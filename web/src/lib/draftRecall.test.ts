/**
 * 任务 135：草案召回重建（draftResultFromTrip）单元测试。
 * 覆盖：无草案 / 无 output / 过期返回 null；新鲜草案字段映射、
 * 未持久化字段空值兜底、snippets targetRef 收窄过滤、统计数计算与可选字段透传。
 */
import { describe, expect, it } from "vitest";
import type { Operation, PendingGuideDraft, Trip } from "@goplay/shared";
import { draftResultFromTrip } from "./draftRecall";

function makeTrip(): Trip {
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
    tripId: "trip-test",
    schemaVersion: 2,
    version: 2,
    destination: { city: "三亚", cityCode: null },
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

const OPERATIONS = [{ op: "add_visit", dayIndex: 1, ref: { kind: "point", id: "p1" } }] as unknown as Operation[];

function makePending(overrides: Partial<PendingGuideDraft> = {}): PendingGuideDraft {
  return {
    draftId: "draft-1",
    baseTripVersion: 2,
    scope: { kind: "trip" },
    sourceSnapshots: [],
    mentionIds: [],
    note: null,
    createdAt: "2026-11-02T00:00:00Z",
    output: {
      operations: OPERATIONS,
      snippets: [
        {
          text: "蜈支洲岛建议早去避排队",
          claimKind: "tip",
          targetRef: { kind: "point", id: "p1" },
          sourceMentionRefs: ["ev1:m1"],
        },
      ],
    },
    ...overrides,
  };
}

function tripWithPending(pending: PendingGuideDraft | null): Trip {
  const trip = makeTrip();
  // pendingGuideDraft 为可选字段：null 与缺失都表示「无可召回草案」
  (trip as { pendingGuideDraft?: PendingGuideDraft | null }).pendingGuideDraft = pending;
  return trip;
}

describe("draftResultFromTrip（任务 135 重载召回）", () => {
  it("无 pendingGuideDraft（缺失 / null）返回 null", () => {
    expect(draftResultFromTrip(makeTrip())).toBeNull();
    expect(draftResultFromTrip(tripWithPending(null))).toBeNull();
  });

  it("pending 无 output（未生成结果 / 旧存量草案）返回 null", () => {
    const pending = makePending();
    delete pending.output;
    expect(draftResultFromTrip(tripWithPending(pending))).toBeNull();
  });

  it("过期草案（版本 / 来源 / 补充句任一变化）返回 null，不给假可用入口", () => {
    expect(draftResultFromTrip(tripWithPending(makePending({ baseTripVersion: 1 })))).toBeNull();
    expect(
      draftResultFromTrip(tripWithPending(makePending({ note: "带娃慢节奏" }))),
    ).toBeNull();
  });

  it("新鲜草案重建为可查看结果：核心字段映射 + 未持久化展示字段空值兜底", () => {
    const result = draftResultFromTrip(tripWithPending(makePending()));
    expect(result).not.toBeNull();
    expect(result?.draftId).toBe("draft-1");
    // tripVersion = baseTripVersion（草案落盘后 Trip.version）
    expect(result?.tripVersion).toBe(2);
    expect(result?.baseTripVersion).toBe(2);
    // 旧存量草案 inputTripVersion 缺省：兜底为落盘版本（仅展示用）
    expect(result?.inputTripVersion).toBe(2);
    expect(result?.scope).toEqual({ kind: "trip" });
    expect(result?.operations).toEqual(OPERATIONS);
    // 未持久化的展示辅助字段：空值兜底，不阻塞应用链路
    expect(result?.unplaced).toEqual([]);
    expect(result?.proposedNew).toEqual([]);
    expect(result?.clarify).toBeNull();
    // 展示统计补零（不参与应用逻辑）
    expect(result?.placeCount).toBe(0);
    expect(result?.mentionRefCount).toBe(0);
    expect(result?.attempts).toBe(1);
  });

  it("inputTripVersion 存在时透传实际生成版本（不落盘字段优先快照值）", () => {
    const result = draftResultFromTrip(
      tripWithPending(makePending({ inputTripVersion: 1 })),
    );
    expect(result?.inputTripVersion).toBe(1);
    expect(result?.baseTripVersion).toBe(2);
  });

  it("snippets targetRef 收窄：point / visit / stop 保留，其余持久层未知 kind 防御性过滤", () => {
    const result = draftResultFromTrip(
      tripWithPending(
        makePending({
          output: {
            operations: OPERATIONS,
            snippets: [
              {
                text: "keep-point",
                claimKind: "tip",
                targetRef: { kind: "point", id: "p1" },
                sourceMentionRefs: [],
              },
              {
                text: "keep-visit",
                claimKind: "experience",
                targetRef: { kind: "visit", id: "v1" },
                sourceMentionRefs: [],
              },
              {
                text: "keep-stop",
                claimKind: "tip",
                targetRef: { kind: "stop", id: "s1" },
                sourceMentionRefs: [],
              },
              {
                text: "drop-lodging",
                claimKind: "tip",
                targetRef: { kind: "lodging", id: "l1" },
                sourceMentionRefs: [],
              } as unknown as NonNullable<PendingGuideDraft["output"]>["snippets"][number],
            ],
          },
        }),
      ),
    );
    expect(result?.snippets.map((snippet) => snippet.text)).toEqual([
      "keep-point",
      "keep-visit",
      "keep-stop",
    ]);
  });

  it("引用的 mention 在证据中不存在时判 stale：不召回（不给假可用入口）", () => {
    const result = draftResultFromTrip(
      tripWithPending(
        makePending({
          sourceSnapshots: [
            { sourceId: "ev1", sourceVersion: 1 },
            { sourceId: "ev2", sourceVersion: 3 },
          ],
          mentionIds: ["m1", "m2", "m3"],
          mentionRefs: ["ev1:m1", "ev2:m3"],
          // evidences 为空：mention 校验不过 → 整体 stale，与来源快照是否存在无关
        }),
      ),
    );
    expect(result).toBeNull();
  });

  it("来源与 mention 引用真实存在时 fresh：统计数按快照重建", () => {
    const trip = makeTrip();
    const evidence: Trip["evidences"][string] = {
      evidenceId: "ev1",
      kind: "note_text",
      noteIndex: 0,
      assetRef: null,
      sourceUrl: null,
      ocrText: "蜈支洲岛很美，建议早去",
      mentions: [
        {
          mentionId: "m1",
          text: "蜈支洲岛",
          quoteText: "蜈支洲岛很美，建议早去",
          bbox: null,
          extractedName: "蜈支洲岛",
          locationHint: null,
          modelSummary: null,
        },
      ],
    };
    trip.guideSources = {
      ev1: {
        sourceId: "ev1",
        sourceVersion: 1,
        inputKind: "text",
        active: true,
        status: "ready",
        evidenceRefs: ["ev1"],
        mentionRefs: ["ev1:m1"],
        imageProgress: { total: 0, completed: 0, failed: 0, images: [] },
        importedAt: "2026-11-01T00:00:00Z",
        updatedAt: "2026-11-01T00:00:00Z",
      },
    };
    trip.evidences = { ev1: evidence };
    (trip as { pendingGuideDraft?: PendingGuideDraft | null }).pendingGuideDraft = makePending({
      sourceSnapshots: [{ sourceId: "ev1", sourceVersion: 1 }],
      mentionIds: ["m1"],
      mentionRefs: ["ev1:m1"],
    });
    const result = draftResultFromTrip(trip);
    expect(result).not.toBeNull();
    expect(result?.sourceCount).toBe(1);
    expect(result?.sourceSnapshots).toEqual([{ sourceId: "ev1", sourceVersion: 1 }]);
    expect(result?.mentionCount).toBe(2); // mentionIds 1 + mentionRefs 1
  });

  it("directives / requirementChecks / conflicts 可选快照字段透传", () => {
    const directives = [
      {
        directiveId: "dir_1",
        dayIndex: 2,
        placeText: "蜈支洲岛",
        resolvedVisitIds: [],
        rawSentence: "第二天去蜈支洲岛",
      },
    ];
    const checks = [
      { directiveId: "dir_1", dayIndex: 2, placeText: "蜈支洲岛", status: "unmet" as const, detail: "行程中无匹配" },
    ];
    const conflicts = [
      {
        conflictId: "cf_1",
        directiveId: "dir_1",
        kind: "subject_locked" as const,
        subjectRef: null,
        subjectLabel: "蜈支洲岛",
        detail: "目标已被锁定",
        sensitive: true,
        defaultSelected: false,
        resolution: null,
      },
    ];
    const result = draftResultFromTrip(
      tripWithPending(makePending({ directives, requirementChecks: checks, conflicts })),
    );
    expect(result?.directives).toEqual(directives);
    expect(result?.requirementChecks).toEqual(checks);
    expect(result?.conflicts).toEqual(conflicts);
  });

  it("Task #250 explanation 分类解释随草案快照透传；旧草案缺省为 undefined", () => {
    const explanation = {
      items: [
        {
          key: "new:visit:v1",
          classification: "new" as const,
          targetRef: { kind: "visit" as const, id: "v1" },
          displayName: "亚龙湾",
          dayIndex: 3,
          detail: "此前不在任何 Day，本轮排入 Day3",
        },
      ],
      counts: { remove: 0, rearrange: 0, new: 1, adjust: 0, retain: 0, snippet_only: 0 },
      replaceSummaries: [],
    };
    const result = draftResultFromTrip(tripWithPending(makePending({ explanation })));
    expect(result?.explanation).toEqual(explanation);

    // 旧草案无该字段：保持 undefined，前端据此回退原展示
    expect(draftResultFromTrip(tripWithPending(makePending()))?.explanation).toBeUndefined();
  });
});
