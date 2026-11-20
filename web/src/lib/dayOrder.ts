/**
 * 天内容「景点 + 酒店」混合排序 —— 展示顺序派生与维护。
 *
 * 事实源边界（重要，避免把展示顺序误当成存储契约）：
 * - Day.scheduleVisitRefs 仍是城市级景点的权威顺序：Visit.order、时间轴、
 *   下一天的交通链都以它的下标为准；
 * - LodgingPlan.hotelRefs 仍是当日住宿候选的权威顺序：首位 = 当前选定酒店；
 * - Day.displayOrder 只决定「同一天列表里景点与酒店如何交错」，不新增实体、
 *   不动 registry；缺失时按「景点在前、酒店在后」的老渲染顺序派生。
 *
 * 因此本模块的顺序维护统一走「槽位重放」：displayOrder 里的景点槽按
 * scheduleVisitRefs 顺序重填、酒店槽按 hotelRefs 顺序重填，悬空槽丢弃、
 * 富余条目补到列表末尾（景点补在上一个景点槽之后）。这样无论变更来自
 * 手工拖拽 / ↑↓、候选池添加、移除撤销还是服务端 AI 结果，都不会出现
 * 「显示顺序与时间轴顺序不一致」的脏状态。
 */

import type {
  Day,
  DayDisplayItemRef,
  HotelCandidate,
  LodgingPlan,
  Trip,
  Visit,
} from "@goplay/shared";
import { recomputeDayTimeline } from "@goplay/shared";
import { stopDisplayName, visitDisplayName } from "./trip";

/** 混合列表中的一条景点（ref = visitId） */
export interface DayVisitItem {
  kind: "visit";
  ref: string;
  visit: Visit;
}

/** 混合列表中的一条酒店候选（ref = hotelRegistry 的 hotelId） */
export interface DayHotelItem {
  kind: "hotel";
  ref: string;
  hotel: HotelCandidate;
}

export type DayDisplayItem = DayVisitItem | DayHotelItem;

/** 酒店卡在 DndContext 中的 sortable id（加前缀避免与 visitId 空间混淆） */
export function hotelSortableId(hotelRef: string): string {
  return `hotel:${hotelRef}`;
}

/** 某天的住宿计划（key = String(dayIndex)）；无计划返回 null */
function planOf(trip: Trip, day: Day): LodgingPlan | null {
  return trip.lodgings[String(day.dayIndex)] ?? null;
}

/** 当日有效的景点 id（按 scheduleVisitRefs 顺序，悬空引用剔除） */
function validVisitIds(trip: Trip, day: Day): string[] {
  return day.scheduleVisitRefs.filter((visitId) => trip.visits[visitId] !== undefined);
}

/** 当日有效的酒店候选 id（按 hotelRefs 顺序，悬空引用剔除） */
function validHotelIds(trip: Trip, day: Day): string[] {
  const plan = planOf(trip, day);
  if (plan === null || !Array.isArray(plan.hotelRefs)) return [];
  return plan.hotelRefs.filter((hotelId) => trip.hotelRegistry[hotelId] !== undefined);
}

/**
 * 当天混合展示列表（渲染唯一入口）：
 * 1. displayOrder 存在时按其顺序取条目；
 * 2. 未列入的有效条目按存储顺序补全（景点后于最后一个景点槽、酒店追加末尾）；
 * 3. displayOrder 缺失 = 老数据，按「景点在前、酒店在后」派生。
 */
export function dayDisplayItems(trip: Trip, day: Day): DayDisplayItem[] {
  const visitIds = validVisitIds(trip, day);
  const hotelIds = validHotelIds(trip, day);
  const seenVisits = new Set<string>();
  const seenHotels = new Set<string>();
  const items: DayDisplayItem[] = [];

  const pushVisit = (visitId: string) => {
    if (seenVisits.has(visitId)) return;
    const visit = trip.visits[visitId];
    if (visit === undefined) return;
    seenVisits.add(visitId);
    items.push({ kind: "visit", ref: visitId, visit });
  };
  const pushHotel = (hotelId: string) => {
    if (seenHotels.has(hotelId)) return;
    const hotel = trip.hotelRegistry[hotelId];
    if (hotel === undefined) return;
    seenHotels.add(hotelId);
    items.push({ kind: "hotel", ref: hotelId, hotel });
  };

  if (Array.isArray(day.displayOrder)) {
    for (const entry of day.displayOrder) {
      if (typeof entry !== "object" || entry === null) continue;
      if (entry.kind === "visit" && typeof entry.visitRef === "string") {
        pushVisit(entry.visitRef);
      } else if (entry.kind === "hotel" && typeof entry.hotelRef === "string") {
        pushHotel(entry.hotelRef);
      }
    }
  }
  for (const visitId of visitIds) pushVisit(visitId);
  for (const hotelId of hotelIds) pushHotel(hotelId);
  return items;
}

/**
 * 路线顺序总览节点（Task #108）：页面下方真实存在的条目按展示顺序展开。
 *
 * - hotel：当天住宿候选（每个候选各一节点，顺序取其混排位置）；
 * - visit：城市级景点（普通景点 / 大景区父卡各一节点）；
 * - stop：大景区父卡之后紧跟的岛内玩法（只在这里出现一次，卡片内不再重复）；
 * - transit：仅当当天存在航班抵达 / 出发约束时补的机场起点 / 终点。
 *   当天已有「机场 / 车站」类景点条目时不再补，避免臆造与重复。
 */
export type DayRouteNodeKind = "hotel" | "visit" | "stop" | "transit";

export interface DayRouteNode {
  key: string;
  kind: DayRouteNodeKind;
  /** 节点短名（长名由 CSS 省略号截断，title 里给出完整说明） */
  label: string;
  /** 悬浮说明：完整名称 / 所属大景区 / 航班时间 */
  hint: string;
}

/** 当天景点条目里已明确是交通枢纽时的名称特征（不据此臆造节点，只用于去重） */
const TRANSIT_NAME_PATTERN = /机场|车站|火车站|高铁站|客运站/;

/** 约束 anchorTime（ISO8601）→ "HH:MM"；非法 / 缺失返回空串 */
function constraintTime(constraint: Trip["constraints"][number]): string {
  const anchor = constraint.anchorTime;
  return anchor.length >= 16 ? anchor.slice(11, 16) : "";
}

/**
 * 当天路线顺序节点（纯函数，唯一派生入口）：
 * 1. 以 dayDisplayItems（displayOrder 混排）为顺序基础，酒店与景点同列展开；
 * 2. 大景区节点之后插入其 childStopRefs（岛内玩法），父节点本身只出现一次；
 * 3. 航班抵达约束 → 列表最前补「抵达机场」；航班出发约束 → 列表最后补「前往机场」；
 *    当天已有机场 / 车站类景点条目时不重复补节点。
 */
export function dayRouteNodes(trip: Trip, day: Day): DayRouteNode[] {
  const items = dayDisplayItems(trip, day);
  const hasTransitItem = items.some(
    (item) => item.kind === "visit" && TRANSIT_NAME_PATTERN.test(visitDisplayName(trip, item.visit)),
  );
  const constraints = trip.constraints.filter((constraint) => constraint.dayIndex === day.dayIndex);
  const arrives = constraints.find((constraint) => constraint.type === "flight_arrive");
  const departs = constraints.find((constraint) => constraint.type === "flight_depart");

  const nodes: DayRouteNode[] = [];
  if (!hasTransitItem && arrives !== undefined) {
    const time = constraintTime(arrives);
    nodes.push({
      key: "transit:arrive",
      kind: "transit",
      label: "抵达机场",
      hint: time === "" ? "航班抵达机场，作为当天起点" : `航班抵达机场 · ${time}，作为当天起点`,
    });
  }

  for (const item of items) {
    if (item.kind === "hotel") {
      nodes.push({
        key: `hotel:${item.ref}`,
        kind: "hotel",
        label: item.hotel.name,
        hint: `住宿：${item.hotel.name}`,
      });
      continue;
    }
    const name = visitDisplayName(trip, item.visit);
    nodes.push({ key: `visit:${item.ref}`, kind: "visit", label: name, hint: name });
    if (item.visit.kind !== "large_attraction") continue;
    for (const stopId of item.visit.childStopRefs) {
      const stop = trip.stops[stopId];
      if (stop === undefined) continue;
      const stopLabel = stopDisplayName(trip, stop);
      nodes.push({
        key: `stop:${stopId}`,
        kind: "stop",
        label: stopLabel,
        hint: `${name} 岛内玩法：${stopLabel}`,
      });
    }
  }

  if (!hasTransitItem && departs !== undefined) {
    const time = constraintTime(departs);
    nodes.push({
      key: "transit:depart",
      kind: "transit",
      label: "前往机场",
      hint: time === "" ? "航班出发，作为当天终点" : `航班出发 · ${time}，作为当天终点`,
    });
  }
  return nodes;
}

/** 混合条目 → 持久化引用数组 */
function refsOf(items: DayDisplayItem[]): DayDisplayItemRef[] {
  return items.map((item) =>
    item.kind === "visit"
      ? { kind: "visit" as const, visitRef: item.ref }
      : { kind: "hotel" as const, hotelRef: item.ref },
  );
}

/** 两个 displayOrder 是否完全一致（用于避免无意义的对象替换） */
function sameOrder(a: unknown, b: DayDisplayItemRef[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] as DayDisplayItemRef | undefined;
    const right = b[index];
    if (left === undefined || right === undefined || left.kind !== right.kind) return false;
    if (left.kind === "visit" && right.kind === "visit" && left.visitRef !== right.visitRef) return false;
    if (left.kind === "hotel" && right.kind === "hotel" && left.hotelRef !== right.hotelRef) return false;
  }
  return true;
}

/**
 * 槽位重放：把既有 displayOrder 与权威数组合并成新的展示顺序。
 * - 景点槽按 visitIds（scheduleVisitRefs）顺序重填；
 * - 酒店槽按 hotelIds（hotelRefs）顺序重填；
 * - 悬空 / 重复槽丢弃；
 * - 富余景点插到最后一个景点槽之后；富余酒店插到最后一个酒店槽之后
 *   （对应位置没有同类槽时落在列表末尾），撤销 / 新增后同类条目仍聚在一起。
 */
function mergeDisplayOrder(
  existing: unknown,
  visitIds: string[],
  hotelIds: string[],
): DayDisplayItemRef[] {
  const old = Array.isArray(existing) ? existing : [];
  const result: DayDisplayItemRef[] = [];
  let visitCursor = 0;
  let hotelCursor = 0;

  for (const entry of old) {
    if (typeof entry !== "object" || entry === null) continue;
    if (entry.kind === "visit") {
      const visitId = visitIds[visitCursor];
      if (visitId === undefined) continue; // 多余槽位：数量减少时直接收缩
      visitCursor += 1;
      result.push({ kind: "visit", visitRef: visitId });
    } else if (entry.kind === "hotel") {
      const hotelId = hotelIds[hotelCursor];
      if (hotelId === undefined) continue;
      hotelCursor += 1;
      result.push({ kind: "hotel", hotelRef: hotelId });
    }
  }

  const extraVisits = visitIds.slice(visitCursor);
  if (extraVisits.length > 0) {
    let insertAt = 0;
    for (let index = result.length - 1; index >= 0; index -= 1) {
      if (result[index]?.kind === "visit") {
        insertAt = index + 1;
        break;
      }
    }
    result.splice(
      insertAt,
      0,
      ...extraVisits.map((visitRef): DayDisplayItemRef => ({ kind: "visit", visitRef })),
    );
  }
  const extraHotels = hotelIds.slice(hotelCursor);
  if (extraHotels.length > 0) {
    let insertAt = result.length;
    for (let index = result.length - 1; index >= 0; index -= 1) {
      if (result[index]?.kind === "hotel") {
        insertAt = index + 1;
        break;
      }
    }
    result.splice(
      insertAt,
      0,
      ...extraHotels.map((hotelRef): DayDisplayItemRef => ({ kind: "hotel", hotelRef })),
    );
  }
  return result;
}

/**
 * 全量同步 displayOrder（commit / 载入 / AI 结果落地后调用）：
 * 保证每天的顺序与 scheduleVisitRefs、hotelRefs 一致；空天移除该字段。
 * 无变化时返回原对象引用，避免多余渲染。
 */
export function syncDisplayOrders(trip: Trip): Trip {
  let changed = false;
  const days: Record<string, Day> = {};

  for (const [dayId, day] of Object.entries(trip.days)) {
    const visitIds = validVisitIds(trip, day);
    const hotelIds = validHotelIds(trip, day);

    if (visitIds.length === 0 && hotelIds.length === 0) {
      if (day.displayOrder === undefined) {
        days[dayId] = day;
        continue;
      }
      const { displayOrder: _removed, ...rest } = day;
      days[dayId] = rest as Day;
      changed = true;
      continue;
    }

    const next = mergeDisplayOrder(day.displayOrder, visitIds, hotelIds);
    if (sameOrder(day.displayOrder, next)) {
      days[dayId] = day;
      continue;
    }
    days[dayId] = { ...day, displayOrder: next };
    changed = true;
  }

  return changed ? { ...trip, days } : trip;
}

/**
 * 混合列表改序的纯函数实现（拖拽与 ↑↓ 共用）。
 *
 * 同步写入三处，保证「看到什么顺序 = 时间轴 / 选定酒店按什么顺序算」：
 * - day.displayOrder = 新的混合顺序；
 * - day.scheduleVisitRefs = 新的景点子序列（并重编 Visit.order）；
 * - plan.hotelRefs = 新的酒店子序列（首位仍是当前选定）。
 * 景点顺序变化时重算当天时间轴；酒店不参与时间链（timeline 不消费 lodging）。
 * 索引越界、index 相同或存量引用已不一致时返回 null（不静默修改脏数据）。
 */
export function reorderDayDisplay(
  trip: Trip,
  dayIndex: number,
  fromIndex: number,
  toIndex: number,
): Trip | null {
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex === toIndex) return null;
  const dayId = trip.dayRefs[dayIndex - 1];
  const day = dayId !== undefined ? trip.days[dayId] : undefined;
  if (day === undefined) return null;

  const plan = planOf(trip, day);
  // 引用完整性防御：悬空 / 重复引用先交给一致性校验，不在这里做半修复
  if (new Set(day.scheduleVisitRefs).size !== day.scheduleVisitRefs.length) return null;
  if (day.scheduleVisitRefs.some((visitId) => trip.visits[visitId] === undefined)) return null;
  if (plan !== null) {
    if (!Array.isArray(plan.hotelRefs)) return null;
    if (new Set(plan.hotelRefs).size !== plan.hotelRefs.length) return null;
    if (plan.hotelRefs.some((hotelId) => trip.hotelRegistry[hotelId] === undefined)) return null;
  }

  const items = dayDisplayItems(trip, day);
  if (fromIndex < 0 || fromIndex >= items.length || toIndex < 0 || toIndex >= items.length) return null;

  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  if (moved === undefined) return null;
  next.splice(toIndex, 0, moved);

  const nextVisitRefs = next.filter((item) => item.kind === "visit").map((item) => item.ref);
  const nextHotelRefs = next.filter((item) => item.kind === "hotel").map((item) => item.ref);
  const movedRef = moved.ref;
  const movedIsVisit = moved.kind === "visit";

  const visitOrderChanged = day.scheduleVisitRefs.some((id, index) => id !== nextVisitRefs[index]);
  const hotelOrderChanged = plan !== null && plan.hotelRefs.some((id, index) => id !== nextHotelRefs[index]);

  let visits = trip.visits;
  if (visitOrderChanged || movedIsVisit) {
    const nextVisits = { ...trip.visits };
    nextVisitRefs.forEach((visitId, index) => {
      const visit = nextVisits[visitId];
      if (visit === undefined) return;
      const isMoved = movedIsVisit && visitId === movedRef;
      if (visit.order === index && (!isMoved || visit.userAdjusted)) return;
      nextVisits[visitId] = {
        ...visit,
        order: index,
        userAdjusted: visit.userAdjusted || isMoved,
      };
    });
    visits = nextVisits;
  }

  let lodgings = trip.lodgings;
  if (plan !== null && (hotelOrderChanged || (!movedIsVisit && !plan.userAdjusted))) {
    lodgings = {
      ...trip.lodgings,
      [String(dayIndex)]: { ...plan, hotelRefs: nextHotelRefs, userAdjusted: true },
    };
  }

  const days = {
    ...trip.days,
    [day.dayId]: { ...day, scheduleVisitRefs: nextVisitRefs, displayOrder: refsOf(next) },
  };

  let updated: Trip = { ...trip, days, visits, lodgings };
  if (visitOrderChanged) updated = recomputeDayTimeline(updated, dayIndex);
  return updated;
}

/** 一条「撤销后恢复混排位置」记录：移除前该实体在当天混排列表中的 0-based 下标 */
export interface DayDisplayPlacement {
  kind: "visit" | "hotel";
  ref: string;
  index: number;
}

/**
 * 把景点插回混排列表：desired 为原混排下标，但必须落在
 * 「scheduleVisitRefs 前一个景点之后、后一个景点之前」的合法区间内，
 * 否则展示顺序会与时间轴顺序（权威事实源）不一致。
 * 撤销期间用户可能新增 / 调整过其他景点，区间收敛让恢复位置尽可能贴近原处。
 */
function insertVisitAt(
  items: DayDisplayItem[],
  visit: DayVisitItem,
  desired: number,
  visitIds: string[],
): DayDisplayItem[] {
  const without = items.filter((item) => !(item.kind === "visit" && item.ref === visit.ref));
  const visitIndex = visitIds.indexOf(visit.ref);
  let lower = 0;
  let upper = without.length;
  if (visitIndex > 0) {
    const predecessor = visitIds[visitIndex - 1];
    const at = without.findIndex((item) => item.kind === "visit" && item.ref === predecessor);
    if (at !== -1) lower = at + 1;
  }
  if (visitIndex !== -1 && visitIndex < visitIds.length - 1) {
    const successor = visitIds[visitIndex + 1];
    const at = without.findIndex((item) => item.kind === "visit" && item.ref === successor);
    if (at !== -1) upper = at;
  }
  const target = Math.max(lower, Math.min(desired, upper));
  without.splice(target, 0, visit);
  return without;
}

/**
 * 撤销恢复混排位置（Task #108）：移除时记下 displayOrder 下标，撤销时只把这个实体
 * 放回原来的「酒店 / 景点交错」位置，不重排其他条目。
 *
 * 前置条件：scheduleVisitRefs / hotelRefs 已由撤销操作恢复；本函数只写 displayOrder。
 * - 景点受权威顺序约束（插入区间收敛），保证展示顺序与时间轴一致；
 * - 酒店无权威混排约束，按下标收敛到当前列表长度内；
 * - 实体已不在当天（未恢复成功 / 已被移走）时跳过；
 * - 下标越界按相邻锚点收敛，条目已在该位置时不产生无意义对象替换。
 */
export function placeDayDisplayRefs(
  trip: Trip,
  dayIndex: number,
  placements: DayDisplayPlacement[],
): Trip {
  const dayId = trip.dayRefs[dayIndex - 1];
  const day = dayId !== undefined ? trip.days[dayId] : undefined;
  if (day === undefined || placements.length === 0) return trip;

  const visitIds = validVisitIds(trip, day);
  const hotelIds = validHotelIds(trip, day);
  const seen = new Set<string>();
  const ordered = [...placements]
    .filter((placement) =>
      placement.kind === "visit" ? visitIds.includes(placement.ref) : hotelIds.includes(placement.ref),
    )
    .filter((placement) => {
      const key = `${placement.kind}:${placement.ref}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.index - right.index);
  if (ordered.length === 0) return trip;

  // 先把本次要恢复的实体全部从混排列表摘除，再按原下标升序插回：
  // 批量撤销时逐个插入会被「尚未归位的其他待恢复项」卡住，无法回到原始交错位置。
  const source = dayDisplayItems(trip, day);
  const byKey = new Map(source.map((item) => [`${item.kind}:${item.ref}`, item]));
  const placedKeys = new Set(ordered.map((placement) => `${placement.kind}:${placement.ref}`));
  let items = source.filter((item) => !placedKeys.has(`${item.kind}:${item.ref}`));
  for (const placement of ordered) {
    const item = byKey.get(`${placement.kind}:${placement.ref}`);
    if (item === undefined) continue;
    if (item.kind === "visit") {
      items = insertVisitAt(items, item, placement.index, visitIds);
      continue;
    }
    const target = Math.max(0, Math.min(placement.index, items.length));
    items.splice(target, 0, item);
  }

  const next = refsOf(items);
  if (sameOrder(day.displayOrder, next)) return trip;
  return {
    ...trip,
    days: { ...trip.days, [day.dayId]: { ...day, displayOrder: next } },
  };
}
