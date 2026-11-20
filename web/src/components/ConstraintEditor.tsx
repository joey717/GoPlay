import { useEffect, useRef, useState } from "react";
import type { Constraint } from "@goplay/shared";
import { notifySheetOpened, onSheetOpened } from "../lib/sheetBus";

/**
 * 约束编辑（Task #206）：从 InitFlow Step 2 抽出的公共编辑器。
 * 行程内通过右上 ⋯ 菜单「修改约束」以底部浮层打开（sheet），
 * 初始化流程内嵌在第二步（inline，按钮由外层步骤按钮提供），两处共用同一套
 * 类型下拉 / 时间 / 第几天 / 备注与增删逻辑，避免两份表单各自演化。
 */
interface ConstraintEditorProps {
  /** 当前约束（打开时快照；编辑只改内部草稿，点「保存」才整体交回） */
  initialConstraints: Constraint[];
  /** 行程总天数：「第几天」的上界，同时用于提示文案 */
  totalDays: number;
  /** 行程开始日期（"2026-11-08"）：时间改动时据此推导所属天 */
  startDate: string;
  /** 保存：交回编辑后的完整约束列表（空数组 = 清空全部约束） */
  onSave: (constraints: Constraint[]) => void;
  /** 取消：放弃本次编辑，不写回任何内容 */
  onCancel: () => void;
  /**
   * 内嵌形态的即时同步：每次增删改都把完整列表交回上层。
   * 初始化流程中步骤按钮（跳过约束 / 开始规划）要先拿到最新草稿，不能等「保存」。
   */
  onChange?: (constraints: Constraint[]) => void;
  /**
   * 渲染形态：
   * - sheet（默认）：自带遮罩 + 标题 + 吸底「取消 / 保存」的独立浮层（行程内编辑）；
   * - inline：只有提示 / 列表 / 表单，按钮由外层提供（初始化流程内嵌）。
   */
  variant?: "sheet" | "inline";
}

interface DraftConstraint {
  /** 稳定 id：既有约束沿用原 id，新加的生成一次，保存时原样带回 */
  constraintId: string;
  type: Constraint["type"];
  /** datetime-local 原始值，形如 "2026-11-08T09:40" */
  anchorTime: string;
  dayIndex: number;
  label: string;
}

const DAY_MS = 86_400_000;

const CONSTRAINT_TYPES: Array<{ value: Constraint["type"]; label: string }> = [
  { value: "flight_arrive", label: "航班到达" },
  { value: "flight_depart", label: "航班出发" },
  { value: "hotel_checkin", label: "酒店入住" },
  { value: "hotel_checkout", label: "酒店退房" },
  { value: "ticket_date", label: "门票日期" },
  { value: "custom", label: "自定义" },
];

const LABEL_PLACEHOLDERS: Record<Constraint["type"], string> = {
  flight_arrive: "如：MU5831 落地 09:40",
  flight_depart: "如：MU5832 起飞 18:00",
  hotel_checkin: "如：海棠湾酒店入住 15:00",
  hotel_checkout: "如：酒店退房 12:00",
  ticket_date: "如：蜈支洲岛门票当日有效",
  custom: "如：和朋友晚饭 19:00",
};

/** 根据 anchorTime 与开始日期推导所属天（dayIndex 从 1 开始） */
function dayIndexFromAnchor(anchorTime: string, startDate: string): number {
  if (!anchorTime || !startDate) return 1;
  const diff = Math.floor((Date.parse(anchorTime) - Date.parse(`${startDate}T00:00:00`)) / DAY_MS);
  return diff >= 0 ? diff + 1 : 1;
}

/** ISO8601（"2026-11-08T09:40:00"）→ datetime-local 值（"2026-11-08T09:40"） */
function toLocalInputValue(anchorTime: string): string {
  return anchorTime.slice(0, 16);
}

/** 草稿 → 领域约束：补 ":00" 秒；约束只由用户维护，恒定 locked */
function toConstraint(draft: DraftConstraint): Constraint {
  return {
    constraintId: draft.constraintId,
    type: draft.type,
    anchorTime: draft.anchorTime.length === 16 ? `${draft.anchorTime}:00` : draft.anchorTime,
    dayIndex: draft.dayIndex,
    label: draft.label,
    locked: true,
  };
}

function toDraft(constraint: Constraint): DraftConstraint {
  return {
    constraintId: constraint.constraintId,
    type: constraint.type,
    anchorTime: toLocalInputValue(constraint.anchorTime),
    dayIndex: constraint.dayIndex,
    label: constraint.label,
  };
}

export default function ConstraintEditor({
  initialConstraints,
  totalDays,
  startDate,
  onSave,
  onCancel,
  onChange,
  variant = "sheet",
}: ConstraintEditorProps) {
  /** 「第几天」上界：行程至少 1 天，越界值一律收敛（约束指向不存在的天会被排期忽略） */
  const maxDay = Math.max(1, totalDays);
  const clampDay = (value: number) => Math.min(maxDay, Math.max(1, Math.trunc(value) || 1));

  const [drafts, setDrafts] = useState<DraftConstraint[]>(() => initialConstraints.map(toDraft));
  const [draftType, setDraftType] = useState<Constraint["type"]>("flight_arrive");
  const [anchorTime, setAnchorTime] = useState(() => (startDate ? `${startDate}T09:00` : ""));
  const [dayIndex, setDayIndex] = useState(1);
  const [label, setLabel] = useState("");

  // 内嵌形态的即时同步：草稿变化后把完整列表交回上层（首帧即父级传入内容，无需回抛）
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const liveSyncedRef = useRef(false);
  useEffect(() => {
    if (!liveSyncedRef.current) {
      liveSyncedRef.current = true;
      return;
    }
    onChangeRef.current?.(drafts.map(toConstraint));
  }, [drafts]);

  // 浮层互斥（Task #109 / #206）：sheet 形态挂载即广播 "constraint"，其余底部浮层让位；
  // 反向收到别家 kind 时自关，保证任意时刻至多一个可见。
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  useEffect(() => {
    if (variant !== "sheet") return;
    notifySheetOpened("constraint");
    return onSheetOpened((kind) => {
      if (kind !== "constraint") onCancelRef.current();
    });
  }, [variant]);

  const handleAnchorChange = (value: string) => {
    setAnchorTime(value);
    setDayIndex(clampDay(dayIndexFromAnchor(value, startDate)));
  };

  const addDraft = () => {
    if (!anchorTime) return;
    const fallbackLabel = `${CONSTRAINT_TYPES.find((t) => t.value === draftType)?.label ?? "约束"} ${anchorTime.slice(11)}`;
    setDrafts((prev) => [
      ...prev,
      {
        constraintId: crypto.randomUUID(),
        type: draftType,
        anchorTime,
        dayIndex: clampDay(dayIndex),
        label: label.trim() || fallbackLabel,
      },
    ]);
    setLabel("");
  };

  const removeDraft = (index: number) => {
    setDrafts((prev) => prev.filter((_, i) => i !== index));
  };

  const body = (
    <div className={`constraint-editor${variant === "inline" ? " inline" : ""}`}>
      <div className="init-hint">
        行程共 {maxDay} 天。航班、入住、退房这类已定安排录入后，排行程会避开这些时段，不会被 AI 打乱。
      </div>

      {drafts.length > 0 ? (
        <div className="init-drafts">
          {drafts.map((draft, index) => (
            <div className="init-draft" key={draft.constraintId}>
              <span className="init-draft-label">🔒 {draft.label}</span>
              <span className="init-draft-meta">
                Day{draft.dayIndex} · {draft.anchorTime.replace("T", " ")}
              </span>
              <button type="button" onClick={() => removeDraft(index)}>
                删除
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="constraint-empty">
          还没有录入约束。航班、入住、退房这类已定安排加进来，排行程会自动避开。
        </div>
      )}

      <div className="init-cform">
        <label className="init-field">
          <span>类型</span>
          <select
            value={draftType}
            onChange={(event) => setDraftType(event.target.value as Constraint["type"])}
          >
            {CONSTRAINT_TYPES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="init-field">
          <span>时间</span>
          <input
            type="datetime-local"
            value={anchorTime}
            onChange={(event) => handleAnchorChange(event.target.value)}
          />
        </label>
        <div className="init-crow">
          <label className="init-field small">
            <span>第几天</span>
            <input
              type="number"
              min={1}
              max={maxDay}
              value={dayIndex}
              onChange={(event) => setDayIndex(Number(event.target.value) || 1)}
            />
          </label>
          <label className="init-field grow">
            <span>备注（可选）</span>
            <input
              value={label}
              placeholder={LABEL_PLACEHOLDERS[draftType]}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
        </div>
        <button type="button" className="ghost wide" onClick={addDraft} disabled={!anchorTime}>
          ＋ 添加这条约束
        </button>
      </div>
    </div>
  );

  if (variant === "inline") return body;

  return (
    <>
      <div className="proposal-overlay" onClick={onCancel} aria-hidden="true" />
      <div
        className="proposal-sheet constraint-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="修改约束"
      >
        <div className="proposal-head">
          <div>
            <div className="t1">修改约束</div>
            <div className="t2">增删已定安排，保存后立即生效；AI 排行程会避开这些时段。</div>
          </div>
          <button type="button" className="x" onClick={onCancel} aria-label="关闭修改约束">
            ✕
          </button>
        </div>

        {body}

        <div className="proposal-actions">
          <button type="button" className="ghost" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="cta" onClick={() => onSave(drafts.map(toConstraint))}>
            保存
          </button>
        </div>
      </div>
    </>
  );
}
