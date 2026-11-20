/**
 * Task #305 回归验证脚本（纯虚拟时钟 + aligner 桩，不依赖 FlyAI / 网络 / 服务端进程）：
 *   S1. 预算充足：全部条目逐条搜索并装配（不截断，行为与既有完全一致）
 *   S2. 预算耗尽截断：搜索前检查剩余预算，耗尽即停止后续搜索、返回已装配的部分结果
 *   S3. 部分结果完整性：截断前已装配的 Item / Visit / mention 完整保留，未装配条目
 *       不产生任何实体（保持未对齐 / 未排状态，走既有兜底语义，不静默丢弃、不编造）
 *   S4. 无需搜索的条目不受预算影响：既有 fliggy Item 复用（跳过搜索）在预算耗尽后仍装配
 *   S5. 所属景区二次搜索也受预算约束：预算耗尽则父级搜索不再触网，当前条目按未命中降级
 *
 * Task #313 增补（并行化：pool 调度器为生产缺省，S1–S5 断言原样保留——桩同步推进
 * 虚拟时钟时，pool 的「认领前预算门」与串行语义判定口径一致）：
 *   S6. pool 有界并发 + 完成乱序下结果按 entry 原索引确定性保序 + 并行预算截断
 *   S7. 单 entry 搜索抛错隔离：该条走未对齐兜底，其余照常装配，errors 按索引序
 *   S8. 单 run 查询级 memo 去重：重复 mention 同查询只触网一次（含归一化键）
 *   S9. ASSEMBLE_CONCURRENCY env 解析：默认 6、合法覆盖、非法回退（同
 *       GUIDE_IMAGE_CONCURRENCY 约定）
 *
 * 运行：npx tsx server/src/ai/verify-task305.ts
 */

import assert from "node:assert/strict";
import type { SourceEvidence, Trip } from "@goplay/shared";
import { SCHEMA_VERSION } from "@goplay/shared";
import type { FlyAIPoi } from "../flyai/client.js";
import {
  ASSEMBLE_CONCURRENCY_DEFAULT,
  ASSEMBLE_CONCURRENCY_MAX,
  assembleEntries,
  normalizeParsedEntry,
  resetSearchPoi,
  resolveAssembleConcurrency,
  setSearchPoi,
  type GuidePoiAligner,
  type ParsedEntry,
  type PoiAlignment,
} from "./assemble.js";

function pass(name: string): void {
  console.log(`✓ ${name}`);
}

// ---- 虚拟时钟 ----
interface VirtualClock {
  now: () => number;
  advance: (ms: number) => void;
}
function virtualClock(startMs = 0): VirtualClock {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

function makePoi(name: string, type: "attraction" | "in_attraction", parent: string | null): ParsedEntry {
  const parsed = normalizeParsedEntry({ name, type, parentAttraction: parent, quote: `${name} 原文`, summary: "笔记提及" });
  assert.ok(parsed !== null, `条目「${name}」应通过结构归一化`);
  return parsed;
}

function makeFliggyPoi(name: string): FlyAIPoi {
  return {
    id: `poi_${name}`,
    name,
    address: `${name} 地址`,
    category: "景点",
    description: null,
    freePoiStatus: null,
    poiLevel: null,
    coords: { lng: 109.5, lat: 18.2 },
    mainPic: null,
    listRank: null,
    ticketInfo: null,
    jumpUrl: null,
  };
}

function makeTrip(): Trip {
  return {
    tripId: "trip_verify_305",
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
}

function makeEvidence(trip: Trip, id: string): SourceEvidence {
  const evidence: SourceEvidence = {
    evidenceId: id,
    kind: "note_text",
    noteIndex: 1,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions: [],
  };
  trip.evidences[id] = evidence;
  return evidence;
}

/**
 * aligner 桩：每次搜索推进虚拟时钟 costMs；命中一个 fliggy POI（除非 namesToMiss 命中）。
 * 记录每次被搜索的名称，供断言「预算耗尽后不再触网」。
 */
function stubAligner(
  clock: VirtualClock,
  costMs: number,
  opts: { miss?: boolean } = {},
): { aligner: GuidePoiAligner; searched: string[] } {
  const searched: string[] = [];
  const aligner: GuidePoiAligner = async (_trip, name) => {
    searched.push(name);
    clock.advance(costMs);
    const alignment: PoiAlignment = opts.miss
      ? { match: null, candidates: [], error: null }
      : { match: makeFliggyPoi(name), candidates: [makeFliggyPoi(name)], error: null };
    return alignment;
  };
  return { aligner, searched };
}

const BUDGET = 120_000;

// ===== S1：预算充足——全部条目逐条搜索并装配（不截断） =====
{
  const clock = virtualClock();
  const trip = makeTrip();
  const evidence = makeEvidence(trip, "ev_s1");
  const { aligner, searched } = stubAligner(clock, 30_000); // 4×30s = 120s，末条搜索前 now=90s<120s
  const entries = [
    makePoi("后海村", "attraction", null),
    makePoi("第一市场", "attraction", null),
    makePoi("西岛", "attraction", null),
    makePoi("情人桥", "attraction", null),
  ];
  const outcome = await assembleEntries(trip, entries, evidence, "ev_s1", [], new Map(), {
    aligner,
    budgetMs: BUDGET,
    now: clock.now,
    logPrefix: "T305",
  });
  assert.equal(searched.length, 4, "预算充足：4 条全部搜索");
  assert.equal(outcome.items.length, 4, "4 条全部装配为 Item");
  assert.deepEqual(outcome.items.map((i) => i.name), ["后海村", "第一市场", "西岛", "情人桥"]);
  assert.equal(evidence.mentions.length, 4, "4 条 mention 全部写入证据");
  pass("S1：预算充足——全部条目逐条搜索并装配（零截断，行为与既有一致）");
}

// ===== S2 + S3：预算耗尽截断 + 部分结果完整性 =====
{
  const clock = virtualClock();
  const trip = makeTrip();
  const evidence = makeEvidence(trip, "ev_s2");
  const { aligner, searched } = stubAligner(clock, 50_000); // 每条 50s
  const entries = [
    makePoi("后海村", "attraction", null),
    makePoi("第一市场", "attraction", null),
    makePoi("西岛", "attraction", null),
    makePoi("情人桥", "attraction", null), // 搜索前 now=150s ≥ 120s → 截断
  ];
  const outcome = await assembleEntries(trip, entries, evidence, "ev_s2", [], new Map(), {
    aligner,
    budgetMs: BUDGET,
    now: clock.now,
    logPrefix: "T305",
  });
  // 截断：只搜索了前 3 条（第 4 条搜索前预算已耗尽）
  assert.equal(searched.length, 3, "预算耗尽：停止后续搜索（第 4 条不再触网）");
  assert.deepEqual(searched, ["后海村", "第一市场", "西岛"]);
  // 部分结果完整性：前 3 条已装配 Item / Visit / mention 完整保留
  assert.equal(outcome.items.length, 3, "返回部分装配结果：前 3 条 Item");
  assert.deepEqual(outcome.items.map((i) => i.name), ["后海村", "第一市场", "西岛"]);
  assert.equal(outcome.newVisitCount, 3, "前 3 条各建一个 Visit 壳");
  assert.equal(evidence.mentions.length, 3, "前 3 条 mention 已落证据");
  // 未装配条目不产生任何实体（不静默丢弃＝不建半成品，不编造＝无情人桥 Item）
  assert.ok(!outcome.items.some((i) => i.name === "情人桥"), "被截断的「情人桥」不得产生 Item");
  assert.ok(!evidence.mentions.some((m) => m.text === "情人桥"), "被截断的「情人桥」不得写 mention");
  assert.equal(Object.keys(trip.itemRegistry).length, 3, "itemRegistry 只含已装配的 3 条");
  pass("S2+S3：预算耗尽截断——停止后续搜索、部分结果完整、未装配条目不产生实体");
}

// ===== S4：无需搜索的条目不受预算影响（既有 fliggy 复用在耗尽后仍装配） =====
{
  const clock = virtualClock();
  const trip = makeTrip();
  // 预置一条既有 fliggy Item：「情人桥」——装配时直接复用并跳过搜索
  trip.itemRegistry["item_existing_bridge"] = {
    itemId: "item_existing_bridge",
    name: "情人桥",
    origin: "fliggy",
    providerId: "poi_existing",
    address: null,
    category: null,
    coords: null,
    suggestMinutes: null,
    mainPic: null,
    ticketInfo: null,
    jumpUrl: null,
    sourceEvidenceRefs: [],
  };
  const evidence = makeEvidence(trip, "ev_s4");
  const { aligner, searched } = stubAligner(clock, 50_000);
  const entries = [
    makePoi("后海村", "attraction", null), // 搜索 → now=50
    makePoi("第一市场", "attraction", null), // 搜索 → now=100
    makePoi("西岛", "attraction", null), // 搜索 → now=150
    makePoi("情人桥", "attraction", null), // 既有 fliggy：无需搜索，预算耗尽后仍复用装配
  ];
  const outcome = await assembleEntries(trip, entries, evidence, "ev_s4", [], new Map(), {
    aligner,
    budgetMs: BUDGET,
    now: clock.now,
    logPrefix: "T305",
  });
  assert.equal(searched.length, 3, "「情人桥」复用既有 fliggy Item，不触网");
  assert.ok(!searched.includes("情人桥"), "既有 fliggy 条目不进入搜索");
  const bridge = outcome.items.find((i) => i.name === "情人桥");
  assert.ok(bridge !== undefined, "预算耗尽后，无需搜索的「情人桥」仍被装配（复用）");
  assert.equal(bridge!.reused, true, "「情人桥」标记为复用既有 Item");
  pass("S4：无需搜索的条目（既有 fliggy 复用）不受预算约束，耗尽后仍装配");
}

// ===== S5：所属景区二次搜索也受预算约束 =====
{
  const clock = virtualClock();
  const trip = makeTrip();
  const evidence = makeEvidence(trip, "ev_s5");
  // 每次搜索 50s；预算 50s——子景点自身搜索后 now=50，父级搜索前预算已耗尽
  const { aligner, searched } = stubAligner(clock, 50_000);
  const entries = [makePoi("过江龙索桥", "in_attraction", "亚龙湾热带天堂森林公园")];
  const outcome = await assembleEntries(trip, entries, evidence, "ev_s5", [], new Map(), {
    aligner,
    budgetMs: 50_000,
    now: clock.now,
    logPrefix: "T305",
  });
  // 只搜索了子景点自身，父级二次搜索被预算拦截（不再触网）
  assert.deepEqual(searched, ["过江龙索桥"], "父级「亚龙湾热带天堂森林公园」二次搜索被预算拦截");
  // 当前条目仍完成装配（子景点 Item + pending Stop），父级按未命中降级为 custom 壳
  assert.equal(outcome.items.length >= 1, true, "子景点已装配为 Item");
  assert.ok(outcome.items.some((i) => i.name === "过江龙索桥"), "子景点「过江龙索桥」已装配");
  assert.equal(outcome.stops.length, 1, "子景点落一个 Stop");
  assert.equal(outcome.stops[0]!.state, "pending", "无所属 Visit 命中 → Stop 落 pending（既有兜底语义）");
  pass("S5：所属景区二次搜索受预算约束——耗尽则不触网，当前条目按未命中降级装配");
}

// ===== S6（Task #313）：pool 有界并发 + 完成乱序下结果按 entry 原索引确定性保序 =====
{
  // (a) 手工门控：concurrency=2，5 条 attraction，搜索按「后启动的先完成」乱序结算
  const names = ["甲", "乙", "丙", "丁", "戊"];
  const gates = new Map<string, { promise: Promise<void>; release: () => void }>();
  const started: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const aligner: GuidePoiAligner = async (_trip, name) => {
    started.push(name);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    gates.set(name, { promise, release });
    await promise;
    inFlight -= 1;
    const poi = makeFliggyPoi(name);
    return { match: poi, candidates: [poi], error: null };
  };
  const trip = makeTrip();
  const evidence = makeEvidence(trip, "ev_s6a");
  const pending = assembleEntries(trip, names.map((n) => makePoi(n, "attraction", null)), evidence, "ev_s6a", [], new Map(), {
    aligner,
    concurrency: 2,
    logPrefix: "T305",
  });
  // 微任务冲刷：pool 认领（concurrency=2）后停在门控 await 上
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.deepEqual(started, ["甲", "乙"], "有界并发：同时只派发 concurrency=2 条搜索（按索引序认领）");
  assert.equal(peak, 2, "在途搜索峰值不得超过并发上限");
  // 乱序结算：乙 先于 甲 完成
  gates.get("乙")!.release();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  gates.get("甲")!.release();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  gates.get("丁")!.release();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  gates.get("丙")!.release();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  gates.get("戊")!.release();
  const outcome = await pending;
  assert.equal(peak, 2, "全程在途峰值 = 2（有界并发不被乱序结算打破）");
  assert.deepEqual(started, ["甲", "乙", "丙", "丁", "戊"], "认领顺序按 entry 索引（与完成顺序无关）");
  // 确定性保序：完成乱序（乙先于甲、丁先于丙），Item / mention 仍按 entry 原索引
  assert.deepEqual(outcome.items.map((i) => i.name), names, "Item 按 entry 原索引保序（完成乱序不影响）");
  assert.deepEqual(evidence.mentions.map((m) => m.text), names, "mention 按 entry 原索引保序");

  // (b) 并行预算截断：虚拟时钟每条搜索 +70s、concurrency=2、预算 120s——
  // 首波 A/B 在 now=0 过预算门派发（在途搜索不被打断，结果照常收下），完成后
  // now=140 ≥ 120：worker 认领前检查剩余预算，C/D 不再派发（保持未对齐）
  const clock = virtualClock();
  const searchedB: string[] = [];
  const alignerB: GuidePoiAligner = async (_trip, name) => {
    searchedB.push(name);
    clock.advance(70_000);
    await Promise.resolve();
    const poi = makeFliggyPoi(name);
    return { match: poi, candidates: [poi], error: null };
  };
  const tripB = makeTrip();
  const evidenceB = makeEvidence(tripB, "ev_s6b");
  const outcomeB = await assembleEntries(
    tripB,
    ["A", "B", "C", "D"].map((n) => makePoi(n, "attraction", null)),
    evidenceB,
    "ev_s6b",
    [],
    new Map(),
    { aligner: alignerB, concurrency: 2, budgetMs: BUDGET, now: clock.now, logPrefix: "T305" },
  );
  assert.deepEqual(searchedB, ["A", "B"], "并行预算截断：预算耗尽后停止派发新搜索");
  assert.deepEqual(outcomeB.items.map((i) => i.name), ["A", "B"], "已完成的部分结果照常返回（索引保序）");
  assert.equal(evidenceB.mentions.length, 2, "未派发条目不写 mention（不建半成品）");
  assert.ok(!outcomeB.items.some((i) => i.name === "C" || i.name === "D"), "被截断条目不得产生 Item");
  pass("S6：pool 有界并发 + 完成乱序下按 entry 索引确定性保序 + 并行预算截断（Task #313）");
}

// ===== S7（Task #313）：单 entry 搜索抛错隔离——该条走未对齐兜底，其余照常 =====
{
  const clock = virtualClock();
  const searched: string[] = [];
  const aligner: GuidePoiAligner = async (_trip, name) => {
    searched.push(name);
    if (name === "乙") throw new Error("boom 网络故障");
    const poi = makeFliggyPoi(name);
    return { match: poi, candidates: [poi], error: null };
  };
  const trip = makeTrip();
  const evidence = makeEvidence(trip, "ev_s7");
  const errors: string[] = [];
  const outcome = await assembleEntries(
    trip,
    ["甲", "乙", "丙"].map((n) => makePoi(n, "attraction", null)),
    evidence,
    "ev_s7",
    errors,
    new Map(),
    { aligner, concurrency: 3, budgetMs: BUDGET, now: clock.now, logPrefix: "T305" },
  );
  assert.deepEqual(searched, ["甲", "乙", "丙"], "单条抛错不中断其余搜索");
  assert.deepEqual(outcome.items.map((i) => i.name), ["甲", "乙", "丙"], "抛错条目仍装配（未对齐兜底），保序");
  const failed = outcome.items.find((i) => i.name === "乙");
  assert.equal(failed!.origin, "custom", "抛错条目按未命中降级 custom（绝不伪造供应商字段）");
  assert.equal(failed!.matched, false, "抛错条目 matched=false");
  assert.equal(outcome.items.find((i) => i.name === "甲")!.origin, "fliggy", "其余条目照常对齐");
  assert.deepEqual(errors, ["「乙」搜索暂不可用，待飞猪匹配"], "errors 只含失败条目（既有降级文案），按索引序");
  pass("S7：单 entry 搜索抛错隔离——该条未对齐兜底、其余照常、errors 确定（Task #313）");
}

// ===== S8（Task #313）：单 run 查询级 memo 去重——重复 mention 同查询只触网一次 =====
{
  let calls = 0;
  const queries: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  setSearchPoi(async (query) => {
    calls += 1;
    queries.push(query);
    await gate; // 挂在途窗口：并行下重复查询必须共享同一在途 Promise
    return { normalized: [makeFliggyPoi("后海村")] };
  });
  try {
    const trip = makeTrip();
    const evidence = makeEvidence(trip, "ev_s8");
    // 三条重复 mention：同名 + 归一化等价（多余空白）——查询键归一化后同串
    const entries = [
      makePoi("后海村", "attraction", null),
      makePoi("后海村", "attraction", null),
      makePoi("后海村  ", "attraction", null),
    ];
    const pending = assembleEntries(trip, entries, evidence, "ev_s8", [], new Map(), {
      concurrency: 3,
      logPrefix: "T305",
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(calls, 1, "并行在途窗口内重复查询只触网一次（memo 命中）");
    release();
    const outcome = await pending;
    assert.deepEqual(queries, ["三亚 后海村"], "只发出唯一归一化查询");
    assert.equal(outcome.items.length, 1, "重复 mention 收敛为同一 Item");
    assert.equal(outcome.items[0]!.origin, "fliggy", "Item 正常对齐");
    assert.equal(evidence.mentions.length, 3, "每条 mention 照常留痕（去重只作用于触网）");
  } finally {
    resetSearchPoi();
  }
  pass("S8：单 run 查询级 memo 去重——重复 mention 同查询只触网一次（Task #313）");
}

// ===== S9（Task #313）：ASSEMBLE_CONCURRENCY env 解析（同 GUIDE_IMAGE_CONCURRENCY 约定） =====
{
  const saved = process.env.ASSEMBLE_CONCURRENCY;
  try {
    assert.equal(ASSEMBLE_CONCURRENCY_DEFAULT, 6, "并发默认值应为 6");
    assert.equal(ASSEMBLE_CONCURRENCY_MAX, 8, "并发安全上限应为 8");
    delete process.env.ASSEMBLE_CONCURRENCY;
    assert.equal(resolveAssembleConcurrency(), 6, "env 未设置 → 默认 6");
    process.env.ASSEMBLE_CONCURRENCY = "";
    assert.equal(resolveAssembleConcurrency(), 6, "env 空串 → 默认 6");
    process.env.ASSEMBLE_CONCURRENCY = "3";
    assert.equal(resolveAssembleConcurrency(), 3, "合法值 3 生效");
    process.env.ASSEMBLE_CONCURRENCY = "8";
    assert.equal(resolveAssembleConcurrency(), 8, "上限 8 生效");
    process.env.ASSEMBLE_CONCURRENCY = "99";
    assert.equal(resolveAssembleConcurrency(), 6, "超上限 99 → 回退默认 6");
    process.env.ASSEMBLE_CONCURRENCY = "0";
    assert.equal(resolveAssembleConcurrency(), 6, "0 → 回退默认 6");
    process.env.ASSEMBLE_CONCURRENCY = "abc";
    assert.equal(resolveAssembleConcurrency(), 6, "非数字 → 回退默认 6");
    process.env.ASSEMBLE_CONCURRENCY = "2.5";
    assert.equal(resolveAssembleConcurrency(), 6, "非整数 → 回退默认 6");
  } finally {
    if (saved === undefined) delete process.env.ASSEMBLE_CONCURRENCY;
    else process.env.ASSEMBLE_CONCURRENCY = saved;
  }
  pass("S9：ASSEMBLE_CONCURRENCY env 解析——默认 6 / 合法覆盖 / 非法回退（Task #313）");
}

console.log("\n===== Task #305 verify 全部通过 =====");
