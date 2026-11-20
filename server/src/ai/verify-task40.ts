/**
 * Task #40 回归验证（v1.1 夹具驱动，无模型调用）：
 *   1. 夹具解析分类：full-replan-1（5 条单日 plan 覆盖多天）与 full-replan-2
 *      （fence + 中文全量 scopeRef + 字符串数值变体）可解析且命中全量重排判定；
 *      full-replan-3（括号交错损坏）整体解析为 null（保守修复不重建碎片）；
 *      full-replan-4（EOF 字符串截断）经保守修复解析成功；single-day-replan 为 clarify；
 *      stop-reorder 为 Stop 级 move（内部玩法改序，非敏感直接应用）；
 *   2. 归一化契约：scopeRef 全量词 / 数字 / 字符串 / 对象形状无损归一化；
 *      EntityRef/ContainerRef/toOrder/minutes 数字字符串无损转换；
 *      allDays / 单条跨天 / 多条单日合计覆盖多天 均命中全量；单日 plan 不误判；
 *   3. 端到端挂起：全量夹具 → proposal.fullPlanOps，不落盘（行程文件逐字节不变）；
 *   4. 普通单日 plan 直接应用：globalPool point 进入 Day 创建 ordinary Visit；
 *   5. 敏感操作提案不变；全量批混入 remove 双通道并存；
 *   6. Stop 级 move 端到端：stop-reorder 落地改序（childStopRefs 与 order 一致）；
 *   7. HTTP 确认链路（8787）：baseVersion 正常落地 + stale baseVersion 409 +
 *      二次护栏（[G1] 保留）+ Stop 级 move 经 confirm 落地。
 *
 * 夹具来源：server/src/ai/fixtures/v11/（v1.1 合成基线，可由 capture-v11.ts 覆写）。
 * 前置：服务端已在 8787 运行（确认端点走 HTTP 真实链路）。
 * 运行：npx tsx server/src/ai/verify-task40.ts
 * 说明：基于标准三亚验收行程（createFixtureSanyaTrip() 显式生成，实体 ID 固定；
 *       Task #66 后 tripStore.create 不再返回夹具，须显式调用 fixture 生成器），
 *       会在 server/data 创建临时行程文件，验证完打印其 tripId 供清理。
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { Operation, OperationSet } from "@goplay/shared";
import { tripStore, createFixtureSanyaTrip } from "../persistence/store.js";
import { applyOperationSet, parseOperationSet } from "./pipeline.js";
import { isFullPlanBatch, normalizePlanFields, normalizeScopeRef } from "./planScope.js";

const FIXTURE_DIR = path.join(import.meta.dirname, "fixtures", "v11");
const CONFIRM_URL = "http://localhost:8787/api/ai/intent/confirm";

/** 本脚本创建的临时行程（结尾打印供清理） */
const createdTripIds: string[] = [];

function tripFilePath(tripId: string): string {
  return path.join(import.meta.dirname, "../../data", `${tripId}.json`);
}

async function readTripFile(tripId: string): Promise<string> {
  return fs.readFile(tripFilePath(tripId), "utf8");
}

async function loadFinalText(file: string): Promise<string> {
  return fs.readFile(path.join(FIXTURE_DIR, file), "utf8");
}

/** 新建标准验收行程（实体 ID 固定：item_wzz / visit_wzz / stop_rock 等，初始 version=1） */
async function freshTrip(): Promise<{ tripId: string; version: number }> {
  const created = await createFixtureSanyaTrip();
  createdTripIds.push(created.tripId);
  return { tripId: created.tripId, version: created.version };
}

function opSet(tripVersion: number, operations: Operation[]): OperationSet {
  return { baseVersion: tripVersion, operations, unplaced: [], proposedNew: [], clarify: null };
}

/** 构造规范形状的 plan 操作（回归内部使用） */
function planOp(
  scopeRef: { kind: "allDays" } | { kind: "day"; dayIndex: number },
  assignments: Array<{ subjectRef: Operation extends never ? never : Record<string, unknown>; containerRef: Record<string, unknown>; order: number }>,
): Operation {
  return { op: "plan", scopeRef, assignments, reason: "回归测试" } as unknown as Operation;
}

function pass(name: string): void {
  console.log(`✓ ${name}`);
}

async function main(): Promise<void> {
  // ---- 1. 夹具解析分类（模型输出形状 → OperationSet）----
  const replan1Ops: Operation[] = [];
  {
    // full-replan-1：5 条单日 plan（scopeRef=day），assignments 合计覆盖 day_2/day_3
    const set1 = parseOperationSet(await loadFinalText("full-replan-1.txt"));
    assert.ok(set1 !== null, "full-replan-1 应可解析");
    assert.equal(set1.baseVersion, 1, "full-replan-1 应回显 baseVersion=1");
    assert.equal(set1.clarify, null);
    assert.equal(set1.operations.length, 5);
    assert.ok(
      set1.operations.every((op) => op.op === "plan"),
      "full-replan-1 应为 5 条 plan",
    );
    assert.ok(isFullPlanBatch(set1.operations), "full-replan-1（多日合计覆盖）应命中全量重排判定");
    replan1Ops.push(...set1.operations);

    // full-replan-2：fence 包裹 + 中文全量 scopeRef + 字符串数值变体
    const set2 = parseOperationSet(await loadFinalText("full-replan-2.txt"));
    assert.ok(set2 !== null, "full-replan-2（fence 包裹）应可解析");
    assert.equal(set2.baseVersion, 1, "字符串 baseVersion 应无损归一化为 1");
    const plan2 = set2.operations.find((op) => op.op === "plan");
    assert.ok(plan2 !== undefined && plan2.op === "plan");
    assert.deepEqual(plan2.scopeRef, { kind: "allDays" }, "裸值「全部」scopeRef 应归一化为 allDays");
    assert.ok(isFullPlanBatch(set2.operations), "full-replan-2 应命中全量重排判定");

    // full-replan-3：括号交错损坏 → 整体解析为 null（不猜测碎片归属）
    assert.equal(parseOperationSet(await loadFinalText("full-replan-3.txt")), null, "full-replan-3 损坏 JSON 应解析为 null");

    // full-replan-4：EOF 字符串截断 → 保守修复补引号后解析成功
    const set4 = parseOperationSet(await loadFinalText("full-replan-4.txt"));
    assert.ok(set4 !== null, "full-replan-4（干净截断）应经保守修复解析成功");
    assert.equal(set4.operations.length, 1);
    assert.equal(set4.operations[0].op, "setDuration");
    assert.match((set4.operations[0] as { reason: string }).reason, /^海滨浴场/, "字符串内容应原样保留");

    // single-day-replan：对照 → clarify 反问（不执行任何操作）
    const single = parseOperationSet(await loadFinalText("single-day-replan.txt"));
    assert.ok(single !== null, "single-day-replan 应可解析");
    assert.equal(single.operations.length, 0);
    assert.ok(single.clarify !== null && single.clarify.length > 0, "single-day 应为 clarify 反问");

    // stop-reorder：Stop 级 move（visit 容器内改序）
    const stopMove = parseOperationSet(await loadFinalText("stop-reorder.txt"));
    assert.ok(stopMove !== null, "stop-reorder 应可解析");
    assert.equal(stopMove.operations.length, 1);
    assert.equal(stopMove.operations[0].op, "move");
    assert.ok(!isFullPlanBatch(stopMove.operations), "stop-reorder 不应误判为全量重排");

    pass("夹具分类：1/2 可解析且命中全量判定；3 损坏解析为 null；4 截断修复成功；single-day 为 clarify；stop-reorder 为 Stop 级 move");
  }

  // ---- 2. 归一化契约（模型变体 → 无损归一化 → 全量判定）----
  {
    assert.deepEqual(normalizeScopeRef({ kind: "allDays" }), { kind: "allDays" });
    assert.deepEqual(normalizeScopeRef("all"), { kind: "allDays" });
    assert.deepEqual(normalizeScopeRef("ALL"), { kind: "allDays" });
    assert.deepEqual(normalizeScopeRef(" 全部 "), { kind: "allDays" });
    assert.deepEqual(normalizeScopeRef("整个行程"), { kind: "allDays" });
    assert.deepEqual(normalizeScopeRef({ kind: "day", dayIndex: "2" }), { kind: "day", dayIndex: 2 });
    assert.deepEqual(normalizeScopeRef(2), { kind: "day", dayIndex: 2 });
    assert.deepEqual(normalizeScopeRef("2"), { kind: "day", dayIndex: 2 });
    assert.deepEqual(normalizeScopeRef("day2"), { kind: "day", dayIndex: 2 });
    assert.deepEqual(normalizeScopeRef("Day 3"), { kind: "day", dayIndex: 3 });
    assert.deepEqual(normalizeScopeRef("第2天"), { kind: "day", dayIndex: 2 });
    assert.equal(normalizeScopeRef("下周"), null);
    assert.equal(normalizeScopeRef("2天"), null);
    assert.equal(normalizeScopeRef(2.5), null);
    assert.equal(normalizeScopeRef(null), null);

    // plan 字段归一化：scopeRef 裸值 / 字符串数值 → 无损转换
    const normalized = normalizePlanFields({
      op: "plan",
      scopeRef: "第2天",
      assignments: [
        {
          subjectRef: { kind: "visit", id: "visit_market" },
          containerRef: { kind: "day", dayIndex: "2" },
          order: "1",
        },
      ],
      reason: "字符串变体",
    }) as Extract<Operation, { op: "plan" }>;
    assert.deepEqual(normalized.scopeRef, { kind: "day", dayIndex: 2 });
    assert.deepEqual(normalized.assignments[0], {
      subjectRef: { kind: "visit", id: "visit_market" },
      containerRef: { kind: "day", dayIndex: 2 },
      order: 1,
    });

    // 非 plan op：subjectRef 内 dayIndex / toOrder / minutes 数字字符串归一化
    const normalizedLock = normalizePlanFields({
      op: "lock",
      subjectRef: { kind: "lodging", dayIndex: "2" },
      value: true,
      reason: "锁酒店",
    }) as Extract<Operation, { op: "lock" }>;
    assert.deepEqual(normalizedLock.subjectRef, { kind: "lodging", dayIndex: 2 });
    const normalizedMove = normalizePlanFields({
      op: "move",
      subjectRef: { kind: "stop", id: "stop_rock" },
      containerRef: { kind: "visit", id: "visit_wzz" },
      toOrder: "0",
      reason: "改序",
    }) as Extract<Operation, { op: "move" }>;
    assert.equal(normalizedMove.toOrder, 0);

    // 批级判定：单日不误判；跨天 / 多日合计 / allDays 命中
    assert.equal(
      isFullPlanBatch([
        planOp({ kind: "day", dayIndex: 2 }, [
          { subjectRef: { kind: "visit", id: "visit_wzz" }, containerRef: { kind: "day", dayIndex: 2 }, order: 0 },
        ]),
      ]),
      false,
      "单日 plan 不得误判为全量",
    );
    assert.equal(
      isFullPlanBatch([
        planOp({ kind: "day", dayIndex: 2 }, [
          { subjectRef: { kind: "visit", id: "visit_wzz" }, containerRef: { kind: "day", dayIndex: 2 }, order: 0 },
          { subjectRef: { kind: "visit", id: "visit_market" }, containerRef: { kind: "day", dayIndex: 3 }, order: 0 },
        ]),
      ]),
      true,
      "单条跨天 assignments 应命中全量",
    );
    assert.equal(
      isFullPlanBatch([
        planOp({ kind: "day", dayIndex: 1 }, [
          { subjectRef: { kind: "visit", id: "visit_market" }, containerRef: { kind: "day", dayIndex: 3 }, order: 0 },
        ]),
        planOp({ kind: "day", dayIndex: 2 }, [
          { subjectRef: { kind: "visit", id: "visit_wzz" }, containerRef: { kind: "day", dayIndex: 2 }, order: 0 },
        ]),
      ]),
      true,
      "多条单日合计覆盖多天应命中全量",
    );
    assert.equal(isFullPlanBatch([planOp({ kind: "allDays" }, [])]), true, "allDays 应命中全量");
    assert.equal(
      isFullPlanBatch([
        { op: "setTime", subjectRef: { kind: "day", dayIndex: 2 }, value: "09:00", target: "dayDepart", reason: "调整" },
      ]),
      false,
    );

    pass("归一化契约：scopeRef 对象/裸值/中英文全量词与字符串数值无损归一；全量判定覆盖 allDays / 跨天 / 多日合计；单日不误判");
  }

  // ---- 3. 端到端挂起：全量夹具 → proposal.fullPlanOps，不落盘 ----
  {
    const { tripId, version } = await freshTrip();
    const trip = (await tripStore.load(tripId))!;
    const before = await readTripFile(tripId);
    const result = await applyOperationSet(trip, opSet(version, replan1Ops));
    assert.equal(result.type, "proposal");
    assert.equal(result.fullPlanOps?.length, 5, "full-replan-1 五条 plan 应全部挂起");
    assert.equal(result.result?.applied.length, 0);
    assert.equal(result.result?.rejected.length, 0, "护栏对合法全量输出零拒绝");
    assert.equal(await readTripFile(tripId), before, "挂起阶段不得落盘");
    pass("全量夹具端到端：proposal.fullPlanOps=5、护栏零拒绝、行程文件逐字节不变");
  }

  // ---- 4. 普通单日 plan 直接应用：globalPool point 进入 Day 创建 ordinary Visit ----
  {
    const { tripId, version } = await freshTrip();
    const trip = (await tripStore.load(tripId))!;
    const singleDay = planOp({ kind: "day", dayIndex: 3 }, [
      { subjectRef: { kind: "point", id: "item_daxiaodongtian" }, containerRef: { kind: "day", dayIndex: 3 }, order: 0 },
      { subjectRef: { kind: "visit", id: "visit_market" }, containerRef: { kind: "day", dayIndex: 3 }, order: 1 },
    ]);
    const result = await applyOperationSet(trip, opSet(version, [singleDay]));
    assert.equal(result.type, "applied", "单日 plan 应直接应用");
    const reloaded = (await tripStore.load(tripId))!;
    const day3Refs = reloaded.days.day_3.scheduleVisitRefs;
    assert.equal(day3Refs.length, 2);
    assert.equal(day3Refs[1], "visit_market");
    const newVisit = reloaded.visits[day3Refs[0]];
    assert.ok(newVisit !== undefined, "大小洞天应创建新 Visit");
    assert.equal(newVisit.pointRef, "item_daxiaodongtian");
    assert.equal(newVisit.kind, "ordinary", "globalPool point 进入 Day 应创建 ordinary Visit");
    assert.ok(!reloaded.globalCandidateRefs.some((ref) => ref.kind === "point" && ref.id === "item_daxiaodongtian"), "候选区引用应被取出");
    pass("普通单日 plan（scopeRef=day）直接应用：候选区 point 创建 ordinary Visit 并顺延第一市场");
  }

  // ---- 5. 敏感操作提案不变；全量批混入 remove 双通道并存 ----
  {
    const { tripId, version } = await freshTrip();
    const trip = (await tripStore.load(tripId))!;
    const before = await readTripFile(tripId);
    const result = await applyOperationSet(
      trip,
      opSet(version, [
        {
          op: "remove",
          subjectRef: { kind: "visit", id: "visit_market" },
          fromContainerRef: { kind: "day", dayIndex: 3 },
          reason: "移除第一市场",
        },
        { op: "setPurchase", subjectRef: { kind: "visit", id: "visit_wzz" }, value: "toBuy", reason: "标记待购" },
        { op: "lock", subjectRef: { kind: "visit", id: "visit_wzz" }, value: true, reason: "锁定蜈支洲岛" },
      ]),
    );
    assert.equal(result.type, "proposal");
    assert.equal(result.proposalOps?.length, 3);
    assert.equal(result.fullPlanOps, undefined);
    assert.equal(await readTripFile(tripId), before);
    pass("remove / setPurchase / lock：提案行为不变（proposalOps=3，fullPlanOps 为空），文件不变");

    const { tripId: tripId2, version: version2 } = await freshTrip();
    const trip2 = (await tripStore.load(tripId2))!;
    const before2 = await readTripFile(tripId2);
    const result2 = await applyOperationSet(
      trip2,
      opSet(version2, [
        ...replan1Ops,
        {
          op: "remove",
          subjectRef: { kind: "visit", id: "visit_market" },
          fromContainerRef: { kind: "day", dayIndex: 3 },
          reason: "移除海滨浴场",
        },
      ]),
    );
    assert.equal(result2.type, "proposal");
    assert.equal(result2.fullPlanOps?.length, 5);
    assert.equal(result2.proposalOps?.length, 1);
    assert.equal(result2.proposalOps?.[0].op, "remove");
    assert.equal(await readTripFile(tripId2), before2);
    pass("全量批混入 remove：fullPlanOps=5 挂起 + proposalOps=1 提案，未落盘");
  }

  // ---- 6. Stop 级 move 端到端：stop-reorder 落地改序 ----
  {
    const { tripId, version } = await freshTrip();
    const trip = (await tripStore.load(tripId))!;
    const stopMove = parseOperationSet(await loadFinalText("stop-reorder.txt"));
    assert.ok(stopMove !== null);
    const result = await applyOperationSet(trip, opSet(version, stopMove.operations));
    assert.equal(result.type, "applied", "Stop 级 move 为非敏感单容器操作，应直接应用");
    const reloaded = (await tripStore.load(tripId))!;
    assert.deepEqual(reloaded.visits.visit_wzz.childStopRefs, ["stop_rock", "stop_bridge", "stop_beach"]);
    assert.equal(reloaded.stops.stop_rock.order, 0);
    assert.equal(reloaded.stops.stop_bridge.order, 1);
    assert.equal(reloaded.stops.stop_beach.order, 2);
    pass("Stop 级 move 端到端：观日岩挪到岛内第一，childStopRefs 与 order 一致");
  }

  // ---- 7. HTTP 确认链路（8787 真实端点：落地 / 409 / 二次护栏 / Stop move）----
  {
    // 7a. 确认 full-replan-1 → day3 前插大小洞天（point 创建 Visit），五天 plan 落地
    const { tripId, version } = await freshTrip();
    const response = await fetch(CONFIRM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tripId, operations: replan1Ops, baseVersion: version }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      type: string;
      result?: { applied: unknown[]; rejected: unknown[] };
    };
    assert.equal(body.type, "applied");
    assert.equal(body.result?.applied.length, 5);
    assert.equal(body.result?.rejected.length, 0);
    const reloaded = (await tripStore.load(tripId))!;
    assert.deepEqual(reloaded.days.day_2.scheduleVisitRefs, ["visit_wzz"]);
    assert.equal(reloaded.days.day_3.scheduleVisitRefs.length, 2);
    assert.equal(reloaded.days.day_3.scheduleVisitRefs[1], "visit_market");
    assert.equal(reloaded.visits[reloaded.days.day_3.scheduleVisitRefs[0]].pointRef, "item_daxiaodongtian");
    pass("HTTP confirm：full-replan-1 落地，大小洞天创建 Visit 插入 Day3、第一市场顺延");

    // 7b. stale baseVersion → 409（version 已因 7a 落地自增）
    const staleResp = await fetch(CONFIRM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tripId, operations: replan1Ops, baseVersion: version }),
    });
    assert.equal(staleResp.status, 409, "重复确认（stale baseVersion）应 409");
    pass("HTTP confirm stale baseVersion：返回 409 版本冲突");

    // 7c. confirm 重过四条护栏：混入 1 条非法（引用不存在的 visit），
    // 另配 3 条合法（1/4=25% 不触发 30% 整批阈值，非法项被逐条拦截可见）
    const guardResp = await fetch(CONFIRM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tripId,
        operations: [
          { op: "setDuration", subjectRef: { kind: "visit", id: "visit_wzz" }, minutes: 200, reason: "岛内延长" },
          { op: "setDuration", subjectRef: { kind: "visit", id: "visit_market" }, minutes: 140, reason: "市场延长" },
          {
            op: "setTime",
            subjectRef: { kind: "visit", id: "visit_market" },
            value: "09:30",
            target: "start",
            reason: "错峰逛市场",
          },
          {
            op: "setDuration",
            subjectRef: { kind: "visit", id: "visit_ghost_http" },
            minutes: 30,
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
    pass("HTTP confirm 二次护栏：非法 op 被拦并保留 [G1]，合法 3 条不受牵连");

    // 7d. stop-reorder 经 confirm 正常落地
    const { tripId: tripId2, version: version2 } = await freshTrip();
    const stopMove = parseOperationSet(await loadFinalText("stop-reorder.txt"));
    assert.ok(stopMove !== null);
    const stopResp = await fetch(CONFIRM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tripId: tripId2, operations: stopMove.operations, baseVersion: version2 }),
    });
    assert.equal(stopResp.status, 200);
    const stopBody = (await stopResp.json()) as { type: string; result?: { applied: unknown[] } };
    assert.equal(stopBody.type, "applied");
    assert.equal(stopBody.result?.applied.length, 1);
    pass("HTTP confirm：stop-reorder 落地（Stop 级 move 经确认通道正常应用）");
  }

  console.log(`\n[verify] Task #40 全部通过 ✓`);
  console.log(`[verify] 临时行程（可清理 server/data/<tripId>.json）：`);
  for (const tripId of createdTripIds) console.log(`  - ${tripId}`);
}

main().catch((error) => {
  console.error("[verify] 失败：", error);
  process.exitCode = 1;
});
