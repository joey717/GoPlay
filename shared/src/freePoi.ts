/**
 * Task #329：免费场所（购物/免税类）判定 —— FlyAI freePoiStatus 的读时默认与三态口径。
 *
 * 背景：国际免税城等免费购物中心，FlyAI 实测返回 freePoiStatus="UNKNOWN" 且
 * category=null，但携带 jumpUrl；此前 freePoiStatus 在 FliggyPoi → Item 装配时被
 * 丢弃，前端 commerce 只看 jumpUrl !== null，导致免费场所透出「去购票」按钮。
 *
 * 判定口径（单一数据源，前端展示 / fix 脚本 / verify 共用）：
 * - freePoiStatus === "FREE" → 免费入场（唯一直接信号）；
 * - "NOT_FREE" → 收费在售，任何兜底都不再介入（供应商明确信号优先于名称/类别猜测）；
 * - "UNKNOWN" / null / 缺失 → category 命中购物类关键词，**或名称命中购物类关键词**
 *   （Task #330 D 双通道兜底）才判为免费；两通道都无信号时视为非免费。
 *
 * Task #330 D 口径变更（PD 批准）：#329 只把「名称关键词判免费」放在一次性存量脚本里，
 * 运行时展示层只做 category 兜底。但 FlyAI 对国际免税城实测返回 freePoiStatus=UNKNOWN
 * + category=null，意味着 PD 新建行程再搜国际免税城时购票按钮会重新出现（正是原始症状）。
 * 因此把 fix-task329 的 FREE_NAME_KEYWORDS 提到本模块导出为 isShoppingNameHit，并接入
 * isFreeAdmissionPoi 运行时判定。窄口径不变：不加入「中心/广场/街」等宽词（会误杀
 * 「海棠广场」「天涯小镇」）；NOT_FREE 优先级不变（名称兜底不得覆盖供应商明确信号）。
 *
 * 迁移铁律：Item.freePoiStatus 为可选字段，存量 Trip JSON 缺失时读时默认 null、
 * 不写回、不报错（与 provenance / addressSource 同模式）。
 */

import type { FreePoiStatus, Item } from "./types/index.js";
import { itemDescription } from "./poiMeta.js";

/**
 * category 兜底关键词（购物类场所 → 免费入场）。
 * 保守性论证（基于 server/data 存量 category 实测分布）：沙滩海岛 / 山湖田园 /
 * 自然风光 / 公园乐园 / 文创街区 / 地标建筑 / 露营 / 宗教场所 / 潜水 —— 均不含
 * 下列子串；「天涯小镇」（文创街区）、「海棠广场」（地标建筑）等真实景点不误杀。
 * 任务口径中的宽词「中心 / 广场 / 街」刻意不入展示层兜底表：存量数据里它们是
 * 地标建筑类真实景点的常见子串，误杀代价高于漏判；宽词仅用于 fix-task329 存量
 * 回填脚本的 category 匹配（脚本侧另有白名单行程范围控制）。
 */
export const SHOPPING_CATEGORY_KEYWORDS = [
  "购物",
  "免税",
  "商场",
  "商城",
  "超市",
  "卖场",
  "奥特莱斯",
  "商业街",
  "步行街",
] as const;

/**
 * 名称通道关键词（明显购物类场所 → 免费入场），Task #330 D 从 fix-task329 提入。
 * 保守窄口径（与 fix 脚本同一数据源）：**刻意不含宽词「中心 / 广场 / 街」**——
 * 存量数据里「海棠广场」（地标建筑）、「天涯小镇」（文创街区）是真实景点，
 * 宽词会误杀（失去购票入口），误杀代价高于漏判（已由 server/data 全量反例论证）。
 */
export const FREE_NAME_KEYWORDS = [
  "免税",
  "奥特莱斯",
  "购物中心",
  "商场",
  "商城",
  "超市",
  "百货",
  "商业街",
  "步行街",
] as const;

/** 名称是否命中购物类关键词（空 / null / 非字符串不命中） */
export function isShoppingNameHit(name: string | null | undefined): boolean {
  if (typeof name !== "string" || name === "") return false;
  return FREE_NAME_KEYWORDS.some((keyword) => name.includes(keyword));
}

/** 读取 Item 的 freePoiStatus：缺失 / null / 非法值一律回落 null（读时默认，存量零迁移） */
export function itemFreePoiStatus(item: Item | null | undefined): FreePoiStatus {
  const status = item?.freePoiStatus;
  return status === "NOT_FREE" || status === "FREE" || status === "UNKNOWN" ? status : null;
}

/** category 是否命中购物类关键词（空 / null 不命中） */
export function isShoppingCategory(category: string | null | undefined): boolean {
  if (typeof category !== "string" || category === "") return false;
  return SHOPPING_CATEGORY_KEYWORDS.some((keyword) => category.includes(keyword));
}

/**
 * 免费入场统一判定（Item 版）：FREE 直接命中；UNKNOWN / null 走 category 购物类
 * 兜底 + 名称购物类兜底（Task #330 D 双通道）；NOT_FREE 恒为 false。前端「免票」
 * 标签与购票按钮降级、候选池标注共用。
 */
export function isFreeAdmissionItem(item: Item | null | undefined): boolean {
  if (item === null || item === undefined) return false;
  return isFreeAdmissionPoi(itemFreePoiStatus(item), item.category, item.name);
}

/**
 * 免费入场统一判定（裸字段版）：供搜索结果卡（NoteInput 快速搜索 / CandidatePool，
 * POI 尚未装配成 Item）与 fix / verify 脚本复用，口径与 Item 版完全一致。
 * name 为可选第三参（Task #330 D 名称通道）：传入时启用名称兜底，不传则仅 category 通道。
 */
export function isFreeAdmissionPoi(
  freePoiStatus: FreePoiStatus,
  category: string | null | undefined,
  name?: string | null | undefined,
): boolean {
  if (freePoiStatus === "FREE") return true;
  if (freePoiStatus === "NOT_FREE") return false;
  // UNKNOWN / null / 缺失：category 通道 + 名称通道双兜底（任一命中即免费）
  return isShoppingCategory(category) || isShoppingNameHit(name);
}

/**
 * Task #372：点位购票通道判定 —— jumpUrl 存在与否是「有/无购票通道」的唯一信号。
 * 调研（#371）证实 jumpUrl 非空时落地页为飞猪购票/H5 POI 页（channel="fliggy"）；
 * jumpUrl 为 null（与 origin==="custom" 在存量数据中完全等价，0 例外）即无购票通道。
 */
export function itemPurchaseChannel(item: Item | null | undefined): "fliggy" | "none" {
  if (item === null || item === undefined) return "none";
  return item.jumpUrl !== null && item.jumpUrl !== undefined ? "fliggy" : "none";
}

/**
 * Task #372：「查看介绍」应用内浮层入口是否展示。
 * 口径：（无购票通道 或 免费入场点位）且 itemDescription(item) !== null。
 * description 判空是**空浮层守卫**——国际免税城等 FREE 但无介绍的点位不降级，
 * 维持现状「查看详情」文案，避免点开空浮层。NOT_FREE 有通道点位（西岛等）恒 false，
 * 原 window.open 购票路径零变化。
 */
export function shouldShowIntroEntry(item: Item | null | undefined): boolean {
  if (item === null || item === undefined) return false;
  if (itemDescription(item) === null) return false;
  return itemPurchaseChannel(item) === "none" || isFreeAdmissionItem(item);
}
