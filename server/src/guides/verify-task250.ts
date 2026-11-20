/**
 * Task #250 确定性验证（离线：不调用百炼 / FlyAI / 小红书）。
 *
 * 目标：草案可解释性——用户在应用前能区分「将移出 / 重新排入 / 本轮新增 /
 * 既有保留 / 仅补亮点」，replace 草案直接消费 replaceRemovedVisitIds /
 * replaceKeptVisitIds 给出「移回 N 项 + 保留 N 项」摘要；应用后仍能说明实际发生了什么。
 *
 * 验证矩阵：
 *   S1 分类准确性：3 项移出 + 1 项锁定保留 + 2 项新增 + 1 项仅补亮点（Day2 未参与）
 *   S2 append 草案：不产生全日替换摘要；未参与的既有安排不进入分类
 *   S3 模型显式排回目标天：旧安排归为「重新排入」而非保留 / 移出
 *   S4 replace 摘要与冲突 / 满足校验共存（旧字段零回归）
 *   S5 apply：旧草案（无 explanation 字段）仍可应用；结果携带实际调整摘要；
 *      应用后行程 = 本轮新增 + 保护保留项，移回项回到候选池
 *   S6（Task #253）：属性 / 内部路线调整归为「调整」（不得因有 snippet 就标成仅补亮点）；
 *      classify 子项的预览日期取父 Visit 的模拟终态天（父同批移动也正确）
 *
 * 运行：npx tsx server/src/guides/verify-task250.ts
 * 临时行程（server/data）在 finally 全部清理，不影响用户既有数据。
 */

import "../env.js";
import assert from "node:assert/strict";
import type {
  Item,
  Operation,
  PendingGuideDraft,
  PendingGuideDraftSnippet,
  Trip,
  Visit,
} from "@goplay/shared";
import { checkPendingGuideDraftFreshness } from "@goplay/shared";
import { createFixtureSanyaTrip, tripStore } from "../persistence/store.js";
import { parseDraftDirectives, enforceDraftDirectives } from "./directives.js";
import { buildDraftExplanation } from "./explain.js";
import { applyGuideDraft } from "./planner.js";

function pass(name: string): void {
  console.log(`✓ ${name}`);
}

/** 本脚本创建的临时行程：finally 统一清理 */
const createdTripIds: string[] = [];

async function loadTrip(tripId: string): Promise<Trip> {
  const trip = await tripStore.load(tripId);
  assert.ok(trip !== null, `行程 ${tripId} 应存在`);
  return trip;
}

function buildItem(itemId: string, name: string): Item {
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

function addVisitToDay(
  trip: Trip,
  input: {
    visitId: string;
    name: string;
    dayIndex: number;
    locked?: boolean;
    purchaseState?: Visit["purchaseState"];
  },
): void {
  const day = trip.days[`day_${input.dayIndex}`];
  assert.ok(day !== undefined, `Day ${input.dayIndex} 应存在`);
  trip.itemRegistry[`item_${input.visitId}`] = buildItem(`item_${input.visitId}`, input.name);
  const visit: Visit = {
    visitId: input.visitId,
    dayRef: day.dayId,
    pointRef: `item_${input.visitId}`,
    kind: "ordinary",
    visitMode: "custom",
    order: day.scheduleVisitRefs.length,
    windowStart: null,
    windowEnd: null,
    startTime: null,
    endTime: null,
    startTimeOverridden: false,
    endTimeOverridden: false,
    reservedMinutes: null,
    effectiveMinutes: null,
    externalLeg: { mode: "驾车", minutes: 20, note: null, source: "user" },
    childStopRefs: [],
    alternateStopRefs: [],
    sourceMentionRefs: [],
    purchaseState: input.purchaseState ?? "unknown",
    locked: input.locked ?? false,
    userAdjusted: false,
    removedFrom: null,
    removedAt: null,
  };
  trip.visits[input.visitId] = visit;
  day.scheduleVisitRefs.push(input.visitId);
}

function addPoolVisit(trip: Trip, visitId: string, name: string): void {
  trip.itemRegistry[`item_${visitId}`] = buildItem(`item_${visitId}`, name);
  const visit: Visit = {
    visitId,
    dayRef: null,
    pointRef: `item_${visitId}`,
    kind: "ordinary",
    visitMode: "custom",
    order: null,
    windowStart: null,
    windowEnd: null,
    startTime: null,
    endTime: null,
    startTimeOverridden: false,
    endTimeOverridden: false,
    reservedMinutes: null,
    effectiveMinutes: null,
    externalLeg: { mode: "驾车", minutes: 20, note: null, source: "user" },
    childStopRefs: [],
    alternateStopRefs: [],
    sourceMentionRefs: [],
    purchaseState: "unknown",
    locked: false,
    userAdjusted: false,
    removedFrom: null,
    removedAt: null,
  };
  trip.visits[visitId] = visit;
  trip.globalCandidateRefs.push({ kind: "visit", id: visitId });
}

/**
 * 夹具：Day2 = visit_wzz（本轮只补亮点，不参与结构）；Day3 = 第一市场 / 南山 /
 * 天涯海角（普通）+ 西岛（锁定）；亚龙湾 / 海棠湾在候选池（本轮新增排入 Day3）。
 */
async function buildFixture(): Promise<Trip> {
  const trip = await createFixtureSanyaTrip();
  createdTripIds.push(trip.tripId);
  addVisitToDay(trip, { visitId: "visit_nanshan", name: "南山文化旅游区", dayIndex: 3 });
  addVisitToDay(trip, { visitId: "visit_tianya", name: "天涯海角", dayIndex: 3 });
  addVisitToDay(trip, { visitId: "visit_locked", name: "西岛", dayIndex: 3, locked: true });
  addPoolVisit(trip, "visit_ylw", "亚龙湾热带天堂森林公园");
  addPoolVisit(trip, "visit_haitang", "海棠湾免税城");
  await tripStore.save(trip);
  return loadTrip(trip.tripId);
}

function planTwoNewIntoDay3(): Operation {
  return {
    op: "plan",
    scopeRef: { kind: "day", dayIndex: 3 },
    assignments: [
      {
        subjectRef: { kind: "visit", id: "visit_ylw" },
        containerRef: { kind: "day", dayIndex: 3 },
        order: 0,
      },
      {
        subjectRef: { kind: "visit", id: "visit_haitang" },
        containerRef: { kind: "day", dayIndex: 3 },
        order: 1,
      },
    ],
    reason: "按攻略重排 Day3：亚龙湾 + 海棠湾",
  };
}

const snippetForWzz: PendingGuideDraftSnippet = {
  text: "后海村傍晚有落日市集",
  claimKind: "experience",
  targetRef: { kind: "visit", id: "visit_wzz" },
  sourceMentionRefs: ["ev_1:m_1"],
};

function classificationOf(
  explanation: ReturnType<typeof buildDraftExplanation>,
  visitId: string,
): string | undefined {
  return explanation.items.find(
    (item) => item.targetRef.kind === "visit" && item.targetRef.id === visitId,
  )?.classification;
}

/** S1：replace 全量分类准确性（3 移出 / 1 保留 / 2 新增 / 1 仅补亮点） */
async function scenarioReplaceClassification(): Promise<void> {
  const trip = await buildFixture();
  const directives = parseDraftDirectives("重新做下DAY3的行程", trip);
  assert.equal(directives[0]?.mode, "replace");
  const enforced = enforceDraftDirectives(trip, directives, [planTwoNewIntoDay3()]);
  const explanation = buildDraftExplanation({
    trip,
    operations: enforced.operations,
    snippets: [snippetForWzz],
    directives: enforced.directives,
  });

  assert.deepEqual(explanation.counts, {
    remove: 3,
    rearrange: 0,
    new: 2,
    adjust: 0,
    retain: 1,
    snippet_only: 1,
  });

  for (const visitId of ["visit_market", "visit_nanshan", "visit_tianya"]) {
    assert.equal(classificationOf(explanation, visitId), "remove", `${visitId} 应为移出`);
  }
  assert.equal(classificationOf(explanation, "visit_locked"), "retain", "锁定项应为既有保留");
  assert.equal(classificationOf(explanation, "visit_ylw"), "new");
  assert.equal(classificationOf(explanation, "visit_haitang"), "new");
  assert.equal(classificationOf(explanation, "visit_wzz"), "snippet_only", "Day2 未被结构触碰，仅补亮点");
  assert.equal(
    explanation.items.some((item) => item.targetRef.kind === "visit" && item.targetRef.id === "visit_ghost"),
    false,
  );

  const lockedItem = explanation.items.find(
    (item) => item.targetRef.kind === "visit" && item.targetRef.id === "visit_locked",
  );
  assert.match(lockedItem?.detail ?? "", /已锁定/, "保留项需说明真实原因（锁定）");
  assert.equal(lockedItem?.dayIndex, 3);
  const wzzItem = explanation.items.find(
    (item) => item.targetRef.kind === "visit" && item.targetRef.id === "visit_wzz",
  );
  assert.match(wzzItem?.detail ?? "", /仅补充 1 条攻略亮点/);

  // replace 摘要：数量 + 名称 + 保护原因，全部来自 directive 元数据
  assert.equal(explanation.replaceSummaries.length, 1);
  const summary = explanation.replaceSummaries[0];
  assert.equal(summary?.dayIndex, 3);
  assert.deepEqual(
    summary?.removed.map((entry) => entry.displayName),
    ["第一市场", "南山文化旅游区", "天涯海角"],
  );
  assert.deepEqual(
    summary?.kept.map((entry) => `${entry.displayName}:${entry.reason}`),
    ["西岛:已锁定"],
  );
  assert.match(summary?.text ?? "", /Day3 将移回 3 项（第一市场、南山文化旅游区、天涯海角）/);
  assert.match(summary?.text ?? "", /保留 1 项（西岛，已锁定）/);
  assert.match(summary?.text ?? "", /再按所选攻略重排/);

  pass("S1 replace 分类：3 移出 / 1 锁定保留 / 2 新增 / 1 仅补亮点 + 摘要数量与名称");
}

/** S2：append 草案不产生全日替换摘要；未参与草案的既有安排不进入分类 */
async function scenarioAppendClassification(): Promise<void> {
  const trip = await buildFixture();
  const directives = parseDraftDirectives("DAY3安排亚龙湾", trip);
  assert.equal(directives[0]?.mode, undefined);
  const enforced = enforceDraftDirectives(trip, directives, [planTwoNewIntoDay3()]);
  const explanation = buildDraftExplanation({
    trip,
    operations: enforced.operations,
    snippets: [],
    directives: enforced.directives,
  });

  assert.deepEqual(explanation.replaceSummaries, [], "append 不得生成整日替换摘要");
  assert.equal(explanation.counts.remove, 0, "append 不得把既有安排标为移出");
  for (const visitId of ["visit_market", "visit_nanshan", "visit_tianya", "visit_locked"]) {
    assert.equal(
      classificationOf(explanation, visitId),
      undefined,
      `append 下未参与的既有安排不得进入分类（${visitId}）`,
    );
  }
  assert.equal(classificationOf(explanation, "visit_ylw"), "new");
  assert.equal(classificationOf(explanation, "visit_haitang"), "new");

  pass("S2 append：无 replace 摘要 / 无移出误标 / 未参与项不出现");
}

/** S3：模型显式把旧安排排回目标天 → 「重新排入」（原已在目标 Day 且参与本轮重排） */
async function scenarioModelKeepsAsRearrange(): Promise<void> {
  const trip = await buildFixture();
  const directives = parseDraftDirectives("重新做下DAY3的行程", trip);
  const modelOps: Operation[] = [
    {
      op: "plan",
      scopeRef: { kind: "day", dayIndex: 3 },
      assignments: [
        {
          subjectRef: { kind: "visit", id: "visit_ylw" },
          containerRef: { kind: "day", dayIndex: 3 },
          order: 0,
        },
        {
          subjectRef: { kind: "visit", id: "visit_market" },
          containerRef: { kind: "day", dayIndex: 3 },
          order: 1,
        },
      ],
      reason: "保留第一市场并重排 Day3",
    },
  ];
  const enforced = enforceDraftDirectives(trip, directives, modelOps);
  const explanation = buildDraftExplanation({
    trip,
    operations: enforced.operations,
    directives: enforced.directives,
  });
  assert.equal(classificationOf(explanation, "visit_market"), "rearrange");
  assert.equal(classificationOf(explanation, "visit_ylw"), "new");
  assert.equal(classificationOf(explanation, "visit_nanshan"), "remove");
  assert.equal(classificationOf(explanation, "visit_locked"), "retain");

  const marketItem = explanation.items.find(
    (item) => item.targetRef.kind === "visit" && item.targetRef.id === "visit_market",
  );
  assert.match(marketItem?.detail ?? "", /参与本轮重排/);

  pass("S3 模型保留旧安排：归类为「重新排入」，不误标移出 / 保留");
}

/** S4：replace 摘要与既有冲突 / 满足校验共存（Task #248 契约零回归） */
async function scenarioMetadataRegression(): Promise<void> {
  const trip = await buildFixture();
  const directives = parseDraftDirectives("重新做下DAY3的行程", trip);
  const enforced = enforceDraftDirectives(trip, directives, [planTwoNewIntoDay3()]);
  const kinds = enforced.conflicts.map((conflict) => conflict.kind);
  assert.ok(kinds.includes("target_day_replace"), "整日替换摘要冲突保留");
  assert.ok(kinds.includes("replace_kept_protected"), "保护项保留告知保留");
  assert.equal(kinds.includes("target_day_occupied"), false);
  assert.equal(enforced.requirementChecks[0]?.status, "met");
  assert.match(enforced.requirementChecks[0]?.detail ?? "", /移回候选池/);
  assert.deepEqual(
    enforced.directives[0]?.replaceRemovedVisitIds,
    ["visit_market", "visit_nanshan", "visit_tianya"],
  );

  pass("S4 冲突 / requirementChecks / 指令元数据不回归");
}

/**
 * 把草案手术式写入行程并落盘；explanation 缺省（模拟 Task #250 之前的旧草案）。
 * baseTripVersion 预判 tripStore.save 恰自增 1，保证应用时版本保护 fresh。
 */
async function attachLegacyDraft(
  tripId: string,
  operations: Operation[],
  directives: PendingGuideDraft["directives"],
): Promise<string> {
  const trip = await loadTrip(tripId);
  const draft: PendingGuideDraft = {
    draftId: `draft_task250_${trip.version + 1}`,
    baseTripVersion: trip.version + 1,
    scope: { kind: "trip" },
    sourceSnapshots: [],
    mentionIds: [],
    note: null,
    createdAt: new Date().toISOString(),
    output: { operations, snippets: [] },
    ...(directives !== undefined && directives.length > 0 ? { directives } : {}),
  };
  trip.pendingGuideDraft = draft;
  await tripStore.save(trip);
  const saved = await loadTrip(tripId);
  const attached = saved.pendingGuideDraft;
  assert.ok(attached !== undefined, "草案应已落盘");
  const freshness = checkPendingGuideDraftFreshness(attached, saved);
  assert.equal(freshness.fresh, true, `草案应 fresh（${freshness.details.join("；")}）`);
  assert.equal(attached.explanation, undefined, "旧草案不带 explanation 字段");
  return draft.draftId;
}

/** S5：旧草案可应用；结果说明实际发生的调整；应用后行程符合分类预期 */
async function scenarioApplySummary(): Promise<void> {
  const trip = await buildFixture();
  const directives = parseDraftDirectives("重新做下DAY3的行程", trip);
  const enforced = enforceDraftDirectives(trip, directives, [planTwoNewIntoDay3()]);
  const draftId = await attachLegacyDraft(trip.tripId, enforced.operations, enforced.directives);

  // Task #253：整日移回需带与当前草案绑定的明确确认
  const result = await applyGuideDraft(trip.tripId, undefined, { draftId, confirmed: true });
  assert.equal(result.type, "applied", `不应产生待确认提案（${JSON.stringify(result.needsProposal)}）`);
  assert.equal(result.rejectedCount, 0, `不应有护栏拒绝（${result.rejectSummary ?? ""}）`);
  assert.equal(result.appliedSummary, "实际调整：移出 3 项、新增 2 项");
  assert.match(result.message, /实际调整：移出 3 项、新增 2 项/, "成功消息应保留简短实际调整摘要");

  // 既有可见性字段不回归
  assert.equal(result.requirementChecks[0]?.status, "met");
  assert.match(result.requirementChecks[0]?.detail ?? "", /已移回候选池/);
  assert.ok(result.autoClassifications.length === 0);

  const after = await loadTrip(trip.tripId);
  assert.deepEqual(after.days.day_3?.scheduleVisitRefs, ["visit_ylw", "visit_haitang", "visit_locked"]);
  for (const visitId of ["visit_market", "visit_nanshan", "visit_tianya"]) {
    assert.equal(after.visits[visitId]?.dayRef, null, `${visitId} 应已回到候选池`);
  }
  assert.deepEqual(after.days.day_2?.scheduleVisitRefs, ["visit_wzz"], "未参与的 Day2 原样保留");
  assert.equal(after.pendingGuideDraft, undefined, "草案一次性消费");

  pass("S5 旧草案应用：实际调整摘要 / 行程符合分类 / 既有字段不回归");
}

/**
 * S6（Task #253）：属性 / 内部路线调整必须归为「调整」，不能因为本轮有 snippet 就被标成
 * 「仅补亮点」；classify 子项的预览日期取父 Visit 的**模拟终态天**（父同批移动也正确）。
 */
async function scenarioAdjustClassification(): Promise<void> {
  const trip = await buildFixture();
  const operations: Operation[] = [
    // 属性调整：停留时长（不改天）
    { op: "setDuration", subjectRef: { kind: "visit", id: "visit_wzz" }, minutes: 90, reason: "后海半天" },
    // 内部玩法同天改序（父 Visit 的内部路线真实变更）
    {
      op: "move",
      subjectRef: { kind: "stop", id: "stop_beach" },
      containerRef: { kind: "visit", id: "visit_wzz" },
      toOrder: 0,
      reason: "把海滨浴场放到最前",
    },
    // 父 Visit 同批移到 Day4 + 归类：子项预览日期必须是父的终态天（4），不是原天（4 之前）
    {
      op: "move",
      subjectRef: { kind: "visit", id: "visit_tianya" },
      containerRef: { kind: "day", dayIndex: 4 },
      toOrder: 0,
      reason: "把天涯海角挪到 Day4",
    },
    {
      op: "classifyVisitAsStop",
      visitId: "visit_nanshan",
      parentVisitId: "visit_tianya",
      toOrder: null,
      evidenceMentionRefs: [],
      reason: "南山归入天涯海角内部行程",
    },
  ];
  const explanation = buildDraftExplanation({
    trip,
    operations,
    snippets: [
      snippetForWzz,
      {
        text: "海滨浴场上午人少",
        claimKind: "experience",
        targetRef: { kind: "stop", id: "stop_beach" },
        sourceMentionRefs: ["ev_1:m_1"],
      },
    ],
  });

  // visit_wzz：有属性调整 + snippet → adjust（绝对不能被标成 snippet_only）
  const wzz = explanation.items.find(
    (item) => item.targetRef.kind === "visit" && item.targetRef.id === "visit_wzz",
  );
  assert.equal(wzz?.classification, "adjust", "属性调整 + snippet 必须归为「调整」");
  assert.equal(wzz?.dayIndex, 2);
  assert.match(wzz?.detail ?? "", /停留时长改为 90 分钟/, "应展示属性调整依据");
  assert.match(wzz?.detail ?? "", /内部玩法顺序调整/, "父 Visit 的内部路线变更也要计入依据");

  // 归类子项：预览日期 = 父 Visit 的模拟终态天
  const nanshan = explanation.items.find(
    (item) => item.targetRef.kind === "visit" && item.targetRef.id === "visit_nanshan",
  );
  assert.equal(nanshan?.classification, "rearrange");
  assert.equal(nanshan?.dayIndex, 4, "预览日期必须取父 Visit 的模拟终态天（父同批移动）");
  assert.match(nanshan?.detail ?? "", /内部行程/);

  // 内部 Stop：有真实路线调整 + snippet → adjust，预览日取父 Visit 终态天
  const stop = explanation.items.find(
    (item) => item.targetRef.kind === "stop" && item.targetRef.id === "stop_beach",
  );
  assert.equal(stop?.classification, "adjust");
  assert.equal(stop?.dayIndex, 2, "Stop 预览日期取父 Visit 的终态天");
  assert.match(stop?.detail ?? "", /同天顺序调整/);
  assert.match(stop?.detail ?? "", /另补充 1 条攻略亮点/, "调整项仍保留亮点补充说明");

  // adjust 只覆盖属性 / 内部玩法（visit_wzz + stop_beach）；父 Visit 与归类子项属于结构变更
  assert.equal(
    explanation.counts.adjust,
    2,
    `adjust 计数应仅覆盖属性 / 内部玩法（实际 ${explanation.counts.adjust}）`,
  );
  assert.ok(explanation.counts.rearrange >= 2, "父 Visit 移动与归类子项应计入「重新排入」");
  assert.equal(explanation.counts.snippet_only, 0, "本轮没有任何实体应被标成「仅补亮点」");

  // 反例：**完全无操作**的实体 + snippet 仍为 snippet_only（口径未被放宽）
  const plain = buildDraftExplanation({ trip, operations: [], snippets: [snippetForWzz] });
  assert.equal(classificationOf(plain, "visit_wzz"), "snippet_only");

  pass("S6 调整分类与预览日：属性 / 内部路线归为 adjust、classify 预览取父终态天、Stop 不误标");
}

async function main(): Promise<void> {
  try {
    await scenarioReplaceClassification();
    await scenarioAppendClassification();
    await scenarioModelKeepsAsRearrange();
    await scenarioMetadataRegression();
    await scenarioApplySummary();
    await scenarioAdjustClassification();
    console.log("\nTask #250 全部验证通过 ✅");
  } finally {
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

await main();
