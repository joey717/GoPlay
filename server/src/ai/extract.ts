/**
 * F5 攻略抽取流水线（PRD v1.1：正文 → SourceEvidence + Item + Visit/Stop 结构化写入）。
 *
 * 执行顺序：
 *   loadTrip → buildExtractPrompt → 百炼 SSE（Task #170：全部尝试共享一个总预算，
 *   解析失败至多重试一次、只使用剩余预算）
 *   → 逐条目 FlyAI 真实搜索对齐（同名查询共享缓存；命中建/复用 fliggy Item，未命中 custom）
 *   → attraction 条目：Item + Visit 壳（scale=large → large_attraction，否则 ordinary）；
 *     in_attraction 条目：Item + Stop，按 confidence 三级归属——
 *     high 自动 attached 到所属 Visit；medium pending + suggestedVisitRef；low pending 无建议
 *   → evidences 新增一条 note_text（mentions 全量记录原文/模型总结）
 *   → tripStore.save（内部 validateConsistency 把关）→ 返回 ExtractResult。
 *
 * 职责边界：
 * - 复用 bailian / flyai / persistence / assemble 既有实现，不在本模块重写；
 * - 模型输出一律不可信：解析层做结构归一化（非法项剔除、字段按契约兑底）；
 * - 搜索命中不是盲目取首个结果：名称归一化相等或互为包含才算对齐成功；
 * - 未命中点位降级 custom Item，不伪造 jumpUrl / mainPic；
 * - 同名/引用去重：Item 按 providerId 或归一化名去重；Stop 按 matchedPointRef
 *   或归一化名去重；证据引用追加去重；
 * - 图片（screenshot）抽取见 ocr.ts（Task #51）；正文与图片共用
 *   assemble.ts 装配层，证据结构同源。
 */

import type { FlyAIPoi } from "../flyai/client.js";
import type { SourceEvidence, Trip } from "@goplay/shared";
import { randomUUID } from "node:crypto";
import {
  assembleEntries,
  nextNoteIndex,
  normalizeParsedEntry,
  type ParsedEntry,
} from "./assemble.js";
import { createBailianSession, BailianTimeoutError, type BailianResult } from "../bailian/client.js";
import { getMissingBailianVars } from "../env.js";
import { tripStore } from "../persistence/store.js";
import { AiError, condenseErrorDetail, isBailianConfigError } from "./errors.js";
import { lastBalancedJsonValue } from "./lastJson.js";
import {
  assessLocalExtract,
  hasLocalFallbackEntries,
  markLocalFallbackEntries,
} from "./localExtract.js";
import { attributeNoteTips } from "./noteAttribution.js";
import { buildExtractPrompt } from "./prompt.js";


/** F5 抽取结果（routes 层原样 JSON 返回给前端）：本批实际写入的结构化视图 */
export interface ExtractResult {
  evidenceId: string;
  noteIndex: number;
  items: Array<{
    itemId: string;
    name: string;
    origin: "fliggy" | "custom";
    matched: boolean;
    /** 复用既有 Item（仅补充证据引用，非新建） */
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
  /** 本批新建 Visit（新入候选池）数量；既有 Visit 只补证据不计入 */
  newVisitCount: number;
  /** 本批复用既有 Visit（仅补充证据引用）数量 */
  reusedVisitCount: number;
  /** 本批新建且已自动挂入所属行程（attached）的 Stop 数量 */
  attachedStopCount: number;
  /** 本批新建且进入待定（pending）的 Stop 数量 */
  pendingStopCount: number;
  /** 本批复用既有 Stop（仅补充证据引用）数量 */
  reusedStopCount: number;
  errors: string[];
}

/** 解析失败后的最大百炼尝试次数（初次 + 1 次重试，与 F11 流水线一致） */
export const MAX_BAILIAN_ATTEMPTS = 2;

/** 短文本判定阈值：粘贴正文不足 100 字时视为短文本 */
const SHORT_TEXT_CHARS = 100;
/**
 * 短文本的百炼总预算。Task #91：Managed Agent 实测单轮 30~60s（含 Session 创建 +
 * SSE 等待 idle），30s 会把正常响应误判为超时，放宽到 60s。
 */
export const SHORT_TEXT_TIMEOUT_MS = 60_000;
/**
 * 常规文本的百炼总预算。Task #91：同一篇 522 字正文实测百炼耗时 29.7s / 30.2s /
 * 52.6s，并复现过 >60s 的首次超时。Task #170：该值从「每次尝试各持独立预算」改为
 * 「callAndParseExtract 全部尝试共享的总预算」——此前每次 createBailianSession 各自
 * 持有独立超时，解析失败重试叠加会突破上层兜底；现在每次尝试只分到剩余预算，本轮
 * 总等待被硬性封顶在本值。
 *
 * Task #305 校准：120s → 90s。实测百炼单轮 30~60s（Adam #302 诊断），90s 已足够
 * 容纳「首轮 + 一次重试」的典型耗时（如首轮 60s 解析失败、剩余 30s 重试）；把总预算
 * 收到 90s 可让服务端抽取阶段更早封顶，为后续 FlyAI 装配（见 assemble.ts 的
 * ASSEMBLE_BUDGET_MS）留出时间，避免整条来源处理链路累积过长。剩余不足
 * MIN_RETRY_BUDGET_MS（10s）时仍按既有逻辑不发起注定超时的重试。
 */
export const DEFAULT_EXTRACT_TIMEOUT_MS = 90_000;
/**
 * Task #170：发起解析失败重试的最小剩余预算。百炼单轮实测 27~41s，剩余不足 10s
 * 的重试几乎必然超时——与其白等到 deadline，不如立即按预算耗尽报错。
 */
export const MIN_RETRY_BUDGET_MS = 10_000;

/**
 * 剥离百炼 SSE 的整段 prompt 回显（Task #170）：实测（透传通道复现）finalText
 * 可能是「完整 prompt 回显 + 模型真实输出」拼接（finalText.startsWith(prompt)
 * 为真）；回显 prompt 自带「输出空数组 []」示例与 schema 对象——不剥离时它们会被
 * 解析层误当作最终空结果。仅处理整段前缀回显（startsWith 精确匹配）；部分回显
 * 无可靠锚点，交由 lastBalancedJsonValue 尾部候选兜底。
 */
function stripPromptEcho(text: string, prompt?: string): string {
  if (typeof prompt !== "string") return text;
  const promptBody = prompt.trim();
  if (promptBody === "" || !text.startsWith(promptBody)) return text;
  return text.slice(promptBody.length).trim();
}

/**
 * 对象包裹兼容（Task #170）：模型偶发把条目数组包在单字段对象里输出（如
 * {"entries": [...]}、{"mentions": [...]}）。仅当对象恰好只有一个字段且值为数组
 * 时才取该字段；多字段对象（回显 prompt 中的 schema 示例、F11 OperationSet 形态）
 * 一律拒绝，避免把示例对象误提取成条目。
 */
function extractSingleArrayField(value: unknown): unknown[] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const fieldValues = Object.values(value);
  if (fieldValues.length !== 1 || !Array.isArray(fieldValues[0])) return null;
  return fieldValues[0];
}

/** 单候选解析：JSON.parse → 数组直接用；对象仅按单字段规则解包；再逐条结构归一化 */
function tryParseEntryArray(candidate: string): ParsedEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  const array = Array.isArray(parsed) ? parsed : extractSingleArrayField(parsed);
  if (array === null) return null;
  return array
    .map(normalizeParsedEntry)
    .filter((entry): entry is ParsedEntry => entry !== null);
}

/**
 * 从模型 finalText 中解析条目数组（Task #170 尾部优先候选链，按序逐个尝试）：
 *   0. 剥离整段 prompt 回显（若有）
 *   1. 最后一个顶层平衡 JSON 值（lastJson.ts）——优先级最高：它位于回显之后的
 *      模型真实输出尾部，天然跳过回显 prompt 中的示例 []、schema 对象与括号
 *   2. markdown code fence 内容（多 fence 时从最后一个开始，尾部更可靠）
 *   3. 整体文本（无回显的纯数组 / 对象包裹直接命中）
 *   4. 首尾中括号截取（历史兜底：fence 未闭合等截断形态）
 * 空数组是合法输出（笔记没有可识别地点）；全部失败返回 null（由调用方决定重试）。
 */
export function parseExtractedArray(finalText: string, prompt?: string): ParsedEntry[] | null {
  const effective = stripPromptEcho(finalText.trim(), prompt);
  if (effective === "") return null;

  const candidates: string[] = [];
  const push = (value: string | null | undefined): void => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed !== "" && !candidates.includes(trimmed)) candidates.push(trimmed);
  };

  push(lastBalancedJsonValue(effective));

  const fences = [...effective.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]);
  for (let i = fences.length - 1; i >= 0; i--) push(fences[i]);

  push(effective);

  const arrayStart = effective.indexOf("[");
  const arrayEnd = effective.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    push(effective.slice(arrayStart, arrayEnd + 1));
  }

  for (const candidate of candidates) {
    const parsed = tryParseEntryArray(candidate);
    if (parsed !== null) return parsed;
  }
  return null;
}

// ===== 百炼调用（共享总预算 + 一次解析重试，Task #170） =====

/** callAgent 的最小返回面（BailianResult 的结构子集，便于测试桩实现） */
export type ExtractAgentResponse = Pick<BailianResult, "finalText" | "latencyMs">;

/**
 * Task #170：callAndParseExtract 的可注入依赖，供 verify-task170 确定性测试
 * 注入 agent 调用桩与虚拟时钟；业务路径用默认实现（真实百炼 + Date.now）。
 */
export interface ExtractCallDeps {
  callAgent: (prompt: string, options: { timeoutMs: number }) => Promise<ExtractAgentResponse>;
  now: () => number;
}

const DEFAULT_EXTRACT_CALL_DEPS: ExtractCallDeps = {
  callAgent: (prompt, options) => createBailianSession(prompt, options),
  now: () => Date.now(),
};

/**
 * 调百炼并解析条目数组。Task #170：**所有尝试共享一个 timeoutMs 总预算**——
 * 每次调用只分到剩余预算（createBailianSession 的单次超时 = 剩余值），本轮总等待
 * 被硬性封顶；解析失败至多重试一次，且剩余预算不足 MIN_RETRY_BUDGET_MS 时直接按
 * 预算耗尽报错，不再发起注定超时的调用；网络超时一次即抛出（不重试）。
 * 两次均解析失败返回 null；异常按分类抛出：
 * - 配置类异常（变量缺失/前缀不合法）→ ENV_NOT_CONFIGURED
 * - 超时/预算耗尽 → BAILIAN_REQUEST_FAILED（消息报告本轮总耗时与总预算，
 *   cause 携带 BailianTimeoutError——routes 层据此不再自动重试）
 * - 其余（网络/HTTP 状态）→ BAILIAN_REQUEST_FAILED（细节仅进服务端日志）
 */
export async function callAndParseExtract(
  prompt: string,
  timeoutMs: number,
  deps: ExtractCallDeps = DEFAULT_EXTRACT_CALL_DEPS,
): Promise<ParsedEntry[] | null> {
  const startMs = deps.now();
  const deadlineMs = startMs + timeoutMs;
  let attempts = 0;
  try {
    for (let attempt = 1; attempt <= MAX_BAILIAN_ATTEMPTS; attempt++) {
      const remainingMs = deadlineMs - deps.now();
      if (remainingMs <= 0) {
        // 剩余预算已耗尽：不发起注定超时的调用，统一走下方超时报错
        throw new BailianTimeoutError(timeoutMs);
      }
      attempts = attempt;
      const result = await deps.callAgent(prompt, { timeoutMs: remainingMs });
      const remainingAfterMs = deadlineMs - deps.now();
      console.log(
        `[AI] 百炼抽取返回 ${result.finalText.length} 字符（第 ${attempt}/${MAX_BAILIAN_ATTEMPTS} 次），` +
          `耗时 ${result.latencyMs}ms，本轮剩余预算 ${Math.max(0, remainingAfterMs)}ms`,
      );
      const parsed = parseExtractedArray(result.finalText, prompt);
      if (parsed !== null) return parsed;
      console.error(
        `[AI] 第 ${attempt} 次抽取响应无法解析为条目数组，前 200 字符：${result.finalText.slice(0, 200)}`,
      );
      if (attempt < MAX_BAILIAN_ATTEMPTS && remainingAfterMs < MIN_RETRY_BUDGET_MS) {
        // 剩余预算不足以完成一次典型调用（实测单轮 27~41s）：不再发起无意义重试
        throw new BailianTimeoutError(timeoutMs);
      }
    }
    return null;
  } catch (error) {
    if (isBailianConfigError(error)) {
      const detail = error instanceof Error ? error.message : "环境变量未配置";
      throw new AiError("ENV_NOT_CONFIGURED", `服务端百炼配置不可用：${detail}`, { cause: error });
    }
    // Task #90/#170：超时消息报告本轮总耗时与总预算（不暗示单次尝试的预算）
    if (error instanceof BailianTimeoutError) {
      const elapsedMs = deps.now() - startMs;
      throw new AiError(
        "BAILIAN_REQUEST_FAILED",
        `AI 抽取超时（本轮已等待 ${Math.round(elapsedMs / 1000)} 秒、总预算 ${Math.round(timeoutMs / 1000)} 秒，共尝试 ${attempts} 次），请重试；正文较长时可分段粘贴`,
        { cause: error },
      );
    }
    throw new AiError(
      "BAILIAN_REQUEST_FAILED",
      `百炼请求失败，请稍后重试（${condenseErrorDetail(error)}）`,
      { cause: error },
    );
  }
}

// ===== 可复用的纯百炼抽取（Task #96） =====

/**
 * 纯百炼抽取（不落盘）：正文 → 条目数组。供 /api/ai/extract 与 Task #96 攻略来源
 * 服务层共用；环境预检 / 短文本预算策略 / 解析失败重试与 F5 完全一致。
 * 失败按分类抛出 AiError：ENV_NOT_CONFIGURED / BAILIAN_REQUEST_FAILED /
 * AI_PARSE_FAILED（重试一次后仍无法解析）。调用方自行决定装配与持久化。
 *
 * Task #181 本地快速路径：正文先经 assessLocalExtract 确定性评估——质量达到 high
 * 时直接返回本地抽取结果，不调用百炼（环境变量缺失也不影响，耗时毫秒级）；
 * 自由文本 / 低置信文本不受影响继续走百炼。Task #187 在此基础上补齐「主题标题 +
 * 项目符号 + 表情」型长攻略（主题标题不计惩罚、强锚点项目符号与正文地点句可
 * 产出条目，且快速路径要求至少 1 条强锚点条目），门槛与降级语义不变。
 * 百炼解析失败（含一次重试）后，仅当本地候选达到 fallback 最低可信标准时标记
 * local_fallback 安全降级返回（上层据此落 partial 并提示重试）；否则维持既有
 * AI_PARSE_FAILED 整篇失败，避免把不可靠解析误提交进行程。
 *
 * deps 参数（Task #170 既有模式）：供确定性测试注入 agent 桩与虚拟时钟；
 * 业务路径用默认实现（真实百炼 + Date.now），历史调用不传该参数行为不变。
 */
export async function extractNoteEntries(
  text: string,
  deps: ExtractCallDeps = DEFAULT_EXTRACT_CALL_DEPS,
): Promise<ParsedEntry[]> {
  // 0. 本地结构化快速路径（Task #181）：高置信结构化文本（「地点名：描述」条目 +
  //    明确 Day 标题）直接本地抽取，不调用百炼——确定性解析无网络依赖，
  //    解决此类文本反复耗尽百炼预算（首轮长耗时 + 不可解析输出）的问题
  const local = assessLocalExtract(text);
  if (local.quality === "high") {
    console.log(
      `[AI] 本地快速抽取命中（Task #181/#187）：结构化条目 ${local.entries.length} 条` +
        `（冒号 ${local.colonEntryCount} / 项目符号 ${local.bulletEntryCount} / 正文句 ${local.proseEntryCount}，` +
        `主题标题 ${local.sectionHeadingCount} 个，强锚点 ${local.anchoredEntryCount} 条，` +
        `Day 归属 ${local.dayMappedEntryCount} 条，结构化占比 ${(local.structuredRatio * 100).toFixed(0)}%），跳过百炼`,
    );
    return local.entries;
  }

  // 1. 环境预检：变量名报告缺失项，不触碰密钥值（本地快速路径无需百炼配置）
  const missingVars = getMissingBailianVars();
  if (missingVars.length > 0) {
    throw new AiError(
      "ENV_NOT_CONFIGURED",
      `服务端百炼环境变量未配置：${missingVars.join("、")}（请检查仓库根目录 .env 后重启服务）`,
    );
  }

  // 2. 组装 prompt 并调百炼（Task #170：全部尝试共享一个总预算——短文本 60s /
  //    常规 120s；解析失败自动重试一次且只使用剩余预算；请求异常分类抛出）
  const prompt = buildExtractPrompt(text);
  const timeoutMs = text.length < SHORT_TEXT_CHARS ? SHORT_TEXT_TIMEOUT_MS : DEFAULT_EXTRACT_TIMEOUT_MS;
  const entries = await callAndParseExtract(prompt, timeoutMs, deps);
  if (entries === null) {
    // Task #181：百炼解析失败（重试一次后仍无法解析）——仅当本地候选达到
    // fallback 最低可信标准才安全降级为 partial；低置信文本维持整篇失败
    if (local.quality === "fallback") {
      console.warn(
        `[AI] 百炼解析失败，本地结构化候选 ${local.entries.length} 条达到降级标准` +
          `（结构化占比 ${(local.structuredRatio * 100).toFixed(0)}%，Task #181），按 partial 降级返回`,
      );
      return markLocalFallbackEntries(local.entries);
    }
    throw new AiError("AI_PARSE_FAILED", "AI 响应解析失败（已自动重试一次），请重试或换一段攻略文字");
  }
  // Task #287：note_tip 归属后处理（单景点笔记确定性归属 + 与 POI 条目去重）
  return attributeNoteTips(entries);
}

// ===== 流水线入口 =====

/**
 * F5 攻略抽取：笔记正文 → 百炼抽取条目 → FlyAI 真实搜索对齐 → 三级归属写入
 * SourceEvidence / itemRegistry / visits / stops / pendingStopRefs / relationshipSuggestions。
 * 失败按分类抛出 AiError（稳定错误码 + 用户可读 message）：
 * 行程不存在 / 环境变量未配置 / 百炼请求失败 / AI 响应解析失败 / 持久化失败。
 * 解析失败（重试一次后）不落库任何变更；搜索未命中降级 custom 保留。
 */
export async function extractFromNote(
  tripId: string,
  text: string,
  sourceUrl?: string,
): Promise<ExtractResult> {
  let trip: Trip | null;
  try {
    trip = await tripStore.load(tripId);
  } catch {
    // 含 tripId 非法 UUID 等加载异常，对外统一按行程不存在提示
    throw new AiError("TRIP_NOT_FOUND", "行程不存在或已被删除，请刷新页面后重试");
  }
  if (trip === null) {
    throw new AiError("TRIP_NOT_FOUND", "行程不存在或已被删除，请刷新页面后重试");
  }

  // 1. 抽取（Task #181：本地快速路径 / 百炼 / 百炼解析失败后的本地降级，
  //    见 extractNoteEntries）
  const entries = await extractNoteEntries(text);
  const degradedLocally = hasLocalFallbackEntries(entries);

  // 2. 新建 note_text 证据（图片类 evidence 走 Task #51，此处结构已兼容）
  const noteIndex = nextNoteIndex(trip);
  let evidenceId = `ev_note_${noteIndex}`;
  if (trip.evidences[evidenceId] !== undefined) {
    evidenceId = `ev_note_${noteIndex}_${randomUUID().slice(0, 8)}`;
  }
  const evidence: SourceEvidence = {
    evidenceId,
    kind: "note_text",
    noteIndex,
    assetRef: null,
    sourceUrl: typeof sourceUrl === "string" && sourceUrl.trim() !== "" ? sourceUrl.trim() : null,
    ocrText: null,
    mentions: [],
  };

  const errors: string[] = [];
  // Task #181：百炼解析失败后的本地降级结果照常装配落库（保守条目 + 原文证据），
  // 但在 errors 中显式告知降级，前端可据此提示「结果为本地降级解析，可重试」
  if (degradedLocally) {
    errors.push("AI 响应解析失败，已按本地结构化解析降级（保留原文证据），建议稍后重试以获得更完整结果");
  }
  const searchCache = new Map<string, FlyAIPoi[]>();

  // 3+4. 逐条目装配（Pass 1 attraction → Visit 壳；Pass 2 in_attraction → Stop
  // 三级归属；共用 assemble.ts，与 OCR 流水线同源）
  let assembled;
  try {
    assembled = await assembleEntries(trip, entries, evidence, evidenceId, errors, searchCache);
  } catch (error) {
    // assembleEntries 内部已对单条搜索 / 装配做了降级（Task #90），到这里意味着
    // 装配逻辑出现了未预期的运行时异常——包装为 AiError 保留真实原因，
    // 避免裸 Error 泄漏到 routes 层导致不明确的 INTERNAL 兜底
    throw new AiError("PERSIST_FAILED", `点位装配异常：${condenseErrorDetail(error)}，请重试`, {
      cause: error,
    });
  }

  // 5. 证据入注册表 + 持久化（一致性校验失败会在 save 内整次拒绝并抛错）
  trip.evidences[evidenceId] = evidence;
  console.log(
    `[AI] F5 抽取落盘：note#${noteIndex}，items=${assembled.items.length}，`
      + `visit 新增=${assembled.newVisitCount}/复用=${assembled.reusedVisitCount}，`
      + `stop attached=${assembled.attachedStopCount}/pending=${assembled.pendingStopCount}/复用=${assembled.reusedStopCount}`,
  );
  try {
    await tripStore.save(trip);
  } catch (error) {
    // 一致性校验失败的具体条目由服务端抛出，附给用户便于定位（如旧数据缺数组字段）
    throw new AiError("PERSIST_FAILED", `点位已抽取但保存失败：${condenseErrorDetail(error)}`, {
      cause: error,
    });
  }

  return { evidenceId, noteIndex, ...assembled, errors };
}
