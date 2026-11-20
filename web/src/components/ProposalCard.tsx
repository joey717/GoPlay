import { useMemo, useState } from "react";
import type { EntityRef, Operation, Trip } from "@goplay/shared";
import { confirmProposal, ApiError, type IntentResult } from "../api/client";
import { visitDayIndexOf, visitDisplayName } from "../lib/trip";

interface ProposalCardProps<T = IntentResult> {
  tripId: string;
  /** 服务端 needsProposal 返回的敏感操作（remove / setPurchase / lock）；
   *  B4 草案场景传草案全部操作（plan / setDuration / move 等）作概览 */
  operations: Operation[];
  /** 当前行程，用于解析实体名称与危险状态标记 */
  trip: Trip;
  /** Sheet 标题（默认「确认 AI 提案」；草案场景传「攻略草案」） */
  title?: string;
  /** Sheet 副标题（默认敏感操作说明文案） */
  subtitle?: string;
  /** 确认按钮文案（默认「执行选中的 N 项」） */
  confirmText?: string;
  /** false 时隐藏逐条勾选与全选（B4 草案应用是原子的，不支持部分执行） */
  allowToggle?: boolean;
  /** 自定义确认执行器（默认 confirmProposal；B4 草案传 applyGuideDraft 包装，忽略 selected） */
  confirmExecutor?: (tripId: string, selected: Operation[]) => Promise<T>;
  /** 确认执行成功后上抛（默认通道为 IntentResult，由容器应用权威 trip） */
  onConfirm: (result: T) => void;
  onCancel: () => void;
  /** 列表下方的补充说明行（如草案提示挂载数 / 未安排项） */
  notes?: string[];
}

const OP_BADGE: Record<string, { label: string; tone: "warn" | "slate" | "clay" | "sage" }> = {
  remove: { label: "移除", tone: "warn" },
  setPurchase: { label: "购票", tone: "slate" },
  lock: { label: "锁定", tone: "clay" },
  plan: { label: "编排", tone: "sage" },
  setDuration: { label: "时长", tone: "slate" },
  move: { label: "排序", tone: "slate" },
  transfer: { label: "归类", tone: "slate" },
  setTime: { label: "时间", tone: "slate" },
};

/** 操作影响的实体引用（提案阶段以单实体敏感操作为主，plan 等多项操作返回 null） */
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
    const hit =
      stop.matchedPointRef !== null
        ? trip.itemRegistry[stop.matchedPointRef]?.name
        : null;
    return hit ?? stop.customName ?? "未命名玩法";
  }
  if (ref.kind === "point") return trip.itemRegistry[ref.id]?.name ?? "未知点位";
  if (ref.kind === "day") return `Day${ref.dayIndex}`;
  if (ref.kind === "lodging") return `Day${ref.dayIndex} 住宿`;
  return trip.hotelRegistry[ref.id]?.name ?? "未知酒店";
}

/** 实体所在天（visit / stop 按 refs 反查；point 按已排 Visit 反查；hotel 引用无天位置返回 null） */
function targetDayIndex(trip: Trip, ref: EntityRef): number | null {
  if (ref.kind === "visit") {
    const visit = trip.visits[ref.id];
    return visit !== undefined ? visitDayIndexOf(trip, visit) : null;
  }
  if (ref.kind === "stop") {
    const stop = trip.stops[ref.id];
    if (stop === undefined || stop.visitRef === null) return null;
    const visit = trip.visits[stop.visitRef];
    return visit !== undefined ? visitDayIndexOf(trip, visit) : null;
  }
  if (ref.kind === "point") {
    for (const visit of Object.values(trip.visits)) {
      if (visit.pointRef === ref.id) {
        const dayIndex = visitDayIndexOf(trip, visit);
        if (dayIndex !== null) return dayIndex;
      }
    }
    return null;
  }
  if (ref.kind === "day" || ref.kind === "lodging") return ref.dayIndex;
  // hotel：引用只有 hotelId，不含天位置；不猜测归属（hotel id 不进 dayIndex 分支）
  return null;
}

/** 容器可读短语（remove/transfer 描述用） */
function containerLabel(trip: Trip, ref: EntityRef | { kind: "globalPool" | "pendingPool" | "visitPool"; visitId?: string }): string {
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

/** 操作的人类可读描述（配合实体名展示；v1.1 ref 寻址） */
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
    default:
      return "";
  }
}

/** 命中数超过当天点位一半的天（顶部警示横幅依据）；按实体实际位置归组 */
function overloadedDays(trip: Trip, operations: Operation[]): number[] {
  const perDay = new Map<number, Set<string>>();
  for (const op of operations) {
    const ref = affectedRef(op);
    if (ref === null) continue;
    const dayIndex = targetDayIndex(trip, ref);
    if (dayIndex === null) continue;
    const day = trip.days[trip.dayRefs[dayIndex - 1]];
    if (day === undefined || day.scheduleVisitRefs.length === 0) continue;
    const key = ref.kind === "visit" || ref.kind === "stop" ? ref.id : `${ref.kind}:${ref.kind === "point" ? ref.id : ""}`;
    const ids = perDay.get(dayIndex) ?? new Set<string>();
    ids.add(key);
    perDay.set(dayIndex, ids);
  }
  const days: number[] = [];
  for (const [dayIndex, ids] of perDay) {
    const day = trip.days[trip.dayRefs[dayIndex - 1]];
    if (day !== undefined && day.scheduleVisitRefs.length > 0 && ids.size * 2 > day.scheduleVisitRefs.length) {
      days.push(dayIndex);
    }
  }
  return days.sort((a, b) => a - b);
}

/** 敏感操作命中的 Visit（已购/已锁定红线标记；stop/point 不适用） */
function guardedVisitId(trip: Trip, ref: EntityRef | null): string | null {
  if (ref === null) return null;
  if (ref.kind === "visit") return ref.id;
  if (ref.kind === "stop") return trip.stops[ref.id]?.visitRef ?? null;
  return null;
}

/**
 * 提案确认 Sheet：AI 涉及 remove / setPurchase / lock 时逐条人审。
 * 勾选默认全选，0 项勾选不可执行；confirmProposal 由本组件调用，
 * 结果经 onConfirm 上抛（服务端护栏仍会拦截 bought/locked 红线）。
 *
 * B4 泛型化（Task #98）：confirmExecutor 可替换默认的 confirmProposal
 * （攻略草案传 applyGuideDraft，原子应用不支持勾选 → allowToggle=false 隐藏
 * 勾选与全选）；标题 / 副标题 / 确认文案 / 补充说明行均可覆盖。
 */
export default function ProposalCard<T = IntentResult>({
  tripId,
  operations,
  trip,
  title,
  subtitle,
  confirmText,
  allowToggle = true,
  confirmExecutor,
  onConfirm,
  onCancel,
  notes,
}: ProposalCardProps<T>) {
  const [checked, setChecked] = useState<boolean[]>(() => operations.map(() => true));
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const warnings = useMemo(() => overloadedDays(trip, operations), [trip, operations]);
  const checkedCount = checked.filter(Boolean).length;
  /** 草案原子应用（allowToggle=false）不受勾选数为 0 限制（空操作草案仅挂提示） */
  const executable = allowToggle ? checkedCount > 0 : true;

  function toggle(index: number) {
    setChecked((prev) => prev.map((value, i) => (i === index ? !value : value)));
  }

  function toggleAll() {
    const next = checkedCount < operations.length;
    setChecked(operations.map(() => next));
  }

  async function handleConfirm() {
    if (submitting || !executable) return;
    setSubmitting(true);
    setErrorMsg(null);
    const selected = operations.filter((_, index) => checked[index]);
    const executor =
      confirmExecutor ??
      ((tid: string, ops: Operation[]) => confirmProposal(tid, ops) as Promise<T>);
    try {
      const result = await executor(tripId, selected);
      onConfirm(result);
    } catch (err) {
      setSubmitting(false);
      // B4：服务端拒绝（如草案 DRAFT_STALE「行程已变化，请重新生成」）时透传安全 message
      setErrorMsg(err instanceof ApiError ? err.message : "确认执行失败，请检查网络后重试");
    }
  }

  return (
    <>
      <div className="proposal-overlay" onClick={submitting ? undefined : onCancel} aria-hidden="true" />
      <div className="proposal-sheet" role="dialog" aria-modal="true" aria-label={title ?? "确认 AI 操作提案"}>
        <div className="proposal-head">
          <div>
            <div className="t1">{title ?? "确认 AI 提案"}</div>
            <div className="t2">{subtitle ?? "以下操作涉及移除、购票或锁定，勾选确认后才会生效"}</div>
          </div>
          <button type="button" className="x" onClick={onCancel} disabled={submitting} aria-label="取消提案">
            ✕
          </button>
        </div>

        {warnings.length > 0 ? (
          <div className="proposal-warn" role="alert">
            ⚠ Day{warnings.join("、Day")} 将影响过半点位，请逐条确认
          </div>
        ) : null}

        {errorMsg !== null ? <div className="proposal-err" role="alert">{errorMsg}</div> : null}

        <div className="proposal-list">
          {operations.map((op, index) => {
            const ref = affectedRef(op);
            const target = ref !== null ? describeTarget(trip, ref) : op.op;
            const dayIndex = ref !== null ? targetDayIndex(trip, ref) : null;
            const guardedId = guardedVisitId(trip, ref);
            const guardedVisit = guardedId !== null ? trip.visits[guardedId] : undefined;
            const danger =
              guardedVisit !== undefined && (guardedVisit.locked || guardedVisit.purchaseState === "bought");
            const badge = OP_BADGE[op.op] ?? { label: op.op, tone: "slate" as const };
            const itemKey = `${op.op}-${ref?.kind ?? "op"}-${ref?.kind === "visit" || ref?.kind === "stop" || ref?.kind === "point" ? ref.id : index}-${index}`;
            const body = (
              <>
                <span className={`proposal-badge ${badge.tone}`}>{badge.label}</span>
                <span className="proposal-body">
                  <span className="pn">
                    {ref !== null ? target : "多项编排"}
                    {dayIndex !== null ? <em> · Day{dayIndex}</em> : null}
                    {danger ? <em className="danger-note">（已购/已锁定，护栏可能拦截）</em> : null}
                  </span>
                  <span className="pd">{describeOp(trip, op)}</span>
                  <span className="pr">{op.reason}</span>
                </span>
              </>
            );
            if (!allowToggle) {
              return (
                <div key={itemKey} className={`proposal-item readonly${danger ? " danger" : ""}`}>
                  {body}
                </div>
              );
            }
            return (
              <label key={itemKey} className={`proposal-item${danger ? " danger" : ""}`}>
                <input
                  type="checkbox"
                  checked={checked[index] ?? false}
                  onChange={() => toggle(index)}
                  disabled={submitting}
                />
                {body}
              </label>
            );
          })}
        </div>

        {notes !== undefined && notes.length > 0 ? (
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
          {allowToggle ? (
            <button
              type="button"
              className="ghost select-all"
              onClick={toggleAll}
              disabled={submitting}
            >
              {checkedCount === operations.length ? "全不选" : "全选"}
            </button>
          ) : null}
          <button
            type="button"
            className="cta"
            onClick={() => void handleConfirm()}
            disabled={submitting || !executable}
          >
            {submitting
              ? "执行中…"
              : (confirmText ?? (allowToggle ? `执行选中的 ${checkedCount} 项` : "确认执行"))}
          </button>
        </div>
      </div>
    </>
  );
}
