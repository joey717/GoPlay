/**
 * Task #264：行程标题栏 ⋯ 菜单的分享链路单测；Task #265 补入口清单口径。
 *
 * 口径（菜单只保留「分享行程」一个入口，不再单列「复制链接」，两者语义重复）：
 * - 有 Web Share API → 系统面板，标题 / 摘要 / 链接三项都要有内容；
 * - 用户取消（AbortError）→ 静默返回，既不提示也不降级复制；
 * - 不支持 Web Share / 系统面板报错（非取消）→ 降级复制链接 + 「链接已复制」；
 * - 链接统一为 `${origin}/share/${tripId}`，与服务端 OG 路由同一个 URL。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Trip } from "@goplay/shared";
import AppHead from "./AppHead";

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  const day = (index: number): Trip["days"][string] => ({
    dayId: `day_${index}`,
    dayIndex: index,
    date: `2026-11-${String(7 + index).padStart(2, "0")}`,
    departTime: null,
    departTimeOverridden: false,
    scheduleVisitRefs: [],
    lodging: null,
  });
  return {
    tripId: "trip-261",
    schemaVersion: 2,
    version: 3,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: "2026-11-10", nights: 2 },
    dayRefs: ["day_1", "day_2", "day_3"],
    days: { day_1: day(1), day_2: day(2), day_3: day(3) },
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
    ...overrides,
  };
}

function renderHead(trip: Trip = makeTrip()) {
  return render(
    <AppHead
      trip={trip}
      onOpenOpLog={vi.fn()}
      onOpenChecklist={vi.fn()}
      onEditConstraints={vi.fn()}
      onNewTrip={vi.fn(async () => true)}
    />,
  );
}

function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
}

const SHARE_URL = `${window.location.origin}/share/trip-261`;

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(navigator, "share");
});

describe("AppHead ⋯ 菜单分享入口（Task #264）", () => {
  it("只有一个「分享行程」入口，不再单列「复制链接」", () => {
    renderHead();
    openMenu();

    const items = screen.getAllByRole("menuitem");
    // 新建行程 / 近期操作 / 待办清单 / 修改约束 / 分享行程
    expect(items).toHaveLength(5);
    // 没有以「复制链接」开头的独立菜单项（降级复制已收进「分享行程」内部）
    const labels = items.map((item) => (item.textContent ?? "").trim());
    expect(labels.some((label) => label.startsWith("复制链接"))).toBe(false);
    expect(screen.getByRole("menuitem", { name: /^分享行程/ })).toBeInTheDocument();
  });

  it("不支持 Web Share：点「分享行程」降级复制链接并提示「链接已复制」", async () => {
    renderHead();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /分享行程/ }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    // 降级只复制链接本身（标题 / 摘要由系统面板承担）
    expect(writeText).toHaveBeenCalledWith(SHARE_URL);
    expect(await screen.findByText("链接已复制")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    // 点击后菜单收起
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("降级复制被拒绝时提示「复制失败，请手动复制」，走错误语气", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    const { container } = renderHead();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /分享行程/ }));

    const toast = await screen.findByRole("alert");
    expect(toast).toHaveTextContent("复制失败，请手动复制");
    expect(toast).toHaveClass("share-toast");
    expect(toast).toHaveClass("is-error");
    expect(container.querySelector(".share-toast.is-error")).not.toBeNull();
  });

  it("系统分享面板报错（非取消）时退回复制链接，不弹失败提示", async () => {
    const share = vi.fn(async () => {
      throw new Error("NotAllowedError");
    });
    Object.defineProperty(navigator, "share", { configurable: true, value: share });

    renderHead();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /分享行程/ }));

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SHARE_URL));
    expect(await screen.findByText("链接已复制")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("AppHead 分享行程（navigator.share 参数完整）", () => {
  it("未命名行程：标题「城市 N天行程」，正文「城市 · N天N晚 · 日期区间」", async () => {
    const share = vi.fn(async () => {});
    Object.defineProperty(navigator, "share", { configurable: true, value: share });

    renderHead();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /分享行程/ }));

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(share).toHaveBeenCalledWith({
      title: "三亚 3天行程",
      text: "三亚 · 3天2晚 · 11/08-11/10",
      url: SHARE_URL,
    });
  });

  it("已命名且有备忘：标题用行程名，正文用备忘单行摘要（前 100 字）", async () => {
    const share = vi.fn(async (_payload: { title: string; text: string; url: string }) => {});
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    const memo = `带证件和泳衣\n\n${"记得提前订船票".repeat(20)}`;

    renderHead(makeTrip({ tripName: "三亚亲子五日", memo }));
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /分享行程/ }));

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    const payload = share.mock.calls[0][0] as { title: string; text: string; url: string };
    expect(payload.title).toBe("三亚亲子五日");
    expect(payload.url).toBe(SHARE_URL);
    // 换行压成单空格、按码点截断到 100 字并以省略号收尾
    expect(payload.text.startsWith("带证件和泳衣 记得提前订船票")).toBe(true);
    expect(payload.text.endsWith("…")).toBe(true);
    expect(Array.from(payload.text)).toHaveLength(101);
    expect(payload.text).not.toContain("\n");
  });

  it("用户取消系统分享（AbortError）不弹任何提示", async () => {
    const share = vi.fn(async () => {
      throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    });
    Object.defineProperty(navigator, "share", { configurable: true, value: share });

    renderHead();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /分享行程/ }));

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    // 取消不降级到剪贴板
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("AppHead 待办清单入口（Task #265）", () => {
  it("点「待办清单」调用 onOpenChecklist 并收起菜单", () => {
    const onOpenChecklist = vi.fn();
    render(
      <AppHead
        trip={makeTrip()}
        onOpenOpLog={vi.fn()}
        onOpenChecklist={onOpenChecklist}
        onEditConstraints={vi.fn()}
        onNewTrip={vi.fn(async () => true)}
      />,
    );
    openMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: /^待办清单/ }));
    expect(onOpenChecklist).toHaveBeenCalledTimes(1);
    // 与其余菜单项一致：点完即收起（不选留在屏上）
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
