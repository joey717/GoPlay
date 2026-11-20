/**
 * Task #231 live 冒烟：真实多图 OCR 并发提速 + 逐图回显验证。
 *
 * 目的（夜间 live 窗口，控制在 1 次真实多图解析内）：
 * - 用本地已落盘的真实小红书图（server/uploads/xhs_*\/{n}.jpg）跑一遍图片并发队列，
 *   走真实百炼 OCR（recognizeImageContent），不重新爬取、不新建行程、不写盘；
 * - 记录：整批 wall-clock、逐图延迟、逐图完成时刻偏移 → 证明并发在跑
 *   （wall-clock ≈ 单波最慢图，而非逐图串行之和）；
 * - 「前后耗时对比」口径：串行基线 = 逐图延迟之和（concurrency=1 的理论耗时），
 *   并发实测 = 整批 wall-clock；提速倍数 = 串行基线 / 并发实测。
 *
 * 运行：npx tsx src/guides/smoke-task231.ts [图数，默认 6]
 * 图数默认 6 = GUIDE_IMAGE_CONCURRENCY 默认值（Task #322 由 4 调为 6），一波打满、并发信号最清晰。
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { recognizeImageContent, type OcrScreenshotInput } from "../ai/ocr.js";
import {
  runGuideImageQueue,
  GUIDE_IMAGE_CONCURRENCY,
  GUIDE_IMAGE_TIMEOUT_MS,
  type GuideImageTask,
  type GuideImageTaskResult,
} from "./jobs.js";

const ASSET_DIR = join(import.meta.dirname, "../../uploads/xhs_6abf466e0000000018014188");

interface ImageTiming {
  index: number;
  startOffsetMs: number;
  latencyMs: number;
  status: "ready" | "failed";
  detail: string;
}

async function main(): Promise<void> {
  const requested = Number(process.argv[2] ?? 6);
  const count = Number.isInteger(requested) && requested >= 1 && requested <= 8 ? requested : 6;

  // 收集本地图（1..count）；缺图直接报错退出（不静默降级，避免假数据）
  const inputs: Array<{ index: number; input: OcrScreenshotInput }> = [];
  for (let i = 1; i <= count; i++) {
    const file = join(ASSET_DIR, `${i}.jpg`);
    if (!existsSync(file)) {
      console.error(`[SMOKE] 缺少真实图：${file}`);
      process.exit(1);
    }
    const data = readFileSync(file);
    inputs.push({
      index: i,
      input: { data: new Uint8Array(data), filename: `${i}.jpg`, mimeType: "image/jpeg", sizeBytes: data.length },
    });
  }

  console.log(
    `[SMOKE] Task #231 live 冒烟：${count} 张真实图，并发=${GUIDE_IMAGE_CONCURRENCY}，单图超时=${GUIDE_IMAGE_TIMEOUT_MS / 1000}s`,
  );

  const timings: ImageTiming[] = [];
  const batchStart = Date.now();

  const tasks: GuideImageTask[] = inputs.map(({ index, input }) => ({
    index,
    run: async (): Promise<GuideImageTaskResult> => {
      const start = Date.now();
      const startOffsetMs = start - batchStart;
      try {
        const recognized = await recognizeImageContent(input);
        const latencyMs = Date.now() - start;
        timings.push({
          index,
          startOffsetMs,
          latencyMs,
          status: "ready",
          detail: `ocrText ${recognized.ocrText.length} 字，mentions ${recognized.mentions.length} 条`,
        });
        return { index, outcome: { kind: "ready", evidenceId: `smoke_ev_${index}` } };
      } catch (error) {
        const latencyMs = Date.now() - start;
        const message = error instanceof Error ? error.message : String(error);
        timings.push({ index, startOffsetMs, latencyMs, status: "failed", detail: message.slice(0, 120) });
        return {
          index,
          outcome: { kind: "failed", failureCode: "unknown", failureMessage: message.slice(0, 200) },
        };
      }
    },
  }));

  const outcome = await runGuideImageQueue(tasks, {
    concurrency: GUIDE_IMAGE_CONCURRENCY,
    budgetMs: 600_000,
    perTaskTimeoutMs: GUIDE_IMAGE_TIMEOUT_MS,
  });
  const wallClockMs = Date.now() - batchStart;

  // 逐图回显（按 index 升序）
  timings.sort((a, b) => a.index - b.index);
  console.log("\n=== 逐图回显 ===");
  for (const t of timings) {
    console.log(
      `  图 ${t.index}: ${t.status.padEnd(6)} 启动@+${(t.startOffsetMs / 1000).toFixed(1)}s 耗时 ${(t.latencyMs / 1000).toFixed(1)}s — ${t.detail}`,
    );
  }

  const serialSumMs = timings.reduce((acc, t) => acc + t.latencyMs, 0);
  const readyCount = timings.filter((t) => t.status === "ready").length;
  const speedup = wallClockMs > 0 ? serialSumMs / wallClockMs : 0;

  console.log("\n=== 耗时对比 ===");
  console.log(`  整批 wall-clock（并发 ${GUIDE_IMAGE_CONCURRENCY}）：${(wallClockMs / 1000).toFixed(1)}s`);
  console.log(`  串行基线（逐图延迟之和，concurrency=1 理论值）：${(serialSumMs / 1000).toFixed(1)}s`);
  console.log(`  提速倍数：${speedup.toFixed(2)}x`);
  console.log(`  成功 ${readyCount}/${timings.length} 张；队列结算 ready ${outcome.settled.length}，超时 ${outcome.timedOutIndexes.length}`);

  // 并发信号判定：wall-clock 应显著小于串行之和（多图时）
  if (timings.length > 1) {
    const concurrent = wallClockMs < serialSumMs * 0.75;
    console.log(`\n  并发提速验证：${concurrent ? "✓ 通过（wall-clock 明显小于串行之和）" : "✗ 未观察到明显并发提速"}`);
    // 启动时刻重叠：非首图若在首图完成前启动，证明并行
    const overlaps = timings.filter((t) => t.startOffsetMs < 1500 && t.index !== timings[0].index).length;
    console.log(`  并行启动信号：${overlaps + 1}/${timings.length} 张在 1.5s 内几乎同时启动`);
  }
}

main().catch((error) => {
  console.error("[SMOKE] 冒烟异常：", error);
  process.exit(1);
});
