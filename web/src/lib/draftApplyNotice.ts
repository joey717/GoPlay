import { describeRejections } from "@goplay/shared";
import type { GuideDraftApplyResult } from "../api/client";

/**
 * 草案应用结果的语义（Task #263）：调用方据此决定提示语气，不再用「applied 是否为空」
 * 这个单一指标推断成功/失败。
 *
 * - success：确有落地（行程结构调整，或仅挂载攻略提示 / 实用参考的非结构补充）；
 * - partial：部分调整被安全规则跳过；
 * - skipped：全部调整被安全规则跳过（行程结构未变更）；
 * - noop：确实没有可落地的变更（重复应用 / 空草案），中性提示，不是失败。
 */
export type DraftApplyNoticeKind = "success" | "partial" | "skipped" | "noop";

/** 草案应用结果的展示形状：head 为主提示行，details 为可展开的逐条明细 */
export interface DraftApplyNotice {
  head: string;
  details: string[];
  kind: DraftApplyNoticeKind;
}

/**
 * 攻略补充计数（攻略提示条数 / 实用参考组数）拼成的用户语言短语（Task #263）。
 * 与 server buildApplyMessage 的 supplementNote 同口径：两类都属于「非行程结构变更的攻略补充」。
 */
function supplementLabel(attachedSnippetCount: number, attachedOptionGroupCount: number): string {
  if (attachedSnippetCount > 0 && attachedOptionGroupCount > 0) {
    return `${attachedSnippetCount} 条攻略提示和 ${attachedOptionGroupCount} 组实用参考`;
  }
  if (attachedSnippetCount > 0) return `${attachedSnippetCount} 条攻略提示`;
  if (attachedOptionGroupCount > 0) return `${attachedOptionGroupCount} 组实用参考`;
  return "";
}

/**
 * snippet-only 应用是否成功（Task #263）：
 * 百炼 / 快速路径可能返回 operations=[]，只在应用时把 snippets（及实用参考）挂到点位上。
 * 这种「行程结构无需变更，但攻略补充确实落地」的结果必须算成功——
 * applied.length === 0 不能作为失败判据。
 */
export function isSnippetOnlyApplySuccess(result: GuideDraftApplyResult): boolean {
  if (result.applied.length > 0 || result.rejected.length > 0) return false;
  return result.attachedSnippetCount > 0 || (result.attachedOptionGroupCount ?? 0) > 0;
}

/**
 * 草案应用结果 → 用户可见提示（任务 125：不能笼统显示成功）。
 *
 * - head 优先沿用服务端汇总 message（已含 applied 数 / 拒绝摘要 / 日期指令一句话 /
 *   未选冲突计数，见 server buildApplyMessage）；有拒绝时改用「已应用 N 项 + 跳过 M 项」
 *   的本地文案；
 * - Task #263：**只有攻略补充的 snippet-only 结果一律按成功展示**——applied=0 且
 *   attachedSnippetCount / attachedOptionGroupCount > 0 时，head 固定为「行程结构无需
 *   变更，已添加 N 条攻略提示」（与后端文案一致），不依赖服务端 message 是否为空 /
 *   是否被旧版本写成 no-op 措辞；真正零变更时 kind=noop（中性提示，不是失败）；
 * - Task #253：head **先确定**，再判断是否把 appliedSummary 补进 details。部分拒绝时
 *   head 会被本地文案替换（服务端 message 不再原样展示），若继续用 result.message
 *   判断就会漏掉「实际调整」摘要——改为用最终 head 判断；
 * - details 逐条补齐服务端 message 里只有计数的部分：
 *   0) Task #250 实际调整分类摘要（服务端已拼进 head 时不重复）；
 *   1) 未勾选冲突逐条「保持原状」提示（unselectedConflicts）；
 *   2) 自动归类逐条结果（autoClassifications，如「三和风味馆 已归入「后海」内部行程」）；
 *   3) 有拒绝时沿用既有「拒绝摘要 + 逐条原因」排在最前（保持 Task #105 可见性行为）。
 *
 * 兼容旧服务端响应：requirementSummary 已含在服务端 message 中，不重复展开；
 * unselectedConflicts / autoClassifications 缺省（undefined）时按空处理。
 * rejected 为空且无明细时 details 为空数组——调用方可退回普通轻提示。
 */
export function buildDraftApplyNotice(result: GuideDraftApplyResult): DraftApplyNotice {
  const details: string[] = [];
  const rejectedCount = result.rejected.length;
  const supplement = supplementLabel(
    result.attachedSnippetCount,
    result.attachedOptionGroupCount ?? 0,
  );

  // 1) 先确定最终 head 与「拒绝明细」（部分拒绝 / 整批拒绝会覆盖服务端 message）
  let head = result.message;
  let rejectionDetails: string[] = [];
  let kind: DraftApplyNoticeKind = result.applied.length > 0 ? "success" : "noop";
  if (rejectedCount > 0) {
    kind = result.allRejected ? "skipped" : "partial";
    const reasons = describeRejections(result.rejected.map((rejection) => rejection.reason));
    // 整批拒绝时 rejected 逐条原因被 threshold 占位覆盖，服务端逐条摘要排在最前
    rejectionDetails =
      result.rejectSummary !== null && result.rejectSummary !== ""
        ? [result.rejectSummary, ...reasons]
        : reasons;
    const snippetNote = supplement !== "" ? `（已添加 ${supplement}）` : "";
    head = result.allRejected
      ? `${result.rejectedCount} 项调整因安全规则被跳过，行程结构未变更${snippetNote}`
      : `已应用 ${result.applied.length} 项，另有 ${result.rejectedCount} 项调整因安全规则被跳过`;
  } else if (isSnippetOnlyApplySuccess(result)) {
    // Task #263 核心修复：operations=[] + 提示已挂载 = 成功，绝不能被当成「没应用成功」；
    // 文案与后端 buildApplyMessage 的 supplement 分支保持一致。
    head = `行程结构无需变更，已添加 ${supplement}`;
    kind = "success";
  } else if (result.applied.length > 0) {
    // 服务端 message 缺失（旧版本 / 异常空串）时兜底本地成功文案，避免空白提示
    head = head.trim() === "" ? `已按攻略草案更新行程（${result.applied.length} 项操作）` : head;
  } else if (head.trim() === "") {
    head = "草案无可应用的变更（可能已被应用过）";
  }

  // 2) Task #250：实际调整摘要（用最终 head 判断是否已包含，避免部分拒绝时丢失）
  const appliedSummary =
    typeof result.appliedSummary === "string" && result.appliedSummary !== "" ? result.appliedSummary : null;
  if (appliedSummary !== null && !head.includes(appliedSummary)) {
    details.push(appliedSummary);
  }

  // 未勾选冲突：明示「保持原状」而不是静默跳过
  for (const unselected of result.unselectedConflicts ?? []) {
    const label = typeof unselected?.subjectLabel === "string" ? unselected.subjectLabel : "";
    const reason = typeof unselected?.detail === "string" ? unselected.detail : "";
    if (label !== "") {
      details.push(reason !== "" ? `「${label}」保持原状：${reason}` : `「${label}」保持原状`);
    }
  }

  // 自动归类：逐条说明归属结果（如「三和风味馆 已归入「三亚后海村」内部行程」）
  for (const classification of result.autoClassifications ?? []) {
    if (
      typeof classification?.visitName === "string" &&
      classification.visitName !== "" &&
      typeof classification?.parentName === "string" &&
      classification.parentName !== ""
    ) {
      details.push(`${classification.visitName} 已归入「${classification.parentName}」内部行程`);
    }
  }

  if (rejectedCount > 0) return { head, details: [...rejectionDetails, ...details], kind };
  return { head, details, kind };
}
