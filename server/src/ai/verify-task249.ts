/**
 * Task #249 离线验收（不触网、不写盘）：区域消歧 + custom → FlyAI 原地升级 + 修复脚本决策。
 *
 * 覆盖矩阵（对应任务书验收项）：
 * A. 区域识别复用 SANYA_AREAS：精确片区名 / 住宿片段命中；「亚龙湾海滩」
 *    「亚龙湾热带天堂森林公园」「海棠湾免税城」「清水湾」等具体名与非三亚目的地零误伤
 *    （严禁「以湾结尾」粗暴过滤）；
 * B. 装配兜底：「亚龙湾」住宿区域段不生成 Item；「亚龙湾海滩」
 *    「亚龙湾热带天堂森林公园」保留；既有 fliggy「三亚湾」不被误删（provider 保护）；
 *    纯片区父级不补建大景区壳；
 * C. 简称召回：搜索 query 同时包含简称与正式名，非别名只有一条；
 * D. custom 原地升级：itemId / name / 证据引用 / Visit / Stop / 排序不变，
 *    重复装配与重复调用均幂等；
 * E. 修复脚本：只扫描别名命中的 custom Item；无结果 / 多义 / providerId 被占用 /
 *    搜索异常一律不更新；dry-run 不修改行程；参数守卫拒绝无 --trip 的批量修改；
 * G. 在线升级安全（Task #254）：多义 / 占用 / 部分搜索失败均保持 custom，
 *    不拿 findBestMatch 首条结果升级存量实体。
 * F. prompt 规则：EXTRACT_RULES_TEXT / OCR_RULES_TEXT 均含区域 / 住宿片区禁令。
 *
 * 运行：npx tsx server/src/ai/verify-task249.ts
 */

import "../env.js";
import assert from "node:assert/strict";
import type { Day, Item, SourceEvidence, Stop, Trip, Visit } from "@goplay/shared";
import { SCHEMA_VERSION, findAreaByPlaceName, isAreaOnlyPlaceName, isPoiAlias } from "@goplay/shared";
import type { FlyAIPoi } from "../flyai/client.js";
import {
  applyPoiUpgradeToCustomItem,
  assembleEntries,
  emptyPoiAlignment,
  planPoiSearchQueries,
  type GuidePoiAligner,
  type ParsedEntry,
  type PoiAlignment,
} from "./assemble.js";
import { EXTRACT_RULES_TEXT, OCR_RULES_TEXT } from "./prompt.js";
import { decidePoiUpgradeTarget } from "./poiUpgrade.js";
import { evaluateTrip, listAliasCustomItems, parseFixArgs } from "./fix-task249.js";

// ===== 断言助手（参数统一 unknown，避免断言签名把调用方变量推断成环） =====

function eq(actual: unknown, expected: unknown, label = ""): void {
  assert.deepEqual(actual, expected, label);
}

function ok(condition: boolean, label: string): void {
  assert.ok(condition, label);
}

function snapshot(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

// ===== fixture =====

function makeDay(dayIndex: number, date: string, scheduleVisitRefs: string[] = []): Day {
  return {
    dayId: `day_${dayIndex}`,
    dayIndex,
    date,
    departTime: null,
    departTimeOverridden: false,
    scheduleVisitRefs,
    lodging: null,
  };
}

function makeTrip(parts: Partial<Trip> = {}): Trip {
  const days: Record<string, Day> = {
    day_1: makeDay(1, "2026-11-08"),
    day_2: makeDay(2, "2026-11-09"),
  };
  return {
    tripId: "11111111-1111-4111-8111-111111111111",
    schemaVersion: SCHEMA_VERSION,
    version: 7,
    destination: { city: "三亚", cityCode: "STY" },
    dateRange: { start: "2026-11-08", end: "2026-11-09", nights: 1 },
    dayRefs: ["day_1", "day_2"],
    days,
    lodgings: {},
    hotelRegistry: {},
    guideSources: {},
    itemRegistry: {},
    visits: {},
    stops: {},
    evidences: {},
    globalCandidateRefs: [],
    pendingStopRefs: [],
    relationshipSuggestions: {},
    constraints: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...parts,
  };
}

function makeItem(overrides: Partial<Item> & { itemId: string; name: string }): Item {
  return {
    origin: "custom",
    providerId: null,
    address: null,
    category: null,
    coords: null,
    suggestMinutes: null,
    mainPic: null,
    ticketInfo: null,
    jumpUrl: null,
    sourceEvidenceRefs: [],
    ...overrides,
  };
}

function makeVisit(overrides: Partial<Visit> & { visitId: string; pointRef: string }): Visit {
  return {
    dayRef: "day_1",
    kind: "ordinary",
    visitMode: "custom",
    order: 0,
    windowStart: null,
    windowEnd: null,
    startTime: null,
    endTime: null,
    startTimeOverridden: false,
    endTimeOverridden: false,
    reservedMinutes: null,
    effectiveMinutes: null,
    externalLeg: null,
    childStopRefs: [],
    alternateStopRefs: [],
    sourceMentionRefs: [],
    purchaseState: "unknown",
    locked: false,
    userAdjusted: false,
    removedFrom: null,
    removedAt: null,
    ...overrides,
  };
}

function makeStop(overrides: Partial<Stop> & { stopId: string }): Stop {
  return {
    state: "pending",
    visitRef: null,
    suggestedVisitRef: null,
    matchedPointRef: null,
    customName: null,
    order: null,
    suggestMinutes: null,
    locationHint: null,
    ticketRelation: "unknown",
    sourceEvidenceRefs: [],
    sourceMentionRefs: [],
    userAdjusted: false,
    removedFromOrder: null,
    removedAt: null,
    ...overrides,
  };
}

function makeEvidence(evidenceId: string, mentions: SourceEvidence["mentions"] = []): SourceEvidence {
  return {
    evidenceId,
    kind: "note_text",
    noteIndex: 1,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions,
  };
}

function makeEntry(name: string, extra: Partial<ParsedEntry> = {}): ParsedEntry {
  return {
    name,
    type: "attraction",
    parentAttraction: null,
    scale: null,
    confidence: "high",
    suggestMinutes: null,
    locationHint: null,
    quote: `攻略提到了${name}`,
    summary: `${name} 值得一去`,
    ticketRelation: "unknown",
    suggestedVisitName: null,
    bbox: null,
    ...extra,
  };
}

function makePoi(id: string, name: string, extra: Partial<FlyAIPoi> = {}): FlyAIPoi {
  return {
    id,
    name,
    address: "海南省三亚市",
    category: "自然风光",
    description: null,
    freePoiStatus: null,
    poiLevel: null,
    coords: { lng: 109.6, lat: 18.2 },
    mainPic: `https://img.example.com/${id}.jpg`,
    listRank: null,
    ticketInfo: "¥128",
    jumpUrl: `https://router.feizhu.com/multi/webview?url=${id}`,
    ...extra,
  };
}

const noSearch: GuidePoiAligner = async () => emptyPoiAlignment();

/** 对齐桩：match = 首条命中（既有召回策略），candidates = 完整候选集 */
function alignmentOf(
  match: FlyAIPoi | null,
  candidates: FlyAIPoi[] = match === null ? [] : [match],
  error: string | null = null,
): PoiAlignment {
  return { match, candidates, error };
}

// ===== 用例集合 =====

interface CaseResult {
  label: string;
  error: string | null;
}

const results: CaseResult[] = [];

async function test(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ label, error: null });
  } catch (error) {
    results.push({ label, error: error instanceof Error ? error.message : String(error) });
  }
}

async function main(): Promise<void> {
  // ---------- A. 区域识别 ----------
  await test("A1 片区名 / 住宿片段精确命中（复用 SANYA_AREAS）", () => {
    ok(isAreaOnlyPlaceName("亚龙湾", "三亚"), "「亚龙湾」应为纯片区");
    ok(isAreaOnlyPlaceName("海棠湾", "三亚"), "「海棠湾」应为纯片区");
    ok(isAreaOnlyPlaceName("三亚湾", "三亚"), "「三亚湾」应为纯片区");
    ok(isAreaOnlyPlaceName("大东海", "三亚"), "「大东海」应为纯片区");
    ok(isAreaOnlyPlaceName(" 亚龙湾 住宿 ", "三亚"), "「亚龙湾 住宿」应为住宿片区描述");
    ok(isAreaOnlyPlaceName("海棠湾一带", "三亚"), "「海棠湾一带」应为纯片区");
    ok(isAreaOnlyPlaceName("亚龙湾", null), "未给出城市时按三亚语境识别");
    eq(findAreaByPlaceName("海棠湾住宿")?.id, "haitang", "海棠湾住宿应命中 haitang");
    eq(findAreaByPlaceName("亚龙湾区域")?.id, "yalong", "亚龙湾区域应命中 yalong");
  });

  await test("A2 具体名称零误伤（禁止「以湾结尾」粗暴过滤）", () => {
    ok(!isAreaOnlyPlaceName("亚龙湾海滩", "三亚"), "「亚龙湾海滩」是具体 POI，不得过滤");
    ok(!isAreaOnlyPlaceName("亚龙湾热带天堂森林公园", "三亚"), "森林公园是具体 POI，不得过滤");
    ok(!isAreaOnlyPlaceName("海棠湾免税城", "三亚"), "免税城是具体 POI，不得过滤");
    ok(!isAreaOnlyPlaceName("后海村", "三亚"), "后海村不是片区名");
    ok(!isAreaOnlyPlaceName("清水湾", "三亚"), "「清水湾」不在 SANYA_AREAS，不得按结尾字过滤");
    ok(!isAreaOnlyPlaceName("香水湾", "三亚"), "「香水湾」不在 SANYA_AREAS，不得按结尾字过滤");
    ok(!isAreaOnlyPlaceName("亚龙湾", "海口"), "非三亚目的地不套用三亚片区表");
    eq(findAreaByPlaceName("亚龙湾热带天堂森林公园"), undefined, "具体 POI 不得命中片区");
  });

  // ---------- B. 装配兜底 ----------
  await test("B1 「亚龙湾」住宿区域段不生成 Item / Visit / mention", async () => {
    const trip = makeTrip();
    const evidence = makeEvidence("ev_b1");
    const outcome = await assembleEntries(trip, [makeEntry("亚龙湾")], evidence, "ev_b1", [], new Map(), {
      aligner: noSearch,
    });
    eq(Object.keys(trip.itemRegistry).length, 0, "纯片区不应创建 Item");
    eq(Object.keys(trip.visits).length, 0, "纯片区不应创建 Visit 壳");
    eq(outcome.items.length, 0, "outcome 不应回报 Item");
    eq(evidence.mentions.length, 0, "被跳过的片区条目不写入 mention");

    // 住宿片段同样不得生成 Item（「住亚龙湾」「海棠湾一带」）
    const lodgingTrip = makeTrip();
    const lodgingOutcome = await assembleEntries(
      lodgingTrip,
      [makeEntry("亚龙湾住宿"), makeEntry("海棠湾一带")],
      makeEvidence("ev_b1_lodging"),
      "ev_b1_lodging",
      [],
      new Map(),
      { aligner: noSearch },
    );
    eq(lodgingOutcome.items.length, 0, "住宿 / 一带描述不得生成 Item");
    eq(Object.keys(lodgingTrip.itemRegistry).length, 0, "住宿 / 一带描述不得进 itemRegistry");
  });

  await test("B2 「亚龙湾海滩」「亚龙湾热带天堂森林公园」保留", async () => {
    const trip = makeTrip();
    const beachOutcome = await assembleEntries(
      trip,
      [makeEntry("亚龙湾海滩")],
      makeEvidence("ev_b2a"),
      "ev_b2a",
      [],
      new Map(),
      { aligner: noSearch },
    );
    eq(beachOutcome.items.length, 1, "「亚龙湾海滩」应正常创建");
    const beach = Object.values(trip.itemRegistry).find((item) => item.name === "亚龙湾海滩");
    ok(beach !== undefined, "「亚龙湾海滩」Item 应存在");
    eq(beach?.origin, "custom", "搜索未命中时为 custom，但仍保留");

    const forestPoi = makePoi("8888", "亚龙湾热带天堂森林公园");
    const forestOutcome = await assembleEntries(
      trip,
      [makeEntry("亚龙湾热带天堂森林公园")],
      makeEvidence("ev_b2b"),
      "ev_b2b",
      [],
      new Map(),
      { aligner: async () => alignmentOf(forestPoi) },
    );
    eq(forestOutcome.items.length, 1, "森林公园应正常创建");
    const forest = Object.values(trip.itemRegistry).find((item) => item.name === "亚龙湾热带天堂森林公园");
    eq(forest?.origin, "fliggy", "命中供应商时 origin 应为 fliggy");
    eq(forest?.providerId, "8888");
  });

  await test("B3 既有 fliggy「三亚湾」不被区域消歧误删（provider 保护边界）", async () => {
    const existing = makeItem({
      itemId: "item_sanya_wan",
      name: "三亚湾",
      origin: "fliggy",
      providerId: "345066",
      sourceEvidenceRefs: ["ev_old"],
    });
    const trip = makeTrip();
    trip.itemRegistry[existing.itemId] = existing;
    const outcome = await assembleEntries(trip, [makeEntry("三亚湾")], makeEvidence("ev_b3"), "ev_b3", [], new Map(), {
      aligner: noSearch,
    });
    eq(Object.keys(trip.itemRegistry).length, 1, "不得新增重复 Item");
    eq(outcome.items.length, 1, "既有真实结果应被复用回报");
    eq(outcome.items[0]?.reused, true, "应标记为复用而非新建");
    eq(trip.itemRegistry[existing.itemId]?.providerId, "345066", "providerId 不得变化");
    eq(trip.itemRegistry[existing.itemId]?.sourceEvidenceRefs, ["ev_old", "ev_b3"], "复用时仅追加证据引用");
  });

  await test("B3b 区域名命中真实供应商 POI 时不得丢弃（具体名称 + 供应商优先）", async () => {
    const trip = makeTrip();
    const outcome = await assembleEntries(
      trip,
      [makeEntry("三亚湾")],
      makeEvidence("ev_b3b"),
      "ev_b3b",
      [],
      new Map(),
      { aligner: async () => alignmentOf(makePoi("345066", "三亚湾")) },
    );
    eq(outcome.items.length, 1, "真实供应商结果应保留（区域名不等于可丢弃）");
    const item = Object.values(trip.itemRegistry).find((candidate) => candidate.name === "三亚湾");
    eq(item?.origin, "fliggy", "命中供应商时 origin 为 fliggy");
    eq(item?.providerId, "345066", "providerId 来自 FlyAI");
  });

  await test("B4 纯片区父级不补建大景区壳，内部玩法落 pending", async () => {
    const trip = makeTrip();
    const outcome = await assembleEntries(
      trip,
      [makeEntry("情人桥", { type: "in_attraction", parentAttraction: "亚龙湾" })],
      makeEvidence("ev_b4"),
      "ev_b4",
      [],
      new Map(),
      { aligner: noSearch },
    );
    const parentItem = Object.values(trip.itemRegistry).find((item) => item.name === "亚龙湾");
    eq(parentItem, undefined, "不得为纯片区补建 Item");
    const parentVisit = Object.values(trip.visits).find(
      (visit) => trip.itemRegistry[visit.pointRef]?.name === "亚龙湾",
    );
    eq(parentVisit, undefined, "不得为纯片区补建 Visit 壳");
    eq(outcome.stops.length, 1, "内部玩法本身仍应保留");
    eq(outcome.stops[0]?.state, "pending", "无归属时落待定");
    eq(outcome.stops[0]?.suggestedVisitRef, null, "纯片区不得作为建议归属");
  });

  await test("B5 非三亚目的地不触发区域消歧", async () => {
    const trip = makeTrip({ destination: { city: "海口", cityCode: "HAK" } });
    const outcome = await assembleEntries(trip, [makeEntry("亚龙湾")], makeEvidence("ev_b5"), "ev_b5", [], new Map(), {
      aligner: noSearch,
    });
    eq(outcome.items.length, 1, "非三亚行程不应跳过同名条目");
  });

  // ---------- C. 简称召回 query ----------
  await test("C1 简称搜索 query 同时包含简称与正式名", () => {
    const queries = planPoiSearchQueries("三亚", "亚龙湾森林公园");
    eq(queries.length, 2, "别名应产生两条查询");
    ok(queries[0]?.includes("亚龙湾森林公园") === true, "第一条 query 应包含简称");
    ok(queries[1]?.includes("亚龙湾热带天堂森林公园") === true, "第二条 query 应包含正式名");
    eq(queries, ["三亚 亚龙湾森林公园", "三亚 亚龙湾热带天堂森林公园"], "查询顺序应为简称 → 正式名");

    eq(planPoiSearchQueries("三亚", "亚龙湾海滩"), ["三亚 亚龙湾海滩"], "非别名只有一条查询");
    eq(planPoiSearchQueries("三亚", "亚龙湾"), ["三亚 亚龙湾"], "片区名本身不是别名");
  });

  // ---------- D. custom 原地升级 ----------
  await test("D1 别名命中 custom Item 原地升级：itemId / 证据 / 归属 / 排序不变", async () => {
    const trip = makeTrip();
    trip.itemRegistry["item_forest"] = makeItem({
      itemId: "item_forest",
      name: "亚龙湾森林公园",
      suggestMinutes: 180,
      sourceEvidenceRefs: ["ev_old"],
    });
    trip.itemRegistry["item_other"] = makeItem({ itemId: "item_other", name: "第一市场" });
    trip.itemRegistry["item_beach"] = makeItem({ itemId: "item_beach", name: "亚龙湾海滩" });
    trip.visits["visit_forest"] = makeVisit({
      visitId: "visit_forest",
      pointRef: "item_forest",
      order: 0,
      childStopRefs: ["stop_beach"],
    });
    trip.visits["visit_other"] = makeVisit({
      visitId: "visit_other",
      pointRef: "item_other",
      order: 1,
    });
    trip.stops["stop_beach"] = makeStop({
      stopId: "stop_beach",
      state: "attached",
      visitRef: "visit_forest",
      matchedPointRef: "item_beach",
      order: 0,
    });
    trip.days.day_1!.scheduleVisitRefs = ["visit_forest", "visit_other"];

    const visitsBefore = snapshot(trip.visits);
    const stopsBefore = snapshot(trip.stops);
    const daysBefore = snapshot(trip.days);
    const evidenceRefsBefore = [...trip.itemRegistry["item_forest"]!.sourceEvidenceRefs];

    const officialPoi = makePoi("8888", "亚龙湾热带天堂森林公园", {
      address: "海南省三亚市吉阳区亚龙湾国家旅游度假区",
      mainPic: "https://img.example.com/forest.jpg",
      jumpUrl: "https://router.feizhu.com/multi/webview?url=forest",
    });
    const outcome = await assembleEntries(
      trip,
      [makeEntry("亚龙湾森林公园")],
      makeEvidence("ev_new"),
      "ev_new",
      [],
      new Map(),
      { aligner: async () => alignmentOf(officialPoi) },
    );

    const upgraded = trip.itemRegistry["item_forest"];
    ok(upgraded !== undefined, "原 Item 必须存在（不得重建）");
    eq(upgraded?.itemId, "item_forest", "itemId 不变");
    eq(upgraded?.name, "亚龙湾森林公园", "name 保留攻略原文");
    eq(upgraded?.origin, "fliggy", "origin 升级为 fliggy");
    eq(upgraded?.providerId, "8888", "providerId 来自唯一命中");
    eq(upgraded?.address, "海南省三亚市吉阳区亚龙湾国家旅游度假区", "address 补全");
    eq(upgraded?.jumpUrl, "https://router.feizhu.com/multi/webview?url=forest", "jumpUrl 补全");
    eq(upgraded?.mainPic, "https://img.example.com/forest.jpg", "mainPic 补全");
    eq(upgraded?.suggestMinutes, 180, "suggestMinutes 不变");
    eq(upgraded?.sourceEvidenceRefs, [...evidenceRefsBefore, "ev_new"], "证据引用只追加不覆盖");
    eq(Object.keys(trip.itemRegistry).length, 3, "不得新建重复 Item");
    eq(snapshot(trip.visits), visitsBefore, "visits 逐字段不变");
    eq(snapshot(trip.stops), stopsBefore, "stops / order 逐字段不变");
    eq(snapshot(trip.days), daysBefore, "days 排序不变");
    eq(outcome.items.length, 1, "outcome 只报一条");
    eq(outcome.items[0]?.reused, true, "升级按复用计数，不计新增");
    eq(outcome.items[0]?.origin, "fliggy", "outcome origin 反映升级结果");
  });

  await test("D2 升级后重复装配幂等（不再搜索、不重复升级）", async () => {
    const trip = makeTrip();
    trip.itemRegistry["item_forest"] = makeItem({
      itemId: "item_forest",
      name: "亚龙湾森林公园",
      sourceEvidenceRefs: ["ev_old"],
    });
    trip.visits["visit_forest"] = makeVisit({ visitId: "visit_forest", pointRef: "item_forest" });
    trip.days.day_1!.scheduleVisitRefs = ["visit_forest"];
    const officialPoi = makePoi("8888", "亚龙湾热带天堂森林公园");

    await assembleEntries(trip, [makeEntry("亚龙湾森林公园")], makeEvidence("ev_1"), "ev_1", [], new Map(), {
      aligner: async () => alignmentOf(officialPoi),
    });
    const afterFirst = snapshot(trip.itemRegistry["item_forest"]);

    let alignCalls = 0;
    const outcome = await assembleEntries(
      trip,
      [makeEntry("亚龙湾森林公园")],
      makeEvidence("ev_2"),
      "ev_2",
      [],
      new Map(),
      {
        aligner: async () => {
          alignCalls += 1;
          throw new Error("已是 fliggy，不应再次搜索");
        },
      },
    );
    eq(alignCalls, 0, "升级后应命中既有 fliggy Item，跳过搜索");
    eq(Object.keys(trip.itemRegistry).length, 1, "不得新增 Item");
    const afterSecond = trip.itemRegistry["item_forest"];
    eq(afterSecond?.providerId, "8888", "providerId 保持");
    eq(afterSecond?.origin, "fliggy", "origin 保持");
    eq(afterSecond?.sourceEvidenceRefs, ["ev_old", "ev_1", "ev_2"], "证据引用幂等追加");
    eq(outcome.items[0]?.reused, true);
    const changesSecondRun = (snapshot(afterSecond) as Item).providerId;
    eq(changesSecondRun, (snapshot(afterFirst) as Item).providerId, "第二次装配不产生字段变更");

    // 直接调用纯函数：已是 fliggy → null（幂等）
    eq(applyPoiUpgradeToCustomItem(afterSecond!, officialPoi, "亚龙湾森林公园"), null, "已升级 Item 再升级返回 null");
  });

  await test("D3 升级边界：非别名 / canonical 不等 / 空 providerId 一律不升级", () => {
    const custom = makeItem({ itemId: "item_1", name: "亚龙湾森林公园" });
    eq(
      applyPoiUpgradeToCustomItem(custom, makePoi("2757", "亚龙湾海滩"), "亚龙湾森林公园"),
      null,
      "片区 POI 与森林公园 canonical 不等，不得升级",
    );
    eq(
      applyPoiUpgradeToCustomItem(custom, makePoi("8888", "亚龙湾热带天堂森林公园"), null),
      null,
      "无别名来源不得升级",
    );
    eq(
      applyPoiUpgradeToCustomItem(custom, makePoi("8888", "亚龙湾热带天堂森林公园"), "亚龙湾海滩"),
      null,
      "非别名名称不得升级",
    );
    eq(
      applyPoiUpgradeToCustomItem(custom, makePoi("", "亚龙湾热带天堂森林公园"), "亚龙湾森林公园"),
      null,
      "空 providerId 绝不伪造",
    );
    ok(isPoiAlias("亚龙湾森林公园"), "简称应在别名表内");
    eq(custom.origin, "custom", "失败路径不得产生副作用");
    eq(custom.providerId, null, "失败路径不得写 providerId");
  });

  await test("D4 在线升级安全：canonical 同名但两个 providerId 时保持 custom（不据首条升级）", async () => {
    const trip = makeTrip();
    trip.itemRegistry["item_forest"] = makeItem({
      itemId: "item_forest",
      name: "亚龙湾森林公园",
      sourceEvidenceRefs: ["ev_old"],
    });
    trip.visits["visit_forest"] = makeVisit({ visitId: "visit_forest", pointRef: "item_forest" });
    const addressBefore = trip.itemRegistry["item_forest"]!.address;
    const first = makePoi("9001", "亚龙湾热带天堂森林公园", { address: "甲商家地址" });
    const second = makePoi("9002", "亚龙湾热带天堂森林公园", { address: "乙商家地址" });

    const outcome = await assembleEntries(
      trip,
      [makeEntry("亚龙湾森林公园")],
      makeEvidence("ev_multi"),
      "ev_multi",
      [],
      new Map(),
      // match 故意给第一条——旧实现会直接拿它升级，新实现必须看完整候选集
      { aligner: async () => alignmentOf(first, [first, second]) },
    );

    const item = trip.itemRegistry["item_forest"];
    eq(item?.origin, "custom", "多义不得升级");
    eq(item?.providerId, null, "不得写 providerId");
    eq(item?.address, addressBefore, "供应商字段一个都不写");
    eq(item?.sourceEvidenceRefs, ["ev_old", "ev_multi"], "复用语义不变：仅追加证据引用");
    eq(Object.keys(trip.itemRegistry).length, 1, "不得新建重复 Item");
    eq(outcome.items[0]?.origin, "custom", "outcome 如实反映仍为 custom");
  });

  await test("D5 在线升级安全：providerId 被其他 Item 占用时保持 custom", async () => {
    const trip = makeTrip();
    trip.itemRegistry["item_forest"] = makeItem({ itemId: "item_forest", name: "亚龙湾森林公园" });
    trip.itemRegistry["item_other"] = makeItem({
      itemId: "item_other",
      name: "别的点位",
      origin: "fliggy",
      providerId: "9001",
    });
    trip.visits["visit_forest"] = makeVisit({ visitId: "visit_forest", pointRef: "item_forest" });
    const official = makePoi("9001", "亚龙湾热带天堂森林公园");
    const area = makePoi("2757", "亚龙湾");

    await assembleEntries(
      trip,
      [makeEntry("亚龙湾森林公园")],
      makeEvidence("ev_occupied"),
      "ev_occupied",
      [],
      new Map(),
      // 首条 match 是「亚龙湾」片区（包含降级命中），完整候选集里才有唯一 canonical
      { aligner: async () => alignmentOf(area, [area, official]) },
    );

    eq(trip.itemRegistry["item_forest"]?.origin, "custom", "被占用不得升级");
    eq(trip.itemRegistry["item_forest"]?.providerId, null, "不得产生重复 providerId");
    eq(
      Object.values(trip.itemRegistry)
        .filter((item) => item.providerId === "9001")
        .map((item) => item.itemId),
      ["item_other"],
      "9001 仍只被 item_other 占用",
    );
  });

  await test("D6 在线升级安全：任一搜索轮次失败时保持 custom（含正式名轮超时）", async () => {
    const trip = makeTrip();
    trip.itemRegistry["item_forest"] = makeItem({ itemId: "item_forest", name: "亚龙湾森林公园" });
    trip.visits["visit_forest"] = makeVisit({ visitId: "visit_forest", pointRef: "item_forest" });
    const official = makePoi("8888", "亚龙湾热带天堂森林公园");

    // 简称轮成功、正式名轮超时：候选非空也不得当成唯一命中
    await assembleEntries(
      trip,
      [makeEntry("亚龙湾森林公园")],
      makeEvidence("ev_partial"),
      "ev_partial",
      [],
      new Map(),
      { aligner: async () => alignmentOf(null, [official], "FlyAI CLI 超时") },
    );

    eq(trip.itemRegistry["item_forest"]?.origin, "custom", "部分搜索失败不得升级");
    eq(trip.itemRegistry["item_forest"]?.providerId, null);
    eq(Object.keys(trip.itemRegistry).length, 1, "不得新建 Item");
  });

  // ---------- E. 修复脚本安全闸门 ----------
  await test("E1 只扫描别名命中的 custom Item", () => {
    const trip = makeTrip();
    trip.itemRegistry["item_forest"] = makeItem({ itemId: "item_forest", name: "亚龙湾森林公园" });
    trip.itemRegistry["item_yalong"] = makeItem({ itemId: "item_yalong", name: "亚龙湾" });
    trip.itemRegistry["item_market"] = makeItem({ itemId: "item_market", name: "第一市场" });
    trip.itemRegistry["item_upgraded"] = makeItem({
      itemId: "item_upgraded",
      name: "亚龙湾热带森林公园",
      origin: "fliggy",
      providerId: "7777",
    });
    const scanned = listAliasCustomItems(trip);
    eq(scanned.length, 1, "只有 custom + 别名命中才进扫描范围");
    eq(scanned[0]?.itemId, "item_forest");
    eq(scanned[0]?.canonicalName, "亚龙湾热带天堂森林公园");
  });

  await test("E2 无结果 / 多义 / 占用 / 搜索异常都不更新（dry-run 不写字段）", async () => {
    const trip = makeTrip();
    trip.itemRegistry["item_forest"] = makeItem({
      itemId: "item_forest",
      name: "亚龙湾森林公园",
      sourceEvidenceRefs: ["ev_old"],
    });
    const before = snapshot(trip.itemRegistry["item_forest"]);
    const queries = ["三亚 亚龙湾森林公园", "三亚 亚龙湾热带天堂森林公园"];

    const noResult = await evaluateTrip(trip, async () => ({ pois: [], queries, error: null }));
    eq(noResult[0]?.status, "no-candidate", "无结果不得更新");

    const multi = await evaluateTrip(trip, async () => ({
      pois: [makePoi("9001", "亚龙湾热带天堂森林公园"), makePoi("9002", "亚龙湾热带天堂森林公园")],
      queries,
      error: null,
    }));
    eq(multi[0]?.status, "ambiguous", "多义结果不得更新");

    ok(trip.itemRegistry["item_forest"] !== undefined, "Item 必须存在");
    const occupied = await evaluateTrip(trip, async () => ({
      pois: [makePoi("9001", "亚龙湾热带天堂森林公园")],
      queries,
      error: null,
    }));
    // 9001 未被占用 → upgrade；再构造占用场景
    eq(occupied[0]?.status, "upgrade", "唯一命中应为 upgrade");
    eq(snapshot(trip.itemRegistry["item_forest"]), before, "dry-run 推演不得修改行程");

    trip.itemRegistry["item_other"] = makeItem({ itemId: "item_other", name: "别的点位", origin: "fliggy", providerId: "9001" });
    const occupied2 = await evaluateTrip(trip, async () => ({
      pois: [makePoi("9001", "亚龙湾热带天堂森林公园")],
      queries,
      error: null,
    }));
    eq(occupied2[0]?.status, "occupied", "providerId 已被占用不得更新");
    delete trip.itemRegistry["item_other"];

    const failed = await evaluateTrip(trip, async () => ({ pois: [], queries, error: "FlyAI CLI 超时" }));
    eq(failed[0]?.status, "search-error", "搜索失败不得更新");

    const plan = await evaluateTrip(trip, async () => ({
      pois: [makePoi("8888", "亚龙湾热带天堂森林公园")],
      queries,
      error: null,
    }));
    eq(plan[0]?.status, "upgrade");
    eq(plan[0]?.providerId, "8888");
    const changedFields = plan[0]?.changes.map((change) => String(change.field)) ?? [];
    ok(changedFields.includes("origin") && changedFields.includes("providerId"), "拟变更字段应含 origin / providerId");
    eq(snapshot(trip.itemRegistry["item_forest"]), before, "完整 dry-run 后行程仍未修改");
  });

  await test("E3 决策函数独立口径（canonical 全等 + 唯一 + 未占用 + 搜索成功）", () => {
    const official = makePoi("9001", "亚龙湾热带天堂森林公园");
    eq(decidePoiUpgradeTarget("亚龙湾森林公园", [], new Map()).kind, "no-candidate", "空结果");
    eq(
      decidePoiUpgradeTarget("亚龙湾森林公园", [official, makePoi("9002", "亚龙湾热带天堂森林公园")], new Map()).kind,
      "ambiguous",
      "两个不同 providerId 为多义",
    );
    eq(
      decidePoiUpgradeTarget("亚龙湾森林公园", [official], new Map([["9001", "item_x"]])).kind,
      "occupied",
      "被其他 Item 占用不得升级",
    );
    eq(
      decidePoiUpgradeTarget("亚龙湾森林公园", [official, official], new Map()).kind,
      "upgrade",
      "同 providerId 去重后唯一仍可升级",
    );
    eq(
      decidePoiUpgradeTarget("亚龙湾森林公园", [makePoi("2757", "亚龙湾海滩")], new Map()).kind,
      "no-candidate",
      "「亚龙湾海滩」与森林公园 canonical 不等",
    );
  });

  await test("E4 参数守卫：必须显式 --trip，拒绝无参批量", () => {
    const none = parseFixArgs([]);
    eq(none.tripId, null, "无 --trip 时不得有默认行程");
    eq(none.apply, false, "默认必须 dry-run");
    eq(none.error, null);

    const dry = parseFixArgs(["--trip", "48275e19-c7cb-417b-8ef7-57b04e097cf4"]);
    eq(dry.tripId, "48275e19-c7cb-417b-8ef7-57b04e097cf4");
    eq(dry.apply, false, "未给 --apply 必须 dry-run");

    const apply = parseFixArgs(["--trip=48275e19-c7cb-417b-8ef7-57b04e097cf4", "--apply"]);
    eq(apply.tripId, "48275e19-c7cb-417b-8ef7-57b04e097cf4");
    eq(apply.apply, true);

    eq(parseFixArgs(["--apply"]).tripId, null, "只给 --apply 仍是非法调用");
    eq(parseFixArgs(["--trip="]).error, "--trip 的行程 ID 不能为空");
    ok(parseFixArgs(["--trip", "x", "--bogus"]).error !== null, "未知参数必须报错");
  });

  // ---------- F. prompt 规则 ----------
  await test("F1 EXTRACT / OCR 规则均禁止区域 / 住宿片区作为实体", () => {
    for (const [label, rules] of [
      ["EXTRACT_RULES_TEXT", EXTRACT_RULES_TEXT],
      ["OCR_RULES_TEXT", OCR_RULES_TEXT],
    ] as const) {
      ok(rules.includes("区域 / 住宿片区"), `${label} 应含区域 / 住宿片区禁令`);
      ok(rules.includes("片区名"), `${label} 应点明片区名`);
      ok(rules.includes("亚龙湾海滩"), `${label} 应保留具体场所示例`);
      ok(rules.includes("亚龙湾热带天堂森林公园"), `${label} 应保留森林公园示例`);
      ok(rules.includes("住宿"), `${label} 应覆盖住宿段落`);
    }
  });

  // ---------- 汇总 ----------
  const failures = results.filter((result) => result.error !== null);
  for (const result of results) {
    console.log(`${result.error === null ? "PASS" : "FAIL"}  ${result.label}${result.error === null ? "" : `：${result.error}`}`);
  }
  console.log(`\n[VERIFY-249] ${results.length - failures.length}/${results.length} 通过`);
  if (failures.length > 0) {
    throw new Error(`Task #249 验收失败 ${failures.length} 项：${failures.map((failure) => failure.label).join("，")}`);
  }
}

main().catch((error: unknown) => {
  console.error("[VERIFY-249] 验收脚本失败：", error);
  process.exitCode = 1;
});
