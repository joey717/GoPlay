/**
 * Task #224：分级进度展示组件测试。
 *
 * 组件自身不计时（时钟由调用方持有），因此这里全部用 resolveWaitStage 造快照，
 * 断言纯渲染契约：
 * - 两个变体（panel 全量 / line 紧凑）的结构差异与取消按钮门控；
 * - 站点三态类名（done / now / todo）随快照 index 推进；
 * - 软进度写成 CSS 变量，末站封顶不满格（完成前永不 100%）；
 * - 可访问性：role=status + 可访问名、路线与计时对读屏隐藏（避免 500ms 刷屏）。
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import WaitStageProgress from "./WaitStageProgress";
import { DRAFT_WAIT_PLAN } from "../lib/waitPlans";
import { PROGRESS_CAP, resolveWaitStage } from "../lib/waitStages";

/** 从 .wait-route 的 style 属性里取 CSS 变量（jsdom 无布局，只能对声明值断言） */
function routeVar(name: string): string {
  const route = document.querySelector(".wait-route");
  const style = route?.getAttribute("style") ?? "";
  const match = new RegExp(`${name}:\\s*([^;]+)`).exec(style);
  return match?.[1]?.trim() ?? "";
}

function stopClasses(): string[] {
  return Array.from(document.querySelectorAll(".wait-stop")).map((element) => element.className);
}

describe("WaitStageProgress panel 变体", () => {
  it("渲染四站路线 + 站名，缺省可访问名为「生成进度」", () => {
    render(<WaitStageProgress snapshot={resolveWaitStage(DRAFT_WAIT_PLAN, 20_000)} />);
    const root = screen.getByRole("status", { name: "生成进度" });
    expect(root).toHaveAttribute("data-variant", "panel");
    expect(root).toHaveAttribute("data-tier", "steady");
    expect(Array.from(document.querySelectorAll(".wait-stop-name")).map((n) => n.textContent)).toEqual(
      ["读料", "选点", "排线", "成稿"],
    );
  });

  it("站点三态：20 秒时前两站已到、第三站当前、末站未到", () => {
    render(<WaitStageProgress snapshot={resolveWaitStage(DRAFT_WAIT_PLAN, 20_000)} />);
    expect(stopClasses()).toEqual([
      "wait-stop done",
      "wait-stop done",
      "wait-stop now",
      "wait-stop todo",
    ]);
  });

  it("首帧全部未到站（首站为当前站）；末站时前三站已到", () => {
    const { unmount } = render(
      <WaitStageProgress snapshot={resolveWaitStage(DRAFT_WAIT_PLAN, 0)} />,
    );
    expect(stopClasses()).toEqual([
      "wait-stop now",
      "wait-stop todo",
      "wait-stop todo",
      "wait-stop todo",
    ]);
    unmount();

    render(<WaitStageProgress snapshot={resolveWaitStage(DRAFT_WAIT_PLAN, 300_000)} />);
    expect(stopClasses()).toEqual([
      "wait-stop done",
      "wait-stop done",
      "wait-stop done",
      "wait-stop now",
    ]);
  });

  it("展示当前阶段句子、已等计时与预计剩余", () => {
    render(<WaitStageProgress snapshot={resolveWaitStage(DRAFT_WAIT_PLAN, 20_000)} />);
    expect(document.querySelector(".wait-panel-sentence")).toHaveTextContent(
      "根据行程约束规划最佳路线…",
    );
    expect(document.querySelector(".wait-panel-clock")).toHaveTextContent("已等 20 秒");
    expect(document.querySelector(".wait-panel-remain")).toHaveTextContent("预计还要 2 分钟左右");
  });

  it("sentence 覆盖当前阶段句子（草案沿用既有思考链文案，面板与浮条口径一致）", () => {
    render(
      <WaitStageProgress
        snapshot={resolveWaitStage(DRAFT_WAIT_PLAN, 20_000)}
        sentence="合并 3 篇攻略的地点和玩法细节…"
      />,
    );
    expect(document.querySelector(".wait-panel-sentence")).toHaveTextContent(
      "合并 3 篇攻略的地点和玩法细节…",
    );
    expect(document.querySelector(".wait-panel-sentence")).not.toHaveTextContent(
      "根据行程约束规划最佳路线…",
    );
  });

  it("取消按钮：给了 onCancel 才渲染，点击上抛一次；文案可覆盖", () => {
    const onCancel = vi.fn();
    const { rerender } = render(
      <WaitStageProgress snapshot={resolveWaitStage(DRAFT_WAIT_PLAN, 20_000)} />,
    );
    expect(screen.queryByRole("button")).toBeNull();

    rerender(
      <WaitStageProgress
        snapshot={resolveWaitStage(DRAFT_WAIT_PLAN, 20_000)}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "取消等待" }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    rerender(
      <WaitStageProgress
        snapshot={resolveWaitStage(DRAFT_WAIT_PLAN, 20_000)}
        onCancel={onCancel}
        cancelText="先不等了"
      />,
    );
    expect(screen.getByRole("button", { name: "先不等了" })).toBeInTheDocument();
  });

  it("hint 补充行（可离开等待）：给了才渲染，且对读屏保留（静态可行动信息）", () => {
    const { rerender } = render(
      <WaitStageProgress snapshot={resolveWaitStage(DRAFT_WAIT_PLAN, 20_000)} />,
    );
    expect(document.querySelector(".wait-panel-hint")).toBeNull();

    rerender(
      <WaitStageProgress
        snapshot={resolveWaitStage(DRAFT_WAIT_PLAN, 20_000)}
        hint="可以先关掉面板去别处看看，排好会在底部提醒你"
      />,
    );
    const hint = document.querySelector(".wait-panel-hint");
    expect(hint).toHaveTextContent("可以先关掉面板去别处看看");
    expect(hint).not.toHaveAttribute("aria-hidden");
  });

  it("分级只换 data-tier，不换结构（等待越久界面不越吵）", () => {
    const { rerender } = render(
      <WaitStageProgress snapshot={resolveWaitStage(DRAFT_WAIT_PLAN, 20_000)} />,
    );
    expect(screen.getByRole("status", { name: "生成进度" })).toHaveAttribute("data-tier", "steady");

    rerender(<WaitStageProgress snapshot={resolveWaitStage(DRAFT_WAIT_PLAN, 140_000)} />);
    const slow = screen.getByRole("status", { name: "生成进度" });
    expect(slow).toHaveAttribute("data-tier", "slow");
    expect(document.querySelector(".wait-panel-remain")).toHaveTextContent("比预计久一些，还在处理");

    rerender(<WaitStageProgress snapshot={resolveWaitStage(DRAFT_WAIT_PLAN, 220_000)} />);
    expect(screen.getByRole("status", { name: "生成进度" })).toHaveAttribute("data-tier", "critical");
    expect(document.querySelector(".wait-panel-remain")).toHaveTextContent(
      "等得有点久了，可以先取消再试一次",
    );
    expect(document.querySelectorAll(".wait-stop")).toHaveLength(4);
  });

  it("ariaLabel 与 className 可覆盖（宿主避让既有可访问名）", () => {
    render(
      <WaitStageProgress
        snapshot={resolveWaitStage(DRAFT_WAIT_PLAN, 20_000)}
        ariaLabel="草案生成进度"
        className="host-tweaked"
      />,
    );
    const root = screen.getByRole("status", { name: "草案生成进度" });
    expect(root).toHaveClass("wait-stage");
    expect(root).toHaveClass("host-tweaked");
  });
});

describe("WaitStageProgress line 变体（气泡 / 浮条内嵌）", () => {
  it("结构紧凑：无取消按钮、无 hint，缺省可访问名为「AI 处理进度」", () => {
    render(
      <WaitStageProgress
        snapshot={resolveWaitStage(DRAFT_WAIT_PLAN, 20_000)}
        variant="line"
        onCancel={vi.fn()}
        hint="不该出现"
      />,
    );
    const root = screen.getByRole("status", { name: "AI 处理进度" });
    expect(root).toHaveAttribute("data-variant", "line");
    expect(screen.queryByRole("button")).toBeNull();
    expect(root).not.toHaveTextContent("不该出现");
    expect(document.querySelector(".wait-line-sentence")).toHaveTextContent(
      "根据行程约束规划最佳路线…",
    );
    expect(document.querySelector(".wait-line-clock")).toHaveTextContent("已等 20 秒");
    expect(document.querySelector(".wait-line-remain")).toHaveTextContent("预计还要 2 分钟左右");
  });

  it("路线仍在（站名靠 CSS 隐藏），markup 与 panel 同源", () => {
    render(
      <WaitStageProgress snapshot={resolveWaitStage(DRAFT_WAIT_PLAN, 20_000)} variant="line" />,
    );
    expect(document.querySelectorAll(".wait-stop")).toHaveLength(4);
    expect(stopClasses()[2]).toBe("wait-stop now");
  });
});

describe("WaitStageProgress 可访问性与软进度几何", () => {
  it("路线与计时对读屏隐藏：站点名与 500ms 跳动的数字都不进可访问树", () => {
    render(
      <WaitStageProgress snapshot={resolveWaitStage(DRAFT_WAIT_PLAN, 20_000)} ariaLabel="生成进度" />,
    );
    expect(document.querySelector(".wait-route")).toHaveAttribute("aria-hidden", "true");
    expect(document.querySelector(".wait-panel-clock")).toHaveAttribute("aria-hidden", "true");
    // 可访问名只来自 aria-label，不把整段读数念出来
    expect(screen.getByRole("status", { name: "生成进度" })).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: /已等 20 秒/ })).toBeNull();
  });

  it("路线几何：4 站等宽列，细线只连首末圆心（left 12.5% / span 75%）", () => {
    render(<WaitStageProgress snapshot={resolveWaitStage(DRAFT_WAIT_PLAN, 20_000)} />);
    const route = document.querySelector(".wait-route") as HTMLElement;
    expect(route.style.gridTemplateColumns).toBe("repeat(4, 1fr)");
    expect(routeVar("--wait-track-start")).toBe("12.500%");
    expect(routeVar("--wait-track-span")).toBe("75.000%");
  });

  it("填充随进度推进，且末站封顶不满格（完成前永不 100%）", () => {
    const { rerender } = render(
      <WaitStageProgress snapshot={resolveWaitStage(DRAFT_WAIT_PLAN, 0)} />,
    );
    expect(routeVar("--wait-fill")).toBe("0.000%");

    rerender(<WaitStageProgress snapshot={resolveWaitStage(DRAFT_WAIT_PLAN, 15_000)} />);
    const midFill = Number.parseFloat(routeVar("--wait-fill").replace("%", ""));
    expect(midFill).toBeGreaterThan(0);
    expect(midFill).toBeLessThan(75);

    rerender(<WaitStageProgress snapshot={resolveWaitStage(DRAFT_WAIT_PLAN, 315_000)} />);
    // 0.94 * 75 = 70.5：兜底超时前一刻也没把线走满
    expect(routeVar("--wait-fill")).toBe(`${(PROGRESS_CAP * 75).toFixed(3)}%`);
    expect(routeVar("--wait-fill")).toBe("70.500%");
  });
});
