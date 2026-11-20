/**
 * Task #248 确定性验证（离线：不调用百炼 / FlyAI / 小红书）。
 *
 * 背景：旧实现把「重排 / 重新做 / 重新安排 / 替换 DayN」当作普通排天指令（append）——
 * 当天旧安排原样保留、新规划追加到末尾，与用户「整日替换」意图不符；且补充句
 * 「帮我重新做下DAY3的亚龙湾的行程，基于这个攻略」旧解析得到 placeText
 * 「的亚龙湾的行程」（前导助词 / 尾部计划名词未剥离）。
 *
 * 实现（Task #248）：
 *   解析：replace 意图写 mode="replace"（append 不写字段，旧草案 / 旧断言零感知）；
 *     剥前导请求语气与助词、尾部「的行程 / 路线 / 安排 / 规划 / 计划」与裸「的」；
 *     「基于这个攻略」等连接语不再进入地点文本；「把 X 重新安排到 DayN」是移动语序，
 *     仍按 append 处理。
 *   生成：enforceDraftDirectives 对 replace 指令的目标天生成确定性 remove
 *     （day → globalPool，复用既有 remove 语义，不新增特权 op），锁定 / 已购项保留在
 *     原天并生成 target_day_replace / replace_kept_protected 告知冲突；模型针对被移回
 *     实体的跨天 / 属性 / 重复 remove 操作被清洗（不重复、不产生非法引用）。
 *   应用：移回 remove 逐条过 G1/G3 护栏、仍计入 30% 阈值，但以 user_confirmed 执行
 *     （草案预览已逐项列出，点应用即确认，不走 needsProposal 形成「未替换」假成功）。
 *
 * 验证矩阵：
 *   S1 真实补充句解析（变体矩阵 + append 不新增 mode 字段）
 *   S2 整日替换全链路：Day3 = 3 普通 + 1 锁定 → 普通项回候选池、锁定项保留、
 *      其他 Day 不变、草案元数据 / 冲突 / 满足校验 / prompt 齐全
 *   S3 与模型 plan 组合：模型计划排回目标天的旧安排保留；指向其他天的操作被清洗
 *   S4 30% 阈值回归：移回 remove 不豁免阈值，整批拒绝时旧安排仍在 Day3
 *   S5 append 回归：普通「安排到 Day3」不产生 remove，仍为 target_day_occupied
 *   S6 否定语义回归：「不要重排Day3」「不用重新安排Day3」「无需替换Day3」不解析为
 *      replace（也不退化成 append）；「不要忘记重排Day3」仍是 replace
 *   S7 补排门控（生成侧）：模型规划为空时不得生成任何移回，移回集清空并写
 *      replaceSkippedReason，requirementChecks 不报 met
 *   S8 明确确认门控（应用侧）：未确认 / draftId 不一致 / confirmed=false 都不移回；
 *      正确 draftId + confirmed=true 才执行
 *   S9 同一目标日多指令：「重排DAY3，DAY3安排第一市场」先汇总全部点名主体再统一计算
 *      移回集（不得先 remove 第一市场再让第二条指令空操作）
 *   S10 区域占位点位：自定义「亚龙湾」不作指令锚点 / 不生成移回 / 不作操作目标（数据保留）
 *
 * 运行：npx tsx server/src/guides/verify-task248.ts
 * 临时行程（server/data）在 finally 全部清理，不影响用户既有数据。
 */

import "../env.js";
import assert from "node:assert/strict";
import type { Item, Operation, PendingGuideDraft, Trip, Visit } from "@goplay/shared";
import { checkPendingGuideDraftFreshness, collectAreaPlaceholderVisitIds } from "@goplay/shared";
import { createFixtureSanyaTrip, tripStore } from "../persistence/store.js";
import { applyGuideDraft } from "./planner.js";
import {
  enforceDraftDirectives,
  formatDirectivesPrompt,
  parseDraftDirectives,
} from "./directives.js";
import { buildTripFacts } from "../ai/prompt.js";

// ===== 基础辅助 =====

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

function buildItem(itemId: string, name: string, providerId: string | null = null): Item {
  return {
    itemId,
    name,
    // Task #253：区域占位判定与 prompt 候选区都以 providerId 区分「飞猪真实 POI / 自定义点位」
    origin: providerId === null ? "custom" : "fliggy",
    providerId,
    address: null,
    category: null,
    coords: null,
    suggestMinutes: null,
    mainPic: null,
    ticketInfo: null,
    jumpUrl: null,
    sourceEvidenceRefs: [],
  };
}

/** 向指定 Day 追加一个普通 Visit（order = 当天末尾） */
function addVisitToDay(
  trip: Trip,
  input: {
    visitId: string;
    name: string;
    dayIndex: number;
    locked?: boolean;
    purchaseState?: Visit["purchaseState"];
    /** 飞猪 POI 的真实 id；缺省 = 自定义点位（providerId=null） */
    providerId?: string | null;
  },
): void {
  const day = trip.days[`day_${input.dayIndex}`];
  assert.ok(day !== undefined, `Day ${input.dayIndex} 应存在`);
  trip.itemRegistry[`item_${input.visitId}`] = buildItem(
    `item_${input.visitId}`,
    input.name,
    input.providerId ?? null,
  );
  const visit: Visit = {
    visitId: input.visitId,
    dayRef: day.dayId,
    pointRef: `item_${input.visitId}`,
    kind: "ordinary",
    visitMode: "custom",
    order: day.scheduleVisitRefs.length,
    windowStart: null,
    windowEnd: null,
    startTime: null,
    endTime: null,
    startTimeOverridden: false,
    endTimeOverridden: false,
    reservedMinutes: null,
    effectiveMinutes: null,
    externalLeg: { mode: "驾车", minutes: 20, note: null, source: "user" },
    childStopRefs: [],
    alternateStopRefs: [],
    sourceMentionRefs: [],
    purchaseState: input.purchaseState ?? "unknown",
    locked: input.locked ?? false,
    userAdjusted: false,
    removedFrom: null,
    removedAt: null,
  };
  trip.visits[input.visitId] = visit;
  day.scheduleVisitRefs.push(input.visitId);
}

/** 向全局候选池追加一个 Visit（dayRef=null + 入 globalCandidateRefs，保证落盘一致性） */
function addPoolVisit(trip: Trip, visitId: string, name: string): void {
  trip.itemRegistry[`item_${visitId}`] = buildItem(`item_${visitId}`, name);
  const visit: Visit = {
    visitId,
    dayRef: null,
    pointRef: `item_${visitId}`,
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
    externalLeg: { mode: "驾车", minutes: 20, note: null, source: "user" },
    childStopRefs: [],
    alternateStopRefs: [],
    sourceMentionRefs: [],
    purchaseState: "unknown",
    locked: false,
    userAdjusted: false,
    removedFrom: null,
    removedAt: null,
  };
  trip.visits[visitId] = visit;
  trip.globalCandidateRefs.push({ kind: "visit", id: visitId });
}

/**
 * 构造整日替换夹具：Day3 = 第一市场 + 南山文化旅游区 + 天涯海角（普通）+ 西岛（锁定），
 * 亚龙湾热带天堂森林公园在全局候选池（本轮重排主题，由模型 plan 排入 Day3）。
 */
async function buildReplaceFixture(): Promise<Trip> {
  const trip = await createFixtureSanyaTrip();
  createdTripIds.push(trip.tripId);
  addVisitToDay(trip, { visitId: "visit_nanshan", name: "南山文化旅游区", dayIndex: 3 });
  addVisitToDay(trip, { visitId: "visit_tianya", name: "天涯海角", dayIndex: 3 });
  addVisitToDay(trip, { visitId: "visit_locked", name: "西岛", dayIndex: 3, locked: true });
  addPoolVisit(trip, "visit_ylw", "亚龙湾热带天堂森林公园");
  await tripStore.save(trip);
  return loadTrip(trip.tripId);
}

/**
 * 把草案手术式写入行程并落盘（baseTripVersion 预判 tripStore.save 恰自增 1，
 * 保证应用时版本保护 fresh）；写盘后断言 freshness。返回 draftId 供 replaceConfirm 绑定。
 */
async function attachDraft(
  tripId: string,
  operations: Operation[],
  directives?: PendingGuideDraft["directives"],
): Promise<string> {
  const trip = await loadTrip(tripId);
  const draft: PendingGuideDraft = {
    draftId: `draft_task248_${trip.version + 1}`,
    baseTripVersion: trip.version + 1,
    scope: { kind: "trip" },
    sourceSnapshots: [],
    mentionIds: [],
    note: null,
    createdAt: new Date().toISOString(),
    output: { operations, snippets: [] },
    ...(directives !== undefined && directives.length > 0 ? { directives } : {}),
  };
  trip.pendingGuideDraft = draft;
  await tripStore.save(trip);
  const saved = await loadTrip(tripId);
  const attached = saved.pendingGuideDraft;
  assert.ok(attached !== undefined, "草案应已落盘");
  const freshness = checkPendingGuideDraftFreshness(attached, saved);
  assert.equal(freshness.fresh, true, `草案应 fresh（${freshness.details.join("；")}）`);
  return draft.draftId;
}

/** 构造「把 visit_ylw 从候选池排入 Day3」的合法 plan */
function planYlwIntoDay3(extraAssignments: { visitId: string; order: number }[] = []): Operation {
  return {
    op: "plan",
    scopeRef: { kind: "day", dayIndex: 3 },
    assignments: [
      {
        subjectRef: { kind: "visit", id: "visit_ylw" },
        containerRef: { kind: "day", dayIndex: 3 },
        order: 0,
      },
      ...extraAssignments.map((entry) => ({
        subjectRef: { kind: "visit" as const, id: entry.visitId },
        containerRef: { kind: "day" as const, dayIndex: 3 },
        order: entry.order,
      })),
    ],
    reason: "按攻略把亚龙湾排入 Day3",
  };
}

function visitIdsOfDay(trip: Trip, dayIndex: number): string[] {
  return trip.days[`day_${dayIndex}`]?.scheduleVisitRefs ?? [];
}

// ===== 场景 =====

/** S1：真实补充句解析 + append 不新增 mode 字段 */
async function scenarioParse(): Promise<void> {
  const trip = await buildReplaceFixture();
  const parse = (note: string) => parseDraftDirectives(note, trip);

  const main = parse("帮我重新做下DAY3的亚龙湾的行程，基于这个攻略");
  assert.equal(main.length, 1, "整句应只解析出一条日期指令（「基于这个攻略」不得自成指令）");
  assert.equal(main[0]?.dayIndex, 3);
  assert.equal(main[0]?.placeText, "亚龙湾", "应剥离前导助词「的」与尾部「的行程」");
  assert.equal(main[0]?.mode, "replace", "「重新做」应识别为整日替换");
  assert.deepEqual(main[0]?.resolvedVisitIds, ["visit_ylw"]);
  assert.equal(main[0]?.rawSentence, "帮我重新做下DAY3的亚龙湾的行程", "原句溯源只保留分句原文");

  // 尾部计划名词矩阵 + 无地点形态
  const route = parse("重新安排Day3的亚龙湾的路线，参考攻略");
  assert.equal(route[0]?.placeText, "亚龙湾");
  assert.equal(route[0]?.mode, "replace");
  const plan = parse("重新做一下第3天的计划");
  assert.equal(plan[0]?.dayIndex, 3);
  assert.equal(plan[0]?.placeText, "", "裸「计划」不得成为地点文本");
  assert.equal(plan[0]?.mode, "replace");
  const wholeDay = parse("帮我重排一下DAY4");
  assert.equal(wholeDay[0]?.placeText, "");
  assert.equal(wholeDay[0]?.mode, "replace");

  // 移动语序保护：「把 X 重新安排到 DayN」仍是 append（且不得被识别成替换）
  const moveOrder = parse("把亚龙湾重新安排到Day3");
  assert.equal(moveOrder[0]?.mode, undefined, "「把 X 重新安排到 DayN」是移动指令，不是整日替换");
  assert.equal("mode" in (moveOrder[0] ?? {}), false, "append 不得新增 mode 字段（旧草案 / 旧断言零感知）");

  // 普通「安排到 DayN」仍是 append
  const append = parse("DAY3安排亚龙湾");
  assert.equal(append[0]?.placeText, "亚龙湾");
  assert.equal(append[0]?.mode, undefined);
  assert.equal("mode" in (append[0] ?? {}), false);

  // 安全边界：点名地点在行程中不存在 → 不生成移回（不为无法落地的请求清空目标天），以 unmet 告知
  const unknown = parse("重新做下DAY3的埃菲尔铁塔行程");
  assert.equal(unknown[0]?.mode, "replace");
  assert.equal(unknown[0]?.placeText, "埃菲尔铁塔");
  const unknownEnforced = enforceDraftDirectives(trip, unknown, []);
  assert.equal(
    unknownEnforced.operations.some((op) => op.op === "remove"),
    false,
    "点名地点不存在时不得清空目标天",
  );
  assert.equal(unknownEnforced.requirementChecks[0]?.status, "unmet", "应明确告知无法安排该地点");

  // prompt 注入：replace 需声明服务端移回 + 不准挪到其他天
  const promptLines = formatDirectivesPrompt(trip, main).join("\n");
  assert.ok(promptLines.includes("整日替换"), "replace 指令块应声明整日替换语义");
  assert.ok(promptLines.includes("移回候选池"), "应告知模型服务端会把旧安排移回候选池");
  assert.ok(promptLines.includes("亚龙湾热带天堂森林公园"), "应携带重排主题的实体名");
  const appendPrompt = formatDirectivesPrompt(trip, append).join("\n");
  assert.ok(!appendPrompt.includes("整日替换"), "append 指令块不得混入整日替换约束");

  pass("S1 解析：真实补充句 / 尾部计划名词 / 移动语序保护 / append 不新增 mode / prompt 注入");
}

/** S2：整日替换全链路（生成 → 预览元数据 → 两阶段应用） */
async function scenarioReplaceEndToEnd(): Promise<void> {
  const trip = await buildReplaceFixture();
  assert.deepEqual(visitIdsOfDay(trip, 3), ["visit_market", "visit_nanshan", "visit_tianya", "visit_locked"]);

  const directives = parseDraftDirectives("帮我重新做下DAY3的亚龙湾的行程，基于这个攻略", trip);
  const modelOps: Operation[] = [
    planYlwIntoDay3(),
    { op: "setDuration", subjectRef: { kind: "visit", id: "visit_ylw" }, minutes: 240, reason: "亚龙湾半天" },
    // 模型把旧安排挪到其他天：应被清洗（整日替换下旧安排只回候选池，不散到其他天）
    {
      op: "move",
      subjectRef: { kind: "visit", id: "visit_market" },
      containerRef: { kind: "day", dayIndex: 4 },
      toOrder: 0,
      reason: "模型自作主张把第一市场挪到 Day4",
    },
    // 针对将被移回旧安排的属性调整：应被清洗
    { op: "setDuration", subjectRef: { kind: "visit", id: "visit_tianya" }, minutes: 90, reason: "天涯海角 90 分钟" },
    // 与确定性移回重复的 remove：应被清洗（不重复）
    {
      op: "remove",
      subjectRef: { kind: "visit", id: "visit_nanshan" },
      fromContainerRef: { kind: "day", dayIndex: 3 },
      reason: "模型自己也移除南山",
    },
  ];

  const enforced = enforceDraftDirectives(trip, directives, modelOps);
  const annotated = enforced.directives[0];
  assert.equal(annotated?.mode, "replace");
  assert.deepEqual(
    annotated?.replaceRemovedVisitIds,
    ["visit_market", "visit_nanshan", "visit_tianya"],
    "目标天未锁定 / 未购买的普通项（排除点名锚点）应移回候选池",
  );
  assert.deepEqual(annotated?.replaceKeptVisitIds, ["visit_locked"], "锁定项应保留并记录");
  assert.deepEqual(visitIdsOfDay(trip, 3), [
    "visit_market",
    "visit_nanshan",
    "visit_tianya",
    "visit_locked",
  ], "生成阶段不得修改输入行程");

  const removeOps = enforced.operations.filter(
    (op): op is Extract<Operation, { op: "remove" }> => op.op === "remove",
  );
  assert.equal(removeOps.length, 3, "确定性移回应恰好 3 条（模型重复 remove 被清洗，不重复）");
  assert.deepEqual(
    removeOps.map((op) => (op.subjectRef.kind === "visit" ? op.subjectRef.id : "")),
    ["visit_market", "visit_nanshan", "visit_tianya"],
  );
  for (const op of removeOps) {
    assert.equal(op.fromContainerRef.kind, "day");
    assert.equal(op.fromContainerRef.kind === "day" ? op.fromContainerRef.dayIndex : -1, 3);
    assert.match(op.reason, /移回候选池/, "移回操作需携带用户可读原因");
  }
  assert.equal(
    enforced.operations.some(
      (op) => op.op === "move" && op.subjectRef.kind === "visit" && op.subjectRef.id === "visit_market",
    ),
    false,
    "把旧安排挪到其他天的 move 必须被清洗",
  );
  assert.equal(
    enforced.operations.some(
      (op) => op.op === "setDuration" && op.subjectRef.kind === "visit" && op.subjectRef.id === "visit_tianya",
    ),
    false,
    "针对被移回旧安排的属性调整必须被清洗",
  );
  assert.ok(
    enforced.operations.some((op) => op.op === "setDuration" && op.subjectRef.kind === "visit" && op.subjectRef.id === "visit_ylw"),
    "针对重排主题的合法属性调整应保留",
  );
  assert.ok(enforced.operations.some((op) => op.op === "plan"), "模型把主题排入 Day3 的 plan 应保留（不重复补排）");
  assert.equal(enforced.removedOps.length, 3, "被清洗的模型操作应有记录（move / 旧安排属性 / 重复 remove）");

  // 冲突：整日替换摘要 + 保护项保留告知；不再出现「追加到当天末尾」的 occupied 告知
  const kinds = enforced.conflicts.map((conflict) => conflict.kind);
  assert.ok(kinds.includes("target_day_replace"), "应生成整日替换摘要冲突");
  assert.ok(kinds.includes("replace_kept_protected"), "锁定 / 已购保留项应有确认信息");
  assert.equal(kinds.includes("target_day_occupied"), false, "整日替换不得再提示「追加到当天末尾」");
  assert.equal(kinds.includes("target_day_locked"), false, "整日替换不把保护项挪到其他天");
  const replaceConflict = enforced.conflicts.find((conflict) => conflict.kind === "target_day_replace");
  assert.match(replaceConflict?.detail ?? "", /第一市场/, "摘要应列出将移回候选池的项目");
  assert.match(replaceConflict?.detail ?? "", /西岛/, "摘要应说明保护项保留");
  assert.equal(replaceConflict?.resolution, null, "纯告知项无可执行 resolution");
  const keptConflict = enforced.conflicts.find((conflict) => conflict.kind === "replace_kept_protected");
  assert.equal(keptConflict?.subjectLabel, "西岛");
  assert.equal(keptConflict?.resolution, null, "保护项保留为告知，不可勾选执行");
  assert.match(keptConflict?.detail ?? "", /保持|保留/);

  // 满足校验（生成阶段推演）
  const check = enforced.requirementChecks[0];
  assert.equal(check?.status, "met");
  assert.match(check?.detail ?? "", /移回候选池/);
  assert.match(check?.detail ?? "", /亚龙湾/);

  // 应用：移回 remove 走 user_confirmed（不进 needsProposal），仍过护栏
  // Task #253：整日移回必须带与当前草案绑定的明确确认
  const draftId = await attachDraft(trip.tripId, enforced.operations, enforced.directives);
  const result = await applyGuideDraft(trip.tripId, undefined, { draftId, confirmed: true });
  assert.equal(result.type, "applied", `不应产生待确认提案（实际 ${JSON.stringify(result.needsProposal)}）`);
  assert.equal(result.needsProposal.length, 0);
  assert.equal(result.rejectedCount, 0, `不应有护栏拒绝（${result.rejectSummary ?? ""}）`);

  const after = await loadTrip(trip.tripId);
  assert.deepEqual(
    visitIdsOfDay(after, 3),
    ["visit_ylw", "visit_locked"],
    "应用后 Day3 = 本轮重排主题 + 保留的锁定项",
  );
  for (const visitId of ["visit_market", "visit_nanshan", "visit_tianya"]) {
    assert.equal(after.visits[visitId]?.dayRef, null, `${visitId} 应已离开 Day`);
    assert.equal(after.visits[visitId]?.order, null);
    assert.ok(
      after.globalCandidateRefs.some((ref) => ref.kind === "visit" && ref.id === visitId),
      `${visitId} 应进入候选池`,
    );
  }
  assert.equal(after.visits.visit_locked?.dayRef, "day_3", "锁定项保留原天");
  assert.equal(after.visits.visit_locked?.locked, true);

  // 其他 Day 不变
  assert.deepEqual(visitIdsOfDay(after, 1), []);
  assert.deepEqual(visitIdsOfDay(after, 2), ["visit_wzz"]);
  assert.deepEqual(visitIdsOfDay(after, 4), []);
  assert.deepEqual(visitIdsOfDay(after, 5), []);
  assert.equal(after.pendingGuideDraft, undefined, "草案应一次性消费");

  // 满足校验（应用后按真实行程重算）
  const applyCheck = result.requirementChecks[0];
  assert.equal(applyCheck?.status, "met");
  assert.match(applyCheck?.detail ?? "", /已移回候选池/);
  assert.match(applyCheck?.detail ?? "", /西岛/, "保留项应出现在满足说明中");

  pass("S2 整日替换全链路：3 普通回候选池 / 锁定保留 / 其他 Day 不变 / 草案元数据与冲突齐全");
}

/** S3：与模型 plan 组合——模型显式排回目标天的旧安排保留，不重复、不产生非法引用 */
async function scenarioModelKeepsOldItem(): Promise<void> {
  const trip = await buildReplaceFixture();
  const directives = parseDraftDirectives("帮我重新做下DAY3的亚龙湾的行程，基于这个攻略", trip);
  const modelOps: Operation[] = [planYlwIntoDay3([{ visitId: "visit_market", order: 1 }])];

  const enforced = enforceDraftDirectives(trip, directives, modelOps);
  assert.deepEqual(
    enforced.directives[0]?.replaceRemovedVisitIds,
    ["visit_nanshan", "visit_tianya"],
    "模型显式 plan 回目标天的旧安排应视为保留，不再移回",
  );
  assert.equal(
    enforced.operations.some(
      (op) => op.op === "remove" && op.subjectRef.kind === "visit" && op.subjectRef.id === "visit_market",
    ),
    false,
    "保留项不得生成 remove（避免移回与 plan 竞态）",
  );
  const plan = enforced.operations.find((op): op is Extract<Operation, { op: "plan" }> => op.op === "plan");
  assert.equal(plan?.assignments.length, 2, "plan 中引用保留项的 assignment 不得被剔除");

  const draftId = await attachDraft(trip.tripId, enforced.operations, enforced.directives);
  const result = await applyGuideDraft(trip.tripId, undefined, { draftId, confirmed: true });
  assert.equal(result.rejectedCount, 0, `不应有护栏拒绝（${result.rejectSummary ?? ""}）`);

  const after = await loadTrip(trip.tripId);
  const day3 = visitIdsOfDay(after, 3);
  assert.deepEqual(day3, ["visit_ylw", "visit_market", "visit_locked"], "保留项与锁定项同留在 Day3");
  assert.equal(new Set(day3).size, day3.length, "Day3 不得出现重复 Visit 引用");
  assert.equal(after.visits.visit_nanshan?.dayRef, null);
  assert.equal(after.visits.visit_tianya?.dayRef, null);

  pass("S3 与模型 plan 组合：保留项不重复移回 / 无非法引用 / 应用后无重复");
}

/** S4：30% 阈值回归——移回 remove 不豁免阈值 */
async function scenarioThreshold(): Promise<void> {
  const trip = await createFixtureSanyaTrip();
  createdTripIds.push(trip.tripId);
  // Task #253：必须有能落地的新安排，否则生成侧补排门控会先跳过移回，阈值场景无法触发
  addPoolVisit(trip, "visit_extra", "南山文化旅游区");
  await tripStore.save(trip);
  const loaded = await loadTrip(trip.tripId);
  assert.deepEqual(visitIdsOfDay(loaded, 3), ["visit_market"]);

  const directives = parseDraftDirectives("重新做下DAY3的行程", loaded);
  assert.equal(directives[0]?.mode, "replace");
  assert.equal(directives[0]?.placeText, "");
  const modelOps: Operation[] = [
    {
      op: "plan",
      scopeRef: { kind: "day", dayIndex: 3 },
      assignments: [
        { subjectRef: { kind: "visit", id: "visit_extra" }, containerRef: { kind: "day", dayIndex: 3 }, order: 0 },
      ],
      reason: "把新安排排进 Day3",
    },
    { op: "setDuration", subjectRef: { kind: "visit", id: "visit_ghost" }, minutes: 30, reason: "引用不存在的 visit" },
  ];
  const enforced = enforceDraftDirectives(loaded, directives, modelOps);
  assert.equal(enforced.operations.filter((op) => op.op === "remove").length, 1, "应有 1 条确定性移回");

  const draftId = await attachDraft(loaded.tripId, enforced.operations, enforced.directives);
  const result = await applyGuideDraft(loaded.tripId, undefined, { draftId, confirmed: true });
  // 3 条操作中 1 条违规 → 33% > 30% → 整批拒绝（移回 remove 不获得豁免）
  assert.equal(result.allRejected, true, "移回操作不得绕过 30% 阈值");
  assert.equal(result.applied.length, 0);

  const after = await loadTrip(loaded.tripId);
  assert.deepEqual(visitIdsOfDay(after, 3), ["visit_market"], "整批拒绝后 Day3 应逐字段原状");
  assert.equal(after.visits.visit_market?.dayRef, "day_3");
  assert.equal(
    after.globalCandidateRefs.some((ref) => ref.kind === "visit" && ref.id === "visit_market"),
    false,
    "整批拒绝后不得残留移回副作用",
  );
  const check = result.requirementChecks[0];
  assert.notEqual(check?.status, "met", "整批拒绝后整日替换不应报告已满足");

  pass("S4 30% 阈值回归：移回 remove 计入分母 / 整批拒绝后行程原状");
}

/** S5：append 回归——普通「安排到 Day3」不产生 remove */
async function scenarioAppendUnchanged(): Promise<void> {
  const trip = await buildReplaceFixture();
  const directives = parseDraftDirectives("DAY3安排亚龙湾", trip);
  assert.equal(directives[0]?.mode, undefined);

  const enforced = enforceDraftDirectives(trip, directives, []);
  assert.equal(
    enforced.operations.some((op) => op.op === "remove"),
    false,
    "append 指令不得生成移回操作",
  );
  const transfer = enforced.operations.find((op) => op.op === "transfer");
  assert.ok(transfer, "候选池主题应被补排 transfer");
  assert.equal(enforced.directives[0]?.replaceRemovedVisitIds, undefined, "append 指令不写 replace 元数据");
  const kinds = enforced.conflicts.map((conflict) => conflict.kind);
  assert.ok(kinds.includes("target_day_occupied"), "append 仍提示当天已有安排（追加不覆盖）");
  assert.equal(kinds.includes("target_day_replace"), false);

  pass("S5 append 回归：不生成 remove / 无 replace 元数据 / 仍为 target_day_occupied");
}

/** S6：否定语义——「不要重排Day3」等不得解析为整日替换（也不退化成追加） */
async function scenarioNegation(): Promise<void> {
  const trip = await buildReplaceFixture();
  const parse = (note: string) => parseDraftDirectives(note, trip);

  for (const note of [
    "不要重排Day3",
    "不用重新安排Day3",
    "无需替换Day3",
    "Day3不用重排",
    "先不要重新做DAY3",
    "暂时别重排DAY3",
  ]) {
    const parsed = parse(note);
    assert.equal(parsed.length, 0, `「${note}」不得生成任何日期指令（既不替换也不追加）`);
  }

  // 否定形固定句式实际是肯定命令：仍应为整日替换
  for (const note of ["不要忘记重排Day3", "别忘了重新做DAY3"]) {
    const parsed = parse(note);
    assert.equal(parsed[0]?.mode, "replace", `「${note}」是肯定命令，应为整日替换`);
  }

  // 未否定的陈述仍照旧识别
  const affirmative = parse("帮我重新做下DAY3的亚龙湾的行程");
  assert.equal(affirmative[0]?.mode, "replace");

  pass("S6 否定语义：否定语序不成指令 / 肯定句式不受抑 / 否定形固定句式仍为 replace");
}

/** S7：生成侧补排门控——没有任何新安排能排入目标天时，不得只清空不重排 */
async function scenarioEmptyPlanNoDetach(): Promise<void> {
  const trip = await buildReplaceFixture();
  // 整日替换但无主题地点：既无模型规划，服务端也无补排来源 → 目标天不可能补排
  const directives = parseDraftDirectives("重新做下DAY3的行程", trip);
  assert.equal(directives[0]?.mode, "replace");
  assert.equal(directives[0]?.placeText, "");

  const enforced = enforceDraftDirectives(trip, directives, []);
  assert.equal(
    enforced.operations.some((op) => op.op === "remove"),
    false,
    "没有任何新安排能落地时不得移回旧安排（否则退化为只清空不重排）",
  );
  assert.equal(enforced.operations.length, 0, "无模型规划 + 无主题地点 → 应该零操作");
  assert.deepEqual(enforced.directives[0]?.replaceRemovedVisitIds, [], "移回集必须清空");
  assert.ok(
    (enforced.directives[0]?.replaceSkippedReason ?? "").includes("Day 3"),
    "应在指令上记录跳过原因（供预览展示）",
  );
  const check = enforced.requirementChecks[0];
  assert.notEqual(check?.status, "met", "未执行移回不得报告已满足");
  assert.match(check?.detail ?? "", /未执行整日移回/, "满足说明必须写明整日移回未执行");
  assert.deepEqual(
    visitIdsOfDay(trip, 3),
    ["visit_market", "visit_nanshan", "visit_tianya", "visit_locked"],
    "生成阶段不得修改输入行程",
  );

  // 对照组：点名了主题地点时，服务端补排的 transfer 本就算「新安排落地」→ 移回照常执行
  const withTheme = enforceDraftDirectives(
    trip,
    parseDraftDirectives("重新做下DAY3的亚龙湾的行程", trip),
    [],
  );
  assert.ok(
    withTheme.operations.some((op) => op.op === "transfer"),
    "点名主题时应由服务端补排 transfer",
  );
  assert.equal(
    withTheme.directives[0]?.replaceRemovedVisitIds?.length,
    3,
    "有确定性的主题补排时，移回不应被门控跳过",
  );

  pass("S7 补排门控：零可落地安排不移回 / 主题补排视为落地 / 原因与 unmet 说明齐全");
}

/** S8：应用侧明确确认门控——缺确认 / draftId 不一致 / confirmed=false 都不移回 */
async function scenarioApplyConfirmationGating(): Promise<void> {
  const note = "帮我重新做下DAY3的亚龙湾的行程，基于这个攻略";

  /** 每个子场景独立夹具：草案被应用即一次性消费，不能复用 */
  const prepare = async (): Promise<{
    tripId: string;
    draftId: string;
    baseline: string[];
  }> => {
    const trip = await buildReplaceFixture();
    const enforced = enforceDraftDirectives(trip, parseDraftDirectives(note, trip), [planYlwIntoDay3()]);
    assert.equal(enforced.directives[0]?.replaceRemovedVisitIds?.length, 3, "夹具应有 3 项待移回");
    const draftId = await attachDraft(trip.tripId, enforced.operations, enforced.directives);
    return { tripId: trip.tripId, draftId, baseline: visitIdsOfDay(trip, 3) };
  };

  // (a) 完全未发送 replaceConfirm（旧客户端 / 普通 apply 请求）
  {
    const { tripId, baseline } = await prepare();
    const result = await applyGuideDraft(tripId);
    assert.equal(result.rejectedCount, 0, "未确认不算护栏拒绝");
    const after = await loadTrip(tripId);
    for (const visitId of baseline) {
      assert.equal(after.visits[visitId]?.dayRef, "day_3", `${visitId} 不得因未确认而被移回`);
    }
    assert.equal(
      baseline.every((id) => visitIdsOfDay(after, 3).includes(id)),
      true,
      "原天安排全部保留（新增项只追加）",
    );
    const check = result.requirementChecks[0];
    assert.notEqual(check?.status, "met", "未确认时不得报告已满足");
    assert.match(check?.detail ?? "", /未收到本次草案的整日替换确认/, "应说明未确认原因");
  }

  // (b) draftId 与当前草案不一致（草案已变化）
  {
    const { tripId } = await prepare();
    const result = await applyGuideDraft(tripId, undefined, { draftId: "draft_from_previous_round", confirmed: true });
    const after = await loadTrip(tripId);
    assert.equal(after.visits.visit_nanshan?.dayRef, "day_3", "draftId 不一致时不得移回");
    assert.match(
      result.requirementChecks[0]?.detail ?? "",
      /确认信息与当前草案不匹配/,
      "应说明确认已失效（草案变化）",
    );
  }

  // (c) 显式 confirmed=false（用户未勾选）
  {
    const { tripId, draftId } = await prepare();
    const result = await applyGuideDraft(tripId, undefined, { draftId, confirmed: false });
    const after = await loadTrip(tripId);
    assert.equal(after.visits.visit_tianya?.dayRef, "day_3", "confirmed=false 时不得移回");
    assert.match(result.requirementChecks[0]?.detail ?? "", /未勾选整日替换确认/);
  }

  pass("S8 确认门控：未确认 / draftId 不一致 / 未勾选都不移回，并给出可读原因");
}

/** S9：同一目标日多条指令——先汇总全部有效指令点名的主体，再统一计算移回集 */
async function scenarioMultiDirectiveSameDay(): Promise<void> {
  const trip = await buildReplaceFixture();
  const parsed = parseDraftDirectives("重排DAY3，DAY3安排第一市场", trip);
  assert.equal(parsed.length, 2, "两分句应各生成一条指令");
  assert.equal(parsed[0]?.mode, "replace", "第一分句是整日替换");
  assert.equal(parsed[1]?.mode, undefined, "第二分句是普通安排");
  assert.deepEqual(parsed[1]?.resolvedVisitIds, ["visit_market"]);

  const enforced = enforceDraftDirectives(trip, parsed, [planYlwIntoDay3()]);
  const removed = enforced.directives[0]?.replaceRemovedVisitIds ?? [];
  assert.equal(
    removed.includes("visit_market"),
    false,
    "同日另一条指令点名的主体必须先进保护集合（不得先 remove 再空操作）",
  );
  assert.deepEqual(removed, ["visit_nanshan", "visit_tianya"], "移回集只含真正的旧安排");
  assert.equal(
    enforced.operations.some(
      (op) => op.op === "remove" && op.subjectRef.kind === "visit" && op.subjectRef.id === "visit_market",
    ),
    false,
    "点名主体不得生成 remove",
  );
  for (const check of enforced.requirementChecks) {
    assert.equal(check.status, "met", `两条指令均应满足：${check.detail}`);
  }
  assert.equal(new Set(removed).size, removed.length, "移回集必须去重");

  pass("S9 同日多指令：保护集合先汇总 / 移回集去重 / 两条指令均满足");
}

/** 区域占位夹具：Day3 = 南山（普通）+ 自定义「亚龙湾」（区域标题）；Day4 = 真实飞猪「亚龙湾热带天堂森林公园」 */
async function buildPlaceholderFixture(): Promise<Trip> {
  const trip = await createFixtureSanyaTrip();
  createdTripIds.push(trip.tripId);
  addVisitToDay(trip, { visitId: "visit_nanshan", name: "南山文化旅游区", dayIndex: 3 });
  addVisitToDay(trip, { visitId: "visit_area", name: "亚龙湾", dayIndex: 3 });
  addVisitToDay(trip, {
    visitId: "visit_yalong_park",
    name: "亚龙湾热带天堂森林公园",
    dayIndex: 4,
    providerId: "880001",
  });
  addPoolVisit(trip, "visit_haitan", "亚龙湾海棠湾海滩");
  await tripStore.save(trip);
  return loadTrip(trip.tripId);
}

/** S10：存量区域占位点位——不作锚点 / 不生成移回 / 不作操作目标（数据保留） */
async function scenarioAreaPlaceholder(): Promise<void> {
  const trip = await buildPlaceholderFixture();
  const placeholders = collectAreaPlaceholderVisitIds(trip);
  assert.equal(placeholders.has("visit_area"), true, "自定义「亚龙湾」应被识别为区域占位点位");
  assert.equal(placeholders.has("visit_yalong_park"), false, "真实飞猪 POI 不得被误判");

  const directives = parseDraftDirectives("重新做下DAY3的亚龙湾的行程", trip);
  assert.equal(directives[0]?.mode, "replace");
  assert.equal(
    directives[0]?.resolvedVisitIds.includes("visit_area"),
    false,
    "区域占位点位不得作为指令主题锚点（应展开到具体 POI）",
  );
  assert.ok(directives[0]?.resolvedVisitIds.includes("visit_yalong_park"), "应展开到真实 POI");

  // 模型误把区域标题当操作目标：plan / move / setDuration / remove 一律不下发
  const modelOps: Operation[] = [
    {
      op: "plan",
      scopeRef: { kind: "day", dayIndex: 3 },
      assignments: [
        { subjectRef: { kind: "visit", id: "visit_area" }, containerRef: { kind: "day", dayIndex: 3 }, order: 0 },
        { subjectRef: { kind: "visit", id: "visit_haitan" }, containerRef: { kind: "day", dayIndex: 3 }, order: 1 },
      ],
      reason: "模型把「亚龙湾」区域标题排进 Day3",
    },
    { op: "setDuration", subjectRef: { kind: "visit", id: "visit_area" }, minutes: 120, reason: "给区域标题设时长" },
    {
      op: "remove",
      subjectRef: { kind: "visit", id: "visit_area" },
      fromContainerRef: { kind: "day", dayIndex: 3 },
      reason: "模型想删除区域标题",
    },
  ];
  const enforced = enforceDraftDirectives(trip, directives, modelOps);
  const referencesPlaceholder = (op: Operation): boolean => {
    if (op.op === "plan") return op.assignments.some((entry) => entry.subjectRef.kind === "visit" && entry.subjectRef.id === "visit_area");
    return "subjectRef" in op && op.subjectRef.kind === "visit" && op.subjectRef.id === "visit_area";
  };
  assert.equal(
    enforced.operations.some(referencesPlaceholder),
    false,
    "任何操作都不得引用区域占位点位",
  );
  assert.ok(
    enforced.removedOps.some((entry) => entry.reason.includes("区域占位点位")),
    "被剔除的操作需有可审计原因",
  );
  assert.equal(
    (enforced.directives[0]?.replaceRemovedVisitIds ?? []).includes("visit_area"),
    false,
    "区域标题只作展示，不参与移回",
  );
  assert.ok(
    (enforced.directives[0]?.replaceRemovedVisitIds ?? []).includes("visit_nanshan"),
    "同天真正的旧安排仍应移回",
  );

  // prompt：天级标注区域占位，避免模型再次把它当可游玩点位
  const facts = buildTripFacts(trip).join("\n");
  assert.match(facts, /区域占位/, "planner 输入应标注区域占位点位");

  // 应用后数据仍在（不删除区域标题）
  const draftId = await attachDraft(trip.tripId, enforced.operations, enforced.directives);
  const result = await applyGuideDraft(trip.tripId, undefined, { draftId, confirmed: true });
  assert.equal(result.rejectedCount, 0, `不应有护栏拒绝（${result.rejectSummary ?? ""}）`);
  const after = await loadTrip(trip.tripId);
  assert.equal(after.visits.visit_area?.dayRef, "day_3", "区域占位点位必须原样保留在原天");
  assert.equal(after.visits.visit_nanshan?.dayRef, null, "真正的旧安排应回到候选池");

  pass("S10 区域占位：不作锚点 / 操作被剔除 / 不作移回项 / prompt 标注 / 数据不删除");
}

async function main(): Promise<void> {
  try {
    await scenarioParse();
    await scenarioReplaceEndToEnd();
    await scenarioModelKeepsOldItem();
    await scenarioThreshold();
    await scenarioAppendUnchanged();
    await scenarioNegation();
    await scenarioEmptyPlanNoDetach();
    await scenarioApplyConfirmationGating();
    await scenarioMultiDirectiveSameDay();
    await scenarioAreaPlaceholder();
    console.log("\nTask #248 全部验证通过 ✅");
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

await main();
