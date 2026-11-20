import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Day, Item, Trip, Visit } from "@goplay/shared";
import DayStrip from "./DayStrip";

afterEach(cleanup);

/**
 * Task #344（PD：「目前发现每个大景区都标了『全天』在景区名字下面的标、
 * 以及 DAY N 里都有，把『全天』二字去掉」）。
 *
 * 「DAY N 里」= 本组件的 Day 横向切换条 .dchip .flag（原形态「鹿回头 · 全天」）。
 * 去掉「全天」后只剩景区名，不得留下悬空的「· 」分隔符；「半天」「自定义」保留。
 * 无大景区的天仍按站数（「N 站」/「空」）展示，不受影响。
 *
 * 仅展示层去字：visitMode 数据与 shared 的 dayRoles 推导一律未动。
 */
function makeItem(overrides: Partial<Item> & Pick<Item, "itemId" | "name">): Item {
  return {
    origin: "fliggy",
    providerId: null,
    address: null,
    category: null,
    coords: null,
    suggestMinutes: null,
    mainPic: null,
    ticketInfo: null,
    jumpUrl: null,
    sourceEvidenceRefs: [],
    ...overrides,
  };
}

function makeVisit(overrides: Partial<Visit> & Pick<Visit, "visitId" | "pointRef">): Visit {
  return {
    dayRef: "day_1",
    kind: "ordinary",
    visitMode: "custom",
    order: 0,
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
    sourceMentionRefs: [],
    guideSnippets: [],
    purchaseState: "unknown",
    locked: false,
    userAdjusted: false,
    removedFrom: null,
    removedAt: null,
    ...overrides,
  };
}

function makeDay(overrides: Partial<Day> & Pick<Day, "dayId" | "dayIndex" | "date">): Day {
  return {
    departTime: null,
    departTimeOverridden: false,
    scheduleVisitRefs: [],
    lodging: null,
    ...overrides,
  };
}

/** 三天夹具：Day1 大景区 full_day / Day2 大景区 half_day / Day3 两个普通景点 + 一天空 */
function makeTrip(visitMode: Visit["visitMode"]): Trip {
  const days: Record<string, Day> = {
    day_1: makeDay({ dayId: "day_1", dayIndex: 1, date: "2026-11-08", scheduleVisitRefs: ["visit_large"] }),
    day_2: makeDay({ dayId: "day_2", dayIndex: 2, date: "2026-11-09", scheduleVisitRefs: ["visit_half"] }),
    day_3: makeDay({
      dayId: "day_3",
      dayIndex: 3,
      date: "2026-11-10",
      scheduleVisitRefs: ["visit_a", "visit_b"],
    }),
    day_4: makeDay({ dayId: "day_4", dayIndex: 4, date: "2026-11-11" }),
  };
  return {
    tripId: "trip-test",
    schemaVersion: 2,
    version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: "2026-11-11", nights: 3 },
    dayRefs: ["day_1", "day_2", "day_3", "day_4"],
    days,
    lodgings: {},
    itemRegistry: {
      item_luhuitou: makeItem({ itemId: "item_luhuitou", name: "鹿回头" }),
      item_tianya: makeItem({ itemId: "item_tianya", name: "天涯海角" }),
      item_a: makeItem({ itemId: "item_a", name: "第一市场" }),
      item_b: makeItem({ itemId: "item_b", name: "后海村" }),
    },
    hotelRegistry: {},
    visits: {
      visit_large: makeVisit({
        visitId: "visit_large",
        pointRef: "item_luhuitou",
        dayRef: "day_1",
        kind: "large_attraction",
        visitMode,
      }),
      visit_half: makeVisit({
        visitId: "visit_half",
        pointRef: "item_tianya",
        dayRef: "day_2",
        kind: "large_attraction",
        visitMode: "half_day",
      }),
      visit_a: makeVisit({ visitId: "visit_a", pointRef: "item_a", dayRef: "day_3", order: 0 }),
      visit_b: makeVisit({ visitId: "visit_b", pointRef: "item_b", dayRef: "day_3", order: 1 }),
    },
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

/** 按 Day 序号取 .dchip 内 .flag 文本（1-based） */
function flags(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".dchip .flag")].map((el) => el.textContent ?? "");
}

describe("DayStrip Day 切换条去掉「全天」（Task #344）", () => {
  it("full_day：含大景区的天只剩景区名，无悬空「· 」，整条不出现「全天」", () => {
    const { container } = render(<DayStrip trip={makeTrip("full_day")} currentDay={1} onSelect={vi.fn()} />);

    expect(flags(container)[0]).toBe("鹿回头");
    expect(flags(container)[0]).not.toContain("·");
    expect(container.textContent).not.toContain("全天");
    expect(screen.queryByText("全天")).toBeNull();
  });

  it("half_day 保留：同形态标签仍为「景区名 · 半天」（只去掉「全天」一个取值）", () => {
    const { container } = render(<DayStrip trip={makeTrip("half_day")} currentDay={1} onSelect={vi.fn()} />);

    expect(flags(container)[0]).toBe("鹿回头 · 半天");
    // Day2 的 half_day 大景区不受本次改动影响
    expect(flags(container)[1]).toBe("天涯海角 · 半天");
  });

  it("custom 保留：同形态标签为「景区名 · 自定义」", () => {
    const { container } = render(<DayStrip trip={makeTrip("custom")} currentDay={1} onSelect={vi.fn()} />);

    expect(flags(container)[0]).toBe("鹿回头 · 自定义");
  });

  it("其他天不受影响：无大景区的天仍显示站数，空天仍显示「空」；日期行与选中态保留", () => {
    const onSelect = vi.fn();
    const { container } = render(<DayStrip trip={makeTrip("full_day")} currentDay={2} onSelect={onSelect} />);

    // Day3 两个普通景点 → 「2 站」；Day4 无内容 → 「空」
    expect(flags(container)).toEqual(["鹿回头", "天涯海角 · 半天", "2 站", "空"]);

    const chips = [...container.querySelectorAll(".dchip")];
    expect(chips).toHaveLength(4);
    // 日期与序号仍在（去掉 mode 段没有连带删掉 .d / .w）
    expect(chips[0].querySelector(".d")?.textContent).toBe("Day1");
    expect(chips[0].querySelector(".w")?.textContent).toBe("11/08 周日");
    // 当前天选中态仍落在 currentDay=2
    expect(chips[1].className).toContain("on");
    expect(chips[0].className).not.toContain("on");
    // 点击仍回调 onSelect（交互未回归）
    fireEvent.click(chips[2]);
    expect(onSelect).toHaveBeenCalledWith(3);
  });
});
