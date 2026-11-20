/**
 * Task #212：攻略亮点 snippets 与原文引用去重（shared 纯函数）。
 *
 * 背景：用户对同一篇攻略多次提交草案并应用（或删除来源后重新添加），
 * Visit/Stop 上会累积重复的亮点与原文引用——
 * - 完全相同的文本（AI 生成常带随机空格，如「可以 走过江龙索桥」vs「可以走过江龙索桥」）；
 * - 高度相似的文本（97% 重合，如「丹姐清补凉甜度恰到好处，椰子香…」vs「…纯椰子香…」）；
 * - 同一句原文被两次截取 / 改写的尾句差异（如「三和风味馆招牌马头鱼鲜嫩入味，强烈安利」
 *   vs「…，尖椒炒蛋巨下饭」，重合率仅 0.79 但公共前缀 15 字）；
 * - 实体 sourceMentionRefs 中同一来源同一句提及被重复引用（含早期无来源数据的重复证据提及）。
 *
 * 两层用法：
 * - 写入防重：server applyGuideDraft 挂载 snippets 时用 areSnippetEntriesSimilar 拦截；
 * - 存量清理：deduplicateSnippets / deduplicateStopSnippets 对既有实体一次清洗
 *   （幂等、纯函数、无变化返回原引用），由一次性修复脚本或写路径收尾调用。
 *
 * 判定口径（与现场数据对齐）：
 * - 文本归一化 = 去除全部空白 + 小写（空格是 AI 生成噪声的主要来源）；
 * - 相似度 = 归一化后最长公共子序列长度 / 较短串长度（容忍插词、空格与局部改写，
 *   现场五组重复该比率 0.91–1.00；真正不同的亮点远低于阈值）；
 * - 基础阈值 0.9 且较短串 ≥ 6 字（与引用无关），防止「去石斑」vs「石斑鱼」这类超短句误杀；
 * - 引用同一 sourceMentionRef（同一 evidence + mention = 同一句原文）时放宽判定：
 *   重合率 ≥ 0.8，或公共前缀 ≥ 10 字且覆盖较短串 ≥ 60%（同句两次截取的后半句
 *   各自补细节，整体 LCS 会被拉低而漏判）；跨提及一律不放宽；
 * - Task #339 第三档（仅存量清洗 / 写入防重提供 trip 上下文时生效）：同一篇攻略
 *   （同 guide source）+ 同一实体 + 引用组合不完全相同 + 重合率 ≥ 0.5 也判相似
 *   （玻璃栈道型：同攻略同景点两段相似表述 0.625）；refs 完全相同的同提及对
 *   与跨来源对不入本档（见 SNIPPET_CROSS_SOURCE_THRESHOLD 注释）；
 * - 组内保留「更可信、更完整」的代表：引用指向 active 来源优先（删除来源后重加的
 *   旧引用让位，EvidenceSheet 重复来源 tab 随之消失）→ 原文更长 → 引用更多 → 先到先得；
 * - sourceMentionRefs 组合键 = 归属来源 + 归一化提及文本（「同一 guideSourceId +
 *   同一 mentionIndex 只留一条」的语义落地：同一篇攻略里同一句提及的引用只保留一条；
 *   同来源不同证据里文本不同的提及各自保留，不误删并行证据）。悬空 / 无法解析的
 *   引用一律原样保留（不丢数据，交由既有一致性校验报告）。
 *
 * 不做：不合并重复的 guideSource 记录本身（来源编组是另一层语义）；不触碰
 * optionGroups；不修改 mention / evidence 原始数据。
 */

import type { GuideSnippet, Stop, Trip, Visit } from "../types/index.js";
import { parseMentionRef, resolveMentionRef } from "./index.js";

/** 相似判定阈值：归一化后公共子序列重合率 ≥ 0.9 视为同一亮点的改写（与引用无关） */
export const SNIPPET_SIMILARITY_THRESHOLD = 0.9;

/** 相似判定的最短归一化长度：低于该长度的串只有完全相等才去重（防超短句误杀） */
export const SNIPPET_SIMILAR_MIN_CHARS = 6;

/**
 * 同一提及内的放宽阈值：两条 snippet 引用同一 sourceMentionRef（同一句原文）时，
 * 重合率 ≥ 0.8 也算同一亮点。取样全量 trip 数据：同提及对的重合率为 0.79 / 0.80 /
 * 0.65 / 0.45 / 0.25 …，其中 0.80（「观光车1号线上牛王岭，是看日落的观景高地」vs
 * 「牛王岭坐观光车1号线可达，是看日落的观景高地」，语序互换）与 0.79（三和风味馆）
 * 是明确的重复，0.45 及以下各自承载不同信息（椰林沙滩排队 vs 珊瑚墙路径）。
 * 阈值取 0.8：吃掉语序互换型，不越过 0.45 的信息差异化区间；跨提及不放宽。
 */
export const SNIPPET_SAME_MENTION_THRESHOLD = 0.8;

/**
 * 同一提及内的公共前缀判定：归一化后公共前缀 ≥ 10 字且覆盖较短串 ≥ 60%。
 * 现场「三和风味馆招牌马头鱼鲜嫩入味，强烈安利」vs「…，尖椒炒蛋巨下饭」公共前缀
 * 15 字 / 较短串 19 字（0.79），LCS 只差临界一点，前缀口径是同一句两次截取的直接证据。
 */
export const SNIPPET_SAME_MENTION_PREFIX_MIN_CHARS = 10;

/** 同一提及内公共前缀覆盖较短串的最低占比（见上：15/19 ≈ 0.79，取 0.6 留足余量） */
export const SNIPPET_SAME_MENTION_PREFIX_MIN_RATIO = 0.6;

/**
 * Task #339 第三档：同一篇攻略（同 guide source）内、同一归属景点（同实体）上、
 * 引用组合**不完全相同**（并非同一句提及的重复抽取）的两条 snippet，
 * 归一化 LCS 重合率 ≥ 0.5 判相似 → 收敛为 1 条（保留更长者）。
 *
 * 现场案例（trip 0a27f726 玻璃栈道）：「大雾天上去白茫茫拍不到，钱就白花」
 * refs=[m6] vs「大雾天玻璃栈道白茫茫拍不到，谨慎购买」refs=[m6,m16]，
 * 同一篇攻略里同一景点的两段相似表述，重合率 0.625——基础档（0.9）与放宽档
 * （同引用对需 ≥ 0.8）都拦不住，PD 拍板仅当内容相似时收敛为 1 条。
 *
 * 阈值 0.5 依据：本案例 0.625 需命中；历史跨来源「不同信息」对全部 ≤ 0.17
 * 远离阈值；refs 完全相同的同提及对（后海村 0.65、太阳湾公路 0.588、鹿回头
 * 0.563、南山 0.529）刻意**不入本档**——同一句提及的两次抽取沿用放宽档既有
 * 取舍（0.65 及以下不合并），本档仅对引用组合不同的对生效（leader 2026-11-03 批准）。
 */
export const SNIPPET_CROSS_SOURCE_THRESHOLD = 0.5;

/** 文本归一化：去除全部空白字符 + 小写（AI 生成文本常带随机空格） */
export function normalizeSnippetText(text: string): string {
  return typeof text === "string" ? text.replace(/\s+/g, "").toLowerCase() : "";
}

/**
 * 归一化后相似度：最长公共子序列长度 / 较短串长度（0..1）。
 * 用子序列而非子串：现场重复形态是「同一句话 + 空格 / 插词 / 局部改写」，
 * 子序列口径恰好覆盖（0.91–1.00），且不会把毫无关系的句子误判为相似。
 * 任一串归一化后为空返回 0。
 */
export function snippetSimilarity(a: string, b: string): number {
  const na = normalizeSnippetText(a);
  const nb = normalizeSnippetText(b);
  const m = na.length;
  const n = nb.length;
  if (m === 0 || n === 0) return 0;
  // 滚动数组 DP：lcs[i][j] = na[i-1]===nb[j-1] ? lcs[i-1][j-1]+1 : max(lcs[i-1][j], lcs[i][j-1])
  let prev = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i += 1) {
    const cur = new Array<number>(n + 1).fill(0);
    for (let j = 1; j <= n; j += 1) {
      cur[j] = na[i - 1] === nb[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[n] / Math.min(m, n);
}

/**
 * 两条亮点文本是否近似重复（纯文本口径）：归一化完全相等，或重合率 ≥ 0.9 且较短串 ≥ 6 字。
 * 无引用上下文时使用；需要同提及放宽判定时用 areSnippetEntriesSimilar。
 */
export function areSnippetsSimilar(a: string, b: string): boolean {
  const na = normalizeSnippetText(a);
  const nb = normalizeSnippetText(b);
  if (na === nb) return true;
  if (Math.min(na.length, nb.length) < SNIPPET_SIMILAR_MIN_CHARS) return false;
  return snippetSimilarity(na, nb) >= SNIPPET_SIMILARITY_THRESHOLD;
}

/** 归一化文本的公共前缀长度（调用方保证入参已归一化） */
function commonPrefixLength(na: string, nb: string): number {
  const limit = Math.min(na.length, nb.length);
  let i = 0;
  while (i < limit && na[i] === nb[i]) i += 1;
  return i;
}

/** 两组引用是否有交集（同一 evidenceId + mentionId = 同一句原文/同一张图区域） */
export function shareMentionRef(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return false;
  const set = new Set(a);
  return b.some((ref) => set.has(ref));
}

/** snippet 相似判定的最小输入：文本 + 原文引用 */
export interface SnippetSimilarityInput {
  text: string;
  sourceMentionRefs?: readonly string[] | null;
}

/**
 * 两条亮点（文本 + 原文引用）是否近似重复：
 * 1. 基础文本口径命中（全等 / 重合率 ≥ 0.9 且较短串 ≥ 6 字）→ 重复；
 * 2. 引用同一 sourceMentionRef 时放宽（同句原文的两次改写）：
 *    a. 重合率 ≥ 0.8（语序互换型）；
 *    b. 公共前缀 ≥ 10 字且覆盖较短串 ≥ 60%（同句两次截取，后半句各补细节）。
 * 跨提及一律只走基础口径，避免把两处不同证据的并行亮点合并。
 */
export function areSnippetEntriesSimilar(a: SnippetSimilarityInput, b: SnippetSimilarityInput): boolean {
  if (areSnippetsSimilar(a.text, b.text)) return true;
  if (!shareMentionRef(a.sourceMentionRefs, b.sourceMentionRefs)) return false;
  const na = normalizeSnippetText(a.text);
  const nb = normalizeSnippetText(b.text);
  const minLen = Math.min(na.length, nb.length);
  if (minLen < SNIPPET_SIMILAR_MIN_CHARS) return false;
  if (snippetSimilarity(na, nb) >= SNIPPET_SAME_MENTION_THRESHOLD) return true;
  const prefix = commonPrefixLength(na, nb);
  return (
    prefix >= SNIPPET_SAME_MENTION_PREFIX_MIN_CHARS &&
    prefix / minLen >= SNIPPET_SAME_MENTION_PREFIX_MIN_RATIO
  );
}

/**
 * Task #339 第三档判定：同一篇攻略（同 guide source）+ 同一归属景点（调用方保证
 * 两条 snippet 挂在同一实体上）+ 引用组合不完全相同 + 归一化 LCS ≥ 0.5 → 相似。
 * - 无 trip 上下文（无法归属来源）恒 false；
 * - 任一侧引用为空 / 悬空（解析不出归属来源）恒 false（不丢数据）；
 * - 两侧引用组合完全相同 = 同一句提及的重复抽取，属放宽档既有领域（同提及
 *   0.65 后海村对刻意不合并的历史取舍），本档不介入；
 * - 跨来源（无共同归属 sourceId）恒 false：不同攻略的并行证据不合并。
 */
export function areSameSourceSnippetsSimilar(
  a: SnippetSimilarityInput,
  b: SnippetSimilarityInput,
  trip: Trip | undefined,
): boolean {
  if (trip === undefined) return false;
  const refsA = Array.isArray(a.sourceMentionRefs) ? a.sourceMentionRefs : [];
  const refsB = Array.isArray(b.sourceMentionRefs) ? b.sourceMentionRefs : [];
  if (refsA.length === 0 || refsB.length === 0) return false;
  if (sameRefSet(refsA, refsB)) return false;
  const sourcesA = guideSourceIdsForRefs(trip, refsA);
  if (sourcesA.size === 0) return false;
  const sourcesB = guideSourceIdsForRefs(trip, refsB);
  let sameSource = false;
  for (const sourceId of sourcesA) {
    if (sourcesB.has(sourceId)) {
      sameSource = true;
      break;
    }
  }
  if (!sameSource) return false;
  const na = normalizeSnippetText(a.text);
  const nb = normalizeSnippetText(b.text);
  if (Math.min(na.length, nb.length) < SNIPPET_SIMILAR_MIN_CHARS) return false;
  return snippetSimilarity(na, nb) >= SNIPPET_CROSS_SOURCE_THRESHOLD;
}

/**
 * 引用组里是否至少有一条指向 active 来源（active 缺省视为 true）。
 * 无 trip 上下文时恒为 false（代表挑选退化为文本长度口径）。
 */
function refsHaveActiveSource(trip: Trip | undefined, refs: string[]): boolean {
  if (trip === undefined) return false;
  for (const ref of refs) {
    const parsed = parseMentionRef(ref);
    if (parsed === null) continue;
    for (const source of Object.values(trip.guideSources ?? {})) {
      if (source === null || source === undefined) continue;
      if (Array.isArray(source.evidenceRefs) && source.evidenceRefs.includes(parsed.evidenceId)) {
        if (source.active !== false) return true;
      }
    }
  }
  return false;
}

/**
 * 引用的身份键（用户口径「同一 guideSourceId + 同一 mentionIndex 只留一条」的落地）：
 * 解析 ref → 提及 → 「归属来源 sourceId + 归一化提及文本」。
 * - 同一篇攻略（同来源）里同一句提及在多个证据中重复提取时键相同 → 去重；
 * - 同来源不同提及（文本不同）键不同 → 保留（不误删并行证据）；
 * - 早期无来源归属的数据退化为仅文本键（同句提及跨证据合并）；
 * - 悬空引用 / 无法解析 / 提及无文本 → null（调用方原样保留，不丢数据）。
 */
function mentionRefIdentityKey(trip: Trip | undefined, ref: string): string | null {
  if (trip === undefined) return null;
  if (parseMentionRef(ref) === null) return null;
  const resolved = resolveMentionRef(trip, ref);
  if (resolved === null) return null;
  const rawText = resolved.mention.text !== "" ? resolved.mention.text : resolved.mention.quoteText;
  const text = normalizeSnippetText(rawText);
  if (text === "") return null;
  let sourceId = "";
  for (const source of Object.values(trip.guideSources ?? {})) {
    if (source === null || source === undefined) continue;
    if (Array.isArray(source.evidenceRefs) && source.evidenceRefs.includes(resolved.evidenceId)) {
      sourceId = source.sourceId;
      break;
    }
  }
  return `${sourceId}|${text}`;
}

/** 引用列表按键去重：null 键原样保留，同键只留首个 */
function dedupeMentionRefs(refs: string[], trip: Trip | undefined): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const ref of refs) {
    const key = mentionRefIdentityKey(trip, ref);
    if (key !== null) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    kept.push(ref);
  }
  return kept;
}

/** 同组近似重复里挑代表：active 引用优先 → 原文更长 → 引用更多 → 先到先得（稳定） */
function pickRepresentative(a: GuideSnippet, b: GuideSnippet, trip: Trip | undefined): GuideSnippet {
  const aActive = refsHaveActiveSource(trip, a.sourceMentionRefs);
  const bActive = refsHaveActiveSource(trip, b.sourceMentionRefs);
  if (aActive !== bActive) return aActive ? a : b;
  if (a.text.length !== b.text.length) return a.text.length > b.text.length ? a : b;
  if (a.sourceMentionRefs.length !== b.sourceMentionRefs.length) {
    return a.sourceMentionRefs.length > b.sourceMentionRefs.length ? a : b;
  }
  return a;
}

/** 两组引用是否完全相同（集合口径，忽略顺序与重复）：同 = 同一句提及的重复抽取形态 */
function sameRefSet(a: readonly string[], b: readonly string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const ref of setA) {
    if (!setB.has(ref)) return false;
  }
  return true;
}

/** 引用组能解析出的归属 guide source 集合（悬空 / 无归属的引用被忽略） */
function guideSourceIdsForRefs(trip: Trip, refs: readonly string[]): Set<string> {
  const ids = new Set<string>();
  for (const ref of refs) {
    const parsed = parseMentionRef(ref);
    if (parsed === null) continue;
    for (const source of Object.values(trip.guideSources ?? {})) {
      if (source === null || source === undefined) continue;
      if (Array.isArray(source.evidenceRefs) && source.evidenceRefs.includes(parsed.evidenceId)) {
        ids.add(source.sourceId);
      }
    }
  }
  return ids;
}

/** 顺序扫描分组去重：与已保留条目近似重复的归并到该组（代表原位替换，顺序稳定） */
function dedupeSnippetList(
  snippets: GuideSnippet[],
  trip: Trip | undefined,
): { kept: GuideSnippet[]; removed: GuideSnippet[] } {
  const kept: GuideSnippet[] = [];
  const removed: GuideSnippet[] = [];
  for (const snippet of snippets) {
    // Task #339：既有双档（areSnippetEntriesSimilar）之外，提供 trip 上下文时追加
    // 第三档（同来源 + 引用组合不同 + LCS ≥ 0.5）；无 trip 的调用点行为不变
    const twinIndex = kept.findIndex(
      (entry) =>
        areSnippetEntriesSimilar(entry, snippet) ||
        (trip !== undefined && areSameSourceSnippetsSimilar(entry, snippet, trip)),
    );
    if (twinIndex === -1) {
      kept.push(snippet);
      continue;
    }
    const twin = kept[twinIndex];
    const winner = pickRepresentative(twin, snippet, trip);
    kept[twinIndex] = winner;
    removed.push(winner === snippet ? twin : snippet);
  }
  return { kept, removed };
}

/** 实体最小契约：Visit / Stop 共有的攻略挂载字段 */
interface GuideSnippetCarrier {
  guideSnippets?: GuideSnippet[] | null;
  sourceMentionRefs?: string[] | null;
}

/**
 * 对单个实体（Visit / Stop）做一次完整清洗：
 * 1. guideSnippets 近似重复归并（每实体上限内的多余重复条目删除）；
 * 2. 每条 snippet 的 sourceMentionRefs 按身份键去重；
 * 3. 实体级 sourceMentionRefs 按身份键去重。
 * 无任何变化时返回原引用（幂等、调用方可引用比较）；sourceMentionRefs 是
 * v2 契约字段，原有则保持存在（允许清为 []）；guideSnippets 清洗结果非空才写字段
 * （缺失视为空的类型契约不变；去重归并结果必非空，不会产生删空路径）。
 */
function dedupeEntitySnippets<T extends GuideSnippetCarrier>(entity: T, trip?: Trip): T {
  const originalSnippets = Array.isArray(entity.guideSnippets) ? entity.guideSnippets : [];
  const originalRefs = Array.isArray(entity.sourceMentionRefs) ? entity.sourceMentionRefs : [];

  const { kept } = dedupeSnippetList(originalSnippets, trip);
  const cleanedSnippets = kept.map((snippet) => ({
    ...snippet,
    sourceMentionRefs: dedupeMentionRefs(snippet.sourceMentionRefs, trip),
  }));
  const cleanedRefs = dedupeMentionRefs(originalRefs, trip);

  const snippetsChanged = JSON.stringify(cleanedSnippets) !== JSON.stringify(originalSnippets);
  const refsChanged =
    cleanedRefs.length !== originalRefs.length ||
    (originalRefs.length > 0 && !Array.isArray(entity.sourceMentionRefs));
  if (!snippetsChanged && !refsChanged) return entity;

  const next = { ...entity } as T & { guideSnippets?: GuideSnippet[]; sourceMentionRefs?: string[] };
  if (cleanedSnippets.length > 0) next.guideSnippets = cleanedSnippets;
  if (originalRefs.length > 0 || Array.isArray(entity.sourceMentionRefs)) {
    next.sourceMentionRefs = cleanedRefs;
  }
  return next;
}

/**
 * Visit 存量去重（用户指定入口）：清洗 Visit.guideSnippets 与 sourceMentionRefs。
 * @param trip 可选上下文：提供后启用「active 来源优先」与跨证据引用身份判定
 */
export function deduplicateSnippets(visit: Visit, trip?: Trip): Visit {
  return dedupeEntitySnippets(visit, trip);
}

/** Stop 存量去重：与 Visit 同一套判定（Stop 同样挂载 snippets / mention 引用） */
export function deduplicateStopSnippets(stop: Stop, trip?: Trip): Stop {
  return dedupeEntitySnippets(stop, trip);
}

/**
 * Task #339：仅对实体的 guideSnippets 列表做相似合并（三档判定均生效），
 * 保留更长者，winner 的 sourceMentionRefs 原样保留——**不触碰**实体级与
 * snippet 级的引用身份去重（那是 #212 deduplicateSnippets 的另一层语义）。
 * 供 fix-task339 精准收敛相似亮点、不把写盘面扩大到无关的引用清理。
 * 无 snippet 条数变化（无合并）时返回原引用（幂等、可引用比较）。
 */
export function mergeSimilarEntitySnippets<T extends GuideSnippetCarrier>(entity: T, trip?: Trip): T {
  const original = Array.isArray(entity.guideSnippets) ? entity.guideSnippets : [];
  if (original.length === 0) return entity;
  const { kept } = dedupeSnippetList(original, trip);
  if (kept.length === original.length) return entity; // 无合并（dedupeSnippetList 每合并一次净减 1 条）
  const next = { ...entity } as T & { guideSnippets?: GuideSnippet[] };
  next.guideSnippets = kept;
  return next;
}

/* ===== Task #342：行程卡展示层相似亮点聚类（仅渲染收敛，不改数据） =====
 *
 * 背景（PD 拍板 2026-11-04）：过江龙索桥同一实体上「不想花钱排队可走旁边平行木栈道，
 * 景色差不多」vs「索桥20元排队久，可走旁边栈道免费绕过」（实测归一化 LCS 0.421、
 * 最长公共连续段「可走旁边」4 字、占较短串 0.211）是同一条建议的两种完整措辞，
 * 两条引用组合完全相同（同一提及的重复抽取，sim < 0.5 不入 #339 第三档，数据层
 * 刻意保留）。行程卡只展示 1 条 + 诚实标注合并来源；攻略原文 sheet 仍逐条全量展示。
 *
 * 展示层聚类三条件（leader 2026-11-04 拍板，拒绝 [0.42,0.45) 过拟合窄窗）：
 * 1. 引用组合完全相同（同一次提及的重复抽取形态），**或**两侧归属 guide source
 *    均非空且完全不相交（跨来源相似，为将来数据留口）；部分交叠 / 悬空引用不入；
 * 2. 归一化 LCS 重合率 ∈ [0.40, 0.50)：下界吃掉「措辞不同的同一建议」改写型重复
 *    （过江龙 0.421）；上界避开 #339 既有取舍域——同提及对 0.529~0.652（南山 /
 *    太阳湾 / 鹿回头 / 后海村）数据层刻意保留，展示层维持同一口径不合并；
 *    ≥ 0.8 的重复对已由数据层基础 / 放宽档合并，不会以并存形态到达展示层；
 * 3. 最长公共连续段 ≥ 4 字且占较短串比 ≤ 0.25：相似度若集中在一段连续共享子句
 *    （占比高）=「共享子句 + 各自补充不同信息」→ 互补不合并（椰林沙滩 0.455 /
 *    6 字 / 0.273 历史红线对、鹿回头 0.563、南山 0.529）；相似度分散（占比低但
 *    LCS 达标）=「同一条建议的完整改写」→ 合并（过江龙 0.211）。
 *
 * 边界：纯展示口径——数据层三档判定（areSnippetEntriesSimilar /
 * areSameSourceSnippetsSimilar）、planner 写入、#339/#351 存量清理均不消费本函数；
 * 不修改任何 snippet / 引用数据；簇代表取更长文本（等长先到先得，顺序稳定）。
 *
 * Task #351（2026-11-04 PD 裁量「相似的都合并」）后：太阳湾公路 / 鹿回头 /
 * 南山三对已在数据层指名收敛为 1 条，不再以并存形态到达展示层；本聚类只服务
 * 剩余未达数据层阈值的对（如过江龙索桥 0.421 同提及对）。两层各自独立，
 * 判定阈值不因合并联动而改。
 */

/** 展示层聚类 LCS 重合率下界（含）：低于此值的并存条目视为承载不同信息 */
export const SNIPPET_DISPLAY_CLUSTER_SIM_MIN = 0.4;

/**
 * 展示层聚类 LCS 重合率上界（不含）：≥ 0.5 属 #339 既有刻意保留 / 已收敛域，
 * 展示层不另行合并（同一实体上仍并存的两条 ≥0.5 对维持既有展示形态）
 */
export const SNIPPET_DISPLAY_CLUSTER_SIM_MAX = 0.5;

/** 展示层聚类最长公共连续段最小字数：≥4 字才算存在真实共享子句（过江龙「可走旁边」） */
export const SNIPPET_DISPLAY_CLUSTER_COMMON_SUBSTRING_MIN = 4;

/**
 * 展示层聚类最长公共连续段占较短串的最大比例（含）：超过即「共享子句 + 各自补充」
 * 互补形态（椰林沙滩红线对 0.273 恰好越界不合并，过江龙 0.211 在界内）
 */
export const SNIPPET_DISPLAY_CLUSTER_COMMON_SUBSTRING_MAX_RATIO = 0.25;

/** 展示层聚类的一簇结果：代表条目 + 全体成员 + 诚实计数（标注口径见 snippetClusterNote） */
export interface SnippetDisplayCluster {
  /** 簇代表（文本更长者；等长取先到者）：行程卡只渲染这一条 */
  representative: GuideSnippet;
  /** 簇全体成员（保持入参顺序） */
  members: GuideSnippet[];
  /** 簇内可解析出的不同 guide source 数（悬空 / 无归属引用不计；无 trip 上下文恒 0） */
  sourceCount: number;
  /** 簇内合并的 snippet 条数（= members.length；单条簇为 1） */
  mergedCount: number;
  /**
   * 簇内总提及次数（Task #352）：全体成员 sourceMentionRefs 按提及身份键
   * （归属来源 + 归一化提及文本，悬空引用退化为字面 ref）去重后的数量。
   * 同一句原文被重复抽取（refs 完全相同的并存对）只计 1 次提及。
   */
  mentionCount: number;
}

/** 归一化文本的最长公共连续子串长度（与 LCS 子序列口径互补的「共享子句」信号） */
export function longestCommonSubstringLength(a: string, b: string): number {
  const na = normalizeSnippetText(a);
  const nb = normalizeSnippetText(b);
  const m = na.length;
  const n = nb.length;
  if (m === 0 || n === 0) return 0;
  let best = 0;
  let prev = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i += 1) {
    const cur = new Array<number>(n + 1).fill(0);
    for (let j = 1; j <= n; j += 1) {
      if (na[i - 1] === nb[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/**
 * 展示层聚类条件一：引用组合完全相同（集合口径，同一次提及的重复抽取），
 * 或两侧归属 guide source 均非空且完全不相交（跨来源相似）。
 * 部分交叠 / 任一侧解析不出归属来源 → false（不丢信息、不误合并）。
 */
function areDisplayClusterRefCompatible(
  a: SnippetSimilarityInput,
  b: SnippetSimilarityInput,
  trip: Trip | undefined,
): boolean {
  const refsA = Array.isArray(a.sourceMentionRefs) ? a.sourceMentionRefs : [];
  const refsB = Array.isArray(b.sourceMentionRefs) ? b.sourceMentionRefs : [];
  if (sameRefSet(refsA, refsB)) return true;
  if (trip === undefined) return false;
  const sourcesA = guideSourceIdsForRefs(trip, refsA);
  const sourcesB = guideSourceIdsForRefs(trip, refsB);
  if (sourcesA.size === 0 || sourcesB.size === 0) return false;
  for (const sourceId of sourcesA) {
    if (sourcesB.has(sourceId)) return false;
  }
  return true;
}

/**
 * 展示层两条 snippet 是否收敛为一条（Task #342 三条件，见文件段落注释）。
 * 仅供行程卡渲染层消费；数据层去重（写入防重 / 存量清理）一律不使用本判定。
 */
export function areDisplaySimilarSnippets(
  a: SnippetSimilarityInput,
  b: SnippetSimilarityInput,
  trip?: Trip,
): boolean {
  const na = normalizeSnippetText(a.text);
  const nb = normalizeSnippetText(b.text);
  const minLen = Math.min(na.length, nb.length);
  if (minLen < SNIPPET_SIMILAR_MIN_CHARS) return false;
  if (!areDisplayClusterRefCompatible(a, b, trip)) return false;
  const sim = snippetSimilarity(na, nb);
  if (sim < SNIPPET_DISPLAY_CLUSTER_SIM_MIN || sim >= SNIPPET_DISPLAY_CLUSTER_SIM_MAX) return false;
  const substring = longestCommonSubstringLength(na, nb);
  return (
    substring >= SNIPPET_DISPLAY_CLUSTER_COMMON_SUBSTRING_MIN &&
    substring / minLen <= SNIPPET_DISPLAY_CLUSTER_COMMON_SUBSTRING_MAX_RATIO
  );
}

/**
 * 同实体 snippet 列表的展示层聚类：与已有簇的**代表**相似即并入（顺序扫描，
 * 与 dedupeSnippetList 同风格，结果稳定）；每簇返回代表（更长文本）与双计数。
 * 纯函数：不修改入参；无相似对时每条自成一簇（mergedCount=1，渲染层不标注）。
 */
export function clusterSimilarSnippets(
  entries: readonly GuideSnippet[],
  trip?: Trip,
): SnippetDisplayCluster[] {
  const clusters: SnippetDisplayCluster[] = [];
  for (const entry of entries) {
    const target = clusters.find((cluster) =>
      areDisplaySimilarSnippets(cluster.representative, entry, trip),
    );
    if (target === undefined) {
      clusters.push({ representative: entry, members: [entry], sourceCount: 0, mergedCount: 1, mentionCount: 0 });
      continue;
    }
    target.members.push(entry);
    if (entry.text.length > target.representative.text.length) target.representative = entry;
    target.mergedCount = target.members.length;
  }
  for (const cluster of clusters) {
    const allRefs = cluster.members.flatMap((member) => member.sourceMentionRefs);
    if (trip !== undefined) {
      const sources = new Set<string>();
      for (const member of cluster.members) {
        for (const sourceId of guideSourceIdsForRefs(trip, member.sourceMentionRefs)) {
          sources.add(sourceId);
        }
      }
      cluster.sourceCount = sources.size;
      // 提及次数按身份键去重（复用 #212 口径：同来源同句提及跨证据只计 1 次）
      cluster.mentionCount = dedupeMentionRefs(allRefs, trip).length;
    } else {
      // 无 trip 上下文：解析不出提及身份，退化为字面 ref 去重计数
      cluster.mentionCount = new Set(allRefs).size;
    }
  }
  return clusters;
}

/**
 * 簇的诚实标注文案（Task #342 引入；Task #352 PD 新口径改短，处/篇规则）：
 * 以簇内总提及次数 N（mentionCount，同句原文重复抽取只计 1 次）为准——
 * - N ≤ 1（含单条簇、同一句提及的重复抽取并存对）→ null 不标注；
 * - 恰好「每篇攻略各提及一次且 ≥ 2 篇」（N == sourceCount 且 N ≥ 2）
 *   → 「N篇攻略提及」；
 * - 其余（单篇多处提及 / 多篇累计多次 / 来源不可解析）→ 「N处攻略提及」。
 * 文案不带空格装饰，保持最简（如「2处攻略提及」「2篇攻略提及」）。
 */
export function snippetClusterNote(
  cluster: Pick<SnippetDisplayCluster, "sourceCount" | "mentionCount">,
): string | null {
  const mentions = cluster.mentionCount;
  if (mentions < 2) return null;
  if (cluster.sourceCount >= 2 && mentions === cluster.sourceCount) {
    return `${cluster.sourceCount}篇攻略提及`;
  }
  return `${mentions}处攻略提及`;
}
