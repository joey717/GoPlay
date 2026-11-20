/**
 * F11 四条护栏（PRD v1.1 §12：服务端强制校验，前端不得信任模型输出）。
 *
 * 职责边界：
 * - 在 applyOps 执行前对操作集逐条校验：违规单条丢弃并计数，
 *   其余照常应用；丢弃占比严格大于 30% 时判定模型未理解意图，整批拒绝；
 * - 全部为纯函数，不依赖任何外部服务：G2 所需的 search_poi 结果由调用方
 *   以 Map 传入（命中=true），护栏只做边界过滤，绝不静默新增未经验证的点位；
 * - 校验语义与 operations 执行器对齐（护栏是执行器的前置过滤器）：
 *   「护栏放行 ⇒ 执行器可应用」，差异仅允许出现在确认时机。
 *
 * 四条护栏与实现位置：
 * - G1 操作合法性（引用 / 容器 / 适用矩阵 / Stop 同天 / order / 深度）+
 *   G3 锁定与约束（按 actor 分流：AI 不得动已购/已锁，用户明确操作可改）：
 *   validateDetail 单条校验；
 * - G2 候选边界：validateProposedNew（针对 OperationSet.proposedNew 的名称）；
 * - G4 重排保护：plan 悄悄省略 userAdjusted 项时判定越界，但保护动作是
 *   「保留原位」而非拒单（执行器的 plan「未提及项保持原序追加」负责落实）。
 *
 * Stop 适用矩阵（PRD §9.4，错误 reason 可读）：
 * - 支持：plan（父内）/ move（父内）/ remove / setDuration / transfer（仅归类纠正）；
 * - 拒绝：setTime（不显示具体开始时间）、setPurchase / lock（状态属于 Visit）、
 *   跨天 transfer（归类纠正不得改变 dayIndex）。
 *
 * pending 归类（Task #105）：state=pending（待定加入）与景区之间的归属判定是用户的
 * 决定，actor=ai_proposed 的任何 touch pending 的 transfer（从 pendingPool 归入景区 /
 * 把既有玩法移回 pendingPool）一律 G3 拒绝；只有用户明确操作（user_manual /
 * user_confirmed）才放行，执行器据此写 userAdjusted / decidedBy=user。
 * 该规则是护栏硬约束，不依赖 planner / intent 的 prompt 禁令。
 *
 * rev2 住宿多候选适配（Task #80）：
 * - addLodgingCandidate 纳入 G1 白名单并逐项校验（dayIndex 有效 / hotelId 非空且已
 *   入库 / 不与当天候选重复）；创建族不触碰已购/已锁/重排保护面，无 G3 分流；
 * - 住宿不适用点位 remove op（与执行器同语义拒绝）；候选的移除/更换走住宿专用行为
 *   ——从当天 LodgingPlan.hotelRefs 移除引用（registry 主数据保留），而非清空
 *   deprecated hotelCandidate；护栏导出 validateLodgingCandidateRemoval 供专用
 *   通道做与四条护栏同源的校验；
 * - setPurchase / lock 对 lodging 的校验作用于 LodgingPlan（候选集合层面），具体
 *   酒店信息一律经 hotelRefs → trip.hotelRegistry 解析，不再查询 deprecated
 *   hotelCandidate / status。
 */

import type {
  ContainerRef,
  EntityRef,
  Item,
  Operation,
  OperationActor,
  PlanAssignment,
  Stop,
  Trip,
  Visit,
} from "../types/index.js";
import { resolveMentionRef } from "../guides/index.js";
import {
  MAX_SETTABLE_MINUTES,
  TIME_PATTERN,
  collectVisitEvidenceScope,
  findStopContainer,
  findVisitLocation,
  getDayByIndex,
  inGlobalPool,
  isContainerRef,
  isEntityRef,
  isPlanScopeRef,
  mentionRefTracesTo,
  refKey,
  stopName,
  visitDayIndex,
  visitName,
} from "../operations/index.js";

// ===== 类型 =====

export interface GuardResult {
  passed: Operation[];
  rejected: { op: Operation; guard: string; reason: string }[];
  rejectAll: boolean; // 违规率 > 30% 时为 true
  /** G4 重排保护标注：plan 中被悄悄省略的 userAdjusted 项（不拒绝，执行器保留原位） */
  warnings?: string[];
}

/** 单条操作校验详单：guard 记录违规护栏编号（G1/G3），供 checkGuards 标注 */
interface ValidateDetail {
  valid: boolean;
  reason?: string;
  guard?: "G1" | "G3";
}

/** checkGuards 选项 */
export interface CheckGuardsOptions {
  /** 操作来源（G3 按 actor 分流）；默认 "ai_proposed"（最保守） */
  actor?: OperationActor;
  /** G2 候选边界所需的 search_poi 结果（proposedNew 校验上下文） */
  searchResults?: Map<string, boolean>;
}

// ===== 常量 =====

/**
 * PRD 七类意图 / 8 个 op 名白名单 + rev2 创建族 addLodgingCandidate
 * （Task #80 纳入 G1 白名单：与 plan 同为可直接应用的创建族，护栏逐项校验而非默认放行）
 * + Task #122 归类族 classifyVisitAsStop（强证据门槛：弱证据/锁定/已购一律拒绝）。
 */
const ALLOWED_OPS: ReadonlySet<string> = new Set([
  "plan",
  "move",
  "transfer",
  "remove",
  "setTime",
  "setDuration",
  "setPurchase",
  "lock",
  "addLodgingCandidate",
  "classifyVisitAsStop",
]);

const PURCHASE_VALUES: ReadonlySet<string> = new Set(["bought", "toBuy", "unknown", "noTicket"]);

// ===== 内部辅助 =====

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

const PASS: ValidateDetail = { valid: true };

function rejectG1(reason: string): ValidateDetail {
  return { valid: false, reason, guard: "G1" };
}

function rejectG3(reason: string): ValidateDetail {
  return { valid: false, reason, guard: "G3" };
}

/** G3：AI 不得移动/改动已购/已锁 Visit（用户明确操作不受限；remove 另有更严规则） */
function guardVisit(trip: Trip, visit: Visit, actor: OperationActor, action: string): ValidateDetail {
  if (actor === "ai_proposed") {
    if (visit.locked) {
      return rejectG3(`${action}：「${visitName(trip, visit.visitId)}」已被锁定，AI 不能改动（用户明确操作不受限）`);
    }
    if (visit.purchaseState === "bought") {
      return rejectG3(`${action}：「${visitName(trip, visit.visitId)}」门票已购，AI 不能移动（如需调整请由用户明确确认）`);
    }
  }
  return PASS;
}

/** G3：remove 对 locked / bought 一律拒绝（先解锁 / 走改订，两条通道一致） */
function guardVisitRemoval(trip: Trip, visit: Visit): ValidateDetail {
  if (visit.locked) return rejectG3(`remove：「${visitName(trip, visit.visitId)}」已被锁定，须先解锁`);
  if (visit.purchaseState === "bought") {
    return rejectG3(`remove：「${visitName(trip, visit.visitId)}」门票已购，不可移除（如行程有变请走改订流程）`);
  }
  return PASS;
}

// ===== G1 + G3 单条校验 =====

/** G1 + G3 单条校验的内部实现（详单含 guard 编号，供 checkGuards 区分标注） */
export function validateDetail(op: Operation, trip: Trip, actor: OperationActor = "ai_proposed"): ValidateDetail {
  // 运行时兜底：F11 输入来自模型 JSON 反序列化，不信任其结构
  if (op === null || typeof op !== "object") {
    return rejectG1("操作不是合法对象");
  }
  if (!ALLOWED_OPS.has(op.op)) {
    return rejectG1(`op 不在七类白名单内：${String(op.op)}`);
  }

  switch (op.op) {
    case "plan":
      return validatePlanDetail(op, trip, actor);
    case "move":
      return validateMoveDetail(op, trip, actor);
    case "transfer":
      return validateTransferDetail(op, trip, actor);
    case "remove":
      return validateRemoveDetail(op, trip);
    case "setTime":
      return validateSetTimeDetail(op, trip, actor);
    case "setDuration":
      return validateSetDurationDetail(op, trip, actor);
    case "setPurchase":
      return validateSetPurchaseDetail(op, trip);
    case "lock":
      return validateLockDetail(op, trip);
    case "addLodgingCandidate":
      // rev2 创建族扩展（Task #80）：已纳入 G1 白名单并逐项校验（日期 / 入库 / 不重复）；
      // 创建族不触碰已购/已锁/重排保护面，无 G3 分流。
      return validateAddLodgingCandidateDetail(op, trip);
    case "classifyVisitAsStop":
      // Task #122 归类族：强证据门槛 + 锁定/已购红线；AI 仅在强证据全部通过时放行，
      // 用户确认通道同样不得绕过证据与安全校验。
      return validateClassifyVisitAsStopDetail(op, trip, actor);
  }
}

/** plan：scopeRef / assignments 逐项校验（存在性、容器矩阵、pending 拒入、order、无重复、G3） */
function validatePlanDetail(op: PlanOp, trip: Trip, actor: OperationActor): ValidateDetail {
  if (!isPlanScopeRef(op.scopeRef)) {
    return rejectG1("plan.scopeRef 非法（须为 { kind: \"day\", dayIndex } 或 { kind: \"allDays\" }）");
  }
  if (op.scopeRef.kind === "day" && getDayByIndex(trip, op.scopeRef.dayIndex) === null) {
    return rejectG1(`plan.scopeRef.dayIndex 超出行程日期范围：${op.scopeRef.dayIndex}`);
  }
  if (!Array.isArray(op.assignments)) return rejectG1("plan.assignments 不是数组");

  // 容器分组计数（order 上限用，与执行器一致：当前长度 + 该容器 assign 条数 - 1）
  const dayAssignCount = new Map<number, number>();
  const visitAssignCount = new Map<string, number>();
  for (const a of op.assignments) {
    if (a === null || typeof a !== "object") return rejectG1("plan.assignments 中存在非法项");
    if (!isEntityRef(a.subjectRef)) return rejectG1("plan.assignments 中存在非法 subjectRef");
    if (!isContainerRef(a.containerRef)) return rejectG1("plan.assignments 中存在非法 containerRef");
    if (a.containerRef.kind === "day") {
      const key = a.containerRef.dayIndex;
      dayAssignCount.set(key, (dayAssignCount.get(key) ?? 0) + 1);
    } else if (a.containerRef.kind === "visit") {
      const key = a.containerRef.id;
      visitAssignCount.set(key, (visitAssignCount.get(key) ?? 0) + 1);
    }
  }

  const seen = new Set<string>();
  for (const a of op.assignments) {
    const key = refKey(a.subjectRef);
    if (seen.has(key)) return rejectG1(`plan.assignments 中 subjectRef 重复：${key}`);
    seen.add(key);
    if (!Number.isInteger(a.order) || a.order < 0) {
      return rejectG1(`plan.assignments.order 非法：${String(a.order)}（须为非负整数）`);
    }
    const check = validatePlanAssignment(a, trip, actor, dayAssignCount, visitAssignCount);
    if (!check.valid) return check;
  }
  return PASS;
}

/** plan 单条 assignment 校验（subject 存在性 / 容器矩阵 / order / G3） */
function validatePlanAssignment(
  a: PlanAssignment,
  trip: Trip,
  actor: OperationActor,
  dayAssignCount: Map<number, number>,
  visitAssignCount: Map<string, number>,
): ValidateDetail {
  if (a.subjectRef.kind === "stop") {
    const stop = trip.stops[a.subjectRef.id];
    if (stop === undefined) return rejectG1(`plan.assignments 引用了不存在的内部玩法：${a.subjectRef.id}`);
    if (stop.state === "pending") {
      return rejectG1(
        `plan 不能自动挂入待定加入的内部玩法「${stopName(trip, stop.stopId)}」，须由用户确认归类（transfer）`,
      );
    }
    if (a.containerRef.kind !== "visit") {
      return rejectG1(`内部玩法只能编入 visit 容器（subjectRef ${a.subjectRef.id}）`);
    }
    const targetVisit = trip.visits[a.containerRef.id];
    if (targetVisit === undefined) return rejectG1(`plan.assignments 引用了不存在的容器 visit：${a.containerRef.id}`);
    if (stop.visitRef !== a.containerRef.id) {
      return rejectG1(
        `plan 不能把内部玩法「${stopName(trip, stop.stopId)}」移到其他大景区；换景区请使用 transfer 归类纠正`,
      );
    }
    const maxOrder = targetVisit.childStopRefs.length + (visitAssignCount.get(a.containerRef.id) ?? 1) - 1;
    if (a.order > maxOrder) return rejectG1(`plan.assignments.order 越界：${a.order}（合法范围 0-${maxOrder}）`);
    return PASS;
  }

  if (a.subjectRef.kind === "visit") {
    const visit = trip.visits[a.subjectRef.id];
    if (visit === undefined) return rejectG1(`plan.assignments 引用了不存在的 visit：${a.subjectRef.id}`);
    if (a.containerRef.kind !== "day") {
      return rejectG1(`Visit 只能编入 day 容器（subjectRef ${a.subjectRef.id}）`);
    }
    const day = getDayByIndex(trip, a.containerRef.dayIndex);
    if (day === null) {
      return rejectG1(`plan.assignments 中 dayIndex 超出行程日期范围：${a.containerRef.dayIndex}`);
    }
    const g3 = guardVisit(trip, visit, actor, "plan");
    if (!g3.valid) return g3;
    const maxOrder = day.scheduleVisitRefs.length + (dayAssignCount.get(a.containerRef.dayIndex) ?? 1) - 1;
    if (a.order > maxOrder) {
      return rejectG1(`plan.assignments.order 越界：${a.order}（Day${a.containerRef.dayIndex} 合法范围 0-${maxOrder}）`);
    }
    return PASS;
  }

  if (a.subjectRef.kind === "point") {
    if (a.containerRef.kind !== "day") {
      return rejectG1(`未安排点位只能编入 day 容器（subjectRef ${a.subjectRef.id}）`);
    }
    const day = getDayByIndex(trip, a.containerRef.dayIndex);
    if (day === null) {
      return rejectG1(`plan.assignments 中 dayIndex 超出行程日期范围：${a.containerRef.dayIndex}`);
    }
    if (trip.itemRegistry[a.subjectRef.id] === undefined) {
      return rejectG1(`plan.assignments 引用了不存在的 point：${a.subjectRef.id}`);
    }
    if (!inGlobalPool(trip, "point", a.subjectRef.id)) {
      return rejectG1(`plan.assignments 引用了不在全局候选区的 point：${a.subjectRef.id}`);
    }
    const maxOrder = day.scheduleVisitRefs.length + (dayAssignCount.get(a.containerRef.dayIndex) ?? 1) - 1;
    if (a.order > maxOrder) {
      return rejectG1(`plan.assignments.order 越界：${a.order}（Day${a.containerRef.dayIndex} 合法范围 0-${maxOrder}）`);
    }
    return PASS;
  }

  return rejectG1(`plan 不支持 ${String(a.subjectRef.kind)} 类型的 subjectRef`);
}

/** move：subject 必须已在容器中；toOrder 上界与执行器一致（取出 1 项后再插入） */
function validateMoveDetail(op: MoveOp, trip: Trip, actor: OperationActor): ValidateDetail {
  if (!isEntityRef(op.subjectRef)) return rejectG1("move.subjectRef 非法");
  if (!isContainerRef(op.containerRef)) return rejectG1("move.containerRef 非法");

  if (op.subjectRef.kind === "visit") {
    if (op.containerRef.kind !== "day") return rejectG1("move：Visit 只能在 day 容器内改序（跨天请使用 transfer）");
    const day = getDayByIndex(trip, op.containerRef.dayIndex);
    if (day === null) return rejectG1(`move.containerRef.dayIndex 超出行程日期范围：${op.containerRef.dayIndex}`);
    const visit = trip.visits[op.subjectRef.id];
    if (visit === undefined) return rejectG1(`move：visit ${op.subjectRef.id} 不存在`);
    if (!day.scheduleVisitRefs.includes(op.subjectRef.id)) {
      return rejectG1(`move：「${visitName(trip, op.subjectRef.id)}」不在 Day${op.containerRef.dayIndex} 的行程中`);
    }
    const g3 = guardVisit(trip, visit, actor, "move");
    if (!g3.valid) return g3;
    const maxOrder = day.scheduleVisitRefs.length - 1;
    if (!Number.isInteger(op.toOrder) || op.toOrder < 0 || op.toOrder > maxOrder) {
      return rejectG1(`move.toOrder 越界：${String(op.toOrder)}（Day${op.containerRef.dayIndex} 合法范围 0-${maxOrder}）`);
    }
    return PASS;
  }

  if (op.subjectRef.kind === "stop") {
    if (op.containerRef.kind !== "visit") return rejectG1("move：内部玩法只能在 visit 容器内改序");
    const stop = trip.stops[op.subjectRef.id];
    if (stop === undefined) return rejectG1(`move：stop ${op.subjectRef.id} 不存在`);
    const visit = trip.visits[op.containerRef.id];
    if (visit === undefined) return rejectG1(`move：visit ${op.containerRef.id} 不存在`);
    if (stop.state === "pending") return rejectG1("move：待定加入的内部玩法不在任何大景区内，无法改序");
    if (stop.visitRef !== op.containerRef.id) {
      return rejectG1(`move：内部玩法「${stopName(trip, stop.stopId)}」不属于该大景区`);
    }
    if (!visit.childStopRefs.includes(op.subjectRef.id)) {
      return rejectG1("move：备选玩法不支持排序，请先放回岛内行程");
    }
    const maxOrder = visit.childStopRefs.length - 1;
    if (!Number.isInteger(op.toOrder) || op.toOrder < 0 || op.toOrder > maxOrder) {
      return rejectG1(`move.toOrder 越界：${String(op.toOrder)}（合法范围 0-${maxOrder}）`);
    }
    return PASS;
  }

  return rejectG1(`move 不支持 ${String(op.subjectRef.kind)} 类型的 subjectRef`);
}

/** transfer：容器矩阵 / 存在性 / Stop 归类纠正同天 / Visit toOrder 范围 / G3 */
function validateTransferDetail(op: TransferOp, trip: Trip, actor: OperationActor): ValidateDetail {
  if (!isEntityRef(op.subjectRef)) return rejectG1("transfer.subjectRef 非法");
  if (!isContainerRef(op.fromContainerRef)) return rejectG1("transfer.fromContainerRef 非法");
  if (!isContainerRef(op.toContainerRef)) return rejectG1("transfer.toContainerRef 非法");

  if (op.subjectRef.kind === "visit") {
    if (op.toContainerRef.kind !== "day") {
      return rejectG1("transfer：Visit 只能转移到 day 容器（移出请使用 remove）");
    }
    const dst = getDayByIndex(trip, op.toContainerRef.dayIndex);
    if (dst === null) return rejectG1(`transfer.toContainerRef.dayIndex 超出行程日期范围：${op.toContainerRef.dayIndex}`);
    const visit = trip.visits[op.subjectRef.id];
    if (visit === undefined) return rejectG1(`transfer：visit ${op.subjectRef.id} 不存在`);
    if (op.fromContainerRef.kind === "day") {
      const src = getDayByIndex(trip, op.fromContainerRef.dayIndex);
      if (src === null) {
        return rejectG1(`transfer.fromContainerRef.dayIndex 超出行程日期范围：${op.fromContainerRef.dayIndex}`);
      }
      if (!src.scheduleVisitRefs.includes(op.subjectRef.id)) {
        return rejectG1(`transfer：「${visitName(trip, op.subjectRef.id)}」不在 Day${op.fromContainerRef.dayIndex} 的行程中`);
      }
    } else if (op.fromContainerRef.kind === "globalPool") {
      if (visit.dayRef !== null) return rejectG1(`transfer：「${visitName(trip, op.subjectRef.id)}」不在全局候选区`);
    } else {
      return rejectG1("transfer：Visit 的 fromContainerRef 只能是 day 或 globalPool");
    }
    const g3 = guardVisit(trip, visit, actor, "transfer");
    if (!g3.valid) return g3;
    const toOrder = op.toOrder === null ? dst.scheduleVisitRefs.length : op.toOrder;
    if (!Number.isInteger(toOrder) || toOrder < 0 || toOrder > dst.scheduleVisitRefs.length) {
      return rejectG1(
        `transfer.toOrder 越界：${String(op.toOrder)}（Day${dst.dayIndex} 合法范围 0-${dst.scheduleVisitRefs.length}）`,
      );
    }
    return PASS;
  }

  if (op.subjectRef.kind === "stop") {
    const stop = trip.stops[op.subjectRef.id];
    if (stop === undefined) return rejectG1(`transfer：stop ${op.subjectRef.id} 不存在`);
    if (stop.state === "pending" && op.fromContainerRef.kind !== "pendingPool") {
      return rejectG1("transfer：待定加入的内部玩法须从 pendingPool 取出");
    }
    // G3（Task #105）：pending ↔ 景区的归类只能由用户确认。AI 通道若允许 transfer，
    // 就绕过了「待定加入须用户归类」的确认（plan/setDuration 已被 G1 拒绝，transfer 是
    // 唯一剩余缺口）；因此任何 touch pending 的归类纠正对 AI 一律拒绝。
    if (actor === "ai_proposed" && touchesPendingClassification(stop, op)) {
      return rejectG3(
        `transfer：「${stopName(trip, stop.stopId)}」的归类（待定加入 ↔ 大景区）是用户的决定，AI 不能代替确认；请由用户在前端确认归类`,
      );
    }

    // from 解析（只读）
    let fromVisitId: string | null = null;
    if (op.fromContainerRef.kind === "visit") {
      const owner = trip.visits[op.fromContainerRef.id];
      if (owner === undefined) return rejectG1(`transfer：visit ${op.fromContainerRef.id} 不存在`);
      if (
        !owner.childStopRefs.includes(op.subjectRef.id) &&
        !owner.alternateStopRefs.includes(op.subjectRef.id)
      ) {
        return rejectG1(`transfer：内部玩法「${stopName(trip, stop.stopId)}」不在该大景区的内部玩法或备选中`);
      }
      fromVisitId = owner.visitId;
    } else if (op.fromContainerRef.kind === "visitPool") {
      const owner = trip.visits[op.fromContainerRef.visitId];
      if (owner === undefined) return rejectG1(`transfer：visit ${op.fromContainerRef.visitId} 不存在`);
      if (!owner.alternateStopRefs.includes(op.subjectRef.id)) {
        return rejectG1(`transfer：内部玩法「${stopName(trip, stop.stopId)}」不在该大景区的备选玩法中`);
      }
      fromVisitId = owner.visitId;
    } else if (op.fromContainerRef.kind === "pendingPool") {
      if (stop.state !== "pending" || !trip.pendingStopRefs.includes(op.subjectRef.id)) {
        return rejectG1(`transfer：内部玩法「${stopName(trip, stop.stopId)}」不在待定加入区`);
      }
    } else {
      return rejectG1("transfer：内部玩法的 fromContainerRef 只能是 visit / visitPool / pendingPool");
    }

    // to 解析（只读）
    let toVisitId: string | null = null;
    if (op.toContainerRef.kind === "visit") {
      const target = trip.visits[op.toContainerRef.id];
      if (target === undefined) return rejectG1(`transfer：visit ${op.toContainerRef.id} 不存在`);
      if (target.childStopRefs.includes(op.subjectRef.id)) {
        return rejectG1(`transfer：内部玩法「${stopName(trip, stop.stopId)}」已在该大景区的岛内行程中，无需转移`);
      }
      if (op.toOrder !== null) {
        if (!Number.isInteger(op.toOrder) || op.toOrder < 0 || op.toOrder > target.childStopRefs.length) {
          return rejectG1(`transfer.toOrder 越界：${String(op.toOrder)}（合法范围 0-${target.childStopRefs.length}）`);
        }
      }
      toVisitId = target.visitId;
    } else if (op.toContainerRef.kind === "visitPool") {
      const target = trip.visits[op.toContainerRef.visitId];
      if (target === undefined) return rejectG1(`transfer：visit ${op.toContainerRef.visitId} 不存在`);
      if (target.alternateStopRefs.includes(op.subjectRef.id)) {
        return rejectG1(`transfer：内部玩法「${stopName(trip, stop.stopId)}」已在该大景区的备选玩法中，无需转移`);
      }
      if (op.toOrder !== null) return rejectG1("transfer：转入备选玩法时不支持 toOrder");
      toVisitId = target.visitId;
    } else if (op.toContainerRef.kind === "pendingPool") {
      if (trip.pendingStopRefs.includes(op.subjectRef.id)) {
        return rejectG1(`transfer：内部玩法「${stopName(trip, stop.stopId)}」已在待定加入区`);
      }
      if (op.toOrder !== null) return rejectG1("transfer：转入待定加入区时不支持 toOrder");
    } else {
      return rejectG1("transfer：内部玩法的 toContainerRef 只能是 visit / visitPool / pendingPool");
    }

    // 同天校验：归类纠正不得改变 dayIndex（PRD §12.1）
    const fromDayIndex = fromVisitId !== null ? visitDayIndex(trip, fromVisitId) : null;
    const toDayIndex = toVisitId !== null ? visitDayIndex(trip, toVisitId) : null;
    if (fromDayIndex !== null && toDayIndex !== null && fromDayIndex !== toDayIndex) {
      return rejectG1(
        `transfer：内部玩法不支持跨天移动（Day${fromDayIndex} → Day${toDayIndex}）。换景区的归类纠正只能指向同一天的大景区；跨天调整请移动大景区本身`,
      );
    }
    return PASS;
  }

  return rejectG1(`transfer 不支持 ${String(op.subjectRef.kind)} 类型的 subjectRef`);
}

/**
 * transfer 是否触及「待定加入」归类：subject 本身 pending、或来源 / 目标是 pendingPool。
 * 三个方向（pendingPool → 景区、景区 → pendingPool、pending 玩法之间）都属于用户的归类决定。
 */
function touchesPendingClassification(stop: Stop, op: TransferOp): boolean {
  return (
    stop.state === "pending" ||
    op.fromContainerRef.kind === "pendingPool" ||
    op.toContainerRef.kind === "pendingPool"
  );
}

/** remove：from 容器矩阵 / 存在性 / G3（locked / bought 一律拒绝） */
function validateRemoveDetail(op: RemoveOp, trip: Trip): ValidateDetail {
  if (!isEntityRef(op.subjectRef)) return rejectG1("remove.subjectRef 非法");
  if (!isContainerRef(op.fromContainerRef)) return rejectG1("remove.fromContainerRef 非法");

  if (op.subjectRef.kind === "visit") {
    if (op.fromContainerRef.kind !== "day") return rejectG1("remove：Visit 的 fromContainerRef 只能是 day");
    const day = getDayByIndex(trip, op.fromContainerRef.dayIndex);
    if (day === null) {
      return rejectG1(`remove.fromContainerRef.dayIndex 超出行程日期范围：${op.fromContainerRef.dayIndex}`);
    }
    const visit = trip.visits[op.subjectRef.id];
    if (visit === undefined) return rejectG1(`remove：visit ${op.subjectRef.id} 不存在`);
    if (!day.scheduleVisitRefs.includes(op.subjectRef.id)) {
      return rejectG1(`remove：「${visitName(trip, op.subjectRef.id)}」不在 Day${day.dayIndex} 的行程中`);
    }
    return guardVisitRemoval(trip, visit);
  }

  if (op.subjectRef.kind === "stop") {
    const stop = trip.stops[op.subjectRef.id];
    if (stop === undefined) return rejectG1(`remove：stop ${op.subjectRef.id} 不存在`);
    if (op.fromContainerRef.kind === "visitPool") {
      return rejectG1("remove：该内部玩法已在备选玩法中，无需再次移除");
    }
    if (op.fromContainerRef.kind === "pendingPool") {
      return rejectG1("remove：待定加入的内部玩法请通过归类（transfer）处理");
    }
    if (op.fromContainerRef.kind !== "visit") {
      return rejectG1("remove：内部玩法的 fromContainerRef 只能是 visit");
    }
    const visit = trip.visits[op.fromContainerRef.id];
    if (visit === undefined) return rejectG1(`remove：visit ${op.fromContainerRef.id} 不存在`);
    if (!visit.childStopRefs.includes(op.subjectRef.id)) {
      return rejectG1("remove：该内部玩法已在备选玩法中，无需再次移除");
    }
    return PASS;
  }

  if (op.subjectRef.kind === "point") {
    if (op.fromContainerRef.kind !== "globalPool") {
      return rejectG1("remove：未安排点位的 fromContainerRef 只能是 globalPool");
    }
    if (trip.itemRegistry[op.subjectRef.id] === undefined) {
      return rejectG1(`remove：point ${op.subjectRef.id} 不存在`);
    }
    if (!inGlobalPool(trip, "point", op.subjectRef.id)) {
      return rejectG1(`remove：point ${op.subjectRef.id} 不在全局候选区`);
    }
    return PASS;
  }

  if (op.subjectRef.kind === "lodging") {
    // rev2 适配（Task #80）：住宿候选的移除 = 从当天 LodgingPlan.hotelRefs 移除引用
    // （hotelRegistry 主数据保留），绝不套用点位「清空选中 / 移回候选池」语义；与
    // 执行器 applyRemove 同语义拒绝，专用移除通道见 validateLodgingCandidateRemoval。
    return rejectG1("remove：酒店候选的移除/更换须走住宿专用行为（从当天候选列表 hotelRefs 移除引用），不套用点位候选池语义");
  }
  return rejectG1(`remove 不支持 ${String(op.subjectRef.kind)} 类型的 subjectRef`);
}

/** setTime：value 格式 / target×subjectKind 适用矩阵（Stop 拒绝）/ G3 */
function validateSetTimeDetail(op: SetTimeOp, trip: Trip, actor: OperationActor): ValidateDetail {
  if (typeof op.value !== "string" || !TIME_PATTERN.test(op.value)) {
    return rejectG1(`setTime.value 非法：${String(op.value)}（须为 HH:MM 格式）`);
  }
  if (!isEntityRef(op.subjectRef)) return rejectG1("setTime.subjectRef 非法");
  if (op.target !== "start" && op.target !== "end" && op.target !== "dayDepart") {
    return rejectG1(`setTime.target 非法：${String(op.target)}（须为 start / end / dayDepart）`);
  }

  if (op.subjectRef.kind === "day") {
    if (op.target !== "dayDepart") return rejectG1("setTime：Day 只支持 target=dayDepart");
    if (getDayByIndex(trip, op.subjectRef.dayIndex) === null) {
      return rejectG1(`setTime.dayIndex 超出行程日期范围：${op.subjectRef.dayIndex}`);
    }
    return PASS;
  }

  if (op.subjectRef.kind === "visit") {
    if (op.target === "dayDepart") return rejectG1("setTime：Visit 不支持 target=dayDepart（请对 Day 设置出发时间）");
    const visit = trip.visits[op.subjectRef.id];
    if (visit === undefined) return rejectG1(`setTime：visit ${op.subjectRef.id} 不存在`);
    const loc = findVisitLocation(trip, op.subjectRef.id);
    if (loc === null || loc.where !== "day") {
      return rejectG1(`setTime：「${visitName(trip, op.subjectRef.id)}」未排入任何一天，无法设置时间`);
    }
    return guardVisit(trip, visit, actor, "setTime");
  }

  if (op.subjectRef.kind === "lodging") {
    if (op.target === "dayDepart") return rejectG1("setTime：住宿不支持 target=dayDepart");
    const plan = trip.lodgings[String(op.subjectRef.dayIndex)];
    if (plan === undefined) return rejectG1(`setTime：Day${op.subjectRef.dayIndex} 无住宿计划`);
    if (actor === "ai_proposed" && (plan.locked || plan.purchaseState === "bought")) {
      return rejectG3(`setTime：Day${plan.dayIndex} 住宿已被锁定或已预订，AI 不能改动（用户明确操作不受限）`);
    }
    return PASS;
  }

  if (op.subjectRef.kind === "stop") {
    return rejectG1("setTime：内部玩法不支持设置具体开始时间（只维护顺序、建议时长、位置提示、票务关系）");
  }
  return rejectG1(`setTime 不支持 ${String(op.subjectRef.kind)} 类型的 subjectRef`);
}

/** setDuration：minutes 正整数且 ≤ 配置上限 / 适用矩阵（仅 Visit 与 Stop）/ G3 */
function validateSetDurationDetail(op: SetDurationOp, trip: Trip, actor: OperationActor): ValidateDetail {
  if (!isEntityRef(op.subjectRef)) return rejectG1("setDuration.subjectRef 非法");
  if (typeof op.minutes !== "number" || !Number.isInteger(op.minutes) || op.minutes <= 0) {
    return rejectG1(`setDuration.minutes 非法：${String(op.minutes)}（须为正整数）`);
  }
  if (op.minutes > MAX_SETTABLE_MINUTES) {
    return rejectG1(`setDuration.minutes 超出配置上限：${op.minutes}（最大 ${MAX_SETTABLE_MINUTES}）`);
  }

  if (op.subjectRef.kind === "visit") {
    const visit = trip.visits[op.subjectRef.id];
    if (visit === undefined) return rejectG1(`setDuration：visit ${op.subjectRef.id} 不存在`);
    const loc = findVisitLocation(trip, op.subjectRef.id);
    if (loc === null || loc.where !== "day") {
      return rejectG1(`setDuration：「${visitName(trip, op.subjectRef.id)}」未排入任何一天，无法设置时长`);
    }
    return guardVisit(trip, visit, actor, "setDuration");
  }

  if (op.subjectRef.kind === "stop") {
    const stop = trip.stops[op.subjectRef.id];
    if (stop === undefined) return rejectG1(`setDuration：stop ${op.subjectRef.id} 不存在`);
    if (stop.state === "pending") return rejectG1("setDuration：待定加入的内部玩法不在任何大景区内，请先归类");
    if (stop.visitRef === null) return rejectG1("setDuration：内部玩法归属不一致，无法设置时长");
    return PASS;
  }

  return rejectG1(`setDuration 不支持 ${String(op.subjectRef.kind)} 类型的 subjectRef`);
}

/** setPurchase：仅 Visit / Lodging；Stop 拒绝（无独立购买状态）；枚举校验 */
function validateSetPurchaseDetail(op: SetPurchaseOp, trip: Trip): ValidateDetail {
  if (!isEntityRef(op.subjectRef)) return rejectG1("setPurchase.subjectRef 非法");
  if (typeof op.value !== "string" || !PURCHASE_VALUES.has(op.value)) {
    return rejectG1(`setPurchase.value 非法：${String(op.value)}（须为 bought / toBuy / unknown / noTicket）`);
  }

  if (op.subjectRef.kind === "visit") {
    if (trip.visits[op.subjectRef.id] === undefined) {
      return rejectG1(`setPurchase：visit ${op.subjectRef.id} 不存在`);
    }
    return PASS;
  }
  if (op.subjectRef.kind === "lodging") {
    if (op.value === "noTicket") return rejectG1("setPurchase：住宿没有免票档（unknown / toBuy / bought）");
    const plan = trip.lodgings[String(op.subjectRef.dayIndex)];
    if (plan === undefined) {
      return rejectG1(`setPurchase：Day${op.subjectRef.dayIndex} 无住宿计划`);
    }
    // rev2 适配（Task #80）：购买状态挂在 LodgingPlan 上，但「已订」必须有具体酒店——
    // 经 hotelRefs → trip.hotelRegistry 解析候选（不再查询 deprecated hotelCandidate）；
    // 当天尚无候选时无法表达买了哪家，一律拒绝。
    if (op.value === "bought" && (!Array.isArray(plan.hotelRefs) || plan.hotelRefs.length === 0)) {
      return rejectG1(`setPurchase：Day${plan.dayIndex} 住宿尚无酒店候选，无法标记已订（请先添加候选酒店）`);
    }
    return PASS;
  }
  if (op.subjectRef.kind === "stop") {
    return rejectG1("setPurchase：内部玩法不支持独立购买状态（票务由父景区大门票承担）");
  }
  return rejectG1(`setPurchase 不支持 ${String(op.subjectRef.kind)} 类型的 subjectRef`);
}

/** lock：仅 Visit / Lodging；Stop 拒绝（锁定属于 Visit）；value 布尔 */
function validateLockDetail(op: LockOp, trip: Trip): ValidateDetail {
  if (!isEntityRef(op.subjectRef)) return rejectG1("lock.subjectRef 非法");
  if (typeof op.value !== "boolean") return rejectG1(`lock.value 非法：${String(op.value)}（须为布尔值）`);

  if (op.subjectRef.kind === "visit") {
    if (trip.visits[op.subjectRef.id] === undefined) {
      return rejectG1(`lock：visit ${op.subjectRef.id} 不存在`);
    }
    return PASS;
  }
  if (op.subjectRef.kind === "lodging") {
    // rev2：锁定作用于 LodgingPlan（候选集合层面），不针对单个酒店；候选信息经
    // hotelRefs → trip.hotelRegistry 解析，与 deprecated hotelCandidate / status 无关。
    if (trip.lodgings[String(op.subjectRef.dayIndex)] === undefined) {
      return rejectG1(`lock：Day${op.subjectRef.dayIndex} 无住宿计划`);
    }
    return PASS;
  }
  if (op.subjectRef.kind === "stop") {
    return rejectG1("lock：内部玩法不支持锁定（锁定属于 Visit，随父景区整体生效）");
  }
  return rejectG1(`lock 不支持 ${String(op.subjectRef.kind)} 类型的 subjectRef`);
}

// ===== addLodgingCandidate（rev2 创建族，Task #80） =====

/**
 * addLodgingCandidate G1 校验（与执行器 applyAddLodgingCandidate 预检对齐）：
 * - dayIndex 须为整数且在行程日期范围内（从 1 开始，越界拒绝不夹取）；
 * - hotelId 须为非空字符串，且已存在于 trip.hotelRegistry（执行器只挂引用不建主数据，
 *   酒店入库由 FlyAI 搜索 / 自定义酒店表单等上游通道负责）；
 * - 目标天候选列表（LodgingPlan.hotelRefs）已含该 hotelId 时拒绝（防重复；执行器对
 *   重复幂等跳过，护栏先行拒绝可让模型尽早得到可读反馈，符合
 *   「护栏放行 ⇒ 执行器可应用」契约——护栏允许比执行器更严）；
 * - 无 G3：追加候选引用不改动选中 / 已购 / 已锁状态，无保护面。
 */
function validateAddLodgingCandidateDetail(op: AddLodgingCandidateOp, trip: Trip): ValidateDetail {
  if (!Number.isInteger(op.dayIndex)) {
    return rejectG1(`addLodgingCandidate.dayIndex 非法：${String(op.dayIndex)}（须为整数，从 1 开始）`);
  }
  if (typeof op.hotelId !== "string" || op.hotelId === "") {
    return rejectG1(`addLodgingCandidate.hotelId 非法：${String(op.hotelId)}（须为非空字符串）`);
  }
  if (getDayByIndex(trip, op.dayIndex) === null) {
    return rejectG1(`addLodgingCandidate.dayIndex 超出行程日期范围：${op.dayIndex}`);
  }
  if (trip.hotelRegistry[op.hotelId] === undefined) {
    return rejectG1(`addLodgingCandidate 引用了 hotelRegistry 中不存在的酒店：${op.hotelId}`);
  }
  const plan = trip.lodgings[String(op.dayIndex)];
  if (plan !== undefined && Array.isArray(plan.hotelRefs) && plan.hotelRefs.includes(op.hotelId)) {
    const name = trip.hotelRegistry[op.hotelId]?.name ?? op.hotelId;
    return rejectG1(`addLodgingCandidate：「${name}」已在 Day${op.dayIndex} 的候选列表中，勿重复添加`);
  }
  return PASS;
}

// ===== classifyVisitAsStop（Task #122 归类族） =====

/**
 * 强证据追溯校验（与执行器 applyClassifyVisitAsStop 同源语义）：
 * - 每条引用须能在 trip.evidences/mentions 中解析（悬空 = 弱证据）；
 * - 每条引用须可追溯至来源或目标至少一侧（精确命中提及引用，或其证据 id 在
 *   该侧 sourceMentionRefs / guideSnippets / Item.sourceEvidenceRefs 中）；
 * - 来源侧与目标侧各至少一条（单侧证据无法支撑「从属关系」这一结论）。
 */
function validateClassifyEvidence(
  refs: string[],
  source: Visit,
  parent: Visit,
  trip: Trip,
): ValidateDetail {
  const sourceScope = collectVisitEvidenceScope(trip, source);
  const parentScope = collectVisitEvidenceScope(trip, parent);
  let sourceTraced = 0;
  let parentTraced = 0;
  for (const ref of refs) {
    if (resolveMentionRef(trip, ref) === null) {
      return rejectG1(`classifyVisitAsStop 强证据引用无法在 trip.evidences 中解析：${ref}（弱证据不予归类）`);
    }
    const inSource = mentionRefTracesTo(sourceScope, ref);
    const inParent = mentionRefTracesTo(parentScope, ref);
    if (!inSource && !inParent) {
      return rejectG1(`classifyVisitAsStop：证据 ${ref} 无法追溯至来源或目标（弱证据不予归类）`);
    }
    if (inSource) sourceTraced += 1;
    if (inParent) parentTraced += 1;
  }
  if (sourceTraced === 0 || parentTraced === 0) {
    return rejectG1(
      `classifyVisitAsStop：强关系证据须同时可追溯来源与目标两侧（当前来源侧 ${sourceTraced} 条 / 目标侧 ${parentTraced} 条），弱证据不予归类`,
    );
  }
  return PASS;
}

/**
 * classifyVisitAsStop G1/G3 校验（与执行器 applyClassifyVisitAsStop 预检对齐）：
 * - 形状：visitId / parentVisitId 非空；toOrder 为 null 或非负整数（越界按插入语义
 *   上界 parent.childStopRefs.length 校验）；evidenceMentionRefs 须为非空字符串数组；
 * - 来源须为 existing ordinary Visit；locked / bought 一律拒绝（G3，用户确认通道
 *   同样不豁免——与 remove 同级红线，转换会把它从原天移除）；
 * - 目标须为 existing large_attraction Visit；目标 locked 一律拒绝（G3）；
 *   目标 bought 对 AI 拒绝（G3，用户明确操作不受限）；
 * - 强证据（Task #199 按通道分流）：AI 通道全部引用须可解析且可追溯至来源或目标，
 *   两侧各至少一条（弱证据一律 G1）；用户手动通道（user_manual / user_confirmed）
 *   允许证据为空，显式引用仍须可解析（只免双侧追溯）；
 * - 幂等重放：来源 visit 已删除但目标内存在其溯源 Stop（classifiedFromVisitRef）时
 *   放行（执行器仅合并证据）；非重放的同 identity Stop 已在目标内 → G1 拒绝
 *   （护栏先行给可读反馈，允许比执行器更严，同 addLodgingCandidate 先例）；
 * - 不触碰 pending Stop：归类族只消费 ordinary Visit，不放松 pending 既有的
 *   G1/G3 禁令（plan / transfer 对 pending 的限制维持原样）。
 */
function validateClassifyVisitAsStopDetail(
  op: ClassifyVisitAsStopOp,
  trip: Trip,
  actor: OperationActor,
): ValidateDetail {
  if (typeof op.visitId !== "string" || op.visitId === "") {
    return rejectG1(`classifyVisitAsStop.visitId 非法：${String(op.visitId)}（须为非空字符串）`);
  }
  if (typeof op.parentVisitId !== "string" || op.parentVisitId === "") {
    return rejectG1(`classifyVisitAsStop.parentVisitId 非法：${String(op.parentVisitId)}（须为非空字符串）`);
  }
  if (op.toOrder !== null && (!Number.isInteger(op.toOrder) || op.toOrder < 0)) {
    return rejectG1(`classifyVisitAsStop.toOrder 非法：${String(op.toOrder)}（须为非负整数或 null）`);
  }
  // Task #199：证据门槛按通道分流——AI 仍须强证据（不得自动归类），用户手动归入
  // 允许为空（用户的选择本身即依据）；显式引用仍须可解析，避免悬空引用写入 Stop。
  const requiresStrongEvidence = actor === "ai_proposed";
  if (!Array.isArray(op.evidenceMentionRefs)) {
    return rejectG1("classifyVisitAsStop.evidenceMentionRefs 非法：须为字符串数组");
  }
  if (requiresStrongEvidence && op.evidenceMentionRefs.length === 0) {
    return rejectG1("classifyVisitAsStop 缺少强关系证据（evidenceMentionRefs 须为非空数组），弱证据不予归类");
  }
  for (const ref of op.evidenceMentionRefs) {
    if (typeof ref !== "string" || !ref.includes(":")) {
      return rejectG1(`classifyVisitAsStop.evidenceMentionRefs 存在非法引用（须为 "evidenceId:mentionId"）：${String(ref)}`);
    }
    if (resolveMentionRef(trip, ref) === null) {
      return rejectG1(`classifyVisitAsStop 强证据引用无法在 trip.evidences 中解析：${ref}（弱证据不予归类）`);
    }
  }

  // 目标解析（幂等重放路径同样要求目标合法）
  const parent = trip.visits[op.parentVisitId];
  if (parent === undefined) {
    return rejectG1(`classifyVisitAsStop：目标大景区不存在：${op.parentVisitId}`);
  }
  if (parent.kind !== "large_attraction") {
    return rejectG1(
      `classifyVisitAsStop：目标「${visitName(trip, op.parentVisitId)}」不是大景区（只支持归入 large_attraction）`,
    );
  }
  if (parent.locked) {
    return rejectG3(`classifyVisitAsStop：目标大景区「${visitName(trip, op.parentVisitId)}」已被锁定，须先解锁`);
  }
  if (actor === "ai_proposed" && parent.purchaseState === "bought") {
    return rejectG3(
      `classifyVisitAsStop：目标大景区「${visitName(trip, op.parentVisitId)}」门票已购，AI 不能改动（如需调整请由用户明确确认）`,
    );
  }
  if (op.toOrder !== null && op.toOrder > parent.childStopRefs.length) {
    return rejectG1(`classifyVisitAsStop.toOrder 越界：${op.toOrder}（合法范围 0-${parent.childStopRefs.length}）`);
  }

  // 幂等重放识别（先于重复 identity 判定与缺失实体拒绝）
  const provenanceStopId = Object.keys(trip.stops).find(
    (stopId) => trip.stops[stopId]!.classifiedFromVisitRef === op.visitId,
  );
  const replayInParent =
    provenanceStopId !== undefined &&
    (parent.childStopRefs.includes(provenanceStopId) || parent.alternateStopRefs.includes(provenanceStopId));

  const source = trip.visits[op.visitId];
  if (source === undefined) {
    if (replayInParent) {
      // 重放仅合并证据：引用可解析性已在形状校验中确认，来源侧追溯首次转换时已验证
      return PASS;
    }
    return rejectG1(`classifyVisitAsStop：来源 visit 不存在（可能已转换或从未加入）：${op.visitId}`);
  }
  if (source.kind !== "ordinary") {
    return rejectG1(
      `classifyVisitAsStop：来源「${visitName(trip, op.visitId)}」不是普通景点（只支持 ordinary Visit 归入大景区）`,
    );
  }
  if (source.locked) {
    return rejectG3(`classifyVisitAsStop：「${visitName(trip, op.visitId)}」已被锁定，须先解锁（用户确认也不豁免）`);
  }
  if (source.purchaseState === "bought") {
    return rejectG3(
      `classifyVisitAsStop：「${visitName(trip, op.visitId)}」门票已购，不可归入大景区（如行程有变请走改订流程）`,
    );
  }
  if (source.childStopRefs.length > 0 || source.alternateStopRefs.length > 0) {
    return rejectG1(
      `classifyVisitAsStop：来源「${visitName(trip, op.visitId)}」携带内部玩法，数据异常，拒绝转换（请先人工核查）`,
    );
  }
  if (trip.itemRegistry[source.pointRef] === undefined) {
    return rejectG1(`classifyVisitAsStop：来源 pointRef 指向不存在的 item：${source.pointRef}`);
  }

  // 强证据双侧追溯只约束 AI 通道；用户手动归入允许无证据（Task #199）
  if (requiresStrongEvidence) {
    const evidence = validateClassifyEvidence(op.evidenceMentionRefs, source, parent, trip);
    if (!evidence.valid) return evidence;
  }

  // 非重放的目标内重复 identity（复用逻辑仅对直接调用兜底，护栏先行拒绝给可读反馈）
  if (provenanceStopId === undefined) {
    const item = trip.itemRegistry[source.pointRef]!;
    const matched = item.origin === "fliggy";
    const duplicate = [...parent.childStopRefs, ...parent.alternateStopRefs].some((stopId) => {
      const stop = trip.stops[stopId];
      if (stop === undefined) return false;
      if (matched) return stop.matchedPointRef === source.pointRef;
      return stop.matchedPointRef === null && stop.customName === item.name;
    });
    if (duplicate) {
      return rejectG1(
        `classifyVisitAsStop：「${visitName(trip, op.visitId)}」已在目标大景区中（同点位内部玩法已存在），勿重复归类`,
      );
    }
  }
  return PASS;
}

// ===== 公开接口 =====

/** G1 + G3 单条校验：合法返回 { valid: true }，否则 { valid: false, reason }（guard 可选） */
export function validateOperation(
  op: Operation,
  trip: Trip,
  actor: OperationActor = "ai_proposed",
): { valid: boolean; reason?: string; guard?: "G1" | "G3" } {
  const detail = validateDetail(op, trip, actor);
  if (detail.valid) return { valid: true };
  return { valid: false, reason: detail.reason, guard: detail.guard };
}

/**
 * 住宿专用行为护栏（rev2 多候选，Task #80）：从指定天的候选列表移除酒店候选。
 *
 * op 通道的 remove 对 lodging / hotel 一律拒绝（住宿不套点位候选池语义，见
 * validateRemoveDetail 与执行器 applyRemove）；真正的候选移除 = 从
 * LodgingPlan.hotelRefs 移除该引用（hotelRegistry 主数据保留，移除后产生的孤儿
 * 条目由 consistency 侧 warning 提示可清理），由服务端住宿专用端点执行，执行前
 * 调用本函数做与四条护栏同源的校验：
 * - dayIndex 须为整数且在行程日期范围内；
 * - 当天须存在 LodgingPlan，且其 hotelRefs 中包含该 hotelId。
 */
export function validateLodgingCandidateRemoval(
  trip: Trip,
  dayIndex: number,
  hotelId: string,
): { valid: boolean; reason?: string } {
  if (!Number.isInteger(dayIndex)) {
    return { valid: false, reason: `住宿候选移除：dayIndex 非法：${String(dayIndex)}（须为整数，从 1 开始）` };
  }
  if (getDayByIndex(trip, dayIndex) === null) {
    return { valid: false, reason: `住宿候选移除：dayIndex 超出行程日期范围：${dayIndex}` };
  }
  const plan = trip.lodgings[String(dayIndex)];
  if (plan === undefined) {
    return { valid: false, reason: `住宿候选移除：Day${dayIndex} 无住宿计划` };
  }
  if (!Array.isArray(plan.hotelRefs) || !plan.hotelRefs.includes(hotelId)) {
    return { valid: false, reason: `住宿候选移除：Day${dayIndex} 的候选列表中不存在酒店：${hotelId}` };
  }
  return { valid: true };
}

/**
 * G2 命中筛选（PRD §12.2 基础层）：返回 search_poi 验证命中的名称；
 * 未命中项的降级入池（自定义点位 + AI 位置描述，前端标注「为AI提取」）
 * 由 F11 流水线在 resolveProposedNew 内单独处理，本函数不再丢弃未命中项。
 */
export function validateProposedNew(names: string[], searchResults: Map<string, boolean>): string[] {
  if (!Array.isArray(names)) return [];
  return names.filter((name) => searchResults.get(name) === true);
}

/**
 * C4 / Task #283：真实飞猪 POI 判定（复用 #229 伪 POI 过滤护栏思路）——
 * origin=fliggy 且 providerId 为非空串。AI 补充项（provenance=ai_supplement）打标的前置门槛：
 * 只有引用了 FlyAI 返回的真实 POI 才允许标 ai_supplement；无真实飞猪 id 者一律降级为
 * 普通 custom（不打标、不展示补充标），杜绝「无供给却以 AI 补充名义落地」。
 */
export function isRealFliggyPoi(item: Item): boolean {
  return (
    item.origin === "fliggy" &&
    typeof item.providerId === "string" &&
    item.providerId.trim() !== ""
  );
}

/**
 * C4 / Task #283 不变量护栏：任何标 provenance=ai_supplement 的 Item 必须引用真实飞猪 POI。
 * 返回违规 itemId 列表（空 = 通过）。planner 打标阶段以 isRealFliggyPoi 分流避免产生违规，
 * 落盘前再以此函数兜底核验（违规即清标），保证 ai_supplement 落盘恒满足「已飞猪核验」。
 * 纯函数、不依赖外部服务（providerId 的核验结果由调用方在打标前经 FlyAI 搜索写入）。
 */
export function validateAiSupplementProvenance(trip: Trip): string[] {
  const violations: string[] = [];
  const registry = trip.itemRegistry ?? {};
  for (const [itemId, item] of Object.entries(registry)) {
    if (item === null || typeof item !== "object") continue;
    if (item.provenance === "ai_supplement" && !isRealFliggyPoi(item)) violations.push(itemId);
  }
  return violations;
}


/**
 * G4 重排保护（PRD §12.4）：userAdjusted=true 的 Visit / Stop 只有被模型显式针对
 * （出现在 plan.assignments 中，或同批存在其 remove）才可重新安排；plan 悄悄省略时
 * 判定为越界——不拒绝 plan（执行器会把未提及项按原相对顺序追加），仅生成标注
 * 供界面提示「该项将保留原位」。只检查编排位置：globalPool 的 Visit、备选玩法与
 * 待定区的 Stop 本就处于移出状态，plan 省略它们属正常行为。
 */
function collectRearrangeWarnings(passed: Operation[], allOps: Operation[], trip: Trip): string[] {
  const removedKeys = new Set(
    allOps
      .filter((o): o is RemoveOp => o.op === "remove")
      .map((o) => refKey(o.subjectRef)),
  );
  const warnings: string[] = [];
  for (const op of passed) {
    if (op.op !== "plan") continue;
    const assignedKeys = new Set(op.assignments.map((a) => refKey(a.subjectRef)));
    for (const visitId of Object.keys(trip.visits)) {
      const visit = trip.visits[visitId]!;
      const visitKey: EntityRef = { kind: "visit", id: visitId };
      if (
        visit.userAdjusted &&
        visit.dayRef !== null &&
        !assignedKeys.has(refKey(visitKey)) &&
        !removedKeys.has(refKey(visitKey))
      ) {
        warnings.push(
          `G4：「${visitName(trip, visitId)}」为用户手动调整项，plan 未显式提及（不在 assignments 中，同批也无对应 remove），执行时将保留原位`,
        );
      }
      for (const stopId of visit.childStopRefs) {
        const stop = trip.stops[stopId];
        if (stop === undefined || !stop.userAdjusted) continue;
        const stopKey: EntityRef = { kind: "stop", id: stopId };
        if (assignedKeys.has(refKey(stopKey)) || removedKeys.has(refKey(stopKey))) continue;
        warnings.push(
          `G4：「${stopName(trip, stopId)}」为用户手动调整的内部玩法，plan 未显式提及（不在 assignments 中，同批也无对应 remove），执行时将保留原位`,
        );
      }
    }
  }
  return warnings;
}

/**
 * 综合校验入口：G1 → G3 逐条校验 + G4 标注 + 丢弃阈值（PRD §12.5 预校验阶段）。
 *
 * - 违规单条丢弃并计数（guard 标注 G1/G3，便于前端提示与日志归因）；
 * - 丢弃占比严格大于 30% 时 rejectAll=true：passed 清空、整批以 guard="threshold"
 *   标注拒绝，调用方不得落库任何操作（行程逐字段不变）；恰好 30% 不触发；
 * - ops 为空时直接放行（rejectAll=false）；
 * - options.actor 用于 G3 分流（默认 ai_proposed 最保守）；
 * - searchResults 参数供同批 proposedNew 校验上下文使用，G2 本身与 ops 正交，
 *   由 F11 流水线对 OperationSet.proposedNew 单独处理（命中筛选见 validateProposedNew）。
 */
export function checkGuards(ops: Operation[], trip: Trip, options: CheckGuardsOptions = {}): GuardResult {
  const actor: OperationActor = options.actor ?? "ai_proposed";

  const passed: Operation[] = [];
  const rejected: GuardResult["rejected"] = [];

  for (const op of ops) {
    const detail = validateDetail(op, trip, actor);
    if (detail.valid) {
      passed.push(op);
    } else {
      rejected.push({ op, guard: detail.guard ?? "G1", reason: detail.reason ?? "未知原因" });
    }
  }

  // 丢弃阈值（PRD：恰好 30% 不整批拒绝，严格大于才触发）
  const rejectAll = ops.length > 0 && rejected.length / ops.length > 0.3;

  if (rejectAll) {
    return {
      passed: [],
      rejected: ops.map((op) => ({ op, guard: "threshold", reason: "违规率超过30%，整批拒绝" })),
      rejectAll: true,
    };
  }

  const result: GuardResult = { passed, rejected, rejectAll: false };
  const warnings = collectRearrangeWarnings(passed, ops, trip);
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}
