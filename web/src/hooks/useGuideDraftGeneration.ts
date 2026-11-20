/**
 * 行程级攻略草案生成会话（任务 135）：
 * 生成请求与状态提升到 TripView 生命周期——用户关闭统一添加面板（NoteInput）或
 * 切换浮层时，请求继续在后台等待，不随组件卸载中断；完成后经 onSuccess 上抛，
 * 由 TripView 展示已持久化的草案并刷新权威行程。
 *
 * 会话状态机：
 *   idle → generating → idle（成功，onSuccess）
 *                     → failed（服务端拒绝 / 网络中断 / 315s 兜底超时；保留重试参数）
 *   generating → idle（用户主动取消等待：静默，不展示为错误）
 *
 * 竞态防护：seq 序号保证只有最新一轮的响应被采纳——超时 abort / 取消 / 重新发起后，
 * 迟到的旧响应一律丢弃，不产生假成功。任务 210：生成中重新发起不再被静默忽略，
 * 而是自动取消旧请求并替换为新请求（cancel 的静默语义由用户主动触发保留）。
 *
 * Task #224：额外输出 stage（分级反馈快照），由同一个 500ms 时钟驱动——
 * 思考链文案（thinkingText）负责「AI 此刻在做什么」，stage 负责「走到第几站 /
 * 已等多久 / 预计还要多久 / 是否偏慢」，两者同源不漂移。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  generateGuideDraft,
  type GuideDraftEntryContext,
  type GuideDraftResult,
  type GuideDraftSourceMode,
} from "../api/client";
import type { ClarificationAnswer } from "@goplay/shared";
import {
  DRAFT_GENERATION_TIMEOUT_MESSAGE,
  DRAFT_GENERATION_TIMEOUT_MS,
  DRAFT_THINKING_TICK_MS,
  draftThinkingText,
} from "../lib/draftThinking";
import { DRAFT_WAIT_PLAN } from "../lib/waitPlans";
import { resolveWaitStage, type WaitStageSnapshot } from "../lib/waitStages";

/** 生成入参快照（Task #176：scope 不再手动选择，只带入口上下文；Task #189：
 * 局部优化携带 sourceMode="selected" + selectedSourceIds，全部重排 sourceMode="all"）：
 * 失败重试时按原参数重发（usableCount 仅用于思考链文案，重试时由调用方刷新） */
export interface GuideDraftGenerationInput {
  /** 面板打开来源（服务端据此 + 日期指令 + 证据归属自动判定 scope） */
  entryContext: GuideDraftEntryContext;
  /** 已 trim 的补充句；空串表示无补充句 */
  note: string;
  /** 发起时的可用攻略篇数（思考链文案用；局部模式 = 所选篇数） */
  usableCount: number;
  /** Task #189：来源模式；缺省 = 旧语义（不携带 sourceMode 字段，服务端归一 "all"） */
  sourceMode?: GuideDraftSourceMode;
  /** sourceMode="selected" 时的来源 id 列表（局部优化；允许暂存来源） */
  selectedSourceIds?: string[];
  /** Task #282：稀疏攻略澄清用户回答（收到 clarification 响应后选择并重发） */
  clarificationAnswer?: ClarificationAnswer;
}

export type GuideDraftGenerationSession =
  | { kind: "idle" }
  | { kind: "generating"; startedAt: number; input: GuideDraftGenerationInput }
  | { kind: "failed"; message: string; input: GuideDraftGenerationInput };

interface Options {
  tripId: string;
  /** 生成成功：由调用方展示草案（行程级 activeDraft）并刷新权威行程；
   *  Task #282：同时传回本次入参快照，供澄清重发时复用 */
  onSuccess: (draft: GuideDraftResult, input: GuideDraftGenerationInput) => void;
}

export function useGuideDraftGeneration({ tripId, onSuccess }: Options) {
  const [session, setSession] = useState<GuideDraftGenerationSession>({ kind: "idle" });
  /** 生成中的时钟：驱动思考链文案按时间线切换 */
  const [now, setNow] = useState(() => Date.now());
  const abortRef = useRef<AbortController | null>(null);
  /** 竞态序号：只接受最新一轮的 settle */
  const seqRef = useRef(0);
  const activeRef = useRef(true);
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;
  const tripIdRef = useRef(tripId);
  tripIdRef.current = tripId;

  // 行程页整体卸载（新建行程等）：中止在途请求并丢弃迟到响应。
  // 任务 207：存活标记必须在挂载时复位——React.StrictMode（main.tsx，开发环境）
  // 会 mount → cleanup → mount，首轮清理若把 activeRef 永久置 false，之后每一次
  // 成功响应都会命中「迟到响应丢弃」分支被静默吞掉：服务端 11ms 返回 fastPath=true，
  // 界面却一直停在生成中，直到 315s 兜底超时才发现（实机现象）。
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      seqRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const generating = session.kind === "generating";
  const startedAt = generating ? session.startedAt : 0;

  // 思考链文案 tick：生成中每半秒推进 now（面板与浮条共用同一文案时间线）
  useEffect(() => {
    if (!generating) return;
    const timer = window.setInterval(() => setNow(Date.now()), DRAFT_THINKING_TICK_MS);
    return () => window.clearInterval(timer);
  }, [generating]);

  // 前端兕底超时（315s > 服务端 300s 单轮预算）：转 failed 并中止挂死的等待；
  // 递增序号使本轮在途响应彻底失效——真实 fetch 会因 abort 报 AbortError（catch 静默），
  // 但响应与 abort 已完成竞态（promise 已 resolve）时也不得再转为成功（假成功）。
  useEffect(() => {
    if (!generating) return;
    const remaining = DRAFT_GENERATION_TIMEOUT_MS - (Date.now() - startedAt);
    const timer = window.setTimeout(() => {
      seqRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      setSession((prev) =>
        prev.kind === "generating"
          ? { kind: "failed", message: DRAFT_GENERATION_TIMEOUT_MESSAGE, input: prev.input }
          : prev,
      );
    }, Math.max(0, remaining));
    return () => window.clearTimeout(timer);
  }, [generating, startedAt]);

  /** 发起生成：进行中重复点击 → 取消旧请求并立即替换为新请求（任务 210：误触
   * 「整体重排」等慢请求后，可随时改走另一入口，不必干等旧请求返回）；
   * 失败态可直接重发（覆盖为新一轮 generating） */
  const start = useCallback((input: GuideDraftGenerationInput) => {
    // 任务 210：有在途旧请求时先中止——旧 promise 会因 AbortError 走 catch 分支；
    // 下方 ++seqRef.current 已使旧 seq 失效：即使旧响应已与 abort 完成竞态（promise
    // 已 resolve），也会命中「迟到响应丢弃」分支，不会覆盖新会话产生假成功。
    if (abortRef.current !== null) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    const seq = ++seqRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setSession({ kind: "generating", startedAt: Date.now(), input });
    setNow(Date.now());
    void generateGuideDraft(
      tripIdRef.current,
      {
        entryContext: input.entryContext,
        note: input.note === "" ? undefined : input.note,
        ...(input.sourceMode !== undefined
          ? {
              sourceMode: input.sourceMode,
              ...(input.sourceMode === "selected"
                ? { selectedSourceIds: input.selectedSourceIds ?? [] }
                : {}),
            }
          : {}),
        ...(input.clarificationAnswer !== undefined
          ? { clarificationAnswer: input.clarificationAnswer }
          : {}),
      },
      controller.signal,
    )
      .then((draft) => {
        if (!activeRef.current || seq !== seqRef.current) return; // 迟到响应丢弃
        abortRef.current = null;
        setSession({ kind: "idle" });
        onSuccessRef.current(draft, input);
      })
      .catch((err: unknown) => {
        if (!activeRef.current || seq !== seqRef.current) return;
        abortRef.current = null;
        // 主动取消 / 兕底超时的 abort：静默（取消不展示错误；超时已转 failed）
        if (controller.signal.aborted) return;
        // DRAFT_STALE / GUIDE_NO_SOURCES 等服务端拒绝透传安全 message；网络中断用通用文案
        const message =
          err instanceof ApiError ? err.message : "攻略草案生成失败，请重试";
        setSession({ kind: "failed", message, input });
      });
  }, []);

  /** 取消等待：只结束前端等待，不展示为错误（服务端结果被丢弃） */
  const cancel = useCallback(() => {
    if (abortRef.current === null) return;
    seqRef.current += 1; // 在途响应失效
    abortRef.current.abort();
    abortRef.current = null;
    setSession({ kind: "idle" });
  }, []);

  /** 关闭失败提示（浮条 × / 重新打开面板等场景重置为 idle） */
  const dismissFailure = useCallback(() => {
    setSession((prev) => (prev.kind === "failed" ? { kind: "idle" } : prev));
  }, []);

  const thinkingText =
    session.kind === "generating"
      ? draftThinkingText(session.startedAt, now, session.input.usableCount)
      : null;

  /**
   * Task #224 分级反馈：与思考链文案共用同一个 500ms 时钟，按已等待时长解析出
   * 「站点 + 计时 + 预计剩余 + 分级」。纯前端推断（服务端一次性返回、无进度事件），
   * 面板内路线与底部浮条消费同一份快照，保证两处读数一致、不会各自漂移。
   * useMemo 让快照只在 tick 时换身份——TripView 因无关状态重渲染时不打穿下游 memo。
   */
  const stage = useMemo<WaitStageSnapshot | null>(
    () => (generating ? resolveWaitStage(DRAFT_WAIT_PLAN, now - startedAt) : null),
    [generating, now, startedAt],
  );

  return { session, thinkingText, stage, start, cancel, dismissFailure };
}
