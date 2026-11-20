/**
 * 只读分享路由（Task #205 / #261）。
 *
 * 两条互相独立的通道，共用同一次 tripStore 现读（不做快照、不缓存）：
 *
 * 1) GET /api/share/:tripId        → 脱敏 SharedTrip（JSON，SPA 渲染用）
 *    GET /api/share/:tripId/og     → 分享预览数据（JSON，前端/自检用；Task #261）
 *    - 每次现读 tripStore，响应头 Cache-Control: no-store；
 *    - 返回脱敏后的 SharedTrip（见 ./sanitize.ts），不含攻略原文 / 原图 / 来源链接；
 *    - 行程不存在（含非法 tripId）统一 404，不区分「格式错」与「已删除」，避免探测；
 *    - 读取失败（文件损坏等）500 + 安全文案，不透传底层路径细节。
 *
 * 2) GET /share/:tripId             → 带 OG meta 的 HTML（社交平台预览，Task #261）
 *    挂在根路径（非 /api）：爬虫不执行 JS，必须由服务端把 og:title / og:description /
 *    og:image / og:url 直接写进首屏 HTML。构建产物存在时注入 web/dist/index.html
 *    （浏览器照旧由 SPA 渲染），否则返回最小壳并跳转 Vite dev server（见 ./og.ts）。
 *
 * 无需登录 / 无本地 Trip：接收方浏览器直接打开链接即可读取。
 *
 * 3) PATCH /api/share/:tripId/status → 受限状态打标（Task #260）
 *    只允许改 Visit / LodgingPlan 的 purchaseState，整批校验后原子落盘
 *    （读 → 改 → 写，复用 tripStore），返回更新后的脱敏 SharedTrip。
 */

import { Hono } from "hono";
import type { Trip } from "@goplay/shared";
import { isValidTripId, tripStore } from "../persistence/store.js";
import { sanitizeTrip } from "./sanitize.js";
import {
  buildShareOgData,
  renderShareHtml,
  renderShareUnavailableHtml,
  requestOrigin,
} from "./og.js";

/** /api/share：JSON 数据通道 */
export const shareRoutes = new Hono();

shareRoutes.get("/:tripId", async (c) => {
  const tripId = c.req.param("tripId");
  if (!isValidTripId(tripId)) {
    return c.json({ error: "行程不存在" }, 404);
  }
  try {
    const trip = await tripStore.load(tripId);
    if (trip === null) {
      return c.json({ error: "行程不存在" }, 404);
    }
    c.header("Cache-Control", "no-store");
    return c.json(sanitizeTrip(trip));
  } catch {
    return c.json({ error: "分享的行程读取失败，请稍后重试" }, 500);
  }
});

/**
 * Task #261：分享预览数据（JSON）。与 HTML 通道同一推导函数，便于前端 / 自检核对文案，
 * 也方便在没有构建产物的环境里单独验证 OG 内容。
 */
shareRoutes.get("/:tripId/og", async (c) => {
  const tripId = c.req.param("tripId");
  if (!isValidTripId(tripId)) {
    return c.json({ error: "行程不存在" }, 404);
  }
  try {
    const trip = await tripStore.load(tripId);
    if (trip === null) {
      return c.json({ error: "行程不存在" }, 404);
    }
    const origin = requestOrigin(c.req.raw.headers);
    c.header("Cache-Control", "no-store");
    return c.json(buildShareOgData(trip, tripId, origin));
  } catch {
    return c.json({ error: "分享的行程读取失败，请稍后重试" }, 500);
  }
});

/** /share：HTML 通道（带 OG meta，供浏览器与社交平台爬虫共用同一 URL） */
export const shareHtmlRoutes = new Hono();

shareHtmlRoutes.get("/:tripId", async (c) => {
  const tripId = c.req.param("tripId");
  if (!isValidTripId(tripId)) {
    c.header("Cache-Control", "no-store");
    return c.html(renderShareUnavailableHtml("行程不存在"), 404);
  }
  try {
    const trip = await tripStore.load(tripId);
    if (trip === null) {
      c.header("Cache-Control", "no-store");
      return c.html(renderShareUnavailableHtml("行程不存在"), 404);
    }
    const origin = requestOrigin(c.req.raw.headers);
    const og = buildShareOgData(trip, tripId, origin);
    c.header("Cache-Control", "no-store");
    return c.html(renderShareHtml(og, tripId));
  } catch {
    c.header("Cache-Control", "no-store");
    return c.html(renderShareUnavailableHtml("分享的行程读取失败，请稍后重试"), 500);
  }
});

// ===== Task #260 受限状态打标 =====

/** 景点状态枚举（对齐 Visit.purchaseState，分享页允许的四态） */
const VISIT_PURCHASE_STATES = ["unknown", "toBuy", "bought", "noTicket"] as const;
/** 住宿状态枚举（对齐 LodgingPlan.purchaseState；住宿没有免票档） */
const LODGING_PURCHASE_STATES = ["unknown", "toBuy", "bought"] as const;

type VisitPurchaseState = (typeof VISIT_PURCHASE_STATES)[number];
type LodgingPurchaseState = (typeof LODGING_PURCHASE_STATES)[number];

/** 请求体（只认这两个可选数组，其余键一律忽略） */
export interface ShareStatusPatch {
  visits?: Array<{ visitId: string; purchaseState: VisitPurchaseState }>;
  lodgings?: Array<{ dayIndex: number; purchaseState: LodgingPurchaseState }>;
}

/** 校验结果：ok=false 时整批拒绝，行程不被修改 */
type ApplyResult = { ok: true } | { ok: false; message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVisitPurchaseState(value: unknown): value is VisitPurchaseState {
  return typeof value === "string" && (VISIT_PURCHASE_STATES as readonly string[]).includes(value);
}

function isLodgingPurchaseState(value: unknown): value is LodgingPurchaseState {
  return typeof value === "string" && (LODGING_PURCHASE_STATES as readonly string[]).includes(value);
}

/**
 * 校验并就地应用状态补丁（唯一写入口：只写 purchaseState）。
 *
 * 先全量校验（visitId 是否存在 / dayIndex 是否有住宿计划 / 枚举是否合法 /
 * 是否至少一项），全部通过后才写字段——任一项非法即整批拒绝，避免半批量落盘。
 * 请求体中除 visitId / dayIndex / purchaseState 以外的字段一律忽略，
 * 不可能借这个端点改锁定、排期、证据等任何其他数据。
 */
export function applyStatusPatch(trip: Trip, raw: unknown): ApplyResult {
  if (!isPlainObject(raw)) return { ok: false, message: "请求体必须是 JSON 对象" };

  const rawVisits = raw.visits;
  const rawLodgings = raw.lodgings;
  if (rawVisits !== undefined && !Array.isArray(rawVisits)) {
    return { ok: false, message: "visits 必须是数组" };
  }
  if (rawLodgings !== undefined && !Array.isArray(rawLodgings)) {
    return { ok: false, message: "lodgings 必须是数组" };
  }

  const visits = (rawVisits ?? []) as unknown[];
  const lodgings = (rawLodgings ?? []) as unknown[];
  if (visits.length === 0 && lodgings.length === 0) {
    return { ok: false, message: "没有要更新的状态" };
  }

  // 第一轮：全量校验，且不产生任何写入
  const visitTargets: Array<{ visitId: string; purchaseState: VisitPurchaseState }> = [];
  for (const entry of visits) {
    if (!isPlainObject(entry)) return { ok: false, message: "visits 的每一项必须是对象" };
    const visitId = entry.visitId;
    if (typeof visitId !== "string" || visitId === "") {
      return { ok: false, message: "visits 缺少 visitId" };
    }
    if (trip.visits[visitId] === undefined) {
      return { ok: false, message: `景点不在行程中：${visitId}` };
    }
    if (!isVisitPurchaseState(entry.purchaseState)) {
      return { ok: false, message: `景点购票状态不合法：${String(entry.purchaseState)}` };
    }
    visitTargets.push({ visitId, purchaseState: entry.purchaseState });
  }

  const lodgingTargets: Array<{ dayIndex: number; purchaseState: LodgingPurchaseState }> = [];
  for (const entry of lodgings) {
    if (!isPlainObject(entry)) return { ok: false, message: "lodgings 的每一项必须是对象" };
    const dayIndex = entry.dayIndex;
    if (typeof dayIndex !== "number" || !Number.isInteger(dayIndex) || dayIndex < 1) {
      return { ok: false, message: "lodgings 缺少合法的 dayIndex" };
    }
    if (trip.lodgings[String(dayIndex)] === undefined) {
      return { ok: false, message: `第 ${dayIndex} 天没有住宿计划` };
    }
    if (!isLodgingPurchaseState(entry.purchaseState)) {
      return { ok: false, message: `住宿预订状态不合法：${String(entry.purchaseState)}` };
    }
    lodgingTargets.push({ dayIndex, purchaseState: entry.purchaseState });
  }

  // 第二轮：只写 purchaseState（不触碰任何其他字段）
  for (const target of visitTargets) {
    trip.visits[target.visitId].purchaseState = target.purchaseState;
  }
  for (const target of lodgingTargets) {
    trip.lodgings[String(target.dayIndex)].purchaseState = target.purchaseState;
  }
  return { ok: true };
}

shareRoutes.patch("/:tripId/status", async (c) => {
  const tripId = c.req.param("tripId");
  if (!isValidTripId(tripId)) {
    return c.json({ error: "行程不存在" }, 404);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "请求体不是合法的 JSON" }, 400);
  }
  try {
    const trip = await tripStore.load(tripId);
    if (trip === null) {
      return c.json({ error: "行程不存在" }, 404);
    }
    const applied = applyStatusPatch(trip, body);
    if (!applied.ok) {
      return c.json({ error: applied.message }, 400);
    }
    // 读 → 改 → 写：tripStore.save 内部做一致性校验、version 自增与原子落盘
    await tripStore.save(trip);
    c.header("Cache-Control", "no-store");
    return c.json(sanitizeTrip(trip));
  } catch {
    return c.json({ error: "状态保存失败，请稍后重试" }, 500);
  }
});
