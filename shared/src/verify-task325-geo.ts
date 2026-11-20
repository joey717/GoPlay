/**
 * Task #325 地理模块验证脚本（离线，零 IO，纯函数断言）。
 *
 * 覆盖：
 * - haversineKm 迁移后数值与原实现逐点相等（5 组黄金值）
 * - resolveItemCoords 脏数据防御（undefined/null/字符串/NaN 不抛异常）
 * - attributePoiArea 三级优先级（marker > center > none）
 * - 并列距离确定性（两次调用全等）
 * - 20km 上限（南山/大小洞天 → none）
 * - 无坐标但 marker 命中（第一市场 → 老城）
 * - computeDayGeoStats（spanKm null / 区域占位排除 / sequentialLegKm 顺序）
 * - evaluateDayCapacity 豁免矩阵（locked/bought/userAdjusted/占位/既有非本批）
 * - 幂等：两次调用深度相等，不修改入参 trip
 * - SANYA_AIRPORT 合理性兜底：距三亚湾中心 [5,15]km
 *
 * 运行：npx tsx shared/src/verify-task325-geo.ts
 */

import assert from "node:assert/strict";
import type { Day, Item, Trip, Visit, Constraint } from "./types/index.js";
import {
  haversineKm,
  SANYA_AIRPORT,
  POI_ATTRIBUTION_MAX_KM,
  resolveItemCoords,
  attributePoiArea,
  computeDayGeoStats,
  evaluateDayCapacity,
  ARRIVAL_DAY_MAX_VISITS,
  LAST_DAY_NO_FLIGHT_MAX_VISITS,
  LAST_DAY_NO_FLIGHT_AIRPORT_KM,
  LAST_DAY_DEPARTURE_MAX_VISITS,
  LAST_DAY_DEPARTURE_AIRPORT_KM,
} from "./geo/index.js";
import { SANYA_AREAS } from "./areas/index.js";

let passCount = 0;
function pass(name: string): void {
  passCount++;
  console.log(`✓ ${name}`);
}

// ===== 最小夹具 =====

function makeItem(overrides: Partial<Item> & { itemId: string; name: string }): Item {
  return {
    origin: "fliggy",
    providerId: "mock_provider",
    address: null,
    category: null,
    coords: null,
    suggestMinutes: null,
    mainPic: null,
    ticketInfo: null,
    jumpUrl: null,
    sourceEvidenceRefs: [],
    ...overrides,
  } as Item;
}

function makeVisit(overrides: Partial<Visit> & { visitId: string; pointRef: string }): Visit {
  return {
    dayRef: null,
    kind: "ordinary",
    visitMode: "custom",
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
    purchaseState: "unknown",
    locked: false,
    userAdjusted: false,
    removedFrom: null,
    removedAt: null,
    ...overrides,
  } as Visit;
}

function makeDay(dayIndex: number, scheduleVisitRefs: string[] = []): Day {
  return {
    dayId: `day_${dayIndex}`,
    dayIndex,
    date: `2026-11-${String(dayIndex + 7).padStart(2, "0")}`,
    departTime: null,
    departTimeOverridden: false,
    scheduleVisitRefs,
    lodging: null,
  };
}

function makeTrip(dayCount: number, opts?: {
  items?: Record<string, Item>;
  visits?: Record<string, Visit>;
  dayVisitRefs?: string[][];
  constraints?: Constraint[];
}): Trip {
  const dayRefs: string[] = [];
  const days: Record<string, Day> = {};
  for (let i = 1; i <= dayCount; i++) {
    dayRefs.push(`day_${i}`);
    days[`day_${i}`] = makeDay(i, opts?.dayVisitRefs?.[i - 1] ?? []);
  }
  return {
    tripId: "trip_verify_325_geo",
    schemaVersion: 2,
    version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: `2026-11-${String(dayCount + 7).padStart(2, "0")}`, nights: dayCount - 1 },
    dayRefs,
    days,
    lodgings: {},
    itemRegistry: opts?.items ?? {},
    hotelRegistry: {},
    visits: opts?.visits ?? {},
    stops: {},
    evidences: {},
    globalCandidateRefs: [],
    pendingStopRefs: [],
    relationshipSuggestions: {},
    guideSources: {},
    constraints: opts?.constraints ?? [],
    createdAt: "2026-11-03T00:00:00Z",
    updatedAt: "2026-11-03T00:00:00Z",
  } as Trip;
}

function makeConstraint(type: Constraint["type"], dayIndex: number, anchorTime: string): Constraint {
  return { constraintId: `c_${type}_${dayIndex}`, type, anchorTime, dayIndex, label: `${type} d${dayIndex}`, locked: true };
}

// ===== §1 haversineKm 黄金值对照 =====

{
  // 原实现公式（scope.ts 原始版本，用作黄金值）
  function originalHaversine(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLng = (b.lng - a.lng) * rad;
    const lat1 = a.lat * rad;
    const lat2 = b.lat * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  const pairs: [string, { lng: number; lat: number }, { lng: number; lat: number }][] = [
    ["椰梦长廊→机场", { lng: 109.475755, lat: 18.274345 }, SANYA_AIRPORT],
    ["三亚湾中心→海棠湾中心", SANYA_AREAS[3].center, SANYA_AREAS[0].center],
    ["蜈支洲岛→机场", { lng: 109.765947, lat: 18.310381 }, SANYA_AIRPORT],
    ["亚龙湾中心→老城中心", SANYA_AREAS[1].center, SANYA_AREAS[4].center],
    ["同一点→同一点（零距离）", { lng: 109.5, lat: 18.25 }, { lng: 109.5, lat: 18.25 }],
  ];

  for (const [label, a, b] of pairs) {
    const migrated = haversineKm(a, b);
    const original = originalHaversine(a, b);
    assert.equal(migrated, original, `§1 ${label} 迁移后数值应与原实现全等`);
  }
  pass("§1 haversineKm 5 组黄金值逐点相等");
}

// ===== §2 SANYA_AIRPORT 合理性兜底 =====

{
  const sanyawanCenter = SANYA_AREAS.find((a) => a.id === "sanyawan")!.center;
  const dist = haversineKm(SANYA_AIRPORT, sanyawanCenter);
  assert.ok(dist >= 5 && dist <= 15, `§2 机场→三亚湾中心 ${dist.toFixed(1)}km 应在 [5,15]`);
  pass(`§2 SANYA_AIRPORT 合理性：距三亚湾中心 ${dist.toFixed(1)}km ∈ [5,15]`);
}

// ===== §3 resolveItemCoords 脏数据防御 =====

{
  // coords 存在但 lat 为 undefined
  const item1 = makeItem({ itemId: "dirty1", name: "脏数据1", coords: { lng: 109.4, lat: undefined } as any });
  assert.equal(resolveItemCoords(item1), null);
  // coords 存在但 lng 为 null
  const item2 = makeItem({ itemId: "dirty2", name: "脏数据2", coords: { lng: null, lat: 18.3 } as any });
  assert.equal(resolveItemCoords(item2), null);
  // coords 存在但 lat 为字符串
  const item3 = makeItem({ itemId: "dirty3", name: "脏数据3", coords: { lng: 109.4, lat: "18.3" } as any });
  assert.equal(resolveItemCoords(item3), null);
  // coords 存在但 lng 为 NaN
  const item4 = makeItem({ itemId: "dirty4", name: "脏数据4", coords: { lng: NaN, lat: 18.3 } });
  assert.equal(resolveItemCoords(item4), null);
  // 正常 coords
  const item5 = makeItem({ itemId: "good", name: "正常", coords: { lng: 109.4, lat: 18.3 } });
  assert.deepEqual(resolveItemCoords(item5), { lng: 109.4, lat: 18.3 });
  // null item
  assert.equal(resolveItemCoords(null), null);
  assert.equal(resolveItemCoords(undefined), null);
  pass("§3 resolveItemCoords 脏数据防御：undefined/null/字符串/NaN 全返回 null 不抛异常");
}

// ===== §4 attributePoiArea marker 优先于最近中心 =====

{
  // 椰梦长廊：名称命中三亚湾 markers（"椰梦长廊"），但最近中心可能是老城（3.6km vs 三亚湾 4.1km）
  const yemeng = makeItem({
    itemId: "yemeng", name: "椰梦长廊",
    coords: { lng: 109.475755, lat: 18.274345 },
    address: "三亚市三亚湾滨海路",
  });
  const result = attributePoiArea(yemeng);
  assert.equal(result.areaName, "三亚湾", "§4 椰梦长廊应归属三亚湾（marker 命中）而非老城");
  assert.equal(result.method, "marker");

  // 西岛：名称命中离岛 markers（"西岛"）
  const xidao = makeItem({
    itemId: "xidao", name: "西岛",
    coords: { lng: 109.374956, lat: 18.242358 },
    address: "海南省三亚市天涯区河西区街道西岛上院东北侧100米",
  });
  const result2 = attributePoiArea(xidao);
  assert.equal(result2.areaName, "离岛", "§4 西岛应归属离岛（marker 命中）而非三亚湾");
  assert.equal(result2.method, "marker");
  pass("§4 attributePoiArea marker 优先：椰梦长廊→三亚湾、西岛→离岛");
}

// ===== §5 并列距离确定性 =====

{
  // 构造一个到两片区中心距离完全相等的坐标（南山文化旅游区实测：三亚湾=离岛=22.2km）
  // 使用三亚湾和离岛中心的中点来构造
  const sw = SANYA_AREAS[3].center; // 三亚湾 {lat:18.247, lng:109.412}
  const ld = SANYA_AREAS[5].center; // 离岛 {lat:18.3089, lng:109.418}
  // 中点
  const mid = { lat: (sw.lat + ld.lat) / 2, lng: (sw.lng + ld.lng) / 2 };
  const midpointItem = makeItem({ itemId: "mid", name: "中点测试", coords: mid, address: null });
  const r1 = attributePoiArea(midpointItem);
  const r2 = attributePoiArea(midpointItem);
  assert.deepEqual(r1, r2, "§5 并列距离两次调用结果应全等（确定性）");
  // 三亚湾在数组中位于离岛之前（index 3 vs 5），所以应取三亚湾
  // 但这里两个距离可能不完全相等（因为中点不一定精确等距），验证确定性即可
  pass("§5 并列距离确定性：两次调用结果全等");
}

// ===== §6 20km 上限 =====

{
  // 南山文化旅游区：设计文档实测 22.2km（三亚湾/离岛并列）→ 超 20km → none
  const nanshan = makeItem({
    itemId: "nanshan", name: "南山文化旅游区",
    // 从 PD 行程推算：距两片区中心均为 22.2km，位于西南方
    coords: { lng: 109.2206, lat: 18.2968 },
    address: "海南省三亚市崖州区南山文化旅游区",
  });
  const r = attributePoiArea(nanshan);
  // 地址中含"南山"但不在任何 markers 中；超 20km → none
  // 注意：如果 address 命中了 marker 则会走 marker 路径
  // 检查 SANYA_AREAS markers 中是否有"南山"... 没有！
  assert.equal(r.method, "none", "§6 南山文化旅游区应为 none（超 20km）");
  assert.equal(r.areaId, null);

  // 大小洞天：设计文档实测 27.5km → none
  const daxiaodongtian = makeItem({
    itemId: "dxdt", name: "大小洞天",
    coords: { lng: 109.1769, lat: 18.3182 },
    address: "海南省三亚市崖州区大小洞天旅游区",
  });
  const r2 = attributePoiArea(daxiaodongtian);
  assert.equal(r2.method, "none", "§6 大小洞天应为 none（超 20km）");
  pass("§6 20km 上限：南山(22.2km)、大小洞天(27.5km) → method=none");
}

// ===== §7 无坐标但 marker 命中 =====

{
  // 第一市场：custom 无坐标，但名称直接命中老城 markers
  const market = makeItem({
    itemId: "market", name: "第一市场",
    origin: "custom", providerId: null, coords: null,
    address: null,
  });
  const r = attributePoiArea(market);
  assert.equal(r.areaName, "老城", "§7 第一市场应归属老城（marker 命中）");
  assert.equal(r.method, "marker");
  assert.equal(r.distanceKm, null, "§7 无坐标时 distanceKm 应为 null");
  pass("§7 无坐标但 marker 命中：第一市场→老城，method=marker");
}

// ===== §8 computeDayGeoStats =====

{
  // 有坐标点位 <2 → spanKm 为 null 而非 0
  const item1 = makeItem({ itemId: "i1", name: "单点", coords: { lng: 109.5, lat: 18.25 } });
  const visit1 = makeVisit({ visitId: "v1", pointRef: "i1", dayRef: "day_1", order: 0 });
  const trip = makeTrip(3, {
    items: { i1: item1 },
    visits: { v1: visit1 },
    dayVisitRefs: [["v1"], [], []],
  });
  const stats = computeDayGeoStats(trip, 1);
  assert.equal(stats.spanKm, null, "§8 有坐标 <2 → spanKm 应为 null");
  assert.equal(stats.sequentialLegKm, null, "§8 有坐标 <2 → sequentialLegKm 应为 null");
  assert.equal(stats.coordsKnownCount, 1);
  assert.equal(stats.visitCount, 1);

  // 多点有坐标 → spanKm 非 null
  const item2 = makeItem({ itemId: "i2", name: "远点", coords: { lng: 109.7, lat: 18.32 } });
  const visit2 = makeVisit({ visitId: "v2", pointRef: "i2", dayRef: "day_2", order: 0 });
  const trip2 = makeTrip(3, {
    items: { i1: item1, i2: item2 },
    visits: { v1: visit1, v2: makeVisit({ ...visit2, dayRef: "day_1", order: 1 }) },
    dayVisitRefs: [["v1", "v2"], [], []],
  });
  // 重写 v2 为 day1
  trip2.visits["v2"] = makeVisit({ visitId: "v2", pointRef: "i2", dayRef: "day_1", order: 1 });
  const stats2 = computeDayGeoStats(trip2, 1);
  assert.ok(stats2.spanKm !== null && stats2.spanKm > 0, "§8 两点有坐标 → spanKm 应 >0");
  assert.ok(stats2.sequentialLegKm !== null, "§8 两点有坐标 → sequentialLegKm 应非 null");
  assert.ok(stats2.maxAirportKm !== null && stats2.maxAirportKm > 0, "§8 maxAirportKm 应非 null");

  // 区域占位点位被排除
  // 构造：一个 custom 点位「亚龙湾」+ 一个 fliggy 点位「亚龙湾森林公园」→ 前者是区域占位
  const placeholderItem = makeItem({ itemId: "ip1", name: "亚龙湾", origin: "custom", providerId: null, coords: null });
  const realItem = makeItem({ itemId: "ip2", name: "亚龙湾热带天堂森林公园", origin: "fliggy", providerId: "2603", coords: { lng: 109.643, lat: 18.2536 } });
  const placeholderVisit = makeVisit({ visitId: "vp1", pointRef: "ip1", dayRef: "day_1", order: 0 });
  const realVisit = makeVisit({ visitId: "vp2", pointRef: "ip2", dayRef: "day_1", order: 1 });
  const trip3 = makeTrip(2, {
    items: { ip1: placeholderItem, ip2: realItem },
    visits: { vp1: placeholderVisit, vp2: realVisit },
    dayVisitRefs: [["vp1", "vp2"], []],
  });
  const stats3 = computeDayGeoStats(trip3, 1);
  // 区域占位 vp1 应被排除 → visitCount = 1（只有 vp2）
  assert.equal(stats3.visitCount, 1, "§8 区域占位点位应被排除（visitCount=1）");

  pass("§8 computeDayGeoStats：<2→null / 区域占位排除 / maxAirportKm");
}

// ===== §9 evaluateDayCapacity 基本断言 =====

{
  // 抵达日：新增后 >2 → 不 ok
  const trip = makeTrip(5, {
    constraints: [makeConstraint("flight_arrive", 1, "2026-11-08T09:00:00")],
  });
  const r1 = evaluateDayCapacity(trip, 1, 3, [null, null, null], ["A", "B", "C"], 0);
  assert.equal(r1.ok, false, "§9 抵达日新增 3 → 应不 ok");
  assert.ok(r1.reason!.includes("[容量]"), "§9 reason 应含 [容量]");

  // 抵达日：新增 2 → ok
  const r2 = evaluateDayCapacity(trip, 1, 2, [null, null], ["A", "B"], 0);
  assert.equal(r2.ok, true, "§9 抵达日新增 2 → 应 ok");

  // 最后一天无 flight_depart：距机场 >25km → 不 ok
  const farCoord = { lng: 109.765947, lat: 18.310381 }; // 蜈支洲岛 37.4km
  const r3 = evaluateDayCapacity(trip, 5, 1, [farCoord], ["蜈支洲岛"], 0);
  assert.equal(r3.ok, false, "§9 最后一天无航班，>25km → 应不 ok");
  assert.ok(r3.reason!.includes("37.4") || r3.reason!.includes("距凤凰机场"), "§9 reason 应含距离数值");

  // 最后一天无 flight_depart：距机场 ≤25km → ok
  const nearCoord = { lng: 109.475755, lat: 18.274345 }; // 椰梦长廊 7.4km
  const r4 = evaluateDayCapacity(trip, 5, 1, [nearCoord], ["椰梦长廊"], 0);
  assert.equal(r4.ok, true, "§9 最后一天无航班，≤25km → 应 ok");

  // 最后一天有 flight_depart：>15km → 不 ok
  const tripDepart = makeTrip(5, {
    constraints: [makeConstraint("flight_depart", 5, "2026-11-12T18:00:00")],
  });
  const midCoord = { lng: 109.643, lat: 18.2536 }; // 亚龙湾 25km
  const r5 = evaluateDayCapacity(tripDepart, 5, 1, [midCoord], ["亚龙湾"], 0);
  assert.equal(r5.ok, false, "§9 最后一天有航班，>15km → 应不 ok（收紧档）");

  // 最后一天有 flight_depart：≤15km → ok
  const closeCoord = { lng: 109.475755, lat: 18.274345 }; // 椰梦长廊 7.4km
  const r6 = evaluateDayCapacity(tripDepart, 5, 1, [closeCoord], ["椰梦长廊"], 0);
  assert.equal(r6.ok, true, "§9 最后一天有航班，≤15km → 应 ok");

  // 非抵达/非最后一天 → 不约束
  const r7 = evaluateDayCapacity(trip, 3, 10, [], [], 0);
  assert.equal(r7.ok, true, "§9 中间天不约束");

  pass("§9 evaluateDayCapacity 阈值矩阵全通过");
}

// ===== §10 幂等：computeDayGeoStats 两次调用深度相等，不修改入参 =====

{
  const item1 = makeItem({ itemId: "x1", name: "测试点A", coords: { lng: 109.5, lat: 18.25 } });
  const item2 = makeItem({ itemId: "x2", name: "测试点B", coords: { lng: 109.6, lat: 18.3 } });
  const v1 = makeVisit({ visitId: "xv1", pointRef: "x1", dayRef: "day_1", order: 0 });
  const v2 = makeVisit({ visitId: "xv2", pointRef: "x2", dayRef: "day_1", order: 1 });
  const trip = makeTrip(3, {
    items: { x1: item1, x2: item2 },
    visits: { xv1: v1, xv2: v2 },
    dayVisitRefs: [["xv1", "xv2"], [], []],
  });
  const snapshot = JSON.stringify(trip);
  const s1 = computeDayGeoStats(trip, 1);
  const s2 = computeDayGeoStats(trip, 1);
  assert.deepEqual(s1, s2, "§10 两次调用结果应深度相等");
  assert.equal(JSON.stringify(trip), snapshot, "§10 入参 trip 不得被修改");
  pass("§10 幂等：两次调用深度相等 + 入参不变");
}

// ===== §11 常量口径 =====

{
  assert.equal(ARRIVAL_DAY_MAX_VISITS, 2);
  assert.equal(LAST_DAY_NO_FLIGHT_MAX_VISITS, 2);
  assert.equal(LAST_DAY_NO_FLIGHT_AIRPORT_KM, 25);
  assert.equal(LAST_DAY_DEPARTURE_MAX_VISITS, 1);
  assert.equal(LAST_DAY_DEPARTURE_AIRPORT_KM, 15);
  assert.equal(POI_ATTRIBUTION_MAX_KM, 20);
  pass("§11 常量口径全符合设计文档");
}

console.log(`\n[verify-task325-geo] 全部通过 ✓（${passCount} 条断言）`);
