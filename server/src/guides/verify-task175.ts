/**
 * Task #175 确定性验证（离线为主，全程不调用付费百炼）。
 *
 * 覆盖用户要求的确定性测试矩阵：
 *   段 A  预筛纯函数：尺寸解析（真实样本 / 生成 PNG / 畸形保守）、本地硬筛
 *         （R1 体积 / R2 像素密度 / 保守保留）、批量分类 prompt 保守规则、
 *         响应解析（info 保留 / 人像风景跳过 / textClue 保留 / fence 与
 *         尾部 JSON 容错 / 缺条目只保留不放大 / 非法输入整批保留）；
 *   段 B  prefilterBatch 集成（仅当百炼环境变量未配置时执行）：tiny.jpg
 *         本地硬筛跳过 stage=local、真实样本保留、零模型调用（耗时上界佐证）、
 *         本地预筛耗时测量（性能报告输入）；已配置时跳过（避免付费）；
 *   段 C  下载槽位（stub fetch）：17 图按原始页码落盘、失败页（P3/P7/P13）
 *         path=null 占位不前移、P14-P17 可保存、25 URL 截断到 24；
 *   段 D  service 集成（桩注入，Task #215 适配：提交后图片默认不解析，
 *         手动触发后识别且不预筛）：IMAGE_COUNT_EXCEEDED(25>24)；
 *         T1 链接 17 槽：提交零模型调用延迟结算 → 触发后 3 张下载失败页码
 *         占位 + 14 张识别按原页码 ready + partial + coverageText
 *         「正文 + 14/17张图」+ download_failed 不可重试（SOURCE_NOT_RETRYABLE）；
 *         T2 链接 17 槽全成功：触发后 P5 识别失败 → partial → 重试只跑 [5]
 *         → ready → 手工构造 skipped 重试跑 [1,2]（历史数据兼容，按需重试
 *         语义仍可用）→ 17/17 → 再重试 SOURCE_NOT_RETRYABLE；
 *   段 E  运行令牌：withSourceImageRun 嵌套接管使外层失效（迟到写盘阻断），
 *         窗口关闭后令牌失效。
 *
 * 运行：npx tsx server/src/guides/verify-task175.ts
 * 不触网、不写行程数据（临时行程与临时上传目录在 finally 全部清理）；
 * 复用既有真实样本 uploads/xhs_6ace31c6000000001b0202f7/1..12.jpg（只读）。
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { GuideSource, Trip } from "@goplay/shared";
import { AiError } from "../ai/errors.js";
import type { ParsedEntry } from "../ai/assemble.js";
import type { OcrScreenshotInput, RecognizedImageContent } from "../ai/ocr.js";
import {
  PREFILTER_BATCH_CLASSIFY_SIZE,
  PREFILTER_MIN_BYTES_PER_PIXEL,
  PREFILTER_MIN_IMAGE_BYTES,
  assessLocalInformation,
  buildBatchClassifyPrompt,
  parseBatchClassifyResponse,
  parseImageDimensions,
  prefilterBatch,
  type PrefilterImageInput,
  type PrefilterSkipDecision,
} from "../ai/prefilter.js";
import { downloadNoteImages, type XhsImageSlot, type XhsNoteResult } from "../ai/xhs.js";
import { getMissingBailianVars } from "../env.js";
import { tripStore, UPLOADS_DIR } from "../persistence/store.js";
import {
  GUIDE_BATCH_BUDGET_MS,
  GUIDE_IMAGE_CONCURRENCY,
  GUIDE_MAX_IMAGES,
  GUIDE_SOURCE_BUDGET_MAX_MS,
  GUIDE_SOURCE_BUDGET_MS,
  guideSourceBudgetMs,
  withSourceImageRun,
} from "./jobs.js";
import {
  getGuideSource,
  resetGuideServiceDeps,
  retryGuideSource,
  setGuideServiceDeps,
  submitGuideSource,
  triggerImageOcr,
} from "./service.js";

// ===== 基础辅助 =====

function pass(name: string): void {
  console.log(`✓ ${name}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 文件名中的数字 → 图片序号（"14.jpg" → 14；队列识别调用的断言依据） */
function imageIndexFromFilename(filename: string): number {
  const match = filename.match(/(\d+)/);
  return match !== null ? Number(match[1]) : 0;
}

// ===== 生成测试 PNG（零依赖：手写 CRC + chunk + deflate 纯色图） =====

const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    table.push(c >>> 0);
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = (CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * 生成 width×height 纯色 PNG（真实可通过 IHDR 解析与格式检测）。
 * padToBytes：用 tEXt chunk 填充到目标体积（R2 像素密度用例需要 >8KB）。
 */
function makeSolidPng(width: number, height: number, padToBytes?: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const rawRowLength = 1 + width * 3;
  const raw = new Uint8Array(rawRowLength * height); // 全 0（黑）→ deflate 高压缩
  const chunks: Uint8Array[] = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const totalOf = (list: Uint8Array[]): number => list.reduce((sum, chunk) => sum + chunk.length, 0);
  let total = totalOf(chunks);
  const padNeeded = padToBytes !== undefined ? padToBytes - total : 0;
  if (padNeeded > 12) {
    const text = new Uint8Array(padNeeded - 12); // tEXt：长度 4 + "tEXt" 4 + CRC 4
    const filler = "task175pad";
    for (let i = 0; i < text.length; i++) text[i] = filler.charCodeAt(i % filler.length);
    chunks.splice(3, 0, pngChunk("tEXt", text));
    total = totalOf(chunks);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

// ===== service 桩（段 D 注入；行为由用例改写） =====

/** 识别调用序号（按调用发生顺序；断言用排序后对比，消除并发完成顺序差异） */
const stubRecognizeCalls: number[] = [];
/** 需要识别失败的页码集合 */
let stubFailPages = new Set<number>();
/** 预筛桩：键 = 预筛输入序号（0-based，即可下载槽位的出现顺序） */
let stubPrefilterSkips = new Map<number, PrefilterSkipDecision>();
/** 预筛桩每次收到的输入规模（验证只送可下载图、跳过图零调用） */
const stubPrefilterCallSizes: number[] = [];
let stubNote: XhsNoteResult = { success: true };

const stubFetchNote = async (): Promise<XhsNoteResult> => ({ ...stubNote });
const stubExtractEntries = async (text: string): Promise<ParsedEntry[]> => [
  mkEntry("蜈支洲岛", "attraction", "medium"),
  mkEntry("情人桥", "in_attraction", "high", "蜈支洲岛"),
];
const stubRecognizeImage = async (image: OcrScreenshotInput): Promise<RecognizedImageContent> => {
  const index = imageIndexFromFilename(image.filename);
  stubRecognizeCalls.push(index);
  if (stubFailPages.has(index)) {
    throw new AiError("BAILIAN_REQUEST_FAILED", `第 ${index} 张识别失败（桩）`);
  }
  return { ocrText: `第 ${index} 张图的识别文本（task175 桩）`, mentions: [] };
};
const stubPrefilterBatch = async (
  items: readonly PrefilterImageInput[],
): Promise<Map<number, PrefilterSkipDecision>> => {
  stubPrefilterCallSizes.push(items.length);
  return new Map(stubPrefilterSkips);
};

/** 测试条目（与 verify-b2 的 mkEntry 同构） */
function mkEntry(
  name: string,
  type: ParsedEntry["type"],
  confidence: ParsedEntry["confidence"],
  parent: string | null = null,
): ParsedEntry {
  return {
    name,
    type,
    parentAttraction: parent,
    scale: null,
    confidence,
    suggestMinutes: 40,
    locationHint: null,
    quote: `原文提及${name}`,
    summary: "验证条目",
    ticketRelation: "unknown",
    suggestedVisitName: null,
    bbox: null,
  };
}

async function loadTrip(tripId: string): Promise<Trip> {
  const trip = await tripStore.load(tripId);
  assert.ok(trip !== null, `行程 ${tripId} 应存在`);
  return trip;
}

/** 轮询来源直到离开 processing（后台 fire-and-forget 任务完成） */
async function waitSettled(tripId: string, sourceId: string, timeoutMs = 20_000): Promise<GuideSource> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const source = await getGuideSource(tripId, sourceId);
    if (source.status !== "processing") return source;
    if (Date.now() > deadline) {
      throw new Error(`来源 ${sourceId} 在 ${timeoutMs}ms 内未结算（仍 processing）`);
    }
    await sleep(50);
  }
}

function entryOf(source: GuideSource, page: number) {
  const entry = source.imageProgress.images.find((candidate) => candidate.index === page);
  assert.ok(entry !== undefined, `imageProgress 应含页码 P${page}`);
  return entry;
}

/** 本脚本创建的临时资源：行程（数据 + 上传目录）、xhs 临时目录、临时下载目录 */
const createdTripIds: string[] = [];
const createdXhsDirs: string[] = [];
let tmpDownloadDir: string | null = null;

async function cleanup(): Promise<void> {
  resetGuideServiceDeps();
  for (const tripId of createdTripIds) {
    await tripStore.deleteTrip(tripId).catch(() => undefined);
  }
  for (const dir of createdXhsDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  if (tmpDownloadDir !== null) {
    await fs.rm(tmpDownloadDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  setGuideServiceDeps({
    fetchNote: stubFetchNote,
    extractEntries: stubExtractEntries,
    recognizeImage: stubRecognizeImage,
    prefilterBatch: stubPrefilterBatch,
  });

  // ===== 公共夹具：真实样本（只读）与 fixture（只读） =====
  const realSampleDir = path.join(UPLOADS_DIR, "xhs_6ace31c6000000001b0202f7");
  const realSample1 = new Uint8Array(await fs.readFile(path.join(realSampleDir, "1.jpg")));
  const realSample5 = new Uint8Array(await fs.readFile(path.join(realSampleDir, "5.jpg")));
  const realSample9 = new Uint8Array(await fs.readFile(path.join(realSampleDir, "9.jpg")));
  const tinyBytes = new Uint8Array(
    await fs.readFile(path.join(import.meta.dirname, "fixtures", "tiny.jpg")),
  );

  // ============ 段 A：预筛纯函数 ============

  // A1 尺寸解析：真实样本 JPEG
  const dims1 = parseImageDimensions(realSample1);
  assert.deepEqual(dims1, { width: 1080, height: 1440 }, "真实样本 1.jpg 应解析出 1080×1440");
  pass("A1 parseImageDimensions：真实样本 1080×1440");

  // A2 尺寸解析：tiny fixture（sips 缩放产物，尺寸非零即可）与畸形数据
  const dimsTiny = parseImageDimensions(tinyBytes);
  assert.ok(dimsTiny !== null && dimsTiny.width > 0 && dimsTiny.height > 0, "tiny.jpg 应解析出非零尺寸");
  assert.equal(parseImageDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null, "截断 PNG（<24B）应返回 null");
  assert.equal(parseImageDimensions(new Uint8Array(64).fill(0x41)), null, "随机字节应返回 null（保守保留）");
  pass("A2 parseImageDimensions：fixture 与畸形数据");

  // A3 尺寸解析：生成 PNG 精确尺寸
  const png64 = makeSolidPng(64, 64);
  const pngBig = makeSolidPng(2000, 2000, 24 * 1024);
  assert.deepEqual(parseImageDimensions(png64), { width: 64, height: 64 });
  assert.deepEqual(parseImageDimensions(pngBig), { width: 2000, height: 2000 });
  assert.ok(pngBig.length > PREFILTER_MIN_IMAGE_BYTES, "填充后应大于 8KB（绕过 R1 命中 R2）");
  pass("A3 parseImageDimensions：生成 PNG 精确尺寸");

  // A4 本地硬筛：R1 极小文件（tiny fixture 与 64×64 PNG 均 <8KB）
  const tinyItem: PrefilterImageInput = {
    data: tinyBytes,
    filename: "tiny.jpg",
    mimeType: "image/jpeg",
    sizeBytes: tinyBytes.length,
  };
  const verdictTiny = assessLocalInformation(tinyItem);
  assert.equal(verdictTiny.skip, true, "tiny.jpg（2799B < 8KB）应跳过");
  assert.ok(verdictTiny.skip && /体积过小/.test(verdictTiny.reason), `R1 原因应含「体积过小」：${JSON.stringify(verdictTiny)}`);
  const verdictPng64 = assessLocalInformation({
    data: png64,
    filename: "small.png",
    mimeType: "image/png",
    sizeBytes: png64.length,
  });
  assert.equal(verdictPng64.skip, true, "64×64 PNG（<8KB）应跳过");
  pass("A4 assessLocalInformation：R1 极小文件跳过");

  // A5 本地硬筛：R2 像素信息密度过低（24KB / 2000×2000 ≈ 0.006 B/px < 0.02）
  assert.ok(
    pngBig.length / (2000 * 2000) < PREFILTER_MIN_BYTES_PER_PIXEL,
    "用例前提：填充图 bpp 应低于阈值",
  );
  const verdictBig = assessLocalInformation({
    data: pngBig,
    filename: "flat.png",
    mimeType: "image/png",
    sizeBytes: pngBig.length,
  });
  assert.equal(verdictBig.skip, true, "低密度纯色大图应跳过");
  assert.ok(verdictBig.skip && /信息密度/.test(verdictBig.reason), `R2 原因应含「信息密度」：${JSON.stringify(verdictBig)}`);
  pass("A5 assessLocalInformation：R2 像素密度跳过");

  // A6 本地硬筛：真实照片保留；模糊 / 畸形样本保守保留
  assert.equal(
    assessLocalInformation({ data: realSample5, filename: "5.jpg", mimeType: "image/jpeg", sizeBytes: realSample5.length }).skip,
    false,
    "真实照片（数百 KB 真实内容）应保留",
  );
  const murky = new Uint8Array(16 * 1024).fill(0x3f); // >8KB 但既非 JPEG 也非 PNG
  assert.equal(
    assessLocalInformation({ data: murky, filename: "murky.bin", mimeType: "application/octet-stream", sizeBytes: murky.length }).skip,
    false,
    "无法解析尺寸的模糊样本应保守保留",
  );
  pass("A6 assessLocalInformation：真实照片保留、模糊样本保守保留");

  // A7 批量分类 prompt：保守规则关键句
  const prompt = buildBatchClassifyPrompt(3);
  assert.ok(prompt.includes("3 张图片") && prompt.includes("index 1"), "prompt 应说明 index 对应关系");
  assert.ok(prompt.includes("textClue"), "prompt 应含 textClue 字段说明");
  assert.ok(prompt.includes("保守") && prompt.includes("宁可多保留"), "prompt 应含保守原则");
  assert.ok(prompt.includes("菜单") && prompt.includes("地图") && prompt.includes("价目表"), "prompt 应列举文字线索类型");
  pass("A7 buildBatchClassifyPrompt：保守规则关键句");

  // A8 响应解析：info / 有文字线索 / 未知类别一律保留
  const keep = parseBatchClassifyResponse(
    '{"images":[{"index":1,"category":"info","textClue":true},{"index":2,"category":"portrait","textClue":true},{"index":3,"category":"landscape","textClue":false}]}',
    3,
  );
  assert.ok(keep !== null && keep.size === 1 && keep.has(3), "textClue=true 的 portrait 与 info 都应保留，仅纯风景跳过");
  const unknownKeep = parseBatchClassifyResponse(
    '{"images":[{"index":1,"category":"unknown-kind","textClue":false}]}',
    1,
  );
  assert.ok(unknownKeep !== null && unknownKeep.size === 0, "未知类别保守保留");
  pass("A8 parseBatchClassifyResponse：info / 文字线索 / 未知类别保留");

  // A9 响应解析：人像 / 风景跳过原因可解释
  const skips = parseBatchClassifyResponse(
    '{"images":[{"index":1,"category":"portrait","textClue":false},{"index":2,"category":"landscape","textClue":false}]}',
    2,
  );
  assert.ok(skips !== null && skips.size === 2, "纯人像 + 纯风景应各跳过 1 张");
  assert.ok(skips !== null && /人像/.test(skips.get(1) ?? ""), "人像跳过原因应含「人像」");
  assert.ok(skips !== null && /风景/.test(skips.get(2) ?? ""), "风景跳过原因应含「风景」");
  pass("A9 parseBatchClassifyResponse：人像 / 风景跳过原因");

  // A10 响应解析：code fence 与回显尾部 JSON 容错
  const fenced = parseBatchClassifyResponse(
    '```json\n{"images":[{"index":1,"category":"portrait","textClue":false}]}\n```',
    1,
  );
  assert.ok(fenced !== null && fenced.size === 1 && fenced.has(1), "code fence 包裹应可解析");
  const tailJson = parseBatchClassifyResponse(
    '好的，分类结果如下：\n{"images":[{"index":1,"category":"landscape","textClue":false}]}\n以上就是全部结果。',
    1,
  );
  assert.ok(tailJson !== null && tailJson.size === 1, "回显 + 尾部 JSON 应可提取");
  pass("A10 parseBatchClassifyResponse：fence 与尾部 JSON 容错");

  // A11 响应解析：缺条目只保留不放大；非法 index / 垃圾整批保守
  const partialEntries = parseBatchClassifyResponse(
    '{"images":[{"index":2,"category":"portrait","textClue":false}]}',
    2,
  );
  assert.ok(partialEntries !== null && partialEntries.size === 1 && partialEntries.has(2), "缺失条目（index 1）保守保留");
  assert.equal(parseBatchClassifyResponse('{"images":[{"index":0,"category":"portrait","textClue":false}]}', 1), null, "index=0 非法 → null");
  assert.equal(parseBatchClassifyResponse('{"images":[{"index":3,"category":"portrait","textClue":false}]}', 2), null, "index 越界 → null");
  assert.equal(parseBatchClassifyResponse("模型抽风输出纯文本", 1), null, "纯垃圾 → null（整批保留）");
  pass("A11 parseBatchClassifyResponse：缺条目与非法输入保守");

  // ============ 段 B：prefilterBatch 集成（离线） ============

  const missingVars = getMissingBailianVars();
  if (missingVars.length > 0) {
    // 离线：批量分类层因环境未配置直接整批保守保留 → 全程零模型调用
    const startedAt = Date.now();
    const skipsB = await prefilterBatch([tinyItem, { data: realSample5, filename: "5.jpg", mimeType: "image/jpeg", sizeBytes: realSample5.length }, { data: realSample9, filename: "9.jpg", mimeType: "image/jpeg", sizeBytes: realSample9.length }]);
    const elapsedB = Date.now() - startedAt;
    assert.equal(skipsB.get(0)?.stage, "local", "tiny.jpg 应由本地硬筛跳过（stage=local）");
    assert.ok(/体积过小/.test(skipsB.get(0)?.reason ?? ""), "R1 跳过原因应可解释");
    assert.ok(!skipsB.has(1) && !skipsB.has(2), "真实样本 5.jpg / 9.jpg 应保守保留");
    assert.ok(elapsedB < 2_000, `零模型调用佐证：本地预筛耗时应远小于网络会话（实际 ${elapsedB}ms）`);
    console.log(
      `[性能] 本地预筛耗时 ${elapsedB}ms（3 张样本，含 1 张跳过）；批量分类层因百炼环境未配置保守保留，全程零模型调用`,
    );
    pass("B prefilterBatch 集成：本地硬筛生效、保留图保守、零模型调用");
  } else {
    console.log(
      "[跳过] 段 B：检测到百炼环境变量已配置，为避免付费调用跳过真实 prefilterBatch 集成（本地层行为已由段 A 纯函数覆盖）",
    );
  }

  // ============ 段 C：下载槽位（stub fetch，17 图页码对齐 + 24 上限截断） ============

  const originalFetch = globalThis.fetch;
  const fakeJpeg = new Uint8Array(100 * 1024);
  fakeJpeg.set([0xff, 0xd8, 0xff, 0xe0], 0); // JPEG magic bytes
  const dlFailedPages = new Set([3, 7, 13]);
  try {
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = input instanceof URL ? input.toString() : String(input);
      const page = Number(url.match(/task175-p(\d+)\.jpg/)?.[1] ?? 0);
      if (dlFailedPages.has(page)) return new Response(null, { status: 404 });
      return new Response(fakeJpeg, { status: 200, headers: { "content-type": "image/jpeg" } });
    }) as typeof fetch;

    tmpDownloadDir = path.join(os.tmpdir(), `task175-dl-${randomUUID().slice(0, 8)}`);
    const urls17 = Array.from({ length: 17 }, (_, position) => `https://sns-img.qh.xhscdn.com/task175-p${position + 1}.jpg`);
    const downloaded = await downloadNoteImages("task175slots", urls17, { outDir: tmpDownloadDir, baseUrl: "/api/uploads" });

    // C1 槽位数量与页码：17 个槽位、index = 1..17 原始页码一一对应（绝不前移）
    const slots: XhsImageSlot[] = downloaded.slots;
    assert.equal(slots.length, 17, "17 个 URL 应产出 17 个槽位");
    assert.deepEqual(slots.map((slot) => slot.index), Array.from({ length: 17 }, (_, position) => position + 1), "槽位 index 应等于原始页码");
    pass("C1 downloadNoteImages：17 槽位页码一一对应");

    // C2 失败槽位：path=null + 可读 error；成功槽位 14 张且 P14-P17 不前移
    for (const failedPage of dlFailedPages) {
      const slot = slots[failedPage - 1];
      assert.equal(slot.path, null, `P${failedPage} 下载失败槽位应 path=null`);
      assert.match(slot.error ?? "", /HTTP 404/, `P${failedPage} 失败原因应含 HTTP 404`);
    }
    assert.equal(downloaded.saved.length, 14, "成功保存应为 14 张");
    for (const okPage of [14, 15, 16, 17]) {
      const slot = slots[okPage - 1];
      assert.equal(slot.path, `/api/uploads/xhs_task175slots/${okPage}.jpg`, `P${okPage} 应按原页码落盘（不前移）`);
      await fs.access(path.join(tmpDownloadDir, `${okPage}.jpg`)); // 文件真实存在
    }
    pass("C2 downloadNoteImages：失败占位不前移、P14-P17 可保存");

    // C3 上限截断：25 URL → 24 槽位
    const urls25 = Array.from({ length: 25 }, (_, position) => `https://sns-img.qh.xhscdn.com/task175-p${(position % 17) + 1}.jpg`);
    const downloaded25 = await downloadNoteImages("task175slots", urls25, { outDir: tmpDownloadDir, baseUrl: "/api/uploads" });
    assert.equal(downloaded25.slots.length, 24, "25 个 URL 应截断到 24 个槽位");
    assert.deepEqual(downloaded25.slots.map((slot) => slot.index), Array.from({ length: 24 }, (_, position) => position + 1));
    pass("C3 downloadNoteImages：24 上限截断");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // ============ 段 D：service 集成 ============

  // D0 上限校验：25 张 images 来源提交应拒绝（GUIDE_MAX_IMAGES=24）
  assert.equal(GUIDE_MAX_IMAGES, 24, "GUIDE_MAX_IMAGES 应为 24");
  assert.equal(GUIDE_IMAGE_CONCURRENCY, 4, "队列并发应为 4");
  assert.deepEqual(
    [1, 12, 17, 24, 40].map(guideSourceBudgetMs),
    [
      GUIDE_SOURCE_BUDGET_MS,
      3 * GUIDE_BATCH_BUDGET_MS,
      5 * GUIDE_BATCH_BUDGET_MS,
      6 * GUIDE_BATCH_BUDGET_MS,
      GUIDE_SOURCE_BUDGET_MAX_MS,
    ],
    "动态预算：180s 下限 / ceil(n/4)×150s / 1200s 上限",
  );
  pass("D0 动态预算与上限常量");

  // 准备 T1 临时目录：P14-P17 用真实样本字节（模拟下载成功的受控文件）
  const t1Dir = path.join(UPLOADS_DIR, "xhs_task175t1");
  createdXhsDirs.push(t1Dir);
  await fs.mkdir(t1Dir, { recursive: true });
  for (let page = 14; page <= 17; page++) {
    await fs.copyFile(path.join(realSampleDir, `${page - 13}.jpg`), path.join(t1Dir, `${page}.jpg`));
  }
  // 准备 T2 临时目录：P1-P12 ← 真实 1-12，P13-P17 ← 真实 1-5（17 张全部有字节）
  const t2Dir = path.join(UPLOADS_DIR, "xhs_task175t2");
  createdXhsDirs.push(t2Dir);
  await fs.mkdir(t2Dir, { recursive: true });
  for (let page = 1; page <= 17; page++) {
    await fs.copyFile(path.join(realSampleDir, `${page <= 12 ? page : page - 12}.jpg`), path.join(t2Dir, `${page}.jpg`));
  }

  // 行程 A（T1）：IMAGE_COUNT_EXCEEDED + 17 槽（3 下载失败 + 2 预筛跳过 + 12 ready）
  const tripA = await tripStore.create({
    destination: { city: "三亚" },
    dateRange: { start: "2026-11-08", end: "2026-11-10", nights: 2 },
  });
  createdTripIds.push(tripA.tripId);

  await assert.rejects(
    () =>
      submitGuideSource(tripA.tripId, {
        inputKind: "images",
        images: Array.from({ length: 25 }, () => ({ data: tinyBytes, filename: "tiny.jpg", mimeType: "image/jpeg" })),
      }),
    (error: unknown) => error instanceof AiError && error.code === "IMAGE_COUNT_EXCEEDED",
    "25 张应超出 24 上限被拒",
  );
  pass("D1 IMAGE_COUNT_EXCEEDED：25 > 24 拒绝");

  const t1FailedPages = new Set([3, 7, 13]);
  stubNote = {
    success: true,
    title: "蜈支洲岛 17 图长笔记（T1）",
    text: "T1 正文：上岛先走情人桥，下午去观日岩看海。",
    sourceUrl: "https://www.xiaohongshu.com/explore/task175t1",
    imageSlots: Array.from({ length: 17 }, (_, position) => {
      const page = position + 1;
      if (t1FailedPages.has(page)) {
        return { index: page, path: null, error: "下载失败（HTTP 404）" };
      }
      return {
        index: page,
        path: page <= 12 ? `/api/uploads/xhs_6ace31c6000000001b0202f7/${page}.jpg` : `/api/uploads/xhs_task175t1/${page}.jpg`,
      };
    }),
  };
  stubPrefilterSkips = new Map([
    [0, { reason: "预筛桩：P1 纯风景图无文字线索，跳过识别", stage: "batch" }],
    [1, { reason: "预筛桩：P2 纯人像图无文字线索，跳过识别", stage: "batch" }],
  ]);

  const t1Submit = await submitGuideSource(tripA.tripId, {
    inputKind: "link",
    url: "https://www.xiaohongshu.com/explore/task175t1",
  });
  const t1SourceId = t1Submit.sourceId;

  // D2a Task #215：提交零预筛、零识别——延迟结算（14 张 pending 待手动触发；
  // 3 张下载失败图在场 → partial，与旧口径失败语义一致）
  const t1Deferred = await waitSettled(tripA.tripId, t1SourceId);
  assert.deepEqual(stubPrefilterCallSizes, [], "提交链路不应调用预筛");
  assert.equal(stubRecognizeCalls.length, 0, "提交后不应有任何识别调用");
  assert.equal(t1Deferred.status, "partial", "下载失败图在场 → 延迟结算 partial");
  assert.equal(t1Deferred.imageOcrDeferred, true, "应标记延迟解析");
  pass("D2a T1 提交零模型调用：延迟结算 partial（14 张待解析 + 3 张下载失败）");

  // 手动触发：14 张可下载图全部送识别（明确指令不预筛，P1/P2 不再跳过）
  await triggerImageOcr(tripA.tripId, t1SourceId);
  const t1Settled = await waitSettled(tripA.tripId, t1SourceId);

  // D2 触发解析只跑 14 张可下载图（17 - 3 下载失败），不预筛 → P1/P2 一并识别
  assert.deepEqual(stubPrefilterCallSizes, [], "触发解析不预筛（预筛桩零调用）");
  const t1ExpectedRecognized = [1, 2, 4, 5, 6, 8, 9, 10, 11, 12, 14, 15, 16, 17];
  assert.deepEqual(
    [...stubRecognizeCalls].sort((left, right) => left - right),
    t1ExpectedRecognized,
    `识别调用应恰为 14 张可下载图 ${JSON.stringify(t1ExpectedRecognized)}（零多余调用）`,
  );
  pass("D2 T1 触发解析：14 张可下载图全部识别（不预筛）");

  // D3 下载失败页码占位：failed / download_failed + 原始页码文案
  for (const failedPage of t1FailedPages) {
    const entry = entryOf(t1Settled, failedPage);
    assert.equal(entry.status, "failed", `P${failedPage} 应 failed`);
    assert.equal(entry.failureCode, "download_failed", `P${failedPage} 应 download_failed`);
    assert.match(entry.failureMessage ?? "", new RegExp(`P${failedPage} 已保留占位`), "占位文案应含原始页码");
    assert.equal(entry.evidenceId, null, `P${failedPage} 无原图不可回看证据`);
  }
  pass("D3 T1 下载失败：页码占位不前移");

  // D4 Task #215：触发解析不预筛——P1/P2 不再 skipped，直接识别 ready
  const tripAAfterT1 = await loadTrip(tripA.tripId);
  for (const page of [1, 2]) {
    const entry = entryOf(t1Settled, page);
    assert.equal(entry.status, "ready", `P${page} 应 ready（不预筛不跳过）`);
    assert.ok(entry.evidenceId !== null, `P${page} 应有证据`);
  }
  pass("D4 T1 无 skipped：触发解析不预筛，P1/P2 直接识别");

  // D5 其余 14 张按原页码 ready；结算 partial + coverageText
  for (const readyPage of t1ExpectedRecognized) {
    const entry = entryOf(t1Settled, readyPage);
    assert.equal(entry.status, "ready", `P${readyPage} 应 ready`);
    assert.ok(entry.evidenceId !== null);
    assert.equal(tripAAfterT1.evidences[entry.evidenceId!].ocrText, `第 ${readyPage} 张图的识别文本（task175 桩）`);
  }
  assert.equal(t1Settled.status, "partial", "3 张下载失败 → partial");
  assert.equal(t1Settled.imageProgress.completed, 14, "completed 只计 ready（14）");
  assert.equal(t1Settled.imageProgress.failed, 3, "failed 只计 failed（3）");
  assert.equal(t1Settled.coverageText, "正文 + 14/17张图", `coverageText 实际 ${t1Settled.coverageText}`);
  pass("D5 T1 结算：partial + 14/17（3 张下载失败）");

  // D6 T1 重试：download_failed 无原图 → SOURCE_NOT_RETRYABLE
  await assert.rejects(
    () => retryGuideSource(tripA.tripId, t1SourceId),
    (error: unknown) => error instanceof AiError && error.code === "SOURCE_NOT_RETRYABLE",
    "download_failed 图无原图可定位，应拒绝重试",
  );
  pass("D6 T1 重试拒绝：download_failed 不可重试");

  // ---- T2：17 槽全成功 + 重试语义（partial → 只跑 failed → ready → 跑 skipped） ----
  const tripB = await tripStore.create({
    destination: { city: "三亚" },
    dateRange: { start: "2026-11-08", end: "2026-11-10", nights: 2 },
  });
  createdTripIds.push(tripB.tripId);

  stubNote = {
    success: true,
    title: "蜈支洲岛 17 图长笔记（T2）",
    text: "T2 正文：情人桥与观日岩全记录。",
    sourceUrl: "https://www.xiaohongshu.com/explore/task175t2",
    imageSlots: Array.from({ length: 17 }, (_, position) => ({
      index: position + 1,
      path: `/api/uploads/xhs_task175t2/${position + 1}.jpg`,
    })),
  };
  stubPrefilterSkips = new Map([
    [0, { reason: "预筛桩：P1 纯风景图无文字线索，跳过识别", stage: "batch" }],
    [1, { reason: "预筛桩：P2 纯人像图无文字线索，跳过识别", stage: "batch" }],
  ]);
  stubFailPages = new Set([5]);
  stubRecognizeCalls.length = 0;

  const t2Submit = await submitGuideSource(tripB.tripId, {
    inputKind: "link",
    url: "https://www.xiaohongshu.com/explore/task175t2",
  });
  const t2SourceId = t2Submit.sourceId;
  const t2Deferred = await waitSettled(tripB.tripId, t2SourceId);
  assert.equal(t2Deferred.imageOcrDeferred, true, "T2 提交后应延迟结算");
  assert.equal(stubRecognizeCalls.length, 0, "T2 提交后零识别调用");
  await triggerImageOcr(tripB.tripId, t2SourceId);
  const t2First = await waitSettled(tripB.tripId, t2SourceId);

  // D7 T2 触发：17 张全部送识别（不预筛）、P5 失败 → partial
  assert.deepEqual(
    [...stubRecognizeCalls].sort((left, right) => left - right),
    Array.from({ length: 17 }, (_, i) => i + 1),
    "触发应识别全部 17 张（零多余调用）",
  );
  assert.equal(t2First.status, "partial", "P5 识别失败 → partial");
  assert.equal(entryOf(t2First, 5).status, "failed");
  assert.equal(entryOf(t2First, 5).failureCode, "extract_failed");
  assert.equal(t2First.imageProgress.completed, 16);
  assert.equal(t2First.imageProgress.failed, 1);
  pass("D7 T2 触发解析：partial（P5 失败，16 ready）");

  // D8 重试：只跑 failed 的 P5 → ready（不重复已完成项）
  stubFailPages = new Set();
  stubRecognizeCalls.length = 0;
  await retryGuideSource(tripB.tripId, t2SourceId);
  const t2AfterRetry1 = await waitSettled(tripB.tripId, t2SourceId);
  assert.deepEqual([...stubRecognizeCalls].sort((left, right) => left - right), [5], "重试应只跑失败图 P5（不重复已完成）");
  assert.equal(t2AfterRetry1.status, "ready", "全部图确定结果（17 ready）→ ready");
  assert.equal(t2AfterRetry1.coverageText, "正文 + 17/17张图", `coverageText 实际 ${t2AfterRetry1.coverageText}`);
  pass("D8 T2 重试：只跑 P5 → ready");

  // D9 历史 skipped 来源重试兼容（Task #215 后新来源不再产生 skipped，但存量
  // 数据 / 未来预筛回归时按需重试语义仍须可用）：手工构造 2 张 skipped 再重试
  stubRecognizeCalls.length = 0;
  const tripBForSkip = await loadTrip(tripB.tripId);
  const t2SourceForSkip = tripBForSkip.guideSources?.[t2SourceId];
  assert.ok(t2SourceForSkip !== undefined);
  for (const page of [1, 2]) {
    const entry = t2SourceForSkip.imageProgress.images.find((candidate) => candidate.index === page);
    assert.ok(entry !== undefined && entry.evidenceId !== null, `P${page} 应有证据可定位原图`);
    entry.status = "skipped";
    entry.failureMessage = "手工构造：预筛跳过（历史数据兼容用例）";
  }
  // skipped 不计入 completed（与 service 内 recountImageProgress 同口径，保持一致性校验可过）
  t2SourceForSkip.imageProgress.completed = 17 - 2;
  await tripStore.save(tripBForSkip);
  await retryGuideSource(tripB.tripId, t2SourceId);
  const t2AfterRetry2 = await waitSettled(tripB.tripId, t2SourceId);
  assert.deepEqual([...stubRecognizeCalls].sort((left, right) => left - right), [1, 2], "ready 重试应只跑预筛跳过图 P1/P2");
  assert.equal(t2AfterRetry2.status, "ready");
  assert.equal(t2AfterRetry2.imageProgress.completed, 17, "全部 17 张 ready（原页码映射完整）");
  assert.equal(t2AfterRetry2.coverageText, "正文 + 17/17张图", `coverageText 实际 ${t2AfterRetry2.coverageText}`);
  pass("D9 T2 重试 #2：ready + skipped 按需重试 → 17/17");

  // D10 重试 #3：无 skipped 的 ready → SOURCE_NOT_RETRYABLE
  await assert.rejects(
    () => retryGuideSource(tripB.tripId, t2SourceId),
    (error: unknown) => error instanceof AiError && error.code === "SOURCE_NOT_RETRYABLE",
    "无跳过图的 ready 应拒绝重试",
  );
  pass("D10 T2 重试拒绝：无 skipped 的 ready");

  // ============ 段 E：运行令牌（迟到写盘阻断） ============

  const tripIdE = "token-trip";
  const sourceIdE = "token-src";
  await withSourceImageRun(tripIdE, sourceIdE, async (outerContext) => {
    assert.equal(outerContext.isActive(), true, "窗口内令牌应有效");
    await withSourceImageRun(tripIdE, sourceIdE, async (innerContext) => {
      assert.equal(innerContext.isActive(), true, "内层窗口令牌应有效");
      assert.equal(outerContext.isActive(), false, "外层令牌应被内层接管而失效（迟到写盘被阻断）");
    });
    assert.equal(outerContext.isActive(), false, "内层窗口关闭后外层仍失效");
  });
  const lateContext = await withSourceImageRun(tripIdE, sourceIdE, async (context) => context);
  assert.equal(lateContext.isActive(), false, "窗口关闭后令牌失效");
  pass("E withSourceImageRun：嵌套接管与窗口关闭失效");

  // ============ 性能摘要 ============

  console.log("");
  console.log("========== Task #175 性能摘要（真实样本 6ace31c6000000001b0202f7，17 图） ==========");
  console.log(`- Task #175 口径：17 张全下载（页码不前移）+ 预筛跳过纯风景/人像图，省逐图 OCR 会话`);
  console.log(`- Task #215 起提交链路默认零模型调用（延迟结算）；「解析图片」为明确指令不预筛，17 图直接送 OCR`);
  console.log(`- 预筛纯函数与整批分类能力保留（段 A/B 实测 ${missingVars.length > 0 ? "见上方耗时" : "见段 A"}；≤${PREFILTER_BATCH_CLASSIFY_SIZE} 张/批 1 次会话）`);
  console.log("====================================================================================");
  console.log("");
  console.log("verify-task175 全部通过 ✓");
}

main()
  .catch(async (error: unknown) => {
    console.error("\nverify-task175 失败：", error);
    process.exitCode = 1;
  })
  .finally(() => cleanup());
