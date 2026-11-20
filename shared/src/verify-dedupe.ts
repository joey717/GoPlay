/**
 * Task #212 去重纯函数验证：deduplicateSnippets / deduplicateStopSnippets /
 * areSnippetsSimilar / snippetSimilarity / normalizeSnippetText。
 *
 * 运行：npx tsx src/verify-dedupe.ts（shared 目录下）；已接入 `npm run verify -w shared`。
 *
 * 覆盖（fixture 复刻现场 trip d0174797 的真实重复形态）：
 *  1. 归一化与相似度口径：空格 / 大小写噪声、子序列重合率、超短句防误杀；
 *     同提及放宽口径（LCS ≥ 0.8 / 公共前缀 ≥ 10 字且覆盖较短串 ≥ 60%）及其跨提及关闭；
 *  2. 完全相同去重（含 AI 随机空格：「可以 走过江龙索桥」vs「可以走过江龙索桥」）；
 *  3. 高度相似合并：保留更完整（更长）的一条（「赶海要下午退潮后再去」被带补充
 *     说明的长句吸收；丹姐清补凉 94% 重合形态；三和风味馆同句两次截取 0.79 + 公共前缀 15 字）；
 *  4. 不同内容保留：两条无关亮点互不误杀；
 *  5. sourceMentionRefs 组合键去重（归属来源 + 归一化提及文本）：
 *     同来源同句跨证据合并 / 同来源不同提及保留 / 早期无来源同句合并 / 悬空引用保留；
 *  6. 代表挑选：引用指向 active 来源的条目优先（删源重加场景，重复来源 tab 随之消失）；
 *  7. 幂等与纯度：无变化返回原引用、二次清洗深度相等、入参 trip 逐字节不变；
 *  8. 字段语义：清洗后 guideSnippets 非空才写、空数组输入视为无变化。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { GuideSnippet, Stop, Trip, Visit } from "./types/index.js";
import {
  areDisplaySimilarSnippets,
  areSameSourceSnippetsSimilar,
  areSnippetEntriesSimilar,
  areSnippetsSimilar,
  clusterSimilarSnippets,
  deduplicateSnippets,
  deduplicateStopSnippets,
  longestCommonSubstringLength,
  normalizeSnippetText,
  SNIPPET_CROSS_SOURCE_THRESHOLD,
  SNIPPET_DISPLAY_CLUSTER_SIM_MAX,
  SNIPPET_DISPLAY_CLUSTER_SIM_MIN,
  SNIPPET_SIMILARITY_THRESHOLD,
  snippetClusterNote,
  snippetSimilarity,
} from "./guides/dedupeSnippets.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ===== fixture =====

function makeSnippet(snippetId: string, text: string, refs: string[]): GuideSnippet {
  return { snippetId, text, claimKind: "tip", sourceMentionRefs: refs };
}

function makeVisit(): Visit {
  return {
    visitId: "visit_ylw",
    dayRef: "day_1",
    pointRef: "item_ylw",
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
    externalLeg: null,
    childStopRefs: [],
    alternateStopRefs: [],
    sourceMentionRefs: [],
    purchaseState: "unknown",
    locked: false,
    userAdjusted: false,
    removedFrom: null,
    removedAt: null,
  };
}

function makeStop(): Stop {
  return {
    stopId: "stop_bridge",
    state: "attached",
    visitRef: "visit_ylw",
    suggestedVisitRef: null,
    matchedPointRef: null,
    customName: null,
    order: 0,
    suggestMinutes: null,
    locationHint: null,
    ticketRelation: "included",
    sourceEvidenceRefs: [],
    sourceMentionRefs: [],
    guideSnippets: [],
    userAdjusted: false,
    removedFromOrder: null,
    removedAt: null,
  };
}

/** 现场形态：同一篇攻略删源（src_old）重加（src_active），两条证据各留一句提及 */
function makeTrip(): Trip {
  return {
    tripId: "trip_verify_dedupe",
    schemaVersion: 2,
    version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: "2026-11-08", nights: 0 },
    dayRefs: ["day_1"],
    days: {},
    lodgings: {},
    hotelRegistry: {},
    itemRegistry: {},
    visits: {},
    stops: {},
    evidences: {
      ev_old: {
        evidenceId: "ev_old",
        kind: "note_text",
        noteIndex: 16,
        assetRef: null,
        sourceUrl: null,
        ocrText: "亚龙湾热带天堂森林公园：《非诚勿扰 2》取景地，可以走过江龙索桥",
        mentions: [
          {
            mentionId: "m3",
            text: "亚龙湾热带天堂森林公园",
            quoteText: "亚龙湾热带天堂森林公园：《非诚勿扰 2》取景地，可以走过江龙索桥",
            bbox: null,
            extractedName: "亚龙 湾热带天堂森林公园",
            locationHint: null,
            modelSummary: null,
          },
        ],
      },
      ev_new: {
        evidenceId: "ev_new",
        kind: "note_text",
        noteIndex: 17,
        assetRef: null,
        sourceUrl: null,
        ocrText: "亚龙湾热带天堂森林公园：可以走过江龙索桥，玻璃栈道俯瞰海景",
        mentions: [
          {
            mentionId: "m1",
            text: "亚龙湾热带天堂森林公园",
            quoteText: "亚龙湾热带天堂森林公园：可以走过江龙索桥",
            bbox: null,
            extractedName: "亚龙湾热带天堂森林公园",
            locationHint: null,
            modelSummary: null,
          },
          {
            mentionId: "m2",
            text: "过江龙索桥",
            quoteText: "可以走过江龙索桥",
            bbox: null,
            extractedName: "过江龙索桥",
            locationHint: null,
            modelSummary: null,
          },
        ],
      },
      // 同来源（src_active）的第二条证据：同句提及再次提取（组合键去重目标形态）
      ev_new_shot: {
        evidenceId: "ev_new_shot",
        kind: "screenshot",
        noteIndex: null,
        assetRef: null,
        sourceUrl: null,
        ocrText: "可以走过江龙索桥",
        mentions: [
          {
            mentionId: "m1",
            text: "过江龙索桥",
            quoteText: "可以走过江龙索桥",
            bbox: [0, 0, 10, 10],
            extractedName: "过江龙索桥",
            locationHint: null,
            modelSummary: null,
          },
          {
            mentionId: "m5",
            text: "玻璃栈道",
            quoteText: "玻璃栈道俯瞰整片海湾",
            bbox: [0, 0, 10, 10],
            extractedName: "玻璃栈道",
            locationHint: null,
            modelSummary: null,
          },
        ],
      },
      // 早期无来源归属的重复证据（同句在两条证据中各提取一次）
      ev_legacy_a: {
        evidenceId: "ev_legacy_a",
        kind: "note_text",
        noteIndex: 1,
        assetRef: null,
        sourceUrl: null,
        ocrText: "西岛 seawalk",
        mentions: [
          {
            mentionId: "m2",
            text: "seawalk",
            quoteText: "西岛 seawalk 值得体验",
            bbox: null,
            extractedName: "seawalk",
            locationHint: null,
            modelSummary: null,
          },
        ],
      },
      ev_legacy_b: {
        evidenceId: "ev_legacy_b",
        kind: "note_text",
        noteIndex: 2,
        assetRef: null,
        sourceUrl: null,
        ocrText: "西岛 seawalk",
        mentions: [
          {
            mentionId: "m2",
            text: "seawalk",
            quoteText: "西岛 seawalk 值得体验",
            bbox: null,
            extractedName: "seawalk",
            locationHint: null,
            modelSummary: null,
          },
        ],
      },
    },
    globalCandidateRefs: [],
    pendingStopRefs: [],
    relationshipSuggestions: {},
    guideSources: {
      src_old: {
        sourceId: "src_old",
        sourceVersion: 1,
        inputKind: "text",
        active: false,
        removedAt: "2026-10-20T00:00:00.000Z",
        status: "ready",
        evidenceRefs: ["ev_old"],
        mentionRefs: ["ev_old:m3"],
        imageProgress: { total: 0, completed: 0, failed: 0, images: [] },
        importedAt: "2026-10-19T00:00:00.000Z",
        updatedAt: "2026-10-19T00:00:00.000Z",
      },
      src_active: {
        sourceId: "src_active",
        sourceVersion: 1,
        inputKind: "text",
        active: true,
        status: "ready",
        evidenceRefs: ["ev_new", "ev_new_shot"],
        mentionRefs: ["ev_new:m1", "ev_new:m2"],
        imageProgress: { total: 0, completed: 0, failed: 0, images: [] },
        importedAt: "2026-10-21T00:00:00.000Z",
        updatedAt: "2026-10-21T00:00:00.000Z",
      },
    },
    constraints: [],
    createdAt: "2026-10-19T00:00:00.000Z",
    updatedAt: "2026-10-19T00:00:00.000Z",
  };
}

// ===== 1. 归一化与相似度口径 =====

test("归一化：去全部空白 + 小写；相似度：子序列重合率边界", () => {
  assert.equal(normalizeSnippetText(" 可以 走过 江龙索桥 "), "可以走过江龙索桥");
  assert.equal(normalizeSnippetText("ABC DEF"), "abcdef");
  // 完全相等比率 1；前串是后串子序列时比率 1；无关串比率低
  assert.equal(snippetSimilarity("赶海要下午退潮后再去", "赶海要下午退潮后再去"), 1);
  assert.equal(
    snippetSimilarity("赶海要下午退潮后再去", "赶海要下午退潮后再去，上午去可能扑空"),
    1,
  );
  assert.ok(snippetSimilarity("丹姐清补凉甜度恰到好处椰子香清爽不腻", "丹姐清补凉甜度恰到好处纯椰子香不腻") >= 0.9);
  assert.ok(snippetSimilarity("蜈支洲岛潜水要看天气", "第一市场海鲜加工认准本地摊位") < 0.5);
  assert.equal(snippetSimilarity("", "任意"), 0);
});

test("areSnippetsSimilar：空格差异全等 / 高相似命中 / 超短句只有全等才去重", () => {
  assert.equal(areSnippetsSimilar("可以 走过江龙索桥", "可以走过江龙索桥"), true);
  assert.equal(areSnippetsSimilar("穿过小吃 街左手边就是珊瑚墙，这里很好看", "穿过小吃街左手边就是珊瑚墙，很好看"), true);
  assert.equal(areSnippetsSimilar("赶海要下午退潮后再去", "赶海要下午退潮后再去，上午去可能扑空"), true);
  // 真正不同的亮点不误杀
  assert.equal(areSnippetsSimilar("情人桥要赶早上8点前上去", "山顶餐厅看日落位置最好"), false);
  // 超短句（归一化 < 6 字）非全等不去重，防「去石斑」vs「石斑鱼」误杀
  assert.equal(areSnippetsSimilar("去石斑", "石斑鱼"), false);
  assert.equal(areSnippetsSimilar("潜水", "潜 水"), true);
});

// ===== 1b. 同一 sourceMentionRef 的放宽口径 =====

test("areSnippetEntriesSimilar：同提及放宽（LCS 0.8 / 长公共前缀），跨提及与信息不同情况不放宽", () => {
  // 现场三和风味馆：同句两次截取，LCS 仅 0.79（基础阈值 0.9 漏判），公共前缀 15/19 字
  const sandA = { text: "三和风味馆招牌马头鱼鲜嫩入味，强烈安利", sourceMentionRefs: ["ev_note_9:m4"] };
  const sandB = { text: "三和风味馆招牌马头鱼鲜嫩入味，尖椒炒蛋巨下饭", sourceMentionRefs: ["ev_note_9:m4"] };
  assert.ok(
    snippetSimilarity(sandA.text, sandB.text) < SNIPPET_SIMILARITY_THRESHOLD,
    "三和风味馆一对在基础口径下确实漏判",
  );
  assert.equal(areSnippetEntriesSimilar(sandA, sandB), true, "同提及 + 公共前缀 15 字 → 合并");
  assert.equal(
    areSnippetEntriesSimilar(sandA, { ...sandB, sourceMentionRefs: ["ev_note_9:m5"] }),
    false,
    "不同提及（并行证据）不得放宽合并",
  );
  assert.equal(
    areSnippetEntriesSimilar(sandA, { ...sandB, sourceMentionRefs: [] }),
    false,
    "无引用上下文只走基础口径",
  );
  // 现场牛王岭：同句语序互换，LCS 0.80（基础口径漏判）
  const niuA = { text: "观光车1号线上牛王岭，是看日落的观景高地", sourceMentionRefs: ["ev_note_12:m8"] };
  const niuB = { text: "牛王岭坐观光车1号线可达，是看日落的观景高地", sourceMentionRefs: ["ev_note_12:m8"] };
  assert.equal(areSnippetEntriesSimilar(niuA, niuB), true, "同提及 + LCS 0.80 → 合并");
  // 现场椰林沙滩：同提及但各自承载不同信息（重合 0.45）→ 保留两条
  const yeA = { text: "椰林沙滩有椰子树出片且不排队，珊瑚墙前会经过", sourceMentionRefs: ["ev_note_11:m5"] };
  const yeB = { text: "木门和歪脖子椰子树人多要排队，椰林沙滩同样出片且不排队", sourceMentionRefs: ["ev_note_11:m5"] };
  assert.equal(areSnippetEntriesSimilar(yeA, yeB), false, "信息不同的同提及亮点不得误杀");
});

// ===== 1c. Task #339 第三档：同攻略同景点、引用组合不同的相似对 =====

test("第三档：同来源 + 引用部分重叠（非同一句提及重复抽取）+ LCS ≥ 0.5 → 合并", () => {
  const trip = makeTrip();
  // 现场玻璃栈道对（trip 0a27f726）：同属 src_031163bc，refs [m6] vs [m6,m16]，
  // 重合率实测 0.625（基础档 0.9 与放宽档 0.8 都拦不住）；fixture 用 ev_new:m1 /
  // ev_new_shot:m5 复刻同来源部分重叠形态
  const fogA = { text: "大雾天上去白茫茫拍不到，钱就白花", sourceMentionRefs: ["ev_new:m1"] };
  const fogB = { text: "大雾天玻璃栈道白茫茫拍不到，谨慎购买", sourceMentionRefs: ["ev_new:m1", "ev_new_shot:m5"] };
  assert.ok(
    snippetSimilarity(fogA.text, fogB.text) >= SNIPPET_CROSS_SOURCE_THRESHOLD &&
      snippetSimilarity(fogA.text, fogB.text) < SNIPPET_SIMILARITY_THRESHOLD,
    "玻璃栈道对重合率 0.625 落在第三档区间（基础档漏判）",
  );
  assert.equal(areSnippetEntriesSimilar(fogA, fogB), false, "既有双档行为不变：放宽档需 LCS ≥ 0.8，0.625 不命中");
  assert.equal(areSameSourceSnippetsSimilar(fogA, fogB, trip), true, "第三档：同来源 + 引用组合不同 + LCS ≥ 0.5 → 相似");

  // 存量清洗端到端：收敛为 1 条且保留更长者，引用不被改写
  const stop = makeStop();
  stop.guideSnippets = [
    makeSnippet("gsn_fog_a", fogA.text, [...fogA.sourceMentionRefs]),
    makeSnippet("gsn_fog_b", fogB.text, [...fogB.sourceMentionRefs]),
  ];
  const cleaned = deduplicateStopSnippets(stop, trip);
  assert.equal(cleaned.guideSnippets?.length, 1, "第三档命中只留一条");
  assert.equal(cleaned.guideSnippets?.[0]?.snippetId, "gsn_fog_b", "保留更长（信息更全）的一条");
  assert.deepEqual(cleaned.guideSnippets?.[0]?.sourceMentionRefs, ["ev_new:m1", "ev_new_shot:m5"], "引用原样保留");
  assert.deepEqual(deduplicateStopSnippets(cleaned, trip), cleaned, "第三档清洗幂等");
});

test("第三档不越界：refs 完全相同的同提及对（0.53~0.65 区间）仍刻意不合并", () => {
  const trip = makeTrip();
  // 现场太阳湾公路对（trip 48275e19）：refs 完全相同，重合率 0.588；同形态还有
  // 鹿回头 0.563、南山 0.529、后海村 0.65——同一句提及的重复抽取属放宽档领域，
  // 历史取舍 0.65 及以下不合并，第三档不得介入（leader 2026-11-03 批准口径）
  const sunA = { text: "观景台限时7分钟，提前想好姿势速拍", sourceMentionRefs: ["ev_new:m1"] };
  const sunB = { text: "有专门观景台可拍照但限时7分钟，速战速决", sourceMentionRefs: ["ev_new:m1"] };
  const sunRatio = snippetSimilarity(sunA.text, sunB.text);
  assert.ok(sunRatio >= 0.53 && sunRatio <= 0.59, `太阳湾公路对重合率实测 0.588（得 ${sunRatio.toFixed(3)}）`);
  assert.equal(areSameSourceSnippetsSimilar(sunA, sunB, trip), false, "refs 完全相同 → 第三档不介入");
  const stop = makeStop();
  stop.guideSnippets = [
    makeSnippet("gsn_sun_a", sunA.text, [...sunA.sourceMentionRefs]),
    makeSnippet("gsn_sun_b", sunB.text, [...sunB.sourceMentionRefs]),
  ];
  assert.ok(deduplicateStopSnippets(stop, trip) === stop, "同提及 0.588 对清洗后两条均保留（原引用返回）");
  // 后海村 0.65 同提及对：放宽档不命中（LCS < 0.8 且无长公共前缀），第三档同样不介入
  const houA = { text: "后海村步行到码头很近，顺便可以逆海", sourceMentionRefs: ["ev_new:m2"] };
  const houB = { text: "从后海村码头坐船出发更方便，适合逆海", sourceMentionRefs: ["ev_new:m2"] };
  assert.equal(areSnippetEntriesSimilar(houA, houB), false, "既有断言：同提及 0.65 放宽档不合并");
  assert.equal(areSameSourceSnippetsSimilar(houA, houB, trip), false, "第三档对同提及对不越界");
});

test("第三档不影响跨来源对与无上下文调用：不同攻略的并行证据不合并", () => {
  const trip = makeTrip();
  // 跨来源：即使重合率 0.667 落在第三档区间，ev_old 属 src_old、ev_new 属 src_active → 不合并
  const crossA = { text: "可以走过江龙索桥，俯瞰整片海湾很出片", sourceMentionRefs: ["ev_old:m3"] };
  const crossB = { text: "可以走过江龙索桥，桥上看海景出片又刺激", sourceMentionRefs: ["ev_new:m1"] };
  assert.ok(
    snippetSimilarity(crossA.text, crossB.text) >= SNIPPET_CROSS_SOURCE_THRESHOLD &&
      !areSnippetsSimilar(crossA.text, crossB.text),
    "前提：重合率落在第三档区间且基础档未命中",
  );
  assert.equal(areSameSourceSnippetsSimilar(crossA, crossB, trip), false, "跨来源 → 第三档恒不合并");
  // 悬空引用（无归属来源）→ 不合并（不丢数据）
  assert.equal(
    areSameSourceSnippetsSimilar(crossA, { ...crossB, sourceMentionRefs: ["ev_ghost:m1"] }, trip),
    false,
    "悬空引用解析不出归属来源 → 不合并",
  );
  // 无 trip 上下文（既有双档调用点形态）→ 第三档恒 false，行为不变
  assert.equal(areSameSourceSnippetsSimilar(crossA, crossB, undefined), false, "无 trip 上下文恒 false");
  const fogA = { text: "大雾天上去白茫茫拍不到，钱就白花", sourceMentionRefs: ["ev_new:m1"] };
  const fogB = { text: "大雾天玻璃栈道白茫茫拍不到，谨慎购买", sourceMentionRefs: ["ev_new:m1", "ev_new_shot:m5"] };
  const noTrip = makeStop();
  noTrip.guideSnippets = [
    makeSnippet("gsn_fog_a", fogA.text, [...fogA.sourceMentionRefs]),
    makeSnippet("gsn_fog_b", fogB.text, [...fogB.sourceMentionRefs]),
  ];
  assert.ok(deduplicateStopSnippets(noTrip) === noTrip, "无 trip 上下文的存量清洗不触发第三档（既有调用点行为不变）");
});

// ===== 2/3/4. Visit 清洗：完全相同 / 高度相似 / 不同保留 =====

test("完全相同（含空格差异）snippet 去重：active 来源引用的代表保留，重复来源引用让位", () => {
  const trip = makeTrip();
  const visit = makeVisit();
  visit.guideSnippets = [
    makeSnippet("gsn_a", "可以 走过江龙索桥", ["ev_old:m3"]), // inactive 来源（已删重加前的残留）
    makeSnippet("gsn_b", "可以走过江龙索桥", ["ev_new:m1"]), // active 来源
  ];
  const cleaned = deduplicateSnippets(visit, trip);
  assert.equal(cleaned.guideSnippets?.length, 1);
  // active 来源引用优先：即使文本更短也保留（EvidenceSheet 重复来源 tab 随之消失）
  assert.equal(cleaned.guideSnippets?.[0]?.snippetId, "gsn_b");
  assert.deepEqual(cleaned.guideSnippets?.[0]?.sourceMentionRefs, ["ev_new:m1"]);
});

test("无 trip 上下文：文本更长（更完整）的代表保留", () => {
  const visit = makeVisit();
  visit.guideSnippets = [
    makeSnippet("gsn_a", "赶海要下午退潮后再去", ["ev_legacy_a:m2"]),
    makeSnippet("gsn_b", "赶海要下午退潮后再去，上午去可能扑空", ["ev_legacy_a:m2"]),
  ];
  const cleaned = deduplicateSnippets(visit);
  assert.equal(cleaned.guideSnippets?.length, 1);
  assert.equal(cleaned.guideSnippets?.[0]?.snippetId, "gsn_b");
});

test("高度相似合并：94% 重合的改写保留更完整长句；不同内容互不误杀", () => {
  const visit = makeVisit();
  visit.guideSnippets = [
    makeSnippet("gsn_a", "丹姐清补凉甜度恰到好处，椰子香清爽不腻", ["ev_legacy_a:m2"]),
    makeSnippet("gsn_b", "丹姐清补凉甜度恰到好处，纯椰子香不腻", ["ev_legacy_a:m2"]),
    makeSnippet("gsn_c", "三和风味馆招牌马头鱼鲜嫩入味，建议提前到店", ["ev_legacy_b:m2"]),
  ];
  const cleaned = deduplicateSnippets(visit);
  assert.equal(cleaned.guideSnippets?.length, 2);
  assert.equal(cleaned.guideSnippets?.[0]?.snippetId, "gsn_a", "更长的原句保留");
  assert.equal(cleaned.guideSnippets?.[1]?.snippetId, "gsn_c", "不同亮点的条目保留");
});

test("同一提及的两次截取（三和风味馆）：合并为一条并保留信息更丰富的长句", () => {
  const visit = makeVisit();
  visit.guideSnippets = [
    makeSnippet("gsn_a", "三和风味馆招牌马头鱼鲜嫩入味，强烈安利", ["ev_note_9:m4"]),
    makeSnippet("gsn_b", "三和风味馆招牌马头鱼鲜嫩入味，尖椒炒蛋巨下饭", ["ev_note_9:m4"]),
  ];
  const cleaned = deduplicateSnippets(visit);
  assert.equal(cleaned.guideSnippets?.length, 1, "同提及 + 公共前缀命中只留一条");
  assert.equal(cleaned.guideSnippets?.[0]?.snippetId, "gsn_b", "更长（信息更全）的一条保留");
  assert.deepEqual(cleaned.guideSnippets?.[0]?.sourceMentionRefs, ["ev_note_9:m4"]);
});

test("同一提及但信息不同的两条亮点：清洗后均保留", () => {
  const visit = makeVisit();
  visit.guideSnippets = [
    makeSnippet("gsn_a", "椰林沙滩有椰子树出片且不排队，珊瑚墙前会经过", ["ev_note_11:m5"]),
    makeSnippet("gsn_b", "木门和歪脖子椰子树人多要排队，椰林沙滩同样出片且不排队", ["ev_note_11:m5"]),
  ];
  const cleaned = deduplicateSnippets(visit);
  assert.ok(cleaned === visit, "无重复可去应返回原引用");
  assert.equal(cleaned.guideSnippets?.length, 2);
});

// ===== 5. sourceMentionRefs 组合键去重 =====

test("实体 sourceMentionRefs：同来源同句跨证据合并；不同提及与悬空引用保留", () => {
  const trip = makeTrip();
  const stop = makeStop();
  // ev_new:m2 与 ev_new_shot:m1 同属 src_active 且提及文本归一化相同（同句跨证据）→ 合并；
  // ev_new_shot:m5 是另一句提及 → 保留；ev_dangling 悬空 → 原样保留（不丢数据）
  stop.sourceMentionRefs = ["ev_new:m2", "ev_new_shot:m1", "ev_new_shot:m5", "ev_dangling:m9"];
  const cleaned = deduplicateStopSnippets(stop, trip);
  assert.deepEqual(cleaned.sourceMentionRefs, ["ev_new:m2", "ev_new_shot:m5", "ev_dangling:m9"]);
});

test("早期无来源归属的重复证据：同句提及（同文本）合并为一条引用", () => {
  const trip = makeTrip();
  const stop = makeStop();
  stop.sourceMentionRefs = ["ev_legacy_a:m2", "ev_legacy_b:m2"];
  const cleaned = deduplicateStopSnippets(stop, trip);
  assert.deepEqual(cleaned.sourceMentionRefs, ["ev_legacy_a:m2"]);
});

test("跨来源的同名提及不去重（不同攻略各提一次是并行证据）", () => {
  const trip = makeTrip();
  const visit = makeVisit();
  // ev_old 属 src_old（inactive）、ev_new 属 src_active：来源不同 → 组合键不同 → 都保留
  visit.sourceMentionRefs = ["ev_old:m3", "ev_new:m1"];
  const cleaned = deduplicateSnippets(visit, trip);
  assert.deepEqual(cleaned.sourceMentionRefs, ["ev_old:m3", "ev_new:m1"]);
});

test("snippet 内部 sourceMentionRefs 同步去重", () => {
  const trip = makeTrip();
  const visit = makeVisit();
  visit.guideSnippets = [
    makeSnippet("gsn_a", "可以走过江龙索桥", ["ev_new:m2", "ev_new_shot:m1", "ev_new_shot:m5"]),
  ];
  const cleaned = deduplicateSnippets(visit, trip);
  assert.deepEqual(cleaned.guideSnippets?.[0]?.sourceMentionRefs, ["ev_new:m2", "ev_new_shot:m5"]);
});

// ===== 6/7/8. 幂等 / 纯度 / 字段语义 =====

test("无变化时返回原引用；二次清洗深度相等（幂等）；入参 trip 逐字节不变", () => {
  const trip = makeTrip();
  const tripBefore = clone(trip);
  const visit = makeVisit();
  visit.guideSnippets = [makeSnippet("gsn_a", "可以走过江龙索桥", ["ev_new:m1"])];
  visit.sourceMentionRefs = ["ev_new:m1"];
  const once = deduplicateSnippets(visit, trip);
  assert.ok(once === visit, "无变化应返回原对象引用");
  assert.deepEqual(trip, tripBefore, "纯函数不得修改 trip");

  const dirty = makeVisit();
  dirty.guideSnippets = [
    makeSnippet("gsn_a", "可以 走过江龙索桥", ["ev_old:m3"]),
    makeSnippet("gsn_b", "可以走过江龙索桥", ["ev_new:m1"]),
  ];
  const onceCleaned = deduplicateSnippets(dirty, trip);
  const twiceCleaned = deduplicateSnippets(onceCleaned, trip);
  assert.deepEqual(onceCleaned, twiceCleaned, "去重必须幂等");
});

test("guideSnippets 清空后整体移除字段；sourceMentionRefs 保留空数组", () => {
  const trip = makeTrip();
  const stop = makeStop();
  stop.guideSnippets = [
    makeSnippet("gsn_a", "木门和歪 脖子椰子树人很多要排队", ["ev_new:m2"]),
    makeSnippet("gsn_b", "木门和歪脖子椰子树人很多要排队，椰林沙滩不排队更出片", ["ev_new:m2"]),
  ];
  const cleaned = deduplicateStopSnippets(stop, trip);
  assert.equal(cleaned.guideSnippets?.length, 1, "近似重复只留一条（更完整长句）");
  assert.equal(cleaned.guideSnippets?.[0]?.snippetId, "gsn_b");

  // 空数组等价缺失：无重复可去 → 无变化返回原引用（字段保持，不做多余规范化）
  const emptying = makeStop();
  emptying.guideSnippets = [];
  const cleanedEmpty = deduplicateStopSnippets(emptying, trip);
  assert.ok(cleanedEmpty === emptying, "空数组无变化应返回原对象引用");
  assert.deepEqual(cleanedEmpty.sourceMentionRefs, [], "sourceMentionRefs 是 v2 契约字段，保持存在");
});

// ===== 9. Task #342 展示层聚类（仅渲染收敛，数据层三档判定不受影响） =====

test("#342 指标口径：最长公共连续段（过江龙「可走旁边」4 字 / 椰林沙滩「出片且不排队」6 字）", () => {
  assert.equal(longestCommonSubstringLength("不想花钱排队可走旁边平行木栈道", "索桥20元排队久，可走旁边栈道免费绕过"), 4);
  assert.equal(longestCommonSubstringLength("椰林沙滩有椰子树出片且不排队", "木门和歪脖子椰子树人多要排队，椰林沙滩同样出片且不排队"), 6);
  assert.equal(longestCommonSubstringLength("", "任意"), 0);
});

test("#342/#352 过江龙对（同提及重复抽取，0.421 / 4 字 / 0.211）：展示层聚为 1 簇，总提及 1 次 → 不标注", () => {
  const trip = makeTrip();
  // 现场 trip 0a27f726 stop 过江龙索桥：两条引用组合同为 ev_note_2:m13，归属同一篇攻略
  const a = makeSnippet("gsn_5aa1", "不想花钱排队可走旁边平行木栈道，景色差不多", ["ev_new:m2"]);
  const b = makeSnippet("gsn_8b9c", "索桥20元排队久，可走旁边栈道免费绕过", ["ev_new:m2"]);
  const sim = snippetSimilarity(a.text, b.text);
  assert.ok(
    sim >= SNIPPET_DISPLAY_CLUSTER_SIM_MIN && sim < SNIPPET_DISPLAY_CLUSTER_SIM_MAX,
    `过江龙对重合率实测 0.421 落在展示层区间（得 ${sim.toFixed(3)}）`,
  );
  assert.equal(areDisplaySimilarSnippets(a, b, trip), true, "三条件命中 → 展示层收敛");
  const clusters = clusterSimilarSnippets([a, b], trip);
  assert.equal(clusters.length, 1, "卡内只展示 1 条");
  assert.equal(clusters[0]?.representative.snippetId, "gsn_5aa1", "代表取更长文本");
  assert.equal(clusters[0]?.mergedCount, 2);
  assert.equal(clusters[0]?.sourceCount, 1, "两条同出一篇攻略 → 来源数诚实为 1");
  assert.equal(clusters[0]?.mentionCount, 1, "refs 完全相同 = 同一句原文重复抽取 → 总提及 1 次");
  assert.equal(snippetClusterNote(clusters[0]!), null, "#352：总提及 ≤ 1 不标注（不得把 1 篇/1 处标成 2）");
  // 数据层不受影响：#212 双档与 #339 第三档对同提及 0.421 对均不合并（刻意保留口径不变）
  assert.equal(areSnippetEntriesSimilar(a, b), false, "数据层双档行为不变");
  assert.equal(areSameSourceSnippetsSimilar(a, b, trip), false, "refs 完全相同 → 第三档不介入（#339 口径不变）");
  const stop = makeStop();
  stop.guideSnippets = [a, b];
  assert.ok(deduplicateStopSnippets(stop, trip) === stop, "存量清洗不动该对（展示层聚类不改数据）");
});

test("#342 历史红线与刻意保留对不聚类：椰林沙滩 0.455 / 太阳湾 0.588 / 鹿回头 0.563 / 南山 0.529", () => {
  // 注：#351 已在数据层指名合并太阳湾/鹿回头/南山三对（椰林沙滩对仅存历史备份），
  // 但本用例断言的是阈值函数行为本身——展示层 [0.40,0.50) 上界与连续段占比红线不变，
  // 两层各自独立，判定阈值不因 #351 合并联动而改。
  const trip = makeTrip();
  // 椰林沙滩红线对：sim 0.455 在区间内，但连续段 6 字占较短串 0.273 > 0.25 →
  // 「共享子句 + 各自补充不同信息」互补形态，不合并
  const yeA = makeSnippet("gsn_ye_a", "椰林沙滩有椰子树出片且不排队，珊瑚墙前会经过", ["ev_new:m2"]);
  const yeB = makeSnippet("gsn_ye_b", "木门和歪脖子椰子树人多要排队，椰林沙滩同样出片且不排队", ["ev_new:m2"]);
  assert.equal(areDisplaySimilarSnippets(yeA, yeB, trip), false, "椰林沙滩 0.455 红线对：连续段占比越界不合并");
  assert.equal(clusterSimilarSnippets([yeA, yeB], trip).length, 2, "卡内仍 2 条");
  // 太阳湾 0.588 / 鹿回头 0.563 / 南山 0.529：同提及对 sim ≥ 0.5 越展示层上界（#339 刻意保留域）
  const sunA = makeSnippet("gsn_sun_a", "观景台限时7分钟，提前想好姿势速拍", ["ev_new:m1"]);
  const sunB = makeSnippet("gsn_sun_b", "有专门观景台可拍照但限时7分钟，速战速决", ["ev_new:m1"]);
  assert.equal(areDisplaySimilarSnippets(sunA, sunB, trip), false);
  const luA = makeSnippet("gsn_lu_a", "不想爬山可坐观光车，又凉快又省力", ["ev_new:m1"]);
  const luB = makeSnippet("gsn_lu_b", "天黑后看城市夜景最佳，不想爬山可坐观光车", ["ev_new:m1"]);
  assert.equal(areDisplaySimilarSnippets(luA, luB, trip), false);
  const nanA = makeSnippet("gsn_nan_a", "园区挺大尽早出发，穿素色衣服拍照更搭", ["ev_new:m1"]);
  const nanB = makeSnippet("gsn_nan_b", "穿素色衣服拍照更搭，别穿太短太暴露", ["ev_new:m1"]);
  assert.equal(areDisplaySimilarSnippets(nanA, nanB, trip), false);
  assert.equal(clusterSimilarSnippets([sunA, sunB, luA, luB, nanA, nanB], trip).length, 6, "六条各自成簇，卡内展示形态不变");
});

test("#342/#352 跨来源夹具：不同攻略相似对聚簇并标注「2篇攻略提及」；部分交叠 / 悬空 / 无 trip 不聚", () => {
  const trip = makeTrip();
  // ev_old 属 src_old、ev_new 属 src_active → 两篇不同攻略（现网暂无实数据，构造夹具：
  // 用过江龙同文本但归属两篇攻略，验证跨来源档命中且标注「2 篇攻略提及」）
  const a = makeSnippet("gsn_cross_a", "不想花钱排队可走旁边平行木栈道，景色差不多", ["ev_old:m3"]);
  const b = makeSnippet("gsn_cross_b", "索桥20元排队久，可走旁边栈道免费绕过", ["ev_new:m1"]);
  const sim = snippetSimilarity(a.text, b.text);
  assert.ok(
    sim >= SNIPPET_DISPLAY_CLUSTER_SIM_MIN && sim < SNIPPET_DISPLAY_CLUSTER_SIM_MAX,
    `跨来源夹具对重合率需落在展示层区间（得 ${sim.toFixed(3)}）`,
  );
  assert.equal(areDisplaySimilarSnippets(a, b, trip), true, "跨来源 + 区间内 + 连续段达标 → 聚类");
  const clusters = clusterSimilarSnippets([a, b], trip);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0]?.sourceCount, 2, "簇内不同来源数 = 2");
  assert.equal(clusters[0]?.mentionCount, 2, "两篇各提及一次 → 总提及 2 次");
  assert.equal(snippetClusterNote(clusters[0]!), "2篇攻略提及", "#352：每篇恰好一次且 ≥2 篇 → 篇（无空格装饰）");
  // 部分交叠（同来源 + 引用组合不同的 #339 第三档领域）→ 展示层不介入
  const fogA = makeSnippet("gsn_fog_a", "大雾天上去白茫茫拍不到，钱就白花", ["ev_new:m1"]);
  const fogB = makeSnippet("gsn_fog_b", "大雾天玻璃栈道白茫茫拍不到，谨慎购买", ["ev_new:m1", "ev_new_shot:m5"]);
  assert.equal(areDisplaySimilarSnippets(fogA, fogB, trip), false, "部分交叠不入展示层聚类（#339 领域）");
  // 悬空引用（无归属来源）不聚；无 trip 上下文只有 refs 完全相同档生效
  const ghost = makeSnippet("gsn_ghost", "索桥20元排队久，可走旁边栈道免费绕过", ["ev_ghost:m1"]);
  assert.equal(clusterSimilarSnippets([a, ghost], trip).length, 2, "悬空引用不聚类");
  assert.equal(clusterSimilarSnippets([a, b], undefined).length, 2, "无 trip 时跨来源档不生效");
  const noTrip = clusterSimilarSnippets(
    [
      makeSnippet("gsn_x", "不想花钱排队可走旁边平行木栈道，景色差不多", ["ev_new:m2"]),
      makeSnippet("gsn_y", "索桥20元排队久，可走旁边栈道免费绕过", ["ev_new:m2"]),
    ],
    undefined,
  );
  assert.equal(noTrip.length, 1, "无 trip 时 refs 完全相同档仍生效");
  assert.equal(noTrip[0]?.sourceCount, 0, "无 trip 无法解析来源 → sourceCount 0");
  assert.equal(noTrip[0]?.mentionCount, 1, "无 trip 退化为字面 ref 去重计数 → 同一 ref 只计 1 次");
  assert.equal(snippetClusterNote(noTrip[0]!), null, "#352：总提及 ≤ 1 不标注");
});

test("#342 单条簇不标注；聚类为纯函数（入参逐字节不变）", () => {
  const trip = makeTrip();
  const single = makeSnippet("gsn_single", "试婚房免费参观，不要被路边人忽悠花钱", ["ev_new:m2"]);
  const clusters = clusterSimilarSnippets([single], trip);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0]?.mergedCount, 1);
  assert.equal(clusters[0]?.mentionCount, 1, "单条单引用 → 总提及 1 次");
  assert.equal(snippetClusterNote(clusters[0]!), null, "N=1 不标注");
  const entries = [
    makeSnippet("gsn_a", "不想花钱排队可走旁边平行木栈道，景色差不多", ["ev_new:m2"]),
    makeSnippet("gsn_b", "索桥20元排队久，可走旁边栈道免费绕过", ["ev_new:m2"]),
  ];
  const before = clone(entries);
  const tripBefore = clone(trip);
  clusterSimilarSnippets(entries, trip);
  assert.deepEqual(entries, before, "聚类不得修改 snippet 入参");
  assert.deepEqual(trip, tripBefore, "聚类不得修改 trip");
});

// ===== 10. Task #352：合并标注文案改短（处/篇规则） =====

test("#352 同篇两处不同提及的相似对：聚簇后标注「2处攻略提及」（单篇多处一律处）", () => {
  const trip = makeTrip();
  // 过江龙同文本夹具：两条同属 src_active，但引用组合完全相同且指向两处不同提及
  // （ev_new:m2「过江龙索桥」 / ev_new_shot:m5「玻璃栈道」）→ 同篇 2 处提及
  const a = makeSnippet("gsn_multi_a", "不想花钱排队可走旁边平行木栈道，景色差不多", ["ev_new:m2", "ev_new_shot:m5"]);
  const b = makeSnippet("gsn_multi_b", "索桥20元排队久，可走旁边栈道免费绕过", ["ev_new:m2", "ev_new_shot:m5"]);
  const clusters = clusterSimilarSnippets([a, b], trip);
  assert.equal(clusters.length, 1, "refs 完全相同 → 展示层聚类");
  assert.equal(clusters[0]?.sourceCount, 1);
  assert.equal(clusters[0]?.mentionCount, 2, "同篇两处不同提及 → 总提及 2 次");
  assert.equal(snippetClusterNote(clusters[0]!), "2处攻略提及", "#352：单篇多处 → 处计总数，不再用「同篇攻略 N 处提及」长文案");
});

test("#352 提及次数按身份键去重：同句提及跨证据只计 1 次（ev_new:m2 与 ev_new_shot:m1 同句）", () => {
  const trip = makeTrip();
  // ev_new_shot:m1 与 ev_new:m2 同为「可以走过江龙索桥」一句（同来源同句跨证据重复提取），
  // 身份键相同 → 总提及仍为 2（m2/m1 计 1 次 + m5 计 1 次），不因证据翻倍而虚报
  const a = makeSnippet("gsn_id_a", "不想花钱排队可走旁边平行木栈道，景色差不多", ["ev_new:m2", "ev_new_shot:m1", "ev_new_shot:m5"]);
  const b = makeSnippet("gsn_id_b", "索桥20元排队久，可走旁边栈道免费绕过", ["ev_new:m2", "ev_new_shot:m1", "ev_new_shot:m5"]);
  const clusters = clusterSimilarSnippets([a, b], trip);
  assert.equal(clusters[0]?.mentionCount, 2, "同句跨证据去重后总提及 2 次");
  assert.equal(snippetClusterNote(clusters[0]!), "2处攻略提及");
});

test("#352 文案三分支（PD 新口径）：只有「每篇恰好一次且 ≥2 篇」用篇，其余一律处计总数", () => {
  // 分支一：单篇出现多次 → N处（N=总提及数）
  assert.equal(snippetClusterNote({ sourceCount: 1, mentionCount: 3 }), "3处攻略提及");
  // 分支二：多篇各恰好一次（总提及数 == 篇数且 ≥2）→ N篇
  assert.equal(snippetClusterNote({ sourceCount: 2, mentionCount: 2 }), "2篇攻略提及");
  assert.equal(snippetClusterNote({ sourceCount: 3, mentionCount: 3 }), "3篇攻略提及");
  // 分支三：多篇累计多次（总提及数 > 篇数）→ X处（X=总提及数，不细分）
  assert.equal(snippetClusterNote({ sourceCount: 2, mentionCount: 3 }), "3处攻略提及");
  assert.equal(snippetClusterNote({ sourceCount: 2, mentionCount: 5 }), "5处攻略提及");
  // 来源不可解析（sourceCount=0）但总提及 ≥2 → 处（不冒充篇数）
  assert.equal(snippetClusterNote({ sourceCount: 0, mentionCount: 2 }), "2处攻略提及");
  // 总提及 ≤1（含单条簇、同句重复抽取并存对）→ 不标注
  assert.equal(snippetClusterNote({ sourceCount: 1, mentionCount: 1 }), null);
  assert.equal(snippetClusterNote({ sourceCount: 0, mentionCount: 0 }), null);
});
