// ===== 片区本地配置（三亚） =====

import { normalizePoiNameBase } from "../poiAlias.js";

export interface AreaConfig {
  id: string;
  name: string;
  center: { lat: number; lng: number };
  description: string;
  /**
   * F6 酒店搜索本地语义关键词：必须是三亚明确地名（如「解放路」）。
   * 禁止「老城」这类全球模糊词——飞猪后端会按全球模糊匹配返回
   * 爱沙尼亚塔林 Old Town 等境外酒店（Task #45 故障样本）。
   */
  hotelKeyword: string;
  /** 酒店坐标过滤半径（km）：以 center 为圆心，超出即判定为非本片区 */
  hotelRadiusKm: number;
  /** 无坐标酒店的片区确认标记：名称或地址命中其一即视为本片区 */
  hotelMarkers: readonly string[];
}

export const SANYA_AREAS: AreaConfig[] = [
  {
    id: "haitang",
    name: "海棠湾",
    center: { lat: 18.3213, lng: 109.739 },
    description: "免税天堂，高端酒店聚集",
    hotelKeyword: "海棠湾",
    hotelRadiusKm: 10,
    hotelMarkers: ["海棠湾", "海棠区", "林旺", "后海", "藤海", "蜈支洲"],
  },
  {
    id: "yalong",
    name: "亚龙湾",
    center: { lat: 18.1912, lng: 109.637 },
    description: "老牌度假区，沙滩质量最佳",
    hotelKeyword: "亚龙湾",
    hotelRadiusKm: 8,
    hotelMarkers: ["亚龙湾", "龙海路", "亚龙湾路", "博后", "六盘"],
  },
  {
    id: "dadonghai",
    name: "大东海",
    center: { lat: 18.2098, lng: 109.512 },
    description: "市区最近海湾，性价比高",
    hotelKeyword: "大东海",
    hotelRadiusKm: 5,
    hotelMarkers: ["大东海", "榆亚", "海花路", "鹿岭路", "海韵路", "下洋田"],
  },
  {
    id: "sanyawan",
    name: "三亚湾",
    center: { lat: 18.247, lng: 109.412 },
    description: "椰梦长廊，落日最美",
    hotelKeyword: "三亚湾",
    hotelRadiusKm: 12,
    hotelMarkers: ["三亚湾", "椰梦长廊", "海坡", "海龙路", "三亚湾路", "凤凰机场"],
  },
  {
    id: "laocheng",
    name: "老城",
    center: { lat: 18.2526, lng: 109.5015 },
    description: "解放路、第一市场，本地生活",
    // 「老城」是全球模糊词（塔林 Old Town 泄漏源）：酒店搜索改用解放路/第一市场等明确本地语义
    hotelKeyword: "解放路",
    hotelRadiusKm: 4,
    hotelMarkers: [
      "解放路",
      "解放二路",
      "解放三路",
      "解放四路",
      "第一市场",
      "跃进街",
      "跃进路",
      "胜利路",
      "河西路",
      "河东路",
      "新风街",
      "新风路",
      "建设街",
      "群众街",
      "光明街",
      "红旗街",
      "步行街",
      "明珠广场",
      "商品街",
      "临春河",
    ],
  },
  {
    id: "lidao",
    name: "离岛",
    center: { lat: 18.3089, lng: 109.418 },
    description: "蜈支洲岛、西岛等离岛景点",
    // 蜈支洲岛在中心东侧约 36km、西岛约 9km：半径需同时覆盖两座离岛及码头村（后海/藤海/林旺）
    hotelKeyword: "蜈支洲岛",
    hotelRadiusKm: 45,
    hotelMarkers: ["蜈支洲", "西岛", "后海", "藤海", "林旺", "南田"],
  },
];

export function findAreaById(id: string): AreaConfig | undefined {
  return SANYA_AREAS.find(a => a.id === id);
}

export function findAreaByName(name: string): AreaConfig | undefined {
  return SANYA_AREAS.find(a => a.name === name);
}

// ===== Task #249：纯区域描述识别（区域消歧，唯一数据源 = SANYA_AREAS） =====

/** 片区数据所属城市：片区名（尤其「老城」这类通用词）只在本地目的地生效，不跨城市误伤 */
export const SANYA_AREA_CITY = "三亚";

/**
 * 允许跟在片区名之后的住宿 / 位置修饰（「亚龙湾住宿」「海棠湾一带」）——这类仍是
 * 片区信息，不是可游玩实体。刻意不收录「海滩 / 沙滩 / 公园 / 景区 / 免税城 / 酒店名」
 * 等具体场所词：「亚龙湾海滩」「亚龙湾热带天堂森林公园」是真实可游玩地点，必须保留。
 * 也不做「以湾结尾」这类后缀猜测——只认片区表里的名称 + 下列封闭修饰。
 */
const AREA_PLACE_SUFFIXES: readonly string[] = [
  "片区",
  "区域",
  "一带",
  "附近",
  "住宿",
  "住宿区",
  "住宿区域",
  "住宿推荐",
  "酒店区",
];

/**
 * 按「片区名」或「片区名 + 住宿/位置修饰」精确查找片区配置。
 * 只做归一化全等（去成对括号内容与空白，与 normalizePoiNameBase 同口径），
 * 不做包含 / 结尾 / 模糊匹配——「亚龙湾海滩」「三亚湾椰梦长廊」查不到片区。
 */
export function findAreaByPlaceName(raw: string): AreaConfig | undefined {
  const name = normalizePoiNameBase(raw);
  if (name === "") return undefined;
  for (const area of SANYA_AREAS) {
    const areaName = normalizePoiNameBase(area.name);
    if (areaName === "") continue;
    if (name === areaName || AREA_PLACE_SUFFIXES.some((suffix) => name === `${areaName}${suffix}`)) {
      return area;
    }
  }
  return undefined;
}

/**
 * 是否为「纯区域 / 住宿片区描述」（Task #249 区域消歧）。
 * - city 提供且不是片区数据所属城市 → 一律 false（「老城」等通用词不跨城市误伤）；
 * - city 缺省（验证脚本 / 无目的地上下文）按片区数据直接判定。
 *
 * 边界：区域名本身可能同时是真实供应商 POI（如「大东海」「海棠湾」），调用方只应在
 * 「即将创建 custom 点位」时使用本判定；已有 providerId 的真实结果与既有实体不受影响。
 */
export function isAreaOnlyPlaceName(raw: string, city?: string | null): boolean {
  const destination = typeof city === "string" ? city.trim() : "";
  if (destination !== "" && destination !== SANYA_AREA_CITY) return false;
  return findAreaByPlaceName(raw) !== undefined;
}
