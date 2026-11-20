import { describe, expect, it } from "vitest";
import type { GuideSource, Item, SourceEvidence, Stop, Trip, Visit } from "@goplay/shared";
import { resolveEntitySourceLinks } from "./sourceLinks";

/**
 * 任务 124：灰色原文入口的来源解析规则。范围（哪些证据算「本点位的」）
 * 完全复用 buildEvidenceMentionScope，这里重点验证证据 → GuideSource →
 * sourceUrl/canonicalUrl 的解析、去重与层级聚合/隔离。
 */

/** 极简证据：解析只消费 mentionId 与 extractedName */
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

function sourceOf(sourceId: string, overrides: Partial<GuideSource> = {}): GuideSource {
  return {
    sourceId,
    sourceVersion: 1,
    inputKind: "link",
    active: true,
    status: "ready",
    evidenceRefs: [],
    mentionRefs: [],
    imageProgress: { total: 0, completed: 0, failed: 0, images: [] },
    importedAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    ...overrides,
  };
}

function tripOf(parts: {
  evidences?: Record<string, SourceEvidence>;
  items?: Record<string, Item>;
  visits?: Record<string, Visit>;
  stops?: Record<string, Stop>;
  guideSources?: Record<string, GuideSource>;
}): Trip {
  return {
    tripId: "trip-links",
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
    guideSources: parts.guideSources ?? {},
    constraints: [],
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
  };
}

describe("resolveEntitySourceLinks（任务 124 外部原链解析）", () => {
  it("单源：sourceUrl 直接作为链接，标题取来源展示标题", () => {
    const trip = tripOf({
      evidences: {
        ev_1: evidenceOf("ev_1", [{ mentionId: "m_1", extractedName: "椰梦长廊" }]),
      },
      stops: { stop_1: stopOf("stop_1", "椰梦长廊", ["ev_1:m_1"]) },
      guideSources: {
        s_1: sourceOf("s_1", {
          title: "三亚两日游攻略",
          sourceUrl: "https://www.xiaohongshu.com/explore/abc",
          evidenceRefs: ["ev_1"],
        }),
      },
    });
    expect(resolveEntitySourceLinks(trip, trip.stops.stop_1, undefined)).toEqual([
      {
        sourceId: "s_1",
        title: "三亚两日游攻略",
        url: "https://www.xiaohongshu.com/explore/abc",
      },
    ]);
  });

  it("sourceUrl 缺失时回退 canonicalUrl；空白 sourceUrl 视为缺失", () => {
    const sharedParts = {
      evidences: {
        ev_1: evidenceOf("ev_1", [{ mentionId: "m_1", extractedName: "椰梦长廊" }]),
      },
      stops: { stop_1: stopOf("stop_1", "椰梦长廊", ["ev_1:m_1"]) },
    };
    const canonicalOnly = tripOf({
      ...sharedParts,
      guideSources: {
        s_1: sourceOf("s_1", {
          canonicalUrl: "https://www.xiaohongshu.com/explore/canonical",
          evidenceRefs: ["ev_1"],
        }),
      },
    });
    expect(resolveEntitySourceLinks(canonicalOnly, canonicalOnly.stops.stop_1, undefined)).toEqual([
      {
        sourceId: "s_1",
        title: "攻略链接",
        url: "https://www.xiaohongshu.com/explore/canonical",
      },
    ]);

    // 空白串不算外部链接，仍回退 canonicalUrl
    const blankSourceUrl = tripOf({
      ...sharedParts,
      guideSources: {
        s_2: sourceOf("s_2", {
          sourceUrl: "   ",
          canonicalUrl: "https://www.xiaohongshu.com/explore/canonical2",
          evidenceRefs: ["ev_1"],
        }),
      },
    });
    const blankLinks = resolveEntitySourceLinks(blankSourceUrl, blankSourceUrl.stops.stop_1, undefined);
    expect(blankLinks).toHaveLength(1);
    expect(blankLinks[0]?.sourceId).toBe("s_2");
    expect(blankLinks[0]?.url).toBe("https://www.xiaohongshu.com/explore/canonical2");
  });

  it("无外部链接的 text/images 来源：返回空，入口应整体隐藏", () => {
    const trip = tripOf({
      evidences: {
        ev_1: evidenceOf("ev_1", [{ mentionId: "m_1", extractedName: "椰梦长廊" }]),
      },
      stops: { stop_1: stopOf("stop_1", "椰梦长廊", ["ev_1:m_1"]) },
      guideSources: {
        s_text: sourceOf("s_text", {
          inputKind: "text",
          status: "ready",
          evidenceRefs: ["ev_1"],
        }),
      },
    });
    expect(resolveEntitySourceLinks(trip, trip.stops.stop_1, undefined)).toEqual([]);
  });

  it("多来源：按证据顺序列出、按 URL 去重并保留各自标题", () => {
    const trip = tripOf({
      evidences: {
        ev_1: evidenceOf("ev_1", [{ mentionId: "m_1", extractedName: "椰梦长廊" }]),
        ev_2: evidenceOf("ev_2", [{ mentionId: "m_2", extractedName: "椰梦长廊" }]),
        ev_3: evidenceOf("ev_3", [{ mentionId: "m_3", extractedName: "椰梦长廊" }]),
      },
      visits: {
        visit_1: visitOf("visit_1", {
          sourceMentionRefs: ["ev_1:m_1", "ev_2:m_2", "ev_3:m_3"],
        }),
      },
      guideSources: {
        s_1: sourceOf("s_1", {
          title: "攻略A",
          sourceUrl: "https://a.example/1",
          evidenceRefs: ["ev_1"],
        }),
        s_2: sourceOf("s_2", {
          title: "攻略B",
          canonicalUrl: "https://b.example/2",
          evidenceRefs: ["ev_2"],
        }),
        s_3: sourceOf("s_3", {
          title: "攻略C（与A同链）",
          sourceUrl: "https://a.example/1",
          evidenceRefs: ["ev_3"],
        }),
      },
    });
    expect(resolveEntitySourceLinks(trip, undefined, trip.visits.visit_1)).toEqual([
      { sourceId: "s_1", title: "攻略A", url: "https://a.example/1" },
      { sourceId: "s_2", title: "攻略B", url: "https://b.example/2" },
    ]);
  });

  it("大景点聚合：父卡与内部玩法来源合并，备选玩法与无来源素材不并入", () => {
    const trip = tripOf({
      evidences: {
        ev_p: evidenceOf("ev_p", [{ mentionId: "m_p", extractedName: "蜈支洲岛" }]),
        ev_c: evidenceOf("ev_c", [{ mentionId: "m_c", extractedName: "情人桥" }]),
        ev_alt: evidenceOf("ev_alt", [{ mentionId: "m_alt", extractedName: "观日岩" }]),
        ev_legacy: evidenceOf("ev_legacy", [{ mentionId: "m_l", extractedName: "老素材" }]),
      },
      items: { item_1: itemOf("item_1", "蜈支洲岛") },
      visits: {
        visit_1: visitOf("visit_1", {
          kind: "large_attraction",
          sourceMentionRefs: ["ev_p:m_p"],
          childStopRefs: ["stop_child", "stop_legacy"],
          alternateStopRefs: ["stop_alt"],
        }),
      },
      stops: {
        stop_child: stopOf("stop_child", "情人桥", ["ev_c:m_c"], ["ev_c"]),
        stop_alt: stopOf("stop_alt", "观日岩", ["ev_alt:m_alt"], ["ev_alt"]),
        stop_legacy: stopOf("stop_legacy", "老素材", ["ev_legacy:m_l"], ["ev_legacy"]),
      },
      guideSources: {
        s_p: sourceOf("s_p", {
          title: "蜈支洲岛整岛攻略",
          sourceUrl: "https://p.example/1",
          evidenceRefs: ["ev_p"],
        }),
        s_c: sourceOf("s_c", {
          title: "情人桥小众玩法",
          sourceUrl: "https://c.example/2",
          evidenceRefs: ["ev_c"],
        }),
        s_alt: sourceOf("s_alt", {
          title: "备选玩法来源（不应出现）",
          sourceUrl: "https://alt.example/3",
          evidenceRefs: ["ev_alt"],
        }),
      },
    });
    expect(resolveEntitySourceLinks(trip, undefined, trip.visits.visit_1)).toEqual([
      { sourceId: "s_p", title: "蜈支洲岛整岛攻略", url: "https://p.example/1" },
      { sourceId: "s_c", title: "情人桥小众玩法", url: "https://c.example/2" },
    ]);
  });

  it("普通景点隔离：只含自身关联来源，不含其他点位来源", () => {
    const trip = tripOf({
      evidences: {
        ev_1: evidenceOf("ev_1", [{ mentionId: "m_1", extractedName: "椰梦长廊" }]),
        ev_2: evidenceOf("ev_2", [{ mentionId: "m_2", extractedName: "天涯海角" }]),
        ev_3: evidenceOf("ev_3", [{ mentionId: "m_3", extractedName: "西岛" }]),
      },
      items: { item_1: itemOf("item_1", "椰梦长廊") },
      visits: {
        visit_1: visitOf("visit_1", { pointRef: "item_1", sourceMentionRefs: ["ev_1:m_1"] }),
        visit_2: visitOf("visit_2", { sourceMentionRefs: ["ev_2:m_2"] }),
      },
      stops: { stop_x: stopOf("stop_x", "西岛", ["ev_3:m_3"], ["ev_3"]) },
      guideSources: {
        s_1: sourceOf("s_1", {
          title: "椰梦长廊来源",
          sourceUrl: "https://yemeng.example/1",
          evidenceRefs: ["ev_1"],
        }),
        s_2: sourceOf("s_2", {
          title: "天涯海角来源",
          sourceUrl: "https://tianya.example/2",
          evidenceRefs: ["ev_2"],
        }),
        s_3: sourceOf("s_3", {
          title: "西岛来源",
          sourceUrl: "https://xidao.example/3",
          evidenceRefs: ["ev_3"],
        }),
      },
    });
    expect(resolveEntitySourceLinks(trip, undefined, trip.visits.visit_1)).toEqual([
      { sourceId: "s_1", title: "椰梦长廊来源", url: "https://yemeng.example/1" },
    ]);
  });

  it("Stop 隔离：内部玩法只含自身来源，不合并父 Visit 与兄弟玩法", () => {
    const trip = tripOf({
      evidences: {
        ev_p: evidenceOf("ev_p", [{ mentionId: "m_p", extractedName: "蜈支洲岛" }]),
        ev_a: evidenceOf("ev_a", [{ mentionId: "m_a", extractedName: "情人桥" }]),
        ev_b: evidenceOf("ev_b", [{ mentionId: "m_b", extractedName: "观日岩" }]),
      },
      items: { item_1: itemOf("item_1", "蜈支洲岛") },
      visits: {
        visit_1: visitOf("visit_1", {
          kind: "large_attraction",
          sourceMentionRefs: ["ev_p:m_p"],
          childStopRefs: ["stop_a", "stop_b"],
        }),
      },
      stops: {
        stop_a: stopOf("stop_a", "情人桥", ["ev_a:m_a"], ["ev_a"]),
        stop_b: stopOf("stop_b", "观日岩", ["ev_b:m_b"], ["ev_b"]),
      },
      guideSources: {
        s_p: sourceOf("s_p", {
          title: "父卡来源",
          sourceUrl: "https://p.example/1",
          evidenceRefs: ["ev_p"],
        }),
        s_a: sourceOf("s_a", {
          title: "情人桥来源",
          sourceUrl: "https://a.example/2",
          evidenceRefs: ["ev_a"],
        }),
        s_b: sourceOf("s_b", {
          title: "观日岩来源",
          sourceUrl: "https://b.example/3",
          evidenceRefs: ["ev_b"],
        }),
      },
    });
    expect(resolveEntitySourceLinks(trip, trip.stops.stop_a, undefined)).toEqual([
      { sourceId: "s_a", title: "情人桥来源", url: "https://a.example/2" },
    ]);
  });

  it("旧数据降级：实体缺精确 ref 时按名称降级命中，链接照常解析", () => {
    const trip = tripOf({
      evidences: {
        ev_1: evidenceOf("ev_1", [
          { mentionId: "m_1", extractedName: "蜈支洲岛" },
          { mentionId: "m_2", extractedName: "天涯海角" },
        ]),
      },
      items: { item_1: itemOf("item_1", "蜈支洲岛旅游区", ["ev_1"]) },
      visits: { visit_1: visitOf("visit_1", { pointRef: "item_1" }) },
      guideSources: {
        s_1: sourceOf("s_1", {
          title: "降级命中来源",
          sourceUrl: "https://legacy.example/1",
          evidenceRefs: ["ev_1"],
        }),
      },
    });
    expect(resolveEntitySourceLinks(trip, undefined, trip.visits.visit_1)).toEqual([
      { sourceId: "s_1", title: "降级命中来源", url: "https://legacy.example/1" },
    ]);
  });

  it("老 Trip 无 guideSources 字段：返回空，不报错", () => {
    const trip = tripOf({
      evidences: {
        ev_1: evidenceOf("ev_1", [{ mentionId: "m_1", extractedName: "椰梦长廊" }]),
      },
      stops: { stop_1: stopOf("stop_1", "椰梦长廊", ["ev_1:m_1"]) },
      guideSources: undefined,
    });
    expect(resolveEntitySourceLinks(trip, trip.stops.stop_1, undefined)).toEqual([]);
  });

  it("精确 ref 命中即整篇来源进入：链接是来源级入口，与同篇其他地点无关", () => {
    const trip = tripOf({
      evidences: {
        ev_1: evidenceOf("ev_1", [
          { mentionId: "m_1", extractedName: "椰梦长廊" },
          { mentionId: "m_2", extractedName: "天涯海角" },
        ]),
      },
      stops: { stop_1: stopOf("stop_1", "椰梦长廊", ["ev_1:m_1"]) },
      guideSources: {
        s_1: sourceOf("s_1", {
          title: "同篇含其他地点",
          sourceUrl: "https://mixed.example/1",
          evidenceRefs: ["ev_1"],
        }),
      },
    });
    // 精确 ref 命中 → 范围含 ev_1 → 其归属来源链接整条返回（打开的是整篇原链）
    expect(resolveEntitySourceLinks(trip, trip.stops.stop_1, undefined)).toEqual([
      { sourceId: "s_1", title: "同篇含其他地点", url: "https://mixed.example/1" },
    ]);
  });
});
