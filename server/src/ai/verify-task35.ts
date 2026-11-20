/**
 * Task #35 回归验证脚本（v1.1 父子 POI 模型，无模型依赖，最小覆盖）：
 *   1. baseVersion 乐观锁：模型输出基于旧版本时整批拒绝（v1.1 新增门槛）；
 *   2. 部分拒绝原因：护栏拒绝项以 `[guard] reason` 原样返回；
 *   3. 超过 30% 整批拒绝：整批不落地、行程文件逐字节不变；
 *   4. Stop 越权错误可见：内部玩法 setTime 被拒且原因可见（合法项照常应用）；
 *   5. 全量重排（scopeRef=allDays）先确认：返回 proposal.fullPlanOps，不直接应用；
 *   6. 确认后执行：/api/ai/intent/confirm 二次下发（带 baseVersion），重过护栏后落地；
 *      stale baseVersion → 409（v1.1 新增）；
 *   7. 可读映射抽样：describeRejection 覆盖 v1.1 常见冲突 + 兜底保留原文。
 *
 * 前置：服务端已在 8787 运行（确认端点走 HTTP 真实链路）。
 * 运行：npx tsx server/src/ai/verify-task35.ts
 * 说明：基于标准三亚验收行程（createFixtureSanyaTrip() 显式生成，实体 ID 固定；
 *       Task #66 后 tripStore.create 不再返回夹具，须显式调用 fixture 生成器），
 *       会在 server/data 创建临时行程文件，验证完打印其 tripId 供清理。
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { Operation, OperationSet } from "@goplay/shared";
import { BATCH_REJECTION_GUIDANCE, describeRejection } from "@goplay/shared";
import { tripStore, createFixtureSanyaTrip } from "../persistence/store.js";
import { applyOperationSet } from "./pipeline.js";

const CONFIRM_URL = "http://localhost:8787/api/ai/intent/confirm";

function tripFilePath(tripId: string): string {
  return path.join(import.meta.dirname, "../../data", `${tripId}.json`);
}

async function readTripFile(tripId: string): Promise<string> {
  return fs.readFile(tripFilePath(tripId), "utf8");
}

function opSet(tripVersion: number, operations: Operation[]): OperationSet {
  return { baseVersion: tripVersion, operations, unplaced: [], proposedNew: [], clarify: null };
}

function pass(name: string): void {
  console.log(`✓ ${name}`);
}

async function main(): Promise<void> {
  const created = await createFixtureSanyaTrip();
  const tripId = created.tripId;
  console.log(`[verify] 临时行程 ${tripId}（标准三亚验收结构，文件 server/data/${tripId}.json）`);

  // ---- 1. baseVersion 乐观锁：请求基于旧版本 → 整批拒绝（v1.1 新增）----
  {
    const trip = (await tripStore.load(tripId))!;
    const result = await applyOperationSet(
      trip,
      opSet(trip.version + 100, [
        { op: "setDuration", subjectRef: { kind: "visit", id: "visit_market" }, minutes: 150, reason: "合法调整" },
      ]),
    );
    assert.equal(result.type, "error");
    assert.match(result.message ?? "", /版本已更新/);
    assert.match(result.message ?? "", /v1/);
    pass(`baseVersion 不匹配整批拒绝：${result.message}`);
  }

  // ---- 2. 部分拒绝原因：3 条合法 + 1 条非法（25% ≤ 30%，不触发整批）----
  {
    const trip = (await tripStore.load(tripId))!;
    const result = await applyOperationSet(
      trip,
      opSet(trip.version, [
        { op: "setTime", subjectRef: { kind: "day", dayIndex: 3 }, value: "08:45", target: "dayDepart", reason: "提前出发" },
        { op: "setDuration", subjectRef: { kind: "visit", id: "visit_market" }, minutes: 150, reason: "延长第一市场时长" },
        { op: "setTime", subjectRef: { kind: "visit", id: "visit_market" }, value: "10:00", target: "start", reason: "覆写开始时间" },
        {
          op: "setDuration",
          subjectRef: { kind: "visit", id: "visit_ghost" },
          minutes: 10,
          reason: "调整一个不存在的到访",
        },
      ]),
    );
    assert.equal(result.type, "applied");
    const appliedResult = result.result!;
    assert.equal(appliedResult.applied.length, 3);
    assert.equal(appliedResult.rejected.length, 1);
    const rejected = appliedResult.rejected[0];
    assert.equal(rejected.op.op, "setDuration");
    assert.match(rejected.reason, /^\[G1\]/);
    assert.match(rejected.reason, /visit_ghost/);
    pass(`部分拒绝保留 guard+reason：${rejected.reason}`);
  }

  // ---- 3. 超过 30% 整批拒绝：2 合法 + 2 非法（50% > 30%），行程文件不变 ----
  {
    const trip = (await tripStore.load(tripId))!;
    const before = await readTripFile(tripId);
    const result = await applyOperationSet(
      trip,
      opSet(trip.version, [
        { op: "setDuration", subjectRef: { kind: "visit", id: "visit_market" }, minutes: 100, reason: "合法调整" },
        { op: "setTime", subjectRef: { kind: "day", dayIndex: 4 }, value: "08:15", target: "dayDepart", reason: "合法调整" },
        {
          op: "move",
          subjectRef: { kind: "visit", id: "visit_ghost_1" },
          containerRef: { kind: "day", dayIndex: 2 },
          toOrder: 0,
          reason: "非法目标",
        },
        {
          op: "remove",
          subjectRef: { kind: "point", id: "item_ghost_2" },
          fromContainerRef: { kind: "globalPool" },
          reason: "非法目标",
        },
      ]),
    );
    assert.equal(result.type, "rejected");
    // Task #379：整批拒绝 message 改为单点可操作引导常量（原因 + 动作建议，不提阈值）
    assert.equal(result.message, BATCH_REJECTION_GUIDANCE);
    const rejectedResult = result.result!;
    assert.equal(rejectedResult.applied.length, 0);
    assert.equal(rejectedResult.rejected.length, 4);
    assert.ok(rejectedResult.rejected.every((entry) => entry.reason.startsWith("[threshold]")));
    const after = await readTripFile(tripId);
    assert.equal(after, before);
    pass("超过 30% 整批拒绝：0 条落地，行程文件逐字节不变");
  }

  // ---- 4. Stop 越权错误可见：1 条 stop setTime（非法）+ 3 条合法（25%）----
  {
    const trip = (await tripStore.load(tripId))!;
    const result = await applyOperationSet(
      trip,
      opSet(trip.version, [
        { op: "move", subjectRef: { kind: "stop", id: "stop_rock" }, containerRef: { kind: "visit", id: "visit_wzz" }, toOrder: 0, reason: "先去观日岩" },
        { op: "move", subjectRef: { kind: "stop", id: "stop_beach" }, containerRef: { kind: "visit", id: "visit_wzz" }, toOrder: 1, reason: "海滨浴场第二" },
        { op: "setDuration", subjectRef: { kind: "stop", id: "stop_bridge" }, minutes: 50, reason: "情人桥缩短" },
        {
          op: "setTime",
          subjectRef: { kind: "stop", id: "stop_rock" },
          value: "10:00",
          target: "start",
          reason: "越权：内部玩法不显示开始时间",
        },
      ]),
    );
    assert.equal(result.type, "applied");
    const appliedResult = result.result!;
    assert.equal(appliedResult.applied.length, 3);
    assert.equal(appliedResult.rejected.length, 1);
    assert.match(appliedResult.rejected[0].reason, /内部玩法不支持设置具体开始时间/);
    // 拒绝原因对用户可读（describeRejection 有专属文案）
    assert.match(describeRejection(appliedResult.rejected[0].reason), /不显示具体开始时间/);
    // 合法的 Stop move 落地：childStopRefs 顺序与 order 字段一致
    const reloaded = (await tripStore.load(tripId))!;
    assert.deepEqual(reloaded.visits.visit_wzz.childStopRefs, ["stop_rock", "stop_beach", "stop_bridge"]);
    assert.equal(reloaded.stops.stop_rock.order, 0);
    assert.equal(reloaded.stops.stop_beach.order, 1);
    assert.equal(reloaded.stops.stop_bridge.order, 2);
    assert.equal(reloaded.stops.stop_bridge.suggestMinutes, 50);
    pass("Stop 越权可见：setTime 被拒且原因含「内部玩法不支持设置具体开始时间」，合法 move/setDuration 落地");
  }

  // ---- 5. 全量重排（scopeRef=allDays）先确认：proposal.fullPlanOps，不落盘 ----
  let fullPlanOps: Operation[] = [];
  let versionBeforeConfirm = 0;
  {
    const trip = (await tripStore.load(tripId))!;
    versionBeforeConfirm = trip.version;
    const before = await readTripFile(tripId);
    const plan: Operation = {
      op: "plan",
      scopeRef: { kind: "allDays" },
      assignments: [
        { subjectRef: { kind: "visit", id: "visit_wzz" }, containerRef: { kind: "day", dayIndex: 2 }, order: 0 },
        { subjectRef: { kind: "visit", id: "visit_market" }, containerRef: { kind: "day", dayIndex: 2 }, order: 1 },
      ],
      reason: "全程重排：第二天集中蜈支洲岛与第一市场",
    };
    const result = await applyOperationSet(trip, opSet(trip.version, [plan]));
    assert.equal(result.type, "proposal");
    fullPlanOps = result.fullPlanOps ?? [];
    assert.equal(fullPlanOps.length, 1);
    assert.equal(fullPlanOps[0].op, "plan");
    const heldResult = result.result!;
    assert.equal(heldResult.applied.length, 0);
    assert.equal(heldResult.needsProposal.length, 0);
    assert.equal(heldResult.rejected.length, 0);
    // 取消语义：前端取消时不调用确认端点 —— 行程文件在此阶段必须逐字节不变
    const after = await readTripFile(tripId);
    assert.equal(after, before);
    pass("全量重排 scopeRef=allDays：返回 proposal.fullPlanOps，未直接应用；取消行程文件不变");
  }

  // ---- 6. 确认后执行：走真实确认端点（带 baseVersion；重过四条护栏；stale → 409）----
  {
    // 6a. 正常确认：plan 落地，第一市场被移到 Day2
    const response = await fetch(CONFIRM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tripId, operations: fullPlanOps, baseVersion: versionBeforeConfirm }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      type: string;
      result?: { applied: unknown[]; rejected: unknown[] };
    };
    assert.equal(body.type, "applied");
    assert.equal(body.result?.applied.length, 1);
    assert.equal(body.result?.rejected.length, 0);
    const reloaded = (await tripStore.load(tripId))!;
    assert.deepEqual(reloaded.days.day_2.scheduleVisitRefs, ["visit_wzz", "visit_market"]);
    assert.deepEqual(reloaded.days.day_3.scheduleVisitRefs, []);
    assert.equal(reloaded.visits.visit_market.dayRef, "day_2");
    pass("确认后执行：经 /intent/confirm（带 baseVersion）落地，visit_market 移入 Day2");

    // 6b. stale baseVersion → 409 版本冲突
    const staleResp = await fetch(CONFIRM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tripId, operations: fullPlanOps, baseVersion: versionBeforeConfirm }),
    });
    assert.equal(staleResp.status, 409);
    const staleBody = (await staleResp.json()) as { type: string; message?: string };
    assert.equal(staleBody.type, "error");
    assert.match(staleBody.message ?? "", /版本已更新/);
    pass("stale baseVersion：confirm 返回 409 与可读版本冲突文案");

    // 6c. 确认端点仍过四条护栏：混入 1 条非法（引用不存在的 visit），
    // 另配 3 条合法（1/4=25% 不触发 30% 整批阈值，非法项被逐条拦截可见）
    const guardResp = await fetch(CONFIRM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tripId,
        operations: [
          { op: "setDuration", subjectRef: { kind: "visit", id: "visit_wzz" }, minutes: 210, reason: "岛内延长" },
          { op: "setDuration", subjectRef: { kind: "visit", id: "visit_market" }, minutes: 130, reason: "市场延长" },
          {
            op: "setTime",
            subjectRef: { kind: "visit", id: "visit_market" },
            value: "10:15",
            target: "start",
            reason: "错峰逛市场",
          },
          {
            op: "setDuration",
            subjectRef: { kind: "visit", id: "visit_ghost_3" },
            minutes: 10,
            reason: "非法目标",
          },
        ],
      }),
    });
    assert.equal(guardResp.status, 200);
    const guardBody = (await guardResp.json()) as {
      type: string;
      result?: { applied: unknown[]; rejected: { reason: string }[] };
    };
    assert.equal(guardBody.type, "applied");
    assert.equal(guardBody.result?.applied.length, 3, "3 条合法操作应正常落地");
    assert.equal(guardBody.result?.rejected.length, 1);
    assert.match(guardBody.result!.rejected[0].reason, /^\[G1\]/);
    const guardReloaded = (await tripStore.load(tripId))!;
    assert.equal((guardReloaded.visits.visit_wzz as { reservedMinutes?: number }).reservedMinutes, 210, "setDuration 应落到 visit_wzz（reservedMinutes）");
    pass("确认端点重过四条护栏：非法目标被拦并保留 [G1] 原因，合法 3 条不受牵连");
  }

  // ---- 7. 可读映射抽样：v1.1 常见冲突 + 兜底保留原文 ----
  {
    assert.match(describeRejection("[G3] locked 项不可操作"), /已锁定/);
    assert.match(describeRejection("[G3] 已购买项不可移除/转移"), /已购票/);
    assert.match(describeRejection("[G1] setTime：stop_bridge 内部玩法不支持设置具体开始时间"), /不显示具体开始时间/);
    assert.match(describeRejection("[G1] transfer：stop_snack 待定加入不能自动挂入"), /待定加入的内部玩法须先由你确认归类/);
    assert.match(describeRejection("[G1] remove：visit_ghost 不在行程中"), /不存在或不合法的目标/);
    assert.match(describeRejection("[G1] toOrder 超出容器范围"), /不存在或不合法的目标/);
    // Task #379：整批拒绝映射为可操作引导单点常量（原因一句 + 动作一句，不提阈值）
    assert.equal(describeRejection("[threshold] 违规率超过30%，整批拒绝"), BATCH_REJECTION_GUIDANCE);
    assert.equal(describeRejection("[G1] 边界外置的未识别原因"), "[G1] 边界外置的未识别原因");
    assert.equal(describeRejection("执行器未识别的拒绝原因"), "执行器未识别的拒绝原因");
    pass("可读映射：v1.1 常见冲突（锁定/已购/Stop 越权/待定加入/非法目标/阈值）+ 兜底保留原文");
  }

  console.log(`\n[verify] Task #35 全部通过 ✓（临时行程 server/data/${tripId}.json）`);
}

main().catch((error) => {
  console.error("[verify] 失败：", error);
  process.exitCode = 1;
});
