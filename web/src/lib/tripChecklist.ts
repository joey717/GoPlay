/**
 * 待办清单盘点（Task #265）——从 Trip 派生「待办 / 已完成」两组按天盘点的清单。
 *
 * 口径（与主行程的购买状态文案一致，不新增数据字段）：
 * - 酒店：LodgingPlan.purchaseState；unknown / toBuy → 待办，bought → 已完成；
 *   某天没有 lodging plan 或 hotelRefs 为空（连住宿都没选）→ 待办「未安排」。
 * - 景点：Visit.purchaseState；unknown / toBuy → 待办，bought / noTicket → 已完成。
 * - 航班：Constraint（type = flight_arrive / flight_depart，按 dayIndex 归天）；
 *   第一天没有到达航班约束 → 待办「到达航班 · 待录入」；
 *   最后一天没有出发航班约束 → 待办「出发航班 · 待录入」；
 *   已录入的航班进已完成，状态文案直接用约束 label（如「MU5831 落地 09:40」）。
 *
 * 约定：
 * - 只读纯函数，不修改 Trip；不做任何操作语义（本页只盘点，不支持勾选/改状态）；
 * - 每个分类内部保持行程原顺序（景点按 scheduleVisitRefs、航班按 constraints 顺序）；
 * - 「某天某分类没有任何条目」时该天的分类数组为空，由展示层整块不渲染。
 */

import type { LodgingPlan, Trip, Visit } from "@goplay/shared";
import { dayVisits, getPrimaryHotel, orderedDays, visitDisplayName } from "./trip";

/** 清单分类（展示顺序固定：住宿 → 景点 → 航班交通） */
export type CheckCategory = "hotel" | "attraction" | "transport";

/**
 * 条目状态：
 * - visit / lodging 的购买状态原样保留（unknown / toBuy / bought / noTicket）；
 * - missing：该天没有内容或航班没录入（待办侧占位）；
 * - flight：航班已录入，状态文案取约束 label。
 */
export type CheckStatus = Visit["purchaseState"] | "missing" | "flight";

export interface CheckItem {
  /** 稳定 key：按天 + 实体 id 拼装（同一天内唯一，跨分类不冲突） */
  id: string;
  name: string;
  status: CheckStatus;
  /** 与主行程一致的展示文案（未确定 / 现场买 / 已购 / 无需购票 / 现场订 / 已订房…） */
  statusLabel: string;
  category: CheckCategory;
}

export interface DayCheckItems {
  dayIndex: number;
  date: string;
  hotels: CheckItem[];
  attractions: CheckItem[];
  transport: CheckItem[];
}

export interface TripChecklist {
  /** 需要处理的事项（按天，只含至少有一个分类非空的天） */
  pending: DayCheckItems[];
  /** 已处理完的事项（同上） */
  done: DayCheckItems[];
}

/** 景点购票状态文案（与 useTrip 操作日志 / 卡片状态按钮同源口径） */
export const VISIT_STATUS_LABEL: Record<Visit["purchaseState"], string> = {
  unknown: "未确定",
  toBuy: "现场买",
  bought: "已购",
  noTicket: "无需购票",
};

/** 酒店预订状态文案（三档，无「无需购票」） */
export const LODGING_STATUS_LABEL: Record<LodgingPlan["purchaseState"], string> = {
  unknown: "未确定",
  toBuy: "现场订",
  bought: "已订房",
};

const ARRIVE_NAME = "到达航班";
const DEPART_NAME = "出发航班";
/** 未录入 / 未安排时的统一文案（待办侧） */
const MISSING_LABEL = "待录入";
const HOTEL_MISSING_NAME = "住宿待安排";
const HOTEL_MISSING_LABEL = "未安排";

function emptyDay(dayIndex: number, date: string): DayCheckItems {
  return { dayIndex, date, hotels: [], attractions: [], transport: [] };
}

/** 该天是否一条条目都没有（三个分类皆空 → 整天不展示） */
export function isDayEmpty(day: DayCheckItems): boolean {
  return day.hotels.length === 0 && day.attractions.length === 0 && day.transport.length === 0;
}

/** 单天条目数 */
export function dayCheckCount(day: DayCheckItems): number {
  return day.hotels.length + day.attractions.length + day.transport.length;
}

/** 一组天的总条目数（tab 上的 N） */
export function checklistCount(days: DayCheckItems[]): number {
  return days.reduce((sum, day) => sum + dayCheckCount(day), 0);
}

/**
 * 组装待办 / 已完成清单。
 *
 * 航班的两条「待录入」判定只看首日与末日：
 * - 首日无 flight_arrive 约束（不看别的天，约束归哪一天就展示在哪一天）；
 * - 末日无 flight_depart 约束。单天行程时两条待录入都落在同一天。
 */
export function buildTripChecklist(trip: Trip): TripChecklist {
  const days = orderedDays(trip);
  if (days.length === 0) return { pending: [], done: [] };

  const firstDayIndex = days[0].dayIndex;
  const lastDayIndex = days[days.length - 1].dayIndex;
  const constraints = trip.constraints ?? [];

  const pending: DayCheckItems[] = [];
  const done: DayCheckItems[] = [];

  for (const day of days) {
    const pendingDay = emptyDay(day.dayIndex, day.date);
    const doneDay = emptyDay(day.dayIndex, day.date);

    // ---- 住宿：没有计划 / 没有候选 → 待办「未安排」；有候选按预订状态分流 ----
    const plan = trip.lodgings[String(day.dayIndex)] ?? null;
    if (plan === null || plan.hotelRefs.length === 0) {
      pendingDay.hotels.push({
        id: `hotel-${day.dayIndex}`,
        name: HOTEL_MISSING_NAME,
        status: "missing",
        statusLabel: HOTEL_MISSING_LABEL,
        category: "hotel",
      });
    } else {
      // rev2 多候选契约暂取首位展示（与卡片一致）；引用悬空时不伪造酒店名
      const hotel = getPrimaryHotel(trip, plan);
      const item: CheckItem = {
        id: `hotel-${day.dayIndex}`,
        name: hotel?.name ?? "已选酒店（信息待补全）",
        status: plan.purchaseState,
        statusLabel: LODGING_STATUS_LABEL[plan.purchaseState],
        category: "hotel",
      };
      if (plan.purchaseState === "bought") doneDay.hotels.push(item);
      else pendingDay.hotels.push(item);
    }

    // ---- 景点：按当天排期顺序，逐条按购票状态分流 ----
    for (const visit of dayVisits(trip, day)) {
      const item: CheckItem = {
        id: `visit-${day.dayIndex}-${visit.visitId}`,
        name: visitDisplayName(trip, visit),
        status: visit.purchaseState,
        statusLabel: VISIT_STATUS_LABEL[visit.purchaseState],
        category: "attraction",
      };
      if (visit.purchaseState === "bought" || visit.purchaseState === "noTicket") {
        doneDay.attractions.push(item);
      } else {
        pendingDay.attractions.push(item);
      }
    }

    // ---- 航班：当天已录入的约束进已完成；首/末日缺约束进待办 ----
    for (const constraint of constraints) {
      if (constraint.dayIndex !== day.dayIndex) continue;
      if (constraint.type !== "flight_arrive" && constraint.type !== "flight_depart") continue;
      const label = constraint.label?.trim() ?? "";
      doneDay.transport.push({
        id: `flight-${constraint.constraintId}`,
        name: constraint.type === "flight_arrive" ? ARRIVE_NAME : DEPART_NAME,
        status: "flight",
        statusLabel: label !== "" ? label : "已录入",
        category: "transport",
      });
    }
    const hasArrive = constraints.some(
      (constraint) => constraint.type === "flight_arrive" && constraint.dayIndex === day.dayIndex,
    );
    const hasDepart = constraints.some(
      (constraint) => constraint.type === "flight_depart" && constraint.dayIndex === day.dayIndex,
    );
    if (day.dayIndex === firstDayIndex && !hasArrive) {
      pendingDay.transport.push({
        id: `flight-arrive-${day.dayIndex}`,
        name: ARRIVE_NAME,
        status: "missing",
        statusLabel: MISSING_LABEL,
        category: "transport",
      });
    }
    if (day.dayIndex === lastDayIndex && !hasDepart) {
      pendingDay.transport.push({
        id: `flight-depart-${day.dayIndex}`,
        name: DEPART_NAME,
        status: "missing",
        statusLabel: MISSING_LABEL,
        category: "transport",
      });
    }

    if (!isDayEmpty(pendingDay)) pending.push(pendingDay);
    if (!isDayEmpty(doneDay)) done.push(doneDay);
  }

  return { pending, done };
}
