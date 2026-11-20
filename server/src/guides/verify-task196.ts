/**
 * Task #196（自定义打卡点过滤 + 正文页码配图）验证——全程离线：
 *
 * 离线手段：
 * - setGuideServiceDeps 桩注入（fetchNote / extractEntries / recognizeImage / prefilterBatch）；
 * - 临时删除 process.env.FLYAI_API_KEY：flyai client 前置凭据校验（Task #62）立即抛
 *   FLYAI_NOT_CONFIGURED，alignWithFliggyCached 捕获后降级 custom（errors 记录
 *   「搜索暂不可用」）——不触网即可驱动「未命中飞猪 → 将新建 custom」路径，
 *   打卡点过滤正是在该路径生效；脚本 finally 恢复环境变量；
 * - 页码绑定解析用内存 fixture Trip 直接驱动 shared 纯函数（不落盘、不触网）。
 *
 * 覆盖：
 * 1. 常量防漂移：GUIDE_PAGE_MAX_INDEX === GUIDE_MAX_IMAGES（24）；
 * 2. prompt 契约：抽取规则含「严禁编造专名 + 打卡点范围」与页码原样保留要求；
 * 3. extractPageRefs 单元矩阵（pN / PN / P N / 多页 / 连写 / 英文排除 / 越界 / 去重）；
 * 4. shouldRejectCustomCheckpoint 矩阵（泛化拒 / 编造拒 / 明确装置保留 / 专名保留）；
 * 5. 绑定解析纯函数：golden p6、多页缺槽不前移、全 ready 多图、顺序不可靠全拒、
 *    越界、跨来源防护、无页码、历史 mention 缺 pageRefs 零迁移；
 * 6. pushMention：正文类提取页码、截图 OCR 类不提取；
 * 7. HTTP 端到端（text 来源）：golden 三样（西岛墙 p6 / 木门歪椰树 p2 p8 p9 /
 *    珊瑚墙 p11 p12 p13）pageRefs 落盘；泛化与编造条目零残留；明确装置保留；
 *    复用既有 Item 豁免过滤；父景区自动补建不受过滤影响。
 *
 * 运行：npx tsx server/src/guides/verify-task196.ts（无需 FLYAI_API_KEY，无 live 段）
 * 临时行程（server/data）在脚本末尾全部清理。
 */

import "../env.js";
import assert from "node:assert/strict";
import type {
  GuideImageProgressEntry,
  GuideImageStatus,
  GuideSource,
  SourceEvidence,
  Trip,
} from "@goplay/shared";
import {
  extractPageRefs,
  GUIDE_PAGE_MAX_INDEX,
  normalizeMentionPageRefs,
  resolveMentionPageImages,
  resolvePageAssetPath,
} from "@goplay/shared";
import { pushMention, type ParsedEntry } from "../ai/assemble.js";
import { shouldRejectCustomCheckpoint } from "../ai/checkpointFilter.js";
import { buildExtractPrompt, buildOcrPrompt } from "../ai/prompt.js";
import { GUIDE_MAX_IMAGES } from "./jobs.js";
import { createFixtureSanyaTrip, tripStore } from "../persistence/store.js";
import { guideRoutes } from "./routes.js";
import { resetGuideServiceDeps, setGuideServiceDeps } from "./service.js";

// ===== 基础辅助 =====

function pass(name: string): void {
  console.log(`✓ ${name}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(
  routePath: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await guideRoutes.request(routePath, init);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function loadTrip(tripId: string): Promise<Trip> {
  const trip = await tripStore.load(tripId);
  assert.ok(trip !== null, `行程 ${tripId} 应存在`);
  return trip;
}

function sourceOf(trip: Trip, sourceId: string): GuideSource {
  const source = trip.guideSources?.[sourceId];
  assert.ok(source !== undefined, `来源 ${sourceId} 应存在`);
  return source;
}

async function getSource(tripId: string, sourceId: string): Promise<GuideSource> {
  const res = await requestJson(`/trips/${tripId}/sources/${sourceId}`, "GET");
  assert.equal(res.status, 200, `获取来源应 200`);
  return res.body.source as GuideSource;
}

async function waitSettled(tripId: string, sourceId: string, timeoutMs = 15_000): Promise<GuideSource> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const source = await getSource(tripId, sourceId);
    if (source.status !== "processing") return source;
    if (Date.now() > deadline) throw new Error(`来源 ${sourceId} 未在 ${timeoutMs}ms 内结算`);
    await sleep(50);
  }
}

// ===== 桩注入（全程离线驱动） =====

const stubEntries: ParsedEntry[] = [];

const stubExtractEntries = async (): Promise<ParsedEntry[]> => stubEntries.map((entry) => ({ ...entry }));

setGuideServiceDeps({
  fetchNote: async () => {
    throw new Error("verify-task196 不覆盖链接抓取路径");
  },
  extractEntries: stubExtractEntries,
  recognizeImage: async () => {
    throw new Error("verify-task196 不覆盖图片识别路径");
  },
  prefilterBatch: async () => new Map(),
});

/** 测试条目（与 verify-b2 的 mkEntry 同构 + quote 可指定页码原文） */
function mkEntry(
  name: string,
  type: ParsedEntry["type"],
  confidence: ParsedEntry["confidence"],
  quote: string,
  parent: string | null = null,
): ParsedEntry {
  return {
    name,
    type,
    parentAttraction: parent,
    scale: null,
    confidence,
    suggestMinutes: 30,
    locationHint: null,
    quote,
    summary: "验证条目",
    ticketRelation: "unknown",
    suggestedVisitName: null,
    bbox: null,
  };
}

// ===== 纯函数层 fixture：页码绑定解析（内存对象，不落盘） =====

function slot(
  index: number,
  status: GuideImageStatus,
  evidenceId: string | null,
  assetPath: string | null,
): GuideImageProgressEntry {
  const entry: GuideImageProgressEntry = { index, status, evidenceId };
  if (assetPath !== null) entry.assetPath = assetPath;
  return entry;
}

function makeEvidence(evidenceId: string, kind: SourceEvidence["kind"], mentions: SourceEvidence["mentions"]): SourceEvidence {
  return {
    evidenceId,
    kind,
    noteIndex: kind === "note_text" ? 1 : null,
    assetRef: null,
    sourceUrl: null,
    ocrText: kind === "screenshot" ? "截图识别文本" : null,
    mentions,
    ...(kind === "screenshot" ? { assetPath: `uploads/trip_t196/${evidenceId}.jpg` } : {}),
  };
}

function makeSource(
  sourceId: string,
  evidenceRefs: string[],
  images: GuideImageProgressEntry[],
): GuideSource {
  const ready = images.filter((entry) => entry.status === "ready").length;
  return {
    sourceId,
    sourceVersion: 1,
    inputKind: "link",
    active: true,
    status: images.length === 0 || images.every((entry) => entry.status !== "failed") ? "ready" : "partial",
    evidenceRefs,
    mentionRefs: [],
    imageProgress: { total: images.length, completed: ready, failed: 0, images },
    importedAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
  };
}

/**
 * 页码绑定解析夹具：
 * - src_a（13 槽，覆盖 p1..p13）：p2/p3/p6/p11/p12/p13 ready 且带明细 assetPath；
 *   p8 failed（download_failed 占位）、p9 skipped（预筛跳过）、p7 ready 但明细
 *   assetPath 缺失（回退证据字段）；p10 ready 但 evidenceId 指向 src_b 的证据（跨来源）；
 * - src_b（8 槽全 ready）：p5 = other-05.jpg。
 */
function makePageFixtureTrip(): Trip {
  const img = (page: number): string => `uploads/trip_t196/img-${String(page).padStart(2, "0")}.jpg`;
  const evidences: Record<string, SourceEvidence> = {
    ev_note: makeEvidence("ev_note", "note_text", [
      {
        mentionId: "m_xdw",
        text: "西岛墙",
        quoteText: "上岛第一站去西岛墙 p6 拍照",
        bbox: null,
        extractedName: "西岛墙",
        locationHint: null,
        modelSummary: null,
        pageRefs: [6],
      },
      {
        mentionId: "m_men",
        text: "木门歪椰树",
        quoteText: "进门是木门，旁边歪椰树 p2 p8 p9",
        bbox: null,
        extractedName: "木门歪椰树",
        locationHint: null,
        modelSummary: null,
        pageRefs: [2, 8, 9],
      },
      {
        mentionId: "m_shh",
        text: "珊瑚墙",
        quoteText: "珊瑚墙 p11 p12 p13 超好拍",
        bbox: null,
        extractedName: "珊瑚墙",
        locationHint: null,
        modelSummary: null,
        pageRefs: [11, 12, 13],
      },
      {
        mentionId: "m_dt",
        text: "灯塔",
        quoteText: "岛尾有座灯塔 p3",
        bbox: null,
        extractedName: "灯塔",
        locationHint: null,
        modelSummary: null,
        pageRefs: [3],
      },
      // 历史 mention（Task #196 之前落盘）：无 pageRefs 字段——零迁移语义
      {
        mentionId: "m_legacy",
        text: "情人桥",
        quoteText: "上岛先走情人桥",
        bbox: null,
        extractedName: "情人桥",
        locationHint: null,
        modelSummary: null,
      },
      // 越界页码（手工构造异常数据）：归一层应滤除
      {
        mentionId: "m_over",
        text: "观日岩",
        quoteText: "观日岩 p25",
        bbox: null,
        extractedName: "观日岩",
        locationHint: null,
        modelSummary: null,
        pageRefs: [25, 0, -1],
      },
      // 无页码
      {
        mentionId: "m_none",
        text: "海滨浴场",
        quoteText: "中午在海滨浴场玩水",
        bbox: null,
        extractedName: "海滨浴场",
        locationHint: null,
        modelSummary: null,
        pageRefs: [],
      },
    ]),
    ev_img2: makeEvidence("ev_img2", "screenshot", []),
    ev_img3: makeEvidence("ev_img3", "screenshot", []),
    ev_img6: makeEvidence("ev_img6", "screenshot", []),
    ev_img7: makeEvidence("ev_img7", "screenshot", []),
    ev_img11: makeEvidence("ev_img11", "screenshot", []),
    ev_img12: makeEvidence("ev_img12", "screenshot", []),
    ev_img13: makeEvidence("ev_img13", "screenshot", []),
    // 属于 src_b 的证据（跨来源防护目标）
    ev_cross: makeEvidence("ev_cross", "screenshot", []),
    ev_other5: makeEvidence("ev_other5", "screenshot", []),
  };

  const srcAImages: GuideImageProgressEntry[] = [];
  const readyPages = new Map<number, string>([
    [2, "ev_img2"],
    [3, "ev_img3"],
    [6, "ev_img6"],
    [7, "ev_img7"],
    [11, "ev_img11"],
    [12, "ev_img12"],
    [13, "ev_img13"],
  ]);
  for (let page = 1; page <= 13; page += 1) {
    const evidenceId = readyPages.get(page) ?? null;
    if (page === 8) {
      srcAImages.push(slot(page, "failed", null, null)); // download_failed 占位
    } else if (page === 9) {
      srcAImages.push(slot(page, "skipped", null, null)); // 预筛跳过占位
    } else if (page === 10) {
      srcAImages.push(slot(page, "ready", "ev_cross", img(10))); // evidenceId 跨来源
    } else {
      srcAImages.push(slot(page, evidenceId !== null ? "ready" : "pending", evidenceId, evidenceId !== null ? img(page) : null));
    }
  }
  // p7 明细不带 assetPath（验证回退证据字段）：改写为仅 evidenceId
  srcAImages[6] = slot(7, "ready", "ev_img7", null);

  const srcBImages: GuideImageProgressEntry[] = [];
  for (let page = 1; page <= 8; page += 1) {
    const evidenceId = page === 5 ? "ev_other5" : null;
    srcBImages.push(slot(page, evidenceId !== null ? "ready" : "pending", evidenceId, evidenceId !== null ? `uploads/trip_t196/other-${String(page).padStart(2, "0")}.jpg` : null));
  }

  const sources: Record<string, GuideSource> = {
    // 注意：ev_cross 故意不入 src_a.evidenceRefs（跨来源防护目标：槽位 evidenceId
    // 指向不属于本来源的证据时应拒绝绑定）
    src_a: makeSource(
      "src_a",
      ["ev_note", "ev_img2", "ev_img3", "ev_img6", "ev_img7", "ev_img11", "ev_img12", "ev_img13"],
      srcAImages,
    ),
    src_b: makeSource("src_b", ["ev_other5"], srcBImages),
  };

  return {
    tripId: "trip_t196",
    evidences,
    guideSources: sources,
  } as unknown as Trip;
}

// ===== main =====

let createdTripIds: string[] = [];

async function main(): Promise<void> {
  const savedFlyaiKey = process.env.FLYAI_API_KEY;
  delete process.env.FLYAI_API_KEY; // 前置凭据校验（Task #62）→ 搜索立即失败 → 离线降级 custom
  try {
    verifyConstantsAndPrompt();
    verifyExtractPageRefs();
    verifyCheckpointFilter();
    verifyPageBindingPureFunctions();
    verifyPushMentionKinds();
    await runHttpScenarios();
    console.log("\n[verify] Task #196 全部通过 ✓（全程离线：桩注入 + FLYAI 凭据摘除 + 内存夹具）");
  } finally {
    if (typeof savedFlyaiKey === "string") process.env.FLYAI_API_KEY = savedFlyaiKey;
    resetGuideServiceDeps();
    let removed = 0;
    for (const tripId of createdTripIds) {
      try {
        await tripStore.deleteTrip(tripId);
        removed += 1;
      } catch (error) {
        console.warn(`[verify] 清理临时行程 ${tripId} 失败:`, error);
      }
    }
    console.log(`[verify] 已清理 ${removed}/${createdTripIds.length} 个临时行程`);
  }
}

// ===== 1+2：常量与 prompt 契约 =====

function verifyConstantsAndPrompt(): void {
  assert.equal(GUIDE_PAGE_MAX_INDEX, GUIDE_MAX_IMAGES, "页码上限应与来源图片上限同值（防漂移）");
  assert.equal(GUIDE_PAGE_MAX_INDEX, 24);

  const extractPrompt = buildExtractPrompt("正文样例");
  assert.ok(extractPrompt.includes("严禁为泛化描述编造"), "抽取规则应明确禁止编造专名");
  assert.ok(extractPrompt.includes("随手拍处"), "抽取规则应列明泛化场景过滤对象");
  assert.ok(extractPrompt.includes("p2 p8 p9"), "抽取规则应说明页码原样保留");
  const ocrPrompt = buildOcrPrompt();
  assert.ok(ocrPrompt.includes("打卡点"), "OCR 规则应包含打卡点提取范围");
  pass("常量与 prompt 契约：GUIDE_PAGE_MAX_INDEX=24=GUIDE_MAX_IMAGES；抽取/OCR 规则含打卡点与页码要求");
}

// ===== 3：extractPageRefs 单元矩阵 =====

function verifyExtractPageRefs(): void {
  assert.deepEqual(extractPageRefs("上岛第一站去西岛墙 p6 拍照"), [6]);
  assert.deepEqual(extractPageRefs("P6 是机位"), [6], "大写 P 应可解析");
  assert.deepEqual(extractPageRefs("p 6 空一格"), [6], "P N 形式应可解析");
  assert.deepEqual(extractPageRefs("木门歪椰树 p2 p8 p9"), [2, 8, 9], "多页码保序");
  assert.deepEqual(extractPageRefs("连写p6p7两张"), [6, 7], "连写页码应全部解析");
  assert.deepEqual(extractPageRefs("第p12、p13张"), [12, 13], "标点分隔应可解析");
  assert.deepEqual(extractPageRefs("iPhone6 很好用"), [], "紧邻英文字母不得误匹配");
  assert.deepEqual(extractPageRefs("op6 与 map 6 都不是页码"), [], "英文单词尾 p 不得误匹配");
  assert.deepEqual(extractPageRefs("p0 与 p01"), [1], "0 舍弃、前导零归一");
  assert.deepEqual(extractPageRefs("p25 越界"), [], "超出 24 上限按非页码处理");
  assert.deepEqual(extractPageRefs("p6 p6 重复"), [6], "重复页码去重保序");
  assert.deepEqual(extractPageRefs(""), []);
  assert.deepEqual(extractPageRefs("没有页码的句子"), []);
  pass("extractPageRefs 矩阵：pN/PN/P N/多页/连写/英文排除/越界滤除/去重保序");
}

// ===== 4：打卡点过滤矩阵 =====

function verifyCheckpointFilter(): void {
  // 产品明示过滤对象：泛化场景 / 纯方位参照
  const rejectedGeneric: Array<[string, string]> = [
    ["普通沙滩", "普通沙滩踩踩水"],
    ["小吃街", "晚上逛小吃街"],
    ["路过椰林", "路过椰林拍了两张"],
    ["海边公路", "骑车经过海边公路"],
    ["随手拍处", "有个随手拍处"],
    ["入口旁", "入口旁有块石头"],
    ["码头左侧", "码头左侧下去就是"],
    ["网红沙滩", "网红沙滩人很多"],
    ["日落", "在屋顶看日落"],
    ["转角处", "转角处有家店"],
  ];
  for (const [name, quote] of rejectedGeneric) {
    assert.equal(shouldRejectCustomCheckpoint({ name, quote }), true, `「${name}」应被过滤`);
  }
  // 编造拒绝：quote 无对应字样
  const rejectedFabricated: Array<[string, string]> = [
    ["粉红沙滩", "沙滩很美"],
    ["神秘灯塔", "风很大"],
    ["海上秋千", "拍了好多照片"],
  ];
  for (const [name, quote] of rejectedFabricated) {
    assert.equal(shouldRejectCustomCheckpoint({ name, quote }), true, `「${name}」（原文无对应字样）应按编造过滤`);
  }
  // 明确装置 / 专名保留
  const kept: Array<[string, string]> = [
    ["西岛墙", "上岛第一站去西岛墙 p6 拍照"],
    ["珊瑚墙", "珊瑚墙 p11 p12 p13 超好拍"],
    ["木门歪椰树", "进门是木门，旁边歪椰树 p2 p8 p9"],
    ["灯塔", "岛尾有座灯塔 p3"],
    ["第一市场", "晚上去第一市场吃海鲜"],
    ["六角亭", "山顶有个六角亭"],
    ["白墙", "巷子里全是白墙"],
  ];
  for (const [name, quote] of kept) {
    assert.equal(shouldRejectCustomCheckpoint({ name, quote }), false, `「${name}」应保留`);
  }
  pass("shouldRejectCustomCheckpoint 矩阵：泛化拒 / 编造拒 / 装置与专名保留");
}

// ===== 5：页码绑定解析纯函数 =====

function verifyPageBindingPureFunctions(): void {
  const trip = makePageFixtureTrip();
  const srcA = (trip as unknown as { guideSources: Record<string, GuideSource> }).guideSources.src_a;

  // 归一层：越界 / 非法值滤除
  assert.deepEqual(normalizeMentionPageRefs([25, 0, -1, 1.5, "6", 6]), [6], "仅 1..24 整数保留（字符串数字按值收）");

  // golden 1：西岛墙 p6 → 第 6 张
  const xdw = resolveMentionPageImages(trip, "ev_note:m_xdw");
  assert.deepEqual(xdw.pageRefs, [6]);
  assert.deepEqual(xdw.assetPaths, ["uploads/trip_t196/img-06.jpg"]);
  assert.equal(xdw.firstAssetPath, "uploads/trip_t196/img-06.jpg");

  // golden 2：木门歪椰树 p2 p8 p9 → p8 failed、p9 skipped 占位不前移，仅 p2 绑定
  const men = resolveMentionPageImages(trip, "ev_note:m_men");
  assert.deepEqual(men.pageRefs, [2, 8, 9], "pageRefs 如实保留全部明确页码");
  assert.deepEqual(men.assetPaths, ["uploads/trip_t196/img-02.jpg"], "失败/跳过槽不绑定且不得前移");
  assert.equal(men.firstAssetPath, "uploads/trip_t196/img-02.jpg");

  // golden 3：珊瑚墙 p11 p12 p13 → 全部有效关联图保序保留
  const shh = resolveMentionPageImages(trip, "ev_note:m_shh");
  assert.deepEqual(shh.assetPaths, [
    "uploads/trip_t196/img-11.jpg",
    "uploads/trip_t196/img-12.jpg",
    "uploads/trip_t196/img-13.jpg",
  ]);
  assert.equal(shh.firstAssetPath, "uploads/trip_t196/img-11.jpg", "首张有效关联图供卡片展示");

  // 明细 assetPath 缺失回退证据字段（历史来源兼容）
  assert.deepEqual(resolvePageAssetPath(trip, srcA, 7), "uploads/trip_t196/ev_img7.jpg");

  // 跨来源防护：槽位 evidenceId 不属于本来源 → 拒绝
  assert.equal(resolvePageAssetPath(trip, srcA, 10), null, "evidenceId 指向其他来源的证据不得绑定");

  // 越界：归一层已滤除 → 无绑定
  const over = resolveMentionPageImages(trip, "ev_note:m_over");
  assert.deepEqual(over.pageRefs, []);
  assert.deepEqual(over.assetPaths, []);

  // 无页码（空数组）与历史 mention（字段缺失）零迁移
  const none = resolveMentionPageImages(trip, "ev_note:m_none");
  assert.deepEqual(none.pageRefs, []);
  assert.deepEqual(none.assetPaths, []);
  const legacy = resolveMentionPageImages(trip, "ev_note:m_legacy");
  assert.deepEqual(legacy.pageRefs, [], "历史 mention 缺 pageRefs 按无页码处理");
  assert.deepEqual(legacy.assetPaths, []);

  // 顺序不可靠：明细长度 ≠ total（缺槽压缩）→ 该来源全部不绑定（页码语义已不可信）
  const broken = structuredClone(srcA) as GuideSource;
  broken.imageProgress = {
    total: 13,
    completed: 7,
    failed: 1,
    images: broken.imageProgress.images.filter((entry) => entry.index !== 4),
  };
  assert.equal(resolvePageAssetPath(trip, broken, 6), null, "顺序不可靠的来源不绑定任何页码图");

  // 引用失效 / 不存在
  assert.deepEqual(resolveMentionPageImages(trip, "ev_note:m_ghost").assetPaths, []);
  assert.deepEqual(resolveMentionPageImages(trip, "not-a-ref").assetPaths, []);

  // 证据不属于任何来源（历史装配产物）→ 有页码也无绑定
  const orphanTrip = makePageFixtureTrip();
  (orphanTrip as unknown as { guideSources: Record<string, GuideSource> }).guideSources = {};
  const orphan = resolveMentionPageImages(orphanTrip, "ev_note:m_xdw");
  assert.deepEqual(orphan.pageRefs, [6], "页码如实保留");
  assert.deepEqual(orphan.assetPaths, [], "无所属来源时不绑定");

  pass("页码绑定解析：golden p6 / 多页缺槽不前移 / 多图保序 / 顺序不可靠全拒 / 越界 / 跨来源 / 历史零迁移");
}

// ===== 6：pushMention 的证据类型差异 =====

function verifyPushMentionKinds(): void {
  const entry: ParsedEntry = mkEntry("灯塔", "attraction", "medium", "岛尾有座灯塔 p6");
  const noteEvidence = makeEvidence("ev_note_x", "note_text", []);
  pushMention(noteEvidence, entry);
  assert.deepEqual(noteEvidence.mentions[0].pageRefs, [6], "正文类证据应提取页码");

  const shotEvidence = makeEvidence("ev_shot_x", "screenshot", []);
  pushMention(shotEvidence, entry);
  assert.deepEqual(shotEvidence.mentions[0].pageRefs, [], "截图 OCR 原句的 p6 字样与图片队列页码无关，不提取");
  pass("pushMention：正文类提取页码 / 截图 OCR 类不提取");
}

// ===== 7：HTTP 端到端（text 来源） =====

async function runHttpScenarios(): Promise<void> {
  // --- 场景 A：golden 三样 + 泛化/编造过滤 + 复用豁免 ---
  const tripA = await createFixtureSanyaTrip();
  createdTripIds.push(tripA.tripId);
  {
    stubEntries.length = 0;
    stubEntries.push(
      mkEntry("蜈支洲岛", "attraction", "medium", "原文提及蜈支洲岛"),
      mkEntry("西岛墙", "in_attraction", "high", "上岛第一站去西岛墙 p6 拍照", "蜈支洲岛"),
      mkEntry("木门歪椰树", "in_attraction", "high", "进门是木门，旁边歪椰树 p2 p8 p9", "蜈支洲岛"),
      mkEntry("珊瑚墙", "in_attraction", "high", "珊瑚墙 p11 p12 p13 超好拍", "蜈支洲岛"),
      mkEntry("灯塔", "in_attraction", "high", "岛尾有座灯塔 p3", "蜈支洲岛"),
      mkEntry("海滨浴场", "in_attraction", "medium", "中午在海滨浴场玩水", "蜈支洲岛"),
      mkEntry("第一市场", "attraction", "medium", "晚上去市场里吃海鲜"),
      mkEntry("普通沙滩", "attraction", "low", "普通沙滩踩踩水"),
      mkEntry("小吃街", "attraction", "low", "晚上逛小吃街"),
      mkEntry("路过椰林", "attraction", "low", "路过椰林拍了两张"),
      mkEntry("海边公路", "attraction", "low", "骑车经过海边公路"),
      mkEntry("随手拍处", "attraction", "low", "有个随手拍处"),
      mkEntry("入口旁", "attraction", "low", "入口旁有块石头"),
      mkEntry("码头左侧", "attraction", "low", "码头左侧下去就是"),
      mkEntry("粉红沙滩", "attraction", "low", "沙滩很美"),
    );

    const res = await requestJson(`/trips/${tripA.tripId}/sources`, "POST", {
      inputKind: "text",
      text: "三亚攻略（桩正文）：Day2 去蜈支洲岛，西岛墙 p6、木门歪椰树 p2 p8 p9、珊瑚墙 p11 p12 p13。",
    });
    assert.equal(res.status, 200, `提交应 200（实际 ${res.status}：${JSON.stringify(res.body)}）`);
    const sourceId = res.body.sourceId as string;
    const settled = await waitSettled(tripA.tripId, sourceId);
    assert.ok(settled.status === "ready" || settled.status === "partial", `来源应结算（实际 ${settled.status}）`);

    const trip = await loadTrip(tripA.tripId);
    const source = sourceOf(trip, sourceId);
    const noteEvidenceIds = source.evidenceRefs.filter((id) => trip.evidences[id]?.kind === "note_text");
    assert.equal(noteEvidenceIds.length, 1, "应恰好一条正文证据");
    const evidence = trip.evidences[noteEvidenceIds[0]];
    const mentionByName = new Map(evidence.mentions.map((mention) => [mention.extractedName ?? mention.text, mention]));

    // golden 三样：pageRefs 落盘保持原始一基页码
    assert.deepEqual(mentionByName.get("西岛墙")?.pageRefs, [6], "西岛墙 p6");
    assert.deepEqual(mentionByName.get("木门歪椰树")?.pageRefs, [2, 8, 9], "木门歪椰树 p2 p8 p9");
    assert.deepEqual(mentionByName.get("珊瑚墙")?.pageRefs, [11, 12, 13], "珊瑚墙 p11 p12 p13");
    assert.deepEqual(mentionByName.get("灯塔")?.pageRefs, [3], "灯塔 p3（明确装置保留）");
    assert.deepEqual(mentionByName.get("海滨浴场")?.pageRefs, [], "无页码条目 pageRefs 为空数组");

    // 自定义点位 Item 已建（custom origin）
    for (const name of ["西岛墙", "木门歪椰树", "珊瑚墙", "灯塔"]) {
      const item = Object.values(trip.itemRegistry).find((candidate) => candidate.name === name);
      assert.ok(item !== undefined, `「${name}」应建为自定义点位 Item`);
      assert.equal(item.origin, "custom", `「${name}」应 origin=custom（搜索失败降级）`);
    }

    // 泛化 / 编造条目零残留：无 Item、无 mention
    const rejectedNames = ["普通沙滩", "小吃街", "路过椰林", "海边公路", "随手拍处", "入口旁", "码头左侧", "粉红沙滩"];
    for (const name of rejectedNames) {
      const item = Object.values(trip.itemRegistry).find((candidate) => candidate.name === name);
      assert.equal(item, undefined, `「${name}」不应建 Item`);
      assert.equal(
        evidence.mentions.some((mention) => (mention.extractedName ?? mention.text) === name),
        false,
        `「${name}」不应留下 mention`,
      );
    }

    // 复用既有 Item 豁免过滤：第一市场（quote 不含全名）仅补证据
    const marketItem = Object.values(trip.itemRegistry).find((candidate) => candidate.name === "第一市场");
    assert.ok(marketItem !== undefined, "第一市场既有 Item 应复用");
    assert.ok(
      marketItem.sourceEvidenceRefs.includes(noteEvidenceIds[0]),
      "复用 Item 应追加新证据引用（复用不受过滤影响）",
    );
    assert.ok(mentionByName.has("第一市场"), "复用条目应保留 mention");

    // 复用既有 fliggy 实体不受过滤：蜈支洲岛 / 海滨浴场照常复用
    const wzz = Object.values(trip.itemRegistry).find((candidate) => candidate.name === "蜈支洲岛");
    assert.ok(wzz !== undefined && wzz.origin === "fliggy", "蜈支洲岛应复用既有 fliggy Item");

    // 后台装配语义不回归：pending stop + suggestedVisitRef（suppressAttach）
    const xdwItemForStop = Object.values(trip.itemRegistry).find((candidate) => candidate.name === "西岛墙");
    assert.ok(xdwItemForStop !== undefined, "西岛墙 Item 应存在");
    const xdwStop = Object.values(trip.stops).find((stop) => stop.matchedPointRef === xdwItemForStop.itemId);
    assert.ok(xdwStop !== undefined, "西岛墙应建 stop（三级归属到蜈支洲岛）");
    assert.equal(xdwStop.state, "pending", "后台装配不得自动挂入");
    assert.ok(source.mentionRefs.length >= 6, "mentionRefs 应覆盖全部保留提及");
    pass("HTTP golden：三样 pageRefs 落盘；泛化/编造零残留；装置保留；复用豁免；suppressAttach 语义不回归");
  }

  // --- 场景 B：父景区自动补建不受过滤影响（补建 quote 为子条目原句，不含父名） ---
  const tripB = await createFixtureSanyaTrip();
  createdTripIds.push(tripB.tripId);
  {
    stubEntries.length = 0;
    stubEntries.push(mkEntry("情人桥", "in_attraction", "high", "上岛先走情人桥很出片", "后海村"));

    const res = await requestJson(`/trips/${tripB.tripId}/sources`, "POST", {
      inputKind: "text",
      text: "三亚攻略（桩正文）：Day2 情人桥在后海村，上岛先走情人桥很出片。",
    });
    assert.equal(res.status, 200);
    const sourceId = res.body.sourceId as string;
    await waitSettled(tripB.tripId, sourceId);
    const trip = await loadTrip(tripB.tripId);
    const parent = Object.values(trip.itemRegistry).find((candidate) => candidate.name === "后海村");
    assert.ok(parent !== undefined, `父景区「后海村」应自动补建（补建路径不受打卡点过滤影响）`);
    assert.equal(parent.origin, "custom", "补建父景区按未命中降级 custom");
    pass("HTTP 父补建：parentAttraction 自动补建壳不被过滤（不误删父子景点）");
  }
}

main().catch((error) => {
  console.error("\n[verify] Task #196 验证失败：", error);
  process.exitCode = 1;
});
