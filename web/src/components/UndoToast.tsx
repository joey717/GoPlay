interface UndoToastProps {
  /** 撤销提示文案：单项「已将「蜈支洲岛」移回候选池」，批量「已将 3 项移回候选池」 */
  text: string;
  onUndo: () => void;
}

/**
 * 撤销提示条：移除点位后 5 秒窗口内展示（消失由 useTrip 的 undoState 控制），
 * 兼容 M2 F12 批量移除（按数量展示，一次撤销整批恢复）。
 * 固定在底部、避开 IntentBar；点击「撤销」按原顺序恢复。
 */
export default function UndoToast({ text, onUndo }: UndoToastProps) {
  return (
    <div className="undo-toast" role="status">
      <span className="undo-text">{text}</span>
      <button type="button" className="undo-action" onClick={onUndo}>
        撤销
      </button>
    </div>
  );
}
