/**
 * plan.scopeRef 归一化 + 全量重排识别（PRD v1.1 §9.4/§9.5，承接 Task #40 修复契约）。
 *
 * 背景（2026-10-15 真实百炼实测，Task #40）：字面判定覆盖不到模型输出的等价形状——
 *   - scope 为数字 dayIndex（逐天分组的多条 plan，等价全量）；
 *   - 单条 plan 覆盖多天 assignments；
 *   - scope 为字符串 dayIndex / 中文全量词等变体。
 * 未命中的操作批直接走 applyOps 落盘（QA 现象：未触发二次确认直接 applied）。
 *
 * v1.1 判定契约（严格归一化 → 批级判定）：
 * - scopeRef 归一化：{"kind":"allDays"} / "all" 家族（大小写不敏感）→ allDays；
 *   {"kind":"day","dayIndex":N} / 数字 / 数字字符串 / "day2" / "第2天" → day+N；
 *   其余原样保留，由四条护栏按非法值拒绝，不做猜测性改写；
 * - subjectRef / containerRef / assignments 的 dayIndex / order / minutes 数字字符串
 *   做无损数值归一化；旧 v1.0 的 scope/assign 形状不映射（护栏按缺失 scopeRef 拒绝）；
 * - 全量重排（批级）：批内任一条 plan 归一化 scopeRef=allDays，或批内 plan 的
 *   assignments 合计覆盖 >1 个不同 dayIndex（单条跨天 / 多条单日合计两种等价形状）；
 * - 单日 plan（day+N 且 assignments 不跨天）不得误判为全量，保持可直接应用。
 */

import type { Operation, PlanScopeRef } from "@goplay/shared";

/** 全量词表（大小写不敏感）：模型实测可能输出的中英文「全部」表达 */
const FULL_SCOPE_WORDS: ReadonlySet<string> = new Set([
  "all",
  "alldays",
  "全部",
  "所有",
  "全部天",
  "所有天",
  "整个行程",
  "全行程",
  "整体",
  "整段行程",
]);

/** 数字 / 数字字符串 → 整数；其余返回 undefined（保留原值） */
function toInteger(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isInteger(value) ? value : undefined;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

/** 裸值 scope 家族 → 整数 dayIndex 或 "all"；无法无损归一化返回 null */
function normalizeScopeToken(value: unknown): number | "all" | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;
  if (FULL_SCOPE_WORDS.has(text.toLowerCase())) return "all";
  if (/^\d+$/.test(text)) return Number(text);
  const englishDay = text.match(/^day\s*(\d+)$/i);
  if (englishDay) return Number(englishDay[1]);
  const chineseDay = text.match(/^第\s*(\d+)\s*天$/);
  if (chineseDay) return Number(chineseDay[1]);
  return null;
}

/**
 * 严格归一化 plan.scopeRef（PRD v1.1 PlanScopeRef）：
 * - {"kind":"allDays"} / "all" 家族 → {"kind":"allDays"}；
 * - {"kind":"day","dayIndex":N} / 数字 / 数字字符串 / "day2" / "第2天" → {"kind":"day","dayIndex":N}；
 * - 其余（含非法值/旧 v1.0 scope 字符串家族以外形状）→ null，
 *   调用方保留原值（护栏会以 G1 拒绝并给出可见原因）。
 */
export function normalizeScopeRef(value: unknown): PlanScopeRef | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.kind === "allDays") return { kind: "allDays" };
    if (record.kind === "day") {
      const dayIndex = toInteger(record.dayIndex);
      return dayIndex !== undefined ? { kind: "day", dayIndex } : null;
    }
    return null;
  }
  const token = normalizeScopeToken(value);
  if (token === "all") return { kind: "allDays" };
  if (typeof token === "number") return { kind: "day", dayIndex: token };
  return null;
}

/** EntityRef / ContainerRef 内的 dayIndex 数字字符串无损归一化（其余字段原样保留） */
function normalizeRef(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const record = { ...(value as Record<string, unknown>) };
  if (record.kind === "day" || record.kind === "lodging") {
    const dayIndex = toInteger(record.dayIndex);
    if (dayIndex !== undefined) record.dayIndex = dayIndex;
  }
  return record;
}

/**
 * 单条操作字段归一化（无损，不猜测）：
 * - plan：scopeRef 可无损映射时替换为规范值；assignments[].subjectRef/containerRef
 *   内 dayIndex 与 order 数字字符串 → number；
 * - 其他 op：subjectRef / from/toContainerRef 内 dayIndex、toOrder / minutes 数字字符串 → number；
 * - 归一化失败字段保留原值，交由四条护栏拒绝；旧 v1.0 scope/assign 形状不映射。
 */
export function normalizePlanFields(entry: Record<string, unknown>): Operation {
  const normalized: Record<string, unknown> = { ...entry };
  for (const refKey of ["subjectRef", "fromContainerRef", "toContainerRef", "containerRef"] as const) {
    if (refKey in normalized) normalized[refKey] = normalizeRef(normalized[refKey]);
  }
  const toOrder = toInteger(normalized.toOrder);
  if (toOrder !== undefined) normalized.toOrder = toOrder;
  const minutes = toInteger(normalized.minutes);
  if (minutes !== undefined) normalized.minutes = minutes;

  if (entry.op !== "plan") return normalized as unknown as Operation;

  const scopeRef = normalizeScopeRef(entry.scopeRef);
  if (scopeRef !== null) normalized.scopeRef = scopeRef;
  if (Array.isArray(entry.assignments)) {
    normalized.assignments = entry.assignments.map((raw) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
      const assign = { ...(raw as Record<string, unknown>) };
      if ("subjectRef" in assign) assign.subjectRef = normalizeRef(assign.subjectRef);
      if ("containerRef" in assign) assign.containerRef = normalizeRef(assign.containerRef);
      const order = toInteger(assign.order);
      if (order !== undefined) assign.order = order;
      return assign;
    });
  }
  return normalized as unknown as Operation;
}

/** plan 的 scopeRef 是否为 allDays（操作可能未经归一化，故做形状防御） */
function isAllDaysScopeRef(op: Operation): boolean {
  if (op.op !== "plan") return false;
  const scopeRef = (op as { scopeRef?: unknown }).scopeRef;
  return typeof scopeRef === "object" && scopeRef !== null && (scopeRef as { kind?: unknown }).kind === "allDays";
}

/** 收集 assignments 中 day 容器的 dayIndex（形状防御，操作可能未经归一化） */
function collectAssignmentDays(op: Operation, coveredDays: Set<number>): void {
  if (op.op !== "plan") return;
  const assignments = (op as { assignments?: unknown }).assignments;
  if (!Array.isArray(assignments)) return;
  for (const raw of assignments) {
    if (typeof raw !== "object" || raw === null) continue;
    const containerRef = (raw as { containerRef?: unknown }).containerRef;
    if (typeof containerRef !== "object" || containerRef === null) continue;
    const record = containerRef as { kind?: unknown; dayIndex?: unknown };
    if (record.kind === "day" && typeof record.dayIndex === "number") {
      coveredDays.add(record.dayIndex);
    }
  }
}

/**
 * 批级全量重排判定（在护栏 passed 操作上调用）：
 * - 任一条 plan 的归一化 scopeRef = allDays → true；
 * - 批内 plan 的 assignments 合计覆盖 >1 个不同 dayIndex → true（单条跨天 /
 *   多条单日合计覆盖多天，两种等价全量形状）；
 * - 单条单日 plan（day+N、assignments 单天）→ false，保持直接应用（不经确认）。
 */
export function isFullPlanBatch(ops: Operation[]): boolean {
  const coveredDays = new Set<number>();
  for (const op of ops) {
    if (op.op !== "plan") continue;
    if (isAllDaysScopeRef(op)) return true;
    collectAssignmentDays(op, coveredDays);
    if (coveredDays.size > 1) return true;
  }
  return false;
}

/** 供日志与回归断言：描述批内 plan 的 scope 与覆盖天集合（无隐私面） */
export function describePlanCoverage(ops: Operation[]): { scopes: string[]; days: number[] } {
  const scopes: string[] = [];
  const days = new Set<number>();
  for (const op of ops) {
    if (op.op !== "plan") continue;
    const scopeRef = (op as { scopeRef?: unknown }).scopeRef;
    if (typeof scopeRef === "object" && scopeRef !== null) {
      const record = scopeRef as { kind?: unknown; dayIndex?: unknown };
      if (record.kind === "allDays") scopes.push("allDays");
      else if (record.kind === "day" && typeof record.dayIndex === "number") scopes.push(String(record.dayIndex));
      else scopes.push("invalid");
    } else {
      scopes.push("invalid");
    }
    collectAssignmentDays(op, days);
  }
  return { scopes, days: [...days].sort((a, b) => a - b) };
}
