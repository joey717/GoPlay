/**
 * AI 补充来源（Task #283 / 验收用例 C4）：provenance 的展示文案与只读判定助手。
 *
 * 单一数据源：chip 全标 / 降级标 / 核验说明文案集中在此，前端（VisitCard、ShareView）、
 * 服务端（planner 打标日志）与 eval C4 断言共用同一份常量，杜绝多处硬编码漂移。
 *
 * 判定口径：provenance 缺失视为 "guide"（存量零迁移、读时默认，遵守迁移铁律）。
 * 只有明确标 "ai_supplement" 的 Item 才展示补充标；护栏（guards.validateAiSupplementProvenance）
 * 保证 ai_supplement 必引用真实飞猪 POI，无真实 POI 者在打标阶段即被降级、不会落盘。
 */

import type { Item, ItemProvenance } from "./types/index.js";

/** chip 全标（宽度充足，如 390px）：AI 补充 ＋ 飞猪核验二段 */
export const AI_SUPPLEMENT_CHIP_LABEL = "AI 补充·飞猪核验";
/** chip 降级标（≤360px 空间不足）：只保留「AI 补充」，核验说明移入详情行 */
export const AI_SUPPLEMENT_CHIP_LABEL_COMPACT = "AI 补充";
/** 核验说明（详情抽屉一行 / 降级态补充）：说清「AI 补排 ＋ 已飞猪核验为真实景点」 */
export const AI_SUPPLEMENT_VERIFY_NOTE = "由 AI 补充排入，已通过飞猪核验为真实景点";

/**
 * 读取 Item 的 provenance，缺失 / 非法值一律回落 "guide"（读时默认，存量零迁移）。
 * 前端与 eval 断言统一经此取值，不直接读裸字段，避免 undefined 判定分叉。
 */
export function itemProvenance(item: Item | null | undefined): ItemProvenance {
  return item?.provenance === "ai_supplement" ? "ai_supplement" : "guide";
}

/** 是否为 AI 补充项（决定主行程卡 / 分享页是否展示补充标；清单不展示） */
export function isAiSupplement(item: Item | null | undefined): boolean {
  return itemProvenance(item) === "ai_supplement";
}
