/**
 * M2 F12 近期操作记录：仅本会话的前端记录，用于展示回顾，不提供回滚/时间旅行。
 * 存 sessionStorage（刷新保留当前会话，关闭页面清空），不写入 Trip 数据契约；
 * 最多保留 20 条，新的在前。
 */

export type OpLogKind =
  | "remove" // 单项移除（点位入候选池 / 内部玩法入备选）
  | "batch-remove" // 批量移除
  | "undo" // 撤销（单项或整批）
  | "reorder" // 拖拽改序（城市级 / 父内）
  | "lock" // 锁定切换
  | "purchase" // 购买状态变更
  | "add" // 加入（排入某天 / 加入候选池 / 手动添加点位 / 选定酒店）
  | "transfer"; // 转移（备选放回 / 待定加入归类）

export interface OpLogEntry {
  id: string;
  /** ISO8601 记录时间 */
  time: string;
  kind: OpLogKind;
  /** 点位名或数量摘要，如「蜈支洲岛」或 "3 项：西岛、鹿回头、天涯海角" */
  label: string;
  /** 补充说明，如 "Day2 → 候选池" */
  detail?: string;
}

const OPLOG_KEY = "goplay.oplog.v1";
const OPLOG_MAX = 20;

const VALID_KINDS: ReadonlySet<string> = new Set<string>([
  "remove",
  "batch-remove",
  "undo",
  "reorder",
  "lock",
  "purchase",
  "add",
  "transfer",
]);

/** 从 sessionStorage 读取记录；损坏或不可用时返回空数组 */
export function loadOpLog(): OpLogEntry[] {
  try {
    const raw = sessionStorage.getItem(OPLOG_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is OpLogEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as OpLogEntry).id === "string" &&
        typeof (entry as OpLogEntry).time === "string" &&
        typeof (entry as OpLogEntry).label === "string" &&
        VALID_KINDS.has((entry as OpLogEntry).kind),
    );
  } catch {
    return [];
  }
}

/** 追加一条记录（新的在前），超出上限截断并同步 sessionStorage */
export function pushOpLog(prev: OpLogEntry[], entry: OpLogEntry): OpLogEntry[] {
  const next = [entry, ...prev].slice(0, OPLOG_MAX);
  persist(next);
  return next;
}

/** 清空全部记录 */
export function clearOpLogStore(): OpLogEntry[] {
  try {
    sessionStorage.removeItem(OPLOG_KEY);
  } catch {
    /* 存储不可用时静默 */
  }
  return [];
}

function persist(entries: OpLogEntry[]): void {
  try {
    sessionStorage.setItem(OPLOG_KEY, JSON.stringify(entries));
  } catch {
    /* 存储不可用时静默 */
  }
}
