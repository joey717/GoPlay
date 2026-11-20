/**
 * Task #224：两类长等待的分级方案配置（站点 + 阈值 + 预估）。
 *
 * 阈值取值依据（全部来自仓库既有事实，不新增服务端约定）：
 * - 草案生成：server/src/guides/planner.ts 单轮预算 300s、前端兜底 315s
 *   （lib/draftThinking.ts DRAFT_GENERATION_TIMEOUT_MS），live 实测常态 30~90s、
 *   planner 单轮常见 100s+ → estimateMs 取 110s，critical 在 210s 预警，
 *   留足 ~100s 让用户在 315s 被兜底杀掉之前自己决定取消重试。
 * - 意图调整：server/src/ai/pipeline.ts 常规 60s / 全量重排 90s，解析失败可重试一次
 *   → 最坏 ~180s；estimateMs 取 75s。前两个站点阈值严格沿用 Task #42 的
 *   15s / 45s 与原文案，既有的分级提示行为不被推翻，只是补齐站点与计时。
 *
 * 站点名刻意用旅行口吻（读料 / 选点 / 排线 / 成稿），与「去玩」的行程隐喻一致，
 * 同时避开技术术语（抽取 / 对齐 / 校验 / 落库）。
 */
import { DRAFT_GENERATION_TIMEOUT_MS } from "./draftThinking";
import type { WaitStagePlan } from "./waitStages";

/**
 * 草案生成等待方案。
 *
 * 站点阈值与 lib/draftThinking.ts 的 DRAFT_THINKING_STEPS 时间线对齐（0 / 5s / 15s / 60s），
 * 于是「站点跳下一站」与「句子换下一句」同时发生，不会出现站点已到排线、
 * 句子还在读素材的错位。展示时句子仍以既有 draftThinkingText 为准（带可用篇数），
 * stage.sentence 只是没有思考链时的兜底。
 */
export const DRAFT_WAIT_PLAN: WaitStagePlan = {
  stages: [
    { atMs: 0, name: "读料", sentence: "正在读取攻略素材…" },
    { atMs: 5_000, name: "选点", sentence: "梳理攻略里的地点和玩法细节…" },
    { atMs: 15_000, name: "排线", sentence: "根据行程约束规划最佳路线…" },
    { atMs: 60_000, name: "成稿", sentence: "整理攻略提示和最终方案…" },
  ],
  estimateMs: 110_000,
  slowAfterMs: 130_000,
  criticalAfterMs: 210_000,
  timeoutMs: DRAFT_GENERATION_TIMEOUT_MS,
};

/** 意图调整（F11）等待方案：前两站沿用 Task #42 的 15s / 45s 阈值与原文案 */
export const INTENT_WAIT_PLAN: WaitStagePlan = {
  stages: [
    { atMs: 0, name: "听懂", sentence: "AI 正在理解你的意思…" },
    { atMs: 15_000, name: "规划", sentence: "AI 正在规划完整行程，请耐心等待…" },
    { atMs: 45_000, name: "重排", sentence: "大规模重排需要较长时间，还在处理中…" },
    { atMs: 90_000, name: "核对", sentence: "还在核对这版改动是否安全…" },
  ],
  estimateMs: 75_000,
  slowAfterMs: 90_000,
  criticalAfterMs: 150_000,
  timeoutMs: 180_000,
};

/**
 * 意图等待气泡的出现门槛：严格保持 Task #42 既有行为——15s 前只有按钮上的
 * 「思考中…」，避免秒回的常规意图闪一下气泡造成噪音；15s 起气泡接管并展示
 * 站点 / 计时 / 预计剩余。
 */
export const INTENT_WAIT_BUBBLE_AFTER_MS = 15_000;

/** 草案生成等待期间「可离开」提示（Task #135 既有能力，这里只补一句可见说明） */
export const DRAFT_WAIT_LEAVE_HINT = "可以先关掉面板去别处看看，排好会在底部提醒你";
