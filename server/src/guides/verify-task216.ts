/**
 * Task #216（prompt 瘦身）+ Task #218（pending stop 引用护栏前剥离）验证（全程离线）。
 *
 * Task #216 四个瘦身开关（TripFactsOptions 可选字段，缺省 = F11 全量行为不变）：
 *   1. P0-A（纯函数）：scope 感知 Day 编排裁剪——day scope 时目标天完整展开、
 *      其余天压成单行摘要（约 40-60 字符），非目标天实体 id / 明细不泄漏；
 *   2. P1-D（纯函数）：slimVisitFormat——visit 行省略 point=UUID / mode /
 *      effective / 车程等 planner 不消费字段，保留 id / 名称 / kind / order /
 *      time / locked / purchase / userAdjusted；F11 全量行逐字保留；
 *   3. P0-A（纯函数）：attraction scope——目标景区完整展开（含内部玩法）、
 *      同日其余 visit 精简为 id + 名称、其余天单行摘要；目标引用失效防御性退全量；
 *   4. P0-B（纯函数）：candidateMentionEntityRefs——素材关联候选保持完整格式、
 *      无关候选压成紧凑名册「其余 N 个候选：id 名称、…」；全关联 / 全无关 /
 *      缺省（F11）三种边界；
 *   5. 端到端（trip scope，HTTP /draft + 桩注入）：素材提及 ≥5 → 第七节
 *      optionGroups 完整契约注入 + slim visit 行 + 候选名册 + 全天明细展开；
 *   6. 端到端（attraction scope）：素材含「观光车 + 电动车」可比较信号时第七节注入
 *      完整契约（Task #270 内容感知解锁；无信号时才是「本轮不适用」短声明），
 *      非目标天单行摘要；
 *
 * Task #218（端到端）：
 *   7. 混合草案（plan 半数 assignment 引用 pending stop + 纯 pending
 *      setDuration + 合法 setDuration）→ 违规引用在护栏前被剥离：合法操作零牵连
 *      （applied=2 / rejectedCount=0 / pending 状态与时长不变 / 不挂入大景区），
 *      30% 阈值不再被「必拒项」放大成整批拒绝。
 *
 * 运行：npx tsx server/src/guides/verify-task216.ts
 * 临时行程（server/data）在脚本末尾全部清理，不影响用户既有数据。
 */

import "../env.js";
import assert from "node:assert/strict";
import type { GuideSource, Item, SourceEvidence, Trip, Visit } from "@goplay/shared";
import { createEmptyGuideImageProgress } from "@goplay/shared";
import { buildFixtureSanyaTrip, createFixtureSanyaTrip, tripStore } from "../persistence/store.js";
import { buildTripFacts } from "../ai/prompt.js";
import { resetGuidePlannerDeps, setGuidePlannerDeps } from "./planner.js";
import { guideRoutes } from "./routes.js";

// ===== 基础辅助 =====

function pass(name: string): void {
  console.log(`✓ ${name}`);
}

/** 本脚本创建的临时行程：finally 统一清理（纯函数场景用内存夹具不落盘） */
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

const STUB_NOOP_JSON = JSON.stringify({ operations: [], snippets: [] });

// ===== 素材夹具（端到端场景共用：一篇来源 6 条提及，≥5 触发 P1-C 完整契约） =====

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

function mkSource(
  sourceId: string,
  title: string,
  inputKind: GuideSource["inputKind"],
  evidenceRefs: string[],
  mentionRefs: string[],
  importedAt: string,
): GuideSource {
  return {
    sourceId,
    sourceVersion: 1,
    inputKind,
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

/**
 * 端到端夹具：1 篇 ready 来源（6 条提及）。大小洞天获得该来源证据支撑——
 * 通过 Task #110 的攻略关联裁剪进入 planner 候选区；作为 point 候选不被本轮
 * 提及对齐（MergedPlaceEntityRef 只有 visit/stop），P0-B 应将其压入名册。
 */
async function setupTask216Sources(tripId: string): Promise<void> {
  const trip = await loadTrip(tripId);
  trip.evidences["ev_216"] = {
    evidenceId: "ev_216",
    kind: "note_text",
    noteIndex: 11,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions: [
      mkMention("t1", "蜈支洲岛", "蜈支洲岛环岛观光车20元一圈，电动车30元一小时", "蜈支洲岛", "route_listing", "place"),
      mkMention("t2", "情人桥", "情人桥铁索桥晃，但早上八点前上去人最少", "情人桥", "tip", "place"),
      mkMention("t3", "海滨浴场", "海滨浴场下午退潮可以赶海，注意防滑", "海滨浴场", "tip", "place"),
      mkMention("t4", "观日岩", "观日岩看日落视野最好，一小时足够", "观日岩", "tip", "place"),
      mkMention("t5", "第一市场", "第一市场海鲜加工人均80元，先问价再落座", "第一市场", "comparison", "place"),
      mkMention("t6", "椰子鸡", "椰子鸡小吃店在码头入口左转", "椰子鸡", "tip", "place"),
    ],
  };
  trip.guideSources = {
    src_216: mkSource(
      "src_216",
      "蜈支洲岛实测补充（T216）",
      "text",
      ["ev_216"],
      ["ev_216:t1", "ev_216:t2", "ev_216:t3", "ev_216:t4", "ev_216:t5", "ev_216:t6"],
      "2026-10-19T08:00:00.000Z",
    ),
  };
  trip.itemRegistry["item_daxiaodongtian"] = {
    ...trip.itemRegistry["item_daxiaodongtian"],
    sourceEvidenceRefs: ["ev_216"],
  };
  trip.guideDraftNote = "";
  await tripStore.save(trip);
}

// ===== main =====

async function main(): Promise<void> {
  try {
    await runScenarios();
    console.log("\n[verify] Task #216（prompt 瘦身）+ Task #218（pending 剥离）全部通过 ✓");
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
  // 纯函数场景共用内存夹具（不落盘；结构 = 标准三亚 5 天行程）
  const base = buildFixtureSanyaTrip("trip-verify-216-offline", "2026-10-23T00:00:00.000Z");

  // ---------- 场景 1（P0-A）：day scope —— 目标天全量、其余天单行摘要 ----------
  {
    const facts = buildTripFacts(base, { scope: { kind: "day", dayIndex: 2 }, slimVisitFormat: true }).join("\n");
    assert.ok(facts.includes("Day 2（2026-11-09）departTime=08:30"), "目标天应完整展开（Day 头行含 departTime）");
    assert.ok(facts.includes("id=visit_wzz"), "目标天大景区 visit 展开");
    assert.ok(facts.includes("[stop] id=stop_bridge"), "目标天内部玩法展开（情人桥）");
    assert.ok(facts.includes("[stop] id=stop_rock"), "目标天内部玩法展开（观日岩）");
    assert.ok(facts.includes("Day 1（2026-11-08）无已排到访"), "空非目标天应单行摘要");
    assert.ok(facts.includes("Day 3（2026-11-10）1 个到访：第一市场"), "非目标天应单行摘要（到访数 + 名称）");
    assert.ok(facts.includes("Day 5（2026-11-12）无已排到访"), "返程日单行摘要");
    assert.ok(!facts.includes("id=visit_market"), "非目标天 visit id 不应泄漏");
    assert.ok(!facts.includes("kind=ordinary"), "非目标天明细字段（kind）不应展开");
    const day3Line = facts.split("\n").find((line) => line.startsWith("Day 3（")) ?? "";
    assert.ok(
      [...day3Line].length < 60,
      `非目标天摘要行应约 40-60 字符（实际 ${[...day3Line].length}：${day3Line}）`,
    );
    pass("1. P0-A day scope：目标天全量展开 / 其余天单行摘要（~50 字符）/ 非目标实体 id 不泄漏");
  }

  // ---------- 场景 2（P1-D）：slim visit 行 vs F11 全量行 ----------
  {
    const slimFacts = buildTripFacts(base, { slimVisitFormat: true, includePending: false }).join("\n");
    const slimLine = slimFacts.split("\n").find((line) => line.includes("id=visit_wzz")) ?? "";
    assert.ok(slimLine !== "", "slim 模式应含 visit_wzz 行");
    for (const field of ["kind=large_attraction", "order=0", "locked=false", "purchase=unknown", "userAdjusted=false"]) {
      assert.ok(slimLine.includes(field), `slim 行应保留 planner 消费字段 ${field}（实际：${slimLine}）`);
    }
    for (const dropped of ["point=", "mode=", "effective=", "车程="]) {
      assert.ok(!slimLine.includes(dropped), `slim 行应省略 planner 不消费字段 ${dropped}（实际：${slimLine}）`);
    }
    assert.ok(!slimFacts.includes("【待定加入】"), "planner 模式不含待定加入区块（includePending=false 不变）");

    // F11 对照：缺省 options 保持全量行为（point/mode/车程/待定加入逐字保留）
    const fullFacts = buildTripFacts(base).join("\n");
    const fullLine = fullFacts.split("\n").find((line) => line.includes("id=visit_wzz")) ?? "";
    assert.ok(fullLine.includes("point=item_wzz"), "F11 全量行应保留 point 引用（候选点位排入天所需）");
    assert.ok(fullLine.includes("mode=full_day"), "F11 全量行应保留 mode");
    assert.ok(fullLine.includes("车程=30min(驾车)"), "F11 全量行应保留车程");
    assert.ok(fullFacts.includes("【待定加入】") && fullFacts.includes("stop_snack"), "F11 全量保留待定加入区块");
    pass("2. P1-D slim 行：省略 point/mode/effective/车程；F11 缺省全量行逐字不变");
  }

  // ---------- 场景 3（P0-A）：attraction scope —— 目标景区全量 + 同日精简 + 防御 ----------
  {
    // 内存构造 Day2 双 visit：visit_extra 排在目标景区之前（同日非目标样本）
    const tripAttr = JSON.parse(JSON.stringify(base)) as Trip;
    const visitExtra: Visit = {
      ...tripAttr.visits.visit_market,
      visitId: "visit_extra",
      dayRef: "day_2",
      order: 0,
    };
    tripAttr.visits.visit_extra = visitExtra;
    tripAttr.days.day_2.scheduleVisitRefs = ["visit_extra", "visit_wzz"];
    tripAttr.visits.visit_wzz.order = 1;

    const facts = buildTripFacts(tripAttr, {
      scope: { kind: "attraction", visitId: "visit_wzz" },
      slimVisitFormat: true,
    }).join("\n");
    assert.ok(facts.includes("id=visit_wzz"), "目标景区 visit 完整展开");
    assert.ok(facts.includes("[stop] id=stop_bridge"), "目标景区内部玩法完整展开");
    const extraLine = facts.split("\n").find((line) => line.includes("id=visit_extra")) ?? "";
    assert.equal(extraLine, "  - [visit] id=visit_extra | 第一市场", "同日非目标 visit 精简为 id + 名称");
    assert.ok(facts.includes("Day 3（2026-11-10）1 个到访：第一市场"), "其余天单行摘要");
    assert.ok(!facts.includes("kind=ordinary"), "非目标实体明细不展开（visit_extra brief 行无 kind）");

    // 防御：目标 visit 引用失效 → 整体退回全量展开
    const fallback = buildTripFacts(tripAttr, {
      scope: { kind: "attraction", visitId: "visit_missing" },
      slimVisitFormat: true,
    }).join("\n");
    assert.ok(fallback.includes("kind=ordinary"), "目标引用失效时应防御性退全量（Day3 明细展开）");
    // 退全量 = 天级编排回退（所有天恢复完整 visit 行）；行格式仍由独立的
    // slimVisitFormat 开关控制（两开关正交），故此处恢复的是完整 slim 行（含 kind/order）
    const fallbackExtraLine = fallback.split("\n").find((line) => line.includes("id=visit_extra")) ?? "";
    assert.ok(
      fallbackExtraLine.includes("kind=ordinary"),
      `退全量时同日 visit 恢复完整 slim 行（含 kind，实际：${fallbackExtraLine}）`,
    );
    assert.ok(
      !fallback.split("\n").includes("  - [visit] id=visit_extra | 第一市场"),
      "退全量时同日 visit 不再是 brief 精简行",
    );
    pass("3. P0-A attraction scope：目标景区全量 / 同日非目标 id+名称 / 其余天摘要 / 引用失效退全量");
  }

  // ---------- 场景 4（P0-B）：候选区分层压缩 + 三种边界 ----------
  {
    const tripPool = JSON.parse(JSON.stringify(base)) as Trip;
    const mkCustomItem = (itemId: string, name: string): Item => ({
      ...tripPool.itemRegistry.item_daxiaodongtian,
      itemId,
      name,
    });
    tripPool.itemRegistry.item_extra_a = mkCustomItem("item_extra_a", "南山文化旅游区");
    tripPool.itemRegistry.item_extra_b = mkCustomItem("item_extra_b", "天涯海角");
    tripPool.itemRegistry.item_shell = mkCustomItem("item_shell", "西岛");
    tripPool.visits.visit_shell = { ...tripPool.visits.visit_market, visitId: "visit_shell", pointRef: "item_shell" };
    tripPool.globalCandidateRefs = [
      { kind: "point", id: "item_daxiaodongtian" },
      { kind: "point", id: "item_extra_a" },
      { kind: "point", id: "item_extra_b" },
      { kind: "visit", id: "visit_shell" },
    ];

    // a) 关联候选完整格式 + 无关候选紧凑名册
    const related = new Set(["visit:visit_shell"]);
    const facts = buildTripFacts(tripPool, { candidateMentionEntityRefs: related }).join("\n");
    assert.ok(
      facts.includes("[visit] id=visit_shell | 西岛 | kind=ordinary | 内部玩法 0 项"),
      "素材关联候选应保持完整格式（含 kind / 内部玩法数）",
    );
    assert.ok(
      facts.includes("其余 3 个候选：item_daxiaodongtian 大小洞天、item_extra_a 南山文化旅游区、item_extra_b 天涯海角"),
      "无关候选应压缩为紧凑名册（id 名称 对）",
    );

    // b) 全部关联 → 逐条完整行，无名册行
    const allRelated = new Set([
      "point:item_daxiaodongtian",
      "point:item_extra_a",
      "point:item_extra_b",
      "visit:visit_shell",
    ]);
    const factsAll = buildTripFacts(tripPool, { candidateMentionEntityRefs: allRelated }).join("\n");
    assert.ok(factsAll.includes("[point] id=item_extra_a | 南山文化旅游区 | suggest=120min"), "全关联时候选逐条完整格式");
    assert.ok(!factsAll.includes("其余"), "全关联时不应有名册行");

    // c) 空集合 → 全部名册（候选区压成一行）
    const factsNone = buildTripFacts(tripPool, { candidateMentionEntityRefs: new Set<string>() }).join("\n");
    assert.ok(factsNone.includes("其余 4 个候选："), "空关联集合时候选全部压成名册");
    assert.ok(!factsNone.includes("suggest=120min"), "名册模式不输出 suggest 明细");

    // d) 缺省（F11）→ 全量逐条（行为不变）
    const factsDefault = buildTripFacts(tripPool).join("\n");
    assert.ok(
      factsDefault.includes("[point] id=item_daxiaodongtian | 大小洞天 | suggest=120min"),
      "缺省保持 F11 全量逐条行为",
    );
    assert.ok(!factsDefault.includes("其余"), "缺省无名册行");
    pass("4. P0-B 候选分层：关联完整 / 无关名册（id 名称）/ 全关联、全无关、缺省三边界");
  }

  // ---------- 端到端夹具（HTTP 链路）：一篇来源 6 条提及 ----------
  const e2eTrip = await createFixtureSanyaTrip();
  createdTripIds.push(e2eTrip.tripId);
  await setupTask216Sources(e2eTrip.tripId);

  // ---------- 场景 5（端到端 trip scope）：P1-C 完整契约 + P1-D + P0-B ----------
  {
    armPlanner(STUB_NOOP_JSON);
    const res = await requestJson(`/trips/${e2eTrip.tripId}/draft`, "POST", { scope: { kind: "trip" } });
    assert.equal(res.status, 200, `生成应 200（实际 ${res.status}：${JSON.stringify(res.body)}）`);
    const prompt = capturedPrompts[0] ?? "";
    // P1-C：素材 6 条提及 ≥5 → 第七节完整契约
    assert.ok(prompt.includes("七、optionGroups（实用参考选项组，Task #190）"), "提及 ≥5 时第七节完整契约注入");
    assert.ok(prompt.includes("同一主题下至少 2 个可比较的选项"), "成组硬条件保留");
    // P1-D：planner 恒 slim visit 行
    assert.ok(prompt.includes("id=visit_wzz | 蜈支洲岛 | kind=large_attraction"), "visit 行为 slim 格式");
    assert.ok(!prompt.includes("point=item_wzz"), "slim 行不含 point=UUID");
    assert.ok(!prompt.includes("point=item_market"), "普通景点同样 slim（无 point）");
    // P0-A：trip scope 全天完整展开
    assert.ok(prompt.includes("kind=ordinary"), "trip scope 非目标天明细完整展开");
    // P0-B：未被提及对齐的候选压入名册
    assert.ok(
      prompt.includes("其余 1 个候选：item_daxiaodongtian 大小洞天"),
      "无素材提及对齐的候选应压入紧凑名册（id 名称）",
    );
    pass("5. 端到端 trip scope：第七节完整契约 / slim visit 行 / 候选名册 / 全天明细展开");
  }

  // ---------- 场景 6（端到端 attraction scope）：P1-C 替换声明 + P0-A 摘要 ----------
  {
    armPlanner(STUB_NOOP_JSON);
    const res = await requestJson(`/trips/${e2eTrip.tripId}/draft`, "POST", {
      scope: { kind: "attraction", visitId: "visit_wzz" },
    });
    assert.equal(res.status, 200, `attraction 生成应 200（实际 ${JSON.stringify(res.body)}）`);
    const prompt = capturedPrompts[0] ?? "";
    // Task #270：attraction scope 仍属降级条件，但本夹具 t1 素材含「观光车 + 电动车」
    // 同族两种方式与两个价格 → 内容感知解锁，第七节注入完整契约（不再输出短声明）
    assert.ok(
      prompt.includes("七、optionGroups（实用参考选项组，Task #190）"),
      "attraction scope 但素材含可比较选项信号时应注入完整第七节",
    );
    assert.ok(prompt.includes("同一主题下至少 2 个可比较的选项"), "完整契约的成组硬条件应出现");
    assert.ok(
      !prompt.includes("七、optionGroups：本轮不适用，输出空数组 []"),
      "信号命中时不得再输出降级短声明",
    );
    assert.ok(prompt.includes("八、输出格式："), "第七节之后第八节（输出格式）应完整衔接");
    // scope 指令块保留（既有行为）
    assert.ok(prompt.includes("- 目标景区：蜈支洲岛（visit=visit_wzz）"), "目标景区指令行保留");
    // P0-A：非目标天单行摘要
    assert.ok(prompt.includes("Day 3（2026-11-10）1 个到访：第一市场"), "非目标天单行摘要");
    assert.ok(!prompt.includes("kind=ordinary"), "非目标天明细不展开");
    assert.ok(prompt.includes("[stop] id=stop_bridge"), "目标景区内部玩法完整展开");
    pass("6. 端到端 attraction scope：素材含可比较信号 → 完整第七节 / 非目标天摘要");
  }

  // ---------- 场景 7（Task #218）：混合草案 —— 违规引用护栏前剥离 ----------
  {
    armPlanner(
      JSON.stringify({
        operations: [
          {
            op: "plan",
            scopeRef: { kind: "day", dayIndex: 2 },
            assignments: [
              // 违规：pending stop 不得被 AI 自动挂入（应被剥离，不影响另一条）
              { subjectRef: { kind: "stop", id: "stop_snack" }, containerRef: { kind: "visit", id: "visit_wzz" }, order: 3 },
              // 合法：stop_rock 重排到首位
              { subjectRef: { kind: "stop", id: "stop_rock" }, containerRef: { kind: "visit", id: "visit_wzz" }, order: 0 },
            ],
            reason: "混合：违规挂 pending + 合法改序",
          },
          // 违规：pending stop 时长（原本 G1 逐条拒，30% 阈值放大导致整批拒绝）
          { op: "setDuration", subjectRef: { kind: "stop", id: "stop_snack" }, minutes: 99, reason: "违规改 pending 时长" },
          // 合法：海滨浴场改时长
          { op: "setDuration", subjectRef: { kind: "stop", id: "stop_beach" }, minutes: 100, reason: "海滨浴场加时" },
        ],
        snippets: [],
      }),
    );
    const genRes = await requestJson(`/trips/${e2eTrip.tripId}/draft`, "POST", { scope: { kind: "trip" } });
    assert.equal(genRes.status, 200, `混合草案生成应 200（实际 ${JSON.stringify(genRes.body)}）`);
    const applyRes = await requestJson(`/trips/${e2eTrip.tripId}/draft/apply`, "POST");
    assert.equal(applyRes.status, 200, `应用应 200（实际 ${JSON.stringify(applyRes.body)}）`);

    // 违规引用被剥离（不计 rejected），合法操作零牵连：原本 3 条操作 2 条违规
    //（66% > 30%）会整批拒绝；剥离后只剩 2 条合法操作全部应用
    assert.equal((applyRes.body.applied as unknown[]).length, 2, "合法 plan（滤后单 assignment）与合法 setDuration 应应用");
    assert.equal(applyRes.body.rejectedCount, 0, "违规引用已被护栏前剥离，不进入护栏计数");
    assert.equal(applyRes.body.allRejected, false, "不得标记整批拒绝");
    assert.equal(applyRes.body.rejectSummary, null, "无护栏拒绝时原因摘要应为 null");

    const saved = await loadTrip(e2eTrip.tripId);
    assert.equal(saved.stops.stop_snack?.state, "pending", "pending 玩法状态不得被改动");
    assert.equal(saved.stops.stop_snack?.suggestMinutes, 30, "pending 玩法时长不得被改动（违规 setDuration 被剥离）");
    assert.ok(!saved.visits.visit_wzz?.childStopRefs.includes("stop_snack"), "pending 玩法不得被挂入大景区");
    assert.ok(saved.visits.visit_wzz?.childStopRefs.includes("stop_rock"), "合法 plan 重排不丢内部玩法");
    assert.equal(saved.stops.stop_beach?.suggestMinutes, 100, "合法 setDuration 应照常应用");
    assert.equal(saved.pendingStopRefs.includes("stop_snack"), true, "pending 引用保留在待定加入");
    assert.equal(saved.pendingGuideDraft, undefined, "草案一次性消费");
    pass("7. Task #218 混合草案：plan 部分 assignment 剥离 / 纯 pending op 移除 / 合法操作零牵连 / pending 不变");
  }
}

void main();
