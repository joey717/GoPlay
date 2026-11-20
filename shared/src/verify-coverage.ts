/**
 * Task #282 稀疏攻略覆盖估算验证脚本 —— estimateGuideCoverage 全矩阵（C1/C2/C3 口径）。
 *
 * 运行：npx tsx src/verify-coverage.ts（shared 目录下）
 *
 * 覆盖场景：
 *  1. C1 稀疏：1 篇素材 2 个点位 ＋ 5 天行程 → 缺口成立、可支撑 1 天、不抑制；
 *  2. 素材充足：7 个点位 ＋ 5 天行程 → 无缺口（多源共享草案不误澄清）；
 *  3. 已排天数直接计入：素材对齐 2 天 ＋ 4 天行程 → 无缺口（边界 2 = 4×0.5 不成立）；
 *  4. C2 抑制：缺口成立但其余天为「锚点天 ＋ 锁定/已购填满」→ suppressed=true；
 *  5. C2 不抑制：其余天存在未锁定内容 → suppressed=false；
 *  6. 空白天不算已填满（无锁定内容可抑制）→ suppressed=false；
 *  7. 单天行程不澄清；
 *  8. 同名去重：未对齐地点与既有实体同名不重复计；
 *  9. 纯函数：不修改入参 Trip；
 * 10. enrichmentAnchored（Task #294）：真稀疏 false / 对齐或同名命中已排天 true，既有口径不变。
 */

import assert from "node:assert/strict";
import type { Constraint, Day, Item, Stop, Trip, Visit } from "./types/index.js";
import { SCHEMA_VERSION } from "./types/index.js";
import { estimateGuideCoverage, type CoveragePlaceRef } from "./guides/coverageEstimate.js";

// ===== 最小 Trip 构建工具 =====

function makeDay(dayIndex: number, scheduleVisitRefs: string[] = []): Day {
  return {
    dayId: `day_${dayIndex}`,
    dayIndex,
    date: `2026-11-${String(dayIndex).padStart(2, "0")}`,
    departTime: null,
    departTimeOverridden: false,
    scheduleVisitRefs,
    lodging: null,
  };
}

function makeItem(itemId: string, name: string): Item {
  return {
    itemId,
    name,
    origin: "fliggy",
    providerId: itemId,
    address: null,
    category: null,
    coords: null,
    suggestMinutes: 120,
    mainPic: null,
    ticketInfo: null,
    jumpUrl: null,
    sourceEvidenceRefs: [],
  };
}

function makeVisit(
  visitId: string,
  pointRef: string,
  dayRef: string | null,
  options: { locked?: boolean; purchaseState?: Visit["purchaseState"]; order?: number | null } = {},
): Visit {
  return {
    visitId,
    dayRef,
    pointRef,
    kind: "ordinary",
    visitMode: "custom",
    order: options.order ?? (dayRef === null ? null : 0),
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
    purchaseState: options.purchaseState ?? "unknown",
    locked: options.locked ?? false,
    userAdjusted: false,
    removedFrom: null,
    removedAt: null,
  };
}

function makeStop(stopId: string, visitRef: string | null, suggestedVisitRef: string | null): Stop {
  return {
    stopId,
    state: visitRef === null ? "pending" : "attached",
    visitRef,
    suggestedVisitRef,
    matchedPointRef: null,
    customName: visitRef === null ? stopId : null,
    order: visitRef === null ? null : 0,
    suggestMinutes: 60,
    locationHint: null,
    ticketRelation: "unknown",
    sourceEvidenceRefs: [],
    sourceMentionRefs: [],
    userAdjusted: false,
    removedFromOrder: null,
    removedAt: null,
  };
}

function makeConstraint(type: Constraint["type"], dayIndex: number): Constraint {
  return {
    constraintId: `c_${type}_${dayIndex}`,
    type,
    anchorTime: `2026-11-${String(dayIndex).padStart(2, "0")}T10:00:00`,
    dayIndex,
    label: `${type} day${dayIndex}`,
    locked: true,
  };
}

/** 标准 5 天验收骨架：Day1 抵达、Day5 返程、Day2 有 visit_wzz（未锁定） */
function makeTrip(totalDays: number): Trip {
  const dayRefs: string[] = [];
  const days: Record<string, Day> = {};
  for (let index = 1; index <= totalDays; index++) {
    const dayId = `day_${index}`;
    dayRefs.push(dayId);
    days[dayId] = makeDay(index, index === 2 ? ["visit_wzz"] : []);
  }
  return {
    tripId: "trip_verify_coverage",
    schemaVersion: SCHEMA_VERSION,
    version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-01", end: `2026-11-${String(totalDays).padStart(2, "0")}`, nights: totalDays - 1 },
    dayRefs,
    days,
    lodgings: {},
    hotelRegistry: {},
    guideSources: {},
    itemRegistry: { item_wzz: makeItem("item_wzz", "蜈支洲岛") },
    visits: { visit_wzz: makeVisit("visit_wzz", "item_wzz", "day_2") },
    stops: {},
    evidences: {},
    globalCandidateRefs: [],
    pendingStopRefs: [],
    relationshipSuggestions: {},
    constraints: [makeConstraint("flight_arrive", 1), makeConstraint("flight_depart", totalDays)],
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-28T00:00:00.000Z",
  };
}

/** 未对齐素材地点（装配已建实体但未写归属 / 与既有实体同名合并） */
function unattached(displayName: string): CoveragePlaceRef {
  return { entityRef: null, displayName };
}

// ===== §1 C1 稀疏：1 篇 2 点位 ＋ 5 天行程 =====

{
  const trip = makeTrip(5);
  const gap = estimateGuideCoverage(trip, [unattached("西岛"), unattached("椰梦长廊")]);
  assert.equal(gap.totalDayCount, 5, "§1: 行程 5 天");
  assert.equal(gap.unscheduledUnitCount, 2, "§1: 素材点位 2 个");
  assert.equal(gap.coveredDayCount, 1, "§1: 可支撑 1 天（2 点位 ÷ 2）");
  assert.equal(gap.hasGap, true, "§1: 1 < 5×0.5 → 缺口成立");
  assert.equal(gap.suppressed, false, "§1: Day2 有未锁定内容 → 不抑制");
  console.log("§1 C1 稀疏缺口 pass（可支撑 1/5 天，触发澄清）");
}

// ===== §2 素材充足：7 点位 ＋ 5 天 → 无缺口 =====

{
  const trip = makeTrip(5);
  const places: CoveragePlaceRef[] = [
    { entityRef: { kind: "stop", id: "stop_sea" }, displayName: "下海游泳" },
    { entityRef: { kind: "stop", id: "stop_view" }, displayName: "牛王岭" },
    unattached("西岛"),
    unattached("椰梦长廊"),
    unattached("亚龙湾海滩"),
    unattached("蜈支洲岛"),
    unattached("后海村"),
  ];
  trip.stops = {
    stop_sea: makeStop("stop_sea", null, null),
    stop_view: makeStop("stop_view", null, "visit_wzz"),
  };
  const gap = estimateGuideCoverage(trip, places);
  assert.equal(gap.scheduledDayCount, 1, "§2: stop_view 的建议父 visit_wzz 已排 Day2 → 已排 1 天");
  assert.equal(gap.unscheduledUnitCount, 5, "§2: 5 个未排素材点位（未对齐「蜈支洲岛」命中既有已排点位 → 归入 Day2 不重复计）");
  assert.equal(gap.coveredDayCount, 3, "§2: 可支撑 3 天（已排 1 ＋ ⌊5÷2⌋）");
  assert.equal(gap.hasGap, false, "§2: 3 ≥ 5×0.5 → 无缺口（多源素材不误澄清）");
  console.log("§2 素材充足无缺口 pass（3/5 天）");
}

// ===== §3 已排天数直接计入（边界：恰好一半不算缺口） =====

{
  const trip = makeTrip(4);
  trip.visits["visit_market"] = makeVisit("visit_market", "item_market", "day_3", { order: 0 });
  trip.itemRegistry["item_market"] = makeItem("item_market", "第一市场");
  trip.days["day_3"]!.scheduleVisitRefs = ["visit_market"];
  const places: CoveragePlaceRef[] = [
    { entityRef: { kind: "visit", id: "visit_wzz" }, displayName: "蜈支洲岛" },
    { entityRef: { kind: "visit", id: "visit_market" }, displayName: "第一市场" },
  ];
  const gap = estimateGuideCoverage(trip, places);
  assert.equal(gap.scheduledDayCount, 2, "§3: 素材已排 2 天（Day2/Day3）");
  assert.equal(gap.coveredDayCount, 2, "§3: 可支撑 2 天");
  assert.equal(gap.hasGap, false, "§3: 2 = 4×0.5 → 边界不算缺口");
  console.log("§3 已排天数计入 ＋ 半数边界 pass");
}

// ===== §4 C2 抑制：其余天＝锚点天 ＋ 锁定/已购填满 =====

{
  const trip = makeTrip(5);
  trip.itemRegistry["item_market"] = makeItem("item_market", "第一市场");
  trip.itemRegistry["item_yalong"] = makeItem("item_yalong", "亚龙湾海滩");
  trip.visits["visit_market"] = makeVisit("visit_market", "item_market", "day_3", { locked: true, order: 0 });
  trip.visits["visit_yalong"] = makeVisit("visit_yalong", "item_yalong", "day_4", { purchaseState: "bought", order: 0 });
  trip.days["day_3"]!.scheduleVisitRefs = ["visit_market"];
  trip.days["day_4"]!.scheduleVisitRefs = ["visit_yalong"];
  // 素材已排到 Day2（visit_wzz），另有 1 个未排点位
  const places: CoveragePlaceRef[] = [
    { entityRef: { kind: "visit", id: "visit_wzz" }, displayName: "蜈支洲岛" },
    unattached("西岛"),
  ];
  const gap = estimateGuideCoverage(trip, places);
  assert.equal(gap.scheduledDayCount, 1, "§4: 素材已排 Day2");
  assert.equal(gap.coveredDayCount, 1, "§4: 可支撑 1 天（1 个未排点位不足折算 1 天）");
  assert.equal(gap.hasGap, true, "§4: 缺口仍成立（1 < 5×0.5）");
  assert.equal(gap.suppressed, true, "§4: Day1/Day5 锚点、Day2 素材覆盖、Day3 锁定、Day4 已购 → 抑制");
  console.log("§4 C2 抑制 pass（其余天＝锚点＋锁定/已购填满）");
}

// ===== §5 C2 不抑制：其余天存在未锁定内容 =====

{
  const trip = makeTrip(5);
  trip.itemRegistry["item_market"] = makeItem("item_market", "第一市场");
  trip.visits["visit_market"] = makeVisit("visit_market", "item_market", "day_3", { locked: false, order: 0 });
  trip.days["day_3"]!.scheduleVisitRefs = ["visit_market"];
  const gap = estimateGuideCoverage(trip, [unattached("西岛"), unattached("椰梦长廊")]);
  assert.equal(gap.hasGap, true, "§5: 缺口成立");
  assert.equal(gap.suppressed, false, "§5: Day3 未锁定 → 不抑制（仍要澄清）");
  console.log("§5 C2 不抑制 pass（Day3 未锁定）");
}

// ===== §6 空白天不算已填满 =====

{
  const trip = makeTrip(5);
  // Day2 也腾空：其余天全是空白天，无锁定内容可抑制
  trip.days["day_2"]!.scheduleVisitRefs = [];
  trip.visits["visit_wzz"].dayRef = null;
  trip.visits["visit_wzz"].order = null;
  const gap = estimateGuideCoverage(trip, [unattached("西岛"), unattached("椰梦长廊")]);
  assert.equal(gap.hasGap, true, "§6: 缺口成立");
  assert.equal(gap.suppressed, false, "§6: 空白天无锁定内容 → 不抑制");
  console.log("§6 空白天不抑制 pass");
}

// ===== §7 单天行程不澄清 =====

{
  const trip = makeTrip(1);
  trip.constraints = [];
  const gap = estimateGuideCoverage(trip, [unattached("西岛")]);
  assert.equal(gap.hasGap, false, "§7: 单天行程无缺口");
  assert.equal(gap.suppressed, false, "§7: 单天行程无抑制语义");
  console.log("§7 单天行程 pass");
}

// ===== §8 同名去重：未对齐地点与既有实体同名不重复计 =====

{
  const trip = makeTrip(5);
  trip.stops = { stop_child: makeStop("stop_child", null, "visit_wzz") };
  const places: CoveragePlaceRef[] = [
    { entityRef: { kind: "visit", id: "visit_wzz" }, displayName: "蜈支洲岛" },
    unattached("蜈支洲岛"),
    { entityRef: { kind: "stop", id: "stop_child" }, displayName: "情人桥" },
  ];
  const gap = estimateGuideCoverage(trip, places);
  assert.equal(gap.scheduledDayCount, 1, "§8: visit_wzz 已排 Day2");
  assert.equal(gap.unscheduledUnitCount, 0, "§8: 同名「蜈支洲岛」不重复计；stop_child 归并到父 visit（已排）");
  assert.equal(gap.coveredDayCount, 1, "§8: 可支撑 1 天");
  assert.equal(gap.hasGap, true, "§8: 1 < 5×0.5 → 缺口成立");
  console.log("§8 同名去重 pass");
}

// ===== §9 纯函数：不修改入参 =====

{
  const trip = makeTrip(5);
  const snapshot = JSON.stringify(trip);
  estimateGuideCoverage(trip, [unattached("西岛"), unattached("椰梦长廊")]);
  assert.equal(JSON.stringify(trip), snapshot, "§9: estimateGuideCoverage 不得修改入参 Trip");
  console.log("§9 纯函数只读 pass");
}

// ===== §10 enrichmentAnchored：素材是否锚定既有已排天（Task #294，C1 触发收窄的判别信号） =====

{
  // 10a. 真稀疏（素材全是未落位新点位、已排天 0）→ 未锚定：C1 应照常触发
  const sparse = makeTrip(5);
  const sparseGap = estimateGuideCoverage(sparse, [unattached("西岛"), unattached("椰梦长廊")]);
  assert.equal(sparseGap.scheduledDayCount, 0, "§10a: 稀疏素材锚不到任何已排天");
  assert.equal(sparseGap.enrichmentAnchored, false, "§10a: 未锚定 → C1 稀疏澄清照常触发");
  assert.equal(sparseGap.hasGap, true, "§10a: hasGap 口径不变（与 §1 一致）");
  assert.equal(sparseGap.coveredDayCount, 1, "§10a: 可支撑天数口径不变");

  // 10b. 素材对齐既有已排实体（visit_wzz 在 Day2）→ 锚定：属 enrichment，不该打扰用户
  const anchored = makeTrip(5);
  const anchoredGap = estimateGuideCoverage(anchored, [
    { entityRef: { kind: "visit", id: "visit_wzz" }, displayName: "蜈支洲岛" },
    unattached("西岛"),
  ]);
  assert.equal(anchoredGap.scheduledDayCount, 1, "§10b: 素材命中已排 Day2");
  assert.equal(anchoredGap.enrichmentAnchored, true, "§10b: 已锚定既有排期 → 跳过 C1");

  // 10c. 未对齐但与既有已排点位同名（note_tip 归属后的 canonical 名）→ 同样算锚定
  const sameName = makeTrip(5);
  const sameNameGap = estimateGuideCoverage(sameName, [unattached("蜈支洲岛"), unattached("门票省钱")]);
  assert.equal(sameNameGap.scheduledDayCount, 1, "§10c: 同名命中既有已排点位 → 计入该天");
  assert.equal(sameNameGap.enrichmentAnchored, true, "§10c: 名称归属后应视为锚定既有排期");

  // 10d. 单天行程：无澄清语义，锚定信号恒 false（不早返回污染消费方）
  const single = makeTrip(1);
  single.constraints = [];
  assert.equal(estimateGuideCoverage(single, [unattached("西岛")]).enrichmentAnchored, false, "§10d: 单天行程不锚定");

  // 10e. C2 抑制场景（§4 同骨架）：锚定信号只读派生，不改 suppressed
  const suppressed = makeTrip(5);
  suppressed.days["day_3"]!.scheduleVisitRefs = ["visit_locked"];
  suppressed.days["day_4"]!.scheduleVisitRefs = ["visit_bought"];
  suppressed.visits["visit_locked"] = makeVisit("visit_locked", "item_locked", "day_3", { locked: true });
  suppressed.visits["visit_bought"] = makeVisit("visit_bought", "item_bought", "day_4", { purchaseState: "bought" });
  suppressed.itemRegistry["item_locked"] = makeItem("item_locked", "锁定景点");
  suppressed.itemRegistry["item_bought"] = makeItem("item_bought", "已购景点");
  const suppressedGap = estimateGuideCoverage(suppressed, [
    { entityRef: { kind: "visit", id: "visit_wzz" }, displayName: "蜈支洲岛" },
  ]);
  assert.equal(suppressedGap.hasGap, true, "§10e: 缺口仍成立");
  assert.equal(suppressedGap.suppressed, true, "§10e: C2 抑制语义不变");
  assert.equal(suppressedGap.enrichmentAnchored, true, "§10e: 锚定信号与 suppressed 并存");
  console.log("§10 enrichmentAnchored pass（真稀疏 false / 对齐或同名命中已排天 true / 既有口径不变）");
}

console.log("\n✅ verify-coverage 全部 10 组断言通过（Task #282 稀疏攻略覆盖估算）");
