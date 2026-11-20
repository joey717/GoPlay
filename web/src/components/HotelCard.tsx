import { useState, type HTMLAttributes } from "react";
import type { HotelCandidate, LodgingPlan } from "@goplay/shared";
import CardActions from "./CardActions";

interface HotelCardProps {
  hotel: HotelCandidate;
  /** 在「当天景点 + 酒店混合列表」中的下标（0-based；↑↓ 隐藏边界用） */
  index?: number;
  /** 当天混合列表条目总数；≤1 时不渲染 ↑↓（只保留 ×） */
  total?: number;
  /** 当天酒店候选数（>1 时显示「当前选定 / 候选」标签；与混合列表长度无关） */
  candidateTotal?: number;
  /** 是否当前选定（hotelRefs 首位展示位）；多候选时标签区分 */
  primary?: boolean;
  /** 混合列表内改序（仅上移/下移；与 StopRow 同为触控可靠的最小排序） */
  onMove?: (fromIndex: number, toIndex: number) => void;
  /** 移出住宿规划：仅解除引用（酒店主数据保留），不触发真实订单取消 */
  onRemove?: () => void;
  /** @dnd-kit 键盘拖拽把手透传（attributes + onKeyDown；不传则不渲染 sr-only 把手） */
  dragKeyboardProps?: Record<string, unknown> | null;
  /** 当天住宿计划的预订状态（同一 LodgingPlan 由当天所有候选卡共享） */
  purchaseState?: LodgingPlan["purchaseState"];
  /** 当天住宿计划是否已锁定（Task #373 后不再渲染锁定钮，保留 prop 兼容调用方） */
  locked?: boolean;
  /** 预订状态三档选择（不传则不渲染状态标签与菜单） */
  onPurchaseSelect?: (state: LodgingPlan["purchaseState"]) => void;
  /** 锁定切换（Task #373 后不再渲染锁定钮，保留 prop 兼容调用方） */
  onToggleLock?: () => void;
}

/**
 * 酒店卡片（视觉对齐 DEMO 的 .hotelcard）：左图 + 名称/地址/星级/参考价 + 飞猪订房按钮。
 * 传入 onMove/onRemove 时渲染排序控件（按钮风格与 StopRow .child-buttons 一致）：
 * 多候选（total > 1）时显示 ↑ ↓ ×；仅 1 个候选时 ↑↓ 无可排序对象，隐藏只留 ×
 * （不呈灰禁用态）；传入 dragKeyboardProps 时渲染 sr-only 键盘拖拽把手
 * （Task #346：把手列移除，鼠标/触摸拖拽面在整卡行容器，键盘路径由此按钮承载）。
 *
 * 任务 220 预订状态管理（与景点卡同一套交互）：
 * - 底部一行 CardActions：状态下拉（定宽 60）+ 飞猪主按钮（定宽 128），
 *   整行贴卡片底部右对齐，橙按钮右缘与景点卡同一条垂线（Task #373 去锁定钮）；
 * - 状态入口：未确定「订」，已选态为「现场订 / 已订房」；
 * - 订房按钮文案分流：bought → 「查看详情」（浅橙降级），其余 → 「去订房」，
 *   文案由 CardActions 字典查表，酒店与景点不混用。
 */
export default function HotelCard({
  hotel,
  index = 0,
  total = 1,
  candidateTotal = 1,
  primary = false,
  onMove,
  onRemove,
  dragKeyboardProps,
  purchaseState = "unknown",
  onPurchaseSelect,
}: HotelCardProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const metaText = [hotel.star, hotel.interestsPoi].filter(Boolean).join(" · ");
  const detailUrl = hotel.detailUrl;
  const sortable = onMove !== undefined;

  /**
   * 底部动作区（任务 220）：与景点卡共用 CardActions；事件缺失时不渲染对应按钮。
   * 作为 .hotelcard 的最后一个直接子节点整行换行（flex 100%），贴卡片底部右对齐。
   */
  const actions = (
    <CardActions
      type="hotel"
      status={purchaseState}
      /* 住宿字典只有 3 档：CardActions 的菜单项共用景点四态类型，这里过滤 noTicket */
      onStatusChange={
        onPurchaseSelect
          ? (state) => {
              if (state !== "noTicket") onPurchaseSelect(state);
            }
          : undefined
      }
      onMainAction={detailUrl ? () => window.open(detailUrl, "_blank", "noopener") : null}
    />
  );

  return (
    <>
      <div className="hotelcard">
        {dragKeyboardProps ? (
          <button
            type="button"
            className="drag-kbd"
            aria-label={`拖动调整顺序：${hotel.name}`}
            {...(dragKeyboardProps as HTMLAttributes<HTMLButtonElement>)}
          />
        ) : null}
        <div className="hotelphoto">
          {hotel.mainPic && !imgFailed ? (
            <img src={hotel.mainPic} alt={hotel.name} loading="lazy" onError={() => setImgFailed(true)} />
          ) : null}
        </div>
        <div className="hotelbody">
          <div className="hn">{hotel.name}</div>
          <div className="ha">{hotel.address ?? "地址待飞猪数据补全"}</div>
          <div className="hm">
            <span className="hm-tags">
              <span className="tag">住宿</span>
              {sortable && candidateTotal > 1 ? (
                primary ? (
                  <span className="tag sage">当前选定</span>
                ) : (
                  <span className="tag">候选</span>
                )
              ) : null}
              {metaText ? (
                <span className="tag">{metaText}</span>
              ) : (
                <span className="tag">酒店信息</span>
              )}
            </span>
            {hotel.priceText ? <span className="hp">{hotel.priceText}</span> : null}
          </div>
          <div className="hfoot">
            <span className="hnote">{hotel.priceBasis}</span>
          </div>
        </div>
        {sortable && onRemove ? (
          <div className="hcard-btns">
            {/* 混合列表只有 1 条时隐藏 ↑↓（不再渲染灰色禁用态），只保留 ×；
                首条隐藏 ↑，末条隐藏 ↓ */}
            {total > 1 && index > 0 ? (
              <button type="button" title="上移" onClick={() => onMove?.(index, index - 1)}>
                ↑
              </button>
            ) : null}
            {total > 1 && index < total - 1 ? (
              <button type="button" title="下移" onClick={() => onMove?.(index, index + 1)}>
                ↓
              </button>
            ) : null}
            <button type="button" title="移出住宿规划（酒店信息保留）" onClick={onRemove}>
              ×
            </button>
          </div>
        ) : null}
        {actions}
      </div>
    </>
  );
}
