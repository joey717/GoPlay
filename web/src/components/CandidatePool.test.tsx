import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Trip } from "@goplay/shared";
import CandidatePool from "./CandidatePool";
import { searchHotels, searchPoi, type PoiSearchResult } from "../api/client";

vi.mock("../api/client", async (importOriginal) => {
  // 保留 ApiError / flyAiErrorMessage 等真实实现，仅桩掉网络函数
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    searchPoi: vi.fn(),
    searchHotels: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/**
 * Task #330：候选池「飞猪搜索结果卡」的元信息展示口径。
 * 搜索结果卡直接读取 FliggyPoi 字段（poi.poiLevel / poi.listRank），复用 PoiMeta 组件：
 * ① poiLevel → 4A/5A 徽标（.n 内 .tag.poi-level，与「景点/免票」tag 同排）；
 * ② listRank → 名称下方 .poi-rank 暖色 chip（有则显示、无则完全不占位）；
 * ③ Task #329/#330 D：购物名场所在 UNKNOWN + category=null 下经名称通道判免费（免票标签）。
 */

function makePoi(extra: Partial<PoiSearchResult> = {}): PoiSearchResult {
  return {
    id: "poi_1",
    name: "西岛",
    address: "三亚市天涯区",
    category: "沙滩海岛",
    description: null,
    freePoiStatus: null,
    poiLevel: null,
    coords: null,
    mainPic: null,
    listRank: null,
    ticketInfo: null,
    jumpUrl: null,
    ...extra,
  };
}

function poiEnvelope(normalized: PoiSearchResult[]) {
  return {
    raw: {},
    normalized,
    toolName: "search_poi",
    params: {},
    capturedAt: "2026-11-01T00:00:00Z",
    latencyMs: 1,
    integrationPath: "cli" as const,
  };
}

function emptyHotelEnvelope() {
  return {
    raw: {},
    normalized: [],
    toolName: "search_hotel",
    params: {},
    capturedAt: "2026-11-01T00:00:00Z",
    latencyMs: 1,
    integrationPath: "cli" as const,
  };
}

function makeTrip(): Trip {
  return {
    tripId: "trip-pool",
    schemaVersion: 2,
    version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: "2026-11-09", nights: 1 },
    dayRefs: ["day_1"],
    days: {
      day_1: {
        dayId: "day_1",
        dayIndex: 1,
        date: "2026-11-08",
        departTime: null,
        departTimeOverridden: false,
        scheduleVisitRefs: [],
        lodging: null,
      },
    },
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
  } as unknown as Trip;
}

function renderPool() {
  render(
    <CandidatePool
      open
      trip={makeTrip()}
      currentDayIndex={1}
      onClose={vi.fn()}
      onAddToPool={vi.fn()}
      onSelectHotel={vi.fn()}
      onAddToDay={vi.fn()}
      onDeleteFromPool={vi.fn()}
      onAttachPendingStop={vi.fn()}
      onRestoreStop={vi.fn()}
    />,
  );
}

/** 输入关键词并点击「搜索」，等待结果卡出现 */
async function search(term: string): Promise<void> {
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: term } });
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  await waitFor(() => {
    expect(document.querySelector(".poolitem")).not.toBeNull();
  });
}

beforeEach(() => {
  vi.mocked(searchHotels).mockResolvedValue(emptyHotelEnvelope());
});

describe("CandidatePool 搜索结果卡飞猪元信息（任务 330）", () => {
  it("poiLevel=\"4\" + listRank：结果卡渲染 4A 徽标（.n 内 .tag.poi-level）+ 榜单 chip", async () => {
    vi.mocked(searchPoi).mockResolvedValue(
      poiEnvelope([makePoi({ poiLevel: "4", listRank: "海南4A/5A景点榜第2名" })]),
    );
    renderPool();
    await search("西岛");

    const item = document.querySelector(".poolitem");
    expect(item?.querySelector(".n .tag.poi-level")?.textContent).toBe("4A");
    expect(item?.querySelector(".poi-rank-text")?.textContent).toBe("海南4A/5A景点榜第2名");
    expect(item?.querySelector(".poi-rank-icon")?.textContent).toBe("🏆");
  });

  it("poiLevel 无法识别（3A）+ listRank 缺失：不渲染徽标、不渲染榜单 chip（不占位、不输出脏值）", async () => {
    vi.mocked(searchPoi).mockResolvedValue(poiEnvelope([makePoi({ poiLevel: "3A" })]));
    renderPool();
    await search("西岛");

    const item = document.querySelector(".poolitem");
    expect(item?.querySelector(".poi-level")).toBeNull();
    expect(item?.querySelector(".poi-rank")).toBeNull();
    expect(screen.queryByText("3A")).toBeNull();
  });

  it("Task #330 D：国际免税城在 UNKNOWN + category=null 下经名称通道判免费（结果卡出「免票」标签）", async () => {
    vi.mocked(searchPoi).mockResolvedValue(
      poiEnvelope([
        makePoi({
          id: "199649345",
          name: "中免集团·三亚国际免税城",
          category: null,
          freePoiStatus: "UNKNOWN",
          jumpUrl: "https://router.feizhu.com/x",
        }),
      ]),
    );
    renderPool();
    await search("国际免税城");

    expect(document.querySelector(".poolitem .n .tag.slate")?.textContent).toBe("免票");
  });
});

/**
 * Task #343（2026-11-04 PD 拍板）：候选池三区的「建议 X 小时/分钟」时长 chip 也一并隐藏。
 * 与行程页 / 分享页同源 AI 推导时长口径一致，复用 web/src/lib/displayFlags.ts 的
 * SHOW_ESTIMATED_TIMES 开关（当前 false），渲染代码保留不删。
 *
 * 开关打开时的恢复断言见 web/src/lib/displayFlags.flagOn.test.tsx。
 * 注：CandidatePool 当前无挂载点（TripView 候选池抽屉入口已移除，组件保留待面板
 * 融入时复用），本组用例锁的是组件自身渲染口径。
 */

function makePoolItem(itemId: string, name: string, suggestMinutes: number | null) {
  return {
    itemId,
    name,
    origin: "fliggy",
    providerId: `provider_${itemId}`,
    address: "三亚市",
    category: "海岛",
    coords: null,
    suggestMinutes,
    mainPic: null,
    ticketInfo: null,
    jumpUrl: null,
    sourceEvidenceRefs: [],
  };
}

function makePoolStop(
  stopId: string,
  customName: string,
  suggestMinutes: number | null,
  extra: Record<string, unknown> = {},
) {
  return {
    stopId,
    state: "attached",
    visitRef: "visit_parent",
    suggestedVisitRef: null,
    matchedPointRef: null,
    customName,
    order: 0,
    suggestMinutes,
    locationHint: null,
    ticketRelation: "unknown",
    sourceEvidenceRefs: [],
    sourceMentionRefs: [],
    userAdjusted: false,
    removedFromOrder: null,
    removedAt: null,
    ...extra,
  };
}

/**
 * 三区都有内容且每区都带建议时长的行程：
 * 区一候选区 1 点位（120min → "建议 2h"）、区二待定加入 1 玩法（45min → "建议 45min"）、
 * 区三备选玩法 1 项（90min → "建议 1.5h"）——开关关闭时三者均不得出现。
 */
function makePoolTrip(): Trip {
  return {
    ...makeTrip(),
    itemRegistry: {
      item_pool: makePoolItem("item_pool", "西岛", 120),
      item_parent: makePoolItem("item_parent", "蜈支洲岛", 180),
    },
    globalCandidateRefs: [{ kind: "point", id: "item_pool" }],
    pendingStopRefs: ["stop_pending"],
    visits: {
      visit_parent: {
        visitId: "visit_parent",
        dayRef: "day_1",
        pointRef: "item_parent",
        kind: "large_attraction",
        visitMode: "full_day",
        order: 0,
        windowStart: null,
        windowEnd: null,
        startTime: "09:00",
        endTime: null,
        startTimeOverridden: false,
        endTimeOverridden: false,
        reservedMinutes: null,
        effectiveMinutes: 210,
        externalLeg: null,
        childStopRefs: [],
        alternateStopRefs: ["stop_alt"],
        purchaseState: "unknown",
        locked: false,
        userAdjusted: false,
        removedFrom: null,
        removedAt: null,
      },
    },
    stops: {
      stop_pending: makePoolStop("stop_pending", "潜水", 45, {
        state: "pending",
        visitRef: null,
        suggestedVisitRef: "visit_parent",
        order: null,
      }),
      stop_alt: makePoolStop("stop_alt", "情人桥", 90),
    },
  } as unknown as Trip;
}

function renderPoolTrip() {
  render(
    <CandidatePool
      open
      trip={makePoolTrip()}
      currentDayIndex={1}
      onClose={vi.fn()}
      onAddToPool={vi.fn()}
      onSelectHotel={vi.fn()}
      onAddToDay={vi.fn()}
      onDeleteFromPool={vi.fn()}
      onAttachPendingStop={vi.fn()}
      onRestoreStop={vi.fn()}
    />,
  );
}

/** 名称元素 → 所属候选行（避开搜索结果区的同名选择器） */
function rowOf(name: string): Element | null {
  return screen.getByText(name).closest(".poolitem");
}

describe("CandidatePool 三区「建议 X」时长 chip（Task #343 开关关闭口径）", () => {
  it("区一候选区：时长 chip 不渲染（metaParts 清空后 .m 整行不占位），名称与操作按钮保留", () => {
    renderPoolTrip();

    const row = rowOf("西岛");
    expect(row).not.toBeNull();
    // 原断言：.m 文本含「建议 2h」（item_pool.suggestMinutes=120）。
    // Task #343 改为开关关闭口径：本行唯一 chip 就是时长，被 gate 后 .m 整行不渲染
    //（恢复断言见 displayFlags.flagOn.test.tsx）
    expect(row?.querySelector(".m")).toBeNull();
    expect(row?.textContent).not.toMatch(/建议/);
    // 名称与「添加到 DayN」入口不受影响
    expect(row?.querySelector(".n")?.textContent).toBe("西岛");
    expect(screen.getByRole("button", { name: "添加到 Day1" })).toBeInTheDocument();
    expect(screen.getByText("候选区（1）")).toBeInTheDocument();
  });

  it("区二待定加入：时长 chip 不渲染，归属语义（可能属于「X」）保留", () => {
    renderPoolTrip();

    const row = rowOf("潜水");
    expect(row).not.toBeNull();
    // 原断言：.m 文本为「建议 45min · 可能属于「蜈支洲岛」」。
    // Task #343 改为开关关闭口径：时长段被 gate，归属语义保留，.m 行不会变空
    expect(row?.querySelector(".m")?.textContent).toBe("可能属于「蜈支洲岛」");
    expect(row?.textContent).not.toMatch(/建议/);
    expect(screen.getByRole("button", { name: "归类" })).toBeInTheDocument();
  });

  it("区三备选玩法：展开后时长 chip 不渲染（.reserve-meta 整行不占位），名称与「放回」保留", () => {
    renderPoolTrip();

    // 备选玩法区默认收起，点「查看」展开
    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    const item = document.querySelector(".reserve-item");
    expect(item).not.toBeNull();
    // 原断言：.reserve-meta 文本为「建议 1.5h」（stop_alt.suggestMinutes=90）
    expect(item?.querySelector(".reserve-meta")).toBeNull();
    expect(item?.textContent).not.toMatch(/建议/);
    expect(item?.querySelector(".reserve-name")?.textContent).toBe("情人桥");
    expect(screen.getByRole("button", { name: "放回" })).toBeInTheDocument();
    // 区头计数与说明保留
    expect(screen.getByText("备选玩法（1 个景区）")).toBeInTheDocument();
    expect(screen.getByText("备选玩法 1 项")).toBeInTheDocument();
  });

  it("全池不出现任何「建议 X 小时/分钟」时长文本（三区展开后全文扫描）", () => {
    renderPoolTrip();

    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    expect(document.body.textContent).not.toMatch(/建议\s*\d+(\.\d+)?\s*(h|min|小时|分钟)/);
    // 哨兵：夹具本身确实带时长数据（否则上面一条断言会是空跑）
    expect(makePoolTrip().stops.stop_alt.suggestMinutes).toBe(90);
  });
});
