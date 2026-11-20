/**
 * Task #285：E9 亮点召回评测（golden fixture v1.1 ＋ 抽取缓存 → recall 纯函数）。
 *
 * 口径（用例文档 v1.4 E9 断言 ＋ golden recall 段，PD 拍板）：
 * - recall ＝ 命中的 expectedClaims 数 / 11，阈值 0.8；
 * - 命中 ＝「实体 + claimKind 语义命中即算；字面不要求逐字相等」；
 * - 实体匹配用 golden canonicalGroups / 别名归一（沧海观景台、山顶公园/山顶婚礼草坪组）；
 * - boundary（实体命中但 kind 存疑 / 一对多）单列清单交 PD 裁，**不自动判 fail**。
 *
 * 语义命中的机器化（评测侧标定，golden 只给口径不给算法）：
 * - 文本：归一化（去空白/标点/小写）后 bigram Dice 相似度 ≥ TEXT_HIT_THRESHOLD 为内容命中；
 *   ≥ TEXT_BOUNDARY_THRESHOLD 且 < TEXT_HIT_THRESHOLD 为存疑（进 boundary 清单）；
 * - claimKind：抽取契约（ParsedEntry）没有 PD 五类字段，用确定性词法信号推断
 *   （duration＝suggestMinutes/时长句式；pitfall＝排队/贵/坑类词；tip＝建议/提前/一定要类词；
 *   highlight＝其余正向体验描述），推断 kind ≠ golden kind 时不 fail、进 boundary 交 PD 裁；
 * - 实体：expectedClaims 不带实体字段（PD 标注挂在篇级），实体校验作用于「不矛盾」——
 *   内容命中但候选 entry 实体与 golden 小景点归一组明确冲突时降级 boundary。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ParsedEntry } from "../../server/src/ai/assemble.js";
import { latestAssetsVersion } from "./fixtureLoader.js";
import { loadExtractionCache, type ExtractionCacheNote } from "./extractionCache.js";

// ===== golden fixture（v1.1，原样入库于 eval/assets/v2） =====

export type GoldenClaimKind = "duration" | "highlight" | "poi" | "pitfall" | "tip";

export interface ExpectedClaim {
  id: string;
  claimKind: GoldenClaimKind;
  loc: string;
  text: string;
  tags?: string[];
  pdNote?: string;
}

export interface CanonicalGroup {
  group: string;
  surfaces: string[];
  rule: string;
  pdRuling?: string;
}

export interface E9Golden {
  assetVersion: string;
  caseId: string;
  purpose: string;
  guide: { title: string; sourceUrl: string; platform: string; labeledBy: string; labeledAt: string; corpusNote: string };
  claimKindEnum: GoldenClaimKind[];
  claimKindMapFromPD: Record<string, GoldenClaimKind>;
  expectedClaims: ExpectedClaim[];
  expectedPois: { note: string; rawList: string[]; canonicalGroups: CanonicalGroup[] };
  recall: { threshold: number; measure: string; matchRule: string; borderlineAdjudicator: string };
  openQuestions: string[];
}

let cachedGolden: E9Golden | null = null;

/** 从最高版本资产目录加载 E9 golden（VERSION.json files.goldenE9，sha256 已由 loader 校验） */
export function loadE9Golden(): E9Golden {
  if (cachedGolden !== null) return cachedGolden;
  const info = latestAssetsVersion();
  const versionFile = JSON.parse(readFileSync(join(info.dir, "VERSION.json"), "utf8")) as {
    files: Record<string, { path: string }>;
  };
  const relative = versionFile.files["goldenE9"]?.path;
  if (relative === undefined) {
    throw new Error(`[E9] assets ${info.version} 缺少 files.goldenE9（E9 golden 未入库）`);
  }
  cachedGolden = JSON.parse(readFileSync(join(info.dir, relative), "utf8")) as E9Golden;
  return cachedGolden;
}

/** E9 输入源笔记（golden guide.sourceUrl 的 noteId；抽取缓存按此键读取） */
export function goldenNoteId(golden: E9Golden): string {
  const match = /\/(?:explore|discovery\/item)\/([0-9a-zA-Z]+)/.exec(golden.guide.sourceUrl);
  if (match === null) throw new Error(`[E9] golden sourceUrl 无法解析 noteId：${golden.guide.sourceUrl}`);
  return match[1]!;
}

// ===== 实体归一（golden canonicalGroups / 别名） =====

const BRACKET_CONTENT_RE = /[（(【\[{][^）)】\]}]*[）)】\]}]/g;

/** 表面串归一：去括号内容/空白/标点 + 小写（与 poiAlias.normalizePoiNameBase 同口径的评测侧实现） */
export function normalizeSurface(raw: string): string {
  return raw.replace(BRACKET_CONTENT_RE, "").replace(/[\s·、，。,.:：;；!！?？"'"'()（）\[\]【】{}]/g, "").toLowerCase();
}

/**
 * 表面串 → canonical 组名（golden canonicalGroups 死数据）：
 * 1. 归一化全等命中组内 surface → 组名；
 * 2. 包含关系命中（≥2 字且短串占长串 ≥60%，防「山顶公园」误吞无关串）→ 组名；
 * 3. 未命中 → 返回归一化原串（保留原始串语义，不散票口径由调用方合并保证）。
 */
export function canonicalOfSurface(surface: string, groups: readonly CanonicalGroup[]): string {
  const normalized = normalizeSurface(surface);
  if (normalized === "") return "";
  for (const group of groups) {
    for (const candidate of group.surfaces) {
      if (normalizeSurface(candidate) === normalized) return group.group;
    }
  }
  for (const group of groups) {
    for (const candidate of group.surfaces) {
      const key = normalizeSurface(candidate);
      const shorter = key.length <= normalized.length ? key : normalized;
      const longer = key.length <= normalized.length ? normalized : key;
      if (shorter.length >= 2 && longer.includes(shorter) && shorter.length / longer.length >= 0.6) {
        return group.group;
      }
    }
  }
  return normalized;
}

/** entry 的实体归一集（name + parentAttraction 都参与，父子任一命中即算实体相关） */
export function entryEntities(entry: ParsedEntry, groups: readonly CanonicalGroup[]): Set<string> {
  const out = new Set<string>();
  const name = canonicalOfSurface(entry.name, groups);
  if (name !== "") out.add(name);
  if (entry.parentAttraction !== null && entry.parentAttraction !== "") {
    const parent = canonicalOfSurface(entry.parentAttraction, groups);
    if (parent !== "") out.add(parent);
  }
  return out;
}

// ===== claimKind 词法推断（抽取契约无 PD 五类字段，确定性信号，评测侧标定） =====

// #286 归因修复：词表精修——移除歧义裸词，保留可靠极性信号。
// - 移除 PITFALL 裸词「大雾」：既出现在亮点「大雾天云雾缭绕」（云海景观）又出现在避雷「大雾看不到海」，
//   裸天气名词非可靠负极性信号；可靠信号是其负面后果词（白茫茫/看不到/拍不到）。
// - 移除 PITFALL 裸词「贵」：保留精确串「物价贵」即可命中，裸「贵」易误伤。
// - 移除 TIP 裸词「攻略」：过泛（笔记标题「完整攻略」即含），非建议语气信号。
const PITFALL_WORDS = ["排队", "巨多", "漫天要价", "白茫茫", "物价贵", "坑", "避雷", "谨慎", "自备", "扑空", "看不到", "拍不到", "晕车", "忽悠", "白花"];
const TIP_WORDS = ["建议", "提前", "一定要", "必买", "备好", "记得", "网上", "便宜", "上午", "下午", "早点", "别忘", "优先"];
const DURATION_RE = /(\d+\s*[-~－至]\s*\d+\s*(小时|分钟))|(\d+\s*(小时|分钟))|游玩时长|玩多久|待上?半天|一整天/;

/**
 * entry 内容 → PD 五类推断（确定性词法信号，评测侧标定；poi 类由小景点实体承载）。
 * #286 归因修复：
 * 1. **不再把 entry.suggestMinutes 非空当作 duration 信号**——抽取器给几乎所有 POI 都填了
 *    suggestMinutes（结构属性，非 claim 语义），据其判 kind 会把 highlight/pitfall 全误判 duration
 *    （YLW-02/03/06 内容命中却因 suggestMinutes 降级 boundary 的 artifact 根因）。
 *    duration 类改由 evaluateE9Recall 显式按 suggestMinutes 数值区间匹配（parseDurationRangeMinutes）。
 * 2. **优先级 pitfall > tip > duration > highlight**——极性词（排队/建议）是比偶然时间数字更强的
 *    kind 信号：「排队1小时以上」的「1小时」是排队时长非游玩时长，不应压过「排队」的 pitfall 极性
 *    （YLW-06 由 boundary 转 hit 的根因）。
 */
export function inferClaimKind(entry: ParsedEntry): GoldenClaimKind {
  const text = `${entry.quote ?? ""} ${entry.summary ?? ""}`;
  if (PITFALL_WORDS.some((word) => text.includes(word))) return "pitfall";
  if (TIP_WORDS.some((word) => text.includes(word))) return "tip";
  if (DURATION_RE.test(text)) return "duration";
  return "highlight";
}

/**
 * 从 duration claim 文本解析分钟区间（#286：抽取器把游玩时长编码进 entry.suggestMinutes 结构字段，
 * 文本 sim 匹配不到，须按数值区间匹配）。例：「3-4小时」→[180,240]、「30分钟」→[22,38]（±25% 容差）；
 * 无法解析返回 null。
 */
export function parseDurationRangeMinutes(text: string): { min: number; max: number } | null {
  const hourRange = /(\d+(?:\.\d+)?)\s*[-~－至]\s*(\d+(?:\.\d+)?)\s*(?:小时|个钟|钟头|h)/i.exec(text);
  if (hourRange !== null) {
    return { min: Math.round(parseFloat(hourRange[1]!) * 60), max: Math.round(parseFloat(hourRange[2]!) * 60) };
  }
  const minRange = /(\d+)\s*[-~－至]\s*(\d+)\s*分钟/.exec(text);
  if (minRange !== null) return { min: parseInt(minRange[1]!, 10), max: parseInt(minRange[2]!, 10) };
  const singleHour = /(\d+(?:\.\d+)?)\s*(?:小时|个钟|钟头|h)/i.exec(text);
  if (singleHour !== null) {
    const value = Math.round(parseFloat(singleHour[1]!) * 60);
    return { min: Math.round(value * 0.75), max: Math.round(value * 1.25) };
  }
  const singleMin = /(\d+)\s*分钟/.exec(text);
  if (singleMin !== null) {
    const value = parseInt(singleMin[1]!, 10);
    return { min: Math.round(value * 0.75), max: Math.round(value * 1.25) };
  }
  return null;
}

// ===== 文本语义相似度（归一化 bigram Dice，不逐字比） =====

function bigrams(text: string): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i < text.length - 1; i++) grams.add(text.slice(i, i + 2));
  return grams;
}

/** 归一化后 bigram Dice 相似度（0..1）；短于 2 字退化为全等比较 */
export function textSimilarity(left: string, right: string): number {
  const a = normalizeSurface(left);
  const b = normalizeSurface(right);
  if (a === "" || b === "") return 0;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let shared = 0;
  for (const gram of ga) if (gb.has(gram)) shared++;
  return (2 * shared) / (ga.size + gb.size);
}

/** 内容命中阈值（评测侧标定：bigram Dice ≥0.30 视为语义命中；golden 只定口径不定算法） */
export const TEXT_HIT_THRESHOLD = 0.3;
/** 存疑阈值（0.18..0.30 之间进 boundary 清单交 PD 裁，不自动判 fail） */
export const TEXT_BOUNDARY_THRESHOLD = 0.18;

// ===== PD 裁量 override 表（Task #299，2026-10-30 PD 拍板落档） =====

/**
 * PD 裁量（2026-10-30 原话意译）：
 * > 「因为我之前对攻略文案自己简单做了提炼和规整，导致你无法完全对应，可以算你评测通过了。」
 *
 * 即：E9 golden（`highlight-recall-yalongwan.json`）系 PD 对原始攻略文案**自行提炼、规整**后的
 * 期望文本，与抽取器逐字摘录的原文本就存在**预期内的字面差异**；四条 boundary（YLW-02/04/10/11）
 * 的分歧根因是「字面不对应」（评测侧 inferClaimKind 词法反推误触 ＋ golden 合并 tip 被抽取拆条稀释
 * bigram sim），而非「内容未抽到」（miss=0）。PD 裁定：**四条全部判命中** → E9 recall 11/11=1.0 达标转 pass。
 *
 * **非静默放宽（红线）**：本表不改写机器判定过程，也不动 TEXT_HIT_THRESHOLD / 词表 / 阈值。
 * evaluateE9Recall 先按原机器口径算出每条的 `machineDecision`（hit/boundary/miss）与 `machineRecall`
 * （7/11=0.636），再对命中本表的 boundary/miss **追加**一行 PD 裁量转 hit；RecallTrace 同时保留
 * `machineDecision`＋`reason`（原始机器判定）与 `pdAdjudication`（PD 裁量＋理由），logRecallResult
 * 逐 claim 双行可见，报告叙述保留「原始机器判定 vs PD 裁量」两行。原始机器值永不被覆盖。
 */
export interface PdAdjudication {
  /** PD 裁定结果（本表仅收录判命中的边界项） */
  decision: "hit";
  /** 裁定理由（人话，落 log 与审阅文档） */
  reason: string;
  adjudicatedBy: string;
  adjudicatedAt: string;
}

/** claimId → PD 裁量（golden borderlineAdjudicator=PD；2026-10-30 四条边界全部判命中） */
// Task #301 说明（不改表内容，仅披露语义）：本表为 PD@2026-10-30 落档的**静态 override 快照**，键固定为
// #299 当时判为 boundary/miss 的 4 条（YLW-02/04/10/11）。重抽（#300 归属下沉生效＋抽取模型方差）后：
// (1) 各条 reason 内嵌的机器 sim 值（如 YLW-02「0.400」、YLW-04「0.250」、YLW-11「0.575」）是 #299 快照，
//     与本轮实际 sim 可能不一致——按红线不静默改写 PD 记录，实时机器值以 logRecallResult「原始机器判定」行为准；
// (2) 若某条本轮机器已直接 HIT（如重抽后 YLW-02），evaluateE9Recall 只对 machineDecision∈{boundary,miss}
//     者套用本表，故该条 override 自动变 no-op、不进 pdAdjudications——表保留 4 键但实际触发数以本轮为准。
export const PD_ADJUDICATION: Readonly<Record<string, PdAdjudication>> = {
  "YLW-02": {
    decision: "hit",
    reason:
      "内容已抽到（试婚房/非诚勿扰2/免费/木屋栈道均对应，机器 sim=0.400≥0.3 已判内容命中）；落 boundary 仅因评测侧 inferClaimKind 反推 kind=tip（quote「一定要进去看看」误触 TIP 词表「一定要」）≠ golden highlight，属词法误触非抽取缺口。golden 系 PD 提炼规整文本、字面不对应属预期 → 判命中。",
    adjudicatedBy: "PD",
    adjudicatedAt: "2026-10-30",
  },
  "YLW-04": {
    decision: "hit",
    reason:
      "golden「观光车一站一站停靠，节奏可以自己把控」系 PD 对攻略文案的提炼规整表述；抽取侧观光车信息（站点单向行驶/按顺序游玩/盘山公路）已 surface，语义等价覆盖该亮点。机器 sim=0.250<0.3 属「字面不对应」（golden 提炼所致，机器取到含「观光车」的兰花谷条目），非内容漏抽 → 判命中。",
    adjudicatedBy: "PD",
    adjudicatedAt: "2026-10-30",
  },
  "YLW-10": {
    decision: "hit",
    reason:
      "反推 kind=tip 与 golden 一致；机器 sim=0.233<0.3 系 golden 本条合并两个 tip（观光车必买／备雨具）而抽取器拆成不同 note_tip 条目致单条 bigram 稀释。前半「观光车必买/盘山陡坡」与 golden 逐字近乎一致，后半「备好雨具」另条 note_tip 已抽到；golden pdNote 已明示「命中判定时按语义拆分容忍」→ 判命中。",
    adjudicatedBy: "PD",
    adjudicatedAt: "2026-10-30",
  },
  "YLW-11": {
    decision: "hit",
    reason:
      "内容近乎逐字命中（机器 sim=0.575≥0.3，「建议上午上山」「下午容易起雾」「阳光柔和拍照好看」全对应）；落 boundary 仅因 inferClaimKind 反推 kind=pitfall（quote「看不到海」误触 PITFALL 词表「看不到」）≠ golden tip，属词法误触——抽取器归 note_tip 与 golden TIPS 归类其实一致 → 判命中。",
    adjudicatedBy: "PD",
    adjudicatedAt: "2026-10-30",
  },
};

// ===== recall 评测（纯函数） =====

export interface RecallHit {
  claimId: string;
  claimKind: GoldenClaimKind;
  entryName: string;
  similarity: number;
  kindInferred: GoldenClaimKind;
  quote: string;
  /**
   * PD 裁量转命中（Task #299）：原始机器判定为 boundary/miss，经 PD_ADJUDICATION override 计入 recall 分子。
   * 存在即表明此 hit 非机器原判——保留 machineDecision/machineReason 使「原始机器判定 vs PD 裁量」双行可见。
   */
  pdAdjudicated?: PdAdjudication & { machineDecision: "boundary" | "miss"; machineReason: string };
}

export interface RecallBoundary {
  claimId: string;
  claimKind: GoldenClaimKind;
  reason: string;
  bestEntryName: string;
  bestSimilarity: number;
  quote: string;
}

export interface RecallMiss {
  claimId: string;
  claimKind: GoldenClaimKind;
  loc: string;
  text: string;
  bestEntryName: string;
  bestSimilarity: number;
}

/** 逐 claim 匹配过程留痕（#286 归因要求：entity 归一前后、kind 对照、决策依据） */
export interface RecallTrace {
  claimId: string;
  claimKind: GoldenClaimKind;
  text: string;
  /** 最匹配 entry 名（duration 走 suggestMinutes 时为该结构字段命中条目） */
  bestEntryName: string;
  /** entity 归一前 → 归一后（canonicalOfSurface(entry.name)，golden canonicalGroups 别名表） */
  entitySurface: string;
  entityCanonical: string;
  bestSimilarity: number;
  /** 抽取侧推断 kind（duration 走 suggestMinutes 命中时记 "duration(suggestMinutes)"） */
  kindInferred: string;
  /** 最终决策（PD 裁量后）：命中 PD_ADJUDICATION 的 boundary/miss 会被 override 为 "hit" */
  decision: "hit" | "boundary" | "miss";
  /** 决策理由（未经 PD 裁量时＝机器判定理由；被 override 时保留原始机器理由，PD 理由见 pdAdjudication） */
  reason: string;
  /** 原始机器判定（未经 PD 裁量）：未触发 override 时等于 decision；触发时保留 boundary/miss 原值 */
  machineDecision: "hit" | "boundary" | "miss";
  /** PD 裁量（Task #299）：仅当 machineDecision 为 boundary/miss 且命中 PD_ADJUDICATION 转 hit 时存在 */
  pdAdjudication?: PdAdjudication;
}

export interface RecallEvalResult {
  total: number;
  hits: RecallHit[];
  boundary: RecallBoundary[];
  misses: RecallMiss[];
  /** 逐 claim 匹配过程（entity 归一前后＋kind 对照＋决策），供归因与 PD 裁边界 */
  traces: RecallTrace[];
  /** recall ＝ hits/total（PD 裁量后：分子含 PD_ADJUDICATION override 转命中的边界项） */
  recall: number;
  threshold: number;
  pass: boolean;
  /**
   * 原始机器 recall（未经 PD 裁量，仅计机器原判 hit）＝ machineHits/total。
   * Task #299 非静默放宽要求：与 `recall`（裁量后）并列留痕，报告叙述「原始机器判定 vs PD 裁量」两行可见。
   */
  machineRecall: number;
  /** 机器原判 hit 数（未经 PD 裁量），＝ round(machineRecall*total) */
  machineHits: number;
  /** PD 裁量转命中清单（Task #299）：每条保留原始机器判定＋理由 与 PD 裁定＋理由 */
  pdAdjudications: {
    claimId: string;
    claimKind: GoldenClaimKind;
    machineDecision: "boundary" | "miss";
    machineReason: string;
    pd: PdAdjudication;
  }[];
}

/**
 * E9 recall 纯函数：抽取缓存 entries vs golden expectedClaims。
 * duration 类先按 suggestMinutes 数值区间匹配（抽取器把游玩时长编码进结构字段，文本 sim 匹配不到）；
 * 其余每条 expected 取相似度最高的候选 entry：
 * - sim ≥ HIT 且 kind 推断一致 → hit；
 * - sim ≥ HIT 但 kind 推断不一致 → boundary（实体命中但 kind 存疑，交 PD 裁）；
 * - BOUNDARY ≤ sim < HIT → boundary（内容存疑）；同一 entry 被多条 expected 命中 → boundary（一对多）；
 * - sim < BOUNDARY → miss（附原文位置 loc，v1.4 断言要求漏抽逐条列出）。
 * 每条 claim 的 entity 归一前后＋kind 对照＋决策记入 traces（#286 归因/PD 裁边界）。
 *
 * PD 裁量 override（Task #299，2026-10-30）：机器判定完成后，对命中 PD_ADJUDICATION 表的
 * boundary/miss **追加**转 hit（golden 系 PD 提炼规整文本、字面不对应属预期，四条边界全判命中）；
 * 不改机器阈值/词表，machineDecision＋machineRecall 原样留存 → recall（裁量后 11/11=1.0，pass）与
 * machineRecall（原始机器 7/11=0.636）并列返回，非静默放宽。
 */
export function evaluateE9Recall(entries: readonly ParsedEntry[], golden: E9Golden): RecallEvalResult {
  const groups = golden.expectedPois.canonicalGroups;
  const hits: RecallHit[] = [];
  const boundary: RecallBoundary[] = [];
  const misses: RecallMiss[] = [];
  const traces: RecallTrace[] = [];
  const claimedEntries = new Map<number, string>(); // entry 下标 → 首个命中的 claimId（文本 claim 一对多检测）
  const durationClaimed = new Set<number>(); // duration 走 suggestMinutes 结构字段匹配，与文本 claim 正交，独立占用

  const trace = (
    expected: ExpectedClaim,
    partial: Omit<RecallTrace, "claimId" | "claimKind" | "text" | "machineDecision">,
  ): void => {
    // machineDecision 默认＝机器原判 decision（下方 PD 裁量 override 只改 decision，machineDecision 原样留存）
    traces.push({
      claimId: expected.id,
      claimKind: expected.claimKind,
      text: expected.text,
      machineDecision: partial.decision,
      ...partial,
    });
  };

  for (const expected of golden.expectedClaims) {
    // duration 类：抽取器把游玩时长编码进 entry.suggestMinutes（结构字段），文本 sim 匹配不到，
    // 先按数值区间匹配（#286 归因：YLW-01「3-4小时」对应父条目 suggestMinutes=210 ∈ [180,240]）。
    if (expected.claimKind === "duration") {
      const range = parseDurationRangeMinutes(expected.text);
      if (range !== null) {
        const idx = entries.findIndex(
          (entry, index) =>
            !durationClaimed.has(index) &&
            entry.suggestMinutes !== null &&
            entry.suggestMinutes >= range.min &&
            entry.suggestMinutes <= range.max,
        );
        if (idx >= 0) {
          const entry = entries[idx]!;
          durationClaimed.add(idx);
          const reason = `suggestMinutes=${entry.suggestMinutes} ∈ [${range.min},${range.max}]（时长区间命中，抽取器以结构字段承载 duration；不占用文本 claim 槽位）`;
          hits.push({
            claimId: expected.id, claimKind: "duration", entryName: entry.name,
            similarity: 1, kindInferred: "duration", quote: reason,
          });
          trace(expected, {
            bestEntryName: entry.name, entitySurface: entry.name, entityCanonical: canonicalOfSurface(entry.name, groups),
            bestSimilarity: 1, kindInferred: "duration(suggestMinutes)", decision: "hit", reason,
          });
          continue;
        }
      }
    }

    let best: { index: number; entry: ParsedEntry; sim: number } | null = null;
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      const sim = Math.max(
        textSimilarity(expected.text, entry.quote ?? ""),
        textSimilarity(expected.text, entry.summary ?? ""),
        textSimilarity(expected.text, `${entry.name} ${entry.quote ?? ""}`),
      );
      if (best === null || sim > best.sim) best = { index, entry, sim };
    }
    const bestCanonical = best === null ? "-" : canonicalOfSurface(best.entry.name, groups);
    if (best === null || best.sim < TEXT_BOUNDARY_THRESHOLD) {
      const reason = `sim=${(best?.sim ?? 0).toFixed(3)} < ${TEXT_BOUNDARY_THRESHOLD}：抽取未 surface 此 claim（POI 级抽取器未产出对应条目）`;
      misses.push({
        claimId: expected.id,
        claimKind: expected.claimKind,
        loc: expected.loc,
        text: expected.text,
        bestEntryName: best?.entry.name ?? "-",
        bestSimilarity: Number((best?.sim ?? 0).toFixed(3)),
      });
      trace(expected, {
        bestEntryName: best?.entry.name ?? "-", entitySurface: best?.entry.name ?? "-", entityCanonical: bestCanonical,
        bestSimilarity: Number((best?.sim ?? 0).toFixed(3)), kindInferred: best === null ? "-" : inferClaimKind(best.entry),
        decision: "miss", reason,
      });
      continue;
    }
    const kindInferred = inferClaimKind(best.entry);
    const duplicate = claimedEntries.get(best.index);
    if (duplicate !== undefined) {
      const reason = `一对多：同一抽取条目「${best.entry.name}」已被 ${duplicate} 命中（PD 裁是否拆分算两条）`;
      boundary.push({
        claimId: expected.id, claimKind: expected.claimKind, reason,
        bestEntryName: best.entry.name, bestSimilarity: Number(best.sim.toFixed(3)), quote: best.entry.quote ?? "",
      });
      trace(expected, {
        bestEntryName: best.entry.name, entitySurface: best.entry.name, entityCanonical: bestCanonical,
        bestSimilarity: Number(best.sim.toFixed(3)), kindInferred, decision: "boundary", reason,
      });
      continue;
    }
    if (best.sim >= TEXT_HIT_THRESHOLD && kindInferred === expected.claimKind) {
      claimedEntries.set(best.index, expected.id);
      const reason = `内容命中 sim=${best.sim.toFixed(3)} ≥ ${TEXT_HIT_THRESHOLD} 且 kind 推断一致（${kindInferred}）`;
      hits.push({
        claimId: expected.id,
        claimKind: expected.claimKind,
        entryName: best.entry.name,
        similarity: Number(best.sim.toFixed(3)),
        kindInferred,
        quote: best.entry.quote ?? "",
      });
      trace(expected, {
        bestEntryName: best.entry.name, entitySurface: best.entry.name, entityCanonical: bestCanonical,
        bestSimilarity: Number(best.sim.toFixed(3)), kindInferred, decision: "hit", reason,
      });
      continue;
    }
    const reason =
      best.sim >= TEXT_HIT_THRESHOLD
        ? `kind 存疑：内容命中（sim=${best.sim.toFixed(3)}）但推断 kind=${kindInferred} ≠ golden ${expected.claimKind}`
        : `内容存疑：sim=${best.sim.toFixed(3)} ∈ [${TEXT_BOUNDARY_THRESHOLD}, ${TEXT_HIT_THRESHOLD})`;
    boundary.push({
      claimId: expected.id, claimKind: expected.claimKind, reason,
      bestEntryName: best.entry.name, bestSimilarity: Number(best.sim.toFixed(3)), quote: best.entry.quote ?? "",
    });
    trace(expected, {
      bestEntryName: best.entry.name, entitySurface: best.entry.name, entityCanonical: bestCanonical,
      bestSimilarity: Number(best.sim.toFixed(3)), kindInferred, decision: "boundary", reason,
    });
  }

  const total = golden.expectedClaims.length;

  // ===== PD 裁量 override（Task #299，2026-10-30）=====
  // 先冻结「原始机器判定」：machineHits ＝ override 前的机器 hit 数（仅计机器原判命中）。
  // 再对命中 PD_ADJUDICATION 表的 boundary/miss 追加转 hit——不改机器阈值/词表，machineDecision 原样留存，
  // 使「原始机器判定 vs PD 裁量」两行永远可见（非静默放宽）。
  const machineHits = hits.length;
  const pdAdjudications: RecallEvalResult["pdAdjudications"] = [];
  for (const t of traces) {
    const pd = PD_ADJUDICATION[t.claimId];
    if (pd === undefined || t.machineDecision === "hit") continue; // 仅裁 boundary/miss；机器已判 hit 无需 override
    const machineReason = t.reason;
    // 从 boundary / misses 清单移除该条（已转 hit），保持三清单互斥
    if (t.machineDecision === "boundary") {
      const idx = boundary.findIndex((b) => b.claimId === t.claimId);
      if (idx >= 0) boundary.splice(idx, 1);
    } else {
      const idx = misses.findIndex((m) => m.claimId === t.claimId);
      if (idx >= 0) misses.splice(idx, 1);
    }
    // trace：decision 转 hit（machineDecision/reason 保留原始机器判定），追加 pdAdjudication
    t.decision = "hit";
    t.pdAdjudication = pd;
    hits.push({
      claimId: t.claimId,
      claimKind: t.claimKind,
      entryName: t.bestEntryName,
      similarity: t.bestSimilarity,
      kindInferred: t.kindInferred as GoldenClaimKind,
      quote: "",
      pdAdjudicated: { ...pd, machineDecision: t.machineDecision as "boundary" | "miss", machineReason },
    });
    pdAdjudications.push({
      claimId: t.claimId,
      claimKind: t.claimKind,
      machineDecision: t.machineDecision as "boundary" | "miss",
      machineReason,
      pd,
    });
  }

  const machineRecall = machineHits / total;
  const recall = hits.length / total; // PD 裁量后（分子含 override 转命中）
  return {
    total,
    hits,
    boundary,
    misses,
    traces,
    recall,
    threshold: golden.recall.threshold,
    pass: recall >= golden.recall.threshold,
    machineRecall,
    machineHits,
    pdAdjudications,
  };
}

/** 读 E9 输入源的抽取缓存（未建缓存时抛错提示先跑 npm run eval:corpus） */
export function loadE9ExtractionCache(golden: E9Golden): ExtractionCacheNote {
  const noteId = goldenNoteId(golden);
  const cached = loadExtractionCache(noteId);
  if (cached === null) {
    throw new Error(`[E9] 抽取缓存缺失或失效（noteId=${noteId}）：请先跑 npm run eval:corpus 建缓存（Task #286 重跑慢层）`);
  }
  return cached;
}
