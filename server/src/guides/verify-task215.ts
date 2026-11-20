/**
 * Task #215 确定性验证（离线，全程桩注入零模型调用）。
 *
 * 行为变更：链接 / 图片来源添加后默认只解析正文，图片照常下载落盘但不自动
 * 启动 OCR；来源卡片「解析图片」按钮一键启动全部待解析图。
 *
 * 验证矩阵：
 *   T1 链接来源延迟：17 图全可下载 → 零识别 / 零预筛调用 → ready（正文可用，
 *      pending 不降级 partial）+ imageOcrDeferred=true + coverageText
 *      「正文 + 17张图片待解析」+ 进度明细 assetPath 已写入（无 /api 前缀，
 *      pending 图尚无证据也能定位原图）；
 *   T2 手动触发：deferred 期间 retry 被 ready 无 skipped 拒绝（互斥保护）→
 *      triggerImageOcr → processing → 17 张全部识别 ready →
 *      imageOcrDeferred=false + coverageText「正文 + 17/17张图」→ 再触发
 *      SOURCE_NOT_RETRYABLE；
 *   T3 图片来源：2 张 PNG 提交 → 零识别调用 → ready（纯图待解析不落 failed）
 *      + coverageText「2张图片待解析」→ trigger → 2/2 ready → 非 deferred
 *      再触发被拒；
 *   T4 下载失败 + deferred：14 可下载 + 3 下载失败 → partial（下载失败如实
 *      计数）+ coverageText「正文 + 14张图片待解析 + 3张图下载失败」→
 *      retry 拒绝（失败图无原图）→ trigger 只跑 14 张 pending（失败图不动）
 *      → partial「正文 + 14/17张图」；
 *   T5 边界：不存在的来源 SOURCE_NOT_FOUND；文字来源（无 imageOcrDeferred
 *      字段 = 历史来源零迁移语义）trigger 拒绝 SOURCE_NOT_RETRYABLE。
 *
 * 运行：npx tsx server/src/guides/verify-task215.ts
 * 不触网、不写真实行程（临时行程与临时上传目录在 finally 全部清理）；
 * 图片全部用零依赖生成 PNG（无外部样本依赖）。
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import type { GuideSource, Trip } from "@goplay/shared";
import { AiError } from "../ai/errors.js";
import type { ParsedEntry } from "../ai/assemble.js";
import type { OcrScreenshotInput, RecognizedImageContent } from "../ai/ocr.js";
import type { XhsImageSlot, XhsNoteResult } from "../ai/xhs.js";
import type { PrefilterImageInput, PrefilterSkipDecision } from "../ai/prefilter.js";
import { tripStore, UPLOADS_DIR } from "../persistence/store.js";
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

/** 文件名中的数字 → 图片序号（"14.jpg" → 14；识别调用的断言依据） */
function imageIndexFromFilename(filename: string): number {
  const match = filename.match(/(\d+)/);
  return match !== null ? Number(match[1]) : 0;
}

// ===== 生成测试 PNG（零依赖：手写 CRC + chunk + deflate 纯色图） =====

const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
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

/** 生成 width×height 纯色 PNG（真实可通过格式检测，识别桩按 magic bytes 放行） */
function makeSolidPng(width: number, height: number): Uint8Array {
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
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

// ===== service 桩（行为由用例改写） =====

/** 识别调用序号（按调用发生顺序；断言用排序后对比，消除并发完成顺序差异） */
const stubRecognizeCalls: number[] = [];
const stubPrefilterCallSizes: number[] = [];
let stubNote: XhsNoteResult = { success: true };

const stubFetchNote = async (): Promise<XhsNoteResult> => ({ ...stubNote });
const stubExtractEntries = async (): Promise<ParsedEntry[]> => [
  mkEntry("蜈支洲岛", "attraction", "medium"),
  mkEntry("情人桥", "in_attraction", "high", "蜈支洲岛"),
];
const stubRecognizeImage = async (image: OcrScreenshotInput): Promise<RecognizedImageContent> => {
  const index = imageIndexFromFilename(image.filename);
  stubRecognizeCalls.push(index);
  return { ocrText: `第 ${index} 张图的识别文本（task215 桩）`, mentions: [] };
};
const stubPrefilterBatch = async (
  items: readonly PrefilterImageInput[],
): Promise<Map<number, PrefilterSkipDecision>> => {
  stubPrefilterCallSizes.push(items.length);
  return new Map();
};

/** 测试条目（与 verify-b2 / verify-task175 的 mkEntry 同构） */
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

/** 本脚本创建的临时资源：行程（数据 + 上传目录）与 xhs 临时目录 */
const createdTripIds: string[] = [];
const createdXhsDirs: string[] = [];

async function cleanup(): Promise<void> {
  resetGuideServiceDeps();
  for (const tripId of createdTripIds) {
    await tripStore.deleteTrip(tripId).catch(() => undefined);
  }
  for (const dir of createdXhsDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 准备 xhs 临时目录：把生成 PNG 写成 pages 中每个页码一份（内容相同，断言只看页码） */
async function prepareXhsDir(dirName: string, pages: readonly number[]): Promise<string> {
  const dir = path.join(UPLOADS_DIR, dirName);
  createdXhsDirs.push(dir);
  await fs.mkdir(dir, { recursive: true });
  const png = makeSolidPng(320, 320);
  for (const page of pages) {
    await fs.writeFile(path.join(dir, `${page}.jpg`), png);
  }
  return dir;
}

async function main(): Promise<void> {
  setGuideServiceDeps({
    fetchNote: stubFetchNote,
    extractEntries: stubExtractEntries,
    recognizeImage: stubRecognizeImage,
    prefilterBatch: stubPrefilterBatch,
  });

  // ============ T1 + T2：链接来源延迟解析 + 手动触发（17 图全可下载） ============

  const tripA = await tripStore.create({
    destination: { city: "三亚" },
    dateRange: { start: "2026-11-08", end: "2026-11-10", nights: 2 },
  });
  createdTripIds.push(tripA.tripId);
  await prepareXhsDir("xhs_task215t1", Array.from({ length: 17 }, (_, i) => i + 1));

  stubNote = {
    success: true,
    title: "蜈支洲岛 17 图笔记（T1 延迟解析）",
    text: "T1 正文：上岛先走情人桥，下午去观日岩看海。",
    sourceUrl: "https://www.xiaohongshu.com/explore/task215t1",
    imageSlots: Array.from({ length: 17 }, (_, position) => ({
      index: position + 1,
      path: `/api/uploads/xhs_task215t1/${position + 1}.jpg`,
    })),
  };

  const t1Submit = await submitGuideSource(tripA.tripId, {
    inputKind: "link",
    url: "https://www.xiaohongshu.com/explore/task215t1",
  });
  const t1SourceId = t1Submit.sourceId;
  const t1Settled = await waitSettled(tripA.tripId, t1SourceId);

  // T1a：零模型调用（不预筛、不识别），图片只下载落盘
  assert.equal(stubPrefilterCallSizes.length, 0, `延迟解析不应触发预筛（实际调用 ${stubPrefilterCallSizes.length} 次）`);
  assert.equal(stubRecognizeCalls.length, 0, `延迟解析不应触发识别（实际调用 ${stubRecognizeCalls.length} 次）`);
  pass("T1a 零模型调用：提交后图片不预筛、不识别");

  // T1b：正文可用即 ready（pending 不降级 partial）+ 延迟标记
  assert.equal(t1Settled.status, "ready", `正文可用 + 图待解析应 ready（实际 ${t1Settled.status}）`);
  assert.equal(t1Settled.imageOcrDeferred, true, "结算应标记 imageOcrDeferred=true");
  assert.equal(t1Settled.coverageText, "正文 + 17张图片待解析", `coverageText 实际 ${t1Settled.coverageText}`);
  pass("T1b 延迟结算：ready + imageOcrDeferred + 「正文 + 17张图片待解析」");

  // T1c：进度明细——17 张全 pending 且 assetPath 已写入（无 /api 前缀，可直接定位原图）
  for (let page = 1; page <= 17; page++) {
    const entry = entryOf(t1Settled, page);
    assert.equal(entry.status, "pending", `P${page} 应保持 pending 待解析`);
    assert.equal(entry.evidenceId, null, `P${page} 延迟解析期间不应有证据`);
    assert.equal(entry.assetPath, `uploads/xhs_task215t1/${page}.jpg`, `P${page} 进度明细应含受控 assetPath`);
  }
  pass("T1c 进度明细：pending + assetPath 已写入（无 /api 前缀）");

  // T2a：deferred 期间 retry 被拒（ready 无 skipped；防止重试绕过延迟语义）
  await assert.rejects(
    () => retryGuideSource(tripA.tripId, t1SourceId),
    (error: unknown) => error instanceof AiError && error.code === "SOURCE_NOT_RETRYABLE",
    "deferred ready 来源的重试应被拒绝",
  );
  pass("T2a deferred 期间 retry 拒绝：入口互斥保护");

  // T2b：手动触发 → processing 快照 → 17 张全部识别 ready
  const triggered = await triggerImageOcr(tripA.tripId, t1SourceId);
  assert.equal(triggered.status, "processing", "触发后状态应回 processing");
  const t2Settled = await waitSettled(tripA.tripId, t1SourceId);
  assert.deepEqual(
    [...stubRecognizeCalls].sort((left, right) => left - right),
    Array.from({ length: 17 }, (_, i) => i + 1),
    "一键解析应识别全部 17 张待解析图（零多余调用）",
  );
  assert.equal(t2Settled.status, "ready", `17/17 识别成功应 ready（实际 ${t2Settled.status}）`);
  assert.equal(t2Settled.imageOcrDeferred, false, "触发后延迟标记应解除");
  assert.equal(t2Settled.imageProgress.completed, 17, "completed 应为 17");
  assert.equal(t2Settled.coverageText, "正文 + 17/17张图", `coverageText 实际 ${t2Settled.coverageText}`);
  pass("T2b 一键解析：17 张全部识别 → ready + 延迟标记解除");

  // T2c：非 deferred 来源再触发 → 拒绝
  await assert.rejects(
    () => triggerImageOcr(tripA.tripId, t1SourceId),
    (error: unknown) => error instanceof AiError && error.code === "SOURCE_NOT_RETRYABLE",
    "无待解析项的来源不应允许再次触发",
  );
  pass("T2c 再触发拒绝：SOURCE_NOT_RETRYABLE");

  // ============ T3：图片来源（纯图待解析不落 failed） ============

  const tripB = await tripStore.create({
    destination: { city: "三亚" },
    dateRange: { start: "2026-11-08", end: "2026-11-10", nights: 2 },
  });
  createdTripIds.push(tripB.tripId);

  stubRecognizeCalls.length = 0;
  const png = makeSolidPng(320, 320);
  const t3Submit = await submitGuideSource(tripB.tripId, {
    inputKind: "images",
    images: [
      { data: png, filename: "shot-1.png", mimeType: "image/png" },
      { data: png, filename: "shot-2.png", mimeType: "image/png" },
    ],
  });
  const t3SourceId = t3Submit.sourceId;
  const t3Settled = await waitSettled(tripB.tripId, t3SourceId);

  // T3a：纯图来源 deferred——无正文可用也不落 failed（待解析是正常待命状态）
  assert.equal(stubRecognizeCalls.length, 0, "图片来源提交后不应自动识别");
  assert.equal(t3Settled.status, "ready", `纯图待解析不应落 failed（实际 ${t3Settled.status}）`);
  assert.equal(t3Settled.imageOcrDeferred, true, "图片来源应标记延迟解析");
  assert.equal(t3Settled.coverageText, "2张图片待解析", `coverageText 实际 ${t3Settled.coverageText}`);
  pass("T3a 图片来源延迟：ready（纯图待解析不落 failed）+「2张图片待解析」");

  // T3b：触发 → 2 张识别 ready
  // 注：图片上传来源的识别输入是服务端资产名（ev_shot_<uuid>），
  // 无页号语义——用调用次数断言，图片身份由下方 completed/coverageText 断言覆盖
  await triggerImageOcr(tripB.tripId, t3SourceId);
  const t3After = await waitSettled(tripB.tripId, t3SourceId);
  assert.equal(stubRecognizeCalls.length, 2, "应识别全部 2 张待解析图（零多余调用）");
  assert.equal(t3After.status, "ready");
  assert.equal(t3After.imageOcrDeferred, false);
  assert.equal(t3After.imageProgress.completed, 2);
  assert.equal(t3After.coverageText, "2/2张图", `coverageText 实际 ${t3After.coverageText}`);
  pass("T3b 图片来源一键解析：2/2 ready");

  // ============ T4：下载失败 + deferred（14 可下载 + 3 失败） ============

  const tripC = await tripStore.create({
    destination: { city: "三亚" },
    dateRange: { start: "2026-11-08", end: "2026-11-10", nights: 2 },
  });
  createdTripIds.push(tripC.tripId);
  const t4FailedPages = new Set([3, 7, 13]);
  const t4Downloadable = Array.from({ length: 17 }, (_, i) => i + 1).filter((page) => !t4FailedPages.has(page));
  await prepareXhsDir("xhs_task215t4", t4Downloadable);

  stubNote = {
    success: true,
    title: "蜈支洲岛 17 图笔记（T4 部分下载失败）",
    text: "T4 正文：观日岩日落全记录。",
    sourceUrl: "https://www.xiaohongshu.com/explore/task215t4",
    imageSlots: Array.from({ length: 17 }, (_, position) => {
      const page = position + 1;
      if (t4FailedPages.has(page)) {
        return { index: page, path: null, error: "下载失败（HTTP 404）" };
      }
      return { index: page, path: `/api/uploads/xhs_task215t4/${page}.jpg` };
    }),
  };

  stubRecognizeCalls.length = 0;
  const t4Submit = await submitGuideSource(tripC.tripId, {
    inputKind: "link",
    url: "https://www.xiaohongshu.com/explore/task215t4",
  });
  const t4SourceId = t4Submit.sourceId;
  const t4Settled = await waitSettled(tripC.tripId, t4SourceId);

  // T4a：下载失败图如实计数 → partial（pending 不再额外放大失败面）
  assert.equal(t4Settled.status, "partial", `3 张下载失败应 partial（实际 ${t4Settled.status}）`);
  assert.equal(t4Settled.imageOcrDeferred, true);
  assert.equal(t4Settled.imageProgress.failed, 3, "failed 只计下载失败的 3 张");
  assert.equal(
    t4Settled.coverageText,
    "正文 + 14张图片待解析 + 3张图下载失败",
    `coverageText 实际 ${t4Settled.coverageText}`,
  );
  for (const failedPage of t4FailedPages) {
    assert.equal(entryOf(t4Settled, failedPage).failureCode, "download_failed", `P${failedPage} 应 download_failed 占位`);
  }
  pass("T4a 下载失败 + deferred：partial +「14张图片待解析 + 3张图下载失败」");

  // T4b：retry 拒绝（下载失败图无原图可定位，既有行为不变）
  await assert.rejects(
    () => retryGuideSource(tripC.tripId, t4SourceId),
    (error: unknown) => error instanceof AiError && error.code === "SOURCE_NOT_RETRYABLE",
    "下载失败图无原图应拒绝重试",
  );
  pass("T4b retry 拒绝：download_failed 不可重试（既有行为不变）");

  // T4c：trigger 只跑 14 张 pending（下载失败图不动）→ partial
  await triggerImageOcr(tripC.tripId, t4SourceId);
  const t4After = await waitSettled(tripC.tripId, t4SourceId);
  assert.deepEqual(
    [...stubRecognizeCalls].sort((left, right) => left - right),
    [...t4Downloadable],
    `一键解析应只跑 ${t4Downloadable.length} 张待解析图（下载失败图不动）`,
  );
  assert.equal(t4After.status, "partial", "仍有 3 张下载失败 → partial");
  assert.equal(t4After.imageOcrDeferred, false);
  assert.equal(t4After.imageProgress.completed, 14);
  assert.equal(t4After.coverageText, "正文 + 14/17张图", `coverageText 实际 ${t4After.coverageText}`);
  pass("T4c 一键解析只跑 pending：14/17 + partial");

  // ============ T5：边界（零迁移兼容） ============

  // T5a：文字来源（无 imageOcrDeferred 字段 = 历史来源语义）触发被拒
  const tripD = await tripStore.create({
    destination: { city: "三亚" },
    dateRange: { start: "2026-11-08", end: "2026-11-10", nights: 2 },
  });
  createdTripIds.push(tripD.tripId);
  const t5Submit = await submitGuideSource(tripD.tripId, {
    inputKind: "text",
    text: "T5 正文：西岛一日游路线。",
  });
  const t5Settled = await waitSettled(tripD.tripId, t5Submit.sourceId);
  assert.equal(t5Settled.status, "ready", "文字来源不受延迟解析影响（正文正常结算 ready）");
  assert.equal(t5Settled.imageOcrDeferred, undefined, "文字来源不应有延迟标记");
  await assert.rejects(
    () => triggerImageOcr(tripD.tripId, t5Submit.sourceId),
    (error: unknown) => error instanceof AiError && error.code === "SOURCE_NOT_RETRYABLE",
    "无 imageOcrDeferred 字段的来源不应允许触发",
  );
  pass("T5a 文字来源零迁移：无延迟标记、触发被拒、正文正常结算");

  // T5b：不存在的来源
  await assert.rejects(
    () => triggerImageOcr(tripD.tripId, "src_nonexistent"),
    (error: unknown) => error instanceof AiError && error.code === "SOURCE_NOT_FOUND",
    "不存在的来源应 SOURCE_NOT_FOUND",
  );
  pass("T5b 来源不存在：SOURCE_NOT_FOUND");

  console.log("");
  console.log("verify-task215 全部通过 ✓");
}

main()
  .catch(async (error: unknown) => {
    console.error("\nverify-task215 失败：", error);
    process.exitCode = 1;
  })
  .finally(() => cleanup());
