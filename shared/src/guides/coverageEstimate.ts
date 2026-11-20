/**
 * Task #282：稀疏攻略覆盖估算纯函数（C1/C2/C3 参赛必须）。
 *
 * 估算口径（保守，只在「素材确实撑不起半数天」时才打扰用户）：
 * 1. 已排天数＝素材地点（places）对齐到行程实体（entityRef）后，经 visitDayIndex
 *    能落到具体天的不同 dayIndex 集合；
 * 2. 未排素材单元＝素材能支撑但还没排期的点位数量，取两路去重后的并集：
 *    a) 对齐到「尚未排期」实体的地点（visit.dayRef 为空 / pending stop 无归属）；
 *    b) 未对齐任何实体的地点（entityRef=null，装配已建实体但未写归属）——按展示名去重；
 *       名字命中行程既有「已排点位」时计入该天（素材讲的就是那个点位，不重复计新点位）；
 * 3. 可支撑天数＝已排天数 ＋ ⌊未排素材单元 ÷ 2⌋（一天约排 2 个点位，向下取整＝保守），
 *    上限为行程总天数；
 * 4. 缺口成立＝可支撑天数 < 总天数 × 0.5，且总天数 ≥ 2（单天行程无澄清意义）；
 * 5. C2 抑制＝缺口成立但「其余天」都已有安排：抵达/返程锚点天视为已安排，
 *    素材已排到的天视为已安排，剩余天要求非空且全部 Visit 均 locked 或 bought，
 *    全部满足即抑制澄清（不打扰用户）。
 * 6. enrichment 锚定（enrichmentAnchored）＝素材锚定到既有已排期行程（已排天数 ≥ 1）：
 *    说明行程本就有计划、用户在往已排的天里补内容（大景区整体提及 / 已排点位的亮点补充），
 *    而非「拿一篇薄攻略从零排满整程」。C1 稀疏澄清只针对后者（素材全是未落位的新点位、
 *    锚定不到任何既有已排天）；已锚定时即便覆盖不足半数也不打扰用户（消费方据此跳过 C1）。
 *    该信号为纯只读派生，不改变 hasGap / suppressed / 覆盖天数等既有口径。
 *
 * 纯函数、只读、无副作用：不写 Trip，不依赖 fs / crypto，可被 web 与 server 以同一份源码消费。
 */

import type { Trip } from "../types/index.js";
import { visitDayIndex } from "../operations/index.js";

/** 覆盖估算所需的最小地点引用形状（server MergedPlace 满足此接口） */
export interface CoveragePlaceRef {
  entityRef: { kind: "visit" | "stop"; id: string } | null;
  /** 展示名（对齐实体名 > extractedName）；缺省时按引用计入，不参与名称去重 */
  displayName?: string;
}

export interface CoverageGapResult {
  /** 缺口是否成立（素材可支撑天数 < 行程天数 × 0.5） */
  hasGap: boolean;
  /** C2 抑制：其余天已被锁定/已购内容（或航班锚点）填满，无需澄清 */
  suppressed: boolean;
  /**
   * 素材是否「锚定到既有已排期行程」（scheduledDayCount ≥ 1）。
   * 为真表示本轮素材对齐/同名命中了行程里已经排好的某一天（大景区整体提及、
   * 或对已排点位的亮点补充），属于对既有行程的补充/丰富（enrichment），
   * 而非「拿一篇薄攻略从零排满整程」。
   *
   * C1 稀疏澄清的语义只针对后者：素材全是尚未落位的新点位、锚定不到任何既有
   * 已排天（scheduledDayCount === 0）时，才说明「素材撑不起行程、需要问用户剩余
   * 天怎么办」。当素材已锚定既有排期（enrichmentAnchored=true），说明行程本就有
   * 计划、用户在往里补内容，此时即便素材覆盖天数不足半数也不应打扰用户——
   * 消费方（planner 澄清门）据此跳过 C1。
   *
   * 该字段是纯只读派生信号，不改变 hasGap / suppressed / coveredDayCount /
   * scheduledDayCount / unscheduledUnitCount 的既有口径（覆盖估算与 C2 抑制语义不变）。
   */
  enrichmentAnchored: boolean;
  /** 素材可支撑的天数（已排天数 ＋ 未排素材单元折半天，上限＝总天数） */
  coveredDayCount: number;
  /** 行程总天数 */
  totalDayCount: number;
  /** 已排天数（素材实体已落在具体天） */
  scheduledDayCount: number;
  /** 未排素材单元数（素材能支撑但尚未排期的点位） */
  unscheduledUnitCount: number;
}

/** 该天是否被航班锚点占用（抵达/返程日无「排满」诉求，视为已安排） */
function isAnchorDay(trip: Trip, dayIndex: number): boolean {
  return (trip.constraints ?? []).some(
    (constraint) =>
      constraint.dayIndex === dayIndex &&
      (constraint.type === "flight_arrive" || constraint.type === "flight_depart"),
  );
}

/** 该天是否已被锁定/已购内容填满（空天不算填满） */
function isDayFilledByLocked(trip: Trip, dayIndex: number): boolean {
  const dayId = trip.dayRefs[dayIndex - 1];
  if (dayId == null) return false;
  const day = trip.days[dayId];
  if (day == null) return false;
  const visitRefs = day.scheduleVisitRefs ?? [];
  if (visitRefs.length === 0) return false;
  return visitRefs.every((visitId) => {
    const visit = trip.visits?.[visitId];
    if (visit == null) return true;
    return visit.locked === true || visit.purchaseState === "bought";
  });
}

/** 名称归一（去空白 + 小写）：仅用于未对齐地点与既有实体的同名去重 */
function unitNameKey(rawName: string): string {
  return rawName.replace(/\s+/g, "").toLowerCase();
}

/** 实体展示名（Visit 取主数据点名；Stop 取匹配点名或自定义名） */
function entityDisplayName(trip: Trip, kind: "visit" | "stop", id: string): string {
  if (kind === "visit") {
    const visit = trip.visits?.[id];
    return trip.itemRegistry?.[visit?.pointRef ?? ""]?.name ?? id;
  }
  const stop = trip.stops?.[id];
  if (stop == null) return id;
  const matched = stop.matchedPointRef != null ? trip.itemRegistry?.[stop.matchedPointRef]?.name : undefined;
  return matched ?? stop.customName ?? id;
}

/**
 * 行程既有「已排期点位」的名称 → 天号索引：素材里未对齐实体但同名的地点，
 * 说明它讲的就是行程里已排好的那个点位（merge 名称索引会把两者合成一条），
 * 因此可以直接计入该天覆盖，不再当成新增点位。
 */
function buildScheduledNameDayIndex(trip: Trip): Map<string, number> {
  const index = new Map<string, number>();
  const register = (kind: "visit" | "stop", id: string, dayIndex: number | null): void => {
    if (dayIndex === null) return;
    const key = unitNameKey(entityDisplayName(trip, kind, id));
    if (key !== "" && !index.has(key)) index.set(key, dayIndex);
  };
  for (const visit of Object.values(trip.visits ?? {})) {
    if (visit == null) continue;
    register("visit", visit.visitId, visitDayIndex(trip, visit.visitId));
    for (const stopId of [...(visit.childStopRefs ?? []), ...(visit.alternateStopRefs ?? [])]) {
      register("stop", stopId, visitDayIndex(trip, visit.visitId));
    }
  }
  return index;
}

/**
 * 估算素材对行程的覆盖缺口。
 *
 * @param trip   当前行程
 * @param places 素材合并后的地点列表（entityRef + displayName；server MergedPlace[] 满足）
 */
export function estimateGuideCoverage(
  trip: Trip,
  places: CoveragePlaceRef[],
): CoverageGapResult {
  const totalDayCount = trip.dayRefs.length;

  // 单天行程无澄清意义
  if (totalDayCount < 2) {
    return {
      hasGap: false,
      suppressed: false,
      enrichmentAnchored: false,
      coveredDayCount: totalDayCount,
      totalDayCount,
      scheduledDayCount: 0,
      unscheduledUnitCount: 0,
    };
  }

  // 1＋2a. 已对齐地点分流：已排期 → 天集合；未排期 → 实体单元
  const scheduledDays = new Set<number>();
  const unitKeys = new Set<string>();
  /** 已计入单元的实体名称（供 2b 同名去重，避免既有行程点位被重复计） */
  const unitNames = new Set<string>();
  /** 未对齐地点（按展示名去重，2b 再判定归属） */
  const unattachedNames = new Set<string>();
  let unattachedAnonymous = 0;

  const addEntityUnit = (kind: "visit" | "stop", id: string): void => {
    unitKeys.add(`${kind}:${id}`);
    const name = entityDisplayName(trip, kind, id);
    const key = unitNameKey(name);
    if (key !== "") unitNames.add(key);
  };

  for (const place of places) {
    const ref = place.entityRef;
    if (ref == null) {
      const name = typeof place.displayName === "string" ? unitNameKey(place.displayName) : "";
      if (name === "") unattachedAnonymous += 1;
      else unattachedNames.add(name);
      continue;
    }
    if (ref.kind === "visit") {
      const dayIndex = visitDayIndex(trip, ref.id);
      if (dayIndex !== null) scheduledDays.add(dayIndex);
      else if (trip.visits?.[ref.id] != null) addEntityUnit("visit", ref.id);
      continue;
    }
    const stop = trip.stops?.[ref.id];
    if (stop == null) continue;
    if (stop.visitRef != null) {
      const dayIndex = visitDayIndex(trip, stop.visitRef);
      if (dayIndex !== null) scheduledDays.add(dayIndex);
      else if (trip.visits?.[stop.visitRef] != null) addEntityUnit("visit", stop.visitRef);
      continue;
    }
    // pending stop：建议归属的父实体已排期 → 计入该天；父实体已计入单元 → 不重复计
    if (stop.suggestedVisitRef != null) {
      const parentDayIndex = visitDayIndex(trip, stop.suggestedVisitRef);
      if (parentDayIndex !== null) {
        scheduledDays.add(parentDayIndex);
        continue;
      }
      if (unitKeys.has(`visit:${stop.suggestedVisitRef}`)) continue;
    }
    addEntityUnit("stop", stop.stopId);
  }

  // 2b. 未对齐地点归属判定：名字命中「行程既有已排点位」→ 计入该天（merge 同名合并，
  //     素材其实就在说那个已排点位）；命中未排单元名 → 同一点位不重复计；否则＝新点位单元
  const scheduledNameDays = buildScheduledNameDayIndex(trip);
  for (const name of unattachedNames) {
    const scheduledDay = scheduledNameDays.get(name);
    if (scheduledDay !== undefined) {
      scheduledDays.add(scheduledDay);
      continue;
    }
    if (!unitNames.has(name)) unitKeys.add(`n:${name}`);
  }
  for (let index = 0; index < unattachedAnonymous; index += 1) unitKeys.add(`u:${index}`);

  // 3. 可支撑天数（一天约 2 个点位，向下取整＝保守；上限＝行程天数）
  const scheduledDayCount = scheduledDays.size;
  const unscheduledUnitCount = unitKeys.size;
  const supportable = Math.min(
    totalDayCount,
    scheduledDayCount + Math.floor(unscheduledUnitCount / 2),
  );

  // 4. 缺口判定
  const hasGap = supportable < totalDayCount * 0.5;
  if (!hasGap) {
    return {
      hasGap: false,
      suppressed: false,
      enrichmentAnchored: scheduledDayCount >= 1,
      coveredDayCount: supportable,
      totalDayCount,
      scheduledDayCount,
      unscheduledUnitCount,
    };
  }

  // 5. C2 抑制：未覆盖天（非锚点、素材未排到的天）全部被锁定/已购填满 → 不打扰用户
  const uncovered: number[] = [];
  for (let dayIndex = 1; dayIndex <= totalDayCount; dayIndex++) {
    if (scheduledDays.has(dayIndex)) continue;
    if (isAnchorDay(trip, dayIndex)) continue;
    uncovered.push(dayIndex);
  }
  const suppressed = uncovered.every((dayIndex) => isDayFilledByLocked(trip, dayIndex));

  return {
    hasGap: true,
    suppressed,
    enrichmentAnchored: scheduledDayCount >= 1,
    coveredDayCount: supportable,
    totalDayCount,
    scheduledDayCount,
    unscheduledUnitCount,
  };
}
