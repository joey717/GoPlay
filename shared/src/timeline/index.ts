/**
 * shared 时间轴计算模块 —— PRD v1.1 §8.1「城市级时间轴」的唯一实现。
 *
 * 城市级公式（只遍历 Day.scheduleVisitRefs，大景区只出现一次）：
 *   computedArrival(1) = day.departTime + externalLeg(1).minutes
 *   computedArrival(i) = visit.endTime(i-1) + externalLeg(i).minutes
 *   visit.startTime = startTimeOverridden ? savedStartTime
 *                   : windowStart ? windowStart
 *                   : computedArrival
 *   visit.effectiveMinutes = reservedMinutes
 *                         ?? itemRegistry[pointRef].suggestMinutes
 *                         ?? (childStopRefs 全部时长已知 ? sum(childStop suggestMinutes) : unknown)
 *   visit.endTime = endTimeOverridden ? savedEndTime
 *                 : windowEnd ? windowEnd
 *                 : (startTime 与 effectiveMinutes 均已知 ? startTime + effectiveMinutes : unknown)
 *
 * 语义要点：
 * - 优先级固定：用户覆写 > 明确窗口 > 系统计算（PRD §8.1），不悄悄修正冲突；
 * - externalLeg 只到景区入口（挂在 Visit 上），Stop 无交通字段、不生成/展示开始时间；
 *   大景区在城市路线只出现一次，城市交通只计算一次（PRD §7.2 / 任务 #48 D）；
 * - Stop 建议时长通过 effectiveMinutes 汇总参与（备选玩法 alternate 不参与游玩时长）；
 * - 任一必要输入未知（departTime / externalLeg.minutes / effectiveMinutes）不得当作 0：
 *   该节点及其后续显示时间待定，直到出现新锚点（覆写值或窗口）或补足数据；
 * - 纯函数、不可变：只重算传入的那一天涉及的 Visit，其余逐字段保持不动；
 *   局部重算边界（PRD §8.3）：调用方只对受影响的天调用本函数；
 * - lodging 边界（rev2，Task #81）：时间链与住宿酒店状态无关——本模块不读取 deprecated
 *   的 hotelCandidate / status；「当天是否有酒店」由消费方按
 *   LodgingPlan.hotelRefs.length > 0 判断、酒店详情经 trip.hotelRegistry[hotelRef]
 *   解析（ops / UI 层消费）；多候选（hotelRefs.length > 1）对时间链无行为影响，
 *   S3 阶段才消费；
 * - constraint 边界保持 v1.0 语义：时间轴不做硬截断，约束越界由上层提示。
 */

import type { Day, Trip, Visit } from "../types/index.js";

const MINUTES_PER_DAY = 24 * 60;

/**
 * "HH:MM" → 从 00:00 起的分钟数（如 "09:30" → 570）。
 * 接受 1-2 位小时（如 "9:05"）；格式非法或超出 23:59 时返回 NaN。
 */
export function parseTime(time: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (match === null) return Number.NaN;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return Number.NaN;
  return hours * 60 + minutes;
}

/**
 * 分钟数 → "HH:MM"。
 * 跨天按 24 小时取模（对齐 DEMO 的 fmt：22:00 之后 5 小时显示 "03:00"）；
 * 非有限数返回 "--:--"（显示占位，与缺失时间约定一致）。
 */
export function formatTime(minutes: number): string {
  if (!Number.isFinite(minutes)) return "--:--";
  const wrapped = ((Math.trunc(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours = Math.floor(wrapped / 60);
  const mins = wrapped % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

/** 解析可空时间字段：null / 空串 / 非法格式 → null（脏数据防御，按未提供处理） */
function parseOptionalTime(value: string | null): number | null {
  if (value === null || value === "") return null;
  const parsed = parseTime(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Visit 实际生效时长（分钟）；null = 待定。
 * 回退顺序（PRD §8.1）：reservedMinutes → itemRegistry[pointRef].suggestMinutes
 * → 大景区 childStopRefs 全部时长已知时求和（备选玩法不参与游玩时长）；
 * childStopRefs 为空且前两级都缺时为待定，不产生 0。
 */
export function resolveEffectiveMinutes(visit: Visit, trip: Trip): number | null {
  if (visit.reservedMinutes != null) return visit.reservedMinutes;
  const item = trip.itemRegistry[visit.pointRef];
  if (item !== undefined && item.suggestMinutes != null) return item.suggestMinutes;
  if (visit.childStopRefs.length === 0) return null;
  let sum = 0;
  for (const stopId of visit.childStopRefs) {
    const stop = trip.stops[stopId];
    if (stop === undefined || stop.suggestMinutes == null) return null; // 任一未知 → 整体待定
    sum += stop.suggestMinutes;
  }
  return sum;
}

/**
 * 重算单天时间轴，返回新的 Trip（不改动入参；只替换该天涉及的 Visit 条目）。
 *
 * 规则：
 * - 只处理 Day.scheduleVisitRefs 中的城市级 Visit；Stop 不生成开始时间；
 * - departTime 只作为锚点读取、绝不覆盖（departTimeOverridden=true 同样如此）；
 * - departTime 缺失/非法时无锚点：无覆写/窗口的 Visit 时间待定；
 * - startTimeOverridden / endTimeOverridden 且值有效的 Visit 保留用户手改值，
 *   并作为新锚点让后续节点从其 endTime 继续累加；
 * - externalLeg 为 null 视为 0 分钟；存在但 minutes=null 表示该段交通待定，
 *   到达时间待定并沿链传播，直到新锚点（覆写/窗口）出现；
 * - dayIndex 超界或该天无 Visit 时原样返回同一引用。
 */
export function recomputeDayTimeline(trip: Trip, dayIndex: number): Trip {
  if (!Number.isInteger(dayIndex) || dayIndex < 1 || dayIndex > trip.dayRefs.length) return trip;
  const day = trip.days[trip.dayRefs[dayIndex - 1]];
  if (day === undefined || day.scheduleVisitRefs.length === 0) return trip;

  const nextVisits = { ...trip.visits };
  const departMinutes = parseOptionalTime(day.departTime);
  let cursor: number | null = departMinutes;

  for (const visitId of day.scheduleVisitRefs) {
    const visit = trip.visits[visitId];
    if (visit === undefined) continue; // 悬空引用由 validateConsistency 兜底

    // 到达时间 = 上一节点结束时间 + 本段城市交通（externalLeg 只到景区入口）
    const legMinutes = visit.externalLeg === null ? 0 : visit.externalLeg.minutes;
    const arrival = cursor === null || legMinutes === null ? null : cursor + legMinutes;

    // startTime 优先级：用户覆写 > 明确窗口 > 系统计算
    const overrideStart = visit.startTimeOverridden ? parseOptionalTime(visit.startTime) : null;
    const windowStart = parseOptionalTime(visit.windowStart);
    const startMin = overrideStart ?? windowStart ?? arrival;

    // effectiveMinutes：reserved → item → childStops 汇总（未知为 null，不当作 0）
    const effective = resolveEffectiveMinutes(visit, trip);

    // endTime 优先级：用户覆写 > 明确窗口 > startTime + effectiveMinutes
    const overrideEnd = visit.endTimeOverridden ? parseOptionalTime(visit.endTime) : null;
    const windowEnd = parseOptionalTime(visit.windowEnd);
    const endMin =
      overrideEnd ??
      windowEnd ??
      (startMin !== null && effective !== null ? startMin + effective : null);

    // 下一节点从本节点结束时间继续累加；endTime 亦为锚点（覆写/窗口可恢复后续链条）
    cursor = endMin;

    nextVisits[visitId] = {
      ...visit,
      startTime: startMin === null ? null : formatTime(startMin),
      endTime: endMin === null ? null : formatTime(endMin),
      effectiveMinutes: effective,
    };
  }

  return { ...trip, visits: nextVisits };
}

/** 兼容导出：按 Day 对象直接重算（等价于 recomputeDayTimeline(trip, day.dayIndex)） */
export function recomputeTimelineForDay(trip: Trip, day: Day): Trip {
  return recomputeDayTimeline(trip, day.dayIndex);
}
