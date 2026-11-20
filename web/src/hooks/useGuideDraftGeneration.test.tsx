/**
 * 任务 135：行程级草案生成会话 hook 单元测试。
 * 覆盖：成功上抛 / 服务端拒绝（保留重试参数）/ 网络中断 / 取消等待静默 /
 * 315s 兜底超时不假成功 / 取消与超时后的迟到响应丢弃 / 卸载丢弃 /
 * 生成中重复发起自动取消旧请求并替换（任务 210）/
 * Task #224 分级反馈快照（站点推进、分级升级、315s 超时衔接、成功与取消后收起）。
 *
 * 运行：npx vitest run src/hooks/useGuideDraftGeneration.test.tsx（web 目录下）
 */
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { GuideDraftResult } from "../api/client";

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
  generateGuideDraft: vi.fn(),
}));

import { useGuideDraftGeneration } from "./useGuideDraftGeneration";
import { generateGuideDraft } from "../api/client";
import { DRAFT_GENERATION_TIMEOUT_MESSAGE } from "../lib/draftThinking";
import { PROGRESS_CAP } from "../lib/waitStages";

function makeDraftResult(overrides: Partial<GuideDraftResult> = {}): GuideDraftResult {
  return {
    draftId: "draft-1",
    tripVersion: 2,
    baseTripVersion: 2,
    inputTripVersion: 1,
    scope: { kind: "trip" },
    operations: [],
    snippets: [],
    unplaced: [],
    proposedNew: [],
    clarify: null,
    sourceSnapshots: [],
    sourceCount: 1,
    mentionCount: 3,
    placeCount: 2,
    mentionRefCount: 3,
    latencyMs: 100,
    promptChars: 1000,
    attempts: 1,
    ...overrides,
  };
}

const INPUT = { entryContext: { type: "global" } as const, note: "", usableCount: 2 };

/** ApiError 工厂：与 client.ts 真实构造签名一致（status, code, message） */
async function makeApiError(status: number, code: string, message: string): Promise<Error> {
  const { ApiError } = await import("../api/client");
  return new (ApiError as unknown as new (status: number, code: string, message: string) => Error)(
    status,
    code,
    message,
  );
}

describe("useGuideDraftGeneration（任务 135 行程级生成会话）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("任务 189 局部优化：selected 模式请求体携带 sourceMode 与去重后的 selectedSourceIds", async () => {
    const onSuccess = vi.fn();
    let resolveDraft: (draft: GuideDraftResult) => void = () => {};
    vi.mocked(generateGuideDraft).mockImplementation(
      () => new Promise<GuideDraftResult>((resolve) => { resolveDraft = resolve; }),
    );
    const { result } = renderHook(() => useGuideDraftGeneration({ tripId: "trip-1", onSuccess }));

    act(() => {
      result.current.start({
        entryContext: { type: "global" },
        note: "",
        usableCount: 2,
        sourceMode: "selected",
        selectedSourceIds: ["src_a", "src_b", "src_a"],
      });
    });
    expect(vi.mocked(generateGuideDraft)).toHaveBeenCalledWith(
      "trip-1",
      {
        entryContext: { type: "global" },
        note: undefined,
        sourceMode: "selected",
        selectedSourceIds: ["src_a", "src_b", "src_a"],
      },
      expect.anything(),
    );

    await act(async () => {
      resolveDraft(makeDraftResult({ sourceMode: "selected", sourceIds: ["src_a", "src_b"] }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.session.kind).toBe("idle");
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("任务 189 全部重排：sourceMode 为 all 时不携带 selectedSourceIds（服务端互斥契约）", async () => {
    const onSuccess = vi.fn();
    let resolveDraft: (draft: GuideDraftResult) => void = () => {};
    vi.mocked(generateGuideDraft).mockImplementation(
      () => new Promise<GuideDraftResult>((resolve) => { resolveDraft = resolve; }),
    );
    const { result } = renderHook(() => useGuideDraftGeneration({ tripId: "trip-1", onSuccess }));

    act(() => {
      result.current.start({
        entryContext: { type: "global" },
        note: "整体重排",
        usableCount: 3,
        sourceMode: "all",
      });
    });
    const call = vi.mocked(generateGuideDraft).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(call).toEqual({ entryContext: { type: "global" }, note: "整体重排", sourceMode: "all" });
    expect(call.selectedSourceIds).toBeUndefined();

    await act(async () => {
      resolveDraft(makeDraftResult({ sourceMode: "all", sourceIds: [] }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.session.kind).toBe("idle");
  });

  it("任务 189 局部优化失败：重试参数快照完整保留 sourceMode 与 selectedSourceIds", async () => {
    const onSuccess = vi.fn();
    vi.mocked(generateGuideDraft).mockRejectedValue(
      await makeApiError(409, "DRAFT_STALE", "行程已变化，请重新生成草案"),
    );
    const { result } = renderHook(() => useGuideDraftGeneration({ tripId: "trip-1", onSuccess }));

    act(() => {
      result.current.start({
        entryContext: { type: "day", dayIndex: 2 },
        note: "",
        usableCount: 1,
        sourceMode: "selected",
        selectedSourceIds: ["src_new"],
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.session.kind).toBe("failed");
    if (result.current.session.kind === "failed") {
      expect(result.current.session.input).toEqual({
        entryContext: { type: "day", dayIndex: 2 },
        note: "",
        usableCount: 1,
        sourceMode: "selected",
        selectedSourceIds: ["src_new"],
      });
    }
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("任务 207 StrictMode 双挂载：毫秒级响应必须立即上抛，不得被卸载清理永久丢弃", async () => {
    const onSuccess = vi.fn();
    let resolveDraft: (draft: GuideDraftResult) => void = () => {};
    vi.mocked(generateGuideDraft).mockImplementation(
      () => new Promise<GuideDraftResult>((resolve) => { resolveDraft = resolve; }),
    );
    // 应用入口 main.tsx 包了 React.StrictMode（开发环境 effect mount → cleanup → mount）：
    // 首轮清理若把 activeRef 永久置 false，所有响应都会被当成迟到响应丢弃，
    // 服务端 11ms 返回 fastPath=true 也只会表现为「一直生成中」，直到 315s 兜底超时。
    const { result } = renderHook(
      () => useGuideDraftGeneration({ tripId: "trip-1", onSuccess }),
      { wrapper: StrictMode },
    );

    act(() => {
      result.current.start({
        entryContext: { type: "global" },
        note: "把亮点补充到对应景点",
        usableCount: 1,
        sourceMode: "selected",
        selectedSourceIds: ["src_a"],
      });
    });
    expect(result.current.session.kind).toBe("generating");

    await act(async () => {
      resolveDraft(
        makeDraftResult({ fastPath: true, sourceMode: "selected", sourceIds: ["src_a"] }),
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.session.kind).toBe("idle");
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("生成成功：generating 中有思考链文案，resolve 后转 idle 并上抛草案", async () => {
    const onSuccess = vi.fn();
    let resolveDraft: (draft: GuideDraftResult) => void = () => {};
    vi.mocked(generateGuideDraft).mockImplementation(
      () => new Promise<GuideDraftResult>((resolve) => { resolveDraft = resolve; }),
    );
    const { result } = renderHook(() => useGuideDraftGeneration({ tripId: "trip-1", onSuccess }));

    act(() => {
      result.current.start(INPUT);
    });
    expect(result.current.session.kind).toBe("generating");
    expect(result.current.thinkingText).toContain("正在读取攻略素材");

    // 文案按时间线递进（5s 后进入合并步，带可用来源篇数）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(result.current.thinkingText).toContain("2 篇攻略");

    await act(async () => {
      resolveDraft(makeDraftResult({ draftId: "draft-ok" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.session.kind).toBe("idle");
    expect(result.current.thinkingText).toBeNull();
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess.mock.calls[0]?.[0]).toMatchObject({ draftId: "draft-ok" });
    expect(vi.mocked(generateGuideDraft)).toHaveBeenCalledWith(
      "trip-1",
      { entryContext: { type: "global" }, note: undefined },
      expect.anything(),
    );
  });

  it("服务端拒绝（DRAFT_STALE / 400 文案）：转 failed 并透传安全 message，重试参数保留", async () => {
    const onSuccess = vi.fn();
    vi.mocked(generateGuideDraft).mockRejectedValue(
      await makeApiError(409, "DRAFT_STALE", "行程已变化，请重新生成草案"),
    );
    const { result } = renderHook(() => useGuideDraftGeneration({ tripId: "trip-1", onSuccess }));

    act(() => {
      result.current.start({ entryContext: { type: "day", dayIndex: 2 }, note: "带娃慢一点", usableCount: 2 });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.session.kind).toBe("failed");
    if (result.current.session.kind === "failed") {
      expect(result.current.session.message).toBe("行程已变化，请重新生成草案");
      expect(result.current.session.input).toEqual({
        entryContext: { type: "day", dayIndex: 2 },
        note: "带娃慢一点",
        usableCount: 2,
      });
    }
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("网络中断：failed 通用文案（不泄露技术细节）", async () => {
    const onSuccess = vi.fn();
    vi.mocked(generateGuideDraft).mockRejectedValue(new TypeError("fetch failed"));
    const { result } = renderHook(() => useGuideDraftGeneration({ tripId: "trip-1", onSuccess }));

    act(() => {
      result.current.start(INPUT);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.session.kind).toBe("failed");
    if (result.current.session.kind === "failed") {
      expect(result.current.session.message).toBe("攻略草案生成失败，请重试");
    }
  });

  it("取消等待：静默转 idle，迟到的成功响应被丢弃（不假成功、不报错）", async () => {
    const onSuccess = vi.fn();
    let resolveDraft: (draft: GuideDraftResult) => void = () => {};
    vi.mocked(generateGuideDraft).mockImplementation(
      () => new Promise<GuideDraftResult>((resolve) => { resolveDraft = resolve; }),
    );
    const { result } = renderHook(() => useGuideDraftGeneration({ tripId: "trip-1", onSuccess }));

    act(() => {
      result.current.start(INPUT);
    });
    act(() => {
      result.current.cancel();
    });
    expect(result.current.session.kind).toBe("idle");

    // 在途请求此刻返回：seq 已失效，不得转为成功
    await act(async () => {
      resolveDraft(makeDraftResult());
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(result.current.session.kind).toBe("idle");
  });

  it("兜底超时（315s）：转 failed 超时文案，迟到的成功响应不再上抛", async () => {
    const onSuccess = vi.fn();
    let resolveDraft: (draft: GuideDraftResult) => void = () => {};
    vi.mocked(generateGuideDraft).mockImplementation(
      () => new Promise<GuideDraftResult>((resolve) => { resolveDraft = resolve; }),
    );
    const { result } = renderHook(() => useGuideDraftGeneration({ tripId: "trip-1", onSuccess }));

    act(() => {
      result.current.start(INPUT);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(315_000);
    });

    expect(result.current.session.kind).toBe("failed");
    if (result.current.session.kind === "failed") {
      expect(result.current.session.message).toBe(DRAFT_GENERATION_TIMEOUT_MESSAGE);
    }

    // 超时后服务端姗姗来迟地成功：不得覆盖 failed（假成功）
    await act(async () => {
      resolveDraft(makeDraftResult());
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(result.current.session.kind).toBe("failed");
  });

  it("任务 210 生成中重复发起：取消旧请求并替换为新请求，旧迟到响应被丢弃不假成功", async () => {
    const onSuccess = vi.fn();
    const signals: AbortSignal[] = [];
    const resolvers: Array<(draft: GuideDraftResult) => void> = [];
    vi.mocked(generateGuideDraft).mockImplementation(
      (_tripId: string, _input: unknown, signal?: AbortSignal) => {
        if (signal) signals.push(signal);
        return new Promise<GuideDraftResult>((resolve) => { resolvers.push(resolve); });
      },
    );
    const { result } = renderHook(() => useGuideDraftGeneration({ tripId: "trip-1", onSuccess }));

    // 第一轮：误触「整体重排」（慢请求，实测 3+ 分钟）
    act(() => {
      result.current.start({
        entryContext: { type: "global" },
        note: "",
        usableCount: 3,
        sourceMode: "all",
      });
    });
    // 第二轮：改走主按钮快速路径（fastPath 毫秒级），新请求必须立即启动而非被静默丢弃
    act(() => {
      result.current.start({
        entryContext: { type: "global" },
        note: "把亮点补充到对应景点",
        usableCount: 1,
        sourceMode: "selected",
        selectedSourceIds: ["src_a"],
      });
    });

    // 旧请求已被 abort，新请求携带新参数在途
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(vi.mocked(generateGuideDraft)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(generateGuideDraft)).toHaveBeenLastCalledWith(
      "trip-1",
      {
        entryContext: { type: "global" },
        note: "把亮点补充到对应景点",
        sourceMode: "selected",
        selectedSourceIds: ["src_a"],
      },
      expect.anything(),
    );
    expect(result.current.session.kind).toBe("generating");
    if (result.current.session.kind === "generating") {
      expect(result.current.session.input.sourceMode).toBe("selected");
      expect(result.current.session.input.note).toBe("把亮点补充到对应景点");
    }

    // 旧请求姗姗来迟地 resolve（abort 竞态中已完成）：seq 已失效，不得覆盖新会话
    await act(async () => {
      resolvers[0]?.(makeDraftResult({ draftId: "draft-old", sourceMode: "all", sourceIds: [] }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(result.current.session.kind).toBe("generating");

    // 新请求 resolve：正常上抛草案
    await act(async () => {
      resolvers[1]?.(
        makeDraftResult({ draftId: "draft-new", fastPath: true, sourceMode: "selected", sourceIds: ["src_a"] }),
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.session.kind).toBe("idle");
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess.mock.calls[0]?.[0]).toMatchObject({ draftId: "draft-new" });
  });

  it("行程页整体卸载：在途请求中止，迟到响应丢弃", async () => {
    const onSuccess = vi.fn();
    let resolveDraft: (draft: GuideDraftResult) => void = () => {};
    let abortSignal: AbortSignal | null = null;
    vi.mocked(generateGuideDraft).mockImplementation(
      (_tripId: string, _input: unknown, signal?: AbortSignal) => {
        abortSignal = signal ?? null;
        return new Promise<GuideDraftResult>((resolve) => { resolveDraft = resolve; });
      },
    );
    const { result, unmount } = renderHook(() =>
      useGuideDraftGeneration({ tripId: "trip-1", onSuccess }),
    );

    act(() => {
      result.current.start(INPUT);
    });
    unmount();
    // TS 闭包赋值收窄：mockImplementation 内的赋值需显式断言类型
    expect((abortSignal as AbortSignal | null)?.aborted).toBe(true);

    await act(async () => {
      resolveDraft(makeDraftResult());
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

/**
 * Task #224：分级反馈快照（stage）。
 * 与思考链文案共用同一个 500ms 时钟——站点 / 已等计时 / 预计剩余 / 分级全部由
 * 「已等待时长」推断（服务端一次性返回，没有进度事件），因此这里用 fake timers
 * 直接推时钟即可确定性断言；同时守住三条与既有功能的衔接契约：
 * 跳站与换句同时发生（阈值与 DRAFT_THINKING_STEPS 对齐）、315s 兜底超时后
 * 分级读数让位给既有失败态与重试入口、成功 / 取消后浮条与面板同时收起读数。
 */
describe("useGuideDraftGeneration 分级反馈快照（Task #224）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  /** 挂起一个可控的生成请求；返回 resolve 供超时 / 迟到响应用例使用 */
  function pendingGeneration(): (draft: GuideDraftResult) => void {
    let resolveDraft: (draft: GuideDraftResult) => void = () => {};
    vi.mocked(generateGuideDraft).mockImplementation(
      () => new Promise<GuideDraftResult>((resolve) => { resolveDraft = resolve; }),
    );
    return (draft) => resolveDraft(draft);
  }

  function renderGeneration() {
    return renderHook(() =>
      useGuideDraftGeneration({ tripId: "trip-1", onSuccess: vi.fn() }),
    );
  }

  it("idle 不产快照；发起后首帧就有站点 / 计时 / 预计剩余（不再只是转圈）", () => {
    pendingGeneration();
    const { result } = renderGeneration();
    expect(result.current.stage).toBeNull();

    act(() => {
      result.current.start(INPUT);
    });
    const stage = result.current.stage;
    expect(stage).not.toBeNull();
    expect(stage?.index).toBe(0);
    expect(stage?.stage.name).toBe("读料");
    expect(stage?.elapsedMs).toBe(0);
    expect(stage?.elapsedText).toBe("0 秒");
    expect(stage?.tier).toBe("steady");
    expect(stage?.remainText).toMatch(/^预计还要 /);
    expect(stage?.progress).toBe(0);
    expect(stage?.total).toBe(4);
    expect(stage?.doneCount).toBe(0);
  });

  it("mock 计时推进站点：5s 选点 / 15s 排线 / 60s 成稿，跳站与思考链换句同时发生", async () => {
    pendingGeneration();
    const { result } = renderGeneration();
    act(() => {
      result.current.start(INPUT);
    });

    // 阈值前一毫秒仍在上一站
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(result.current.stage?.index).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current.stage?.stage.name).toBe("选点");
    expect(result.current.stage?.doneCount).toBe(1);
    expect(result.current.stage?.elapsedText).toBe("5 秒");
    // 站点阈值落在思考链时间线上：站点跳到「选点」的同一刻句子也换（不错位）
    expect(result.current.thinkingText).toContain("2 篇攻略");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current.stage?.stage.name).toBe("排线");
    expect(result.current.stage?.elapsedText).toBe("15 秒");
    expect(result.current.thinkingText).toBe("根据行程约束规划最佳路线…");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });
    expect(result.current.stage?.stage.name).toBe("成稿");
    expect(result.current.stage?.index).toBe(3);
    expect(result.current.thinkingText).toBe("生成攻略提示和注意事项…");

    // 末站不越界：兜底超时之前一直停在最后一站（不产出第 5 站）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(result.current.stage?.index).toBe(3);
    expect(result.current.stage?.total).toBe(4);
  });

  it("分级单向升级：130s slow / 210s critical，超预估后不再倒计时，critical 先给出取消出路", async () => {
    pendingGeneration();
    const { result } = renderGeneration();
    act(() => {
      result.current.start(INPUT);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current.stage?.tier).toBe("steady");
    expect(result.current.stage?.remainText).toMatch(/^预计还要 /);
    expect(result.current.stage?.elapsedText).toBe("1 分 00 秒");

    // 过了预估（110s）但还没到 slow 档（130s）：如实说「比预计稍久」，不谎称就快好了
    await act(async () => {
      await vi.advanceTimersByTimeAsync(69_000);
    });
    expect(result.current.stage?.tier).toBe("steady");
    expect(result.current.stage?.remainText).toBe("比预计稍久，就快好了");
    expect(result.current.stage?.elapsedText).toBe("2 分 09 秒");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(result.current.stage?.tier).toBe("slow");
    expect(result.current.stage?.remainText).toBe("比预计久一些，还在处理");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(80_000);
    });
    expect(result.current.stage?.tier).toBe("critical");
    expect(result.current.stage?.remainText).toBe("等得有点久了，可以先取消再试一次");
    expect(result.current.stage?.elapsedText).toBe("3 分 30 秒");
    // 软进度封顶：等了 210s 也不满格（完成前永不显示 100%）
    expect(result.current.stage?.progress).toBeLessThanOrEqual(PROGRESS_CAP);
    expect(result.current.stage?.progress).toBeLessThan(1);
  });

  it("兜底超时衔接（315s）：分级读数让位给既有失败态与重试入口，迟到成功不复活快照", async () => {
    const resolveDraft = pendingGeneration();
    const { result } = renderGeneration();
    act(() => {
      result.current.start(INPUT);
    });

    // 超时前一档持续预警（critical 早于 315s，用户有机会自己取消重试）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(314_000);
    });
    expect(result.current.stage?.tier).toBe("critical");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(result.current.session.kind).toBe("failed");
    if (result.current.session.kind === "failed") {
      expect(result.current.session.message).toBe(DRAFT_GENERATION_TIMEOUT_MESSAGE);
      // 重试参数保留：既有重试入口照常可用
      expect(result.current.session.input).toEqual(INPUT);
    }
    // 超时后不再显示进度读数（否则「还在排线」与失败提示自相矛盾）
    expect(result.current.stage).toBeNull();
    expect(result.current.thinkingText).toBeNull();

    await act(async () => {
      resolveDraft(makeDraftResult());
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.session.kind).toBe("failed");
    expect(result.current.stage).toBeNull();
  });

  it("生成成功即收起快照：浮条与面板同时不再显示分级读数", async () => {
    const resolveDraft = pendingGeneration();
    const onSuccess = vi.fn();
    const { result } = renderHook(() =>
      useGuideDraftGeneration({ tripId: "trip-1", onSuccess }),
    );
    act(() => {
      result.current.start(INPUT);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(result.current.stage).not.toBeNull();

    await act(async () => {
      resolveDraft(makeDraftResult({ draftId: "draft-stage" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.stage).toBeNull();
    expect(result.current.thinkingText).toBeNull();
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("取消等待即收起快照：静默转 idle，不把「已等 2 分」残留成失败读数", async () => {
    pendingGeneration();
    const { result } = renderGeneration();
    act(() => {
      result.current.start(INPUT);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(130_000);
    });
    expect(result.current.stage?.tier).toBe("slow");

    act(() => {
      result.current.cancel();
    });
    expect(result.current.session.kind).toBe("idle");
    expect(result.current.stage).toBeNull();
  });

  it("快照身份只随 tick 变化：无关重渲染不换引用（不打穿面板 / 浮条下游 memo）", () => {
    pendingGeneration();
    const { result, rerender } = renderGeneration();
    act(() => {
      result.current.start(INPUT);
    });
    const before = result.current.stage;
    expect(before).not.toBeNull();

    rerender();
    expect(result.current.stage).toBe(before);
  });

  it("生成中重复发起：快照按新请求的起点重算（不从旧等待继承已等时长）", async () => {
    pendingGeneration();
    const { result } = renderGeneration();
    act(() => {
      result.current.start(INPUT);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current.stage?.index).toBe(3);

    act(() => {
      result.current.start({ ...INPUT, note: "改走局部优化" });
    });
    expect(result.current.stage?.index).toBe(0);
    expect(result.current.stage?.elapsedText).toBe("0 秒");
    expect(result.current.stage?.tier).toBe("steady");
  });
});
