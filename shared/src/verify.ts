/**
 * Task #48 shared 替换验证脚本 —— 覆盖 PRD v1.1 父子 POI 核心模型的关键行为。
 *
 * 运行：npx tsx src/verify.ts（shared 目录下）
 *
 * 覆盖场景（任务 #48 范围 E）：
 *  1. fixture 自检：schemaVersion 为数字 2（rev2 契约）、一致性通过；
 *  2. 普通 Visit 排序（move 同天改序 + 时间轴重排）；
 *  3. 大景区 + 3 Stop（child 汇总时长 / alternate 不参与 / 大景区只出现一次）；
 *  4. Stop 父内排序（move stop 父内重排）；
 *  5. Stop 移入 alternate 并保留撤销所需信息（removedFromOrder / transfer 回 child 恢复）；
 *  6. Visit 跨天携带子项（transfer day→day，child/alternate 整组随行）；
 *  7. 非法 Stop 跨天 / setPurchase / lock / setTime 被拒（guards + 执行器双通道）；
 *  8. plan 保序（未提及项按原相对顺序追加）；
 *  9. locked / bought 保护（G3 按 actor 分流；remove 一律拒绝）；
 * 10. 30% 整批拒绝阈值（恰好 30% 不触发，严格大于才触发）；
 * 11. 引用一致性（validateConsistency 检测悬空 / 双容器 / 状态错位）；
 * 12. timeline 大景区只算一次交通（externalLeg 只到景区入口；未知沿链传播到新锚点）；
 * 13. needsProposal 确认分流（remove 默认分流，confirmed 二次下发执行）；
 * 14. G4 重排保护（userAdjusted 项被 plan 悄悄省略 → warning，不拒单）；
 * 15. plan 从全局候选区引入 point（确定性 visitId、候选引用解除）。
 * 16. classify 成功转换（Task #122）：Visit→Stop、证据/snippets 迁移、旧引用清理、时间轴汇总；
 * 17. classify 幂等重放：单条重放与同批双发不重复创建；
 * 18. classify 弱证据拒绝：无引用/不可解析/单侧证据（护栏+执行器双通道）；
 * 19. classify 锁定/已购红线：来源双通道拒绝，目标按通道分流；
 * 20. classify 目标/来源不合法：非大景区/非普通景点/缺失实体/越界；
 * 21. classify 上线后 pending 护栏无回归；
 * 22. classify AI 通道强证据直接归类（不进 needsProposal，不写 userAdjusted）；
 * 23. classify 候选区 Visit：globalPool 引用清理与 toOrder 插入重排。
 */

import assert from "node:assert/strict";
import type { Item, Operation, Stop, Trip, Visit } from "./types/index.js";
import { SCHEMA_VERSION } from "./types/index.js";
import { applyOps, deepClone } from "./operations/index.js";
import { checkGuards, validateOperation } from "./guards/index.js";
import { recomputeDayTimeline } from "./timeline/index.js";
import { validateConsistency } from "./consistency/index.js";
import { BATCH_REJECTION_GUIDANCE, describeRejection } from "./rejections/index.js";

// ===== fixtures =====

function makeItem(itemId: string, name: string, suggestMinutes: number | null): Item {
  return {
    itemId,
    name,
    origin: "fliggy",
    providerId: `fp_${itemId}`,
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

function makeVisit(visitId: string, pointRef: string, kind: "ordinary" | "large_attraction"): Visit {
  return {
    visitId,
    dayRef: null,
    pointRef,
    kind,
    visitMode: kind === "large_attraction" ? "full_day" : "custom",
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
    purchaseState: "unknown",
    locked: false,
    userAdjusted: false,
    removedFrom: null,
    removedAt: null,
  };
}

function makeStop(stopId: string, customName: string, suggestMinutes: number | null): Stop {
  return {
    stopId,
    state: "attached",
    visitRef: null,
    suggestedVisitRef: null,
    matchedPointRef: null,
    customName,
    order: null,
    suggestMinutes,
    locationHint: null,
    ticketRelation: "included",
    sourceEvidenceRefs: [],
    sourceMentionRefs: [],
    userAdjusted: false,
    removedFromOrder: null,
    removedAt: null,
  };
}

/**
 * 基准行程：
 * - Day1（09:00 出发）：visit_large（大景区，3 child + 1 alternate + 1 pending，externalLeg 30min）
 *   → visit_market（普通，90min，externalLeg 20min）；
 * - Day2（08:30 出发）：visit_beach → visit_locked（locked）→ visit_bought（bought）；
 * - 全局候选区：item_temp（南山寺）；待定区：stop_pending（建议归 visit_large）。
 */
function makeBaseTrip(): Trip {
  const trip: Trip = {
    tripId: "trip_verify_48",
    schemaVersion: SCHEMA_VERSION,
    version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-01", end: "2026-11-02", nights: 1 },
    dayRefs: ["day_1", "day_2"],
    days: {
      day_1: {
        dayId: "day_1",
        dayIndex: 1,
        date: "2026-11-01",
        departTime: "09:00",
        departTimeOverridden: false,
        scheduleVisitRefs: [],
        lodging: null,
      },
      day_2: {
        dayId: "day_2",
        dayIndex: 2,
        date: "2026-11-02",
        departTime: "08:30",
        departTimeOverridden: false,
        scheduleVisitRefs: [],
        lodging: null,
      },
    },
    lodgings: {},
    itemRegistry: {
      item_large: makeItem("item_large", "亚特兰蒂斯水世界", null),
      item_market: makeItem("item_market", "第一市场", 90),
      item_beach: makeItem("item_beach", "大东海海滩", 120),
      item_locked: makeItem("item_locked", "蜈支洲岛", 240),
      item_bought: makeItem("item_bought", "亚龙湾森林公园", 150),
      item_temp: makeItem("item_temp", "南山寺", 180),
    },
    hotelRegistry: {},
    visits: {},
    stops: {},
    evidences: {},
    globalCandidateRefs: [{ kind: "point", id: "item_temp" }],
    pendingStopRefs: [],
    relationshipSuggestions: {},
    constraints: [],
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
  };

  // 大景区 + 内部玩法
  const visitLarge = makeVisit("visit_large", "item_large", "large_attraction");
  visitLarge.dayRef = "day_1";
  visitLarge.order = 0;
  visitLarge.externalLeg = { mode: "驾车", minutes: 30, note: null };

  const stopA = makeStop("stop_a", "海神塔滑道", 90);
  const stopB = makeStop("stop_b", "漂流河", 60);
  const stopC = makeStop("stop_c", "造浪池", 30);
  const stopAlt = makeStop("stop_alt", "水族馆喂食", 45);
  stopA.visitRef = "visit_large";
  stopA.order = 0;
  stopB.visitRef = "visit_large";
  stopB.order = 1;
  stopC.visitRef = "visit_large";
  stopC.order = 2;
  stopAlt.visitRef = "visit_large";
  stopAlt.order = 0;
  visitLarge.childStopRefs = ["stop_a", "stop_b", "stop_c"];
  visitLarge.alternateStopRefs = ["stop_alt"];

  const stopPending = makeStop("stop_pending", "夜场灯光秀", 60);
  stopPending.state = "pending";
  stopPending.suggestedVisitRef = "visit_large";

  trip.stops = { stop_a: stopA, stop_b: stopB, stop_c: stopC, stop_alt: stopAlt, stop_pending: stopPending };
  trip.pendingStopRefs = ["stop_pending"];
  trip.relationshipSuggestions = {
    stop_pending: {
      stopRef: "stop_pending",
      suggestedVisitRef: "visit_large",
      level: "medium",
      positiveSignals: ["攻略提及水世界夜场"],
      negativeSignals: [],
      decidedBy: "system",
    },
  };

  const visitMarket = makeVisit("visit_market", "item_market", "ordinary");
  visitMarket.dayRef = "day_1";
  visitMarket.order = 1;
  visitMarket.externalLeg = { mode: "打车", minutes: 20, note: null };

  const visitBeach = makeVisit("visit_beach", "item_beach", "ordinary");
  visitBeach.dayRef = "day_2";
  visitBeach.order = 0;
  visitBeach.externalLeg = { mode: "驾车", minutes: 40, note: null };

  const visitLocked = makeVisit("visit_locked", "item_locked", "ordinary");
  visitLocked.dayRef = "day_2";
  visitLocked.order = 1;
  visitLocked.locked = true;

  const visitBought = makeVisit("visit_bought", "item_bought", "ordinary");
  visitBought.dayRef = "day_2";
  visitBought.order = 2;
  visitBought.purchaseState = "bought";

  trip.visits = { visit_large: visitLarge, visit_market: visitMarket, visit_beach: visitBeach, visit_locked: visitLocked, visit_bought: visitBought };
  trip.days.day_1!.scheduleVisitRefs = ["visit_large", "visit_market"];
  trip.days.day_2!.scheduleVisitRefs = ["visit_beach", "visit_locked", "visit_bought"];

  // Task #122 归类族测试素材：证据 ev_guide1 同时被来源（第一市场）与目标（水世界）引用
  trip.evidences = {
    ev_guide1: {
      evidenceId: "ev_guide1",
      kind: "note_text",
      noteIndex: 1,
      assetRef: null,
      sourceUrl: null,
      ocrText: null,
      mentions: [
        {
          mentionId: "m_market",
          text: "第一市场",
          quoteText: "傍晚去第一市场吃海鲜",
          bbox: null,
          extractedName: "第一市场",
          locationHint: null,
          modelSummary: null,
        },
        {
          mentionId: "m_relation",
          text: "水世界内排队",
          quoteText: "亚特兰蒂斯水世界里的海神塔排队最久",
          bbox: null,
          extractedName: "海神塔",
          locationHint: "水世界内",
          modelSummary: null,
        },
      ],
    },
  };
  trip.itemRegistry.item_market!.sourceEvidenceRefs = ["ev_guide1"];
  visitMarket.sourceMentionRefs = ["ev_guide1:m_market"];
  visitMarket.guideSnippets = [
    {
      snippetId: "snip_market_1",
      text: "第一市场海鲜加工认准本地人多的摊位",
      claimKind: "tip",
      sourceMentionRefs: ["ev_guide1:m_market"],
    },
  ];
  visitLarge.sourceMentionRefs = ["ev_guide1:m_relation"];
  trip.days.day_1!.displayOrder = [
    { kind: "visit", visitRef: "visit_large" },
    { kind: "visit", visitRef: "visit_market" },
  ];
  return trip;
}

// ===== 轻量 test runner =====

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ===== 场景 =====

const base = makeBaseTrip();

// 1. fixture 自检：schemaVersion 为数字 2（rev2）、结构一致
test("fixture：schemaVersion 为数字 2 且一致性校验通过", () => {
  assert.equal(typeof SCHEMA_VERSION, "number");
  assert.equal(SCHEMA_VERSION, 2);
  assert.equal(base.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(validateConsistency(base), []);
});

// 2. 普通 Visit 排序：move 同天改序 + 时间轴重排
test("普通 Visit 排序：move visit 至 Day1 首位并重算时间轴", () => {
  const result = applyOps(
    base,
    [
      {
        op: "move",
        subjectRef: { kind: "visit", id: "visit_market" },
        containerRef: { kind: "day", dayIndex: 1 },
        toOrder: 0,
        reason: "把第一市场放最前",
      },
    ],
    { actor: "user_manual" },
  );
  assert.equal(result.applied.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.deepEqual(result.trip.days.day_1!.scheduleVisitRefs, ["visit_market", "visit_large"]);
  assert.equal(result.trip.visits.visit_market!.order, 0);
  assert.equal(result.trip.visits.visit_large!.order, 1);
  assert.equal(result.trip.visits.visit_market!.userAdjusted, true);
  // 时间轴：market 09:00+20=09:20 起，+90=10:50 止；large 10:50+30=11:20 起，+180=14:20 止
  assert.equal(result.trip.visits.visit_market!.startTime, "09:20");
  assert.equal(result.trip.visits.visit_market!.endTime, "10:50");
  assert.equal(result.trip.visits.visit_large!.startTime, "11:20");
  assert.equal(result.trip.visits.visit_large!.endTime, "14:20");
});

// 3. 大景区 + 3 Stop：汇总时长、alternate 不参与、大景区只出现一次
test("大景区时长汇总：child 三项求和，alternate 不参与，schedule 只出现一次", () => {
  const result = recomputeDayTimeline(base, 1);
  // 09:00 出发 + 30min 交通 = 09:30 到达；无覆写无窗口
  assert.equal(result.visits.visit_large!.startTime, "09:30");
  // effectiveMinutes = 90+60+30 = 180（reserved 与 item 均无 → child 汇总）
  assert.equal(result.visits.visit_large!.effectiveMinutes, 180);
  assert.equal(result.visits.visit_large!.endTime, "12:30");
  // 备选玩法（45min）不参与游玩时长
  assert.notEqual(result.visits.visit_large!.effectiveMinutes, 225);
  // 大景区在城市路线只出现一次；Stop 不进入城市级 schedule
  assert.equal(result.days.day_1!.scheduleVisitRefs.filter((id) => id === "visit_large").length, 1);
  assert.equal(result.days.day_1!.scheduleVisitRefs.length, 2);
  // Stop 无开始时间字段（类型层裁剪，运行时防御断言）
  assert.equal("startTime" in result.stops.stop_a!, false);
  assert.equal("purchaseState" in result.stops.stop_a!, false);
  assert.equal("locked" in result.stops.stop_a!, false);
  // 纯函数：入参 trip 未被改动
  assert.equal(base.visits.visit_large!.startTime, null);
  assert.equal(base.visits.visit_large!.effectiveMinutes, null);
});

// 3b. externalLeg 未知沿链传播，窗口锚点恢复链条
test("timeline：交通待定不当作 0，沿链传播直到新锚点（窗口）", () => {
  const unknown = deepClone(base);
  unknown.visits.visit_large!.externalLeg = { mode: "景区接驳", minutes: null, note: null };
  const propagated = recomputeDayTimeline(unknown, 1);
  assert.equal(propagated.visits.visit_large!.startTime, null);
  assert.equal(propagated.visits.visit_large!.endTime, null);
  assert.equal(propagated.visits.visit_market!.startTime, null); // 沿链传播

  const anchored = deepClone(unknown);
  anchored.visits.visit_market!.windowStart = "13:00";
  const recovered = recomputeDayTimeline(anchored, 1);
  assert.equal(recovered.visits.visit_market!.startTime, "13:00"); // 窗口锚点
  assert.equal(recovered.visits.visit_market!.endTime, "14:30"); // 13:00 + 90
});

// 4. Stop 父内排序：move stop 父内重排
test("Stop 父内排序：move stop_c 至大景区内部首位", () => {
  const result = applyOps(
    base,
    [
      {
        op: "move",
        subjectRef: { kind: "stop", id: "stop_c" },
        containerRef: { kind: "visit", id: "visit_large" },
        toOrder: 0,
        reason: "先去造浪池",
      },
    ],
    { actor: "user_manual" },
  );
  assert.equal(result.applied.length, 1);
  assert.deepEqual(result.trip.visits.visit_large!.childStopRefs, ["stop_c", "stop_a", "stop_b"]);
  assert.equal(result.trip.stops.stop_c!.order, 0);
  assert.equal(result.trip.stops.stop_a!.order, 1);
  assert.equal(result.trip.stops.stop_b!.order, 2);
  assert.equal(result.trip.stops.stop_c!.userAdjusted, true);
  // 汇总时长不变（180），时间轴不受父内顺序影响
  assert.equal(result.trip.visits.visit_large!.effectiveMinutes, 180);

  // toOrder 越界（child 长 3，上界 2）被拒
  const overflow = applyOps(
    base,
    [
      {
        op: "move",
        subjectRef: { kind: "stop", id: "stop_c" },
        containerRef: { kind: "visit", id: "visit_large" },
        toOrder: 3,
        reason: "越界",
      },
    ],
    { actor: "user_manual" },
  );
  assert.equal(overflow.applied.length, 0);
  assert.match(overflow.rejected[0]!.reason, /越界/);
});

// 5. Stop 移入 alternate + 撤销所需信息
test("Stop 移入备选玩法：记录原位置，transfer 撤销后完整恢复", () => {
  const removed = applyOps(
    base,
    [
      {
        op: "remove",
        subjectRef: { kind: "stop", id: "stop_a" },
        fromContainerRef: { kind: "visit", id: "visit_large" },
        reason: "不玩海神塔",
      },
    ],
    { confirmed: true, actor: "user_manual" },
  );
  assert.equal(removed.applied.length, 1);
  const visit = removed.trip.visits.visit_large!;
  assert.deepEqual(visit.childStopRefs, ["stop_b", "stop_c"]);
  assert.deepEqual(visit.alternateStopRefs, ["stop_alt", "stop_a"]);
  const stop = removed.trip.stops.stop_a!;
  // 撤销恢复所需信息：原位置 + 时间戳保留，归属与配置不动
  assert.equal(stop.state, "attached");
  assert.equal(stop.visitRef, "visit_large");
  assert.equal(stop.removedFromOrder, 0);
  assert.ok(stop.removedAt !== null);
  assert.equal(stop.suggestMinutes, 90);
  assert.equal(stop.customName, "海神塔滑道");
  assert.equal(stop.ticketRelation, "included");
  // effectiveMinutes 更新为 60+30=90
  assert.equal(removed.trip.visits.visit_large!.effectiveMinutes, 90);

  // 撤销：transfer 从备选玩法放回 child 首位
  const undo = applyOps(
    removed.trip,
    [
      {
        op: "transfer",
        subjectRef: { kind: "stop", id: "stop_a" },
        fromContainerRef: { kind: "visitPool", visitId: "visit_large" },
        toContainerRef: { kind: "visit", id: "visit_large" },
        toOrder: 0,
        reason: "撤销：还是玩海神塔",
      },
    ],
    { actor: "user_manual" },
  );
  assert.equal(undo.applied.length, 1);
  const restored = undo.trip;
  assert.deepEqual(restored.visits.visit_large!.childStopRefs, ["stop_a", "stop_b", "stop_c"]);
  assert.deepEqual(restored.visits.visit_large!.alternateStopRefs, ["stop_alt"]);
  const restoredStop = restored.stops.stop_a!;
  assert.equal(restoredStop.removedFromOrder, null); // 撤销信息清空
  assert.equal(restoredStop.removedAt, null);
  assert.equal(restoredStop.userAdjusted, true);
  assert.equal(restored.visits.visit_large!.effectiveMinutes, 180);
  assert.deepEqual(validateConsistency(restored), []);
});

// 6. Visit 跨天携带子项
test("Visit 跨天：transfer 大景区 Day1→Day2，child/alternate 整组随行", () => {
  const result = applyOps(
    base,
    [
      {
        op: "transfer",
        subjectRef: { kind: "visit", id: "visit_large" },
        fromContainerRef: { kind: "day", dayIndex: 1 },
        toContainerRef: { kind: "day", dayIndex: 2 },
        toOrder: null,
        reason: "水世界改到第二天",
      },
    ],
    { actor: "user_manual" },
  );
  assert.equal(result.applied.length, 1);
  assert.deepEqual(result.trip.days.day_1!.scheduleVisitRefs, ["visit_market"]);
  assert.deepEqual(result.trip.days.day_2!.scheduleVisitRefs, [
    "visit_beach",
    "visit_locked",
    "visit_bought",
    "visit_large",
  ]);
  const visit = result.trip.visits.visit_large!;
  assert.equal(visit.dayRef, "day_2");
  assert.equal(visit.order, 3);
  assert.deepEqual(visit.childStopRefs, ["stop_a", "stop_b", "stop_c"]);
  assert.deepEqual(visit.alternateStopRefs, ["stop_alt"]);
  // 子项挂载不变
  for (const stopId of ["stop_a", "stop_b", "stop_c", "stop_alt"]) {
    assert.equal(result.trip.stops[stopId]!.visitRef, "visit_large");
  }
  // Day2 重算：08:30+40=09:10 beach；+120=11:10；locked 11:10+240=15:10；bought 15:10+150=17:40；large 17:40+30=18:10 起，+180=21:10 止
  assert.equal(visit.startTime, "18:10");
  assert.equal(visit.endTime, "21:10");
});

// 7. 非法 Stop 操作被拒（guards 预校验 + 执行器兜底双通道）
test("Stop 越权操作全部被拒：setTime / setPurchase / lock / 跨天 transfer", () => {
  // guards 层单条校验（G1；checkGuards 单条 100% 违规会触发整批阈值，故用单条接口）
  const guarded = validateOperation(
    { op: "setTime", subjectRef: { kind: "stop", id: "stop_a" }, value: "10:00", target: "start", reason: "x" },
    base,
  );
  assert.equal(guarded.valid, false);
  assert.match(guarded.reason ?? "", /不支持设置具体开始时间/);

  // 执行器层（不经过 guards 直接下发）
  const setTime = applyOps(
    base,
    [{ op: "setTime", subjectRef: { kind: "stop", id: "stop_a" }, value: "10:00", target: "start", reason: "x" }],
    { actor: "user_manual" },
  );
  assert.equal(setTime.applied.length, 0);
  assert.match(setTime.rejected[0]!.reason, /不支持设置具体开始时间/);

  const setPurchase = applyOps(
    base,
    [{ op: "setPurchase", subjectRef: { kind: "stop", id: "stop_a" }, value: "bought", reason: "x" }],
    { confirmed: true, actor: "user_manual" },
  );
  assert.equal(setPurchase.applied.length, 0);
  assert.match(setPurchase.rejected[0]!.reason, /不支持独立购买状态/);

  const lock = applyOps(
    base,
    [{ op: "lock", subjectRef: { kind: "stop", id: "stop_a" }, value: true, reason: "x" }],
    { confirmed: true, actor: "user_manual" },
  );
  assert.equal(lock.applied.length, 0);
  assert.match(lock.rejected[0]!.reason, /不支持锁定/);

  // 跨天归类纠正：visit_large 在 Day1，目标 visit_beach 在 Day2
  const crossDay = applyOps(
    base,
    [
      {
        op: "transfer",
        subjectRef: { kind: "stop", id: "stop_a" },
        fromContainerRef: { kind: "visit", id: "visit_large" },
        toContainerRef: { kind: "visit", id: "visit_beach" },
        toOrder: null,
        reason: "x",
      },
    ],
    { actor: "user_manual" },
  );
  assert.equal(crossDay.applied.length, 0);
  assert.match(crossDay.rejected[0]!.reason, /不支持跨天移动/);

  // 用户可读文案映射
  assert.match(describeRejection(crossDay.rejected[0]!.reason), /不能跨天移动/);
  assert.match(describeRejection(setTime.rejected[0]!.reason), /不显示具体开始时间/);
});

// 7b. Stop 合法归类纠正：child ↔ pendingPool / visitPool
test("Stop 归类纠正：child → pendingPool（用户移出）→ 回 child", () => {
  const out = applyOps(
    base,
    [
      {
        op: "transfer",
        subjectRef: { kind: "stop", id: "stop_a" },
        fromContainerRef: { kind: "visit", id: "visit_large" },
        toContainerRef: { kind: "pendingPool" },
        toOrder: null,
        reason: "用户主动移出归类",
      },
    ],
    { actor: "user_manual" },
  );
  assert.equal(out.applied.length, 1);
  assert.deepEqual(out.trip.visits.visit_large!.childStopRefs, ["stop_b", "stop_c"]);
  assert.ok(out.trip.pendingStopRefs.includes("stop_a"));
  const pendingStop = out.trip.stops.stop_a!;
  assert.equal(pendingStop.state, "pending");
  assert.equal(pendingStop.visitRef, null);
  assert.equal(pendingStop.order, null);

  // 用户移出归类：suggestedVisitRef 清空，自动判断不得再覆盖
  const back = applyOps(
    out.trip,
    [
      {
        op: "transfer",
        subjectRef: { kind: "stop", id: "stop_a" },
        fromContainerRef: { kind: "pendingPool" },
        toContainerRef: { kind: "visit", id: "visit_large" },
        toOrder: 2,
        reason: "重新归入水世界",
      },
    ],
    { actor: "user_manual" },
  );
  assert.equal(back.applied.length, 1);
  assert.deepEqual(back.trip.visits.visit_large!.childStopRefs, ["stop_b", "stop_c", "stop_a"]);
  const backStop = back.trip.stops.stop_a!;
  assert.equal(backStop.state, "attached");
  assert.equal(backStop.visitRef, "visit_large");
  assert.equal(backStop.order, 2);
  // 归类纠正 decidedBy=user：自动判断不得覆盖
  const suggestion = back.trip.relationshipSuggestions.stop_a;
  assert.equal(suggestion, undefined); // fixture 未给 stop_a 建建议记录（原 child 状态）
});

// 7c. pending 归类只能由用户确认（Task #105：护栏 + 执行器双层拒绝 AI）
test("pending 归类：AI transfer 被护栏与执行器双层拒绝，用户明确归类才写 userAdjusted/decidedBy", () => {
  const fromPending: Operation = {
    op: "transfer",
    subjectRef: { kind: "stop", id: "stop_pending" },
    fromContainerRef: { kind: "pendingPool" },
    toContainerRef: { kind: "visit", id: "visit_large" },
    toOrder: null,
    reason: "AI 想把夜场直接归入水世界",
  };

  // 护栏层：默认 actor=ai_proposed（最保守）→ G3
  const guarded = validateOperation(fromPending, base);
  assert.equal(guarded.valid, false);
  assert.equal(guarded.guard, "G3");
  assert.match(guarded.reason ?? "", /归类/);
  assert.equal(checkGuards([fromPending], base).passed.length, 0, "checkGuards 不得放行 AI 归类");
  // 用户通道放行
  assert.equal(validateOperation(fromPending, base, "user_manual").valid, true);
  assert.equal(validateOperation(fromPending, base, "user_confirmed").valid, true);

  // 执行器层（绕过护栏直发）同样兜底拒绝，行程逐字段不变
  const byAi = applyOps(base, [fromPending], { actor: "ai_proposed" });
  assert.equal(byAi.applied.length, 0);
  assert.match(byAi.rejected[0]!.reason, /归类/);
  assert.equal(byAi.trip.stops.stop_pending!.state, "pending");
  assert.ok(byAi.trip.pendingStopRefs.includes("stop_pending"));
  assert.equal(byAi.trip.relationshipSuggestions.stop_pending!.decidedBy, "system");
  assert.equal(byAi.trip.stops.stop_pending!.userAdjusted, false);

  // 用户明确归类：执行并写 userAdjusted=true / decidedBy=user
  const byUser = applyOps(base, [fromPending], { actor: "user_manual" });
  assert.equal(byUser.applied.length, 1);
  const classified = byUser.trip.stops.stop_pending!;
  assert.equal(classified.state, "attached");
  assert.equal(classified.visitRef, "visit_large");
  assert.equal(classified.userAdjusted, true);
  assert.ok(!byUser.trip.pendingStopRefs.includes("stop_pending"));
  assert.equal(byUser.trip.relationshipSuggestions.stop_pending!.decidedBy, "user");

  // 反向（child → pendingPool）也是归类决定：AI 拒绝、用户放行
  const toPending: Operation = {
    op: "transfer",
    subjectRef: { kind: "stop", id: "stop_a" },
    fromContainerRef: { kind: "visit", id: "visit_large" },
    toContainerRef: { kind: "pendingPool" },
    toOrder: null,
    reason: "AI 想把海神塔移回待定",
  };
  assert.equal(validateOperation(toPending, base).valid, false);
  assert.equal(applyOps(base, [toPending], { actor: "ai_proposed" }).applied.length, 0);
  const userOut = applyOps(base, [toPending], { actor: "user_manual" });
  assert.equal(userOut.applied.length, 1);
  assert.equal(userOut.trip.stops.stop_a!.state, "pending");

  // 非 pending 的归类纠正（child → visitPool）不受此限制：AI 可执行，但不得写用户决定
  const toAlternate: Operation = {
    op: "transfer",
    subjectRef: { kind: "stop", id: "stop_b" },
    fromContainerRef: { kind: "visit", id: "visit_large" },
    toContainerRef: { kind: "visitPool", visitId: "visit_large" },
    toOrder: null,
    reason: "AI 把漂流河改为备选",
  };
  const aiAlternate = applyOps(base, [toAlternate], { actor: "ai_proposed" });
  assert.equal(aiAlternate.applied.length, 1);
  assert.equal(aiAlternate.trip.stops.stop_b!.userAdjusted, false, "AI 操作不得伪装成用户调整");
});

// 8. plan 保序：未提及项保持原相对顺序追加
test("plan 保序：显式提及项按 order 放置，未提及项原序追加", () => {
  const result = applyOps(
    base,
    [
      {
        op: "plan",
        scopeRef: { kind: "day", dayIndex: 1 },
        assignments: [{ subjectRef: { kind: "visit", id: "visit_market" }, containerRef: { kind: "day", dayIndex: 1 }, order: 0 }],
        reason: "第一市场优先",
      },
    ],
    { actor: "ai_proposed" },
  );
  assert.equal(result.applied.length, 1);
  assert.deepEqual(result.trip.days.day_1!.scheduleVisitRefs, ["visit_market", "visit_large"]);
  assert.equal(result.trip.visits.visit_market!.userAdjusted, true);
  assert.equal(result.trip.visits.visit_large!.userAdjusted, false); // 未提及不算调整

  // plan 父内重排 Stop：只列 stop_a，其余保持原序
  const inner = applyOps(
    base,
    [
      {
        op: "plan",
        scopeRef: { kind: "day", dayIndex: 1 },
        assignments: [{ subjectRef: { kind: "stop", id: "stop_c" }, containerRef: { kind: "visit", id: "visit_large" }, order: 0 }],
        reason: "先去造浪池",
      },
    ],
    { actor: "ai_proposed" },
  );
  assert.equal(inner.applied.length, 1);
  assert.deepEqual(inner.trip.visits.visit_large!.childStopRefs, ["stop_c", "stop_a", "stop_b"]);
  assert.deepEqual(validateConsistency(inner.trip), []);

  // pending stop 不得被 plan 自动挂入（须用户确认归类）
  const pendingPlan = applyOps(
    base,
    [
      {
        op: "plan",
        scopeRef: { kind: "day", dayIndex: 1 },
        assignments: [
          { subjectRef: { kind: "stop", id: "stop_pending" }, containerRef: { kind: "visit", id: "visit_large" }, order: 3 },
        ],
        reason: "挂入夜场",
      },
    ],
    { actor: "ai_proposed" },
  );
  assert.equal(pendingPlan.applied.length, 0);
  assert.match(pendingPlan.rejected[0]!.reason, /待定加入/);
});

// 9. locked / bought 保护
test("locked/bought 保护：AI 不可动，用户可改但 remove 一律拒绝", () => {
  const moveLocked: Operation = {
    op: "move",
    subjectRef: { kind: "visit", id: "visit_locked" },
    containerRef: { kind: "day", dayIndex: 2 },
    toOrder: 0,
    reason: "x",
  };
  // AI 通道被 G3 拒
  const byAi = applyOps(base, [moveLocked], { actor: "ai_proposed" });
  assert.equal(byAi.applied.length, 0);
  assert.match(byAi.rejected[0]!.reason, /锁定/);
  const guardAi = validateOperation(moveLocked, base);
  assert.equal(guardAi.valid, false);
  assert.equal(guardAi.guard, "G3");

  // 用户明确操作可改（锁保留）
  const byUser = applyOps(base, [moveLocked], { actor: "user_manual" });
  assert.equal(byUser.applied.length, 1);
  assert.equal(byUser.trip.visits.visit_locked!.order, 0);
  assert.equal(byUser.trip.visits.visit_locked!.locked, true);

  // remove 对 locked 一律拒绝（confirmed 也拒）
  const removeLocked = applyOps(
    base,
    [
      {
        op: "remove",
        subjectRef: { kind: "visit", id: "visit_locked" },
        fromContainerRef: { kind: "day", dayIndex: 2 },
        reason: "x",
      },
    ],
    { confirmed: true, actor: "user_manual" },
  );
  assert.equal(removeLocked.applied.length, 0);
  assert.match(removeLocked.rejected[0]!.reason, /锁定/);

  // bought：AI 不可移动；remove 走改订
  const moveBought: Operation = {
    op: "move",
    subjectRef: { kind: "visit", id: "visit_bought" },
    containerRef: { kind: "day", dayIndex: 2 },
    toOrder: 0,
    reason: "x",
  };
  const boughtAi = applyOps(base, [moveBought], { actor: "ai_proposed" });
  assert.equal(boughtAi.applied.length, 0);
  assert.match(boughtAi.rejected[0]!.reason, /已购/);
  const removeBought = applyOps(
    base,
    [
      {
        op: "remove",
        subjectRef: { kind: "visit", id: "visit_bought" },
        fromContainerRef: { kind: "day", dayIndex: 2 },
        reason: "x",
      },
    ],
    { confirmed: true, actor: "user_manual" },
  );
  assert.equal(removeBought.applied.length, 0);
  assert.match(removeBought.rejected[0]!.reason, /已购|改订/);
});

// 9b. remove Visit：进全局候选区，子项保持挂载（原子恢复语义）
test("remove Visit：进入 globalCandidateRefs，子项保持挂载", () => {
  const result = applyOps(
    base,
    [
      {
        op: "remove",
        subjectRef: { kind: "visit", id: "visit_large" },
        fromContainerRef: { kind: "day", dayIndex: 1 },
        reason: "水世界先不排",
      },
    ],
    { confirmed: true, actor: "user_manual" },
  );
  assert.equal(result.applied.length, 1);
  assert.deepEqual(result.trip.days.day_1!.scheduleVisitRefs, ["visit_market"]);
  const visit = result.trip.visits.visit_large!;
  assert.equal(visit.dayRef, null);
  assert.equal(visit.order, null);
  assert.deepEqual(visit.removedFrom, { dayIndex: 1, order: 0 });
  assert.ok(visit.removedAt !== null);
  // 子项保持挂载（撤销 / 重新加入原子恢复）
  assert.deepEqual(visit.childStopRefs, ["stop_a", "stop_b", "stop_c"]);
  assert.deepEqual(visit.alternateStopRefs, ["stop_alt"]);
  for (const stopId of ["stop_a", "stop_b", "stop_c", "stop_alt"]) {
    assert.equal(result.trip.stops[stopId]!.visitRef, "visit_large");
  }
  assert.ok(result.trip.globalCandidateRefs.some((ref) => ref.kind === "visit" && ref.id === "visit_large"));
  assert.deepEqual(validateConsistency(result.trip), []);

  // 重新加入（transfer globalPool → day1）：恢复到原天
  const back = applyOps(
    result.trip,
    [
      {
        op: "transfer",
        subjectRef: { kind: "visit", id: "visit_large" },
        fromContainerRef: { kind: "globalPool" },
        toContainerRef: { kind: "day", dayIndex: 1 },
        toOrder: null,
        reason: "撤销移除",
      },
    ],
    { actor: "user_manual" },
  );
  assert.equal(back.applied.length, 1);
  assert.deepEqual(back.trip.days.day_1!.scheduleVisitRefs, ["visit_market", "visit_large"]);
  assert.equal(back.trip.visits.visit_large!.removedFrom, null);
  assert.ok(!back.trip.globalCandidateRefs.some((ref) => ref.kind === "visit" && ref.id === "visit_large"));
});

// 10. 30% 整批拒绝阈值
test("30% 阈值：恰好 30% 不触发，严格大于整批拒绝", () => {
  const badOp = (): Operation => ({
    op: "setTime",
    subjectRef: { kind: "stop", id: "stop_a" },
    value: "10:00",
    target: "start",
    reason: "x",
  });
  const goodOp = (): Operation => ({
    op: "setDuration",
    subjectRef: { kind: "stop", id: "stop_b" },
    minutes: 45,
    reason: "y",
  });

  // 3 违规 / 10 条 = 30%：不触发
  const atThreshold = checkGuards([...Array.from({ length: 3 }, badOp), ...Array.from({ length: 7 }, goodOp)], base);
  assert.equal(atThreshold.rejectAll, false);
  assert.equal(atThreshold.passed.length, 7);
  assert.equal(atThreshold.rejected.length, 3);

  // 4 违规 / 10 条 = 40%：整批拒绝
  const overThreshold = checkGuards([...Array.from({ length: 4 }, badOp), ...Array.from({ length: 6 }, goodOp)], base);
  assert.equal(overThreshold.rejectAll, true);
  assert.equal(overThreshold.passed.length, 0);
  assert.equal(overThreshold.rejected.length, 10);
  assert.equal(overThreshold.rejected[0]!.guard, "threshold");
  // Task #379：整批拒绝用户文案改为可操作引导（单点常量），不得出现阈值数字
  assert.equal(describeRejection(overThreshold.rejected[0]!.reason), BATCH_REJECTION_GUIDANCE);
  assert.ok(!BATCH_REJECTION_GUIDANCE.includes("30%"), "引导文案不得提及阈值数字");
  assert.match(BATCH_REJECTION_GUIDANCE, /建议缩小单次改动范围/);
});

// 11. 引用一致性校验
test("引用一致性：悬空 / 双容器 / 状态错位均被检出", () => {
  // 悬空 visit 引用
  const dangling = deepClone(base);
  dangling.days.day_1!.scheduleVisitRefs.push("visit_ghost");
  assert.ok(validateConsistency(dangling).some((e) => e.includes("visit_ghost")));

  // Stop visitRef 与实际容器不一致
  const mismatch = deepClone(base);
  mismatch.stops.stop_a!.visitRef = "visit_market";
  assert.ok(validateConsistency(mismatch).some((e) => e.includes("不一致")));

  // pending stop 携带 visitRef
  const badPending = deepClone(base);
  badPending.stops.stop_pending!.visitRef = "visit_large";
  assert.ok(validateConsistency(badPending).some((e) => e.includes("pending")));

  // stop 同时出现在两个容器
  const doubleStop = deepClone(base);
  doubleStop.visits.visit_large!.alternateStopRefs.push("stop_b");
  assert.ok(validateConsistency(doubleStop).some((e) => e.includes("多个容器")));

  // 移除后遗留 alternate 引用（悬空 stop）
  const staleStop = deepClone(base);
  delete staleStop.stops.stop_alt;
  assert.ok(validateConsistency(staleStop).some((e) => e.includes("stop_alt")));
});

// 12. needsProposal 确认分流
test("needsProposal：remove 默认分流，confirmed 二次下发执行", () => {
  const removeOp: Operation = {
    op: "remove",
    subjectRef: { kind: "stop", id: "stop_a" },
    fromContainerRef: { kind: "visit", id: "visit_large" },
    reason: "不玩海神塔",
  };
  const first = applyOps(base, [removeOp]);
  assert.equal(first.applied.length, 0);
  assert.equal(first.needsProposal.length, 1);
  // 行程未变
  assert.deepEqual(first.trip.days.day_1!.scheduleVisitRefs, base.days.day_1!.scheduleVisitRefs);
  assert.deepEqual(first.trip.visits.visit_large!.childStopRefs, ["stop_a", "stop_b", "stop_c"]);

  const second = applyOps(base, [removeOp], { confirmed: true });
  assert.equal(second.applied.length, 1);
  assert.equal(second.needsProposal.length, 0);
  assert.deepEqual(second.trip.visits.visit_large!.childStopRefs, ["stop_b", "stop_c"]);
});

// 13. G4 重排保护：userAdjusted 项被 plan 悄悄省略 → warning
test("G4 重排保护：plan 省略 userAdjusted 项产生 warning 而非拒绝", () => {
  const adjusted = deepClone(base);
  adjusted.visits.visit_large!.userAdjusted = true;
  const planOp: Operation = {
    op: "plan",
    scopeRef: { kind: "day", dayIndex: 1 },
    assignments: [{ subjectRef: { kind: "visit", id: "visit_market" }, containerRef: { kind: "day", dayIndex: 1 }, order: 0 }],
    reason: "重排 Day1",
  };
  const result = checkGuards([planOp], adjusted);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.rejectAll, false);
  assert.ok((result.warnings ?? []).some((w) => w.includes("亚特兰蒂斯水世界")));

  // 同批存在对应 remove 时不警告
  const withRemove = checkGuards(
    [
      planOp,
      { op: "remove", subjectRef: { kind: "visit", id: "visit_large" }, fromContainerRef: { kind: "day", dayIndex: 1 }, reason: "移除水世界" },
    ],
    adjusted,
  );
  assert.equal(withRemove.rejected.length, 0);
  assert.ok(!(withRemove.warnings ?? []).some((w) => w.includes("亚特兰蒂斯水世界")));
});

// 14. plan 从全局候选区引入 point（确定性 visitId + 候选引用解除）
test("plan 引入候选 point：创建普通 Visit 并从 globalPool 解除引用", () => {
  const result = applyOps(
    base,
    [
      {
        op: "plan",
        scopeRef: { kind: "day", dayIndex: 1 },
        assignments: [{ subjectRef: { kind: "point", id: "item_temp" }, containerRef: { kind: "day", dayIndex: 1 }, order: 2 }],
        reason: "南山寺加入行程",
      },
    ],
    { actor: "ai_proposed" },
  );
  assert.equal(result.applied.length, 1);
  const created = result.trip.visits.visit_item_temp_1;
  assert.ok(created !== undefined);
  assert.equal(created.pointRef, "item_temp");
  assert.equal(created.kind, "ordinary");
  assert.equal(created.dayRef, "day_1");
  // 未提及的既有项保持原相对顺序追加
  assert.deepEqual(result.trip.days.day_1!.scheduleVisitRefs, ["visit_item_temp_1", "visit_large", "visit_market"]);
  assert.ok(!result.trip.globalCandidateRefs.some((ref) => ref.kind === "point" && ref.id === "item_temp"));
  // 时间轴：09:00 到达（无交通段），+180 = 12:00
  assert.equal(created.startTime, "09:00");
  assert.equal(created.endTime, "12:00");
  assert.equal(result.trip.visits.visit_large!.startTime, "12:30");
  assert.deepEqual(validateConsistency(result.trip), []);
});

// ===== Task #122：classifyVisitAsStop 归类族 =====

/** 构造 classify op（默认把第一市场归入水世界，强证据齐备） */
function classifyOp(overrides: Partial<Extract<Operation, { op: "classifyVisitAsStop" }>> = {}): Operation {
  return {
    op: "classifyVisitAsStop",
    visitId: "visit_market",
    parentVisitId: "visit_large",
    toOrder: null,
    evidenceMentionRefs: ["ev_guide1:m_market", "ev_guide1:m_relation"],
    reason: "攻略同时提及两者的从属关系，按强证据归类",
    ...overrides,
  };
}

// 16. 成功转换：身份转换 / 证据迁移 / 旧引用清理 / 时间轴汇总
 test("classify 成功转换：Visit 转 Stop、证据 snippets 迁移、旧引用清理、时间轴汇总", () => {
  const result = applyOps(base, [classifyOp()], { actor: "user_manual" });
  assert.equal(result.applied.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.deepEqual(validateConsistency(result.trip), []);
  // 原 Visit 删除 + 城市级排期 / 混合展示顺序清理
  assert.equal(result.trip.visits.visit_market, undefined);
  assert.deepEqual(result.trip.days.day_1!.scheduleVisitRefs, ["visit_large"]);
  assert.deepEqual(result.trip.days.day_1!.displayOrder, [{ kind: "visit", visitRef: "visit_large" }]);
  // Stop 创建：命中飞猪 → matchedPointRef 继承 Item 引用（名称/图片/地址继续从主数据解析）
  const stop = result.trip.stops.stop_from_visit_market!;
  assert.equal(stop.state, "attached");
  assert.equal(stop.visitRef, "visit_large");
  assert.equal(stop.matchedPointRef, "item_market");
  assert.equal(stop.customName, null);
  assert.equal(stop.suggestMinutes, 90); // reservedMinutes(null) → item.suggestMinutes(90)
  assert.deepEqual(stop.sourceMentionRefs, ["ev_guide1:m_market", "ev_guide1:m_relation"]);
  assert.deepEqual(stop.sourceEvidenceRefs, ["ev_guide1"]);
  assert.equal(stop.classifiedFromVisitRef, "visit_market");
  assert.equal(stop.userAdjusted, true);
  assert.deepEqual((stop.guideSnippets ?? []).map((s) => s.snippetId), ["snip_market_1"]);
  // 挂入 parent.childStopRefs 末位，汇总时长参与（90+60+30+90=270）
  assert.deepEqual(result.trip.visits.visit_large!.childStopRefs, [
    "stop_a",
    "stop_b",
    "stop_c",
    "stop_from_visit_market",
  ]);
  assert.equal(stop.order, 3);
  assert.equal(result.trip.visits.visit_large!.effectiveMinutes, 270);
  assert.equal(result.trip.visits.visit_large!.endTime, "14:00"); // 09:30 + 270
  // 归属档案：用户通道 decidedBy=user；不触碰 pending；纯函数不改入参
  assert.equal(result.trip.relationshipSuggestions.stop_from_visit_market!.decidedBy, "user");
  assert.deepEqual(result.trip.pendingStopRefs, ["stop_pending"]);
  assert.ok(base.visits.visit_market !== undefined);
});

// 17. 幂等重放
 test("classify 幂等重放：单条重放与同批双发都不重复创建，仅合并证据", () => {
  const first = applyOps(base, [classifyOp()], { actor: "user_manual" });
  // 护栏：重放命中溯源放行（执行器仅合并证据）
  assert.equal(validateOperation(classifyOp(), first.trip).valid, true);
  const replay = applyOps(first.trip, [classifyOp()], { actor: "user_manual" });
  assert.equal(replay.applied.length, 1);
  assert.deepEqual(validateConsistency(replay.trip), []);
  assert.equal(
    Object.keys(replay.trip.stops).filter((id) => id.startsWith("stop_from_visit_market")).length,
    1,
  );
  assert.deepEqual(replay.trip.visits.visit_large!.childStopRefs, [
    "stop_a",
    "stop_b",
    "stop_c",
    "stop_from_visit_market",
  ]);
  assert.deepEqual(replay.trip.stops.stop_from_visit_market!.sourceMentionRefs, [
    "ev_guide1:m_market",
    "ev_guide1:m_relation",
  ]);
  // 同批双发：第一条转换 + 第二条重放，结果不重复
  const batch = applyOps(base, [classifyOp(), classifyOp()], { actor: "user_manual" });
  assert.equal(batch.applied.length, 2);
  assert.equal(
    Object.keys(batch.trip.stops).filter((id) => id.startsWith("stop_from_visit_market")).length,
    1,
  );
  assert.deepEqual(validateConsistency(batch.trip), []);
});

// 18. 弱证据拒绝（护栏 + 执行器双通道）
test("classify 弱证据拒绝：无引用/不可解析/无关联/单侧证据一律拒绝", () => {
  const empty = classifyOp({ evidenceMentionRefs: [] });
  assert.equal(validateOperation(empty, base).valid, false);
  assert.match(validateOperation(empty, base).reason ?? "", /弱证据/);

  // 引用可解析但与两侧均无关联（凭空引用）
  const fabricatedTrip = deepClone(base);
  fabricatedTrip.evidences.ev_other = {
    evidenceId: "ev_other",
    kind: "note_text",
    noteIndex: 2,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions: [
      {
        mentionId: "m_other",
        text: "别的店",
        quoteText: "隔壁那家店不错",
        bbox: null,
        extractedName: null,
        locationHint: null,
        modelSummary: null,
      },
    ],
  };
  const fabricated = classifyOp({ evidenceMentionRefs: ["ev_other:m_other"] });
  const guardFabricated = validateOperation(fabricated, fabricatedTrip);
  assert.equal(guardFabricated.valid, false);
  assert.equal(guardFabricated.guard, "G1");
  assert.match(guardFabricated.reason ?? "", /追溯/);
  const execFabricated = applyOps(fabricatedTrip, [fabricated], { actor: "ai_proposed" });
  assert.equal(execFabricated.applied.length, 0);
  assert.match(execFabricated.rejected[0]!.reason, /追溯/);

  // 引用无法解析（提及不存在）
  const dangling = classifyOp({ evidenceMentionRefs: ["ev_guide1:m_ghost"] });
  assert.equal(validateOperation(dangling, base).valid, false);
  assert.match(validateOperation(dangling, base).reason ?? "", /解析|弱证据/);

  // 单侧证据（只有来源侧，缺目标侧）
  const oneSide = classifyOp({ evidenceMentionRefs: ["ev_guide1:m_market"] });
  const guardOneSide = validateOperation(oneSide, base);
  assert.equal(guardOneSide.valid, false);
  assert.match(guardOneSide.reason ?? "", /两侧/);
  assert.equal(applyOps(base, [oneSide], { actor: "ai_proposed" }).applied.length, 0);
});

// 19. 锁定/已购红线
 test("classify 锁定/已购：来源双通道拒绝（用户确认也不豁免），目标按通道分流", () => {
  // 来源 locked（visit_locked）→ 双通道拒绝
  const lockedSrc = classifyOp({ visitId: "visit_locked" });
  const guardLocked = validateOperation(lockedSrc, base, "user_manual");
  assert.equal(guardLocked.valid, false);
  assert.equal(guardLocked.guard, "G3");
  assert.match(guardLocked.reason ?? "", /锁定/);
  assert.equal(applyOps(base, [lockedSrc], { actor: "user_manual" }).applied.length, 0);
  assert.equal(applyOps(base, [lockedSrc], { actor: "ai_proposed" }).applied.length, 0);
  assert.equal(applyOps(base, [lockedSrc], { actor: "user_confirmed" }).applied.length, 0);

  // 来源 bought（visit_bought）→ 双通道拒绝
  const boughtSrc = classifyOp({ visitId: "visit_bought" });
  assert.equal(validateOperation(boughtSrc, base, "user_manual").guard, "G3");
  assert.equal(applyOps(base, [boughtSrc], { actor: "user_manual" }).applied.length, 0);

  // 目标 locked → 一律拒绝（须先解锁）
  const lockedParentTrip = applyOps(
    base,
    [{ op: "lock", subjectRef: { kind: "visit", id: "visit_large" }, value: true, reason: "x" }],
    { confirmed: true, actor: "user_manual" },
  ).trip;
  const guardParentLocked = validateOperation(classifyOp(), lockedParentTrip, "user_manual");
  assert.equal(guardParentLocked.valid, false);
  assert.equal(guardParentLocked.guard, "G3");
  assert.match(guardParentLocked.reason ?? "", /已被锁定/);
  assert.equal(applyOps(lockedParentTrip, [classifyOp()], { actor: "user_manual" }).applied.length, 0);

  // 目标 bought：AI 拒绝（G3），用户明确操作放行
  const boughtParentTrip = deepClone(base);
  boughtParentTrip.visits.visit_large!.purchaseState = "bought";
  const guardParentBought = validateOperation(classifyOp(), boughtParentTrip);
  assert.equal(guardParentBought.valid, false);
  assert.equal(guardParentBought.guard, "G3");
  assert.equal(applyOps(boughtParentTrip, [classifyOp()], { actor: "ai_proposed" }).applied.length, 0);
  assert.equal(applyOps(boughtParentTrip, [classifyOp()], { actor: "user_manual" }).applied.length, 1);
});

// 20. 目标/来源不合法
 test("classify 目标/来源不合法：非大景区/非普通景点/缺失实体/越界一律 G1", () => {
  const ordinaryParent = classifyOp({ parentVisitId: "visit_beach" });
  const guardOrdinary = validateOperation(ordinaryParent, base);
  assert.equal(guardOrdinary.valid, false);
  assert.equal(guardOrdinary.guard, "G1");
  assert.match(guardOrdinary.reason ?? "", /大景区/);
  assert.equal(applyOps(base, [ordinaryParent], { actor: "user_manual" }).applied.length, 0);

  const largeSource = classifyOp({ visitId: "visit_large" });
  assert.match(validateOperation(largeSource, base).reason ?? "", /普通景点/);
  assert.equal(applyOps(base, [largeSource], { actor: "user_manual" }).applied.length, 0);

  assert.match(validateOperation(classifyOp({ visitId: "visit_ghost" }), base).reason ?? "", /不存在/);
  assert.match(validateOperation(classifyOp({ parentVisitId: "visit_ghost" }), base).reason ?? "", /不存在/);
  assert.match(validateOperation(classifyOp({ toOrder: 4 }), base).reason ?? "", /越界/);
});

// 21. pending 护栏无回归
 test("classify 上线后 pending 护栏无回归：plan 拒挂入、AI transfer 拒归类", () => {
  const pendingPlan = applyOps(
    base,
    [
      {
        op: "plan",
        scopeRef: { kind: "day", dayIndex: 1 },
        assignments: [
          { subjectRef: { kind: "stop", id: "stop_pending" }, containerRef: { kind: "visit", id: "visit_large" }, order: 3 },
        ],
        reason: "挂入夜场",
      },
    ],
    { actor: "ai_proposed" },
  );
  assert.equal(pendingPlan.applied.length, 0);
  assert.match(pendingPlan.rejected[0]!.reason, /待定加入/);

  const aiPendingTransfer: Operation = {
    op: "transfer",
    subjectRef: { kind: "stop", id: "stop_pending" },
    fromContainerRef: { kind: "pendingPool" },
    toContainerRef: { kind: "visit", id: "visit_large" },
    toOrder: null,
    reason: "x",
  };
  const guardPending = validateOperation(aiPendingTransfer, base);
  assert.equal(guardPending.valid, false);
  assert.equal(guardPending.guard, "G3");
  assert.equal(applyOps(base, [aiPendingTransfer], { actor: "ai_proposed" }).applied.length, 0);
});

// 22. AI 通道强证据直接归类
 test("classify AI 通道：强证据齐备时直接归类（不进 needsProposal），不写 userAdjusted", () => {
  const result = applyOps(base, [classifyOp()], { actor: "ai_proposed" });
  assert.equal(result.applied.length, 1); // 未传 confirmed，直接应用
  assert.equal(result.needsProposal.length, 0);
  assert.equal(result.trip.stops.stop_from_visit_market!.userAdjusted, false);
  assert.equal(result.trip.relationshipSuggestions.stop_from_visit_market!.decidedBy, "system");
  assert.deepEqual(validateConsistency(result.trip), []);
});

// 23. 候选区 Visit：globalPool 引用清理 + toOrder 插入重排
 test("classify 候选区 Visit：globalPool 引用清理、toOrder 指定插入位置并重排", () => {
  const pool = deepClone(base);
  const visitPool = makeVisit("visit_pool", "item_temp", "ordinary");
  visitPool.sourceMentionRefs = ["ev_guide1:m_relation"];
  pool.visits.visit_pool = visitPool;
  pool.globalCandidateRefs.push({ kind: "visit", id: "visit_pool" });
  pool.itemRegistry.item_temp!.sourceEvidenceRefs = ["ev_guide1"];
  const op = classifyOp({
    visitId: "visit_pool",
    toOrder: 0,
    evidenceMentionRefs: ["ev_guide1:m_relation"],
  });
  const result = applyOps(pool, [op], { actor: "user_manual" });
  assert.equal(result.applied.length, 1);
  assert.deepEqual(validateConsistency(result.trip), []);
  assert.ok(!result.trip.globalCandidateRefs.some((ref) => ref.kind === "visit" && ref.id === "visit_pool"));
  assert.ok(result.trip.globalCandidateRefs.some((ref) => ref.kind === "point" && ref.id === "item_temp"));
  assert.equal(result.trip.visits.visit_pool, undefined);
  assert.deepEqual(result.trip.visits.visit_large!.childStopRefs, [
    "stop_from_visit_pool",
    "stop_a",
    "stop_b",
    "stop_c",
  ]);
  assert.equal(result.trip.stops.stop_from_visit_pool!.order, 0);
  assert.equal(result.trip.stops.stop_a!.order, 1);
  // 城市级排期不受影响
  assert.deepEqual(result.trip.days.day_1!.scheduleVisitRefs, ["visit_large", "visit_market"]);
});

// 24. Task #199 用户通道免强证据归类（AI 通道门槛不变）
test("classify 用户通道：证据可空；AI 通道仍须强证据，锁定/已购红线不豁免", () => {
  const noEvidence = classifyOp({ evidenceMentionRefs: [] });

  // AI 通道：空证据仍 G1 拒绝（护栏 + 执行器双通道）
  const guardAI = validateOperation(noEvidence, base, "ai_proposed");
  assert.equal(guardAI.valid, false);
  assert.equal(guardAI.guard, "G1");
  assert.match(guardAI.reason ?? "", /强关系证据/);
  assert.equal(applyOps(base, [noEvidence], { actor: "ai_proposed" }).applied.length, 0);

  // 用户手输：空证据放行，转换成功（来源 Visit 删除 → Stop 挂入目标末尾）
  assert.equal(validateOperation(noEvidence, base, "user_manual").valid, true);
  const result = applyOps(base, [noEvidence], { actor: "user_manual" });
  assert.equal(result.applied.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.deepEqual(validateConsistency(result.trip), []);
  assert.equal(result.trip.visits.visit_market, undefined);
  const stop = result.trip.stops.stop_from_visit_market!;
  assert.equal(stop.classifiedFromVisitRef, "visit_market");
  assert.equal(stop.userAdjusted, true);
  // 来源 Visit 自身已有的证据照常迁移；操作未携带证据不产生额外引用
  assert.deepEqual(stop.sourceMentionRefs, ["ev_guide1:m_market"]);
  assert.deepEqual(stop.sourceEvidenceRefs, ["ev_guide1"]);
  const suggestion = result.trip.relationshipSuggestions.stop_from_visit_market!;
  assert.equal(suggestion.decidedBy, "user");
  assert.deepEqual(suggestion.positiveSignals, ["用户手动归入大景区"]);
  assert.ok(result.trip.visits.visit_large!.childStopRefs.includes("stop_from_visit_market"));

  // user_confirmed 同样放行
  assert.equal(applyOps(base, [noEvidence], { actor: "user_confirmed" }).applied.length, 1);

  // 单侧证据：AI 拒绝（须双侧），用户手动放行（只免双侧追溯）
  const oneSide = classifyOp({ evidenceMentionRefs: ["ev_guide1:m_market"] });
  assert.equal(validateOperation(oneSide, base, "ai_proposed").valid, false);
  assert.equal(validateOperation(oneSide, base, "user_manual").valid, true);
  assert.equal(applyOps(base, [oneSide], { actor: "user_manual" }).applied.length, 1);

  // 放宽仅限证据：来源锁定/已购、目标非大景区等预检原样保留
  const lockedSrc = classifyOp({ visitId: "visit_locked", evidenceMentionRefs: [] });
  assert.equal(validateOperation(lockedSrc, base, "user_manual").guard, "G3");
  assert.equal(applyOps(base, [lockedSrc], { actor: "user_manual" }).applied.length, 0);
  const boughtSrc = classifyOp({ visitId: "visit_bought", evidenceMentionRefs: [] });
  assert.equal(applyOps(base, [boughtSrc], { actor: "user_manual" }).applied.length, 0);
  const ordinaryParent = classifyOp({ parentVisitId: "visit_beach", evidenceMentionRefs: [] });
  assert.equal(validateOperation(ordinaryParent, base, "user_manual").guard, "G1");
  assert.equal(applyOps(base, [ordinaryParent], { actor: "user_manual" }).applied.length, 0);

  // 显式携带的悬空引用仍拒绝（数据卫生）：用户通道只免双侧追溯
  const dangling = classifyOp({ evidenceMentionRefs: ["ev_guide1:m_ghost"] });
  assert.equal(validateOperation(dangling, base, "user_manual").valid, false);
  assert.equal(applyOps(base, [dangling], { actor: "user_manual" }).applied.length, 0);

  // 纯函数：不修改入参
  assert.ok(base.visits.visit_market !== undefined);
});

// ===== 汇总 =====

console.log(`\n全部 ${passed} 组场景通过（PRD v1.1 父子 POI 模型 shared 替换验证）`);
