/**
 * Task #217 确定性验证（离线：全程桩注入，不抓取小红书、不调用百炼）。
 *
 * 修复背景：小红书西岛攻略正文含 9 个打卡点，但 note_text 证据从未创建
 * （抽取超时 / 解析失败），来源只带着截图 OCR 的 1 条提及结算 partial；
 * 旧 retryGuideSource 对 partial 只重跑 failed | skipped 图片，正文缺失
 * 既不会被发现也无法修复（无失败图时直接 SOURCE_NOT_RETRYABLE）。
 *
 * 验证矩阵：
 *   T1 链接来源 partial（无 note_text、无失败图）：抓取正文已持久化到 sourceText →
 *      重试零重抓（fetch 调用数不变）→ 凭原文重抽 → note_text 证据 + 9 条提及
 *      全部恢复 → ready；
 *   T2 历史链接来源（手动删 sourceText 模拟存量数据）：无原文可重抽 → 兜底重新抓取
 *      （fetch +1）→ 正文提及恢复；
 *   T3 历史链接来源重抓失败（XHS 风控）：保持 partial、既有证据与图片进度不清空，
 *      failureMessage 透出本次抓取失败原因（不再泛化为「部分内容处理未完成」）；
 *   T4 partial 且已有 note_text（正文成功、图失败）：重试只跑图片，不重抽正文、
 *      不新建第二份 note_text 证据；
 *   T5 正文缺失 + 图片失败并存（西岛实况）：一次重试优先补正文（图仍失败 → partial），
 *      二次重试补图 → ready；正文证据始终只有 1 份；
 *   T6 同一篇笔记重抓成功：已完成图沿用原结果（不重识别、不重建截图证据）、
 *      sourceText 回填、coverageText 回到「正文 + N/N张图」。
 *
 * 运行：npx tsx server/src/guides/verify-task217.ts
 * 不抓取真实笔记、不调用付费模型；临时行程 / 上传目录在 finally 全部清理。
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import type { GuideSource, SourceEvidence, Trip } from "@goplay/shared";
import type { ParsedEntry } from "../ai/assemble.js";
import type { OcrScreenshotInput, RecognizedImageContent } from "../ai/ocr.js";
import type { PrefilterImageInput, PrefilterSkipDecision } from "../ai/prefilter.js";
import { XhsError, type XhsNoteResult } from "../ai/xhs.js";
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

/** 轮询来源直到离开 processing（后台 fire-and-forget 任务完成）。
 *  9 条点位逐条与服务端真实 POI 对齐（道具直连 FlyAI）需数十秒，超时宽至 120s */
async function waitSettled(tripId: string, sourceId: string, timeoutMs = 120_000): Promise<GuideSource> {
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

/** 来源下的全部 note_text 证据（正文证据） */
function noteEvidences(trip: Trip, source: GuideSource): SourceEvidence[] {
  const result: SourceEvidence[] = [];
  for (const evidenceId of source.evidenceRefs) {
    const evidence = trip.evidences[evidenceId];
    if (evidence !== undefined && evidence.kind === "note_text") result.push(evidence);
  }
  return result;
}

/** 正文证据的提及总数（跨全部 note_text 证据） */
function noteMentionCount(trip: Trip, source: GuideSource): number {
  return noteEvidences(trip, source).reduce((sum, evidence) => sum + evidence.mentions.length, 0);
}

async function sourceWithTrip(tripId: string, sourceId: string): Promise<{ trip: Trip; source: GuideSource }> {
  const trip = await loadTrip(tripId);
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

// ===== service 桩（行为由用例改写） =====

/** 抓取调用记录（"零重抓" 断言的依据）；stubFetchFails 模拟小红书风控拦截 */
const fetchCalls: string[] = [];
let stubFetchFails = false;
let stubNote: XhsNoteResult = { success: true };

/** 正文抽取调用记录（"是否重抽正文" 断言的依据）；Error 模拟抽取失败 */
const extractCalls: string[] = [];
let stubExtract: ParsedEntry[] | Error = [];

/** 图片识别：throwPages 中的页码抛错（其余返回带 ocrText 的成功结果） */
const recognizeCalls: number[] = [];
let stubRecognizeThrowPages: number[] = [];

function pageFromFilename(filename: string): number {
  const match = filename.match(/(\d+)/);
  return match !== null ? Number(match[1]) : 0;
}

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

/** 西岛级样本：9 个打卡点（正文证据应产出 9 条提及） */
const SANYA_PLACES = [
  "西岛",
  "牛王岛",
  "椰梦长廊",
  "天涯海角",
  "南山文化旅游区",
  "后海村",
  "亚龙湾热带天堂森林公园",
  "鹿回头",
  "大小洞天",
];

const stubFetchNote = async (url: string): Promise<XhsNoteResult> => {
  fetchCalls.push(url);
  if (stubFetchFails) {
    // 消息含「风控」→ classifyLinkFailure 归类 blocked
    throw new XhsError("小红书风控拦截，抓取失败（task217 桩）");
  }
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
  if (stubRecognizeThrowPages.includes(page)) {
    throw new Error(`第 ${page} 张图识别失败（task217 桩）`);
  }
  return { ocrText: `第 ${page} 张图识别文本（task217 桩）`, mentions: [] };
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

  const NOTE_TEXT =
    "西岛一日游：先坐船上岛，牛王岛看海，回程去椰梦长廊吹风。天涯海角拍照，南山文化旅游区看海上观音，" +
    "傍晚回后海村吃海鲜，亚龙湾热带天堂森林公园走栈道，鹿回头等日落，最后大小洞天收尾。";

  // ============ T1：链接来源 partial（正文缺失）+ 已持久化正文 → 零重抓重抽 ============

  await prepareXhsDir("xhs_task217t1", [1, 2, 3]);
  stubNote = {
    success: true,
    title: "西岛一日游 9 个打卡点（T1）",
    text: NOTE_TEXT,
    sourceUrl: "https://www.xiaohongshu.com/explore/task217t1",
    imageSlots: slots("xhs_task217t1", [1, 2, 3]),
  };
  stubExtract = new Error("正文抽取超时（task217 桩）");
  const t1Submit = await submitGuideSource(trip.tripId, {
    inputKind: "link",
    url: "https://www.xiaohongshu.com/explore/task217t1",
  });
  const t1SourceId = t1Submit.sourceId;
  const t1Partial = await waitSettled(trip.tripId, t1SourceId);
  assert.equal(t1Partial.status, "partial", `正文抽取失败应 partial（实际 ${t1Partial.status}）`);
  assert.equal(fetchCalls.length, 1, "用例前提：抓取成功 1 次");

  // Task #217 修复 2：抓取正文与 contentHash 一同持久化（重抽凭据）
  {
    const { trip: t1Trip, source: t1Source } = await sourceWithTrip(trip.tripId, t1SourceId);
    assert.equal(t1Source.sourceText, NOTE_TEXT, "链接抓取成功应持久化正文到 sourceText");
    assert.equal(noteEvidences(t1Trip, t1Source).length, 0, "抽取失败不应产生 note_text 证据");
    // 无失败图（全部延迟待解析）→ 旧逻辑必然不可重试
    assert.equal(t1Source.imageProgress.failed, 0, "用例前提：无失败图");
  }
  pass("T1a 正文抽取失败 → partial + 正文已持久化 + 无 note_text 证据");

  stubExtract = SANYA_PLACES.map((name) => mkEntry(name, "attraction", "medium"));
  const t1Retried = await retryGuideSource(trip.tripId, t1SourceId);
  assert.equal(t1Retried.status, "processing", "重试后状态回 processing");
  const t1Ready = await waitSettled(trip.tripId, t1SourceId);
  assert.equal(fetchCalls.length, 1, "有持久化正文时重试不得重新抓取小红书（零重抓）");
  assert.equal(extractCalls.length, 2, "重试应发起一次正文重抽");
  assert.equal(extractCalls[1], NOTE_TEXT, "重抽应使用持久化正文原文");
  {
    const { trip: t1Trip, source: t1Source } = await sourceWithTrip(trip.tripId, t1SourceId);
    assert.equal(noteEvidences(t1Trip, t1Source).length, 1, "重抽成功应写入 1 份 note_text 证据");
    assert.equal(noteMentionCount(t1Trip, t1Source), 9, "9 个打卡点提及应全部恢复");
    assert.equal(t1Source.mentionRefs.length, 9, "来源 mentionRefs 应包含全部正文提及");
    assert.equal(t1Source.status, "ready", `正文恢复 + 图待解析应 ready（实际 ${t1Source.status}）`);
    assert.equal(t1Source.imageOcrDeferred, true, "补正文不得解除图片延迟解析标记");
    assert.equal(t1Source.coverageText, "正文 + 3张图片待解析", `coverageText 实际 ${t1Source.coverageText}`);
  }
  pass("T1b partial 无失败图也可重试：凭 sourceText 本地重抽，9 条正文提及全部恢复");

  // ============ T2：历史来源无 sourceText → 兜底重新抓取 ============

  stubExtract = new Error("正文抽取超时（task217 桩，T2）");
  await prepareXhsDir("xhs_task217t2", [1]);
  stubNote = {
    success: true,
    title: "历史西岛攻略（T2）",
    text: NOTE_TEXT,
    sourceUrl: "https://www.xiaohongshu.com/explore/task217t2",
    imageSlots: slots("xhs_task217t2", [1]),
  };
  const t2Submit = await submitGuideSource(trip.tripId, {
    inputKind: "link",
    url: "https://www.xiaohongshu.com/explore/task217t2",
  });
  const t2SourceId = t2Submit.sourceId;
  await waitSettled(trip.tripId, t2SourceId);
  // 模拟 Task #217 之前落盘的存量来源：无 sourceText，只有截图证据
  {
    const legacy = await loadTrip(trip.tripId);
    const legacySource = legacy.guideSources?.[t2SourceId];
    assert.ok(legacySource !== undefined);
    delete legacySource.sourceText;
    await tripStore.save(legacy);
  }
  const fetchBeforeT2 = fetchCalls.length;
  stubExtract = SANYA_PLACES.map((name) => mkEntry(name, "attraction", "medium"));
  await retryGuideSource(trip.tripId, t2SourceId);
  const t2Ready = await waitSettled(trip.tripId, t2SourceId);
  assert.equal(fetchCalls.length, fetchBeforeT2 + 1, "无持久化正文的历史来源应兜底重新抓取 1 次");
  {
    const { trip: t2Trip, source: t2Source } = await sourceWithTrip(trip.tripId, t2SourceId);
    assert.equal(noteMentionCount(t2Trip, t2Source), 9, "重抓后 9 个打卡点提及应恢复");
    assert.equal(t2Ready.status, "ready", `重抓 + 重抽成功应 ready（实际 ${t2Ready.status}）`);
    assert.equal(t2Source.sourceText, NOTE_TEXT, "重抓成功后应回填 sourceText（下次免重抓）");
  }
  pass("T2 历史链接来源无 sourceText：兜底重新抓取并恢复 9 条提及，随后回填原文");

  // ============ T3：重抓失败（风控）→ 保持 partial 且既有证据不丢 ============

  // 模拟真实存量来源（src_fc579c8a 同构）：图片全部 OCR 完成（8/8 式）、正文证据
  // 从未创建、无 sourceText、状态 partial——只能靠重抓链接补正文
  stubExtract = new Error("正文抽取超时（task217 桩，T3）");
  await prepareXhsDir("xhs_task217t3", [1, 2]);
  stubNote = {
    success: true,
    title: "存量西岛攻略（T3）",
    text: NOTE_TEXT,
    sourceUrl: "https://www.xiaohongshu.com/explore/task217t3",
    imageSlots: slots("xhs_task217t3", [1, 2]),
  };
  const t3Submit = await submitGuideSource(trip.tripId, {
    inputKind: "link",
    url: "https://www.xiaohongshu.com/explore/task217t3",
  });
  const t3SourceId = t3Submit.sourceId;
  await waitSettled(trip.tripId, t3SourceId);
  stubRecognizeThrowPages = [];
  await triggerImageOcr(trip.tripId, t3SourceId);
  await waitSettled(trip.tripId, t3SourceId);
  {
    const legacy = await loadTrip(trip.tripId);
    const legacySource = legacy.guideSources?.[t3SourceId];
    assert.ok(legacySource !== undefined);
    // 历史落盘形态：图全就绪、状态 partial、无 sourceText（正文缺失）
    delete legacySource.sourceText;
    legacySource.status = "partial";
    legacySource.failureMessage = "正文抽取失败，其余内容已保留，可重试";
    await tripStore.save(legacy);
  }
  {
    const before = await sourceWithTrip(trip.tripId, t3SourceId);
    assert.equal(before.source.imageProgress.failed, 0, "用例前提：无失败图（旧逻辑必被拒）");
    stubFetchFails = true;
    stubExtract = new Error("不应走到抽取（task217 桩）"); // 抓取失败即止
    const fetchBeforeT3 = fetchCalls.length;
    await retryGuideSource(trip.tripId, t3SourceId);
    const t3Settled = await waitSettled(trip.tripId, t3SourceId);
    stubFetchFails = false;
    const { trip: t3Trip, source: t3Source } = await sourceWithTrip(trip.tripId, t3SourceId);
    assert.equal(fetchCalls.length, fetchBeforeT3 + 1, "无 sourceText 时应尝试重新抓取 1 次");
    assert.equal(t3Settled.status, "partial", `抓取失败但有既有证据应保持 partial（实际 ${t3Settled.status}）`);
    assert.equal(t3Source.evidenceRefs.length, before.source.evidenceRefs.length, "重抓失败不得丢证据引用");
    assert.equal(
      t3Source.imageProgress.completed,
      before.source.imageProgress.completed,
      "重抓失败不得重置已完成的图片进度",
    );
    assert.ok(
      typeof t3Source.failureMessage === "string" && t3Source.failureMessage.includes("风控拦截"),
      `failureMessage 应透出本次抓取失败原因（实际 ${String(t3Source.failureMessage)}）`,
    );
    assert.equal(noteEvidences(t3Trip, t3Source).length, 0, "重抓失败时正文证据仍未创建（不伪造）");
  }
  pass("T3 重抓被风控拦截：partial 保留既有证据与图片进度，failureMessage 透出抓取失败原因");

  // ============ T6：同一篇笔记重抓成功 → 已完成图沿用（不重识别） ============

  {
    const before = await sourceWithTrip(trip.tripId, t3SourceId);
    const recognizeBefore = recognizeCalls.length;
    const evidenceBefore = before.source.evidenceRefs.length;
    stubFetchFails = false;
    stubExtract = SANYA_PLACES.map((name) => mkEntry(name, "attraction", "medium"));
    await retryGuideSource(trip.tripId, t3SourceId);
    const t6Settled = await waitSettled(trip.tripId, t3SourceId);
    const { trip: t6Trip, source: t6Source } = await sourceWithTrip(trip.tripId, t3SourceId);
    assert.equal(
      recognizeCalls.length,
      recognizeBefore,
      "重抓沿用已完成图：不得重新识别任何图（否则重复建截图证据、提及翻倍）",
    );
    assert.equal(t6Source.imageProgress.completed, before.source.imageProgress.completed, "已完成图计数应沿用");
    for (const entry of t6Source.imageProgress.images) {
      assert.equal(entry.status, "ready", `P${entry.index} 应沿用 ready（不被打回 pending）`);
      const previous = before.source.imageProgress.images.find((candidate) => candidate.index === entry.index);
      assert.equal(entry.evidenceId, previous?.evidenceId, `P${entry.index} 应沿用原证据 ID（不建新证据）`);
    }
    assert.equal(t6Source.evidenceRefs.length, evidenceBefore + 1, "重抓只新增正文证据，不新增截图证据");
    assert.equal(noteMentionCount(t6Trip, t6Source), 9, "重抓后正文 9 个打卡点提及全部恢复");
    assert.equal(t6Source.sourceText, NOTE_TEXT, "重抓成功后回填 sourceText（下次免重抓）");
    assert.equal(t6Settled.status, "ready", `正文恢复 + 图已完成应 ready（实际 ${t6Settled.status}）`);
    assert.equal(t6Source.coverageText, "正文 + 2/2张图", `coverageText 实际 ${t6Source.coverageText}`);
  }
  pass("T6 同一篇笔记重抓：已完成图零重识别、证据不复建，coverageText 回到「正文 + 2/2张图」");

  // ============ T4：partial 已有 note_text（图失败）→ 只重跑图片 ============

  await prepareXhsDir("xhs_task217t4", [1, 2]);
  stubNote = {
    success: true,
    title: "已有正文、图片失败（T4）",
    text: NOTE_TEXT,
    sourceUrl: "https://www.xiaohongshu.com/explore/task217t4",
    imageSlots: slots("xhs_task217t4", [1, 2]),
  };
  stubExtract = [mkEntry("西岛", "attraction", "medium")];
  const t4Submit = await submitGuideSource(trip.tripId, {
    inputKind: "link",
    url: "https://www.xiaohongshu.com/explore/task217t4",
  });
  const t4SourceId = t4Submit.sourceId;
  await waitSettled(trip.tripId, t4SourceId);
  stubRecognizeThrowPages = [1, 2];
  await triggerImageOcr(trip.tripId, t4SourceId);
  const t4Partial = await waitSettled(trip.tripId, t4SourceId);
  assert.equal(t4Partial.status, "partial", `正文可用 + 图全失败应 partial（实际 ${t4Partial.status}）`);
  assert.equal(t4Partial.imageProgress.failed, 2, "用例前提：2 张图失败");

  const extractBeforeT4 = extractCalls.length;
  const fetchBeforeT4 = fetchCalls.length;
  stubExtract = new Error("若重抽正文即失败（task217 桩）"); // 正文已存在，不该再抽
  stubRecognizeThrowPages = [];
  await retryGuideSource(trip.tripId, t4SourceId);
  const t4Ready = await waitSettled(trip.tripId, t4SourceId);
  assert.equal(extractCalls.length, extractBeforeT4, "正文证据已存在时重试不得重抽正文");
  assert.equal(fetchCalls.length, fetchBeforeT4, "正文证据已存在时重试不得重新抓取");
  {
    const { trip: t4Trip, source: t4Source } = await sourceWithTrip(trip.tripId, t4SourceId);
    assert.equal(noteEvidences(t4Trip, t4Source).length, 1, "重试图片不得新建第二份正文证据");
    assert.equal(t4Ready.status, "ready", `图片重跑成功应 ready（实际 ${t4Ready.status}）`);
  }
  pass("T4 正文已齐备的 partial：重试只跑失败图，零正文重抽、零重抓");

  // ============ T5：正文缺失 + 图片失败并存（西岛实况）→ 先补正文再补图 ============

  await prepareXhsDir("xhs_task217t5", [1, 2, 3]);
  stubNote = {
    success: true,
    title: "西岛实况：正文抽失败 + 部分图失败（T5）",
    text: NOTE_TEXT,
    sourceUrl: "https://www.xiaohongshu.com/explore/task217t5",
    imageSlots: slots("xhs_task217t5", [1, 2, 3]),
  };
  stubExtract = new Error("正文抽取超时（task217 桩，T5）");
  const t5Submit = await submitGuideSource(trip.tripId, {
    inputKind: "link",
    url: "https://www.xiaohongshu.com/explore/task217t5",
  });
  const t5SourceId = t5Submit.sourceId;
  await waitSettled(trip.tripId, t5SourceId);
  // 图片解析：P1 成功（截图证据可用）、P2/P3 失败 → 与西岛实况同构的 partial
  stubRecognizeThrowPages = [2, 3];
  await triggerImageOcr(trip.tripId, t5SourceId);
  const t5Partial = await waitSettled(trip.tripId, t5SourceId);
  assert.equal(t5Partial.status, "partial", `有可用截图证据 + 图失败应 partial（实际 ${t5Partial.status}）`);
  assert.equal(t5Partial.imageProgress.failed, 2, "用例前提：2 张图失败");
  {
    const { trip: t5Trip, source: t5Source } = await sourceWithTrip(trip.tripId, t5SourceId);
    assert.equal(noteEvidences(t5Trip, t5Source).length, 0, "用例前提：正文证据缺失（仅截图提及）");
    assert.equal(noteMentionCount(t5Trip, t5Source), 0, "用例前提：无正文提及");
  }

  // 第一次重试：优先补正文（图片仍失败 → 仍 partial）
  const fetchBeforeT5 = fetchCalls.length;
  stubExtract = SANYA_PLACES.map((name) => mkEntry(name, "attraction", "medium"));
  stubRecognizeThrowPages = []; // 图片本轮尚未重跑
  await retryGuideSource(trip.tripId, t5SourceId);
  const t5AfterNote = await waitSettled(trip.tripId, t5SourceId);
  assert.equal(fetchCalls.length, fetchBeforeT5, "补正文应走持久化原文，不重新抓取");
  {
    const { trip: t5Trip, source: t5Source } = await sourceWithTrip(trip.tripId, t5SourceId);
    assert.equal(noteMentionCount(t5Trip, t5Source), 9, "第一次重试应恢复 9 条正文提及");
    assert.equal(t5AfterNote.status, "partial", `图片仍失败应保持 partial（实际 ${t5AfterNote.status}）`);
    assert.equal(t5Source.imageProgress.failed, 2, "第一次重试不应提前改动失败图状态");
  }
  pass("T5a 正文缺失 + 图失败：第一次重试优先补正文（9 条提及恢复），图仍未跑");

  // 第二次重试：正文已齐备 → 只重跑失败图
  const extractBeforeT5b = extractCalls.length;
  stubExtract = new Error("若重抽正文即失败（task217 桩）");
  await retryGuideSource(trip.tripId, t5SourceId);
  const t5Ready = await waitSettled(trip.tripId, t5SourceId);
  assert.equal(extractCalls.length, extractBeforeT5b, "第二次重试不得重抽正文");
  {
    const { trip: t5Trip, source: t5Source } = await sourceWithTrip(trip.tripId, t5SourceId);
    assert.equal(noteEvidences(t5Trip, t5Source).length, 1, "正文证据始终只有 1 份（不重复建）");
    assert.equal(noteMentionCount(t5Trip, t5Source), 9, "正文提及保持 9 条");
    assert.equal(t5Ready.status, "ready", `图补完应 ready（实际 ${t5Ready.status}）`);
    assert.equal(t5Ready.imageProgress.failed, 0, "失败图应全部补齐");
  }
  pass("T5b 第二次重试补失败图 → ready；正文证据不重复");

  console.log("\nTask #217 全部验证通过 ✅");
}

main()
  .catch((error) => {
    console.error("✗ Task #217 验证失败：", error);
    process.exitCode = 1;
  })
  .finally(() => cleanup());
