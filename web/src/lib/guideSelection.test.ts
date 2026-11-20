/**
 * Task #236：攻略来源选择纯函数层测试。
 *
 * 覆盖（对应任务验收口径）：
 * - 可选判定 = 可用来源（active + ready/partial + 有可读证据）；
 * - 默认选择 = 暂存 + 可选 + 未消费（新攻略保存后默认勾选，但不自动改行程）；
 * - 「只选新的」= 仅 staged=true 的可选来源；
 * - 收敛：软删除 / 状态回退 / 轮询更新剔除失效 id；新变为可选的暂存来源自动并入，
 *   用户主动取消过的来源不回弹；首次推导不覆盖默认选择；
 * - 紧凑排序：处理中 → 待重试 → 新增暂存 → 其他，同级稳定。
 */
import { describe, expect, it } from "vitest";
import type { GuideSource, SourceEvidence, Trip } from "@goplay/shared";
import {
  defaultGuideSelection,
  guideSourceRowPriority,
  isGuideSourceSelectable,
  reconcileGuideSelection,
  selectableGuideSourceIds,
  sortGuideSourcesForCompactList,
  stagedGuideSourceIds,
} from "./guideSelection";

function makeEvidence(evidenceId: string, overrides: Partial<SourceEvidence> = {}): SourceEvidence {
  return {
    evidenceId,
    kind: "note_text",
    noteIndex: null,
    assetRef: null,
    sourceUrl: null,
    ocrText: "第一天 亚龙湾",
    mentions: [],
    assetPath: null,
    ...overrides,
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
    title: "三亚攻略",
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

const trip = makeTrip({ ev_1: makeEvidence("ev_1"), ev_2: makeEvidence("ev_2") });

describe("isGuideSourceSelectable / selectableGuideSourceIds", () => {
  it("ready / partial 且有可读证据才可选", () => {
    expect(isGuideSourceSelectable(trip, makeSource())).toBe(true);
    expect(isGuideSourceSelectable(trip, makeSource({ status: "partial" }))).toBe(true);
    expect(isGuideSourceSelectable(trip, makeSource({ status: "processing" }))).toBe(false);
    expect(isGuideSourceSelectable(trip, makeSource({ status: "failed" }))).toBe(false);
    expect(isGuideSourceSelectable(trip, makeSource({ active: false }))).toBe(false);
    expect(isGuideSourceSelectable(trip, makeSource({ evidenceRefs: ["ev_missing"] }))).toBe(false);
    // 证据存在但既无文字也无疑点：不可用
    expect(
      isGuideSourceSelectable(
        makeTrip({ ev_empty: makeEvidence("ev_empty", { ocrText: "  " }) }),
        makeSource({ evidenceRefs: ["ev_empty"] }),
      ),
    ).toBe(false);
  });

  it("保持来源顺序输出可选 id", () => {
    const sources = [
      makeSource({ sourceId: "a" }),
      makeSource({ sourceId: "p", status: "processing" }),
      makeSource({ sourceId: "b" }),
    ];
    expect(selectableGuideSourceIds(trip, sources)).toEqual(["a", "b"]);
  });
});

describe("defaultGuideSelection / stagedGuideSourceIds", () => {
  it("默认只选暂存且未消费的可用来源（历史来源不默认混入）", () => {
    const sources = [
      makeSource({ sourceId: "hist" }),
      makeSource({ sourceId: "new", staged: true }),
      makeSource({ sourceId: "used", staged: true }),
      makeSource({ sourceId: "failed", staged: true, status: "failed" }),
    ];
    expect(defaultGuideSelection(trip, sources)).toEqual(["new", "used"]);
    expect(defaultGuideSelection(trip, sources, ["used"])).toEqual(["new"]);
  });

  it("「只选新的」仅 staged 可选来源（不看消费记录）", () => {
    const sources = [
      makeSource({ sourceId: "hist" }),
      makeSource({ sourceId: "new", staged: true }),
      makeSource({ sourceId: "used", staged: true }),
    ];
    expect(stagedGuideSourceIds(trip, sources)).toEqual(["new", "used"]);
  });
});

describe("reconcileGuideSelection 安全收敛", () => {
  it("首次推导（seen=null）只与可选集合取交集，不额外并入", () => {
    const sources = [makeSource({ sourceId: "a" }), makeSource({ sourceId: "new", staged: true })];
    const result = reconcileGuideSelection({
      previous: ["a", "missing"],
      trip,
      sources,
      seenSelectableIds: null,
    });
    expect(result.selectedIds).toEqual(["a"]);
    expect(result.selectableIds).toEqual(["a", "new"]);
  });

  it("软删除 / 状态回退 / 证据消失：选择集合不残留无效 id", () => {
    const sources = [
      makeSource({ sourceId: "a" }),
      makeSource({ sourceId: "b", status: "processing" }),
      makeSource({ sourceId: "c", evidenceRefs: [] }),
    ];
    const result = reconcileGuideSelection({
      previous: ["a", "b", "c", "gone"],
      trip,
      sources,
      seenSelectableIds: new Set(["a", "b", "c"]),
    });
    expect(result.selectedIds).toEqual(["a"]);
  });

  it("新变为可选的暂存来源自动并入（处理完成 / 重试成功）", () => {
    const sources = [
      makeSource({ sourceId: "a" }),
      makeSource({ sourceId: "new", staged: true }),
    ];
    const result = reconcileGuideSelection({
      previous: ["a"],
      trip,
      sources,
      seenSelectableIds: new Set(["a"]),
    });
    expect(result.selectedIds).toEqual(["a", "new"]);
  });

  it("用户主动取消勾选的暂存来源不回弹（上一轮已计入 seen）", () => {
    const sources = [makeSource({ sourceId: "new", staged: true })];
    const result = reconcileGuideSelection({
      previous: [],
      trip,
      sources,
      seenSelectableIds: new Set(["new"]),
    });
    expect(result.selectedIds).toEqual([]);
  });

  it("已消费的暂存来源不再自动并入，但仍可显式保留", () => {
    const sources = [makeSource({ sourceId: "new", staged: true })];
    const auto = reconcileGuideSelection({
      previous: [],
      trip,
      sources,
      consumedSourceIds: ["new"],
      seenSelectableIds: new Set<string>(),
    });
    expect(auto.selectedIds).toEqual([]);

    const explicit = reconcileGuideSelection({
      previous: ["new"],
      trip,
      sources,
      consumedSourceIds: ["new"],
      seenSelectableIds: new Set(["new"]),
    });
    expect(explicit.selectedIds).toEqual(["new"]);
  });

  it("历史来源不会因为新变为可选而被自动并入", () => {
    const sources = [makeSource({ sourceId: "hist" })];
    const result = reconcileGuideSelection({
      previous: [],
      trip,
      sources,
      seenSelectableIds: new Set<string>(),
    });
    expect(result.selectedIds).toEqual([]);
  });
});

describe("紧凑列表排序", () => {
  it("处理中 → 待重试 → 新增暂存 → 其他，同级保持导入顺序", () => {
    const sources = [
      makeSource({ sourceId: "h1" }),
      makeSource({ sourceId: "f", status: "failed" }),
      makeSource({ sourceId: "n1", staged: true }),
      makeSource({ sourceId: "p", status: "processing" }),
      makeSource({ sourceId: "n2", staged: true }),
      makeSource({ sourceId: "h2" }),
    ];
    expect(sortGuideSourcesForCompactList(sources).map((source) => source.sourceId)).toEqual([
      "p",
      "f",
      "n1",
      "n2",
      "h1",
      "h2",
    ]);
    // 不修改入参
    expect(sources.map((source) => source.sourceId)).toEqual(["h1", "f", "n1", "p", "n2", "h2"]);
  });

  it("优先级常量稳定（供列表与测试共用口径）", () => {
    expect(guideSourceRowPriority(makeSource({ status: "processing" }))).toBe(0);
    expect(guideSourceRowPriority(makeSource({ status: "failed" }))).toBe(1);
    expect(guideSourceRowPriority(makeSource({ staged: true }))).toBe(2);
    expect(guideSourceRowPriority(makeSource())).toBe(3);
  });
});
