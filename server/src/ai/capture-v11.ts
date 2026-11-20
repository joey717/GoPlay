/**
 * v1.1 fixture 捕获脚本（Task #49）：用真实百炼 Managed Agent 复现 v1.1 意图，
 * 把模型原始 finalText 固化为回归夹具（不输出任何密钥）。
 *
 * 产出（server/src/ai/fixtures/v11/）：
 *   - full-replan-*.txt       全量重排意图的原始响应（可覆盖合成基线）
 *   - single-day-replan.txt   单日意图的原始响应（对照，防误判全量）
 *   - stop-reorder.txt        内部玩法改序意图的原始响应（Stop 级操作）
 *   - meta.json               本次捕获的意图文本 / 长度 / 耗时 / 捕获时间（不含密钥）
 *
 * 说明：目录幂等——同名夹具已存在则跳过；测试行程 = 标准三亚验收行程
 * （createFixtureSanyaTrip() 显式生成，实体 ID 固定，模型输出中的 id 可直接重放；
 *  Task #66 后 tripStore.create 不再返回夹具）。
 * Managed Agent 偶发慢响应，捕获侧超时放宽至 150s（生产 F11 仍为 60s/90s 分级预算）。
 *
 * 运行：npx tsx server/src/ai/capture-v11.ts
 */

import "../env.js";
import fs from "node:fs/promises";
import path from "node:path";
import type { Trip } from "@goplay/shared";
import { createBailianSession } from "../bailian/client.js";
import { createFixtureSanyaTrip } from "../persistence/store.js";
import { buildIntentPrompt } from "./prompt.js";

const FIXTURE_DIR = path.join(import.meta.dirname, "fixtures", "v11");

const CAPTURES: Array<{ file: string; intent: string }> = [
  { file: "full-replan-1.txt", intent: "全部重排行程" },
  { file: "full-replan-2.txt", intent: "重新排一版整个行程" },
  { file: "full-replan-3.txt", intent: "帮我把五天的行程全部重新安排一遍" },
  { file: "full-replan-4.txt", intent: "整体重新规划这个行程" },
  { file: "single-day-replan.txt", intent: "重新安排第二天" },
  { file: "stop-reorder.txt", intent: "把蜈支洲岛的观日岩挪到岛内第一个玩" },
];

/** 捕获侧放宽的超时（Managed Agent 偶发慢响应） */
const CAPTURE_TIMEOUT_MS = 150_000;

async function main(): Promise<void> {
  await fs.mkdir(FIXTURE_DIR, { recursive: true });

  // 标准三亚验收行程：实体 ID 固定（item_wzz / visit_wzz / stop_rock 等），捕获输出可重放
  const trip: Trip = await createFixtureSanyaTrip();
  console.log(`[capture] 测试行程 ${trip.tripId}（version=${trip.version}，写入 data 目录）`);

  const meta: Array<{ file: string; intent: string; chars: number; latencyMs: number; capturedAt: string }> = [];
  try {
    const previous = JSON.parse(await fs.readFile(path.join(FIXTURE_DIR, "meta.json"), "utf8")) as {
      captures?: Array<{ file: string; intent: string; chars: number; latencyMs: number; capturedAt: string }>;
    };
    meta.push(...(previous.captures ?? []));
  } catch {
    // 无历史 meta（合成基线的 meta.json 无 captures 字段），正常首次运行
  }

  for (const { file, intent } of CAPTURES) {
    const filePath = path.join(FIXTURE_DIR, file);
    try {
      await fs.access(filePath);
      console.log(`[capture] ${file} 已存在，跳过（幂等）`);
      continue;
    } catch {
      // 未捕获过，继续
    }
    const prompt = buildIntentPrompt(trip, intent);
    let captured: Awaited<ReturnType<typeof createBailianSession>> | null = null;
    for (let attempt = 1; attempt <= 3 && captured === null; attempt++) {
      console.log(`\n[capture] 意图「${intent}」→ 百炼调用中（第 ${attempt}/3 次，超时 ${CAPTURE_TIMEOUT_MS / 1000}s）…`);
      try {
        captured = await createBailianSession(prompt, { timeoutMs: CAPTURE_TIMEOUT_MS });
      } catch (error) {
        console.error(`[capture] 第 ${attempt} 次失败：${(error as Error).message}`);
      }
    }
    if (captured === null) {
      console.error(`[capture] 意图「${intent}」三次均失败，跳过`);
      continue;
    }
    await fs.writeFile(filePath, captured.finalText, "utf8");
    meta.push({
      file,
      intent,
      chars: captured.finalText.length,
      latencyMs: captured.latencyMs,
      capturedAt: new Date().toISOString(),
    });
    console.log(`[capture] 已保存 ${file}（${captured.finalText.length} 字符，${captured.latencyMs}ms）`);
    console.log(`[capture] 前 300 字符预览：${captured.finalText.slice(0, 300)}`);
  }

  // 同名记录去重后回写（后捕的覆盖先前记录）
  const deduped = [...new Map(meta.map((entry) => [entry.file, entry])).values()];

  await fs.writeFile(
    path.join(FIXTURE_DIR, "meta.json"),
    `${JSON.stringify({ tripId: trip.tripId, captures: deduped }, null, 2)}\n`,
    "utf8",
  );
  console.log(`\n[capture] 全部完成，夹具目录 ${FIXTURE_DIR}`);
}

main().catch((error) => {
  console.error("[capture] 失败：", error);
  process.exitCode = 1;
});
