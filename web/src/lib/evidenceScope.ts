/**
 * 任务 116：按点位层级筛选攻略原文提及（纯函数，EvidenceSheet 消费）。
 *
 * 产品规则：
 * 1. 大景点 Visit：自身 + 全部内部 Stop（childStopRefs）的相关提及；备选玩法不并入；
 * 2. 普通景点 Visit：仅自身相关提及；
 * 3. 大景点内部 Stop：仅自身相关提及，不合并父 Visit；
 * 4. 不因「与目标同属一篇 evidence」而展示其中其他无关地点。
 *
 * 精确优先：实体的 sourceMentionRefs 与 guideSnippets.sourceMentionRefs 能解析到
 * 真实提及时，按 ref 严格筛选（本实体不再做名称兜底，避免混入同证据其他地点）。
 * 旧数据降级：实体缺精确 ref（为空或全部悬空）时，在其候选证据
 * （Stop.sourceEvidenceRefs / Visit 关联 Item.sourceEvidenceRefs）内按
 * 实体名称与 mention.extractedName 的规范化匹配；无法匹配则不展示——
 * 宁可清晰空态，不回退整篇所有 mentions。
 */

import type { EvidenceMention, GuideSnippet, Stop, Trip, Visit } from "@goplay/shared";
import { canonicalPoiMatchKey, parseMentionRef } from "@goplay/shared";
import { stopDisplayName, visitDisplayName, visitItem } from "./trip";

/**
 * 名称规范化：去成对括号内容、去空白、去已知城市前缀，并把显式别名解析为正式名，
 * 最后转小写（Task #233：唯一实现在 @goplay/shared poiAlias，本处只转发）。
 * 与 server 真实召回 / 对齐链路口径一致；server normalizePoiName 仍为基础口径。
 */
export function normalizeEvidenceName(name: string): string {
  return canonicalPoiMatchKey(name);
}

/** 降级名称匹配：规范化后精确相等；或双向包含（两侧均 ≥2 字符，防止单字误命中） */
function fallbackNameMatches(target: string, extracted: string): boolean {
  if (target === "" || extracted === "") return false;
  if (target === extracted) return true;
  return (
    target.length >= 2 &&
    extracted.length >= 2 &&
    (extracted.includes(target) || target.includes(extracted))
  );
}

/** 参与范围计算的实体（目标自身；大景点额外含内部 Stop） */
interface ScopeEntity {
  /** 展示名（降级名称匹配用） */
  name: string;
  /** 精确提及引用 "evidenceId:mentionId"（sourceMentionRefs + guideSnippets） */
  preciseRefs: string[];
  /** 降级候选证据 id（实体缺精确 ref 时按名称在其中匹配） */
  fallbackEvidenceIds: string[];
}

/** 从实体收集精确 refs：sourceMentionRefs + guideSnippets.sourceMentionRefs */
function collectPreciseRefs(entity: {
  sourceMentionRefs?: string[];
  guideSnippets?: GuideSnippet[];
}): string[] {
  const snippets = Array.isArray(entity.guideSnippets) ? entity.guideSnippets : [];
  return [
    ...(Array.isArray(entity.sourceMentionRefs) ? entity.sourceMentionRefs : []),
    ...snippets.flatMap((snippet) =>
      Array.isArray(snippet?.sourceMentionRefs) ? snippet.sourceMentionRefs : [],
    ),
  ];
}

function stopEntity(trip: Trip, stop: Stop): ScopeEntity {
  return {
    name: stopDisplayName(trip, stop),
    preciseRefs: collectPreciseRefs(stop),
    fallbackEvidenceIds: Array.isArray(stop.sourceEvidenceRefs) ? stop.sourceEvidenceRefs : [],
  };
}

function visitEntity(trip: Trip, visit: Visit): ScopeEntity {
  const item = visitItem(trip, visit);
  return {
    name: visitDisplayName(trip, visit),
    preciseRefs: collectPreciseRefs(visit),
    fallbackEvidenceIds:
      item !== null && Array.isArray(item.sourceEvidenceRefs) ? item.sourceEvidenceRefs : [],
  };
}

/** 按点位层级构建的提及展示范围 */
export interface EvidenceMentionScope {
  /** 有序证据 id（每条至少含 1 个可见提及；先精确命中后降级命中，保持实体顺序） */
  readonly evidenceIds: readonly string[];
  /** 精确命中的 "evidenceId:mentionId" 集合（命中高亮与聚焦用） */
  readonly preciseRefs: ReadonlySet<string>;
  /** 提及是否可见：精确命中，或所属降级实体的名称匹配 */
  isVisible(evidenceId: string, mention: EvidenceMention): boolean;
}

/**
 * 构建提及展示范围。stop 与 visit 二选一（同 EvidenceSheet 的 stop ?? visit 语义）；
 * 两者都缺时返回空范围（调用方展示空态）。
 */
export function buildEvidenceMentionScope(
  trip: Trip,
  stop: Stop | undefined,
  visit: Visit | undefined,
): EvidenceMentionScope {
  const entities: ScopeEntity[] = [];
  if (stop !== undefined) {
    // Stop 通道：仅自身（规则 3，不合并父 Visit）
    entities.push(stopEntity(trip, stop));
  } else if (visit !== undefined) {
    entities.push(visitEntity(trip, visit));
    // 大景点：合并内部 Stop 的精确 refs（规则 1；备选玩法不是内部行程，不并入）
    if (visit.kind === "large_attraction") {
      const childRefs = Array.isArray(visit.childStopRefs) ? visit.childStopRefs : [];
      for (const stopId of childRefs) {
        const child = trip.stops[stopId];
        if (child !== undefined) entities.push(stopEntity(trip, child));
      }
    }
  }

  const preciseRefs = new Set<string>();
  const evidenceIds: string[] = [];
  const seenEvidence = new Set<string>();
  /** 降级候选：evidenceId → 规范化实体名集合（仅缺精确 ref 的实体贡献） */
  const fallbackNames = new Map<string, Set<string>>();

  for (const entity of entities) {
    // 精确 refs：剔除解析失败或指向已不存在证据/提及的悬空引用
    const resolvable: Array<{ ref: string; evidenceId: string }> = [];
    for (const ref of entity.preciseRefs) {
      const parsed = parseMentionRef(ref);
      if (parsed === null) continue;
      const evidence = trip.evidences[parsed.evidenceId];
      const mentions = evidence !== undefined && Array.isArray(evidence.mentions) ? evidence.mentions : [];
      if (mentions.some((mention) => mention.mentionId === parsed.mentionId)) {
        resolvable.push({ ref, evidenceId: parsed.evidenceId });
      }
    }
    if (resolvable.length > 0) {
      // 有精确 ref：严格模式，本实体不再做名称降级（不混入同证据其他地点）
      for (const { ref, evidenceId } of resolvable) {
        preciseRefs.add(ref);
        if (!seenEvidence.has(evidenceId)) {
          seenEvidence.add(evidenceId);
          evidenceIds.push(evidenceId);
        }
      }
      continue;
    }
    // 降级：缺精确 ref 的实体，把规范化名称登记到其候选证据上
    const normalizedName = normalizeEvidenceName(entity.name);
    if (normalizedName === "") continue;
    for (const evidenceId of entity.fallbackEvidenceIds) {
      if (trip.evidences[evidenceId] === undefined) continue;
      let names = fallbackNames.get(evidenceId);
      if (names === undefined) {
        names = new Set<string>();
        fallbackNames.set(evidenceId, names);
      }
      names.add(normalizedName);
    }
  }

  // 降级证据：候选里至少 1 个提及名称命中才进入展示序列（保持候选顺序，去重）
  for (const [evidenceId, names] of fallbackNames) {
    const evidence = trip.evidences[evidenceId];
    if (evidence === undefined || !Array.isArray(evidence.mentions)) continue;
    const matched = evidence.mentions.some((mention) => mentionNameMatches(mention, names));
    if (matched && !seenEvidence.has(evidenceId)) {
      seenEvidence.add(evidenceId);
      evidenceIds.push(evidenceId);
    }
  }

  return {
    evidenceIds,
    preciseRefs,
    isVisible(evidenceId: string, mention: EvidenceMention): boolean {
      if (preciseRefs.has(`${evidenceId}:${mention.mentionId}`)) return true;
      const names = fallbackNames.get(evidenceId);
      if (names === undefined) return false;
      return mentionNameMatches(mention, names);
    },
  };
}

/** mention 的 extractedName 是否命中任一降级实体名（规范化匹配） */
function mentionNameMatches(mention: EvidenceMention, names: Set<string>): boolean {
  const extracted = normalizeEvidenceName(mention.extractedName ?? "");
  if (extracted === "") return false;
  for (const name of names) {
    if (fallbackNameMatches(name, extracted)) return true;
  }
  return false;
}
