/**
 * Task #265：待办清单浮层（TripChecklist）组件测试。
 *
 * 覆盖：tab 切换与计数、按天分组、分类固定顺序、分类空则不渲染、
 * 待办 / 已完成各自的空态、只读（无编辑控件）、浮层互斥与关闭链路。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Constraint, Day, Item, Trip, Visit } from "@goplay/shared";
import { AI_SUPPLEMENT_CHIP_LABEL, AI_SUPPLEMENT_VERIFY_NOTE } from "@goplay/shared";
import { notifySheetOpened, onSheetOpened } from "../lib/sheetBus";
import TripChecklist from "./TripChecklist";

afterEach(cleanup);

function dayDate(dayIndex: number): string {
  return new Date(Date.UTC(2026, 10, 7 + dayIndex)).toISOString().slice(0, 10);
}

function makeDay(dayIndex: number): Day {
  return {
    dayId: `day_${dayIndex}`,
    dayIndex,
    date: dayDate(dayIndex),
    departTime: null,
    departTimeOverridden: false,
    scheduleVisitRefs: [],
    lodging: null,
  };
}

function emptyTrip(dayCount = 2): Trip {
  const days: Record<string, Day> = {};
  const dayRefs: string[] = [];
  for (let dayIndex = 1; dayIndex <= dayCount; dayIndex += 1) {
    const day = makeDay(dayIndex);
    days[day.dayId] = day;
    dayRefs.push(day.dayId);
  }
  return {
    tripId: "trip-checklist",
    schemaVersion: 2,
    version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: dayDate(Math.max(dayCount, 1)), nights: Math.max(dayCount - 1, 0) },
    dayRefs,
    days,
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

function addVisit(
  trip: Trip,
  dayIndex: number,
  name: string,
  purchaseState: Visit["purchaseState"],
): Trip {
  const visitId = `visit_${dayIndex}_${name}`;
  const itemId = `item_${visitId}`;
  const day = trip.days[`day_${dayIndex}`];
  const item: Item = {
    itemId,
    name,
    origin: "fliggy",
    providerId: `pid_${itemId}`,
    address: null,
    category: null,
    coords: null,
    suggestMinutes: null,
    mainPic: null,
    ticketInfo: null,
    jumpUrl: null,
    sourceEvidenceRefs: [],
  };
  const visit: Visit = {
    visitId,
    dayRef: day.dayId,
    pointRef: itemId,
    kind: "ordinary",
    visitMode: "custom",
    order: day.scheduleVisitRefs.length,
    windowStart: null,
    windowEnd: null,
    startTime: null,
    endTime: null,
    startTimeOverridden: false,
    endTimeOverridden: false,
    reservedMinutes: null,
    effectiveMinutes: null,
    externalLeg: null,
    childStopRefs: [],
    alternateStopRefs: [],
    purchaseState,
    locked: false,
    userAdjusted: false,
    removedFrom: null,
    removedAt: null,
  };
  return {
    ...trip,
    visits: { ...trip.visits, [visitId]: visit },
    itemRegistry: { ...trip.itemRegistry, [itemId]: item },
    days: {
      ...trip.days,
      [day.dayId]: { ...day, scheduleVisitRefs: [...day.scheduleVisitRefs, visitId] },
    },
  };
}

function setLodging(
  trip: Trip,
  dayIndex: number,
  purchaseState: "unknown" | "toBuy" | "bought",
  hotelName: string,
): Trip {
  const hotelId = `hotel_${dayIndex}`;
  return {
    ...trip,
    lodgings: {
      ...trip.lodgings,
      [String(dayIndex)]: {
        dayIndex,
        hotelRefs: [hotelId],
        purchaseState,
        locked: false,
        userAdjusted: false,
      },
    },
    hotelRegistry: {
      ...trip.hotelRegistry,
      [hotelId]: {
        id: hotelId,
        shId: hotelId,
        name: hotelName,
        brandName: null,
        star: null,
        priceText: null,
        priceBasis: "价格与库存以飞猪详情页为准",
        address: null,
        interestsPoi: null,
        decorationTime: null,
        coords: null,
        mainPic: null,
        detailUrl: null,
        rate: null,
      },
    },
  };
}

function addFlight(
  trip: Trip,
  dayIndex: number,
  type: "flight_arrive" | "flight_depart",
  label: string,
): Trip {
  const constraint: Constraint = {
    constraintId: `c_${type}_${dayIndex}`,
    type,
    anchorTime: `${dayDate(dayIndex)}T09:40:00`,
    dayIndex,
    label,
    locked: true,
  };
  return { ...trip, constraints: [...trip.constraints, constraint] };
}

/** 待办 / 已完成都有内容的两天行程 */
function mixedTrip(): Trip {
  let trip = emptyTrip(2);
  trip = setLodging(trip, 1, "toBuy", "海棠湾某度假酒店");
  trip = setLodging(trip, 2, "bought", "亚龙湾某酒店");
  trip = addVisit(trip, 1, "蜈支洲岛", "unknown");
  trip = addVisit(trip, 2, "南山文化旅游区", "bought");
  trip = addFlight(trip, 1, "flight_arrive", "MU5831 落地 09:40");
  return trip;
}

/** 全部闭环：待办侧没有任何条目 */
function allDoneTrip(): Trip {
  let trip = emptyTrip(2);
  trip = setLodging(trip, 1, "bought", "海棠湾某度假酒店");
  trip = setLodging(trip, 2, "bought", "亚龙湾某酒店");
  trip = addVisit(trip, 1, "蜈支洲岛", "bought");
  trip = addFlight(trip, 1, "flight_arrive", "MU5831 落地 09:40");
  trip = addFlight(trip, 2, "flight_depart", "MU5832 起飞 18:20");
  return trip;
}

function renderSheet(trip: Trip) {
  const onClose = vi.fn();
  const view = render(<TripChecklist trip={trip} onClose={onClose} />);
  return { ...view, onClose };
}

function tab(name: "待办" | "已完成") {
  return screen.getByRole("tab", { name: new RegExp(`^${name}`) });
}

describe("TripChecklist 待办 / 已完成分组", () => {
  it("默认展示待办：tab 带各自总数，Day 分组、分类顺序为 住宿 → 景点 → 交通", () => {
    renderSheet(mixedTrip());

    const dialog = screen.getByRole("dialog", { name: "待办清单" });
    expect(tab("待办")).toHaveAttribute("aria-selected", "true");
    expect(tab("已完成")).toHaveAttribute("aria-selected", "false");
    // 待办 3 项：Day1 住宿(现场订) + Day1 景点(未确定) + Day2 出发航班待录入
    expect(tab("待办").textContent).toContain("3");
    // 已完成 3 项：Day1 到达航班 + Day2 住宿(已订房) + Day2 景点(已购)
    expect(tab("已完成").textContent).toContain("3");

    const day1 = within(dialog).getByRole("region", { name: "Day 1" });
    const text = day1.textContent ?? "";
    expect(text).toContain("11/08");
    expect(text).toContain("海棠湾某度假酒店");
    expect(text).toContain("现场订");
    expect(text).toContain("蜈支洲岛");
    expect(text).toContain("未确定");
    // 住宿在景点之前（固定分类顺序）
    expect(text.indexOf("住宿")).toBeLessThan(text.indexOf("景点"));
    // Day1 没有待办交通项（到达航班已录入），交通分类整块不渲染
    expect(within(day1).queryByText("交通")).toBeNull();

    const day2 = within(dialog).getByRole("region", { name: "Day 2" });
    expect(day2.textContent).toContain("出发航班");
    expect(day2.textContent).toContain("待录入");
    // Day2 待办里没有景点（景点已购，归到已完成）
    expect(within(day2).queryByText("景点")).toBeNull();
  });

  it("切到已完成：展示已购 / 已订房 / 航班 label，并保留按天分组", () => {
    renderSheet(mixedTrip());

    fireEvent.click(tab("已完成"));
    expect(tab("已完成")).toHaveAttribute("aria-selected", "true");
    expect(tab("待办")).toHaveAttribute("aria-selected", "false");

    const dialog = screen.getByRole("dialog", { name: "待办清单" });
    const day1 = within(dialog).getByRole("region", { name: "Day 1" });
    expect(day1.textContent).toContain("到达航班");
    expect(day1.textContent).toContain("MU5831 落地 09:40");

    const day2 = within(dialog).getByRole("region", { name: "Day 2" });
    expect(day2.textContent).toContain("亚龙湾某酒店");
    expect(day2.textContent).toContain("已订房");
    expect(day2.textContent).toContain("南山文化旅游区");
    expect(day2.textContent).toContain("已购");

    // 切回待办：内容仍是待办那组
    fireEvent.click(tab("待办"));
    expect(
      within(screen.getByRole("dialog", { name: "待办清单" })).queryByText("南山文化旅游区"),
    ).toBeNull();
  });

  it("左右方向键在两组 tab 之间切换", () => {
    renderSheet(mixedTrip());
    fireEvent.keyDown(tab("待办"), { key: "ArrowRight" });
    expect(tab("已完成")).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tab("已完成"), { key: "ArrowLeft" });
    expect(tab("待办")).toHaveAttribute("aria-selected", "true");
  });

  it("待办为空时给出鼓励空态；已完成为空时给出对应空态", () => {
    const { unmount } = renderSheet(allDoneTrip());
    expect(screen.getByText("太棒了，没有待办！")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /^Day/ })).toBeNull();
    unmount();

    renderSheet(emptyTrip(2));
    fireEvent.click(tab("已完成"));
    expect(screen.getByText("还没有已完成的事项")).toBeInTheDocument();
  });

  it("只读：除 tab / 关闭 / 知道了之外没有任何可操作控件", () => {
    const { container } = renderSheet(mixedTrip());

    expect(container.querySelectorAll("input, textarea, select, checkbox")).toHaveLength(0);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    // tab 是 role=tab（不是按钮），可点的只剩头部 ✕ 与底部「知道了」
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.queryAllByRole("button")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "知道了" })).toBeInTheDocument();
  });
});

describe("TripChecklist 浮层行为", () => {
  it("挂载即广播 checklist；其他浮层打开时自关（互斥）", () => {
    const seen: string[] = [];
    const off = onSheetOpened((kind) => seen.push(kind));
    const { onClose } = renderSheet(mixedTrip());

    expect(seen).toContain("checklist");
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      notifySheetOpened("cover");
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    off();
  });

  it("✕ / 「知道了」/ 遮罩 / Esc 都走同一个关闭回调", () => {
    const { onClose } = renderSheet(mixedTrip());

    fireEvent.click(screen.getByRole("button", { name: "关闭待办清单" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(document.querySelector(".proposal-overlay") as Element);
    expect(onClose).toHaveBeenCalledTimes(3);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(4);
  });
});

// ===== Task #283 / C4：待办清单不承载 AI 补充来源标 =====

describe("TripChecklist AI 补充标（Task #283 / C4：清单不展示）", () => {
  /** 把已排期景点标为 AI 补充项：清单是待办视角，不承载来源标（展示范围排除清单） */
  function supplementChecklistTrip(): Trip {
    const trip = mixedTrip();
    const itemId = Object.keys(trip.itemRegistry)[0];
    return {
      ...trip,
      itemRegistry: {
        ...trip.itemRegistry,
        [itemId]: { ...trip.itemRegistry[itemId], provenance: "ai_supplement" },
      },
    };
  }

  it("补充项在待办清单不渲染 AI 补充 chip 与核验文案", () => {
    renderSheet(supplementChecklistTrip());

    expect(document.querySelector(".ai-supplement-chip")).toBeNull();
    expect(document.querySelector(".ai-supplement-note")).toBeNull();
    expect(screen.queryByText(AI_SUPPLEMENT_CHIP_LABEL)).toBeNull();
    expect(screen.queryByText(AI_SUPPLEMENT_VERIFY_NOTE)).toBeNull();
  });
});
