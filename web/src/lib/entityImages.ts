/**
 * 任务 196：实体页码关联图解析（web 读取侧，纯函数）。
 *
 * 复用任务 116 的 buildEvidenceMentionScope 口径（配图与证据面板展示同一批提及）：
 * 实体关联提及中带 pageRefs 的，逐页解析其所属 GuideSource 的原图路径
 * （shared resolveMentionPageImages：槽位 ready + assetPath + 同来源才绑定；
 * 缺槽 / 越界 / 下载失败 / 预筛跳过 / 顺序不可靠一律跳过，绝不前移或取相邻图）。
 *
 * 无页码（旧证据 pageRefs 缺失）→ 自然无绑定，调用方沿用现有无图兜底。
 */

import type { Stop, Trip, Visit } from "@goplay/shared";
import { resolveMentionPageImages } from "@goplay/shared";
import { buildEvidenceMentionScope } from "./evidenceScope";

/** 实体的页码关联图集合（受控路径，渲染按 /api/${path} 读取） */
export interface EntityPageImages {
  readonly assetPaths: readonly string[];
  readonly firstAssetPath: string | null;
}

const EMPTY_ENTITY_PAGE_IMAGES: EntityPageImages = { assetPaths: [], firstAssetPath: null };

/**
 * 解析实体（Stop 或 Visit）的全部有效页码关联图：
 * 提及范围与 EvidenceSheet 一致（精确 ref 优先 + 旧数据名称降级），
 * 按证据顺序收集，路径去重。
 */
export function resolveEntityPageImages(
  trip: Trip,
  stop: Stop | undefined,
  visit: Visit | undefined,
): EntityPageImages {
  if (stop === undefined && visit === undefined) return EMPTY_ENTITY_PAGE_IMAGES;
  const scope = buildEvidenceMentionScope(trip, stop, visit);
  const assetPaths: string[] = [];
  const seen = new Set<string>();
  for (const evidenceId of scope.evidenceIds) {
    const evidence = trip.evidences[evidenceId];
    const mentions = Array.isArray(evidence?.mentions) ? evidence.mentions : [];
    for (const mention of mentions) {
      if (!scope.isVisible(evidenceId, mention)) continue;
      const resolved = resolveMentionPageImages(trip, `${evidenceId}:${mention.mentionId}`);
      for (const assetPath of resolved.assetPaths) {
        if (!seen.has(assetPath)) {
          seen.add(assetPath);
          assetPaths.push(assetPath);
        }
      }
    }
  }
  return { assetPaths, firstAssetPath: assetPaths[0] ?? null };
}
