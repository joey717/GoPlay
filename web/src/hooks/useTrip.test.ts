import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { Item, RelationshipSuggestion, Stop, Trip, Visit } from "@goplay/shared";

vi.mock("../api/client", () => ({
  loadTrip: vi.fn(),
  saveTrip: vi.fn(),
}));

import { useTrip } from "./useTrip";
import { loadTrip, saveTrip } from "../api/client";

function makeTrip(tripId: string, city: string, version = 1): Trip {
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
    version,
    destination: { city, cityCode: null },
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

/** 挂载 hook 并等待初始 loadTrip 完成（trip 就绪） */
async function mountReady(tripId: string) {
  const utils = renderHook(() => useTrip(tripId));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  return utils;
}

/** 任务 213：带 Day1 住宿计划的行程（hotelRefs 首位 = 当前展示酒店） */
function tripWithLodging(): Trip {
  const trip = makeTrip("trip-213", "三亚");
  return {
    ...trip,
    days: {
      ...trip.days,
      day_1: { ...trip.days.day_1, lodging: { kind: "lodging", dayIndex: 1 } },
    },
    lodgings: {
      "1": {
        dayIndex: 1,
        hotelRefs: ["hotel_1"],
        checkInTime: null,
        checkOutTime: null,
        purchaseState: "unknown",
        locked: false,
        userAdjusted: false,
      },
    },
    hotelRegistry: {
      hotel_1: {
        id: "hotel_1",
        shId: "hotel_1",
        name: "三亚湾红树林度假世界",
        brandName: null,
        star: "5星",
        priceText: "¥501",
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

describe("useTrip refreshFromServer（问题2：保存/刷新串行协调）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("防抖窗口内的本地编辑：refreshFromServer 先冲刷 PUT（含编辑）再 GET 采纳，且不排队新的防抖 PUT", async () => {
    vi.mocked(loadTrip).mockResolvedValue(makeTrip("trip-106", "三亚"));
    const { result } = await mountReady("trip-106");
    expect(result.current.trip).not.toBeNull();

    // 本地编辑进入防抖窗口（PUT 未触发）
    act(() => {
      result.current.updateTrip((trip) => ({
        ...trip,
        destination: { city: "本地编辑后的城市", cityCode: null },
      }));
    });
    expect(result.current.trip?.destination.city).toBe("本地编辑后的城市");
    expect(vi.mocked(saveTrip)).not.toHaveBeenCalled();

    // 服务端已有更新（如攻略来源后台装配入池）
    const serverTrip = makeTrip("trip-106", "服务端权威城市", 5);
    vi.mocked(loadTrip).mockResolvedValue(serverTrip);
    vi.mocked(saveTrip).mockResolvedValue(serverTrip);

    await act(async () => {
      await result.current.refreshFromServer();
    });

    // 冲刷：PUT 收到的是含本地编辑的 trip（本地编辑已落地，不会丢）
    expect(vi.mocked(saveTrip)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveTrip).mock.calls[0][0].destination.city).toBe("本地编辑后的城市");
    // GET：初始加载 + 刷新各一次
    expect(vi.mocked(loadTrip)).toHaveBeenCalledTimes(2);
    // 直接采纳服务端数据（不走防抖 PUT 的普通编辑路径）
    expect(result.current.trip?.destination.city).toBe("服务端权威城市");
    expect(result.current.trip?.version).toBe(5);

    // 服务端采纳不排队新的防抖 PUT：推进超过 SAVE_DEBOUNCE_MS（1s）后仍只有冲刷那一次
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(vi.mocked(saveTrip)).toHaveBeenCalledTimes(1);
  });

  it("冲刷失败（PUT reject）：放弃本次刷新，本地未保存编辑保留", async () => {
    vi.mocked(loadTrip).mockResolvedValue(makeTrip("trip-106", "三亚"));
    const { result } = await mountReady("trip-106");

    act(() => {
      result.current.updateTrip((trip) => ({
        ...trip,
        destination: { city: "未持久化的本地编辑", cityCode: null },
      }));
    });
    vi.mocked(saveTrip).mockRejectedValue(new Error("network down"));

    await act(async () => {
      await result.current.refreshFromServer();
    });

    // 冲刷失败 → 不 GET，旧快照绝不覆盖本地
    expect(vi.mocked(loadTrip)).toHaveBeenCalledTimes(1); // 仅初始加载
    expect(result.current.trip?.destination.city).toBe("未持久化的本地编辑");
  });

  it("防抖已触发、PUT 在途：refreshFromServer 等待在途 PUT 落地后才 GET", async () => {
    vi.mocked(loadTrip).mockResolvedValue(makeTrip("trip-106", "三亚"));
    const { result } = await mountReady("trip-106");

    act(() => {
      result.current.updateTrip((trip) => ({
        ...trip,
        destination: { city: "在途编辑", cityCode: null },
      }));
    });
    // 防抖 1 秒后 PUT 发出，但响应由测试手动控制（在途）
    let resolveSave!: (trip: Trip) => void;
    vi.mocked(saveTrip).mockImplementation(
      () =>
        new Promise<Trip>((resolve) => {
          resolveSave = resolve;
        }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(vi.mocked(saveTrip)).toHaveBeenCalledTimes(1); // PUT 在途

    const serverTrip = makeTrip("trip-106", "服务端权威城市", 7);
    vi.mocked(loadTrip).mockResolvedValue(serverTrip);
    // 不 await：保留在途 PUT 未落地时的中间态供断言
    const refreshing = result.current.refreshFromServer();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // 在途 PUT 未落地 → 不得提前 GET 读到旧快照
    expect(vi.mocked(loadTrip)).toHaveBeenCalledTimes(1);

    // 在途 PUT 落地 → 才 GET 并采纳（状态更新包在同一个 act 内）
    await act(async () => {
      resolveSave(serverTrip);
      await refreshing;
    });
    expect(vi.mocked(loadTrip)).toHaveBeenCalledTimes(2);
    expect(result.current.trip?.destination.city).toBe("服务端权威城市");
  });
});

describe("useTrip 住宿预订状态与锁定（任务 213）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("setLodgingPurchaseState 走 setPurchase(lodging)：三档均落库到当天住宿计划", async () => {
    vi.mocked(loadTrip).mockResolvedValue(tripWithLodging());
    const { result } = await mountReady("trip-213");
    expect(result.current.trip?.lodgings["1"].purchaseState).toBe("unknown");

    act(() => result.current.setLodgingPurchaseState(1, "bought"));
    expect(result.current.trip?.lodgings["1"].purchaseState).toBe("bought");

    act(() => result.current.setLodgingPurchaseState(1, "toBuy"));
    expect(result.current.trip?.lodgings["1"].purchaseState).toBe("toBuy");

    act(() => result.current.setLodgingPurchaseState(1, "unknown"));
    expect(result.current.trip?.lodgings["1"].purchaseState).toBe("unknown");
  });

  it("toggleLodgingLock 走 lock(lodging)：锁定/解锁往返，酒店引用不受影响", async () => {
    vi.mocked(loadTrip).mockResolvedValue(tripWithLodging());
    const { result } = await mountReady("trip-213");
    expect(result.current.trip?.lodgings["1"].locked).toBe(false);

    act(() => result.current.toggleLodgingLock(1));
    expect(result.current.trip?.lodgings["1"].locked).toBe(true);
    expect(result.current.trip?.lodgings["1"].hotelRefs).toEqual(["hotel_1"]);

    act(() => result.current.toggleLodgingLock(1));
    expect(result.current.trip?.lodgings["1"].locked).toBe(false);
  });

  it("无住宿计划的天：直接忽略，不新增 lodgings 条目", async () => {
    vi.mocked(loadTrip).mockResolvedValue(tripWithLodging());
    const { result } = await mountReady("trip-213");

    act(() => result.current.setLodgingPurchaseState(2, "bought"));
    act(() => result.current.toggleLodgingLock(2));
    expect(result.current.trip?.lodgings["2"]).toBeUndefined();
  });
});

// ===== 任务 199：独立景点手动归入大景区 =====

function makeClassifyItem(itemId: string, name: string): Item {
  return {
    itemId,
    name,
    origin: "fliggy",
    providerId: `provider_${itemId}`,
    address: null,
    category: null,
    coords: null,
    suggestMinutes: 120,
    mainPic: null,
    ticketInfo: null,
    jumpUrl: null,
    sourceEvidenceRefs: [],
  };
}

function makeClassifyVisit(
  visitId: string,
  pointRef: string,
  kind: Visit["kind"],
  order: number,
): Visit {
  return {
    visitId,
    dayRef: "day_1",
    pointRef,
    kind,
    visitMode: kind === "ordinary" ? "custom" : "half_day",
    order,
    windowStart: null,
    windowEnd: null,
    startTime: "09:00",
    endTime: null,
    startTimeOverridden: false,
    endTimeOverridden: false,
    reservedMinutes: null,
    effectiveMinutes: 120,
    externalLeg: null,
    childStopRefs: [],
    alternateStopRefs: [],
    sourceMentionRefs: [],
    purchaseState: "unknown",
    locked: false,
    userAdjusted: false,
    removedFrom: null,
    removedAt: null,
  };
}

/** Day1 = 独立普通景点「情人桥」+ 大景点「蜈支洲岛」 */
function tripWithClassifyFixture(overrides: { locked?: boolean } = {}): Trip {
  const trip = makeTrip("trip-199", "三亚");
  trip.itemRegistry = {
    item_child: makeClassifyItem("item_child", "情人桥"),
    item_parent: makeClassifyItem("item_parent", "蜈支洲岛"),
  };
  trip.visits = {
    visit_child: {
      ...makeClassifyVisit("visit_child", "item_child", "ordinary", 0),
      locked: overrides.locked ?? false,
    },
    visit_parent: makeClassifyVisit("visit_parent", "item_parent", "large_attraction", 1),
  };
  trip.days.day_1!.scheduleVisitRefs = ["visit_child", "visit_parent"];
  return trip;
}

describe("useTrip 独立景点手动归入大景点（任务 199）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("用户通道空证据即可归类：原 Visit 移除、目标生成内部玩法、记操作日志", async () => {
    vi.mocked(loadTrip).mockResolvedValue(tripWithClassifyFixture());
    const { result } = await mountReady("trip-199");

    let applied = false;
    act(() => {
      applied = result.current.classifyVisitAsParentStop("visit_child", "visit_parent");
    });

    expect(applied).toBe(true);
    const trip = result.current.trip!;
    // 原 Visit 被删除转 Stop（不可逆）
    expect(trip.visits.visit_child).toBeUndefined();
    const parent = trip.visits.visit_parent!;
    expect(parent.childStopRefs).toHaveLength(1);
    const stop = trip.stops[parent.childStopRefs[0]!]!;
    expect(stop.classifiedFromVisitRef).toBe("visit_child");
    expect(stop.matchedPointRef).toBe("item_child");
    expect(stop.userAdjusted).toBe(true);
    // 来源从天内移除，剩余 Visit 顺序重排
    expect(trip.days.day_1!.scheduleVisitRefs).toEqual(["visit_parent"]);
    expect(parent.order).toBe(0);
    // 归属档案为用户手动决定（而非 AI / system）
    expect(trip.relationshipSuggestions[stop.stopId]?.decidedBy).toBe("user");
    expect(trip.relationshipSuggestions[stop.stopId]?.positiveSignals).toEqual([
      "用户手动归入大景区",
    ]);
    // 近期操作可读文案
    expect(result.current.opLog[0]?.kind).toBe("transfer");
    expect(result.current.opLog[0]?.detail).toContain("归入「蜈支洲岛」作为内部玩法");
  });

  it("来源已锁定：护栏拒绝，返回 false 且行程原样保留", async () => {
    vi.mocked(loadTrip).mockResolvedValue(tripWithClassifyFixture({ locked: true }));
    const { result } = await mountReady("trip-199");
    const before = result.current.trip;
    const logBefore = result.current.opLog.length;

    let applied = true;
    act(() => {
      applied = result.current.classifyVisitAsParentStop("visit_child", "visit_parent");
    });

    expect(applied).toBe(false);
    expect(result.current.trip).toBe(before);
    expect(result.current.trip?.visits.visit_child?.locked).toBe(true);
    // 护栏拒绝时不写近期操作（opLog 为模块级持久化，按增量断言）
    expect(result.current.opLog).toHaveLength(logBefore);
  });
});

// ===== 验收修复：大景区一键采纳高置信度待定玩法 =====

function makePendingStop(
  stopId: string,
  name: string,
  suggestedVisitRef: string,
): Stop {
  return {
    stopId,
    state: "pending",
    visitRef: null,
    suggestedVisitRef,
    matchedPointRef: null,
    customName: name,
    order: null,
    suggestMinutes: 40,
    locationHint: null,
    ticketRelation: "unknown",
    sourceEvidenceRefs: [],
    sourceMentionRefs: [],
    userAdjusted: false,
    removedFromOrder: null,
    removedAt: null,
  };
}

function makeSuggestion(
  stopId: string,
  level: RelationshipSuggestion["level"],
  decidedBy: RelationshipSuggestion["decidedBy"],
  suggestedVisitRef: string,
): RelationshipSuggestion {
  return {
    stopRef: stopId,
    suggestedVisitRef,
    level,
    positiveSignals: ["夹具信号"],
    negativeSignals: [],
    decidedBy,
  };
}

/** Day1 = 大景区「西岛」+ 两个 high / 一个 medium / 一个用户已表态 的待定玩法 */
function tripWithAdoptFixture(): Trip {
  const trip = makeTrip("trip-225", "三亚");
  trip.itemRegistry = { item_parent: makeClassifyItem("item_parent", "西岛") };
  trip.visits = {
    visit_parent: makeClassifyVisit("visit_parent", "item_parent", "large_attraction", 0),
  };
  trip.days.day_1!.scheduleVisitRefs = ["visit_parent"];
  trip.stops = {
    stop_high_1: makePendingStop("stop_high_1", "牛王岭", "visit_parent"),
    stop_high_2: makePendingStop("stop_high_2", "珊瑚石墙", "visit_parent"),
    stop_medium: makePendingStop("stop_medium", "海上书屋", "visit_parent"),
    stop_user: makePendingStop("stop_user", "渔村", "visit_parent"),
  };
  trip.pendingStopRefs = ["stop_high_1", "stop_high_2", "stop_medium", "stop_user"];
  trip.relationshipSuggestions = {
    stop_high_1: makeSuggestion("stop_high_1", "high", "system", "visit_parent"),
    stop_high_2: makeSuggestion("stop_high_2", "high", "system", "visit_parent"),
    stop_medium: makeSuggestion("stop_medium", "medium", "system", "visit_parent"),
    stop_user: makeSuggestion("stop_user", "high", "user", "visit_parent"),
  };
  return trip;
}

describe("useTrip 大景区一键采纳推荐玩法（验收修复）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("批量采纳 high：一次 transfer 搭进 childStopRefs，medium 与用户已表态的留在待定区", async () => {
    vi.mocked(loadTrip).mockResolvedValue(tripWithAdoptFixture());
    const { result } = await mountReady("trip-225");

    let adopted = 0;
    act(() => {
      adopted = result.current.adoptSuggestedStops("visit_parent");
    });

    expect(adopted).toBe(2);
    const trip = result.current.trip!;
    expect(trip.visits.visit_parent!.childStopRefs).toEqual(["stop_high_1", "stop_high_2"]);
    expect(trip.stops.stop_high_1!.state).toBe("attached");
    expect(trip.stops.stop_high_1!.visitRef).toBe("visit_parent");
    expect(trip.stops.stop_high_1!.order).toBe(0);
    expect(trip.stops.stop_high_2!.order).toBe(1);
    expect(trip.stops.stop_high_1!.suggestedVisitRef).toBeNull();
    expect(trip.pendingStopRefs).toEqual(["stop_medium", "stop_user"]);
    expect(trip.stops.stop_medium!.state).toBe("pending");
    expect(trip.stops.stop_user!.state).toBe("pending");
    expect(result.current.opLog[0]?.detail).toContain("一键采纳 2 个推荐玩法");

    // 幂等：同一景区再点一次没有可采纳项
    let again = 1;
    act(() => {
      again = result.current.adoptSuggestedStops("visit_parent");
    });
    expect(again).toBe(0);
    expect(result.current.trip?.visits.visit_parent?.childStopRefs).toEqual([
      "stop_high_1",
      "stop_high_2",
    ]);
  });

  it("没有高置信度待确认项：返回 0 且行程引用不变", async () => {
    const trip = tripWithAdoptFixture();
    trip.stops = { stop_medium: makePendingStop("stop_medium", "海上书屋", "visit_parent") };
    trip.pendingStopRefs = ["stop_medium"];
    trip.relationshipSuggestions = {
      stop_medium: makeSuggestion("stop_medium", "medium", "system", "visit_parent"),
    };
    vi.mocked(loadTrip).mockResolvedValue(trip);
    const { result } = await mountReady("trip-225");
    const before = result.current.trip;

    let adopted = 1;
    act(() => {
      adopted = result.current.adoptSuggestedStops("visit_parent");
    });

    expect(adopted).toBe(0);
    expect(result.current.trip).toBe(before);
  });
});
