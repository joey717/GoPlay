import type { Ref } from "react";

interface PurchaseToggleProps {
  /** 按钮文案（由 CardActions 的状态字典查出：未确定「购」/「订」，已选态为状态文案） */
  label: string;
  /** 未选择状态（unknown）：文案是简写，视觉上加下箭头提示可展开 */
  pending?: boolean;
  /** 悬停提示：景点「点击选择购票状态」，酒店「点击选择预订状态」 */
  menuTitle: string;
  /** 菜单定位基准 */
  buttonRef?: Ref<HTMLButtonElement>;
  /** 点击展开购票/预订状态菜单（菜单本体由 CardActions 渲染） */
  onOpenMenu: () => void;
}

/**
 * 购票/预订状态入口（任务 220 收窄为定宽灰短按钮）：
 * - 定宽 60px、高 32px，所有状态都是同一档灰底（不再是三色药丸）；
 * - 未确定显示简写「购」/「订」，已选态显示对应字典文案；
 * - 点击弹出菜单明确选择，不再循环切换。
 * 文案字典与菜单项统一由 CardActions 提供，景点与酒店不混用。
 */
export default function PurchaseToggle({
  label,
  pending = false,
  menuTitle,
  buttonRef,
  onOpenMenu,
}: PurchaseToggleProps) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`act-status${pending ? " pending" : ""}`}
      title={menuTitle}
      aria-haspopup="menu"
      onClick={onOpenMenu}
    >
      <span className="act-status-label">{label}</span>
    </button>
  );
}
