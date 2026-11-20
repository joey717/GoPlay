import { describe, expect, it } from "vitest";
import type { GuideSource, Item, SourceEvidence, Trip, Visit } from "@goplay/shared";
import {
  candidateSuggestions,
  isCityPlusGenericCandidateName,
  isParentCardVisit,
  isPlatformOrGenericCandidateName,
  joinTagParts,
  visitModeLabel,
} from "./trip";

function makeItem(overrides: Partial<Item> & Pick<Item, "itemId" | "name">): Item {
  return {
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
    ...overrides,
  };
}

function makeGuideSource(): GuideSource {
  return {
    sourceId: "src_1",
    sourceVersion: 1,
    inputKind: "images",
    active: true,
    status: "ready",
    evidenceRefs: ["ev_1"],
    mentionRefs: [],
    imageProgress: { total: 0, completed: 0, failed: 0, images: [] },
    importedAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
  };
}

const WATERMARK_EVIDENCE: SourceEvidence = {
  evidenceId: "ev_1",
  kind: "screenshot",
  noteIndex: null,
  assetRef: null,
  sourceUrl: null,
  ocrText: "小红书 亚龙湾热带天堂森林公园",
  mentions: [
    {
      mentionId: "m1",
      text: "小红书",
      quoteText: "小红书",
      bbox: null,
      extractedName: "小红书",
      locationHint: null,
      modelSummary: "平台水印，非实际地点",
    },
    {
      mentionId: "m2",
      text: "亚龙湾热带天堂森林公园",
      quoteText: "亚龙湾热带天堂森林公园值得去",
      bbox: null,
      extractedName: "亚龙湾热带天堂森林公园",
      locationHint: null,
      modelSummary: "值得去",
    },
  ],
};

function makeTrip(items: Item[]): Trip {
  return {
    tripId: "trip-filter",
    schemaVersion: 2,
    version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: "2026-11-10", nights: 2 },
    dayRefs: [],
    days: {},
    lodgings: {},
    itemRegistry: Object.fromEntries(items.map((item) => [item.itemId, item])),
    hotelRegistry: {},
    visits: {},
    stops: {},
    evidences: { ev_1: WATERMARK_EVIDENCE },
    globalCandidateRefs: items.map((item) => ({ kind: "point" as const, id: item.itemId })),
    pendingStopRefs: [],
    relationshipSuggestions: {},
    guideSources: { src_1: makeGuideSource() },
    constraints: [],
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
  };
}

describe("候选脏数据纯规则", () => {
  it("平台/媒体词与纯泛化地理词只做 exact 过滤", () => {
    expect(isPlatformOrGenericCandidateName("小红书")).toBe(true);
    expect(isPlatformOrGenericCandidateName("海滩")).toBe(true);
    expect(isPlatformOrGenericCandidateName(" 岛屿 ")).toBe(true);
    expect(isPlatformOrGenericCandidateName("后海海滩")).toBe(false);
    expect(isPlatformOrGenericCandidateName("西岛码头")).toBe(false);
    expect(isPlatformOrGenericCandidateName("第一市场")).toBe(false);
  });

  it("城市 + 单个泛化后缀才视为可疑组合", () => {
    expect(isCityPlusGenericCandidateName("三亚岛", "三亚")).toBe(true);
    expect(isCityPlusGenericCandidateName("三亚湾", "三亚")).toBe(true);
    expect(isCityPlusGenericCandidateName("后海海滩", "三亚")).toBe(false);
    expect(isCityPlusGenericCandidateName("西岛码头", "三亚")).toBe(false);
    expect(isCityPlusGenericCandidateName("第一市场", "三亚")).toBe(false);
  });
});

describe("candidateSuggestions 历史脏数据兜底过滤（Task #107）", () => {
  it("过滤小红书水印、纯泛化词、城市+泛化后缀的 custom 空壳；保留具体点位", () => {
    const items = [
      makeItem({ itemId: "i_xhs", name: "小红书", sourceEvidenceRefs: ["ev_1"] }),
      makeItem({ itemId: "i_beach", name: "海滩" }),
      makeItem({ itemId: "i_sanya_island", name: "三亚岛" }),
      makeItem({ itemId: "i_houhai", name: "后海海滩", address: "三亚市海棠区后海村" }),
      makeItem({ itemId: "i_west_island_pier", name: "西岛码头" }),
      makeItem({ itemId: "i_market", name: "第一市场" }),
      makeItem({
        itemId: "i_sanya_bay",
        name: "三亚湾",
        origin: "fliggy",
        providerId: "fliggy_1",
        address: "三亚市吉阳区三亚湾路",
      }),
      makeItem({
        itemId: "i_yalong",
        name: "亚龙湾热带天堂森林公园",
        address: "亚龙湾国家旅游度假区",
        sourceEvidenceRefs: ["ev_1"],
      }),
    ];
    const suggestions = candidateSuggestions(makeTrip(items));
    const names = suggestions.map((suggestion) => suggestion.name).sort();

    expect(names).toEqual(
      ["亚龙湾热带天堂森林公园", "三亚湾", "后海海滩", "第一市场", "西岛码头"].sort(),
    );
    expect(names).not.toContain("小红书");
    expect(names).not.toContain("海滩");
    expect(names).not.toContain("三亚岛");
  });

  it("address 从 Item.address 透传；custom 的 AI 位置提示同样展示，无地址为 null", () => {
    const items = [
      makeItem({ itemId: "i_custom", name: "第一市场", address: "第一市场入口", sourceEvidenceRefs: ["ev_1"] }),
      makeItem({ itemId: "i_none", name: "西岛码头" }),
    ];
    const suggestions = candidateSuggestions(makeTrip(items));

    expect(suggestions.find((suggestion) => suggestion.name === "第一市场")?.address).toBe("第一市场入口");
    expect(suggestions.find((suggestion) => suggestion.name === "西岛码头")?.address).toBeNull();
  });
});

/**
 * Task #344（PD：「目前发现每个大景区都标了『全天』在景区名字下面的标、
 * 以及 DAY N 里都有，把『全天』二字去掉」）。
 *
 * 「全天」文案的唯一产出点是本文件的 visitModeLabel（shared/src 对「全天」零命中），
 * 4 个渲染调用点：VisitCard 父卡 .tag.clay、DayStrip .dchip .flag、
 * ShareView dayFlag 与 .share-badge。本组用例锁定文案层取值：只去掉「全天」，
 * 「半天」「自定义」原样保留；且空段拼接不得留下悬空的「· 」分隔符。
 */
describe("visitModeLabel / joinTagParts（Task #344 去掉「全天」）", () => {
  function makeVisit(visitMode: Visit["visitMode"]): Visit {
    return {
      visitId: "visit_1",
      dayRef: "day_1",
      pointRef: "item_1",
      kind: "large_attraction",
      visitMode,
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

  it("full_day 不再产出「全天」（返回空串），half_day / custom 两个取值原样保留", () => {
    expect(visitModeLabel(makeVisit("full_day"))).toBe("");
    expect(visitModeLabel(makeVisit("half_day"))).toBe("半天");
    expect(visitModeLabel(makeVisit("custom"))).toBe("自定义");
    // 三个取值均不得包含「全天」（防回归）
    for (const mode of ["full_day", "half_day", "custom"] as const) {
      expect(visitModeLabel(makeVisit(mode))).not.toContain("全天");
    }
  });

  it("joinTagParts：空段丢弃不留悬空「· 」，非空段按「 · 」拼接", () => {
    // Task #346：父卡 clay 标签改为只渲染 mode 段（「大景区」前缀移除，不再走本拼接）；
    // helper 仍供 DayStrip .flag / 分享页 dayFlag 两处共用，这里以景区名样例锁通用拼接语义
    expect(joinTagParts("鹿回头", visitModeLabel(makeVisit("full_day")))).toBe("鹿回头");
    expect(joinTagParts("鹿回头", visitModeLabel(makeVisit("half_day")))).toBe("鹿回头 · 半天");
    expect(joinTagParts("鹿回头", visitModeLabel(makeVisit("custom")))).toBe("鹿回头 · 自定义");
    // Day 条 / 分享页：景区名 + mode 段
    expect(joinTagParts("天涯海角", visitModeLabel(makeVisit("full_day")))).toBe("天涯海角");
    expect(joinTagParts("天涯海角", visitModeLabel(makeVisit("half_day")))).toBe("天涯海角 · 半天");
    // 边界：null / undefined / 纯空白 同为空段；全空时返回空串（调用方据此不渲染）
    expect(joinTagParts("鹿回头", null, undefined, "  ")).toBe("鹿回头");
    expect(joinTagParts("", null)).toBe("");
    expect(joinTagParts()).toBe("");
  });
});

// ===== Task #348（PD 2026-11-04）：父卡渲染判定单点 isParentCardVisit =====
describe("isParentCardVisit（#348 渲染形态由岛内子玩法驱动）", () => {
  it("childStopRefs 为空 / null / undefined 均判非父卡（鹿回头类空壳）", () => {
    expect(isParentCardVisit({ childStopRefs: [] })).toBe(false);
    expect(isParentCardVisit(null)).toBe(false);
    expect(isParentCardVisit(undefined)).toBe(false);
    // childStopRefs 缺失（存量/部分形状）也当作 0 子玩法
    expect(isParentCardVisit({} as Pick<Visit, "childStopRefs">)).toBe(false);
  });

  it("childStopRefs ≥1 判父卡（含悬空 ref：只看声明数量，不校验 stop 是否存在）", () => {
    expect(isParentCardVisit({ childStopRefs: ["stop_a"] })).toBe(true);
    expect(isParentCardVisit({ childStopRefs: ["stop_a", "stop_b"] })).toBe(true);
    // 悬空 ref（stops 中不存在）仍判 true：父卡形态成立，子列表由渲染层另行过滤
    expect(isParentCardVisit({ childStopRefs: ["stop_ghost"] })).toBe(true);
  });

  it("判定只看 childStopRefs、与 kind 无关（kind 降为先验，不再决定渲染形态）", () => {
    // large_attraction 但 0 子 → 非父卡（正是 #348 要消除的空壳父卡）
    expect(isParentCardVisit({ kind: "large_attraction", childStopRefs: [] } as Pick<Visit, "childStopRefs">)).toBe(false);
    // 数据不变量：合法数据中 children≥1 蕴含 kind=large_attraction；函数本身只读 children
    expect(isParentCardVisit({ kind: "large_attraction", childStopRefs: ["stop_a"] } as Pick<Visit, "childStopRefs">)).toBe(true);
  });
});
