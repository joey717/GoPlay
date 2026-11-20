/**
 * Task #356（PD 2026-11-10，DEMO《GoPlay_景点卡字段排布微调》v0.6 转化行话术）：
 * 「先囤票，改期全额退」退票保障话术。
 *
 * ⚠️ MOCK 文案——无任何真实退改规则/服务保障逻辑支撑，仅为 PD DEMO 的视觉占位；
 * PD 11/10 指定仅「西岛」「蜈支洲岛」两个景点的购票处展示（name includes 匹配），
 * 其余景点一律不展示。后续接入真实退改逻辑时替换本文件（文案 + 白名单 + 判定
 * 函数三处均在此单点维护，调用方只消费 showRefundAssurance / REFUND_ASSURANCE_TEXT）。
 */

/** MOCK 话术文本（DEMO v0.6：转化行左侧，✓ 前缀由渲染处拼接） */
export const REFUND_ASSURANCE_TEXT = "先囤票，改期全额退";

/** MOCK 展示白名单：景点名 includes 命中任一关键字即展示（PD 11/10 指定仅两岛） */
export const REFUND_ASSURANCE_POI_WHITELIST: readonly string[] = ["西岛", "蜈支洲岛"];

/** 是否在该景点的购票处展示 MOCK 退票话术（白名单 includes 匹配，空名恒 false） */
export function showRefundAssurance(name: string | null | undefined): boolean {
  if (name === null || name === undefined || name === "") return false;
  return REFUND_ASSURANCE_POI_WHITELIST.some((keyword) => name.includes(keyword));
}
