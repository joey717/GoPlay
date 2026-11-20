import type { Trip } from "@goplay/shared";

/** 行程相对今天的阶段：出发前 / 行中（含首尾两天）/ 行后 */
export type TripPhase = "before" | "during" | "after";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** "2026-11-08" → 本地午夜的 Date；非法日期返回 null。
 *  必须补 T00:00:00 按本地时间解析：裸 ISO 串会被当作 UTC 午夜，在偏西时区 setHours(0,0,0,0) 后会偏早一天。 */
function parseLocalDate(iso: string): Date | null {
  const time = Date.parse(`${iso}T00:00:00`);
  return Number.isNaN(time) ? null : new Date(time);
}

/** 今天零点（本地时区） */
function startOfToday(): Date {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

/** 行程阶段；日期字段非法时按行后处理（不加倒计时等特殊文案） */
export function getTripPhase(trip: Trip): TripPhase {
  const start = parseLocalDate(trip.dateRange.start);
  const end = parseLocalDate(trip.dateRange.end);
  if (!start || !end) return "after";
  const today = startOfToday();
  if (today < start) return "before";
  if (today > end) return "after";
  return "during";
}

/** 距离出发还有几天（出发前为正数；按零点对齐后差值是整天，round 防御异常时钟偏移） */
export function getDaysUntilStart(trip: Trip): number {
  const start = parseLocalDate(trip.dateRange.start);
  if (!start) return 0;
  return Math.round((start.getTime() - startOfToday().getTime()) / MS_PER_DAY);
}

/** 空天标题：出发前给出发倒计时引导；行中/行后为通用空态，不再误称「今天」 */
export function emptyDayTitle(trip: Trip): string {
  if (getTripPhase(trip) === "before") {
    return `距离出发还有 ${getDaysUntilStart(trip)} 天，安排行程吧~`;
  }
  return "这天还没有安排行程";
}
