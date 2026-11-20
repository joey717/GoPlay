/**
 * Task #233 景点显式别名端到端验证（离线：不调用百炼 / FlyAI / 小红书）。
 *
 * 问题现场：攻略写简称「亚龙湾森林公园」，飞猪官方名是「亚龙湾热带天堂森林公园」。
 * 两者没有子串包含关系，既有的「归一化全等 / 整体双向包含」都命不中，抽取装配
 * 只好把它降级成 custom 点位，攻略提及与官方候选从此对不上（server/data 实测：
 * 同一趟行程里既有 custom「亚龙湾森林公园」大景区，又有 fliggy「亚龙湾海滩」）。
 *
 * 验证矩阵：
 *   S1 单一数据源：别名表只有一份（@goplay/shared poiAlias），两个简称都映射到
 *      同一个正式名；正式名不再作为别名键（单跳解析无链）。
 *   S2 保守归一化：空白 / 成对括号 / 已知城市前缀被吸收；「三亚湾」不被剥成泛化词
 *      「湾」；「亚龙湾」「亚龙湾海滩」「亚龙湾森林公园」三个对齐键互不相同。
 *   S3 飞猪 POI 召回（findBestMatch）：两个简称都命中官方 POI；官方名精确匹配不回归；
 *      「亚龙湾海滩」不命中森林公园；精确同名 POI 优先于包含匹配。
 *   S4 搜索查询计划（成本边界）：仅别名追加正式名二次检索，其余名称永远单条查询。
 *   S5 实体对齐链路（mergeGuideMentions）：未对齐的简称提及并入已对齐的官方
 *      地点；两篇攻略分别写简称 / 全称时归为同一地点；海滩与森林公园不串。
 *   S6 Item / Visit 复用：官方名已有 fliggy Item / Visit 时，简称直接复用，
 *      不再新建 custom 重复点位，内部玩法挂到官方 Visit。
 *   S7 口径边界：planner 快速路径与 directives 仍用基础归一化（同名重复实体
 *      「全等 > 整体包含」的平局规则不被别名折叠成歧义）。
 *
 * 运行：npx tsx server/src/ai/verify-task233.ts
 */

import assert from "node:assert/strict";
import type { Day, GuideSource, Item, SourceEvidence, Trip, Visit } from "@goplay/shared";
import {
  canonicalPoiMatchKey,
  createEmptyGuideImageProgress,
  isPoiAlias,
  isSameCanonicalPoiName,
  normalizePoiNameBase,
  POI_ALIAS_MAP,
  resolvePoiAlias,
} from "@goplay/shared";
import type { FlyAIPoi } from "../flyai/client.js";
import {
  findBestMatch,
  findExistingFliggyItem,
  findReusableItem,
  findVisitByItemName,
  normalizePoiName,
  planPoiSearchQueries,
} from "./assemble.js";
import { mergeGuideMentions } from "../guides/merge.js";

function pass(name: string): void {
  console.log(`✓ ${name}`);
}

const OFFICIAL = "亚龙湾热带天堂森林公园";
const ALIAS_SHORT = "亚龙湾森林公园";
const ALIAS_MID = "亚龙湾热带森林公园";
const BEACH = "亚龙湾海滩";

// ===== S1 单一数据源 =====

// 表的键是「基础归一化 + 去城市前缀」后的简称，值是归一化后的正式名
assert.equal(POI_ALIAS_MAP.get(normalizePoiNameBase(ALIAS_SHORT)), OFFICIAL);
assert.equal(POI_ALIAS_MAP.get(normalizePoiNameBase(ALIAS_MID)), OFFICIAL);
assert.ok(POI_ALIAS_MAP.size >= 2, "首批至少两条别名");
for (const canonical of new Set(POI_ALIAS_MAP.values())) {
  assert.equal(
    POI_ALIAS_MAP.has(canonical.toLowerCase()),
    false,
    `正式名「${canonical}」不得再作为别名键（单跳解析，禁止链式）`,
  );
}
assert.equal(isPoiAlias(ALIAS_SHORT), true);
assert.equal(isPoiAlias(ALIAS_MID), true);
assert.equal(isPoiAlias(OFFICIAL), false);
assert.equal(isPoiAlias(BEACH), false);
pass("S1 别名表单一数据源：两个简称 → 官方名，正式名非别名键");

// ===== S2 保守归一化 =====

assert.equal(resolvePoiAlias(" 亚龙湾 森林公园 "), OFFICIAL, "空白不阻碍别名命中");
assert.equal(resolvePoiAlias("亚龙湾森林公园（含门票）"), OFFICIAL, "成对括号说明被吸收");
assert.equal(resolvePoiAlias("三亚亚龙湾森林公园"), OFFICIAL, "已知城市前缀被吸收");
assert.equal(resolvePoiAlias(ALIAS_MID), OFFICIAL);
assert.equal(resolvePoiAlias(OFFICIAL), OFFICIAL, "正式名幂等");
assert.equal(resolvePoiAlias("三亚亚龙湾热带天堂森林公园"), OFFICIAL, "官方名带城市前缀同样归位");

// 保守边界：城市前缀剥离不得把可辨识名称砸成泛化词
assert.equal(normalizePoiNameBase("三亚湾"), "三亚湾");
assert.equal(canonicalPoiMatchKey("三亚湾"), "三亚湾", "「三亚湾」不得被剥成「湾」");
assert.equal(canonicalPoiMatchKey("三亚千古情"), "三亚千古情", "剥离后主体不足 4 字不剥");

// 三个名称必须保持可区分（别名不做共享子串 / 编辑距离匹配）
const keys = [canonicalPoiMatchKey("亚龙湾"), canonicalPoiMatchKey(BEACH), canonicalPoiMatchKey(ALIAS_SHORT)];
assert.equal(new Set(keys).size, 3, `三个名称的对齐键应互不相同（实际 ${JSON.stringify(keys)}）`);
assert.equal(resolvePoiAlias("亚龙湾"), "亚龙湾");
assert.equal(resolvePoiAlias(BEACH), BEACH);
pass("S2 保守归一化：空白/括号/城市前缀，三亚湾与亚龙湾海滩不被误折叠");

// ===== S3 飞猪 POI 召回 =====

function poi(name: string): FlyAIPoi {
  return {
    id: `poi_${name}`,
    name,
    address: null,
    category: null,
    description: null,
    freePoiStatus: null,
    poiLevel: null,
    coords: null,
    mainPic: null,
    listRank: null,
    ticketInfo: null,
    jumpUrl: null,
  };
}

const parkPoi = poi(OFFICIAL);
assert.equal(findBestMatch(ALIAS_SHORT, [parkPoi])?.id, parkPoi.id, "简称应召回官方点位");
assert.equal(findBestMatch(ALIAS_MID, [parkPoi])?.id, parkPoi.id, "缺「天堂」的简称应召回官方点位");
assert.equal(findBestMatch(OFFICIAL, [parkPoi])?.id, parkPoi.id, "官方名精确匹配不回归");
assert.equal(findBestMatch(`${OFFICIAL}（4A）`, [parkPoi])?.id, parkPoi.id, "括号说明不回归");
assert.equal(findBestMatch(BEACH, [parkPoi]), undefined, "亚龙湾海滩不得误匹配森林公园");
assert.equal(findBestMatch("亚龙湾", [poi("亚龙湾"), parkPoi])?.name, "亚龙湾", "精确同名优先于包含匹配");
assert.equal(findBestMatch("蜈支洲岛", [poi("蜈支洲岛")])?.name, "蜈支洲岛", "普通精确匹配不回归");
pass("S3 findBestMatch：两个简称召回官方 POI，海滩不误匹配，精确匹配不回归");

// ===== S4 搜索查询计划（别名召回成本边界） =====

assert.deepEqual(planPoiSearchQueries("三亚", ALIAS_SHORT), [`三亚 ${ALIAS_SHORT}`, `三亚 ${OFFICIAL}`]);
assert.deepEqual(planPoiSearchQueries("", ALIAS_SHORT), [ALIAS_SHORT, OFFICIAL]);
assert.deepEqual(planPoiSearchQueries("三亚", OFFICIAL), [`三亚 ${OFFICIAL}`], "正式名不追加查询");
assert.deepEqual(planPoiSearchQueries("三亚", BEACH), [`三亚 ${BEACH}`], "非别名不追加查询");
pass("S4 planPoiSearchQueries：仅别名追加正式名检索，其余名称零额外网络成本");

// ===== 行程夹具 =====

function makeItem(
  itemId: string,
  name: string,
  opts?: { origin?: "fliggy" | "custom"; providerId?: string | null; evidenceRefs?: string[] },
): Item {
  return {
    itemId,
    name,
    origin: opts?.origin ?? "custom",
    providerId: opts?.providerId ?? null,
    address: null,
    category: null,
    coords: null,
    suggestMinutes: 180,
    mainPic: null,
    ticketInfo: null,
    jumpUrl: null,
    sourceEvidenceRefs: opts?.evidenceRefs ?? [],
  };
}

function makeVisit(
  visitId: string,
  pointRef: string,
  kind: Visit["kind"],
  opts?: { dayRef?: string | null; sourceMentionRefs?: string[] },
): Visit {
  return {
    visitId,
    dayRef: opts?.dayRef ?? null,
    pointRef,
    kind,
    visitMode: kind === "large_attraction" ? "full_day" : "custom",
    order: null,
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
    sourceMentionRefs: opts?.sourceMentionRefs ?? [],
    purchaseState: "unknown",
    locked: false,
    userAdjusted: false,
    removedFrom: null,
    removedAt: null,
  };
}

function makeMention(mentionId: string, name: string): SourceEvidence["mentions"][number] {
  return {
    mentionId,
    text: name,
    quoteText: `${name}：山顶看海，含过江龙索桥。`,
    bbox: null,
    extractedName: name,
    locationHint: null,
    modelSummary: `【桩】${name}`,
    claimKind: "experience",
    targetScope: "place",
    firsthand: true,
    relationEvidence: null,
  };
}

function makeEvidence(evidenceId: string, names: Array<[mentionId: string, name: string]>): SourceEvidence {
  return {
    evidenceId,
    kind: "note_text",
    noteIndex: 1,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions: names.map(([mentionId, name]) => makeMention(mentionId, name)),
  };
}

function makeSource(sourceId: string, evidenceIds: string[], mentionRefs: string[]): GuideSource {
  return {
    sourceId,
    sourceVersion: 1,
    inputKind: "text",
    title: `来源 ${sourceId}`,
    active: true,
    status: "ready",
    evidenceRefs: evidenceIds,
    mentionRefs,
    imageProgress: createEmptyGuideImageProgress(),
    importedAt: "2026-10-26T08:00:00.000Z",
    updatedAt: "2026-10-26T08:00:00.000Z",
  };
}

function makeDay(dayId: string, dayIndex: number, scheduleVisitRefs: string[]): Day {
  return {
    dayId,
    dayIndex,
    date: `2026-11-0${dayIndex}`,
    departTime: null,
    departTimeOverridden: false,
    scheduleVisitRefs,
    lodging: null,
  };
}

function makeTrip(inject: (trip: Trip) => void): Trip {
  const trip: Trip = {
    tripId: "trip_task233",
    version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-01", end: "2026-11-02", nights: 1 },
    dayRefs: ["day_1"],
    days: { day_1: makeDay("day_1", 1, ["visit_park", "visit_beach"]) },
    lodgings: {},
    itemRegistry: {},
    hotelRegistry: {},
    visits: {},
    stops: {},
    evidences: {},
    globalCandidateRefs: [],
    pendingStopRefs: [],
    relationshipSuggestions: {},
    guideSources: {},
    constraints: [],
    createdAt: "2026-10-26T08:00:00.000Z",
    updatedAt: "2026-10-26T08:00:00.000Z",
  };
  inject(trip);
  return trip;
}

/** 官方名大景区 Visit + 海滩 Visit（含精确提及归属） */
function parkTrip(): Trip {
  return makeTrip((trip) => {
    trip.itemRegistry["item_park"] = makeItem("item_park", OFFICIAL, {
      origin: "fliggy",
      providerId: "fp_park",
      evidenceRefs: ["ev_official"],
    });
    trip.itemRegistry["item_beach"] = makeItem("item_beach", BEACH, {
      origin: "fliggy",
      providerId: "fp_beach",
      evidenceRefs: ["ev_short"],
    });
    trip.visits["visit_park"] = makeVisit("visit_park", "item_park", "large_attraction", {
      dayRef: "day_1",
      sourceMentionRefs: ["ev_official:m1"],
    });
    trip.visits["visit_beach"] = makeVisit("visit_beach", "item_beach", "ordinary", {
      dayRef: "day_1",
      sourceMentionRefs: ["ev_short:m2"],
    });
    trip.evidences["ev_official"] = makeEvidence("ev_official", [["m1", OFFICIAL]]);
    trip.evidences["ev_short"] = makeEvidence("ev_short", [
      ["m1", ALIAS_SHORT],
      ["m2", BEACH],
    ]);
    trip.guideSources = {
      src_1: makeSource("src_1", ["ev_official", "ev_short"], [
        "ev_official:m1",
        "ev_short:m1",
        "ev_short:m2",
      ]),
    };
  });
}

// ===== S5 merge：攻略提及 → 地点对齐 =====

{
  const merge = mergeGuideMentions(parkTrip());
  const parkPlace = merge.places.find((place) => place.providerId === "fp_park");
  assert.ok(parkPlace !== undefined, "应存在官方森林公园地点");
  assert.deepEqual(parkPlace.entityRef, { kind: "visit", id: "visit_park" });
  assert.equal(parkPlace.displayName, OFFICIAL, "展示名沿用实体主数据，不改写简称原文");
  assert.equal(parkPlace.mentions.length, 2, "简称提及应并入官方地点，而不是另起一条");
  assert.deepEqual(
    parkPlace.mentions.map((entry) => entry.ref).sort(),
    ["ev_official:m1", "ev_short:m1"],
    "两条提及都要保留可溯源 ref",
  );
  const beachPlace = merge.places.find((place) => place.providerId === "fp_beach");
  assert.ok(beachPlace !== undefined);
  assert.equal(beachPlace.mentions.length, 1, "海滩不得被森林公园的别名吞并");
  assert.equal(merge.places.length, 2, `地点数应为 2（实际 ${merge.places.length}）`);

  // 未对齐场景：两篇攻略分别写简称 / 全称 → 同一地点（n: 键同名去重）
  const unaligned = makeTrip((trip) => {
    trip.evidences["ev_a"] = makeEvidence("ev_a", [["m1", ALIAS_SHORT]]);
    trip.evidences["ev_b"] = makeEvidence("ev_b", [["m1", OFFICIAL]]);
    trip.guideSources = {
      src_a: makeSource("src_a", ["ev_a"], ["ev_a:m1"]),
      src_b: makeSource("src_b", ["ev_b"], ["ev_b:m1"]),
    };
  });
  const unalignedMerge = mergeGuideMentions(unaligned);
  assert.equal(unalignedMerge.places.length, 1, "简称 / 全称两篇攻略应归为同一地点");
  assert.equal(unalignedMerge.places[0]?.mentions.length, 2);
  assert.equal(unalignedMerge.places[0]?.entityRef, null, "未对齐地点不伪造实体");
  pass("S5 merge：简称提及并入官方地点；跨攻略简称/全称不裂条；海滩不串");
}

// ===== S6 Item / Visit 复用 =====

{
  const trip = parkTrip();
  const officialItem = trip.itemRegistry["item_park"];
  assert.equal(findExistingFliggyItem(trip, ALIAS_SHORT), officialItem, "官方 fliggy Item 应被简称复用");
  assert.equal(findExistingFliggyItem(trip, ALIAS_MID), officialItem);
  assert.equal(findExistingFliggyItem(trip, BEACH)?.itemId, "item_beach", "海滩只命中自己");
  assert.equal(findReusableItem(trip, { name: ALIAS_SHORT }, null), officialItem, "ensureItem 复用同一口径");
  assert.equal(findVisitByItemName(trip, ALIAS_SHORT)?.visitId, "visit_park", "内部玩法应挂到官方 Visit");
  assert.equal(findVisitByItemName(trip, ALIAS_MID)?.visitId, "visit_park");
  assert.equal(findVisitByItemName(trip, BEACH)?.visitId, "visit_beach");
  // 「亚龙湾」不在别名表：Item 精确 / 别名口径下不指向森林公园。
  // （findVisitByItemName 的整体包含降级是 #233 之前就有的规则，本次未放宽也未收紧，
  //   真实召回时精确同名 POI 优先，见 S3。）
  assert.equal(findExistingFliggyItem(trip, "亚龙湾"), undefined, "「亚龙湾」不命中森林公园 Item");
  assert.notEqual(canonicalPoiMatchKey("亚龙湾"), canonicalPoiMatchKey(ALIAS_SHORT));
  pass("S6 复用：官方 Item / Visit 被简称复用，海滩与「亚龙湾」不误挂");
}

// ===== S7 口径边界：planner/directives 基础归一化不变 =====

assert.equal(normalizePoiName(ALIAS_SHORT), ALIAS_SHORT, "基础归一化不折叠别名（快速路径平局规则保持）");
assert.notEqual(
  normalizePoiName(ALIAS_SHORT),
  normalizePoiName(OFFICIAL),
  "同名重复实体仍可被「全等 > 整体包含」唯一收敛（#193 行为不回归）",
);
pass("S7 边界：planner 快速路径 / directives 的基础归一化口径未改动");

// ===== S8 Task #286 回归：亚龙湾山顶打卡点别名折叠（A13 硬绿对应） =====

{
  // PD 2026-10-28 裁定：山顶婚礼草坪==婚礼礼堂大草坪（同一打卡点），属山顶公园范围 → 全归「山顶公园」
  const CANON = "山顶公园";
  const LAWN_A = "山顶婚礼草坪";
  const LAWN_B = "婚礼礼堂大草坪";

  // 别名表单跳解析：两个打卡点串都归到 canonical，正式名本身不再是别名键（无链式）
  assert.equal(resolvePoiAlias(LAWN_A), CANON, "「山顶婚礼草坪」应归一到「山顶公园」");
  assert.equal(resolvePoiAlias(LAWN_B), CANON, "「婚礼礼堂大草坪」应归一到「山顶公园」");
  assert.equal(resolvePoiAlias(CANON), CANON, "正式名幂等");
  assert.equal(isPoiAlias(LAWN_A), true);
  assert.equal(isPoiAlias(LAWN_B), true);
  assert.equal(isPoiAlias(CANON), false, "「山顶公园」不得再作别名键（单跳解析）");
  assert.equal(POI_ALIAS_MAP.get(normalizePoiNameBase(LAWN_A)), CANON);
  assert.equal(POI_ALIAS_MAP.get(normalizePoiNameBase(LAWN_B)), CANON);

  // 对齐键折叠：三表面串同一 canonicalPoiMatchKey
  const keys = [canonicalPoiMatchKey(CANON), canonicalPoiMatchKey(LAWN_A), canonicalPoiMatchKey(LAWN_B)];
  assert.equal(new Set(keys).size, 1, `三表面串应对齐到同一键（实际 ${JSON.stringify(keys)}）`);
  assert.equal(isSameCanonicalPoiName(LAWN_A, LAWN_B), true, "两个打卡点串互为同一实体");
  assert.equal(isSameCanonicalPoiName(LAWN_A, CANON), true);

  // 聚合层：三篇攻略分别写三表面串 → mergeGuideMentions 折叠为同一地点（A13 alias_gap 硬绿对应）
  const trip = makeTrip((t) => {
    t.evidences["ev_park"] = makeEvidence("ev_park", [["m1", CANON]]);
    t.evidences["ev_lawn_a"] = makeEvidence("ev_lawn_a", [["m1", LAWN_A]]);
    t.evidences["ev_lawn_b"] = makeEvidence("ev_lawn_b", [["m1", LAWN_B]]);
    t.guideSources = {
      src_park: makeSource("src_park", ["ev_park"], ["ev_park:m1"]),
      src_lawn_a: makeSource("src_lawn_a", ["ev_lawn_a"], ["ev_lawn_a:m1"]),
      src_lawn_b: makeSource("src_lawn_b", ["ev_lawn_b"], ["ev_lawn_b:m1"]),
    };
  });
  const merged = mergeGuideMentions(trip);
  assert.equal(merged.places.length, 1, `三表面串应折叠为同一地点（实际 ${merged.places.length}）`);
  assert.equal(merged.places[0]?.mentions.length, 3, "三条提及都并入同一地点，票数合并不散");

  // 边界：亚龙湾既有别名与沧海观景台不受本次补条影响（不串）
  assert.notEqual(canonicalPoiMatchKey(LAWN_A), canonicalPoiMatchKey(ALIAS_SHORT));
  assert.notEqual(canonicalPoiMatchKey("沧海观景台"), canonicalPoiMatchKey(LAWN_A));
  pass("S8 Task #286：山顶婚礼草坪/婚礼礼堂大草坪→山顶公园 别名折叠（resolvePoiAlias+merge 三串归一）");
}

console.log("\nTask #233 景点显式别名验证全部通过");
