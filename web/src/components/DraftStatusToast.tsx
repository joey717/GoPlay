/**
 * 底部草案状态浮条（任务 135）：非阻塞、可点击。
 * 统一添加面板关闭期间，行程级生成会话的三种状态在这里持续可见：
 * - generating：按时间线递进的过程文案（与面板内思考链同源）；点击重新打开面板；
 * - ready：生成完成 / 重载召回的新鲜草案待查看；点击打开面板直接进入草案预览；
 * - failed：本次没排成；点击主体打开面板看原因，或直接点「重试」按原参数重发。
 * 面板打开时浮条隐藏（进度 / 结果 / 错误都由面板内展示，避免重复噪音）。
 *
 * Task #224：generating 态在过程文案之下补一行分级读数（当前站点 · 已等多久 ·
 * 预计剩余），并在浮条底边加一条软进度轨——用户离开面板后仍能一眼看出「走到哪了、
 * 还要多久、是不是卡住了」，而不只是转圈。快照与面板同源（useGuideDraftGeneration），
 * 两处读数不会漂移；快照缺失时严格退回原单行展示，既有行为与测试不受影响。
 */
import { waitProgressPercent, type WaitStageSnapshot } from "../lib/waitStages";

export type DraftToastState =
  | { kind: "generating"; text: string; stage?: WaitStageSnapshot | null }
  | { kind: "ready" }
  | { kind: "failed" };

interface DraftStatusToastProps {
  state: DraftToastState;
  /** 点击浮条主体：重新打开统一添加面板（生成中可继续等待 / 完成与召回直接看草案） */
  onOpen: () => void;
  /** 失败态重试：按上一轮的 scope 与补充句重新发起生成（不打开面板） */
  onRetry: () => void;
}

export default function DraftStatusToast({ state, onOpen, onRetry }: DraftStatusToastProps) {
  if (state.kind === "generating") {
    const stage = state.stage ?? null;
    return (
      <div
        className="draft-toast"
        role="status"
        aria-label="攻略生成进度"
        data-tier={stage?.tier}
      >
        <button type="button" className="draft-toast-body" onClick={onOpen}>
          <span className="draft-thinking-dot" aria-hidden="true" />
          <span className="draft-toast-main">
            <span key={state.text} className="draft-toast-text">
              {state.text}
            </span>
            {/* 计时每 500ms 变化：aria-hidden 避免读屏被数字刷屏（主文案仍会播报） */}
            {stage !== null ? (
              <span className="draft-toast-stage" aria-hidden="true">
                {stage.stage.name} · 已等 {stage.elapsedText} · {stage.remainText}
              </span>
            ) : null}
          </span>
          <span className="draft-toast-go" aria-hidden="true">
            查看
          </span>
          {stage !== null ? (
            <span className="draft-toast-rail" aria-hidden="true">
              <i style={{ width: waitProgressPercent(stage.progress) }} />
            </span>
          ) : null}
        </button>
      </div>
    );
  }
  if (state.kind === "ready") {
    return (
      <div className="draft-toast" role="status" aria-label="攻略草案已就绪">
        <button type="button" className="draft-toast-body" onClick={onOpen}>
          <span className="draft-toast-done-mark" aria-hidden="true">
            ✓
          </span>
          <span className="draft-toast-text">攻略排好了，点开看看</span>
          <span className="draft-toast-go" aria-hidden="true">
            查看
          </span>
        </button>
      </div>
    );
  }
  return (
    <div className="draft-toast" role="alert" aria-label="攻略生成失败">
      <div className="draft-toast-body draft-toast-failed">
        <button type="button" className="draft-toast-msg" onClick={onOpen}>
          <span className="draft-toast-text">这一版没排成，点开看看</span>
          <span className="draft-toast-go" aria-hidden="true">
            查看
          </span>
        </button>
        <button type="button" className="draft-toast-retry" onClick={onRetry}>
          重试
        </button>
      </div>
    </div>
  );
}
