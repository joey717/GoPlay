/**
 * Task #123：补充句日期指令的纯函数解析与草案后校验。
 *
 * 职责（全部为纯函数，无 IO / 无锁，便于离线测试）：
 * - parseDraftDirectives：把补充句解析为结构化日期指令（DAY3 / Day 3 / 第3天 / DAY三 /
 *   全角数字 / 中文数字），目标短语解析到「去 / 安排 / 放到」等动词后的地点文本，
 *   并按行程天数做 dayIndex 范围校验；
 *   - 明显写了 DAY 但缺数字（如「DAY安排后海」）→ 抛 GUIDE_DAY_NUMBER_REQUIRED（HTTP 400）；
 *   - dayIndex 超出范围 → 抛 GUIDE_DAY_INDEX_OUT_OF_RANGE（HTTP 400）；
 * - formatDirectivesPrompt：把指令注入 planner prompt（声明不可自行改天）；
 * - enforceDraftDirectives：模型返回后的服务端后校验——
 *   - classifyVisitAsStop 逐条过 validateOperation 强证据护栏（证据不足不下发）；
 *   - 目标 Visit 终态必须位于指定 Day：模型错误排天的 op 被移除，由服务端补确定性
 *     move / transfer（不重试 AI：单次 300s 成本高，确定性纠正即可满足指令）；
 *   - classify op 统一前置（先归类、后安排 parent，避免先 plan 已被删除的 child Visit）；
 *   - 计算 requirementChecks（按「操作全部成功」终态推演）与 conflicts（任务 125 勾选数据）；
 * - computeRequirementChecksFromTrip：apply 后按真实行程重算指令满足状态。
 *
 * Task #248（整日替换重排）：补充句带替换意图（「重排 / 重新做 / 重新安排 / 替换 DayN」）时
 * directive.mode="replace"：服务端对目标天的未锁定、未购买、非受保护 Visit 生成确定性
 * remove 移回候选池（复用既有 remove 语义，不新增特权 op），锁定 / 已购项保留在原天
 * 并生成告知冲突；普通「安排到 DayN」仍是 append（mode 缺省，行为与旧版完全一致）。
 *
 * 指令只属于 pendingGuideDraft 快照，不写入 Trip.constraints。
 * 四条护栏仍是最终裁决：本模块只做「不下发」，不放宽任何 G1/G3 语义；
 * 冲突 resolution 在 apply 阶段以 user_confirmed 执行（G3 对 move/transfer 放行、
 * remove 红线不变），未选中冲突保持原状。
 */

import type {
  EntityRef,
  GuideDraftAutoClassification,
  GuideDraftConflict,
  GuideDraftDayDirective,
  GuideDraftRequirementCheck,
  Operation,
  Trip,
} from "@goplay/shared";
import {
  collectAreaPlaceholderVisitIds,
  findVisitLocation,
  getDayByIndex,
  validateOperation,
  visitDayIndex,
} from "@goplay/shared";
import { AiError } from "../ai/errors.js";
import { normalizePoiName } from "../ai/assemble.js";

// ===== 数字解析 =====

/** 全角数字 → 半角 */
function normalizeFullwidthDigits(raw: string): string {
  return raw.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

/** 中文数字（一 ~ 九十九）→ 阿拉伯数字；非中文数字串返回 null */
function cnNumToArabic(raw: string): number | null {
  const digitMap: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (/^[一二三四五六七八九十]+$/.test(raw) === false) return null;
  if (raw === "十") return 10;
  const tenIndex = raw.indexOf("十");
  if (tenIndex === -1) {
    const single = digitMap[raw];
    return single === undefined ? null : single;
  }
  const tensPart = raw.slice(0, tenIndex);
  const onesPart = raw.slice(tenIndex + 1);
  const tens = tensPart === "" ? 1 : digitMap[tensPart];
  const ones = onesPart === "" ? 0 : digitMap[onesPart];
  if (tens === undefined || ones === undefined) return null;
  return tens * 10 + ones;
}

/** 解析日期 token 中的数字（半角 / 全角 / 中文数字）；不可识别返回 null */
function parseDayNumber(raw: string): number | null {
  const half = normalizeFullwidthDigits(raw);
  if (/^[0-9]+$/.test(half)) return Number.parseInt(half, 10);
  return cnNumToArabic(raw);
}

// ===== 分句与日期 token 扫描 =====

/** 按中英文标点与换行分句（保留各子句独立解析，避免跨句误配） */
function splitSentences(note: string): string[] {
  return note
    .split(/[，。；！？,!?;\n\r]+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");
}

interface DayTokenScan {
  /** 解析成功的日期 token（matchStart 句内偏移 / dayIndex / restStart 目标短语起点） */
  tokens: { matchStart: number; dayIndex: number; restStart: number }[];
  /** 出现了 DAY（或「第…天」）骨架但读不到数字 → GUIDE_DAY_NUMBER_REQUIRED */
  missingNumber: boolean;
}

/** DAY 后允许跳过的连接字符（如「Day: 3」「Day-3」「Day 3」） */
const DAY_SEPARATOR_RE = /[\s:：.\-—–]/;
/** 英文 day 词边界：前后不能是字母（防 today / daylight 误报） */
const DAY_WORD_RE = /(?<![a-zA-Z])day(?![a-zA-Z])/gi;
/** 「第 N 天」：数字可含全角与中文数字 */
const DI_DAY_RE = /第\s*([0-9０-９]+|[一二三四五六七八九十]+)\s*天/g;
/** 「第」后紧邻「天」（中间无数字）→ 缺数字形态 */
const DI_MISSING_RE = /第\s{0,2}天/;

/** 从 from 起跳过分隔符后读取数字 token；读到返回 { value, nextIndex }，否则 null */
function readNumberAt(sentence: string, from: number): { value: number; nextIndex: number } | null {
  let index = from;
  while (index < sentence.length && DAY_SEPARATOR_RE.test(sentence[index] ?? "")) index += 1;
  // 半角 / 全角数字串
  let raw = "";
  while (index < sentence.length) {
    const ch = sentence[index] ?? "";
    if (/[0-9０-９]/.test(ch)) {
      raw += ch;
      index += 1;
    } else break;
  }
  if (raw !== "") {
    const value = parseDayNumber(raw);
    if (value !== null) return { value, nextIndex: index };
  }
  // 中文数字串（一 ~ 九十九）
  let cnRaw = "";
  let cursor = index;
  while (cursor < sentence.length) {
    const ch = sentence[cursor] ?? "";
    if (/[一二三四五六七八九十]/.test(ch)) {
      cnRaw += ch;
      cursor += 1;
    } else break;
  }
  if (cnRaw !== "") {
    const value = cnNumToArabic(cnRaw);
    if (value !== null) return { value, nextIndex: cursor };
  }
  return null;
}

/** 扫描单句中的日期 token；DAY 后读不到数字 → missingNumber（缺数字错误） */
function scanDayTokens(sentence: string): DayTokenScan {
  const tokens: DayTokenScan["tokens"] = [];
  let missingNumber = false;

  // DAY / Day / day 风格：DAY3、Day 3、day：4、DAY三
  for (const match of sentence.matchAll(DAY_WORD_RE)) {
    const start = (match.index ?? 0) + match[0].length;
    const number = readNumberAt(sentence, start);
    if (number === null) {
      missingNumber = true;
      continue;
    }
    tokens.push({ matchStart: match.index ?? 0, dayIndex: number.value, restStart: number.nextIndex });
  }

  // 第 N 天风格：第3天、第 三 天、第三天、第３天
  for (const match of sentence.matchAll(DI_DAY_RE)) {
    const dayIndex = parseDayNumber(match[1] ?? "");
    if (dayIndex === null) {
      missingNumber = true;
      continue;
    }
    tokens.push({ matchStart: match.index ?? 0, dayIndex, restStart: (match.index ?? 0) + match[0].length });
  }

  // 「第天」（第后无数字直接天）也按缺数字处理
  if (DI_MISSING_RE.test(sentence)) missingNumber = true;

  tokens.sort((a, b) => a.matchStart - b.matchStart);
  return { tokens, missingNumber };
}

// ===== 目标短语提取 =====

/** 尾部语气词（循环剥离） */
const TRAILING_MOOD_RE = /[吧呀啊呢哦哟哈了嗯]+$/;
/** Task #248：前导请求语气 / 助词（循环剥离；「帮我重新做下DAY3的亚龙湾的行程」→「亚龙湾的行程」） */
const LEADING_FILLERS = ["帮我", "帮忙", "麻烦", "请你", "请", "我想", "我要", "的"];
/** Task #248：尾部计划名词（「亚龙湾的行程 / 路线 / 安排 / 规划 / 计划」→「亚龙湾」） */
const TRAILING_PLAN_NOUN_RE = /(?:的)?(?:行程|路线|安排|规划|计划)$/;
/** 前导动词 / 介词（长词优先，循环剥离；覆盖「去 / 安排 / 放到 / 排 / 加入 / 给 / 在 / 把」等） */
const LEADING_VERBS = [
  "安排到",
  "安排在",
  "安排进",
  "安排",
  "放到",
  "放进",
  "放在",
  "加入",
  "加到",
  "加进",
  "加上",
  "排到",
  "排进",
  "排在",
  "留给",
  "保留给",
  "排",
  "放",
  "加",
  "去",
  "逛",
  "给",
  "在",
  "把",
];
/** 「把 X 放到 Day Y」语序的移动动词（X 在动词前） */
const MOVE_VERBS_RE = /(?:放到|放进|放在|排到|排进|排在|加入|加进|安排到|安排在|安排进)/;
/** 中途连接词截断（防止把后续意图并进地点文本；Task #248 新增「基于」与句首截断） */
const CONNECTIVE_RE = /(?:基于|结合|参考|帮我|麻烦|然后|另外|还有|顺便|尽量|记得|注意)/;
/** Task #248：整日替换意图（重排 / 重新做 / 重新安排 / 替换），命中即 mode=replace */
const REPLACE_INTENT_RE = /(?:重排|重新排|重新做|重做|重新规划|重新安排|重新计划|重新来|重来|整日替换|全日替换|替换|换掉)/;
/** Task #248：「把 X 重新安排到 DayN」是移动语序（把某个点挪到某天），不是整日替换 */
const MOVE_ORDER_RE = /把[^，。；！？\n]*?(?:重排|重新排|重新做|重做|重新安排|重新规划|重新计划|替换)[^，。；！？\n]*?(?:到|进|在)/;

/**
 * Task #253：否定语序识别——「不要重排Day3」「不用重新安排Day3」「无需替换Day3」
 * 都不得解析为整日替换（用户是在禁止改动，而非要求重排）。
 *
 * 判定方式：看替换动词**之前**的片段（同分句内、最多回看 8 个字符）是否带否定词。
 * 覆盖两种常见语序：「不要重排Day3」（否定在动词前）与「Day3不用重排」
 * （否定仍紧邻动词前）。分句已在 splitSentences 按标点切开，不会跨句误判。
 */
const NEGATION_WORDS = [
  "不要",
  "不用",
  "不必",
  "不需要",
  "无需",
  "无须",
  "不建议",
  "不希望",
  "不想",
  "不准",
  "不能",
  "勿",
  "禁止",
  "避免",
  "先不",
  "暂不",
  "没有",
  "别再",
];
/** 单字「别」：排除「区别 / 特别 / 分别 / 类别 / 道别」等词内出现 */
const NEGATION_BIE_RE = /(?:^|[不把将再帮给])别(?!的)/;
/**
 * Task #253：「暂时别重排」「先别重新安排」这类祈使否定——动词**紧跟在「别」后**。
 * 用固定后缀判定，再排除「特别 / 分别 / 个别 / 区别 / 类别 / 级别 / 性别 / 告 别 / 差别 /
 * 识别 / 离别 / 派别」等词内「别」，避免误判。
 */
const NEGATION_BIE_TAIL_RE = /(?<![特别分个区类级性告差识离派])别$/;
/** 否定形固定句式（「不要忘记重排 Day3」其实是肯定命令） */
const AFFIRMATIVE_IDIOMS = ["不要忘记", "不要忘了", "别忘记", "别忘了"];

/** 替换动词是否处于否定语境（prefix 回看窗口内带否定词） */
function isNegatedReplaceIntent(sentence: string, matchIndex: number): boolean {
  const prefix = sentence.slice(Math.max(0, matchIndex - 8), matchIndex);
  if (AFFIRMATIVE_IDIOMS.some((idiom) => prefix.includes(idiom))) return false;
  if (NEGATION_WORDS.some((word) => prefix.includes(word))) return true;
  if (NEGATION_BIE_TAIL_RE.test(prefix)) return true;
  return NEGATION_BIE_RE.test(prefix);
}

/**
 * 同句首个**未被否定**的替换意图位置；全部被否定 / 未命中返回 null。
 * 只有明确肯定语序（肯定动词）才允许把指令升级为 replace。
 */
function findAffirmativeReplaceIntent(sentence: string): number | null {
  const pattern = new RegExp(REPLACE_INTENT_RE.source, "g");
  for (const match of sentence.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (!isNegatedReplaceIntent(sentence, index)) return index;
  }
  return null;
}

/** 提取日期 token 后的目标短语：剥请求语气 / 动词 / 尾部计划名词 / 语气词，截连接词 */
function extractPlaceText(rest: string): string {
  let text = rest.trim();
  // Task #248：先剥前导请求语气与助词（「的亚龙湾的行程」→「亚龙湾的行程」）
  let strippedFiller = true;
  while (strippedFiller) {
    strippedFiller = false;
    for (const filler of LEADING_FILLERS) {
      if (text.startsWith(filler)) {
        text = text.slice(filler.length).trim();
        strippedFiller = true;
        break;
      }
    }
  }
  // 「把 X 放到…」语序：取「把」后到移动动词前的文本
  if (text.startsWith("把")) {
    const afterBa = text.slice(1);
    const moveMatch = afterBa.match(MOVE_VERBS_RE);
    text = moveMatch !== null ? afterBa.slice(0, moveMatch.index ?? 0) : afterBa;
  } else {
    // 常规语序：循环剥离开头动词（如「放到」「去」）
    let stripped = true;
    while (stripped) {
      stripped = false;
      for (const verb of LEADING_VERBS) {
        if (text.startsWith(verb)) {
          text = text.slice(verb.length);
          stripped = true;
          break;
        }
      }
    }
  }
  // Task #248：连接语在句首也截断（「基于这个攻略」不得成为地点文本）
  const connectMatch = text.match(CONNECTIVE_RE);
  if (connectMatch !== null) {
    text = text.slice(0, connectMatch.index ?? 0);
  }
  text = text.replace(TRAILING_MOOD_RE, "").trim();
  // Task #248：剥尾部计划名词与裸助词「的」（「亚龙湾的行程」→「亚龙湾」）
  let strippedTail = true;
  while (strippedTail) {
    strippedTail = false;
    const withoutPlanNoun = text.replace(TRAILING_PLAN_NOUN_RE, "").trim();
    if (withoutPlanNoun !== text) {
      text = withoutPlanNoun;
      strippedTail = true;
      continue;
    }
    if (text.endsWith("的")) {
      text = text.slice(0, -1).trim();
      strippedTail = true;
    }
  }
  return text;
}

// ===== 地点 → Visit 匹配 =====

/** 名称归一化：去空白与成对括号内容 + 小写（与 assemble.normalizePoiName 同源） */
function normalizeName(name: string): string {
  return normalizePoiName(name).toLowerCase();
}

/** 目标短语拆段：「和 / 与 / 、 / 跟」分隔（「第3天去后海和南湾猴岛」→ 两段） */
export function splitPlaceSegments(placeText: string): string[] {
  return placeText
    .split(/\s*(?:和|与|、|跟)\s*/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
}

function visitDisplayName(trip: Trip, visitId: string): string {
  const visit = trip.visits[visitId];
  if (visit === undefined) return visitId;
  return trip.itemRegistry[visit.pointRef]?.name ?? visitId;
}

/**
 * 单段地点文本 → 全部可靠匹配的 Visit（多匹配，按优先级排序；调用方合并去重）。
 * 匹配优先级：归一化全等（返回全部同名）> 互含全集内 large_attraction 优先 >
 * 普通互含（名称长度差最小优先）。
 * Task #147：同一短语可指向多个真实地点（「亚龙湾」= 森林公园 / 海底世界 /
 * 喜来登酒店），只取第一条会遗漏同一有效攻略中的其余点——改为返回全部；
 * 「后海」同时互含「三亚后海村」与「后海海滩」时 large 仍排最前（父景点是指令主体）。
 * 防偶然短词泛化：互含匹配要求短语归一化后 ≥2 字符（单字如「海」会命中
 * 大量名称仅偶然含该字的无关点）；全等匹配不受此限。
 * 只接受名称层面的真实匹配：同日、同篇、同证据不参与（防误配）。
 */
function matchSegmentToVisits(trip: Trip, segment: string): string[] {
  const target = normalizeName(segment);
  if (target === "") return [];
  // Task #253：区域占位点位（自定义「亚龙湾」这类区域标题）不得作为指令主题锚点——
  // 区域主题应经下面的互含匹配展开到真实 POI（亚龙湾森林公园 / 亚龙湾海滩）。
  const placeholderVisitIds = collectAreaPlaceholderVisitIds(trip);
  const candidates = Object.entries(trip.visits)
    .filter(([visitId]) => !placeholderVisitIds.has(visitId))
    .map(([visitId, visit]) => {
      const name = trip.itemRegistry[visit.pointRef]?.name ?? "";
      const normalized = normalizeName(name);
      return { visitId, visit, normalized };
    })
    .filter((entry) => entry.normalized !== "");
  const exact = candidates.filter((entry) => entry.normalized === target);
  if (exact.length > 0) return exact.map((entry) => entry.visitId);

  if (target.length < 2) return []; // 单字短语（如「海」）不做互含匹配，防偶然短词命中无关点
  const contains = candidates.filter(
    (entry) => entry.normalized.includes(target) || target.includes(entry.normalized),
  );
  const largeFirst = [...contains].sort((a, b) => {
    const aLarge = a.visit.kind === "large_attraction" ? 0 : 1;
    const bLarge = b.visit.kind === "large_attraction" ? 0 : 1;
    if (aLarge !== bLarge) return aLarge - bLarge;
    return Math.abs(a.normalized.length - target.length) - Math.abs(b.normalized.length - target.length);
  });
  return largeFirst.map((entry) => entry.visitId);
}

/** 目标短语 → 匹配到的全部 Visit（逐段多匹配，合并去重保序） */
function matchPlaceToVisits(trip: Trip, placeText: string): string[] {
  const resolved: string[] = [];
  for (const segment of splitPlaceSegments(placeText)) {
    for (const visitId of matchSegmentToVisits(trip, segment)) {
      if (!resolved.includes(visitId)) resolved.push(visitId);
    }
  }
  return resolved;
}

// ===== 指令解析主入口 =====

/**
 * 解析补充句为日期指令（纯函数）。
 * - 写了 DAY / 第…天 但缺数字 → AiError("GUIDE_DAY_NUMBER_REQUIRED")（HTTP 400，用户语言）；
 * - dayIndex 超出行程范围 → AiError("GUIDE_DAY_INDEX_OUT_OF_RANGE")（HTTP 400）；
 * - 无日期 token → 返回 []（补充句仅作软建议进入 prompt）。
 * 解析失败的句子立即抛错（不部分成功）：用户需要修正输入后重新生成。
 */
export function parseDraftDirectives(note: string, trip: Trip): GuideDraftDayDirective[] {
  const totalDays = trip.dayRefs.length;
  const directives: GuideDraftDayDirective[] = [];
  let counter = 0;
  for (const sentence of splitSentences(note)) {
    const scan = scanDayTokens(sentence);
    if (scan.missingNumber) {
      throw new AiError(
        "GUIDE_DAY_NUMBER_REQUIRED",
        `补充句「${sentence}」写了 DAY 但缺少年份数字，无法确定要安排到哪一天；请补全为「DAY3」「第3天」这样的写法后重新生成`,
      );
    }
    // Task #253：否定语序（「不要重排Day3」「不用重新安排Day3」「无需替换Day3」）不是整日替换
    // 意图，而是禁止改动；整句跳过，不生成任何指令（尤其不能退化成 append 把点排进该天）。
    // 「把 X 重新安排到 DayN」是移动语序，本就不算替换意图，仍按 append 处理。
    const isMoveOrder = MOVE_ORDER_RE.test(sentence);
    const affirmativeReplace = REPLACE_INTENT_RE.test(sentence) ? findAffirmativeReplaceIntent(sentence) : null;
    if (affirmativeReplace === null && !isMoveOrder && REPLACE_INTENT_RE.test(sentence)) continue;
    for (const token of scan.tokens) {
      if (!Number.isInteger(token.dayIndex) || token.dayIndex < 1 || token.dayIndex > totalDays) {
        throw new AiError(
          "GUIDE_DAY_INDEX_OUT_OF_RANGE",
          `补充句「${sentence}」指定了 Day ${token.dayIndex}，但当前行程共 ${totalDays} 天，请修改后再生成`,
        );
      }
      const rest = sentence.slice(token.restStart);
      const placeText = extractPlaceText(rest);
      counter += 1;
      // Task #248：整日替换意图（「把 X 重新安排到 DayN」是移动语序，仍按 append 处理）
      const replaceIntent = affirmativeReplace !== null && !isMoveOrder;
      directives.push({
        directiveId: `dir_${counter}`,
        dayIndex: token.dayIndex,
        placeText,
        resolvedVisitIds: placeText === "" ? [] : matchPlaceToVisits(trip, placeText),
        rawSentence: sentence,
        // 仅 replace 时写字段：append 保持旧形状（旧草案 / 旧断言零感知）
        ...(replaceIntent ? { mode: "replace" as const } : {}),
      });
    }
  }
  return directives;
}

// ===== prompt 注入 =====

/** 指令块的 prompt 序列化：声明不可自行改天；无指令返回 []（prompt 不出现该块） */
export function formatDirectivesPrompt(trip: Trip, directives: GuideDraftDayDirective[]): string[] {
  if (directives.length === 0) return [];
  const lines = ["【日期硬性指令】（来自用户补充句，优先级最高，不可违背）"];
  for (const directive of directives) {
    if (directive.mode === "replace") {
      // Task #248：整日替换——目标天视为空天，按本轮攻略重新规划整天
      if (directive.resolvedVisitIds.length > 0) {
        const named = directive.resolvedVisitIds
          .map((visitId) => `「${visitDisplayName(trip, visitId)}」（visit=${visitId}）`)
          .join("、");
        lines.push(
          `- Day ${directive.dayIndex}：用户要求整日替换（重排）该天，重排主题为 ${named}；该天旧安排会由服务端移回候选池，请把它当作空天重新规划整天（用户原话：「${directive.rawSentence}」）。`,
        );
      } else if (directive.placeText !== "") {
        lines.push(
          `- Day ${directive.dayIndex}：用户要求整日替换（重排）该天，并希望在当天安排「${directive.placeText}」；该天旧安排会由服务端移回候选池，但行程中没有该地点，不要凭空 plan（无 proposedNew 通道），可写 snippet 提示用户（用户原话：「${directive.rawSentence}」）。`,
        );
      } else {
        lines.push(
          `- Day ${directive.dayIndex}：用户要求整日替换（重排）该天；该天旧安排会由服务端移回候选池，请按本轮攻略重新规划整天（用户原话：「${directive.rawSentence}」）。`,
        );
      }
      continue;
    }
    if (directive.resolvedVisitIds.length > 0) {
      const named = directive.resolvedVisitIds
        .map((visitId) => `「${visitDisplayName(trip, visitId)}」（visit=${visitId}）`)
        .join("、");
      lines.push(`- Day ${directive.dayIndex}：把 ${named} 安排到 Day ${directive.dayIndex}（用户原话：「${directive.rawSentence}」）。`);
    } else {
      lines.push(
        `- Day ${directive.dayIndex}：用户希望在 Day ${directive.dayIndex} 安排「${directive.placeText}」，但行程中没有该地点；行程外地点不要凭空 plan（无 proposedNew 通道），可写 snippet 提示用户（用户原话：「${directive.rawSentence}」）。`,
      );
    }
  }
  lines.push(
    "上述排天要求是用户明确指令，不得以「更合理」为由改到其他天：",
    "- 目标 Visit 必须最终位于指定 Day（用 move / transfer 排入该天；已在该天的不必重复排）；",
    "- 目标 Visit 的内部玩法随父进入该天（内部玩法不支持独立跨天）；",
    "- 与其他排版原则冲突时，日期硬性指令优先；确实无法满足的不要强行输出操作（服务端会兜底补排）。",
  );
  if (directives.some((directive) => directive.mode === "replace")) {
    lines.push(
      "整日替换的补充约束：",
      "- 目标天现有普通安排由服务端移回候选池，该天按本轮攻略从空天开始重新规划整天；",
      "- 不得把目标天的旧安排挪到其他天（服务端会丢弃这类操作）；确实需要保留的旧安排，用 plan 明确放回目标天（服务端据此保留，不再移回）；",
      "- 不要输出针对将被移回旧安排的 setDuration / setTime / move / remove（服务端会丢弃；移回由服务端生成）。",
    );
  }
  return lines;
}

// ===== 操作辅助（subject / 目标天解析） =====

/** op 的 visit 级 subject id 集合（plan 取 assignments；其余取 subjectRef；classify 取被删 visit） */
function opSubjectVisitIds(op: Operation): string[] {
  if (op.op === "plan") {
    return op.assignments
      .map((assignment) => (assignment.subjectRef.kind === "visit" ? assignment.subjectRef.id : null))
      .filter((id): id is string => id !== null);
  }
  if (op.op === "classifyVisitAsStop") return [op.visitId];
  if ("subjectRef" in op && op.subjectRef.kind === "visit") return [op.subjectRef.id];
  return [];
}

/** op 的目标 dayIndex 集合（plan.scopeRef / move.containerRef / transfer.toContainerRef） */
function opTargetDayIndexes(op: Operation): number[] {
  if (op.op === "plan") return op.scopeRef.kind === "day" ? [op.scopeRef.dayIndex] : [];
  if (op.op === "move") return op.containerRef.kind === "day" ? [op.containerRef.dayIndex] : [];
  if (op.op === "transfer") return op.toContainerRef.kind === "day" ? [op.toContainerRef.dayIndex] : [];
  return [];
}

/** 指令主体当前是否受保护（锁定 / 已购）：补排 op 以 ai_proposed 下发会被 G3 拒，需用户勾选冲突 */
function isSubjectProtected(trip: Trip, visitId: string): boolean {
  const visit = trip.visits[visitId];
  if (visit === undefined) return false;
  return visit.locked || visit.purchaseState === "bought";
}

/** 给指令主体补的确定性排天 op（transfer 跨天挪动 / 从候选区入天；toOrder=null = 追加目标天末尾）。
 *  护栏契约：move 是「同容器内改序」，跨天必须用 transfer（validateMoveDetail 拒绝跨天 move）。 */
function buildDirectiveTransferOp(trip: Trip, visitId: string, dayIndex: number): Operation | null {
  const location = findVisitLocation(trip, visitId);
  if (location === null) return null;
  const name = visitDisplayName(trip, visitId);
  if (location.where === "day") {
    if (location.dayIndex === dayIndex) return null; // 已在目标天，无需 op
    return {
      op: "transfer",
      subjectRef: { kind: "visit", id: visitId },
      fromContainerRef: { kind: "day", dayIndex: location.dayIndex },
      toContainerRef: { kind: "day", dayIndex },
      toOrder: null, // null = 追加到目标天末尾（护栏允许，避免执行时长度漂移）
      reason: `补充句明确指定 Day${dayIndex}，「${name}」由服务端补排（原 Day${location.dayIndex}）`,
    };
  }
  if (location.where === "globalPool") {
    return {
      op: "transfer",
      subjectRef: { kind: "visit", id: visitId },
      fromContainerRef: { kind: "globalPool" },
      toContainerRef: { kind: "day", dayIndex },
      toOrder: null,
      reason: `补充句明确指定 Day${dayIndex}，「${name}」由服务端从候选区补排`,
    };
  }
  return null;
}

/** 冲突 resolution 的替代天：避开指定天，选已有安排最少的一天（不存在返回 null） */
function pickAlternativeDay(trip: Trip, avoidDayIndex: number): number | null {
  let best: { dayIndex: number; load: number } | null = null;
  for (let dayIndex = 1; dayIndex <= trip.dayRefs.length; dayIndex += 1) {
    if (dayIndex === avoidDayIndex) continue;
    const day = getDayByIndex(trip, dayIndex);
    if (day === null) continue;
    const load = day.scheduleVisitRefs.length;
    if (best === null || load < best.load) best = { dayIndex, load };
  }
  return best?.dayIndex ?? null;
}

// ===== 冲突检测 =====

interface DroppedClassify {
  op: Operation & { op: "classifyVisitAsStop" };
  guard: string | null;
  reason: string;
}

/**
 * 检测排天冲突（生成阶段，任务 125 勾选数据源）：
 * - 敏感冲突（锁定 / 已购 / 航班 / 受保护子项）默认不选；
 * - 普通冲突（目标天已有普通安排）为纯告知，默认不选（无 resolution 可执行）；
 * - 生成阶段不直接覆盖受影响项：只列冲突，选中后 apply 以 user_confirmed 执行 resolution。
 */
export function detectDirectiveConflicts(
  trip: Trip,
  directives: GuideDraftDayDirective[],
  droppedClassifies: DroppedClassify[],
): GuideDraftConflict[] {
  const conflicts: GuideDraftConflict[] = [];
  let counter = 0;
  const nextId = (): string => {
    counter += 1;
    return `cf_${counter}`;
  };

  for (const directive of directives) {
    const targetDay = getDayByIndex(trip, directive.dayIndex);
    if (targetDay === null) continue; // parse 已保证范围内（防御）
    const subjectSet = new Set(directive.resolvedVisitIds);

    // A. 指令主体自身受保护且不在目标天：补排的 transfer 需要用户确认（已在目标天无需移动）
    for (const visitId of directive.resolvedVisitIds) {
      const visit = trip.visits[visitId];
      if (visit === undefined) continue;
      const location = findVisitLocation(trip, visitId);
      if (location === null) continue;
      if (!(location.where === "day" || location.where === "globalPool")) continue;
      const currentDayIndex = location.where === "day" ? location.dayIndex : null;
      if (currentDayIndex === directive.dayIndex) continue; // 已在目标天：无补排、无移动、无冲突
      const name = visitDisplayName(trip, visitId);
      const resolution: Operation = {
        op: "transfer",
        subjectRef: { kind: "visit", id: visitId },
        fromContainerRef:
          location.where === "day" ? { kind: "day", dayIndex: location.dayIndex } : { kind: "globalPool" },
        toContainerRef: { kind: "day", dayIndex: directive.dayIndex },
        toOrder: null,
        reason: `用户确认：按补充句指令把「${name}」移入 Day ${directive.dayIndex}`,
      };
      if (visit.locked) {
        conflicts.push({
          conflictId: nextId(),
          directiveId: directive.directiveId,
          kind: "subject_locked",
          subjectRef: { kind: "visit", id: visitId },
          subjectLabel: name,
          detail: `「${name}」当前已锁定，默认不会移动；勾选后将把它移入 Day ${directive.dayIndex}（锁定状态保留）`,
          sensitive: true,
          defaultSelected: false,
          resolution,
        });
      } else if (visit.purchaseState === "bought") {
        conflicts.push({
          conflictId: nextId(),
          directiveId: directive.directiveId,
          kind: "subject_bought",
          subjectRef: { kind: "visit", id: visitId },
          subjectLabel: name,
          detail: `「${name}」已购票，默认不会移动；勾选后将把它移入 Day ${directive.dayIndex}（请自行确认票务日期仍适用）`,
          sensitive: true,
          defaultSelected: false,
          resolution,
        });
      }
    }

    if (directive.mode === "replace") {
      // Task #248：整日替换——普通项移回候选池（纯告知），锁定 / 已购项逐项告知保留
      // （不做 B 段的「挪到其他天」：替换语义下保护项就该留在原天）
      const removedNames = (directive.replaceRemovedVisitIds ?? []).map((visitId) =>
        visitDisplayName(trip, visitId),
      );
      const keptNames = (directive.replaceKeptVisitIds ?? []).map((visitId) => visitDisplayName(trip, visitId));
      if (removedNames.length > 0 || keptNames.length > 0) {
        const parts: string[] = [];
        if (removedNames.length > 0) {
          parts.push(
            `「${removedNames.join("、")}」将移回候选池，再由本轮规划按攻略重新安排 Day ${directive.dayIndex}`,
          );
        }
        if (keptNames.length > 0) {
          parts.push(`锁定 / 已购的「${keptNames.join("、")}」保留在原天，不参与本次替换`);
        }
        conflicts.push({
          conflictId: nextId(),
          directiveId: directive.directiveId,
          kind: "target_day_replace",
          subjectRef: null,
          subjectLabel: `Day ${directive.dayIndex}`,
          detail: `整日替换 Day ${directive.dayIndex}：${parts.join("；")}`,
          sensitive: false,
          defaultSelected: false,
          resolution: null,
        });
      }
      for (const visitId of directive.replaceKeptVisitIds ?? []) {
        const visit = trip.visits[visitId];
        if (visit === undefined) continue;
        const name = visitDisplayName(trip, visitId);
        conflicts.push({
          conflictId: nextId(),
          directiveId: directive.directiveId,
          kind: "replace_kept_protected",
          subjectRef: { kind: "visit", id: visitId },
          subjectLabel: name,
          detail: `「${name}」${visit.locked ? "已锁定" : "已购票"}，整日替换时保留在 Day ${directive.dayIndex}，不会移回候选池；如需替换它，请先解锁（或走改订）后重新生成草案`,
          sensitive: true,
          defaultSelected: false,
          resolution: null,
        });
      }
    } else {
      // B. 目标天已有安排（排除指令主体自身）：锁定 / 已购逐项列出（可勾选挪走），普通项汇总告知
      const others = targetDay.scheduleVisitRefs.filter((visitId) => !subjectSet.has(visitId));
      const plainOthers: string[] = [];
      for (const otherId of others) {
        const other = trip.visits[otherId];
        if (other === undefined) continue;
        const otherName = visitDisplayName(trip, otherId);
        if (other.locked || other.purchaseState === "bought") {
          const alternative = pickAlternativeDay(trip, directive.dayIndex);
          const locked = other.locked;
          const altText = alternative !== null ? `Day ${alternative}` : "其他天（当前无可用替代天）";
          conflicts.push({
            conflictId: nextId(),
            directiveId: directive.directiveId,
            kind: locked ? "target_day_locked" : "target_day_bought",
            subjectRef: { kind: "visit", id: otherId },
            subjectLabel: otherName,
            detail: locked
              ? `Day ${directive.dayIndex} 已有锁定的「${otherName}」；勾选后将把它挪到 ${altText}（锁定状态保留），给指令项腾出空间`
              : `Day ${directive.dayIndex} 已有已购的「${otherName}」；勾选后将把它挪到 ${altText}（请自行确认票务日期仍适用）`,
            sensitive: true,
            defaultSelected: false,
            resolution:
              alternative !== null
                ? {
                    op: "transfer",
                    subjectRef: { kind: "visit", id: otherId },
                    fromContainerRef: { kind: "day", dayIndex: directive.dayIndex },
                    toContainerRef: { kind: "day", dayIndex: alternative },
                    toOrder: null,
                    reason: `用户确认：为 Day ${directive.dayIndex} 的指令安排腾出空间，把「${otherName}」挪到 Day ${alternative}`,
                  }
                : null,
          });
        } else {
          plainOthers.push(otherName);
        }
      }
      if (plainOthers.length > 0) {
        conflicts.push({
          conflictId: nextId(),
          directiveId: directive.directiveId,
          kind: "target_day_occupied",
          subjectRef: null,
          subjectLabel: `Day ${directive.dayIndex}`,
          detail: `Day ${directive.dayIndex} 已有安排：${plainOthers.join("、")}；「${directives
            .map((entry) => entry.placeText)
            .filter((text) => text !== "")
            .join("、")}」将追加到当天末尾，不会覆盖既有项`,
          sensitive: false,
          defaultSelected: false,
          resolution: null,
        });
      }
    }

    // C. 目标天有航班约束：不可调整，纯告知
    const flightLabels = trip.constraints
      .filter(
        (constraint) =>
          (constraint.type === "flight_arrive" || constraint.type === "flight_depart") &&
          constraint.dayIndex === directive.dayIndex,
      )
      .map((constraint) => constraint.label);
    if (flightLabels.length > 0) {
      conflicts.push({
        conflictId: nextId(),
        directiveId: directive.directiveId,
        kind: "target_day_flight",
        subjectRef: null,
        subjectLabel: `Day ${directive.dayIndex}`,
        detail: `Day ${directive.dayIndex} 存在航班约束（${flightLabels.join("、")}），当天可用时间可能有限，指令项将安排在航班之外的空档`,
        sensitive: true,
        defaultSelected: false,
        resolution: null,
      });
    }
  }

  // D. 被护栏拒绝的自动归类（子项锁定 / 已购）：生成「建议用户手动处理」的告知冲突
  for (const dropped of droppedClassifies) {
    const visit = trip.visits[dropped.op.visitId];
    if (visit === undefined) continue;
    const name = visitDisplayName(trip, dropped.op.visitId);
    const locked = visit.locked;
    conflicts.push({
      conflictId: nextId(),
      directiveId: null,
      kind: locked ? "child_locked" : "child_bought",
      subjectRef: { kind: "visit", id: dropped.op.visitId },
      subjectLabel: name,
      detail: locked
        ? `攻略证据支持把「${name}」归入父景区，但该到访已锁定，自动归类被安全规则拦截；请先在前端解锁后手动归类`
        : `攻略证据支持把「${name}」归入父景区，但该到访已购票，自动归类被安全规则拦截；请手动确认后归类`,
      sensitive: true,
      defaultSelected: false,
      resolution: null,
    });
  }

  return conflicts;
}

// ===== requirement 计算 =====

/** visit 的有效终态天：visit 存在取其天；被 classify 删除时经 Stop.classifiedFromVisitRef 反查父的天 */
function resolveEffectiveDayIndex(trip: Trip, visitId: string): number | null {
  const direct = visitDayIndex(trip, visitId);
  if (direct !== null) return direct;
  for (const stop of Object.values(trip.stops ?? {})) {
    if (stop.classifiedFromVisitRef !== visitId) continue;
    if (stop.visitRef === null) continue;
    const parentDay = visitDayIndex(trip, stop.visitRef);
    if (parentDay !== null) return parentDay;
  }
  return null;
}

/**
 * Task #248：整日替换的「移回 / 保留」说明片段。
 * tense=future：生成阶段推演（将移回）；past：apply 后真实结果（已移回）。
 */
function buildReplaceNotes(removedNames: string[], keptNames: string[], tense: "future" | "past"): string[] {
  const notes: string[] = [];
  if (removedNames.length > 0) {
    notes.push(`原安排「${removedNames.join("、")}」${tense === "future" ? "将移回候选池" : "已移回候选池"}`);
  }
  if (keptNames.length > 0) {
    notes.push(`锁定 / 已购的「${keptNames.join("、")}」保留在原天`);
  }
  return notes;
}

/** Task #248：整日替换的满足校验（生成阶段，按「草案操作全部成功应用」的终态推演） */
function computeReplaceCheckFromOperations(
  trip: Trip,
  directive: GuideDraftDayDirective,
  operations: Operation[],
): GuideDraftRequirementCheck {
  const base = { directiveId: directive.directiveId, dayIndex: directive.dayIndex, placeText: directive.placeText };
  const notes = buildReplaceNotes(
    (directive.replaceRemovedVisitIds ?? []).map((visitId) => visitDisplayName(trip, visitId)),
    (directive.replaceKeptVisitIds ?? []).map((visitId) => visitDisplayName(trip, visitId)),
    "future",
  );
  const noteSuffix = notes.length > 0 ? `；${notes.join("；")}` : "";
  if (directive.resolvedVisitIds.length === 0) {
    if (directive.placeText === "") {
      return { ...base, status: "met", detail: `Day ${directive.dayIndex} 将整日重排${noteSuffix}` };
    }
    return {
      ...base,
      status: "unmet",
      detail: `「${directive.placeText}」未匹配到行程中的地点，Day ${directive.dayIndex} 的整日重排无法包含该地点${noteSuffix}`,
    };
  }
  const satisfied: string[] = [];
  const missing: string[] = [];
  let pendingSubject = false;
  for (const visitId of directive.resolvedVisitIds) {
    const currentDay = visitDayIndex(trip, visitId);
    const hasTargetOp = operations.some(
      (op) =>
        op.op !== "classifyVisitAsStop" &&
        opSubjectVisitIds(op).includes(visitId) &&
        opTargetDayIndexes(op).includes(directive.dayIndex),
    );
    if (currentDay === directive.dayIndex || hasTargetOp) {
      satisfied.push(visitDisplayName(trip, visitId));
      if (currentDay !== directive.dayIndex && isSubjectProtected(trip, visitId)) pendingSubject = true;
    } else {
      missing.push(visitDisplayName(trip, visitId));
    }
  }
  if (satisfied.length === 0) {
    return {
      ...base,
      status: "unmet",
      detail: `「${directive.placeText}」未能安排到 Day ${directive.dayIndex}${noteSuffix}`,
    };
  }
  if (missing.length > 0) {
    return {
      ...base,
      status: "partial",
      detail: `「${satisfied.join("、")}」将位于 Day ${directive.dayIndex}；「${missing.join("、")}」未能排入${noteSuffix}`,
    };
  }
  if (pendingSubject) {
    return {
      ...base,
      status: "pending",
      detail: `Day ${directive.dayIndex} 将整日重排；「${satisfied.join("、")}」处于锁定 / 已购状态，需在冲突清单中确认后才会移入${noteSuffix}`,
    };
  }
  return {
    ...base,
    status: "met",
    detail: `Day ${directive.dayIndex} 将整日重排，「${satisfied.join("、")}」位于当天${noteSuffix}`,
  };
}

/** Task #248：整日替换的满足校验（apply 后，按真实行程重算） */
function computeReplaceCheckFromTrip(trip: Trip, directive: GuideDraftDayDirective): GuideDraftRequirementCheck {
  const base = { directiveId: directive.directiveId, dayIndex: directive.dayIndex, placeText: directive.placeText };
  const movedBackNames: string[] = [];
  const stuckNames: string[] = [];
  for (const visitId of directive.replaceRemovedVisitIds ?? []) {
    const name = visitDisplayName(trip, visitId);
    const location = findVisitLocation(trip, visitId);
    if (location !== null && location.where === "globalPool") movedBackNames.push(name);
    else if (location !== null && location.where === "day" && location.dayIndex === directive.dayIndex) {
      stuckNames.push(name);
    }
  }
  const keptNames = (directive.replaceKeptVisitIds ?? [])
    .filter((visitId) => visitDayIndex(trip, visitId) === directive.dayIndex)
    .map((visitId) => visitDisplayName(trip, visitId));
  const noteSuffix = (() => {
    const notes = buildReplaceNotes(movedBackNames, keptNames, "past");
    return notes.length > 0 ? `；${notes.join("；")}` : "";
  })();
  if (stuckNames.length > 0) {
    return {
      ...base,
      status: "partial",
      detail: `Day ${directive.dayIndex} 整日重排未完全生效：「${stuckNames.join("、")}」未能移回候选池（可能受安全规则限制）${noteSuffix}`,
    };
  }
  if (directive.resolvedVisitIds.length === 0) {
    if (directive.placeText === "") {
      return { ...base, status: "met", detail: `Day ${directive.dayIndex} 已整日重排${noteSuffix}` };
    }
    return {
      ...base,
      status: "unmet",
      detail: `补充句中的「${directive.placeText}」未匹配到行程中的地点，Day ${directive.dayIndex} 的整日重排未包含该地点${noteSuffix}`,
    };
  }
  const satisfied: string[] = [];
  const missing: string[] = [];
  for (const visitId of directive.resolvedVisitIds) {
    const effectiveDay = resolveEffectiveDayIndex(trip, visitId);
    if (effectiveDay === directive.dayIndex) satisfied.push(visitDisplayName(trip, visitId));
    else missing.push(visitDisplayName(trip, visitId));
  }
  if (satisfied.length === 0) {
    return {
      ...base,
      status: "unmet",
      detail: `Day ${directive.dayIndex} 整日重排未生效：「${missing.join("、")}」不在 Day ${directive.dayIndex}（可能因锁定 / 已购被安全规则拦截）${noteSuffix}`,
    };
  }
  if (missing.length > 0) {
    return {
      ...base,
      status: "partial",
      detail: `「${satisfied.join("、")}」已位于 Day ${directive.dayIndex}；「${missing.join("、")}」未生效${noteSuffix}`,
    };
  }
  return {
    ...base,
    status: "met",
    detail: `Day ${directive.dayIndex} 已整日重排，「${satisfied.join("、")}」位于当天${noteSuffix}`,
  };
}

/**
 * 生成时的指令满足校验：按「草案操作全部成功应用」的终态推演。
 * - resolved 为空 → unmet；
 * - 主体受保护（补排 op 会被 G3 拒，需用户勾选冲突）→ pending；
 * - 全部主体终态在指定天 → met；部分 → partial（placeText 拆段有未匹配项）。
 */
export function computeRequirementChecksFromOperations(
  trip: Trip,
  directives: GuideDraftDayDirective[],
  operations: Operation[],
): GuideDraftRequirementCheck[] {
  return directives.map((directive) => {
    const base = { directiveId: directive.directiveId, dayIndex: directive.dayIndex, placeText: directive.placeText };
    // Task #248：整日替换单独推演（移回项 / 保留项 + 重排主题是否落到目标天）；
    // Task #253：被补排门控跳过的一天降级为非 met 并带出原因
    if (directive.mode === "replace") {
      return applyReplaceSkipNote(
        computeReplaceCheckFromOperations(trip, directive, operations),
        directive.replaceSkippedReason,
      );
    }
    const segments = splitPlaceSegments(directive.placeText);
    if (directive.resolvedVisitIds.length === 0) {
      return {
        ...base,
        status: "unmet" as const,
        detail: `补充句中的「${directive.placeText}」未匹配到行程中的地点，无法安排到 Day ${directive.dayIndex}`,
      };
    }
    const classifyDeleted = new Set(
      operations
        .filter((op): op is Operation & { op: "classifyVisitAsStop" } => op.op === "classifyVisitAsStop")
        .map((op) => op.visitId),
    );
    const satisfiedNames: string[] = [];
    const missingNames: string[] = [];
    let pendingSubject = false;
    for (const visitId of directive.resolvedVisitIds) {
      const name = visitDisplayName(trip, visitId);
      let effectiveDay: number | null;
      if (classifyDeleted.has(visitId)) {
        // 主体被自动归类删除：终态跟随父 Visit 的推演终态天（父被排到指定天的 op
        // 也计入——子项随父移动；多匹配后同一指令常含被归类的子项，如「亚龙湾」
        // 命中的子景点被归入父景区时，子项终态应随父的补排天判定）
        const classify = operations.find(
          (op): op is Operation & { op: "classifyVisitAsStop" } =>
            op.op === "classifyVisitAsStop" && op.visitId === visitId,
        );
        if (classify === undefined) {
          effectiveDay = null;
        } else {
          const parentCurrentDay = resolveEffectiveDayIndex(trip, classify.parentVisitId);
          const parentHasTargetOp = operations.some(
            (op) =>
              op.op !== "classifyVisitAsStop" &&
              opSubjectVisitIds(op).includes(classify.parentVisitId) &&
              opTargetDayIndexes(op).includes(directive.dayIndex),
          );
          effectiveDay = parentCurrentDay === directive.dayIndex || parentHasTargetOp ? directive.dayIndex : null;
        }
      } else {
        const currentDay = visitDayIndex(trip, visitId);
        const hasTargetOp = operations.some(
          (op) =>
            op.op !== "classifyVisitAsStop" &&
            opSubjectVisitIds(op).includes(visitId) &&
            opTargetDayIndexes(op).includes(directive.dayIndex),
        );
        effectiveDay = currentDay === directive.dayIndex || hasTargetOp ? directive.dayIndex : null;
      }
      if (effectiveDay === directive.dayIndex) {
        satisfiedNames.push(name);
        if (!classifyDeleted.has(visitId)) {
          const currentDay = visitDayIndex(trip, visitId);
          if (currentDay !== null && currentDay !== directive.dayIndex && isSubjectProtected(trip, visitId)) {
            pendingSubject = true;
          }
          if (currentDay === null && isSubjectProtected(trip, visitId)) pendingSubject = true;
        }
      } else {
        missingNames.push(name);
      }
    }
    if (satisfiedNames.length === 0) {
      return {
        ...base,
        status: "unmet" as const,
        detail: `「${directive.placeText}」未能安排到 Day ${directive.dayIndex}（行程中无匹配或无法移动）`,
      };
    }
    // Task #147：一段可多匹配后「段数 > resolved 数」不再等价于「有段未匹配」，
    // 直接检测与 resolved 无交集的段（partial 判定不受多匹配影响）
    const unmatchedSegments = segments.filter((segment) => {
      const matched = matchSegmentToVisits(trip, segment);
      return matched.length === 0 || !matched.some((visitId) => directive.resolvedVisitIds.includes(visitId));
    });
    if (missingNames.length > 0 || unmatchedSegments.length > 0) {
      return {
        ...base,
        status: "partial" as const,
        detail: `「${satisfiedNames.join("、")}」将位于 Day ${directive.dayIndex}；「${unmatchedSegments.join("、") || missingNames.join("、")}」未能在行程中找到对应地点`,
      };
    }
    if (pendingSubject) {
      return {
        ...base,
        status: "pending" as const,
        detail: `「${satisfiedNames.join("、")}」已按 Day ${directive.dayIndex} 生成排天，但该到访处于锁定/已购状态，需在冲突清单中确认后才会实际移动`,
      };
    }
    return {
      ...base,
      status: "met" as const,
      detail: `「${satisfiedNames.join("、")}」将位于 Day ${directive.dayIndex}`,
    };
  });
}

/**
 * apply 后按真实行程重算指令满足状态（pending 收敛为三态）：
 * - visit 已被 classify 删除时经 Stop.classifiedFromVisitRef 反查父的天；
 * - 未达标的 detail 说明原因（被拒 / 未勾选冲突）；
 * - Task #253：replaceSkips 传入 apply 时新产生的跳过原因（如未获用户确认），
 *   优先于指令自带的 replaceSkippedReason。
 */
export function computeRequirementChecksFromTrip(
  trip: Trip,
  directives: GuideDraftDayDirective[],
  replaceSkips?: ReadonlyMap<number, string>,
): GuideDraftRequirementCheck[] {
  return directives.map((directive) => {
    const base = { directiveId: directive.directiveId, dayIndex: directive.dayIndex, placeText: directive.placeText };
    // Task #248：整日替换按真实行程重算（移回是否真实发生 / 保护项是否保留）
    if (directive.mode === "replace") {
      const skipReason = replaceSkips?.get(directive.dayIndex) ?? directive.replaceSkippedReason;
      return applyReplaceSkipNote(computeReplaceCheckFromTrip(trip, directive), skipReason);
    }
    const segments = splitPlaceSegments(directive.placeText);
    if (directive.resolvedVisitIds.length === 0) {
      return {
        ...base,
        status: "unmet" as const,
        detail: `补充句中的「${directive.placeText}」未匹配到行程中的地点，Day ${directive.dayIndex} 指令未生效`,
      };
    }
    const satisfiedNames: string[] = [];
    const missingNames: string[] = [];
    for (const visitId of directive.resolvedVisitIds) {
      const name = visitDisplayName(trip, visitId);
      const effectiveDay = resolveEffectiveDayIndex(trip, visitId);
      if (effectiveDay === directive.dayIndex) satisfiedNames.push(name);
      else missingNames.push(name);
    }
    if (satisfiedNames.length === 0) {
      return {
        ...base,
        status: "unmet" as const,
        detail: `Day ${directive.dayIndex} 指令未生效：「${missingNames.join("、")}」不在 Day ${directive.dayIndex}（可能因锁定/已购被安全规则拦截，或冲突未勾选）`,
      };
    }
    // Task #147：同上——多匹配下直接检测与 resolved 无交集的段（长度启发式失效）
    const unmatchedSegments = segments.filter((segment) => {
      const matched = matchSegmentToVisits(trip, segment);
      return matched.length === 0 || !matched.some((visitId) => directive.resolvedVisitIds.includes(visitId));
    });
    if (missingNames.length > 0 || unmatchedSegments.length > 0) {
      return {
        ...base,
        status: "partial" as const,
        detail: `「${satisfiedNames.join("、")}」已位于 Day ${directive.dayIndex}；「${unmatchedSegments.join("、") || missingNames.join("、")}」未生效`,
      };
    }
    return {
      ...base,
      status: "met" as const,
      detail: `「${satisfiedNames.join("、")}」已位于 Day ${directive.dayIndex}`,
    };
  });
}

// ===== 操作清洗（Task #253） =====

/**
 * 剔除引用「不可操作 Visit」的模型操作（Task #253 两种场景：整日替换移回项、区域占位点位）。
 * - plan 逐 assignment 过滤（只丢引用不可操作实体的项，保留其余入天安排）；
 * - 其余带 subjectRef 的 op（move / remove / setDuration / setTime / transfer / setPurchase / lock）
 *   命中即整条移除；引用 stop 时经 stop.visitRef 回到父 Visit 判定；
 * - classifyVisitAsStop 无 subjectRef，由调用方单独处理。
 * 只做「不下发」，不放宽任何护栏。
 */
export function stripOpsReferencingVisits(
  trip: Trip,
  operations: Operation[],
  excludedVisitIds: ReadonlySet<string>,
  label: string,
  removedOps: { op: Operation; reason: string }[],
): Operation[] {
  if (excludedVisitIds.size === 0) return operations;
  const referencesExcluded = (op: Operation): boolean => {
    if (op.op === "classifyVisitAsStop") return false;
    if (opSubjectVisitIds(op).some((visitId) => excludedVisitIds.has(visitId))) return true;
    if ("subjectRef" in op && op.subjectRef.kind === "stop") {
      const parentVisitId = trip.stops[op.subjectRef.id]?.visitRef ?? null;
      return parentVisitId !== null && excludedVisitIds.has(parentVisitId);
    }
    return false;
  };
  const result: Operation[] = [];
  for (const op of operations) {
    if (op.op === "plan") {
      const keptAssignments = op.assignments.filter(
        (assignment) => !(assignment.subjectRef.kind === "visit" && excludedVisitIds.has(assignment.subjectRef.id)),
      );
      if (keptAssignments.length === op.assignments.length) {
        result.push(op);
      } else if (keptAssignments.length > 0) {
        removedOps.push({ op, reason: `${label}：plan 中引用不可操作实体的 assignment 已剔除` });
        result.push({ ...op, assignments: keptAssignments });
      } else {
        removedOps.push({ op, reason: `${label}：plan 全部 assignment 引用不可操作实体，已移除` });
      }
      continue;
    }
    if (referencesExcluded(op)) {
      removedOps.push({ op, reason: `${label}：${op.op} 引用的实体不可操作，该操作已移除` });
      continue;
    }
    result.push(op);
  }
  return result;
}

/**
 * Task #253：整日替换被门控跳过（没有可落地的新规划 / 移回未发生）时的说明补强——
 * 移回没有发生就不能报 met，否则用户会误以为旧安排已被替换。
 */
function applyReplaceSkipNote(
  check: GuideDraftRequirementCheck,
  reason: string | undefined,
): GuideDraftRequirementCheck {
  if (reason === undefined || reason === "") return check;
  const detail = `${check.detail}；未执行整日移回：${reason}`;
  return check.status === "met" ? { ...check, status: "partial", detail } : { ...check, detail };
}

// ===== 生成后校验主入口 =====

export interface EnforceDirectivesResult {
  /** 调整后的操作序列（classify 前置 + 错误排天移除 + 服务端补排 + 整日替换移回） */
  operations: Operation[];
  /** 注解后的指令（整日替换附 replaceRemovedVisitIds / replaceKeptVisitIds；旧字段缺省） */
  directives: GuideDraftDayDirective[];
  requirementChecks: GuideDraftRequirementCheck[];
  conflicts: GuideDraftConflict[];
  autoClassifications: GuideDraftAutoClassification[];
  /** 被移除的模型操作与原因（日志与调试可见，不进返回体） */
  removedOps: { op: Operation; reason: string }[];
}

/**
 * 模型返回后的指令硬约束执行（生成阶段，保存草案前）：
 *
 * 1. classifyVisitAsStop 逐条过 validateOperation（ai_proposed 语义，含任务 122 强证据
 *    双侧追溯护栏）——证据不足直接丢弃不下发（任务 123「证据不足不下发此 op」）；
 *    G3 拒绝（子项锁定/已购）转为告知冲突；
 * 2. 全部保留的 classify 前置（先归类、后安排 parent，避免先 plan 已被删除的 child Visit）；
 * 3. 逐指令后校验：模型把目标 Visit 排到其他天的 op 被移除，服务端补确定性 move/transfer
 *    保证终态位于指定 Day（不重试 AI）；
 * 4. 计算 requirementChecks（终态推演）与 conflicts（含默认选中策略）。
 *
 * Task #248：mode="replace" 的指令额外执行整日替换——目标天内未锁定 / 未购买 / 非受保护
 * Visit 生成确定性 remove（from=Day → globalPool，复用既有 remove 语义）移回候选池；
 * 锁定 / 已购项保留并生成告知冲突；模型针对被移回实体的跨天 / 属性 / 重复 remove 操作
 * 一并丢弃（避免与确定性移回竞态或引用已不在天的实体）。
 *
 * 不放宽任何护栏：补排 op 与模型 op 一样在 apply 时重过四条护栏。
 */
export function enforceDraftDirectives(
  trip: Trip,
  directives: GuideDraftDayDirective[],
  parsedOperations: Operation[],
): EnforceDirectivesResult {
  const removedOps: EnforceDirectivesResult["removedOps"] = [];
  if (directives.length === 0) {
    // 无指令：仍需过滤弱证据 classify（证据不足不下发与指令无关）
    const kept: Operation[] = [];
    const droppedClassifies: DroppedClassify[] = [];
    for (const op of parsedOperations) {
      if (op.op !== "classifyVisitAsStop") {
        kept.push(op);
        continue;
      }
      const verdict = validateOperation(op, trip, "ai_proposed");
      if (verdict.valid) {
        kept.push(op);
        continue;
      }
      removedOps.push({ op, reason: verdict.reason ?? "classifyVisitAsStop 未通过护栏" });
      if (verdict.guard === "G3") droppedClassifies.push({ op, guard: verdict.guard, reason: verdict.reason ?? "" });
    }
    const ordered = [
      ...kept.filter((op) => op.op === "classifyVisitAsStop"),
      ...kept.filter((op) => op.op !== "classifyVisitAsStop"),
    ];
    // Task #253：区域占位点位不是操作目标——无指令时同样不下发对它的操作
    const placeholderVisitIds = collectAreaPlaceholderVisitIds(trip);
    const filtered = stripOpsReferencingVisits(
      trip,
      ordered.filter(
        (op) =>
          op.op !== "classifyVisitAsStop" ||
          (!placeholderVisitIds.has(op.visitId) && !placeholderVisitIds.has(op.parentVisitId)),
      ),
      placeholderVisitIds,
      "区域占位点位",
      removedOps,
    );
    return {
      operations: filtered,
      directives: [],
      requirementChecks: [],
      conflicts: detectDirectiveConflicts(trip, [], droppedClassifies),
      autoClassifications: buildAutoClassifications(trip, filtered),
      removedOps,
    };
  }

  const classifyOps: (Operation & { op: "classifyVisitAsStop" })[] = [];
  const dayOps: Operation[] = [];
  const droppedClassifies: DroppedClassify[] = [];
  for (const op of parsedOperations) {
    if (op.op !== "classifyVisitAsStop") {
      dayOps.push(op);
      continue;
    }
    const verdict = validateOperation(op, trip, "ai_proposed");
    if (verdict.valid) {
      classifyOps.push(op);
      continue;
    }
    removedOps.push({ op, reason: verdict.reason ?? "classifyVisitAsStop 未通过护栏" });
    if (verdict.guard === "G3") droppedClassifies.push({ op, guard: verdict.guard, reason: verdict.reason ?? "" });
    // 证据不足等其余原因：直接丢弃，不进 conflicts（conflicts 只承载排天冲突与受保护子项告知）
  }

  // Task #253：整日替换按目标日聚合——同一天可能有多条指令（「重排DAY3，DAY3安排第一市场」），
  // 保护集合必须先汇总**所有**有效指令点名的主体，再统一计算移回；否则第一条指令会把
  // 第二条指令点名的主体先移回，第二条指令落地时已无点可排（整日替换空转）。
  const placeholderVisitIds = collectAreaPlaceholderVisitIds(trip);
  // 区域占位点位不参与归类（归类一个区域标题会破坏其展示语义）
  const keptClassifyOps = classifyOps.filter((op) => {
    const hitsPlaceholder = placeholderVisitIds.has(op.visitId) || placeholderVisitIds.has(op.parentVisitId);
    if (hitsPlaceholder) {
      removedOps.push({ op, reason: "classifyVisitAsStop 指向区域占位点位（非可游玩 POI），未下发" });
    }
    return !hitsPlaceholder;
  });
  classifyOps.length = 0;
  classifyOps.push(...keptClassifyOps);
  const classifyVisitIds = new Set(classifyOps.map((op) => op.visitId));
  const modelKeepsOnTargetDay = (visitId: string, dayIndex: number): boolean =>
    dayOps.some(
      (op) =>
        op.op !== "classifyVisitAsStop" &&
        opSubjectVisitIds(op).includes(visitId) &&
        opTargetDayIndexes(op).includes(dayIndex),
    );
  
  // 1) 按目标日汇总「全部」指令（append + replace）点名的主体 = 该日保护集合
  const anchorsByDay = new Map<number, Set<string>>();
  const detachDayIndexes: number[] = [];
  for (const directive of directives) {
    let anchors = anchorsByDay.get(directive.dayIndex);
    if (anchors === undefined) {
      anchors = new Set<string>();
      anchorsByDay.set(directive.dayIndex, anchors);
    }
    for (const visitId of directive.resolvedVisitIds) anchors.add(visitId);
    if (directive.mode !== "replace") continue;
    // 点名地点在行程中不存在（placeText 非空但零匹配）：该条不产生移回——避免为无法
    // 落地的请求清空目标天；requirementCheck 会以 unmet 明确告知用户。同一天若还有其它
    // 可落地的 replace 指令，仍按天计算（不因此整日跳过）。
    if (directive.placeText !== "" && directive.resolvedVisitIds.length === 0) continue;
    if (!detachDayIndexes.includes(directive.dayIndex)) detachDayIndexes.push(directive.dayIndex);
  }
  
  // 2) 逐天统一计算移回 / 保留集合（去重；跳过锚点 / 归类目标 / 区域占位 / 模型显式保留）
  interface ReplaceDayPlan {
    dayIndex: number;
    removedVisitIds: string[];
    keptVisitIds: string[];
  }
  const replacePlans: ReplaceDayPlan[] = [];
  for (const dayIndex of detachDayIndexes.sort((a, b) => a - b)) {
    const targetDay = getDayByIndex(trip, dayIndex);
    if (targetDay === null) continue; // parse 已保证范围内（防御）
    const anchors = anchorsByDay.get(dayIndex) ?? new Set<string>();
    const removedVisitIds: string[] = [];
    const keptVisitIds: string[] = [];
    for (const visitId of targetDay.scheduleVisitRefs) {
      // 同一天重复引用只处理一次（移回集合必须去重）
      if (removedVisitIds.includes(visitId) || keptVisitIds.includes(visitId)) continue;
      const visit = trip.visits[visitId];
      if (visit === undefined) continue;
      // 保护项：锁定 / 已购一律保留（remove 对二者连用户通道都拒绝，不能安全移出）
      if (visit.locked || visit.purchaseState === "bought") {
        keptVisitIds.push(visitId);
        continue;
      }
      // 同一天所有指令点名的主体都是本轮重排主题：保留原位，由本轮规划围绕它重排
      if (anchors.has(visitId)) continue;
      // 本批 classify 的目标：终态跟随父 Visit，移回会破坏归类
      if (classifyVisitIds.has(visitId)) continue;
      // 区域占位点位只是区域标题：不删除、不移回、也不是操作目标
      if (placeholderVisitIds.has(visitId)) continue;
      // 模型显式 plan / transfer 回目标天 = 明确保留（prompt 提供的保留通道）
      if (modelKeepsOnTargetDay(visitId, dayIndex)) continue;
      removedVisitIds.push(visitId);
    }
    replacePlans.push({ dayIndex, removedVisitIds, keptVisitIds });
  }
  
  // 3) 清洗模型操作：旧安排回到候选池后，跨天挪动 / 属性调整 / 重复 remove 都失去意义，
  //    统一丢弃；引用区域占位点位的操作同样丢弃（既非锚点也非 plan 目标）。
  const detachVisitIds = new Set(replacePlans.flatMap((plan) => plan.removedVisitIds));
  const detachCleaned = stripOpsReferencingVisits(trip, dayOps, detachVisitIds, "整日替换：移回项", removedOps);
  const placeholderCleaned = stripOpsReferencingVisits(
    trip,
    detachCleaned,
    placeholderVisitIds,
    "区域占位点位",
    removedOps,
  );
  // 注意：stripOpsReferencingVisits 在排除集为空时**原样返回入参数组**（性能优化），
  // 必须先拷贝再清空 dayOps，否则 dayOps.length = 0 会把即将被 push 回来的同一数组清空。
  const cleanedDayOps = [...placeholderCleaned];
  dayOps.length = 0;
  dayOps.push(...cleanedDayOps);
  
  // 逐指令后校验：目标 Visit 终态必须位于指定 Day
  for (const directive of directives) {
    const classifyDeleted = new Set(classifyOps.map((op) => op.visitId));
    for (const visitId of directive.resolvedVisitIds) {
      // 主体被自动归类删除：终态跟随父，无需排天
      if (classifyDeleted.has(visitId)) continue;
      const currentDay = visitDayIndex(trip, visitId);
      const alreadyOnTarget = currentDay === directive.dayIndex;

      // 模型输出的排天 op 分类：指向目标天（保留） vs 指向其他天（移除并补排）
      let satisfiedByModel = false;
      for (let index = dayOps.length - 1; index >= 0; index -= 1) {
        const op = dayOps[index];
        if (op === undefined || op.op === "classifyVisitAsStop") continue;
        if (!opSubjectVisitIds(op).includes(visitId)) continue;
        const targets = opTargetDayIndexes(op);
        if (targets.length === 0) continue; // 非排天 op（setDuration 等）不动
        if (targets.includes(directive.dayIndex)) {
          satisfiedByModel = true;
          continue;
        }
        // 错误排天：移除（记录原因），由服务端补确定性 op
        removedOps.push({
          op,
          reason: `模型把「${visitDisplayName(trip, visitId)}」排到 Day ${targets.join("/")}，与日期指令 Day ${directive.dayIndex} 冲突，已移除并由服务端补排`,
        });
        dayOps.splice(index, 1);
      }
      if (satisfiedByModel || alreadyOnTarget) continue;

      // 服务端补确定性排天 op（transfer 跨天，ai_proposed 下发，apply 时照常过护栏）
      const transferOp = buildDirectiveTransferOp(trip, visitId, directive.dayIndex);
      if (transferOp !== null) dayOps.push(transferOp);
    }
  }

  // 4) 补排门控（Task #253）：只有本轮确实有新安排落进目标天时，才允许把旧安排移回候选池。
  //    模型新规划为空 / 全部被护栏拒绝 / 待用户确认 → 不执行任何整日移出，原天保持原样
  //    （否则整日替换会退化成「只清空不重排」）。判定基于清洗 + 服务端补排后的完整 dayOps。
  const replenishedDays = new Set<number>();
  for (const op of dayOps) {
    if (op.op === "classifyVisitAsStop") continue;
    if (op.op === "plan") {
      const scope = op.scopeRef;
      if (scope.kind !== "day") continue;
      const hasNewAssignment = op.assignments.some((assignment) => {
        const ref = assignment.subjectRef;
        if (ref.kind !== "visit") return true; // point 壳由 plan 新建，必为新排入
        return visitDayIndex(trip, ref.id) !== scope.dayIndex;
      });
      if (hasNewAssignment) replenishedDays.add(scope.dayIndex);
      continue;
    }
    if (op.op === "transfer") {
      const to = op.toContainerRef;
      if (to.kind !== "day") continue;
      const ref = op.subjectRef;
      if (ref.kind !== "visit") continue;
      if (visitDayIndex(trip, ref.id) !== to.dayIndex) replenishedDays.add(to.dayIndex);
    }
  }

  // 确定性移回操作：复用既有 remove（Visit 从 Day → globalPool）；apply 时照常过 G1/G3 与 30% 阈值
  const detachOps: Operation[] = [];
  const skippedReplaceDays = new Map<number, string>();
  for (const plan of replacePlans) {
    if (plan.removedVisitIds.length > 0 && !replenishedDays.has(plan.dayIndex)) {
      const reason = `本轮没有能排入 Day ${plan.dayIndex} 的新安排（模型规划为空、被安全规则拒绝或待用户确认），Day ${plan.dayIndex} 的旧安排保持不变`;
      skippedReplaceDays.set(plan.dayIndex, reason);
      console.warn(`[GUIDES] 整日替换 Day ${plan.dayIndex} 跳过移回：${reason}`);
      continue;
    }
    for (const visitId of plan.removedVisitIds) {
      detachOps.push({
        op: "remove",
        subjectRef: { kind: "visit", id: visitId },
        fromContainerRef: { kind: "day", dayIndex: plan.dayIndex },
        reason: `整日替换 Day ${plan.dayIndex}：「${visitDisplayName(trip, visitId)}」移回候选池，由本轮规划重新安排`,
      });
    }
  }
  // 注解后的指令：草案预览 / apply 据此识别移回项与保留项（append 指令原样返回）；
  // 被门控跳过的一天写 replaceSkippedReason 且移回项清空（移回未发生）
  const annotatedDirectives: GuideDraftDayDirective[] = directives.map((directive) => {
    if (directive.mode !== "replace") return directive;
    const plan = replacePlans.find((entry) => entry.dayIndex === directive.dayIndex);
    if (plan === undefined) return directive;
    const skippedReason = skippedReplaceDays.get(directive.dayIndex);
    if (skippedReason !== undefined) {
      return {
        ...directive,
        replaceRemovedVisitIds: [],
        replaceKeptVisitIds: [...plan.keptVisitIds],
        replaceSkippedReason: skippedReason,
      };
    }
    return {
      ...directive,
      replaceRemovedVisitIds: [...plan.removedVisitIds],
      replaceKeptVisitIds: [...plan.keptVisitIds],
    };
  });

  const operations: Operation[] = [...detachOps, ...classifyOps, ...dayOps];
  return {
    operations,
    directives: annotatedDirectives,
    requirementChecks: computeRequirementChecksFromOperations(trip, annotatedDirectives, operations),
    conflicts: detectDirectiveConflicts(trip, annotatedDirectives, droppedClassifies),
    autoClassifications: buildAutoClassifications(trip, operations),
    removedOps,
  };
}

/** 从操作序列派生自动归类摘要（草案预览与 apply 响应共用；外部可直接对 draft.output.operations 调用） */
export function buildAutoClassifications(trip: Trip, operations: Operation[]): GuideDraftAutoClassification[] {
  const result: GuideDraftAutoClassification[] = [];
  for (const op of operations) {
    if (op.op !== "classifyVisitAsStop") continue;
    result.push({
      visitId: op.visitId,
      visitName: visitDisplayName(trip, op.visitId),
      parentVisitId: op.parentVisitId,
      parentName: visitDisplayName(trip, op.parentVisitId),
      evidenceMentionRefs: [...op.evidenceMentionRefs],
      reason: op.reason,
    });
  }
  return result;
}

// ===== apply 侧 =====

/** 未选中冲突摘要（apply 响应回传，前端展示「保持原状」项） */
export interface UnselectedConflictSummary {
  conflictId: string;
  subjectLabel: string;
  detail: string;
}

/** 按 selectedConflictIds 过滤出可执行的冲突 resolution（id 存在且 resolution 非空） */
export function selectConflictResolutions(
  conflicts: GuideDraftConflict[],
  selectedConflictIds: string[] | undefined,
): { selected: GuideDraftConflict[]; unselected: UnselectedConflictSummary[] } {
  const idSet = new Set(selectedConflictIds ?? []);
  const selected: GuideDraftConflict[] = [];
  const unselected: UnselectedConflictSummary[] = [];
  for (const conflict of conflicts) {
    if (conflict.resolution !== null && idSet.has(conflict.conflictId)) selected.push(conflict);
    else unselected.push({ conflictId: conflict.conflictId, subjectLabel: conflict.subjectLabel, detail: conflict.detail });
  }
  return { selected, unselected };
}

/** requirement 汇总字符串：全部 met → null；否则生成部分满足 / 未满足说明 */
export function summarizeRequirementChecks(checks: GuideDraftRequirementCheck[]): string | null {
  if (checks.length === 0) return null;
  const notMet = checks.filter((check) => check.status !== "met");
  if (notMet.length === 0) return null;
  const parts = checks.map((check) => `${check.status === "met" ? "已满足" : check.status === "partial" ? "部分满足" : "未满足"}：${check.detail}`);
  return parts.join("；");
}
