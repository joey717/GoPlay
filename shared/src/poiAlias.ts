/**
 * Task #233：POI 名称的保守归一化与显式别名召回（单一数据源）。
 *
 * 背景：攻略里常写景点简称（「亚龙湾森林公园」），飞猪官方名是
 * 「亚龙湾热带天堂森林公园」。两个名称没有子串包含关系，既有的
 * 「归一化全等 / 整体双向包含」两条规则都命不中，抽取装配
 * （server/src/ai/assemble.ts findBestMatch）只能把它降级成 custom 点位，
 * 攻略提及与官方候选从此对不上。
 *
 * 设计取舍（最低成本、最低误匹配风险）：
 * - 只认显式别名表：本文件是唯一事实来源，追加一行即扩展召回；
 * - 名称归一化只做三种保守处理：成对括号及其内容、全部空白、已知城市前缀
 *   （剥离后主体不足 4 字不剥——「三亚湾」不能被剥成泛化词「湾」）；
 * - 不做编辑距离、不做共享子串 / 单字包含等宽松匹配：
 *   「亚龙湾海滩」「亚龙湾」与「亚龙湾热带天堂森林公园」因此互不指代。
 *
 * 消费方（同一口径，禁止各自复制常量）：
 * - server 真实召回 / 对齐：assemble.findBestMatch（飞猪 POI）、findExistingFliggyItem /
 *   findReusableItem（Item 复用）、findVisitByItemName（parentAttraction 归属）、
 *   ensureStopAndPlace（Stop 复用）；guides.merge 的地点去重与 nameIndex；
 * - web：normalizeEvidenceName（原文范围降级匹配）、largeAttraction.normalizePoiName
 *   （搜索结果 → 行程已有大景区 / 内部玩法召回）。
 *
 * 刻意不消费别名的地方（保留各自的既有语义）：
 * - server normalizePoiName 只做基础归一化——planner 快速路径与 directives 靠
 *   「全等 > 整体包含」收敛同名重复实体，折叠别名会把可唯一命中的实体变成歧义；
 * - checkpointFilter 的私有归一化用于校验名称是否能在原文 quote 中定位，
 *   折叠别名会让简称在原文中找不到而被误判为编造。
 */

/** 成对括号及其内容（中英文圆括号 / 方括号 / 花括号） */
const BRACKET_CONTENT_RE = /[（(【\[{][^）)】\]}]*[）)】\]}]/g;

/**
 * 显式别名表（唯一事实来源）：[简称, 正式名]。
 * 两列都按「基础归一化 + 去城市前缀」装载，写自然名称即可。
 * 新增别名只需追加一行；正式名本身不允许再是别名（单跳解析，见下）。
 */
const POI_ALIAS_ROWS: ReadonlyArray<readonly [alias: string, canonical: string]> = [
  ["亚龙湾森林公园", "亚龙湾热带天堂森林公园"],
  ["亚龙湾热带森林公园", "亚龙湾热带天堂森林公园"],
  // Task #286（PD 2026-10-28 裁定，golden E9 expectedPois.canonicalGroups）：亚龙湾山顶打卡点归一。
  // 「山顶婚礼草坪」==「婚礼礼堂大草坪」（同一具体打卡点），且该打卡点属「山顶公园」范围内 →
  // 全归「山顶公园」canonical（A13 口径：全归山顶公园 PASS）。补此两条别名后 merge.ts nameIndex
  // 折叠三表面串到同一地点，#285 的 alias_gap finding 转硬断言全绿（回归见 verify-task233.ts S8）。
  ["山顶婚礼草坪", "山顶公园"],
  ["婚礼礼堂大草坪", "山顶公园"],
];

/**
 * 已知城市前缀：飞猪官方名常带城市层（如「三亚亚特兰蒂斯酒店」）。
 * 只列明确城市名，不按目的地动态推断；新增目的地城市在此追加一条。
 */
const POI_CITY_PREFIXES: readonly string[] = ["三亚"];

/** 剥离城市前缀后允许的最短主体长度（防「三亚湾」→「湾」这类泛化坍缩） */
const MIN_BODY_CHARS_AFTER_CITY = 4;

/** 基础归一化：去成对括号及其内容 + 去全部空白（不做任何模糊 / 编辑距离处理） */
export function normalizePoiNameBase(raw: string): string {
  if (typeof raw !== "string") return "";
  return raw.replace(BRACKET_CONTENT_RE, "").replace(/\s+/g, "").trim();
}

/** 剥离已知城市前缀（主体过短时原样返回，保持名称可辨识） */
function stripCityPrefix(name: string): string {
  for (const prefix of POI_CITY_PREFIXES) {
    if (!name.startsWith(prefix)) continue;
    const body = name.slice(prefix.length);
    if ([...body].length >= MIN_BODY_CHARS_AFTER_CITY) return body;
  }
  return name;
}

/** 别名 / 正式名的比对键：基础归一化 + 去城市前缀 + 小写 */
function aliasLookupKey(raw: string): string {
  return stripCityPrefix(normalizePoiNameBase(raw)).toLowerCase();
}

/**
 * 别名 → 正式名映射（键为 aliasLookupKey 形式，值为归一化后的正式名）。
 * 装载时对两列都做归一化，调用方不需要也不应该自己拼键。
 */
export const POI_ALIAS_MAP: ReadonlyMap<string, string> = new Map(
  POI_ALIAS_ROWS.map(([alias, canonical]) => [
    aliasLookupKey(alias),
    stripCityPrefix(normalizePoiNameBase(canonical)),
  ]),
);

/**
 * 别名单跳解析：命中别名表返回正式名（归一化后），否则返回基础归一化名。
 * 单跳是刻意的——不做 A→B→C 链式解析，避免表里写错造成环路；验证脚本断言
 * 正式名不会再是别名键。
 */
export function resolvePoiAlias(raw: string): string {
  const base = stripCityPrefix(normalizePoiNameBase(raw));
  if (base === "") return "";
  return POI_ALIAS_MAP.get(base.toLowerCase()) ?? base;
}

/** 对齐键：resolvePoiAlias 后小写（各匹配链路直接比较此键） */
export function canonicalPoiMatchKey(raw: string): string {
  return resolvePoiAlias(raw).toLowerCase();
}

/**
 * 两个名称是否指向同一 canonical POI（别名折叠后全等）。
 * Task #249：custom → fliggy 原地升级的唯一比对口径——只认全等，不含「整体包含」
 * 降级（「亚龙湾」与「亚龙湾海滩」因此不会被当成同一实体而误升级）。
 */
export function isSameCanonicalPoiName(left: string, right: string): boolean {
  const key = canonicalPoiMatchKey(left);
  return key !== "" && key === canonicalPoiMatchKey(right);
}

/** 名称是否命中显式别名表（别名召回需要追加正式名检索时使用） */
export function isPoiAlias(raw: string): boolean {
  const base = stripCityPrefix(normalizePoiNameBase(raw)).toLowerCase();
  if (base === "") return false;
  return canonicalPoiMatchKey(raw) !== base;
}
