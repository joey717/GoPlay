/**
 * Task #222 确定性验证（离线：全程桩注入，不抓取小红书、不调用百炼 / FlyAI）。
 *
 * 修复背景：存量链接来源（如 07a624b0/src_599e2ea2）5 张图 4 张 ready、第 1 张
 * 卡在 pending（无证据、无 assetPath，但原图仍在盘上），来源 partial 且
 * imageOcrDeferred 缺失。旧 retryGuideSource 对 partial 只认 failed → skipped，
 * 残留 pending 既不算失败也不可重试 → 点「重试」报「没有可重试的失败项」，
 * 永久死锁。
 *
 * 验证矩阵：
 *   S1 主场景（真实数据同构）：partial + 4 ready + 1 残留 pending（无证据 /
 *      无 assetPath，文件在盘）→ 重试成功 → 凭小红书落盘约定探测定位原图 →
 *      只补识别第 1 张（不重复识别 2-5、零重抓、零正文重抽）→ ready 5/5；
 *   S2 残留收敛：延迟来源触发解析后，原图不可定位（assetPath 缺失 + 文件已删）
 *      的图被队列跳过 → 结算收敛为 failed(timeout) 而非永远 pending → partial
 *      如实计数失败；后续重试被精确拒绝（失败图片的原图均不可定位）；
 *   S3 回归：ready 且无跳过 / 残留图的重试仍被拒绝（已处理完成）；
 *   S4 回归：延迟 partial（正文缺失）重试仍优先补正文（Task #217 路径不被
 *      Task #222 的残留图兜底劫持），解析延迟标记不被解除。
 *
 * 运行：npx tsx server/src/guides/verify-task222.ts
 * 不抓取真实笔记、不调用付费模型；临时行程 / 上传目录在 finally 全部清理。
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import type { GuideSource, Trip } from "@goplay/shared";
import type { ParsedEntry } from "../ai/assemble.js";
import type { OcrScreenshotInput, RecognizedImageContent } from "../ai/ocr.js";
import type { PrefilterImageInput, PrefilterSkipDecision } from "../ai/prefilter.js";
import { AiError } from "../ai/errors.js";
import { type XhsNoteResult } from "../ai/xhs.js";
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

/** 轮询来源直到离开 processing（后台 fire-and-forget 任务完成；全离线桩，秒级） */
async function waitSettled(tripId: string, sourceId: string, timeoutMs = 30_000): Promise<GuideSource> {
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

async function loadSource(tripId: string, sourceId: string): Promise<{ trip: Trip; source: GuideSource }> {
  const trip = await tripStore.load(tripId);
  assert.ok(trip !== null, `行程 ${tripId} 应存在`);
  const source = trip.guideSources?.[sourceId];
  assert.ok(source !== undefined, `来源 ${sourceId} 应存在`);
  return { trip, source };
}

// ===== 生成测试 PNG（零依赖：手写 CRC + chunk + deflate 纯色图） =====

const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0;
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

function makePng(width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const raw = new Uint8Array((1 + width * 3) * height);
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

// ===== service 桩（行为由用例改写；全程零网络） =====

const fetchCalls: string[] = [];
const extractCalls: string[] = [];
/** 正文抽取结果：空数组 = 抽取成功但零条目（与存量 src_599e2ea2 的空 note 证据同构） */
let stubExtract: ParsedEntry[] | Error = [];
/** 图片识别调用记录的页码（“只补识别第 1 张”断言的依据） */
const recognizeCalls: number[] = [];

function pageFromFilename(filename: string): number {
  const match = filename.match(/(\d+)/);
  return match !== null ? Number(match[1]) : 0;
}

let stubNote: XhsNoteResult = { success: true };

const stubFetchNote = async (url: string): Promise<XhsNoteResult> => {
  fetchCalls.push(url);
  return { ...stubNote };
};

const stubExtractEntries = async (text: string): Promise<ParsedEntry[]> => {
  extractCalls.push(text);
  if (stubExtract instanceof Error) throw stubExtract;
  return stubExtract;
};

const stubRecognizeImage = async (image: OcrScreenshotInput): Promise<RecognizedImageContent> => {
  const page = pageFromFilename(image.filename);
  recognizeCalls.push(page);
  return { ocrText: `第 ${page} 张图识别文本（task222 桩）`, mentions: [] };
};

const stubPrefilterBatch = async (
  items: readonly PrefilterImageInput[],
): Promise<Map<number, PrefilterSkipDecision>> => {
  void items;
  return new Map<number, PrefilterSkipDecision>();
};

// ===== 临时资源与清理 =====

const createdTripIds: string[] = [];
const createdXhsDirs: string[] = [];

async function prepareXhsDir(dirName: string, pages: readonly number[]): Promise<void> {
  const dir = path.join(UPLOADS_DIR, dirName);
  createdXhsDirs.push(dir);
  await fs.mkdir(dir, { recursive: true });
  const png = makePng(64, 64);
  for (const page of pages) {
    await fs.writeFile(path.join(dir, `${page}.jpg`), png);
  }
}

function slots(dirName: string, pages: readonly number[]): XhsNoteResult["imageSlots"] {
  return pages.map((page) => ({ index: page, path: `/api/uploads/${dirName}/${page}.jpg` }));
}

async function cleanup(): Promise<void> {
  resetGuideServiceDeps();
  for (const tripId of createdTripIds) {
    await tripStore.deleteTrip(tripId).catch(() => undefined);
  }
  for (const dir of createdXhsDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const NOTE_TEXT = "三亚美食攻略：西岛坐船，牛王岛看海，椰梦长廊吹风，天涯海角拍照（task222 桩正文）。";

/** 提交链接来源并等待结算（正文抽取零条目 → 空 note_text 证据，同存量形态） */
async function submitLinkSource(tripId: string, dirName: string, pages: readonly number[]): Promise<string> {
  stubNote = {
    success: true,
    title: `task222 笔记（${dirName}）`,
    text: NOTE_TEXT,
    sourceUrl: `https://www.xiaohongshu.com/explore/${dirName.slice("xhs_".length)}`,
    imageSlots: slots(dirName, pages),
  };
  const submitted = await submitGuideSource(tripId, { inputKind: "link", url: stubNote.sourceUrl! });
  await waitSettled(tripId, submitted.sourceId);
  return submitted.sourceId;
}

async function main(): Promise<void> {
  setGuideServiceDeps({
    fetchNote: stubFetchNote,
    extractEntries: stubExtractEntries,
    recognizeImage: stubRecognizeImage,
    prefilterBatch: stubPrefilterBatch,
  });

  const trip = await tripStore.create({
    destination: { city: "三亚" },
    dateRange: { start: "2026-11-08", end: "2026-11-10", nights: 2 },
  });
  createdTripIds.push(trip.tripId);

  // ============ S1：主场景——残留 pending 图凭落盘约定探测恢复 ============

  await prepareXhsDir("xhs_task222s1", [1, 2, 3, 4, 5]);
  const s1SourceId = await submitLinkSource(trip.tripId, "xhs_task222s1", [1, 2, 3, 4, 5]);
  // 延迟解析：全部 5 张识别完成（复刻「4 完成 + 1 残留」前的完整状态）
  await triggerImageOcr(trip.tripId, s1SourceId);
  const s1Before = await waitSettled(trip.tripId, s1SourceId);
  assert.equal(s1Before.status, "ready", "用例前提：图片全部完成后应 ready");

  // 手术复刻存量形态（07a624b0/src_599e2ea2 同构）：第 1 张回 pending、无证据、
  // 无 assetPath（Task #215 之前的落盘形态），其截图证据一并移除；来源回 partial
  {
    const current = await loadSource(trip.tripId, s1SourceId);
    const entry = current.source.imageProgress.images[0];
    assert.ok(entry !== undefined && entry.status === "ready");
    const evidenceId = entry.evidenceId;
    assert.ok(evidenceId !== null);
    delete current.trip.evidences[evidenceId];
    current.source.evidenceRefs = current.source.evidenceRefs.filter((id) => id !== evidenceId);
    entry.status = "pending";
    entry.evidenceId = null;
    delete entry.assetPath;
    current.source.imageProgress.completed = 4;
    current.source.imageProgress.failed = 0;
    delete current.source.imageOcrDeferred;
    current.source.status = "partial";
    current.source.failureMessage = "部分内容处理未完成，成功部分已保留";
    await tripStore.save(current.trip);
  }

  // 用例前提即用户反馈的表象：partial、4/5 完成、零失败、1 张残留 pending
  {
    const { source } = await loadSource(trip.tripId, s1SourceId);
    assert.equal(source.status, "partial", "用例前提：残留 pending 使来源停在 partial");
    assert.equal(source.imageProgress.completed, 4, "用例前提：4 张完成");
    assert.equal(source.imageProgress.failed, 0, "用例前提：零失败（旧逻辑必报没有可重试项）");
    assert.equal(source.imageProgress.images[0].status, "pending", "用例前提：第 1 张残留 pending");
  }
  pass("S1a 手术复刻存量形态：partial + 4 ready + 1 残留 pending（无证据 / 无 assetPath）");

  const fetchBeforeS1 = fetchCalls.length;
  const extractBeforeS1 = extractCalls.length;
  const recognizeBeforeS1 = recognizeCalls.length;
  const s1Retried = await retryGuideSource(trip.tripId, s1SourceId);
  assert.equal(s1Retried.status, "processing", "残留 pending 图重试应被接受（回 processing）");
  const s1Ready = await waitSettled(trip.tripId, s1SourceId);
  {
    const { trip: s1Trip, source: s1Source } = await loadSource(trip.tripId, s1SourceId);
    assert.equal(s1Ready.status, "ready", `补齐残留图后应 ready（实际 ${s1Ready.status}）`);
    assert.equal(s1Source.imageProgress.completed, 5, "5/5 张图全部完成");
    assert.equal(s1Source.imageProgress.failed, 0, "零失败");
    const entry = s1Source.imageProgress.images[0];
    assert.equal(entry.status, "ready", "第 1 张应恢复 ready");
    assert.ok(entry.evidenceId !== null, "第 1 张应重建截图证据");
    assert.ok(s1Trip.evidences[entry.evidenceId] !== undefined, "新证据应真实存在");
    assert.ok(
      (s1Trip.evidences[entry.evidenceId].assetPath ?? "") !== "",
      "新证据应携带原图 assetPath（后续重试不再依赖探测）",
    );
    assert.equal(fetchCalls.length, fetchBeforeS1, "重试不得重新抓取小红书");
    assert.equal(extractCalls.length, extractBeforeS1, "正文证据已存在时重试不得重抽正文");
    assert.deepEqual(recognizeCalls.slice(recognizeBeforeS1), [1], "只补识别第 1 张（不重复识别 2-5）");
    assert.equal(s1Source.evidenceRefs.length, 6, "证据引用 = 空 note + 4 张沿用截图 + 1 张新截图");
    assert.equal(s1Source.coverageText, "5/5张图", `coverageText 实际 ${s1Source.coverageText}`);
  }
  pass("S1b 残留 pending 重试：凭落盘约定探测定位原图，只补第 1 张 → ready 5/5");

  // ============ S3：ready 且无跳过 / 残留图 → 重试仍拒绝 ============

  {
    let refused: AiError | null = null;
    try {
      await retryGuideSource(trip.tripId, s1SourceId);
    } catch (error) {
      refused = error instanceof AiError ? error : null;
    }
    assert.ok(refused !== null, "无跳过 / 残留图的 ready 重试应被拒绝");
    assert.equal(refused!.code, "SOURCE_NOT_RETRYABLE");
    assert.match(refused!.message, /已处理完成/, `拒绝原因实际：${refused!.message}`);
  }
  pass("S3 回归：ready 且无可重试图 → 仍拒绝「已处理完成」");

  // ============ S2：原图不可定位的残留图 → 结算收敛 failed(timeout) + 精确拒绝 ============

  await prepareXhsDir("xhs_task222s2", [1, 2]);
  const s2SourceId = await submitLinkSource(trip.tripId, "xhs_task222s2", [1, 2]);
  {
    const { source } = await loadSource(trip.tripId, s2SourceId);
    assert.equal(source.status, "ready", "用例前提：延迟来源正文回填后 ready");
    assert.equal(source.imageOcrDeferred, true, "用例前提：延迟解析标记在");
  }
  // 手术：第 1 张进度明细去掉 assetPath 且盘上文件删除（原图不可定位），保持延迟标记
  {
    const current = await loadSource(trip.tripId, s2SourceId);
    delete current.source.imageProgress.images[0].assetPath;
    await tripStore.save(current.trip);
    await fs.rm(path.join(UPLOADS_DIR, "xhs_task222s2", "1.jpg"));
  }

  await triggerImageOcr(trip.tripId, s2SourceId);
  const s2Settled = await waitSettled(trip.tripId, s2SourceId);
  {
    const { source } = await loadSource(trip.tripId, s2SourceId);
    assert.equal(s2Settled.status, "partial", `有失败图应 partial（实际 ${s2Settled.status}）`);
    assert.equal(source.imageProgress.failed, 1, "不可定位图应收敛为 failed（不再永远 pending）");
    const entry = source.imageProgress.images[0];
    assert.equal(entry.status, "failed", "第 1 张应为 failed");
    assert.equal(entry.failureCode, "timeout", "残留收敛记 timeout");
    assert.equal(entry.failureMessage, "图片处理未完成（中断残留），可重试");
    assert.equal(source.imageProgress.images[1].status, "ready", "第 2 张正常解析 ready");
    assert.match(
      source.failureMessage ?? "",
      /部分图片处理失败（1\/2）/,
      `来源失败文案应如实计数（实际 ${String(source.failureMessage)}）`,
    );
  }
  pass("S2a 原图不可定位的残留图：结算收敛 failed(timeout)，partial 如实计数 1/2");

  {
    const { source } = await loadSource(trip.tripId, s2SourceId);
    const failedBefore = source.imageProgress.failed;
    let refused: AiError | null = null;
    try {
      await retryGuideSource(trip.tripId, s2SourceId);
    } catch (error) {
      refused = error instanceof AiError ? error : null;
    }
    assert.ok(refused !== null, "原图不可定位的失败图重试应被拒绝");
    assert.equal(refused!.code, "SOURCE_NOT_RETRYABLE");
    assert.match(refused!.message, /失败图片的原图均不可定位/, `拒绝原因实际：${refused!.message}`);
    const after = await loadSource(trip.tripId, s2SourceId);
    assert.equal(after.source.imageProgress.failed, failedBefore, "被拒绝后进度不得变动");
    assert.equal(after.source.status, "partial", "被拒绝后状态不得变动");
  }
  pass("S2b 原图确实缺失时重试被精确拒绝，来源状态与进度不动");

  // ============ S4：延迟 partial（正文缺失）重试仍优先补正文 ============

  await prepareXhsDir("xhs_task222s4", [1, 2]);
  stubExtract = new Error("正文抽取超时（task222 桩）");
  const s4SourceId = await submitLinkSource(trip.tripId, "xhs_task222s4", [1, 2]);
  {
    const { source } = await loadSource(trip.tripId, s4SourceId);
    assert.equal(source.status, "partial", "用例前提：正文失败 + 延迟图 → partial");
    assert.equal(source.imageOcrDeferred, true, "用例前提：延迟解析标记在");
  }
  const fetchBeforeS4 = fetchCalls.length;
  const recognizeBeforeS4 = recognizeCalls.length;
  stubExtract = []; // 重抽成功（零条目，保持离线）
  await retryGuideSource(trip.tripId, s4SourceId);
  const s4Settled = await waitSettled(trip.tripId, s4SourceId);
  {
    const { source } = await loadSource(trip.tripId, s4SourceId);
    assert.equal(s4Settled.status, "ready", `补正文后应回 ready（实际 ${s4Settled.status}）`);
    assert.equal(source.imageOcrDeferred, true, "补正文不得解除图片延迟解析标记");
    assert.equal(fetchCalls.length, fetchBeforeS4, "补正文走持久化原文，不得重新抓取");
    assert.equal(recognizeCalls.length, recognizeBeforeS4, "补正文不得顺带启动图片识别");
    assert.equal(source.coverageText, "2张图片待解析", `coverageText 实际 ${source.coverageText}`);
  }
  pass("S4 回归：延迟 partial 补正文优先，不被残留图兜底劫持，延迟标记保持");

  console.log("\nTask #222 全部验证通过 ✅");
}

main()
  .catch((error) => {
    console.error("✗ Task #222 验证失败：", error);
    process.exitCode = 1;
  })
  .finally(() => cleanup());
