/**
 * Task #280 天角色派生验证脚本 —— deriveDayRoles 全角色矩阵 + 迁移幂等。
 *
 * 运行：npx tsx src/verify-dayRoles.ts（shared 目录下）
 *
 * 覆盖场景：
 *  1. 基础矩阵：抵达日 / 返程日 / 换区日 / 完整游玩日各自独立命中；
 *  2. 优先级冲突：同一天同时有 flight_depart + flight_arrive → departure 胜出；
 *  3. 无锚点 fallback：无航班、无锁定 lodging → 全部 full_play；
 *  4. 换区链：连续多天区域变化（A→B→C）→ 中间天均为 transit；
 *  5. 换区锚点门槛：lodging 存在但 locked=false 且 purchaseState≠bought → 不推导换区；
 *  6. 换区 areaName 为空/缺失 → 不推导换区；
 *  7. 首日无前一天 → 不推导换区（即使首天有锚点区域）；
 *  8. recomputeDerivedFields 幂等：两次执行结果深度相等；
 *  9. recomputeDerivedFields 覆盖外部写入的 role（派生数据红线）；
 * 10. 越界 constraint.dayIndex 被忽略（不崩溃、不影响其他天）。
 */

import assert from "node:assert/strict";
import type { Constraint, Day, DayRole, LodgingPlan, Trip } from "./types/index.js";
import { SCHEMA_VERSION } from "./types/index.js";
import { deriveDayRoles, recomputeDerivedFields } from "./dayRoles/index.js";
import { deepClone } from "./operations/index.js";

// ===== 最小 Trip 构建工具 =====

function makeDay(dayIndex: number): Day {
  return {
    dayId: `day_${dayIndex}`,
    dayIndex,
    date: `2026-11-${String(dayIndex).padStart(2, "0")}`,
    departTime: null,
    departTimeOverridden: false,
    scheduleVisitRefs: [],
    lodging: null,
  };
}

function makeLodging(dayIndex: number, areaName: string | null, locked: boolean, purchaseState: "unknown" | "toBuy" | "bought"): LodgingPlan {
  return {
    dayIndex,
    areaName,
    hotelRefs: [],
    checkInTime: null,
    checkOutTime: null,
    purchaseState,
    locked,
    userAdjusted: false,
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

function makeTrip(totalDays: number, constraints: Constraint[] = [], lodgings: Record<string, LodgingPlan> = {}): Trip {
  const dayRefs: string[] = [];
  const days: Record<string, Day> = {};
  for (let i = 1; i <= totalDays; i++) {
    const dayId = `day_${i}`;
    dayRefs.push(dayId);
    days[dayId] = makeDay(i);
  }
  return {
    tripId: "trip_verify_roles",
    schemaVersion: SCHEMA_VERSION,
    version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-01", end: `2026-11-${String(totalDays).padStart(2, "0")}`, nights: totalDays - 1 },
    dayRefs,
    days,
    lodgings,
    hotelRegistry: {},
    guideSources: {},
    itemRegistry: {},
    visits: {},
    stops: {},
    evidences: {},
    globalCandidateRefs: [],
    pendingStopRefs: [],
    relationshipSuggestions: {},
    constraints,
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-28T00:00:00.000Z",
  };
}

// ===== §1 基础矩阵 =====

{
  const trip = makeTrip(5, [
    makeConstraint("flight_arrive", 1),
    makeConstraint("flight_depart", 5),
  ]);
  const roles = deriveDayRoles(trip);
  assert.equal(roles.get(1), "arrival", "§1: Day1 有 flight_arrive → arrival");
  assert.equal(roles.get(2), "full_play", "§1: Day2 无锚点 → full_play");
  assert.equal(roles.get(3), "full_play", "§1: Day3 无锚点 → full_play");
  assert.equal(roles.get(4), "full_play", "§1: Day4 无锚点 → full_play");
  assert.equal(roles.get(5), "departure", "§1: Day5 有 flight_depart → departure");
  console.log("§1 基础矩阵 pass");
}

// ===== §2 优先级冲突：departure > arrival =====

{
  const trip = makeTrip(3, [
    makeConstraint("flight_arrive", 2),
    makeConstraint("flight_depart", 2),
  ]);
  const roles = deriveDayRoles(trip);
  assert.equal(roles.get(2), "departure", "§2: 同天 arrive+depart → departure 优先");
  console.log("§2 优先级冲突 pass");
}

// ===== §3 无锚点 fallback =====

{
  const trip = makeTrip(4);
  const roles = deriveDayRoles(trip);
  for (let i = 1; i <= 4; i++) {
    assert.equal(roles.get(i), "full_play", `§3: Day${i} 无任何锚点 → full_play`);
  }
  console.log("§3 无锚点 fallback pass");
}

// ===== §4 换区链 =====

{
  const trip = makeTrip(4, [], {
    "1": makeLodging(1, "海棠湾", true, "unknown"),
    "2": makeLodging(2, "亚龙湾", true, "unknown"),
    "3": makeLodging(3, "三亚湾", false, "bought"),
    "4": makeLodging(4, "三亚湾", true, "unknown"),
  });
  const roles = deriveDayRoles(trip);
  assert.equal(roles.get(1), "full_play", "§4: Day1 无前一天 → full_play");
  assert.equal(roles.get(2), "transit", "§4: Day2 海棠湾→亚龙湾 → transit");
  assert.equal(roles.get(3), "transit", "§4: Day3 亚龙湾→三亚湾 → transit");
  assert.equal(roles.get(4), "full_play", "§4: Day4 三亚湾→三亚湾 同区域 → full_play");
  console.log("§4 换区链 pass");
}

// ===== §5 换区锚点门槛：locked=false 且 purchaseState≠bought → 不推导 =====

{
  const trip = makeTrip(3, [], {
    "1": makeLodging(1, "海棠湾", false, "unknown"),
    "2": makeLodging(2, "亚龙湾", false, "toBuy"),
    "3": makeLodging(3, "三亚湾", true, "unknown"),
  });
  const roles = deriveDayRoles(trip);
  assert.equal(roles.get(2), "full_play", "§5: Day1/Day2 lodging 均未锁定/已订 → 不推导换区");
  assert.equal(roles.get(3), "full_play", "§5: Day2 无锚点 → Day3 即使有锚点也无法比较 → full_play");
  console.log("§5 换区锚点门槛 pass");
}

// ===== §6 areaName 为空/缺失 → 不推导换区 =====

{
  const trip = makeTrip(3, [], {
    "1": makeLodging(1, null, true, "unknown"),
    "2": makeLodging(2, "  ", true, "bought"),
    "3": makeLodging(3, "亚龙湾", true, "unknown"),
  });
  const roles = deriveDayRoles(trip);
  assert.equal(roles.get(2), "full_play", "§6: Day1 areaName=null → 无锚点 → Day2 不推导换区");
  assert.equal(roles.get(3), "full_play", "§6: Day2 areaName 空白 → 无锚点 → Day3 不推导换区");
  console.log("§6 areaName 空值 pass");
}

// ===== §7 首日不推导换区 =====

{
  const trip = makeTrip(2, [], {
    "1": makeLodging(1, "海棠湾", true, "bought"),
    "2": makeLodging(2, "亚龙湾", true, "bought"),
  });
  const roles = deriveDayRoles(trip);
  assert.equal(roles.get(1), "full_play", "§7: 首日无前一天 → 即使有锚点也不推导换区");
  assert.equal(roles.get(2), "transit", "§7: Day2 海棠湾→亚龙湾 → transit");
  console.log("§7 首日不推导换区 pass");
}

// ===== §8 recomputeDerivedFields 幂等 =====

{
  const trip = makeTrip(4, [
    makeConstraint("flight_arrive", 1),
    makeConstraint("flight_depart", 4),
  ], {
    "1": makeLodging(1, "海棠湾", true, "unknown"),
    "2": makeLodging(2, "亚龙湾", true, "bought"),
    "3": makeLodging(3, "亚龙湾", true, "unknown"),
  });

  const first = recomputeDerivedFields(deepClone(trip));
  const second = recomputeDerivedFields(deepClone(first));

  for (const dayId of first.dayRefs) {
    assert.equal(first.days[dayId].role, second.days[dayId].role, `§8: Day ${dayId} 幂等`);
  }
  assert.equal(first.days["day_1"].role, "arrival");
  assert.equal(first.days["day_2"].role, "transit");
  assert.equal(first.days["day_3"].role, "full_play");
  assert.equal(first.days["day_4"].role, "departure");
  console.log("§8 recomputeDerivedFields 幂等 pass");
}

// ===== §9 覆盖外部写入的 role（派生数据红线）=====

{
  const trip = makeTrip(3, [makeConstraint("flight_arrive", 1)]);
  // 模拟外部恶意写入
  trip.days["day_1"].role = "departure";
  trip.days["day_2"].role = "transit";
  trip.days["day_3"].role = "arrival";

  recomputeDerivedFields(trip);

  assert.equal(trip.days["day_1"].role, "arrival", "§9: 外部写入 departure 被派生覆盖为 arrival");
  assert.equal(trip.days["day_2"].role, "full_play", "§9: 外部写入 transit 被派生覆盖为 full_play");
  assert.equal(trip.days["day_3"].role, "full_play", "§9: 外部写入 arrival 被派生覆盖为 full_play");
  console.log("§9 派生数据红线 pass");
}

// ===== §10 越界 constraint.dayIndex 被忽略 =====

{
  const trip = makeTrip(3, [
    makeConstraint("flight_arrive", 0),   // 越界（< 1）
    makeConstraint("flight_depart", 99),  // 越界（> totalDays）
    makeConstraint("flight_arrive", 2),   // 合法
  ]);
  const roles = deriveDayRoles(trip);
  assert.equal(roles.get(1), "full_play", "§10: 越界 arrive(0) 被忽略 → Day1 full_play");
  assert.equal(roles.get(2), "arrival", "§10: 合法 arrive(2) → Day2 arrival");
  assert.equal(roles.get(3), "full_play", "§10: 越界 depart(99) 被忽略 → Day3 full_play");
  console.log("§10 越界 dayIndex 忽略 pass");
}

console.log("\n✅ verify-dayRoles 全部 10 组断言通过");
