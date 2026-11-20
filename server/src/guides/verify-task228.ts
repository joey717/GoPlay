/**
 * Task #228 确定性验证（离线：不调用百炼 / FlyAI / 小红书）。
 *
 * 修复背景：百炼返回的草案常把 plan（把候选池景点排入某天）与 setDuration（给该
 * 景点及子玩法设时长）放在同一批 operations。旧 applyGuideDraft 用 checkGuards 一次性
 * 校验全部操作——此时 plan 尚未执行，实体仍在候选池 → setDuration 被 G1 拒绝
 * （「未排入任何一天，无法设置时长」）→ 少量必拒项把违规率放大过 30% → 整批拒绝，
 * 合法的 plan / setTime 全部陪葬。
 *
 * 修复方案（两阶段应用）：
 *   结构阶段（plan / transfer / classifyVisitAsStop）先校验并执行 → 得到中间行程；
 *   属性阶段（setDuration / setTime / move / remove 等）基于中间行程校验后再执行；
 *   30% 阈值在两阶段合并后按全部操作总数统一计算（基数不按阶段拆分，阈值语义不放宽）。
 *
 * 验证矩阵：
 *   S1 主场景：候选池 visit（西岛同构）+ plan 排入 Day4 + setDuration + setTime
 *      （外加 1 条引用 pending stop 的 setDuration，验证 Task #218 预过滤叠加）→
 *      三条全部应用、零拒绝；候选池迁移正确、pending 状态不受影响、草案消费落盘；
 *   S2 阈值基数回归：合法 plan + 合法 setDuration + 1 条引用不存在 visit 的非法
 *      setDuration → 合并违规率 1/3 > 30% → 整批拒绝（合法操作不得绕过阈值，
 *      结构阶段合法 plan 一并弃用），行程逐字段不变；
 *   S3 结构阶段全拒回归：plan 引用不存在 visit（拒）+ setDuration 候选池 visit（拒）
 *      → 属性阶段退回原始行程校验，行为与修改前一致（整批拒绝、候选池不变）；
 *   S4 敏感分流跨阶段合并：合法 plan（结构阶段）+ remove（属性阶段敏感项）→
 *      plan 应用、remove 转 needsProposal，两阶段结果正确合并。
 *
 * 运行：npx tsx server/src/guides/verify-task228.ts
 * 临时行程（server/data）在 finally 全部清理，不影响用户既有数据。
 */

import "../env.js";
import assert from "node:assert/strict";
import type { Item, Operation, PendingGuideDraft, Trip, Visit } from "@goplay/shared";
import { checkPendingGuideDraftFreshness } from "@goplay/shared";
import { createFixtureSanyaTrip, tripStore } from "../persistence/store.js";
import { applyGuideDraft } from "./planner.js";

// ===== 基础辅助 =====

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

/** 向夹具写入候选池 visit（西岛同构：dayRef=null + 入 globalCandidateRefs）并落盘 */
async function addCandidateVisit(tripId: string): Promise<void> {
  const trip = await loadTrip(tripId);
  const item: Item = {
    itemId: "item_xidao",
    name: "西岛",
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
  trip.itemRegistry["item_xidao"] = item;
  const visit: Visit = {
    visitId: "visit_xidao",
    dayRef: null,
    pointRef: "item_xidao",
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
    externalLeg: { mode: "驾车", minutes: 40, note: null, source: "user" },
    childStopRefs: [],
    alternateStopRefs: [],
    sourceMentionRefs: [],
    purchaseState: "unknown",
    locked: false,
    userAdjusted: false,
    removedFrom: null,
    removedAt: null,
  };
  trip.visits["visit_xidao"] = visit;
  trip.globalCandidateRefs.push({ kind: "visit", id: "visit_xidao" });
  await tripStore.save(trip);
}

/**
 * 把草案手术式写入行程并落盘（baseTripVersion 预判 tripStore.save 恰自增 1，
 * 保证应用时版本保护 fresh）；写盘后断言 freshness，防夹具自身配置漂移。
 */
async function attachDraft(tripId: string, operations: Operation[]): Promise<void> {
  const trip = await loadTrip(tripId);
  const draft: PendingGuideDraft = {
    draftId: `draft_task228_${trip.version + 1}`,
    baseTripVersion: trip.version + 1,
    scope: { kind: "trip" },
    sourceSnapshots: [],
    mentionIds: [],
    note: null,
    createdAt: new Date().toISOString(),
    output: { operations, snippets: [] },
  };
  trip.pendingGuideDraft = draft;
  await tripStore.save(trip);
  const saved = await loadTrip(tripId);
  const attached = saved.pendingGuideDraft;
  assert.ok(attached !== undefined, "草案应已落盘");
  const freshness = checkPendingGuideDraftFreshness(attached, saved);
  assert.equal(freshness.fresh, true, `草案应 fresh（${freshness.details.join("；")}）`);
}

/** 构造「把 visit_xidao 从候选池排入 Day4」的合法 plan（多数场景复用） */
function planXidaoIntoDay4(reason: string): Operation {
  return {
    op: "plan",
    scopeRef: { kind: "day", dayIndex: 4 },
    assignments: [
      { subjectRef: { kind: "visit", id: "visit_xidao" }, containerRef: { kind: "day", dayIndex: 4 }, order: 0 },
    ],
    reason,
  };
}

async function main(): Promise<void> {
  try {
    await runScenarios();
    console.log("\nTask #228 全部验证通过 ✅");
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

async function runScenarios(): Promise<void> {
  // ============ S1：主场景——plan + setDuration + setTime 同批两阶段应用 ============
  {
    const trip = await createFixtureSanyaTrip();
    createdTripIds.push(trip.tripId);
    await addCandidateVisit(trip.tripId);

    await attachDraft(trip.tripId, [
      planXidaoIntoDay4("把西岛排入 Day4"),
      { op: "setDuration", subjectRef: { kind: "visit", id: "visit_xidao" }, minutes: 240, reason: "西岛建议留半天" },
      { op: "setTime", subjectRef: { kind: "day", dayIndex: 4 }, target: "dayDepart", value: "08:15", reason: "早点出发" },
      // Task #218 预过滤与两阶段护栏叠加：引用 pending stop 的必拒项在护栏前剥离
      {
        op: "setDuration",
        subjectRef: { kind: "stop", id: "stop_snack" },
        minutes: 20,
        reason: "引用 pending stop（应被预过滤剥离）",
      },
    ]);

    const result = await applyGuideDraft(trip.tripId);
    assert.equal(result.type, "applied", `应为 applied（实际：${result.message}）`);
    assert.equal(result.applied.length, 3, "plan + setDuration + setTime 应全部应用（Task #228 修复点）");
    assert.equal(result.rejectedCount, 0, "setDuration 不再因候选池被 G1 误拒，应零拒绝");
    assert.equal(result.allRejected, false);
    assert.equal(result.rejectSummary, null, "零拒绝时原因摘要应为 null");
    assert.ok(result.message.includes("已按攻略草案更新行程"), `message 实际：${result.message}`);

    const saved = await loadTrip(trip.tripId);
    assert.equal(saved.visits.visit_xidao?.dayRef, "day_4", "plan 应已把西岛排入 Day4");
    assert.ok(saved.days.day_4?.scheduleVisitRefs.includes("visit_xidao"), "Day4 行程应包含 visit_xidao");
    assert.equal(saved.visits.visit_xidao?.reservedMinutes, 240, "setDuration 应已生效（Visit 写 reservedMinutes）");
    assert.equal(saved.days.day_4?.departTime, "08:15", "setTime dayDepart 应已生效");
    assert.ok(
      !saved.globalCandidateRefs.some((ref) => ref.kind === "visit" && ref.id === "visit_xidao"),
      "西岛应已移出候选池",
    );
    assert.equal(saved.stops.stop_snack?.state, "pending", "pending stop 状态不得被改动（Task #218 剥离）");
    assert.equal(saved.stops.stop_snack?.suggestMinutes, 30, "pending stop 时长不得被改动");
    assert.equal(saved.pendingGuideDraft, undefined, "草案应一次性消费");
    pass("S1 主场景：plan+setDuration+setTime 同批应用成功（零拒绝），pending 引用预剥离，候选池正确迁移");
  }

  // ============ S2：阈值基数回归——合并后按全部操作总数计算 30% ============
  {
    const trip = await createFixtureSanyaTrip();
    createdTripIds.push(trip.tripId);
    await addCandidateVisit(trip.tripId);
    const before = await loadTrip(trip.tripId);
    const stopBridgeMinutes = before.stops.stop_bridge?.suggestMinutes ?? null;

    await attachDraft(trip.tripId, [
      planXidaoIntoDay4("合法 plan（结构阶段）"),
      {
        op: "setDuration",
        subjectRef: { kind: "stop", id: "stop_bridge" },
        minutes: 50,
        reason: "合法 setDuration（stop 已挂载）",
      },
      {
        op: "setDuration",
        subjectRef: { kind: "visit", id: "visit_ghost" },
        minutes: 60,
        reason: "引用不存在 visit（G1 必拒）",
      },
    ]);

    const result = await applyGuideDraft(trip.tripId);
    assert.equal(result.rejectedCount, 3, "合并违规率 1/3 > 30% 应整批拒绝（3 条全部计入 rejected）");
    assert.equal(result.applied.length, 0, "结构阶段合法 plan 不得绕过合并阈值");
    assert.equal(result.allRejected, true);
    assert.ok(
      String(result.rejectSummary).includes("G1"),
      `逐条原因应保留具体 G1 拒绝原因（实际：${result.rejectSummary}）`,
    );
    assert.ok(result.message.includes("因安全规则被拒绝"), `message 实际：${result.message}`);

    const saved = await loadTrip(trip.tripId);
    assert.equal(saved.visits.visit_xidao?.dayRef, null, "结构阶段合法 plan 一并弃用，候选池不变");
    assert.equal(saved.stops.stop_bridge?.suggestMinutes, stopBridgeMinutes, "行程逐字段不变");
    assert.equal(saved.pendingGuideDraft, undefined, "整批拒绝后草案仍应消费落盘");
    pass("S2 阈值基数回归：30% 按全部操作总数计算，结构阶段合法操作随整批拒绝弃用，行程不变");
  }

  // ============ S3：结构阶段全拒回归——属性阶段退回原始行程校验 ============
  {
    const trip = await createFixtureSanyaTrip();
    createdTripIds.push(trip.tripId);
    await addCandidateVisit(trip.tripId);

    await attachDraft(trip.tripId, [
      {
        op: "plan",
        scopeRef: { kind: "day", dayIndex: 4 },
        assignments: [
          { subjectRef: { kind: "visit", id: "visit_ghost" }, containerRef: { kind: "day", dayIndex: 4 }, order: 0 },
        ],
        reason: "引用不存在 visit（结构阶段必拒）",
      },
      {
        op: "setDuration",
        subjectRef: { kind: "visit", id: "visit_xidao" },
        minutes: 240,
        reason: "候选池 visit 设时长（对原始行程必拒）",
      },
    ]);

    const result = await applyGuideDraft(trip.tripId);
    assert.equal(result.rejectedCount, 2, "2/2 全拒应整批拒绝");
    assert.equal(result.applied.length, 0);
    assert.equal(result.allRejected, true);
    const saved = await loadTrip(trip.tripId);
    assert.equal(saved.visits.visit_xidao?.dayRef, null, "候选池不变");
    pass("S3 结构阶段全拒回归：属性阶段退回原始行程校验，行为与修改前一致（整批拒绝）");
  }

  // ============ S4：敏感分流跨阶段合并——结构阶段应用 + 属性阶段敏感项转提案 ============
  {
    const trip = await createFixtureSanyaTrip();
    createdTripIds.push(trip.tripId);
    await addCandidateVisit(trip.tripId);

    await attachDraft(trip.tripId, [
      planXidaoIntoDay4("合法 plan（结构阶段先应用）"),
      {
        op: "remove",
        subjectRef: { kind: "visit", id: "visit_market" },
        fromContainerRef: { kind: "day", dayIndex: 3 },
        reason: "敏感 remove（属性阶段转 needsProposal）",
      },
    ]);

    const result = await applyGuideDraft(trip.tripId);
    assert.equal(result.type, "proposal", "含敏感操作时响应应为 proposal");
    assert.equal(result.applied.length, 1, "结构阶段 plan 应照常应用");
    assert.equal(result.needsProposal.length, 1, "属性阶段敏感 remove 应转提案");
    assert.equal(result.needsProposal[0]?.op, "remove");
    assert.equal(result.rejectedCount, 0, "无护栏拒绝项");

    const saved = await loadTrip(trip.tripId);
    assert.equal(saved.visits.visit_xidao?.dayRef, "day_4", "plan 生效");
    assert.ok(saved.visits.visit_market !== undefined, "敏感 remove 不得执行（行程保持完整）");
    assert.equal(saved.pendingGuideDraft, undefined, "草案仍应一次性消费");
    pass("S4 敏感分流跨阶段合并：结构阶段应用 + 属性阶段敏感项转提案，两阶段结果正确合并");
  }
}

main()
  .catch((error) => {
    console.error("✗ Task #228 验证失败：", error);
    process.exitCode = 1;
  });
