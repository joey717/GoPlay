/**
 * Task #147（服务端最小修复）确定性回归（全程离线，纯函数 + 隔离 fixture，不触网）：
 *
 * 缺陷一（directives.ts 单段地点匹配只返回一个 Visit，真实 trip d0174797 现场：
 * 「DAY4去亚龙湾」只命中旧大景点，遗漏同一有效新攻略中的亚龙湾海底世界与
 * 亚龙湾喜来登酒店）：
 *   1. 多匹配命中：「DAY4去亚龙湾」→ large 的森林公园在前 + 候选区的海底世界与
 *      喜来登酒店（同一 active 来源）全部命中；enforceDraftDirectives 为三个主体
 *      各补一条确定性 transfer（含候选区入天），requirement met 且 detail 点名两个新点；
 *   2. 不相关地点不误命中：仅偶然共享「湾」字的三亚湾游艇码头不命中；单字短语
 *      （「湾」「海」）不做互含匹配（防偶然短词泛化）；多段组合（「亚龙湾和西岛」）
 *      下 partial 判定直接检测无交集段，不再依赖「段数 > resolved 数」长度启发式。
 *
 * 缺陷二（prompt.ts 攻略候选过滤未校验来源 active，inactive 来源独占的候选仍进 planner）：
 *   3. inactive 来源独占的亚龙湾森林公园不进入 planner prompt（guideRelevantOnly）；
 *   4. active 与 inactive 共同支撑的候选保留（item 级 ev 并集 + mention 级多来源）；
 *      mention 全失效但 item 证据仍 active 时回退保留；无来源归属的旧证据候选保留
 *      （旧数据兼容）；无证据候选仍被裁剪（Task #110 原有行为不回退）。
 *
 * 边界保持：日期硬约束 / classifyVisitAsStop 护栏 / pending 禁令 / 旧数据兼容
 * 由 verify-b3.ts 场景 21-27 继续覆盖，本脚本不重复。
 *
 * 运行：npx tsx server/src/guides/verify-task147.ts
 * 临时行程（server/data）在脚本末尾全部清理，不影响用户既有数据。
 */

import "../env.js";
import assert from "node:assert/strict";
import type { GuideSource, Item, SourceEvidence, Trip, Visit } from "@goplay/shared";
import type { Operation } from "@goplay/shared";
import { createEmptyGuideImageProgress } from "@goplay/shared";
import { createFixtureSanyaTrip, tripStore } from "../persistence/store.js";
import { buildTripFacts } from "../ai/prompt.js";
import { enforceDraftDirectives, parseDraftDirectives } from "./directives.js";

function pass(name: string): void {
  console.log(`✓ ${name}`);
}

/** 本脚本创建的临时行程：finally 统一清理 */
const createdTripIds: string[] = [];

async function loadTrip(tripId: string): Promise<Trip> {
  const trip = await tripStore.load(tripId);
  assert.ok(trip !== null, `行程 ${tripId} 应存在`);
  return trip;
}

// ===== fixture 构造辅助 =====

function mkEvidence(evidenceId: string, noteIndex: number, mentions: SourceEvidence["mentions"]): SourceEvidence {
  return { evidenceId, kind: "note_text", noteIndex, assetRef: null, sourceUrl: null, ocrText: null, mentions };
}

function mkMention(
  mentionId: string,
  text: string,
  quoteText: string,
  extractedName: string,
): SourceEvidence["mentions"][number] {
  return {
    mentionId,
    text,
    quoteText,
    bbox: null,
    extractedName,
    locationHint: null,
    modelSummary: `【桩】${quoteText}`,
    claimKind: "experience",
    targetScope: "place",
    firsthand: true,
    relationEvidence: null,
  };
}

function mkSource(
  sourceId: string,
  title: string,
  active: boolean,
  evidenceRefs: string[],
  mentionRefs: string[],
): GuideSource {
  return {
    sourceId,
    sourceVersion: 1,
    inputKind: "text",
    title,
    active,
    // 软删除契约（validateConsistency）：active=false 必须携带 removedAt
    removedAt: active ? undefined : "2026-10-19T12:00:00.000Z",
    status: "ready",
    evidenceRefs,
    mentionRefs,
    imageProgress: createEmptyGuideImageProgress(),
    importedAt: "2026-10-19T08:00:00.000Z",
    updatedAt: "2026-10-19T08:00:00.000Z",
  };
}

function mkItem(itemId: string, name: string, sourceEvidenceRefs: string[], suggestMinutes: number | null): Item {
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
    sourceEvidenceRefs,
  };
}

/** 排天 visit（dayRef 非空，与 day.scheduleVisitRefs 对齐） */
function mkDayVisit(visitId: string, pointRef: string, kind: Visit["kind"], dayRef: string, order: number): Visit {
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
    externalLeg: { mode: "驾车", minutes: 30, note: null, source: "user" },
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

/** globalPool 候选 visit（dayRef=null / order=null，与真实 trip d0174797 候选区同构） */
function mkPoolVisit(visitId: string, pointRef: string, sourceMentionRefs: string[]): Visit {
  return {
    visitId,
    dayRef: null,
    pointRef,
    kind: "ordinary",
    visitMode: "custom",
    order: null,
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

/**
 * 夹具 A（缺陷一现场复刻，模仿真实 trip d0174797 的亚龙湾形态）：
 * - visit_forest「亚龙湾热带天堂森林公园」large 已排 Day1，证据为无来源归属的
 *   旧证据 ev_legacy（历史装配产物——旧数据兼容形态，指令解析只看名称）；
 * - visit_ocean「亚龙湾海底世界」/ visit_hotel「亚龙湾喜来登酒店」：候选区 visit，
 *   同一 active 来源 src_new（ev_new）支撑，mention 精确到提及粒度；
 * - visit_noise「三亚湾游艇码头」：候选区干扰项（仅与「亚龙湾」偶然共享「湾」字）。
 */
async function setupYalongBayFixture(tripId: string): Promise<Trip> {
  const trip = await loadTrip(tripId);
  trip.evidences["ev_new"] = mkEvidence("ev_new", 13, [
    mkMention("o1", "亚龙湾海底世界", "亚龙湾海底世界看珊瑚，下午场人少", "亚龙湾海底世界"),
    mkMention("h1", "亚龙湾喜来登酒店", "住亚龙湾喜来登酒店，步行到沙滩五分钟", "亚龙湾喜来登酒店"),
  ]);
  trip.evidences["ev_legacy"] = mkEvidence("ev_legacy", 4, [
    mkMention("f1", "亚龙湾热带天堂森林公园", "森林公园打卡过江龙索桥", "亚龙湾热带天堂森林公园"),
  ]);

  trip.itemRegistry["item_forest"] = mkItem("item_forest", "亚龙湾热带天堂森林公园", ["ev_legacy"], null);
  trip.itemRegistry["item_ocean"] = mkItem("item_ocean", "亚龙湾海底世界", ["ev_new"], 120);
  trip.itemRegistry["item_hotel"] = mkItem("item_hotel", "亚龙湾喜来登酒店", ["ev_new"], 60);
  trip.itemRegistry["item_noise"] = mkItem("item_noise", "三亚湾游艇码头", [], 90);

  trip.visits["visit_forest"] = mkDayVisit("visit_forest", "item_forest", "large_attraction", "day_1", 0);
  const day1 = trip.days["day_1"];
  assert.ok(day1 !== undefined, "前提：fixture 应有 day_1");
  day1.scheduleVisitRefs = ["visit_forest"];

  trip.visits["visit_ocean"] = mkPoolVisit("visit_ocean", "item_ocean", ["ev_new:o1"]);
  trip.visits["visit_hotel"] = mkPoolVisit("visit_hotel", "item_hotel", ["ev_new:h1"]);
  trip.visits["visit_noise"] = mkPoolVisit("visit_noise", "item_noise", []);
  trip.globalCandidateRefs.push(
    { kind: "visit", id: "visit_ocean" },
    { kind: "visit", id: "visit_hotel" },
    { kind: "visit", id: "visit_noise" },
  );

  trip.guideSources = {
    src_new: mkSource("src_new", "亚龙湾新攻略（active）", true, ["ev_new"], ["ev_new:o1", "ev_new:h1"]),
  };
  await tripStore.save(trip);
  return loadTrip(tripId);
}

/**
 * 夹具 B（缺陷二现场复刻）：
 * - src_old inactive 独占 ev_xhs；src_new active 独占 ev_note_new；ev_legacy 无归属；
 * - 候选：visit_park_old（inactive 独占 / 应裁剪）、visit_multi（mention 级 active+inactive
 *   共同支撑 / 应保留）、item_shared（item 级证据并集共同支撑 / 应保留）、
 *   visit_fallback（mention 全失效回退 item active 证据 / 应保留）、
 *   item_unowned（无来源归属旧证据 / 应保留）、基础夹具 item_daxiaodongtian（无证据 / 裁剪）。
 */
async function setupPromptFilterFixture(tripId: string): Promise<Trip> {
  const trip = await loadTrip(tripId);
  trip.evidences["ev_xhs"] = mkEvidence("ev_xhs", 6, [
    mkMention("m_ty", "天涯海角", "天涯海角日落最美", "天涯海角"),
    mkMention("m_fb", "小东海", "小东海潜水便宜", "小东海"),
  ]);
  trip.evidences["ev_note_new"] = mkEvidence("ev_note_new", 13, [
    mkMention("m_ty2", "天涯海角", "新攻略也提到天涯海角", "天涯海角"),
  ]);
  trip.evidences["ev_legacy"] = mkEvidence("ev_legacy", 3, [
    mkMention("m_tw", "太阳湾公路", "太阳湾公路自驾最美", "太阳湾公路"),
  ]);

  trip.itemRegistry["item_park_old"] = mkItem("item_park_old", "亚龙湾森林公园", ["ev_xhs"], 180);
  trip.itemRegistry["item_multi"] = mkItem("item_multi", "天涯海角", ["ev_xhs"], 150);
  trip.itemRegistry["item_shared"] = mkItem("item_shared", "鹿回头", ["ev_xhs", "ev_note_new"], 90);
  trip.itemRegistry["item_fallback"] = mkItem("item_fallback", "小东海", ["ev_note_new"], 120);
  trip.itemRegistry["item_unowned"] = mkItem("item_unowned", "太阳湾公路", ["ev_legacy"], 60);

  trip.visits["visit_park_old"] = mkPoolVisit("visit_park_old", "item_park_old", []);
  trip.visits["visit_multi"] = mkPoolVisit("visit_multi", "item_multi", ["ev_xhs:m_ty", "ev_note_new:m_ty2"]);
  trip.visits["visit_fallback"] = mkPoolVisit("visit_fallback", "item_fallback", ["ev_xhs:m_fb"]);
  trip.globalCandidateRefs.push(
    { kind: "visit", id: "visit_park_old" },
    { kind: "visit", id: "visit_multi" },
    { kind: "visit", id: "visit_fallback" },
    { kind: "point", id: "item_shared" },
    { kind: "point", id: "item_unowned" },
  );

  trip.guideSources = {
    src_old: mkSource("src_old", "已删除的旧攻略（inactive）", false, ["ev_xhs"], ["ev_xhs:m_ty", "ev_xhs:m_fb"]),
    src_new: mkSource("src_new", "新攻略（active）", true, ["ev_note_new"], ["ev_note_new:m_ty2"]),
  };
  await tripStore.save(trip);
  return loadTrip(tripId);
}

// ===== 场景 =====

async function runScenarios(): Promise<void> {
  // ---------- 场景 1 & 2：缺陷一（同一亚龙湾指令命中有效来源的两个点 / 不相关不误命中） ----------
  {
    const fixtureA = await createFixtureSanyaTrip();
    createdTripIds.push(fixtureA.tripId);
    const tripA = await setupYalongBayFixture(fixtureA.tripId);

    // 1a) 多匹配解析：large 森林公园在前，同一 active 来源的海底世界与喜来登酒店也命中
    //     （修复前只返回第一条 visit_forest，两个新点被遗漏）
    const directives = parseDraftDirectives("DAY4去亚龙湾", tripA);
    assert.deepEqual(
      directives,
      [
        {
          directiveId: "dir_1",
          dayIndex: 4,
          placeText: "亚龙湾",
          resolvedVisitIds: ["visit_forest", "visit_ocean", "visit_hotel"],
          rawSentence: "DAY4去亚龙湾",
        },
      ],
      "「亚龙湾」应多匹配：large 森林公园在前，海底世界与喜来登酒店也命中（Task #147）",
    );
    assert.ok(
      !directives[0]!.resolvedVisitIds.includes("visit_noise"),
      "「三亚湾游艇码头」仅与「亚龙湾」偶然共享「湾」字，不得命中",
    );

    // 1b) enforce 端到端：三个主体各补一条确定性 transfer（含候选区两个点入天）
    const enforced = enforceDraftDirectives(tripA, directives, []);
    const transfers = enforced.operations.filter(
      (op): op is Extract<Operation, { op: "transfer" }> => op.op === "transfer",
    );
    assert.deepEqual(
      transfers.map((op) => (op.subjectRef.kind === "visit" ? op.subjectRef.id : op.subjectRef.kind)),
      ["visit_forest", "visit_ocean", "visit_hotel"],
      "服务端应为三个命中主体各补一条 transfer（含候选区两个点的入天补排）",
    );
    for (const transfer of transfers) {
      assert.equal(
        transfer.toContainerRef.kind === "day" ? transfer.toContainerRef.dayIndex : -1,
        4,
        "补排目标天必须是 Day4",
      );
    }
    const check = enforced.requirementChecks[0];
    assert.equal(check?.status, "met", "三主体均有补排 op，生成期推演应为 met");
    assert.match(String(check?.detail ?? ""), /亚龙湾海底世界/, "detail 应点名同一有效来源的海底世界");
    assert.match(String(check?.detail ?? ""), /亚龙湾喜来登酒店/, "detail 应点名同一有效来源的喜来登酒店");
    assert.equal(enforced.conflicts.length, 0, "Day4 为空天且主体未锁定：无冲突");
    pass("1. 「DAY4去亚龙湾」多匹配：森林公园+海底世界+喜来登酒店全部命中并各补 transfer，requirement met");

    // 2a) 单字短语不做互含匹配（旧逻辑「湾」会互含命中森林公园/海底世界/喜来登酒店/
    //     三亚湾游艇码头等大量含「湾」点——名称仅偶然共享短词的无关点防泛化）
    const singleWan = parseDraftDirectives("DAY4去湾", tripA);
    assert.deepEqual(singleWan[0]?.resolvedVisitIds, [], "单字「湾」不得做互含匹配");
    const singleSea = parseDraftDirectives("DAY4去海", tripA);
    assert.deepEqual(
      singleSea[0]?.resolvedVisitIds,
      [],
      "单字「海」不得互含命中「亚龙湾海底世界」（防偶然短词泛化）",
    );

    // 2b) 不相关短语零命中（fixture 无「西岛」实体）
    const unrelated = parseDraftDirectives("DAY2去西岛", tripA);
    assert.deepEqual(unrelated[0]?.resolvedVisitIds, [], "「西岛」在行程中不存在，不应误命中");

    // 2c) 多段组合：一段多匹配 + 一段零匹配 → partial 直接检测无交集段
    //     （旧「段数 > resolved 数」启发式下 2 段 vs 3 resolved 会漏报 partial）
    const combo = parseDraftDirectives("DAY4去亚龙湾和西岛", tripA);
    assert.deepEqual(combo[0]?.resolvedVisitIds, ["visit_forest", "visit_ocean", "visit_hotel"]);
    const comboEnforced = enforceDraftDirectives(tripA, combo, []);
    assert.equal(
      comboEnforced.requirementChecks[0]?.status,
      "partial",
      "多匹配使 resolved 数 ≥ 段数时，partial 判定不得再依赖长度启发式",
    );
    assert.match(String(comboEnforced.requirementChecks[0]?.detail ?? ""), /西岛/, "未匹配段应在 detail 中点名");
    pass("2. 不误命中：偶然共享「湾」字的无关点不命中 / 单字短语不互含 / 多段组合 partial 判定不漏报");
  }

  // ---------- 场景 3 & 4：缺陷二（inactive 独占不进 prompt / 共同支撑保留） ----------
  {
    const fixtureB = await createFixtureSanyaTrip();
    createdTripIds.push(fixtureB.tripId);
    const tripB = await setupPromptFilterFixture(fixtureB.tripId);

    // planner 同款开关（buildGuidePlannerPrompt 传 guideRelevantCandidatesOnly: true）
    const facts = buildTripFacts(tripB, { guideRelevantCandidatesOnly: true }).join("\n");

    // 3) inactive 来源独占的候选不进入 prompt
    assert.ok(
      !facts.includes("亚龙湾森林公园") && !facts.includes("visit_park_old"),
      "inactive 来源独占的亚龙湾森林公园不得进入 planner prompt（Task #147）",
    );

    // 4a) active 与 inactive 共同支撑的候选保留（mention 级 + item 级证据并集）
    assert.ok(facts.includes("天涯海角"), "mention 级 active+inactive 共同支撑的天涯海角应保留");
    assert.ok(facts.includes("鹿回头"), "item 级证据并集（ev_xhs+ev_note_new）共同支撑的鹿回头应保留");
    // 4b) mention 全失效但 item 证据仍 active：回退保留
    assert.ok(facts.includes("小东海"), "mention 全失效但 item 证据仍 active 的小东海应回退保留");
    // 4c) 无来源归属的旧证据候选保留（旧数据兼容）
    assert.ok(facts.includes("太阳湾公路"), "无来源归属的旧证据候选太阳湾公路应保留（旧数据兼容）");
    // 4d) Task #110 原有行为不回退：无证据候选仍被裁剪
    assert.ok(!facts.includes("大小洞天"), "无证据候选 item_daxiaodongtian 仍应被裁剪");

    // 对照：默认全量 facts 含该候选，证明裁剪来自 active 校验而非数据缺失
    const fullFacts = buildTripFacts(tripB).join("\n");
    assert.ok(
      fullFacts.includes("亚龙湾森林公园"),
      "对照：默认全量 facts 应含亚龙湾森林公园（裁剪仅发生在 guideRelevantOnly 通道）",
    );
    pass("3&4. inactive 独占裁剪 / 共同支撑保留（mention 级+item 级）/ mention 失效回退 / 无主旧证据保留");
  }
}

async function main(): Promise<void> {
  try {
    await runScenarios();
    console.log("\n[verify] Task #147 全部通过 ✓");
  } finally {
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

main().catch((error) => {
  console.error("\n[verify] 验证失败：", error);
  process.exitCode = 1;
});
