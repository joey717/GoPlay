/**
 * F11/F5 上下文组装：把 Trip 压缩为百炼 Managed Agent 的单条 input 文本。
 *
 * 设计约束（PRD v1.1 F11「意图编排」/ §9.5 输出契约）：
 * - 只携带模型决策所需字段，完整 Trip JSON 直接投喂浪费 token 且引入噪音；
 * - 八种操作的 JSON schema 与输出契约作为系统指令嵌入 prompt
 *   （Managed Agent 会话无独立 system 通道，走 user message 承载）；
 * - 契约文本与 shared/src/types/operations.ts 的 OperationSet（含 baseVersion、
 *   EntityRef/ContainerRef 寻址）严格一致；模型输出由 server/src/ai/pipeline.ts
 *   解析并过四条护栏，prompt 规则只是前置引导；
 * - 【Day 编排】按 Day → Visit → Stop 层级序列化（大景区内部玩法始终展开），
 *   让模型能用真实 id 构造 EntityRef/ContainerRef。
 */

import { collectAreaPlaceholderVisitIds, parseMentionRef, attributePoiArea, computeDayGeoStats, deriveDepartureDayCutoff } from "@goplay/shared";
import type { Day, DraftScope, EntityRef, HotelCandidate, Stop, Trip, Visit } from "@goplay/shared";
import { SCHEDULE_GEO_RULES_TEXT } from "./scheduleRules.js";

// ===== 固定规则文本（system 指令，嵌入 prompt 顶部） =====

const FIXED_RULES_TEXT = `你是旅行行程编排引擎。根据【用户意图】修改当前行程，输出一个 OperationSet JSON 对象。以下输出契约必须严格遵守。

一、OperationSet 顶层结构（五个字段齐全）：
{"baseVersion": <【版本】中的数字>, "operations": [...], "unplaced": [], "proposedNew": [], "clarify": null}
- baseVersion 必须原样回显【版本】行给出的数字，不得改动或省略；版本不一致时服务端会拒绝整批操作。

二、operations 支持八种操作（每条必须携带 reason）：
1. plan 整排：{"op":"plan","scopeRef":{"kind":"day","dayIndex":2} 或 {"kind":"allDays"},"assignments":[{"subjectRef":{"kind":"visit","id":"visit_x"},"containerRef":{"kind":"day","dayIndex":2},"order":0}],"reason":"..."}
   - scopeRef 声明影响范围：单天用 {"kind":"day","dayIndex":N}；全程重排用 {"kind":"allDays"}（仅当用户明确提出全部/整个行程时使用，服务端会挂起待用户确认）
   - 安排大景区/普通景点：subjectRef={"kind":"visit","id":"..."} 或 {"kind":"point","id":"..."}（候选区点位进入 Day 时自动创建 Visit），containerRef={"kind":"day","dayIndex":N}；order 从 0 开始
   - 安排大景区内部玩法：subjectRef={"kind":"stop","id":"..."}，containerRef={"kind":"visit","id":"..."}
   - plan 未提及的既有项保持原相对顺序追加在尾部，不会丢失
2. move 同容器改序：{"op":"move","subjectRef":{"kind":"visit","id":"..."},"containerRef":{"kind":"day","dayIndex":1},"toOrder":0,"reason":"..."}（内部玩法用 containerRef={"kind":"visit","id":"..."}）
3. transfer 转移 / 归类纠正：{"op":"transfer","subjectRef":{...},"fromContainerRef":{...},"toContainerRef":{...},"toOrder":null,"reason":"..."}
   - 候选区点位/大景区壳 → 某天：toContainerRef={"kind":"day","dayIndex":N}
   - 大景区内部玩法 → 备选玩法：toContainerRef={"kind":"visitPool","visitId":"..."}；反向回主路线 containerRef 用 {"kind":"visit","id":"..."}
   - 大景区内部玩法 → 待定加入：toContainerRef={"kind":"pendingPool"}
   - 内部玩法换景区（归类纠正）不能改变所在日期；内部玩法不支持跨天移动
4. remove 移除（敏感操作，照常输出，服务端自动转提案）：{"op":"remove","subjectRef":{...},"fromContainerRef":{...},"reason":"..."}
5. setTime 改时间：{"op":"setTime","subjectRef":{...},"value":"09:30","target":"start" 或 "end" 或 "dayDepart","reason":"..."}
   - target="dayDepart" 时 subjectRef={"kind":"day","dayIndex":N}；start/end 仅适用于 visit 与 lodging
6. setDuration 改时长：{"op":"setDuration","subjectRef":{...},"minutes":120,"reason":"..."}（对内部玩法即建议时长）
7. setPurchase 改购买状态（敏感操作）：{"op":"setPurchase","subjectRef":{...},"value":"bought" 或 "toBuy" 或 "unknown" 或 "noTicket","reason":"..."}
8. lock 锁定或解锁（敏感操作）：{"op":"lock","subjectRef":{...},"value":true,"reason":"..."}

三、EntityRef 写法（subjectRef 统一使用）：
- 天：{"kind":"day","dayIndex":N}；点位主数据：{"kind":"point","id":"item_x"}；到访：{"kind":"visit","id":"visit_x"}；内部玩法：{"kind":"stop","id":"stop_x"}；住宿：{"kind":"lodging","dayIndex":N}
- id 只能使用【Day 编排】【全局候选区】【待定加入】中出现的 id，禁止编造。

四、索引与适用限制：
- dayIndex 从 1 开始；order / toOrder 从 0 开始；越界索引会被服务端直接拒绝，不要猜测；
- 内部玩法（stop）不支持 setTime / setPurchase / lock，也不支持跨天移动——输出这些操作只会被拒绝并展示原因；
- 大景区整体支持全部八种操作；内部玩法仅支持 plan / move / remove / setDuration 与同天归类纠正 transfer。

五、保护规则：
- locked=true 的到访不可 move / transfer / remove / setTime / setDuration（setPurchase 允许）；
- purchaseState="bought" 的到访不可 remove / transfer；
- userAdjusted=true 的到访若未被本批 plan 显式安排，执行时将保留原位置（不会丢失）。

六、确认分流：
- remove / setPurchase / lock 属敏感操作，模型照常输出，服务端自动转为提案由用户确认；
- scopeRef={"kind":"allDays"} 或批内 plan 覆盖多个 dayIndex 时，服务端整批挂起待用户确认，同样照常输出即可。

七、proposedNew 与 unplaced：
- 行程与候选区都没有合适点位时，通过 proposedNew 提出新点位（服务端会经真实搜索验证后加入【全局候选区】；未命中时以自定义点位入池），最多提议 3 个；
- proposedNew 每项格式：{"name":"点位本名","reason":"位置或推荐描述，如“距第一市场约3公里，登顶可俯瞰三亚全景”；确实无法给出时为 null"}；
- 同一批 operations 不得引用 proposedNew 中尚未存在的新点位；
- 【待定加入】中的内部玩法由用户确认归类，模型不要自动 plan/transfer 挂入（服务端会拒绝）；
- 一天排不下的项放入 unplaced：{"subjectRef":{...},"reason":"..."}，不要硬塞。

八、输出格式：
- 输出必须是合法 JSON，不要包裹在 markdown code block 中，不要输出任何解释性文字；
- 如果意图不明确、需要反问用户，设置 clarify 字段为问题文本且 operations 输出空数组；能明确执行时 clarify 必须为 null。

${SCHEDULE_GEO_RULES_TEXT}`;

// ===== 行程序列化（Day → Visit → Stop 层级） =====

function formatTimeSpan(visit: Visit): string {
  const start = visit.startTime ?? "null";
  const end = visit.endTime ?? "null";
  return `${start}-${end}`;
}

function formatStopLine(prefix: string, stop: Stop, trip: Trip): string {
  // Task #316：补中文展示名（matchedPointRef→itemRegistry 名称，或 customName），
  // 让模型不再仅靠 UUID 辨识 stop；附行内短标注禁止对其输出 setTime/setPurchase/lock。
  const displayName =
    stop.matchedPointRef !== null
      ? trip.itemRegistry[stop.matchedPointRef]?.name ?? stop.customName ?? "?"
      : stop.customName ?? "?";
  const ref =
    stop.matchedPointRef !== null ? `matched=${stop.matchedPointRef}` : `custom`;
  const hint = stop.locationHint === null ? "" : ` | hint=${stop.locationHint}`;
  return `${prefix}[stop] id=${stop.stopId} | ${displayName} | ${ref} | order=${stop.order ?? "null"} | suggest=${stop.suggestMinutes ?? "null"}min | ticket=${stop.ticketRelation}${hint} | ⛔勿输出setTime/setPurchase/lock`;
}

function formatVisitSection(
  trip: Trip,
  visit: Visit,
  slim: boolean = false,
  areaPlaceholderIds?: ReadonlySet<string>,
): string[] {
  const item = trip.itemRegistry[visit.pointRef];
  const name = item?.name ?? visit.pointRef;
  // Task #253：区域占位点位只是区域标题（如自定义「亚龙湾」），不是可游玩 POI——
  // 显式标注，告知模型不得把它当规划目标 / 指令锚点。
  const placeholderNote =
    areaPlaceholderIds?.has(visit.visitId) === true
      ? " | 区域占位（区域标题，非可游玩点位，勿对它输出 plan/move/transfer/remove/setDuration）"
      : "";
  // Task #325 A-P1：片区归属标注（marker 优先 + 最近中心兖底 + 超 20km 判未知）
  const areaResult = attributePoiArea(item);
  const areaNote = ` | 片区=${areaResult.areaName ?? "未知"}`;
  let head: string;
  if (slim) {
    // Task #216 P1-D：planner 瘦身行——point=UUID / mode / effective / 车程对 planner
    // 无消费价值（planner 只用 id/名称/kind/order/time/locked/purchase/userAdjusted），
    // 全量行保留给 F11 意图通道（F11 需要 point 引用候选区点位入天）
    head = `  - [visit] id=${visit.visitId} | ${name} | kind=${visit.kind} | order=${visit.order ?? "null"} | time=${formatTimeSpan(visit)} | locked=${visit.locked} | purchase=${visit.purchaseState} | userAdjusted=${visit.userAdjusted}${areaNote}${placeholderNote}`;
  } else {
    const leg =
      visit.externalLeg === null
        ? ""
        : ` | 车程=${visit.externalLeg.minutes === null ? "待定" : `${visit.externalLeg.minutes}min`}(${visit.externalLeg.mode})`;
    head = `  - [visit] id=${visit.visitId} | ${name}(point=${visit.pointRef}) | kind=${visit.kind} | mode=${visit.visitMode} | order=${visit.order ?? "null"} | time=${formatTimeSpan(visit)} | effective=${visit.effectiveMinutes ?? "null"}min | locked=${visit.locked} | purchase=${visit.purchaseState} | userAdjusted=${visit.userAdjusted}${leg}${areaNote}${placeholderNote}`;
  }
  const lines = [head];
  for (const stopId of visit.childStopRefs) {
    const stop = trip.stops[stopId];
    if (stop !== undefined) lines.push(formatStopLine("      * ", stop, trip));
  }
  if (visit.alternateStopRefs.length > 0) {
    lines.push(`      （备选玩法 visitPool，containerRef={"kind":"visitPool","visitId":"${visit.visitId}"}）`);
    for (const stopId of visit.alternateStopRefs) {
      const stop = trip.stops[stopId];
      if (stop !== undefined) lines.push(formatStopLine("      * ", stop, trip));
    }
  }
  return lines;
}

function formatDaySection(
  trip: Trip,
  day: Day,
  slim: boolean = false,
  areaPlaceholderIds?: ReadonlySet<string>,
): string[] {
  // Task #325 A-P1：Day 头行注入 role / 地理跨度 / 最远离机场 / 行程截止
  const geoStats = computeDayGeoStats(trip, day.dayIndex);
  const totalDays = (trip.dayRefs ?? []).length;
  const isLastDay = day.dayIndex === totalDays;
  const cutoffInfo = isLastDay ? deriveDepartureDayCutoff(trip) : null;
  const geoSuffix = ` | role=${day.role ?? "未派生"} | 地理跨度=${geoStats.spanKm ?? "null"}km | 最远离机场=${geoStats.maxAirportKm ?? "null"}km${cutoffInfo !== null ? ` | 行程截止=${cutoffInfo.cutoffTime}(${cutoffInfo.source})` : ""}`;
  const lines = [`Day ${day.dayIndex}（${day.date}）departTime=${day.departTime ?? "null"}${geoSuffix}`];
  if (day.scheduleVisitRefs.length === 0) {
    lines.push("  （无已排到访）");
    return lines;
  }
  for (const visitId of day.scheduleVisitRefs) {
    const visit = trip.visits[visitId];
    if (visit !== undefined) lines.push(...formatVisitSection(trip, visit, slim, areaPlaceholderIds));
  }
  return lines;
}

// ===== Task #216 P0-A：scope 感知的 Day 编排裁剪（planner 局部优化专用） =====

/** 单行 Day 摘要（非目标天）：只保留天号 / 日期 / 到访数与名称概况（约 40-60 字符），
 * 不展开 visit / stop 明细；名称超长时截断（模型只需知道该天有什么，不需引用其 id） */
const DAY_SUMMARY_NAME_CHARS_LIMIT = 42;

function formatDaySummaryLine(trip: Trip, day: Day): string {
  if (day.scheduleVisitRefs.length === 0) {
    return `Day ${day.dayIndex}（${day.date}）无已排到访`;
  }
  const names: string[] = [];
  let used = 0;
  let truncated = false;
  for (const visitId of day.scheduleVisitRefs) {
    const visit = trip.visits[visitId];
    if (visit === undefined) continue;
    const name = trip.itemRegistry[visit.pointRef]?.name ?? visit.pointRef;
    const length = [...name].length;
    if (names.length > 0 && used + length > DAY_SUMMARY_NAME_CHARS_LIMIT) {
      truncated = true;
      break;
    }
    names.push(name);
    used += length;
  }
  return `Day ${day.dayIndex}（${day.date}）${day.scheduleVisitRefs.length} 个到访：${names.join("、")}${truncated ? "…" : ""}`;
}

/** attraction scope 同日非目标 visit 的精简行：只保留 id + 名称（供素材对齐上下文） */
function formatVisitBriefLine(trip: Trip, visit: Visit): string {
  const item = trip.itemRegistry[visit.pointRef];
  return `  - [visit] id=${visit.visitId} | ${item?.name ?? visit.pointRef}`;
}

/**
 * scope 感知的单天输出（Task #216 P0-A）：
 * - 无 scope / trip scope：全量展开（F11 意图通道与整体重排保持原行为）；
 * - day scope：目标天全量展开，其余天压成单行摘要；
 * - attraction scope：目标天 = 目标景区 visit 完整展开（含内部玩法与备选玩法）+
 *   同日其余 visit 精简为 id + 名称；其余天单行摘要。
 * 目标 visit 引用失效（不存在 / 不属于任何天）时静默退全量（防御：上游
 * validateDraftScope 已拦截，此处只兑底，不抛错）。
 */
function formatDaySectionForScope(
  trip: Trip,
  day: Day,
  scope: DraftScope | undefined,
  slim: boolean,
  areaPlaceholderIds?: ReadonlySet<string>,
): string[] {
  if (scope === undefined || scope.kind === "trip") {
    return formatDaySection(trip, day, slim, areaPlaceholderIds);
  }
  if (scope.kind === "day") {
    return day.dayIndex === scope.dayIndex
      ? formatDaySection(trip, day, slim, areaPlaceholderIds)
      : [formatDaySummaryLine(trip, day)];
  }
  const visit = trip.visits?.[scope.visitId];
  const dayRef = visit?.dayRef ?? null;
  const targetDayIndex = dayRef !== null ? trip.days?.[dayRef]?.dayIndex : undefined;
  if (visit === undefined || targetDayIndex === undefined) {
    return formatDaySection(trip, day, slim, areaPlaceholderIds); // 防御：目标景区引用失效 → 全量
  }
  if (day.dayIndex !== targetDayIndex) {
    return [formatDaySummaryLine(trip, day)];
  }
  // Task #325 A-P1：attraction scope 目标天也注入地理事实行
  const geoStats = computeDayGeoStats(trip, day.dayIndex);
  const totalDays = (trip.dayRefs ?? []).length;
  const isLastDay = day.dayIndex === totalDays;
  const cutoffInfo = isLastDay ? deriveDepartureDayCutoff(trip) : null;
  const geoSuffix = ` | role=${day.role ?? "未派生"} | 地理跨度=${geoStats.spanKm ?? "null"}km | 最远离机场=${geoStats.maxAirportKm ?? "null"}km${cutoffInfo !== null ? ` | 行程截止=${cutoffInfo.cutoffTime}(${cutoffInfo.source})` : ""}`;
  const lines = [`Day ${day.dayIndex}（${day.date}）departTime=${day.departTime ?? "null"}${geoSuffix}`];
  if (day.scheduleVisitRefs.length === 0) {
    lines.push("  （无已排到访）");
    return lines;
  }
  for (const visitId of day.scheduleVisitRefs) {
    const dayVisit = trip.visits[visitId];
    if (dayVisit === undefined) continue;
    if (visitId === scope.visitId) {
      lines.push(...formatVisitSection(trip, dayVisit, slim, areaPlaceholderIds));
    } else {
      lines.push(formatVisitBriefLine(trip, dayVisit));
    }
  }
  return lines;
}

/**
 * buildTripFacts 组装开关（Task #110）：缺省全部保持 F11 原行为，只有显式传入才生效。
 * planner（B3 草案）传两者为 true——pending 与无攻略关联候选对 planner 均不可操作，
 * 留在 prompt 里只是纯输入噪音（占 token 且稀释有效上下文）。
 */
export interface TripFactsOptions {
  /** 是否包含【待定加入】区块；缺省 true。planner 传 false：pending stop 只能由用户确认归类，
   * AI 对它输出任何操作都会被服务端 G1/G3 拒绝，序列化出来不可操作 */
  includePending?: boolean;
  /** 是否把【全局候选区】裁剪到「与攻略有明确关联」的条目；缺省 false（F11 需要全量候选区
   * 供 transfer 入池）。planner 传 true：只保留攻略证据/提及可达的候选，避免无来源噪音 */
  guideRelevantCandidatesOnly?: boolean;
  /**
   * Task #161：候选支撑证据的资格来源 id 集合（planner 来源隔离，与
   * guideRelevantCandidatesOnly 联合生效）。
   * - 提供时：只有属于集合内来源的 evidenceRefs 的证据才算「有支撑」（代替 Task #147
   *   的 active 宽判）；调用方（planner）保证集合只含 active 来源——局部模式 = 所选
   *   来源，全部模式 = active 非暂存来源，均为 active 来源子集，过滤只收窄不放宽：
   *   inactive 来源独占候选依旧被裁、无主证据照旧保留，不会因来源过滤把旧候选补回；
   * - 缺省：保持 Task #147 既有 active 判定（F11 全量行为零影响）。
   */
  candidateSupportSourceIds?: ReadonlySet<string>;
  /**
   * Task #216 P0-A：局部优化 scope（planner 专用）。day / attraction scope 时
   * 非目标天压缩为单行摘要、非目标 visit 精简为 id+名称（模型只需上下文对齐，
   * 不需引用非目标实体 id）；trip scope 或缺省 = 全量展开（F11 意图通道行为不变）。
   */
  scope?: DraftScope;
  /**
   * Task #216 P1-D：【Day 编排】visit 行使用瘦身格式——省略 point=UUID / mode /
   * effective / 车程等 planner 不消费的字段，保留 id / 名称 / kind / order /
   * time / locked / purchase / userAdjusted。缺省 false：F11 需要 point 引用把
   * 候选区点位排入天。
   */
  slimVisitFormat?: boolean;
  /**
   * Task #216 P0-B：素材关联实体键集合（`kind:id` 格式，调用方从攻略 mentions
   * 对齐产物收集）。提供时【全局候选区】分层压缩——素材关联候选保持完整格式、
   * 无关候选压缩为紧凑名册；缺省 = 全量逐条展开（F11 行为不变）。
   */
  candidateMentionEntityRefs?: ReadonlySet<string>;
}

/**
 * 全局候选是否与攻略有明确关联（planner 裁剪判据，Task #110）。
 * 只读现有真实字段：Item.sourceEvidenceRefs（主数据必填）与 Visit.sourceMentionRefs
 * （可选字段，防御式读取）——不假设 Item 上存在 sourceMentionRefs。
 *
 * Task #147：证据引用还需交叉校验所属攻略来源（Trip.guideSources）仍 active——
 * 已删除或停用（active=false）来源独占支撑的候选不再进入 planner；多来源共同
 * 支撑的候选只要至少一个 active 来源即保留。兼容两类旧数据：
 * - Trip.guideSources 缺失（老行程无来源表）：无从校验，保持原保留行为；
 * - 证据不属于任何来源（历史装配产物）：保留，不因「无主」被裁剪。
 *
 * Task #161：可选 qualifyingSourceIds（planner 来源隔离）——提供时以「属于集合内
 * 来源」代替 active 宽判；集合恒为 active 来源子集（局部 = 所选，全部 = active
 * 非暂存），因此相对既有行为只收窄不放宽，不会把被裁候选补回。
 */
function isGuideRelatedCandidate(
  trip: Trip,
  ref: EntityRef,
  qualifyingSourceIds?: ReadonlySet<string>,
): boolean {
  // 来源归属索引：owned = 被任何来源引用；active = 被至少一个合格来源引用
  //（Task #161：qualifyingSourceIds 提供时合格 = 属于集合；缺省合格 = active，保持 #147 行为）
  const sources = trip.guideSources;
  const hasSourceTable = sources !== undefined && sources !== null;
  const activeEvidenceIds = new Set<string>();
  const ownedEvidenceIds = new Set<string>();
  if (hasSourceTable) {
    for (const source of Object.values(sources)) {
      const qualifies = qualifyingSourceIds !== undefined
        ? qualifyingSourceIds.has(source.sourceId)
        : source.active === true;
      for (const evidenceId of Array.isArray(source.evidenceRefs) ? source.evidenceRefs : []) {
        ownedEvidenceIds.add(evidenceId);
        if (qualifies) activeEvidenceIds.add(evidenceId);
      }
    }
  }
  const evidenceSupported = (evidenceId: string): boolean =>
    !hasSourceTable || !ownedEvidenceIds.has(evidenceId) || activeEvidenceIds.has(evidenceId);

  const itemHasSupportedEvidence = (itemId: string): boolean => {
    const item = trip.itemRegistry[itemId];
    if (!Array.isArray(item?.sourceEvidenceRefs)) return false;
    return item.sourceEvidenceRefs.some((evidenceId) => evidenceSupported(evidenceId));
  };
  if (ref.kind === "point") return itemHasSupportedEvidence(ref.id);
  if (ref.kind === "visit") {
    const visit = trip.visits[ref.id];
    if (visit === undefined) return false;
    if (Array.isArray(visit.sourceMentionRefs)) {
      for (const mentionRef of visit.sourceMentionRefs) {
        const parsed = parseMentionRef(mentionRef);
        if (parsed !== null && evidenceSupported(parsed.evidenceId)) return true;
      }
      // mention 引用全部失效时回退 item 证据：item 侧可能仍由 active 来源支撑
    }
    return itemHasSupportedEvidence(visit.pointRef);
  }
  return false;
}

// ===== Task #229：候选区伪 POI 兕底过滤（只影响 prompt 组装，不删数据） =====

/** 伪 POI 高频关键词（Task #229 西岛案例实测：交通 / 服务 / 备选标注被抽取为候选地点） */
const NON_POI_KEYWORDS = ["观光车", "电动车", "三轮车", "接驳", "租车", "租电动", "首班船", "末班船", "备选（", "备选("];

/**
 * 候选名称疑似非真实地点（Task #229 启发式）：
 * - 关键词包含命中：交通工具 / 服务 / 备选标注；「步行」只按前缀命中（下方正则），
 *   避免误伤「步行街」类真实地点——真实飞猪 POI 另有 providerId 硬保护；
 * - 前缀正则命中：交通动词开头（步行 / 骑行 / 乘车 / 打车 / 坐船）与时间表述
 *   开头（约N / 早上 / 下午 / 晚上）。
 */
function isLikelyNonPoiName(name: string): boolean {
  if (NON_POI_KEYWORDS.some((keyword) => name.includes(keyword))) return true;
  return /^(步行|骑行|乘车|打车|坐船)/.test(name) || /^(约\d|早上|下午|晚上)/.test(name);
}

/**
 * Task #229：候选条目是否为「伪 POI」（不进入 prompt；数据保留在行程中不动）。
 * 保护条件（绝不过滤）：有 providerId 的飞猪真实 POI、用户手动添加的点位
 * （origin=custom 且无攻略证据来源）、大景区壳（kind=large_attraction）。
 * 非法候选引用与引用缺失条目原样保留（防御信息不丢，与既有约定一致）。
 */
function isFilteredNonPoiCandidate(trip: Trip, ref: EntityRef): boolean {
  if (ref.kind !== "point" && ref.kind !== "visit") return false;
  const item =
    ref.kind === "point"
      ? trip.itemRegistry[ref.id]
      : trip.itemRegistry[trip.visits[ref.id]?.pointRef ?? ""];
  if (item === undefined) return false;
  if (item.providerId !== null) return false; // 飞猪真实 POI
  if (item.origin === "custom" && item.sourceEvidenceRefs.length === 0) return false; // 用户手动添加
  if (ref.kind === "visit" && trip.visits[ref.id]?.kind === "large_attraction") return false; // 大景区壳
  return isLikelyNonPoiName(item.name);
}

/** 候选条目完整行（Task #216 P0-B 从 formatGlobalPool 提取：分层后关联候选沿用） */
function formatGlobalPoolEntry(trip: Trip, ref: EntityRef): string {
  if (ref.kind === "point") {
    const item = trip.itemRegistry[ref.id];
    return `  - [point] id=${ref.id} | ${item?.name ?? ref.id} | suggest=${item?.suggestMinutes ?? "null"}min`;
  }
  if (ref.kind === "visit") {
    const visit = trip.visits[ref.id];
    const item = visit !== undefined ? trip.itemRegistry[visit.pointRef] : undefined;
    return `  - [visit] id=${ref.id} | ${item?.name ?? ref.id} | kind=${visit?.kind ?? "?"} | 内部玩法 ${visit?.childStopRefs.length ?? 0} 项`;
  }
  return `  - （非法候选引用：${String(ref)}）`;
}

/** 候选显示名（Task #216 P0-B 名册条目）：point 取 item 名称，visit 取其点位 item 名称 */
function globalPoolEntryDisplayName(trip: Trip, ref: EntityRef): string {
  if (ref.kind === "point") {
    return trip.itemRegistry[ref.id]?.name ?? ref.id;
  }
  if (ref.kind === "visit") {
    const visit = trip.visits[ref.id];
    const item = visit !== undefined ? trip.itemRegistry[visit.pointRef] : undefined;
    return item?.name ?? ref.id;
  }
  return String(ref);
}

/**
 * 全局候选区序列化。
 * Task #216 P0-B：提供 mentionEntityRefs（素材关联实体键集合，`kind:id` 格式）时
 * 分层压缩——攻略素材提及过的候选保持完整格式（模型需要 suggest / kind / 内部
 * 玩法数等细节做编排决策），无关候选压成一行紧凑名册「其余 N 个候选：id 名称、
 * …」（id 保留供模型构造 EntityRef，名称供语义匹配）。缺省 = 全量逐条展开
 * （F11 意图通道行为不变）。非法候选引用无论何种模式都原样保留（防御信息不丢）。
 * Task #229：伪 POI 兕底过滤（isFilteredNonPoiCandidate）在候选集入口统一生效
 * （早于 mention 分层）——交通 / 服务 / 时间 / 备选标注类条目不进入 prompt；
 * 数据保留在行程中不动，素材 mention 引用（指向 evidence，非候选区 visit）不受影响。
 */
function formatGlobalPool(
  trip: Trip,
  guideRelevantOnly: boolean,
  qualifyingSourceIds?: ReadonlySet<string>,
  mentionEntityRefs?: ReadonlySet<string>,
  areaPlaceholderIds?: ReadonlySet<string>,
): string[] {
  // Task #253：区域占位点位（自定义「亚龙湾」这类区域标题）不是可规划点位——
  // 无论以 visit 还是 point 形态出现在候选区，都不进入 prompt，避免模型对它 plan / transfer。
  const placeholderPointRefs = new Set<string>();
  for (const visitId of areaPlaceholderIds ?? []) {
    const visit = trip.visits[visitId];
    if (visit !== undefined) placeholderPointRefs.add(visit.pointRef);
  }
  const isAreaPlaceholderRef = (ref: EntityRef): boolean =>
    (ref.kind === "visit" && areaPlaceholderIds?.has(ref.id) === true) ||
    (ref.kind === "point" && placeholderPointRefs.has(ref.id));
  // Task #229：伪 POI 过滤在 guideRelevantOnly 裁剪之后、mention 分层之前统一执行，
  // 全量 / 攻略关联 / 分层压缩三种形态下伪 POI 一律不进入 prompt
  const refs = (guideRelevantOnly
    ? trip.globalCandidateRefs.filter((ref) => isGuideRelatedCandidate(trip, ref, qualifyingSourceIds))
    : trip.globalCandidateRefs
  )
    .filter((ref) => !isFilteredNonPoiCandidate(trip, ref))
    .filter((ref) => !isAreaPlaceholderRef(ref));
  if (refs.length === 0) {
    return [guideRelevantOnly ? "（无与攻略相关的候选点位）" : "（全局候选区为空）"];
  }
  if (mentionEntityRefs === undefined) {
    return refs.map((ref) => formatGlobalPoolEntry(trip, ref));
  }
  const relatedLines: string[] = [];
  const rosterEntries: string[] = [];
  for (const ref of refs) {
    if (ref.kind !== "point" && ref.kind !== "visit") {
      relatedLines.push(formatGlobalPoolEntry(trip, ref));
      continue;
    }
    if (mentionEntityRefs.has(`${ref.kind}:${ref.id}`)) {
      relatedLines.push(formatGlobalPoolEntry(trip, ref));
    } else {
      rosterEntries.push(`${ref.id} ${globalPoolEntryDisplayName(trip, ref)}`);
    }
  }
  const lines = [...relatedLines];
  if (rosterEntries.length > 0) {
    lines.push(`  其余 ${rosterEntries.length} 个候选：${rosterEntries.join("、")}`);
  }
  return lines;
}

function formatPendingStops(trip: Trip): string[] {
  if (trip.pendingStopRefs.length === 0) return ["（待定加入为空）"];
  return trip.pendingStopRefs.map((stopId) => {
    const stop = trip.stops[stopId];
    if (stop === undefined) return `  - [stop] id=${stopId} |（引用缺失）`;
    const name = stop.matchedPointRef !== null ? trip.itemRegistry[stop.matchedPointRef]?.name ?? stopId : stop.customName ?? stopId;
    const suggestion = trip.relationshipSuggestions[stopId];
    const suggested =
      stop.suggestedVisitRef !== null
        ? `${stop.suggestedVisitRef}(${trip.itemRegistry[trip.visits[stop.suggestedVisitRef]?.pointRef ?? ""]?.name ?? stop.suggestedVisitRef})`
        : "null";
    const level = suggestion?.level ?? "null";
    return `  - [stop] id=${stopId} | ${name} | suggest=${stop.suggestMinutes ?? "null"}min | hint=${stop.locationHint ?? "null"} | 建议归属=${suggested} | 置信度=${level}`;
  });
}

function formatConstraints(trip: Trip): string[] {
  if (trip.constraints.length === 0) return ["（无硬约束）"];
  return trip.constraints.map(
    (constraint) =>
      `  - Day${constraint.dayIndex} ${constraint.type} | ${constraint.label} | anchor=${constraint.anchorTime} | locked=${constraint.locked}`,
  );
}

/**
 * 住宿行（rev2 修订附录 A）：酒店信息一律经 plan.hotelRefs → trip.hotelRegistry
 * 解析（唯一事实源），不再读取 deprecated 的 hotelCandidate / status（rev2 数据中
 * 该字段已不存在，若仍读会拿 undefined 崩溃）；候选列表为空 = 未定酒店。
 * 多候选时全部列出，供模型感知住宿意向。
 */
function formatLodging(trip: Trip): string[] {
  const lines: string[] = [];
  for (const [key, plan] of Object.entries(trip.lodgings)) {
    // 运行时防御：早期落盘 / 手工构造的 LodgingPlan 可能缺 hotelRefs（rev2 迁移契约兜底）
    const refs = Array.isArray(plan.hotelRefs) ? plan.hotelRefs : [];
    const hotels = refs
      .map((hotelId) => trip.hotelRegistry?.[hotelId])
      .filter((hotel): hotel is HotelCandidate => hotel !== undefined);
    const hotel =
      hotels.length === 0
        ? "未定"
        : hotels.map((h) => `${h.name}(shId=${h.shId}，price=${h.priceText ?? "null"})`).join("、");
    const times = `checkin=${plan.checkInTime ?? "null"}/checkout=${plan.checkOutTime ?? "null"}`;
    lines.push(
      `  - Day${key}：${plan.areaName ?? "区域待定"}（候选=${hotels.length}家，hotel=${hotel}，${times}，purchase=${plan.purchaseState}，locked=${plan.locked}）`,
    );
  }
  return lines.length > 0 ? lines : ["（无住宿安排）"];
}

// ===== 公开接口 =====

/**
 * 行程事实块（【行程概况】→【住宿信息】，不含系统规则 / 版本 / 用户输入）。
 * F11 意图 prompt 与 B3 攻略草案 prompt 共用同一序列化，避免双份漂移；
 * 实体 id 可被 operations 直接引用（Day → Visit → Stop 层级始终展开）。
 * options 缺省 = F11 全量行为（含待定加入 + 全量候选区）；planner 用开关瘦身（Task #110）。
 */
export function buildTripFacts(trip: Trip, options?: TripFactsOptions): string[] {
  const includePending = options?.includePending ?? true;
  const guideRelevantOnly = options?.guideRelevantCandidatesOnly ?? false;
  const candidateSupportSourceIds = options?.candidateSupportSourceIds;
  const scope = options?.scope;
  const slimVisitFormat = options?.slimVisitFormat ?? false;
  const candidateMentionEntityRefs = options?.candidateMentionEntityRefs;
  // Task #253：区域占位点位集合（天级标注 + 候选区过滤共用，只算一次）
  const areaPlaceholderIds = collectAreaPlaceholderVisitIds(trip);
  const totalDays = trip.dayRefs.length;
  return [
    "【行程概况】",
    `目的地：${trip.destination.city}`,
    `日期：${trip.dateRange.start} 至 ${trip.dateRange.end}，共 ${totalDays} 天 ${trip.dateRange.nights} 晚`,
    "",
    "【Day 编排】（dayIndex 从 1 开始；visit / stop 的 id 可被 operations 引用；大景区内部玩法始终展开）",
    ...trip.dayRefs.flatMap((dayId) => {
      const day = trip.days[dayId];
      return day === undefined
        ? [`Day ?（引用缺失 ${dayId}）`]
        : formatDaySectionForScope(trip, day, scope, slimVisitFormat, areaPlaceholderIds);
    }),
    "",
    "【全局候选区】（未排入行程的点位 / 大景区壳，plan / transfer 可引用其 id）",
    ...formatGlobalPool(
      trip,
      guideRelevantOnly,
      candidateSupportSourceIds,
      candidateMentionEntityRefs,
      areaPlaceholderIds,
    ),
    ...(includePending
      ? ["", "【待定加入】（待用户确认归类的内部玩法，AI 不得自动挂入）", ...formatPendingStops(trip)]
      : []),
    "",
    "【约束列表】（不可违背的硬约束）",
    ...formatConstraints(trip),
    "",
    "【住宿信息】",
    ...formatLodging(trip),
  ];
}

/**
 * 将 Trip 压缩为完整 prompt（系统规则 + 版本 + 层级行程上下文 + 用户意图），
 * 作为一次百炼短会话的 user input 发送。
 */
export function buildIntentPrompt(trip: Trip, intentText: string): string {
  return [
    "【系统规则】",
    FIXED_RULES_TEXT,
    "",
    "【版本】",
    `baseVersion=${trip.version}（原样回显到输出的 baseVersion 字段）`,
    "",
    ...buildTripFacts(trip),
    "",
    "【用户意图】",
    intentText.trim(),
  ].join("\n");
}

// ===== F5 攻略抽取 =====

/** 正文抽取规则（导出供 verify-task249 断言区域/住宿片区禁令仍在位） */
export const EXTRACT_RULES_TEXT = `你是旅行信息提取助手。从以下旅行笔记正文中提取所有值得去的地点，包括景点、海滩、公园、商圈，以及餐厅、小吃店、咖啡馆等餐饮点位。若某大景区内部的具体玩法点（如景区内的桥、海滩、观景台、餐厅）被单独提及，也提取为独立条目并用 parentAttraction 标注所属景区。

此外，还需提取笔记中的「笔记级建议」（tips / 避雷 / 亮点体验）——即不专属于某个具体小景点、而是对整个景点或整篇笔记通用的实用建议、避坑提醒、体验亮点。

输出格式要求：
- 输出必须是合法 JSON 数组，不要包裹在 markdown code block 中，不要输出任何解释性文字
- 地点条目格式：
  { "name": "地点本名", "type": "attraction" 或 "in_attraction", "parentAttraction": null 或 "所属景区名", "scale": null 或 "large", "confidence": "high" 或 "medium" 或 "low", "suggestMinutes": 90, "locationHint": null 或 "入口左转", "quote": "笔记原句", "summary": "一句话评价", "relationEvidence": null 或 "从属关系原文依据" }
- 笔记级建议条目格式（Task #287）：
  { "name": "建议的简短标签", "type": "note_tip", "parentAttraction": "相关景区名" 或 null, "scale": null, "confidence": null, "suggestMinutes": null, "locationHint": null, "quote": "笔记原文（完整摘录含建议的那句话）", "summary": "一句话概括建议内容" }
- name（地点条目）：地点或店名本名，不含修饰语（如"超美的"、"必去的"）
- name（note_tip 条目）：建议的简短描述标签（如"门票省钱"、"拍照避雷"、"交通建议"、"雨具备忘"），不超过 8 字
- 不要提取：平台水印或账号名（如小红书、抖音、大众点评）、广告与 logo、纯地理类型词（海滩、沙滩、岛、景点、景区、码头、市场等）、打卡牌/装饰文字（如"三亚岛"这类城市名+泛化后缀的组合）；只提取具体的可到访地点
- 严禁将以下内容提取为地点：交通方式/工具（如“步行”“观光车”“电动车”“三轮车”“首班船”“末班船”）、服务描述（如“接驳”“租车”）、时间表述（如“约8点”“早上”）、备选标注（如“备选（xxx）”）——这些不是可游玩实体，只是动线 / 后勤信息
- 严禁将区域 / 住宿片区描述提取为地点：如"亚龙湾""海棠湾""三亚湾""大东海"等片区名，以及"住亚龙湾""亚龙湾住宿""海棠湾一带"这类住宿 / 位置段落——它们只是片区与住宿信息，不是可游玩实体；带具体场所名的（如"亚龙湾海滩""亚龙湾热带天堂森林公园""海棠湾免税城"）仍照常提取
- 仅提取有明确地理位置的可游玩实体（景点、海滩、餐厅、酒店、商铺等）
- 打卡点/装置：只提取原文明确定名、可辨识且相对固定的打卡点或装置（如有专名的墙、门、树、灯塔、装置、观景台，如"珊瑚墙""歪椰树"）；普通沙滩、小吃街、路过椰林、海边公路、随手拍处、入口旁、码头左侧等泛化场景或纯方位参照不要提取；严禁为泛化描述编造一个听起来像专名的点位名，名称必须能在原句中找到（服务端会逐字校验，编造即整条丢弃）
- type：attraction=独立景点/餐饮/商圈；in_attraction=大景区内部玩法点；note_tip=笔记级建议/避雷/亮点
- parentAttraction：type=in_attraction 时必填，值为笔记中出现过的所属景区名（须与某条 attraction 条目的 name 一致或为其通行简称）；仅当上下文明示该地点从属或位于该景区（而非同日提及、并列出现或名称相似）才标注；type=attraction 时为 null；type=note_tip 时填写该建议所关联的景区名（若能确定），否则 null
- relationEvidence：type=in_attraction 时必填——从笔记原文中摘录能证明「该地点属于 parentAttraction」的原句片段（如「位于后海村内部」「后海村里的海滩」「后海村旁的餐馆」）；仅当原文明确写出从属 / 内部 / 位于 / 附近等关系时填写，同日安排、同一篇笔记或名称相似不构成依据，此时填 null；attraction 条目填 null
- scale：仅当该景区在笔记中明显是大景区（内部含多个玩法点、通常需要大半天以上）时填 "large"，否则 null
- confidence：内部玩法条目必填——high=有明确位置词/动线描述证明归属（如"上岛先走情人桥"）；medium=疑似归属但证据不直接；low=仅提及名称无上下文；attraction 条目填 null 可省略
- suggestMinutes：建议停留时长整数分钟；无法判断时用 null（不要瞎猜）
- locationHint：笔记中的位置提示原文（如"入口左转"），没有则 null
- quote：笔记中提及该地点的原句，尽量完整摘录——原句中的配图页码（如 p6、P6、p 6、p2 p8 p9）必须原样保留，不得改写、合并或省略（服务端据此把第 N 张攻略原图关联到该点位）；summary：主观评价摘要不超 30 字，无评价写"笔记提及"
- note_tip 的 quote：完整摘录含该建议的原文句子（这是召回匹配的关键字段，务必原文照搬、不要改写缩写）

笔记级建议（note_tip）提取规则：
- 提取对象：实用的游玩建议（如"提前买票便宜"）、避雷/避坑提醒（如"拍照漫天要价"、"大雾天看不到"）、通用体验亮点（如"建议上午去"）
- 不提取：已在某个地点条目的 quote 中充分体现的信息（例如"过江龙索桥排队人多"若已在过江龙索桥条目的 quote 里完整出现，不再单独提为 note_tip）
- 不提取：纯行程动线安排（如"先去A再去B"）、交通方式描述（如"坐观光车到山顶"）、无实质建议的客观陈述
- 每条 note_tip 应是一条独立的、有实用价值的建议/提醒/亮点
- quote 字段务必完整摘录原文（包含上下文关键信息），不要截断或改写

如果笔记中没有任何可识别的地点，输出空数组 []`;

/**
 * 将用户粘贴的攻略正文组装为 F5 抽取 prompt（抽取规则 + 笔记正文），
 * 作为一次百炼短会话的 user input 发送；输出由 server/src/ai/extract.ts 解析归一化，
 * 并落为 SourceEvidence / Item / Visit / Stop 结构。
 */
export function buildExtractPrompt(noteText: string): string {
  return `${EXTRACT_RULES_TEXT}\n\n---\n以下是用户粘贴的旅行笔记正文：\n\n${noteText}`;
}

// ===== Task #51 截图 OCR 抽取 =====

/** OCR 抽取规则（导出供 verify-task249 断言区域/住宿片区禁令仍在位） */
export const OCR_RULES_TEXT = `你是旅行攻略图片识别助手。请先完整识别图片中的文字（OCR 原文，保留原始换行与排版），再从识别出的内容中提取所有值得去的地点。提取范围与正文抽取一致：景点、海滩、公园、商圈，以及餐厅、小吃店、咖啡馆等餐饮点位；若某大景区内部的具体玩法点（如景区内的桥、海滩、观景台、餐厅）被单独提及，也提取为独立条目并用 parentAttraction 标注所属景区。

输出格式要求：
- 输出必须是单个合法 JSON 对象，不要包裹在 markdown code block 中，不要输出任何解释性文字
- 顶层结构：{ "ocrText": "...", "mentions": [...] }
- ocrText：图片中所有可读文字的完整转录（保留换行；纯风景图无文字时为空字符串）
- mentions 数组每个元素：
  { "name": "地点本名", "type": "attraction" 或 "in_attraction", "parentAttraction": null 或 "所属景区名", "scale": null 或 "large", "confidence": "high" 或 "medium" 或 "low", "suggestMinutes": 90, "locationHint": null 或 "入口左转", "ticketRelation": "included" 或 "separate" 或 "unknown", "suggestedVisitName": null 或 "建议归入景区名", "quote": "图中原文", "summary": "一句话评价", "bbox": [x1, y1, x2, y2], "relationEvidence": null 或 "从属关系原文依据" }
- name：地点或店名本名，不含修饰语（如“超美的”“必去的”）；识别不准时按图中原字输出
- 不要提取：图片水印、平台账号名（如小红书、抖音、大众点评）、广告与 logo、纯地理类型词（海滩、沙滩、岛、景点、景区、码头、市场等）、打卡牌或装饰文字（如“三亚岛”这类城市名+泛化后缀的组合）；只提取具体的可到访地点
- 严禁将以下内容提取为地点：交通方式/工具（如“步行”“观光车”“电动车”“三轮车”“首班船”“末班船”）、服务描述（如“接驳”“租车”）、时间表述（如“约8点”“早上”）、备选标注（如“备选（xxx）”）——这些不是可游玩实体，只是动线 / 后勤信息
- 严禁将区域 / 住宿片区描述提取为地点：如“亚龙湾”“海棠湾”“三亚湾”“大东海”等片区名，以及“住亚龙湾”“亚龙湾住宿”“海棠湾一带”这类住宿 / 位置段落——它们只是片区与住宿信息，不是可游玩实体；带具体场所名的（如“亚龙湾海滩”“亚龙湾热带天堂森林公园”“海棠湾免税城”）仍照常提取
- 仅提取图中文本明确定位的可游玩实体（景点、海滩、餐厅、酒店、商铺等）
- 打卡点/装置：只提取图中文字明确定名、可辨识且相对固定的打卡点或装置（如有专名的墙、门、树、灯塔、装置、观景台）；普通沙滩、小吃街、路过椰林、海边公路、随手拍处、入口旁、码头左侧等泛化场景或纯方位参照不要提取；严禁为泛化描述编造一个听起来像专名的点位名，名称必须能在图中文字中找到
- type：attraction=独立景点/餐饮/商圈；in_attraction=大景区内部玩法点
- parentAttraction：type=in_attraction 时必填，值为图中出现的所属景区名；仅当图中文本明示该地点从属或位于该景区（而非同图并列出现或名称相似）才标注；type=attraction 时为 null
- relationEvidence：type=in_attraction 时必填——从图中文字摘录能证明「该地点属于 parentAttraction」的原句片段（如“位于后海村内部”“后海村里的海滩”）；仅当文字明确写出从属 / 内部 / 位于 / 附近等关系时填写，同图并列或名称相似不构成依据，此时填 null；attraction 条目填 null
- scale：仅当该景区在图中明显是大景区（内部含多个玩法点、通常需要大半天以上）时填 "large"，否则 null
- confidence：内部玩法条目必填——high=有明确位置词/动线描述证明归属（如“上岛先走情人桥”）；medium=疑似归属但证据不直接；low=仅提及名称无上下文；attraction 条目填 null 可省略
- suggestMinutes：建议停留时长整数分钟；无法判断时用 null（不要瞎猜）
- locationHint：图中文字里的位置提示原文（如“入口左转”“索道站旁”），没有则 null
- ticketRelation：该玩法与大景区门票的关系——included=包含在大门票内；separate=需单独购票；unknown=图中未提及或不确定
- suggestedVisitName：建议归入的大景区名（通常与 parentAttraction 一致，也可以是图中提到的另一景区）；无建议时 null
- quote：图中提及该地点的原文片段，尽量完整摘录，不得改写或省略图中的页码字样（如 p6）；summary：主观评价摘要不超 30 字，无评价写“图中提及”
- bbox：该地点对应文字在图片中的大致包围盒 [x1, y1, x2, y2]，使用 0-1000 归一化坐标（左上角为原点）；无法定位时 null

如果图片中没有可识别的地点，mentions 输出空数组 []，ocrText 仍输出识别到的全部文字`;

/**
 * 组装截图 OCR 抽取 prompt（Task #51）：图片本体走百炼 File API 的
 * image file_id 块传入，本函数只产出文本指令块；editedText 为用户对上一轮
 * OCR 文本的修正/补充，拼接后一并提供（模糊处以用户文字为准）。
 */
export function buildOcrPrompt(editedText?: string): string {
  const supplement =
    typeof editedText === "string" && editedText.trim() !== ""
      ? `\n\n【用户补充/修正文字】\n${editedText.trim()}\n（该文字与图片内容合并理解：图片中模糊或缺失处以这段文字为准，其余以图片为准）`
      : "";
  return `${OCR_RULES_TEXT}\n\n---\n请识别这张旅行攻略截图并按上述契约输出。${supplement}`;
}
