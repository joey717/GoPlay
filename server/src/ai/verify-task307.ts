/**
 * Task #307 草案版本护栏「冲突域」粒度验证（全程离线，不触网、不调用真实百炼）。
 *
 * 缺陷背景：草案生成期间，后台图片结算写（commitImageEvidence / commitSkippedEvidence /
 * finalizeSource 的 save）只写 guide 证据 / sourceVersion / imageProgress，不写排程，
 * 但每次 save 都 bump trip.version；旧护栏用「latest.version !== inputTripVersion」做全 trip
 * 乐观锁，任何 save 都作废草案——粒度过粗。修复后仅「排程 / 约束 / 补充句 / 选中来源」变化
 * 或「已消费证据被删」才作废，纯证据类写入以最新版本 rebase 提交。
 *
 * 覆盖 5 场景（每场景独立新建夹具行程，可重复运行）：
 *   ① prep 后仅图片结算类写入（sourceVersion+1、追加证据、更新 imageProgress、save bump）
 *      → 应用成功（rebase，草案落盘且版本双跳）；
 *   ② prep 后手动 stop / 排程重排 → 作废（409 DRAFT_STALE，草案不落盘）；
 *   ③ prep 后删除（软移除）某选中来源 → 作废；
 *   ④ prep 后删除某条已消费证据 → 作废；
 *   ⑤ 无并发写入 → 原路径提交（版本单跳，无 rebase）。
 *
 * 运行：npx tsx server/src/ai/verify-task307.ts
 * 临时行程（server/data）在脚本末尾统一清理，不影响用户既有数据。
 */

import "../env.js";
import assert from "node:assert/strict";
import type { GuideSource, SourceEvidence, Trip } from "@goplay/shared";
import { createEmptyGuideImageProgress } from "@goplay/shared";
import { createFixtureSanyaTrip, tripStore } from "../persistence/store.js";
import { resetGuidePlannerDeps, setGuidePlannerDeps } from "../guides/planner.js";
import { guideRoutes } from "../guides/routes.js";
import { evaluateDraftRebase } from "./draftConflict.js";

// ===== 基础辅助 =====

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

// ===== planner 桩（生产依赖零触网；beforeDraftSave 模拟生成期间并发写） =====

let plannerCalls = 0;
let beforeDraftSaveHook: ((tripId: string) => Promise<void>) | undefined;

const AI_EMPTY_JSON = JSON.stringify({ operations: [], snippets: [] });

setGuidePlannerDeps({
  callPlanner: async () => {
    plannerCalls += 1;
    return AI_EMPTY_JSON;
  },
  beforeDraftSave: async (tripId: string) => {
    if (beforeDraftSaveHook !== undefined) await beforeDraftSaveHook(tripId);
  },
});

// ===== 夹具辅助 =====

function mkMention(mentionId: string, text: string, quoteText: string): SourceEvidence["mentions"][number] {
  return {
    mentionId,
    text,
    quoteText,
    bbox: null,
    extractedName: text,
    locationHint: null,
    modelSummary: `【桩】${quoteText}`,
    claimKind: "tip",
    targetScope: "place",
    firsthand: true,
    relationEvidence: null,
  };
}

function mkEvidence(evidenceId: string, noteIndex: number, mentions: SourceEvidence["mentions"]): SourceEvidence {
  return {
    evidenceId,
    kind: "note_text",
    noteIndex,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions,
  };
}

const SRC = "src_307";
const EV_MAIN = "ev_307";
const EV_EXTRA = "ev_307_extra";

/**
 * 单一可用来源 src_307：正文证据 ev_307（含一条提及，保证 merge.mentions 非空、来源 usable）
 * ＋ 一条无提及的额外证据 ev_307_extra（供场景④删除，验证「已消费证据」检查）。
 * guideSources 整体覆盖为仅 src_307，确保冲突域判定的选中来源集合确定。
 */
async function setup307Fixture(tripId: string): Promise<void> {
  const trip = await loadTrip(tripId);
  trip.evidences[EV_MAIN] = mkEvidence(EV_MAIN, 1, [
    mkMention("m1", "蜈支洲岛", "蜈支洲岛：建议早8点前登岛避开人流。"),
  ]);
  trip.evidences[EV_EXTRA] = mkEvidence(EV_EXTRA, 2, []);
  const source: GuideSource = {
    sourceId: SRC,
    sourceVersion: 1,
    inputKind: "text",
    title: "三亚攻略（Task #307 夹具）",
    active: true,
    status: "ready",
    evidenceRefs: [EV_MAIN, EV_EXTRA],
    mentionRefs: [`${EV_MAIN}:m1`],
    imageProgress: createEmptyGuideImageProgress(),
    importedAt: "2026-11-02T08:00:00.000Z",
    updatedAt: "2026-11-02T08:00:00.000Z",
  };
  trip.guideSources = { [SRC]: source };
  trip.guideDraftNote = "";
  await tripStore.save(trip);
}

/** 制造一次真实的排程变更（真冲突）：优先重排首个含 ≥2 景点的天，否则翻转首个 Visit 锁定标志。 */
function mutateSchedule(trip: Trip): void {
  for (const dayId of trip.dayRefs) {
    const day = trip.days[dayId];
    if (day !== undefined && day.scheduleVisitRefs.length >= 2) {
      const refs = day.scheduleVisitRefs;
      [refs[0], refs[1]] = [refs[1], refs[0]];
      // 同步 order，保持一致性（order 与 scheduleVisitRefs 下标对齐）
      for (let i = 0; i < refs.length; i += 1) {
        const visit = trip.visits[refs[i]];
        if (visit !== undefined) visit.order = i;
      }
      return;
    }
  }
  const anyVisitId = Object.keys(trip.visits)[0];
  assert.ok(anyVisitId !== undefined, "前提：夹具行程应至少有一个 Visit");
  trip.visits[anyVisitId].locked = !trip.visits[anyVisitId].locked;
}

// ===== main =====

async function main(): Promise<void> {
  try {
    await runScenarios();
    console.log("\n[verify] Task #307（草案护栏冲突域粒度）全部通过 ✓");
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

async function newFixtureTrip(): Promise<string> {
  const trip = await createFixtureSanyaTrip();
  createdTripIds.push(trip.tripId);
  await setup307Fixture(trip.tripId);
  return trip.tripId;
}

async function runScenarios(): Promise<void> {
  // ---------- 场景⓪（fail-safe）：指纹重算抛异常 → 回退严格作废，绝不静默放行 ----------
  {
    // 构造一个访问 dayRefs 即抛异常的畸形 latest，模拟指纹重算 / 引用检查中的意外异常
    const throwingTrip = {
      get dayRefs(): never {
        throw new Error("boom（模拟指纹重算异常）");
      },
    } as unknown as Trip;
    const decision = evaluateDraftRebase({
      latest: throwingTrip,
      preparedFingerprint: "any",
      selectedSourceIds: [],
      consumedEvidenceRefs: [],
    });
    assert.equal(decision.kind, "stale", "指纹重算抛异常必须回退严格作废（stale），不得 rebase 放行");
    assert.match(decision.kind === "stale" ? decision.reason : "", /异常/, "作废原因应标明校验异常");
    pass("⓪ fail-safe：指纹重算抛异常 → 严格作废（stale），不静默放行");
  }

  // ---------- 场景①：仅图片结算类写入 → rebase 成功 ----------
  {
    const tripId = await newFixtureTrip();
    const baseVersion = (await loadTrip(tripId)).version;
    plannerCalls = 0;
    beforeDraftSaveHook = async (targetTripId: string) => {
      const latest = await loadTrip(targetTripId);
      const source = latest.guideSources?.[SRC];
      assert.ok(source !== undefined, "前提：src_307 应存在");
      // 模拟 commitImageEvidence：sourceVersion+1、追加图片证据、更新 imageProgress、save bump
      source.sourceVersion += 1;
      const imgEvidenceId = "ev_307_img";
      latest.evidences[imgEvidenceId] = mkEvidence(imgEvidenceId, 3, []);
      source.evidenceRefs = [...source.evidenceRefs, imgEvidenceId];
      source.imageProgress = {
        total: 1,
        completed: 1,
        failed: 0,
        images: [{ index: 1, status: "ready", evidenceId: imgEvidenceId }],
      };
      source.updatedAt = new Date().toISOString();
      await tripStore.save(latest); // 非冲突写：只动 guide 证据 / sourceVersion / imageProgress
    };
    const res = await requestJson(`/trips/${tripId}/draft`, "POST", { scope: { kind: "trip" } });
    beforeDraftSaveHook = undefined;

    assert.equal(res.status, 200, `图片结算类并发写应 rebase 成功 200（实际 ${res.status}：${JSON.stringify(res.body)}）`);
    assert.ok(res.body.draftId !== null && res.body.draftId !== undefined, "rebase 后草案应落盘（draftId 非空）");
    const saved = await loadTrip(tripId);
    assert.ok(saved.pendingGuideDraft !== undefined, "rebase 后应保存待应用草案");
    // 版本双跳：hook 的非冲突写 +1，草案保存 +1；inputTripVersion 改绑到 rebase 时的最新版本
    assert.equal(saved.version, baseVersion + 2, "rebase 路径应有两次版本自增（并发写 + 草案保存）");
    assert.equal(saved.pendingGuideDraft?.inputTripVersion, baseVersion + 1, "rebase 后 inputTripVersion 改绑最新版本");
    assert.equal(saved.pendingGuideDraft?.baseTripVersion, saved.version, "baseTripVersion 应等于保存后 Trip.version");
    pass("① 仅图片结算类写入 → rebase 成功（草案落盘 / 版本双跳 / inputTripVersion 改绑最新）");
  }

  // ---------- 场景②：手动排程重排（真冲突）→ 作废 ----------
  {
    const tripId = await newFixtureTrip();
    const baseVersion = (await loadTrip(tripId)).version;
    beforeDraftSaveHook = async (targetTripId: string) => {
      const latest = await loadTrip(targetTripId);
      mutateSchedule(latest);
      await tripStore.save(latest);
    };
    const res = await requestJson(`/trips/${tripId}/draft`, "POST", { scope: { kind: "trip" } });
    beforeDraftSaveHook = undefined;

    assert.equal(res.status, 409, `排程重排应作废 409（实际 ${res.status}：${JSON.stringify(res.body)}）`);
    assert.equal(res.body.code, "DRAFT_STALE", "错误码应为 DRAFT_STALE");
    assert.match(String(res.body.message), /重新生成/, "作废消息应提示重新生成");
    const saved = await loadTrip(tripId);
    assert.equal(saved.pendingGuideDraft, undefined, "真冲突时草案不得落盘");
    assert.equal(saved.version, baseVersion + 1, "仅并发排程写那一次版本自增");
    pass("② 手动排程重排（真冲突）→ 409 DRAFT_STALE / 草案不落盘");
  }

  // ---------- 场景③：删除（软移除）某选中来源 → 作废 ----------
  {
    const tripId = await newFixtureTrip();
    beforeDraftSaveHook = async (targetTripId: string) => {
      const latest = await loadTrip(targetTripId);
      const source = latest.guideSources?.[SRC];
      assert.ok(source !== undefined, "前提：src_307 应存在");
      source.active = false;
      source.removedAt = new Date().toISOString();
      source.updatedAt = source.removedAt;
      await tripStore.save(latest);
    };
    const res = await requestJson(`/trips/${tripId}/draft`, "POST", { scope: { kind: "trip" } });
    beforeDraftSaveHook = undefined;

    assert.equal(res.status, 409, `删除选中来源应作废 409（实际 ${res.status}：${JSON.stringify(res.body)}）`);
    assert.equal(res.body.code, "DRAFT_STALE", "错误码应为 DRAFT_STALE");
    const saved = await loadTrip(tripId);
    assert.equal(saved.pendingGuideDraft, undefined, "选中来源被删时草案不得落盘");
    pass("③ 删除（软移除）选中来源 → 409 DRAFT_STALE / 草案不落盘");
  }

  // ---------- 场景④：删除某条已消费证据 → 作废 ----------
  {
    const tripId = await newFixtureTrip();
    beforeDraftSaveHook = async (targetTripId: string) => {
      const latest = await loadTrip(targetTripId);
      const source = latest.guideSources?.[SRC];
      assert.ok(source !== undefined, "前提：src_307 应存在");
      // 删除 prep 时已消费的 ev_307_extra（无 mentionRefs，删除后仍满足一致性）
      source.evidenceRefs = source.evidenceRefs.filter((id) => id !== EV_EXTRA);
      delete latest.evidences[EV_EXTRA];
      source.updatedAt = new Date().toISOString();
      await tripStore.save(latest);
    };
    const res = await requestJson(`/trips/${tripId}/draft`, "POST", { scope: { kind: "trip" } });
    beforeDraftSaveHook = undefined;

    assert.equal(res.status, 409, `删除已消费证据应作废 409（实际 ${res.status}：${JSON.stringify(res.body)}）`);
    assert.equal(res.body.code, "DRAFT_STALE", "错误码应为 DRAFT_STALE");
    const saved = await loadTrip(tripId);
    assert.equal(saved.pendingGuideDraft, undefined, "已消费证据被删时草案不得落盘");
    pass("④ 删除某条已消费证据 → 409 DRAFT_STALE / 草案不落盘");
  }

  // ---------- 场景⑤：无并发写入 → 原路径提交 ----------
  {
    const tripId = await newFixtureTrip();
    const baseVersion = (await loadTrip(tripId)).version;
    beforeDraftSaveHook = undefined;
    const res = await requestJson(`/trips/${tripId}/draft`, "POST", { scope: { kind: "trip" } });

    assert.equal(res.status, 200, `无并发写应正常 200（实际 ${res.status}：${JSON.stringify(res.body)}）`);
    assert.ok(res.body.draftId !== null && res.body.draftId !== undefined, "草案应落盘");
    const saved = await loadTrip(tripId);
    assert.ok(saved.pendingGuideDraft !== undefined, "应保存待应用草案");
    // 原路径：inputTripVersion = prep 版本，版本单跳（仅草案保存 +1）
    assert.equal(saved.version, baseVersion + 1, "原路径仅草案保存一次版本自增");
    assert.equal(saved.pendingGuideDraft?.inputTripVersion, baseVersion, "原路径 inputTripVersion = prep 版本");
    assert.equal(saved.pendingGuideDraft?.baseTripVersion, saved.version, "baseTripVersion 应等于保存后 Trip.version");
    pass("⑤ 无并发写入 → 原路径提交（版本单跳 / inputTripVersion = prep 版本）");
  }
}

void main();
