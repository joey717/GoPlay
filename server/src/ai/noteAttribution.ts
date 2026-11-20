/**
 * Task #287：note 级 tips/pitfalls 的确定性归属判定与去重后处理。
 * Task #300：归属下沉——quote 明确指向已抽取的 in_attraction 子景点时归属下沉。
 *
 * PD 归属口径（原话意译）：
 * "有的攻略笔记全篇都在说一个大景点，那么这些笔记级信息也是在说这个大景点的"
 * — 单景点笔记的 note 级建议归属该大景点（entity=该景点）。
 *
 * Task #300 细化（PD 2026-10-30，源自 E9 YLW-06）：
 * 收敛到 canonical 后，若 note_tip 的 quote/name 文本明确命中该景点下已抽取的某个
 * in_attraction 子景点名（经 resolvePoiAlias 归一后比对），归属下沉到该子景点。
 * - 恰好 1 个子景点命中 → 下沉
 * - 0 个命中 → 保持归父卡
 * - ≥2 个命中 → 歧义，保守归父卡（记日志）
 * - 下沉后不新建 Item/Visit，只改归属指向已存在的 in_attraction 实体
 *
 * 判定规则（确定性优先）：
 * 1. 收集 POI 条目（attraction + in_attraction）的名称集合；
 * 2. 对 attraction 条目取 name、对 in_attraction 条目取 parentAttraction；
 * 3. 全部经 resolvePoiAlias 归一化后去重；
 * 4. 若恰好收敛到 1 个 canonical → 单景点笔记 → note_tip 的 parentAttraction 设为该 canonical；
 *    4a. (Task #300) 在设为 canonical 前，检查 quote/name 是否命中唯一子景点 → 下沉
 * 5. 多景点笔记 → 保留模型填写的 parentAttraction（模型从上下文推断归属），null 表示 trip 级。
 *
 * 去重规则：
 * - note_tip.quote 与某 POI 条目 quote 的 bigram Dice 相似度 ≥ DEDUP_THRESHOLD → 删除
 *   （该信息已被 POI 条目承载，无需重复 surface）；
 * - 阈值 0.6 高于 E9 TEXT_HIT_THRESHOLD(0.3)，避免误删语义不同的条目。
 */

import { normalizePoiNameBase, resolvePoiAlias } from "@goplay/shared";
import type { ParsedEntry } from "./assemble.js";

// ===== 文本相似度（bigram Dice，与 eval/harness/e9Recall.ts 同口径） =====

const BRACKET_CONTENT_RE = /[（(【\[{][^）)】\]}]*[）)】\]}]/g;

function normalizeForSim(raw: string): string {
  return raw
    .replace(BRACKET_CONTENT_RE, "")
    .replace(/[\s·、，。,.:：;；!！?？"'"'()（）\[\]【】{}]/g, "")
    .toLowerCase();
}

function bigrams(text: string): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i < text.length - 1; i++) grams.add(text.slice(i, i + 2));
  return grams;
}

/** 归一化 bigram Dice 相似度（0..1）；与 e9Recall.textSimilarity 同口径 */
export function textSimilarity(left: string, right: string): number {
  const a = normalizeForSim(left);
  const b = normalizeForSim(right);
  if (a === "" || b === "") return 0;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let shared = 0;
  for (const gram of ga) if (gb.has(gram)) shared++;
  return (2 * shared) / (ga.size + gb.size);
}

/** note_tip 与 POI 条目 quote 的去重阈值（高于此值视为重复，删除 note_tip） */
export const DEDUP_THRESHOLD = 0.6;

// ===== 归属判定 =====

/**
 * 从 POI 条目集合中提取"根景点"名称集：
 * - type=attraction → name 本身
 * - type=in_attraction → parentAttraction（已知非 null，normalizeParsedEntry 保证）
 * 全部经 resolvePoiAlias 归一后去重。
 */
export function extractRootCanonicals(entries: readonly ParsedEntry[]): Set<string> {
  const canonicals = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "note_tip") continue;
    if (entry.type === "attraction") {
      const resolved = resolvePoiAlias(entry.name);
      if (resolved !== "") canonicals.add(resolved);
    } else if (entry.type === "in_attraction" && entry.parentAttraction !== null) {
      const resolved = resolvePoiAlias(entry.parentAttraction);
      if (resolved !== "") canonicals.add(resolved);
    }
  }
  return canonicals;
}

/**
 * 判定笔记是否为"单景点笔记"：
 * POI 条目的根景点经归一后恰好收敛到 1 个 canonical。
 * 返回该 canonical 名（单景点）或 null（多景点/无 POI）。
 */
export function detectSingleAttraction(entries: readonly ParsedEntry[]): string | null {
  const canonicals = extractRootCanonicals(entries);
  if (canonicals.size === 1) {
    return [...canonicals][0]!;
  }
  return null;
}

// ===== Task #300：note_tip 归属下沉（quote 明确指向 in_attraction 子景点时） =====

/**
 * 收集单景点笔记中属于该 canonical 的 in_attraction 子景点名称集合。
 * 返回 Map<resolvedCanonical, rawName[]>：同一 resolved canonical 可能有多个表面名。
 */
export function collectSubSpotNames(
  poiEntries: readonly ParsedEntry[],
  singleCanonical: string,
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const entry of poiEntries) {
    if (entry.type !== "in_attraction" || entry.parentAttraction === null) continue;
    const parentResolved = resolvePoiAlias(entry.parentAttraction);
    if (parentResolved !== singleCanonical) continue;
    const subResolved = resolvePoiAlias(entry.name);
    if (subResolved === "" || subResolved === singleCanonical) continue; // 子景点不能与父同名
    const existing = groups.get(subResolved);
    if (existing) {
      if (!existing.includes(entry.name)) existing.push(entry.name);
    } else {
      groups.set(subResolved, [entry.name]);
    }
  }
  return groups;
}

/**
 * Task #300 下沉判定：note_tip 的 quote/name 是否明确命中唯一子景点。
 *
 * 匹配规则：
 * - 对 subSpotGroups 中每个 resolved canonical 及其所有 raw 表面名，
 *   经 normalizePoiNameBase 归一后检查是否为 quote/name 文本的子串；
 * - 同一 resolved canonical 下多个表面名任一命中只算 1 次匹配；
 * - 恰好 1 个 resolved canonical 命中 → 下沉目标；
 * - 0 个命中 → 归父卡（返回 null）；
 * - ≥2 个命中 → 歧义，保守归父卡（记日志，返回 null）。
 */
export function findSubSpotSinkTarget(
  tipQuote: string,
  tipName: string,
  subSpotGroups: ReadonlyMap<string, string[]>,
): string | null {
  if (subSpotGroups.size === 0) return null;

  // 归一化 tip 文本用于子串匹配（去括号内容 + 去空白，与 resolvePoiAlias 同口径基础）
  const normalizedQuote = normalizePoiNameBase(tipQuote);
  const normalizedName = normalizePoiNameBase(tipName);
  const searchText = `${normalizedQuote}\u0000${normalizedName}`; // 拼接两段，\0 防跨界假命中

  const matched: string[] = [];
  for (const [resolvedCanonical, rawNames] of subSpotGroups) {
    let hit = false;
    for (const rawName of rawNames) {
      const forms = new Set([normalizePoiNameBase(rawName), resolvedCanonical]);
      for (const form of forms) {
        if (form.length < 2) continue; // 单字不做子串匹配（误伤率太高）
        if (searchText.includes(form)) {
          hit = true;
          break;
        }
      }
      if (hit) break;
    }
    if (hit) matched.push(resolvedCanonical);
  }

  if (matched.length === 1) return matched[0]!;
  if (matched.length > 1) {
    console.log(
      `[AI] Task #300 归属下沉歧义：note_tip「${tipName}」quote 同时命中 ${matched.length} 个子景点` +
        `（${matched.join("、")}），保守归父卡`,
    );
    return null;
  }
  return null;
}

/**
 * note_tip 去重：与 POI 条目的 quote 高度重叠时删除。
 * 比较 note_tip.quote vs 每个 POI entry 的 quote 和 summary，取最大 sim；
 * sim ≥ DEDUP_THRESHOLD → 该 note_tip 视为重复，丢弃。
 */
export function deduplicateNoteTips(
  noteTips: ParsedEntry[],
  poiEntries: readonly ParsedEntry[],
): ParsedEntry[] {
  if (noteTips.length === 0 || poiEntries.length === 0) return noteTips;
  return noteTips.filter((tip) => {
    const tipQuote = tip.quote || tip.summary;
    if (tipQuote === "") return true; // 空 quote 不去重（保留）
    for (const poi of poiEntries) {
      const poiQuote = poi.quote || "";
      const poiSummary = poi.summary || "";
      const sim = Math.max(
        textSimilarity(tipQuote, poiQuote),
        textSimilarity(tipQuote, poiSummary),
      );
      if (sim >= DEDUP_THRESHOLD) {
        console.log(
          `[AI] Task #287 去重：note_tip「${tip.name}」与 POI 条目「${poi.name}」重叠 sim=${sim.toFixed(3)}≥${DEDUP_THRESHOLD}，丢弃`,
        );
        return false;
      }
    }
    return true;
  });
}

/**
 * Task #287 归属后处理（确定性）：
 * 1. 分离 note_tip 与 POI 条目
 * 2. 去重（note_tip.quote 与 POI quote 高度重叠 → 删除）
 * 3. 单景点笔记 → 所有 note_tip.parentAttraction 设为 canonical
 *    Task #300 细化：若 note_tip 的 quote/name 明确命中已抽取的某个 in_attraction
 *    子景点名（经 resolvePoiAlias 归一后比对），归属下沉到该子景点
 * 4. 多景点 → 保留模型填写的 parentAttraction
 * 返回处理后的完整条目数组（POI + note_tip），保持原始相对顺序。
 */
export function attributeNoteTips(entries: ParsedEntry[]): ParsedEntry[] {
  const poiEntries = entries.filter((e) => e.type !== "note_tip");
  const noteTips = entries.filter((e) => e.type === "note_tip");

  if (noteTips.length === 0) return entries;

  // 去重
  const deduped = deduplicateNoteTips(noteTips, poiEntries);

  // 归属判定
  const singleCanonical = detectSingleAttraction(poiEntries);
  if (singleCanonical !== null) {
    // Task #300：收集子景点用于下沉判定
    const subSpotGroups = collectSubSpotNames(poiEntries, singleCanonical);
    let sinkCount = 0;

    console.log(
      `[AI] Task #287 单景点笔记归属：canonical=「${singleCanonical}」，` +
        `${deduped.length} 条 note_tip 统一归属` +
        (subSpotGroups.size > 0 ? `（Task #300：${subSpotGroups.size} 个子景点参与下沉判定）` : ""),
    );
    for (const tip of deduped) {
      // Task #300：尝试下沉到子景点
      const sinkTarget = subSpotGroups.size > 0
        ? findSubSpotSinkTarget(tip.quote || tip.summary, tip.name, subSpotGroups)
        : null;

      const attributionName = sinkTarget ?? singleCanonical;
      if (sinkTarget !== null) {
        sinkCount++;
        console.log(
          `[AI] Task #300 归属下沉：note_tip「${tip.name}」→ 子景点「${sinkTarget}」` +
            `（quote 明确命中）`,
        );
      }

      tip.parentAttraction = attributionName;
      // 同步 name 为归属景点名（E9 matcher 的 entity 校验与展示均依赖此字段）
      // 保留原始描述性 name 到 summary 前缀（不丢信息）
      if (!tip.summary.includes(tip.name)) {
        tip.summary = `${tip.name}：${tip.summary}`;
      }
      tip.name = attributionName;
    }
    if (sinkCount > 0) {
      console.log(
        `[AI] Task #300 下沉汇总：${sinkCount}/${deduped.length} 条 note_tip 归属下沉到子景点`,
      );
    }
  } else {
    console.log(
      `[AI] Task #287 多景点笔记：${deduped.length} 条 note_tip 保留模型归属` +
        `（有 parentAttraction ${deduped.filter((t) => t.parentAttraction !== null).length} 条）`,
    );
  }

  // 重建完整数组：保持 POI 条目在前、note_tip 在后的稳定顺序
  return [...poiEntries, ...deduped];
}
