/**
 * B1 攻略包契约验证 —— GuideSource / GuideSnippet / pendingGuideDraft 与去重纯函数。
 *
 * 运行：npx tsx src/verify-guides.ts（shared 目录下）；已接入 `npm run verify -w shared`。
 *
 * 覆盖（任务 #95）：
 *  A. 空 Trip 兼容：缺失 guideSources / guideSnippets 时一致性通过且校验为纯函数；
 *  B. ready 来源：证据 / mention 引用完整 + Visit/Stop guideSnippets 可定位；
 *  C. partial：成功部分保留 + 失败清单（rejected / timeout）不要求图片全部成功；
 *  D. 悬空引用：evidenceRefs / mentionRefs / GuideSnippet / 图片 evidenceId 均被检出；
 *  E. 去重：canonicalUrl（含分享参数变化）或 contentHash 命中；已移除来源仍命中；
 *  F. 快照过期：Trip version / sourceVersion / 来源缺失 / mention 缺失逐项判定，
 *     且过期快照本身不阻止历史 Trip 通过一致性校验（应用阶段才拒绝）；
 *  G. pendingGuideDraft 结构错误（来源 / scope / mention / 版本号）被检出；
 *  H. imageProgress 计数与明细一致（total / completed / failed / 每图 evidenceId）；
 *  I. Task #161：staged 暂存标记 / 全部模式可用性 / sourceMode-sourceIds 元数据
 *     与旧草案正交（局部草案契约，旧数据零迁移）。
 */

import assert from "node:assert/strict";
import type {
  GuideSource,
  Item,
  PendingGuideDraft,
  Trip,
  Visit,
} from "./types/index.js";
import { SCHEMA_VERSION } from "./types/index.js";
import { validateConsistency } from "./consistency/index.js";
import {
  GUIDE_SNIPPET_MAX_CHARS,
  checkPendingGuideDraftFreshness,
  createEmptyGuideImageProgress,
  findDuplicateGuideSource,
  formatMentionRef,
  isGuideSourceStaged,
  isGuideSourceUsable,
  isGuideSourceUsableForFullMerge,
  normalizeCanonicalUrl,
  parseMentionRef,
  resolveMentionRef,
} from "./guides/index.js";

// ===== fixtures =====

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeItem(): Item {
  return {
    itemId: "item_xidao",
    name: "西岛",
    origin: "custom",
    providerId: null,
    address: null,
    category: null,
    coords: null,
    suggestMinutes: 240,
    mainPic: null,
    ticketInfo: null,
    jumpUrl: null,
    sourceEvidenceRefs: [],
  };
}

function makeVisit(): Visit {
  return {
    visitId: "visit_xidao",
    dayRef: "day_1",
    pointRef: "item_xidao",
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
    externalLeg: { mode: "驾车", minutes: 30, note: null, source: "user" },
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

/** 一天行程：西岛大景区（无 Stop，便于聚焦攻略契约） */
function makeTrip(): Trip {
  return {
    tripId: "trip_verify_guides",
    schemaVersion: SCHEMA_VERSION,
    version: 7,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: "2026-11-08", nights: 0 },
    dayRefs: ["day_1"],
    days: {
      day_1: {
        dayId: "day_1",
        dayIndex: 1,
        date: "2026-11-08",
        departTime: "08:00",
        departTimeOverridden: false,
        scheduleVisitRefs: ["visit_xidao"],
        lodging: null,
      },
    },
    lodgings: {},
    hotelRegistry: {},
    itemRegistry: { item_xidao: makeItem() },
    visits: { visit_xidao: makeVisit() },
    stops: {},
    evidences: {
      // 正文证据：可用正文提及
      ev_text: {
        evidenceId: "ev_text",
        kind: "note_text",
        noteIndex: 1,
        assetRef: null,
        sourceUrl: "https://www.xiaohongshu.com/explore/abc",
        ocrText: null,
        mentions: [
          {
            mentionId: "m1",
            text: "西岛",
            quoteText: "西岛建议早上八点前上岛，不然排队很久",
            bbox: null,
            extractedName: "西岛",
            locationHint: null,
            modelSummary: "建议早到",
            claimKind: "tip",
            targetScope: "time_window",
            firsthand: true,
          },
        ],
      },
      // 单图证据：OCR 文字 + 提及
      ev_img_1: {
        evidenceId: "ev_img_1",
        kind: "screenshot",
        noteIndex: null,
        assetRef: "截图 1.jpg",
        sourceUrl: null,
        ocrText: "岛上有电瓶车，20元一人",
        mentions: [
          {
            mentionId: "m9",
            text: "电瓶车",
            quoteText: "岛上有电瓶车，20元一人",
            bbox: [10, 20, 30, 40],
            extractedName: "电瓶车",
            locationHint: null,
            modelSummary: null,
            claimKind: "experience",
            targetScope: "activity",
            firsthand: true,
          },
        ],
      },
    },
    globalCandidateRefs: [],
    pendingStopRefs: [],
    relationshipSuggestions: {},
    guideSources: {},
    constraints: [],
    createdAt: "2026-10-19T00:00:00.000Z",
    updatedAt: "2026-10-19T00:00:00.000Z",
  };
}

function makeSource(overrides: Partial<GuideSource> = {}): GuideSource {
  return {
    sourceId: "gs_link",
    sourceVersion: 1,
    inputKind: "link",
    title: "西岛一日攻略",
    sourceUrl: "https://www.xiaohongshu.com/explore/abc?xsec_token=old&share_id=1",
    canonicalUrl: "https://www.xiaohongshu.com/explore/abc",
    contentHash: "hash-abc",
    active: true,
    status: "ready",
    evidenceRefs: ["ev_text"],
    mentionRefs: ["ev_text:m1"],
    imageProgress: createEmptyGuideImageProgress(),
    importedAt: "2026-10-19T00:00:00.000Z",
    updatedAt: "2026-10-19T00:00:00.000Z",
    ...overrides,
  };
}

/** 写入来源注册表并返回强类型引用（避免 TS 把 `{}` 字面量收窄为无索引类型） */
function withSources(trip: Trip, ...sources: GuideSource[]): Record<string, GuideSource> {
  const registry: Record<string, GuideSource> = {};
  for (const source of sources) registry[source.sourceId] = source;
  trip.guideSources = registry;
  return registry;
}

function registryOf(trip: Trip): Record<string, GuideSource> {
  return trip.guideSources as Record<string, GuideSource>;
}

function makeDraft(trip: Trip): PendingGuideDraft {
  return {
    draftId: "draft_1",
    baseTripVersion: trip.version,
    scope: { kind: "trip" },
    sourceSnapshots: [{ sourceId: "gs_link", sourceVersion: 1 }],
    mentionIds: ["m1"],
    mentionRefs: ["ev_text:m1"],
    note: "多留一点海边时间",
    createdAt: "2026-10-19T00:10:00.000Z",
  };
}

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ===== A. 空 Trip 兼容 =====

test("空 Trip：缺失 guideSources / guideSnippets 时一致性通过，且校验不写字段", () => {
  const trip = makeTrip();
  delete trip.guideSources;
  const before = clone(trip);
  assert.deepEqual(validateConsistency(trip), []);
  assert.deepEqual(trip, before, "validateConsistency 必须是纯函数");
  assert.equal(trip.guideSources, undefined);
  assert.equal(findDuplicateGuideSource(trip.guideSources, { canonicalUrl: "https://example.com/a" }), null);
  assert.deepEqual(findDuplicateGuideSource(undefined, {}), null);
});

// ===== B. ready 来源 + GuideSnippet =====

test("ready 来源：证据 / mention 完整 + Visit guideSnippets 可定位 → 一致性通过", () => {
  const trip = makeTrip();
  const sources = withSources(trip, makeSource());
  trip.visits.visit_xidao.guideSnippets = [
    {
      snippetId: "snip_1",
      text: "八点前上岛，避开排队",
      claimKind: "tip",
      sourceMentionRefs: ["ev_text:m1"],
    },
  ];

  assert.deepEqual(validateConsistency(trip), []);
  assert.equal(isGuideSourceUsable(trip, sources.gs_link!), true);
  const resolved = resolveMentionRef(trip, "ev_text:m1");
  assert.ok(resolved !== null);
  assert.equal(resolved.mention.quoteText, "西岛建议早上八点前上岛，不然排队很久");
  assert.equal(resolved.mention.claimKind, "tip");
  assert.equal(resolved.mention.firsthand, true);
});

test("ready 来源没有任何可读证据 → 报错（不能只靠标题就 ready）", () => {
  const trip = makeTrip();
  withSources(trip, makeSource({ evidenceRefs: [], mentionRefs: [] }));
  const errors = validateConsistency(trip);
  assert.ok(errors.some((error) => error.includes("ready")), errors.join("\n"));
});

test("Task #215 延迟解析：imageOcrDeferred + pending 图，无证据 ready → 豁免通过", () => {
  const trip = makeTrip();
  const sources = withSources(
    trip,
    makeSource({
      inputKind: "images",
      sourceUrl: undefined,
      canonicalUrl: undefined,
      evidenceRefs: [],
      mentionRefs: [],
      imageOcrDeferred: true,
      imageProgress: {
        total: 2,
        completed: 0,
        failed: 0,
        images: [
          { index: 1, status: "pending", evidenceId: null, assetPath: "uploads/xhs_a/1.jpg" },
          { index: 2, status: "pending", evidenceId: null, assetPath: "uploads/xhs_a/2.jpg" },
        ],
      },
    }),
  );
  assert.deepEqual(validateConsistency(trip), []);
  // 豁免只放行持久化：图片尚未解析、正文证据缺失 → 不计入可用篇数
  assert.equal(isGuideSourceUsable(trip, sources.gs_link!), false);
});

test("Task #215 延迟解析：deferred + partial + 空证据 + pending（正文抽取失败场景）→ 豁免通过", () => {
  const trip = makeTrip();
  withSources(
    trip,
    makeSource({
      status: "partial",
      evidenceRefs: [],
      mentionRefs: [],
      imageOcrDeferred: true,
      imageProgress: {
        total: 2,
        completed: 0,
        failed: 0,
        images: [
          { index: 1, status: "pending", evidenceId: null, assetPath: "uploads/xhs_a/1.jpg" },
          { index: 2, status: "pending", evidenceId: null, assetPath: "uploads/xhs_a/2.jpg" },
        ],
      },
    }),
  );
  assert.deepEqual(validateConsistency(trip), []);
});

test("Task #215 延迟解析：deferred 标记残留但无 pending 图 → 仍报错（防脏数据）", () => {
  const trip = makeTrip();
  withSources(
    trip,
    makeSource({
      evidenceRefs: [],
      mentionRefs: [],
      imageOcrDeferred: true,
      imageProgress: {
        total: 1,
        completed: 0,
        failed: 1,
        images: [
          { index: 1, status: "failed", evidenceId: null, failureCode: "download_failed", failureMessage: "P1 下载失败" },
        ],
      },
    }),
  );
  const errors = validateConsistency(trip);
  assert.ok(errors.some((error) => error.includes("没有任何可读正文")), errors.join("\n"));
});

// ===== C. partial 与图片进度 =====

test("partial：正文 + 成功图片 + 失败清单共存，计数与明细一致 → 通过", () => {
  const trip = makeTrip();
  const sources = withSources(
    trip,
    makeSource({
      sourceId: "gs_images",
      inputKind: "images",
      status: "partial",
      evidenceRefs: ["ev_text", "ev_img_1"],
      mentionRefs: ["ev_text:m1", "ev_img_1:m9"],
      imageProgress: {
        total: 3,
        completed: 1,
        failed: 2,
        images: [
          { index: 1, status: "ready", evidenceId: "ev_img_1" },
          { index: 2, status: "failed", evidenceId: null, failureCode: "timeout" },
          { index: 3, status: "failed", evidenceId: null, failureMessage: "模型拒绝：图片模糊" },
        ],
      },
      coverageText: "正文 + 1/3张图",
    }),
  );

  assert.deepEqual(validateConsistency(trip), []);
  assert.equal(isGuideSourceUsable(trip, sources.gs_images!), true);
});

test("图片进度：ready 图缺 evidenceId / 悬空证据 / 计数不符 均被检出", () => {
  const base = makeTrip();
  withSources(base, makeSource({ sourceId: "gs_images", inputKind: "images" }));

  const noEvidence = clone(base);
  registryOf(noEvidence).gs_images!.imageProgress = {
    total: 1,
    completed: 1,
    failed: 0,
    images: [{ index: 1, status: "ready", evidenceId: null }],
  };
  assert.ok(validateConsistency(noEvidence).some((error) => error.includes("evidenceId")));

  const dangling = clone(base);
  registryOf(dangling).gs_images!.imageProgress = {
    total: 1,
    completed: 1,
    failed: 0,
    images: [{ index: 1, status: "ready", evidenceId: "ev_ghost" }],
  };
  assert.ok(validateConsistency(dangling).some((error) => error.includes("ev_ghost")));

  const mismatch = clone(base);
  registryOf(mismatch).gs_images!.imageProgress = {
    total: 2,
    completed: 0,
    failed: 0,
    images: [{ index: 1, status: "ready", evidenceId: "ev_img_1" }],
  };
  const errors = validateConsistency(mismatch);
  assert.ok(errors.some((error) => error.includes("不一致")), errors.join("\n"));
  assert.ok(errors.some((error) => error.includes("completed")), errors.join("\n"));
});

// ===== D. 悬空引用 =====

test("悬空引用：evidenceRefs / mentionRefs / 证据未列入 evidenceRefs 均被检出", () => {
  const base = makeTrip();
  withSources(base, makeSource());

  const ghostEvidence = clone(base);
  registryOf(ghostEvidence).gs_link!.evidenceRefs = ["ev_ghost"];
  registryOf(ghostEvidence).gs_link!.mentionRefs = [];
  assert.ok(validateConsistency(ghostEvidence).some((error) => error.includes("ev_ghost")));

  const ghostMention = clone(base);
  registryOf(ghostMention).gs_link!.mentionRefs = ["ev_text:m404"];
  assert.ok(validateConsistency(ghostMention).some((error) => error.includes("m404")));

  const notOwned = clone(base);
  registryOf(notOwned).gs_link!.mentionRefs = ["ev_img_1:m9"];
  assert.ok(validateConsistency(notOwned).some((error) => error.includes("未列入 evidenceRefs")));

  const badFormat = clone(base);
  registryOf(badFormat).gs_link!.mentionRefs = ["m1"];
  assert.ok(validateConsistency(badFormat).some((error) => error.includes("格式非法")));
});

test("GuideSnippet：悬空 mention / 超长 / 超过 3 条引用 / 缺 claimKind / snippetId 重复 均被检出", () => {
  const base = makeTrip();
  withSources(base, makeSource());
  const snippet = {
    snippetId: "snip_1",
    text: "八点前上岛",
    claimKind: "tip" as const,
    sourceMentionRefs: ["ev_text:m1"],
  };

  const dangling = clone(base);
  dangling.visits.visit_xidao.guideSnippets = [{ ...snippet, sourceMentionRefs: ["ev_text:m404"] }];
  assert.ok(validateConsistency(dangling).some((error) => error.includes("m404")));

  const tooLong = clone(base);
  tooLong.visits.visit_xidao.guideSnippets = [
    { ...snippet, text: "攻".repeat(GUIDE_SNIPPET_MAX_CHARS + 1) },
  ];
  assert.ok(validateConsistency(tooLong).some((error) => error.includes("硬上限")));

  const tooManyRefs = clone(base);
  tooManyRefs.visits.visit_xidao.guideSnippets = [
    { ...snippet, sourceMentionRefs: ["ev_text:m1", "ev_text:m1", "ev_text:m1", "ev_text:m1"] },
  ];
  assert.ok(validateConsistency(tooManyRefs).some((error) => error.includes("超过上限")));

  const noClaimKind = clone(base);
  noClaimKind.visits.visit_xidao.guideSnippets = [
    { ...snippet, claimKind: undefined as never },
  ];
  assert.ok(validateConsistency(noClaimKind).some((error) => error.includes("claimKind")));

  const duplicated = clone(base);
  duplicated.visits.visit_xidao.guideSnippets = [snippet, { ...snippet }];
  assert.ok(validateConsistency(duplicated).some((error) => error.includes("snippetId 重复")));
});

// ===== E. 去重 =====

test("去重：canonicalUrl 分享参数变化 / contentHash 大小写不同均命中；不相关不误判", () => {
  const trip = makeTrip();
  const sources = withSources(
    trip,
    makeSource(),
    makeSource({
      sourceId: "gs_text",
      inputKind: "text",
      title: "纯文字攻略",
      sourceUrl: undefined,
      canonicalUrl: undefined,
      contentHash: "hash-text",
      importedAt: "2026-10-19T01:00:00.000Z",
    }),
    makeSource({
      sourceId: "gs_removed",
      canonicalUrl: "https://www.xiaohongshu.com/explore/removed",
      contentHash: undefined,
      active: false,
      removedAt: "2026-10-19T02:00:00.000Z",
    }),
  );

  const sameLink = findDuplicateGuideSource(sources, {
    canonicalUrl: "https://www.xiaohongshu.com/explore/abc?xsec_token=new&share_id=2&utm_source=wechat",
  });
  assert.equal(sameLink?.sourceId, "gs_link");

  const sameLinkViaSourceUrl = findDuplicateGuideSource(sources, {
    sourceUrl: "HTTPS://WWW.XIAOHONGSHU.COM/explore/abc/#fragment",
  });
  assert.equal(sameLinkViaSourceUrl?.sourceId, "gs_link");

  const sameHash = findDuplicateGuideSource(sources, { contentHash: "HASH-TEXT" });
  assert.equal(sameHash?.sourceId, "gs_text", "contentHash 比较忽略大小写");

  const removedHit = findDuplicateGuideSource(sources, {
    canonicalUrl: "https://www.xiaohongshu.com/explore/removed/",
  });
  assert.equal(removedHit?.sourceId, "gs_removed", "已移除来源仍命中缓存，避免重复抓取 / 计数");

  assert.equal(findDuplicateGuideSource(sources, { contentHash: "hash-other" }), null);
  assert.equal(findDuplicateGuideSource(sources, {}), null);
});

test("normalizeCanonicalUrl：去 fragment / utm / 分享参数，host 小写，尾部斜杠归一", () => {
  assert.equal(
    normalizeCanonicalUrl(
      "  HTTPS://WWW.XiaoHongShu.com/explore/abc/?utm_source=x&xsec_token=y&share_id=9#frag  ",
    ),
    "https://www.xiaohongshu.com/explore/abc",
  );
  // 非跟踪参数保留并按键名排序（顺序不影响相等判定）
  assert.equal(
    normalizeCanonicalUrl("https://example.com/path?b=2&a=1#x"),
    "https://example.com/path?a=1&b=2",
  );
  // 非法 URL 不猜测改写
  assert.equal(normalizeCanonicalUrl("not a url"), "not a url");
  assert.equal(normalizeCanonicalUrl("   "), "");
});

test("mention 引用：parse / format 与证据内定位", () => {
  const trip = makeTrip();
  assert.deepEqual(parseMentionRef("ev_text:m1"), { evidenceId: "ev_text", mentionId: "m1" });
  assert.equal(parseMentionRef("m1"), null);
  assert.equal(parseMentionRef(":m1"), null);
  assert.equal(parseMentionRef("ev_text:"), null);
  assert.equal(formatMentionRef("ev_text", "m1"), "ev_text:m1");
  assert.equal(resolveMentionRef(trip, "ev_text:m404"), null);
  assert.equal(resolveMentionRef(trip, "ev_ghost:m1"), null);
});

// ===== F. 草案快照过期 =====

test("快照新鲜：Trip version / sourceVersion / mention / 补充句均一致 → fresh", () => {
  const trip = makeTrip();
  withSources(trip, makeSource());
  const draft = makeDraft(trip);
  trip.pendingGuideDraft = draft;
  trip.guideDraftNote = draft.note ?? "";

  assert.deepEqual(validateConsistency(trip), []);
  const freshness = checkPendingGuideDraftFreshness(draft, trip);
  assert.equal(freshness.fresh, true);
  assert.deepEqual(freshness.reasons, []);
});

test("快照过期：Trip version / sourceVersion / 来源缺失 / mention 缺失逐项判定", () => {
  const base = makeTrip();
  withSources(base, makeSource());
  base.guideDraftNote = "多留一点海边时间";
  const draft = makeDraft(base);

  const movedTrip = clone(base);
  movedTrip.version += 1;
  const tripChanged = checkPendingGuideDraftFreshness(draft, movedTrip);
  assert.equal(tripChanged.fresh, false);
  assert.deepEqual(tripChanged.reasons, ["trip_version_changed"]);

  const sourceChanged = clone(base);
  registryOf(sourceChanged).gs_link!.sourceVersion = 2;
  const sourceVersionChanged = checkPendingGuideDraftFreshness(draft, sourceChanged);
  assert.equal(sourceVersionChanged.fresh, false);
  assert.deepEqual(sourceVersionChanged.reasons, ["source_version_changed"]);

  const sourceGone = clone(base);
  delete registryOf(sourceGone).gs_link;
  const sourceMissing = checkPendingGuideDraftFreshness(draft, sourceGone);
  assert.equal(sourceMissing.fresh, false);
  assert.ok(sourceMissing.reasons.includes("source_missing"));

  const mentionGone = clone(base);
  mentionGone.evidences.ev_text!.mentions = [];
  const mentionMissing = checkPendingGuideDraftFreshness(draft, mentionGone);
  assert.equal(mentionMissing.fresh, false);
  assert.ok(mentionMissing.reasons.includes("mention_missing"));
  assert.ok(mentionMissing.reasons.includes("mention_ref_missing"));
});

test("快照过期：来源被移除 / 补充句变化也被判定（应用时拒绝，不阻止加载）", () => {
  const base = makeTrip();
  withSources(base, makeSource());
  base.guideDraftNote = "多留一点海边时间";
  const draft = makeDraft(base);

  const inactive = clone(base);
  registryOf(inactive).gs_link!.active = false;
  registryOf(inactive).gs_link!.removedAt = "2026-10-19T03:00:00.000Z";
  const inactiveResult = checkPendingGuideDraftFreshness(draft, inactive);
  assert.equal(inactiveResult.fresh, false);
  assert.deepEqual(inactiveResult.reasons, ["source_inactive"]);
  assert.deepEqual(validateConsistency(inactive), [], "已移除来源本身是合法结构");

  const noteChanged = clone(base);
  noteChanged.guideDraftNote = "改成只排半天";
  const noteResult = checkPendingGuideDraftFreshness(draft, noteChanged);
  assert.equal(noteResult.fresh, false);
  assert.deepEqual(noteResult.reasons, ["note_changed"]);
});

test("过期快照不阻止历史 Trip 加载：版本不一致仍通过一致性校验", () => {
  const trip = makeTrip();
  withSources(trip, makeSource());
  trip.pendingGuideDraft = makeDraft(trip);
  trip.guideDraftNote = trip.pendingGuideDraft.note ?? "";
  // 模拟生成后又发生一次用户编辑：Trip.version 前进、来源版本递增
  trip.version += 3;
  registryOf(trip).gs_link!.sourceVersion = 5;

  assert.equal(checkPendingGuideDraftFreshness(trip.pendingGuideDraft, trip).fresh, false);
  assert.deepEqual(validateConsistency(trip), [], "版本过期只能在应用时拒绝，不能在加载时判失败");
});

// ===== G. pendingGuideDraft 结构 =====

test("pendingGuideDraft：来源快照 / scope / mentionIds / 版本号非法均被检出", () => {
  const base = makeTrip();
  withSources(base, makeSource());

  const ghostSource = clone(base);
  ghostSource.pendingGuideDraft = {
    ...makeDraft(base),
    sourceSnapshots: [{ sourceId: "gs_ghost", sourceVersion: 1 }],
  };
  assert.ok(validateConsistency(ghostSource).some((error) => error.includes("gs_ghost")));

  const badScope = clone(base);
  badScope.pendingGuideDraft = { ...makeDraft(base), scope: { kind: "day", dayIndex: 9 } };
  assert.ok(validateConsistency(badScope).some((error) => error.includes("超出行程范围")));

  const badVisitScope = clone(base);
  badVisitScope.pendingGuideDraft = {
    ...makeDraft(base),
    scope: { kind: "attraction", visitId: "visit_ghost" },
  };
  assert.ok(validateConsistency(badVisitScope).some((error) => error.includes("visit_ghost")));

  const badMention = clone(base);
  badMention.pendingGuideDraft = { ...makeDraft(base), mentionIds: ["m404"] };
  assert.ok(validateConsistency(badMention).some((error) => error.includes("m404")));

  const badVersion = clone(base);
  badVersion.pendingGuideDraft = { ...makeDraft(base), baseTripVersion: 0 };
  assert.ok(validateConsistency(badVersion).some((error) => error.includes("baseTripVersion")));
});

// ===== H. 硬范围与补充句 =====

test("hardScope：day / attraction 必须落在当前行程；guideDraftNote 必须是字符串", () => {
  const base = makeTrip();
  const sources = withSources(
    base,
    makeSource({ hardScope: { kind: "day", dayIndex: 1 } }),
    makeSource({
      sourceId: "gs_attraction",
      hardScope: { kind: "attraction", visitId: "visit_xidao" },
      canonicalUrl: "https://www.xiaohongshu.com/explore/attraction",
    }),
  );
  assert.deepEqual(validateConsistency(base), []);
  assert.equal(sources.gs_link!.hardScope?.kind, "day");

  const badDay = clone(base);
  registryOf(badDay).gs_link!.hardScope = { kind: "day", dayIndex: 2 };
  assert.ok(validateConsistency(badDay).some((error) => error.includes("hardScope")));

  const badAttraction = clone(base);
  registryOf(badAttraction).gs_attraction!.hardScope = { kind: "attraction", visitId: "visit_ghost" };
  assert.ok(validateConsistency(badAttraction).some((error) => error.includes("visit_ghost")));

  const badNote = clone(base);
  (badNote as { guideDraftNote?: unknown }).guideDraftNote = 123;
  assert.ok(validateConsistency(badNote).some((error) => error.includes("guideDraftNote")));
});

// ===== I. Task #161：来源暂存与局部草案契约 =====

test("staged 缺省：历史来源 isGuideSourceUsableForFullMerge 与 isGuideSourceUsable 判定一致（零迁移）", () => {
  const trip = makeTrip();
  const sources = withSources(trip, makeSource());
  assert.equal(isGuideSourceStaged(sources.gs_link!), false, "无 staged 字段 = 非暂存");
  assert.equal(isGuideSourceUsable(trip, sources.gs_link!), true);
  assert.equal(isGuideSourceUsableForFullMerge(trip, sources.gs_link!), true, "历史来源全部模式照常可消费");
  assert.equal(sources.gs_link!.staged, undefined, "不得因读取而补写字段");
});

test("staged=true：仍 isGuideSourceUsable（显式选择可用）但默认规划不消费", () => {
  const trip = makeTrip();
  const sources = withSources(trip, makeSource({ staged: true }));
  assert.equal(isGuideSourceStaged(sources.gs_link!), true);
  assert.equal(isGuideSourceUsable(trip, sources.gs_link!), true, "暂存来源可被局部模式显式选中");
  assert.equal(isGuideSourceUsableForFullMerge(trip, sources.gs_link!), false, "暂存来源不进入全部模式合并");
  assert.deepEqual(validateConsistency(trip), [], "staged 字段不影响一致性校验");
});

test("active=false 优先于 staged：软移除语义不变，可用与全部模式均拒绝", () => {
  const trip = makeTrip();
  const sources = withSources(trip, makeSource({ staged: true, active: false }));
  assert.equal(isGuideSourceStaged(sources.gs_link!), true, "暂存标记与 active 正交");
  assert.equal(isGuideSourceUsable(trip, sources.gs_link!), false, "已移除来源任何模式均不可用");
  assert.equal(isGuideSourceUsableForFullMerge(trip, sources.gs_link!), false);
});

test("pendingGuideDraft sourceMode/sourceIds 元数据：局部模式快照 + 与旧草案正交", () => {
  const trip = makeTrip();
  withSources(trip, makeSource());
  const draft: PendingGuideDraft = {
    ...makeDraft(trip),
    sourceMode: "selected",
    sourceIds: ["gs_link"],
  };
  trip.pendingGuideDraft = draft;
  assert.equal(draft.sourceMode, "selected");
  assert.deepEqual(draft.sourceIds, ["gs_link"]);
  assert.deepEqual(validateConsistency(trip), [], "元数据字段不影响一致性校验");

  // 旧草案（无 sourceMode / sourceIds）仍然 fresh——新字段与 freshness 判定正交，
  // 来源版本变化由 sourceSnapshots 负责，不因缺元数据误判过期
  const legacy = clone(trip);
  legacy.pendingGuideDraft = makeDraft(legacy);
  legacy.guideDraftNote = makeDraft(legacy).note ?? "";
  assert.equal(legacy.pendingGuideDraft.sourceMode, undefined);
  assert.equal(legacy.pendingGuideDraft.sourceIds, undefined);
  assert.equal(checkPendingGuideDraftFreshness(legacy.pendingGuideDraft, legacy).fresh, true);
});

// ===== 汇总 =====

console.log(`\n[verify-guides] 全部 ${passed} 组场景通过（攻略包 B1 契约）`);
