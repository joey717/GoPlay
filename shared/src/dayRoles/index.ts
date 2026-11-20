/**
 * 天角色派生模块（Task #280 S10/S11 + Task #281 S5 参赛必须）。
 *
 * 职责边界：
 * - deriveDayRoles(trip)：纯函数，按航班约束＋锁定酒店锚点推导每天角色；
 * - deriveTimeSourceLabels(trip)：纯函数，按 departTimeOverridden＋航班约束
 *   生成时间来源灰字文案（四状态：手改/抵达/返程/null）；
 * - recomputeDerivedFields(trip)：单一钩子，就地写入 role + timeSourceLabel；
 * - 派生数据红线：role / timeSourceLabel 由本模块唯一写入，任何 op / 外部输入
 *   不得手改——applyOps 与 tripStore.save 均在最终态调用 recomputeDerivedFields
 *   覆盖，外部传入的值一律被派生结果替换（忽略而非拒绝，保持操作原子性）。
 *
 * 角色优先级（v1.2 拍板）：返程 ＞ 抵达 ＞ 换区 ＞ 完整游玩。
 * 同一天命中多个角色时取最高优先级；不臆造锚点——无到达航班则无抵达日、
 * 无回程航班则无返程日、无锁定/已订 lodging 区域锚点则不推导换区。
 *
 * 锚点定义：
 * - 航班锚点：trip.constraints 中 type=flight_arrive / flight_depart 的条目，
 *   按 dayIndex 定位到天（与 ConstraintEditor 录入路径一致）；
 * - 住宿锚点：trip.lodgings[String(dayIndex)] 存在且（locked=true 或
 *   purchaseState="bought"）且 areaName 为非空字符串——只有用户确认过的
 *   住宿区域才作为换区判定依据，placeholder / unknown 状态不参与。
 *
 * 换区日判定（确定性口径）：当日夜宿区域与前一夜不同。即 day N 与 day N-1
 * 同时具备住宿锚点且 areaName 不同时，day N 为换区日；任一侧缺锚点则
 * 不推导换区（该天按剩余优先级降级为完整游玩日）。
 *
 * 幂等与迁移铁律：
 * - recomputeDerivedFields 就地修改并返回同一对象（与 migrateV1toV2 同模式）；
 * - 多次执行结果深度相等（派生函数确定性，无随机 / 时间依赖）；
 * - 旧 Trip 缺失 role 字段：读时经 recomputeDerivedFields 补齐，不提升
 *   schemaVersion（可选派生字段，与 guideSources 同模式）。
 */

import type { DayRole, Trip } from "../types/index.js";

/**
 * 时间来源标签纯函数（Task #281，S5 参赛必须）。
 *
 * 四状态文案（v1.2 拍板口径）：
 * 1. 手改（departTimeOverridden=true）→ "你设定"（优先级最高，覆盖航班推算；
 *    **不限锚点日**——普通日手改同样显示"你设定"，与产品口径"手改后该 Day 时间行
 *    显示'你设定'"一致）
 * 2. 抵达日（flight_arrive 约束命中且未手改）→ "按你的到达航班 HH:MM 算"
 * 3. 返程日（flight_depart 约束命中且未手改）→ "按回程航班倒推，当天只排机场附近"
 * 4. 普通日且未手改 → null（不显示）
 *
 * 返回 Map<dayIndex, string|null>，覆盖行程内全部天。
 */
export function deriveTimeSourceLabels(trip: Trip): Map<number, string | null> {
  const labels = new Map<number, string | null>();
  const dayRefs = trip.dayRefs ?? [];
  const totalDays = dayRefs.length;

  // 收集航班约束的 anchorTime（按 dayIndex 索引）
  const arriveTimeByDay = new Map<number, string>();
  const departDaySet = new Set<number>();
  for (const constraint of trip.constraints ?? []) {
    if (!Number.isInteger(constraint.dayIndex) || constraint.dayIndex < 1 || constraint.dayIndex > totalDays) {
      continue;
    }
    if (constraint.type === "flight_arrive") {
      // anchorTime 格式 "2026-11-08T09:40:00" → 提取 HH:MM
      const timePart = extractHHMM(constraint.anchorTime);
      if (timePart !== null) {
        arriveTimeByDay.set(constraint.dayIndex, timePart);
      }
    } else if (constraint.type === "flight_depart") {
      departDaySet.add(constraint.dayIndex);
    }
  }

  for (const dayId of dayRefs) {
    const day = trip.days[dayId];
    if (day === undefined) continue;
    const dayIndex = day.dayIndex;

    // 优先级 1：手改覆盖一切
    if (day.departTimeOverridden) {
      labels.set(dayIndex, "你设定");
      continue;
    }
    // 优先级 2：抵达日（有 flight_arrive 约束且能提取时间）
    const arriveTime = arriveTimeByDay.get(dayIndex);
    if (arriveTime !== undefined) {
      labels.set(dayIndex, `按你的到达航班 ${arriveTime} 算`);
      continue;
    }
    // 优先级 3：返程日
    if (departDaySet.has(dayIndex)) {
      labels.set(dayIndex, "按回程航班倒推，当天只排机场附近");
      continue;
    }
    // 优先级 4：普通日且未手改，不显示灰字
    labels.set(dayIndex, null);
  }

  return labels;
}

/** 从 ISO datetime 字符串提取 HH:MM（"2026-11-08T09:40:00" → "09:40"） */
function extractHHMM(anchorTime: string): string | null {
  if (typeof anchorTime !== "string") return null;
  const match = anchorTime.match(/T(\d{2}:\d{2})/);
  return match !== null ? match[1] : null;
}

// ===== Task #323：返程日（行程最后一天）行程截止时间派生 =====

/** 无返程机票时间时的默认行程截止（PD 口径：最后一天行程到 15:00 结束） */
export const DEFAULT_LAST_DAY_CUTOFF = "15:00";

/** 有返程机票时间时的提前量（PD 口径：起飞时间 − 3 小时作为行程截止参考） */
export const FLIGHT_CUTOFF_LEAD_MINUTES = 180;

/**
 * 返程日行程截止时间（Task #323，纯函数，不修改入参）。
 *
 * PD 口径：
 * 1. 最后一天无 flight_depart 约束（用户未设定离开/机票时间）→ "15:00"（source="default"）；
 * 2. 最后一天有 flight_depart 约束且 anchorTime 可解析 → 起飞时间 − 3 小时
 *    （source="flight"；凌晨航班倒推跨天按 24h 取模，与 timeline.formatTime 同口径）；
 * 3. flight_depart 存在但 anchorTime 非法（脏数据）→ 按未设定降级 "15:00"；
 * 4. 空行程（dayRefs 缺失）→ null。
 *
 * 消费边界：本函数只提供截止时间参考，不改变 timeline 语义（时间轴不做硬截断，
 * 约束越界由上层提示）；planner prompt 的返程日截止软规则与本函数同口径。
 */
export function deriveDepartureDayCutoff(
  trip: Trip,
): { cutoffTime: string; source: "flight" | "default" } | null {
  const totalDays = (trip.dayRefs ?? []).length;
  if (totalDays === 0) return null;

  // 只看最后一天的 flight_depart（与 deriveDayRoles 同口径：越界 dayIndex 忽略；
  // 多条命中取最晚起飞时间，截止参考以最晚航班为准）
  let departMinutes: number | null = null;
  for (const constraint of trip.constraints ?? []) {
    if (constraint.type !== "flight_depart") continue;
    if (!Number.isInteger(constraint.dayIndex) || constraint.dayIndex < 1 || constraint.dayIndex > totalDays) {
      continue;
    }
    if (constraint.dayIndex !== totalDays) continue;
    const hhmm = extractHHMM(constraint.anchorTime);
    if (hhmm === null) continue;
    const [hours, minutes] = hhmm.split(":").map(Number);
    const total = hours * 60 + minutes;
    if (departMinutes === null || total > departMinutes) departMinutes = total;
  }

  if (departMinutes === null) {
    return { cutoffTime: DEFAULT_LAST_DAY_CUTOFF, source: "default" };
  }
  const cutoff = ((departMinutes - FLIGHT_CUTOFF_LEAD_MINUTES) % 1440 + 1440) % 1440;
  const hh = String(Math.floor(cutoff / 60)).padStart(2, "0");
  const mm = String(cutoff % 60).padStart(2, "0");
  return { cutoffTime: `${hh}:${mm}`, source: "flight" };
}

/**
 * 推导每天角色（纯函数，不修改入参）。
 * 返回 Map<dayIndex, DayRole>，覆盖行程内全部天（1..dayRefs.length）。
 *
 * 算法：
 * 1. 收集航班锚点：flight_depart → departure 集合，flight_arrive → arrival 集合；
 * 2. 收集住宿锚点区域：locked/bought 且 areaName 非空的 lodging → areaByDay；
 * 3. 逐天按优先级判定：
 *    - departure 集合命中 → "departure"；
 *    - arrival 集合命中 → "arrival"；
 *    - 当天与前一天均有住宿锚点且区域不同 → "transit"；
 *    - 其余 → "full_play"。
 */
export function deriveDayRoles(trip: Trip): Map<number, DayRole> {
  const roles = new Map<number, DayRole>();
  const totalDays = (trip.dayRefs ?? []).length;

  // 1. 航班锚点（按 dayIndex 定位；越界 dayIndex 忽略——约束录入已校验范围）
  const departureDays = new Set<number>();
  const arrivalDays = new Set<number>();
  for (const constraint of trip.constraints ?? []) {
    if (!Number.isInteger(constraint.dayIndex) || constraint.dayIndex < 1 || constraint.dayIndex > totalDays) {
      continue;
    }
    if (constraint.type === "flight_depart") {
      departureDays.add(constraint.dayIndex);
    } else if (constraint.type === "flight_arrive") {
      arrivalDays.add(constraint.dayIndex);
    }
  }

  // 2. 住宿锚点区域（只有 locked / bought 且 areaName 非空才作为换区依据）
  const areaByDay = new Map<number, string>();
  const lodgings = trip.lodgings ?? {};
  for (let dayIndex = 1; dayIndex <= totalDays; dayIndex++) {
    const lodging = lodgings[String(dayIndex)];
    if (lodging === undefined) continue;
    const isAnchored = lodging.locked === true || lodging.purchaseState === "bought";
    if (!isAnchored) continue;
    const area = typeof lodging.areaName === "string" ? lodging.areaName.trim() : "";
    if (area === "") continue;
    areaByDay.set(dayIndex, area);
  }

  // 3. 逐天按优先级判定
  for (let dayIndex = 1; dayIndex <= totalDays; dayIndex++) {
    let role: DayRole;
    if (departureDays.has(dayIndex)) {
      role = "departure";
    } else if (arrivalDays.has(dayIndex)) {
      role = "arrival";
    } else {
      const currentArea = areaByDay.get(dayIndex);
      const previousArea = areaByDay.get(dayIndex - 1);
      if (currentArea !== undefined && previousArea !== undefined && currentArea !== previousArea) {
        role = "transit";
      } else {
        role = "full_play";
      }
    }
    roles.set(dayIndex, role);
  }

  return roles;
}

/**
 * 派生字段重算钩子（单一入口）：就地写入 Day.role 并返回同一对象。
 *
 * 调用时机（同一操作内重算落盘，S11 口径）：
 * - tripStore.save：落盘前统一重算（覆盖外部传入的任何 role 值）；
 * - tripStore.load：读时迁移路径补齐旧 Trip 缺失的 role；
 * - applyOps：操作集应用后、一致性校验前重算（锚点变更同操作同步）；
 * - buildFixtureSanyaTrip：夹具生成后预填（验收断言依赖）。
 *
 * 派生数据红线：外部（客户端 / op）写入的 role 一律被本函数覆盖，
 * 不存在「手改 role」的合法路径——guards 层无需额外拒绝逻辑，
 * 因为 recomputeDerivedFields 在最终态必然执行。
 */
export function recomputeDerivedFields(trip: Trip): Trip {
  const roles = deriveDayRoles(trip);
  const dayRefs = trip.dayRefs ?? [];
  for (const dayId of dayRefs) {
    const day = trip.days[dayId];
    if (day === undefined) continue;
    const role = roles.get(day.dayIndex);
    // 派生结果写入； undefined 兜底 full_play（理论上不会发生，roles 覆盖全部天）
    day.role = role ?? "full_play";
  }

  // ===== Task #281：时间来源标签派生（S5 参赛必须） =====
  // 按 role + departTimeOverridden + 航班约束生成人话文案，写入 Day.timeSourceLabel。
  // 与 role 同一次 recomputeDerivedFields 调用内完成（S11：锚点变更同操作同步重算）。
  const timeLabels = deriveTimeSourceLabels(trip);
  for (const dayId of dayRefs) {
    const day = trip.days[dayId];
    if (day === undefined) continue;
    const label = timeLabels.get(day.dayIndex);
    day.timeSourceLabel = label ?? null;
  }

  return trip;
}
