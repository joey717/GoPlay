/**
 * Task #253：存量「区域占位点位」判定（纯函数，单一事实源）。
 *
 * 现场：真实行程里存在一条自定义点位「亚龙湾」（origin=custom、无 providerId、
 * 未归类为大景区），它其实是用户 / 抽取器写下的**区域主题**，不是可游玩 POI；
 * 亚龙湾片区的真实点位是「亚龙湾森林公园」「亚龙湾海滩」等同名开头的飞猪 POI。
 *
 * 缺陷：区域主题一旦被当作普通 Visit，
 * - 指令匹配会把它当成点名主体锚点（于是整日替换时它被保留而不参与重排，
 *   真实森林公园反被移出）；
 * - planner prompt 把它列为可 plan / move 的候选；
 * - 模型可能直接对它输出 plan / move / transfer / remove / setDuration。
 *
 * 判定口径（保守、只读现有真实字段，宁可漏判不可误判）：
 * 1. Visit 存在且不是大景区壳（kind !== "large_attraction"）；
 * 2. 其 Item 是自定义创建（origin === "custom" 且 providerId === null）；
 * 3. 名称归一化后 ≥2 字符；
 * 4. 行程内至少存在另一个**真实点位**（providerId !== null，即飞猪 POI），其归一化
 *    名称**严格包含**该名称（如「亚龙湾森林公园」包含「亚龙湾」）。
 *    严格包含（而非相等）用于排除「自定义点位与官方 POI 同名」的重复实体——
 *    同名重复不是区域主题，仍由既有同名收敛逻辑处理。
 *
 * 判定结果只用于「不作为指令主题锚点 / planner 候选 / 操作目标」，绝不删除数据：
 * 该 Visit 与其 Item 原样保留在行程中（可作为区域标题展示）。
 */

import type { EntityRef, Trip } from "./types/index.js";

/** 名称归一化：去成对括号内容 + 去空白 + 小写（与 server normalizePoiName 同口径） */
function normalizeAreaName(raw: string): string {
  return raw
    .replace(/[（(【\[{][^）)】\]}]*[）)】\]}]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/**
 * 行程内全部「区域占位点位」的 Visit id 集合。
 * 纯读：不修改入参，不依赖 IO，可在指令匹配 / prompt 组装 / 操作过滤中复用。
 */
export function collectAreaPlaceholderVisitIds(trip: Trip): Set<string> {
  const visits = trip.visits ?? {};
  const items = trip.itemRegistry ?? {};
  // 真实点位（飞猪 POI）名称池：只有它们能证明某个自定义点位是「区域主题」
  const realNames: string[] = [];
  for (const visit of Object.values(visits)) {
    const item = items[visit.pointRef];
    if (item === undefined || item === null) continue;
    if (item.providerId === null || item.providerId === undefined || item.providerId === "") continue;
    const normalized = normalizeAreaName(typeof item.name === "string" ? item.name : "");
    if (normalized !== "") realNames.push(normalized);
  }
  if (realNames.length === 0) return new Set<string>();

  const placeholders = new Set<string>();
  for (const [visitId, visit] of Object.entries(visits)) {
    if (visit.kind === "large_attraction") continue;
    const item = items[visit.pointRef];
    if (item === undefined || item === null) continue;
    if (item.origin !== "custom" || item.providerId !== null) continue;
    const normalized = normalizeAreaName(typeof item.name === "string" ? item.name : "");
    if (normalized.length < 2) continue;
    // 严格包含：真实点位名更长且完整包含该名称，说明它只是区域前缀
    if (realNames.some((name) => name.length > normalized.length && name.includes(normalized))) {
      placeholders.add(visitId);
    }
  }
  return placeholders;
}

/** 单个 EntityRef 是否指向区域占位点位（非 visit 引用一律 false） */
export function isAreaPlaceholderRef(ref: EntityRef, placeholderVisitIds: ReadonlySet<string>): boolean {
  return ref.kind === "visit" && placeholderVisitIds.has(ref.id);
}
