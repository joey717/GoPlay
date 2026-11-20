/**
 * Task #329 离线验收（不触网、不写盘）：免费场所（国际免税城）误透出购票样式修复。
 *
 * 根因链（已实测确认）：FlyAI search_poi 对「三亚 国际免税城」返回
 * freePoiStatus="UNKNOWN"、category=null、jumpUrl 非空；归一化层（normalizePoi）
 * 正确保留该字段，但 FliggyPoi → Item 装配时被丢弃，前端 commerce 又只看
 * jumpUrl !== null，于是免费购物中心透出「去飞猪购票」。
 *
 * 覆盖矩阵：
 *   S1 契约透传：ensureItem / applyPoiUpgradeToCustomItem 行为断言（含不臆造、
 *      不把读时默认回写成 null）；其余装配点与前端渲染点做源码在位断言。
 *   S2 三态判定纯函数（shared/freePoi.ts）：FREE / NOT_FREE / UNKNOWN / null 四态
 *      与 category 兜底的组合口径。
 *   S3 兜底关键词不误杀：用 server/data 全量现存 category 值与代表性真实景点名做反例。
 *   S4 存量迁移读时默认：真实 PD 行程 + .bak-task329 历史快照，缺失字段读时默认 null、
 *      不写回、不报错，且历史快照的判定结果维持既有 jumpUrl 行为（不制造回归）。
 *   S5 fix-task329 幂等与范围收敛：重复执行为空操作；custom 无 jumpUrl 的购物名不改写。
 *   S6 前端三态展示口径：commerce 三态表达式、四处「免票」标签、购票按钮降级文案在位。
 *
 * 运行：npx tsx server/src/ai/verify-task329.ts
 */

import "../env.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { Item, Trip } from "@goplay/shared";
import {
  FREE_NAME_KEYWORDS,
  SHOPPING_CATEGORY_KEYWORDS,
  isFreeAdmissionItem,
  isFreeAdmissionPoi,
  isShoppingCategory,
  isShoppingNameHit,
  itemFreePoiStatus,
  validateConsistency,
} from "@goplay/shared";
import type { FlyAIPoi } from "../flyai/client.js";
import {
  applyPoiUpgradeToCustomItem,
  emptyPoiAlignment,
  ensureItem,
  type ParsedEntry,
  type PoiAlignment,
} from "./assemble.js";
// Task #330 D：FREE_NAME_KEYWORDS / isShoppingNameHit 已提到 shared 单一数据源，改从 shared 引入
import { applyTask329Fixes, shouldMarkFree } from "../guides/fix-task329.js";
import { isValidTripId, tripStore } from "../persistence/store.js";

// ===== 断言助手（与 verify-task254 同范式：逐用例收集，末尾汇总） =====

interface CaseResult {
  label: string;
  error: string | null;
}

const results: CaseResult[] = [];

async function test(label: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
    results.push({ label, error: null });
    console.log(`PASS  ${label}`);
  } catch (error) {
    results.push({ label, error: error instanceof Error ? error.message : String(error) });
    console.log(`FAIL  ${label}：${error instanceof Error ? error.message : String(error)}`);
  }
}

function eq(actual: unknown, expected: unknown, label = ""): void {
  assert.deepEqual(actual, expected, label);
}

function ok(condition: boolean, label = "断言应成立"): void {
  assert.ok(condition, label);
}

const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const DATA_DIR = path.join(REPO_ROOT, "server/data");

/** PD 现场行程（Task #329 反馈来源）与其修复前备份 */
const PD_TRIP_ID = "0a27f726-9c93-48e8-ab68-1d62e9bc685b";
const PD_TRIP_FILE = path.join(DATA_DIR, `${PD_TRIP_ID}.json`);
const PD_TRIP_BACKUP = `${PD_TRIP_FILE}.bak-task329`;

async function readSource(relative: string): Promise<string> {
  return fs.readFile(path.join(REPO_ROOT, relative), "utf8");
}

/** 源码在位断言：pattern 命中即通过（用于私有函数 / 前端渲染点这类无法直接调用的位置） */
async function assertSource(
  relative: string,
  pattern: RegExp,
  what: string,
): Promise<void> {
  const source = await readSource(relative);
  ok(pattern.test(source), `${relative} 应包含${what}`);
}

function makePoi(id: string, name: string, extra: Partial<FlyAIPoi> = {}): FlyAIPoi {
  return {
    id,
    name,
    address: `地址-${id}`,
    category: null,
    description: null,
    freePoiStatus: null,
    poiLevel: null,
    coords: { lng: 109.75, lat: 18.37 },
    mainPic: null,
    listRank: null,
    ticketInfo: null,
    jumpUrl: "https://router.feizhu.com/multi/webview?url=https%3A%2F%2Frouter.feizhu.com%2Fws%2F0cHDhj",
    ...extra,
  };
}

function makeEntry(name: string): ParsedEntry {
  return {
    name,
    type: "attraction",
    parentAttraction: null,
    scale: null,
    confidence: "high",
    suggestMinutes: 120,
    locationHint: null,
    quote: `攻略提到了${name}`,
    summary: `${name} 值得一去`,
    ticketRelation: "unknown",
    suggestedVisitName: null,
    bbox: null,
  };
}

function makeItem(itemId: string, name: string, extra: Partial<Item> = {}): Item {
  return {
    itemId,
    name,
    origin: "custom",
    providerId: null,
    address: null,
    category: null,
    coords: null,
    suggestMinutes: null,
    mainPic: null,
    ticketInfo: null,
    jumpUrl: null,
    sourceEvidenceRefs: [],
    ...extra,
  };
}

/** 最小 Trip（ensureItem 只读写 itemRegistry；与 shared/verify-provenance 同做法） */
function makeTripShell(): Trip {
  return { itemRegistry: {}, visits: {}, stops: {} } as unknown as Trip;
}

/** 落盘形态：undefined 值的可选字段经 JSON 序列化后应彻底消失（不写回存量） */
function persistedKeys(item: Item): string[] {
  return Object.keys(JSON.parse(JSON.stringify(item)) as Record<string, unknown>);
}

// ===== 真实存量数据（S3 / S4 用；只读，不写盘） =====

/** 扫描 server/data/*.json 收集全部 Item（.bak-* 后缀不以 .json 结尾，天然被排除） */
async function collectStoredItems(): Promise<Array<{ tripId: string; item: Item }>> {
  const files = (await fs.readdir(DATA_DIR)).filter(
    (file) => file.endsWith(".json") && isValidTripId(file.slice(0, -".json".length)),
  );
  const collected: Array<{ tripId: string; item: Item }> = [];
  for (const file of files) {
    const raw = await fs.readFile(path.join(DATA_DIR, file), "utf8");
    let parsed: { itemRegistry?: Record<string, Item> };
    try {
      parsed = JSON.parse(raw) as { itemRegistry?: Record<string, Item> };
    } catch {
      continue; // 损坏文件跳过：本脚本只读，不承担数据修复职责
    }
    const tripId = file.slice(0, -".json".length);
    for (const item of Object.values(parsed.itemRegistry ?? {})) collected.push({ tripId, item });
  }
  return collected;
}

async function main(): Promise<void> {
  const stored = await collectStoredItems();
  ok(stored.length > 0, "存量行程应至少扫描到一个 Item（否则 S3/S4 反例断言无意义）");

  // ---------- S1 契约透传 ----------

  await test("S1-1 ensureItem：POI freePoiStatus=UNKNOWN 原样透传（不臆造 FREE）", () => {
    const trip = makeTripShell();
    const alignment: PoiAlignment = {
      ...emptyPoiAlignment(),
      match: makePoi("199649345", "中免集团·三亚国际免税城", { freePoiStatus: "UNKNOWN" }),
    };
    const { item, reused } = ensureItem(trip, makeEntry("国际免税城"), alignment, "ev_1");
    eq(reused, false, "首次装配应新建 Item");
    eq(item.origin, "fliggy", "命中飞猪 POI 应为 fliggy");
    eq(item.freePoiStatus, "UNKNOWN", "UNKNOWN 必须原样透传，不得升级为 FREE");
    // Task #330 D 口径变更（PD 批准，与 #329 原断言相反）：#329 时此处断言 false（免税城
    // UNKNOWN + category=null 不判免费，须靠存量回填 FREE）。现名称通道接入运行时判定，
    // item.name「国际免税城」命中「免税」→ 应判免费，使 PD 新建行程再搜免税城时购票按钮
    // 不再复现（原始症状）。freePoiStatus 仍原样透传 UNKNOWN（不臆造 FREE），判定靠名称兜底。
    eq(isFreeAdmissionItem(item), true, "免税城名称命中购物词，UNKNOWN + category=null 也判免费（#330 D 名称通道）");
  });

  await test("S1-2 ensureItem：POI freePoiStatus=FREE 透传并命中免费判定", () => {
    const trip = makeTripShell();
    const alignment: PoiAlignment = {
      ...emptyPoiAlignment(),
      match: makePoi("F1", "某免费公园", { freePoiStatus: "FREE" }),
    };
    const { item } = ensureItem(trip, makeEntry("某免费公园"), alignment, "ev_1");
    eq(item.freePoiStatus, "FREE", "FREE 必须透传");
    eq(isFreeAdmissionItem(item), true, "FREE → 免费入场");
  });

  await test("S1-3 ensureItem：POI 未携带信号时不把读时默认回写成 null（落盘无该字段）", () => {
    const trip = makeTripShell();
    const alignment: PoiAlignment = {
      ...emptyPoiAlignment(),
      match: makePoi("F2", "蜈支洲岛", { freePoiStatus: null }),
    };
    const { item } = ensureItem(trip, makeEntry("蜈支洲岛"), alignment, "ev_1");
    eq(itemFreePoiStatus(item), null, "读时默认 null");
    ok(!persistedKeys(item).includes("freePoiStatus"), "null 信号不得写进落盘形态（保持存量零迁移）");
  });

  await test("S1-4 ensureItem：custom 降级路径不伪造 freePoiStatus", () => {
    const trip = makeTripShell();
    const { item } = ensureItem(trip, makeEntry("某个飞猪未收录的点"), emptyPoiAlignment(), "ev_1");
    eq(item.origin, "custom", "未命中 POI 应降级 custom");
    eq(itemFreePoiStatus(item), null, "custom 读时默认 null");
    ok(!persistedKeys(item).includes("freePoiStatus"), "custom 不得携带该字段（不伪造供应商数据）");
  });

  await test("S1-5 升级路径：custom → fliggy 时 freePoiStatus 随 POI 升级写入", () => {
    const item = makeItem("item_ylw", "亚龙湾热带天堂森林公园");
    const poi = makePoi("P9", "亚龙湾热带天堂森林公园", { freePoiStatus: "FREE" });
    const upgrade = applyPoiUpgradeToCustomItem(item, poi, "亚龙湾森林公园");
    ok(upgrade !== null, "别名命中且 canonical 全等，应升级");
    eq(item.freePoiStatus, "FREE", "升级后应带上免费状态");
    ok(
      upgrade!.changes.some((change) => change.field === "freePoiStatus"),
      "变更记录应包含 freePoiStatus（升级日志可归因）",
    );
    eq(isFreeAdmissionItem(item), true, "升级后命中免费判定");
  });

  await test("S1-6 升级路径：POI 无信号时保留字段缺失态，不产生无意义变更", () => {
    const item = makeItem("item_ylw2", "亚龙湾热带天堂森林公园");
    const poi = makePoi("P10", "亚龙湾热带天堂森林公园", { freePoiStatus: null });
    const upgrade = applyPoiUpgradeToCustomItem(item, poi, "亚龙湾森林公园");
    ok(upgrade !== null, "应升级");
    ok(
      !upgrade!.changes.some((change) => change.field === "freePoiStatus"),
      "POI 无信号时不得把缺失字段回写成 null",
    );
    ok(!persistedKeys(item).includes("freePoiStatus"), "落盘形态仍无该字段");
  });

  await test("S1-7 升级路径：已有 FREE 的 Item 被无信号 POI 升级时不被抹掉", () => {
    const item = makeItem("item_ylw3", "亚龙湾热带天堂森林公园", { freePoiStatus: "FREE" });
    const poi = makePoi("P11", "亚龙湾热带天堂森林公园", { freePoiStatus: null });
    applyPoiUpgradeToCustomItem(item, poi, "亚龙湾森林公园");
    eq(item.freePoiStatus, "FREE", "既有免费标记不得丢失（不丢数据铁律）");
  });

  await test("S1-8 装配点四路 + 前端透传两路源码在位", async () => {
    // 服务端两路（buildCandidatePoint 为模块私有，只能源码断言）
    await assertSource(
      "server/src/ai/pipeline.ts",
      /buildCandidatePoint[\s\S]{0,900}freePoiStatus: poi\.freePoiStatus/,
      "buildCandidatePoint 的 freePoiStatus 透传",
    );
    await assertSource(
      "server/src/ai/assemble.ts",
      /freePoiStatus: poi\?\.freePoiStatus \?\? undefined/,
      "ensureItem 的 freePoiStatus 透传",
    );
    await assertSource(
      "server/src/ai/assemble.ts",
      /apply\("freePoiStatus"/,
      "applyPoiUpgradeToCustomItem 的升级写入",
    );
    // 前端四路
    await assertSource(
      "web/src/components/TripView.tsx",
      /freePoiStatus: poi\.freePoiStatus/,
      "poiToItem 的 freePoiStatus 透传",
    );
    await assertSource(
      "web/src/components/TripView.tsx",
      /freePoiStatus: item\.poi\.freePoiStatus/,
      "confirmChildAttach matchedPoi 的 freePoiStatus 透传",
    );
    await assertSource(
      "web/src/components/CandidatePool.tsx",
      /freePoiStatus: poi\.freePoiStatus/,
      "poiResultToItem 的 freePoiStatus 透传",
    );
    await assertSource(
      "web/src/hooks/useTrip.ts",
      /freePoiStatus: poi\.freePoiStatus/,
      "addCustomStop fliggy Item 的 freePoiStatus 透传",
    );
    await assertSource(
      "web/src/components/AddStopSheet.tsx",
      /freePoiStatus: poi\.freePoiStatus/,
      "AddStopSheet matchedPoi 的 freePoiStatus 透传",
    );
  });

  // ---------- S2 三态判定纯函数 ----------

  await test("S2-1 四态口径：FREE→免费、NOT_FREE→收费、UNKNOWN/null→category 兜底", () => {
    eq(isFreeAdmissionPoi("FREE", null), true, "FREE + 无 category → 免费");
    eq(isFreeAdmissionPoi("FREE", "沙滩海岛"), true, "FREE 优先于 category");
    eq(isFreeAdmissionPoi("NOT_FREE", "购物中心"), false, "NOT_FREE 时 category 兜底不得介入");
    eq(isFreeAdmissionPoi("UNKNOWN", "购物"), true, "UNKNOWN + 购物类 category → 免费");
    eq(isFreeAdmissionPoi("UNKNOWN", "沙滩海岛"), false, "UNKNOWN + 景点类 category → 非免费");
    eq(isFreeAdmissionPoi(null, null), false, "双无信号 → 非免费（绝不当免费）");
    eq(isFreeAdmissionPoi(null, "免税"), true, "null + 免税类 category → 免费");
  });

  await test("S2-2 读时默认：缺失 / null / 非法值一律回落 null 且不写回", () => {
    const legacy = makeItem("legacy", "国际免税城"); // 存量形态：无 freePoiStatus 字段
    eq(itemFreePoiStatus(legacy), null, "字段缺失 → null");
    eq(itemFreePoiStatus(null), null, "null item → null");
    eq(itemFreePoiStatus(undefined), null, "undefined item → null");
    const dirty = { ...legacy, freePoiStatus: "free" } as unknown as Item;
    eq(itemFreePoiStatus(dirty), null, "非法值（小写 free）→ null");
    eq(legacy.freePoiStatus, undefined, "读时默认不得改写存量对象");
    ok(!persistedKeys(legacy).includes("freePoiStatus"), "存量落盘形态零变化");
  });

  await test("S2-3 Item 判定：FREE 直命中；UNKNOWN 靠 category/名称兜底；NOT_FREE 恒否", () => {
    eq(isFreeAdmissionItem(makeItem("a", "免费公园", { freePoiStatus: "FREE" })), true, "FREE → true");
    eq(
      isFreeAdmissionItem(makeItem("b", "某商城", { freePoiStatus: "UNKNOWN", category: "购物中心" })),
      true,
      "UNKNOWN + 购物 category → true",
    );
    eq(
      isFreeAdmissionItem(makeItem("c", "蜈支洲岛", { freePoiStatus: "NOT_FREE", category: "沙滩海岛" })),
      false,
      "NOT_FREE → false",
    );
    eq(isFreeAdmissionItem(null), false, "null item → false");
    // Task #330 D 口径变更（PD 批准，与 #329 原断言相反，非静默删除）：国际免税城 =
    // UNKNOWN + category null。#329 时判 false（须靠 fix 脚本回填 FREE）；现名称通道接入
    // 运行时判定，「国际免税城」命中「免税」→ 直接判免费，新建行程无需依赖存量回填即可
    // 让购票按钮降级（修复 PD 报的原始症状：新建行程再搜免税城购票按钮复现）。
    eq(
      isFreeAdmissionItem(makeItem("d", "国际免税城", { freePoiStatus: "UNKNOWN", category: null })),
      true,
      "免税城在 UNKNOWN + 无 category 时靠名称通道判免费（#330 D 双通道兜底）",
    );
    eq(
      isFreeAdmissionItem(makeItem("e", "国际免税城", { freePoiStatus: "FREE", category: null })),
      true,
      "回填 FREE 后判免费",
    );
  });

  await test("S2-4 名称通道（Task #330 D）：UNKNOWN/null + 购物名 → 免费；NOT_FREE 名称不覆盖；真实景点名不误杀", () => {
    // 新增断言（任务要求）：国际免税城在 UNKNOWN + category=null 下现在应判为免费
    eq(
      isFreeAdmissionPoi("UNKNOWN", null, "国际免税城"),
      true,
      "UNKNOWN + category null + 免税名 → 免费（原始症状修复）",
    );
    eq(isFreeAdmissionPoi(null, null, "三亚奥特莱斯"), true, "null + 奥特莱斯名 → 免费");
    eq(
      isFreeAdmissionPoi("NOT_FREE", null, "国际免税城"),
      false,
      "NOT_FREE 时名称兜底不得覆盖（供应商明确信号优先）",
    );
    eq(isFreeAdmissionPoi("UNKNOWN", null, "蜈支洲岛"), false, "真实景点名 + 无 category → 非免费");
    eq(
      isFreeAdmissionPoi("UNKNOWN", "沙滩海岛", "海棠广场"),
      false,
      "名称无购物词 + category 非购物 → 非免费（广场不入宽词）",
    );
    eq(isShoppingNameHit("天街商业街"), true, "商业街命中名称通道");
    eq(isShoppingNameHit("天涯小镇"), false, "天涯小镇不含购物关键词（镇≠街）");
    eq(isShoppingNameHit("海棠广场"), false, "海棠广场不含购物关键词（广场为宽词，不入表）");
  });

  // ---------- S3 兜底关键词不误杀 ----------

  await test("S3-1 存量全量 category 值逐个反例：真实景点类别一律不命中购物兜底", () => {
    const categories = new Set<string>();
    for (const { item } of stored) {
      if (typeof item.category === "string" && item.category !== "") categories.add(item.category);
    }
    ok(categories.size >= 5, `存量 category 种类应足够做反例（实际 ${categories.size} 种）`);
    for (const category of categories) {
      eq(isShoppingCategory(category), false, `存量真实景点 category「${category}」不得命中购物兜底`);
    }
    console.log(`      （反例 category 全集：${[...categories].sort().join(" / ")}）`);
  });

  await test("S3-2 代表性真实景点名不命中名称关键词表（含天涯小镇/海棠广场这类含宽词的名称）", () => {
    const realAttractions = [
      "天涯小镇",
      "海棠广场",
      "蜈支洲岛",
      "西岛",
      "南山寺",
      "鹿回头",
      "亚龙湾热带天堂森林公园",
      "天涯海角",
      "椰梦长廊",
      "观日岩",
      "情人桥",
      "大东海",
      "星空营地",
      "凤凰岛桥头公园",
    ];
    for (const name of realAttractions) {
      eq(isShoppingNameHit(name), false, `真实景点「${name}」不得命中购物名称关键词`);
      eq(isFreeAdmissionItem(makeItem("x", name)), false, `真实景点「${name}」不得判定为免费`);
    }
  });

  await test("S3-3 宽词「中心 / 广场 / 街」刻意不在两张关键词表内（误杀代价高于漏判）", () => {
    for (const wide of ["中心", "广场", "街"]) {
      ok(
        !SHOPPING_CATEGORY_KEYWORDS.some((keyword) => keyword === wide),
        `严格 category 表不得含裸宽词「${wide}」`,
      );
      ok(
        !FREE_NAME_KEYWORDS.some((keyword) => keyword === wide),
        `名称表不得含裸宽词「${wide}」`,
      );
    }
    eq(isShoppingCategory("文创街区"), false, "「文创街区」（天涯小镇）不因含「街」误杀");
    eq(isShoppingCategory("地标建筑"), false, "「地标建筑」（海棠广场）不误杀");
  });

  await test("S3-4 存量全量 Item 走判定：命中免费的只有购物类点位，无真实景点", () => {
    const hits = stored.filter(({ item }) => isFreeAdmissionItem(item)).map(({ tripId, item }) => ({
      tripId: tripId.slice(0, 8),
      name: item.name,
      category: item.category,
      status: itemFreePoiStatus(item),
    }));
    for (const hit of hits) {
      const shopping = isShoppingNameHit(hit.name) || isShoppingCategory(hit.category);
      ok(shopping || hit.status === "FREE", `命中免费的「${hit.name}」必须是购物类点位或显式 FREE`);
    }
    console.log(
      `      （存量命中免费判定 ${hits.length} 条：` +
        `${hits.map((hit) => `${hit.tripId}「${hit.name}」${String(hit.status)}`).join("、") || "无"}）`,
    );
  });

  // ---------- S4 存量迁移读时默认 ----------

  await test("S4-1 PD 现场行程：国际免税城已带 FREE 且判定为免费（症状已修）", async () => {
    // 经 tripStore.load 读取：自带读时迁移与攻略契约补齐，避开裸 JSON 缺可选表时
    // 一致性校验取 .length 抛 TypeError 的已知坑（只读，不写盘）
    const trip = await tripStore.load(PD_TRIP_ID);
    ok(trip !== null, "PD 行程应可载入");
    const target = Object.values(trip!.itemRegistry).find((item) => item.name.includes("免税"));
    ok(target !== undefined, "PD 行程应存在国际免税城点位");
    eq(target!.freePoiStatus, "FREE", "fix-task329 应已回填 FREE");
    eq(isFreeAdmissionItem(target!), true, "应判定为免费入场（前端将隐藏购票按钮）");
    ok(
      typeof target!.jumpUrl === "string" && target!.jumpUrl !== "",
      "jumpUrl 必须保留（弱入口仍可跳飞猪详情）",
    );
    eq(validateConsistency(trip!), [], "回填后行程一致性校验应无错");
  });

  await test("S4-2 修复前快照（.bak-task329）：缺失字段读时默认不报错、不写回、判定维持原行为", async () => {
    const exists = await fs
      .access(PD_TRIP_BACKUP)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      console.log("      （备份文件不存在，跳过历史快照断言）");
      return;
    }
    const raw = await fs.readFile(PD_TRIP_BACKUP, "utf8");
    const trip = JSON.parse(raw) as Trip;
    const target = Object.values(trip.itemRegistry).find((item) => item.name.includes("免税"));
    ok(target !== undefined, "备份里应存在国际免税城点位");
    ok(!("freePoiStatus" in target!), "备份应为修复前形态（无该字段）");
    const before = JSON.stringify(target);
    eq(itemFreePoiStatus(target!), null, "缺失 → 读时默认 null，不抛错");
    // Task #330 D 口径变更（PD 批准，与 #329 原断言相反）：名称通道接入后，历史快照里的
    // 「国际免税城」名称命中「免税」关键词 → 现在判为免费。这正是任务 D 要修的症状：即便
    // 存量快照缺 freePoiStatus（UNKNOWN/null）且 category 无信号，购物名场所也不应再透出
    // 购票按钮。读时默认（上一行）与不写回（下一行）两条迁移铁律不受影响，仍全绿。
    eq(isFreeAdmissionItem(target!), true, "历史快照「国际免税城」经名称通道判为免费（Task #330 D 口径变更）");
    eq(JSON.stringify(target!), before, "读取判定不得改写对象（读时默认，非读时迁移写回）");
  });

  await test("S4-3 全部存量行程读时默认零抛错（缺失字段的行程照常判定）", () => {
    let legacyCount = 0;
    for (const { item } of stored) {
      if ("freePoiStatus" in item) continue;
      legacyCount += 1;
      const status = itemFreePoiStatus(item); // 不得抛错
      eq(status, null, "缺失字段读时默认 null");
      const free = isFreeAdmissionItem(item);
      // 缺失 + 非购物 category + 非购物名 必须为 false（UNKNOWN 双通道都无信号才不当免费）
      // Task #330 D：名称通道接入后须同时排除名称命中，否则购物名 legacy 项会误报
      if (!isShoppingCategory(item.category) && !isShoppingNameHit(item.name))
        eq(free, false, `「${item.name}」无信号不得判免费`);
    }
    ok(legacyCount > 0, `应存在缺失该字段的存量 Item（实际 ${legacyCount} 条）`);
  });

  // ---------- S5 fix 脚本幂等与范围收敛 ----------

  await test("S5-1 applyTask329Fixes 幂等：第二次执行为空操作且结果深度相等", () => {
    const trip = {
      itemRegistry: {
        i1: makeItem("i1", "国际免税城", { origin: "fliggy", providerId: "F1", jumpUrl: "https://router.feizhu.com/x" }),
        i2: makeItem("i2", "蜈支洲岛", { origin: "fliggy", providerId: "F2", jumpUrl: "https://router.feizhu.com/y" }),
      },
    } as unknown as Trip;
    const first = applyTask329Fixes(trip);
    eq(first.length, 1, "首次应只回填免税城");
    eq(first[0]!.name, "国际免税城", "回填目标是免税城");
    const snapshot = JSON.stringify(trip.itemRegistry);
    const second = applyTask329Fixes(trip);
    eq(second, [], "第二次执行应为空操作（幂等）");
    eq(JSON.stringify(trip.itemRegistry), snapshot, "重复执行不得改动数据");
    eq(trip.itemRegistry.i2!.freePoiStatus, undefined, "真实景点不得被回填");
  });

  await test("S5-2 范围收敛：无 jumpUrl / 已 FREE / 飞猪 NOT_FREE 一律不回填", () => {
    const customStreet = makeItem("c1", "天街商业街", { origin: "custom", jumpUrl: null });
    eq(shouldMarkFree(customStreet), false, "custom + 无 jumpUrl → 不回填");
    const noJumpFliggy = makeItem("c2", "某免税店", { origin: "fliggy", jumpUrl: null });
    eq(shouldMarkFree(noJumpFliggy), false, "无 jumpUrl → 不回填");
    const already = makeItem("c3", "国际免税城", {
      origin: "fliggy",
      jumpUrl: "https://router.feizhu.com/z",
      freePoiStatus: "FREE",
    });
    eq(shouldMarkFree(already), false, "已是 FREE → 幂等跳过");
    const notFree = makeItem("c4", "海岛购物点", {
      origin: "fliggy",
      jumpUrl: "https://router.feizhu.com/w",
      freePoiStatus: "NOT_FREE",
    });
    eq(shouldMarkFree(notFree), false, "飞猪明确标 NOT_FREE 不得被名称兜底覆盖（尊重供应商信号）");
    eq(
      isFreeAdmissionItem(notFree),
      false,
      "脚本口径与展示口径必须同向：NOT_FREE 两侧都不判免费",
    );
  });

  await test("S5-3 存量复跑为 0 变更（脚本已执行过，再评估应无候选）", () => {
    const trip = { itemRegistry: {} } as unknown as Trip;
    const pdItems = stored.filter(({ tripId }) => tripId === PD_TRIP_ID);
    ok(pdItems.length > 0, "应能读到 PD 行程的存量 Item");
    for (const { item } of pdItems) trip.itemRegistry[item.itemId] = structuredClone(item);
    eq(applyTask329Fixes(trip), [], "PD 行程复跑应为 0 变更");
  });

  await test("S5-4 口径同向：凡被脚本回填的 Item，展示层必须判为免费（不出现回填了仍显购票）", () => {
    const samples: Item[] = [
      makeItem("s1", "国际免税城", { origin: "fliggy", jumpUrl: "https://x", category: null }),
      makeItem("s2", "旺豪超市", { origin: "fliggy", jumpUrl: "https://x", category: "公园乐园" }),
      makeItem("s3", "天街商业街", { origin: "custom", jumpUrl: null, category: null }),
      makeItem("s4", "海岛购物点", {
        origin: "fliggy",
        jumpUrl: "https://x",
        freePoiStatus: "NOT_FREE",
      }),
      makeItem("s5", "某免费公园", { origin: "fliggy", jumpUrl: "https://x", freePoiStatus: "FREE" }),
      makeItem("s6", "大东海", { origin: "fliggy", jumpUrl: "https://x", category: "沙滩海岛" }),
      makeItem("s7", "海棠广场", { origin: "fliggy", jumpUrl: "https://x", category: "地标建筑" }),
    ];
    let backfilledCount = 0;
    for (const sample of samples) {
      const trip = { itemRegistry: { [sample.itemId]: sample } } as unknown as Trip;
      const filled = applyTask329Fixes(trip);
      eq(filled.length <= 1, true, "单个 Item 最多回填一条");
      if (filled.length === 1) {
        backfilledCount += 1;
        eq(sample.freePoiStatus, "FREE", `「${sample.name}」回填后字段应为 FREE`);
        eq(isFreeAdmissionItem(sample), true, `「${sample.name}」回填后展示层必须判为免费`);
      }
    }
    eq(backfilledCount, 2, "样本中应只有免税城（名称通道）与超市（名称通道）被回填");
    eq(
      isFreeAdmissionItem(samples[4]!),
      true,
      "已是 FREE 的点位不需回填但展示层仍判免费",
    );
    // Task #330 D：s3「天街商业街」custom + 无 jumpUrl，脚本不回填（无购票按钮、不在症状面），
    // 但名称命中「商业街」→ 运行时展示层现在判为免费；因其本就无 jumpUrl / 无购票按钮，
    // 判免费无可见副作用（无按钮可降级）。脚本回填范围（须有 jumpUrl）与展示判定刻意不同，非回归。
    eq(isFreeAdmissionItem(samples[2]!), true, "天街商业街名称命中购物词 → 展示层判免费（#330 D 名称通道）");
    eq(shouldMarkFree(samples[2]!), false, "但无 jumpUrl → 脚本不回填（不在症状面）");
    for (const untouched of [samples[3]!, samples[5]!, samples[6]!]) {
      eq(
        isFreeAdmissionItem(untouched),
        false,
        `「${untouched.name}」无购物信号（名称/类别均未命中）不得判免费`,
      );
    }
  });

  // ---------- S6 前端三态展示口径 ----------

  await test("S6-1 VisitCard commerce 三态表达式在位（free 优先，其次 fliggy/unknown 原逻辑）", async () => {
    await assertSource(
      "web/src/components/VisitCard.tsx",
      /commerce=\{freeAdmission \? "free" : jumpUrl !== null \? "fliggy" : "unknown"\}/,
      "commerce 三态判定",
    );
    await assertSource(
      "web/src/components/VisitCard.tsx",
      /const freeAdmission = isFreeAdmissionItem\(item\);/,
      "免费判定取值（单一数据源 shared/freePoi.ts）",
    );
    await assertSource(
      "web/src/components/VisitCard.tsx",
      /onMainAction=\{jumpUrl !== null \? \(\) => window\.open\(jumpUrl/,
      "jumpUrl 跳转能力保留（降级为弱入口而非删除）",
    );
  });

  await test("S6-2 四处「免票」标签渲染点在位（主卡 / 父卡 / 岛内玩法行 / 候选卡 / 快速搜索卡）", async () => {
    const visitCard = await readSource("web/src/components/VisitCard.tsx");
    const freeTags = (visitCard.match(/<span className="tag slate">免票<\/span>/g) ?? []).length;
    ok(freeTags >= 2, `VisitCard 应含普通卡与父卡两处免票标签（实际 ${freeTags} 处）`);
    await assertSource("web/src/components/StopRow.tsx", /tag slate">免票/, "岛内玩法行免票标签");
    await assertSource("web/src/components/CandidatePool.tsx", /tag slate">免票/, "候选/搜索结果免票标签");
    await assertSource("web/src/components/NoteInput.tsx", /quick-result-cat">免票/, "快速搜索卡免票标签");
    // Task #330：showTimeRow 因新增 poiLevelLabel 条件改为多行书写，断言相应改为多行容错
    // 匹配（语义不变：freeAdmission 仍纳入时间行渲染条件，否则免票标签不显示）
    await assertSource(
      "web/src/components/StopRow.tsx",
      /showTimeRow\s*=[\s\S]*?freeAdmission[\s\S]*?;/,
      "免票标签纳入时间行渲染条件（否则标签不显示）",
    );
  });

  await test("S6-3 CardActions 购票按钮降级：commerce=free 恒为「查看详情」，其余态不变", async () => {
    await assertSource(
      "web/src/components/CardActions.tsx",
      /if \(commerce === "free"\) return "查看详情";/,
      "免票态主按钮降级为查看详情（无购票/票价语义）",
    );
    await assertSource(
      "web/src/components/CardActions.tsx",
      /if \(status === "noTicket" \|\| commerce !== "fliggy"\) return "查票价";/,
      "unknown 态维持「查票价」（不制造回归）",
    );
    await assertSource(
      "web/src/components/CardActions.tsx",
      /return "去购票";/,
      // #367 遗留：原断言为「去飞猪购票」，#367 去「飞猪」二字后文案改为「去购票」，
      // 本断言当时未同步而转红，#372 一并修正为现行文案（语义不变：fliggy 在售态维持购票入口）
      "fliggy 在售态维持「去购票」（不制造回归）",
    );
    await assertSource(
      "web/src/components/CardActions.tsx",
      /export function isDimMainAction[\s\S]{0,200}查看详情/,
      "查看详情属降级态（浅橙弱入口样式）",
    );
  });

  // ---------- 汇总 ----------
  const failures = results.filter((result) => result.error !== null);
  console.log(`\n[VERIFY-329] ${results.length - failures.length}/${results.length} 通过`);
  if (failures.length > 0) {
    throw new Error(
      `Task #329 验收失败 ${failures.length} 项：${failures.map((failure) => failure.label).join("，")}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error("[VERIFY-329] 验收脚本失败：", error);
  process.exitCode = 1;
});
