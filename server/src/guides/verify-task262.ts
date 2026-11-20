/**
 * 任务 262 确定性验证（离线：抽取桩注入，不触网、不调用付费百炼）。
 *
 * 背景：用户连续粘贴多篇文字攻略时，来源都没有标题，前端统一兜底显示
 * 「粘贴的攻略文字」，列表里无法区分。改为新建文字来源时用正文开头若干字派生标题。
 *
 * 覆盖矩阵：
 *   段 A  纯函数：长正文 → 前 20 字 + …；短正文 → 完整正文；首尾空白 / 换行 → 单行；
 *         空白正文 → 「粘贴的文字」；码点安全（emoji 不被截半）；
 *   段 B  集成：提交 text 来源未显式给 title → 标题 = 派生标题（内存与落盘一致），
 *         两篇不同正文得到不同标题（核心诉求）；
 *   段 C  显式 title 优先：调用方传 title 时不被正文覆盖；
 *   段 D  存量不改：历史文字来源（无 title）重复命中不回写标题。
 *
 * 运行：npx tsx server/src/guides/verify-task262.ts
 * 不触网、不留数据（临时行程在 finally 清理）。
 */

import assert from "node:assert/strict";
import {
  deriveTextSourceTitle,
  GUIDE_SOURCE_TEXT_TITLE_CHARS,
  GUIDE_SOURCE_TEXT_TITLE_FALLBACK,
  type GuideSource,
  type Trip,
} from "@goplay/shared";
import type { ParsedEntry } from "../ai/assemble.js";
import type { OcrScreenshotInput, RecognizedImageContent } from "../ai/ocr.js";
import type { PrefilterImageInput, PrefilterSkipDecision } from "../ai/prefilter.js";
import type { XhsNoteResult } from "../ai/xhs.js";
import { tripStore } from "../persistence/store.js";
import {
  getGuideSource,
  resetGuideServiceDeps,
  setGuideServiceDeps,
  submitGuideSource,
} from "./service.js";

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

/** 轮询来源直到离开 processing（后台抽取桩立即返回，通常一轮即结算） */
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

function mkEntry(name: string): ParsedEntry {
  return {
    name,
    type: "attraction",
    parentAttraction: null,
    scale: null,
    confidence: "high",
    suggestMinutes: 40,
    locationHint: null,
    quote: `原文提及${name}`,
    summary: "验证条目",
    ticketRelation: "unknown",
    suggestedVisitName: null,
    bbox: null,
  };
}

// ===== service 桩（仅需正文抽取可用；链接 / 图片链路不参与本验证） =====

const stubFetchNote = async (_url: string): Promise<XhsNoteResult> => ({ success: true });
const stubExtractEntries = async (_text: string): Promise<ParsedEntry[]> => [mkEntry("亚龙湾")];
const stubRecognizeImage = async (
  _image: OcrScreenshotInput,
  _options?: { editedText?: string },
): Promise<RecognizedImageContent> => ({ ocrText: "task262 桩识别文本", mentions: [] });
const stubPrefilterBatch = async (
  items: readonly PrefilterImageInput[],
): Promise<Map<number, PrefilterSkipDecision>> => {
  void items;
  return new Map<number, PrefilterSkipDecision>();
};

const createdTripIds: string[] = [];

async function cleanup(): Promise<void> {
  resetGuideServiceDeps();
  for (const tripId of createdTripIds) {
    await tripStore.deleteTrip(tripId).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  // ============ 段 A：纯函数口径 ============

  const LONG_A = "第一天下机直奔亚龙湾，第二天早起去蜈支洲岛，记得提前订船票，下午去观日岩看海。";
  const longTitleA = deriveTextSourceTitle(LONG_A);
  assert.equal(
    longTitleA,
    `${Array.from(LONG_A).slice(0, GUIDE_SOURCE_TEXT_TITLE_CHARS).join("")}…`,
    "长正文应取前 20 字并加省略号",
  );
  assert.equal(Array.from(longTitleA).length, GUIDE_SOURCE_TEXT_TITLE_CHARS + 1, "标题长度 = 20 字 + 省略号");
  pass("A1 长正文：前 20 字 + …");

  const SHORT_A = "后海村冲浪小店清单";
  assert.equal(deriveTextSourceTitle(SHORT_A), SHORT_A, "短正文应原样作为标题（不加省略号）");
  pass("A2 短正文：标题为完整正文");

  assert.equal(
    deriveTextSourceTitle("\n  三亚亲子五日游\n\n带娃必看  \n"),
    "三亚亲子五日游 带娃必看",
    "首尾空白 / 换行应去掉，内部换行压成单空格",
  );
  pass("A3 首尾空白与换行：标题单行");

  assert.equal(deriveTextSourceTitle("   \n\t  "), GUIDE_SOURCE_TEXT_TITLE_FALLBACK, "空白正文应兜底");
  assert.equal(GUIDE_SOURCE_TEXT_TITLE_FALLBACK, "粘贴的文字", "兜底文案为「粘贴的文字」");
  pass("A4 空白正文：兜底「粘贴的文字」");

  assert.equal(deriveTextSourceTitle("🌴".repeat(30), 3), "🌴🌴🌴…", "emoji 不应被截成半个");
  pass("A5 码点安全：emoji 不被截半");

  // ============ 段 B：新建文字来源写入派生标题 ============

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

  const submitLong = await submitGuideSource(trip.tripId, { inputKind: "text", text: LONG_A });
  assert.equal(submitLong.source?.title, longTitleA, "创建响应的来源标题应为派生标题");
  const reloadedLong = await loadTrip(trip.tripId);
  assert.equal(
    reloadedLong.guideSources?.[submitLong.sourceId]?.title,
    longTitleA,
    "派生标题应随 Trip 落盘",
  );
  await waitSettled(trip.tripId, submitLong.sourceId);
  pass("B1 text 来源创建即写入派生标题（落盘可读）");

  const LONG_B = "Day1 亚龙湾泡海，Day2 蜈支洲岛浮潜，Day3 海棠湾免税店买买买，晚上回市区吃椰子鸡。";
  const submitSecond = await submitGuideSource(trip.tripId, { inputKind: "text", text: LONG_B });
  assert.notEqual(
    submitSecond.source?.title,
    submitLong.source?.title,
    "两篇不同正文应得到不同标题（不再统一为同一句兜底文案）",
  );
  assert.equal(submitSecond.source?.title, deriveTextSourceTitle(LONG_B), "第二篇标题同样是派生标题");
  await waitSettled(trip.tripId, submitSecond.sourceId);
  pass("B2 两篇粘贴文字标题可区分");

  const SHORT_B = "小众：后海村冲浪小店";
  const submitShort = await submitGuideSource(trip.tripId, { inputKind: "text", text: SHORT_B });
  assert.equal(submitShort.source?.title, SHORT_B, "短正文编号来源标题为完整正文");
  await waitSettled(trip.tripId, submitShort.sourceId);
  pass("B3 短正文来源标题为完整正文");

  // ============ 段 C：显式 title 优先 ============

  const submitExplicit = await submitGuideSource(trip.tripId, {
    inputKind: "text",
    text: "显式标题用例正文：西岛一日游，情人桥、观日岩、牛王岭。",
    title: "  西岛一日游  ",
  });
  assert.equal(submitExplicit.source?.title, "西岛一日游", "显式 title 去空白后优先，不被正文派生覆盖");
  await waitSettled(trip.tripId, submitExplicit.sourceId);
  pass("C1 显式 title 优先于派生标题");

  // ============ 段 D：存量来源标题不回写 ============

  const reloadedForLegacy = await loadTrip(trip.tripId);
  const legacySource = reloadedForLegacy.guideSources?.[submitShort.sourceId];
  assert.ok(legacySource !== undefined, "用例前提：短正文来源存在");
  delete legacySource.title; // 模拟本次改动之前创建的存量来源（无 title）
  await tripStore.save(reloadedForLegacy);

  const legacy = await loadTrip(trip.tripId);
  assert.equal(legacy.guideSources?.[submitShort.sourceId]?.title, undefined, "存量来源应无 title");

  const dup = await submitGuideSource(trip.tripId, { inputKind: "text", text: SHORT_B });
  assert.equal(dup.duplicate, true, "同正文重复提交应命中已有来源");
  assert.equal(
    dup.source?.title,
    undefined,
    "重复命中不回写标题：存量来源标题保持原样（不擅自补写）",
  );
  pass("D1 存量文字来源（无 title）重复命中不回写标题");

  console.log("\n任务 262 验证全部通过（8 项）");
}

main()
  .catch((error: unknown) => {
    console.error("任务 262 验证失败：", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
  });
