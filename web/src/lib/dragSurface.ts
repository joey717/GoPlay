/**
 * Task #346（PD 2026-11-04：「卡片左侧拖拽的浅灰样式去掉，内容居中；拖拽功能保留」）：
 * 拖拽发起面从 24px 把手列移到整卡行容器。本模块把 useSortable 的 listeners
 * 收敛成「卡片表面」专用的受守卫监听：
 * - 命中 button / a / input / textarea / select / [data-nodrag] 一律不发起拖拽
 *  （卡片内所有按钮、链接、输入控件保持原有点击/聚焦语义）；
 * - 鼠标 mousedown 守卫通过后先转发给 dnd-kit（传感器激活检测
 *   `nativeEvent.defaultPrevented`，必须在此前保持 false），再 preventDefault
 *   阻止原生图片拖拽与浏览器选择手势（与 Trello / Notion 整卡拖拽同款取舍）；
 * - 触摸 touchstart 不 preventDefault：竖向滚动让路给浏览器， TouchSensor 以
 *   {delay: 200, tolerance: 5} 长按激活（pending 期 dnd-kit 不 preventDefault，
 *   激活后 handleMove 对 touchmove preventDefault 阻断滚动——见
 *   @dnd-kit/core AbstractPointerSensor 源码）。
 * 键盘路径不走这里：sr-only 把手按钮单独承载 attributes + onKeyDown（KeyboardSensor）。
 */
import type { MouseEvent as ReactMouseEvent, TouchEvent as ReactTouchEvent } from "react";

/** 拖拽发起守卫排除的交互元素（命中则本次按下不发起拖拽） */
export const DRAG_EXCLUDE_SELECTOR = "button, a, input, textarea, select, [data-nodrag]";

/** dnd-kit useSortable listeners 的最小结构（与库的 SyntheticListenerMap: Record<string, Function> 兼容） */
export type SortableListenerMap = { [key: string]: Function | undefined } | undefined;

export interface DragSurfaceListeners {
  onMouseDown: (event: ReactMouseEvent) => void;
  onTouchStart: (event: ReactTouchEvent) => void;
}

function hitsInteractive(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest(DRAG_EXCLUDE_SELECTOR) !== null;
}

/**
 * 把 dnd-kit listeners 包装成整卡拖拽面监听；listeners 缺失（如批量选择态）返回
 * undefined，调用方直接 `{...undefined}` 展开即可（JSX 展开 undefined 合法）。
 */
export function buildDragSurfaceListeners(
  listeners: SortableListenerMap,
): DragSurfaceListeners | undefined {
  if (!listeners) return undefined;
  // Function → 具体签名：dnd-kit 内部按 sensor 注册 onMouseDown / onTouchStart / onKeyDown
  const onMouseDown = listeners.onMouseDown as ((event: ReactMouseEvent) => void) | undefined;
  const onTouchStart = listeners.onTouchStart as ((event: ReactTouchEvent) => void) | undefined;
  return {
    onMouseDown: (event) => {
      if (hitsInteractive(event.target)) return;
      // 必须先转发给 dnd-kit：传感器激活检测 nativeEvent.defaultPrevented（@dnd-kit/core L3185），
      // 若先 preventDefault 则传感器永远不会启动。转发后再 preventDefault 阻止原生图片拖拽/选择。
      onMouseDown?.(event);
      event.preventDefault();
    },
    onTouchStart: (event) => {
      if (hitsInteractive(event.target)) return;
      onTouchStart?.(event);
    },
  };
}
