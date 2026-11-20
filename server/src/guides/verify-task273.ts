/**
 * Task #273：真实生产路径 optionGroups 信号漏判修复验证（全程离线，不触网）。
 *
 * 已确认根因（真实行程 48275e19 / 来源 src_913c9426 / 证据 ev_note_6）：
 * - 同一篇「西岛交通方式」被 NER 拆成 4 个地点：西岛 / 渔村 / 牛王岭 / 乌龟滩；
 * - quoteText 只留半句，丢了「步行 / 电动车 / 电动三轮车」与 25-40、5-10 两档价格；
 * - Task #270 的 per-place 判据在每个地点都凑不出 ≥2 方案 → 漏判，真实草案只产出 3 条
 *   snippets、0 组 optionGroups。
 *
 * 修复：在 per-place 之上新增「按 sourceId 聚合」判定层，并优先用 GuideSource.sourceText
 * 原文；不同来源之间绝不合并。命中来源的完整原文还会补进【攻略素材】，否则即使第七节
 * 解锁，模型也拿不到被 NER 丢掉的方式与价格。
 *
 * 场景：
 *   1. 根因复现：逐地点判定全部不命中；按来源 + sourceText 命中且包含四方式与多价格；
 *   2. 同来源跨地点拆分：单地点无 ≥2 方案，仍由来源层命中（不能靠地点层）；
 *   3. 不同来源各一个选项不合并误命中；同一来源聚齐两方式才命中；
 *   4. 普通亮点（日落 / 早上人少）不命中；
 *   5. 生产 prompt：mentionCount=4、attraction 与 trip scope 都注入完整第七节 +
 *      来源原文补充 + 四方式；
 *   6. snippet-only 快速路径：其他条件全部满足且无信号 → hit；补上 sourceText 信号后
 *      必须 miss（回退完整 planner）；
 *   7. 端到端：真实来源 + 临时行程副本（不碰用户主行程）→ 桩 planner 被调用 1 次，
 *      prompt 带完整契约与来源原文，草案正常落盘。
 *
 * 运行：npx tsx server/src/guides/verify-task273.ts
 * 真实行程只读；临时行程副本在脚本末尾删除。
 */

import "../env.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { DraftScope, EvidenceMention, Trip } from "@goplay/shared";
import { tripStore } from "../persistence/store.js";
import { mergeGuideMentions, type GuideMergeResult, type MergedMention, type MergedPlace } from "./merge.js";
import {
  collectMergeSourceTexts,
  collectPlaceTexts,
  detectMergeOptionGroupSignals,
  detectOptionGroupSignals,
} from "./optionSignals.js";
import {
  buildGuidePlannerPrompt,
  resetGuidePlannerDeps,
  resolveSnippetOnlyFastPath,
  setGuidePlannerDeps,
} from "./planner.js";
import { guideRoutes } from "./routes.js";

function pass(name: string): void {
  console.log(`✓ ${name}`);
}

// ===== 真实数据常量（只读） =====

const REAL_TRIP_ID = "48275e19-c7cb-417b-8ef7-57b04e097cf4";
const REAL_SOURCE_ID = "src_913c9426";
const REAL_EVIDENCE_ID = "ev_note_6";
const REAL_XIDAO_VISIT_ID = "visit_2217b269-803d-4be9-b329-7c4677ff0cc4_1";
const EXPECTED_TERMS = ["步行", "电动车", "观光车", "电动三轮车"];

const createdTripIds: string[] = [];

// ===== planner 桩（端到端场景用，不触网） =====

let stubResponses: string[] = [];
const capturedPrompts: string[] = [];

function armPlanner(...responses: string[]): void {
  stubResponses = [...responses];
  capturedPrompts.length = 0;
}

setGuidePlannerDeps({
  callPlanner: async (prompt: string) => {
    capturedPrompts.push(prompt);
    const next = stubResponses.shift();
    if (next === undefined) throw new Error("桩响应已耗尽（测试准备失误）");
    return next;
  },
});

const STUB_NOOP_JSON = JSON.stringify({ operations: [], snippets: [], optionGroups: [] });

async function requestJson(
  routePath: string,
  method: "GET" | "POST" | "PUT",
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await guideRoutes.request(routePath, init);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

// ===== 夹具 =====

async function loadRealTrip(): Promise<Trip> {
  const trip = await tripStore.load(REAL_TRIP_ID);
  assert.ok(trip !== null, `真实行程 ${REAL_TRIP_ID} 应存在（server/data）`);
  assert.ok(trip.visits[REAL_XIDAO_VISIT_ID] !== undefined, "真实行程应含西岛 visit");
  const source = trip.guideSources?.[REAL_SOURCE_ID];
  assert.ok(source !== undefined, `真实行程应含来源 ${REAL_SOURCE_ID}`);
  assert.ok(
    typeof source.sourceText === "string" && source.sourceText.includes("电动三轮车"),
    "真实来源应保留完整原文（sourceText 含电动三轮车）",
  );
  return trip;
}

function mkMergedMention(ref: string, sourceId: string, quoteText: string): MergedMention {
  const [evidenceId = "ev_syn", mentionId = "m1"] = ref.split(":");
  return {
    ref,
    sourceId,
    evidenceId,
    mentionId,
    mention: {
      mentionId,
      text: quoteText,
      quoteText,
      bbox: null,
      extractedName: null,
      locationHint: null,
      modelSummary: null,
      claimKind: null,
      targetScope: null,
      firsthand: true,
      relationEvidence: null,
    } as unknown as EvidenceMention,
  };
}

/** 合成 merge：每条提及独立成地点（模拟未对齐 / 跨地点），只用于来源聚合边界测试 */
function buildSyntheticMerge(entries: readonly { sourceId: string; quote: string }[]): GuideMergeResult {
  const places: MergedPlace[] = entries.map((entry, index) => {
    const mention = mkMergedMention(`ev_syn:m${index + 1}`, entry.sourceId, entry.quote);
    return {
      key: `u:${mention.ref}`,
      displayName: `地点${index + 1}`,
      entityRef: null,
      providerId: null,
      mentions: [mention],
    };
  });
  const mentions = places.flatMap((place) => place.mentions);
  return {
    sourceSnapshots: [...new Set(entries.map((entry) => entry.sourceId))].map((sourceId) => ({
      sourceId,
      sourceVersion: 1,
    })),
    mentions,
    places,
    mentionIds: mentions.map((entry) => entry.mentionId),
    mentionRefs: mentions.map((entry) => entry.ref),
  };
}

/** 深拷贝真实行程（只在内存里改，不落盘） */
function cloneTrip(trip: Trip): Trip {
  return JSON.parse(JSON.stringify(trip)) as Trip;
}

// ===== 场景 =====

async function runScenarios(): Promise<void> {
  const trip = await loadRealTrip();
  const merge = mergeGuideMentions(trip, { selectedSourceIds: new Set([REAL_SOURCE_ID]) });

  // ---------- 场景 1：根因复现 + 修复后命中 ----------
  {
    assert.equal(merge.mentions.length, 4, "真实来源应有 4 条提及");
    assert.ok(merge.places.length >= 3, `真实素材应被拆到多个地点（实际：${merge.places.map((p) => p.displayName).join(" / ")}）`);
    const perPlace = merge.places.map((place) => ({ place, result: detectOptionGroupSignals(collectPlaceTexts(place)) }));
    const perPlaceHits = perPlace.filter((entry) => entry.result.hit).map((entry) => entry.place.displayName);
    assert.deepEqual(perPlaceHits, [], `逐地点判定应全部不命中（根因；实际命中：${perPlaceHits.join(" / ")}）`);

    const signals = detectMergeOptionGroupSignals(merge, {
      sourceTexts: collectMergeSourceTexts(trip, merge),
    });
    assert.equal(signals.hit, true, "按来源 + sourceText 判定应命中");
    for (const term of EXPECTED_TERMS) {
      assert.ok(
        signals.optionTerms.includes(term),
        `命中选项词应包含「${term}」（实际：${signals.optionTerms.join(" / ")}）`,
      );
    }
    assert.ok(signals.priceCount >= 3, `应识别出多档价格（实际 ${signals.priceCount}）`);
    assert.equal(signals.priceRange, true, "「25-40 元/天」应识别为价格区间");
    pass("1. 根因：逐地点判定 0 命中（4 地点拆分 + quoteText 截断）；按来源 + sourceText 命中四方式与多价格");
  }

  // ---------- 场景 2：同来源跨地点拆分仍命中（命中来自来源层而非地点层） ----------
  {
    const signals = detectMergeOptionGroupSignals(merge, {
      sourceTexts: collectMergeSourceTexts(trip, merge),
    });
    assert.equal(signals.hit, true, "同来源跨地点拆分仍应命中");
    assert.equal(signals.places.length, 0, "真实素材没有单地点聚齐 ≥2 方案（证明不是地点层命中）");
    assert.ok(signals.sources.includes(REAL_SOURCE_ID), "命中来源应包含真实西岛来源");
    assert.ok(
      signals.reasons.some((reason) => reason.includes(`来源 ${REAL_SOURCE_ID}`)),
      "命中理由应标注来源，便于线上排查",
    );
    // 即使没有 sourceText，同来源 4 条提及聚合也应命中（价格档位型：交通主题 + 建议坐 + 价格区间）
    const aggregated = detectMergeOptionGroupSignals(merge);
    assert.equal(aggregated.hit, true, "同来源跨地点提及聚合本身也应命中（不依赖 sourceText）");
    assert.ok(aggregated.sources.includes(REAL_SOURCE_ID));
    pass("2. 跨地点：来源层命中且 places 为空；仅聚合提及（无 sourceText）同样命中");
  }

  // ---------- 场景 3：不同来源不合并 / 同来源聚齐才命中 ----------
  {
    const cross = buildSyntheticMerge([
      { sourceId: "s1", quote: "渔村就在码头左侧，走过去很近" },
      { sourceId: "s2", quote: "牛王岭在岛的另一头，路有点远" },
    ]);
    const crossSignals = detectMergeOptionGroupSignals(cross, {
      sourceTexts: new Map([
        ["s1", "西岛：可以步行过去，大约 20 分钟。"],
        ["s2", "蜈支洲岛：观光车 30 元一位。"],
      ]),
    });
    assert.equal(crossSignals.hit, false, "不同来源各一个方式不得合并成一组对比");
    assert.equal(crossSignals.sources.length, 0);

    const same = buildSyntheticMerge([
      { sourceId: "s1", quote: "渔村就在码头左侧，走过去很近" },
      { sourceId: "s1", quote: "牛王岭在岛的另一头，路有点远" },
    ]);
    const sameSignals = detectMergeOptionGroupSignals(same, {
      sourceTexts: new Map([["s1", "西岛：可以步行过去，大约 20 分钟；也可以坐观光车，30 元一位。"]]),
    });
    assert.equal(sameSignals.hit, true, "同一来源原文聚齐两种方式应命中");
    assert.deepEqual(sameSignals.sources, ["s1"]);
    pass("3. 来源隔离：跨来源不合并（hit=false）；同来源聚齐两方式命中");
  }

  // ---------- 场景 4：普通亮点不命中 ----------
  {
    const plain = buildSyntheticMerge([{ sourceId: "s9", quote: "鹿回头傍晚看日落很美" }]);
    const plainSignals = detectMergeOptionGroupSignals(plain, {
      sourceTexts: new Map([["s9", "鹿回头傍晚看日落很美，建议早上去人少，一小时足够。"]]),
    });
    assert.equal(plainSignals.hit, false, "普通亮点（日落 / 早上人少）不得命中");
    assert.equal(plainSignals.optionTerms.length, 0, "普通亮点不应命中任何选项词");
    pass("4. 普通亮点：日落 / 早上人少 不命中（不误涨 prompt）");
  }

  // ---------- 场景 5：生产 prompt 注入（attraction / trip 两种 scope） ----------
  {
    assert.equal(merge.mentions.length, 4, "前提：提及 4 条（低于阈值 5）");
    const scopes: DraftScope[] = [
      { kind: "attraction", visitId: REAL_XIDAO_VISIT_ID },
      { kind: "trip" },
    ];
    for (const scope of scopes) {
      const prompt = buildGuidePlannerPrompt(trip, merge, scope);
      const label = scope.kind === "attraction" ? "attraction scope" : "trip scope";
      assert.ok(
        prompt.includes("七、optionGroups（实用参考选项组，Task #190）"),
        `${label} 有 sourceText 信号 → 应注入完整第七节`,
      );
      assert.ok(
        !prompt.includes("七、optionGroups：本轮不适用，输出空数组 []"),
        `${label} 信号命中时不得输出降级短声明`,
      );
      assert.ok(prompt.includes("整个景区通用的交通方式"), `${label} 应包含父 visit 归属指导`);
      assert.ok(prompt.includes("【来源原文补充】"), `${label} 应补发命中来源的完整原文`);
      assert.ok(prompt.includes("电动三轮车"), `${label} prompt 应含 NER 丢掉的「电动三轮车」`);
      assert.ok(prompt.includes("25-40 元/天"), `${label} prompt 应含被截断的电动车价格`);
    }
    pass("5. prompt：4 条提及 + attraction / trip scope 均注入完整第七节，并补发来源原文（四方式 + 价格）");
  }

  // ---------- 场景 6：快速路径因信号回退（隔离 sourceText 这一个变量） ----------
  {
    const fastTrip = cloneTrip(trip);
    const visit = fastTrip.visits[REAL_XIDAO_VISIT_ID];
    assert.ok(visit !== undefined);
    visit.sourceMentionRefs = [...(visit.sourceMentionRefs ?? []), ...merge.mentionRefs];
    const evidence = fastTrip.evidences[REAL_EVIDENCE_ID];
    assert.ok(evidence !== undefined);
    // 改成「无方案词、但能提炼亮点」的原文，模拟「其他条件全部满足」的快速路径场景
    const plainQuotes = [
      "西岛渔村小巷很有烟火气，适合慢慢逛，拍照出片",
      "码头左侧海岸线海景清澈，适合拍照",
      "牛王岭人少安静，适合看海",
      "乌龟滩海水清澈，能见度高",
    ];
    evidence.mentions.forEach((mention, index) => {
      const quote = plainQuotes[index % plainQuotes.length] ?? "";
      mention.quoteText = quote;
      mention.modelSummary = quote;
    });
    const fastMerge = mergeGuideMentions(fastTrip, { selectedSourceIds: new Set([REAL_SOURCE_ID]) });
    assert.equal(fastMerge.places.length, 1, "对齐后应聚合为单地点（快速路径前提）");

    const source = fastTrip.guideSources?.[REAL_SOURCE_ID];
    assert.ok(source !== undefined);
    const savedSourceText = source.sourceText;
    delete source.sourceText;
    const withoutSignal = resolveSnippetOnlyFastPath({
      trip: fastTrip,
      merge: fastMerge,
      note: "补充西岛的实用建议",
      directives: [],
      sourceMode: "selected",
    });
    assert.equal(
      withoutSignal.kind,
      "hit",
      `无信号且其他条件满足时应走快速路径（实际：${JSON.stringify(withoutSignal)}）`,
    );

    source.sourceText = savedSourceText;
    const withSignal = resolveSnippetOnlyFastPath({
      trip: fastTrip,
      merge: fastMerge,
      note: "补充西岛的实用建议",
      directives: [],
      sourceMode: "selected",
    });
    assert.equal(withSignal.kind, "miss", "sourceText 信号命中后快速路径必须回退");
    assert.ok(
      withSignal.kind === "miss" && withSignal.reason.includes("可比较选项组信号"),
      `回退原因应指向选项组信号（实际：${withSignal.kind === "miss" ? withSignal.reason : "hit"}）`,
    );
    pass("6. 快速路径：无信号 hit → 补上 sourceText 信号后 miss（回退完整 planner）");
  }

  // ---------- 场景 7：端到端（临时副本，不碰用户主行程） ----------
  {
    const temp = cloneTrip(trip);
    temp.tripId = randomUUID();
    delete temp.pendingGuideDraft;
    temp.guideDraftNote = "";
    const visit = temp.visits[REAL_XIDAO_VISIT_ID];
    assert.ok(visit !== undefined);
    visit.sourceMentionRefs = [...(visit.sourceMentionRefs ?? []), ...merge.mentionRefs];
    await tripStore.save(temp);
    createdTripIds.push(temp.tripId);

    armPlanner(STUB_NOOP_JSON);
    const res = await requestJson(`/trips/${temp.tripId}/draft`, "POST", {
      scope: { kind: "attraction", visitId: REAL_XIDAO_VISIT_ID },
      sourceMode: "selected",
      selectedSourceIds: [REAL_SOURCE_ID],
      note: "补充西岛的实用建议",
    });
    assert.equal(res.status, 200, `生成应 200（实际 ${JSON.stringify(res.body)}）`);
    assert.equal(capturedPrompts.length, 1, "有信号时不得走快速路径（planner 应被调用 1 次）");
    const prompt = capturedPrompts[0] ?? "";
    assert.ok(prompt.includes("七、optionGroups（实用参考选项组，Task #190）"), "prompt 应含完整第七节");
    assert.ok(prompt.includes("【来源原文补充】"), "prompt 应补发命中来源原文");
    assert.ok(prompt.includes("电动三轮车"), "prompt 应含被 NER 丢掉的方式");

    const saved = await tripStore.load(temp.tripId);
    assert.ok(saved?.pendingGuideDraft?.output !== undefined, "草案应持久化到临时行程");
    assert.deepEqual(saved.pendingGuideDraft.output.operations, [], "桩响应无操作");
    pass("7. 端到端：真实来源 + 临时副本 → planner 调用 1 次，prompt 带完整契约与来源原文，草案落盘");
  }
}

async function main(): Promise<void> {
  try {
    await runScenarios();
    console.log("\n[verify] Task #273（真实生产路径 optionGroups 信号漏判修复）全部通过 ✓");
  } finally {
    resetGuidePlannerDeps();
    let removed = 0;
    for (const tripId of createdTripIds) {
      try {
        await tripStore.deleteTrip(tripId);
        removed += 1;
      } catch (error) {
        console.warn(`[verify] 清理临时行程 ${tripId} 失败:`, error);
      }
    }
    console.log(`[verify] 已清理 ${removed}/${createdTripIds.length} 个临时行程（server/data）`);
  }
}

void main();
