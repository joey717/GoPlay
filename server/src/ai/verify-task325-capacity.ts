/**
 * Task #325 容量剥离验证脚本（离线，禁止 live 调用百炼；照 verify-task316 十批范式）。
 *
 * 覆盖（设计文档 §6 verify-task325-capacity.ts 断言清单）：
 * - 抵达日排第 3 项 → 剥离（reason 含 [容量]）；排第 2 项 → 放行
 * - 最后一天无 flight_depart：新增距机场 >25km → 剥离；≤25km → 放行
 * - 最后一天 + role=departure（有 flight_depart）：>15km → 剥离（收紧档生效）
 * - 剥离项不进 30% 阈值分子分母：3 条操作（1 容量违规 + 2 合法）→ 2 条合法照常应用、rejectAll===false
 * - 剥离项进 rejected 明细，reason 非空且含距离数值
 * - 幂等：无违规时 remaining === 原 operations（引用相等）
 * - 豁免五类各自断言不剥离（locked / bought / userAdjusted / 区域占位 / 既有非本批）
 * - actor="user_manual" → 完全不剥离
 * - 同批 remove 对冲：Day5 先 remove 1 项再 plan 1 项 → 净增 0，不剥离
 * - 草案侧：剥离后两阶段阈值基数 = 剥离后剩余总数（对标 #228 口径）
 *
 * 运行：npx tsx server/src/ai/verify-task325-capacity.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Constraint, Day, Item, Operation, OperationSet, Trip, Visit } from "@goplay/shared";
import { tripStore } from "../persistence/store.js";
import { applyOperationSet, stripOverloadedDayOps } from "./pipeline.js";

let passCount = 0;
function pass(name: string): void {
  passCount++;
  console.log(`✓ ${name}`);
}

// ===== 坐标夹具（相对 SANYA_AIRPORT 的实测距离） =====
const NEAR = { lng: 109.475755, lat: 18.274345 }; // 椰梦长廊 ≈ 7.4km（≤15、≤25 均放行）
const MID = { lng: 109.6, lat: 18.3 }; // ≈ 19.8km（>15 收紧档剥离、≤25 无航班档放行）
const FAR = { lng: 109.765947, lat: 18.310381 }; // 蜈支洲岛 ≈ 37.4km（>25、>15 均剥离）

// ===== Trip 夹具构建 =====

function makeItem(overrides: Partial<Item> & { itemId: string; name: string }): Item {
  return {
    origin: "fliggy", providerId: "mock", address: null, category: null,
    coords: null, suggestMinutes: null, mainPic: null, ticketInfo: null,
    jumpUrl: null, sourceEvidenceRefs: [], ...overrides,
  } as Item;
}

function makeVisit(overrides: Partial<Visit> & { visitId: string; pointRef: string }): Visit {
  return {
    dayRef: null, kind: "ordinary", visitMode: "custom", order: null,
    windowStart: null, windowEnd: null, startTime: null, endTime: null,
    startTimeOverridden: false, endTimeOverridden: false,
    reservedMinutes: null, effectiveMinutes: null, externalLeg: null,
    childStopRefs: [], alternateStopRefs: [],
    purchaseState: "unknown", locked: false, userAdjusted: false,
    removedFrom: null, removedAt: null, ...overrides,
  } as Visit;
}

function makeDay(dayIndex: number, scheduleVisitRefs: string[] = [], role?: string | null): Day {
  return {
    dayId: `day_${dayIndex}`, dayIndex,
    date: `2026-11-${String(dayIndex + 7).padStart(2, "0")}`,
    departTime: null, departTimeOverridden: false,
    scheduleVisitRefs, lodging: null,
    role: (role ?? null) as any,
  };
}

function makeConstraint(type: Constraint["type"], dayIndex: number, anchorTime: string): Constraint {
  return { constraintId: `c_${type}_${dayIndex}`, type, anchorTime, dayIndex, label: `${type} d${dayIndex}`, locked: true };
}

function makeTrip(dayCount: number, opts?: {
  items?: Record<string, Item>;
  visits?: Record<string, Visit>;
  dayVisitRefs?: string[][];
  dayRoles?: (string | null)[];
  constraints?: Constraint[];
  candidateRefs?: { kind: "point"; id: string }[];
}): Trip {
  const dayRefs: string[] = [];
  const days: Record<string, Day> = {};
  for (let i = 1; i <= dayCount; i++) {
    dayRefs.push(`day_${i}`);
    days[`day_${i}`] = makeDay(i, opts?.dayVisitRefs?.[i - 1] ?? [], opts?.dayRoles?.[i - 1] ?? null);
  }
  const visits = opts?.visits ?? {};
  // 回填 visit.dayRef（依据 dayVisitRefs）
  for (let i = 1; i <= dayCount; i++) {
    for (const vid of opts?.dayVisitRefs?.[i - 1] ?? []) {
      if (visits[vid] !== undefined) visits[vid] = { ...visits[vid], dayRef: `day_${i}` };
    }
  }
  return {
    tripId: "trip_verify_325_cap", schemaVersion: 2, version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: `2026-11-${String(dayCount + 7).padStart(2, "0")}`, nights: dayCount - 1 },
    dayRefs, days, lodgings: {},
    itemRegistry: opts?.items ?? {}, hotelRegistry: {},
    visits, stops: {}, evidences: {},
    globalCandidateRefs: opts?.candidateRefs ?? [], pendingStopRefs: [],
    relationshipSuggestions: {}, guideSources: {},
    constraints: opts?.constraints ?? [],
    createdAt: "2026-11-03T00:00:00Z", updatedAt: "2026-11-03T00:00:00Z",
  } as Trip;
}

function planOp(dayIndex: number, pointIds: string[]): Operation {
  return {
    op: "plan",
    scopeRef: { kind: "day", dayIndex },
    assignments: pointIds.map((id, i) => ({
      subjectRef: { kind: "point", id },
      containerRef: { kind: "day", dayIndex },
      order: i,
    })),
    reason: `plan into Day${dayIndex}`,
  } as Operation;
}

function opSet(version: number, operations: Operation[]): OperationSet {
  return { baseVersion: version, operations, unplaced: [], proposedNew: [], clarify: null };
}

// ===== §1 抵达日排第 3 项 → 剥离 =====

{
  const trip = makeTrip(5, {
    items: { pA: makeItem({ itemId: "pA", name: "点A", coords: NEAR }), pB: makeItem({ itemId: "pB", name: "点B", coords: NEAR }), pC: makeItem({ itemId: "pC", name: "点C", coords: NEAR }) },
    constraints: [makeConstraint("flight_arrive", 1, "2026-11-08T09:00:00")],
    dayRoles: ["arrival", null, null, null, null],
    candidateRefs: [{ kind: "point", id: "pA" }, { kind: "point", id: "pB" }, { kind: "point", id: "pC" }],
  });
  const ops: Operation[] = [planOp(1, ["pA", "pB", "pC"])];
  const { remaining, stripped } = stripOverloadedDayOps(ops, trip, "ai_proposed");
  assert.equal(stripped.length, 1, "§1 抵达日第 3 项应被剥离");
  assert.match(stripped[0].reason, /\[容量\]/, "§1 reason 应含 [容量]");
  assert.match(stripped[0].reason, /抵达日/, "§1 reason 应说明抵达日");
  // remaining 的 plan 只剩 2 条 assignment
  const remPlan = remaining[0] as any;
  assert.equal(remPlan.assignments.length, 2, "§1 remaining plan 应只剩 2 条 assignment");
  pass("§1 抵达日排第 3 项 → 剥离（reason 含 [容量]）");
}

// ===== §2 抵达日排第 2 项 → 放行 =====

{
  const trip = makeTrip(5, {
    items: { pA: makeItem({ itemId: "pA", name: "点A", coords: NEAR }), pB: makeItem({ itemId: "pB", name: "点B", coords: NEAR }) },
    constraints: [makeConstraint("flight_arrive", 1, "2026-11-08T09:00:00")],
    dayRoles: ["arrival", null, null, null, null],
    candidateRefs: [{ kind: "point", id: "pA" }, { kind: "point", id: "pB" }],
  });
  const ops: Operation[] = [planOp(1, ["pA", "pB"])];
  const { remaining, stripped } = stripOverloadedDayOps(ops, trip, "ai_proposed");
  assert.equal(stripped.length, 0, "§2 抵达日第 2 项应放行");
  assert.equal((remaining[0] as any).assignments.length, 2, "§2 两条 assignment 均保留");
  pass("§2 抵达日排第 2 项 → 放行");
}

// ===== §3 最后一天无 flight_depart：>25km → 剥离（reason 含距离数值） =====

{
  const trip = makeTrip(5, {
    items: { pFar: makeItem({ itemId: "pFar", name: "蜈支洲岛", coords: FAR }) },
    constraints: [makeConstraint("flight_arrive", 1, "2026-11-08T09:00:00")], // Day5 无 flight_depart
    candidateRefs: [{ kind: "point", id: "pFar" }],
  });
  const ops: Operation[] = [planOp(5, ["pFar"])];
  const { stripped } = stripOverloadedDayOps(ops, trip, "ai_proposed");
  assert.equal(stripped.length, 1, "§3 最后一天 >25km 应剥离");
  assert.match(stripped[0].reason, /\[容量\]/, "§3 reason 含 [容量]");
  assert.match(stripped[0].reason, /\d+(\.\d+)?km/, "§3/§7 reason 含距离数值");
  assert.match(stripped[0].reason, /凤凰机场/, "§3 reason 应点名凤凰机场");
  pass("§3 最后一天无 flight_depart：>25km → 剥离（§7 reason 含距离数值）");
}

// ===== §4 最后一天无 flight_depart：≤25km → 放行 =====

{
  const trip = makeTrip(5, {
    items: { pNear: makeItem({ itemId: "pNear", name: "椰梦长廊", coords: NEAR }) },
    constraints: [makeConstraint("flight_arrive", 1, "2026-11-08T09:00:00")],
    candidateRefs: [{ kind: "point", id: "pNear" }],
  });
  const ops: Operation[] = [planOp(5, ["pNear"])];
  const { stripped } = stripOverloadedDayOps(ops, trip, "ai_proposed");
  assert.equal(stripped.length, 0, "§4 最后一天 ≤25km 应放行");
  pass("§4 最后一天无 flight_depart：≤25km（7.4km）→ 放行");
}

// ===== §5 最后一天 + role=departure（有 flight_depart）：>15km → 剥离（收紧档） =====

{
  const trip = makeTrip(5, {
    items: { pMid: makeItem({ itemId: "pMid", name: "亚龙湾点", coords: MID }) }, // 19.8km：>15 但 <25
    constraints: [
      makeConstraint("flight_arrive", 1, "2026-11-08T09:00:00"),
      makeConstraint("flight_depart", 5, "2026-11-12T18:00:00"),
    ],
    dayRoles: [null, null, null, null, "departure"],
    candidateRefs: [{ kind: "point", id: "pMid" }],
  });
  const ops: Operation[] = [planOp(5, ["pMid"])];
  const { stripped } = stripOverloadedDayOps(ops, trip, "ai_proposed");
  assert.equal(stripped.length, 1, "§5 收紧档 >15km 应剥离（19.8km 在无航班档会放行）");
  assert.match(stripped[0].reason, /\[容量\]/, "§5 reason 含 [容量]");
  assert.match(stripped[0].reason, /返程航班|返程日/, "§5 reason 应说明返程日收紧档");
  pass("§5 最后一天 + role=departure：>15km（19.8km）→ 剥离（收紧档生效）");
}

// ===== §8 幂等：无违规时 remaining === 原 operations（引用相等） =====

{
  const trip = makeTrip(5, {
    items: { pNear: makeItem({ itemId: "pNear", name: "椰梦长廊", coords: NEAR }) },
    constraints: [makeConstraint("flight_arrive", 1, "2026-11-08T09:00:00")],
  });
  const ops: Operation[] = [
    { op: "setDuration", subjectRef: { kind: "visit", id: "vX" }, minutes: 90, reason: "合法" } as Operation,
    { op: "plan", scopeRef: { kind: "day", dayIndex: 3 }, assignments: [{ subjectRef: { kind: "point", id: "pNear" }, containerRef: { kind: "day", dayIndex: 3 }, order: 0 }], reason: "中间天合法" } as Operation,
  ];
  const { remaining, stripped } = stripOverloadedDayOps(ops, trip, "ai_proposed");
  assert.equal(stripped.length, 0, "§8 无违规 stripped 应为空");
  assert.ok(remaining === ops, "§8 无违规时 remaining 应与原数组引用相等");
  pass("§8 幂等：无违规时 remaining === 原 operations（引用相等）");
}

// ===== §9 豁免五类各自不剥离 =====

// 构造：抵达日 Day1 已有 2 个非豁免既有 visit（MAX=2 已满），再 plan 一个「豁免」visit → 不剥离
function exemptionTrip(subjectVisit: Visit, subjectItem: Item, extraReal?: Item): Trip {
  const e1 = makeVisit({ visitId: "e1", pointRef: "pe1", dayRef: "day_1", order: 0 });
  const e2 = makeVisit({ visitId: "e2", pointRef: "pe2", dayRef: "day_1", order: 1 });
  const items: Record<string, Item> = {
    pe1: makeItem({ itemId: "pe1", name: "既有1", coords: NEAR }),
    pe2: makeItem({ itemId: "pe2", name: "既有2", coords: NEAR }),
    [subjectItem.itemId]: subjectItem,
  };
  const visits: Record<string, Visit> = { e1, e2, [subjectVisit.visitId]: subjectVisit };
  const dayVisitRefs: string[][] = [["e1", "e2"], [], [], [], []];
  if (extraReal !== undefined) {
    // collectAreaPlaceholderVisitIds 的 realNames 只扫描「被 visit 引用」的真实点位，
    // 故区域占位判定需要一个引用 extraReal 的 visit（放 Day3，不影响 Day1 容量）。
    items[extraReal.itemId] = extraReal;
    visits["vReal"] = makeVisit({ visitId: "vReal", pointRef: extraReal.itemId, dayRef: "day_3", order: 0 });
    dayVisitRefs[2] = ["vReal"];
  }
  return makeTrip(5, {
    items,
    visits,
    dayVisitRefs,
    constraints: [makeConstraint("flight_arrive", 1, "2026-11-08T09:00:00")],
    dayRoles: ["arrival", null, null, null, null],
  });
}

// 9a locked
{
  const item = makeItem({ itemId: "pL", name: "锁定点", coords: NEAR });
  const v = makeVisit({ visitId: "vL", pointRef: "pL", dayRef: "day_2", locked: true });
  const trip = exemptionTrip(v, item);
  const ops: Operation[] = [{ op: "plan", scopeRef: { kind: "day", dayIndex: 1 }, assignments: [{ subjectRef: { kind: "visit", id: "vL" }, containerRef: { kind: "day", dayIndex: 1 }, order: 2 }], reason: "排入锁定 visit" } as Operation];
  const { stripped } = stripOverloadedDayOps(ops, trip, "ai_proposed");
  assert.equal(stripped.length, 0, "§9a locked visit 应豁免不剥离");
  pass("§9a 豁免：locked visit 不剥离");
}

// 9b bought
{
  const item = makeItem({ itemId: "pB", name: "已购点", coords: NEAR });
  const v = makeVisit({ visitId: "vB", pointRef: "pB", dayRef: "day_2", purchaseState: "bought" });
  const trip = exemptionTrip(v, item);
  const ops: Operation[] = [{ op: "plan", scopeRef: { kind: "day", dayIndex: 1 }, assignments: [{ subjectRef: { kind: "visit", id: "vB" }, containerRef: { kind: "day", dayIndex: 1 }, order: 2 }], reason: "排入已购 visit" } as Operation];
  const { stripped } = stripOverloadedDayOps(ops, trip, "ai_proposed");
  assert.equal(stripped.length, 0, "§9b bought visit 应豁免不剥离");
  pass("§9b 豁免：bought visit 不剥离");
}

// 9c userAdjusted
{
  const item = makeItem({ itemId: "pU", name: "手调点", coords: NEAR });
  const v = makeVisit({ visitId: "vU", pointRef: "pU", dayRef: "day_2", userAdjusted: true });
  const trip = exemptionTrip(v, item);
  const ops: Operation[] = [{ op: "plan", scopeRef: { kind: "day", dayIndex: 1 }, assignments: [{ subjectRef: { kind: "visit", id: "vU" }, containerRef: { kind: "day", dayIndex: 1 }, order: 2 }], reason: "排入手调 visit" } as Operation];
  const { stripped } = stripOverloadedDayOps(ops, trip, "ai_proposed");
  assert.equal(stripped.length, 0, "§9c userAdjusted visit 应豁免不剥离");
  pass("§9c 豁免：userAdjusted visit 不剥离");
}

// 9d 区域占位（custom「亚龙湾」+ 真实「亚龙湾森林公园」证明其为区域主题）
{
  const placeholderItem = makeItem({ itemId: "pArea", name: "亚龙湾", origin: "custom", providerId: null, coords: NEAR });
  const realItem = makeItem({ itemId: "pReal", name: "亚龙湾森林公园", providerId: "fliggy_123", coords: NEAR });
  const v = makeVisit({ visitId: "vArea", pointRef: "pArea", dayRef: "day_2", kind: "ordinary" });
  const trip = exemptionTrip(v, placeholderItem, realItem);
  const ops: Operation[] = [{ op: "plan", scopeRef: { kind: "day", dayIndex: 1 }, assignments: [{ subjectRef: { kind: "visit", id: "vArea" }, containerRef: { kind: "day", dayIndex: 1 }, order: 2 }], reason: "排入区域占位" } as Operation];
  const { stripped } = stripOverloadedDayOps(ops, trip, "ai_proposed");
  assert.equal(stripped.length, 0, "§9d 区域占位 visit 应豁免不剥离");
  pass("§9d 豁免：区域占位 visit 不剥离");
}

// 9e 既有非本批 visit（已在 Day1，re-plan 回 Day1 → 非净新增）
{
  const trip = makeTrip(5, {
    items: {
      pe1: makeItem({ itemId: "pe1", name: "既有1", coords: NEAR }),
      pe2: makeItem({ itemId: "pe2", name: "既有2", coords: NEAR }),
      pe3: makeItem({ itemId: "pe3", name: "既有3", coords: NEAR }),
    },
    visits: {
      e1: makeVisit({ visitId: "e1", pointRef: "pe1", dayRef: "day_1", order: 0 }),
      e2: makeVisit({ visitId: "e2", pointRef: "pe2", dayRef: "day_1", order: 1 }),
      e3: makeVisit({ visitId: "e3", pointRef: "pe3", dayRef: "day_1", order: 2 }),
    },
    // Day1 已有 3 个（超 MAX），但都是既有非本批 → 绝不评判用户已有安排
    dayVisitRefs: [["e1", "e2", "e3"], [], [], [], []],
    constraints: [makeConstraint("flight_arrive", 1, "2026-11-08T09:00:00")],
    dayRoles: ["arrival", null, null, null, null],
  });
  // 本批不往 Day1 加任何新点位（只 re-plan 既有 e1 回 Day1）→ 非净新增，不剥离
  const ops: Operation[] = [{ op: "plan", scopeRef: { kind: "day", dayIndex: 1 }, assignments: [{ subjectRef: { kind: "visit", id: "e1" }, containerRef: { kind: "day", dayIndex: 1 }, order: 0 }], reason: "re-plan 既有" } as Operation];
  const { stripped } = stripOverloadedDayOps(ops, trip, "ai_proposed");
  assert.equal(stripped.length, 0, "§9e 既有非本批 visit（已在目标天）不算净新增，不剥离");
  pass("§9e 豁免：既有非本批 visit（已在目标天）不剥离");
}

// ===== §10 actor="user_manual" → 完全不剥离 =====

{
  const trip = makeTrip(5, {
    items: { pFar: makeItem({ itemId: "pFar", name: "蜈支洲岛", coords: FAR }) },
    constraints: [makeConstraint("flight_arrive", 1, "2026-11-08T09:00:00")],
    candidateRefs: [{ kind: "point", id: "pFar" }],
  });
  const ops: Operation[] = [planOp(5, ["pFar"])]; // 与 §3 同形状（ai_proposed 会剥离）
  const { remaining, stripped } = stripOverloadedDayOps(ops, trip, "user_manual");
  assert.equal(stripped.length, 0, "§10 user_manual 通道完全不剥离");
  assert.ok(remaining === ops, "§10 user_manual remaining === 原 ops");
  pass("§10 actor=user_manual → 完全不剥离");
}

// ===== §11 同批 remove 对冲：Day5 remove 1 + plan 1 → 净增 0，不剥离 =====

{
  const trip = makeTrip(5, {
    items: {
      pe1: makeItem({ itemId: "pe1", name: "既有1", coords: NEAR }),
      pe2: makeItem({ itemId: "pe2", name: "既有2", coords: NEAR }),
      pNew: makeItem({ itemId: "pNew", name: "新点", coords: NEAR }),
    },
    visits: {
      e1: makeVisit({ visitId: "e1", pointRef: "pe1", dayRef: "day_5", order: 0 }),
      e2: makeVisit({ visitId: "e2", pointRef: "pe2", dayRef: "day_5", order: 1 }),
    },
    dayVisitRefs: [[], [], [], [], ["e1", "e2"]], // Day5 已满 2（无航班档 MAX=2）
    constraints: [makeConstraint("flight_arrive", 1, "2026-11-08T09:00:00")], // Day5 无 flight_depart
    candidateRefs: [{ kind: "point", id: "pNew" }],
  });
  const ops: Operation[] = [
    { op: "remove", subjectRef: { kind: "visit", id: "e1" }, fromContainerRef: { kind: "day", dayIndex: 5 }, reason: "移除既有1腾名额" } as Operation,
    planOp(5, ["pNew"]), // 新增 1（NEAR，≤25km）
  ];
  const { stripped } = stripOverloadedDayOps(ops, trip, "ai_proposed");
  assert.equal(stripped.length, 0, "§11 remove 对冲后净增 0（2-1+1=2 ≤2），不剥离");
  pass("§11 同批 remove 对冲：Day5 remove 1 + plan 1 → 净增 0，不剥离");
}

// ===== §12 草案侧阈值基数 = 剥离后剩余总数（对标 #228） =====

{
  const trip = makeTrip(5, {
    items: {
      pFar: makeItem({ itemId: "pFar", name: "蜈支洲岛", coords: FAR }),
      pN1: makeItem({ itemId: "pN1", name: "合法点1", coords: NEAR }),
    },
    visits: { m1: makeVisit({ visitId: "m1", pointRef: "pN1", dayRef: "day_2", order: 0 }) },
    dayVisitRefs: [[], ["m1"], [], [], []],
    constraints: [makeConstraint("flight_arrive", 1, "2026-11-08T09:00:00")],
    candidateRefs: [{ kind: "point", id: "pFar" }],
  });
  // 3 条操作：1 条容量违规（plan FAR→Day5）+ 2 条合法（setDuration）
  const ops: Operation[] = [
    planOp(5, ["pFar"]), // 违规
    { op: "setDuration", subjectRef: { kind: "visit", id: "m1" }, minutes: 120, reason: "合法1" } as Operation,
    { op: "setDuration", subjectRef: { kind: "visit", id: "m1" }, minutes: 100, reason: "合法2" } as Operation,
  ];
  const { remaining, stripped } = stripOverloadedDayOps(ops, trip, "ai_proposed");
  assert.equal(stripped.length, 1, "§12 应剥离 1 条容量违规");
  assert.equal(remaining.length, 2, "§12 剥离后剩余 2 条 = 两阶段阈值基数（不进 30% 分子分母）");
  pass("§12 草案侧阈值基数 = 剥离后剩余总数（2 条，对标 #228）");
}

// ===== §6 端到端：剥离项不进 30% 分子分母 → 2 条合法照常应用、rejectAll===false =====

async function endToEnd(): Promise<void> {
  const tripId = randomUUID();
  const trip = makeTrip(5, {
    items: {
      pFar: makeItem({ itemId: "pFar", name: "蜈支洲岛", coords: FAR }),
      pN1: makeItem({ itemId: "pN1", name: "合法点1", coords: NEAR }),
      pN2: makeItem({ itemId: "pN2", name: "合法点2", coords: NEAR }),
    },
    visits: {
      m1: makeVisit({ visitId: "m1", pointRef: "pN1", dayRef: "day_2", order: 0 }),
      m2: makeVisit({ visitId: "m2", pointRef: "pN2", dayRef: "day_3", order: 0 }),
    },
    dayVisitRefs: [[], ["m1"], ["m2"], [], []],
    constraints: [makeConstraint("flight_arrive", 1, "2026-11-08T09:00:00")], // Day5 无 flight_depart
    candidateRefs: [{ kind: "point", id: "pFar" }],
  });
  (trip as any).tripId = tripId;
  await tripStore.save(trip);
  const loaded = await tripStore.load(tripId);
  assert.ok(loaded !== null, "§6 端到端行程应可加载");

  // 3 条操作：1 条容量违规（plan FAR→Day5，>25km 剥离）+ 2 条合法 setDuration
  const result = await applyOperationSet(loaded!, opSet(loaded!.version, [
    planOp(5, ["pFar"]),
    { op: "setDuration", subjectRef: { kind: "visit", id: "m1" }, minutes: 120, reason: "合法1" } as Operation,
    { op: "setDuration", subjectRef: { kind: "visit", id: "m2" }, minutes: 90, reason: "合法2" } as Operation,
  ]));

  assert.equal(result.type, "applied", "§6 应 applied（rejectAll===false，未整批拒绝）");
  assert.ok(!(result.message ?? "").includes("30%"), "§6 message 不应含 30% 整批拒绝");
  assert.equal(result.result!.applied.length, 2, "§6 2 条合法照常应用");
  assert.equal(result.result!.rejected.length, 1, "§6 1 条容量违规进 rejected 明细");
  assert.match(result.result!.rejected[0].reason, /\[容量\]/, "§6 rejected reason 含 [容量]");
  assert.match(result.result!.rejected[0].reason, /\d+(\.\d+)?km/, "§6 rejected reason 含距离数值");
  // 合法字段生效
  assert.equal(result.result!.trip.visits["m1"].effectiveMinutes, 120, "§6 m1 时长生效");
  assert.equal(result.result!.trip.visits["m2"].effectiveMinutes, 90, "§6 m2 时长生效");
  pass("§6 端到端：容量违规剥离不进 30% 分子分母 → 2 条合法应用、rejectAll===false");
  // 清理临时行程文件（不留残物）
  await tripStore.deleteTrip(tripId);
}

async function main(): Promise<void> {
  await endToEnd();
  console.log(`\n[verify-task325-capacity] 全部通过 ✓（${passCount} 条断言组）`);
}

main().catch((error) => {
  console.error("[verify-task325-capacity] 断言失败：", error);
  process.exitCode = 1;
});
