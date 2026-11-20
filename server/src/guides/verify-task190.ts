/**
 * Task #190 实用参考选项组端到端验证（B3 planner 链路，全程离线）。
 *
 * setGuidePlannerDeps 桩注入 callPlanner，不触网、不调用真实百炼：
 *   1. 生成链路（golden：西岛环岛交通 三轮车/电动车/观光车 + 非交通：渔村食堂套餐）：
 *      prompt 含 optionGroups 契约节与素材原文；解析层——单选组丢弃（日落观赏点）、
 *      编造引用组丢弃（潜水租赁：选项与组级引用过滤后为空）、合法 3 组随草案持久化
 *      （output.optionGroups 落盘；交通 golden / 餐饮 / 牛王岛）；
 *   2. 应用链路：attachedOptionGroupCount 精确（牛王岛组强证据不足拒挂，其余 2 组挂载）；
 *      stop targetRef 归一到父 Visit（渔村套餐挂 visit_xidao 而非 stop）；
 *      字段无臆测（bargain=null / 缺失字段=null 原样落盘）；
 *   3. 去重合并：二次草案同主题新选项「双人自行车」→ 新增组数 0、选项并入 4 条、
 *      既有组 collectedAt 保留首见值；
 *   4. 历史兼容：旧形状草案（无 optionGroups 键）生成与应用零异常、
 *      attachedOptionGroupCount=0、snippet 链路不受影响（历史 Trip 零迁移）。
 *
 * 运行：npx tsx server/src/guides/verify-task190.ts
 * 临时行程（server/data）在脚本末尾全部清理，不影响用户既有数据。
 */

import "../env.js";
import assert from "node:assert/strict";
import type {
  GuideSource,
  Item,
  SourceEvidence,
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

// ===== 夹具：西岛（大景区）+ 渔村（内部玩法）+ 一篇攻略证据 =====

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

function mkVisit(visitId: string, pointRef: string, kind: Visit["kind"], order: number): Visit {
  return {
    visitId,
    dayRef: "day_1",
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

/**
 * 西岛夹具：visit_xidao（large_attraction）← m_xd（环岛交通原文）；
 * stop_fucun（渔村，child）← m_cun（套餐原文）；m_other = 牛王岛（无关提及）。
 */
async function setupXidaoFixture(tripId: string): Promise<void> {
  const trip = await loadTrip(tripId);
  trip.itemRegistry["item_xidao"] = customItem("item_xidao", "西岛", 240);
  trip.itemRegistry["item_fucun"] = customItem("item_fucun", "西岛渔村", 60);

  const day1 = trip.days["day_1"];
  assert.ok(day1 !== undefined, "前提：fixture 应有 day_1");
  day1.scheduleVisitRefs = [...day1.scheduleVisitRefs, "visit_xidao"];
  const orderInDay = day1.scheduleVisitRefs.length - 1;
  const visitXidao = mkVisit("visit_xidao", "item_xidao", "large_attraction", orderInDay);
  visitXidao.sourceMentionRefs = ["ev_xd:m_xd"];
  visitXidao.childStopRefs = ["stop_fucun"];
  trip.visits["visit_xidao"] = visitXidao;

  trip.stops["stop_fucun"] = {
    stopId: "stop_fucun",
    state: "attached",
    visitRef: "visit_xidao",
    suggestedVisitRef: null,
    matchedPointRef: "item_fucun",
    customName: null,
    order: 0,
    suggestMinutes: 60,
    locationHint: "码头步行五分钟",
    ticketRelation: "included",
    sourceEvidenceRefs: ["ev_xd"],
    sourceMentionRefs: ["ev_xd:m_cun"],
    userAdjusted: false,
    removedFromOrder: null,
    removedAt: null,
  };

  trip.evidences["ev_xd"] = {
    evidenceId: "ev_xd",
    kind: "note_text",
    noteIndex: 7,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions: [
      mkMention(
        "m_xd",
        "西岛",
        "西岛环岛交通：三轮车50元一圈可以砍价，电动车30元一小时，观光车20元一圈环岛一周",
        "西岛",
        "route_listing",
        "place",
      ),
      mkMention(
        "m_cun",
        "西岛渔村",
        "渔村食堂双人套餐68元，单点人均50元左右",
        "西岛渔村",
        "comparison",
        "place",
      ),
      mkMention("m_other", "牛王岛", "牛王岛船票往返120元", "牛王岛", "route_listing", "place"),
    ],
  };

  const source: GuideSource = {
    sourceId: "src_xd",
    sourceVersion: 1,
    inputKind: "text",
    title: "西岛一日游攻略",
    active: true,
    status: "ready",
    evidenceRefs: ["ev_xd"],
    mentionRefs: ["ev_xd:m_xd", "ev_xd:m_cun", "ev_xd:m_other"],
    imageProgress: createEmptyGuideImageProgress(),
    importedAt: "2026-10-19T08:00:00.000Z",
    updatedAt: "2026-10-19T08:00:00.000Z",
  };
  trip.guideSources = { src_xd: source };
  trip.guideDraftNote = "";
  await tripStore.save(trip);
}

// ===== 桩响应 =====

/** golden 5 组：交通 golden / 餐饮（stop 归属）/ 牛王岛（无关引用）/ 单选（不成组）/ 编造引用（丢弃） */
const STUB_OPTION_GROUPS_JSON = JSON.stringify({
  operations: [],
  snippets: [],
  optionGroups: [
    {
      topic: "西岛环岛交通",
      category: "transport",
      targetRef: { kind: "visit", id: "visit_xidao" },
      sourceMentionRefs: ["ev_xd:m_xd"],
      options: [
        {
          label: "三轮车",
          priceText: "50元/圈",
          routeText: null,
          sceneText: "带老人小孩省力",
          bargain: true,
          noteText: "可随时停车",
          sourceMentionRefs: ["ev_xd:m_xd"],
        },
        {
          label: "电动车",
          priceText: "30元/小时",
          routeText: null,
          sceneText: null,
          bargain: null,
          noteText: null,
          sourceMentionRefs: ["ev_xd:m_xd"],
        },
        {
          label: "观光车",
          priceText: "20元/圈",
          routeText: "环岛一周",
          sceneText: null,
          bargain: null,
          noteText: null,
          sourceMentionRefs: ["ev_xd:m_xd"],
        },
      ],
    },
    {
      topic: "渔村食堂套餐",
      category: "dining",
      targetRef: { kind: "stop", id: "stop_fucun" },
      sourceMentionRefs: ["ev_xd:m_cun"],
      options: [
        {
          label: "双人套餐",
          priceText: "68元",
          routeText: null,
          sceneText: null,
          bargain: null,
          noteText: null,
          sourceMentionRefs: ["ev_xd:m_cun"],
        },
        {
          label: "单点",
          priceText: "人均50元左右",
          routeText: null,
          sceneText: null,
          bargain: null,
          noteText: null,
          sourceMentionRefs: ["ev_xd:m_cun"],
        },
      ],
    },
    {
      topic: "牛王岛船票",
      category: "ticket",
      targetRef: { kind: "visit", id: "visit_xidao" },
      sourceMentionRefs: ["ev_xd:m_other"],
      options: [
        {
          label: "往返船票",
          priceText: "120元",
          routeText: null,
          sceneText: null,
          bargain: null,
          noteText: null,
          sourceMentionRefs: ["ev_xd:m_other"],
        },
        {
          label: "单程船票",
          priceText: "70元",
          routeText: null,
          sceneText: null,
          bargain: null,
          noteText: null,
          sourceMentionRefs: ["ev_xd:m_other"],
        },
      ],
    },
    {
      topic: "日落观赏点",
      category: "activity",
      targetRef: { kind: "visit", id: "visit_xidao" },
      sourceMentionRefs: ["ev_xd:m_xd"],
      options: [
        {
          label: "山顶平台",
          priceText: "免费",
          routeText: null,
          sceneText: null,
          bargain: null,
          noteText: null,
          sourceMentionRefs: ["ev_xd:m_xd"],
        },
      ],
    },
    {
      topic: "潜水装备租赁",
      category: "rental",
      targetRef: { kind: "visit", id: "visit_xidao" },
      sourceMentionRefs: [],
      options: [
        {
          label: "面镜脚蹼",
          priceText: "80元/套",
          routeText: null,
          sceneText: null,
          bargain: null,
          noteText: null,
          sourceMentionRefs: ["ev_xd:fake"],
        },
        {
          label: "潜水服",
          priceText: "60元/套",
          routeText: null,
          sceneText: null,
          bargain: null,
          noteText: null,
          sourceMentionRefs: ["ev_xd:fake"],
        },
      ],
    },
  ],
});

/** 去重场景：同主题（西岛环岛交通）+ 新选项双人自行车 + 已有选项电动车 */
const STUB_MERGE_JSON = JSON.stringify({
  operations: [],
  snippets: [],
  optionGroups: [
    {
      topic: "西岛环岛交通",
      category: "transport",
      targetRef: { kind: "visit", id: "visit_xidao" },
      sourceMentionRefs: ["ev_xd:m_xd"],
      options: [
        {
          label: "双人自行车",
          priceText: "60元/小时",
          routeText: null,
          sceneText: null,
          bargain: null,
          noteText: null,
          sourceMentionRefs: ["ev_xd:m_xd"],
        },
        {
          label: "电动车",
          priceText: "30元/小时",
          routeText: null,
          sceneText: null,
          bargain: null,
          noteText: null,
          sourceMentionRefs: ["ev_xd:m_xd"],
        },
      ],
    },
  ],
});

/** 历史兼容：旧形状草案（无 optionGroups 键），仅 snippets */
const STUB_LEGACY_JSON = JSON.stringify({
  operations: [],
  snippets: [
    {
      text: "西岛环岛交通建议坐观光车省力",
      claimKind: "tip",
      targetRef: { kind: "visit", id: "visit_xidao" },
      sourceMentionRefs: ["ev_xd:m_xd"],
    },
  ],
});

// ===== main =====

async function main(): Promise<void> {
  try {
    await runScenarios();
    console.log("\n[verify] Task #190（实用参考选项组）全部通过 ✓");
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
  await setupXidaoFixture(trip.tripId);
  const tripId = trip.tripId;

  // ---------- 场景 1：生成链路（prompt 契约 + 解析清洗 + 草案持久化） ----------
  {
    armPlanner(STUB_OPTION_GROUPS_JSON);
    const res = await requestJson(`/trips/${tripId}/draft`, "POST", { scope: { kind: "trip" } });
    assert.equal(res.status, 200, `生成应 200（实际 ${res.status}：${JSON.stringify(res.body)}）`);

    const prompt = capturedPrompts[0] ?? "";
    // Task #270：本夹具仅 3 条提及（<5），但素材本身含「三轮车 / 电动车 / 观光车 + 三个价格」
    // 的可比较信号 → 内容感知解锁，注入完整第七节（不再是一刀切降级短声明）
    assert.ok(
      prompt.includes("七、optionGroups（实用参考选项组，Task #190）"),
      "Task #270：素材含可比较选项信号时应注入完整第七节契约",
    );
    assert.ok(
      prompt.includes("同一主题下至少 2 个可比较的选项"),
      "Task #270：完整契约的成组硬条件应在 prompt 中",
    );
    assert.ok(
      !prompt.includes("七、optionGroups：本轮不适用，输出空数组 []"),
      "Task #270：信号命中时不得再输出降级短声明",
    );
    assert.ok(prompt.includes("禁止编造"), "prompt 应含引用禁编造规则");
    assert.ok(
      prompt.includes("三轮车50元一圈可以砍价"),
      "prompt 素材应含 golden 原文（交通提及）",
    );
    assert.ok(prompt.includes("ev_xd:m_xd"), "prompt 素材应含可复制的引用 ref");

    // 解析层清洗：单选组（日落观赏点）与编造引用组（潜水租赁）丢弃，剩 3 组
    const optionGroups = res.body.optionGroups as Record<string, unknown>[];
    assert.equal(optionGroups.length, 3, "解析后应剩 3 组（单选不成组 / 编造引用组丢弃）");
    assert.deepEqual(
      optionGroups.map((group) => group.topic),
      ["西岛环岛交通", "渔村食堂套餐", "牛王岛船票"],
      "保留组应按输入顺序（golden 交通 / 非交通餐饮 / 牛王岛）",
    );
    const transport = optionGroups[0];
    assert.equal(transport.category, "transport");
    const transportOptions = transport.options as Record<string, unknown>[];
    assert.equal(transportOptions.length, 3, "交通组应含 3 个选项");
    assert.deepEqual(
      transportOptions.map((option) => option.label),
      ["三轮车", "电动车", "观光车"],
      "golden 三选项（三轮车/电动车/观光车）",
    );
    assert.equal(transportOptions[0].priceText, "50元/圈", "priceText 原样保留措辞与单位");
    assert.equal(transportOptions[0].bargain, true, "原文明说可砍价 → bargain=true");
    assert.equal(transportOptions[1].bargain, null, "原文未提 → bargain=null（不臆测）");
    assert.equal(transportOptions[1].sceneText, null, "原文未提 → sceneText=null（不臆测）");
    const diveGroup = optionGroups.find((group) => group.topic === "潜水装备租赁");
    assert.equal(diveGroup, undefined, "引用全编造的组应在解析层丢弃");

    // 草案持久化：output.optionGroups 落盘
    const saved = await loadTrip(tripId);
    const draft = saved.pendingGuideDraft;
    assert.ok(draft !== undefined && draft.output !== undefined, "草案与 output 应持久化");
    const persistedGroups = draft.output.optionGroups;
    assert.ok(Array.isArray(persistedGroups) && persistedGroups.length === 3, "output.optionGroups 应随草案持久化");
    pass("1. 生成：内容感知解锁注入完整第七节 / 单选不成组 / 编造引用丢弃 / golden+非交通落盘草案");
  }

  // ---------- 场景 2：应用链路（归属 + stop→父 Visit 归一 + 无关组拒挂） ----------
  {
    const applyRes = await requestJson(`/trips/${tripId}/draft/apply`, "POST");
    assert.equal(applyRes.status, 200, `应用应 200（实际 ${JSON.stringify(applyRes.body)}）`);
    assert.equal(applyRes.body.attachedOptionGroupCount, 2, "应恰好挂载 2 组（牛王岛拒挂）");
    assert.ok(
      String(applyRes.body.message).includes("2 组实用参考"),
      `文案应含「2 组实用参考」（实际：${applyRes.body.message}）`,
    );

    const saved = await loadTrip(tripId);
    const visit = saved.visits["visit_xidao"];
    assert.ok(visit !== undefined);
    const groups = visit.optionGroups ?? [];
    assert.equal(groups.length, 2, "visit_xidao 应挂 2 组（含 stop 归一的渔村组）");
    assert.deepEqual(
      groups.map((group) => group.topic),
      ["西岛环岛交通", "渔村食堂套餐"],
      "stop targetRef 应归一到父 Visit 挂载",
    );

    const transport = groups[0];
    assert.equal(transport.category, "transport");
    assert.ok(transport.groupId.startsWith("gog_"), "groupId 前缀");
    assert.equal(transport.collectedAt !== "" , true, "collectedAt 应为应用落盘时间");
    const labels = transport.options.map((option) => option.label);
    assert.deepEqual(labels, ["三轮车", "电动车", "观光车"]);
    assert.deepEqual(transport.options[0].sourceMentionRefs, ["ev_xd:m_xd"], "选项证据引用应落盘");
    assert.deepEqual(transport.sourceMentionRefs, ["ev_xd:m_xd"], "组级证据引用应落盘");

    const dining = groups[1];
    assert.equal(dining.category, "dining", "非交通分类（餐饮）应原样保留");
    assert.equal(dining.options.length, 2);

    // 牛王岛组不得挂到任何实体（强证据不足）
    for (const entity of Object.values(saved.visits)) {
      const attached = (entity.optionGroups ?? []).some((group) => group.topic === "牛王岛船票");
      assert.equal(attached, false, `牛王岛组不得挂到 ${entity.visitId}`);
    }
    assert.equal(
      Object.values(saved.stops).some((stop) => "optionGroups" in stop),
      false,
      "Stop 不承载选项组（归一语义：统一落 Visit）",
    );
    assert.equal(saved.pendingGuideDraft, undefined, "草案应一次性消费清除");
    pass("2. 应用：归属精确（牛王岛拒挂）/ stop→父 Visit 归一 / 字段无臆测落盘 / 文案计数");
  }

  // ---------- 场景 3：去重合并（同主题新选项并入，不新增组） ----------
  {
    armPlanner(STUB_MERGE_JSON);
    const genRes = await requestJson(`/trips/${tripId}/draft`, "POST", { scope: { kind: "trip" } });
    assert.equal(genRes.status, 200);
    const applyRes = await requestJson(`/trips/${tripId}/draft/apply`, "POST");
    assert.equal(applyRes.status, 200);
    assert.equal(applyRes.body.attachedOptionGroupCount, 0, "同主题组重复 → 新增组数 0");
    assert.ok(
      !String(applyRes.body.message).includes("组实用参考"),
      "0 组新增时文案不得声称实用参考",
    );

    const saved = await loadTrip(tripId);
    const groups = saved.visits["visit_xidao"].optionGroups ?? [];
    assert.equal(groups.length, 2, "组数不变（去重合并）");
    const transport = groups.find((group) => group.topic === "西岛环岛交通");
    assert.ok(transport !== undefined);
    assert.deepEqual(
      transport.options.map((option) => option.label),
      ["三轮车", "电动车", "观光车", "双人自行车"],
      "新选项「双人自行车」并入；已有「电动车」去重跳过",
    );
    assert.equal(
      transport.options.length,
      4,
      "合并后交通组 4 选项",
    );
    pass("3. 去重：同主题新选项并入（不新增组）/ 已有选项 label 去重 / 计数与文案不虚报");
  }

  // ---------- 场景 4：历史兼容（旧草案无 optionGroups 键零感知） ----------
  {
    armPlanner(STUB_LEGACY_JSON);
    const genRes = await requestJson(`/trips/${tripId}/draft`, "POST", { scope: { kind: "trip" } });
    assert.equal(genRes.status, 200);
    const saved = await loadTrip(tripId);
    const draft = saved.pendingGuideDraft;
    assert.ok(draft !== undefined && draft.output !== undefined, "草案应持久化");
    assert.equal(
      "optionGroups" in draft.output,
      false,
      "空选项组时草案 output 不写 optionGroups 键（旧消费方零感知）",
    );
    const applyRes = await requestJson(`/trips/${tripId}/draft/apply`, "POST");
    assert.equal(applyRes.status, 200);
    assert.equal(applyRes.body.attachedOptionGroupCount, 0, "旧形状草案应用 → 0 组");
    const after = await loadTrip(tripId);
    const visit = after.visits["visit_xidao"];
    assert.equal(
      visit.guideSnippets?.length ?? 0,
      1,
      "snippet 链路不受影响（既有能力回归）",
    );
    assert.equal(
      (visit.optionGroups ?? []).length,
      2,
      "既有选项组数据不被旧草案清除（合并语义，非覆盖）",
    );
    pass("4. 历史兼容：无 optionGroups 键的旧草案生成与应用零异常 / snippet 与既有组不受影响");
  }
}

void main();
