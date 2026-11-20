import { describe, expect, it } from "vitest";
import type { Item, SourceEvidence, Stop, Trip, Visit } from "@goplay/shared";
import { buildEvidenceMentionScope, normalizeEvidenceName } from "./evidenceScope";

/** 极简证据：范围计算只消费 mentionId 与 extractedName */
function evidenceOf(
  evidenceId: string,
  mentions: Array<{ mentionId: string; extractedName: string | null }>,
): SourceEvidence {
  return {
    evidenceId,
    kind: "note_text",
    noteIndex: null,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions: mentions.map((entry) => ({
      mentionId: entry.mentionId,
      text: "",
      quoteText: `Q_${entry.mentionId}`,
      bbox: null,
      extractedName: entry.extractedName,
      locationHint: null,
      modelSummary: null,
    })),
  };
}

function stopOf(
  stopId: string,
  name: string,
  refs: string[],
  evidenceRefs: string[] = ["ev_1"],
): Stop {
  return {
    stopId,
    state: "attached",
    visitRef: "visit_1",
    suggestedVisitRef: null,
    matchedPointRef: null,
    customName: name,
    order: 0,
    suggestMinutes: null,
    locationHint: null,
    ticketRelation: "unknown",
    sourceEvidenceRefs: evidenceRefs,
    sourceMentionRefs: refs,
    userAdjusted: false,
    removedFromOrder: null,
    removedAt: null,
  };
}

function visitOf(visitId: string, overrides: Partial<Visit> = {}): Visit {
  return {
    visitId,
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
    effectiveMinutes: 90,
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

function itemOf(itemId: string, name: string, evidenceRefs: string[] = []): Item {
  return {
    itemId,
    name,
    origin: "custom",
    providerId: null,
    address: null,
    category: null,
    coords: null,
    suggestMinutes: null,
    mainPic: null,
    ticketInfo: null,
    jumpUrl: null,
    sourceEvidenceRefs: evidenceRefs,
  };
}

function tripOf(parts: {
  evidences?: Record<string, SourceEvidence>;
  items?: Record<string, Item>;
  visits?: Record<string, Visit>;
  stops?: Record<string, Stop>;
}): Trip {
  return {
    tripId: "trip-scope",
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
    itemRegistry: parts.items ?? {},
    hotelRegistry: {},
    visits: parts.visits ?? {},
    stops: parts.stops ?? {},
    evidences: parts.evidences ?? {},
    globalCandidateRefs: [],
    pendingStopRefs: [],
    relationshipSuggestions: {},
    guideSources: {},
    constraints: [],
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
  };
}

describe("normalizeEvidenceName（名称规范化）", () => {
  it("去成对括号内容、空白并转小写", () => {
    expect(normalizeEvidenceName("蜈支洲岛（Wuzhizhou）")).toBe("蜈支洲岛");
    expect(normalizeEvidenceName("  Coconut   Dream ")).toBe("coconutdream");
    expect(normalizeEvidenceName("椰梦长廊·三亚湾")).toBe("椰梦长廊·三亚湾");
  });

  it("显式别名解析为正式名（Task #233）", () => {
    expect(normalizeEvidenceName("亚龙湾森林公园")).toBe("亚龙湾热带天堂森林公园");
    expect(normalizeEvidenceName("亚龙湾热带森林公园（含门票）")).toBe("亚龙湾热带天堂森林公园");
    expect(normalizeEvidenceName("亚龙湾海滩")).toBe("亚龙湾海滩");
  });
});

describe("buildEvidenceMentionScope（任务 116 提及范围）", () => {
  it("精确模式：有可解析 ref 的实体严格按 ref 筛选，不做名称兜底", () => {
    const trip = tripOf({
      evidences: {
        ev_1: evidenceOf("ev_1", [
          { mentionId: "m_1", extractedName: "椰梦长廊" },
          { mentionId: "m_2", extractedName: "椰梦长廊" }, // 同名另一条，未被 ref 指向
          { mentionId: "m_3", extractedName: "天涯海角" },
        ]),
      },
      stops: { stop_1: stopOf("stop_1", "椰梦长廊", ["ev_1:m_1"]) },
    });
    const scope = buildEvidenceMentionScope(trip, trip.stops.stop_1, undefined);
    expect(scope.evidenceIds).toEqual(["ev_1"]);
    expect(scope.preciseRefs.has("ev_1:m_1")).toBe(true);
    expect(scope.isVisible("ev_1", trip.evidences.ev_1.mentions[0]!)).toBe(true);
    expect(scope.isVisible("ev_1", trip.evidences.ev_1.mentions[1]!)).toBe(false);
    expect(scope.isVisible("ev_1", trip.evidences.ev_1.mentions[2]!)).toBe(false);
  });

  it("悬空精确 ref（指向不存在的提及）整体降级为名称匹配", () => {
    const trip = tripOf({
      evidences: {
        ev_1: evidenceOf("ev_1", [
          { mentionId: "m_1", extractedName: "椰梦长廊" },
          { mentionId: "m_2", extractedName: "天涯海角" },
        ]),
      },
      stops: { stop_1: stopOf("stop_1", "椰梦长廊", ["ev_1:m_gone"]) },
    });
    const scope = buildEvidenceMentionScope(trip, trip.stops.stop_1, undefined);
    expect(scope.preciseRefs.size).toBe(0);
    expect(scope.evidenceIds).toEqual(["ev_1"]);
    expect(scope.isVisible("ev_1", trip.evidences.ev_1.mentions[0]!)).toBe(true);
    expect(scope.isVisible("ev_1", trip.evidences.ev_1.mentions[1]!)).toBe(false);
  });

  it("降级名称匹配：规范化相等或 extractedName 整体包含目标名；单字包含不误命中", () => {
    const trip = tripOf({
      evidences: {
        ev_1: evidenceOf("ev_1", [
          { mentionId: "m_1", extractedName: "三亚蜈支洲岛" }, // extractedName 包含目标名
          { mentionId: "m_2", extractedName: "蜈支洲岛" }, // 精确相等
          { mentionId: "m_3", extractedName: "湾" }, // 单字，包含匹配被防护
        ]),
      },
      stops: { stop_1: stopOf("stop_1", "蜈支洲岛", []) },
    });
    const scope = buildEvidenceMentionScope(trip, trip.stops.stop_1, undefined);
    expect(scope.isVisible("ev_1", trip.evidences.ev_1.mentions[0]!)).toBe(true);
    expect(scope.isVisible("ev_1", trip.evidences.ev_1.mentions[1]!)).toBe(true);
    expect(scope.isVisible("ev_1", trip.evidences.ev_1.mentions[2]!)).toBe(false);
  });

  it("降级名称匹配：目标名（去括号后）整体包含 extractedName 同样命中", () => {
    // 飞猪全称「蜈支洲岛旅游区（Wuzhizhou Island）」 vs 攻略简称「蜈支洲岛」
    const trip = tripOf({
      evidences: {
        ev_1: evidenceOf("ev_1", [
          { mentionId: "m_1", extractedName: "蜈支洲岛" },
          { mentionId: "m_2", extractedName: "天涯海角" },
        ]),
      },
      stops: { stop_1: stopOf("stop_1", "蜈支洲岛旅游区（Wuzhizhou Island）", []) },
    });
    const scope = buildEvidenceMentionScope(trip, trip.stops.stop_1, undefined);
    expect(scope.isVisible("ev_1", trip.evidences.ev_1.mentions[0]!)).toBe(true);
    expect(scope.isVisible("ev_1", trip.evidences.ev_1.mentions[1]!)).toBe(false);
  });

  it("降级只认候选证据：sourceEvidenceRefs 之外的证据即使同名提及也不进入", () => {
    const trip = tripOf({
      evidences: {
        ev_1: evidenceOf("ev_1", [{ mentionId: "m_1", extractedName: "椰梦长廊" }]),
        ev_2: evidenceOf("ev_2", [{ mentionId: "m_9", extractedName: "椰梦长廊" }]),
      },
      stops: { stop_1: stopOf("stop_1", "椰梦长廊", [], ["ev_1"]) },
    });
    const scope = buildEvidenceMentionScope(trip, trip.stops.stop_1, undefined);
    expect(scope.evidenceIds).toEqual(["ev_1"]);
    expect(scope.isVisible("ev_2", trip.evidences.ev_2.mentions[0]!)).toBe(false);
  });

  it("大景点：合并 childStopRefs 的精确 refs，不合并备选玩法", () => {
    const trip = tripOf({
      evidences: {
        ev_1: evidenceOf("ev_1", [
          { mentionId: "m_parent", extractedName: "蜈支洲岛" },
          { mentionId: "m_child", extractedName: "情人桥" },
          { mentionId: "m_alt", extractedName: "观日岩" },
        ]),
      },
      items: { item_1: itemOf("item_1", "蜈支洲岛") },
      visits: {
        visit_1: visitOf("visit_1", {
          kind: "large_attraction",
          sourceMentionRefs: ["ev_1:m_parent"],
          childStopRefs: ["stop_child"],
          alternateStopRefs: ["stop_alt"],
        }),
      },
      stops: {
        stop_child: stopOf("stop_child", "情人桥", ["ev_1:m_child"]),
        stop_alt: stopOf("stop_alt", "观日岩", ["ev_1:m_alt"]),
      },
    });
    const scope = buildEvidenceMentionScope(trip, undefined, trip.visits.visit_1);
    expect(scope.preciseRefs.has("ev_1:m_parent")).toBe(true);
    expect(scope.preciseRefs.has("ev_1:m_child")).toBe(true);
    expect(scope.preciseRefs.has("ev_1:m_alt")).toBe(false);
    expect(scope.isVisible("ev_1", trip.evidences.ev_1.mentions[2]!)).toBe(false);
  });

  it("Stop 通道不合并父 Visit：父提及不因子 Stop 打开而可见", () => {
    const trip = tripOf({
      evidences: {
        ev_1: evidenceOf("ev_1", [
          { mentionId: "m_parent", extractedName: "蜈支洲岛" },
          { mentionId: "m_child", extractedName: "情人桥" },
        ]),
      },
      items: { item_1: itemOf("item_1", "蜈支洲岛") },
      visits: {
        visit_1: visitOf("visit_1", {
          kind: "large_attraction",
          sourceMentionRefs: ["ev_1:m_parent"],
          childStopRefs: ["stop_child"],
        }),
      },
      stops: { stop_child: stopOf("stop_child", "情人桥", ["ev_1:m_child"]) },
    });
    const scope = buildEvidenceMentionScope(trip, trip.stops.stop_child, undefined);
    expect(scope.preciseRefs.has("ev_1:m_child")).toBe(true);
    expect(scope.isVisible("ev_1", trip.evidences.ev_1.mentions[0]!)).toBe(false);
  });

  it("降级名称匹配：攻略简称提及并入官方名 Visit，海滩提及不并入（Task #233）", () => {
    const trip = tripOf({
      evidences: {
        ev_1: evidenceOf("ev_1", [
          { mentionId: "m_alias", extractedName: "亚龙湾森林公园" },
          { mentionId: "m_beach", extractedName: "亚龙湾海滩" },
        ]),
      },
      items: { item_1: itemOf("item_1", "亚龙湾热带天堂森林公园", ["ev_1"]) },
      visits: { visit_1: visitOf("visit_1", { kind: "large_attraction" }) },
    });
    const scope = buildEvidenceMentionScope(trip, undefined, trip.visits.visit_1);
    expect(scope.preciseRefs.size).toBe(0);
    expect(scope.evidenceIds).toEqual(["ev_1"]);
    expect(scope.isVisible("ev_1", trip.evidences.ev_1.mentions[0]!)).toBe(true);
    expect(scope.isVisible("ev_1", trip.evidences.ev_1.mentions[1]!)).toBe(false);
  });

  it("Visit 降级候选取关联 Item.sourceEvidenceRefs；无任何匹配时范围为空", () => {
    const trip = tripOf({
      evidences: {
        ev_1: evidenceOf("ev_1", [{ mentionId: "m_1", extractedName: "椰梦长廊" }]),
      },
      items: { item_1: itemOf("item_1", "椰梦长廊", ["ev_1"]) },
      visits: { visit_1: visitOf("visit_1") },
    });
    const matched = buildEvidenceMentionScope(trip, undefined, trip.visits.visit_1);
    expect(matched.evidenceIds).toEqual(["ev_1"]);
    expect(matched.isVisible("ev_1", trip.evidences.ev_1.mentions[0]!)).toBe(true);

    // Item 无证据引用（候选为空）→ 无法降级 → 空范围（调用方展示空态）
    const empty = tripOf({
      evidences: { ev_1: evidenceOf("ev_1", [{ mentionId: "m_1", extractedName: "椰梦长廊" }]) },
      items: { item_1: itemOf("item_1", "椰梦长廊") },
      visits: { visit_1: visitOf("visit_1") },
    });
    const emptyScope = buildEvidenceMentionScope(empty, undefined, empty.visits.visit_1);
    expect(emptyScope.evidenceIds).toEqual([]);
    expect(emptyScope.preciseRefs.size).toBe(0);
  });
});
