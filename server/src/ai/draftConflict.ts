/**
 * Task #307：草案版本护栏的「冲突域」判定。
 *
 * 背景缺陷：草案生成期间，后台图片结算写（commitImageEvidence / commitSkippedEvidence /
 * finalizeSource 的 save）只写 guide 证据 / sourceVersion / imageProgress，不写排程，
 * 但每次 tripStore.save 都会 bump trip.version。旧护栏（planner.ts 保存草案前）用
 * 「latest.version !== inputTripVersion」做全 trip 乐观锁校验——任何 save（含上述非冲突写）
 * 都作废草案，粒度过粗。
 *
 * 正确性依据：草案的正确性只依赖其冻结输入——选中攻略来源的证据 + 补充句 + prep 时的
 * 排程现状。因此仅当「排程 / 约束 / 选中来源 / 补充句」发生变化时才应作废；纯证据追加 /
 * 图片进度类写入应容忍（rebase 到最新版本后提交）。
 *
 * 本模块提供：
 * - computeScheduleFingerprint：对排程相关状态做确定性稳定哈希（键排序）；
 * - collectSelectedSourceIds / collectConsumedEvidenceRefs：从合并结果与 trip 收集冻结输入；
 * - evaluateDraftRebase：在 latest.version 变化时判定「可否以 latest 为基线 rebase 提交」，
 *   任一条件不满足或指纹重算 / 引用检查抛异常时回退严格作废（fail-safe，不静默放行）。
 */

import { createHash } from "node:crypto";
import type { Trip } from "@goplay/shared";

/**
 * 确定性序列化：递归排序对象键，数组保持原序（数组顺序本身即语义，如 dayRefs /
 * scheduleVisitRefs 的排程顺序）。用于保证指纹哈希与键插入顺序无关。
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

/**
 * 排程指纹：对「草案正确性所依赖的排程相关状态」做稳定哈希。
 *
 * 纳入（任一变化即视为真冲突、草案作废）：
 * - 补充句（trip.guideDraftNote）：草案冻结输入的一部分（解析为日期指令并注入 prompt）；
 * - 各 day（按 dayRefs 顺序）：dayIndex / date / departTime(+override) / scheduleVisitRefs
 *   顺序 / lodging / displayOrder；
 * - 每个 Visit：归属、类型、顺序、时间窗口与起止（含 override 标志）、时长（reserved /
 *   effective）、外部交通段、内部与备选玩法引用、锁定 / 已购 / 用户调整标志；
 * - 每个 Stop（按 stopId 排序）：状态、归属、顺序、建议时长、票务关系、用户调整标志；
 * - trip 约束集合（按 constraintId 排序）；
 * - globalCandidateRefs / pendingStopRefs（候选池与待定区形态）；
 * - lodgings（按 dayIndex 排序）：酒店引用、锁定 / 已购、入离时间；
 * - selectedSourceIds（排序后并入）。
 *
 * 刻意排除（这些字段的写入不构成排程冲突，应被容忍）：
 * - guideSources / evidences / imageProgress / sourceVersion / coverageText（图片结算写）；
 * - Visit / Stop 上的 guideSnippets / optionGroups / sourceMentionRefs / sourceEvidenceRefs
 *   （攻略内容挂载，非排程结构）；
 * - version / updatedAt / schemaVersion / 派生字段（role / timeSourceLabel）/ 展示元数据
 *   （tripName / memo / coverImage）/ pendingGuideDraft / clarification*。
 */
export function computeScheduleFingerprint(trip: Trip, selectedSourceIds: readonly string[]): string {
  const visits = trip.visits ?? {};
  const stops = trip.stops ?? {};
  const lodgings = trip.lodgings ?? {};

  const dayPayload = (trip.dayRefs ?? []).map((dayId) => {
    const day = trip.days?.[dayId];
    if (day === undefined) return { dayId, missing: true };
    return {
      dayId,
      dayIndex: day.dayIndex,
      date: day.date,
      departTime: day.departTime ?? null,
      departTimeOverridden: day.departTimeOverridden === true,
      scheduleVisitRefs: day.scheduleVisitRefs ?? [],
      lodging: day.lodging ?? null,
      displayOrder: day.displayOrder ?? null,
    };
  });

  const visitIds = Object.keys(visits).sort();
  const visitPayload = visitIds.map((visitId) => {
    const visit = visits[visitId];
    return {
      visitId,
      dayRef: visit.dayRef ?? null,
      pointRef: visit.pointRef ?? null,
      kind: visit.kind,
      visitMode: visit.visitMode,
      order: visit.order ?? null,
      windowStart: visit.windowStart ?? null,
      windowEnd: visit.windowEnd ?? null,
      startTime: visit.startTime ?? null,
      endTime: visit.endTime ?? null,
      startTimeOverridden: visit.startTimeOverridden === true,
      endTimeOverridden: visit.endTimeOverridden === true,
      reservedMinutes: visit.reservedMinutes ?? null,
      effectiveMinutes: visit.effectiveMinutes ?? null,
      externalLeg: visit.externalLeg ?? null,
      childStopRefs: visit.childStopRefs ?? [],
      alternateStopRefs: visit.alternateStopRefs ?? [],
      purchaseState: visit.purchaseState,
      locked: visit.locked === true,
      userAdjusted: visit.userAdjusted === true,
    };
  });

  const stopIds = Object.keys(stops).sort();
  const stopPayload = stopIds.map((stopId) => {
    const stop = stops[stopId];
    return {
      stopId,
      state: stop.state,
      visitRef: stop.visitRef ?? null,
      suggestedVisitRef: stop.suggestedVisitRef ?? null,
      matchedPointRef: stop.matchedPointRef ?? null,
      customName: stop.customName ?? null,
      order: stop.order ?? null,
      suggestMinutes: stop.suggestMinutes ?? null,
      ticketRelation: stop.ticketRelation,
      userAdjusted: stop.userAdjusted === true,
    };
  });

  const constraintPayload = (trip.constraints ?? [])
    .map((constraint) => ({
      constraintId: constraint.constraintId,
      type: constraint.type,
      anchorTime: constraint.anchorTime,
      dayIndex: constraint.dayIndex,
      label: constraint.label,
      locked: constraint.locked === true,
    }))
    .sort((a, b) => (a.constraintId < b.constraintId ? -1 : a.constraintId > b.constraintId ? 1 : 0));

  const lodgingPayload = Object.keys(lodgings)
    .sort()
    .map((key) => {
      const lodging = lodgings[key];
      return {
        key,
        dayIndex: lodging.dayIndex,
        hotelRefs: lodging.hotelRefs ?? [],
        purchaseState: lodging.purchaseState,
        locked: lodging.locked === true,
        userAdjusted: lodging.userAdjusted === true,
        checkInTime: lodging.checkInTime ?? null,
        checkOutTime: lodging.checkOutTime ?? null,
      };
    });

  const payload = {
    note: typeof trip.guideDraftNote === "string" ? trip.guideDraftNote : null,
    days: dayPayload,
    visits: visitPayload,
    stops: stopPayload,
    constraints: constraintPayload,
    lodgings: lodgingPayload,
    globalCandidateRefs: trip.globalCandidateRefs ?? [],
    pendingStopRefs: trip.pendingStopRefs ?? [],
    selectedSourceIds: [...selectedSourceIds].sort(),
  };

  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

/** 从合并结果提取本轮实际参与（选中）的来源 id（去重、排序，覆盖 all / selected 两种模式）。 */
export function collectSelectedSourceIds(sourceSnapshots: readonly { sourceId: string }[]): string[] {
  return [...new Set(sourceSnapshots.map((snapshot) => snapshot.sourceId))].sort();
}

/**
 * 收集 prep 时选中来源名下的全部证据 ID（去重、排序）——草案冻结消费的证据集合。
 * 应用校验时据此判断「已消费证据是否仍存在于 latest 对应来源」。
 */
export function collectConsumedEvidenceRefs(trip: Trip, selectedSourceIds: readonly string[]): string[] {
  const sources = trip.guideSources ?? {};
  const evidenceIds = new Set<string>();
  for (const sourceId of selectedSourceIds) {
    const source = sources[sourceId];
    if (source !== undefined && Array.isArray(source.evidenceRefs)) {
      for (const evidenceId of source.evidenceRefs) evidenceIds.add(evidenceId);
    }
  }
  return [...evidenceIds].sort();
}

export interface DraftRebaseInput {
  /** 保存草案前重新加载的最新行程 */
  latest: Trip;
  /** prep 时计算的排程指纹 */
  preparedFingerprint: string;
  /** prep 时选中（参与合并）的来源 id */
  selectedSourceIds: readonly string[];
  /** prep 时选中来源名下消费的全部证据 id */
  consumedEvidenceRefs: readonly string[];
}

export type DraftRebaseDecision =
  | { kind: "rebase" }
  | { kind: "stale"; reason: string };

/**
 * 冲突域判定：latest.version 与 prep 版本不一致时，判断能否以 latest 为基线 rebase 提交。
 *
 * 三个条件全部满足才 rebase：
 * (a) latest 重算的排程指纹与 prep 时相等（排程 / 约束 / 补充句 / 选中来源未变）；
 * (b) selectedSourceIds 全部仍存在于 latest.guideSources 且仍处于 active（未被软移除）；
 * (c) consumedEvidenceRefs 全部仍存在于 latest 对应来源的 evidenceRefs 中。
 *
 * fail-safe：指纹重算或引用检查抛任何异常 → 回退严格作废（返回 stale），不得静默放行。
 */
export function evaluateDraftRebase(input: DraftRebaseInput): DraftRebaseDecision {
  try {
    // (a) 排程指纹
    const latestFingerprint = computeScheduleFingerprint(input.latest, input.selectedSourceIds);
    if (latestFingerprint !== input.preparedFingerprint) {
      return { kind: "stale", reason: "排程 / 约束 / 补充句 / 选中来源发生变化" };
    }
    // (b) 选中来源仍存在且未被软移除
    const sources = input.latest.guideSources ?? {};
    for (const sourceId of input.selectedSourceIds) {
      const source = sources[sourceId];
      if (source === undefined) {
        return { kind: "stale", reason: `选中来源 ${sourceId} 已不存在` };
      }
      if (source.active === false) {
        return { kind: "stale", reason: `选中来源 ${sourceId} 已被移除` };
      }
    }
    // (c) 已消费证据仍存在于对应来源
    const latestEvidenceIds = new Set<string>();
    for (const sourceId of input.selectedSourceIds) {
      const source = sources[sourceId];
      if (source !== undefined && Array.isArray(source.evidenceRefs)) {
        for (const evidenceId of source.evidenceRefs) latestEvidenceIds.add(evidenceId);
      }
    }
    for (const evidenceId of input.consumedEvidenceRefs) {
      if (!latestEvidenceIds.has(evidenceId)) {
        return { kind: "stale", reason: `已消费证据 ${evidenceId} 不再存在于对应来源` };
      }
    }
    return { kind: "rebase" };
  } catch (error) {
    // fail-safe：任何异常都回退严格作废，绝不静默放行
    return {
      kind: "stale",
      reason: `冲突域校验异常（回退严格作废）：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
