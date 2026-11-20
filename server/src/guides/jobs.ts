/**
 * Task #96 攻略来源后台作业原语：per-trip 互斥锁、图片并发队列、活跃 job 注册表。
 *
 * 并发模型（Task #94 实测基线；Task #175 放宽上限）：
 * - 同一 Trip 的「load → 改 → save」临界区用 withTripLock 串行化，防止
 *   两个写路径基于同一旧快照互相覆盖（tripStore.save 无乐观锁比对，后写胜出）；
 * - 锁窗口只覆盖内存合并 + save（毫秒级），百炼 / FlyAI / 抓取等长网络调用
 *   一律由调用方放在锁外（见 service.ts 的乐观版本提交），
 *   保证提交接口两秒内返回；
 * - 图片队列：并发 4、单图 120s 超时（Task #121）；来源总预算按实际
 *   送模型图片数动态伸缩（guideSourceBudgetMs，Task #175）：
 *   批次预算 × ceil(图数/4)，下限 180s、上限 1200s——防止固定总预算
 *   在图片增多后系统性切断后半段；
 * - 预算耗尽后不再启动新图，进行中的任务由「来源运行令牌」失效丢弃迟到写入；
 *   令牌窗口同时覆盖预筛阶段（withSourceImageRun，Task #175）——
 *   预筛期间用户重试同来源时，旧一轮的预筛 / 队列结果一律不写盘；
 * - 活跃 job 注册表（进程内）：重启恢复扫描据此区分「真在跑」与
 *   「重启遗留的 processing」（后者转 partial 并提示可重试）。
 */

import type { GuideImageFailureCode } from "@goplay/shared";

// ===== per-trip 互斥锁 =====

/** 每个 Trip 一条 promise 链：后来的调用等前一个完成后再进入临界区 */
const tripLocks = new Map<string, Promise<void>>();

/**
 * 串行执行 fn（同一 tripId 的调用按到达顺序排队）。
 * - fn 抛错不影响后续排队者（链尾吞掉 rejection，只作完成信号）；
 * - 调用方拿到的是自己那次 fn 的真实结果 / 异常；
 * - 无竞争时清理 Map 条目，防止长期运行泄漏。
 */
export async function withTripLock<T>(tripId: string, fn: () => Promise<T>): Promise<T> {
  const previous = tripLocks.get(tripId) ?? Promise.resolve();
  const invocation = previous.then(
    () => fn(),
    () => fn(),
  );
  const tail = invocation.then(
    () => undefined,
    () => undefined,
  );
  tripLocks.set(tripId, tail);
  void tail.then(() => {
    if (tripLocks.get(tripId) === tail) tripLocks.delete(tripId);
  });
  return invocation;
}

// ===== 活跃 job 注册表（进程内；重启即清空，是「过期 processing」判定的权威） =====

/** tripId -> 正在处理中的 sourceId 集合 */
const activeJobs = new Map<string, Set<string>>();

export function registerGuideJob(tripId: string, sourceId: string): void {
  let set = activeJobs.get(tripId);
  if (set === undefined) {
    set = new Set<string>();
    activeJobs.set(tripId, set);
  }
  set.add(sourceId);
}

export function unregisterGuideJob(tripId: string, sourceId: string): void {
  const set = activeJobs.get(tripId);
  if (set === undefined) return;
  set.delete(sourceId);
  if (set.size === 0) activeJobs.delete(tripId);
}

export function hasActiveGuideJob(tripId: string, sourceId: string): boolean {
  return activeJobs.get(tripId)?.has(sourceId) === true;
}

// ===== 图片并发队列（并发 4 / 总预算 180s / 单图 120s） =====

/**
 * 队列运行上下文（来源级运行令牌）：单图任务据此判断「本轮是否还该写盘」。
 * 失效情形（任一）：本轮队列已结束（全部完成 / 总预算耗尽）、同一来源已开始
 * 新一轮队列（用户在 partial 上重试）。失效后任务必须丢弃结果且不落盘——
 * 否则迟到写入会覆盖结算时记下的 timeout，或在重试时对同一张图重复写证据。
 */
export interface GuideImageRunContext {
  /** true = 本轮仍有效，可以写盘；false = 结果必须丢弃 */
  isActive(): boolean;
}

interface GuideImageRun extends GuideImageRunContext {
  readonly tripId: string;
  readonly sourceId: string;
  /** null = 有效；非 null = 失效原因（排查迟到结果用） */
  abortReason: string | null;
}

/** `${tripId}::${sourceId}` -> 该来源当前有效的一轮（进程内；重启即清空） */
const activeImageRuns = new Map<string, GuideImageRun>();

/** 无令牌场景的兜底上下文（队列单测等直接调用方） */
const ALWAYS_ACTIVE: GuideImageRunContext = { isActive: () => true };

/** 单图任务的确定结果：成功携带证据 ID，失败携带具体 failureCode；令牌失效 / 来源已离开 processing（被移除 / 重试复位等）时结果丢弃为 skipped */
export interface GuideImageTaskResult {
  index: number;
  outcome:
    | { kind: "ready"; evidenceId: string }
    | { kind: "failed"; failureCode: GuideImageFailureCode; failureMessage: string }
    | { kind: "skipped"; reason: string };
}

export interface GuideImageTask {
  /** 1-based 原图顺序；重试剩余图片按此顺序补跑 */
  index: number;
  /**
   * 识别 + 逐图写盘；实现方保证永不 reject（异常须转为 failed 结果）。
   * 写盘前必须检查 context.isActive()：失效即返回 skipped 且不落任何写入。
   */
  run: (context: GuideImageRunContext) => Promise<GuideImageTaskResult>;
}

export interface GuideImageQueueOutcome {
  /** 预算内拿到确定结果的图（ready / failed；按 index 升序） */
  settled: GuideImageTaskResult[];
  /** 预算耗尽仍未完成的图（未启动或单图超时；结算时按 timeout 记失败） */
  timedOutIndexes: number[];
}

/** 队列时钟（离线验证可注入虚拟时钟，无需真的等满预算） */
export interface GuideImageQueueClock {
  /** 当前时间（毫秒；单调递增即可，不要求与 Date.now 对齐） */
  now: () => number;
  /** ms 毫秒后触发回调；返回取消函数 */
  after: (ms: number, callback: () => void) => () => void;
}

const realClock: GuideImageQueueClock = {
  now: () => Date.now(),
  after: (ms, callback) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};

export interface GuideImageQueueOptions {
  concurrency: number;
  budgetMs: number;
  perTaskTimeoutMs?: number;
  /** 注入时钟（离线验证用）；缺省使用真实时钟 */
  clock?: GuideImageQueueClock;
}

/**
 * 图片并发队列：
 * - 最多 concurrency 个任务同时执行；worker 取任务前检查总预算，到期不再启动新图；
 * - perTaskTimeoutMs：单图从启动起的硬上限（超时任务记 timeout，迟到结果凭
 *   context.isActive() 丢弃，不写盘——结算可能已把该图记为超时失败）；
 * - 总预算到期即返回：未拿到确定结果的图列入 timedOutIndexes；仍在跑的识别
 *   不被打断（网络调用无中止能力），但其结果在队列结束时随令牌失效被丢弃；
 * - worker 永不 reject；提前返回后仍在跑的 worker 也已挂上 catch，不产生未处理 rejection；
 * - 到期定时器显式取消，队列提前完成不会让进程空等预算倒计时。
 */
export async function runGuideImageQueue(
  tasks: GuideImageTask[],
  options: GuideImageQueueOptions,
  context: GuideImageRunContext = ALWAYS_ACTIVE,
): Promise<GuideImageQueueOutcome> {
  const settledByIndex = new Map<number, GuideImageTaskResult>();
  if (tasks.length === 0) {
    return { settled: [], timedOutIndexes: [] };
  }

  const clock = options.clock ?? realClock;
  const perTaskTimeoutMs = options.perTaskTimeoutMs;
  const deadline = clock.now() + options.budgetMs;
  let cursor = 0;

  /** 单任务包装：永不 reject；可选单图硬超时（超时记 timeout，迟到结果丢弃） */
  const runOne = async (task: GuideImageTask): Promise<void> => {
    let result: GuideImageTaskResult;
    if (perTaskTimeoutMs !== undefined) {
      let timer: NodeJS.Timeout | undefined;
      try {
        result = await Promise.race([
          task.run(context),
          new Promise<GuideImageTaskResult>((resolve) => {
            timer = setTimeout(
              () =>
                resolve({
                  index: task.index,
                  outcome: {
                    kind: "failed",
                    failureCode: "timeout",
                    failureMessage: `单图处理超过 ${Math.round(perTaskTimeoutMs / 1000)} 秒上限`,
                  },
                }),
              perTaskTimeoutMs,
            );
          }),
        ]);
      } catch (error) {
        result = toFailedResult(task.index, error);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    } else {
      try {
        result = await task.run(context);
      } catch (error) {
        result = toFailedResult(task.index, error);
      }
    }
    settledByIndex.set(task.index, result);
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (cursor >= tasks.length) return;
      if (clock.now() >= deadline) return;
      const task = tasks[cursor++];
      try {
        await runOne(task);
      } catch (error) {
        // runOne 自身已兜底；这里再隔离一层，保证 worker 永不 reject
        console.error("[GUIDES] 图片队列 worker 异常（已隔离）:", error);
      }
    }
  };

  const workerCount = Math.max(1, Math.min(options.concurrency, tasks.length));
  // 预算提前返回后 Promise.all 仍在 pending；单个 catch 兼作「无未处理 rejection」保险
  const workersDone = Promise.all(
    Array.from({ length: workerCount }, () => worker()).map((pending) =>
      pending.catch((error: unknown) => {
        console.error("[GUIDES] 图片队列 worker 异常（已隔离）:", error);
      }),
    ),
  );

  let releaseDeadline: (() => void) | undefined;
  const deadlinePromise = new Promise<void>((resolve) => {
    releaseDeadline = resolve;
  });
  const cancelDeadline = clock.after(Math.max(0, deadline - clock.now()), () => releaseDeadline?.());
  try {
    await Promise.race([workersDone, deadlinePromise]);
  } finally {
    cancelDeadline();
  }

  const settled = [...settledByIndex.values()].sort((left, right) => left.index - right.index);
  const timedOutIndexes = tasks
    .filter((task) => !settledByIndex.has(task.index))
    .map((task) => task.index);
  if (timedOutIndexes.length > 0) {
    console.warn(
      `[GUIDES] 图片队列预算耗尽（${Math.round(options.budgetMs / 1000)}s）：${timedOutIndexes.length}/${tasks.length} 张未完成，迟到结果将被丢弃（${timedOutIndexes.join(",")}）`,
    );
  }
  return { settled, timedOutIndexes };
}

/**
 * 来源级运行令牌的手动窗口（Task #175）：预筛阶段与图片队列同属一轮，
 * 需要在整个窗口内接管令牌——用户在预筛期间重试同一来源时，旧一轮的
 * 预筛 / 队列迟到结果不得写盘（防止覆盖新一轮状态或重复写证据）。
 * 开始时接管（同一来源上一轮立刻失效）→ 执行 fn → 无论成败 finally 失效。
 * fn 拿到的 context 即本轮令牌；runGuideImageQueueForSource 基于其实现。
 */
export async function withSourceImageRun<T>(
  tripId: string,
  sourceId: string,
  fn: (context: GuideImageRunContext) => Promise<T>,
): Promise<T> {
  const key = `${tripId}::${sourceId}`;
  const previous = activeImageRuns.get(key);
  if (previous !== undefined) previous.abortReason = "被同一来源的新一轮任务接管";
  const run: GuideImageRun = {
    tripId,
    sourceId,
    abortReason: null,
    isActive: () => run.abortReason === null && activeImageRuns.get(key) === run,
  };
  activeImageRuns.set(key, run);
  try {
    return await fn(run);
  } finally {
    if (run.abortReason === null) run.abortReason = "本轮图片任务已结束";
    if (activeImageRuns.get(key) === run) activeImageRuns.delete(key);
  }
}

/**
 * 带「来源级运行令牌」的队列：一次调用 = 该来源的一轮图片任务。
 * - 开始时接管令牌：同一来源上一轮（若有）立刻失效，其迟到结果不会写盘；
 * - 结束时令牌失效：预算耗尽后仍在跑的识别结果一律丢弃，不会与结算
 *   （未完成图记 timeout）或用户重试产生竞态覆盖。
 */
export async function runGuideImageQueueForSource(
  tripId: string,
  sourceId: string,
  tasks: GuideImageTask[],
  options: GuideImageQueueOptions,
): Promise<GuideImageQueueOutcome> {
  return withSourceImageRun(tripId, sourceId, (context) =>
    runGuideImageQueue(tasks, options, context),
  );
}

/** 任务异常兜底：未知异常转 unknown 失败码，绝不让异常逃逸出队列 */
function toFailedResult(index: number, error: unknown): GuideImageTaskResult {
  const detail =
    error instanceof Error ? `${error.name}：${error.message}` : String(error);
  return {
    index,
    outcome: {
      kind: "failed",
      failureCode: "unknown",
      failureMessage: `图片处理异常：${detail.replace(/\s+/g, " ").slice(0, 160)}`,
    },
  };
}

// ===== 队列参数（Task #94 实测基线；Task #175 解除 12 张上限 + 动态预算；Task #231 env 可配并发） =====

/** 单来源最多纳入处理的图片数（Task #175：12 → 24，覆盖 17 图长笔记） */
export const GUIDE_MAX_IMAGES = 24;

/**
 * 图片队列并发数（Task #121：3 → 4；Task #231：支持 env 配置；Task #322：默认 4 → 6，安全上限 8 不变）。
 * 环境变量 GUIDE_IMAGE_CONCURRENCY 可覆盖默认值（正整数，1~8 范围内生效，
 * 超范围静默回退默认值并在启动日志警告）。提高并发可缩短多图总耗时，
 * 但需配合 MAX_COMMIT_ATTEMPTS 放宽（已为 12）和运行令牌保护（已就位）。
 * 默认 6 的压测依据（Task #318，eval/tools/perf-task318.ts）：九图并发 6
 * 墙钟 63s、9/9 成功、峰值并发 6、无限流/配额错误。
 */
function resolveImageConcurrency(): number {
  const DEFAULT = 6;
  const MAX_SAFE = 8;
  const raw = process.env.GUIDE_IMAGE_CONCURRENCY;
  if (raw === undefined || raw.trim() === "") return DEFAULT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_SAFE) {
    console.warn(
      `[GUIDES] GUIDE_IMAGE_CONCURRENCY="${raw}" 无效（需 1~${MAX_SAFE} 整数），回退默认值 ${DEFAULT}`,
    );
    return DEFAULT;
  }
  return parsed;
}

export const GUIDE_IMAGE_CONCURRENCY: number = resolveImageConcurrency();
/** 来源总预算下限（Task #121 实测基线）：1~4 图场景与旧行为完全一致 */
export const GUIDE_SOURCE_BUDGET_MS = 180_000;
/** 每批图片的批次预算：单图 120s 硬超时 × 实测余量（批大小 = GUIDE_IMAGE_CONCURRENCY） */
export const GUIDE_BATCH_BUDGET_MS = 150_000;
/** 来源总预算上限：24 张 / 最小并发 1 = 24 批 × 150s = 3600s，cap 在 1200s 防无限膨胀 */
export const GUIDE_SOURCE_BUDGET_MAX_MS = 1_200_000;

/**
 * Task #175 动态预算：按实际送模型图片数伸缩——
 * ceil(图数/并发) 批 × 批次预算，下限 GUIDE_SOURCE_BUDGET_MS、
 * 上限 GUIDE_SOURCE_BUDGET_MAX_MS。防止固定总预算在图片增多后
 * 系统性切断后半段（预算只是最坏情况截断，队列提前完成即提前返回）。
 */
export function guideSourceBudgetMs(imageCount: number): number {
  const batches = Math.max(1, Math.ceil(imageCount / GUIDE_IMAGE_CONCURRENCY));
  return Math.min(
    GUIDE_SOURCE_BUDGET_MAX_MS,
    Math.max(GUIDE_SOURCE_BUDGET_MS, batches * GUIDE_BATCH_BUDGET_MS),
  );
}

/** 单图硬超时（上传 + 轮询 + 识别整体上限；沿用 OCR 实测预算） */
export const GUIDE_IMAGE_TIMEOUT_MS = 120_000;
