/**
 * 已关闭草案的持久化（任务 #211）：用户在草案预览点「取消」后把 draftId 记入
 * localStorage——重载召回时检查该记录，不再自动弹出「攻略排好了，点开看看」浮条。
 * 此前该记录只存在会话内存（useRef），刷新即失效，同一份未应用草案每次刷新都会
 * 重新召回并弹浮条，形成重复打扰。
 *
 * 边界：
 * - 应用成功由服务端一次性消费 pendingGuideDraft（召回条件自然不成立），
 *   这里的记录无需主动清理；FIFO 保留最近 50 条防无限增长；
 * - localStorage 不可用（隐私模式）或数据损坏：静默退化为会话内记忆，不阻塞主流程。
 */
const DISMISSED_DRAFTS_KEY = "goplay.dismissedDraftIds";
const DISMISSED_DRAFTS_LIMIT = 50;

/** 读取已关闭草案 id 集合；无记录 / 损坏 / 不可用时返回空集 */
export function loadDismissedDraftIds(): Set<string> {
  try {
    const raw = window.localStorage.getItem(DISMISSED_DRAFTS_KEY);
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

/** 追加式保存（调用方传入含新增 id 的完整集合）；超出上限时保留最近的记录 */
export function saveDismissedDraftIds(ids: ReadonlySet<string>): void {
  try {
    const list = [...ids];
    const trimmed =
      list.length > DISMISSED_DRAFTS_LIMIT
        ? list.slice(list.length - DISMISSED_DRAFTS_LIMIT)
        : list;
    window.localStorage.setItem(DISMISSED_DRAFTS_KEY, JSON.stringify(trimmed));
  } catch {
    // 写入失败（隐私模式等）仅影响跨刷新记忆，不阻塞主流程
  }
}
