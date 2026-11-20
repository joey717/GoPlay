/**
 * Task #325 事实注入验证脚本（离线，禁止 live 调用百炼）。
 *
 * 覆盖（设计文档 §6 verify-task325-facts.ts 断言清单）：
 * - buildTripFacts 输出的 Day 头行含 role=、地理跨度=、最远离机场=
 * - 最后一天额外含 行程截止=
 * - 最后一天的行程截止值与 deriveDepartureDayCutoff 返回值逐字相等
 * - slim 行（planner 路径）与 full 行（F11 路径）都含 片区=
 * - 非目标天摘要行不含新增字段（scope 裁剪不退化）
 * - 无坐标行程（全 custom）→ 输出 片区=未知、地理跨度=null，不崩溃、不输出 NaN
 *
 * 运行：npx tsx server/src/ai/verify-task325-facts.ts
 */

import assert from "node:assert/strict";
import type { Constraint, Day, Item, Trip, Visit } from "@goplay/shared";
import { deriveDepartureDayCutoff } from "@goplay/shared";
import { buildTripFacts } from "./prompt.js";

let passCount = 0;
function pass(name: string): void {
  passCount++;
  console.log(`✓ ${name}`);
}

// ===== 夹具构建 =====

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

function makeDay(dayIndex: number, scheduleVisitRefs: string[] = [], role?: string): Day {
  return {
    dayId: `day_${dayIndex}`, dayIndex,
    date: `2026-11-${String(dayIndex + 7).padStart(2, "0")}`,
    departTime: null, departTimeOverridden: false,
    scheduleVisitRefs, lodging: null,
    role: role as any ?? null,
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
}): Trip {
  const dayRefs: string[] = [];
  const days: Record<string, Day> = {};
  for (let i = 1; i <= dayCount; i++) {
    dayRefs.push(`day_${i}`);
    days[`day_${i}`] = makeDay(i, opts?.dayVisitRefs?.[i - 1] ?? [], opts?.dayRoles?.[i - 1] ?? undefined);
  }
  return {
    tripId: "trip_verify_325_facts", schemaVersion: 2, version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: `2026-11-${String(dayCount + 7).padStart(2, "0")}`, nights: dayCount - 1 },
    dayRefs, days, lodgings: {},
    itemRegistry: opts?.items ?? {}, hotelRegistry: {},
    visits: opts?.visits ?? {}, stops: {}, evidences: {},
    globalCandidateRefs: [], pendingStopRefs: [],
    relationshipSuggestions: {}, guideSources: {},
    constraints: opts?.constraints ?? [],
    createdAt: "2026-11-03T00:00:00Z", updatedAt: "2026-11-03T00:00:00Z",
  } as Trip;
}

// ===== §1 Day 头行含 role / 地理跨度 / 最远离机场 =====

{
  const item1 = makeItem({ itemId: "i1", name: "椰梦长廊", coords: { lng: 109.475755, lat: 18.274345 } });
  const v1 = makeVisit({ visitId: "v1", pointRef: "i1", dayRef: "day_1", order: 0 });
  const trip = makeTrip(3, {
    items: { i1: item1 }, visits: { v1: v1 },
    dayVisitRefs: [["v1"], [], []],
    dayRoles: ["arrival", null, null],
    constraints: [makeConstraint("flight_arrive", 1, "2026-11-08T09:00:00")],
  });
  const facts = buildTripFacts(trip, { includePending: false }).join("\n");
  // Day 1 头行应含 role=arrival、地理跨度、最远离机场
  assert.ok(facts.includes("role=arrival"), "§1 Day1 应含 role=arrival");
  assert.ok(facts.includes("地理跨度="), "§1 Day 头应含 地理跨度=");
  assert.ok(facts.includes("最远离机场="), "§1 Day 头应含 最远离机场=");
  // 非最后一天不应含行程截止
  const day1Line = facts.split("\n").find((l) => l.startsWith("Day 1"));
  assert.ok(day1Line !== undefined && !day1Line.includes("行程截止="), "§1 非最后一天不含行程截止");
  pass("§1 Day 头行含 role/地理跨度/最远离机场");
}

// ===== §2 最后一天含行程截止（无 flight_depart → 15:00/default） =====

{
  const trip = makeTrip(5, { constraints: [makeConstraint("flight_arrive", 1, "2026-11-08T09:00:00")] });
  const facts = buildTripFacts(trip, { includePending: false }).join("\n");
  const day5Line = facts.split("\n").find((l) => l.startsWith("Day 5"));
  assert.ok(day5Line !== undefined, "§2 Day5 行应存在");
  assert.ok(day5Line!.includes("行程截止=15:00(default)"), "§2 最后一天无 flight_depart → 行程截止=15:00(default)");
  // 与 deriveDepartureDayCutoff 逐字相等
  const cutoff = deriveDepartureDayCutoff(trip);
  assert.ok(cutoff !== null);
  assert.ok(day5Line!.includes(`行程截止=${cutoff.cutoffTime}(${cutoff.source})`), "§2 行程截止值与 deriveDepartureDayCutoff 逐字相等");
  pass("§2 最后一天无 flight_depart → 行程截止=15:00(default)");
}

// ===== §3 最后一天含行程截止（有 flight_depart → flight source） =====

{
  const trip = makeTrip(5, {
    constraints: [
      makeConstraint("flight_arrive", 1, "2026-11-08T09:00:00"),
      makeConstraint("flight_depart", 5, "2026-11-12T18:00:00"),
    ],
  });
  const facts = buildTripFacts(trip, { includePending: false }).join("\n");
  const day5Line = facts.split("\n").find((l) => l.startsWith("Day 5"));
  assert.ok(day5Line !== undefined);
  const cutoff = deriveDepartureDayCutoff(trip);
  assert.ok(cutoff !== null);
  assert.equal(cutoff.cutoffTime, "15:00");
  assert.equal(cutoff.source, "flight");
  assert.ok(day5Line!.includes(`行程截止=${cutoff.cutoffTime}(${cutoff.source})`), "§3 行程截止=15:00(flight)");
  pass("§3 最后一天有 flight_depart → 行程截止=15:00(flight)");
}

// ===== §4 slim 行与 full 行都含 片区= =====

{
  const item1 = makeItem({ itemId: "i1", name: "椰梦长廊", coords: { lng: 109.475755, lat: 18.274345 }, address: "三亚湾滨海路" });
  const v1 = makeVisit({ visitId: "v1", pointRef: "i1", dayRef: "day_1", order: 0 });
  const trip = makeTrip(2, {
    items: { i1: item1 }, visits: { v1: v1 }, dayVisitRefs: [["v1"], []],
  });
  // full 行（F11 路径，slimVisitFormat=false）
  const fullFacts = buildTripFacts(trip, { includePending: false, slimVisitFormat: false }).join("\n");
  assert.ok(fullFacts.includes("片区=三亚湾"), "§4 full 行应含 片区=三亚湾（marker 命中）");
  // slim 行（planner 路径，slimVisitFormat=true）
  const slimFacts = buildTripFacts(trip, { includePending: false, slimVisitFormat: true }).join("\n");
  assert.ok(slimFacts.includes("片区=三亚湾"), "§4 slim 行应含 片区=三亚湾");
  pass("§4 slim 行与 full 行都含 片区=");
}

// ===== §5 非目标天摘要行不含新增字段 =====

{
  const item1 = makeItem({ itemId: "i1", name: "测试点", coords: { lng: 109.5, lat: 18.25 } });
  const v1 = makeVisit({ visitId: "v1", pointRef: "i1", dayRef: "day_1", order: 0 });
  const trip = makeTrip(3, {
    items: { i1: item1 }, visits: { v1: v1 }, dayVisitRefs: [["v1"], [], []],
  });
  // day scope → 非目标天压缩为摘要行
  const facts = buildTripFacts(trip, { includePending: false, scope: { kind: "day", dayIndex: 1 } }).join("\n");
  const day2Line = facts.split("\n").find((l) => l.startsWith("Day 2"));
  const day3Line = facts.split("\n").find((l) => l.startsWith("Day 3"));
  // 摘要行不应含 role= / 地理跨度= / 片区= 等新增字段
  if (day2Line !== undefined) {
    assert.ok(!day2Line.includes("role="), "§5 非目标天摘要行不含 role=");
    assert.ok(!day2Line.includes("地理跨度="), "§5 非目标天摘要行不含 地理跨度=");
  }
  // 但注意 Day3 是最后一天，它可能走 formatDaySection 而非摘要行（取决于 scope 逻辑）
  // day scope=1 → Day2,Day3 是摘要行
  if (day3Line !== undefined) {
    assert.ok(!day3Line.includes("role="), "§5 Day3 摘要行不含 role=");
  }
  pass("§5 非目标天摘要行不含新增字段（scope 裁剪不退化）");
}

// ===== §6 无坐标行程 → 片区=未知 / 地理跨度=null / 不崩溃 / 不输出 NaN =====

{
  const customItem = makeItem({ itemId: "c1", name: "自定义点A", origin: "custom", providerId: null, coords: null });
  const v1 = makeVisit({ visitId: "v1", pointRef: "c1", dayRef: "day_1", order: 0 });
  const trip = makeTrip(2, {
    items: { c1: customItem }, visits: { v1: v1 }, dayVisitRefs: [["v1"], []],
  });
  const facts = buildTripFacts(trip, { includePending: false }).join("\n");
  // 无坐标 → 片区=未知（除非名称命中 marker）
  assert.ok(facts.includes("片区=未知"), "§6 无坐标且无 marker → 片区=未知");
  // 地理跨度=null（有坐标 <2）
  const day1Line = facts.split("\n").find((l) => l.startsWith("Day 1"));
  assert.ok(day1Line !== undefined);
  assert.ok(day1Line!.includes("地理跨度=null"), "§6 有坐标 <2 → 地理跨度=null");
  // 不含 NaN
  assert.ok(!facts.includes("NaN"), "§6 输出不含 NaN");
  pass("§6 无坐标行程：片区=未知 / 地理跨度=null / 不含 NaN");
}

console.log(`\n[verify-task325-facts] 全部通过 ✓（${passCount} 条断言）`);
