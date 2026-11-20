/**
 * 任务 186：resolveSourceOriginal 纯函数测试——原文回看内容的解析口径。
 *
 * 重点覆盖：
 * - 文字来源 sourceText 消费 / 历史来源缺失降级 / 空白文本不冒充原文；
 * - 截图来源 assetPath 明细优先、证据 assetPath 回退（历史兼容）、按 index 升序；
 * - externalUrl 的 sourceUrl > canonicalUrl > null 优先级与空白串口径；
 * - hasSourceOriginalContent 的入口门控判定。
 */
import { describe, expect, it } from "vitest";
import type { GuideSource, SourceEvidence, Trip } from "@goplay/shared";
import { hasSourceOriginalContent, resolveSourceOriginal } from "./sourceOriginal";

function makeEvidence(evidenceId: string, assetPath: string | null): SourceEvidence {
  return {
    evidenceId,
    kind: "screenshot",
    noteIndex: null,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions: [],
    assetPath,
  };
}

function makeTrip(evidences: Record<string, SourceEvidence> = {}): Trip {
  return {
    tripId: "trip-test",
    schemaVersion: 2,
    version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: "2026-11-10", nights: 2 },
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
    itemRegistry: {},
    hotelRegistry: {},
    visits: {},
    stops: {},
    evidences,
    globalCandidateRefs: [],
    pendingStopRefs: [],
    relationshipSuggestions: {},
    guideSources: {},
    constraints: [],
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
  };
}

function makeSource(overrides: Partial<GuideSource> = {}): GuideSource {
  return {
    sourceId: "src_1",
    sourceVersion: 1,
    inputKind: "text",
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

describe("resolveSourceOriginal：文字来源 sourceText", () => {
  it("text 来源有 sourceText 时返回完整原文", () => {
    const trip = makeTrip();
    const source = makeSource({ inputKind: "text", sourceText: "第一天 亚龙湾\n第二天 蜈支洲岛" });
    const original = resolveSourceOriginal(trip, source);
    expect(original.text).toBe("第一天 亚龙湾\n第二天 蜈支洲岛");
    expect(original.images).toEqual([]);
  });

  it("历史 text 来源缺 sourceText 时 text 为 null（零迁移降级，不报错）", () => {
    const original = resolveSourceOriginal(makeTrip(), makeSource({ inputKind: "text" }));
    expect(original.text).toBeNull();
  });

  it("sourceText 为纯空白时按无原文处理（不冒充原文）", () => {
    const original = resolveSourceOriginal(
      makeTrip(),
      makeSource({ inputKind: "text", sourceText: "   \n\t  " }),
    );
    expect(original.text).toBeNull();
  });

  it("非 text 来源即使字段被误写入 sourceText 也不消费（只有文字来源有文本原文）", () => {
    const original = resolveSourceOriginal(
      makeTrip(),
      makeSource({ inputKind: "images", sourceText: "不应被读到的文本" }),
    );
    expect(original.text).toBeNull();
  });
});

describe("resolveSourceOriginal：截图来源原图收集", () => {
  it("优先取明细自带的 assetPath（提交落盘即写入，不依赖证据就绪）", () => {
    const trip = makeTrip({
      ev_1: makeEvidence("ev_1", "uploads/trip-test/ev_1.jpg"),
    });
    const source = makeSource({
      inputKind: "images",
      imageProgress: {
        total: 1,
        completed: 1,
        failed: 0,
        images: [{ index: 1, status: "ready", evidenceId: "ev_1", assetPath: "uploads/trip-test/ev_shot_abc12345.png" }],
      },
    });
    const original = resolveSourceOriginal(trip, source);
    expect(original.images).toEqual([
      { index: 1, path: "uploads/trip-test/ev_shot_abc12345.png" },
    ]);
  });

  it("明细 assetPath 缺失（历史来源）回退证据的 assetPath", () => {
    const trip = makeTrip({ ev_1: makeEvidence("ev_1", "uploads/trip-test/ev_1.jpg") });
    const source = makeSource({
      inputKind: "images",
      imageProgress: {
        total: 1,
        completed: 1,
        failed: 0,
        images: [{ index: 1, status: "ready", evidenceId: "ev_1" }],
      },
    });
    const original = resolveSourceOriginal(trip, source);
    expect(original.images).toEqual([{ index: 1, path: "uploads/trip-test/ev_1.jpg" }]);
  });

  it("明细与证据都拿不到 assetPath 时该图不展示（历史来源无资产优雅降级）", () => {
    const trip = makeTrip({ ev_1: makeEvidence("ev_1", null) });
    const source = makeSource({
      inputKind: "images",
      imageProgress: {
        total: 2,
        completed: 1,
        failed: 1,
        images: [
          { index: 1, status: "ready", evidenceId: "ev_1" },
          { index: 2, status: "pending", evidenceId: null },
        ],
      },
    });
    const original = resolveSourceOriginal(trip, source);
    expect(original.images).toEqual([]);
  });

  it("按 index 升序输出（防御持久化乱序），保持上传顺序", () => {
    const trip = makeTrip({
      ev_1: makeEvidence("ev_1", "uploads/trip-test/ev_1.jpg"),
      ev_2: makeEvidence("ev_2", "uploads/trip-test/ev_2.jpg"),
    });
    const source = makeSource({
      inputKind: "images",
      imageProgress: {
        total: 2,
        completed: 2,
        failed: 0,
        images: [
          { index: 2, status: "ready", evidenceId: "ev_2", assetPath: "uploads/trip-test/ev_shot_b.png" },
          { index: 1, status: "ready", evidenceId: "ev_1", assetPath: "uploads/trip-test/ev_shot_a.png" },
        ],
      },
    });
    const original = resolveSourceOriginal(trip, source);
    expect(original.images.map((image) => image.index)).toEqual([1, 2]);
    expect(original.images.map((image) => image.path)).toEqual([
      "uploads/trip-test/ev_shot_a.png",
      "uploads/trip-test/ev_shot_b.png",
    ]);
  });

  it("evidenceId 为 null（证据未提交）时仍可用明细 assetPath 回看", () => {
    const source = makeSource({
      inputKind: "images",
      imageProgress: {
        total: 1,
        completed: 0,
        failed: 0,
        images: [{ index: 1, status: "pending", evidenceId: null, assetPath: "uploads/trip-test/ev_shot_c.png" }],
      },
    });
    const original = resolveSourceOriginal(makeTrip(), source);
    expect(original.images).toEqual([{ index: 1, path: "uploads/trip-test/ev_shot_c.png" }]);
  });

  it("link 来源的下载图同样可被收集（通用能力；入口门控由调用方负责）", () => {
    const trip = makeTrip({ ev_link: makeEvidence("ev_link", "uploads/trip-test/ev_link.png") });
    const source = makeSource({
      inputKind: "link",
      sourceUrl: "https://example.com/guide",
      imageProgress: {
        total: 1,
        completed: 1,
        failed: 0,
        images: [{ index: 1, status: "ready", evidenceId: "ev_link", assetPath: "uploads/trip-test/ev_shot_d.png" }],
      },
    });
    const original = resolveSourceOriginal(trip, source);
    expect(original.images).toEqual([{ index: 1, path: "uploads/trip-test/ev_shot_d.png" }]);
  });
});

describe("resolveSourceOriginal：externalUrl 与门控", () => {
  it("sourceUrl 优先；空白 sourceUrl 回退 canonicalUrl；都无则 null", () => {
    const base = { inputKind: "images" as const };
    expect(
      resolveSourceOriginal(makeTrip(), makeSource({ ...base, sourceUrl: "https://a.com/1", canonicalUrl: "https://b.com/1" }))
        .externalUrl,
    ).toBe("https://a.com/1");
    expect(
      resolveSourceOriginal(makeTrip(), makeSource({ ...base, sourceUrl: "   ", canonicalUrl: "https://b.com/2" }))
        .externalUrl,
    ).toBe("https://b.com/2");
    expect(resolveSourceOriginal(makeTrip(), makeSource({ ...base })).externalUrl).toBeNull();
  });

  it("hasSourceOriginalContent：文本或图片任一非空即可回看，全空则隐藏入口", () => {
    expect(hasSourceOriginalContent({ text: "原文", images: [], externalUrl: null })).toBe(true);
    expect(hasSourceOriginalContent({ text: null, images: [{ index: 1, path: "uploads/x.png" }], externalUrl: null })).toBe(true);
    expect(hasSourceOriginalContent({ text: null, images: [], externalUrl: "https://a.com" })).toBe(false);
  });
});
