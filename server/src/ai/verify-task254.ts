/**
 * Task #254 离线验收（不触网、不写盘）：custom → 飞猪存量升级的两项安全修复。
 *
 * CodeReview 对 Task #249 的整改点：
 * 1. 在线装配不得拿 findBestMatch 的第一条升级存量实体——必须基于完整候选集、
 *    canonical 全等、providerId 去重后唯一且未被其他 Item 占用，多义保持 custom；
 * 2. fix-task249 脚本任一搜索轮次报错都必须 status=search-error 并保持 custom，
 *    「简称查询成功、正式名查询超时」同样不得升级，错误不得被吞掉。
 *
 * 覆盖矩阵：
 *   A 唯一升级决策纯函数：canonical 全等 / 多义 / 占用 / 搜索失败 / 空 providerId /
 *     别名折叠 / 同 providerId 去重（在线与脚本共用同一实现）。
 *   B 候选聚合：全轮次合并去重、任一轮失败即报错并保留已获候选、失败后不再追加轮次。
 *   C 在线装配：多义 / 占用 / 部分失败均保持 custom；全部成功唯一命中才升级。
 *   D 在线装配重复执行幂等（第二次不再搜索、字段零变更）。
 *   E 修复脚本：部分失败 → search-error；全部成功唯一 → upgrade；重复评估无副作用。
 *   F 真实 Trip 只读校验：providerId=2603 仍唯一、数据不变量不变、文件字节未变化。
 *
 * 运行：npx tsx server/src/ai/verify-task254.ts
 */

import "../env.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { Day, Item, SourceEvidence, Trip, Visit } from "@goplay/shared";
import { SCHEMA_VERSION, validateConsistency } from "@goplay/shared";
import type { FlyAIPoi } from "../flyai/client.js";
import {
  assembleEntries,
  emptyPoiAlignment,
  type ParsedEntry,
  type PoiAlignment,
} from "./assemble.js";
import { aggregatePoiCandidates, collectOccupiedProviderIds, decidePoiUpgradeTarget } from "./poiUpgrade.js";
import { evaluateTrip, listAliasCustomItems } from "./fix-task249.js";
import { tripStore } from "../persistence/store.js";

// ===== 断言助手 =====

function eq(actual: unknown, expected: unknown, label = ""): void {
  assert.deepEqual(actual, expected, label);
}

function ok(condition: boolean, label = "断言应成立"): void {
  assert.ok(condition, label);
}

function snapshot(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

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

// ===== fixture =====

const OFFICIAL = "亚龙湾热带天堂森林公园";
const ALIAS = "亚龙湾森林公园";
const ALIAS_MID = "亚龙湾热带森林公园";
const ITEM_FOREST = "item_forest";

function makeTrip(parts: Partial<Trip> = {}): Trip {
  const day1: Day = {
    dayId: "day_1",
    dayIndex: 1,
    date: "2026-11-08",
    departTime: null,
    departTimeOverridden: false,
    scheduleVisitRefs: [],
    lodging: null,
  };
  return {
    tripId: "22222222-2222-4222-8222-222222222222",
    schemaVersion: SCHEMA_VERSION,
    version: 3,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: "2026-11-08", nights: 0 },
    dayRefs: ["day_1"],
    days: { day_1: day1 },
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

function makeVisit(pointRef: string): Visit {
  return {
    visitId: `visit_${pointRef}`,
    dayRef: "day_1",
    pointRef,
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
  };
}

function makeEvidence(evidenceId: string): SourceEvidence {
  return {
    evidenceId,
    kind: "note_text",
    noteIndex: 1,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions: [],
  };
}

function makeEntry(name: string): ParsedEntry {
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
  };
}

function makePoi(id: string, name: string, extra: Partial<FlyAIPoi> = {}): FlyAIPoi {
  return {
    id,
    name,
    address: `地址-${id}`,
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

/** 对齐桩：match = 既有召回策略首条命中；candidates = 完整候选集 */
function alignmentOf(
  match: FlyAIPoi | null,
  candidates: FlyAIPoi[] = match === null ? [] : [match],
  error: string | null = null,
): PoiAlignment {
  return { match, candidates, error };
}

/** 待升级存量行程：custom 别名 Item + 对应 Visit */
function customAliasTrip(): Trip {
  const trip = makeTrip();
  trip.itemRegistry[ITEM_FOREST] = makeItem({
    itemId: ITEM_FOREST,
    name: ALIAS,
    sourceEvidenceRefs: ["ev_old"],
  });
  trip.visits[`visit_${ITEM_FOREST}`] = makeVisit(ITEM_FOREST);
  trip.days.day_1!.scheduleVisitRefs = [`visit_${ITEM_FOREST}`];
  return trip;
}

// ===== 主流程 =====

async function main(): Promise<void> {
  // ---------- A. 唯一升级决策纯函数 ----------
  await test("A1 canonical 全等 + providerId 唯一 → upgrade（别名折叠生效）", () => {
    const official = makePoi("2603", OFFICIAL);
    const decision = decidePoiUpgradeTarget(ALIAS, [official], new Map());
    eq(decision.kind, "upgrade", "唯一 canonical 命中应可升级");
    ok(decision.kind === "upgrade" && decision.providerId === "2603", "providerId 来自唯一命中");
    eq(decidePoiUpgradeTarget(ALIAS_MID, [official], new Map()).kind, "upgrade", "第二个简称同样可升级");
    eq(decidePoiUpgradeTarget(OFFICIAL, [official], new Map()).kind, "upgrade", "正式名同样可升级");
  });

  await test("A2 canonical 相同但两个不同 providerId → ambiguous（绝不取首条）", () => {
    const decision = decidePoiUpgradeTarget(
      ALIAS,
      [makePoi("9001", OFFICIAL), makePoi("9002", OFFICIAL)],
      new Map(),
    );
    eq(decision.kind, "ambiguous", "多义必须保持 custom");
    ok(decision.kind === "ambiguous" && decision.providerIds.length === 2, "应回报两个 providerId");
  });

  await test("A3 同 providerId 重复 → 去重后唯一仍可升级", () => {
    const official = makePoi("2603", OFFICIAL);
    const decision = decidePoiUpgradeTarget(ALIAS, [official, official, makePoi("2603", OFFICIAL)], new Map());
    eq(decision.kind, "upgrade", "同 providerId 的重复召回不算多义");
    ok(decision.kind === "upgrade" && decision.providerId === "2603");
  });

  await test("A4 providerId 已被其他 Item 占用 → occupied", () => {
    const decision = decidePoiUpgradeTarget(ALIAS, [makePoi("2603", OFFICIAL)], new Map([["2603", "item_x"]]));
    eq(decision.kind, "occupied", "占用不得升级（否则重复 providerId）");
    ok(decision.kind === "occupied" && decision.occupiedBy === "item_x");
  });

  await test("A5 部分搜索失败（候选唯一）→ search-error，优先级高于唯一命中", () => {
    const decision = decidePoiUpgradeTarget(ALIAS, [makePoi("2603", OFFICIAL)], new Map(), {
      searchError: "FlyAI CLI 超时（90s）",
    });
    eq(decision.kind, "search-error", "任一搜索轮次失败不得升级");
    ok(decision.kind === "search-error" && decision.error.includes("超时"), "错误原文必须保留");
    eq(
      decidePoiUpgradeTarget(ALIAS, [makePoi("2603", OFFICIAL)], new Map(), { searchError: "   " }).kind,
      "upgrade",
      "空白错误文案不构成失败",
    );
  });

  await test("A6 非 canonical 同名 / 空 providerId → 不升级", () => {
    eq(decidePoiUpgradeTarget(ALIAS, [], new Map()).kind, "no-candidate", "空候选");
    eq(
      decidePoiUpgradeTarget(ALIAS, [makePoi("2757", "亚龙湾海滩")], new Map()).kind,
      "no-candidate",
      "「亚龙湾」片区 / 海滩不得当成森林公园",
    );
    eq(
      decidePoiUpgradeTarget(ALIAS, [makePoi("  ", OFFICIAL)], new Map()).kind,
      "no-candidate",
      "空 providerId 不得伪造",
    );
  });

  await test("A7 占用表只统计其他 Item，且忽略空 providerId", () => {
    const trip = makeTrip();
    trip.itemRegistry.a = makeItem({ itemId: "a", name: "甲", origin: "fliggy", providerId: "111" });
    trip.itemRegistry.b = makeItem({ itemId: "b", name: "乙", origin: "fliggy", providerId: "222" });
    trip.itemRegistry.c = makeItem({ itemId: "c", name: "丙" });
    const occupied = collectOccupiedProviderIds(trip, "a");
    eq(occupied.get("111"), undefined, "自身应排除");
    eq(occupied.get("222"), "b", "其他 fliggy Item 应计入");
    eq(occupied.has(""), false, "空 providerId 不计入");
    ok(collectOccupiedProviderIds(trip, null).get("111") === "a", "excludeItemId=null 时统计全部");
  });

  // ---------- B. 候选聚合 ----------
  await test("B1 全部轮次成功：合并去重，保留首见顺序", async () => {
    const official = makePoi("2603", OFFICIAL);
    const beach = makePoi("2757", "亚龙湾海滩");
    const aggregate = await aggregatePoiCandidates(["三亚 亚龙湾森林公园", "三亚 亚龙湾热带天堂森林公园"], async (query) =>
      query.includes("热带天堂") ? [official, beach] : [beach, official],
    );
    eq(aggregate.error, null);
    eq(aggregate.failedIndex, null);
    eq(
      aggregate.candidates.map((poi) => poi.id),
      ["2757", "2603"],
      "按 providerId 去重且保留首见顺序",
    );
  });

  await test("B2 第二轮（正式名）失败：保留首轮候选 + 上报错误 + 不再追加轮次", async () => {
    const calls: string[] = [];
    const aggregate = await aggregatePoiCandidates(
      ["三亚 亚龙湾森林公园", "三亚 亚龙湾热带天堂森林公园", "三亚 第三轮"],
      async (query) => {
        calls.push(query);
        if (query.includes("热带天堂")) throw new Error("CLI 超时");
        return [makePoi("9001", OFFICIAL)];
      },
    );
    eq(aggregate.error, "CLI 超时", "错误不得被吞掉");
    eq(aggregate.failedIndex, 1, "应标注失败轮次");
    eq(aggregate.candidates.length, 1, "已获候选保留但不得当作完整集");
    eq(calls.length, 2, "失败后不得继续追加轮次（避免双倍超时）");
  });

  await test("B3 首轮失败：无候选 + 错误上报", async () => {
    const aggregate = await aggregatePoiCandidates(["三亚 亚龙湾森林公园", "三亚 亚龙湾热带天堂森林公园"], async () => {
      throw new Error("额度耗尽");
    });
    eq(aggregate.candidates, []);
    eq(aggregate.error, "额度耗尽");
    eq(aggregate.failedIndex, 0);
  });

  // ---------- C. 在线装配升级安全 ----------
  await test("C1 多义（首条 match 命中）→ 保持 custom，仅追加证据", async () => {
    const trip = customAliasTrip();
    const first = makePoi("9001", OFFICIAL);
    const second = makePoi("9002", OFFICIAL);
    const outcome = await assembleEntries(
      trip,
      [makeEntry(ALIAS)],
      makeEvidence("ev_multi"),
      "ev_multi",
      [],
      new Map(),
      { aligner: async () => alignmentOf(first, [first, second]) },
    );
    const item = trip.itemRegistry[ITEM_FOREST]!;
    eq(item.origin, "custom", "多义不得据首条升级");
    eq(item.providerId, null);
    eq(item.address, null, "供应商字段一个都不写");
    eq(item.sourceEvidenceRefs, ["ev_old", "ev_multi"]);
    eq(Object.keys(trip.itemRegistry).length, 1, "不得新建重复 Item");
    eq(outcome.items[0]?.reused, true, "复用语义不变");
  });

  await test("C2 providerId 被其他 Item 占用 → 保持 custom，全库 providerId 仍唯一", async () => {
    const trip = customAliasTrip();
    trip.itemRegistry.occupier = makeItem({
      itemId: "occupier",
      name: "占位点位",
      origin: "fliggy",
      providerId: "2603",
    });
    const official = makePoi("2603", OFFICIAL);
    const area = makePoi("2757", "亚龙湾");
    await assembleEntries(trip, [makeEntry(ALIAS)], makeEvidence("ev_occ"), "ev_occ", [], new Map(), {
      aligner: async () => alignmentOf(area, [area, official]),
    });
    eq(trip.itemRegistry[ITEM_FOREST]!.origin, "custom", "占用不得升级");
    eq(trip.itemRegistry[ITEM_FOREST]!.providerId, null);
    const holders = Object.values(trip.itemRegistry).filter((item) => item.providerId === "2603");
    eq(holders.map((item) => item.itemId), ["occupier"], "2603 仍只被一个 Item 占用");
  });

  await test("C3 部分搜索失败（正式名轮超时）→ 保持 custom", async () => {
    const trip = customAliasTrip();
    await assembleEntries(trip, [makeEntry(ALIAS)], makeEvidence("ev_partial"), "ev_partial", [], new Map(), {
      aligner: async () => alignmentOf(null, [makePoi("2603", OFFICIAL)], "FlyAI CLI 超时"),
    });
    eq(trip.itemRegistry[ITEM_FOREST]!.origin, "custom", "半截候选集不得升级");
    eq(trip.itemRegistry[ITEM_FOREST]!.providerId, null);
  });

  await test("C4 全部成功唯一命中 → upgrade（现存安全路径不回归）", async () => {
    const trip = customAliasTrip();
    const official = makePoi("2603", OFFICIAL, { address: "海南省三亚市吉阳区吉阳镇亚龙湾" });
    const area = makePoi("2757", "亚龙湾");
    await assembleEntries(trip, [makeEntry(ALIAS)], makeEvidence("ev_ok"), "ev_ok", [], new Map(), {
      aligner: async () => alignmentOf(area, [area, official]),
    });
    const item = trip.itemRegistry[ITEM_FOREST]!;
    eq(item.origin, "fliggy");
    eq(item.providerId, "2603");
    eq(item.name, ALIAS, "攻略原文名不变");
    eq(item.address, "海南省三亚市吉阳区吉阳镇亚龙湾", "供应商字段以命中 POI 为准");
    eq(item.sourceEvidenceRefs, ["ev_old", "ev_ok"]);
  });

  // ---------- D. 在线装配幂等 ----------
  await test("D1 重复装配幂等：第二次不搜索、字段零变更", async () => {
    const trip = customAliasTrip();
    const official = makePoi("2603", OFFICIAL);
    await assembleEntries(trip, [makeEntry(ALIAS)], makeEvidence("ev_1"), "ev_1", [], new Map(), {
      aligner: async () => alignmentOf(official),
    });
    const afterFirst = snapshot(trip.itemRegistry[ITEM_FOREST]);

    let alignCalls = 0;
    await assembleEntries(trip, [makeEntry(ALIAS)], makeEvidence("ev_2"), "ev_2", [], new Map(), {
      aligner: async () => {
        alignCalls += 1;
        throw new Error("已是 fliggy，不应再次搜索");
      },
    });
    eq(alignCalls, 0, "升级后命中既有 fliggy，跳过搜索");
    const afterSecond = trip.itemRegistry[ITEM_FOREST]!;
    eq(afterSecond.providerId, "2603");
    eq(afterSecond.origin, "fliggy");
    eq(afterSecond.sourceEvidenceRefs, ["ev_old", "ev_1", "ev_2"], "证据引用幂等追加");
    eq(snapshot({ ...afterSecond, sourceEvidenceRefs: [] }), snapshot({ ...(afterFirst as Item), sourceEvidenceRefs: [] }), "供应商字段零变更");
  });

  // ---------- E. 修复脚本 ----------
  await test("E1 简称成功、正式名超时 → search-error 且保持 custom", async () => {
    const trip = customAliasTrip();
    const before = snapshot(trip.itemRegistry[ITEM_FOREST]);
    const plans = await evaluateTrip(trip, async () => ({
      pois: [makePoi("2603", OFFICIAL)],
      queries: ["三亚 亚龙湾森林公园", "三亚 亚龙湾热带天堂森林公园"],
      error: "第二查询超时（90000ms）",
    }));
    eq(plans.length, 1);
    eq(plans[0]?.status, "search-error", "任一搜索轮次失败必须 search-error");
    ok((plans[0]?.note ?? "").includes("90000ms"), "错误原文必须进报告");
    eq(plans[0]?.providerId, null);
    eq(snapshot(trip.itemRegistry[ITEM_FOREST]), before, "dry-run 推演不得修改行程");
  });

  await test("E2 全部成功唯一命中 → upgrade；重复评估同结论且无副作用", async () => {
    const trip = customAliasTrip();
    const before = snapshot(trip);
    const searcher = async () => ({
      pois: [makePoi("2603", OFFICIAL), makePoi("2757", "亚龙湾海滩")],
      queries: ["三亚 亚龙湾森林公园", "三亚 亚龙湾热带天堂森林公园"],
      error: null,
    });
    const first = await evaluateTrip(trip, searcher);
    const second = await evaluateTrip(trip, searcher);
    eq(first[0]?.status, "upgrade");
    eq(first[0]?.providerId, "2603");
    eq(second[0]?.status, "upgrade", "重复评估结论一致（幂等）");
    eq(snapshot(trip), before, "评估阶段不得写盘 / 改行程");
  });

  await test("E3 多义 / 占用场景脚本同样不升级", async () => {
    const trip = customAliasTrip();
    const multi = await evaluateTrip(trip, async () => ({
      pois: [makePoi("9001", OFFICIAL), makePoi("9002", OFFICIAL)],
      queries: ["三亚 亚龙湾森林公园"],
      error: null,
    }));
    eq(multi[0]?.status, "ambiguous");

    trip.itemRegistry.occupier = makeItem({
      itemId: "occupier",
      name: "占位点位",
      origin: "fliggy",
      providerId: "2603",
    });
    const occupied = await evaluateTrip(trip, async () => ({
      pois: [makePoi("2603", OFFICIAL)],
      queries: ["三亚 亚龙湾森林公园"],
      error: null,
    }));
    eq(occupied[0]?.status, "occupied");
    eq(trip.itemRegistry[ITEM_FOREST]!.origin, "custom");
  });

  // ---------- F. 真实 Trip 只读校验 ----------
  await test("F1 真实 Trip：providerId=2603 唯一、数据不变量不变、文件字节未变", async () => {
    const realTripId = "48275e19-c7cb-417b-8ef7-57b04e097cf4";
    const filePath = path.join(import.meta.dirname, "../../data", `${realTripId}.json`);
    const hashOf = async (): Promise<string> =>
      crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
    const hashBefore = await hashOf();
    const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as Trip;

    const trip = await tripStore.load(realTripId);
    ok(trip !== null, "真实行程应可读取");
    if (trip === null) return;

    // 1. 升级结果仍在且唯一
    const holders = Object.values(trip.itemRegistry).filter((item) => item.providerId === "2603");
    eq(holders.length, 1, "providerId=2603 必须唯一");
    const forest = holders[0]!;
    eq(forest.name, ALIAS, "名称保持攻略原文");
    eq(forest.origin, "fliggy", "已完成安全升级");
    eq(forest.address, "海南省三亚市吉阳区吉阳镇亚龙湾");

    // 2. 与磁盘原件逐字段一致（本次未重写升级结果）
    const rawForest = (raw.itemRegistry as Record<string, Item>)[forest.itemId];
    ok(rawForest !== undefined, "磁盘原件应含该 Item");
    eq(forest.itemId, rawForest!.itemId);
    eq(forest.name, rawForest!.name);
    eq(forest.providerId, rawForest!.providerId);
    eq(forest.origin, rawForest!.origin);
    eq(forest.sourceEvidenceRefs, rawForest!.sourceEvidenceRefs, "证据引用不得变化");
    eq(forest.suggestMinutes, rawForest!.suggestMinutes, "时长不得变化");

    // 3. 全库 providerId 不重复（升级的核心不变量）
    const seen = new Map<string, string>();
    for (const item of Object.values(trip.itemRegistry)) {
      if (item.providerId === null) continue;
      eq(seen.get(item.providerId) ?? item.itemId, item.itemId, `providerId ${item.providerId} 不得重复`);
      seen.set(item.providerId, item.itemId);
    }

    // 4. 集合 / 引用完整性不变量
    eq(Object.keys(trip.itemRegistry).sort(), Object.keys(raw.itemRegistry).sort(), "Item 集合不得变化");
    eq(Object.keys(trip.visits).sort(), Object.keys(raw.visits).sort(), "Visit 集合不得变化");
    eq(Object.keys(trip.stops).sort(), Object.keys(raw.stops).sort(), "Stop 集合不得变化");
    eq(Object.keys(trip.days).sort(), Object.keys(raw.days).sort(), "Day 集合不得变化");
    for (const visit of Object.values(trip.visits)) {
      ok(trip.itemRegistry[visit.pointRef] !== undefined, `Visit ${visit.visitId} 的 pointRef 必须有效`);
    }
    for (const stop of Object.values(trip.stops)) {
      if (stop.matchedPointRef === null) continue;
      ok(trip.itemRegistry[stop.matchedPointRef] !== undefined, `Stop ${stop.stopId} 的 matchedPointRef 必须有效`);
    }
    for (const day of Object.values(trip.days)) {
      for (const visitId of day.scheduleVisitRefs) {
        ok(trip.visits[visitId] !== undefined, `Day ${day.dayId} 的 scheduleVisitRef 必须有效`);
      }
    }
    eq(validateConsistency(trip), [], "真实行程必须仍通过一致性校验");

    // 5. 幂等：没有待修复项（重复执行 fix-task249 找不到任何 custom 别名 Item）
    const pending = listAliasCustomItems(trip);
    eq(pending, [], "已安全升级的 Item 不得再次进入修复范围");
    let searched = 0;
    const plans = await evaluateTrip(trip, async () => {
      searched += 1;
      throw new Error("不应触发任何搜索");
    });
    eq(plans, [], "重复执行脚本应为空操作");
    eq(searched, 0, "无候选时不得触网");

    // 6. 文件字节未变化（只读校验，不写盘）
    eq(await hashOf(), hashBefore, "真实行程文件不得被改动");
  });

  // ---------- 汇总 ----------
  const failures = results.filter((result) => result.error !== null);
  for (const result of results) {
    console.log(
      `${result.error === null ? "PASS" : "FAIL"}  ${result.label}${result.error === null ? "" : `：${result.error}`}`,
    );
  }
  console.log(`\n[VERIFY-254] ${results.length - failures.length}/${results.length} 通过`);
  if (failures.length > 0) {
    throw new Error(`Task #254 验收失败 ${failures.length} 项：${failures.map((failure) => failure.label).join("，")}`);
  }
}

main().catch((error: unknown) => {
  console.error("[VERIFY-254] 验收脚本失败：", error);
  process.exitCode = 1;
});
