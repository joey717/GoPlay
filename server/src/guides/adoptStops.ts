/**
 * 高置信度子玩法自动采纳（正式运行时模块）。
 *
 * 从一次性修复脚本 fix-task225.ts 抽出的可复用纯函数——运行时链路（planner.ts
 * applyGuideDraft）与存量修复脚本共用同一份采纳逻辑，禁止运行时 import fix 脚本。
 *
 * ## 背景
 * 后台装配对 in_attraction 子玩法一律 suppressAttach:true（service.ts），子 Stop 落成
 * state="pending"（visitRef=null）躺在待定区，父 Visit 的 childStopRefs 为空——前端
 * VisitCard 只渲染 childStopRefs，故大景区父卡下的岛内玩法全空白。relationshipSuggestions
 * 早已判定归属（level="high"），缺的只是运行时把它们采纳进父卡的环节。
 *
 * ## 采纳口径（保守策略，与 fix-task225 一致）
 * 对每个 large_attraction Visit，把「suggestedVisitRef 指向它 + state=pending +
 * relationshipSuggestions.level="high" + decidedBy≠"user"」的 Stop 落为 attached：
 *   - state → "attached"（Stop 合法状态只有 attached / pending，见 shared/src/types），
 *     visitRef → 该 Visit，order → 追加到 childStopRefs 末尾的下标；
 *   - 从 trip.pendingStopRefs 移除；suggestedVisitRef 置 null（attached 携带
 *     suggestedVisitRef 会被一致性校验拒绝），relationshipSuggestions.suggestedVisitRef
 *     同步置 null（类型约定 high = 已落 attached），level / decidedBy 保留便于溯源；
 *   - 把证据中「本尊提及」（extractedName 归一化后等于 Visit 名，或仅多出三亚/海南等
 *     目的地前缀与旅游区/景区等通用后缀）的 mentionRef 并入 Visit.sourceMentionRefs；
 *   - 子玩法参与父 Visit 时长汇总，采纳时就地按同一口径（resolveEffectiveMinutes）刷新
 *     effectiveMinutes；调用方据返回的 dayIndex 对受影响的天重算时间轴。
 *
 * 边界：只认 level="high"（medium / low 保留在待定区由用户归类）；decidedBy="user"
 * 跳过（用户已表态，自动通道不得覆盖）；已排期与候选区壳一视同仁。
 *
 * 幂等：Stop 已 attached、已在 childStopRefs、提及已存在均天然跳过；无变更返回空数组，
 * 调用方据此决定是否写盘 / 重算。
 */

import type { Trip, Visit } from "@goplay/shared";
import { resolveEffectiveMinutes, visitDayIndex } from "@goplay/shared";

/**
 * 「本尊提及」允许的目的地前缀：飞猪 / 攻略常写成「三亚西岛」「海南西岛」，
 * 去掉前缀后名称与本尊一致，仍算西岛本体的提及（只对名称讲本尊时成立）。
 */
const VISIT_BODY_PREFIX_NOISE = ["海南省", "海南", "三亚市", "三亚"] as const;

/**
 * 「本尊提及」允许的通用景区后缀：只在「本尊 + 完整后缀」时成立，
 * 例如「西岛海洋文化旅游区」算西岛本体；「西岛渔村」这类岛内玩法不算。
 */
const VISIT_BODY_SUFFIX_NOISE = [
  "海洋文化旅游区",
  "文化旅游区",
  "旅游区",
  "风景区",
  "景区",
  "度假区",
] as const;

/** 名称归一化：去成对括号内容、去空白——与 web normalizePoiName / 服务端同口径 */
export function normalizePoiName(name: string): string {
  return name
    .replace(/[（(【[{][^）)】\]}]*[）)】\]}]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

/** 单个 Visit 的子玩法采纳记录（日志与回归验证用） */
export interface ChildAdoption {
  visitId: string;
  visitName: string;
  /** 采纳时父 Visit 所在天；null = 尚未排期（仍在候选区） */
  dayIndex: number | null;
  /** 本次落为 attached 的 stopId（按追加进 childStopRefs 的顺序） */
  stopRefs: string[];
  /** 本次新写入 Visit.sourceMentionRefs 的本尊提及条数（已存在的不重复计） */
  addedBodyMentionRefs: number;
}

/**
 * 某条提及是否在讲 Visit 本尊：归一化后与本尊名全等，或仅多出目的地前缀 /
 * 通用景区后缀。岛内玩法名（「西岛渔村」）剥离后仍不等于本尊，不会误判。
 */
function isVisitBodyMention(rawName: string, visitName: string): boolean {
  const body = normalizePoiName(visitName);
  if (body === "") return false;
  let candidate = normalizePoiName(rawName);
  if (candidate === "" || candidate === body) return candidate === body;
  for (const prefix of VISIT_BODY_PREFIX_NOISE) {
    if (!candidate.startsWith(prefix)) continue;
    candidate = candidate.slice(prefix.length);
    break;
  }
  if (candidate === body) return true;
  return VISIT_BODY_SUFFIX_NOISE.some((suffix) => candidate === `${body}${suffix}`);
}

/**
 * 把证据中本尊提及的 mentionRef（"evidenceId:mentionId"）并入 Visit.sourceMentionRefs。
 * 先并入已有引用去重，不改顺序；返回新增条数（0 表示无需写盘）。
 */
function mergeVisitBodyMentionRefs(trip: Trip, visit: Visit, visitName: string): number {
  if (normalizePoiName(visitName) === "") return 0;
  const merged = [...(visit.sourceMentionRefs ?? [])];
  const seen = new Set(merged);
  let added = 0;
  for (const [evidenceId, evidence] of Object.entries(trip.evidences ?? {})) {
    const mentions = Array.isArray(evidence.mentions) ? evidence.mentions : [];
    for (const mention of mentions) {
      const rawName = mention.extractedName ?? mention.text ?? "";
      if (!isVisitBodyMention(rawName, visitName)) continue;
      const ref = `${evidenceId}:${mention.mentionId}`;
      if (seen.has(ref)) continue;
      seen.add(ref);
      merged.push(ref);
      added += 1;
    }
  }
  if (added > 0) visit.sourceMentionRefs = merged;
  return added;
}

/**
 * 纯函数：把「高置信度 pending 子玩法」自动采纳进大景区的 childStopRefs。
 *
 * 采纳条件（全部满足）：Stop.state=pending 且 suggestedVisitRef 指向该 Visit、
 * relationshipSuggestions[stopId].level="high"、decidedBy≠"user"。采纳后同步维护
 * pendingStopRefs / suggestedVisitRef / order / relationshipSuggestions，按同一口径
 * 刷新父 Visit 的 effectiveMinutes，并回填本尊提及；返回采纳列表（空 = 无变更，
 * 调用方不写盘 / 不重算）。幂等：已 attached / 已在 childStopRefs / 用户已表态跳过。
 */
export function adoptHighConfidenceChildStops(trip: Trip): ChildAdoption[] {
  const adoptions: ChildAdoption[] = [];
  for (const visit of Object.values(trip.visits)) {
    if (visit.kind !== "large_attraction") continue;
    const visitName = trip.itemRegistry[visit.pointRef]?.name ?? "";

    const adoptedStopRefs: string[] = [];
    for (const stop of Object.values(trip.stops)) {
      if (stop.state !== "pending") continue; // 幂等：已采纳 / 原生 attached 跳过
      if (stop.suggestedVisitRef !== visit.visitId) continue;
      const suggestion = trip.relationshipSuggestions[stop.stopId];
      if (suggestion === undefined || suggestion.level !== "high") continue; // 保守：只采纳高置信度
      if (suggestion.decidedBy === "user") continue; // 用户已表态，自动通道不得覆盖
      if (visit.childStopRefs.includes(stop.stopId)) continue;

      stop.state = "attached";
      stop.visitRef = visit.visitId;
      stop.suggestedVisitRef = null; // attached 携带 suggestedVisitRef 会被一致性校验拒绝
      stop.order = visit.childStopRefs.length;
      visit.childStopRefs.push(stop.stopId);
      suggestion.suggestedVisitRef = null; // high = 已落 attached（类型约定）
      adoptedStopRefs.push(stop.stopId);
    }
    if (adoptedStopRefs.length === 0) continue;

    const adoptedSet = new Set(adoptedStopRefs);
    trip.pendingStopRefs = trip.pendingStopRefs.filter((stopId) => !adoptedSet.has(stopId));
    // 子玩法参与父 Visit 时长汇总：与 timeline 同口径就地刷新（未排期壳无天可重算）
    visit.effectiveMinutes = resolveEffectiveMinutes(visit, trip);
    const addedBodyMentionRefs = mergeVisitBodyMentionRefs(trip, visit, visitName);
    adoptions.push({
      visitId: visit.visitId,
      visitName: visitName === "" ? visit.visitId : visitName,
      dayIndex: visitDayIndex(trip, visit.visitId),
      stopRefs: adoptedStopRefs,
      addedBodyMentionRefs,
    });
  }
  return adoptions;
}
