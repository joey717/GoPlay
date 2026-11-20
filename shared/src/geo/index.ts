/**
 * Task #325：地理计算模块（纯函数，无 IO，无副作用）。
 *
 * 职责：
 * - haversineKm：球面大圆距离（从 server/src/flyai/scope.ts 原样迁移）；
 * - SANYA_AIRPORT：凤凰机场坐标常量（经 eval/cache/flyai 椰梦长廊坐标反算验证）；
 * - resolveItemCoords：Item.coords 防御性读取（脏数据不抛异常）；
 * - attributePoiArea：POI 片区归属（名称标记优先 + 最近中心兜底 + 超 20km 判 unknown）；
 * - computeDayGeoStats：单日地理统计（跨度 / 距机场 / 序列化距离）；
 * - evaluateDayCapacity：抵达日 / 返程日容量评估（计数型，D2 约束：不用时长求和）。
 *
 * 设计约束（D1-D4）：
 * - D1：返程日判定用「行程最后一天」（dayIndex === days.length），不以 role 为开关；
 * - D2：只用计数型规则（每天 ai_proposed visit 条数），禁止用时长求和型规则；
 * - D3：抵达日规则降级为「距机场距离」口径（PD 行程无 lodging）；
 * - D4：片区归属 marker 优先 + 20km 上限 + unknown 一等公民；顺路度量用跨度而非同片区。
 */

import type { Item, Trip } from "../types/index.js";
import { SANYA_AREAS } from "../areas/index.js";
import { collectAreaPlaceholderVisitIds } from "../areaPlaceholder.js";
import { deriveDepartureDayCutoff } from "../dayRoles/index.js";

// ===== 常量 =====

/**
 * 三亚凤凰国际机场坐标。
 *
 * 验证方法：eval/cache/flyai 椰梦长廊 POI（id=163575）coords={lng:109.475755,lat:18.274345}，
 * haversine(椰梦长廊, SANYA_AIRPORT) = 7.43km，与设计文档 §1.2 Day1 实测值 7.4km 吻合；
 * 蜈支洲岛（PD 行程 item coords={lng:109.762849,lat:18.309938}）→ 37.3km ≈ 设计文档 37.4km。
 * 三亚湾片区中心 {lat:18.247,lng:109.412} 距机场 6.2km，在 verify 兜底区间 [5,15]km 内。
 */
export const SANYA_AIRPORT: { lat: number; lng: number } = { lat: 18.3029, lng: 109.4122 };

/** POI 片区归属最大距离（km）：超出此距离判 unknown，不强行归属（D4） */
export const POI_ATTRIBUTION_MAX_KM = 20;

/** 抵达日 AI 新增 Visit 上限（设计文档 §3：≤2） */
export const ARRIVAL_DAY_MAX_VISITS = 2;

/** 最后一天（无 flight_depart）AI 新增 Visit 上限（设计文档 §3：≤2） */
export const LAST_DAY_NO_FLIGHT_MAX_VISITS = 2;

/** 最后一天（无 flight_depart）距机场剥离阈值 km（设计文档 §3：>25km 即剥离） */
export const LAST_DAY_NO_FLIGHT_AIRPORT_KM = 25;

/** 最后一天（有 flight_depart，role=departure）AI 新增 Visit 上限（设计文档 §3：≤1） */
export const LAST_DAY_DEPARTURE_MAX_VISITS = 1;

/** 最后一天（有 flight_depart）距机场剥离阈值 km（设计文档 §3：>15km 即剥离） */
export const LAST_DAY_DEPARTURE_AIRPORT_KM = 15;

// ===== haversineKm（从 server/src/flyai/scope.ts#182-194 原样迁移） =====

/** 球面大圆距离（km），用于坐标与片区中心 / 机场的偏差计算 */
export function haversineKm(
  a: { lng: number; lat: number },
  b: { lng: number; lat: number },
): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const lat1 = a.lat * rad;
  const lat2 = b.lat * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ===== resolveItemCoords =====

/**
 * 防御性读取 Item.coords：校验 lat/lng 均为有限数字，否则返回 null。
 * 设计文档 §A-P0 #3：「coords 字段存在但 lat/lng 非数字而抛 TypeError」的真实故障形态。
 */
export function resolveItemCoords(item: Item | null | undefined): { lng: number; lat: number } | null {
  if (item === null || item === undefined) return null;
  const coords = item.coords;
  if (coords === null || coords === undefined) return null;
  if (typeof coords !== "object") return null;
  const { lat, lng } = coords as { lat?: unknown; lng?: unknown };
  if (typeof lat !== "number" || !Number.isFinite(lat)) return null;
  if (typeof lng !== "number" || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

// ===== attributePoiArea =====

export interface PoiAreaResult {
  areaId: string | null;
  areaName: string | null;
  method: "marker" | "center" | "none";
  distanceKm: number | null;
}

/**
 * POI 片区归属（D4 决定的三级优先级）：
 * ① 名称/地址标记命中 → method="marker"（多片区命中时按 SANYA_AREAS 数组顺序取第一个）
 * ② 最近中心 + ≤20km → method="center"（距离相等时按数组顺序取前者）
 * ③ 都不满足 → method="none"（unknown 是一等结果，绝不强行归属）
 */
export function attributePoiArea(item: Item | null | undefined): PoiAreaResult {
  if (item === null || item === undefined) {
    return { areaId: null, areaName: null, method: "none", distanceKm: null };
  }

  // ① 名称/地址标记命中
  const text = [item.name, item.address]
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .join(" ");
  if (text !== "") {
    for (const area of SANYA_AREAS) {
      for (const marker of area.hotelMarkers) {
        if (text.includes(marker)) {
          // marker 命中：计算距离（如果有坐标）
          const coords = resolveItemCoords(item);
          const dist = coords !== null ? haversineKm(coords, area.center) : null;
          return { areaId: area.id, areaName: area.name, method: "marker", distanceKm: dist };
        }
      }
    }
  }

  // ② 最近中心 + 半径上限
  const coords = resolveItemCoords(item);
  if (coords !== null) {
    let bestArea: (typeof SANYA_AREAS)[number] | null = null;
    let bestDist = Infinity;
    for (const area of SANYA_AREAS) {
      const dist = haversineKm(coords, area.center);
      if (dist < bestDist) {
        bestDist = dist;
        bestArea = area;
      }
      // 距离相等时按数组顺序取前者（严格 < 保证确定性）
    }
    if (bestArea !== null && bestDist <= POI_ATTRIBUTION_MAX_KM) {
      return { areaId: bestArea.id, areaName: bestArea.name, method: "center", distanceKm: bestDist };
    }
  }

  // ③ unknown
  return { areaId: null, areaName: null, method: "none", distanceKm: null };
}

// ===== computeDayGeoStats =====

export interface DayGeoStats {
  visitCount: number;
  coordsKnownCount: number;
  /** 有坐标点位的两两最大距离（km）；有坐标 <2 时为 null */
  spanKm: number | null;
  /** 按 scheduleVisitRefs 顺序相邻累加距离（km）；有坐标 <2 时为 null */
  sequentialLegKm: number | null;
  /** 该天有坐标点位到 SANYA_AIRPORT 的最大距离（km）；无坐标时 null */
  maxAirportKm: number | null;
  /** 无法获取坐标的点位名称 */
  unknownNames: string[];
}

/**
 * 单日地理统计（纯函数，不修改入参 trip）。
 * 计算前排除区域占位点位（复用 collectAreaPlaceholderVisitIds）。
 */
export function computeDayGeoStats(trip: Trip, dayIndex: number): DayGeoStats {
  const dayId = trip.dayRefs[dayIndex - 1];
  if (dayId === undefined) {
    return { visitCount: 0, coordsKnownCount: 0, spanKm: null, sequentialLegKm: null, maxAirportKm: null, unknownNames: [] };
  }
  const day = trip.days[dayId];
  if (day === undefined) {
    return { visitCount: 0, coordsKnownCount: 0, spanKm: null, sequentialLegKm: null, maxAirportKm: null, unknownNames: [] };
  }

  const placeholderIds = collectAreaPlaceholderVisitIds(trip);
  const visitRefs = day.scheduleVisitRefs.filter((vid) => !placeholderIds.has(vid));
  const visitCount = visitRefs.length;

  // 收集有坐标的点位（保持 scheduleVisitRefs 顺序）
  const coordPoints: { lng: number; lat: number }[] = [];
  const unknownNames: string[] = [];

  for (const visitId of visitRefs) {
    const visit = trip.visits[visitId];
    if (visit === undefined) continue;
    const item = trip.itemRegistry[visit.pointRef];
    const coords = resolveItemCoords(item);
    if (coords !== null) {
      coordPoints.push(coords);
    } else {
      unknownNames.push(item?.name ?? visitId);
    }
  }

  const coordsKnownCount = coordPoints.length;

  // spanKm：两两最大距离
  let spanKm: number | null = null;
  if (coordsKnownCount >= 2) {
    let maxSpan = 0;
    for (let i = 0; i < coordPoints.length; i++) {
      for (let j = i + 1; j < coordPoints.length; j++) {
        const d = haversineKm(coordPoints[i], coordPoints[j]);
        if (d > maxSpan) maxSpan = d;
      }
    }
    spanKm = Math.round(maxSpan * 10) / 10;
  }

  // sequentialLegKm：按 scheduleVisitRefs 顺序相邻累加（只对有坐标的连续对）
  let sequentialLegKm: number | null = null;
  if (coordsKnownCount >= 2) {
    let total = 0;
    for (let i = 1; i < coordPoints.length; i++) {
      total += haversineKm(coordPoints[i - 1], coordPoints[i]);
    }
    sequentialLegKm = Math.round(total * 10) / 10;
  }

  // maxAirportKm：到 SANYA_AIRPORT 的最大距离
  let maxAirportKm: number | null = null;
  if (coordsKnownCount >= 1) {
    let maxDist = 0;
    for (const pt of coordPoints) {
      const d = haversineKm(pt, SANYA_AIRPORT);
      if (d > maxDist) maxDist = d;
    }
    maxAirportKm = Math.round(maxDist * 10) / 10;
  }

  return { visitCount, coordsKnownCount, spanKm, sequentialLegKm, maxAirportKm, unknownNames };
}

// ===== evaluateDayCapacity =====

export interface CapacityResult {
  ok: boolean;
  reason: string | null;
}

/**
 * 抵达日 / 返程日（行程最后一天）容量评估（D1-D3 约束的计数型规则）。
 *
 * @param trip 行程
 * @param dayIndex 目标天（1-based）
 * @param netAddCount 本批 AI 对该天的净新增城市级 Visit 条数（已扣除 remove 对冲）
 * @param addedCoords 本批 AI 新增点位的坐标数组（用于距机场判定）
 * @param addedNames 本批 AI 新增点位的名称数组（用于 reason 文案）
 * @param existingAiCount 该天既有的 AI 排入（非豁免）的 visit 条数
 * @returns { ok, reason } ok=true 放行；ok=false 应剥离，reason 带具体数值
 *
 * 判定口径：
 * - 抵达日（trip.constraints 有 flight_arrive 命中该天）：总新增后 ≤2
 * - 行程最后一天 + 无 flight_depart：≤2 且任一新增 >25km 即剥离
 * - 行程最后一天 + 有 flight_depart（或 role=departure）：≤1 且任一新增 >15km 即剥离
 * - 其余天：不约束（ok=true）
 */
export function evaluateDayCapacity(
  trip: Trip,
  dayIndex: number,
  netAddCount: number,
  addedCoords: ({ lng: number; lat: number } | null)[],
  addedNames: string[],
  existingAiCount: number,
): CapacityResult {
  const totalDays = (trip.dayRefs ?? []).length;
  if (dayIndex < 1 || dayIndex > totalDays) return { ok: true, reason: null };

  // 判定是否为抵达日
  const isArrivalDay = (trip.constraints ?? []).some(
    (c) => c.type === "flight_arrive" && c.dayIndex === dayIndex,
  );

  // 判定是否为最后一天
  const isLastDay = dayIndex === totalDays;

  // 判定最后一天是否有 flight_depart
  const hasDepartFlight = isLastDay && (trip.constraints ?? []).some(
    (c) => c.type === "flight_depart" && c.dayIndex === dayIndex,
  );

  // 也检查 day.role === "departure"（D1 补充：role 不是唯一判据但有航班证据时收紧）
  const dayId = trip.dayRefs[dayIndex - 1];
  const day = dayId !== undefined ? trip.days[dayId] : undefined;
  const roleIsDeparture = day?.role === "departure";
  const isDepartureLastDay = isLastDay && (hasDepartFlight || roleIsDeparture);

  if (isDepartureLastDay) {
    // 收紧档：≤1，>15km 即剥离
    const total = existingAiCount + netAddCount;
    if (total > LAST_DAY_DEPARTURE_MAX_VISITS) {
      return {
        ok: false,
        reason: `[容量] Day${dayIndex} 为行程最后一天（有返程航班），截止 ${deriveDepartureDayCutoff(trip)?.cutoffTime ?? "15:00"}，已排 ${existingAiCount} 项 + 本批新增 ${netAddCount} 项 = ${total} 项，超出返程日容量上限 ${LAST_DAY_DEPARTURE_MAX_VISITS} 项，未排入；建议改到其他天`,
      };
    }
    // 距离检查
    for (let i = 0; i < addedCoords.length; i++) {
      const coord = addedCoords[i];
      if (coord === null) continue;
      const dist = haversineKm(coord, SANYA_AIRPORT);
      if (dist > LAST_DAY_DEPARTURE_AIRPORT_KM) {
        const name = addedNames[i] ?? "未知点位";
        return {
          ok: false,
          reason: `[容量] Day${dayIndex} 为行程最后一天（有返程航班，截止 ${deriveDepartureDayCutoff(trip)?.cutoffTime ?? "15:00"}），${name} 距凤凰机场 ${dist.toFixed(1)}km，超出返程日 ${LAST_DAY_DEPARTURE_AIRPORT_KM}km 半径，未排入；建议改到其他天`,
        };
      }
    }
    return { ok: true, reason: null };
  }

  if (isLastDay) {
    // 无 flight_depart 的最后一天：≤2，>25km 即剥离
    const cutoff = deriveDepartureDayCutoff(trip);
    const total = existingAiCount + netAddCount;
    if (total > LAST_DAY_NO_FLIGHT_MAX_VISITS) {
      return {
        ok: false,
        reason: `[容量] Day${dayIndex} 为行程最后一天（截止 ${cutoff?.cutoffTime ?? "15:00"}），已排 ${existingAiCount} 项 + 本批新增 ${netAddCount} 项 = ${total} 项，超出最后一天容量上限 ${LAST_DAY_NO_FLIGHT_MAX_VISITS} 项，未排入；建议改到其他天`,
      };
    }
    for (let i = 0; i < addedCoords.length; i++) {
      const coord = addedCoords[i];
      if (coord === null) continue;
      const dist = haversineKm(coord, SANYA_AIRPORT);
      if (dist > LAST_DAY_NO_FLIGHT_AIRPORT_KM) {
        const name = addedNames[i] ?? "未知点位";
        return {
          ok: false,
          reason: `[容量] Day${dayIndex} 为行程最后一天（截止 ${cutoff?.cutoffTime ?? "15:00"}），${name} 距凤凰机场 ${dist.toFixed(1)}km，超出最后一天 ${LAST_DAY_NO_FLIGHT_AIRPORT_KM}km 半径，未排入；建议改到其他天`,
        };
      }
    }
    return { ok: true, reason: null };
  }

  if (isArrivalDay) {
    // 抵达日：≤2
    const total = existingAiCount + netAddCount;
    if (total > ARRIVAL_DAY_MAX_VISITS) {
      return {
        ok: false,
        reason: `[容量] Day${dayIndex} 为抵达日，已排 ${existingAiCount} 项 + 本批新增 ${netAddCount} 项 = ${total} 项，超出抵达日容量上限 ${ARRIVAL_DAY_MAX_VISITS} 项，未排入；建议改到其他天`,
      };
    }
    return { ok: true, reason: null };
  }

  // 其余天不约束
  return { ok: true, reason: null };
}
