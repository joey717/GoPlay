/**
 * Task #257：行程封面 / 名称 / 备忘的展示与契约纯函数（无 React 依赖）。
 *
 * 设计口径：
 * - Trip 三字段全部可选，**读时兼容**：缺失 / 空串一律按「空值」处理，
 *   不写迁移脚本、不提升 schemaVersion（见 shared Trip 注释）；
 * - 名称 / 备忘的写入统一走 normalize*（限长按 Unicode 码点计数，避免截断 emoji
 *   产生半个代理对），空串 = 清除字段（等价于缺字段）；
 * - 封面路径统一换算为受控读取地址 `/api/{path}`，并带 `v=` 版本参数击穿
 *   浏览器缓存（同格式更换封面时路径不变，否则会继续显示旧图）；
 * - 自动信息行完全由 Trip.days / destination 推导，不引入新的事实来源。
 */

import type { Trip } from "@goplay/shared";
import { shortDate } from "./format";

/** 行程名称上限（按 Unicode 码点计数） */
export const TRIP_NAME_MAX = 50;
/** 备忘录上限（按 Unicode 码点计数） */
export const MEMO_MAX = 500;
/** 未命名行程的展示名 */
export const DEFAULT_TRIP_NAME = "我的行程";
/** 备忘收起时显示的行数（CSS line-clamp 对齐此值） */
export const MEMO_COLLAPSED_LINES = 2;
/** 两行大约可容纳的中文字数；超过即认为需要「展开」 */
export const MEMO_COLLAPSE_HINT_CHARS = 56;

/** 封面三字段的写入补丁：coverImage 传 null 表示删除封面 */
export interface TripCoverPatch {
  coverImage?: string | null;
  tripName?: string;
  memo?: string;
}

/** TripCover 渲染所需的全部展示数据（由 tripCoverInfo 从 Trip 推导） */
export interface TripCoverInfo {
  /** 展示用名称（空 → 「我的行程」） */
  tripName: string;
  /** 是否为默认名（编辑态给出「未命名」提示） */
  isDefaultName: boolean;
  memo: string;
  hasMemo: boolean;
  /** 是否超出两行预览（决定是否出现「展开」入口） */
  memoOverflows: boolean;
  /** 封面受控路径（如 uploads/{tripId}/cover.jpg）；null = 渐变兜底 */
  coverImage: string | null;
  /** 缓存版本号（trip.version）：同路径换图时用于击穿浏览器缓存 */
  coverVersion: number;
  cityLabel: string;
  dayCount: number;
  nightCount: number;
  /** 「11/08-11/12」；单日只有起始日期 */
  dateLabel: string;
  /** 自动信息行：「三亚 · 5天4晚 · 11/08-11/12」 */
  metaLine: string;
}

/** 按 Unicode 码点截断（不切断 emoji / 组合字符） */
function clampCodePoints(value: string, max: number): string {
  const points = Array.from(value);
  return points.length <= max ? value : points.slice(0, max).join("");
}

/**
 * 名称输入归一：换行压成单空格（单行展示）、去首尾空白、限 50 码点。
 * 空结果 = 清除名称（展示回默认「我的行程」）。
 */
export function normalizeTripName(raw: string): string {
  return clampCodePoints(raw.replace(/\s+/gu, " ").trim(), TRIP_NAME_MAX);
}

/**
 * 备忘输入归一：统一换行符（CRLF / CR → LF）、去尾部空白（保留行首缩进语义可忽略，
 * 但纯文本不做规则化）、限 500 码点。空结果 = 清除备忘。
 */
export function normalizeMemo(raw: string): string {
  return clampCodePoints(raw.replace(/\r\n?/gu, "\n").trimEnd(), MEMO_MAX);
}

/** 备忘是否需要「展开」：行数超过 2 行或长度超过两行容量 */
export function memoNeedsExpand(memo: string): boolean {
  const text = memo.trim();
  if (!text) return false;
  return text.split("\n").length > MEMO_COLLAPSED_LINES || Array.from(text).length > MEMO_COLLAPSE_HINT_CHARS;
}

/**
 * 封面是否有「值得首屏展示」的内容（Task #258）。
 * 只读分享页首次打开时据此决定是否自动拉起封面浮层：
 * - 有封面图 → 有内容（分享的首屏视觉）；
 * - 有备忘 → 有内容（朋友特意写下的提醒）；
 * - 只有行程名（含默认名）不算——名称已在紧凑入口里常驻可见，
 *   再自动弹一层浮层只会挡住行程。
 */
export function hasCoverContent(info: TripCoverInfo): boolean {
  return info.coverImage !== null || info.hasMemo;
}

/** 封面信息推导所需的最小 Trip 结构：Trip 与 SharedTrip 均满足（分享页复用同一推导） */
export interface TripCoverSource {
  destination: { city: string };
  dateRange: { start: string; end: string; nights: number };
  dayRefs: string[];
  days: Record<string, { dayIndex: number; date: string }>;
  version?: number;
  coverImage?: string;
  tripName?: string;
  memo?: string;
}

/** 按 dayRefs 顺序（其次 dayIndex）取出有效的 Day */
function orderedDays(trip: TripCoverSource): { dayIndex: number; date: string }[] {
  const fromRefs = trip.dayRefs
    .map((ref) => trip.days[ref])
    .filter((day): day is { dayIndex: number; date: string } => day !== undefined);
  if (fromRefs.length > 0) return fromRefs;
  return Object.values(trip.days).sort((a, b) => a.dayIndex - b.dayIndex);
}

/**
 * 由 Trip 推导封面卡展示数据。
 * 旧数据（无 coverImage / tripName / memo）→ 默认名 + 渐变封面 + 无备忘，正常渲染。
 *
 * fallbackName：未命名时的展示名——行程主人看「我的行程」，分享访客由调用方传「{城市}行程」。
 */
export function tripCoverInfo(
  trip: TripCoverSource,
  fallbackName: string = DEFAULT_TRIP_NAME,
): TripCoverInfo {
  const days = orderedDays(trip);
  const fallbackDays = trip.dateRange.nights > 0 ? trip.dateRange.nights + 1 : 0;
  const dayCount = days.length > 0 ? days.length : fallbackDays;
  const nightCount = Math.max(0, dayCount - 1);

  const startDate = days[0]?.date ?? trip.dateRange.start;
  const endDate = days[days.length - 1]?.date ?? trip.dateRange.end;
  const dateLabel =
    startDate && endDate
      ? startDate === endDate
        ? shortDate(startDate)
        : `${shortDate(startDate)}-${shortDate(endDate)}`
      : startDate
        ? shortDate(startDate)
        : "";

  const cityLabel = trip.destination.city.trim();
  const spanLabel = dayCount > 0 ? (nightCount > 0 ? `${dayCount}天${nightCount}晚` : `${dayCount}天`) : "";
  const metaLine = [cityLabel, spanLabel, dateLabel].filter((part) => part !== "").join(" · ");

  const tripName = normalizeTripName(trip.tripName ?? "");
  const memo = normalizeMemo(trip.memo ?? "");

  return {
    tripName: tripName === "" ? fallbackName : tripName,
    isDefaultName: tripName === "",
    memo,
    hasMemo: memo !== "",
    memoOverflows: memoNeedsExpand(memo),
    coverImage: trip.coverImage?.trim() ? trip.coverImage.trim() : null,
    coverVersion: trip.version ?? 0,
    cityLabel,
    dayCount,
    nightCount,
    dateLabel,
    metaLine,
  };
}

/**
 * 封面受控读取地址：
 * - 空 → null（调用方渲染渐变兜底，不请求任何静态资源）；
 * - 已是绝对地址 / 根路径 / data-URL → 原样返回（兼容未来外链，不在此改写）；
 * - 其余按项目约定拼 `/api/`（服务端 GET /api/uploads/:tripId/:filename 受控读取）；
 * - 传 version 时追加 `v=`，同一路径换图也能刷新。
 */
export function coverImageUrl(
  coverImage: string | null | undefined,
  version?: string | number,
): string | null {
  const path = coverImage?.trim();
  if (!path) return null;
  const base = /^(?:[a-z][a-z0-9+.-]*:|\/)/iu.test(path) ? path : `/api/${path.replace(/^\/+/u, "")}`;
  if (version === undefined || version === null || `${version}` === "") return base;
  const joiner = base.includes("?") ? "&" : "?";
  return `${base}${joiner}v=${encodeURIComponent(String(version))}`;
}

/**
 * 把封面补丁应用到 Trip（不可变）。无实际变化时返回**原引用**，
 * 调用方可用 `next === trip` 跳过多余的 1s 防抖 PUT。
 */
export function applyCoverPatch(trip: Trip, patch: TripCoverPatch): Trip {
  let changed = false;
  const next: Trip = { ...trip };

  if (patch.coverImage !== undefined) {
    const value = patch.coverImage?.trim() ?? "";
    if (value === "") {
      if (next.coverImage !== undefined) {
        delete next.coverImage;
        changed = true;
      }
    } else if (next.coverImage !== value) {
      next.coverImage = value;
      changed = true;
    }
  }

  if (patch.tripName !== undefined) {
    const value = normalizeTripName(patch.tripName);
    if (value === "") {
      if (next.tripName !== undefined) {
        delete next.tripName;
        changed = true;
      }
    } else if (next.tripName !== value) {
      next.tripName = value;
      changed = true;
    }
  }

  if (patch.memo !== undefined) {
    const value = normalizeMemo(patch.memo);
    if (value === "") {
      if (next.memo !== undefined) {
        delete next.memo;
        changed = true;
      }
    } else if (next.memo !== value) {
      next.memo = value;
      changed = true;
    }
  }

  return changed ? next : trip;
}
