import { useMemo, useState } from "react";
import type { Stop, Trip } from "@goplay/shared";
import {
  clusterSimilarSnippets,
  GUIDE_SNIPPET_DISPLAY_LIMIT,
  isFreeAdmissionItem,
  itemListRank,
  itemPoiLevelLabel,
  snippetClusterNote,
} from "@goplay/shared";
import { suggestDurationLabel } from "../lib/format";
import { SHOW_ESTIMATED_TIMES } from "../lib/displayFlags";
import { resolveEntityPageImages } from "../lib/entityImages";
import { resolvePointImage } from "../lib/pointImage";
import { resolveEntitySourceLinks } from "../lib/sourceLinks";
import { addressText, stopDisplayName } from "../lib/trip";
import EvidenceSheet from "./EvidenceSheet";
import ImagePlaceholder from "./ImagePlaceholder";
import { PoiLevelTag, PoiRankChip } from "./PoiMeta";
import SourceLinkEntry from "./SourceLinkEntry";

interface StopRowProps {
  trip: Trip;
  stop: Stop;
  /** 在父 Visit childStopRefs 中的下标（0-based，用于序号与上移/下移） */
  index: number;
  total: number;
  /** Module C：父 Visit 推算的起止时间（从 startTime 按建议时长顺排）；null = 无法推算 */
  timeRange: { start: string; end: string } | null;
  /** 父内改序（仅上移/下移；触控可用的最小可靠排序） */
  onMove: (fromIndex: number, toIndex: number) => void;
  /** 移入父 Visit 的备选玩法（5 秒撤销窗口由上层管理） */
  onRemove: () => void;
}

/**
 * 大景区内部玩法行（PRD §7.5 · Module C 视觉）：56×56 小方图
 * （老版图片视觉恢复 + 任务 113 放大：有飞猪主图显示图片，无图/加载失败回退
 * 任务 128 统一占位——低饱和渐变 + 类别单字 + 精简短名；
 * 编号圆点与纵向连线已按用户要求去除，顺序仅靠 ↑↓ 表达）
 * + 名称（命中飞猪时链到详情页）+ 时间行（推算区间或「建议 X」+ 票务/自定义标签）
 * + 地址（飞猪原始地址优先，见 addressText）
 * + 攻略提示 chips（B4：≤2 条，点击打开证据面板定位原文提及）
 * +「查看攻略原文」外链入口（任务 124：只打开用户导入的外部原链，来源按本
 *   玩法自身解析，不合并父 Visit；单源直开、多源极简列表、无链接隐藏）
 * + 上移/下移/移入备选按钮（与 HotelCard 同规则：多玩法时显示 ↑↓×，
 * 仅 1 个玩法时 ↑↓ 隐藏只留 ×）。
 * v1.1 约定：内部玩法没有购买/锁定/跨天/设时间入口。
 */
export default function StopRow({
  trip,
  stop,
  index,
  total,
  timeRange,
  onMove,
  onRemove,
}: StopRowProps) {
  /** B4 攻略提示回看：open 时打开内部 EvidenceSheet；ref 为定位提及（可空） */
  const [snippetFocus, setSnippetFocus] = useState<{ open: boolean; ref: string | null }>({
    open: false,
    ref: null,
  });
  /** Task #296：图片加载失败按来源分别记账（飞猪外链失败仍可降级 PX 图，PX 失败才落占位） */
  const [fliggyPicFailed, setFliggyPicFailed] = useState(false);
  const [guidePicFailed, setGuidePicFailed] = useState(false);
  const isCustom = stop.matchedPointRef === null;
  // 任务 124：外部原链入口按本玩法自身范围解析（Stop 不合并父 Visit）；
  // 无外部链接（text / images 来源）时入口隐藏，不再降级打开 EvidenceSheet
  const sourceLinks = resolveEntitySourceLinks(trip, stop, undefined);
  /**
   * Task #342 展示层聚类：同一条建议的相似改写卡内只展示 1 条 chip + 诚实标注
   * （Task #352 处/篇规则：每篇恰好提及一次且 ≥2 篇 →「N篇攻略提及」，
   * 其余按总提及次数 →「N处攻略提及」，总提及 ≤1 不标注）；
   * 数据与攻略原文 sheet（EvidenceSheet）仍逐条全量展示，信息不丢。
   * 先对全量聚类再取前 GUIDE_SNIPPET_DISPLAY_LIMIT 簇（与原 slice 条数上限一致）。
   */
  const snippetClusters = useMemo(
    () => clusterSimilarSnippets(stop.guideSnippets ?? [], trip).slice(0, GUIDE_SNIPPET_DISPLAY_LIMIT),
    [stop, trip],
  );
  // 命中飞猪的内部玩法：取主数据详情链接与 56×56 小方图（老版图片视觉恢复）；custom 时为空
  const item = stop.matchedPointRef !== null ? trip.itemRegistry[stop.matchedPointRef] : undefined;
  const jumpUrl = item?.jumpUrl ?? null;
  // 任务 196 + Task #296 配图优先级：飞猪图（origin=fliggy 且 mainPic 非空）优先；
  // 无飞猪图（custom 或飞猪记录无图，不再要求 isCustom）才回退攻略 PX 页码关联首图；
  // 两者皆无 / 加载失败降级完毕沿用统一占位兜底（不猜测相邻/最接近的图）
  const pageImages = useMemo(() => resolveEntityPageImages(trip, stop, undefined), [trip, stop]);
  const pointImage = resolvePointImage(item ?? null, pageImages.firstAssetPath, {
    fliggyFailed: fliggyPicFailed,
    guideFailed: guidePicFailed,
  });
  const name = stopDisplayName(trip, stop);
  // 建议时长未知（待定）时不渲染「建议 …」，避免出现无信息量的「建议 待定」
  const suggestLabel = suggestDurationLabel(stop.suggestMinutes);
  // Module C 时间行：推算区间优先；无法推算时回退「建议 X」，都没有则不渲染时间文字。
  // Task #340：推算区间与建议时长均为 AI 推导，估算时间开关关闭时一律不渲染（代码保留可恢复）
  const timeLabel = !SHOW_ESTIMATED_TIMES
    ? null
    : timeRange !== null
      ? `${timeRange.start}–${timeRange.end}`
      : suggestLabel !== null
        ? `建议 ${suggestLabel}`
        : null;

  // Task #77 地址展示：命中飞猪的玩法经 matchedPointRef 取飞猪原始地址优先展示；
  // 无飞猪地址时回退 AI 提取的位置描述（locationHint）并声明来源；都无则如实提示。
  // 「自定义点位」仅是时间行标签，不进入地址文案。
  const fliggyAddress = item !== undefined && item.origin === "fliggy" ? item.address : null;
  const addrText = addressText(fliggyAddress, stop.locationHint);
  /**
   * Task #329：免费场所（freePoiStatus=FREE 或 category 购物类兜底，单一数据源
   * shared/freePoi.ts）——岛内玩法行展示「免票」标签；名称链接（child-link）
   * 本就是弱入口无购票语义，保留不动。
   */
  const freeAdmission = isFreeAdmissionItem(item);
  // Task #330：飞猪景点等级（归一化 4A/5A，无法识别为 null）与榜单文案（读时默认，缺失为 null）
  const poiLevelLabel = itemPoiLevelLabel(item);
  const listRank = itemListRank(item);
  // 时间行是否需要渲染（时间文字或任一标签存在时；#330 等级徽标也需占位）
  const showTimeRow =
    timeLabel !== null ||
    isCustom ||
    freeAdmission ||
    stop.ticketRelation !== "unknown" ||
    poiLevelLabel !== null;

  return (
    <div className="child">
      {/* 任务 113 + 128：编号圆点已去除；56×56 小方图（cover 不变形；
          无图/加载失败回退统一占位，尺寸固定不跳动）；容器不 aria-hidden，
          占位 role=img 的完整名称可被读屏 */}
      <div className="child-pic">
        {pointImage.kind === "fliggy" ? (
          <img
            src={pointImage.src}
            alt=""
            loading="lazy"
            onError={() => setFliggyPicFailed(true)}
          />
        ) : pointImage.kind === "guide" ? (
          <img
            src={`/api/${pointImage.assetPath}`}
            alt=""
            loading="lazy"
            title="攻略原图（原文页码关联）"
            onError={() => setGuidePicFailed(true)}
          />
        ) : (
          <ImagePlaceholder name={name} category={item?.category ?? null} />
        )}
      </div>
      <div className="child-main">
        <div className="child-name">
          {jumpUrl !== null && jumpUrl !== "" ? (
            <a className="child-link" href={jumpUrl} target="_blank" rel="noopener noreferrer">
              {name}
            </a>
          ) : (
            <span>{name}</span>
          )}
        </div>
        {/* Task #330：榜单行（名称下方独立一行暖色 chip，无则完全不占位） */}
        <PoiRankChip rank={listRank} />
        {showTimeRow ? (
          <div className="child-time">
            {timeLabel !== null ? <span className="child-time-text">{timeLabel}</span> : null}
            {/* Task #330：4A/5A 等级徽标（与「自定义/免票」tag 同排同尺寸） */}
            <PoiLevelTag level={poiLevelLabel} />
            {isCustom ? <span className="tag custom-stop">自定义</span> : null}
            {freeAdmission ? <span className="tag slate">免票</span> : null}
            {stop.ticketRelation === "included" ? <span className="tag sage">门票已含</span> : null}
            {stop.ticketRelation === "separate" ? <span className="tag clay">需另购票</span> : null}
          </div>
        ) : null}
        <div className="child-hint">{addrText}</div>
        {snippetClusters.length > 0 ? (
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
        {sourceLinks.length > 0 ? (
          <SourceLinkEntry
            links={sourceLinks}
            className="child-evidence"
            label="查看攻略原文 ›"
          />
        ) : null}
      </div>
      <div className="child-buttons">
        {total > 1 ? (
          <>
            <button
              type="button"
              title="上移"
              disabled={index === 0}
              onClick={() => onMove(index, index - 1)}
            >
              ↑
            </button>
            <button
              type="button"
              title="下移"
              disabled={index === total - 1}
              onClick={() => onMove(index, index + 1)}
            >
              ↓
            </button>
          </>
        ) : null}
        <button type="button" title="移到备选玩法" onClick={onRemove}>
          ×
        </button>
      </div>

      {/* B4 攻略提示证据回看：EvidenceSheet 内部 portal 到 .app（不受 .child 定位限制） */}
      {snippetFocus.open ? (
        <EvidenceSheet
          trip={trip}
          stop={stop}
          focusMentionRef={snippetFocus.ref}
          onClose={() => setSnippetFocus({ open: false, ref: null })}
        />
      ) : null}
    </div>
  );
}
