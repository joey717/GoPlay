/**
 * Task #318 测量脚本：九图并发 6 压测 ＋ P1b 纯文字门禁非争用复测。
 *
 * 运行方式：npx tsx eval/tools/perf-task318.ts [nine|text|both]（默认 both）
 *
 * 注意：
 * - 脚本内设 process.env.GUIDE_IMAGE_CONCURRENCY="6" 后 import 服务端模块，
 *   确认 jobs.ts resolveImageConcurrency 读到 6（Task #322 后默认值已为 6，
 *   此处显式注入保留，确保测量口径不随 env 漂移）；
 * - 不改任何产品代码，不改默认并发常量，不停 dev server；
 * - 不碰 PD 行程 0a27f726-9c93-48e8-ab68-1d62e9bc685b；
 * - 遇限流立即停并记录。
 */

// ======= 环境变量注入（必须在 import 服务端模块之前） =======
process.env.GUIDE_IMAGE_CONCURRENCY = "6";

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../..");

// ======= 工具函数 =======
const PD_TRIP = "0a27f726-9c93-48e8-ab68-1d62e9bc685b";
const scratchTrips: string[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  // 动态 import 服务端模块（env 已加载、GUIDE_IMAGE_CONCURRENCY=6 已注入）
  await import("../../server/src/env.js");
  const { tripStore } = await import("../../server/src/persistence/store.js");
  const {
    submitGuideSource,
    triggerImageOcr,
    setGuideServiceDeps,
    resetGuideServiceDeps,
  } = await import("../../server/src/guides/service.js");
  const { GUIDE_IMAGE_CONCURRENCY } = await import("../../server/src/guides/jobs.js");

  // ======= 验证并发注入生效 =======
  console.log(`\n===== Task #318 测量脚本 =====`);
  console.log(`GUIDE_IMAGE_CONCURRENCY = ${GUIDE_IMAGE_CONCURRENCY}（期望 6）`);
  if (GUIDE_IMAGE_CONCURRENCY !== 6) {
    console.error("❌ 并发注入失败！终止测量。");
    process.exit(1);
  }
  console.log(`✓ 并发注入生效\n`);

  async function pollSourceUntilSettled(
    tripId: string,
    sourceId: string,
    timeoutMs = 600_000,
    intervalMs = 2_000,
  ): Promise<{ status: string; elapsedMs: number }> {
    const t0 = Date.now();
    for (;;) {
      await sleep(intervalMs);
      const trip = await tripStore.load(tripId);
      const source = trip?.guideSources?.[sourceId];
      if (!source) return { status: "not_found", elapsedMs: Date.now() - t0 };
      if (source.status !== "processing") {
        return { status: source.status, elapsedMs: Date.now() - t0 };
      }
      if (Date.now() - t0 > timeoutMs) {
        return { status: "timeout", elapsedMs: Date.now() - t0 };
      }
    }
  }

  // ======= Part A：九图并发 6 压测 =======
  async function runNineImageTest(): Promise<void> {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Part A：九图并发 6 压测`);
    console.log(`${"=".repeat(60)}\n`);

    // 读取 9 张本地缓存图片（xhs_6a93bde9000000002600105b = 亚龙湾热带天堂森林公园 9 图）
    const imageDir = path.join(ROOT, "server/uploads/xhs_6a93bde9000000002600105b");
    const imageFiles: string[] = [];
    for (let i = 1; i <= 9; i++) {
      imageFiles.push(path.join(imageDir, `${i}.jpg`));
    }
    for (const f of imageFiles) {
      try { await fs.access(f); } catch {
        console.error(`❌ 图片不存在：${f}`);
        return;
      }
    }
    console.log(`✓ 9 张图片就绪（亚龙湾热带天堂森林公园）`);

    // 创建 scratch 行程
    const trip = await tripStore.create({
      destination: { city: "三亚" },
      dateRange: { start: "2026-11-10", end: "2026-11-14", nights: 4 },
    });
    const tripId = trip.tripId;
    scratchTrips.push(tripId);
    console.log(`✓ scratch 行程创建：${tripId}`);

    // 读取图片字节
    const images = [];
    for (let i = 0; i < 9; i++) {
      const data = new Uint8Array(await fs.readFile(imageFiles[i]));
      images.push({ data, filename: `${i + 1}.jpg`, mimeType: "image/jpeg" });
    }

    // 提交图片来源（会 deferImageOcr）
    const submitResult = await submitGuideSource(tripId, {
      inputKind: "images",
      images,
      title: "Task #318 九图并发6压测（亚龙湾9图）",
    });
    const sourceId = submitResult.sourceId;
    console.log(`✓ 图片来源提交：${sourceId}，状态=${submitResult.status}`);

    // 等待来源结算（deferImageOcr → ready）
    const deferSettle = await pollSourceUntilSettled(tripId, sourceId, 30_000, 500);
    console.log(`✓ 延迟结算完成：status=${deferSettle.status}（${(deferSettle.elapsedMs / 1000).toFixed(1)}s）`);

    if (deferSettle.status !== "ready") {
      console.error(`❌ 延迟结算未达 ready，终止九图测试`);
      return;
    }

    // ======= 注入计时桩：包装 recognizeImage 记录单图耗时 =======
    const imageTimings: Array<{ index: number; startMs: number; endMs: number; success: boolean; error?: string }> = [];
    let imageCallIndex = 0;
    let activeCount = 0;
    let peakConcurrency = 0;
    let rateLimited = false;

    const { recognizeImageContent } = await import("../../server/src/ai/ocr.js");

    setGuideServiceDeps({
      recognizeImage: async (image, options) => {
        const idx = ++imageCallIndex;
        activeCount++;
        if (activeCount > peakConcurrency) peakConcurrency = activeCount;
        const startMs = Date.now();
        console.log(`  [OCR] 图 ${idx} 开始（当前并发 ${activeCount}）`);
        try {
          const result = await recognizeImageContent(image, options);
          const endMs = Date.now();
          imageTimings.push({ index: idx, startMs, endMs, success: true });
          console.log(`  [OCR] 图 ${idx} 完成 ✓（${((endMs - startMs) / 1000).toFixed(1)}s）`);
          return result;
        } catch (error: any) {
          const endMs = Date.now();
          const errMsg = error?.message ?? String(error);
          imageTimings.push({ index: idx, startMs, endMs, success: false, error: errMsg });
          console.log(`  [OCR] 图 ${idx} 失败 ✗（${((endMs - startMs) / 1000).toFixed(1)}s）：${errMsg.slice(0, 100)}`);
          if (errMsg.includes("rate") || errMsg.includes("limit") || errMsg.includes("throttl") || errMsg.includes("429")) {
            rateLimited = true;
            console.error(`\n🚨 检测到限流！错误：${errMsg}`);
          }
          throw error;
        } finally {
          activeCount--;
        }
      },
    });

    // 触发 OCR
    console.log(`\n--- 触发九图 OCR（并发=${GUIDE_IMAGE_CONCURRENCY}）---`);
    const ocrStartMs = Date.now();
    await triggerImageOcr(tripId, sourceId);

    // 轮询等待完成
    const ocrResult = await pollSourceUntilSettled(tripId, sourceId, 600_000, 3_000);
    const ocrWallMs = Date.now() - ocrStartMs;

    // 恢复默认依赖
    resetGuideServiceDeps();

    // ======= 输出九图结果 =======
    console.log(`\n${"-".repeat(50)}`);
    console.log(`九图并发 6 压测结果：`);
    console.log(`  墙钟总耗时：${(ocrWallMs / 1000).toFixed(1)}s`);
    console.log(`  终态：${ocrResult.status}`);
    console.log(`  并发实际峰值：${peakConcurrency}`);
    console.log(`  限流事件：${rateLimited ? "是 🚨" : "否 ✓"}`);

    if (imageTimings.length > 0) {
      const durations = imageTimings.map((t) => t.endMs - t.startMs).sort((a, b) => a - b);
      const p50 = durations[Math.floor(durations.length / 2)];
      const worst = durations[durations.length - 1];
      const best = durations[0];
      const failures = imageTimings.filter((t) => !t.success);
      console.log(`  单图 p50：${(p50 / 1000).toFixed(1)}s`);
      console.log(`  单图最坏：${(worst / 1000).toFixed(1)}s`);
      console.log(`  单图最好：${(best / 1000).toFixed(1)}s`);
      console.log(`  失败数：${failures.length}`);
      if (failures.length > 0) {
        for (const f of failures) {
          console.log(`    图 ${f.index}：${f.error?.slice(0, 120)}`);
        }
      }
      // 对照 #231 基线（4 并发 4 图 wall 61.7s → 单图均 15.4s → 9 图 4 并发理论 wall ≈ 3 批 × 15.4s ≈ 46.3s）
      // 但实测 9 图 4 并发基线参考 #94 记录（eval-report 无精确值，以 #231 单图均耗时推算）
      const perImageAvg = durations.reduce((s, d) => s + d, 0) / durations.length / 1000;
      const theoretical4Wall = Math.ceil(9 / 4) * perImageAvg; // 3 批 × 单图均耗时
      const theoretical6Wall = Math.ceil(9 / 6) * perImageAvg; // 2 批 × 单图均耗时
      console.log(`  单图均耗时：${perImageAvg.toFixed(1)}s`);
      console.log(`  理论 4 并发墙钟（3批×${perImageAvg.toFixed(1)}s）：${theoretical4Wall.toFixed(1)}s`);
      console.log(`  理论 6 并发墙钟（2批×${perImageAvg.toFixed(1)}s）：${theoretical6Wall.toFixed(1)}s`);
      console.log(`  实际墙钟 vs 理论 4 并发加速比：${(theoretical4Wall / (ocrWallMs / 1000)).toFixed(2)}x`);
    }

    // 读最终来源状态
    const finalTrip = await tripStore.load(tripId);
    const finalSource = finalTrip?.guideSources?.[sourceId];
    if (finalSource) {
      const progress = finalSource.imageProgress;
      console.log(`  图片进度：completed=${progress.completed} failed=${progress.failed} total=${progress.total}`);
      for (const entry of progress.images) {
        if (entry.status === "failed") {
          console.log(`    图 ${entry.index}：${entry.failureCode} - ${entry.failureMessage ?? ""}`);
        }
      }
    }

    console.log(`\n✓ 九图测试完成，scratch tripId=${tripId}`);
  }

  // ======= Part B：P1b 纯文字门禁非争用复测 =======
  async function runTextGateTest(): Promise<void> {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Part B：P1b 总门禁非争用复测`);
    console.log(`${"=".repeat(60)}\n`);

    // 读取 eval 语料文字（西岛 seawalk 笔记原文）
    const corpusPath = path.join(ROOT, "eval/cache/extraction/6ace31c6000000001b0202f7.json");
    const corpus = JSON.parse(await fs.readFile(corpusPath, "utf8")) as { text: string };
    const text = `${corpus.text}\n\n（Task #318 P1b 门禁非争用复测，scratch 行程，测毕归档）`;
    console.log(`✓ 语料加载：${text.length} 字符`);

    // 创建 scratch 行程
    const trip = await tripStore.create({
      destination: { city: "三亚" },
      dateRange: { start: "2026-11-10", end: "2026-11-14", nights: 4 },
    });
    const tripId = trip.tripId;
    scratchTrips.push(tripId);
    console.log(`✓ scratch 行程创建：${tripId}`);

    // 捕获 console.log 中的 #313 分段日志
    const capturedLogs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: any[]) => {
      const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
      if (msg.includes("Task #313") || msg.includes("分段耗时")) {
        capturedLogs.push(msg);
      }
      originalLog.apply(console, args);
    };

    // 提交文字来源
    const submitT0 = Date.now();
    const submitResult = await submitGuideSource(tripId, {
      inputKind: "text",
      text,
      title: "Task #318 P1b 门禁复测",
    });
    const submitResponseMs = Date.now() - submitT0;
    const sourceId = submitResult.sourceId;
    originalLog(`✓ 文字来源提交：${sourceId}，响应耗时 ${submitResponseMs}ms`);

    // 轮询等待 ready
    const pollResult = await pollSourceUntilSettled(tripId, sourceId, 400_000, 3_000);
    const totalMs = Date.now() - submitT0;

    // 恢复 console.log
    console.log = originalLog;

    // ======= 输出 P1b 结果 =======
    console.log(`\n${"-".repeat(50)}`);
    console.log(`P1b 纯文字门禁非争用复测结果：`);
    console.log(`  提交→终态总秒数：${(totalMs / 1000).toFixed(1)}s`);
    console.log(`  终态：${pollResult.status}`);
    console.log(`  提交响应：${submitResponseMs}ms`);

    if (capturedLogs.length > 0) {
      console.log(`  #313 分段日志：`);
      for (const log of capturedLogs) {
        console.log(`    ${log}`);
      }
      for (const log of capturedLogs) {
        const extractMatch = log.match(/抽取\s+(\d+)ms/);
        const assembleMatch = log.match(/装配写盘\s+(\d+)ms/);
        if (extractMatch) {
          const extractSec = Number(extractMatch[1]) / 1000;
          console.log(`  抽取段：${extractSec.toFixed(1)}s`);
          if (extractSec > 70) {
            console.log(`    ⚠️ 抽取段 >70s，归因百炼侧波动（非装配瓶颈）`);
          }
        }
        if (assembleMatch) {
          const assembleSec = Number(assembleMatch[1]) / 1000;
          console.log(`  装配写盘段：${assembleSec.toFixed(1)}s`);
        }
      }
    }

    // 门禁判定（Task #326：P1b 门禁 90s → 120s；Task #334 复测后维持 120s，理由修订：
    // #318 非争用实测 117.1s（百炼抽取 68.1s + 装配 46.7s），主导项是模型侧推理；
    // 原理由中「飞猪单次搜索 ~21s」已过期——11-03 同口径复测 p50 3.72s（快约 82%，
    // 根因未定位），重估 P1b ≈ 78〜100s（中值 ≈90s）仍贴线无裕量，且飞猪延迟存在
    // 跨天大幅波动（21s↔3.7s），120s 为波动裕量；若去 npx 方案落地后实测稳定
    // <90s 再收紧。推导见 eval-report/v2/perf.md「2026-11-03 FlyAI 延迟复测」节，
    // 与门禁表同步）
    //
    // Task #335（2026-11-04）：上述收紧条件已满足——去 npx 直跑 bundle + 服务端 24h
    // 搜索缓存落地后，P1b 非争用连测 2 轮 69.1s / 63.1s（均 <90s），装配写盘段由 46.7s
    // 降至 1.6〜2.4s（飞猪侧已非瓶颈，主导项转为百炼抽取 57.9〜67.3s）。据此门禁由
    // 120s 收回至 90s，三处口径同步（本常量、runner.ts P1b 门禁行、perf.md 门禁表）。
    // 残余风险：90s 裕量现取决于百炼抽取段波动（争用峰值曾 79.9s），见 perf.md #335 节。
    const GATE_LIMIT_SEC = 90;
    const totalSec = totalMs / 1000;
    const passed = totalSec <= GATE_LIMIT_SEC;
    console.log(`\n  门禁判定（≤${GATE_LIMIT_SEC}s）：${passed ? "✅ 通过" : "❌ 未通过"}`);
    console.log(`  差额：${(totalSec - GATE_LIMIT_SEC).toFixed(1)}s（正数=超标）`);
    console.log(`\n  对照基线：`);
    console.log(`    Cole #277 基线：~180s`);
    console.log(`    Victor #313 Run A2 争用轮：130.4s（抽取 79.9s 受争用）`);
    console.log(`    本轮非争用：${totalSec.toFixed(1)}s`);

    // 读最终来源详情
    const finalTrip = await tripStore.load(tripId);
    const finalSource = finalTrip?.guideSources?.[sourceId];
    if (finalSource) {
      console.log(`  evidenceRefs：${finalSource.evidenceRefs?.length ?? 0}`);
      console.log(`  mentionRefs：${finalSource.mentionRefs?.length ?? 0}`);
    }

    console.log(`\n✓ P1b 测试完成，scratch tripId=${tripId}`);
  }

  // ======= 主入口 =======
  const mode = process.argv[2] ?? "both";
  console.log(`运行模式：${mode}`);
  console.log(`时间：${new Date().toISOString()}`);
  console.log(`PD 行程 ${PD_TRIP} 不会被触碰`);

  try {
    if (mode === "nine" || mode === "both") {
      await runNineImageTest();
    }
    if (mode === "text" || mode === "both") {
      if (mode === "both") {
        console.log(`\n…间隔 10s 再跑 P1b（避免瞬时叠加限流）…`);
        await sleep(10_000);
      }
      await runTextGateTest();
    }
  } catch (error: any) {
    console.error(`\n🚨 测量异常终止：${error?.message ?? error}`);
    if (error?.stack) console.error(error.stack.split("\n").slice(0, 5).join("\n"));
  }

  // ======= 输出 scratch 行程列表供清理 =======
  console.log(`\n${"=".repeat(60)}`);
  console.log(`测量完毕。scratch 行程列表（待归档清理）：`);
  for (const id of scratchTrips) {
    console.log(`  ${id}`);
  }
  console.log(`${"=".repeat(60)}\n`);
}

void main().catch((error) => {
  console.error("[Task #318] 脚本异常：", error);
  process.exit(2);
});
