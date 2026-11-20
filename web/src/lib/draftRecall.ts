/**
 * 草案召回（任务 135）：从已持久化的 Trip.pendingGuideDraft 重建前端可展示的
 * GuideDraftResult，供「页面重载后新鲜草案直接可看」使用。
 *
 * 边界：
 * - 只在草案新鲜（checkPendingGuideDraftFreshness.fresh）时返回非 null；
 *   过期草案由应用端点以 DRAFT_STALE 拒绝，召回侧同样不展示，避免假可用入口。
 * - 未持久化的展示辅助字段（unplaced / proposedNew / clarify）缺失时以空值兜底
 *   （GuideDraftReview 对空数组 / null 均安全），核心 operations / snippets /
 *   directives / conflicts / requirementChecks 完整保留。
 */
import type { Trip } from "@goplay/shared";
import { checkPendingGuideDraftFreshness } from "@goplay/shared";
import type { GuideDraftResult, GuideDraftSnippet } from "../api/client";

/** 待应用草案的暂存提示 → 前端展示形态（字段同构；targetRef 收窄为可挂载的三种） */
function snippetsOf(
  draft: NonNullable<NonNullable<Trip["pendingGuideDraft"]>["output"]>,
): GuideDraftSnippet[] {
  return draft.snippets.flatMap((snippet) => {
    const targetRef = snippet.targetRef;
    if (targetRef.kind !== "point" && targetRef.kind !== "visit" && targetRef.kind !== "stop") {
      return []; // 持久层契约只允许 point / visit / stop；防御未知 kind 不进入展示
    }
    return [
      {
        text: snippet.text,
        claimKind: snippet.claimKind,
        targetRef,
        sourceMentionRefs: snippet.sourceMentionRefs,
      },
    ];
  });
}

/**
 * 从行程重建可直接查看的草案；无草案 / 无生成结果 / 已过期（版本、来源、补充句任一变化）
 * 时返回 null（调用方不展示召回入口，也不得伪装成成功）。
 */
export function draftResultFromTrip(trip: Trip): GuideDraftResult | null {
  const pending = trip.pendingGuideDraft;
  if (pending === undefined || pending === null) return null;
  if (pending.output === undefined || pending.output === null) return null;
  if (!checkPendingGuideDraftFreshness(pending, trip).fresh) return null;

  const sourceSnapshots = Array.isArray(pending.sourceSnapshots) ? pending.sourceSnapshots : [];
  const mentionCount =
    (Array.isArray(pending.mentionIds) ? pending.mentionIds.length : 0) +
    (Array.isArray(pending.mentionRefs) ? pending.mentionRefs.length : 0);

  return {
    // baseTripVersion = 草案落盘后的 Trip.version（服务端 tripStore.save 恰自增 1）
    draftId: pending.draftId,
    tripVersion: pending.baseTripVersion,
    baseTripVersion: pending.baseTripVersion,
    // 旧存量草案可缺省；仅展示用，兜底为落盘版本
    inputTripVersion: pending.inputTripVersion ?? pending.baseTripVersion,
    scope: pending.scope,
    operations: pending.output.operations,
    snippets: snippetsOf(pending.output),
    // 未持久化的展示辅助字段：空值兜底（重载后少展示补充信息，不阻塞应用链路）
    unplaced: [],
    proposedNew: [],
    clarify: null,
    sourceSnapshots,
    sourceCount: sourceSnapshots.length,
    mentionCount,
    placeCount: 0,
    mentionRefCount: 0,
    latencyMs: 0,
    promptChars: 0,
    attempts: 1,
    directives: pending.directives,
    requirementChecks: pending.requirementChecks,
    conflicts: pending.conflicts,
    // Task #250：分类解释随草案快照持久化；旧草案缺省时前端按原操作列表展示
    explanation: pending.explanation,
  };
}
