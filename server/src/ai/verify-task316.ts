/**
 * Task #316 回归验证脚本（离线、桩化 AI op 集，走 pipeline 级 harness）。
 *
 * 覆盖 Gwen #314 重放表的 20 个批次（A–T），断言：
 * - 放行批（A/D/E/F/G/L/O/Q/S）：行为不变，合法操作正常应用；
 * - 修复批（B/K/M/R/C）：stop 越权操作被前置剥离，剥离项带 G1 理由可见于 rejected，
 *   剩余合法 ops 成功应用、行程对应字段生效；
 * - 真违规批（H/I/J/N/T/P）：仍按阈值整批或逐条拒绝，理由可读，阈值语义未变；
 * - 剥离幂等：无 stop 越权 ops 时零影响；
 * - B3 通道（planner）同形态批次行为不变（不测，因 B3 走 verify-b3.ts 独立覆盖）。
 *
 * 运行：npx tsx server/src/ai/verify-task316.ts
 */

import assert from "node:assert/strict";
import type { Operation, OperationSet, Trip } from "@goplay/shared";
import { createFixtureSanyaTrip, tripStore } from "../persistence/store.js";
import { applyOperationSet, stripUnsupportedStopOps } from "./pipeline.js";

function pass(name: string): void {
  console.log(`✓ ${name}`);
}

function opSet(tripVersion: number, operations: Operation[]): OperationSet {
  return { baseVersion: tripVersion, operations, unplaced: [], proposedNew: [], clarify: null };
}

/** 每次测试前重载行程（避免上一步变更影响下一步断言） */
async function freshTrip(tripId: string): Promise<Trip> {
  const trip = await tripStore.load(tripId);
  assert.ok(trip !== null, `行程 ${tripId} 应存在`);
  return trip;
}

// ===== 主验证 =====

async function main(): Promise<void> {
  const created = await createFixtureSanyaTrip();
  const tripId = created.tripId;
  console.log(`[verify-task316] 临时行程 ${tripId}（标准三亚验收结构）\n`);

  // =============== 放行批（A/D/E/F/G/L/O/Q/S）：合法操作正常应用 ===============

  // ---- Batch A：setDuration visit + move stop（合法操作混合）----
  {
    const trip = await freshTrip(tripId);
    const result = await applyOperationSet(trip, opSet(trip.version, [
      { op: "setDuration", subjectRef: { kind: "visit", id: "visit_market" }, minutes: 150, reason: "延长第一市场" },
      { op: "move", subjectRef: { kind: "stop", id: "stop_rock" }, containerRef: { kind: "visit", id: "visit_wzz" }, toOrder: 0, reason: "观日岩优先" },
    ]));
    assert.equal(result.type, "applied");
    assert.equal(result.result!.applied.length, 2);
    assert.equal(result.result!.rejected.length, 0);
    pass("Batch A 放行：setDuration visit + move stop 全部应用");
  }

  // ---- Batch D：setTime day departTime + setDuration visit ----
  {
    const trip = await freshTrip(tripId);
    const result = await applyOperationSet(trip, opSet(trip.version, [
      { op: "setTime", subjectRef: { kind: "day", dayIndex: 2 }, value: "07:30", target: "dayDepart", reason: "提前出发" },
      { op: "setDuration", subjectRef: { kind: "visit", id: "visit_market" }, minutes: 90, reason: "缩短第一市场" },
    ]));
    assert.equal(result.type, "applied");
    assert.equal(result.result!.applied.length, 2);
    assert.equal(result.result!.rejected.length, 0);
    pass("Batch D 放行：setTime day + setDuration visit");
  }

  // ---- Batch E：plan visit→day ----
  {
    const trip = await freshTrip(tripId);
    const result = await applyOperationSet(trip, opSet(trip.version, [
      {
        op: "plan",
        scopeRef: { kind: "day", dayIndex: 3 },
        assignments: [
          { subjectRef: { kind: "visit", id: "visit_market" }, containerRef: { kind: "day", dayIndex: 3 }, order: 0 },
        ],
        reason: "重排 Day3",
      },
    ]));
    assert.equal(result.type, "applied");
    assert.equal(result.result!.applied.length, 1);
    pass("Batch E 放行：plan visit→day");
  }

  // ---- Batch F：move visit within day（Day3 只有一个 visit，toOrder=0 合法）----
  {
    const trip = await freshTrip(tripId);
    const result = await applyOperationSet(trip, opSet(trip.version, [
      { op: "move", subjectRef: { kind: "visit", id: "visit_market" }, containerRef: { kind: "day", dayIndex: 3 }, toOrder: 0, reason: "确认首位" },
    ]));
    assert.equal(result.type, "applied");
    assert.equal(result.result!.applied.length, 1);
    pass("Batch F 放行：move visit within day");
  }

  // ---- Batch G：setDuration on stop（合法操作）----
  {
    const trip = await freshTrip(tripId);
    const result = await applyOperationSet(trip, opSet(trip.version, [
      { op: "setDuration", subjectRef: { kind: "stop", id: "stop_bridge" }, minutes: 50, reason: "情人桥缩短" },
      { op: "setDuration", subjectRef: { kind: "stop", id: "stop_beach" }, minutes: 120, reason: "海滨浴场延长" },
    ]));
    assert.equal(result.type, "applied");
    assert.equal(result.result!.applied.length, 2);
    assert.equal(result.result!.rejected.length, 0);
    // 验证字段生效
    assert.equal(result.result!.trip.stops["stop_bridge"].suggestMinutes, 50);
    assert.equal(result.result!.trip.stops["stop_beach"].suggestMinutes, 120);
    pass("Batch G 放行：setDuration on stop（合法），字段生效");
  }

  // ---- Batch L：plan stop→visit（合法重排内部玩法顺序）----
  {
    const trip = await freshTrip(tripId);
    const result = await applyOperationSet(trip, opSet(trip.version, [
      {
        op: "plan",
        scopeRef: { kind: "day", dayIndex: 2 },
        assignments: [
          { subjectRef: { kind: "stop", id: "stop_rock" }, containerRef: { kind: "visit", id: "visit_wzz" }, order: 0 },
          { subjectRef: { kind: "stop", id: "stop_bridge" }, containerRef: { kind: "visit", id: "visit_wzz" }, order: 1 },
          { subjectRef: { kind: "stop", id: "stop_beach" }, containerRef: { kind: "visit", id: "visit_wzz" }, order: 2 },
        ],
        reason: "重排内部玩法顺序",
      },
    ]));
    assert.equal(result.type, "applied");
    assert.equal(result.result!.applied.length, 1);
    assert.equal(result.result!.rejected.length, 0);
    pass("Batch L 放行：plan stop→visit 容器（合法）");
  }

  // ---- Batch O：setTime on visit（start time）----
  {
    const trip = await freshTrip(tripId);
    const result = await applyOperationSet(trip, opSet(trip.version, [
      { op: "setTime", subjectRef: { kind: "visit", id: "visit_market" }, value: "10:00", target: "start", reason: "设定开始时间" },
    ]));
    assert.equal(result.type, "applied");
    assert.equal(result.result!.applied.length, 1);
    pass("Batch O 放行：setTime on visit");
  }

  // ---- Batch Q：setTime dayDepart ----
  {
    const trip = await freshTrip(tripId);
    const result = await applyOperationSet(trip, opSet(trip.version, [
      { op: "setTime", subjectRef: { kind: "day", dayIndex: 4 }, value: "08:00", target: "dayDepart", reason: "第四天早起" },
    ]));
    assert.equal(result.type, "applied");
    assert.equal(result.result!.applied.length, 1);
    pass("Batch Q 放行：setTime dayDepart");
  }

  // ---- Batch S：move stop within visit（合法改序）----
  {
    const trip = await freshTrip(tripId);
    const result = await applyOperationSet(trip, opSet(trip.version, [
      { op: "move", subjectRef: { kind: "stop", id: "stop_beach" }, containerRef: { kind: "visit", id: "visit_wzz" }, toOrder: 0, reason: "海滨浴场先去" },
    ]));
    assert.equal(result.type, "applied");
    assert.equal(result.result!.applied.length, 1);
    pass("Batch S 放行：move stop within visit");
  }

  // =============== 修复批（B/K/M/R/C）：stop 越权 → 前置剥离 ===============

  // ---- Batch B：stop setTime + 合法 ops → 剥离项可见 + 剩余应用 ----
  {
    const trip = await freshTrip(tripId);
    const result = await applyOperationSet(trip, opSet(trip.version, [
      { op: "setDuration", subjectRef: { kind: "visit", id: "visit_market" }, minutes: 100, reason: "合法" },
      { op: "setTime", subjectRef: { kind: "stop", id: "stop_rock" }, value: "14:00", target: "start", reason: "越权：stop setTime" },
      { op: "move", subjectRef: { kind: "stop", id: "stop_bridge" }, containerRef: { kind: "visit", id: "visit_wzz" }, toOrder: 2, reason: "合法改序" },
    ]));
    assert.equal(result.type, "applied");
    // 合法操作应用
    assert.equal(result.result!.applied.length, 2);
    // 剥离项进入 rejected
    assert.equal(result.result!.rejected.length, 1);
    assert.match(result.result!.rejected[0].reason, /\[G1\]/);
    assert.match(result.result!.rejected[0].reason, /内部玩法不支持设置具体开始时间/);
    // 验证合法 ops 字段生效
    assert.equal(result.result!.trip.visits["visit_market"].effectiveMinutes, 100);
    pass("Batch B 修复：stop setTime 被剥离（理由可见）+ 剩余合法 ops 应用");
  }

  // ---- Batch K：stop setPurchase + 合法 ops → 剥离 + 剩余应用 ----
  {
    const trip = await freshTrip(tripId);
    const result = await applyOperationSet(trip, opSet(trip.version, [
      { op: "setDuration", subjectRef: { kind: "stop", id: "stop_beach" }, minutes: 60, reason: "合法" },
      { op: "setPurchase", subjectRef: { kind: "stop", id: "stop_bridge" }, value: "bought", reason: "越权：stop setPurchase" },
    ]));
    assert.equal(result.type, "applied");
    assert.equal(result.result!.applied.length, 1);
    assert.equal(result.result!.rejected.length, 1);
    assert.match(result.result!.rejected[0].reason, /\[G1\]/);
    assert.match(result.result!.rejected[0].reason, /内部玩法不支持独立购买状态/);
    assert.equal(result.result!.trip.stops["stop_beach"].suggestMinutes, 60);
    pass("Batch K 修复：stop setPurchase 被剥离 + 剩余 setDuration 应用");
  }

  // ---- Batch M：stop lock + 合法 ops → 剥离 + 剩余应用 ----
  {
    const trip = await freshTrip(tripId);
    const result = await applyOperationSet(trip, opSet(trip.version, [
      { op: "setTime", subjectRef: { kind: "day", dayIndex: 3 }, value: "08:30", target: "dayDepart", reason: "合法" },
      { op: "lock", subjectRef: { kind: "stop", id: "stop_beach" }, value: true, reason: "越权：stop lock" },
      { op: "setDuration", subjectRef: { kind: "visit", id: "visit_market" }, minutes: 110, reason: "合法" },
    ]));
    assert.equal(result.type, "applied");
    assert.equal(result.result!.applied.length, 2);
    assert.equal(result.result!.rejected.length, 1);
    assert.match(result.result!.rejected[0].reason, /\[G1\]/);
    assert.match(result.result!.rejected[0].reason, /内部玩法不支持锁定/);
    pass("Batch M 修复：stop lock 被剥离 + 剩余合法 ops 应用");
  }

  // ---- Batch R：多条 stop setTime + 合法 ops → 全部剥离 + 剩余应用 ----
  {
    const trip = await freshTrip(tripId);
    const result = await applyOperationSet(trip, opSet(trip.version, [
      { op: "setTime", subjectRef: { kind: "stop", id: "stop_rock" }, value: "10:00", target: "start", reason: "越权1" },
      { op: "setTime", subjectRef: { kind: "stop", id: "stop_bridge" }, value: "11:00", target: "start", reason: "越权2" },
      { op: "setTime", subjectRef: { kind: "stop", id: "stop_beach" }, value: "12:00", target: "start", reason: "越权3" },
      { op: "setDuration", subjectRef: { kind: "stop", id: "stop_rock" }, minutes: 45, reason: "合法" },
    ]));
    assert.equal(result.type, "applied");
    assert.equal(result.result!.applied.length, 1);
    assert.equal(result.result!.rejected.length, 3);
    for (const rej of result.result!.rejected) {
      assert.match(rej.reason, /\[G1\].*内部玩法不支持设置具体开始时间/);
    }
    assert.equal(result.result!.trip.stops["stop_rock"].suggestMinutes, 45);
    pass("Batch R 修复：3 条 stop setTime 全部剥离（各带理由）+ 剩余 setDuration 应用");
  }

  // ---- Batch C：plan stop→day 容器 + 合法 ops → 剥离 + 剩余应用 ----
  {
    const trip = await freshTrip(tripId);
    const result = await applyOperationSet(trip, opSet(trip.version, [
      {
        op: "plan",
        scopeRef: { kind: "day", dayIndex: 2 },
        assignments: [
          // 合法：stop→visit 容器
          { subjectRef: { kind: "stop", id: "stop_bridge" }, containerRef: { kind: "visit", id: "visit_wzz" }, order: 0 },
          // 越权：stop→day 容器（应被剥离）
          { subjectRef: { kind: "stop", id: "stop_rock" }, containerRef: { kind: "day", dayIndex: 2 }, order: 1 },
        ],
        reason: "混合 plan",
      },
      { op: "setDuration", subjectRef: { kind: "visit", id: "visit_market" }, minutes: 80, reason: "合法" },
    ]));
    assert.equal(result.type, "applied");
    // plan（剩余合法 assignment）+ setDuration = 2 applied
    assert.equal(result.result!.applied.length, 2);
    // 剥离项 1 条
    assert.equal(result.result!.rejected.length, 1);
    assert.match(result.result!.rejected[0].reason, /\[G1\].*内部玩法只能编入 visit 容器/);
    pass("Batch C 修复：plan stop→day 被剥离 + stop→visit 保留应用");
  }

  // ---- 全部 ops 都是 stop 越权 → rejected 型响应（不静默 no-op）----
  {
    const trip = await freshTrip(tripId);
    const result = await applyOperationSet(trip, opSet(trip.version, [
      { op: "setTime", subjectRef: { kind: "stop", id: "stop_rock" }, value: "09:00", target: "start", reason: "越权" },
      { op: "setPurchase", subjectRef: { kind: "stop", id: "stop_bridge" }, value: "toBuy", reason: "越权" },
      { op: "lock", subjectRef: { kind: "stop", id: "stop_beach" }, value: true, reason: "越权" },
    ]));
    assert.equal(result.type, "rejected");
    assert.match(result.message ?? "", /内部玩法越权/);
    assert.equal(result.result!.rejected.length, 3);
    assert.equal(result.result!.applied.length, 0);
    for (const rej of result.result!.rejected) {
      assert.match(rej.reason, /^\[G1\]/);
    }
    pass("全部 stop 越权：rejected 型响应附逐条理由（不静默 no-op）");
  }

  // =============== 真违规批（H/I/J/N/T/P）：仍拒绝，阈值语义未变 ===============

  // ---- Batch H：order 越界（move toOrder=99）→ 整批拒绝（1/1=100%>30%）----
  {
    const trip = await freshTrip(tripId);
    const result = await applyOperationSet(trip, opSet(trip.version, [
      { op: "move", subjectRef: { kind: "stop", id: "stop_rock" }, containerRef: { kind: "visit", id: "visit_wzz" }, toOrder: 99, reason: "越界" },
    ]));
    assert.equal(result.type, "rejected");
    assert.match(result.message ?? "", /30%/);
    assert.equal(result.result!.applied.length, 0);
    pass("Batch H 真违规：order 越界 → 整批拒绝");
  }

  // ---- Batch I：minutes 非法（负数）→ 整批拒绝 ----
  {
    const trip = await freshTrip(tripId);
    const result = await applyOperationSet(trip, opSet(trip.version, [
      { op: "setDuration", subjectRef: { kind: "visit", id: "visit_market" }, minutes: -10, reason: "非法值" },
    ]));
    assert.equal(result.type, "rejected");
    assert.match(result.message ?? "", /30%/);
    pass("Batch I 真违规：minutes 非法 → 整批拒绝");
  }

  // ---- Batch J：setTime 非法 value 格式 → 整批拒绝 ----
  {
    const trip = await freshTrip(tripId);
    const result = await applyOperationSet(trip, opSet(trip.version, [
      { op: "setTime", subjectRef: { kind: "visit", id: "visit_market" }, value: "9:00", target: "start", reason: "非法格式（单位数）" },
    ]));
    assert.equal(result.type, "rejected");
    assert.match(result.message ?? "", /30%/);
    pass("Batch J 真违规：setTime value 非法 → 整批拒绝");
  }

  // ---- Batch N：引用不存在实体 → 整批拒绝 ----
  {
    const trip = await freshTrip(tripId);
    const result = await applyOperationSet(trip, opSet(trip.version, [
      { op: "setDuration", subjectRef: { kind: "visit", id: "visit_ghost" }, minutes: 60, reason: "不存在" },
    ]));
    assert.equal(result.type, "rejected");
    assert.match(result.message ?? "", /30%/);
    pass("Batch N 真违规：引用不存在实体 → 整批拒绝");
  }

  // ---- Batch T：transfer stop→pendingPool（G3 红线）→ 拒绝（不剥离，安全语义不动）----
  {
    const trip = await freshTrip(tripId);
    const result = await applyOperationSet(trip, opSet(trip.version, [
      {
        op: "transfer",
        subjectRef: { kind: "stop", id: "stop_bridge" },
        fromContainerRef: { kind: "visit", id: "visit_wzz" },
        toContainerRef: { kind: "pendingPool" },
        toOrder: null,
        reason: "AI 试图移回待定区",
      },
    ]));
    // G3 拒绝（AI 不得代替用户做 pending 归类决定）→ 1/1=100%>30% 整批拒绝
    assert.equal(result.type, "rejected");
    assert.match(result.message ?? "", /30%/);
    // 理由中应包含 G3 相关信息
    const allReasons = result.result!.rejected.map((r) => r.reason).join(" ");
    assert.ok(
      allReasons.includes("G3") || allReasons.includes("threshold"),
      `应包含 G3 或 threshold 标注，实际：${allReasons}`,
    );
    pass("Batch T 真违规：transfer stop→pendingPool（G3 红线）→ 拒绝，不剥离");
  }

  // ---- Batch P：transfer visit 到不支持的容器 → 整批拒绝 ----
  {
    const trip = await freshTrip(tripId);
    const result = await applyOperationSet(trip, opSet(trip.version, [
      {
        op: "transfer",
        subjectRef: { kind: "visit", id: "visit_market" },
        fromContainerRef: { kind: "day", dayIndex: 3 },
        toContainerRef: { kind: "visit", id: "visit_wzz" },
        toOrder: null,
        reason: "非法：visit 只能转移到 day",
      },
    ]));
    assert.equal(result.type, "rejected");
    assert.match(result.message ?? "", /30%/);
    pass("Batch P 真违规：transfer visit→visit 容器 → 整批拒绝");
  }

  // ---- 混合真违规 + stop 越权：真违规仍计入 30% 分子，stop 越权不计入 ----
  {
    const trip = await freshTrip(tripId);
    // 3 条 stop setTime（剥离，不进分子分母）+ 2 条真违规 + 1 条合法 = 剩余 3 条中 2 条违规 = 66%>30%
    const result = await applyOperationSet(trip, opSet(trip.version, [
      { op: "setTime", subjectRef: { kind: "stop", id: "stop_rock" }, value: "09:00", target: "start", reason: "越权→剥离" },
      { op: "setTime", subjectRef: { kind: "stop", id: "stop_bridge" }, value: "10:00", target: "start", reason: "越权→剥离" },
      { op: "setTime", subjectRef: { kind: "stop", id: "stop_beach" }, value: "11:00", target: "start", reason: "越权→剥离" },
      { op: "setDuration", subjectRef: { kind: "visit", id: "visit_ghost" }, minutes: 60, reason: "真违规1" },
      { op: "move", subjectRef: { kind: "visit", id: "visit_ghost2" }, containerRef: { kind: "day", dayIndex: 2 }, toOrder: 0, reason: "真违规2" },
      { op: "setDuration", subjectRef: { kind: "visit", id: "visit_market" }, minutes: 100, reason: "合法" },
    ]));
    // 剩余 3 条（2 违规 + 1 合法）中 2/3=66%>30% → 整批拒绝
    assert.equal(result.type, "rejected");
    // rejected 应包含护栏拒绝的 + 剥离的
    assert.ok(result.result!.rejected.length >= 5, `至少 5 条 rejected（含剥离），实际 ${result.result!.rejected.length}`);
    pass("混合：stop 越权剥离不进分子 + 真违规仍触发 30% 整批拒绝");
  }

  // =============== 剥离幂等性 ===============

  // ---- 无 stop 越权 ops 时零影响 ----
  {
    const ops: Operation[] = [
      { op: "setDuration", subjectRef: { kind: "visit", id: "visit_market" }, minutes: 100, reason: "合法" },
      { op: "move", subjectRef: { kind: "stop", id: "stop_rock" }, containerRef: { kind: "visit", id: "visit_wzz" }, toOrder: 0, reason: "合法" },
      { op: "setDuration", subjectRef: { kind: "stop", id: "stop_bridge" }, minutes: 30, reason: "合法" },
    ];
    const { remaining, stripped } = stripUnsupportedStopOps(ops);
    assert.equal(remaining.length, 3);
    assert.equal(stripped.length, 0);
    // remaining 应与原数组内容相同
    assert.deepEqual(remaining, ops);
    pass("剥离幂等：无 stop 越权时零影响（remaining===原 ops）");
  }

  // ---- plan stop→visit 容器不被剥离 ----
  {
    const ops: Operation[] = [
      {
        op: "plan",
        scopeRef: { kind: "day", dayIndex: 2 },
        assignments: [
          { subjectRef: { kind: "stop", id: "stop_rock" }, containerRef: { kind: "visit", id: "visit_wzz" }, order: 0 },
          { subjectRef: { kind: "stop", id: "stop_bridge" }, containerRef: { kind: "visit", id: "visit_wzz" }, order: 1 },
        ],
        reason: "合法 plan",
      },
    ];
    const { remaining, stripped } = stripUnsupportedStopOps(ops);
    assert.equal(remaining.length, 1);
    assert.equal(stripped.length, 0);
    pass("剥离幂等：plan stop→visit 容器不剥离");
  }

  // ---- transfer stop→pendingPool 不被剥离（G3 红线保留进分子）----
  {
    const ops: Operation[] = [
      {
        op: "transfer",
        subjectRef: { kind: "stop", id: "stop_bridge" },
        fromContainerRef: { kind: "visit", id: "visit_wzz" },
        toContainerRef: { kind: "pendingPool" },
        toOrder: null,
        reason: "G3 红线",
      },
    ];
    const { remaining, stripped } = stripUnsupportedStopOps(ops);
    assert.equal(remaining.length, 1);
    assert.equal(stripped.length, 0);
    pass("剥离幂等：transfer stop→pendingPool 不剥离（G3 红线保留）");
  }

  // =============== DAY2 场景复现（PD 原始问题的精确复现） ===============

  // ---- DAY2 整批：3 条 stop setTime（小批量 3/3=100%>30%）→ 修复后全部剥离，rejected 响应 ----
  {
    const trip = await freshTrip(tripId);
    // 模拟 Gwen 重放：DAY2 批次全是 stop setTime（AI 误操作）
    const result = await applyOperationSet(trip, opSet(trip.version, [
      { op: "setTime", subjectRef: { kind: "stop", id: "stop_bridge" }, value: "09:00", target: "start", reason: "AI 误操作" },
      { op: "setTime", subjectRef: { kind: "stop", id: "stop_beach" }, value: "10:30", target: "start", reason: "AI 误操作" },
      { op: "setTime", subjectRef: { kind: "stop", id: "stop_rock" }, value: "14:00", target: "start", reason: "AI 误操作" },
    ]));
    // 修复前：3/3=100%>30% → 整批拒绝（合法操作陪葬）
    // 修复后：全部剥离，剩余 0 条 → rejected 响应附逐条理由
    assert.equal(result.type, "rejected");
    assert.equal(result.result!.rejected.length, 3);
    assert.equal(result.result!.applied.length, 0);
    for (const rej of result.result!.rejected) {
      assert.match(rej.reason, /\[G1\].*内部玩法不支持设置具体开始时间/);
    }
    pass("DAY2 精确复现：全 stop setTime → 剥离可见（不再静默整批拒绝丢失理由）");
  }

  // ---- DAY2 典型混合：stop 越权 + 合法调整 → 修复后合法部分自动落地 ----
  {
    const trip = await freshTrip(tripId);
    const result = await applyOperationSet(trip, opSet(trip.version, [
      // AI 想调整 Day2 蜈支洲岛内部玩法时间（越权）
      { op: "setTime", subjectRef: { kind: "stop", id: "stop_bridge" }, value: "09:00", target: "start", reason: "越权" },
      { op: "setTime", subjectRef: { kind: "stop", id: "stop_beach" }, value: "10:30", target: "start", reason: "越权" },
      { op: "setTime", subjectRef: { kind: "stop", id: "stop_rock" }, value: "14:00", target: "start", reason: "越权" },
      // 同时想调整时长和顺序（合法）
      { op: "setDuration", subjectRef: { kind: "stop", id: "stop_bridge" }, minutes: 30, reason: "缩短情人桥" },
      { op: "move", subjectRef: { kind: "stop", id: "stop_rock" }, containerRef: { kind: "visit", id: "visit_wzz" }, toOrder: 0, reason: "先去观日岩" },
    ]));
    // 修复前：3/5=60%>30% → 整批拒绝，合法操作陪葬
    // 修复后：3 条剥离（不进分子分母），剩余 2 条全合法 → applied
    assert.equal(result.type, "applied");
    assert.equal(result.result!.applied.length, 2);
    assert.equal(result.result!.rejected.length, 3);
    // 验证合法 ops 字段生效
    assert.equal(result.result!.trip.stops["stop_bridge"].suggestMinutes, 30);
    // stop_rock 应在 childStopRefs[0]
    assert.equal(result.result!.trip.visits["visit_wzz"].childStopRefs[0], "stop_rock");
    pass("DAY2 混合：stop 越权剥离 + 合法 setDuration/move 自动落地");
  }

  // =============== 清理 ===============
  console.log(`\n[verify-task316] 全部通过 ✓`);
  console.log(`临时行程文件：server/data/${tripId}.json（可手动清理）`);
}

main().catch((error) => {
  console.error("[verify-task316] 断言失败：", error);
  process.exitCode = 1;
});
