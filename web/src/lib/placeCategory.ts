/**
 * 任务 128：无图占位的稳定分类与精简短名（纯函数，无副作用、无网络）。
 *
 * 设计约束：
 * - 分类只依据三路输入：item.category 文本 → 名称关键词 → visit.kind 兜底；
 *   关键词为少量声明式词表（具体类在前、宽泛类在后），不做地名硬编码表。
 * - 匹配顺序即优先级：咖啡茶饮（最具体）→ 海滩海岛 → 餐饮 → 购物 → 住宿交通
 *   → 景点（最宽泛兜底）→ 通用。顺序保证「咖啡馆」不会被「馆」（景点）抢先、
 *   「海鲜加工店」归餐饮而非被「店」误判。
 * - 短名规则固定：去成对括号 → 按常见分隔符取首段 → 超过 4 字截前 4 字；
 *   2–4 字在 56×56 / 120px 缩略窗内均可单行可读，长名截断规则简单可预测。
 */

/** 占位类别 key（7 类；generic 为兜底） */
export type PlaceCategoryKey =
  | "dining"
  | "coffee"
  | "beach"
  | "sight"
  | "shopping"
  | "stay"
  | "generic";

export interface PlaceCategoryInfo {
  key: PlaceCategoryKey;
  /** 单字图标文本；空串 = 使用地图钉图形（generic 专用） */
  glyph: string;
  /** 类别中文名（进入 aria-label，读屏完整可懂） */
  label: string;
}

const CATEGORY_META: Record<PlaceCategoryKey, PlaceCategoryInfo> = {
  dining: { key: "dining", glyph: "食", label: "餐饮" },
  coffee: { key: "coffee", glyph: "咖", label: "咖啡茶饮" },
  beach: { key: "beach", glyph: "海", label: "海滩海岛" },
  sight: { key: "sight", glyph: "景", label: "景点" },
  shopping: { key: "shopping", glyph: "购", label: "购物" },
  stay: { key: "stay", glyph: "宿", label: "住宿交通" },
  generic: { key: "generic", glyph: "", label: "地点" },
};

/** item.category 文本直判（飞猪/自定义类别字段），优先于名称关键词 */
const CATEGORY_TEXT_RULES: Array<[RegExp, PlaceCategoryKey]> = [
  [/咖啡|茶饮|茶/, "coffee"],
  [/海滩|沙滩|海岛|海滨/, "beach"],
  [/美食|餐饮|餐厅|小吃/, "dining"],
  [/购物|商场|免税/, "shopping"],
  [/酒店|住宿|民宿|交通|机场|车站|码头/, "stay"],
  [/景点|景区|观光|门票|游玩/, "sight"],
];

/** 名称关键词表（顺序 = 优先级；小写比较，英文词天然命中大小写混排） */
const CATEGORY_KEYWORD_RULES: Array<[PlaceCategoryKey, string[]]> = [
  ["coffee", ["咖啡", "奶茶", "茶室", "茶馆", "茶铺", "cafe", "coffee"]],
  ["beach", ["海滩", "沙滩", "海滨", "海岛", "浴场", "岛", "beach", "island"]],
  [
    "dining",
    [
      "餐厅",
      "餐馆",
      "美食",
      "饭店",
      "饭馆",
      "食堂",
      "酒楼",
      "火锅",
      "烧烤",
      "烤肉",
      "小吃",
      "米粉",
      "米线",
      "面馆",
      "粥",
      "海鲜",
      "菜馆",
      "food",
      "restaurant",
      "kitchen",
    ],
  ],
  [
    "shopping",
    [
      "购物",
      "商城",
      "商场",
      "免税",
      "夜市",
      "集市",
      "市场",
      "商业街",
      "步行街",
      "百货",
      "mall",
      "shop",
      "market",
    ],
  ],
  [
    "stay",
    [
      "酒店",
      "民宿",
      "客栈",
      "度假村",
      "度假城",
      "公寓",
      "机场",
      "码头",
      "车站",
      "港口",
      "高铁",
      "hotel",
      "resort",
      "inn",
      "airport",
      "station",
    ],
  ],
  [
    "sight",
    [
      "公园",
      "景区",
      "博物馆",
      "美术馆",
      "科技馆",
      "水族馆",
      "动物园",
      "植物园",
      "乐园",
      "庙",
      "寺",
      "塔",
      "瀑布",
      "温泉",
      "溶洞",
      "剧场",
      "广场",
      "park",
      "museum",
      "temple",
      "zoo",
      "plaza",
    ],
  ],
];

/**
 * 稳定分类：category 文本 → 名称关键词 → 大景区兜底 → 通用。
 * 同名输入恒得同类别（无随机、无时间、无环境依赖）。
 */
export function classifyPlace(input: {
  category?: string | null;
  name: string;
  isLargeAttraction?: boolean;
}): PlaceCategoryInfo {
  const categoryText = (input.category ?? "").trim();
  if (categoryText !== "") {
    for (const [pattern, key] of CATEGORY_TEXT_RULES) {
      if (pattern.test(categoryText)) return CATEGORY_META[key];
    }
  }
  const lowerName = input.name.toLowerCase();
  for (const [key, words] of CATEGORY_KEYWORD_RULES) {
    if (words.some((word) => lowerName.includes(word))) return CATEGORY_META[key];
  }
  if (input.isLargeAttraction) return CATEGORY_META.sight;
  return CATEGORY_META.generic;
}

/**
 * 精简短名：去成对括号 → 按分隔符（中点/破折号/竖线/冒号/逗号/空白）取首个
 * 非空段 → 超过 4 字截前 4 字；清洗后为空回退「地点」。
 * 2–4 字段在 56×56 与 120px 缩略窗内均可单行完整显示。
 */
export function shortPlaceLabel(name: string): string {
  const cleaned = name
    .trim()
    .replace(/（[^）]*）|\([^)]*\)/g, "")
    .trim();
  if (cleaned === "") return "地点";
  const segment = cleaned
    .split(/[·•・\-–—_|/：:，,\s]+/)
    .find((part) => part.length > 0);
  const base = segment ?? cleaned;
  return base.length <= 4 ? base : base.slice(0, 4);
}
