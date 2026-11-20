// 副作用导入：统一从仓库根 .env 加载环境变量（服务端经 index.ts 已加载，属幂等；
// 保证独立验证脚本 npx tsx server/src/flyai/verify*.ts 同样能拿到 FLYAI_API_KEY）
import "../env.js";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FliggyPoi, HotelCandidate } from "@goplay/shared";
import { FlyAiError, classifyFlyAiError, redactSecretsForLog } from "./errors.js";
import { filterByAreaCenter, filterByDestinationCity, type AreaScopeConfig } from "./scope.js";
import { makeSearchKey, searchWithCache } from "./searchCache.js";

const CLI_PACKAGE = "@fly-ai/flyai-cli";
/**
 * 直跑 bundle 子路径（Task #335 去 npx）：包 main 指向不存在的 dist/index.js，bare
 * specifier `require.resolve('@fly-ai/flyai-cli')` 会 MODULE_NOT_FOUND；包无 exports
 * 字段，故必须用显式子路径解析 dist/flyai-bundle.cjs（实测已验证，见任务记录）。
 */
const CLI_BUNDLE_SUBPATH = "@fly-ai/flyai-cli/dist/flyai-bundle.cjs";
const esmRequire = createRequire(import.meta.url);
const CLI_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/**
 * npx 子进程专用的独立 npm 缓存目录（Task #115）。
 *
 * 背景：IDE 启动的 server 进程调用 `npx @fly-ai/flyai-cli` 时，npm 写默认缓存
 * `~/.npm/_cacache/tmp` 可能遇到 EPERM（IDE 沙箱/权限收紧），导致 CLI 无法运行；
 * 而用户终端手动调用正常。npm 通过 `npm_config_cache` 环境变量即可覆盖缓存目录
 * （npm 10.x 已实测：npm_config_cache=... npm config get cache 生效），无需额外 flag。
 *
 * 目录固定在系统 temp 下的稳定路径（跨重启复用已下载的包，不写入仓库）；
 * 优先级：用户显式 NPM_CONFIG_CACHE / npm_config_cache > 内置 temp 目录。
 */
function resolveNpmCacheDir(): string | null {
  const dir = path.join(tmpdir(), "goplay-npm-cache");
  try {
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch (error) {
    // 目录创建失败时退回默认缓存行为（不注入覆盖变量），细节仅进服务端日志
    console.warn(
      `[FlyAI] 独立 npm 缓存目录创建失败，回退默认缓存：${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/**
 * 构造 npx 子进程环境：进程环境原样透传（FLYAI_API_KEY 鉴权依赖）。
 * 用户显式配置 NPM_CONFIG_CACHE 时尊重之；否则注入独立缓存目录 npm_config_cache。
 * 注意：`npm run dev` 会把解析后的默认缓存（~/.npm）以 npm_config_cache 注入子进程环境，
 * 那是 npm 自动传播而非用户显式配置，且可能正是 EPERM 的坏目录，必须覆盖。
 */
function buildNpxChildEnv(): NodeJS.ProcessEnv {
  const userExplicitCache = process.env.NPM_CONFIG_CACHE ?? "";
  if (userExplicitCache.trim() !== "") return process.env;
  const cacheDir = resolveNpmCacheDir();
  if (cacheDir === null) return process.env;
  return { ...process.env, npm_config_cache: cacheDir };
}

/**
 * 解析直跑 bundle 的绝对路径（Task #335 去 npx）。
 *
 * npx 每次调用都要经 npm 解析/校验（实测约 1.9s 纯开销，Troy #334），而 CLI 已作为
 * server 依赖安装，直接 `node <bundle> <command> ...args` 即可省去该开销（3.7s → 0.8〜1.7s）。
 * 解析结果首次成功后固定缓存；失败（包未安装 / 内网 registry 不可达）返回 null，调用方
 * 退回 npx——主链路绝不因直跑不可用而挂（fallback 见 buildSpawnTarget）。
 */
let cachedBundlePath: string | null | undefined;
function resolveBundlePath(): string | null {
  if (cachedBundlePath !== undefined) return cachedBundlePath;
  try {
    cachedBundlePath = esmRequire.resolve(CLI_BUNDLE_SUBPATH);
  } catch (error) {
    console.warn(
      `[FlyAI] 直跑 bundle 解析失败，退回 npx：${error instanceof Error ? error.message : String(error)}`,
    );
    cachedBundlePath = null;
  }
  return cachedBundlePath;
}

/** spawn 目标：直跑 bundle 优先，解析失败退回 npx（完整保留 Task #115 独立 npm 缓存修复）。 */
interface SpawnTarget {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  mode: "bundle" | "npx";
}

let loggedSpawnMode = false;
function buildSpawnTarget(cliCommand: string, cliArgs: string[]): SpawnTarget {
  const bundlePath = resolveBundlePath();
  const target: SpawnTarget =
    bundlePath !== null
      ? {
          // 直跑模式：`node <bundle> <command> ...args`。env 只需透传进程环境（bundle 读
          // FLYAI_API_KEY 走鉴权）；npm_config_cache 是 npm/npx 专用（Task #115 修 EPERM），
          // 直跑不触发 npm 下载/缓存写入，故无需注入。判定：直跑模式不需要 buildNpxChildEnv，
          // 该函数仅服务下方 npx fallback 与 getFlyAiCliVersion 的 `npm view`。
          command: process.execPath,
          args: [bundlePath, cliCommand, ...cliArgs],
          env: process.env,
          mode: "bundle",
        }
      : {
          // npx fallback：完全保留原逻辑（--yes + 包名 + 命令；env 走 buildNpxChildEnv）
          command: process.platform === "win32" ? "npx.cmd" : "npx",
          args: ["--yes", CLI_PACKAGE, cliCommand, ...cliArgs],
          env: buildNpxChildEnv(),
          mode: "npx",
        };
  if (!loggedSpawnMode) {
    loggedSpawnMode = true;
    console.log(
      `[FlyAI] spawn 模式：${target.mode === "bundle" ? "直跑 bundle（去 npx，Task #335）" : "npx fallback（bundle 不可用）"}`,
    );
  }
  return target;
}

export interface FlyAISearchResult<T> {
  raw: unknown;
  normalized: T[];
  toolName: string;
  params: unknown;
  capturedAt: string;
  latencyMs: number;
  integrationPath: "cli" | "mcp" | "agent_proxy";
  /** 服务端权威过滤统计（非敏感计数；丢弃明细仅进服务端日志，不含密钥） */
  filter?: FlyAISearchFilterStats;
}

/** 城市层/片区层过滤计数：用于前端展示与验证脚本复核 */
export interface FlyAISearchFilterStats {
  destination: string;
  /** 片区名；null 表示未启用片区过滤（仅城市层） */
  areaName: string | null;
  /** CLI 归一化后的原始条数（过滤前） */
  rawCount: number;
  cityKept: number;
  cityRejected: number;
  /** 仅片区搜索时非 null */
  areaKept: number | null;
  areaRejected: number | null;
  /** 最终保留条数 */
  kept: number;
}

/** POI 名称是搜索结果展示字段，不属于 shared.FliggyPoi 商品字段。 */
export interface FlyAIPoi extends FliggyPoi {
  name: string;
}

type SearchKind = "poi" | "hotel";
type RawRecord = Record<string, unknown>;

function runProcess(
  command: string,
  args: string[],
  timeoutMs = CLI_TIMEOUT_MS,
  env: NodeJS.ProcessEnv = buildNpxChildEnv(),
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      // env 由调用方决定：直跑 bundle 传 process.env（仅需 FLYAI_API_KEY 透传，Task #335），
      // npx/npm fallback 传 buildNpxChildEnv()（额外注入独立 npm 缓存目录，Task #115）
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    const append = (current: string, chunk: Buffer) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        finish(() =>
          reject(
            new FlyAiError("FLYAI_UPSTREAM_FAILED", {
              rawDetail: "FlyAI CLI 输出超过 10 MB，已终止本次调用",
            }),
          ),
        );
      }
      return next;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      // 可执行文件缺失/无权访问等启动失败：安全中文文案返回客户端，原始细节仅进服务端日志
      const launchDetail =
        error.code === "ENOENT"
          ? `未找到可执行文件（ENOENT）：${command}`
          : error.code === "EACCES" || error.code === "EPERM"
            ? `无权启动可执行文件（${error.code}）：${command}`
            : `无法启动 FlyAI CLI：${error.message}`;
      finish(() =>
        reject(
          new FlyAiError("FLYAI_CLI_UNAVAILABLE", {
            rawDetail: launchDetail,
            cause: error,
          }),
        ),
      );
    });
    child.on("close", (code) => {
      finish(() => {
        if (code === 0) {
          resolve(stdout.trim());
          return;
        }
        const detail = (stderr || stdout).trim() || `进程退出码 ${code ?? "unknown"}`;
        // 外部报错统一安全分类：原始 detail 只随 rawDetail 进服务端日志，绝不进入 HTTP 响应
        reject(classifyFlyAiError(detail));
      });
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() =>
        reject(
          new FlyAiError("FLYAI_TIMEOUT", {
            rawDetail: `FlyAI CLI 调用超过 ${timeoutMs / 1000} 秒，已终止`,
          }),
        ),
      );
    }, timeoutMs);
  });
}

function parseCliJson(output: string): unknown {
  const clean = output.replace(/\u001b\[[0-9;]*m/g, "").trim();
  const candidates = [clean];
  const fenced = clean.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) candidates.push(fenced.trim());

  const objectStart = clean.indexOf("{");
  const objectEnd = clean.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(clean.slice(objectStart, objectEnd + 1));
  }
  const arrayStart = clean.indexOf("[");
  const arrayEnd = clean.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    candidates.push(clean.slice(arrayStart, arrayEnd + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // 继续尝试 CLI 日志中的 JSON 主体。
    }
  }
  throw new Error("FlyAI CLI 未返回合法 JSON，无法建立可靠字段映射");
}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryParseNestedJson(value: string): unknown | null {
  const text = value.trim();
  if (!(text.startsWith("{") || text.startsWith("["))) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function looksLikeResult(record: RawRecord, kind: SearchKind): boolean {
  if (typeof record.name !== "string") return false;
  if (kind === "poi") {
    return ["jumpUrl", "longitude", "latitude", "poiLevel", "freePoiStatus", "category"].some(
      (key) => key in record,
    );
  }
  return ["shId", "detailUrl", "price", "priceText", "star", "brandName"].some(
    (key) => key in record,
  );
}

export function extractRawRecords(raw: unknown, kind: SearchKind): RawRecord[] {
  const records: RawRecord[] = [];
  const visited = new WeakSet<object>();

  const visit = (value: unknown, depth: number) => {
    if (depth > 12 || value === null || value === undefined) return;
    if (typeof value === "string") {
      const nested = tryParseNestedJson(value);
      if (nested !== null) visit(nested, depth + 1);
      return;
    }
    if (typeof value !== "object" || visited.has(value)) return;
    visited.add(value);

    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    if (looksLikeResult(value as RawRecord, kind)) records.push(value as RawRecord);
    Object.values(value as RawRecord).forEach((entry) => visit(entry, depth + 1));
  };

  visit(raw, 0);
  return records;
}

function nullableString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function nullableNumber(value: unknown): number | null {
  if (typeof value === "string" && value.trim() === "") return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCoords(record: RawRecord): { lng: number; lat: number } | null {
  const lng = nullableNumber(record.longitude);
  const lat = nullableNumber(record.latitude);
  return lng === null || lat === null ? null : { lng, lat };
}

function safeFliggyRouteUrl(value: unknown): string | null {
  const text = nullableString(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" && url.hostname === "router.feizhu.com" ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizePoi(record: RawRecord): FlyAIPoi | null {
  const id = nullableString(record.id);
  const name = nullableString(record.name);
  if (!id || !name) return null;

  const freePoiStatus = nullableString(record.freePoiStatus);
  return {
    id,
    name,
    address: nullableString(record.address),
    category: nullableString(record.category),
    description: nullableString(record.description),
    freePoiStatus:
      freePoiStatus === "NOT_FREE" || freePoiStatus === "FREE" || freePoiStatus === "UNKNOWN"
        ? freePoiStatus
        : null,
    poiLevel: nullableString(record.poiLevel),
    coords: normalizeCoords(record),
    mainPic: nullableString(record.mainPic),
    listRank: nullableString(record.listRank),
    ticketInfo: nullableString(record.ticketInfo),
    jumpUrl: safeFliggyRouteUrl(record.jumpUrl),
  };
}

function normalizeHotel(record: RawRecord): HotelCandidate | null {
  const shId = nullableString(record.shId);
  const name = nullableString(record.name);
  if (!shId || !name) return null;

  return {
    // rev2：HotelCandidate.id 为 GoPlay 酒店主键，飞猪酒店同 shId（hotelRegistry 的 key）
    id: shId,
    shId,
    name,
    brandName: nullableString(record.brandName),
    star: nullableString(record.star),
    priceText: nullableString(record.priceText) ?? nullableString(record.price),
    priceBasis: "价格与库存以飞猪详情页为准",
    address: nullableString(record.address),
    interestsPoi: nullableString(record.interestsPoi),
    decorationTime: nullableString(record.decorationTime),
    coords: normalizeCoords(record),
    mainPic: nullableString(record.mainPic),
    detailUrl: safeFliggyRouteUrl(record.detailUrl),
    rate: nullableString(record.rate),
  };
}

/**
 * 前置凭据校验（Task #62）：无正式 FLYAI_API_KEY 绝不触达 CLI——CLI 在缺失凭据时会静默
 * 回落共享试用通道，导致 429 且难以与真实故障区分。
 *
 * Task #335：本守卫必须在 searchPoi/searchHotels 进入 24h 缓存查询**之前**执行（而非仅在
 * invokeCli 内）——否则缓存命中会短路 live() 闭包、跳过守卫，使「缺 key 应抛
 * FLYAI_NOT_CONFIGURED」的契约在命中缓存时被静默放宽（verify-errors.ts 段 D 会误判）。
 * invokeCli 内保留同一守卫作纵深防御（供 runCliForStabilityTest 等非缓存路径复用）。
 */
function assertFlyAiConfigured(): void {
  if (typeof process.env.FLYAI_API_KEY !== "string" || process.env.FLYAI_API_KEY.trim() === "") {
    throw new FlyAiError("FLYAI_NOT_CONFIGURED", {
      rawDetail: "FLYAI_API_KEY 未配置，拒绝调用 FlyAI CLI（防止静默使用共享试用通道）",
    });
  }
}

async function invokeCli<T>(
  command: "search-poi" | "search-hotels",
  args: string[],
  toolName: "search_poi" | "search_hotels",
  params: unknown,
  normalize: (record: RawRecord) => T | null,
  kind: SearchKind,
): Promise<FlyAISearchResult<T>> {
  const startedAt = performance.now();
  try {
    // 纵深防御：真正的凭据守卫已前移到 searchPoi/searchHotels（缓存查询之前），此处再校验一次
    assertFlyAiConfigured();
    // Task #335：直跑已安装的 bundle（去 npx ~1.9s 开销）；bundle 不可用时 buildSpawnTarget 退回 npx
    const target = buildSpawnTarget(command, args);
    const output = await runProcess(target.command, target.args, CLI_TIMEOUT_MS, target.env);
    let raw: unknown;
    try {
      raw = parseCliJson(output);
    } catch (parseError) {
      // 非 JSON 输出属上游异常：片段仅进日志（rawDetail），不进 HTTP 响应
      throw new FlyAiError("FLYAI_UPSTREAM_FAILED", {
        rawDetail: `CLI 输出未含合法 JSON，前 500 字符：${output.slice(0, 500)}`,
        cause: parseError,
      });
    }
    const normalized = extractRawRecords(raw, kind)
      .map(normalize)
      .filter((item): item is T => item !== null);
    return {
      raw,
      normalized,
      toolName,
      params,
      capturedAt: new Date().toISOString(),
      latencyMs: Math.round(performance.now() - startedAt),
      integrationPath: "cli",
    };
  } catch (error) {
    // 统一安全分类：日志只打印脱敏后的原始细节，异常向调用方携带安全 message
    const flyaiError =
      error instanceof FlyAiError
        ? error
        : new FlyAiError("FLYAI_UPSTREAM_FAILED", {
            rawDetail: error instanceof Error ? error.message : String(error),
            cause: error,
          });
    console.error(
      `[FlyAI:${toolName}] CLI 直连失败（${flyaiError.code}）：${redactSecretsForLog(flyaiError.rawDetail).slice(0, 2000)}`,
    );
    throw flyaiError;
  }
}

function splitDestinationQuery(query: string): { destination: string; keyword: string } {
  const [destination, ...keywordParts] = query.trim().split(/\s+/);
  return {
    destination,
    keyword: keywordParts.join(" ") || destination,
  };
}

export interface SearchPoiOptions {
  /** 结构化目的地（如 Trip.destination.city），存在时优先于查询串首词拆分，避免「西岛」被误当城市 */
  destination?: string | null;
}

/**
 * POI 搜索。两种传参形态（Task #334 显式化契约，防调用方把城市/父景区名拼进 keyword）：
 * - 带 options.destination（HTTP 路由/前端路径）：query 必须是**裸关键词**，整串透传
 *   给 CLI --keyword，城市走 --city-name；拼接形态（如「蜈支洲岛 情人桥」「三亚 西」）
 *   实测召回为空或不稳定；
 * - 不带 destination（服务端内部 planPoiSearchQueries / pipeline 路径）：query 按
 *   「城市 关键词」约定拼串，由 splitDestinationQuery 拆首词为城市、余下为裸关键词，
 *   最终 CLI 参数与上一形态等价。
 * 两种形态落地后均为：--city-name 城市 + --keyword 裸词。
 */
export async function searchPoi(
  query: string,
  options: SearchPoiOptions = {},
): Promise<FlyAISearchResult<FlyAIPoi>> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    throw new FlyAiError("FLYAI_INVALID_REQUEST", { rawDetail: "POI 搜索关键词不能为空" });
  }

  const explicitCity = options.destination?.trim() || null;
  const { destination, keyword } = splitDestinationQuery(normalizedQuery);
  const city = explicitCity ?? destination;
  const keywordArg = explicitCity !== null ? normalizedQuery : keyword;
  const params =
    explicitCity !== null
      ? { query: normalizedQuery, destination: explicitCity }
      : { query: normalizedQuery };

  // Task #335：凭据守卫必须在缓存查询之前——缺 FLYAI_API_KEY 时无论缓存命中与否都抛
  // FLYAI_NOT_CONFIGURED（否则命中缓存会短路守卫，静默放宽契约，见 assertFlyAiConfigured 注释）
  assertFlyAiConfigured();

  // Task #335：进入 spawn 前先查 24h 缓存。键 sha256(city + "\u0000" + keyword)——两种传参形态
  // （带 destination 的裸词 / 内部「城市 关键词」拼串）归一后 city+keywordArg 相同即同键，
  // 故 HTTP /api/flyai/search 与 assemble 装配链路共享同一份缓存（见 searchCache.ts 边界说明）。
  const outcome = await searchWithCache<FlyAIPoi>(
    makeSearchKey([city, keywordArg]),
    `${city}\u0000${keywordArg}`,
    async () => {
      const result = await invokeCli(
        "search-poi",
        ["--city-name", city, "--keyword", keywordArg],
        "search_poi",
        params,
        normalizePoi,
        "poi",
      );
      // 服务端权威城市过滤：无法确认归属的结果一律丢弃（候选池搜索与攻略抽取共用此路径）
      const decision = filterByDestinationCity(result.normalized, city);
      for (const item of decision.rejected) {
        console.log(`[FlyAI:search_poi] 目的地过滤丢弃「${item.name}」：${item.reason}`);
      }
      return { raw: result.raw, normalized: decision.kept };
    },
  );
  if (outcome.fromCache) {
    console.log(
      `[FlyAI:search_poi] 24h 缓存命中「${city} ${keywordArg}」：${outcome.normalized.length} 条，0 live 调用，${outcome.latencyMs}ms`,
    );
  } else {
    console.log(
      `[FlyAI:search_poi] live 直跑「${city} ${keywordArg}」：${outcome.normalized.length} 条，${outcome.latencyMs}ms（去 npx）`,
    );
  }
  return {
    raw: outcome.raw,
    normalized: outcome.normalized,
    toolName: "search_poi",
    params,
    capturedAt: new Date().toISOString(),
    latencyMs: outcome.latencyMs,
    integrationPath: "cli",
  };
}

export interface SearchHotelsOptions {
  /** 结构化目的地（如 Trip.destination.city 的「三亚」），必填；不再从关键词拆词猜测 */
  destination: string;
  /** 片区：shared AreaConfig 结构（含 hotelKeyword/hotelRadiusKm/hotelMarkers），给出时叠加片区过滤 */
  area?: (AreaScopeConfig & { hotelKeyword: string }) | null;
  /** 自由关键词（仅 area 缺席时使用，如手动调试）；禁止把目的地拼进关键词 */
  keyword?: string | null;
}

/** 片区搜索关键词：使用配置的明确本地语义词（如「解放路」），不可为空 */
function hotelAreaKeyword(area: NonNullable<SearchHotelsOptions["area"]>): string {
  const keyword = area.hotelKeyword.trim();
  if (keyword) return keyword;
  throw new FlyAiError("FLYAI_NOT_CONFIGURED", {
    rawDetail: `片区「${area.name}」缺少酒店搜索关键词配置`,
  });
}

export async function searchHotels(
  options: SearchHotelsOptions,
  checkIn: string,
  checkOut: string,
): Promise<FlyAISearchResult<HotelCandidate>> {
  const destination = options.destination.trim();
  if (!destination) {
    throw new FlyAiError("FLYAI_INVALID_REQUEST", {
      rawDetail: "酒店搜索必须携带结构化目的地（destination）",
    });
  }
  const keyword = options.area ? hotelAreaKeyword(options.area) : (options.keyword ?? "").trim();
  if (!keyword) {
    throw new FlyAiError("FLYAI_INVALID_REQUEST", { rawDetail: "酒店搜索关键词不能为空" });
  }

  const areaName = options.area?.name ?? null;
  const params = {
    destination,
    keyword,
    area: areaName,
    checkInDate: checkIn,
    checkOutDate: checkOut,
  };

  // Task #335：凭据守卫必须在缓存查询之前（同 searchPoi，缺 key 时不得被缓存命中掩盖）
  assertFlyAiConfigured();

  // Task #335：酒店缓存键并入 checkIn/checkOut——不同日期价格/库存不同，禁止跨日期串结果。
  const outcome = await searchWithCache<HotelCandidate>(
    makeSearchKey([destination, keyword, checkIn, checkOut]),
    `${destination}\u0000${keyword}\u0000${checkIn}\u0000${checkOut}`,
    async () => {
      const result = await invokeCli(
        "search-hotels",
        [
          "--dest-name",
          destination,
          "--key-words",
          keyword,
          "--check-in-date",
          checkIn,
          "--check-out-date",
          checkOut,
        ],
        "search_hotels",
        params,
        normalizeHotel,
        "hotel",
      );

      // 服务端权威城市过滤：无法确认属于目的地的酒店一律丢弃（宁可空结果，不可错放）
      const cityDecision = filterByDestinationCity(result.normalized, destination);
      for (const item of cityDecision.rejected) {
        console.log(`[FlyAI:search_hotels] 目的地过滤丢弃「${item.name}」：${item.reason}`);
      }

      const filter: FlyAISearchFilterStats = {
        destination,
        areaName,
        rawCount: result.normalized.length,
        cityKept: cityDecision.kept.length,
        cityRejected: cityDecision.rejected.length,
        areaKept: null,
        areaRejected: null,
        kept: cityDecision.kept.length,
      };
      if (options.area == null) {
        return { raw: result.raw, normalized: cityDecision.kept, filter };
      }

      // 片区层过滤：坐标半径/本地标记确认 + 按距片区中心排序（仅对已过城市过滤的结果执行）
      const areaDecision = filterByAreaCenter(cityDecision.kept, options.area);
      for (const item of areaDecision.rejected) {
        console.log(`[FlyAI:search_hotels] 片区过滤丢弃「${item.name}」：${item.reason}`);
      }
      filter.areaKept = areaDecision.kept.length;
      filter.areaRejected = areaDecision.rejected.length;
      filter.kept = areaDecision.kept.length;
      return { raw: result.raw, normalized: areaDecision.kept, filter };
    },
  );
  if (outcome.fromCache) {
    console.log(
      `[FlyAI:search_hotels] 24h 缓存命中「${destination} ${keyword}」：${outcome.normalized.length} 条，0 live 调用，${outcome.latencyMs}ms`,
    );
  } else {
    console.log(
      `[FlyAI:search_hotels] live 直跑「${destination} ${keyword}」：${outcome.normalized.length} 条，${outcome.latencyMs}ms（去 npx）`,
    );
  }
  return {
    raw: outcome.raw,
    normalized: outcome.normalized,
    toolName: "search_hotels",
    params,
    capturedAt: new Date().toISOString(),
    latencyMs: outcome.latencyMs,
    integrationPath: "cli",
    filter: outcome.filter,
  };
}

export async function getFlyAiCliVersion(): Promise<string> {
  try {
    return await runProcess(process.platform === "win32" ? "npm.cmd" : "npm", [
      "view",
      CLI_PACKAGE,
      "version",
    ], 15_000);
  } catch {
    return "unknown";
  }
}

/** 稳定性验证结果（Task #335）：暴露真实 spawn 模式、成败、耗时与捕获到的输出/报错细节 */
export interface StabilityRunResult {
  /** 实际走的 spawn 模式：期望恒为 "bundle"（直跑），若为 "npx" 说明 bundle 解析失败退回 */
  mode: "bundle" | "npx";
  /** exit 0 为 true；非 0（含 commander 本地报错）为 false */
  ok: boolean;
  /** 成功时的完整 stdout（用于验证无截断）；失败时为空串 */
  output: string;
  /** 失败时的稳定错误码；成功时为空串 */
  errorCode: string;
  /** 失败时的原始细节（commander stderr，如 required option 未指定）；成功时为空串 */
  detail: string;
  /** 本次 spawn 墙钟毫秒 */
  ms: number;
}

/**
 * Task #335 稳定性验证专用（非业务入口，不被任何生产链路调用）：
 * 用**真实** buildSpawnTarget + runProcess + 错误分类跑一条 CLI 子命令。传非法参数
 * （如 search-poi 缺 --city-name）触发 commander 本地报错——不触网、不耗额度，用于
 * 20+ 次连续 / 并发 spawn 的句柄泄漏 / 输出截断 / ANSI 解析稳定性验证（verify-spawn-stability.ts）。
 * 本函数不抛错：失败以 { ok:false, errorCode, detail } 返回，便于批量统计。
 */
export async function runCliForStabilityTest(
  cliCommand: string,
  cliArgs: string[],
): Promise<StabilityRunResult> {
  const target = buildSpawnTarget(cliCommand, cliArgs);
  const startedAt = performance.now();
  try {
    const output = await runProcess(target.command, target.args, CLI_TIMEOUT_MS, target.env);
    return {
      mode: target.mode,
      ok: true,
      output,
      errorCode: "",
      detail: "",
      ms: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    const flyaiError =
      error instanceof FlyAiError
        ? error
        : classifyFlyAiError(error instanceof Error ? error.message : String(error));
    return {
      mode: target.mode,
      ok: false,
      output: "",
      errorCode: flyaiError.code,
      detail: flyaiError.rawDetail,
      ms: Math.round(performance.now() - startedAt),
    };
  }
}
