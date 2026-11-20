/**
 * Task #335 微基准：去 npx 直跑提速 + 24h 搜索缓存命中（真实 FlyAI，**共 2 次 live 调用**）。
 *
 * live 计数严格控制：POI 冷调 1 次 + 酒店冷调 1 次 = 2；其余（同 query 复调、两种传参形态
 * 归一、跨日期键隔离）全部命中缓存或纯本地计算 = 0 live。每次冷调前先 clearSearchCacheKey
 * 强制冷启动，使脚本可重复运行而 live 计数恒定。
 *
 * 断言（不静默放宽）：
 *   - POI 冷调 latencyMs ≥ 300（真实触网）且缓存文件落盘；
 *   - POI 复调 latencyMs ≤ 50 且命中日志出现、normalized 条数与冷调一致（0 live）；
 *   - searchPoi("三亚 天涯海角") 无 destination 形态命中同一键（HTTP 形态与 assemble 形态共享缓存）；
 *   - 酒店冷调 latencyMs ≥ 300、filter 存在；复调 latencyMs ≤ 50、filter 还原、kept 一致；
 *   - 跨日期键隔离：makeSearchKey(dest,kw,dateA) ≠ makeSearchKey(dest,kw,dateB)（纯本地，0 live）。
 * 运行：npx tsx scripts/perf-task335-flyai.ts
 */
import "../server/src/env.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { searchPoi, searchHotels } from "../server/src/flyai/client.js";
import { makeSearchKey, clearSearchCacheKey, isSearchCacheEnabled } from "../server/src/flyai/searchCache.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = join(ROOT, "server/cache/flyai");
const NPX_BASELINE_MS = 3720; // Troy #334 11-03 实测 npx p50 3.72s

const POI_CITY = "三亚";
const POI_KW = "天涯海角";
const HOTEL_DEST = "三亚";
const HOTEL_KW = "海棠湾";
const HOTEL_IN = "2026-11-20";
const HOTEL_OUT = "2026-11-21";

let liveCalls = 0;
const failures: string[] = [];

// 捕获 console.log 以检测「缓存命中」日志（命中 ⇒ 0 live）
const origLog = console.log;
let captured: string[] = [];
function startCapture(): void { captured = []; }
function hitLogged(): boolean { return captured.some((l) => l.includes("缓存命中")); }
console.log = (...args: unknown[]) => {
  const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  captured.push(msg);
  origLog(...args);
};

function cacheFile(key: string): string { return join(CACHE_DIR, `${key}.json`); }
function assert(cond: boolean, msg: string): void { if (!cond) failures.push(msg); }

async function main(): Promise<void> {
  origLog(`===== Task #335 微基准：去 npx 提速 + 24h 缓存（严格 2 次 live）=====`);
  origLog(`缓存开关 FLYAI_SEARCH_CACHE：${isSearchCacheEnabled() ? "启用" : "禁用（应为启用）"}`);
  assert(isSearchCacheEnabled(), "缓存未启用（FLYAI_SEARCH_CACHE 被设为 0？）");

  const poiKey = makeSearchKey([POI_CITY, POI_KW]);
  const hotelKey = makeSearchKey([HOTEL_DEST, HOTEL_KW, HOTEL_IN, HOTEL_OUT]);

  // ---------- POI 冷调（live #1）----------
  clearSearchCacheKey(poiKey);
  assert(!existsSync(cacheFile(poiKey)), "POI 冷调前缓存文件应已清除");
  startCapture();
  const poiCold = await searchPoi(POI_KW, { destination: POI_CITY });
  liveCalls += 1;
  const poiColdMs = poiCold.latencyMs;
  origLog(`\n[POI 冷调 live#1] 「${POI_CITY} ${POI_KW}」 latency=${poiColdMs}ms 条数=${poiCold.normalized.length} raw存在=${poiCold.raw !== null}`);
  origLog(`  vs npx 基线 ${NPX_BASELINE_MS}ms → 提速 ${((1 - poiColdMs / NPX_BASELINE_MS) * 100).toFixed(0)}%（去 npx ~1.9s 开销）`);
  assert(poiColdMs >= 300, `POI 冷调 latency=${poiColdMs}ms 应 ≥300（真实触网）`);
  assert(!hitLogged(), "POI 冷调不应命中缓存");
  assert(existsSync(cacheFile(poiKey)), "POI 冷调后缓存文件应落盘");
  assert(poiCold.raw !== null, "POI 冷调应返回真实 raw（供契约/校验）");

  // ---------- POI 复调（0 live，缓存命中）----------
  startCapture();
  const poiWarm = await searchPoi(POI_KW, { destination: POI_CITY });
  const poiWarmMs = poiWarm.latencyMs;
  origLog(`[POI 复调 0-live] latency=${poiWarmMs}ms 条数=${poiWarm.normalized.length} 命中日志=${hitLogged()}`);
  assert(poiWarmMs <= 50, `POI 复调 latency=${poiWarmMs}ms 应 ≤50（缓存命中）`);
  assert(hitLogged(), "POI 复调应打印缓存命中日志");
  assert(poiWarm.normalized.length === poiCold.normalized.length, "POI 复调条数应与冷调一致");
  assert(poiWarmMs < poiColdMs / 5, `POI 复调(${poiWarmMs}ms) 应显著快于冷调(${poiColdMs}ms)`);

  // ---------- POI 另一种传参形态归一（0 live，应命中同键）----------
  startCapture();
  const poiFormB = await searchPoi(`${POI_CITY} ${POI_KW}`); // 无 destination：内部拆「城市 关键词」
  origLog(`[POI 形态B 0-live] 「${POI_CITY} ${POI_KW}」拼串 latency=${poiFormB.latencyMs}ms 命中日志=${hitLogged()}`);
  assert(hitLogged(), "POI「城市 关键词」拼串形态应命中同一缓存键（两形态归一）");
  assert(poiFormB.latencyMs <= 50, "POI 形态B 应为缓存命中（≤50ms）");

  // ---------- 酒店冷调（live #2）----------
  clearSearchCacheKey(hotelKey);
  startCapture();
  const hotelCold = await searchHotels({ destination: HOTEL_DEST, keyword: HOTEL_KW }, HOTEL_IN, HOTEL_OUT);
  liveCalls += 1;
  const hotelColdMs = hotelCold.latencyMs;
  origLog(`\n[酒店冷调 live#2] 「${HOTEL_DEST}/${HOTEL_KW} ${HOTEL_IN}→${HOTEL_OUT}」 latency=${hotelColdMs}ms 条数=${hotelCold.normalized.length} filter=${hotelCold.filter ? `kept=${hotelCold.filter.kept}` : "无"}`);
  origLog(`  注：${NPX_BASELINE_MS}ms 为 POI(search-poi) npx 基线；酒店后端含日期/库存查询本就更重，去 npx 同样省 ~1.9s spawn 开销，但不宜直接与 POI 基线算百分比`);
  assert(hotelColdMs >= 300, `酒店冷调 latency=${hotelColdMs}ms 应 ≥300（真实触网）`);
  assert(!hitLogged(), "酒店冷调不应命中缓存");
  assert(hotelCold.filter !== undefined, "酒店冷调应返回 filter 统计");
  assert(existsSync(cacheFile(hotelKey)), "酒店冷调后缓存文件应落盘");

  // ---------- 酒店复调（0 live，filter 应还原）----------
  startCapture();
  const hotelWarm = await searchHotels({ destination: HOTEL_DEST, keyword: HOTEL_KW }, HOTEL_IN, HOTEL_OUT);
  const hotelWarmMs = hotelWarm.latencyMs;
  origLog(`[酒店复调 0-live] latency=${hotelWarmMs}ms 条数=${hotelWarm.normalized.length} filter=${hotelWarm.filter ? `kept=${hotelWarm.filter.kept}` : "无"} 命中日志=${hitLogged()}`);
  assert(hotelWarmMs <= 50, `酒店复调 latency=${hotelWarmMs}ms 应 ≤50（缓存命中）`);
  assert(hitLogged(), "酒店复调应打印缓存命中日志");
  assert(hotelWarm.filter !== undefined, "酒店复调应从缓存还原 filter（HotelPicker 消费）");
  assert(hotelWarm.filter?.kept === hotelCold.filter?.kept, "酒店复调 filter.kept 应与冷调一致");

  // ---------- 跨日期键隔离（纯本地，0 live）----------
  const keyA = makeSearchKey([HOTEL_DEST, HOTEL_KW, "2026-11-20", "2026-11-21"]);
  const keyB = makeSearchKey([HOTEL_DEST, HOTEL_KW, "2026-12-01", "2026-12-02"]);
  origLog(`\n[跨日期键隔离 0-live] dateA键=${keyA.slice(0, 12)} dateB键=${keyB.slice(0, 12)} 不同=${keyA !== keyB}`);
  assert(keyA !== keyB, "不同入离日期必须产生不同缓存键（禁止跨日期串结果）");

  // ---------- 汇总 ----------
  origLog(`\n----- 汇总 -----`);
  origLog(`真实 live 调用次数：${liveCalls}（预算 ≤10，本脚本固定 2）`);
  origLog(`POI 单次搜索：冷 ${poiColdMs}ms（去 npx）/ 暖 ${poiWarmMs}ms（缓存命中，0 live）`);
  origLog(`酒店单次搜索：冷 ${hotelColdMs}ms（去 npx）/ 暖 ${hotelWarmMs}ms（缓存命中，0 live）`);

  if (liveCalls !== 2) failures.push(`live 调用应恰好 2 次，实为 ${liveCalls}`);
  if (failures.length > 0) {
    console.log = origLog;
    console.error(`\n❌ 微基准断言失败（${failures.length} 项）：`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log = origLog;
  console.log(`\n✅ 微基准通过：去 npx 冷调 POI ${poiColdMs}ms / 酒店 ${hotelColdMs}ms（均远低于 npx 3720ms 基线）；缓存命中 ${poiWarmMs}ms / ${hotelWarmMs}ms（0 live）；两形态归一 + 跨日期键隔离均正确；live 合计 ${liveCalls} 次`);
}

main().catch((error) => {
  console.log = origLog;
  console.error(`微基准异常（已用 live=${liveCalls}）：`, error);
  process.exit(1);
});
