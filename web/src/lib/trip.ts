/**
 * web 派生工具集 —— 从 v1.1 Trip（itemRegistry / visits / stops / refs）推导视图数据。
 *
 * 约定：
 * - 只读纯函数，不修改 Trip；
 * - 组件不得直接遍历 days / visits / stops Record，统一经本模块按 refs 取数；
 * - 「未知」一律保留 null（与 shared 契约一致，不当作 0 展示）。
 */

import type {
  Day,
  EntityRef,
  HotelCandidate,
  Item,
  LodgingPlan,
  Stop,
  Trip,
  Visit,
} from "@goplay/shared";
import { SCHEMA_VERSION, recomputeDayTimeline } from "@goplay/shared";

/** v1.1 结构校验：schemaVersion 与关键字段存在性（启动加载与缓存恢复的防御闸门） */
export function isV11Trip(value: unknown): value is Trip {
  if (value === null || typeof value !== "object") return false;
  const trip = value as Partial<Trip>;
  if (trip.schemaVersion !== SCHEMA_VERSION) return false;
  return (
    typeof trip.tripId === "string" &&
    typeof trip.version === "number" &&
    Array.isArray(trip.dayRefs) &&
    trip.days !== null && typeof trip.days === "object" &&
    trip.visits !== null && typeof trip.visits === "object" &&
    trip.stops !== null && typeof trip.stops === "object" &&
    trip.itemRegistry !== null && typeof trip.itemRegistry === "object" &&
    Array.isArray(trip.globalCandidateRefs) &&
    Array.isArray(trip.pendingStopRefs) &&
    Array.isArray(trip.constraints)
  );
}

/** 按 dayRefs 顺序返回有序 Day 数组（唯一合法的天遍历方式）
 *  签名只取 Trip 的结构子集：只读分享页的 SharedTrip（Task #205）没有候选池等字段，
 *  但天 / visits 形状一致，可直接复用本模块的全部派生函数。 */
export function orderedDays(trip: Pick<Trip, "dayRefs" | "days">): Day[] {
  return trip.dayRefs
    .map((dayId) => trip.days[dayId])
    .filter((day): day is Day => day !== undefined);
}

/** 某天的城市级 Visit 列表（按 scheduleVisitRefs 顺序；悬空引用过滤） */
export function dayVisits(trip: Pick<Trip, "visits">, day: Day): Visit[] {
  return day.scheduleVisitRefs
    .map((visitId) => trip.visits[visitId])
    .filter((visit): visit is Visit => visit !== undefined);
}

/**
 * Task #348（PD 2026-11-04 拍板）：父卡渲染形态的唯一判定——由岛内子玩法驱动。
 * 岛内子玩法（childStopRefs）≥1 才渲染大景区父卡形态；0 子玩法一律渲染普通卡
 * （鹿回头类「有身份没内容」的空壳父卡自动消失）。纯展示层约束：存量数据零迁移、
 * 可逆——回滚只需让渲染分支改回读 kind（判定收敛在本函数单点）。
 *
 * visit.kind === "large_attraction" 保留为「先验」（白名单 / 5A / AI scale 三路赋值
 * 与消费一律不动），只影响系统主动性：攻略抽出子玩法时是否自动采纳、搜索添加时的
 * 前瞻提示（poiAttractionLabel）、归入大景点的目标过滤——不再决定渲染形态。
 * 数据不变量：合法数据中 childStopRefs ≥1 蕴含 kind === "large_attraction"
 * （只有大景区壳能挂子玩法），故本判定不会把普通景点误升为父卡。
 */
export function isParentCardVisit(visit: Pick<Visit, "childStopRefs"> | null | undefined): boolean {
  return (visit?.childStopRefs?.length ?? 0) > 0;
}

/** Visit 关联的 Item 主数据 */
export function visitItem(trip: Pick<Trip, "itemRegistry">, visit: Visit): Item | null {
  return trip.itemRegistry[visit.pointRef] ?? null;
}

/** Visit 可读名称（itemRegistry 主数据名优先） */
export function visitDisplayName(trip: Pick<Trip, "itemRegistry">, visit: Visit): string {
  return trip.itemRegistry[visit.pointRef]?.name ?? visit.visitId;
}

/** Stop 可读名称：命中飞猪用主数据名，否则自定义名 */
export function stopDisplayName(trip: Pick<Trip, "itemRegistry">, stop: Stop): string {
  if (stop.matchedPointRef !== null) {
    return trip.itemRegistry[stop.matchedPointRef]?.name ?? stop.customName ?? stop.stopId;
  }
  return stop.customName ?? stop.stopId;
}

/** Stop 的攻略原文摘要（弱入口预览）：优先用户原文 / OCR 原句 */
export function stopEvidenceSummary(trip: Trip, stop: Stop): string | null {
  for (const evidenceId of stop.sourceEvidenceRefs) {
    const evidence = trip.evidences[evidenceId];
    if (evidence === undefined) continue;
    for (const mention of evidence.mentions) {
      const text = mention.quoteText !== "" ? mention.quoteText : mention.text;
      if (text !== "") return text;
    }
  }
  return null;
}

/**
 * Task #77 地址文案（VisitCard / StopRow 共用同一展示契约）：
 * 1. 飞猪原始地址（fliggyAddress）→ 直接展示，不加来源标注；
 * 2. 用户在自定义点位表单手填的地址（userAddress，Task #221）→ 直接展示，
 *    用户自己填的不加「AI 提取」声明；
 * 3. 无飞猪地址但有 AI 提取的位置描述（aiAddress：自定义 Item.address /
 *    Stop.locationHint）→ 展示并声明来源，提醒用户可确认是否准确；
 * 4. 都没有 → 如实提示，不用标签 / 占位文案冒充地址。
 */
export function addressText(
  fliggyAddress: string | null,
  aiAddress: string | null,
  userAddress: string | null = null,
): string {
  const fliggy = fliggyAddress?.trim() ?? "";
  if (fliggy !== "") return fliggy;
  const user = userAddress?.trim() ?? "";
  if (user !== "") return user;
  const ai = aiAddress?.trim() ?? "";
  if (ai !== "") return `${ai}，为AI提取，可确认是否准确`;
  return "暂无法获知详细地址";
}

/**
 * visitMode → 展示标签；ordinary 恒 custom。
 *
 * Task #344（PD：「每个大景区都标了『全天』…把『全天』二字去掉」）：full_day 不再产出
 * 「全天」，返回空串，调用方经 joinTagParts 按段过滤后只留基础段——父卡只剩「大景区」，
 * Day 条 / 分享页只剩景区名；「半天」「自定义」两个取值原样保留。
 *
 * 仅展示层去字：visitMode 数据本身、dayRoles 推导、server 侧 prompt 与规则语义一律未动
 * （shared/src 对「全天」零命中，本函数不被 server 消费，故直接改 web）。
 */
export function visitModeLabel(visit: Visit): string {
  if (visit.visitMode === "half_day") return "半天";
  if (visit.visitMode === "full_day") return "";
  return "自定义";
}

/**
 * Task #344：标签分段拼接——空段（null / undefined / 空串 / 纯空白）自动丢弃，
 * 避免 visitModeLabel 对 full_day 返回空串后留下悬空的「· 」分隔符。
 * 与项目既有 `[a, b].filter((part) => part !== "").join(" · ")` 同一口径，
 * 抽成函数供 4 个 visitModeLabel 调用点共用。
 */
export function joinTagParts(...parts: Array<string | null | undefined>): string {
  return parts
    .filter((part): part is string => typeof part === "string" && part.trim() !== "")
    .join(" · ");
}

/** Visit 所在天号（dayRef 反查）；未排期返回 null */
export function visitDayIndexOf(trip: Trip, visit: Visit): number | null {
  if (visit.dayRef === null) return null;
  return trip.days[visit.dayRef]?.dayIndex ?? null;
}

/** 加载 / 恢复后重算全部天的时间轴（服务端不保证时间字段新鲜，前端统一推导） */
export function recomputeAllDays(trip: Trip): Trip {
  let next = trip;
  for (const day of orderedDays(trip)) {
    next = recomputeDayTimeline(next, day.dayIndex);
  }
  return next;
}

/** globalPool 中的 point 主数据（保持 refs 顺序） */
export function poolPoints(trip: Trip): Item[] {
  return trip.globalCandidateRefs
    .filter((ref): ref is Extract<EntityRef, { kind: "point" }> => ref.kind === "point")
    .map((ref) => trip.itemRegistry[ref.id])
    .filter((item): item is Item => item !== undefined);
}

/** globalPool 中的大景区 Visit 壳 */
export function poolVisits(trip: Trip): Visit[] {
  return trip.globalCandidateRefs
    .filter((ref): ref is Extract<EntityRef, { kind: "visit" }> => ref.kind === "visit")
    .map((ref) => trip.visits[ref.id])
    .filter((visit): visit is Visit => visit !== undefined);
}

/** pendingPool 待定加入的 Stop 列表 */
export function pendingStops(trip: Trip): Stop[] {
  return trip.pendingStopRefs
    .map((stopId) => trip.stops[stopId])
    .filter((stop): stop is Stop => stop !== undefined);
}

/** 候选池统一条目（point 与大景区壳合并，保持 refs 顺序） */
export interface PoolEntry {
  ref: EntityRef;
  name: string;
  /** point 的主数据；visit 壳为其 pointRef 的主数据 */
  item: Item | null;
  kind: "ordinary" | "large_attraction";
  /** 移入候选区时的原位置（「原 DayN」展示） */
  removedFrom: { dayIndex: number; order: number } | null;
}

export function poolEntries(trip: Trip): PoolEntry[] {
  const entries: PoolEntry[] = [];
  for (const ref of trip.globalCandidateRefs) {
    if (ref.kind === "point") {
      const item = trip.itemRegistry[ref.id];
      if (item === undefined) continue;
      entries.push({ ref, name: item.name, item, kind: "ordinary", removedFrom: null });
    } else if (ref.kind === "visit") {
      const visit = trip.visits[ref.id];
      if (visit === undefined) continue;
      const item = trip.itemRegistry[visit.pointRef] ?? null;
      entries.push({
        ref,
        name: item?.name ?? ref.id,
        item,
        kind: visit.kind,
        removedFrom: visit.removedFrom,
      });
    }
  }
  return entries;
}

/** 拥有备选玩法的大景区列表（候选池「备选玩法」区展示用） */
export function visitsWithAlternates(trip: Trip): Visit[] {
  return Object.values(trip.visits).filter((visit) => visit.alternateStopRefs.length > 0);
}

/** 候选池推荐条目（交互优化 Module F：统一面板 day 上下文首屏数据源） */
export interface CandidateSuggestion {
  /** 候选区引用（point 主数据 / visit 壳），排入目标天即用此引用 */
  ref: Extract<EntityRef, { kind: "point" } | { kind: "visit" }>;
  name: string;
  /** 提到该景点的可用攻略来源数（active 且 ready/partial）；0 = 非攻略来源（搜索 / 移出） */
  sourceCount: number;
  kind: "ordinary" | "large_attraction";
  /** 从行程移入候选区时的原天号（「原 DayN」展示；一直在池中为 null） */
  removedFrom: { dayIndex: number; order: number } | null;
  /** 候选地址（Item.address 透传：飞猪地址，或 custom 点位的 AI 位置提示）；null = 无地址 */
  address: string | null;
}

// ===== 候选脏数据防御（Task #107：历史数据展示层兜底） =====

/**
 * 平台 / 媒体词（精确匹配）：抽取时把 OCR 水印、平台角标当成点位的历史脏数据。
 * 与 server/src/ai/assemble.ts 的 PLATFORM_OR_MEDIA_WORDS 保持同源口径。
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
 * 纯泛化地理类型词（仅 exact 匹配过滤）：不能误杀「后海海滩」「西岛码头」
 * 「第一市场」等具体名称；与 server/src/ai/assemble.ts 保持同源口径。
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

/** 「当前城市 + 单个泛化后缀」可疑组合的后缀（如 三亚岛、三亚湾） */
const CITY_GENERIC_SUFFIXES = new Set([...GENERIC_PLACE_WORDS, "城", "村", "镇", "山", "湖", "河", "江", "区"]);

/** 模型自述「不是地点」的标记词（水印 / 广告 / logo） */
const NON_PLACE_MARKERS = ["水印", "非实际地点", "广告", "logo"];

/** 候选脏数据判定用归一化：去括号内容、空白与常见分隔符，英文转小写 */
function normalizeCandidateName(name: string): string {
  return name
    .replace(/[（(【\[{][^）)】\]}]*(?:[）)】\]}])/g, "")
    .replace(/[\s·・|｜/\\]+/g, "")
    .trim()
    .toLowerCase();
}

/** 平台 / 媒体词或纯泛化地理类型词（exact 判定，不做 includes） */
export function isPlatformOrGenericCandidateName(name: string): boolean {
  const normalized = normalizeCandidateName(name);
  if (normalized === "") return false;
  return PLATFORM_OR_MEDIA_WORDS.has(normalized) || GENERIC_PLACE_WORDS.has(normalized);
}

/** 名称是否为「当前城市 + 单个泛化后缀」的可疑组合（如 三亚岛、三亚湾） */
export function isCityPlusGenericCandidateName(name: string, city: string): boolean {
  const normalized = normalizeCandidateName(name);
  const normalizedCity = normalizeCandidateName(city);
  if (normalized === "" || normalizedCity === "") return false;
  if (!normalized.startsWith(normalizedCity)) return false;
  const suffix = normalized.slice(normalizedCity.length);
  return suffix !== "" && CITY_GENERIC_SUFFIXES.has(suffix);
}

/**
 * 该 Item 关联证据的模型摘要是否自述「非实际地点」（水印 / 广告 / logo）。
 * 一条 evidence 可能包含多个 mention：只认与 Item 名称对应的那段 mention，
 * 避免同篇笔记里一个水印条目把其他正常点位一起滤掉。
 */
function hasNonPlaceSummary(trip: Trip, item: Item): boolean {
  const itemName = normalizeCandidateName(item.name);
  for (const evidenceId of item.sourceEvidenceRefs ?? []) {
    const evidence = trip.evidences?.[evidenceId];
    if (evidence === undefined) continue;
    for (const mention of evidence.mentions ?? []) {
      const mentionName = normalizeCandidateName(mention.extractedName ?? mention.text ?? "");
      if (mentionName === "" || mentionName !== itemName) continue;
      const summary = mention.modelSummary?.toLowerCase() ?? "";
      if (summary !== "" && NON_PLACE_MARKERS.some((marker) => summary.includes(marker))) return true;
    }
  }
  return false;
}

/**
 * 历史脏数据兜底（Task #107，只影响展示，不删除数据）：
 * 1. 平台 / 媒体词、纯泛化地理类型词（exact）；
 * 2. 模型摘要自述水印 / 广告 / 非实际地点；
 * 3. custom 且无 provider / address / coords / category 的「城市 + 泛化后缀」组合。
 * 有飞猪 provider 或地址的具体点位（如三亚湾）不受第 3 条影响。
 */
function isDisqualifiedCandidate(trip: Trip, entry: PoolEntry): boolean {
  if (isPlatformOrGenericCandidateName(entry.name)) return true;
  const item = entry.item;
  if (item === null) return false;
  if (hasNonPlaceSummary(trip, item)) return true;
  const noMetadata =
    item.origin === "custom" &&
    item.providerId == null &&
    (item.address?.trim() ?? "") === "" &&
    item.coords == null &&
    (item.category?.trim() ?? "") === "";
  return noMetadata && isCityPlusGenericCandidateName(entry.name, trip.destination?.city ?? "");
}

/**
 * 候选池推荐清单：globalCandidateRefs（攻略提到但还没排进任何 Day 的景点 +
 * 从行程移出的候选）逐条统计「N 篇攻略推荐」。
 *
 * 来源计数走 Item.sourceEvidenceRefs：服务端抽取装配（ensureItem）在复用命中时
 * 逐条追加证据引用，而证据与来源一一对应（source.evidenceRefs），据此反查提到
 * 该景点的来源数；仅统计 active 且 ready/partial 的来源（与排版可用口径一致）。
 * 结果按推荐数降序（稳定排序，同数保持池内顺序），推荐最多的候选排在最前。
 */
export function candidateSuggestions(trip: Trip): CandidateSuggestion[] {
  const sourceIdByEvidence = new Map<string, string>();
  for (const source of Object.values(trip.guideSources ?? {})) {
    if (source === null || !source.active) continue;
    if (source.status !== "ready" && source.status !== "partial") continue;
    for (const evidenceId of source.evidenceRefs) {
      sourceIdByEvidence.set(evidenceId, source.sourceId);
    }
  }
  return poolEntries(trip)
    .filter((entry) => !isDisqualifiedCandidate(trip, entry))
    .map((entry): CandidateSuggestion => {
      const sourceIds = new Set<string>();
      for (const evidenceId of entry.item?.sourceEvidenceRefs ?? []) {
        const sourceId = sourceIdByEvidence.get(evidenceId);
        if (sourceId !== undefined) sourceIds.add(sourceId);
      }
      const address = entry.item?.address?.trim() ?? "";
      return {
        ref: entry.ref as CandidateSuggestion["ref"],
        name: entry.name,
        sourceCount: sourceIds.size,
        kind: entry.kind,
        removedFrom: entry.removedFrom,
        address: address !== "" ? address : null,
      };
    })
    .sort((left, right) => right.sourceCount - left.sourceCount);
}

/** 某天住宿计划（key = String(dayIndex)；无计划返回 null） */
export function dayLodging(trip: Pick<Trip, "lodgings">, dayIndex: number): Trip["lodgings"][string] | null {
  return trip.lodgings[String(dayIndex)] ?? null;
}

/**
 * S1-7 rev2 兼容读取：当前展示酒店 = lodging.hotelRefs[0] + trip.hotelRegistry 查表。
 * 多候选契约暂取首个展示（S3 再实现完整候选列表）；无引用或引用悬空回退 null，
 * 由调用方降级为片区占位展示（不猜测、不伪造）。
 */
export function getPrimaryHotel(
  trip: Pick<Trip, "hotelRegistry">,
  plan: LodgingPlan | null,
): HotelCandidate | null {
  if (plan === null) return null;
  const hotelId = plan.hotelRefs[0];
  if (hotelId === undefined) return null;
  return trip.hotelRegistry[hotelId] ?? null;
}
