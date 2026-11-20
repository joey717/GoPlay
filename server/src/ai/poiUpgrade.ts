/**
 * Task #254：custom → 飞猪（fliggy）存量实体「唯一升级」决策（纯函数，单一口径）。
 *
 * 背景（CodeReview 对 Task #249 的两项升级安全问题）：
 * 1. 在线装配曾直接拿 findBestMatch 的第一条结果升级存量 custom Item——同一批召回里
 *    存在多个 canonical 同名但 providerId 不同的候选时，会把存量实体挂到任意一个
 *    商家 POI 上，也不检查该 providerId 是否已被别的 Item 占用；
 * 2. fix-task249 脚本曾在「简称查询成功、正式名查询超时」时用半截候选集继续决策，
 *    把不完整的召回当成唯一命中并完成升级。
 *
 * 因此「是否允许升级」只在本模块判定一次，在线装配（assemble.ts）与修复脚本
 * （fix-task249.ts）共用同一实现，避免两处口径再次漂移：
 * - 任一搜索轮次失败 → search-error，绝不升级（错误不得被吞掉）；
 * - 只认 canonical 全等（isSameCanonicalPoiName，别名折叠后全等），不做包含降级；
 * - 按 providerId 去重后必须唯一（同一 providerId 的重复结果不算多义）；
 * - 唯一命中但 providerId 已被其他 Item 占用 → occupied，绝不产生重复 providerId。
 *
 * 普通搜索召回（新建实体 / 复用查找）不走这里，仍用 findBestMatch 的既有策略：
 * 本模块只回答「是否允许把一条存量 custom Item 升级成飞猪实体」。
 */

import { isSameCanonicalPoiName } from "@goplay/shared";
import type { Trip } from "@goplay/shared";
import type { FlyAIPoi } from "../flyai/client.js";

// ===== 决策 =====

/** 唯一升级决策（在线装配与修复脚本的共用结果类型） */
export type PoiUpgradeDecision =
  | { kind: "upgrade"; poi: FlyAIPoi; providerId: string }
  | { kind: "no-candidate"; candidateCount: 0 }
  | { kind: "ambiguous"; providerIds: string[]; names: string[] }
  | { kind: "occupied"; providerId: string; occupiedBy: string }
  | { kind: "search-error"; error: string };

/** 决策入参的可选约束 */
export interface PoiUpgradeDecisionOptions {
  /**
   * 搜索阶段任一轮次失败的错误文案（不含密钥）。非空即拒绝升级：
   * 半截候选集不足以证明「唯一命中」，宁可保持 custom。
   */
  searchError?: string | null;
}

/**
 * 从完整候选集里挑出可以安全升级的唯一目标。
 *
 * 判定顺序（任一不满足即保持 custom）：
 * 1. searchError 非空 → search-error；
 * 2. 只保留 `isSameCanonicalPoiName(itemName, poi.name)` 的候选（不做包含 / 模糊），
 *    并按 providerId 去重（空 providerId 一律丢弃，绝不伪造）；
 * 3. 0 个 → no-candidate；>1 个 → ambiguous（不同商家 / 同名景区）；
 * 4. 唯一但 providerId 已被其他 Item 占用 → occupied（会产生重复 providerId）；
 * 5. 其余 → upgrade。
 *
 * @param itemName 待升级存量 Item 的名称（攻略原文名，如「亚龙湾森林公园」）
 * @param candidates 本轮全部搜索轮次合并去重后的完整候选集（禁止只传首条 / findBestMatch 结果）
 * @param occupiedProviderIds providerId → 占用它的既有 Item ID（仅含其他 Item）
 */
export function decidePoiUpgradeTarget(
  itemName: string,
  candidates: readonly FlyAIPoi[],
  occupiedProviderIds: ReadonlyMap<string, string>,
  options: PoiUpgradeDecisionOptions = {},
): PoiUpgradeDecision {
  const searchError = typeof options.searchError === "string" ? options.searchError.trim() : "";
  if (searchError !== "") return { kind: "search-error", error: searchError };

  const matches = new Map<string, FlyAIPoi>();
  for (const poi of candidates) {
    if (!isSameCanonicalPoiName(itemName, poi.name)) continue;
    const providerId = typeof poi.id === "string" ? poi.id.trim() : "";
    if (providerId === "") continue;
    if (!matches.has(providerId)) matches.set(providerId, poi);
  }

  if (matches.size === 0) return { kind: "no-candidate", candidateCount: 0 };
  if (matches.size > 1) {
    return {
      kind: "ambiguous",
      providerIds: [...matches.keys()],
      names: [...matches.values()].map((poi) => poi.name),
    };
  }

  const [providerId, poi] = [...matches.entries()][0]!;
  const occupiedBy = occupiedProviderIds.get(providerId);
  if (occupiedBy !== undefined) return { kind: "occupied", providerId, occupiedBy };
  return { kind: "upgrade", poi, providerId };
}

/** 供日志 / 报告使用的拒绝原因（不参与判定） */
export function describePoiUpgradeRejection(decision: PoiUpgradeDecision): string {
  switch (decision.kind) {
    case "no-candidate":
      return "无 canonical 全等的搜索候选";
    case "ambiguous":
      return `多义候选（providerId：${decision.providerIds.join("，")}）`;
    case "occupied":
      return `providerId ${decision.providerId} 已被 Item ${decision.occupiedBy} 占用`;
    case "search-error":
      return `搜索失败（${decision.error}）`;
    case "upgrade":
      return `唯一 canonical 命中「${decision.poi.name}」（providerId=${decision.providerId}）`;
  }
}

// ===== 占用检测 =====

/**
 * 收集已被占用的 providerId（providerId → 占用它的 Item ID）。
 * @param excludeItemId 待升级 Item 自身（其 providerId 为 null，排除是为了防御脏数据）
 */
export function collectOccupiedProviderIds(
  trip: Pick<Trip, "itemRegistry">,
  excludeItemId: string | null,
): Map<string, string> {
  const occupied = new Map<string, string>();
  for (const item of Object.values(trip.itemRegistry)) {
    if (excludeItemId !== null && item.itemId === excludeItemId) continue;
    const providerId = typeof item.providerId === "string" ? item.providerId.trim() : "";
    if (providerId === "") continue;
    if (!occupied.has(providerId)) occupied.set(providerId, item.itemId);
  }
  return occupied;
}

// ===== 候选聚合（所有搜索轮次共用同一合并 / 失败口径） =====

/** 多轮搜索聚合结果 */
export interface PoiCandidateAggregate {
  /** 已执行轮次返回的完整候选集（按 providerId 去重，保留首次出现顺序） */
  candidates: FlyAIPoi[];
  /** 任一轮次失败的错误文案；非 null 表示候选集不完整 */
  error: string | null;
  /** 失败轮次下标（0 起）；未失败为 null */
  failedIndex: number | null;
}

/**
 * 逐轮执行查询并聚合候选。
 *
 * 口径（在线装配与修复脚本共用，防再次漂移）：
 * - 任一轮次抛错即停止后续轮次（避免双倍超时），并把错误原样上报；
 * - 空 providerId 的条目不去重（保持既有召回可见性），非空 providerId 按首次出现去重；
 * - 不在此处做任何匹配 / 升级判定——匹配策略（findBestMatch / canonical 全等）
 *   由调用方按用途选择。
 */
export async function aggregatePoiCandidates(
  queries: readonly string[],
  search: (query: string) => Promise<readonly FlyAIPoi[]>,
): Promise<PoiCandidateAggregate> {
  const candidates: FlyAIPoi[] = [];
  const seenProviderIds = new Set<string>();
  for (const [index, query] of queries.entries()) {
    let pois: readonly FlyAIPoi[];
    try {
      pois = await search(query);
    } catch (caught) {
      return {
        candidates,
        error: caught instanceof Error ? caught.message : String(caught),
        failedIndex: index,
      };
    }
    for (const poi of pois) {
      const providerId = typeof poi.id === "string" ? poi.id.trim() : "";
      if (providerId !== "") {
        if (seenProviderIds.has(providerId)) continue;
        seenProviderIds.add(providerId);
      }
      candidates.push(poi);
    }
  }
  return { candidates, error: null, failedIndex: null };
}
