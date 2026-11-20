/**
 * 攻略包纯函数（修订附录 B v0.3，B1）—— 去重、mention 寻址与草案快照过期判断。
 *
 * 边界（B1 明确非目标）：
 * - 不做链接展开 / 抓取 / OCR / 抽取，URL 短链解析仍在服务端；
 * - 不生成 contentHash（服务端按正文 / OCR 文本计算），本模块只定义比较语义；
 * - 不写 Trip，不依赖 fs / crypto，可被 web 与 server 以同一份源码消费。
 *
 * 去重语义（附录 B §3.1）：规范化 URL 相同或内容 hash 相同即视为同一篇。
 * 已移除来源（active=false）仍参与命中，调用方可复用缓存并恢复 active，不重复抓取 / 计数。
 */

import type {
  EvidenceMention,
  GuideImageProgress,
  GuideSource,
  PendingGuideDraft,
  SourceEvidence,
  Trip,
} from "../types/index.js";

// 实用参考选项组（Task #190）：成组校验 / 清洗 / 去重合并 / 最低价纯函数
export * from "./optionGroups.js";

// 正文页码配图（Task #196）：页码提取与「页码 → 原图路径」确定性解析纯函数
export * from "./pageImages.js";

// 亮点 snippets 与原文引用去重（Task #212）：相似判定 / 实体存量清洗纯函数
export * from "./dedupeSnippets.js";

// Task #282：稀疏攻略覆盖估算（C1/C2/C3 参赛必须）——缺口判定 / C2 抑制纯函数
export * from "./coverageEstimate.js";

// Task #304：小红书链接识别与归一化（无 scheme 粘贴补 https://）——web 分流与 server 校验共用口径
export * from "./xhsLink.js";

/** 攻略提示硬上限（附录 B §3.3）：超过 40 字符即视为契约违规，展示截断不得回写 */
export const GUIDE_SNIPPET_MAX_CHARS = 40;

/** 攻略提示建议长度（只作生成侧提示，不作为校验失败条件） */
export const GUIDE_SNIPPET_RECOMMENDED_MAX_CHARS = 28;

/** 单条攻略提示可引用的原文提及上限（MVP 最多 3 条） */
export const GUIDE_SNIPPET_MAX_MENTION_REFS = 3;

/** 攻略提示展示上限（每实体最多两条；属于展示规则，不阻止存储更多） */
export const GUIDE_SNIPPET_DISPLAY_LIMIT = 2;

/** 小红书分享 / 埋点参数：变化不得制造新来源，规范化时剔除 */
const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  "xsec_token",
  "xsec_source",
  "share_id",
  "share_token",
  "share_from_user_hidden",
  "share_channel",
  "appuid",
  "apptime",
  "author_share",
  "spm",
]);

/** 纯文字来源 / 尚未提交图片时的空进度（total=0，images=[]） */
export function createEmptyGuideImageProgress(): GuideImageProgress {
  return { total: 0, completed: 0, failed: 0, images: [] };
}

/**
 * 规范化 URL（纯函数；短链展开仍由服务端完成）：
 * - 去除首尾空白与 fragment；
 * - protocol / hostname 小写（URL 解析器同时移除默认端口）；
 * - 剔除 utm_* 与小书分享参数，剩余查询参数按键名排序，保证同源不同分享参数稳定相等；
 * - 非根路径去掉末尾斜杠。
 *
 * 非法 URL 不猜测改写：返回 trim 后的原串，交由上层报告失败。
 */
export function normalizeCanonicalUrl(rawUrl: string): string {
  if (typeof rawUrl !== "string") return "";
  const trimmed = rawUrl.trim();
  if (trimmed === "") return "";

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }

  url.hash = "";
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();

  const kept = [...url.searchParams.entries()]
    .filter(([key]) => {
      const lower = key.toLowerCase();
      return !lower.startsWith("utm_") && !TRACKING_PARAMS.has(lower);
    })
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
      return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
    });

  url.search = "";
  for (const [key, value] of kept) url.searchParams.append(key, value);

  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString();
}

/** 内容 hash 归一（服务端输出通常为 hex；大小写与首尾空白不应制造重复） */
function normalizeContentHash(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "" ? null : normalized;
}

/** 去重比对候选：链接来源、纯文字来源、图片组来源各自至少提供一个身份字段 */
export interface GuideSourceIdentity {
  sourceUrl?: string | null;
  canonicalUrl?: string | null;
  contentHash?: string | null;
}

/** 候选的全部可比较规范化 URL（canonicalUrl 优先，sourceUrl 兜底；两者都收集） */
function canonicalKeys(identity: GuideSourceIdentity): Set<string> {
  const keys = new Set<string>();
  for (const value of [identity.canonicalUrl, identity.sourceUrl]) {
    if (typeof value !== "string") continue;
    const normalized = normalizeCanonicalUrl(value);
    if (normalized !== "") keys.add(normalized);
  }
  return keys;
}

/**
 * 判断候选是否命中已有来源（附录 B §3.1）：
 * - canonicalUrl / sourceUrl 规范化后相同；或 contentHash 相同（大小写不敏感）；
 * - 包含 active=false 的已移除来源（复用缓存，由调用方恢复 active）；
 * - 无任何身份字段时返回 null（不把空候选误判为重复）；
 * - 命中多条时按 importedAt、sourceId 稳定排序返回最早一条，保证结果确定。
 */
export function findDuplicateGuideSource(
  sources: Record<string, GuideSource> | null | undefined,
  candidate: GuideSourceIdentity,
): GuideSource | null {
  if (sources === null || sources === undefined) return null;
  const candidateKeys = canonicalKeys(candidate);
  const candidateHash = normalizeContentHash(candidate.contentHash);
  if (candidateKeys.size === 0 && candidateHash === null) return null;

  const ordered = Object.values(sources)
    .filter((source): source is GuideSource => source !== null && typeof source === "object")
    .sort((left, right) => {
      const leftTime = typeof left.importedAt === "string" ? left.importedAt : "";
      const rightTime = typeof right.importedAt === "string" ? right.importedAt : "";
      if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
      return left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0;
    });

  for (const source of ordered) {
    if (candidateHash !== null && normalizeContentHash(source.contentHash) === candidateHash) {
      return source;
    }
    const sourceKeys = canonicalKeys(source);
    for (const key of candidateKeys) {
      if (sourceKeys.has(key)) return source;
    }
  }
  return null;
}

/** 已解析的 mention 引用："evidenceId:mentionId" → 证据与提及实体 */
export interface ResolvedMentionRef {
  ref: string;
  evidenceId: string;
  mentionId: string;
  evidence: SourceEvidence;
  mention: EvidenceMention;
}

/**
 * 解析 "evidenceId:mentionId"（与 Visit/Stop.sourceMentionRefs 同构）。
 * 空串 / 缺分隔符 / 分隔符在首尾 → null，不猜测修复。
 */
export function parseMentionRef(ref: string): { evidenceId: string; mentionId: string } | null {
  if (typeof ref !== "string") return null;
  const separator = ref.indexOf(":");
  if (separator <= 0 || separator === ref.length - 1) return null;
  return { evidenceId: ref.slice(0, separator), mentionId: ref.slice(separator + 1) };
}

/** 拼装 "evidenceId:mentionId"；调用方保证两段非空 */
export function formatMentionRef(evidenceId: string, mentionId: string): string {
  return `${evidenceId}:${mentionId}`;
}

/** 精确解析引用：证据或提及任一不存在返回 null */
export function resolveMentionRef(trip: Trip, ref: string): ResolvedMentionRef | null {
  const parsed = parseMentionRef(ref);
  if (parsed === null) return null;
  const evidence = trip.evidences?.[parsed.evidenceId];
  if (evidence === undefined || evidence === null) return null;
  const mentions = Array.isArray(evidence.mentions) ? evidence.mentions : [];
  const mention = mentions.find((entry) => entry.mentionId === parsed.mentionId);
  if (mention === undefined) return null;
  return {
    ref,
    evidenceId: parsed.evidenceId,
    mentionId: parsed.mentionId,
    evidence,
    mention,
  };
}

/**
 * 按 mentionId 在全部证据中查找（存量 mentionId 仅在单条证据内唯一，
 * 因此可能返回多个结果；草案快照的 mentionIds 校验使用本函数）。
 */
export function findMentionsById(trip: Trip, mentionId: string): ResolvedMentionRef[] {
  const resolved: ResolvedMentionRef[] = [];
  if (typeof mentionId !== "string" || mentionId === "") return resolved;
  for (const [evidenceId, evidence] of Object.entries(trip.evidences ?? {})) {
    if (evidence === null || typeof evidence !== "object") continue;
    const mentions = Array.isArray(evidence.mentions) ? evidence.mentions : [];
    for (const mention of mentions) {
      if (mention?.mentionId === mentionId) {
        resolved.push({
          ref: formatMentionRef(evidenceId, mentionId),
          evidenceId,
          mentionId,
          evidence,
          mention,
        });
      }
    }
  }
  return resolved;
}

/**
 * 来源是否至少有一条可读证据（正文 / OCR 文本 / 已抽取提及）。
 * ready 判定只要求「正文或可用证据」，不要求图片全部成功（附录 B §5）。
 */
export function hasUsableGuideEvidence(trip: Trip, source: GuideSource): boolean {
  if (source === null || typeof source !== "object" || !Array.isArray(source.evidenceRefs)) return false;
  return source.evidenceRefs.some((evidenceId) => {
    const evidence = trip.evidences?.[evidenceId];
    if (evidence === undefined || evidence === null) return false;
    const ocrText = typeof evidence.ocrText === "string" ? evidence.ocrText.trim() : "";
    const mentions = Array.isArray(evidence.mentions) ? evidence.mentions : [];
    return ocrText !== "" || mentions.length > 0;
  });
}

/**
 * 可用来源（附录 B §2.2）：active 且 status 为 ready / partial 且至少一条可读证据。
 * processing（含正文已回、图片仍处理中）不进入 planner 的「可用篇数」，
 * 由 B2/B3 的覆盖判断单独处理「正文可用」提示。
 */
export function isGuideSourceUsable(trip: Trip, source: GuideSource): boolean {
  if (source === null || typeof source !== "object") return false;
  if (source.active !== true) return false;
  if (source.status !== "ready" && source.status !== "partial") return false;
  return hasUsableGuideEvidence(trip, source);
}

/**
 * 来源是否处于暂存状态（Task #161）：staged=true 的新增来源不参与默认（全部模式）
 * 草案合并与候选支撑，仅可被显式 selectedSourceIds 选中参与本轮局部优化。
 * 缺省 / false = 历史来源（非暂存）；与 active（软移除）正交。
 */
export function isGuideSourceStaged(source: GuideSource): boolean {
  if (source === null || typeof source !== "object") return false;
  return source.staged === true;
}

/**
 * 全部模式（默认规划「全部可用攻略整体重排」）可消费的来源（Task #161）：
 * isGuideSourceUsable 且非暂存。历史数据无 staged 字段（缺省非暂存），
 * 判定结果与 isGuideSourceUsable 完全一致——旧数据零迁移、默认行为不变。
 * 局部优化（selected 模式）不受此限制，暂存来源可被显式选中。
 */
export function isGuideSourceUsableForFullMerge(trip: Trip, source: GuideSource): boolean {
  return isGuideSourceUsable(trip, source) && !isGuideSourceStaged(source);
}

/** 草案过期原因：Trip 版本 / 来源缺失或移除 / 来源版本 / mention 快照 / 补充句 */
export type PendingGuideDraftStaleReason =
  | "trip_version_changed"
  | "source_missing"
  | "source_inactive"
  | "source_version_changed"
  | "mention_missing"
  | "mention_ref_missing"
  | "note_changed";

/** 草案新鲜度结果：fresh=false 时 reasons 去重、details 保留逐条可读原因 */
export interface PendingGuideDraftFreshness {
  fresh: boolean;
  reasons: PendingGuideDraftStaleReason[];
  details: string[];
}

/**
 * 判断 pendingGuideDraft 是否因 Trip version / sourceVersion / 来源移除 / 补充句变化而过期
 * （附录 B §2.4）。
 *
 * 纯函数、只读：版本过期属于「应用时拒绝并提示重新生成」，不得让历史 Trip 无法加载。
 * mentionIds 采用全证据查找（存量 mentionId 仅证据内唯一）；mentionRefs 若存在则精确校验。
 */
export function checkPendingGuideDraftFreshness(
  draft: PendingGuideDraft,
  trip: Trip,
): PendingGuideDraftFreshness {
  const reasons: PendingGuideDraftStaleReason[] = [];
  const details: string[] = [];

  if (draft.baseTripVersion !== trip.version) {
    reasons.push("trip_version_changed");
    details.push(`Trip.version 已由 ${draft.baseTripVersion} 变为 ${trip.version}`);
  }

  for (const snapshot of Array.isArray(draft.sourceSnapshots) ? draft.sourceSnapshots : []) {
    const source = trip.guideSources?.[snapshot.sourceId];
    if (source === undefined || source === null) {
      reasons.push("source_missing");
      details.push(`来源已不存在：${snapshot.sourceId}`);
      continue;
    }
    if (source.sourceVersion !== snapshot.sourceVersion) {
      reasons.push("source_version_changed");
      details.push(
        `来源版本已变化：${snapshot.sourceId}（快照 ${snapshot.sourceVersion} → 当前 ${source.sourceVersion}）`,
      );
    }
    if (source.active === false) {
      reasons.push("source_inactive");
      details.push(`来源已从当前行程移除：${snapshot.sourceId}`);
    }
  }

  for (const mentionId of Array.isArray(draft.mentionIds) ? draft.mentionIds : []) {
    if (findMentionsById(trip, mentionId).length === 0) {
      reasons.push("mention_missing");
      details.push(`mention 已不存在：${mentionId}`);
    }
  }

  for (const ref of Array.isArray(draft.mentionRefs) ? draft.mentionRefs : []) {
    if (resolveMentionRef(trip, ref) === null) {
      reasons.push("mention_ref_missing");
      details.push(`mention 引用无法解析：${ref}`);
    }
  }

  // 补充句属于草案输入快照：缺失与 null 都归一为空串，避免 undefined / null 抖动误判
  const draftNote = typeof draft.note === "string" ? draft.note : "";
  const currentNote = typeof trip.guideDraftNote === "string" ? trip.guideDraftNote : "";
  if (draftNote !== currentNote) {
    reasons.push("note_changed");
    details.push("攻略补充句已变化，需要重新生成草案");
  }

  const uniqueReasons = [...new Set(reasons)];
  return { fresh: uniqueReasons.length === 0, reasons: uniqueReasons, details };
}

/** 便捷包装：只要布尔结果时使用 */
export function isPendingGuideDraftStale(draft: PendingGuideDraft, trip: Trip): boolean {
  return !checkPendingGuideDraftFreshness(draft, trip).fresh;
}

// ===== 文字来源默认标题（Task #262） =====

/**
 * 文字来源默认标题的预览长度：取粘贴正文开头 20 个字符。
 * 服务端标题存储上限为 100 字符，20 字预览远低于该硬上限（加省略号仍不越界），
 * 目的只是让多篇粘贴攻略在列表里可区分，不追求容纳首段全文。
 */
export const GUIDE_SOURCE_TEXT_TITLE_CHARS = 20;

/** 文字来源默认标题兜底：正文全为空白时使用（正常情况下提交校验已拒绝空正文） */
export const GUIDE_SOURCE_TEXT_TITLE_FALLBACK = "粘贴的文字";

/**
 * 文字来源默认标题（Task #262）：粘贴多篇文字攻略时标题不再统一叫「粘贴的攻略文字」。
 *
 * 口径：
 * - 去首尾空白与换行，内部空白（含换行）压成单个空格，标题始终单行；
 * - 按码点截取前 maxChars 个字（emoji / 生僻字不会被截成半个）；
 * - 超出预览长度时末尾加「…」，截断点前的空白先去掉，避免出现「 …」；
 * - 正文全空白 → GUIDE_SOURCE_TEXT_TITLE_FALLBACK。
 *
 * 纯函数、只读、无副作用：只在新来源创建时调用，历史来源标题不回改。
 */
export function deriveTextSourceTitle(
  text: string,
  maxChars: number = GUIDE_SOURCE_TEXT_TITLE_CHARS,
): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized === "") return GUIDE_SOURCE_TEXT_TITLE_FALLBACK;
  const cap =
    Number.isFinite(maxChars) && maxChars >= 1
      ? Math.floor(maxChars)
      : GUIDE_SOURCE_TEXT_TITLE_CHARS;
  const points = Array.from(normalized);
  if (points.length <= cap) return normalized;
  return `${points.slice(0, cap).join("").trimEnd()}…`;
}
