/**
 * 展示层功能开关（集中管理，便于整体恢复）。
 *
 * SHOW_ESTIMATED_TIMES
 * -------------------
 * 2026-11-03 PD 判定：当前所有 AI/推导时间（点位时间区间、时长估算、时间来源标签）
 * 数据源不够准确，暂停全部估算时间展示。
 *
 * 覆盖范围（Task #340）：行程页（VisitCard / StopRow / DayContent）与分享页（ShareView）
 * 的时间区间、「约 X 小时」、「X 小时游玩」、「估算」徽标、带时间来源灰字、「建议 X」时长。
 * 覆盖范围（Task #343，2026-11-04 PD 拍板「也都藏」）：扩展到候选池与备选玩法区的
 * 「建议 X 小时/分钟」时长 chip —— CandidatePool 三区（候选区 / 待定加入 / 备选玩法）
 * 与 VisitCard 备选玩法展开区；其余 chip（名称 / 榜单 / 免票 / 片区 / 4A5A /
 * 「含 N 个岛内玩法」/「原 DayN」/「需另购票」/「归属待确认」）一律不受影响。
 *
 * 恢复条件：拿到准确时长/时间数据源后，将此值改回 true 即可一次性恢复所有渲染点。
 * 被 gate 的渲染代码全部保留（不删除），仅由本开关控制是否输出到 DOM。
 * 双向行为由 displayFlags.test.ts（哨兵锁默认 false）与 displayFlags.flagOn.test.tsx
 * （mock 为 true 逐点断言恢复）共同锁定。
 */
export const SHOW_ESTIMATED_TIMES = false;
