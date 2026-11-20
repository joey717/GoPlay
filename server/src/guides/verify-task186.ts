/**
 * 任务 186 确定性验证（离线：全程桩注入，不触网、不调用付费百炼）。
 *
 * 覆盖矩阵：
 *   段 A  text 来源创建时持久化完整原文 sourceText（内存与落盘一致）；
 *   段 B  images 来源提交即写入明细 assetPath，按上传顺序落盘（原图字节一致），
 *         单图同样正常；
 *   段 C  text 来源 failed 后凭 sourceText 重试成功（sourceVersion+1、原文保持）；
 *         历史来源无 sourceText 重试 → SOURCE_NOT_RETRYABLE（不冒进）；
 *   段 D  duplicate 非 rerun：contentHash 一致时回填历史来源缺失的 sourceText；
 *         URL 命中但正文不同（contentHash 不一致）不回填（不冒充原文）；
 *   段 E  images 来源 failed 重新导入（rerun）：重建明细并重新写入 assetPath。
 *
 * 运行：npx tsx server/src/guides/verify-task186.ts
 * 不触网、不留数据（临时行程与上传目录在 finally 全部清理）。
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import type { GuideSource, Trip } from "@goplay/shared";
import { AiError } from "../ai/errors.js";
import type { ParsedEntry } from "../ai/assemble.js";
import type { OcrScreenshotInput, RecognizedImageContent } from "../ai/ocr.js";
import type { PrefilterImageInput, PrefilterSkipDecision } from "../ai/prefilter.js";
import type { XhsNoteResult } from "../ai/xhs.js";
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

/** assetPath（"uploads/{tripId}/{file}"）→ 磁盘真实路径（UPLOADS_DIR/{tripId}/{file}） */
function assetDiskPath(assetPath: string): string {
  return path.join(UPLOADS_DIR, assetPath.replace(/^uploads\//, ""));
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

/** width×height 纯色 PNG（fill 决定像素值，不同 fill 产生不同字节内容） */
function makePng(width: number, height: number, fill: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const rawRowLength = 1 + width * 3;
  const raw = new Uint8Array(rawRowLength * height).fill(fill);
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

/** 文字抽取桩：数组 = 正常返回条目；Error = 抛出（模拟提取失败 → 来源 failed） */
let stubExtract: ParsedEntry[] | Error = [];

/** 图片识别桩：true = 抛错（模拟识别失败） */
let stubRecognizeFail = false;

function mkEntry(name: string, type: ParsedEntry["type"], confidence: ParsedEntry["confidence"]): ParsedEntry {
  return {
    name,
    type,
    parentAttraction: null,
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

const stubFetchNote = async (_url: string): Promise<XhsNoteResult> => ({ success: true });
const stubExtractEntries = async (_text: string): Promise<ParsedEntry[]> => {
  if (stubExtract instanceof Error) throw stubExtract;
  return stubExtract;
};
const stubRecognizeImage = async (
  _image: OcrScreenshotInput,
  _options?: { editedText?: string },
): Promise<RecognizedImageContent> => {
  if (stubRecognizeFail) {
    throw new AiError("BAILIAN_REQUEST_FAILED", "识别失败（task186 桩）");
  }
  return { ocrText: "task186 桩识别文本", mentions: [] };
};
const stubPrefilterBatch = async (
  items: readonly PrefilterImageInput[],
): Promise<Map<number, PrefilterSkipDecision>> => {
  void items;
  return new Map<number, PrefilterSkipDecision>();
};

// ===== 临时资源与清理 =====

const createdTripIds: string[] = [];

async function cleanup(): Promise<void> {
  resetGuideServiceDeps();
  for (const tripId of createdTripIds) {
    await tripStore.deleteTrip(tripId).catch(() => undefined);
  }
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

  // ============ 段 A：text 来源创建时持久化完整原文 ============

  const TEXT_A = "第一天下机直奔亚龙湾。\n第二天早起去蜈支洲岛，记得提前订船票。";
  stubExtract = [mkEntry("亚龙湾", "attraction", "high")];
  const submitA = await submitGuideSource(trip.tripId, { inputKind: "text", text: TEXT_A });
  const settledA = await waitSettled(trip.tripId, submitA.sourceId);
  assert.equal(settledA.status, "ready", "文字来源桩抽取成功应 ready");
  assert.equal(settledA.sourceText, TEXT_A, "创建时应原样持久化用户提交的完整原文（含换行）");
  // 落盘验证：重新从磁盘加载仍能读到原文
  const reloadedA = await loadTrip(trip.tripId);
  assert.equal(
    reloadedA.guideSources?.[submitA.sourceId]?.sourceText,
    TEXT_A,
    "sourceText 应随 Trip 持久化落盘",
  );
  pass("A1 text 来源创建时持久化完整原文（含换行，落盘可读）");

  // ============ 段 B：images 来源提交即写入明细 assetPath（按上传顺序） ============

  const pngBlack = makePng(64, 64, 0x00);
  const pngWhite = makePng(64, 64, 0xff);
  assert.notDeepEqual([...pngBlack], [...pngWhite], "用例前提：两张图字节不同");
  const submitB = await submitGuideSource(trip.tripId, {
    inputKind: "images",
    images: [
      { data: pngBlack, filename: "shot-1.png", mimeType: "image/png" },
      { data: pngWhite, filename: "shot-2.png", mimeType: "image/png" },
    ],
  });
  const settledB = await waitSettled(trip.tripId, submitB.sourceId);
  assert.equal(settledB.status, "ready", "纯图待解析延迟结算也应 ready（Task #215）");
  assert.equal(settledB.imageProgress.images.length, 2);
  const entryB1 = settledB.imageProgress.images[0];
  const entryB2 = settledB.imageProgress.images[1];
  assert.ok(
    typeof entryB1.assetPath === "string" && entryB1.assetPath.startsWith(`uploads/${trip.tripId}/`),
    `明细 P1 应写入受控 assetPath（实际 ${String(entryB1.assetPath)}）`,
  );
  assert.ok(
    typeof entryB2.assetPath === "string" && entryB2.assetPath.startsWith(`uploads/${trip.tripId}/`),
    "明细 P2 应写入受控 assetPath",
  );
  assert.notEqual(entryB1.assetPath, entryB2.assetPath, "两图应各自落盘");
  // 顺序：第 1 条明细的文件字节 = 第 1 张上传图（若顺序错乱则字节不等，断言即败）
  const fileB1 = await fs.readFile(assetDiskPath(entryB1.assetPath!));
  const fileB2 = await fs.readFile(assetDiskPath(entryB2.assetPath!));
  assert.ok(fileB1.equals(pngBlack), "P1 落盘文件应与第 1 张上传图字节一致（顺序正确）");
  assert.ok(fileB2.equals(pngWhite), "P2 落盘文件应与第 2 张上传图字节一致（顺序正确）");
  // Task #215：图片默认不解析——延迟结算期明细 pending、尚无证据
  assert.equal(settledB.imageOcrDeferred, true, "images 来源应标记延迟解析");
  assert.ok(
    entryB1.evidenceId === null && entryB2.evidenceId === null,
    "待解析期明细不应指向证据",
  );

  // 手动触发解析：从明细 assetPath 定位原图建证据
  await triggerImageOcr(trip.tripId, submitB.sourceId);
  const triggeredB = await waitSettled(trip.tripId, submitB.sourceId);
  assert.equal(triggeredB.status, "ready", "两张图识别成功应 ready");
  assert.equal(triggeredB.imageOcrDeferred, false, "触发后延迟标记解除");
  assert.ok(
    triggeredB.imageProgress.images[0].evidenceId !== null &&
      triggeredB.imageProgress.images[1].evidenceId !== null,
    "触发解析后明细应指向已提交证据",
  );
  pass("B1 images 来源按上传顺序写入明细 assetPath，原图落盘可读");

  // 单图来源同样正常
  const pngGray = makePng(48, 48, 0x80);
  const submitB2 = await submitGuideSource(trip.tripId, {
    inputKind: "images",
    images: [{ data: pngGray, filename: "shot-single.png", mimeType: "image/png" }],
  });
  const settledB2 = await waitSettled(trip.tripId, submitB2.sourceId);
  assert.equal(settledB2.status, "ready");
  assert.equal(settledB2.imageProgress.images.length, 1);
  assert.ok(
    typeof settledB2.imageProgress.images[0].assetPath === "string",
    "单图来源也应写入明细 assetPath",
  );
  pass("B2 单图来源同样写入 assetPath");

  // ============ 段 C：text 来源 failed 重试（凭 sourceText） ============

  const TEXT_C = "失败重试用例原文：后海村冲浪小店清单。";
  stubExtract = new AiError("BAILIAN_REQUEST_FAILED", "抽取失败（task186 桩）");
  const submitC = await submitGuideSource(trip.tripId, { inputKind: "text", text: TEXT_C });
  const failedC = await waitSettled(trip.tripId, submitC.sourceId);
  assert.equal(failedC.status, "failed", "抽取桩抛错应 failed");
  assert.equal(failedC.sourceText, TEXT_C, "失败时原文已在创建阶段持久化（可重试凭据）");
  stubExtract = [mkEntry("后海村", "attraction", "medium")];
  const retriedC = await retryGuideSource(trip.tripId, submitC.sourceId);
  assert.equal(retriedC.status, "processing", "重试后状态回 processing");
  assert.equal(retriedC.sourceVersion, failedC.sourceVersion + 1, "重试递增 sourceVersion");
  const settledC = await waitSettled(trip.tripId, submitC.sourceId);
  assert.equal(settledC.status, "ready", "凭持久化原文重试应成功");
  assert.equal(settledC.sourceText, TEXT_C, "重试成功后原文保持不变");
  pass("C1 text 来源 failed 后凭 sourceText 重试成功，原文保持");

  // C2 历史 text 来源无 sourceText：重试拒绝（不冒进）
  const tripLegacy = await loadTrip(trip.tripId);
  const legacySource = tripLegacy.guideSources?.[submitC.sourceId];
  assert.ok(legacySource !== undefined);
  legacySource.status = "failed";
  delete legacySource.sourceText;
  await tripStore.save(tripLegacy);
  await assert.rejects(
    () => retryGuideSource(trip.tripId, submitC.sourceId),
    (error: unknown) => error instanceof AiError && error.code === "SOURCE_NOT_RETRYABLE",
    "历史来源无 sourceText 重试应 SOURCE_NOT_RETRYABLE",
  );
  pass("C2 历史 text 来源无 sourceText 重试被拒（SOURCE_NOT_RETRYABLE）");

  // ============ 段 D：duplicate 命中时的原文回填口径 ============

  // D1 contentHash 一致（同一篇文本）：回填历史来源缺失的 sourceText
  const tripD1 = await loadTrip(trip.tripId);
  const d1Source = tripD1.guideSources?.[submitA.sourceId];
  assert.ok(d1Source !== undefined && typeof d1Source.contentHash === "string", "用例前提：来源有 contentHash");
  delete d1Source.sourceText; // 模拟历史来源
  await tripStore.save(tripD1);
  const dupD1 = await submitGuideSource(trip.tripId, { inputKind: "text", text: TEXT_A });
  assert.equal(dupD1.duplicate, true, "相同文本应命中 duplicate");
  assert.equal(dupD1.source.sourceId, submitA.sourceId);
  assert.equal(dupD1.source.sourceText, TEXT_A, "contentHash 一致时应回填原文");
  pass("D1 duplicate 非 rerun：contentHash 一致时回填历史来源缺失的 sourceText");

  // D2 URL 命中但正文不同：不回填（不冒充原文）
  const TEXT_D2 = "D2 种子正文：海棠湾免税店购物动线。";
  stubExtract = [mkEntry("海棠湾", "attraction", "low")];
  const submitD2 = await submitGuideSource(trip.tripId, {
    inputKind: "text",
    text: TEXT_D2,
    sourceUrl: "https://example.com/note-d2",
  });
  await waitSettled(trip.tripId, submitD2.sourceId);
  const tripD2 = await loadTrip(trip.tripId);
  const d2Source = tripD2.guideSources?.[submitD2.sourceId];
  assert.ok(d2Source !== undefined);
  delete d2Source.sourceText;
  d2Source.contentHash = "legacyhash00000000"; // 模拟历史 hash（与任何新文本不同）
  await tripStore.save(tripD2);
  const dupD2 = await submitGuideSource(trip.tripId, {
    inputKind: "text",
    text: "完全不同的另一篇正文，与种子文本毫无关系。",
    sourceUrl: "https://example.com/note-d2",
  });
  assert.equal(dupD2.duplicate, true, "相同 URL 应命中 duplicate");
  assert.equal(
    dupD2.source.sourceText,
    undefined,
    "URL 命中但 contentHash 不一致：不得把本次文本冒充存量来源原文",
  );
  pass("D2 duplicate 非 rerun：URL 命中但正文不同不回填（不冒充原文）");

  // ============ 段 E：images 来源 failed 重新导入（rerun）重建 assetPath ============

  stubRecognizeFail = true;
  const pngBlue = makePng(40, 40, 0x3f);
  const submitE = await submitGuideSource(trip.tripId, {
    inputKind: "images",
    images: [{ data: pngBlue, filename: "shot-e.png", mimeType: "image/png" }],
  });
  // Task #215：提交后延迟结算 ready（纯图待解析不落 failed）；触发解析后单图失败 → failed
  const deferredE = await waitSettled(trip.tripId, submitE.sourceId);
  assert.equal(deferredE.status, "ready", "纯图待解析延迟结算 ready（不落 failed）");
  await triggerImageOcr(trip.tripId, submitE.sourceId);
  const failedE = await waitSettled(trip.tripId, submitE.sourceId);
  assert.equal(failedE.status, "failed", "单图识别失败（无可用证据）应 failed");
  assert.ok(
    typeof failedE.imageProgress.images[0].assetPath === "string",
    "失败来源在提交阶段也已写入 assetPath（提交落盘即知）",
  );
  // 模拟历史失败来源：清掉 assetPath，重新导入应重建并再次写入
  const tripE = await loadTrip(trip.tripId);
  const eSource = tripE.guideSources?.[submitE.sourceId];
  assert.ok(eSource !== undefined);
  delete eSource.imageProgress.images[0].assetPath;
  await tripStore.save(tripE);
  stubRecognizeFail = false;
  const rerunE = await submitGuideSource(trip.tripId, {
    inputKind: "images",
    images: [{ data: pngBlue, filename: "shot-e.png", mimeType: "image/png" }],
  });
  assert.equal(rerunE.duplicate, true, "相同图应命中 duplicate");
  assert.equal(rerunE.source.sourceId, submitE.sourceId);
  assert.equal(rerunE.source.status, "processing", "failed 来源重新导入回 processing");
  const settledE = await waitSettled(trip.tripId, submitE.sourceId);
  assert.equal(settledE.status, "ready");
  const rerunEntry = settledE.imageProgress.images[0];
  assert.ok(
    typeof rerunEntry.assetPath === "string" && rerunEntry.assetPath.startsWith(`uploads/${trip.tripId}/`),
    "rerun 应重建明细并写入 assetPath",
  );
  const fileE = await fs.readFile(assetDiskPath(rerunEntry.assetPath!));
  assert.ok(fileE.equals(pngBlue), "rerun 落盘文件与上传图字节一致");
  pass("E1 images 来源 failed 重新导入：rerun 重建明细 assetPath");

  console.log("\n任务 186 全部验证通过 ✅");
}

main()
  .catch((error) => {
    console.error("✗ 任务 186 验证失败：", error);
    process.exitCode = 1;
  })
  .finally(() => cleanup());
