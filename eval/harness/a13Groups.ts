/**
 * Task #285：A13 实体归一化死判（golden canonicalGroups ＋ merge.ts 聚合层产物）。
 *
 * 口径（用例文档 v1.4 A13 ＋ golden canonicalGroups，PD 2026-10-28 裁定）：
 * - 同实体不同表面串聚合层归一到同一 canonicalId，票数合并不散；
 * - 沧海观景台：同名出现 2 次去重为 1 个实体，散成 2 票 FAIL；
 * - 山顶公园/山顶婚礼草坪组：山顶婚礼草坪==婚礼礼堂大草坪（同一打卡点，属山顶公园范围）；
 *   归到「山顶公园」或「山顶婚礼草坪」任一 canonical 都 PASS、全归山顶公园 PASS、
 *   把『山顶婚礼草坪』与『婚礼礼堂大草坪』拆成两个不同实体 FAIL；
 * - 无 canonical 可归时保留原始串但不散票（同串合并）。
 *
 * 被测面：server/src/guides/merge.ts mergeGuideMentions（B3 聚合层地点去重，
 * nameIndex 走 canonicalPoiMatchKey＝poiAlias 别名折叠）——纯函数，快层可测。
 * 本模块只做「places → canonicalGroups 违规」的死判，归一化表本身不在此扩展
 * （poiAlias.ts 为功能源码，评测侧不私设映射迎合）。
 *
 * Task #286：PD 裁定在功能源码 poiAlias.ts 补「山顶婚礼草坪」「婚礼礼堂大草坪」→
 * 「山顶公园」别名条目后，alias_gap 档由 #285 的 finding 单列转硬断言全绿
 * （runA13 现断言 violations 两档均为 0；回归单测 verify-task233.ts S8）。
 */

import type { MergedPlace } from "../../server/src/guides/merge.js";
import { normalizeSurface, type CanonicalGroup } from "./e9Recall.js";

/** 表面串 → 落位地点 key 集合（一个 surface 落到 ≥2 个地点即散票） */
export type SurfacePlacement = Map<string, Set<string>>;

export interface CanonicalViolation {
  group: string;
  /**
   * 违规形态：
   * - duplicate_split＝同一归一化表面串散到 ≥2 个地点（同名未去重，**真聚合缺陷 → 硬 FAIL**，
   *   如「沧海观景台散成 2 票」；merge.ts nameIndex 本应折叠同串，散了即代码 bug）；
   * - alias_gap＝组内 ≥2 个**不同**归一化表面串未折叠到同一地点（需 poiAlias 别名条目，
   *   如「山顶婚礼草坪/婚礼礼堂大草坪」未建别名）。Task #286 PD 裁定已在功能源码
   *   poiAlias.ts 补齐两条别名 → 本档现为**硬断言**（runA13 断言 aliasGaps===0），
   *   不再是 #285 的 finding 单列；仍保留独立档位以便回归定位（折叠失效即精确报此档）。
   */
  kind: "duplicate_split" | "alias_gap";
  detail: string;
}

/** 从 merge 产物建表面串落位索引：mention.extractedName（原始表面串）与 displayName 都计入 */
export function buildSurfacePlacement(places: readonly MergedPlace[]): SurfacePlacement {
  const placement: SurfacePlacement = new Map();
  const add = (surface: string, key: string): void => {
    const normalized = normalizeSurface(surface);
    if (normalized === "") return;
    const keys = placement.get(normalized) ?? new Set<string>();
    keys.add(key);
    placement.set(normalized, keys);
  };
  for (const place of places) {
    add(place.displayName, place.key);
    for (const mention of place.mentions) {
      const extracted = mention.mention.extractedName;
      if (typeof extracted === "string" && extracted.trim() !== "") add(extracted, place.key);
    }
  }
  return placement;
}

/**
 * canonicalGroups 死判（区分硬 FAIL 与 finding 两档，见 CanonicalViolation.kind）：
 * 1. duplicate_split——组内**同一**归一化表面串落到 ≥2 个不同地点 key（同名散票，真去重缺陷）；
 *    golden「沧海观景台出现 2 次去重为 1，散成 2 票 FAIL」即此档，merge.ts nameIndex 应折叠同串；
 * 2. alias_gap——组内 ≥2 个**不同**归一化表面串未落到同一地点（需别名折叠）；
 *    golden「山顶婚礼草坪==婚礼礼堂大草坪拆成两个实体 FAIL」即此档，归一化表来源＝
 *    poiAlias.ts（功能源码）。Task #286 PD 裁定已补齐别名 → 本档现按硬断言判（aliasGaps===0）。
 * 组内表面串全部落到同一地点 key（含全归 山顶公园、或全归 山顶婚礼草坪/婚礼礼堂大草坪
 * 任一 canonical）→ 无违规 PASS。未出现的表面串不判（golden rawList 覆盖由 E9/S12 管）。
 */
export function checkCanonicalGroupViolations(
  places: readonly MergedPlace[],
  groups: readonly CanonicalGroup[],
): CanonicalViolation[] {
  const placement = buildSurfacePlacement(places);
  const violations: CanonicalViolation[] = [];
  for (const group of groups) {
    const present = group.surfaces
      .map((surface) => ({ surface, norm: normalizeSurface(surface), keys: placement.get(normalizeSurface(surface)) }))
      .filter((entry): entry is { surface: string; norm: string; keys: Set<string> } => entry.keys !== undefined);
    if (present.length === 0) continue;
    // 档 1：同名表面串散到多地点（真去重缺陷，硬 FAIL）
    const duplicated = present.find((entry) => entry.keys.size > 1);
    if (duplicated !== undefined) {
      violations.push({
        group: group.group,
        kind: "duplicate_split",
        detail: `同名表面串「${duplicated.surface}」散到 ${duplicated.keys.size} 个地点（应去重合并为 1）：[${[...duplicated.keys].join(", ")}]`,
      });
      continue;
    }
    // 档 2：组内 ≥2 个不同表面串未折叠到同一地点（别名缺口，finding）
    const distinct = new Set(present.map((entry) => entry.norm));
    const union = new Set<string>();
    for (const entry of present) for (const key of entry.keys) union.add(key);
    if (distinct.size >= 2 && union.size > 1) {
      violations.push({
        group: group.group,
        kind: "alias_gap",
        detail: `组内 ${distinct.size} 个不同表面串未折叠到同一 canonical（需 poiAlias 别名条目，功能源码缺口）：${present
          .map((entry) => `${entry.surface}→[${[...entry.keys].join(", ")}]`)
          .join("；")}`,
      });
    }
  }
  return violations;
}

/** 沧海观景台专项：同名 2 次去重为 1（golden rule 原文的死判表述，报告可读性用） */
export function checkDuplicateSurfaceMerged(
  places: readonly MergedPlace[],
  surface: string,
): { occurrences: number; pass: boolean } {
  const placement = buildSurfacePlacement(places);
  const keys = placement.get(normalizeSurface(surface)) ?? new Set<string>();
  return { occurrences: keys.size, pass: keys.size <= 1 };
}
