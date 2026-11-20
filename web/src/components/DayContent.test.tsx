/**
 * Task #281 S5：时间来源标签限场景展示 DOM 断言。
 *
 * Task #340（2026-11-03）：SHOW_ESTIMATED_TIMES=false 时，带具体时间（HH:MM）的
 * 来源灰字（如"按你的到达航班 09:40 算"）属估算时间来源徽标，不渲染；
 * 不带时间的语义标签（"你设定" / "按回程航班倒推…"）保留。
 * 原「抵达日显示航班推算灰字」与「编辑态灰字」断言改为开关关闭口径；
 * 开关打开时的恢复性断言见 DayContent.flagOn.test.tsx（原断言原样迁移）。
 *
 * 验证四状态（开关关闭口径）：
 * 1. 抵达日带时间的灰字不渲染（Task #340）
 * 2. 返程日不带时间的灰字仍显示"按回程航班倒推，当天只排机场附近"
 * 3. 时间编辑态：带时间灰字不渲染，不带时间灰字仍可见
 * 4. 手改后"你设定"仅该 Day 时间行（不带时间，保留）
 * 5. 普通日不显示（无 .anchor-src 元素）
 * 6. 不出现全局角标（dayhead / 非 anchor 区域无来源文案）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Constraint, Day, Trip } from "@goplay/shared";
import { recomputeDerivedFields } from "@goplay/shared";
import DayContent from "./DayContent";

afterEach(cleanup);

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

// ===== 最小 Trip 构建 =====

function makeDay(dayIndex: number, overrides: Partial<Day> = {}): Day {
  return {
    dayId: `day_${dayIndex}`,
    dayIndex,
    date: `2026-11-${String(dayIndex).padStart(2, "0")}`,
    departTime: "09:00",
    departTimeOverridden: false,
    scheduleVisitRefs: [],
    lodging: null,
    ...overrides,
  };
}

function makeConstraint(type: Constraint["type"], dayIndex: number, anchorTime: string): Constraint {
  return {
    constraintId: `c_${type}_${dayIndex}`,
    type,
    anchorTime,
    dayIndex,
    label: `${type} day${dayIndex}`,
    locked: true,
  };
}

function makeTrip(dayCount: number, constraints: Constraint[], dayOverrides: Record<number, Partial<Day>> = {}): Trip {
  const dayRefs: string[] = [];
  const days: Record<string, Day> = {};
  for (let i = 1; i <= dayCount; i++) {
    dayRefs.push(`day_${i}`);
    days[`day_${i}`] = makeDay(i, dayOverrides[i] ?? {});
  }
  const trip = {
    tripId: "trip_test_s5",
    schemaVersion: 2,
    version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: `2026-11-${String(7 + dayCount).padStart(2, "0")}`, nights: dayCount - 1 },
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
    constraints,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
  } as unknown as Trip;
  // 派生字段写入（模拟服务端 save/load 路径）
  recomputeDerivedFields(trip);
  return trip;
}

const noop = () => {};

function renderDay(trip: Trip, dayIndex: number) {
  const day = trip.days[`day_${dayIndex}`];
  return render(
    <DayContent
      trip={trip}
      day={day}
      onOpenNoteInput={noop}
      onRemoveVisit={noop}
      onBatchRemove={noop}
      onPurchaseSelect={noop}
      onToggleLock={noop}
      onLodgingPurchaseSelect={noop}
      onToggleLodgingLock={noop}
      onUpdateDepart={noop}
      onReorderDayItems={noop}
      onMoveDayItem={noop}
      onMoveStop={noop}
      onRemoveStop={noop}
      onRestoreStop={noop}
      onAddStop={noop}
      onSearchHotels={noop}
      onRemoveHotel={noop}
    />,
  );
}

// ===== 测试 =====

describe("S5 时间来源标签限场景展示（Task #340 开关关闭口径）", () => {
  it("抵达日带具体时间的航班推算灰字不渲染（Task #340：估算时间来源徽标隐藏）", () => {
    const trip = makeTrip(3, [makeConstraint("flight_arrive", 1, "2026-11-08T09:40:00")]);
    const { container } = renderDay(trip, 1);
    // 原断言：.anchor-src 存在且文案为"按你的到达航班 09:40 算"（见 flagOn 用例）；
    // 开关关闭后带时间标签隐藏；出发时间本体（约束推导、可手改）仍保留
    const src = container.querySelector(".anchor-src");
    expect(src).toBeNull();
    const time = container.querySelector(".anchor-time");
    expect(time).not.toBeNull();
    expect(time!.textContent).toBe("09:00");
  });

  it("返程日不带具体时间的倒推灰字保留（Task #340：无时间语义标签不在隐藏范围）", () => {
    const trip = makeTrip(3, [makeConstraint("flight_depart", 3, "2026-11-10T18:00:00")]);
    const { container } = renderDay(trip, 3);
    const src = container.querySelector(".anchor-src");
    expect(src).not.toBeNull();
    expect(src!.textContent).toBe("按回程航班倒推，当天只排机场附近");
  });

  it("手改后显示'你设定'（不带时间，保留）", () => {
    const trip = makeTrip(2, [makeConstraint("flight_arrive", 1, "2026-11-08T09:40:00")], {
      1: { departTimeOverridden: true },
    });
    const { container } = renderDay(trip, 1);
    const src = container.querySelector(".anchor-src");
    expect(src).not.toBeNull();
    expect(src!.textContent).toBe("你设定");
  });

  it("普通日不显示灰字（无 .anchor-src 元素）", () => {
    const trip = makeTrip(3, [makeConstraint("flight_arrive", 1, "2026-11-08T09:40:00")]);
    const { container } = renderDay(trip, 2);
    const src = container.querySelector(".anchor-src");
    expect(src).toBeNull();
  });

  it("编辑态：带时间灰字不渲染（Task #340），输入框本体保留", () => {
    const trip = makeTrip(3, [makeConstraint("flight_arrive", 1, "2026-11-08T09:40:00")]);
    const { container } = renderDay(trip, 1);
    // 点击「改」进入编辑态
    const editBtn = container.querySelector(".anchor-edit-btn") as HTMLButtonElement;
    fireEvent.click(editBtn);
    // 原断言：.editing-hint 灰字为"按你的到达航班 09:40 算"（见 flagOn 用例）；开关关闭后隐藏
    const hint = container.querySelector(".anchor-src.editing-hint");
    expect(hint).toBeNull();
    // 用户编辑入口（约束时间类）不受开关影响
    expect(container.querySelector(".depart-input")).not.toBeNull();
  });

  it("编辑态普通日无灰字", () => {
    const trip = makeTrip(3, []);
    const { container } = renderDay(trip, 2);
    const editBtn = container.querySelector(".anchor-edit-btn") as HTMLButtonElement;
    fireEvent.click(editBtn);
    const hint = container.querySelector(".anchor-src.editing-hint");
    expect(hint).toBeNull();
  });

  it("不出现全局角标：dayhead 区域无来源文案", () => {
    const trip = makeTrip(3, [
      makeConstraint("flight_arrive", 1, "2026-11-08T09:40:00"),
      makeConstraint("flight_depart", 3, "2026-11-10T18:00:00"),
    ]);
    const { container } = renderDay(trip, 1);
    // dayhead 内不应有来源标签文案
    const dayhead = container.querySelector(".dayhead");
    expect(dayhead).not.toBeNull();
    expect(dayhead!.textContent).not.toContain("按你的到达航班");
    expect(dayhead!.textContent).not.toContain("你设定");
    expect(dayhead!.textContent).not.toContain("按回程航班倒推");
    // 全局无 .global-badge 或类似角标元素
    expect(container.querySelector(".global-badge")).toBeNull();
    expect(container.querySelector(".time-source-badge")).toBeNull();
  });
});

// Task #354：当天无片区时「看酒店 ›」必须传 null，不再回退城市名（城市名会被服务端判为未知片区而 400）
describe("Task #354 看酒店片区入参", () => {
  function renderDayWithSpy(trip: Trip, dayIndex: number, onSearchHotels: (d: number, a: string | null) => void) {
    const day = trip.days[`day_${dayIndex}`];
    return render(
      <DayContent
        trip={trip}
        day={day}
        onOpenNoteInput={noop}
        onRemoveVisit={noop}
        onBatchRemove={noop}
        onPurchaseSelect={noop}
        onToggleLock={noop}
        onLodgingPurchaseSelect={noop}
        onToggleLodgingLock={noop}
        onUpdateDepart={noop}
        onReorderDayItems={noop}
        onMoveDayItem={noop}
        onMoveStop={noop}
        onRemoveStop={noop}
        onRestoreStop={noop}
        onAddStop={noop}
        onSearchHotels={onSearchHotels}
        onRemoveHotel={noop}
      />,
    );
  }

  it("无片区时点「看酒店 ›」传 null 而非城市名", () => {
    const trip = makeTrip(3, []);
    const onSearchHotels = vi.fn();
    const { container } = renderDayWithSpy(trip, 2, onSearchHotels);
    const btn = container.querySelector(".anchor-hotels-btn") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    fireEvent.click(btn);
    expect(onSearchHotels).toHaveBeenCalledTimes(1);
    // 第二个入参为 null（未回退城市名「三亚」）
    expect(onSearchHotels).toHaveBeenCalledWith(2, null);
    expect(onSearchHotels.mock.calls[0][1]).not.toBe("三亚");
  });
});
