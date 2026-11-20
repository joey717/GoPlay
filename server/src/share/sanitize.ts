/**
 * 只读分享脱敏（Task #205）。
 *
 * 输入是 tripStore.load 的内存形态 Trip，输出是 SharedTrip（web 只读视图消费）。
 * 原则：只做「减法」，绝不改写业务字段；不修改入参（纯函数），可被验证脚本直接复用。
 *
 * 剥除口径：
 * 1. 完全删除 —— evidences（攻略原文 / OCR / 原图路径）、guideSources（来源链接与
 *    处理状态）、pendingGuideDraft / guideDraftNote（未落地的草案与补充句）、
 *    globalCandidateRefs / pendingStopRefs（候选池）、relationshipSuggestions
 *    （来源归属溯源信号）；
 * 2. 引用清空 —— Visit / Stop / Item 的 sourceMentionRefs、sourceEvidenceRefs
 *    一律置空数组：证据已不在载荷中，保留 "evidenceId:mentionId" 只会悬空；
 * 3. 攻略亮点保留 —— guideSnippets 的 text / claimKind / snippetId 保留（分享页
 *    展示「亮点」），但其 sourceMentionRefs 清空；optionGroups 属原文价格 / 路线
 *    结构化引用，分享页不展示，整体删除；
 * 4. 只保留排进行程的 Visit 及其引用的 Stop（attached / alternate）——待定池里的
 *    Stop 不随分享外泄；
 * 5. 保留纯行程事实 —— 目的地 / 日期 / 天 / 住宿计划（purchaseState 属公开信息）/
 *    酒店主数据 / 约束 / 时间轴字段。
 */

import type {
  Constraint,
  Day,
  GuideSnippet,
  Item,
  LodgingPlan,
  SharedTrip,
  Stop,
  Trip,
  Visit,
} from "@goplay/shared";
import { SCHEMA_VERSION } from "@goplay/shared";

/** 攻略亮点去引用：保留展示文本与事实类型，剥掉 "evidenceId:mentionId" 定位串 */
function sanitizeSnippets(snippets: GuideSnippet[] | undefined): GuideSnippet[] | undefined {
  if (snippets === undefined) return undefined;
  return snippets.map((snippet) => ({ ...snippet, sourceMentionRefs: [] }));
}

function sanitizeVisit(visit: Visit): Visit {
  const next: Visit = {
    ...visit,
    sourceMentionRefs: [],
    childStopRefs: [...visit.childStopRefs],
    alternateStopRefs: [...visit.alternateStopRefs],
  };
  const snippets = sanitizeSnippets(visit.guideSnippets);
  if (snippets !== undefined) next.guideSnippets = snippets;
  else delete next.guideSnippets;
  // 实用参考选项组带原文 mention 定位（价格 / 路线原句），分享页不展示
  delete next.optionGroups;
  return next;
}

function sanitizeStop(stop: Stop): Stop {
  const next: Stop = {
    ...stop,
    sourceEvidenceRefs: [],
    sourceMentionRefs: [],
  };
  const snippets = sanitizeSnippets(stop.guideSnippets);
  if (snippets !== undefined) next.guideSnippets = snippets;
  else delete next.guideSnippets;
  return next;
}

function sanitizeItem(item: Item): Item {
  return { ...item, sourceEvidenceRefs: [] };
}

function sanitizeConstraints(constraints: Constraint[]): Constraint[] {
  return constraints.map((constraint) => ({ ...constraint }));
}

/**
 * Trip → SharedTrip 脱敏。入参不被修改；返回对象与入参不共享可变的嵌套数组引用
 * （visits / stops / items / days / lodgings / constraints 均为新对象）。
 */
export function sanitizeTrip(trip: Trip): SharedTrip {
  // 只分享已排期的城市级 Visit（dayRef 非空即出现在某个 day.scheduleVisitRefs 中）
  const scheduledVisitIds = new Set<string>();
  for (const day of Object.values(trip.days)) {
    for (const visitId of day.scheduleVisitRefs) scheduledVisitIds.add(visitId);
  }

  const visits: Record<string, Visit> = {};
  const keptStopIds = new Set<string>();
  for (const visitId of scheduledVisitIds) {
    const visit = trip.visits[visitId];
    if (visit === undefined) continue;
    visits[visitId] = sanitizeVisit(visit);
    for (const stopId of visit.childStopRefs) keptStopIds.add(stopId);
    for (const stopId of visit.alternateStopRefs) keptStopIds.add(stopId);
  }

  const stops: Record<string, Stop> = {};
  for (const stopId of keptStopIds) {
    const stop = trip.stops[stopId];
    if (stop !== undefined) stops[stopId] = sanitizeStop(stop);
  }

  const itemRegistry: Record<string, Item> = {};
  for (const [itemId, item] of Object.entries(trip.itemRegistry)) {
    itemRegistry[itemId] = sanitizeItem(item);
  }

  const days: Record<string, Day> = {};
  for (const [dayId, day] of Object.entries(trip.days)) {
    days[dayId] = { ...day, scheduleVisitRefs: [...day.scheduleVisitRefs] };
  }

  const lodgings: Record<string, LodgingPlan> = {};
  for (const [key, plan] of Object.entries(trip.lodgings)) {
    lodgings[key] = { ...plan, hotelRefs: [...plan.hotelRefs] };
  }

  return {
    tripId: trip.tripId,
    schemaVersion: trip.schemaVersion ?? SCHEMA_VERSION,
    version: trip.version,
    // Task #257：封面三字段属于「分享首屏」的展示事实（封面图 / 名称 / 备忘），
    // 不含任何证据或订单引用，按原值下发；undefined 时保持键缺失（read 侧按空值处理）。
    ...(trip.coverImage !== undefined ? { coverImage: trip.coverImage } : {}),
    ...(trip.tripName !== undefined ? { tripName: trip.tripName } : {}),
    ...(trip.memo !== undefined ? { memo: trip.memo } : {}),
    destination: { ...trip.destination },
    dateRange: { ...trip.dateRange },
    dayRefs: [...trip.dayRefs],
    days,
    lodgings,
    itemRegistry,
    hotelRegistry: { ...trip.hotelRegistry },
    visits,
    stops,
    constraints: sanitizeConstraints(trip.constraints),
    createdAt: trip.createdAt,
    updatedAt: trip.updatedAt,
  };
}
