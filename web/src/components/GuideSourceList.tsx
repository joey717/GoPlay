import { memo, useMemo, useRef, useState, type MouseEvent } from "react";
import type {
  GuideImageProgressEntry,
  GuideImageStatus,
  GuideSource,
  Trip,
} from "@goplay/shared";
import { isGuideSourceStaged } from "@goplay/shared";
import { guideSourceRowPriority, isGuideSourceSelectable } from "../lib/guideSelection";
import { hasSourceOriginalContent, type SourceOriginal } from "../lib/sourceOriginal";
import { sourceWaitMeter, sourceWaitShortText, type SourceWaitMeter } from "../lib/sourceWait";
import { waitProgressPercent } from "../lib/waitStages";
import { ConfirmDialog } from "./ConfirmDialog";

/** 少于该篇数用大卡片（可勾选）；达到即切换紧凑单行列表 + 批量选择（Task #236） */
const COMPACT_LIST_THRESHOLD = 4;

interface GuideSourceListProps {
  /** 行程快照：判定来源可选性（active + ready/partial + 有可读证据） */
  trip: Trip;
  /** 当前 active 来源（调用方已过滤 active=false；按导入顺序） */
  sources: GuideSource[];
  /** 已勾选要参与本次生成的来源 id（NoteInput 单一选择状态源，受控） */
  selectedIds: ReadonlySet<string>;
  /** 生成进行中：请求参数已快照，锁住勾选与批量入口 */
  locked: boolean;
  /** 有进行中操作（提交 / 重试 / 解析图片 / 移除）时禁用按钮 */
  busy: boolean;
  /** 解析来源可回看的原文（任务 186）；无可回看内容返回 null（入口降级 / 隐藏） */
  getOriginal: (source: GuideSource) => SourceOriginal | null;
  /** 点击可回看来源的「原文」：打开来源原文查看层（区别于外链 <a>） */
  onOpenOriginal: (source: GuideSource) => void;
  /** 勾选 / 取消勾选单篇（不可选来源不会上抛） */
  onToggleSource: (sourceId: string) => void;
  /** 全选：所有可选来源 */
  onSelectAll: () => void;
  /** 全不选 */
  onSelectNone: () => void;
  /** 只选新的：仅 staged=true 的可选来源 */
  onSelectStaged: () => void;
  onRetry: (sourceId: string) => void;
  /** Task #215：手动触发图片解析（imageOcrDeferred 来源一键启动全部待解析图 OCR） */
  onTriggerOcr: (sourceId: string) => void;
  /** Task #231：单图重试（只重跑指定失败图，不整批重来） */
  onRetryImage: (sourceId: string, imageIndex: number) => void;
  onRemove: (sourceId: string) => void;
}

/** 来源状态的可读标签与样式类（B4 §1：ready/processing/partial/failed） */
function sourceStatusMeta(status: GuideSource["status"]): { label: string; className: string } {
  switch (status) {
    case "processing":
      return { label: "处理中", className: "processing" };
    case "ready":
      return { label: "已就绪", className: "ready" };
    case "partial":
      return { label: "部分完成", className: "partial" };
    default:
      return { label: "失败", className: "failed" };
  }
}

/** 来源展示标题：title > sourceUrl > 按输入形态兜底（EvidenceSheet 来源切换 tab 复用） */
export function sourceTitle(source: GuideSource): string {
  if (source.title !== undefined && source.title !== "") return source.title;
  if (source.sourceUrl !== undefined && source.sourceUrl !== "") return source.sourceUrl;
  if (source.inputKind === "text") return "粘贴的攻略文字";
  if (source.inputKind === "images") return "上传的攻略截图";
  return "攻略链接";
}

/** 来源类型短标签（任务 188 删除确认）：让用户能区分要删的是哪一类来源 */
function sourceKindLabel(source: GuideSource): string {
  if (source.inputKind === "link") return "链接攻略";
  if (source.inputKind === "images") return "上传截图";
  return "粘贴文字";
}

/** 删除确认描述：类型 + 来源标题（超长截断，避免整段链接 / 长文撑爆弹窗，任务 188） */
function removeConfirmDescription(source: GuideSource): string {
  const title = sourceTitle(source);
  const shown = title.length > 24 ? `${title.slice(0, 24)}…` : title;
  return `将移除${sourceKindLabel(source)}「${shown}」。移除后它不再参与后续 AI 排版，已加入行程的点位和攻略证据不受影响。`;
}

/** 图片进度行：完成 / 总数，失败数单列（纯文字来源 total=0 不显示）；
 *  Task #215：延迟解析时展示待解析张数（pending ≠ 失败，如「10 张图片待解析」） */
function imageProgressText(source: GuideSource): string | null {
  const progress = source.imageProgress;
  if (progress.total === 0) return null;
  if (source.imageOcrDeferred === true) {
    const pending = progress.images.filter((entry) => entry.status === "pending").length;
    if (pending > 0) return `${pending} 张图片待解析`;
  }
  const parts = [`图片 ${progress.completed}/${progress.total}`];
  if (progress.failed > 0) parts.push(`${progress.failed} 张失败`);
  return parts.join(" · ");
}

/** 不可选原因（勾选框 title 提示，避免「点了没反应」） */
function notSelectableHint(source: GuideSource): string | null {
  if (source.status === "processing") return "该攻略还在解析，完成后可选择";
  if (source.status === "failed") return "该攻略解析失败，请先重试";
  if (!source.active) return "该攻略已移除";
  return "该攻略暂无可用于排版的要点";
}

/**
 * Task #308：单图失败原因的用户语言解释 + 「重试是否有效」判定。
 *
 * 确定性失败——内容审核拒绝（rejected）、格式不支持（unsupported）——重试必然
 * 再次失败（PD 现场第 6 格「点了重试没反应」实为审核拒绝，重试回到同样结果），
 * 因此禁用重试入口并标注「重试无效」；其余（超时 / 识别失败 / 下载失败 / 未知）
 * 属瞬时故障，保留可重试。detail 优先复用服务端已落盘的 failureMessage（已是
 * 用户语言），short 是网格下方短文案用的凝练说法，均不暴露英文码值。
 */
function imageFailureInfo(entry: GuideImageProgressEntry): {
  short: string;
  detail: string;
  retryFutile: boolean;
} {
  const message =
    entry.failureMessage !== undefined && entry.failureMessage !== ""
      ? entry.failureMessage
      : null;
  switch (entry.failureCode) {
    case "rejected":
      return { short: "内容审核未通过", detail: message ?? "内容审核未通过", retryFutile: true };
    case "unsupported":
      return { short: "图片格式不支持", detail: message ?? "图片格式不支持", retryFutile: true };
    case "timeout":
      return { short: "处理超时", detail: message ?? "处理超时，可重试", retryFutile: false };
    case "extract_failed":
      return { short: "识别失败", detail: message ?? "识别失败，可重试", retryFutile: false };
    case "download_failed":
      return { short: "下载失败", detail: message ?? "下载失败，可重试", retryFutile: false };
    default:
      return { short: "处理失败", detail: message ?? "处理失败，可重试", retryFutile: false };
  }
}

/**
 * Task #308：pending / processing 图格的 title 说明——消除「灰格点了没反应」的困惑。
 * 关键区分：ocrDeferred 来源的 pending 图确需用户点「解析图片」才启动（不能说
 * 「无需手动操作」）；#303 预告态（processing 中、图已下载）与常规就绪流程则是
 * 「等下载 / 正文完成，无需手动操作」。processing 图恒为解析进行中。
 */
function imagePendingHint(source: GuideSource, status: GuideImageStatus): string {
  if (status === "processing") return "图片正在解析中，请稍候，无需手动操作";
  if (source.imageOcrDeferred === true) {
    return "图片待解析，点上方「解析图片」按钮即可开始";
  }
  if (source.status === "processing") {
    return "图片已下载，正文解析完成后即可解析，无需手动操作";
  }
  return "图片尚未就绪，下载完成后会自动处理，无需手动操作";
}

/** Task #231：单图状态方块（逐图进度网格的最小单元）；Task #308 补失败/待处理原因可见 */
function ImageCell({
  entry,
  source,
  disabled,
  onRetry,
}: {
  entry: GuideImageProgressEntry;
  source: GuideSource;
  disabled: boolean;
  onRetry: (sourceId: string, imageIndex: number) => void;
}) {
  const statusLabel: Record<string, string> = {
    pending: "待解析",
    processing: "解析中",
    ready: "已完成",
    failed: "失败",
    skipped: "已跳过",
  };
  const label = `第${entry.index}张：${statusLabel[entry.status] ?? entry.status}`;
  const sourceId = source.sourceId;

  // pending / processing：不可点，用 title 说清「尚未就绪 / 解析中」而非留白（Task #308）
  if (entry.status === "pending" || entry.status === "processing") {
    return (
      <span
        className={`img-progress-cell ${entry.status}`}
        title={imagePendingHint(source, entry.status)}
        aria-label={label}
      >
        {entry.index}
      </span>
    );
  }

  // ready：纯展示
  if (entry.status === "ready") {
    return (
      <span className="img-progress-cell ready" title={label} aria-label={label}>
        {entry.index}
      </span>
    );
  }

  // skipped（Task #175 预筛跳过）：仍可按需重试，title 用服务端跳过原因
  if (entry.status === "skipped") {
    const reason = entry.failureMessage ?? "已跳过预筛，未送模型识别";
    return (
      <button
        type="button"
        className="img-progress-cell skipped"
        title={reason}
        aria-label={`重试${label}`}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          onRetry(sourceId, entry.index);
        }}
      >
        {entry.index}
      </button>
    );
  }

  // failed：区分确定性失败（审核 / 格式）与瞬时失败
  const info = imageFailureInfo(entry);
  if (info.retryFutile) {
    // 确定性失败：重试入口禁用并标注「重试无效：<原因>」，避免用户反复点无反应
    return (
      <button
        type="button"
        className="img-progress-cell failed futile"
        title={`重试无效：${info.detail}`}
        aria-label={`第${entry.index}张：${info.short}，重试无效`}
        disabled
      >
        {entry.index}
      </button>
    );
  }
  return (
    <button
      type="button"
      className="img-progress-cell failed"
      title={info.detail}
      aria-label={`重试${label}`}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onRetry(sourceId, entry.index);
      }}
    >
      {entry.index}
    </button>
  );
}

/** 行模型：把两种布局共用的派生信息算一次，避免分支里重复 */
interface SourceRowModel {
  source: GuideSource;
  title: string;
  statusLabel: string;
  statusClass: string;
  progress: string | null;
  ocrDeferred: boolean;
  /** Task #225：待解析图片张数（ocrDeferred 时 > 0，用于模式提示文案） */
  pendingImageCount: number;
  /**
   * Task #303：图片解析入口预告态——来源仍在 processing（链接抓取 + 正文提炼），
   * 但图片已全部下载落盘（pending 且无任何图在 OCR 队列中）。服务端契约
   * （triggerImageOcr）拒绝 processing 来源，此阶段不能给可点按钮，但必须让
   * 用户看见「之后可以单独解析图片」的入口预告，避免以为功能消失。
   */
  ocrPreview: boolean;
  /** 预告态下的待解析张数 */
  ocrPreviewCount: number;
  retryable: boolean;
  failure: string | null;
  original: SourceOriginal | null;
  externalHref: string | null;
  selectable: boolean;
  disabledHint: string | null;
  staged: boolean;
  checked: boolean;
  /** Task #224：处理中来源的分级读数；非 processing 恒为 null */
  wait: SourceWaitMeter | null;
}

/**
 * 已添加攻略来源列表（Task #98 B4 §1；Task #236 对齐 DEMO 核心交互）：
 *
 * 功能层级：输入区在面板顶部，本列表紧随其后，负责「先保存的素材」与
 * 「本次要用哪几篇生成」——每篇来源直接带勾选框（受控，状态唯一在 NoteInput）。
 *
 * 两种密度：
 * - 少于 4 篇：大卡片（既有视觉），左侧勾选框 + 标题 / 状态 / 原文 / 移除；
 * - 4 篇及以上：紧凑单行列表（标题省略 + 状态 + 重试 / 原文 / 移除 + 勾选框），
 *   顶部批量栏展示「已选 N / M 篇」并提供全选 / 全不选 / 只选新的（仅 staged=true 来源）。
 *
 * Task #242：紧凑列表不再自建滚动容器。原实现给列表设 max-height + overflow-y:auto +
 * overscroll-behavior:contain，与外层 Sheet 形成嵌套滚动——手机上滑到列表底部后手势仍被
 * 内层吃掉，必须先把手指移出列表才可能继续滚整个面板，实测就是「卡在攻略区域里」。
 * 现在列表直接在文档流里铺开，由 Sheet 的唯一滚动容器承载（6~10 篇规模无需虚拟化）。
 *
 * 紧凑列表把待处理来源置顶（处理中 → 待重试 → 新增暂存 → 其他），同级保持
 * 导入顺序（稳定排序），避免长列表里「该处理的」被历史素材淹没。
 *
 * 勾选安全：整行可点（移动端易命中），但事件来源落在 button / a / input / label
 * 时一律不切换勾选——删除、重试、解析图片、原文入口不会误触发勾选；不可选来源
 * （处理中 / 失败 / 无要点）勾选框禁用并给出 title 说明。
 *
 * 解析图片（Task #215）：链接 / 截图来源的图片默认不自动 OCR（已下载待解析），
 * imageOcrDeferred 且有待解析图时 meta 行展示「解析图片」入口（优先于重试）。
 *
 * 「原文」入口优先级（任务 186）：
 * - 文字 / 截图来源有可回看原文 → 按钮打开原文查看层；
 * - 否则有外部链接（sourceUrl）→ 既有外链 <a>（链接来源始终走此分支）；
 * - 两者皆无 → 不渲染入口，不显示无效按钮。
 *
 * 删除二次确认（任务 188）：点 ✕ 先弹 ConfirmDialog，确认后才走既有软移除链路。
 *
 * 处理中分级反馈（Task #224）：来源解析是长耗时操作（抓取 + 图片 OCR + 抽取，
 * 真实 live 可达 1~3 分钟），原来只有一个静态「处理中」胶囊。现在按**前端确实
 * 拿得到的信号**分级：图片队列的已结算比例（唯一可靠的确定进度）、已提交证据 /
 * 提及（说明抽取已产出，阶段前推）、距上次落盘的静默时长（判定「这一步慢」并升级
 * 措辞）。大卡片展示整句阶段说明 + 底边进度轨；紧凑行只展示阶段短名 + 进度轨，
 * 整句挂在状态胶囊 title 上。无确定信号时轨道走来回扫光而非假百分比。
 * 详见 lib/sourceWait.ts 的取舍说明（含「为何不用已等待时长驱动」）。
 */
function GuideSourceList({
  trip,
  sources,
  selectedIds,
  locked,
  busy,
  getOriginal,
  onOpenOriginal,
  onToggleSource,
  onSelectAll,
  onSelectNone,
  onSelectStaged,
  onRetry,
  onTriggerOcr,
  onRetryImage,
  onRemove,
}: GuideSourceListProps) {
  /** 待二次确认移除的来源（任务 188）：null = 无弹窗；仅 UI 门控，不持有请求 */
  const [removeTarget, setRemoveTarget] = useState<GuideSource | null>(null);
  /** 确认执行互斥：setState 异步生效前连点「移除」只上抛一次（重复请求保护） */
  const confirmLockRef = useRef(false);

  /** 点 ✕：先弹二次确认（任务 188），不立即删除；每次打开前复位连点锁 */
  function handleRemoveRequest(source: GuideSource): void {
    confirmLockRef.current = false;
    setRemoveTarget(source);
  }

  /** 确认移除：关闭弹窗并上抛一次；删除进行中由父组件 busy（含 sourceBusy）禁用列表按钮 */
  function handleRemoveConfirm(): void {
    if (removeTarget === null || confirmLockRef.current) return;
    confirmLockRef.current = true;
    const sourceId = removeTarget.sourceId;
    setRemoveTarget(null);
    onRemove(sourceId);
  }

  /**
   * 整行点击切换勾选：只在点击「非交互区域」时生效。
   * 删除 / 重试 / 解析图片 / 原文是 button / a，勾选框是 input / label——
   * 这些元素的点击一律交给自身处理，避免事件冒泡造成误勾选。
   */
  function handleRowClick(event: MouseEvent<HTMLDivElement>, row: SourceRowModel): void {
    if (!row.selectable || locked) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, label")) return;
    onToggleSource(row.source.sourceId);
  }

  /** 行模型（Task #242）：随 sources / trip / 勾选集合缓存，输入框打字不再逐字符重建。
   *  Task #224：wait 读数在同一次 map 里算出——来源轮询（NoteInput 每 3s）会换掉
   *  sources 身份并触发重算，因此「这一步比较慢」的判定无需额外计时器即可推进。 */
  const rows: SourceRowModel[] = useMemo(() => sources.map((source) => {
    const meta = sourceStatusMeta(source.status);
    const pendingImageCount = source.imageOcrDeferred === true
      ? source.imageProgress.images.filter((entry) => entry.status === "pending").length
      : 0;
    const ocrDeferred = pendingImageCount > 0;
    // Task #303：processing 中、图片已落盘待解析（pending）且 OCR 队列未启动
    // （无任何 processing 图）——预告「解析图片」入口，不给可点按钮（服务端
    // triggerImageOcr 拒绝 processing 来源）。手动 OCR / 重试进行中必有
    // processing 图在场，不会误入预告态。
    const ocrPreviewCount =
      source.status === "processing" && source.imageOcrDeferred !== true
        ? source.imageProgress.images.filter((entry) => entry.status === "pending").length
        : 0;
    const ocrPreview =
      ocrPreviewCount > 0 &&
      !source.imageProgress.images.some((entry) => entry.status === "processing");
    const selectable = isGuideSourceSelectable(trip, source);
    return {
      source,
      title: sourceTitle(source),
      statusLabel: meta.label,
      statusClass: meta.className,
      progress: imageProgressText(source),
      ocrDeferred,
      pendingImageCount,
      ocrPreview,
      ocrPreviewCount,
      retryable: (source.status === "partial" || source.status === "failed") && !ocrDeferred,
      failure:
        source.status === "failed" &&
        source.failureMessage !== undefined &&
        source.failureMessage !== ""
          ? source.failureMessage
          : null,
      // 任务 186：链接来源保持外链语义（不做本地回看）
      original: source.inputKind === "link" ? null : getOriginal(source),
      externalHref:
        source.sourceUrl !== undefined && source.sourceUrl !== "" ? source.sourceUrl : null,
      selectable,
      disabledHint: selectable ? null : notSelectableHint(source),
      staged: isGuideSourceStaged(source),
      checked: selectedIds.has(source.sourceId),
      wait: sourceWaitMeter(source),
    };
  }), [sources, trip, selectedIds, getOriginal]);

  // 以下派生值必须在空态早退之前计算：hooks 不能被条件跳过（否则来源清零时
  // 「Rendered fewer hooks than expected」崩溃）
  /** 紧凑密度：达到阈值（>=4 篇）时切换为单行列表 + 批量栏 */
  const compact = sources.length >= COMPACT_LIST_THRESHOLD;
  /** 已选篇数：直接由行模型得出，不再另建 Set */
  const selectedCount = useMemo(() => rows.filter((row) => row.checked).length, [rows]);
  /** 紧凑列表：待处理置顶的稳定排序；大卡片保持导入顺序（排序结果按 rows 缓存） */
  const orderedRows = useMemo(
    () =>
      compact
        ? rows
            .map((row, index) => ({ row, index }))
            .sort((left, right) => {
              const delta =
                guideSourceRowPriority(left.row.source) -
                guideSourceRowPriority(right.row.source);
              return delta !== 0 ? delta : left.index - right.index;
            })
            .map((entry) => entry.row)
        : rows,
    [compact, rows],
  );

  /** 勾选框（两种密度共用；label 提供整块命中区，disabled 时不可点） */
  function renderCheckbox(row: SourceRowModel) {
    const hint = row.disabledHint !== null ? `（${row.disabledHint}）` : "";
    return (
      <label className="guide-source-pick" title={row.disabledHint ?? undefined}>
        <input
          type="checkbox"
          checked={row.checked}
          disabled={!row.selectable || locked}
          aria-label={`选择攻略 ${row.title}${hint}`}
          onChange={() => onToggleSource(row.source.sourceId)}
        />
      </label>
    );
  }

  /**
   * Task #224：处理中来源的底边进度轨（两种密度共用）。
   * 只在有真实信号时填充比例（图片队列已结算数 / 总数），否则渲染来回扫光——
   * 宁可显示「在动但不知道比例」，也不画一条会停在 90% 一分钟的假进度条。
   * aria-hidden：进度已由状态胶囊的 title 与阶段文案承载，轨道纯装饰。
   */
  function renderWaitMeter(row: SourceRowModel) {
    if (row.wait === null) return null;
    return (
      <span
        className="source-wait-meter"
        data-mode={row.wait.mode}
        data-phase={row.wait.phase}
        data-stalled={row.wait.stalled ? "true" : undefined}
        aria-hidden="true"
      >
        <i
          style={
            row.wait.ratio !== null ? { width: waitProgressPercent(row.wait.ratio) } : undefined
          }
        />
      </span>
    );
  }

  /**
   * Task #231：逐图进度网格——来源有图片且处于 processing / partial / failed 时展示。
   * 每图一个小方块：颜色编码状态（pending 灰、processing 脉冲、ready 绿、failed 红、
   * skipped 黄）；failed 图方块可点击触发单图重试。紧凑布局，360px 不溢出。
   */
  function renderImageGrid(row: SourceRowModel) {
    const images = row.source.imageProgress.images;
    if (images.length === 0) return null;
    // 只在有活跃处理或失败图时展示（ready 来源不占空间）
    const hasActive = images.some(
      (img) => img.status === "processing" || img.status === "pending" || img.status === "failed",
    );
    if (!hasActive && row.source.status === "ready") return null;

    // Task #308：网格下方追加失败/跳过图的短原因文案（用户语言），让「1 张失败」
    // 不再只有一个数字——确定性失败标注「重试无效」，瞬时失败标注「可重试」。
    const notes = images
      .filter((img) => img.status === "failed" || img.status === "skipped")
      .map((img) => {
        if (img.status === "skipped") {
          return {
            index: img.index,
            futile: false,
            text: `第 ${img.index} 张：${img.failureMessage ?? "已跳过预筛"}`,
          };
        }
        const info = imageFailureInfo(img);
        return {
          index: img.index,
          futile: info.retryFutile,
          text: `第 ${img.index} 张：${info.short}${info.retryFutile ? "，重试无效" : "，可重试"}`,
        };
      });

    return (
      <>
        <div className="img-progress-grid" aria-label="图片解析进度">
          {images.map((img) => (
            <ImageCell
              key={img.index}
              entry={img}
              source={row.source}
              disabled={busy}
              onRetry={onRetryImage}
            />
          ))}
        </div>
        {notes.length > 0 ? (
          <div className="img-failure-notes">
            {notes.map((note) => (
              <div
                key={note.index}
                className={`img-failure-note${note.futile ? " futile" : ""}`}
              >
                {note.text}
              </div>
            ))}
          </div>
        ) : null}
      </>
    );
  }

  /**
   * Task #225 / #303：图片解析模式提示块（仅卡片视图）。
   *
   * 两种形态：
   * - ocrDeferred（正文已结算、图片待解析）：说明两种模式 + 可点「解析图片」按钮；
   * - ocrPreview（Task #303，processing 中、图片已下载但正文未完成）：入口预告，
   *   按钮禁用（服务端 triggerImageOcr 拒绝 processing 来源），让用户知道
   *   「正文解析完成后即可单独解析图片」，不再以为功能消失。
   */
  function renderOcrModeHint(row: SourceRowModel) {
    if (row.ocrDeferred) {
      const count = row.pendingImageCount;
      return (
        <div className="ocr-mode-hint" role="note" aria-label="图片解析选项说明">
          <div className="ocr-mode-hint-text">
            <span className="ocr-mode-current">当前：仅解析正文（快速）</span>
            <span className="ocr-mode-optional">
              可选：解析 {count} 张图片获取更完整信息（约1-2分钟/张）
            </span>
          </div>
          <button
            type="button"
            className="ocr-mode-hint-btn"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              onTriggerOcr(row.source.sourceId);
            }}
            aria-label={`解析该攻略的 ${count} 张图片`}
          >
            解析图片
          </button>
        </div>
      );
    }
    if (row.ocrPreview) {
      const count = row.ocrPreviewCount;
      return (
        <div className="ocr-mode-hint preview" role="note" aria-label="图片解析选项说明">
          <div className="ocr-mode-hint-text">
            <span className="ocr-mode-current">
              {count} 张图片已下载，正文解析进行中
            </span>
            <span className="ocr-mode-optional">
              正文完成后即可一键解析图片（约1-2分钟/张）
            </span>
          </div>
          <button
            type="button"
            className="ocr-mode-hint-btn"
            disabled
            title="正文解析完成后可点击"
            aria-label={`正文完成后可解析 ${count} 张图片`}
          >
            解析图片
          </button>
        </div>
      );
    }
    return null;
  }

  /** 移除（二次确认）+ 外链 / 原文回看入口 */
  function renderCardActions(row: SourceRowModel) {
    return (
      <div className="guide-source-actions" onClick={(event) => event.stopPropagation()}>
        {row.original !== null && hasSourceOriginalContent(row.original) ? (
          <button
            type="button"
            className="guide-source-link"
            onClick={() => onOpenOriginal(row.source)}
            aria-label="查看攻略原文"
          >
            原文
          </button>
        ) : row.externalHref !== null ? (
          <a
            className="guide-source-link"
            href={row.externalHref}
            target="_blank"
            rel="noreferrer"
            aria-label="打开攻略原文链接"
          >
            原文
          </a>
        ) : null}
        <button
          type="button"
          className="guide-source-remove"
          disabled={busy}
          onClick={() => handleRemoveRequest(row.source)}
          aria-label="移除该攻略"
        >
          ✕
        </button>
      </div>
    );
  }

  if (sources.length === 0) {
    // Task #223（DEMO ② 素材列表对齐）：空列表不再整体隐藏，展示空态引导（不拄
    // aria-label——唯一来源移除后「已添加的攻略来源」容器应从可访问树消失）
    return (
      <div className="guide-source-list">
        <div className="guide-source-head">攻略素材</div>
        <div className="guide-source-empty">
          粘贴攻略链接后回车，AI 会自动解析出地点与推荐
          <br />
          输入景点 / 酒店名也可以直接添加
        </div>
      </div>
    );
  }

  return (
    <>
      <div
        className={`guide-source-list${compact ? " compact" : ""}`}
        aria-label="已添加的攻略来源"
      >
        {/* Task #223（DEMO ②）：标题「攻略素材」居左，「已添加 N 篇」计数居右 */}
        <div className="guide-source-head">
          <span>攻略素材</span>
          <span className="guide-source-count">已添加 {sources.length} 篇</span>
        </div>

        {/* 批量栏（Task #236，仅长列表）：已选 N / M 篇 + 全选 / 全不选 / 只选新的 */}
        {compact ? (
          <div className="guide-source-batch">
            <span className="guide-source-selcount">
              已选 <b>{selectedCount}</b> / {sources.length} 篇
            </span>
            <div className="guide-source-batch-actions">
              <button type="button" onClick={onSelectAll} disabled={locked}>
                全选
              </button>
              <button type="button" onClick={onSelectNone} disabled={locked}>
                全不选
              </button>
              <button
                type="button"
                className="dim"
                onClick={onSelectStaged}
                disabled={locked}
                title="只勾选新添加、尚未参与生成的暂存攻略"
              >
                只选新的
              </button>
            </div>
          </div>
        ) : null}

        {/* Task #242：紧凑密度也只是普通文档流容器（不再设 max-height / overflow），
            长列表由 Sheet 的唯一滚动容器承载，避免嵌套滚动陷阱 */}
        <div className={compact ? "guide-compact-rows" : "guide-source-rows"}>
          {orderedRows.map((row) => {
            const source = row.source;
            if (!compact) {
              return (
                <div
                  className={`guide-source-item${row.selectable ? " selectable" : ""}`}
                  key={source.sourceId}
                  onClick={(event) => handleRowClick(event, row)}
                >
                  {renderCheckbox(row)}
                  <div className="guide-source-main">
                    <div className="guide-source-title">{row.title}</div>
                    <div className="guide-source-meta">
                      <span className={`guide-source-status ${row.statusClass}`}>
                        {row.statusLabel}
                      </span>
                      {row.staged ? <span className="guide-source-tag">新</span> : null}
                      {row.ocrDeferred ? (
                        <button
                          type="button"
                          className="guide-source-retry"
                          disabled={busy}
                          onClick={() => onTriggerOcr(source.sourceId)}
                          aria-label="解析该攻略的图片"
                        >
                          解析图片
                        </button>
                      ) : null}
                      {row.retryable ? (
                        <button
                          type="button"
                          className="guide-source-retry"
                          disabled={busy}
                          onClick={() => onRetry(source.sourceId)}
                          aria-label="重试处理该攻略"
                        >
                          重试
                        </button>
                      ) : null}
                      {/* Task #224：处理中先说清「此刻在做哪一步」，再给既有张数读数 */}
                      {row.wait !== null ? (
                        <span
                          className="guide-source-stage"
                          data-phase={row.wait.phase}
                          data-stalled={row.wait.stalled ? "true" : undefined}
                        >
                          {row.wait.sentence}
                        </span>
                      ) : null}
                      {source.status === "processing" && row.progress !== null ? (
                        <span className="guide-source-progress">{row.progress}</span>
                      ) : null}
                      {source.status !== "processing" &&
                      source.coverageText !== undefined &&
                      source.coverageText !== "" ? (
                        <span className="guide-source-progress">{source.coverageText}</span>
                      ) : null}
                      {source.status === "partial" && row.progress !== null ? (
                        <span className="guide-source-progress">{row.progress}</span>
                      ) : null}
                    </div>
                    {row.failure !== null ? (
                      <div className="guide-source-failure">{row.failure}</div>
                    ) : null}
                    {renderImageGrid(row)}
                    {renderOcrModeHint(row)}
                  </div>
                  {renderCardActions(row)}
                  {renderWaitMeter(row)}
                </div>
              );
            }
            // 紧凑单行：勾选 + 标题省略 + 状态（含重试 / 解析图片）+ 原文 + 移除
            return (
              <div
                className={`guide-compact-item${row.checked ? " on" : ""}${row.selectable ? " selectable" : ""}`}
                key={source.sourceId}
                onClick={(event) => handleRowClick(event, row)}
              >
                {renderCheckbox(row)}
                <div className="guide-compact-title" title={row.title}>
                  {row.title}
                </div>
                <div
                  className="guide-compact-status"
                  onClick={(event) => event.stopPropagation()}
                >
                  <span
                    className={`guide-source-status ${row.statusClass}`}
                    // Task #224：紧凑行放不下整句阶段说明，用 title 承载（处理中无 failure）
                    title={row.failure ?? row.wait?.sentence}
                  >
                    {row.statusLabel}
                  </span>
                  {row.staged ? <span className="guide-source-tag">新</span> : null}
                  {row.ocrDeferred ? (
                    <button
                      type="button"
                      className="guide-source-retry"
                      disabled={busy}
                      onClick={() => onTriggerOcr(source.sourceId)}
                      aria-label="解析该攻略的图片"
                      title={`当前仅解析正文；点击解析 ${row.pendingImageCount} 张图片获取更完整信息（约1-2分钟/张）`}
                    >
                      解析图片
                    </button>
                  ) : null}
                  {/* Task #303：processing 中图片已落盘——预告入口（禁用），说明正文完成后可单独解析 */}
                  {row.ocrPreview ? (
                    <button
                      type="button"
                      className="guide-source-retry"
                      disabled
                      aria-label={`正文完成后可解析 ${row.ocrPreviewCount} 张图片`}
                      title={`${row.ocrPreviewCount} 张图片已下载；正文解析完成后即可一键解析图片（约1-2分钟/张）`}
                    >
                      解析图片
                    </button>
                  ) : null}
                  {row.retryable ? (
                    <button
                      type="button"
                      className="guide-source-retry"
                      disabled={busy}
                      onClick={() => onRetry(source.sourceId)}
                      aria-label="重试处理该攻略"
                    >
                      重试
                    </button>
                  ) : null}
                  {/* Task #224：既有张数读数优先（含失败数），纯文字来源补阶段短名 */}
                  {source.status === "processing" &&
                  (row.progress !== null || row.wait !== null) ? (
                    <span className="guide-compact-progress">
                      {row.progress ?? (row.wait !== null ? sourceWaitShortText(row.wait) : "")}
                    </span>
                  ) : null}
                </div>
                <div
                  className="guide-compact-actions"
                  onClick={(event) => event.stopPropagation()}
                >
                  {row.original !== null && hasSourceOriginalContent(row.original) ? (
                    <button
                      type="button"
                      className="guide-source-inline-link"
                      onClick={() => onOpenOriginal(source)}
                      aria-label="查看攻略原文"
                    >
                      原文
                    </button>
                  ) : row.externalHref !== null ? (
                    <a
                      className="guide-source-inline-link"
                      href={row.externalHref}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="打开攻略原文链接"
                    >
                      原文
                    </a>
                  ) : null}
                  <button
                    type="button"
                    className="guide-source-remove"
                    disabled={busy}
                    onClick={() => handleRemoveRequest(source)}
                    aria-label="移除该攻略"
                  >
                    ✕
                  </button>
                </div>
                {renderImageGrid(row)}
                {renderWaitMeter(row)}
              </div>
            );
          })}
        </div>
      </div>

      {/* 任务 188：删除二次确认；确认后才上抛 onRemove 走既有软移除链路（错误提示 /
          刷新语义不变），取消与遮罩关闭只关弹窗。ConfirmDialog z-index 70/71，
          盖过统一添加面板与原文查看层 */}
      {removeTarget !== null ? (
        <ConfirmDialog
          title="移除攻略来源"
          description={removeConfirmDescription(removeTarget)}
          confirmText="移除"
          danger
          onConfirm={handleRemoveConfirm}
          onCancel={() => setRemoveTarget(null)}
        />
      ) : null}
    </>
  );
}

/** Task #242：回调用 useCallback 稳定后，memo 让「主输入框打字 / 补充要求打字」不再
 *  连带重渲染整张来源列表（行模型与排序都在组件内部缓存） */
export default memo(GuideSourceList);
