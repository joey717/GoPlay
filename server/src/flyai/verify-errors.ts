/**
 * FlyAI 错误契约离线验证（Task #55；不调用真实 CLI / 网络）。
 *
 * A. 错误映射：trial 429 / 普通 429 / 超时 / 未知错误 / ENOENT / EPERM / EACCES /
 *    permission denied / 缺配置 / -32603 无 trial 文案
 *    → 断言稳定 code、HTTP 状态、retryable、固定安全 message；
 * B. HTTP 路由验证：createFlyAiRoutes 注入桩函数（隔离真实 CLI），对 /api/flyai/search 断言：
 *    - 失败响应体仅 { code, message, retryable } 三字段；
 *    - 响应文本不含 MCP / flyai.open / API Key / --help / npx / -32603 / jsonrpc；
 *    - 额度耗尽 code/message 固定，且不携带任何酒店数据（不伪造、不回退）；宁可空列表；
 *    - 参数校验 400 + FLYAI_INVALID_REQUEST；成功路径封套原样透传。
 * C. 老城地域过滤回归：塔林 Old Town 样本必须被丢弃，三亚解放路样本必须保留
 *    （确保 Task #45 的过滤逻辑未回退；本脚本不改动过滤实现，仅做幂等复核）。
 * D. CLI 前置凭据校验（Task #62）：临时清空 FLYAI_API_KEY 后调用 searchPoi，
 *    必须在触达 CLI 之前抛出 FLYAI_NOT_CONFIGURED（503 / 不可重试），随后恢复现场。
 *
 * 运行：npx tsx server/src/flyai/verify-errors.ts
 */
import { findAreaByName } from "@goplay/shared";
import {
  FLYAI_MESSAGE_BY_CODE,
  FlyAiError,
  classifyFlyAiError,
  redactSecretsForLog,
  toSafeFlyAiError,
  type FlyAiErrorCode,
  type FlyAiSafeErrorBody,
} from "./errors.js";
import { searchPoi } from "./client.js";
import { createFlyAiRoutes, type FlyAiRouteDeps } from "./routes.js";
import { filterByAreaCenter, filterByDestinationCity } from "./scope.js";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  [PASS] ${label}`);
    return;
  }
  failures += 1;
  console.error(`  [FAIL] ${label}${detail === "" ? "" : `（${detail}）`}`);
}

// ===== 敏感子串黑名单：HTTP 响应与安全体一律不得出现 =====
const FORBIDDEN_SUBSTRINGS = ["MCP", "flyai.open", "API Key", "--help", "npx", "-32603", "jsonrpc", "Body:"];

function firstForbiddenHit(text: string): string | null {
  const lowered = text.toLowerCase();
  for (const needle of FORBIDDEN_SUBSTRINGS) {
    if (lowered.includes(needle.toLowerCase())) return needle;
  }
  return null;
}

// ===== 模拟样本（取自 2026-10 试用额度耗尽时的真实 CLI 报错形态） =====
const TRIAL_429_RAW = [
  "MCP HTTP 429: ",
  'Body: {"jsonrpc":"2.0","id":"1","error":{"code":-32603,"message":"Trial limit reached. Please visit the console at flyai.open.fliggy.com to get a formal API Key"}}',
].join("\n");
const PLAIN_429_RAW = "MCP HTTP 429: Too Many Requests";
const TIMEOUT_RAW = "FlyAI CLI 调用超过 90 秒，已终止";
const UNKNOWN_RAW = "磁盘写入异常：上游返回了无法识别的错误形态";
const ENOENT_RAW = "未找到可执行文件（ENOENT）：npx";
/** npm 写默认缓存 ~/.npm/_cacache/tmp 遇 EPERM 的真实报错形态（Task #115 根因样本） */
const NPM_CACHE_EPERM_RAW = [
  "npm error code EPERM",
  "npm error syscall mkdir",
  "npm error path /Users/dev/.npm/_cacache/tmp-8f2a11",
  "npm error errno -13",
  "npm error Error: EPERM: operation not permitted, mkdir '/Users/dev/.npm/_cacache/tmp-8f2a11'",
].join("\n");
const NPM_CACHE_EACCES_RAW = [
  "npm error code EACCES",
  "npm error syscall open",
  "npm error path /Users/dev/.npm/_cacache/index-v5/package-lock.json",
].join("\n");
const PERMISSION_DENIED_RAW =
  "spawnSync npx EACCES: permission denied, spawn npx --yes @fly-ai/flyai-cli";
const NOT_CONFIGURED_RAW = "片区「老城」缺少酒店搜索关键词配置";
const MCP_INTERNAL_RAW =
  'MCP HTTP 200: Body: {"jsonrpc":"2.0","error":{"code":-32603,"message":"internal error"}}';
/** 旧版 client.ts 拼接出的完整报错（含 --help / flyai.open / API Key 指引）：也必须被安全分类 */
const LEGACY_FULL_RAW =
  "FlyAI CLI 调用失败：MCP HTTP 429: \n" +
  'Body: {"jsonrpc":"2.0","id":"1","error":{"code":-32603,"message":"Trial limit reached. Please visit the console at flyai.open.fliggy.com to get a formal API Key"}}\n' +
  "请运行 npx --yes @fly-ai/flyai-cli --help 检查安装，并在 flyai.open.fliggy.com 配置可用 API Key。";

// ===== A. 错误映射（纯函数） =====

function verifyErrorMapping(): void {
  console.log("\nA. 错误映射（classifyFlyAiError 纯函数）");

  const cases: {
    label: string;
    raw: string;
    code: FlyAiErrorCode;
    status: number;
    retryable: boolean;
  }[] = [
    {
      label: "trial 429（MCP -32603 + Trial limit reached）",
      raw: TRIAL_429_RAW,
      code: "FLYAI_QUOTA_EXHAUSTED",
      status: 503,
      retryable: true,
    },
    {
      label: "普通 429（无额度文案）",
      raw: PLAIN_429_RAW,
      code: "FLYAI_RATE_LIMITED",
      status: 503,
      retryable: true,
    },
    {
      label: "CLI 调用超时",
      raw: TIMEOUT_RAW,
      code: "FLYAI_TIMEOUT",
      status: 504,
      retryable: true,
    },
    {
      label: "未知错误兜底",
      raw: UNKNOWN_RAW,
      code: "FLYAI_UPSTREAM_FAILED",
      status: 502,
      retryable: true,
    },
    {
      label: "CLI 不可用（ENOENT）",
      raw: ENOENT_RAW,
      code: "FLYAI_CLI_UNAVAILABLE",
      status: 503,
      retryable: false,
    },
    {
      label: "CLI 不可用（npm 缓存目录 EPERM，Task #115）",
      raw: NPM_CACHE_EPERM_RAW,
      code: "FLYAI_CLI_UNAVAILABLE",
      status: 503,
      retryable: false,
    },
    {
      label: "CLI 不可用（npm 缓存目录 EACCES）",
      raw: NPM_CACHE_EACCES_RAW,
      code: "FLYAI_CLI_UNAVAILABLE",
      status: 503,
      retryable: false,
    },
    {
      label: "CLI 不可用（permission denied 文案）",
      raw: PERMISSION_DENIED_RAW,
      code: "FLYAI_CLI_UNAVAILABLE",
      status: 503,
      retryable: false,
    },
    {
      label: "片区关键词配置缺失",
      raw: NOT_CONFIGURED_RAW,
      code: "FLYAI_NOT_CONFIGURED",
      status: 503,
      retryable: false,
    },
    {
      label: "-32603 无 trial 文案",
      raw: MCP_INTERNAL_RAW,
      code: "FLYAI_UPSTREAM_FAILED",
      status: 502,
      retryable: true,
    },
  ];

  for (const item of cases) {
    const error = classifyFlyAiError(item.raw);
    check(`${item.label} → code=${item.code}`, error.code === item.code, `实际 ${error.code}`);
    check(`${item.label} → HTTP ${item.status}`, error.status === item.status, `实际 ${error.status}`);
    check(
      `${item.label} → retryable=${String(item.retryable)}`,
      error.retryable === item.retryable,
      `实际 ${String(error.retryable)}`,
    );
    const safeText = JSON.stringify(error.toSafeBody());
    const hit = firstForbiddenHit(safeText);
    check(`安全体不含敏感子串`, hit === null, `命中「${String(hit)}」`);
  }

  check(
    "额度耗尽 message 固定为「搜索服务额度暂不可用，请稍后重试」",
    FLYAI_MESSAGE_BY_CODE.FLYAI_QUOTA_EXHAUSTED === "搜索服务额度暂不可用，请稍后重试",
  );

  const legacy = classifyFlyAiError(LEGACY_FULL_RAW);
  check(
    "旧版完整报错 → FLYAI_QUOTA_EXHAUSTED",
    legacy.code === "FLYAI_QUOTA_EXHAUSTED",
    `实际 ${legacy.code}`,
  );
  const legacyHit = firstForbiddenHit(JSON.stringify(legacy.toSafeBody()));
  check("旧版完整报错 → 安全体不含敏感子串", legacyHit === null, `命中「${String(legacyHit)}」`);

  const redacted = redactSecretsForLog(
    "request failed: apiKey=sk-FAKE-NOT-A-REAL-KEY-000000 Authorization: Bearer FAKE-NOT-A-REAL-TOKEN",
  );
  check("日志脱敏移除 sk- 令牌", !redacted.includes("sk-FAKE-NOT-A-REAL-KEY-000000"), redacted);
  check("日志脱敏移除 Bearer 令牌", !redacted.includes("FAKE-NOT-A-REAL-TOKEN"), redacted);
}

// ===== B. HTTP 路由验证（注入桩函数） =====

const HOTEL_PATH = `/search?${new URLSearchParams({
  type: "hotel",
  destination: "三亚",
  area: "老城",
  checkIn: "2026-11-08",
  checkOut: "2026-11-09",
}).toString()}`;
const POI_PATH = `/search?${new URLSearchParams({
  type: "poi",
  q: "西岛",
  destination: "三亚",
}).toString()}`;

/** 两个搜索桩都抛出同一错误：只验证路由的错误通道，不触网、不调 CLI */
function throwingDeps(error: unknown): FlyAiRouteDeps {
  return {
    searchPoi: async () => {
      throw error;
    },
    searchHotels: async () => {
      throw error;
    },
  };
}

const EMPTY_HOTEL_ENVELOPE: Awaited<ReturnType<FlyAiRouteDeps["searchHotels"]>> = {
  raw: { ok: true, items: [] },
  normalized: [],
  toolName: "search_hotels",
  params: { destination: "三亚", keyword: "解放路" },
  capturedAt: new Date().toISOString(),
  latencyMs: 0,
  integrationPath: "cli",
};
const EMPTY_POI_ENVELOPE: Awaited<ReturnType<FlyAiRouteDeps["searchPoi"]>> = {
  raw: { ok: true, items: [] },
  normalized: [],
  toolName: "search_poi",
  params: { query: "西岛", destination: "三亚" },
  capturedAt: new Date().toISOString(),
  latencyMs: 0,
  integrationPath: "cli",
};

interface HttpCase {
  label: string;
  path: string;
  error: unknown;
  status: number;
  code?: string;
  message?: string;
  retryable?: boolean;
}

async function verifyHttpCase(item: HttpCase): Promise<void> {
  const app = createFlyAiRoutes(throwingDeps(item.error));
  const res = await app.request(item.path);
  const text = await res.text();
  check(`${item.label} → HTTP ${item.status}`, res.status === item.status, `实际 ${res.status}`);

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    parsed = null;
  }
  const keys =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.keys(parsed as Record<string, unknown>).sort()
      : [];
  check(
    `${item.label} → 响应体仅 {code,message,retryable}`,
    JSON.stringify(keys) === JSON.stringify(["code", "message", "retryable"]),
    `实际键 [${keys.join(",")}]`,
  );

  const body = (parsed ?? {}) as FlyAiSafeErrorBody;
  if (item.code !== undefined) {
    check(`${item.label} → code=${item.code}`, body.code === item.code, `实际 ${String(body.code)}`);
  }
  if (item.message !== undefined) {
    check(
      `${item.label} → message 固定`,
      body.message === item.message,
      `实际「${String(body.message)}」`,
    );
  }
  if (item.retryable !== undefined) {
    check(
      `${item.label} → retryable=${String(item.retryable)}`,
      body.retryable === item.retryable,
      `实际 ${String(body.retryable)}`,
    );
  }
  const hit = firstForbiddenHit(text);
  check(
    `${item.label} → 响应不含 MCP/flyai.open/API Key/--help 等`,
    hit === null,
    `命中「${String(hit)}」`,
  );
  check(`${item.label} → 不携带任何搜索结果`, !text.includes("normalized"));
}

async function verifyHttpRoutes(): Promise<void> {
  console.log("\nB. HTTP 路由验证（注入桩函数，隔离真实 CLI）");

  await verifyHttpCase({
    label: "酒店·trial 429",
    path: HOTEL_PATH,
    error: classifyFlyAiError(TRIAL_429_RAW),
    status: 503,
    code: "FLYAI_QUOTA_EXHAUSTED",
    message: FLYAI_MESSAGE_BY_CODE.FLYAI_QUOTA_EXHAUSTED,
    retryable: true,
  });
  await verifyHttpCase({
    label: "酒店·trial 429（旧版完整报错字符串，非 FlyAiError 兜底分类）",
    path: HOTEL_PATH,
    error: new Error(LEGACY_FULL_RAW),
    status: 503,
    code: "FLYAI_QUOTA_EXHAUSTED",
    message: FLYAI_MESSAGE_BY_CODE.FLYAI_QUOTA_EXHAUSTED,
    retryable: true,
  });
  await verifyHttpCase({
    label: "POI·trial 429",
    path: POI_PATH,
    error: classifyFlyAiError(TRIAL_429_RAW),
    status: 503,
    code: "FLYAI_QUOTA_EXHAUSTED",
    message: FLYAI_MESSAGE_BY_CODE.FLYAI_QUOTA_EXHAUSTED,
    retryable: true,
  });
  await verifyHttpCase({
    label: "酒店·普通 429",
    path: HOTEL_PATH,
    error: classifyFlyAiError(PLAIN_429_RAW),
    status: 503,
    code: "FLYAI_RATE_LIMITED",
    retryable: true,
  });
  await verifyHttpCase({
    label: "酒店·超时",
    path: HOTEL_PATH,
    error: classifyFlyAiError(TIMEOUT_RAW),
    status: 504,
    code: "FLYAI_TIMEOUT",
    retryable: true,
  });
  await verifyHttpCase({
    label: "酒店·未知错误",
    path: HOTEL_PATH,
    error: new Error(UNKNOWN_RAW),
    status: 502,
    code: "FLYAI_UPSTREAM_FAILED",
    retryable: true,
  });
  await verifyHttpCase({
    label: "酒店·CLI 不可用",
    path: HOTEL_PATH,
    error: classifyFlyAiError(ENOENT_RAW),
    status: 503,
    code: "FLYAI_CLI_UNAVAILABLE",
    retryable: false,
  });
  await verifyHttpCase({
    label: "酒店·CLI 缓存目录权限错误（npm EPERM，Task #115）",
    path: HOTEL_PATH,
    error: classifyFlyAiError(NPM_CACHE_EPERM_RAW),
    status: 503,
    code: "FLYAI_CLI_UNAVAILABLE",
    message: FLYAI_MESSAGE_BY_CODE.FLYAI_CLI_UNAVAILABLE,
    retryable: false,
  });
  await verifyHttpCase({
    label: "酒店·凭据未配置（FLYAI_API_KEY 缺失，Task #62）",
    path: HOTEL_PATH,
    error: new FlyAiError("FLYAI_NOT_CONFIGURED", { rawDetail: "FLYAI_API_KEY 未配置" }),
    status: 503,
    code: "FLYAI_NOT_CONFIGURED",
    message: FLYAI_MESSAGE_BY_CODE.FLYAI_NOT_CONFIGURED,
    retryable: false,
  });

  // 参数校验错误：400 + FLYAI_INVALID_REQUEST（同样只含安全结构）
  const validationApp = createFlyAiRoutes(throwingDeps(new Error(LEGACY_FULL_RAW)));
  const missingDestination = await validationApp.request(
    `/search?${new URLSearchParams({
      type: "hotel",
      area: "老城",
      checkIn: "2026-11-08",
      checkOut: "2026-11-09",
    }).toString()}`,
  );
  const missingText = await missingDestination.text();
  check(
    "酒店·缺 destination → HTTP 400",
    missingDestination.status === 400,
    `实际 ${missingDestination.status}`,
  );
  check(
    "酒店·缺 destination → code=FLYAI_INVALID_REQUEST",
    missingText.includes("FLYAI_INVALID_REQUEST"),
  );
  const missingHit = firstForbiddenHit(missingText);
  check("酒店·缺 destination → 响应不含敏感子串", missingHit === null, `命中「${String(missingHit)}」`);

  // 成功路径：封套原样透传；空结果保持空数组（宁可空列表，不伪造）
  const successApp = createFlyAiRoutes({
    searchPoi: async () => EMPTY_POI_ENVELOPE,
    searchHotels: async () => EMPTY_HOTEL_ENVELOPE,
  });
  const successRes = await successApp.request(HOTEL_PATH);
  const successBody = (await successRes.json()) as {
    normalized?: unknown;
    integrationPath?: unknown;
    code?: unknown;
  };
  check("酒店·成功路径 HTTP 200", successRes.status === 200, `实际 ${successRes.status}`);
  check(
    "酒店·成功路径空结果不伪造不回退",
    Array.isArray(successBody.normalized) && successBody.normalized.length === 0,
  );
  check("酒店·成功路径封套透传 integrationPath=cli", successBody.integrationPath === "cli");
  check("酒店·成功路径不含错误 code", successBody.code === undefined);

  // 老城片区搜索的调用形态：路由必须把 shared 片区配置（hotelKeyword=解放路）传给搜索层
  let captured: { options?: Record<string, unknown>; checkIn?: string; checkOut?: string } = {};
  const captureApp = createFlyAiRoutes({
    searchPoi: async () => EMPTY_POI_ENVELOPE,
    searchHotels: async (options, checkIn, checkOut) => {
      captured = { options: options as unknown as Record<string, unknown>, checkIn, checkOut };
      return EMPTY_HOTEL_ENVELOPE;
    },
  });
  await captureApp.request(HOTEL_PATH);
  const capturedArea = captured.options?.area as
    | { name?: string; hotelKeyword?: string }
    | null
    | undefined;
  check(
    "酒店·路由传入老城片区配置（keyword=解放路）",
    capturedArea?.name === "老城" && capturedArea?.hotelKeyword === "解放路",
    JSON.stringify(capturedArea ?? null),
  );
  check("酒店·片区搜索不拼接调用方关键词", captured.options?.keyword === null);
  check(
    "酒店·路由透传目的地与日期",
    captured.options?.destination === "三亚" &&
      captured.checkIn === "2026-11-08" &&
      captured.checkOut === "2026-11-09",
  );
}

// ===== C. 老城地域过滤回归 =====

interface FilterSample {
  name: string;
  address: string | null;
  coords: { lng: number; lat: number } | null;
}

function verifyLaochengFilterRegression(): void {
  console.log("\nC. 老城地域过滤回归（Task #45 逻辑未回退）");

  const area = findAreaByName("老城");
  if (area === undefined) {
    check("老城片区配置存在", false);
    return;
  }
  check("老城片区配置存在且关键词为「解放路」", area.hotelKeyword === "解放路");

  const foreignSamples: FilterSample[] = [
    { name: "CRU 酒店", address: "Viru 3, Tallinn, Estonia", coords: null },
    {
      name: "梅查特斯家庭酒店",
      address: "爱沙尼亚塔林老城",
      coords: { lng: 24.7536, lat: 59.4369 },
    },
  ];
  const foreignDecision = filterByDestinationCity(foreignSamples, "三亚");
  check(
    "境外 Old Town 样本全部被城市过滤丢弃",
    foreignDecision.kept.length === 0 && foreignDecision.rejected.length === 2,
    `kept=${foreignDecision.kept.length} rejected=${foreignDecision.rejected.length}`,
  );

  const localSamples: FilterSample[] = [
    {
      name: "三亚解放路亚朵酒店",
      address: "三亚市解放路 88 号",
      coords: { lng: 109.5015, lat: 18.2526 },
    },
    { name: "三亚全季酒店(解放路店)", address: null, coords: null },
  ];
  const localCity = filterByDestinationCity(localSamples, "三亚");
  check(
    "三亚解放路本地样本通过城市过滤",
    localCity.kept.length === 2 && localCity.rejected.length === 0,
    `kept=${localCity.kept.length} rejected=${localCity.rejected.length}`,
  );
  const localArea = filterByAreaCenter(localCity.kept, area);
  check(
    "三亚解放路本地样本通过老城片区过滤",
    localArea.kept.length === 2 && localArea.rejected.length === 0,
    JSON.stringify(localArea.rejected),
  );

  const distant: FilterSample = {
    name: "三亚亚特兰蒂斯酒店",
    address: "三亚市海棠湾海棠北路 36 号",
    coords: { lng: 109.739, lat: 18.3213 },
  };
  const distantCity = filterByDestinationCity([distant], "三亚");
  check("海棠湾样本通过城市过滤（确属三亚）", distantCity.kept.length === 1);
  const distantArea = filterByAreaCenter(distantCity.kept, area);
  check(
    "海棠湾样本被老城片区过滤丢弃（超半径）",
    distantArea.kept.length === 0 && distantArea.rejected.length === 1,
    `kept=${distantArea.kept.length}`,
  );
}

// ===== D. CLI 前置凭据校验（Task #62，不触达 CLI/网络） =====

/**
 * 临时清空 FLYAI_API_KEY 后调用 searchPoi：必须在前置校验处抛出
 * FLYAI_NOT_CONFIGURED（未配置时绝不启动 CLI 子进程），结束后恢复现场。
 */
async function verifyCredentialsGuard(): Promise<void> {
  console.log("\nD. CLI 前置凭据校验（不会触达 CLI/网络）");

  const saved = process.env.FLYAI_API_KEY;
  delete process.env.FLYAI_API_KEY;
  try {
    await searchPoi("西岛", { destination: "三亚" });
    check("缺 FLYAI_API_KEY 时 searchPoi 必须抛错", false, "未抛错（可能已触达 CLI）");
  } catch (error) {
    const safe = toSafeFlyAiError(error);
    check(
      "缺 FLYAI_API_KEY → FLYAI_NOT_CONFIGURED / 503 / 不可重试",
      safe.code === "FLYAI_NOT_CONFIGURED" && safe.status === 503 && safe.retryable === false,
      `实际 ${safe.code} / ${safe.status} / ${String(safe.retryable)}`,
    );
    check(
      "缺凭据错误 message 固定安全文案",
      safe.message === FLYAI_MESSAGE_BY_CODE.FLYAI_NOT_CONFIGURED,
      `实际「${safe.message}」`,
    );
    const hit = firstForbiddenHit(JSON.stringify(safe.toSafeBody()));
    check("缺凭据错误安全体不含敏感子串", hit === null, `命中「${String(hit)}」`);
  } finally {
    if (saved !== undefined) process.env.FLYAI_API_KEY = saved;
  }
}

async function main(): Promise<void> {
  console.log("FlyAI 错误契约离线验证（Task #55）：不调用真实 CLI / 网络");
  verifyErrorMapping();
  await verifyHttpRoutes();
  verifyLaochengFilterRegression();
  await verifyCredentialsGuard();

  if (failures > 0) {
    console.error(`\n验证失败：${failures} 项断言未通过`);
    process.exitCode = 1;
    return;
  }
  console.log(
    "\n验证通过：错误映射 / HTTP 安全契约 / 老城过滤回归 / 凭据前置校验 全部通过；响应无 MCP、flyai.open、API Key、--help 等敏感细节。",
  );
}

main().catch((error: unknown) => {
  console.error("离线错误契约验证执行失败：", error);
  process.exitCode = 1;
});
