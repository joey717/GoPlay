/**
 * Task #273：真实生产路径一次性验证（真实调用百炼一次）。
 *
 * 目的：用真实行程 48275e19 / 来源 src_913c9426（ev_note_6 西岛交通攻略）+ 真实用户意图
 * 「补充西岛实用攻略」，跑一次与生产完全同形的 POST /trips/:tripId/draft，确认
 * draft.output.optionGroups 里真的出现 transport 组（Task #270 之后仍漏判的那一环）。
 *
 * 与生产同形之处：
 * - 4 条 NER 提及保持「未对齐西岛 visit」的原始状态（正是漏判现场，不做任何 ref 补写）；
 * - 来源为 staged=true，因此必须 sourceMode="selected" + selectedSourceIds（生产只能这样选）；
 * - 不注入桩：callPlanner 直接复用生产默认实现 createBailianSession，只在外面套一层记录
 *   prompt / finalText / 耗时；
 * - scope = attraction（西岛 visit），与前端从西岛卡片进面板时一致。
 *
 * 不写用户主行程：整体深拷贝成临时 tripId 落盘，结束（含异常）立即删除。
 *
 * 用法：
 *   npx tsx server/src/guides/eval-real-273.ts                  # 真实调用一次（约 40~120 秒）
 *   npx tsx server/src/guides/eval-real-273.ts --dry-run        # 只跑 prompt / 信号，不触网
 *   npx tsx server/src/guides/eval-real-273.ts --replay=/tmp/x.txt  # 离线回放已保存的 finalText
 */

import "../env.js";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import type { Trip } from "@goplay/shared";
import { getMissingBailianVars } from "../env.js";
import { createBailianSession } from "../bailian/client.js";
import { tripStore } from "../persistence/store.js";
import { mergeGuideMentions } from "./merge.js";
import {
  collectMergeSourceTexts,
  detectMergeOptionGroupSignals,
} from "./optionSignals.js";
import {
  buildGuidePlannerPrompt,
  resetGuidePlannerDeps,
  setGuidePlannerDeps,
} from "./planner.js";
import { guideRoutes } from "./routes.js";

// ===== 常量（真实数据，只读） =====

const REAL_TRIP_ID = "48275e19-c7cb-417b-8ef7-57b04e097cf4";
const REAL_SOURCE_ID = "src_913c9426";
const REAL_XIDAO_VISIT_ID = "visit_2217b269-803d-4be9-b329-7c4677ff0cc4_1";
const USER_NOTE = "补充西岛实用攻略";
const RESPONSE_DUMP = join(tmpdir(), "goplay-eval-real-273-response.txt");
const EXPECTED_TERMS = ["步行", "电动车", "观光车", "电动三轮车"];

interface CliOptions {
  dryRun: boolean;
  replay: string | null;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let dryRun = false;
  let replay: string | null = null;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("--replay=")) replay = arg.slice("--replay=".length).trim();
  }
  return { dryRun, replay };
}

// ===== 记录型 planner 依赖（生产实现 + 抓取） =====

const capturedPrompts: string[] = [];
let plannerFinalText = "";
let plannerLatencyMs = 0;

function armRecordingPlanner(): void {
  capturedPrompts.length = 0;
  plannerFinalText = "";
  plannerLatencyMs = 0;
  setGuidePlannerDeps({
    callPlanner: async (prompt: string, timeoutMs: number) => {
      capturedPrompts.push(prompt);
      const startedAt = Date.now();
      const result = await createBailianSession(prompt, { timeoutMs });
      plannerLatencyMs = Date.now() - startedAt;
      plannerFinalText = result.finalText;
      return result.finalText;
    },
  });
}

async function requestJson(
  routePath: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await guideRoutes.request(routePath, init);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function cloneTrip(trip: Trip): Trip {
  return JSON.parse(JSON.stringify(trip)) as Trip;
}

// ===== main =====

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const tempTripIds: string[] = [];
  try {
    const realTrip = await tripStore.load(REAL_TRIP_ID);
    assert.ok(realTrip !== null, `真实行程 ${REAL_TRIP_ID} 应存在`);

    // ---------- 0. 现场事实（只读） ----------
    const source = realTrip.guideSources?.[REAL_SOURCE_ID];
    assert.ok(source !== undefined, `真实行程应包含来源 ${REAL_SOURCE_ID}`);
    const evidence = realTrip.evidences["ev_note_6"];
    assert.ok(evidence !== undefined, "真实行程应包含证据 ev_note_6");
    const sourceText = typeof source.sourceText === "string" ? source.sourceText : "";
    console.log("===== 0. 真实素材现场 =====");
    console.log(`来源 ${REAL_SOURCE_ID}：active=${String(source.active)} staged=${String(source.staged)} status=${source.status}`);
    console.log(`sourceText 长度=${sourceText.length} 字；含电动三轮车=${String(sourceText.includes("电动三轮车"))}`);
    console.log(`ev_note_6 mentions=${evidence.mentions.length} 条`);
    const xidaoVisit = realTrip.visits[REAL_XIDAO_VISIT_ID];
    assert.ok(xidaoVisit !== undefined, "真实行程应包含西岛 visit");
    console.log(`西岛 visit 已对齐 refs=${JSON.stringify(xidaoVisit.sourceMentionRefs ?? [])}`);

    const merge = mergeGuideMentions(realTrip, { selectedSourceIds: new Set([REAL_SOURCE_ID]) });
    const signals = detectMergeOptionGroupSignals(merge, { sourceTexts: collectMergeSourceTexts(realTrip, merge) });
    console.log(
      `生产 merge：mentions=${merge.mentions.length} places=${merge.places.map((p) => p.displayName).join(" / ")}`,
    );
    console.log(
      `信号：hit=${String(signals.hit)} places=${JSON.stringify(signals.places)} sources=${JSON.stringify(signals.sources)}`,
    );
    console.log(`选项词：${signals.optionTerms.join(" / ")}；价格 ${signals.priceCount} 处，区间=${String(signals.priceRange)}`);
    assert.equal(merge.mentions.length, 4, "生产现场应为 4 条提及");
    assert.equal(signals.hit, true, "生产现场信号应命中（本脚本前提）");
    assert.ok(signals.sources.includes(REAL_SOURCE_ID), "命中来源应包含真实来源");

    // ---------- 1. 临时行程副本（不碰用户主行程） ----------
    const temp = cloneTrip(realTrip);
    temp.tripId = randomUUID();
    delete temp.pendingGuideDraft;
    temp.guideDraftNote = "";
    await tripStore.save(temp);
    tempTripIds.push(temp.tripId);
    console.log(`\n临时行程副本：${temp.tripId}（进程结束后删除）`);

    // ---------- 2. prompt 预演（离线，证明第七节与原文补充都进了生产 prompt） ----------
    const dryPrompt = buildGuidePlannerPrompt(temp, merge, {
      kind: "attraction",
      visitId: REAL_XIDAO_VISIT_ID,
    });
    const promptChecks: [string, boolean][] = [
      ["完整第七节", dryPrompt.includes("七、optionGroups（实用参考选项组，Task #190）")],
      ["无降级短声明", !dryPrompt.includes("七、optionGroups：本轮不适用，输出空数组 []")],
      ["来源原文补充", dryPrompt.includes("【来源原文补充】")],
      ["电动三轮车", dryPrompt.includes("电动三轮车")],
      ["电动车价格区间", dryPrompt.includes("25-40 元/天")],
      ["交通组指导", dryPrompt.includes("整个景区通用的交通方式")],
    ];
    console.log("\n===== 1. 生产 prompt 预演 =====");
    for (const [label, ok] of promptChecks) console.log(`  ${ok ? "✓" : "✗"} ${label}`);
    console.log(`prompt 长度=${dryPrompt.length} 字`);

    // ---------- 3. 真实调用（或回放） ----------
    console.log("\n===== 2. 生成草案（POST /trips/:id/draft） =====");
    const requestBody = {
      scope: { kind: "attraction" as const, visitId: REAL_XIDAO_VISIT_ID },
      sourceMode: "selected" as const,
      selectedSourceIds: [REAL_SOURCE_ID],
      note: USER_NOTE,
    };
    console.log(`body=${JSON.stringify(requestBody)}`);

    if (options.replay !== null) {
      const replayed = readFileSync(options.replay, "utf8");
      plannerFinalText = replayed;
      setGuidePlannerDeps({ callPlanner: async () => replayed });
      console.log(`离线回放 ${options.replay}（${replayed.length} 字，不触网）`);
    } else if (options.dryRun) {
      console.log("--dry-run：不调用百炼，只看 prompt 与信号");
      return;
    } else {
      const missing = getMissingBailianVars();
      assert.deepEqual(missing, [], `百炼环境变量缺失：${missing.join(", ")}`);
      armRecordingPlanner();
    }

    const startedAt = Date.now();
    const res = await requestJson(`/trips/${temp.tripId}/draft`, "POST", requestBody);
    const totalMs = Date.now() - startedAt;
    console.log(`HTTP ${res.status}；路由总耗时 ${totalMs}ms；planner 调用 ${capturedPrompts.length} 次`);
    if (res.status !== 200) {
      console.log(`响应体：${JSON.stringify(res.body)}`);
      process.exitCode = 1;
      return;
    }

    if (plannerLatencyMs > 0) console.log(`百炼单轮耗时 ${plannerLatencyMs}ms`);
    if (plannerFinalText !== "") {
      writeFileSync(RESPONSE_DUMP, plannerFinalText, "utf8");
      console.log(`百炼 finalText 已存到 ${RESPONSE_DUMP}（${plannerFinalText.length} 字，可用 --replay 复盘）`);
    }

    // ---------- 4. 结果核对 ----------
    const fastPath = res.body.fastPath === true;
    const attempts = Number(res.body.attempts ?? 0);
    const latencyMs = Number(res.body.latencyMs ?? 0);
    const promptChars = Number(res.body.promptChars ?? 0);
    const mentionCount = Number(res.body.mentionCount ?? 0);
    const placeCount = Number(res.body.placeCount ?? 0);
    const sourceCount = Number(res.body.sourceCount ?? 0);
    const snippets = Array.isArray(res.body.snippets) ? res.body.snippets : [];
    const optionGroups = Array.isArray(res.body.optionGroups) ? res.body.optionGroups : [];

    console.log("\n===== 3. 草案结果 =====");
    console.log(
      `fastPath=${String(fastPath)} attempts=${attempts} latencyMs=${latencyMs} promptChars=${promptChars}`,
    );
    console.log(`sources=${sourceCount} mentions=${mentionCount} places=${placeCount}`);
    console.log(`snippets=${snippets.length} optionGroups=${optionGroups.length}`);
    console.log("optionGroups：");
    console.log(JSON.stringify(optionGroups, null, 2));

    const saved = await tripStore.load(temp.tripId);
    const draftOutput = saved?.pendingGuideDraft?.output;
    console.log(`\n草案已落盘：${draftOutput !== undefined}`);
    if (draftOutput !== undefined) {
      console.log(`落盘 snippets=${draftOutput.snippets.length} optionGroups=${draftOutput.optionGroups?.length ?? 0}`);
    }

    // transport 组判定
    const groups = (draftOutput?.optionGroups ?? []).map((group) => group as unknown as {
      category?: string;
      title?: string;
      options?: { label?: string }[];
    });
    const transport = groups.find((group) => group.category === "transport");
    const labels = (transport?.options ?? []).map((option) => option.label ?? "");
    const joinedLabels = labels.join(" / ");
    const coveredTerms = EXPECTED_TERMS.filter((term) => joinedLabels.includes(term));

    const finalChecks: [string, boolean][] = [
      ["未走快速路径（planner 真跑）", !fastPath && attempts >= 1],
      ["草案落盘", draftOutput !== undefined],
      ["存在 transport 选项组", transport !== undefined],
      ["transport 选项 ≥ 2", labels.length >= 2],
      ["覆盖步行/电动车/观光车/电动三轮车", coveredTerms.length === EXPECTED_TERMS.length],
    ];
    console.log("\n===== 4. 判定 =====");
    for (const [label, ok] of finalChecks) console.log(`  ${ok ? "✓" : "✗"} ${label}`);
    console.log(`transport labels：${joinedLabels === "" ? "（无）" : joinedLabels}`);
    if (coveredTerms.length !== EXPECTED_TERMS.length) {
      console.log(`未覆盖：${EXPECTED_TERMS.filter((term) => !coveredTerms.includes(term)).join(" / ")}`);
    }
    const failed = finalChecks.filter(([, ok]) => !ok).map(([label]) => label);
    if (failed.length > 0) {
      console.log(`\n[eval] 未通过：${failed.join("；")}`);
      process.exitCode = 1;
    } else {
      console.log("\n[eval] Task #273 真实生产路径通过 ✓（draft.output.optionGroups 含 transport 组）");
    }
  } finally {
    resetGuidePlannerDeps();
    let removed = 0;
    for (const tripId of tempTripIds) {
      try {
        await tripStore.deleteTrip(tripId);
        removed += 1;
      } catch (error) {
        console.warn(`[eval] 清理临时行程 ${tripId} 失败:`, error);
      }
    }
    console.log(`[eval] 已清理 ${removed}/${tempTripIds.length} 个临时行程（server/data）`);
  }
}

void main();
