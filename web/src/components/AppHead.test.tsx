/**
 * 行程标题栏 ⋯ 菜单的分享链路单测（Task #264 / #265 / #401）。
 *
 * Task #401 修正后的口径（菜单仍只保留「分享行程」一个入口）：
 * - 桌面（包括实现了 navigator.share 的 macOS Safari / Chrome）→ 直接复制
 *   `${origin}/share/${tripId}` + 「链接已复制」，不再一上来弹系统分享面板；
 * - 触屏设备且有 Web Share → 打开小面板：「复制链接」为主、「系统分享…」为辅；
 * - 系统分享被取消（AbortError）→ 静默返回；报错（非取消）→ 退回复制链接；
 * - 两套复制通道都不可用 → 提示手动复制，并给出可全选的链接面板。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

/** 模拟触屏设备（手机 / iPad）：maxTouchPoints > 0 即判为触屏，系统分享才有意义 */
function setMobile() {
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 });
}

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
  Reflect.deleteProperty(navigator, "maxTouchPoints");
});

describe("AppHead 分享行程（Task #401：桌面默认复制只读链接）", () => {
  it("只有一个「分享行程」入口，不再单列「复制链接」", () => {
    renderHead();
    openMenu();

    const items = screen.getAllByRole("menuitem");
    // 新建行程 / 近期操作 / 待办清单 / 修改约束 / 分享行程
    expect(items).toHaveLength(5);
    const labels = items.map((item) => (item.textContent ?? "").trim());
    expect(labels.some((label) => label.startsWith("复制链接"))).toBe(false);
    expect(screen.getByRole("menuitem", { name: /^分享行程/ })).toBeInTheDocument();
  });

  it("桌面即使实现了 navigator.share 也不弹系统面板：直接复制链接并提示「链接已复制」", async () => {
    const share = vi.fn(async () => {});
    Object.defineProperty(navigator, "share", { configurable: true, value: share });

    renderHead();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /分享行程/ }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    // 只复制链接本身（标题 / 摘要由系统分享或社交卡片承担）
    expect(writeText).toHaveBeenCalledWith(SHARE_URL);
    expect(share).not.toHaveBeenCalled();
    expect(await screen.findByText("链接已复制")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    // 一次点击就拿到链接：菜单收起，也不再额外弹面板
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("复制被拒且回退不可用时提示手动复制，并展示可全选的链接面板", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    const { container } = renderHead();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /分享行程/ }));

    const toast = await screen.findByRole("alert");
    expect(toast).toHaveTextContent("复制失败，请手动复制链接");
    expect(toast).toHaveClass("share-toast");
    expect(toast).toHaveClass("is-error");
    expect(container.querySelector(".share-toast.is-error")).not.toBeNull();
    // 失败时把 URL 摆出来，用户仍能长按 / 全选手工复制
    expect(await screen.findByLabelText("只读分享链接")).toHaveValue(SHARE_URL);
  });
});

describe("AppHead 分享面板（触屏设备：复制为主 + 系统分享为辅）", () => {
  it("点「分享行程」先弹小面板，不直接唤起系统面板；复制与系统分享都在", async () => {
    setMobile();
    const share = vi.fn(async () => {});
    Object.defineProperty(navigator, "share", { configurable: true, value: share });

    renderHead();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /分享行程/ }));

    const panel = await screen.findByRole("dialog", { name: "分享行程" });
    expect(share).not.toHaveBeenCalled();
    expect(within(panel).getByLabelText("只读分享链接")).toHaveValue(SHARE_URL);
    expect(within(panel).getByRole("button", { name: "复制链接" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "系统分享…" })).toBeInTheDocument();
  });

  it("面板内「复制链接」：写剪贴板 + 提示 + 收起面板", async () => {
    setMobile();
    Object.defineProperty(navigator, "share", { configurable: true, value: vi.fn(async () => {}) });

    renderHead();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /分享行程/ }));
    fireEvent.click(screen.getByRole("button", { name: "复制链接" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SHARE_URL));
    expect(await screen.findByText("链接已复制")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("触屏但无 Web Share：不弹面板，直接复制链接", async () => {
    setMobile();

    renderHead();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /分享行程/ }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SHARE_URL));
    expect(await screen.findByText("链接已复制")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("面板内「系统分享…」：标题 / 摘要 / 链接三项完整", async () => {
    setMobile();
    const share = vi.fn(async () => {});
    Object.defineProperty(navigator, "share", { configurable: true, value: share });

    renderHead();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /分享行程/ }));
    fireEvent.click(screen.getByRole("button", { name: "系统分享…" }));

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(share).toHaveBeenCalledWith({
      title: "三亚 3天行程",
      text: "三亚 · 3天2晚 · 11/08-11/10",
      url: SHARE_URL,
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("已命名且有备忘：标题用行程名，正文用备忘单行摘要（前 100 字）", async () => {
    setMobile();
    const share = vi.fn(async (_payload: { title: string; text: string; url: string }) => {});
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    const memo = `带证件和泳衣\n\n${"记得提前订船票".repeat(20)}`;

    renderHead(makeTrip({ tripName: "三亚亲子五日", memo }));
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /分享行程/ }));
    fireEvent.click(screen.getByRole("button", { name: "系统分享…" }));

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

  it("用户取消系统分享（AbortError）不弹任何提示，也不降级复制", async () => {
    setMobile();
    const share = vi.fn(async () => {
      throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    });
    Object.defineProperty(navigator, "share", { configurable: true, value: share });

    renderHead();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /分享行程/ }));
    fireEvent.click(screen.getByRole("button", { name: "系统分享…" }));

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    // 取消不降级到剪贴板
    expect(writeText).not.toHaveBeenCalled();
  });

  it("系统面板报错（非取消）时退回复制链接，不弹失败提示", async () => {
    setMobile();
    const share = vi.fn(async () => {
      throw new Error("NotAllowedError");
    });
    Object.defineProperty(navigator, "share", { configurable: true, value: share });

    renderHead();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /分享行程/ }));
    fireEvent.click(screen.getByRole("button", { name: "系统分享…" }));

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SHARE_URL));
    expect(await screen.findByText("链接已复制")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
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
