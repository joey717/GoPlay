/**
 * 通用二次确认弹窗：遮罩 + 居中卡片，点击遮罩或取消按钮触发 onCancel。
 * danger 为 true 时确认按钮呈红色，用于删除等不可逆操作。
 * 样式见 styles.css 的 "通用二次确认弹窗" 区块。
 */
interface ConfirmDialogProps {
  title: string;
  description: string;
  /** 确认按钮文案，默认 "确认" */
  confirmText?: string;
  /** 取消按钮文案，默认 "取消" */
  cancelText?: string;
  /** 为 true 时确认按钮红色（危险操作） */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  description,
  confirmText = "确认",
  cancelText = "取消",
  danger,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <>
      <div className="confirm-overlay" onClick={onCancel} aria-hidden="true" />
      <div className="confirm-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h3 className="confirm-title">{title}</h3>
        <p className="confirm-desc">{description}</p>
        <div className="confirm-actions">
          <button type="button" className="confirm-btn cancel" onClick={onCancel}>
            {cancelText}
          </button>
          <button
            type="button"
            className={`confirm-btn ok${danger ? " danger" : ""}`}
            onClick={onConfirm}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </>
  );
}
