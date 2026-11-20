/**
 * Task #339 一次性数据修复：同攻略同景点的相似亮点收敛为 1 条（第三档存量清理）。
 *
 * ## 现场
 * PD 反馈行程 0a27f726 的玻璃栈道（亚龙湾热带天堂森林公园子玩法）有 2 条亮点，
 * 来自同一篇攻略（src_031163bc / ev_note_2）里同一景点的两段相似表述：
 * - 「大雾天上去白茫茫拍不到，钱就白花」refs=[ev_note_2:m6]
 * - 「大雾天玻璃栈道白茫茫拍不到，谨慎购买」refs=[ev_note_2:m6, ev_note_2:m16]
 * 归一化 LCS 重合率实测 0.625——基础档（0.9）与放宽档（同引用对需 ≥ 0.8）都拦不住。
 * PD 拍板（两次补充）：仅当内容相似时才收敛为 1 条；完全不同的贴士可以保留多条。
 *
 * ## 判定口径（第三档，leader 2026-11-03 批准的落地版）
 * 复用 shared 纯函数 areSameSourceSnippetsSimilar：
 * - 同一实体（= 同一归属景点，snippet 挂载粒度天然满足）；
 * - 同一 guide source（引用可解析出共同归属来源）；
 * - 两条 sourceMentionRefs 组合**不完全相同**——refs 完全相同 = 同一句提及的重复
 *   抽取，属放宽档既有领域，历史取舍刻意保留（后海村 0.65；全仓扫描同形态还有
 *   太阳湾公路 0.588、鹿回头 0.563、南山 0.529，一律不动）；
 * - 归一化 LCS 重合率 ≥ 0.5（SNIPPET_CROSS_SOURCE_THRESHOLD）。
 * 合并保留更长（信息更丰富）者，引用原样保留；跨来源 / 悬空引用一律不合并。
 *
 * 实现上只跑 shared mergeSimilarEntitySnippets（仅合并 guideSnippets 列表、
 * 与写入路径 appendGuideSnippet 共用同一三档判定），刻意**不跑** #212 的
 * 引用身份去重（deduplicateSnippets）：后者会连带清理 sourceMentionRefs，把写盘面
 * 扩大到与本次亮点收敛无关的 7 个行程（dry-run 实测）。只清洗 guideSnippets，
 * 不触碰行程结构、证据原始数据、实体引用与 optionGroups。
 *
 * ## 写盘纪律（仿 fix-task329/330 范式）
 * - 主模块守卫：被 import 时不触发真实修复；
 * - --dry-run：只打印将发生的合并与刻意保留清单，不写盘、不备份；
 * - 备份先行：写盘前复制原文件为 <tripId>.json.bak-task339；
 * - tripStore.load / save：读时迁移 + 一致性校验 + version 自增 + 原子写；
 * - 无变更不写盘；单文件失败只记录并继续，有失败退出码非零；
 * - 幂等：实跑后回读再跑一遍去重必须全部无变化，否则视为失败退出。
 *
 * 运行：npx tsx server/src/guides/fix-task339.ts
 * 预演：npx tsx server/src/guides/fix-task339.ts --dry-run
 */

import "../env.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GuideSnippet, Stop, Trip, Visit } from "@goplay/shared";
import {
  areSameSourceSnippetsSimilar,
  areSnippetEntriesSimilar,
  mergeSimilarEntitySnippets,
  snippetSimilarity,
} from "@goplay/shared";
import { isValidTripId, tripStore } from "../persistence/store.js";

/** 一条合并记录（报告用）：谁被并入谁、重合率、两侧引用 */
export interface Task339MergeRecord {
  tripId: string;
  entityKind: "visit" | "stop";
  entityName: string;
  keptText: string;
  removedText: string;
  /** 归一化 LCS 重合率（报告口径） */
  ratio: number;
  /** 命中档位：entries = 既有双档；same-source = 第三档 */
  tier: "entries" | "same-source";
  keptRefs: string[];
  removedRefs: string[];
}

/** 一条刻意保留记录：同来源、重合率 ≥ 0.5 但 refs 完全相同（同提及历史取舍） */
export interface Task339KeptRecord {
  tripId: string;
  entityKind: "visit" | "stop";
  entityName: string;
  textA: string;
  textB: string;
  ratio: number;
  reason: string;
}

/** 实体显示名（与 planner.snippetEntityName 同数据源，报告可读性用，不做归一化） */
function entityDisplayName(trip: Trip, entity: Visit | Stop): string {
  if ("stopId" in entity) {
    return (
      trip.itemRegistry?.[entity.matchedPointRef ?? ""]?.name ?? entity.customName ?? entity.stopId
    );
  }
  return trip.itemRegistry?.[entity.pointRef]?.name ?? entity.visitId;
}

function refSetKey(refs: readonly string[]): string {
  return JSON.stringify([...refs].sort());
}

/**
 * 纯函数：对一个实体做第三档清洗并产出报告明细。
 * before/after 对比得出被移除条目，再对 (kept, removed) 复跑判定归因命中档位。
 * 无变化时 cleaned === entity（shared 幂等契约），不产生记录。
 */
export function cleanEntityWithReport<T extends Visit | Stop>(
  trip: Trip,
  entity: T,
  tripId: string,
): { cleaned: T; merges: Task339MergeRecord[]; keeps: Task339KeptRecord[] } {
  const before: GuideSnippet[] = Array.isArray(entity.guideSnippets) ? entity.guideSnippets : [];
  const cleaned = mergeSimilarEntitySnippets(entity, trip);
  const after: GuideSnippet[] = Array.isArray(cleaned.guideSnippets) ? cleaned.guideSnippets : [];
  const entityKind: "visit" | "stop" = "stopId" in entity ? "stop" : "visit";
  const entityName = entityDisplayName(trip, entity);

  const merges: Task339MergeRecord[] = [];
  if (cleaned !== entity) {
    const afterIds = new Set(after.map((snippet) => snippet.snippetId));
    for (const removed of before) {
      if (afterIds.has(removed.snippetId)) continue;
      // 归因：找到吸收它的保留条目（原位替换的 winner），复跑判定确定命中档位
      const partner =
        after.find(
          (kept) =>
            areSnippetEntriesSimilar(kept, removed) ||
            areSameSourceSnippetsSimilar(kept, removed, trip),
        ) ?? after[0];
      merges.push({
        tripId,
        entityKind,
        entityName,
        keptText: partner?.text ?? "",
        removedText: removed.text,
        ratio: snippetSimilarity(partner?.text ?? "", removed.text),
        tier: areSnippetEntriesSimilar(partner ?? removed, removed) ? "entries" : "same-source",
        keptRefs: partner?.sourceMentionRefs ?? [],
        removedRefs: removed.sourceMentionRefs,
      });
    }
  }

  // 刻意保留清单：同来源、重合率 ≥ 0.5、但 refs 完全相同的对（同提及历史取舍）
  const keeps: Task339KeptRecord[] = [];
  for (let i = 0; i < after.length; i += 1) {
    for (let j = i + 1; j < after.length; j += 1) {
      const a = after[i];
      const b = after[j];
      const ratio = snippetSimilarity(a.text, b.text);
      if (ratio < 0.5) continue;
      if (a.sourceMentionRefs.length === 0 || b.sourceMentionRefs.length === 0) continue;
      if (refSetKey(a.sourceMentionRefs) !== refSetKey(b.sourceMentionRefs)) continue;
      keeps.push({
        tripId,
        entityKind,
        entityName,
        textA: a.text,
        textB: b.text,
        ratio,
        reason: "refs 完全相同（同提及重复抽取），沿用放宽档既有取舍不合并",
      });
    }
  }
  return { cleaned, merges, keeps };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const dataDir = path.join(import.meta.dirname, "../../data");
  const files = (await fs.readdir(dataDir)).filter(
    (file) => file.endsWith(".json") && isValidTripId(file.slice(0, -".json".length)),
  );
  console.log(
    `[FIX-339] 扫描 ${dataDir}：共 ${files.length} 个行程文件${dryRun ? "（dry-run：不写盘、不备份）" : ""}`,
  );

  let scanned = 0;
  let changedTrips = 0;
  const allMerges: Task339MergeRecord[] = [];
  const allKeeps: Task339KeptRecord[] = [];
  const failures: string[] = [];

  for (const file of files) {
    const tripId = file.slice(0, -".json".length);
    let trip: Trip | null;
    try {
      trip = await tripStore.load(tripId);
    } catch (error) {
      failures.push(tripId);
      console.error(`[FIX-339] ${tripId} 读取失败（损坏拒载？），跳过：`, error);
      continue;
    }
    if (trip === null) continue;
    scanned += 1;

    let changed = false;
    for (const [id, visit] of Object.entries(trip.visits ?? {})) {
      const { cleaned, merges, keeps } = cleanEntityWithReport(trip, visit, tripId);
      allMerges.push(...merges);
      allKeeps.push(...keeps);
      if (cleaned !== visit) {
        trip.visits[id] = cleaned;
        changed = true;
      }
    }
    for (const [id, stop] of Object.entries(trip.stops ?? {})) {
      const { cleaned, merges, keeps } = cleanEntityWithReport(trip, stop, tripId);
      allMerges.push(...merges);
      allKeeps.push(...keeps);
      if (cleaned !== stop) {
        trip.stops[id] = cleaned;
        changed = true;
      }
    }

    if (!changed) continue; // 无变更不写盘
    if (dryRun) {
      changedTrips += 1;
      continue;
    }

    try {
      // 备份先行：写盘失败也能原样回滚（后缀 .bak-task339 不被行程遍历误读）
      const jsonPath = path.join(dataDir, file);
      await fs.copyFile(jsonPath, `${jsonPath}.bak-task339`);
      await tripStore.save(trip); // 一致性校验 + version 自增 + 原子写
      changedTrips += 1;
      console.log(`[FIX-339] ${tripId}：已备份 ${path.basename(jsonPath)}.bak-task339 并写盘`);
    } catch (error) {
      failures.push(tripId);
      console.error(`[FIX-339] ${tripId} 写盘失败（一致性校验拒绝？），内存变更已丢弃：`, error);
    }
  }

  // ===== 报告：合并清单 + 刻意保留清单 =====
  console.log(`[FIX-339] ===== 合并清单（共 ${allMerges.length} 对）=====`);
  for (const record of allMerges) {
    console.log(
      [
        `[FIX-339] 合并 | ${record.tripId} | ${record.entityKind}「${record.entityName}」| 档位=${record.tier} | 重合率=${record.ratio.toFixed(3)}`,
        `    保留「${record.keptText}」refs=${JSON.stringify(record.keptRefs)}`,
        `    移除「${record.removedText}」refs=${JSON.stringify(record.removedRefs)}`,
      ].join("\n"),
    );
  }
  console.log(`[FIX-339] ===== 刻意保留清单（同来源相似但 refs 完全相同，共 ${allKeeps.length} 对）=====`);
  for (const record of allKeeps) {
    console.log(
      [
        `[FIX-339] 保留 | ${record.tripId} | ${record.entityKind}「${record.entityName}」| 重合率=${record.ratio.toFixed(3)} | ${record.reason}`,
        `    A「${record.textA}」`,
        `    B「${record.textB}」`,
      ].join("\n"),
    );
  }

  // 幂等回读断言（仅实跑）：落盘数据再跑一遍聚焦合并必须全部无变化
  if (!dryRun) {
    for (const file of files) {
      const tripId = file.slice(0, -".json".length);
      if (failures.includes(tripId)) continue;
      const saved = await tripStore.load(tripId);
      if (saved === null) continue;
      for (const visit of Object.values(saved.visits ?? {})) {
        assert.ok(mergeSimilarEntitySnippets(visit, saved) === visit, `回读后 visit ${visit.visitId} 应已无相似亮点可合并`);
      }
      for (const stop of Object.values(saved.stops ?? {})) {
        assert.ok(mergeSimilarEntitySnippets(stop, saved) === stop, `回读后 stop ${stop.stopId} 应已无相似亮点可合并`);
      }
    }
    console.log("[FIX-339] 幂等回读断言通过：全仓再跑一遍聚焦合并均无变化");
  }

  console.log(
    [
      `[FIX-339] 完成：扫描 ${scanned} 个行程，合并 ${allMerges.length} 对 / 涉及 ${changedTrips} 个行程；刻意保留 ${allKeeps.length} 对`,
      failures.length > 0
        ? `  失败 ${failures.length} 个（未写入）：${failures.join("、")}`
        : "  无失败",
    ].join("\n"),
  );
  if (failures.length > 0) process.exitCode = 1;
}

// 主模块守卫：被 import（回归验证复用纯函数）时不触发真实数据修复，
// 只有直接运行（npx tsx server/src/guides/fix-task339.ts）才执行。
const invokedAsMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedAsMain) {
  main().catch((error: unknown) => {
    console.error("[FIX-339] 失败：", error);
    process.exitCode = 1;
  });
}
