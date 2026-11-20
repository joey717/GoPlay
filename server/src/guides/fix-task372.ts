/**
 * Task #372 一次性数据修复：存量行程 freePoiStatus 回填（「查看介绍」入口的数据根因）。
 *
 * ## 背景
 * #371 调研实测：server/data 存量 447 个 Item 仅 3 个有 freePoiStatus（0.7%）。根因是
 * fix-task330 的 CachedPoiMeta 只带 poiLevel / listRank / description 三字段，未带
 * freePoiStatus——FlyAI 缓存里天涯海角（14944986）/ 椰梦长廊（163575）/ 后海村
 * （14937676）等实测均为 FREE，但从未落盘，前端 isFreeAdmissionItem 无法命中，
 * 这些免费点位仍透出橙色「去购票」主按钮。#372 前端改动（shouldShowIntroEntry →
 * 「查看介绍」浅橙入口）依赖该字段，故先修数据根因。
 *
 * ## 本脚本做两件事
 * 1. 代码修复已由本次提交落在 fix-task330.ts：CachedPoiMeta 增 freePoiStatus 字段
 *    （三值白名单，口径同 server/src/flyai/client.ts normalizePoi）+ applyTask330Fixes
 *    增回填分支（缓存非空 + Item 读时默认 null 才写；已有合法值不覆盖）。
 * 2. 数据回填（本脚本 main）：对 server/data 全部存量行程，从**双离线缓存联表**
 *    （eval/cache/flyai 15 文件 37 条记录 + server/cache/flyai 12 文件 52 条记录，
 *    合计约 66 个 POI id）回填 freePoiStatus。**零 FlyAI live 调用**（红线：只读缓存）。
 *
 * ## 联表口径
 * loadFlyAiPoiIndex（fix-task330 导出）逐目录建 providerId → CachedPoiMeta 索引；
 * mergePoiMetaIndex 按「非空优先」合并两目录（同一 POI 两缓存值一致，合并只为
 * 兜底单侧缺字段——如天涯海角仅在 server 侧缓存、椰梦长廊/后海村仅在 eval 侧）。
 *
 * ## 写盘纪律（仿 fix-task351 范式）
 * - 主模块守卫：被 import 时不触发真实修复；
 * - --dry-run：只打印将发生的回填与前后分布，不写盘、不备份；
 * - 备份先行：写盘前复制原文件为 <tripId>.json.bak-task372；
 * - tripStore.load / save：读时迁移 + 一致性校验 + version 自增 + 原子写；
 * - 幂等回读（仅实跑）：验收行程 0a27f726 天涯海角/椰梦长廊/后海村 freePoiStatus=FREE、
 *   西岛保持 NOT_FREE 语义（缓存 NOT_FREE，Item 已有值则不覆盖）、重跑零变更；
 * - 单文件损坏/校验失败只记录并继续，有失败退出码非零。
 *
 * 运行：npx tsx server/src/guides/fix-task372.ts
 * 预演：npx tsx server/src/guides/fix-task372.ts --dry-run
 */

import "../env.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Trip } from "@goplay/shared";
import { itemFreePoiStatus } from "@goplay/shared";
import { isValidTripId, tripStore } from "../persistence/store.js";
import {
  applyTask330Fixes,
  loadFlyAiPoiIndex,
  type CachedPoiMeta,
  type PoiMetaBackfill,
} from "./fix-task330.js";

/** 验收行程（PD 现场行程，截图与回读断言对象） */
const ACCEPTANCE_TRIP_ID = "0a27f726-9c93-48e8-ab68-1d62e9bc685b";

/** 实跑后回读断言的指定点位：名称 → 期望 freePoiStatus（#371 调研 + 缓存实测） */
const EXPECTED_BACKFILL: ReadonlyArray<{ name: string; expected: "FREE" }> = [
  { name: "天涯海角", expected: "FREE" },
  { name: "椰梦长廊", expected: "FREE" },
  { name: "后海村", expected: "FREE" },
];

/**
 * 联表合并两个缓存索引（纯函数，导出供回归验证）：base 缺失的 id 整条补入；
 * 已有 id 按字段「非空优先」填补（与 loadFlyAiPoiIndex 单目录内合并同口径）。
 */
export function mergePoiMetaIndex(
  base: Map<string, CachedPoiMeta>,
  extra: Map<string, CachedPoiMeta>,
): Map<string, CachedPoiMeta> {
  const merged = new Map(base);
  for (const [id, meta] of extra) {
    const existing = merged.get(id);
    if (existing === undefined) {
      merged.set(id, { ...meta });
      continue;
    }
    if (existing.poiLevel === null) existing.poiLevel = meta.poiLevel;
    if (existing.listRank === null) existing.listRank = meta.listRank;
    if (existing.description === null) existing.description = meta.description;
    if (existing.freePoiStatus === null) existing.freePoiStatus = meta.freePoiStatus;
  }
  return merged;
}

/** 从 import.meta.dirname 向上定位仓库根（存在 eval/ 与 server/ 子目录的第一层） */
async function resolveRepoRoot(): Promise<string | null> {
  let dir = import.meta.dirname;
  for (let depth = 0; depth < 6; depth += 1) {
    const hasEval = await fs
      .access(path.join(dir, "eval"))
      .then(() => true)
      .catch(() => false);
    const hasServer = await fs
      .access(path.join(dir, "server"))
      .then(() => true)
      .catch(() => false);
    if (hasEval && hasServer) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** freePoiStatus 分布统计（报告用：回填前后对比 + version 变化） */
function freePoiStatusDistribution(trips: ReadonlyArray<{ trip: Trip; version: number }>): {
  total: number;
  dist: Record<string, number>;
} {
  const dist: Record<string, number> = { FREE: 0, NOT_FREE: 0, UNKNOWN: 0, null: 0 };
  let total = 0;
  for (const { trip } of trips) {
    for (const item of Object.values(trip.itemRegistry)) {
      total += 1;
      const status = itemFreePoiStatus(item);
      dist[status ?? "null"] = (dist[status ?? "null"] ?? 0) + 1;
    }
  }
  return { total, dist };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const root = await resolveRepoRoot();
  if (root === null) {
    console.error("[FIX-372] 未定位到仓库根（eval/ + server/），无法找离线缓存，退出。");
    process.exitCode = 1;
    return;
  }
  const evalCacheDir = path.join(root, "eval", "cache", "flyai");
  const serverCacheDir = path.join(root, "server", "cache", "flyai");
  const evalIndex = await loadFlyAiPoiIndex(evalCacheDir);
  const serverIndex = await loadFlyAiPoiIndex(serverCacheDir);
  const index = mergePoiMetaIndex(evalIndex, serverIndex);
  const withStatus = [...index.values()].filter((meta) => meta.freePoiStatus !== null).length;
  console.log(
    `[FIX-372] 双缓存联表：eval ${evalIndex.size} id + server ${serverIndex.size} id → 合并 ${index.size} id` +
      `（其中 ${withStatus} 个带 freePoiStatus，零 live 调用）`,
  );
  if (index.size === 0 || withStatus === 0) {
    console.error("[FIX-372] 联表索引为空或无 freePoiStatus 数据源，退出。");
    process.exitCode = 1;
    return;
  }

  const dataDir = path.join(import.meta.dirname, "../../data");
  const files = (await fs.readdir(dataDir)).filter(
    (file) => file.endsWith(".json") && isValidTripId(file.slice(0, -".json".length)),
  );
  console.log(
    `[FIX-372] 扫描 ${dataDir}：共 ${files.length} 个行程文件${dryRun ? "（dry-run：不写盘、不备份）" : ""}`,
  );

  // 先全量 load：报告回填前分布与 version 基线
  const loaded: Array<{ tripId: string; trip: Trip; versionBefore: number }> = [];
  const failures: string[] = [];
  for (const file of files) {
    const tripId = file.slice(0, -".json".length);
    try {
      const trip = await tripStore.load(tripId);
      if (trip !== null) loaded.push({ tripId, trip, versionBefore: trip.version });
    } catch (error) {
      failures.push(tripId);
      console.error(`[FIX-372] ${tripId} 读取失败（损坏拒载？），跳过：`, error);
    }
  }
  const before = freePoiStatusDistribution(loaded.map((e) => ({ trip: e.trip, version: e.versionBefore })));
  console.log(
    `[FIX-372] 回填前分布：Item 总数 ${before.total}，FREE=${before.dist.FREE} NOT_FREE=${before.dist.NOT_FREE} UNKNOWN=${before.dist.UNKNOWN} null=${before.dist.null}`,
  );

  let changedTrips = 0;
  let changedItems = 0;
  let changedFields = 0;
  const versionChanges: string[] = [];

  for (const entry of loaded) {
    const { tripId, trip, versionBefore } = entry;
    const backfilled: PoiMetaBackfill[] = applyTask330Fixes(trip, index);
    if (backfilled.length === 0) continue; // 无变更不写盘（不自增 version）

    const statusHits = backfilled.filter((b) => b.fields.includes("freePoiStatus"));
    for (const b of statusHits) {
      const item = trip.itemRegistry[b.itemId];
      console.log(
        `[FIX-372] ${tripId.slice(0, 8)} item ${b.itemId}「${b.name}」(providerId=${b.providerId})：freePoiStatus → ${item?.freePoiStatus}`,
      );
    }
    console.log(
      `[FIX-372] ${tripId.slice(0, 8)}：回填 ${backfilled.length} 个 Item（freePoiStatus ${statusHits.length} 个，其余为 #330 三字段补漏）`,
    );
    changedFields += backfilled.reduce((sum, b) => sum + b.fields.length, 0);

    if (dryRun) {
      changedTrips += 1;
      changedItems += backfilled.length;
      continue;
    }

    try {
      // 备份先行：写盘失败也能原样回滚（后缀 .bak-task372 不被行程遍历误读）
      const jsonPath = path.join(dataDir, `${tripId}.json`);
      await fs.copyFile(jsonPath, `${jsonPath}.bak-task372`);
      await tripStore.save(trip); // 一致性校验 + version 自增 + 原子写
      changedTrips += 1;
      changedItems += backfilled.length;
      versionChanges.push(`${tripId.slice(0, 8)}: v${versionBefore} → v${trip.version}`);
      console.log(`[FIX-372] ${tripId.slice(0, 8)}：已备份 .bak-task372 并写盘（version ${versionBefore} → ${trip.version}）`);
    } catch (error) {
      failures.push(tripId);
      console.error(`[FIX-372] ${tripId} 写盘失败（一致性校验拒绝？），内存变更已丢弃：`, error);
    }
  }

  // 回填后分布（dry-run 用内存态预估；实跑为落盘态）
  const after = freePoiStatusDistribution(loaded.map((e) => ({ trip: e.trip, version: e.trip.version })));
  console.log(
    `[FIX-372] 回填后分布${dryRun ? "（dry-run 预估）" : ""}：Item 总数 ${after.total}，FREE=${after.dist.FREE} NOT_FREE=${after.dist.NOT_FREE} UNKNOWN=${after.dist.UNKNOWN} null=${after.dist.null}`,
  );
  if (versionChanges.length > 0) {
    console.log(`[FIX-372] version 变化（${versionChanges.length} 个行程）：${versionChanges.join("、")}`);
  }

  // ===== 幂等回读断言（仅实跑）=====
  if (!dryRun && changedTrips > 0) {
    const saved = await tripStore.load(ACCEPTANCE_TRIP_ID);
    assert.ok(saved !== null, `回读：验收行程 ${ACCEPTANCE_TRIP_ID} 应可加载`);
    const byName = new Map(Object.values(saved.itemRegistry).map((item) => [item.name, item]));
    for (const spec of EXPECTED_BACKFILL) {
      const item = byName.get(spec.name);
      assert.ok(item !== undefined, `回读：验收行程应有「${spec.name}」`);
      assert.equal(itemFreePoiStatus(item), spec.expected, `回读：「${spec.name}」freePoiStatus 应为 ${spec.expected}`);
    }
    // 西岛：缓存 NOT_FREE，Item 已有值不覆盖 / 原空白则回填 NOT_FREE——两者都不得为 FREE
    const xidao = byName.get("西岛");
    if (xidao !== undefined) {
      assert.notEqual(itemFreePoiStatus(xidao), "FREE", "回读：西岛（NOT_FREE 收费在售）不得被判 FREE");
    }
    // 重跑零变更：已落盘数据上 applyTask330Fixes 不得再产生任何回填
    const rerun = applyTask330Fixes(saved, index);
    assert.equal(rerun.length, 0, `幂等：验收行程重跑应零变更（实际 ${rerun.length} 条）`);
    console.log("[FIX-372] 幂等回读断言通过：天涯海角/椰梦长廊/后海村=FREE、西岛非 FREE、重跑零变更");
  }

  console.log(
    [
      `[FIX-372] 完成：扫描 ${loaded.length} 个行程，回填 ${changedTrips} 个行程 / ${changedItems} 个 Item / ${changedFields} 个字段`,
      failures.length > 0 ? `  失败 ${failures.length} 个（未写入）：${failures.join("、")}` : "  无失败",
    ].join("\n"),
  );
  if (failures.length > 0) process.exitCode = 1;
}

// 主模块守卫：被 import（回归验证复用纯函数）时不触发真实数据修复，
// 只有直接运行（npx tsx server/src/guides/fix-task372.ts）才执行。
const invokedAsMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedAsMain) {
  main().catch((error: unknown) => {
    console.error("[FIX-372] 失败：", error);
    process.exitCode = 1;
  });
}
