/**
 * Task #219：搜索添加点位的大景区识别（短期启发式方案）。
 *
 * 背景：FlyAI 搜索返回的 POI 不含规模/父子关系字段；前端「搜索 → 候选池 → 排入」
 * 路径不经过 AI 抽取（server/src/ai/assemble.ts 的 scale 判定），plan(point) 在
 * shared 执行器里硬编码创建 kind:"ordinary" 壳，导致西岛、蜈支洲岛这类大景区
 * 排入后是普通景点，情人桥等内部玩法失去可挂载的父卡。
 *
 * 本模块提供三层能力（均为纯函数，不改 shared 守卫与 AI 抽取路径）：
 * 1. isLargeAttractionPoi：新 POI 的 kind 推断（知名景区关键词 + 5A 辅助）；
 * 2. findMatchingLargeVisit / findChildStopParentVisit：与行程已有大景区、
 *    已有岛内玩法的名称交叉比对（方案 1 归属提示的依据）；
 * 3. poiAttractionLabel：搜索结果标注文案（方案 2）。
 * 长期应由 FlyAI 提供更丰富的景点分类字段，关键词列表仅为过渡手段；
 * 去往新目的地时在 KNOWN_LARGE_ATTRACTION_KEYWORDS 中补充即可。
 *
 * Task #360 追加第 4 层能力：
 * 4. CLASSIFY_MAX_DISTANCE_KM / isEligibleClassifyTarget / eligibleClassifyTargets：
 *    「归入大景点」UI 入口的距离资格判定（2km + 无坐标同天兜底）。
 */
import type { Trip, Visit } from "@goplay/shared";
import { haversineKm, resolveItemCoords, resolvePoiAlias } from "@goplay/shared";
import { stopDisplayName } from "./trip";

/**
 * 知名大景区关键词：POI 名称包含（归一化后）即判为大景区。
 * 2026-11-04 PD 名单更新（Task #349），旧名单见 git 历史；与
 * server/src/guides/fix-task225.ts 的 KNOWN_LARGE_ATTRACTION_KEYWORDS 保持完全一致。
 */
export const KNOWN_LARGE_ATTRACTION_KEYWORDS = [
  "西岛",
  "蜈支洲岛",
  "分界洲岛",
  "南山文化旅游区",
  "呀诺达",
  "亚龙湾热带天堂森林公园",
] as const;

/**
 * 名称归一化：去成对括号内容、去空白、去已知城市前缀，并把显式别名解析为正式名
 * （Task #233：唯一实现在 @goplay/shared poiAlias，本处只转发，禁止另存别名常量）。
 * server 侧只在真实召回 / 对齐点调用同一函数；其 normalizePoiName 仍为基础口径
 * （planner 快速路径需要保留「全等 > 整体包含」的平局规则）。
 * 搜索「亚龙湾热带天堂森林公园」与行程里攻略抽取的「亚龙湾森林公园」因此可互相召回。
 */
export function normalizePoiName(name: string): string {
  return resolvePoiAlias(name);
}

/** POI 是否应创建为大景区（方案 3）：
 * 1) 名称（归一化后）包含知名大景区关键词；2) 5A 景区（poiLevel="AAAAA"）辅助判定。
 * 4A 不参与自动判定（数量大且含中小景点），仅在搜索结果中展示等级信息。 */
export function isLargeAttractionPoi(name: string, poiLevel?: string | null): boolean {
  const target = normalizePoiName(name);
  if (target === "") return false;
  const keywordHit = KNOWN_LARGE_ATTRACTION_KEYWORDS.some((keyword) =>
    target.includes(normalizePoiName(keyword)),
  );
  if (keywordHit) return true;
  return poiLevel === "AAAAA";
}

/** 大景区 Visit 的显示名（无主数据时返回 null，调用方跳过匹配） */
export function largeVisitDisplayName(trip: Trip, visit: Visit): string | null {
  return trip.itemRegistry[visit.pointRef]?.name ?? null;
}

/**
 * 在行程已有 large_attraction Visit 中找与 poiName 名称匹配的（方案 1）：
 * 归一化后整体双向包含（两侧 ≥2 字符，对齐服务端名称降级匹配口径）。
 * 典型场景：行程已有攻略抽取的「西岛旅游区」，用户又搜到飞猪「西岛」。
 */
export function findMatchingLargeVisit(trip: Trip, poiName: string): Visit | null {
  const target = normalizePoiName(poiName);
  if (target.length < 2) return null;
  for (const visit of Object.values(trip.visits)) {
    if (visit.kind !== "large_attraction") continue;
    const visitName = largeVisitDisplayName(trip, visit);
    if (visitName === null) continue;
    const candidate = normalizePoiName(visitName);
    if (candidate.length < 2) continue;
    if (candidate.includes(target) || target.includes(candidate)) return visit;
  }
  return null;
}

/**
 * 在行程已有大景区的岛内玩法（childStopRefs + alternateStopRefs）中找与 poiName
 * 名称匹配的，返回所属大景区。用于：方案 1 归属提示（搜「情人桥」→ 蜈支洲岛内
 * 已有同名玩法）与方案 2 的「XX 子景点」标注。
 */
export function findChildStopParentVisit(trip: Trip, poiName: string): Visit | null {
  const target = normalizePoiName(poiName);
  if (target.length < 2) return null;
  for (const visit of Object.values(trip.visits)) {
    if (visit.kind !== "large_attraction") continue;
    const stopRefs = [...visit.childStopRefs, ...visit.alternateStopRefs];
    for (const stopId of stopRefs) {
      const stop = trip.stops[stopId];
      if (stop === undefined) continue;
      const stopName = normalizePoiName(stopDisplayName(trip, stop));
      if (stopName.length < 2) continue;
      if (stopName.includes(target) || target.includes(stopName)) return visit;
    }
  }
  return null;
}

/**
 * 搜索结果标注文案（方案 2）：返回 null 表示无需标注。
 * 优先级：已有大景区本名匹配 > 已有岛内玩法同名 > 关键词/5A 前瞻判定。
 */
export function poiAttractionLabel(
  trip: Trip,
  poiName: string,
  poiLevel?: string | null,
): string | null {
  const nameMatch = findMatchingLargeVisit(trip, poiName);
  if (nameMatch !== null) {
    const parentName = largeVisitDisplayName(trip, nameMatch);
    return parentName !== null ? `${parentName} · 大景区` : "大景区";
  }
  const childMatch = findChildStopParentVisit(trip, poiName);
  if (childMatch !== null) {
    const parentName = largeVisitDisplayName(trip, childMatch);
    return parentName !== null ? `${parentName}子景点` : "岛内玩法";
  }
  if (isLargeAttractionPoi(poiName, poiLevel)) return "大景区";
  return null;
}

// ===== Task #360：「归入大景点」UI 入口的距离资格判定 =====

/**
 * 归类入口的最大距离阈值（km）——单点维护、常量可调（PD 2026-11-10 拍板 2km）。
 *
 * 实测依据（验收行程 0a27f726，haversineKm）：
 * - 真实子景点→所属大景区最远 1.40km（过江龙索桥；玻璃栈道 0.20、试婚房 0.33、
 *   珊瑚墙 0.97、兰花谷 1.26）；
 * - 误报（同片区不同景区）最近 2.74km（亚龙湾海滩→亚龙湾森林公园；
 *   后海村→蜈支洲岛 5.72、椰梦长廊→鹿回头 6.05）。
 * 2km 与两侧各留约 1.3km 安全边际。
 *
 * 范围：本阈值只收紧 UI 入口（普通卡「归入大景点」按钮 + 归类浮层目标列表）；
 * shared/src/operations 的 classifyVisitAsStop 执行器与手动 op 通道保留不动。
 */
export const CLASSIFY_MAX_DISTANCE_KM = 2;

/**
 * 资格判定 eligible(sourceVisit, targetVisit)：
 * - 目标必须是已排期（dayRef !== null）的大景点，且不等于源自身；
 * - 双方 Item 均有坐标 → haversineKm ≤ CLASSIFY_MAX_DISTANCE_KM 才合格；
 * - 任一方无坐标 → 兜底为「同天」（target.dayRef === source.dayRef）才合格。
 */
export function isEligibleClassifyTarget(trip: Trip, source: Visit, target: Visit): boolean {
  if (target.visitId === source.visitId) return false;
  if (target.kind !== "large_attraction") return false;
  if (target.dayRef === null) return false;
  const sourceCoords = resolveItemCoords(trip.itemRegistry[source.pointRef] ?? null);
  const targetCoords = resolveItemCoords(trip.itemRegistry[target.pointRef] ?? null);
  if (sourceCoords !== null && targetCoords !== null) {
    return haversineKm(sourceCoords, targetCoords) <= CLASSIFY_MAX_DISTANCE_KM;
  }
  return target.dayRef === source.dayRef;
}

/**
 * 源普通景点的合格归类目标列表（按 trip.visits 插入顺序，与旧全局列表同序）。
 * VisitCard 用 length > 0 决定按钮显示；TripView 归类浮层直接用它渲染目标项。
 */
export function eligibleClassifyTargets(trip: Trip, source: Visit): Visit[] {
  return Object.values(trip.visits).filter((target) =>
    isEligibleClassifyTarget(trip, source, target),
  );
}
