/**
 * Task #323 验证脚本（离线，禁止 live 调用百炼）——返程日行程截止时间规则。
 *
 * PD 口径：
 * 1. 最后一天无返程机票时间（flight_depart 约束）→ 行程截止 15:00；
 * 2. 最后一天有返程机票时间 → 行程截止 = 起飞时间 − 3 小时。
 *
 * 覆盖场景：
 *  S1 prompt 软规则：buildGuidePlannerRulesText 四种拼装形态（optionGroups 完整/降级 ×
 *     trip/day scope）均包含「15:00 截止」「起飞 − 3 小时」两条规则与 Task #323 标注，
 *     且与 #291 返程日走廊规则共存（无矛盾文案：显式声明 3 小时更严、以 #323 条为准）；
 *  S2 纯函数数值：deriveDepartureDayCutoff 全分支——
 *     无约束→15:00/default；18:00 起飞→15:00/flight；09:40 起飞→06:40/flight；
 *     凌晨 01:30 起飞→22:30/flight（跨天取模）；非法 anchorTime→15:00/default 降级；
 *     flight_depart 挂在非最后一天→不消费（15:00/default）；同天多条→取最晚起飞；
 *     空行程→null；
 *  S3 事实块联动：buildTripFacts 的【约束列表】带 anchor= 起飞时间、【行程概况】带
 *     共 N 天——prompt 静态规则所需的两个动态输入对模型可见（规则可执行的前提）。
 *
 * 运行：npx tsx server/src/ai/verify-task323.ts
 */

import assert from "node:assert/strict";
import type { Constraint, Day, DraftScope, Trip } from "@goplay/shared";
import {
  DEFAULT_LAST_DAY_CUTOFF,
  deriveDepartureDayCutoff,
  FLIGHT_CUTOFF_LEAD_MINUTES,
} from "@goplay/shared";
import { buildTripFacts } from "./prompt.js";
import { buildGuidePlannerRulesText } from "../guides/planner.js";

function pass(name: string): void {
  console.log(`✓ ${name}`);
}

// ===== 最小 Trip 构建工具（同 shared/verify-timeSource 形态，不落盘、零副作用） =====

function makeDay(dayIndex: number): Day {
  return {
    dayId: `day_${dayIndex}`,
    dayIndex,
    date: `2026-11-${String(dayIndex + 7).padStart(2, "0")}`,
    departTime: null,
    departTimeOverridden: false,
    scheduleVisitRefs: [],
    lodging: null,
  };
}

function makeConstraint(type: Constraint["type"], dayIndex: number, anchorTime: string): Constraint {
  return {
    constraintId: `c_${type}_${dayIndex}_${anchorTime}`,
    type,
    anchorTime,
    dayIndex,
    label: `${type} day${dayIndex}`,
    locked: true,
  };
}

function makeTrip(dayCount: number, constraints: Constraint[] = []): Trip {
  const dayRefs: string[] = [];
  const days: Record<string, Day> = {};
  for (let i = 1; i <= dayCount; i++) {
    dayRefs.push(`day_${i}`);
    days[`day_${i}`] = makeDay(i);
  }
  return {
    tripId: "trip_verify_323",
    schemaVersion: 2,
    version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: `2026-11-${String(dayCount + 7).padStart(2, "0")}`, nights: dayCount - 1 },
    dayRefs,
    days,
    lodgings: {},
    itemRegistry: {},
    hotelRegistry: {},
    visits: {},
    stops: {},
    evidences: {},
    globalCandidateRefs: [],
    pendingStopRefs: [],
    relationshipSuggestions: {},
    guideSources: {},
    constraints,
    createdAt: "2026-11-03T00:00:00Z",
    updatedAt: "2026-11-03T00:00:00Z",
  } as Trip;
}

// ===== S1 prompt 软规则：四种拼装形态均携带两条截止规则 =====

const FORMS: Array<{ name: string; mentionCount: number; scope: DraftScope; signals?: boolean }> = [
  { name: "全量形态（trip scope，optionGroups 完整）", mentionCount: 10, scope: { kind: "trip" } },
  { name: "降级形态（素材提及不足）", mentionCount: 2, scope: { kind: "trip" } },
  { name: "单日形态（day scope）", mentionCount: 10, scope: { kind: "day", dayIndex: 2 } },
  { name: "景区形态（attraction scope，降级）", mentionCount: 10, scope: { kind: "attraction", visitId: "visit_x" } },
];

for (const form of FORMS) {
  const text = buildGuidePlannerRulesText(form.mentionCount, form.scope, form.signals ?? false);
  // 规则一：无机票时间 → 15:00 截止
  assert.ok(text.includes("Task #323"), `S1[${form.name}] 应带 Task #323 标注`);
  assert.ok(text.includes("截止时间 = 15:00"), `S1[${form.name}] 应含无机票 15:00 截止规则`);
  // 规则二：有机票时间 → 起飞 − 3 小时
  assert.ok(text.includes("起飞时间（anchor 的 HH:MM）− 3 小时"), `S1[${form.name}] 应含 起飞−3h 截止规则`);
  assert.ok(text.includes("flight_depart"), `S1[${form.name}] 截止规则应锚定 flight_depart 约束`);
  // 与 #291 走廊规则共存且显式消解矛盾（3 小时更严、以 #323 条为准）
  assert.ok(text.includes("返程日走廊规则（Task #291）"), `S1[${form.name}] #291 走廊规则应保留`);
  assert.ok(text.includes("比上一条的 2 小时 buffer 更严，以本条为准"), `S1[${form.name}] 应显式声明与 #291 buffer 的取舍`);
  // 宁可不排 + 不挤占其他天
  assert.ok(text.includes("也不得为此把项目挤到更早的天"), `S1[${form.name}] 应禁止把返程日项目挤到更早的天`);
  pass(`S1 ${form.name}`);
}

// optionGroups 内容感知解锁形态（降级 + 信号 → 完整第七节）同样携带规则
{
  const text = buildGuidePlannerRulesText(2, { kind: "trip" }, true);
  assert.ok(text.includes("截止时间 = 15:00") && text.includes("− 3 小时"), "S1[信号解锁形态] 两条截止规则应在位");
  pass("S1 信号解锁形态（mentionCount<5 + signals）");
}

// ===== S2 deriveDepartureDayCutoff 纯函数数值断言 =====

// §2.1 无约束（用户未设定离开时间）→ 15:00 / default
{
  const cutoff = deriveDepartureDayCutoff(makeTrip(5));
  assert.deepEqual(cutoff, { cutoffTime: "15:00", source: "default" }, "§2.1 无约束应 15:00/default");
  assert.equal(DEFAULT_LAST_DAY_CUTOFF, "15:00", "§2.1 常量口径");
  pass("S2 §2.1 无机票时间 → 15:00（default）");
}

// §2.2 最后一天 18:00 起飞 → 15:00 / flight（数值恰好与 default 相同但来源不同）
{
  const trip = makeTrip(5, [makeConstraint("flight_depart", 5, "2026-11-12T18:00:00")]);
  assert.deepEqual(deriveDepartureDayCutoff(trip), { cutoffTime: "15:00", source: "flight" }, "§2.2 18:00−3h=15:00");
  pass("S2 §2.2 起飞 18:00 → 截止 15:00（flight）");
}

// §2.3 最后一天 09:40 起飞 → 06:40 / flight
{
  const trip = makeTrip(3, [makeConstraint("flight_depart", 3, "2026-11-10T09:40:00")]);
  assert.deepEqual(deriveDepartureDayCutoff(trip), { cutoffTime: "06:40", source: "flight" }, "§2.3 09:40−3h=06:40");
  pass("S2 §2.3 起飞 09:40 → 截止 06:40（flight）");
}

// §2.4 凌晨 01:30 起飞 → 22:30 / flight（跨天按 24h 取模）
{
  const trip = makeTrip(3, [makeConstraint("flight_depart", 3, "2026-11-10T01:30:00")]);
  assert.deepEqual(deriveDepartureDayCutoff(trip), { cutoffTime: "22:30", source: "flight" }, "§2.4 01:30−3h=22:30（取模）");
  pass("S2 §2.4 凌晨起飞 01:30 → 截止 22:30（跨天取模）");
}

// §2.5 anchorTime 非法（脏数据）→ 降级 15:00 / default
{
  const trip = makeTrip(3, [makeConstraint("flight_depart", 3, "not-a-time")]);
  assert.deepEqual(deriveDepartureDayCutoff(trip), { cutoffTime: "15:00", source: "default" }, "§2.5 非法 anchor 应降级 default");
  pass("S2 §2.5 非法 anchorTime → 降级 15:00（default）");
}

// §2.6 flight_depart 挂在非最后一天（中途转机返程等）→ 不作为最后一天截止依据
{
  const trip = makeTrip(5, [makeConstraint("flight_depart", 3, "2026-11-10T18:00:00")]);
  assert.deepEqual(deriveDepartureDayCutoff(trip), { cutoffTime: "15:00", source: "default" }, "§2.6 非最后一天的 flight_depart 不消费");
  pass("S2 §2.6 flight_depart 非最后一天 → 不消费（default）");
}

// §2.7 最后一天多条 flight_depart → 取最晚起飞时间
{
  const trip = makeTrip(3, [
    makeConstraint("flight_depart", 3, "2026-11-10T14:00:00"),
    makeConstraint("flight_depart", 3, "2026-11-10T20:30:00"),
  ]);
  assert.deepEqual(deriveDepartureDayCutoff(trip), { cutoffTime: "17:30", source: "flight" }, "§2.7 20:30−3h=17:30（取最晚）");
  pass("S2 §2.7 多条 flight_depart → 取最晚起飞（17:30）");
}

// §2.8 空行程 → null；提前量常量口径
{
  const empty = makeTrip(0);
  assert.equal(deriveDepartureDayCutoff(empty), null, "§2.8 空行程应 null");
  assert.equal(FLIGHT_CUTOFF_LEAD_MINUTES, 180, "§2.8 提前量应为 3 小时");
  pass("S2 §2.8 空行程 → null；FLIGHT_CUTOFF_LEAD_MINUTES=180");
}

// §2.9 纯函数：不修改入参
{
  const trip = makeTrip(3, [makeConstraint("flight_depart", 3, "2026-11-10T18:00:00")]);
  const snapshot = JSON.stringify(trip);
  deriveDepartureDayCutoff(trip);
  assert.equal(JSON.stringify(trip), snapshot, "§2.9 入参不得被修改");
  pass("S2 §2.9 纯函数（入参零改动）");
}

// ===== S3 buildTripFacts 联动：规则所需动态输入对模型可见 =====

{
  const trip = makeTrip(5, [
    makeConstraint("flight_arrive", 1, "2026-11-08T09:40:00"),
    makeConstraint("flight_depart", 5, "2026-11-12T18:00:00"),
  ]);
  const facts = buildTripFacts(trip, { includePending: false, slimVisitFormat: true }).join("\n");
  assert.ok(facts.includes("共 5 天"), "S3 行程概况应含总天数（Day N 可定位）");
  assert.ok(facts.includes("Day5 flight_depart"), "S3 约束列表应含最后一天 flight_depart");
  assert.ok(facts.includes("anchor=2026-11-12T18:00:00"), "S3 约束列表应含起飞 anchorTime（供模型倒推 −3h）");
  pass("S3 buildTripFacts：总天数 + flight_depart anchor 对模型可见");
}

console.log("\n[verify-task323] 全部通过 ✓（S1 prompt 五形态 / S2 纯函数九分支 / S3 事实块联动）");
