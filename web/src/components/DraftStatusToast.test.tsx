/**
 * 任务 135：底部草案状态浮条（DraftStatusToast）单元测试。
 * 覆盖：三态渲染（generating / ready / failed）与点击回调——
 * 生成中与完成态点击主体重开面板；失败态「重试」直接重发且不误触打开。
 *
 * Task #224：generating 态在过程文案之下补一行分级读数（站点 · 已等多久 ·
 * 预计剩余）与底边软进度轨；快照缺失时严格退回既有单行展示。
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import DraftStatusToast, { type DraftToastState } from "./DraftStatusToast";
import { DRAFT_WAIT_PLAN } from "../lib/waitPlans";
import { PROGRESS_CAP, resolveWaitStage } from "../lib/waitStages";

describe("DraftStatusToast（任务 135 底部浮条三态）", () => {
  it("generating：展示时间线过程文案与「查看」，点击主体触发 onOpen", () => {
    const onOpen = vi.fn();
    const onRetry = vi.fn();
    const state: DraftToastState = { kind: "generating", text: "根据行程约束规划最佳路线…" };
    render(<DraftStatusToast state={state} onOpen={onOpen} onRetry={onRetry} />);

    expect(screen.getByRole("status", { name: "攻略生成进度" })).toBeInTheDocument();
    expect(screen.getByText("根据行程约束规划最佳路线…")).toBeInTheDocument();
    expect(screen.getByText("查看")).toBeInTheDocument();
    // 生成中不提供重试（请求在途，重试无意义）
    expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /根据行程约束规划最佳路线/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("ready：完成文案 + 点击主体触发 onOpen（重开面板直达草案预览）", () => {
    const onOpen = vi.fn();
    const onRetry = vi.fn();
    render(<DraftStatusToast state={{ kind: "ready" }} onOpen={onOpen} onRetry={onRetry} />);

    expect(screen.getByRole("status", { name: "攻略草案已就绪" })).toBeInTheDocument();
    expect(screen.getByText("攻略排好了，点开看看")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /攻略排好了/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("failed：role=alert 失败提示，点「重试」触发 onRetry 且不误触 onOpen；点「查看」走 onOpen", () => {
    const onOpen = vi.fn();
    const onRetry = vi.fn();
    render(<DraftStatusToast state={{ kind: "failed" }} onOpen={onOpen} onRetry={onRetry} />);

    expect(screen.getByRole("alert", { name: "攻略生成失败" })).toBeInTheDocument();
    expect(screen.getByText("这一版没排成，点开看看")).toBeInTheDocument();

    // 重试按钮：只重发，不打开面板
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();

    // 主体消息：打开面板看失败原因
    fireEvent.click(screen.getByRole("button", { name: /这一版没排成/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

/**
 * Task #224：离开面板后浮条接管的分级读数。
 * 快照由 useGuideDraftGeneration 产出（与面板同源），这里只验证浮条如实展示：
 * 读数行 / 软进度轨 / 分级挂钩，以及「没有快照就退回原样」的兼容边界。
 */
describe("DraftStatusToast 分级读数（Task #224）", () => {
  function railWidth(): number {
    const rail = document.querySelector(".draft-toast-rail > i") as HTMLElement | null;
    expect(rail).not.toBeNull();
    return Number.parseFloat(rail?.style.width ?? "");
  }

  it("有快照：过程文案之下补「站点 · 已等 · 预计剩余」，底边软进度轨按进度填充", () => {
    const stage = resolveWaitStage(DRAFT_WAIT_PLAN, 20_000);
    const state: DraftToastState = {
      kind: "generating",
      text: "根据行程约束规划最佳路线…",
      stage,
    };
    render(<DraftStatusToast state={state} onOpen={vi.fn()} onRetry={vi.fn()} />);

    // 主文案仍是既有思考链文案（口径不被分级读数顶掉）
    expect(screen.getByText("根据行程约束规划最佳路线…")).toBeInTheDocument();
    const reading = document.querySelector(".draft-toast-stage");
    expect(reading?.textContent).toBe("排线 · 已等 20 秒 · 预计还要 2 分钟左右");
    expect(railWidth()).toBeCloseTo(stage.progress * 100, 1);
    expect(document.querySelector(".draft-toast")).toHaveAttribute("data-tier", "steady");
  });

  it("分级读数与软进度轨对读屏隐藏：可访问名与按钮名都不含 500ms 跳动的数字", () => {
    const state: DraftToastState = {
      kind: "generating",
      text: "根据行程约束规划最佳路线…",
      stage: resolveWaitStage(DRAFT_WAIT_PLAN, 20_000),
    };
    render(<DraftStatusToast state={state} onOpen={vi.fn()} onRetry={vi.fn()} />);

    expect(document.querySelector(".draft-toast-stage")).toHaveAttribute("aria-hidden", "true");
    expect(document.querySelector(".draft-toast-rail")).toHaveAttribute("aria-hidden", "true");
    // 可访问名不变（既有测试与读屏用户都按这个名字找浮条）
    expect(screen.getByRole("status", { name: "攻略生成进度" })).toBeInTheDocument();
    // 计时数字不进按钮名：否则「已等 20 秒」每半秒变一次，读屏反复播报
    // （可访问名只剩主文案——读数行、「查看」与进度轨都被 aria-hidden 摘掉）
    expect(
      screen.getByRole("button", { name: "根据行程约束规划最佳路线…" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /已等/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /排线/ })).not.toBeInTheDocument();
  });

  it("分级只换 data-tier，不加结构：slow / critical 下仍是同一行读数（等待越久浮条不越吵）", () => {
    const slow = resolveWaitStage(DRAFT_WAIT_PLAN, 140_000);
    const { rerender } = render(
      <DraftStatusToast
        state={{ kind: "generating", text: "内容较多，还需要一点时间…", stage: slow }}
        onOpen={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(slow.tier).toBe("slow");
    expect(document.querySelector(".draft-toast")).toHaveAttribute("data-tier", "slow");
    expect(document.querySelector(".draft-toast-stage")?.textContent).toBe(
      "成稿 · 已等 2 分 20 秒 · 比预计久一些，还在处理",
    );

    const critical = resolveWaitStage(DRAFT_WAIT_PLAN, 240_000);
    rerender(
      <DraftStatusToast
        state={{ kind: "generating", text: "内容较多，还需要一点时间…", stage: critical }}
        onOpen={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(critical.tier).toBe("critical");
    expect(document.querySelector(".draft-toast")).toHaveAttribute("data-tier", "critical");
    expect(document.querySelector(".draft-toast-stage")?.textContent).toBe(
      "成稿 · 已等 4 分 00 秒 · 等得有点久了，可以先取消再试一次",
    );
    expect(document.querySelectorAll(".draft-toast-stage")).toHaveLength(1);
    expect(document.querySelectorAll(".draft-toast-rail")).toHaveLength(1);
  });

  it("软进度轨封顶：等到 critical 也不满格（完成前永不显示 100%）", () => {
    render(
      <DraftStatusToast
        state={{
          kind: "generating",
          text: "内容较多，还需要一点时间…",
          stage: resolveWaitStage(DRAFT_WAIT_PLAN, 300_000),
        }}
        onOpen={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(railWidth()).toBeLessThanOrEqual(PROGRESS_CAP * 100);
    expect(railWidth()).toBeLessThan(100);
  });

  it("没有快照就严格退回单行：不渲染读数行 / 进度轨 / data-tier（既有行为零回归）", () => {
    const { rerender } = render(
      <DraftStatusToast
        state={{ kind: "generating", text: "正在读取攻略素材…" }}
        onOpen={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(document.querySelector(".draft-toast-stage")).toBeNull();
    expect(document.querySelector(".draft-toast-rail")).toBeNull();
    expect(document.querySelector(".draft-toast")).not.toHaveAttribute("data-tier");
    expect(screen.getByText("正在读取攻略素材…")).toBeInTheDocument();

    // 显式 null 同样退回（调用方在未生成时给 null）
    rerender(
      <DraftStatusToast
        state={{ kind: "generating", text: "正在读取攻略素材…", stage: null }}
        onOpen={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(document.querySelector(".draft-toast-stage")).toBeNull();
    expect(document.querySelector(".draft-toast-rail")).toBeNull();
  });

  it("分级读数不吞点击：点浮条主体照旧重开面板继续等待", () => {
    const onOpen = vi.fn();
    render(
      <DraftStatusToast
        state={{
          kind: "generating",
          text: "根据行程约束规划最佳路线…",
          stage: resolveWaitStage(DRAFT_WAIT_PLAN, 20_000),
        }}
        onOpen={onOpen}
        onRetry={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /根据行程约束规划最佳路线/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
