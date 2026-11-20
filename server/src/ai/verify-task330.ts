/**
 * Task #330 离线验收（不触网、不写盘）：飞猪 POI 元信息（poiLevel / listRank / description）
 * 三项透传 + 读时默认 + 归一化 + 展示口径 + 存量回填幂等。
 *
 * 背景：FlyAI search-poi 返回 13 字段，normalizePoi 已 100% 映射到 FliggyPoi，但
 * FliggyPoi → Item 装配曾丢弃这三项（freePoiStatus 已由 #329 补齐）。#330 任务 A 接通
 * 8 处透传点，任务 B 落地前端展示（4A/5A 徽标 / 榜单 chip / 介绍折叠区），任务 C 离线回填存量。
 *
 * 覆盖矩阵：
 *   S1 契约透传（行为断言）：ensureItem / applyPoiUpgradeToCustomItem 对三字段的透传，
 *      含「未携带不回写 null」「已有值不被无信号 POI 抹掉」两条铁律。
 *   S2 8 处透传点源码在位：服务端 3 路（pipeline + ensureItem + 升级路径 null 守卫）
 *      + 前端 5 路（TripView×2 + CandidatePool + useTrip×2 + AddStopSheet）。
 *   S3 读时默认纯函数：itemPoiLevel / itemListRank / itemDescription 对缺失 / null /
 *      空白 / 非字符串一律回落 null，不写回、不抛错。
 *   S4 poiLevel 归一化：normalizePoiLevel 各形态（"4"/"5"/"4A"/"AAAA"/"AAAAA"/脏值）。
 *   S5 展示口径源码在位：listRank 缺失不产空文本、description 折叠默认收起、
 *      poiLevel 无法识别不渲染脏值（PoiMeta.tsx）。
 *   S6 存量脚本幂等：applyTask330Fixes 重复执行为空操作；缓存全 null 不回写；
 *      已有非空值不覆盖；custom / 未命中缓存不回填；真实缓存含西岛三项。
 *   S7 全量存量读时默认零抛错 + PD 行程西岛三项已回填在位 + 国际免税城仍判免费（不回归）。
 *
 * 运行：npx tsx server/src/ai/verify-task330.ts
 */

import "../env.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { Item, Trip } from "@goplay/shared";
import {
  isFreeAdmissionItem,
  itemDescription,
  itemListRank,
  itemPoiLevel,
  itemPoiLevelLabel,
  normalizePoiLevel,
} from "@goplay/shared";
import type { FlyAIPoi } from "../flyai/client.js";
import {
  applyPoiUpgradeToCustomItem,
  emptyPoiAlignment,
  ensureItem,
  type ParsedEntry,
  type PoiAlignment,
} from "./assemble.js";
import {
  applyTask330Fixes,
  loadFlyAiPoiIndex,
  type CachedPoiMeta,
} from "../guides/fix-task330.js";
import { isValidTripId } from "../persistence/store.js";

// ===== 断言助手（与 verify-task329 同范式：逐用例收集，末尾汇总） =====

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
const CACHE_DIR = path.join(REPO_ROOT, "eval/cache/flyai");

/** PD 现场行程（Task #330 回填目标，含西岛样例） */
const PD_TRIP_ID = "0a27f726-9c93-48e8-ab68-1d62e9bc685b";
const PD_TRIP_FILE = path.join(DATA_DIR, `${PD_TRIP_ID}.json`);

async function readSource(relative: string): Promise<string> {
  return fs.readFile(path.join(REPO_ROOT, relative), "utf8");
}

/** 源码在位断言：pattern 命中即通过（用于私有函数 / 前端渲染点这类无法直接调用的位置） */
async function assertSource(relative: string, pattern: RegExp, what: string): Promise<void> {
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

/** 最小 Trip（ensureItem 只读写 itemRegistry） */
function makeTripShell(): Trip {
  return { itemRegistry: {}, visits: {}, stops: {} } as unknown as Trip;
}

/** 落盘形态：undefined 值的可选字段经 JSON 序列化后应彻底消失（不写回存量） */
function persistedKeys(item: Item): string[] {
  return Object.keys(JSON.parse(JSON.stringify(item)) as Record<string, unknown>);
}

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
      continue;
    }
    const tripId = file.slice(0, -".json".length);
    for (const item of Object.values(parsed.itemRegistry ?? {})) collected.push({ tripId, item });
  }
  return collected;
}

async function main(): Promise<void> {
  const stored = await collectStoredItems();
  ok(stored.length > 0, "存量行程应至少扫描到一个 Item");

  // ---------- S1 契约透传（行为断言） ----------

  await test("S1-1 ensureItem：POI 携带 poiLevel/listRank/description 时原样透传到 Item", () => {
    const trip = makeTripShell();
    const alignment: PoiAlignment = {
      ...emptyPoiAlignment(),
      match: makePoi("2611", "西岛", {
        poiLevel: "4",
        listRank: "海南4A/5A景点榜第2名",
        description: "西岛，全称西瑁洲岛，坐落在三亚市西南8海里的三亚湾海域。",
      }),
    };
    const { item, reused } = ensureItem(trip, makeEntry("西岛"), alignment, "ev_1");
    eq(reused, false, "首次装配应新建 Item");
    eq(item.origin, "fliggy", "命中飞猪 POI 应为 fliggy");
    eq(item.poiLevel, "4", "poiLevel 原样透传（保留飞猪原始形态，归一化交给读侧）");
    eq(item.listRank, "海南4A/5A景点榜第2名", "listRank 原样透传");
    eq(item.description, "西岛，全称西瑁洲岛，坐落在三亚市西南8海里的三亚湾海域。", "description 原样透传");
  });

  await test("S1-2 ensureItem：POI 未携带三项时不把读时默认回写成 null（落盘无字段）", () => {
    const trip = makeTripShell();
    const alignment: PoiAlignment = {
      ...emptyPoiAlignment(),
      match: makePoi("99", "蜈支洲岛", { poiLevel: null, listRank: null, description: null }),
    };
    const { item } = ensureItem(trip, makeEntry("蜈支洲岛"), alignment, "ev_1");
    eq(itemPoiLevel(item), null, "poiLevel 读时默认 null");
    eq(itemListRank(item), null, "listRank 读时默认 null");
    eq(itemDescription(item), null, "description 读时默认 null");
    const keys = persistedKeys(item);
    ok(!keys.includes("poiLevel"), "null 信号不得写进落盘形态（poiLevel）");
    ok(!keys.includes("listRank"), "null 信号不得写进落盘形态（listRank）");
    ok(!keys.includes("description"), "null 信号不得写进落盘形态（description）");
  });

  await test("S1-3 ensureItem：custom 降级路径不伪造三项字段", () => {
    const trip = makeTripShell();
    const { item } = ensureItem(trip, makeEntry("某个飞猪未收录的点"), emptyPoiAlignment(), "ev_1");
    eq(item.origin, "custom", "未命中 POI 应降级 custom");
    const keys = persistedKeys(item);
    ok(
      !keys.includes("poiLevel") && !keys.includes("listRank") && !keys.includes("description"),
      "custom 不得携带三项字段（不伪造供应商数据）",
    );
  });

  await test("S1-4 升级路径：custom → fliggy 时三项随 POI 升级写入并记入变更", () => {
    const item = makeItem("item_ylw", "亚龙湾热带天堂森林公园");
    const poi = makePoi("P9", "亚龙湾热带天堂森林公园", {
      poiLevel: "5",
      listRank: "海南5A景点榜第1名",
      description: "亚龙湾热带天堂森林公园介绍",
    });
    const upgrade = applyPoiUpgradeToCustomItem(item, poi, "亚龙湾森林公园");
    ok(upgrade !== null, "别名命中，应升级");
    eq(item.poiLevel, "5", "升级后带上 poiLevel");
    eq(item.listRank, "海南5A景点榜第1名", "升级后带上 listRank");
    eq(item.description, "亚龙湾热带天堂森林公园介绍", "升级后带上 description");
    const fields = upgrade!.changes.map((change) => change.field);
    ok(fields.includes("poiLevel"), "变更记录含 poiLevel（升级日志可归因）");
    ok(fields.includes("listRank"), "变更记录含 listRank");
    ok(fields.includes("description"), "变更记录含 description");
  });

  await test("S1-5 升级路径关键铁律：POI 无信号时不回写 null（不污染 opLog）", () => {
    const item = makeItem("item_ylw2", "亚龙湾热带天堂森林公园");
    const poi = makePoi("P10", "亚龙湾热带天堂森林公园", {
      poiLevel: null,
      listRank: null,
      description: null,
    });
    const upgrade = applyPoiUpgradeToCustomItem(item, poi, "亚龙湾森林公园");
    ok(upgrade !== null, "应升级");
    ok(
      !upgrade!.changes.some(
        (change) =>
          change.field === "poiLevel" || change.field === "listRank" || change.field === "description",
      ),
      "POI 无信号时不得把缺失字段回写成 null（避免无意义变更记录）",
    );
    const keys = persistedKeys(item);
    ok(
      !keys.includes("poiLevel") && !keys.includes("listRank") && !keys.includes("description"),
      "落盘形态仍无三项字段",
    );
  });

  await test("S1-6 升级路径：已有三项值的 Item 被无信号 POI 升级时不被抹掉（不丢数据）", () => {
    const item = makeItem("item_ylw3", "亚龙湾热带天堂森林公园", {
      poiLevel: "5",
      listRank: "海南5A景点榜第1名",
      description: "既有介绍",
    });
    const poi = makePoi("P11", "亚龙湾热带天堂森林公园", {
      poiLevel: null,
      listRank: null,
      description: null,
    });
    applyPoiUpgradeToCustomItem(item, poi, "亚龙湾森林公园");
    eq(item.poiLevel, "5", "既有 poiLevel 不得丢失");
    eq(item.listRank, "海南5A景点榜第1名", "既有 listRank 不得丢失");
    eq(item.description, "既有介绍", "既有 description 不得丢失");
  });

  // ---------- S2 8 处透传点源码在位 ----------

  await test("S2-1 服务端三路在位（pipeline + ensureItem + 升级路径 null 守卫）", async () => {
    // pipeline.ts buildCandidatePoint（模块私有，源码断言）
    await assertSource(
      "server/src/ai/pipeline.ts",
      /buildCandidatePoint[\s\S]{0,1200}poiLevel: poi\.poiLevel \?\? undefined[\s\S]{0,120}listRank: poi\.listRank \?\? undefined[\s\S]{0,120}description: poi\.description \?\? undefined/,
      "buildCandidatePoint 的三项透传",
    );
    // assemble.ts ensureItem
    await assertSource(
      "server/src/ai/assemble.ts",
      /poiLevel: poi\?\.poiLevel \?\? undefined/,
      "ensureItem 的 poiLevel 透传",
    );
    await assertSource("server/src/ai/assemble.ts", /listRank: poi\?\.listRank \?\? undefined/, "ensureItem 的 listRank 透传");
    await assertSource(
      "server/src/ai/assemble.ts",
      /description: poi\?\.description \?\? undefined/,
      "ensureItem 的 description 透传",
    );
    // assemble.ts 升级路径：关键是 `if (poi.X !== null) apply(...)` 的 null 守卫
    await assertSource(
      "server/src/ai/assemble.ts",
      /if \(poi\.poiLevel !== null\) apply\("poiLevel", poi\.poiLevel\)/,
      "升级路径 poiLevel 的「无信号不回写 null」守卫",
    );
    await assertSource(
      "server/src/ai/assemble.ts",
      /if \(poi\.listRank !== null\) apply\("listRank", poi\.listRank\)/,
      "升级路径 listRank 的 null 守卫",
    );
    await assertSource(
      "server/src/ai/assemble.ts",
      /if \(poi\.description !== null\) apply\("description", poi\.description\)/,
      "升级路径 description 的 null 守卫",
    );
  });

  await test("S2-2 前端五路在位（TripView×2 + CandidatePool + useTrip×2 + AddStopSheet）", async () => {
    // TripView poiToItem
    await assertSource("web/src/components/TripView.tsx", /poiLevel: poi\.poiLevel \?\? undefined/, "poiToItem 的 poiLevel 透传");
    await assertSource("web/src/components/TripView.tsx", /listRank: poi\.listRank \?\? undefined/, "poiToItem 的 listRank 透传");
    await assertSource(
      "web/src/components/TripView.tsx",
      /description: poi\.description \?\? undefined/,
      "poiToItem 的 description 透传",
    );
    // TripView confirmChildAttach matchedPoi
    await assertSource(
      "web/src/components/TripView.tsx",
      /poiLevel: item\.poi\.poiLevel \?\? undefined/,
      "confirmChildAttach matchedPoi 的 poiLevel 透传",
    );
    await assertSource(
      "web/src/components/TripView.tsx",
      /description: item\.poi\.description \?\? undefined/,
      "confirmChildAttach matchedPoi 的 description 透传",
    );
    // CandidatePool poiResultToItem
    await assertSource(
      "web/src/components/CandidatePool.tsx",
      /poiLevel: poi\.poiLevel \?\? undefined[\s\S]{0,120}listRank: poi\.listRank \?\? undefined[\s\S]{0,120}description: poi\.description \?\? undefined/,
      "poiResultToItem 的三项透传",
    );
    // useTrip：CustomStopInput.matchedPoi 类型 + addCustomStop Item 创建
    await assertSource(
      "web/src/hooks/useTrip.ts",
      /poiLevel\?: Item\["poiLevel"\]/,
      "CustomStopInput.matchedPoi 的 poiLevel 类型",
    );
    await assertSource(
      "web/src/hooks/useTrip.ts",
      /poiLevel: poi\.poiLevel \?\? undefined[\s\S]{0,120}listRank: poi\.listRank \?\? undefined[\s\S]{0,120}description: poi\.description \?\? undefined/,
      "addCustomStop fliggy Item 的三项透传",
    );
    // AddStopSheet matchedPoi
    await assertSource(
      "web/src/components/AddStopSheet.tsx",
      /poiLevel: poi\.poiLevel \?\? undefined[\s\S]{0,120}listRank: poi\.listRank \?\? undefined[\s\S]{0,120}description: poi\.description \?\? undefined/,
      "AddStopSheet matchedPoi 的三项透传",
    );
  });

  // ---------- S3 读时默认纯函数 ----------

  await test("S3-1 读时默认：缺失 / null / 空白 / 非字符串一律回落 null 且不写回、不抛错", () => {
    const legacy = makeItem("legacy", "西岛"); // 存量形态：无三项字段
    eq(itemPoiLevel(legacy), null, "poiLevel 缺失 → null");
    eq(itemListRank(legacy), null, "listRank 缺失 → null");
    eq(itemDescription(legacy), null, "description 缺失 → null");
    eq(itemPoiLevel(null), null, "null item → null（不抛错）");
    eq(itemListRank(undefined), null, "undefined item → null（不抛错）");
    eq(itemDescription(null), null, "null item description → null");

    const blank = { ...legacy, poiLevel: "  ", listRank: "", description: "   " } as unknown as Item;
    eq(itemPoiLevel(blank), null, "纯空白 poiLevel → null");
    eq(itemListRank(blank), null, "空串 listRank → null");
    eq(itemDescription(blank), null, "纯空白 description → null");

    const dirty = { ...legacy, poiLevel: 4, listRank: {}, description: [] } as unknown as Item;
    eq(itemPoiLevel(dirty), null, "非字符串 poiLevel（数字）→ null");
    eq(itemListRank(dirty), null, "非字符串 listRank（对象）→ null");
    eq(itemDescription(dirty), null, "非字符串 description（数组）→ null");

    eq(legacy.poiLevel, undefined, "读时默认不得改写存量对象（poiLevel）");
    const keys = persistedKeys(legacy);
    ok(
      !keys.includes("poiLevel") && !keys.includes("listRank") && !keys.includes("description"),
      "存量落盘形态零变化",
    );

    // 有效值原样返回（poiLevel 保留飞猪原始形态，归一化交给 normalizePoiLevel）
    const valid = makeItem("v", "西岛", { poiLevel: "4", listRank: "海南4A/5A景点榜第2名", description: "介绍" });
    eq(itemPoiLevel(valid), "4", "有效 poiLevel 原样返回（未归一化）");
    eq(itemListRank(valid), "海南4A/5A景点榜第2名", "有效 listRank 原样返回");
    eq(itemDescription(valid), "介绍", "有效 description 原样返回");
  });

  // ---------- S4 poiLevel 归一化 ----------

  await test("S4-1 normalizePoiLevel 各形态归一化正确（脏值/3A/空一律 null，不输出脏值）", () => {
    // 4A 系
    eq(normalizePoiLevel("4"), "4A", '"4" → 4A');
    eq(normalizePoiLevel("4A"), "4A", '"4A" → 4A');
    eq(normalizePoiLevel("4a"), "4A", '"4a" → 4A（大小写无关）');
    eq(normalizePoiLevel("AAAA"), "4A", '"AAAA"（4 个 A）→ 4A');
    eq(normalizePoiLevel("4A级景区"), "4A", "含 4 的长文案 → 4A");
    // 5A 系
    eq(normalizePoiLevel("5"), "5A", '"5" → 5A');
    eq(normalizePoiLevel("5A"), "5A", '"5A" → 5A');
    eq(normalizePoiLevel("AAAAA"), "5A", '"AAAAA"（5 个 A）→ 5A');
    eq(normalizePoiLevel("国家5A级旅游景区"), "5A", "含 5 的长文案 → 5A");
    // 不展示（null）
    eq(normalizePoiLevel("3"), null, '"3"（3A）不展示');
    eq(normalizePoiLevel("3A"), null, '"3A" 不展示');
    eq(normalizePoiLevel("AAA"), null, '"AAA"（3 个 A）不展示');
    eq(normalizePoiLevel("AAAAAA"), null, '"AAAAAA"（6 个 A）不展示');
    eq(normalizePoiLevel("2A"), null, '"2A" 不展示');
    eq(normalizePoiLevel(""), null, "空串 → null");
    eq(normalizePoiLevel("   "), null, "纯空白 → null");
    eq(normalizePoiLevel(null), null, "null → null");
    eq(normalizePoiLevel(undefined), null, "undefined → null");
    eq(normalizePoiLevel("无等级"), null, "无数字脏值 → null（绝不输出原始脏值）");
    // Item → 展示文本一步到位
    eq(itemPoiLevelLabel(makeItem("a", "西岛", { poiLevel: "4" })), "4A", "itemPoiLevelLabel: 4 → 4A");
    eq(itemPoiLevelLabel(makeItem("b", "某", { poiLevel: "AAAAA" })), "5A", "itemPoiLevelLabel: AAAAA → 5A");
    eq(itemPoiLevelLabel(makeItem("c", "某", { poiLevel: "3" })), null, "itemPoiLevelLabel: 3 → null");
    eq(itemPoiLevelLabel(makeItem("d", "某")), null, "itemPoiLevelLabel: 缺失 → null");
  });

  // ---------- S5 展示口径源码在位（PoiMeta.tsx） ----------

  await test("S5-1 展示组件口径：榜单空不产文本、介绍默认收起、等级脏值不渲染", async () => {
    // listRank 缺失 / 空白 → 组件返回 null（有则显示、无则完全不占位，不产空文本）
    await assertSource(
      "web/src/components/PoiMeta.tsx",
      /if \(typeof rank !== "string" \|\| rank\.trim\(\) === ""\) return null;/,
      "PoiRankChip：listRank 空/缺失返回 null（不产空文本、不占位）",
    );
    // description 空 / 缺失 → 整个入口不出现
    await assertSource(
      "web/src/components/PoiMeta.tsx",
      /if \(typeof text !== "string" \|\| text\.trim\(\) === ""\) return null;/,
      "PoiDescription：description 空/缺失时整个入口不出现",
    );
    // description 折叠默认收起（useState(false)），展开态才渲染正文，可再收起
    await assertSource(
      "web/src/components/PoiMeta.tsx",
      /const \[open, setOpen\] = useState\(false\);/,
      "PoiDescription：默认收起（useState(false)，长文本绝不默认展开）",
    );
    await assertSource(
      "web/src/components/PoiMeta.tsx",
      /\{open \? <div className="poi-desc-body">/,
      "PoiDescription：仅展开态渲染正文",
    );
    await assertSource(
      "web/src/components/PoiMeta.tsx",
      /onClick=\{\(\) => setOpen\(\(prev\) => !prev\)\}/,
      "PoiDescription：点击可切换展开/再次收起",
    );
    // poiLevel 无法识别 → 不渲染徽标（不输出脏值）
    await assertSource(
      "web/src/components/PoiMeta.tsx",
      /const label = normalizePoiLevel\(level\);\s*\n\s*if \(label === null\) return null;/,
      "PoiLevelTag：归一化为 null（无法识别）时不渲染徽标",
    );
  });

  // ---------- S6 存量脚本幂等与回填口径 ----------

  await test("S6-1 真实离线缓存索引含西岛三项（零 live 调用数据源可用）", async () => {
    const index = await loadFlyAiPoiIndex(CACHE_DIR);
    ok(index.size > 0, `缓存索引应非空（实际 ${index.size} 个 POI id）`);
    const xidao = index.get("2611");
    ok(xidao !== undefined, "缓存应含西岛（providerId=2611）");
    eq(xidao!.poiLevel, "4", "缓存西岛 poiLevel=4");
    eq(xidao!.listRank, "海南4A/5A景点榜第2名", "缓存西岛 listRank");
    ok(
      typeof xidao!.description === "string" && xidao!.description.length > 0,
      "缓存西岛 description 非空",
    );
  });

  await test("S6-2 applyTask330Fixes 幂等：第二次执行为空操作且结果深度相等", async () => {
    const index = await loadFlyAiPoiIndex(CACHE_DIR);
    const trip = {
      itemRegistry: {
        i1: makeItem("i1", "西岛", { origin: "fliggy", providerId: "2611" }),
        i2: makeItem("i2", "蜈支洲岛", { origin: "fliggy", providerId: "99" }), // 不在缓存
      },
    } as unknown as Trip;
    const first = applyTask330Fixes(trip, index);
    eq(first.length, 1, "首次应只回填命中缓存的西岛");
    eq(first[0]!.name, "西岛", "回填目标是西岛");
    ok(
      first[0]!.fields.includes("poiLevel") &&
        first[0]!.fields.includes("listRank") &&
        first[0]!.fields.includes("description"),
      "西岛三项齐全（poiLevel + listRank + description）",
    );
    eq(trip.itemRegistry.i1!.poiLevel, "4", "回填后 poiLevel=4");
    const snapshot = JSON.stringify(trip.itemRegistry);
    const second = applyTask330Fixes(trip, index);
    eq(second, [], "第二次执行应为空操作（幂等）");
    eq(JSON.stringify(trip.itemRegistry), snapshot, "重复执行不得改动数据");
    eq(trip.itemRegistry.i2!.poiLevel, undefined, "未命中缓存的蜈支洲岛不回填");
  });

  await test("S6-3 回填口径：缓存全 null 不回写、已有非空值不覆盖、custom 不回填", () => {
    // 缓存记录三项全 null → 不回填、不把 null 写进落盘形态（与升级路径同口径）
    const nullIndex: Map<string, CachedPoiMeta> = new Map([
      // freePoiStatus 字段由 Task #372 补入 CachedPoiMeta；本用例保持全 null 语义不变
      ["X", { poiLevel: null, listRank: null, description: null, freePoiStatus: null }],
    ]);
    const t1 = {
      itemRegistry: { j: makeItem("j", "某", { origin: "fliggy", providerId: "X" }) },
    } as unknown as Trip;
    eq(applyTask330Fixes(t1, nullIndex), [], "缓存全 null → 不回填");
    const keys = persistedKeys(t1.itemRegistry.j!);
    ok(
      !keys.includes("poiLevel") && !keys.includes("listRank") && !keys.includes("description"),
      "不把 null 写进落盘形态（无信号不回写 null）",
    );

    // Item 已有非空值 → 不被缓存覆盖（保守 + 幂等：运行时可能已写入更新值）
    const keepIndex: Map<string, CachedPoiMeta> = new Map([
      ["2611", { poiLevel: "5", listRank: "新榜", description: "新介绍", freePoiStatus: null }],
    ]);
    const t2 = {
      itemRegistry: {
        k: makeItem("k", "西岛", {
          origin: "fliggy",
          providerId: "2611",
          poiLevel: "4",
          listRank: "旧榜",
          description: "旧介绍",
        }),
      },
    } as unknown as Trip;
    eq(applyTask330Fixes(t2, keepIndex), [], "已有非空值不覆盖");
    eq(t2.itemRegistry.k!.poiLevel, "4", "既有 poiLevel 不被覆盖");
    eq(t2.itemRegistry.k!.listRank, "旧榜", "既有 listRank 不被覆盖");

    // custom / 无 providerId → 不回填
    const anyIndex: Map<string, CachedPoiMeta> = new Map([
      ["2611", { poiLevel: "4", listRank: "榜", description: "介绍", freePoiStatus: null }],
    ]);
    const t3 = {
      itemRegistry: { c: makeItem("c", "西岛", { origin: "custom", providerId: null }) },
    } as unknown as Trip;
    eq(applyTask330Fixes(t3, anyIndex), [], "custom（无 providerId）不回填");
  });

  // ---------- S7 全量存量零抛错 + PD 行程回填在位 ----------

  await test("S7-1 全部存量行程读三项字段零抛错（缺失字段的行程照常读取）", () => {
    let read = 0;
    for (const { item } of stored) {
      itemPoiLevel(item); // 不得抛错
      itemListRank(item);
      itemDescription(item);
      itemPoiLevelLabel(item);
      read += 1;
    }
    ok(read > 0, `应读取到存量 Item（实际 ${read} 条）`);
  });

  await test("S7-2 PD 行程西岛三项已回填在位 + 国际免税城仍判免费（#329/#330D 不回归）", async () => {
    const raw = await fs.readFile(PD_TRIP_FILE, "utf8");
    const trip = JSON.parse(raw) as Trip;
    const xidao = Object.values(trip.itemRegistry).find(
      (item) => item.name === "西岛" && item.origin === "fliggy",
    );
    ok(xidao !== undefined, "PD 行程应有飞猪西岛");
    eq(itemPoiLevel(xidao), "4", "西岛 poiLevel 已回填=4");
    eq(itemPoiLevelLabel(xidao), "4A", "西岛展示为 4A 徽标");
    eq(itemListRank(xidao), "海南4A/5A景点榜第2名", "西岛 listRank 已回填");
    ok(itemDescription(xidao) !== null, "西岛 description 已回填（介绍折叠区有内容）");
    // 任务 D 不回归：国际免税城仍判免费（名称通道）
    const dutyFree = Object.values(trip.itemRegistry).find((item) => item.name.includes("免税"));
    ok(dutyFree !== undefined, "PD 行程应有国际免税城");
    eq(isFreeAdmissionItem(dutyFree), true, "国际免税城仍判免费（#329 FREE + #330D 名称通道）");
  });

  // ---------- 汇总 ----------
  const failures = results.filter((result) => result.error !== null);
  console.log(`\n[VERIFY-330] ${results.length - failures.length}/${results.length} 通过`);
  if (failures.length > 0) {
    throw new Error(
      `Task #330 验收失败 ${failures.length} 项：${failures.map((failure) => failure.label).join("，")}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error("[VERIFY-330] 验收脚本失败：", error);
  process.exitCode = 1;
});
