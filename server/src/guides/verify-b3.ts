/**
 * Task #97（攻略包 B3：多篇攻略合并与按上下文排版）验证（全程离线）。
 *
 * setGuidePlannerDeps 桩注入 callPlanner，全程不触网、不调用真实百炼：
 *   1. merge 单元：三来源合并 → providerId 去重（p:）/ 归一化名称兜底聚合（n:，
 *      含「一条对齐 + 一条未对齐」同地点并入）/ 无名称独立成条（u:）/
 *      多来源证据并列保留 / sourceSnapshots 与 mentionIds/mentionRefs 快照；
 *   2. HTTP 错误矩阵：scope 缺失 / dayIndex 越界 / visitId 不存在 / tripId 不存在 /
 *      无可用来源（GUIDE_NO_SOURCES）+ 生成接口空形状契约；
 *   3. 生成链路：scope=trip 成功生成（响应契约全字段 / pendingGuideDraft 持久化 /
 *      baseTripVersion = 保存后版本且 freshness fresh）/ prompt 内容断言
 *      （攻略素材原文 / 来源标题 / 用户补充句）/ scope=day 与 attraction 的指令块；
 *   4. 补充句顺手保存：draft body note 写入 trip.guideDraftNote 且进入草案快照；
 *   5. 应用链路：非敏感操作直接应用 + snippets 按 targetRef 挂载 Stop + 草案一次性
 *      消费（重复 apply → DRAFT_NOT_FOUND）；
 *   6. 版本保护：trip.version 变化 / sourceVersion 变化 / 补充句变化 → 全部
 *      DRAFT_STALE 拒绝（附录 B §2.4，提示重新生成）；
 *   7. 敏感分流：remove 转 needsProposal（ProposalCard 通道），非敏感部分照常应用；
 *   8. 护栏：引用不存在实体的操作被丢弃（applied=0 / rejected 非空）；
 *   9. snippet 清洗：编造 mentionRef / 非法 targetRef / 空引用的条目被过滤，
 *      仅可溯源提示挂载（attachedSnippetCount 精确）；
 *  10. 解析健壮性：两次垃圾输出 → AI_PARSE_FAILED；首败重试成功 → attempts=2。
 *
 * Task #105 安全与版本保护回归（16/18 断言自 Task #218 起随行为更新）：
 *  16. pending 操作引用被护栏前预处理剥离（Task #218），零应用零拒绝且不触碰
 *      pending 状态；零操作草案也从持久层消失（删除必须落盘）；
 *  17. AI 不得代替用户做 pending 归类：护栏 G3 + 执行器双层拒绝，用户明确归类可执行
 *      且只有用户通道写 userAdjusted / decidedBy=user；
 *  18. 草案中含 AI pending 归类：该条被护栏前剥离（Task #218），其余合法操作照常
 *      应用，pending 状态不变；
 *  19. 生成期间 Trip.version 变化 → 不保存草案，返回 DRAFT_STALE（旧输出不绑定最新版本）。
 *
 * Task #110 prompt 瘦身回归：
 *  20. 大样本下断言：pending 整段不出现在 planner prompt / 无攻略关联候选被裁剪
 *      （判据只基于真实字段 Item.sourceEvidenceRefs 与 Visit.sourceMentionRefs）/
 *      超长 quote 截断到 ≤80 Unicode 字符（含省略号）/ 非空 quote 不重发 modelSummary、
 *      空 quote 用 modelSummary 兜底 / operations ≤15 条规则；并以同 trip 的
 *      「旧版等价 prompt」（全量 facts + 旧素材格式）为对照断言总字符显著下降并打印减少比例。
 *
 * Task #123 日期指令与强证据归类回归（server 草案与抽取接线）：
 *  21. 补充句日期指令纯函数解析：DAY3 / Day 3 / 第3天 / 第 三 天 / 全角 / 中文数字 /
 *      「把 X 放到第 N 天」语序 / large_attraction 优先匹配；「DAY安排后海」缺数字 →
 *      GUIDE_DAY_NUMBER_REQUIRED；Day9 超范围 → GUIDE_DAY_INDEX_OUT_OF_RANGE；
 *      无日期句返回空（补充句仍作软建议）。
 *  22. note 数字端到端不丢：PUT /draft-note 与 POST /draft body note 逐字落盘
 *      （缺数字字符串保存后仍缺——磁盘值来自提交时已缺，server 不吞字符）；
 *      解析失败不调 AI、不落草案、400 用户语言文案。
 *  23. DAY3 完整生成链路：指令块进 prompt（声明不可自行改天）；模型错误排 Day1 被服务端
 *      后校验移除并补排 Day3；编造引用的 classify 不下发；Day3 已有普通安排列为告知冲突
 *      （生成阶段不覆盖）；apply 后补排生效、requirement 收敛 met。
 *  24. 「第 3 天」空格变体端到端；已在指定天的主体不重复补排。
 *  25. 锁定/已购主体冲突契约：subject_locked / subject_bought（纯函数断言）；不带
 *      selectedConflictIds apply → 补排 move 被 G3 拒 + unmet + 未选冲突摘要（不笼统成功）；
 *      带 id apply → user_confirmed 执行 + met + appliedConflictIds 回传。
 *  26. 强证据父子归类（后海夹具）：relationEvidence 双侧可追溯 → classify 前置 + 服务端
 *      补排 parent Day3 + apply 后 Stop.classifiedFromVisitRef 落地、原 Visit 删除。
 *  27. 弱证据不归类：仅目标单侧提及（双侧追溯不满足）→ classify 不下发、原 ordinary Visit
 *      保留。锁定/已购护栏与 pending 禁令回归由场景 11/16/17/18 继续覆盖。
 *
 * 运行：npx tsx server/src/guides/verify-b3.ts
 * 临时行程（server/data）在脚本末尾全部清理，不影响用户既有数据。
 */

import "../env.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type {
  GuideDraftDayDirective,
  GuideSource,
  Item,
  Operation,
  PendingGuideDraft,
  SourceEvidence,
  Stop,
  Trip,
  Visit,
} from "@goplay/shared";
import {
  applyOps,
  checkPendingGuideDraftFreshness,
  createEmptyGuideImageProgress,
  validateOperation,
} from "@goplay/shared";
import { createFixtureSanyaTrip, tripStore } from "../persistence/store.js";
import { AiError } from "../ai/errors.js";
import { buildTripFacts } from "../ai/prompt.js";
import { enforceDraftDirectives, parseDraftDirectives } from "./directives.js";
import { mergeGuideMentions, type GuideMergeResult } from "./merge.js";
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
/** 单次桩调用期间的并发钩子（Task #105：模拟生成期间用户修改行程，触发版本保护） */
let duringPlannerCall: (() => Promise<void>) | null = null;

const STUB_DRAFT_JSON = JSON.stringify({
  operations: [
    { op: "setDuration", subjectRef: { kind: "stop", id: "stop_bridge" }, minutes: 50, reason: "情人桥铁索桥慢行，多留10分钟" },
  ],
  snippets: [
    {
      text: "情人桥早上8点前上去人最少",
      claimKind: "tip",
      targetRef: { kind: "stop", id: "stop_bridge" },
      sourceMentionRefs: ["ev_shot_2:n1"],
    },
  ],
});

const GARBAGE_TEXT = "这是一段与 JSON 无关的垃圾输出";

function armPlanner(...responses: string[]): void {
  stubResponses = [...responses];
  capturedPrompts.length = 0;
}

setGuidePlannerDeps({
  callPlanner: async (prompt: string) => {
    capturedPrompts.push(prompt);
    if (duringPlannerCall !== null) {
      const hook = duringPlannerCall;
      duringPlannerCall = null;
      await hook();
    }
    const next = stubResponses.shift();
    if (next === undefined) throw new Error("桩响应已耗尽（测试准备失误）");
    return next;
  },
});

// ===== 夹具：三来源 + 两条新证据（复用三亚夹具的既有实体与 ev_note_1） =====

function mkMention(
  mentionId: string,
  text: string,
  quoteText: string,
  extractedName: string | null,
  claimKind: NonNullable<SourceEvidence["mentions"][number]["claimKind"]>,
  targetScope: NonNullable<SourceEvidence["mentions"][number]["targetScope"]>,
  /** Task #123：从属关系原文依据（「位于 / 里面 / 附近」等）；null = 无关系声明 */
  relationEvidence: string | null = null,
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
    relationEvidence,
  };
}

function mkSource(
  sourceId: string,
  title: string,
  inputKind: GuideSource["inputKind"],
  evidenceRefs: string[],
  mentionRefs: string[],
  importedAt: string,
): GuideSource {
  return {
    sourceId,
    sourceVersion: 1,
    inputKind,
    title,
    active: true,
    status: "ready",
    evidenceRefs,
    mentionRefs,
    imageProgress: createEmptyGuideImageProgress(),
    importedAt,
    updatedAt: importedAt,
  };
}

/** 时刻常量：importedAt 决定合并顺序（A → B → C） */
const T_A = "2026-10-19T08:00:00.000Z";
const T_B = "2026-10-19T09:00:00.000Z";
const T_C = "2026-10-19T10:00:00.000Z";
const T_H = "2026-10-19T12:00:00.000Z";

/**
 * Task #110 规模对照：复刻瘦身前的素材序列化（原文不截断、modelSummary 恒发）。
 * 仅用于 verify 中量化 prompt 减少比例，不参与业务链路（新实现见 planner.formatMergeMaterials）。
 */
function buildLegacyMaterialsForCompare(trip: Trip, merge: GuideMergeResult): string[] {
  const lines: string[] = [];
  for (const place of merge.places) {
    const aligned =
      place.entityRef !== null ? `对齐 ${place.entityRef.kind}=${place.entityRef.id}` : "未对齐行程实体";
    const provider = place.providerId !== null ? `，providerId=${place.providerId}` : "";
    lines.push(`▸ 地点：${place.displayName}（${aligned}${provider}）`);
    for (const merged of place.mentions) {
      const source = trip.guideSources?.[merged.sourceId];
      const title =
        typeof source?.title === "string" && source.title.trim() !== "" ? source.title : "无标题来源";
      const mention = merged.mention;
      const summary =
        typeof mention.modelSummary === "string" && mention.modelSummary.trim() !== ""
          ? ` | 摘要=${JSON.stringify(mention.modelSummary)}`
          : "";
      const hint = mention.locationHint !== null ? ` | 提示=${JSON.stringify(mention.locationHint)}` : "";
      lines.push(
        `    - ref=${merged.ref} | 类型=${mention.claimKind ?? "unknown"} | 范围=${mention.targetScope ?? "unknown"} | 原文=${JSON.stringify(mention.quoteText)}${summary}${hint}（来源：${title}）`,
      );
    }
  }
  return lines;
}

/**
 * 在标准三亚夹具上补充 B3 素材：
 * - 挂载对齐（模拟 B2 装配产物）：visit_wzz ← m1；stop_bridge ← m2 + n1；
 * - 新证据 ev_shot_2（来源B：截图，3 提及）；ev_note_3（来源C：正文，2 提及）；
 * - 三来源全部 ready + active。
 */
async function setupGuideSources(tripId: string): Promise<void> {
  const trip = await loadTrip(tripId);
  trip.visits.visit_wzz.sourceMentionRefs = ["ev_note_1:m1"];
  trip.stops.stop_bridge.sourceMentionRefs = ["ev_note_1:m2", "ev_shot_2:n1"];

  trip.evidences["ev_shot_2"] = {
    evidenceId: "ev_shot_2",
    kind: "screenshot",
    noteIndex: null,
    assetRef: null,
    sourceUrl: null,
    ocrText: "蜈支洲岛攻略：情人桥一定要早上8点前上去，人最少；下午两点后旅行团走了人也少；后海村夜市晚上7点后热闹",
    mentions: [
      mkMention("n1", "情人桥", "情人桥一定要早上8点前上去，人最少", "情人桥", "tip", "activity"),
      mkMention("n2", "蜈支洲岛", "下午两点后旅行团走了人也少", "蜈支洲岛", "tip", "time_window"),
      mkMention("n3", "后海村", "后海村夜市晚上7点后热闹", "后海村", "experience", "activity"),
    ],
  };
  trip.evidences["ev_note_3"] = {
    evidenceId: "ev_note_3",
    kind: "note_text",
    noteIndex: 3,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions: [
      mkMention("c1", "后海村", "后海村吃海鲜推荐林姐香味，比第一市场实惠", "后海村", "comparison", "place"),
      mkMention("c2", "风险提示", "码头旁边那家摊位海鲜可能不新鲜，谨慎", null, "risk", "provider"),
    ],
  };

  const sources = trip.guideSources ?? {};
  sources["src_aaaa"] = mkSource(
    "src_aaaa",
    "小岛两天一夜攻略（A）",
    "text",
    ["ev_note_1"],
    ["ev_note_1:m1", "ev_note_1:m2", "ev_note_1:m3", "ev_note_1:m4"],
    T_A,
  );
  sources["src_bbbb"] = mkSource(
    "src_bbbb",
    "蜈支洲岛避雷帖（B）",
    "images",
    ["ev_shot_2"],
    ["ev_shot_2:n1", "ev_shot_2:n2", "ev_shot_2:n3"],
    T_B,
  );
  sources["src_cccc"] = mkSource(
    "src_cccc",
    "后海村吃喝指南（C）",
    "text",
    ["ev_note_3"],
    ["ev_note_3:c1", "ev_note_3:c2"],
    T_C,
  );
  trip.guideSources = sources;
  trip.guideDraftNote = "带老人出游，节奏放慢";
  await tripStore.save(trip);
}

/**
 * Task #123 后海夹具（模仿真实 trip d0174797 结构的隔离副本，不改用户数据）：
 * - 三亚后海村 = large_attraction Visit（Day1）；后海海滩 / 三和风味馆 / 丹姐清补凉 =
 *   三个独立 ordinary Visit（同在 Day1）——真实问题：攻略明示从属但行程互不挂靠；
 * - 证据 ev_note_9：m2 = 后海村本体提及（目标侧）；m3/m4/m5 = 子项提及且 relationEvidence
 *   原文明示「位于 / 里面 / 附近」从属关系（来源侧）；
 * - 子项 Item.sourceEvidenceRefs 留空，仅 visit.sourceMentionRefs 精确到提及粒度，
 *   保证「仅目标单侧提及」可被任务 122 双侧追溯门槛判为弱证据（不因主数据级证据误判）。
 */
async function setupHouhaiFixture(tripId: string): Promise<void> {
  const trip = await loadTrip(tripId);
  const customItem = (itemId: string, name: string, suggestMinutes: number | null): Item => ({
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
  });
  trip.itemRegistry["item_houhai"] = {
    ...customItem("item_houhai", "三亚后海村", null),
    sourceEvidenceRefs: ["ev_note_9"],
  };
  trip.itemRegistry["item_beach_hh"] = customItem("item_beach_hh", "后海海滩", 60);
  trip.itemRegistry["item_sanhewfg"] = customItem("item_sanhewfg", "三和风味馆", 60);
  trip.itemRegistry["item_danjie"] = customItem("item_danjie", "丹姐清补凉", 30);

  const mkHouhaiVisit = (
    visitId: string,
    pointRef: string,
    kind: Visit["kind"],
    order: number,
    sourceMentionRefs: string[],
  ): Visit => ({
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
    sourceMentionRefs,
    purchaseState: "unknown",
    locked: false,
    userAdjusted: false,
    removedFrom: null,
    removedAt: null,
  });
  trip.visits["visit_houhai"] = mkHouhaiVisit("visit_houhai", "item_houhai", "large_attraction", 0, ["ev_note_9:m2"]);
  trip.visits["visit_beach_hh"] = mkHouhaiVisit("visit_beach_hh", "item_beach_hh", "ordinary", 1, ["ev_note_9:m3"]);
  trip.visits["visit_sanhewfg"] = mkHouhaiVisit("visit_sanhewfg", "item_sanhewfg", "ordinary", 2, ["ev_note_9:m4"]);
  trip.visits["visit_danjie"] = mkHouhaiVisit("visit_danjie", "item_danjie", "ordinary", 3, ["ev_note_9:m5"]);
  const day1 = trip.days["day_1"];
  assert.ok(day1 !== undefined, "前提：fixture 应有 day_1");
  day1.scheduleVisitRefs = ["visit_houhai", "visit_beach_hh", "visit_sanhewfg", "visit_danjie"];

  trip.evidences["ev_note_9"] = {
    evidenceId: "ev_note_9",
    kind: "note_text",
    noteIndex: 9,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions: [
      mkMention("m2", "三亚后海村", "后海村可以冲浪，晚上夜市热闹", "三亚后海村", "experience", "place", null),
      mkMention(
        "m3",
        "后海海滩",
        "后海海滩位于后海村内，步行五分钟就到",
        "后海海滩",
        "experience",
        "place",
        "位于后海村内",
      ),
      mkMention(
        "m4",
        "三和风味馆",
        "三和风味馆在后海村里面，海鲜加工实惠",
        "三和风味馆",
        "tip",
        "place",
        "在后海村里面",
      ),
      mkMention("m5", "丹姐清补凉", "丹姐清补凉就在后海村附近巷口", "丹姐清补凉", "tip", "place", "就在后海村附近"),
    ],
  };
  trip.guideSources = {
    src_houhai: mkSource(
      "src_houhai",
      "后海村深度攻略（H）",
      "text",
      ["ev_note_9"],
      ["ev_note_9:m2", "ev_note_9:m3", "ev_note_9:m4", "ev_note_9:m5"],
      T_H,
    ),
  };
  trip.guideDraftNote = "";
  await tripStore.save(trip);
}

// ===== main =====

async function main(): Promise<void> {
  try {
    await runScenarios();
    console.log("\n[verify] Task #97（B3）全部通过 ✓");
  } finally {
    duringPlannerCall = null;
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
  // ---------- 场景 1：merge 单元（三来源合并 / 去重 / 并列保留） ----------
  {
    const trip = await createFixtureSanyaTrip();
    createdTripIds.push(trip.tripId);
    await setupGuideSources(trip.tripId);
    const reloaded = await loadTrip(trip.tripId);
    const merge = mergeGuideMentions(reloaded);

    assert.equal(merge.mentions.length, 9, "合并提及总数应为 9（m1-m4 + n1-n3 + c1-c2）");
    assert.equal(merge.sourceSnapshots.length, 3, "可用来源快照应为 3");
    assert.deepEqual(
      merge.sourceSnapshots.map((entry) => entry.sourceId),
      ["src_aaaa", "src_bbbb", "src_cccc"],
      "来源快照应按 importedAt 排序",
    );
    assert.equal(merge.mentionIds.length, 9, "mentionIds 应去重且完整");
    assert.equal(merge.mentionRefs.length, 9, "mentionRefs 应与提及一一对应");

    const placeKeys = merge.places.map((place) => place.key);
    assert.deepEqual(
      placeKeys,
      ["p:99", "p:14290139", "p:14937691", "p:163572", "n:后海村", "u:c2"],
      "地点 key 应为 providerId 优先（p:）+ 名称兜底（n:）+ 无名称独立（u:）",
    );

    const wzz = merge.places.find((place) => place.key === "p:99");
    assert.ok(wzz !== undefined, "蜈支洲岛应聚合为 p:99");
    assert.equal(wzz.entityRef?.kind, "visit");
    assert.equal(wzz.entityRef?.id, "visit_wzz");
    assert.deepEqual(
      wzz.mentions.map((entry) => entry.ref),
      ["ev_note_1:m1", "ev_shot_2:n2"],
      "对齐提及（m1）与未对齐同名提及（n2）应并入同一地点",
    );

    const bridge = merge.places.find((place) => place.key === "p:14290139");
    assert.ok(bridge !== undefined, "情人桥应聚合为 p:14290139（两来源都对齐 stop_bridge）");
    assert.deepEqual(
      bridge.mentions.map((entry) => entry.ref),
      ["ev_note_1:m2", "ev_shot_2:n1"],
      "情人桥应保留两来源证据并列",
    );

    const houhai = merge.places.find((place) => place.key === "n:后海村");
    assert.ok(houhai !== undefined, "后海村应按归一化名称跨来源聚合");
    assert.equal(houhai.entityRef, null, "后海村未对齐实体");
    assert.deepEqual(
      houhai.mentions.map((entry) => entry.sourceId),
      ["src_bbbb", "src_cccc"],
      "后海村应保留 B/C 两来源证据",
    );

    const orphan = merge.places.find((place) => place.key === "u:c2");
    assert.ok(orphan !== undefined, "无 extractedName 的风险提及应独立成条（u:）");
    assert.equal(orphan.mentions[0]?.mention.claimKind, "risk");
    assert.ok(orphan.displayName.length > 0, "u: 条目应有展示名兜底");

    pass("1. merge 单元：providerId 去重 / 名称兜底聚合 / u: 独立 / 多来源并列");
  }

  // ---------- 主体行程：三来源夹具 ----------
  const trip = await createFixtureSanyaTrip();
  createdTripIds.push(trip.tripId);
  const tripId = trip.tripId;
  await setupGuideSources(tripId);
  const baseVersionAfterSetup = (await loadTrip(tripId)).version;

  // ---------- 场景 2：HTTP 错误矩阵 + 空形状契约 ----------
  {
    // Task #176：scope 可缺省（缺省 = 服务端自动判定），不再 400 —— 改断言自动判定
    // 生成成功；非法形状（越界 dayIndex / ghost visitId / ghost trip）仍被拒绝。
    armPlanner(STUB_DRAFT_JSON);
    const autoScope = await requestJson(`/trips/${tripId}/draft`, "POST", {});
    assert.equal(
      autoScope.status,
      200,
      `scope 缺省应自动判定后正常生成（实际 ${autoScope.status}：${JSON.stringify(autoScope.body)}）`,
    );
    assert.equal(typeof autoScope.body.draftId, "string", "自动判定应正常产出草案");

    const badDay = await requestJson(`/trips/${tripId}/draft`, "POST", { scope: { kind: "day", dayIndex: 9 } });
    assert.equal(badDay.status, 400);
    assert.equal(badDay.body.code, "INVALID_REQUEST", "dayIndex 越界应拒绝");

    const badVisit = await requestJson(`/trips/${tripId}/draft`, "POST", {
      scope: { kind: "attraction", visitId: "visit_ghost" },
    });
    assert.equal(badVisit.status, 400);
    assert.equal(badVisit.body.code, "INVALID_REQUEST", "visitId 不存在应拒绝");

    const ghostTrip = await requestJson("/trips/ffffffff-ffff-4fff-8fff-ffffffffffff/draft", "POST", {
      scope: { kind: "trip" },
    });
    assert.equal(ghostTrip.status, 404);
    assert.equal(ghostTrip.body.code, "TRIP_NOT_FOUND");
    assert.equal(
      capturedPrompts.length,
      1,
      "仅 scope 缺省自动判定一次调用 planner；错误场景不应额外调用",
    );
    pass("2. 错误矩阵：scope 缺省自动判定（Task #176）/ 越界 / visitId 不存在 / TRIP_NOT_FOUND（不调 AI）");
  }

  // ---------- 场景 3：无可用来源 → GUIDE_NO_SOURCES ----------
  {
    const emptyTrip = await createFixtureSanyaTrip();
    createdTripIds.push(emptyTrip.tripId);
    const res = await requestJson(`/trips/${emptyTrip.tripId}/draft`, "POST", { scope: { kind: "trip" } });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "GUIDE_NO_SOURCES");
    pass("3. 无可用来源 → 409 GUIDE_NO_SOURCES");
  }

  // ---------- 场景 4：scope=trip 生成成功（契约 + 持久化 + prompt 内容） ----------
  {
    armPlanner(STUB_DRAFT_JSON);
    const res = await requestJson(`/trips/${tripId}/draft`, "POST", { scope: { kind: "trip" } });
    assert.equal(res.status, 200, `生成应 200（实际 ${res.status}：${JSON.stringify(res.body)}）`);
    assert.equal(typeof res.body.draftId, "string", "draftId 应为非空字符串");
    assert.equal(res.body.baseTripVersion, res.body.tripVersion, "baseTripVersion 应等于保存后版本");
    assert.equal(
      res.body.inputTripVersion,
      (res.body.baseTripVersion as number) - 1,
      "inputTripVersion 应为实际生成输入版本（草案落盘前 vN，落盘后 vN+1）",
    );
    assert.equal(res.body.sourceCount, 3);
    assert.equal(res.body.mentionCount, 9);
    assert.equal(res.body.placeCount, 6);
    assert.equal(res.body.attempts, 1);
    const operations = res.body.operations as unknown[];
    assert.equal(operations.length, 1, "桩返回 1 条操作");
    const snippets = res.body.snippets as Array<{ text: string; sourceMentionRefs: string[] }>;
    assert.equal(snippets.length, 1);
    assert.equal(snippets[0]?.text, "情人桥早上8点前上去人最少");

    // prompt 内容断言：素材原文 / 来源标题 / 补充句 / scope 指令 / 规则契约
    assert.equal(capturedPrompts.length, 1);
    const prompt = capturedPrompts[0] ?? "";
    assert.ok(prompt.includes("【攻略素材】"), "prompt 应包含攻略素材块");
    assert.ok(prompt.includes("带老人出游，节奏放慢"), "prompt 应包含行程补充句（沿用 trip.guideDraftNote）");
    assert.ok(prompt.includes("情人桥一定要早上8点前上去，人最少"), "prompt 应包含 mention 原文");
    assert.ok(prompt.includes("蜈支洲岛避雷帖（B）"), "prompt 应包含来源标题");
    assert.ok(prompt.includes("ref=ev_shot_2:n1"), "prompt 应包含可复制的 mention 引用");
    assert.ok(prompt.includes("全程优化"), "trip scope 应有全程指令");
    assert.ok(prompt.includes('禁止 {"kind":"allDays"}'), "prompt 应禁止 allDays");
    assert.ok(prompt.includes("snippets"), "prompt 应包含 snippets 契约");

    // 持久化断言：pendingGuideDraft + 版本语义（baseTripVersion = 保存后版本 → fresh）
    const saved = await loadTrip(tripId);
    const draft = saved.pendingGuideDraft as PendingGuideDraft | undefined;
    assert.ok(draft !== undefined, "pendingGuideDraft 应已保存");
    assert.equal(draft.baseTripVersion, saved.version, "baseTripVersion 应等于保存后 Trip.version");
    assert.equal(draft.inputTripVersion, saved.version - 1, "inputTripVersion 应快照生成输入时的版本");
    assert.equal(draft.scope.kind, "trip");
    assert.equal(draft.sourceSnapshots.length, 3);
    assert.equal(draft.mentionIds.length, 9);
    assert.ok(draft.output !== undefined, "output 应已保存");
    assert.equal(draft.output?.operations.length, 1);
    assert.equal(draft.note, "带老人出游，节奏放慢", "草案 note 应快照行程补充句");
    const freshness = checkPendingGuideDraftFreshness(draft, saved);
    assert.equal(freshness.fresh, true, `生成后草案应 fresh（原因：${freshness.details.join("；")}）`);
    pass("4. scope=trip 生成：响应契约 / pendingGuideDraft 持久化 / baseTripVersion=fresh / prompt 内容");
  }

  // ---------- 场景 5：scope=day / attraction 的指令块 ----------
  {
    armPlanner(STUB_DRAFT_JSON);
    await requestJson(`/trips/${tripId}/draft`, "POST", { scope: { kind: "day", dayIndex: 2 } });
    assert.ok(capturedPrompts[0]?.includes("单日优化"), "day scope 应输出单日指令");
    assert.ok(capturedPrompts[0]?.includes("Day 2（2026-11-09）"), "day scope 指令应带日期");

    armPlanner(STUB_DRAFT_JSON);
    await requestJson(`/trips/${tripId}/draft`, "POST", { scope: { kind: "attraction", visitId: "visit_wzz" } });
    assert.ok(capturedPrompts[0]?.includes("大景区内部补充"), "attraction scope 应输出内部补充指令");
    assert.ok(capturedPrompts[0]?.includes("visit_wzz"), "attraction 指令应带目标景区 id");
    pass("5. scope=day / attraction：只限制输出范围的指令块");
  }

  // ---------- 场景 6：note 顺手保存 ----------
  {
    armPlanner(STUB_DRAFT_JSON);
    const res = await requestJson(`/trips/${tripId}/draft`, "POST", {
      scope: { kind: "trip" },
      note: "雨天备选方案多一点",
    });
    assert.equal(res.status, 200);
    const saved = await loadTrip(tripId);
    assert.equal(saved.guideDraftNote, "雨天备选方案多一点", "note 应写入 trip.guideDraftNote");
    assert.equal(saved.pendingGuideDraft?.note, "雨天备选方案多一点", "草案 note 快照应一致");
    assert.ok(capturedPrompts[0]?.includes("雨天备选方案多一点"), "补充句应进入 prompt");
    pass("6. 补充句顺手保存：写入行程 + 进入草案快照 + 进入 prompt");
  }

  // ---------- 场景 7：应用成功（非敏感直应用 + snippet 挂载 + 一次性消费） ----------
  {
    armPlanner(STUB_DRAFT_JSON);
    await requestJson(`/trips/${tripId}/draft`, "POST", { scope: { kind: "trip" } });
    const applyRes = await requestJson(`/trips/${tripId}/draft/apply`, "POST");
    assert.equal(applyRes.status, 200, `应用应 200（实际 ${JSON.stringify(applyRes.body)}）`);
    assert.equal(applyRes.body.type, "applied");
    const applied = applyRes.body.applied as unknown[];
    assert.equal(applied.length, 1, "setDuration 应直接应用");
    assert.equal((applyRes.body.needsProposal as unknown[]).length, 0);
    assert.equal(applyRes.body.attachedSnippetCount, 1, "1 条合法 snippet 应挂载");
    assert.ok(String(applyRes.body.message).includes("已按攻略草案更新"));

    const saved = await loadTrip(tripId);
    assert.equal(saved.stops.stop_bridge?.suggestMinutes, 50, "setDuration 应已生效");
    const snippetsOnStop = saved.stops.stop_bridge?.guideSnippets ?? [];
    assert.equal(snippetsOnStop.length, 1, "snippet 应挂载到 stop_bridge.guideSnippets");
    assert.equal(snippetsOnStop[0]?.text, "情人桥早上8点前上去人最少");
    assert.deepEqual(snippetsOnStop[0]?.sourceMentionRefs, ["ev_shot_2:n1"]);
    assert.equal(saved.pendingGuideDraft, undefined, "草案应一次性消费清除");
    assert.equal(saved.version, applyRes.body.tripVersion);

    const again = await requestJson(`/trips/${tripId}/draft/apply`, "POST");
    assert.equal(again.status, 404);
    assert.equal(again.body.code, "DRAFT_NOT_FOUND", "重复应用应报 DRAFT_NOT_FOUND");
    pass("7. 应用成功：op 生效 / snippet 挂载 Stop / 草案清除 / 重复应用 404");
  }

  // ---------- 场景 8：版本保护 —— trip.version 变化 ----------
  {
    armPlanner(STUB_DRAFT_JSON);
    await requestJson(`/trips/${tripId}/draft`, "POST", { scope: { kind: "trip" } });
    const touched = await loadTrip(tripId);
    touched.updatedAt = new Date().toISOString();
    await tripStore.save(touched); // version+1，模拟草案生成后的并发修改
    const applyRes = await requestJson(`/trips/${tripId}/draft/apply`, "POST");
    assert.equal(applyRes.status, 409);
    assert.equal(applyRes.body.code, "DRAFT_STALE", "行程版本变化应拒绝应用");
    assert.ok(String(applyRes.body.message).includes("重新生成"), "拒绝消息应提示重新生成");
    pass("8. 版本保护：trip.version 变化 → DRAFT_STALE");
  }

  // ---------- 场景 9：版本保护 —— sourceVersion 变化（图片异步完成场景） ----------
  {
    armPlanner(STUB_DRAFT_JSON);
    await requestJson(`/trips/${tripId}/draft`, "POST", { scope: { kind: "trip" } });
    const bumped = await loadTrip(tripId);
    const source = bumped.guideSources?.["src_bbbb"] as GuideSource;
    source.sourceVersion += 1; // 模拟来源处理完成 / 重试后 sourceVersion 递增
    await tripStore.save(bumped);
    const applyRes = await requestJson(`/trips/${tripId}/draft/apply`, "POST");
    assert.equal(applyRes.status, 409);
    assert.equal(applyRes.body.code, "DRAFT_STALE", "来源版本变化应使草案过期（发现新的攻略细节）");
    pass("9. 版本保护：sourceVersion 递增 → DRAFT_STALE（发现新的攻略细节场景）");
  }

  // ---------- 场景 10：版本保护 —— 补充句变化 ----------
  {
    armPlanner(STUB_DRAFT_JSON);
    await requestJson(`/trips/${tripId}/draft`, "POST", { scope: { kind: "trip" } });
    const noteRes = await requestJson(`/trips/${tripId}/draft-note`, "PUT", { note: "节奏再快一点" });
    assert.equal(noteRes.status, 200);
    const applyRes = await requestJson(`/trips/${tripId}/draft/apply`, "POST");
    assert.equal(applyRes.status, 409);
    assert.equal(applyRes.body.code, "DRAFT_STALE", "补充句变化应使草案过期（note_changed）");
    pass("10. 版本保护：补充句变化 → DRAFT_STALE");
  }

  // ---------- 场景 11：敏感分流（remove 转 ProposalCard 通道） ----------
  {
    armPlanner(
      JSON.stringify({
        operations: [
          {
            op: "remove",
            subjectRef: { kind: "visit", id: "visit_wzz" },
            fromContainerRef: { kind: "day", dayIndex: 2 },
            reason: "攻略吐槽排队久，建议移除",
          },
          { op: "setDuration", subjectRef: { kind: "stop", id: "stop_beach" }, minutes: 120, reason: "海滨浴场加时" },
        ],
        snippets: [],
      }),
    );
    await requestJson(`/trips/${tripId}/draft`, "POST", { scope: { kind: "trip" } });
    const applyRes = await requestJson(`/trips/${tripId}/draft/apply`, "POST");
    assert.equal(applyRes.status, 200);
    assert.equal(applyRes.body.type, "proposal", "含敏感操作时响应应为 proposal");
    const needsProposal = applyRes.body.needsProposal as Array<{ op: string }>;
    assert.equal(needsProposal.length, 1);
    assert.equal(needsProposal[0]?.op, "remove");
    assert.equal((applyRes.body.applied as unknown[]).length, 1, "非敏感 setDuration 应照常应用");
    const saved = await loadTrip(tripId);
    assert.ok(saved.visits.visit_wzz !== undefined, "敏感 remove 不得执行（行程保持完整）");
    assert.equal(saved.stops.stop_beach?.suggestMinutes, 120);
    assert.equal(saved.pendingGuideDraft, undefined, "草案仍应一次性消费（敏感项走确认通道）");
    pass("11. 敏感分流：remove 转 needsProposal / 非敏感照常应用 / 行程完整");
  }

  // ---------- 场景 12：护栏拒绝（引用不存在实体） ----------
  {
    armPlanner(
      JSON.stringify({
        operations: [
          {
            op: "move",
            subjectRef: { kind: "stop", id: "stop_ghost" },
            containerRef: { kind: "visit", id: "visit_wzz" },
            toOrder: 0,
            reason: "幽灵玩法前置",
          },
        ],
        snippets: [],
      }),
    );
    await requestJson(`/trips/${tripId}/draft`, "POST", { scope: { kind: "trip" } });
    const applyRes = await requestJson(`/trips/${tripId}/draft/apply`, "POST");
    assert.equal(applyRes.status, 200, "护栏拒绝不是 HTTP 错误（逐条 rejected）");
    assert.equal((applyRes.body.applied as unknown[]).length, 0, "幽灵操作不得应用");
    const rejected = applyRes.body.rejected as unknown[];
    assert.equal(rejected.length, 1, "护栏拒绝项应并入 rejected");
    pass("12. 护栏：引用不存在实体的操作被拒绝（applied=0 / rejected=1）");
  }

  // ---------- 场景 13：snippet 清洗（编造引用 / 非法 targetRef / 空引用） ----------
  {
    // Task #150：有效条目的 sourceMentionRefs 还须与目标实体强相关
    //（名称全等/整体包含/既有归属/父子，见 verify-task150.ts 专项）；
    // 本场景沿用「清洗」主题：有效条目引用各自实体的同名提及。
    armPlanner(
      JSON.stringify({
        operations: [],
        snippets: [
          {
            text: "有效提示：可溯源",
            claimKind: "tip",
            targetRef: { kind: "stop", id: "stop_rock" },
            sourceMentionRefs: ["ev_note_1:m4"], // 观日岩提及：名称整体包含于「蜈支洲岛旅游风景区-观日岩」
          },
          {
            text: "编造引用提示",
            claimKind: "tip",
            targetRef: { kind: "visit", id: "visit_wzz" },
            sourceMentionRefs: ["ev_ghost:m9"],
          },
          {
            text: "非法目标提示",
            claimKind: "tip",
            targetRef: { kind: "hotel", id: "hotel_x" },
            sourceMentionRefs: ["ev_shot_2:n1"],
          },
          {
            text: "空引用提示",
            claimKind: "tip",
            targetRef: { kind: "stop", id: "stop_bridge" },
            sourceMentionRefs: [],
          },
          {
            text: "超长提示".repeat(30),
            claimKind: "tip",
            targetRef: { kind: "stop", id: "stop_beach" },
            sourceMentionRefs: ["ev_note_1:m3"], // 海滨浴场提及：名称整体包含于「蜈支洲岛海滨浴场」
          },
        ],
      }),
    );
    await requestJson(`/trips/${tripId}/draft`, "POST", { scope: { kind: "trip" } });
    const applyRes = await requestJson(`/trips/${tripId}/draft/apply`, "POST");
    assert.equal(applyRes.status, 200);
    assert.equal(applyRes.body.attachedSnippetCount, 2, "仅有效与截断后的两条应挂载");
    const saved = await loadTrip(tripId);
    const beachSnippets = saved.stops.stop_beach?.guideSnippets ?? [];
    assert.equal(beachSnippets.length, 1);
    assert.ok((beachSnippets[0]?.text.length ?? 0) <= 40, "超长文本应截断到 40 字硬上限");
    assert.equal(saved.stops.stop_rock?.guideSnippets?.length, 1, "有效可溯源条目应挂载到 stop_rock");
    assert.equal(
      saved.stops.stop_bridge?.guideSnippets?.length,
      1,
      "编造 / 空引用条目不得挂载（stop_bridge 保持场景 7 的 1 条）",
    );
    pass("13. snippet 清洗：编造引用与非法 targetRef 被过滤 / 超长截断 40 字");
  }

  // ---------- 场景 14：解析失败两次 → AI_PARSE_FAILED ----------
  {
    armPlanner(GARBAGE_TEXT, GARBAGE_TEXT);
    const res = await requestJson(`/trips/${tripId}/draft`, "POST", { scope: { kind: "trip" } });
    assert.ok(res.status >= 400, "解析失败应返回错误状态");
    assert.equal(res.body.code, "AI_PARSE_FAILED");
    assert.equal(capturedPrompts.length, 2, "解析失败应重试一次（共两次调用）");
    pass("14. 解析失败：两次垃圾输出 → AI_PARSE_FAILED（重试一次）");
  }

  // ---------- 场景 15：首败重试成功 → attempts=2 ----------
  {
    armPlanner(GARBAGE_TEXT, STUB_DRAFT_JSON);
    const res = await requestJson(`/trips/${tripId}/draft`, "POST", { scope: { kind: "trip" } });
    assert.equal(res.status, 200, `重试应成功（实际 ${JSON.stringify(res.body)}）`);
    assert.equal(res.body.attempts, 2, "首次失败后重试应记 attempts=2");
    assert.equal((res.body.operations as unknown[]).length, 1);
    const saved = await loadTrip(tripId);
    assert.equal(checkPendingGuideDraftFreshness(saved.pendingGuideDraft as PendingGuideDraft, saved).fresh, true);
    pass("15. 首败重试：垃圾输出后重试成功（attempts=2）");
  }

  // ---------- 场景 16：pending stop 禁令 —— 违规引用护栏前剥离，不得触碰 pending 状态（Task #218） ----------
  {
    // planner 违规对 state=pending 的内部玩法生成 plan + setDuration：
    // Task #218 起在护栏前被 filterPendingStopAssignments 剥离（原本 100% 违规触发整批拒绝）
    armPlanner(
      JSON.stringify({
        operations: [
          {
            op: "plan",
            scopeRef: { kind: "day", dayIndex: 2 },
            assignments: [
              {
                subjectRef: { kind: "stop", id: "stop_snack" },
                containerRef: { kind: "visit", id: "visit_wzz" },
                order: 0,
              },
            ],
            reason: "攻略推荐小吃店",
          },
          { op: "setDuration", subjectRef: { kind: "stop", id: "stop_snack" }, minutes: 40, reason: "小吃停留" },
        ],
        snippets: [],
      }),
    );
    const genRes = await requestJson(`/trips/${tripId}/draft`, "POST", { scope: { kind: "trip" } });
    assert.equal(genRes.status, 200);
    assert.ok(capturedPrompts[0]?.includes("state=pending"), "planner 规则应包含 pending 内部玩法禁令");

    const applyRes = await requestJson(`/trips/${tripId}/draft/apply`, "POST");
    assert.equal(applyRes.status, 200, "预处理剥离不是 HTTP 错误");
    assert.equal((applyRes.body.applied as unknown[]).length, 0, "pending 内部玩法操作不得应用");
    // Task #218：违规引用在护栏前被剥离（不计入 rejected——不是「被裁决拒绝」而是
    // 「不该出现」），剩余合法操作集为空 → 零应用零拒绝，不触发 30% 阈值整批拒绝
    assert.equal(applyRes.body.rejectedCount, 0, "pending 引用已被预处理剥离，不进入护栏计数");
    assert.equal(applyRes.body.allRejected, false, "剥离后无可裁决违规，不得标记 allRejected");
    assert.equal(applyRes.body.rejectSummary, null, "无护栏拒绝时原因摘要应为 null");
    const message = String(applyRes.body.message);
    assert.ok(message.includes("草案无可应用的变更"), "剥离后零操作应如实报告无可应用变更");

    const saved = await loadTrip(tripId);
    assert.equal(saved.stops.stop_snack?.state, "pending", "pending 内部玩法状态不得被改动");
    assert.equal(saved.stops.stop_snack?.suggestMinutes, 30, "pending 内部玩法时长不得被改动");
    // Task #105：零操作应用时草案也必须从持久层消失（删除本身要落盘），否则同一草案可反复应用
    assert.equal(saved.pendingGuideDraft, undefined, "零操作应用后草案应从持久层消失");
    assert.equal(applyRes.body.tripVersion, saved.version, "应返回落盘后的 Trip.version");
    const repeat = await requestJson(`/trips/${tripId}/draft/apply`, "POST");
    assert.equal(repeat.status, 404, "零操作应用后重复应用应 404");
    assert.equal(repeat.body.code, "DRAFT_NOT_FOUND", "重复应用应报 DRAFT_NOT_FOUND");
    pass("16. pending stop 禁令（Task #218）：违规引用护栏前剥离 / 零应用零拒绝 / pending 状态不变 / 草案消费落盘");
  }

  // ---------- 场景 17：AI 不得代替用户做 pending 归类（护栏 + 执行器双层） ----------
  {
    const before = await loadTrip(tripId);
    assert.equal(before.stops.stop_snack?.state, "pending", "前提：stop_snack 仍为待定加入");
    const pendingTransfer: Operation = {
      op: "transfer",
      subjectRef: { kind: "stop", id: "stop_snack" },
      fromContainerRef: { kind: "pendingPool" },
      toContainerRef: { kind: "visit", id: "visit_wzz" },
      toOrder: null,
      reason: "攻略提到入口小吃店，直接归入蜈支洲岛",
    };

    // 护栏层：默认 actor=ai_proposed → G3 拒绝
    const guarded = validateOperation(pendingTransfer, before);
    assert.equal(guarded.valid, false, "AI 的 pending 归类应被护栏拒绝");
    assert.equal(guarded.guard, "G3");
    assert.match(guarded.reason ?? "", /归类/);
    // 用户通道放行
    assert.equal(validateOperation(pendingTransfer, before, "user_manual").valid, true);

    // 执行器层（绕过护栏直发）同样兜底拒绝，行程逐字段不变
    const byAi = applyOps(before, [pendingTransfer], { actor: "ai_proposed" });
    assert.equal(byAi.applied.length, 0, "执行器不得让 AI 归类 pending 玩法");
    assert.match(byAi.rejected[0]?.reason ?? "", /归类/);
    assert.equal(byAi.trip.stops.stop_snack?.state, "pending");
    assert.ok(byAi.trip.pendingStopRefs.includes("stop_snack"));
    assert.equal(byAi.trip.stops.stop_snack?.userAdjusted, false, "AI 不得写 userAdjusted");
    assert.equal(byAi.trip.relationshipSuggestions.stop_snack?.decidedBy, "system");

    // 用户明确归类可执行，且只有用户通道写 userAdjusted / decidedBy=user
    const byUser = applyOps(before, [pendingTransfer], { actor: "user_manual" });
    assert.equal(byUser.applied.length, 1, "用户明确归类应执行");
    const classified = byUser.trip.stops.stop_snack;
    assert.equal(classified?.state, "attached");
    assert.equal(classified?.visitRef, "visit_wzz");
    assert.equal(classified?.userAdjusted, true);
    assert.equal(byUser.trip.pendingStopRefs.includes("stop_snack"), false);
    assert.equal(byUser.trip.relationshipSuggestions.stop_snack?.decidedBy, "user");
    pass("17. AI pending 归类：护栏 G3 与执行器双层拒绝 / 用户明确归类可执行并写用户决定");
  }

  // ---------- 场景 18：草案中的 AI pending 归类被护栏前剥离，其余操作照常应用（Task #218） ----------
  {
    armPlanner(
      JSON.stringify({
        operations: [
          {
            op: "transfer",
            subjectRef: { kind: "stop", id: "stop_snack" },
            fromContainerRef: { kind: "pendingPool" },
            toContainerRef: { kind: "visit", id: "visit_wzz" },
            toOrder: null,
            reason: "攻略推荐小吃店，归入蜈支洲岛",
          },
          { op: "setDuration", subjectRef: { kind: "stop", id: "stop_bridge" }, minutes: 45, reason: "情人桥 45 分钟" },
          { op: "setDuration", subjectRef: { kind: "stop", id: "stop_beach" }, minutes: 100, reason: "海滨浴场 100 分钟" },
          { op: "setDuration", subjectRef: { kind: "stop", id: "stop_rock" }, minutes: 70, reason: "观日岩 70 分钟" },
        ],
        snippets: [],
      }),
    );
    const genRes = await requestJson(`/trips/${tripId}/draft`, "POST", { scope: { kind: "trip" } });
    assert.equal(genRes.status, 200);
    const applyRes = await requestJson(`/trips/${tripId}/draft/apply`, "POST");
    assert.equal(applyRes.status, 200);
    assert.equal((applyRes.body.applied as unknown[]).length, 3, "三条合法 setDuration 应照常应用");
    // Task #218：pending 归类在护栏前被剥离（原本 1/4 违规仅逐条拒绝；剥离后连
    // 违规统计都不再出现），合法操作零牵连
    assert.equal(applyRes.body.rejectedCount, 0, "pending 归类已被预处理剥离，不进入护栏计数");
    assert.equal(applyRes.body.allRejected, false, "不触发整批拒绝");
    assert.equal(applyRes.body.rejectSummary, null, "无护栏拒绝时原因摘要应为 null");

    const saved = await loadTrip(tripId);
    assert.equal(saved.stops.stop_snack?.state, "pending", "草案不得把 pending 玩法归入景区");
    assert.ok(saved.pendingStopRefs.includes("stop_snack"));
    assert.equal(saved.visits.visit_wzz?.childStopRefs.includes("stop_snack"), false);
    assert.equal(saved.stops.stop_snack?.userAdjusted, false, "AI 操作不得伪装成用户调整");
    assert.equal(saved.relationshipSuggestions.stop_snack?.decidedBy, "system", "decidedBy 仍为 system");
    assert.equal(saved.stops.stop_bridge?.suggestMinutes, 45);
    assert.equal(saved.stops.stop_beach?.suggestMinutes, 100);
    pass("18. 草案链路（Task #218）：AI pending 归类被护栏前剥离 / 其余操作照常应用 / pending 状态未变");
  }

  // ---------- 场景 19：生成期间行程版本变化 → DRAFT_STALE（旧输出不得绑定最新版本） ----------
  {
    const beforeVersion = (await loadTrip(tripId)).version;
    duringPlannerCall = async () => {
      const concurrent = await loadTrip(tripId);
      concurrent.guideDraftNote = "生成期间用户改了补充句";
      await tripStore.save(concurrent); // version+1：模拟百炼调用期间行程被并发修改
    };
    armPlanner(STUB_DRAFT_JSON);
    const res = await requestJson(`/trips/${tripId}/draft`, "POST", { scope: { kind: "trip" } });
    assert.equal(res.status, 409, `生成期间版本变化应 409（实际 ${JSON.stringify(res.body)}）`);
    assert.equal(res.body.code, "DRAFT_STALE");
    assert.match(String(res.body.message), /重新生成/, "应明确要求重新生成");
    assert.equal(res.body.draftId, null, "草案不得保存");

    const saved = await loadTrip(tripId);
    assert.equal(saved.version, beforeVersion + 1, "行程只应有并发修改那一次版本自增");
    assert.equal(saved.pendingGuideDraft, undefined, "旧输出不得被绑定为最新版本的基线");
    pass("19. 生成期版本变化：草案不保存 + 409 DRAFT_STALE（要求重新生成）");
  }

  // ---------- 场景 20：prompt 瘦身回归（Task #110）----------
  {
    const slimTrip = await createFixtureSanyaTrip();
    createdTripIds.push(slimTrip.tripId);
    await setupGuideSources(slimTrip.tripId);
    const prepared = await loadTrip(slimTrip.tripId);

    // a) 超长 quote（>80 Unicode 字符，含 emoji）+ 空 quote（仅 modelSummary 兜底）
    const longQuoteA =
      "清晨五点半就要到灯塔下面的礁石区占机位，太阳从海平面升起来的那几分钟光线最柔和，退潮之后礁石缝里有很多小螃蟹可以拍特写，带长焦镜头效果更好，风大注意给相机防沙，记得带够饮用水和防滑鞋🦀📷";
    const longQuoteB =
      "沿着椰林公路慢慢骑电动车，傍晚五点以后逆光最出片，路边小店的白切鸡配清补凉是本地人吃法，一辆车最多坐两个人，环岛一圈大概要三个小时，中途在栈道口看日落再返程正好，记得提前在驿站还车🌴🛵";
    assert.ok(
      [...longQuoteA].length > 80 && [...longQuoteB].length > 80,
      "前提：两条长 quote 均应超过 80 个 Unicode 字符",
    );
    prepared.evidences["ev_slim"] = {
      evidenceId: "ev_slim",
      kind: "note_text",
      noteIndex: 9,
      assetRef: null,
      sourceUrl: null,
      ocrText: null,
      mentions: [
        mkMention("s1", "灯塔礁石", longQuoteA, "灯塔礁石", "experience", "place"),
        mkMention("s2", "椰林公路", longQuoteB, "椰林公路", "experience", "place"),
        {
          mentionId: "s3",
          text: "后海村夜市",
          quoteText: "",
          bbox: null,
          extractedName: "后海村夜市",
          locationHint: null,
          modelSummary: "后海村夜市七点后最热闹，海鲜先问价再落座",
          claimKind: "tip",
          targetScope: "activity",
          firsthand: false,
        },
      ],
    };
    const slimSources = prepared.guideSources ?? {};
    slimSources["src_slim"] = mkSource(
      "src_slim",
      "机位与自驾补充（S）",
      "text",
      ["ev_slim"],
      ["ev_slim:s1", "ev_slim:s2", "ev_slim:s3"],
      "2026-10-19T11:00:00.000Z",
    );
    prepared.guideSources = slimSources;

    // b) 大量 pending stops（planner 不可操作）+ 无关联候选（应裁剪）与有关联候选（应保留）
    const snackTemplate: Stop | undefined = prepared.stops.stop_snack;
    assert.ok(snackTemplate !== undefined, "前提：fixture 应有 pending 样本 stop_snack");
    for (let index = 1; index <= 8; index += 1) {
      const stopId = `stop_slim_${index}`;
      const cloned: Stop = { ...snackTemplate, stopId, customName: `待定玩法样本${index}号超长名称占位描述` };
      prepared.stops[stopId] = cloned;
      prepared.pendingStopRefs.push(stopId);
    }
    const noGuideTemplate: Item | undefined = prepared.itemRegistry.item_daxiaodongtian;
    assert.ok(noGuideTemplate !== undefined, "前提：fixture 应有无攻略关联候选样本");
    for (let index = 1; index <= 5; index += 1) {
      const itemId = `item_noguide_${index}`;
      const cloned: Item = {
        ...noGuideTemplate,
        itemId,
        name: `无攻略关联候选${index}号超长名称占位`,
        sourceEvidenceRefs: [],
      };
      prepared.itemRegistry[itemId] = cloned;
      prepared.globalCandidateRefs.push({ kind: "point", id: itemId });
    }
    prepared.itemRegistry["item_slim_guide"] = {
      ...noGuideTemplate,
      itemId: "item_slim_guide",
      name: "有攻略关联候选",
      sourceEvidenceRefs: ["ev_note_1"],
    };
    prepared.globalCandidateRefs.push({ kind: "point", id: "item_slim_guide" });
    await tripStore.save(prepared);

    // c) 生成并逐项断言瘦身效果
    armPlanner(STUB_DRAFT_JSON);
    const genRes = await requestJson(`/trips/${slimTrip.tripId}/draft`, "POST", { scope: { kind: "trip" } });
    assert.equal(genRes.status, 200, `生成应 200（实际 ${JSON.stringify(genRes.body)}）`);
    assert.equal(capturedPrompts.length, 1);
    const slimPrompt = capturedPrompts[0] ?? "";

    // c1) pending 整段不出现（不可操作，纯输入噪音）
    assert.ok(!slimPrompt.includes("【待定加入】"), "planner prompt 不应包含【待定加入】区块标题");
    for (const stopId of ["stop_snack", ...Array.from({ length: 8 }, (_, i) => `stop_slim_${i + 1}`)]) {
      assert.ok(!slimPrompt.includes(stopId), `pending stop ${stopId} 不应出现在 planner prompt`);
    }

    // c2) 无来源关联候选裁剪 / 有关联候选保留（判据只基于真实字段 sourceEvidenceRefs / sourceMentionRefs）
    assert.ok(!slimPrompt.includes("item_daxiaodongtian"), "无攻略关联候选 item_daxiaodongtian 应被裁剪");
    for (let index = 1; index <= 5; index += 1) {
      assert.ok(!slimPrompt.includes(`item_noguide_${index}`), `无关联候选 item_noguide_${index} 应被裁剪`);
    }
    assert.ok(slimPrompt.includes("item_slim_guide"), "有攻略证据引用的候选应保留");

    // c3) quote 截断到 ≤80 Unicode 字符（含末位省略号）
    const longQuotes: Array<[string, string]> = [
      ["longQuoteA", longQuoteA],
      ["longQuoteB", longQuoteB],
    ];
    for (const [name, raw] of longQuotes) {
      const truncated = `${[...raw].slice(0, 79).join("")}…`;
      assert.ok([...truncated].length <= 80, `${name} 截断后应 ≤80 字符`);
      assert.ok(slimPrompt.includes(JSON.stringify(truncated)), `${name} 应以 79 字 + 省略号截断出现`);
      assert.ok(!slimPrompt.includes(JSON.stringify(raw)), `${name} 完整原文不应出现`);
    }

    // c4) quote 非空不再重发 modelSummary；空 quote 才用 modelSummary 兜底
    assert.ok(!slimPrompt.includes("【桩】"), "非空 quote 的 modelSummary（【桩】前缀）不应重复发送");
    assert.ok(
      slimPrompt.includes("后海村夜市七点后最热闹，海鲜先问价再落座"),
      "空 quote 的 mention 应以 modelSummary 兜底",
    );

    // c5) operations ≤15 条规则
    assert.ok(slimPrompt.includes("最多 15 条"), "规则应包含 operations ≤15 条限制");

    // d) 规模对照：同 trip 的旧版等价 prompt（全量 facts + 旧素材格式，规则/scope/note 复用新 prompt）
    const savedSlim = await loadTrip(slimTrip.tripId);
    const mergeSlim = mergeGuideMentions(savedSlim);
    // 规则文本内也提及【行程现状】字样，必须用 lastIndexOf 锚定真实的块标题（块标题独立成行且是最后一次出现）
    const headEnd = slimPrompt.lastIndexOf("【行程现状】");
    const tailStart = slimPrompt.lastIndexOf("【用户补充句】");
    assert.ok(headEnd > 0 && tailStart > headEnd, "prompt 结构应完整（现状块与补充句块存在）");
    const legacyPrompt = `${slimPrompt.slice(0, headEnd)}【行程现状】\n${buildTripFacts(savedSlim).join("\n")}\n\n【攻略素材】\n${buildLegacyMaterialsForCompare(savedSlim, mergeSlim).join("\n")}\n\n${slimPrompt.slice(tailStart)}`;
    const ratio = slimPrompt.length / legacyPrompt.length;
    console.log(
      `[verify] Task #110 规模对照：旧版等价 ${legacyPrompt.length} 字符 → 瘦身后 ${slimPrompt.length} 字符（减少 ${((1 - ratio) * 100).toFixed(1)}%）`,
    );
    assert.ok(slimPrompt.length < legacyPrompt.length, "瘦身后 prompt 必须短于旧版等价");
    assert.ok(ratio < 0.9, `瘦身幅度应 ≥10%（实际减少 ${((1 - ratio) * 100).toFixed(1)}%）`);
    pass("20. prompt 瘦身：pending 不出现 / 无关联候选裁剪 / quote 截断 80 字 / modelSummary 去重 / 规模显著下降");
  }

  // ---------- Task #123 后海行程（场景 21-25 主体，模仿真实 trip d0174797 的隔离副本） ----------
  const houhaiTripA = await createFixtureSanyaTrip();
  createdTripIds.push(houhaiTripA.tripId);
  const tripIdA = houhaiTripA.tripId;
  await setupHouhaiFixture(tripIdA);
  const houhaiTrip = await loadTrip(tripIdA);

  // ---------- 场景 21：日期指令纯函数解析（变体矩阵 + 缺数字 + 超范围） ----------
  {
    const parse = (note: string): GuideDraftDayDirective[] => parseDraftDirectives(note, houhaiTrip);

    // a) DAY3 连写 + 动词剥离 + 多匹配（Task #147）：large_attraction 优先在前（「后海」→
    //    三亚后海村 + 后海海滩都命中；旧行为只返回第一条会遗漏第二个真实地点）
    const a = parse("DAY3去后海，结合攻略排一版本");
    assert.deepEqual(a, [
      {
        directiveId: "dir_1",
        dayIndex: 3,
        placeText: "后海",
        resolvedVisitIds: ["visit_houhai", "visit_beach_hh"],
        rawSentence: "DAY3去后海",
      },
    ], "DAY3 应解析为 Day3 指令；「后海」多匹配：large 的三亚后海村在前，互含的后海海滩也命中");

    // b) Day 3 带空格 / 安排动词
    const b = parse("Day 3 安排后海");
    assert.equal(b[0]?.dayIndex, 3);
    assert.equal(b[0]?.placeText, "后海", "「安排」动词应被剥离");

    // c) 第3天 / 第 三 天（空格）/ 全角 / 中文数字
    assert.equal(parse("第3天去后海")[0]?.dayIndex, 3);
    assert.equal(parse("第 三 天去后海")[0]?.dayIndex, 3);
    assert.equal(parse("第３天去后海")[0]?.dayIndex, 3, "全角数字应等价半角");
    assert.equal(parse("DAY三去后海")[0]?.dayIndex, 3, "中文数字应等价阿拉伯数字");

    // d) 「把 X 排进去」语序（日期词在前、地点在把字后）
    const d = parse("第3天把后海排进去");
    assert.equal(d[0]?.dayIndex, 3);
    assert.equal(d[0]?.placeText, "后海");

    // e) 无日期句 → 空数组（补充句仍作软建议进 prompt，不产生硬指令）
    assert.deepEqual(parse("雨天备选方案多一点"), []);
    assert.deepEqual(parse("节奏放慢一点"), []);

    // f) 多日期 token：未匹配地点不报错（unmet），已匹配地点解析到实体
    const f = parse("DAY2去西岛，DAY4蜈支洲岛");
    assert.deepEqual(f, [
      { directiveId: "dir_1", dayIndex: 2, placeText: "西岛", resolvedVisitIds: [], rawSentence: "DAY2去西岛" },
      {
        directiveId: "dir_2",
        dayIndex: 4,
        placeText: "蜈支洲岛",
        resolvedVisitIds: ["visit_wzz"],
        rawSentence: "DAY4蜈支洲岛",
      },
    ]);

    // g) 明显写了 DAY 但缺数字（真实 trip 的「DAY安排后海」形态）→ 可识别错误码
    assert.throws(
      () => parse("DAY2去西岛，DAY安排后海，DAY4蜈支洲岛，结合攻略排一版本吧"),
      (error: unknown) => {
        assert.ok(error instanceof AiError, "缺数字应抛 AiError");
        assert.equal((error as AiError).code, "GUIDE_DAY_NUMBER_REQUIRED");
        assert.match((error as AiError).message, /补全/, "错误文案应用用户语言提示补全写法");
        return true;
      },
      "「DAY安排后海」缺数字应抛 GUIDE_DAY_NUMBER_REQUIRED",
    );
    assert.throws(
      () => parse("第天去后海"),
      (error: unknown) => {
        assert.ok(error instanceof AiError);
        return (error as AiError).code === "GUIDE_DAY_NUMBER_REQUIRED";
      },
      "「第天」骨架缺数字同样拦截",
    );

    // h) 超出行程范围（fixture 5 天，Day9 越界）
    assert.throws(
      () => parse("DAY9去后海"),
      (error: unknown) => {
        assert.ok(error instanceof AiError);
        assert.equal((error as AiError).code, "GUIDE_DAY_INDEX_OUT_OF_RANGE");
        assert.match((error as AiError).message, /共 5 天/);
        return true;
      },
      "超范围 dayIndex 应抛 GUIDE_DAY_INDEX_OUT_OF_RANGE",
    );
    pass("21. 日期指令解析：DAY3/Day 3/第3天/全角/中文数字变体 / large 优先匹配 / 缺数字与超范围错误码");
  }

  // ---------- 场景 22：note 数字端到端不丢（逐字落盘 + 提交时缺数字不掩盖） ----------
  {
    const noteWithDigits = "DAY3去后海，第4天去蜈支洲岛";
    const putRes = await requestJson(`/trips/${tripIdA}/draft-note`, "PUT", { note: noteWithDigits });
    assert.equal(putRes.status, 200);
    const saved = await loadTrip(tripIdA);
    assert.equal(
      saved.guideDraftNote,
      noteWithDigits,
      "PUT /draft-note 应逐字保存（句中数字与写法不丢不改）",
    );

    // 真实 trip 的缺数字字符串：保存逐字保留 → 解析 400 → 不调 AI、不落草案。
    // 即：磁盘上「DAY安排后海」是提交时已缺数字，server 不存在吞数字 normalize。
    const missingDigitNote = "DAY2去西岛，DAY安排后海，DAY4蜈支洲岛，结合攻略排一版本吧";
    armPlanner(); // 桩置空：任何 planner 调用都会使 capturedPrompts 非空或拋错
    const res = await requestJson(`/trips/${tripIdA}/draft`, "POST", {
      scope: { kind: "trip" },
      note: missingDigitNote,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "GUIDE_DAY_NUMBER_REQUIRED");
    assert.match(String(res.body.message), /补全/, "400 文案应为用户语言");
    const after = await loadTrip(tripIdA);
    assert.equal(
      after.guideDraftNote,
      missingDigitNote,
      "缺数字 note 应原样落盘：磁盘缺数字是提交时已缺，server 不吞字符",
    );
    assert.equal(after.pendingGuideDraft, undefined, "解析失败不得保存草案");
    assert.equal(capturedPrompts.length, 0, "指令解析在 planner 调用之前，失败不应调 AI");
    pass("22. note 数字端到端不丢：PUT/POST 逐字落盘 / 缺数字 400 不调 AI 不落草案");
  }

  // ---------- 场景 23：DAY3 完整链路（错误排天后校验 + 弱证据 classify 丢弃 + 冲突契约 + apply met） ----------
  {
    // 桩模拟模型的三个行为：错误排天（move 到 Day1）/ 编造证据 classify / 合法 setDuration
    armPlanner(
      JSON.stringify({
        operations: [
          {
            op: "move",
            subjectRef: { kind: "visit", id: "visit_houhai" },
            containerRef: { kind: "day", dayIndex: 1 },
            toOrder: 0,
            reason: "模型自作主张留在 Day1",
          },
          {
            op: "classifyVisitAsStop",
            visitId: "visit_sanhewfg",
            parentVisitId: "visit_houhai",
            toOrder: null,
            evidenceMentionRefs: ["ev_ghost:x9"],
            reason: "编造引用尝试归类",
          },
          { op: "setDuration", subjectRef: { kind: "stop", id: "stop_bridge" }, minutes: 55, reason: "情人桥多留" },
        ],
        snippets: [],
      }),
    );
    const genRes = await requestJson(`/trips/${tripIdA}/draft`, "POST", {
      scope: { kind: "trip" },
      note: "DAY3去后海，结合攻略排一版本",
    });
    assert.equal(genRes.status, 200, `生成应 200（实际 ${JSON.stringify(genRes.body)}）`);

    const prompt = capturedPrompts[0] ?? "";
    assert.ok(prompt.includes("【日期硬性指令】"), "指令块应注入 prompt");
    assert.ok(prompt.includes("不可违背"), "应声明不可自行改天");
    assert.ok(prompt.includes("visit_houhai"), "指令应携带已解析的 visit id");
    assert.ok(prompt.includes("visit_beach_hh"), "多匹配后指令块应携带第二个命中的 visit id（Task #147）");
    assert.ok(prompt.includes("DAY3去后海"), "应携带用户原话溯源");

    assert.deepEqual(genRes.body.directives, [
      {
        directiveId: "dir_1",
        dayIndex: 3,
        placeText: "后海",
        resolvedVisitIds: ["visit_houhai", "visit_beach_hh"],
        rawSentence: "DAY3去后海",
      },
    ]);

    const ops = genRes.body.operations as Operation[];
    const transferOps = ops.filter((op) => op.op === "transfer");
    assert.equal(transferOps.length, 2, "模型错误排 Day1 的 op 应被移除；多匹配后两个主体各补一条 transfer");
    const backfill = transferOps[0] as Extract<Operation, { op: "transfer" }>;
    assert.equal(backfill.subjectRef.kind, "visit");
    assert.equal(backfill.subjectRef.id, "visit_houhai");
    assert.equal(
      backfill.toContainerRef.kind === "day" ? backfill.toContainerRef.dayIndex : -1,
      3,
      "服务端应补排到 Day3（不能只信模型；跨天移动用 transfer）",
    );
    assert.match(backfill.reason, /服务端补排/);
    const beachBackfill = transferOps[1] as Extract<Operation, { op: "transfer" }>;
    assert.equal(
      beachBackfill.subjectRef.kind === "visit" ? beachBackfill.subjectRef.id : "",
      "visit_beach_hh",
      "同一指令命中的第二个主体（后海海滩）也应被服务端补排（Task #147）",
    );
    assert.equal(beachBackfill.toContainerRef.kind === "day" ? beachBackfill.toContainerRef.dayIndex : -1, 3);
    assert.equal(
      ops.some((op) => op.op === "classifyVisitAsStop"),
      false,
      "编造引用的 classify 不得下发（证据不足不下发此 op）",
    );
    assert.ok(ops.some((op) => op.op === "setDuration"), "非排天合法 op 应保留");

    const checks = genRes.body.requirementChecks as Array<{ status: string; detail: string }>;
    assert.equal(checks.length, 1);
    assert.equal(checks[0]?.status, "met", "按草案终态推演：补排后目标 Visit 位于 Day3");

    const conflicts = genRes.body.conflicts as Array<{
      conflictId: string;
      kind: string;
      directiveId: string | null;
      subjectRef: { kind: string; id?: string } | null;
      subjectLabel: string;
      detail: string;
      sensitive: boolean;
      defaultSelected: boolean;
      resolution: Operation | null;
    }>;
    assert.equal(conflicts.length, 1, "Day3 已有普通安排应列告知冲突，且无其他冲突");
    assert.equal(conflicts[0]?.kind, "target_day_occupied");
    assert.equal(conflicts[0]?.directiveId, "dir_1");
    assert.equal(conflicts[0]?.subjectLabel, "Day 3", "汇总告知项以天为标签");
    assert.match(String(conflicts[0]?.detail), /第一市场/, "受影响项应在 detail 中列出");
    assert.equal(conflicts[0]?.sensitive, false, "普通安排冲突不敏感");
    assert.equal(
      conflicts[0]?.defaultSelected,
      false,
      "纯告知项（resolution=null）默认不选，生成阶段不覆盖既有安排",
    );
    assert.equal(conflicts[0]?.resolution, null, "普通安排冲突无可执行 resolution（新项追加不覆盖）");

    // apply：补排 move（目标非锁定）直接应用；visit_market 不被动
    const applyRes = await requestJson(`/trips/${tripIdA}/draft/apply`, "POST");
    assert.equal(applyRes.status, 200);
    assert.equal(applyRes.body.type, "applied");
    const afterTrip = await loadTrip(tripIdA);
    assert.equal(afterTrip.visits.visit_houhai?.dayRef, "day_3", "后海村终态必须位于 Day3");
    assert.equal(afterTrip.visits.visit_beach_hh?.dayRef, "day_3", "同一指令命中的后海海滩也随补排到 Day3（Task #147）");
    assert.ok(afterTrip.days.day_3?.scheduleVisitRefs.includes("visit_houhai"));
    assert.equal(afterTrip.days.day_1?.scheduleVisitRefs.includes("visit_houhai"), false);
    assert.ok(afterTrip.days.day_3?.scheduleVisitRefs.includes("visit_market"), "告知冲突不覆盖既有安排");
    assert.equal(
      afterTrip.visits.visit_sanhewfg?.kind,
      "ordinary",
      "弱证据目标仍是独立 ordinary Visit（未被自动归类）",
    );
    const applyChecks = applyRes.body.requirementChecks as Array<{ status: string }>;
    assert.equal(applyChecks[0]?.status, "met", "apply 后按真实行程重算应收敛 met");
    assert.equal(applyRes.body.requirementSummary, null, "全部满足时无 partial 摘要");
    pass("23. DAY3 链路：指令进 prompt / 错误排 Day1 被后校验移除并补排 / 弱证据 classify 不下发 / 冲突契约 / apply met");
  }

  // ---------- 场景 24：「第 3 天」变体端到端 + 已在指定天不重复补排 ----------
  {
    armPlanner(STUB_DRAFT_JSON);
    const genRes = await requestJson(`/trips/${tripIdA}/draft`, "POST", {
      scope: { kind: "trip" },
      note: "第 3 天 去后海",
    });
    assert.equal(genRes.status, 200);
    const directives = genRes.body.directives as Array<{ dayIndex: number; placeText: string }>;
    assert.equal(directives[0]?.dayIndex, 3, "「第 3 天」空格变体应解析");
    assert.equal(directives[0]?.placeText, "后海");
    const ops = genRes.body.operations as Operation[];
    assert.equal(
      ops.some((op) => op.op === "move" || op.op === "transfer"),
      false,
      "主体已在 Day3（场景 23 补排），不应重复补排",
    );
    const conflicts = genRes.body.conflicts as Array<{ kind: string }>;
    assert.equal(conflicts[0]?.kind, "target_day_occupied", "Day3 普通安排仍应告知");
    const applyRes = await requestJson(`/trips/${tripIdA}/draft/apply`, "POST");
    assert.equal(applyRes.status, 200);
    const after = await loadTrip(tripIdA);
    assert.equal(after.visits.visit_houhai?.dayRef, "day_3");
    pass("24. 「第 3 天」变体端到端：已在指定天的主体不重复补排 / 冲突照常告知");
  }

  // ---------- 场景 25：锁定/已购冲突契约 + selectedConflictIds 部分应用 ----------
  {
    // a) 纯函数：锁定 / 已购主体的补排 move 必须列冲突（生成阶段不覆盖，等用户勾选）
    const beforeLock = await loadTrip(tripIdA);
    const lockedClone = structuredClone(beforeLock);
    if (lockedClone.visits.visit_houhai !== undefined) lockedClone.visits.visit_houhai.locked = true;
    const boughtClone = structuredClone(beforeLock);
    if (boughtClone.visits.visit_houhai !== undefined) boughtClone.visits.visit_houhai.purchaseState = "bought";
    const dirDay4: GuideDraftDayDirective = {
      directiveId: "dir_1",
      dayIndex: 4,
      placeText: "后海",
      resolvedVisitIds: ["visit_houhai"],
      rawSentence: "DAY4去后海",
    };
    const lockedEnforced = enforceDraftDirectives(lockedClone, [dirDay4], []);
    assert.equal(lockedEnforced.conflicts.length, 1, "day_4 空：应仅锁定主体一条冲突");
    assert.equal(lockedEnforced.conflicts[0]?.kind, "subject_locked");
    assert.equal(lockedEnforced.conflicts[0]?.sensitive, true, "敏感冲突默认不选");
    assert.equal(lockedEnforced.conflicts[0]?.defaultSelected, false);
    assert.ok(lockedEnforced.conflicts[0]?.resolution !== null, "锁定冲突应带可执行的 transfer resolution");
    assert.equal(lockedEnforced.requirementChecks[0]?.status, "pending", "生成时：需勾选冲突后才能确定");
    const boughtEnforced = enforceDraftDirectives(boughtClone, [dirDay4], []);
    assert.equal(boughtEnforced.conflicts[0]?.kind, "subject_bought", "已购主体同理列冲突");

    // b) 端到端：锁定后海村 → 生成（两个主体的补排 transfer 中，锁定者会以 ai_proposed
    //    被 G3 拒，未锁的后海海滩照常应用）。
    //    桩带 3 条合法 setDuration：违规率 1/5 ≤ 30% 不触发整批拒绝，
    //    可验证「未勾选冲突仅锁定主体的补排被拒、其余照常应用」的部分应用语义。
    const toLock = await loadTrip(tripIdA);
    toLock.visits.visit_houhai.locked = true;
    await tripStore.save(toLock);
    const diluteStub = JSON.stringify({
      operations: [
        { op: "setDuration", subjectRef: { kind: "stop", id: "stop_bridge" }, minutes: 45, reason: "情人桥 45" },
        { op: "setDuration", subjectRef: { kind: "stop", id: "stop_beach" }, minutes: 95, reason: "浴场 95" },
        { op: "setDuration", subjectRef: { kind: "stop", id: "stop_rock" }, minutes: 65, reason: "观日岩 65" },
      ],
      snippets: [],
    });
    armPlanner(diluteStub); // 模型不排天，服务端补排
    const genRes = await requestJson(`/trips/${tripIdA}/draft`, "POST", {
      scope: { kind: "trip" },
      note: "DAY4去后海",
    });
    assert.equal(genRes.status, 200);
    const conflicts = genRes.body.conflicts as Array<{ conflictId: string; kind: string; sensitive: boolean }>;
    const lockedConflict = conflicts.find((conflict) => conflict.kind === "subject_locked");
    assert.ok(lockedConflict !== undefined, "草案应携带锁定冲突供任务 125 渲染勾选");
    const checks = genRes.body.requirementChecks as Array<{ status: string }>;
    assert.equal(checks[0]?.status, "pending");

    // c) 不带 selectedConflictIds apply：锁定主体的补排 transfer 被 G3 拒，未锁的后海海滩
    //    照常生效 → partial + 未选摘要（不笼统成功）
    const apply1 = await requestJson(`/trips/${tripIdA}/draft/apply`, "POST");
    assert.equal(apply1.status, 200);
    assert.equal(
      (apply1.body.applied as unknown[]).length,
      4,
      "3 条 setDuration + 未锁主体的后海海滩补排 transfer 应用（锁定主体的补排被拒）",
    );
    assert.equal(apply1.body.rejectedCount, 1, "锁定主体的补排 transfer 应被 G3 拒（AI 不可动）");
    assert.equal(apply1.body.allRejected, false, "1/5 违规不触发整批拒绝");
    const partialChecks = apply1.body.requirementChecks as Array<{ status: string; detail: string }>;
    assert.equal(
      partialChecks[0]?.status,
      "partial",
      "未勾选冲突：锁定主体未生效，但同一指令命中的未锁主体已生效（Task #147）",
    );
    assert.match(String(partialChecks[0]?.detail), /后海海滩.*已位于 Day 4.*三亚后海村.*未生效/);
    assert.deepEqual(apply1.body.appliedConflictIds, []);
    const unselected = apply1.body.unselectedConflicts as Array<{ conflictId: string; subjectLabel: string }>;
    assert.ok(
      unselected.some((entry) => entry.conflictId === lockedConflict.conflictId),
      "未选冲突应回传摘要（保持原状项）",
    );
    assert.match(String(apply1.body.requirementSummary), /部分满足/, "requirement 摘要不得笼统成功");
    const after1 = await loadTrip(tripIdA);
    assert.equal(after1.visits.visit_houhai?.dayRef, "day_3", "未勾选：保持原状（Day3）");
    assert.equal(after1.visits.visit_beach_hh?.dayRef, "day_4", "未锁主体照常生效（Task #147）");

    // d) 重新生成（冲突 id 重排）→ 带 selectedConflictIds 部分应用：user_confirmed 执行
    armPlanner(diluteStub);
    const genRes2 = await requestJson(`/trips/${tripIdA}/draft`, "POST", {
      scope: { kind: "trip" },
      note: "DAY4去后海",
    });
    assert.equal(genRes2.status, 200);
    const conflicts2 = genRes2.body.conflicts as Array<{ conflictId: string; kind: string }>;
    const locked2 = conflicts2.find((conflict) => conflict.kind === "subject_locked");
    assert.ok(locked2 !== undefined);
    const apply2 = await requestJson(`/trips/${tripIdA}/draft/apply`, "POST", {
      selectedConflictIds: [locked2.conflictId],
    });
    assert.equal(apply2.status, 200);
    assert.equal(
      (apply2.body.applied as unknown[]).length,
      4,
      "3 条 setDuration + 冲突 resolution transfer 均应应用",
    );
    assert.deepEqual(
      apply2.body.appliedConflictIds,
      [locked2.conflictId],
      "选中的冲突应以 user_confirmed 执行并回传 id",
    );
    const after2 = await loadTrip(tripIdA);
    assert.equal(after2.visits.visit_houhai?.dayRef, "day_4", "勾选锁定冲突后应实际移动到 Day4");
    const metChecks = apply2.body.requirementChecks as Array<{ status: string }>;
    assert.equal(metChecks[0]?.status, "met");
    assert.equal(apply2.body.requirementSummary, null);
    assert.equal(
      (apply2.body.unselectedConflicts as unknown[]).length,
      0,
      "唯一冲突已选中执行：无保持原状项",
    );
    pass("25. 锁定/已购冲突契约：纯函数检测 / 不选则 G3 拒+partial（锁定项未生效、未锁项生效）+未选摘要 / 选则 user_confirmed 执行+met");
  }

  // ---------- 场景 26：强证据父子归类 + parent 补排 Day3（后海夹具端到端） ----------
  {
    const tripB = await createFixtureSanyaTrip();
    createdTripIds.push(tripB.tripId);
    await setupHouhaiFixture(tripB.tripId);

    // 桩：模型输出双侧可追溯的 classify（m3=后海海滩 来源侧 + m2=后海村 目标侧）
    armPlanner(
      JSON.stringify({
        operations: [
          {
            op: "classifyVisitAsStop",
            visitId: "visit_beach_hh",
            parentVisitId: "visit_houhai",
            toOrder: null,
            evidenceMentionRefs: ["ev_note_9:m3", "ev_note_9:m2"],
            reason: "攻略明示「后海海滩位于后海村内」",
          },
          { op: "setDuration", subjectRef: { kind: "stop", id: "stop_bridge" }, minutes: 50, reason: "情人桥 50 分钟" },
        ],
        snippets: [],
      }),
    );
    const genRes = await requestJson(`/trips/${tripB.tripId}/draft`, "POST", {
      scope: { kind: "trip" },
      note: "DAY3去后海",
    });
    assert.equal(genRes.status, 200, `生成应 200（实际 ${JSON.stringify(genRes.body)}）`);

    const autos = genRes.body.autoClassifications as Array<{
      visitId: string;
      visitName: string;
      parentVisitId: string;
      parentName: string;
      evidenceMentionRefs: string[];
    }>;
    assert.equal(autos.length, 1, "强证据 classify 应保留并生成归类摘要");
    assert.equal(autos[0]?.visitId, "visit_beach_hh");
    assert.equal(autos[0]?.parentVisitId, "visit_houhai");
    assert.deepEqual(autos[0]?.evidenceMentionRefs, ["ev_note_9:m3", "ev_note_9:m2"]);

    const ops = genRes.body.operations as Operation[];
    assert.equal(
      ops[0]?.op,
      "classifyVisitAsStop",
      "classify 应前置（先归类后安排 parent，避免先 plan 已被删除的 child）",
    );
    const transferOp = ops.find((op) => op.op === "transfer") as Extract<Operation, { op: "transfer" }> | undefined;
    assert.ok(transferOp !== undefined, "服务端应补排 parent 到 Day3（模型桩未排天）");
    assert.equal(
      transferOp.subjectRef.kind === "visit" ? transferOp.subjectRef.id : "",
      "visit_houhai",
    );
    assert.equal(transferOp.toContainerRef.kind === "day" ? transferOp.toContainerRef.dayIndex : -1, 3);
    const checks = genRes.body.requirementChecks as Array<{ status: string }>;
    assert.equal(checks[0]?.status, "met", "补排后 parent 终态位于 Day3");

    const applyRes = await requestJson(`/trips/${tripB.tripId}/draft/apply`, "POST");
    assert.equal(applyRes.status, 200);
    assert.equal(
      (applyRes.body.applied as unknown[]).length,
      3,
      "classify + 补排 move + setDuration 均非敏感应直接应用",
    );
    assert.equal(
      (applyRes.body.autoClassifications as unknown[]).length,
      1,
      "apply 响应应回传归类摘要",
    );

    const saved = await loadTrip(tripB.tripId);
    assert.equal(saved.visits.visit_beach_hh, undefined, "原 ordinary Visit 应已删除");
    const converted = Object.values(saved.stops).find(
      (stop) => stop.classifiedFromVisitRef === "visit_beach_hh",
    );
    assert.ok(converted !== undefined, "应存在 classifiedFromVisitRef=visit_beach_hh 的 Stop");
    assert.equal(converted.visitRef, "visit_houhai", "新 Stop 应挂靠后海村");
    assert.equal(converted.state, "attached");
    assert.ok(
      saved.visits.visit_houhai?.childStopRefs.includes(converted.stopId),
      "parent.childStopRefs 应包含转换后的 Stop",
    );
    assert.equal(saved.visits.visit_houhai?.dayRef, "day_3", "parent 应位于 Day3");
    assert.ok(saved.days.day_3?.scheduleVisitRefs.includes("visit_houhai"));
    const applyChecks = applyRes.body.requirementChecks as Array<{ status: string }>;
    assert.equal(applyChecks[0]?.status, "met");
    pass("26. 强证据归类：classify 前置 + parent 补排 Day3 + apply 后 classifiedFromVisitRef 落地");
  }

  // ---------- 场景 27：弱证据不归类（仅目标单侧提及，双侧追溯不满足） ----------
  {
    const tripC = await createFixtureSanyaTrip();
    createdTripIds.push(tripC.tripId);
    await setupHouhaiFixture(tripC.tripId);

    // 桩：仅带目标侧提及 m2（来源侧 0 条）——同日/同篇/名称相似不构成从属证据
    armPlanner(
      JSON.stringify({
        operations: [
          {
            op: "classifyVisitAsStop",
            visitId: "visit_beach_hh",
            parentVisitId: "visit_houhai",
            toOrder: null,
            evidenceMentionRefs: ["ev_note_9:m2"],
            reason: "同篇攻略提到后海海滩，尝试归类",
          },
        ],
        snippets: [],
      }),
    );
    const genRes = await requestJson(`/trips/${tripC.tripId}/draft`, "POST", {
      scope: { kind: "trip" },
      note: "DAY3去后海",
    });
    assert.equal(genRes.status, 200);
    assert.equal(
      (genRes.body.autoClassifications as unknown[]).length,
      0,
      "单侧弱证据不得生成归类摘要",
    );
    const ops = genRes.body.operations as Operation[];
    assert.equal(
      ops.some((op) => op.op === "classifyVisitAsStop"),
      false,
      "证据不足的 classify 不得下发",
    );
    assert.ok(
      ops.some((op) => op.op === "transfer"),
      "指令本身仍有效：parent 补排照常",
    );

    const applyRes = await requestJson(`/trips/${tripC.tripId}/draft/apply`, "POST");
    assert.equal(applyRes.status, 200);
    const saved = await loadTrip(tripC.tripId);
    assert.equal(
      saved.visits.visit_beach_hh?.kind,
      "ordinary",
      "弱证据不归类：后海海滩仍是独立 ordinary Visit",
    );
    assert.equal(
      Object.values(saved.stops).some((stop) => stop.classifiedFromVisitRef === "visit_beach_hh"),
      false,
      "不得产生溯源 Stop",
    );
    pass("27. 弱证据不归类：单侧提及被双侧追溯门槛拦截 / classify 不下发 / 原 Visit 保留");
  }

  // 收尾一致性：全程未破坏行程可加载性
  const finalTrip = await loadTrip(tripId);
  assert.ok(finalTrip.visits.visit_wzz !== undefined, "行程主结构应保持完整");
  void baseVersionAfterSetup;
}
void fs;

main().catch((error) => {
  console.error("\n[verify] 验证失败：", error);
  process.exitCode = 1;
});
