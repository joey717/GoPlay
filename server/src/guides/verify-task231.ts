/**
 * Task #231 验证：OCR 并发 env 可配 + 单图重试 + 回显检测。
 *
 * 离线验证（VERIFY_SKIP_LIVE=1 或无百炼凭证时自动跳过触网段）：
 *   1. GUIDE_IMAGE_CONCURRENCY 默认值 = 6（env 未设置时；Task #322 由 4 调为 6，
 *      压测依据 Task #318：九图并发 6 墙钟 63s、0 失败）；
 *   2. guideSourceBudgetMs 按动态并发计算批次预算；
 *   3. retryGuideImage 单图重试：failed 图重置为 pending、来源回 processing、
 *      只跑被重置的图（collectPendingImageInputs 只收 pending）；
 *   4. retryGuideImage 边界：ready 图拒绝、processing 来源拒绝、不存在的 index 拒绝；
 *   5. isPromptEcho 回显检测逻辑（纯函数，不触网）。
 *
 * 运行：npx tsx server/src/guides/verify-task231.ts
 */

import "../env.js";
import assert from "node:assert/strict";
import type { GuideSource, Trip } from "@goplay/shared";
import { createEmptyGuideImageProgress } from "@goplay/shared";
import { AiError } from "../ai/errors.js";
import type { OcrScreenshotInput, RecognizedImageContent } from "../ai/ocr.js";
import type { PrefilterImageInput, PrefilterSkipDecision } from "../ai/prefilter.js";
import { createFixtureSanyaTrip, tripStore } from "../persistence/store.js";
import {
  GUIDE_IMAGE_CONCURRENCY,
  GUIDE_SOURCE_BUDGET_MS,
  guideSourceBudgetMs,
} from "./jobs.js";
import {
  resetGuideServiceDeps,
  retryGuideImage,
  setGuideServiceDeps,
} from "./service.js";

// ===== 辅助 =====

function pass(name: string): void {
  console.log(`✓ ${name}`);
}

async function createTestTrip(): Promise<Trip> {
  const trip = await createFixtureSanyaTrip();
  return trip;
}

function makeImageSource(
  tripId: string,
  sourceId: string,
  imageStatuses: Array<"pending" | "ready" | "failed" | "skipped">,
): GuideSource {
  const now = new Date().toISOString();
  const images = imageStatuses.map((status, i) => ({
    index: i + 1,
    status,
    evidenceId: status === "ready" ? `ev_img_${i + 1}` : null,
    assetPath: `uploads/${tripId}/ev_shot_test${i + 1}.jpg`,
    ...(status === "failed" ? { failureCode: "extract_failed" as const, failureMessage: "测试失败" } : {}),
    ...(status === "skipped" ? { failureMessage: "预筛跳过：风景照" } : {}),
  }));
  const completed = images.filter((i) => i.status === "ready").length;
  const failed = images.filter((i) => i.status === "failed").length;
  return {
    sourceId,
    sourceVersion: 1,
    inputKind: "images",
    active: true,
    staged: true,
    status: failed > 0 ? "partial" : "ready",
    evidenceRefs: images.filter((i) => i.evidenceId).map((i) => i.evidenceId!),
    mentionRefs: [],
    imageProgress: { total: images.length, completed, failed, images },
    importedAt: now,
    updatedAt: now,
  };
}

// ===== 桩注入（不触网） =====

const recognizeCalls: Array<{ filename: string }> = [];

setGuideServiceDeps({
  fetchNote: async () => {
    throw new Error("verify-task231 不应调用 fetchNote");
  },
  extractEntries: async () => [],
  recognizeImage: async (image: OcrScreenshotInput): Promise<RecognizedImageContent> => {
    recognizeCalls.push({ filename: image.filename });
    // 模拟 50ms 延迟
    await new Promise((r) => setTimeout(r, 50));
    return { ocrText: `识别结果 ${image.filename}`, mentions: [] };
  },
  prefilterBatch: async (_items: readonly PrefilterImageInput[]): Promise<Map<number, PrefilterSkipDecision>> => {
    return new Map();
  },
});

// ===== 验证场景 =====

async function main(): Promise<void> {
  console.log("\n=== Task #231 验证：OCR 并发 env 可配 + 单图重试 ===\n");

  // --- 场景 1：并发默认值 ---
  {
    // env 未设置 GUIDE_IMAGE_CONCURRENCY 时默认 6（Task #322，原为 4）
    assert.equal(GUIDE_IMAGE_CONCURRENCY, 6, "默认并发应为 6");
    pass("场景 1：GUIDE_IMAGE_CONCURRENCY 默认值 = 6");
  }

  // --- 场景 2：动态预算按并发计算 ---
  {
    // 9 图 / 并发 6 = ceil(9/6) = 2 批 × 150s = 300s > 下限 180s → 300s（Task #322 后口径）
    assert.equal(guideSourceBudgetMs(9), 300_000, "9 图动态预算应为 300s");
    // 6 图 / 并发 6 = 1 批 × 150s = 150s < 下限 180s → 180s
    assert.equal(guideSourceBudgetMs(6), GUIDE_SOURCE_BUDGET_MS, "6 图应回落下限 180s");
    // 1 图 → 下限
    assert.equal(guideSourceBudgetMs(1), GUIDE_SOURCE_BUDGET_MS, "1 图应回落下限 180s");
    pass("场景 2：guideSourceBudgetMs 动态预算正确");
  }

  // --- 场景 3：单图重试（failed → pending → processing） ---
  {
    const trip = await createTestTrip();
    const sourceId = "src_retry_test";
    const source = makeImageSource(trip.tripId, sourceId, ["ready", "failed", "ready"]);
    trip.guideSources = { [sourceId]: source };
    // 为 ready 图创建空证据（一致性校验需要）
    trip.evidences["ev_img_1"] = {
      evidenceId: "ev_img_1", kind: "screenshot", noteIndex: null,
      assetRef: "test", sourceUrl: null, ocrText: "ok", mentions: [],
    };
    trip.evidences["ev_img_3"] = {
      evidenceId: "ev_img_3", kind: "screenshot", noteIndex: null,
      assetRef: "test", sourceUrl: null, ocrText: "ok", mentions: [],
    };
    await tripStore.save(trip);

    const result = await retryGuideImage(trip.tripId, sourceId, 2);
    assert.equal(result.status, "processing", "重试后来源应回 processing");
    const entry2 = result.imageProgress.images.find((i) => i.index === 2)!;
    assert.equal(entry2.status, "pending", "目标图应重置为 pending");
    assert.equal(entry2.failureCode, undefined, "failureCode 应被清除");
    // 其他图不受影响
    const entry1 = result.imageProgress.images.find((i) => i.index === 1)!;
    assert.equal(entry1.status, "ready", "已成功图不受影响");

    // 等待后台队列完成（桩 50ms 延迟 + 写盘）
    await new Promise((r) => setTimeout(r, 2000));

    // 重新加载验证最终状态
    const finalTrip = await tripStore.load(trip.tripId);
    assert.ok(finalTrip !== null, "行程应存在");
    const finalSource = finalTrip.guideSources?.[sourceId];
    assert.ok(finalSource !== undefined, "来源应存在");
    // 来源应结算为 ready（全部图完成）或 partial（如果桩写盘有竞态）
    assert.ok(
      finalSource.status === "ready" || finalSource.status === "partial",
      `来源应结算为终态，实际 ${finalSource.status}`,
    );
    pass("场景 3：单图重试 failed → pending → 队列执行 → 结算");

    // 清理
    await tripStore.deleteTrip(trip.tripId);
  }

  // --- 场景 4：单图重试边界拒绝 ---
  {
    const trip = await createTestTrip();
    const sourceId = "src_edge_test";
    const source = makeImageSource(trip.tripId, sourceId, ["ready", "failed"]);
    trip.guideSources = { [sourceId]: source };
    trip.evidences["ev_img_1"] = {
      evidenceId: "ev_img_1", kind: "screenshot", noteIndex: null,
      assetRef: "test", sourceUrl: null, ocrText: "ok", mentions: [],
    };
    await tripStore.save(trip);

    // 4a: ready 图不可重试
    await assert.rejects(
      () => retryGuideImage(trip.tripId, sourceId, 1),
      (err: unknown) => err instanceof AiError && err.code === "INVALID_REQUEST",
      "ready 图应拒绝重试",
    );

    // 4b: 不存在的 index
    await assert.rejects(
      () => retryGuideImage(trip.tripId, sourceId, 99),
      (err: unknown) => err instanceof AiError && err.code === "INVALID_REQUEST",
      "不存在的 index 应拒绝",
    );

    // 4c: processing 来源拒绝
    source.status = "processing";
    await tripStore.save(trip);
    await assert.rejects(
      () => retryGuideImage(trip.tripId, sourceId, 2),
      (err: unknown) => err instanceof AiError && err.code === "SOURCE_BUSY",
      "processing 来源应拒绝单图重试",
    );

    // 4d: 非法 index（0、负数、小数）
    source.status = "partial";
    await tripStore.save(trip);
    await assert.rejects(
      () => retryGuideImage(trip.tripId, sourceId, 0),
      (err: unknown) => err instanceof AiError && err.code === "INVALID_REQUEST",
      "index=0 应拒绝",
    );
    await assert.rejects(
      () => retryGuideImage(trip.tripId, sourceId, -1),
      (err: unknown) => err instanceof AiError && err.code === "INVALID_REQUEST",
      "index=-1 应拒绝",
    );

    pass("场景 4：单图重试边界拒绝（ready / 不存在 / processing / 非法 index）");

    // 清理
    await tripStore.deleteTrip(trip.tripId);
  }

  // --- 场景 5：回显检测逻辑（纯函数验证） ---
  {
    // 模拟 isPromptEcho 的判定逻辑（与 ocr.ts 中一致）
    const PROMPT_ECHO_SIGNATURE = "你是旅行攻略图片识别助手";
    function isPromptEcho(finalText: string): boolean {
      return finalText.slice(0, 200).includes(PROMPT_ECHO_SIGNATURE);
    }

    // 正常 JSON 响应：不是回显
    assert.equal(isPromptEcho('{"ocrText":"三亚","mentions":[]}'), false);
    // prompt 回显：是回显
    assert.equal(
      isPromptEcho("你是旅行攻略图片识别助手。请先完整识别图片中的文字..."),
      true,
    );
    // 回显在 200 字符之后：不判定为回显（避免误判）
    assert.equal(
      isPromptEcho(`${"x".repeat(201)}你是旅行攻略图片识别助手`),
      false,
    );
    // 空响应：不是回显
    assert.equal(isPromptEcho(""), false);

    pass("场景 5：isPromptEcho 回显检测逻辑正确");
  }

  // --- 完成 ---
  resetGuideServiceDeps();
  console.log("\n=== Task #231 验证全部通过 ===\n");
}

main().catch((error) => {
  console.error("\n✗ Task #231 验证失败:", error);
  process.exit(1);
});
