/**
 * F5（笔记正文抽取）/ Task #51（截图 OCR）共享的抽取装配层。
 *
 * 从 extract.ts 抽出的纯装配函数集合：模型条目归一化、名称归一化与匹配、
 * FlyAI 搜索对齐（同名查询缓存）、Item / Visit / Stop 装配与三级归属、
 * evidence mention 写入、笔记序号计算。
 *
 * 设计约束：
 * - 模型输出一律不可信：归一化层只接受契约内字段，非法值按兜底处理；
 * - ParsedEntry 的 OCR 扩展字段（ticketRelation / suggestedVisitName / bbox）
 *   对 F5 保持可选——F5 不产出这些字段时行为与抽取前完全一致；
 * - 全部函数直接改动已加载的 trip 副本，由 save 前的 validateConsistency 兜底；
 * - 同名去重：Item 按 providerId > 归一化名；Stop 按 matchedPointRef > 归一化名。
 */

import type { FlyAIPoi } from "../flyai/client.js";
import { searchPoi as realSearchPoi } from "../flyai/client.js";
import type { Item, SourceEvidence, Stop, Trip, Visit } from "@goplay/shared";
import {
  extractPageRefs,
  isAreaOnlyPlaceName,
  isPoiAlias,
  isSameCanonicalPoiName,
  makeVisitId,
  normalizePoiNameBase,
  resolvePoiAlias,
} from "@goplay/shared";
import { shouldRejectCustomCheckpoint } from "./checkpointFilter.js";
import { generateId } from "./idGen.js";
import {
  aggregatePoiCandidates,
  collectOccupiedProviderIds,
  decidePoiUpgradeTarget,
  describePoiUpgradeRejection,
} from "./poiUpgrade.js";

// ===== Task #284：FlyAI 搜索 DI 钩子（评测态缓存/桩替换，功能态＝真搜索零变化） =====
export type SearchPoiFn = (query: string) => Promise<{ normalized: FlyAIPoi[] }>;
let searchPoiFn: SearchPoiFn = realSearchPoi;
export function setSearchPoi(fn: SearchPoiFn): void { searchPoiFn = fn; }
export function resetSearchPoi(): void { searchPoiFn = realSearchPoi; }

/** F5 / OCR 共用的装配结果：本批实际写入的结构化视图（routes 原样返回前端） */
export interface AssembleOutcome {
  items: Array<{
    itemId: string;
    name: string;
    origin: "fliggy" | "custom";
    matched: boolean;
    /** 复用既有 Item（仅补充证据引用，非新建）；前端据此区分"新增/已收录" */
    reused: boolean;
    suggestMinutes: number | null;
  }>;
  visits: Array<{ visitId: string; pointRef: string; name: string; kind: "ordinary" | "large_attraction" }>;
  stops: Array<{
    stopId: string;
    name: string;
    state: "attached" | "pending";
    visitRef: string | null;
    suggestedVisitRef: string | null;
    level: "high" | "medium" | "low";
  }>;
  /** 本批新建 Visit（含入 globalCandidateRefs）数量；既有 Visit 只补证据不计入 */
  newVisitCount: number;
  /** 本批复用既有 Visit（仅补充证据引用）数量 */
  reusedVisitCount: number;
  /** 本批新建且已自动挂入所属行程（attached）的 Stop 数量 */
  attachedStopCount: number;
  /** 本批新建且进入待定（pending）的 Stop 数量 */
  pendingStopCount: number;
  /** 本批复用既有 Stop（仅补充证据引用）数量 */
  reusedStopCount: number;
}

/** 归一化后的模型抽取条目（契约见 prompt.ts EXTRACT_RULES_TEXT / OCR_RULES_TEXT） */
export interface ParsedEntry {
  name: string;
  type: "attraction" | "in_attraction" | "note_tip";
  parentAttraction: string | null;
  scale: "large" | null;
  confidence: "high" | "medium" | "low";
  suggestMinutes: number | null;
  locationHint: string | null;
  quote: string;
  summary: string;
  /** Task #51 OCR：大景区门票与该玩法的关系；F5 不产出 → unknown（行为不变） */
  ticketRelation: "included" | "separate" | "unknown";
  /** Task #51 OCR：模型建议归入的大景区名（可能与 parentAttraction 不同）；F5 → null */
  suggestedVisitName: string | null;
  /** Task #51 OCR：图片内位置框（模型归一化坐标，原样存储）；F5 → null */
  bbox: [number, number, number, number] | null;
  /**
   * Task #123 强证据父子关系：模型给出的从属关系原文依据（如「位于后海村内部」）；
   * 可选（旧构造点 / 未标注 = undefined，行为不变）。仅当上下文明示从属关系
   * （位于 / 内部 / 附近 / 某景区内）时非空；同日、同篇、名称相似不构成依据。
   */
  relationEvidence?: string | null;
  /**
   * Task #181：明确 Day 归属（1 起始）。仅本地结构化抽取产出——条目位于行首
   * 明确 Day 标题（Day N / DN / 第 N 天）之下时为该标题序号，无标题归属为 null；
   * 模型路径不产出该字段（undefined，行为不变）。不凭空推断日期。
   */
  dayIndex?: number | null;
  /**
   * Task #181：条目来源标记，仅本地抽取产出——"local"=高置信快速路径（未调用
   * 百炼）、"local_fallback"=百炼解析失败后的安全降级（上层据此落 partial 并
   * 提示重试）；模型路径不产出（undefined）。
   */
  extractSource?: "local" | "local_fallback";
}

/** 模型未给出有效 summary 时的兜底文案 */
export const DEFAULT_SUMMARY = "笔记提及";

/**
 * Task #305：assembleEntries 的整体装配预算（毫秒）。
 *
 * 背景（Adam #302 诊断）：装配阶段逐条串行调用 FlyAI 搜索——每条 attraction /
 * in_attraction 至少一次，in_attraction 命中不到所属景区时还会追加一次父级搜索。
 * 单次搜索受 client 侧 90s 超时约束，此前装配整体**没有预算**，N 条最坏可达 N×90s，
 * 是来源处理链路里唯一无封顶的耗时黑洞。
 *
 * 取 120s：与前端来源等待的慢档阈值（web SOURCE_STALL_AFTER_MS=180s）配合，让装配
 * 在服务端硬性封顶，超时后**停止后续搜索、返回已装配的部分结果**——未装配条目保持
 * 未对齐 / 未排状态走既有兜底语义（来源据此落 partial，用户可重试），绝不静默丢弃
 * 或编造供应商字段。预算与「当前时刻」均可由调用方注入（options.budgetMs / options.now），
 * 供离线单测确定性验证截断行为。
 */
export const ASSEMBLE_BUDGET_MS = 120_000;

/**
 * Task #313：FlyAI 装配搜索的有界并发数。
 *
 * 背景（Cole #277 实测）：装配段串行 6 mention × 单次搜索 p50≈21s ≈ 126s，
 * 被 #305 的 120s 预算截顶仍慢，是 P1b（纯文字攻略 ≤90s）不达标的主因。
 * （Task #334 注：21s 系 11-02 基线，11-03 同口径复测 p50 3.72s，跨天波动大、
 * 根因未定位，见 eval-report/v2/perf.md 复测节；并行化收益随单次延迟下降而
 * 缩小，但波动情形下仍必要。）
 * 搜索相互独立（结果按 entry 原索引保序装配），并行化后墙钟 ≈ 最慢一条。
 *
 * 解析约定与 jobs.ts 的 GUIDE_IMAGE_CONCURRENCY 一致：env ASSEMBLE_CONCURRENCY
 * 可覆盖默认值（正整数，1~8 范围内生效，超范围 / 非法值回退默认并告警一次）。
 * 调用时惰性解析（而非模块加载期定值）：验证脚本可在进程内改 env 后直接断言。
 */
export const ASSEMBLE_CONCURRENCY_DEFAULT = 6;
export const ASSEMBLE_CONCURRENCY_MAX = 8;
const assembleConcurrencyWarned = new Set<string>();
export function resolveAssembleConcurrency(): number {
  const raw = process.env.ASSEMBLE_CONCURRENCY;
  if (raw === undefined || raw.trim() === "") return ASSEMBLE_CONCURRENCY_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > ASSEMBLE_CONCURRENCY_MAX) {
    if (!assembleConcurrencyWarned.has(raw)) {
      assembleConcurrencyWarned.add(raw);
      console.warn(
        `[AI] ASSEMBLE_CONCURRENCY="${raw}" 无效（需 1~${ASSEMBLE_CONCURRENCY_MAX} 整数），` +
          `回退默认值 ${ASSEMBLE_CONCURRENCY_DEFAULT}`,
      );
    }
    return ASSEMBLE_CONCURRENCY_DEFAULT;
  }
  return parsed;
}

/** bbox 归一化：4 个有限数字才收，否则 null（坐标体系由模型侧约定，服务端不换算） */
function normalizeBbox(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const nums = value.map((entry) => Number(entry));
  if (!nums.every((num) => Number.isFinite(num))) return null;
  return [nums[0], nums[1], nums[2], nums[3]];
}

/** 结构归一化：name 必须为非空字符串；type/confidence/quote 按契约兜底，不猜测 */
export function normalizeParsedEntry(value: unknown): ParsedEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name.trim() === "") return null;

  const parentAttraction =
    typeof record.parentAttraction === "string" && record.parentAttraction.trim() !== ""
      ? record.parentAttraction.trim()
      : null;
  // Task #287：note_tip 不要求 parentAttraction（归属由后处理确定性设置）；
  // in_attraction 缺 parentAttraction 时降级为独立 attraction（不猜测所属）
  const type: ParsedEntry["type"] =
    record.type === "note_tip"
      ? "note_tip"
      : record.type === "in_attraction" && parentAttraction !== null
        ? "in_attraction"
        : "attraction";
  const scale = record.scale === "large" ? "large" : null;
  const confidence =
    record.confidence === "high" || record.confidence === "medium" ? record.confidence : "low";
  const minutes = Number(record.suggestMinutes);
  const suggestMinutes =
    Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : null; // null = 待定（不冒充先验值）
  const locationHint =
    typeof record.locationHint === "string" && record.locationHint.trim() !== ""
      ? record.locationHint.trim()
      : null;
  const quote = typeof record.quote === "string" ? record.quote.trim() : "";
  const summary =
    typeof record.summary === "string" && record.summary.trim() !== "" ? record.summary.trim() : DEFAULT_SUMMARY;
  const ticketRelation =
    record.ticketRelation === "included" || record.ticketRelation === "separate"
      ? record.ticketRelation
      : "unknown";
  const suggestedVisitName =
    typeof record.suggestedVisitName === "string" && record.suggestedVisitName.trim() !== ""
      ? record.suggestedVisitName.trim()
      : null;

  return {
    name: record.name.trim(),
    type,
    parentAttraction,
    scale,
    confidence,
    suggestMinutes,
    locationHint,
    quote,
    summary,
    ticketRelation,
    suggestedVisitName,
    bbox: normalizeBbox(record.bbox),
    // Task #123：从属关系原文依据归一化（空串归 null；仅明示从属关系时模型才填）
    relationEvidence:
      typeof record.relationEvidence === "string" && record.relationEvidence.trim() !== ""
        ? record.relationEvidence.trim()
        : null,
  };
}

// ===== 名称归一化与匹配 =====

/**
 * 名称归一化（基础口径）：去空白、去成对括号及其内容（中英文），用于匹配与同名去重。
 * 别名解析不在此处：planner 快速路径 / directives 地点指令靠「全等 > 整体包含」
 * 收敛同名重复实体，若把别名（「亚龙湾森林公园」）在这里折叠成正式名，
 * 行程中同时存在两个名称时会把原可唯一命中的实体变成歧义（回落 AI）。
 *
 * Task #233：真实召回 / 对齐点改用 @goplay/shared 的 resolvePoiAlias
 * （本函数 + 去城市前缀 + 显式别名表，唯一数据源）。
 */
export function normalizePoiName(name: string): string {
  return normalizePoiNameBase(name);
}

// ===== Task #107：候选脏数据前置过滤（平台水印 / 泛化词 / 自述非地点） =====

/**
 * 平台 / 媒体词（exact）：抽取时把 OCR 水印、平台角标当成点位的历史脏数据。
 * 与 web/src/lib/trip.ts 的 PLATFORM_OR_MEDIA_WORDS 保持同源口径。
 */
const PLATFORM_OR_MEDIA_WORDS = new Set([
  "小红书",
  "小红书号",
  "抖音",
  "大众点评",
  "美团",
  "携程",
  "飞猪",
  "微博",
  "快手",
  "高德地图",
  "百度地图",
  "马蜂窝",
  "去哪儿",
  "穷游",
  "哔哩哔哩",
  "youtube",
  "instagram",
]);

/**
 * 纯泛化地理类型词（exact）：不能误杀「后海海滩」「西岛码头」「第一市场」；
 * 与 web/src/lib/trip.ts 的 GENERIC_PLACE_WORDS 保持同源口径。
 */
const GENERIC_PLACE_WORDS = new Set([
  "海滩",
  "沙滩",
  "海岛",
  "岛",
  "岛屿",
  "景点",
  "景区",
  "码头",
  "市场",
  "海湾",
  "湾",
  "海边",
  "海岸",
  "公园",
  "广场",
  "商圈",
  "步行街",
  "古城",
  "古镇",
  "夜市",
]);

/** summary 自述「不是地点」的标记词（水印 / 广告 / logo） */
const NON_PLACE_SUMMARY_MARKERS = ["水印", "非实际地点", "广告", "logo"];

/** 平台 / 媒体词或纯泛化地理类型词（exact 判定，不做 includes） */
export function isPlatformOrGenericPlaceName(name: string): boolean {
  const target = normalizePoiName(name).toLowerCase();
  if (target === "") return false;
  return PLATFORM_OR_MEDIA_WORDS.has(target) || GENERIC_PLACE_WORDS.has(target);
}

/**
 * FlyAI 搜索前的通用淘汰规则（Task #107）：
 * - 名称是平台 / 媒体词或纯泛化地理类型词（exact）；
 * - 模型 summary 明确自述水印 / 广告 / 非实际地点。
 * 只认 exact 与明确自述，不做模糊猜测，避免误杀具体景点。
 */
export function isDisqualifiedEntry(entry: ParsedEntry): boolean {
  if (isPlatformOrGenericPlaceName(entry.name)) return true;
  const summary = entry.summary.trim().toLowerCase();
  return summary !== "" && NON_PLACE_SUMMARY_MARKERS.some((marker) => summary.includes(marker));
}

/** includes 降级的最小名称长度：更短（极短名）只接受 exact */
const MIN_FUZZY_NAME_LENGTH = 3;

/**
 * 名称匹配优先级：归一化相等 > 互为包含；都算不上即未命中。
 * Task #107：纯泛化词与极短名不参与 includes（「海滩」不得错配到「后海海滩」），
 * 正常具体名称保留现有模糊匹配。
 * Task #233：两侧都过别名解析（简称「亚龙湾森林公园」与官方名
 * 「亚龙湾热带天堂森林公园」因此全等）；仍只有全等 + 整体双向包含两档。
 */
export function findBestMatch(name: string, pois: FlyAIPoi[]): FlyAIPoi | undefined {
  const target = resolvePoiAlias(name);
  if (target === "") return undefined;
  const allowFuzzy = target.length >= MIN_FUZZY_NAME_LENGTH && !isPlatformOrGenericPlaceName(target);
  let contains: FlyAIPoi | undefined;
  for (const poi of pois) {
    const candidate = resolvePoiAlias(poi.name);
    if (candidate === "") continue;
    if (candidate === target) return poi;
    if (!allowFuzzy || candidate.length < MIN_FUZZY_NAME_LENGTH) continue;
    if (contains === undefined && (candidate.includes(target) || target.includes(candidate))) {
      contains = poi;
    }
  }
  return contains;
}

/**
 * Task #233：POI 搜索查询序列（别名召回）。
 * - 第一查询始终是抽取名（原文语义最接近，行为与既有完全一致）；
 * - 仅当抽取名命中显式别名表时，追加一条正式名查询——简称与官方名没有子串
 *   包含关系，只靠名称映射命中不了「搜索词根本没召回到官方 POI」的情形；
 * - 非别名名称永远只有一条查询（不增加任何网络成本）。
 * 同一正式名查询在批次内共享 searchCache，因此同名简称最多多一次 CLI 调用。
 */
export function planPoiSearchQueries(city: string, name: string): string[] {
  const trimmedCity = city.trim();
  const withCity = (value: string): string => (trimmedCity !== "" ? `${trimmedCity} ${value}` : value);
  const queries = [withCity(name)];
  if (!isPoiAlias(name)) return queries;
  const canonical = resolvePoiAlias(name);
  if (canonical === "" || canonical === name) return queries;
  const aliasQuery = withCity(canonical);
  if (!queries.includes(aliasQuery)) queries.push(aliasQuery);
  return queries;
}

/**
 * Task #254：单次名称对齐结果。
 *
 * - match：既有召回策略（findBestMatch：canonical 全等 > 整体包含）的最佳命中，
 *   只用于新建实体 / 复用查找——「首条命中」不得作为存量实体升级依据；
 * - candidates：本轮全部搜索轮次合并去重后的完整候选集，是存量升级唯一性判定的
 *   唯一输入（多义 / 占用判定都基于它）；
 * - error：任一轮次搜索失败的错误文案（非空 → 存量实体一律保持 custom）。
 */
export interface PoiAlignment {
  match: FlyAIPoi | null;
  candidates: FlyAIPoi[];
  error: string | null;
}

/** 未执行搜索时的空对齐结果（既有 fliggy 命中 / 调用方显式跳过搜索） */
export function emptyPoiAlignment(): PoiAlignment {
  return { match: null, candidates: [], error: null };
}

/**
 * 单个点位与飞猪真实 POI 对齐（同名查询进程内缓存，避免重复触网）：
 * 搜索异常或无匹配时 match=null（调用方降级 custom），绝不伪造供应商字段。
 *
 * Task #233：名称命中别名时按 planPoiSearchQueries 追加正式名二次召回。
 * Task #254：不再「首轮命中即返回」——别名名称的全部查询轮次都要执行并合并成
 * 完整候选集，否则第二个同义 providerId 会被漏掉、误导存量升级。任一轮次失败
 * 即停止后续轮次并把错误上报（不吞错），存量实体据此保持 custom。
 * Task #313：inFlight 为**本次装配 run 内**的查询级 Promise memo（归一化查询串为
 * 键）——并行装配下重复 mention 的同名查询共享同一在途 Promise，只触网一次；
 * run 结束即弃（不做跨 run 缓存）。失败不 memo（删除在途记录，重查会再触网，
 * 与既有「失败不进 searchCache」口径一致）。不传 inFlight 时行为与既有完全一致。
 */
export async function alignWithFliggyCached(
  trip: Trip,
  name: string,
  errors: string[],
  searchCache: Map<string, FlyAIPoi[]>,
  inFlight?: Map<string, Promise<FlyAIPoi[]>>,
): Promise<PoiAlignment> {
  const queries = planPoiSearchQueries(trip.destination.city, name);

  const aggregate = await aggregatePoiCandidates(queries, (query) => {
    const cached = searchCache.get(query);
    if (cached !== undefined) return Promise.resolve(cached);
    const memoKey = query.trim().replace(/\s+/g, " ");
    if (inFlight !== undefined) {
      const memoized = inFlight.get(memoKey);
      if (memoized !== undefined) return memoized;
    }
    const pending = (async (): Promise<FlyAIPoi[]> => {
      try {
        const result = await searchPoiFn(query);
        searchCache.set(query, result.normalized);
        if (memoKey !== query) searchCache.set(memoKey, result.normalized);
        return result.normalized;
      } catch (error) {
        console.error(`[AI] 抽取点位「${name}」搜索失败，按未命中降级 custom：`, error);
        throw error;
      }
    })();
    if (inFlight !== undefined) {
      inFlight.set(memoKey, pending);
      // 失败即弃（不 memo 失败 Promise）；catch 挂在共享 Promise 上防未处理 rejection，
      // 真实错误仍由上方聚合链的每个调用方各自接收
      pending.catch(() => inFlight.delete(memoKey));
    }
    return pending;
  });

  if (aggregate.error !== null) {
    // 不写"飞猪未收录"：失败≠未收录，前端据"待飞猪匹配"字样区分灰色标签。
    // 只有首轮失败才提示（正式名补召回失败沿用既有安静降级，不改用户可见文案）
    if (aggregate.failedIndex === 0) errors.push(`「${name}」搜索暂不可用，待飞猪匹配`);
    return { match: null, candidates: aggregate.candidates, error: aggregate.error };
  }

  const match = findBestMatch(name, aggregate.candidates) ?? null;
  if (match !== null) {
    console.log(`[AI] 抽取点位「${name}」对齐飞猪 POI「${match.name}」（id=${match.id}）`);
  } else {
    const aliasNote = queries.length > 1 ? `（含别名正式名「${resolvePoiAlias(name)}」二次召回）` : "";
    console.log(`[AI] 抽取点位「${name}」搜索未命中飞猪 POI${aliasNote}，降级 custom`);
  }
  return { match, candidates: aggregate.candidates, error: null };
}

// ===== Item / Visit / Stop 装配（直接改动已加载的 trip，由 save 前校验兜底） =====

/**
 * 查找既有 fliggy Item（按名称相等，含显式别名）：命中即跳过 FlyAI 搜索——
 * 供应商字段已在库且稳定，重复搜索徒增失败面（额度紧张时还会把已收录点位
 * 误标"待飞猪匹配"）；custom Item 不在此列，仍会尝试 FlyAI 对齐。
 * Task #233：官方名已有 Item 时，攻略简称（「亚龙湾森林公园」）直接复用，
 * 不再另建一条 custom 重复点位。
 */
export function findExistingFliggyItem(trip: Trip, name: string): Item | undefined {
  const target = resolvePoiAlias(name);
  if (target === "") return undefined;
  return Object.values(trip.itemRegistry).find(
    (item) => item.origin === "fliggy" && resolvePoiAlias(item.name) === target,
  );
}

/**
 * Task #249 / #254：存量 custom Item 的在线升级入口（唯一判定，与修复脚本同源）。
 *
 * - 只有别名命中的 custom Item 才进入判定（别名表是唯一升级范围）；
 * - 三道闸门全部通过才升级：完整候选集 canonical 全等且 providerId 去重后唯一、
 *   providerId 未被其他 Item 占用、全部搜索轮次成功；
 * - 多义 / 被占用 / 搜索失败 / 无候选一律保持 custom（供应商字段一个都不写）。
 */
function maybeUpgradeExistingCustomItem(
  trip: Trip,
  item: Item,
  entryName: string,
  alignment: PoiAlignment,
): CustomItemPoiUpgrade | null {
  if (item.origin !== "custom" || item.providerId !== null) return null;
  const aliasName = isPoiAlias(entryName) ? entryName : isPoiAlias(item.name) ? item.name : null;
  if (aliasName === null) return null;

  const decision = decidePoiUpgradeTarget(
    item.name,
    alignment.candidates,
    collectOccupiedProviderIds(trip, item.itemId),
    { searchError: alignment.error },
  );
  if (decision.kind === "no-candidate") return null;
  if (decision.kind !== "upgrade") {
    console.log(
      `[AI] custom 点位「${item.name}」保持 custom：${describePoiUpgradeRejection(decision)}（Task #254）`,
    );
    return null;
  }
  return applyPoiUpgradeToCustomItem(item, decision.poi, aliasName);
}

/** ensureItem：providerId 精确 > 归一化名；复用时追加证据引用（去重）并补时长。
 *  返回 reused = 是否命中既有 Item（调用方据此统计新增/复用）。
 *  Task #249：命中既有 custom Item 且别名命中的 FlyAI 正式 POI 已召回时，原地升级
 *  为 fliggy（不新建重复项，itemId / name / 证据引用 / 归属 / 排序一律不变）。
 *  Task #254：升级判定统一走 decidePoiUpgradeTarget（完整候选集 + 唯一 + 未占用 +
 *  全轮次搜索成功），绝不再拿 findBestMatch 首条结果升级存量实体。 */
export function ensureItem(
  trip: Trip,
  entry: ParsedEntry,
  alignment: PoiAlignment,
  evidenceId: string,
): { item: Item; reused: boolean } {
  // Task #196：复用查找抽为独立函数——打卡点过滤的「是否会新建」预判与实际
  // 建库共用同一口径，防两处逻辑漂移
  const existing = findReusableItem(trip, entry, alignment.match);
  if (existing !== undefined) {
    // Task #249 / #254：别名命中的 custom Item → 唯一判定通过后原地升级
    const upgrade = maybeUpgradeExistingCustomItem(trip, existing, entry.name, alignment);
    if (upgrade !== null) {
      console.log(
        `[AI] custom 点位「${existing.name}」原地升级为飞猪 POI（providerId=${upgrade.providerId}，` +
          `变更字段：${upgrade.changes.map((change) => change.field).join(" / ")}）`,
      );
    }
    if (!existing.sourceEvidenceRefs.includes(evidenceId)) existing.sourceEvidenceRefs.push(evidenceId);
    if (existing.suggestMinutes === null && entry.suggestMinutes !== null) {
      existing.suggestMinutes = entry.suggestMinutes;
    }
    // Task #76：既有 custom Item 缺地址且本批有位置提示时补齐（与补时长同模式），
    // 供前端标注「为AI提取」展示；fliggy Item 地址以飞猪为准不补
    if (
      existing.origin === "custom" &&
      existing.address === null &&
      entry.locationHint !== null
    ) {
      existing.address = entry.locationHint;
    }
    return { item: existing, reused: true };
  }

  const poi = alignment.match;
  const item: Item = {
    // Task #284：id 经中央生成器——功能态＝randomUUID 零变化；评测态注入
    // 内容种子派生（name），跨进程稳定 → planner prompt 可回放。
    // 种子不含 poi?.id：FlyAI 对齐结果可能随网络波动，name 在 fixture 内唯一足够。
    itemId: generateId(`item:${entry.name}`),
    name: entry.name,
    origin: poi !== null ? "fliggy" : "custom",
    providerId: poi?.id ?? null,
    // Task #76：custom 点位无飞猪地址，用抽取的位置提示作地址描述（前端标注「为AI提取」）
    address: poi !== null ? poi.address : entry.locationHint,
    category: poi?.category ?? null,
    coords: poi?.coords ?? null,
    suggestMinutes: entry.suggestMinutes,
    mainPic: poi?.mainPic ?? null,
    ticketInfo: poi?.ticketInfo ?? null,
    jumpUrl: poi?.jumpUrl ?? null,
    // Task #329：免费状态透传（custom 无 POI 时缺省，读时默认 null，不伪造）
    freePoiStatus: poi?.freePoiStatus ?? undefined,
    // Task #330：飞猪 POI 元信息透传（等级/榜单/介绍）；custom 无 POI 时缺省，读时默认 null，不伪造
    poiLevel: poi?.poiLevel ?? undefined,
    listRank: poi?.listRank ?? undefined,
    description: poi?.description ?? undefined,
    sourceEvidenceRefs: [evidenceId],
  };
  trip.itemRegistry[item.itemId] = item;
  return { item, reused: false };
}

/**
 * Task #196：ensureItem 的既有 Item 复用查找（providerId 精确 > 名称相等，含显式别名）。
 * 返回 undefined = 本次装配将新建 Item（打卡点过滤仅在此场景生效，
 * 复用既有实体 / 命中飞猪的真实 POI 零影响）。
 */
export function findReusableItem(
  trip: Trip,
  entry: Pick<ParsedEntry, "name">,
  poi: FlyAIPoi | null,
): Item | undefined {
  const normName = resolvePoiAlias(entry.name);
  if (poi !== null) {
    const byProvider = Object.values(trip.itemRegistry).find(
      (item) => item.origin === "fliggy" && item.providerId === poi.id,
    );
    if (byProvider !== undefined) return byProvider;
  }
  if (normName !== "") {
    const byName = Object.values(trip.itemRegistry).find(
      (item) => resolvePoiAlias(item.name) === normName,
    );
    if (byName !== undefined) return byName;
  }
  return undefined;
}

// ===== Task #249：别名命中的 custom Item 原地升级（custom → fliggy） =====

/** 单字段变更记录（升级日志 / dry-run 明细 / 回读断言共用） */
export interface PoiUpgradeFieldChange {
  field: keyof Item;
  before: unknown;
  after: unknown;
}

/** custom Item 原地升级结果（changes 为空表示无需变更） */
export interface CustomItemPoiUpgrade {
  itemId: string;
  name: string;
  providerId: string;
  changes: PoiUpgradeFieldChange[];
}

/** 值变更判定：基本类型引用相等；对象（coords）按序列化比较，避免无意义重写 */
function sameUpgradeValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left === "object" && typeof right === "object" && left !== null && right !== null) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return false;
}

/**
 * Task #249：把「显式别名命中」的 custom Item 在原地升级为飞猪实体。
 *
 * 前置条件（任一不满足即不升级，返回 null）：
 * - item 仍为 custom 且 providerId 为 null（已是 fliggy 幂等跳过）；
 * - aliasName 命中显式别名表（单跳解析，唯一数据源 @goplay/shared poiAlias）；
 * - item 名称与 POI 名称 canonical 全等（只认全等，不做包含 / 模糊）；
 * - POI id 非空（绝不伪造 providerId）。
 *
 * 只写供应商字段：origin / providerId / address / category / coords / mainPic /
 * ticketInfo / jumpUrl；itemId、name（攻略原文名称）、suggestMinutes、
 * sourceEvidenceRefs 及引用该 Item 的 Visit / Stop / 排序一律不动——升级是
 * 原地补全，不是重建或迁移。
 */
export function applyPoiUpgradeToCustomItem(
  item: Item,
  poi: FlyAIPoi,
  aliasName: string | null,
): CustomItemPoiUpgrade | null {
  if (item.origin !== "custom" || item.providerId !== null) return null;
  if (aliasName === null || !isPoiAlias(aliasName)) return null;
  if (!isSameCanonicalPoiName(item.name, poi.name)) return null;
  const providerId = typeof poi.id === "string" ? poi.id.trim() : "";
  if (providerId === "") return null;

  const changes: PoiUpgradeFieldChange[] = [];
  const apply = <K extends keyof Item>(field: K, next: Item[K]): void => {
    if (sameUpgradeValue(item[field], next)) return;
    changes.push({ field, before: item[field], after: next });
    item[field] = next;
  };

  // 两个契约标志先行：origin + providerId 共同定义「fliggy 实体」
  apply("origin", "fliggy");
  apply("providerId", providerId);
  // 供应商字段以飞猪为准；POI 未提供时保留既有值，不制造臆造数据
  apply("address", poi.address ?? item.address);
  apply("category", poi.category ?? item.category);
  apply("coords", poi.coords ?? item.coords);
  apply("mainPic", poi.mainPic ?? item.mainPic);
  apply("ticketInfo", poi.ticketInfo ?? item.ticketInfo);
  apply("jumpUrl", poi.jumpUrl ?? item.jumpUrl);
  // Task #329：升级路径同样透传免费状态；仅 POI 携带信号时写入，未携带则保留
  // 既有值（含字段缺失态），不把读时默认回写成 null 制造无意义变更
  if (poi.freePoiStatus !== null) apply("freePoiStatus", poi.freePoiStatus);
  // Task #330：升级路径同样透传等级/榜单/介绍；关键细节——`if (poi.X !== null) apply(...)`，
  // 无信号时刻意不回写 null，避免污染 opLog 与制造无意义变更记录（与 freePoiStatus 同口径）
  if (poi.poiLevel !== null) apply("poiLevel", poi.poiLevel);
  if (poi.listRank !== null) apply("listRank", poi.listRank);
  if (poi.description !== null) apply("description", poi.description);

  return { itemId: item.itemId, name: item.name, providerId, changes };
}

/**
 * 按名称查找既有 Visit（全等 > 互为包含），用于 parentAttraction / suggestedVisitName
 * 归属解析。Task #233：两侧过别名解析——简称「亚龙湾森林公园」可以归入官方名
 * 「亚龙湾热带天堂森林公园」的 Visit，内部玩法不再自动补建重复的大景区壳。
 */
export function findVisitByItemName(trip: Trip, name: string): Visit | null {
  const target = resolvePoiAlias(name);
  if (target === "") return null;
  let contains: Visit | null = null;
  for (const visit of Object.values(trip.visits)) {
    const candidate = resolvePoiAlias(trip.itemRegistry[visit.pointRef]?.name ?? "");
    if (candidate === "") continue;
    if (candidate === target) return visit;
    if (contains === null && (candidate.includes(target) || target.includes(candidate))) contains = visit;
  }
  return contains;
}

/** ensureVisitShell：同 pointRef 复用；新建壳进全局候选区（globalCandidateRefs）。
 *  返回 created = 是否新建（调用方据此区分"新入候选池/复用补证据"） */
export function ensureVisitShell(
  trip: Trip,
  item: Item,
  kind: "ordinary" | "large_attraction",
): { visit: Visit; created: boolean } {
  for (const visit of Object.values(trip.visits)) {
    if (visit.pointRef === item.itemId) return { visit, created: false };
  }
  const visit: Visit = {
    visitId: makeVisitId(trip, item.itemId),
    dayRef: null,
    pointRef: item.itemId,
    kind,
    visitMode: kind === "large_attraction" ? "full_day" : "custom",
    order: null,
    windowStart: null,
    windowEnd: null,
    startTime: null,
    endTime: null,
    startTimeOverridden: false,
    endTimeOverridden: false,
    reservedMinutes: null,
    effectiveMinutes: null,
    externalLeg: null,
    childStopRefs: [],
    alternateStopRefs: [],
    purchaseState: "unknown",
    locked: false,
    userAdjusted: false,
    removedFrom: null,
    removedAt: null,
  };
  trip.visits[visit.visitId] = visit;
  trip.globalCandidateRefs.push({ kind: "visit", id: visit.visitId });
  return { visit, created: true };
}

/**
 * ensureStop + 三级归属（PRD §10.4）：
 * - 新建 Stop（pending 起步）后按 confidence 归置；复用的 Stop 不重复归置；
 * - high + 找到所属 Visit → attached（childStopRefs 末位）；
 * - medium（或 high 但未找到所属）→ pending + suggestedVisitRef；
 * - low / 无所属 → pending 无建议；
 * - 全部写入 relationshipSuggestions（后台三级，decidedBy=system）；
 * - ticketRelation 来自 OCR 抽取（F5 → unknown）；
 * - options.suppressAttach（Task #96）：high 也不自动挂入所属 Visit，一律 pending +
 *   suggestedVisitRef（level 仍记 high），供攻略来源后台异步装配使用——
 *   后台图片完成不得自动修改已生成行程（附录 B §5），只进待定区供用户确认。
 */
export function ensureStopAndPlace(
  trip: Trip,
  entry: ParsedEntry,
  matchedItem: Item,
  evidenceId: string,
  mentionId: string,
  parentVisit: Visit | null,
  options: { suppressAttach?: boolean } = {},
): { stop: Stop; level: "high" | "medium" | "low"; created: boolean } {
  const normName = resolvePoiAlias(entry.name);
  let stop = Object.values(trip.stops).find(
    (candidate) =>
      candidate.matchedPointRef === matchedItem.itemId ||
      (candidate.matchedPointRef === null && resolvePoiAlias(candidate.customName ?? "") === normName && normName !== ""),
  );

  const mentionRef = `${evidenceId}:${mentionId}`;
  if (stop !== undefined) {
    if (!stop.sourceEvidenceRefs.includes(evidenceId)) stop.sourceEvidenceRefs.push(evidenceId);
    if (!stop.sourceMentionRefs.includes(mentionRef)) stop.sourceMentionRefs.push(mentionRef);
    const level = trip.relationshipSuggestions[stop.stopId]?.level ?? "low";
    return { stop, level, created: false };
  }

  const created: Stop = {
    // Task #284：种子＝matchedItem.itemId（Stop 与 Item 1:1，见上方 reuse 查找）
    stopId: `stop_${generateId(`stop:${matchedItem.itemId}`)}`,
    state: "pending",
    visitRef: null,
    suggestedVisitRef: null,
    matchedPointRef: matchedItem.itemId,
    customName: null,
    order: null,
    suggestMinutes: entry.suggestMinutes,
    locationHint: entry.locationHint,
    ticketRelation: entry.ticketRelation,
    sourceEvidenceRefs: [evidenceId],
    sourceMentionRefs: [mentionRef],
    userAdjusted: false,
    removedFromOrder: null,
    removedAt: null,
  };
  trip.stops[created.stopId] = stop = created;

  let level: "high" | "medium" | "low";
  if (parentVisit !== null && entry.confidence === "high" && options.suppressAttach !== true) {
    // high：自动挂入所属大景区（用户可再手动纠正）
    created.state = "attached";
    created.visitRef = parentVisit.visitId;
    created.order = parentVisit.childStopRefs.length;
    parentVisit.childStopRefs.push(created.stopId);
    level = "high";
    trip.relationshipSuggestions[created.stopId] = {
      stopRef: created.stopId,
      suggestedVisitRef: null,
      level: "high",
      positiveSignals: [`模型以高置信度归属「${entry.parentAttraction}」，已自动挂入`],
      negativeSignals: [],
      decidedBy: "system",
    };
  } else {
    // medium（有疑似归属）/ low（无归属）：一律 pending，等待用户确认归类；
    // suppressAttach（Task #96）时 high 也走这里：不改动已生成行程，只进待定区
    created.state = "pending";
    if (parentVisit !== null) created.suggestedVisitRef = parentVisit.visitId;
    trip.pendingStopRefs.push(created.stopId);
    level = parentVisit === null ? "low" : entry.confidence;
    const suppressedHigh = options.suppressAttach === true && entry.confidence === "high";
    trip.relationshipSuggestions[created.stopId] = {
      stopRef: created.stopId,
      suggestedVisitRef: created.suggestedVisitRef,
      level,
      positiveSignals:
        level === "low"
          ? ["仅提及名称，缺乏归属上下文"]
          : suppressedHigh
            ? [`模型以高置信度归属「${entry.parentAttraction}」（后台装配不自动挂入，待用户确认）`]
            : [`模型疑似归属「${entry.parentAttraction}」（置信度 medium）`],
      negativeSignals: [],
      decidedBy: "system",
    };
  }
  return { stop: created, level, created: true };
}

/** 在 evidence 上追加一条 mention（F5 正文类 bbox=null；OCR 透传模型 bbox），返回 mentionId */
export function pushMention(evidence: SourceEvidence, entry: ParsedEntry): string {
  const mentionId = `m${evidence.mentions.length + 1}`;
  // Task #196：正文明确页码引用随提及落盘（仅正文类证据；截图 OCR 原句中的
  // "p6" 字样与图片队列页码无关，不提取）。空数组 = 无页码（契约统一写 []），
  // 旧证据缺字段同义（读取侧 normalizeMentionPageRefs 归一）。
  const pageRefs = evidence.kind === "note_text" ? extractPageRefs(entry.quote) : [];
  evidence.mentions.push({
    mentionId,
    text: entry.name,
    quoteText: entry.quote,
    bbox: entry.bbox,
    extractedName: entry.name,
    locationHint: entry.locationHint,
    modelSummary: entry.summary,
    // Task #123：强证据父子关系原文依据随提及落盘，planner 素材行透传
    relationEvidence: typeof entry.relationEvidence === "string" && entry.relationEvidence !== "" ? entry.relationEvidence : null,
    // Task #181：明确 Day 归属随提及落盘（仅本地抽取产出；模型路径 null = 未标注）
    dayIndex:
      typeof entry.dayIndex === "number" && Number.isInteger(entry.dayIndex) && entry.dayIndex >= 1
        ? entry.dayIndex
        : null,
    pageRefs,
  });
  return mentionId;
}

/**
 * Task #294：note_tip 落 mention 前的名称归一——地点名取「归属景区」，描述标签不丢信息。
 *
 * 背景：note_tip 的 name 是描述标签（如「门票省钱」「拍照避雷」）。单景点笔记在
 * attributeNoteTips 里已把 name 改写为 canonical 景区名，但多景点笔记保留模型归属时
 * name 仍是标签。pushMention 直接把 name 写进 mention.text / mention.extractedName，
 * 于是 merge 的第二遍（未对齐组）会按标签新建一个独立地点 `n:门票省钱`：
 * - planner 素材里凭空多出一个「地点」行（模型可能把它当可排点位）；
 * - coverageEstimate 把它计成一个「未排素材单元」，虚增可支撑天数（掩盖真稀疏）。
 * 归一后 mention 与所属景区的既有提及合并到同一地点，覆盖估算按名称命中既有已排点位
 * （计入已支撑天），符合「笔记级建议归属该大景点」的 #287 口径。
 *
 * 无可归属景区（parentAttraction=null）时原样返回，不猜测归属。
 */
export function noteTipMentionEntry(entry: ParsedEntry): ParsedEntry {
  const parent = entry.parentAttraction;
  if (parent === null || parent === entry.name) return entry;
  return {
    ...entry,
    name: parent,
    // 描述标签前缀进 summary（与 attributeNoteTips 单景点分支同一写法，幂等）
    summary: entry.summary.includes(entry.name) ? entry.summary : `${entry.name}：${entry.summary}`,
  };
}

/** 计算下一笔记序号：现有 note_text 证据的最大 noteIndex + 1 */
export function nextNoteIndex(trip: Trip): number {
  let max = 0;
  for (const evidence of Object.values(trip.evidences)) {
    if (evidence.kind === "note_text" && evidence.noteIndex !== null) {
      max = Math.max(max, evidence.noteIndex);
    }
  }
  return max + 1;
}

// ===== 通用装配主流程（F5 正文 / Task #51 OCR 共用） =====

/**
 * 旧数据字段防御（Task #90）：历史行程（含 schemaVersion 2 早期数据）可能缺少
 * sourceEvidenceRefs / sourceMentionRefs / childStopRefs 等数组字段，直接
 * .includes / .push 会抛 TypeError，进而使整篇正文抽取失败。装配前就地补齐
 * （幂等），并随本次保存写回，避免同一个旧数据反复引发失败。
 */
function normalizeTripCollections(trip: Trip): void {
  if (!Array.isArray(trip.pendingStopRefs)) trip.pendingStopRefs = [];
  if (!Array.isArray(trip.globalCandidateRefs)) trip.globalCandidateRefs = [];
  if (typeof trip.relationshipSuggestions !== "object" || trip.relationshipSuggestions === null) {
    trip.relationshipSuggestions = {};
  }
  for (const item of Object.values(trip.itemRegistry)) {
    if (!Array.isArray(item.sourceEvidenceRefs)) item.sourceEvidenceRefs = [];
  }
  for (const visit of Object.values(trip.visits)) {
    if (!Array.isArray(visit.childStopRefs)) visit.childStopRefs = [];
    if (!Array.isArray(visit.alternateStopRefs)) visit.alternateStopRefs = [];
    if (!Array.isArray(visit.sourceMentionRefs)) visit.sourceMentionRefs = [];
  }
  for (const stop of Object.values(trip.stops)) {
    if (!Array.isArray(stop.sourceEvidenceRefs)) stop.sourceEvidenceRefs = [];
    if (!Array.isArray(stop.sourceMentionRefs)) stop.sourceMentionRefs = [];
  }

  // 重建容器引用：旧 / 半迁移数据可能丢失 childStopRefs / pendingStopRefs，
  // 仅补齐空数组会让既有 Stop 变成“不属于任何容器”，一致性校验仍会整次拒绝。
  // 因此按 Stop 自身 state / visitRef 反推归属，保证旧行程可自愈后继续抽取。
  const contained = new Set<string>();
  for (const visit of Object.values(trip.visits)) {
    for (const stopId of [...visit.childStopRefs, ...visit.alternateStopRefs]) {
      if (trip.stops[stopId] !== undefined) contained.add(stopId);
    }
  }
  for (const stopId of trip.pendingStopRefs) {
    if (trip.stops[stopId] !== undefined) contained.add(stopId);
  }
  for (const [stopId, stop] of Object.entries(trip.stops)) {
    if (contained.has(stopId)) continue;
    const visit = stop.visitRef !== null ? trip.visits[stop.visitRef] : undefined;
    if (stop.state === "attached" && visit !== undefined) {
      visit.childStopRefs.push(stopId);
    } else {
      // pending，或 attached 但 visitRef 悬空：统一回收到待定区，避免整次保存被拒
      stop.state = "pending";
      stop.visitRef = null;
      trip.pendingStopRefs.push(stopId);
    }
    contained.add(stopId);
  }
  // 容器下标即权威顺序：修正与下标不一致的 order（不一致时保存本就会被拒）
  for (const visit of Object.values(trip.visits)) {
    visit.childStopRefs.forEach((stopId, index) => {
      const stop = trip.stops[stopId];
      if (stop !== undefined) stop.order = index;
    });
    visit.alternateStopRefs.forEach((stopId, index) => {
      const stop = trip.stops[stopId];
      if (stop !== undefined) stop.order = index;
    });
  }
  for (const stopId of trip.pendingStopRefs) {
    const stop = trip.stops[stopId];
    if (stop === undefined) continue;
    stop.order = null;
    stop.visitRef = null;
  }
}

/**
 * Task #249 / #254：FlyAI 对齐函数（可注入）——验证脚本用桩替代真实 CLI；业务路径
 * 缺省 = alignWithFliggyCached（真实搜索 + 别名二次召回，返回完整候选集）。
 * Task #313：末位可选参数 = 本次 run 的查询级在途 Promise memo（并行去重，见
 * alignWithFliggyCached；桩可忽略）。
 */
export type GuidePoiAligner = (
  trip: Trip,
  name: string,
  errors: string[],
  searchCache: Map<string, FlyAIPoi[]>,
  inFlight?: Map<string, Promise<FlyAIPoi[]>>,
) => Promise<PoiAlignment>;

// ===== Task #313：FlyAI 搜索并行调度（搜索并行、装配串行保序） =====

/**
 * 搜索调度器：
 * - "pool"（缺省，生产）：有界并发 worker-pool——最多 concurrency 条搜索在途，
 *   worker 每次认领（按 entry 原索引顺序）前检查剩余预算，耗尽即停止派发新搜索；
 * - "serial"：逐条串行（预算门在每条搜索前）＝ #305 既有语义的调度等价形式。
 *   verify-task305 的虚拟时钟场景注入它：桩 aligner 同步推进时钟，与 Promise
 *   并发调度冲突（并发派发时全部搜索都在 now=0 过预算门，截断不可观测），
 *   串行调度下 5 个既有场景的断言口径原样保留。
 */
export type AssembleSearchScheduler = "pool" | "serial";

/** 单条搜索任务：对 entry 原索引 index 的名称执行 FlyAI 对齐 */
interface AssembleSearchPlan {
  index: number;
  phase: "attraction" | "in_attraction";
  name: string;
}

/** 单条搜索的确定结果（runAlignedSearch 永不 reject） */
interface AssembleSearchSettled {
  alignment: PoiAlignment;
  /** 对齐期间收集的错误文案（apply 阶段按 entry 索引序并入 errors，保序确定） */
  errors: string[];
}

/**
 * 执行单条搜索：对齐函数抛错时按「未命中 + 错误上报」隔离（与既有串行路径的
 * alignWithFliggyCached 失败语义一致：entry 走未对齐兜底，绝不牵连其他 entry）。
 */
async function runAlignedSearch(
  align: GuidePoiAligner,
  trip: Trip,
  plan: AssembleSearchPlan,
  searchCache: Map<string, FlyAIPoi[]>,
  inFlight: Map<string, Promise<FlyAIPoi[]>>,
): Promise<AssembleSearchSettled> {
  const entryErrors: string[] = [];
  try {
    const alignment = await align(trip, plan.name, entryErrors, searchCache, inFlight);
    return { alignment, errors: entryErrors };
  } catch (error) {
    // 不写"飞猪未收录"：失败≠未收录（与 alignWithFliggyCached 首轮失败同文案）
    entryErrors.push(`「${plan.name}」搜索暂不可用，待飞猪匹配`);
    return {
      alignment: { match: null, candidates: [], error: error instanceof Error ? error.message : String(error) },
      errors: entryErrors,
    };
  }
}

/**
 * 有界并发 worker-pool：worker 认领前检查剩余预算（耗尽即停止派发新搜索，
 * 已在途的搜索不打断——网络调用无中止能力，结果照常收下）；认领按索引原子
 * 递增，结果按 plan 原索引写回（确定性保序，并行不引入顺序方差）。
 */
async function runAssembleSearchPool(
  plans: readonly AssembleSearchPlan[],
  concurrency: number,
  ctx: {
    trip: Trip;
    align: GuidePoiAligner;
    searchCache: Map<string, FlyAIPoi[]>;
    inFlight: Map<string, Promise<FlyAIPoi[]>>;
    hasBudget: () => boolean;
  },
): Promise<Map<number, AssembleSearchSettled>> {
  const results = new Map<number, AssembleSearchSettled>();
  if (plans.length === 0) return results;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (cursor >= plans.length) return;
      if (!ctx.hasBudget()) return; // 预算耗尽：停止派发新搜索（未认领 entry 保持未对齐）
      const plan = plans[cursor++];
      // runAlignedSearch 永不 reject，worker 无需再兜底
      results.set(plan.index, await runAlignedSearch(ctx.align, ctx.trip, plan, ctx.searchCache, ctx.inFlight));
    }
  };
  const workerCount = Math.min(concurrency, plans.length);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/** 串行调度（#305 既有语义；虚拟时钟验证场景注入）：预算门在每条搜索前 */
async function runAssembleSearchSerial(
  plans: readonly AssembleSearchPlan[],
  ctx: {
    trip: Trip;
    align: GuidePoiAligner;
    searchCache: Map<string, FlyAIPoi[]>;
    inFlight: Map<string, Promise<FlyAIPoi[]>>;
    hasBudget: () => boolean;
  },
): Promise<Map<number, AssembleSearchSettled>> {
  const results = new Map<number, AssembleSearchSettled>();
  for (const plan of plans) {
    if (!ctx.hasBudget()) break; // 预算耗尽：停止后续搜索（与既有 break 语义一致）
    results.set(plan.index, await runAlignedSearch(ctx.align, ctx.trip, plan, ctx.searchCache, ctx.inFlight));
  }
  return results;
}

/**
 * 逐条目装配：Pass 1（attraction → Item + Visit 壳）→ Pass 2（in_attraction →
 * Item + Stop + 三级归属），mention 全量写入传入的 evidence。
 *
 * 行为与 F5 既有流水线完全一致；OCR 通过 options 开启差异点：
 * - useSuggestedVisitName：parentAttraction 未命中时再尝试模型建议的
 *   suggestedVisitName（F5 不产出该字段，保持 false 行为不变）；
 * - logPrefix：日志前缀（F5 / OCR），便于区分来源；
 * - suppressAttach（Task #96）：high 置信度也不自动挂入所属 Visit（攻略来源
 *   后台异步装配不得改动已生成行程），一律 pending + suggestedVisitRef；
 * - aligner（Task #249 / #254）：可注入 FlyAI 对齐函数（验证脚本用桩，业务路径缺省 =
 *   alignWithFliggyCached）；返回值必须携带完整候选集，存量升级的唯一次性判定
 *   不得基于单条 match。
 * - budgetMs / now（Task #305）：整体装配预算与当前时刻（缺省 ASSEMBLE_BUDGET_MS /
 *   Date.now）。每轮 FlyAI 搜索前检查剩余预算，耗尽即停止后续搜索并返回部分结果。
 * - concurrency / scheduler（Task #313）：FlyAI 搜索有界并发（缺省 env
 *   ASSEMBLE_CONCURRENCY 解析值，默认 6、上限 8）与调度器（缺省 "pool"）。
 *   搜索阶段并行、**trip 装配阶段仍按 entry 原索引串行**（Pass 1 → Pass 2，
 *   mention / Item / Visit / Stop 写入顺序与串行版完全一致，并行不引入顺序方差）；
 *   单 entry 搜索抛错隔离（该 entry 走未对齐兜底，其余照常）；预算语义保留 #305：
 *   worker 认领前检查剩余预算，耗尽即停止派发新搜索、未装配 entry 保持未对齐。
 */
export async function assembleEntries(
  trip: Trip,
  entries: ParsedEntry[],
  evidence: SourceEvidence,
  evidenceId: string,
  errors: string[],
  searchCache: Map<string, FlyAIPoi[]>,
  options: {
    useSuggestedVisitName?: boolean;
    logPrefix?: string;
    suppressAttach?: boolean;
    aligner?: GuidePoiAligner;
    budgetMs?: number;
    now?: () => number;
    concurrency?: number;
    scheduler?: AssembleSearchScheduler;
  } = {},
): Promise<AssembleOutcome> {
  const logPrefix = options.logPrefix ?? "F5";
  const useSuggestedVisitName = options.useSuggestedVisitName === true;
  const suppressAttach = options.suppressAttach === true;
  /** 对齐请求计数（Task #313 去重统计日志用） */
  let alignRequests = 0;
  const alignInner: GuidePoiAligner = options.aligner ?? alignWithFliggyCached;
  const align: GuidePoiAligner = (tripArg, name, entryErrors, cache, inFlight) => {
    alignRequests += 1;
    return alignInner(tripArg, name, entryErrors, cache, inFlight);
  };

  // Task #305：整体装配预算——入口记 deadline，每轮 FlyAI 搜索前检查剩余预算。
  const nowFn = options.now ?? ((): number => Date.now());
  const budgetMs = options.budgetMs ?? ASSEMBLE_BUDGET_MS;
  const deadlineMs = nowFn() + budgetMs;
  let budgetTruncated = false;
  const hasAssembleBudget = (): boolean => nowFn() < deadlineMs;
  /** 预算耗尽只记一次日志（原生 console，符合项目日志规范），后续静默跳过 */
  const noteBudgetTruncation = (where: string): void => {
    if (budgetTruncated) return;
    budgetTruncated = true;
    console.warn(
      `[AI] ${logPrefix} 装配预算 ${Math.round(budgetMs / 1000)}s 耗尽（${where}），停止后续 FlyAI 搜索，` +
        `返回已装配的部分结果；未装配条目保持未对齐 / 未排状态走既有兜底（Task #305）`,
    );
  };

  // Task #313：有界并发（env ASSEMBLE_CONCURRENCY，默认 6、上限 8）＋可注入调度器
  // （"serial" 供虚拟时钟验证场景；生产缺省 "pool"）
  const concurrency = Math.min(
    ASSEMBLE_CONCURRENCY_MAX,
    Math.max(1, options.concurrency ?? resolveAssembleConcurrency()),
  );
  const scheduler = options.scheduler ?? "pool";
  // 单次装配 run 内的查询级 Promise memo（Task #313）：并行下重复 mention 的同名
  // 查询只触网一次；run 结束随本函数作用域丢弃（不做跨 run 缓存）
  const searchInFlight = new Map<string, Promise<FlyAIPoi[]>>();

  const resultItems: AssembleOutcome["items"] = [];
  const resultVisits: AssembleOutcome["visits"] = [];
  const resultStops: AssembleOutcome["stops"] = [];
  const seenItemIds = new Set<string>();
  const seenVisitIds = new Set<string>();
  const seenStopIds = new Set<string>();
  let newVisitCount = 0;
  let reusedVisitCount = 0;
  let attachedStopCount = 0;
  let pendingStopCount = 0;
  let reusedStopCount = 0;

  normalizeTripCollections(trip);

  /**
   * 单条目异常隔离（Task #90）：某一条模型条目的搜索 / 装配抛错时，
   * 只跳过该条并记录可读原因，绝不让整篇正文抽取失败。
   */
  const runEntryIsolated = async (
    entry: ParsedEntry,
    phase: string,
    task: () => Promise<void>,
  ): Promise<void> => {
    try {
      await task();
    } catch (error) {
      const detail = (error instanceof Error ? `${error.name}：${error.message}` : String(error))
        .replace(/\s+/g, " ")
        .slice(0, 120);
      console.error(`[AI] ${logPrefix} 条目「${entry.name}」（${phase}）装配失败，已跳过：`, error);
      errors.push(`「${entry.name}」装配失败，已跳过（${detail}）`);
    }
  };

  /** matched = 本次 FlyAI 命中，或本身已是 fliggy Item（既有 fliggy 未调搜索也视为已收录）；
   *  reused = 复用既有 Item（仅补证据引用，非新建） */
  const trackItem = (item: Item, matched: boolean, reused: boolean): void => {
    if (seenItemIds.has(item.itemId)) return;
    seenItemIds.add(item.itemId);
    resultItems.push({
      itemId: item.itemId,
      name: item.name,
      origin: item.origin,
      matched,
      reused,
      suggestMinutes: item.suggestMinutes,
    });
  };

  /** Visit 归类统计（同批去重）：新建计入新增（新入候选池），既有计入复用（仅补证据） */
  const trackVisit = (visit: Visit, created: boolean, name: string): void => {
    if (seenVisitIds.has(visit.visitId)) return;
    seenVisitIds.add(visit.visitId);
    if (created) newVisitCount += 1;
    else reusedVisitCount += 1;
    resultVisits.push({
      visitId: visit.visitId,
      pointRef: visit.pointRef,
      name,
      kind: visit.kind,
    });
  };

  // Task #107：平台水印 / 泛化词 / 自述非地点的条目在 FlyAI 搜索前直接跳过（省额度）
  // Task #287：note_tip 条目不参与地点淘汰（name 是描述标签而非地名）
  const acceptedEntries: ParsedEntry[] = [];
  const noteTipEntries: ParsedEntry[] = [];
  for (const entry of entries) {
    if (entry.type === "note_tip") {
      noteTipEntries.push(entry);
      continue;
    }
    if (isDisqualifiedEntry(entry)) {
      console.log(
        `[AI] ${logPrefix} 跳过疑似非地点条目「${entry.name}」（平台水印/泛化词/摘要自述非地点）`,
      );
      continue;
    }
    acceptedEntries.push(entry);
  }

  // Pass 0（Task #287）：note_tip 条目 → 只写 mention（证据留痕），不创建 Item/Visit/Stop
  // Task #294：mention 的地点名按归属景区归一（见 noteTipMentionEntry），避免描述标签
  // 在 merge / 覆盖估算里被当成一个独立地点
  for (const entry of noteTipEntries) {
    pushMention(evidence, noteTipMentionEntry(entry));
  }

  /**
   * Task #313：并行搜索阶段执行器——plans 按 entry 原索引升序派发（pool＝有界并发
   * worker 按索引认领；serial＝逐条），结果按索引写回 Map（确定性保序）。
   * 预算语义（#305）：每条搜索派发前检查剩余预算，耗尽即停止派发新搜索——未派发
   * 的 entry 在结果 Map 中缺席，装配阶段据此跳过（不建半成品 Item / 不写 mention）。
   */
  const runSearchPhase = (plans: AssembleSearchPlan[]): Promise<Map<number, AssembleSearchSettled>> => {
    const ctx = { trip, align, searchCache, inFlight: searchInFlight, hasBudget: hasAssembleBudget };
    return scheduler === "serial"
      ? runAssembleSearchSerial(plans, ctx)
      : runAssembleSearchPool(plans, concurrency, ctx);
  };

  /** 取回某 entry 的搜索结果；缺席＝派发前预算已耗尽（未触网） */
  const settledOf = (
    searchResults: Map<number, AssembleSearchSettled>,
    index: number,
    entry: ParsedEntry,
    phase: "attraction" | "in_attraction",
  ): AssembleSearchSettled | null => {
    const settled = searchResults.get(index);
    if (settled !== undefined) {
      // 对齐期间收集的错误按 entry 索引序并入（并行下也确定）
      errors.push(...settled.errors);
      return settled;
    }
    noteBudgetTruncation(`${phase}「${entry.name}」搜索前`);
    return null;
  };

  // Pass 1：attraction 条目 → Item + Visit 壳（ordinary / large_attraction）
  const attractionEntries = acceptedEntries.filter((candidate) => candidate.type === "attraction");
  // Task #313：搜索先行（有界并发）——只为「无既有 fliggy Item 可复用」的条目派发
  // 搜索；复用条目零成本，不受并发 / 预算限制照常装配（#305 既有语义）
  const pass1SearchResults = await runSearchPhase(
    attractionEntries.flatMap((entry, index) =>
      findExistingFliggyItem(trip, entry.name) === undefined
        ? [{ index, phase: "attraction" as const, name: entry.name }]
        : [],
    ),
  );
  for (const [index, entry] of attractionEntries.entries()) {
    // Task #305：本条需要 FlyAI 搜索（无既有 fliggy Item 可复用）且预算已耗尽 →
    // 停止装配循环（已装配的部分结果照常返回；截断日志只记一次）
    const needsSearch = findExistingFliggyItem(trip, entry.name) === undefined;
    const settled = needsSearch ? settledOf(pass1SearchResults, index, entry, "attraction") : null;
    if (needsSearch && settled === null) break;
    await runEntryIsolated(entry, "attraction", async () => {
      // 既有 fliggy Item 直接复用并跳过搜索；custom/未知仍走 FlyAI 对齐
      // （Task #313：对齐已在搜索阶段并行完成，此处按索引取回，trip 写入仍串行保序）
      const existingFliggy = findExistingFliggyItem(trip, entry.name);
      const alignment =
        existingFliggy !== undefined ? emptyPoiAlignment() : (settled?.alignment ?? emptyPoiAlignment());
      const poi = alignment.match;
      // Task #249：区域消歧——纯片区 / 住宿段落（「亚龙湾」「亚龙湾住宿」）不创建
      // custom 区域点位；仅当「即将新建 custom」时判定，真实供应商 POI（如飞猪
      // 「大东海」「海棠湾」）与既有实体零影响（边界见 isAreaOnlyPlaceName）
      if (existingFliggy === undefined && poi === null) {
        const reusable = findReusableItem(trip, entry, null);
        if (reusable === undefined && isAreaOnlyPlaceName(entry.name, trip.destination?.city)) {
          console.log(
            `[AI] ${logPrefix} 区域消歧：跳过纯片区 / 住宿描述「${entry.name}」（Task #249，不创建 custom 区域点位）`,
          );
          return;
        }
        // Task #196：自定义打卡点过滤——仅「未命中飞猪且不会复用既有 Item
        // （即将新建 custom 点位）」时判定；真实 POI 与既有实体零影响
        if (reusable === undefined && shouldRejectCustomCheckpoint(entry)) {
          console.log(
            `[AI] ${logPrefix} 打卡点过滤：跳过泛化/疑似编造自定义点位「${entry.name}」（Task #196）`,
          );
          return;
        }
      }
      pushMention(evidence, entry); // attraction 条目的 mention 由证据承载（不落 Stop 引用）
      const { item, reused } = ensureItem(trip, entry, alignment, evidenceId);
      trackItem(item, poi !== null || item.origin === "fliggy", reused);
      const shell = ensureVisitShell(trip, item, entry.scale === "large" ? "large_attraction" : "ordinary");
      trackVisit(shell.visit, shell.created, item.name);
    });
  }

  // Pass 2：in_attraction 条目 → Item + Stop + 三级归属（依赖 Pass 1 的 Visit 壳）
  const inAttractionEntries = acceptedEntries.filter((candidate) => candidate.type === "in_attraction");
  // Task #313：同 Pass 1——自身名称搜索先行（有界并发；Pass 1 已建的 fliggy Item
  // 在此可见，复用条目不派发搜索）；所属景区二次搜索依赖装配态，仍在下方串行门控
  const pass2SearchResults = await runSearchPhase(
    inAttractionEntries.flatMap((entry, index) =>
      findExistingFliggyItem(trip, entry.name) === undefined
        ? [{ index, phase: "in_attraction" as const, name: entry.name }]
        : [],
    ),
  );
  for (const [index, entry] of inAttractionEntries.entries()) {
    // Task #305：同 Pass 1——本条需要搜索且预算耗尽即停止装配，返回部分结果
    const needsSearch = findExistingFliggyItem(trip, entry.name) === undefined;
    const settled = needsSearch ? settledOf(pass2SearchResults, index, entry, "in_attraction") : null;
    if (needsSearch && settled === null) break;
    await runEntryIsolated(entry, "in_attraction", async () => {
      const existingFliggy = findExistingFliggyItem(trip, entry.name);
      const alignment =
        existingFliggy !== undefined ? emptyPoiAlignment() : (settled?.alignment ?? emptyPoiAlignment());
      const poi = alignment.match;
      // Task #249：区域消歧（同 Pass 1）
      if (existingFliggy === undefined && poi === null) {
        const reusable = findReusableItem(trip, entry, null);
        if (reusable === undefined && isAreaOnlyPlaceName(entry.name, trip.destination?.city)) {
          console.log(
            `[AI] ${logPrefix} 区域消歧：跳过纯片区 / 住宿描述「${entry.name}」（Task #249，不创建 custom 区域点位）`,
          );
          return;
        }
        // Task #196：自定义打卡点过滤（同 Pass 1；仅将新建 custom 时判定）
        if (reusable === undefined && shouldRejectCustomCheckpoint(entry)) {
          console.log(
            `[AI] ${logPrefix} 打卡点过滤：跳过泛化/疑似编造自定义点位「${entry.name}」（Task #196）`,
          );
          return;
        }
      }
      const mentionId = pushMention(evidence, entry);
      const { item, reused } = ensureItem(trip, entry, alignment, evidenceId);
      trackItem(item, poi !== null || item.origin === "fliggy", reused);

      // 所属 Visit：优先 parentAttraction；OCR 再尝试 suggestedVisitName；
      // 两者均未命中且 parentAttraction 非空时自动补建 large_attraction 壳
      let parentVisit = findVisitByItemName(trip, entry.parentAttraction ?? "");
      if (parentVisit === null && useSuggestedVisitName && entry.suggestedVisitName !== null) {
        parentVisit = findVisitByItemName(trip, entry.suggestedVisitName);
      }
      if (parentVisit === null && entry.parentAttraction !== null) {
        const parentExistingFliggy = findExistingFliggyItem(trip, entry.parentAttraction);
        // Task #305：所属景区二次搜索也是 FlyAI 触网——预算耗尽则不再搜索，按未命中
        // 降级（parentAlignment.match=null → 既有兜底：非纯片区则补建 custom 大景区壳，
        // 内部玩法落 pending），绝不编造供应商字段
        let parentAlignment: PoiAlignment;
        if (parentExistingFliggy !== undefined) {
          parentAlignment = emptyPoiAlignment();
        } else if (!hasAssembleBudget()) {
          noteBudgetTruncation(`所属景区「${entry.parentAttraction}」搜索前`);
          parentAlignment = emptyPoiAlignment();
        } else {
          parentAlignment = await align(trip, entry.parentAttraction, errors, searchCache, searchInFlight);
        }
        const parentPoi = parentAlignment.match;
        // Task #249：纯片区父级（如「亚龙湾」）不补建 custom 大景区壳——避免变相
        // 创建区域 PoI；内部玩法仍落 pending（无建议归属），由用户确认归属
        const parentWouldBeCustom =
          parentExistingFliggy === undefined &&
          parentPoi === null &&
          findReusableItem(trip, { name: entry.parentAttraction }, null) === undefined;
        if (parentWouldBeCustom && isAreaOnlyPlaceName(entry.parentAttraction, trip.destination?.city)) {
          console.log(
            `[AI] ${logPrefix} 区域消歧：所属片区「${entry.parentAttraction}」不补建大景区壳（Task #249）`,
          );
        } else {
          console.log(`[AI] ${logPrefix} 所属景区「${entry.parentAttraction}」未显式提取，自动补建大景区壳`);
          const parent = ensureItem(
            trip,
            {
              name: entry.parentAttraction,
              type: "attraction",
              parentAttraction: null,
              scale: "large",
              confidence: "low",
              suggestMinutes: null,
              locationHint: null,
              quote: entry.quote,
              summary: "作为所属景区自动补建",
              ticketRelation: "unknown",
              suggestedVisitName: null,
              bbox: null,
            },
            parentAlignment,
            evidenceId,
          );
          trackItem(parent.item, parentPoi !== null || parent.item.origin === "fliggy", parent.reused);
          const parentShell = ensureVisitShell(trip, parent.item, "large_attraction");
          trackVisit(parentShell.visit, parentShell.created, parent.item.name);
        }
      }

      const { stop, level, created } = ensureStopAndPlace(trip, entry, item, evidenceId, mentionId, parentVisit, {
        suppressAttach,
      });
      if (created) {
        resultStops.push({
          stopId: stop.stopId,
          name: stop.matchedPointRef !== null ? item.name : stop.customName ?? entry.name,
          state: stop.state,
          visitRef: stop.visitRef,
          suggestedVisitRef: stop.suggestedVisitRef,
          level,
        });
        if (stop.state === "attached") attachedStopCount += 1;
        else pendingStopCount += 1;
      } else if (!seenStopIds.has(stop.stopId)) {
        // 既有 Stop：只补充了证据引用（ensureStopAndPlace 内已去重追加），不重复统计
        seenStopIds.add(stop.stopId);
        reusedStopCount += 1;
      }
    });
  }

  // Task #313：run 内查询去重统计（重复 mention 同查询只触网一次）；memo 随 run 结束即弃。
  // dedupeHits＝对齐请求次数 − 唯一查询数：>0 即本次 run 有重复查询被 memo 拦下。
  if (alignRequests > 0 && searchInFlight.size > 0) {
    const dedupeHits = alignRequests - searchInFlight.size;
    console.log(
      `[AI] ${logPrefix} 装配搜索（Task #313）：对齐请求 ${alignRequests} 次 → 唯一查询 ${searchInFlight.size} 条` +
        `（去重命中 ${dedupeHits}；scheduler=${scheduler}，concurrency=${concurrency}）`,
    );
  }

  return {
    items: resultItems,
    visits: resultVisits,
    stops: resultStops,
    newVisitCount,
    reusedVisitCount,
    attachedStopCount,
    pendingStopCount,
    reusedStopCount,
  };
}
