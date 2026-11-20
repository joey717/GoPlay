/**
 * 启动加载行程的稳健性策略（Task #158）。
 *
 * 背景：`App` 启动时若只要 loadTrip 失败就清掉本地 tripId 并进入初始化，
 * 那么「服务端重启」与「Vite 全页重载」重叠导致的瞬时断连会被误判为
 * 「行程不存在」，用户会突然落到新建行程表单，原行程引用丢失。
 *
 * 契约：
 * 1. 只有 HTTP 404（服务端明确返回「行程不存在」）才算「确实不存在」；
 * 2. 网络错误、代理 502/503/504、超时、429 等临时失败一律保留 tripId，
 *    先做有限自动重试，仍失败由调用方展示「暂时无法连接」+ 手动重试；
 * 3. 其他 4xx（如 400 数据结构异常）保留引用但不自动重试，避免无效循环。
 *
 * 本模块只做分类与重试编排，不读写 localStorage，不改动任何行程数据。
 */

import type { Trip } from "@goplay/shared";
import { ApiError, loadTrip } from "../api/client";

/** 单次 GET 行程的超时预算：超时按临时失败处理（宁可重试，也不清行程引用） */
export const TRIP_LOAD_ATTEMPT_TIMEOUT_MS = 8_000;

/** 自动重试间隔（长度即自动重试次数：3 次，加上首次共 4 次尝试） */
export const TRIP_LOAD_RETRY_DELAYS_MS: readonly number[] = [500, 1_200, 2_500];

/** 启动加载失败分类：not-found 才允许清引用，transient 必须保留 */
export type TripLoadFailure =
  | { kind: "not-found"; message: string }
  | { kind: "transient"; message: string; autoRetry: boolean };

/** 主文案：无论哪种临时失败，界面统一说「暂时无法连接」，不暴露技术细节 */
const TRANSIENT_FALLBACK_MESSAGE = "暂时无法连接";

function transientMessage(status: number): string {
  if (status === 0) return "网络连接失败";
  if (status === 408) return "加载超时";
  if (status === 429) return "服务繁忙";
  if (status >= 500) return "服务暂时不可用";
  return "行程暂时无法加载";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * 把启动加载异常分类为「确实不存在」或「临时失败」。
 * 判定只看 HTTP 状态，不看 message 文案（文案会随服务端调整）。
 */
export function classifyTripLoadError(error: unknown): TripLoadFailure {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return { kind: "not-found", message: error.message };
    }
    const status = error.status;
    if (status === 0 || status === 408 || status === 425 || status === 429 || status >= 500) {
      return { kind: "transient", message: transientMessage(status), autoRetry: true };
    }
    // 其余 4xx（含 400）：保留引用，但不做无效的自动重试
    return { kind: "transient", message: transientMessage(status), autoRetry: false };
  }
  if (isAbortError(error)) {
    return { kind: "transient", message: "加载超时", autoRetry: true };
  }
  return { kind: "transient", message: TRANSIENT_FALLBACK_MESSAGE, autoRetry: true };
}

/** 调用方已放弃本次加载（组件卸载 / 阶段切换），不再重试也不再上报 */
export class TripLoadCancelledError extends Error {
  constructor() {
    super("行程加载已取消");
    this.name = "TripLoadCancelledError";
  }
}

export interface LoadTripWithRetryOptions {
  /** 是否为当前有效加载：false 时立即停止重试 */
  isActive?: () => boolean;
  /** 每次自动重试前回调（1-based 的下一次尝试序号 / 总尝试次数） */
  onRetry?: (info: { attempt: number; total: number; message: string }) => void;
  /** 单次请求超时（毫秒） */
  attemptTimeoutMs?: number;
  /** 自动重试间隔（主要供测试注入短间隔） */
  retryDelaysMs?: readonly number[];
  /** 等待实现（主要供测试注入） */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 单次加载：超时主动中止，避免请求悬挂把用户永久留在「正在打开行程」 */
async function loadTripOnce(tripId: string, timeoutMs: number): Promise<Trip> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await loadTrip(tripId, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 带有限自动重试的启动加载。
 * - 成功：返回 Trip；
 * - 404：立即抛出（不重试），由调用方清引用并进入初始化；
 * - 临时失败：按 retryDelaysMs 重试，仍失败则抛出最后一次错误（引用不动）。
 */
export async function loadTripWithRetry(
  tripId: string,
  options: LoadTripWithRetryOptions = {},
): Promise<Trip> {
  const delays = options.retryDelaysMs ?? TRIP_LOAD_RETRY_DELAYS_MS;
  const timeoutMs = options.attemptTimeoutMs ?? TRIP_LOAD_ATTEMPT_TIMEOUT_MS;
  const sleep = options.sleep ?? defaultSleep;
  const total = delays.length + 1;
  const isActive = options.isActive ?? (() => true);
  let lastError: unknown = new Error("行程加载失败");

  for (let attempt = 1; attempt <= total; attempt += 1) {
    if (!isActive()) throw new TripLoadCancelledError();
    try {
      return await loadTripOnce(tripId, timeoutMs);
    } catch (error) {
      lastError = error;
      const failure = classifyTripLoadError(error);
      const canRetry = failure.kind === "transient" && failure.autoRetry && attempt < total;
      if (!canRetry) throw error;
      options.onRetry?.({
        attempt: attempt + 1,
        total,
        message: failure.kind === "transient" ? failure.message : TRANSIENT_FALLBACK_MESSAGE,
      });
      await sleep(delays[attempt - 1] ?? 0);
      if (!isActive()) throw new TripLoadCancelledError();
    }
  }
  throw lastError;
}
