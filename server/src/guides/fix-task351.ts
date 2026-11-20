/**
 * Task #351 一次性数据修复：PD 裁量「相似的都合并」——把 #339/#342 分析中刻意
 * 保留的相似亮点对在数据层指名收敛为 1 条（保留较长者，sourceMentionRefs 全并）。
 *
 * ## 背景
 * #339 第三档只收敛「同来源 + 引用组合不同 + LCS ≥ 0.5」的对；refs 完全相同的
 * 同提及对（太阳湾公路 0.588 / 鹿回头 0.563 / 南山 0.529）与跨来源相似对
 * （椰林沙滩 0.455）当时刻意保留。#342 又在展示层对 [0.40,0.50) 区间做了聚类。
 * 本次 PD 对保留清单全部裁量为合并（2026-11-04），沿用玻璃栈道 / fix-task339
 * 先例做一次性存量清理，**不新增任何自动去重规则 / 阈值**——逐对指名合并。
 *
 * ## 四对裁量与定位结果（2026-11-04 全仓实测扫描）
 * 1. 鹿回头（trip 0a27f726，visit_0eb177e9…_1）：「不想爬山可坐观光车，又凉快又
 *    省力」vs「天黑后看城市夜景最佳，不想爬山可坐观光车」（sim 0.563，refs 同提及
 *    ev_retry_b2777e27:m1）→ 合并保留较长条（夜景条）；
 * 2. 太阳湾公路（**trip 48275e19**，stop_from_visit_41b20875…_1，不在验收行程
 *    0a27f726——0a27f726 的太阳湾公路 stop 只有 1 条 snippet）：「观景台限时7分钟，
 *    提前想好姿势速拍」vs「有专门观景台可拍照但限时7分钟，速战速决」（sim 0.588 /
 *    连续段 6 字，refs 同提及 ev_retry_ad80301a:m1）→ 合并保留较长条；
 * 3. 南山文化旅游区（trip 0a27f726，visit_4f13fc50…_1）：「园区挺大尽早出发，穿
 *    素色衣服拍照更搭」vs「穿素色衣服拍照更搭，别穿太短太暴露」（sim 0.529，互补贴士，
 *    PD 明确裁量合并）→ 两条等长（17 字），按「保留较长条、等长取先到者」口径保留
 *    A 条，refs 全并；
 * 4. 椰林沙滩 vs 珊瑚墙（sim 0.455，跨来源）→ **live 数据定位不到，如实报备不强行
 *    匹配**：该对仅存在于 d0174797 行程的历史备份 d0174797….json.bak-task212
 *    （stop_2d092702「椰林沙滩」两条），该行程 live 版本已归档删除（data-archive
 *    亦无），全仓 live 数据无「椰林沙滩」实体、珊瑚墙实体 snippets 均为 0。
 *
 * ## 合并口径
 * - 定位：按实体显示名（itemRegistry 名称 / customName，与 fix-task339 同源）+
 *   snippet 全文精确匹配，两者在目标行程内必须唯一命中，否则记失败不动数据；
 * - 保留条 = 文本较长者（等长取列表中先到者），snippetId / claimKind 随保留条；
 * - sourceMentionRefs = 保留条 refs + 被并条 refs 顺序拼接后按字面去重（三对
 *   实测 refs 均相同或单一，并集不膨胀）；
 * - 只动 visit/stop 的 guideSnippets；攻略原文 sheet / 证据数据 / 实体级引用不动。
 *   #348/#350 展示层改动不涉及数据字段，无冲突；
 * - 合并后数据层与展示层均不再触达这些对：三档判定阈值不变（同提及 0.529~0.588
 *   仍低于放宽档 0.8；展示层 [0.40,0.50) 上界不含 0.529+），幂等由「被并条已不存在」
 *   保证，再跑一遍零变更。
 *
 * ## 写盘纪律（仿 fix-task339 范式）
 * - 主模块守卫：被 import 时不触发真实修复；
 * - --dry-run：只打印将合并的对与定位结果，不写盘、不备份；
 * - 备份先行：写盘前复制原文件为 <tripId>.json.bak-task351；
 * - tripStore.load / save：读时迁移 + 一致性校验 + version 自增 + 原子写；
 * - 定位不到 / 形态不符只记录并继续，有失败退出码非零；
 * - 幂等：实跑后回读逐对断言（被并条已消失、保留条 refs 已合并），重跑零变更。
 *
 * 运行：npx tsx server/src/guides/fix-task351.ts
 * 预演：npx tsx server/src/guides/fix-task351.ts --dry-run
 */

import "../env.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GuideSnippet, Stop, Trip, Visit } from "@goplay/shared";
import { snippetSimilarity } from "@goplay/shared";
import { tripStore } from "../persistence/store.js";

/** 一对指名合并的规格：行程 + 实体显示名 + 两条 snippet 全文 */
export interface Task351PairSpec {
  tripId: string;
  entityName: string;
  textA: string;
  textB: string;
  /** PD 裁量依据（报告用）：#339/#342 分析时的实测重合率与形态 */
  rationale: string;
}

/** 一对合并的执行结果（报告用） */
export interface Task351PairResult {
  spec: Task351PairSpec;
  status: "merged" | "already" | "not-found";
  entityKind?: "visit" | "stop";
  entityId?: string;
  keptText?: string;
  removedText?: string;
  ratio?: number;
  keptRefs?: string[];
  removedRefs?: string[];
  mergedRefs?: string[];
  detail?: string;
}

/** PD 裁量的四对（第 4 对 live 数据不存在，见文件头注释，仍列入规格以便如实报备） */
export const TASK351_PAIRS: Task351PairSpec[] = [
  {
    tripId: "0a27f726-9c93-48e8-ab68-1d62e9bc685b",
    entityName: "鹿回头",
    textA: "不想爬山可坐观光车，又凉快又省力",
    textB: "天黑后看城市夜景最佳，不想爬山可坐观光车",
    rationale: "sim 0.563，refs 同提及（ev_retry_b2777e27:m1），保留较长条（夜景条）",
  },
  {
    tripId: "48275e19-c7cb-417b-8ef7-57b04e097cf4",
    entityName: "太阳湾公路",
    textA: "观景台限时7分钟，提前想好姿势速拍",
    textB: "有专门观景台可拍照但限时7分钟，速战速决",
    rationale: "sim 0.588 / 连续段 6 字，近改写，refs 同提及（ev_retry_ad80301a:m1），保留较长条",
  },
  {
    tripId: "0a27f726-9c93-48e8-ab68-1d62e9bc685b",
    entityName: "南山文化旅游区",
    textA: "园区挺大尽早出发，穿素色衣服拍照更搭",
    textB: "穿素色衣服拍照更搭，别穿太短太暴露",
    rationale: "sim 0.529，互补贴士 PD 明确裁量合并；两条等长（17 字）→ 保留先到条，refs 全并",
  },
  {
    tripId: "d0174797-f87f-4726-8c55-833840235e51",
    entityName: "椰林沙滩",
    textA: "椰林沙滩有椰子树出片且不排队，珊瑚墙前会经过",
    textB: "木门和歪脖子椰子树人多要排队，椰林沙滩同样出片且不排队",
    rationale: "sim 0.455 跨来源，PD 明确裁量合并；live 行程已归档删除，仅存 .bak-task212 历史备份 → 定位不到，如实报备不动数据",
  },
];

/** 实体显示名（与 fix-task339 entityDisplayName 同口径） */
function entityDisplayName(trip: Trip, entity: Visit | Stop): string {
  if ("stopId" in entity) {
    return (
      trip.itemRegistry?.[entity.matchedPointRef ?? ""]?.name ?? entity.customName ?? entity.stopId
    );
  }
  return trip.itemRegistry?.[entity.pointRef]?.name ?? entity.visitId;
}

/** refs 顺序拼接 + 字面去重（保留条在前，被并条追加） */
export function unionRefs(keptRefs: readonly string[], removedRefs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of [...keptRefs, ...removedRefs]) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
}

/**
 * 纯函数：在行程内定位一对并执行合并（直接改 trip 内存对象）。
 * 返回结果供报告；status=already / not-found 时不改任何数据。
 */
export function mergeNamedPair(trip: Trip, spec: Task351PairSpec): Task351PairResult {
  const hits: { kind: "visit" | "stop"; id: string; entity: Visit | Stop }[] = [];
  for (const [id, visit] of Object.entries(trip.visits ?? {})) {
    if (entityDisplayName(trip, visit) === spec.entityName) hits.push({ kind: "visit", id, entity: visit });
  }
  for (const [id, stop] of Object.entries(trip.stops ?? {})) {
    if (entityDisplayName(trip, stop) === spec.entityName) hits.push({ kind: "stop", id, entity: stop });
  }
  if (hits.length === 0) {
    return { spec, status: "not-found", detail: `行程内无实体「${spec.entityName}」` };
  }
  if (hits.length > 1) {
    return { spec, status: "not-found", detail: `实体名「${spec.entityName}」命中 ${hits.length} 处，不强行匹配` };
  }
  const hit = hits[0];
  const snippets: GuideSnippet[] = Array.isArray(hit.entity.guideSnippets) ? hit.entity.guideSnippets : [];
  const matchesA = snippets.filter((s) => s.text === spec.textA);
  const matchesB = snippets.filter((s) => s.text === spec.textB);
  if (matchesA.length === 0 && matchesB.length === 0) {
    // 两条都不在：若行程里该实体只剩 1 条且文本是其中之一，视为已合并（幂等重跑形态）
    return { spec, status: "not-found", detail: `实体「${spec.entityName}」（${hit.id}）上两条指定 snippet 均不存在（现有 ${snippets.length} 条）` };
  }
  if (matchesA.length === 0 || matchesB.length === 0) {
    const present = matchesA.length > 0 ? spec.textA : spec.textB;
    const missing = matchesA.length > 0 ? spec.textB : spec.textA;
    return {
      spec,
      status: "already",
      entityKind: hit.kind,
      entityId: hit.id,
      keptText: present,
      detail: `被并条「${missing}」已不存在，保留条在位（视为已合并）`,
    };
  }
  if (matchesA.length > 1 || matchesB.length > 1) {
    return { spec, status: "not-found", detail: `snippet 全文匹配非唯一（A×${matchesA.length} B×${matchesB.length}），不强行匹配` };
  }
  const a = matchesA[0];
  const b = matchesB[0];
  // 保留较长条；等长取列表中先到者（南山对两条均 17 字 → 保留 A）
  const indexA = snippets.indexOf(a);
  const indexB = snippets.indexOf(b);
  const keepFirst = a.text.length === b.text.length ? indexA < indexB : a.text.length > b.text.length;
  const kept = keepFirst ? a : b;
  const removed = keepFirst ? b : a;
  const mergedRefs = unionRefs(kept.sourceMentionRefs, removed.sourceMentionRefs);
  const nextSnippets = snippets
    .filter((s) => s !== removed)
    .map((s) => (s === kept ? { ...kept, sourceMentionRefs: mergedRefs } : s));
  (hit.entity as Visit & Stop).guideSnippets = nextSnippets;
  return {
    spec,
    status: "merged",
    entityKind: hit.kind,
    entityId: hit.id,
    keptText: kept.text,
    removedText: removed.text,
    ratio: snippetSimilarity(a.text, b.text),
    keptRefs: [...kept.sourceMentionRefs],
    removedRefs: [...removed.sourceMentionRefs],
    mergedRefs,
  };
}

/** 回读断言（实跑后）：被并条消失、保留条在位且 refs = 全并集 */
function assertPairMerged(trip: Trip, spec: Task351PairSpec, expectRefs: string[]): void {
  const entities = [
    ...Object.values(trip.visits ?? {}),
    ...Object.values(trip.stops ?? {}),
  ].filter((e) => entityDisplayName(trip, e) === spec.entityName);
  assert.equal(entities.length, 1, `回读：实体「${spec.entityName}」应唯一`);
  const snippets = entities[0].guideSnippets ?? [];
  assert.equal(
    snippets.filter((s) => s.text === spec.textA || s.text === spec.textB).length,
    1,
    `回读：「${spec.entityName}」两条指定 snippet 应已收敛为 1 条`,
  );
  const keptSnippet = snippets.find((s) => s.text === spec.textA || s.text === spec.textB);
  assert.deepEqual(keptSnippet?.sourceMentionRefs, expectRefs, `回读：「${spec.entityName}」保留条 refs 应为全并集`);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const dataDir = path.join(import.meta.dirname, "../../data");
  console.log(`[FIX-351] 指名合并 ${TASK351_PAIRS.length} 对（PD 裁量：相似的都合并）${dryRun ? "（dry-run：不写盘、不备份）" : ""}`);

  // 按行程分组执行（一个行程可能承载多对）
  const tripIds = [...new Set(TASK351_PAIRS.map((spec) => spec.tripId))];
  const results: Task351PairResult[] = [];
  const failures: string[] = [];

  for (const tripId of tripIds) {
    const specs = TASK351_PAIRS.filter((spec) => spec.tripId === tripId);
    let trip: Trip | null = null;
    try {
      trip = await tripStore.load(tripId);
    } catch (error) {
      for (const spec of specs) {
        failures.push(`${tripId}「${spec.entityName}」`);
        results.push({ spec, status: "not-found", detail: `行程读取失败：${String(error)}` });
      }
      continue;
    }
    if (trip === null) {
      for (const spec of specs) {
        results.push({ spec, status: "not-found", detail: "行程文件不存在（live 数据已归档删除？）——如实报备不强行匹配" });
      }
      continue;
    }

    let changed = false;
    for (const spec of specs) {
      const result = mergeNamedPair(trip, spec);
      results.push(result);
      if (result.status === "merged") changed = true;
    }
    if (!changed || dryRun) continue;

    try {
      const jsonPath = path.join(dataDir, `${tripId}.json`);
      await fs.copyFile(jsonPath, `${jsonPath}.bak-task351`);
      await tripStore.save(trip); // 一致性校验 + version 自增 + 原子写
      console.log(`[FIX-351] ${tripId}：已备份 ${path.basename(jsonPath)}.bak-task351 并写盘`);
    } catch (error) {
      for (const spec of specs) failures.push(`${tripId}「${spec.entityName}」`);
      console.error(`[FIX-351] ${tripId} 写盘失败（一致性校验拒绝？），内存变更已丢弃：`, error);
    }
  }

  // ===== 报告 =====
  console.log(`[FIX-351] ===== 逐对结果 =====`);
  for (const result of results) {
    const head = `[FIX-351] ${result.status} | ${result.spec.tripId.slice(0, 8)} |「${result.spec.entityName}」| ${result.spec.rationale}`;
    if (result.status === "merged") {
      console.log(
        [
          head,
          `    实体=${result.entityKind} ${result.entityId} 重合率=${result.ratio?.toFixed(3)}`,
          `    保留「${result.keptText}」refs=${JSON.stringify(result.keptRefs)}`,
          `    并入「${result.removedText}」refs=${JSON.stringify(result.removedRefs)}`,
          `    合并后 refs=${JSON.stringify(result.mergedRefs)}（共 ${result.mergedRefs?.length} 条）`,
        ].join("\n"),
      );
    } else {
      console.log([head, `    ${result.detail ?? ""}`].join("\n"));
    }
  }

  // 幂等回读断言（仅实跑）：本次合并成功的对回读校验 + 全部对重跑必须零变更
  if (!dryRun) {
    const mergedResults = results.filter((r) => r.status === "merged");
    if (mergedResults.length > 0) {
      for (const tripId of [...new Set(mergedResults.map((r) => r.spec.tripId))]) {
        const saved = await tripStore.load(tripId);
        assert.ok(saved !== null, `回读：${tripId} 应可加载`);
        for (const result of mergedResults.filter((r) => r.spec.tripId === tripId)) {
          assertPairMerged(saved, result.spec, result.mergedRefs ?? []);
        }
        // 重跑零变更：所有指名对在已落盘数据上不得再产生 merged
        for (const spec of TASK351_PAIRS.filter((s) => s.tripId === tripId)) {
          const rerun = mergeNamedPair(saved, spec);
          assert.notEqual(rerun.status, "merged", `幂等：重跑「${spec.entityName}」不得再次合并`);
        }
      }
      console.log("[FIX-351] 幂等回读断言通过：合并对各收敛为 1 条、refs 全并，重跑零变更");
    }
  }

  const merged = results.filter((r) => r.status === "merged").length;
  const already = results.filter((r) => r.status === "already").length;
  const notFound = results.filter((r) => r.status === "not-found").length;
  console.log(
    [
      `[FIX-351] 完成：本次合并 ${merged} 对；已合并（幂等）${already} 对；定位不到 ${notFound} 对（如实报备）`,
      failures.length > 0 ? `  失败 ${failures.length} 个：${failures.join("、")}` : "  无失败",
    ].join("\n"),
  );
  if (failures.length > 0) process.exitCode = 1;
}

// 主模块守卫：被 import 时不触发真实数据修复，只有直接运行才执行
const invokedAsMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedAsMain) {
  main().catch((error: unknown) => {
    console.error("[FIX-351] 失败：", error);
    process.exitCode = 1;
  });
}
