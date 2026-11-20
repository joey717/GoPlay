/**
 * Task #176（草案自动 scope + 岛内空态隐藏）服务端确定性验证（全程离线）。
 *
 * setGuidePlannerDeps 桩注入 callPlanner，全程不触网、不调用真实百炼。夹具：
 * 基础三亚行程 + 来源 A（ev_note_1：m1 → 蜈支洲岛本体显式对齐，m2-m4 → 岛内
 * stops）+ 来源 B（ev_note_b：b1 → 第一市场、b2 → 大小洞天（新增 Day3 普通
 * Visit）、b3 后海村未对齐提及）。四种证据形态覆盖自动判定的全部输入组合。
 *
 * 场景清单（确定性回归，规则优先级：日期指令 > 入口上下文 > 证据归属 > 整程）：
 *   1. 老调用方兼容：body { scope } 显式携带 → 直接使用（自动判定不介入），
 *      draft.scope 持久化显式值，sourceMode 缺省归一 "all"；
 *   2. 显式 scope 与 entryContext 并存 → 显式 scope 赢（entryContext 被忽略）；
 *   3. 缺省 scope + global 上下文 + 证据跨天（Day2 蜈支洲岛 + Day3 两实体）→ 整程；
 *   4. 完全空 body（无 scope / entryContext / note）→ 200 整程（不猜、不炸）；
 *   5. entryContext 形状校验：非法 type / day 缺 dayIndex / attraction 空 visitId → 400；
 *   6. 显式 scope 非法（dayIndex 越界）→ 400（校验兜底不变）；
 *   7. 单天 Day 指令 → 锁定该天（指令进 prompt / 元数据持久化 / requirementChecks met）；
 *   8. 跨天 Day 指令 → 整程（指令优先级高于入口上下文：入口 day 2 仍判 trip）；
 *   9. 指令错误回归：缺数字 → 400 GUIDE_DAY_NUMBER_REQUIRED；越界 → 400
 *      GUIDE_DAY_INDEX_OUT_OF_RANGE（scope 缺省不改变指令解析时序）；
 *  10. 入口上下文 day → 单天（优先于证据归属，证据跨天本应判 trip）；
 *  11. 入口上下文 attraction（有效大景区）→ 景区内部（prompt 景区指令行）；
 *  12. 入口上下文无效（非大景点 / 悬空 visitId / day 越界）→ 静默降级证据归属
 *      （形状合法但业务无效不 400，由 resolveDraftScope 降级）；
 *  13. 证据全在单一大景区（来源 A）→ 景区内部；
 *  14. 证据单天多实体 + 未对齐提及（来源 B：b1/b2 对齐 Day3 两实体，b3 未对齐）
 *      → 单天（未对齐提及素材照常进 prompt 但不参与收敛、不扩大范围）；
 *  15. 全部模式证据跨天 → 整程 + draft.scope 持久化。
 *
 * 每个行程独立夹具（note 会在 guideDraftNote 残留，跨场景隔离避免串扰）。
 * 岛内空态隐藏（目标一）属 web 渲染层，由 VisitCard.test.tsx 覆盖。
 *
 * 运行：npx tsx server/src/guides/verify-task176.ts
 * 临时行程（server/data）在脚本末尾全部清理，不影响用户既有数据。
 */

import "../env.js";
import assert from "node:assert/strict";
import type { GuideSource, PendingGuideDraft, SourceEvidence, Trip } from "@goplay/shared";
import { createEmptyGuideImageProgress } from "@goplay/shared";
import { createFixtureSanyaTrip, tripStore } from "../persistence/store.js";
import { resetGuidePlannerDeps, setGuidePlannerDeps } from "./planner.js";
import { guideRoutes } from "./routes.js";

// ===== 基础辅助 =====

function pass(name: string): void {
  console.log(`✓ ${name}`);
}

/** 本脚本创建的临时行程：finally 统一清理 */
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

/** 空操作桩：scope 判定不依赖 AI 输出，空草案最干净 */
const EMPTY_DRAFT_JSON = JSON.stringify({ operations: [], snippets: [] });

/** 各来源提及原文（prompt 素材断言判据） */
const M1_QUOTE = "Day2 一整天留给蜈支洲岛，记得早去避堵";
const B1_QUOTE = "第一市场海鲜加工首选四川小胡子，嫌贵就去旁边的林姐";
const B2_QUOTE = "大小洞天下午四点后免门票，别白排队";
const B3_QUOTE = "后海村冲浪点浪小，适合新手第一节体验课";

// ===== 夹具 =====

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
    claimKind: "tip",
    targetScope: "place",
    firsthand: true,
  };
}

function mkSource(
  sourceId: string,
  title: string,
  evidenceRefs: string[],
  mentionRefs: string[],
  importedAt: string,
): GuideSource {
  return {
    sourceId,
    sourceVersion: 1,
    inputKind: "text",
    title,
    active: true,
    status: "ready",
    evidenceRefs,
    mentionRefs,
    imageProgress: createEmptyGuideImageProgress(),
    importedAt,
    updatedAt: importedAt,
  };
}

const T_A = "2026-10-19T08:00:00.000Z";
const T_B = "2026-10-19T09:00:00.000Z";
const SRC_A = "src_island_a";
const SRC_B = "src_city_b";

/**
 * Task #176 夹具（在标准三亚行程上增补）：
 * - 来源 A（ev_note_1，历史）：m1 显式对齐 visit_wzz（大景区本体，Day2）；
 *   m2/m3/m4 由基础夹具对齐到岛内 stops（情人桥 / 海滨浴场 / 观日岩，均在 visit_wzz 内）；
 * - 来源 B（ev_note_b，历史）：b1 对齐 visit_market（Day3 普通景点）、
 *   b2 对齐 visit_dxc（新增 Day3 普通景点「大小洞天」，复用基础夹具 item）、
 *   b3（后海村）刻意不对齐——未对齐提及进素材但不参与 scope 收敛；
 * - guideDraftNote 置空（note 不传时沿用，保证无指令场景干净）。
 */
async function setupTask176Fixture(tripId: string): Promise<void> {
  const trip = await loadTrip(tripId);
  trip.visits.visit_wzz.sourceMentionRefs = ["ev_note_1:m1"];
  trip.visits.visit_market.sourceMentionRefs = ["ev_note_b:b1"];

  trip.evidences["ev_note_b"] = {
    evidenceId: "ev_note_b",
    kind: "note_text",
    noteIndex: 2,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions: [
      mkMention("b1", "第一市场", B1_QUOTE, "第一市场"),
      mkMention("b2", "大小洞天", B2_QUOTE, "大小洞天"),
      mkMention("b3", "后海村", B3_QUOTE, "后海村"),
    ],
  };
  trip.guideSources = {
    [SRC_A]: mkSource(
      SRC_A,
      "小岛两天一夜攻略（A）",
      ["ev_note_1"],
      ["ev_note_1:m1", "ev_note_1:m2", "ev_note_1:m3", "ev_note_1:m4"],
      T_A,
    ),
    [SRC_B]: mkSource(
      SRC_B,
      "市区与大小洞天攻略（B）",
      ["ev_note_b"],
      ["ev_note_b:b1", "ev_note_b:b2", "ev_note_b:b3"],
      T_B,
    ),
  };

  // Day3 第二个实体（普通景点）：让来源 B 的证据可归属「同一天的不同实体」
  trip.visits["visit_dxc"] = {
    visitId: "visit_dxc",
    dayRef: "day_3",
    pointRef: "item_daxiaodongtian",
    kind: "ordinary",
    visitMode: "custom",
    order: 1,
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
    sourceMentionRefs: ["ev_note_b:b2"],
    purchaseState: "unknown",
    locked: false,
    userAdjusted: false,
    removedFrom: null,
    removedAt: null,
  };
  trip.days.day_3.scheduleVisitRefs = [...trip.days.day_3.scheduleVisitRefs, "visit_dxc"];

  trip.guideDraftNote = "";
  await tripStore.save(trip);
}

/** 生成请求后断言响应 scope 与草案持久化 scope 一致，返回响应体 */
async function expectScope(
  tripId: string,
  expected: { kind: string; dayIndex?: number; visitId?: string },
  label: string,
): Promise<Record<string, unknown>> {
  const saved = await loadTrip(tripId);
  const draft = saved.pendingGuideDraft as PendingGuideDraft | undefined;
  assert.ok(draft !== undefined, `${label}：草案应已保存`);
  assert.deepEqual(draft.scope, expected, `${label}：draft.scope 应持久化解析后的值`);
  return { draftScope: draft.scope };
}

// ===== main =====

async function main(): Promise<void> {
  try {
    await runScenarios();
    console.log("\n[verify] Task #176（草案自动 scope 判定）全部通过 ✓");
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
  // ---------- 主体夹具（显式 scope 兼容 + 缺省跨天 + 形状校验） ----------
  const main = await createFixtureSanyaTrip();
  createdTripIds.push(main.tripId);
  await setupTask176Fixture(main.tripId);

  // ---------- 场景 1：老调用方显式 scope（自动判定不介入） ----------
  {
    armPlanner(EMPTY_DRAFT_JSON);
    const res = await requestJson(`/trips/${main.tripId}/draft`, "POST", {
      scope: { kind: "day", dayIndex: 2 },
    });
    assert.equal(res.status, 200, `显式 scope 应 200（实际 ${res.status}：${JSON.stringify(res.body)}）`);
    assert.equal(res.body.sourceMode, "all", "缺省 sourceMode 应归一 all（旧契约不变）");
    assert.equal(res.body.sourceCount, 2, "全部模式可用来源 = A + B");
    assert.deepEqual(res.body.scope, { kind: "day", dayIndex: 2 }, "响应应回传显式 scope（不被自动判定改写）");
    const prompt = capturedPrompts[0] ?? "";
    assert.ok(prompt.includes("单日优化：只输出影响 Day 2"), "显式 day scope 应有单日指令行");
    assert.ok(!prompt.includes("全程优化"), "day scope 不应出现全程指令");
    await expectScope(main.tripId, { kind: "day", dayIndex: 2 }, "场景1");
    pass("1. 老调用方显式 scope：直接使用（day 2）/ prompt 单日指令 / draft.scope 持久化 / sourceMode 归一 all");
  }

  // ---------- 场景 2：显式 scope 与 entryContext 并存 → 显式赢 ----------
  {
    armPlanner(EMPTY_DRAFT_JSON);
    const res = await requestJson(`/trips/${main.tripId}/draft`, "POST", {
      scope: { kind: "trip" },
      entryContext: { type: "day", dayIndex: 3 },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.scope, { kind: "trip" }, "显式 scope 优先，entryContext 被忽略");
    const prompt = capturedPrompts[0] ?? "";
    assert.ok(prompt.includes("全程优化"), "显式 trip scope 应有全程指令");
    assert.ok(!prompt.includes("只输出影响 Day 3"), "入口上下文不得改写显式 scope");
    pass("2. 显式 scope + entryContext 并存：显式 scope 赢（旧调用方与新前端误并发时行为确定）");
  }

  // ---------- 场景 3：缺省 + global 上下文 + 证据跨天 → 整程 ----------
  {
    armPlanner(EMPTY_DRAFT_JSON);
    const res = await requestJson(`/trips/${main.tripId}/draft`, "POST", {
      entryContext: { type: "global" },
    });
    assert.equal(res.status, 200, `缺省 scope 应 200（实际 ${JSON.stringify(res.body)}）`);
    assert.deepEqual(res.body.scope, { kind: "trip" }, "证据跨天（Day2 景区 + Day3 两实体）应判整程");
    const prompt = capturedPrompts[0] ?? "";
    assert.ok(prompt.includes("全程优化"), "整程应有全程指令");
    assert.ok(!prompt.includes("只输出影响 Day"), "不应出现单日指令");
    assert.ok(!prompt.includes("大景区内部补充"), "不应出现景区内部指令");
    assert.ok(!prompt.includes("目标景区："), "不应出现目标景区行");
    pass("3. 缺省 + global 上下文：证据跨天不可靠收敛 → 整程（不凭短词模糊扩大）");
  }

  // ---------- 场景 4：完全空 body → 整程 ----------
  {
    armPlanner(EMPTY_DRAFT_JSON);
    const res = await requestJson(`/trips/${main.tripId}/draft`, "POST", {});
    assert.equal(res.status, 200, "空 body（无 scope / entryContext）应 200");
    assert.deepEqual(res.body.scope, { kind: "trip" });
    pass("4. 完全空 body：200 且整程回退（不猜、不炸）");
  }

  // ---------- 场景 5-6：entryContext 形状校验 + 显式 scope 越界（全部 400，不调 AI） ----------
  {
    armPlanner();
    const badType = await requestJson(`/trips/${main.tripId}/draft`, "POST", {
      entryContext: { type: "hour" },
    });
    assert.equal(badType.status, 400, "entryContext 非法 type 应 400");
    assert.equal(badType.body.code, "INVALID_REQUEST");

    const noDayIndex = await requestJson(`/trips/${main.tripId}/draft`, "POST", {
      entryContext: { type: "day" },
    });
    assert.equal(noDayIndex.status, 400, "entryContext day 缺 dayIndex 应 400");
    assert.equal(noDayIndex.body.code, "INVALID_REQUEST");

    const blankVisitId = await requestJson(`/trips/${main.tripId}/draft`, "POST", {
      entryContext: { type: "attraction", visitId: "  " },
    });
    assert.equal(blankVisitId.status, 400, "entryContext attraction 空 visitId 应 400");
    assert.equal(blankVisitId.body.code, "INVALID_REQUEST");

    const scopeOutOfRange = await requestJson(`/trips/${main.tripId}/draft`, "POST", {
      scope: { kind: "day", dayIndex: 99 },
    });
    assert.equal(scopeOutOfRange.status, 400, "显式 scope dayIndex 越界应 400（校验兜底不变）");
    assert.equal(scopeOutOfRange.body.code, "INVALID_REQUEST");

    assert.equal(capturedPrompts.length, 0, "全部 400 场景不得调用 planner");
    pass("5. 形状校验：entryContext 非法 type / day 缺 dayIndex / attraction 空 visitId / 显式 scope 越界 → 400 且不调 AI");
  }

  // ---------- 指令夹具（独立行程：note 会残留 guideDraftNote，跨场景隔离） ----------
  const dayTrip = await createFixtureSanyaTrip();
  createdTripIds.push(dayTrip.tripId);
  await setupTask176Fixture(dayTrip.tripId);

  // ---------- 场景 7：单天 Day 指令 → 锁定该天 ----------
  {
    armPlanner(EMPTY_DRAFT_JSON);
    const res = await requestJson(`/trips/${dayTrip.tripId}/draft`, "POST", {
      entryContext: { type: "global" },
      note: "DAY3去第一市场",
    });
    assert.equal(res.status, 200, `单天指令应 200（实际 ${JSON.stringify(res.body)}）`);
    assert.deepEqual(res.body.scope, { kind: "day", dayIndex: 3 }, "单天指令应锁定该天（优先于证据归属）");
    const prompt = capturedPrompts[0] ?? "";
    assert.ok(prompt.includes("单日优化：只输出影响 Day 3（2026-11-10）"), "指令锁定天应有单日指令行（含日期）");
    assert.ok(prompt.includes("【日期硬性指令】"), "指令块应进 prompt");
    const directives = res.body.directives as Array<{ dayIndex: number }>;
    assert.equal(directives.length, 1, "应解析出 1 条日期指令");
    assert.equal(directives[0]?.dayIndex, 3);
    const checks = res.body.requirementChecks as Array<{ status: string }>;
    assert.equal(checks[0]?.status, "met", "第一市场已在 Day3：指令满足");
    await expectScope(dayTrip.tripId, { kind: "day", dayIndex: 3 }, "场景7");
    pass("7. 单天 Day 指令：锁定 Day3（指令 > 证据归属）/ 指令块进 prompt / 元数据持久化 / requirementChecks met");
  }

  // ---------- 场景 8：跨天 Day 指令 → 整程（指令优先级高于入口上下文） ----------
  {
    armPlanner(EMPTY_DRAFT_JSON);
    const res = await requestJson(`/trips/${dayTrip.tripId}/draft`, "POST", {
      entryContext: { type: "day", dayIndex: 2 },
      note: "DAY2去蜈支洲岛，DAY3去第一市场",
    });
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.scope,
      { kind: "trip" },
      "跨多天明确日期应整程（入口 day 2 上下文不得覆盖指令）",
    );
    const prompt = capturedPrompts[0] ?? "";
    assert.ok(prompt.includes("全程优化"), "整程应有全程指令");
    assert.ok(!prompt.includes("只输出影响 Day 2（"), "不得退化单日指令");
    const directives = res.body.directives as Array<{ dayIndex: number }>;
    assert.equal(directives.length, 2, "应解析出 2 条日期指令");
    pass("8. 跨天 Day 指令：整程（跨多个明确日期才降级；指令优先级 > 入口上下文）");
  }

  // ---------- 场景 9：指令错误回归（scope 缺省不改变指令解析时序） ----------
  {
    armPlanner();
    const noNumber = await requestJson(`/trips/${dayTrip.tripId}/draft`, "POST", {
      entryContext: { type: "global" },
      note: "DAY安排后海",
    });
    assert.equal(noNumber.status, 400, "指令缺数字应 400");
    assert.equal(noNumber.body.code, "GUIDE_DAY_NUMBER_REQUIRED");

    const outOfRange = await requestJson(`/trips/${dayTrip.tripId}/draft`, "POST", {
      entryContext: { type: "global" },
      note: "DAY9去后海",
    });
    assert.equal(outOfRange.status, 400, "指令越界应 400");
    assert.equal(outOfRange.body.code, "GUIDE_DAY_INDEX_OUT_OF_RANGE");
    assert.equal(capturedPrompts.length, 0, "指令错误不得调用 planner");
    pass("9. 指令错误回归：缺数字 GUIDE_DAY_NUMBER_REQUIRED / 越界 GUIDE_DAY_INDEX_OUT_OF_RANGE（时序不变）");
  }

  // ---------- 入口上下文夹具 ----------
  const contextTrip = await createFixtureSanyaTrip();
  createdTripIds.push(contextTrip.tripId);
  await setupTask176Fixture(contextTrip.tripId);

  // ---------- 场景 10：入口上下文 day → 单天（优先于证据归属） ----------
  {
    armPlanner(EMPTY_DRAFT_JSON);
    const res = await requestJson(`/trips/${contextTrip.tripId}/draft`, "POST", {
      entryContext: { type: "day", dayIndex: 2 },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.scope, { kind: "day", dayIndex: 2 }, "入口 day 上下文应优先于证据归属（证据跨天本应判 trip）");
    const prompt = capturedPrompts[0] ?? "";
    assert.ok(prompt.includes("单日优化：只输出影响 Day 2"), "应有单日指令行");
    pass("10. 入口上下文 day：单天（从 Day2 打开优先局部，证据归属让位）");
  }

  // ---------- 场景 11：入口上下文 attraction（有效大景区）→ 景区内部 ----------
  {
    armPlanner(EMPTY_DRAFT_JSON);
    const res = await requestJson(`/trips/${contextTrip.tripId}/draft`, "POST", {
      entryContext: { type: "attraction", visitId: "visit_wzz" },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.scope, { kind: "attraction", visitId: "visit_wzz" }, "入口 attraction 上下文应判景区内部");
    const prompt = capturedPrompts[0] ?? "";
    assert.ok(prompt.includes("大景区内部补充"), "应有景区内部指令");
    assert.ok(prompt.includes("目标景区：蜈支洲岛（visit=visit_wzz）"), "应指名目标景区");
    assert.ok(!prompt.includes("只输出影响 Day"), "不应出现单日指令");
    await expectScope(contextTrip.tripId, { kind: "attraction", visitId: "visit_wzz" }, "场景11");
    pass("11. 入口上下文 attraction：景区内部（prompt 景区指令 + 目标景区行 + draft 持久化）");
  }

  // ---------- 场景 12：入口上下文业务无效 → 静默降级证据归属 ----------
  {
    // 12a. attraction 指向非大景点（visit_market 是 ordinary）
    armPlanner(EMPTY_DRAFT_JSON);
    const notLarge = await requestJson(`/trips/${contextTrip.tripId}/draft`, "POST", {
      entryContext: { type: "attraction", visitId: "visit_market" },
      sourceMode: "selected",
      selectedSourceIds: [SRC_A],
    });
    assert.equal(notLarge.status, 200, `非大景点上下文应静默降级（实际 ${JSON.stringify(notLarge.body)}）`);
    assert.deepEqual(
      notLarge.body.scope,
      { kind: "attraction", visitId: "visit_wzz" },
      "降级后按证据归属：来源 A 全部实体在蜈支洲岛内 → 景区内部",
    );

    // 12b. attraction 悬空 visitId
    armPlanner(EMPTY_DRAFT_JSON);
    const ghostVisit = await requestJson(`/trips/${contextTrip.tripId}/draft`, "POST", {
      entryContext: { type: "attraction", visitId: "visit_not_exist" },
      sourceMode: "selected",
      selectedSourceIds: [SRC_A],
    });
    assert.equal(ghostVisit.status, 200, "悬空 visitId 上下文应静默降级（形状合法，业务无效不 400）");
    assert.deepEqual(ghostVisit.body.scope, { kind: "attraction", visitId: "visit_wzz" });

    // 12c. day 越界（dayIndex 99：形状合法，业务越界）
    armPlanner(EMPTY_DRAFT_JSON);
    const dayOutOfRange = await requestJson(`/trips/${contextTrip.tripId}/draft`, "POST", {
      entryContext: { type: "day", dayIndex: 99 },
      sourceMode: "selected",
      selectedSourceIds: [SRC_A],
    });
    assert.equal(dayOutOfRange.status, 200, "越界 day 上下文应静默降级");
    assert.deepEqual(dayOutOfRange.body.scope, { kind: "attraction", visitId: "visit_wzz" });
    pass("12. 入口上下文业务无效（非大景点 / 悬空 / day 越界）：静默降级证据归属（不 400、不猜）");
  }

  // ---------- 证据归属夹具 ----------
  const evidenceTrip = await createFixtureSanyaTrip();
  createdTripIds.push(evidenceTrip.tripId);
  await setupTask176Fixture(evidenceTrip.tripId);

  // ---------- 场景 13：证据全在单一大景区 → 景区内部 ----------
  {
    armPlanner(EMPTY_DRAFT_JSON);
    const res = await requestJson(`/trips/${evidenceTrip.tripId}/draft`, "POST", {
      sourceMode: "selected",
      selectedSourceIds: [SRC_A],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.scope,
      { kind: "attraction", visitId: "visit_wzz" },
      "来源 A 证据（m1 大景区本体 + m2-m4 岛内 stops）全在蜈支洲岛 → 景区内部",
    );
    const prompt = capturedPrompts[0] ?? "";
    assert.ok(prompt.includes("大景区内部补充"), "应有景区内部指令");
    assert.ok(prompt.includes(M1_QUOTE), "来源 A 素材应进 prompt");
    await expectScope(evidenceTrip.tripId, { kind: "attraction", visitId: "visit_wzz" }, "场景13");
    pass("13. 证据归属：全在单一大景区 → 景区内部（来源 A 局部）");
  }

  // ---------- 场景 14：证据单天多实体 + 未对齐提及 → 单天 ----------
  {
    armPlanner(EMPTY_DRAFT_JSON);
    const res = await requestJson(`/trips/${evidenceTrip.tripId}/draft`, "POST", {
      sourceMode: "selected",
      selectedSourceIds: [SRC_B],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.scope,
      { kind: "day", dayIndex: 3 },
      "来源 B 证据（b1 第一市场 + b2 大小洞天，均在 Day3）→ 单天；b3 未对齐不参与收敛",
    );
    const prompt = capturedPrompts[0] ?? "";
    assert.ok(prompt.includes("单日优化：只输出影响 Day 3"), "应有单日指令行");
    // 素材始终全集：未对齐提及照常进 prompt，但 scope 不因它扩大
    assert.ok(prompt.includes(B3_QUOTE), "未对齐提及（后海村）素材应照常进 prompt");
    assert.ok(prompt.includes(B1_QUOTE) && prompt.includes(B2_QUOTE), "对齐提及素材应在 prompt");
    await expectScope(evidenceTrip.tripId, { kind: "day", dayIndex: 3 }, "场景14");
    pass("14. 证据归属：单天多实体 → 单天（未对齐提及进素材但不阻止收敛、不扩大范围）");
  }

  // ---------- 场景 15：全部模式证据跨天 → 整程 + 持久化 ----------
  {
    armPlanner(EMPTY_DRAFT_JSON);
    const res = await requestJson(`/trips/${evidenceTrip.tripId}/draft`, "POST", {});
    assert.equal(res.status, 200);
    assert.equal(res.body.sourceCount, 2, "全部模式 = A + B 两篇");
    assert.deepEqual(res.body.scope, { kind: "trip" }, "A（Day2 景区）+ B（Day3 两实体）跨天 → 整程");
    await expectScope(evidenceTrip.tripId, { kind: "trip" }, "场景15");
    pass("15. 证据归属：跨天发散 → 整程回退 + draft.scope 持久化");
  }

  // 收尾一致性：各行程结构未被破坏
  const finalMain = await loadTrip(main.tripId);
  assert.ok(finalMain.visits.visit_wzz !== undefined, "主体行程结构应保持完整");
}

main().catch((error) => {
  console.error("\n[verify] 验证失败：", error);
  process.exitCode = 1;
});
