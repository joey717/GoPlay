/**
 * Task #224：分级方案配置的契约测试。
 *
 * 这类测试的价值不在「算得对」，而在**防止后人无意推翻既有行为**：
 * - INTENT_WAIT_PLAN 的前两站必须与 Task #42 的 15s / 45s 阈值和原文案逐字一致；
 * - DRAFT_WAIT_PLAN 的站点阈值必须落在 DRAFT_THINKING_STEPS 的时间线上，
 *   否则会出现「站点已跳到排线、句子还在读素材」的错位；
 * - 两套方案的 estimate / slow / critical / timeout 必须单调，
 *   且 critical 预警早于兜底超时（不然用户来不及自己取消重试）。
 */
import { describe, expect, it } from "vitest";
import {
  DRAFT_GENERATION_TIMEOUT_MS,
  DRAFT_THINKING_STEPS,
} from "./draftThinking";
import {
  DRAFT_WAIT_LEAVE_HINT,
  DRAFT_WAIT_PLAN,
  INTENT_WAIT_BUBBLE_AFTER_MS,
  INTENT_WAIT_PLAN,
} from "./waitPlans";
import type { WaitStagePlan } from "./waitStages";

/** 技术术语黑名单：阶段名与句子必须是用户语言（口径来自 draftThinking 的文案约定） */
const FORBIDDEN_TERMS = [
  "OCR",
  "extract",
  "LLM",
  "planner",
  "pipeline",
  "抽取",
  "落库",
  "校验",
  "超时",
  "请求",
  "接口",
  "轮询",
];

function expectPlanShape(plan: WaitStagePlan): void {
  expect(plan.stages.length).toBeGreaterThanOrEqual(2);
  expect(plan.stages[0].atMs).toBe(0);
  for (let i = 1; i < plan.stages.length; i += 1) {
    expect(plan.stages[i].atMs).toBeGreaterThan(plan.stages[i - 1].atMs);
  }
  const slow = plan.slowAfterMs ?? plan.estimateMs;
  const critical = plan.criticalAfterMs ?? plan.estimateMs * 2;
  expect(plan.estimateMs).toBeGreaterThan(0);
  expect(slow).toBeGreaterThanOrEqual(plan.estimateMs);
  expect(critical).toBeGreaterThan(slow);
  if (plan.timeoutMs !== undefined) {
    // critical 必须早于兜底超时，留出用户自己取消重试的窗口
    expect(critical).toBeLessThan(plan.timeoutMs);
  }
  for (const stage of plan.stages) {
    expect(stage.name.length).toBeLessThanOrEqual(3);
    expect(stage.name.length).toBeGreaterThanOrEqual(2);
    expect(stage.sentence.endsWith("…")).toBe(true);
    for (const term of FORBIDDEN_TERMS) {
      expect(stage.name).not.toContain(term);
      expect(stage.sentence).not.toContain(term);
    }
  }
}

describe("DRAFT_WAIT_PLAN 草案生成等待方案", () => {
  it("方案形状合法：站点升序、分级单调、critical 早于 315s 兜底", () => {
    expectPlanShape(DRAFT_WAIT_PLAN);
    expect(DRAFT_WAIT_PLAN.timeoutMs).toBe(DRAFT_GENERATION_TIMEOUT_MS);
    expect(DRAFT_WAIT_PLAN.criticalAfterMs).toBe(210_000);
  });

  it("站点阈值全部落在思考链时间线上（跳站与换句同时发生，不错位）", () => {
    const thinkingAfterMs = DRAFT_THINKING_STEPS.map((step) => step.afterMs);
    for (const stage of DRAFT_WAIT_PLAN.stages) {
      expect(thinkingAfterMs).toContain(stage.atMs);
    }
  });

  it("前三站的兜底句子与思考链同阈值文案逐字一致（展示时仍以思考链为准）", () => {
    const textAt = (afterMs: number) =>
      DRAFT_THINKING_STEPS.find((step) => step.afterMs === afterMs)?.text(1);
    for (const stage of DRAFT_WAIT_PLAN.stages.slice(0, 3)) {
      expect(stage.sentence).toBe(textAt(stage.atMs));
    }
  });

  it("站点名是旅行口吻的四站路线", () => {
    expect(DRAFT_WAIT_PLAN.stages.map((stage) => stage.name)).toEqual([
      "读料",
      "选点",
      "排线",
      "成稿",
    ]);
  });
});

describe("INTENT_WAIT_PLAN 意图调整等待方案", () => {
  it("方案形状合法：critical 150s 早于 180s 兜底", () => {
    expectPlanShape(INTENT_WAIT_PLAN);
    expect(INTENT_WAIT_PLAN.timeoutMs).toBe(180_000);
  });

  /**
   * Task #42 既有行为不被推翻：原 WAIT_HINT_15S / WAIT_HINT_45S 的阈值与文案
   * 原样搬进站点表（原常量已随 IntentBar 重写移除，此处成为唯一权威来源）。
   */
  it("Task #42 的 15s / 45s 两段提示阈值与文案逐字保留", () => {
    expect(INTENT_WAIT_PLAN.stages[1].atMs).toBe(15_000);
    expect(INTENT_WAIT_PLAN.stages[1].sentence).toBe("AI 正在规划完整行程，请耐心等待…");
    expect(INTENT_WAIT_PLAN.stages[2].atMs).toBe(45_000);
    expect(INTENT_WAIT_PLAN.stages[2].sentence).toBe("大规模重排需要较长时间，还在处理中…");
  });

  it("气泡门槛仍是 15s，且与第二站同时到点（秒回的常规意图不闪气泡）", () => {
    expect(INTENT_WAIT_BUBBLE_AFTER_MS).toBe(15_000);
    expect(INTENT_WAIT_BUBBLE_AFTER_MS).toBe(INTENT_WAIT_PLAN.stages[1].atMs);
  });

  it("四站名与站点顺序", () => {
    expect(INTENT_WAIT_PLAN.stages.map((stage) => stage.name)).toEqual([
      "听懂",
      "规划",
      "重排",
      "核对",
    ]);
  });
});

describe("DRAFT_WAIT_LEAVE_HINT 可离开提示（Task #135 既有能力的可见说明）", () => {
  it("明确告知可关面板 + 完成后底部提醒，且不含技术术语", () => {
    expect(DRAFT_WAIT_LEAVE_HINT).toContain("关掉面板");
    expect(DRAFT_WAIT_LEAVE_HINT).toContain("底部提醒");
    for (const term of FORBIDDEN_TERMS) {
      expect(DRAFT_WAIT_LEAVE_HINT).not.toContain(term);
    }
  });
});
