/**
 * Task #265：待办清单盘点纯函数单测。
 *
 * 口径（与主行程购买状态文案一致）：
 * - 酒店：unknown / toBuy → 待办，bought → 已完成；没有 plan 或 hotelRefs 为空 → 「未安排」；
 * - 景点：unknown / toBuy → 待办，bought / noTicket → 已完成；
 * - 航班：首日缺 flight_arrive / 末日缺 flight_depart → 「待录入」；已录入按约束 label 进已完成；
 * - 某天某分类无条目时该分类为空，整天无条目则整天不进入分组。
 */

import { describe, expect, it } from "vitest";
import type { Constraint, Day, Item, Trip, Visit } from "@goplay/shared";
import {
  buildTripChecklist,
  checklistCount,
  dayCheckCount,
  isDayEmpty,
  LODGING_STATUS_LABEL,
  VISIT_STATUS_LABEL,
  type DayCheckItems,
} from "./tripChecklist";

/** 2026-11-08 起第 index 天（dayIndex 从 1 开始） */
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

/** 没有任何住宿 / 景点 / 航班的基础行程 */
function emptyTrip(dayCount = 3): Trip {
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

/** 往某天排入一个景点（主数据同步建） */
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

/** 某天住宿：hotelName 为 null = 有 plan 但 hotelRefs 为空（连候选都没选） */
function setLodging(
  trip: Trip,
  dayIndex: number,
  purchaseState: "unknown" | "toBuy" | "bought",
  hotelName: string | null,
): Trip {
  const hotelId = hotelName !== null ? `hotel_${dayIndex}` : null;
  return {
    ...trip,
    lodgings: {
      ...trip.lodgings,
      [String(dayIndex)]: {
        dayIndex,
        hotelRefs: hotelId !== null ? [hotelId] : [],
        purchaseState,
        locked: false,
        userAdjusted: false,
      },
    },
    hotelRegistry:
      hotelId !== null && hotelName !== null
        ? {
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
          }
        : trip.hotelRegistry,
  };
}

/** 录入一条航班约束 */
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

function pickDay(days: DayCheckItems[], dayIndex: number): DayCheckItems | undefined {
  return days.find((day) => day.dayIndex === dayIndex);
}

describe("buildTripChecklist 分类口径", () => {
  it("没有住宿计划的天进待办「未安排」，首末日缺航班各一条待录入", () => {
    const { pending, done } = buildTripChecklist(emptyTrip(3));

    const day1 = pickDay(pending, 1);
    expect(day1?.hotels).toEqual([
      expect.objectContaining({ name: "住宿待安排", status: "missing", statusLabel: "未安排" }),
    ]);
    // Day1 = 首日：到达航班待录入（出发航班只看末日，所以 Day1 没有出发项）
    expect(day1?.transport).toEqual([
      expect.objectContaining({ name: "到达航班", statusLabel: "待录入", category: "transport" }),
    ]);
    expect(day1?.attractions).toEqual([]);

    const day3 = pickDay(pending, 3);
    expect(day3?.transport).toEqual([
      expect.objectContaining({ name: "出发航班", statusLabel: "待录入" }),
    ]);

    // 中间天只有住宿待办，没有任何航班条目
    const day2 = pickDay(pending, 2);
    expect(day2?.transport).toEqual([]);
    expect(day2?.hotels).toHaveLength(1);

    expect(done).toEqual([]);
    expect(checklistCount(pending)).toBe(5);
  });

  it("酒店三档：未确定 / 现场订进待办，已订房进已完成；hotelRefs 为空仍算未安排", () => {
    let trip = emptyTrip(3);
    trip = setLodging(trip, 1, "unknown", "海棠湾某度假酒店");
    trip = setLodging(trip, 2, "toBuy", "亚龙湾某酒店");
    trip = setLodging(trip, 3, "bought", "三亚湾某酒店");
    // 覆盖 Day1 住宿计划为空候选：hotelRefs = [] 时即使 purchaseState 已订也视为未安排
    const withoutCandidates = setLodging(trip, 1, "bought", null);

    const normal = buildTripChecklist(trip);
    expect(pickDay(normal.pending, 1)?.hotels[0]).toEqual(
      expect.objectContaining({ name: "海棠湾某度假酒店", statusLabel: "未确定" }),
    );
    expect(pickDay(normal.pending, 2)?.hotels[0]).toEqual(
      expect.objectContaining({ name: "亚龙湾某酒店", statusLabel: "现场订" }),
    );
    expect(pickDay(normal.pending, 3)?.hotels ?? []).toEqual([]);
    expect(pickDay(normal.done, 3)?.hotels[0]).toEqual(
      expect.objectContaining({ name: "三亚湾某酒店", statusLabel: "已订房", status: "bought" }),
    );

    const emptyCandidates = buildTripChecklist(withoutCandidates);
    expect(pickDay(emptyCandidates.pending, 1)?.hotels[0]).toEqual(
      expect.objectContaining({ name: "住宿待安排", status: "missing" }),
    );
  });

  it("景点四态：未确定 / 现场买进待办，已购 / 无需购票进已完成", () => {
    let trip = emptyTrip(2);
    trip = addVisit(trip, 1, "蜈支洲岛", "unknown");
    trip = addVisit(trip, 1, "后海村", "toBuy");
    trip = addVisit(trip, 2, "南山文化旅游区", "bought");
    trip = addVisit(trip, 2, "天涯海角", "noTicket");

    const { pending, done } = buildTripChecklist(trip);
    expect(pickDay(pending, 1)?.attractions.map((item) => [item.name, item.statusLabel])).toEqual([
      ["蜈支洲岛", "未确定"],
      ["后海村", "现场买"],
    ]);
    expect(pickDay(done, 2)?.attractions.map((item) => [item.name, item.statusLabel])).toEqual([
      ["南山文化旅游区", "已购"],
      ["天涯海角", "无需购票"],
    ]);
    // 分类内保持排期顺序
    expect(pickDay(pending, 1)?.attractions.map((item) => item.name)).toEqual(["蜈支洲岛", "后海村"]);
  });

  it("航班按 dayIndex 归天：已录入进已完成，状态文案取约束 label，空 label 兜底", () => {
    let trip = emptyTrip(3);
    trip = addFlight(trip, 1, "flight_arrive", "MU5831 落地 09:40");
    trip = addFlight(trip, 3, "flight_depart", "");

    const { pending, done } = buildTripChecklist(trip);

    expect(pickDay(done, 1)?.transport[0]).toEqual(
      expect.objectContaining({
        name: "到达航班",
        status: "flight",
        statusLabel: "MU5831 落地 09:40",
      }),
    );
    expect(pickDay(done, 3)?.transport[0]).toEqual(
      expect.objectContaining({ name: "出发航班", statusLabel: "已录入" }),
    );
    // 已录入 → 首末日不再产生待录入
    expect(pickDay(pending, 1)?.transport ?? []).toEqual([]);
    expect(pickDay(pending, 3)?.transport ?? []).toEqual([]);
  });

  it("单天行程：到达与出发两条待录入落在同一天", () => {
    const { pending } = buildTripChecklist(emptyTrip(1));
    const only = pickDay(pending, 1);
    expect(only?.transport.map((item) => item.name)).toEqual(["到达航班", "出发航班"]);
  });

  it("中间天的航班约束按天展示，不会替首末日的待录入消账", () => {
    let trip = emptyTrip(3);
    trip = addFlight(trip, 2, "flight_arrive", "HO1123 落地 14:00");

    const { pending, done } = buildTripChecklist(trip);
    expect(pickDay(done, 2)?.transport[0]?.statusLabel).toBe("HO1123 落地 14:00");
    // 首日仍缺到达航班、末日仍缺出发航班
    expect(pickDay(pending, 1)?.transport[0]?.statusLabel).toBe("待录入");
    expect(pickDay(pending, 3)?.transport[0]?.statusLabel).toBe("待录入");
  });

  it("全部闭环的天不进待办分组；全天无内容也不出现在已完成", () => {
    let trip = emptyTrip(3);
    trip = setLodging(trip, 2, "bought", "亚龙湾某酒店");
    trip = addFlight(trip, 1, "flight_arrive", "MU5831 落地 09:40");
    trip = addFlight(trip, 3, "flight_depart", "MU5832 起飞 18:20");

    const { pending, done } = buildTripChecklist(trip);
    // Day2：住宿已订 + 无景点 + 无航班 → 待办里没有 Day2
    expect(pickDay(pending, 2)).toBeUndefined();
    // Day2 只出现在已完成（住宿）
    expect(pickDay(done, 2)?.hotels[0]?.statusLabel).toBe("已订房");
    expect(pickDay(done, 2)?.attractions).toEqual([]);
    // Day1 仍有「住宿未安排」待办
    expect(pickDay(pending, 1)?.hotels[0]?.status).toBe("missing");
  });

  it("空行程（没有任何天）两组都为空", () => {
    expect(buildTripChecklist(emptyTrip(0))).toEqual({ pending: [], done: [] });
  });
});

describe("清单计数与工具", () => {
  it("dayCheckCount / checklistCount / isDayEmpty 口径一致", () => {
    const empty = { dayIndex: 1, date: "2026-11-08", hotels: [], attractions: [], transport: [] };
    expect(isDayEmpty(empty)).toBe(true);
    expect(dayCheckCount(empty)).toBe(0);

    let trip = emptyTrip(2);
    trip = addVisit(trip, 1, "蜈支洲岛", "bought");
    const { done } = buildTripChecklist(trip);
    const day1 = pickDay(done, 1)!;
    expect(isDayEmpty(day1)).toBe(false);
    expect(dayCheckCount(day1)).toBe(1);
    expect(checklistCount(done)).toBe(dayCheckCount(day1));
    // 已购景点 → 待办侧只剩两天的「住宿未安排」与首末日「航班待录入」：2 + 2 = 4
    expect(checklistCount(buildTripChecklist(trip).pending)).toBe(4);
  });

  it("文案映射与主行程一致（景点四态 / 酒店三态）", () => {
    expect(VISIT_STATUS_LABEL).toEqual({
      unknown: "未确定",
      toBuy: "现场买",
      bought: "已购",
      noTicket: "无需购票",
    });
    expect(LODGING_STATUS_LABEL).toEqual({ unknown: "未确定", toBuy: "现场订", bought: "已订房" });
  });
});
