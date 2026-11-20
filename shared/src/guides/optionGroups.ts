/**
 * 攻略实用参考选项组纯函数（Task #190）—— 成组校验、文本清洗、去重合并与最低参考价。
 *
 * 边界（与 guides/index.ts 同约定）：
 * - 不写 Trip、不依赖 fs / crypto、不触网，可被 web 与 server 以同一份源码消费；
 * - 字段清洗只做「截断与空值归一」，绝不从无证据内容补写业务字段（缺失保持 null）；
 * - 去重口径：主题归一化（去成对括号内容 + 空白，与 server normalizePoiName 同口径）
 *   相同且分类相同视为同一主题组，选项按 label 归一化去重后合并。
 */

import type {
  GuideOptionCategory,
  GuideOptionGroup,
  GuideOptionItem,
  PendingGuideDraftOptionGroup,
  PendingGuideDraftOptionItem,
} from "../types/index.js";

/** 单组选项数量上限：超过截断（防提示膨胀；生成侧 prompt 同口径声明） */
export const GUIDE_OPTION_GROUP_MAX_OPTIONS = 6;

/** 单实体（Visit）主题组数量上限：同上限语义防无界增长（与 SNIPPET_PER_ENTITY_LIMIT 同模式） */
export const GUIDE_OPTION_GROUP_MAX_PER_ENTITY = 4;

/** 单选项 / 单组证据引用上限（与 GUIDE_SNIPPET_MAX_MENTION_REFS 同口径） */
export const GUIDE_OPTION_MAX_MENTION_REFS = 3;

/** 分类展示名（前端直接渲染；server 日志复用） */
export const GUIDE_OPTION_CATEGORY_LABELS: Record<GuideOptionCategory, string> = {
  transport: "交通",
  ticket: "门票",
  rental: "租赁",
  activity: "玩法",
  dining: "餐饮",
  shuttle: "接驳",
  other: "参考",
};

/** 分类白名单集合（清洗用：白名单外兜底 other） */
const GUIDE_OPTION_CATEGORY_SET: ReadonlySet<string> = new Set([
  "transport",
  "ticket",
  "rental",
  "activity",
  "dining",
  "shuttle",
  "other",
]);

/** 文本字段截断上限：主题 / 选项名紧凑，描述字段留一行空间 */
export const GUIDE_OPTION_TOPIC_MAX_CHARS = 24;
export const GUIDE_OPTION_LABEL_MAX_CHARS = 20;
export const GUIDE_OPTION_TEXT_MAX_CHARS = 40;

/**
 * 选项名归一化（去重比对口径）：去成对括号及其内容、去全部空白；
 * 与 server normalizePoiName / web normalizeEvidenceName 同口径（小写在调用侧补）。
 */
export function normalizeOptionLabelKey(label: string): string {
  return label
    .replace(/[（(【\[{][^）)】\]}]*[）)】\]}]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

/**
 * 可空文本清洗：非字符串 / trim 后空串 → null；否则 trim 后按 maxChars 截断
 * （按 Unicode 码点截断，避免代理对破坏）。绝不臆造默认值。
 */
export function normalizeOptionalText(raw: unknown, maxChars: number): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return [...trimmed].slice(0, maxChars).join("");
}

/** 分类清洗：白名单内原样；其余兜底 other（不抛错、不臆造新分类） */
export function normalizeOptionCategory(raw: unknown): GuideOptionCategory {
  return typeof raw === "string" && GUIDE_OPTION_CATEGORY_SET.has(raw)
    ? (raw as GuideOptionCategory)
    : "other";
}

/** 可议价清洗：仅接受显式 boolean；字符串 "true"/"false" 等一律按未提（null） */
export function normalizeOptionBargain(raw: unknown): boolean | null {
  return typeof raw === "boolean" ? raw : null;
}

/**
 * 从价格文本提取首个数字（如 "50元/圈" → 50、"¥120/人" → 120）；
 * 无数字返回 null（「价格面议」等非数字表述不猜）。用于最低参考价摘要。
 */
export function optionPriceNumber(priceText: string): number | null {
  const matched = priceText.match(/\d+(?:\.\d+)?/);
  if (matched === null) return null;
  const value = Number.parseFloat(matched[0]);
  return Number.isFinite(value) ? value : null;
}

/** 组内最低参考价：可解析价格的选项取最小值；全部不可解析（或无价格）→ null */
export function guideOptionGroupMinPrice(
  group: Pick<GuideOptionGroup, "options"> | Pick<PendingGuideDraftOptionGroup, "options">,
): number | null {
  let min: number | null = null;
  for (const option of Array.isArray(group.options) ? group.options : []) {
    if (typeof option.priceText !== "string" || option.priceText === "") continue;
    const value = optionPriceNumber(option.priceText);
    if (value === null) continue;
    if (min === null || value < min) min = value;
  }
  return min;
}

/**
 * 选项清洗（生成侧唯一入口）：label 非空且截断；可空字段按 normalizeOptionalText；
 * 证据引用去重 + 过滤合法形状（含 ":" 且两端非空）+ 截断到上限。
 */
export function normalizeGuideOptionItem(raw: {
  label: unknown;
  priceText: unknown;
  routeText: unknown;
  sceneText: unknown;
  bargain: unknown;
  noteText: unknown;
  sourceMentionRefs: unknown;
}): PendingGuideDraftOptionItem | null {
  const label = normalizeOptionalText(raw.label, GUIDE_OPTION_LABEL_MAX_CHARS);
  if (label === null) return null;
  const refs: string[] = [];
  if (Array.isArray(raw.sourceMentionRefs)) {
    for (const ref of raw.sourceMentionRefs) {
      if (typeof ref !== "string") continue;
      const separator = ref.indexOf(":");
      if (separator <= 0 || separator === ref.length - 1) continue;
      if (!refs.includes(ref)) refs.push(ref);
      if (refs.length >= GUIDE_OPTION_MAX_MENTION_REFS) break;
    }
  }
  return {
    label,
    priceText: normalizeOptionalText(raw.priceText, GUIDE_OPTION_TEXT_MAX_CHARS),
    routeText: normalizeOptionalText(raw.routeText, GUIDE_OPTION_TEXT_MAX_CHARS),
    sceneText: normalizeOptionalText(raw.sceneText, GUIDE_OPTION_TEXT_MAX_CHARS),
    bargain: normalizeOptionBargain(raw.bargain),
    noteText: normalizeOptionalText(raw.noteText, GUIDE_OPTION_TEXT_MAX_CHARS),
    sourceMentionRefs: refs,
  };
}

/**
 * 主题组级去重键：主题归一化（小写）+ 分类。
 * 同键 = 同一主题组（合并选项），不同分类的同名主题视为不同组（如「门票」与「交通」）。
 */
export function guideOptionGroupKey(topic: string, category: GuideOptionCategory): string {
  return `${normalizeOptionLabelKey(topic).toLowerCase()}::${category}`;
}

/** 待合并入组的草案形状（应用挂载侧传入；不需要 targetRef / groupId） */
export interface GuideOptionGroupMergeInput {
  topic: string;
  category: GuideOptionCategory;
  options: PendingGuideDraftOptionItem[];
  sourceMentionRefs: string[];
}

/**
 * 把一组草案选项组去重合并进既有列表（应用时挂载唯一入口）：
 * - 同 guideOptionGroupKey 的组：选项按 label 归一化去重后追加（已有 label 跳过），
 *   组级引用并入组级（去重）；组对象与 collectedAt 保留首见值（不覆盖采集时间）；
 * - 新组：追加（collectedAt 由调用方传入）；
 * - 超过 GUIDE_OPTION_GROUP_MAX_PER_ENTITY 截断（先到先得，确定不抖动）；
 * - 返回合并后的新数组与计数（不修改入参），供返回体统计与日志。
 */
export function mergeOptionGroupsIntoList(
  existing: GuideOptionGroup[] | null | undefined,
  incoming: readonly GuideOptionGroupMergeInput[],
  collectedAt: string,
): { groups: GuideOptionGroup[]; addedGroups: number; addedOptions: number } {
  const groups: GuideOptionGroup[] = (Array.isArray(existing) ? existing : []).map((group) => ({
    ...group,
    options: [...group.options],
    sourceMentionRefs: [...group.sourceMentionRefs],
  }));
  const keyIndex = new Map<string, GuideOptionGroup>();
  for (const group of groups) keyIndex.set(guideOptionGroupKey(group.topic, group.category), group);

  let addedGroups = 0;
  let addedOptions = 0;
  for (const draft of incoming) {
    if (groups.length >= GUIDE_OPTION_GROUP_MAX_PER_ENTITY) break;
    const draftOptions = Array.isArray(draft.options) ? draft.options : [];
    if (draftOptions.length < 2) continue; // 单选不成组（防御：清洗层已过滤）
    const key = guideOptionGroupKey(draft.topic, draft.category);
    const target = keyIndex.get(key);
    if (target === undefined) {
      const created: GuideOptionGroup = {
        groupId: `gog_${Math.random().toString(36).slice(2, 10)}`,
        topic: draft.topic,
        category: draft.category,
        options: draftOptions.map((option) => ({ ...option, sourceMentionRefs: [...option.sourceMentionRefs] })),
        sourceMentionRefs: [...draft.sourceMentionRefs],
        collectedAt,
      };
      groups.push(created);
      keyIndex.set(key, created);
      addedGroups += 1;
      addedOptions += created.options.length;
      continue;
    }
    // 同主题组合并：label 归一化去重追加 + 组级引用并入
    const knownLabels = new Set(
      target.options.map((option) => normalizeOptionLabelKey(option.label).toLowerCase()),
    );
    for (const option of draft.options) {
      const labelKey = normalizeOptionLabelKey(option.label).toLowerCase();
      if (knownLabels.has(labelKey)) continue;
      knownLabels.add(labelKey);
      target.options.push({ ...option, sourceMentionRefs: [...option.sourceMentionRefs] });
      addedOptions += 1;
    }
    for (const ref of draft.sourceMentionRefs) {
      if (!target.sourceMentionRefs.includes(ref)) target.sourceMentionRefs.push(ref);
    }
  }
  return { groups, addedGroups, addedOptions };
}
