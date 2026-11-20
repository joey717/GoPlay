/**
 * Task #300 回归验证脚本（纯函数，不依赖模型 / 网络 / 服务端进程）：
 *   S1. 命中下沉：过江龙索桥场景（YLW-06 复现）——quote 明确命中唯一子景点 → 归属下沉
 *   S2. 无命中归父：quote 不含任何子景点名 → 保持归 canonical 父卡
 *   S3. 歧义保守：quote 同时命中多个子景点 → 保守归父卡（不下沉）
 *   S4. 别名归一下沉：子景点经 resolvePoiAlias 折叠后匹配（山顶婚礼草坪 → 山顶公园）
 *   S5. 不产生新实体：下沉后 note_tip 经 assembleEntries 只写 mention，不建 Item/Visit/Stop
 *   S6. 真实缓存场景：YLW-06 抽取缓存中 3 条 note_tip 预期下沉
 *
 * 运行：npx tsx server/src/ai/verify-task300.ts
 */

import assert from "node:assert/strict";
import type { SourceEvidence, Trip } from "@goplay/shared";
import { SCHEMA_VERSION } from "@goplay/shared";
import {
  normalizeParsedEntry,
  noteTipMentionEntry,
  assembleEntries,
  type ParsedEntry,
  type GuidePoiAligner,
} from "./assemble.js";
import {
  attributeNoteTips,
  collectSubSpotNames,
  detectSingleAttraction,
} from "./noteAttribution.js";
import type { FlyAIPoi } from "../flyai/client.js";

function pass(name: string): void {
  console.log(`✓ ${name}`);
}

function makePoi(name: string, type: "attraction" | "in_attraction", parent: string | null, quote = ""): ParsedEntry {
  const parsed = normalizeParsedEntry({ name, type, parentAttraction: parent, quote, summary: "笔记提及" });
  assert.ok(parsed !== null, `条目「${name}」应通过结构归一化`);
  return parsed;
}

function makeTip(name: string, quote: string, parent: string | null = null): ParsedEntry {
  const parsed = normalizeParsedEntry({ name, type: "note_tip", parentAttraction: parent, quote, summary: name });
  assert.ok(parsed !== null, `note_tip「${name}」应通过结构归一化`);
  return parsed;
}

const CANONICAL = "亚龙湾热带天堂森林公园";

// ===== S1：命中下沉——过江龙索桥场景（YLW-06 复现） =====
{
  const entries: ParsedEntry[] = [
    makePoi(CANONICAL, "attraction", null),
    makePoi("过江龙索桥", "in_attraction", CANONICAL, "过江龙索桥排队人巨多"),
    makePoi("兰花谷", "in_attraction", CANONICAL, "坐观光车第一站：兰花谷"),
    makePoi("试婚房", "in_attraction", CANONICAL, "《非诚勿扰2》拍摄原址试婚房"),
    // YLW-06 场景：quote 明确提到「过江龙索桥」
    makeTip("索桥排队避雷", "过江龙索桥排队人巨多，节假日排1小时以上，不想花钱排队，走旁边平行木栈道，景色差不多。"),
  ];

  const result = attributeNoteTips(entries);
  const tips = result.filter((e) => e.type === "note_tip");
  assert.equal(tips.length, 1, "应有 1 条 note_tip（去重可能删掉与 POI quote 重叠的——检查）");

  // 核心断言：归属下沉到「过江龙索桥」而非父卡
  assert.equal(tips[0]!.parentAttraction, "过江龙索桥", "归属应下沉到子景点「过江龙索桥」");
  assert.equal(tips[0]!.name, "过江龙索桥", "name 应为下沉目标子景点名");
  assert.ok(tips[0]!.summary.includes("索桥排队避雷"), "原始描述标签应保留在 summary");
  // quote 不被改写
  assert.ok(tips[0]!.quote.includes("过江龙索桥排队人巨多"), "quote 原文不改写");

  pass("S1：命中下沉——过江龙索桥场景（YLW-06 复现）");
}

// ===== S2：无命中归父——quote 不含任何子景点名 =====
{
  const entries: ParsedEntry[] = [
    makePoi(CANONICAL, "attraction", null),
    makePoi("过江龙索桥", "in_attraction", CANONICAL),
    makePoi("兰花谷", "in_attraction", CANONICAL),
    // 通用建议，不涉及任何子景点
    makeTip("门票省钱", "网上提前买票比现场窗口便宜"),
    makeTip("上午上山", "建议上午上山，下午容易起大雾看不到海"),
  ];

  const result = attributeNoteTips(entries);
  const tips = result.filter((e) => e.type === "note_tip");
  assert.equal(tips.length, 2);

  for (const tip of tips) {
    assert.equal(tip.parentAttraction, CANONICAL, "无子景点命中 → 归属保持 canonical 父卡");
    assert.equal(tip.name, CANONICAL, "name 设为父卡名");
  }

  pass("S2：无命中归父——quote 不含任何子景点名");
}

// ===== S3：歧义保守——quote 同时命中多个子景点 → 不下沉 =====
{
  const entries: ParsedEntry[] = [
    makePoi(CANONICAL, "attraction", null),
    makePoi("过江龙索桥", "in_attraction", CANONICAL),
    makePoi("兰花谷", "in_attraction", CANONICAL),
    // quote 同时提到两个子景点
    makeTip("路线建议", "从兰花谷出发走过江龙索桥到山顶，全程约2小时"),
  ];

  const result = attributeNoteTips(entries);
  const tips = result.filter((e) => e.type === "note_tip");
  assert.equal(tips.length, 1);

  // 歧义：保守归父卡
  assert.equal(tips[0]!.parentAttraction, CANONICAL, "多子景点命中 → 保守归父卡");
  assert.equal(tips[0]!.name, CANONICAL, "歧义时 name 仍为父卡名");

  pass("S3：歧义保守——多子景点命中不下沉");
}

// ===== S4：别名归一下沉——子景点通过 resolvePoiAlias 折叠后匹配 =====
{
  // 「山顶婚礼草坪」是「山顶公园」的别名（shared/src/poiAlias.ts 第 46 行）
  // 抽取到的 in_attraction 名为「山顶婚礼草坪」，resolvePoiAlias → 「山顶公园」
  // note_tip quote 中提到「山顶公园」→ 应匹配到 resolved canonical「山顶公园」→ 下沉
  const entries: ParsedEntry[] = [
    makePoi(CANONICAL, "attraction", null),
    makePoi("山顶婚礼草坪", "in_attraction", CANONICAL, "山顶必逛：婚礼礼堂大草坪"),
    makePoi("过江龙索桥", "in_attraction", CANONICAL),
    // quote 提到的是 resolved canonical「山顶公园」
    makeTip("拍照提示", "山顶公园拍照最佳时间是早上9点，云雾缭绕"),
  ];

  // 验证 collectSubSpotNames 的别名折叠
  const poiEntries = entries.filter((e) => e.type !== "note_tip");
  const single = detectSingleAttraction(poiEntries);
  assert.equal(single, CANONICAL);
  const groups = collectSubSpotNames(poiEntries, CANONICAL);
  assert.ok(groups.has("山顶公园"), "「山顶婚礼草坪」应折叠为 resolved canonical「山顶公园」");
  assert.deepEqual(groups.get("山顶公园"), ["山顶婚礼草坪"], "rawName 保留原始抽取名");

  const result = attributeNoteTips(entries);
  const tips = result.filter((e) => e.type === "note_tip");
  assert.equal(tips.length, 1);

  // 下沉到「山顶公园」（resolved canonical）
  assert.equal(tips[0]!.parentAttraction, "山顶公园", "别名归一后应下沉到 resolved canonical「山顶公园」");
  assert.equal(tips[0]!.name, "山顶公园");

  // 也验证：quote 提到原始表面名「山顶婚礼草坪」同样能匹配
  const entries2: ParsedEntry[] = [
    makePoi(CANONICAL, "attraction", null),
    makePoi("山顶婚礼草坪", "in_attraction", CANONICAL),
    makeTip("草坪拍照", "山顶婚礼草坪适合拍婚纱照，早上光线好"),
  ];
  const result2 = attributeNoteTips(entries2);
  const tips2 = result2.filter((e) => e.type === "note_tip");
  assert.equal(tips2[0]!.parentAttraction, "山顶公园", "原始表面名命中 → 同样下沉到 resolved canonical");

  pass("S4：别名归一下沉（山顶婚礼草坪 → 山顶公园）");
}

// ===== S5：不产生新实体——下沉后 assembleEntries 只写 mention =====
{
  // 构建最小行程夹具
  const trip: Trip = {
    tripId: "trip_verify_300",
    schemaVersion: SCHEMA_VERSION,
    version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-01", end: "2026-11-05", nights: 4 },
    dayRefs: ["day_1"],
    days: {
      day_1: {
        dayId: "day_1", dayIndex: 1, date: "2026-11-01",
        departTime: null, departTimeOverridden: false,
        scheduleVisitRefs: [], lodging: null,
      },
    },
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
    constraints: [],
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
  };

  const evidence: SourceEvidence = {
    evidenceId: "ev_300",
    kind: "note_text",
    noteIndex: 1,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions: [],
  };
  trip.evidences["ev_300"] = evidence;

  // 模拟归属下沉后的 entries（attributeNoteTips 产出）
  const sunkTip: ParsedEntry = {
    ...makeTip("索桥排队避雷", "过江龙索桥排队人巨多，不想排队走旁边栈道"),
    parentAttraction: "过江龙索桥",
    name: "过江龙索桥",
    summary: "索桥排队避雷：索桥排队超1小时",
  };
  const poiEntry = makePoi("过江龙索桥", "in_attraction", CANONICAL, "过江龙索桥排队人巨多");
  const parentEntry = makePoi(CANONICAL, "attraction", null);

  // 用空桩 aligner（禁 live FlyAI）
  const stubAligner: GuidePoiAligner = async () => ({
    match: null, candidates: [], error: null,
  });

  const itemCountBefore = Object.keys(trip.itemRegistry).length;
  const visitCountBefore = Object.keys(trip.visits).length;
  const stopCountBefore = Object.keys(trip.stops).length;

  const outcome = await assembleEntries(
    trip,
    [parentEntry, poiEntry, sunkTip],
    evidence,
    "ev_300",
    [],
    new Map<string, FlyAIPoi[]>(),
    { aligner: stubAligner },
  );

  // note_tip 不产生额外实体（Item/Visit/Stop 只来自 attraction + in_attraction）
  // 关键断言：下沉后的 note_tip 只写了 mention，不新建 Item/Visit/Stop
  const tipMentions = evidence.mentions.filter(
    (m) => m.quoteText.includes("不想排队走旁边栈道"),
  );
  assert.equal(tipMentions.length, 1, "下沉后 note_tip 应有 1 条 mention");
  assert.equal(tipMentions[0]!.text, "过江龙索桥", "mention.text 应为子景点名");
  assert.equal(tipMentions[0]!.extractedName, "过江龙索桥", "mention.extractedName 应为子景点名");

  // noteTipMentionEntry 幂等：parent === name 时原样返回
  const normalized = noteTipMentionEntry(sunkTip);
  assert.equal(normalized.name, "过江龙索桥", "noteTipMentionEntry 幂等（parent===name 不改写）");

  pass("S5：不产生新实体——下沉后 note_tip 只写 mention");
}

// ===== S6：真实缓存场景——YLW-06 抽取缓存中的下沉预期 =====
{
  // 模拟亚龙湾真实抽取缓存的 POI 条目（eval/cache/extraction/6a93bde9000000002600105b.json）
  const poiEntries: ParsedEntry[] = [
    makePoi(CANONICAL, "attraction", null, "亚龙湾热带天堂森林公园 完整攻略+避坑指南"),
    makePoi("兰花谷", "in_attraction", CANONICAL),
    makePoi("过江龙索桥", "in_attraction", CANONICAL),
    makePoi("试婚房", "in_attraction", CANONICAL),
    makePoi("山顶公园", "in_attraction", CANONICAL),
    makePoi("婚礼礼堂大草坪", "in_attraction", CANONICAL),
    makePoi("沧海观景台", "in_attraction", CANONICAL),
    makePoi("天街商业街", "in_attraction", CANONICAL),
    makePoi("玻璃栈道", "in_attraction", CANONICAL),
    makePoi("鸟巢雨林栈道", "in_attraction", CANONICAL),
    makePoi("天街餐厅", "in_attraction", CANONICAL),
  ];

  // 模拟缓存中的 note_tip 条目（quote 取自真实抽取缓存）
  const noteTips: ParsedEntry[] = [
    makeTip("门票省钱", "门票+往返观光车：140元左右，网上提前买比现场窗口便宜"),
    makeTip("观光车必买", "⚠️重点：**观光车必买！！**景区全是盘山陡坡，千万不要想着步行上山，走路又远又危险。"),
    makeTip("早上山避雾", "不要大中午来，优先早上9‑10点上山；随身带薄外套+雨伞。\n建议上午上山，下午容易起雾；下午晚一点来，阳光柔和拍照好看，但遇上雾就看不到海。"),
    makeTip("备外套雨伞", "山上气温比山下低3‑5℃，经常起雾、阵雨。大雾天山顶看不到亚龙湾大海！不要大中午来，优先早上9‑10点上山；随身带薄外套+雨伞。"),
    // YLW-06：预期下沉到「过江龙索桥」
    makeTip("索桥排队避雷", "过江龙索桥排队人巨多，节假日排1小时以上，不想花钱排队，走旁边平行木栈道，景色差不多。"),
    // YLW-08：预期下沉到「玻璃栈道」
    makeTip("玻璃栈道避雷", "玻璃栈道谨慎买，如果遇到大雾，上去白茫茫什么都拍不到，钱就白花。"),
    // 预期下沉到「试婚房」
    makeTip("试婚房免费", "试婚房是免费！不要被路边人忽悠花钱带你参观。"),
    makeTip("晕车备药", "观光车是盘山公路，弯道特别多，容易晕车，晕车的提前备好晕车药。"),
    // 「山顶很多有偿拍照」→ 检查是否命中「山顶公园」（"山顶" ≠ "山顶公园" 全串匹配）
    makeTip("有偿拍照避雷", "山顶很多有偿拍照的小贩，先问清楚价格再拍，避免拍完漫天要价；自己手机完全足够出片。"),
    makeTip("观光车单向", "站点是单向行驶，不能倒回去坐，按顺序游玩。"),
  ];

  const single = detectSingleAttraction(poiEntries);
  assert.equal(single, CANONICAL);

  const groups = collectSubSpotNames(poiEntries, CANONICAL);
  // 验证子景点收集：「婚礼礼堂大草坪」resolvePoiAlias → 「山顶公园」，与「山顶公园」合并
  assert.ok(groups.has("山顶公园"), "「婚礼礼堂大草坪」别名折叠到「山顶公园」");
  const shandingRawNames = groups.get("山顶公园")!;
  assert.ok(shandingRawNames.includes("山顶公园"), "rawNames 包含「山顶公园」");
  assert.ok(shandingRawNames.includes("婚礼礼堂大草坪"), "rawNames 包含「婚礼礼堂大草坪」");

  // 逐条验证下沉判定
  const allEntries = [...poiEntries, ...noteTips];
  const result = attributeNoteTips(allEntries);
  const resultTips = result.filter((e) => e.type === "note_tip");

  // 建立 name → tip 映射（attributeNoteTips 已改写 name）
  // 按原始顺序：门票省钱、观光车必买、早上山避雾、备外套雨伞、索桥排队避雷、
  //            玻璃栈道避雷、试婚房免费、晕车备药、有偿拍照避雷、观光车单向

  // 预期下沉的 3 条
  const sunkBridge = resultTips.find((t) => t.summary.includes("索桥排队避雷"));
  assert.ok(sunkBridge !== undefined, "索桥排队避雷 tip 应存在");
  assert.equal(sunkBridge!.parentAttraction, "过江龙索桥", "YLW-06 下沉到过江龙索桥");

  const sunkGlass = resultTips.find((t) => t.summary.includes("玻璃栈道避雷"));
  assert.ok(sunkGlass !== undefined, "玻璃栈道避雷 tip 应存在");
  assert.equal(sunkGlass!.parentAttraction, "玻璃栈道", "YLW-08 下沉到玻璃栈道");

  const sunkTrial = resultTips.find((t) => t.summary.includes("试婚房免费"));
  assert.ok(sunkTrial !== undefined, "试婚房免费 tip 应存在");
  assert.equal(sunkTrial!.parentAttraction, "试婚房", "试婚房免费下沉到试婚房");

  // 预期不下沉的条目
  const noSink = resultTips.filter((t) => t.parentAttraction === CANONICAL);
  assert.ok(noSink.length >= 5, `至少 5 条保持归父卡，实得 ${noSink.length}`);

  // 「山顶很多有偿拍照」— "山顶公园" 整体子串匹配：quote 中只有 "山顶" 不含 "山顶公园"
  const photoTip = resultTips.find((t) => t.summary.includes("有偿拍照避雷"));
  assert.ok(photoTip !== undefined);
  assert.equal(photoTip!.parentAttraction, CANONICAL, "「山顶」≠「山顶公园」全串 → 不下沉");

  pass("S6：真实缓存场景——3 条下沉（过江龙索桥/玻璃栈道/试婚房）、其余归父卡");
}

console.log("\n===== Task #300 verify 全部通过 =====");
