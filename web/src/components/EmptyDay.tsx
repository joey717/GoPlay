interface EmptyDayProps {
  /** 空态天号：标题与按钮文案都带上（"DayN 还没安排" / "添加到 DayN"） */
  dayIndex: number;
  /**
   * 打开统一添加面板（交互优化 Module D：唯一主行动）；
   * 上抛 dayIndex 供父组件设置 openContext（候选池内容排面板第一屏）。
   */
  onOpenNote: (dayIndex: number) => void;
}

/**
 * 空 Day 状态（交互优化 Module D）：紧凑虚线空态卡，页面上不再露出候选池等
 * 其他添加入口。标题「DayN 还没安排」+ 按钮「添加到 DayN」+ 灰字提示——
 * 点击后统一面板以「添加到 DayN」为标题打开，攻略推荐的候选点排在面板最前面。
 */
export default function EmptyDay({ dayIndex, onOpenNote }: EmptyDayProps) {
  return (
    <div className="empty-card">
      <div className="et">Day{dayIndex} 还没安排</div>
      <button type="button" className="ebtn" onClick={() => onOpenNote(dayIndex)}>
        添加到 Day{dayIndex}
      </button>
      <div className="ehint">点击后，攻略里推荐的候选点会排在面板最前面</div>
    </div>
  );
}
