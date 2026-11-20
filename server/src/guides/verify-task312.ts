/**
 * Task #312 确定性验证（离线：桩化 callPlanner，不触网、不调用真实百炼）。
 *
 * 背景：后台装配对 in_attraction 子玩法一律 suppressAttach:true，子 Stop 落成
 * state=pending、父 Visit 的 childStopRefs 为空；运行时缺自动采纳环节，前端 VisitCard
 * 只渲染 childStopRefs 故大景区父卡下的岛内玩法全空白。Task #312 在 applyGuideDraft
 * 内接入 adoptHighConfidenceChildStops（从 fix-task225.ts 抽到正式模块 adoptStops.ts）。
 *
 * 验证矩阵（端到端走 generate → apply 真实链路，桩只提供 planner 输出）：
 *   A1 应用含 large_attraction visit 的草案后，high+system 的 pending stops 自动
 *      attached 且并入 childStopRefs（非空）；从 pendingStopRefs 移除；
 *   A2 decidedBy=user 的高置信度 pending stop 保持 pending（自动通道不覆盖用户表态）；
 *   A3 重复应用幂等：第二轮草案应用后 childStopRefs 不重复增长、无二次采纳；
 *   A4 纯函数直测：对已采纳后的行程再次调用返回空数组。
 *
 * 运行：npx tsx server/src/guides/verify-task312.ts
 * 临时行程（server/data）在脚本末尾全部清理，不影响用户既有数据。
 */

import "../env.js";
import assert from "node:assert/strict";
import type {
  GuideSource,
  Item,
  RelationshipSuggestion,
  SourceEvidence,
  Stop,
  Trip,
  Visit,
} from "@goplay/shared";
import { createEmptyGuideImageProgress, recomputeDayTimeline } from "@goplay/shared";
import { createFixtureSanyaTrip, tripStore } from "../persistence/store.js";
import { adoptHighConfidenceChildStops } from "./adoptStops.js";
import { resetGuidePlannerDeps, setGuidePlannerDeps } from "./planner.js";
import { guideRoutes } from "./routes.js";

function pass(name: string): void {
  console.log(`✓ ${name}`);
}

const createdTripIds: string[] = [];

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

async function loadTrip(tripId: string): Promise<Trip> {
  const trip = await tripStore.load(tripId);
  assert.ok(trip !== null, `行程 ${tripId} 应存在`);
  return trip;
}

// ===== planner 桩：零操作草案（apply 只跑采纳环节，不做结构变更） =====

const STUB_EMPTY_DRAFT = JSON.stringify({ operations: [], snippets: [], optionGroups: [] });
let stubResponses: string[] = [];

function armPlanner(...responses: string[]): void {
  stubResponses = [...responses];
}

setGuidePlannerDeps({
  callPlanner: async () => {
    const next = stubResponses.shift();
    if (next === undefined) throw new Error("桩响应已耗尽（测试准备失误）");
    return next;
  },
});

// ===== 夹具：在三亚验收行程上补一个「空 childStopRefs 的大景区 + 高置信度 pending 子玩法」 =====

function mkMention(
  mentionId: string,
  text: string,
  quoteText: string,
  extractedName: string | null,
): SourceEvidence["mentions"][number] {
  return {
    mentionId,
    text,
    quoteText,
    bbox: null,
    extractedName,
    locationHint: null,
    modelSummary: `【桩】${quoteText}`,
    claimKind: "experience",
    targetScope: "place",
    firsthand: true,
    relationEvidence: null,
  };
}

function mkItem(itemId: string, name: string): Item {
  return {
    itemId,
    name,
    origin: "custom",
    providerId: null,
    address: null,
    category: null,
    coords: null,
    suggestMinutes: null, // null = 由岛内玩法汇总
    mainPic: null,
    ticketInfo: null,
    jumpUrl: null,
    sourceEvidenceRefs: ["ev_312"],
  };
}

function mkPendingStop(stopId: string, name: string, suggestMinutes: number, suggestedVisitRef: string): Stop {
  return {
    stopId,
    state: "pending",
    visitRef: null,
    suggestedVisitRef,
    matchedPointRef: null,
    customName: name,
    order: null,
    suggestMinutes,
    locationHint: null,
    ticketRelation: "unknown",
    sourceEvidenceRefs: ["ev_312"],
    sourceMentionRefs: [],
    userAdjusted: false,
    removedFromOrder: null,
    removedAt: null,
  };
}

function mkSuggestion(
  stopRef: string,
  level: RelationshipSuggestion["level"],
  decidedBy: RelationshipSuggestion["decidedBy"],
  suggestedVisitRef: string,
): RelationshipSuggestion {
  return {
    stopRef,
    suggestedVisitRef,
    level,
    positiveSignals: [`夹具信号：${level}`],
    negativeSignals: [],
    decidedBy,
  };
}

/**
 * 在标准三亚夹具上补：西岛 = large_attraction Visit（Day4，childStopRefs 为空，复现问题现场），
 * 三个高置信度 pending 子玩法（西岛墙 / 珊瑚墙 = system 应采纳；西岛渔村 = user 应保留），
 * 以及一条 ready+active 的攻略来源（generate 需要可用来源）。
 */
async function setupAdoptFixture(tripId: string): Promise<void> {
  const trip = await loadTrip(tripId);

  trip.itemRegistry["item_xidao"] = mkItem("item_xidao", "西岛");

  const visit: Visit = {
    visitId: "visit_xidao",
    dayRef: "day_4",
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
    externalLeg: null,
    childStopRefs: [], // 问题现场：装配 suppressAttach 后父卡为空
    alternateStopRefs: [],
    sourceMentionRefs: [],
    purchaseState: "unknown",
    locked: false,
    userAdjusted: false,
    removedFrom: null,
    removedAt: null,
  };
  trip.visits["visit_xidao"] = visit;
  const day4 = trip.days["day_4"];
  assert.ok(day4 !== undefined, "前提：三亚夹具应有 day_4");
  day4.scheduleVisitRefs = ["visit_xidao"];

  trip.stops["stop_wall"] = mkPendingStop("stop_wall", "西岛墙", 30, "visit_xidao");
  trip.stops["stop_coral"] = mkPendingStop("stop_coral", "珊瑚墙", 40, "visit_xidao");
  trip.stops["stop_fishing"] = mkPendingStop("stop_fishing", "西岛渔村", 50, "visit_xidao");
  trip.pendingStopRefs = [...trip.pendingStopRefs, "stop_wall", "stop_coral", "stop_fishing"];

  trip.relationshipSuggestions["stop_wall"] = mkSuggestion("stop_wall", "high", "system", "visit_xidao");
  trip.relationshipSuggestions["stop_coral"] = mkSuggestion("stop_coral", "high", "system", "visit_xidao");
  // 用户已表态（例如手动移回待定）：自动通道不得覆盖
  trip.relationshipSuggestions["stop_fishing"] = mkSuggestion("stop_fishing", "high", "user", "visit_xidao");

  trip.evidences["ev_312"] = {
    evidenceId: "ev_312",
    kind: "note_text",
    noteIndex: 312,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions: [
      mkMention("m1", "西岛", "西岛是个小众海岛", "西岛"),
      mkMention("m2", "西岛墙", "西岛墙是网红打卡点", "西岛墙"),
      mkMention("m3", "珊瑚墙", "珊瑚墙适合浮潜", "珊瑚墙"),
      mkMention("m4", "西岛渔村", "西岛渔村可以吃海鲜", "西岛渔村"),
    ],
  };

  const importedAt = "2026-10-19T08:00:00.000Z";
  const source: GuideSource = {
    sourceId: "src_312",
    sourceVersion: 1,
    inputKind: "text",
    title: "西岛深度攻略（312）",
    active: true,
    status: "ready",
    evidenceRefs: ["ev_312"],
    mentionRefs: ["ev_312:m1", "ev_312:m2", "ev_312:m3", "ev_312:m4"],
    imageProgress: createEmptyGuideImageProgress(),
    importedAt,
    updatedAt: importedAt,
  };
  trip.guideSources = { ...(trip.guideSources ?? {}), src_312: source };
  trip.guideDraftNote = "";

  const next = recomputeDayTimeline(trip, 4);
  await tripStore.save(next);
}

async function generateAndApply(tripId: string): Promise<Record<string, unknown>> {
  armPlanner(STUB_EMPTY_DRAFT);
  const genRes = await requestJson(`/trips/${tripId}/draft`, "POST", { scope: { kind: "trip" } });
  assert.equal(genRes.status, 200, `生成草案应 200（实际 ${JSON.stringify(genRes.body)}）`);
  const applyRes = await requestJson(`/trips/${tripId}/draft/apply`, "POST");
  assert.equal(applyRes.status, 200, `应用草案应 200（实际 ${JSON.stringify(applyRes.body)}）`);
  return applyRes.body;
}

async function runScenarios(): Promise<void> {
  const trip = await createFixtureSanyaTrip();
  createdTripIds.push(trip.tripId);
  const tripId = trip.tripId;
  await setupAdoptFixture(tripId);

  // 前置：应用前 childStopRefs 为空，三个子玩法都在待定区
  const before = await loadTrip(tripId);
  assert.deepEqual(before.visits.visit_xidao?.childStopRefs, [], "前置：大景区父卡 childStopRefs 应为空");
  assert.equal(before.stops.stop_wall?.state, "pending", "前置：stop_wall 应为 pending");

  // ---------- A1 / A2：首轮应用 ----------
  await generateAndApply(tripId);
  const after = await loadTrip(tripId);
  const xidao = after.visits.visit_xidao!;
  assert.deepEqual(
    xidao.childStopRefs,
    ["stop_wall", "stop_coral"],
    "A1：high+system 的两个子玩法应自动采纳进 childStopRefs（user 表态的不在内）",
  );
  for (const stopId of ["stop_wall", "stop_coral"]) {
    const stop = after.stops[stopId]!;
    assert.equal(stop.state, "attached", `A1：${stopId} 应落为 attached`);
    assert.equal(stop.visitRef, "visit_xidao", `A1：${stopId} 应归入西岛`);
    assert.equal(stop.suggestedVisitRef, null, `A1：${stopId} attached 后不得携带 suggestedVisitRef`);
    assert.equal(after.pendingStopRefs.includes(stopId), false, `A1：${stopId} 应从 pendingStopRefs 移除`);
  }
  // A2：decidedBy=user 的高置信度子玩法保持 pending
  const fishing = after.stops.stop_fishing!;
  assert.equal(fishing.state, "pending", "A2：decidedBy=user 的子玩法应保持 pending");
  assert.equal(fishing.visitRef, null, "A2：user 子玩法 visitRef 仍为空");
  assert.equal(after.pendingStopRefs.includes("stop_fishing"), true, "A2：user 子玩法仍留在待定区");
  assert.equal(
    after.relationshipSuggestions.stop_fishing?.decidedBy,
    "user",
    "A2：user 表态不被覆盖",
  );
  pass("A1 high+system pending 子玩法自动 attached 且 childStopRefs 非空；A2 decidedBy=user 保持 pending");

  // ---------- A3：重复应用幂等 ----------
  await generateAndApply(tripId);
  const again = await loadTrip(tripId);
  assert.deepEqual(
    again.visits.visit_xidao?.childStopRefs,
    ["stop_wall", "stop_coral"],
    "A3：第二轮应用后 childStopRefs 不得重复增长",
  );
  assert.equal(again.stops.stop_fishing?.state, "pending", "A3：user 子玩法第二轮仍保持 pending");
  assert.equal(
    again.pendingStopRefs.filter((id) => id === "stop_wall" || id === "stop_coral").length,
    0,
    "A3：已采纳子玩法不得回到待定区",
  );
  pass("A3 重复应用幂等：childStopRefs 不重复增长、无二次采纳");

  // ---------- A4：纯函数直测（已采纳后再调返回空） ----------
  const direct = adoptHighConfidenceChildStops(again);
  assert.deepEqual(direct, [], "A4：对已采纳行程再次调用纯函数应返回空数组（幂等）");
  pass("A4 纯函数直测：已采纳后再次调用返回空数组");

  console.log("\n[verify] Task #312 全部通过 ✓");
}

async function main(): Promise<void> {
  try {
    await runScenarios();
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

main().catch((error: unknown) => {
  console.error("✗ Task #312 验证失败：", error);
  process.exitCode = 1;
});
