/**
 * Task #284：FlyAI searchPoi 录制 / 回放缓存——消除对齐层网络波动对 prompt 的影响。
 *
 * 注入点：`server/src/ai/assemble.ts` 的 setSearchPoi DI 钩子。
 * 键：sha256(query)。缓存文件：eval/cache/flyai/{key}.json（gitignore，可再生）。
 *
 * 模式（Task #292：FlyAI 缓存键＝sha256(点位名 query)，与 planner prompt 无关——#291 prompt
 * 改动只失效 planner 缓存键，FlyAI 缓存仍有效；live 轮核心是 planner 真调（方差观测），FlyAI
 * 对齐结果不影响断言（#284 itemId 种子＝item:{name} 已剔除 poi.id），故 EVAL_LIVE=1 时 FlyAI
 * 默认走 replay 消除网络波动/限流，不再强制真调）：
 * - EVAL_FLYAI_LIVE=1 → live：强制真调并录制（刷新 FlyAI 缓存的逃生口）；
 * - EVAL_LIVE=1       → replay：命中回放、未命中真调并录制（planner 仍 live，见 plannerCache）；
 * - EVAL_REPLAY       → 默认随 EVAL_FIXTURE=1 开启：命中回放、未命中真调并录制；
 * - 两者都关          → passthrough：直接真调（仍录制）。
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FlyAIPoi } from "../../server/src/flyai/client.js";
import { setSearchPoi, resetSearchPoi, type SearchPoiFn } from "../../server/src/ai/assemble.js";

const CACHE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../cache/flyai");

export interface FlyAiCacheRecord {
  key: string;
  query: string;
  normalized: FlyAIPoi[];
  recordedAt: string;
}

export interface FlyAiCacheStats {
  hits: number;
  misses: number;
}

const stats: FlyAiCacheStats = { hits: 0, misses: 0 };

function cacheKey(query: string): string {
  return createHash("sha256").update(query).digest("hex");
}

function cachePath(key: string): string {
  return join(CACHE_DIR, `${key}.json`);
}

function readCache(key: string): FlyAiCacheRecord | null {
  try {
    return JSON.parse(readFileSync(cachePath(key), "utf8")) as FlyAiCacheRecord;
  } catch {
    return null;
  }
}

function writeCache(record: FlyAiCacheRecord): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath(record.key), JSON.stringify(record, null, 2), "utf8");
}

function flyaiCacheMode(): "live" | "replay" | "passthrough" {
  // Task #292：见文件头注释——FlyAI 缓存键＝sha256(点位名)，与 planner prompt 无关，live 轮
  // FlyAI 默认 replay 消除网络波动/限流（对齐结果不影响断言，#284 已剔除 poi.id）；
  // EVAL_FLYAI_LIVE=1 为强制真调刷新缓存的逃生口。planner 仍由 plannerCacheMode 控制为 live。
  if (process.env["EVAL_FLYAI_LIVE"] === "1") return "live";
  if (process.env["EVAL_LIVE"] === "1") return "replay";
  const explicit = process.env["EVAL_REPLAY"];
  if (explicit === "0") return "passthrough";
  if (explicit === "1") return "replay";
  return process.env["EVAL_FIXTURE"] === "1" ? "replay" : "passthrough";
}

export function getFlyAiCacheStats(): Readonly<FlyAiCacheStats> {
  return stats;
}

/**
 * 安装 FlyAI 搜索缓存（幂等）：用 setSearchPoi 把 searchPoi 换成缓存包装。
 * uninstall 恢复 assemble.ts 默认依赖。
 */
export function installFlyAiCache(): { uninstall: () => void } {
  const mode = flyaiCacheMode();
  // 保留真调通道引用（resetSearchPoi 后 realSearchPoi 仍是原始导入）
  let realSearch: SearchPoiFn;
  // 动态获取真实 searchPoi（assemble.ts 的 realSearchPoi 是模块私有的，
  // 这里直接 import flyai/client 的 searchPoi 作为真调通道）
  const getRealSearch = async (): Promise<SearchPoiFn> => {
    if (realSearch !== undefined as unknown) return realSearch;
    const mod = await import("../../server/src/flyai/client.js");
    realSearch = mod.searchPoi as unknown as SearchPoiFn;
    return realSearch;
  };

  const wrappedSearch: SearchPoiFn = async (query: string) => {
    const key = cacheKey(query);

    if (mode === "replay") {
      const hit = readCache(key);
      if (hit !== null) {
        stats.hits += 1;
        return { normalized: hit.normalized };
      }
      stats.misses += 1;
      // 未命中：转真调并录制
    } else {
      stats.misses += 1;
    }

    const real = await getRealSearch();
    const result = await real(query);
    writeCache({
      key,
      query,
      normalized: result.normalized,
      recordedAt: new Date().toISOString(),
    });
    return result;
  };

  setSearchPoi(wrappedSearch);
  return {
    uninstall: () => {
      resetSearchPoi();
    },
  };
}
