import { useState } from "react";
import type {
  EntityRef,
  GuideDraftClassifiedItem,
  GuideDraftConflict,
  GuideDraftEntityClassification,
  GuideDraftExplanation,
  Operation,
  Trip,
} from "@goplay/shared";
import {
  ApiError,
  applyGuideDraft,
  type GuideDraftApplyResult,
  type GuideDraftResult,
  type GuideDraftScope,
} from "../api/client";
import { isSnippetOnlyApplySuccess } from "../lib/draftApplyNotice";
import { visitDayIndexOf, visitDisplayName } from "../lib/trip";

interface GuideDraftReviewProps {
  tripId: string;
  trip: Trip;
  /** 服务端草案响应（Task #123 契约；旧服务端可能缺 directives/conflicts 等新字段，一律按 undefined 兼容） */
  draft: GuideDraftResult;
  /** 应用成功上抛（NoteInput → TripView：requirementSummary/未选冲突/自动归类由父级展示，此处不做笼统成功提示） */
  onApplied: (result: GuideDraftApplyResult) => void;
  /** 应用后仍有敏感操作：转交 TripView 全局 ProposalCard 逐条确认 */
  onProposalNeeded: (operations: Operation[]) => void;
  onCancel: () => void;
}

/** 冲突种类的用户语言短标签（敏感可执行项的「短原因」徽章；纯告知项 detail 已完整说明） */
const CONFLICT_KIND_LABEL: Record<string, string> = {
  subject_locked: "已锁定",
  subject_bought: "已购票",
  child_locked: "已锁定",
  child_bought: "已购票",
  target_day_occupied: "已有安排",
  target_day_locked: "锁定项",
  target_day_bought: "已购票",
  target_day_flight: "航班约束",
};

/** 指令满足状态的用户语言符号（不展示 met/partial/unmet 内部码；说明直接用服务端 detail） */
const REQUIREMENT_MARK: Record<string, string> = {
  met: "✓",
  partial: "○",
  unmet: "✕",
  pending: "？",
};

const OP_BADGE: Record<string, { label: string; tone: "warn" | "slate" | "clay" | "sage" }> = {
  remove: { label: "移除", tone: "warn" },
  setPurchase: { label: "购票", tone: "slate" },
  lock: { label: "锁定", tone: "clay" },
  plan: { label: "编排", tone: "sage" },
  setDuration: { label: "时长", tone: "slate" },
  move: { label: "排序", tone: "slate" },
  transfer: { label: "归类", tone: "slate" },
  setTime: { label: "时间", tone: "slate" },
  classifyVisitAsStop: { label: "归入景区", tone: "sage" },
};

/**
 * Task #250：分类分组的展示顺序与标签（服务端给分类，前端只负责分组渲染）。
 * 分类值本身不出现在界面上，一律用用户语言。
 */
const PLAN_GROUP_META: Record<
  GuideDraftEntityClassification,
  { label: string; tone: "warn" | "slate" | "clay" | "sage" }
> = {
  remove: { label: "移出并回到候选池", tone: "warn" },
  rearrange: { label: "重新排入", tone: "sage" },
  new: { label: "本轮新增", tone: "clay" },
  // Task #253：属性 / 内部路线调整（setTime / setDuration / setPurchase / lock /
  // 同天改序 / 内部 Stop 排入与改挂）——真实调整，不能混进「仅补攻略亮点」
  adjust: { label: "调整细节", tone: "clay" },
  retain: { label: "既有保留", tone: "slate" },
  snippet_only: { label: "仅补攻略亮点", tone: "slate" },
};

const PLAN_GROUP_ORDER: GuideDraftEntityClassification[] = [
  "remove",
  "rearrange",
  "new",
  "adjust",
  "retain",
  "snippet_only",
];

/** 分类项按服务端分类分组（空组不渲染；旧草案无 explanation 时返回空数组） */
function groupClassifiedItems(
  items: GuideDraftClassifiedItem[],
): { classification: GuideDraftEntityClassification; items: GuideDraftClassifiedItem[] }[] {
  return PLAN_GROUP_ORDER.map((classification) => ({
    classification,
    items: items.filter((item) => item.classification === classification),
  })).filter((group) => group.items.length > 0);
}

/** 操作影响的实体引用（与全局 ProposalCard 同语义；plan 无单实体返回 null） */
function affectedRef(op: Operation): EntityRef | null {
  switch (op.op) {
    case "remove":
    case "setPurchase":
    case "lock":
    case "setDuration":
    case "move":
    case "transfer":
    case "setTime":
      return op.subjectRef;
    default:
      return null;
  }
}

/** 实体可读名称（visit / stop / point / day / lodging / hotel） */
function describeTarget(trip: Trip, ref: EntityRef): string {
  if (ref.kind === "visit") {
    const visit = trip.visits[ref.id];
    return visit !== undefined ? visitDisplayName(trip, visit) : "未知点位";
  }
  if (ref.kind === "stop") {
    const stop = trip.stops[ref.id];
    if (stop === undefined) return "未知玩法";
    const hit = stop.matchedPointRef !== null ? trip.itemRegistry[stop.matchedPointRef]?.name : null;
    return hit ?? stop.customName ?? "未命名玩法";
  }
  if (ref.kind === "point") return trip.itemRegistry[ref.id]?.name ?? "未知点位";
  if (ref.kind === "day") return `Day${ref.dayIndex}`;
  if (ref.kind === "lodging") return `Day${ref.dayIndex} 住宿`;
  return trip.hotelRegistry[ref.id]?.name ?? "未知酒店";
}

/** 容器可读短语（remove/transfer 描述用） */
function containerLabel(
  trip: Trip,
  ref: EntityRef | { kind: "globalPool" | "pendingPool" | "visitPool"; visitId?: string },
): string {
  if (ref.kind === "day") return `Day${ref.dayIndex}`;
  if (ref.kind === "globalPool") return "候选区";
  if (ref.kind === "pendingPool") return "待定加入";
  if (ref.kind === "visitPool") {
    const visitId = ref.visitId;
    if (visitId === undefined) return "备选玩法";
    const visit = trip.visits[visitId];
    return visit !== undefined ? `「${visitDisplayName(trip, visit)}」备选玩法` : "备选玩法";
  }
  if (ref.kind === "visit") {
    const visit = trip.visits[ref.id];
    return visit !== undefined ? `「${visitDisplayName(trip, visit)}」` : "大景区";
  }
  return "相关位置";
}

/** 操作的人类可读描述（含 Task #122 归类族；未知 op 回退空串由 badge 兜底） */
function describeOp(trip: Trip, op: Operation): string {
  switch (op.op) {
    case "remove":
      return `从${containerLabel(trip, op.fromContainerRef)}移除`;
    case "setPurchase":
      return op.value === "bought"
        ? "标记为已购票"
        : op.value === "toBuy"
          ? "标记为现场买"
          : op.value === "noTicket"
            ? "标记为无需购票"
            : "清除购票标记";
    case "lock":
      return op.value ? "锁定（AI 不再调整）" : "解除锁定";
    case "setDuration":
      return `调整时长为 ${op.minutes} 分钟`;
    case "move":
      return `${containerLabel(trip, op.containerRef)}内移动到第 ${op.toOrder + 1} 位`;
    case "transfer":
      return `从${containerLabel(trip, op.fromContainerRef)}转移到${containerLabel(trip, op.toContainerRef)}${
        op.toOrder !== null ? `第 ${op.toOrder + 1} 位` : "末尾"
      }`;
    case "setTime":
      return op.subjectRef.kind === "day"
        ? `设置 Day${op.subjectRef.dayIndex} 出发时间为 ${op.value}`
        : `设置时间为 ${op.value}`;
    case "plan":
      return `编排到 Day${op.scopeRef.kind === "day" ? op.scopeRef.dayIndex : ""}（${op.assignments.length} 项）`;
    case "classifyVisitAsStop": {
      const parent = trip.visits[op.parentVisitId];
      return parent !== undefined
        ? `归入「${visitDisplayName(trip, parent)}」内部行程`
        : "归入父景区内部行程";
    }
    default:
      return "";
  }
}

/** 草案 scope 的用户可读标签（自 NoteInput.scopeLabel 迁入，语义不变） */
function scopeLabel(trip: Trip, scope: GuideDraftScope | null): string {
  if (scope === null) return "";
  if (scope.kind === "trip") return "全程范围";
  if (scope.kind === "day") return `Day${scope.dayIndex} 范围`;
  const visit = trip.visits[scope.visitId];
  return visit !== undefined ? `「${visitDisplayName(trip, visit)}」范围` : "大景区范围";
}

/** 草案补充说明行（自 NoteInput.draftNotes 迁入，语义不变；Task #263 细化「仅补提示」措辞） */
function draftNotes(draft: GuideDraftResult): string[] {
  const notes: string[] = [];
  const snippetCount = draft.snippets.length;
  if (draft.operations.length === 0) {
    // Task #263：只有攻略提示、没有结构操作时，说明要读成「补充」而不是「空草案 / 没排成」
    notes.push(
      snippetCount > 0
        ? `仅补充 ${snippetCount} 条攻略提示，不改动行程结构`
        : "本草案不调整行程结构",
    );
  } else if (snippetCount > 0) {
    notes.push(`应用后将为对应点位添加 ${snippetCount} 条攻略提示`);
  }
  if (draft.unplaced.length > 0) notes.push(`${draft.unplaced.length} 项攻略素材未纳入草案（缺时间信息或已存在）`);
  if (draft.proposedNew.length > 0) notes.push(`包含 ${draft.proposedNew.length} 个新点位建议`);
  if (draft.clarify !== null && draft.clarify !== "") notes.push(draft.clarify);
  return notes;
}

/**
 * 草案预览与一次性确认（任务 125，替代原 ProposalCard 原子应用通道）：
 * - 单 Sheet 完成，不再多层弹窗：操作概览（只读）+ 「需要你确认」冲突卡片 + 单个应用按钮；
 * - directives 非空时展示「你的明确要求」（如「后海」安排到 Day3）+ 指令满足详情
 *   （✓/○/✕ 符号 + 服务端用户语言 detail，不显示 met/partial/unmet 内部码）；
 * - Task #253：存在整日替换（mode="replace"）指令时，额外渲染**绑定当前 draftId** 的
 *   明确确认勾选。未勾选时不发送 replaceConfirm（服务端默认不执行任何整日移回），
 *   只应用新增安排，原 Day 安排保持不变；勾选后才发送 { draftId, confirmed: true }。
 *   组件以 key={draft.draftId} 挂载，草案变化即重建 → 上一份草案的勾选不会被沿用；
 * - conflicts 非空时渲染唯一紧凑区块：resolution 非空才有勾选框，默认值取
 *   defaultSelected（普通冲突默认选、敏感默认不选并显示短原因徽章），纯告知项
 *   （resolution=null）无勾选框只展示；「按新要求调整全部」总开关一次选中全部
 *   可执行且非敏感项，用户仍可逐项覆盖，不对每项弹 ConfirmDialog；
 * - 应用提交 selectedConflictIds（有冲突区块时显式提交勾选集合，含空数组=都不执行；
 *   无冲突保持 body {}）；成功后经 onApplied 上抛完整结果，由 TripView 展示
 *   requirementSummary / 未选冲突保持原状 / autoClassifications 明细；
 * - Task #263：applied 为空但攻略提示已挂载（snippet-only）同样走**成功**分支：
 *   不设置 errorMsg、照常上抛结果，提示文案由 buildDraftApplyNotice 统一给出；
 * - 选中状态清理：NoteInput 以 key={draft.draftId} 挂载本组件——取消卸载、重新
 *   生成/草案变化时强制重建，不沿用旧草案的 conflict id。
 */
export default function GuideDraftReview({
  tripId,
  trip,
  draft,
  onApplied,
  onProposalNeeded,
  onCancel,
}: GuideDraftReviewProps) {
  // 兼容旧服务端响应：Task #123 新字段缺失（undefined）时按空集合处理
  const directives = draft.directives ?? [];
  const requirementChecks = draft.requirementChecks ?? [];
  const conflicts = draft.conflicts ?? [];
  // Task #250：旧草案 / 旧服务端无 explanation 时为 null，整块解释区不渲染（原 UI 不变）
  const explanation: GuideDraftExplanation | null = draft.explanation ?? null;
  const classifiedGroups = groupClassifiedItems(explanation?.items ?? []);
  const replaceSummaries = explanation?.replaceSummaries ?? [];

  // 勾选集合初值=defaultSelected（=!sensitive && resolution 非空）；组件随草案重建，不跨草案保留
  const [selected, setSelected] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (const conflict of conflicts) {
      if (conflict.defaultSelected === true && conflict.resolution !== null) {
        initial.add(conflict.conflictId);
      }
    }
    return initial;
  });
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Task #253：整日替换的明确确认（默认不勾选 = 旧安排不移回；随草案重建而重置）
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);

  /** 需要整日移回旧安排的指令（append 指令不参与确认） */
  const replaceDirectives = directives.filter((directive) => directive.mode === "replace");
  /** 确认控件只在有 replace 指令且草案 id 存在时才可用（id 缺失无法绑定确认） */
  const replaceConfirmAvailable = replaceDirectives.length > 0 && draft.draftId !== null;
  const replaceDayText = [...new Set(replaceDirectives.map((directive) => directive.dayIndex))]
    .sort((left, right) => left - right)
    .map((dayIndex) => `Day${dayIndex}`)
    .join("、");

  /** 可执行且非敏感的冲突（总开关只批量选中这部分；敏感项须用户单独勾选） */
  const plainSelectable = conflicts.filter(
    (conflict) => conflict.resolution !== null && conflict.sensitive !== true,
  );
  /** 存在可执行冲突 → 应用按钮文案切换为「应用草案及已选调整」 */
  const hasSelectable = conflicts.some((conflict) => conflict.resolution !== null);
  const allSelected =
    plainSelectable.length > 0 && plainSelectable.every((conflict) => selected.has(conflict.conflictId));

  function toggleConflict(conflictId: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(conflictId)) next.delete(conflictId);
      else next.add(conflictId);
      return next;
    });
  }

  /**
   * 总开关「按新要求调整全部」：开=只选中可执行且非敏感项（敏感项不自动选中，
   * 重置为未选）；关=清空全部勾选（含逐项手动勾选的敏感项）。逐项勾选后总开关
   * 状态自动反映（全部非敏感可执行项被选中才亮）。
   */
  function toggleAll(): void {
    setSelected(() => {
      if (allSelected) return new Set<string>();
      const next = new Set<string>();
      for (const conflict of conflicts) {
        if (conflict.resolution !== null && conflict.sensitive !== true) {
          next.add(conflict.conflictId);
        }
      }
      return next;
    });
  }

  async function handleApply(): Promise<void> {
    if (submitting) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      // 有冲突区块时显式提交勾选集合（空数组=用户确认都不执行，语义同服务端
      // selectedConflictIds 缺省）；无冲突保持既有简洁 body {}
      const selectedIds = conflicts
        .filter((conflict) => conflict.resolution !== null && selected.has(conflict.conflictId))
        .map((conflict) => conflict.conflictId);
      // Task #253：只有用户勾选确认才发送 replaceConfirm（绑定当前 draftId）；
      // 未勾选 / 草案 id 缺失 → 不发送，服务端不执行任何整日移回
      const replaceConfirm =
        replaceConfirmAvailable && replaceConfirmed && draft.draftId !== null
          ? { draftId: draft.draftId, confirmed: true }
          : undefined;
      const result = await applyGuideDraft(
        tripId,
        hasSelectable ? selectedIds : undefined,
        replaceConfirm,
      );
      // Task #263：snippet-only 结果（operations=[]，但攻略提示已挂载）是**成功**——
      // 不能因为 applied 为空就把它当失败（不写 errorMsg、不拦上抛）。应用通知由
      // 父级 buildDraftApplyNotice 按 kind=success 展示「行程结构无需变更，已添加 N 条攻略提示」。
      if (isSnippetOnlyApplySuccess(result)) setErrorMsg(null);
      // 成功路径同样复位提交态：父级可能保留本组件（如后续还需要展示同一份草案）
      setSubmitting(false);
      onApplied(result);
      if (result.type === "proposal" && (result.needsProposal?.length ?? 0) > 0) {
        onProposalNeeded(result.needsProposal ?? []);
      }
    } catch (err) {
      setSubmitting(false);
      // DRAFT_STALE（行程已变化）等服务端拒绝透传安全 message
      setErrorMsg(err instanceof ApiError ? err.message : "应用失败，请检查网络后重试");
    }
  }

  const notes = draftNotes(draft);
  const scopeText = scopeLabel(trip, draft.scope);

  return (
    <>
      <div className="proposal-overlay" onClick={submitting ? undefined : onCancel} aria-hidden="true" />
      <div className="proposal-sheet" role="dialog" aria-modal="true" aria-label="攻略草案">
        <div className="proposal-head">
          <div>
            <div className="t1">攻略草案</div>
            <div className="t2">基于 {draft.sourceCount} 篇攻略{scopeText !== "" ? ` · ${scopeText}` : ""}；确认后应用到当前行程</div>
          </div>
          <button type="button" className="x" onClick={onCancel} disabled={submitting} aria-label="取消草案">
            ✕
          </button>
        </div>

        {errorMsg !== null ? <div className="proposal-err" role="alert">{errorMsg}</div> : null}

        {/* Task #250：这轮会怎么调整——replace 摘要 + 分类分组（服务端口径，前端不推断） */}
        {replaceSummaries.length > 0 || classifiedGroups.length > 0 ? (
          <div className="draft-review-plan" role="group" aria-label="这轮会怎么调整">
            <div className="draft-review-plan-title">这轮会怎么调整</div>
            {replaceSummaries.map((summary) => (
              <div key={summary.directiveId} className="draft-review-replace">
                <span className="draft-review-replace-tag">整日替换</span>
                <span className="draft-review-replace-text">{summary.text}</span>
              </div>
            ))}
            {classifiedGroups.map((group) => (
              <div key={group.classification} className="draft-review-plan-group">
                <div className="draft-review-plan-label">
                  <span className={`proposal-badge ${PLAN_GROUP_META[group.classification].tone}`}>
                    {PLAN_GROUP_META[group.classification].label}
                  </span>
                  <span className="draft-review-plan-count">{group.items.length} 项</span>
                </div>
                <div className="draft-review-plan-items">
                  {group.items.map((item) => (
                    <div key={item.key} className={`draft-review-plan-item ${item.classification}`}>
                      <span className="draft-review-plan-name">{item.displayName}</span>
                      {item.dayIndex !== null ? (
                        <span className="draft-review-plan-day">Day{item.dayIndex}</span>
                      ) : null}
                      <span className="draft-review-plan-detail">{item.detail}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {/* 明确要求（directives 非空才出现）：一句话要求 + 用户语言的满足详情 */}
        {directives.length > 0 ? (
          <div className="draft-review-directives">
            <div className="draft-review-directives-title">你的明确要求</div>
            {directives.map((directive) => (
              <div key={directive.directiveId} className="draft-review-directive">
                {directive.mode === "replace"
                  ? `整日重排 Day${directive.dayIndex}${directive.placeText !== "" ? `（以「${directive.placeText}」为主题）` : ""}`
                  : `「${directive.placeText}」安排到 Day${directive.dayIndex}`}
              </div>
            ))}
            {requirementChecks.map((check) => (
              <div key={check.directiveId} className={`draft-review-check ${check.status ?? "pending"}`}>
                <span className="draft-review-check-mark" aria-hidden="true">
                  {REQUIREMENT_MARK[check.status] ?? "？"}
                </span>
                <span className="draft-review-check-detail">{check.detail}</span>
              </div>
            ))}
          </div>
        ) : null}

        {/* 操作概览（只读；冲突与红线信息由下方确认卡片承载，此处不再重复警示标注） */}
        {draft.operations.length > 0 ? (
          <div className="proposal-list">
            {draft.operations.map((op, index) => {
              const ref = affectedRef(op);
              const badge = OP_BADGE[op.op] ?? { label: op.op, tone: "slate" as const };
              return (
                <div key={`${op.op}-${index}`} className="proposal-item readonly">
                  <span className={`proposal-badge ${badge.tone}`}>{badge.label}</span>
                  <span className="proposal-body">
                    <span className="pn">{ref !== null ? describeTarget(trip, ref) : "多项编排"}</span>
                    <span className="pd">{describeOp(trip, op)}</span>
                    <span className="pr">{op.reason}</span>
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}

        {/* Task #253 整日替换明确确认：绑定当前草案；不勾选则仅应用新增安排 */}
        {replaceDirectives.length > 0 ? (
          <div className="draft-review-replace-confirm" role="group" aria-label="整日替换确认">
            <label className="draft-review-replace-confirm-row">
              <input
                type="checkbox"
                checked={replaceConfirmed}
                onChange={() => setReplaceConfirmed((prev) => !prev)}
                disabled={submitting || !replaceConfirmAvailable}
                aria-label="确认整日替换"
              />
              <span className="draft-review-replace-confirm-body">
                <span className="draft-review-replace-confirm-title">
                  {replaceConfirmAvailable
                    ? `确认整日替换 ${replaceDayText}：原有安排将被移回候选池后按攻略重排`
                    : `整日替换 ${replaceDayText} 需要草案编号，本次只能应用新增安排`}
                </span>
                <span className="draft-review-replace-confirm-detail">
                  不勾选时只应用本轮新增安排，原有安排保持不变（不做整日移回）。
                </span>
              </span>
            </label>
          </div>
        ) : null}

        {/* 「需要你确认」唯一紧凑区块（conflicts 非空才出现）：可执行项勾选、纯告知项只展示 */}
        {conflicts.length > 0 ? (
          <div className="draft-review-conflicts" role="group" aria-label="需要你确认">
            <div className="draft-review-conflicts-title">需要你确认</div>
            <div className="draft-review-conflicts-sub">草案与现有安排有冲突，勾选后随草案一起应用</div>
            {plainSelectable.length > 0 ? (
              <label className="draft-review-conflict-all">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  disabled={submitting}
                  aria-label="按新要求调整全部"
                />
                <span>按新要求调整全部</span>
              </label>
            ) : null}
            <div className="draft-review-conflict-list">
              {conflicts.map((conflict: GuideDraftConflict) => {
                const executable = conflict.resolution !== null;
                const kindLabel = CONFLICT_KIND_LABEL[conflict.kind] ?? "";
                const body = (
                  <span className="draft-review-conflict-body">
                    <span className="draft-review-conflict-name">
                      {conflict.subjectLabel}
                      {conflict.sensitive === true && executable && kindLabel !== "" ? (
                        <em className="draft-review-conflict-tag">{kindLabel}</em>
                      ) : null}
                    </span>
                    <span className="draft-review-conflict-detail">{conflict.detail}</span>
                  </span>
                );
                // 纯告知项（resolution=null：已有安排汇总 / 航班约束 / 被拦截的自动归类）无勾选框
                if (!executable) {
                  return (
                    <div key={conflict.conflictId} className="draft-review-conflict readonly">
                      <span className="draft-review-conflict-info" aria-hidden="true">ⓘ</span>
                      {body}
                    </div>
                  );
                }
                return (
                  <label key={conflict.conflictId} className="draft-review-conflict">
                    <input
                      type="checkbox"
                      checked={selected.has(conflict.conflictId)}
                      onChange={() => toggleConflict(conflict.conflictId)}
                      disabled={submitting}
                      aria-label={conflict.subjectLabel}
                    />
                    {body}
                  </label>
                );
              })}
            </div>
          </div>
        ) : null}

        {notes.length > 0 ? (
          <div className="proposal-notes">
            {notes.map((note) => (
              <div key={note}>{note}</div>
            ))}
          </div>
        ) : null}

        <div className="proposal-actions">
          <button type="button" className="ghost" onClick={onCancel} disabled={submitting}>
            取消
          </button>
          {/* 全屏唯一橙色主按钮：有可执行冲突时明示「及已选调整」，无冲突保持简洁文案 */}
          <button
            type="button"
            className="cta"
            onClick={() => void handleApply()}
            disabled={submitting}
          >
            {submitting
              ? "应用中…"
              : replaceDirectives.length > 0 && !replaceConfirmed && replaceConfirmAvailable
                ? "仅应用新增安排"
                : hasSelectable
                  ? "应用草案及已选调整"
                  : "应用草案到行程"}
          </button>
        </div>
      </div>
    </>
  );
}
