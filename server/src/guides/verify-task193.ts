/**
 * Task #193 snippet-only 本地快速路径端到端验证（全程离线，不触网、不调用真实百炼）。
 *
 * setGuidePlannerDeps 桩注入 callPlanner：可精确统计「百炼调用次数」，命中快速路径时
 * 必须为 0；未命中时必须为 1（证明完整 AI 链路未被短路）。
 *
 * 覆盖：
 *   1. 用户三景点样例（西岛 / 蜈支洲岛 / 亚龙湾热带森林公园，note 缺「天堂」）：
 *      来源 mention 名称唯一对齐、0 操作、3 条提示、目标实体与引用精确、毫秒级完成、
 *      草案持久化（sourceMode / sourceIds / note）并可正常应用挂载；
 *      同名 pending Stop 与近似重复 Visit 都不得抢走已排期 Visit；
 *   2. merge 已确定 entityRef 优先：即使名称更像另一条近似重复 Visit，也只认
 *      sourceMentionRefs 归属的实体；
 *   3. 「加个亮点 / 推荐理由」不误判为新增地点（负向前瞻）；
 *   4. 回落边界：all 模式、新增地点、日期指令、调序、未对齐 mention、模糊 / 复杂
 *      note 全部回落 AI（调用次数 1、fastPath=false、prompt 非空）；
 *   5. 版本保护：快速路径保存前行程被并发修改 → 409 DRAFT_STALE，不覆盖既有草案；
 *   6. optionGroups 契约回归：快速路径响应空数组、草案 output 不写空键、错误形状补零；
 *   7. Task #197 用户精确 note："帮我把这里…亮点，补充到我目前的对应景点中"
 *      与样例 note 同一来源夹具命中快速路径（note 文本不参与实体对齐）。
 *
 * 运行：npx tsx server/src/guides/verify-task193.ts
 * 临时行程（server/data）在脚本末尾统一清理，不影响用户既有数据。
 */

import "../env.js";
import assert from "node:assert/strict";
import type {
  GuideSource,
  Item,
  SourceEvidence,
  Stop,
  Trip,
  Visit,
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

// ===== planner 桩（调用计数 + prompt 捕获；生产依赖零触网） =====

let plannerCalls = 0;
const capturedPrompts: string[] = [];
let beforeDraftSaveHook: ((tripId: string) => Promise<void>) | undefined;

/** 未命中快速路径时的合法空草案（解析成功、0 操作 0 提示） */
const AI_EMPTY_JSON = JSON.stringify({ operations: [], snippets: [] });

setGuidePlannerDeps({
  callPlanner: async (prompt: string) => {
    plannerCalls += 1;
    capturedPrompts.push(prompt);
    return AI_EMPTY_JSON;
  },
  beforeDraftSave: async (tripId: string) => {
    if (beforeDraftSaveHook !== undefined) await beforeDraftSaveHook(tripId);
  },
});

function armStub(): void {
  plannerCalls = 0;
  capturedPrompts.length = 0;
}

// ===== 夹具辅助 =====

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

function customItem(itemId: string, name: string, suggestMinutes: number | null): Item {
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
    sourceEvidenceRefs: [],
  };
}

function mkVisit(
  visitId: string,
  dayRef: string,
  pointRef: string,
  kind: Visit["kind"],
  order: number,
): Visit {
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

function mkSource(
  sourceId: string,
  title: string,
  evidenceId: string,
  mentionRefs: string[],
): GuideSource {
  return {
    sourceId,
    sourceVersion: 1,
    inputKind: "text",
    title,
    active: true,
    status: "ready",
    evidenceRefs: [evidenceId],
    mentionRefs,
    imageProgress: createEmptyGuideImageProgress(),
    importedAt: "2026-10-19T08:00:00.000Z",
    updatedAt: "2026-10-19T08:00:00.000Z",
  };
}

/** 用户真实补充句（"亚龙湾热带森林公园"缺"天堂"，不得依赖 note 文本做实体匹配） */
const SAMPLE_NOTE =
  "这里有西岛、蜈支洲岛、亚龙湾热带森林公园的推荐理由亮点，我希望你把这个内容补充到我对应的行程景点里";

/** 用户真实验收精确原文（Task #197："亚龙湾森林公园"连"热带"也缺，
 *  但快速路径按 evidence mention extractedName 对齐，不依赖 note 文本） */
const EXACT_USER_NOTE =
  "帮我把这里西岛、蜈支洲岛、亚龙湾森林公园的亮点，补充到我目前的对应景点中";

/**
 * 三景点夹具：复用 fixture 的 visit_wzz（蜈支洲岛，day_2），
 * 新增西岛（day_3）、亚龙湾热带天堂森林公园（day_4）与近似重复的亚龙湾森林公园
 * （day_4）；再放一条同名 pending Stop「西岛」验证同名重复项收敛。
 */
async function setupThreeAttractionsFixture(tripId: string): Promise<void> {
  const trip = await loadTrip(tripId);
  trip.itemRegistry["item_xidao"] = customItem("item_xidao", "西岛", 240);
  trip.itemRegistry["item_ylw"] = customItem("item_ylw", "亚龙湾热带天堂森林公园", 300);
  trip.itemRegistry["item_ylw_dup"] = customItem("item_ylw_dup", "亚龙湾森林公园", 240);

  const day3 = trip.days["day_3"];
  assert.ok(day3 !== undefined, "前提：fixture 应有 day_3");
  const xidaoOrder = day3.scheduleVisitRefs.length;
  day3.scheduleVisitRefs.push("visit_xidao");
  trip.visits["visit_xidao"] = mkVisit("visit_xidao", "day_3", "item_xidao", "large_attraction", xidaoOrder);

  const day4 = trip.days["day_4"];
  assert.ok(day4 !== undefined, "前提：fixture 应有 day_4");
  const ylwOrder = day4.scheduleVisitRefs.length;
  day4.scheduleVisitRefs.push("visit_ylw", "visit_ylw_dup");
  trip.visits["visit_ylw"] = mkVisit("visit_ylw", "day_4", "item_ylw", "large_attraction", ylwOrder);
  trip.visits["visit_ylw_dup"] = mkVisit(
    "visit_ylw_dup",
    "day_4",
    "item_ylw_dup",
    "large_attraction",
    ylwOrder + 1,
  );

  // 历史归类残留：与 day_3 的 Visit 同名的 pending Stop（名称全等命中两个实体）
  const pendingXidao: Stop = {
    stopId: "stop_xidao_dup",
    state: "pending",
    visitRef: null,
    suggestedVisitRef: "visit_xidao",
    matchedPointRef: null,
    customName: "西岛",
    order: null,
    suggestMinutes: 60,
    locationHint: null,
    ticketRelation: "unknown",
    sourceEvidenceRefs: [],
    sourceMentionRefs: [],
    userAdjusted: false,
    removedFromOrder: null,
    removedAt: null,
  };
  trip.stops["stop_xidao_dup"] = pendingXidao;
  trip.pendingStopRefs.push("stop_xidao_dup");

  trip.evidences["ev_193"] = {
    evidenceId: "ev_193",
    kind: "note_text",
    noteIndex: 9,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions: [
      mkMention(
        "m1",
        "蜈支洲岛",
        "蜈支洲岛：建议早8点前登岛避开人流，环岛电瓶车120元一位。",
        "蜈支洲岛",
        "tip",
        "place",
      ),
      // Task #273：同一来源内若出现两种交通方式，会被「按 sourceId 聚合」判定层识别为
      // 可比较选项组信号，快速路径必须回退 planner。本场景要测快速路径本身，
      // 因此西岛这条只保留纯亮点措辞（不含第二/第三种交通方式）。
      mkMention(
        "m2",
        "西岛",
        "西岛：彩色珊瑚石墙超出片，适合慢慢逛。",
        "西岛",
        "experience",
        "place",
      ),
      mkMention(
        "m3",
        "亚龙湾热带天堂森林公园",
        "亚龙湾热带天堂森林公园：可以走过江龙索桥，山顶看亚龙湾全景。",
        "亚龙湾热带天堂森林公园",
        "route_listing",
        "place",
      ),
    ],
  };
  trip.evidences["ev_193_unknown"] = {
    evidenceId: "ev_193_unknown",
    kind: "note_text",
    noteIndex: 10,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions: [
      mkMention(
        "m1",
        "不存在的无人岛",
        "不存在的无人岛：风景很好，但行程里没有这个地点。",
        "不存在的无人岛",
        "experience",
        "place",
      ),
    ],
  };
  // 同实体多条 mention：同文本合并引用 + 每实体最多 2 条提示（第三条被上限丢弃）
  trip.evidences["ev_193_multi"] = {
    evidenceId: "ev_193_multi",
    kind: "note_text",
    noteIndex: 11,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions: [
      mkMention("m1", "西岛", "西岛：租小电驴环岛50元一天。", "西岛", "tip", "place"),
      mkMention("m2", "西岛", "西岛：租小电驴环岛50元一天。", "西岛", "tip", "place"),
      mkMention("m3", "西岛", "西岛：傍晚看日落很美。", "西岛", "experience", "place"),
      mkMention("m4", "西岛", "西岛：珊瑚石墙超出片。", "西岛", "experience", "place"),
    ],
  };

  trip.guideSources = {
    src_193: mkSource("src_193", "三亚三景点推荐理由", "ev_193", [
      "ev_193:m1",
      "ev_193:m2",
      "ev_193:m3",
    ]),
    src_193_unknown: mkSource("src_193_unknown", "未对齐地点来源", "ev_193_unknown", [
      "ev_193_unknown:m1",
    ]),
    src_193_multi: mkSource("src_193_multi", "同实体多条提及", "ev_193_multi", [
      "ev_193_multi:m1",
      "ev_193_multi:m2",
      "ev_193_multi:m3",
      "ev_193_multi:m4",
    ]),
  };
  trip.guideDraftNote = "";
  await tripStore.save(trip);
}

// ===== 断言辅助 =====

interface DraftSnippetView {
  text: string;
  claimKind: string;
  targetRef: { kind: string; id: string };
  sourceMentionRefs: string[];
}

function readSnippets(body: Record<string, unknown>): DraftSnippetView[] {
  return body.snippets as DraftSnippetView[];
}

function snippetByTarget(snippets: DraftSnippetView[], kind: string, id: string): DraftSnippetView | undefined {
  return snippets.find((snippet) => snippet.targetRef.kind === kind && snippet.targetRef.id === id);
}

// ===== main =====

async function main(): Promise<void> {
  try {
    await runScenarios();
    console.log("\n[verify] Task #193（snippet-only 本地快速路径）全部通过 ✓");
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
  const trip = await createFixtureSanyaTrip();
  createdTripIds.push(trip.tripId);
  await setupThreeAttractionsFixture(trip.tripId);
  const tripId = trip.tripId;

  // ---------- 场景 1：用户三景点样例（快速路径命中 + 持久化 + 应用） ----------
  {
    assert.ok(
      SAMPLE_NOTE.includes("亚龙湾热带森林公园") && !SAMPLE_NOTE.includes("亚龙湾热带天堂森林公园"),
      "样例 note 缺「天堂」，实体对齐不得依赖 note 文本",
    );
    armStub();
    const startedAt = Date.now();
    const res = await requestJson(`/trips/${tripId}/draft`, "POST", {
      sourceMode: "selected",
      selectedSourceIds: ["src_193"],
      note: SAMPLE_NOTE,
    });
    const wallMs = Date.now() - startedAt;

    assert.equal(res.status, 200, `生成应 200（实际 ${res.status}：${JSON.stringify(res.body)}）`);
    assert.equal(plannerCalls, 0, "快速路径不得调用百炼 planner");
    assert.equal(res.body.fastPath, true, "应标记 fastPath=true");
    assert.equal(res.body.attempts, 0, "快速路径 attempts=0");
    assert.equal(res.body.promptChars, 0, "快速路径不构建 planner prompt");
    assert.ok(
      Number(res.body.latencyMs) < 1000,
      `快速路径 latencyMs 应 <1000（实际 ${String(res.body.latencyMs)}）`,
    );
    assert.ok(wallMs < 1000, `快速路径端到端应 <1s（实际 ${wallMs}ms）`);
    assert.equal(res.body.sourceMode, "selected");
    assert.deepEqual(res.body.sourceIds, ["src_193"]);
    assert.deepEqual(res.body.operations, [], "快速路径 operations 必须为空数组");
    assert.deepEqual(res.body.optionGroups, [], "快速路径不产出选项组");
    assert.equal((res.body.scope as { kind?: unknown }).kind, "trip", "无对齐实体时 scope 自动判定为整程");

    const snippets = readSnippets(res.body);
    assert.equal(snippets.length, 3, `三景点应产出 3 条提示（实际 ${snippets.length}）`);
    assert.ok(snippets.every((snippet) => [...snippet.text].length <= 40), "提示文本不得超过 40 字硬上限");

    const wzz = snippetByTarget(snippets, "visit", "visit_wzz");
    const xidao = snippetByTarget(snippets, "visit", "visit_xidao");
    const ylw = snippetByTarget(snippets, "visit", "visit_ylw");
    assert.ok(wzz !== undefined, "蜈支洲岛提示应挂到 fixture 的 visit_wzz");
    assert.ok(xidao !== undefined, "西岛提示应挂到 visit_xidao（而非同名 pending Stop）");
    assert.ok(ylw !== undefined, "亚龙湾热带天堂森林公园应挂到完整名称 Visit");
    assert.equal(
      snippetByTarget(snippets, "visit", "visit_ylw_dup"),
      undefined,
      "近似重复 Visit（亚龙湾森林公园）不得抢走提示",
    );

    assert.deepEqual(wzz.sourceMentionRefs, ["ev_193:m1"], "蜈支洲岛提示引用应精确");
    assert.deepEqual(xidao.sourceMentionRefs, ["ev_193:m2"], "西岛提示引用应精确");
    assert.deepEqual(ylw.sourceMentionRefs, ["ev_193:m3"], "亚龙湾提示引用应精确");
    assert.ok(wzz.text.includes("120元"), `价格亮点不得丢失（实际：${wzz.text}）`);
    assert.ok(wzz.text.length > 0 && xidao.text.length > 0 && ylw.text.length > 0, "提示文本非空");

    // 草案持久化：sourceMode / sourceIds / note / 0 操作 / 空 optionGroups 不写键
    const saved = await loadTrip(tripId);
    const draft = saved.pendingGuideDraft;
    assert.ok(draft !== undefined && draft.output !== undefined, "草案应持久化");
    assert.equal(draft.sourceMode, "selected", "草案应记录 sourceMode=selected");
    assert.deepEqual(draft.sourceIds, ["src_193"], "草案应记录所选来源 id");
    assert.equal(draft.note, SAMPLE_NOTE, "草案应保存补充句快照（逐字）");
    assert.deepEqual(draft.output.operations, [], "持久化 operations 为空");
    assert.equal(draft.output.snippets.length, 3, "持久化 3 条提示");
    assert.equal("optionGroups" in draft.output, false, "空选项组不写键（旧消费方零感知）");

    // 草案应用：快速路径产物走同一挂载链路
    const applyRes = await requestJson(`/trips/${tripId}/draft/apply`, "POST");
    assert.equal(applyRes.status, 200, `应用应 200（实际 ${JSON.stringify(applyRes.body)}）`);
    assert.equal(applyRes.body.attachedSnippetCount, 3, "应用应挂载 3 条提示");
    assert.equal(applyRes.body.attachedOptionGroupCount, 0, "无选项组挂载");
    const applied = await loadTrip(tripId);
    assert.equal(applied.visits["visit_wzz"]?.guideSnippets?.length ?? 0, 1, "蜈支洲岛应挂 1 条");
    assert.equal(applied.visits["visit_xidao"]?.guideSnippets?.length ?? 0, 1, "西岛应挂 1 条");
    assert.equal(applied.visits["visit_ylw"]?.guideSnippets?.length ?? 0, 1, "亚龙湾应挂 1 条");
    assert.equal(applied.visits["visit_ylw_dup"]?.guideSnippets, undefined, "近似重复 Visit 无提示");
    assert.equal(applied.pendingGuideDraft, undefined, "草案应一次性消费清除");
    pass("1. 样例命中：0 次百炼 / 0 操作 / 3 条提示 / 毫秒级 / 目标与引用精确 / 持久化与应用");
  }

  // ---------- 场景 2：merge 已确定 entityRef 优先（近似重复 Visit 名称不得二次匹配） ----------
  {
    const t = await loadTrip(tripId);
    t.visits["visit_ylw_dup"].sourceMentionRefs = ["ev_193:m3"];
    await tripStore.save(t);

    armStub();
    const res = await requestJson(`/trips/${tripId}/draft`, "POST", {
      sourceMode: "selected",
      selectedSourceIds: ["src_193"],
      note: SAMPLE_NOTE,
    });
    assert.equal(res.status, 200, `生成应 200（实际 ${JSON.stringify(res.body)}）`);
    assert.equal(plannerCalls, 0, "实体已由 merge 确定时仍应命中快速路径");
    assert.equal(res.body.fastPath, true);
    const snippets = readSnippets(res.body);
    const ylwSnippet = snippets.find((snippet) => snippet.sourceMentionRefs.includes("ev_193:m3"));
    assert.ok(ylwSnippet !== undefined, "应产出亚龙湾提示");
    assert.deepEqual(
      ylwSnippet.targetRef,
      { kind: "visit", id: "visit_ylw_dup" },
      "必须使用 merge 已确定的 entityRef，不得按名称改挂 visit_ylw",
    );

    const restore = await loadTrip(tripId);
    restore.visits["visit_ylw_dup"].sourceMentionRefs = [];
    await tripStore.save(restore);
    pass("2. merge 归属优先：refs 指向近似重复 Visit 时只认 merge 结果");
  }

  // ---------- 场景 3：「加个亮点 / 推荐理由」不误判为新增地点 ----------
  {
    armStub();
    const res = await requestJson(`/trips/${tripId}/draft`, "POST", {
      sourceMode: "selected",
      selectedSourceIds: ["src_193"],
      note: "补充一下西岛的推荐理由，加个亮点说明。",
    });
    assert.equal(res.status, 200);
    assert.equal(plannerCalls, 0, "「加个亮点」是补充语义，不应触发 AI");
    assert.equal(res.body.fastPath, true, "负向前瞻应放行补充类「加个」");
    pass("3. 补充语义：「加个亮点 / 推荐理由」不误判为新增地点");
  }

  // ---------- 场景 4：同实体多条 mention（去重合并 + 每实体上限 2 条） ----------
  {
    armStub();
    const res = await requestJson(`/trips/${tripId}/draft`, "POST", {
      sourceMode: "selected",
      selectedSourceIds: ["src_193_multi"],
      note: SAMPLE_NOTE,
    });
    assert.equal(res.status, 200);
    assert.equal(plannerCalls, 0, "同实体多条提及仍应命中快速路径");
    assert.equal(res.body.fastPath, true);
    const snippets = readSnippets(res.body);
    assert.equal(snippets.length, 2, `每实体最多 2 条提示（实际 ${snippets.length}）`);
    assert.ok(snippets.every((snippet) => snippet.targetRef.kind === "visit" && snippet.targetRef.id === "visit_xidao"));
    const merged = snippets.find((snippet) => snippet.text.includes("50元"));
    assert.ok(merged !== undefined, "价格提示应保留");
    assert.deepEqual(
      merged.sourceMentionRefs,
      ["ev_193_multi:m1", "ev_193_multi:m2"],
      "同文本提及应合并引用（不超过 3 条）",
    );
    pass("4. 同实体：同文本合并引用 / 每实体最多 2 条提示（第三组被上限丢弃）");
  }

  // ---------- 场景 5：all 模式回落 ----------
  {
    armStub();
    const res = await requestJson(`/trips/${tripId}/draft`, "POST", { note: SAMPLE_NOTE });
    assert.equal(res.status, 200);
    assert.equal(res.body.fastPath, false, "all 模式不得走快速路径");
    assert.equal(plannerCalls, 1, "all 模式应调用一次 planner");
    assert.ok(capturedPrompts[0]?.includes(SAMPLE_NOTE), "回落时 prompt 应含补充句");
    pass("5. 回落：all 模式（sourceMode 缺省）");
  }

  // ---------- 场景 6：新增地点回落 ----------
  {
    armStub();
    const res = await requestJson(`/trips/${tripId}/draft`, "POST", {
      sourceMode: "selected",
      selectedSourceIds: ["src_193"],
      note: "把西岛、蜈支洲岛的推荐理由亮点补充到行程里，再加个天涯海角。",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.fastPath, false, "新增地点意图不得走快速路径");
    assert.equal(plannerCalls, 1);
    pass("6. 回落：新增地点（再加个天涯海角）");
  }

  // ---------- 场景 7：日期指令回落 ----------
  {
    armStub();
    const res = await requestJson(`/trips/${tripId}/draft`, "POST", {
      sourceMode: "selected",
      selectedSourceIds: ["src_193"],
      note: "把西岛的推荐理由亮点补充到第3天。",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.fastPath, false, "日期指令不得走快速路径");
    assert.equal(plannerCalls, 1);
    assert.equal((res.body.directives as unknown[]).length, 1, "日期指令应被解析并保留");
    pass("7. 回落：日期指令（第3天）");
  }

  // ---------- 场景 8：调序回落 ----------
  {
    armStub();
    const res = await requestJson(`/trips/${tripId}/draft`, "POST", {
      sourceMode: "selected",
      selectedSourceIds: ["src_193"],
      note: "把西岛的推荐理由亮点补充到行程里，顺便把顺序调整一下。",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.fastPath, false, "调序 / 整体调整意图不得走快速路径");
    assert.equal(plannerCalls, 1);
    pass("8. 回落：调序 / 整体调整");
  }

  // ---------- 场景 9：未对齐 mention 回落 ----------
  {
    armStub();
    const res = await requestJson(`/trips/${tripId}/draft`, "POST", {
      sourceMode: "selected",
      selectedSourceIds: ["src_193", "src_193_unknown"],
      note: SAMPLE_NOTE,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.fastPath, false, "存在未对齐地点必须回落 AI");
    assert.equal(plannerCalls, 1);
    assert.ok(
      capturedPrompts[0]?.includes("不存在的无人岛"),
      "回落 prompt 应包含未对齐地点（交由 AI 判断）",
    );
    pass("9. 回落：存在未对齐 mention（不存在的无人岛）");
  }

  // ---------- 场景 10：模糊 / 复杂 note 回落 ----------
  {
    armStub();
    const res = await requestJson(`/trips/${tripId}/draft`, "POST", {
      sourceMode: "selected",
      selectedSourceIds: ["src_193"],
      note: "帮我优化一下这些攻略。",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.fastPath, false, "普通优化行程不得误判为 snippet-only");
    assert.equal(plannerCalls, 1);
    pass("10. 回落：模糊 / 复杂 note（优化攻略）");
  }

  // ---------- 场景 12：用户真实验收精确 note（Task #197："补充到…对应景点中"） ----------
  {
    armStub();
    const startedAt12 = Date.now();
    const res = await requestJson(`/trips/${tripId}/draft`, "POST", {
      sourceMode: "selected",
      selectedSourceIds: ["src_193"],
      note: EXACT_USER_NOTE,
    });
    const wallMs12 = Date.now() - startedAt12;

    assert.equal(res.status, 200, `生成应 200（实际 ${res.status}：${JSON.stringify(res.body)}）`);
    assert.equal(plannerCalls, 0, "用户精确 note 不得调用百炼 planner");
    assert.equal(res.body.fastPath, true, "用户精确 note 应标记 fastPath=true");
    assert.equal(res.body.attempts, 0);
    assert.equal(res.body.promptChars, 0);
    assert.ok(
      Number(res.body.latencyMs) < 1000,
      `用户精确 note 快速路径 latencyMs 应 <1000（实际 ${String(res.body.latencyMs)}）`,
    );
    assert.ok(wallMs12 < 1000, `用户精确 note 端到端应 <1s（实际 ${wallMs12}ms）`);
    assert.deepEqual(res.body.operations, [], "快速路径 operations 为空");
    assert.deepEqual(res.body.optionGroups, [], "快速路径 optionGroups 为空");

    const snippets12 = readSnippets(res.body);
    assert.equal(snippets12.length, 3, `三景点应产出 3 条提示（实际 ${snippets12.length}）`);
    const wzz12 = snippetByTarget(snippets12, "visit", "visit_wzz");
    const xidao12 = snippetByTarget(snippets12, "visit", "visit_xidao");
    const ylw12 = snippetByTarget(snippets12, "visit", "visit_ylw");
    assert.ok(wzz12 !== undefined, "蜈支洲岛提示应挂到 visit_wzz");
    assert.ok(xidao12 !== undefined, "西岛提示应挂到 visit_xidao");
    assert.ok(ylw12 !== undefined, "亚龙湾提示应挂到 visit_ylw");
    assert.deepEqual(wzz12.sourceMentionRefs, ["ev_193:m1"], "蜈支洲岛引用精确");
    assert.deepEqual(xidao12.sourceMentionRefs, ["ev_193:m2"], "西岛引用精确");
    assert.deepEqual(ylw12.sourceMentionRefs, ["ev_193:m3"], "亚龙湾引用精确");

    // 持久化验证：note 逐字保存
    const saved12 = await loadTrip(tripId);
    assert.equal(saved12.pendingGuideDraft?.note, EXACT_USER_NOTE, "草案保存用户精确 note（逐字）");
    pass("12. Task #197 用户精确 note：0 次百炼 / 0 操作 / 3 条提示 / <1s / 引用精确");
  }

  // ---------- 场景 13：快速路径版本保护（并发修改 → 409 且不覆盖旧草案） ----------
  {
    const before = await loadTrip(tripId);
    const oldDraftId = before.pendingGuideDraft?.draftId;
    assert.ok(oldDraftId !== undefined, "前提：上一场景应留下待应用草案");

    armStub();
    beforeDraftSaveHook = async (targetTripId: string) => {
      const latest = await loadTrip(targetTripId);
      // Task #307：模拟生成期间的「真冲突」并发修改——改动排程（翻转某 Visit 锁定标志），
      // 使排程指纹变化。纯 version bump（图片结算类非冲突写）已被 rebase 容忍，不再作废，
      // 因此本用例必须制造排程级冲突才能验证快速路径仍守 DRAFT_STALE 护栏。
      const anyVisitId = Object.keys(latest.visits)[0];
      assert.ok(anyVisitId !== undefined, "前提：夹具行程应至少有一个 Visit");
      latest.visits[anyVisitId].locked = !latest.visits[anyVisitId].locked;
      await tripStore.save(latest);
    };
    const res = await requestJson(`/trips/${tripId}/draft`, "POST", {
      sourceMode: "selected",
      selectedSourceIds: ["src_193"],
      note: SAMPLE_NOTE,
    });
    beforeDraftSaveHook = undefined;

    assert.equal(res.status, 409, `并发修改应 409（实际 ${res.status}：${JSON.stringify(res.body)}）`);
    assert.equal(res.body.code, "DRAFT_STALE", "错误码应为 DRAFT_STALE");
    assert.equal(plannerCalls, 0, "快速路径仍不调用 planner");
    assert.deepEqual(res.body.optionGroups, [], "错误形状 optionGroups 补空数组");
    assert.equal(res.body.fastPath, false, "错误形状 fastPath 补 false");

    const after = await loadTrip(tripId);
    assert.equal(after.pendingGuideDraft?.draftId, oldDraftId, "版本变化时不得覆盖既有草案");
    pass("13. 版本保护：并发改排程（真冲突）→ 409 DRAFT_STALE / 不写入旧草案 / 错误形状同契约");
  }
}

void main();
