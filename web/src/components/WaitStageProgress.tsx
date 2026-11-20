/**
 * Task #224：长等待「分级反馈」展示组件。
 *
 * 设计取径：不去做通用 stepper，而是把等待画成一段**行程路线**——四个站点
 * （读料 → 选点 → 排线 → 成稿）串在一条陶土色细线上，已到站实心、当前站脉冲、
 * 未到站空心；细线上的填充随软进度渐近推进，永远差最后一站到不了头。
 * 这与「去玩」的行程隐喻同构：用户本来就在等一趟路线被排出来，
 * 等待过程本身也被表达成一段路。
 *
 * 三档分级（data-tier）只改强调色与剩余文案口径，不改结构，避免等待越久界面越吵：
 * - steady   正常推进：陶土色，报「预计还要 X 秒左右」
 * - slow     比预计久：琥珀色，不再倒计时（避免"还要 5 秒"说了半分钟）
 * - critical 接近兜底：深色 + 呼吸描边，直接给出「可以先取消再试一次」的出路
 *
 * 组件自身不计时：时钟（startedAt / now）由调用方持有（草案在 useGuideDraftGeneration，
 * 意图在 IntentBar），这里只消费已解析的 WaitStageSnapshot，保证纯渲染、易测。
 */
import type { CSSProperties } from "react";
import type { WaitStageSnapshot } from "../lib/waitStages";

/** panel = 路线全量（面板内）；line = 单行紧凑（气泡 / 浮条内嵌） */
export type WaitStageVariant = "panel" | "line";

export interface WaitStageProgressProps {
  /** 已解析的等待快照（由调用方按时钟算出） */
  snapshot: WaitStageSnapshot;
  /** 覆盖当前阶段句子（草案沿用既有思考链文案，面板与浮条口径一致） */
  sentence?: string | null;
  variant?: WaitStageVariant;
  /** 取消按钮文案；与 onCancel 同时给出才渲染按钮 */
  cancelText?: string;
  onCancel?: () => void;
  /** panel 变体的补充一行（如「可离开等待」提示） */
  hint?: string | null;
  /** role=status 的可访问名（缺省按变体给） */
  ariaLabel?: string;
  /** 追加到根节点的类名（宿主微调间距用） */
  className?: string;
}

/**
 * 路线几何：N 个等宽列，站点 i 的圆心落在 (i + 0.5) / N；
 * 细线只连首末两站的圆心，于是 left = 50/N%、span = (N-1)/N*100%。
 * 百分比在 JS 侧算好写成 CSS 变量，避免 calc() 里除以 var() 的兼容坑。
 */
function routeStyle(snapshot: WaitStageSnapshot): CSSProperties {
  const n = Math.max(1, snapshot.total);
  const startPct = 50 / n;
  const spanPct = Math.max(0, 100 - 100 / n);
  return {
    gridTemplateColumns: `repeat(${n}, 1fr)`,
    "--wait-track-start": `${startPct.toFixed(3)}%`,
    "--wait-track-span": `${spanPct.toFixed(3)}%`,
    "--wait-fill": `${(snapshot.progress * spanPct).toFixed(3)}%`,
  } as CSSProperties;
}

/** 站点状态类名：已到站 / 当前站 / 未到站 */
function stopClass(snapshot: WaitStageSnapshot, index: number): string {
  if (index < snapshot.index) return "wait-stop done";
  if (index === snapshot.index) return "wait-stop now";
  return "wait-stop todo";
}

export default function WaitStageProgress({
  snapshot,
  sentence,
  variant = "panel",
  cancelText,
  onCancel,
  hint,
  ariaLabel,
  className,
}: WaitStageProgressProps) {
  const text = sentence ?? snapshot.stage.sentence;
  const rootClass = `wait-stage${className !== undefined ? ` ${className}` : ""}`;
  const label = ariaLabel ?? (variant === "panel" ? "生成进度" : "AI 处理进度");
  const style = routeStyle(snapshot);

  /** 路线站点（两个变体共用；line 变体隐藏站名，只留节点与细线） */
  const route = (
    <div className="wait-route" style={style} aria-hidden="true">
      <span className="wait-route-track" />
      <span className="wait-route-fill" />
      {snapshot.stages.map((stage, index) => (
        <span key={stage.name} className={stopClass(snapshot, index)}>
          <span className="wait-stop-dot" />
          <span className="wait-stop-name">{stage.name}</span>
        </span>
      ))}
    </div>
  );

  if (variant === "line") {
    return (
      <div className={rootClass} data-variant="line" data-tier={snapshot.tier} role="status" aria-label={label}>
        {route}
        <div className="wait-line-main">
          <span key={text} className="wait-line-sentence">
            {text}
          </span>
          {/* 计时每 500ms 变化：aria-hidden，避免读屏被数字刷屏 */}
          <span className="wait-line-clock" aria-hidden="true">
            已等 {snapshot.elapsedText}
          </span>
        </div>
        <div className="wait-line-remain">{snapshot.remainText}</div>
      </div>
    );
  }

  return (
    <div className={rootClass} data-variant="panel" data-tier={snapshot.tier} role="status" aria-label={label}>
      {route}
      <div className="wait-panel-line">
        <span key={text} className="wait-panel-sentence">
          {text}
        </span>
        <span className="wait-panel-clock" aria-hidden="true">
          已等 {snapshot.elapsedText}
        </span>
      </div>
      <div className="wait-panel-foot">
        <span className="wait-panel-remain">{snapshot.remainText}</span>
        {onCancel !== undefined ? (
          <button type="button" className="wait-panel-cancel" onClick={onCancel}>
            {cancelText ?? "取消等待"}
          </button>
        ) : null}
      </div>
      {/* 静态提示（可离开等待）：只在生成开始时出现一次，对读屏保留——
          与每半秒跳动的计时不同，这句话是用户可以据此行动的信息 */}
      {hint ? <div className="wait-panel-hint">{hint}</div> : null}
    </div>
  );
}
