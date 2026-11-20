/**
 * Task #96（攻略包 B2）验证（两段制）。
 *
 * 段一（离线：setGuideServiceDeps 桩注入，全程不触网、不调用真实百炼 / FlyAI）：
 *   1. HTTP 错误码矩阵：INVALID_REQUEST / LINK_INVALID / TRIP_NOT_FOUND /
 *      SOURCE_NOT_FOUND / IMAGE_COUNT_EXCEEDED + 响应空形状契约 + 拒绝不落盘；
 *   2. runGuideImageQueue 单元测试：生产参数（并发 4 / 单图 120s / 上限 24 张 /
 *      动态总预算，Task #175）、9 图与 12 图在 180s 下限预算内全部结算（注入虚拟时钟，真等不可能）、
 *      旧 90s 预算对照、预算到期不再启动新图、迟到写入被运行令牌阻断、无未处理 rejection；
 *   3. suppressAttach 单元测试：high 后台装配不自动挂入，pending + 建议归属；
 *   4. 文字来源：两秒内返回 processing → 轮询 ready；正文证据 / mentionRefs /
 *      候选池兼容（复用情人桥 / 观日岩既有实体）；已生成行程零改动；
 *      ready 来源重试 → SOURCE_NOT_RETRYABLE；同正文重复提交命中缓存；
 *   5. 攻略补充句：保存 / 清除 / 超长 / 非法 JSON / 非法类型；
 *   6. 链接来源全流程：抓取 → 正文先落 → 预筛桩全保留（Task #175）→ 12 图队列
 *      （图 6 审核拒绝）→ partial，其余 11 图证据保留；imageProgress / coverageText / sourceVersion 明细；
 *   7. 链接去重：分享参数变体命中缓存，不重抓（fetchCalls 不增）；
 *   8. 重启恢复：手动模拟进程重启（processing + 无活跃 job）→ 列表读取触发恢复 →
 *      partial + 未完成图 timeout + 成功证据保留 → 重试只跑失败图 → ready（原位升级）；
 *      pendingGuideDraft 全程保留，sourceVersion 变化使旧快照过期；
 *   9. 软移除 / 恢复：active=false + removedAt、evidence 原样保留、
 *      isGuideSourceUsable=false；恢复幂等；
 *   10. 抓取失败：登录墙 → failed(blocked)；同链接重新提交视为重跑 → 成功 ready；
 *   11. 处理中重试：挂起桩 → retry 409 SOURCE_BUSY；释放后 ready；
 *      multipart 提交原图落盘受控目录（uploads/{tripId}/ev_shot_*.png）。
 *
 * 段二（触网：真实百炼 File API，约 30-150s，需仓库根目录 .env）：
 *   12. 真实图片来源：multipart 提交现有小红书缓存图（xhs_6ace… 目录）→
 *      两秒内返回 processing → 轮询至终态；每图 ready 证据有真实 ocrText /
 *      mentions，或失败带具体 failureCode；部分失败 → partial 且成功图保留；
 *      百炼远端文件识别完即删（日志提取 fileId → getBailianFile 全部 404）；
 *      后台装配不改动已生成行程。
 *
 * 运行：npm run verify:guides -w server（或 npx tsx server/src/guides/verify-b2.ts）
 * 跳过触网段：VERIFY_SKIP_LIVE=1
 * 临时行程（server/data + server/uploads）在脚本末尾全部清理，不影响用户既有数据。
 */

import "../env.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { GuideSource, Item, PendingGuideDraft, Trip } from "@goplay/shared";
import {
  checkPendingGuideDraftFreshness,
  isGuideSourceUsable,
  parseMentionRef,
  SCHEMA_VERSION,
} from "@goplay/shared";
import { getBailianFile } from "../bailian/client.js";
import { ensureStopAndPlace, type ParsedEntry } from "../ai/assemble.js";
import { AiError } from "../ai/errors.js";
import type { OcrScreenshotInput, RecognizedImageContent } from "../ai/ocr.js";
import { XhsError, type XhsNoteResult } from "../ai/xhs.js";
import type { PrefilterImageInput, PrefilterSkipDecision } from "../ai/prefilter.js";
import { createFixtureSanyaTrip, tripStore, UPLOADS_DIR } from "../persistence/store.js";
import {
  GUIDE_IMAGE_CONCURRENCY,
  GUIDE_IMAGE_TIMEOUT_MS,
  GUIDE_MAX_IMAGES,
  GUIDE_SOURCE_BUDGET_MS,
  guideSourceBudgetMs,
  runGuideImageQueue,
  runGuideImageQueueForSource,
  type GuideImageQueueClock,
} from "./jobs.js";
import { guideRoutes } from "./routes.js";
import { resetGuideServiceDeps, setGuideServiceDeps } from "./service.js";

// ===== 基础辅助 =====

function pass(name: string): void {
  console.log(`✓ ${name}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 虚拟时钟（Task #121）：队列的预算判定与到期回调全部走注入时钟，
 * 离线验证无需真的等待 180s；任务按「虚拟耗时」推进时钟。
 */
class VirtualClock implements GuideImageQueueClock {
  private nowMs = 0;
  private readonly timers: Array<{ at: number; callback: () => void; cancelled: boolean }> = [];

  now = (): number => this.nowMs;

  after = (ms: number, callback: () => void): (() => void) => {
    const timer = { at: this.nowMs + ms, callback, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };

  /** 推进到 target（不倒退），按时间顺序触发到期回调，并让队列续体先跑完再返回 */
  async advanceTo(target: number): Promise<void> {
    this.nowMs = Math.max(this.nowMs, target);
    for (;;) {
      const due = this.timers
        .filter((timer) => !timer.cancelled && timer.at <= this.nowMs)
        .sort((left, right) => left.at - right.at)[0];
      if (due === undefined) break;
      due.cancelled = true;
      due.callback();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** 拦截 console.log 收集日志：用于提取 fileId（验证百炼侧文件删除），不打印密钥 */
const collectedLogs: string[] = [];
const originalLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
  collectedLogs.push(args.map((value) => String(value)).join(" "));
  originalLog(...args);
};

/** 本脚本创建的临时行程：finally 统一清理（数据 + 上传目录） */
const createdTripIds: string[] = [];

/** 合法 PNG 测试字节（magic bytes 前 8 位 + 填充；detectImageKind 只看前缀） */
function pngBytes(size: number): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(new ArrayBuffer(Math.max(8, size)));
  data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return data;
}

/** 文件名中的数字 → 图片序号（xhs 图 "6.jpg" / multipart "gate-2.png"） */
function imageIndexFromFilename(filename: string): number {
  const match = filename.match(/(\d+)/);
  return match !== null ? Number(match[1]) : 0;
}

// ===== HTTP 辅助（直接驱动 guideRoutes，与 verify-task51 驱动 aiRoutes 同模式） =====

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

async function requestForm(
  routePath: string,
  form: FormData,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await guideRoutes.request(routePath, { method: "POST", body: form });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function loadTrip(tripId: string): Promise<Trip> {
  const trip = await tripStore.load(tripId);
  assert.ok(trip !== null, `行程 ${tripId} 应存在`);
  return trip;
}

/** 取来源（guideSources 为可选属性；load 时 ensureGuideContract 已补齐） */
function sourceOf(trip: Trip, sourceId: string): GuideSource {
  const source = trip.guideSources?.[sourceId];
  assert.ok(source !== undefined, `来源 ${sourceId} 应存在于行程 ${trip.tripId}`);
  return source;
}

async function getSource(tripId: string, sourceId: string): Promise<GuideSource> {
  const res = await requestJson(`/trips/${tripId}/sources/${sourceId}`, "GET");
  assert.equal(res.status, 200, `获取来源应 200（实际 ${res.status}：${JSON.stringify(res.body)}）`);
  return res.body.source as GuideSource;
}

/** 轮询来源直到离开 processing（后台 fire-and-forget 任务完成） */
async function waitSettled(tripId: string, sourceId: string, timeoutMs = 15_000): Promise<GuideSource> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const source = await getSource(tripId, sourceId);
    if (source.status !== "processing") return source;
    if (Date.now() > deadline) {
      throw new Error(`来源 ${sourceId} 在 ${timeoutMs}ms 内未结算（仍 processing）`);
    }
    await sleep(50);
  }
}

async function assertNoTripFile(tripId: string, label: string): Promise<void> {
  const filePath = path.join(UPLOADS_DIR, "..", "data", `${tripId}.json`);
  await assert.rejects(
    () => fs.access(filePath),
    (error: unknown) => error instanceof Error,
    `${label}：不应写入 ${tripId}.json`,
  );
}

// ===== 桩注入（段一离线驱动；段二 resetGuideServiceDeps 恢复真实依赖） =====

let stubNote: XhsNoteResult = {
  success: true,
  title: "蜈支洲岛游记（桩）",
  text: "上岛先走情人桥，下午去观日岩看海（桩正文）",
  images: [],
  sourceUrl: "https://www.xiaohongshu.com/explore/b2stub",
};
let stubFetchError: Error | null = null;
let stubFetchCalls = 0;
let stubEntries: ParsedEntry[] = [];
let stubExtractError: Error | null = null;
const stubImageFailures = new Map<number, Error>();
let stubImageGate: ((index: number) => Promise<RecognizedImageContent>) | null = null;
/** 识别调用序号列表（重试只跑失败图的断言依据） */
const stubRecognizeIndexes: number[] = [];

const stubFetchNote = async (): Promise<XhsNoteResult> => {
  stubFetchCalls += 1;
  if (stubFetchError !== null) throw stubFetchError;
  return { ...stubNote };
};
const stubExtractEntries = async (): Promise<ParsedEntry[]> => {
  if (stubExtractError !== null) throw stubExtractError;
  return stubEntries.map((entry) => ({ ...entry }));
};
const stubRecognizeImage = async (image: OcrScreenshotInput): Promise<RecognizedImageContent> => {
  const index = imageIndexFromFilename(image.filename);
  stubRecognizeIndexes.push(index);
  if (stubImageGate !== null) return stubImageGate(index);
  const failure = stubImageFailures.get(index);
  if (failure !== undefined) throw failure;
  return { ocrText: `【桩】第 ${index} 张图的识别文本（蜈支洲岛游记配图）`, mentions: [] };
};

/**
 * Task #175 预筛桩：默认全保留（空 Map = 不跳过任何图）；
 * 个别场景可改写 stubPrefilterSkips 验证跳过路径。键为预筛输入序号（0-based）。
 */
let stubPrefilterSkips = new Map<number, PrefilterSkipDecision>();
const stubPrefilterBatch = async (
  items: readonly PrefilterImageInput[],
): Promise<Map<number, PrefilterSkipDecision>> => {
  const result = new Map<number, PrefilterSkipDecision>();
  for (const [index, decision] of stubPrefilterSkips) {
    if (index < items.length) result.set(index, decision);
  }
  return result;
};

setGuideServiceDeps({
  fetchNote: stubFetchNote,
  extractEntries: stubExtractEntries,
  recognizeImage: stubRecognizeImage,
  prefilterBatch: stubPrefilterBatch,
});

/** 测试条目（与 verify-task51 的 mkEntry 同构） */
function mkEntry(
  name: string,
  type: ParsedEntry["type"],
  confidence: ParsedEntry["confidence"],
  parent: string | null = null,
): ParsedEntry {
  return {
    name,
    type,
    parentAttraction: parent,
    scale: null,
    confidence,
    suggestMinutes: 40,
    locationHint: null,
    quote: `原文提及${name}`,
    summary: "验证条目",
    ticketRelation: "unknown",
    suggestedVisitName: null,
    bbox: null,
  };
}

function mkItem(name: string): Item {
  return {
    itemId: `item_${name}`,
    name,
    origin: "custom",
    providerId: null,
    address: null,
    category: null,
    coords: null,
    suggestMinutes: 30,
    mainPic: null,
    ticketInfo: null,
    jumpUrl: null,
    sourceEvidenceRefs: [],
  };
}

// ===== main =====

async function main(): Promise<void> {
  try {
    await runOfflineScenarios();
    if (process.env.VERIFY_SKIP_LIVE === "1") {
      console.log("\n[verify] 离线段全部通过 ✓（VERIFY_SKIP_LIVE=1，跳过真实百炼段）");
      return;
    }
    await runLiveScenario();
    console.log("\n[verify] Task #96（B2）全部通过 ✓（离线段 + 真实百炼段）");
  } finally {
    await cleanup();
  }
}

async function cleanup(): Promise<void> {
  resetGuideServiceDeps();
  console.log = originalLog;
  let removed = 0;
  for (const tripId of createdTripIds) {
    try {
      await tripStore.deleteTrip(tripId);
      await fs.rm(path.join(UPLOADS_DIR, tripId), { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      console.warn(`[verify] 清理临时行程 ${tripId} 失败:`, error);
    }
  }
  console.log(`[verify] 已清理 ${removed}/${createdTripIds.length} 个临时行程（server/data + server/uploads）`);
}

// ===== 段一：离线场景 =====

async function runOfflineScenarios(): Promise<void> {
  // --- 场景 1：HTTP 错误码矩阵（错误均不落盘任何行程文件） ---
  {
    const ghostId = randomUUID();
    const base = `/trips/${ghostId}/sources`;

    const badLink = await requestJson(base, "POST", { inputKind: "link", url: "https://example.com/note" });
    assert.equal(badLink.status, 400);
    assert.equal(badLink.body.code, "LINK_INVALID");
    assert.deepEqual(
      { sourceId: badLink.body.sourceId, status: badLink.body.status, duplicate: badLink.body.duplicate, source: badLink.body.source },
      { sourceId: null, status: null, duplicate: false, source: null },
      "错误响应应保持与成功响应同形的空形状",
    );

    assert.equal((await requestJson(base, "POST", {})).body.code, "INVALID_REQUEST");
    assert.equal((await requestJson(base, "POST", { inputKind: "text", text: "   " })).body.code, "INVALID_REQUEST");
    assert.equal((await requestJson(base, "POST", { inputKind: "images" })).body.code, "INVALID_REQUEST");
    const rawBad = await guideRoutes.request(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json at all",
    });
    assert.equal(rawBad.status, 400);

    const noTrip = await requestJson(base, "GET");
    assert.equal(noTrip.status, 404);
    assert.equal(noTrip.body.code, "TRIP_NOT_FOUND");
    assert.deepEqual(noTrip.body.sources, []);
    assert.equal(noTrip.body.tripVersion, 0);

    const tripErr = await createFixtureSanyaTrip();
    createdTripIds.push(tripErr.tripId);
    const tripBase = `/trips/${tripErr.tripId}/sources`;

    const noSource = await requestJson(`${tripBase}/src_nonexistent`, "GET");
    assert.equal(noSource.status, 404);
    assert.equal(noSource.body.code, "SOURCE_NOT_FOUND");
    assert.equal(noSource.body.source, null);

    const retryGhost = await requestJson(`${tripBase}/src_nonexistent/retry`, "POST");
    assert.equal(retryGhost.status, 404);
    assert.equal(retryGhost.body.code, "SOURCE_NOT_FOUND");

    const noFile = new FormData();
    noFile.append("title", "无图片");
    assert.equal((await requestForm(tripBase, noFile)).body.code, "INVALID_REQUEST");

    const overForm = new FormData();
    for (let i = 1; i <= 31; i++) {
      overForm.append("images", new File([pngBytes(16)], `over-${i}.png`, { type: "image/png" }));
    }
    const overLimit = await requestForm(tripBase, overForm);
    assert.equal(overLimit.status, 413);
    assert.equal(overLimit.body.code, "IMAGE_COUNT_EXCEEDED");

    await assertNoTripFile(ghostId, "参数错误");
    pass("错误码矩阵：LINK_INVALID / INVALID_REQUEST / TRIP_NOT_FOUND / SOURCE_NOT_FOUND / IMAGE_COUNT_EXCEEDED(413) + 空形状 + 拒绝不落盘");
  }

  // --- 场景 2：图片并发队列单元测试（runGuideImageQueue / runGuideImageQueueForSource） ---
  {
    // 生产参数（Task #121 基线；Task #175 解除 12 张上限 + 动态预算）
    // 陈旧断言同步（Task #319 预飞）：#322 已把默认并发 4 → 6（verify-task231 断言 =6 且通过），
    // 此处同步为 6，属陈旧断言同步而非放宽门禁。
    assert.equal(GUIDE_IMAGE_CONCURRENCY, 6, "图片队列并发数应为 6（Task #322，原为 4）");
    assert.equal(GUIDE_SOURCE_BUDGET_MS, 180_000, "来源总预算下限应为 180s");
    assert.equal(GUIDE_IMAGE_TIMEOUT_MS, 120_000, "单图硬超时应保持 120s");
    assert.equal(GUIDE_MAX_IMAGES, 24, "单来源上限应为 24 张（Task #175）");
    // 动态预算：下限 / 批次伸缩 / 上限（Task #175）
    // 陈旧断言同步（Task #319 预飞）：#322 并发 4 → 6 后批数 = ceil(图数/6)，期望值随之变化，公式本身未改。
    assert.equal(guideSourceBudgetMs(1), 180_000, "1 图按预算下限 180s");
    assert.equal(guideSourceBudgetMs(12), 300_000, "12 图 = 2 批 × 150s（#322 并发 6，原为 3 批 450s）");
    assert.equal(guideSourceBudgetMs(17), 450_000, "17 图 = 3 批 × 150s（#322 并发 6，原为 5 批 750s）");
    assert.equal(guideSourceBudgetMs(24), 600_000, "24 图 = 4 批 × 150s（#322 并发 6，原为 6 批 900s）");
    assert.equal(guideSourceBudgetMs(40), 1_050_000, "40 图 = 7 批 × 150s（#322 并发 6，未触 1200s 上限；原为按上限截断）");
    assert.equal(guideSourceBudgetMs(48), 1_200_000, "48 图 = 8 批 × 150s 触上限 1200s 截断（#322 并发 6）");

    // 并发上限：12 任务、并发 GUIDE_IMAGE_CONCURRENCY(6)、每任务 10ms → 全部结算且峰值并发恰为 6
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 12 }, (_, i) => ({
      index: i + 1,
      run: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(10);
        active -= 1;
        return { index: i + 1, outcome: { kind: "ready" as const, evidenceId: `ev_q_${i + 1}` } };
      },
    }));
    const full = await runGuideImageQueue(tasks, { concurrency: GUIDE_IMAGE_CONCURRENCY, budgetMs: 10_000 });
    assert.equal(full.settled.length, 12);
    assert.deepEqual(full.timedOutIndexes, []);
    assert.equal(peak, GUIDE_IMAGE_CONCURRENCY, `并发峰值应达到上限 ${GUIDE_IMAGE_CONCURRENCY}（实际 ${peak}）`); // #322：4 → 6

    // 9 图 / 12 图：单图虚拟耗时 35s（实测量级）、并发 6 → 9 图 2 批 70s / 12 图 2 批 70s；180s 预算内全部结算。
    // 虚拟时钟推进，不真的等 180s；预算到期回调也由虚拟时钟触发。
    const runVirtualBatch = async (
      count: number,
      budgetMs: number,
    ): Promise<{ timedOut: number[]; settled: number; peak: number }> => {
      const clock = new VirtualClock();
      let running = 0;
      let peakRunning = 0;
      const batch = Array.from({ length: count }, (_, i) => ({
        index: i + 1,
        run: async () => {
          running += 1;
          peakRunning = Math.max(peakRunning, running);
          // 每批 concurrency 个任务同时起跑，单图虚拟耗时 35s：第 n 批在 n*35s 完成
          const finishAt = (Math.floor(i / GUIDE_IMAGE_CONCURRENCY) + 1) * 35_000;
          await clock.advanceTo(finishAt);
          running -= 1;
          return { index: i + 1, outcome: { kind: "ready" as const, evidenceId: `ev_v_${i + 1}` } };
        },
      }));
      const outcome = await runGuideImageQueue(batch, {
        concurrency: GUIDE_IMAGE_CONCURRENCY,
        budgetMs,
        clock,
      });
      // 预算提前返回后仍有虚拟任务在跑：等它们收尾，避免污染下个用例
      await sleep(20);
      return { timedOut: outcome.timedOutIndexes, settled: outcome.settled.length, peak: peakRunning };
    };

    const nine = await runVirtualBatch(9, GUIDE_SOURCE_BUDGET_MS);
    assert.equal(nine.settled, 9, `9 图应在 180s 预算内全部结算（实际 ${nine.settled}/9）`);
    assert.deepEqual(nine.timedOut, [], "9 图不应再有超时项");
    assert.equal(nine.peak, GUIDE_IMAGE_CONCURRENCY, `9 图并发峰值应为 ${GUIDE_IMAGE_CONCURRENCY}（实际 ${nine.peak}）`); // #322：4 → 6

    const twelve = await runVirtualBatch(12, GUIDE_SOURCE_BUDGET_MS);
    assert.equal(twelve.settled, 12, `12 图应在 180s 预算内全部结算（实际 ${twelve.settled}/12）`);
    assert.deepEqual(twelve.timedOut, [], "12 图不应再有超时项");

    // 回归对照：同一 9 图 fixture 在不足预算下会切掉后批（证明本断言不是空跑）。
    // 陈旧断言同步（Task #319 预飞）：#322 并发 4 → 6 后 9 图两批在 70s 内完成，
    // 旧对照预算 90s 不再能切掉后批；改用 30s（首批 35s 完成前到期）保持对照语义不变。
    const nineLegacy = await runVirtualBatch(9, 30_000);
    assert.ok(
      nineLegacy.timedOut.length > 0,
      `不足预算（30s）应切掉后批（实际 timedOut=${nineLegacy.timedOut.length}）`,
    );

    // 总预算到期不再启动新图：真实短预算 80ms + 12 任务各 300ms + 并发 GUIDE_IMAGE_CONCURRENCY(6)
    let started = 0;
    let finished = 0;
    const slowTasks = Array.from({ length: 12 }, (_, i) => ({
      index: i + 1,
      run: async () => {
        started += 1;
        await sleep(300);
        finished += 1;
        return { index: i + 1, outcome: { kind: "ready" as const, evidenceId: `ev_s_${i + 1}` } };
      },
    }));
    const budgeted = await runGuideImageQueue(slowTasks, {
      concurrency: GUIDE_IMAGE_CONCURRENCY,
      budgetMs: 80,
    });
    assert.equal(budgeted.settled.length, 0, "预算内没有图能完成");
    assert.equal(budgeted.timedOutIndexes.length, 12, "12 张均列入超时");
    assert.equal(started, GUIDE_IMAGE_CONCURRENCY, `预算到期后不得再启动新图（实际启动 ${started}）`); // #322：4 → 6
    await sleep(340);
    assert.equal(finished, GUIDE_IMAGE_CONCURRENCY, "在跑任务各自收尾，不会因为队列返回而取新任务"); // #322：4 → 6

    // 迟到写盘阻断：预算耗尽后队列结束、令牌失效 → 在跑任务不得补写
    const writes: number[] = [];
    let lateSawInactive = false;
    const lateTasks = Array.from({ length: 8 }, (_, i) => ({
      index: i + 1,
      run: async (run: { isActive: () => boolean }) => {
        await sleep(i === 0 ? 400 : 10);
        if (!run.isActive()) {
          lateSawInactive = true;
          return { index: i + 1, outcome: { kind: "skipped" as const, reason: "令牌已失效" } };
        }
        writes.push(i + 1);
        return { index: i + 1, outcome: { kind: "ready" as const, evidenceId: `ev_l_${i + 1}` } };
      },
    }));
    const lateOutcome = await runGuideImageQueueForSource("verify-t121-trip", "src-late", lateTasks, {
      concurrency: GUIDE_IMAGE_CONCURRENCY,
      budgetMs: 80,
    });
    assert.deepEqual(lateOutcome.timedOutIndexes, [1], `仅超长的图 1 未结算（实际 ${lateOutcome.timedOutIndexes.join(",")}）`);
    assert.deepEqual([...writes].sort((left, right) => left - right), [2, 3, 4, 5, 6, 7, 8], "预算内完成的图正常写盘");
    await sleep(430);
    assert.equal(lateSawInactive, true, "预算结束后令牌应失效：迟到结果必须丢弃");
    assert.deepEqual(
      [...writes].sort((left, right) => left - right),
      [2, 3, 4, 5, 6, 7, 8],
      "迟到结果不得在结算后补写（防竞态覆盖）",
    );

    // 重试接管：同一来源上一轮未完成任务的迟到结果不得与新一轮重复写同一张图
    const writeOrder: string[] = [];
    let releaseStale!: () => void;
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    const staleRound = runGuideImageQueueForSource("verify-t121-trip", "src-race", [{
      index: 1,
      run: async (run) => {
        await staleGate;
        if (run.isActive()) writeOrder.push("stale");
        return { index: 1, outcome: { kind: "skipped" as const, reason: "被新一轮接管" } };
      },
    }], { concurrency: 1, budgetMs: 10_000 });
    await sleep(20);
    const freshRound = await runGuideImageQueueForSource("verify-t121-trip", "src-race", [{
      index: 1,
      run: async (run) => {
        if (run.isActive()) writeOrder.push("fresh");
        return { index: 1, outcome: { kind: "ready" as const, evidenceId: "ev_fresh" } };
      },
    }], { concurrency: 1, budgetMs: 10_000 });
    assert.equal(freshRound.settled.length, 1);
    releaseStale();
    await staleRound;
    await sleep(20);
    assert.deepEqual(writeOrder, ["fresh"], "新一轮接管后，上一轮迟到结果不得写盘");

    // 未处理 rejection 监测：预算提前返回后仍在跑的 worker / 任务必须没有漏网 rejection
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const rejecting = await runGuideImageQueueForSource("verify-t121-trip", "src-reject", [{
      index: 1,
      run: async () => {
        await sleep(120);
        throw new Error("迟到的识别异常（桩）");
      },
    }], { concurrency: 1, budgetMs: 50 });
    assert.deepEqual(rejecting.timedOutIndexes, [1], "超预算的图记 timeout");
    await sleep(180);
    process.off("unhandledRejection", onUnhandled);
    assert.deepEqual(unhandled, [], "队列结束后不得产生未处理 rejection");

    // 单图硬超时：任务 150ms、perTaskTimeoutMs=40 → timeout 失败（迟到结果丢弃）
    const timeoutTask = [{
      index: 1,
      run: async () => {
        await sleep(150);
        return { index: 1, outcome: { kind: "ready" as const, evidenceId: "ev_late" } };
      },
    }];
    const timed = await runGuideImageQueue(timeoutTask, { concurrency: 1, budgetMs: 10_000, perTaskTimeoutMs: 40 });
    assert.equal(timed.settled.length, 1);
    assert.equal(timed.settled[0].outcome.kind, "failed");
    assert.equal(timed.settled[0].outcome.kind === "failed" ? timed.settled[0].outcome.failureCode : "", "timeout");

    pass("图片并发队列：并发 4 上限 / 9 图与 12 图在 180s（虚拟时钟）内全部结算、旧 90s 对照成立 / 预算到期不再启动新图 / 迟到写入被令牌阻断 / 无未处理 rejection");
  }

  // --- 场景 3：suppressAttach 单元测试（内存行程，不落盘不触网） ---
  {
    const trip: Trip = {
      tripId: "unit-b2-trip",
      schemaVersion: SCHEMA_VERSION,
      version: 1,
      destination: { city: "三亚", cityCode: null },
      dateRange: { start: "2026-10-01", end: "2026-10-02", nights: 1 },
      dayRefs: ["day_1"],
      days: {
        day_1: {
          dayId: "day_1",
          dayIndex: 1,
          date: "2026-10-01",
          departTime: null,
          departTimeOverridden: false,
          scheduleVisitRefs: [],
          lodging: null,
        },
      },
      lodgings: {},
      hotelRegistry: {},
      itemRegistry: {},
      visits: {
        visit_ut: {
          visitId: "visit_ut",
          dayRef: null,
          pointRef: "item_wzz_ut",
          kind: "large_attraction",
          visitMode: "full_day",
          order: null,
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
          purchaseState: "unknown",
          locked: false,
          userAdjusted: false,
          removedFrom: null,
          removedAt: null,
        },
      },
      stops: {},
      evidences: {},
      globalCandidateRefs: [],
      pendingStopRefs: [],
      relationshipSuggestions: {},
      constraints: [],
      createdAt: "2026-10-15T00:00:00.000Z",
      updatedAt: "2026-10-15T00:00:00.000Z",
    };
    const parentVisit = trip.visits.visit_ut;

    const suppressed = ensureStopAndPlace(
      trip,
      mkEntry("海上滑索", "in_attraction", "high", "蜈支洲岛"),
      mkItem("海上滑索"),
      "ev_ut",
      "m1",
      parentVisit,
      { suppressAttach: true },
    );
    assert.equal(suppressed.created, true);
    assert.equal(suppressed.stop.state, "pending", "suppressAttach：high 置信也不自动挂入");
    assert.ok(trip.pendingStopRefs.includes(suppressed.stop.stopId), "应进待定区");
    assert.equal(parentVisit.childStopRefs.length, 0, "所属 Visit 不得被后台装配改动");
    const suggestion = trip.relationshipSuggestions[suppressed.stop.stopId];
    assert.equal(suggestion.level, "high");
    assert.equal(suggestion.suggestedVisitRef, parentVisit.visitId, "保留建议归属供用户确认");
    assert.ok(
      suggestion.positiveSignals.some((signal) => signal.includes("后台装配不自动挂入")),
      "positiveSignals 应注明后台装配语义",
    );
    pass("suppressAttach 单元：high 后台装配 → pending + 建议归属，不改已生成行程");
  }

  // --- 场景 4：文字来源（两秒提交 → ready → 候选池兼容 → 去重 → 重试拒绝） ---
  const tripText = await createFixtureSanyaTrip();
  createdTripIds.push(tripText.tripId);
  {
    const loaded0 = await loadTrip(tripText.tripId);
    const scheduleBefore = JSON.stringify(loaded0.days);
    const stopCountBefore = Object.keys(loaded0.stops).length;
    const visitCountBefore = Object.keys(loaded0.visits).length;
    const pendingBefore = loaded0.pendingStopRefs.length;

    // 全部选用 fixture 已有 fliggy 精确名：findExistingFliggyItem 命中即跳过 FlyAI 搜索（离线）
    stubEntries = [
      mkEntry("蜈支洲岛", "attraction", "medium"),
      mkEntry("情人桥", "in_attraction", "high", "蜈支洲岛"),
    ];

    const started = Date.now();
    const res = await requestJson(`/trips/${tripText.tripId}/sources`, "POST", {
      inputKind: "text",
      text: "三亚攻略（桩正文）：Day2 去蜈支洲岛，上岛先走情人桥，下午去观日岩看海。",
    });
    const elapsed = Date.now() - started;
    assert.equal(res.status, 200, `提交应 200（实际 ${res.status}：${JSON.stringify(res.body)}）`);
    assert.ok(elapsed < 2_000, `提交应在两秒内返回（实际 ${elapsed}ms）`);
    const sourceId = res.body.sourceId as string;
    assert.ok(sourceId.startsWith("src_"), `sourceId 应 src_ 前缀（实际 ${sourceId}）`);
    assert.equal(res.body.status, "processing");
    assert.equal(res.body.duplicate, false);

    const settled = await waitSettled(tripText.tripId, sourceId);
    assert.equal(settled.status, "ready", "正文成功且无图片应 ready");
    assert.equal(settled.coverageText, "正文");
    assert.equal(settled.imageProgress.total, 0);

    const trip = await loadTrip(tripText.tripId);
    const source = sourceOf(trip, sourceId);
    const noteEvidenceIds = source.evidenceRefs.filter((id) => trip.evidences[id]?.kind === "note_text");
    assert.equal(noteEvidenceIds.length, 1, "应恰好一条正文证据");
    const noteEvidence = trip.evidences[noteEvidenceIds[0]];
    assert.ok(noteEvidence.mentions.length >= 2, "正文证据应含情人桥 / 观日岩 mention");
    assert.equal(source.mentionRefs.length, noteEvidence.mentions.length);
    for (const ref of source.mentionRefs) {
      assert.ok(parseMentionRef(ref) !== null, `mentionRef ${ref} 应可解析`);
    }

    // 候选池兼容：蜈支洲岛 Visit 壳与情人桥 attached stop 全部复用（零重建、零改排）
    assert.equal(Object.keys(trip.stops).length, stopCountBefore, "复用既有实体，不重建 stop");
    assert.equal(Object.keys(trip.visits).length, visitCountBefore, "复用既有 Visit 壳，不重建壳");
    assert.equal(trip.pendingStopRefs.length, pendingBefore, "后台装配不应新增待定 stop");
    assert.equal(JSON.stringify(trip.days), scheduleBefore, "已生成行程（日程）零改动");
    const bridgeStops = Object.values(trip.stops).filter((stop) => stop.matchedPointRef === "item_bridge");
    assert.equal(bridgeStops.length, 1, "情人桥既有 attached stop 应唯一");
    assert.ok(
      bridgeStops[0].sourceMentionRefs.some((ref) => ref.startsWith(`${noteEvidenceIds[0]}:`)),
      "复用 stop 应追加新证据的 mention 引用（候选池证据链兼容）",
    );
    assert.equal(bridgeStops[0].state, "attached", "复用不得改动已挂入状态");

    // ready 来源重试 → SOURCE_NOT_RETRYABLE
    const retryReady = await requestJson(`/trips/${tripText.tripId}/sources/${sourceId}/retry`, "POST");
    assert.equal(retryReady.status, 400);
    assert.equal(retryReady.body.code, "SOURCE_NOT_RETRYABLE");

    // 同正文重复提交 → 命中缓存
    const dup = await requestJson(`/trips/${tripText.tripId}/sources`, "POST", {
      inputKind: "text",
      text: "三亚攻略（桩正文）：Day2 去蜈支洲岛，上岛先走情人桥，下午去观日岩看海。",
    });
    assert.equal(dup.status, 200);
    assert.equal(dup.body.duplicate, true, "contentHash 相同应命中");
    assert.equal(dup.body.sourceId, sourceId);
    pass("文字来源：两秒提交 → ready；正文证据 / mentionRefs / 候选池兼容；日程零改动；去重命中；ready 不可重试(400)");
  }

  // --- 场景 5：攻略补充句 ---
  {
    const draftPath = `/trips/${tripText.tripId}/draft-note`;
    const saved = await requestJson(draftPath, "PUT", { note: "带老人出游，节奏放慢" });
    assert.equal(saved.status, 200);
    assert.equal((await loadTrip(tripText.tripId)).guideDraftNote, "带老人出游，节奏放慢");

    const cleared = await requestJson(draftPath, "PUT", { note: "" });
    assert.equal(cleared.status, 200);
    assert.ok((await loadTrip(tripText.tripId)).guideDraftNote === undefined, "空串应清除补充句");

    const tooLong = await requestJson(draftPath, "PUT", { note: "长".repeat(501) });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.code, "INVALID_REQUEST");

    const rawBad = await guideRoutes.request(draftPath, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    assert.equal(rawBad.status, 400);

    const badType = await requestJson(draftPath, "PUT", { note: 123 });
    assert.equal(badType.status, 400);
    pass("攻略补充句：保存 / 空串清除 / 超长 400 / 非法 JSON 400 / 非法类型 400");
  }

  // --- 场景 6：链接来源全流程（12 图、图 6 审核拒绝 → partial） ---
  const tripLink = await createFixtureSanyaTrip();
  createdTripIds.push(tripLink.tripId);
  const linkSourceId = await (async () => {
    const loaded0 = await loadTrip(tripLink.tripId);
    const scheduleBefore = JSON.stringify(loaded0.days);

    stubNote = {
      success: true,
      title: "蜈支洲岛 12 图游记（桩）",
      text: "上岛先走情人桥（桩正文）",
      images: Array.from({ length: 12 }, (_, i) => `/api/uploads/xhs_6ace31c6000000001b0202f7/${i + 1}.jpg`),
      sourceUrl: "https://www.xiaohongshu.com/explore/b2link01",
    };
    stubEntries = [mkEntry("情人桥", "attraction", "medium")];
    stubImageFailures.clear();
    stubImageFailures.set(6, new AiError("IMAGE_REJECTED", "图片未通过 AI 平台内容审核"));

    const started = Date.now();
    const res = await requestJson(`/trips/${tripLink.tripId}/sources`, "POST", {
      inputKind: "link",
      url: "http://xhslink.com/b2link01",
    });
    const elapsed = Date.now() - started;
    assert.equal(res.status, 200, `链接提交应 200（实际 ${res.status}：${JSON.stringify(res.body)}）`);
    assert.ok(elapsed < 2_000, `链接提交应在两秒内返回（实际 ${elapsed}ms，抓取在后台）`);
    assert.equal(res.body.status, "processing");
    const sourceId = res.body.sourceId as string;

    const settledDeferred = await waitSettled(tripLink.tripId, sourceId);
    // Task #215：图片默认不解析——提交后延迟结算 ready，全部图 pending 待手动触发
    assert.equal(settledDeferred.status, "ready", "正文可用 + 图片待解析 → 延迟结算 ready（不落 failed）");
    assert.equal(settledDeferred.imageOcrDeferred, true, "应标记延迟解析");
    assert.equal(settledDeferred.coverageText, "正文 + 12张图片待解析");
    assert.equal(settledDeferred.imageProgress.completed, 0, "提交后不应有图片识别完成");

    // 手动触发「解析图片」→ 12 图并发队列（图 6 桩拒绝）
    const trigger = await requestJson(`/trips/${tripLink.tripId}/sources/${sourceId}/ocr-images`, "POST");
    assert.equal(trigger.status, 200, `触发解析应 200（实际 ${trigger.status}：${JSON.stringify(trigger.body)}）`);
    const settled = await waitSettled(tripLink.tripId, sourceId);
    assert.equal(settled.status, "partial", "图 6 被拒 → partial，其余图保留");
    assert.ok((settled.failureMessage ?? "").includes("1/12"), `failureMessage 应说明失败比例（实际 ${settled.failureMessage}）`);
    assert.equal(settled.coverageText, "正文 + 11/12张图");
    assert.equal(settled.imageProgress.total, 12);
    assert.equal(settled.imageProgress.completed, 11);
    assert.equal(settled.imageProgress.failed, 1);

    const trip = await loadTrip(tripLink.tripId);
    const source = sourceOf(trip, sourceId);
    assert.equal(source.evidenceRefs.length, 13, "12 图证据（含拒绝空证据）+ 1 正文");

    const entry6 = source.imageProgress.images.find((entry) => entry.index === 6);
    assert.ok(entry6 !== undefined);
    assert.equal(entry6.status, "failed");
    assert.equal(entry6.failureCode, "rejected", "审核拒绝应记具体 failureCode");
    assert.ok(entry6.evidenceId !== null, "拒绝图也建空证据保留重试入口");
    const ev6 = trip.evidences[entry6.evidenceId as string];
    assert.ok(ev6 !== undefined);
    assert.equal(ev6.ocrText, null);
    assert.ok((ev6.assetPath ?? "").includes("xhs_"), "原图路径保留供回看 / 重试");

    for (const entry of source.imageProgress.images) {
      if (entry.index === 6) continue;
      assert.equal(entry.status, "ready", `图 ${entry.index} 应 ready`);
      const evidence = trip.evidences[entry.evidenceId as string];
      assert.ok(evidence !== undefined, `图 ${entry.index} 证据应存在`);
      assert.ok((evidence.ocrText ?? "") !== "", `图 ${entry.index} 证据应有 OCR 文本`);
      assert.ok(evidence.assetPath !== null);
    }
    assert.equal(JSON.stringify(trip.days), scheduleBefore, "后台图片装配不得改动已生成行程");
    assert.ok(source.sourceVersion >= 14, `sourceVersion 应随每图写盘递增（实际 ${source.sourceVersion}）`);
    assert.equal(stubFetchCalls, 1, "首次提交抓取一次");
    return sourceId;
  })();
  pass("链接来源全流程：两秒提交 → 正文先落 → 延迟结算（Task #215）→ 手动触发 → 12 图并发队列 → 图 6 被拒 partial、11 图证据保留；coverageText=正文 + 11/12张图");

  // --- 场景 7：链接去重（分享参数变体命中缓存，不重抓） ---
  {
    const fetchBefore = stubFetchCalls;
    const dup = await requestJson(`/trips/${tripLink.tripId}/sources`, "POST", {
      inputKind: "link",
      url: "http://xhslink.com/b2link01?xsec_token=abc123&share_id=xyz&utm_source=ios",
    });
    assert.equal(dup.status, 200);
    assert.equal(dup.body.duplicate, true, "分享参数变体应命中 canonicalUrl 去重");
    assert.equal(dup.body.sourceId, linkSourceId);
    assert.equal(stubFetchCalls, fetchBefore, "去重命中不得重新抓取");
    pass("链接去重：xsec_token / share_id / utm 变体命中缓存，不重抓不重计数");
  }

  // --- 场景 8：重启恢复 → 重试只跑失败图 → 原位升级；pendingGuideDraft 保留 ---
  {
    const tripId = tripLink.tripId;
    // 手动模拟服务重启：processing + 无活跃 job（脚本进程内注册表自然为空）
    const trip = await loadTrip(tripId);
    const source = sourceOf(trip, linkSourceId);
    const draft: PendingGuideDraft = {
      draftId: "draft_b2_verify",
      baseTripVersion: trip.version,
      scope: { kind: "trip" },
      sourceSnapshots: [{ sourceId: linkSourceId, sourceVersion: source.sourceVersion }],
      mentionIds: [],
      note: null,
      createdAt: new Date().toISOString(),
    };
    trip.pendingGuideDraft = draft;
    source.status = "processing";
    const entry6 = source.imageProgress.images.find((entry) => entry.index === 6);
    assert.ok(entry6 !== undefined);
    entry6.status = "pending";
    delete entry6.failureCode;
    delete entry6.failureMessage;
    source.imageProgress.failed = 0;
    await tripStore.save(trip);

    // 列表读取触发重启恢复扫描
    const listRes = await requestJson(`/trips/${tripId}/sources`, "GET");
    assert.equal(listRes.status, 200);
    const recovered = (listRes.body.sources as GuideSource[]).find((s) => s.sourceId === linkSourceId);
    assert.ok(recovered !== undefined);
    assert.equal(recovered.status, "partial", "重启遗留 processing 应转 partial（不自动重跑百炼）");
    const recovered6 = recovered.imageProgress.images.find((entry) => entry.index === 6);
    assert.ok(recovered6 !== undefined);
    assert.equal(recovered6.status, "failed");
    assert.equal(recovered6.failureCode, "timeout");
    assert.ok((recovered6.failureMessage ?? "").includes("重启"), "应提示可重试");

    const tripAfterRecover = await loadTrip(tripId);
    const sourceAfterRecover = sourceOf(tripAfterRecover, linkSourceId);
    assert.equal(sourceAfterRecover.imageProgress.completed, 11, "重启恢复保留全部成功证据");
    assert.equal(sourceAfterRecover.evidenceRefs.length, 13, "证据引用不因恢复丢失");
    assert.ok(tripAfterRecover.pendingGuideDraft !== undefined, "恢复不得删除 pendingGuideDraft");

    // 重试：只跑图 6（不重复 11 张已完成图）
    stubImageFailures.clear();
    const recognizeBeforeRetry = stubRecognizeIndexes.length;
    const retry = await requestJson(`/trips/${tripId}/sources/${linkSourceId}/retry`, "POST");
    assert.equal(retry.status, 200);
    assert.equal((retry.body.source as GuideSource).status, "processing");
    const settledRetry = await waitSettled(tripId, linkSourceId);
    const retriedIndexes = stubRecognizeIndexes.slice(recognizeBeforeRetry);
    assert.deepEqual(
      retriedIndexes,
      [6],
      `重试只应识别失败图（实际识别：${retriedIndexes.join(",") || "无"}）`,
    );
    assert.equal(settledRetry.status, "ready", "图 6 重试成功 → 来源 ready");
    const final6 = settledRetry.imageProgress.images.find((entry) => entry.index === 6);
    assert.ok(final6 !== undefined);
    assert.equal(final6.status, "ready");
    assert.equal(final6.evidenceId, entry6.evidenceId, "空证据原位升级：证据 ID 不变");
    const tripFinal = await loadTrip(tripId);
    const evFinal6 = tripFinal.evidences[final6.evidenceId as string];
    assert.ok((evFinal6.ocrText ?? "") !== "", "原位升级后证据应携带 OCR 文本");

    // pendingGuideDraft 保留 + sourceVersion 变化使旧快照过期（支撑「发现新的攻略细节」）
    assert.ok(tripFinal.pendingGuideDraft !== undefined, "重试不得删除 pendingGuideDraft");
    const freshness = checkPendingGuideDraftFreshness(
      tripFinal.pendingGuideDraft as PendingGuideDraft,
      tripFinal,
    );
    assert.ok(
      freshness.reasons.includes("source_version_changed"),
      `来源版本变化应使旧草案过期（reasons：${freshness.reasons.join(",")}）`,
    );
    assert.ok(
      sourceOf(tripFinal, linkSourceId).sourceVersion > draft.sourceSnapshots[0].sourceVersion,
      "重试应递增 sourceVersion",
    );
    pass("重启恢复：processing → partial（证据保留、未完成图标 timeout 可重试）；重试只跑图 6 → ready 原位升级；pendingGuideDraft 保留且 source_version_changed 过期");
  }

  // --- 场景 9：软移除 / 恢复 ---
  {
    const tripId = tripLink.tripId;
    const evidenceCountBefore = Object.keys((await loadTrip(tripId)).evidences).length;

    const remove = await requestJson(`/trips/${tripId}/sources/${linkSourceId}/remove`, "POST");
    assert.equal(remove.status, 200);
    const removed = remove.body.source as GuideSource;
    assert.equal(removed.active, false);
    assert.ok(typeof removed.removedAt === "string", "移除应记录 removedAt");

    const tripRemoved = await loadTrip(tripId);
    assert.equal(Object.keys(tripRemoved.evidences).length, evidenceCountBefore, "移除不删除 evidence 原始数据");
    const removedSource = sourceOf(tripRemoved, linkSourceId);
    assert.equal(removedSource.active, false);
    assert.equal(isGuideSourceUsable(tripRemoved, removedSource), false, "移除后重新排版不再使用");

    const restore = await requestJson(`/trips/${tripId}/sources/${linkSourceId}/restore`, "POST");
    assert.equal(restore.status, 200);
    const restored = restore.body.source as GuideSource;
    assert.equal(restored.active, true);
    assert.ok(restored.removedAt === undefined, "恢复应清除 removedAt");
    const restoreAgain = await requestJson(`/trips/${tripId}/sources/${linkSourceId}/restore`, "POST");
    assert.equal(restoreAgain.status, 200, "恢复幂等");
    pass("软移除 / 恢复：active=false + removedAt；evidence 原样保留；isGuideSourceUsable=false；恢复幂等");
  }

  // --- 场景 10：抓取失败 → failed(blocked)；同链接重新提交重跑 ---
  const tripFail = await createFixtureSanyaTrip();
  createdTripIds.push(tripFail.tripId);
  {
    stubNote = {
      success: true,
      title: "重跑验证（桩）",
      text: "重跑正文（桩）",
      images: ["/api/uploads/xhs_6ace31c6000000001b0202f7/1.jpg", "/api/uploads/xhs_6ace31c6000000001b0202f7/2.jpg"],
      sourceUrl: "https://www.xiaohongshu.com/explore/b2fail01",
    };
    stubImageFailures.clear();
    stubFetchError = new XhsError("检测到登录墙：该笔记需要登录后才能查看");

    const res = await requestJson(`/trips/${tripFail.tripId}/sources`, "POST", {
      inputKind: "link",
      url: "http://xhslink.com/b2fail01",
    });
    assert.equal(res.status, 200);
    const firstSettled = await waitSettled(tripFail.tripId, res.body.sourceId as string);
    assert.equal(firstSettled.status, "failed", "登录墙拦截 → failed");
    assert.equal(firstSettled.failureCode, "blocked");
    assert.deepEqual(firstSettled.evidenceRefs, []);

    // 同链接重新提交：failed 无成果可复用 → 视为重新导入（duplicate=true + 重跑）
    stubFetchError = null;
    const fetchBefore = stubFetchCalls;
    const res2 = await requestJson(`/trips/${tripFail.tripId}/sources`, "POST", {
      inputKind: "link",
      url: "http://xhslink.com/b2fail01",
    });
    assert.equal(res2.status, 200);
    assert.equal(res2.body.duplicate, true, "failed 来源重新提交标记 duplicate（同 sourceId 重跑）");
    assert.equal(res2.body.sourceId, res.body.sourceId);
    assert.equal(res2.body.status, "processing");
    assert.equal(stubFetchCalls, fetchBefore + 1, "重跑应重新抓取");
    const secondSettled = await waitSettled(tripFail.tripId, res.body.sourceId as string);
    assert.equal(secondSettled.status, "ready", "重跑成功（2 图 + 正文全部成功）");
    assert.ok(secondSettled.sourceVersion > firstSettled.sourceVersion, "重跑递增 sourceVersion");
    pass("抓取失败：登录墙 → failed(blocked)；同链接重新提交视为重跑 → ready");
  }

  // --- 场景 11：处理中重试 409 + multipart 原图落盘 ---
  const tripBusy = await createFixtureSanyaTrip();
  createdTripIds.push(tripBusy.tripId);
  {
    const releases: Array<() => void> = [];
    stubImageGate = (index) =>
      new Promise((resolve) => {
        releases.push(() => resolve({ ocrText: `【桩】gate 图 ${index}`, mentions: [] }));
      });

    const form = new FormData();
    for (let i = 1; i <= 3; i++) {
      form.append("images", new File([pngBytes(64 + i)], `gate-${i}.png`, { type: "image/png" }));
    }
    const res = await requestForm(`/trips/${tripBusy.tripId}/sources`, form);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "processing");
    const sourceId = res.body.sourceId as string;

    // Task #215：提交后不自动识别——延迟结算 ready，挂起桩零调用；
    // multipart 原图提交即落盘，进度明细已带受控 assetPath
    const deferred = await waitSettled(tripBusy.tripId, sourceId);
    assert.equal(deferred.status, "ready", "纯图待解析 → 延迟结算 ready");
    assert.equal(deferred.imageOcrDeferred, true);
    assert.equal(releases.length, 0, "提交后不应有任何识别调用");
    for (const entry of deferred.imageProgress.images) {
      assert.ok(
        (entry.assetPath ?? "").startsWith(`uploads/${tripBusy.tripId}/ev_shot_`),
        `提交即落盘：进度明细应带受控 assetPath（实际 ${entry.assetPath}）`,
      );
    }

    // 手动触发解析：3 张图并发起跑（挂起桩拦截）
    const trigger = await requestJson(`/trips/${tripBusy.tripId}/sources/${sourceId}/ocr-images`, "POST");
    assert.equal(trigger.status, 200, `触发解析应 200（实际 ${trigger.status}）`);

    const gateDeadline = Date.now() + 5_000;
    while (releases.length < 3) {
      if (Date.now() > gateDeadline) throw new Error("挂起桩未被调用满 3 次（3 张图应同时起跑）");
      await sleep(20);
    }
    const busy = await requestJson(`/trips/${tripBusy.tripId}/sources/${sourceId}/retry`, "POST");
    assert.equal(busy.status, 409);
    assert.equal(busy.body.code, "SOURCE_BUSY", "解析处理中 retry 应 409");

    stubImageGate = null;
    for (const release of releases.splice(0)) release();
    const settled = await waitSettled(tripBusy.tripId, sourceId);
    assert.equal(settled.status, "ready", "3 张图全部成功 → ready");

    // multipart 原图落盘受控目录（uploads/{tripId}/ev_shot_*.png）
    const trip = await loadTrip(tripBusy.tripId);
    for (const entry of settled.imageProgress.images) {
      const evidence = trip.evidences[entry.evidenceId as string];
      assert.ok(evidence !== undefined);
      const assetPath = evidence.assetPath as string;
      assert.ok(
        assetPath.startsWith(`uploads/${tripBusy.tripId}/ev_shot_`),
        `原图应落盘行程受控目录（实际 ${assetPath}）`,
      );
      await fs.access(path.join(UPLOADS_DIR, assetPath.slice("uploads/".length)));
    }
    pass("处理中 retry 409 SOURCE_BUSY；multipart 提交即落盘（明细 assetPath）；触发解析并发挂起；释放后 ready");
  }

  console.log("\n[verify] 离线段（桩注入状态机 + 契约）全部通过 ✓");
}

// ===== 段二：真实百炼段（触网） =====

async function runLiveScenario(): Promise<void> {
  resetGuideServiceDeps();
  collectedLogs.length = 0;

  const tripLive = await createFixtureSanyaTrip();
  createdTripIds.push(tripLive.tripId);
  const loaded0 = await loadTrip(tripLive.tripId);
  const scheduleBefore = JSON.stringify(loaded0.days);

  const liveIndexes = [1, 3, 6];
  const form = new FormData();
  for (const index of liveIndexes) {
    const raw = await fs.readFile(path.join(UPLOADS_DIR, "xhs_6ace31c6000000001b0202f7", `${index}.jpg`));
    const bytes = new Uint8Array(new ArrayBuffer(raw.byteLength));
    bytes.set(raw);
    assert.ok(bytes.length > 0, `缓存图 ${index}.jpg 应存在`);
    assert.ok(bytes.length <= 10 * 1024 * 1024, `缓存图 ${index}.jpg 应在 10MB 内`);
    form.append("images", new File([bytes], `live-${index}.jpg`, { type: "image/jpeg" }));
  }

  console.log("[verify] 真实百炼段：提交 3 张现有小红书缓存图（并发 4 / 总预算 180s / 单图 120s），预计 30-150s…");
  const started = Date.now();
  const res = await requestForm(`/trips/${tripLive.tripId}/sources`, form);
  assert.equal(res.status, 200, `真实提交应 200（实际 ${res.status}：${JSON.stringify(res.body)}）`);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2_000, `真实提交应在两秒内返回（实际 ${elapsed}ms，识别在后台）`);
  assert.equal(res.body.status, "processing");
  const sourceId = res.body.sourceId as string;

  const deferred = await waitSettled(tripLive.tripId, sourceId, 150_000);
  console.log(
    `[verify] 真实提交延迟结算：${deferred.status}（${deferred.coverageText ?? ""}，耗时 ${Math.round((Date.now() - started) / 1000)}s）`,
  );
  assert.equal(deferred.imageOcrDeferred, true, "Task #215：真实段提交后应延迟结算");
  assert.equal(deferred.imageProgress.completed, 0, "真实段提交后不应自动识别");

  // Task #215：手动触发解析（真实百炼 OCR）
  const trigger = await requestJson(`/trips/${tripLive.tripId}/sources/${sourceId}/ocr-images`, "POST");
  assert.equal(trigger.status, 200, `触发解析应 200（实际 ${trigger.status}）`);
  const settled = await waitSettled(tripLive.tripId, sourceId, 150_000);
  console.log(
    `[verify] 真实来源终态：${settled.status}（${settled.coverageText ?? ""}，耗时 ${Math.round((Date.now() - started) / 1000)}s）`,
  );

  const trip = await loadTrip(tripLive.tripId);
  const source = sourceOf(trip, sourceId);
  assert.equal(source.imageProgress.total, liveIndexes.length);

  let readyCount = 0;
  for (const entry of source.imageProgress.images) {
    if (entry.status === "ready") {
      readyCount += 1;
      const evidence = trip.evidences[entry.evidenceId as string];
      assert.ok(evidence !== undefined, `图 ${entry.index} 证据应落盘`);
      assert.ok(evidence.assetPath !== null, `图 ${entry.index} 原图应落盘受控目录`);
      const hasContent = (evidence.ocrText ?? "") !== "" || evidence.mentions.length > 0;
      assert.ok(hasContent, `图 ${entry.index} 真实识别应有内容（ocrText / mentions）`);
      console.log(
        `[verify]   图 ${entry.index}: ready（ocrText ${(evidence.ocrText ?? "").length} 字，mentions ${evidence.mentions.length} 条）`,
      );
    } else {
      assert.equal(entry.status, "failed", `图 ${entry.index} 应为确定终态`);
      assert.ok(entry.failureCode !== undefined, `失败图 ${entry.index} 必须带具体 failureCode`);
      console.log(`[verify]   图 ${entry.index}: failed（${entry.failureCode}：${entry.failureMessage}）`);
    }
  }
  assert.ok(readyCount >= 1, "真实缓存图至少一张识别成功");
  if (readyCount > 0 && readyCount < liveIndexes.length) {
    assert.equal(settled.status, "partial", "部分图失败 → partial，成功图保留");
  }
  assert.equal(JSON.stringify(trip.days), scheduleBefore, "真实后台装配不得改动已生成行程（suppressAttach）");

  // 隐私：百炼远端文件识别完即删（finally 必删生效）
  const fileIds = [
    ...new Set(collectedLogs.join("\n").match(/fileId=([\w-]+)/g)?.map((m) => m.slice("fileId=".length)) ?? []),
  ];
  assert.ok(fileIds.length > 0, "应能从日志提取上传的 fileId");
  for (const fileId of fileIds) {
    await assert.rejects(
      () => getBailianFile(fileId),
      (error: unknown) => error instanceof Error,
      `百炼文件 ${fileId} 应已删除（查询 404）`,
    );
  }
  pass(`真实百炼段：${settled.status}（ready ${readyCount}/${liveIndexes.length}）；${fileIds.length} 个百炼文件识别完即删；行程零改动`);
}

main().catch((error: unknown) => {
  console.error("[verify] 失败：", error instanceof AiError ? `${error.code} ${error.message}` : error);
  process.exitCode = 1;
});
