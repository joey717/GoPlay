/**
 * 底部浮层互斥总线（Task #109）：
 * OpLogSheet（近期操作）与 EvidenceSheet（攻略原文）共用 .backdrop/.sheet 层级
 * （z-index 8/9，同以 .app 为包含块）。两者分属不同状态域——OpLog 的开关在
 * TripView，Evidence 的开关分散在 StopRow / VisitCard / DayContent 内部 state，
 * 无法通过 props 直接互斥；曾出现的「攻略原文打开时近期操作 Sheet 叠在底下、
 * 其 × 被上层遮挡无法点击」即两面板同时 on 所致。
 *
 * 约定：任一此类浮层挂载（= 打开）时广播 sheet-opened，其余同类浮层的持有方
 * 收到非自身 kind 的事件后关闭自己，保证任意时刻至多一个可见：
 * - EvidenceSheet 挂载 → 广播 "evidence" → TripView 收到后 setOpLogOpen(false)；
 * - OpLogSheet 挂载 → 广播 "oplog" → EvidenceSheet 收到后调用自身 onClose；
 * - ConstraintEditor 挂载 → 广播 "constraint" → TripView 关闭近期操作，
 *   EvidenceSheet 等收到非自身 kind 时自关（Task #206 约束编辑浮层）。
 * - TripCoverSheet 挂载 → 广播 "cover" → TripView 关闭近期操作 / 约束编辑，
 *   ConstraintEditor 与 EvidenceSheet 收到非自身 kind 时自关（Task #258 行程封面浮层）。
 * - TripChecklist 挂载 → 广播 "checklist" → TripView 关闭近期操作 / 封面 / 约束编辑，
 *   其余浮层收到非自身 kind 时自关（Task #265 待办清单盘点浮层）。
 * - PoiIntroSheet 挂载 → 广播 "poiIntro" → TripView 关闭近期操作 / 封面 / 约束编辑，
 *   EvidenceSheet 等收到非自身 kind 时自关（Task #372 景点介绍应用内浮层）。
 */

export type SheetKind = "oplog" | "evidence" | "constraint" | "cover" | "checklist" | "poiIntro";

const SHEET_OPENED_EVENT = "goplay:sheet-opened";

/** 浮层打开方在挂载后调用：广播「本浮层已打开」，其余浮层应让位关闭 */
export function notifySheetOpened(kind: SheetKind): void {
  window.dispatchEvent(new CustomEvent<SheetKind>(SHEET_OPENED_EVENT, { detail: kind }));
}

/** 订阅浮层打开广播；返回取消订阅函数（供 useEffect 清理）。
 *  handler 会收到包括自身在内的所有打开事件，调用方需按 kind 过滤。 */
export function onSheetOpened(handler: (kind: SheetKind) => void): () => void {
  const listener = (event: Event): void => {
    handler((event as CustomEvent<SheetKind>).detail);
  };
  window.addEventListener(SHEET_OPENED_EVENT, listener);
  return () => window.removeEventListener(SHEET_OPENED_EVENT, listener);
}
