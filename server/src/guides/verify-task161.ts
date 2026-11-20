/**
 * Task #161（增量攻略来源隔离与局部草案契约）验证（全程离线）。
 *
 * setGuidePlannerDeps 桩注入 callPlanner，全程不触网、不调用真实百炼。夹具：
 * 历史来源 A（ev_note_1）+ 历史来源 B（ev_new_b）+ 暂存来源 Q（ev_new_q，staged=true）
 * + 已移除来源 C（ev_c，active=false）。全局候选：item_daxiaodongtian（证据指向 A）
 * 与 item_ghost_candidate（证据仅被 C 支撑）——后者用于验证「只收窄不放宽」。
 *
 * 场景清单（确定性回归）：
 *   1. 全部模式兼容：老调用方 body { scope }（无 sourceMode）→ 缺省归一 "all"、
 *      素材 = 全部历史来源（A+B）、暂存来源与已移除来源被排除、候选区保留 A 支撑的
 *      大小洞天且不补回 inactive 来源支撑的旧候选、响应与草案元数据持久化；
 *   2. 暂存默认不参与：仅有暂存来源的行程全部模式 → 409 GUIDE_NO_SOURCES；
 *      同一暂存来源显式 selectedSourceIds 选中 → 单篇稀疏素材先触发 C1 澄清（#282/#294），
 *      带 clarificationAnswer 重发后 200 且素材进入 prompt（单篇局部）；
 *   3. 多篇局部：选历史 A + 暂存 Q → 素材含两篇、未选来源 B 的提及 / 标题 / 候选
 *      全隔离；桩编造未选来源（B）提及的 snippet 被 validMentionRefs 清洗；
 *   4. 单篇历史 + scope=day：素材只含所选来源、draft.scope 持久化 affected scope；
 *   5. Day 硬约束：局部模式 + 「DAY3去蜈支洲岛」→ 指令块进 prompt、模型未排天时
 *      服务端确定性补排 Day3（Day 指令优先级不受来源过滤影响）、草案指令元数据持久化；
 *   6. 无效 sourceId 与组合校验：不存在 / 已移除（active=false）/ 未处理完成（processing）
 *      的来源被选中 → 400；空选择（缺 ids / 空数组）→ 400；携带 ids 缺 sourceMode → 400；
 *      sourceMode="all" 携带 ids → 400（互斥）；显式 sourceMode="all" 单独合法（200）；
 *   7. 失败不修改原行程：桩两次垃圾输出 → 502 AI_PARSE_FAILED，无草案落盘、版本不变；
 *   8. 重复请求不叠加：同选择重复 generate 覆盖 pendingGuideDraft（sourceIds 一致）；
 *      apply 一次消费后重复 apply → 404 DRAFT_NOT_FOUND。
 *
 * 全部模式二次确认边界：整体重排确认（isFullPlanBatch / ConfirmDialog）属 F11 通道与
 * web 前端，server 侧本任务不改动；场景 1 证明旧 body 契约与素材语义不变，即不退化
 * 旧调用方（含二次确认链路的上游输入）。
 *
 * 运行：npx tsx server/src/guides/verify-task161.ts
 * 临时行程（server/data）在脚本末尾全部清理，不影响用户既有数据。
 */

import "../env.js";
import assert from "node:assert/strict";
import type {
  GuideSource,
  Item,
  PendingGuideDraft,
  SourceEvidence,
  Trip,
} from "@goplay/shared";
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

const STUB_DRAFT_JSON = JSON.stringify({
  operations: [
    { op: "setDuration", subjectRef: { kind: "stop", id: "stop_bridge" }, minutes: 50, reason: "情人桥铁索桥慢行，多留10分钟" },
  ],
  snippets: [],
});

const GARBAGE_TEXT = "这是一段与 JSON 无关的垃圾输出";

/** 各来源提及原文（prompt 隔离断言的判据） */
const M1_QUOTE = "Day2 一整天留给蜈支洲岛，记得早去避堵";
const B1_QUOTE = "第一市场海鲜加工首选四川小胡子，嫌贵就去旁边的林姐";
const Q1_QUOTE = "西岛新码头快艇直达，比旧码头省半小时";
const C1_QUOTE = "幽灵湾栈道下午涨潮会关闭，务必上午去";

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
  overrides: Partial<GuideSource> = {},
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
    ...overrides,
  };
}

/** 时刻常量：importedAt 决定合并顺序（A → B → Q → C） */
const T_A = "2026-10-19T08:00:00.000Z";
const T_B = "2026-10-19T09:00:00.000Z";
const T_Q = "2026-10-19T10:00:00.000Z";
const T_C = "2026-10-19T11:00:00.000Z";

const SRC_A = "src_hist_a";
const SRC_B = "src_hist_b";
const SRC_Q = "src_staged_q";
const SRC_C = "src_inactive_c";

/**
 * Task #161 夹具（在标准三亚夹具上增补，不触碰用户数据）：
 * - 历史来源 A（ev_note_1，非暂存）：m1-m4，visit_wzz / stop_bridge 对齐 m1 / m2；
 * - 历史来源 B（ev_new_b，非暂存）：b1 / b2（未对齐实体，做未选来源隔离判据）；
 * - 暂存来源 Q（ev_new_q，staged=true）：q1 / q2（新增攻略默认暂存的判据）；
 * - 已移除来源 C（ev_c，active=false）：c1，支撑 item_ghost_candidate——
 *   该候选必须在任何模式下都不出现（只收窄不放宽，不因来源过滤把旧候选补回）；
 * - 失败来源 P：无证据且 status=failed，验证局部选中未处理完成（非 ready/partial）
 *   来源被拒绝（与 processing 同一 status 门分支）；
 * - item_daxiaodongtian.sourceEvidenceRefs 指向 ev_note_1（A 支撑的候选）：
 *   全部模式 / 选 A 时保留；只选 Q 时被裁（未选来源支撑的候选不进 prompt）。
 */
async function setupTask161Fixture(tripId: string): Promise<void> {
  const trip = await loadTrip(tripId);
  trip.visits.visit_wzz.sourceMentionRefs = ["ev_note_1:m1"];
  trip.stops.stop_bridge.sourceMentionRefs = ["ev_note_1:m2"];

  trip.evidences["ev_new_b"] = {
    evidenceId: "ev_new_b",
    kind: "note_text",
    noteIndex: 2,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions: [
      mkMention("b1", "第一市场", B1_QUOTE, "第一市场"),
      mkMention("b2", "天涯镇", "天涯镇晚上有夜市，民宿便宜", "天涯镇"),
    ],
  };
  trip.evidences["ev_new_q"] = {
    evidenceId: "ev_new_q",
    kind: "note_text",
    noteIndex: 3,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions: [
      mkMention("q1", "西岛", Q1_QUOTE, "西岛"),
      mkMention("q2", "椰梦长廊", "椰梦长廊日落时分最出片，18点半到正好", "椰梦长廊"),
    ],
  };
  trip.evidences["ev_c"] = {
    evidenceId: "ev_c",
    kind: "note_text",
    noteIndex: 4,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions: [mkMention("c1", "幽灵湾", C1_QUOTE, "幽灵湾")],
  };

  const sources = trip.guideSources ?? {};
  sources[SRC_A] = mkSource(
    SRC_A,
    "小岛两天一夜攻略（A·历史）",
    ["ev_note_1"],
    ["ev_note_1:m1", "ev_note_1:m2", "ev_note_1:m3", "ev_note_1:m4"],
    T_A,
  );
  sources[SRC_B] = mkSource(
    SRC_B,
    "第一市场避雷指南（B·历史）",
    ["ev_new_b"],
    ["ev_new_b:b1", "ev_new_b:b2"],
    T_B,
  );
  sources[SRC_Q] = mkSource(
    SRC_Q,
    "西岛快船实测（Q·暂存）",
    ["ev_new_q"],
    ["ev_new_q:q1", "ev_new_q:q2"],
    T_Q,
    { staged: true },
  );
  sources[SRC_C] = mkSource(
    SRC_C,
    "幽灵湾攻略（C·已移除）",
    ["ev_c"],
    ["ev_c:c1"],
    T_C,
    // active=false 走软移除语义：一致性校验要求携带 removedAt（与 remove 端点行为一致）
    { active: false, removedAt: T_C },
  );
  sources["src_failed_p"] = mkSource(
    "src_failed_p",
    "处理失败攻略（P）",
    [],
    [],
    T_C,
    // 用 failed 而非 processing：recoverStaleProcessingLocked 会把无活跃 job 的
    // processing 来源结算落盘（version+1），干扰场景 7 的版本不变断言；
    // failed 与 processing 走同一个 status 门分支（!== ready && !== partial）
    { status: "failed" },
  );
  trip.guideSources = sources;

  // A 支撑的全局候选（大小洞天）：证据明确指向 ev_note_1
  const dxc = trip.itemRegistry["item_daxiaodongtian"];
  assert.ok(dxc !== undefined, "前提：fixture 应有 item_daxiaodongtian");
  dxc.sourceEvidenceRefs = ["ev_note_1"];

  // 仅被 inactive 来源 C 支撑的全局候选：任何模式都不得出现
  const ghostItem: Item = {
    itemId: "item_ghost_candidate",
    name: "幽灵湾",
    origin: "custom",
    providerId: null,
    address: null,
    category: null,
    coords: null,
    suggestMinutes: 90,
    mainPic: null,
    ticketInfo: null,
    jumpUrl: null,
    sourceEvidenceRefs: ["ev_c"],
  };
  trip.itemRegistry["item_ghost_candidate"] = ghostItem;
  trip.globalCandidateRefs = [...trip.globalCandidateRefs, { kind: "point", id: "item_ghost_candidate" }];

  trip.guideDraftNote = "";
  await tripStore.save(trip);
}

/** 仅含暂存来源 Q 的行程（场景 2：暂存默认不参与的极端形态） */
async function setupStagedOnlyFixture(tripId: string): Promise<void> {
  const trip = await loadTrip(tripId);
  trip.evidences["ev_new_q"] = {
    evidenceId: "ev_new_q",
    kind: "note_text",
    noteIndex: 3,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions: [
      mkMention("q1", "西岛", Q1_QUOTE, "西岛"),
      mkMention("q2", "椰梦长廊", "椰梦长廊日落时分最出片，18点半到正好", "椰梦长廊"),
    ],
  };
  trip.guideSources = {
    [SRC_Q]: mkSource(
      SRC_Q,
      "西岛快船实测（Q·暂存）",
      ["ev_new_q"],
      ["ev_new_q:q1", "ev_new_q:q2"],
      T_Q,
      { staged: true },
    ),
  };
  trip.guideDraftNote = "";
  await tripStore.save(trip);
}

// ===== main =====

async function main(): Promise<void> {
  try {
    await runScenarios();
    console.log("\n[verify] Task #161（增量攻略来源隔离与局部草案契约）全部通过 ✓");
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
  // ---------- 主体夹具行程 ----------
  const main = await createFixtureSanyaTrip();
  createdTripIds.push(main.tripId);
  const mainTripId = main.tripId;
  await setupTask161Fixture(mainTripId);

  // ---------- 场景 1：全部模式兼容（老调用方 body 不变 + 暂存排除 + 候选不放宽） ----------
  {
    armPlanner(STUB_DRAFT_JSON);
    // 老调用方只发 { scope }——不传 sourceMode，必须归一 "all" 且行为与旧版一致
    const res = await requestJson(`/trips/${mainTripId}/draft`, "POST", { scope: { kind: "trip" } });
    assert.equal(res.status, 200, `生成应 200（实际 ${res.status}：${JSON.stringify(res.body)}）`);
    assert.equal(res.body.sourceMode, "all", "缺省请求应归一为 sourceMode=all");
    assert.deepEqual(res.body.sourceIds, [], "全部模式 sourceIds 应为空数组");
    assert.equal(res.body.sourceCount, 2, "全部模式可用来源 = 历史 A + B（暂存 Q 与已移除 C 排除）");

    const prompt = capturedPrompts[0] ?? "";
    assert.ok(prompt.includes("共 2 篇可用来源"), "素材头行应为 2 篇（A+B）");
    assert.ok(prompt.includes(M1_QUOTE), "历史来源 A 的提及应进入 prompt");
    assert.ok(prompt.includes("小岛两天一夜攻略（A·历史）"), "来源 A 标题应进入 prompt");
    assert.ok(prompt.includes(B1_QUOTE), "历史来源 B 的提及应进入 prompt（全部模式含全部历史来源）");
    assert.ok(!prompt.includes(Q1_QUOTE), "暂存来源 Q 的提及不得进入默认（全部模式）prompt");
    assert.ok(!prompt.includes("西岛快船实测（Q·暂存）"), "暂存来源 Q 标题不得出现在全部模式");
    assert.ok(!prompt.includes(C1_QUOTE), "已移除来源 C 的提及不得出现");
    assert.ok(prompt.includes("item_daxiaodongtian"), "A 支撑的候选（大小洞天）应保留在候选区");
    assert.ok(!prompt.includes("item_ghost_candidate"), "inactive 来源支撑的候选不得被补回（只收窄不放宽）");
    assert.ok(!prompt.includes("来源范围：本轮只使用用户显式选中"), "全部模式不追加局部来源范围指令");

    const saved = await loadTrip(mainTripId);
    const draft = saved.pendingGuideDraft as PendingGuideDraft | undefined;
    assert.ok(draft !== undefined, "pendingGuideDraft 应已保存");
    assert.equal(draft.sourceMode, "all", "草案应持久化 sourceMode=all");
    assert.equal(draft.sourceIds, undefined, "全部模式草案不写 sourceIds（无显式选择）");
    assert.deepEqual(
      draft.sourceSnapshots.map((entry) => entry.sourceId),
      [SRC_A, SRC_B],
      "全部模式来源快照 = 历史来源（A、B，按导入序）",
    );
    assert.equal(draft.scope.kind, "trip", "affected scope 应持久化");
    pass("1. 全部模式兼容：缺省归一 all / 历史来源全集 / 暂存与已移除排除 / 候选只收窄不放宽 / 元数据持久化");
  }

  // ---------- 场景 2：暂存默认不参与 + 显式选中暂存来源可参与（单篇局部） ----------
  {
    const stagedOnly = await createFixtureSanyaTrip();
    createdTripIds.push(stagedOnly.tripId);
    await setupStagedOnlyFixture(stagedOnly.tripId);

    armPlanner();
    const allRes = await requestJson(`/trips/${stagedOnly.tripId}/draft`, "POST", { scope: { kind: "trip" } });
    assert.equal(allRes.status, 409, "仅暂存来源的行程全部模式应 409");
    assert.equal(allRes.body.code, "GUIDE_NO_SOURCES");
    assert.equal(allRes.body.sourceMode, null, "错误体应保持 sourceMode 空形状契约");
    assert.equal(capturedPrompts.length, 0, "无可用素材不得调用 planner");

    // Task #282/#294：本场景素材只有西岛 + 椰梦长廊两个「未落位的新点位」（已排天 0），
    // 与 eval C1 稀疏基线同口径 → C1 澄清先于 planner 触发是正确行为（不是回归）。
    armPlanner(STUB_DRAFT_JSON);
    const clarRes = await requestJson(`/trips/${stagedOnly.tripId}/draft`, "POST", {
      scope: { kind: "trip" },
      sourceMode: "selected",
      selectedSourceIds: [SRC_Q],
    });
    assert.equal(clarRes.status, 200, `显式选中暂存来源应 200（实际 ${JSON.stringify(clarRes.body)}）`);
    assert.equal(clarRes.body.draftId, null, "稀疏素材首轮应先澄清、不产出草案");
    assert.ok(clarRes.body.clarification != null, "单篇稀疏暂存来源应触发 C1 澄清");
    assert.equal(capturedPrompts.length, 0, "澄清阶段不得调用 planner");

    // 带答案重发：契约验证（暂存来源可显式选中参与局部生成、素材进 prompt、元数据持久化）
    armPlanner(STUB_DRAFT_JSON);
    const selRes = await requestJson(`/trips/${stagedOnly.tripId}/draft`, "POST", {
      scope: { kind: "trip" },
      sourceMode: "selected",
      selectedSourceIds: [SRC_Q],
      clarificationAnswer: "ai_fill",
    });
    assert.equal(selRes.status, 200, `带澄清答案的显式选中应 200（实际 ${JSON.stringify(selRes.body)}）`);
    assert.equal(selRes.body.sourceMode, "selected");
    assert.deepEqual(selRes.body.sourceIds, [SRC_Q], "单篇选择应原样回传");
    assert.equal(selRes.body.sourceCount, 1);
    const prompt = capturedPrompts[0] ?? "";
    assert.ok(prompt.includes(Q1_QUOTE), "被显式选中的暂存来源素材应进入 prompt");
    assert.ok(prompt.includes("来源范围：本轮只使用用户显式选中的 1 篇攻略"), "局部模式应有来源范围指令行");

    const saved = await loadTrip(stagedOnly.tripId);
    const draft = saved.pendingGuideDraft as PendingGuideDraft | undefined;
    assert.ok(draft !== undefined);
    assert.equal(draft.sourceMode, "selected");
    assert.deepEqual(draft.sourceIds, [SRC_Q], "草案应持久化所选来源 id（单篇）");
    assert.deepEqual(
      draft.sourceSnapshots.map((entry) => entry.sourceId),
      [SRC_Q],
      "局部模式来源快照应只含所选来源",
    );
    pass("2. 暂存默认不参与：仅暂存来源全部模式 409 / 稀疏素材先 C1 澄清 / 带答案后 200 且素材进 prompt");
  }

  // ---------- 场景 3：多篇局部 + 未选来源隔离（素材 / 标题 / snippet 清洗 / 候选） ----------
  {
    armPlanner(
      JSON.stringify({
        operations: [],
        snippets: [
          {
            text: "上岛先走情人桥，铁索桥有点晃",
            claimKind: "tip",
            targetRef: { kind: "stop", id: "stop_bridge" },
            sourceMentionRefs: ["ev_note_1:m2"],
          },
          {
            text: "第一市场海鲜加工有靠谱店",
            claimKind: "tip",
            targetRef: { kind: "stop", id: "stop_bridge" },
            // 编造未选来源 B 的引用：必须被 validMentionRefs 清洗
            sourceMentionRefs: ["ev_new_b:b1"],
          },
          {
            text: "西岛新码头快艇直达",
            claimKind: "tip",
            targetRef: { kind: "visit", id: "visit_wzz" },
            // 被选中的暂存来源 Q 的引用：合法保留
            sourceMentionRefs: ["ev_new_q:q1"],
          },
        ],
      }),
    );
    const res = await requestJson(`/trips/${mainTripId}/draft`, "POST", {
      scope: { kind: "trip" },
      sourceMode: "selected",
      selectedSourceIds: [SRC_A, SRC_Q],
    });
    assert.equal(res.status, 200, `多篇局部生成应 200（实际 ${JSON.stringify(res.body)}）`);
    assert.deepEqual(res.body.sourceIds, [SRC_A, SRC_Q], "多篇选择应按请求顺序回传");
    assert.equal(res.body.sourceCount, 2);

    const prompt = capturedPrompts[0] ?? "";
    assert.ok(prompt.includes("来源范围：本轮只使用用户显式选中的 2 篇攻略"), "多篇局部应有来源范围指令行");
    assert.ok(prompt.includes(M1_QUOTE), "所选历史来源 A 素材应在 prompt");
    assert.ok(prompt.includes(Q1_QUOTE), "所选暂存来源 Q 素材应在 prompt");
    assert.ok(!prompt.includes(B1_QUOTE), "未选历史来源 B 的提及不得进入 prompt");
    assert.ok(!prompt.includes("第一市场避雷指南（B·历史）"), "未选来源 B 标题不得进入 prompt");
    assert.ok(prompt.includes("item_daxiaodongtian"), "所选 A 支撑的候选应保留");
    assert.ok(!prompt.includes("item_ghost_candidate"), "inactive 来源支撑的候选不得出现");

    const snippets = res.body.snippets as Array<{ sourceMentionRefs: string[] }>;
    assert.equal(snippets.length, 2, "编造未选来源引用的 snippet 应被清洗（3 条桩输入剩 2 条）");
    assert.ok(
      snippets.every((entry) => !entry.sourceMentionRefs.includes("ev_new_b:b1")),
      "任何 snippet 不得引用未选来源的提及",
    );

    const saved = await loadTrip(mainTripId);
    const draft = saved.pendingGuideDraft as PendingGuideDraft | undefined;
    assert.ok(draft !== undefined);
    assert.deepEqual(draft.sourceIds, [SRC_A, SRC_Q], "多篇选择应持久化（结果召回 / 重复提交核对）");
    assert.deepEqual(
      draft.sourceSnapshots.map((entry) => entry.sourceId),
      [SRC_A, SRC_Q],
      "局部模式快照 = 所选来源（按导入序）",
    );
    const draftMentionRefs = draft.mentionRefs;
    assert.ok(draftMentionRefs !== undefined, "草案应携带证据引用（mentionRefs）");
    assert.ok(
      draftMentionRefs.includes("ev_note_1:m2") && draftMentionRefs.includes("ev_new_q:q1"),
      "草案证据应含所选两来源的引用",
    );
    assert.ok(
      !draftMentionRefs.some((ref) => ref.startsWith("ev_new_b")),
      "草案证据不得包含未选来源 B 的引用",
    );
    pass("3. 多篇局部：素材 / 标题 / 草案证据只含所选来源；编造未选引用的 snippet 被清洗；候选按支撑过滤");
  }

  // ---------- 场景 4：单篇历史 + scope=day（affected scope 持久化） ----------
  {
    armPlanner(STUB_DRAFT_JSON);
    const res = await requestJson(`/trips/${mainTripId}/draft`, "POST", {
      scope: { kind: "day", dayIndex: 2 },
      sourceMode: "selected",
      selectedSourceIds: [SRC_B],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.sourceIds, [SRC_B], "单篇历史来源局部生成应回传所选 id");
    const prompt = capturedPrompts[0] ?? "";
    assert.ok(prompt.includes(B1_QUOTE), "所选来源 B 素材应在 prompt");
    assert.ok(prompt.includes("单日优化"), "day scope 指令应保留（自动 scope 规则不因来源过滤改变）");
    assert.ok(!prompt.includes(M1_QUOTE), "未选来源 A 的提及不得进入局部 prompt");

    const saved = await loadTrip(mainTripId);
    const draft = saved.pendingGuideDraft as PendingGuideDraft | undefined;
    assert.ok(draft !== undefined);
    assert.deepEqual(draft.scope, { kind: "day", dayIndex: 2 }, "实际 affected scope 应持久化到草案");
    assert.deepEqual(draft.sourceIds, [SRC_B]);
    pass("4. 单篇历史 + scope=day：素材隔离 / day scope 指令保留 / affected scope 持久化");
  }

  // ---------- 场景 5：Day 硬约束（局部模式，Day 指令优先） ----------
  {
    const dayTrip = await createFixtureSanyaTrip();
    createdTripIds.push(dayTrip.tripId);
    await setupTask161Fixture(dayTrip.tripId);

    armPlanner(
      // 桩输出不含任何排天操作：visit_wzz 仍在 Day2，指令要求 Day3 → 服务端必须确定性补排
      JSON.stringify({ operations: [], snippets: [] }),
    );
    const res = await requestJson(`/trips/${dayTrip.tripId}/draft`, "POST", {
      scope: { kind: "trip" },
      sourceMode: "selected",
      selectedSourceIds: [SRC_A],
      note: "DAY3去蜈支洲岛",
    });
    assert.equal(res.status, 200, `Day 指令局部生成应 200（实际 ${JSON.stringify(res.body)}）`);

    const prompt = capturedPrompts[0] ?? "";
    assert.ok(prompt.includes("【日期硬性指令】"), "局部模式日期指令块应进入 prompt");
    assert.ok(prompt.includes("DAY3去蜈支洲岛"), "指令应携带用户原话（prompt 可追溯到补充句）");

    const directives = res.body.directives as Array<{ dayIndex: number; resolvedVisitIds: string[] }>;
    assert.equal(directives.length, 1, "应解析出 1 条日期指令");
    assert.equal(directives[0]?.dayIndex, 3);
    assert.ok(directives[0]?.resolvedVisitIds.includes("visit_wzz"), "指令应匹配到蜈支洲岛 Visit");

    const ops = res.body.operations as Array<{
      op: string;
      subjectRef?: { id?: string };
      toContainerRef?: { kind?: string; dayIndex?: number };
    }>;
    const transfer = ops.find((entry) => entry.op === "transfer");
    assert.ok(transfer !== undefined, "模型未排天时服务端应补确定性 transfer");
    assert.equal(transfer.subjectRef?.id, "visit_wzz");
    assert.equal(transfer.toContainerRef?.kind, "day");
    assert.equal(transfer.toContainerRef?.dayIndex, 3, "补排目标必须是指令指定的 Day3");
    const checks = res.body.requirementChecks as Array<{ status: string }>;
    assert.equal(checks[0]?.status, "met", "补排后指令应满足");

    const saved = await loadTrip(dayTrip.tripId);
    const draft = saved.pendingGuideDraft as PendingGuideDraft | undefined;
    assert.ok(draft !== undefined);
    assert.equal(draft.directives?.length, 1, "草案应持久化日期指令元数据");
    assert.equal(draft.requirementChecks?.[0]?.status, "met", "草案应持久化指令满足校验");
    assert.equal(saved.guideDraftNote, "DAY3去蜈支洲岛", "note 应顺手保存（与旧语义一致）");
    pass("5. Day 硬约束：局部模式指令进 prompt / 服务端补排 Day3 / 草案指令元数据持久化");
  }

  // ---------- 场景 6：无效 sourceId 与组合校验（全部 400 + 空形状 + 不调 AI） ----------
  {
    armPlanner();
    const ghost = await requestJson(`/trips/${mainTripId}/draft`, "POST", {
      scope: { kind: "trip" },
      sourceMode: "selected",
      selectedSourceIds: [SRC_A, "src_not_exist"],
    });
    assert.equal(ghost.status, 400, "不存在的来源 id 应 400");
    assert.equal(ghost.body.code, "INVALID_REQUEST");
    assert.equal(ghost.body.sourceMode, null, "错误体应保持 sourceMode 空形状契约");
    assert.deepEqual(ghost.body.sourceIds, [], "错误体应保持 sourceIds 空形状契约");

    const removed = await requestJson(`/trips/${mainTripId}/draft`, "POST", {
      scope: { kind: "trip" },
      sourceMode: "selected",
      selectedSourceIds: [SRC_C],
    });
    assert.equal(removed.status, 400, "已移除（active=false）来源被选中应 400");
    assert.equal(removed.body.code, "INVALID_REQUEST");

    const failed = await requestJson(`/trips/${mainTripId}/draft`, "POST", {
      scope: { kind: "trip" },
      sourceMode: "selected",
      selectedSourceIds: ["src_failed_p"],
    });
    assert.equal(failed.status, 400, "未处理完成（failed，与 processing 同一 status 门）来源被选中应 400");
    assert.equal(failed.body.code, "INVALID_REQUEST");

    const noIds = await requestJson(`/trips/${mainTripId}/draft`, "POST", {
      scope: { kind: "trip" },
      sourceMode: "selected",
    });
    assert.equal(noIds.status, 400, "selected 模式缺 selectedSourceIds 应 400");

    const emptyIds = await requestJson(`/trips/${mainTripId}/draft`, "POST", {
      scope: { kind: "trip" },
      sourceMode: "selected",
      selectedSourceIds: [],
    });
    assert.equal(emptyIds.status, 400, "selected 模式空数组应 400");

    const idsWithoutMode = await requestJson(`/trips/${mainTripId}/draft`, "POST", {
      scope: { kind: "trip" },
      selectedSourceIds: [SRC_A],
    });
    assert.equal(idsWithoutMode.status, 400, "携带 ids 缺 sourceMode 应 400（拒绝猜测）");

    const allWithIds = await requestJson(`/trips/${mainTripId}/draft`, "POST", {
      scope: { kind: "trip" },
      sourceMode: "all",
      selectedSourceIds: [SRC_A],
    });
    assert.equal(allWithIds.status, 400, "all 模式携带 ids 应 400（两种模式互斥）");

    const badMode = await requestJson(`/trips/${mainTripId}/draft`, "POST", {
      scope: { kind: "trip" },
      sourceMode: "partial",
    });
    assert.equal(badMode.status, 400, "非法 sourceMode 应 400");

    assert.equal(capturedPrompts.length, 0, "全部 400 场景不得调用 planner");

    armPlanner(STUB_DRAFT_JSON);
    const explicitAll = await requestJson(`/trips/${mainTripId}/draft`, "POST", {
      scope: { kind: "trip" },
      sourceMode: "all",
    });
    assert.equal(explicitAll.status, 200, "显式 sourceMode=all（不带 ids）应合法 200");
    assert.equal(explicitAll.body.sourceMode, "all");
    pass("6. 组合校验：不存在 / 已移除 / failed 来源 → 400；空选择 / ids-缺-mode / all-带-ids → 400；显式 all 合法");
  }

  // ---------- 场景 7：失败不修改原行程 ----------
  {
    const failTrip = await createFixtureSanyaTrip();
    createdTripIds.push(failTrip.tripId);
    await setupTask161Fixture(failTrip.tripId);
    // Task #282/#294：单篇稀疏暂存来源（西岛 + 椰梦长廊，已排天 0）首轮必触发 C1 澄清，
    // 故先带 clarificationAnswer 打底把答案持久化（答案持久化本身会 bump 版本），
    // 再在「答案已存在」的前提下验证失败路径不修改行程——C1 语义与本场景断言互不干扰。
    armPlanner(GARBAGE_TEXT, GARBAGE_TEXT);
    const primed = await requestJson(`/trips/${failTrip.tripId}/draft`, "POST", {
      scope: { kind: "trip" },
      sourceMode: "selected",
      selectedSourceIds: [SRC_Q],
      clarificationAnswer: "ai_fill",
    });
    assert.equal(primed.status, 502, "打底请求同样应走 planner 失败路径");
    const versionBefore = (await loadTrip(failTrip.tripId)).version;

    armPlanner(GARBAGE_TEXT, GARBAGE_TEXT);
    const res = await requestJson(`/trips/${failTrip.tripId}/draft`, "POST", {
      scope: { kind: "trip" },
      sourceMode: "selected",
      selectedSourceIds: [SRC_Q],
    });
    assert.equal(res.status, 502, "两次垃圾输出应 502 AI_PARSE_FAILED");
    assert.equal(res.body.code, "AI_PARSE_FAILED");
    assert.equal(res.body.sourceMode, null, "错误体应保持空形状契约");

    const saved = await loadTrip(failTrip.tripId);
    assert.equal(saved.pendingGuideDraft, undefined, "生成失败不得落草案");
    assert.equal(saved.version, versionBefore, "生成失败不得修改原行程（版本不变）");
    pass("7. 失败不修改原行程：AI_PARSE_FAILED 后无草案落盘、Trip.version 不变");
  }

  // ---------- 场景 8：重复请求不叠加 + pending 元数据核对 + 一次性消费 ----------
  {
    const dupTrip = await createFixtureSanyaTrip();
    createdTripIds.push(dupTrip.tripId);
    await setupTask161Fixture(dupTrip.tripId);

    armPlanner(STUB_DRAFT_JSON);
    const first = await requestJson(`/trips/${dupTrip.tripId}/draft`, "POST", {
      scope: { kind: "trip" },
      sourceMode: "selected",
      selectedSourceIds: [SRC_A, SRC_Q],
    });
    assert.equal(first.status, 200);
    const firstDraftId = first.body.draftId as string;

    armPlanner(STUB_DRAFT_JSON);
    const second = await requestJson(`/trips/${dupTrip.tripId}/draft`, "POST", {
      scope: { kind: "trip" },
      sourceMode: "selected",
      selectedSourceIds: [SRC_A, SRC_Q],
    });
    assert.equal(second.status, 200);
    assert.notEqual(second.body.draftId, firstDraftId, "重复 generate 应产生新草案（覆盖旧草案）");

    const saved = await loadTrip(dupTrip.tripId);
    const draft = saved.pendingGuideDraft as PendingGuideDraft | undefined;
    assert.ok(draft !== undefined);
    assert.equal(draft.draftId, second.body.draftId, "pendingGuideDraft 应是最新一次生成（覆盖不叠加）");
    assert.deepEqual(draft.sourceIds, [SRC_A, SRC_Q], "重复提交的元数据应一致（核对判据）");
    assert.equal(draft.sourceMode, "selected");

    const applyRes = await requestJson(`/trips/${dupTrip.tripId}/draft/apply`, "POST");
    assert.equal(applyRes.status, 200, `应用应 200（实际 ${JSON.stringify(applyRes.body)}）`);
    const afterApply = await loadTrip(dupTrip.tripId);
    assert.equal(afterApply.pendingGuideDraft, undefined, "应用后草案应被一次性消费");

    const dupApply = await requestJson(`/trips/${dupTrip.tripId}/draft/apply`, "POST");
    assert.equal(dupApply.status, 404, "重复 apply 应 404");
    assert.equal(dupApply.body.code, "DRAFT_NOT_FOUND");
    const finalTrip = await loadTrip(dupTrip.tripId);
    assert.equal(finalTrip.pendingGuideDraft, undefined, "重复 apply 不得复活或叠加草案");
    pass("8. 重复请求不叠加：重复 generate 覆盖草案（sourceMode/sourceIds 一致）/ apply 一次后 DRAFT_NOT_FOUND");
  }

  // 收尾一致性：主体行程结构未被破坏
  const finalMain = await loadTrip(mainTripId);
  assert.ok(finalMain.visits.visit_wzz !== undefined, "主体行程结构应保持完整");
}

main().catch((error) => {
  console.error("\n[verify] 验证失败：", error);
  process.exitCode = 1;
});
