/**
 * 任务 189：生成前影响范围的一句话预判（纯函数，GuideDraftPanel 消费）。
 *
 * 与服务端 resolveDraftScope（server/src/guides/planner.ts）同向的轻量近似：
 * 1. 入口上下文优先：day 入口 → 该天；attraction 入口 → 该大景区；
 * 2. 证据归属近似：所选来源的 mention refs 命中的实体（Visit/Stop 持有的
 *    sourceMentionRefs / guideSnippets refs）全部落在同一天 → 该天；全部落在
 *    同一大景区 → 该景区；
 * 3. 跨天 / 跨景区 / 无关联实体 → 整程。
 *
 * 与服务端的已知差异（保守回退，不误导）：
 * - 补充句日期指令优先级最高（服务端规则 1），前端不解析日期指令——
 *   预判可能比实际 scope 更宽（回退整程），实际范围以草案返回的 scope 为准；
 * - 服务端 merge 的名称兜底对齐（未挂 ref 的提及按名称归入实体）不复刻，
 *   前端只认精确 ref 命中，同样只会更保守（更常回退整程）。
 */

import type { GuideSource, GuideSnippet, Stop, Trip, Visit } from "@goplay/shared";
import { isGuideSourceUsable } from "@goplay/shared";
import type { GuideDraftEntryContext } from "../api/client";
import { visitDisplayName } from "./trip";

/** 预判结果：某天 / 某大景区 / 整程（与服务端 DraftScope 同构） */
export type DraftScopeHint =
  | { kind: "day"; dayIndex: number }
  | { kind: "attraction"; visitId: string; name: string }
  | { kind: "trip" };

/** 实体持有的精确提及引用（sourceMentionRefs + guideSnippets.sourceMentionRefs） */
function entityMentionRefs(entity: {
  sourceMentionRefs?: string[];
  guideSnippets?: GuideSnippet[];
}): Set<string> {
  const refs = new Set<string>(entity.sourceMentionRefs ?? []);
  for (const snippet of entity.guideSnippets ?? []) {
    for (const ref of snippet.sourceMentionRefs ?? []) refs.add(ref);
  }
  return refs;
}

/** 所选来源的全部提及引用（只收 active 来源；与 merge 的素材口径一致收窄到可用来源） */
function selectedMentionRefs(
  trip: Trip,
  selectedSourceIds: readonly string[],
): Set<string> {
  const refs = new Set<string>();
  for (const id of selectedSourceIds) {
    const source = trip.guideSources?.[id];
    if (source === undefined || source === null) continue;
    if (!isGuideSourceUsable(trip, source)) continue;
    for (const ref of source.mentionRefs ?? []) refs.add(ref);
  }
  return refs;
}

/**
 * 生成前范围预判。selectedSourceIds 为本轮将消费的来源（局部模式 = 所选 id；
 * 全部重排语义上 = 全部非暂存可用来源，调用方按需传入）；空数组 = 无具体
 * 素材可依（整程口径）。
 */
export function resolveDraftScopeHint(
  trip: Trip,
  selectedSourceIds: readonly string[],
  entryContext: GuideDraftEntryContext | undefined,
): DraftScopeHint {
  // 1. 入口上下文：day / attraction 入口优先局部（与服务端规则 2 一致）
  if (entryContext?.type === "day") {
    const dayIndex = entryContext.dayIndex;
    if (Number.isInteger(dayIndex) && dayIndex >= 1 && dayIndex <= trip.dayRefs.length) {
      return { kind: "day", dayIndex };
    }
  } else if (entryContext?.type === "attraction") {
    const visit = trip.visits?.[entryContext.visitId];
    if (visit !== undefined && visit.kind === "large_attraction") {
      return {
        kind: "attraction",
        visitId: entryContext.visitId,
        name: visitDisplayName(trip, visit),
      };
    }
  }

  // 2. 证据归属近似：只看实体持有的精确 refs（与服务端对齐组同源）
  const refs = selectedMentionRefs(trip, selectedSourceIds);
  if (refs.size === 0) return { kind: "trip" };

  // visitId → 所在天索引
  const dayByVisitId = new Map<string, number>();
  for (const dayId of trip.dayRefs) {
    const day = trip.days?.[dayId];
    if (day === undefined) continue;
    for (const visitId of day.scheduleVisitRefs ?? []) dayByVisitId.set(visitId, day.dayIndex);
  }
  // stopId → 所属大景区 visitId（只认 large_attraction 父级）
  const attractionByStopId = new Map<string, string>();
  for (const visit of Object.values(trip.visits ?? {})) {
    if (visit.kind !== "large_attraction") continue;
    for (const stopId of visit.childStopRefs ?? []) attractionByStopId.set(stopId, visit.visitId);
  }

  /** 关联实体的归属（visit 与 stop 统一折算到天或大景区；两者都可能为 null） */
  function locate(
    entityRefs: Set<string>,
    visit: Visit | undefined,
    stop: Stop | undefined,
  ): { dayIndex: number | null; attractionVisitId: string | null } | null {
    let hit = false;
    for (const ref of entityRefs) {
      if (refs.has(ref)) {
        hit = true;
        break;
      }
    }
    if (!hit) return null;
    // stop 归属：先看是否为某大景区内部玩法，再回落其父 visit 所在天
    if (stop !== undefined) {
      const parentAttraction = attractionByStopId.get(stop.stopId);
      if (parentAttraction !== undefined) return { dayIndex: null, attractionVisitId: parentAttraction };
    }
    if (visit !== undefined) {
      if (visit.kind === "large_attraction") {
        return { dayIndex: null, attractionVisitId: visit.visitId };
      }
      const dayIndex = dayByVisitId.get(visit.visitId);
      return { dayIndex: dayIndex ?? null, attractionVisitId: null };
    }
    return { dayIndex: null, attractionVisitId: null };
  }

  const dayIndexes = new Set<number>();
  const attractionVisitIds = new Set<string>();
  let alignedCount = 0;
  const collect = (
    location: { dayIndex: number | null; attractionVisitId: string | null } | null,
  ): void => {
    if (location === null) return;
    alignedCount += 1;
    if (location.dayIndex !== null) dayIndexes.add(location.dayIndex);
    if (location.attractionVisitId !== null) attractionVisitIds.add(location.attractionVisitId);
  };

  for (const visit of Object.values(trip.visits ?? {})) {
    collect(locate(entityMentionRefs(visit), visit, undefined));
  }
  for (const stop of Object.values(trip.stops ?? {})) {
    collect(locate(entityMentionRefs(stop), undefined, stop));
  }

  if (alignedCount === 0) return { kind: "trip" }; // 无任何关联实体：不收敛
  if (dayIndexes.size === 0 && attractionVisitIds.size === 1) {
    const visitId = [...attractionVisitIds][0]!;
    const visit = trip.visits?.[visitId];
    return {
      kind: "attraction",
      visitId,
      name: visit !== undefined ? visitDisplayName(trip, visit) : "大景区",
    };
  }
  if (attractionVisitIds.size === 0 && dayIndexes.size === 1) {
    return { kind: "day", dayIndex: [...dayIndexes][0]! };
  }
  return { kind: "trip" };
}

/**
 * 预判结果的用户语言一句话文案（单行展示，不恢复两行说明）。
 *
 * Task #242：整程不返回文案（null = 不渲染）——「将调整整段行程」属于没有操作价值的
 * 冗余提示，用户补一句自然语言要求 + 服务端自动判定 scope 即可，不再用占位句解释范围。
 * 局部入口（Day / 大景区）仍保留一句预判，因为它能解释「这次只动这一小块」。
 */
export function draftScopeHintLabel(hint: DraftScopeHint): string | null {
  if (hint.kind === "day") return `将优先优化 Day${hint.dayIndex} 的安排`;
  if (hint.kind === "attraction") return `将优先补充「${hint.name}」的玩法`;
  return null;
}
