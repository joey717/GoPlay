/**
 * 任务 196：resolveEntityPageImages 纯函数单测（web 读取侧页码配图聚合）。
 *
 * 覆盖：golden 多页保序（珊瑚墙 p11 p12 p13）、缺槽/失败不前移（木门歪椰树
 * p2 p8 p9 中 p8 失败）、跨来源防护、来源顺序不可靠全拒、历史证据无 pageRefs
 * 零迁移、多 mention 合并去重（同证据重复页 + 跨来源顺序追加）、明细 assetPath
 * 缺失回退证据字段、Visit 通道（普通卡父级精确 ref）。
 * 全程内存对象，不触网、不落盘。
 */
import { describe, expect, it } from "vitest";
import type {
  EvidenceMention,
  GuideImageProgressEntry,
  GuideSource,
  Item,
  SourceEvidence,
  Stop,
  Trip,
  Visit,
} from "@goplay/shared";
import { resolveEntityPageImages } from "./entityImages";

// ===== 工厂 =====

function makeMention(mentionId: string, extractedName: string, pageRefs?: number[]): EvidenceMention {
  const mention: EvidenceMention = {
    mentionId,
    text: "",
    quoteText: `Q_${mentionId}`,
    bbox: null,
    extractedName,
    locationHint: null,
    modelSummary: null,
  };
  if (pageRefs !== undefined) mention.pageRefs = pageRefs;
  return mention;
}

function makeEvidence(evidenceId: string, mentions: EvidenceMention[]): SourceEvidence {
  return {
    evidenceId,
    kind: "note_text",
    noteIndex: null,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions,
  };
}

function makeScreenshot(evidenceId: string, assetPath?: string): SourceEvidence {
  const evidence = {
    evidenceId,
    kind: "screenshot" as const,
    noteIndex: null,
    assetRef: null,
    sourceUrl: null,
    ocrText: "截图识别文本",
    mentions: [] as EvidenceMention[],
  };
  if (assetPath !== undefined) (evidence as SourceEvidence).assetPath = assetPath;
  return evidence as SourceEvidence;
}

function slot(
  index: number,
  status: GuideImageProgressEntry["status"],
  evidenceId: string | null,
  assetPath?: string,
): GuideImageProgressEntry {
  const entry: GuideImageProgressEntry = { index, status, evidenceId };
  if (assetPath !== undefined) entry.assetPath = assetPath;
  return entry;
}

function makeSource(
  sourceId: string,
  evidenceRefs: string[],
  images: GuideImageProgressEntry[],
): GuideSource {
  const ready = images.filter((entry) => entry.status === "ready").length;
  const failed = images.filter((entry) => entry.status === "failed").length;
  return {
    sourceId,
    sourceVersion: 1,
    inputKind: "link",
    active: true,
    status: "ready",
    evidenceRefs,
    mentionRefs: [],
    imageProgress: { total: images.length, completed: ready, failed, images },
    importedAt: "2026-10-21T00:00:00Z",
    updatedAt: "2026-10-21T00:00:00Z",
  };
}

function makeItem(itemId: string, name: string): Item {
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
    sourceEvidenceRefs: [],
  };
}

function makeStop(
  stopId: string,
  customName: string,
  refs: { mentionRefs?: string[]; evidenceRefs?: string[] } = {},
): Stop {
  return {
    stopId,
    state: "attached",
    visitRef: "visit_1",
    suggestedVisitRef: null,
    matchedPointRef: null,
    customName,
    order: 0,
    suggestMinutes: 60,
    locationHint: null,
    ticketRelation: "unknown",
    sourceEvidenceRefs: refs.evidenceRefs ?? [],
    sourceMentionRefs: refs.mentionRefs ?? [],
    guideSnippets: [],
    userAdjusted: true,
    removedFromOrder: null,
    removedAt: null,
  };
}

function makeVisit(visitId: string, pointRef: string, overrides: Partial<Visit> = {}): Visit {
  return {
    visitId,
    dayRef: "day_1",
    pointRef,
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

function makeTrip(parts: {
  evidences?: Record<string, SourceEvidence>;
  items?: Record<string, Item>;
  visits?: Record<string, Visit>;
  stops?: Record<string, Stop>;
  guideSources?: Record<string, GuideSource>;
}): Trip {
  return {
    tripId: "trip-entity-images",
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
    createdAt: "2026-10-21T00:00:00Z",
    updatedAt: "2026-10-21T00:00:00Z",
  };
}

/** 1..13 顺序槽位；readyPages 内的页 ready 且带明细 assetPath，其余 pending 占位 */
function fixtureImages(readyPages: number[], total = 13): GuideImageProgressEntry[] {
  return Array.from({ length: total }, (_, i) => {
    const index = i + 1;
    if (!readyPages.includes(index)) return slot(index, "pending", null);
    return slot(index, "ready", `ev_img${index}`, pagePath(index));
  });
}

function pagePath(page: number): string {
  return `uploads/t_ei/img-${String(page).padStart(2, "0")}.jpg`;
}

// ===== 用例 =====

describe("resolveEntityPageImages（任务 196 页码关联图）", () => {
  it("golden 珊瑚墙 p11 p12 p13：三条全绑定、保序，首图 = 第一个有效页", () => {
    const stop = makeStop("stop_shh", "珊瑚墙", {
      mentionRefs: ["ev_shh:m_shh"],
      evidenceRefs: ["ev_shh"],
    });
    const trip = makeTrip({
      stops: { stop_shh: stop },
      evidences: { ev_shh: makeEvidence("ev_shh", [makeMention("m_shh", "珊瑚墙", [11, 12, 13])]) },
      guideSources: {
        s_a: makeSource(
          "s_a",
          ["ev_shh", "ev_img11", "ev_img12", "ev_img13"],
          fixtureImages([11, 12, 13]),
        ),
      },
    });

    const images = resolveEntityPageImages(trip, stop, undefined);
    expect([...images.assetPaths]).toEqual([pagePath(11), pagePath(12), pagePath(13)]);
    expect(images.firstAssetPath).toBe(pagePath(11));
  });

  it("缺槽不前移：木门歪椰树 p2 p8 p9，p8 failed → 只绑 p2/p9 且保持页序", () => {
    const stop = makeStop("stop_men", "木门歪椰树", {
      mentionRefs: ["ev_men:m_men"],
      evidenceRefs: ["ev_men"],
    });
    const images = fixtureImages([2, 9]);
    images[7] = slot(8, "failed", null); // download_failed 占位槽保留原始页码
    const trip = makeTrip({
      stops: { stop_men: stop },
      evidences: {
        ev_men: makeEvidence("ev_men", [makeMention("m_men", "木门歪椰树", [2, 8, 9])]),
      },
      guideSources: {
        s_a: makeSource("s_a", ["ev_men", "ev_img2", "ev_img9"], images),
      },
    });

    const resolved = resolveEntityPageImages(trip, stop, undefined);
    expect([...resolved.assetPaths]).toEqual([pagePath(2), pagePath(9)]);
    expect(resolved.firstAssetPath).toBe(pagePath(2));
  });

  it("跨来源防护：槽位 evidenceId 不属于本来源时该页不绑定（不猜相邻 p11）", () => {
    const stop = makeStop("stop_x", "西岛墙", {
      mentionRefs: ["ev_x:m_x"],
      evidenceRefs: ["ev_x"],
    });
    const images = fixtureImages([10, 11]);
    images[9] = slot(10, "ready", "ev_cross", pagePath(10)); // ev_cross 属于另一来源
    const trip = makeTrip({
      stops: { stop_x: stop },
      evidences: {
        ev_x: makeEvidence("ev_x", [makeMention("m_x", "西岛墙", [10, 11])]),
      },
      guideSources: {
        s_a: makeSource("s_a", ["ev_x", "ev_img11"], images),
      },
    });

    const resolved = resolveEntityPageImages(trip, stop, undefined);
    expect([...resolved.assetPaths]).toEqual([pagePath(11)]);
  });

  it("来源顺序不可靠（images.length !== total）：整源拒绝，不绑定任何图", () => {
    const stop = makeStop("stop_o", "情人桥", {
      mentionRefs: ["ev_o:m_o"],
      evidenceRefs: ["ev_o"],
    });
    const images = fixtureImages([6]);
    const source = makeSource("s_a", ["ev_o", "ev_img6"], images);
    source.imageProgress = { total: 15, completed: 1, failed: 0, images }; // 明细被压缩
    const trip = makeTrip({
      stops: { stop_o: stop },
      evidences: { ev_o: makeEvidence("ev_o", [makeMention("m_o", "情人桥", [6])]) },
      guideSources: { s_a: source },
    });

    expect(resolveEntityPageImages(trip, stop, undefined)).toEqual({
      assetPaths: [],
      firstAssetPath: null,
    });
  });

  it("历史证据无 pageRefs：返回空集合（零迁移，不猜测任何图）", () => {
    const stop = makeStop("stop_l", "情人桥", {
      mentionRefs: ["ev_l:m_l"],
      evidenceRefs: ["ev_l"],
    });
    const trip = makeTrip({
      stops: { stop_l: stop },
      evidences: { ev_l: makeEvidence("ev_l", [makeMention("m_l", "情人桥")]) }, // 无 pageRefs 字段
      guideSources: { s_a: makeSource("s_a", ["ev_l", "ev_img6"], fixtureImages([6])) },
    });

    expect(resolveEntityPageImages(trip, stop, undefined)).toEqual({
      assetPaths: [],
      firstAssetPath: null,
    });
  });

  it("多 mention 合并：同证据重复页按路径去重，跨来源证据按证据顺序追加", () => {
    const stop = makeStop("stop_m", "西岛墙", {
      mentionRefs: ["ev_a:m_a1", "ev_a:m_a2", "ev_b:m_b"],
      evidenceRefs: ["ev_a", "ev_b"],
    });
    const trip = makeTrip({
      stops: { stop_m: stop },
      evidences: {
        ev_a: makeEvidence("ev_a", [
          makeMention("m_a1", "西岛墙", [6]),
          makeMention("m_a2", "西岛墙", [6]),
        ]),
        ev_b: makeEvidence("ev_b", [makeMention("m_b", "西岛墙", [6])]),
      },
      guideSources: {
        s_a: makeSource("s_a", ["ev_a", "ev_img6"], fixtureImages([6])),
        s_b: makeSource("s_b", ["ev_b", "ev_b6"], [
          ...Array.from({ length: 5 }, (_, i) => slot(i + 1, "pending" as const, null)),
          slot(6, "ready", "ev_b6", "uploads/t_ei/other-06.jpg"),
          ...Array.from({ length: 2 }, (_, i) => slot(i + 7, "pending" as const, null)),
        ]),
      },
    });

    const resolved = resolveEntityPageImages(trip, stop, undefined);
    expect([...resolved.assetPaths]).toEqual([pagePath(6), "uploads/t_ei/other-06.jpg"]);
    expect(resolved.firstAssetPath).toBe(pagePath(6));
  });

  it("明细 assetPath 缺失：回退证据字段 assetPath（历史来源兼容）", () => {
    const stop = makeStop("stop_dt", "灯塔", {
      mentionRefs: ["ev_note:m_n"],
      evidenceRefs: ["ev_note"],
    });
    const images = fixtureImages([7]);
    images[6] = slot(7, "ready", "ev_img7"); // 明细不带 assetPath
    const trip = makeTrip({
      stops: { stop_dt: stop },
      evidences: {
        ev_note: makeEvidence("ev_note", [makeMention("m_n", "灯塔", [7])]),
        ev_img7: makeScreenshot("ev_img7", "uploads/t_ei/evidence-07.jpg"),
      },
      guideSources: { s_a: makeSource("s_a", ["ev_note", "ev_img7"], images) },
    });

    const resolved = resolveEntityPageImages(trip, stop, undefined);
    expect(resolved.firstAssetPath).toBe("uploads/t_ei/evidence-07.jpg");
  });

  it("Visit 通道（普通卡父级）：精确 mention ref 同样解析页码关联图", () => {
    const visit = makeVisit("visit_1", "item_1", { sourceMentionRefs: ["ev_v:m_v"] });
    const trip = makeTrip({
      items: { item_1: makeItem("item_1", "情人桥") },
      visits: { visit_1: visit },
      evidences: { ev_v: makeEvidence("ev_v", [makeMention("m_v", "情人桥", [3])]) },
      guideSources: { s_a: makeSource("s_a", ["ev_v", "ev_img3"], fixtureImages([3])) },
    });

    const resolved = resolveEntityPageImages(trip, undefined, visit);
    expect(resolved.firstAssetPath).toBe(pagePath(3));
  });
});
