import { describe, expect, it } from "vitest";
import type { Item, Stop, Trip, Visit } from "@goplay/shared";
import { haversineKm } from "@goplay/shared";
import {
  CLASSIFY_MAX_DISTANCE_KM,
  eligibleClassifyTargets,
  findChildStopParentVisit,
  findMatchingLargeVisit,
  isEligibleClassifyTarget,
  isLargeAttractionPoi,
  normalizePoiName,
  poiAttractionLabel,
} from "./largeAttraction";

const OFFICIAL = "亚龙湾热带天堂森林公园";
const ALIAS_SHORT = "亚龙湾森林公园";
const ALIAS_MID = "亚龙湾热带森林公园";
const BEACH = "亚龙湾海滩";

function itemOf(itemId: string, name: string): Item {
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

function visitOf(visitId: string, pointRef: string, childStopRefs: string[] = []): Visit {
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
    childStopRefs,
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

function stopOf(stopId: string, name: string): Stop {
  return {
    stopId,
    state: "attached",
    visitRef: "visit_park",
    suggestedVisitRef: null,
    matchedPointRef: null,
    customName: name,
    order: 0,
    suggestMinutes: null,
    locationHint: null,
    ticketRelation: "unknown",
    sourceEvidenceRefs: [],
    sourceMentionRefs: [],
    userAdjusted: false,
    removedFromOrder: null,
    removedAt: null,
  };
}

/** 行程已有大景区 Visit + 一个内部玩法 Stop（名称由参数决定） */
function tripOf(visitName: string, childStopName = "过江龙索桥"): Trip {
  const visit = visitOf("visit_park", "item_park", ["stop_bridge"]);
  return {
    tripId: "trip-large-233",
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
        scheduleVisitRefs: ["visit_park"],
        lodging: null,
      },
    },
    lodgings: {},
    itemRegistry: { item_park: itemOf("item_park", visitName) },
    hotelRegistry: {},
    visits: { visit_park: visit },
    stops: { stop_bridge: stopOf("stop_bridge", childStopName) },
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

describe("normalizePoiName（Task #233 共享口径转发）", () => {
  it("显式别名解析为正式名，海滩保持原样", () => {
    expect(normalizePoiName(ALIAS_SHORT)).toBe(OFFICIAL);
    expect(normalizePoiName(ALIAS_MID)).toBe(OFFICIAL);
    expect(normalizePoiName(" 亚龙湾 森林公园 ")).toBe(OFFICIAL);
    expect(normalizePoiName(`${ALIAS_SHORT}（含门票）`)).toBe(OFFICIAL);
    expect(normalizePoiName(BEACH)).toBe(BEACH);
  });
});

describe("isLargeAttractionPoi（Task #233 别名命中关键词）", () => {
  it("简称同样识别为大景区，海滩不误判", () => {
    expect(isLargeAttractionPoi(ALIAS_SHORT)).toBe(true);
    expect(isLargeAttractionPoi(ALIAS_MID)).toBe(true);
    expect(isLargeAttractionPoi(BEACH)).toBe(false);
    expect(isLargeAttractionPoi(BEACH, "AAAAA")).toBe(true);
  });
});

describe("KNOWN_LARGE_ATTRACTION_KEYWORDS（PD 2026-11-04 名单更新，#349）", () => {
  it("新增关键词：分界洲岛、呀诺达命中大景区（产品变更，非静默放宽）", () => {
    expect(isLargeAttractionPoi("分界洲岛")).toBe(true);
    // 城市前缀剥离后仍命中（shared poiAlias 口径）
    expect(isLargeAttractionPoi("三亚分界洲岛")).toBe(true);
    // 「呀诺达」经 includes 覆盖全称形态（server/data 与 eval/cache 扫描零出现，取官方全称）
    expect(isLargeAttractionPoi("呀诺达")).toBe(true);
    expect(isLargeAttractionPoi("呀诺达雨林文化旅游区")).toBe(true);
  });

  it("移除关键词：鹿回头、天涯海角、南山风景区不再命中（除非 5A 兜底）", () => {
    expect(isLargeAttractionPoi("鹿回头")).toBe(false);
    expect(isLargeAttractionPoi("鹿回头公园")).toBe(false);
    expect(isLargeAttractionPoi("天涯海角")).toBe(false);
    expect(isLargeAttractionPoi("南山风景区")).toBe(false);
    // 5A 规则未动：被移出名单的景区若带 AAAAA 仍判大景区
    expect(isLargeAttractionPoi("天涯海角", "AAAAA")).toBe(true);
    expect(isLargeAttractionPoi("鹿回头", "AAAA")).toBe(false);
  });

  it("保留关键词：西岛、蜈支洲岛、南山文化旅游区、亚龙湾森林公园仍命中", () => {
    expect(isLargeAttractionPoi("西岛")).toBe(true);
    expect(isLargeAttractionPoi("蜈支洲岛")).toBe(true);
    expect(isLargeAttractionPoi("南山文化旅游区")).toBe(true);
    expect(isLargeAttractionPoi(OFFICIAL)).toBe(true);
    expect(isLargeAttractionPoi(ALIAS_SHORT)).toBe(true);
  });

  it("前瞻标签同步：分界洲岛标大景区，鹿回头不再标注", () => {
    const trip = tripOf(OFFICIAL);
    expect(poiAttractionLabel(trip, "分界洲岛")).toBe("大景区");
    expect(poiAttractionLabel(trip, "呀诺达雨林文化旅游区")).toBe("大景区");
    expect(poiAttractionLabel(trip, "鹿回头")).toBeNull();
    expect(poiAttractionLabel(trip, "鹿回头", "AAAAA")).toBe("大景区");
  });
});

describe("findMatchingLargeVisit（Task #233 双向别名召回）", () => {
  it("行程里是官方名时，搜索简称可召回", () => {
    const trip = tripOf(OFFICIAL);
    expect(findMatchingLargeVisit(trip, ALIAS_SHORT)?.visitId).toBe("visit_park");
    expect(findMatchingLargeVisit(trip, ALIAS_MID)?.visitId).toBe("visit_park");
    expect(findMatchingLargeVisit(trip, OFFICIAL)?.visitId).toBe("visit_park");
  });

  it("行程里是攻略简称时，搜索官方名同样召回", () => {
    const trip = tripOf(ALIAS_SHORT);
    expect(findMatchingLargeVisit(trip, OFFICIAL)?.visitId).toBe("visit_park");
    expect(findMatchingLargeVisit(trip, ALIAS_MID)?.visitId).toBe("visit_park");
  });

  it("亚龙湾海滩不召回森林公园大景区", () => {
    const trip = tripOf(OFFICIAL);
    expect(findMatchingLargeVisit(trip, BEACH)).toBeNull();
  });

  it("标注文案沿用行程主数据名", () => {
    const trip = tripOf(OFFICIAL);
    expect(poiAttractionLabel(trip, ALIAS_SHORT)).toBe(`${OFFICIAL} · 大景区`);
  });
});

describe("findChildStopParentVisit（Task #233 别名参与玩法归属）", () => {
  it("内部玩法名为简称时，搜索官方名仍能找回父大景区", () => {
    const trip = tripOf(OFFICIAL, ALIAS_SHORT);
    expect(findChildStopParentVisit(trip, OFFICIAL)?.visitId).toBe("visit_park");
  });

  it("内部玩法名为官方名时，搜索简称同样找回", () => {
    const trip = tripOf(OFFICIAL, OFFICIAL);
    expect(findChildStopParentVisit(trip, ALIAS_SHORT)?.visitId).toBe("visit_park");
  });

  it("亚龙湾海滩不挂到森林公园", () => {
    const trip = tripOf(OFFICIAL, OFFICIAL);
    expect(findChildStopParentVisit(trip, BEACH)).toBeNull();
  });
});

// ===== Task #360：「归入大景点」UI 入口的距离资格矩阵 =====

type Coords = { lng: number; lat: number };

const FOREST = OFFICIAL;

/** 该 POI 名首字以 \u8708 码点转义写入（规避编辑链路字形替换），运行时值与 server/data 真实 POI 名一致 */
const WUZHIZHOU = "\u8708支洲岛";

/**
 * 真实坐标取自验收行程 server/data/0a27f726-9c93-48e8-ab68-1d62e9bc685b.json 的
 * itemRegistry；haversineKm 实测：真实子景点→所属大景区最远 1.40km（过江龙索桥），
 * 误报（同片区不同景区）最近 2.74km（亚龙湾海滩→森林公园）。
 */
const POI_COORDS: Record<string, Coords> = {
  椰梦长廊: { lng: 109.475755, lat: 18.274345 },
  鹿回头: { lng: 109.50131, lat: 18.225639 },
  亚龙湾海滩: { lng: 109.646004, lat: 18.229188 },
  亚龙湾热带天堂森林公园: { lng: 109.643059, lat: 18.253643 },
  玻璃栈道: { lng: 109.643092, lat: 18.251821 },
  过江龙索桥: { lng: 109.632129, lat: 18.260802 },
  后海村: { lng: 109.72963, lat: 18.272223 },
  [WUZHIZHOU]: { lng: 109.765947, lat: 18.310381 },
};

interface ClassifySide {
  name: string;
  /** 省略 = 沿用 POI_COORDS 里的真实坐标；显式 null = 无坐标（走同天兜底） */
  coords?: Coords | null;
  /** 省略 = day_1；null = 未排期（候选池里的壳） */
  dayRef?: string | null;
}

/** 源普通景点 + 目标大景点的最小两天行程夹具（day_1 / day_2） */
function classifyTrip(source: ClassifySide, target: ClassifySide) {
  const sourceDay = source.dayRef === undefined ? "day_1" : source.dayRef;
  const targetDay = target.dayRef === undefined ? "day_1" : target.dayRef;
  const sourceVisit: Visit = {
    ...visitOf("visit_source", "item_source"),
    kind: "ordinary",
    visitMode: "custom",
    dayRef: sourceDay,
  };
  const targetVisit: Visit = { ...visitOf("visit_target", "item_target"), dayRef: targetDay };
  const refsFor = (dayId: string) =>
    [sourceDay === dayId ? "visit_source" : null, targetDay === dayId ? "visit_target" : null].filter(
      (ref): ref is string => ref !== null,
    );
  const trip: Trip = {
    tripId: "trip-classify-360",
    schemaVersion: 2,
    version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: "2026-11-09", nights: 1 },
    dayRefs: ["day_1", "day_2"],
    days: {
      day_1: {
        dayId: "day_1",
        dayIndex: 1,
        date: "2026-11-08",
        departTime: null,
        departTimeOverridden: false,
        scheduleVisitRefs: refsFor("day_1"),
        lodging: null,
      },
      day_2: {
        dayId: "day_2",
        dayIndex: 2,
        date: "2026-11-09",
        departTime: null,
        departTimeOverridden: false,
        scheduleVisitRefs: refsFor("day_2"),
        lodging: null,
      },
    },
    lodgings: {},
    itemRegistry: {
      item_source: {
        ...itemOf("item_source", source.name),
        coords: source.coords === undefined ? (POI_COORDS[source.name] ?? null) : source.coords,
      },
      item_target: {
        ...itemOf("item_target", target.name),
        coords: target.coords === undefined ? (POI_COORDS[target.name] ?? null) : target.coords,
      },
    },
    hotelRegistry: {},
    visits: { visit_source: sourceVisit, visit_target: targetVisit },
    stops: {},
    evidences: {},
    globalCandidateRefs: [],
    pendingStopRefs: [],
    relationshipSuggestions: {},
    guideSources: {},
    constraints: [],
    createdAt: "2026-11-10T00:00:00Z",
    updatedAt: "2026-11-10T00:00:00Z",
  };
  return { trip, sourceVisit, targetVisit };
}

describe("CLASSIFY_MAX_DISTANCE_KM（Task #360 PD 2026-11-10 拍板 2km 单点常量）", () => {
  it("阈值恒为 2km，且夹在真实子景点最远 1.40km 与误报最近 2.74km 之间", () => {
    expect(CLASSIFY_MAX_DISTANCE_KM).toBe(2);
    expect(haversineKm(POI_COORDS["过江龙索桥"]!, POI_COORDS[FOREST]!)).toBeCloseTo(1.4, 1);
    expect(haversineKm(POI_COORDS[BEACH]!, POI_COORDS[FOREST]!)).toBeCloseTo(2.74, 2);
    expect(1.4).toBeLessThan(CLASSIFY_MAX_DISTANCE_KM);
    expect(CLASSIFY_MAX_DISTANCE_KM).toBeLessThan(2.74);
  });
});

describe("isEligibleClassifyTarget（Task #360 距离矩阵）", () => {
  it("椰梦长廊 → 鹿回头 6.05km：不合格（按钮隐）", () => {
    expect(haversineKm(POI_COORDS["椰梦长廊"]!, POI_COORDS["鹿回头"]!)).toBeCloseTo(6.05, 2);
    const { trip, sourceVisit, targetVisit } = classifyTrip(
      { name: "椰梦长廊" },
      { name: "鹿回头" },
    );
    expect(isEligibleClassifyTarget(trip, sourceVisit, targetVisit)).toBe(false);
    expect(eligibleClassifyTargets(trip, sourceVisit)).toEqual([]);
  });

  it("亚龙湾海滩 → 森林公园 2.74km：不合格（误报最近侧，按钮隐）", () => {
    const { trip, sourceVisit, targetVisit } = classifyTrip(
      { name: BEACH },
      { name: FOREST },
    );
    expect(isEligibleClassifyTarget(trip, sourceVisit, targetVisit)).toBe(false);
    expect(eligibleClassifyTargets(trip, sourceVisit)).toEqual([]);
  });

  it(`后海村 → ${WUZHIZHOU} 5.72km：不合格（按钮隐）`, () => {
    expect(haversineKm(POI_COORDS["后海村"]!, POI_COORDS[WUZHIZHOU]!)).toBeCloseTo(5.72, 2);
    const { trip, sourceVisit, targetVisit } = classifyTrip(
      { name: "后海村" },
      { name: WUZHIZHOU },
    );
    expect(isEligibleClassifyTarget(trip, sourceVisit, targetVisit)).toBe(false);
  });

  it("玻璃栈道 → 森林公园 0.20km：合格（真实子景点，按钮显）", () => {
    expect(haversineKm(POI_COORDS["玻璃栈道"]!, POI_COORDS[FOREST]!)).toBeCloseTo(0.2, 1);
    const { trip, sourceVisit, targetVisit } = classifyTrip(
      { name: "玻璃栈道" },
      { name: FOREST },
    );
    expect(isEligibleClassifyTarget(trip, sourceVisit, targetVisit)).toBe(true);
    expect(eligibleClassifyTargets(trip, sourceVisit).map((v) => v.visitId)).toEqual([
      "visit_target",
    ]);
  });

  it("过江龙索桥 → 森林公园 1.40km：合格（真实子景点最远，边界内）", () => {
    const { trip, sourceVisit, targetVisit } = classifyTrip(
      { name: "过江龙索桥" },
      { name: FOREST },
    );
    expect(isEligibleClassifyTarget(trip, sourceVisit, targetVisit)).toBe(true);
  });

  it("无坐标源 + 同天目标：同天兜底合格（按钮显）", () => {
    const { trip, sourceVisit, targetVisit } = classifyTrip(
      { name: "情人桥", coords: null },
      { name: WUZHIZHOU },
    );
    expect(isEligibleClassifyTarget(trip, sourceVisit, targetVisit)).toBe(true);
    expect(eligibleClassifyTargets(trip, sourceVisit)).toHaveLength(1);
  });

  it("无坐标源 + 跨天目标：兜底不成立（按钮隐）", () => {
    const { trip, sourceVisit, targetVisit } = classifyTrip(
      { name: "情人桥", coords: null },
      { name: WUZHIZHOU, dayRef: "day_2" },
    );
    expect(isEligibleClassifyTarget(trip, sourceVisit, targetVisit)).toBe(false);
    expect(eligibleClassifyTargets(trip, sourceVisit)).toEqual([]);
  });

  it("目标无坐标 + 源有坐标：同样走同天兜底（任一方无坐标即不看距离）", () => {
    const sameDay = classifyTrip({ name: "椰梦长廊" }, { name: "鹿回头", coords: null });
    expect(isEligibleClassifyTarget(sameDay.trip, sameDay.sourceVisit, sameDay.targetVisit)).toBe(
      true,
    );
    const crossDay = classifyTrip(
      { name: "椰梦长廊" },
      { name: "鹿回头", coords: null, dayRef: "day_2" },
    );
    expect(isEligibleClassifyTarget(crossDay.trip, crossDay.sourceVisit, crossDay.targetVisit)).toBe(
      false,
    );
  });

  it("目标未排期（dayRef=null 的候选池壳）恒不合格，即使坐标重合", () => {
    const { trip, sourceVisit, targetVisit } = classifyTrip(
      { name: "玻璃栈道" },
      { name: FOREST, dayRef: null },
    );
    expect(isEligibleClassifyTarget(trip, sourceVisit, targetVisit)).toBe(false);
    expect(eligibleClassifyTargets(trip, sourceVisit)).toEqual([]);
  });

  it("源自身不作为目标；普通景点目标不入列", () => {
    const { trip, sourceVisit, targetVisit } = classifyTrip(
      { name: "玻璃栈道" },
      { name: FOREST },
    );
    expect(isEligibleClassifyTarget(trip, sourceVisit, sourceVisit)).toBe(false);
    const ordinaryTarget: Visit = { ...targetVisit, kind: "ordinary", visitMode: "custom" };
    expect(isEligibleClassifyTarget(trip, sourceVisit, ordinaryTarget)).toBe(false);
  });

  it("eligibleClassifyTargets 只返回合格目标（一近一远→仅近的），与按钮显示口径一致", () => {
    const { trip, sourceVisit, targetVisit } = classifyTrip(
      { name: "玻璃栈道" },
      { name: FOREST },
    );
    const farVisit: Visit = { ...targetVisit, visitId: "visit_far", pointRef: "item_far" };
    trip.visits.visit_far = farVisit;
    trip.itemRegistry.item_far = {
      ...itemOf("item_far", WUZHIZHOU),
      coords: POI_COORDS[WUZHIZHOU]!,
    };
    const eligible = eligibleClassifyTargets(trip, sourceVisit);
    expect(eligible.map((v) => v.visitId)).toEqual(["visit_target"]);
    expect(eligible.length > 0).toBe(true);
  });
});
