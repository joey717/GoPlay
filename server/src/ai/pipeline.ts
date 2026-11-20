/**
 * F11 意图编排流水线（PRD「智能行程编排」端到端主链路）。
 *
 * 执行顺序（每步失败即短路）：
 *   loadTrip → 多轮会话判定（Task #70：入参 sessionId 且状态 idle → 复用只发增量意图；
 *   否则新建完整 prompt + title）→ 百炼 SSE（全量重排意图 90s / 其余 60s 预算；
 *   仅 finalText 空/异常短时重试一次，充分但损坏时走本地保守修复，不盲调）
 *   → clarify 短路 → baseVersion 乐观锁（模型输出必须基于当前行程版本；复用多轮
 *   会话时基线先对齐当前版本再校验，Task #75）
 *   → G2 proposedNew 真实搜索验证（命中项写入 itemRegistry 入全局候选区；
 *   明确未命中时降级为自定义点位入池，address 承载 AI 的 reason 位置描述；
 *   搜索异常仍丢弃，避免服务故障时误入池）
 *   → 四条护栏（G1/G3 逐条 + G4 标注 + 30% 整批拒绝阈值）
 *   → 全量重排挂起待确认（scopeRef=allDays 或 plan 覆盖多天的等价形状）/ 其余走 applyOps 应用
 *   → consistencyErrors 非空视为整批失败不落盘 → saveTrip 持久化 → 返回 IntentResult。
 *
 * 职责边界：
 * - 复用 bailian / flyai / persistence / shared 既有实现，不在本模块重写；
 * - 模型输出一律不可信：解析层做结构归一化（含 plan.scope / assign 的严格
 *   无损归一化，见 planScope.ts），护栏层做语义校验，执行器保证自洽；
 * - 整批拒绝时不落库任何变更（行程逐字段不变）；
 * - 护栏拒绝项以 `[guard] reason` 原样并入 result.rejected，前端逐条展示
 *   「未执行原因」，不得静默丢弃；
 * - 全量重排（批内任一条 plan scopeRef=allDays，或批内 plan 的 assignments 合计覆盖
 *   多个 dayIndex）不得直接应用：非敏感操作整批挂起并返回
 *   多个 dayIndex）不得直接应用：非敏感操作整批挂起并返回
 *   proposal.fullPlanOps，前端确认后经 /intent/confirm 二次下发（服务端仍重过
 *   四条护栏）；挂起阶段不落盘任何变更，取消即零变更。敏感操作照旧走
 *   needsProposal → ProposalCard 逐条确认。
 */

import type {
  ApplyResult,
  EntityRef,
  GuardResult,
  Item,
  Operation,
  OperationActor,
  OperationSet,
  Trip,
} from "@goplay/shared";
import {
  applyOps,
  BATCH_REJECTION_GUIDANCE,
  checkGuards,
  collectAreaPlaceholderVisitIds,
  deepClone,
  evaluateDayCapacity,
  resolveItemCoords,
} from "@goplay/shared";
import { randomUUID } from "node:crypto";
import {
  BailianTimeoutError,
  createBailianSession,
  getSessionStatus,
} from "../bailian/client.js";
import { repairJsonCandidates } from "./jsonRepair.js";
import type { FlyAIPoi } from "../flyai/client.js";
import { searchPoi } from "../flyai/client.js";
import { tripStore } from "../persistence/store.js";
import { lastBalancedJsonValue } from "./lastJson.js";
import { describePlanCoverage, isFullPlanBatch, normalizePlanFields } from "./planScope.js";
import { buildIntentPrompt } from "./prompt.js";

/** F11 意图编排结果（routes 层原样 JSON 返回给前端） */
export interface IntentResult {
  type: "clarify" | "applied" | "proposal" | "rejected" | "error";
  /**
   * 本轮实际使用的百炼 Session ID（Task #70 多轮会话：新建或复用，非空字符串；
   * 前端原样回传即可续接同一会话上下文。仅在无法确定 Session 的极早失败
   * （行程不存在 / 超时且为新建路径）时为请求携带值回显或空串，空串视为新建）。
   */
  sessionId: string;
  clarify?: string;
  result?: ApplyResult;
  /** 敏感操作（remove / setPurchase / lock）→ 前端 ProposalCard 逐条确认 */
  proposalOps?: Operation[];
  /**
   * 全量重排（op=plan 且 scope=all）挂起待确认的非敏感操作：前端弹 ConfirmDialog，
   * 确认后经 /api/ai/intent/confirm 二次下发（服务端仍重过四条护栏）；取消不落地。
   */
  fullPlanOps?: Operation[];
  message?: string;
  /**
   * 本轮 G2 搜索命中并新入全局候选池的点位名称列表（Task #75）：
   * proposedNew-only（operations 全未落地或为空）时前端据此给出持久反馈
   * 并自动打开候选池，避免新点位静默入池只剩 3.2s 闪现通知。
   */
  newPoolItems?: string[];
}

/** 全量重排意图的百炼超时预算：实测 60-76s，放宽到 90s（Task #42） */
const COMPLEX_INTENT_TIMEOUT_MS = 90_000;

/** 常规意图的百炼超时预算（F11 原 60s 契约） */
const DEFAULT_INTENT_TIMEOUT_MS = 60_000;

/**
 * finalText 重试阈值：空 / 异常短（< 此长度）视为流异常，可重试一次；
 * 达到此长度仍无法解析视为「响应充分但 JSON 损坏」，不重调完整 prompt。
 * 合法 OperationSet（含 clarify 反问）实测远长于此值（task40 夹具 ≥ 1500 字符）。
 */
const RETRYABLE_FINALTEXT_MIN_CHARS = 256;

/** 全量重排范围词：全部 / 整个 / 从头等（用户意图原文，非模型输出） */
const FULL_REPLAN_SCOPE_PATTERN = /(全部|所有|整个|整段|整体|全行程|从头|重头)/;

/** 全量重排动词：重排 / 重新安排 / 重新规划 / 排一版等 */
const FULL_REPLAN_VERB_PATTERN = /(重排|重新(排|安排|规划|编)|编排|排一版|排一遍|规划|安排)/;

/**
 * 按原始意图关键词识别「复杂全量重排」：范围词 + 重排动词同时出现才命中
 * （如「全部重排行程」「重新排一版整个行程」「把五天的行程全部重新安排一遍」）。
 * 误报只会多给 30s 预算（安全方向），漏报维持原有 60s；不影响任何校验逻辑。
 */
export function isFullReplanIntent(intentText: string): boolean {
  return FULL_REPLAN_SCOPE_PATTERN.test(intentText) && FULL_REPLAN_VERB_PATTERN.test(intentText);
}

/** 解析失败（含本地修复失败）的用户可读文案：与「处理超时」明确区分 */
const PARSE_FAILED_MESSAGE = "响应格式异常：AI 返回内容无法解析为有效操作，请重试或换一种说法";

// ===== 结果分流辅助（Task #35） =====

/** 敏感操作判定：与 shared.operations 的确认分流（needsProposal）保持一致 */
function isSensitiveOp(op: Operation): boolean {
  return op.op === "remove" || op.op === "setPurchase" || op.op === "lock";
}

/** 护栏拒绝项并入 ApplyResult.rejected：保留具体 guard 与 reason（与 /intent/confirm 同格式） */
function mergeGuardRejections(result: ApplyResult, rejections: GuardResult["rejected"]): ApplyResult {
  for (const rejection of rejections) {
    result.rejected.push({ op: rejection.op, reason: `[${rejection.guard}] ${rejection.reason}` });
  }
  return result;
}

// ===== Task #316 前置剥离：stripUnsupportedStopOps =====

/**
 * 前置剥离结果：remaining 是仍需走 checkGuards 的操作；stripped 是「注定被 G1 硬拒」
 * 的 stop 越权操作（附原始 G1 理由，必须进入响应 rejected 明细，不得静默丢弃）。
 */
interface StripResult {
  remaining: Operation[];
  stripped: { op: Operation; guard: string; reason: string }[];
}

/**
 * 剥离「注定被 G1 硬拒」的 stop 越权操作（Task #316，与 B3 通道 #218 filterPendingStopAssignments 同构防御）。
 *
 * 背景：AI 偶尔违反 prompt 禁令，对内部玩法输出 setTime / setPurchase / lock，
 * 或在 plan 中把 stop 排入 day 容器（正确目标是 visit 容器）——这些操作 100% 被 G1 拒绝，
 * 但小批量时 1-3 条违规即可触发 30% 阈值放大成整批拒绝，合法操作全部陪葬。
 *
 * 剥离语义表（剥 / 不剥）：
 * - 剥离：subjectRef kind=stop 的 setTime / setPurchase / lock（适用矩阵硬拒）
 * - 剥离：plan 中 stop assignment 且 containerRef.kind=day（应排入 visit）
 * - 不剥：plan stop 入 visit 容器（合法操作）
 * - 不剥：transfer stop→pendingPool（G3 用户决定红线，保留进分子，安全语义不动）
 * - 不剥：move / remove / setDuration 等 stop 合法操作
 *
 * 设计约束：
 * - 剥离项不进 30% 分子分母（护栏不再因必拒项膨胀拒绝率）
 * - 剥离项必须进入响应 rejected 明细并带原始 G1 理由（可见，不得静默丢弃，遵守 #22-23 契约）
 * - 剥离后若剩余 ops 为空→调用方返回 rejected 型响应附逐条理由（不得静默 no-op）
 * - 剥离幂等：无 stop 越权 ops 时零影响（remaining === 原 operations）
 */
export function stripUnsupportedStopOps(operations: Operation[]): StripResult {
  const stripped: StripResult["stripped"] = [];
  const remaining: Operation[] = [];

  for (const op of operations) {
    // 1) 直接拒绝：setTime / setPurchase / lock 对 stop
    if ("subjectRef" in op && op.subjectRef.kind === "stop") {
      if (op.op === "setTime") {
        stripped.push({
          op,
          guard: "G1",
          reason: "setTime：内部玩法不支持设置具体开始时间（只维护顺序、建议时长、位置提示、票务关系）",
        });
        console.log(`[AI] Task #316 前置剥离：stop ${op.subjectRef.id} 的 setTime 操作（注定被 G1 拒绝）`);
        continue;
      }
      if (op.op === "setPurchase") {
        stripped.push({
          op,
          guard: "G1",
          reason: "setPurchase：内部玩法不支持独立购买状态（票务由父景区大门票承担）",
        });
        console.log(`[AI] Task #316 前置剥离：stop ${op.subjectRef.id} 的 setPurchase 操作（注定被 G1 拒绝）`);
        continue;
      }
      if (op.op === "lock") {
        stripped.push({
          op,
          guard: "G1",
          reason: "lock：内部玩法不支持锁定（锁定属于 Visit，随父景区整体生效）",
        });
        console.log(`[AI] Task #316 前置剥离：stop ${op.subjectRef.id} 的 lock 操作（注定被 G1 拒绝）`);
        continue;
      }
    }

    // 2) plan 操作中 stop→day 容器的 assignment 剥离（stop→visit 容器合法，不剥）
    if (op.op === "plan") {
      const badAssignments = op.assignments.filter(
        (a) => a.subjectRef.kind === "stop" && a.containerRef.kind === "day",
      );
      if (badAssignments.length === 0) {
        remaining.push(op);
        continue;
      }
      const goodAssignments = op.assignments.filter(
        (a) => !(a.subjectRef.kind === "stop" && a.containerRef.kind === "day"),
      );
      // 整条 plan 作为 stripped 记录（附 G1 理由）
      for (const a of badAssignments) {
        const stopId = a.subjectRef.kind === "stop" ? a.subjectRef.id : String(a.subjectRef.kind);
        stripped.push({
          op: { ...op, assignments: [a] } as Operation,
          guard: "G1",
          reason: `内部玩法只能编入 visit 容器（subjectRef ${stopId}）`,
        });
        console.log(
          `[AI] Task #316 前置剥离：plan 中 stop ${stopId}→day 容器 assignment（注定被 G1 拒绝）`,
        );
      }
      if (goodAssignments.length > 0) {
        remaining.push({ ...op, assignments: goodAssignments } as Operation);
      }
      continue;
    }

    // 3) transfer stop→pendingPool：G3 用户决定红线，**不剥**（保留进分子，安全语义不动）
    remaining.push(op);
  }

  return { remaining, stripped };
}

// ===== Task #325 前置剥离：stripOverloadedDayOps（抵达日 / 返程日容量规则） =====

/**
 * 容量剥离结果：remaining 是仍需走 checkGuards 的操作；stripped 是超出抵达日 /
 * 返程日容量的「本批 AI 净新增」项（reason 已含 [容量] 前缀与距离数值，直接进
 * rejected 明细，无需再包 [guard] 前缀）。
 */
interface CapacityStripResult {
  remaining: Operation[];
  stripped: { op: Operation; reason: string }[];
}

/** 单条「本批新增到某天的城市级 Visit」候选（plan assignment 或 transfer） */
interface DayAddUnit {
  opIndex: number;
  /** plan 走 assignment 下标；transfer 为 null（整条 op 即一个单元） */
  assignmentIndex: number | null;
  dayIndex: number;
  coords: { lng: number; lat: number } | null;
  name: string;
  /** locked / bought / userAdjusted / 区域占位 → 不计入容量、不剥离 */
  exempt: boolean;
}

/**
 * 解析 plan/transfer/remove 的 subjectRef 为「城市级 Visit 候选」的坐标 / 名称 / 豁免态。
 * 返回 null 表示该 subject 不是城市级 Visit（stop / day / 无法解析），不参与容量判定。
 * currentDayId 用于识别「已在目标天」的既有 visit（非净新增，不计入、不剥离）。
 */
function resolveAddSubject(
  trip: Trip,
  subjectRef: EntityRef,
  placeholderIds: ReadonlySet<string>,
): { coords: { lng: number; lat: number } | null; name: string; exempt: boolean; currentDayId: string | null } | null {
  if (subjectRef.kind === "visit") {
    const visit = trip.visits[subjectRef.id];
    if (visit === undefined) return null;
    const item = trip.itemRegistry[visit.pointRef];
    const exempt =
      visit.locked === true ||
      visit.purchaseState === "bought" ||
      visit.userAdjusted === true ||
      placeholderIds.has(visit.visitId);
    return {
      coords: resolveItemCoords(item),
      name: item?.name ?? subjectRef.id,
      exempt,
      currentDayId: visit.dayRef,
    };
  }
  if (subjectRef.kind === "point") {
    const item = trip.itemRegistry[subjectRef.id];
    if (item === undefined) return null;
    // 候选区点位进 Day 时新建 Visit，无既有锁定 / 购买 / 手调态
    return { coords: resolveItemCoords(item), name: item.name ?? subjectRef.id, exempt: false, currentDayId: null };
  }
  // stop / day：非城市级 Visit，不参与容量判定
  return null;
}

/**
 * 剥离超出「抵达日 / 行程最后一天」容量的本批 AI 净新增操作（Task #325，D1-D3 计数型规则）。
 *
 * 背景：容量规则若进 guards，小批量时「3 条拒 1 条 = 33%」会触发 30% 整批拒绝，
 * 合法操作全部陪葬（对标 #314/#316 的 33% 故障）。故走前置剥离：不进 30% 分子分母，
 * 但进 rejected 明细（可见、不得静默丢弃）。
 *
 * 剥离语义（与设计文档 §3 阈值表一致，判定单源于 shared.evaluateDayCapacity）：
 * - 只处理 actor==="ai_proposed"（用户手工通道完全不受限，与 G3 actor 分流同口径）；
 * - 只统计 plan（containerRef.kind==="day"）与 transfer（toContainerRef.kind==="day"）的净新增；
 * - 同批 remove（fromContainerRef.kind==="day"）对冲名额（先算净增量再判阈值）；
 * - 豁免五类：locked / bought / userAdjusted / 区域占位 / 该天既有非本批 Visit → 不计入、不剥离；
 * - 逐条贪心：按顺序接纳，超出容量或距机场超阈的新增项被剥离（点级 reason）。
 *
 * 设计约束：
 * - 剥离项不进 30% 分子分母（护栏不再因容量违规膨胀拒绝率）；
 * - 剥离项必须进 rejected 明细并带 [容量] 理由与距离数值（可见）；
 * - 幂等：无违规时 remaining === 原 operations（引用相等）。
 */
export function stripOverloadedDayOps(
  operations: Operation[],
  trip: Trip,
  actor: OperationActor,
): CapacityStripResult {
  // 用户手工 / 确认通道完全不受容量限制
  if (actor !== "ai_proposed") return { remaining: operations, stripped: [] };

  const placeholderIds = collectAreaPlaceholderVisitIds(trip);

  // 1) 收集本批「净新增到某天」的城市级 Visit 单元 + remove 对冲
  const addUnitsByDay = new Map<number, DayAddUnit[]>();
  const removeOffsetByDay = new Map<number, number>();

  operations.forEach((op, opIndex) => {
    if (op.op === "plan") {
      op.assignments.forEach((a, assignmentIndex) => {
        if (a.containerRef.kind !== "day") return;
        const resolved = resolveAddSubject(trip, a.subjectRef, placeholderIds);
        if (resolved === null) return;
        const dayIndex = a.containerRef.dayIndex;
        // 已在目标天的既有 visit → 非净新增，跳过
        const targetDayId = trip.dayRefs[dayIndex - 1];
        if (resolved.currentDayId !== null && resolved.currentDayId === targetDayId) return;
        const bucket = addUnitsByDay.get(dayIndex) ?? [];
        bucket.push({ opIndex, assignmentIndex, dayIndex, coords: resolved.coords, name: resolved.name, exempt: resolved.exempt });
        addUnitsByDay.set(dayIndex, bucket);
      });
    } else if (op.op === "transfer") {
      if (op.toContainerRef.kind !== "day") return;
      const resolved = resolveAddSubject(trip, op.subjectRef, placeholderIds);
      if (resolved === null) return;
      const dayIndex = op.toContainerRef.dayIndex;
      const targetDayId = trip.dayRefs[dayIndex - 1];
      if (resolved.currentDayId !== null && resolved.currentDayId === targetDayId) return;
      const bucket = addUnitsByDay.get(dayIndex) ?? [];
      bucket.push({ opIndex, assignmentIndex: null, dayIndex, coords: resolved.coords, name: resolved.name, exempt: resolved.exempt });
      addUnitsByDay.set(dayIndex, bucket);
    } else if (op.op === "remove") {
      if (op.fromContainerRef.kind !== "day") return;
      const resolved = resolveAddSubject(trip, op.subjectRef, placeholderIds);
      // 只有非豁免的城市级 Visit 移除才真正腾出名额
      if (resolved === null || resolved.exempt) return;
      const dayIndex = op.fromContainerRef.dayIndex;
      removeOffsetByDay.set(dayIndex, (removeOffsetByDay.get(dayIndex) ?? 0) + 1);
    }
  });

  // 2) 逐天贪心判定，标记需剥离的单元
  //    key = `${opIndex}:${assignmentIndex ?? "op"}`
  const strippedByKey = new Map<string, { opIndex: number; assignmentIndex: number | null; reason: string }>();

  for (const [dayIndex, units] of addUnitsByDay) {
    const dayId = trip.dayRefs[dayIndex - 1];
    const day = dayId !== undefined ? trip.days[dayId] : undefined;
    if (day === undefined) continue;

    // 该天既有的非豁免 visit 条数（不含区域占位 / locked / bought / userAdjusted）
    const existingAiCount = day.scheduleVisitRefs.filter((vid) => {
      if (placeholderIds.has(vid)) return false;
      const v = trip.visits[vid];
      if (v === undefined) return false;
      return !(v.locked === true || v.purchaseState === "bought" || v.userAdjusted === true);
    }).length;

    const removeOffset = removeOffsetByDay.get(dayIndex) ?? 0;
    const effectiveExisting = Math.max(0, existingAiCount - removeOffset);

    let accepted = 0;
    for (const unit of units) {
      if (unit.exempt) continue; // 豁免项：保留，不占容量
      // 单源于 shared.evaluateDayCapacity：netAddCount = 已接纳 + 当前这条
      const verdict = evaluateDayCapacity(trip, dayIndex, accepted + 1, [unit.coords], [unit.name], effectiveExisting);
      if (verdict.ok) {
        accepted++;
      } else {
        const key = `${unit.opIndex}:${unit.assignmentIndex ?? "op"}`;
        strippedByKey.set(key, { opIndex: unit.opIndex, assignmentIndex: unit.assignmentIndex, reason: verdict.reason ?? "[容量] 超出当天容量，未排入" });
      }
    }
  }

  // 3) 幂等：无剥离项 → 原样返回（引用相等）
  if (strippedByKey.size === 0) return { remaining: operations, stripped: [] };

  // 4) 重建 operations：plan 过滤被剥离的 assignment；transfer 整条剥离
  const remaining: Operation[] = [];
  const stripped: CapacityStripResult["stripped"] = [];

  operations.forEach((op, opIndex) => {
    if (op.op === "plan") {
      const strippedAssignIdxs = new Set<number>();
      for (const s of strippedByKey.values()) {
        if (s.opIndex === opIndex && s.assignmentIndex !== null) strippedAssignIdxs.add(s.assignmentIndex);
      }
      if (strippedAssignIdxs.size === 0) {
        remaining.push(op);
        return;
      }
      const keptAssignments = op.assignments.filter((_, i) => !strippedAssignIdxs.has(i));
      for (const i of strippedAssignIdxs) {
        const s = strippedByKey.get(`${opIndex}:${i}`);
        stripped.push({ op: { ...op, assignments: [op.assignments[i]] } as Operation, reason: s?.reason ?? "[容量] 超出当天容量，未排入" });
      }
      if (keptAssignments.length > 0) remaining.push({ ...op, assignments: keptAssignments } as Operation);
      return;
    }
    // transfer（整条即一个单元）
    const key = `${opIndex}:op`;
    const s = strippedByKey.get(key);
    if (s !== undefined) {
      stripped.push({ op, reason: s.reason });
      return; // 整条剥离，不进 remaining
    }
    remaining.push(op);
  });

  return { remaining, stripped };
}

// ===== OperationSet 解析与归一化 =====

const CODE_FENCE_PATTERN = /```(?:json)?\s*([\s\S]*?)```/i;

/**
 * 结构归一化：operations 必为存在且每项带 op 字段的数组，其余字段按契约兜底。
 * 导出供 B3 攻略草案解析（guides/planner.ts）复用同一操作归一化，不另建第二套。
 */
export function normalizeOperationSet(value: unknown): OperationSet | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.operations)) return null;

  const operations: Operation[] = [];
  for (const entry of record.operations) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.op !== "string" || candidate.op.length === 0) return null;
    // plan 的 scope / assign 数值字段做严格无损归一化（Task #40，见 planScope.ts）：
    // 真实模型可能输出字符串 dayIndex / 中文 scope 等变体，避免字面判定与护栏误拒
    operations.push(normalizePlanFields(candidate));
  }

  // unplaced 条目：{ subjectRef: EntityRef, reason }（PRD §9.5）；subjectRef 必须是
  // 合法 EntityRef 形状（kind ∈ day/point/visit/stop/lodging），非法条目整体丢弃
  const unplaced: OperationSet["unplaced"] = Array.isArray(record.unplaced)
    ? record.unplaced
        .filter((entry): entry is Record<string, unknown> => {
          if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
          const subjectRef = (entry as Record<string, unknown>).subjectRef;
          if (typeof subjectRef !== "object" || subjectRef === null || Array.isArray(subjectRef)) return false;
          const kind = (subjectRef as Record<string, unknown>).kind;
          return kind === "day" || kind === "point" || kind === "visit" || kind === "stop" || kind === "lodging";
        })
        .map((entry) => ({
          subjectRef: entry.subjectRef as EntityRef,
          reason: typeof entry.reason === "string" ? entry.reason : "",
        }))
    : [];

  const proposedNew: OperationSet["proposedNew"] = Array.isArray(record.proposedNew)
    ? record.proposedNew
        .filter(
          (entry): entry is Record<string, unknown> =>
            typeof entry === "object" && entry !== null && typeof (entry as Record<string, unknown>).name === "string",
        )
        .map((entry) => ({
          name: (entry.name as string).trim(),
          // AI 的位置/推荐描述（Task #76）：FlyAI 未命中时降级为自定义点位 address；缺失不猜测
          reason:
            typeof entry.reason === "string" && entry.reason.trim() !== "" ? entry.reason.trim() : null,
        }))
        .filter((entry) => entry.name !== "")
    : [];

  const clarify =
    typeof record.clarify === "string" && record.clarify.trim() !== "" ? record.clarify.trim() : null;

  // baseVersion（PRD §9.5）：缺失 / 非整数按 0 —— 必然与当前行程版本不符，
  // 由 applyOperationSet 的乐观锁门槛整批拒绝，绝不猜测模型意图
  const baseVersionRaw = record.baseVersion;
  const baseVersion =
    typeof baseVersionRaw === "number" && Number.isInteger(baseVersionRaw)
      ? baseVersionRaw
      : typeof baseVersionRaw === "string" && /^-?\d+$/.test(baseVersionRaw.trim())
        ? Number(baseVersionRaw.trim())
        : 0;

  return { baseVersion, operations, unplaced, proposedNew, clarify };
}

/**
 * 从模型 finalText 中解析 OperationSet：
 * 直接 parse → markdown code block 提取 → 首尾大括号截取 → 最后一个平衡 JSON 块
 * （兜底百炼 SSE 间歇性 prompt 回显，见 lastJson.ts）→ 保守结构修复候选
 * （悬空逗号 / EOF 补闭合，见 jsonRepair.ts），逐个候选尝试，所有候选都过
 * 同一结构归一化；全部失败返回 null（由调用方按分级策略决定重试或拒绝）。
 *
 * 导出供 Task #40 夹具回归（verify-task40.ts）用真实模型输出重放解析链路。
 */
export function parseOperationSet(finalText: string): OperationSet | null {
  const trimmed = finalText.trim();
  const candidates: string[] = [];
  const fenced = trimmed.match(CODE_FENCE_PATTERN)?.[1];
  if (fenced) candidates.push(fenced.trim());
  candidates.push(trimmed);
  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(trimmed.slice(objectStart, objectEnd + 1));
  }
  const lastBalanced = lastBalancedJsonValue(trimmed);
  if (lastBalanced !== null) candidates.push(lastBalanced);

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const normalized = normalizeOperationSet(parsed);
    if (normalized !== null) return normalized;
  }

  // 保守修复兜底（Task #42）：只做可验证的语法修复，不猜业务字段；修复候选
  // 仍走同一 parse + normalizeOperationSet 校验，护栏在后续链路照常生效。
  // 括号交错类损坏（task40 full-replan-2/5）不在可安全修复范畴 → 维持 null。
  for (const candidate of repairJsonCandidates(finalText)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const normalized = normalizeOperationSet(parsed);
    if (normalized !== null) {
      console.log("[AI] 响应经保守 JSON 修复后解析成功（仅悬空逗号/EOF 补闭合类修复）");
      return normalized;
    }
  }
  return null;
}

// ===== G2 proposedNew 验证 =====

/** 搜索命中后构建全局候选区点位主数据（origin=fliggy；时长待定不冒充先验值） */
function buildCandidatePoint(name: string, poi: FlyAIPoi): Item {
  return {
    itemId: randomUUID(),
    name,
    origin: "fliggy",
    providerId: poi.id,
    address: poi.address,
    category: poi.category,
    coords: poi.coords,
    suggestMinutes: null, // 搜索结果无真实时长数据，保持待定
    mainPic: poi.mainPic,
    ticketInfo: poi.ticketInfo,
    jumpUrl: poi.jumpUrl,
    // Task #329：免费状态透传（免税城等免费场所不得透出购票语义）；未携带时缺省，读时默认 null
    freePoiStatus: poi.freePoiStatus ?? undefined,
    // Task #330：飞猪 POI 元信息透传（等级/榜单/介绍）；未携带时缺省，读时默认 null，不伪造
    poiLevel: poi.poiLevel ?? undefined,
    listRank: poi.listRank ?? undefined,
    description: poi.description ?? undefined,
    sourceEvidenceRefs: [],
  };
}

/**
 * proposedNew 明确未命中飞猪时降级为自定义点位主数据（Task #76）：
 * address 承载 AI 的 reason 位置描述（前端标注「为AI提取，可确认是否准确」），
 * 供应商字段一律 null 不伪造；reason 缺失时 address 保持 null，由前端如实提示。
 */
function buildCustomCandidatePoint(name: string, reason: string | null): Item {
  return {
    itemId: randomUUID(),
    name,
    origin: "custom",
    providerId: null,
    address: reason,
    category: null,
    coords: null,
    suggestMinutes: null,
    mainPic: null,
    ticketInfo: null,
    jumpUrl: null,
    sourceEvidenceRefs: [],
  };
}

/**
 * G2 proposedNew 验证：逐个经真实 search_poi 验证后分流入池——
 * 命中 → 飞猪点位（供应商字段完整）；明确未命中 → 自定义点位（address=AI
 * 位置描述，用户可见可删）；搜索异常（服务故障≠未收录）→ 丢弃，避免故障时批量误入池。
 */
async function resolveProposedNew(
  trip: Trip,
  proposedNew: OperationSet["proposedNew"],
): Promise<Item[]> {
  if (proposedNew.length === 0) return [];

  const city = trip.destination.city.trim();
  const results: Item[] = [];

  for (const { name, reason } of proposedNew) {
    const query = city !== "" ? `${city} ${name}` : name;
    try {
      const result = await searchPoi(query);
      const first = result.normalized[0];
      if (first !== undefined) {
        results.push(buildCandidatePoint(name, first));
        console.log(`[AI] G2 proposedNew「${name}」搜索命中，入池为飞猪点位（${result.latencyMs}ms）`);
      } else {
        results.push(buildCustomCandidatePoint(name, reason));
        console.log(
          `[AI] G2 proposedNew「${name}」搜索未命中，降级自定义点位入池（address=AI位置描述${reason === null ? "缺失" : "已填充"}）`,
        );
      }
    } catch (error) {
      console.error(`[AI] G2 proposedNew「${name}」搜索失败，按异常丢弃不入池：`, error);
    }
  }
  return results;
}

// ===== 百炼调用（分级超时 + 分级重试，Task #42） =====

/** callAndParse 结果：解析出的操作集（null 表示不可解析）+ 本轮实际使用的 Session ID */
interface CallAndParseOutcome {
  operationSet: OperationSet | null;
  sessionId: string;
}

/**
 * 调百炼并解析 OperationSet（分级重试策略，Task #70 支持会话透传）：
 * - finalText 空 / 异常短（< RETRYABLE_FINALTEXT_MIN_CHARS）→ 视为流异常，最多重试一次；
 * - finalText 充分但 JSON 损坏 → 不再重调完整 prompt（全量重排实测 60-76s/次，
 *   盲目重试会拖到 120-150s），解析层已含本地保守修复，修复失败返回 null；
 * - session.sessionId 提供时透传复用（重试也在同一会话内追加），否则新建并携带 title；
 * - 返回本轮实际使用的 sessionId（取最后一次成功返回响应的那次调用）。
 * 网络 / 超时异常向上抛出（BailianTimeoutError 由 executeIntent 转用户文案）。
 */
async function callAndParse(
  prompt: string,
  timeoutMs: number,
  session: { sessionId?: string; title?: string } = {},
): Promise<CallAndParseOutcome> {
  const result = await createBailianSession(prompt, { timeoutMs, ...session });
  console.log(
    `[AI] 百炼返回 ${result.finalText.length} 字符，耗时 ${result.latencyMs}ms（超时预算 ${Math.round(timeoutMs / 1000)}s，session=${result.sessionId}）`,
  );
  const parsed = parseOperationSet(result.finalText);
  if (parsed !== null) {
    return { operationSet: parsed, sessionId: result.sessionId };
  }

  const textLength = result.finalText.trim().length;
  if (textLength >= RETRYABLE_FINALTEXT_MIN_CHARS) {
    console.error(
      `[AI] 响应充分（${textLength} 字符）但无法解析为 OperationSet，不再重调完整 prompt；前 200 字符：${result.finalText.slice(0, 200)}`,
    );
    return { operationSet: null, sessionId: result.sessionId };
  }
  console.warn(`[AI] finalText 异常短（${textLength} 字符），按流异常重试一次（同一超时预算）`);
  const retry = await createBailianSession(prompt, { timeoutMs, ...session });
  console.log(`[AI] 百炼重试返回 ${retry.finalText.length} 字符，耗时 ${retry.latencyMs}ms`);
  const retryParsed = parseOperationSet(retry.finalText);
  if (retryParsed !== null) {
    return { operationSet: retryParsed, sessionId: retry.sessionId };
  }
  console.error(
    `[AI] 重试响应仍无法解析（${retry.finalText.trim().length} 字符），前 200 字符：${retry.finalText.slice(0, 200)}`,
  );
  return { operationSet: null, sessionId: retry.sessionId };
}

// ===== 流水线入口 =====

/**
 * 归一化后的操作集落地：G2 搜索验证 → 四条护栏 → 全量重排确认分流 →
 * applyOps 应用 → 持久化 → 按结果分发（applied / proposal / rejected）。
 *
 * 与 executeIntent 分离，使「护栏 / 分流 / 应用」链路可脱离模型做回归验证
 * （proposedNew 为空时不触网，见 verify-task35.ts）；sessionId 由 executeIntent
 * 透传（回归脚本直接调用时缺省空串，不参与任何业务判断）；isReusedSession 仅
 * executeIntent 复用多轮会话时置 true（回归脚本缺省 false，乐观锁行为不变）。
 */
export async function applyOperationSet(
  trip: Trip,
  operationSet: OperationSet,
  sessionId: string = "",
  isReusedSession = false,
): Promise<IntentResult> {
  // 4.5 乐观锁门槛（PRD §9.5 baseVersion）：模型输出基于旧版本时整批拒绝，防止覆盖并发修改。
  // Task #75 多轮复用例外：复用百炼 Session 只发增量意图，模型看不到最新 baseVersion，
  // 而上一轮 save 已递增 trip.version → 乐观锁必然误拒。故复用会话时先把 baseVersion
  // 对齐当前版本再校验；并发安全性不受影响——四条护栏仍按当前行程校验实体引用，
  // 引用已被并发修改移除的点位照样被拒（见 verify-task35 用例 1/2）。
  if (isReusedSession && operationSet.baseVersion !== trip.version) {
    console.log(
      `[AI] 多轮复用会话：模型 baseVersion=${operationSet.baseVersion} 已过期，对齐当前 v${trip.version} 后继续（护栏照常校验）`,
    );
    operationSet = { ...operationSet, baseVersion: trip.version };
  }
  if (operationSet.baseVersion !== trip.version) {
    console.warn(
      `[AI] baseVersion 不匹配：请求基于 v${operationSet.baseVersion}，当前 v${trip.version}，整批拒绝`,
    );
    return {
      type: "error",
      message: `行程版本已更新（当前 v${trip.version}，请求基于 v${operationSet.baseVersion}），请重新描述需求`,
      sessionId,
    };
  }

  // 5. G2 proposedNew：真实搜索验证分流入池——命中为飞猪点位，明确未命中降级
  // 自定义点位（address=AI 位置描述）；后续 plan/transfer 才可引用
  const newPoolItems = await resolveProposedNew(trip, operationSet.proposedNew);
  const workingTrip = deepClone(trip);
  for (const item of newPoolItems) {
    workingTrip.itemRegistry[item.itemId] = item;
    workingTrip.globalCandidateRefs.push({ kind: "point", id: item.itemId });
  }

  // 5.5 Task #316 前置剥离：把「注定被 G1 硬拒」的 stop 越权操作剥离出来，
  // 剥离项不进 30% 分子分母，但必须进入响应 rejected 明细（可见、不得静默丢弃）。
  const stripResult = stripUnsupportedStopOps(operationSet.operations);
  const strippedRejections = stripResult.stripped;

  // 5.6 Task #325 前置剥离：把超出抵达日 / 返程日容量的本批 AI 净新增剥离出来。
  // 容量规则禁止进 guards（3 条拒 1 条=33% 会触发 30% 整批拒绝）——走前置剥离：
  // 不进 30% 分子分母、进 rejected 明细（reason 已含 [容量] 前缀与距离数值）。
  const capacityResult = stripOverloadedDayOps(stripResult.remaining, workingTrip, "ai_proposed");
  const capacityRejections = capacityResult.stripped;
  const finalRemaining = capacityResult.remaining;

  // 剥离后若剩余 ops 为空→返回 rejected 型响应附逐条理由（不得静默 no-op）
  if (finalRemaining.length === 0 && strippedRejections.length + capacityRejections.length > 0) {
    const rejectedResult: ApplyResult = {
      trip: workingTrip,
      applied: [],
      rejected: [],
      needsProposal: [],
      consistencyErrors: [],
    };
    for (const item of strippedRejections) {
      rejectedResult.rejected.push({ op: item.op, reason: `[${item.guard}] ${item.reason}` });
    }
    for (const item of capacityRejections) {
      rejectedResult.rejected.push({ op: item.op, reason: item.reason });
    }
    console.log(`[AI] Task #316/#325：全部 ${strippedRejections.length + capacityRejections.length} 条操作均被前置剥离（stop 越权 ${strippedRejections.length} / 容量 ${capacityRejections.length}），无剩余操作`);
    return {
      type: "rejected",
      message: `本批 ${strippedRejections.length + capacityRejections.length} 条操作均被前置剥离（内部玩法越权 / 超出抵达日·返程日容量），已附逐条理由，行程未修改`,
      result: rejectedResult,
      sessionId,
    };
  }
  if (strippedRejections.length > 0) {
    console.log(
      `[AI] Task #316：前置剥离 ${strippedRejections.length} 条 stop 越权操作，剩余继续护栏校验`,
    );
  }
  if (capacityRejections.length > 0) {
    console.log(
      `[AI] Task #325：前置剥离 ${capacityRejections.length} 条超容量操作（抵达日/返程日），剩余 ${finalRemaining.length} 条继续护栏校验`,
    );
  }

  // 6. 四条护栏：G1/G3 逐条校验 + G4 标注 + 30% 整批拒绝阈值（对剥离后剩余操作）
  const guardResult = checkGuards(finalRemaining, workingTrip, { actor: "ai_proposed" });
  if (guardResult.rejectAll) {
    // 整批拒绝：不落库任何变更；拒绝项带 guard 标注返回，供前端逐条展示
    // Task #316：剥离项也并入 rejected（可见，不静默丢弃）
    const rejectedResult: ApplyResult = {
      trip: workingTrip,
      applied: [],
      rejected: [],
      needsProposal: [],
      consistencyErrors: [],
    };
    mergeGuardRejections(rejectedResult, guardResult.rejected);
    for (const item of strippedRejections) {
      rejectedResult.rejected.push({ op: item.op, reason: `[${item.guard}] ${item.reason}` });
    }
    // Task #325：容量剥离项也并入 rejected（reason 已含 [容量] 前缀，直接推入）
    for (const item of capacityRejections) {
      rejectedResult.rejected.push({ op: item.op, reason: item.reason });
    }
    return {
      type: "rejected",
      // Task #379：整批拒绝用户文案单点常量（原因一句 + 动作建议一句，不提阈值）；
      // 与 shared describeRejection threshold 分支共用，避免两消费面文案漂移
      message: BATCH_REJECTION_GUIDANCE,
      result: rejectedResult,
      sessionId,
    };
  }
  for (const warning of guardResult.warnings ?? []) {
    console.warn(`[AI] ${warning}`);
  }
  for (const rejection of guardResult.rejected) {
    console.warn(`[AI] 护栏丢弃 ${rejection.guard}：${rejection.reason}`);
  }

  // 7. 全量重排分流（批级判定，Task #40）：批内任一条 plan 归一化 scopeRef=allDays，
  //    或批内 plan 的 assignments 合计覆盖多个 dayIndex（单条跨天 / 多条单日合计的
  //    等价全量形状）→ 非敏感操作整批挂起，不落盘任何变更；确认后经
  //    /intent/confirm 二次下发（重过四条护栏）；取消不调用确认端点，零变更。
  //    敏感操作（remove / setPurchase / lock）照旧走 needsProposal → ProposalCard。
  if (isFullPlanBatch(guardResult.passed)) {
    const sensitiveOps = guardResult.passed.filter(isSensitiveOp);
    const confirmOps = guardResult.passed.filter((op) => !isSensitiveOp(op));
    const held: ApplyResult = {
      trip: workingTrip,
      applied: [],
      rejected: [],
      needsProposal: sensitiveOps,
      consistencyErrors: [],
    };
    mergeGuardRejections(held, guardResult.rejected);
    // Task #316：前置剥离项也并入 rejected（可见，不静默丢弃）
    for (const item of strippedRejections) {
      held.rejected.push({ op: item.op, reason: `[${item.guard}] ${item.reason}` });
    }
    // Task #325：容量剥离项也并入 rejected（reason 已含 [容量] 前缀）
    for (const item of capacityRejections) {
      held.rejected.push({ op: item.op, reason: item.reason });
    }
    const coverage = describePlanCoverage(confirmOps);
    const scopeLabel = coverage.scopes.includes("allDays")
      ? `"allDays"×${coverage.scopes.length}`
      : JSON.stringify(coverage.scopes);
    console.log(
      `[AI] 全量重排挂起待确认：${confirmOps.length} 条非敏感操作（scope=${scopeLabel}，assign 覆盖 Day${coverage.days.join("、Day") || "-"}），未落盘`,
    );
    // 挂起阶段不落盘（含 proposedNew 命中项）：用户取消即零变更；
    // 确认通道重载行程后若 plan.assign 引用未经确认入池的新点位，护栏会拒绝
    // 并给出可见原因（不静默、不越权写入）。
    return {
      type: "proposal",
      result: held,
      proposalOps: sensitiveOps.length > 0 ? sensitiveOps : undefined,
      fullPlanOps: confirmOps,
      sessionId,
    };
  }

  // 8. 应用通过护栏的操作（执行器内部完成确认分流与局部重算）
  const result = applyOps(workingTrip, guardResult.passed);

  // 8.0 一致性校验失败（shared 已整批回滚，result.trip 与 workingTrip 逐字段一致）：
  // 不落盘任何变更，并把失败原因显式上抛（绝不静默保存不一致状态）
  if (result.consistencyErrors.length > 0) {
    console.error(`[AI] 应用后一致性校验失败，已整批回滚：${result.consistencyErrors.join("；")}`);
    return {
      type: "error",
      message: "操作应用后一致性校验失败，已整批回滚，行程未修改",
      result,
      sessionId,
    };
  }

  // 8.1 护栏拒绝项并入 result.rejected：guard 与 reason 原样保留，前端逐条展示未执行原因
  mergeGuardRejections(result, guardResult.rejected);
  // Task #316：前置剥离项也并入 rejected（可见，不静默丢弃）
  for (const item of strippedRejections) {
    result.rejected.push({ op: item.op, reason: `[${item.guard}] ${item.reason}` });
  }
  // Task #325：容量剥离项也并入 rejected（reason 已含 [容量] 前缀）
  for (const item of capacityRejections) {
    result.rejected.push({ op: item.op, reason: item.reason });
  }

  // 9. 持久化：有直接应用的操作或新增候选池项时才写盘
  const changed = result.applied.length > 0 || newPoolItems.length > 0;
  if (changed) {
    await tripStore.save(result.trip);
  }

  // 10. 确认分流：needsProposal 非空 → 提案，由前端确认后走 /intent/confirm 二次下发
  if (result.needsProposal.length > 0) {
    return { type: "proposal", result, proposalOps: result.needsProposal, sessionId };
  }
  // 11. proposedNew-only 反馈（Task #75）：AI 推荐点位已入候选池时显式带回名称与
  // message，前端据此持久提示并自动打开候选池，不再只弹 3.2s 闪现通知。
  if (newPoolItems.length > 0) {
    const poolNames = newPoolItems.map((item) => item.name);
    return {
      type: "applied",
      result,
      sessionId,
      newPoolItems: poolNames,
      message:
        result.applied.length > 0
          ? `已应用 ${result.applied.length} 项操作；AI 推荐了 ${poolNames.length} 个新点位，已加入候选池`
          : `AI 推荐了 ${poolNames.length} 个新点位，已加入候选池`,
    };
  }
  return { type: "applied", result, sessionId };
}

/**
 * 新建 Session 的标题（Task #70）：便于百炼控制台按行程识别会话来源，
 * 形如「三亚5天行程·a1b2c3d4」（总天数 = nights + 1，tripId 取前 8 位）。
 */
function buildSessionTitle(trip: Trip, tripId: string): string {
  return `${trip.destination.city}${trip.dateRange.nights + 1}天行程·${tripId.slice(0, 8)}`;
}

export async function executeIntent(
  tripId: string,
  intentText: string,
  sessionId?: string,
): Promise<IntentResult> {
  const trip = await tripStore.load(tripId);
  if (trip === null) {
    return { type: "error", message: "行程不存在", sessionId: sessionId ?? "" };
  }

  // 0. 多轮会话判定（Task #70）：入参 sessionId 且状态 idle → 复用（只发增量意图
  // 原文，对话上下文由百炼 Session 续接）；否则新建（完整 prompt + title）。
  // 状态查询失败（unknown / running / terminated）一律降级新建，不阻塞业务。
  let reuseSessionId: string | undefined;
  if (sessionId !== undefined && sessionId !== "") {
    const status = await getSessionStatus(sessionId);
    if (status.status === "idle") {
      reuseSessionId = sessionId;
      console.log(`[AI] 复用百炼 Session ${sessionId}，本轮只发送增量意图`);
    } else {
      console.log(`[AI] Session ${sessionId} 状态为 ${status.status}，不复用，改为新建`);
    }
  }

  // 1-3. 组装上下文并调百炼：按原始意图分级超时（全量重排 90s / 其余 60s）
  const timeoutMs = isFullReplanIntent(intentText)
    ? COMPLEX_INTENT_TIMEOUT_MS
    : DEFAULT_INTENT_TIMEOUT_MS;
  if (timeoutMs === COMPLEX_INTENT_TIMEOUT_MS) {
    console.log(`[AI] 识别为全量重排意图，超时预算放宽为 ${COMPLEX_INTENT_TIMEOUT_MS / 1000} 秒`);
  }
  const prompt = reuseSessionId !== undefined ? intentText : buildIntentPrompt(trip, intentText);
  let outcome: CallAndParseOutcome;
  try {
    outcome = await callAndParse(prompt, timeoutMs, {
      sessionId: reuseSessionId,
      title: buildSessionTitle(trip, tripId),
    });
  } catch (error) {
    if (error instanceof BailianTimeoutError) {
      console.error(`[AI] 意图编排处理超时：${error.message}`);
      return {
        type: "error",
        message: `处理超时：AI 规划超过 ${Math.round(error.timeoutMs / 1000)} 秒仍未完成，请重试或缩小调整范围`,
        // 复用路径超时保留原 sessionId：下一轮状态非 idle 时自动降级新建；
        // 新建路径超时拿不到已创建的 sessionId，返回空串视为新建
        sessionId: reuseSessionId ?? "",
      };
    }
    throw error;
  }
  if (outcome.operationSet === null) {
    return { type: "error", message: PARSE_FAILED_MESSAGE, sessionId: outcome.sessionId };
  }

  // 4. 反问用户：直接返回 clarify，不执行任何操作（会话上下文保留本轮追问）
  if (outcome.operationSet.clarify !== null) {
    return {
      type: "clarify",
      clarify: outcome.operationSet.clarify,
      sessionId: outcome.sessionId,
    };
  }

  // Task #75：复用会话时模型输出的 baseVersion 必然落后上一轮 save 递增后的版本，
  // 传 isReusedSession 让 applyOperationSet 先对齐乐观锁基线（护栏照常生效）
  return applyOperationSet(trip, outcome.operationSet, outcome.sessionId, reuseSessionId !== undefined);
}
