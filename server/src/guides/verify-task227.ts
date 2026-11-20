/**
 * Task #227：callAndParsePlanner 共享总预算验证（全程离线，虚拟时钟，不触网）。
 *
 * 缺陷背景：此前每次重试都给百炼分配完整的 GUIDE_DRAFT_TIMEOUT_MS（300s），首次 75s
 * 返回但解析失败触发重试时，总耗时可达 75+300=375s，超过前端 315s 兜底超时。
 *
 * 验证点（通过 guideRoutes + planner 桩 + 虚拟 Date.now 精确驱动，无真实等待）：
 *   1. 第 1 次尝试拿满 300s；解析失败后第 2 次只拿「剩余预算」（300s-75s=225s），
 *      总耗时 85s 成功返回；
 *   2. 两次都解析失败但预算够用：两次各 75s，最终 AI_PARSE_FAILED，总耗时 150s；
 *      解析失败日志含 finalText 前 200 字符摘要（截断不外溢）；
 *   3. 第 2 次尝试耗尽剩余预算：单次超时 = 225s，本轮总耗时恰好封顶 300s，
 *      错误消息报告「本轮已等待 300 秒、总预算 300 秒，共尝试 2 次」；
 *   4. 第 1 次已耗 280s：剩余 20s < 最低重试阈值 30s，不再发起第 2 次调用
 *      （planner 调用次数 = 1），立即按超时报错；
 *   5. 百炼自身超时（BailianTimeoutError）一次即抛出，不重试；
 * 全局不变量：每次调用 timeoutMs ∈ (0, 300s]、实际消耗 ≤ 该次 timeoutMs，
 * 且每轮总耗时 ≤ 300s（始终早于前端 315s）。
 *
 * 运行：npx tsx server/src/guides/verify-task227.ts
 * 临时行程（server/data）在脚本末尾清理，不影响用户既有数据。
 */

import "../env.js";
import assert from "node:assert/strict";
import type { GuideSource, SourceEvidence, Trip } from "@goplay/shared";
import { createEmptyGuideImageProgress } from "@goplay/shared";
import { BailianTimeoutError } from "../bailian/client.js";
import { createFixtureSanyaTrip, tripStore } from "../persistence/store.js";
import { resetGuidePlannerDeps, setGuidePlannerDeps } from "./planner.js";
import { guideRoutes } from "./routes.js";

const BUDGET_MS = 300_000;
const MIN_RETRY_MS = 30_000;
/** 无解析价值的模型输出（远超 200 字，用于验证日志截断） */
const GARBAGE = `这不是 JSON：${"甲".repeat(400)}`;
/** 合法空草案（解析成功、0 操作 0 提示） */
const EMPTY_DRAFT_JSON = JSON.stringify({ operations: [], snippets: [] });

function pass(name: string): void {
  console.log(`✓ ${name}`);
}

// ===== 虚拟时钟（只替换 Date.now；new Date() 与定时器仍走真实时间） =====

const realDateNow = Date.now;
let virtualNow = realDateNow();
Date.now = () => virtualNow;

// ===== planner 桩（按脚本登记的单次消耗时间推进虚拟时钟） =====

interface PlannedCall {
  /** 本次调用消耗的时间（虚拟毫秒）；超过分到的 timeoutMs 时按真实行为先撞超时 */
  elapsedMs: number;
  /** 返回的 finalText；缺省表示该次调用以超时收场 */
  finalText?: string;
}

interface CallRecord {
  timeoutMs: number;
  consumedMs: number;
  timedOut: boolean;
}

let plan: PlannedCall[] = [];
let calls: CallRecord[] = [];

setGuidePlannerDeps({
  callPlanner: async (_prompt: string, timeoutMs: number) => {
    const step = plan.shift();
    if (step === undefined) throw new Error("桩计划已耗尽（测试准备失误）");
    const timedOut = step.elapsedMs > timeoutMs;
    const consumedMs = timedOut ? timeoutMs : step.elapsedMs;
    virtualNow += consumedMs;
    calls.push({ timeoutMs, consumedMs, timedOut });
    if (timedOut || step.finalText === undefined) throw new BailianTimeoutError(timeoutMs);
    return step.finalText;
  },
});

/** 解析失败日志捕获（同时保留原始输出，便于人工排查） */
const capturedErrors: string[] = [];
const realConsoleError = console.error;
console.error = (...args: unknown[]) => {
  capturedErrors.push(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
  realConsoleError(...args);
};

// ===== 夹具：一条可用来源（提及对齐 fixture 的「蜈支洲岛」visit_wzz） =====

function seedUsableSource(trip: Trip): void {
  const mention: SourceEvidence["mentions"][number] = {
    mentionId: "m1",
    text: "蜈支洲岛",
    quoteText: "蜈支洲岛：建议早8点前登岛避开人流。",
    bbox: null,
    extractedName: "蜈支洲岛",
    locationHint: null,
    modelSummary: "【桩】早8点前登岛避开人流",
    claimKind: "tip",
    targetScope: "place",
    firsthand: true,
    relationEvidence: null,
  };
  trip.evidences["ev_227"] = {
    evidenceId: "ev_227",
    kind: "note_text",
    noteIndex: 1,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions: [mention],
  };
  const source: GuideSource = {
    sourceId: "src_227",
    sourceVersion: 1,
    inputKind: "text",
    title: "Task #227 预算验证来源",
    active: true,
    status: "ready",
    evidenceRefs: ["ev_227"],
    mentionRefs: ["ev_227:m1"],
    imageProgress: createEmptyGuideImageProgress(),
    importedAt: "2026-10-23T08:00:00.000Z",
    updatedAt: "2026-10-23T08:00:00.000Z",
  };
  trip.guideSources = { ...(trip.guideSources ?? {}), src_227: source };
}

async function postDraft(tripId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await guideRoutes.request(`/trips/${tripId}/draft`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // 缺省 sourceMode="all"：不满足 snippet-only 快速路径条件，必然走 planner
    body: JSON.stringify({}),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** 每轮场景的统一校验：调用预算单调收紧、单次消耗不越界、总耗时封顶 300s */
function assertBudgetInvariant(totalElapsedMs: number): void {
  for (const call of calls) {
    assert.ok(call.timeoutMs > 0, `单次 timeoutMs 必须为正（实际 ${call.timeoutMs}）`);
    assert.ok(call.timeoutMs <= BUDGET_MS, `单次 timeoutMs 不得超过总预算（实际 ${call.timeoutMs}）`);
    assert.ok(call.consumedMs <= call.timeoutMs, "单次消耗不得超过该次分到的预算");
  }
  assert.ok(
    totalElapsedMs <= BUDGET_MS,
    `本轮总耗时必须封顶 300s（实际 ${totalElapsedMs}ms），必须早于前端 315s 兜底超时`,
  );
}

async function main(): Promise<void> {
  const trip = await createFixtureSanyaTrip();
  try {
    seedUsableSource(trip);
    await tripStore.save(trip);
    const tripId = trip.tripId;

    // ---------- 场景 1：首次 75s 解析失败 → 重试只分到剩余 225s ----------
    {
      calls = [];
      plan = [
        { elapsedMs: 75_000, finalText: GARBAGE },
        { elapsedMs: 10_000, finalText: EMPTY_DRAFT_JSON },
      ];
      capturedErrors.length = 0;
      const startedAt = virtualNow;
      const res = await postDraft(tripId);
      assert.equal(res.status, 200, `解析成功应 200（实际 ${res.status}：${JSON.stringify(res.body)}）`);
      assert.equal(calls.length, 2, "解析失败应重试一次");
      assert.equal(calls[0]!.timeoutMs, BUDGET_MS, "第 1 次尝试应拿满 300s");
      assert.equal(calls[1]!.timeoutMs, BUDGET_MS - 75_000, "第 2 次尝试只应拿剩余 225s");
      assertBudgetInvariant(virtualNow - startedAt);
      const parseLog = capturedErrors.find((line) => line.includes("次响应无法解析为有效草案"));
      assert.ok(parseLog !== undefined, "解析失败必须输出 finalText 摘要日志");
      assert.ok(parseLog.includes(GARBAGE.slice(0, 200)), "日志应含 finalText 前 200 字符");
      assert.ok(!parseLog.includes(GARBAGE.slice(200)), "日志串应截断在 200 字符，不外溢");
      pass("场景 1：首次 75s 解析失败 → 重试只分到剩余 225s，总耗时 85s 成功");
    }

    // ---------- 场景 2：两次都解析失败且预算够用 → AI_PARSE_FAILED ----------
    {
      calls = [];
      plan = [
        { elapsedMs: 75_000, finalText: GARBAGE },
        { elapsedMs: 75_000, finalText: GARBAGE },
      ];
      const startedAt = virtualNow;
      const res = await postDraft(tripId);
      assert.equal(res.status, 502, "解析两次失败应 502");
      assert.equal(res.body.code, "AI_PARSE_FAILED", "错误码应为解析失败");
      assert.equal(calls.length, 2, "最多尝试 2 次");
      assert.equal(calls[1]!.timeoutMs, BUDGET_MS - 75_000, "第 2 次仍只拿剩余预算");
      assertBudgetInvariant(virtualNow - startedAt);
      pass("场景 2：两次解析失败预算够用 → AI_PARSE_FAILED，总耗时 150s");
    }

    // ---------- 场景 3：第 2 次耗尽剩余预算 → 总耗时恰好封顶 300s ----------
    {
      calls = [];
      plan = [{ elapsedMs: 75_000, finalText: GARBAGE }, { elapsedMs: 999_000 }];
      const startedAt = virtualNow;
      const res = await postDraft(tripId);
      assert.equal(res.status, 502);
      assert.equal(res.body.code, "BAILIAN_REQUEST_FAILED");
      const message = String(res.body.message);
      assert.ok(message.includes("本轮已等待 300 秒"), `消息应报告本轮总耗时（实际：${message}）`);
      assert.ok(message.includes("总预算 300 秒"), `消息应报告总预算（实际：${message}）`);
      assert.ok(message.includes("共尝试 2 次"), `消息应报告尝试次数（实际：${message}）`);
      assert.equal(calls.length, 2);
      assert.equal(calls[1]!.timeoutMs, BUDGET_MS - 75_000);
      assert.equal(calls[1]!.timedOut, true, "第 2 次应在剩余预算处超时");
      assert.equal(virtualNow - startedAt, BUDGET_MS, "总耗时不得突破 300s 总预算");
      assertBudgetInvariant(virtualNow - startedAt);
      pass("场景 3：第 2 次耗尽剩余预算 → 总耗时恰好 300s，不越前端 315s");
    }

    // ---------- 场景 4：剩余预算低于 30s 阈值 → 不再发起重试 ----------
    {
      calls = [];
      plan = [{ elapsedMs: 280_000, finalText: GARBAGE }];
      const startedAt = virtualNow;
      const res = await postDraft(tripId);
      assert.equal(res.status, 502);
      assert.equal(res.body.code, "BAILIAN_REQUEST_FAILED");
      assert.equal(calls.length, 1, `剩余 20s < ${MIN_RETRY_MS}ms 阈值时不得重试`);
      assert.ok(String(res.body.message).includes("本轮已等待 280 秒"), "消息应报告实际等待时长");
      assert.ok(String(res.body.message).includes("共尝试 1 次"), "消息应报告实际尝试次数");
      assertBudgetInvariant(virtualNow - startedAt);
      pass("场景 4：剩余 20s 不足最低阈值 → 立即超时，不再调用百炼");
    }

    // ---------- 场景 5：百炼自身超时一次即抛出，不再等下一个预算 ----------
    {
      calls = [];
      plan = [{ elapsedMs: 400_000 }];
      const startedAt = virtualNow;
      const res = await postDraft(tripId);
      assert.equal(res.status, 502);
      assert.equal(res.body.code, "BAILIAN_REQUEST_FAILED");
      assert.equal(calls.length, 1, "超时不得重试");
      assert.equal(calls[0]!.timeoutMs, BUDGET_MS);
      assert.equal(virtualNow - startedAt, BUDGET_MS);
      assertBudgetInvariant(virtualNow - startedAt);
      pass("场景 5：单次超时一次即抛错，总耗时 300s");
    }

    console.log("\n[verify] Task #227（草案生成重试共享总预算）全部通过 ✓");
  } finally {
    console.error = realConsoleError;
    Date.now = realDateNow;
    resetGuidePlannerDeps();
    try {
      await tripStore.deleteTrip(trip.tripId);
      console.log(`[verify] 已清理临时行程 ${trip.tripId}（server/data）`);
    } catch (error) {
      console.warn(`[verify] 清理临时行程 ${trip.tripId} 失败:`, error);
    }
  }
}

void main();
