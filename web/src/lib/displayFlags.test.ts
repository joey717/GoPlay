/**
 * Task #340 开关默认值哨兵：锁定 SHOW_ESTIMATED_TIMES 当前为 false（暂停估算时间展示）。
 * 若未来拿到准确时长/时间数据源要恢复展示，把 displayFlags.ts 改回 true 后，
 * 本用例会失败提醒同步更新——届时按 displayFlags.flagOn.test.tsx 的恢复断言回归。
 */
import { describe, expect, it } from "vitest";
import { SHOW_ESTIMATED_TIMES } from "./displayFlags";

describe("displayFlags（Task #340）", () => {
  it("估算时间展示开关默认关闭（2026-11-03 PD 判定时间评估不准）", () => {
    expect(SHOW_ESTIMATED_TIMES).toBe(false);
  });
});
