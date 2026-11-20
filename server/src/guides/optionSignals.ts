/**
 * Task #270：optionGroups「内容感知解锁」与 snippets 去重（纯函数，离线可测）。
 *
 * 背景：Task #216 P1-C 的降级规则（素材提及 < 5 或 scope = attraction 时把第七节
 * optionGroups 契约换成一行动作声明）是为「成组原料不足」兜底，但西岛「单景区 + 交通
 * 方式对比」素材恰好同时命中两个降级条件——「步行 / 电动车 / 观光车 / 电动三轮车」这种
 * 天然可成组的对比信息永远进不了 optionGroups（Task #269 评测：解锁后 4/4 稳定产出
 * transport 组）。既不能无条件取消降级（每次多约 920 token 且抬高幻觉面），也不能继续
 * 一刀切，因此改为「素材内容命中可比较信号才解锁」。
 *
 * 本模块提供两个纯函数（不读写 Trip、不触网、无副作用）：
 * 1. detectOptionGroupSignals / collectPlaceTexts / detectMergeOptionGroupSignals：
 *    保守判定素材里是否存在「同一主题下 ≥2 个可比较选项」的原料；
 * 2. dropSnippetsDuplicatedByOptionGroups：百炼实测会把同一交通内容同时写进 snippets
 *    与 optionGroups（Task #269 四轮中三轮如此），按确定性规则删除重复 snippet。
 *
 * Task #273 真实生产路径修复（原判定漏判）：
 * - 真实西岛攻略被 NER 切成 4 个地点提及（西岛 / 渔村 / 牛王岭 / 乌龟滩），每个地点
 *   只有 1 种方式，且 quoteText 只留半句（丢了「电动车 / 电动三轮车」与两档价格）——
 *   原 per-place 判定必然漏判；
 * - 新增「按 sourceId 聚合」判定层：同一篇来源下跨地点的提及汇聚后判定，并优先用
 *   GuideSource.sourceText 原文（NER 截断的兜底）；不同来源之间绝不合并，避免跨攻略
 *   拼凑出伪对比。
 */

import type {
  PendingGuideDraftOptionGroup,
  PendingGuideDraftSnippet,
  Trip,
} from "@goplay/shared";
import type { GuideMergeResult, MergedMention, MergedPlace } from "./merge.js";

// ===== 一、可比较信息信号 =====

/**
 * 选项词表：按「语义族 + 词」登记，只有同一族内出现 ≥2 个不同词才算「可比较选项」，
 * 避免「门票 80 元 + 观光车 20 元」这种不同族的价格被误判成一组对比。
 *
 * 刻意保守：
 * - 只收确定性强的名词（代步方式 / 票种 / 餐饮形态 / 租借），泛化动词（去、玩、逛）不入表；
 * - 长的词优先（「电动三轮车」不会被「三轮车」重复计数，见 findOptionTermHits 的重叠消解）。
 */
const OPTION_TERM_TABLE: readonly { group: string; term: string }[] = [
  // 交通 / 代步方式
  { group: "transport", term: "步行" },
  { group: "transport", term: "徒步" },
  { group: "transport", term: "电动车" },
  { group: "transport", term: "电瓶车" },
  { group: "transport", term: "电单车" },
  { group: "transport", term: "小电驴" },
  { group: "transport", term: "电动三轮车" },
  { group: "transport", term: "三轮车" },
  { group: "transport", term: "摩托车" },
  { group: "transport", term: "观光车" },
  { group: "transport", term: "游览车" },
  { group: "transport", term: "摆渡车" },
  { group: "transport", term: "接驳车" },
  { group: "transport", term: "自行车" },
  { group: "transport", term: "缆车" },
  { group: "transport", term: "索道" },
  { group: "transport", term: "游船" },
  { group: "transport", term: "快艇" },
  { group: "transport", term: "轮渡" },
  { group: "transport", term: "帆船" },
  { group: "transport", term: "包车" },
  { group: "transport", term: "打车" },
  { group: "transport", term: "自驾" },
  { group: "transport", term: "公交" },
  // 票种 / 门票
  { group: "ticket", term: "门票" },
  { group: "ticket", term: "联票" },
  { group: "ticket", term: "套票" },
  { group: "ticket", term: "通票" },
  { group: "ticket", term: "成人票" },
  { group: "ticket", term: "儿童票" },
  { group: "ticket", term: "学生票" },
  { group: "ticket", term: "往返船票" },
  { group: "ticket", term: "单程船票" },
  // 餐饮形态
  { group: "dining", term: "套餐" },
  { group: "dining", term: "双人餐" },
  { group: "dining", term: "单点" },
  { group: "dining", term: "自助餐" },
  // 装备租赁
  { group: "rental", term: "租金" },
  { group: "rental", term: "租赁" },
  { group: "rental", term: "押金" },
];

/** 价格 token：必须带货币单位（元 / 块），避免把「8 点前」「3 小时」当成价格 */
const PRICE_TOKEN_RE = /(?:[0-9]{1,6}(?:\.[0-9]+)?)(?:\s*[-~～—–至到]\s*[0-9]{1,6}(?:\.[0-9]+)?)?\s*(?:元|块)/g;

/** 价格区间（「25-40 元」这类）：单独命中即可作为「多档价格」证据 */
const PRICE_RANGE_RE = /[0-9]{1,6}(?:\.[0-9]+)?\s*[-~～—–至到]\s*[0-9]{1,6}(?:\.[0-9]+)?\s*(?:元|块)/;

/** 免费价格（也是一档可比较的价格） */
const FREE_PRICE_RE = /免费|不收费|无需门票/;

/** 对比 / 选择意图词：出现才说明原文在做「方式之间」的比较 */
const COMPARE_RE = /对比|比较|不如|更划算|性价比|更省|更便宜|更贵|差不多|可选|或者|也可以|建议坐|建议租/;

/** 主题结构词：交通 / 票务 / 租赁 / 餐饮等「这段素材本来就在讲可选项」的强提示 */
const THEME_CUE_RE = /交通|代步|环岛|船班|门票|船票|票种|租赁|租车|接驳|摆渡|套餐|人均|餐饮|装备/;

/** 阈值：同一语义族内至少 2 个不同选项词 */
const MIN_OPTION_TERMS_PER_GROUP = 2;

/** 阈值：价格档位型的多档价格下限（少于 3 档更像单点信息，交给 snippets） */
const MIN_PRICE_TIERS = 3;

/** 信号判定结果（reasons 直接进日志，便于线上判断解锁是否正确） */
export interface OptionGroupSignalResult {
  hit: boolean;
  /** 命中的可比较选项词（同族 ≥2 个，或全部命中词；用于日志 / 断言） */
  optionTerms: string[];
  /** 价格 token 数（含免费） */
  priceCount: number;
  priceRange: boolean;
  compare: boolean;
  themeCue: boolean;
  /** 人类可读的命中理由（未命中为空数组） */
  reasons: string[];
}

interface OptionTermHit {
  group: string;
  term: string;
  start: number;
  end: number;
}

/** 去空白 + 小写（保留标点，便于后续按位置消解重叠） */
function normalizeSignalText(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}

/**
 * 找出全部选项词命中，并消解「长词内部包含短词」的重叠：
 * 「电动三轮车」只计 1 个方式，不会被「三轮车」再计一次；
 * 「观光车/三轮车」这类并列则正确计 2 个。
 */
function findOptionTermHits(normalized: string): OptionTermHit[] {
  const raw: OptionTermHit[] = [];
  for (const entry of OPTION_TERM_TABLE) {
    let from = 0;
    while (from < normalized.length) {
      const index = normalized.indexOf(entry.term, from);
      if (index < 0) break;
      raw.push({ group: entry.group, term: entry.term, start: index, end: index + entry.term.length });
      from = index + entry.term.length;
    }
  }
  raw.sort((left, right) => left.start - right.start || right.end - left.end);
  const kept: OptionTermHit[] = [];
  for (const hit of raw) {
    const overlapped = kept.some((existing) => hit.start < existing.end && existing.start < hit.end);
    if (!overlapped) kept.push(hit);
  }
  return kept;
}

/**
 * 单份素材（同一地点下的全部提及原文）的可比较信号判定（保守）：
 *
 * 命中条件（任一）：
 *   A. 同类对比型：同一语义族内出现 ≥2 个不同选项词（如「步行 / 观光车 / 三轮车」）；
 *   B. 价格档位型：主题结构词 + 对比词 + 多档价格（≥3 个价格 token 或存在价格区间）——
 *      覆盖选项词没被识别出、但原文明显在横向比价的素材。
 *
 * 为什么这样设计：
 * - 「日落很美」「建议早上去人少」没有任何选项词 → 不命中（普通亮点不涨 prompt）；
 * - 「观光车 20 元一圈」只有 1 个方式 → 不命中（单点信息该写 snippets，不该成组）；
 * - 西岛交通原文：步行 / 租电动车 / 观光车 / 电动三轮车 + 多个价格 → A 命中；
 * - 门票与观光车混在一句时，因不同族不会被凑成一组对比（宁可漏，不要错）。
 */
export function detectOptionGroupSignals(rawTexts: readonly string[]): OptionGroupSignalResult {
  const normalized = rawTexts.map((text) => normalizeSignalText(text)).join("\n");
  const hits = findOptionTermHits(normalized);
  const termsByGroup = new Map<string, Set<string>>();
  for (const hit of hits) {
    const terms = termsByGroup.get(hit.group) ?? new Set<string>();
    terms.add(hit.term);
    termsByGroup.set(hit.group, terms);
  }

  const priceMatches = normalized.match(PRICE_TOKEN_RE) ?? [];
  const priceCount =
    new Set(priceMatches.map((price) => price.replace(/\s+/g, ""))).size + (FREE_PRICE_RE.test(normalized) ? 1 : 0);
  const priceRange = PRICE_RANGE_RE.test(normalized);
  const compare = COMPARE_RE.test(normalized);
  const themeCue = THEME_CUE_RE.test(normalized);

  const optionTerms: string[] = [];
  const reasons: string[] = [];
  for (const [group, terms] of termsByGroup) {
    if (terms.size < MIN_OPTION_TERMS_PER_GROUP) continue;
    optionTerms.push(...terms);
    const supporting: string[] = [];
    if (priceCount >= 1 || priceRange) supporting.push(`价格 ${priceCount} 处${priceRange ? "（含区间）" : ""}`);
    if (compare) supporting.push("对比词");
    if (themeCue) supporting.push("主题结构词");
    reasons.push(
      `同族「${group}」出现 ${terms.size} 个可比较选项（${[...terms].join(" / ")}）` +
        (supporting.length > 0 ? ` + ${supporting.join("、")}` : ""),
    );
  }
  // 价格档位型：主题 + 对比 + 多档价格（选项词没识别出来也能解锁）
  if (optionsByPriceTiers(themeCue, compare, priceCount, priceRange)) {
    reasons.push(`主题结构词 + 对比词 + 多档价格（${priceCount} 处${priceRange ? "，含区间" : ""}）`);
  }

  return {
    hit: reasons.length > 0,
    optionTerms: [...new Set(optionTerms)],
    priceCount,
    priceRange,
    compare,
    themeCue,
    reasons,
  };
}

/** 价格档位型信号（独立纯函数，便于测试与文档化） */
function optionsByPriceTiers(themeCue: boolean, compare: boolean, priceCount: number, priceRange: boolean): boolean {
  if (!themeCue || !compare) return false;
  return priceRange || priceCount >= MIN_PRICE_TIERS;
}

/** 便捷布尔版（调用侧只关心是否解锁第七节完整契约） */
export function hasOptionGroupSignals(rawTexts: readonly string[]): boolean {
  return detectOptionGroupSignals(rawTexts).hit;
}

/** 单条合并提及的判定文本：原文优先，原文缺失（OCR 失败 / 旧数据）时用摘要兜底 */
function collectMentionTexts(mentions: readonly MergedMention[]): string[] {
  const texts: string[] = [];
  for (const merged of mentions) {
    const mention = merged.mention;
    if (typeof mention.quoteText === "string" && mention.quoteText.trim() !== "") {
      texts.push(mention.quoteText);
      continue;
    }
    if (typeof mention.modelSummary === "string" && mention.modelSummary.trim() !== "") {
      texts.push(mention.modelSummary);
    }
  }
  return texts;
}

/** 单个合并地点的判定文本（Task #270 per-place 语义保持不变） */
export function collectPlaceTexts(place: MergedPlace): string[] {
  return collectMentionTexts(place.mentions);
}

/** 合并素材级判定的可选输入（Task #273） */
export interface MergeOptionSignalOptions {
  /**
   * sourceId → GuideSource.sourceText（来源完整原文）。
   * 缺失 key 时只用该来源名下聚合提及文本兜底（旧数据 / 测试夹具）。
   */
  sourceTexts?: ReadonlyMap<string, string>;
}

/**
 * 取「本轮参与合并的来源」的完整原文映射（Task #273）：
 * 只遍历 merge.sourceSnapshots——局部模式选中的来源、全部模式的可用来源都在其中，
 * 未参与合并的来源不会混进来，也就不会被拿来拼凑选项组。
 */
export function collectMergeSourceTexts(trip: Trip, merge: GuideMergeResult): Map<string, string> {
  const texts = new Map<string, string>();
  for (const snapshot of merge.sourceSnapshots) {
    const raw = trip.guideSources?.[snapshot.sourceId]?.sourceText;
    if (typeof raw === "string" && raw.trim() !== "") texts.set(snapshot.sourceId, raw);
  }
  return texts;
}

/**
 * 合并素材级判定（两层，取并集）：
 *
 * 1. per-place 层（Task #270）：同一地点下的提及命中即解锁。解决「单地点聚齐多方案」；
 * 2. per-source 层（Task #273）：同一来源下跨地点提及汇聚 + 来源原文（sourceText）命中
 *    即解锁。解决真实 NER 把一篇交通攻略切成「西岛 / 渔村 / 牛王岭 / 乌龟滩」四个地点、
 *    且 quoteText 只留半句（丢了电动车 / 电动三轮车与价格）导致的地点数无 ≥2 方案的漏判。
 *
 * 关键边界：per-source 层只在同一 sourceId 内部聚合——不同攻略各有一个「电动车」不会
 * 被拼成一组对比（避免跨攻略伪信号）。
 */
export function detectMergeOptionGroupSignals(
  merge: GuideMergeResult,
  options: MergeOptionSignalOptions = {},
): OptionGroupSignalResult & { places: string[]; sources: string[] } {
  const hitPlaces: string[] = [];
  const hitSources: string[] = [];
  const reasons: string[] = [];
  const optionTerms = new Set<string>();
  let priceCount = 0;
  let priceRange = false;
  let compare = false;
  let themeCue = false;

  const accumulate = (result: OptionGroupSignalResult): void => {
    for (const term of result.optionTerms) optionTerms.add(term);
    priceCount += result.priceCount;
    priceRange = priceRange || result.priceRange;
    compare = compare || result.compare;
    themeCue = themeCue || result.themeCue;
  };

  // 第 1 层：per-place（Task #270 既有行为，保持不变）
  for (const place of merge.places) {
    const texts = collectPlaceTexts(place);
    if (texts.length === 0) continue;
    const result = detectOptionGroupSignals(texts);
    if (!result.hit) continue;
    hitPlaces.push(place.displayName);
    for (const reason of result.reasons) reasons.push(`${place.displayName}：${reason}`);
    accumulate(result);
  }

  // 第 2 层：per-source（Task #273）——同一来源原文 + 跨地点提及聚合，绝不跨来源拼接
  const mentionsBySource = new Map<string, MergedMention[]>();
  for (const merged of merge.mentions) {
    const list = mentionsBySource.get(merged.sourceId) ?? [];
    list.push(merged);
    mentionsBySource.set(merged.sourceId, list);
  }
  for (const [sourceId, mentions] of mentionsBySource) {
    const texts: string[] = [];
    const raw = options.sourceTexts?.get(sourceId);
    if (typeof raw === "string" && raw.trim() !== "") texts.push(raw);
    texts.push(...collectMentionTexts(mentions));
    if (texts.length === 0) continue;
    const result = detectOptionGroupSignals(texts);
    if (!result.hit) continue;
    hitSources.push(sourceId);
    for (const reason of result.reasons) reasons.push(`来源 ${sourceId}：${reason}`);
    accumulate(result);
  }

  return {
    hit: hitPlaces.length > 0 || hitSources.length > 0,
    optionTerms: [...optionTerms],
    priceCount,
    priceRange,
    compare,
    themeCue,
    reasons,
    places: hitPlaces,
    sources: hitSources,
  };
}

// ===== 二、snippets 与 optionGroups 去重 =====

/** 文本归一化：去空白 + 去标点 + 小写（两侧同口径比对） */
const DEDUPE_STRIP_RE = /[\s・·、，。；：,.;:!?！？~～\-—–_/\\|"'“”‘’()（）\[\]【】{}「」<>《》+*#…]/g;

function dedupeKey(text: string): string {
  return text.replace(DEDUPE_STRIP_RE, "").toLowerCase();
}

/** 价格数字 key：从 priceText 抽「25-40」这类数字骨架（去标点后为 2540），与 snippet 同口径比对 */
function priceNumberKey(priceText: string): string | null {
  const matched = priceText.match(/[0-9]+(?:\.[0-9]+)?(?:\s*[-~～—–至到]\s*[0-9]+(?:\.[0-9]+)?)?/);
  if (matched === null) return null;
  const key = dedupeKey(matched[0]);
  return key === "" ? null : key;
}

/** 字符二元组集合（中文覆盖率比对用） */
function bigrams(text: string): string[] {
  const chars = [...text];
  if (chars.length < 2) return chars;
  const grams: string[] = [];
  for (let index = 0; index < chars.length - 1; index += 1) {
    grams.push(`${chars[index]}${chars[index + 1]}`);
  }
  return grams;
}

/** snippet 被某选项覆盖的比例（snippet 自身二元组中落在选项文本内的占比） */
function coverageRatio(snippetKey: string, optionKey: string): number {
  const grams = bigrams(snippetKey);
  if (grams.length === 0) return 0;
  let hit = 0;
  for (const gram of grams) {
    if (optionKey.includes(gram)) hit += 1;
  }
  return hit / grams.length;
}

/** 选项名最小可比长度（归一化后 <2 字的 label 不做重复判据，避免误删） */
const MIN_LABEL_KEY_CHARS = 2;
/** 覆盖率门槛：snippet 的二元组有 60% 以上落在同一选项文本内才算重复 */
const COVERAGE_MIN_RATIO = 0.6;

interface OptionGroupKeyIndex {
  topic: string;
  labels: string[];
  prices: string[];
  /** label + price + route + scene + note 的归一化整串（覆盖率判据） */
  optionKeys: string[];
}

function buildGroupKeyIndex(group: PendingGuideDraftOptionGroup): OptionGroupKeyIndex {
  const labels: string[] = [];
  const prices: string[] = [];
  const optionKeys: string[] = [];
  for (const option of group.options) {
    const labelKey = dedupeKey(option.label);
    if ([...labelKey].length >= MIN_LABEL_KEY_CHARS) labels.push(labelKey);
    if (typeof option.priceText === "string" && option.priceText !== "") {
      const priceKey = priceNumberKey(option.priceText);
      if (priceKey !== null) prices.push(priceKey);
    }
    const parts = [option.label, option.priceText, option.routeText, option.sceneText, option.noteText].filter(
      (part): part is string => typeof part === "string" && part !== "",
    );
    optionKeys.push(dedupeKey(parts.join("")));
  }
  return { topic: group.topic, labels, prices, optionKeys };
}

/** 单条 snippet 与单个选项组的重合判定 */
function matchGroup(
  snippetKey: string,
  index: OptionGroupKeyIndex,
): { labelHits: number; priceHits: number; coverage: number } {
  let labelHits = 0;
  for (const label of index.labels) {
    if (snippetKey.includes(label)) labelHits += 1;
  }
  let priceHits = 0;
  for (const price of new Set(index.prices)) {
    if (snippetKey.includes(price)) priceHits += 1;
  }
  let coverage = 0;
  for (const optionKey of index.optionKeys) {
    coverage = Math.max(coverage, coverageRatio(snippetKey, optionKey));
  }
  return { labelHits, priceHits, coverage };
}

/** 去重丢弃明细（日志 / 验证脚本断言用） */
export interface SnippetOptionDedupeDrop {
  text: string;
  topic: string;
  reason: string;
}

export interface SnippetOptionDedupeResult {
  snippets: PendingGuideDraftSnippet[];
  dropped: SnippetOptionDedupeDrop[];
}

/**
 * snippets 与 optionGroups 的确定性去重（保守）：
 * 同一信息只保留在 optionGroups 里，避免景区卡上同一段交通内容出现两遍。
 *
 * 只有以下任一条件成立才删除 snippet（否则原样保留）：
 * 1. 命中同一组内 ≥2 个选项名（snippet 在枚举多个选项）；
 * 2. 命中 1 个选项名 + 1 个价格数字（点名某选项并复述其价格）；
 * 3. 命中 1 个选项名 + 与某选项文本的二元组覆盖率 ≥ 60%（原文被改写成提示）；
 * 4. 命中同一组内 ≥2 个价格数字（复述多个选项的价格档）。
 *
 * 边界：普通亮点（「日落很美」「建议早上去」「渔村慢慢逛」）不含选项名与价格 →
 * 即使与选项共享少量词也不会被覆盖率门槛误删（覆盖率按 snippet 自身长度归一）。
 */
export function dropSnippetsDuplicatedByOptionGroups(
  snippets: readonly PendingGuideDraftSnippet[],
  optionGroups: readonly PendingGuideDraftOptionGroup[],
): SnippetOptionDedupeResult {
  if (optionGroups.length === 0 || snippets.length === 0) {
    return { snippets: [...snippets], dropped: [] };
  }
  const indexes = optionGroups.map((group) => buildGroupKeyIndex(group));
  const kept: PendingGuideDraftSnippet[] = [];
  const dropped: SnippetOptionDedupeDrop[] = [];
  for (const snippet of snippets) {
    const snippetKey = dedupeKey(snippet.text);
    let dropReason: SnippetOptionDedupeDrop | null = null;
    for (const index of indexes) {
      const { labelHits, priceHits, coverage } = matchGroup(snippetKey, index);
      if (labelHits >= 2) {
        dropReason = { text: snippet.text, topic: index.topic, reason: `枚举同组 ${labelHits} 个选项` };
        break;
      }
      if (labelHits >= 1 && priceHits >= 1) {
        dropReason = { text: snippet.text, topic: index.topic, reason: "复述选项名与价格" };
        break;
      }
      if (labelHits >= 1 && coverage >= COVERAGE_MIN_RATIO) {
        dropReason = {
          text: snippet.text,
          topic: index.topic,
          reason: `与选项文本重合 ${(coverage * 100).toFixed(0)}%`,
        };
        break;
      }
      if (priceHits >= 2) {
        dropReason = { text: snippet.text, topic: index.topic, reason: `复述同组 ${priceHits} 档价格` };
        break;
      }
    }
    if (dropReason !== null) dropped.push(dropReason);
    else kept.push(snippet);
  }
  return { snippets: kept, dropped };
}
