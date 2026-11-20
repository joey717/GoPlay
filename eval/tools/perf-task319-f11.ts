/**
 * Task #319：F11 意图通道耗时实测（live 窗口，≤3 次真实百炼 executeIntent 调用）。
 *
 * 目的：#316（formatStopLine 补 stop 中文名与禁操作标注）与 #327（FIXED_RULES_TEXT
 * 增长至 3849 字符）后，确认意图 prompt 增长无显著耗时回归。
 * 对照基线：O3 意图真调 28s（#292 轮）；P1b 重估 78–100s、门禁 120s（perf.md #334）。
 * 生产超时预算：普通意图 60s / 全量重排 90s（pipeline.ts 分级）。
 *
 * 运行：npx tsx eval/tools/perf-task319-f11.ts
 * 纪律：scratch 行程（createFixtureSanyaTrip，随机 UUID），测毕删除数据文件；
 *       不碰 PD 行程；不修改任何产品代码；3 次调用串行，出错不重试烧额度。
 */

import "../../server/src/env.js";
import fs from "node:fs/promises";
import path from "node:path";
import { createFixtureSanyaTrip } from "../../server/src/persistence/store.js";
import { executeIntent } from "../../server/src/ai/pipeline.js";
import { buildIntentPrompt } from "../../server/src/ai/prompt.js";

/** 三次意图（覆盖三类形态；均为 fixture 行程上语义合法的操作，全量重排不计入以省额度） */
const INTENTS: Array<{ label: string; text: string }> = [
  { label: "F11-1 单日松排（O3 同文本）", text: "Day2 松一点" },
  { label: "F11-2 stop 级改序", text: "把蜈支洲岛的观日岩挪到岛内第一个玩" },
  { label: "F11-3 单日补充诉求", text: "第二天下午加一个适合拍照的免费点位" },
];

function summarize(intent: { type: string; message?: string; clarify?: unknown; result?: { applied?: unknown[]; needsProposal?: unknown[] } }): string {
  const applied = intent.result?.applied?.length ?? 0;
  const needsProposal = intent.result?.needsProposal?.length ?? 0;
  return `type=${intent.type} applied=${applied} needsProposal=${needsProposal}${intent.message !== undefined ? ` message=${intent.message.slice(0, 80)}` : ""}`;
}

async function main(): Promise<void> {
  const trip = await createFixtureSanyaTrip();
  const tripId = trip.tripId;
  console.log(`[perf-task319-f11] scratch 行程：${tripId}`);
  try {
    // prompt 长度观测（#316/#327 增长后的实际口径；buildIntentPrompt 纯函数不触网）
    const promptSample = buildIntentPrompt(trip, INTENTS[0]!.text);
    console.log(`[perf-task319-f11] 完整意图 prompt 长度：${promptSample.length} 字符（含 FIXED_RULES_TEXT 与行程事实块）`);

    const rows: Array<{ label: string; wallMs: number; outcome: string }> = [];
    for (const entry of INTENTS) {
      const t0 = Date.now();
      // 每次新建会话（不复用 sessionId）：走完整 prompt 路径，才能量到 prompt 增长的影响
      const intent = await executeIntent(tripId, entry.text);
      const wallMs = Date.now() - t0;
      const outcome = summarize(intent as Parameters<typeof summarize>[0]);
      rows.push({ label: entry.label, wallMs, outcome });
      console.log(`[perf-task319-f11] ${entry.label}：${(wallMs / 1000).toFixed(1)}s ｜ ${outcome}`);
    }

    console.log(`\n===== F11 意图耗时实测汇总（Task #319） =====`);
    for (const row of rows) {
      console.log(`| ${row.label} | ${(row.wallMs / 1000).toFixed(1)}s | ${row.outcome} |`);
    }
    const walls = rows.map((r) => r.wallMs / 1000);
    const max = Math.max(...walls);
    const avg = walls.reduce((a, b) => a + b, 0) / walls.length;
    console.log(`均值 ${avg.toFixed(1)}s ／ 最坏 ${max.toFixed(1)}s（生产预算：普通 60s / 全量重排 90s）`);
    console.log(`对照：#292 轮 O3 意图真调 28s；判定口径＝与预算及历史基线比无显著回归`);
  } finally {
    // 清理 scratch 行程数据文件（不留业务副作用）
    const dataFile = path.resolve(import.meta.dirname, `../../server/data/${tripId}.json`);
    try {
      await fs.unlink(dataFile);
      console.log(`[perf-task319-f11] 已清理 scratch 行程文件：${dataFile}`);
    } catch (error) {
      console.warn(`[perf-task319-f11] 清理失败（需手动删除 ${dataFile}）：`, error);
    }
  }
}

void main().catch((error) => {
  console.error("[perf-task319-f11] 异常：", error);
  process.exit(1);
});
