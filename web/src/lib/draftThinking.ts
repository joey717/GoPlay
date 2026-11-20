/**
 * 草案生成等待的思考链文案（任务 135 自 GuideDraftPanel 提升为共享模块）：
 * 行程级生成会话（useGuideDraftGeneration）与面板内进度展示、底部浮条共用同一时间线，
 * 保证用户在面板内外看到一致的「AI 此刻在做什么」。
 *
 * 文案口径（用户偏好）：简洁自然、口语化、按时间递进；不出现技术术语。
 * afterMs = 相对点击生成的毫秒数；后端一次性返回，文案切换为纯前端按时间线模拟。
 */
export interface DraftThinkingStep {
  afterMs: number;
  text: (sourceCount: number) => string;
}

export const DRAFT_THINKING_STEPS: ReadonlyArray<DraftThinkingStep> = [
  { afterMs: 0, text: () => "正在读取攻略素材…" },
  {
    afterMs: 5_000,
    text: (sourceCount) =>
      sourceCount > 1
        ? `合并 ${sourceCount} 篇攻略的地点和玩法细节…`
        : "梳理攻略里的地点和玩法细节…",
  },
  { afterMs: 15_000, text: () => "根据行程约束规划最佳路线…" },
  { afterMs: 30_000, text: () => "安排每日景点顺序和时间…" },
  { afterMs: 60_000, text: () => "生成攻略提示和注意事项…" },
  { afterMs: 90_000, text: () => "即将完成，正在整理最终方案…" },
  { afterMs: 120_000, text: () => "内容较多，还需要一点时间…" },
];

/**
 * 前端兜底超时：315 秒。
 * 服务端单轮 planner 预算 300s（GUIDE_DRAFT_TIMEOUT_MS，超时直接失败不重试），
 * 正常情况服务端会先返回错误；前端只在 fetch 挂死等异常场景下兜底转失败，
 * 取 315s 避免与服务端预算竞态（300s 时前端抢先 abort 会把可成功的请求误杀）。
 */
export const DRAFT_GENERATION_TIMEOUT_MS = 315_000;

/** 兜底超时的用户语言文案（不说「超时/请求」等技术词） */
export const DRAFT_GENERATION_TIMEOUT_MESSAGE = "等了快五分钟还没排好，可能是网络不稳定，请重试";

/** 思考链轮询间隔：到点切步即可，半秒粒度让文案切换不迟滞 */
export const DRAFT_THINKING_TICK_MS = 500;

/** 按已流逝时间取当前思考链文案（纯函数，面板与浮条共用） */
export function draftThinkingText(startedAt: number, now: number, sourceCount: number): string {
  const elapsed = now - startedAt;
  let step = 0;
  for (let i = 0; i < DRAFT_THINKING_STEPS.length; i += 1) {
    if (elapsed >= DRAFT_THINKING_STEPS[i].afterMs) step = i;
  }
  return DRAFT_THINKING_STEPS[step].text(sourceCount);
}
