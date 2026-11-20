/** 展示层格式化工具（无 React 依赖，供多个组件复用） */

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** "2026-11-08" → "周日"；非法日期返回空串 */
export function weekdayLabel(date: string): string {
  const parsed = Date.parse(`${date}T00:00:00`);
  if (Number.isNaN(parsed)) return "";
  return WEEKDAYS[new Date(parsed).getDay()];
}

/** "2026-11-08" → "11/08" */
export function shortDate(date: string): string {
  return date.length >= 10 ? `${date.slice(5, 7)}/${date.slice(8, 10)}` : date;
}

/** 今天的本地 ISO 日期 "YYYY-MM-DD" */
export function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** 建议游玩时长文案：180 → "3h"，90 → "1.5h"，40 → "40min"；未知（null）→ "待定" */
export function formatDuration(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return "待定";
  if (minutes < 60) return `${Math.round(minutes)}min`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

/**
 * 「建议 …」标签的取值：只有实际建议时长（正数分钟）才返回文案，
 * 未知（null / 非有限数 / ≤0）返回 null，由调用方决定不渲染该标签，
 * 避免行程卡上出现没有信息量的「建议 待定」。
 */
export function suggestDurationLabel(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return null;
  return formatDuration(minutes);
}

/** 交通方式文案；未知模式原样返回 */
export function formatMode(mode: string): string {
  const known: Record<string, string> = {
    driving: "驾车",
    walking: "步行",
    transit: "公交",
    ferry: "轮渡",
  };
  return known[mode] ?? mode;
}
