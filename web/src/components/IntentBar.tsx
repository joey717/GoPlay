import { useEffect, useRef, useState } from "react";
import { ApiError, sendIntent, type IntentResult } from "../api/client";
import { INTENT_WAIT_BUBBLE_AFTER_MS, INTENT_WAIT_PLAN } from "../lib/waitPlans";
import { resolveWaitStage, WAIT_STAGE_TICK_MS, waitProgressPercent } from "../lib/waitStages";
import WaitStageProgress from "./WaitStageProgress";

interface IntentBarProps {
  tripId: string;
  /** 是否已有行程内容（任意 Day 有景点）：决定按钮文案「AI 调整」/「AI 排一版」（Module E） */
  hasContent: boolean;
  /** 非 clarify 结果（applied / proposal / rejected / error）统一上抛给容器处理 */
  onResult: (result: IntentResult) => void;
  /**
   * Task #72 多轮会话 ID 变化上报（闲置过期 / 卸载时上报 null）：
   * 容器用 ref 记录最新值，行程切换（新建行程）前归档旧 Session。
   */
  onSessionChange: (sessionId: string | null) => void;
}

/** Task #72 多轮会话闲置过期：5 分钟无新意图即放弃续接（只清前端状态，不调归档） */
const SESSION_IDLE_MS = 5 * 60_000;

/**
 * 底部意图栏：自然语言 → 百炼 F11 流水线。
 * 交互优化 Module E：placeholder 带例子句；按钮文案状态驱动——已有行程
 * （任意 Day 有景点）=「AI 调整」，还没有行程 =「AI 排一版」（由上层传入 hasContent）。
 * clarify 就地气泡反问；其余结果经 onResult 交由 TripView 分发
 * （applied → applyServerResult，proposal → ProposalCard，rejected/error → 提示）。
 *
 * 等待体验（Task #42 → Task #224 分级反馈）：
 * - 原 15s / 45s 两段提示已升级为四站路线（听懂 → 规划 → 重排 → 核对），
 *   阈值与原文案严格保留在 lib/waitPlans.ts 的 INTENT_WAIT_PLAN 里，不推翻既有行为；
 * - 发送即在输入栏顶边铺一条软进度轨（0s 起就有反馈，秒回时只是一闪）；
 * - 15s 起气泡接管，展示站点路线 + 已等多久 + 预计剩余 + 三档分级配色，附取消按钮
 *   （AbortController 中止 fetch）；取消只结束前端等待——不展示网络错误、不更新行程；
 * - 服务端 60s / 全量重排 90s 预算耗尽后透传其错误文案，critical 档（150s+）
 *   先一步给出「可以先取消再试一次」的出路，衔接既有重试入口。
 *
 * 多轮会话（Task #72）：保存结果中的 sessionId 并于下一轮回传续接；5 分钟无新
 * 意图或组件卸载即清空（不归档；归档由行程切换流程统一负责）。
 */
export default function IntentBar({ tripId, hasContent, onResult, onSessionChange }: IntentBarProps) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [clarify, setClarify] = useState<string | null>(null);
  /** Task #224：本轮等待起点（null = 不在等待）；与 waitNow 一起驱动分级反馈 */
  const [waitStartedAt, setWaitStartedAt] = useState<number | null>(null);
  /** 等待时钟：每 500ms 推进，驱动站点跳站 / 计时 / 预计剩余 / 分级 */
  const [waitNow, setWaitNow] = useState(0);
  /** Task #72 多轮会话：下一轮续接的百炼 Session ID（null = 无会话 / 已闲置过期） */
  const [sessionId, setSessionId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  /** 会话 ID 的 ref 镜像：供计时器回调 / 卸载清理读取最新值，避免闭包过期 */
  const sessionIdRef = useRef<string | null>(null);
  /** 多轮会话闲置过期计时器（Task #72） */
  const sessionTimerRef = useRef<number | null>(null);

  // 卸载兜底：清理定时器并中止进行中的请求，避免 setState 到已卸载组件
  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (sessionTimerRef.current !== null) window.clearTimeout(sessionTimerRef.current);
      // Task #72：卸载即放弃多轮会话引用（不归档；归档由行程切换流程负责）
      sessionIdRef.current = null;
      onSessionChange(null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Task #224：等待期间推进时钟（不在等待时不挂任何定时器，空闲零开销）
  useEffect(() => {
    if (waitStartedAt === null) return;
    const timer = window.setInterval(() => setWaitNow(Date.now()), WAIT_STAGE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [waitStartedAt]);

  /** 分级快照：纯前端按已等待时长推断（服务端一次性返回，无进度事件通道） */
  const waitSnapshot =
    waitStartedAt !== null
      ? resolveWaitStage(INTENT_WAIT_PLAN, Math.max(0, waitNow - waitStartedAt))
      : null;
  /** Task #42 门槛保持：15s 前不弹气泡（避免秒回的常规意图闪一下噪音），
   *  15s 起由分级气泡接管；顶边软进度轨则从 0s 起就在走 */
  const showWaitBubble =
    waitSnapshot !== null && waitSnapshot.elapsedMs >= INTENT_WAIT_BUBBLE_AFTER_MS;

  /** Task #72：会话状态统一入口（state + ref 镜像 + 上报容器），供发送结果 / 过期复用 */
  function applySession(next: string | null) {
    sessionIdRef.current = next;
    setSessionId(next);
    onSessionChange(next);
  }

  /** 重置闲置计时：5 分钟无新意图 → 清空会话（只清前端状态，不调归档接口） */
  function scheduleSessionIdle() {
    if (sessionTimerRef.current !== null) window.clearTimeout(sessionTimerRef.current);
    sessionTimerRef.current = window.setTimeout(() => {
      sessionTimerRef.current = null;
      applySession(null);
    }, SESSION_IDLE_MS);
  }

  async function handleSend() {
    const text = input.trim();
    if (text === "" || loading) return;
    setLoading(true);
    setClarify(null);

    // Task #72：发送即视为会话活跃，推迟闲置过期，避免请求在途（最长 90s）被清空
    if (sessionIdRef.current !== null) scheduleSessionIdle();

    // Task #224：起点与时钟同时落位（waitNow 先等于起点，避免首帧算出负耗时）
    const startedAt = Date.now();
    setWaitStartedAt(startedAt);
    setWaitNow(startedAt);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await sendIntent(tripId, text, controller.signal, sessionId ?? undefined);
      // Task #72：保存本轮实际 sessionId 供下一轮续接（极早失败为空串 → 视为无会话）
      const nextSession =
        typeof result.sessionId === "string" && result.sessionId !== "" ? result.sessionId : null;
      applySession(nextSession);
      if (nextSession !== null) scheduleSessionIdle();
      if (result.type === "clarify") {
        setClarify(result.clarify ?? "请补充更多信息");
      } else {
        setInput("");
        onResult(result);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        // 用户主动取消：静默结束等待，不展示网络错误，不更新 trip
        return;
      }
      if (error instanceof ApiError) {
        // 服务端错误透传用户可读文案（处理超时 / 响应格式异常等已区分）
        onResult({ type: "error", sessionId: sessionIdRef.current ?? "", message: error.message });
      } else {
        onResult({ type: "error", sessionId: sessionIdRef.current ?? "", message: "网络错误，请重试" });
      }
    } finally {
      // 等待结束（成功 / 失败 / 取消）：收起分级反馈并停掉时钟
      setWaitStartedAt(null);
      abortRef.current = null;
      setLoading(false);
    }
  }

  /** 取消当前等待：中止 fetch，保留输入内容便于直接重发 */
  function handleCancel() {
    abortRef.current?.abort();
  }

  // Enter 直接发送，Shift+Enter 换行（单行输入框下仅拦截默认提交）
  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  }

  return (
    <div className="intentbar-wrap">
      {clarify !== null ? (
        <div className="clarify-bubble" role="status">
          <span>{clarify}</span>
          <button type="button" aria-label="关闭提示" onClick={() => setClarify(null)}>
            ×
          </button>
        </div>
      ) : null}
      {showWaitBubble && waitSnapshot !== null ? (
        <div className="wait-bubble">
          <WaitStageProgress snapshot={waitSnapshot} variant="line" ariaLabel="AI 调整进度" />
          <button type="button" className="wait-cancel" onClick={handleCancel}>
            取消等待
          </button>
        </div>
      ) : null}
      {/* Task #224：顶边软进度轨——0s 起就有推进反馈，气泡出现前的空窗不再干等 */}
      {loading && waitSnapshot !== null ? (
        <span className="intent-wait-rail" data-tier={waitSnapshot.tier} aria-hidden="true">
          <i style={{ width: waitProgressPercent(waitSnapshot.progress) }} />
        </span>
      ) : null}
      <div className="intentbar">
        <div className="field">
          <input
            type="text"
            placeholder="说一句话调整，如：Day2 松一点 / 把情人桥放第一站"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            disabled={loading}
            aria-label="行程调整意图"
          />
        </div>
        <button
          type="button"
          className="cta"
          onClick={() => void handleSend()}
          disabled={loading || input.trim() === ""}
        >
          {loading ? "思考中…" : hasContent ? "AI 调整" : "AI 排一版"}
        </button>
      </div>
    </div>
  );
}
