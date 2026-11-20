/**
 * Task #330：飞猪 POI 元信息（poiLevel / listRank / description）的读时默认与归一化。
 *
 * 背景：FlyAI search-poi 返回 13 个字段，归一化层（server/src/flyai/client.ts normalizePoi）
 * 已 100% 映射到 FliggyPoi，但 FliggyPoi → Item 装配时曾丢弃 description / poiLevel /
 * listRank（freePoiStatus 已由 #329 补齐）。本模块为这三项提供单一数据源的读侧口径，
 * 供前端展示层与 verify / fix 脚本共用（与 freePoi.ts 同范式）。
 *
 * 迁移铁律：Item.poiLevel / listRank / description 均为可选字段，存量 Trip JSON 缺失时
 * 读时默认 null、不写回、不报错（与 provenance / freePoiStatus 同模式）。
 */

import type { Item } from "./types/index.js";

/** 景点等级归一化后的展示文本（仅识别 4A / 5A；其余形态不展示） */
export type PoiLevelLabel = "4A" | "5A";

/**
 * 读取 Item.poiLevel：缺失 / null / 非字符串 / 空白一律回落 null（读时默认，存量零迁移，
 * 不改写入参对象）。返回飞猪原始形态（如 "4" / "AAAA"），展示前须经 normalizePoiLevel。
 */
export function itemPoiLevel(item: Item | null | undefined): string | null {
  const value = item?.poiLevel;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** 读取 Item.listRank：缺失 / null / 非字符串 / 空白一律回落 null（读时默认，不写回） */
export function itemListRank(item: Item | null | undefined): string | null {
  const value = item?.listRank;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** 读取 Item.description：缺失 / null / 非字符串 / 空白一律回落 null（读时默认，不写回） */
export function itemDescription(item: Item | null | undefined): string | null {
  const value = item?.description;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * poiLevel 归一化为展示文本 "4A" / "5A"；无法识别的形态（含 3A、脏值、空）返回 null，
 * 展示层据此不渲染徽标——**绝不把原始脏值直接输出到界面**。
 *
 * 兼容形态对照：
 *   "4" / "4A" / "4a" / "AAAA"（4 个 A）        → "4A"
 *   "5" / "5A" / "5a" / "AAAAA"（5 个 A）       → "5A"
 *   "3" / "3A" / "AAA" / "AAAAAA" / "" / null   → null（不展示）
 *   "国家5A级旅游景区" 等含 4/5 数字的长文案     → 取首个 4 或 5 → "5A" / "4A"
 */
export function normalizePoiLevel(raw: string | null | undefined): PoiLevelLabel | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toUpperCase();
  if (value === "") return null;
  // 纯 A 串：AAAA = 4A、AAAAA = 5A（AAA = 3A 等不在展示范围，返回 null）
  if (/^A+$/.test(value)) {
    if (value.length === 4) return "4A";
    if (value.length === 5) return "5A";
    return null;
  }
  // 数字形态（可带 A / 级 等后缀）：取首个 4 或 5；其余数字（含 3A）不展示
  const digit = value.match(/[45]/);
  if (digit !== null) return digit[0] === "4" ? "4A" : "5A";
  return null;
}

/** Item → 展示用等级徽标文本（"4A" / "5A" / null）：读时默认 + 归一化一步到位 */
export function itemPoiLevelLabel(item: Item | null | undefined): PoiLevelLabel | null {
  return normalizePoiLevel(itemPoiLevel(item));
}
