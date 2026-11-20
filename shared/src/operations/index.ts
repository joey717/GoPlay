/**
 * shared 操作执行器 —— 手工与 AI 双通道的唯一收敛实现（PRD v1.1 §10.1「双通道原则」）。
 *
 * 职责边界：
 * - 只负责把 Operation（EntityRef/ContainerRef 寻址）应用到 Trip 工作副本并维持
 *   数据一致性（重排 / 跨天搬运 / 候选进出 / 归类纠正 / 字段写入 / 受影响天重算）；
 * - 不做护栏校验：四条护栏由 guards 模块在调用前负责，执行器只保证「应用后数据自洽」；
 *   执行器内部保留同语义兜底（护栏在前，执行器兜底，防止绕过护栏的调用越过红线）；
 * - 确认分流：remove / setPurchase / lock 属「写入不可自动回退状态」的敏感操作，
 *   默认归入 needsProposal，由用户确认后以 confirmed=true 二次下发执行；
 * - 原子提交（PRD §12.5）：单条预检失败仅拒绝该条（预校验筛除组成新批次）；
 *   应用后一致性校验失败则整批回滚（consistencyErrors 非空，trip 原样返回）。
 *
 * 位置语义（PRD §9.4/§9.5）：
 * - order / toOrder 均 0-based；越界一律拒绝，不默默夹取；
 * - transfer.toOrder=null 表示追加到目标容器末尾（仅 visit 目标有意义）；
 * - plan 未列入 assignments 的既有实体保持原相对顺序追加在后——绝不静默丢弃；
 *   「排不下」由模型在 unplaced 中声明。
 *
 * G3 兜底（PRD §12.3）：actor=ai_proposed 时不得移动已购/已锁 Visit 与 Lodging；
 * user_manual / user_confirmed（用户明确点名并确认）可改行程但锁保留。
 * remove 对 locked / bought 一律拒绝（先解锁 / 走改订）。
 *
 * userAdjusted 标记：move / transfer / setTime / setDuration / plan 显式提及
 * 均视为用户调整，供护栏 G4「重排保护」识别。例外（Task #105）：Stop 的 transfer
 * 归类（pending ↔ 景区）只能由用户通道执行，userAdjusted / relationshipSuggestions
 * .decidedBy="user" 也仅在 actor≠ai_proposed 时写入。
 */

import type {
  ApplyResult,
  ContainerRef,
  Day,
  EntityRef,
  GuideSnippet,
  LodgingPlan,
  Operation,
  OperationActor,
  PlanScopeRef,
  Stop,
  Trip,
  Visit,
} from "../types/index.js";
import { validateConsistency } from "../consistency/index.js";
import { recomputeDayTimeline } from "../timeline/index.js";
import { recomputeDerivedFields } from "../dayRoles/index.js";
import { parseMentionRef, resolveMentionRef } from "../guides/index.js";

// ===== 类型与常量 =====

type PlanOp = Extract<Operation, { op: "plan" }>;
type MoveOp = Extract<Operation, { op: "move" }>;
type TransferOp = Extract<Operation, { op: "transfer" }>;
type RemoveOp = Extract<Operation, { op: "remove" }>;
type SetTimeOp = Extract<Operation, { op: "setTime" }>;
type SetDurationOp = Extract<Operation, { op: "setDuration" }>;
type SetPurchaseOp = Extract<Operation, { op: "setPurchase" }>;
type LockOp = Extract<Operation, { op: "lock" }>;
type AddLodgingCandidateOp = Extract<Operation, { op: "addLodgingCandidate" }>;
type ClassifyVisitAsStopOp = Extract<Operation, { op: "classifyVisitAsStop" }>;

/** setDuration 的配置上限（PRD §9.4「minutes 为正整数且在配置上限内」）：单次设置不超过 24 小时 */
export const MAX_SETTABLE_MINUTES = 24 * 60;

/** HH:MM 时间格式（24 小时制两位表示；与 guards / timeline 共用约定） */
export const TIME_PATTERN = /^\d{2}:\d{2}$/;

/** applyOps 执行选项 */
export interface ApplyOpsOptions {
  /** 操作来源（PRD §9.6）：G3 按 actor 分流；默认 "ai_proposed"（最保守） */
  actor?: OperationActor;
  /** true 时敏感操作（remove / setPurchase / lock）直接执行而非分流到 needsProposal */
  confirmed?: boolean;
}

/** Visit 当前位置：某天的第 order 位，或全局候选区 */
export type VisitLocation = { where: "day"; dayIndex: number; order: number } | { where: "globalPool" };

/** Stop 当前位置：某 Visit 的内部玩法 / 备选玩法，或全局待定区 */
export type StopContainer = { where: "child" | "alternate"; visitId: string } | { where: "pending" };

// ===== 通用辅助（guards 亦依赖，导出） =====

/** 深拷贝（快照 / 工作副本统一走 JSON 序列化，与 v1.0 语义一致） */
export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 运行时防御：值是否为合法 EntityRef（F11 输入来自模型 JSON 反序列化，不信任其结构） */
export function isEntityRef(value: unknown): value is EntityRef {
  if (value === null || typeof value !== "object") return false;
  const ref = value as { kind?: unknown; dayIndex?: unknown; id?: unknown };
  switch (ref.kind) {
    case "day":
    case "lodging":
      return Number.isInteger(ref.dayIndex);
    case "point":
    case "visit":
    case "stop":
      return typeof ref.id === "string";
    default:
      return false;
  }
}

/** 运行时防御：值是否为合法 ContainerRef */
export function isContainerRef(value: unknown): value is ContainerRef {
  if (value === null || typeof value !== "object") return false;
  const ref = value as { kind?: unknown; dayIndex?: unknown; id?: unknown; visitId?: unknown };
  switch (ref.kind) {
    case "day":
      return Number.isInteger(ref.dayIndex);
    case "visit":
      return typeof ref.id === "string";
    case "globalPool":
    case "pendingPool":
      return true;
    case "visitPool":
      return typeof ref.visitId === "string";
    default:
      return false;
  }
}

/** 运行时防御：值是否为合法 plan.scopeRef（kind 限定 day/allDays；day 须带整数 dayIndex） */
export function isPlanScopeRef(value: unknown): value is PlanScopeRef {
  if (value === null || typeof value !== "object") return false;
  const ref = value as { kind?: unknown; dayIndex?: unknown };
  if (ref.kind === "allDays") return true;
  return ref.kind === "day" && Number.isInteger(ref.dayIndex);
}

/** 引用的稳定字符串键（去重 / 展示用） */
export function refKey(ref: EntityRef | ContainerRef): string {
  switch (ref.kind) {
    case "day":
    case "lodging":
      return `${ref.kind}:${ref.dayIndex}`;
    case "point":
    case "visit":
    case "stop":
      return `${ref.kind}:${ref.id}`;
    case "visitPool":
      return `visitPool:${ref.visitId}`;
    default:
      return ref.kind;
  }
}

/** dayIndex 是否落在行程范围内（dayRefs 顺序与 dayIndex 一致，从 1 开始） */
export function getDayByIndex(trip: Trip, dayIndex: number): Day | null {
  if (!Number.isInteger(dayIndex) || dayIndex < 1 || dayIndex > trip.dayRefs.length) return null;
  return trip.days[trip.dayRefs[dayIndex - 1]] ?? null;
}

/** Visit 当前位置；引用不一致或不存在时返回 null（悬空由 validateConsistency 兜底） */
export function findVisitLocation(trip: Trip, visitId: string): VisitLocation | null {
  const visit = trip.visits[visitId];
  if (visit === undefined) return null;
  if (visit.dayRef !== null) {
    const day = trip.days[visit.dayRef];
    if (day === undefined) return null;
    const order = day.scheduleVisitRefs.indexOf(visitId);
    if (order === -1) return null;
    return { where: "day", dayIndex: day.dayIndex, order };
  }
  return { where: "globalPool" };
}

/** Stop 当前位置；引用不一致或不存在时返回 null */
export function findStopContainer(trip: Trip, stopId: string): StopContainer | null {
  const stop = trip.stops[stopId];
  if (stop === undefined) return null;
  if (stop.state === "pending") {
    return trip.pendingStopRefs.includes(stopId) ? { where: "pending" } : null;
  }
  if (stop.visitRef === null) return null;
  const visit = trip.visits[stop.visitRef];
  if (visit === undefined) return null;
  if (visit.childStopRefs.includes(stopId)) return { where: "child", visitId: stop.visitRef };
  if (visit.alternateStopRefs.includes(stopId)) return { where: "alternate", visitId: stop.visitRef };
  return null;
}

/** Visit 所在天号（dayRef 反查）；未排期 / 引用不一致返回 null */
export function visitDayIndex(trip: Trip, visitId: string): number | null {
  const visit = trip.visits[visitId];
  if (visit === undefined || visit.dayRef === null) return null;
  const day = trip.days[visit.dayRef];
  return day === undefined ? null : day.dayIndex;
}

/** point 是否在全局候选区（未安排的城市级 Point） */
export function inGlobalPool(trip: Trip, kind: "point" | "visit", id: string): boolean {
  return trip.globalCandidateRefs.some((ref) => ref.kind === kind && ref.id === id);
}

/** 为 point 生成确定性 visitId（plan 创建 Visit 用）：visit_{pointRef}_{n}，n 递增避免碰撞 */
export function makeVisitId(trip: Trip, pointRef: string): string {
  let n = 1;
  let candidate = `visit_${pointRef}_${n}`;
  while (trip.visits[candidate] !== undefined) {
    n += 1;
    candidate = `visit_${pointRef}_${n}`;
  }
  return candidate;
}

/** Visit 的可读名称（拒绝原因展示用）：优先 itemRegistry 名称 */
export function visitName(trip: Trip, visitId: string): string {
  const visit = trip.visits[visitId];
  if (visit === undefined) return visitId;
  return trip.itemRegistry[visit.pointRef]?.name ?? visitId;
}

/** Stop 的可读名称：matchedPoint 的名称或 customName */
export function stopName(trip: Trip, stopId: string): string {
  const stop = trip.stops[stopId];
  if (stop === undefined) return stopId;
  if (stop.matchedPointRef !== null) {
    return trip.itemRegistry[stop.matchedPointRef]?.name ?? stop.customName ?? stopId;
  }
  return stop.customName ?? stopId;
}

/** toOrder 是否为合法的 0-based 位置（maxInclusive 为该容器当前允许的上界） */
function isValidOrder(toOrder: number, maxInclusive: number): boolean {
  return Number.isInteger(toOrder) && toOrder >= 0 && toOrder <= maxInclusive;
}

/** 重排某 Visit 的 child / alternate 下标到 Stop.order（保持冗余字段一致） */
function renumberStops(trip: Trip, visit: Visit): void {
  visit.childStopRefs.forEach((stopId, index) => {
    const stop = trip.stops[stopId];
    if (stop !== undefined) stop.order = index;
  });
  visit.alternateStopRefs.forEach((stopId, index) => {
    const stop = trip.stops[stopId];
    if (stop !== undefined) stop.order = index;
  });
}

/** G3 兜底：AI 不得移动已购/已锁 Visit（用户明确操作不受限；remove 另有更严规则） */
function guardProtectedVisit(trip: Trip, visit: Visit, actor: OperationActor, action: string): string | null {
  if (actor !== "ai_proposed") return null;
  if (visit.locked) {
    return `${action}：「${visitName(trip, visit.visitId)}」已被锁定，AI 不能改动（用户明确操作不受限）`;
  }
  if (visit.purchaseState === "bought") {
    return `${action}：「${visitName(trip, visit.visitId)}」门票已购，AI 不能移动（如需调整请由用户明确确认）`;
  }
  return null;
}

/** G3 兜底：AI 不得改动已锁/已订住宿的时间 */
function guardProtectedLodging(plan: LodgingPlan, actor: OperationActor, action: string): string | null {
  if (actor !== "ai_proposed") return null;
  if (plan.locked || plan.purchaseState === "bought") {
    return `${action}：Day${plan.dayIndex} 住宿已被锁定或已预订，AI 不能改动（用户明确操作不受限）`;
  }
  return null;
}

// ===== applyOps 主入口 =====

/**
 * 将一组操作应用到行程副本上（纯函数：不改动入参 trip，返回全新副本）。
 *
 * - remove / setPurchase / lock：默认归入 needsProposal 等用户确认；
 *   options.confirmed=true 时直接落地（用户已确认的二次下发）；
 * - 其余操作逐条应用：单条预检失败进入 rejected（含可读原因），不影响其余操作；
 *   每条内部先整体预检再执行，任一预检失败整条拒绝，不做部分应用；
 * - 每条成功后仅对受影响的天调用 recomputeDayTimeline（PRD §8.3 局部重算边界）；
 * - 全部应用后执行 validateConsistency（PRD §12.5 一致性校验）：
 *   失败则整批回滚（trip 原样、applied 清空、consistencyErrors 携带原因）。
 */
export function applyOps(trip: Trip, ops: Operation[], options: ApplyOpsOptions = {}): ApplyResult {
  const confirmed = options.confirmed === true;
  const actor: OperationActor = options.actor ?? "ai_proposed";
  let next = deepClone(trip);
  const applied: Operation[] = [];
  const rejected: { op: Operation; reason: string }[] = [];
  const needsProposal: Operation[] = [];

  for (const op of ops) {
    if (op === null || typeof op !== "object") {
      rejected.push({ op: op as Operation, reason: "操作不是合法对象" });
      continue;
    }
    // 确认分流：三类敏感操作默认必须经提案确认后由调用方二次下发
    if (!confirmed && (op.op === "remove" || op.op === "setPurchase" || op.op === "lock")) {
      needsProposal.push(op);
      continue;
    }

    const affected = new Set<number>();
    const error = applyOne(next, op, affected, confirmed, actor);

    if (error !== null) {
      rejected.push({ op, reason: error });
      continue;
    }

    applied.push(op);
    for (const dayIndex of affected) {
      next = recomputeDayTimeline(next, dayIndex);
    }
  }

  // Task #280：派生字段重算（day 角色）——操作集应用后、一致性校验前统一重算，
  // 锚点变更（改航班约束 / 改锁酒店 / 改 lodging）在同一操作内同步落盘（S11 口径）。
  // 外部传入的 role 一律被派生结果覆盖（派生数据红线：无手改合法路径）。
  // Task #290 Nit8：仅在确有变更（applied.length>0）时重算——零操作/全部被拒时 next 仍是
  // deepClone(trip) 的等价克隆，不产生「无操作却改派生字段」的伪 diff（幂等深比较友好）。
  if (applied.length > 0) {
    next = recomputeDerivedFields(next);
  }

  // 原子提交阶段：一致性校验失败 → 最终接受集全部回滚（PRD §12.5）
  const consistencyErrors = validateConsistency(next);
  if (consistencyErrors.length > 0) {
    return { trip: deepClone(trip), applied: [], rejected, needsProposal, consistencyErrors };
  }
  return { trip: next, applied, rejected, needsProposal, consistencyErrors: [] };
}

/** 应用单条操作；返回 null 表示成功，否则返回拒绝原因。affected 收集被波及的天。 */
function applyOne(
  trip: Trip,
  op: Operation,
  affected: Set<number>,
  confirmed: boolean,
  actor: OperationActor,
): string | null {
  switch (op.op) {
    case "plan":
      return applyPlan(trip, op, affected, actor);
    case "move":
      return applyMove(trip, op, affected, actor);
    case "transfer":
      return applyTransfer(trip, op, affected, actor);
    case "setTime":
      return applySetTime(trip, op, affected, actor);
    case "setDuration":
      return applySetDuration(trip, op, affected, actor);
    case "remove":
      return confirmed ? applyRemove(trip, op, affected) : "操作 remove 属确认类操作，必须经用户提案确认后执行";
    case "setPurchase":
      return confirmed ? applySetPurchase(trip, op) : "操作 setPurchase 属确认类操作，必须经用户提案确认后执行";
    case "lock":
      return confirmed ? applyLock(trip, op) : "操作 lock 属确认类操作，必须经用户提案确认后执行";
    case "addLodgingCandidate":
      return applyAddLodgingCandidate(trip, op);
    case "classifyVisitAsStop":
      return applyClassifyVisitAsStop(trip, op, affected, actor);
  }
}

// ===== plan =====

/**
 * plan：增量补丁式编排（PRD §9.4）。
 *
 * - subject 支持：visit（已排期天 / globalPool 壳）、point（globalPool 中，进入 Day 时
 *   创建 ordinary Visit 壳）、attached stop（父内重排 / 从备选提升）；
 * - 不得把 pending（待定加入）的 Stop 自动挂入 Visit——须由用户确认归类（transfer）；
 * - Stop 的目标容器必须是其当前所属 Visit（换景区是 transfer 归类纠正的职责）；
 * - 未列入 assignments 的既有实体保持原相对顺序追加在新排列之后，绝不静默丢弃；
 * - G3：actor=ai_proposed 时不得移动已购/已锁 Visit（单条 assignment 违规则整条拒绝）；
 * - order 上限 = 目标容器当前长度 + 该容器 assignment 条数 - 1（支持从候选引入新实体）。
 */
function applyPlan(trip: Trip, op: PlanOp, affected: Set<number>, actor: OperationActor): string | null {
  if (!isPlanScopeRef(op.scopeRef)) {
    return "plan.scopeRef 非法（须为 { kind: \"day\", dayIndex } 或 { kind: \"allDays\" }）";
  }
  if (op.scopeRef.kind === "day" && getDayByIndex(trip, op.scopeRef.dayIndex) === null) {
    return `plan.scopeRef.dayIndex 超出行程日期范围：${op.scopeRef.dayIndex}`;
  }
  if (!Array.isArray(op.assignments)) return "plan.assignments 不是数组";

  // ---- 预检：容器分组计数（order 上限用）----
  const dayAssignCount = new Map<number, number>();
  const visitAssignCount = new Map<string, number>();
  for (const a of op.assignments) {
    if (a === null || typeof a !== "object") return "plan.assignments 中存在非法项";
    if (!isEntityRef(a.subjectRef)) return "plan.assignments 中存在非法 subjectRef";
    if (!isContainerRef(a.containerRef)) return "plan.assignments 中存在非法 containerRef";
    if (a.subjectRef.kind === "stop" || a.subjectRef.kind === "point" || a.subjectRef.kind === "visit") {
      if (a.containerRef.kind === "day") {
        const key = a.containerRef.dayIndex;
        dayAssignCount.set(key, (dayAssignCount.get(key) ?? 0) + 1);
      } else if (a.containerRef.kind === "visit") {
        const key = a.containerRef.id;
        visitAssignCount.set(key, (visitAssignCount.get(key) ?? 0) + 1);
      }
    }
  }

  // ---- 预检：逐条校验 ----
  const seen = new Set<string>();
  for (const a of op.assignments) {
    const key = refKey(a.subjectRef);
    if (seen.has(key)) return `plan.assignments 中 subjectRef 重复：${key}`;
    seen.add(key);
    if (!Number.isInteger(a.order) || a.order < 0) {
      return `plan.assignments.order 非法：${String(a.order)}（须为非负整数）`;
    }

    if (a.subjectRef.kind === "stop") {
      const stop = trip.stops[a.subjectRef.id];
      if (stop === undefined) return `plan.assignments 引用了不存在的内部玩法：${a.subjectRef.id}`;
      if (stop.state === "pending") {
        return `plan 不能自动挂入待定加入的内部玩法「${stopName(trip, stop.stopId)}」，须由用户确认归类（transfer）`;
      }
      if (a.containerRef.kind !== "visit") {
        return `内部玩法只能编入 visit 容器（subjectRef ${a.subjectRef.id}）`;
      }
      const targetVisit = trip.visits[a.containerRef.id];
      if (targetVisit === undefined) return `plan.assignments 引用了不存在的容器 visit：${a.containerRef.id}`;
      if (stop.visitRef !== a.containerRef.id) {
        return `plan 不能把内部玩法「${stopName(trip, stop.stopId)}」移到其他大景区；换景区请使用 transfer 归类纠正`;
      }
      const maxOrder = targetVisit.childStopRefs.length + (visitAssignCount.get(a.containerRef.id) ?? 1) - 1;
      if (a.order > maxOrder) {
        return `plan.assignments.order 越界：${a.order}（合法范围 0-${maxOrder}）`;
      }
    } else if (a.subjectRef.kind === "visit") {
      const visit = trip.visits[a.subjectRef.id];
      if (visit === undefined) return `plan.assignments 引用了不存在的 visit：${a.subjectRef.id}`;
      if (a.containerRef.kind !== "day") {
        return `Visit 只能编入 day 容器（subjectRef ${a.subjectRef.id}）`;
      }
      const day = getDayByIndex(trip, a.containerRef.dayIndex);
      if (day === null) {
        return `plan.assignments 中 dayIndex 超出行程日期范围：${a.containerRef.dayIndex}`;
      }
      const guardErr = guardProtectedVisit(trip, visit, actor, "plan");
      if (guardErr !== null) return guardErr;
      const maxOrder = day.scheduleVisitRefs.length + (dayAssignCount.get(a.containerRef.dayIndex) ?? 1) - 1;
      if (a.order > maxOrder) {
        return `plan.assignments.order 越界：${a.order}（Day${a.containerRef.dayIndex} 合法范围 0-${maxOrder}）`;
      }
    } else if (a.subjectRef.kind === "point") {
      if (a.containerRef.kind !== "day") {
        return `未安排点位只能编入 day 容器（subjectRef ${a.subjectRef.id}）`;
      }
      const day = getDayByIndex(trip, a.containerRef.dayIndex);
      if (day === null) {
        return `plan.assignments 中 dayIndex 超出行程日期范围：${a.containerRef.dayIndex}`;
      }
      if (trip.itemRegistry[a.subjectRef.id] === undefined) {
        return `plan.assignments 引用了不存在的 point：${a.subjectRef.id}`;
      }
      if (!inGlobalPool(trip, "point", a.subjectRef.id)) {
        return `plan.assignments 引用了不在全局候选区的 point：${a.subjectRef.id}`;
      }
      const maxOrder = day.scheduleVisitRefs.length + (dayAssignCount.get(a.containerRef.dayIndex) ?? 1) - 1;
      if (a.order > maxOrder) {
        return `plan.assignments.order 越界：${a.order}（Day${a.containerRef.dayIndex} 合法范围 0-${maxOrder}）`;
      }
    } else {
      return `plan 不支持 ${String(a.subjectRef.kind)} 类型的 subjectRef`;
    }
  }

  // ---- 执行第一步：统一取出被 assign 的实体（跨容器互排时避免顺序踩踏）----
  const newVisitByPoint = new Map<string, Visit>();
  for (const a of op.assignments) {
    if (a.subjectRef.kind === "visit") {
      const visitId = a.subjectRef.id;
      const loc = findVisitLocation(trip, visitId);
      if (loc === null) return `plan：visit ${visitId} 引用位置不一致，无法定位`;
      if (loc.where === "day") {
        const srcDay = getDayByIndex(trip, loc.dayIndex);
        if (srcDay !== null) {
          srcDay.scheduleVisitRefs = srcDay.scheduleVisitRefs.filter((id) => id !== visitId);
          affected.add(loc.dayIndex);
        }
      } else {
        trip.globalCandidateRefs = trip.globalCandidateRefs.filter(
          (ref) => !(ref.kind === "visit" && ref.id === visitId),
        );
      }
    } else if (a.subjectRef.kind === "point") {
      const pointId = a.subjectRef.id;
      trip.globalCandidateRefs = trip.globalCandidateRefs.filter(
        (ref) => !(ref.kind === "point" && ref.id === pointId),
      );
      const visitId = makeVisitId(trip, pointId);
      const created: Visit = {
        visitId,
        dayRef: null,
        pointRef: pointId,
        kind: "ordinary",
        visitMode: "custom",
        order: null,
        windowStart: null,
        windowEnd: null,
        startTime: null,
        endTime: null,
        startTimeOverridden: false,
        endTimeOverridden: false,
        reservedMinutes: null,
        effectiveMinutes: null,
        externalLeg: null,
        childStopRefs: [],
        alternateStopRefs: [],
        purchaseState: "unknown",
        locked: false,
        userAdjusted: false,
        removedFrom: null,
        removedAt: null,
      };
      trip.visits[visitId] = created;
      newVisitByPoint.set(pointId, created);
    } else if (a.subjectRef.kind === "stop") {
      const stopId = a.subjectRef.id;
      const stop = trip.stops[stopId]!;
      const owner = trip.visits[a.containerRef.kind === "visit" ? a.containerRef.id : ""];
      if (owner === undefined) return "plan：内部玩法容器解析失败";
      owner.childStopRefs = owner.childStopRefs.filter((id) => id !== stopId);
      owner.alternateStopRefs = owner.alternateStopRefs.filter((id) => id !== stopId);
      renumberStops(trip, owner);
    }
  }

  // ---- 执行第二步：day 容器分组放置（order 升序 + 未提及项按原相对顺序追加）----
  const dayGroups = new Map<number, PlanOp["assignments"][number][]>();
  const visitGroups = new Map<string, PlanOp["assignments"][number][]>();
  for (const a of op.assignments) {
    if (a.subjectRef.kind === "stop" && a.containerRef.kind === "visit") {
      const group = visitGroups.get(a.containerRef.id) ?? [];
      group.push(a);
      visitGroups.set(a.containerRef.id, group);
    } else if (a.containerRef.kind === "day") {
      const group = dayGroups.get(a.containerRef.dayIndex) ?? [];
      group.push(a);
      dayGroups.set(a.containerRef.dayIndex, group);
    }
  }

  for (const [dayIndex, assigns] of dayGroups) {
    const day = getDayByIndex(trip, dayIndex);
    if (day === null) continue;
    const ordered = [...assigns].sort((x, y) => x.order - y.order);
    const assignedIds: string[] = [];
    for (const a of ordered) {
      const subject = a.subjectRef;
      if (subject.kind === "point") {
        assignedIds.push(newVisitByPoint.get(subject.id)!.visitId);
      } else if (subject.kind === "visit" || subject.kind === "stop") {
        assignedIds.push(subject.id);
      }
    }
    const assignedSet = new Set(assignedIds);
    const rest = day.scheduleVisitRefs.filter((id) => !assignedSet.has(id));
    day.scheduleVisitRefs = [...assignedIds, ...rest];
    day.scheduleVisitRefs.forEach((id, index) => {
      const visit = trip.visits[id];
      if (visit === undefined) return;
      visit.dayRef = day.dayId;
      visit.order = index;
      if (assignedSet.has(id)) {
        visit.removedFrom = null;
        visit.removedAt = null;
        visit.userAdjusted = true;
      }
    });
    affected.add(dayIndex);
  }

  // ---- 执行第三步：visit 容器分组放置（父内重排 + 备选提升）----
  for (const [visitId, assigns] of visitGroups) {
    const visit = trip.visits[visitId];
    if (visit === undefined) continue;
    const ordered = [...assigns].sort((x, y) => x.order - y.order);
    const assignedIds = ordered.map((a) => (a.subjectRef.kind === "stop" ? a.subjectRef.id : ""));
    const assignedSet = new Set(assignedIds);
    const rest = visit.childStopRefs.filter((id) => !assignedSet.has(id));
    visit.childStopRefs = [...assignedIds, ...rest];
    visit.childStopRefs.forEach((id, index) => {
      const stop = trip.stops[id];
      if (stop === undefined) return;
      stop.order = index;
      if (assignedSet.has(id)) {
        stop.state = "attached";
        stop.visitRef = visitId;
        stop.suggestedVisitRef = null;
        stop.removedFromOrder = null;
        stop.removedAt = null;
        stop.userAdjusted = true;
      }
    });
    const dayIndex = visitDayIndex(trip, visitId);
    if (dayIndex !== null) affected.add(dayIndex);
  }
  return null;
}

// ===== move =====

/** move：同一容器内改序（Visit 在 day 内 / Stop 在父 Visit 的 child 内）。toOrder 以取出前长度为界。 */
function applyMove(trip: Trip, op: MoveOp, affected: Set<number>, actor: OperationActor): string | null {
  if (!isEntityRef(op.subjectRef)) return "move.subjectRef 非法";
  if (!isContainerRef(op.containerRef)) return "move.containerRef 非法";

  if (op.subjectRef.kind === "visit") {
    if (op.containerRef.kind !== "day") return "move：Visit 只能在 day 容器内改序（跨天请使用 transfer）";
    const day = getDayByIndex(trip, op.containerRef.dayIndex);
    if (day === null) return `move.containerRef.dayIndex 超出行程日期范围：${op.containerRef.dayIndex}`;
    const visit = trip.visits[op.subjectRef.id];
    if (visit === undefined) return `move：visit ${op.subjectRef.id} 不存在`;
    const from = day.scheduleVisitRefs.indexOf(op.subjectRef.id);
    if (from === -1) return `move：「${visitName(trip, op.subjectRef.id)}」不在 Day${op.containerRef.dayIndex} 的行程中`;
    const guardErr = guardProtectedVisit(trip, visit, actor, "move");
    if (guardErr !== null) return guardErr;
    if (!isValidOrder(op.toOrder, day.scheduleVisitRefs.length - 1)) {
      return `move.toOrder 越界：${op.toOrder}（Day${op.containerRef.dayIndex} 合法范围 0-${day.scheduleVisitRefs.length - 1}）`;
    }
    day.scheduleVisitRefs.splice(from, 1);
    day.scheduleVisitRefs.splice(op.toOrder, 0, op.subjectRef.id);
    day.scheduleVisitRefs.forEach((id, index) => {
      const v = trip.visits[id];
      if (v !== undefined) v.order = index;
    });
    visit.userAdjusted = true;
    affected.add(op.containerRef.dayIndex);
    return null;
  }

  if (op.subjectRef.kind === "stop") {
    if (op.containerRef.kind !== "visit") return "move：内部玩法只能在 visit 容器内改序";
    const stop = trip.stops[op.subjectRef.id];
    if (stop === undefined) return `move：stop ${op.subjectRef.id} 不存在`;
    const visit = trip.visits[op.containerRef.id];
    if (visit === undefined) return `move：visit ${op.containerRef.id} 不存在`;
    if (stop.state === "pending") return `move：待定加入的内部玩法不在任何大景区内，无法改序`;
    if (stop.visitRef !== op.containerRef.id) {
      return `move：内部玩法「${stopName(trip, stop.stopId)}」不属于该大景区`;
    }
    const from = visit.childStopRefs.indexOf(op.subjectRef.id);
    if (from === -1) return "move：备选玩法不支持排序，请先放回岛内行程";
    if (!isValidOrder(op.toOrder, visit.childStopRefs.length - 1)) {
      return `move.toOrder 越界：${op.toOrder}（合法范围 0-${visit.childStopRefs.length - 1}）`;
    }
    visit.childStopRefs.splice(from, 1);
    visit.childStopRefs.splice(op.toOrder, 0, op.subjectRef.id);
    visit.childStopRefs.forEach((id, index) => {
      const s = trip.stops[id];
      if (s !== undefined) s.order = index;
    });
    stop.userAdjusted = true;
    const dayIndex = visitDayIndex(trip, op.containerRef.id);
    if (dayIndex !== null) affected.add(dayIndex);
    return null;
  }

  return `move 不支持 ${String(op.subjectRef.kind)} 类型的 subjectRef`;
}

// ===== transfer =====

/**
 * transfer（PRD §9.4 / §6.3）：
 * - Visit：跨 Day 移动（from day/globalPool → to day），child/alternate Stop 随 Visit 整组携带；
 * - Stop：仅归类纠正（visit ↔ pendingPool / visitPool / 另一 Visit），不得改变 dayIndex——
 *   源 Visit 与目标 Visit 均已排期时必须在同一天；归类纠正记录 decidedBy=user，
 *   系统自动判断不得再次覆盖（PRD §6.3）。
 */
function applyTransfer(trip: Trip, op: TransferOp, affected: Set<number>, actor: OperationActor): string | null {
  if (!isEntityRef(op.subjectRef)) return "transfer.subjectRef 非法";
  if (!isContainerRef(op.fromContainerRef)) return "transfer.fromContainerRef 非法";
  if (!isContainerRef(op.toContainerRef)) return "transfer.toContainerRef 非法";

  if (op.subjectRef.kind === "visit") {
    if (op.toContainerRef.kind !== "day") return "transfer：Visit 只能转移到 day 容器（移出请使用 remove）";
    const dst = getDayByIndex(trip, op.toContainerRef.dayIndex);
    if (dst === null) return `transfer.toContainerRef.dayIndex 超出行程日期范围：${op.toContainerRef.dayIndex}`;
    const visitId = op.subjectRef.id;
    const visit = trip.visits[visitId];
    if (visit === undefined) return `transfer：visit ${visitId} 不存在`;

    // 预检 from（只读）
    let srcDay: Day | null = null;
    if (op.fromContainerRef.kind === "day") {
      srcDay = getDayByIndex(trip, op.fromContainerRef.dayIndex);
      if (srcDay === null) return `transfer.fromContainerRef.dayIndex 超出行程日期范围：${op.fromContainerRef.dayIndex}`;
      if (!srcDay.scheduleVisitRefs.includes(visitId)) {
        return `transfer：「${visitName(trip, visitId)}」不在 Day${op.fromContainerRef.dayIndex} 的行程中`;
      }
    } else if (op.fromContainerRef.kind === "globalPool") {
      if (visit.dayRef !== null) return `transfer：「${visitName(trip, visitId)}」不在全局候选区`;
    } else {
      return "transfer：Visit 的 fromContainerRef 只能是 day 或 globalPool";
    }

    const guardErr = guardProtectedVisit(trip, visit, actor, "transfer");
    if (guardErr !== null) return guardErr;

    const toOrder = op.toOrder === null ? dst.scheduleVisitRefs.length : op.toOrder;
    if (!isValidOrder(toOrder, dst.scheduleVisitRefs.length)) {
      return `transfer.toOrder 越界：${String(op.toOrder)}（Day${dst.dayIndex} 合法范围 0-${dst.scheduleVisitRefs.length}）`;
    }

    // 执行：源容器移除 → 目标天插入；子项（child/alternate）随 Visit 引用自动携带
    if (srcDay !== null) {
      const idx = srcDay.scheduleVisitRefs.indexOf(visitId);
      srcDay.scheduleVisitRefs.splice(idx, 1);
      srcDay.scheduleVisitRefs.forEach((id, index) => {
        const v = trip.visits[id];
        if (v !== undefined) v.order = index;
      });
      affected.add(srcDay.dayIndex);
    } else {
      trip.globalCandidateRefs = trip.globalCandidateRefs.filter(
        (ref) => !(ref.kind === "visit" && ref.id === visitId),
      );
    }
    dst.scheduleVisitRefs.splice(toOrder, 0, visitId);
    dst.scheduleVisitRefs.forEach((id, index) => {
      const v = trip.visits[id];
      if (v !== undefined) {
        v.dayRef = dst.dayId;
        v.order = index;
      }
    });
    visit.userAdjusted = true;
    visit.removedFrom = null;
    visit.removedAt = null;
    affected.add(dst.dayIndex);
    return null;
  }

  if (op.subjectRef.kind === "stop") {
    return transferStop(trip, op, affected, actor);
  }

  return `transfer 不支持 ${String(op.subjectRef.kind)} 类型的 subjectRef`;
}

/**
 * Stop 归类纠正（transfer 子过程）：visit ↔ pendingPool / visitPool / 另一 Visit，不改 dayIndex。
 *
 * pending 归类保护（Task #105）：state=pending 的内部玩法只能由用户确认归类，actor=
 * ai_proposed 时任何 touch pending 的 transfer（从 pendingPool 归入景区 / 移回
 * pendingPool）一律拒绝——执行器兜底，防止绕过护栏的调用越过「用户确认归类」红线。
 * userAdjusted / decidedBy="user" 也只在用户通道写入，避免 AI 操作伪装成用户手动调整
 * 而影响 G4 重排保护与「系统自动判断不得覆盖」的语义。
 */
function transferStop(trip: Trip, op: TransferOp, affected: Set<number>, actor: OperationActor): string | null {
  if (op.subjectRef.kind !== "stop") return "transfer：内部玩法的 subjectRef 须为 stop";
  const stopId = op.subjectRef.id;
  const stop = trip.stops[stopId];
  if (stop === undefined) return `transfer：stop ${stopId} 不存在`;
  if (stop.state === "pending" && op.fromContainerRef.kind !== "pendingPool") {
    return `transfer：待定加入的内部玩法须从 pendingPool 取出`;
  }
  if (
    actor === "ai_proposed" &&
    (stop.state === "pending" ||
      op.fromContainerRef.kind === "pendingPool" ||
      op.toContainerRef.kind === "pendingPool")
  ) {
    return `transfer：「${stopName(trip, stop.stopId)}」的归类（待定加入 ↔ 大景区）是用户的决定，AI 不能代替确认；请由用户在前端确认归类`;
  }

  // ---- 预检 from（只读解析当前位置）----
  let fromVisit: Visit | null = null;
  let fromWhere: "child" | "alternate" | "pendingPool" | null = null;
  if (op.fromContainerRef.kind === "visit") {
    const owner = trip.visits[op.fromContainerRef.id];
    if (owner === undefined) return `transfer：visit ${op.fromContainerRef.id} 不存在`;
    if (owner.childStopRefs.includes(stopId)) {
      fromVisit = owner;
      fromWhere = "child";
    } else if (owner.alternateStopRefs.includes(stopId)) {
      fromVisit = owner;
      fromWhere = "alternate";
    } else {
      return `transfer：内部玩法「${stopName(trip, stop.stopId)}」不在该大景区的内部玩法或备选中`;
    }
  } else if (op.fromContainerRef.kind === "visitPool") {
    const owner = trip.visits[op.fromContainerRef.visitId];
    if (owner === undefined) return `transfer：visit ${op.fromContainerRef.visitId} 不存在`;
    if (!owner.alternateStopRefs.includes(stopId)) {
      return `transfer：内部玩法「${stopName(trip, stop.stopId)}」不在该大景区的备选玩法中`;
    }
    fromVisit = owner;
    fromWhere = "alternate";
  } else if (op.fromContainerRef.kind === "pendingPool") {
    if (stop.state !== "pending" || !trip.pendingStopRefs.includes(stopId)) {
      return `transfer：内部玩法「${stopName(trip, stop.stopId)}」不在待定加入区`;
    }
    fromWhere = "pendingPool";
  } else {
    return "transfer：内部玩法的 fromContainerRef 只能是 visit / visitPool / pendingPool";
  }

  // ---- 预检 to（只读解析目标位置）----
  let toVisit: Visit | null = null;
  let toWhere: "child" | "alternate" | "pendingPool" | null = null;
  let insertOrder: number | null = null;
  if (op.toContainerRef.kind === "visit") {
    const target = trip.visits[op.toContainerRef.id];
    if (target === undefined) return `transfer：visit ${op.toContainerRef.id} 不存在`;
    if (target.childStopRefs.includes(stopId)) {
      return `transfer：内部玩法「${stopName(trip, stop.stopId)}」已在该大景区的岛内行程中，无需转移`;
    }
    toVisit = target;
    toWhere = "child";
    if (op.toOrder !== null) {
      if (!isValidOrder(op.toOrder, target.childStopRefs.length)) {
        return `transfer.toOrder 越界：${op.toOrder}（合法范围 0-${target.childStopRefs.length}）`;
      }
      insertOrder = op.toOrder;
    }
  } else if (op.toContainerRef.kind === "visitPool") {
    const target = trip.visits[op.toContainerRef.visitId];
    if (target === undefined) return `transfer：visit ${op.toContainerRef.visitId} 不存在`;
    if (target.alternateStopRefs.includes(stopId)) {
      return `transfer：内部玩法「${stopName(trip, stop.stopId)}」已在该大景区的备选玩法中，无需转移`;
    }
    toVisit = target;
    toWhere = "alternate";
    if (op.toOrder !== null) return "transfer：转入备选玩法时不支持 toOrder";
  } else if (op.toContainerRef.kind === "pendingPool") {
    if (trip.pendingStopRefs.includes(stopId)) {
      return `transfer：内部玩法「${stopName(trip, stop.stopId)}」已在待定加入区`;
    }
    toWhere = "pendingPool";
    if (op.toOrder !== null) return "transfer：转入待定加入区时不支持 toOrder";
  } else {
    return "transfer：内部玩法的 toContainerRef 只能是 visit / visitPool / pendingPool";
  }

  // ---- 同天校验：归类纠正不得改变 dayIndex（PRD §12.1）----
  const fromDayIndex = fromVisit !== null ? visitDayIndex(trip, fromVisit.visitId) : null;
  const toDayIndex = toVisit !== null ? visitDayIndex(trip, toVisit.visitId) : null;
  if (fromDayIndex !== null && toDayIndex !== null && fromDayIndex !== toDayIndex) {
    return `transfer：内部玩法不支持跨天移动（Day${fromDayIndex} → Day${toDayIndex}）。换景区的归类纠正只能指向同一天的大景区；跨天调整请移动大景区本身`;
  }

  // ---- 执行 ----
  if (fromWhere === "child") {
    fromVisit!.childStopRefs = fromVisit!.childStopRefs.filter((id) => id !== stopId);
  } else if (fromWhere === "alternate") {
    fromVisit!.alternateStopRefs = fromVisit!.alternateStopRefs.filter((id) => id !== stopId);
  } else {
    trip.pendingStopRefs = trip.pendingStopRefs.filter((id) => id !== stopId);
  }
  if (fromVisit !== null) renumberStops(trip, fromVisit);

  if (toWhere === "child") {
    const target = insertOrder === null ? toVisit!.childStopRefs.length : insertOrder;
    toVisit!.childStopRefs.splice(target, 0, stopId);
    stop.state = "attached";
    stop.visitRef = toVisit!.visitId;
    stop.suggestedVisitRef = null;
    stop.removedFromOrder = null;
    stop.removedAt = null;
  } else if (toWhere === "alternate") {
    toVisit!.alternateStopRefs.push(stopId);
    stop.state = "attached";
    stop.visitRef = toVisit!.visitId;
    stop.suggestedVisitRef = null;
  } else {
    trip.pendingStopRefs.push(stopId);
    stop.state = "pending";
    stop.visitRef = null;
    stop.suggestedVisitRef = null; // 用户主动移出归类：清空建议，自动判断不得再覆盖
    stop.order = null;
  }
  if (toVisit !== null) renumberStops(trip, toVisit);

  // 用户归类纠正优先：decidedBy=user（PRD §6.3），后续自动判断不得覆盖。
  // 仅用户通道写入（Task #105）：AI 的 transfer 不得把归类结果标成用户决定。
  if (actor !== "ai_proposed") {
    stop.userAdjusted = true;
    const suggestion = trip.relationshipSuggestions[stopId];
    if (suggestion !== undefined) suggestion.decidedBy = "user";
  }

  if (fromDayIndex !== null) affected.add(fromDayIndex);
  if (toDayIndex !== null) affected.add(toDayIndex);
  return null;
}

// ===== remove =====

/**
 * remove（confirmed 通道专用，PRD §10.3 移除语义）：
 * - Visit（from day）：仅 VisitRef 进入 globalCandidateRefs；childStopRefs/alternateStopRefs
 *   保持挂载、Stop 与 Evidence 不动（撤销或重新加入时原图谱原子恢复）；记录 removedFrom/removedAt；
 * - Stop（from visit）：移入父 Visit 的备选玩法（visitPool 语义），记录 removedFromOrder/removedAt；
 * - Point（from globalPool）：仅解除候选引用，itemRegistry 主数据保留（M1 无不可逆删除）；
 * - locked / bought 的 Visit 一律拒绝（先解锁 / 走改订，两条通道一致）；
 * - Lodging 不支持 remove：酒店移除/更换走住宿专用行为，不套点位候选池语义。
 */
function applyRemove(trip: Trip, op: RemoveOp, affected: Set<number>): string | null {
  if (!isEntityRef(op.subjectRef)) return "remove.subjectRef 非法";
  if (!isContainerRef(op.fromContainerRef)) return "remove.fromContainerRef 非法";

  if (op.subjectRef.kind === "visit") {
    if (op.fromContainerRef.kind !== "day") return "remove：Visit 的 fromContainerRef 只能是 day";
    const day = getDayByIndex(trip, op.fromContainerRef.dayIndex);
    if (day === null) return `remove.fromContainerRef.dayIndex 超出行程日期范围：${op.fromContainerRef.dayIndex}`;
    const idx = day.scheduleVisitRefs.indexOf(op.subjectRef.id);
    if (idx === -1) return `remove：「${visitName(trip, op.subjectRef.id)}」不在 Day${day.dayIndex} 的行程中`;
    const visit = trip.visits[op.subjectRef.id]!;
    if (visit.locked) return `remove：「${visitName(trip, op.subjectRef.id)}」已被锁定，须先解锁`;
    if (visit.purchaseState === "bought") {
      return `remove：「${visitName(trip, op.subjectRef.id)}」门票已购，不可移除（如行程有变请走改订流程）`;
    }
    day.scheduleVisitRefs.splice(idx, 1);
    day.scheduleVisitRefs.forEach((id, index) => {
      const v = trip.visits[id];
      if (v !== undefined) v.order = index;
    });
    visit.dayRef = null;
    visit.order = null;
    visit.removedFrom = { dayIndex: day.dayIndex, order: idx };
    visit.removedAt = new Date().toISOString();
    trip.globalCandidateRefs.push({ kind: "visit", id: op.subjectRef.id });
    // 其余字段（时间/交通/子项挂载）原样保留：撤销或重新加入时原子恢复
    affected.add(day.dayIndex);
    return null;
  }

  if (op.subjectRef.kind === "stop") {
    const stop = trip.stops[op.subjectRef.id];
    if (stop === undefined) return `remove：stop ${op.subjectRef.id} 不存在`;
    if (op.fromContainerRef.kind !== "visit") {
      if (op.fromContainerRef.kind === "visitPool") return "remove：该内部玩法已在备选玩法中，无需再次移除";
      if (op.fromContainerRef.kind === "pendingPool") return "remove：待定加入的内部玩法请通过归类（transfer）处理";
      return "remove：内部玩法的 fromContainerRef 只能是 visit";
    }
    const visit = trip.visits[op.fromContainerRef.id];
    if (visit === undefined) return `remove：visit ${op.fromContainerRef.id} 不存在`;
    const idx = visit.childStopRefs.indexOf(op.subjectRef.id);
    if (idx === -1) return "remove：该内部玩法已在备选玩法中，无需再次移除";
    visit.childStopRefs.splice(idx, 1);
    visit.childStopRefs.forEach((id, index) => {
      const s = trip.stops[id];
      if (s !== undefined) s.order = index;
    });
    visit.alternateStopRefs.push(op.subjectRef.id);
    stop.removedFromOrder = idx;
    stop.removedAt = new Date().toISOString();
    stop.order = visit.alternateStopRefs.length - 1;
    // state=attached / visitRef / suggestMinutes / locationHint / ticketRelation / 证据全部保留
    const dayIndex = visitDayIndex(trip, visit.visitId);
    if (dayIndex !== null) affected.add(dayIndex);
    return null;
  }

  if (op.subjectRef.kind === "point") {
    if (op.fromContainerRef.kind !== "globalPool") return "remove：未安排点位的 fromContainerRef 只能是 globalPool";
    const pointId = op.subjectRef.id;
    if (!inGlobalPool(trip, "point", pointId)) {
      return `remove：point ${pointId} 不在全局候选区`;
    }
    trip.globalCandidateRefs = trip.globalCandidateRefs.filter(
      (ref) => !(ref.kind === "point" && ref.id === pointId),
    );
    // itemRegistry 主数据保留：手工添加可再引入（M1 无不可逆删除）
    return null;
  }

  if (op.subjectRef.kind === "lodging") {
    return "remove：酒店移除/更换须走住宿专用流程，不套用点位候选池语义";
  }
  return `remove 不支持 ${String(op.subjectRef.kind)} 类型的 subjectRef`;
}

// ===== setTime =====

/**
 * setTime（PRD §9.4）：
 * - day + dayDepart：更新当天出发时间并标记覆写；
 * - visit + start/end：写覆写标记（timeline 重算时保留为锚点）；
 * - lodging + start/end：写 checkInTime / checkOutTime；
 * - Stop 不支持 setTime（只维护顺序、建议时长、位置提示、票务关系）。
 */
function applySetTime(trip: Trip, op: SetTimeOp, affected: Set<number>, actor: OperationActor): string | null {
  if (typeof op.value !== "string" || !TIME_PATTERN.test(op.value)) {
    return `setTime.value 非法：${String(op.value)}（须为 HH:MM 格式）`;
  }
  if (!isEntityRef(op.subjectRef)) return "setTime.subjectRef 非法";

  if (op.subjectRef.kind === "day") {
    if (op.target !== "dayDepart") return "setTime：Day 只支持 target=dayDepart";
    const day = getDayByIndex(trip, op.subjectRef.dayIndex);
    if (day === null) return `setTime.dayIndex 超出行程日期范围：${op.subjectRef.dayIndex}`;
    day.departTime = op.value;
    day.departTimeOverridden = true;
    affected.add(op.subjectRef.dayIndex);
    return null;
  }

  if (op.subjectRef.kind === "visit") {
    if (op.target === "dayDepart") return "setTime：Visit 不支持 target=dayDepart（请对 Day 设置出发时间）";
    const visit = trip.visits[op.subjectRef.id];
    if (visit === undefined) return `setTime：visit ${op.subjectRef.id} 不存在`;
    const loc = findVisitLocation(trip, op.subjectRef.id);
    if (loc === null || loc.where !== "day") {
      return `setTime：「${visitName(trip, op.subjectRef.id)}」未排入任何一天，无法设置时间`;
    }
    const guardErr = guardProtectedVisit(trip, visit, actor, "setTime");
    if (guardErr !== null) return guardErr;
    if (op.target === "start") {
      visit.startTime = op.value;
      visit.startTimeOverridden = true;
    } else {
      visit.endTime = op.value;
      visit.endTimeOverridden = true;
    }
    visit.userAdjusted = true;
    affected.add(loc.dayIndex);
    return null;
  }

  if (op.subjectRef.kind === "lodging") {
    if (op.target === "dayDepart") return "setTime：住宿不支持 target=dayDepart";
    const plan = trip.lodgings[String(op.subjectRef.dayIndex)];
    if (plan === undefined) return `setTime：Day${op.subjectRef.dayIndex} 无住宿计划`;
    const guardErr = guardProtectedLodging(plan, actor, "setTime");
    if (guardErr !== null) return guardErr;
    if (op.target === "start") {
      plan.checkInTime = op.value;
    } else {
      plan.checkOutTime = op.value;
    }
    plan.userAdjusted = true;
    return null;
  }

  if (op.subjectRef.kind === "stop") {
    return "setTime：内部玩法不支持设置具体开始时间（只维护顺序、建议时长、位置提示、票务关系）";
  }
  return `setTime 不支持 ${String(op.subjectRef.kind)} 类型的 subjectRef`;
}

// ===== setDuration =====

/** setDuration：Visit 写 reservedMinutes / Stop 写 suggestMinutes；须为正整数且 ≤ 配置上限。 */
function applySetDuration(trip: Trip, op: SetDurationOp, affected: Set<number>, actor: OperationActor): string | null {
  if (!isEntityRef(op.subjectRef)) return "setDuration.subjectRef 非法";
  if (typeof op.minutes !== "number" || !Number.isInteger(op.minutes) || op.minutes <= 0) {
    return `setDuration.minutes 非法：${String(op.minutes)}（须为正整数）`;
  }
  if (op.minutes > MAX_SETTABLE_MINUTES) {
    return `setDuration.minutes 超出配置上限：${op.minutes}（最大 ${MAX_SETTABLE_MINUTES}）`;
  }

  if (op.subjectRef.kind === "visit") {
    const visit = trip.visits[op.subjectRef.id];
    if (visit === undefined) return `setDuration：visit ${op.subjectRef.id} 不存在`;
    const loc = findVisitLocation(trip, op.subjectRef.id);
    if (loc === null || loc.where !== "day") {
      return `setDuration：「${visitName(trip, op.subjectRef.id)}」未排入任何一天，无法设置时长`;
    }
    const guardErr = guardProtectedVisit(trip, visit, actor, "setDuration");
    if (guardErr !== null) return guardErr;
    visit.reservedMinutes = op.minutes;
    visit.userAdjusted = true;
    affected.add(loc.dayIndex);
    return null;
  }

  if (op.subjectRef.kind === "stop") {
    const stop = trip.stops[op.subjectRef.id];
    if (stop === undefined) return `setDuration：stop ${op.subjectRef.id} 不存在`;
    if (stop.state === "pending") return "setDuration：待定加入的内部玩法不在任何大景区内，请先归类";
    if (stop.visitRef === null) return "setDuration：内部玩法归属不一致，无法设置时长";
    stop.suggestMinutes = op.minutes;
    stop.userAdjusted = true;
    const dayIndex = visitDayIndex(trip, stop.visitRef);
    if (dayIndex !== null) affected.add(dayIndex);
    return null;
  }

  return `setDuration 不支持 ${String(op.subjectRef.kind)} 类型的 subjectRef`;
}

// ===== setPurchase（confirmed 通道专用） =====

/** setPurchase：仅 Visit / Lodging；Stop 不支持独立购买状态（票务由父景区承担）。 */
function applySetPurchase(trip: Trip, op: SetPurchaseOp): string | null {
  if (!isEntityRef(op.subjectRef)) return "setPurchase.subjectRef 非法";
  const values = new Set(["bought", "toBuy", "unknown", "noTicket"]);
  if (typeof op.value !== "string" || !values.has(op.value)) {
    return `setPurchase.value 非法：${String(op.value)}`;
  }

  if (op.subjectRef.kind === "visit") {
    const visit = trip.visits[op.subjectRef.id];
    if (visit === undefined) return `setPurchase：visit ${op.subjectRef.id} 不存在`;
    visit.purchaseState = op.value;
    return null;
  }
  if (op.subjectRef.kind === "lodging") {
    if (op.value === "noTicket") return "setPurchase：住宿没有免票档（unknown / toBuy / bought）";
    const plan = trip.lodgings[String(op.subjectRef.dayIndex)];
    if (plan === undefined) return `setPurchase：Day${op.subjectRef.dayIndex} 无住宿计划`;
    plan.purchaseState = op.value;
    return null;
  }
  if (op.subjectRef.kind === "stop") {
    return "setPurchase：内部玩法不支持独立购买状态（票务由父景区大门票承担）";
  }
  return `setPurchase 不支持 ${String(op.subjectRef.kind)} 类型的 subjectRef`;
}

// ===== lock（confirmed 通道专用） =====

/** lock：仅 Visit / Lodging；锁与购买状态独立（PRD §9.4）。 */
function applyLock(trip: Trip, op: LockOp): string | null {
  if (!isEntityRef(op.subjectRef)) return "lock.subjectRef 非法";
  if (typeof op.value !== "boolean") return `lock.value 非法：${String(op.value)}（须为布尔值）`;

  if (op.subjectRef.kind === "visit") {
    const visit = trip.visits[op.subjectRef.id];
    if (visit === undefined) return `lock：visit ${op.subjectRef.id} 不存在`;
    visit.locked = op.value;
    return null;
  }
  if (op.subjectRef.kind === "lodging") {
    const plan = trip.lodgings[String(op.subjectRef.dayIndex)];
    if (plan === undefined) return `lock：Day${op.subjectRef.dayIndex} 无住宿计划`;
    plan.locked = op.value;
    return null;
  }
  if (op.subjectRef.kind === "stop") {
    return "lock：内部玩法不支持锁定（锁定属于 Visit，随父景区整体生效）";
  }
  return `lock 不支持 ${String(op.subjectRef.kind)} 类型的 subjectRef`;
}

// ===== addLodgingCandidate（rev2 创建族扩展） =====

/**
 * addLodgingCandidate（rev2 附录 A 住宿多候选）：向指定天的住宿区追加酒店候选。
 *
 * - 创建族低风险操作：不改动已有选中态，与 plan 同级可直接应用，不入 needsProposal；
 * - dayIndex 沿用全局约定从 1 开始（越界拒绝，不夹取）；
 * - hotelId 必须已存在于 trip.hotelRegistry：执行器只挂引用，不创建酒店主数据
 *   （酒店入库由 FlyAI 搜索 / 自定义酒店表单等上游通道负责）；
 * - 当天无 LodgingPlan 时自动创建空候选计划（hotelCandidate=null / status=placeholder
 *   与种子数据形态对齐，避免旧消费方读到 undefined）；
 * - 候选已在 hotelRefs 中时幂等跳过（不重复追加，视为成功）；
 * - 仅追加候选引用，不写 deprecated hotelCandidate / status 选中态；
 *   与现有 lodging 写入路径（setTime/setPurchase/lock）一致，不触发当天时间轴重算。
 */
function applyAddLodgingCandidate(trip: Trip, op: AddLodgingCandidateOp): string | null {
  if (!Number.isInteger(op.dayIndex)) {
    return `addLodgingCandidate.dayIndex 非法：${String(op.dayIndex)}（须为整数，从 1 开始）`;
  }
  if (typeof op.hotelId !== "string" || op.hotelId === "") {
    return `addLodgingCandidate.hotelId 非法：${String(op.hotelId)}（须为非空字符串）`;
  }
  const day = getDayByIndex(trip, op.dayIndex);
  if (day === null) {
    return `addLodgingCandidate.dayIndex 超出行程日期范围：${op.dayIndex}`;
  }
  if (trip.hotelRegistry[op.hotelId] === undefined) {
    return `addLodgingCandidate 引用了 hotelRegistry 中不存在的酒店：${op.hotelId}`;
  }

  let plan = trip.lodgings[String(op.dayIndex)];
  if (plan === undefined) {
    plan = {
      dayIndex: op.dayIndex,
      hotelRefs: [],
      hotelCandidate: null,
      status: "placeholder",
      checkInTime: null,
      checkOutTime: null,
      purchaseState: "unknown",
      locked: false,
      userAdjusted: true,
    };
    trip.lodgings[String(op.dayIndex)] = plan;
  }
  // 运行时防御：早期落盘 / 手工构造的 LodgingPlan 可能缺 hotelRefs（rev2 迁移契约兜底）
  if (!Array.isArray(plan.hotelRefs)) plan.hotelRefs = [];
  if (plan.hotelRefs.includes(op.hotelId)) return null; // 幂等：已在候选列表，不重复追加
  plan.hotelRefs.push(op.hotelId);
  plan.userAdjusted = true;
  return null;
}

// ===== classifyVisitAsStop（Task #122 归类族扩展） =====

/**
 * Visit 证据作用域：该 Visit 可追溯的原文提及引用与裸证据 id 集合。
 * 两个集合粒度不同，命中规则也不同：
 * - mentionRefs：visit.sourceMentionRefs / guideSnippets 的完整引用
 *   （"evidenceId:mentionId"），溯源精确到提及条目，只允许精确命中——
 *   同一证据下指向其他实体的提及不得借用（否则单侧证据判定被架空）；
 * - evidenceIds：关联 Item.sourceEvidenceRefs 的裸证据 id（主数据只记录
 *   「该点位来自哪个证据」，不到提及粒度），该证据下任一提及均可命中。
 * 供 classifyVisitAsStop 的强证据追溯判定（guards 与执行器共用同一实现）。
 */
export interface VisitEvidenceScope {
  /** 精确提及引用集合，格式 "evidenceId:mentionId" */
  mentionRefs: Set<string>;
  /** 裸证据 id 集合（仅 Item 主数据来源，不到提及粒度） */
  evidenceIds: Set<string>;
}

/** 收集 Visit 侧证据作用域（悬空引用静默忽略，悬空由 consistency 兜底） */
export function collectVisitEvidenceScope(trip: Trip, visit: Visit): VisitEvidenceScope {
  const mentionRefs = new Set<string>();
  const evidenceIds = new Set<string>();
  for (const ref of visit.sourceMentionRefs ?? []) {
    if (typeof ref === "string") mentionRefs.add(ref);
  }
  for (const snippet of visit.guideSnippets ?? []) {
    for (const ref of snippet.sourceMentionRefs) {
      if (typeof ref === "string") mentionRefs.add(ref);
    }
  }
  const item = trip.itemRegistry[visit.pointRef];
  if (item !== undefined && Array.isArray(item.sourceEvidenceRefs)) {
    for (const entry of item.sourceEvidenceRefs) {
      if (typeof entry !== "string" || entry === "") continue;
      if (entry.includes(":")) mentionRefs.add(entry); // 完整引用按提及粒度精确命中
      else evidenceIds.add(entry); // 裸证据 id 按主数据粒度命中
    }
  }
  return { mentionRefs, evidenceIds };
}

/**
 * 提及引用是否可追溯到该作用域：精确命中提及引用（mention 级溯源），
 * 或其证据 id 命中裸证据 id 集合（Item 主数据级溯源，不到提及粒度）。
 */
export function mentionRefTracesTo(scope: VisitEvidenceScope, ref: string): boolean {
  if (scope.mentionRefs.has(ref)) return true;
  const parsed = parseMentionRef(ref);
  return parsed !== null && scope.evidenceIds.has(parsed.evidenceId);
}

/** 字符串去重保序（证据引用合并用，不丢任何一侧） */
function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

/** guideSnippets 按 snippetId 去重合并（保序；空集返回 undefined 保持旧数据形态） */
function mergeGuideSnippets(
  base: GuideSnippet[] | undefined,
  incoming: GuideSnippet[] | undefined,
): GuideSnippet[] | undefined {
  const merged: GuideSnippet[] = [...(base ?? [])];
  const seen = new Set(merged.map((snippet) => snippet.snippetId));
  for (const snippet of incoming ?? []) {
    if (seen.has(snippet.snippetId)) continue;
    merged.push(snippet);
    seen.add(snippet.snippetId);
  }
  return merged.length > 0 ? merged : undefined;
}

/**
 * classifyVisitAsStop（Task #122）：把 ordinary Visit 原子转换为 large_attraction 的内部 Stop。
 *
 * - 身份转换：创建或复用 Stop——命中飞猪的来源经 matchedPointRef 继承 Item 引用
 *   （名称 / 图片 / 地址 / 详情链接继续从 itemRegistry 解析），custom 来源落 customName
 *   （与手工添加内部玩法的字段约定一致）；visit 的 sourceMentionRefs / guideSnippets /
 *   操作自带强证据引用全部并入 Stop（按 id 去重，不丢证据）；原 Visit 从 trip.visits
 *   删除——停留身份已转换，若保留会因「不属于任何天也不在 globalPool」破坏一致性；
 * - 旧引用清理：Day.scheduleVisitRefs（其余项保序重排）、Day.displayOrder、
 *   globalCandidateRefs 与防御性 suggestedVisitRef 回填全部移除，避免重复占用；
 * - 幂等：Stop.classifiedFromVisitRef 记录来源 visitId——同一 op 重放时仅合并新带的
 *   证据引用后幂等返回成功，不新建重复 Stop；目标已有同 identity 的 Stop 时复用并
 *   合并（护栏对非重放的重复 identity 先行拒绝，同 addLodgingCandidate 先例）；
 * - 强证据兜底：AI 通道与护栏同源的追溯校验（弱证据拒绝），防止自动归类越过红线；
 *   Task #199 起用户手动通道（user_manual / user_confirmed）允许证据为空——用户的
 *   选择本身即依据，只保留「显式引用可解析」的数据卫生校验；
 * - actor 语义：AI 仅在强证据全部通过时放行；来源 locked / bought 一律拒绝
 *   （与 remove 同级红线，用户确认也不豁免）；目标 locked 一律拒绝、bought 对 AI 拒绝；
 * - 归属档案：新建 Stop 写入 relationshipSuggestions（level=high，decidedBy 按通道：
 *   AI=system / 用户=user），AI 通道不写 userAdjusted（不得伪装成用户调整）；
 * - affected：来源原在天与目标所在天各做一次局部时间轴重算（Stop 汇总参与时长）。
 */
function applyClassifyVisitAsStop(
  trip: Trip,
  op: ClassifyVisitAsStopOp,
  affected: Set<number>,
  actor: OperationActor,
): string | null {
  // ---- 形状预检（不信任模型 JSON）----
  if (typeof op.visitId !== "string" || op.visitId === "") {
    return `classifyVisitAsStop.visitId 非法：${String(op.visitId)}（须为非空字符串）`;
  }
  if (typeof op.parentVisitId !== "string" || op.parentVisitId === "") {
    return `classifyVisitAsStop.parentVisitId 非法：${String(op.parentVisitId)}（须为非空字符串）`;
  }
  if (op.toOrder !== null && !isValidOrder(op.toOrder, Number.MAX_SAFE_INTEGER)) {
    return `classifyVisitAsStop.toOrder 非法：${String(op.toOrder)}（须为非负整数或 null）`;
  }
  // Task #199：强证据门槛按通道分流——AI 不得自动归类（必须强证据），用户手动归入
  // 允许不带证据（用户的选择本身即依据）。显式携带的引用仍须可解析，避免悬空引用写入 Stop。
  const requiresStrongEvidence = actor === "ai_proposed";
  if (!Array.isArray(op.evidenceMentionRefs)) {
    return "classifyVisitAsStop.evidenceMentionRefs 非法：须为字符串数组";
  }
  if (requiresStrongEvidence && op.evidenceMentionRefs.length === 0) {
    return "classifyVisitAsStop 缺少强关系证据（evidenceMentionRefs 须为非空数组），弱证据不予归类";
  }
  for (const ref of op.evidenceMentionRefs) {
    if (typeof ref !== "string" || parseMentionRef(ref) === null) {
      return `classifyVisitAsStop.evidenceMentionRefs 存在非法引用（须为 "evidenceId:mentionId"）：${String(ref)}`;
    }
    if (resolveMentionRef(trip, ref) === null) {
      return `classifyVisitAsStop 强证据引用无法在 trip.evidences 中解析：${ref}（弱证据不予归类）`;
    }
  }

  // ---- 目标大景区解析（幂等重放路径同样要求目标合法）----
  const parent = trip.visits[op.parentVisitId];
  if (parent === undefined) {
    return `classifyVisitAsStop：目标大景区不存在：${op.parentVisitId}`;
  }
  if (parent.kind !== "large_attraction") {
    return `classifyVisitAsStop：目标「${visitName(trip, op.parentVisitId)}」不是大景区（只支持归入 large_attraction）`;
  }
  if (parent.locked) {
    return `classifyVisitAsStop：目标大景区「${visitName(trip, op.parentVisitId)}」已被锁定，须先解锁`;
  }
  if (actor === "ai_proposed" && parent.purchaseState === "bought") {
    return `classifyVisitAsStop：目标大景区「${visitName(trip, op.parentVisitId)}」门票已购，AI 不能改动（如需调整请由用户明确确认）`;
  }
  if (op.toOrder !== null && !isValidOrder(op.toOrder, parent.childStopRefs.length)) {
    return `classifyVisitAsStop.toOrder 越界：${op.toOrder}（合法范围 0-${parent.childStopRefs.length}）`;
  }

  // ---- 幂等重放：同一来源 visitId 已转换过（classifiedFromVisitRef 溯源）----
  const provenanceStopId = Object.keys(trip.stops).find(
    (stopId) => trip.stops[stopId]!.classifiedFromVisitRef === op.visitId,
  );
  if (
    provenanceStopId !== undefined &&
    (parent.childStopRefs.includes(provenanceStopId) || parent.alternateStopRefs.includes(provenanceStopId))
  ) {
    // 仅并入本次新带的证据引用（按 id 去重），不重复建 Stop、不改顺序
    const prev = trip.stops[provenanceStopId]!;
    prev.sourceMentionRefs = dedupeStrings([...prev.sourceMentionRefs, ...op.evidenceMentionRefs]);
    const evidenceIds = new Set(prev.sourceEvidenceRefs);
    for (const ref of op.evidenceMentionRefs) {
      const parsed = parseMentionRef(ref);
      if (parsed !== null) evidenceIds.add(parsed.evidenceId);
    }
    prev.sourceEvidenceRefs = [...evidenceIds];
    const parentDay = visitDayIndex(trip, parent.visitId);
    if (parentDay !== null) affected.add(parentDay);
    return null; // 幂等成功
  }
  if (provenanceStopId !== undefined) {
    return `classifyVisitAsStop：「${stopName(trip, provenanceStopId)}」已由该来源转换而来，但当前不在目标大景区内（如需调整归属请由用户使用归类纠正 transfer）`;
  }

  // ---- 来源 Visit 解析 ----
  const source = trip.visits[op.visitId];
  if (source === undefined) {
    return `classifyVisitAsStop：来源 visit 不存在（可能已转换或从未加入）：${op.visitId}`;
  }
  if (source.kind !== "ordinary") {
    return `classifyVisitAsStop：来源「${visitName(trip, op.visitId)}」不是普通景点（只支持 ordinary Visit 归入大景区）`;
  }
  if (source.locked) {
    return `classifyVisitAsStop：「${visitName(trip, op.visitId)}」已被锁定，须先解锁（用户确认也不豁免）`;
  }
  if (source.purchaseState === "bought") {
    return `classifyVisitAsStop：「${visitName(trip, op.visitId)}」门票已购，不可归入大景区（如行程有变请走改订流程）`;
  }
  if (source.childStopRefs.length > 0 || source.alternateStopRefs.length > 0) {
    return `classifyVisitAsStop：来源「${visitName(trip, op.visitId)}」携带内部玩法，数据异常，拒绝转换（请先人工核查）`;
  }
  const sourceItem = trip.itemRegistry[source.pointRef];
  if (sourceItem === undefined) {
    return `classifyVisitAsStop：来源 pointRef 指向不存在的 item：${source.pointRef}`;
  }

  // ---- 强证据追溯（仅 AI 通道，与 guards 同源语义）：全部引用可追溯至来源或目标，两侧各至少一条 ----
  if (requiresStrongEvidence) {
    const sourceScope = collectVisitEvidenceScope(trip, source);
    const parentScope = collectVisitEvidenceScope(trip, parent);
    let sourceTraced = 0;
    let parentTraced = 0;
    for (const ref of op.evidenceMentionRefs) {
      const inSource = mentionRefTracesTo(sourceScope, ref);
      const inParent = mentionRefTracesTo(parentScope, ref);
      if (!inSource && !inParent) {
        return `classifyVisitAsStop：证据 ${ref} 无法追溯至来源或目标（弱证据不予归类）`;
      }
      if (inSource) sourceTraced += 1;
      if (inParent) parentTraced += 1;
    }
    if (sourceTraced === 0 || parentTraced === 0) {
      return `classifyVisitAsStop：强关系证据须同时可追溯来源与目标两侧（当前来源侧 ${sourceTraced} 条 / 目标侧 ${parentTraced} 条），弱证据不予归类`;
    }
  }

  // ---- 目标内同 identity Stop 复用（避免同一点位在景区内外重复占用）----
  const matched = sourceItem.origin === "fliggy";
  const existing = [...parent.childStopRefs, ...parent.alternateStopRefs].find((stopId) => {
    const stop = trip.stops[stopId];
    if (stop === undefined) return false;
    if (matched) return stop.matchedPointRef === source.pointRef;
    return stop.matchedPointRef === null && stop.customName === sourceItem.name;
  });

  // ---- 移除来源 Visit 的全部独立占用（预检全部通过后才开始变更）----
  if (source.dayRef !== null) {
    const day = trip.days[source.dayRef];
    if (day !== undefined) {
      day.scheduleVisitRefs = day.scheduleVisitRefs.filter((id) => id !== op.visitId);
      day.scheduleVisitRefs.forEach((id, index) => {
        const v = trip.visits[id];
        if (v !== undefined) v.order = index;
      });
      if (Array.isArray(day.displayOrder)) {
        day.displayOrder = day.displayOrder.filter(
          (entry) => !(entry.kind === "visit" && entry.visitRef === op.visitId),
        );
      }
      affected.add(day.dayIndex);
    }
  } else {
    trip.globalCandidateRefs = trip.globalCandidateRefs.filter(
      (ref) => !(ref.kind === "visit" && ref.id === op.visitId),
    );
  }
  // 防御：归类建议不得再指向已删除的来源 visit（ordinary 正常不会被建议指向，兜底旧数据）
  for (const suggestion of Object.values(trip.relationshipSuggestions)) {
    if (suggestion.suggestedVisitRef === op.visitId) suggestion.suggestedVisitRef = null;
  }
  delete trip.visits[op.visitId];

  // ---- 证据迁移集合：visit 提及 + 操作强证据（去重）----
  const mergedMentionRefs = dedupeStrings([
    ...(source.sourceMentionRefs ?? []),
    ...op.evidenceMentionRefs,
  ]);
  const evidenceIdSet = new Set<string>();
  for (const ref of mergedMentionRefs) {
    const parsed = parseMentionRef(ref);
    if (parsed !== null) evidenceIdSet.add(parsed.evidenceId);
  }
  const mergedSnippets = source.guideSnippets;

  if (existing !== undefined) {
    // 复用：证据并入既有 Stop（去重），不新建、不改其在 child/alternate 中的位置；
    // 补写溯源以便同一 op 重放时命中幂等分支
    const target = trip.stops[existing]!;
    target.sourceMentionRefs = dedupeStrings([...target.sourceMentionRefs, ...mergedMentionRefs]);
    target.sourceEvidenceRefs = [...new Set([...target.sourceEvidenceRefs, ...evidenceIdSet])];
    const snippets = mergeGuideSnippets(target.guideSnippets, mergedSnippets);
    if (snippets !== undefined) target.guideSnippets = snippets;
    target.classifiedFromVisitRef = op.visitId;
    if (actor !== "ai_proposed") {
      target.userAdjusted = true;
      const suggestion = trip.relationshipSuggestions[existing];
      if (suggestion !== undefined) suggestion.decidedBy = "user";
    }
  } else {
    // 创建：确定性 stopId（stop_from_{visitId}，碰撞递增后缀）
    let n = 1;
    let stopId = `stop_from_${op.visitId}`;
    while (trip.stops[stopId] !== undefined) {
      n += 1;
      stopId = `stop_from_${op.visitId}_${n}`;
    }
    const stop: Stop = {
      stopId,
      state: "attached",
      visitRef: parent.visitId,
      suggestedVisitRef: null,
      matchedPointRef: matched ? source.pointRef : null,
      customName: matched ? null : sourceItem.name,
      order: null,
      suggestMinutes: source.reservedMinutes ?? sourceItem.suggestMinutes ?? null,
      locationHint: null,
      ticketRelation: "unknown",
      sourceEvidenceRefs: [...evidenceIdSet],
      sourceMentionRefs: mergedMentionRefs,
      userAdjusted: actor !== "ai_proposed",
      removedFromOrder: null,
      removedAt: null,
      classifiedFromVisitRef: op.visitId,
    };
    const snippets = mergeGuideSnippets(undefined, mergedSnippets);
    if (snippets !== undefined) stop.guideSnippets = snippets;
    trip.stops[stopId] = stop;
    const insertAt = op.toOrder === null ? parent.childStopRefs.length : op.toOrder;
    parent.childStopRefs.splice(insertAt, 0, stopId);
    renumberStops(trip, parent);
    trip.relationshipSuggestions[stopId] = {
      stopRef: stopId,
      suggestedVisitRef: null,
      level: "high",
      positiveSignals:
        op.evidenceMentionRefs.length > 0
          ? [`原文从属证据：${op.evidenceMentionRefs.join("、")}`]
          : ["用户手动归入大景区"],
      negativeSignals: [],
      decidedBy: actor === "ai_proposed" ? "system" : "user",
    };
  }

  const parentDay = visitDayIndex(trip, parent.visitId);
  if (parentDay !== null) affected.add(parentDay);
  return null;
}
