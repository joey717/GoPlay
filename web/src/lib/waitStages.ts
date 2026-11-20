/**
 * Task #224：长等待「分级反馈」的纯逻辑层（无组件、无副作用、不触网）。
 *
 * 为什么在前端推断阶段：服务端一次性返回结果（planner / F11 都没有进度事件通道），
 * 今晚硬约束又禁止改 server/，因此阶段只能由「已等待时长」推断——本质是把既有
 * 思考链文案（lib/draftThinking.ts）与 Task #42 的 15s/45s 分级提示统一成一套
 * 可复用模型：站点（stage）+ 已等待计时（elapsed）+ 预计剩余（remain）+ 分级（tier）。
 *
 * 三条诚实性约束（避免"假进度条"反噬信任）：
 * 1. 阶段名一律是用户语言（读料 / 选点 / 排线 / 成稿），不出现技术术语；
 * 2. 软进度渐近且封顶 PROGRESS_CAP（0.94）——完成前永不显示 100%，最后一个站点
 *    只脉冲不被填满，视觉上就是"到了最后一站但还没到站"；
 * 3. 预计剩余一律带"左右/预计"口径，超过预估后不再倒计时，改为分级兜底文案
 *    （steady 缓冲段说"比预计稍久"，slow / critical 各有措辞）。
 *
 * 服务端若日后提供真实进度事件，只需让调用方用事件覆盖 snapshot.index，
 * 本模块与展示组件都不用改（阶段名与文案仍是同一套）。
 */

/** 等待分级：正常推进 / 偏慢 / 接近兜底超时（三级，驱动配色与剩余文案口径） */
export type WaitTier = "steady" | "slow" | "critical";

/** 一个等待阶段（路线上的一个站点） */
export interface WaitStage {
  /** 进入本阶段的已等待毫秒阈值（首个阶段恒为 0） */
  atMs: number;
  /** 站点短名（2~3 字，展示在路线节点下方） */
  name: string;
  /** 本阶段的一句话说明（调用方可用既有文案覆盖，如草案的思考链） */
  sentence: string;
}

/** 一类长等待的完整分级方案 */
export interface WaitStagePlan {
  /** 阶段列表（必须按 atMs 升序，首个 atMs = 0，至少 1 个） */
  stages: readonly WaitStage[];
  /** 预计总耗时（毫秒）：软进度与「预计还要多久」的基准，取实测常态而非上限 */
  estimateMs: number;
  /** 进入 slow 分级的阈值；缺省 = estimateMs */
  slowAfterMs?: number;
  /** 进入 critical 分级的阈值；缺省 = estimateMs * 2 */
  criticalAfterMs?: number;
  /** 兜底超时（毫秒）：只用于对齐文案口径，真正的 abort 由调用方负责 */
  timeoutMs?: number;
}

/** 某一时刻的等待快照（展示组件只消费它，自身不计时） */
export interface WaitStageSnapshot {
  /** 当前阶段下标（0 基） */
  index: number;
  /** 当前阶段 */
  stage: WaitStage;
  /** 全部阶段（渲染站点用） */
  stages: readonly WaitStage[];
  /** 已等待毫秒（负值归零） */
  elapsedMs: number;
  /** 已等待的可读文案（"12 秒" / "1 分 05 秒"） */
  elapsedText: string;
  /** 路线软进度 0..PROGRESS_CAP：站点 k 落在 k/(N-1) 处，渐近不越界 */
  progress: number;
  /** 分级 */
  tier: WaitTier;
  /** 预计剩余文案（tier 决定口径） */
  remainText: string;
  /** 已完成站点数（= index） */
  doneCount: number;
  /** 站点总数 */
  total: number;
}

/** 软进度封顶：完成前永远留一截，避免"条满了却还没好"的欺骗感 */
export const PROGRESS_CAP = 0.94;

/** 计时刷新粒度：1 秒足够（半秒粒度的思考链 tick 复用它也不迟滞） */
export const WAIT_STAGE_TICK_MS = 500;

/** 预计剩余的最小口径：不足 10 秒也说"10 秒左右"，避免"还要 1 秒"反复打脸 */
const REMAIN_MIN_SECONDS = 10;
/** 预计剩余的取整粒度（秒）：按 10 秒一档向上取整，读数稳定不跳字 */
const REMAIN_BUCKET_SECONDS = 10;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

/** smoothstep：两端慢中间快，让软进度在站点边界平滑衔接、不出现跳变 */
function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * 已等待时长的可读文案：< 1 分钟报秒，≥ 1 分钟报「M 分 SS 秒」。
 * 用「已等 1 分 05 秒」而不是「65 秒」——长等待下分秒制更容易被读成"进展"。
 */
export function formatWaitClock(elapsedMs: number): string {
  const safe = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  const totalSeconds = Math.floor(safe / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes} 分 ${pad2(totalSeconds % 60)} 秒`;
}

/** 预计剩余的可读文案：10 秒一档向上取整；≥ 60 秒改报分钟 */
export function formatWaitRemainder(remainMs: number): string {
  const safe = Number.isFinite(remainMs) && remainMs > 0 ? remainMs : 0;
  const bucketed = Math.max(
    REMAIN_MIN_SECONDS,
    Math.ceil(safe / 1000 / REMAIN_BUCKET_SECONDS) * REMAIN_BUCKET_SECONDS,
  );
  if (bucketed < 60) return `${bucketed} 秒左右`;
  return `${Math.ceil(bucketed / 60)} 分钟左右`;
}

/** 由已等待时长判分级：steady → slow → critical 单向递进 */
export function resolveWaitTier(plan: WaitStagePlan, elapsedMs: number): WaitTier {
  const slowAfter = plan.slowAfterMs ?? plan.estimateMs;
  const criticalAfter = plan.criticalAfterMs ?? plan.estimateMs * 2;
  if (elapsedMs >= criticalAfter) return "critical";
  if (elapsedMs >= slowAfter) return "slow";
  return "steady";
}

/** 由已等待时长定位当前阶段下标（阶段阈值单调，倒序取第一个命中的即可） */
export function resolveWaitStageIndex(plan: WaitStagePlan, elapsedMs: number): number {
  const { stages } = plan;
  let index = 0;
  for (let i = 0; i < stages.length; i += 1) {
    if (elapsedMs >= stages[i].atMs) index = i;
  }
  return index;
}

/** 分级剩余文案：steady 才倒计时，超过预估后不再给数字（避免"还要 5 秒"说了半分钟） */
export function resolveWaitRemainText(plan: WaitStagePlan, tier: WaitTier, elapsedMs: number): string {
  if (tier === "critical") return "等得有点久了，可以先取消再试一次";
  if (tier === "slow") return "比预计久一些，还在处理";
  const remainMs = plan.estimateMs - elapsedMs;
  // 已过预估但还没到 slow 档（estimate 与 slowAfter 之间留了缓冲）：不谎称"就快好了"
  // 干等 20 秒，也不提前报警——如实承认已经超出预计，同时说明还在收尾。
  if (remainMs <= 0) return "比预计稍久，就快好了";
  if (remainMs <= 5_000) return "就快好了";
  return `预计还要 ${formatWaitRemainder(remainMs)}`;
}

/**
 * 解析等待快照（纯函数）。
 *
 * 软进度：站点 i 落在路线的 i/(N-1) 处；站点内按 smoothstep 渐近推进，
 * 到达下一站点阈值时刚好接上下一个站点的起点，因此整条路线连续不跳变；
 * 最后一站进入后进度封顶 PROGRESS_CAP，站点本身只脉冲不被填满。
 */
export function resolveWaitStage(plan: WaitStagePlan, elapsedMs: number): WaitStageSnapshot {
  const stages = plan.stages;
  const total = stages.length;
  const safeElapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  const index = resolveWaitStageIndex(plan, safeElapsed);
  const stage = stages[index];

  // 站点内比例：终点取下一站点阈值；最后一个站点用 estimateMs 兜底（可超程，渐近饱和）
  const stageStart = stage.atMs;
  const stageEnd = index + 1 < total ? stages[index + 1].atMs : Math.max(plan.estimateMs, stageStart + 1);
  const span = Math.max(1, stageEnd - stageStart);
  const within = smoothstep(clamp01((safeElapsed - stageStart) / span) * 0.999);

  const segments = Math.max(1, total - 1);
  const progress = Math.min(PROGRESS_CAP, clamp01((index + within) / segments));

  const tier = resolveWaitTier(plan, safeElapsed);

  return {
    index,
    stage,
    stages,
    elapsedMs: safeElapsed,
    elapsedText: formatWaitClock(safeElapsed),
    progress,
    tier,
    remainText: resolveWaitRemainText(plan, tier, safeElapsed),
    doneCount: index,
    total,
  };
}

/** 软进度百分比字符串（内联 style 用，保留一位小数避免抖动） */
export function waitProgressPercent(progress: number): string {
  return `${(clamp01(progress) * 100).toFixed(1)}%`;
}
