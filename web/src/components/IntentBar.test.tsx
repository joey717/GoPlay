/**
 * Task #224：IntentBar 等待分级反馈测试。
 *
 * 重点覆盖（既要证明新体验成立，也要证明 Task #42 既有行为没被推翻）：
 * - 0~15s：只有顶边软进度轨，**不弹气泡**（#42 的 15s 门槛严格保留，秒回不闪噪音）；
 * - 15s / 45s / 90s：四站路线逐站推进，前两站文案与 #42 原文逐字一致；
 * - 90s / 150s：slow → critical 分级换档，critical 先一步给出「取消再试」的出路，
 *   衔接既有错误透传与重试入口；
 * - 取消等待：abort 中止 fetch、静默不上抛错误、收起分级反馈、保留输入便于重发；
 * - 秒回 / clarify / 服务端错误：等待结束后分级反馈一律收起，既有分发语义不变。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { IntentResult } from "../api/client";

vi.mock("../api/client", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  sendIntent: vi.fn(),
}));

import IntentBar from "./IntentBar";
import { sendIntent } from "../api/client";
import { INTENT_WAIT_PLAN } from "../lib/waitPlans";

/** 挂起请求句柄：测试自行决定何时 resolve / 是否响应 abort */
interface Pending {
  resolve: (result: IntentResult) => void;
  signal: AbortSignal | undefined;
}

/**
 * 真实 fetch 语义的 mock：signal abort 时以 AbortError 拒绝。
 * 若只返回永不结算的 promise，取消后 finally 不会执行，测出来的是 mock 失真而非产品行为。
 */
function mockPendingIntent(): { pendings: Pending[] } {
  const pendings: Pending[] = [];
  vi.mocked(sendIntent).mockImplementation(
    (_tripId: string, _input: string, signal?: AbortSignal) =>
      new Promise<IntentResult>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
        pendings.push({ resolve, signal });
      }),
  );
  return { pendings };
}

function renderBar(hasContent = true) {
  const onResult = vi.fn();
  const onSessionChange = vi.fn();
  const { unmount } = render(
    <IntentBar
      tripId="trip-1"
      hasContent={hasContent}
      onResult={onResult}
      onSessionChange={onSessionChange}
    />,
  );
  return { onResult, onSessionChange, unmount };
}

function typeAndSend(text = "把 Day2 松一点") {
  fireEvent.change(screen.getByLabelText("行程调整意图"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "AI 调整" }));
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function rail(): Element | null {
  return document.querySelector(".intent-wait-rail");
}

function bubble(): Element | null {
  return document.querySelector(".wait-bubble");
}

function bubbleSentence(): string {
  return document.querySelector(".wait-line-sentence")?.textContent ?? "";
}

function bubbleClock(): string {
  return document.querySelector(".wait-line-clock")?.textContent ?? "";
}

function bubbleRemain(): string {
  return document.querySelector(".wait-line-remain")?.textContent ?? "";
}

function stopStates(): string[] {
  return Array.from(document.querySelectorAll(".wait-bubble .wait-stop")).map(
    (element) => element.className,
  );
}

describe("IntentBar 等待分级反馈（Task #224）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("发送即铺顶边软进度轨；15s 前不弹气泡（Task #42 门槛严格保留）", async () => {
    mockPendingIntent();
    renderBar();
    expect(rail()).toBeNull();
    expect(bubble()).toBeNull();

    act(() => {
      typeAndSend();
    });
    expect(rail()).not.toBeNull();
    expect(rail()).toHaveAttribute("data-tier", "steady");
    expect(bubble()).toBeNull();
    // 0~15s 的空窗不再只有按钮上的「思考中…」
    expect(screen.getByRole("button", { name: "思考中…" })).toBeDisabled();

    await advance(14_500);
    expect(rail()).not.toBeNull();
    expect(bubble()).toBeNull();
  });

  it("顶边轨宽度随已等待时长推进，且完成前不满格", async () => {
    mockPendingIntent();
    renderBar();
    act(() => {
      typeAndSend();
    });
    const fillAt = () => {
      const fill = rail()?.querySelector("i") as HTMLElement | null;
      return Number.parseFloat((fill?.style.width ?? "0%").replace("%", ""));
    };
    const zero = fillAt();
    expect(zero).toBe(0);

    await advance(20_000);
    const later = fillAt();
    expect(later).toBeGreaterThan(zero);
    expect(later).toBeLessThan(100);

    await advance(200_000);
    expect(fillAt()).toBeLessThan(100);
  });

  it("15s 起气泡接管：第二站「规划」，文案与 Task #42 原文逐字一致", async () => {
    mockPendingIntent();
    renderBar();
    act(() => {
      typeAndSend();
    });
    await advance(INTENT_WAIT_PLAN.stages[1].atMs);

    expect(bubble()).not.toBeNull();
    expect(screen.getByRole("status", { name: "AI 调整进度" })).toBeInTheDocument();
    expect(bubbleSentence()).toBe("AI 正在规划完整行程，请耐心等待…");
    expect(bubbleClock()).toBe("已等 15 秒");
    expect(bubbleRemain()).toBe("预计还要 1 分钟左右");
    expect(stopStates()[1]).toBe("wait-stop now");
    expect(stopStates()[0]).toBe("wait-stop done");
    // 顶边轨继续存在（气泡与轨道同源快照，不互相取代）
    expect(rail()).not.toBeNull();
    expect(screen.getByRole("button", { name: "取消等待" })).toBeInTheDocument();
  });

  it("45s 进第三站「重排」：文案与 Task #42 原文逐字一致", async () => {
    mockPendingIntent();
    renderBar();
    act(() => {
      typeAndSend();
    });
    await advance(INTENT_WAIT_PLAN.stages[2].atMs);

    expect(bubbleSentence()).toBe("大规模重排需要较长时间，还在处理中…");
    expect(bubbleClock()).toBe("已等 45 秒");
    expect(stopStates()[2]).toBe("wait-stop now");
    expect(rail()).toHaveAttribute("data-tier", "steady");
  });

  it("90s 进末站「核对」并转 slow 档：不再倒计时，改说「比预计久一些」", async () => {
    mockPendingIntent();
    renderBar();
    act(() => {
      typeAndSend();
    });
    await advance(INTENT_WAIT_PLAN.stages[3].atMs);

    expect(bubbleSentence()).toBe("还在核对这版改动是否安全…");
    expect(bubbleClock()).toBe("已等 1 分 30 秒");
    expect(rail()).toHaveAttribute("data-tier", "slow");
    expect(document.querySelector(".wait-stage")).toHaveAttribute("data-tier", "slow");
    expect(bubbleRemain()).toBe("比预计久一些，还在处理");
    expect(stopStates()[3]).toBe("wait-stop now");
  });

  it("150s 转 critical 档：先一步给出「取消再试」的出路，衔接既有重试入口", async () => {
    mockPendingIntent();
    renderBar();
    act(() => {
      typeAndSend();
    });
    await advance(150_000);

    expect(rail()).toHaveAttribute("data-tier", "critical");
    expect(document.querySelector(".wait-stage")).toHaveAttribute("data-tier", "critical");
    expect(bubbleRemain()).toBe("等得有点久了，可以先取消再试一次");
    expect(screen.getByRole("button", { name: "取消等待" })).toBeEnabled();
  });

  it("计时每半秒推进：已等读数从 15 秒走到 20 秒", async () => {
    mockPendingIntent();
    renderBar();
    act(() => {
      typeAndSend();
    });
    await advance(15_000);
    expect(bubbleClock()).toBe("已等 15 秒");
    await advance(5_000);
    expect(bubbleClock()).toBe("已等 20 秒");
    expect(bubbleSentence()).toBe("AI 正在规划完整行程，请耐心等待…");
  });

  it("取消等待：abort 中止 fetch、静默不上抛错误、收起分级反馈、保留输入便于重发", async () => {
    const { pendings } = mockPendingIntent();
    const { onResult } = renderBar();
    act(() => {
      typeAndSend("Day2 松一点");
    });
    await advance(20_000);
    expect(bubble()).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "取消等待" }));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(pendings[0]?.signal?.aborted).toBe(true);
    expect(onResult).not.toHaveBeenCalled();
    expect(bubble()).toBeNull();
    expect(rail()).toBeNull();
    expect(screen.getByLabelText("行程调整意图")).toHaveValue("Day2 松一点");
    expect(screen.getByRole("button", { name: "AI 调整" })).toBeEnabled();
  });

  it("取消后迟到的响应不再更新界面（静默语义与 Task #42 一致）", async () => {
    const { pendings } = mockPendingIntent();
    const { onResult } = renderBar();
    act(() => {
      typeAndSend();
    });
    await advance(20_000);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "取消等待" }));
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      pendings[0]?.resolve({ type: "applied", sessionId: "s-1" });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onResult).not.toHaveBeenCalled();
    expect(bubble()).toBeNull();
  });

  it("秒回（不足 15s）：气泡从不出现，结束后顶边轨一并收起", async () => {
    const { pendings } = mockPendingIntent();
    const { onResult } = renderBar();
    act(() => {
      typeAndSend();
    });
    expect(rail()).not.toBeNull();

    await act(async () => {
      pendings[0]?.resolve({ type: "applied", sessionId: "s-fast" });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(bubble()).toBeNull();
    expect(rail()).toBeNull();
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith({ type: "applied", sessionId: "s-fast" });
    expect(screen.getByLabelText("行程调整意图")).toHaveValue("");
  });

  it("clarify 结果：就地气泡反问，分级反馈收起", async () => {
    const { pendings } = mockPendingIntent();
    const { onResult } = renderBar();
    act(() => {
      typeAndSend();
    });
    await advance(20_000);
    expect(bubble()).not.toBeNull();

    await act(async () => {
      pendings[0]?.resolve({ type: "clarify", sessionId: "s-2", clarify: "想调整哪一天？" });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(bubble()).toBeNull();
    expect(rail()).toBeNull();
    expect(onResult).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("想调整哪一天？");
  });

  it("critical 档之后服务端错误照旧透传：等待反馈收起，既有重试入口不受影响", async () => {
    const { ApiError } = await import("../api/client");
    const error = new (ApiError as unknown as new (s: number, c: string, m: string) => Error)(
      504,
      "BAILIAN_REQUEST_FAILED",
      "意图处理超时，请重试",
    );
    // 手动控制拒绝时机：必须真的等到 critical 档之后再失败（立即拒绝测不到分档衔接）
    let rejectIntent: (reason: unknown) => void = () => {};
    vi.mocked(sendIntent).mockImplementation(
      () =>
        new Promise<IntentResult>((_resolve, reject) => {
          rejectIntent = reject;
        }),
    );
    const { onResult } = renderBar();

    act(() => {
      typeAndSend();
    });
    await advance(160_000);
    expect(rail()).toHaveAttribute("data-tier", "critical");
    expect(bubbleRemain()).toBe("等得有点久了，可以先取消再试一次");

    await act(async () => {
      rejectIntent(error);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith({
      type: "error",
      sessionId: "",
      message: "意图处理超时，请重试",
    });
    expect(bubble()).toBeNull();
    expect(rail()).toBeNull();
  });

  it("非 ApiError（网络中断）：通用文案，不泄露技术细节", async () => {
    let rejectIntent: (reason: unknown) => void = () => {};
    vi.mocked(sendIntent).mockImplementation(
      () =>
        new Promise<IntentResult>((_resolve, reject) => {
          rejectIntent = reject;
        }),
    );
    const { onResult } = renderBar();
    act(() => {
      typeAndSend();
    });
    await act(async () => {
      rejectIntent(new TypeError("fetch failed"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onResult).toHaveBeenCalledWith({
      type: "error",
      sessionId: "",
      message: "网络错误，请重试",
    });
    expect(rail()).toBeNull();
  });

  it("空闲时不挂任何等待元素（顶边轨只在 loading 期间存在）", () => {
    mockPendingIntent();
    renderBar();
    expect(rail()).toBeNull();
    expect(bubble()).toBeNull();
    expect(document.querySelector(".wait-stage")).toBeNull();
  });

  it("还没有行程内容时按钮文案仍是「AI 排一版」，等待反馈同一套", async () => {
    mockPendingIntent();
    renderBar(false);
    fireEvent.change(screen.getByLabelText("行程调整意图"), { target: { value: "排个三亚三天" } });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "AI 排一版" }));
    });
    expect(rail()).not.toBeNull();
    await advance(15_000);
    expect(bubbleSentence()).toBe("AI 正在规划完整行程，请耐心等待…");
  });

  it("卸载即中止在途请求并收起等待（不 setState 到已卸载组件）", async () => {
    const { pendings } = mockPendingIntent();
    const { onResult, unmount } = renderBar();
    act(() => {
      typeAndSend();
    });
    await advance(20_000);
    expect(bubble()).not.toBeNull();

    unmount();
    expect(pendings[0]?.signal?.aborted).toBe(true);
    expect(rail()).toBeNull();
    expect(bubble()).toBeNull();
    expect(onResult).not.toHaveBeenCalled();
  });
});
