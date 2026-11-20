/**
 * Task #270：optionGroups 内容感知解锁 + snippets 去重验证（全程离线，不触网）。
 *
 * 背景：Task #216 P1-C 的降级（提及 < 5 或 scope = attraction）把西岛「步行 / 电动车 /
 * 观光车 / 电动三轮车 + 多个价格」这种天然可成组的对比信息挡在 optionGroups 之外（Task
 * #269 评测已证明解锁后 4/4 稳定产出 transport 组）。本任务改为内容感知解锁：只有素材
 * 命中「同一主题 ≥2 个可比较选项」信号才注入完整第七节，同时把百炼重复写进 snippets 的
 * 同一内容按确定性规则删除。
 *
 * 场景：
 *   1. 信号纯函数：西岛交通命中；普通亮点 / 单点门票不命中；跨语义族不凑组；价格档位型命中；
 *   2. prompt 注入：有信号 → 提及 <5 与 attraction scope 都注入完整第七节；
 *      无信号 → 维持降级短声明（token 不被普遍抬高）；
 *   3. snippet-only 快速路径：含信号 → 主动回落完整 planner；无信号 → 仍走快速路径；
 *   4. 去重回放：Task #269 保存的两轮真实响应（/tmp 同内容内联）——纯 optionGroups 版
 *      零删除；snippets 与 optionGroups 重复版 3 条全删；追加普通亮点时仅保留该条；
 *   5. 端到端：桩注入重复版响应 → 草案逐条落盘去重；应用后 snippets 0 条、选项组 1 组。
 *
 * 运行：npx tsx server/src/guides/verify-task270.ts
 * 临时行程（server/data）在脚本末尾全部清理，不影响用户既有数据。
 */

import "../env.js";
import assert from "node:assert/strict";
import type { GuideSource, Item, SourceEvidence, Trip, Visit } from "@goplay/shared";
import { createEmptyGuideImageProgress } from "@goplay/shared";
import { createFixtureSanyaTrip, tripStore } from "../persistence/store.js";
import { resetGuidePlannerDeps, setGuidePlannerDeps } from "./planner.js";
import {
  detectMergeOptionGroupSignals,
  detectOptionGroupSignals,
  dropSnippetsDuplicatedByOptionGroups,
  hasOptionGroupSignals,
} from "./optionSignals.js";
import { buildGuidePlannerRulesText, parsePlannerOutput } from "./planner.js";
import { guideRoutes } from "./routes.js";

function pass(name: string): void {
  console.log(`✓ ${name}`);
}

const createdTripIds: string[] = [];

async function requestJson(
  routePath: string,
  method: "GET" | "POST" | "PUT",
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await guideRoutes.request(routePath, init);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function loadTrip(tripId: string): Promise<Trip> {
  const trip = await tripStore.load(tripId);
  assert.ok(trip !== null, `行程 ${tripId} 应存在`);
  return trip;
}

// ===== planner 桩（响应队列 + prompt 捕获） =====

let stubResponses: string[] = [];
const capturedPrompts: string[] = [];

function armPlanner(...responses: string[]): void {
  stubResponses = [...responses];
  capturedPrompts.length = 0;
}

setGuidePlannerDeps({
  callPlanner: async (prompt: string) => {
    capturedPrompts.push(prompt);
    const next = stubResponses.shift();
    if (next === undefined) throw new Error("桩响应已耗尽（测试准备失误）");
    return next;
  },
});

// ===== 素材：西岛交通原文（Task #269 评测基线）+ 普通亮点对照 =====

/** 西岛交通四行原文（与 eval-optionGroups 的评测素材逐字同源） */
const XIDAO_TRANSPORT_LINES = [
  "西岛上交通方式",
  "步行：西岛不大，核心打卡点集中在码头左侧的海岸线和渔村，步行即可轻松覆盖，适合不想花钱代步的人。",
  "租电动车：约 25-40 元/天，适合想在渔村小巷深度逛、追求自由的人。注意：必须佩戴头盔，规范停车，否则会被交警罚款 50 元；且电动车无法直达牛王岭，只能停在 1 公里外再徒步。",
  "观光车/三轮车：去牛王岭或乌龟滩建议坐观光车（约 25-35 元/人），省力且不晒；也可以坐岛上村民的电动三轮车（约 5-10 元/人），能直接送到牛王岭脚下。",
];

/** 普通单条亮点（必须不命中） */
const PLAIN_HIGHLIGHT_LINES = ["鹿回头：傍晚看日落很美。", "鹿回头：建议早上去人少，一小时足够。"];

// ===== 夹具 =====

function mkMention(
  mentionId: string,
  text: string,
  quoteText: string,
  extractedName: string | null,
  claimKind: NonNullable<SourceEvidence["mentions"][number]["claimKind"]>,
  targetScope: NonNullable<SourceEvidence["mentions"][number]["targetScope"]>,
): SourceEvidence["mentions"][number] {
  return {
    mentionId,
    text,
    quoteText,
    bbox: null,
    extractedName,
    locationHint: null,
    modelSummary: `【桩】${quoteText}`,
    claimKind,
    targetScope,
    firsthand: true,
    relationEvidence: null,
  };
}

function customItem(itemId: string, name: string, suggestMinutes: number | null): Item {
  return {
    itemId,
    name,
    origin: "custom",
    providerId: null,
    address: null,
    category: null,
    coords: null,
    suggestMinutes,
    mainPic: null,
    ticketInfo: null,
    jumpUrl: null,
    sourceEvidenceRefs: [],
  };
}

function mkVisit(
  visitId: string,
  dayRef: string,
  pointRef: string,
  kind: Visit["kind"],
  order: number,
  sourceMentionRefs: string[],
): Visit {
  return {
    visitId,
    dayRef,
    pointRef,
    kind,
    visitMode: kind === "large_attraction" ? "full_day" : "custom",
    order,
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
    sourceMentionRefs,
    purchaseState: "unknown",
    locked: false,
    userAdjusted: false,
    removedFrom: null,
    removedAt: null,
  };
}

function mkSource(sourceId: string, title: string, evidenceId: string, refs: string[]): GuideSource {
  return {
    sourceId,
    sourceVersion: 1,
    inputKind: "text",
    title,
    active: true,
    status: "ready",
    evidenceRefs: [evidenceId],
    mentionRefs: refs,
    imageProgress: createEmptyGuideImageProgress(),
    importedAt: "2026-10-26T08:00:00.000Z",
    updatedAt: "2026-10-26T08:00:00.000Z",
  };
}

/** Trip A：西岛（大景区）+ 四行交通原文（命中信号） */
async function setupSignalTrip(tripId: string): Promise<void> {
  const trip = await loadTrip(tripId);
  trip.itemRegistry["item_xd270"] = customItem("item_xd270", "西岛", 240);
  const day1 = trip.days["day_1"];
  assert.ok(day1 !== undefined, "前提：fixture 应有 day_1");
  day1.scheduleVisitRefs = [...day1.scheduleVisitRefs, "visit_xd270"];
  trip.visits["visit_xd270"] = mkVisit(
    "visit_xd270",
    "day_1",
    "item_xd270",
    "large_attraction",
    day1.scheduleVisitRefs.length - 1,
    ["ev270:m1", "ev270:m2", "ev270:m3", "ev270:m4"],
  );

  trip.evidences["ev270"] = {
    evidenceId: "ev270",
    kind: "note_text",
    noteIndex: 12,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions: [
      mkMention("m1", "西岛", XIDAO_TRANSPORT_LINES[0] ?? "", "西岛", "route_listing", "place"),
      mkMention("m2", "西岛", XIDAO_TRANSPORT_LINES[1] ?? "", "西岛", "route_listing", "place"),
      mkMention("m3", "西岛", XIDAO_TRANSPORT_LINES[2] ?? "", "西岛", "route_listing", "place"),
      mkMention("m4", "西岛", XIDAO_TRANSPORT_LINES[3] ?? "", "西岛", "route_listing", "place"),
    ],
  };
  trip.guideSources = { src270: mkSource("src270", "西岛交通攻略", "ev270", ["ev270:m1", "ev270:m2", "ev270:m3", "ev270:m4"]) };
  trip.guideDraftNote = "";
  await tripStore.save(trip);
}

/** Trip B：鹿回头（普通景点）+ 两条普通亮点（不命中信号，用于对照降级 / 快速路径） */
async function setupPlainTrip(tripId: string): Promise<void> {
  const trip = await loadTrip(tripId);
  trip.itemRegistry["item_lht270"] = customItem("item_lht270", "鹿回头", 60);
  const day2 = trip.days["day_2"];
  assert.ok(day2 !== undefined, "前提：fixture 应有 day_2");
  day2.scheduleVisitRefs = [...day2.scheduleVisitRefs, "visit_lht270"];
  trip.visits["visit_lht270"] = mkVisit(
    "visit_lht270",
    "day_2",
    "item_lht270",
    "ordinary",
    day2.scheduleVisitRefs.length - 1,
    ["ev270ns:m1", "ev270ns:m2"],
  );
  trip.evidences["ev270ns"] = {
    evidenceId: "ev270ns",
    kind: "note_text",
    noteIndex: 13,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions: [
      mkMention("m1", "鹿回头", PLAIN_HIGHLIGHT_LINES[0] ?? "", "鹿回头", "experience", "place"),
      mkMention("m2", "鹿回头", PLAIN_HIGHLIGHT_LINES[1] ?? "", "鹿回头", "tip", "place"),
    ],
  };
  trip.guideSources = { src270ns: mkSource("src270ns", "鹿回头随手记", "ev270ns", ["ev270ns:m1", "ev270ns:m2"]) };
  trip.guideDraftNote = "";
  await tripStore.save(trip);
}

// ===== Task #269 保存的真实响应（/tmp/goplay-eval-run1|2.txt 同一内容，改写 id 内联） =====

/** run1：只有 optionGroups（4 个交通选项），snippets 为空 */
const RAW_RUN1 = `{"operations":[],"snippets":[],"optionGroups":[{"topic":"西岛环岛交通方式","category":"transport","targetRef":{"kind":"visit","id":"@VISIT@"},"sourceMentionRefs":["@EVID@:m1"],"options":[{"label":"步行","priceText":null,"routeText":"码头左侧海岸线和渔村","sceneText":"不想花钱代步、轻松覆盖核心打卡点","bargain":null,"noteText":"西岛不大，核心打卡点集中，步行即可轻松覆盖","sourceMentionRefs":["@EVID@:m2"]},{"label":"租电动车","priceText":"约 25-40 元/天","routeText":null,"sceneText":"渔村小巷深度逛、追求自由","bargain":null,"noteText":"必须佩戴头盔、规范停车，否则罚款 50 元；无法直达牛王岭","sourceMentionRefs":["@EVID@:m3"]},{"label":"观光车","priceText":"约 25-35 元/人","routeText":"去牛王岭或乌龟滩","sceneText":"省力且不晒","bargain":null,"noteText":null,"sourceMentionRefs":["@EVID@:m4"]},{"label":"电动三轮车","priceText":"约 5-10 元/人","routeText":"能直接送到牛王岭脚下","sceneText":null,"bargain":null,"noteText":null,"sourceMentionRefs":["@EVID@:m4"]}]}]}`;

/** run2：同一条交通内容同时写进 snippets 与 optionGroups（去重目标） */
const RAW_RUN2 = `{
  "operations": [],
  "snippets": [
    {"text":"西岛不大，核心打卡点集中在码头左侧海岸线和渔村，步行即可覆盖","claimKind":"tip","targetRef":{"kind":"visit","id":"@VISIT@"},"sourceMentionRefs":["@EVID@:m2"]},
    {"text":"租电动车约25-40元/天，须戴头盔规范停车，否则罚50元","claimKind":"tip","targetRef":{"kind":"visit","id":"@VISIT@"},"sourceMentionRefs":["@EVID@:m3"]},
    {"text":"去牛王岭或乌龟滩建议坐观光车25-35元/人，省力不晒","claimKind":"tip","targetRef":{"kind":"visit","id":"@VISIT@"},"sourceMentionRefs":["@EVID@:m4"]}
  ],
  "optionGroups": [
    {"topic":"西岛环岛交通方式","category":"transport","options":[
      {"label":"步行","priceText":null,"routeText":"码头左侧海岸线和渔村","sceneText":"不想花钱代步的人","bargain":null,"noteText":"核心打卡点集中，步行即可轻松覆盖","sourceMentionRefs":["@EVID@:m2"]},
      {"label":"租电动车","priceText":"约 25-40 元/天","routeText":"渔村小巷","sceneText":"想在渔村小巷深度逛、追求自由的人","bargain":null,"noteText":"必须佩戴头盔，规范停车，否则会被交警罚款 50 元；电动车无法直达牛王岭","sourceMentionRefs":["@EVID@:m3"]},
      {"label":"观光车","priceText":"约 25-35 元/人","routeText":"去牛王岭或乌龟滩","sceneText":"省力且不晒","bargain":null,"noteText":null,"sourceMentionRefs":["@EVID@:m4"]},
      {"label":"电动三轮车","priceText":"约 5-10 元/人","routeText":"能直接送到牛王岭脚下","sceneText":null,"bargain":null,"noteText":"岛上村民运营","sourceMentionRefs":["@EVID@:m4"]}
    ],"targetRef":{"kind":"visit","id":"@VISIT@"},"sourceMentionRefs":["@EVID@:m1"]}
  ]
}`;

function adaptRaw(raw: string, visitId: string, evidenceId: string): string {
  return raw.replaceAll("@VISIT@", visitId).replaceAll("@EVID@", evidenceId);
}

/** 无操作无提示的合法响应（快速路径回落时消耗桩） */
const STUB_NOOP_JSON = JSON.stringify({ operations: [], snippets: [], optionGroups: [] });

// ===== main =====

async function main(): Promise<void> {
  try {
    await runScenarios();
    console.log("\n[verify] Task #270（optionGroups 内容感知解锁 + snippets 去重）全部通过 ✓");
  } finally {
    resetGuidePlannerDeps();
    let removed = 0;
    for (const tripId of createdTripIds) {
      try {
        await tripStore.deleteTrip(tripId);
        removed += 1;
      } catch (error) {
        console.warn(`[verify] 清理临时行程 ${tripId} 失败:`, error);
      }
    }
    console.log(`[verify] 已清理 ${removed}/${createdTripIds.length} 个临时行程（server/data）`);
  }
}

async function runScenarios(): Promise<void> {
  // ---------- 场景 1：信号纯函数 ----------
  {
    const xidao = detectOptionGroupSignals(XIDAO_TRANSPORT_LINES);
    assert.equal(xidao.hit, true, "西岛交通四行原文应命中信号");
    for (const expected of ["步行", "电动车", "观光车", "电动三轮车"]) {
      assert.ok(
        xidao.optionTerms.some((term) => term.includes(expected) || expected.includes(term)),
        `命中选项词应包含「${expected}」（实际：${xidao.optionTerms.join(" / ")}）`,
      );
    }
    assert.ok(xidao.priceCount >= 3, `西岛原文应识别出多个价格（实际 ${xidao.priceCount}）`);
    assert.equal(xidao.priceRange, true, "「25-40 元/天」应识别为价格区间");

    const plain = detectOptionGroupSignals(PLAIN_HIGHLIGHT_LINES);
    assert.equal(plain.hit, false, "普通单条亮点（日落 / 早上人少）不得命中");
    assert.equal(plain.optionTerms.length, 0, "普通亮点不应命中任何选项词");

    assert.equal(hasOptionGroupSignals(["蜈支洲岛：环岛电瓶车120元一位。"]), false, "单一方式 + 单价格不命中");
    assert.equal(hasOptionGroupSignals(["西岛：门票 80 元，景区停车 10 元。"]), false, "跨语义族的价格不凑组");
    assert.equal(hasOptionGroupSignals(["交通：可以步行，也可以坐观光车。"]), true, "同族两种方式（无价格）命中");
    assert.equal(
      hasOptionGroupSignals(["门票价格 80 元、120 元、150 元，对比下来贵的更值"]),
      true,
      "主题 + 对比 + 多档价格命中（价格档位型）",
    );
    assert.equal(
      hasOptionGroupSignals(["门票区间 120-180 元，对比单买更划算"]),
      true,
      "主题 + 对比 + 价格区间命中（价格档位型）",
    );
    assert.equal(hasOptionGroupSignals(["西岛：珊瑚石墙超出片，建议早上八点前去。"]), false, "纯玩法亮点不命中");
    pass("1. 信号：西岛交通命中（4 方式 + 多价格）/ 普通亮点与单点门票不命中 / 跨族不凑组 / 价格档位型命中");
  }

  // ---------- 场景 2：prompt 注入（有信号解锁 / 无信号仍降级） ----------
  const signalTrip = await createFixtureSanyaTrip();
  createdTripIds.push(signalTrip.tripId);
  await setupSignalTrip(signalTrip.tripId);
  const plainTrip = await createFixtureSanyaTrip();
  createdTripIds.push(plainTrip.tripId);
  await setupPlainTrip(plainTrip.tripId);
  {
    armPlanner(STUB_NOOP_JSON);
    const res = await requestJson(`/trips/${signalTrip.tripId}/draft`, "POST", {
      scope: { kind: "attraction", visitId: "visit_xd270" },
    });
    assert.equal(res.status, 200, `生成应 200（实际 ${JSON.stringify(res.body)}）`);
    const prompt = capturedPrompts[0] ?? "";
    assert.ok(
      prompt.includes("七、optionGroups（实用参考选项组，Task #190）"),
      "attraction scope + 4 条提及（<5）+ 有信号 → 应注入完整第七节",
    );
    assert.ok(
      !prompt.includes("七、optionGroups：本轮不适用，输出空数组 []"),
      "信号命中时不得输出降级短声明",
    );
    assert.ok(prompt.includes("与 snippets 的分工（Task #270）"), "完整第七节应含 snippets 分工禁令");
    assert.ok(
      prompt.includes("整个景区通用的交通方式 / 门票票种 / 装备租赁对比一律挂父级大景区 visit"),
      "完整第七节应含「通用交通挂父 visit」层级指导",
    );
    assert.equal(res.body.mentionCount, 4, "素材提及应为 4 条（命中旧降级阈值 <5）");
    pass("2a. 注入：提及 4 条（<5）+ attraction scope + 信号 → 完整第七节（含分工禁令与父 visit 指导）");
  }
  {
    armPlanner(STUB_NOOP_JSON);
    const res = await requestJson(`/trips/${plainTrip.tripId}/draft`, "POST", {
      scope: { kind: "attraction", visitId: "visit_lht270" },
    });
    assert.equal(res.status, 200, `生成应 200（实际 ${JSON.stringify(res.body)}）`);
    const prompt = capturedPrompts[0] ?? "";
    assert.ok(
      prompt.includes("七、optionGroups：本轮不适用，输出空数组 []"),
      "无信号的 attraction scope 应继续降级为短声明（不普遍抬 token）",
    );
    assert.ok(!prompt.includes("同一主题下至少 2 个可比较的选项"), "无信号时完整契约不得出现");
    assert.ok(prompt.includes("八、输出格式："), "降级后第八节应紧接其后");
    pass("2b. 注入：无信号素材维持降级短声明（token 仅按需增加）");
  }
  {
    // 纯函数形态：内容感知解锁不依赖 HTTP 链路
    assert.ok(
      buildGuidePlannerRulesText(3, { kind: "attraction", visitId: "visit_x" }, false).includes(
        "七、optionGroups：本轮不适用，输出空数组 []",
      ),
      "signals=false 时维持降级声明",
    );
    assert.ok(
      buildGuidePlannerRulesText(3, { kind: "attraction", visitId: "visit_x" }, true).includes(
        "七、optionGroups（实用参考选项组，Task #190）",
      ),
      "signals=true 时注入完整契约",
    );
    pass("2c. 注入：buildGuidePlannerRulesText 第三参数控制解锁（降级门槛本身不变）");
  }

  // ---------- 场景 3：snippet-only 快速路径与信号互斥 ----------
  {
    const note = "把推荐理由补充到对应景点卡片";
    armPlanner(STUB_NOOP_JSON);
    const res = await requestJson(`/trips/${signalTrip.tripId}/draft`, "POST", {
      sourceMode: "selected",
      selectedSourceIds: ["src270"],
      note,
      scope: { kind: "attraction", visitId: "visit_xd270" },
    });
    assert.equal(res.status, 200, `生成应 200（实际 ${JSON.stringify(res.body)}）`);
    assert.equal(res.body.fastPath, false, "含选项组信号的素材不得走快速路径");
    assert.equal(capturedPrompts.length, 1, "含信号时必须回落到完整 planner（调用一次桩）");
    pass("3a. 快速路径：含可比较信号 → 回落完整 planner（不再产出 optionGroups 恒空的快速结果）");
  }
  {
    const note = "把推荐理由补充到对应景点卡片";
    armPlanner();
    const res = await requestJson(`/trips/${plainTrip.tripId}/draft`, "POST", {
      sourceMode: "selected",
      selectedSourceIds: ["src270ns"],
      note,
      scope: { kind: "attraction", visitId: "visit_lht270" },
    });
    assert.equal(res.status, 200, `生成应 200（实际 ${JSON.stringify(res.body)}）`);
    assert.equal(res.body.fastPath, true, "无信号的补亮点请求仍走 snippet-only 快速路径");
    assert.equal(capturedPrompts.length, 0, "快速路径不得调用 AI（性能优化保留）");
    assert.ok(((res.body.snippets as unknown[]) ?? []).length >= 1, "快速路径仍应产出提示");
    pass("3b. 快速路径：无信号素材仍毫秒级走本地路径（性能优化未被普遍破坏）");
  }

  // ---------- 场景 4：去重回放（Task #269 真实响应） ----------
  {
    const validRefs = new Set(["ev270:m1", "ev270:m2", "ev270:m3", "ev270:m4"]);
    const run1 = parsePlannerOutput(adaptRaw(RAW_RUN1, "visit_xd270", "ev270"), validRefs);
    assert.ok(run1 !== null, "run1 应可解析");
    assert.equal(run1.snippets.length, 0, "run1 没有 snippets");
    assert.equal(run1.optionGroups.length, 1, "run1 应保留 1 组");
    assert.deepEqual(
      run1.optionGroups[0]?.options.map((option) => option.label),
      ["步行", "租电动车", "观光车", "电动三轮车"],
      "run1 四选项应完整保留",
    );
    const run1Dedupe = dropSnippetsDuplicatedByOptionGroups(run1.snippets, run1.optionGroups);
    assert.equal(run1Dedupe.dropped.length, 0, "无 snippets 时去重零删除");

    const run2 = parsePlannerOutput(adaptRaw(RAW_RUN2, "visit_xd270", "ev270"), validRefs);
    assert.ok(run2 !== null, "run2 应可解析");
    assert.equal(run2.snippets.length, 3, "run2 原始有 3 条与选项组重复的提示");
    assert.equal(run2.optionGroups.length, 1, "run2 有 1 组交通选项");
    const run2Dedupe = dropSnippetsDuplicatedByOptionGroups(run2.snippets, run2.optionGroups);
    assert.equal(run2Dedupe.dropped.length, 3, "3 条重复提示应全部删除");
    assert.equal(run2Dedupe.snippets.length, 0, "重复提示删除后不残留");
    for (const dropped of run2Dedupe.dropped) {
      assert.equal(dropped.topic, "西岛环岛交通方式", "删除记录应标明所属选项组主题");
    }

    // 追加一条普通亮点：不得因共享少量词被误删
    const withHighlight = {
      ...run2,
      snippets: [
        ...run2.snippets,
        {
          text: "西岛渔村慢慢逛，别赶时间",
          claimKind: "tip" as const,
          targetRef: { kind: "visit" as const, id: "visit_xd270" },
          sourceMentionRefs: ["ev270:m2"],
        },
      ],
    };
    const mixedDedupe = dropSnippetsDuplicatedByOptionGroups(withHighlight.snippets, withHighlight.optionGroups);
    assert.equal(mixedDedupe.dropped.length, 3, "重复的 3 条仍被删除");
    assert.deepEqual(
      mixedDedupe.snippets.map((snippet) => snippet.text),
      ["西岛渔村慢慢逛，别赶时间"],
      "非重复普通亮点保留",
    );

    // 组内没有该信息时不得删除（跨组不误伤）
    const unrelated = dropSnippetsDuplicatedByOptionGroups(
      [
        {
          text: "渔村食堂双人套餐 68 元",
          claimKind: "comparison" as const,
          targetRef: { kind: "visit" as const, id: "visit_xd270" },
          sourceMentionRefs: ["ev270:m2"],
        },
      ],
      run2.optionGroups,
    );
    assert.equal(unrelated.dropped.length, 0, "与交通组无关的餐饮提示不得被删");
    pass("4. 去重：run1 零删除 / run2 重复 3 条全删 / 普通亮点与异主题提示保留");
  }

  // ---------- 场景 5：端到端（草案落盘 + 应用计数） ----------
  {
    armPlanner(adaptRaw(RAW_RUN2, "visit_xd270", "ev270"));
    const genRes = await requestJson(`/trips/${signalTrip.tripId}/draft`, "POST", {
      scope: { kind: "attraction", visitId: "visit_xd270" },
    });
    assert.equal(genRes.status, 200, `生成应 200（实际 ${JSON.stringify(genRes.body)}）`);
    assert.equal((genRes.body.snippets as unknown[]).length, 0, "响应中重复提示应已被删除");
    assert.equal((genRes.body.optionGroups as unknown[]).length, 1, "响应中选项组保留 1 组");

    const savedDraft = await loadTrip(signalTrip.tripId);
    const draftOutput = savedDraft.pendingGuideDraft?.output;
    assert.ok(draftOutput !== undefined, "草案应持久化");
    assert.equal(draftOutput.snippets.length, 0, "草案落盘的 snippets 已去重");
    assert.equal(draftOutput.optionGroups?.length ?? 0, 1, "草案落盘的 optionGroups 保留");

    const applyRes = await requestJson(`/trips/${signalTrip.tripId}/draft/apply`, "POST");
    assert.equal(applyRes.status, 200, `应用应 200（实际 ${JSON.stringify(applyRes.body)}）`);
    assert.equal(applyRes.body.attachedSnippetCount, 0, "去重后不再挂载重复提示");
    assert.equal(applyRes.body.attachedOptionGroupCount, 1, "选项组应挂载到西岛");

    const applied = await loadTrip(signalTrip.tripId);
    const visit = applied.visits["visit_xd270"];
    assert.ok(visit !== undefined);
    assert.equal(visit.optionGroups?.length ?? 0, 1, "Visit.optionGroups 落 1 组");
    const transport = visit.optionGroups?.[0];
    assert.equal(transport?.category, "transport");
    assert.deepEqual(
      transport?.options.map((option) => option.label),
      ["步行", "租电动车", "观光车", "电动三轮车"],
      "四方式完整挂载",
    );
    assert.equal(transport?.options[0]?.routeText, "码头左侧海岸线和渔村", "routeText 原样落盘");
    assert.equal(transport?.options[0]?.sceneText, "不想花钱代步的人", "sceneText 原样落盘");
    assert.equal(
      transport?.options[0]?.noteText,
      "核心打卡点集中，步行即可轻松覆盖",
      "noteText 保持模型原文（不概括为「核心打卡点均可覆盖」）",
    );
    assert.equal(visit.guideSnippets?.length ?? 0, 0, "重复提示未写入卡片（同一信息只展示一次）");
    pass("5. 端到端：草案去重落盘 / 应用计数 0 提示 + 1 组 / route-scene-note 原样保留");
  }
}

void main();
