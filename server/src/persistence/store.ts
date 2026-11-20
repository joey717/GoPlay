import type {
  Constraint,
  Day,
  EntityRef,
  Item,
  LodgingPlan,
  SourceEvidence,
  Stop,
  Trip,
  Visit,
} from "@goplay/shared";
import { SCHEMA_VERSION, recomputeDayTimeline, recomputeDerivedFields, validateConsistency } from "@goplay/shared";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.join(import.meta.dirname, "../../data");
const TRIP_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Task #65：攻略截图原图目录（按 tripId 分隔，随行程删除整体清理；.gitignore 已排除） */
export const UPLOADS_DIR = path.join(import.meta.dirname, "../../uploads");

/** 某行程的截图目录；tripId 非法时抛错（与 tripPath 同一校验） */
export function tripUploadsDir(tripId: string): string {
  assertTripId(tripId);
  return path.join(UPLOADS_DIR, tripId);
}

/** 供路由层复用的 tripId UUID 校验 */
export function isValidTripId(tripId: string): boolean {
  return TRIP_ID_PATTERN.test(tripId);
}

function assertTripId(tripId: string): void {
  if (!TRIP_ID_PATTERN.test(tripId)) throw new Error("tripId 必须是合法 UUID");
}

function tripPath(tripId: string): string {
  assertTripId(tripId);
  return path.join(DATA_DIR, `${tripId}.json`);
}

/**
 * schemaVersion 终检（S1-5 rev2）：读时自动迁移（migrateV1toV2）已把低版本行程
 * 升至最新版本，此处只拦截迁移无法覆盖的异常值——高于当前版本的未来数据
 * （不可降级迁移，拒载以免损坏）等。消息用 JSON.stringify 以区分数值 2 与字符串 "2"。
 */
function assertSchemaVersion(trip: Trip): void {
  if (trip.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `行程 schemaVersion 异常（当前为 ${JSON.stringify(trip.schemaVersion) ?? String(trip.schemaVersion)}，仅接受 ${SCHEMA_VERSION}；未来版本数据不可降级载入）`,
    );
  }
}

// ===== 存量迁移（S1-5 rev2：读时自动迁移、惰性写回） =====

/**
 * v1 → v2 读时自动迁移（rev2 契约差量，修订附录 A）。
 *
 * 四条铁律：
 * 1. schemaVersion 缺失视为 1（v1 存量）；迁移后写 SCHEMA_VERSION；
 * 2. 只覆盖 rev2 契约差量，不做通用迁移框架，不动其余字段；
 * 3. Leg.source 迁移默认 "user"——不对称安全：标错 user 最多损失一次 AI 重估，
 *    标错 ai_estimate 则 AI 可能覆盖用户填过的值；
 * 4. 幂等：migrateV1toV2(migrateV1toV2(x)) 与 migrateV1toV2(x) 深度相等——
 *    已有 hotelRefs 不重建、已有 hotelRegistry 不覆盖、已有 source 的 Leg 不改、
 *    已有 sourceMentionRefs 的 Visit 不改；v1 专属字段（status / hotelCandidate）
 *    在同一次迁移内上移 / 删除，因此二次执行均为无操作。
 *
 * 差量内容（v1 → v2）：
 * a. lodging.hotelCandidate → trip.hotelRegistry[hotelId] + lodging.hotelRefs = [hotelId]
 *    （hotelId = shId；无 shId 生成 UUID，经 candidate.id / registry / hotelRefs
 *    三处引用固定，同一次迁移内不重复生成）；
 * b. 删除 lodging.status（选中态改由 hotelRegistry / hotelRefs 推导）；
 * c. 删除 lodging.hotelCandidate（数据已上移 registry）；
 * d. Visit.externalLeg 补 source: "user"；
 * e. Visit 补 sourceMentionRefs: []；
 * f. trip.hotelRegistry 缺失时初始化 {}；
 * g. schemaVersion = SCHEMA_VERSION。
 *
 * 就地修改并返回同一对象（读时内存升级，下次 save 自然写回，不立即写文件）。
 * 入参 any：v1 存量结构与 Trip 新类型不完全匹配。
 *
 * 注（B1 攻略契约，修订附录 B v0.3）：guideSources 等新增字段不提升 schemaVersion，
 * 不在本函数内补齐，而由 ensureGuideContract 在读取边界补空表，保持 v1→v2 差量纯粹。
 */
export function migrateV1toV2(trip: any): Trip {
  if (typeof trip !== "object" || trip === null || Array.isArray(trip)) {
    throw new Error("migrateV1toV2：入参必须是 Trip 形状的对象");
  }

  // 差量 f：hotelRegistry 初始化（已存在则保持原样，保证幂等）
  if (typeof trip.hotelRegistry !== "object" || trip.hotelRegistry === null || Array.isArray(trip.hotelRegistry)) {
    trip.hotelRegistry = {};
  }

  // 差量 a/b/c：lodgings 逐日迁移（key = String(dayIndex)）
  if (typeof trip.lodgings === "object" && trip.lodgings !== null) {
    for (const key of Object.keys(trip.lodgings)) {
      const lodging = trip.lodgings[key];
      if (typeof lodging !== "object" || lodging === null) continue;
      const candidate = lodging.hotelCandidate;
      if (typeof candidate === "object" && candidate !== null) {
        // hotelId：飞猪酒店 = shId；无 shId（自定义 / 脏数据）生成 UUID 稳定主键
        const hotelId =
          typeof candidate.shId === "string" && candidate.shId !== "" ? candidate.shId : crypto.randomUUID();
        // 补 id 字段（v1 HotelCandidate 无 id；已有则不覆盖）
        if (candidate.id === null || candidate.id === undefined) {
          candidate.id = hotelId;
        }
        // 写入 registry（已有同 key 条目不覆盖，保证幂等与不丢数据）
        if (!Object.prototype.hasOwnProperty.call(trip.hotelRegistry, hotelId)) {
          trip.hotelRegistry[hotelId] = candidate;
        }
        // v1 单候选语义：hotelRefs = [hotelId]；已有非空 refs 不重建（不覆盖用户可见引用）
        if (!Array.isArray(lodging.hotelRefs) || lodging.hotelRefs.length === 0) {
          lodging.hotelRefs = [hotelId];
        }
      } else if (!Array.isArray(lodging.hotelRefs)) {
        // 无候选：hotelRefs 缺失才补空（已有则不动）
        lodging.hotelRefs = [];
      }
      // 差量 b/c：v1 专属字段内存中移除（delete 对不存在的属性是无操作，天然幂等）
      delete lodging.status;
      delete lodging.hotelCandidate;
    }
  }

  // 差量 d/e：visits 逐个补全
  if (typeof trip.visits === "object" && trip.visits !== null) {
    for (const key of Object.keys(trip.visits)) {
      const visit = trip.visits[key];
      if (typeof visit !== "object" || visit === null) continue;
      // 铁律 3：Leg.source 默认 "user"（不对称安全；已有值不改）
      if (
        typeof visit.externalLeg === "object" &&
        visit.externalLeg !== null &&
        (visit.externalLeg.source === null || visit.externalLeg.source === undefined)
      ) {
        visit.externalLeg.source = "user";
      }
      // 差量 e：sourceMentionRefs 缺失才补空（已有则不动）
      if (!Array.isArray(visit.sourceMentionRefs)) {
        visit.sourceMentionRefs = [];
      }
    }
  }

  // 差量 g：版本号写最新
  trip.schemaVersion = SCHEMA_VERSION;

  return trip as Trip;
}

/**
 * 攻略来源注册表兼容补齐（修订附录 B v0.3，B1）——读取边界稳定兜底。
 *
 * 为何独立于 migrateV1toV2：
 * - 附录 B 只新增可选字段、未要求提升 schemaVersion（保持 2），因此不做版本迁移，
 *   避免把已落盘的 v2 行程当作低版本再跑一次无意义的版本差量；
 * - 只补缺失的 guideSources 空表（缺失 = 空表），不初始化 Visit/Stop.guideSnippets
 *   （可选字段按空数组读取），不反推历史 evidence，不触碰既有来源表 / 草案快照；
 * - 幂等：已有对象原样返回；null 视为缺失；数组 / 字符串等损坏形态原样保留，
 *   交由 validateConsistency 报错，避免静默丢数据。
 */
export function ensureGuideContract(trip: any): Trip {
  if (typeof trip !== "object" || trip === null || Array.isArray(trip)) {
    throw new Error("ensureGuideContract：入参必须是 Trip 形状的对象");
  }
  if (trip.guideSources === undefined || trip.guideSources === null) {
    trip.guideSources = {};
  }
  return trip as Trip;
}

/** 原子写：先写临时文件再 rename，避免半写入 */
async function writeTripFile(trip: Trip): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const targetPath = tripPath(trip.tripId);
  const temporaryPath = path.join(DATA_DIR, `${trip.tripId}.tmp.json`);
  await fs.writeFile(temporaryPath, `${JSON.stringify(trip, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, targetPath);
}

// ===== 创建种子 =====

/**
 * POST /api/trip 的创建参数（Task #66）：destination / constraints 可省略；
 * dateRange 缺省或非法时拒绝创建（不伪造日期、不再回退示例模板）。
 */
export interface CreateTripSeed {
  destination?: { city: string; cityCode?: string | null };
  dateRange?: { start: string; end: string; nights: number };
  /** 已定约束（InitFlow Step 2 录入）；形状非法或 dayIndex 越界的条目在创建时被丢弃 */
  constraints?: unknown;
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

function addDays(isoDate: string, offset: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + offset * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * 校验 dateRange 合法性（Task #66 修正日期口径）：
 * ISO 日期 + nights 整数 1..30 + end - start 的天数差恰为 nights（不加一天）。
 * 例：2026-11-08 → 2026-11-12 为 nights=4（5 天，含出发和返程日），与 InitFlow 传入口径一致。
 * 非法返回 null。
 */
function normalizeDateRange(value: unknown): { start: string; end: string; nights: number } | null {
  if (typeof value !== "object" || value === null) return null;
  const { start, end, nights } = value as { start?: unknown; end?: unknown; nights?: unknown };
  if (typeof start !== "string" || !ISO_DATE_PATTERN.test(start)) return null;
  if (typeof end !== "string" || !ISO_DATE_PATTERN.test(end)) return null;
  if (typeof nights !== "number" || !Number.isInteger(nights) || nights < 1 || nights > 30) return null;
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  if (Math.round((endMs - startMs) / MS_PER_DAY) !== nights) return null;
  return { start, end, nights };
}

/** shared Constraint.type 白名单（seed 清洗用） */
const CONSTRAINT_TYPE_SET: ReadonlySet<string> = new Set([
  "flight_arrive",
  "flight_depart",
  "hotel_checkin",
  "hotel_checkout",
  "ticket_date",
  "custom",
]);

/**
 * 清洗 seed.constraints（Task #66）：只保留形状合法且 dayIndex 落在行程内的条目，
 * 非法条目直接丢弃（不伪造、不放宽）；label 缺省时按类型与时间生成可读文案。
 */
function normalizeSeedConstraints(value: unknown, totalDays: number): Constraint[] {
  if (!Array.isArray(value)) return [];
  const normalized: Constraint[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as Partial<Constraint>;
    if (typeof candidate.type !== "string" || !CONSTRAINT_TYPE_SET.has(candidate.type)) continue;
    if (typeof candidate.anchorTime !== "string" || candidate.anchorTime.trim() === "") continue;
    if (
      typeof candidate.dayIndex !== "number" ||
      !Number.isInteger(candidate.dayIndex) ||
      candidate.dayIndex < 1 ||
      candidate.dayIndex > totalDays
    ) {
      continue;
    }
    const label =
      typeof candidate.label === "string" && candidate.label.trim() !== ""
        ? candidate.label.trim()
        : `${candidate.type} ${candidate.anchorTime.slice(11)}`;
    normalized.push({
      constraintId:
        typeof candidate.constraintId === "string" && candidate.constraintId.trim() !== ""
          ? candidate.constraintId
          : crypto.randomUUID(),
      type: candidate.type as Constraint["type"],
      anchorTime: candidate.anchorTime,
      dayIndex: candidate.dayIndex,
      label,
      locked: true,
    });
  }
  return normalized;
}

/**
 * 用户 seed 驱动的空白行程骨架（Task #66）：只落地 seed 中的日期 / 目的地 / 已定约束。
 * 每个 day 仅初始化 departTime（null）与 lodging（null）、scheduleVisitRefs 为空数组；
 * itemRegistry / visits / stops / evidences / lodgings 全空，无任何预置示例数据。
 */
function buildBlankTrip(
  tripId: string,
  now: string,
  destination: { city: string; cityCode: string | null },
  dateRange: { start: string; end: string; nights: number },
  constraints: Constraint[],
): Trip {
  const totalDays = dateRange.nights + 1;
  const dayRefs: string[] = [];
  const days: Record<string, Day> = {};
  for (let dayIndex = 1; dayIndex <= totalDays; dayIndex++) {
    const dayId = `day_${dayIndex}`;
    dayRefs.push(dayId);
    days[dayId] = {
      dayId,
      dayIndex,
      date: addDays(dateRange.start, dayIndex - 1),
      departTime: null,
      departTimeOverridden: false,
      scheduleVisitRefs: [],
      lodging: null,
    };
  }
  return {
    tripId,
    schemaVersion: SCHEMA_VERSION,
    version: 1,
    destination,
    dateRange: { ...dateRange },
    dayRefs,
    days,
    lodgings: {},
    hotelRegistry: {},
    guideSources: {},
    itemRegistry: {},
    visits: {},
    stops: {},
    evidences: {},
    globalCandidateRefs: [],
    pendingStopRefs: [],
    relationshipSuggestions: {},
    constraints,
    createdAt: now,
    updatedAt: now,
  };
}

// ===== 标准三亚验收 Trip（fixture 专用，Task #66 隔离）=====
//
// 仅供 fixture / verify / capture 脚本经 buildFixtureSanyaTrip / createFixtureSanyaTrip
// 显式调用；正常创建路径（tripStore.create / buildTripFromSeed）绝不调用，
// 避免示例数据（蜈支洲岛 / 第一市场等）混入用户新建行程。
//
// 结构性验收样本（Task #49）：固定实体 ID 便于断言与前端联调；覆盖任务书要求的全部要素：
// - 普通 Visit（第一市场，Day3）
// - 大景区 Visit + 3 个 attached Stop（蜈支洲岛 + 情人桥/海滨浴场/观日岩，Day2）
// - global candidate（大小洞天，custom point）
// - pending Stop（椰子鸡小吃店，medium 建议 → suggestedVisitRef 指向蜈支洲岛）
// - 航班约束（MU5831 落地 / MU5832 起飞）与片区/住宿状态（海棠湾 placeholder × 4 晚）
// - 一条 note_text 证据（4 条 mentions），支撑 evidence → item/stop 的引用链
//
// POI 字段来源：docs/flyai-samples/search-toolcall.json（2026-10-14 flyai-cli 真实捕获，
// jumpUrl / mainPic 均为飞猪真实链接，禁止替换为首页或伪造链接）。
// custom 点位（第一市场 / 大小洞天 / 小吃店）不伪造供应商字段（mainPic/jumpUrl 恒 null）。
//
// 注意 item_wzz.suggestMinutes=null：大景区时长演示 childStop 汇总（40+90+60=190 分钟）。

function buildSanyaItems(now: string): {
  itemRegistry: Record<string, Item>;
  evidence: SourceEvidence;
} {
  void now;
  const evidence: SourceEvidence = {
    evidenceId: "ev_note_1",
    kind: "note_text",
    noteIndex: 1,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions: [
      {
        mentionId: "m1",
        text: "蜈支洲岛",
        quoteText: "Day2 一整天留给蜈支洲岛，记得早去避堵",
        bbox: null,
        extractedName: "蜈支洲岛",
        locationHint: null,
        modelSummary: "第二天全天游览蜈支洲岛，建议早点出发",
      },
      {
        mentionId: "m2",
        text: "情人桥",
        quoteText: "上岛先走情人桥，铁索桥有点晃，大概40分钟",
        bbox: null,
        extractedName: "情人桥",
        locationHint: null,
        modelSummary: "情人桥约 40 分钟",
      },
      {
        mentionId: "m3",
        text: "海滨浴场",
        quoteText: "中午到海滨浴场游泳，沙子很细，建议留足一个半小时",
        bbox: null,
        extractedName: "海滨浴场",
        locationHint: null,
        modelSummary: "海滨浴场约 90 分钟",
      },
      {
        mentionId: "m4",
        text: "观日岩",
        quoteText: "下午去观日岩看海，凭海临风视野最好，一小时足够",
        bbox: null,
        extractedName: "观日岩",
        locationHint: null,
        modelSummary: "观日岩约 60 分钟",
      },
    ],
  };

  const fliggyItem = (itemId: string, name: string, providerId: string, fields: Partial<Item>): Item => ({
    itemId,
    name,
    origin: "fliggy",
    providerId,
    address: null,
    category: null,
    coords: null,
    suggestMinutes: null,
    mainPic: null,
    ticketInfo: null,
    jumpUrl: null,
    sourceEvidenceRefs: ["ev_note_1"],
    ...fields,
  });

  const itemRegistry: Record<string, Item> = {
    item_wzz: fliggyItem("item_wzz", "蜈支洲岛", "99", {
      address: "海南省三亚市海棠区海棠湾镇林旺蜈支洲岛",
      category: "沙滩海岛",
      coords: { lng: 109.765947, lat: 18.310381 },
      // 故意 null：演示大景区时长由 childStop 汇总得出（40+90+60=190）
      suggestMinutes: null,
      mainPic: "https://img.alicdn.com/imgextra/i4/6000000003770/O1CN01cvdFpDaVErK43lYM_!!6000000003770-0-fliggyimage.jpg",
      jumpUrl: "https://router.feizhu.com/multi/webview?url=https%3A%2F%2Frouter.feizhu.com%2Fws%2F18mEhx",
    }),
    item_bridge: fliggyItem("item_bridge", "情人桥", "14290139", {
      address: "海南省三亚市海棠区海棠湾镇情人街三亚蜈支洲岛旅游区",
      category: "山湖田园",
      coords: { lng: 109.762405, lat: 18.313446 },
      mainPic: "https://img.alicdn.com/tfscom/TB143MiXDMG5uJjSZFASuvmspXa",
      jumpUrl: "https://router.feizhu.com/multi/webview?url=https%3A%2F%2Frouter.feizhu.com%2Fws%2F1b45QY",
    }),
    item_beach: fliggyItem("item_beach", "蜈支洲岛海滨浴场", "14937691", {
      address: "海南省三亚市海棠区海棠湾镇蜈支洲岛三亚蜈支洲岛度假中心内",
      category: "沙滩海岛",
      coords: { lng: 109.760321, lat: 18.313329 },
      mainPic: "https://img.alicdn.com/imgextra/i1/O1CN01BOOXs21tVuTg0ug4D_!!0-alitrip.jpg",
      jumpUrl: "https://router.feizhu.com/multi/webview?url=https%3A%2F%2Frouter.feizhu.com%2Fws%2F14v7RI",
    }),
    item_rock: fliggyItem("item_rock", "蜈支洲岛旅游风景区-观日岩", "163572", {
      address: "海南省三亚市海棠区海棠湾镇蜈支洲岛三亚蜈支洲岛度假中心内",
      category: "自然风光",
      coords: { lng: 109.770544, lat: 18.308285 },
      mainPic: "https://img.alicdn.com/tfscom/TB1S8ygeJrJ8KJjSspaSutuKpXa",
      jumpUrl: "https://router.feizhu.com/multi/webview?url=https%3A%2F%2Frouter.feizhu.com%2Fws%2F3pzB6i",
    }),
    item_market: {
      itemId: "item_market",
      name: "第一市场",
      origin: "custom",
      providerId: null,
      address: null,
      category: null,
      coords: null,
      suggestMinutes: 120,
      mainPic: null,
      ticketInfo: null,
      jumpUrl: null,
      sourceEvidenceRefs: [],
    },
    item_daxiaodongtian: {
      itemId: "item_daxiaodongtian",
      name: "大小洞天",
      origin: "custom",
      providerId: null,
      address: null,
      category: null,
      coords: null,
      suggestMinutes: 120,
      mainPic: null,
      ticketInfo: null,
      jumpUrl: null,
      sourceEvidenceRefs: [],
    },
  };

  return { itemRegistry, evidence };
}

/** 标准三亚验收行程：固定实体 ID 的结构性夹具（仅 fixture 显式调用，正常创建路径不使用） */
export function buildFixtureSanyaTrip(tripId: string, now: string): Trip {
  const { itemRegistry, evidence } = buildSanyaItems(now);

  const stops: Record<string, Stop> = {
    stop_bridge: {
      stopId: "stop_bridge",
      state: "attached",
      visitRef: "visit_wzz",
      suggestedVisitRef: null,
      matchedPointRef: "item_bridge",
      customName: null,
      order: 0,
      suggestMinutes: 40,
      locationHint: "上岛后先走铁索桥",
      ticketRelation: "included",
      sourceEvidenceRefs: ["ev_note_1"],
      sourceMentionRefs: ["ev_note_1:m2"],
      userAdjusted: false,
      removedFromOrder: null,
      removedAt: null,
    },
    stop_beach: {
      stopId: "stop_beach",
      state: "attached",
      visitRef: "visit_wzz",
      suggestedVisitRef: null,
      matchedPointRef: "item_beach",
      customName: null,
      order: 1,
      suggestMinutes: 90,
      locationHint: "岛西北角白沙滩",
      ticketRelation: "included",
      sourceEvidenceRefs: ["ev_note_1"],
      sourceMentionRefs: ["ev_note_1:m3"],
      userAdjusted: false,
      removedFromOrder: null,
      removedAt: null,
    },
    stop_rock: {
      stopId: "stop_rock",
      state: "attached",
      visitRef: "visit_wzz",
      suggestedVisitRef: null,
      matchedPointRef: "item_rock",
      customName: null,
      order: 2,
      suggestMinutes: 60,
      locationHint: "岛东南悬崖处",
      ticketRelation: "included",
      sourceEvidenceRefs: ["ev_note_1"],
      sourceMentionRefs: ["ev_note_1:m4"],
      userAdjusted: false,
      removedFromOrder: null,
      removedAt: null,
    },
    // pending 样本：medium 建议归属蜈支洲岛，等待用户确认归类后才会挂载
    stop_snack: {
      stopId: "stop_snack",
      state: "pending",
      visitRef: null,
      suggestedVisitRef: "visit_wzz",
      matchedPointRef: null,
      customName: "入口左转椰子鸡小吃店",
      order: null,
      suggestMinutes: 30,
      locationHint: "蜈支洲岛入口左转",
      ticketRelation: "separate",
      sourceEvidenceRefs: [],
      sourceMentionRefs: [],
      userAdjusted: false,
      removedFromOrder: null,
      removedAt: null,
    },
  };

  const visits: Record<string, Visit> = {
    visit_wzz: {
      visitId: "visit_wzz",
      dayRef: "day_2",
      pointRef: "item_wzz",
      kind: "large_attraction",
      visitMode: "full_day",
      order: 0,
      windowStart: null,
      windowEnd: null,
      startTime: null,
      endTime: null,
      startTimeOverridden: false,
      endTimeOverridden: false,
      reservedMinutes: null,
      effectiveMinutes: null,
      externalLeg: { mode: "驾车", minutes: 30, note: null, source: "user" },
      childStopRefs: ["stop_bridge", "stop_beach", "stop_rock"],
      alternateStopRefs: [],
      sourceMentionRefs: [],
      purchaseState: "unknown",
      locked: false,
      userAdjusted: false,
      removedFrom: null,
      removedAt: null,
    },
    visit_market: {
      visitId: "visit_market",
      dayRef: "day_3",
      pointRef: "item_market",
      kind: "ordinary",
      visitMode: "custom",
      order: 0,
      windowStart: null,
      windowEnd: null,
      startTime: null,
      endTime: null,
      startTimeOverridden: false,
      endTimeOverridden: false,
      reservedMinutes: null,
      effectiveMinutes: null,
      externalLeg: { mode: "驾车", minutes: 30, note: null, source: "user" },
      childStopRefs: [],
      alternateStopRefs: [],
      sourceMentionRefs: [],
      purchaseState: "unknown",
      locked: false,
      userAdjusted: false,
      removedFrom: null,
      removedAt: null,
    },
  };

  const days: Record<string, Day> = {
    // 到达日：MU5831 落地 09:40，10:30 出发，不排景点
    day_1: {
      dayId: "day_1",
      dayIndex: 1,
      date: "2026-11-08",
      departTime: "10:30",
      departTimeOverridden: false,
      scheduleVisitRefs: [],
      lodging: { kind: "lodging", dayIndex: 1 },
    },
    // 蜈支洲岛一日（大景区 + 内部玩法）
    day_2: {
      dayId: "day_2",
      dayIndex: 2,
      date: "2026-11-09",
      departTime: "08:30",
      departTimeOverridden: false,
      scheduleVisitRefs: ["visit_wzz"],
      lodging: { kind: "lodging", dayIndex: 2 },
    },
    day_3: {
      dayId: "day_3",
      dayIndex: 3,
      date: "2026-11-10",
      departTime: "09:00",
      departTimeOverridden: false,
      scheduleVisitRefs: ["visit_market"],
      lodging: { kind: "lodging", dayIndex: 3 },
    },
    day_4: {
      dayId: "day_4",
      dayIndex: 4,
      date: "2026-11-11",
      departTime: "09:00",
      departTimeOverridden: false,
      scheduleVisitRefs: [],
      lodging: { kind: "lodging", dayIndex: 4 },
    },
    // 返程日：MU5832 起飞 18:00，无住宿
    day_5: {
      dayId: "day_5",
      dayIndex: 5,
      date: "2026-11-12",
      departTime: "09:00",
      departTimeOverridden: false,
      scheduleVisitRefs: [],
      lodging: null,
    },
  };

  const lodgings: Record<string, LodgingPlan> = {};
  for (let dayIndex = 1; dayIndex <= 4; dayIndex++) {
    lodgings[String(dayIndex)] = {
      dayIndex,
      areaName: "海棠湾",
      hotelRefs: [],
      checkInTime: null,
      checkOutTime: null,
      purchaseState: "unknown",
      locked: false,
      userAdjusted: false,
    };
  }

  const constraints: Constraint[] = [
    {
      constraintId: "constraint_mu5831_arrive",
      type: "flight_arrive",
      anchorTime: "2026-11-08T09:40:00",
      dayIndex: 1,
      label: "MU5831 落地 09:40",
      locked: true,
    },
    {
      constraintId: "constraint_mu5832_depart",
      type: "flight_depart",
      anchorTime: "2026-11-12T18:00:00",
      dayIndex: 5,
      label: "MU5832 起飞 18:00",
      locked: true,
    },
  ];

  const globalCandidateRefs: EntityRef[] = [{ kind: "point", id: "item_daxiaodongtian" }];

  let trip: Trip = {
    tripId,
    schemaVersion: SCHEMA_VERSION,
    version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: "2026-11-12", nights: 4 },
    dayRefs: ["day_1", "day_2", "day_3", "day_4", "day_5"],
    days,
    lodgings,
    hotelRegistry: {},
    guideSources: {},
    itemRegistry,
    visits,
    stops,
    evidences: { ev_note_1: evidence },
    globalCandidateRefs,
    pendingStopRefs: ["stop_snack"],
    relationshipSuggestions: {
      stop_snack: {
        stopRef: "stop_snack",
        suggestedVisitRef: "visit_wzz",
        level: "medium",
        positiveSignals: ["位置提示指向蜈支洲岛入口动线", "与情人桥/海滨浴场同属一天行程"],
        negativeSignals: [],
        decidedBy: "system",
      },
    },
    constraints,
    createdAt: now,
    updatedAt: now,
  };

  // 预填时间轴：Day2 大景区（09:00-12:10，190 分钟汇总）与 Day3 普通景点（09:30-11:30）
  for (let dayIndex = 1; dayIndex <= 5; dayIndex++) {
    trip = recomputeDayTimeline(trip, dayIndex);
  }
  // Task #280：夹具预填 day 角色（验收断言依赖；与 save/load 路径同源派生）
  trip = recomputeDerivedFields(trip);
  return trip;
}

/**
 * 显式生成标准三亚验收行程并落盘（fixture / verify / capture 脚本专用）。
 * 返回已写入的 Trip；正常创建路径（tripStore.create）永不调用本函数。
 */
export async function createFixtureSanyaTrip(): Promise<Trip> {
  const now = new Date().toISOString();
  const trip = buildFixtureSanyaTrip(crypto.randomUUID(), now);
  const errors = validateConsistency(trip);
  if (errors.length > 0) {
    throw new Error(`验收夹具行程未通过一致性校验：${errors.slice(0, 3).join("；")}`);
  }
  await writeTripFile(trip);
  return trip;
}

/**
 * 创建分流（Task #66）：唯一路径是「用户 seed 驱动的空白骨架」——
 * 只落地 seed 中的目的地 / 日期 / 已定约束，不预置任何 Visit / Stop / Evidence / Item；
 * 标准三亚验收数据仅经 buildFixtureSanyaTrip / createFixtureSanyaTrip 显式生成。
 * dateRange 缺省或非法时拒绝创建（不伪造日期、不回退示例模板）。
 */
function buildTripFromSeed(seed: CreateTripSeed, now: string): Trip {
  const dateRange = normalizeDateRange(seed.dateRange);
  if (dateRange === null) {
    throw new Error(
      "创建行程必须提供合法 dateRange（ISO 日期；end = start + nights，nights 为 1..30 的整数）",
    );
  }
  // 目的地缺省时按当前产品口径落到三亚（M1 仅开放三亚；InitFlow 始终显式传入）
  const city = seed.destination?.city?.trim() || "三亚";
  const cityCode = seed.destination?.cityCode ?? null;
  return buildBlankTrip(
    crypto.randomUUID(),
    now,
    { city, cityCode },
    dateRange,
    normalizeSeedConstraints(seed.constraints, dateRange.nights + 1),
  );
}

export const tripStore = {
  /**
   * 读取行程；文件不存在返回 null。
   * S1-5 rev2 读时自动迁移：schemaVersion 缺失视为 1（含 v1 存量 "1.1" 字符串，
   * "1.1" < 2 同样命中），低于最新版本即在内存升级（migrateV1toV2），
   * 下次 save 自然写回，不立即写文件。
   * 文件损坏（JSON 解析失败 / 内容非对象）时拒载：console.error 明确提示并抛出
   * 可识别错误（路由层转错误响应），原文件保留不删不覆盖、引导用户重建。
   */
  async load(tripId: string): Promise<Trip | null> {
    const filePath = tripPath(tripId);
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      console.error(`[persistence] 行程文件 JSON 解析失败，已拒载（原文件保留未改动）：${filePath}`, error);
      throw new Error(`行程文件损坏（JSON 解析失败），已拒载并保留原文件：${filePath}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.error(`[persistence] 行程文件内容不是 Trip 对象，已拒载（原文件保留未改动）：${filePath}`);
      throw new Error(`行程文件损坏（内容不是 Trip 对象），已拒载并保留原文件：${filePath}`);
    }
    let trip = parsed as Trip;
    // 铁律 1：schemaVersion 缺失视为 1；低于最新版本即读时迁移（内存升级、惰性写回）
    if (!trip.schemaVersion || trip.schemaVersion < SCHEMA_VERSION) {
      trip = migrateV1toV2(trip);
    }
    // B1：先做版本终检，再补攻略来源空表（不触碰未来版本数据）
    assertSchemaVersion(trip);
    trip = ensureGuideContract(trip);
    // Task #280：读时迁移路径补齐旧 Trip 缺失的 day 角色（派生字段，不提升 schemaVersion）
    trip = recomputeDerivedFields(trip);
    return trip;
  },

  /**
   * 保存行程（rev2 契约）：
   * 1. tripId 合法性校验；
   * 2. 铁律 1：保存时统一写最新版本号 SCHEMA_VERSION（读时迁移的行程由此自然写回 v2）；
   *    高于当前版本的未来数据拒绝写入（不可降级覆盖，防静默损坏）；入参低于最新
   *    版本时先按读时迁移语义补齐，避免「标记 v2 但结构仍是 v1」的半迁移落盘；
   * 3. 写入前 validateConsistency，任一违规即整次拒绝（不落盘、不留半写入）；
   * 4. 校验通过后 version 自增（乐观锁基准）并原子写。
   */
  async save(trip: Trip): Promise<void> {
    assertTripId(trip.tripId);
    if (trip.schemaVersion !== undefined && trip.schemaVersion > SCHEMA_VERSION) {
      throw new Error(
        `拒绝保存未来版本行程（schemaVersion=${JSON.stringify(trip.schemaVersion)} > ${SCHEMA_VERSION}）：不可降级覆盖`,
      );
    }
    if (!trip.schemaVersion || trip.schemaVersion < SCHEMA_VERSION) {
      // 防御：低版本入参按读时迁移语义补齐（migrateV1toV2 就地修改并盖版本号）
      migrateV1toV2(trip);
    }
    trip.schemaVersion = SCHEMA_VERSION;
    // B1：落盘前同样保证攻略注册表存在（只补空表，不改 schemaVersion / 不反推证据）
    ensureGuideContract(trip);
    // Task #280：派生字段重算（day 角色）——落盘前统一覆盖，外部传入的 role 一律被派生结果替换
    recomputeDerivedFields(trip);
    const errors = validateConsistency(trip);
    if (errors.length > 0) {
      const preview = errors.slice(0, 3).join("；");
      throw new Error(
        `行程一致性校验失败，已拒绝写入：${preview}${errors.length > 3 ? `（共 ${errors.length} 条问题）` : ""}`,
      );
    }
    trip.version = (Number.isInteger(trip.version) ? trip.version : 0) + 1;
    trip.updatedAt = new Date().toISOString();
    await writeTripFile(trip);
  },

  /**
   * 创建新行程（Task #66）：按 seed 生成空白骨架（目的地 / 日期 / 已定约束），
   * 不注入任何示例数据；dateRange 缺省或非法时直接拒绝。
   * 初始 version=1（写盘不 bump；后续 save 才自增），写入前同样过一致性校验。
   */
  async create(seed: CreateTripSeed = {}): Promise<Trip> {
    const now = new Date().toISOString();
    const trip = buildTripFromSeed(seed, now);
    // Task #290：与 save/load 对齐——新建行程落盘前重算派生字段（role / timeSourceLabel），
    // 使「跳过片区」直接进行程页的首屏即带正确派生值，避免读时有、新建时没有的不对称。
    recomputeDerivedFields(trip);
    const errors = validateConsistency(trip);
    if (errors.length > 0) {
      throw new Error(`生成的行程未通过一致性校验：${errors.slice(0, 3).join("；")}`);
    }
    await writeTripFile(trip);
    return trip;
  },

  /**
   * 删除行程（Task #65）：删除 Trip JSON 后同步删除该行程的截图目录，
   * 避免 uploads 孤儿文件。行程不存在时幂等返回 false。
   */
  async deleteTrip(tripId: string): Promise<boolean> {
    const filePath = tripPath(tripId);
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    await fs.rm(tripUploadsDir(tripId), { recursive: true, force: true });
    return true;
  },
};
