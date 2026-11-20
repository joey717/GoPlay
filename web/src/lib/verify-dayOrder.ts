/**
 * Task #108 纯函数场景验证 —— Day 路线顺序总览 + 混排撤销位置恢复。
 *
 * 运行：npx tsx web/src/lib/verify-dayOrder.ts（仓库根目录）
 *
 * 覆盖：
 *  A. 必验场景：[酒店H, 景点A] → 移除 A → 撤销（plan + move）→
 *     placeDayDisplayRefs 按移除前混排下标恢复，展示顺序回到 [酒店H, 景点A]；
 *     同时断言「只靠 plan + move」会把 A 补到最前（证明补混排位置的必要性）。
 *  B. 路线总览：以 displayOrder 为准（酒店与景点交错，不按 scheduleVisitRefs 重排）；
 *     大景区内部玩法紧跟父卡且只出现一次；岛内明细不进入节点重复。
 *  C. 机场节点：航班抵达 / 出发约束分别补起点 / 终点；无约束不臆造；
 *     当天已有「机场 / 车站」类景点条目时不重复补节点。
 */

import assert from "node:assert/strict";
import type { HotelCandidate, Item, Stop, Trip, Visit } from "@goplay/shared";
import { SCHEMA_VERSION, applyOps } from "@goplay/shared";
import { dayDisplayItems, dayRouteNodes, placeDayDisplayRefs, syncDisplayOrders } from "./dayOrder.js";

let passed = 0;
function pass(name: string): void {
  passed += 1;
  console.log(`✓ ${name}`);
}

function makeItem(itemId: string, name: string): Item {
  return {
    itemId,
    name,
    origin: "custom",
    providerId: null,
    address: null,
    category: null,
    coords: null,
    suggestMinutes: 90,
    mainPic: null,
    ticketInfo: null,
    jumpUrl: null,
    sourceEvidenceRefs: [],
  };
}

function makeHotel(id: string, name: string): HotelCandidate {
  return {
    id,
    shId: id,
    name,
    brandName: null,
    star: null,
    priceText: null,
    priceBasis: "价格与库存以飞猪详情页为准",
    address: null,
    interestsPoi: null,
    decorationTime: null,
    coords: null,
    mainPic: null,
    detailUrl: null,
    rate: null,
  };
}

function makeVisit(
  visitId: string,
  pointRef: string,
  dayId: string,
  order: number,
  childStopRefs: string[] = [],
): Visit {
  return {
    visitId,
    dayRef: dayId,
    pointRef,
    kind: childStopRefs.length > 0 ? "large_attraction" : "ordinary",
    visitMode: "custom",
    order,
    windowStart: null,
    windowEnd: null,
    startTime: "09:00",
    endTime: null,
    startTimeOverridden: false,
    endTimeOverridden: false,
    reservedMinutes: null,
    effectiveMinutes: 90,
    externalLeg: null,
    childStopRefs,
    alternateStopRefs: [],
    sourceMentionRefs: [],
    guideSnippets: [],
    purchaseState: "unknown",
    locked: false,
    userAdjusted: false,
    removedFrom: null,
    removedAt: null,
  };
}

function makeStop(stopId: string, visitRef: string, name: string, order: number): Stop {
  return {
    stopId,
    state: "attached",
    visitRef,
    suggestedVisitRef: null,
    matchedPointRef: null,
    customName: name,
    order,
    suggestMinutes: 40,
    locationHint: null,
    ticketRelation: "unknown",
    sourceEvidenceRefs: [],
    sourceMentionRefs: [],
    guideSnippets: [],
    userAdjusted: false,
    removedFromOrder: null,
    removedAt: null,
  };
}

/** 基础行程：Day1 = 酒店 H + 普通景点 A（displayOrder 刻意把酒店放在景点前） */
function makeTrip(): Trip {
  const dayId = "day_1";
  const hotel = makeHotel("H", "亚龙湾万豪");
  const visitA = makeVisit("visit_A", "item_A", dayId, 0);
  return {
    tripId: "trip_verify_108",
    schemaVersion: SCHEMA_VERSION,
    version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: "2026-11-08", nights: 1 },
    dayRefs: [dayId],
    days: {
      [dayId]: {
        dayId,
        dayIndex: 1,
        date: "2026-11-08",
        departTime: "09:00",
        departTimeOverridden: false,
        scheduleVisitRefs: ["visit_A"],
        lodging: { kind: "lodging", dayIndex: 1 },
        displayOrder: [
          { kind: "hotel", hotelRef: "H" },
          { kind: "visit", visitRef: "visit_A" },
        ],
      },
    },
    lodgings: {
      "1": {
        dayIndex: 1,
        areaName: "亚龙湾",
        hotelRefs: ["H"],
        checkInTime: null,
        checkOutTime: null,
        purchaseState: "unknown",
        locked: false,
        userAdjusted: false,
      },
    },
    itemRegistry: { item_A: makeItem("item_A", "天涯海角") },
    hotelRegistry: { H: hotel },
    visits: { visit_A: visitA },
    stops: {},
    evidences: {},
    globalCandidateRefs: [],
    pendingStopRefs: [],
    relationshipSuggestions: {},
    constraints: [],
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
  };
}

/** 展示顺序（便于断言）：hotel:ID / visit:ID */
function displayKeys(trip: Trip): string[] {
  const day = trip.days["day_1"];
  if (day === undefined) return [];
  return dayDisplayItems(trip, day).map((item) => `${item.kind}:${item.ref}`);
}

// ===== A. 必验场景：[酒店H, 景点A] 移除 A → 撤销恢复原位 =====

{
  let trip = makeTrip();
  assert.deepEqual(displayKeys(trip), ["hotel:H", "visit:visit_A"]);

  const removed = applyOps(
    trip,
    [
      {
        op: "remove",
        subjectRef: { kind: "visit", id: "visit_A" },
        fromContainerRef: { kind: "day", dayIndex: 1 },
        reason: "验证移除",
      },
    ],
    { actor: "user_manual", confirmed: true },
  );
  assert.equal(removed.applied.length, 1, "remove 应被应用");
  trip = syncDisplayOrders(removed.trip);
  assert.deepEqual(displayKeys(trip), ["hotel:H"], "移除 A 后只剩酒店 H");

  // 撤销：与 useTrip.undoRemove 的 visit 分支一致（plan 恢复 + move 回原 order）
  const undone = applyOps(
    trip,
    [
      {
        op: "plan",
        scopeRef: { kind: "day", dayIndex: 1 },
        assignments: [
          {
            subjectRef: { kind: "visit", id: "visit_A" },
            containerRef: { kind: "day", dayIndex: 1 },
            order: 0,
          },
        ],
        reason: "撤销移除",
      },
      {
        op: "move",
        subjectRef: { kind: "visit", id: "visit_A" },
        containerRef: { kind: "day", dayIndex: 1 },
        toOrder: 0,
        reason: "恢复原位",
      },
    ],
    { actor: "user_manual", confirmed: true },
  );
  assert.equal(undone.applied.length, 2, "撤销 plan + move 应全部应用");
  trip = syncDisplayOrders(undone.trip);
  // 只靠 plan/move：景点被补到最后一个景点槽之后（无景点槽时落在最前）
  assert.deepEqual(displayKeys(trip), ["visit:visit_A", "hotel:H"], "缺少混排位置时会被补到最前");

  // 补回移除前记录的第 2 位（displayIndex = 1）
  trip = placeDayDisplayRefs(trip, 1, [{ kind: "visit", ref: "visit_A", index: 1 }]);
  assert.deepEqual(displayKeys(trip), ["hotel:H", "visit:visit_A"], "撤销后恢复原混排位置");
  // commit 会再走一次 syncDisplayOrders：槽位重放必须保持恢复后的位置（幂等）
  trip = syncDisplayOrders(trip);
  assert.deepEqual(displayKeys(trip), ["hotel:H", "visit:visit_A"], "同步后位置不得被槽位重放改写");
  pass("A. [酒店H, 景点A] 移除 A 再撤销恢复 [酒店H, 景点A]");
}

// ===== B. 路线总览按 displayOrder 展开，岛内玩法只出现一次 =====

{
  let trip = makeTrip();
  const dayId = "day_1";
  trip.itemRegistry.item_L = makeItem("item_L", "蜈支洲岛");
  trip.visits.visit_L = makeVisit("visit_L", "item_L", dayId, 1, ["stop_1", "stop_2"]);
  trip.stops.stop_1 = makeStop("stop_1", "visit_L", "情人桥", 0);
  trip.stops.stop_2 = makeStop("stop_2", "visit_L", "观日岩", 1);
  trip.days[dayId] = {
    ...trip.days[dayId],
    scheduleVisitRefs: ["visit_A", "visit_L"],
    // 酒店插在两个景点之间：总览必须按混排顺序（A → H → L），而不是先景点后酒店
    displayOrder: [
      { kind: "visit", visitRef: "visit_A" },
      { kind: "hotel", hotelRef: "H" },
      { kind: "visit", visitRef: "visit_L" },
    ],
  };

  const nodes = dayRouteNodes(trip, trip.days[dayId]);
  assert.deepEqual(
    nodes.map((node) => `${node.kind}:${node.label}`),
    [
      "visit:天涯海角",
      "hotel:亚龙湾万豪",
      "visit:蜈支洲岛",
      "stop:情人桥",
      "stop:观日岩",
    ],
    "总览应携带酒店与岛内玩法，并遵循混排顺序",
  );
  assert.equal(
    nodes.filter((node) => node.kind === "stop").length,
    2,
    "每个岛内玩法在总览中只出现一次",
  );
  pass("B. 路线总览按 displayOrder 混排展开（含酒店 / 岛内玩法，内部点位只出现一次）");
}

// ===== C. 机场节点：约束明确时补起点/终点，不臆造、不重复 =====

{
  let trip = makeTrip();
  const dayId = "day_1";
  const withFlights: Trip = {
    ...trip,
    constraints: [
      {
        constraintId: "c_arrive",
        type: "flight_arrive",
        anchorTime: "2026-11-08T10:20:00+08:00",
        dayIndex: 1,
        label: "航班抵达",
        locked: true,
      },
      {
        constraintId: "c_depart",
        type: "flight_depart",
        anchorTime: "2026-11-08T21:40:00+08:00",
        dayIndex: 1,
        label: "航班出发",
        locked: true,
      },
    ],
  };
  trip = withFlights;
  let nodes = dayRouteNodes(trip, trip.days[dayId]);
  assert.equal(nodes[0]?.key, "transit:arrive", "抵达航班作为当天起点");
  assert.equal(nodes[0]?.label, "抵达机场");
  assert.equal(nodes.at(-1)?.key, "transit:depart", "出发航班作为当天终点");
  assert.equal(nodes.at(-1)?.label, "前往机场");
  assert.ok(nodes.some((node) => node.hint.includes("10:20")), "起点说明带抵达时间");
  assert.ok(nodes.some((node) => node.hint.includes("21:40")), "终点说明带出发时间");

  // 无航班约束：不臆造机场节点
  nodes = dayRouteNodes(makeTrip(), makeTrip().days[dayId]);
  assert.ok(!nodes.some((node) => node.kind === "transit"), "无航班约束不补机场节点");

  // 当天已有机场类景点条目：不再补抵达机场节点，避免重复
  const withAirportVisit = makeTrip();
  withAirportVisit.itemRegistry.item_air = makeItem("item_air", "三亚凤凰机场");
  withAirportVisit.visits.visit_air = makeVisit("visit_air", "item_air", dayId, 1);
  withAirportVisit.days[dayId] = {
    ...withAirportVisit.days[dayId],
    scheduleVisitRefs: ["visit_A", "visit_air"],
    displayOrder: [
      { kind: "visit", visitRef: "visit_air" },
      { kind: "hotel", hotelRef: "H" },
      { kind: "visit", visitRef: "visit_A" },
    ],
  };
  const dedupTrip: Trip = { ...withAirportVisit, constraints: withFlights.constraints };
  nodes = dayRouteNodes(dedupTrip, dedupTrip.days[dayId]);
  assert.ok(!nodes.some((node) => node.key === "transit:arrive"), "机场已是当天条目时不再补起点");
  assert.ok(!nodes.some((node) => node.key === "transit:depart"), "机场已是当天条目时不再补终点");
  assert.equal(
    nodes.filter((node) => node.label === "三亚凤凰机场").length,
    1,
    "机场条目只出现一次",
  );
  pass("C. 机场节点仅在约束明确时补起点/终点，不臆造、不重复");
}

// ===== D. 批量撤销：多个景点同时恢复时仍回到原始交错位置 =====

{
  let trip = makeTrip();
  const dayId = "day_1";
  trip.itemRegistry.item_B = makeItem("item_B", "南山文化旅游区");
  trip.visits.visit_B = makeVisit("visit_B", "item_B", dayId, 1);
  trip.days[dayId] = {
    ...trip.days[dayId],
    scheduleVisitRefs: ["visit_A", "visit_B"],
    displayOrder: [
      { kind: "hotel", hotelRef: "H" },
      { kind: "visit", visitRef: "visit_A" },
      { kind: "visit", visitRef: "visit_B" },
    ],
  };
  assert.deepEqual(displayKeys(trip), ["hotel:H", "visit:visit_A", "visit:visit_B"]);

  const removed = applyOps(
    trip,
    ["visit_A", "visit_B"].map(
      (visitId) =>
        ({
          op: "remove",
          subjectRef: { kind: "visit" as const, id: visitId },
          fromContainerRef: { kind: "day" as const, dayIndex: 1 },
          reason: "验证批量移除",
        }) as const,
    ),
    { actor: "user_manual", confirmed: true },
  );
  assert.equal(removed.applied.length, 2, "批量 remove 应全部应用");
  trip = syncDisplayOrders(removed.trip);
  assert.deepEqual(displayKeys(trip), ["hotel:H"], "批量移除后只剩酒店 H");

  const undone = applyOps(
    trip,
    [
      {
        op: "plan",
        scopeRef: { kind: "day", dayIndex: 1 },
        assignments: [
          {
            subjectRef: { kind: "visit", id: "visit_A" },
            containerRef: { kind: "day", dayIndex: 1 },
            order: 0,
          },
          {
            subjectRef: { kind: "visit", id: "visit_B" },
            containerRef: { kind: "day", dayIndex: 1 },
            order: 1,
          },
        ],
        reason: "撤销批量移除",
      },
      ...["visit_A", "visit_B"].map(
        (visitId, order) =>
          ({
            op: "move" as const,
            subjectRef: { kind: "visit" as const, id: visitId },
            containerRef: { kind: "day" as const, dayIndex: 1 },
            toOrder: order,
            reason: "恢复批量原位",
          }) as const,
      ),
    ],
    { actor: "user_manual", confirmed: true },
  );
  assert.equal(undone.applied.length, 3, "撤销 plan + 两条 move 应全部应用");
  trip = syncDisplayOrders(undone.trip);

  trip = placeDayDisplayRefs(trip, 1, [
    { kind: "visit", ref: "visit_A", index: 1 },
    { kind: "visit", ref: "visit_B", index: 2 },
  ]);
  assert.deepEqual(
    displayKeys(trip),
    ["hotel:H", "visit:visit_A", "visit:visit_B"],
    "批量撤销应整体回到原始交错位置",
  );
  trip = syncDisplayOrders(trip);
  assert.deepEqual(
    displayKeys(trip),
    ["hotel:H", "visit:visit_A", "visit:visit_B"],
    "批量恢复后同步仍保持交错位置",
  );
  pass("D. 批量撤销多个景点仍恢复原始交错位置");
}

console.log(`\n全部通过：${passed} 组场景`);
