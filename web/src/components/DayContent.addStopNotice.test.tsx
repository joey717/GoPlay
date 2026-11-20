/**
 * Task #334：DayContent 添加点位降级提示条集成测试。
 *
 * 验收口径：
 * - AddStopSheet 未命中飞猪 POI（meta.matchedPoi=false）时，DayContent 渲染
 *   内联提示条「「名称」未匹配到飞猪点位，已作为自定义点位添加」，3 秒自动消失；
 * - 提示条为 role=status 内联小条（复用 candidate-toast 深色样式），非弹框、
 *   不阻断操作（项目纪律：添加表单避免新增弹框）；
 * - onAddStop 照常上抛（降级不阻止添加）。
 *
 * mock 说明：Module C 起 VisitCard 卡内不再渲染「添加点位」入口（onAddStop prop
 * 保留兼容），故 mock VisitCard 暴露打开 Sheet 的驱动点；mock AddStopSheet 直接
 * 触发降级确认回调（真实 Sheet 的搜索/匹配链路由 AddStopSheet.test.tsx 覆盖）。
 * 与真实 AddStopSheet 的测试分文件隔离（vi.mock 是文件级提升，同文件会污染）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Day, Item, Trip, Visit } from "@goplay/shared";
import DayContent from "./DayContent";
import type { CustomStopInput } from "../hooks/useTrip";

vi.mock("./VisitCard", () => ({
  default: (props: { visit: { visitId: string }; onAddStop: () => void }) => (
    <button
      type="button"
      data-testid={`mock-open-sheet-${props.visit.visitId}`}
      onClick={props.onAddStop}
    >
      open-{props.visit.visitId}
    </button>
  ),
}));

vi.mock("./AddStopSheet", () => ({
  default: (props: {
    visitName: string;
    onConfirm: (input: CustomStopInput, meta: { matchedPoi: boolean }) => void;
  }) => (
    <button
      type="button"
      data-testid="mock-addstop-confirm-degraded"
      onClick={() =>
        props.onConfirm(
          { name: "入口左转小吃店", locationHint: null, noteText: null, matchedPoi: null },
          { matchedPoi: false },
        )
      }
    >
      mock-{props.visitName}
    </button>
  ),
}));

// ===== 夹具：单天 + 一个大景区 Visit（蜈支洲岛） =====

function makeItem(itemId: string, name: string): Item {
  return {
    itemId,
    name,
    origin: "fliggy",
    providerId: `fp_${itemId}`,
    address: null,
    category: null,
    coords: null,
    suggestMinutes: null,
    mainPic: null,
    ticketInfo: null,
    jumpUrl: null,
    sourceEvidenceRefs: [],
  };
}

function makeVisit(visitId: string, pointRef: string): Visit {
  return {
    visitId,
    dayRef: "day_1",
    pointRef,
    kind: "large_attraction",
    visitMode: "full_day",
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
  };
}

function makeTripWithVisit(): Trip {
  const day: Day = {
    dayId: "day_1",
    dayIndex: 1,
    date: "2026-11-08",
    departTime: null,
    departTimeOverridden: false,
    scheduleVisitRefs: ["visit_wzz"],
    lodging: null,
  };
  return {
    tripId: "trip-test-334",
    schemaVersion: 2,
    version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: "2026-11-09", nights: 1 },
    dayRefs: ["day_1"],
    days: { day_1: day },
    lodgings: {},
    itemRegistry: { item_wzz: makeItem("item_wzz", "蜈支洲岛") },
    hotelRegistry: {},
    visits: { visit_wzz: makeVisit("visit_wzz", "item_wzz") },
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

const noop = () => {};

function renderDayContent(onAddStop: (visitId: string, input: CustomStopInput) => void) {
  const trip = makeTripWithVisit();
  return render(
    <DayContent
      trip={trip}
      day={trip.days["day_1"]}
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
      onAddStop={onAddStop}
      onSearchHotels={noop}
      onRemoveHotel={noop}
    />,
  );
}

describe("DayContent 降级提示条（Task #334）", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("默认无 Sheet 无提示条；打开 Sheet 后父景区名透传（visitName=蜈支洲岛）", () => {
    const { baseElement } = renderDayContent(noop);
    // 注：不能用 queryByRole("status") 判无——dnd-kit 的 DndLiveRegion 也是 role=status
    expect(baseElement.querySelector(".addstop-fallback-toast")).toBeNull();
    fireEvent.click(screen.getByTestId("mock-open-sheet-visit_wzz"));
    expect(screen.getByTestId("mock-addstop-confirm-degraded").textContent).toBe(
      "mock-蜈支洲岛",
    );
  });

  it("降级确认后：onAddStop 上抛 + Sheet 关闭 + 内联提示条展示，3 秒自动消失", () => {
    const onAddStop = vi.fn();
    const { baseElement } = renderDayContent(onAddStop);
    fireEvent.click(screen.getByTestId("mock-open-sheet-visit_wzz"));
    fireEvent.click(screen.getByTestId("mock-addstop-confirm-degraded"));

    // 上抛载荷：visitId + 降级 custom 的输入（matchedPoi=null）
    expect(onAddStop).toHaveBeenCalledTimes(1);
    expect(onAddStop.mock.calls[0][0]).toBe("visit_wzz");
    expect(onAddStop.mock.calls[0][1].matchedPoi ?? null).toBeNull();
    // Sheet 已关闭（不阻断后续操作），提示条内联展示（role=status，非弹框）
    expect(screen.queryByTestId("mock-addstop-confirm-degraded")).toBeNull();
    const toast = baseElement.querySelector(".addstop-fallback-toast");
    expect(toast).not.toBeNull();
    expect(toast!.getAttribute("role")).toBe("status");
    expect(toast!.textContent).toBe("「入口左转小吃店」未匹配到飞猪点位，已作为自定义点位添加");

    // 3 秒自动消失
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(baseElement.querySelector(".addstop-fallback-toast")).toBeNull();
  });
});
