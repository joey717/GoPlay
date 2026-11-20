/**
 * /api/ai 系列接口的错误分类：稳定错误码 + 用户可读 message。
 *
 * - code 稳定可编程判断，前端据此给出可操作提示；
 * - message 面向最终用户，可直接展示，绝不包含密钥、请求头或原始密文；
 * - 上游百炼原始报错细节只进服务端日志（routes 层 console.error），
 *   不回传客户端。
 */

export type AiErrorCode =
  | "TRIP_NOT_FOUND"
  | "ENV_NOT_CONFIGURED"
  | "BAILIAN_REQUEST_FAILED"
  | "AI_PARSE_FAILED"
  | "PERSIST_FAILED"
  // Task #51 截图 OCR 专用：请求形态 / 文件校验 / 识别链路错误
  | "IMAGE_REQUIRED"
  | "IMAGE_FORMAT_UNSUPPORTED"
  | "IMAGE_TOO_LARGE"
  | "IMAGE_REJECTED"
  | "OCR_TIMEOUT"
  // Task #96 攻略来源（/api/guides）专用：请求形态 / 来源状态机错误
  | "INVALID_REQUEST"
  | "LINK_INVALID"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_BUSY"
  | "SOURCE_NOT_RETRYABLE"
  | "IMAGE_COUNT_EXCEEDED"
  // Task #97 攻略草案（B3）专用：可用来源缺失 / 草案状态机错误
  | "GUIDE_NO_SOURCES"
  | "DRAFT_NOT_FOUND"
  | "DRAFT_STALE"
  | "DRAFT_MISMATCH"
  // Task #123 补充句日期指令专用：写了 DAY 但缺数字 / 指定天超出范围
  | "GUIDE_DAY_NUMBER_REQUIRED"
  | "GUIDE_DAY_INDEX_OUT_OF_RANGE";

/** 各错误码对应的默认 HTTP 状态 */
const STATUS_BY_CODE: Record<AiErrorCode, number> = {
  TRIP_NOT_FOUND: 404,
  ENV_NOT_CONFIGURED: 503,
  BAILIAN_REQUEST_FAILED: 502,
  AI_PARSE_FAILED: 502,
  PERSIST_FAILED: 500,
  IMAGE_REQUIRED: 400,
  IMAGE_FORMAT_UNSUPPORTED: 422,
  IMAGE_TOO_LARGE: 413,
  IMAGE_REJECTED: 422,
  OCR_TIMEOUT: 504,
  INVALID_REQUEST: 400,
  LINK_INVALID: 400,
  SOURCE_NOT_FOUND: 404,
  SOURCE_BUSY: 409,
  SOURCE_NOT_RETRYABLE: 400,
  IMAGE_COUNT_EXCEEDED: 413,
  GUIDE_NO_SOURCES: 409,
  DRAFT_NOT_FOUND: 404,
  DRAFT_STALE: 409,
  DRAFT_MISMATCH: 409,
  GUIDE_DAY_NUMBER_REQUIRED: 400,
  GUIDE_DAY_INDEX_OUT_OF_RANGE: 400,
};

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly status: number;

  constructor(
    code: AiErrorCode,
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(message);
    this.name = "AiError";
    this.code = code;
    this.status = options?.status ?? STATUS_BY_CODE[code];
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * 兜底判断：百炼客户端抛出的配置类错误（变量未配置 / 前缀不合法）。
 * 提取入口在调用前已做主动检查，此处拦截残余的配置类异常，避免被误分类为请求失败。
 */
export function isBailianConfigError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /未配置|为空|前缀/.test(error.message);
}

/**
 * 把任意异常压成单行可读摘要（Task #90）：用于面向用户的 message，
 * 让前端能展示服务端真实原因（如一致性校验失败的具体条目），
 * 而不是只显示「抽取失败，请重试」。完整堆栈仍由 routes 层打服务端日志。
 */
export function condenseErrorDetail(error: unknown, maxLength = 200): string {
  const raw = error instanceof Error ? `${error.name}：${error.message}` : String(error);
  const condensed = raw.replace(/\s+/g, " ").trim();
  return condensed.length > maxLength ? `${condensed.slice(0, maxLength)}…` : condensed;
}
