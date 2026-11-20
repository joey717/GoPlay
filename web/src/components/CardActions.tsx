import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Visit } from "@goplay/shared";
import PurchaseToggle from "./PurchaseToggle";

/** 卡片类型：景点（普通卡 / 大景区父卡）与酒店卡共用同一套动作区 */
export type CardActionsType = "poi" | "hotel";
/** 售卖渠道：fliggy = 飞猪在售；free = 免票；unknown = 价格未知 */
export type CardCommerce = "fliggy" | "free" | "unknown";

type PurchaseState = Visit["purchaseState"];

/** 景点状态字典（4 态：无需购票 / 现场买 / 已购 / 未确定） */
const POI_STATUS_OPTIONS: Array<{ value: PurchaseState; label: string }> = [
  { value: "noTicket", label: "无需购票" },
  { value: "toBuy", label: "现场买" },
  { value: "bought", label: "已购" },
  { value: "unknown", label: "未确定" },
];

/** 酒店状态字典（3 态：未确定 / 现场订 / 已订房；住宿没有免票档，与景点不混用） */
const HOTEL_STATUS_OPTIONS: Array<{ value: PurchaseState; label: string }> = [
  { value: "unknown", label: "未确定" },
  { value: "toBuy", label: "现场订" },
  { value: "bought", label: "已订房" },
];

/**
 * 主按钮（橙）文案查表：由「类型 × 售卖渠道 × 用户状态 × 是否有介绍入口」决定，最长 4 字（Task #367 去「飞猪」二字）。
 * 判定顺序（Task #372）：hotel 短路 > bought > hasIntro > 原逻辑（commerce free / noTicket / 去购票）。
 * - 景点·飞猪在售·未购 → 去购票；已购 → 查看详情；
 * - hasIntro（Task #372：无购票通道或免费入场且有介绍）→ 「查看介绍」（应用内浮层，浅橙弱入口）；
 * - 景点·免票（Task #329：freePoiStatus=FREE 或 category 购物类兜底）→ 恒为
 *   「查看详情」（弱入口保留 jumpUrl 跳转能力，不呈现任何购票/票价语义）；
 * - 景点·价格未知 → 降级为「查票价」；
 * - 酒店·未订 → 去订房；已订房 → 查看详情。
 * 文案全部在前端字典内，AI 不产出按钮文案。
 */
export function cardMainActionLabel(
  type: CardActionsType,
  status: PurchaseState,
  commerce: CardCommerce = "fliggy",
  hasIntro = false,
): string {
  if (type === "hotel") return status === "bought" ? "查看详情" : "去订房";
  if (status === "bought") return "查看详情";
  if (hasIntro) return "查看介绍";
  if (commerce === "free") return "查看详情";
  if (status === "noTicket" || commerce !== "fliggy") return "查票价";
  return "去购票";
}

/** 降级态（查票价 / 查看详情 / 查看介绍）用浅橙：不是本次的主转化动作 */
export function isDimMainAction(label: string): boolean {
  return label === "查票价" || label === "查看详情" || label === "查看介绍";
}

/**
 * 灰短按钮文案：未确定时显示简写「购」/「订」（仍是下拉入口），
 * 已选态显示当前状态文案（无需购票 / 现场买 / 已购 / 现场订 / 已订房）。
 */
export function cardStatusLabel(type: CardActionsType, status: PurchaseState): string {
  if (status === "unknown") return type === "hotel" ? "订" : "购";
  const options = type === "hotel" ? HOTEL_STATUS_OPTIONS : POI_STATUS_OPTIONS;
  return options.find((option) => option.value === status)?.label ?? (type === "hotel" ? "订" : "购");
}

interface CardActionsProps {
  type: CardActionsType;
  /** 景点售卖渠道；酒店恒为飞猪在售 */
  commerce?: CardCommerce;
  /** 购票（景点四态）/ 订房（酒店三态）状态 */
  status: PurchaseState;

  /** 状态下拉选中后回调（景点 / 酒店各自的字典项）；不传则不渲染状态钮 */
  onStatusChange?: (state: PurchaseState) => void;
  /** 主按钮点击；null = 没有飞猪外链，主按钮整颗不渲染 */
  onMainAction: (() => void) | null;
  /**
   * Task #372：「查看介绍」应用内浮层入口。传入时主按钮文案改「查看介绍」（浅橙弱入口），
   * 点击打开 PoiIntroSheet 而非跳飞猪外链。仅当 shouldShowIntroEntry(item) 为真时由
   * VisitCard 传入（无购票通道或免费入场 + 有介绍文本）。判定顺序在 bought 之后、原逻辑之前，
   * 故 noTicket / commerce free 点位若命中介绍入口同样降级为「查看介绍」；「购」下拉不受影响。
   */
  onIntro?: () => void;
  /** 分享：系统分享 / 复制；resolve 后按钮短暂显示对勾；不传则整颗不渲染
   *  （Task #225：分享功能 Task #205 尚未落地，调用方暂不传入、按钮隐藏） */
  onShare?: () => void | Promise<void>;
  /** Task #356：行首附加内容（按钮组左侧，如景点卡 MOCK 退票话术 .buy-assure，
   *  经 margin-right:auto 占满剩余宽）；不传则动作区与既往完全一致（酒店卡不传） */
  leading?: ReactNode;
}

/**
 * 卡片动作区（任务 220）：景点普通卡 / 大景区父卡 / 酒店卡共用。
 *
 * 布局契约（styles.css `.card-actions`）：
 * `[分享 28px 圆钮（条件位）] [灰短按钮 60px] [橙主按钮 128px]`，
 * 整行贴卡片底部、右对齐到卡片右内缩线——三类卡片的橙按钮右缘完全重合。
 * 宽度全部定死（60 / 128），文案长度差异被宽度吃掉，短文案居中留白。
 * 分享钮仅在传入 onShare 时渲染（Task #205 分享功能落地前恒不渲染）。
 *
 * 状态菜单挂在组件内部：fixed 定位避免被卡片 overflow 裁剪，
 * 位置按状态按钮位置向视口内收敛（与旧实现一致）。
 */
export default function CardActions({
  type,
  commerce = "fliggy",
  status,
  onStatusChange,
  onMainAction,
  onIntro,
  onShare,
  leading = null,
}: CardActionsProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [shared, setShared] = useState(false);
  const statusBtnRef = useRef<HTMLButtonElement | null>(null);
  const sharedTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (sharedTimerRef.current !== null) window.clearTimeout(sharedTimerRef.current);
    },
    [],
  );

  const options = type === "hotel" ? HOTEL_STATUS_OPTIONS : POI_STATUS_OPTIONS;
  const menuTitle = type === "hotel" ? "点击选择预订状态" : "点击选择购票状态";
  const mainLabel = cardMainActionLabel(type, status, commerce, onIntro !== undefined);
  // Task #372：主按钮点击目标——「查看介绍」走应用内浮层（onIntro），其余走原外链（onMainAction）。
  // 主按钮渲染条件 = 该目标非 null：onIntro 命中时即便无 jumpUrl（onMainAction=null）也渲染。
  const mainActionHandler =
    mainLabel === "查看介绍" && onIntro !== undefined ? onIntro : onMainAction;

  /** 打开状态菜单：按按钮位置计算 fixed 定位，向视口内收敛 */
  const openMenu = () => {
    const rect = statusBtnRef.current?.getBoundingClientRect();
    if (rect) {
      const MENU_W = 152;
      const MENU_H = options.length * 44 + 8;
      const left = Math.min(Math.max(8, rect.right - MENU_W), window.innerWidth - MENU_W - 8);
      const top =
        window.innerHeight - rect.bottom >= MENU_H + 12
          ? rect.bottom + 6
          : Math.max(8, rect.top - MENU_H - 6);
      setMenuPos({ top, left });
    }
    setMenuOpen(true);
  };

  const selectStatus = (value: PurchaseState) => {
    setMenuOpen(false);
    onStatusChange?.(value);
  };

  const handleShare = () => {
    Promise.resolve()
      .then(() => onShare?.())
      .then(() => {
        setShared(true);
        if (sharedTimerRef.current !== null) window.clearTimeout(sharedTimerRef.current);
        sharedTimerRef.current = window.setTimeout(() => {
          sharedTimerRef.current = null;
          setShared(false);
        }, 1600);
      })
      .catch(() => {
        /* 用户取消系统分享 / 环境不支持：不提示成功 */
      });
  };

  /* 状态菜单 portal 到 body：卡片自身有 overflow:hidden 且入场动画的 fill 会留下
     transform（形成 fixed 的包含块），否则 fixed 菜单会被卡片裁剪并错位。 */
  const menuLayer = menuOpen
    ? createPortal(
        <>
          <div className="purchase-menu-overlay" onClick={() => setMenuOpen(false)} aria-hidden="true" />
          <div
            className="purchase-menu"
            role="menu"
            aria-label={type === "hotel" ? "选择预订状态" : "选择购票状态"}
            style={{ top: menuPos.top, left: menuPos.left }}
          >
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitem"
                className={`purchase-menu-item${option.value === status ? " active" : ""}`}
                onClick={() => selectStatus(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </>,
        document.body,
      )
    : null;

  return (
    <>
      <div className="card-actions">
        {leading}
        {onShare !== undefined ? (
          <button
            type="button"
            className={`act-share${shared ? " done" : ""}`}
            title={shared ? "已复制到剪贴板" : "分享"}
            aria-label="分享"
            onClick={handleShare}
          >
            {shared ? "✓" : "↗"}
          </button>
        ) : null}
        {onStatusChange ? (
          <PurchaseToggle
            label={cardStatusLabel(type, status)}
            pending={status === "unknown"}
            menuTitle={menuTitle}
            buttonRef={statusBtnRef}
            onOpenMenu={openMenu}
          />
        ) : null}
        {mainActionHandler !== null ? (
          <button
            type="button"
            className={`booklink${isDimMainAction(mainLabel) ? " dim" : ""}`}
            onClick={mainActionHandler}
          >
            {mainLabel}
          </button>
        ) : null}
      </div>

      {menuLayer}
    </>
  );
}
