import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Trip } from "@goplay/shared";
import { ApiError, loadTrip } from "./api/client";
import App from "./App";

// 只替换行程加载网络调用；ApiError 等保持真实实现（启动逻辑依赖 status 分类）
vi.mock("./api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/client")>()),
  loadTrip: vi.fn(),
}));

// 两个阶段组件用轻量 stub：本测试只验证「落到哪个阶段」与本地引用是否被清
vi.mock("./components/InitFlow", () => ({
  default: ({ notice }: { notice: string | null }) => (
    <div data-testid="init-flow">{notice ?? ""}</div>
  ),
}));
vi.mock("./components/TripView", () => ({
  default: ({ tripId }: { tripId: string }) => <div data-testid="trip-view">{tripId}</div>,
}));
// Task #205：分享路由只验证「落到 share 阶段」，真实视图另由 ShareView.test.tsx 覆盖
vi.mock("./components/ShareView", () => ({
  default: ({ tripId }: { tripId: string }) => <div data-testid="share-view">{tripId}</div>,
}));

const loadTripMock = vi.mocked(loadTrip);
const TRIP_ID = "trip-158";

/** 最小 v2 行程（字段与 isV11Trip 闸门一致即可） */
function makeTrip(tripId = TRIP_ID): Trip {
  const day = (index: number): Trip["days"][string] => ({
    dayId: `day_${index}`,
    dayIndex: index,
    date: `2026-11-0${7 + index}`,
    departTime: null,
    departTimeOverridden: false,
    scheduleVisitRefs: [],
    lodging: null,
  });
  return {
    tripId,
    schemaVersion: 2,
    version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: "2026-11-10", nights: 2 },
    dayRefs: ["day_1", "day_2"],
    days: { day_1: day(1), day_2: day(2) },
    lodgings: {},
    itemRegistry: {},
    hotelRegistry: {},
    visits: {},
    stops: {},
    evidences: {},
    globalCandidateRefs: [],
    pendingStopRefs: [],
    relationshipSuggestions: {},
    guideSources: {},
    constraints: [],
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
  };
}

/** 推进假定时器并把期间产生的 Promise 链与 React 更新一起冲刷 */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function seedStoredTrip() {
  localStorage.setItem("goplay.tripId", TRIP_ID);
  localStorage.setItem("goplay.trip", JSON.stringify({ marker: "cached" }));
}

beforeEach(() => {
  localStorage.clear();
  loadTripMock.mockReset();
  vi.useFakeTimers();
  // 分享路由按 pathname 判定，用例之间必须复位到根路径
  window.history.pushState({}, "", "/");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});

describe("App 启动加载（Task #158）", () => {
  it("临时断连（代理 502）不清本地行程引用，自动重试后显示「暂时无法连接」而非初始化表单", async () => {
    seedStoredTrip();
    loadTripMock.mockRejectedValue(new ApiError(502, "INTERNAL", "Bad Gateway"));

    render(<App />);
    await advance(500);
    // 自动重试期间有过程反馈，仍在加载态
    expect(screen.getByText(/正在重试/)).toBeInTheDocument();
    expect(screen.queryByTestId("init-flow")).not.toBeInTheDocument();

    await advance(4_000);
    expect(screen.getByRole("alert")).toHaveTextContent("暂时无法连接");
    expect(screen.queryByTestId("init-flow")).not.toBeInTheDocument();
    // tripId 与本地缓存都必须保留
    expect(localStorage.getItem("goplay.tripId")).toBe(TRIP_ID);
    expect(localStorage.getItem("goplay.trip")).toBe(JSON.stringify({ marker: "cached" }));
    // 首次 + 3 次自动重试
    expect(loadTripMock).toHaveBeenCalledTimes(4);
  });

  it("临时断连后自动重试成功，直接恢复原 TripView 且引用不变", async () => {
    seedStoredTrip();
    loadTripMock
      .mockRejectedValueOnce(new ApiError(503, "INTERNAL", "Service Unavailable"))
      .mockResolvedValueOnce(makeTrip());

    render(<App />);
    await advance(600);

    expect(screen.getByTestId("trip-view")).toHaveTextContent(TRIP_ID);
    expect(screen.queryByTestId("init-flow")).not.toBeInTheDocument();
    expect(localStorage.getItem("goplay.tripId")).toBe(TRIP_ID);
    expect(loadTripMock).toHaveBeenCalledTimes(2);
  });

  it("明确 404 才清除 tripId 与缓存并进入初始化，且不自动重试", async () => {
    seedStoredTrip();
    loadTripMock.mockRejectedValue(new ApiError(404, "TRIP_NOT_FOUND", "行程不存在"));

    render(<App />);
    await advance(10);

    expect(screen.getByTestId("init-flow")).toBeInTheDocument();
    expect(screen.queryByText("暂时无法连接")).not.toBeInTheDocument();
    expect(localStorage.getItem("goplay.tripId")).toBeNull();
    expect(localStorage.getItem("goplay.trip")).toBeNull();
    expect(loadTripMock).toHaveBeenCalledTimes(1);
  });

  it("非 404 的失败（如 400）保留引用并落到断连态，等待手动重试", async () => {
    seedStoredTrip();
    loadTripMock.mockRejectedValue(new ApiError(400, "INTERNAL", "行程数据异常"));

    render(<App />);
    await advance(10);

    expect(screen.getByRole("alert")).toHaveTextContent("暂时无法连接");
    expect(localStorage.getItem("goplay.tripId")).toBe(TRIP_ID);
    // 4xx（非 408/425/429）不做无效自动重试
    expect(loadTripMock).toHaveBeenCalledTimes(1);
  });

  it("断连态点「重试」后可继续进入原 TripView", async () => {
    seedStoredTrip();
    loadTripMock.mockRejectedValue(new ApiError(0, "NETWORK", "网络连接失败"));

    render(<App />);
    await advance(5_000);
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();

    loadTripMock.mockReset();
    loadTripMock.mockResolvedValue(makeTrip());
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await advance(10);

    expect(screen.getByTestId("trip-view")).toHaveTextContent(TRIP_ID);
    expect(localStorage.getItem("goplay.tripId")).toBe(TRIP_ID);
    expect(loadTripMock).toHaveBeenCalledTimes(1);
  });

  it("没有本地 tripId 时直接进入初始化，不发请求", async () => {
    render(<App />);
    await advance(10);

    expect(screen.getByTestId("init-flow")).toBeInTheDocument();
    expect(loadTripMock).not.toHaveBeenCalled();
  });
});

describe("App 分享链接路由（Task #205）", () => {
  it("命中 /share/:tripId 时直接进入只读分享，不读本地 Trip 也不发请求", async () => {
    window.history.pushState({}, "", "/share/22222222-2222-4222-8222-222222222222");
    // 即便本地有历史行程，分享链接也不应被本地状态影响
    seedStoredTrip();

    render(<App />);
    await advance(10);

    expect(screen.getByTestId("share-view")).toHaveTextContent("22222222-2222-4222-8222-222222222222");
    expect(loadTripMock).not.toHaveBeenCalled();
    // 接收方浏览器的本地引用保持原样（不被分享链路清空 / 覆写）
    expect(localStorage.getItem("goplay.tripId")).toBe(TRIP_ID);
  });

  it("容忍尾部斜杠并解码 tripId", async () => {
    window.history.pushState({}, "", "/share/trip%2Dshare/");

    render(<App />);
    await advance(10);

    expect(screen.getByTestId("share-view")).toHaveTextContent("trip-share");
    expect(loadTripMock).not.toHaveBeenCalled();
  });

  it("非分享路径仍按本地引用加载原 TripView", async () => {
    window.history.pushState({}, "", "/share");
    seedStoredTrip();
    loadTripMock.mockResolvedValue(makeTrip());

    render(<App />);
    await advance(10);

    expect(screen.getByTestId("trip-view")).toHaveTextContent(TRIP_ID);
    expect(screen.queryByTestId("share-view")).not.toBeInTheDocument();
  });
});
