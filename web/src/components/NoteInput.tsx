import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { makeVisitId } from "@goplay/shared";
import { findXhsLink, isFreeAdmissionPoi } from "@goplay/shared";
import type { EntityRef, GuideSource, HotelCandidate, Operation, Trip } from "@goplay/shared";
import {
  ApiError,
  flyAiErrorMessage,
  getGuideSource,
  listGuideSources,
  removeGuideSource,
  retryGuideImage,
  retryGuideSource,
  searchHotels,
  searchPoi,
  submitGuideSourceImages,
  submitGuideSourceLink,
  submitGuideSourceText,
  triggerGuideSourceOcr,
  type GuideDraftApplyResult,
  type GuideDraftResult,
  type GuideSourceSubmitResult,
  type PoiSearchResult,
} from "../api/client";
import GuideDraftPanel, {
  GuideDraftActionsBar,
  type GuideDraftGenerationView,
  type GuideDraftGenerateInput,
} from "./GuideDraftPanel";
import GuideDraftReview from "./GuideDraftReview";
import GuideSourceList from "./GuideSourceList";
import { PoiLevelTag, PoiRankChip } from "./PoiMeta";
import SourceOriginalSheet from "./SourceOriginalSheet";
import {
  hasSourceOriginalContent,
  resolveSourceOriginal,
  type SourceOriginal,
} from "../lib/sourceOriginal";
import { candidateSuggestions, type CandidateSuggestion } from "../lib/trip";
import {
  defaultGuideSelection,
  reconcileGuideSelection,
  selectableGuideSourceIds,
  stagedGuideSourceIds,
} from "../lib/guideSelection";
import { poiAttractionLabel } from "../lib/largeAttraction";

/** 候选行第二行含地址时单行省略（复用 .candidate-meta，不动 styles.css） */
const CANDIDATE_META_ELLIPSIS = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

/**
 * 统一面板打开来源（交互优化 Module F）：
 * - global：顶栏「＋ 添加攻略 / 地点」入口，面板保持既有布局；
 * - day：日卡「+」/ 空 Day 卡「添加到 DayN」入口，标题改「添加到 DayN」，候选池区块
 *   置于输入框与当前输入对应操作之后（任务 185：先见输入，再见推荐）；
 *   任务 198：该场景收敛为纯「往当天加点位」面板（隐藏来源列表与排版区）。
 */
export type OpenContext = { type: "global" } | { type: "day"; dayIndex: number };

/** 快速搜索路径的确认载荷：勾选的飞猪 POI、飞猪酒店与/或自定义点位 */
export interface QuickAddSelection {
  /** 飞猪搜索命中且被勾选的 POI（原样透传，由父组件转 Item 落地） */
  pois: PoiSearchResult[];
  /** 勾选的飞猪酒店（原样透传，由父组件走 F6 selectHotel 写入当天住宿，不入点位候选池） */
  hotels: HotelCandidate[];
  /** 添加为自定义点位的名称（搜索结果底部表单 / 0 结果与失败兑底）；null = 无自定义添加 */
  customName: string | null;
  /** 自定义点位地址（选填，表单手填）；仅 customName 非 null 时有意义，未填为 null */
  customAddress: string | null;
}

interface NoteInputProps {
  tripId: string;
  /** 当前行程（来源可用性判定 / 草案实体名解析） */
  trip: Trip;
  /** 快速搜索：目的地城市（Trip.destination.city），作为 FlyAI 搜索的城市过滤 */
  cityName: string;
  /** 快速搜索：目标天（TripView 当前选中天），点位将排入该天末尾、酒店选为该天住宿 */
  dayIndex: number;
  /** 快速搜索酒店通道：目标天入住日（当天日期 "YYYY-MM-DD"） */
  checkIn: string;
  /** 快速搜索酒店通道：退房日（次日日期） */
  checkOut: string;
  /** 打开来源（Module F）：global＝顶栏入口；day＝空 Day 卡「添加到 DayN」（候选池在输入操作之后）。
   *  Task #176：同时作为草案生成的入口上下文上报（服务端自动判定 scope） */
  openContext: OpenContext;
  /** 来源到达终态 / 来源增删后通知父组件刷新权威 trip（后台装配入池、badge 数量） */
  onExtracted: () => void;
  /** 候选池「添加」：把候选条目排进目标天末尾（TripView → useTrip.addRefToDay，plan+move） */
  onAddCandidate: (dayIndex: number, ref: EntityRef) => void;
  /** 候选池「撤销添加」：把刚排入的 visit 移回候选池（useTrip.removeVisitWithUndo，5 秒二次撤销窗口） */
  onUndoAddCandidate: (dayIndex: number, visitId: string) => void;
  /** 快速搜索确认：由父组件经 useTrip 落地（确保主数据 + 排入目标天，不做去重拦截） */
  onQuickAdd: (selection: QuickAddSelection) => void;
  /** 草案应用完成（含部分应用 / 全部被拒绝）：上抛完整结果，由父组件决定成功提示或拒绝警告 + 刷新行程 */
  onDraftApplied: (result: GuideDraftApplyResult) => void;
  /** 草案应用后仍有敏感操作：转交 TripView 全局 ProposalCard 逐条确认 */
  onProposalNeeded: (operations: Operation[]) => void;
  /** 任务 189：已消费来源 id（TripView 行程级，selected 生成成功后并入）——
   *  已参与过已完成生成的暂存来源退出本轮默认聚焦；可缺省（无消费记录） */
  consumedSourceIds?: readonly string[];
  /** 行程级草案生成会话视图（任务 135：状态在 TripView，关闭本面板不中断生成） */
  generation: GuideDraftGenerationView;
  /** 发起草案生成（行程级会话；面板关闭后请求继续等待） */
  onGenerateDraft: (input: GuideDraftGenerateInput) => void;
  /** 取消生成等待（仅结束前端等待，不展示为错误） */
  onCancelGenerateDraft: () => void;
  /** 活动草案（生成成功 / 重载召回的新鲜草案）：非空时展示 GuideDraftReview 并隐藏 Sheet */
  draft: GuideDraftResult | null;
  /** 取消草案（关闭预览不应用；由父组件记录已读避免召回重复弹出） */
  onDraftDismiss: () => void;
  onClose: () => void;
}

/** 快速搜索子状态机：待命 → 搜索中 → 结果（含 0 结果空态）/ 错误 */
type QuickSearchPhase = "idle" | "searching" | "results" | "error";

/** 快速搜索合并结果条目：景点（search-poi）与酒店（search-hotels）统一为可勾选结构；
 *  两者 id 命名空间独立（shId ≠ poi id），key 前缀避免勾选集合碰撞 */
type QuickSearchEntry =
  | { kind: "poi"; key: string; poi: PoiSearchResult }
  | { kind: "hotel"; key: string; hotel: HotelCandidate };

/** 单次截图来源最多张数（与服务端 IMAGE_COUNT_EXCEEDED 上限一致） */
const MAX_IMAGES_PER_SOURCE = 12;

/** 本地预校验上限（与服务端硬上限一致） */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/** 上传前 canvas 压缩的最大宽度（原图 ≤ 2000px 宽则不压缩） */
const MAX_IMAGE_WIDTH = 2000;

/**
 * 上传前 canvas 压缩：等比缩放至最大 2000px 宽，输出保持原格式（JPEG / PNG）。
 * 解码、绘制或导出任一步失败时回退原图，不阻塞上传；压缩无收益（结果反而
 * 更大）时同样回退。10MB 上限校验在调用侧执行。
 */
async function compressImage(file: File): Promise<File> {
  const mime = file.type === "image/jpg" ? "image/jpeg" : file.type;
  if (mime !== "image/jpeg" && mime !== "image/png") return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  try {
    if (bitmap.width <= MAX_IMAGE_WIDTH) return file;
    const scale = MAX_IMAGE_WIDTH / bitmap.width;
    const canvas = document.createElement("canvas");
    canvas.width = MAX_IMAGE_WIDTH;
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (context === null) return file;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, mime, mime === "image/jpeg" ? 0.9 : undefined),
    );
    if (blob === null || blob.size >= file.size) return file;
    return new File([blob], file.name, { type: mime });
  } catch {
    return file;
  } finally {
    bitmap.close();
  }
}

/** 短文本快速搜索的字数上限（按 Unicode 码点计）：超过则作为攻略文字保存 */
const QUICK_SEARCH_MAX_CODEPOINTS = 30;

/** 快速搜索不承接的输入：含 http(s) 链接或小红书域名（属攻略素材，走来源提交） */
const QUICK_SEARCH_SKIP_PATTERN = /https?:\/\/|(?:xiaohongshu|xhslink)\.com/i;

/**
 * 短文本（≤30 字且不含链接）判定为快速搜索：提交时并行调 FlyAI searchPoi（景点）与
 * searchHotels（酒店）双通道让用户勾选添加，不经 AI 抽取。
 */
function isQuickSearchText(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return false;
  if (QUICK_SEARCH_SKIP_PATTERN.test(trimmed)) return false;
  return Array.from(trimmed).length <= QUICK_SEARCH_MAX_CODEPOINTS;
}

/** 来源列表初始值：trip 内 active 来源按导入时间排序（listGuideSources 覆盖前避免空闪） */
function activeSourcesFromTrip(trip: Trip): GuideSource[] {
  return Object.values(trip.guideSources ?? {})
    .filter((source) => source.active)
    .sort((left, right) => {
      if (left.importedAt !== right.importedAt) return left.importedAt < right.importedAt ? -1 : 1;
      return left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0;
    });
}

/**
 * 统一添加 Sheet（Task #98 B4）：攻略来源提交 + 来源状态轮询 + 攻略草案生成/应用。
 *
 * 输入区合并为单一 textarea（链接 / 攻略文字 / 景点酒店名同一框；Task #223 对齐 DEMO：
 * 确认按钮常驻固定在输入区下方操作行，空输入灰禁「保存」，右侧 🖼 为上传截图图标钮）：
 * - 粘贴分享文案（含小红书链接）：全文保留 + 深色 toast 提示，提交时自动分流——
 *   纯链接或「链接 + ≤30 字分享口令」走链接来源（服务端抓取完整正文与图片）；
 * - 其余非空正文 → 文字来源（正文里的链接一并作为 sourceUrl 记录）；
 * - 截图：操作行「🖼」图标多选 1..12 张 → 压缩（≤2000px）→ submitGuideSourceImages。
 * 短文本（≤30 字无链接）仍走快速搜索（POI + 酒店并行勾选添加），不经来源。
 *
 * 橙钮互斥：输入区有待保存内容（正文或截图）时只亮「保存攻略」，保存后不关面板
 * （仅清空输入 + 刷新来源列表）；排版 CTA 由 GuideDraftPanel 在输入为空时才亮。
 *
 * 来源列表常驻顶部（B4 §1）：状态徽章、图片进度、重试 / 软移除 / 原文链接；
 * processing 来源每 3 秒轮询单个来源状态，到终态时通知父组件刷新 trip
 * （服务端后台已把抽取点位装配入候选池）。
 *
 * 面板布局顺序（任务 185）：头部 → 来源列表 → 输入区与当前输入对应操作
 * （短文本「搜索点位」/ 链接长文截图「保存攻略」/ 搜索结果勾选）→ 候选池推荐
 * （逐项添加，不再置顶）→ 攻略排版次级区（不覆盖输入的主操作）。
 *
 * 任务 198（day 添加面板收口）：openContext.type === "day"（日卡「+」/ 空 Day 卡）时
 * 面板只服务「往当天加点位」一件事——隐藏攻略来源列表（攻略管理统一走主页面 global
 * 面板，不在此重复），收起攻略排版次级区，布局收敛为 标题「添加到 DayN」
 * → 输入框 + 常驻「提交」→ 推荐候选；提交按输入长度分流不变：短文本（≤30 字无链接）
 * 走飞猪双通道搜索勾选，链接 / 长文 / 截图仍保存为攻略来源（提示条反馈，不在此回看列表）。
 *
 * 草案（B4 §2）：GuideDraftPanel 生成（入口上下文 + 补充句，Task #176 起 scope
 * 由服务端自动判定），返回后由 GuideDraftReview（任务 125：明确要求 + 冲突一次性
 * 勾选）展示并调 /draft/apply；应用返回仍有敏感操作时转交父组件全局 ProposalCard
 * 走 confirmProposal 二次下发。
 */
export default function NoteInput({
  tripId,
  trip,
  cityName,
  dayIndex,
  checkIn,
  checkOut,
  openContext,
  onExtracted,
  onAddCandidate,
  onUndoAddCandidate,
  onQuickAdd,
  onDraftApplied,
  onProposalNeeded,
  consumedSourceIds,
  generation,
  onGenerateDraft,
  onCancelGenerateDraft,
  draft,
  onDraftDismiss,
  onClose,
}: NoteInputProps) {
  // ===== 来源列表与轮询（B4 §1） =====
  const [sources, setSources] = useState<GuideSource[]>(() => activeSourcesFromTrip(trip));
  /** 单个来源的重试 / 移除操作进行中（禁用列表按钮） */
  const [sourceBusy, setSourceBusy] = useState(false);
  /** 任务 186：正在回看的来源原文（null = 关闭；查看层 z-63 盖过面板，关闭即卸载） */
  const [originalView, setOriginalView] = useState<{
    source: GuideSource;
    original: SourceOriginal;
  } | null>(null);
  const onExtractedRef = useRef(onExtracted);
  onExtractedRef.current = onExtracted;

  // 挂载时拉取来源列表（服务端读取前会做重启恢复扫描；失败静默保留 trip 快照）
  useEffect(() => {
    let cancelled = false;
    listGuideSources(tripId)
      .then((res) => {
        if (cancelled) return;
        setSources(activeSourcesSorted(res.sources));
      })
      .catch(() => {
        /* 网络失败不打断：列表保持 trip 初始快照，轮询 / 下次打开会再同步 */
      });
    return () => {
      cancelled = true;
    };
  }, [tripId]);

  // processing 来源 3 秒轮询（B4 §1：状态与图片进度刷新）
  // Task #242：按 sources 缓存——字符串 key 在每次 render 重建会让下方轮询 effect 的
  // 依赖比较不稳定，也让输入框打字时多做一次 O(n) 扫描
  const processingKey = useMemo(
    () =>
      sources
        .filter((source) => source.status === "processing")
        .map((source) => source.sourceId)
        .join(","),
    [sources],
  );
  useEffect(() => {
    if (processingKey === "") return;
    const ids = processingKey.split(",");
    // 失效标记：effect 重建（processing 集合变化）或卸载后，在途响应一律丢弃，
    // 不再 setSources / 不再触发终态通知（旧响应对新列表无意义）。
    let cancelled = false;
    const timer = window.setInterval(() => {
      void (async () => {
        const results = await Promise.allSettled(ids.map((id) => getGuideSource(tripId, id)));
        if (cancelled) return;
        const freshById = new Map<string, GuideSource>();
        ids.forEach((id, index) => {
          const settled = results[index];
          if (settled.status === "fulfilled") freshById.set(id, settled.value);
        });
        // 纯合并：updater 不携带任何副作用，终态检测交给下方 committed-state effect
        setSources((prev) =>
          prev.flatMap((source) => {
            const fresh = freshById.get(source.sourceId);
            if (fresh === undefined) return [source];
            if (!fresh.active) return []; // 被外部移除：从展示列表剔除
            return [fresh];
          }),
        );
      })();
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [processingKey, tripId]);

  /** 来源状态快照：终态检测 effect 用它与 committed sources 比对（见下方 effect 注释） */
  const sourceStatusRef = useRef<Map<string, GuideSource["status"]>>(new Map());

  // ===== 输入区（统一单一 textarea：链接 / 攻略文字 / 景点酒店名 / 截图入口） =====
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** 提交成功提示（含 duplicate 复用说明）；processing 提示在对应来源到终态时立即清除（任务 142），其余下次输入时清除 */
  const [submitNotice, setSubmitNotice] = useState<string | null>(null);
  /** submitNotice 关联的来源（任务 142）：processing 提示只由该来源到终态时清除，不连带其他来源 */
  const noticeSourceIdRef = useRef<string | null>(null);

  // processing → 终态（ready/partial/failed）检测：基于 committed 的 sources 状态在
  // effect 中比对上一轮快照（Task #106：不再依赖 React updater 同步执行——updater
  // 必须是纯函数，setSources 后同步读外部变量在并发渲染下会丢通知）。
  // 到终态时服务端后台装配已落库，通知父组件刷新权威 trip（候选池/证据/badge）。
  useEffect(() => {
    const prev = sourceStatusRef.current;
    const terminalIds: string[] = [];
    for (const source of sources) {
      const before = prev.get(source.sourceId);
      if (before === "processing" && source.status !== "processing") terminalIds.push(source.sourceId);
      prev.set(source.sourceId, source.status);
    }
    if (terminalIds.length > 0) {
      onExtractedRef.current();
      // 任务 142：对应来源到终态（ready/partial/failed）后「已保存，正在识别要点」
      // 使命完成，立即清除，终态由来源卡片展示（失败 / 部分成功的重试入口也在卡片上）
      if (noticeSourceIdRef.current !== null && terminalIds.includes(noticeSourceIdRef.current)) {
        noticeSourceIdRef.current = null;
        setSubmitNotice(null);
      }
    }
  }, [sources]);

  // ===== 选择参与本次生成的攻略（Task #236：唯一选择状态源上提到本组件） =====
  /**
   * 已勾选来源 id（列表勾选框与底部 CTA 共用的唯一状态）：
   * 默认 = 暂存（staged）+ 可选 + 未消费的新增来源，保持任务 189「新攻略默认聚焦」。
   */
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>(() =>
    defaultGuideSelection(trip, sources, consumedSourceIds ?? []),
  );
  /** 可选来源 id（勾选框可用性 / 全选 / 请求参数过滤的统一口径） */
  const selectableIds = useMemo(
    () => selectableGuideSourceIds(trip, sources),
    [trip, sources],
  );
  const selectableIdSet = useMemo(() => new Set(selectableIds), [selectableIds]);
  const selectedIdSet = useMemo(() => new Set(selectedSourceIds), [selectedSourceIds]);
  /** 上一轮可选来源（收敛判据「新变为可选」），null = 首次推导 */
  const seenSelectableRef = useRef<Set<string> | null>(null);
  /** 消费集合按内容作为依赖：父组件每次渲染都可能给新数组，不按引用比较 */
  const consumedSelectionKey = (consumedSourceIds ?? []).join(",");

  // 新增来源 / 软删除 / 状态轮询 / trip 刷新：选择集合安全收敛——
  // 剔除删除 / 处理中 / 失败 / 证据消失的 id，不残留无效 sourceId；
  // 新处理完成的暂存来源自动勾选（用户主动取消过的已在 seen 内，不回弹）
  useEffect(() => {
    const selectable = selectableGuideSourceIds(trip, sources);
    const seen = seenSelectableRef.current;
    seenSelectableRef.current = new Set(selectable);
    setSelectedSourceIds((prev) => {
      const reconciled = reconcileGuideSelection({
        previous: prev,
        trip,
        sources,
        consumedSourceIds,
        seenSelectableIds: seen,
      }).selectedIds;
      // Task #242：内容相同就返回原引用（React 直接 bail out）。父组件每次刷新 trip /
      // 轮询来源都会重建本 effect，旧写法无条件写入新数组会让整棵面板（列表 + 行动区）
      // 白重渲染一次，累积成移动端的输入卡顿。
      const same =
        prev.length === reconciled.length && prev.every((id, index) => id === reconciled[index]);
      return same ? prev : reconciled;
    });
    // consumedSourceIds 通过内容 key 参与依赖，避免父组件新数组引用导致重复收敛
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip, sources, consumedSelectionKey]);

  /** 粘贴分享文案识别到小红书链接：深色 toast，3s 后自动淡出 */
  const [linkToast, setLinkToast] = useState(false);
  const linkToastTimerRef = useRef<number | null>(null);

  // ===== 截图通道（多选 1..12 张，作为图片组来源提交；入口在 textarea 右下角小按钮） =====
  const [shotFiles, setShotFiles] = useState<File[]>([]);
  const [shotError, setShotError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ===== 快速搜索（短文本并行搜飞猪景点 + 酒店，不经 AI 抽取；逻辑保持不变） =====
  const [quickPhase, setQuickPhase] = useState<QuickSearchPhase>("idle");
  const [quickEntries, setQuickEntries] = useState<QuickSearchEntry[]>([]);
  /** 已勾选条目的 key 集合（poi:{id} / hotel:{id}；景点可多选，酒店为当天住宿单选） */
  const [quickSelected, setQuickSelected] = useState<Set<string>>(new Set());
  const [quickQuery, setQuickQuery] = useState("");
  const [quickError, setQuickError] = useState<string | null>(null);
  /** 单侧通道失败时的非阻塞提示（另一侧结果照常展示；双侧失败才进入 error 态） */
  const [quickPartialError, setQuickPartialError] = useState<string | null>(null);

  // ===== 自定义点位表单（Task #221）：搜索结果底部「都不是，添加自定义点位」 =====
  /** 表单展开状态：展开期间隐藏「添加选中的」主行动行（同一时刻只有一个橙色主钮） */
  const [customFormOpen, setCustomFormOpen] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customAddr, setCustomAddr] = useState("");
  const customAddrInputRef = useRef<HTMLInputElement | null>(null);
  /** 创建成功提示（内联展示在结果底部，3 秒自动消失；面板保持打开可继续搜索） */
  const [customAdded, setCustomAdded] = useState<{ name: string; address: string | null } | null>(
    null,
  );
  const customAddedTimerRef = useRef<number | null>(null);

  // ===== 攻略草案（任务 135：展示与生成状态均在行程级，由 props 传入） =====
  /**
   * 补充要求（Task #242）：Task #242 把攻略区拆成「正文区 + 固定行动区」两个组件，
   * 输入框在正文区、主 CTA 在行动区，两边必须读同一份值——状态上提到本组件受控。
   */
  const [draftNote, setDraftNote] = useState("");

  // ===== 候选池区块（Module F：仅 day 上下文渲染；任务 185 起置于输入操作之后） =====
  /** 撤销 toast：刚排入目标天的 visit（3 秒内可撤销移回候选池） */
  const [addedVisit, setAddedVisit] = useState<{
    dayIndex: number;
    visitId: string;
    name: string;
  } | null>(null);
  const addedToastTimerRef = useRef<number | null>(null);

  /** day 上下文目标天（global 为 null：不渲染候选池区块，标题回落「添加攻略/地点」） */
  const dayContextIndex = openContext.type === "day" ? openContext.dayIndex : null;
  /** 候选池推荐条目：攻略提到但还没排进任何 Day 的景点（含移出候选），随 trip 刷新 */
  const candidateRows = useMemo(
    () => (dayContextIndex === null ? [] : candidateSuggestions(trip)),
    [trip, dayContextIndex],
  );

  const busy = submitting || sourceBusy || quickPhase === "searching";
  /** 纯短文本（≤30 字无链接）：快速搜索词而非攻略素材，按钮文案切换为「搜索点位」 */
  const quickPending = isQuickSearchText(text);
  /** 输入区有待保存内容（正文或截图）：全屏唯一橙钮让位给「保存攻略」，排版区退让为引导文案 */
  const textHasContent = text.trim() !== "" || shotFiles.length > 0;
  const canSubmit = textHasContent && !busy;
  /**
   * 固定行动区是否渲染（Task #242）：global 面板 + 非搜索结果态。
   * 输入区有待保存内容时仍然渲染（内容退让为「保存后，可在此一键排行程」引导行）：
   * 行动区高度不随打字伸缩，避免每敲一个字首屏布局就跳一次；全屏同一时刻仍然只有
   * 「保存攻略」一个橙色实心钮。
   */
  const showDraftFoot = dayContextIndex === null && quickPhase === "idle";

  // 截图预览 objectURL：文件集变化时重建，旧 URL 由 effect 清理时释放
  const shotPreviews = useMemo(
    () => shotFiles.map((file) => ({ name: file.name, size: file.size, url: URL.createObjectURL(file) })),
    [shotFiles],
  );
  useEffect(() => {
    return () => {
      for (const preview of shotPreviews) URL.revokeObjectURL(preview.url);
    };
  }, [shotPreviews]);

  // 卸载时清理 toast 定时器，避免卸载后 setState
  useEffect(
    () => () => {
      if (linkToastTimerRef.current !== null) window.clearTimeout(linkToastTimerRef.current);
      if (addedToastTimerRef.current !== null) window.clearTimeout(addedToastTimerRef.current);
      if (customAddedTimerRef.current !== null) window.clearTimeout(customAddedTimerRef.current);
    },
    [],
  );

  /** 粘贴识别到链接的 toast：展示 3s 后淡出（动画总时长 3.4s，结束后卸载） */
  function showLinkToast(): void {
    setLinkToast(true);
    if (linkToastTimerRef.current !== null) window.clearTimeout(linkToastTimerRef.current);
    linkToastTimerRef.current = window.setTimeout(() => {
      setLinkToast(false);
      linkToastTimerRef.current = null;
    }, 3400);
  }

  /** 提交结果并入来源列表：新来源追加、既有来源（重试 / 恢复）原位更新；返回是否写入成功 */
  function mergeSubmittedSource(result: GuideSourceSubmitResult): boolean {
    const source = result.source;
    if (source === null || result.sourceId === null) {
      setSubmitError("服务端返回异常（未返回来源），请重试");
      return false;
    }
    setSources((prev) => {
      const exists = prev.some((item) => item.sourceId === source.sourceId);
      return exists
        ? prev.map((item) => (item.sourceId === source.sourceId ? source : item))
        : [...prev, source];
    });
    // Task #225：来源含待解析图片时，提示用户有两种模式可选
    const hasPendingImages =
      source.imageOcrDeferred === true &&
      source.imageProgress.images.some((img) => img.status === "pending");
    if (result.duplicate) {
      setSubmitNotice("这篇攻略之前添加过，已复用当时的处理结果");
    } else if (hasPendingImages) {
      const pendingCount = source.imageProgress.images.filter(
        (img) => img.status === "pending",
      ).length;
      setSubmitNotice(
        `已保存，正在识别正文要点。该攻略含 ${pendingCount} 张图片，可在来源卡片选择「解析图片」获取更完整信息（约1-2分钟/张）`,
      );
    } else {
      setSubmitNotice("已保存，正在识别要点");
    }
    // 任务 142：processing 提示关联本条来源，轮询检测到它到终态后立即清除；
    // duplicate 复用已终态来源时无 processing 可等，提示保留到下次输入
    noticeSourceIdRef.current = source.status === "processing" ? source.sourceId : null;
    setText("");
    // trip.guideSources 已变化（新增 / 恢复 active / 去重复用），刷新权威 trip
    onExtractedRef.current();
    return true;
  }

  /**
   * 正文提交（B4，统一 textarea）：
   * - 正文是纯小红书链接或「链接 + ≤30 字分享口令」→ 链接来源（服务端抓取完整正文与图片）；
   * - 其余非空正文 → 文字来源（正文里的小红书链接一并作为 sourceUrl 记录）。
   */
  async function handleSubmitText(): Promise<boolean> {
    const trimmed = text.trim();
    if (trimmed === "" || busy) return false;
    setSubmitting(true);
    setSubmitError(null);
    setSubmitNotice(null);
    try {
      const linkMatch = findXhsLink(trimmed);
      // Task #304：剔除用原文命中子串 raw（无 scheme 时 ≠ 归一化 url），提交用归一化 url
      const textWithoutLink =
        linkMatch !== null ? trimmed.replace(linkMatch.raw, "").trim() : trimmed;
      let result: GuideSourceSubmitResult;
      if (linkMatch !== null && (textWithoutLink === "" || Array.from(textWithoutLink).length <= 30)) {
        result = await submitGuideSourceLink(tripId, linkMatch.url);
      } else {
        result = await submitGuideSourceText(tripId, trimmed, {
          sourceUrl: linkMatch?.url,
        });
      }
      return mergeSubmittedSource(result);
    } catch (err) {
      // 服务端稳定错误码 message 均为安全中文文案（LINK_INVALID / INVALID_REQUEST 等）
      setSubmitError(err instanceof ApiError ? err.message : "攻略提交失败，请检查网络后重试");
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  /** 截图多选追加：逐张校验格式与大小，超 12 张截断提示（与服务端 IMAGE_COUNT_EXCEEDED 一致） */
  function pickShotFiles(files: FileList | null): void {
    if (files === null || files.length === 0) return;
    const errors: string[] = [];
    const valid: File[] = [];
    for (const file of Array.from(files)) {
      const mime = file.type === "image/jpg" ? "image/jpeg" : file.type;
      if (mime !== "image/jpeg" && mime !== "image/png") {
        errors.push(`${file.name}：仅支持 JPEG / PNG`);
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        errors.push(`${file.name}：${formatBytes(file.size)} 超过 10MB 上限`);
        continue;
      }
      valid.push(file);
    }
    setShotFiles((prev) => {
      const merged = [...prev, ...valid];
      if (merged.length > MAX_IMAGES_PER_SOURCE) {
        setShotError(`单次最多提交 ${MAX_IMAGES_PER_SOURCE} 张截图，已保留前 ${MAX_IMAGES_PER_SOURCE} 张`);
        return merged.slice(0, MAX_IMAGES_PER_SOURCE);
      }
      return merged;
    });
    if (errors.length > 0) setShotError(errors.join("；"));
    else setShotError(null);
  }

  function removeShotFile(index: number): void {
    setShotFiles((prev) => prev.filter((_, i) => i !== index));
  }

  /**
   * 截图来源提交：逐张压缩 → multipart 提交（2 秒内返回），处理进度走来源轮询；
   * sourceUrl 为输入区正文里识别到的小红书链接（可选，随截图一并保存）。
   */
  async function handleSubmitShots(sourceUrl?: string): Promise<boolean> {
    if (shotFiles.length === 0 || busy) return false;
    setSubmitting(true);
    setShotError(null);
    setSubmitNotice(null);
    try {
      const compressed: File[] = [];
      for (const file of shotFiles) {
        compressed.push(await compressImage(file));
      }
      const oversize = compressed.find((file) => file.size > MAX_IMAGE_BYTES);
      if (oversize !== undefined) {
        setShotError(`${oversize.name} 压缩后仍超过 10MB，请移除后重试`);
        return false;
      }
      const result = await submitGuideSourceImages(tripId, compressed, {
        sourceUrl: sourceUrl !== undefined && sourceUrl !== "" ? sourceUrl : undefined,
      });
      if (!mergeSubmittedSource(result)) return false;
      setShotFiles([]);
      if (fileInputRef.current !== null) fileInputRef.current.value = "";
      return true;
    } catch (err) {
      setShotError(err instanceof ApiError ? err.message : "截图提交失败，请检查网络后重试");
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * 统一保存入口（全屏唯一橙钮，互斥规则见 GuideDraftPanel）：
   * - 纯短文本（≤30 字无链接、未选截图）→ 快速搜索（FlyAI 景点 + 酒店勾选，逻辑不变）；
   * - 有正文 → 文字 / 链接来源（服务端分流）；
   * - 有截图 → 截图来源（正文里识别到的链接一并记录为 sourceUrl）；
   * - 成功后仅清空输入并刷新来源列表，面板保持打开（继续添加或直接排版）。
   */
  async function handleSave(): Promise<void> {
    if (busy) return;
    if (quickPending && shotFiles.length === 0) {
      await handleQuickSearch();
      return;
    }
    const trimmed = text.trim();
    if (trimmed === "" && shotFiles.length === 0) return;
    // 正文里的链接先捕获：提交正文后 text 已清空，截图来源仍可携带（Task #304：归一化 url）
    const textLink = findXhsLink(trimmed);
    if (trimmed !== "") {
      if (!(await handleSubmitText())) return;
    }
    if (shotFiles.length > 0) {
      await handleSubmitShots(textLink?.url);
    }
  }

  /** 来源重试（partial / failed）：状态回 processing，由轮询继续跟踪 */
  const handleRetrySource = useCallback(
    async (sourceId: string): Promise<void> => {
      if (sourceBusy) return;
      setSourceBusy(true);
      setSubmitError(null);
      try {
        const updated = await retryGuideSource(tripId, sourceId);
        setSources((prev) => prev.map((item) => (item.sourceId === sourceId ? updated : item)));
      } catch (err) {
        setSubmitError(err instanceof ApiError ? err.message : "来源重试失败，请稍后再试");
      } finally {
        setSourceBusy(false);
      }
    },
    [sourceBusy, tripId],
  );

  /** 手动触发图片解析（Task #215）：一键启动全部待解析图，状态回 processing 由轮询跟踪 */
  const handleTriggerOcr = useCallback(
    async (sourceId: string): Promise<void> => {
      if (sourceBusy) return;
      setSourceBusy(true);
      setSubmitError(null);
      try {
        const updated = await triggerGuideSourceOcr(tripId, sourceId);
        setSources((prev) => prev.map((item) => (item.sourceId === sourceId ? updated : item)));
      } catch (err) {
        setSubmitError(err instanceof ApiError ? err.message : "图片解析启动失败，请稍后再试");
      } finally {
        setSourceBusy(false);
      }
    },
    [sourceBusy, tripId],
  );

  /** 单图重试（Task #231）：只重跑指定失败图，不整批重来；状态回 processing 由轮询跟踪 */
  const handleRetryImage = useCallback(
    async (sourceId: string, imageIndex: number): Promise<void> => {
      if (sourceBusy) return;
      setSourceBusy(true);
      setSubmitError(null);
      try {
        const updated = await retryGuideImage(tripId, sourceId, imageIndex);
        setSources((prev) => prev.map((item) => (item.sourceId === sourceId ? updated : item)));
      } catch (err) {
        setSubmitError(err instanceof ApiError ? err.message : "单图重试失败，请稍后再试");
      } finally {
        setSourceBusy(false);
      }
    },
    [sourceBusy, tripId],
  );

  /** 来源软移除（active=false，证据与原图保留供回看）：列表剔除并刷新 trip（badge 数量） */
  const handleRemoveSource = useCallback(
    async (sourceId: string): Promise<void> => {
      if (sourceBusy) return;
      setSourceBusy(true);
      setSubmitError(null);
      try {
        await removeGuideSource(tripId, sourceId);
        setSources((prev) => prev.filter((item) => item.sourceId !== sourceId));
        onExtractedRef.current();
      } catch (err) {
        setSubmitError(err instanceof ApiError ? err.message : "来源移除失败，请重试");
      } finally {
        setSourceBusy(false);
      }
    },
    [sourceBusy, tripId],
  );

  // ===== 来源勾选（Task #236：列表受控，勾选状态唯一存在本组件） =====

  /** 勾选 / 取消一篇来源：生成中锁定；不可选来源（处理中 / 失败 / 无要点）不上抛 */
  const handleToggleSource = useCallback(
    (sourceId: string): void => {
      if (generation.active || !selectableIdSet.has(sourceId)) return;
      setSelectedSourceIds((prev) =>
        prev.includes(sourceId) ? prev.filter((id) => id !== sourceId) : [...prev, sourceId],
      );
    },
    [generation.active, selectableIdSet],
  );

  /** 全选：所有可选来源（处理中 / 失败不选） */
  const handleSelectAllSources = useCallback((): void => {
    if (generation.active) return;
    setSelectedSourceIds([...selectableIds]);
  }, [generation.active, selectableIds]);

  /** 全不选：清空勾选（主 CTA 随之为禁用并提示勾选） */
  const handleSelectNoSources = useCallback((): void => {
    if (generation.active) return;
    setSelectedSourceIds([]);
  }, [generation.active]);

  /** 只选新的：仅 staged=true 的可选来源（历史已整合来源不选） */
  const handleSelectStagedSources = useCallback((): void => {
    if (generation.active) return;
    setSelectedSourceIds(stagedGuideSourceIds(trip, sources));
  }, [generation.active, trip, sources]);

  // ===== 来源原文回看（任务 186）：截图原图 / 粘贴文字完整原文 =====

  /**
   * 解析来源可回看原文（trip 快照提供历史证据 assetPath 回退）；
   * 无可回看内容（历史来源无完整原文文本且无图）返回 null，列表入口随之降级隐藏。
   */
  const getOriginal = useCallback(
    (source: GuideSource) => {
      const original = resolveSourceOriginal(trip, source);
      return hasSourceOriginalContent(original) ? original : null;
    },
    [trip],
  );

  /** 打开原文查看层（列表「原文」按钮）；无内容时静默忽略（按钮本不应渲染，防御） */
  const handleOpenOriginal = useCallback(
    (source: GuideSource): void => {
      const original = getOriginal(source);
      if (original === null) return;
      setOriginalView({ source, original });
    },
    [getOriginal],
  );

  // ===== 快速搜索（短文本并行搜飞猪景点 + 酒店；与改造前逻辑一致） =====

  /**
   * 并行双通道搜索：searchPoi（景点）与 searchHotels（酒店，按名称关键词直搜）。
   * allSettled 保证互不拖累；双侧全失败才进 error 态，单侧失败降级为非阻塞提示。
   */
  async function handleQuickSearch(): Promise<void> {
    const query = text.trim();
    if (query === "" || busy) return;
    setQuickQuery(query);
    setQuickEntries([]);
    setQuickSelected(new Set());
    setQuickError(null);
    setQuickPartialError(null);
    // 新一轮搜索重置自定义点位表单与已添加提示（Task #221）
    setCustomFormOpen(false);
    setCustomAdded(null);
    if (customAddedTimerRef.current !== null) {
      window.clearTimeout(customAddedTimerRef.current);
      customAddedTimerRef.current = null;
    }
    setQuickPhase("searching");

    const city = cityName.trim();
    // 酒店通道前提：结构化目的地 + 合法日期区间（服务端 400 契约）；不满足时只搜景点
    const hotelReady =
      city !== "" &&
      /^\d{4}-\d{2}-\d{2}$/.test(checkIn) &&
      /^\d{4}-\d{2}-\d{2}$/.test(checkOut) &&
      checkOut > checkIn;
    const [poiSettled, hotelSettled] = await Promise.allSettled([
      searchPoi(query, city === "" ? undefined : city),
      hotelReady
        ? searchHotels({ destination: city, q: query, checkIn, checkOut })
        : Promise.reject(new Error("酒店搜索需要目的地与行程日期")),
    ]);

    const poiEntries: QuickSearchEntry[] =
      poiSettled.status === "fulfilled"
        ? poiSettled.value.normalized.map(
            (poi): QuickSearchEntry => ({ kind: "poi", key: `poi:${poi.id}`, poi }),
          )
        : [];
    const hotelEntries: QuickSearchEntry[] =
      hotelSettled.status === "fulfilled"
        ? hotelSettled.value.normalized.map(
            (hotel): QuickSearchEntry => ({ kind: "hotel", key: `hotel:${hotel.id}`, hotel }),
          )
        : [];

    const poiMessage =
      poiSettled.status === "rejected"
        ? `景点搜索失败：${flyAiErrorMessage(poiSettled.reason)}`
        : null;
    const hotelMessage =
      hotelSettled.status === "rejected" && hotelReady
        ? `酒店搜索失败：${flyAiErrorMessage(hotelSettled.reason)}`
        : null;

    // 双侧全失败才算失败（酒店未发起时以景点通道定性）；否则单侧失败仅降级提示
    if (poiMessage !== null && (hotelMessage !== null || !hotelReady)) {
      setQuickError(
        [poiMessage, hotelMessage].filter((item): item is string => item !== null).join("；"),
      );
      setQuickPhase("error");
      return;
    }
    const partial = [poiMessage, hotelMessage]
      .filter((item): item is string => item !== null)
      .join("；");
    if (partial !== "") setQuickPartialError(partial);
    // 景点结果在前，酒店结果在后
    setQuickEntries([...poiEntries, ...hotelEntries]);
    setQuickPhase("results");
  }

  /** 勾选切换：景点多选；酒店是当天住宿（F6 单选语义），勾选新酒店时自动取消其他酒店 */
  function toggleQuickEntry(entry: QuickSearchEntry): void {
    setQuickSelected((prev) => {
      const next = new Set(prev);
      if (next.has(entry.key)) {
        next.delete(entry.key);
        return next;
      }
      if (entry.kind === "hotel") {
        for (const key of next) {
          if (key.startsWith("hotel:")) next.delete(key);
        }
      }
      next.add(entry.key);
      return next;
    });
  }

  /**
   * 确认添加勾选项：交给父组件经 useTrip 落地后自动关闭 Sheet。
   * 不调 onExtracted——快速路径是本地乐观更新 + 防抖保存，若立即拉取
   * 服务端行程会拿到旧数据把未保存的添加冲掉。
   */
  function confirmQuickAdd(): void {
    const pois: PoiSearchResult[] = [];
    const hotels: HotelCandidate[] = [];
    for (const entry of quickEntries) {
      if (!quickSelected.has(entry.key)) continue;
      if (entry.kind === "poi") pois.push(entry.poi);
      else hotels.push(entry.hotel);
    }
    if (pois.length === 0 && hotels.length === 0) return;
    onQuickAdd({ pois, hotels, customName: null, customAddress: null });
    onClose();
  }

  /** 0 结果（或搜索失败兑底）：把搜索词添加为自定义点位后关闭 Sheet（无地址输入，保持既有行为） */
  function addCustomFromQuick(): void {
    if (quickQuery.trim() === "") return;
    onQuickAdd({ pois: [], hotels: [], customName: quickQuery.trim(), customAddress: null });
    onClose();
  }

  // ===== 自定义点位表单（Task #221）：搜索结果底部「都不是」兑底 =====

  /** 展开内联表单：名称默认带入当前搜索关键词，地址留空待填 */
  function openCustomForm(): void {
    setCustomFormOpen(true);
    setCustomName(quickQuery);
    setCustomAddr("");
    setCustomAdded(null);
    if (customAddedTimerRef.current !== null) {
      window.clearTimeout(customAddedTimerRef.current);
      customAddedTimerRef.current = null;
    }
  }
  
  function closeCustomForm(): void {
    setCustomFormOpen(false);
  }

  /**
   * 确认创建自定义点位：经 onQuickAdd 落地（父组件构造 origin=custom 的 Item
   * 排入目标天末尾，本地乐观更新 + 防抖保存，与勾选添加同一链路）。
   * 表单收起 + 内联已添加提示（3 秒自动消失），面板保持打开可继续搜索或关闭。
   */
  function submitCustomPoint(): void {
    const name = customName.trim();
    if (name === "") return;
    const address = customAddr.trim() === "" ? null : customAddr.trim();
    onQuickAdd({ pois: [], hotels: [], customName: name, customAddress: address });
    setCustomFormOpen(false);
    setCustomName("");
    setCustomAddr("");
    setCustomAdded({ name, address });
    if (customAddedTimerRef.current !== null) window.clearTimeout(customAddedTimerRef.current);
    customAddedTimerRef.current = window.setTimeout(() => {
      setCustomAdded(null);
      customAddedTimerRef.current = null;
    }, 3000);
  }

  /** 草案应用完成（GuideDraftReview onApplied）：上抛完整结果（含 rejected 明细）；仍有敏感操作转交父组件 */
  function handleDraftConfirm(result: GuideDraftApplyResult): void {
    onDraftApplied(result);
    if (result.type === "proposal" && (result.needsProposal?.length ?? 0) > 0) {
      onProposalNeeded(result.needsProposal ?? []);
    }
    onClose();
  }

  /**
   * 候选池「添加」（Module F）：把候选条目排进 DayN 末尾（plan+move，本地乐观落地），
   * 行随 trip 刷新自动消失；toast 3 秒内可撤销。
   * 撤销寻址：visit 壳直接用 visitId；point 由 plan 确定性建壳（makeVisitId 在同一
   * trip 基准上计算，与服务端 applyOps 内生成的 visitId 一致）。
   */
  function handleAddCandidate(entry: CandidateSuggestion): void {
    if (dayContextIndex === null) return;
    const visitId = entry.ref.kind === "visit" ? entry.ref.id : makeVisitId(trip, entry.ref.id);
    onAddCandidate(dayContextIndex, entry.ref);
    setAddedVisit({ dayIndex: dayContextIndex, visitId, name: entry.name });
    if (addedToastTimerRef.current !== null) window.clearTimeout(addedToastTimerRef.current);
    addedToastTimerRef.current = window.setTimeout(() => {
      setAddedVisit(null);
      addedToastTimerRef.current = null;
    }, 3000);
  }

  /** 撤销刚添加的候选：移回候选池（useTrip 开 5 秒二次撤销窗口），行重新出现 */
  function handleUndoAddCandidate(): void {
    if (addedVisit === null) return;
    if (addedToastTimerRef.current !== null) {
      window.clearTimeout(addedToastTimerRef.current);
      addedToastTimerRef.current = null;
    }
    onUndoAddCandidate(addedVisit.dayIndex, addedVisit.visitId);
    setAddedVisit(null);
  }

  const baseTitle = dayContextIndex === null ? "添加攻略 / 地点" : `添加到 Day${dayContextIndex}`;
  // 任务 198：day 面板标题恒为「添加到 DayN」（搜索状态在正文内表达），打开即见稳定锚点；
  // global 面板沿用搜索阶段标题（结果概览仍在头部）
  const title =
    dayContextIndex !== null
      ? baseTitle
      : quickPhase === "searching"
        ? "正在搜索…"
        : quickPhase === "results"
          ? quickEntries.length > 0
            ? `找到 ${quickEntries.length} 个结果`
            : "未找到相关景点或酒店"
          : quickPhase === "error"
            ? "搜索失败"
            : baseTitle;

  return (
    <>
      {/* 草案 ProposalCard 与 Sheet 同为 z-index 60/61：草案展示期间隐藏 Sheet（仅隐藏不卸载，
          取消草案后输入与来源列表原样回来），避免遮罩压不住 Sheet 导致两层叠在一起 */}
      <div
        className="note-input-overlay"
        style={draft !== null ? { display: "none" } : undefined}
        onClick={busy ? undefined : onClose}
        role="presentation"
      />
      <div
        className="note-input-sheet"
        style={draft !== null ? { display: "none" } : undefined}
        role="dialog"
        aria-label={dayContextIndex === null ? "添加攻略 / 地点" : `添加到 Day${dayContextIndex}`}
      >
        <div className="note-input-head">
          <h3>{title}</h3>
          <button
            type="button"
            className="close-btn"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭添加攻略"
          >
            ✕
          </button>
        </div>

        {/* 正文区（Task #242）：Sheet 内唯一的滚动容器——头部与底部行动区都在它之外，
            所以打开面板即见行动区，且不会出现「列表自己滚、整个面板不滚」的嵌套滚动 */}
        <div className="note-input-body">
        {submitNotice !== null ? (
          <div className="note-submit-notice" role="status">
            {submitNotice}
          </div>
        ) : null}
        {submitError !== null ? (
          <div className="extract-errors" role="alert">
            <div>{submitError}</div>
          </div>
        ) : null}

        {quickPhase !== "idle" ? (
          /* ===== 快速搜索（短文本直搜飞猪）：搜索中 / 结果勾选 / 0 结果 / 失败 ===== */
          <div className="quick-search-panel">
            {quickPhase === "searching" ? (
              <>
                <div className="quick-search-query">「{quickQuery}」</div>
                <div className="extract-count" role="status">正在搜索...</div>
              </>
            ) : null}

            {quickPhase === "results" && quickEntries.length > 0 ? (
              <>
                <div className="quick-search-query">
                  「{quickQuery}」找到 {quickEntries.length} 个结果，勾选后加入 Day{dayIndex}
                </div>
                {quickPartialError !== null ? (
                  <div className="quick-partial-notice" role="status">
                    {quickPartialError}，已展示另一侧结果
                  </div>
                ) : null}
                <div className="quick-results" role="group" aria-label="飞猪搜索结果">
                  {quickEntries.map((entry) => {
                    const checked = quickSelected.has(entry.key);
                    const name = entry.kind === "poi" ? entry.poi.name : entry.hotel.name;
                    const typeLabel = entry.kind === "poi" ? "景点" : "酒店";
                    const category =
                      entry.kind === "poi" &&
                      entry.poi.category !== null &&
                      entry.poi.category !== ""
                        ? entry.poi.category
                        : null;
                    // 酒店次要信息：参考价 + 评分 + 位置/地址（价格与库存以飞猪页面为准）
                    const hotelMeta =
                      entry.kind === "hotel"
                        ? [
                            entry.hotel.priceText,
                            entry.hotel.rate !== null && entry.hotel.rate !== ""
                              ? `评分 ${entry.hotel.rate}`
                              : null,
                            entry.hotel.interestsPoi ?? entry.hotel.address,
                          ]
                            .filter((part): part is string => typeof part === "string" && part !== "")
                            .join(" · ")
                        : null;
                    const meta = entry.kind === "poi" ? entry.poi.address : hotelMeta;
                    return (
                      <button
                        key={entry.key}
                        type="button"
                        role="checkbox"
                        aria-checked={checked}
                        aria-label={`${typeLabel} ${name}`}
                        className={`quick-result${checked ? " on" : ""}`}
                        onClick={() => toggleQuickEntry(entry)}
                      >
                        <span className="quick-check" aria-hidden="true">✓</span>
                        <span className="quick-result-body">
                          <span className="quick-result-top">
                            <span className="quick-result-name">{name}</span>
                            {/* Task #330：4A/5A 等级徽标（快速搜索卡，复用 quick-result-cat 体系；
                                与下方 poiAttractionLabel「大景区」标注互补：前者显示官方等级，后者显示规模归类 */}
                            {entry.kind === "poi" ? (
                              <PoiLevelTag level={entry.poi.poiLevel} variant="quick" />
                            ) : null}
                            <span className="quick-result-cat">{typeLabel}</span>
                            {category !== null ? (
                              <span className="quick-result-cat">{category}</span>
                            ) : null}
                            {entry.kind === "poi"
                              ? (() => {
                                  // Task #219 方案 2：已知大景区 / 已有归属的前瞻标注（勾选前可见）
                                  const attractionLabel = poiAttractionLabel(
                                    trip,
                                    entry.poi.name,
                                    entry.poi.poiLevel,
                                  );
                                  return attractionLabel !== null ? (
                                    <span className="quick-result-cat attraction-tag">
                                      {attractionLabel}
                                    </span>
                                  ) : null;
                                })()
                              : null}
                            {/* Task #329：快速搜索卡同口径标「免票」（免费场所不透出购票语义）；#330 D 传入名称启用名称通道 */}
                            {entry.kind === "poi" &&
                            isFreeAdmissionPoi(entry.poi.freePoiStatus, entry.poi.category, entry.poi.name) ? (
                              <span className="quick-result-cat">免票</span>
                            ) : null}
                          </span>
                          {/* Task #330：榜单行（名称下方独立一行暖色 chip，无则完全不占位） */}
                          {entry.kind === "poi" ? <PoiRankChip rank={entry.poi.listRank} /> : null}
                          {meta !== null && meta !== "" ? (
                            <span className="quick-result-address">{meta}</span>
                          ) : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {/* Task #221：搜索结果底部兑底——都不是时展开自定义点位内联表单。
                    已添加提示与入口按钮互斥展示（提示 3 秒自动消失）；
                    表单展开期间隐藏「添加选中的」主行动行：同一时刻只有一个橙色主钮，
                    取消或提交后恢复 */}
                {customAdded !== null ? (
                  <div className="quick-custom-added" role="status">
                    已添加「{customAdded.name}」到 Day{dayIndex}
                    {customAdded.address !== null ? "（含地址）" : ""}
                  </div>
                ) : !customFormOpen ? (
                  <div className="quick-custom-bar">
                    <button
                      type="button"
                      className="quick-custom-toggle"
                      onClick={openCustomForm}
                    >
                      都不是，添加自定义点位
                    </button>
                  </div>
                ) : null}
                {customFormOpen ? (
                  <div className="quick-custom-form" aria-label="添加自定义点位">
                    <div className="quick-custom-field">
                      <label className="quick-custom-label" htmlFor="quick-custom-name">
                        名称<span className="quick-custom-req">必填</span>
                      </label>
                      <input
                        id="quick-custom-name"
                        className="quick-custom-input"
                        value={customName}
                        placeholder="如：第一市场夜市入口"
                        autoFocus
                        onChange={(event) => setCustomName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") customAddrInputRef.current?.focus();
                        }}
                      />
                    </div>
                    <div className="quick-custom-field">
                      <label className="quick-custom-label" htmlFor="quick-custom-addr">
                        地址（选填）
                      </label>
                      <input
                        ref={customAddrInputRef}
                        id="quick-custom-addr"
                        className="quick-custom-input"
                        value={customAddr}
                        placeholder="可稍后补充，也可留空"
                        onChange={(event) => setCustomAddr(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") submitCustomPoint();
                        }}
                      />
                    </div>
                    <div className="quick-custom-actions">
                      <button
                        type="button"
                        className="quick-custom-cancel"
                        onClick={closeCustomForm}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className="quick-custom-confirm"
                        disabled={customName.trim() === ""}
                        onClick={submitCustomPoint}
                      >
                        添加到 Day{dayIndex}
                      </button>
                    </div>
                    <div className="quick-custom-hint">
                      自定义点位将加入 Day{dayIndex} 行程；无飞猪售卖信息，展示为普通点位卡片
                    </div>
                  </div>
                ) : null}
                {!customFormOpen ? (
                  <div className="note-results-actions">
                    <button
                      type="button"
                      className="extract-btn"
                      disabled={quickSelected.size === 0}
                      onClick={confirmQuickAdd}
                    >
                      添加选中的 {quickSelected.size} 项
                    </button>
                    <button type="button" className="ghost" onClick={() => setQuickPhase("idle")}>
                      返回修改
                    </button>
                  </div>
                ) : null}
              </>
            ) : null}

            {quickPhase === "results" && quickEntries.length === 0 ? (
              <>
                {quickPartialError !== null ? (
                  <div className="quick-partial-notice" role="status">{quickPartialError}</div>
                ) : null}
                <div className="quick-empty">
                  <div className="quick-empty-title">未找到相关景点或酒店</div>
                  <div className="quick-empty-hint">
                    「{quickQuery}」没有搜到{cityName.trim() === "" ? "" : `${cityName}的`}飞猪景点或酒店收录结果，
                    可先作为自定义点位加入行程
                  </div>
                </div>
                <div className="note-results-actions">
                  <button type="button" className="extract-btn" onClick={addCustomFromQuick}>
                    添加为自定义点位
                  </button>
                  <button type="button" className="ghost" onClick={() => setQuickPhase("idle")}>
                    返回修改
                  </button>
                </div>
              </>
            ) : null}

            {quickPhase === "error" ? (
              <>
                <div className="extract-errors">
                  <div>{quickError ?? "搜索失败，请稍后重试"}</div>
                </div>
                <div className="note-actions">
                  <button
                    type="button"
                    className="extract-btn"
                    onClick={() => void handleQuickSearch()}
                  >
                    重试搜索
                  </button>
                </div>
                <div className="note-actions">
                  <button type="button" className="ghost" onClick={addCustomFromQuick}>
                    仍添加为自定义点位
                  </button>
                  <button type="button" className="ghost" onClick={() => setQuickPhase("idle")}>
                    返回修改
                  </button>
                </div>
              </>
            ) : null}
          </div>
        ) : (
          <>
            {/* 粘贴分享文案识别到链接：输入框上方深色 toast，3s 后自动淡出 */}
            {linkToast ? (
              <div className="note-link-toast" role="status">
                已识别分享文案中的链接
              </div>
            ) : null}

            {/* 隐藏 file input：由输入区操作行「🖼」上传截图图标按钮触发（可多选 1..12 张） */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png"
              multiple
              className="shot-file-input"
              onChange={(event) => {
                pickShotFiles(event.target.files);
                // 允许连续选择同一批文件（每次 onChange 后重置 value）
                event.target.value = "";
              }}
            />

            {/* 统一输入区（DEMO ①）：链接 / 攻略文字 / 景点酒店名都粘同一个框 */}
            <div className="note-input-box">
              <textarea
                className="note-textarea"
                value={text}
                placeholder={
                  dayContextIndex === null
                    ? "粘贴攻略链接 / 文字，或输入景点、酒店名"
                    : "输入景点/酒店名直接搜索，或粘贴攻略链接/文字"
                }
                rows={2}
                disabled={submitting}
                onChange={(event) => {
                  setText(event.target.value);
                  if (submitNotice !== null) setSubmitNotice(null);
                }}
                onPaste={(event) => {
                  // 粘贴分享文案（含小红书链接，Task #304 起含无 scheme 形态）：
                  // 全文保留，提交时自动分流到链接来源
                  if (findXhsLink(event.clipboardData.getData("text")) !== null) {
                    showLinkToast();
                  }
                }}
              />
              {/* Task #236（对齐 DEMO ① 功能层级）：保存 / 上传按钮紧贴录入框右下，
                  不再占满整行——「先保存攻略」是录入区的动作，底部橙色主 CTA
                  才负责「再选择攻略生成行程」，两者视觉层级明确分离。
                  空输入灰禁；文案随输入类型感知切换（短文本「搜索点位」/ 长文链接
                  「保存攻略」；day 面板恒为「提交」） */}
              <div className="note-input-actions">
                <button
                  type="button"
                  className="note-upload-btn"
                  disabled={submitting}
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="上传截图"
                  title="上传截图"
                >
                  🖼
                </button>
                <button
                  type="button"
                  className="extract-btn"
                  disabled={!canSubmit}
                  onClick={() => void handleSave()}
                >
                  {dayContextIndex !== null
                    ? submitting
                      ? "提交中…"
                      : "提交"
                    : submitting
                      ? "保存中…"
                      : !textHasContent
                        ? "保存"
                        : quickPending && shotFiles.length === 0
                          ? "搜索点位"
                          : "保存攻略"}
                </button>
              </div>
            </div>

            {shotError !== null ? (
              <div className="extract-errors" role="alert">
                <div>{shotError}</div>
              </div>
            ) : null}
            {shotFiles.length > 0 ? (
              <>
                <div className="shot-file-list" aria-label="已选择的攻略截图">
                  {shotPreviews.map((preview, index) => (
                    <div className="shot-file-thumb" key={preview.url}>
                      <img src={preview.url} alt={`截图 ${index + 1}`} loading="lazy" />
                      <button
                        type="button"
                        className="shot-file-remove"
                        aria-label={`移除第 ${index + 1} 张截图`}
                        disabled={submitting}
                        onClick={() => removeShotFile(index)}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  {shotFiles.length < MAX_IMAGES_PER_SOURCE ? (
                    <button
                      type="button"
                      className="shot-file-add"
                      disabled={submitting}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      ＋
                    </button>
                  ) : null}
                </div>
                <div className="shot-privacy">
                  提交后截图会自动识别要点（每张约需几十秒）；原图随证据保存，可在点位的「攻略原文」中回看。
                </div>
              </>
            ) : null}

            {submitting ? (
              <div className="extract-count" role="status">正在保存攻略…</div>
            ) : null}

            {/* 任务 198：「提交」是唯一主行动，此处用一行灰字说明提交后的去向
                （短文本 → 飞猪搜索勾选；长文/链接 → 攻略来源识别后进推荐） */}
            {dayContextIndex !== null ? (
              <div className="note-submit-hint">
                景点 / 酒店名搜飞猪结果；链接或长文识别后进入推荐
              </div>
            ) : null}
          </>
        )}

        {/* 已添加攻略素材列表（Task #236）：跟在录入区之后——先保存攻略，再在列表里
            勾选本次要用的几篇生成（列表自带受控勾选框，阶段与底部 CTA 共用同一份
            选择状态）。任务 198：day 添加面板不重复攻略管理，直接隐藏；快速搜索
            结果展开时也让位（同一时刻只服务一个任务） */}
        {dayContextIndex === null && quickPhase === "idle" ? (
          <GuideSourceList
            trip={trip}
            sources={sources}
            selectedIds={selectedIdSet}
            locked={generation.active}
            busy={busy}
            getOriginal={getOriginal}
            onOpenOriginal={handleOpenOriginal}
            onToggleSource={handleToggleSource}
            onSelectAll={handleSelectAllSources}
            onSelectNone={handleSelectNoSources}
            onSelectStaged={handleSelectStagedSources}
            onRetry={handleRetrySource}
            onTriggerOcr={handleTriggerOcr}
            onRetryImage={handleRetryImage}
            onRemove={handleRemoveSource}
          />
        ) : null}

        {/* ===== 候选池区块（Module F / 任务 185）：仅 day 上下文渲染，置于输入框与当前
            输入对应操作（搜索结果面板或主按钮）之后——打开面板先见输入与主操作，
            推荐候选下移不再置顶；逐项「添加」与撤销 toast 语义不变。
            任务 198：快速搜索结果展开时候选区让位（搜索态只保留输入结果，避免两套列表
            同时抢占首屏）；addedVisit 非空时保持渲染，避免候选清空后 toast 跟着消失 */}
        {dayContextIndex !== null &&
        quickPhase === "idle" &&
        (candidateRows.length > 0 || addedVisit !== null) ? (
          <div className="candidate-section" aria-label="攻略推荐的候选景点">
            {candidateRows.length > 0 ? (
              <div className="candidate-head">推荐添加到 Day{dayContextIndex}</div>
            ) : null}
            {candidateRows.map((row) => {
              const address = row.address ?? "";
              // 大景区壳已归入的岛内玩法数（验收问题修复）：排入当天后父卡会直接
              // 展示这些子玩法与亮点，这里提前声明，避免候选行看起来只有孤零零一个景区
              const childCount =
                row.ref.kind === "visit"
                  ? (trip.visits[row.ref.id]?.childStopRefs.length ?? 0)
                  : 0;
              const baseMeta =
                row.sourceCount > 0
                  ? `${row.sourceCount} 篇攻略推荐`
                  : row.removedFrom !== null
                    ? `原 Day${row.removedFrom.dayIndex}`
                    : null;
              // 第二行：推荐数（或原位置）· 岛内玩法数 · 地址；都无则不渲染
              const metaParts = [
                baseMeta,
                childCount > 0 ? `含 ${childCount} 个岛内玩法` : null,
                address !== "" ? address : null,
              ].filter((part): part is string => part !== null);
              const meta = metaParts.length > 0 ? metaParts.join(" · ") : null;
              return (
                <div className="candidate-item" key={`${row.ref.kind}:${row.ref.id}`}>
                  <div className="candidate-main">
                    <div className="candidate-name">{row.name}</div>
                    {meta !== null ? (
                      <div
                        className="candidate-meta"
                        style={address !== "" ? CANDIDATE_META_ELLIPSIS : undefined}
                        title={address !== "" ? address : undefined}
                      >
                        {meta}
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="candidate-add"
                    onClick={() => handleAddCandidate(row)}
                  >
                    添加
                  </button>
                </div>
              );
            })}
            {addedVisit !== null ? (
              <div className="candidate-toast" role="status">
                <span className="candidate-toast-text">
                  已添加到 Day{addedVisit.dayIndex} · {addedVisit.name}
                </span>
                <button
                  type="button"
                  className="candidate-toast-undo"
                  onClick={handleUndoAddCandidate}
                >
                  撤销
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* 攻略生成区（Task #236）：素材勾选在来源列表完成，此处只负责补充要求
            与底部固定主 CTA（AI 生成行程 · 已选 N 篇）+ 次要出口（仅暂存，稍后处理）；
            输入区有待保存内容时退让为引导文案，保证全屏同一时刻只有一个橙色实心钮；
            任务 198：day 添加面板不渲染此区；生成请求经 onGenerateDraft 上抛行程级
            会话（任务 135），关闭面板不中断 */}
        {quickPhase === "idle" && dayContextIndex === null ? (
          <GuideDraftPanel
            trip={trip}
            sources={sources}
            openContext={openContext}
            busy={busy}
            textHasContent={textHasContent}
            generation={generation}
            consumedSourceIds={consumedSourceIds}
            selectedSourceIds={selectedSourceIds}
            note={draftNote}
            onNoteChange={setDraftNote}
            onGenerate={onGenerateDraft}
            onCancelGenerate={onCancelGenerateDraft}
            onSaveLater={onClose}
          />
        ) : null}
        </div>

        {/* 固定行动区（Task #242）：挂在 Sheet 尾部、滚动容器之外——主 CTA
            「AI 生成行程 · 已选 N 篇」与次要出口「仅暂存，稍后处理」打开即见；
            软键盘弹出时 Sheet 随 --app-height 收缩，行动区仍贴 Sheet 底边不被遮挡。
            day 面板 / 快速搜索结果展开时不渲染本区（同一时刻只服务一个任务） */}
        {showDraftFoot ? (
          <div className="note-input-foot">
            <GuideDraftActionsBar
              trip={trip}
              sources={sources}
              openContext={openContext}
              busy={busy}
              textHasContent={textHasContent}
              generation={generation}
              consumedSourceIds={consumedSourceIds}
              selectedSourceIds={selectedSourceIds}
              note={draftNote}
              onGenerate={onGenerateDraft}
              onCancelGenerate={onCancelGenerateDraft}
              onSaveLater={onClose}
            />
          </div>
        ) : null}
      </div>

      {/* 任务 186：来源原文查看层（文字 / 截图来源的原文回看），z-index 62/63 盖过
          本面板 61 层；复用 .backdrop/.sheet 与 .evidence-zoom，不另造弹层体系。
          关闭即卸载（setOriginalView(null)） */}
      {originalView !== null ? (
        <SourceOriginalSheet
          source={originalView.source}
          original={originalView.original}
          onClose={() => setOriginalView(null)}
        />
      ) : null}

      {/* 草案预览与一次性确认（任务 125：明确要求 + 冲突勾选 + 应用，替代原 ProposalCard
          原子应用通道；遮罩铺满视口；DRAFT_STALE 由 GuideDraftReview 透传提示）。
          草案由行程级 props.draft 提供（任务 135）：生成成功 / 重载召回的新鲜草案直接可看；
          key=draft.draftId：取消卸载 / 重新生成或草案变化时强制重建，勾选状态不沿用旧
          草案的 conflict id（任务 125 选中状态清理要求）。 */}
      {draft !== null ? (
        <GuideDraftReview
          key={draft.draftId}
          tripId={tripId}
          trip={trip}
          draft={draft}
          onApplied={handleDraftConfirm}
          onProposalNeeded={onProposalNeeded}
          onCancel={onDraftDismiss}
        />
      ) : null}
    </>
  );
}

/** 服务端来源列表排序（按导入时间稳定排序；listGuideSources 返回含 inactive，需过滤） */
function activeSourcesSorted(sources: GuideSource[]): GuideSource[] {
  return sources
    .filter((source) => source.active)
    .sort((left, right) => {
      if (left.importedAt !== right.importedAt) return left.importedAt < right.importedAt ? -1 : 1;
      return left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0;
    });
}
