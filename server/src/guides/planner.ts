/**
 * B3 攻略草案 planner（Task #97，修订附录 B §2.3「合并排版」执行侧）。
 *
 * 职责：
 * - buildGuidePlannerPrompt：把 merge.ts 的合并素材 + buildTripFacts 的行程现状 +
 *   DraftScope 指令 + 用户补充句压成单条百炼输入（复用 buildTripFacts，避免双份漂移）；
 * - generateGuideDraft：锁内准备素材（含重启恢复扫描 / 补充句顺手保存 / scope 校验）→
 *   锁外调 AI（长网络调用不占 per-trip 锁，与 B2 装配同模式）→ 锁内乐观保存草案；
 * - applyGuideDraft：版本保护（checkPendingGuideDraftFreshness）→ 四条护栏（两阶段：
 *   结构操作先应用、属性操作基于中间行程校验，Task #228）→ applyOps 确认分流
 *   （敏感操作转 ProposalCard，非敏感直接应用）→ 挂载 snippets → 一次性消费草案。
 *
 * 复用边界（不建第二套执行器）：
 * - 操作归一化复用 pipeline.normalizeOperationSet；JSON 候选链与 parseOperationSet
 *   同构（fence → 全文 → 大括号 → 平衡 JSON → 保守修复）；
 * - 护栏 / 执行器复用 shared 的 validateOperation / applyOps（checkGuards 的逐条校验
 *   语义；30% 阈值与两阶段编排收敛在 applyGuideDraft，Task #228）；敏感操作确认通道
 *   复用 /api/ai/intent/confirm（前端 ProposalCard 持有 proposalOps 二次下发）。
 *
 * 版本保护语义（附录 B §2.4 + Task #105）:
 * - 草案必须保存「实际生成输入时」的 Trip.version 快照（inputTripVersion）与补充句快照；
 * - 百炼返回后加锁保存时再核一次版本：输入版本与最新版本不一致（生成期间行程被
 *   并发修改）→ 不保存草案，直接返回 DRAFT_STALE 要求重新生成——旧输出不得绑定
 *   最新版本，否则素材陈旧却被当作 fresh；
 * - 落盘成功后 baseTripVersion = 保存后的 Trip.version（tripStore.save 恰自增 1），
 *   使「无后续变化时 fresh、任何变化即过期」的应用侧判定成立（乐观锁保持不变）。
 *
 * Task #161 来源隔离（增量攻略默认暂存 / 局部草案契约）：
 * - 请求显式携带 sourceMode（"all" | "selected"）与 selectedSourceIds；缺省归一为
 *   "all"，保持「全部可用攻略整体重排」既有语义与二次确认链路，不退化旧调用方；
 * - "all"：可用且非暂存（staged）来源全集参与合并与候选支撑；历史来源无 staged
 *   字段（缺省非暂存），行为与旧版逐字节一致；
 * - "selected"：只使用所选来源的 evidence / mentions / 候选支撑（允许暂存来源）；
 *   未选历史来源不进入 prompt、关系匹配或草案证据；候选过滤只收窄不放宽
 *   （资格集合恒为 active 来源子集，不因来源过滤把旧候选补回）；
 * - 自动 scope 沿用既有规则（Day 指令优先 → 景点或父子关系 → 必要降级），
 *   来源过滤不改变 scope 决策链；草案持久化 sourceMode / sourceIds 供结果召回
 *   与重复提交核对；失败不落盘、重复生成覆盖同一 pendingGuideDraft 不叠加。
 *
 * Task #176（合并 143/145，落实 144 设计）自动 scope：
 * - 请求可缺省 scope：服务端按确定性规则自动判定（resolveDraftScope 纯函数，
 *   离线可测）：① 补充句日期指令（单天锁定该天 / 跨天降整程）→ ② 面板入口
 *   上下文（day / attraction 有效时取局部）→ ③ 所选攻略证据可靠归属同一大景区
 *   或同一天 → ④ 整程回退；不凭短词模糊扩大，任何发散迹象都退整程；
 * - 显式携带 scope 的旧调用方行为不变（显式优先，entryContext 被忽略）；
 * - 日期硬约束 / 父子关系 / 用户锁定 / 冲突确认机制不受影响：scope 只改变
 *   formatScopeDirective 的输出指令块，不改素材合并与后校验链路。
 *
 * Task #193 snippet-only 本地快速路径：
 * - 局部优化（sourceMode="selected"）+ 补充句明确只补推荐理由 / 亮点 / 介绍 /
 *   细节 + 无日期指令 / 无结构意图 + 所选来源全部提及唯一对齐现有 Visit / Stop 时，
 *   不再调用百炼：确定性产出 0 operations + 从 quoteText 提炼的 snippets，
 *   避免本可毫秒级完成的请求等待 2~5 分钟；
 * - 任一条件不确定（来源模式 / note 意图 / 实体对齐 / 强证据）立即回落既有 AI
 *   链路，绝不把普通「优化行程」误判成 snippet-only；
 * - 快速路径复用同一锁内素材快照、同一版本保护、同一 pendingGuideDraft 落盘与
 *   草案应用链路，optionGroups 契约保持不变（快速路径输出空数组）。
 *
 * Task #209 optionGroups 提取完整度与分类粒度：
 * - 规则第七节由泛化一句改为七类典型主题对号清单（环岛代步工具 / 缆车索道归
 *   transport，不因「租」字误归 rental），并明确「原文有提及时必须输出对应组」；
 * - 组数上限从 3 放宽到 6（每景点 ≤4 与应用侧 GUIDE_OPTION_GROUP_MAX_PER_ENTITY
 *   对齐），多篇攻略合并时不再因顶层上限硬丢组；
 * - 开放时间 / 注意事项等单点信息仍不成组，明确回落 snippets（第五节 text 描述
 *   同步纳入门票价格 / 开放时间 / 注意事项）；类型与解析 / 应用链路零改动。
 *
 * Task #270 optionGroups 内容感知解锁（替代 Task #216 P1-C 的一刀切降级）：
 * - 降级条件（提及 < 5 / attraction scope）仍保留，但素材命中「同一主题 ≥2 个可比较
 *   选项」信号时注入完整第七节（optionSignals.detectOptionGroupSignals）；
 * - 信号判定按地点聚合、同语义族计数，普通单条亮点（「日落很美」「建议早上去」）不命中；
 * - snippet-only 快速路径命中信号时主动回落完整 planner（否则可成组的对比被丢弃，
 *   快速路径 optionGroups 恒为空数组）；
 * - 解析后用确定性规则删除与选项组重复的 snippet（只保留 optionGroup 一处展示）。
 *
 * Task #273 真实生产路径修复：
 * - 真实 NER 会把一篇交通攻略切成多个地点提及（西岛 → 西岛 / 渔村 / 牛王岭 / 乌龟滩），
 *   且 quoteText 只留半句，per-place 判据因此漏判；现增加「按 sourceId 聚合」层，
 *   并优先用 GuideSource.sourceText 原文（不同来源之间不合并）；
 * - 命中信号的来源会把完整原文（截断到 1200 字符）补进【攻略素材】，否则模型拿不到被
 *   NER 丢掉的电动车 / 电动三轮车与价格，即使第七节已解锁也只能产出残缺组。
 */

import { createHash, randomUUID } from "node:crypto";
import type {
  ApplyResult,
  ClarificationAnswer,
  DraftScope,
  EntityRef,
  GuideClaimKind,
  GuideDraftAutoClassification,
  GuideDraftClarification,
  GuideDraftConflict,
  GuideDraftDayDirective,
  GuideDraftExplanation,
  GuideDraftRequirementCheck,
  GuideDraftSourceMode,
  GuideOptionCategory,
  GuideSnippet,
  GuideSourceVersionSnapshot,
  Item,
  Operation,
  PendingGuideDraft,
  PendingGuideDraftOptionGroup,
  PendingGuideDraftSnippet,
  Stop,
  Trip,
  Visit,
} from "@goplay/shared";
import {
  applyOps,
  areSameSourceSnippetsSimilar,
  areSnippetEntriesSimilar,
  checkPendingGuideDraftFreshness,
  collectAreaPlaceholderVisitIds,
  deduplicateSnippets,
  deduplicateStopSnippets,
  estimateGuideCoverage,
  GUIDE_OPTION_GROUP_MAX_OPTIONS,
  GUIDE_OPTION_GROUP_MAX_PER_ENTITY,
  GUIDE_OPTION_MAX_MENTION_REFS,
  GUIDE_OPTION_TEXT_MAX_CHARS,
  GUIDE_OPTION_TOPIC_MAX_CHARS,
  GUIDE_SNIPPET_DISPLAY_LIMIT,
  GUIDE_SNIPPET_MAX_CHARS,
  GUIDE_SNIPPET_MAX_MENTION_REFS,
  GUIDE_SNIPPET_RECOMMENDED_MAX_CHARS,
  hasUsableGuideEvidence,
  isGuideSourceStaged,
  isRealFliggyPoi,
  mergeOptionGroupsIntoList,
  normalizeGuideOptionItem,
  normalizeOptionCategory,
  normalizeOptionalText,
  parseMentionRef,
  recomputeDayTimeline,
  resolveMentionRef,
  validateAiSupplementProvenance,
  validateOperation,
  visitDayIndex,
} from "@goplay/shared";
import { normalizePoiName } from "../ai/assemble.js";
import { BailianTimeoutError, createBailianSession } from "../bailian/client.js";
import { AiError } from "../ai/errors.js";
import { repairJsonCandidates } from "../ai/jsonRepair.js";
import { lastBalancedJsonValue } from "../ai/lastJson.js";
import { normalizeOperationSet, stripOverloadedDayOps } from "../ai/pipeline.js";
import { buildTripFacts } from "../ai/prompt.js";
import {
  collectConsumedEvidenceRefs,
  collectSelectedSourceIds,
  computeScheduleFingerprint,
  evaluateDraftRebase,
} from "../ai/draftConflict.js";
import { tripStore } from "../persistence/store.js";
// Task #312：高置信度子玩法自动采纳纯函数（从 fix-task225.ts 抽到正式模块，运行时复用）
import { adoptHighConfidenceChildStops } from "./adoptStops.js";
import {
  buildAutoClassifications,
  computeRequirementChecksFromTrip,
  enforceDraftDirectives,
  formatDirectivesPrompt,
  parseDraftDirectives,
  selectConflictResolutions,
  stripOpsReferencingVisits,
  summarizeRequirementChecks,
  type UnselectedConflictSummary,
} from "./directives.js";
import { buildDraftExplanation, summarizeAppliedExplanation } from "./explain.js";
import { withTripLock } from "./jobs.js";
import { mergeGuideMentions, type GuideMergeResult, type MergedPlace } from "./merge.js";
import {
  collectMergeSourceTexts,
  detectMergeOptionGroupSignals,
  dropSnippetsDuplicatedByOptionGroups,
} from "./optionSignals.js";
import { DRAFT_NOTE_MAX_CHARS, recoverStaleProcessingLocked } from "./service.js";

// ===== 参数 =====

/** planner 单轮超时：多篇攻略合并 + 全行程上下文 prompt 很大，实测 180s 仍会精确超时
 *  （Task #110：4 篇攻略全程 scope 实测 180,024ms 超时），放宽到 300s（5 分钟）；仍比 F11 的 60s 预算宽。
 *  Task #227：该值语义从「每次尝试各持独立预算」改为「callAndParsePlanner 全部尝试共享的
 *  总预算」——此前首次调用 75s 返回但解析失败触发重试时，第二次仍拿完整 300s，总耗时可达
 *  375s 而超过前端 315s 兜底超时；现在每次尝试只分到剩余预算，本轮总等待被硬性封顶在本值。 */
const GUIDE_DRAFT_TIMEOUT_MS = 300_000;

/** 生成尝试上限：首败（解析失败 / 空响应 / 网络抖动）后重试一次；超时一次即抛出 */
const GUIDE_DRAFT_MAX_ATTEMPTS = 2;

/**
 * Task #227：发起解析失败重试的最小剩余预算。planner 单轮实测常在 100s 以上
 * （Task #110 记录过 180s 精确超时），剩余不足本值的重试几乎必然撞上 deadline——
 * 与其白等到预算耗尽，不如立即按超时报错，把确定的结果早点交给前端。
 */
const GUIDE_DRAFT_MIN_RETRY_BUDGET_MS = 30_000;

// ===== 依赖注入（验证脚本桩注入 callPlanner，不触网驱动全链路） =====

export interface GuidePlannerDeps {
  /** 单轮 planner 调用：prompt 进、finalText 出；超时与其他网络错误由实现抛出 */
  callPlanner: (prompt: string, timeoutMs: number) => Promise<string>;
  /**
   * Task #193：草案输出已确定（快速路径或 AI 解析完成）、保存草案之前的钩子。
   * 仅验证脚本注入，用于模拟「生成期间行程被并发修改」；生产不配置。
   */
  beforeDraftSave?: (tripId: string) => Promise<void>;
}

async function defaultCallPlanner(prompt: string, timeoutMs: number): Promise<string> {
  const result = await createBailianSession(prompt, { timeoutMs });
  return result.finalText;
}

let plannerDeps: GuidePlannerDeps = { callPlanner: defaultCallPlanner };

/** 替换部分依赖（桩注入）；传空对象无操作 */
export function setGuidePlannerDeps(overrides: Partial<GuidePlannerDeps>): void {
  plannerDeps = { ...plannerDeps, ...overrides };
}

/** 恢复默认依赖 */
export function resetGuidePlannerDeps(): void {
  plannerDeps = { callPlanner: defaultCallPlanner };
}

// ===== 输出解析 =====

export interface ParsedPlannerOutput {
  operations: Operation[];
  snippets: PendingGuideDraftSnippet[];
  /** Task #190：实用参考选项组（无符合定义的内容为空数组） */
  optionGroups: PendingGuideDraftOptionGroup[];
  unplaced: { subjectRef: EntityRef; reason: string }[];
  proposedNew: { name: string; reason: string | null }[];
  clarify: string | null;
}

/** 解析失败的用户可读文案：与 pipeline 的 PARSE_FAILED_MESSAGE 同语义 */
const PLANNER_PARSE_FAILED_MESSAGE = "响应格式异常：AI 返回内容无法解析为有效草案，请重试";

/** snippet 的 targetRef 只允许这三种 kind（day / lodging / hotel 不承载提示） */
const SNIPPET_TARGET_KINDS: ReadonlySet<string> = new Set(["point", "visit", "stop"]);

/** optionGroup 的 targetRef 同 snippet：只允许 visit / stop / point（应用时归一到 Visit） */
const OPTION_GROUP_TARGET_KINDS: ReadonlySet<string> = SNIPPET_TARGET_KINDS;

/** claimKind 白名单（附录 B §3.2）；白名单外兜底为 reported_opinion（最保守的事实类型） */
const CLAIM_KIND_SET: ReadonlySet<string> = new Set([
  "experience",
  "route_listing",
  "tip",
  "risk",
  "comparison",
  "reported_opinion",
]);

function isValidSnippetTargetRef(value: unknown): value is EntityRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.kind !== "string" || !SNIPPET_TARGET_KINDS.has(record.kind)) return false;
  return typeof record.id === "string" && record.id !== "";
}

/**
 * Task #190：解析并清洗 optionGroups（实用参考主题组）。
 * 逐组清洗——topic 非空截断；category 白名单外兜底 other；选项逐条
 * normalizeGuideOptionItem（label 必填 / 可空字段 null / 引用过滤去重截断）；
 * 选项引用为空时用组级有效引用兜底（保证每条选项可溯源）；
 * 成组硬条件：清洗后 ≥2 个选项（单选不成组），超上限截断；
 * targetRef 形状非法整组丢弃（无处挂载）；组级引用过滤到草案消费集合；
 * 同主题（归一化）同分类重复组保留首个，后续跳过并记日志（确定性不叠加）。
 */
function parseDraftOptionGroups(
  value: unknown,
  validMentionRefs: ReadonlySet<string>,
): PendingGuideDraftOptionGroup[] {
  if (!Array.isArray(value)) return [];
  const groups: PendingGuideDraftOptionGroup[] = [];
  const seenKeys = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const topic = normalizeOptionalText(record.topic, GUIDE_OPTION_TOPIC_MAX_CHARS);
    if (topic === null) continue;
    if (!isValidSnippetTargetRef(record.targetRef) || !OPTION_GROUP_TARGET_KINDS.has(record.targetRef.kind)) {
      continue;
    }
    const category: GuideOptionCategory = normalizeOptionCategory(record.category);
    const groupRefs = Array.isArray(record.sourceMentionRefs)
      ? [
          ...new Set(
            record.sourceMentionRefs.filter(
              (item): item is string =>
                typeof item === "string" && parseMentionRef(item) !== null && validMentionRefs.has(item),
            ),
          ),
        ].slice(0, GUIDE_OPTION_MAX_MENTION_REFS)
      : [];
    const options: PendingGuideDraftOptionGroup["options"] = [];
    if (Array.isArray(record.options)) {
      for (const rawOption of record.options) {
        if (typeof rawOption !== "object" || rawOption === null || Array.isArray(rawOption)) continue;
        const optionRecord = rawOption as Record<string, unknown>;
        const cleaned = normalizeGuideOptionItem({
          label: optionRecord.label,
          priceText: optionRecord.priceText,
          routeText: optionRecord.routeText,
          sceneText: optionRecord.sceneText,
          bargain: optionRecord.bargain,
          noteText: optionRecord.noteText,
          sourceMentionRefs: optionRecord.sourceMentionRefs,
        });
        if (cleaned === null) continue;
        // 选项级引用过滤到草案消费集合；空则用组级有效引用兜底，仍空则丢弃（必须可溯源）
        const refs = cleaned.sourceMentionRefs.filter((ref) => validMentionRefs.has(ref));
        if (refs.length === 0) {
          if (groupRefs.length === 0) continue;
          refs.push(...groupRefs);
        }
        options.push({ ...cleaned, sourceMentionRefs: refs });
        if (options.length >= GUIDE_OPTION_GROUP_MAX_OPTIONS) break;
      }
    }
    if (options.length < 2) continue; // 单选不成组（普通单点推荐 / 装备清单 / 泛泛 TIPS 拒绝）
    const key = `${optionGroupTopicKey(topic)}::${category}`;
    if (seenKeys.has(key)) {
      console.warn(`[GUIDES] optionGroup 去重：同主题同分类重复组已跳过「${topic}」（${category}）`);
      continue;
    }
    seenKeys.add(key);
    groups.push({ topic, category, options, targetRef: record.targetRef, sourceMentionRefs: groupRefs });
  }
  return groups;
}

/** 主题归一化 key（与 shared normalizeOptionLabelKey 同口径，直接内联避免多余导出） */
function optionGroupTopicKey(topic: string): string {
  return topic
    .replace(/[（(【\[{][^）)】\]}]*[）)】\]}]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/**
 * 解析 snippets 数组：逐条清洗——
 * - text 非空且硬截断到 40 字（附录 B §3.3：生成侧直接保证，展示层不回写）；
 * - targetRef 必须是 point / visit / stop 合法形状，非法整条丢弃（无处挂载）；
 * - sourceMentionRefs 过滤到「格式合法 + 在草案消费集合内」1..3 条，
 *   编造 / 改写的引用一律剔除，过滤后为空整条丢弃（提示必须可溯源）。
 */
function parseDraftSnippets(value: unknown, validMentionRefs: ReadonlySet<string>): PendingGuideDraftSnippet[] {
  if (!Array.isArray(value)) return [];
  const snippets: PendingGuideDraftSnippet[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const rawText = typeof record.text === "string" ? record.text.trim() : "";
    if (rawText === "") continue;
    const refs = Array.isArray(record.sourceMentionRefs)
      ? [
          ...new Set(
            record.sourceMentionRefs.filter(
              (item): item is string =>
                typeof item === "string" && parseMentionRef(item) !== null && validMentionRefs.has(item),
            ),
          ),
        ]
      : [];
    if (refs.length === 0 || refs.length > GUIDE_SNIPPET_MAX_MENTION_REFS) continue;
    if (!isValidSnippetTargetRef(record.targetRef)) continue;
    snippets.push({
      text: [...rawText].slice(0, GUIDE_SNIPPET_MAX_CHARS).join(""),
      claimKind:
        typeof record.claimKind === "string" && CLAIM_KIND_SET.has(record.claimKind)
          ? (record.claimKind as GuideClaimKind)
          : "reported_opinion",
      targetRef: record.targetRef,
      sourceMentionRefs: refs,
    });
  }
  return snippets;
}

/**
 * 从 planner finalText 解析草案输出：候选链与 pipeline.parseOperationSet 同构
 * （markdown fence → 全文 → 首尾大括号 → 最后一个平衡 JSON 块 → 保守修复候选），
 * 全部候选过同一 normalizeOperationSet 校验（operations 结构与 F11 完全同契约）；
 * snippets 单独清洗（见 parseDraftSnippets）。全部失败返回 null（调用方重试一次）。
 */
export function parsePlannerOutput(finalText: string, validMentionRefs: ReadonlySet<string>): ParsedPlannerOutput | null {
  const trimmed = finalText.trim();
  if (trimmed === "") return null;

  const candidates: string[] = [];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced !== undefined) candidates.push(fenced.trim());
  candidates.push(trimmed);
  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) candidates.push(trimmed.slice(objectStart, objectEnd + 1));
  const lastBalanced = lastBalancedJsonValue(trimmed);
  if (lastBalanced !== null) candidates.push(lastBalanced);

  const tryParse = (candidate: string): ParsedPlannerOutput | null => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    // operations 结构与 F11 同契约归一化（baseVersion 字段草案不用，忽略其归一结果）
    const operationSet = normalizeOperationSet(parsed);
    if (operationSet === null) return null;
    return {
      operations: operationSet.operations,
      snippets: parseDraftSnippets(record.snippets, validMentionRefs),
      optionGroups: parseDraftOptionGroups(record.optionGroups, validMentionRefs),
      unplaced: operationSet.unplaced,
      proposedNew: operationSet.proposedNew,
      clarify: operationSet.clarify,
    };
  };

  for (const candidate of candidates) {
    const parsed = tryParse(candidate);
    if (parsed !== null) return parsed;
  }
  // 保守修复兜底（悬空逗号 / EOF 补闭合），与 parseOperationSet 同策略
  for (const candidate of repairJsonCandidates(finalText)) {
    const parsed = tryParse(candidate);
    if (parsed !== null) {
      console.log("[GUIDES] 草案响应经保守 JSON 修复后解析成功（仅悬空逗号/EOF 补闭合类修复）");
      return parsed;
    }
  }
  return null;
}

// ===== Prompt 构建 =====

/**
 * planner 规则文本（Task #216 P1-C 起按需拼装，见 buildGuidePlannerRulesText）：
 * 操作契约（八种操作 / EntityRef 写法 / 索引限制 / 保护规则）与 F11
 * FIXED_RULES_TEXT 同语义，差异点：
 * - 顶层输出 {"operations", "snippets"}（无 baseVersion / unplaced / proposedNew / clarify）；
 * - 禁止 scopeRef=allDays 与 proposedNew（草案应用走 applyOps 直连，不做全量重排
 *   挂起与 G2 搜索入池，规则前置规避）；
 * - 新增 snippets 契约（附录 B §3.3：短提示 + claimKind + 可溯源 mentionRefs）。
 *
 * Task #291 方差稳定化（PD 拍板，两处软规则注入；不改任何解析 / 校验 / 应用逻辑）：
 * - 第五节 claimKind 行后补「risk / tip 边界从宽」说明：risk 留给重大安全 / 财务损失 /
 *   商家欺诈，警告性实用建议（如「不适合下海游泳」）归 tip 同样可接受——消除 A4
 *   risk↔tip 分类级摇摆（评测侧 runA4 同步放宽为 risk 或 tip 任一即 pass）；
 * - 第六节「排版必须尊重【约束列表】」之后补三条排程硬规则：返程日走廊（flight_depart
 *   倒推最晚离开时间 + 禁排海岛/船班/远/付费水上等重项）、抵达日（flight_arrive 正推、
 *   只排住宿片区附近低承诺项）、方向综合评估（机场 / 酒店片区 / 素材方位判断顺路性，
 *   避免跨城区折返）——把 S1「后海村被排入返程日」从模型自行推断变为 prompt 显式规则
 *   （S1 断言保持严格不放宽）。
 *
 * Task #323 返程日行程截止时间（PD 口径，融入第六节返程日走廊规则，不另立新条目）：
 * - 最后一天有 flight_depart 约束 → 全部安排须在「起飞时间 − 3 小时」前结束
 *   （与 #291 既有「不少于 2 小时」buffer 的关系：3 小时截止已含值机安检 + 交通 buffer，
 *   倒推后放不下仍一律不排，两者不矛盾，取更严的 3 小时为硬参考）；
 * - 最后一天无 flight_depart 约束（用户未设定离开时间）→ 全部安排须在 15:00 前结束；
 * - 同源纯函数 shared deriveDepartureDayCutoff（验证脚本 verify-task323 双侧断言）；
 *   不改 timeline / 护栏 / 应用链路（时间轴保持「不做硬截断」既有语义）。
 */
const GUIDE_PLANNER_RULES_HEAD = `你是旅行攻略排版助手。输入是【行程现状】（当前行程）与【攻略素材】（多篇旅行攻略合并后的原文提及）。你的任务：把攻略中具体、可执行的玩法细节融入当前行程，输出一个 JSON 对象。以下契约必须严格遵守。

一、顶层结构（三个字段）：
{"operations": [...], "snippets": [...], "optionGroups": [...]}
- operations：行程结构变更（八种操作见下）；snippets：卡片攻略提示；optionGroups：实用参考选项组（见第七节）；前两者可为空数组，optionGroups 没有符合定义的内容时输出空数组。
- 不要输出 baseVersion / unplaced / proposedNew。
- 只能引用【行程现状】中已出现的 id（item_x / visit_x / stop_x），禁止编造；
  禁止提议行程与候选区都不存在的新点位（无 proposedNew 通道）；
  素材里有价值但行程没有的地点，写进 snippets 提示用户（targetRef 指向最相关的既有实体）。

二、operations 支持九种操作（每条必须携带 reason；最多 15 条，优先保留证据最具体、对行程影响最大的调整，其余宁可舍弃；未落进 operations 的素材细节仍应通过 snippets 覆盖相关点位）：
1. plan 整排：{"op":"plan","scopeRef":{"kind":"day","dayIndex":2},"assignments":[{"subjectRef":{"kind":"visit","id":"visit_x"},"containerRef":{"kind":"day","dayIndex":2},"order":0}],"reason":"..."}
   - scopeRef 一律用单天 {"kind":"day","dayIndex":N}；禁止输出 {"kind":"allDays"}
   - 安排大景区/普通景点：subjectRef={"kind":"visit","id":"..."} 或 {"kind":"point","id":"..."}（候选区点位进入 Day 时自动创建 Visit），containerRef={"kind":"day","dayIndex":N}；order 从 0 开始
   - 安排大景区内部玩法：subjectRef={"kind":"stop","id":"..."}，containerRef={"kind":"visit","id":"..."}
   - plan 未提及的既有项保持原相对顺序追加在尾部，不会丢失
2. move 同容器改序：{"op":"move","subjectRef":{"kind":"visit","id":"..."},"containerRef":{"kind":"day","dayIndex":1},"toOrder":0,"reason":"..."}（内部玩法 containerRef={"kind":"visit","id":"..."}）
3. transfer 转移 / 归类纠正：{"op":"transfer","subjectRef":{...},"fromContainerRef":{...},"toContainerRef":{...},"toOrder":null,"reason":"..."}
   - 候选区点位/大景区壳 → 某天：toContainerRef={"kind":"day","dayIndex":N}
   - 内部玩法 → 备选玩法：toContainerRef={"kind":"visitPool","visitId":"..."}；反向回主路线用 {"kind":"visit","id":"..."}
   - 内部玩法换景区（归类纠正）不能改变所在日期；内部玩法不支持跨天移动
4. remove 移除（敏感操作，照常输出，服务端自动转提案）：{"op":"remove","subjectRef":{...},"fromContainerRef":{...},"reason":"..."}
5. setTime 改时间：{"op":"setTime","subjectRef":{...},"value":"09:30","target":"start" 或 "end" 或 "dayDepart","reason":"..."}
   - target="dayDepart" 时 subjectRef={"kind":"day","dayIndex":N}；start/end 仅适用于 visit 与 lodging
6. setDuration 改时长：{"op":"setDuration","subjectRef":{...},"minutes":120,"reason":"..."}（对内部玩法即建议时长）
7. setPurchase 改购买状态（敏感操作）：{"op":"setPurchase","subjectRef":{...},"value":"bought" 或 "toBuy" 或 "unknown" 或 "noTicket","reason":"..."}
8. lock 锁定或解锁（敏感操作）：{"op":"lock","subjectRef":{...},"value":true,"reason":"..."}
9. classifyVisitAsStop 强证据归类（把独立排期的普通 Visit 转为父景区内部玩法 Stop）：{"op":"classifyVisitAsStop","visitId":"visit_x","parentVisitId":"visit_y","toOrder":null,"evidenceMentionRefs":["evidenceId:mentionId"],"reason":"..."}
   - 仅当【攻略素材】原文明确写出从属关系（「位于 / 内部 / 附近 / …景区内」等）时才输出；
     evidenceMentionRefs 从素材行 ref= 原样复制，且每条引用必须能同时追溯到该 Visit 与父景区双方；
   - 同日安排、同一篇攻略、名称相似都不构成从属证据，禁止据此归类；
   - visitId / parentVisitId 必须来自【行程现状】；toOrder 固定 null（追加到父景区内部玩法末尾）；
   - 服务端会先执行归类再处理排天操作（输出顺序无关，服务端自动排序）。

三、EntityRef 写法（subjectRef / targetRef 统一）：
- 天：{"kind":"day","dayIndex":N}；点位：{"kind":"point","id":"item_x"}；到访：{"kind":"visit","id":"visit_x"}；内部玩法：{"kind":"stop","id":"stop_x"}；住宿：{"kind":"lodging","dayIndex":N}

四、索引与适用限制：
- dayIndex 从 1 开始；order / toOrder 从 0 开始；越界索引会被服务端直接拒绝，不要猜测；
- 内部玩法（stop）不支持 setTime / setPurchase / lock，也不支持跨天移动；
- state=pending 的内部玩法（待用户确认归类，不在输入中出现）禁止输出任何操作：
  plan / move / remove / setDuration 会被服务端逐条 G1 拒绝；transfer 归类属于用户的决定，同样不得代替用户执行；
  素材涉及这些玩法时只写 snippet 提示用户先在前端确认归类；
- locked=true 的到访不可 move / transfer / remove / setTime / setDuration（setPurchase 允许）；
- purchaseState="bought" 的到访不可 remove / transfer；
- userAdjusted=true 的到访若未被本批 plan 显式安排，执行时保留原位置。

五、snippets（卡片攻略提示，必须来自攻略素材的具体细节）：
每条：{"text":"...","claimKind":"...","targetRef":{...},"sourceMentionRefs":["evidenceId:mentionId",...]}
- text：一句话可操作建议（玩法细节 / 时段 / 顺序 / 避雷 / 门票价格 / 开放时间 / 注意事项），建议 ≤${GUIDE_SNIPPET_RECOMMENDED_MAX_CHARS} 个中文字符，硬上限 ${GUIDE_SNIPPET_MAX_CHARS}；不要景点简介式空话；
- claimKind 六选一：experience 亲历玩法 / route_listing 路线列举 / tip 实用技巧 / risk 避雷风险 / comparison 对比结论 / reported_opinion 转述观点；
- claimKind 的 risk / tip 边界从宽（不苛求，两者取其一都算对）：risk 留给重大风险——人身安全威胁、重大财务损失、商家欺诈（如「无资质商家带出海」「漫天要价」「假票」「多看真实学员评价、不着急交费」）；警告性的实用建议（如「大多区域不适合下海游泳」「岛上消费偏高，建议自备饮水零食」「礁石锋利注意脚下」）归 tip 同样可接受——用户到现场还会看到说明，产品不是唯一权威来源。归类犹豫时不得因此丢掉这条信息：信息本身必须写进 snippets，claimKind 取 risk 或 tip 任一即可；
- targetRef：提示挂在哪个实体，只允许 {"kind":"visit","id":"..."} 或 {"kind":"stop","id":"..."} 或 {"kind":"point","id":"..."}，id 必须来自【行程现状】或素材行括号内的对齐标注；
- 层级选择（Task #266：先判断信息属于谁再选 targetRef）：
  适用于整个景区的信息（整体交通方式 / 上岛与入园须知 / 全景区通用建议 / 全天路线大方向）→ targetRef 指向父级大景区 visit；
  只有明确针对某个具体子景点的信息（提及名称就是该子景点或其内部点位）→ targetRef 指向该 stop；
  判不准时取父级 visit，不要把一个子景点的细节写成整个景区的结论（会让用户误以为全景区都适用）；
- sourceMentionRefs：1..3 条，从【攻略素材】的 ref= 原样复制，禁止编造或改写；
  每条引用的提及必须与 targetRef 实体直接相关（同一地点名称全等或整体包含，
  或该实体本身 / 其父景区 / 其内部玩法已归属的提及）；禁止把其他地点的提及
  挂到无关实体上——无关引用的提示会被服务端拒挂；
  risk 类提示的 sourceMentionRefs 必须确实支持该风险表述，不得从玩法提及借引，
  且不得把局部风险（某摊位 / 某时段 / 某供应商）扩大为整座景点的结论；
- 同一实体的提示不超过 2 条，优先保留最具体、最可操作的；
- 多来源建议冲突时不裁决：各写一条 snippet 并写明前提（如「来源A建议早去避晒」与「来源B推荐日落时段」）。

六、排版原则：
- 优先吸收素材中的时段与顺序建议（如「下午去人少」「日落前到」「先X后Y顺路」）落到 setTime / plan 顺序，依据写进 reason；
- 排版必须尊重【约束列表】（不可违背）与【行程现状】中的 locked / purchase / userAdjusted 标注；
- 返程日走廊规则（Task #291）：【约束列表】中带 flight_depart 的天是返程日，该天只排机场方向、低承诺、退出时间可控的项目（如市区 / 住宿片区附近散步、近机场商圈、已锁定项）；禁止排入：海岛 / 船班 / 需提前购票的景区 / 付费水上活动 / 单程 >40 分钟的远距离点 / 天气高度敏感 / 退出时间不可控的项目。返程日的核心约束是「最晚离开游玩点的时间」——从航班起飞时间倒推（含值机安检 + 到机场交通 buffer，不少于 2 小时），倒推后放不下的项目一律不排；不确定时宁可不排（该天 operations 留空），把建议写进 snippets；
- 返程日行程截止时间（Task #323，硬参考）：行程最后一天（【行程概况】共 N 天中的 Day N）的全部安排必须在该天行程截止时间之前结束——【约束列表】中 Day N 带 flight_depart 时，截止时间 = 起飞时间（anchor 的 HH:MM）− 3 小时（这 3 小时已含值机安检与到机场交通，比上一条的 2 小时 buffer 更严，以本条为准）；Day N 没有 flight_depart 约束（用户未设定离开时间）时，截止时间 = 15:00。安排放不进截止时间之前时一律不排（宁可不排，把建议写进 snippets）；也不得为此把项目挤到更早的天——其他天的既有安排不动；
- 抵达日规则（Task #291）：带 flight_arrive 的天是抵达日，从落地时间正推（含取行李 + 到住宿片区交通），只排住宿片区附近、低承诺、可随时退出的项目（如近酒店海滩 / 片区内村落商圈），不排需要早到、需要大半天、需要抢票或看天吃饭的重项；
- 方向综合评估（Task #291 + #325）：结合【约束列表】的机场航班、【住宿信息】的片区（areaName）与服务端实测地理数据（Day 头行「地理跨度=Xkm」「最远离机场=Xkm」，每 visit 行「片区=」），判断每个点位是否顺路——同一天的点位应落在同一动线方向上，避免跨城区来回折返；返程日的点位还须与机场同向（机场在城市西侧时，不要把东侧的海湾 / 村落排进返程日）。服务端已给出实测距离，不得自行臆测方位；素材额外提供的距离/耗时信息可作补充参考；
- 出现【日期硬性指令】块时，其中的排天要求优先于一切排版偏好：目标 Visit 必须最终位于指定 Day，不得自行改天；
- 攻略建议与现状冲突时：锁定项、已购项不改动，把攻略建议写成 snippet；
- 不确定时宁缺毋滥：operations 可为空数组，把建议放进 snippets。`;

/**
 * Task #216 P1-C：第七节 optionGroups 契约全文——只在素材充足（提及 ≥
 * OPTION_GROUPS_MIN_MENTIONS）且非 attraction scope 时注入（见 buildGuidePlannerRulesText）
 */
const GUIDE_PLANNER_OPTION_GROUPS_RULES = `七、optionGroups（实用参考选项组，Task #190）：把攻略中「同一主题下至少两个可比较选项」的实用信息提炼成组。应提取的典型主题与分类对号（原文有提及时必须输出对应组，不要遗漏）：
- transport 交通与代步工具：环岛交通（三轮车 / 电动车 / 观光车 / 双人自行车）、缆车索道、船班、景区公交方式对比等；「环岛工具 / 租车环岛」这类代步方式对比按主题归 transport，不因出现「租」字改归 rental；
- ticket 门票与船票：门票、联票 / 套票 / 一价全包、往返船票、快艇上岛等票种对比；
- rental 装备租赁：浮潜面镜、潜水服、储物柜、帐篷等按件租用的游玩装备；
- activity 玩法档位：同一玩法的不同档位或形式（如潜水不同深度档、快艇 vs 帆船出海、跟团 vs 自由行）；
- dining 餐饮与套餐：餐厅人均 / 双人套餐 / 单点对比、必吃榜价格档；
- shuttle 接驳与摆渡：码头接驳车、跨景点穿梭巴士、摆渡船班次；
- other 其他可比较实用参考：以上之外的同类选项对比（如储物柜尺寸档位、更衣 / 淋浴套餐）。
每条：
{"topic":"...","category":"...","options":[...],"targetRef":{...},"sourceMentionRefs":["evidenceId:mentionId",...]}
- 成组硬条件：同一主题下至少 2 个可比较的选项（如「环岛交通：三轮车 / 电动车 / 观光车」）。普通单点推荐、装备清单、泛泛 TIPS 不得成组输出；凑不够 2 个就完全不输出该组，其中的单点信息（如单一门票价、开放时间、注意事项）按第五节写进对应景点的 snippets；
- 每个选项：{"label":"选项名","priceText":"原文价格与单位","routeText":"路线或范围","sceneText":"适用场景","bargain":true|false|null,"noteText":"特点","sourceMentionRefs":[...]}
  - label 必填；其余字段只能从原文提取，原文未提一律 null，禁止臆测或补全；
  - priceText 原样保留原文措辞与单位（如「50元/圈」），不换算、不格式化；
  - bargain：原文明说可议价 true / 不可议 false / 未提 null；
- category 七选一：transport 交通 / ticket 门票 / rental 租赁 / activity 玩法 / dining 餐饮 / shuttle 接驳 / other 其他，按本节开头的典型主题对号入座；
- sourceMentionRefs（组级与每个选项）：从【攻略素材】的 ref= 原样复制 1..3 条，禁止编造；选项引用原文中支撑该选项价格与特点的句子，组级引用主题所在句子；
- targetRef：选项组归属的最相关景点，只允许 {"kind":"visit","id":"..."} 或 {"kind":"stop","id":"..."} 或 {"kind":"point","id":"..."}；归属不到具体景点的（跨景点通用 / 行程无关）不要强挂，宁可不输出；
  整个景区通用的交通方式 / 门票票种 / 装备租赁对比一律挂父级大景区 visit（不要挂到某个内部玩法 stop 上，否则用户会以为这套对比只适用于该玩法）；
- 与 snippets 的分工（Task #270）：已经写进 optionGroups 的方式名、价格、路线不得再写进 snippets——同一信息两处展示会让用户以为存在两套玩法；
  分组后仍值得单独提示的只有组里没有的注意事项（头盔 / 罚款 / 末班时间等），且不得复述选项价格；
- 不为选项创建任何 POI / 点位 / 内部行程：不得因此输出 plan / transfer 等操作，也不得把已提取为选项组的内容再写进 snippets 让用户误解为玩法；
- 全输出最多 6 组、每个景点最多 4 组，价格与差异最明确、对决策最有用的优先；每组最多 6 个选项。`;

/** Task #216 P1-C：optionGroups 降级声明——素材提及过少或 attraction scope 时第七节
 *  整体替换为本行（保留「七、optionGroups」前缀，既有断言兼容） */
const GUIDE_PLANNER_OPTION_GROUPS_SKIPPED_NOTE = `七、optionGroups：本轮不适用，输出空数组 []`;

const GUIDE_PLANNER_RULES_TAIL = `八、输出格式：
- 输出必须是合法 JSON，不要包裹在 markdown code block 中，不要输出任何解释性文字。
- 【重要】直接输出合法 JSON 文本即可，不要调用任何工具（bash、python、文件读写等），不要验证 JSON，不要输出任何解释性文字。`;

/** Task #216 P1-C：optionGroups 契约注入的素材量门槛——提及少于该值时成组原料不足，
 *  强行提取只会放大幻觉概率，第七节降级为短声明 */
const OPTION_GROUPS_MIN_MENTIONS = 5;

/**
 * Task #216 P1-C + Task #270：planner 规则文本按素材量与 scope 按需拼装：
 * - 降级条件（素材提及 < OPTION_GROUPS_MIN_MENTIONS，或 attraction scope 的「单景区
 *   横切面不足」判断）成立时，第七节替换为「本轮不适用」短声明（省约 900 字符）；
 * - Task #270 内容感知解锁：降级条件成立但素材本身命中了「同一主题 ≥2 个可比较选项」
 *   信号（见 optionSignals.detectOptionGroupSignals）时，仍然注入完整契约——西岛
 *   「步行 / 电动车 / 观光车 / 电动三轮车 + 多个价格」正是被旧门槛误杀的反例；
 *   无信号的请求继续降级，避免每次多约 920 token；
 * - 其余场景三段拼装结果与原 GUIDE_PLANNER_RULES_TEXT 逐字一致，既有行为不变。
 * Task #229：导出供 verify-task229 断言各种拼装形态均携带禁用工具指令。
 */
export function buildGuidePlannerRulesText(
  mentionCount: number,
  scope: DraftScope,
  optionGroupSignals = false,
): string {
  const degraded = mentionCount < OPTION_GROUPS_MIN_MENTIONS || scope.kind === "attraction";
  const optionGroupsSection =
    degraded && !optionGroupSignals ? GUIDE_PLANNER_OPTION_GROUPS_SKIPPED_NOTE : GUIDE_PLANNER_OPTION_GROUPS_RULES;
  return `${GUIDE_PLANNER_RULES_HEAD}\n\n${optionGroupsSection}\n\n${GUIDE_PLANNER_RULES_TAIL}`;
}

/** scope 指令块：只限制输出范围，不改变素材归属（素材始终全集给出） */
function formatScopeDirective(trip: Trip, scope: DraftScope): string[] {
  switch (scope.kind) {
    case "trip":
      return [
        "- 全程优化：所有 Day 都在允许范围内，但每条 plan 的 scopeRef 仍用单天 {\"kind\":\"day\",\"dayIndex\":N}，禁止 {\"kind\":\"allDays\"}。",
      ];
    case "day": {
      const day = trip.days[`day_${scope.dayIndex}`];
      const date = day !== undefined ? day.date : "日期未知";
      return [
        `- 单日优化：只输出影响 Day ${scope.dayIndex}（${date}）的操作；不要改动其他 Day 的既有安排。`,
      ];
    }
    case "attraction": {
      const visit = trip.visits?.[scope.visitId];
      const item = visit !== undefined ? trip.itemRegistry[visit.pointRef] : undefined;
      const name = item?.name ?? scope.visitId;
      return [
        `- 大景区内部补充：operations 只允许 containerRef={"kind":"visit","id":"${scope.visitId}"} 的 stop 级操作（plan / move / setDuration）以及该景区相关实体的 snippets；不要改动景区外的任何安排。`,
        `- 目标景区：${name}（visit=${scope.visitId}）`,
      ];
    }
  }
}

// ===== Task #161：来源模式与局部优化 =====

/** planner 来源选择上下文（Task #161：prompt 指令与候选过滤的统一输入） */
export interface GuidePlannerSourceSelection {
  mode: GuideDraftSourceMode;
  /** 局部模式：所选来源 id（校验后非空）；全部模式忽略 */
  selectedIds: ReadonlySet<string>;
}

/**
 * 局部模式来源选择业务校验（形状合法性在路由层；存在性 / 可用性在锁内同一 Trip 上做）。
 * 规则：选择必须非空；每个 id 必须存在于 guideSources 且 active、status ready/partial、
 * 有可读内容；无效选择在素材冻结前抛 INVALID_REQUEST（400），不保存任何草案。
 * 暂存来源（staged）允许——显式选中即可参与本轮局部优化。
 * 返回：按请求顺序去重的 id 数组（用于 draft.sourceIds 持久化与响应回传）。
 */
function validateDraftSourceSelection(
  trip: Trip,
  sourceMode: GuideDraftSourceMode,
  selectedSourceIds: string[] | undefined,
): string[] {
  if (sourceMode !== "selected") return [];
  const ids = [...new Set(selectedSourceIds ?? [])];
  if (ids.length === 0) {
    throw new AiError("INVALID_REQUEST", "局部优化必须至少选择一篇攻略来源（selectedSourceIds 不能为空）");
  }
  for (const id of ids) {
    const source = trip.guideSources?.[id];
    if (source === undefined || source === null) {
      throw new AiError("INVALID_REQUEST", `所选来源不存在：${id}，请刷新页面后重试`);
    }
    if (source.active !== true) {
      throw new AiError("INVALID_REQUEST", `所选来源已从当前行程移除：${id}`);
    }
    if (source.status !== "ready" && source.status !== "partial") {
      throw new AiError(
        "INVALID_REQUEST",
        `所选来源尚未处理完成（${id} 当前状态：${source.status}），请等待处理完成后重试`,
      );
    }
    if (!hasUsableGuideEvidence(trip, source)) {
      throw new AiError("INVALID_REQUEST", `所选来源没有可读内容：${id}，无法作为草案素材`);
    }
  }
  return ids;
}

/**
 * Task #161：候选支撑证据的资格来源 id 集合（只收窄不放宽）：
 * - 全部模式：全部 active 且非暂存来源——与 Task #147 的 active 宽判相比仅排除暂存来源，
 *   processing/failed 等状态但 active 的来源证据仍算支撑，与既有行为完全一致；
 * - 局部模式：仅所选来源（校验后必 active）——未选历史来源支撑的候选不进入 prompt；
 * - selection 缺省（buildGuidePlannerPrompt 被直接调用）：返回 undefined，
 *   保持 Task #147 既有 active 判定。
 */
function collectCandidateSupportSourceIds(
  trip: Trip,
  selection: GuidePlannerSourceSelection | undefined,
): Set<string> | undefined {
  if (selection === undefined) return undefined;
  const ids = new Set<string>();
  for (const source of Object.values(trip.guideSources ?? {})) {
    if (source === null || typeof source !== "object") continue;
    if (selection.mode === "selected") {
      if (selection.selectedIds.has(source.sourceId) && source.active === true) ids.add(source.sourceId);
    } else if (source.active === true && !isGuideSourceStaged(source)) {
      ids.add(source.sourceId);
    }
  }
  return ids;
}

/**
 * Task #216 P0-B：素材关联实体键集合（`kind:id` 格式）——合并产物中被提及对齐
 * 的 visit / stop 实体（MergedPlace.entityRef 只含这两类且都带 id）。作为
 * 【全局候选区】分层压缩的关联判据：素材提过的候选保持完整格式，其余压成
 * 紧凑名册。
 */
function collectCandidateMentionEntityRefs(merge: GuideMergeResult): ReadonlySet<string> {
  const refs = new Set<string>();
  for (const place of merge.places) {
    if (place.entityRef !== null) refs.add(`${place.entityRef.kind}:${place.entityRef.id}`);
  }
  return refs;
}

/** Task #161：来源范围指令行（局部模式告知模型素材已按所选来源过滤） */
function formatSourceScopeDirective(mode: GuideDraftSourceMode, sourceCount: number): string[] {
  if (mode !== "selected") return [];
  return [
    `- 来源范围：本轮只使用用户显式选中的 ${sourceCount} 篇攻略（【攻略素材】已按所选来源过滤）；未选来源的提及不作为本轮依据，不得引用其内容作为 operations / snippets 的证据。`,
  ];
}

/**
 * Task #282：来源集合哈希（SHA256 前 16 位）——用于判断已持久化的澄清答案是否仍有效。
 * 来源集合变化（新增/移除攻略）后哈希不同，答案失效，需重新澄清。
 *
 * Task #290 Minor5：把影响澄清问句的覆盖估算结果（coveredDayCount / totalDayCount /
 * suppressed）一并纳入哈希——问句本身含 coveredDayCount/totalDayCount，一旦天数扩展或
 * 覆盖缺口性质变化，问句语义前提改变，旧答案即失效（「问句变则答案失效」）。
 */
function computeSourceHash(
  snapshots: GuideSourceVersionSnapshot[],
  coverage: { coveredDayCount: number; totalDayCount: number; suppressed: boolean },
): string {
  const ids = snapshots.map((s) => s.sourceId).sort().join(",");
  const payload = `${ids}|cov=${coverage.coveredDayCount}/${coverage.totalDayCount}/sup=${coverage.suppressed}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/** Task #282：澄清答案注入 prompt 的指令行（用户选择后告知模型排程范围） */
function formatClarificationDirective(answer: ClarificationAnswer): string[] {
  if (answer === "guide_only") {
    return [
      "- 用户选择：只排攻略涉及的天（其余天保持现安排），不要为未被攻略覆盖的天生成任何操作。",
    ];
  }
  return [
    "- 用户选择：允许 AI 补充排满剩余天，可以为未被攻略覆盖的天安排合理活动（补充项须标注 provenance=ai_supplement）。",
  ];
}

/** quote 原文硬上限（Task #110）：截断到不超过 80 个 Unicode 字符（含末位省略号），
 *  压缩 prompt 规模且保留可读性；ref / 来源标题 / 地点关联照旧保留 */
const MENTION_QUOTE_MAX_CHARS = 80;

/** quoteText 瘦身：按 Unicode 码点截断到 ≤MENTION_QUOTE_MAX_CHARS 字符（含省略号） */
function truncateQuoteText(raw: string): string {
  const chars = [...raw];
  if (chars.length <= MENTION_QUOTE_MAX_CHARS) return raw;
  return `${chars.slice(0, MENTION_QUOTE_MAX_CHARS - 1).join("")}…`;
}

/** Task #273：命中可比较信号的来源补发完整原文的上限——只补被截断的选项细节，
 *  不把整篇长攻略灌进 prompt（西岛这类交通段落实测 251 字符，远离上限） */
const SOURCE_TEXT_SUPPLEMENT_MAX_CHARS = 1200;

/** 来源原文补发用的截断（按 Unicode 码点，含末位省略号） */
function truncateSourceText(raw: string): string {
  const chars = [...raw];
  if (chars.length <= SOURCE_TEXT_SUPPLEMENT_MAX_CHARS) return raw;
  return `${chars.slice(0, SOURCE_TEXT_SUPPLEMENT_MAX_CHARS - 1).join("")}…`;
}

/**
 * Task #273：只给「命中可比较信号」的来源补发完整原文。
 *
 * 为什么需要：真实生产数据的 NER 会把一篇交通攻略切成 4 个地点提及，且 quoteText 只留
 * 半句（西岛丢了「电动车 / 电动三轮车」与 25-40 / 5-10 两档价格），planner 仅凭提及文本
 * 无法补齐选项——即使第七节已解锁也只能产出残缺组。sourceText 是创建来源时持久化的
 * 用户原文，逐字可信，正是补齐选项细节的唯一依据。
 *
 * 边界：仅用于核对方式 / 价格 / 路线；ref 仍只能来自上方提及行，避免用来源 id 编造引用。
 */
function formatSourceTextSupplement(trip: Trip, sourceIds: readonly string[]): string[] {
  const lines: string[] = [];
  for (const sourceId of sourceIds) {
    const source = trip.guideSources?.[sourceId];
    const raw = source?.sourceText;
    if (typeof raw !== "string" || raw.trim() === "") continue;
    const title =
      typeof source?.title === "string" && source.title.trim() !== "" ? source.title : "无标题来源";
    lines.push(`▸ 来源原文（${title}，${sourceId}）：${JSON.stringify(truncateSourceText(raw))}`);
  }
  if (lines.length === 0) return [];
  return [
    "",
    "【来源原文补充】（提及原文被截断时用它核对方式 / 价格 / 路线；sourceMentionRefs 仍只能引用上方 ref= 值，禁止用来源 id 编造引用）",
    ...lines,
  ];
}

/** 攻略素材序列化：按地点分组，每条提及带 ref / claimKind / 原文（JSON 转义保行结构） */
function formatMergeMaterials(
  trip: Trip,
  merge: GuideMergeResult,
  signalSourceIds: readonly string[] = [],
): string[] {
  if (merge.mentions.length === 0) return ["（无可用攻略素材）"];
  const lines: string[] = [
    `（共 ${merge.sourceSnapshots.length} 篇可用来源、${merge.mentions.length} 条提及、${merge.places.length} 个地点；snippets.sourceMentionRefs 从 ref= 原样复制 1..3 条）`,
  ];
  for (const place of merge.places) {
    const aligned =
      place.entityRef !== null ? `对齐 ${place.entityRef.kind}=${place.entityRef.id}` : "未对齐行程实体";
    const provider = place.providerId !== null ? `，providerId=${place.providerId}` : "";
    lines.push(`▸ 地点：${place.displayName}（${aligned}${provider}）`);
    for (const merged of place.mentions) {
      const source = trip.guideSources?.[merged.sourceId];
      const title =
        typeof source?.title === "string" && source.title.trim() !== "" ? source.title : "无标题来源";
      const mention = merged.mention;
      const rawQuote = typeof mention.quoteText === "string" ? mention.quoteText : "";
      // Task #110 瘦身：原文截断到 80 字符；原文非空时不再重复发送语义重叠的 modelSummary，
      // 仅原文为空（OCR 失败 / 旧数据缺失）时才用摘要兜底，ref 与来源标题永远保留（溯源不破坏）
      const summary =
        rawQuote.trim() === "" &&
        typeof mention.modelSummary === "string" &&
        mention.modelSummary.trim() !== ""
          ? ` | 摘要=${JSON.stringify(mention.modelSummary)}`
          : "";
      const hint = mention.locationHint !== null ? ` | 提示=${JSON.stringify(mention.locationHint)}` : "";
      // Task #123 强证据父子关系：抽取/OCR 标注的从属关系原文依据随素材下发，
      // 供 classifyVisitAsStop 判断「上下文明示从属关系」；null/缺失不占行
      const relation =
        typeof mention.relationEvidence === "string" && mention.relationEvidence.trim() !== ""
          ? ` | 关系=${JSON.stringify(mention.relationEvidence)}`
          : "";
      lines.push(
        `    - ref=${merged.ref} | 类型=${mention.claimKind ?? "unknown"} | 范围=${mention.targetScope ?? "unknown"} | 原文=${JSON.stringify(truncateQuoteText(rawQuote))}${summary}${hint}${relation}（来源：${title}）`,
      );
    }
  }
  lines.push(...formatSourceTextSupplement(trip, signalSourceIds));
  return lines;
}

/** 组装 planner prompt：系统规则 + scope 指令 + 来源范围 + 日期硬性指令 + 行程现状 + 合并素材 + 补充句 */
export function buildGuidePlannerPrompt(
  trip: Trip,
  merge: GuideMergeResult,
  scope: DraftScope,
  directives: GuideDraftDayDirective[] = [],
  sourceSelection?: GuidePlannerSourceSelection,
  clarificationAnswer?: ClarificationAnswer | null,
): string {
  const note = typeof trip.guideDraftNote === "string" && trip.guideDraftNote.trim() !== "" ? trip.guideDraftNote : "（无）";
  const directiveLines = formatDirectivesPrompt(trip, directives);
  // Task #270 内容感知解锁 + Task #273 按来源聚合：per-place 之外再看同一来源原文 /
  // 跨地点聚合提及（真实 NER 会把一篇交通攻略切到多个地点，quoteText 还会截断）。
  const optionSignals = detectMergeOptionGroupSignals(merge, {
    sourceTexts: collectMergeSourceTexts(trip, merge),
  });
  if (optionSignals.hit) {
    console.log(
      `[GUIDES] optionGroups 内容信号命中，注入完整第七节契约：${optionSignals.reasons.join("；")}` +
        (optionSignals.sources.length > 0 ? `（命中来源：${optionSignals.sources.join(" / ")}）` : ""),
    );
  }
  // Task #161：局部模式告知素材已按所选来源过滤；全部模式不追加指令（与旧 prompt 一致）
  const sourceScopeLines =
    sourceSelection !== undefined
      ? formatSourceScopeDirective(sourceSelection.mode, merge.sourceSnapshots.length)
      : [];
  // Task #282：澄清答案注入（用户选择后告知模型排程范围）
  const clarificationLines =
    clarificationAnswer != null ? formatClarificationDirective(clarificationAnswer) : [];
  return [
    "【系统规则】",
    // Task #216 P1-C + Task #270：规则文本按素材量 / scope / 内容信号拼装
    buildGuidePlannerRulesText(merge.mentions.length, scope, optionSignals.hit),
    "",
    "【本次任务范围】",
    ...formatScopeDirective(trip, scope),
    ...sourceScopeLines,
    ...clarificationLines,
    ...(directiveLines.length > 0 ? ["", ...directiveLines] : []),
    "",
    "【行程现状】",
    // Task #110：pending 区块不可操作、无攻略关联候选对 planner 不可达，均不进 prompt（F11 全量行为不受影响）；
    // Task #161：候选支撑证据再按来源模式收窄（局部 = 仅所选来源，全部 = active 非暂存），
    // 资格集合恒为 active 来源子集 → 只收窄不放宽，不会因来源过滤把旧候选补回；
    // Task #216：scope 感知 Day 编排裁剪（P0-A）+ visit 行瘦身（P1-D）+
    // 候选区按素材关联分层压缩（P0-B）——planner 专用，F11 意图通道不受影响
    ...buildTripFacts(trip, {
      includePending: false,
      guideRelevantCandidatesOnly: true,
      candidateSupportSourceIds: collectCandidateSupportSourceIds(trip, sourceSelection),
      scope,
      slimVisitFormat: true,
      candidateMentionEntityRefs: collectCandidateMentionEntityRefs(merge),
    }),
    "",
    "【攻略素材】",
    ...formatMergeMaterials(trip, merge, optionSignals.sources),
    "",
    "【用户补充句】",
    note,
  ].join("\n");
}

// ===== Task #193：snippet-only 本地快速路径 =====

/**
 * 确定性的「只补提示」快速路径（Task #193）。
 *
 * 背景：攻略优化统一走 planner（prompt 常超 2 万字符、单轮预算 300s），但用户
 * 「把推荐理由 / 亮点补充到对应景点」这类请求最终常常只需 0 operations + 几条
 * snippets——语义与实体都已确定，等待百炼 2~5 分钟没有收益。
 *
 * 命中条件（全部满足才跳过 AI，任一不确定立即回落）：
 * 1. sourceMode="selected"（局部优化：用户显式选了来源）；
 * 2. 补充句无日期指令，且明确是补推荐理由 / 亮点 / 介绍 / 细节类内容，不包含
 *    新增地点 / 移动 / 删除 / 替换 / 调序 / 安排时间 / 整体重排 / 交通 / 住宿
 *    等结构性意图；
 * 3. 所选来源的全部提及都能唯一对齐现有 Visit / Stop：merge 已确定的 entityRef
 *    直接采用（行程存在近似重复 Visit 也不会被名称二次匹配抢走）；未对齐地点
 *    只做 normalizePoiName 全等 / 整体双向包含，同名 Visit / Stop 重复项按行程内
 *    优先级收敛（已排期 Visit > 已挂载 Stop > 未排期 Visit > 待定 Stop），
 *    同优先级多候选即回落；
 * 4. 能从 quoteText 提炼出至少一条可溯源提示，且全部提示过强证据校验；
 * 5. Task #270：素材不含「同一主题 ≥2 个可比较选项」信号——快速路径 optionGroups
 *    恒为空数组，命中信号时必须回落完整 planner（否则可成组的交通对比被静默丢弃）。
 *
 * 输出：operations 固定空数组；snippets.text 从原文分句确定性提炼（价格 / 时段 /
 * 可操作建议优先，≤GUIDE_SNIPPET_MAX_CHARS），targetRef 用已对齐实体，
 * sourceMentionRefs 精确引用对应 mention；同实体最多 GUIDE_SNIPPET_DISPLAY_LIMIT
 * 条（第二条仅在价值分 ≥30 的价格 / 时段等硬信息时保留），完全相同的文本合并引用。
 */

/** 快速路径对齐到的实体引用（只允许 visit / stop） */
type FastPathEntityRef = Extract<EntityRef, { kind: "visit" } | { kind: "stop" }>;

/** 单实体提示上限（与挂载侧同口径：GUIDE_SNIPPET_DISPLAY_LIMIT = 2） */
const FAST_PATH_SNIPPETS_PER_ENTITY = GUIDE_SNIPPET_DISPLAY_LIMIT;

/** 同实体第二条提示的最低价值分：只有价格 / 时段等硬信息才值得多占一张卡 */
const FAST_PATH_SECOND_SNIPPET_MIN_SCORE = 30;

/** 单条提示的最低价值分：0 分句（如「以上景点均未亲自拍摄」）不产出，避免噪音上卡 */
const FAST_PATH_MIN_SNIPPET_SCORE = 10;

/** 快速路径判定结果（未命中时携带原因，供日志与验证脚本断言） */
export type SnippetOnlyFastPathDecision =
  | { kind: "hit"; snippets: PendingGuideDraftSnippet[]; placeCount: number; mentionCount: number }
  | { kind: "miss"; reason: string };

/** 补充句结构意图拦截表：任一命中即回落 AI，不能把普通「优化行程」误判成 snippet-only */
const NOTE_STRUCTURAL_INTENTS: { reason: string; pattern: RegExp }[] = [
  {
    reason: "新增地点",
    // 「加个推荐理由 / 补一个亮点」是补充语义，不算新增地点（负向前瞻排除补充名词）
    pattern:
      /(?:新增|增加|再加|新加|加进|加一个|加个|多加|补一个|补个)(?!推荐|亮点|介绍|说明|细节|提示|理由|标签|备注|评价|玩法|特色|注意事项)|新景点|新地点|新地方|多一个|想去|还要去|顺便去/,
  },
  { reason: "移动 / 换位", pattern: /移动|移到|挪到|挪一|搬到|换到|放到|放进|调到|转到|调换|对调/ },
  { reason: "删除", pattern: /删除|删掉|删了|去掉|去除|移除|剔除|取消|不要了|拿掉|别去|不去了/ },
  { reason: "替换", pattern: /替换|换成|改为|改成|代替|取代/ },
  {
    reason: "调序 / 整体重排",
    pattern: /调序|排序|重排|顺序|整体|全局|全部重新|重新规划|重新安排|重新生成|重新排|先去|再去|先玩|再玩|顺路/,
  },
  {
    reason: "安排时间 / 时长",
    pattern: /安排|排到|排进|排在|排一下|定在|改时间|调整时间|提前到|推迟|延后|调早|调晚|早点|晚点|多待|少待|多玩|少玩|多住|少住|延长|缩短|加长|减少时间/,
  },
  { reason: "交通调整", pattern: /交通|打车|包车|航班|机票|高铁|火车|自驾|租车|接送|接机|送机|换乘|怎么去|出行方式/ },
  { reason: "住宿调整", pattern: /住宿|酒店|民宿|客栈|入住|退房|换房|订房|房型/ },
  { reason: "优化 / 调整行程", pattern: /优化|调整|改动|改一下|改一改/ },
];

/** 补充类动作 + 补充内容（两者同时出现才视为「只补亮点」意图） */
const NOTE_SUPPLEMENT_ACTION = /补充|补上|补齐|补进|补到|添加到|加入|加到|写入|写上|附上|整合|整理|提炼|总结/;
const NOTE_SUPPLEMENT_CONTENT = /推荐理由|亮点|介绍|简介|细节|说明|特色|体验|评价|玩法|建议|注意事项|看点|优缺点|心得/;

/** 分句打分线索：价格 / 时段 / 可操作建议 / 场景亮点 */
const HIGHLIGHT_PRICE_RE = /(?:[0-9０-９]+(?:\.[0-9]+)?\s*(?:元|块|毛|角|万))|免费|门票|人均|往返|单程|半价|优惠|价格|收费|消费|预算/;
const HIGHLIGHT_TIME_RE = /(?:早上|上午|中午|下午|傍晚|晚上|清晨|日出|日落|夜里|夜游|[0-9０-９一二三四五六七八九十]+\s*(?:点|小时|分钟)|半天|全天)/;
const HIGHLIGHT_ACTION_RE = /建议|推荐|一定|值得|适合|可以|记得|最好|避开|提前|预约|排队|不要|注意|小心|防晒|驱蚊|晕船|带好|准备|别忘/;
const HIGHLIGHT_SCENE_RE = /海水|沙滩|景色|拍照|出片|好吃|好玩|舒服|体验|清澈|浮潜|深潜|打卡|网红|安静|人少|烟火气|雨林|海景|玻璃海|能见度|日落|日出/;

/** 行程实体显示名（原始文本；与 merge.derivePlaceIdentity 同源） */
function fastPathEntityDisplayName(trip: Trip, ref: FastPathEntityRef): string {
  if (ref.kind === "visit") {
    const visit = trip.visits?.[ref.id];
    if (visit === undefined) return ref.id;
    return trip.itemRegistry?.[visit.pointRef]?.name ?? visit.pointRef;
  }
  const stop = trip.stops?.[ref.id];
  if (stop === undefined) return ref.id;
  return trip.itemRegistry?.[stop.matchedPointRef ?? ""]?.name ?? stop.customName ?? stop.stopId;
}

interface FastPathEntityCandidate {
  ref: FastPathEntityRef;
  /** normalizePoiName + 小写后的显示名 */
  normalizedName: string;
}

/** 全部候选实体（Visit / Stop）及其归一化显示名 */
function collectFastPathEntityCandidates(trip: Trip): FastPathEntityCandidate[] {
  const candidates: FastPathEntityCandidate[] = [];
  for (const visitId of Object.keys(trip.visits ?? {})) {
    const ref: FastPathEntityRef = { kind: "visit", id: visitId };
    const normalizedName = normalizePoiName(fastPathEntityDisplayName(trip, ref)).toLowerCase();
    if (normalizedName !== "") candidates.push({ ref, normalizedName });
  }
  for (const stopId of Object.keys(trip.stops ?? {})) {
    const ref: FastPathEntityRef = { kind: "stop", id: stopId };
    const normalizedName = normalizePoiName(fastPathEntityDisplayName(trip, ref)).toLowerCase();
    if (normalizedName !== "") candidates.push({ ref, normalizedName });
  }
  return candidates;
}

/** 未对齐地点的唯一名称（全部提及归一化后必须一致；不一致 / 为空视为无法对齐） */
function fastPathPlaceName(place: MergedPlace): string | null {
  const names = new Set<string>();
  for (const merged of place.mentions) {
    const rawName =
      typeof merged.mention.extractedName === "string" && merged.mention.extractedName.trim() !== ""
        ? merged.mention.extractedName
        : merged.mention.text;
    const normalized = normalizePoiName(typeof rawName === "string" ? rawName : "").toLowerCase();
    if (normalized !== "") names.add(normalized);
  }
  return names.size === 1 ? [...names][0] ?? null : null;
}

/**
 * 候选实体优先级（同名重复项收敛用；数值越小越可信）：
 * 0 = 已排期 Visit（真正的「行程景点」）> 1 = 已挂载 child / alternate Stop
 * > 2 = 未排期 Visit（候选池）> 3 = 待定 Stop > 4 = 已移除。
 * 现场：西岛既有 day_2 的 large_attraction Visit，又有一条同名 pending Stop
 * （历史归类残留）；名称全等命中两个实体时不应直接回落，而应取已排期 Visit。
 */
function fastPathCandidateTier(trip: Trip, ref: FastPathEntityRef): number {
  if (ref.kind === "visit") {
    const visit = trip.visits?.[ref.id];
    if (visit === undefined) return 9;
    if (visit.removedAt !== null && visit.removedAt !== undefined) return 4;
    const day = visit.dayRef === null ? undefined : trip.days?.[visit.dayRef];
    if (day !== undefined && day.scheduleVisitRefs.includes(ref.id)) return 0;
    return 2;
  }
  const stop = trip.stops?.[ref.id];
  if (stop === undefined) return 9;
  if (stop.removedAt !== null && stop.removedAt !== undefined) return 4;
  return stop.state === "attached" ? 1 : 3;
}

/** 同优先级唯一 → 该实体；同优先级仍有多个同名实体 → null（不猜，回落 AI） */
function pickUniqueFastPathCandidate(
  trip: Trip,
  matches: FastPathEntityCandidate[],
): FastPathEntityRef | null {
  if (matches.length === 0) return null;
  let bestTier = Number.POSITIVE_INFINITY;
  for (const match of matches) bestTier = Math.min(bestTier, fastPathCandidateTier(trip, match.ref));
  const best = matches.filter((match) => fastPathCandidateTier(trip, match.ref) === bestTier);
  return best.length === 1 ? (best[0]?.ref ?? null) : null;
}

/**
 * 地点 → 唯一实体：
 * - merge 已确定 entityRef（sourceMentionRefs 精确归属）→ 只认它，即使行程里存在
 *   近似重复 Visit 也不做名称二次匹配（避免抢到另一条重复行程）；
 * - 未对齐地点：归一化全等优先（同名 Visit / Stop 重复项按行程内优先级收敛，
 *   例如已排期 Visit 胜过同名 pending Stop）；其次整体双向包含；同优先级多候选
 *   / 零候选 → null（回落 AI，不猜）。
 */
function resolveFastPathEntityRef(
  trip: Trip,
  place: MergedPlace,
  candidates: FastPathEntityCandidate[],
): FastPathEntityRef | null {
  if (place.entityRef !== null) {
    const exists =
      place.entityRef.kind === "visit"
        ? trip.visits?.[place.entityRef.id] !== undefined
        : trip.stops?.[place.entityRef.id] !== undefined;
    return exists ? place.entityRef : null;
  }
  const placeName = fastPathPlaceName(place);
  if (placeName === null) return null;
  const exact = candidates.filter((candidate) => candidate.normalizedName === placeName);
  if (exact.length > 0) return pickUniqueFastPathCandidate(trip, exact);
  const partial = candidates.filter((candidate) => strongNameMatch(candidate.normalizedName, placeName));
  return pickUniqueFastPathCandidate(trip, partial);
}

interface HighlightClause {
  text: string;
  score: number;
  /** 原文顺序（同分保持稳定） */
  order: number;
}

/** 原文清洗：压空白 + 剥离开头地点名（如「蜈支洲岛：」），避免提示重复景点名 */
function stripQuoteHeading(rawQuote: string, mentionNames: string[]): string {
  let body = rawQuote.replace(/\s+/g, " ").trim();
  for (const name of mentionNames) {
    const trimmed = name.trim();
    if (trimmed === "" || !body.startsWith(trimmed)) continue;
    body = body.slice(trimmed.length).replace(/^[\s:：,，、\-—–|]+/, "").trim();
    break;
  }
  return body;
}

/** 分句 + 打分：价格 40 / 时段 30 / 可操作建议 20 / 场景亮点 10（同分保持原文顺序） */
function extractHighlightClauses(rawQuote: string, mentionNames: string[]): HighlightClause[] {
  const clauses: HighlightClause[] = [];
  const body = stripQuoteHeading(rawQuote, mentionNames);
  for (const part of body.split(/[。！？；;!?\n，,]+/)) {
    const text = part
      .replace(/^[\s\d一二三四五六七八九十]+[、.．)）]\s*/, "")
      .replace(/^[·•\-—*#\s]+/, "")
      .replace(/[。！？；;!?，,\s…]+$/, "")
      .trim();
    const length = [...text].length;
    if (length < 4 || !/[\u4e00-\u9fff]/.test(text)) continue;
    let score = 0;
    if (HIGHLIGHT_PRICE_RE.test(text)) score += 40;
    if (HIGHLIGHT_TIME_RE.test(text)) score += 30;
    if (HIGHLIGHT_ACTION_RE.test(text)) score += 20;
    if (HIGHLIGHT_SCENE_RE.test(text)) score += 10;
    if (length > GUIDE_SNIPPET_MAX_CHARS) score -= length - GUIDE_SNIPPET_MAX_CHARS;
    if (length < 8) score -= 5;
    clauses.push({ text, score, order: clauses.length });
  }
  return clauses;
}

/** 硬截断到 snippet 硬上限（含省略号） */
function truncateHighlightText(text: string): string {
  const chars = [...text];
  if (chars.length <= GUIDE_SNIPPET_MAX_CHARS) return text;
  return `${chars.slice(0, GUIDE_SNIPPET_MAX_CHARS - 1).join("")}…`;
}

/**
 * 由同一段原文的候选分句合成提示：最高分分句为准；过短时再并入一条有价值分句，
 * 合成文本不超推荐长度（28 字符）。价格 / 时段分句得分最高，不会被场景描述挤掉。
 */
function composeHighlightText(clauses: HighlightClause[], primary: HighlightClause): string {
  let text = primary.text;
  if ([...text].length < GUIDE_SNIPPET_RECOMMENDED_MAX_CHARS) {
    const supporting = clauses.find(
      (clause) =>
        clause.order !== primary.order &&
        clause.score >= 20 &&
        !text.includes(clause.text) &&
        [...`${text}，${clause.text}`].length <= GUIDE_SNIPPET_RECOMMENDED_MAX_CHARS,
    );
    if (supporting !== undefined) text = `${text}，${supporting.text}`;
  }
  return truncateHighlightText(text);
}

/** 提示文本去重 key（去括号 / 空白 / 标点后小写） */
function highlightTextKey(text: string): string {
  return normalizePoiName(text).replace(/[。！？；;!?，,、\s]/g, "").toLowerCase();
}

interface FastPathSnippetCandidate {
  text: string;
  claimKind: GuideClaimKind;
  ref: string;
  score: number;
  order: number;
}

/** 一个地点的全部提及 → 提示候选（每提及取最高分分句；无原文 / 无有效分句跳过） */
function collectFastPathSnippetCandidates(place: MergedPlace): FastPathSnippetCandidate[] {
  const candidates: FastPathSnippetCandidate[] = [];
  for (const merged of place.mentions) {
    const mention = merged.mention;
    const rawQuote =
      typeof mention.quoteText === "string" && mention.quoteText.trim() !== ""
        ? mention.quoteText
        : typeof mention.modelSummary === "string"
          ? mention.modelSummary
          : "";
    if (rawQuote.trim() === "") continue;
    const mentionNames = [mention.extractedName, mention.text].filter(
      (name): name is string => typeof name === "string" && name.trim() !== "",
    );
    const clauses = extractHighlightClauses(rawQuote, mentionNames);
    const primary = [...clauses].sort((left, right) => right.score - left.score || left.order - right.order)[0];
    if (primary === undefined || primary.score < FAST_PATH_MIN_SNIPPET_SCORE) continue;
    candidates.push({
      text: composeHighlightText(clauses, primary),
      claimKind:
        typeof mention.claimKind === "string" && CLAIM_KIND_SET.has(mention.claimKind)
          ? (mention.claimKind as GuideClaimKind)
          : "reported_opinion",
      ref: merged.ref,
      score: primary.score,
      order: candidates.length,
    });
  }
  return candidates;
}

interface FastPathSnippetGroup {
  text: string;
  claimKind: GuideClaimKind;
  refs: string[];
  score: number;
  order: number;
}

/** 同实体候选按文本去重合并（相同文本保留最强引用，最多 GUIDE_SNIPPET_MAX_MENTION_REFS 条） */
function groupFastPathSnippetCandidates(candidates: FastPathSnippetCandidate[]): FastPathSnippetGroup[] {
  const groups = new Map<string, FastPathSnippetGroup>();
  for (const candidate of candidates) {
    const key = highlightTextKey(candidate.text);
    if (key === "") continue;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        text: candidate.text,
        claimKind: candidate.claimKind,
        refs: [candidate.ref],
        score: candidate.score,
        order: candidate.order,
      });
      continue;
    }
    if (!existing.refs.includes(candidate.ref) && existing.refs.length < GUIDE_SNIPPET_MAX_MENTION_REFS) {
      existing.refs.push(candidate.ref);
    }
    existing.score = Math.max(existing.score, candidate.score);
  }
  return [...groups.values()].sort((left, right) => right.score - left.score || left.order - right.order);
}

/** 单个已对齐地点 → 最多 GUIDE_SNIPPET_DISPLAY_LIMIT 条提示（第二条只收硬信息） */
function buildFastPathPlaceSnippets(place: MergedPlace, entityRef: FastPathEntityRef): PendingGuideDraftSnippet[] {
  const groups = groupFastPathSnippetCandidates(collectFastPathSnippetCandidates(place));
  if (groups.length === 0) return [];
  const first = groups[0];
  if (first === undefined) return [];
  const selected = [first];
  const second = groups.find(
    (group) => group !== first && group.score >= FAST_PATH_SECOND_SNIPPET_MIN_SCORE,
  );
  if (second !== undefined) selected.push(second);
  return selected.slice(0, FAST_PATH_SNIPPETS_PER_ENTITY).map((group) => ({
    text: group.text,
    claimKind: group.claimKind,
    targetRef: entityRef,
    sourceMentionRefs: group.refs.slice(0, GUIDE_SNIPPET_MAX_MENTION_REFS),
  }));
}

/**
 * 快速路径判定 + 生成（确定性纯函数，离线可测）。
 * 任一条件不满足返回 miss（附带原因）；调用方只在 hit 时跳过 AI。
 */
export function resolveSnippetOnlyFastPath(input: {
  trip: Trip;
  merge: GuideMergeResult;
  note: string;
  directives: GuideDraftDayDirective[];
  sourceMode: GuideDraftSourceMode;
}): SnippetOnlyFastPathDecision {
  if (input.sourceMode !== "selected") return { kind: "miss", reason: "来源模式不是局部选择" };
  if (input.directives.length > 0) return { kind: "miss", reason: "补充句包含日期指令" };
  const note = input.note.trim();
  if (note === "") return { kind: "miss", reason: "缺少补充句" };
  const structural = NOTE_STRUCTURAL_INTENTS.find((intent) => intent.pattern.test(note));
  if (structural !== undefined) {
    return { kind: "miss", reason: `补充句包含结构意图（${structural.reason}）` };
  }
  if (!(NOTE_SUPPLEMENT_ACTION.test(note) && NOTE_SUPPLEMENT_CONTENT.test(note))) {
    return { kind: "miss", reason: "补充句未明确为补推荐理由 / 亮点 / 介绍 / 细节" };
  }
  if (input.merge.places.length === 0) return { kind: "miss", reason: "所选来源没有可用地点" };
  // Task #270 内容感知解锁 + Task #273 按来源聚合：素材含「同一主题 ≥2 个可比较选项」时
  // 必须走完整 planner——快速路径的 optionGroups 恒为空数组，命中会把可成组的交通 /
  // 票种对比直接丢弃。真实 NER 跨地点拆分 / quoteText 截断的素材由来源原文兜底。
  const optionSignals = detectMergeOptionGroupSignals(input.merge, {
    sourceTexts: collectMergeSourceTexts(input.trip, input.merge),
  });
  if (optionSignals.hit) {
    // 价格档位型命中时 optionTerms 可能为空——日志/原因里必须说清命中了什么，
    // 否则会出现「素材含可比较选项组信号（）」这种无法排查的空括号
    const signalDetail =
      optionSignals.optionTerms.length > 0
        ? optionSignals.optionTerms.join(" / ")
        : `价格档位型（${optionSignals.priceCount} 处价格${optionSignals.priceRange ? "，含区间" : ""}）`;
    return {
      kind: "miss",
      reason: `素材含可比较选项组信号（${signalDetail}），需完整 planner 提取 optionGroups`,
    };
  }

  const candidates = collectFastPathEntityCandidates(input.trip);
  const aligned: { place: MergedPlace; entityRef: FastPathEntityRef }[] = [];
  for (const place of input.merge.places) {
    const entityRef = resolveFastPathEntityRef(input.trip, place, candidates);
    if (entityRef === null) {
      return { kind: "miss", reason: `地点「${place.displayName}」无法唯一对齐现有行程实体` };
    }
    aligned.push({ place, entityRef });
  }

  // 同实体跨地点聚合去重（两个地点可能都归到同一实体）：每实体不超过展示上限
  const perEntityCount = new Map<string, number>();
  const seenKeys = new Set<string>();
  const rawSnippets: PendingGuideDraftSnippet[] = [];
  for (const entry of aligned) {
    const entityKey = `${entry.entityRef.kind}:${entry.entityRef.id}`;
    for (const snippet of buildFastPathPlaceSnippets(entry.place, entry.entityRef)) {
      const used = perEntityCount.get(entityKey) ?? 0;
      if (used >= FAST_PATH_SNIPPETS_PER_ENTITY) break;
      const dedupeKey = `${entityKey}|${highlightTextKey(snippet.text)}`;
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);
      perEntityCount.set(entityKey, used + 1);
      rawSnippets.push(snippet);
    }
  }
  if (rawSnippets.length === 0) return { kind: "miss", reason: "素材中没有可提炼的亮点原文" };

  // 与 AI 输出同一清洗链路：引用必须落在草案消费集合内，文本截断到硬上限
  const snippets = parseDraftSnippets(rawSnippets, new Set(input.merge.mentionRefs));
  if (snippets.length !== rawSnippets.length) {
    return { kind: "miss", reason: "提示清洗后条目丢失" };
  }
  // 与挂载侧同一强证据规则：不过关就整体回落 AI（不产出会被拒挂的草案）
  for (const snippet of snippets) {
    if (snippet.targetRef.kind !== "visit" && snippet.targetRef.kind !== "stop") {
      return { kind: "miss", reason: "提示目标不是 visit / stop" };
    }
    const target =
      snippet.targetRef.kind === "visit"
        ? input.trip.visits?.[snippet.targetRef.id]
        : input.trip.stops?.[snippet.targetRef.id];
    if (target === undefined || !isSnippetEvidenceRelated(input.trip, target, snippet)) {
      return { kind: "miss", reason: "提示未通过强证据校验" };
    }
  }
  return { kind: "hit", snippets, placeCount: aligned.length, mentionCount: input.merge.mentions.length };
}

// ===== 草案生成 =====

export interface GenerateGuideDraftInput {
  /**
   * 显式 scope（旧调用方 / 显式范围锁定）：提供时优先使用，entryContext 被忽略；
   * Task #176 起可缺省——缺省时按 resolveDraftScope 确定性规则自动判定。
   */
  scope?: DraftScope;
  /**
   * 本次临时补充句：提供时先写入 trip.guideDraftNote（与 PUT /draft-note 同校验、
   * 同 trim 语义）再生成草案，保证草案 note 快照与素材一致；缺省沿用现有补充句。
   */
  note?: string | null;
  /**
   * Task #161：本轮草案来源模式；缺省 = "all"（全部可用且非暂存来源整体重排，
   * 旧调用方不传即旧行为）；"selected" = 局部优化，只使用 selectedSourceIds
   * 所选来源的素材（允许暂存来源）。
   */
  sourceMode?: GuideDraftSourceMode;
  /** sourceMode="selected" 时的显式来源 id（非空；形状校验在路由层，业务校验在锁内） */
  selectedSourceIds?: string[];
  /**
   * Task #176：统一添加面板的入口上下文（自动 scope 判定输入，非用户可见控件）：
   * global = 顶栏入口；day = 某 Day 入口（优先局部优化该天）；
   * attraction = 某大景区入口（优先局部补充该景区内部玩法）。
   * 形状校验在路由层；有效性（天号越界 / visitId 不存在或非大景区）在
   * resolveDraftScope 内静默降级。显式 scope 存在时本字段被忽略。
   */
  entryContext?: GuideDraftEntryContext;
  /**
   * Task #282：稀疏攻略澄清用户回答（前端收到 clarification 响应后选择并重发）。
   * 提供时跳过缺口检测，持久化答案到 Trip 并注入 prompt 指令后正常生成。
   */
  clarificationAnswer?: ClarificationAnswer;
}

export interface GuideDraftResult {
  draftId: string | null;
  /** 草案落盘后的 Trip.version（= baseTripVersion，前端刷新行程用） */
  tripVersion: number;
  baseTripVersion: number;
  /** 实际生成输入时的 Trip.version（Task #105：素材冻结时的版本快照） */
  inputTripVersion: number;
  scope: DraftScope;
  /** Task #161：本轮草案来源模式（"all" | "selected"；缺省请求归一为 "all"） */
  sourceMode: GuideDraftSourceMode;
  /** Task #161：本轮实际选中的来源 id（局部模式 = 所选 id；全部模式 = 空数组） */
  sourceIds: string[];
  operations: Operation[];
  snippets: PendingGuideDraftSnippet[];
  /** Task #190：实用参考选项组（无符合定义的内容为空数组） */
  optionGroups: PendingGuideDraftOptionGroup[];
  unplaced: { subjectRef: EntityRef; reason: string }[];
  proposedNew: { name: string; reason: string | null }[];
  clarify: string | null;
  sourceSnapshots: GuideSourceVersionSnapshot[];
  sourceCount: number;
  mentionCount: number;
  placeCount: number;
  mentionRefCount: number;
  latencyMs: number;
  promptChars: number;
  attempts: number;
  /** Task #193：是否命中确定性 snippet-only 快速路径（true = 未调用 AI，attempts=0） */
  fastPath: boolean;
  /** Task #123：从补充句解析出的日期硬性指令（无指令为空数组） */
  directives: GuideDraftDayDirective[];
  /** 指令满足校验（生成时按草案操作终态推演；无指令为空数组） */
  requirementChecks: GuideDraftRequirementCheck[];
  /** 排天冲突（任务 125 勾选数据源；含默认选中策略） */
  conflicts: GuideDraftConflict[];
  /** 自动归类摘要（classifyVisitAsStop；预览展示用） */
  autoClassifications: GuideDraftAutoClassification[];
  /** Task #250：结构化分类解释（服务端按生成前行程快照 + 最终操作计算；旧客户端可不读） */
  explanation: GuideDraftExplanation;
  /**
   * Task #282：稀疏攻略澄清响应（非空时表示草案未生成，需前端弹两选项交互）。
   * 用户选择后带 clarificationAnswer 重发 draft 请求。
   */
  clarification?: GuideDraftClarification | null;
}

/** scope 业务边界校验（形状合法性在路由层完成；此处校验引用存在性 / 越界） */
function validateDraftScope(trip: Trip, scope: DraftScope): void {
  if (scope.kind === "day") {
    if (!Number.isInteger(scope.dayIndex) || scope.dayIndex < 1 || scope.dayIndex > trip.dayRefs.length) {
      throw new AiError("INVALID_REQUEST", `dayIndex 越界（当前行程共 ${trip.dayRefs.length} 天）`);
    }
    return;
  }
  if (scope.kind === "attraction" && trip.visits?.[scope.visitId] === undefined) {
    throw new AiError("INVALID_REQUEST", "visitId 不存在于当前行程，请刷新页面后重试");
  }
}

// ===== Task #176：自动 scope 决策（确定性纯函数，离线可测） =====

/** 统一添加面板的入口上下文（前端不再有用户可见的手动 scope 控件） */
export type GuideDraftEntryContext =
  | { type: "global" }
  | { type: "day"; dayIndex: number }
  | { type: "attraction"; visitId: string };

export interface ResolveDraftScopeInput {
  trip: Trip;
  /** 素材冻结后的合并结果（证据归属判定的数据源） */
  merge: GuideMergeResult;
  /** 补充句日期指令（parseDraftDirectives 在同一锁内解析的结果） */
  directives: GuideDraftDayDirective[];
  /** 面板入口上下文；缺省视为 global */
  entryContext: GuideDraftEntryContext | undefined;
}

/** 对齐实体的归属位置：天号（不可归属为 null）与所属大景区（非大景区内为 null） */
interface EntityScopeLocation {
  dayIndex: number | null;
  attractionVisitId: string | null;
}

/** 单个对齐实体（visit / stop）的归属推导；悬空实体返回 null（无法可靠归属） */
function resolveEntityScopeLocation(
  trip: Trip,
  entityRef: NonNullable<GuideMergeResult["places"][number]["entityRef"]>,
): EntityScopeLocation | null {
  if (entityRef.kind === "visit") {
    const visit = trip.visits?.[entityRef.id];
    if (visit === undefined) return null;
    return {
      dayIndex: visitDayIndex(trip, entityRef.id),
      attractionVisitId: visit.kind === "large_attraction" ? entityRef.id : null,
    };
  }
  const stop = trip.stops?.[entityRef.id];
  if (stop === undefined || stop.visitRef === null) return null;
  const parent = trip.visits?.[stop.visitRef];
  if (parent === undefined) return null;
  return {
    dayIndex: visitDayIndex(trip, stop.visitRef),
    attractionVisitId: parent.kind === "large_attraction" ? stop.visitRef : null,
  };
}

/**
 * 自动 scope 决策（Task #144 设计 / Task #176 落地；确定性纯函数）：
 * 1. 补充句日期指令优先锁定：全部指令指向同一天 → 该天；跨多个明确日期 → 整程；
 * 2. 入口上下文：从某天 / 某大景区打开时优先局部（无效上下文静默跳过）；
 * 3. 所选攻略证据可靠归属：全部对齐实体同属一个大景区 → 景区内部；否则全部
 *    归属同一天 → 单天。存在悬空实体、跨天 / 跨景区发散、或没有任何对齐实体
 *    时不收敛；未对齐提及不阻止收敛（scope 只限制输出操作，未对齐地点本来就
 *    无法成为操作主体）；
 * 4. 无法可靠收敛 → 整程回退（trip 永远是安全默认，不凭短词模糊扩大）。
 */
export function resolveDraftScope(input: ResolveDraftScopeInput): DraftScope {
  const { trip, merge, directives, entryContext } = input;

  // 1. 日期硬性指令优先：用户明确写了天，锁定该天（跨多天明确日期 → 整程）
  if (directives.length > 0) {
    const dayIndexes = new Set(directives.map((directive) => directive.dayIndex));
    if (dayIndexes.size === 1) return { kind: "day", dayIndex: directives[0]!.dayIndex };
    return { kind: "trip" };
  }

  // 2. 入口上下文：某天 / 某大景区上下文打开时优先局部
  if (entryContext !== undefined) {
    if (entryContext.type === "day") {
      if (
        Number.isInteger(entryContext.dayIndex) &&
        entryContext.dayIndex >= 1 &&
        entryContext.dayIndex <= trip.dayRefs.length
      ) {
        return { kind: "day", dayIndex: entryContext.dayIndex };
      }
    } else if (entryContext.type === "attraction") {
      const visit = trip.visits?.[entryContext.visitId];
      if (visit !== undefined && visit.kind === "large_attraction") {
        return { kind: "attraction", visitId: entryContext.visitId };
      }
    }
  }

  // 3. 证据归属：只看对齐实体（visit / stop）；未对齐提及不参与
  const dayIndexes = new Set<number>();
  const attractionVisitIds = new Set<string>();
  let allInsideAttraction = true;
  let alignedCount = 0;
  for (const place of merge.places) {
    if (place.entityRef === null) continue;
    alignedCount += 1;
    const location = resolveEntityScopeLocation(trip, place.entityRef);
    if (location === null) return { kind: "trip" }; // 悬空实体：无法可靠归属
    if (location.dayIndex !== null) dayIndexes.add(location.dayIndex);
    if (location.attractionVisitId !== null) attractionVisitIds.add(location.attractionVisitId);
    else allInsideAttraction = false;
  }
  if (alignedCount === 0) return { kind: "trip" }; // 无任何对齐实体：不收敛
  if (allInsideAttraction && attractionVisitIds.size === 1) {
    return { kind: "attraction", visitId: [...attractionVisitIds][0]! };
  }
  if (dayIndexes.size === 1) {
    return { kind: "day", dayIndex: [...dayIndexes][0]! };
  }

  // 4. 无法可靠收敛（跨天 / 跨景区 / 悬空）：整程回退
  return { kind: "trip" };
}

/**
 * Task #227：共享总预算耗尽的统一错误。消息报告本轮已等待时长 / 总预算 / 尝试次数
 * （与 callAndParseExtract 同口径），cause 保留 BailianTimeoutError 供上层识别超时来源。
 */
function draftBudgetExhaustedError(startMs: number, attempts: number, cause?: unknown): AiError {
  const elapsedMs = Date.now() - startMs;
  const totalSeconds = Math.round(GUIDE_DRAFT_TIMEOUT_MS / 1000);
  return new AiError(
    "BAILIAN_REQUEST_FAILED",
    `攻略草案生成超时（本轮已等待 ${Math.round(elapsedMs / 1000)} 秒、总预算 ${totalSeconds} 秒，共尝试 ${attempts} 次），请稍后重试`,
    cause === undefined ? undefined : { cause },
  );
}

/**
 * planner 调用 + 解析（Task #227：全部尝试共享 GUIDE_DRAFT_TIMEOUT_MS 总预算）。
 * - 每次尝试只分到剩余预算（callPlanner 的单次超时 = 剩余值），本轮总等待被硬性
 *   封顶在 GUIDE_DRAFT_TIMEOUT_MS，始终早于前端 315s 兜底超时返回；
 * - 解析失败 / 空响应 / 网络抖动最多重试一次；重试前剩余预算不足
 *   GUIDE_DRAFT_MIN_RETRY_BUDGET_MS 时直接按超时报错，不发起注定超时的调用；
 * - 百炼自身超时（BailianTimeoutError）一次即抛出，不再等下一个预算。
 */
async function callAndParsePlanner(
  prompt: string,
  validMentionRefs: ReadonlySet<string>,
): Promise<{ parsed: ParsedPlannerOutput; finalText: string; attempts: number }> {
  const startMs = Date.now();
  const deadlineMs = startMs + GUIDE_DRAFT_TIMEOUT_MS;
  let attempts = 0;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= GUIDE_DRAFT_MAX_ATTEMPTS; attempt += 1) {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      // 总预算已耗尽：不发起注定超时的调用
      throw draftBudgetExhaustedError(startMs, attempts);
    }
    attempts = attempt;
    try {
      const finalText = await plannerDeps.callPlanner(prompt, remainingMs);
      const parsed = parsePlannerOutput(finalText, validMentionRefs);
      if (parsed !== null) return { parsed, finalText, attempts: attempt };
      lastError = new AiError("AI_PARSE_FAILED", PLANNER_PARSE_FAILED_MESSAGE);
      console.error(
        `[GUIDES] 攻略草案第 ${attempt}/${GUIDE_DRAFT_MAX_ATTEMPTS} 次响应无法解析为有效草案，` +
          `前 200 字符：${finalText.slice(0, 200)}`,
      );
    } catch (error) {
      if (error instanceof BailianTimeoutError) {
        throw draftBudgetExhaustedError(startMs, attempt, error);
      }
      lastError = error;
    }
    const remainingAfterMs = deadlineMs - Date.now();
    console.warn(
      `[GUIDES] 攻略草案第 ${attempt}/${GUIDE_DRAFT_MAX_ATTEMPTS} 次生成失败：` +
        `${lastError instanceof Error ? lastError.message : String(lastError)}，本轮剩余预算 ${Math.max(0, remainingAfterMs)}ms`,
    );
    if (attempt < GUIDE_DRAFT_MAX_ATTEMPTS && remainingAfterMs < GUIDE_DRAFT_MIN_RETRY_BUDGET_MS) {
      // 剩余预算不足以完成一轮 planner（实测单轮常 >100s）：不再发起无意义重试
      throw draftBudgetExhaustedError(startMs, attempt);
    }
  }
  throw lastError instanceof AiError
    ? lastError
    : new AiError("BAILIAN_REQUEST_FAILED", "攻略草案生成失败，请稍后重试", { cause: lastError });
}

/**
 * 生成攻略草案（Task #97）：
 * 锁内（素材冻结）→ 锁外（AI）→ 锁内（乐观保存）。
 */
export async function generateGuideDraft(tripId: string, input: GenerateGuideDraftInput): Promise<GuideDraftResult> {
  // 1. 锁内：重启恢复扫描（锁内核心版，避免同 tripId 嵌套锁死锁）→ 补充句顺手保存 →
  //    合并素材 → 日期指令解析 → scope 解析（Task #176：显式优先，缺省自动判定）→
  //    构建 prompt
  const prepared = await withTripLock(tripId, async () => {
    const trip = await recoverStaleProcessingLocked(tripId);
    if (trip === null) {
      throw new AiError("TRIP_NOT_FOUND", "行程不存在或已被删除，请刷新页面后重试");
    }
    if (typeof input.note === "string") {
      if (input.note.length > DRAFT_NOTE_MAX_CHARS) {
        throw new AiError("INVALID_REQUEST", `攻略补充句超过 ${DRAFT_NOTE_MAX_CHARS} 字上限`);
      }
      const normalized = input.note.trim();
      if (normalized === "") delete trip.guideDraftNote;
      else trip.guideDraftNote = normalized;
      await tripStore.save(trip);
    }

    // Task #161：来源模式归一与局部选择校验（锁内同一 Trip 上做存在性 / 可用性判定）。
    // 无效选择在素材冻结前拒绝，不保存任何草案；暂存来源可被显式选中参与本轮。
    const sourceMode: GuideDraftSourceMode = input.sourceMode ?? "all";
    const selectedIdList = validateDraftSourceSelection(trip, sourceMode, input.selectedSourceIds);
    const selectedSet: ReadonlySet<string> = new Set(selectedIdList);
    const sourceSelection: GuidePlannerSourceSelection = { mode: sourceMode, selectedIds: selectedSet };

    // Task #161：局部模式只合并所选来源；全部模式只合并可用且非暂存来源（旧数据零迁移）
    const merge = mergeGuideMentions(
      trip,
      sourceMode === "selected" ? { selectedSourceIds: selectedSet } : undefined,
    );
    if (merge.mentions.length === 0) {
      throw new AiError(
        "GUIDE_NO_SOURCES",
        sourceMode === "selected"
          ? "所选攻略来源没有可用素材（需已处理完成且有可读内容），请检查选择后重试"
          : "没有可用的攻略来源（需已处理完成且有可读内容），请先导入攻略并等待处理完成",
      );
    }
    // Task #123：补充句日期指令解析（在锁内、素材冻结后的同一状态上做，保证指令与
    // prompt / 草案一致）。缺数字 / 超范围在此抛 400（note 仍已逐字保存，不吞不改）
    const directives = parseDraftDirectives(
      typeof trip.guideDraftNote === "string" ? trip.guideDraftNote : "",
      trip,
    );
    // Task #176：scope 解析——显式携带时优先（旧调用方行为不变）；缺省时按确定性
    // 规则自动判定（指令 > 入口上下文 > 证据归属 > 整程）。解析基于同一锁内的
    // 素材快照，与 prompt 输入完全一致；产出再过一次边界校验（防御性兑底）。
    const scope = input.scope ?? resolveDraftScope({ trip, merge, directives, entryContext: input.entryContext });
    validateDraftScope(trip, scope);

    // Task #282：稀疏攻略澄清——答案持久化与缺口检测（scope 解析后、快速路径前）
    // Task #290 Minor5：覆盖估算提前到 sourceHash 之前，并把结果纳入哈希——问句变则旧答案失效。
    const gap = estimateGuideCoverage(trip, merge.places);
    const sourceHash = computeSourceHash(merge.sourceSnapshots, gap);
    let effectiveAnswer: ClarificationAnswer | null = input.clarificationAnswer ?? null;
    let clarification: GuideDraftClarification | null = null;

    if (effectiveAnswer !== null) {
      // 用户本次提供了答案：持久化到 Trip（与 note 同次保存语义，版本已含 note 保存）
      trip.clarificationAnswer = effectiveAnswer;
      trip.clarificationSourceHash = sourceHash;
      await tripStore.save(trip);
    } else if (trip.clarificationAnswer != null && trip.clarificationSourceHash === sourceHash) {
      // 已持久化答案有效（来源集合与覆盖估算未变化）：复用，不再澄清
      effectiveAnswer = trip.clarificationAnswer;
    } else {
      // 无有效答案：检测覆盖缺口（gap 已在上方估算）
      // Task #294：C1 稀疏澄清只针对「拿薄攻略从零排满整程」——素材锚定不到任何既有已排天
      // （enrichmentAnchored=false，即 scheduledDayCount===0，素材全是未落位的新点位）。
      // 当素材已锚定既有排期（大景区整体提及 / 已排点位的亮点补充，scheduledDayCount≥1），
      // 说明行程本就有计划、用户在往里补内容（enrichment），此时即便覆盖天数不足半数也不打扰用户。
      // 该判定不改动覆盖估算门槛常数与 C2 抑制语义，仅收窄 C1 的触发场景（真稀疏仍触发）。
      if (gap.hasGap && !gap.suppressed && !gap.enrichmentAnchored) {
        // 缺口成立、未被 C2 抑制、且非既有排期补充：返回澄清响应（不调用 AI，毫秒级）
        clarification = {
          question: `攻略素材只够排 ${gap.coveredDayCount} 天，你的行程有 ${gap.totalDayCount} 天。要怎么处理剩余天？`,
          options: [
            { value: "guide_only", label: "只排攻略涉及的天（其余天保持现安排）" },
            { value: "ai_fill", label: "允许 AI 补充排满剩余天" },
          ],
        };
        console.log(
          `[GUIDES] 稀疏攻略澄清：素材可支撑 ${gap.coveredDayCount}/${gap.totalDayCount} 天` +
            `（已排 ${gap.scheduledDayCount} 天＋未排素材点位 ${gap.unscheduledUnitCount} 个），触发澄清（C1）`,
        );
      }
    }

    // Task #193：确定性 snippet-only 快速路径——语义（只补亮点）与实体（全部唯一对齐）
    // 都确定的请求不再等待百炼；任一条件不确定返回 miss，后续仍走完整 AI 链路。
    // Task #282：澄清响应时跳过快速路径（不调用 AI）
    const fastPath =
      clarification !== null
        ? ({ kind: "miss", reason: "clarification_needed" } as const)
        : resolveSnippetOnlyFastPath({
            trip,
            merge,
            note: typeof trip.guideDraftNote === "string" ? trip.guideDraftNote : "",
            directives,
            sourceMode,
          });
    const prompt =
      fastPath.kind === "hit" || clarification !== null
        ? ""
        : buildGuidePlannerPrompt(trip, merge, scope, directives, sourceSelection, effectiveAnswer);
    // Task #307：冲突域快照——草案正确性只依赖「排程现状 + 选中来源证据 + 补充句」，
    // 与 trip.version 解耦。保存草案前若版本变化，用这三项判定是真冲突还是可容忍的
    // 非冲突写（图片结算 / 证据追加），后者以最新版本 rebase 提交而非作废。
    const conflictSourceIds = collectSelectedSourceIds(merge.sourceSnapshots);
    const scheduleFingerprint = computeScheduleFingerprint(trip, conflictSourceIds);
    const consumedEvidenceRefs = collectConsumedEvidenceRefs(trip, conflictSourceIds);
    return {
      prompt,
      merge,
      scope,
      directives,
      promptChars: prompt.length,
      fastPath,
      validRefs: new Set(merge.mentionRefs),
      // Task #105：实际生成输入时的版本 + 补充句快照（落盘前据此判过期；
      // 含「补充句顺手保存」后的版本——它才是真正构建 prompt 的数据状态）
      inputTripVersion: trip.version,
      noteSnapshot: typeof trip.guideDraftNote === "string" ? trip.guideDraftNote : null,
      // Task #161：本轮来源模式与所选 id（重复提交核对与结果召回）
      sourceMode,
      sourceIds: selectedIdList,
      // Task #282：澄清响应（非空时草案未生成，直接返回）
      clarification,
      // Task #307：冲突域判定快照（仅在保存草案前版本变化时使用）
      scheduleFingerprint,
      conflictSourceIds,
      consumedEvidenceRefs,
    };
  });

  // 2. 锁外：快速路径直接产出；否则调 planner（长网络调用不占锁，与 B2 装配同模式）
  // Task #282：澄清响应——草案未生成，直接返回（不调用 AI，不保存草案）
  if (prepared.clarification !== null) {
    return {
      draftId: null,
      tripVersion: prepared.inputTripVersion,
      baseTripVersion: prepared.inputTripVersion,
      inputTripVersion: prepared.inputTripVersion,
      scope: prepared.scope,
      sourceMode: prepared.sourceMode,
      sourceIds: prepared.sourceIds,
      operations: [],
      snippets: [],
      optionGroups: [],
      unplaced: [],
      proposedNew: [],
      clarify: null,
      sourceSnapshots: prepared.merge.sourceSnapshots,
      sourceCount: prepared.merge.sourceSnapshots.length,
      mentionCount: prepared.merge.mentions.length,
      placeCount: prepared.merge.places.length,
      mentionRefCount: prepared.merge.mentionRefs.length,
      latencyMs: 0,
      promptChars: 0,
      attempts: 0,
      fastPath: false,
      directives: [],
      requirementChecks: [],
      conflicts: [],
      autoClassifications: [],
      explanation: {
        items: [],
        counts: { remove: 0, rearrange: 0, new: 0, retain: 0, adjust: 0, snippet_only: 0 },
        replaceSummaries: [],
      },
      clarification: prepared.clarification,
    };
  }

  const startedAt = Date.now();
  let parsed: ParsedPlannerOutput;
  let finalText = "";
  let attempts = 0;
  if (prepared.fastPath.kind === "hit") {
    parsed = {
      operations: [],
      snippets: prepared.fastPath.snippets,
      optionGroups: [],
      unplaced: [],
      proposedNew: [],
      clarify: null,
    };
    console.log(
      `[GUIDES] 攻略草案命中 snippet-only 快速路径：跳过 AI 调用（${prepared.fastPath.placeCount} 个已对齐地点 / ${prepared.fastPath.snippets.length} 条提示）`,
    );
  } else {
    if (prepared.sourceMode === "selected") {
      console.log(`[GUIDES] snippet-only 快速路径未命中，回落 AI：${prepared.fastPath.reason}`);
    }
    const plannerOutput = await callAndParsePlanner(prepared.prompt, prepared.validRefs);
    parsed = plannerOutput.parsed;
    finalText = plannerOutput.finalText;
    attempts = plannerOutput.attempts;
  }
  const latencyMs = Date.now() - startedAt;
  // Task #270：snippets 与 optionGroups 去重——百炼实测会把同一段交通对比同时写进
  // 两处（四次中三次），去重后只保留 optionGroup（组内已含方式 / 价格 / 路线）；
  // 保守规则见 optionSignals.dropSnippetsDuplicatedByOptionGroups。
  const snippetDedupe = dropSnippetsDuplicatedByOptionGroups(parsed.snippets, parsed.optionGroups);
  if (snippetDedupe.dropped.length > 0) {
    parsed = { ...parsed, snippets: snippetDedupe.snippets };
    console.log(
      `[GUIDES] optionGroups 去重：删除 ${snippetDedupe.dropped.length} 条与选项组重复的提示——` +
        snippetDedupe.dropped.map((entry) => `「${entry.text}」（${entry.topic}：${entry.reason}）`).join("；"),
    );
  }
  const routeNote =
    prepared.fastPath.kind === "hit"
      ? "snippet-only 快速路径，未调用 AI"
      : `尝试 ${attempts} 次，prompt ${prepared.promptChars} 字符`;
  console.log(
    `[GUIDES] 攻略草案生成完成：${parsed.operations.length} 条操作 / ${parsed.snippets.length} 条提示 / ${parsed.optionGroups.length} 组实用参考（${latencyMs}ms，${routeNote}）`,
  );

  // Task #193：验证钩子（生产不注入）——保存草案前允许模拟并发修改
  if (plannerDeps.beforeDraftSave !== undefined) {
    await plannerDeps.beforeDraftSave(tripId);
  }

  // 3. 锁内：先核版本再保存草案（Task #105）
  return withTripLock(tripId, async () => {
    const latest = await tripStore.load(tripId);
    if (latest === null) {
      throw new AiError("TRIP_NOT_FOUND", "行程不存在或已被删除，请刷新页面后重试");
    }
    // 版本保护（Task #307：冲突域粒度）：草案正确性只依赖其冻结输入——排程现状 +
    // 选中来源证据 + 补充句，与 trip.version 解耦。生成期间行程版本变化时分两种情况：
    // - 真冲突（排程 / 约束 / 补充句 / 选中来源被改，或已消费证据被删）→ 本次输出基于
    //   陈旧素材，丢弃并要求重新生成（不重试 AI：单次成本高）；
    // - 非冲突写（图片结算 / 证据追加 / imageProgress 更新等只 bump version 的后台写）→
    //   以 latest.version 为基线 rebase 提交（下方草案本就基于 latest 构建、save 再 bump）。
    // fail-safe：冲突域校验抛任何异常一律回退严格作废，绝不静默放行。
    if (latest.version !== prepared.inputTripVersion) {
      const decision = evaluateDraftRebase({
        latest,
        preparedFingerprint: prepared.scheduleFingerprint,
        selectedSourceIds: prepared.conflictSourceIds,
        consumedEvidenceRefs: prepared.consumedEvidenceRefs,
      });
      if (decision.kind === "stale") {
        console.warn(
          `[GUIDES] 草案未保存：生成期间行程版本已变化（输入 v${prepared.inputTripVersion} → 当前 v${latest.version}）` +
            `且命中真冲突——${decision.reason}`,
        );
        throw new AiError(
          "DRAFT_STALE",
          `生成期间行程已被修改（版本 ${prepared.inputTripVersion} → ${latest.version}），本次草案已作废，请重新生成`,
        );
      }
      console.warn(
        `[GUIDES] 草案 rebase：生成期间行程版本变化（输入 v${prepared.inputTripVersion} → 当前 v${latest.version}）` +
          `仅为非冲突写（图片结算 / 证据追加类），排程指纹与选中来源证据未变，以最新版本为基线提交`,
      );
    }
    const baseTripVersion = latest.version + 1;
    // Task #307：rebase 后草案绑定的输入版本 = 保存前的 latest.version（正常路径下
    // 恒等于 prepared.inputTripVersion；rebase 路径下改绑最新版本，维持 base = input + 1
    // 不变量，且不误导应用期新鲜度判定）。素材未变（指纹 + 证据已校验一致），改绑安全。
    const resolvedInputVersion = latest.version;
    // Task #123：服务端后校验与冲突检测（保存草案前，在同一锁内版本上执行）——
    // 目标 Visit / 已归类 child stops 终态必须位于指定 Day：模型错误排天的 op 被移除，
    // 由服务端补确定性 move/transfer；弱证据 classify 不下发；冲突只列出不覆盖。
    const enforced = enforceDraftDirectives(latest, prepared.directives, parsed.operations);
    // Task #250：可解释性分类——按「生成前行程快照 + 最终操作」确定性计算，
    // 前端只展示不推断（replace 移回 / 重排 / 新增 / 保留 / 仅补亮点）。
    const explanation = buildDraftExplanation({
      trip: latest,
      operations: enforced.operations,
      snippets: parsed.snippets,
      directives: enforced.directives,
    });
    if (enforced.removedOps.length > 0) {
      console.warn(
        `[GUIDES] 草案指令后校验移除 ${enforced.removedOps.length} 条操作：` +
          enforced.removedOps.map((entry) => entry.reason).join("；"),
      );
    }
    if (enforced.operations.length !== parsed.operations.length) {
      console.log(
        `[GUIDES] 草案操作经指令后校验调整：${parsed.operations.length} → ${enforced.operations.length} 条（classify 前置 / 错误排天纠正 / 补排）`,
      );
    }
    const draft: PendingGuideDraft = {
      draftId: `gd_${randomUUID().slice(0, 8)}`,
      baseTripVersion,
      inputTripVersion: resolvedInputVersion,
      scope: prepared.scope,
      sourceSnapshots: prepared.merge.sourceSnapshots,
      mentionIds: prepared.merge.mentionIds,
      mentionRefs: prepared.merge.mentionRefs,
      note: prepared.noteSnapshot,
      createdAt: new Date().toISOString(),
      output: {
        operations: enforced.operations,
        snippets: parsed.snippets,
        // Task #190：实用参考选项组随草案快照持久化（空组不写字段，旧消费方零感知）
        ...(parsed.optionGroups.length > 0 ? { optionGroups: parsed.optionGroups } : {}),
      },
      directives: enforced.directives.length > 0 ? enforced.directives : undefined,
      requirementChecks: enforced.requirementChecks.length > 0 ? enforced.requirementChecks : undefined,
      conflicts: enforced.conflicts.length > 0 ? enforced.conflicts : undefined,
      // Task #250：分类解释随草案快照持久化（刷新召回后仍可解释；旧草案缺省为零感知）
      explanation,
      // Task #161：本轮来源模式与所选 id 持久化（结果召回 / 重复提交核对）；
      // sourceSnapshots 已是实际参与合并的来源快照，sourceIds 记录用户显式选择
      sourceMode: prepared.sourceMode,
      ...(prepared.sourceMode === "selected" ? { sourceIds: prepared.sourceIds } : {}),
    };
    latest.pendingGuideDraft = draft;
    await tripStore.save(latest);
    return {
      draftId: draft.draftId,
      tripVersion: latest.version,
      baseTripVersion,
      inputTripVersion: resolvedInputVersion,
      scope: draft.scope,
      sourceMode: prepared.sourceMode,
      sourceIds: prepared.sourceIds,
      operations: enforced.operations,
      snippets: parsed.snippets,
      optionGroups: parsed.optionGroups,
      unplaced: parsed.unplaced,
      proposedNew: parsed.proposedNew,
      clarify: parsed.clarify,
      sourceSnapshots: draft.sourceSnapshots,
      sourceCount: draft.sourceSnapshots.length,
      mentionCount: prepared.merge.mentions.length,
      placeCount: prepared.merge.places.length,
      mentionRefCount: prepared.merge.mentionRefs.length,
      latencyMs,
      promptChars: prepared.promptChars,
      attempts,
      fastPath: prepared.fastPath.kind === "hit",
      finalTextChars: finalText.length,
      directives: enforced.directives,
      requirementChecks: enforced.requirementChecks,
      conflicts: enforced.conflicts,
      autoClassifications: enforced.autoClassifications,
      explanation,
    };
  });
}

// ===== 草案应用 =====

export interface GuideDraftApplyResult {
  type: "applied" | "proposal";
  /** 草案消费落盘后的 Trip.version（即使零应用 / 全拒绝也已自增：删除草案本身是状态变更） */
  tripVersion: number;
  draftId: string;
  applied: ApplyResult["applied"];
  rejected: ApplyResult["rejected"];
  /** 被护栏 / 执行器拒绝的操作条数（整批拒绝时 = 全部操作数） */
  rejectedCount: number;
  /** 拒绝原因摘要：按护栏分组计数 + 每组首条具体原因（整批拒绝时已补回逐条 G1/G3 原因）；无拒绝为 null */
  rejectSummary: string | null;
  /** 全部操作都被拒绝（applied=0 且 rejected>0）：行程结构未变更，前端不得提示「无需变更」 */
  allRejected: boolean;
  /** 敏感操作（remove / setPurchase / lock）→ ProposalCard 确认后走 /api/ai/intent/confirm */
  needsProposal: Operation[];
  /** 成功挂载到 Visit/Stop.guideSnippets 的提示条数（去重后实际新增） */
  attachedSnippetCount: number;
  /** Task #190：成功挂载到 Visit.optionGroups 的实用参考组数（去重后实际新增） */
  attachedOptionGroupCount: number;
  /** Task #123：应用后按真实行程重算的指令满足状态（met / partial / unmet，不再有 pending） */
  requirementChecks: GuideDraftRequirementCheck[];
  /** 草案中的自动归类摘要（classifyVisitAsStop；供前端展示归类结果） */
  autoClassifications: GuideDraftAutoClassification[];
  /** 实际以 user_confirmed 执行的冲突 id（选中且 resolution 执行成功的） */
  appliedConflictIds: string[];
  /** 未选中 / 不可执行的冲突摘要（保持原状项，前端展示） */
  unselectedConflicts: UnselectedConflictSummary[];
  /** 指令汇总：全部满足 → null；否则「已满足 / 部分满足 / 未满足」说明，禁止笼统成功文案 */
  requirementSummary: string | null;
  /** Task #250：实际执行操作的分类摘要（如「实际调整：移出 3 项、重排 1 项、新增 1 项」）；无结构变更 null */
  appliedSummary: string | null;
  message: string;
}

/** 每实体挂载上限（附录 B §3.3 展示上限；存储同限避免无界增长） */
const SNIPPET_PER_ENTITY_LIMIT = GUIDE_SNIPPET_DISPLAY_LIMIT;

// ===== Task #150：snippet 挂载强证据校验 =====

/** 实体显示名的归一化形式（与 merge.nameKey / web evidenceScope.normalizeEvidenceName 同口径） */
function snippetEntityName(trip: Trip, entity: Visit | Stop): string {
  const rawName =
    "stopId" in entity
      ? (trip.itemRegistry?.[entity.matchedPointRef ?? ""]?.name ?? entity.customName ?? entity.stopId)
      : (trip.itemRegistry?.[entity.pointRef]?.name ?? entity.pointRef);
  return normalizePoiName(rawName).toLowerCase();
}

/** 实体已归属的精确提及引用集合（sourceMentionRefs + guideSnippets[].sourceMentionRefs） */
function entityOwnedMentionRefs(entity: Visit | Stop): Set<string> {
  const owned = new Set<string>(Array.isArray(entity.sourceMentionRefs) ? entity.sourceMentionRefs : []);
  for (const snippet of Array.isArray(entity.guideSnippets) ? entity.guideSnippets : []) {
    for (const ref of Array.isArray(snippet.sourceMentionRefs) ? snippet.sourceMentionRefs : []) {
      owned.add(ref);
    }
  }
  return owned;
}

/** 名称强匹配：归一化后全等，或整体双向包含（两侧均 ≥2 字符，防单字短语泛化误命中） */
function strongNameMatch(entityName: string, mentionName: string): boolean {
  if (entityName === "" || mentionName === "") return false;
  if (entityName === mentionName) return true;
  return (
    entityName.length >= 2 &&
    mentionName.length >= 2 &&
    (entityName.includes(mentionName) || mentionName.includes(entityName))
  );
}

/**
 * Task #150 snippet 强证据判定：snippet 的 sourceMentionRefs 与目标实体须至少一条强相关，
 * 否则拒挂（现场：西岛「珊瑚墙」提示被错挂到蜈支洲岛情人岛 Stop）。强证据口径：
 * 1. 既有归属：ref 已在目标实体或其明确父子实体的精确引用中
 *   （B2 装配 / 前端已挂载写入的提及，是最高置信度信号）；
 * 2. 名称强匹配：相关实体的显示名与提及 extractedName（降级 text）归一化后
 *   全等或整体双向包含（两侧 ≥2 字符；与 web evidenceScope / directives 同口径）；
 * 3. 明确父子：目标 visit 合并其 child/alternate stops 的归属与名称，
 *   目标 stop 合并其父 visit 的归属与名称（父卡聚合与父级建议下沉两个方向）。
 * 兄弟实体（同一篇证据中的其他地点）不构成强证据。
 */
function isSnippetEvidenceRelated(trip: Trip, target: Visit | Stop, snippet: PendingGuideDraftSnippet): boolean {
  const related: Array<Visit | Stop> = [target];
  if ("stopId" in target) {
    const parent = target.visitRef !== null ? trip.visits?.[target.visitRef] : undefined;
    if (parent !== undefined) related.push(parent);
  } else {
    for (const stopId of [...target.childStopRefs, ...target.alternateStopRefs]) {
      const child = trip.stops?.[stopId];
      if (child !== undefined) related.push(child);
    }
  }
  const ownedRefs = new Set<string>();
  const entityNames: string[] = [];
  for (const entity of related) {
    for (const ref of entityOwnedMentionRefs(entity)) ownedRefs.add(ref);
    entityNames.push(snippetEntityName(trip, entity));
  }
  for (const ref of snippet.sourceMentionRefs) {
    if (ownedRefs.has(ref)) return true;
    const resolved = resolveMentionRef(trip, ref);
    if (resolved === null) continue;
    const rawMentionName = resolved.mention.extractedName ?? resolved.mention.text;
    const mentionName = normalizePoiName(typeof rawMentionName === "string" ? rawMentionName : "").toLowerCase();
    if (mentionName === "") continue;
    if (entityNames.some((name) => strongNameMatch(name, mentionName))) return true;
  }
  return false;
}

/**
 * 单实体追加一条提示（Task #212 写入防重）：
 * - 近似重复（全等 / 重合率 ≥ 0.9；引用同一 sourceMentionRef 时放宽为重合率 ≥ 0.8
 *   或公共前缀 ≥ 10 字且覆盖较短串 ≥ 60%，含 AI 随机空格、局部改写与同句两次
 *   截取）不再新增：同一亮点的改写不叠加成两条；新文本更完整（更长）时原位替换
 *   （复用 snippetId，引用随之更新），否则跳过；
 * - Task #339 第三档：双档未命中时，对同 (guide source, 归属景点) 的既有 snippet
 *   再跑 areSameSourceSnippetsSimilar（引用组合不完全相同 + 重合率 ≥ 0.5），命中
 *   同样合并为 1 条（保留更长者，替换时复用 snippetId），玻璃栈道型同攻略同景点
 *   两段相似表述不再叠加；
 * - 非重复且未超限时正常追加；返回是否挂载（新增 / 替换计 1，重复跳过计 0）。
 */
function appendGuideSnippet(entity: Visit | Stop, snippet: PendingGuideDraftSnippet, trip: Trip): number {
  const existing = Array.isArray(entity.guideSnippets) ? entity.guideSnippets : [];
  let twinIndex = existing.findIndex((entry) => areSnippetEntriesSimilar(entry, snippet));
  if (twinIndex === -1) {
    // Task #339：同一篇攻略 + 同一实体（归属景点由调用方保证）+ 引用组合不同的相似对
    twinIndex = existing.findIndex((entry) => areSameSourceSnippetsSimilar(entry, snippet, trip));
  }
  if (twinIndex >= 0) {
    const twin = existing[twinIndex];
    if (snippet.text.length <= twin.text.length) return 0;
    const next = existing.slice();
    next[twinIndex] = {
      ...twin,
      text: snippet.text,
      claimKind: snippet.claimKind,
      sourceMentionRefs:
        snippet.sourceMentionRefs.length > 0 ? snippet.sourceMentionRefs : twin.sourceMentionRefs,
    };
    entity.guideSnippets = next;
    return 1;
  }
  if (existing.length >= SNIPPET_PER_ENTITY_LIMIT) return 0;
  const stored: GuideSnippet = {
    snippetId: `gsn_${randomUUID().slice(0, 8)}`,
    text: snippet.text,
    claimKind: snippet.claimKind,
    sourceMentionRefs: snippet.sourceMentionRefs,
  };
  entity.guideSnippets = [...existing, stored];
  return 1;
}

// ===== Task #283 / C4：AI 补充项打标（provenance=ai_supplement） =====

/**
 * 判定一个 Visit 是否「非 AI 补充」——满足任一即视为来自攻略或用户资产，不打 AI 补充标：
 * - **用户侧豁免（Task #290 Major4）**：关联 Item 在本轮草案之前已存在于 before.itemRegistry
 *   （即非本轮新建）——用户从候选池搜来 / 历史沉淀的飞猪 POI 被 plan 排入某天时，
 *   属既有资产编排，不是本次 AI 补排产生的点位，不得标 ai_supplement（C4 语义反向失真防护）；
 * - 关联 Item 有 sourceEvidenceRefs（抽取自攻略证据）；
 * - Visit 自身有 sourceMentionRefs（精确提及引用）；
 * - Visit 已挂载 guideSnippets（攻略亮点，且 snippet 挂载本身已过强证据校验）。
 * 全部不成立 = 本轮新建、攻略未覆盖、由 AI 补排的点位（C4 补充项判定口径）。
 */
function isVisitGuideBacked(before: Trip, trip: Trip, visit: Visit): boolean {
  // 本轮之前就已存在的 Item = 用户/历史资产，不是本次 AI 补排产生的点位
  if (before.itemRegistry?.[visit.pointRef] !== undefined) return true;
  const item = trip.itemRegistry?.[visit.pointRef];
  if (item !== undefined && Array.isArray(item.sourceEvidenceRefs) && item.sourceEvidenceRefs.length > 0) {
    return true;
  }
  if (Array.isArray(visit.sourceMentionRefs) && visit.sourceMentionRefs.length > 0) return true;
  if (Array.isArray(visit.guideSnippets) && visit.guideSnippets.length > 0) return true;
  return false;
}

/** AI 补充打标结果：成功标 ai_supplement 的 itemId ＋ 因无真实飞猪 POI 被降级的 itemId */
export interface AiSupplementMarkResult {
  marked: string[];
  downgraded: string[];
}

/**
 * 对「本轮草案新排入且非攻略证据支撑」的点位打 provenance=ai_supplement（C4）。
 *
 * 判定点：before（应用前快照）未排期（不存在或 dayRef=null）、after（应用后）已排期的 Visit
 * ——即本次草案真正补排进某天的点位；已在行程中的既有安排不改标（不追溯历史）。
 *
 * 护栏（复用 #229 伪 POI 过滤思路）：只有引用真实飞猪 POI（isRealFliggyPoi）的补充项才标
 * ai_supplement；无真实飞猪 id 者降级——保持 origin/provenance 原样（不打标、前端不展示补充标），
 * 记入 downgraded 供上层告警，杜绝「无供给却以 AI 补充名义落地」。
 *
 * 纯函数式就地改写 after.itemRegistry（applyOps 产出的新行程对象，随后由 tripStore.save 落盘）。
 * 导出供 eval C4 与单测直接断言打标判定与护栏降级（确定性、无需真调 planner）。
 */
export function markAiSupplementProvenance(before: Trip, after: Trip): AiSupplementMarkResult {
  const marked: string[] = [];
  const downgraded: string[] = [];
  for (const [visitId, visit] of Object.entries(after.visits ?? {})) {
    if (visit === null || typeof visit !== "object") continue;
    if (visit.dayRef === null) continue; // 只标本轮已排入某天的点位
    const prev = before.visits?.[visitId];
    if (prev !== undefined && prev.dayRef !== null) continue; // 本轮之前已排期，非本次补排
    if (isVisitGuideBacked(before, after, visit)) continue; // 攻略证据支撑 / 用户既有资产 → 非 AI 补充
    const item = after.itemRegistry?.[visit.pointRef];
    if (item === undefined) continue;
    if (isRealFliggyPoi(item)) {
      item.provenance = "ai_supplement";
      marked.push(item.itemId);
    } else {
      // 无真实飞猪 POI：不得标 ai_supplement（降级 custom，前端不展示补充标）
      downgraded.push(item.itemId);
    }
  }
  return { marked, downgraded };
}

/** 挂载结果：新增条数 + 本次写入的实体（Task #212：应用后对其实体做引用级去重收尾） */
interface SnippetAttachResult {
  count: number;
  entities: Array<Visit | Stop>;
}

/**
 * 按 targetRef 挂载草案 snippets（附录 B §3.3）：
 * - visit → Visit.guideSnippets；stop → Stop.guideSnippets（内部玩法细节挂 Stop）；
 * - point → 按 pointRef 反查应用后 Trip 的 Visit（plan 新建或既有）挂 Visit；
 * - 其他 kind（day / lodging / hotel）不承载提示，静默跳过；
 * - Task #150：挂载前过强证据校验（isSnippetEvidenceRelated），提及与目标实体
 *   无名称全等/整体包含、无既有归属、无父子关系的提示拒挂并记日志，
 *   防止无关攻略片段错挂到同证据内的其他地点；
 * - Task #212：返回本次写入的实体列表，供 applyGuideDraft 挂载后做引用级去重。
 */
function attachDraftSnippets(trip: Trip, snippets: PendingGuideDraftSnippet[]): SnippetAttachResult {
  let attached = 0;
  const touched = new Map<string, Visit | Stop>();
  for (const snippet of snippets) {
    let target: Visit | Stop | undefined;
    let targetLabel: string;
    if (snippet.targetRef.kind === "stop") {
      target = trip.stops?.[snippet.targetRef.id];
      targetLabel = `stop=${snippet.targetRef.id}`;
    } else if (snippet.targetRef.kind === "point") {
      // 先取局部变量：回调内不保留外部属性窄化（EntityRef 联合含无 id 成员）
      const pointId = snippet.targetRef.id;
      target = Object.values(trip.visits ?? {}).find((entry) => entry.pointRef === pointId);
      targetLabel = `point=${pointId}`;
    } else if (snippet.targetRef.kind === "visit") {
      target = trip.visits?.[snippet.targetRef.id];
      targetLabel = `visit=${snippet.targetRef.id}`;
    } else {
      continue;
    }
    if (target === undefined) continue;
    if (!isSnippetEvidenceRelated(trip, target, snippet)) {
      console.warn(
        `[GUIDES] snippet 拒挂（强证据不足）：目标 ${targetLabel} 与提及 ${snippet.sourceMentionRefs.join(",")} 无名称全等/整体包含、既有归属或父子关系，文本「${snippet.text}」`,
      );
      continue;
    }
    const added = appendGuideSnippet(target, snippet, trip);
    if (added > 0) touched.set(targetLabel, target);
    attached += added;
  }
  return { count: attached, entities: [...touched.values()] };
}

/**
 * Task #190：按 targetRef 归一挂载实用参考选项组到 Visit.optionGroups。
 * - visit → 自身；stop → 父 Visit（选项组统一在 VisitCard 展示，不落 Stop）；
 *   point → 按 pointRef 反查应用后的 Visit；
 * - 无法可靠归属（stop 悬空 / point 无对应 Visit）不强挂，记日志跳过；
 * - 强证据校验：复用 isSnippetEvidenceRelated（组主题作为 text，组级∪选项级引用
 *   合并判定），任一引用与目标实体强相关即可；全无关拒挂（防止选项组错挂到
 *   同证据内的其他景点）；
 * - 同实体去重合并：shared mergeOptionGroupsIntoList（同主题同分类并选项，
 *   每实体上限 GUIDE_OPTION_GROUP_MAX_PER_ENTITY）；
 * - 返回新增组数（与 attachedSnippetCount 同口径，供返回体与文案）。
 */
function attachDraftOptionGroups(trip: Trip, groups: PendingGuideDraftOptionGroup[]): number {
  if (groups.length === 0) return 0;
  const collectedAt = new Date().toISOString();
  let addedGroups = 0;
  for (const group of groups) {
    let target: Visit | undefined;
    let targetLabel: string;
    if (group.targetRef.kind === "visit") {
      target = trip.visits?.[group.targetRef.id];
      targetLabel = `visit=${group.targetRef.id}`;
    } else if (group.targetRef.kind === "stop") {
      // 先取局部变量：回调内不保留外部属性窄化（EntityRef 联合含无 id 成员）
      const stopId = group.targetRef.id;
      const stop = trip.stops?.[stopId];
      target =
        stop !== undefined && stop.visitRef !== null ? trip.visits?.[stop.visitRef] : undefined;
      targetLabel = `stop=${stopId}`;
    } else if (group.targetRef.kind === "point") {
      const pointId = group.targetRef.id;
      target = Object.values(trip.visits ?? {}).find((entry) => entry.pointRef === pointId);
      targetLabel = `point=${pointId}`;
    } else {
      continue; // day / lodging / hotel 不承载选项组
    }
    if (target === undefined) {
      console.warn(`[GUIDES] optionGroup 拒挂：目标 ${targetLabel} 不存在，主题「${group.topic}」`);
      continue;
    }
    const allRefs = [
      ...new Set([...group.sourceMentionRefs, ...group.options.flatMap((option) => option.sourceMentionRefs)]),
    ];
    const pseudoSnippet: PendingGuideDraftSnippet = {
      text: group.topic,
      claimKind: "route_listing",
      targetRef: group.targetRef,
      sourceMentionRefs: allRefs,
    };
    if (!isSnippetEvidenceRelated(trip, target, pseudoSnippet)) {
      console.warn(
        `[GUIDES] optionGroup 拒挂（强证据不足）：目标 ${targetLabel} 与提及 ${allRefs.join(",")} 无既有归属或名称强匹配，主题「${group.topic}」`,
      );
      continue;
    }
    const merged = mergeOptionGroupsIntoList(
      target.optionGroups,
      [
        {
          topic: group.topic,
          category: group.category,
          options: group.options,
          sourceMentionRefs: allRefs,
        },
      ],
      collectedAt,
    );
    target.optionGroups = merged.groups;
    addedGroups += merged.addedGroups;
    if (merged.addedGroups === 0 && merged.addedOptions === 0) {
      console.log(`[GUIDES] optionGroup 去重：主题「${group.topic}」在 ${targetLabel} 已存在且无新选项`);
    }
  }
  return addedGroups;
}

/** 单条拒绝明细（guard 编号 + 具体原因），用于日志与返回体原因摘要 */
interface RejectionDetail {
  guard: string;
  reason: string;
}

// ===== Task #228：两阶段应用（结构阶段先行，属性阶段基于中间行程校验） =====

/**
 * 结构阶段 op 集合（Task #228）：改变实体所在容器的操作——plan（编排落天 / 父内重排）、
 * transfer（跨容器转移 / 归类纠正）、classifyVisitAsStop（普通景点归入大景区）。
 * 其余操作（setDuration / setTime / setPurchase / lock / move / remove /
 * addLodgingCandidate）全部归入属性阶段。
 */
const STRUCTURAL_PHASE_OPS: ReadonlySet<string> = new Set(["plan", "transfer", "classifyVisitAsStop"]);

/** 合并阈值触发时，本身合法操作的占位原因（沿用旧 revalidateForRejectAll 文案） */
const LEGAL_OP_THRESHOLD_REASON = "该条本身合法，因同批违规率超过 30% 被整批拒绝";

/** threshold 占位原因（整批拒绝时 rejected 条目统一文案，parseRejectionReason 已兼容） */
const THRESHOLD_BATCH_REASON = "违规率超过30%，整批拒绝";

/** 单阶段逐条护栏结果：passed / rejected 供执行与并入；details 与该阶段操作顺序对齐
 * （合法项预填 threshold 占位，整批拒绝时直接拼接即得逐条明细，无需重新校验） */
interface PhaseGuardOutcome {
  passed: Operation[];
  rejected: { op: Operation; guard: string; reason: string }[];
  details: { op: Operation; guard: string; reason: string }[];
}

/**
 * 对单阶段操作逐条跑 G1/G3 校验（与 checkGuards 的逐条部分同语义：validateOperation
 * 即其内部 validateDetail 的公开包装）；30% 阈值不在此计算——由调用方在两阶段合并后
 * 按全部操作总数统一判定（Task #228，避免结构阶段少量操作被单阶段阈值误杀）。
 */
function validateOpsPerItem(ops: Operation[], trip: Trip): PhaseGuardOutcome {
  const passed: Operation[] = [];
  const rejected: PhaseGuardOutcome["rejected"] = [];
  const details: PhaseGuardOutcome["details"] = [];
  for (const op of ops) {
    const detail = validateOperation(op, trip);
    if (detail.valid) {
      passed.push(op);
      details.push({ op, guard: "threshold", reason: LEGAL_OP_THRESHOLD_REASON });
    } else {
      const guard = detail.guard ?? "G1";
      const reason = detail.reason ?? "未知原因";
      rejected.push({ op, guard, reason });
      details.push({ op, guard, reason });
    }
  }
  return { passed, rejected, details };
}

/** 按阶段拆分操作（保序）：结构阶段先行，其余归入属性阶段（Task #228） */
function splitOpsByPhase(operations: Operation[]): { structuralOps: Operation[]; attributeOps: Operation[] } {
  const structuralOps: Operation[] = [];
  const attributeOps: Operation[] = [];
  for (const op of operations) {
    if (STRUCTURAL_PHASE_OPS.has(op.op)) structuralOps.push(op);
    else attributeOps.push(op);
  }
  return { structuralOps, attributeOps };
}

/** 从最终 rejected 条目还原 guard + reason（`[G1] xxx` 格式；执行器自拒条目归为「执行器」） */
function parseRejectionReason(raw: string): RejectionDetail {
  const matched = raw.match(/^\[(G1|G3|threshold)\]\s*([\s\S]*)$/);
  if (matched === null) return { guard: "执行器", reason: raw };
  return { guard: matched[1] ?? "G1", reason: (matched[2] ?? raw).trim() };
}

/** 拒绝原因摘要：按护栏分组计数 + 每组首条具体原因（口径紧凑，供返回体与前端警告展示） */
function summarizeRejectionDetails(details: RejectionDetail[]): string | null {
  if (details.length === 0) return null;
  const groups = new Map<string, { count: number; first: string }>();
  for (const detail of details) {
    const group = groups.get(detail.guard);
    if (group === undefined) groups.set(detail.guard, { count: 1, first: detail.reason });
    else group.count += 1;
  }
  return [...groups.entries()]
    .map(([guard, group]) => `${guard}×${group.count}：${group.first}`)
    .join("；");
}

/**
 * 应用结果文案：把「被安全规则拒绝」与「行程结构无需变更」彻底区分——
 * 只要 rejected > 0 且 applied = 0，文案必须明说被拒绝 + 原因摘要，
 * 绝不能再输出「无需变更」这类暗示用户「什么都没发生但成功了」的措辞。
 */
function buildApplyMessage(input: {
  type: GuideDraftApplyResult["type"];
  appliedCount: number;
  rejectedCount: number;
  allRejected: boolean;
  rejectSummary: string | null;
  attachedSnippetCount: number;
  attachedOptionGroupCount: number;
  proposalCount: number;
  requirementSummary: string | null;
  unselectedConflictCount: number;
}): string {
  const {
    type,
    appliedCount,
    rejectedCount,
    allRejected,
    rejectSummary,
    attachedSnippetCount,
    attachedOptionGroupCount,
    proposalCount,
    requirementSummary,
    unselectedConflictCount,
  } = input;
  // Task #123：指令满足情况与未选冲突必须显式出现在文案里，禁止笼统成功
  const requirementNote = requirementSummary !== null ? `。日期指令：${requirementSummary}` : "";
  const unselectedNote =
    unselectedConflictCount > 0 ? `；${unselectedConflictCount} 项冲突未勾选，相关安排保持原状` : "";
  // Task #190：实用参考组数并入提示计数（同一类「非结构变更的攻略补充」）
  const supplementNote =
    attachedSnippetCount > 0 && attachedOptionGroupCount > 0
      ? `，${attachedSnippetCount} 条攻略提示和 ${attachedOptionGroupCount} 组实用参考`
      : attachedSnippetCount > 0
        ? `，${attachedSnippetCount} 条攻略提示`
        : attachedOptionGroupCount > 0
          ? `，${attachedOptionGroupCount} 组实用参考`
          : "";
  if (allRejected) {
    const snippetNote = supplementNote !== "" ? `，仅添加了 ${supplementNote.slice(1)}` : "";
    const proposalNote = proposalCount > 0 ? `；另有 ${proposalCount} 项敏感操作待确认` : "";
    const reasonNote = rejectSummary !== null ? `。原因：${rejectSummary}` : "";
    return `草案中的 ${rejectedCount} 项调整因安全规则被拒绝，行程结构未变更${snippetNote}${proposalNote}${reasonNote}${requirementNote}${unselectedNote}`;
  }
  if (type === "proposal") {
    const skippedNote = rejectedCount > 0 ? `（另有 ${rejectedCount} 项调整因安全规则被跳过）` : "";
    return `已应用 ${appliedCount} 项操作${supplementNote}；另有 ${proposalCount} 项敏感操作需要确认${skippedNote}${requirementNote}${unselectedNote}`;
  }
  if (appliedCount > 0) {
    const skippedNote = rejectedCount > 0 ? `；${rejectedCount} 项调整因安全规则被跳过` : "";
    return `已按攻略草案更新行程（${appliedCount} 项操作${supplementNote}）${skippedNote}${requirementNote}${unselectedNote}`;
  }
  if (supplementNote !== "") {
    return `行程结构无需变更，已添加 ${supplementNote.slice(1)}${requirementNote}${unselectedNote}`;
  }
  return `草案无可应用的变更（可能已被应用过）${requirementNote}${unselectedNote}`;
}

// ===== Task #218：pending stop 引用预处理（applyGuideDraft 护栏前置防御） =====

/**
 * 过滤引用 pending stop 的操作（Task #218）。
 *
 * 背景：百炼偶尔违反 prompt 禁令，对 state=pending 的内部玩法输出 plan 挂入 /
 * setDuration / transfer 归类等操作——G1/G3 护栏本会逐条拒绝，但草案常只有
 * 少量操作，1 条违规就可能触发 30% 阈值放大成整批拒绝，合法操作全部陪葬。
 *
 * 语义：护栏保持硬约束不动（shared 不改）；本函数在护栏之前把「注定被拒的
 * pending 引用」从操作集中剥离——模型本就不该输出它们，剥离不改变任何可执行
 * 语义，只让护栏面对真正需要裁决的操作：
 * - plan：逐 assignment 过滤 subjectRef 引用 pending stop 的项；全部被滤掉则
 *   移除整条 plan；
 * - 其余带 subjectRef 的 op（move / remove / setDuration / transfer / setTime /
 *   setPurchase / lock）：subjectRef 引用 pending stop 即移除整条；
 * - classifyVisitAsStop / addLodgingCandidate 无 subjectRef，天然跳过；
 * - 任何过滤都 console.log 记录被剥离内容（线下排查模型违规用）。
 */
function filterPendingStopAssignments(operations: Operation[], trip: Trip): Operation[] {
  const isPendingStopRef = (ref: EntityRef): ref is Extract<EntityRef, { kind: "stop" }> =>
    ref.kind === "stop" && trip.stops[ref.id]?.state === "pending";

  const result: Operation[] = [];
  for (const op of operations) {
    if (op.op === "plan") {
      const kept = op.assignments.filter((assignment) => !isPendingStopRef(assignment.subjectRef));
      if (kept.length === op.assignments.length) {
        result.push(op);
        continue;
      }
      const dropped = op.assignments.filter((assignment) => isPendingStopRef(assignment.subjectRef));
      const droppedDesc = dropped
        .flatMap((assignment) => {
          const ref = assignment.subjectRef;
          return isPendingStopRef(ref) ? [`${ref.kind}:${ref.id}`] : [String(ref.kind)];
        })
        .join("、");
      if (kept.length > 0) {
        console.log(
          `[GUIDES] Task #218：草案 plan 过滤 ${dropped.length} 条 pending stop assignment（${droppedDesc}），保留其余 ${kept.length} 条`,
        );
        result.push({ ...op, assignments: kept });
      } else {
        console.log(
          `[GUIDES] Task #218：草案 plan 整条移除（${op.assignments.length} 条 assignment 全部引用 pending stop：${droppedDesc}）`,
        );
      }
      continue;
    }
    if ("subjectRef" in op) {
      const ref = op.subjectRef;
      if (isPendingStopRef(ref)) {
        console.log(`[GUIDES] Task #218：草案移除引用 pending stop 的 ${op.op} 操作（stop=${ref.id}）`);
        continue;
      }
    }
    result.push(op);
  }
  return result;
}

/**
 * Task #248：整日替换的确定性移回操作键集合（`${dayIndex}:${visitId}`）。
 * 旧草案无 mode / 无 replaceRemovedVisitIds 时为空集——应用行为与修改前完全一致。
 */
function collectReplaceDetachKeys(directives: GuideDraftDayDirective[] | undefined): Set<string> {
  const keys = new Set<string>();
  for (const directive of directives ?? []) {
    if (directive.mode !== "replace") continue;
    for (const visitId of directive.replaceRemovedVisitIds ?? []) {
      keys.add(`${directive.dayIndex}:${visitId}`);
    }
  }
  return keys;
}

/** op 是否为整日替换生成的「移回候选池」操作（remove visit from day，且命中指令清单） */
function isReplaceDetachRemove(op: Operation, keys: ReadonlySet<string>): boolean {
  if (op.op !== "remove") return false;
  if (op.subjectRef.kind !== "visit") return false;
  if (op.fromContainerRef.kind !== "day") return false;
  return keys.has(`${op.fromContainerRef.dayIndex}:${op.subjectRef.id}`);
}

/**
 * Task #253：本次实际应用的操作中，真正「向某天新排入」的天号集合。
 *
 * 整日替换的移回只允许发生在这些天：模型新规划为空 / 全部被拒绝 / 待用户确认时，
 * 旧安排必须留在原天（否则会退化成「只清空不重排」）。plan 与 transfer 都是真实落地；
 * move 是同天改序，不算新入天；已在当天的锚点再次 plan 也不算。
 */
function collectReplenishedDayIndexes(trip: Trip, operations: Operation[]): Set<number> {
  const days = new Set<number>();
  for (const op of operations) {
    if (op.op === "classifyVisitAsStop") continue;
    if (op.op === "plan") {
      const scope = op.scopeRef;
      if (scope.kind !== "day") continue;
      const hasNewAssignment = op.assignments.some((assignment) => {
        const ref = assignment.subjectRef;
        if (ref.kind !== "visit") return true; // point 壳由 plan 新建，必为新排入
        return visitDayIndex(trip, ref.id) !== scope.dayIndex;
      });
      if (hasNewAssignment) days.add(scope.dayIndex);
      continue;
    }
    if (op.op === "transfer") {
      const to = op.toContainerRef;
      if (to.kind !== "day") continue;
      const ref = op.subjectRef;
      if (ref.kind !== "visit") continue;
      if (visitDayIndex(trip, ref.id) !== to.dayIndex) days.add(to.dayIndex);
    }
  }
  return days;
}

/**
 * 应用当前草案（Task #97；Task #123 扩展 selectedConflictIds 部分应用）：
 * 版本保护 → 四条护栏（两阶段：结构先应用、属性基于中间行程校验，Task #228）→
 * applyOps 确认分流 → 选中冲突 user_confirmed 执行 → 挂载 snippets →
 * 重算指令满足状态 → 一次性消费草案。
 *
 * - 版本保护（附录 B §2.4）：Trip.version / 来源版本 / mention 快照 / 补充句
 *   任一变化即 DRAFT_STALE，提示重新生成（发现新的攻略细节，可重新优化）；
 * - 护栏不豁免：G1/G3 红线（锁定项 / 已购项）照常拒绝；
 * - 两阶段应用（Task #228）：plan / transfer / classifyVisitAsStop 等结构操作先
 *   校验并执行得到中间行程，setDuration / setTime / move 等属性操作再基于中间
 *   行程校验执行——消除「plan 与 setDuration 同批时，实体尚未落天导致属性操作
 *   被 G1 误拒」的批内顺序依赖；结构阶段全拒时属性阶段退回原始行程校验（行为
 *   与修改前一致）；30% 阈值在两阶段合并后按全部操作总数统一计算，不因分阶段放宽；
 * - 敏感操作走 applyOps 默认确认分流（needsProposal），由前端 ProposalCard
 *   确认后经 /api/ai/intent/confirm 二次下发——与 F11 提案链路同构；
 *   Task #253 例外收紧：整日替换（draft.directives 中 mode="replace" 的 replaceRemovedVisitIds）
 *   对应的 remove 必须由前端在 GuideDraftReview 里明确勾选确认（replaceConfirm，
 *   且 draftId 必须等于当前草案）才执行——草案摘要存在、普通 apply 请求、确认缺失 /
 *   false / draftId 不一致一律不移出；同时要求该天本次确有新安排落地（补排成功），
 *   模型规划为空 / 全部被拒时不得只清空不重排。逐条仍过护栏、仍计入 30% 阈值。
 * - 选中冲突（selectedConflictIds）：仅选中且 resolution 非空的冲突，以
 *   confirmed=true + actor=user_confirmed 执行（G3 对 move/transfer 放行，
 *   remove 红线不变）；未选中冲突保持原状并回传摘要；
 * - 草案一次性消费：应用后清除 pendingGuideDraft，且无条件落盘——全拒绝 / 零操作时
 *   applied=0 但删除草案本身也是状态变更，不 save 会让同一草案可被反复应用；
 *   返回的 tripVersion 为落盘后的版本（前端据此刷新行程）；
 * - 拒绝可见：整批拒绝时返回体保留逐条 G1/G3 原因（rejectSummary），message 明确为
 *   「被拒绝」而非「无需变更」，前端据此提示警告并可展开原因；
 * - 指令可见：requirementChecks 按应用后真实行程重算，message 携带已满足 /
 *   部分满足 / 未满足说明与未选冲突摘要，不笼统报成功。
 */
export interface GuideDraftReplaceConfirm {
  /** 必须与当前草案 draftId 一致；草案已变化（重新生成）时该确认自动失效 */
  draftId: string;
  /** 用户是否明确勾选「整日替换旧安排」（仅 true 才允许执行 replace 移回） */
  confirmed: boolean;
}

export async function applyGuideDraft(
  tripId: string,
  selectedConflictIds?: string[],
  replaceConfirm?: GuideDraftReplaceConfirm,
): Promise<GuideDraftApplyResult> {
  return withTripLock(tripId, async () => {
    const trip = await tripStore.load(tripId);
    if (trip === null) {
      throw new AiError("TRIP_NOT_FOUND", "行程不存在或已被删除，请刷新页面后重试");
    }
    const draft = trip.pendingGuideDraft;
    if (draft === undefined || draft === null) {
      throw new AiError("DRAFT_NOT_FOUND", "当前没有待应用的攻略草案，请先生成草案");
    }
    if (draft.output === undefined) {
      throw new AiError("DRAFT_NOT_FOUND", "草案缺少生成结果，请重新生成草案后再应用");
    }

    // 版本保护：任一快照维度变化即过期（不阻断生成，只阻断应用）
    const freshness = checkPendingGuideDraftFreshness(draft, trip);
    if (!freshness.fresh) {
      console.warn(`[GUIDES] 草案应用被版本保护拒绝：${freshness.reasons.join(",")}`);
      throw new AiError(
        "DRAFT_STALE",
        `草案已过期（${freshness.details.join("；")}）。发现新的行程或攻略变化，请重新生成草案后再应用`,
      );
    }

    const operations = draft.output.operations;
    // Task #218：护栏前置防御——剥离注定被拒的 pending stop 引用（prompt 已有禁令
    // 但模型不保证遵守；剥离后护栏只需裁决真正可疑的操作，30% 阈值不再被
    // 「必拒项」放大成整批拒绝。护栏本身保持硬约束，shared 不动）
    const pendingSafeOps = filterPendingStopAssignments(operations, trip);
    // Task #253：区域占位点位（自定义「亚龙湾」这类区域标题）不是操作目标——旧草案 / 模型
    // 对它的 plan / transfer / remove / setDuration 一律不下发；数据本身原样保留不删除。
    const areaPlaceholderIds = collectAreaPlaceholderVisitIds(trip);
    const sanitizedOps = stripOpsReferencingVisits(
      trip,
      pendingSafeOps.filter(
        (op) =>
          op.op !== "classifyVisitAsStop" ||
          (!areaPlaceholderIds.has(op.visitId) && !areaPlaceholderIds.has(op.parentVisitId)),
      ),
      areaPlaceholderIds,
      "区域占位点位",
      [],
    );

    // Task #325：容量前置剥离（与 F11 pipeline.ts 步骤 5.6 同源，复用同一 stripOverloadedDayOps）——
    // 剥离超出抵达日 / 返程日容量的本批 AI 净新增。剥离项不进两阶段合并后的 30% 阈值
    // 分子分母（阈值基数 = 剥离后剩余操作总数，与 #228 口径一致），但进 rejected 明细（可见）。
    const capacityStrip = stripOverloadedDayOps(sanitizedOps, trip, "ai_proposed");
    const capacitySafeOps = capacityStrip.remaining;
    const capacityRejections = capacityStrip.stripped;
    if (capacityRejections.length > 0) {
      console.log(
        `[GUIDES] Task #325：草案侧前置剥离 ${capacityRejections.length} 条超容量操作（抵达日/返程日），剩余 ${capacitySafeOps.length} 条继续两阶段护栏`,
      );
    }

    // Task #228：两阶段护栏——结构阶段（plan / transfer / classifyVisitAsStop）先校验并
    // 执行，属性阶段（setDuration / setTime / move 等）基于结构阶段应用后的中间行程校验，
    // 消除「plan 与 setDuration 同批时，setDuration 因实体尚在候选池 / 未落天被 G1 误拒」
    // 的批内顺序依赖；30% 阈值在两阶段合并后按全部操作总数统一计算（基数不按阶段拆分）。
    const { structuralOps, attributeOps } = splitOpsByPhase(capacitySafeOps);
    const structuralGuard = validateOpsPerItem(structuralOps, trip);
    // 结构阶段先行执行（applyOps 纯函数不落盘；合并阈值触发时整体弃用该中间结果）
    const structuralApply =
      structuralGuard.passed.length > 0
        ? applyOps(trip, structuralGuard.passed, { confirmed: false, actor: "ai_proposed" })
        : null;
    const intermediateTrip = structuralApply !== null ? structuralApply.trip : trip;
    const attributeGuard = validateOpsPerItem(attributeOps, intermediateTrip);

    // 30% 阈值（PRD §12.5）：两阶段合并后统一计算，恰好 30% 不触发，与 checkGuards 同口径；
    // 触发时结构阶段合法操作一并弃用（trip 逐字段原状），阈值语义不因分阶段放宽。
    // Task #253：阈值判定提到整日替换门控之前——整批拒绝时没有任何新安排落地。
    const totalOpsCount = structuralOps.length + attributeOps.length;
    const guardRejectedCount = structuralGuard.rejected.length + attributeGuard.rejected.length;
    const rejectAll = totalOpsCount > 0 && guardRejectedCount / totalOpsCount > 0.3;

    // Task #123：选中冲突先解析（纯函数，无副作用）——整日替换门控与后续执行共用同一份结果
    const { selected: selectedConflicts, unselected: unselectedConflicts } = selectConflictResolutions(
      draft.conflicts ?? [],
      selectedConflictIds,
    );

    // Task #253：整日替换（replace）的移回必须同时满足两个条件：
    // 1. 用户对**当前草案**明确确认（replaceConfirm.draftId === draft.draftId 且 confirmed）；
    //    确认缺失 / false / draftId 不一致（草案已变化）时一律不移出，原天保持原样；
    // 2. 本次实际应用的操作中，该天确有「新排入」落地（模型规划非空且未被拒绝）。
    //    模型规划为空 / 全部被拒 / 待确认时，整日替换不得退化成「只清空不重排」。
    const replaceConfirmRejectedReason =
      replaceConfirm === undefined
        ? "未收到本次草案的整日替换确认，旧安排未移回"
        : replaceConfirm.draftId !== draft.draftId
          ? "确认信息与当前草案不匹配（草案已变化），本次不执行整日替换"
          : replaceConfirm.confirmed !== true
            ? "未勾选整日替换确认，旧安排未移回"
            : null;
    const replaceLandedDays = collectReplenishedDayIndexes(trip, [
      ...(rejectAll ? [] : (structuralApply?.applied ?? [])),
      ...selectedConflicts.flatMap((conflict) => (conflict.resolution === null ? [] : [conflict.resolution])),
    ]);
    const replaceDetachKeys = collectReplaceDetachKeys(draft.directives);
    const replaceDetachCandidates = attributeGuard.passed.filter((op) => isReplaceDetachRemove(op, replaceDetachKeys));
    const replaceSkippedDays = new Map<number, string>();
    const replaceDetachOps: Operation[] = [];
    for (const op of replaceDetachCandidates) {
      if (op.op !== "remove" || op.fromContainerRef.kind !== "day") continue;
      const dayIndex = op.fromContainerRef.dayIndex;
      if (replaceConfirmRejectedReason !== null) {
        replaceSkippedDays.set(dayIndex, replaceConfirmRejectedReason);
        continue;
      }
      if (!replaceLandedDays.has(dayIndex)) {
        replaceSkippedDays.set(dayIndex, `本次实际未向 Day ${dayIndex} 排入新安排（相关操作被拒绝或待确认），旧安排未移回`);
        continue;
      }
      replaceDetachOps.push(op);
    }
    const regularAttributeOps = attributeGuard.passed.filter((op) => !isReplaceDetachRemove(op, replaceDetachKeys));
    if (replaceDetachOps.length > 0) {
      console.log(
        `[GUIDES] 草案 ${draft.draftId} 整日替换：${replaceDetachOps.length} 项旧安排移回候选池（user_confirmed 执行）`,
      );
    }
    if (replaceSkippedDays.size > 0) {
      console.warn(
        `[GUIDES] 草案 ${draft.draftId} 整日替换跳过：${[...replaceSkippedDays.entries()]
          .map(([dayIndex, reason]) => `Day${dayIndex}（${reason}）`)
          .join("；")}`,
      );
    }
    // 整批拒绝时逐条明细直接取两阶段校验结果（合法项已预填 threshold 占位），无需重新校验
    const rejectAllDetails: RejectionDetail[] = rejectAll
      ? [...structuralGuard.details, ...attributeGuard.details].map((detail) => ({
          guard: detail.guard,
          reason: detail.reason,
        }))
      : [];
    if (rejectAll) {
      console.warn(
        `[GUIDES] 草案 ${draft.draftId} 应用整批拒绝（违规率 > 30%，${capacitySafeOps.length} 条操作全部未执行），逐条原因：`,
      );
      for (let index = 0; index < capacitySafeOps.length; index += 1) {
        const op = capacitySafeOps[index];
        const detail = rejectAllDetails[index];
        if (op === undefined || detail === undefined) continue;
        console.warn(`[GUIDES]   ${index + 1}/${operations.length} op=${op.op} [${detail.guard}] ${detail.reason}`);
      }
    } else {
      for (const rejection of [...structuralGuard.rejected, ...attributeGuard.rejected]) {
        console.warn(`[GUIDES] 草案应用护栏丢弃 ${rejection.guard}：${rejection.reason}`);
      }
    }

    // applyOps 默认确认分流：敏感操作进 needsProposal 不执行，非敏感直接应用
    //（actor 用 ai_proposed：草案由 AI 提议；用户在前端点应用不代表已确认敏感项）
    const attributeApply =
      !rejectAll && regularAttributeOps.length > 0
        ? applyOps(intermediateTrip, regularAttributeOps, { confirmed: false, actor: "ai_proposed" })
        : null;
    // Task #248：整日替换的移回单独执行（在属性阶段之后，user_confirmed）：
    // 既保留护栏校验与阈值计数，也不影响其他敏感项的 needsProposal 分流。
    const replaceDetachApply =
      !rejectAll && replaceDetachOps.length > 0
        ? applyOps(attributeApply !== null ? attributeApply.trip : intermediateTrip, replaceDetachOps, {
            confirmed: true,
            actor: "user_confirmed",
          })
        : null;
    // 合并两阶段执行结果；整批拒绝时弃用全部中间产物（trip 原样、applied / rejected 清空）
    const result: ApplyResult = rejectAll
      ? { trip, applied: [], rejected: [], needsProposal: [], consistencyErrors: [] }
      : {
          trip:
            replaceDetachApply !== null
              ? replaceDetachApply.trip
              : attributeApply !== null
                ? attributeApply.trip
                : intermediateTrip,
          applied: [
            ...(structuralApply?.applied ?? []),
            ...(attributeApply?.applied ?? []),
            ...(replaceDetachApply?.applied ?? []),
          ],
          rejected: [
            ...(structuralApply?.rejected ?? []),
            ...(attributeApply?.rejected ?? []),
            ...(replaceDetachApply?.rejected ?? []),
          ],
          needsProposal: [
            ...(structuralApply?.needsProposal ?? []),
            ...(attributeApply?.needsProposal ?? []),
            ...(replaceDetachApply?.needsProposal ?? []),
          ],
          consistencyErrors: [
            ...(structuralApply?.consistencyErrors ?? []),
            ...(attributeApply?.consistencyErrors ?? []),
            ...(replaceDetachApply?.consistencyErrors ?? []),
          ],
        };
    if (rejectAll) {
      // 整批拒绝：全部操作以 threshold 占位原因并入 rejected（与 checkGuards 旧形态一致）
      for (const op of capacitySafeOps) {
        result.rejected.push({ op, reason: `[threshold] ${THRESHOLD_BATCH_REASON}` });
      }
    } else {
      // 护栏拒绝项并入 rejected（形状对齐 ApplyResult，前端逐条提示）
      for (const rejection of [...structuralGuard.rejected, ...attributeGuard.rejected]) {
        result.rejected.push({ op: rejection.op, reason: `[${rejection.guard}] ${rejection.reason}` });
      }
    }
    // Task #325：容量前置剥离项并入 rejected（reason 已含 [容量] 前缀与距离数值，直接推入；
    // 无论是否整批拒绝都可见，且不进 30% 阈值分子分母）
    for (const item of capacityRejections) {
      result.rejected.push({ op: item.op, reason: item.reason });
    }

    // Task #123：选中冲突部分应用——仅选中的冲突 resolution 以 user_confirmed 执行
    //（G3 对 move/transfer 放行、remove 红线不变；四条护栏在本批已随基础操作执行，
    // 冲突 resolution 逐条 applyOps 时同样重过护栏与一致性校验；选择结果已在上方算好）
    const appliedConflictIds: string[] = [];
    for (const conflict of selectedConflicts) {
      const resolution = conflict.resolution;
      if (resolution === null) continue; // 类型已过滤，防御
      const conflictResult = applyOps(result.trip, [resolution], { confirmed: true, actor: "user_confirmed" });
      // applyOps 是纯函数：把执行后的行程与成功项赋回 result，否则冲突调整会被丢弃
      //（consistencyErrors 非空时 shared 已整批回滚，conflictResult.trip 与入参逐字段一致，赋回安全）
      result.trip = conflictResult.trip;
      result.applied.push(...conflictResult.applied);
      for (const rejection of conflictResult.rejected) result.rejected.push(rejection);
      for (const proposal of conflictResult.needsProposal) result.needsProposal.push(proposal);
      for (const error of conflictResult.consistencyErrors) result.consistencyErrors.push(error);
      if (conflictResult.applied.length > 0) appliedConflictIds.push(conflict.conflictId);
      if (conflictResult.rejected.length > 0) {
        console.warn(
          `[GUIDES] 冲突 ${conflict.conflictId}（${conflict.kind}）resolution 执行被拒：${conflictResult.rejected.map((entry) => entry.reason).join("；")}`,
        );
      }
    }

    // 一致性校验失败（shared 已整批回滚）：不落盘并显式报错
    if (result.consistencyErrors.length > 0) {
      console.error(`[GUIDES] 草案应用后一致性校验失败，已整批回滚：${result.consistencyErrors.join("；")}`);
      throw new AiError("DRAFT_MISMATCH", "草案与当前行程冲突，应用已整批回滚，行程未修改，请重新生成草案");
    }

    const { count: attachedSnippetCount, entities: snippetTargets } = attachDraftSnippets(
      result.trip,
      draft.output.snippets,
    );
    // Task #212：挂载后对触碰实体做一次引用级去重收尾（同源同提及只留一条；
    // 纯函数幂等，顺带清理该实体上既有的存量重复，防止重复应用草案继续累积）
    for (const entity of snippetTargets) {
      if ("visitRef" in entity) deduplicateStopSnippets(entity, result.trip);
      else deduplicateSnippets(entity, result.trip);
    }
    // Task #190：实用参考选项组挂载（非行程结构变更，不参与护栏；历史草案无字段为空数组）
    const attachedOptionGroupCount = attachDraftOptionGroups(result.trip, draft.output.optionGroups ?? []);
    // Task #312：高置信度子玩法自动采纳——后台装配对 in_attraction 子玩法一律
    // suppressAttach:true（service.ts 设计如此，不改），子 Stop 落成 pending、父 Visit 的
    // childStopRefs 为空，前端 VisitCard 只渲染 childStopRefs 故大景区父卡下的岛内玩法全空白。
    // 这里在草案应用链路补上运行时自动采纳环节：level=high && decidedBy≠user 的 pending
    // stops 落 attached（复用 fix-task225 抽出的纯函数，幂等——已 attached / 用户已表态天然跳过）。
    // 采纳改变父 Visit 的 effectiveMinutes（子玩法汇总），对受影响的天去重后逐个重算时间轴。
    const childAdoptions = adoptHighConfidenceChildStops(result.trip);
    if (childAdoptions.length > 0) {
      const adoptedStopCount = childAdoptions.reduce((sum, item) => sum + item.stopRefs.length, 0);
      const affectedDayIndexes = [
        ...new Set(
          childAdoptions
            .map((item) => item.dayIndex)
            .filter((dayIndex): dayIndex is number => dayIndex !== null),
        ),
      ].sort((a, b) => a - b);
      for (const dayIndex of affectedDayIndexes) {
        result.trip = recomputeDayTimeline(result.trip, dayIndex);
      }
      console.log(
        `[GUIDES] 草案 ${draft.draftId} 自动采纳 ${adoptedStopCount} 个高置信度子玩法` +
          `（${childAdoptions.length} 个大景区），重算 ${affectedDayIndexes.length} 天时间轴`,
      );
    }
    // Task #283 / C4：AI 补充项打标——本轮新排入、非攻略证据支撑的点位标 provenance=ai_supplement。
    // 在 snippets / optionGroups 挂载之后执行，isVisitGuideBacked 才能看到本轮挂载的攻略亮点。
    // 护栏：无真实飞猪 POI（isRealFliggyPoi=false）者降级不打标；落盘前再以
    // validateAiSupplementProvenance 兜底核验，违规则清标，保证落盘的 ai_supplement 恒已飞猪核验。
    const supplementMark = markAiSupplementProvenance(trip, result.trip);
    if (supplementMark.marked.length > 0) {
      console.log(
        `[GUIDES] 草案 ${draft.draftId} AI 补充打标：${supplementMark.marked.length} 项 provenance=ai_supplement（已飞猪核验）`,
      );
    }
    if (supplementMark.downgraded.length > 0) {
      console.warn(
        `[GUIDES] 草案 ${draft.draftId} AI 补充降级：${supplementMark.downgraded.length} 项无真实飞猪 POI，未标 ai_supplement（复用 #229 伪 POI 护栏）`,
      );
    }
    const supplementViolations = validateAiSupplementProvenance(result.trip);
    if (supplementViolations.length > 0) {
      // 防御性兜底：打标逻辑已保证不产生违规，此处一旦命中说明数据异常，清标拒绝落盘 ai_supplement
      for (const itemId of supplementViolations) {
        const item = result.trip.itemRegistry?.[itemId];
        if (item !== undefined) delete item.provenance;
      }
      console.warn(
        `[GUIDES] 草案 ${draft.draftId} ai_supplement 不变量兜底：${supplementViolations.length} 项无真实飞猪 POI，已清除补充标`,
      );
    }
    delete result.trip.pendingGuideDraft;

    // 拒绝可见性：applied=0 且 rejected>0 时不得暗示「无需变更」，必须明确标出被拒绝
    const rejectedCount = result.rejected.length;
    // 整批拒绝用两阶段校验的逐条明细；常规拒绝从最终 rejected 条目还原（含执行器自拒）
    const rejectionDetails =
      rejectAll ? rejectAllDetails : result.rejected.map((rejection) => parseRejectionReason(rejection.reason));
    const rejectSummary = summarizeRejectionDetails(rejectionDetails);
    const allRejected = rejectedCount > 0 && result.applied.length === 0;

    // 草案消费必须持久化（Task #105）：即使 applied=0 且无提示挂载（全拒绝 / 零操作），
    // 删除 pendingGuideDraft 本身也是状态变更；不保存会让同一草案重复应用、
    // 前端也拿不到新的 Trip.version。
    await tripStore.save(result.trip);
    const savedTripVersion = result.trip.version;

    const needsProposal = [...result.needsProposal];
    const type: GuideDraftApplyResult["type"] = needsProposal.length > 0 ? "proposal" : "applied";
    // Task #123：按应用后的真实行程重算指令满足状态（pending 收敛为三态）；
    // Task #253：把本次因未确认 / 未落地而跳过的整日替换原因传入，满足说明不得报 met
    const requirementChecks = computeRequirementChecksFromTrip(
      result.trip,
      draft.directives ?? [],
      replaceSkippedDays,
    );
    const requirementSummary = summarizeRequirementChecks(requirementChecks);
    const autoClassifications = buildAutoClassifications(result.trip, draft.output.operations);
    // Task #250：应用结果解释——只统计实际执行的操作（护栏拒绝 / 未选冲突不计入）。
    // 不传 snippets / directives：这里要说的是「真正发生了什么」，而不是预案。
    const appliedSummary =
      result.applied.length > 0
        ? summarizeAppliedExplanation(buildDraftExplanation({ trip, operations: result.applied }))
        : null;
    const message =
      buildApplyMessage({
        type,
        appliedCount: result.applied.length,
        rejectedCount,
        allRejected,
        rejectSummary,
        attachedSnippetCount,
        attachedOptionGroupCount,
        proposalCount: needsProposal.length,
        requirementSummary,
        unselectedConflictCount: unselectedConflicts.length,
      }) + (appliedSummary !== null ? `。${appliedSummary}` : "");

    console.log(
      `[GUIDES] 草案 ${draft.draftId} 应用完成：applied=${result.applied.length} rejected=${rejectedCount} proposal=${needsProposal.length} snippets=${attachedSnippetCount} optionGroups=${attachedOptionGroupCount}` +
        ` conflicts=${appliedConflictIds.length}/${(draft.conflicts ?? []).length} 未选=${unselectedConflicts.length}` +
        (rejectSummary !== null ? `；拒绝原因：${rejectSummary}` : "") +
        (requirementSummary !== null ? `；指令：${requirementSummary}` : ""),
    );
    return {
      type,
      tripVersion: savedTripVersion,
      draftId: draft.draftId,
      applied: result.applied,
      rejected: result.rejected,
      rejectedCount,
      rejectSummary,
      allRejected,
      needsProposal,
      attachedSnippetCount,
      attachedOptionGroupCount,
      requirementChecks,
      autoClassifications,
      appliedConflictIds,
      unselectedConflicts,
      requirementSummary,
      appliedSummary,
      message,
    };
  });
}
