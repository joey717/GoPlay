import { useMemo, useState, type KeyboardEventHandler } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { GuideOptionCategory, GuideOptionGroup, Stop, Trip, Visit } from "@goplay/shared";
import {
  AI_SUPPLEMENT_CHIP_LABEL,
  AI_SUPPLEMENT_CHIP_LABEL_COMPACT,
  AI_SUPPLEMENT_VERIFY_NOTE,
  clusterSimilarSnippets,
  GUIDE_OPTION_CATEGORY_LABELS,
  GUIDE_SNIPPET_DISPLAY_LIMIT,
  guideOptionGroupMinPrice,
  isAiSupplement,
  isFreeAdmissionItem,
  itemDescription,
  itemListRank,
  itemPoiLevel,
  shouldShowIntroEntry,
  snippetClusterNote,
} from "@goplay/shared";
import { resolveEntityPageImages } from "../lib/entityImages";
import { SHOW_ESTIMATED_TIMES } from "../lib/displayFlags";
import { REFUND_ASSURANCE_TEXT, showRefundAssurance } from "../lib/refundAssurance";
import { resolvePointImage } from "../lib/pointImage";
import { resolveEntitySourceLinks } from "../lib/sourceLinks";
import { formatMode, suggestDurationLabel } from "../lib/format";
import { eligibleClassifyTargets } from "../lib/largeAttraction";
import {
  addressText,
  isParentCardVisit,
  stopDisplayName,
  visitDisplayName,
  visitItem,
  visitModeLabel,
} from "../lib/trip";
import { buildDragSurfaceListeners } from "../lib/dragSurface";
import { ConfirmDialog } from "./ConfirmDialog";
import CardActions from "./CardActions";
import EvidenceSheet from "./EvidenceSheet";
import PoiIntroSheet from "./PoiIntroSheet";
import ImagePlaceholder from "./ImagePlaceholder";
import SourceLinkEntry from "./SourceLinkEntry";
import StopRow from "./StopRow";
import { PoiLevelTag, PoiRankChip } from "./PoiMeta";

interface VisitCardProps {
  trip: Trip;
  visit: Visit;
  /** 当天第一站时，交通行显示「从住处出发」 */
  isFirst: boolean;
  /** 在「当天景点 + 酒店混合列表」中的下标（0-based；↑↓ 隐藏边界用） */
  index: number;
  /** 当天混合列表条目总数（≤1 时不渲染 ↑↓，只保留 ×） */
  total: number;
  /** 混合列表 ↑↓ 改序（与酒店共用同一排序写入） */
  onMoveItem: (fromIndex: number, toIndex: number) => void;
  /** M2 F12 批量管理：进入选择模式（默认不选），隐藏拖拽与操作钮，整卡点击切换选中 */
  selectMode: boolean;
  /** 批量管理下的当前选中态 */
  selected: boolean;
  onToggleSelect: () => void;
  onRemove: () => void;
  /** F7 购票状态明确选择（站外已购携带备注） */
  onPurchaseSelect: (state: Visit["purchaseState"], externalNote?: string) => void;
  /** F3 锁定切换 */
  onToggleLock: () => void;
  /** 内部玩法父内改序（上移/下移；不跨父/跨天） */
  onMoveStop: (fromIndex: number, toIndex: number) => void;
  /** 内部玩法移入本父备选玩法 */
  onRemoveStop: (stopId: string) => void;
  /** 备选玩法放回岛内行程末尾 */
  onRestoreStop: (stopId: string) => void;
  /** 打开手动添加点位 Sheet（Module C 起大景区卡不再渲染「添加」入口，prop 保留兼容调用方） */
  onAddStop: () => void;
  /**
   * 任务 124 起卡内「查看攻略原文」改为打开外部原链语义，不再经此打开内部玩法
   * 证据面板；DayContent 调用方仍传入，prop 保留兼容（卡内不再消费）。
   */
  onOpenStopEvidence: (stopId: string) => void;
  /**
   * Task #199：把本卡（独立普通景点）归入某大景区作为内部玩法。
   * 目标大景区由上层弹层选择并二次确认；不传则该入口整体不渲染。
   */
  onClassifyIntoParent?: (visitId: string) => void;
  /**
   * 一键采纳本景区的高置信度推荐玩法（待定区里 level=high 且建议归属为本卡的 Stop）。
   * 不传则只展示「有 N 个推荐玩法待确认」提示，不提供按钮。
   */
  onAdoptSuggestedStops?: (visitId: string) => void;
}

/** 拖动已锁定/已购票点位时的移除护栏：文案与「先完成前置操作再移出」的确认载荷 */
interface RemoveGuard {
  locked: boolean;
  bought: boolean;
}

/** "HH:MM" + 分钟 → "HH:MM"（按 24h 取模）；非法时间格式返回 null */
function addMinutes(time: string, minutes: number): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (match === null) return null;
  const total = (Number(match[1]) * 60 + Number(match[2]) + minutes) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** 分钟 → 中文时长（Module C「约 X 小时」）；未知（null / 非正数）返回 null 不渲染 */
function parentDurationLabel(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes < 60) return `${Math.round(minutes)} 分钟`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours} 小时` : `${hours.toFixed(1)} 小时`;
}

/** Task #190：选项组打开原文时定位的首条提及（选项级优先，组级兜底；无则 null） */
function optionGroupFocusRef(group: GuideOptionGroup): string | null {
  const fromOption = group.options.find((option) => option.sourceMentionRefs.length > 0);
  return fromOption?.sourceMentionRefs[0] ?? group.sourceMentionRefs[0] ?? null;
}

/** 最低参考价展示文本：整数不带小数（30 → "30"，32.5 → "32.5"）；null 不显示 */
function minPriceLabel(group: GuideOptionGroup): string | null {
  const min = guideOptionGroupMinPrice(group);
  if (min === null) return null;
  return Number.isInteger(min) ? String(min) : min.toFixed(1);
}

/**
 * Task #274 实用参考分类图标：内联描边 SVG（1.4px stroke + currentColor），
 * 与项目既有 TrashIcon 图标同一套语言；刻意不用彩色 emoji，
 * 避免表情色块与纸感（clay/sage）配色打架。颜色与尺寸由外层 .og-icon 控制。
 */
function OptionCategoryIcon({ category }: { category: GuideOptionCategory }) {
  const shape = {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (category) {
    case "transport": // 环岛代步车：车顶 + 车体 + 双轮
      return (
        <svg {...shape}>
          <rect x="2.1" y="6.5" width="11.8" height="4.6" rx="1.9" />
          <path d="M4.5 6.5 5.7 3.9a1 1 0 0 1 .9-.6h2.8a1 1 0 0 1 .9.6l1.2 2.6" />
          <circle cx="5.4" cy="11.6" r="1.15" />
          <circle cx="10.6" cy="11.6" r="1.15" />
        </svg>
      );
    case "shuttle": // 接驳摆渡：车厢 + 车窗线 + 双轮
      return (
        <svg {...shape}>
          <rect x="3.1" y="2.9" width="9.8" height="7.3" rx="1.5" />
          <path d="M3.1 7.3h9.8" />
          <circle cx="5.7" cy="11.9" r="1.1" />
          <circle cx="10.3" cy="11.9" r="1.1" />
        </svg>
      );
    case "ticket": // 票券：票面 + 虚线撕口 + 打孔
      return (
        <svg {...shape}>
          <rect x="2.1" y="4.6" width="11.8" height="7.2" rx="1.6" />
          <path d="M7 4.9v6.6" strokeDasharray="1.2 1.3" />
          <path d="M4.6 8h.01" strokeWidth={1.8} />
        </svg>
      );
    case "rental": // 租赁：钥匙
      return (
        <svg {...shape}>
          <circle cx="5.7" cy="10.3" r="2.4" />
          <path d="M7.4 8.6 13 3" />
          <path d="M10.9 5.1l1.6 1.6" />
        </svg>
      );
    case "dining": // 餐饮：碗 + 筷子
      return (
        <svg {...shape}>
          <path d="M2.9 8.6h10.2a5.1 5.1 0 0 1-10.2 0z" />
          <path d="M6.6 8.4 8.4 4.3M9.6 8.4 11.4 4.3" />
        </svg>
      );
    case "activity": // 玩法档位：四角星
      return (
        <svg {...shape}>
          <path d="M8 2.6l1.4 3.9 4 1.5-4 1.5L8 13.4 6.6 9.5l-4-1.5 4-1.5z" />
        </svg>
      );
    default: // other 兜底：信息提示
      return (
        <svg {...shape}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 7.4v3.4" />
          <path d="M8 5.1h.01" strokeWidth={1.8} />
        </svg>
      );
  }
}

/**
 * Task #274 分类小字：比底部 chip（交通 / 门票 …）多「参考」二字，
 * 明确这是参考资料而非待办或 CTA；other 兜底「实用参考」，不臆造分类名。
 */
const OPTION_CATEGORY_HINTS: Record<GuideOptionCategory, string> = {
  transport: "交通参考",
  shuttle: "接驳参考",
  ticket: "门票参考",
  rental: "租赁参考",
  activity: "玩法参考",
  dining: "餐饮参考",
  other: "实用参考",
};

/**
 * Task #190 实用参考主题卡：默认只占一行摘要（主题 · 选项数 · 最低参考价），
 * 点击展开逐选项一行 + 底部原文入口与「价格仅供参考」；无数据不渲染（历史 Trip 兼容）。
 *
 * Task #274：收起态识别度偏低（只有「主题 + 4 个选项 · 低至 ¥5 + 展开」），
 * 因此在标题左侧加 28px 浅色圆底分类图标、主题下方加一行 9.5px 分类小字
 * （「交通参考」），并给整张卡极轻的 sage 头部底色 + clay 左强调线；
 * 视觉仍明显弱于主 CTA。收起/展开共用同一标题头，展开态内容（route / scene /
 * note 分行、底部原文入口）完全不变。
 *
 * Task #270：展开态把 routeText / sceneText / noteText 分行展示（「路线 / 适合 / 说明」），
 * 不再用「·」拼成一行——西岛「步行」这类选项的路线（码头左侧海岸线和渔村）与适用场景
 * （不想花钱代步的人）是决策关键信息，压成一行后用户在手机上无法区分。字段为空时
 * 整行不渲染，避免出现只有标签的空行。
 */
function OptionGroupCard({
  group,
  onOpenEvidence,
}: {
  group: GuideOptionGroup;
  onOpenEvidence: () => void;
}) {
  const [open, setOpen] = useState(false);
  const price = minPriceLabel(group);
  const hint = OPTION_CATEGORY_HINTS[group.category];
  const actionLabel = open ? "收起选项明细" : "展开选项明细";
  return (
    <div className="option-group">
      <button
        type="button"
        className="og-head"
        aria-expanded={open}
        aria-label={`${group.topic}，${hint}，${actionLabel}，共 ${group.options.length} 个选项${
          price !== null ? `，低至 ${price} 元` : ""
        }`}
        title={actionLabel}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="og-icon" data-category={group.category} aria-hidden="true">
          <OptionCategoryIcon category={group.category} />
        </span>
        <span className="og-titles">
          <span className="og-topic">{group.topic}</span>
          <span className="og-hint">{hint}</span>
        </span>
        <span className="og-sum">
          <span className="og-count">{group.options.length} 个选项</span>
          {price !== null ? <span className="og-min">低至 ¥{price}</span> : null}
        </span>
        <span className="og-arrow" aria-hidden="true">
          {open ? "收起" : "展开"}
        </span>
      </button>
      {open ? (
        <div className="og-body">
          {group.options.map((option, index) => {
            const lines: { key: string; label: string; text: string | null }[] = [
              { key: "route", label: "路线", text: option.routeText },
              { key: "scene", label: "适合", text: option.sceneText },
              { key: "note", label: "说明", text: option.noteText },
            ];
            return (
              <div className="og-row" key={`${option.label}-${index}`}>
                <div className="og-main">
                  <span className="og-label">{option.label}</span>
                  {option.priceText !== null ? <span className="og-price">{option.priceText}</span> : null}
                  {option.bargain === true ? <span className="og-bargain">可议价</span> : null}
                </div>
                {lines.map((line) =>
                  line.text !== null ? (
                    <div className="og-line" key={line.key}>
                      <span className="og-key">{line.label}</span>
                      <span className="og-val">{line.text}</span>
                    </div>
                  ) : null,
                )}
              </div>
            );
          })}
          <div className="og-foot">
            <span className="og-cat">{GUIDE_OPTION_CATEGORY_LABELS[group.category]}</span>
            <button type="button" className="og-evidence" onClick={onOpenEvidence}>
              查看原文
            </button>
            <span className="og-disclaimer">价格仅供参考</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Task #342 父卡引用块的簇诚实标注（Task #352 处/篇规则）：总提及 ≤1 不标注；每篇恰好一次且 ≥2 篇「N篇攻略提及」；其余「N处攻略提及」 */
function clusterInlineNote(cluster: { sourceCount: number; mentionCount: number }): string | null {
  const note = snippetClusterNote(cluster);
  return note !== null ? `（${note}）` : null;
}

/**
 * 行程点位卡（v1.1 父子模型）：
 * - ordinary 普通景点：沿用城市级卡片（拖拽/锁定/购买/时长/移除）；
 * - large_attraction 大景区父卡（Module C 改造）：卡片顶部横版大照片（154px 高、
 *   object-fit: cover；无图保留米色占位——老版图片视觉恢复，交互仍为新版）
 *   + 标题/标签行
 *   + 底部时长摘要（Task #350 起「岛内 N 个点」计数文案已永久去除，仅保留受
 *   SHOW_ESTIMATED_TIMES 门控的「约 X 小时」；Task #108 起不再内嵌路线 chips，
 *   岛内玩法顺序统一由 Day 路线顺序总览承载）
 *   + 攻略亮点引用块（snippets 合并拼接 + 原文弱入口）+ 岛内小行程
 *   （StopRow 序号圆点 + 40×40 小方图 + 时间行，仅上移/下移/移入备选，
 *   无购买/锁定/跨天/设时间）
 *   + 备选玩法展开区；
 * - 任务 127 恢复父卡城市级操作：标题区下方紧凑操作行（锁定 / 购票状态 /
 *   查票价，与普通卡共用同一套处理器与按钮体系；无飞猪跳转链接时只隐藏
 *   查票价、保留状态切换），✕ 仍在标题行右侧；已锁定/已购票时的移除护栏
 *   弹窗仍提供解锁 / 改购票状态的等价操作；
 * - 攻略提示（B4）：普通卡 chips ≤2 条；大景区合并为单条引用块（批量模式下隐藏）。
 * 外部交通只算到景区入口（Visit.externalLeg），内部不重复计算城市交通。
 */
export default function VisitCard({
  trip,
  visit,
  isFirst,
  index,
  total,
  onMoveItem,
  selectMode,
  selected,
  onToggleSelect,
  onRemove,
  onPurchaseSelect,
  onToggleLock,
  onMoveStop,
  onRemoveStop,
  onRestoreStop,
  onClassifyIntoParent,
  onAdoptSuggestedStops,
}: VisitCardProps) {
  /** Task #296：图片加载失败按来源分别记账（飞猪外链失败仍可降级 PX 图，PX 失败才落占位） */
  const [fliggyImgFailed, setFliggyImgFailed] = useState(false);
  const [guideImgFailed, setGuideImgFailed] = useState(false);
  const [reserveOpen, setReserveOpen] = useState(false);
  /** v1.1 remove 拒绝 locked/bought：点击移除时弹说明，并提供完成前置操作的确认入口 */
  const [removeGuard, setRemoveGuard] = useState<RemoveGuard | null>(null);
  /** B4 攻略提示回看：open 时打开内部 EvidenceSheet；ref 为定位提及（可空） */
  const [snippetFocus, setSnippetFocus] = useState<{ open: boolean; ref: string | null }>({
    open: false,
    ref: null,
  });
  /** Task #372：「查看介绍」应用内浮层开关（仿 snippetFocus；仅命中介绍入口的点位可开） */
  const [introOpen, setIntroOpen] = useState(false);

  // F2 同日拖拽排序：整个 .row（交通行 + 卡片）作为 sortable 单元；
  // Task #346（PD 2026-11-04）：把手列移除，listeners 经守卫后挂整卡行容器
  // （button/a/input 等交互元素不发起拖拽），键盘路径由 sr-only .drag-kbd 把手承载
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: visit.visitId,
  });
  // 批量选择态不挂拖拽面（该态原本就以 pick 取代把手，整卡点击切换选中）
  const surfaceListeners = selectMode ? undefined : buildDragSurfaceListeners(listeners);
  // Task #346：父卡 clay 标签只显 mode 段——full_day 空串时整枚不渲染（PD：「大景区」几个字也去掉）
  const parentModeLabel = visitModeLabel(visit);

  const dragStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 100 : undefined,
  };

  const item = visitItem(trip, visit);
  const name = visitDisplayName(trip, visit);
  const jumpUrl = item?.jumpUrl ?? null;
  /**
   * Task #329：免费场所（freePoiStatus=FREE 或 category 购物类兜底，单一数据源
   * shared/freePoi.ts）——主按钮降级为「查看详情」弱入口（保留 jumpUrl 跳转能力，
   * 不呈现购票语义）并展示「免票」标签；普通卡与父卡同一口径。
   */
  const freeAdmission = isFreeAdmissionItem(item);
  /**
   * Task #372：「查看介绍」应用内浮层入口——无购票通道或免费入场且有介绍文本时命中
   * （单一数据源 shared/freePoi.ts shouldShowIntroEntry；空浮层守卫已在其中）。
   * introText 为浮层正文（命中时恒非 null）；西岛等 NOT_FREE 有通道点位不命中，原购票路径零变化。
   */
  const showIntro = shouldShowIntroEntry(item);
  const introText = itemDescription(item);
  /**
   * Task #330：飞猪 POI 元信息（读时默认，缺失 → null，存量零迁移）——
   * poiLevel 归一化为 4A/5A 徽标、listRank 榜单 chip；普通卡与大景区父卡同一取值，
   * 无信号时各组件自行返回 null（不占位）。
   * Task #356（PD DEMO v0.5）：description 介绍折叠区不再渲染（页面文字太多），
   * 数据字段与 shared 取值函数保留不动，仅移除展示层消费。
   */
  const poiLevel = itemPoiLevel(item);
  const listRank = itemListRank(item);
  // 任务 196 + Task #296 配图优先级：飞猪图（origin=fliggy 且 mainPic 非空）优先；
  // 无飞猪图（自定义点 / 飞猪记录无图）才回退攻略 PX 页码关联首图（标注「攻略原图」
  // 与飞猪实图区分）；两者皆无 / 加载失败降级完毕沿用统一占位兜底
  const pageImages = useMemo(() => resolveEntityPageImages(trip, undefined, visit), [trip, visit]);
  /**
   * Task #283 / C4：AI 补充项——攻略未覆盖、由 AI 补排且已飞猪核验的点位。
   * 主行程卡展示「AI 补充·飞猪核验」chip；≤360px 降级为「AI 补充」并把核验说明
   * 移入详情行（.ai-supplement-note，宽屏隐藏、窄屏显示）。清单不展示（见 TripChecklist）。
   */
  const aiSupplement = isAiSupplement(item);
  const aiSupplementVerifyPart = AI_SUPPLEMENT_CHIP_LABEL.slice(AI_SUPPLEMENT_CHIP_LABEL_COMPACT.length);
  const pointImage = resolvePointImage(item, pageImages.firstAssetPath, {
    fliggyFailed: fliggyImgFailed,
    guideFailed: guideImgFailed,
  });

  // Task #77 地址展示（与 StopRow 共用 addressText 契约）：飞猪主数据地址
  // 直接展示；自定义点位退回 AI 提取的位置描述并声明来源（可确认是否准确）；
  // Task #221：表单手填的地址（addressSource="user"）直接展示、免加 AI 声明；
  // 都没有时如实提示，不再冒充「待补全」
  const addrText = addressText(
    item !== null && item.origin === "fliggy" ? item.address : null,
    item !== null && item.origin === "custom" ? item.address : null,
    item !== null && item.origin === "custom" && item.addressSource === "user"
      ? item.address
      : null,
  );

  const childStops = visit.childStopRefs
    .map((stopId) => trip.stops[stopId])
    .filter((stop): stop is Stop => stop !== undefined);
  const alternateStops = visit.alternateStopRefs
    .map((stopId) => trip.stops[stopId])
    .filter((stop): stop is Stop => stop !== undefined);
  /**
   * 待确认的高置信度推荐玩法（与 planner / 存量修复脚本同口径）：待定区里
   * suggestedVisitRef 指向本景区、level=high 且用户未表态（decidedBy≠user）的 Stop。
   * 父卡据此提示「有 N 个推荐玩法待确认」，一键采纳走 useTrip.adoptSuggestedStops。
   */
  const suggestedChildStops = useMemo(
    () =>
      Object.values(trip.stops).filter((stop) => {
        if (stop.state !== "pending") return false;
        if (stop.suggestedVisitRef !== visit.visitId) return false;
        const suggestion = trip.relationshipSuggestions[stop.stopId];
        if (suggestion === undefined || suggestion.level !== "high") return false;
        return suggestion.decidedBy !== "user";
      }),
    [trip, visit.visitId],
  );
  /** Module C 父卡底部时长段的中文时长（Task #340：SHOW_ESTIMATED_TIMES 关闭时为 null 不展示时长；
      Task #350：「岛内 N 个点」计数文案已永久去除，本时长段是 parent-sub 唯一残留内容） */
  const durationLabel = SHOW_ESTIMATED_TIMES
    ? parentDurationLabel(visit.effectiveMinutes)
    : null;
  /**
   * Module C 岛内小点时间推算：从父 Visit startTime 起按建议时长连续顺排
   * （Stop 无独立时间字段、也无内部交通数据，按连续游玩近似）；无法推算为 null。
   * 任一小点时长未知时清空游标：后续小点不再假定与上一项同一开始时间（Task #108）。
   * Task #340：估算时间开关关闭时整列置 null（StopRow 时间行不渲染推算区间）。
   */
  const childTimeRanges: Array<{ start: string; end: string } | null> = [];
  let childTimeCursor = SHOW_ESTIMATED_TIMES ? visit.startTime : null;
  for (const stop of childStops) {
    if (childTimeCursor === null || stop.suggestMinutes === null || stop.suggestMinutes <= 0) {
      childTimeRanges.push(null);
      childTimeCursor = null;
      continue;
    }
    const end = addMinutes(childTimeCursor, stop.suggestMinutes);
    childTimeRanges.push(end !== null ? { start: childTimeCursor, end } : null);
    childTimeCursor = end;
  }
  /**
   * Task #342 展示层聚类：相似亮点卡内收敛为 1 条 + 诚实标注（Task #352 处/篇
   * 规则：每篇恰好提及一次且 ≥2 篇 →「N篇攻略提及」，其余按总提及次数 →
   * 「N处攻略提及」）；普通卡 chips 与父卡引用块同一口径；数据与攻略原文 sheet
   * 仍逐条全量展示，信息不丢。
   */
  const snippetClusters = useMemo(
    () => clusterSimilarSnippets(visit.guideSnippets ?? [], trip).slice(0, GUIDE_SNIPPET_DISPLAY_LIMIT),
    [visit, trip],
  );
  /**
   * Task #190 实用参考选项组：仅 Visit 有数据时渲染可折叠主题卡（普通卡 chips 下方、
   * 父卡引用块下方）；批量选择模式与 snippets 同规则隐藏；原文入口复用 EvidenceSheet。
   */
  const optionGroups = visit.optionGroups ?? [];
  /**
   * 任务 124 原文入口语义分离：灰色「查看攻略原文」只负责打开用户导入的外部
   * 原链，层级规则与 EvidenceSheet 提及范围一致（任务 118 的 buildEvidenceMentionScope）——
   * 大景点聚合父 Visit + 已归属内部玩法（备选玩法不并入），链接取来源 sourceUrl、
   * 缺失回退 canonicalUrl，按 URL 去重。无外部链接（text / images 来源）时入口
   * 整体隐藏，不再降级打开 EvidenceSheet；绿色 snippet chip 仍打开 EvidenceSheet
   * 并定位对应提及（下方 chips 逻辑保持不变）。
   */
  const sourceLinks = useMemo(() => resolveEntitySourceLinks(trip, undefined, visit), [trip, visit]);
  /**
   * Task #412：父卡是否拥有「自己的」亮点证据（景区自身 guideSnippets 或 sourceMentionRefs）。
   * 父卡证据范围按层级规则会合并已归属内部玩法的提及（lib/evidenceScope），因此
   * sourceLinks 非空并不等于父卡自己有亮点：没有自身亮点时父卡不再单独挂「查看攻略原文」
   * 兜底入口（否则会形成「无引文只有外链」的孤立块）；内部玩法各自的原文入口不受影响。
   */
  const parentOwnEvidence =
    (visit.guideSnippets?.length ?? 0) > 0 || (visit.sourceMentionRefs?.length ?? 0) > 0;

  // 外部交通（只算到景区入口）；null 视为 0 分钟（同址/紧邻），不渲染交通行
  const leg = visit.externalLeg;
  const legText =
    leg === null
      ? null
      : `${formatMode(leg.mode)} ${leg.minutes !== null ? `${leg.minutes} 分钟` : "时间待定"}`;

  // 建议时长未知（待定）时不渲染「建议 …」，避免出现无信息量的「建议 待定」
  const suggestLabel = suggestDurationLabel(visit.effectiveMinutes);

  /**
   * Task #199：独立景点归入大景区入口的显示条件——本卡为普通景点、未锁定未购票，
   * 行程中存在「合格」的已排期大景区（候选池里的壳归入后不可见，不作为目标），且上层已接线。
   * Task #360（PD 2026-11-10 拍板）：合格口径由「任意已排期大景区」收紧为
   * 距离规则（双方有坐标 ≤2km；任一方无坐标→同天兜底），单点维护在
   * lib/largeAttraction.ts。入口只负责抛事件；目标选择与二次确认（原 Visit 会被删除）在上层完成。
   */
  const canClassifyIntoParent =
    visit.kind === "ordinary" &&
    !visit.locked &&
    visit.purchaseState !== "bought" &&
    onClassifyIntoParent !== undefined &&
    eligibleClassifyTargets(trip, visit).length > 0;



  /** 移除护栏：v1.1 remove 拒绝 locked/bought，弹窗提供「先解锁 / 改购票状态再移出」的等价操作 */
  const handleRemoveClick = () => {
    if (visit.locked || visit.purchaseState === "bought") {
      setRemoveGuard({ locked: visit.locked, bought: visit.purchaseState === "bought" });
      return;
    }
    onRemove();
  };

  /**
   * 护栏确认：先把锁定 / 已购票状态复位（解锁 / 购票改为未确定），再执行移除。
   * 任务 127 后父卡虽已恢复锁定 / 购票按钮，二次确认的等价操作流程保持不变；
   * 普通景点同样适用（与卡片按钮结果一致）。
   * runOps 同步更新 tripRef，因此连续调用按顺序生效。
   */
  const confirmRemoveGuard = () => {
    const guard = removeGuard;
    if (guard === null) return;
    setRemoveGuard(null);
    if (guard.locked) onToggleLock();
    if (guard.bought) onPurchaseSelect("unknown");
    onRemove();
  };

  /**
   * 卡片底部动作区（任务 220 / Task #373 去锁定钮）：购票状态下拉 + 飞猪主按钮；
   * 分享钮 Task #225 起隐藏（Task #205 分享功能落地后随 onShare 恢复），
   * 与酒店卡共用 CardActions；文案全部由前端字典查表（AI 不产出按钮文案）。
   * 普通卡作为 .item 的直接子节点落在整行底部（grid-area: acts）；
   * 父卡放在 .parent-foot 内右对齐——三类卡片的橙按钮右缘同一条垂线。
   */
  const cardActions = selectMode ? null : (
    <CardActions
      type="poi"
      commerce={freeAdmission ? "free" : jumpUrl !== null ? "fliggy" : "unknown"}
      status={visit.purchaseState}
      onStatusChange={onPurchaseSelect}
      onMainAction={jumpUrl !== null ? () => window.open(jumpUrl, "_blank", "noopener") : null}
      /* Task #372：命中介绍入口时主按钮降级为「查看介绍」（浅橙），点击开应用内浮层而非跳外链；
         「购」下拉渲染条件不受影响（标记无需购票/已购的唯一入口，保留） */
      onIntro={showIntro ? () => setIntroOpen(true) : undefined}
      /* Task #356（PD DEMO v0.6 转化行）：MOCK 退票话术与按钮同行居左——
         仅白名单景点（西岛/蜈支洲岛，lib/refundAssurance 单点）展示，
         无真实退改逻辑支撑，接入真实逻辑时替换该 lib */
      leading={
        showRefundAssurance(name) ? (
          <span className="buy-assure">✓ {REFUND_ASSURANCE_TEXT}</span>
        ) : null
      }
    />
  );

  /** 普通卡右上角操作列：只剩移除 ✕（锁定/购票入口已下沉到卡片右下） */
  const actionButtons = selectMode ? null : (
    <div className="iact">
      <button type="button" title="移除（移回候选池）" onClick={handleRemoveClick}>
        ✕
      </button>
    </div>
  );

  /**
   * 混合列表 ↑↓（景点与酒店统一）：列表只有 1 条时不渲染，只留 ×；
   * 首条隐藏 ↑、末条隐藏 ↓（不展示灰色禁用态）。
   */
  const moveButtons =
    selectMode || total <= 1 ? null : (
      <div className="imove">
        {index > 0 ? (
          <button type="button" title="上移" onClick={() => onMoveItem(index, index - 1)}>
            ↑
          </button>
        ) : null}
        {index < total - 1 ? (
          <button type="button" title="下移" onClick={() => onMoveItem(index, index + 1)}>
            ↓
          </button>
        ) : null}
      </div>
    );

  return (
    <div
      ref={setNodeRef}
      className="row"
      style={dragStyle}
      data-dragging={isDragging ? "true" : undefined}
      data-selected={selectMode && selected ? "true" : undefined}
      onClick={selectMode ? onToggleSelect : undefined}
      {...surfaceListeners}
    >
      {/* Task #346：视觉隐藏但可聚焦的键盘拖拽把手（承载 dnd-kit attributes + KeyboardSensor 的
          onKeyDown），不静默丢掉键盘可达性；聚焦时卡片描边见 styles.css .drag-kbd 规则 */}
      {!selectMode ? (
        <button
          type="button"
          className="drag-kbd"
          aria-label={`拖动调整顺序：${name}`}
          {...attributes}
          onKeyDown={listeners?.onKeyDown as KeyboardEventHandler<HTMLButtonElement> | undefined}
        />
      ) : null}
      {legText !== null ? (
        <div className="transport">
          <span className="ln" aria-hidden="true" />
          {isFirst ? `从住处出发 · ${legText}` : legText}
        </div>
      ) : null}

      {/* Task #348（PD 2026-11-04）：父卡形态由岛内子玩法驱动，非 kind。
          large_attraction 但 0 子玩法的空壳（鹿回头类）自动走普通卡分支 */}
      {isParentCardVisit(visit) ? (
        <div className={`item parent-item${selectMode ? " selecting" : ""}`}>
          {selectMode ? (
            <span className={`pick${selected ? " on" : ""}`} aria-hidden="true">
              <span className="pick-dot">{selected ? "✓" : ""}</span>
            </span>
          ) : null}
          <div className="parent-card">
            {/* 老版视觉恢复 + 任务 128：卡片顶部横版大照片（宽铺满内容区、高 154px，
                cover 不变形；圆角由 .parent-card overflow hidden 裁出；无图/加载失败
                渲染统一占位填充同一窗口，尺寸稳定不跳动） */}
            <div className="parent-banner">
              {pointImage.kind === "fliggy" ? (
                <img
                  src={pointImage.src}
                  alt={name}
                  loading="lazy"
                  onError={() => setFliggyImgFailed(true)}
                />
              ) : pointImage.kind === "guide" ? (
                <img
                  src={`/api/${pointImage.assetPath}`}
                  alt={name}
                  loading="lazy"
                  title="攻略原图（原文页码关联）"
                  onError={() => setGuideImgFailed(true)}
                />
              ) : (
                <ImagePlaceholder
                  name={name}
                  category={item?.category ?? null}
                  isLargeAttraction
                />
              )}
            </div>
            {/* 新版头部：标题/标签/副文本横向布局（☰ 在外层 .item 手柄列，✕ 在标题行右侧） */}
            <div className="parent-top">
              <div className="parent-main">
                <div className="parent-title">
                  <span className="parent-name">{name}</span>
                  {!selectMode ? (
                    <button
                      type="button"
                      className="parent-close"
                      title="移除（移回候选池）"
                      onClick={handleRemoveClick}
                    >
                      ✕
                    </button>
                  ) : null}
                </div>
                {/* Task #356（PD DEMO v0.6 Z2 徽章行）：4A/5A 徽标移出本行与榜单 chip 同行；
                    clay mode 标签与免票标签均无时整行不渲染（不留空白行） */}
                {parentModeLabel !== "" || freeAdmission ? (
                  <div className="parent-tags">
                    {/* Task #346（PD 2026-11-04 决策，反转 #344 口径）：去掉「大景区」字样——
                        clay 标签只渲染 mode 段：full_day 空串→整枚不渲染；
                        half_day / custom 只显「半天」/「自定义」 */}
                    {parentModeLabel !== "" ? <span className="tag clay">{parentModeLabel}</span> : null}
                    {/* Task #329：免费场所父卡同口径展示「免票」标签 */}
                    {freeAdmission ? <span className="tag slate">免票</span> : null}
                  </div>
                ) : null}
                {/* Task #356（PD DEMO v0.6 Z2）：等级徽标 + 榜单 chip 同行（gap 6px），
                    双信号均缺失时整行收起（:empty） */}
                <div className="badge-row">
                  <PoiLevelTag level={poiLevel} />
                  <PoiRankChip rank={listRank} />
                </div>
                {/* 底部信息行：左侧时长摘要 + 右侧操作区（锁定/购票状态/飞猪入口），
                    与酒店卡 .hfoot 的左右分布及控件顺序完全一致。
                    Task #350（PD 2026-11-04）：永久去除「岛内 X 个点」点位计数文案——与
                    #344 去「全天」标签、#340 隐藏「约 X 小时」同属展示精简线；岛内子玩法列表
                    本身照常渲染，数据字段（childStopRefs / kind）不变。左侧仅保留受
                    SHOW_ESTIMATED_TIMES 门控的时长段：开关关闭（生产默认）时 durationLabel=null，
                    整个 parent-sub 不渲染，parent-foot 仅在有操作区时出现，不留孤立「·」分隔符。 */}
                {durationLabel !== null || cardActions !== null ? (
                  <div className="parent-foot">
                    {durationLabel !== null ? (
                      <span className="parent-sub">约 {durationLabel}</span>
                    ) : null}
                    {cardActions}
                  </div>
                ) : null}
              </div>
            </div>
            {/* Task #356（PD DEMO v0.5）：介绍折叠区移除渲染（页面文字太多）；
                description 数据字段保留不动，仅去除展示层消费（可逆） */}
            {/* 验收问题修复：高置信度待定玩法的父卡确认入口——升级为大景区后，
                岛内玩法还躺在待定区时在这里一次性归入（批量 transfer，全有或全无） */}
            {!selectMode && suggestedChildStops.length > 0 ? (
              <div className="adopt-hint" role="status">
                <span className="adopt-hint-text">
                  有 {suggestedChildStops.length} 个推荐玩法待确认
                  <span className="adopt-hint-names">
                    {suggestedChildStops
                      .slice(0, 3)
                      .map((stop) => stopDisplayName(trip, stop))
                      .join("、")}
                    {suggestedChildStops.length > 3 ? " 等" : ""}
                  </span>
                </span>
                {onAdoptSuggestedStops !== undefined ? (
                  <button
                    type="button"
                    className="adopt-hint-btn"
                    title="把这些高置信度推荐玩法归入岛内小行程"
                    onClick={() => onAdoptSuggestedStops(visit.visitId)}
                  >
                    一键采纳
                  </button>
                ) : null}
              </div>
            ) : null}
            {/* Module C 攻略亮点：多 snippet 合并为单条引用块 + 原文弱入口（Task #342：相似簇只引代表条 + 诚实标注） */}
            {!selectMode && snippetClusters.length > 0 ? (
              <div className="guide-quote">
                <span className="guide-quote-text">
                  "{snippetClusters
                    .map((cluster) => {
                      const note = clusterInlineNote(cluster);
                      return note !== null ? `${cluster.representative.text}${note}` : cluster.representative.text;
                    })
                    .join("；")}"
                </span>
                {sourceLinks.length > 0 ? (
                  <SourceLinkEntry
                    links={sourceLinks}
                    className="guide-quote-link"
                    label="查看攻略原文"
                  />
                ) : (
                  <button
                    type="button"
                    className="guide-quote-link"
                    onClick={() =>
                      setSnippetFocus({
                        open: true,
                        ref: snippetClusters[0]?.representative.sourceMentionRefs[0] ?? null,
                      })
                    }
                  >
                    查看攻略原文
                  </button>
                )}
              </div>
            ) : null}
            {/* Task #412：无自身亮点证据的父卡不渲染兜底原文入口（源链接可能全部来自内部玩法） */}
            {!selectMode && snippetClusters.length === 0 && sourceLinks.length > 0 && parentOwnEvidence ? (
              <SourceLinkEntry
                links={sourceLinks}
                className="evidence-link"
                label="查看攻略原文 ›"
              />
            ) : null}
            {/* Task #190 实用参考主题卡：父卡在引用块之后、岛内小行程之前 */}
            {!selectMode && optionGroups.length > 0 ? (
              <div className="option-groups">
                {optionGroups.map((group) => (
                  <OptionGroupCard
                    key={group.groupId}
                    group={group}
                    onOpenEvidence={() =>
                      setSnippetFocus({ open: true, ref: optionGroupFocusRef(group) })
                    }
                  />
                ))}
              </div>
            ) : null}
            {/* 任务 176：大景点没有任何实际内部 child stop（childStopRefs 为空或悬空）时
                整块不渲染（标题 / 容器 / 空态引导都不要）；备选玩法是独立区域，
                alternate 不计入已排内部行程；有内部玩法时保持原有渲染 */}
            {childStops.length > 0 ? (
              <>
                <div className="child-head">
                  <b>岛内小行程</b>
                  <span>内部顺序 · 不重复计算城市交通</span>
                </div>
                <div className="child-list">
                  {childStops.map((stop, index) => (
                    <StopRow
                      key={stop.stopId}
                      trip={trip}
                      stop={stop}
                      index={index}
                      total={childStops.length}
                      timeRange={childTimeRanges[index] ?? null}
                      onMove={(fromIndex, toIndex) => onMoveStop(fromIndex, toIndex)}
                      onRemove={() => onRemoveStop(stop.stopId)}
                    />
                  ))}
                </div>
              </>
            ) : null}
            {alternateStops.length > 0 ? (
              <div className="reserve-block">
                <button
                  type="button"
                  className="reserve-toggle"
                  aria-expanded={reserveOpen}
                  onClick={() => setReserveOpen((prev) => !prev)}
                >
                  <span>备选玩法 {alternateStops.length} 项</span>
                  <span className="reserve-arrow">{reserveOpen ? "收起" : "查看"}</span>
                </button>
                {reserveOpen ? (
                  <div className="reserve-list">
                    {alternateStops.map((stop) => {
                      // 建议时长未知时不显示时长片段，票务关系独立成句；
                      // Task #343（leader 转 PD 拍板，#341 顺带）：估算时间开关关闭时备选区「建议 X」chip 同口径隐藏
                      const stopSuggest = SHOW_ESTIMATED_TIMES ? suggestDurationLabel(stop.suggestMinutes) : null;
                      const metaParts = [
                        stopSuggest !== null ? `建议 ${stopSuggest}` : null,
                        stop.ticketRelation === "separate" ? "需另购票" : null,
                      ].filter((part): part is string => part !== null);
                      return (
                        <div className="reserve-item" key={stop.stopId}>
                          <div className="reserve-info">
                            <div className="reserve-name">{stopDisplayName(trip, stop)}</div>
                            {metaParts.length > 0 ? (
                              <div className="reserve-meta">{metaParts.join(" · ")}</div>
                            ) : null}
                          </div>
                          <button
                            type="button"
                            className="mini"
                            disabled={selectMode}
                            onClick={() => onRestoreStop(stop.stopId)}
                          >
                            放回
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className={`item${selectMode ? " selecting" : ""}`}>
          {selectMode ? (
            <span className={`pick${selected ? " on" : ""}`} aria-hidden="true">
              <span className="pick-dot">{selected ? "✓" : ""}</span>
            </span>
          ) : null}
          <div className="thumb">
            {/* thumb-frame：Task #364 D 档媒体盒 height:100% + min 120 + max 160（图高随内容行数区间浮动）+ cover，
                窗口与标题同顶（.thumb flex-start，#347 列内居中废弃）；卡总高仍由内容行数自然浮动。
                任务 128：无图/加载失败时渲染统一占位填满同一窗口，布局零跳动 */}
            {pointImage.kind === "fliggy" ? (
              <div className="thumb-frame">
                <img
                  src={pointImage.src}
                  alt={name}
                  loading="lazy"
                  onError={() => setFliggyImgFailed(true)}
                />
                <span className="photo-note">飞猪实图</span>
              </div>
            ) : pointImage.kind === "guide" ? (
              <div className="thumb-frame">
                <img
                  src={`/api/${pointImage.assetPath}`}
                  alt={name}
                  loading="lazy"
                  onError={() => setGuideImgFailed(true)}
                />
                <span className="photo-note">攻略原图</span>
              </div>
            ) : (
              <ImagePlaceholder name={name} category={item?.category ?? null} />
            )}
          </div>
          <div className="ibody">
            <div className="nm">
              <span className="t">{name}</span>
              {item?.origin === "custom" ? <span className="tag">自定义</span> : null}
              {/* Task #329：免费场所展示「免票」标签，与购票按钮降级配套 */}
              {freeAdmission ? <span className="tag slate">免票</span> : null}
              {aiSupplement ? (
                <span className="tag ai-supplement-chip" title={AI_SUPPLEMENT_VERIFY_NOTE}>
                  {AI_SUPPLEMENT_CHIP_LABEL_COMPACT}
                  <span className="chip-verify">{aiSupplementVerifyPart}</span>
                </span>
              ) : null}
            </div>
            {/* Task #356（PD DEMO v0.6 Z2 徽章行）：4A/5A 徽标移出名称行，与榜单 chip
                同行（gap 6px）；双信号均缺失时整行收起（:empty） */}
            <div className="badge-row">
              <PoiLevelTag level={poiLevel} />
              <PoiRankChip rank={listRank} />
            </div>
            <div className="addr">{addrText}</div>
            {/* C4：核验说明——宽屏 chip 已含「·飞猪核验」，本行隐藏；≤360px chip 降级后本行显示 */}
            {aiSupplement ? <div className="ai-supplement-note">{AI_SUPPLEMENT_VERIFY_NOTE}</div> : null}
            {/* Task #358（PD 2026-11-10）：去除平台分类标签 chip（「山湖田园」/「沙滩海岛」类，
                来源 FlyAI 归一化 item.category）——PD 反馈意义不大；数据字段 item.category
                保留不动（server/shared 仍消费），仅移除渲染节点；容器 .meta 本就条件渲染，
                整块删除后不留空白行。候选池/添加面板/酒店等其余出口不改。 */}
            {!selectMode && snippetClusters.length > 0 ? (
              <div className="guide-snippets">
                {snippetClusters.map((cluster) => {
                  const snippet = cluster.representative;
                  const note = snippetClusterNote(cluster);
                  return (
                    <button
                      key={snippet.snippetId}
                      type="button"
                      className="guide-snippet-chip"
                      title="点击查看攻略原文依据"
                      onClick={() =>
                        setSnippetFocus({ open: true, ref: snippet.sourceMentionRefs[0] ?? null })
                      }
                    >
                      <span className="guide-snippet-text">{snippet.text}</span>
                      {note !== null ? <span className="guide-snippet-note">（{note}）</span> : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {!selectMode && sourceLinks.length > 0 ? (
              <SourceLinkEntry
                links={sourceLinks}
                className="evidence-link"
                label="查看攻略原文 ›"
              />
            ) : null}
            {/* Task #190 实用参考主题卡：普通卡在 chips 之后、原文弱入口之后 */}
            {!selectMode && optionGroups.length > 0 ? (
              <div className="option-groups">
                {optionGroups.map((group) => (
                  <OptionGroupCard
                    key={group.groupId}
                    group={group}
                    onOpenEvidence={() =>
                      setSnippetFocus({ open: true, ref: optionGroupFocusRef(group) })
                    }
                  />
                ))}
              </div>
            ) : null}
            {/* Task #356（PD DEMO v0.5）：介绍折叠区移除渲染（页面文字太多）；
                description 数据字段保留不动，仅去除展示层消费（可逆） */}
            {/* Task #340：估算开始时间 + 「估算」来源徽标 + 建议时长均为 AI 推导，
                开关关闭时整行不渲染（代码保留，SHOW_ESTIMATED_TIMES=true 即恢复） */}
            {SHOW_ESTIMATED_TIMES ? (
              <div className="prodrow">
                <div className="schedule">
                  <span className={`st ${visit.startTimeOverridden ? "override" : ""}`}>
                    {visit.startTime ?? "--:--"}
                  </span>
                  <span className="est">估算</span>
                  {suggestLabel !== null ? <span className="du">建议 {suggestLabel}</span> : null}
                </div>
              </div>
            ) : null}
            {!selectMode && canClassifyIntoParent ? (
              <button
                type="button"
                className="classify-entry"
                title="把这个景点归入某个大景点，作为它的内部玩法"
                onClick={() => onClassifyIntoParent?.(visit.visitId)}
              >
                归入大景点
              </button>
            ) : null}
          </div>
          {cardActions}
          {actionButtons}
          {moveButtons}
        </div>
      )}

      {removeGuard !== null ? (
        <ConfirmDialog
          title={
            removeGuard.locked && removeGuard.bought
              ? "已锁定且已购票，不能直接移除"
              : removeGuard.locked
                ? "已锁定，不能直接移除"
                : "已购票，不能直接移除"
          }
          description={
            removeGuard.locked && removeGuard.bought
              ? `「${name}」同时处于已锁定与已购票状态。可先解锁并把购票状态改为「未确定」，再移出当天（移出仅解除规划，不会取消真实订单）。`
              : removeGuard.locked
                ? `「${name}」已锁定为已定项。可先解锁再移出当天；解锁与移出都会保留可撤销记录。`
                : `「${name}」已标记为已购票。可先把购票状态改为「未确定」再移出当天（仅解除规划，不会取消真实订单）。`
          }
          confirmText={
            removeGuard.locked && removeGuard.bought
              ? "先处理并移出"
              : removeGuard.locked
                ? "解锁并移出"
                : "改为未确定并移出"
          }
          danger
          onConfirm={confirmRemoveGuard}
          onCancel={() => setRemoveGuard(null)}
        />
      ) : null}

      {/* B4 攻略提示证据回看：EvidenceSheet 内部 portal 到 .app，不受卡片定位/裁剪限制 */}
      {snippetFocus.open ? (
        <EvidenceSheet
          trip={trip}
          visit={visit}
          focusMentionRef={snippetFocus.ref}
          onClose={() => setSnippetFocus({ open: false, ref: null })}
        />
      ) : null}

      {/* Task #372 景点介绍浮层：内部 portal 到 .app，紧邻 EvidenceSheet 挂载点；
          introText 命中时恒非 null（shouldShowIntroEntry 已守卫），双重判空防 TS null */}
      {introOpen && introText !== null ? (
        <PoiIntroSheet
          name={name}
          text={introText}
          origin={item?.origin ?? null}
          onClose={() => setIntroOpen(false)}
        />
      ) : null}
    </div>
  );
}
