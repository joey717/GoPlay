/**
 * B3 多篇攻略 mentions 合并（Task #97，修订附录 B §2.3「合并排版」素材侧）。
 *
 * 输入输出：
 * - 读取 Trip 可用来源（Task #161 起区分模式：全部模式 = 可用且非暂存来源，
 *   局部模式 = 显式选中来源），按导入顺序收集各来源 mentionRefs 并解析为具体提及；
 * - 地点去重：providerId 命中优先（p: 前缀，飞猪主数据是地点的稳定身份）；
 *   未命中退归一化名称（n: 前缀，规范化去括号内容 + 小写 + 显式别名解析）；
 *   两者都不可得时按单条提及独立成条（u: 前缀）；
 * - 同一细节保留多来源证据：每条 mention 原样保留（quoteText / modelSummary /
 *   claimKind 不改写、不合并文案），冲突内容在同一地点下并列，不在合并阶段裁决。
 *
 * 提及 → 行程实体对齐（附录 B「素材归属」）：
 * - 扫描全部 Visit / Stop 的 sourceMentionRefs 建「引用 → 实体」索引；
 *   B2 装配（attach / suppressAttach）已把高置信玩法写入该字段，
 *   待定（pending）Stop 同样参与对齐——scope 不改变素材归属；
 * - 未对齐的提及用 extractedName 归一化聚合到同名地点；连名称都没有时独立成条。
 *
 * 边界：
 * - 不做 scope 过滤：DraftScope 只限制输出（planner 侧指令），全部可用素材始终合并；
 * - 悬空 mentionRefs（证据 / 提及已不存在）静默跳过，由
 *   checkPendingGuideDraftFreshness 的 mention_ref_missing 在草案侧报告；
 * - 纯函数只读：不写 Trip、不触网、不依赖锁。
 */

import type {
  EntityRef,
  EvidenceMention,
  GuideSourceVersionSnapshot,
  Trip,
} from "@goplay/shared";
import {
  canonicalPoiMatchKey,
  isGuideSourceUsable,
  isGuideSourceUsableForFullMerge,
  resolveMentionRef,
} from "@goplay/shared";

// ===== 合并结果类型 =====

/** 合并后的单条提及：保留精确引用与原文，绝不在合并阶段改写内容 */
export interface MergedMention {
  /** 精确引用 "evidenceId:mentionId"（与 Visit/Stop.sourceMentionRefs 同构） */
  ref: string;
  /** 提及所属来源（guideSources 的 key） */
  sourceId: string;
  evidenceId: string;
  mentionId: string;
  /** 原始提及（quoteText / modelSummary / claimKind 按证据保存，不合并改写） */
  mention: EvidenceMention;
}

/** 对齐到的行程实体：仅 visit / stop（由 buildMentionEntityIndex 产出，无其他 kind） */
type MergedPlaceEntityRef = Extract<EntityRef, { kind: "visit" } | { kind: "stop" }>;

/** 去重后的地点：同一地点的多来源提及按顺序并列 */
export interface MergedPlace {
  /** 去重 key：p:{providerId} | n:{归一化名称} | u:{首条提及引用} */
  key: string;
  /** 展示名：对齐实体名 > extractedName > 首条提及文本截断 */
  displayName: string;
  /** 对齐到的行程实体（visit / stop）；该地点全部提及均未对齐时为 null */
  entityRef: MergedPlaceEntityRef | null;
  /** 对齐实体的飞猪 providerId（custom 点位 / 未对齐为 null，不伪造） */
  providerId: string | null;
  /** 该地点下的全部提及（按来源导入顺序；冲突内容并列不裁决） */
  mentions: MergedMention[];
}

/** mergeGuideMentions 的输出：planner prompt 与草案输入快照的直接数据源 */
export interface GuideMergeResult {
  /** 参与合并的可用来源版本快照（草案 sourceSnapshots 直接使用，已按导入顺序） */
  sourceSnapshots: GuideSourceVersionSnapshot[];
  /** 合并后的全部提及（按来源导入顺序） */
  mentions: MergedMention[];
  /** 去重地点清单（按首次出现顺序） */
  places: MergedPlace[];
  /** 提及 id 去重集合（草案 mentionIds；存量 mentionId 仅证据内唯一） */
  mentionIds: string[];
  /** 全部精确引用去重集合（草案 mentionRefs） */
  mentionRefs: string[];
}

// ===== 提及 → 实体对齐索引 =====

/**
 * 建「mentionRef → EntityRef」索引：visit 优先写入（大景区整体提及），
 * stop 不覆盖同引用的 visit 条目（先到先得，保持首个——通常是 attach 时的主归属）。
 */
function buildMentionEntityIndex(trip: Trip): Map<string, MergedPlaceEntityRef> {
  const index = new Map<string, MergedPlaceEntityRef>();
  for (const visit of Object.values(trip.visits ?? {})) {
    const refs = Array.isArray(visit.sourceMentionRefs) ? visit.sourceMentionRefs : [];
    for (const ref of refs) {
      if (!index.has(ref)) index.set(ref, { kind: "visit", id: visit.visitId });
    }
  }
  for (const stop of Object.values(trip.stops ?? {})) {
    const refs = Array.isArray(stop.sourceMentionRefs) ? stop.sourceMentionRefs : [];
    for (const ref of refs) {
      if (!index.has(ref)) index.set(ref, { kind: "stop", id: stop.stopId });
    }
  }
  return index;
}

// ===== 地点身份推导 =====

interface PlaceIdentity {
  key: string;
  displayName: string;
  providerId: string | null;
}

/**
 * 归一化名称 key：去括号内容 / 空白 / 已知城市前缀 + 小写，并把显式别名解析为正式名
 * （Task #233：简称「亚龙湾森林公园」与官方名「亚龙湾热带天堂森林公园」归为同一地点，
 * 避免多篇攻略将同一景点裂成两条）。
 */
function nameKey(rawName: string): string {
  return `n:${canonicalPoiMatchKey(rawName)}`;
}

/**
 * 推导对齐提及的地点身份（去重 key + 展示名 + providerId）：
 * - 对齐 visit：item.providerId 命中 → p:；否则按 item 名称归一化 → n:；
 * - 对齐 stop：matchedPointRef 命中主数据同上；custom 点位按 customName → n:。
 * 未对齐提及的身份在 mergeGuideMentions 主体内处理（需查名称索引并入既有地点）。
 */
function derivePlaceIdentity(trip: Trip, entityRef: MergedPlaceEntityRef): PlaceIdentity {
  if (entityRef.kind === "visit") {
    const visit = trip.visits?.[entityRef.id];
    const item = visit !== undefined ? trip.itemRegistry?.[visit.pointRef] : undefined;
    const providerId = typeof item?.providerId === "string" && item.providerId !== "" ? item.providerId : null;
    const name = item?.name ?? visit?.pointRef ?? entityRef.id;
    return {
      key: providerId !== null ? `p:${providerId}` : nameKey(name),
      displayName: name,
      providerId,
    };
  }
  const stop = trip.stops?.[entityRef.id];
  const item =
    stop?.matchedPointRef !== null && stop?.matchedPointRef !== undefined
      ? trip.itemRegistry?.[stop.matchedPointRef]
      : undefined;
  const providerId = typeof item?.providerId === "string" && item.providerId !== "" ? item.providerId : null;
  const name = item?.name ?? stop?.customName ?? entityRef.id;
  return {
    key: providerId !== null ? `p:${providerId}` : nameKey(name),
    displayName: name,
    providerId,
  };
}

// ===== 合并入口 =====

/** 收集阶段的中间条目：提及 + 对齐实体（实体可能为 null） */
interface CollectedEntry {
  sourceId: string;
  ref: string;
  evidenceId: string;
  mentionId: string;
  mention: EvidenceMention;
  entityRef: MergedPlaceEntityRef | null;
}

function toMergedMention(entry: CollectedEntry): MergedMention {
  return {
    ref: entry.ref,
    sourceId: entry.sourceId,
    evidenceId: entry.evidenceId,
    mentionId: entry.mentionId,
    mention: entry.mention,
  };
}

/**
 * mergeGuideMentions 来源筛选选项（Task #161）。
 * - selectedSourceIds 提供（局部模式 sourceMode="selected"）：仅选中来源参与合并，
 *   允许暂存来源（staged）；可用性仍要求 active + ready/partial + 至少一条可读证据；
 * - 缺省（全部模式）：全部可用且非暂存来源（isGuideSourceUsableForFullMerge）。
 *   历史数据无 staged 字段（缺省非暂存）→ 与既有全部合并语义逐字节一致。
 */
export interface MergeGuideMentionsOptions {
  selectedSourceIds?: ReadonlySet<string>;
}

/**
 * 合并 Trip 可用来源的 mentions（Task #97；Task #161 增加来源模式）。
 * 来源筛选：局部模式仅选中来源（可用性仍复用 isGuideSourceUsable）；全部模式
 * 复用 isGuideSourceUsableForFullMerge（active + ready/partial + 可读证据 + 非暂存）。
 * 来源按 importedAt → sourceId 稳定排序，保证同输入下合并结果确定。
 *
 * 两遍扫描（地点身份归一）:
 * - 第一遍处理对齐提及：providerId 优先定 p:/n: key，并把展示名登记进名称索引；
 * - 第二遍处理未对齐提及：extractedName 归一化后先查名称索引——命中则并入既有地点
 *   （解决「一条对齐 + 一条未对齐」同地点分裂），未命中 n: 新条目，无名称 u: 独立成条。
 */
export function mergeGuideMentions(trip: Trip, options?: MergeGuideMentionsOptions): GuideMergeResult {
  const selected = options?.selectedSourceIds;
  const usable = Object.values(trip.guideSources ?? {})
    .filter((source) => {
      if (source === null || typeof source !== "object") return false;
      if (selected !== undefined) {
        return selected.has(source.sourceId) && isGuideSourceUsable(trip, source);
      }
      return isGuideSourceUsableForFullMerge(trip, source);
    })
    .sort((left, right) => {
      if (left.importedAt !== right.importedAt) return left.importedAt < right.importedAt ? -1 : 1;
      return left.sourceId < right.sourceId ? -1 : 1;
    });

  const sourceSnapshots: GuideSourceVersionSnapshot[] = usable.map((source) => ({
    sourceId: source.sourceId,
    sourceVersion: source.sourceVersion,
  }));

  const entityByRef = buildMentionEntityIndex(trip);

  // 统一收集（保持来源顺序）；悬空引用静默跳过（草案侧按 mention_ref_missing 报告）
  const entries: CollectedEntry[] = [];
  for (const source of usable) {
    const refs = Array.isArray(source.mentionRefs) ? source.mentionRefs : [];
    for (const ref of refs) {
      const resolved = resolveMentionRef(trip, ref);
      if (resolved === null) continue;
      entries.push({
        sourceId: source.sourceId,
        ref,
        evidenceId: resolved.evidenceId,
        mentionId: resolved.mentionId,
        mention: resolved.mention,
        entityRef: entityByRef.get(ref) ?? null,
      });
    }
  }

  const places = new Map<string, MergedPlace>();
  const nameIndex = new Map<string, string>(); // 归一化名称 → 地点 key（先到先得）

  const pushMention = (key: string, entry: CollectedEntry): void => {
    places.get(key)?.mentions.push(toMergedMention(entry));
  };
  const ensurePlace = (
    key: string,
    displayName: string,
    entityRef: MergedPlaceEntityRef | null,
    providerId: string | null,
  ): void => {
    if (!places.has(key)) {
      places.set(key, { key, displayName, entityRef, providerId, mentions: [] });
    }
  };

  // 第一遍：对齐组（身份由实体主数据决定，展示名登记进名称索引）
  const unalignedEntries: CollectedEntry[] = [];
  for (const entry of entries) {
    if (entry.entityRef === null) {
      unalignedEntries.push(entry);
      continue;
    }
    const identity = derivePlaceIdentity(trip, entry.entityRef);
    ensurePlace(identity.key, identity.displayName, entry.entityRef, identity.providerId);
    const normalized = canonicalPoiMatchKey(identity.displayName);
    if (normalized !== "" && !nameIndex.has(normalized)) nameIndex.set(normalized, identity.key);
    pushMention(identity.key, entry);
  }

  // 第二遍：未对齐组（extractedName 并入既有地点；未命中 n: 新条目；无名称 u: 独立）
  for (const entry of unalignedEntries) {
    const mention = entry.mention;
    const extracted =
      typeof mention.extractedName === "string" && mention.extractedName.trim() !== ""
        ? mention.extractedName.trim()
        : null;
    if (extracted !== null) {
      const normalized = canonicalPoiMatchKey(extracted);
      const hit = normalized !== "" ? nameIndex.get(normalized) : undefined;
      if (hit !== undefined) {
        pushMention(hit, entry);
        continue;
      }
      const key = `n:${normalized}`;
      ensurePlace(key, extracted, null, null);
      if (normalized !== "" && !nameIndex.has(normalized)) nameIndex.set(normalized, key);
      pushMention(key, entry);
      continue;
    }
    const fallback = mention.text !== "" ? mention.text : mention.quoteText;
    const key = `u:${entry.mentionId}`;
    ensurePlace(key, [...fallback].slice(0, 30).join(""), null, null);
    pushMention(key, entry);
  }

  const mentions = entries.map(toMergedMention);
  return {
    sourceSnapshots,
    mentions,
    places: [...places.values()],
    mentionIds: [...new Set(mentions.map((entry) => entry.mentionId))],
    mentionRefs: [...new Set(entries.map((entry) => entry.ref))],
  };
}
