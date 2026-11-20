/**
 * Task #276：依赖 planner 的 9 条用例共享的「一次真实草案」场景。
 *
 * 设计（v1.1 §0 拍板：planner 依赖用例本轮 live 录制、里程碑强制 live）：
 * - 8 条草案类用例（A1/A3/A4/A5/A11/S1/S2/S3）共享**同一次** generateGuideDraft
 *   真调结果——一次 live 录制喂多条断言，token 成本从 8 次降到 1 次；
 * - O3（NL 局部松排）走 F11 executeIntent（pipeline.ts 直连百炼，不经 plannerCache），
 *   只能 live、不可回放，单独录制。
 *
 * 确定性：行程用固定 UUID + 固定 now 构建（buildFixtureSanyaTrip 结构本身确定），
 * 素材经 fixtureLoader 注入（EVAL_FIXTURE=1）。Task #284 已实现固定 id 装配：
 * assemble 内部 itemId/stopId 与 service 的 sourceId 经中央 idGen 模块生成——
 * 评测态注入 deterministicIdFromSeed（内容种子派生），跨进程稳定 → prompt 稳定
 * → plannerCache 回放键命中。功能态＝randomUUID 零变化。
 *
 * 场景不落业务副作用：用独立固定 tripId，runner 收尾统一 cleanupSharedScenario 删除。
 */

import type { Trip } from "@goplay/shared";
import { generateGuideDraft, type GuideDraftResult } from "../../server/src/guides/planner.js";
import { executeIntent, type IntentResult } from "../../server/src/ai/pipeline.js";
import { getGuideSource, submitGuideSource } from "../../server/src/guides/service.js";
import { buildFixtureSanyaTrip, tripStore } from "../../server/src/persistence/store.js";
import { getPlannerCacheStats, type PlannerCallMode } from "./plannerCache.js";
import { installFixtureExtraction, loadFixtureAssets } from "./fixtureLoader.js";

/** 固定 UUID（满足 store TRIP_ID_PATTERN）+ 固定 now：行程结构逐次确定 */
export const SCENARIO_TRIP_ID = "0e1a2b3c-4d5e-4f60-8a7b-000000000276";
const SCENARIO_NOW = "2026-10-19T08:00:00.000Z";

/** O3 意图原文：局部松排 Day2（F11 局部重算 scope） */
export const O3_INTENT_TEXT = "Day2 松一点";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// 来源结算轮询上限：submitGuideSource 内部对每个抽取点位做 FlyAI POI 对齐。Task #292：FlyAI
// 改走 replay（flyaiCache，命中缓存消除网络波动）后正常极快，但 MISS 转真调 ＋ 连续多轮限流
// 仍可能使大源（S2 10 点位）逼近上限；120s→240s 只影响「卡死判定」的基础设施阈值，不改任何
// 断言语义（#286 首放宽 30s→120s；#292 live 轮 S2 波动实测再放宽，配合 FlyAI replay 消除根因）。
async function pollSourceUntilDone(tripId: string, sourceId: string, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const source = await getGuideSource(tripId, sourceId);
    if (source.status !== "processing") return source;
    if (Date.now() > deadline) throw new Error(`[SCENARIO] 来源 ${sourceId} 轮询超时（${timeoutMs}ms）仍在 processing`);
    await sleep(100);
  }
}

export interface SharedDraftScenario {
  tripId: string;
  /** 素材冻结后的行程（generateGuideDraft 内部已保存草案；此为调用后快照） */
  trip: Trip;
  draft: GuideDraftResult;
  /** 本次构建实际提交的来源数（S1–S5） */
  sourceCount: number;
  /** 构建期 planner 调用模式（live/replay），供 runner 给共享用例统一打标 */
  plannerModes: PlannerCallMode[];
  /** 构建耗时（含素材处理 + 一次 planner 真调） */
  buildMs: number;
}

let scenarioPromise: Promise<SharedDraftScenario> | null = null;
let intentPromise: Promise<IntentResult> | null = null;

/** 构建共享草案场景（记忆化：8 条草案用例只在首条触发一次真调） */
async function buildSharedDraft(): Promise<SharedDraftScenario> {
  const started = Date.now();
  installFixtureExtraction();
  const { data } = loadFixtureAssets();

  // 1. 固定行程落盘（结构确定）
  const base = buildFixtureSanyaTrip(SCENARIO_TRIP_ID, SCENARIO_NOW);
  await tripStore.save(base);

  // 2. 提交 S1–S5 文本源（fixture 抽取按标题匹配 claims）——逐源「提交→等 ready」串行结算。
  //    Task #284：并发提交在回放态会触发乐观锁重试耗尽（FlyAI 缓存瞬时返回，5 源写盘窗口
  //    完全重叠；录制态网络延迟天然错开故不暴露），且并发结算顺序本身不确定 → noteIndex /
  //    mention 排序漂移 → prompt 不稳定 → 回放键跨进程 MISS。串行结算彻底消除该非确定性，
  //    跨进程 prompt 完全一致（仅改 harness 场景编排，功能态来源仍并发结算，行为零变化）。
  const sourceIds: string[] = [];
  for (const source of data.sources) {
    // Task #292：只纳入有 fixture claims 的源（S1–S5）。S6（亚龙湾，#285 E9 golden 语料源）
    // 在 claims 数组无对应条目，fixtureEntriesForSource 对其「未收录回退全量 claims」（19 条
    // S1–S5 合集），共享草案若纳入 S6 会把全部点位重复对齐一遍 → live FlyAI 真调超 120s 轮询
    // 上限（src_7054bee8 超时 → A4/S1 在到达 planner 前即 fail）。共享草案设计素材为 S1–S5
    // （本文件 L5/L54/L75/L96 注），E9 走 extraction cache 不依赖 sources；fixture assets 有
    // sha256 完整性校验（改 JSON＝升版本），故在 harness 侧按 claims 归属过滤，数据驱动。
    if (!data.claims.some((claim) => claim.source === source.id)) {
      console.log(
        `[SCENARIO] 跳过源 ${source.id}（${source.title}）：claims 数组无对应条目，非共享草案素材（S1–S5）；E9 语料源走 extraction cache`,
      );
      continue;
    }
    const submitted = await submitGuideSource(SCENARIO_TRIP_ID, {
      inputKind: "text",
      text: `${source.title}\n${source.notes ?? ""}`,
      title: source.title,
    });
    sourceIds.push(submitted.sourceId);
    const done = await pollSourceUntilDone(SCENARIO_TRIP_ID, submitted.sourceId);
    if (done.status !== "ready") {
      console.warn(`[SCENARIO] 来源 ${submitted.sourceId} 终态=${done.status}（${done.failureMessage ?? ""}）`);
    }
  }

  // 3. 一次 planner 真调（whole-trip scope，避开 snippet-only 快速路径）
  //    Task #161：新增来源默认 staged=true，不参与默认 "all" 模式合并（会 GUIDE_NO_SOURCES）；
  //    故显式 sourceMode="selected" + selectedSourceIds 把 5 条 fixture 源纳入本轮草案。
  const before = getPlannerCacheStats();
  const beforeLive = before.liveCalls;
  const beforeReplay = before.replayHits;
  const draft = await generateGuideDraft(SCENARIO_TRIP_ID, {
    scope: { kind: "trip" },
    sourceMode: "selected",
    selectedSourceIds: sourceIds,
  });
  const after = getPlannerCacheStats();
  const plannerModes: PlannerCallMode[] = [
    ...Array.from({ length: after.replayHits - beforeReplay }, () => "replay" as PlannerCallMode),
    ...Array.from({ length: after.liveCalls - beforeLive }, () => "live" as PlannerCallMode),
  ];

  const trip = await tripStore.load(SCENARIO_TRIP_ID);
  console.log(
    `[SCENARIO] 共享草案就绪：sources=${sourceIds.length}，fastPath=${draft.fastPath}，attempts=${draft.attempts}，` +
      `operations=${draft.operations.length}，snippets=${draft.snippets.length}，optionGroups=${draft.optionGroups.length}，` +
      `placeCount=${draft.placeCount}，mentionCount=${draft.mentionCount}，planner=${plannerModes.join("/") || "无(快速路径)"}`,
  );
  return {
    tripId: SCENARIO_TRIP_ID,
    trip: trip ?? base,
    draft,
    sourceCount: sourceIds.length,
    plannerModes,
    buildMs: Date.now() - started,
  };
}

/** 获取共享草案场景（记忆化）；首条用例触发构建，其余复用同一次真调结果 */
export function getSharedDraft(): Promise<SharedDraftScenario> {
  if (scenarioPromise === null) scenarioPromise = buildSharedDraft();
  return scenarioPromise;
}

/** O3：F11 局部松排意图（独立 live 真调，不经 plannerCache，不可回放） */
export function getSharedIntent(): Promise<IntentResult> {
  if (intentPromise === null) {
    intentPromise = (async () => {
      // 依赖共享草案场景先把行程建好（同一 tripId）
      await getSharedDraft();
      console.log(`[SCENARIO] O3 executeIntent 真调：「${O3_INTENT_TEXT}」（F11 pipeline，直连百炼，不经缓存）`);
      return executeIntent(SCENARIO_TRIP_ID, O3_INTENT_TEXT);
    })();
  }
  return intentPromise;
}

let sharedPlannerModes: PlannerCallMode[] = [];
/** runner 读取：共享草案构建期的 planner 模式（给未触发构建的复用用例打标） */
export function getSharedPlannerModes(): PlannerCallMode[] {
  return sharedPlannerModes;
}
export function setSharedPlannerModes(modes: PlannerCallMode[]): void {
  if (modes.length > 0) sharedPlannerModes = modes;
}

/** 收尾清理：删除固定行程，重置记忆化（runner 结束时调用） */
export async function cleanupSharedScenario(): Promise<void> {
  try {
    await tripStore.deleteTrip(SCENARIO_TRIP_ID);
  } catch {
    // 未创建或已删除：静默
  }
  scenarioPromise = null;
  intentPromise = null;
  sharedPlannerModes = [];
}
