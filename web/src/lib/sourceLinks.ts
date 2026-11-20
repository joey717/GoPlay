/**
 * 任务 124：按目标实体解析「外部原文链接」来源（纯函数，灰色原文入口消费）。
 *
 * 与 EvidenceSheet 的提及范围（buildEvidenceMentionScope）共用同一套层级规则：
 * - 大景点 Visit：自身 + 已归属内部玩法（childStopRefs）相关证据的来源；备选玩法不并入；
 * - 普通 Visit / Stop：仅自身相关证据的来源（Stop 不合并父 Visit）；
 * - 旧数据实体缺精确 ref 时沿用名称降级——「能回看的证据」与「能打开的原链」
 *   永远是同一批，不会出现入口链到一篇与该点位无关的攻略。
 *
 * 链接解析：范围内证据 → 归属 GuideSource（按 evidenceRefs 编组）→ sourceUrl，
 * 缺失时回退 canonicalUrl；两者都没有（text / images 来源）视为无外部链接，
 * 不产生条目。灰色入口只承担「打开用户导入的外部原链」职责，无链接时由调用方
 * 整体隐藏，不再降级打开提炼证据面板（避免与绿色 snippet 亮点重复）。
 * 结果按 URL 去重（同链多来源只保留首个），并保留来源展示标题（sourceTitle
 * 同口径：title > sourceUrl > 输入形态兜底）。
 */

import type { GuideSource, Stop, Trip, Visit } from "@goplay/shared";
import { buildEvidenceMentionScope } from "./evidenceScope";
import { sourceTitle } from "../components/GuideSourceList";

/** 目标实体关联的一个外部原文链接（已解析 + 去重后的稳定条目） */
export interface EntitySourceLink {
  /** 首个命中来源的 id（列表渲染 key / 排查用） */
  readonly sourceId: string;
  /** 来源展示标题（与来源列表、EvidenceSheet 来源 tab 同口径） */
  readonly title: string;
  /** 外部原链：sourceUrl 优先，缺失时 canonicalUrl */
  readonly url: string;
}

/** 非空 URL 才算外部链接；空白串按缺失处理（不产生只含空白的可点入口） */
function nonEmptyUrl(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed !== "" ? trimmed : null;
}

/** evidenceId → 归属 GuideSource（来源只编组不复制正文，与 EvidenceSheet 同规则） */
function sourceByEvidenceMap(trip: Trip): Map<string, GuideSource> {
  const map = new Map<string, GuideSource>();
  for (const source of Object.values(trip.guideSources ?? {})) {
    if (source === null || typeof source !== "object") continue;
    const evidenceRefs = Array.isArray(source.evidenceRefs) ? source.evidenceRefs : [];
    for (const evidenceId of evidenceRefs) map.set(evidenceId, source);
  }
  return map;
}

/**
 * 解析目标实体（stop / visit 二选一，同 buildEvidenceMentionScope 语义）关联的
 * 外部原文链接列表。返回顺序跟随证据范围顺序（先父后子），已按 URL 去重。
 */
export function resolveEntitySourceLinks(
  trip: Trip,
  stop?: Stop,
  visit?: Visit,
): EntitySourceLink[] {
  const scope = buildEvidenceMentionScope(trip, stop, visit);
  const sourceByEvidence = sourceByEvidenceMap(trip);

  const links: EntitySourceLink[] = [];
  const seenUrls = new Set<string>();
  for (const evidenceId of scope.evidenceIds) {
    const source = sourceByEvidence.get(evidenceId);
    // 早期素材（证据无来源编组）没有可打开的外部原链
    if (source === undefined) continue;
    const url = nonEmptyUrl(source.sourceUrl) ?? nonEmptyUrl(source.canonicalUrl);
    if (url === null || seenUrls.has(url)) continue;
    seenUrls.add(url);
    links.push({ sourceId: source.sourceId, title: sourceTitle(source), url });
  }
  return links;
}
