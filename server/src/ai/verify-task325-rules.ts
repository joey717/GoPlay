/**
 * Task #325 规则文本验证脚本（离线，禁止 live 调用百炼）。
 *
 * 覆盖：
 * - F11：FIXED_RULES_TEXT 含返程日截止规则 + 抵达日 + 顺路三条（Task #325 核心缺口修复）
 * - planner：buildGuidePlannerRulesText 四种拼装形态均含三条新规则关键词
 * - 体积回归上限：FIXED_RULES_TEXT.length <= 4100
 * - 与 #323/#291 共存无矛盾：verify-task323 的既有断言仍通过
 *
 * 运行：npx tsx server/src/ai/verify-task325-rules.ts
 */

import assert from "node:assert/strict";
import type { DraftScope } from "@goplay/shared";
import { buildIntentPrompt } from "./prompt.js";
import { buildGuidePlannerRulesText } from "../guides/planner.js";
import { SCHEDULE_GEO_RULES_TEXT } from "./scheduleRules.js";

let passCount = 0;
function pass(name: string): void {
  passCount++;
  console.log(`✓ ${name}`);
}

// ===== §1 SCHEDULE_GEO_RULES_TEXT 本体断言 =====

{
  // 规则 1：返程日行程截止
  assert.ok(SCHEDULE_GEO_RULES_TEXT.includes("返程日行程截止"), "§1 应含返程日行程截止规则");
  assert.ok(SCHEDULE_GEO_RULES_TEXT.includes("行程截止=HH:MM(source)"), "§1 应含行程截止标注格式");
  assert.ok(SCHEDULE_GEO_RULES_TEXT.includes("flight_depart"), "§1 应锚定 flight_depart");
  assert.ok(SCHEDULE_GEO_RULES_TEXT.includes("15:00"), "§1 应含无航班时默认截止 15:00");
  assert.ok(SCHEDULE_GEO_RULES_TEXT.includes("不得挤到更早的天"), "§1 应禁止挤到其他天");
  // 规则 2：抵达日低承诺
  assert.ok(SCHEDULE_GEO_RULES_TEXT.includes("抵达日低承诺"), "§1 应含抵达日规则");
  assert.ok(SCHEDULE_GEO_RULES_TEXT.includes("role=arrival"), "§1 应含 role=arrival 锚定");
  assert.ok(SCHEDULE_GEO_RULES_TEXT.includes("已排 2 项时不再新增"), "§1 应含抵达日容量上限");
  // 规则 3：顺路/地理跨度
  assert.ok(SCHEDULE_GEO_RULES_TEXT.includes("顺路/地理跨度"), "§1 应含顺路规则");
  assert.ok(SCHEDULE_GEO_RULES_TEXT.includes("片区="), "§1 应引用片区标注");
  assert.ok(SCHEDULE_GEO_RULES_TEXT.includes("地理跨度=Xkm"), "§1 应引用地理跨度标注");
  assert.ok(SCHEDULE_GEO_RULES_TEXT.includes("最远离机场=Xkm"), "§1 应引用最远离机场标注");
  assert.ok(SCHEDULE_GEO_RULES_TEXT.includes("不得自行臆测方位"), "§1 应禁止臆测方位");
  pass("§1 SCHEDULE_GEO_RULES_TEXT 三条规则关键词全在位");
}

// ===== §2 F11 FIXED_RULES_TEXT 体积与新规则 =====

{
  // buildIntentPrompt 输出含 FIXED_RULES_TEXT（通过最小行程构造来提取）
  const minimalTrip = {
    tripId: "test", schemaVersion: 2, version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: "2026-11-10", nights: 2 },
    dayRefs: ["day_1", "day_2", "day_3"],
    days: {
      day_1: { dayId: "day_1", dayIndex: 1, date: "2026-11-08", departTime: null, departTimeOverridden: false, scheduleVisitRefs: [], lodging: null },
      day_2: { dayId: "day_2", dayIndex: 2, date: "2026-11-09", departTime: null, departTimeOverridden: false, scheduleVisitRefs: [], lodging: null },
      day_3: { dayId: "day_3", dayIndex: 3, date: "2026-11-10", departTime: null, departTimeOverridden: false, scheduleVisitRefs: [], lodging: null },
    },
    lodgings: {}, itemRegistry: {}, hotelRegistry: {}, visits: {}, stops: {},
    evidences: {}, globalCandidateRefs: [], pendingStopRefs: [],
    relationshipSuggestions: {}, guideSources: {}, constraints: [],
    createdAt: "2026-11-03T00:00:00Z", updatedAt: "2026-11-03T00:00:00Z",
  } as any;

  const prompt = buildIntentPrompt(minimalTrip, "测试意图");
  // F11 prompt 应含三条新规则
  assert.ok(prompt.includes("返程日行程截止"), "§2 F11 prompt 应含返程日截止规则");
  assert.ok(prompt.includes("抵达日低承诺"), "§2 F11 prompt 应含抵达日规则");
  assert.ok(prompt.includes("顺路/地理跨度"), "§2 F11 prompt 应含顺路规则");
  assert.ok(prompt.includes("Task #325"), "§2 F11 prompt 应含 Task #325 标注");
  pass("§2 F11 FIXED_RULES_TEXT 含三条新规则");
}

// ===== §3 FIXED_RULES_TEXT 体积回归上限 =====

{
  // 提取 FIXED_RULES_TEXT 部分（从 prompt 中截取【系统规则】到【版本】之间）
  const minimalTrip = {
    tripId: "test", schemaVersion: 2, version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: "2026-11-08", nights: 0 },
    dayRefs: ["day_1"],
    days: { day_1: { dayId: "day_1", dayIndex: 1, date: "2026-11-08", departTime: null, departTimeOverridden: false, scheduleVisitRefs: [], lodging: null } },
    lodgings: {}, itemRegistry: {}, hotelRegistry: {}, visits: {}, stops: {},
    evidences: {}, globalCandidateRefs: [], pendingStopRefs: [],
    relationshipSuggestions: {}, guideSources: {}, constraints: [],
    createdAt: "2026-11-03T00:00:00Z", updatedAt: "2026-11-03T00:00:00Z",
  } as any;
  const prompt = buildIntentPrompt(minimalTrip, "x");
  const rulesStart = prompt.indexOf("【系统规则】\n") + "【系统规则】\n".length;
  const rulesEnd = prompt.indexOf("\n\n【版本】");
  const fixedRules = prompt.slice(rulesStart, rulesEnd);
  assert.ok(fixedRules.length <= 4100, `§3 FIXED_RULES_TEXT.length=${fixedRules.length} 应 ≤4100`);
  console.log(`  FIXED_RULES_TEXT 体积: ${fixedRules.length} 字符（上限 4100）`);
  pass(`§3 FIXED_RULES_TEXT 体积回归上限 ≤4100（实际 ${fixedRules.length}）`);
}

// ===== §4 planner 四种拼装形态均含三条新规则关键词 =====

const FORMS: Array<{ name: string; mentionCount: number; scope: DraftScope; signals?: boolean }> = [
  { name: "全量形态（trip scope，optionGroups 完整）", mentionCount: 10, scope: { kind: "trip" } },
  { name: "降级形态（素材提及不足）", mentionCount: 2, scope: { kind: "trip" } },
  { name: "单日形态（day scope）", mentionCount: 10, scope: { kind: "day", dayIndex: 2 } },
  { name: "景区形态（attraction scope，降级）", mentionCount: 10, scope: { kind: "attraction", visitId: "visit_x" } },
];

for (const form of FORMS) {
  const text = buildGuidePlannerRulesText(form.mentionCount, form.scope, form.signals ?? false);
  // 规则 1：返程日截止（Task #323 既有文本）
  assert.ok(text.includes("Task #323"), `§4[${form.name}] 应含 Task #323 截止规则`);
  assert.ok(text.includes("截止时间 = 15:00"), `§4[${form.name}] 应含 15:00 截止`);
  // 规则 2：抵达日（Task #291 既有文本）
  assert.ok(text.includes("抵达日规则（Task #291）"), `§4[${form.name}] 应含抵达日规则`);
  assert.ok(text.includes("flight_arrive"), `§4[${form.name}] 应含 flight_arrive 锚定`);
  // 规则 3：方向综合评估（#291 + #325）
  assert.ok(text.includes("#325"), `§4[${form.name}] 应含 Task #325 标注（方向综合评估）`);
  assert.ok(text.includes("地理跨度="), `§4[${form.name}] 应引用地理跨度事实行`);
  assert.ok(text.includes("最远离机场="), `§4[${form.name}] 应引用最远离机场事实行`);
  assert.ok(text.includes("片区="), `§4[${form.name}] 应引用片区标注`);
  assert.ok(text.includes("服务端已给出实测距离"), `§4[${form.name}] 应声明服务端已给实测数据`);
  pass(`§4 planner ${form.name}`);
}

// ===== §5 与 #323/#291 共存无矛盾 =====

{
  const text = buildGuidePlannerRulesText(10, { kind: "trip" });
  // verify-task323 的核心断言必须仍然通过
  assert.ok(text.includes("返程日走廊规则（Task #291）"), "§5 #291 走廊规则应保留");
  assert.ok(text.includes("比上一条的 2 小时 buffer 更严，以本条为准"), "§5 应显式声明与 #291 buffer 的取舍");
  assert.ok(text.includes("也不得为此把项目挤到更早的天"), "§5 应禁止把返程日项目挤到更早的天");
  assert.ok(text.includes("起飞时间（anchor 的 HH:MM）− 3 小时"), "§5 起飞−3h 规则应保留");
  pass("§5 与 #323/#291 共存无矛盾（verify-task323 核心断言仍通过）");
}

console.log(`\n[verify-task325-rules] 全部通过 ✓（${passCount} 条断言）`);
