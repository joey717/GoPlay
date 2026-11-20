/**
 * Task #332 一次性数据修复：用真实 FlyAI live 搜索补全存量行程中缺失的 poiLevel/listRank/description。
 *
 * ## 背景
 * fix-task330.ts 基于 eval/cache/flyai 离线缓存回填了 16 个行程 / 38 个 Item，但缓存仅覆盖 35 个 POI。
 * PD 行程 0a27f726 中仍有 20 个飞猪点位（亚龙湾森林公园、蜈支洲岛等）三项为空——本脚本通过
 * HTTP 调用已运行的 dev server（localhost:8787）的 /api/flyai/search 端点做真实 FlyAI 查询补全。
 *
 * ## 设计
 * - 复用 fix-task330.ts 的 `applyTask330Fixes` 纯函数与全部安全范式
 * - 并发控制 2（FlyAI 有额度限制）；单次失败最多重试 1 次后跳过
 * - 用 providerId（= FlyAI POI id）精确匹配返回结果，避免同名误匹配
 * - 备份后缀 `.bak-task332`（与 #330 区分）
 * - 回填口径沿用 #330：仅 origin=fliggy + providerId 命中；来源非空 + Item 空白才写；不覆盖、不回写 null
 *
 * 运行：npx tsx server/src/guides/fix-task332-live.ts
 * 预演：npx tsx server/src/guides/fix-task332-live.ts --dry-run
 */

import "../env.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Trip } from "@goplay/shared";
import { isValidTripId, tripStore } from "../persistence/store.js";
import { applyTask330Fixes, type CachedPoiMeta, type PoiMetaBackfill } from "./fix-task330.js";

// ===== 配置 =====
const FLYAI_BASE = "http://localhost:8787/api/flyai/search";
const CONCURRENCY = 2;
const MAX_RETRIES = 1;
const BACKUP_SUFFIX = ".bak-task332";

// ===== 工具函数 =====
function isBlank(value: string | null | undefined): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

interface GapPoi {
  providerId: string;
  name: string;
  city: string;
}

interface FlyAiNormalizedPoi {
  id: string;
  name: string;
  poiLevel: string | null;
  listRank: string | null;
  description: string | null;
  /** Task #372：服务端 normalizePoi 已做三值白名单，非法值已回落 null */
  freePoiStatus?: "FREE" | "NOT_FREE" | "UNKNOWN" | null;
  [key: string]: unknown;
}

interface FlyAiSearchResponse {
  normalized: FlyAiNormalizedPoi[];
  latencyMs?: number;
  [key: string]: unknown;
}

/** 并发池：限制同时运行的异步任务数量 */
async function asyncPool<T, R>(
  concurrency: number,
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  const executing = new Set<Promise<void>>();

  for (let i = 0; i < items.length; i++) {
    const p = fn(items[i]!, i).then((r) => {
      results[i] = r;
    });
    const wrapped = p.then(
      () => { executing.delete(wrapped); },
      () => { executing.delete(wrapped); },
    );
    executing.add(wrapped);
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
  return results;
}

/** 单次 FlyAI POI 搜索（通过 dev server HTTP 代理） */
async function searchPoiLive(name: string, city: string): Promise<FlyAiNormalizedPoi[]> {
  const query = `${city} ${name}`;
  const url = `${FLYAI_BASE}?type=poi&q=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100_000); // 100s 超时（含 CLI 90s）
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    const data = (await resp.json()) as FlyAiSearchResponse;
    return Array.isArray(data.normalized) ? data.normalized : [];
  } finally {
    clearTimeout(timer);
  }
}

/** 带重试的 FlyAI 查询，返回精确匹配 providerId 的 CachedPoiMeta 或 null */
async function queryOnePoi(
  gap: GapPoi,
  index: number,
  total: number,
): Promise<{ providerId: string; meta: CachedPoiMeta | null; error: string | null }> {
  const prefix = `[${index + 1}/${total}]`;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const results = await searchPoiLive(gap.name, gap.city);
      // 精确匹配 providerId
      const matched = results.find((r) => r.id === gap.providerId);
      if (!matched) {
        const msg = `${prefix}「${gap.name}」(id=${gap.providerId})：FlyAI 返回 ${results.length} 条，无精确 id 匹配，跳过`;
        console.log(msg);
        return { providerId: gap.providerId, meta: null, error: "no_id_match" };
      }
      const meta: CachedPoiMeta = {
        poiLevel: typeof matched.poiLevel === "string" && matched.poiLevel.trim() !== "" ? matched.poiLevel : null,
        listRank: typeof matched.listRank === "string" && matched.listRank.trim() !== "" ? matched.listRank : null,
        description: typeof matched.description === "string" && matched.description.trim() !== "" ? matched.description : null,
        // freePoiStatus 字段由 Task #372 补入 CachedPoiMeta；normalizePoi 已做过三值白名单，直透
        freePoiStatus: matched.freePoiStatus ?? null,
      };
      const fields = [meta.poiLevel && "poiLevel", meta.listRank && "listRank", meta.description && "description", meta.freePoiStatus && "freePoiStatus"].filter(Boolean);
      console.log(`${prefix}「${gap.name}」(id=${gap.providerId})：匹配成功，可用字段 [${fields.join(", ")}]`);
      return { providerId: gap.providerId, meta, error: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_RETRIES) {
        console.warn(`${prefix}「${gap.name}」(id=${gap.providerId})：第 ${attempt + 1} 次失败（${msg.slice(0, 100)}），重试...`);
        // 短暂等待后重试
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } else {
        console.error(`${prefix}「${gap.name}」(id=${gap.providerId})：失败（${msg.slice(0, 200)}），跳过`);
        return { providerId: gap.providerId, meta: null, error: msg.slice(0, 200) };
      }
    }
  }
  // unreachable
  return { providerId: gap.providerId, meta: null, error: "unexpected" };
}

// ===== 主流程 =====
async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const startedAt = Date.now();

  console.log(`[FIX-332] 开始（dry-run=${dryRun}）...`);
  console.log(`[FIX-332] FlyAI 端点：${FLYAI_BASE}`);
  console.log(`[FIX-332] 并发：${CONCURRENCY}，最大重试：${MAX_RETRIES}`);

  // 1. 扫描全库，收集缺口 Item 的去重 providerId 列表
  const dataDir = path.join(import.meta.dirname, "../../data");
  const files = (await fs.readdir(dataDir)).filter(
    (file) => file.endsWith(".json") && isValidTripId(file.slice(0, -".json".length)),
  );
  console.log(`[FIX-332] 扫描 ${dataDir}：共 ${files.length} 个行程文件`);

  // 收集去重后的 gap POI 列表（providerId → 首次遇到的 name + city）
  const gapMap = new Map<string, GapPoi>();

  for (const file of files) {
    const tripId = file.slice(0, -".json".length);
    let raw: string;
    try {
      raw = await fs.readFile(path.join(dataDir, file), "utf8");
    } catch {
      continue;
    }
    let trip: any;
    try {
      trip = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!trip || !trip.itemRegistry) continue;
    const city = trip.destination?.city || "三亚";

    for (const item of Object.values(trip.itemRegistry) as any[]) {
      if (item.origin !== "fliggy" || !item.providerId) continue;
      if (!isBlank(item.poiLevel) && !isBlank(item.listRank) && !isBlank(item.description)) continue;
      // 有至少一项为空的飞猪 Item
      if (!gapMap.has(item.providerId)) {
        gapMap.set(item.providerId, { providerId: item.providerId, name: item.name, city });
      }
    }
  }

  let gaps = Array.from(gapMap.values());
  // --limit=N：冒烟测试用，仅查询前 N 个缺口 POI（默认全量）
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  if (limitArg) {
    const n = Number(limitArg.slice("--limit=".length));
    if (Number.isFinite(n) && n > 0 && n < gaps.length) {
      console.log(`[FIX-332] --limit=${n}：仅处理前 ${n} 个缺口 POI（冒烟测试）`);
      gaps = gaps.slice(0, n);
    }
  }
  console.log(`[FIX-332] 去重后缺口 providerId 数：${gaps.length}`);
  if (gaps.length === 0) {
    console.log("[FIX-332] 无缺口，退出。");
    return;
  }

  // 2. 批量查询 FlyAI（并发控制）
  console.log(`[FIX-332] 开始 FlyAI live 查询（${gaps.length} 个 POI）...`);
  const liveIndex = new Map<string, CachedPoiMeta>();
  let successCount = 0;
  let noMatchCount = 0;
  let failCount = 0;

  const results = await asyncPool(CONCURRENCY, gaps, (gap, i) => queryOnePoi(gap, i, gaps.length));

  for (const r of results) {
    if (r.meta !== null) {
      liveIndex.set(r.providerId, r.meta);
      successCount++;
    } else if (r.error === "no_id_match") {
      noMatchCount++;
    } else {
      failCount++;
    }
  }

  const queryElapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[FIX-332] FlyAI 查询完成（${queryElapsed}s）：成功 ${successCount}，无匹配 ${noMatchCount}，失败 ${failCount}`,
  );
  console.log(`[FIX-332] live 索引大小：${liveIndex.size} 个 POI`);

  if (liveIndex.size === 0) {
    console.log("[FIX-332] live 索引为空，无可回填数据，退出。");
    return;
  }

  // 3. 遍历行程文件，通过 tripStore.load 加载（含读时迁移），applyTask330Fixes 回填，tripStore.save 写盘
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
      console.error(`[FIX-332] ${tripId} 读取失败，跳过：`, error);
      continue;
    }
    if (trip === null) continue;
    scanned += 1;

    const backfilled = applyTask330Fixes(trip, liveIndex);
    if (backfilled.length === 0) continue; // 无变更不写盘

    for (const entry of backfilled) {
      console.log(
        `[FIX-332] ${tripId} item ${entry.itemId}「${entry.name}」(providerId=${entry.providerId})：回填 ${entry.fields.join(" + ")}`,
      );
    }
    changedFields += backfilled.reduce((sum, e) => sum + e.fields.length, 0);

    if (dryRun) {
      changedTrips += 1;
      changedItems += backfilled.length;
      continue;
    }

    try {
      // 备份先行
      const jsonPath = path.join(dataDir, file);
      await fs.copyFile(jsonPath, `${jsonPath}${BACKUP_SUFFIX}`);
      await tripStore.save(trip); // 一致性校验 + version 自增 + 原子写
      changedTrips += 1;
      changedItems += backfilled.length;
      console.log(`[FIX-332] ${tripId}：已备份 ${path.basename(jsonPath)}${BACKUP_SUFFIX} 并写盘`);
    } catch (error) {
      failures.push(tripId);
      console.error(`[FIX-332] ${tripId} 写盘失败，内存变更已丢弃：`, error);
    }
  }

  const totalElapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    [
      `\n[FIX-332] === 完成（总耗时 ${totalElapsed}s）===`,
      `  FlyAI 调用：${gaps.length} 次（成功 ${successCount} / 无匹配 ${noMatchCount} / 失败 ${failCount}）`,
      `  行程扫描：${scanned} 个`,
      `  回填：${changedTrips} 个行程 / ${changedItems} 个 Item / ${changedFields} 个字段`,
      failures.length > 0
        ? `  写盘失败：${failures.length} 个（${failures.join("、")}）`
        : "  写盘失败：无",
      dryRun ? "  （dry-run 模式：未实际写盘）" : "",
    ].join("\n"),
  );
  if (failures.length > 0) process.exitCode = 1;
}

// 主模块守卫
const invokedAsMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedAsMain) {
  main().catch((error: unknown) => {
    console.error("[FIX-332] 失败：", error);
    process.exitCode = 1;
  });
}
