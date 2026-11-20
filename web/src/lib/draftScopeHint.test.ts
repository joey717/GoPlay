/**
 * 任务 189：draftScopeHint 生成前影响范围预判测试（纯函数，离线）。
 *
 * 覆盖：
 * - day / attraction 入口上下文优先（与服务端 resolveDraftScope 规则 2 一致）；
 * - 证据归属近似：所选来源提及命中实体全部落在同一天 → 该天；全部落在同一
 *   大景区（父 visit 或其 child stop）→ 该景区；跨天 / 跨景区 → 整程；
 * - 无关联实体 / 不可用来源 → 整程回退；
 * - label 单句文案（day / attraction / trip 三形态）。
 */
import { describe, expect, it } from "vitest";
import type { GuideSource, SourceEvidence, Stop, Trip, Visit } from "@goplay/shared";
import {
  draftScopeHintLabel,
  resolveDraftScopeHint,
} from "../lib/draftScopeHint";

function makeEvidence(evidenceId: string): SourceEvidence {
  return {
    evidenceId,
    kind: "note_text",
    noteIndex: 1,
    assetRef: null,
    sourceUrl: null,
    ocrText: "正文",
    mentions: [{ mentionId: "m1", text: "亚龙湾", quoteText: "亚龙湾细沙滩", bbox: null, extractedName: "亚龙湾", locationHint: null, modelSummary: null }],
    assetPath: null,
  };
}

function makeVisit(overrides: Partial<Visit> & { visitId: string; pointRef: string }): Visit {
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
    purchaseState: "unknown",
    locked: false,
    userAdjusted: false,
    removedFrom: null,
    removedAt: null,
    ...overrides,
  };
}

function makeStop(overrides: Partial<Stop> & { stopId: string }): Stop {
  return {
    state: "attached",
    visitRef: null,
    suggestedVisitRef: null,
    matchedPointRef: null,
    customName: "情人桥",
    order: 0,
    suggestMinutes: null,
    locationHint: null,
    ticketRelation: "unknown",
    sourceEvidenceRefs: [],
    sourceMentionRefs: [],
    userAdjusted: false,
    removedFromOrder: null,
    removedAt: null,
    ...overrides,
  };
}

function makeSource(overrides: Partial<GuideSource> & { sourceId: string }): GuideSource {
  return {
    sourceVersion: 1,
    inputKind: "text",
    active: true,
    status: "ready",
    evidenceRefs: ["ev_1"],
    mentionRefs: [],
    imageProgress: { total: 0, completed: 0, failed: 0, images: [] },
    importedAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    ...overrides,
  };
}

interface FixtureOptions {
  /** Day1 / Day2 各排一个普通景点；额外提供一个大景区（挂在 Day1） */
  visits?: Visit[];
  stops?: Stop[];
  guideSources?: Record<string, GuideSource>;
}

function makeTrip(options: FixtureOptions = {}): Trip {
  const day1 = makeVisit({ visitId: "visit_d1", pointRef: "item_d1", dayRef: "day_1" });
  const day2 = makeVisit({ visitId: "visit_d2", pointRef: "item_d2", dayRef: "day_2" });
  const attraction = makeVisit({
    visitId: "visit_big",
    pointRef: "item_big",
    dayRef: "day_1",
    kind: "large_attraction",
    visitMode: "full_day",
    childStopRefs: ["stop_child"],
  });
  const visits = options.visits ?? [day1, day2, attraction];
  return {
    tripId: "trip-test",
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
        scheduleVisitRefs: ["visit_d1", "visit_big"],
        lodging: null,
      },
      day_2: {
        dayId: "day_2",
        dayIndex: 2,
        date: "2026-11-09",
        departTime: null,
        departTimeOverridden: false,
        scheduleVisitRefs: ["visit_d2"],
        lodging: null,
      },
    },
    lodgings: {},
    itemRegistry: {
      item_d1: { itemId: "item_d1", name: "亚龙湾", category: "景点", address: null, sourceEvidenceRefs: [] } as never,
      item_d2: { itemId: "item_d2", name: "第一市场", category: "景点", address: null, sourceEvidenceRefs: [] } as never,
      item_big: { itemId: "item_big", name: "蜈支洲岛", category: "景点", address: null, sourceEvidenceRefs: [] } as never,
    },
    hotelRegistry: {},
    visits: Object.fromEntries(visits.map((visit) => [visit.visitId, visit])),
    stops: Object.fromEntries((options.stops ?? []).map((stop) => [stop.stopId, stop])),
    evidences: { ev_1: makeEvidence("ev_1") },
    globalCandidateRefs: [],
    pendingStopRefs: [],
    relationshipSuggestions: {},
    guideSources: options.guideSources ?? {},
    constraints: [],
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
  };
}

describe("resolveDraftScopeHint（任务 189 生成前范围预判）", () => {
  /** 带单一暂存来源的标准夹具：来源提及 refs 由调用方定制 */
  function tripWithSource(
    mentionRefs: string[],
    options: FixtureOptions = {},
  ): Trip {
    return makeTrip({
      ...options,
      guideSources: {
        src_new: makeSource({ sourceId: "src_new", mentionRefs }),
      },
    });
  }

  it("day 入口：优先该天（与服务端规则 2 一致，不看证据归属）", () => {
    const trip = makeTrip();
    const result = resolveDraftScopeHint(trip, [], { type: "day", dayIndex: 2 });
    expect(result).toEqual({ kind: "day", dayIndex: 2 });
  });

  it("day 入口天号越界：降级继续证据归属（不误报非法天）", () => {
    const trip = makeTrip();
    const result = resolveDraftScopeHint(trip, [], { type: "day", dayIndex: 9 });
    expect(result).toEqual({ kind: "trip" });
  });

  it("attraction 入口：优先该大景区并解析名称", () => {
    const trip = makeTrip();
    const result = resolveDraftScopeHint(trip, [], { type: "attraction", visitId: "visit_big" });
    expect(result).toEqual({ kind: "attraction", visitId: "visit_big", name: "蜈支洲岛" });
  });

  it("global + 所选来源提及全部落在 Day1 的景点：收敛 Day1", () => {
    const trip = tripWithSource(["ev_1:m1"]);
    trip.visits.visit_d1!.sourceMentionRefs = ["ev_1:m1"];
    const result = resolveDraftScopeHint(trip, ["src_new"], undefined);
    expect(result).toEqual({ kind: "day", dayIndex: 1 });
  });

  it("global + 提及全在大景区内部玩法（child stop）：收敛该景区", () => {
    const stop = makeStop({
      stopId: "stop_child",
      visitRef: "visit_big",
      sourceMentionRefs: ["ev_1:m1"],
    });
    const trip = tripWithSource(["ev_1:m1"], { stops: [stop] });
    const result = resolveDraftScopeHint(trip, ["src_new"], undefined);
    expect(result).toEqual({ kind: "attraction", visitId: "visit_big", name: "蜈支洲岛" });
  });

  it("global + 提及跨天（Day1 与 Day2）：回退整程", () => {
    const trip = tripWithSource(["ev_1:m1", "ev_1:m2"]);
    trip.visits.visit_d1!.sourceMentionRefs = ["ev_1:m1"];
    trip.visits.visit_d2!.sourceMentionRefs = ["ev_1:m2"];
    const result = resolveDraftScopeHint(trip, ["src_new"], undefined);
    expect(result).toEqual({ kind: "trip" });
  });

  it("global + 提及同时命中大景区与普通天景点：跨域回退整程", () => {
    const stop = makeStop({
      stopId: "stop_child",
      visitRef: "visit_big",
      sourceMentionRefs: ["ev_1:m1"],
    });
    const trip = tripWithSource(["ev_1:m1", "ev_1:m2"], { stops: [stop] });
    trip.visits.visit_d2!.sourceMentionRefs = ["ev_1:m2"];
    const result = resolveDraftScopeHint(trip, ["src_new"], undefined);
    expect(result).toEqual({ kind: "trip" });
  });

  it("无关联实体（提及未命中任何行程点位）：整程回退", () => {
    const trip = tripWithSource(["ev_1:m9"]); // 无实体持有该 ref
    const result = resolveDraftScopeHint(trip, ["src_new"], undefined);
    expect(result).toEqual({ kind: "trip" });
  });

  it("不可用来源（failed / processing）的提及不参与预判：整程回退", () => {
    const trip = makeTrip({
      guideSources: {
        src_fail: makeSource({ sourceId: "src_fail", status: "failed", mentionRefs: ["ev_1:m1"] }),
      },
    });
    trip.visits.visit_d1!.sourceMentionRefs = ["ev_1:m1"];
    const result = resolveDraftScopeHint(trip, ["src_fail"], undefined);
    expect(result).toEqual({ kind: "trip" });
  });

  it("未选择来源（空数组）：整程回退", () => {
    const trip = makeTrip();
    expect(resolveDraftScopeHint(trip, [], undefined)).toEqual({ kind: "trip" });
  });
});

describe("draftScopeHintLabel（一句范围文案）", () => {
  it("局部入口返回单句文案；整程返回 null 不展示（Task #242 删除冗余文案）", () => {
    expect(draftScopeHintLabel({ kind: "day", dayIndex: 2 })).toBe("将优先优化 Day2 的安排");
    expect(draftScopeHintLabel({ kind: "attraction", visitId: "v", name: "蜈支洲岛" })).toBe(
      "将优先补充「蜈支洲岛」的玩法",
    );
    expect(draftScopeHintLabel({ kind: "trip" })).toBeNull();
  });
});
