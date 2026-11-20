/**
 * Task #224：攻略来源「处理中」等待的分级反馈。
 *
 * 与草案 / 意图两条等待路径的关键差别：**来源侧不能用「已等待时长」驱动阶段**。
 * 调研服务端（只读）后确认前端拿不到可靠的起始时刻——
 * - `GuideSource` 没有 `processingStartedAt` 字段；
 * - `importedAt` 是创建时间，重试 / 重新导入 / 手动解析图片都不会更新它，
 *   用它算 elapsed 会让「三天前导入、刚刚点了重试」的来源瞬间落到最严重档；
 * - `updatedAt` 在处理途中每次落盘都会被刷新（图片单张完成、正文证据提交、
 *   链接元信息保存都会 bump），用它算 elapsed 等于每完成一步就把计时器归零。
 *
 * 因此本模块只用**确实可靠的信号**分级，宁可少说也不谎报：
 * 1. `imageProgress.completed / failed / total`——图片队列的真实结算进度（已持久化，
 *    刷新后仍在），是唯一能给「确定百分比」的信号；
 * 2. `evidenceRefs / mentionRefs` 是否已有内容——说明抽取已经产出，阶段可前推；
 * 3. `updatedAt` 距今的**静默时长**——不用于计时展示，只用于判断「这一步是不是慢」，
 *    据此升级措辞（stalled），而不是编一个进度条往前走。
 *
 * 无确定信号时 `ratio` 返回 null，UI 渲染为来回扫光（indeterminate）而非假百分比：
 * 纯文字来源没有图片队列，若硬按时间画进度条，用户会在 90% 处等上一分钟，
 * 反而比「不知道还要多久」更伤信任。
 *
 * 明天若要更细的分级（见任务报告「需服务端配合」）：给 `GuideSource` 增加
 * `processingStartedAt`（四条进入 processing 的路径都已 bump updatedAt，改造点很小），
 * 本模块即可切到与草案同源的 `resolveWaitStage` 时间线，UI 层不用动。
 */
import type { GuideSource } from "@goplay/shared";

/** 来源处理阶段：取料（抓取 / 下载）→ 读图（图片队列）→ 提炼（抽取要点）→ 归拢（已有产出，收尾） */
export type SourceWaitPhase = "fetch" | "images" | "extract" | "assemble";

export interface SourceWaitMeter {
  phase: SourceWaitPhase;
  /** 站点短名（用户语言，2 字）：紧凑列表空间有限时只展示它 */
  name: string;
  /** 一句话说明（已含 stalled 变体，UI 直接渲染，无需再判断） */
  sentence: string;
  /** 0..1 的确定进度；null = 无可靠信号（渲染为扫光，不假装百分比） */
  ratio: number | null;
  /** 已结算图片数（completed + failed；skipped 不计入，与 imageProgressText 同口径） */
  done: number;
  /** 图片总数（纯文字来源为 0） */
  total: number;
  /** 距上次落盘超过阈值：这一步确实慢（措辞升级 + 轨道换暖色，但不谎报进度） */
  stalled: boolean;
  /** 进度轨模式：determinate = 按 ratio 填充；indeterminate = 扫光 */
  mode: "determinate" | "indeterminate";
}

/**
 * 距上次落盘多久算「这一步慢」。
 *
 * Task #305 校准：原值 60s 是按「图片单张」场景设计的——服务端图片并发 4，
 * 单张「下载 → OCR → FlyAI 装配」可达数十秒，60s 足以判一张图确实卡住。但来源
 * 处理的主耗时其实是**正文抽取 + FlyAI 装配**这条长操作：实测（Adam #302 诊断）
 * 两来源分别 243s / 297s 才成功结算，全程未超时；期间百炼单轮 30~60s、装配逐条
 * 串行搜索，落盘静默轻松超过 60s。用 60s 判慢会把这类**正常长操作**在 1 分钟就
 * 误报成「这一步比较慢」，制造「是不是卡死了」的焦虑——这正是体感差的主因之一。
 *
 * 取 180s（3 分钟）：既覆盖正文抽取 + 装配的正常长耗时不误报，又能在真正异常
 * （远超服务端各路径预算仍未落盘）时给出「确实慢」的确认。
 */
export const SOURCE_STALL_AFTER_MS = 180_000;

/** 阶段短名（紧凑列表 / 轨道 title 用） */
const PHASE_NAME: Record<SourceWaitPhase, string> = {
  fetch: "取料",
  images: "读图",
  extract: "提炼",
  assemble: "归拢",
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** 落盘静默判定：时间戳缺失 / 不可解析 / 在未来（时钟偏移）一律视为「不慢」，不误报 */
function isStalled(updatedAt: string | undefined, now: number): boolean {
  if (updatedAt === undefined || updatedAt === "") return false;
  const at = Date.parse(updatedAt);
  if (Number.isNaN(at)) return false;
  return now - at >= SOURCE_STALL_AFTER_MS;
}

/**
 * 解析来源当前所处的处理阶段与进度。
 * @param source 来源快照（调用方已保证 status === "processing" 时才有意义）
 * @param now    当前时间戳（测试可注入；缺省取 Date.now()）
 * @returns 非 processing 来源返回 null（UI 据此不渲染任何等待元素）
 */
export function sourceWaitMeter(
  source: GuideSource,
  now: number = Date.now(),
): SourceWaitMeter | null {
  if (source.status !== "processing") return null;

  const progress = source.imageProgress;
  const total = Math.max(0, progress.total);
  const done = Math.min(total, Math.max(0, progress.completed) + Math.max(0, progress.failed));
  const stalled = isStalled(source.updatedAt, now);
  const hasEvidence = source.evidenceRefs.length > 0;
  const hasMentions = source.mentionRefs.length > 0;
  // Task #215 延迟解析：图片已落盘但 OCR 未启动，等用户点「解析图片」。
  // 此时没有自动推进的队列，不能按 done/total 画进度（会显得卡住），走不确定态。
  const deferred = source.imageOcrDeferred === true;
  const hasImageQueue = total > 0 && !deferred;
  // Task #305：sourceText 非空 = 正文已抓到（commitNoteMeta 已落盘），只是抽取/装配
  // 尚未产出证据。此时若仍按「取料」措辞（正在抓取…）就是误报——正文其实已在手，
  // 真正在跑的是提炼/装配这条长操作。据此把 fetch 收窄为「连正文都还没抓到」。
  const hasSourceText = (source.sourceText ?? "").trim() !== "";

  let phase: SourceWaitPhase;
  if (hasImageQueue) {
    // done===0 && 无证据：图片队列尚未结算。若正文已抓到（sourceText 非空）则已在
    // 提炼阶段，仅当正文也为空才判「取料」（还在下载图片 / 抓正文）
    if (done === 0 && !hasEvidence) phase = hasSourceText ? "extract" : "fetch";
    else if (done < total) phase = "images";
    else phase = hasMentions ? "assemble" : "extract";
  } else if (deferred && total > 0) {
    // 有图但等用户触发：仍在处理中（例如正文已抽取、图片待解析），按提炼口径措辞
    phase = hasMentions ? "assemble" : "extract";
  } else {
    // 纯文字 / 链接尚未取到元信息：有产出即前推阶段
    if (hasMentions) phase = "assemble";
    else if (hasEvidence) phase = "extract";
    // 正文已抓到（sourceText 非空）或本就是粘贴文字：都在提炼，而非取料
    else if (hasSourceText || source.inputKind === "text") phase = "extract";
    else phase = "fetch";
  }

  return {
    phase,
    name: PHASE_NAME[phase],
    sentence: buildSentence(phase, source.inputKind, done, total, stalled),
    ratio: phase === "images" ? clamp01(done / Math.max(1, total)) : null,
    done,
    total,
    stalled,
    mode: phase === "images" ? "determinate" : "indeterminate",
  };
}

/** 阶段文案：用户语言（不用 OCR / extract 等术语）；stalled 时升级措辞而非改进度 */
function buildSentence(
  phase: SourceWaitPhase,
  inputKind: GuideSource["inputKind"],
  done: number,
  total: number,
  stalled: boolean,
): string {
  if (phase === "images") {
    return stalled
      ? `图片还在读取（${done}/${total}），这一步比较慢…`
      : `正在读取图片 ${done}/${total}…`;
  }
  if (phase === "fetch") {
    if (inputKind === "images") return stalled ? "图片较多，还在下载中…" : "正在下载攻略图片…";
    return stalled ? "抓取比较慢，还在等攻略内容…" : "正在抓取攻略正文…";
  }
  if (phase === "assemble") {
    return stalled ? "还在归拢要点，快好了…" : "内容读到了，正在归拢地点和玩法…";
  }
  // extract：图片来源已全部结算 → 明确告知「图片读完了」，避免用户以为卡在图上
  if (total > 0 && done >= total) {
    return stalled ? "还在提炼要点，这一步比较慢…" : "图片读完了，正在提炼地点和玩法…";
  }
  if (inputKind === "images") {
    return stalled ? "还在提炼要点，这一步比较慢…" : "正在提炼图片里的地点和玩法…";
  }
  return stalled ? "还在提炼要点，这一步比较慢…" : "正在提炼文字里的地点和玩法…";
}

/**
 * 紧凑列表的极简读数：站名 + （有确定进度时）张数。
 * 46% 最大宽度容不下一整句话，用短读数保证不溢出、不换行。
 */
export function sourceWaitShortText(meter: SourceWaitMeter): string {
  return meter.ratio !== null ? `${meter.name} ${meter.done}/${meter.total}` : meter.name;
}
