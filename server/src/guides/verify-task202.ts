/**
 * Task #202 端到端验证：前端 sourceMode 传递 → 亮点补充 snippet-only 快速路径命中。
 *
 * 与 verify-task193 的区别：请求体不再硬编码，而是调用前端真实的
 * web/src/api/client.ts generateGuideDraft（client 仅依赖 type-only import 与全局
 * fetch，可在 node 直接复用），通过桥接 globalThis.fetch 把请求转发到内存 Hono
 * app（guideRoutes）——精确复现「浏览器点击生成 → HTTP 请求体 → 服务端路由解析
 * → 快速路径判定」全链路，填补两段既有测试之间的契约盲区：
 *   - 前端测试 mock 掉了 generateGuideDraft（验证不到 HTTP body 序列化）；
 *   - 服务端验证硬编码请求体（验证不到前端传参）。
 * 若未来 client.ts 的 sourceMode 序列化被改坏（发 all / 丢字段），本脚本立即失败。
 *
 * 覆盖：
 *   1. 用户验收场景（选择态点击生成：sourceMode="selected" + 单篇来源 + 用户精确
 *      note）：请求体形状断言（sourceMode / selectedSourceIds / note / entryContext
 *      四字段齐全）→ fastPath=true、planner 0 调用、墙钟 <2s、响应 latencyMs <1s、
 *      服务端日志出现「命中 snippet-only 快速路径」标记、3 条提示精确挂载；
 *   2. 整体重排（sourceMode="all"）：请求体不携带 selectedSourceIds（互斥契约）
 *      → 回落 AI（plannerCalls=1、fastPath=false）；
 *   3. 旧调用方缺省（不传 sourceMode）：请求体无 sourceMode 键 → 服务端归一 all
 *      → 回落 AI；
 *   4. 空 note 契约：note 为空串时请求体不携带 note 键；服务端沿用已存补充句仍命中。
 *
 * 运行：npx tsx server/src/guides/verify-task202.ts
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

// ===== 前端真实请求构建函数（运行时动态加载 web 源码，绕开 tsc 跨包 rootDir 限制） =====

/** 与 web/src/api/client.ts generateGuideDraft 签名同构（本地声明，避免静态跨包 import） */
interface GenerateGuideDraftFn {
  (tripId: string, input: {
    entryContext?: { type: "global" } | { type: "day"; dayIndex: number } | { type: "attraction"; visitId: string };
    note?: string;
    sourceMode?: "all" | "selected";
    selectedSourceIds?: string[];
  }): Promise<DraftResultView>;
}

/** 与 web GuideDraftResult / server GuideDraftResult 同构的响应视图（本脚本断言所需字段） */
interface DraftResultView {
  draftId: string | null;
  fastPath?: boolean;
  sourceMode?: "all" | "selected";
  sourceIds?: string[];
  attempts: number;
  promptChars: number;
  latencyMs: number;
  snippets: DraftSnippetView[];
}

/** 动态加载前端 client.ts（tsx 把 .js 请求映射到同名 .ts，与 server 内部导入同机制） */
async function loadWebGenerateGuideDraft(): Promise<GenerateGuideDraftFn> {
  const clientUrl = new URL("../../../web/src/api/client.js", import.meta.url);
  const mod = (await import(clientUrl.href)) as {
    generateGuideDraft: GenerateGuideDraftFn;
  };
  return mod.generateGuideDraft;
}

// ===== 基础辅助 =====

function pass(name: string): void {
  console.log(`✓ ${name}`);
}

/** 本脚本创建的临时行程：finally 统一清理 */
const createdTripIds: string[] = [];

// ===== fetch 桥接：前端 generateGuideDraft → 内存 Hono app =====

interface CapturedRequest {
  url: string;
  body: Record<string, unknown> | null;
}

const originalFetch = globalThis.fetch;
let captured: CapturedRequest | null = null;

function installFetchBridge(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    assert.ok(
      url.startsWith("/api/guides/trips/") && url.endsWith("/draft"),
      `桥接只应收到草案生成请求（实际 ${url}）`,
    );
    captured = {
      url,
      body: init?.body != null ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    };
    // 服务端路由挂载于 /api/guides，guideRoutes 内部路径从 /trips 开始
    const routePath = url.replace("/api/guides", "");
    return guideRoutes.request(routePath, init);
  }) as typeof fetch;
}

/** 前端请求体形状断言（调用后 captured 必为当次请求） */
function requireCapturedBody(): Record<string, unknown> {
  assert.ok(captured !== null, "应捕获到前端发出的请求");
  assert.ok(captured.body !== null, "草案生成请求必须携带 JSON body");
  return captured.body;
}

// ===== 服务端日志捕获（验证 fast path 标记进入服务端日志） =====

const serverLogs: string[] = [];
const originalConsoleLog = console.log;
console.log = (...args: unknown[]) => {
  serverLogs.push(args.map((arg) => String(arg)).join(" "));
  originalConsoleLog(...args);
};

function clearServerLogs(): void {
  serverLogs.length = 0;
}

// ===== planner 桩（调用计数；生产依赖零触网） =====

let plannerCalls = 0;

/** 未命中快速路径时的合法空草案（解析成功、0 操作 0 提示） */
const AI_EMPTY_JSON = JSON.stringify({ operations: [], snippets: [] });

setGuidePlannerDeps({
  callPlanner: async () => {
    plannerCalls += 1;
    return AI_EMPTY_JSON;
  },
});

function armStub(): void {
  plannerCalls = 0;
  clearServerLogs();
}

// ===== 夹具辅助（三景点：蜈支洲岛复用 fixture 自带 visit_wzz） =====

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
    claimKind: "experience",
    targetScope: "place",
    firsthand: true,
    relationEvidence: null,
  };
}

function customItem(itemId: string, name: string, suggestMinutes: number): Item {
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
  order: number,
): Visit {
  return {
    visitId,
    dayRef,
    pointRef,
    kind: "large_attraction",
    visitMode: "full_day",
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

function mkSource(sourceId: string, title: string, evidenceId: string, mentionRefs: string[]): GuideSource {
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
    importedAt: "2026-10-20T08:00:00.000Z",
    updatedAt: "2026-10-20T08:00:00.000Z",
  };
}

/** 用户真实验收补充说明（与 verify-task193 EXACT_USER_NOTE 同原文） */
const EXACT_USER_NOTE = "帮我把这里西岛、蜈支洲岛、亚龙湾森林公园的亮点，补充到我目前的对应景点中";

/** 单篇文字攻略（三段推荐理由）+ 行程三景点 + 同名 pending Stop / 近似重复 Visit 干扰项 */
async function setupSingleTextSourceFixture(tripId: string): Promise<void> {
  const trip = await tripStore.load(tripId);
  assert.ok(trip !== null, `行程 ${tripId} 应存在`);
  const t = trip as Trip;

  t.itemRegistry["item_xidao"] = customItem("item_xidao", "西岛", 240);
  t.itemRegistry["item_ylw"] = customItem("item_ylw", "亚龙湾热带天堂森林公园", 300);
  t.itemRegistry["item_ylw_dup"] = customItem("item_ylw_dup", "亚龙湾森林公园", 240);

  const day3 = t.days["day_3"];
  assert.ok(day3 !== undefined, "前提：fixture 应有 day_3");
  day3.scheduleVisitRefs.push("visit_xidao");
  t.visits["visit_xidao"] = mkVisit("visit_xidao", "day_3", "item_xidao", day3.scheduleVisitRefs.length - 1);

  const day4 = t.days["day_4"];
  assert.ok(day4 !== undefined, "前提：fixture 应有 day_4");
  day4.scheduleVisitRefs.push("visit_ylw", "visit_ylw_dup");
  t.visits["visit_ylw"] = mkVisit("visit_ylw", "day_4", "item_ylw", day4.scheduleVisitRefs.length - 2);
  t.visits["visit_ylw_dup"] = mkVisit("visit_ylw_dup", "day_4", "item_ylw_dup", day4.scheduleVisitRefs.length - 1);

  // 历史归类残留：与 day_3 Visit 同名的 pending Stop（验证同名重复项按优先级收敛，不回落）
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
  t.stops["stop_xidao_dup"] = pendingXidao;
  t.pendingStopRefs.push("stop_xidao_dup");

  t.evidences["ev_202"] = {
    evidenceId: "ev_202",
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
      ),
      // Task #273：同一来源出现两种交通方式会被「按 sourceId 聚合」判定层判为可比较
      // 选项组信号，快速路径必须回退 planner；本场景要测快速路径，故只留纯亮点措辞。
      mkMention(
        "m2",
        "西岛",
        "西岛：彩色珊瑚石墙超出片，适合慢慢逛。",
        "西岛",
      ),
      mkMention(
        "m3",
        "亚龙湾热带天堂森林公园",
        "亚龙湾热带天堂森林公园：可以走过江龙索桥，山顶看亚龙湾全景。",
        "亚龙湾热带天堂森林公园",
      ),
    ],
  };

  t.guideSources = {
    src_202: mkSource("src_202", "三亚三景点推荐理由", "ev_202", [
      "ev_202:m1",
      "ev_202:m2",
      "ev_202:m3",
    ]),
  };
  t.guideDraftNote = "";
  await tripStore.save(t);
}

// ===== 断言辅助 =====

interface DraftSnippetView {
  text: string;
  targetRef: { kind: string; id: string };
  sourceMentionRefs: string[];
}
// ===== 场景 =====

async function runScenarios(): Promise<void> {
  // 运行时加载前端真实请求构建函数（含 sourceMode → HTTP body 的完整序列化逻辑）
  const generateGuideDraft = await loadWebGenerateGuideDraft();
  const trip = await createFixtureSanyaTrip();
  createdTripIds.push(trip.tripId);
  const tripId = trip.tripId;
  await setupSingleTextSourceFixture(tripId);

  // ---------- 场景 1：用户验收场景（选择态点击生成 → 快速路径命中） ----------
  {
    armStub();
    const startedAt = Date.now();
    // 参数与 GuideDraftPanel 选择态 handlePrimary 完全一致（顶栏入口 + 所选单篇 + 补充说明）
    const result = await generateGuideDraft(tripId, {
      entryContext: { type: "global" },
      note: EXACT_USER_NOTE,
      sourceMode: "selected",
      selectedSourceIds: ["src_202"],
    });
    const wallMs = Date.now() - startedAt;

    // 前端请求体形状（任务 #202 要求的 JSON 契约）
    const body = requireCapturedBody();
    assert.equal(body.sourceMode, "selected", "请求体必须携带 sourceMode=selected");
    assert.deepEqual(body.selectedSourceIds, ["src_202"], "请求体必须携带选中的来源 id 数组");
    assert.equal(body.note, EXACT_USER_NOTE, "请求体必须携带用户补充说明");
    assert.deepEqual(body.entryContext, { type: "global" }, "请求体应携带面板入口上下文");

    // 快速路径命中：跳过百炼、毫秒级、日志标记
    assert.equal(plannerCalls, 0, "快速路径不得调用百炼 planner");
    assert.equal(result.fastPath, true, "响应应标记 fastPath=true");
    assert.equal(result.attempts, 0, "快速路径 attempts=0");
    assert.equal(result.promptChars, 0, "快速路径不构建 planner prompt");
    assert.equal(result.sourceMode, "selected");
    assert.deepEqual(result.sourceIds, ["src_202"]);
    assert.ok(wallMs < 2000, `端到端耗时应 <2s（实际 ${wallMs}ms）`);
    assert.ok(Number(result.latencyMs) < 1000, `服务端 latencyMs 应 <1s（实际 ${String(result.latencyMs)}）`);
    assert.ok(
      serverLogs.some((log) => log.includes("命中 snippet-only 快速路径")),
      "服务端日志应出现快速路径命中标记",
    );

    // 三条提示精确挂载到对应行程景点
    const snippets = result.snippets;
    assert.equal(snippets.length, 3, `应产出 3 条提示（实际 ${snippets.length}）`);
    const refSet = new Set(snippets.flatMap((snippet) => snippet.sourceMentionRefs));
    assert.deepEqual([...refSet].sort(), ["ev_202:m1", "ev_202:m2", "ev_202:m3"], "提示引用应精确覆盖三条原文");
    assert.ok(
      snippets.every((snippet) => snippet.targetRef.kind === "visit"),
      `提示目标应为已排期 Visit（实际 ${JSON.stringify(snippets.map((snippet) => snippet.targetRef))}）`,
    );
    const wzz = snippets.find((snippet) => snippet.sourceMentionRefs.includes("ev_202:m1"));
    assert.ok(wzz !== undefined && wzz.text.includes("120元"), "蜈支洲岛价格亮点不得丢失");
    pass(
      `1. selected+精确 note：请求体契约 ✓ / fastPath=true / planner 0 调用 / 端到端 ${wallMs}ms / 日志标记 ✓`,
    );
  }

  // ---------- 场景 2：整体重排 all 模式（互斥契约 + 回落 AI） ----------
  {
    armStub();
    const result = await generateGuideDraft(tripId, {
      entryContext: { type: "global" },
      note: EXACT_USER_NOTE,
      sourceMode: "all",
    });
    const body = requireCapturedBody();
    assert.equal(body.sourceMode, "all", "整体重排应显式发送 sourceMode=all");
    assert.ok(
      !("selectedSourceIds" in body),
      "all 模式请求体不得携带 selectedSourceIds（服务端互斥校验）",
    );
    assert.equal(result.fastPath, false, "all 模式不得走快速路径");
    assert.equal(plannerCalls, 1, "all 模式应回落调用一次 planner");
    assert.ok(
      !serverLogs.some((log) => log.includes("命中 snippet-only 快速路径")),
      "all 模式不应出现快速路径命中日志",
    );
    pass("2. all 模式：请求体互斥契约 ✓ / 回落 AI（plannerCalls=1）");
  }

  // ---------- 场景 3：旧调用方缺省（不传 sourceMode → 归一 all 回落） ----------
  {
    armStub();
    const result = await generateGuideDraft(tripId, {
      entryContext: { type: "global" },
      note: EXACT_USER_NOTE,
    });
    const body = requireCapturedBody();
    assert.ok(
      !("sourceMode" in body),
      "缺省模式请求体不得携带 sourceMode 键（旧调用方语义）",
    );
    assert.equal(result.fastPath, false, "缺省（归一 all）不得走快速路径");
    assert.equal(plannerCalls, 1, "缺省模式应回落调用一次 planner");
    pass("3. 缺省模式：请求体无 sourceMode 键 / 服务端归一 all 回落 AI");
  }

  // ---------- 场景 4：空 note 契约（前端不携带 note 键；服务端沿用已存补充句仍命中） ----------
  {
    armStub();
    // 前端契约：note 为空串时不携带 note 键（模拟补充说明留空点击生成）
    const result = await generateGuideDraft(tripId, {
      entryContext: { type: "global" },
      note: "",
      sourceMode: "selected",
      selectedSourceIds: ["src_202"],
    });
    const body = requireCapturedBody();
    assert.ok(!("note" in body), "空 note 请求体不得携带 note 键");
    assert.equal(body.sourceMode, "selected", "空 note 时 sourceMode 仍必须正确传递");
    // 服务端沿用场景 1 写入的 trip.guideDraftNote（同一补充句）→ 仍命中快速路径
    assert.equal(result.fastPath, true, "沿用已存补充句时仍应命中快速路径");
    assert.equal(plannerCalls, 0, "命中快速路径不得调用百炼 planner");
    pass("4. 空 note 契约：不携带 note 键 / 服务端沿用已存补充句仍命中");
  }
}

// ===== main =====

async function main(): Promise<void> {
  installFetchBridge();
  try {
    await runScenarios();
    console.log("\n[verify] Task #202（前端 sourceMode 传递 → 快速路径端到端）全部通过 ✓");
  } finally {
    console.log = originalConsoleLog;
    globalThis.fetch = originalFetch;
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

void main();
