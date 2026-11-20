/**
 * Task #225 确定性验证（离线：纯内存夹具，不读写 server/data、不调用任何外部服务）。
 *
 * 修复背景（验收问题）：西岛 Visit 已升级为 large_attraction，但 7 个高置信度
 * 岛内玩法（牛王岭、珊瑚石墙、海上书屋…）仍是 state="pending"（visitRef=null），
 * 子 Stop 上的 guideSnippets 因父卡只渲染 childStopRefs 而无处展示。
 *
 * 验证矩阵：
 *   S1 kind 升级与子玩法采纳一次跑完（顺序敏感）：ordinary 蜈支洲岛同轮升级为
 *      large_attraction 后，其高置信度 pending 玩法立刻被采纳，不需要再跑一轮；
 *   S2 采纳落点字段：state=attached / visitRef / order 与 childStopRefs 下标一致 /
 *      suggestedVisitRef 与 relationshipSuggestions 置 null（level 保留）/ 从
 *      pendingStopRefs 移除；
 *   S3 保守边界：medium / low / decidedBy=user 一律不采纳；未排期大景区壳同样
 *      采纳（规格要求对每个 large_attraction Visit 生效），但不动任何一天的时间轴；
 *   S4 本尊提及回填：「西岛」「三亚西岛」并入 Visit.sourceMentionRefs，
 *      岛内玩法「西岛渔村」不误判为本尊；重复运行不重复追加；
 *   S5 一致性：采纳后 validateConsistency 零违规（attached 携带 suggestedVisitRef
 *      会被拒绝，本用例覆盖该红线）；
 *   S6 幂等：同一 Trip 连跑两次，第二次零升级零采纳、childStopRefs 不重复增长；
 *   S7 时间轴：采纳改变父 Visit 的 effectiveMinutes（reserved→item→子玩法汇总），
 *      recomputeDayTimeline 后 = 子玩法建议时长之和。
 *
 * 运行：npx tsx server/src/guides/verify-task225.ts
 */

import assert from "node:assert/strict";
import type { RelationshipSuggestion, SourceEvidence, Stop, Trip, Visit } from "@goplay/shared";
import { recomputeDayTimeline, validateConsistency } from "@goplay/shared";
import { applyTask225Fixes } from "./fix-task225.js";
import { adoptHighConfidenceChildStops } from "./adoptStops.js";

function pass(name: string): void {
  console.log(`✓ ${name}`);
}

/** 行程夹具：一天、西岛（已是大景区）+ 蜈支洲岛（待升级）、亚龙湾（未排期壳） */
function mkVisit(visitId: string, pointRef: string, kind: Visit["kind"], dayRef: string | null, order: number | null): Visit {
  return {
    visitId,
    dayRef,
    pointRef,
    kind,
    visitMode: kind === "large_attraction" ? "full_day" : "custom",
    order,
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
    purchaseState: "unknown",
    locked: false,
    userAdjusted: false,
    removedFrom: null,
    removedAt: null,
  };
}

function mkPendingStop(stopId: string, name: string, suggestMinutes: number | null, suggestedVisitRef: string): Stop {
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
    sourceEvidenceRefs: [],
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
  suggestedVisitRef: string | null,
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

function mkEvidence(): SourceEvidence {
  const mention = (mentionId: string, name: string) => ({
    mentionId,
    text: name,
    quoteText: `${name}的原文句子`,
    bbox: null,
    extractedName: name,
    locationHint: null,
    modelSummary: null,
  });
  return {
    evidenceId: "ev_body",
    kind: "note_text",
    noteIndex: 1,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions: [
      mention("m1", "西岛"),
      mention("m2", "三亚西岛"),
      mention("m3", "西岛渔村"),
      mention("m4", "蜈支洲岛"),
    ],
  };
}

function mkTrip(): Trip {
  const visits: Record<string, Visit> = {
    visit_xidao: mkVisit("visit_xidao", "item_xidao", "large_attraction", "day_1", 0),
    visit_putuo: mkVisit("visit_putuo", "item_putuo", "ordinary", "day_1", 1),
    visit_ylw: mkVisit("visit_ylw", "item_ylw", "large_attraction", null, null),
  };
  const stops: Record<string, Stop> = {
    stop_xd_high: mkPendingStop("stop_xd_high", "牛王岭", 60, "visit_xidao"),
    stop_xd_high2: mkPendingStop("stop_xd_high2", "珊瑚石墙", 30, "visit_xidao"),
    stop_xd_medium: mkPendingStop("stop_xd_medium", "海上书屋", 20, "visit_xidao"),
    stop_xd_low: mkPendingStop("stop_xd_low", "拍照点", 10, "visit_xidao"),
    stop_xd_user: mkPendingStop("stop_xd_user", "渔村", 40, "visit_xidao"),
    stop_pt_high: mkPendingStop("stop_pt_high", "情人桥", 45, "visit_putuo"),
    stop_ylw_high: mkPendingStop("stop_ylw_high", "过江龙索桥", 30, "visit_ylw"),
  };
  return {
    tripId: "trip_verify_225",
    schemaVersion: 2,
    version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: "2026-11-08", nights: 0 },
    dayRefs: ["day_1"],
    days: {
      day_1: {
        dayId: "day_1",
        dayIndex: 1,
        date: "2026-11-08",
        departTime: "09:00",
        departTimeOverridden: false,
        scheduleVisitRefs: ["visit_xidao", "visit_putuo"],
        lodging: null,
      },
    },
    lodgings: {},
    itemRegistry: {
      item_xidao: {
        itemId: "item_xidao",
        name: "西岛",
        origin: "custom",
        providerId: null,
        address: null,
        category: null,
        coords: null,
        suggestMinutes: null, // null = 由岛内玩法汇总（本用例覆盖 S7）
        mainPic: null,
        ticketInfo: null,
        jumpUrl: null,
        sourceEvidenceRefs: [],
      },
      item_putuo: {
        itemId: "item_putuo",
        name: "蜈支洲岛",
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
      },
      item_ylw: {
        itemId: "item_ylw",
        name: "亚龙湾森林公园",
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
      },
    },
    hotelRegistry: {},
    visits,
    stops,
    evidences: { ev_body: mkEvidence() },
    globalCandidateRefs: [{ kind: "visit", id: "visit_ylw" }],
    pendingStopRefs: Object.keys(stops),
    relationshipSuggestions: {
      stop_xd_high: mkSuggestion("stop_xd_high", "high", "system", "visit_xidao"),
      stop_xd_high2: mkSuggestion("stop_xd_high2", "high", "system", "visit_xidao"),
      stop_xd_medium: mkSuggestion("stop_xd_medium", "medium", "system", "visit_xidao"),
      stop_xd_low: mkSuggestion("stop_xd_low", "low", "system", null),
      stop_xd_user: mkSuggestion("stop_xd_user", "high", "user", "visit_xidao"),
      stop_pt_high: mkSuggestion("stop_pt_high", "high", "system", "visit_putuo"),
      stop_ylw_high: mkSuggestion("stop_ylw_high", "high", "system", "visit_ylw"),
    },
    guideSources: {},
    constraints: [],
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
  };
}

function main(): void {
  const trip = mkTrip();
  const result = applyTask225Fixes(trip);

  // ---------- S1 ----------
  assert.deepEqual(
    result.kindUpgrades.map((item) => item.visitId),
    ["visit_putuo"],
    "只在同轮升级 ordinary 的蜈支洲岛（西岛已是 large_attraction）",
  );
  assert.deepEqual(
    result.adoptions.map((item) => item.visitId).sort(),
    ["visit_putuo", "visit_xidao", "visit_ylw"],
    "本轮升级出来的大景区、既有大景区与候选区壳都要采纳（顺序敏感：先升级后采纳）",
  );
  pass("S1 kind 升级与子玩法采纳一次跑完，同轮升级的大景区不被遗漏");

  // ---------- S2 ----------
  const xidao = trip.visits.visit_xidao!;
  assert.deepEqual(
    xidao.childStopRefs,
    ["stop_xd_high", "stop_xd_high2"],
    "只采纳 high 且追加到 childStopRefs 末尾（保持 stops 声明顺序）",
  );
  for (const [index, stopId] of xidao.childStopRefs.entries()) {
    const stop = trip.stops[stopId]!;
    assert.equal(stop.state, "attached", `${stopId} 状态应为 attached`);
    assert.equal(stop.visitRef, "visit_xidao", `${stopId} 归入西岛`);
    assert.equal(stop.order, index, `${stopId} order 与 child 下标一致`);
    assert.equal(stop.suggestedVisitRef, null, `${stopId} attached 后不得携带 suggestedVisitRef`);
    assert.equal(trip.relationshipSuggestions[stopId]?.suggestedVisitRef, null, `${stopId} 建议归属置空`);
    assert.equal(trip.relationshipSuggestions[stopId]?.level, "high", `${stopId} level 保留用于溯源`);
    assert.equal(trip.pendingStopRefs.includes(stopId), false, `${stopId} 从 pendingStopRefs 移除`);
  }
  pass("S2 采纳落点字段全部正确（state / visitRef / order / suggestedVisitRef / pendingStopRefs）");

  // ---------- S3 ----------
  const stillPending = ["stop_xd_medium", "stop_xd_low", "stop_xd_user"];
  for (const stopId of stillPending) {
    assert.equal(trip.stops[stopId]?.state, "pending", `${stopId} 应保持 pending`);
    assert.equal(trip.pendingStopRefs.includes(stopId), true, `${stopId} 应留在待定区`);
  }
  // 候选区壳（未排期）同样采纳：作为城市候选显示子玩法数量，排入某天后直接可见
  assert.deepEqual(trip.visits.visit_ylw!.childStopRefs, ["stop_ylw_high"], "候选区大景区壳也要采纳");
  assert.equal(trip.stops.stop_ylw_high?.state, "attached", "池内壳的子玩法同样落为 attached");
  assert.equal(trip.pendingStopRefs.includes("stop_ylw_high"), false, "池内壳的子玩法也移出待定区");
  pass("S3 保守边界生效：medium / low / 用户已表态不采纳；候选区壳正常采纳");

  // ---------- S4 ----------
  assert.deepEqual(
    xidao.sourceMentionRefs,
    ["ev_body:m1", "ev_body:m2"],
    "只回填本尊提及（西岛 / 三亚西岛），岛内玩法「西岛渔村」不算",
  );
  assert.equal(
    trip.visits.visit_ylw!.sourceMentionRefs?.length ?? 0,
    0,
    "没有本尊提及的 Visit 不写入空引用",
  );
  pass("S4 本尊提及回填正确，岛内玩法名不误判");

  // ---------- S5 ----------
  const errors = validateConsistency(trip);
  assert.deepEqual(errors, [], `采纳后一致性必须零违规，实际：${errors.join("；")}`);
  pass("S5 采纳后一致性校验零违规");

  // ---------- S6 ----------
  const again = adoptHighConfidenceChildStops(trip);
  assert.deepEqual(again, [], "第二次运行不得再有采纳");
  assert.deepEqual(
    xidao.childStopRefs,
    ["stop_xd_high", "stop_xd_high2"],
    "childStopRefs 不得重复增长",
  );
  const againAll = applyTask225Fixes(trip);
  assert.deepEqual(againAll.kindUpgrades, [], "第二次运行不得再升级 kind");
  assert.deepEqual(againAll.adoptions, [], "第二次运行不得再采纳玩法");
  assert.equal(xidao.sourceMentionRefs?.length, 2, "提及不得重复追加");
  pass("S6 幂等：连跑两次零变更、无重复挂载与重复提及");

  // ---------- S7 ----------
  const recomputed = recomputeDayTimeline(trip, 1);
  assert.equal(
    recomputed.visits.visit_xidao?.effectiveMinutes,
    90,
    "西岛 item.suggestMinutes=null 时由子玩法汇总（60 + 30）",
  );
  assert.equal(
    recomputed.visits.visit_putuo?.effectiveMinutes,
    45,
    "同轮升级的蜈支洲岛同样按采纳后的子玩法汇总",
  );
  pass("S7 时间轴重算后父 Visit 时长 = 子玩法建议时长之和");

  // ---------- S8 ----------
  assert.deepEqual(
    result.affectedDayIndexes,
    [1],
    "只有已排期的父 Visit 需要重算时间轴（候选区壳没有天）",
  );
  assert.equal(
    trip.visits.visit_ylw?.effectiveMinutes,
    30,
    "候选区壳无天可重算，采纳时就地刷新 effectiveMinutes",
  );
  assert.equal(
    result.adoptions.find((item) => item.visitId === "visit_ylw")?.dayIndex,
    null,
    "候选区壳采纳记录的 dayIndex 为 null",
  );
  pass("S8 候选区壳采纳只刷新时长、不牵连任何一天的时间轴");

  console.log("\nTask #225 全部验证通过 ✅");
}

try {
  main();
} catch (error) {
  console.error("✗ Task #225 验证失败：", error);
  process.exitCode = 1;
}
