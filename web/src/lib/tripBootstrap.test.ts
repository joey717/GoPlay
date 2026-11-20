import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Trip } from "@goplay/shared";
import { ApiError, loadTrip } from "../api/client";
import { TripLoadCancelledError, classifyTripLoadError, loadTripWithRetry } from "./tripBootstrap";

// 只替换行程加载这一次网络调用；ApiError 保持真实实现（分类依赖它的 status）
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  loadTrip: vi.fn(),
}));

const loadTripMock = vi.mocked(loadTrip);

/** 最小 v2 行程壳：本测试只关心启动加载编排，不做结构断言 */
function makeTrip(tripId = "trip-158"): Trip {
  return { tripId, schemaVersion: 2, version: 1 } as unknown as Trip;
}

function abortError(): Error {
  return Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
}

/** 记录重试间隔的 sleep 替身：立即 resolve，不拖慢测试 */
function makeSleepSpy() {
  const calls: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    calls.push(ms);
    return Promise.resolve();
  };
  return { calls, sleep };
}

beforeEach(() => {
  loadTripMock.mockReset();
});

describe("classifyTripLoadError", () => {
  it("只有 404 被判为「行程确实不存在」", () => {
    expect(classifyTripLoadError(new ApiError(404, "TRIP_NOT_FOUND", "行程不存在"))).toEqual({
      kind: "not-found",
      message: "行程不存在",
    });
  });

  it("网络失败 / 代理 502-504 / 超时 / 429 / 5xx 都按临时失败处理并允许自动重试", () => {
    for (const status of [0, 408, 429, 500, 502, 503, 504]) {
      const failure = classifyTripLoadError(new ApiError(status, "INTERNAL", "x"));
      expect(failure.kind).toBe("transient");
      expect(failure.kind === "transient" && failure.autoRetry).toBe(true);
    }
  });

  it("AbortError（单次请求超时中止）按临时失败处理", () => {
    const failure = classifyTripLoadError(abortError());
    expect(failure).toEqual({ kind: "transient", message: "加载超时", autoRetry: true });
  });

  it("其他 4xx 保留引用但不自动重试，避免无效循环", () => {
    const failure = classifyTripLoadError(new ApiError(400, "INTERNAL", "行程数据异常"));
    expect(failure.kind).toBe("transient");
    expect(failure.kind === "transient" && failure.autoRetry).toBe(false);
  });

  it("未知异常不低于「保留引用」的下限", () => {
    const failure = classifyTripLoadError(new Error("boom"));
    expect(failure.kind).toBe("transient");
    expect(failure.kind === "transient" && failure.autoRetry).toBe(true);
  });
});

describe("loadTripWithRetry", () => {
  it("临时断连后自动重试成功即恢复，不清任何引用", async () => {
    const trip = makeTrip();
    loadTripMock
      .mockRejectedValueOnce(new ApiError(502, "INTERNAL", "Bad Gateway"))
      .mockRejectedValueOnce(new ApiError(503, "INTERNAL", "Service Unavailable"))
      .mockResolvedValueOnce(trip);
    const { calls, sleep } = makeSleepSpy();
    const retries: number[] = [];

    const result = await loadTripWithRetry("trip-158", {
      sleep,
      attemptTimeoutMs: 50,
      onRetry: ({ attempt }) => retries.push(attempt),
    });

    expect(result).toBe(trip);
    expect(loadTripMock).toHaveBeenCalledTimes(3);
    expect(retries).toEqual([2, 3]);
    expect(calls).toEqual([500, 1_200]);
  });

  it("自动重试次数有限：全部失败后抛出最后一次错误", async () => {
    loadTripMock.mockRejectedValue(new ApiError(503, "INTERNAL", "Service Unavailable"));
    const { calls, sleep } = makeSleepSpy();

    await expect(
      loadTripWithRetry("trip-158", { sleep, attemptTimeoutMs: 50 }),
    ).rejects.toMatchObject({ status: 503 });
    expect(loadTripMock).toHaveBeenCalledTimes(4);
    expect(calls).toEqual([500, 1_200, 2_500]);
  });

  it("404 不重试：立即抛出交给调用方清引用并进入初始化", async () => {
    loadTripMock.mockRejectedValue(new ApiError(404, "TRIP_NOT_FOUND", "行程不存在"));
    const { calls, sleep } = makeSleepSpy();

    await expect(loadTripWithRetry("trip-158", { sleep })).rejects.toMatchObject({ status: 404 });
    expect(loadTripMock).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });

  it("加载已被放弃时立即停止，不再发请求", async () => {
    await expect(
      loadTripWithRetry("trip-158", { isActive: () => false }),
    ).rejects.toBeInstanceOf(TripLoadCancelledError);
    expect(loadTripMock).not.toHaveBeenCalled();
  });
});
