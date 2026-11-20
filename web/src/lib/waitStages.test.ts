/**
 * Task #224：分级反馈纯逻辑层测试。
 *
 * 重点覆盖：
 * - 站点推进：阈值边界（前一毫秒 / 整点）与末站不越界；
 * - 分级切换：steady → slow → critical 单向递进，含缺省阈值推导；
 * - 软进度诚实性：单调不减、站点边界连续、封顶 PROGRESS_CAP（完成前永不 100%）；
 * - 文案格式：计时分秒制、预计剩余 10 秒一档、超预估后不再倒计时；
 * - 兜底：负值 / NaN / Infinity / 单站点方案都不炸。
 */
import { describe, expect, it } from "vitest";
import {
  formatWaitClock,
  formatWaitRemainder,
  PROGRESS_CAP,
  resolveWaitRemainText,
  resolveWaitStage,
  resolveWaitStageIndex,
  resolveWaitTier,
  WAIT_STAGE_TICK_MS,
  waitProgressPercent,
  type WaitStagePlan,
} from "./waitStages";

/** 四站方案（阈值与 DRAFT_WAIT_PLAN 同形，便于手算期望值） */
const PLAN: WaitStagePlan = {
  stages: [
    { atMs: 0, name: "读料", sentence: "正在读取攻略素材…" },
    { atMs: 5_000, name: "选点", sentence: "梳理攻略里的地点和玩法细节…" },
    { atMs: 15_000, name: "排线", sentence: "根据行程约束规划最佳路线…" },
    { atMs: 60_000, name: "成稿", sentence: "整理攻略提示和最终方案…" },
  ],
  estimateMs: 110_000,
  slowAfterMs: 130_000,
  criticalAfterMs: 210_000,
  timeoutMs: 315_000,
};

/** 只给 estimateMs：验证 slow / critical 阈值的缺省推导 */
const BARE_PLAN: WaitStagePlan = {
  stages: [{ atMs: 0, name: "处理", sentence: "处理中…" }],
  estimateMs: 1_000,
};

describe("formatWaitClock 已等待计时", () => {
  it("不足 1 分钟报秒，整秒向下取整", () => {
    expect(formatWaitClock(0)).toBe("0 秒");
    expect(formatWaitClock(999)).toBe("0 秒");
    expect(formatWaitClock(12_000)).toBe("12 秒");
    expect(formatWaitClock(59_999)).toBe("59 秒");
  });

  it("满 1 分钟改分秒制，秒位补零（长等待下更容易被读成进展）", () => {
    expect(formatWaitClock(60_000)).toBe("1 分 00 秒");
    expect(formatWaitClock(65_000)).toBe("1 分 05 秒");
    expect(formatWaitClock(125_000)).toBe("2 分 05 秒");
    expect(formatWaitClock(315_000)).toBe("5 分 15 秒");
  });

  it("负值 / NaN / Infinity 归零，不出现「-3 秒」", () => {
    expect(formatWaitClock(-5_000)).toBe("0 秒");
    expect(formatWaitClock(Number.NaN)).toBe("0 秒");
    expect(formatWaitClock(Number.POSITIVE_INFINITY)).toBe("0 秒");
  });
});

describe("formatWaitRemainder 预计剩余", () => {
  it("10 秒一档向上取整，最小 10 秒（不说「还要 1 秒」反复打脸）", () => {
    expect(formatWaitRemainder(0)).toBe("10 秒左右");
    expect(formatWaitRemainder(3_000)).toBe("10 秒左右");
    expect(formatWaitRemainder(10_000)).toBe("10 秒左右");
    expect(formatWaitRemainder(12_000)).toBe("20 秒左右");
    expect(formatWaitRemainder(50_000)).toBe("50 秒左右");
  });

  it("满 60 秒改报分钟，仍带「左右」口径", () => {
    expect(formatWaitRemainder(55_000)).toBe("1 分钟左右");
    expect(formatWaitRemainder(90_000)).toBe("2 分钟左右");
    expect(formatWaitRemainder(110_000)).toBe("2 分钟左右");
  });

  it("负值 / NaN 归到最小档", () => {
    expect(formatWaitRemainder(-100)).toBe("10 秒左右");
    expect(formatWaitRemainder(Number.NaN)).toBe("10 秒左右");
  });
});

describe("resolveWaitStageIndex 站点推进", () => {
  it("阈值前一毫秒仍在上一站，整点即跳站", () => {
    expect(resolveWaitStageIndex(PLAN, 0)).toBe(0);
    expect(resolveWaitStageIndex(PLAN, 4_999)).toBe(0);
    expect(resolveWaitStageIndex(PLAN, 5_000)).toBe(1);
    expect(resolveWaitStageIndex(PLAN, 14_999)).toBe(1);
    expect(resolveWaitStageIndex(PLAN, 15_000)).toBe(2);
    expect(resolveWaitStageIndex(PLAN, 59_999)).toBe(2);
    expect(resolveWaitStageIndex(PLAN, 60_000)).toBe(3);
  });

  it("超过最后一站阈值不再越界（兜底超时前一直停在末站）", () => {
    expect(resolveWaitStageIndex(PLAN, 315_000)).toBe(3);
    expect(resolveWaitStageIndex(PLAN, 9_999_999)).toBe(3);
  });

  it("负耗时归到首站", () => {
    expect(resolveWaitStageIndex(PLAN, -1)).toBe(0);
  });
});

describe("resolveWaitTier 分级", () => {
  it("steady → slow → critical 单向递进（含边界整点）", () => {
    expect(resolveWaitTier(PLAN, 0)).toBe("steady");
    expect(resolveWaitTier(PLAN, 129_999)).toBe("steady");
    expect(resolveWaitTier(PLAN, 130_000)).toBe("slow");
    expect(resolveWaitTier(PLAN, 209_999)).toBe("slow");
    expect(resolveWaitTier(PLAN, 210_000)).toBe("critical");
    expect(resolveWaitTier(PLAN, 999_999)).toBe("critical");
  });

  it("缺省阈值：slow = estimateMs，critical = estimateMs * 2", () => {
    expect(resolveWaitTier(BARE_PLAN, 999)).toBe("steady");
    expect(resolveWaitTier(BARE_PLAN, 1_000)).toBe("slow");
    expect(resolveWaitTier(BARE_PLAN, 1_999)).toBe("slow");
    expect(resolveWaitTier(BARE_PLAN, 2_000)).toBe("critical");
  });
});

describe("resolveWaitRemainText 剩余文案口径", () => {
  it("steady 才倒计时，并带「预计」字样", () => {
    expect(resolveWaitRemainText(PLAN, "steady", 0)).toBe("预计还要 2 分钟左右");
    expect(resolveWaitRemainText(PLAN, "steady", 100_000)).toBe("预计还要 10 秒左右");
  });

  it("剩余不足 5 秒改说「就快好了」，不给具体数字", () => {
    expect(resolveWaitRemainText(PLAN, "steady", 106_000)).toBe("就快好了");
  });

  it("已过预估但还在 steady 档：如实说「比预计稍久」，不谎称就快好了干等 20 秒", () => {
    expect(resolveWaitRemainText(PLAN, "steady", 120_000)).toBe("比预计稍久，就快好了");
    expect(resolveWaitRemainText(PLAN, "steady", 200_000)).toBe("比预计稍久，就快好了");
  });

  it("slow / critical 不再倒计时（避免「还要 5 秒」说了半分钟）", () => {
    expect(resolveWaitRemainText(PLAN, "slow", 130_000)).toBe("比预计久一些，还在处理");
    expect(resolveWaitRemainText(PLAN, "critical", 210_000)).toBe(
      "等得有点久了，可以先取消再试一次",
    );
  });
});

describe("resolveWaitStage 快照", () => {
  it("首帧：首站、0 进度、steady、字段齐全", () => {
    const snapshot = resolveWaitStage(PLAN, 0);
    expect(snapshot.index).toBe(0);
    expect(snapshot.doneCount).toBe(0);
    expect(snapshot.total).toBe(4);
    expect(snapshot.stage.name).toBe("读料");
    expect(snapshot.stages).toBe(PLAN.stages);
    expect(snapshot.elapsedMs).toBe(0);
    expect(snapshot.elapsedText).toBe("0 秒");
    expect(snapshot.progress).toBe(0);
    expect(snapshot.tier).toBe("steady");
    expect(snapshot.remainText).toBe("预计还要 2 分钟左右");
  });

  it("跳站即换站点与句子，计时同步", () => {
    const at15s = resolveWaitStage(PLAN, 15_000);
    expect(at15s.index).toBe(2);
    expect(at15s.doneCount).toBe(2);
    expect(at15s.stage.name).toBe("排线");
    expect(at15s.stage.sentence).toBe("根据行程约束规划最佳路线…");
    expect(at15s.elapsedText).toBe("15 秒");

    const at130s = resolveWaitStage(PLAN, 130_000);
    expect(at130s.elapsedText).toBe("2 分 10 秒");
    expect(at130s.tier).toBe("slow");
    expect(at130s.remainText).toBe("比预计久一些，还在处理");
  });

  it("软进度：站点 i 落在 i/(N-1)，单调不减且站点边界连续", () => {
    expect(resolveWaitStage(PLAN, 0).progress).toBe(0);
    expect(resolveWaitStage(PLAN, 5_000).progress).toBeCloseTo(1 / 3, 6);
    expect(resolveWaitStage(PLAN, 15_000).progress).toBeCloseTo(2 / 3, 6);

    // 边界连续：跳站前一瞬的进度略低于站点值，不出现回退
    const beforeJump = resolveWaitStage(PLAN, 14_999).progress;
    const afterJump = resolveWaitStage(PLAN, 15_000).progress;
    expect(beforeJump).toBeLessThan(afterJump);
    expect(afterJump - beforeJump).toBeLessThan(0.02);

    // 全程单调不减（0 → 兜底超时，1 秒粒度采样）
    let previous = -1;
    for (let elapsed = 0; elapsed <= 315_000; elapsed += 1_000) {
      const progress = resolveWaitStage(PLAN, elapsed).progress;
      expect(progress).toBeGreaterThanOrEqual(previous);
      previous = progress;
    }
  });

  it("软进度封顶 PROGRESS_CAP：末站再久也不满格（完成前永不 100%）", () => {
    expect(PROGRESS_CAP).toBeLessThan(1);
    expect(resolveWaitStage(PLAN, 60_000).progress).toBe(PROGRESS_CAP);
    expect(resolveWaitStage(PLAN, 110_000).progress).toBe(PROGRESS_CAP);
    expect(resolveWaitStage(PLAN, 315_000).progress).toBe(PROGRESS_CAP);
    expect(resolveWaitStage(PLAN, 9_999_999).progress).toBe(PROGRESS_CAP);
  });

  it("单站点方案不除零：进度仍受封顶约束", () => {
    const snapshot = resolveWaitStage(BARE_PLAN, 5_000);
    expect(snapshot.total).toBe(1);
    expect(snapshot.index).toBe(0);
    expect(snapshot.progress).toBeGreaterThan(0);
    expect(snapshot.progress).toBeLessThanOrEqual(PROGRESS_CAP);
    expect(Number.isFinite(snapshot.progress)).toBe(true);
  });

  it("负耗时 / NaN / Infinity 兜底：按 0 处理，不产出非法读数", () => {
    for (const bad of [-1_000, Number.NaN, Number.POSITIVE_INFINITY]) {
      const snapshot = resolveWaitStage(PLAN, bad);
      expect(snapshot.elapsedMs).toBe(0);
      expect(snapshot.elapsedText).toBe("0 秒");
      expect(snapshot.index).toBe(0);
      expect(snapshot.progress).toBe(0);
      expect(snapshot.tier).toBe("steady");
    }
  });

  it("tick 粒度为半秒：与既有思考链 DRAFT_THINKING_TICK_MS 同源不打架", () => {
    expect(WAIT_STAGE_TICK_MS).toBe(500);
  });
});

describe("waitProgressPercent 内联宽度", () => {
  it("保留一位小数（避免每帧抖动），越界值夹紧到 0..100%", () => {
    expect(waitProgressPercent(0)).toBe("0.0%");
    expect(waitProgressPercent(1 / 3)).toBe("33.3%");
    expect(waitProgressPercent(PROGRESS_CAP)).toBe("94.0%");
    expect(waitProgressPercent(1)).toBe("100.0%");
    expect(waitProgressPercent(1.5)).toBe("100.0%");
    expect(waitProgressPercent(-1)).toBe("0.0%");
    expect(waitProgressPercent(Number.NaN)).toBe("0.0%");
  });
});
