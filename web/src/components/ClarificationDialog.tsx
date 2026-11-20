/**
 * Task #282：稀疏攻略澄清对话框（C1/C2/C3 参赛必须）。
 *
 * 当服务端检测到攻略素材覆盖缺口时返回 clarification 响应，前端弹出此对话框
 * 让用户选择排程范围（A：只排攻略涉及的天；B：允许 AI 补充排满剩余天）。
 * 用户选择后带 clarificationAnswer 重发 draft 请求。
 *
 * 视觉沿用项目 ConfirmDialog 体系（遮罩 + 居中卡片），但提供两个并列选项按钮
 * 而非确认/取消，以匹配「两选项绑定 planScope」的产品口径。
 */
import { useCallback } from "react";
import type { ClarificationAnswer, GuideDraftClarification } from "@goplay/shared";

export interface ClarificationDialogProps {
  clarification: GuideDraftClarification;
  /** 用户选择某个选项后回调（携带 clarificationAnswer 重发 draft） */
  onAnswer: (answer: ClarificationAnswer) => void;
  /** 取消澄清（关闭对话框，不重发；等同于放弃本次生成） */
  onCancel: () => void;
}

/**
 * 稀疏攻略澄清对话框：两选项并列，文案逐字定稿（v1.2 拍板）。
 * 点击遮罩或取消按钮关闭对话框，不触发生成。
 */
export function ClarificationDialog({ clarification, onAnswer, onCancel }: ClarificationDialogProps) {
  const handleOverlayClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onCancel();
    },
    [onCancel],
  );

  return (
    <div
      className="clarification-overlay"
      onClick={handleOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-label="攻略覆盖澄清"
    >
      <div className="clarification-card">
        <p className="clarification-question">{clarification.question}</p>
        <div className="clarification-options">
          {clarification.options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`clarification-option clarification-option--${opt.value}`}
              onClick={() => onAnswer(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <button type="button" className="clarification-cancel" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}
