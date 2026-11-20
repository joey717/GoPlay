/**
 * FlyAI 搜索链路的错误契约（Task #55）：稳定错误码 + 安全响应体 + 原始细节仅进服务端日志。
 *
 * - code 稳定可编程判断，前端据此给出可操作提示（额度耗尽使用固定文案）；
 * - message 面向最终用户，简洁中文，绝不包含原始 body、CLI 命令、控制台地址、API Key 指引或堆栈；
 * - 客户端可见响应体固定为 { code, message, retryable } 三字段（安全结构）；
 * - 原始 stderr/stdout 等细节只保留在服务端日志（routes 层经 redactSecretsForLog 脱敏后打印），
 *   绝不进入 HTTP 响应。
 */

export type FlyAiErrorCode =
  /** 外部额度耗尽：HTTP 429 + trial 文案 / MCP code -32603 对应 trial 文案 */
  | "FLYAI_QUOTA_EXHAUSTED"
  /** 外部限流：429 但非额度类文案 */
  | "FLYAI_RATE_LIMITED"
  /** CLI 调用超时 */
  | "FLYAI_TIMEOUT"
  /** 未完成配置：凭据缺失 / 片区关键词配置缺失等 */
  | "FLYAI_NOT_CONFIGURED"
  /** CLI 组件不可用：npx 或可执行文件缺失/无权访问、进程无法启动（含 npm 缓存目录 EPERM/EACCES 写入失败，Task #115） */
  | "FLYAI_CLI_UNAVAILABLE"
  /** 上游失败：其余错误兜底（含输出非法 JSON / 体积超限） */
  | "FLYAI_UPSTREAM_FAILED"
  /** 请求参数不合法（400，由路由校验产生） */
  | "FLYAI_INVALID_REQUEST";

/**
 * 各错误码默认 HTTP 状态：
 * 外部 429 不直接透传，统一映射为网关类 503（依赖暂不可用），与既有 502/504 风格一致。
 */
export const FLYAI_STATUS_BY_CODE: Record<FlyAiErrorCode, number> = {
  FLYAI_QUOTA_EXHAUSTED: 503,
  FLYAI_RATE_LIMITED: 503,
  FLYAI_TIMEOUT: 504,
  FLYAI_NOT_CONFIGURED: 503,
  FLYAI_CLI_UNAVAILABLE: 503,
  FLYAI_UPSTREAM_FAILED: 502,
  FLYAI_INVALID_REQUEST: 400,
};

/** 各错误码的默认用户可读 message（简洁中文；不含任何原始报错细节） */
export const FLYAI_MESSAGE_BY_CODE: Record<FlyAiErrorCode, string> = {
  FLYAI_QUOTA_EXHAUSTED: "搜索服务额度暂不可用，请稍后重试",
  FLYAI_RATE_LIMITED: "搜索服务繁忙，请稍后重试",
  FLYAI_TIMEOUT: "搜索服务响应超时，请稍后重试",
  FLYAI_NOT_CONFIGURED: "搜索服务尚未完成配置，请联系管理员",
  FLYAI_CLI_UNAVAILABLE: "搜索服务组件不可用，请联系管理员",
  FLYAI_UPSTREAM_FAILED: "搜索服务暂时不可用，请稍后重试",
  FLYAI_INVALID_REQUEST: "搜索参数不完整，请调整后重试",
};

/** 是否建议用户重试：限流 / 超时 / 上游抖动可重试；配置与组件缺失需管理员处理 */
const RETRYABLE_BY_CODE: Record<FlyAiErrorCode, boolean> = {
  FLYAI_QUOTA_EXHAUSTED: true,
  FLYAI_RATE_LIMITED: true,
  FLYAI_TIMEOUT: true,
  FLYAI_NOT_CONFIGURED: false,
  FLYAI_CLI_UNAVAILABLE: false,
  FLYAI_UPSTREAM_FAILED: true,
  FLYAI_INVALID_REQUEST: false,
};

/** 客户端可见的安全响应体：仅此三字段 */
export interface FlyAiSafeErrorBody {
  code: FlyAiErrorCode;
  message: string;
  retryable: boolean;
}

/** 搜索链路分类错误：message 安全可展示；rawDetail 仅供服务端日志 */
export class FlyAiError extends Error {
  readonly code: FlyAiErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  /** 原始细节（CLI stderr/stdout、进程错误等）：绝不进 HTTP 响应 */
  readonly rawDetail: string;

  constructor(
    code: FlyAiErrorCode,
    options: { rawDetail?: string; cause?: unknown; message?: string } = {},
  ) {
    super(options.message ?? FLYAI_MESSAGE_BY_CODE[code]);
    this.name = "FlyAiError";
    this.code = code;
    this.status = FLYAI_STATUS_BY_CODE[code];
    this.retryable = RETRYABLE_BY_CODE[code];
    this.rawDetail = options.rawDetail ?? "";
    if (options.cause !== undefined) this.cause = options.cause;
  }

  /** 安全响应体：只有 code/message/retryable，无任何原始细节 */
  toSafeBody(): FlyAiSafeErrorBody {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

// ===== 原始报错文本 → 稳定错误码（纯函数，可离线测试） =====

/** 额度耗尽：trial 限额 / quota / 中文额度提示（含 MCP -32603 携带 trial 文案的组合） */
const QUOTA_PATTERN = /trial|quota|额度|试用/i;
/** 外部限流状态码（无额度文案时的普通 429） */
const HTTP_429_PATTERN = /\b429\b/;
/** 调用超时 */
const TIMEOUT_PATTERN = /调用超过|超时|timed?\s*out|timeout|ETIMEDOUT/i;
/** 未配置 / 配置缺失 */
const NOT_CONFIGURED_PATTERN =
  /未配置|未设置|缺少[^\n]{0,24}配置|not\s+configured|missing[^\n]{0,32}(?:key|token|credential|api[-\s_]?key)|(?:api[-\s_]?key|apikey|credential|token)[^\n]{0,32}(?:missing|invalid|not\s+set|required|absent)/i;
/** CLI 组件不可用：含可执行文件缺失/无权访问，以及 npm 缓存目录写入失败（EPERM/EACCES/permission denied，Task #115） */
const CLI_UNAVAILABLE_PATTERN =
  /ENOENT|command not found|not recognized|EACCES|EPERM|permission denied|未找到[^\n]{0,24}(?:npx|命令|可执行)|无法启动|无权启动/i;

/**
 * 按优先级把外部 FlyAI 原始报错归类为稳定错误码。
 * 判定顺序：额度耗尽 → 普通限流 429 → 超时 → 未配置 → CLI 不可用 → 上游失败兜底。
 * 纯函数：只读入原始文本、输出 FlyAiError（rawDetail 保留原文供日志），可离线复核。
 */
export function classifyFlyAiError(rawDetail: string): FlyAiError {
  const text = rawDetail ?? "";
  if (QUOTA_PATTERN.test(text)) return new FlyAiError("FLYAI_QUOTA_EXHAUSTED", { rawDetail: text });
  if (HTTP_429_PATTERN.test(text)) return new FlyAiError("FLYAI_RATE_LIMITED", { rawDetail: text });
  if (TIMEOUT_PATTERN.test(text)) return new FlyAiError("FLYAI_TIMEOUT", { rawDetail: text });
  if (NOT_CONFIGURED_PATTERN.test(text)) {
    return new FlyAiError("FLYAI_NOT_CONFIGURED", { rawDetail: text });
  }
  if (CLI_UNAVAILABLE_PATTERN.test(text)) {
    return new FlyAiError("FLYAI_CLI_UNAVAILABLE", { rawDetail: text });
  }
  return new FlyAiError("FLYAI_UPSTREAM_FAILED", { rawDetail: text });
}

/** 任意异常 → 安全分类错误（已是 FlyAiError 原样返回；其余按 message 兜底分类） */
export function toSafeFlyAiError(error: unknown): FlyAiError {
  if (error instanceof FlyAiError) return error;
  const rawDetail = error instanceof Error ? error.message : String(error);
  return classifyFlyAiError(rawDetail);
}

/** 参数校验错误的响应体（400）：仍走统一安全结构 */
export function flyAiInvalidRequest(message: string): FlyAiSafeErrorBody {
  return { code: "FLYAI_INVALID_REQUEST", message, retryable: false };
}

// ===== 服务端日志脱敏 =====

/** 常见密钥形态：sk- 令牌 / Bearer 头 / key=value 赋值 */
const SECRET_RULES: readonly { pattern: RegExp; replacement: string }[] = [
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/g, replacement: "[已脱敏]" },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: "Bearer [已脱敏]" },
  {
    pattern:
      /((?:api[-_]?key|apikey|access[-_]?token|token|secret|password)["']?\s*[:=]\s*["']?)([A-Za-z0-9._~+/=-]{6,})/gi,
    replacement: "$1[已脱敏]",
  },
];

/** 原始细节进日志前统一脱敏，保证服务端日志也不出现密钥 */
export function redactSecretsForLog(text: string): string {
  let output = text;
  for (const rule of SECRET_RULES) output = output.replace(rule.pattern, rule.replacement);
  return output;
}
