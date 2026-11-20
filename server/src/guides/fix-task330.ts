/**
 * Task #330 一次性数据修复：存量行程飞猪 POI 元信息（poiLevel / listRank / description）回填。
 *
 * ## 现场
 * FlyAI search-poi 返回 13 个字段，归一化层（server/src/flyai/client.ts normalizePoi）已
 * 100% 映射到 FliggyPoi，但 FliggyPoi → Item 装配曾丢弃 description / poiLevel / listRank
 * （freePoiStatus 已由 #329 补齐；这三项的透传点已由 #330 任务 A 全部接通）。存量行程的
 * 飞猪点位因此缺这三项，页面看不到 4A/5A 徽标、榜单行与介绍折叠区。PD 现场行程
 * 0a27f726（含西岛等 21 个飞猪点位）需回填到位，以便 PD「晚点刷新看看效果」。
 *
 * ## 数据来源（离线，零 FlyAI live 调用）
 * eval/cache/flyai/*.json 是 FlyAI search-poi 的录制缓存，每条形如
 * { key, query, normalized, recordedAt }，normalized 为归一化后的 FlyAIPoi[]
 * （含 id / poiLevel / listRank / description / freePoiStatus，最后一项由 Task #372 补入索引）。以 POI id（= Item.providerId）为键建索引，
 * 对存量行程 origin="fliggy" 且 providerId 命中的 Item 回填。**不发起任何 live 查询**
 * （遵守红线：FlyAI 只读、禁止全量 59 行程打飞猪）。实测覆盖：缓存 35 个 POI id，
 * 命中 16 个行程 / 38 个 Item；PD 行程 0a27f726 命中 4 个——其中「西岛」(providerId=2611)
 * poiLevel="4" + listRank="海南4A/5A景点榜第2名" + description(124 字) 三项齐全，正是任务
 * 背景样例，刷新即可看到 4A 徽标 + 榜单行 + 介绍折叠区。未命中的点位留待运行时自然升级
 * （assemble 升级路径下次 POI 匹配时按「无信号不回写 null」口径补上）。
 *
 * ## 回填口径（与 assemble 升级路径同口径：无信号不回写 null）
 * 逐字段（poiLevel / listRank / description / freePoiStatus）：仅当**缓存值非空** 且 **Item 当前该字段
 * 缺失 / null / 空白**时才写入；缓存值为 null 一律不写（不覆盖、不伪造、不制造 null 噪声）；
 * Item 已有非空值一律不覆盖（保守 + 幂等：运行时可能已写入更新的值）。
 *
 * 幂等：按上述口径，第二次执行对已回填 Item 为空操作；无变更的行程不写盘（不自增 version）。
 * 备份：写盘前把原文件复制为 `<tripId>.json.bak-task330`（与 .bak-task329 同命名范式；
 * 后缀不以 .json 结尾，因此不会被任何遍历 data 目录的脚本误读为行程）。
 *
 * 写盘纪律：逐文件经 tripStore.load / save——load 自带读时迁移与损坏拒载；save 内置
 * 一致性校验 + version 自增 + updatedAt + 临时文件原子写。本修复只动 Item 的三个可选
 * 字段，不影响时间轴 / 派生字段，无需重算。单个文件损坏或校验失败只记录并继续，
 * 不中断整批；有失败时退出码非零。
 *
 * 可复用纯函数：applyTask330Fixes（无 IO，就地把命中的 Item 回填，返回明细）与
 * loadFlyAiPoiIndex（读缓存建索引）——server/src/ai/verify-task330.ts 直接 import 做回归断言。
 *
 * 运行：npx tsx server/src/guides/fix-task330.ts
 * 预演：npx tsx server/src/guides/fix-task330.ts --dry-run（只打印将发生的变更，不写盘、不备份）
 */

import "../env.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FreePoiStatus, Trip } from "@goplay/shared";
import { itemFreePoiStatus } from "@goplay/shared";
import { isValidTripId, tripStore } from "../persistence/store.js";

/**
 * 缓存里一条 FlyAIPoi 归一化记录中本任务关心的字段（id 作为索引键，故不单列）。
 * freePoiStatus 由 Task #372 补入：#330 当时未带该字段，导致存量 447 个 Item 仅 3 个
 * 有 freePoiStatus（0.7%），天涯海角/椰梦长廊等 FlyAI 实测 FREE 的点位未落盘，
 * 前端 isFreeAdmissionItem 无法命中（#372「查看介绍」入口的数据根因）。
 */
export interface CachedPoiMeta {
  poiLevel: string | null;
  listRank: string | null;
  description: string | null;
  freePoiStatus: FreePoiStatus | null;
}

/** 本任务回填的字段名（freePoiStatus 由 Task #372 补入） */
export type PoiMetaField = "poiLevel" | "listRank" | "description" | "freePoiStatus";

/** 一条回填记录（日志与回归验证共用） */
export interface PoiMetaBackfill {
  itemId: string;
  name: string;
  providerId: string;
  /** 本次实际写入的字段（缓存有值且 Item 原为空白） */
  fields: PoiMetaField[];
}

/** 值非空判定：非字符串 / null / 纯空白一律视为「空」（与 shared/poiMeta.ts 读时默认同口径） */
function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * freePoiStatus 三值白名单（Task #372，口径同 server/src/flyai/client.ts normalizePoi：
 * nullableString + FREE/NOT_FREE/UNKNOWN 之外一律回落 null，不写脏值）。
 */
function freePoiStatusOrNull(value: unknown): FreePoiStatus | null {
  const status = strOrNull(value);
  return status === "NOT_FREE" || status === "FREE" || status === "UNKNOWN" ? status : null;
}

/** Item 当前字段是否「空白」（缺失 / null / 纯空白）——空白才允许回填 */
function isBlank(value: string | null | undefined): boolean {
  return value === undefined || value === null || value.trim() === "";
}

/** 从缓存文件解析出 normalized 记录数组（结构不符 / 损坏一律返回空，不抛错） */
function extractNormalized(parsed: unknown): Array<Record<string, unknown>> {
  if (typeof parsed !== "object" || parsed === null) return [];
  const norm = (parsed as { normalized?: unknown }).normalized;
  if (!Array.isArray(norm)) return [];
  return norm.filter((record): record is Record<string, unknown> => typeof record === "object" && record !== null);
}

/**
 * 读取 eval/cache/flyai 全部录制缓存，建 providerId(=POI id) → 三字段 索引。
 * 同一 id 出现在多条查询里时按「非空优先」合并（不同 query 返回同一 POI 数据应一致，
 * 合并只为兜底某条缺字段的情况）。单个缓存文件损坏只跳过，不中断整批。
 */
export async function loadFlyAiPoiIndex(cacheDir: string): Promise<Map<string, CachedPoiMeta>> {
  const index = new Map<string, CachedPoiMeta>();
  let files: string[];
  try {
    files = (await fs.readdir(cacheDir)).filter((file) => file.endsWith(".json"));
  } catch {
    return index; // 缓存目录不存在 → 空索引（调用方据此判断离线数据是否可用）
  }
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(path.join(cacheDir, file), "utf8"));
    } catch {
      continue;
    }
    for (const record of extractNormalized(parsed)) {
      const rawId = record.id;
      const id = typeof rawId === "string" ? rawId : rawId !== undefined && rawId !== null ? String(rawId) : null;
      if (id === null) continue;
      const meta: CachedPoiMeta = {
        poiLevel: strOrNull(record.poiLevel),
        listRank: strOrNull(record.listRank),
        description: strOrNull(record.description),
        freePoiStatus: freePoiStatusOrNull(record.freePoiStatus),
      };
      const existing = index.get(id);
      if (existing === undefined) {
        index.set(id, meta);
      } else {
        if (existing.poiLevel === null) existing.poiLevel = meta.poiLevel;
        if (existing.listRank === null) existing.listRank = meta.listRank;
        if (existing.description === null) existing.description = meta.description;
        if (existing.freePoiStatus === null) existing.freePoiStatus = meta.freePoiStatus;
      }
    }
  }
  return index;
}

/**
 * 纯函数：就地把命中缓存索引的飞猪 Item 回填 poiLevel / listRank / description /
 * freePoiStatus（第四项由 Task #372 补入），返回明细。
 * 口径见文件头「回填口径」：缓存非空 + Item 空白才写；不覆盖已有非空值；不写 null。
 * 只动这四个可选字段，name / providerId / jumpUrl / sourceEvidenceRefs 等一律不改。
 */
export function applyTask330Fixes(trip: Trip, index: Map<string, CachedPoiMeta>): PoiMetaBackfill[] {
  const backfilled: PoiMetaBackfill[] = [];
  for (const item of Object.values(trip.itemRegistry)) {
    if (item.origin !== "fliggy" || item.providerId === null) continue;
    const cached = index.get(item.providerId);
    if (cached === undefined) continue;
    const fields: PoiMetaField[] = [];
    if (cached.poiLevel !== null && isBlank(item.poiLevel)) {
      item.poiLevel = cached.poiLevel;
      fields.push("poiLevel");
    }
    if (cached.listRank !== null && isBlank(item.listRank)) {
      item.listRank = cached.listRank;
      fields.push("listRank");
    }
    if (cached.description !== null && isBlank(item.description)) {
      item.description = cached.description;
      fields.push("description");
    }
    // Task #372 回填分支：读时默认经 itemFreePoiStatus（非法值视同空白）；
    // 已有合法三值（含 #329 装配路径写入的）一律不覆盖，幂等口径不变。
    if (cached.freePoiStatus !== null && itemFreePoiStatus(item) === null) {
      item.freePoiStatus = cached.freePoiStatus;
      fields.push("freePoiStatus");
    }
    if (fields.length > 0) {
      backfilled.push({ itemId: item.itemId, name: item.name, providerId: item.providerId, fields });
    }
  }
  return backfilled;
}

/** 从 import.meta.dirname 向上定位 eval/cache/flyai（兼容 tsx 源码执行与 dist 执行） */
async function resolveFlyAiCacheDir(): Promise<string | null> {
  let dir = import.meta.dirname;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(dir, "eval", "cache", "flyai");
    const ok = await fs
      .access(candidate)
      .then(() => true)
      .catch(() => false);
    if (ok) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const cacheDir = await resolveFlyAiCacheDir();
  if (cacheDir === null) {
    console.error("[FIX-330] 未找到 eval/cache/flyai 离线缓存目录，无法离线回填（不发起 live 查询）。");
    process.exitCode = 1;
    return;
  }
  const index = await loadFlyAiPoiIndex(cacheDir);
  console.log(`[FIX-330] 离线缓存 ${cacheDir}：索引 ${index.size} 个飞猪 POI id（零 live 调用）`);
  if (index.size === 0) {
    console.error("[FIX-330] 缓存索引为空，无可回填数据源，退出。");
    process.exitCode = 1;
    return;
  }

  const dataDir = path.join(import.meta.dirname, "../../data");
  const files = (await fs.readdir(dataDir)).filter(
    (file) => file.endsWith(".json") && isValidTripId(file.slice(0, -".json".length)),
  );
  console.log(
    `[FIX-330] 扫描 ${dataDir}：共 ${files.length} 个行程文件${dryRun ? "（dry-run：不写盘、不备份）" : ""}`,
  );

  let scanned = 0;
  let changedTrips = 0;
  let changedItems = 0;
  let changedFields = 0;
  const failures: string[] = [];

  for (const file of files) {
    const tripId = file.slice(0, -".json".length);
    let trip: Trip | null;
    try {
      trip = await tripStore.load(tripId);
    } catch (error) {
      failures.push(tripId);
      console.error(`[FIX-330] ${tripId} 读取失败（损坏拒载？），跳过：`, error);
      continue;
    }
    if (trip === null) continue;
    scanned += 1;

    const backfilled = applyTask330Fixes(trip, index);
    if (backfilled.length === 0) {
      console.log(`[FIX-330] ${tripId}：改动 0 条`);
      continue; // 无变更不写盘
    }

    for (const entry of backfilled) {
      console.log(
        `[FIX-330] ${tripId} item ${entry.itemId}「${entry.name}」(providerId=${entry.providerId})：` +
          `回填 ${entry.fields.join(" + ")}`,
      );
    }
    console.log(`[FIX-330] ${tripId}：改动 ${backfilled.length} 条`);
    changedFields += backfilled.reduce((sum, entry) => sum + entry.fields.length, 0);

    if (dryRun) {
      changedTrips += 1;
      changedItems += backfilled.length;
      continue;
    }

    try {
      // 备份先行：写盘失败也能原样回滚（后缀 .bak-task330 不被行程遍历误读）
      const jsonPath = path.join(dataDir, file);
      await fs.copyFile(jsonPath, `${jsonPath}.bak-task330`);
      await tripStore.save(trip); // 一致性校验 + version 自增 + 原子写
      changedTrips += 1;
      changedItems += backfilled.length;
      console.log(`[FIX-330] ${tripId}：已备份 ${path.basename(jsonPath)}.bak-task330 并写盘`);
    } catch (error) {
      failures.push(tripId);
      console.error(`[FIX-330] ${tripId} 写盘失败（一致性校验拒绝？），内存变更已丢弃：`, error);
    }
  }

  console.log(
    [
      `[FIX-330] 完成：扫描 ${scanned} 个行程，回填 ${changedTrips} 个行程 / ${changedItems} 个 Item / ${changedFields} 个字段（poiLevel/listRank/description）`,
      failures.length > 0
        ? `  失败 ${failures.length} 个（未写入）：${failures.join("、")}`
        : "  无失败",
    ].join("\n"),
  );
  if (failures.length > 0) process.exitCode = 1;
}

// 主模块守卫：被 import（回归验证复用纯函数）时不触发真实数据修复，
// 只有直接运行（npx tsx server/src/guides/fix-task330.ts）才执行。
const invokedAsMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedAsMain) {
  main().catch((error: unknown) => {
    console.error("[FIX-330] 失败：", error);
    process.exitCode = 1;
  });
}
