/**
 * Task #340 恢复性证明：SHOW_ESTIMATED_TIMES=true 时，所有被 gate 的估算时间
 * 渲染点原样恢复（渲染代码从未删除，仅由 web/src/lib/displayFlags.ts 开关控制）。
 *
 * 覆盖四个组件的恢复断言：
 * 1. VisitCard 普通卡：.schedule 行（开始时间 + 「估算」徽标 + 建议时长）
 * 2. VisitCard 父卡：「约 X 小时」时长段 + 岛内小点推算区间（Task #350：「岛内 N 个点」计数文案已永久去除，不受开关控制）
 * 3. StopRow：timeRange 推算区间文本（"HH:MM–HH:MM"）
 * 4. DayContent：dayhead「N 站 · X 小时游玩」+ S5 带时间来源灰字（原 Task #281 断言迁移）
 * 5. ShareView：时间窗 "09:00 – 12:00" + 「建议 3h」+ 内部玩法时长 "20min"
 * 6. CandidatePool（Task #343）：候选池三区（候选区 / 待定加入 / 备选玩法）
 *    的「建议 X 小时·分钟」时长 chip
 *
 * 开关关闭口径的断言在各组件既有测试文件中（VisitCard.test / StopRow.test /
 * DayContent.test / ShareView.test），两边共同锁定开关的双向行为。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import type { Constraint, Day, Item, SharedTrip, Stop, Trip, Visit } from "@goplay/shared";
import { recomputeDerivedFields } from "@goplay/shared";

// 恢复性前提：整个文件内开关为 true（模块级 mock，不改源文件）
vi.mock("./displayFlags", () => ({ SHOW_ESTIMATED_TIMES: true }));
// ShareView 网络层：与 ShareView.test.tsx 同款，只替换分享读/写调用
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  loadShareTrip: vi.fn(),
  patchShareStatus: vi.fn(),
}));

import VisitCard from "../components/VisitCard";
import StopRow from "../components/StopRow";
import DayContent from "../components/DayContent";
import ShareView from "../components/ShareView";
import CandidatePool from "../components/CandidatePool";
import { loadShareTrip } from "../api/client";
import { SHOW_ESTIMATED_TIMES } from "./displayFlags";

const loadShareTripMock = vi.mocked(loadShareTrip);

afterEach(cleanup);

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  loadShareTripMock.mockReset();
});

// ===== 最小夹具（形态对齐各组件既有测试） =====

function makeVisit(overrides: Partial<Visit> = {}): Visit {
  return {
    visitId: "visit_1",
    dayRef: "day_1",
    pointRef: "item_1",
    kind: "ordinary",
    visitMode: "custom",
    order: 0,
    windowStart: null,
    windowEnd: null,
    startTime: "09:00",
    endTime: null,
    startTimeOverridden: false,
    endTimeOverridden: false,
    reservedMinutes: null,
    effectiveMinutes: 240,
    externalLeg: null,
    childStopRefs: [],
    alternateStopRefs: [],
    purchaseState: "unknown",
    locked: false,
    userAdjusted: false,
    removedFrom: null,
    removedAt: null,
    ...overrides,
  } as Visit;
}

function makeStop(stopId: string, overrides: Partial<Stop> = {}): Stop {
  return {
    stopId,
    state: "attached",
    visitRef: "visit_p",
    suggestedVisitRef: null,
    matchedPointRef: null,
    customName: `玩法${stopId}`,
    order: 0,
    suggestMinutes: 60,
    locationHint: null,
    ticketRelation: "unknown",
    sourceEvidenceRefs: [],
    sourceMentionRefs: [],
    userAdjusted: false,
    removedFromOrder: null,
    removedAt: null,
    ...overrides,
  } as Stop;
}

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    tripId: "trip_flag_on",
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
        departTime: "09:00",
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
    ...overrides,
  } as unknown as Trip;
}

function renderCard(trip: Trip, visit: Visit) {
  render(
    <DndContext>
      <SortableContext items={[visit.visitId]}>
        <VisitCard
          trip={trip}
          visit={visit}
          isFirst={false}
          index={0}
          total={1}
          onMoveItem={vi.fn()}
          selectMode={false}
          selected={false}
          onToggleSelect={vi.fn()}
          onRemove={vi.fn()}
          onPurchaseSelect={vi.fn()}
          onToggleLock={vi.fn()}
          onMoveStop={vi.fn()}
          onRemoveStop={vi.fn()}
          onRestoreStop={vi.fn()}
          onAddStop={vi.fn()}
          onOpenStopEvidence={vi.fn()}
        />
      </SortableContext>
    </DndContext>,
  );
}

// ===== 1/2. VisitCard：普通卡 schedule 行 + 父卡时长段与推算区间 =====

describe("Task #340 开关打开：VisitCard 估算时间恢复渲染", () => {
  it("mock 生效：文件内开关为 true", () => {
    expect(SHOW_ESTIMATED_TIMES).toBe(true);
  });

  it("普通卡恢复 .schedule 行：开始时间 + 「估算」徽标 + 建议时长", () => {
    const visit = makeVisit({ startTime: "09:00", effectiveMinutes: 240 });
    renderCard(makeTrip({ visits: { visit_1: visit } }), visit);

    const schedule = document.querySelector(".prodrow .schedule");
    expect(schedule).not.toBeNull();
    expect(document.querySelector(".schedule .st")?.textContent).toBe("09:00");
    expect(document.querySelector(".schedule .est")?.textContent).toBe("估算");
    expect(document.querySelector(".schedule .du")?.textContent).toBe("建议 4h");
  });

  it("父卡恢复「约 X 小时」时长段与岛内小点推算区间（Task #350：「岛内 N 个点」计数已永久去除）", () => {
    const parent = makeVisit({
      visitId: "visit_p",
      pointRef: "item_p",
      kind: "large_attraction",
      visitMode: "full_day",
      startTime: "09:00",
      effectiveMinutes: 210,
      childStopRefs: ["stop_a", "stop_b"],
    });
    const trip = makeTrip({
      visits: { visit_p: parent },
      stops: {
        stop_a: makeStop("stop_a", { suggestMinutes: 60 }),
        stop_b: makeStop("stop_b", { suggestMinutes: 90 }),
      },
    });
    renderCard(trip, parent);

    // Task #350（PD 2026-11-04）：「岛内 N 个点」计数文案永久去除，即使 SHOW_ESTIMATED_TIMES=true
    // 也不再展示；parent-sub 仅保留时长段（effectiveMinutes=210 → 3.5 小时）。
    expect(document.querySelector(".parent-sub")?.textContent).toBe("约 3.5 小时");
    // 岛内小点推算区间恢复：09:00 起按建议时长顺排
    const times = [...document.querySelectorAll(".child-time-text")].map((node) => node.textContent);
    expect(times).toEqual(["09:00–10:00", "10:00–11:30"]);
  });
});

// ===== 3. StopRow：timeRange 推算区间 =====

describe("Task #340 开关打开：StopRow 时间区间恢复渲染", () => {
  it("timeRange 存在时恢复 \"HH:MM–HH:MM\" 区间文本", () => {
    const stop = makeStop("stop_a");
    render(
      <StopRow
        trip={makeTrip({ stops: { stop_a: stop } })}
        stop={stop}
        index={0}
        total={1}
        timeRange={{ start: "09:00", end: "10:30" }}
        onMove={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(document.querySelector(".child-time-text")?.textContent).toBe("09:00–10:30");
  });

  it("timeRange 为 null 时恢复「建议 X」回退文本", () => {
    const stop = makeStop("stop_a", { suggestMinutes: 90 });
    render(
      <StopRow
        trip={makeTrip({ stops: { stop_a: stop } })}
        stop={stop}
        index={0}
        total={1}
        timeRange={null}
        onMove={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(document.querySelector(".child-time-text")?.textContent).toBe("建议 1.5h");
  });
});

// ===== 4. DayContent：dayhead 时长汇总 + S5 带时间灰字（原 Task #281 断言迁移） =====

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

function makeDayTrip(dayCount: number, constraints: Constraint[], visits: Visit[] = []): Trip {
  const dayRefs: string[] = [];
  const days: Record<string, Day> = {};
  for (let i = 1; i <= dayCount; i++) {
    dayRefs.push(`day_${i}`);
    days[`day_${i}`] = makeDay(i, i === 1 ? { scheduleVisitRefs: visits.map((v) => v.visitId) } : {});
  }
  const visitMap: Record<string, Visit> = {};
  for (const visit of visits) visitMap[visit.visitId] = visit;
  const trip = makeTrip({
    dayRefs,
    days,
    constraints,
    visits: visitMap,
  } as Partial<Trip>);
  // 派生字段写入（模拟服务端 save/load 路径，同 DayContent.test.tsx）
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

describe("Task #340 开关打开：DayContent 时长汇总与 S5 灰字恢复渲染", () => {
  it("dayhead 恢复「N 站 · X 小时游玩」时长汇总", () => {
    const trip = makeDayTrip(1, [], [
      makeVisit({ visitId: "v1", effectiveMinutes: 120 }),
      makeVisit({ visitId: "v2", order: 1, effectiveMinutes: 90 }),
    ]);
    const { container } = renderDay(trip, 1);
    expect(container.querySelector(".dayhead .s")?.textContent).toBe("2 站 · 3.5 小时游玩");
  });

  it("抵达日出发时间旁恢复航班推算灰字（原 Task #281 断言）", () => {
    const trip = makeDayTrip(3, [makeConstraint("flight_arrive", 1, "2026-11-08T09:40:00")]);
    const { container } = renderDay(trip, 1);
    const src = container.querySelector(".anchor-src");
    expect(src).not.toBeNull();
    expect(src!.textContent).toBe("按你的到达航班 09:40 算");
  });

  it("编辑态恢复对应来源灰字（原 Task #281 断言）", () => {
    const trip = makeDayTrip(3, [makeConstraint("flight_arrive", 1, "2026-11-08T09:40:00")]);
    const { container } = renderDay(trip, 1);
    fireEvent.click(container.querySelector(".anchor-edit-btn") as HTMLButtonElement);
    const hint = container.querySelector(".anchor-src.editing-hint");
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toBe("按你的到达航班 09:40 算");
  });
});

// ===== 5. ShareView：时间窗 / 建议时长 / 内部玩法时长 =====

function makeSharedTrip(): SharedTrip {
  return {
    tripId: "11111111-1111-4111-8111-111111111111",
    schemaVersion: 2,
    version: 3,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: "2026-11-09", nights: 1 },
    dayRefs: ["day_1"],
    days: {
      day_1: makeDay(1, { departTime: "08:30", scheduleVisitRefs: ["visit_wzz"] }),
    },
    lodgings: {},
    itemRegistry: {
      item_wzz: {
        itemId: "item_wzz",
        name: "蜈支洲岛",
        origin: "custom",
        providerId: null,
        address: "海南省三亚市海棠区蜈支洲岛",
        category: "海岛",
        coords: null,
        suggestMinutes: 180,
        mainPic: null,
        ticketInfo: null,
        jumpUrl: null,
        sourceEvidenceRefs: [],
      },
      item_qingren: {
        itemId: "item_qingren",
        name: "情人桥",
        origin: "custom",
        providerId: null,
        address: null,
        category: null,
        coords: null,
        suggestMinutes: null,
        mainPic: null,
        ticketInfo: null,
        jumpUrl: null,
        sourceEvidenceRefs: [],
      },
    },
    hotelRegistry: {},
    visits: {
      visit_wzz: makeVisit({
        visitId: "visit_wzz",
        pointRef: "item_wzz",
        kind: "large_attraction",
        visitMode: "full_day",
        startTime: "09:00",
        endTime: "12:00",
        effectiveMinutes: 180,
        childStopRefs: ["stop_bridge"],
      }),
    },
    stops: {
      stop_bridge: makeStop("stop_bridge", {
        visitRef: "visit_wzz",
        matchedPointRef: "item_qingren",
        customName: null,
        suggestMinutes: 20,
        locationHint: "入口左转",
      }),
    },
    constraints: [],
    createdAt: "2026-11-01T02:00:00.000Z",
    updatedAt: "2026-11-02T06:00:00.000Z",
  } as unknown as SharedTrip;
}

describe("Task #340 开关打开：ShareView 估算时间恢复渲染", () => {
  it("景点卡恢复时间窗、建议时长与内部玩法时长（原 ShareView.test 断言）", async () => {
    loadShareTripMock.mockResolvedValue(makeSharedTrip());
    render(<ShareView tripId="11111111-1111-4111-8111-111111111111" />);
    await screen.findByRole("button", { name: /行程封面：/ });

    expect(screen.getByText("09:00 – 12:00")).toBeInTheDocument();
    expect(screen.getByText("建议 3h")).toBeInTheDocument();
    expect(screen.getByText("20min")).toBeInTheDocument();
  });
});

// ===== 6. CandidatePool：候选池三区「建议 X」时长 chip（Task #343）=====

function makePoolItem(itemId: string, name: string, suggestMinutes: number | null): Item {
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

/**
 * 三区都带建议时长的行程（与 CandidatePool.test.tsx 的开关关闭夹具同数据）：
 * 区一候选区 120min → 「建议 2h」；区二待定加入 45min → 「建议 45min」；
 * 区三备选玩法 90min → 「建议 1.5h」。
 */
function makePoolTrip(): Trip {
  return makeTrip({
    itemRegistry: {
      item_pool: makePoolItem("item_pool", "西岛", 120),
      item_parent: makePoolItem("item_parent", "蜈支洲岛", 180),
    },
    globalCandidateRefs: [{ kind: "point", id: "item_pool" }],
    pendingStopRefs: ["stop_pending"],
    visits: {
      visit_parent: makeVisit({
        visitId: "visit_parent",
        pointRef: "item_parent",
        kind: "large_attraction",
        visitMode: "full_day",
        effectiveMinutes: 210,
        childStopRefs: [],
        alternateStopRefs: ["stop_alt"],
      }),
    },
    stops: {
      stop_pending: makeStop("stop_pending", {
        state: "pending",
        visitRef: null,
        suggestedVisitRef: "visit_parent",
        customName: "潜水",
        order: null,
        suggestMinutes: 45,
      }),
      stop_alt: makeStop("stop_alt", {
        visitRef: "visit_parent",
        customName: "情人桥",
        order: 0,
        suggestMinutes: 90,
      }),
    },
  });
}

function renderPool() {
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
function poolRowOf(name: string): Element | null {
  return screen.getByText(name).closest(".poolitem");
}

describe("Task #343 开关打开：CandidatePool 三区「建议 X」时长 chip 恢复渲染", () => {
  it("区一候选区恢复 .m 时长 chip「建议 2h」", () => {
    renderPool();

    const row = poolRowOf("西岛");
    expect(row).not.toBeNull();
    // 开关关闭时本行为 null（见 CandidatePool.test.tsx Task #343 组），打开后恢复
    expect(row?.querySelector(".m")?.textContent).toContain("建议 2h");
    expect(row?.querySelector(".n")?.textContent).toBe("西岛");
  });

  it("区二待定加入恢复「建议 45min · 可能属于「蜈支洲岛」」", () => {
    renderPool();

    const row = poolRowOf("潜水");
    expect(row).not.toBeNull();
    // 时长段回到归属语义之前，两段拼接形态与 gate 前一致
    expect(row?.querySelector(".m")?.textContent).toBe("建议 45min · 可能属于「蜈支洲岛」");
  });

  it("区三备选玩法展开后恢复 .reserve-meta「建议 1.5h」", () => {
    renderPool();

    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    expect(document.querySelector(".reserve-item .reserve-meta")?.textContent).toBe("建议 1.5h");
    expect(document.querySelector(".reserve-item .reserve-name")?.textContent).toBe("情人桥");
  });

  it("三区时长文本齐全（全文扫描确认 gate 可完全恢复）", () => {
    renderPool();

    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/建议 2h/);
    expect(text).toMatch(/建议 45min/);
    expect(text).toMatch(/建议 1\.5h/);
  });
});
