/**
 * FlyAI 搜索结果的目的地权威过滤（服务端可复用函数）。
 *
 * 背景：FlyAI 对「西岛」这类短关键词可能返回境外同名结果（如马尔代夫甘格西岛），
 * 候选池与攻略抽取都只应保留能确认属于行程目的地的结果。
 *
 * 判定顺序（对每条结果，Task #45 调整：目的地确认优先于境外标记——
 *   否则会误杀品牌名含国家词的本地酒店，如实测样本「三亚亚龙湾雅高瑞士酒店」Swissôtel）：
 *   1. 名称或地址包含目的地基准名（如「三亚」）→ 确认归属；
 *   2. 名称或地址命中非本地国家/地区标记 → 明确排除
 *      （不扫描 description/category，避免「中国马尔代夫」类营销文案误杀本地点位）；
 *   3. 已知目的地有地理包围盒且结果带经纬度、落在盒内 → 确认归属（仅作辅助判据）；
 *   4. 其余一律视为无法确认归属，丢弃 —— 宁可漏收，不可让池外错误地点进入候选池。
 */

/** 参与归属判定的最小结构（FlyAIPoi / HotelCandidate 均天然满足，便于后续复用） */
export interface DestinationScopeRecord {
  name: string;
  address: string | null;
  category?: string | null;
  description?: string | null;
  coords: { lng: number; lat: number } | null;
}

export interface DestinationScopeDecision<T> {
  kept: T[];
  rejected: { name: string; reason: string }[];
}

interface CityGeoBox {
  minLng: number;
  maxLng: number;
  minLat: number;
  maxLat: number;
}

/** 已知城市地理包围盒（粗粒度，仅作文本确认之外的辅助判据）。
 *  三亚东界由 110.0 收紧至 109.85：东侧紧邻的陵水清水湾（约 109.98E）会落进旧盒，
 *  属「其他城市」泄漏面；三亚本土最东的蜈支洲岛约 109.766E，不受影响（宁可漏收，不可错收）。 */
const CITY_GEO_BOXES: Record<string, CityGeoBox> = {
  三亚: { minLng: 108.9, maxLng: 109.85, minLat: 18.05, maxLat: 18.7 },
};

/** 非本地国家/地区标记：名称或地址命中即明确排除 */
const FOREIGN_MARKERS = [
  "马尔代夫",
  "马累",
  "日本",
  "韩国",
  "朝鲜",
  "蒙古",
  "俄罗斯",
  "泰国",
  "越南",
  "老挝",
  "柬埔寨",
  "缅甸",
  "马来西亚",
  "新加坡",
  "印度尼西亚",
  "巴厘岛",
  "菲律宾",
  "印度",
  "尼泊尔",
  "斯里兰卡",
  "土耳其",
  "阿联酋",
  "迪拜",
  "沙特",
  "卡塔尔",
  "埃及",
  "摩洛哥",
  "南非",
  "肯尼亚",
  "英国",
  "法国",
  "德国",
  "意大利",
  "西班牙",
  "葡萄牙",
  "希腊",
  "瑞士",
  "奥地利",
  "荷兰",
  "比利时",
  "美国",
  "加拿大",
  "墨西哥",
  "巴西",
  "阿根廷",
  "澳大利亚",
  "新西兰",
  "斐济",
  "帕劳",
  "塞班",
  "关岛",
  "毛里求斯",
  "塞舌尔",
];

/** 城市名归一化：去空白与行政后缀，得到用于文本匹配的基准名（如「三亚市」→「三亚」） */
function cityBaseName(city: string): string {
  return city.replace(/\s+/g, "").replace(/(市|地区|自治州|盟)$/, "");
}

/** 返回排除原因；null 表示归属可确认 */
function judgeDestination(
  text: string,
  coords: DestinationScopeRecord["coords"],
  base: string,
  geoBox: CityGeoBox | null,
): string | null {
  // 1. 已含目的地基准名 → 确认归属（优先于境外标记，避免品牌名含国家词的本地酒店被误杀）
  if (text.includes(base)) return null;
  // 2. 命中非本地国家/地区标记 → 明确排除（未确认归属前提下的硬拒绝）
  for (const marker of FOREIGN_MARKERS) {
    if (text.includes(marker)) return `命中非本地标记「${marker}」`;
  }
  // 3. 坐标落在目的地包围盒 → 确认归属（仅作文本确认之外的辅助判据）
  if (
    geoBox !== null &&
    coords !== null &&
    coords.lng >= geoBox.minLng &&
    coords.lng <= geoBox.maxLng &&
    coords.lat >= geoBox.minLat &&
    coords.lat <= geoBox.maxLat
  ) {
    return null;
  }
  return "无法确认属于目的地，按契约丢弃";
}

/**
 * 按目的地城市过滤搜索结果；city 为空时不做判定（原样保留，由调用方决定是否放行）。
 * 纯函数：不改写结果内容，只做保留/丢弃划分，便于复用与幂等复核。
 */
export function filterByDestinationCity<T extends DestinationScopeRecord>(
  records: readonly T[],
  city: string,
): DestinationScopeDecision<T> {
  const base = cityBaseName(city);
  if (base === "") return { kept: [...records], rejected: [] };

  const geoBox = CITY_GEO_BOXES[base] ?? null;
  const kept: T[] = [];
  const rejected: DestinationScopeDecision<T>["rejected"] = [];
  for (const record of records) {
    const text = [record.name, record.address]
      .filter((value): value is string => typeof value === "string" && value.trim() !== "")
      .join(" ");
    const reason = judgeDestination(text, record.coords, base, geoBox);
    if (reason === null) kept.push(record);
    else rejected.push({ name: record.name, reason });
  }
  return { kept, rejected };
}

// ===== 片区层过滤（F6 酒店候选，Task #45） =====

/** 参与片区判定的最小结构（HotelCandidate 天然满足） */
export interface AreaScopeRecord {
  name: string;
  address: string | null;
  coords: { lng: number; lat: number } | null;
}

/** 片区判定配置：shared AreaConfig 的结构子集（可直接传入，无需字段改写） */
export interface AreaScopeConfig {
  name: string;
  center: { lat: number; lng: number };
  hotelRadiusKm: number;
  hotelMarkers: readonly string[];
}

export interface AreaScopeDecision<T> {
  /** 保留结果：有坐标的按「命中本地标记优先 → 距片区中心由近到远」排序；无坐标且命中标记的排在最后 */
  kept: T[];
  rejected: { name: string; reason: string }[];
}

// Task #325：haversineKm 已迁移至 shared/src/geo/index.ts（shared 无循环依赖约束）
import { haversineKm } from "@goplay/shared";
export { haversineKm };

/** 名称或地址首个命中的片区本地标记；null 表示未命中 */
function matchAreaMarker(record: AreaScopeRecord, markers: readonly string[]): string | null {
  const text = [record.name, record.address]
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .join(" ");
  for (const marker of markers) {
    if (text.includes(marker)) return marker;
  }
  return null;
}

/**
 * 片区层权威过滤（仅对已通过城市过滤的结果执行）：
 *   1. 有坐标：距片区中心超过 hotelRadiusKm → 明确排除；否则保留并按距离参与排序；
 *   2. 无坐标：名称/地址命中片区本地标记（如「解放路」）→ 保留（排最后）；
 *   3. 无坐标且未命中标记 → 无法确认片区归属，丢弃（宁可空结果，不可错放）。
 * 排序：命中本地标记的坐标结果优先（离岛场景让「蜈支洲岛珊瑚酒店」排在周边酒店前），
 * 其次按距中心由近到远，无坐标标记命中者保持原相对顺序垫底。纯函数，可幂等复核。
 */
export function filterByAreaCenter<T extends AreaScopeRecord>(
  records: readonly T[],
  area: AreaScopeConfig,
): AreaScopeDecision<T> {
  const rejected: AreaScopeDecision<T>["rejected"] = [];
  const ranked: { record: T; tier: number; distanceKm: number; index: number }[] = [];

  records.forEach((record, index) => {
    const marker = matchAreaMarker(record, area.hotelMarkers);
    if (record.coords === null) {
      if (marker !== null) {
        ranked.push({ record, tier: 2, distanceKm: Number.POSITIVE_INFINITY, index });
      } else {
        rejected.push({
          name: record.name,
          reason: `无坐标且名称/地址未命中「${area.name}」本地标记，无法确认片区归属`,
        });
      }
      return;
    }
    const distanceKm = haversineKm(record.coords, area.center);
    if (distanceKm > area.hotelRadiusKm) {
      rejected.push({
        name: record.name,
        reason: `距「${area.name}」中心 ${distanceKm.toFixed(1)}km，超出 ${area.hotelRadiusKm}km 半径`,
      });
      return;
    }
    ranked.push({ record, tier: marker !== null ? 0 : 1, distanceKm, index });
  });

  const kept = ranked
    .sort((x, y) => x.tier - y.tier || x.distanceKm - y.distanceKm || x.index - y.index)
    .map((entry) => entry.record);
  return { kept, rejected };
}
