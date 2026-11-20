/**
 * Task #335：服务端 FlyAI 搜索缓存（生产链路省额度 / 降延迟）。
 *
 * 定位：在 `client.ts` 的 searchPoi / searchHotels 进入 spawn 前先查本缓存——
 * 命中直接返回（0 live 调用、延迟 <5ms），未命中真调后写盘。使 HTTP
 * `/api/flyai/search` 与 assemble 装配链路（经 DI 最终仍调 client.searchPoi）
 * 同时受益。落盘目录 `server/cache/flyai/`，24h TTL，可再生、不入库。
 *
 * 键：`sha256(city + "\u0000" + keyword)`（酒店再并入 checkIn/checkOut，避免不同
 * 日期串结果互相污染）。两种 searchPoi 传参形态（带 destination 的裸词 / 内部
 * 「城市 关键词」拼串，见 client.ts L406-416 契约）归一后 city+keyword 相同即同键，
 * 故 HTTP 路径与 assemble 路径共享同一份缓存。
 *
 * ⚠️ 与 eval/harness/flyaiCache.ts 的边界（严格区分，勿混用）：
 *   - 本模块（server/cache/flyai）：生产态缓存，位于 client.searchPoi/searchHotels
 *     层（DI 之下），24h TTL 自动过期，键含 city+keyword(+dates)，存 normalized(+filter)。
 *   - eval flyaiCache（eval/cache/flyai）：评测态录制/回放，经 assemble `setSearchPoi`
 *     DI 注入（位于本缓存之上/外层），键＝sha256(整串 query)，无 TTL（手动清理），
 *     由 EVAL_LIVE/EVAL_REPLAY/EVAL_FLYAI_LIVE 控制 live/replay/passthrough。
 *   两者物理隔离（不同目录）、层级不同（assemble DI 外 vs client 内）、键口径不同。
 *   评测回放命中时根本不会下沉到 client，故本缓存不干扰评测；评测 live/miss 真调时
 *   本缓存作为二级省额度层兜底（如需强制真调刷新，设 FLYAI_SEARCH_CACHE=0 关闭本缓存）。
 *
 * 回滚开关：环境变量 `FLYAI_SEARCH_CACHE=0` 完全禁用本缓存（读+写+single-flight 全 bypass），
 * 主链路退回「每次真调」的原行为；bundle 直跑另有独立 fallback（见 client.ts resolveBundlePath）。
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FlyAISearchFilterStats } from "./client.js";

/**
 * 落盘目录 server/cache/flyai：本文件运行时位于 server/src/flyai（dev/tsx）或
 * server/dist/flyai（build 后，tsconfig rootDir=src/outDir=dist）——两者均在 server/
 * 下两级，故 `../../cache/flyai` 恒定解析到 server/cache/flyai，与 eval/cache 物理隔离。
 */
const CACHE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../cache/flyai");

/** 缓存有效期：24 小时（perf.md 附录 C 长期建议落地） */
const TTL_MS = 24 * 60 * 60 * 1000;

/** 缓存记录：复用 eval/cache/flyai 的 {key, query, normalized, recordedAt} 形态；
 *  酒店结果附带 filter 统计（HotelPicker 消费 res.filter），POI 无此字段。 */
export interface SearchCacheRecord<T> {
  key: string;
  query: string;
  normalized: T[];
  recordedAt: string;
  filter?: FlyAISearchFilterStats;
}

/** 缓存是否启用：FLYAI_SEARCH_CACHE=0 为回滚开关（禁用读+写+single-flight） */
export function isSearchCacheEnabled(): boolean {
  return process.env.FLYAI_SEARCH_CACHE !== "0";
}

/** 缓存键：sha256(各语义段以 NUL 分隔拼接)。POI=[city, keyword]；酒店=[dest, keyword, checkIn, checkOut]。 */
export function makeSearchKey(parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

function cachePath(key: string): string {
  return path.join(CACHE_DIR, `${key}.json`);
}

/** 删除指定键的缓存文件（供 perf / 验证脚本强制冷启动；生产链路不调用） */
export function clearSearchCacheKey(key: string): void {
  try {
    rmSync(cachePath(key), { force: true });
  } catch {
    // 忽略：不存在或删除失败不影响后续真调
  }
}

/** 读缓存：命中且未过期返回记录，否则 null（禁用/缺文件/损坏/过期/时钟异常一律 null，绝不抛错打断主链路） */
export function readSearchCache<T>(key: string): SearchCacheRecord<T> | null {
  if (!isSearchCacheEnabled()) return null;
  try {
    const record = JSON.parse(readFileSync(cachePath(key), "utf8")) as SearchCacheRecord<T>;
    if (!Array.isArray(record.normalized) || typeof record.recordedAt !== "string") return null;
    const age = Date.now() - Date.parse(record.recordedAt);
    // age<0：记录时间在未来（时钟回拨），保守视为不可信；age>TTL：过期
    if (!Number.isFinite(age) || age < 0 || age > TTL_MS) return null;
    return record;
  } catch {
    return null;
  }
}

/** 写缓存：best-effort，失败仅告警不抛错（缓存不可用绝不能拖垮主搜索链路） */
export function writeSearchCache<T>(record: SearchCacheRecord<T>): void {
  if (!isSearchCacheEnabled()) return;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cachePath(record.key), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  } catch (error) {
    console.warn(
      `[FlyAI:cache] 写缓存失败（忽略，不影响主链路）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** live 真调闭包产出：raw 供契约样本/校验用（不落盘），normalized(+filter) 落盘并回传调用方 */
export interface LiveSearchPayload<T> {
  raw: unknown;
  normalized: T[];
  filter?: FlyAISearchFilterStats;
}

/** searchWithCache 统一出口：fromCache 标记命中来源，latencyMs 为本次 searchPoi/Hotels 层耗时 */
export interface CacheOutcome<T> {
  raw: unknown;
  normalized: T[];
  filter?: FlyAISearchFilterStats;
  fromCache: boolean;
  latencyMs: number;
}

/**
 * single-flight 在途去重：同键并发冷未命中时只放一个真调子进程，其余等待共享结果，
 * 避免瞬时并发把同一 query 打成多次 live 调用（省额度）。仅缓存启用时生效。
 */
const inflight = new Map<string, Promise<CacheOutcome<unknown>>>();

/**
 * 缓存编排：读盘命中 → 直接返回；未命中 → single-flight 合并 → 真调 live() → 写盘。
 * live() 抛错时原样向上抛（错误结果绝不入缓存），并清理在途登记。
 */
export async function searchWithCache<T>(
  key: string,
  query: string,
  live: () => Promise<LiveSearchPayload<T>>,
): Promise<CacheOutcome<T>> {
  const startedAt = performance.now();
  const enabled = isSearchCacheEnabled();

  if (enabled) {
    const hit = readSearchCache<T>(key);
    if (hit !== null) {
      return {
        raw: null, // 命中不回放 raw（前端/装配不消费；需 raw 的校验脚本走 FLYAI_SEARCH_CACHE=0）
        normalized: hit.normalized,
        filter: hit.filter,
        fromCache: true,
        latencyMs: Math.round(performance.now() - startedAt),
      };
    }
    const existing = inflight.get(key) as Promise<CacheOutcome<T>> | undefined;
    if (existing !== undefined) return existing;
  }

  const run = (async (): Promise<CacheOutcome<T>> => {
    const payload = await live();
    if (enabled) {
      writeSearchCache<T>({
        key,
        query,
        normalized: payload.normalized,
        recordedAt: new Date().toISOString(),
        ...(payload.filter !== undefined ? { filter: payload.filter } : {}),
      });
    }
    return {
      raw: payload.raw,
      normalized: payload.normalized,
      filter: payload.filter,
      fromCache: false,
      latencyMs: Math.round(performance.now() - startedAt),
    };
  })();

  if (enabled) {
    inflight.set(key, run as Promise<CacheOutcome<unknown>>);
    // 无论成功失败都清理在途登记（失败不残留，下次可重新真调）
    void run.catch(() => {}).finally(() => {
      if (inflight.get(key) === (run as unknown)) inflight.delete(key);
    });
  }

  return run;
}
