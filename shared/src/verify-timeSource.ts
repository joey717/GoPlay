/**
 * Task #281 时间来源标签验证脚本 —— deriveTimeSourceLabels 四状态矩阵 + 优先级 + 同步重算。
 *
 * 运行：npx tsx src/verify-timeSource.ts（shared 目录下）
 *
 * 覆盖场景：
 *  1. 抵达日：flight_arrive 约束 → "按你的到达航班 HH:MM 算"
 *  2. 返程日：flight_depart 约束 → "按回程航班倒推，当天只排机场附近"
 *  3. 手改：departTimeOverridden=true → "你设定"（覆盖航班推算）
 *  4. 普通日：无航班约束且未手改 → null（不显示）
 *  5. 手改优先级：抵达日 + departTimeOverridden → "你设定"（手改覆盖航班）
 *  6. 手改优先级：返程日 + departTimeOverridden → "你设定"
 *  7. 无锚点不显示：无约束的行程全部 null
 *  8. recomputeDerivedFields 写入：timeSourceLabel 落盘到 Day 字段
 *  9. S11 同步重算：改航班约束后 role 与 timeSourceLabel 同一操作内更新
 * 10. 幂等：两次 recomputeDerivedFields 结果深度相等
 * 11. 普通日手改口径（v1.2）：full_play 日 departTimeOverridden=true → "你设定"；未手改 → null
 */

import assert from "node:assert/strict";
import type { Constraint, Day, LodgingPlan, Trip } from "./types/index.js";
import { SCHEMA_VERSION } from "./types/index.js";
import { deriveTimeSourceLabels, recomputeDerivedFields } from "./dayRoles/index.js";
import { deepClone } from "./operations/index.js";

// ===== 最小 Trip 构建工具 =====

function makeDay(dayIndex: number, overrides: Partial<Day> = {}): Day {
  return {
    dayId: `day_${dayIndex}`,
    dayIndex,
    date: `2026-11-${String(dayIndex).padStart(2, "0")}`,
    departTime: null,
    departTimeOverridden: false,
    scheduleVisitRefs: [],
    lodging: null,
    ...overrides,
  };
}

function makeConstraint(type: Constraint["type"], dayIndex: number, anchorTime?: string): Constraint {
  return {
    constraintId: `c_${type}_${dayIndex}`,
    type,
    anchorTime: anchorTime ?? `2026-11-${String(dayIndex).padStart(2, "0")}T10:00:00`,
    dayIndex,
    label: `${type} day${dayIndex}`,
    locked: true,
  };
}

function makeTrip(dayCount: number, constraints: Constraint[], dayOverrides: Record<number, Partial<Day>> = {}): Trip {
  const dayRefs: string[] = [];
  const days: Record<string, Day> = {};
  for (let i = 1; i <= dayCount; i++) {
    dayRefs.push(`day_${i}`);
    days[`day_${i}`] = makeDay(i, dayOverrides[i] ?? {});
  }
  return {
    tripId: "trip_verify_ts",
    schemaVersion: SCHEMA_VERSION,
    version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: `2026-11-${String(7 + dayCount).padStart(2, "0")}`, nights: dayCount - 1 },
    dayRefs,
    days,
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
    constraints,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
  } as Trip;
}

// ===== §1 抵达日 =====
{
  const trip = makeTrip(3, [makeConstraint("flight_arrive", 1, "2026-11-08T09:40:00")]);
  const labels = deriveTimeSourceLabels(trip);
  assert.equal(labels.get(1), "按你的到达航班 09:40 算", "§1: 抵达日应显示航班时间");
  assert.equal(labels.get(2), null, "§1: 普通日应为 null");
  assert.equal(labels.get(3), null, "§1: 普通日应为 null");
  console.log("§1 抵达日 pass");
}

// ===== §2 返程日 =====
{
  const trip = makeTrip(3, [makeConstraint("flight_depart", 3, "2026-11-10T18:00:00")]);
  const labels = deriveTimeSourceLabels(trip);
  assert.equal(labels.get(3), "按回程航班倒推，当天只排机场附近", "§2: 返程日文案");
  assert.equal(labels.get(1), null, "§2: 普通日 null");
  console.log("§2 返程日 pass");
}

// ===== §3 手改 =====
{
  const trip = makeTrip(2, [], { 1: { departTimeOverridden: true, departTime: "08:30" } });
  const labels = deriveTimeSourceLabels(trip);
  assert.equal(labels.get(1), "你设定", "§3: 手改 → 你设定");
  assert.equal(labels.get(2), null, "§3: 未手改普通日 null");
  console.log("§3 手改 pass");
}

// ===== §4 普通日全 null =====
{
  const trip = makeTrip(3, []);
  const labels = deriveTimeSourceLabels(trip);
  for (let i = 1; i <= 3; i++) {
    assert.equal(labels.get(i), null, `§4: Day${i} 普通日 null`);
  }
  console.log("§4 普通日 pass");
}

// ===== §5 手改优先：抵达日 + overridden =====
{
  const trip = makeTrip(2, [makeConstraint("flight_arrive", 1, "2026-11-08T09:40:00")], {
    1: { departTimeOverridden: true },
  });
  const labels = deriveTimeSourceLabels(trip);
  assert.equal(labels.get(1), "你设定", "§5: 手改覆盖抵达日航班推算");
  console.log("§5 手改优先（抵达日）pass");
}

// ===== §6 手改优先：返程日 + overridden =====
{
  const trip = makeTrip(2, [makeConstraint("flight_depart", 2, "2026-11-09T18:00:00")], {
    2: { departTimeOverridden: true },
  });
  const labels = deriveTimeSourceLabels(trip);
  assert.equal(labels.get(2), "你设定", "§6: 手改覆盖返程日");
  console.log("§6 手改优先（返程日）pass");
}

// ===== §7 无锚点不显示 =====
{
  const trip = makeTrip(5, []);
  const labels = deriveTimeSourceLabels(trip);
  for (let i = 1; i <= 5; i++) {
    assert.equal(labels.get(i), null, `§7: Day${i} 无锚点 → null`);
  }
  console.log("§7 无锚点不显示 pass");
}

// ===== §8 recomputeDerivedFields 写入 timeSourceLabel =====
{
  const trip = makeTrip(3, [
    makeConstraint("flight_arrive", 1, "2026-11-08T09:40:00"),
    makeConstraint("flight_depart", 3, "2026-11-10T18:00:00"),
  ]);
  recomputeDerivedFields(trip);
  assert.equal(trip.days["day_1"].timeSourceLabel, "按你的到达航班 09:40 算", "§8: 抵达日 label 落盘");
  assert.equal(trip.days["day_2"].timeSourceLabel, null, "§8: 普通日 label=null");
  assert.equal(trip.days["day_3"].timeSourceLabel, "按回程航班倒推，当天只排机场附近", "§8: 返程日 label 落盘");
  // role 也同步写入
  assert.equal(trip.days["day_1"].role, "arrival", "§8: role=arrival");
  assert.equal(trip.days["day_3"].role, "departure", "§8: role=departure");
  console.log("§8 recomputeDerivedFields 写入 pass");
}

// ===== §9 S11 同步重算：改航班约束后 role 与 label 同操作更新 =====
{
  const trip = makeTrip(3, [makeConstraint("flight_arrive", 1, "2026-11-08T09:40:00")]);
  recomputeDerivedFields(trip);
  assert.equal(trip.days["day_1"].role, "arrival");
  assert.equal(trip.days["day_1"].timeSourceLabel, "按你的到达航班 09:40 算");
  assert.equal(trip.days["day_3"].role, "full_play");
  assert.equal(trip.days["day_3"].timeSourceLabel, null);

  // 模拟改航班：把 flight_arrive 从 Day1 移到 Day3（同一操作内）
  trip.constraints = [makeConstraint("flight_arrive", 3, "2026-11-10T14:00:00")];
  recomputeDerivedFields(trip);

  // Day1 不再是抵达日
  assert.equal(trip.days["day_1"].role, "full_play", "§9: 改约束后 Day1 role 更新");
  assert.equal(trip.days["day_1"].timeSourceLabel, null, "§9: 改约束后 Day1 label 清除（无 stale）");
  // Day3 变为抵达日
  assert.equal(trip.days["day_3"].role, "arrival", "§9: 改约束后 Day3 role=arrival");
  assert.equal(trip.days["day_3"].timeSourceLabel, "按你的到达航班 14:00 算", "§9: 改约束后 Day3 label 同步更新");
  console.log("§9 S11 同步重算 pass");
}

// ===== §10 幂等 =====
{
  const trip = makeTrip(3, [
    makeConstraint("flight_arrive", 1, "2026-11-08T09:40:00"),
    makeConstraint("flight_depart", 3, "2026-11-10T18:00:00"),
  ], { 2: { departTimeOverridden: true } });
  const first = recomputeDerivedFields(deepClone(trip));
  const second = recomputeDerivedFields(deepClone(first));
  for (const dayId of first.dayRefs) {
    assert.equal(first.days[dayId].timeSourceLabel, second.days[dayId].timeSourceLabel, `§10: ${dayId} 幂等`);
    assert.equal(first.days[dayId].role, second.days[dayId].role, `§10: ${dayId} role 幂等`);
  }
  console.log("§10 幂等 pass");
}

// ===== §11 普通日手改口径（v1.2：手改不限锚点日）=====
{
  // Day2 既非抵达日也非返程日（role=full_play），仅 departTimeOverridden=true
  const trip = makeTrip(3, [makeConstraint("flight_arrive", 1, "2026-11-08T09:40:00")], {
    2: { departTimeOverridden: true, departTime: "09:00" },
  });
  recomputeDerivedFields(trip);
  // 断言 Day2 确为普通日（full_play），排除"其实是锚点日"的歧义
  assert.equal(trip.days["day_2"].role, "full_play", "§11: Day2 应为普通日 full_play");
  assert.equal(trip.days["day_2"].timeSourceLabel, "你设定", "§11: 普通日 + 手改 → 显示'你设定'（不限锚点日）");
  // Day3 普通日且未手改 → null
  assert.equal(trip.days["day_3"].role, "full_play", "§11: Day3 普通日");
  assert.equal(trip.days["day_3"].timeSourceLabel, null, "§11: 普通日无手改 → null（不显示）");
  console.log("§11 普通日手改口径 pass");
}

console.log("\n✅ verify-timeSource 全部 11 组断言通过");
