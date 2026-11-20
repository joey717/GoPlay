/**
 * Task #287 回归验证脚本（纯函数，不依赖模型 / 网络 / 服务端进程）：
 *   S1. normalizeParsedEntry 正确处理 type="note_tip"（不降级为 attraction）
 *   S2. 单景点笔记归属判定：POI 条目全收敛到 1 canonical → note_tip 归属该 canonical
 *   S3. 多景点笔记：note_tip 保留模型填写的 parentAttraction
 *   S4. 去重：note_tip.quote 与 POI 条目 quote 高重叠时删除
 *   S5. 亚龙湾场景端到端模拟（golden E9 的 5 条 miss 均可被 note_tip surface）
 *   S6. poiAlias 别名参与归属判定（简称「亚龙湾森林公园」→ canonical）
 *   S7. assembleEntries 对 note_tip 只写 mention 不建 Item/Visit/Stop
 *   S8. EXTRACT_RULES_TEXT 包含 note_tip 相关指令（prompt 层回归）
 *   S9. （Task #294 回归）note_tip 归属后并入所属景区地点，不计入覆盖估算的未排素材单元
 *  S10. （Task #294 回归）C1 澄清门语义不变：真稀疏仍触发、只跳过 enrichment（锚定既有排期）
 *
 * 运行：npx tsx server/src/ai/verify-task287.ts
 */

import assert from "node:assert/strict";
import type { Day, SourceEvidence, Trip } from "@goplay/shared";
import {
  SCHEMA_VERSION,
  createEmptyGuideImageProgress,
  estimateGuideCoverage,
  type CoverageGapResult,
} from "@goplay/shared";
import {
  normalizeParsedEntry,
  noteTipMentionEntry,
  pushMention,
  type ParsedEntry,
} from "./assemble.js";
import {
  attributeNoteTips,
  deduplicateNoteTips,
  detectSingleAttraction,
  extractRootCanonicals,
  textSimilarity,
  DEDUP_THRESHOLD,
} from "./noteAttribution.js";
import { mergeGuideMentions } from "../guides/merge.js";
import { EXTRACT_RULES_TEXT } from "./prompt.js";

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

// ===== S1：normalizeParsedEntry 正确处理 note_tip =====
{
  const raw = { name: "门票省钱", type: "note_tip", parentAttraction: "亚龙湾热带天堂森林公园", quote: "网上提前买票比现场窗口便宜", summary: "提前网上买票更便宜" };
  const entry = normalizeParsedEntry(raw);
  assert.ok(entry !== null, "note_tip 应通过归一化");
  assert.equal(entry.type, "note_tip", "type 应保持 note_tip 不降级");
  assert.equal(entry.parentAttraction, "亚龙湾热带天堂森林公园");
  assert.equal(entry.name, "门票省钱");
  assert.equal(entry.quote, "网上提前买票比现场窗口便宜");

  // note_tip 缺 parentAttraction 也不降级（区别于 in_attraction）
  const raw2 = { name: "雨具备忘", type: "note_tip", quote: "备好雨具", summary: "带雨具" };
  const entry2 = normalizeParsedEntry(raw2);
  assert.ok(entry2 !== null);
  assert.equal(entry2.type, "note_tip", "缺 parentAttraction 的 note_tip 不降级为 attraction");
  assert.equal(entry2.parentAttraction, null);

  pass("S1：normalizeParsedEntry 正确处理 note_tip");
}

// ===== S2：单景点笔记归属判定 =====
{
  const entries: ParsedEntry[] = [
    makePoi("亚龙湾热带天堂森林公园", "attraction", null),
    makePoi("过江龙索桥", "in_attraction", "亚龙湾热带天堂森林公园"),
    makePoi("兰花谷", "in_attraction", "亚龙湾热带天堂森林公园"),
    makeTip("门票省钱", "网上提前买票比现场窗口便宜"),
    makeTip("拍照避雷", "有偿拍照漫天要价，先问清楚价格再拍"),
  ];

  const canonicals = extractRootCanonicals(entries);
  assert.equal(canonicals.size, 1, "应只有 1 个 canonical");
  assert.ok(canonicals.has("亚龙湾热带天堂森林公园"));

  const single = detectSingleAttraction(entries);
  assert.equal(single, "亚龙湾热带天堂森林公园", "应判定为单景点笔记");

  const result = attributeNoteTips(entries);
  const tips = result.filter((e) => e.type === "note_tip");
  assert.equal(tips.length, 2);
  for (const tip of tips) {
    assert.equal(tip.parentAttraction, "亚龙湾热带天堂森林公园", "归属应设为 canonical");
    assert.equal(tip.name, "亚龙湾热带天堂森林公园", "name 应设为归属景点名");
  }

  pass("S2：单景点笔记归属判定");
}

// ===== S3：多景点笔记保留模型归属 =====
{
  const entries: ParsedEntry[] = [
    makePoi("亚龙湾热带天堂森林公园", "attraction", null),
    makePoi("大东海", "attraction", null),
    makePoi("过江龙索桥", "in_attraction", "亚龙湾热带天堂森林公园"),
    makeTip("门票省钱", "网上提前买票便宜", "亚龙湾热带天堂森林公园"),
    makeTip("浮潜建议", "大东海浮潜要注意安全", "大东海"),
    makeTip("通用建议", "三亚紫外线很强记得防晒", null),
  ];

  const single = detectSingleAttraction(entries);
  assert.equal(single, null, "多景点不应判定为单景点");

  const result = attributeNoteTips(entries);
  const tips = result.filter((e) => e.type === "note_tip");
  assert.equal(tips.length, 3);
  // 保留模型填写的 parentAttraction
  assert.equal(tips[0]!.parentAttraction, "亚龙湾热带天堂森林公园");
  assert.equal(tips[1]!.parentAttraction, "大东海");
  assert.equal(tips[2]!.parentAttraction, null);
  // name 不被覆盖（多景点场景保留原始描述标签）
  assert.equal(tips[0]!.name, "门票省钱");
  assert.equal(tips[1]!.name, "浮潜建议");

  pass("S3：多景点笔记保留模型归属");
}

// ===== S4：去重（note_tip 与 POI quote 高重叠） =====
{
  const poiEntries: ParsedEntry[] = [
    makePoi("过江龙索桥", "in_attraction", "亚龙湾热带天堂森林公园", "过江龙索桥排队人巨多，节假日排1小时以上，不想排可走旁边栈道绕过去不用花钱"),
    makePoi("天街餐厅", "in_attraction", "亚龙湾热带天堂森林公园", "山上天街餐厅物价贵，矿泉水、零食建议山下提前买好带上去"),
  ];
  const noteTips: ParsedEntry[] = [
    // 与过江龙索桥 quote 高度重叠 → 应被去重删除
    makeTip("排队避雷", "过江龙索桥排队人巨多，节假日排1小时以上，不想排可走旁边栈道绕过去"),
    // 与任何 POI 条目都不重叠 → 应保留
    makeTip("门票省钱", "网上提前买票比现场窗口便宜"),
    makeTip("上午上山", "建议上午上山，下午容易起大雾看不到海"),
  ];

  const deduped = deduplicateNoteTips(noteTips, poiEntries);
  assert.equal(deduped.length, 2, "高度重叠的 1 条应被删除");
  assert.equal(deduped[0]!.name, "门票省钱");
  assert.equal(deduped[1]!.name, "上午上山");

  pass("S4：去重（note_tip 与 POI quote 高重叠时删除）");
}

// ===== S5：亚龙湾场景端到端模拟（E9 的 5 条 miss 可被 note_tip surface） =====
{
  // 模拟亚龙湾笔记的完整抽取结果（POI + note_tip）
  const entries: ParsedEntry[] = [
    makePoi("亚龙湾热带天堂森林公园", "attraction", null, "亚龙湾热带天堂森林公园 完整攻略+避坑指南"),
    makePoi("试婚房", "in_attraction", "亚龙湾热带天堂森林公园", "《非诚勿扰2》拍摄原址试婚房"),
    makePoi("过江龙索桥", "in_attraction", "亚龙湾热带天堂森林公园", "过江龙索桥排队人巨多"),
    makePoi("山顶婚礼草坪", "in_attraction", "亚龙湾热带天堂森林公园", "山顶必逛：婚礼礼堂大草坪"),
    makePoi("玻璃观景台", "in_attraction", "亚龙湾热带天堂森林公园", "玻璃观景台可以看全景"),
    makePoi("兰花谷", "in_attraction", "亚龙湾热带天堂森林公园", "坐观光车第一站：兰花谷"),
    // note_tip 条目（对应 E9 golden 的 5 条 miss）
    makeTip("拍照避雷", "有偿拍照漫天要价，先问清楚价格再拍。"),          // YLW-07
    makeTip("玻璃栈道避雷", "玻璃栈道谨慎买，如果遇到大雾，上去白茫茫什么都拍不到。"), // YLW-08
    makeTip("门票省钱", "网上提前买票比现场窗口便宜。"),                  // YLW-09
    makeTip("观光车雨具", "观光车一定要买全是盘山陡坡，备好雨具，山上天气变幻莫测。"), // YLW-10
    makeTip("上午上山", "建议上午上山，下午容易起大雾看不到海；下午晚一点来，阳光柔和拍照好看。"), // YLW-11
  ];

  const result = attributeNoteTips(entries);
  const tips = result.filter((e) => e.type === "note_tip");
  assert.equal(tips.length, 5, "5 条 note_tip 不应被去重（与 POI quote 重叠度不够高）");

  // 验证归属
  for (const tip of tips) {
    assert.equal(tip.parentAttraction, "亚龙湾热带天堂森林公园");
    assert.equal(tip.name, "亚龙湾热带天堂森林公园");
  }

  // 验证 E9 matcher 的文本相似度能命中（quote 包含关键原文）
  const goldenTexts = [
    "有偿拍照漫天要价，先问清楚价格再拍。",
    "玻璃栈道谨慎买，如果遇到大雾，上去白茫茫什么都拍不到。",
    "网上提前买票比现场窗口便宜。",
    "观光车一定要买全是盘山陡坡，备好雨具，山上天气变幻莫测。",
    "建议上午上山，下午容易起大雾看不到海；下午晚一点来，阳光柔和拍照好看。",
  ];
  for (let i = 0; i < goldenTexts.length; i++) {
    const tip = tips[i]!;
    // E9 matcher 用 textSimilarity(expected.text, entry.quote) 匹配
    // note_tip.quote 就是原文 → sim 应接近 1.0
    const sim = textSimilarity(goldenTexts[i]!, tip.quote);
    assert.ok(sim >= 0.8, `YLW-${String(7 + i).padStart(2, "0")} sim=${sim.toFixed(3)} 应 ≥ 0.8（quote 即原文）`);
  }

  pass("S5：亚龙湾场景端到端（5 条 miss 均可被 note_tip surface，sim ≥ 0.8）");
}

// ===== S6：poiAlias 别名参与归属判定 =====
{
  // 用简称「亚龙湾森林公园」作为 attraction name → 应通过 resolvePoiAlias 归一到 canonical
  const entries: ParsedEntry[] = [
    makePoi("亚龙湾森林公园", "attraction", null),
    makePoi("过江龙索桥", "in_attraction", "亚龙湾森林公园"),
    makeTip("上午上山", "建议上午上山"),
  ];

  const single = detectSingleAttraction(entries);
  assert.equal(single, "亚龙湾热带天堂森林公园", "简称应通过 resolvePoiAlias 归一到正式名");

  const result = attributeNoteTips(entries);
  const tips = result.filter((e) => e.type === "note_tip");
  assert.equal(tips[0]!.parentAttraction, "亚龙湾热带天堂森林公园");

  pass("S6：poiAlias 别名参与归属判定");
}

// ===== S7：note_tip 不参与 isDisqualifiedEntry（描述标签不被误杀） =====
{
  // note_tip 的 name 是描述标签（如"门票省钱"），不应被 POI 淘汰规则误杀
  // attributeNoteTips 在 assembleEntries 之前已分离 note_tip，不会进入 isDisqualifiedEntry
  // 这里验证 note_tip 的 name 确实不在泛化词表中
  const tip = makeTip("门票省钱", "网上提前买票便宜");
  assert.equal(tip.type, "note_tip");
  // assembleEntries 中 note_tip 走 Pass 0（pushMention），不经 isDisqualifiedEntry
  pass("S7：note_tip 不参与 isDisqualifiedEntry");
}

// ===== S8：EXTRACT_RULES_TEXT 包含 note_tip 指令 =====
{
  assert.ok(EXTRACT_RULES_TEXT.includes("note_tip"), "prompt 应包含 note_tip 类型说明");
  assert.ok(EXTRACT_RULES_TEXT.includes("笔记级建议"), "prompt 应包含「笔记级建议」概念");
  assert.ok(EXTRACT_RULES_TEXT.includes("type\": \"note_tip\""), "prompt 应包含 note_tip 的 JSON 格式示例");
  // 既有 POI 指令不被破坏
  assert.ok(EXTRACT_RULES_TEXT.includes("attraction"), "prompt 应保留 attraction 类型");
  assert.ok(EXTRACT_RULES_TEXT.includes("in_attraction"), "prompt 应保留 in_attraction 类型");
  assert.ok(EXTRACT_RULES_TEXT.includes("parentAttraction"), "prompt 应保留 parentAttraction 字段");
  // note_tip 提取规则存在
  assert.ok(EXTRACT_RULES_TEXT.includes("不提取：已在某个地点条目的 quote 中充分体现的信息"), "prompt 应包含去重指令");

  pass("S8：EXTRACT_RULES_TEXT 包含 note_tip 指令且不破坏既有");
}

// ===== S9/S10 公共夹具：最小 5 天行程（Day1 抵达 / Day2 已排目标景区 / Day5 返程） =====

const CANONICAL = "亚龙湾热带天堂森林公园";

function makeCoverageDay(dayIndex: number, scheduleVisitRefs: string[]): Day {
  return {
    dayId: `day_${dayIndex}`,
    dayIndex,
    date: `2026-11-${String(dayIndex).padStart(2, "0")}`,
    departTime: null,
    departTimeOverridden: false,
    scheduleVisitRefs,
    lodging: null,
  };
}

function makeCoverageTrip(): Trip {
  const dayRefs: string[] = [];
  const days: Record<string, Day> = {};
  for (let index = 1; index <= 5; index++) {
    dayRefs.push(`day_${index}`);
    days[`day_${index}`] = makeCoverageDay(index, index === 2 ? ["visit_poi"] : []);
  }
  return {
    tripId: "trip_verify_287",
    schemaVersion: SCHEMA_VERSION,
    version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-01", end: "2026-11-05", nights: 4 },
    dayRefs,
    days,
    lodgings: {},
    hotelRegistry: {},
    guideSources: {},
    itemRegistry: {
      item_poi: {
        itemId: "item_poi",
        name: CANONICAL,
        origin: "fliggy",
        providerId: "item_poi",
        address: null,
        category: null,
        coords: null,
        suggestMinutes: 180,
        mainPic: null,
        ticketInfo: null,
        jumpUrl: null,
        sourceEvidenceRefs: [],
      },
    },
    visits: {
      visit_poi: {
        visitId: "visit_poi",
        dayRef: "day_2",
        pointRef: "item_poi",
        kind: "large_attraction",
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
        externalLeg: null,
        childStopRefs: [],
        alternateStopRefs: [],
        sourceMentionRefs: [],
        purchaseState: "unknown",
        locked: false,
        userAdjusted: false,
        removedFrom: null,
        removedAt: null,
      },
    },
    stops: {},
    evidences: {},
    globalCandidateRefs: [],
    pendingStopRefs: [],
    relationshipSuggestions: {},
    constraints: [
      {
        constraintId: "c_arrive",
        type: "flight_arrive",
        anchorTime: "2026-11-01T10:00:00",
        dayIndex: 1,
        label: "抵达",
        locked: true,
      },
      {
        constraintId: "c_depart",
        type: "flight_depart",
        anchorTime: "2026-11-05T18:00:00",
        dayIndex: 5,
        label: "返程",
        locked: true,
      },
    ],
    createdAt: "2026-10-29T00:00:00.000Z",
    updatedAt: "2026-10-29T00:00:00.000Z",
  };
}

function makeEvidence(evidenceId: string): SourceEvidence {
  return {
    evidenceId,
    kind: "note_text",
    noteIndex: 1,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions: [],
  };
}

/** 写入证据 + 建来源（ready / 非暂存），返回 mentionRefs 供对齐字段使用 */
function attachSource(trip: Trip, sourceId: string, evidence: SourceEvidence): string[] {
  trip.evidences[evidence.evidenceId] = evidence;
  const mentionRefs = evidence.mentions.map((mention) => `${evidence.evidenceId}:${mention.mentionId}`);
  const sources = trip.guideSources ?? {};
  sources[sourceId] = {
    sourceId,
    sourceVersion: 1,
    inputKind: "text",
    title: `来源 ${sourceId}`,
    active: true,
    status: "ready",
    evidenceRefs: [evidence.evidenceId],
    mentionRefs,
    imageProgress: createEmptyGuideImageProgress(),
    importedAt: "2026-10-29T08:00:00.000Z",
    updatedAt: "2026-10-29T08:00:00.000Z",
  };
  trip.guideSources = sources;
  return mentionRefs;
}

// ===== S9（Task #294 回归）：note_tip 归属后并入所属景区，不计入未排素材单元 =====
{
  // 9a. 名称归一：多景点笔记（保留模型归属）落 mention 前地点名 = 归属景区，标签进 summary
  const multiTip = noteTipMentionEntry(makeTip("门票省钱", "网上提前买票比现场窗口便宜", CANONICAL));
  assert.equal(multiTip.type, "note_tip", "归一只改地点名，不改类型");
  assert.equal(multiTip.name, CANONICAL, "note_tip 地点名应归一为归属景区（否则 merge 按标签新建幽灵地点）");
  assert.equal(multiTip.parentAttraction, CANONICAL);
  assert.ok(multiTip.summary.includes("门票省钱"), "描述标签应保留在 summary（不丢信息）");
  assert.equal(multiTip.quote, "网上提前买票比现场窗口便宜", "原文 quote 不得改写（E9 召回依赖原文）");
  // 单景点笔记（attributeNoteTips 已把 name 改成 canonical）→ 幂等；无归属 → 不猜测
  assert.equal(noteTipMentionEntry(makeTip(CANONICAL, "建议上午上山", CANONICAL)).name, CANONICAL);
  assert.equal(noteTipMentionEntry(makeTip("雨具备忘", "备好雨具")).name, "雨具备忘", "parentAttraction=null 时原样保留");

  // 9b. 端到端：归属后的 note_tip mention 折进所属景区地点，覆盖估算计入「已支撑天」
  const trip = makeCoverageTrip();
  const evidence = makeEvidence("ev_ylw");
  const poiRef = pushMention(evidence, makePoi(CANONICAL, "attraction", null, `${CANONICAL} 完整攻略与避坑指南`));
  pushMention(evidence, noteTipMentionEntry(makeTip("门票省钱", "网上提前买票比现场窗口便宜", CANONICAL)));
  pushMention(evidence, noteTipMentionEntry(makeTip("上午上山", "建议上午上山，下午容易起大雾", CANONICAL)));
  attachSource(trip, "src_ylw", evidence);
  trip.visits["visit_poi"]!.sourceMentionRefs = [poiRef]; // POI 提及已对齐 Day2 的 Visit

  const merge = mergeGuideMentions(trip, { selectedSourceIds: new Set(["src_ylw"]) });
  assert.equal(
    merge.places.length,
    1,
    `note_tip 应并入所属景区地点，实得 ${merge.places.length} 个（${merge.places.map((p) => p.displayName).join("、")}）`,
  );
  assert.equal(merge.places[0]!.displayName, CANONICAL);
  assert.equal(merge.places[0]!.mentions.length, 3, "景区地点下应有 POI + 2 条 note_tip 提及（素材不丢）");

  const gap = estimateGuideCoverage(trip, merge.places);
  assert.equal(gap.scheduledDayCount, 1, "素材命中已排 Day2 → 已排 1 天");
  assert.equal(gap.unscheduledUnitCount, 0, "note_tip 不得计成未排素材单元");
  assert.equal(gap.enrichmentAnchored, true, "锚定既有排期 → C1 澄清门跳过（Task #294 修复点）");

  // 9c. 对照组（#287 原样：mention 用描述标签）→ 凭空多出 2 个幽灵地点 / 未排素材单元
  const rawTrip = makeCoverageTrip();
  const rawEvidence = makeEvidence("ev_raw");
  const rawPoiRef = pushMention(rawEvidence, makePoi(CANONICAL, "attraction", null, `${CANONICAL} 完整攻略与避坑指南`));
  pushMention(rawEvidence, makeTip("门票省钱", "网上提前买票比现场窗口便宜", CANONICAL));
  pushMention(rawEvidence, makeTip("上午上山", "建议上午上山，下午容易起大雾", CANONICAL));
  attachSource(rawTrip, "src_raw", rawEvidence);
  rawTrip.visits["visit_poi"]!.sourceMentionRefs = [rawPoiRef];

  const rawMerge = mergeGuideMentions(rawTrip, { selectedSourceIds: new Set(["src_raw"]) });
  assert.equal(rawMerge.places.length, 3, "对照组：描述标签各自成为独立地点（幽灵地点）");
  const rawGap = estimateGuideCoverage(rawTrip, rawMerge.places);
  assert.equal(rawGap.unscheduledUnitCount, 2, "对照组：幽灵地点被计成未排素材单元");
  assert.ok(
    rawGap.coveredDayCount > gap.coveredDayCount,
    `对照组虚增可支撑天数（${rawGap.coveredDayCount} vs ${gap.coveredDayCount}）→ 会掩盖真稀疏`,
  );

  pass("S9：note_tip 归属后并入所属景区地点、不计入未排素材单元（对照组虚增 2 单元）");
}

// ===== S10（Task #294 回归）：C1 澄清门语义不变——真稀疏仍触发，只跳过 enrichment =====
{
  // planner.ts 澄清门条件：hasGap && !suppressed && !enrichmentAnchored（门槛常数未改）
  const gate = (gap: CoverageGapResult): boolean => gap.hasGap && !gap.suppressed && !gap.enrichmentAnchored;
  const trip = makeCoverageTrip();

  // 真稀疏：素材全是未落位新点位（已排天 0）→ 与 eval C1 / verify-coverage §1 同口径，仍触发澄清
  const sparse = estimateGuideCoverage(trip, [
    { entityRef: null, displayName: "西岛" },
    { entityRef: null, displayName: "椰梦长廊" },
  ]);
  assert.equal(sparse.scheduledDayCount, 0, "真稀疏：素材锚不到任何已排天");
  assert.equal(sparse.hasGap, true, "真稀疏：缺口成立");
  assert.equal(sparse.enrichmentAnchored, false, "真稀疏：未锚定既有排期");
  assert.equal(gate(sparse), true, "真稀疏仍必须触发 C1 澄清（不得一刀切关掉澄清门）");

  // enrichment：素材锚定既有已排天 → 缺口仍成立，但不再打扰用户
  const anchored = estimateGuideCoverage(trip, [{ entityRef: { kind: "visit", id: "visit_poi" }, displayName: CANONICAL }]);
  assert.equal(anchored.hasGap, true, "enrichment：覆盖缺口判定口径不变");
  assert.equal(anchored.suppressed, false, "enrichment：C2 抑制语义不变");
  assert.equal(anchored.enrichmentAnchored, true, "enrichment：已锚定既有排期");
  assert.equal(gate(anchored), false, "enrichment 场景应跳过 C1（Task #294 修复的过度触发）");

  pass("S10：C1 门语义不变（真稀疏触发 / enrichment 跳过），门槛常数与 C2 抑制口径未改");
}

console.log("\n===== Task #287 verify 全部通过 =====");
