/**
 * Task #313 live 取证（Run B）：装配段隔离 A/B 基准。
 *
 * 用同一批真实 entry（eval 语料 6ace31c6 西岛笔记抽取缓存：1 attraction + 5
 * in_attraction + 3 note_tip → 6 条唯一 FlyAI 搜索），对 **live FlyAI** 分别以：
 *   - serial（concurrency=1）：复现 Cole #277 串行基线（6 × p50≈21s ≈ 126s；
 *     Task #334 注：21s 系 11-02 基线，11-03 同口径复测 p50 3.72s，重跑本脚本
 *     时 serial 段预期同步下降，见 eval-report/v2/perf.md 复测节）；
 *   - pool（concurrency=ASSEMBLE_CONCURRENCY，默认 6）：#313 并行装配；
 * 各跑一次装配段，对照墙钟秒数。note_tip 走 Pass 0 不搜索；parent 西岛在 Pass 1
 * 已建 Visit 壳，Pass 2 无二次父级搜索——恰好 6 条唯一搜索，与基线同量级。
 *
 * 每 run 独立 trip + 独立 searchCache（run 内 memo 生效、跨 run 不缓存），保证
 * 两段都真实触网。装配段＝assembleEntries 全程（抽取不在此脚本，百炼今晚限流另计）。
 *
 * 运行：npx tsx scripts/perf-task313-assemble.ts [serial|parallel|both，默认 both]
 */
import "../server/src/env.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { SourceEvidence, Trip } from "@goplay/shared";
import { SCHEMA_VERSION } from "@goplay/shared";
import { assembleEntries, type ParsedEntry } from "../server/src/ai/assemble.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(join(here, "../eval/cache/extraction/6ace31c6000000001b0202f7.json"), "utf8"),
) as { entries: unknown[] };
const entries = corpus.entries as ParsedEntry[];

function makeTrip(): Trip {
  return {
    tripId: "trip_perf_313",
    schemaVersion: SCHEMA_VERSION,
    version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-10", end: "2026-11-14", nights: 4 },
    dayRefs: ["day_1"],
    days: {
      day_1: {
        dayId: "day_1", dayIndex: 1, date: "2026-11-10",
        departTime: null, departTimeOverridden: false,
        scheduleVisitRefs: [], lodging: null,
      },
    },
    lodgings: {},
    hotelRegistry: {},
    guideSources: {},
    itemRegistry: {},
    visits: {},
    stops: {},
    evidences: {},
    globalCandidateRefs: [],
    pendingStopRefs: [],
    relationshipSuggestions: {},
    constraints: [],
    createdAt: "2026-11-02T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
  };
}

async function runOnce(label: string, scheduler: "serial" | "pool", concurrency: number): Promise<void> {
  const trip = makeTrip();
  const evidence: SourceEvidence = {
    evidenceId: "ev_perf", kind: "note_text", noteIndex: 1,
    assetRef: null, sourceUrl: null, ocrText: null, mentions: [],
  };
  trip.evidences.ev_perf = evidence;
  const errors: string[] = [];
  const t0 = Date.now();
  const outcome = await assembleEntries(trip, entries, evidence, "ev_perf", errors, new Map(), {
    scheduler,
    concurrency,
    budgetMs: 120_000,
    logPrefix: `PERF-${label}`,
  });
  const sec = (Date.now() - t0) / 1000;
  const matched = outcome.items.filter((i) => i.origin === "fliggy").length;
  console.log(
    `\n=== [${label}] scheduler=${scheduler} concurrency=${concurrency} ===\n` +
      `装配段墙钟：${sec.toFixed(1)}s\n` +
      `items=${outcome.items.length}（fliggy 对齐 ${matched}） visits=${outcome.visits.length} ` +
      `stops=${outcome.stops.length} mentions=${evidence.mentions.length} errors=${errors.length}\n` +
      `RESULT ${JSON.stringify({ label, scheduler, concurrency, assembleSeconds: Number(sec.toFixed(1)), items: outcome.items.length, matched, stops: outcome.stops.length })}`,
  );
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "both";
  console.log(`Task #313 装配段 A/B 基准（live FlyAI）：entries=${entries.length}，mode=${mode}`);
  if (mode === "serial" || mode === "both") {
    await runOnce("serial-baseline", "serial", 1);
  }
  if (mode === "both") {
    console.log("\n…间隔 5s 再跑并行段（避免瞬时叠加 FlyAI 压力）…");
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (mode === "parallel" || mode === "both") {
    await runOnce("parallel-313", "pool", Number(process.env.ASSEMBLE_CONCURRENCY) || 6);
  }
  console.log("\n===== Task #313 装配段基准完成 =====");
}

// Task #335 回归复跑：原脚本用顶层 await，但仓库根 package.json 无 type:module，tsx 以 cjs
// 编译会报「Top-level await is not supported with cjs」——与仓库同类脚本（perf-task318/
// perf-task335）一致改为 async main() 包裹，仅修复可运行性，不改任何测量语义/参数。
void main().catch((error) => {
  console.error("[Task #313] 脚本异常：", error);
  process.exit(2);
});
