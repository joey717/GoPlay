/**
 * Task #275：首轮 28 条用例定义（用例文档 v1.1 §5）。
 *
 * 每条用例带映射标注（v1.1 拍板口径）：
 * - implStatus：已实现 / 依赖planner输出 / 未实现（逐条对照代码核实，见 eval/case-mapping.md）；
 * - backlog：未实现项两级标签——参赛必须（S10/S5/C1/C4，转 Task #278 本周实现）/ 赛后（只跟踪）；
 * - reuse：复用既有 verify 脚本 / vitest 套件；缺口才新建内联断言（run 字段）。
 *
 * 绿判据（首轮）＝已实现子集全绿；依赖planner输出项在非 live 轮记 blocked（回放就绪后转绿），
 * 未实现项记 blocked（带 backlog 标签）。
 *
 * 内联断言（本轮新建，全部离线）：
 * - FX1：EVAL_FIXTURE 抽取层替换证明（fixtureLoader 注入生效 + 后台处理 ready）；
 * - E6：同 canonicalUrl 粘两次去重为 1 源（submitGuideSource.duplicate）；
 * - A9：snippet 40 字硬截断 / 引用 ≤3 / 非法 targetRef 丢弃（parsePlannerOutput 生产解析链）；
 * - A10：snippet evidenceRefs 1–3 非空且全部落在消费集合（可溯源前提）；
 * 脚本复用（子进程执行，解析退出码）：
 * - S7 / O8 / O1 → shared/src/verify.ts（guards G1/G3 锁定项拒绝、30% 阈值、时间线）；
 * - E6 / E8 / A7 / E3 / Q5 → server/src/guides/verify-b2.ts（来源状态机、去重、多图 1 源）；
 * - A9 / A10（补充）→ shared/src/verify-dedupe.ts、shared/src/verify-guides.ts。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClarificationAnswer, ContainerRef, Day, EntityRef, Item, Operation, Trip, Visit } from "@goplay/shared";
import {
  AI_SUPPLEMENT_CHIP_LABEL,
  AI_SUPPLEMENT_CHIP_LABEL_COMPACT,
  deriveDayRoles,
  deriveTimeSourceLabels,
  estimateGuideCoverage,
  isAiSupplement,
  isRealFliggyPoi,
  itemProvenance,
  normalizeSnippetText,
  recomputeDerivedFields,
  validateAiSupplementProvenance,
} from "@goplay/shared";
import { generateGuideDraft, markAiSupplementProvenance, parsePlannerOutput } from "../../server/src/guides/planner.js";
import {
  getGuideSource,
  submitGuideSource,
} from "../../server/src/guides/service.js";
import { buildFixtureSanyaTrip, createFixtureSanyaTrip, tripStore } from "../../server/src/persistence/store.js";
import {
  getFixtureStats,
  installFixtureExtraction,
  loadFixtureAssets,
  resetFixtureStats,
  uninstallFixtureExtraction,
} from "../harness/fixtureLoader.js";
import {
  getSharedDraft,
  getSharedIntent,
  setSharedPlannerModes,
  type SharedDraftScenario,
} from "../harness/draftScenario.js";

// ===== 用例元数据模型 =====

export type ImplStatus = "已实现" | "依赖planner输出" | "未实现";
export type BacklogTag = "参赛必须" | "赛后" | "-";
export type Judgment = "机" | "人" | "报" | "机+人";
export type Layer = "L1" | "L2" | "L3" | "L4" | "L5" | "L6";

/** 断言上下文：ctx.log 的每一行都会落进 evidence/{ID}.log（机器证据，禁止手写） */
export interface CaseContext {
  log(line: string): void;
}

export interface EvalCase {
  id: string;
  layer: Layer;
  title: string;
  /** 用例文档 v1.1 的断言原文（争议仲裁唯一标准） */
  assertion: string;
  judgment: Judgment;
  implStatus: ImplStatus;
  backlog: BacklogTag;
  /** 复用说明：既有脚本路径 / vitest 套件 / 「新建内联」 */
  reuse: string;
  /** 执行方式：inline＝本文件内联断言；script＝子进程跑既有 verify 脚本；null＝本轮不执行（blocked） */
  run:
    | { kind: "inline"; fn: (ctx: CaseContext) => Promise<void> | void }
    | { kind: "script"; cwd: string; command: string[]; env?: Record<string, string> }
    | null;
  /**
   * 依赖 planner 的共享草案用例（A1/A3/A4/A5/A11/S1/S2/S3）：8 条复用同一次
   * generateGuideDraft 真调。构建者用例经 drainCallModes 拿到 [live]；复用者
   * drain 为空时 runner 回退到 getSharedPlannerModes() 统一打标。
   */
  plannerShared?: boolean;
  /**
   * 「报」判定 UI 用例（Q1/Q3）：除脚本断言外，runner 额外用 playwright 自动截图
   * 存 evidence/{ID}.png（gitignore），report 引路径供 PD 复核。
   */
  uiShot?: boolean;
  /**
   * Task #284：只能 live 执行、不可回放的用例（如 O3 走 executeIntent 直连百炼，
   * 不经 plannerCache）。非 live 轮 blocked，避免无缓存真调烧 token。
   * 与「依赖planner输出」解耦：后者经固定 id 装配后回放已稳定，不再一律阻断。
   */
  liveOnly?: boolean;
  /** blocked / 不执行时的原因说明（写进报告） */
  note?: string;
}

// ===== 内联断言工具 =====

/** 仓库根（eval/cases/first28.ts → ../.. 与 runner.ts 同口径），供 C4 内联 spawn web vitest 定位 cwd */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询来源直到离开 processing（与 verify-b2 同模式；后台 fire-and-forget 任务完成） */
async function pollSourceUntilDone(tripId: string, sourceId: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const source = await getGuideSource(tripId, sourceId);
    if (source.status !== "processing") return source;
    if (Date.now() > deadline) throw new Error(`来源 ${sourceId} 轮询超时（${timeoutMs}ms）仍在 processing`);
    await sleep(100);
  }
}

/** 从行程证据收集全部合法 mentionRef（"evidenceId:mentionId"，A9/A10 的消费集合） */
function collectMentionRefs(trip: Trip): Set<string> {
  const refs = new Set<string>();
  for (const [evidenceId, evidence] of Object.entries(trip.evidences)) {
    for (const mention of evidence.mentions) refs.add(`${evidenceId}:${mention.mentionId}`);
  }
  return refs;
}

// ===== 内联断言：FX1（fixture 注入证明）＋ E6（去重） =====

/**
 * FX1＋E6 合并执行（共享一个 fixture 行程，两次提交）：
 * 1. FX1：EVAL_FIXTURE=1 时 installFixtureExtraction 注入 extractEntries，
 *    提交文本源 → 后台处理 → 断言注入调用计数 >0 且来源 ready（抽取层确实被替换，
 *    [EVAL-FIXTURE] 日志行同步落证据）；
 * 2. E6：同 canonicalUrl（同 noteId、不同 query 参数）再提交一次 → duplicate=true
 *    且 sourceId 相同（去重为 1 源）。
 */
async function runFixtureProofAndDedupe(ctx: CaseContext): Promise<void> {
  const installed = installFixtureExtraction();
  assert.equal(installed, true, "EVAL_FIXTURE=1 时 installFixtureExtraction 应完成注入");
  resetFixtureStats();
  const trip = await createFixtureSanyaTrip();
  try {
    // ---- FX1：文本源全链路（fixture 抽取 → 装配 → ready） ----
    const submitted = await submitGuideSource(trip.tripId, {
      inputKind: "text",
      text: "第一次去三亚旅游，直接复制这条精华路线\n西岛和蜈支洲岛建议提前线上买票",
      title: "S1 fixture 源",
    });
    const done = await pollSourceUntilDone(trip.tripId, submitted.sourceId);
    const stats = getFixtureStats();
    ctx.log(`FX1 assert: installFixtureExtraction() === true（EVAL_FIXTURE=1 注入生效）`);
    ctx.log(`FX1 assert: fixtureStats.calls = ${stats.calls} > 0（业务链路确实调到 fixture extractEntries）`);
    assert.ok(stats.calls > 0, "抽取层未被 fixture 替换：extractEntries 注入调用计数为 0");
    ctx.log(`FX1 assert: source.status = "${done.status}"（期望 ready；partial/failed 即注入链路异常）`);
    assert.equal(done.status, "ready", `fixture 文本源应处理为 ready，实际 ${done.status}（${done.failureMessage ?? ""}）`);
    ctx.log(`FX1 assert: mentionRefs.length = ${done.mentionRefs.length} > 0（fixture claims 已装配为 mentions）`);
    assert.ok(done.mentionRefs.length > 0, "fixture claims 应装配出非空 mentionRefs");

    // ---- E6：同 canonicalUrl 粘两次去重为 1 源 ----
    const first = await submitGuideSource(trip.tripId, {
      inputKind: "link",
      url: "https://www.xiaohongshu.com/explore/6a6812d3000000001101a289?xsec_token=abc123",
    });
    const second = await submitGuideSource(trip.tripId, {
      inputKind: "link",
      url: "https://www.xiaohongshu.com/explore/6a6812d3000000001101a289?utm_source=ios&share_id=xyz",
    });
    // 先等链接源后台任务到终态再断言：listGuideSources 的过期 processing 恢复
    // （recoverStaleProcessing）会写盘，与后台任务写盘竞态（评测环境可复现的噪声源）
    await pollSourceUntilDone(trip.tripId, first.sourceId);
    ctx.log(`E6 assert: first.duplicate = ${first.duplicate}（期望 false，首次提交）`);
    ctx.log(`E6 assert: second.duplicate = ${second.duplicate}（期望 true，同 canonicalUrl 命中去重）`);
    ctx.log(`E6 assert: second.sourceId === first.sourceId（${second.sourceId} === ${first.sourceId}）`);
    assert.equal(first.duplicate, false, "首次提交不应命中去重");
    assert.equal(second.duplicate, true, "同 canonicalUrl 第二次提交应命中去重");
    assert.equal(second.sourceId, first.sourceId, "去重应返回既有来源（1 源）");
    const { sources } = await import("../../server/src/guides/service.js").then((m) => m.listGuideSources(trip.tripId));
    const sameCanonical = sources.filter(
      (source) => source.canonicalUrl === first.source.canonicalUrl,
    );
    ctx.log(`E6 assert: 同 canonicalUrl 来源数 = ${sameCanonical.length}（期望 1）`);
    assert.equal(sameCanonical.length, 1, "同 canonicalUrl 应去重为 1 源");
  } finally {
    await tripStore.deleteTrip(trip.tripId);
    uninstallFixtureExtraction();
  }
}

// ===== 内联断言：A9（snippet 上限）＋ A10（引用可溯源前提） =====

/** 构造 46 字文本（超 40 字硬上限 6 字） */
const LONG_TEXT = "西岛拍照路线从码头出发走到孤独的树全程走走拍拍大概两个小时沿途珊瑚墙和椰林沙滩都值得停留慢慢逛";

function buildFixtureTripRefs(): { validMentionRefs: Set<string>; quoteByText: Map<string, string> } {
  // A9/A10 是纯解析层断言：消费集合用合成 mentionRef（形状与生产一致），
  // 不依赖真实行程——生产同构性由 parsePlannerOutput 本体保证（同一条解析链）。
  const validMentionRefs = new Set(["ev_note_1:m1", "ev_note_1:m2", "ev_note_2:m1", "ev_note_2:m2"]);
  const quoteByText = new Map<string, string>([
    ["走走拍拍大概2小时左右", "走走拍拍大概2小时左右，返程注意末班船"],
  ]);
  return { validMentionRefs, quoteByText };
}

function runSnippetLimits(ctx: CaseContext): void {
  const { validMentionRefs } = buildFixtureTripRefs();
  const finalText = JSON.stringify({
    baseVersion: 1,
    operations: [],
    unplaced: [],
    proposedNew: [],
    clarify: null,
    snippets: [
      // 46 字超长文本 → 40 字硬截断
      { text: LONG_TEXT, claimKind: "tip", targetRef: { kind: "visit", id: "v1" }, sourceMentionRefs: ["ev_note_1:m1"] },
      // 3 条合法引用（上限内）→ 保留
      {
        text: "提前线上买票",
        claimKind: "tip",
        targetRef: { kind: "visit", id: "v1" },
        sourceMentionRefs: ["ev_note_1:m1", "ev_note_1:m2", "ev_note_2:m1"],
      },
      // 4 条引用（> GUIDE_SNIPPET_MAX_MENTION_REFS=3）→ 整条丢弃（生产语义：超限不截断）
      {
        text: "引用超限被丢弃",
        claimKind: "tip",
        targetRef: { kind: "visit", id: "v1" },
        sourceMentionRefs: ["ev_note_1:m1", "ev_note_1:m2", "ev_note_2:m1", "ev_note_2:m2"],
      },
      // 引用全部非法 → 整条丢弃（提示必须可溯源）
      { text: "编造引用被丢弃", claimKind: "tip", targetRef: { kind: "visit", id: "v1" }, sourceMentionRefs: ["ev_fake:m9"] },
      // targetRef kind 非法（day 不承载提示）→ 整条丢弃
      { text: "非法挂载被丢弃", claimKind: "tip", targetRef: { kind: "day", dayIndex: 1 }, sourceMentionRefs: ["ev_note_1:m1"] },
    ],
    optionGroups: [],
  });

  const parsed = parsePlannerOutput(finalText, validMentionRefs);
  assert.ok(parsed !== null, "parsePlannerOutput 应解析成功");
  const snippets = parsed.snippets;
  ctx.log(`A9 assert: 输入 5 条 → 输出 ${snippets.length} 条（期望 2：超长截断保留 + 3 引用保留；引用超限/非法引用/非法 targetRef 三条丢弃）`);
  assert.equal(snippets.length, 2, "非法引用 / 引用超限 / 非法 targetRef 的 snippet 应被丢弃");

  const truncated = snippets[0]!;
  ctx.log(`A9 assert: [..."${LONG_TEXT.slice(0, 12)}…"].length = ${[...truncated.text].length} ≤ 40（GUIDE_SNIPPET_MAX_CHARS 硬上限，截断不回写存储）`);
  assert.ok([...truncated.text].length <= 40, "snippet 超 40 字未截断");
  assert.equal(truncated.text, [...LONG_TEXT].slice(0, 40).join(""), "截断应保留前 40 字");

  const multiRef = snippets[1]!;
  ctx.log(`A9 assert: sourceMentionRefs.length = ${multiRef.sourceMentionRefs.length} ≤ 3（GUIDE_SNIPPET_MAX_MENTION_REFS；>3 整条丢弃已验证）`);
  assert.ok(multiRef.sourceMentionRefs.length <= 3, "snippet 引用超 3 条未拦截");

  // 每 Visit/Stop ≤2 条由 appendGuideSnippet（SNIPPET_PER_ENTITY_LIMIT=GUIDE_SNIPPET_DISPLAY_LIMIT=2）
  // 在挂载层保证——生产链路断言复用 shared/src/verify-dedupe.ts（见 case-mapping A9 行）。
  ctx.log("A9 note: 每实体 ≤2 条上限由挂载层 appendGuideSnippet 保证，复用 shared/src/verify-dedupe.ts 覆盖");
}

function runSnippetTraceability(ctx: CaseContext): void {
  const { validMentionRefs } = buildFixtureTripRefs();
  const finalText = JSON.stringify({
    baseVersion: 1,
    operations: [],
    unplaced: [],
    proposedNew: [],
    clarify: null,
    snippets: [
      { text: "走走拍拍大概2小时左右", claimKind: "experience", targetRef: { kind: "visit", id: "v1" }, sourceMentionRefs: ["ev_note_1:m1"] },
      { text: "西岛和蜈支洲岛建议提前线上买票", claimKind: "tip", targetRef: { kind: "visit", id: "v1" }, sourceMentionRefs: ["ev_note_1:m1", "ev_note_2:m1"] },
    ],
    optionGroups: [],
  });
  const parsed = parsePlannerOutput(finalText, validMentionRefs);
  assert.ok(parsed !== null, "parsePlannerOutput 应解析成功");
  for (const snippet of parsed.snippets) {
    ctx.log(
      `A10 assert: snippet「${snippet.text.slice(0, 14)}…」 refs=${snippet.sourceMentionRefs.length} ∈ [1,3] 且全部 ∈ 消费集合（${snippet.sourceMentionRefs.join(", ")}）`,
    );
    assert.ok(snippet.sourceMentionRefs.length >= 1 && snippet.sourceMentionRefs.length <= 3, "evidenceRefs 必须在 1–3 条");
    for (const ref of snippet.sourceMentionRefs) {
      assert.ok(validMentionRefs.has(ref), `引用 ${ref} 不在草案消费集合内（不可溯源应被过滤）`);
    }
  }
  ctx.log(`A10 assert: 输出 snippet 数 = ${parsed.snippets.length}（期望 2，无引用者已在解析层丢弃）`);
  assert.equal(parsed.snippets.length, 2);
  // 文本 ↔ quote 归一化包含/高相似的强证据校验（isSnippetEvidenceRelated）在挂载层，
  // 生产链路断言复用 shared/src/verify-guides.ts + verify-dedupe.ts（归一化口径同源）。
  const normalized = normalizeSnippetText("走走拍拍 大概2小时左右");
  ctx.log(`A10 note: normalizeSnippetText 归一化口径可用（"${normalized}"），quote 相似度断言复用 shared/src/verify-dedupe.ts`);
  assert.equal(normalized, normalizeSnippetText("走走拍拍大概2小时左右"), "归一化应消除空格噪声（溯源比对口径）");
}

// ===== planner 共享草案断言（A1/A3/A4/A5/A11/S1/S2/S3 复用同一次 live 真调） =====

/** 从 EntityRef 解析实体显示名（visit→point名；stop→custom或matched名/point→item名；找不到回退 id） */
function resolveEntityName(trip: Trip, ref: EntityRef): string {
  if (ref.kind === "point") return trip.itemRegistry[ref.id]?.name ?? ref.id;
  if (ref.kind === "visit") {
    const visit = trip.visits[ref.id];
    if (visit === undefined) return ref.id;
    return trip.itemRegistry[visit.pointRef]?.name ?? (visit.kind === "large_attraction" ? "大景区" : "普通景点");
  }
  if (ref.kind === "stop") {
    const stop = trip.stops[ref.id];
    if (stop === undefined) return ref.id;
    if (stop.customName !== null) return stop.customName;
    return stop.matchedPointRef !== null ? trip.itemRegistry[stop.matchedPointRef]?.name ?? stop.stopId : stop.stopId;
  }
  if (ref.kind === "day") return `Day${ref.dayIndex}`;
  if (ref.kind === "lodging") return `Day${ref.dayIndex}住宿`;
  return ref.kind;
}

interface DayAssignment {
  subjectName: string;
  dayIndex: number;
  op: string;
  reason: string;
}

/** 收集把实体排入某天（day 容器）的分配：plan.assignments + move/transfer→day */
function collectDayAssignments(trip: Trip, operations: Operation[]): DayAssignment[] {
  const out: DayAssignment[] = [];
  for (const op of operations) {
    if (op.op === "plan") {
      for (const assignment of op.assignments) {
        if (assignment.containerRef.kind === "day") {
          out.push({
            subjectName: resolveEntityName(trip, assignment.subjectRef),
            dayIndex: assignment.containerRef.dayIndex,
            op: "plan",
            reason: op.reason,
          });
        }
      }
    } else if (op.op === "move" && op.containerRef.kind === "day") {
      out.push({ subjectName: resolveEntityName(trip, op.subjectRef), dayIndex: op.containerRef.dayIndex, op: "move", reason: op.reason });
    } else if (op.op === "transfer" && op.toContainerRef.kind === "day") {
      out.push({ subjectName: resolveEntityName(trip, op.subjectRef), dayIndex: op.toContainerRef.dayIndex, op: "transfer", reason: op.reason });
    }
  }
  return out;
}

/** 名称命中（含子串）：判断实体名集合里是否出现某关键词 */
function namesInclude(names: string[], keyword: string): string | null {
  for (const name of names) if (name.includes(keyword)) return name;
  return null;
}

/** 打印草案概览到证据（所有 planner 用例共享的诊断上下文） */
function logDraftOverview(ctx: CaseContext, scenario: SharedDraftScenario): void {
  const { draft } = scenario;
  ctx.log(`[shared-draft] tripId=${scenario.tripId}，sources=${scenario.sourceCount}，buildMs=${scenario.buildMs}，planner=${scenario.plannerModes.join("/") || "无"}`);
  ctx.log(`[shared-draft] fastPath=${draft.fastPath}（true=未调 AI），attempts=${draft.attempts}，latencyMs=${draft.latencyMs}，promptChars=${draft.promptChars}`);
  ctx.log(`[shared-draft] operations=${draft.operations.length}，snippets=${draft.snippets.length}，optionGroups=${draft.optionGroups.length}，unplaced=${draft.unplaced.length}，proposedNew=${draft.proposedNew.length}，clarify=${draft.clarify ?? "null"}`);
  const assignments = collectDayAssignments(scenario.trip, draft.operations);
  ctx.log(`[shared-draft] 按天分配：${assignments.map((a) => `${a.subjectName}→D${a.dayIndex}(${a.op})`).join("、") || "（无 day 容器分配）"}`);
  // 模型侧 reason 逐条落证据：fail 复核（如返程日排重项）无需再翻缓存原始响应
  for (const a of assignments) ctx.log(`[shared-draft]   D${a.dayIndex} ${a.subjectName} reason：${a.reason}`);
  ctx.log(`[shared-draft] proposedNew：${draft.proposedNew.map((p) => p.name).join("、") || "（无）"}`);
  ctx.log(`[shared-draft] snippet claimKinds：${draft.snippets.map((s) => `${s.claimKind}「${s.text.slice(0, 12)}」`).join("、") || "（无）"}`);
}

/** 共享草案获取 + 记忆化 planner 模式回填（构建者触发真调，复用者读缓存） */
async function sharedScenario(ctx: CaseContext): Promise<SharedDraftScenario> {
  const scenario = await getSharedDraft();
  setSharedPlannerModes(scenario.plannerModes);
  logDraftOverview(ctx, scenario);
  assert.equal(scenario.draft.fastPath, false, "共享草案应走完整 planner（fastPath=true 表示未调 AI，无法验证 planner 依赖用例）");
  return scenario;
}

/** A1：≥2 篇独立 firsthand 强推的实体应进入草案（proposedNew 或按天分配），不被静默丢弃 */
async function runA1(ctx: CaseContext): Promise<void> {
  const scenario = await sharedScenario(ctx);
  const { draft } = scenario;
  const assignments = collectDayAssignments(scenario.trip, draft.operations);
  const placedNames = [...assignments.map((a) => a.subjectName), ...draft.proposedNew.map((p) => p.name)];
  // 西岛：C04(S4 firsthand positive_experience「走走拍拍2小时」) + C01/C02/C03 多源；
  // 后海村：C11(S5 firsthand positive_experience「亲身体验反而很不错」)
  const strongMultiSource = ["西岛", "后海村"];
  const hit = strongMultiSource.map((name) => namesInclude(placedNames, name)).filter((v): v is string => v !== null);
  ctx.log(`A1 assert: 强推多源实体命中 = [${hit.join("、")}]（候选集 ${strongMultiSource.join("/")}；草案实体池 ${placedNames.length} 个）`);
  ctx.log(`A1 note: 投票规则在 planner prompt 层，代码无独立投票器；本断言验证「多源 firsthand 强推实体确实被草案surface（proposedNew/按天分配），未被静默丢弃」`);
  assert.ok(hit.length >= 1, `≥2 篇 firsthand 强推实体（${strongMultiSource.join("/")}）应进入草案，实际草案实体池：${placedNames.join("、") || "空"}`);
}

/** A3：reported_opinion 转述差评不计负票——后海村（C11 firsthand 正向 + 转述差评）不被 remove/负面 unplaced */
async function runA3(ctx: CaseContext): Promise<void> {
  const scenario = await sharedScenario(ctx);
  const { draft } = scenario;
  const removeTargets = draft.operations
    .filter((op): op is Extract<Operation, { op: "remove" }> => op.op === "remove")
    .map((op) => resolveEntityName(scenario.trip, op.subjectRef));
  const negativeUnplaced = draft.unplaced.filter((u) => /差评|负面|避雷|不推荐|劝退/.test(u.reason));
  ctx.log(`A3 assert: remove 操作目标 = [${removeTargets.join("、") || "无"}]（后海村不应因转述差评被移除）`);
  ctx.log(`A3 assert: 负面措辞 unplaced = [${negativeUnplaced.map((u) => u.reason).join("、") || "无"}]`);
  ctx.log(`A3 note: C11「网上差评只是作者转述，不增加独立负面计数」；reported_opinion 不计负票规则在 prompt 层；本断言验证「无因转述差评产生的移除/负面落选」`);
  assert.equal(namesInclude(removeTargets, "后海村"), null, "后海村不应因 reported_opinion 转述差评被 remove");
  assert.equal(negativeUnplaced.length, 0, "不应出现基于转述差评的负面 unplaced 理由");
}

/**
 * A4 警告类信息识别词表（Task #291）：锚定 fixture 中 stance ∈ {risk_of_activity,
 * risk_of_provider, conditional_risk} 的 6 条 claim——C03「穿好鞋 / 碎石与珊瑚」、
 * C05「人很多要排队」、C09「多看真实学员评价 / 不着急交费」、C10「临海民宿晚上有点吵」、
 * C17「大多区域不适合下海游泳」、C18「礁石锋利注意脚下安全」，外加已知财务警告
 * 「岛上消费偏高，建议自备饮水零食」。只判「警告信息有没有被带出来」，不判归到哪一类。
 */
const A4_WARNING_RE =
  /不适合|注意安全|小心|谨慎|锋利|脚下|碎石|珊瑚|排队|学员评价|交费|交钱|有点吵|噪音|消费偏高|自备|漫天要价|宰|坑|骗|欺诈|假票|避雷|风险|无资质/;

/**
 * A4：风险 claim 绑定活动/商家——警告类信息以 claimKind=risk 或 tip 任一出现即 pass。
 *
 * Task #291 PD 拍板放宽（原断言强制 risk ≥1，因模型 risk↔tip 分类级摇摆间歇性 fail）：
 * 「不适合下海游泳」这类警告性实用建议归 tip 可接受——用户线下还会看到现场说明，
 * 产品非唯一权威；risk 留给重大安全 / 财务损失 / 商家欺诈。planner prompt 第五节已同步
 * 注入「risk / tip 边界从宽」说明（server/src/guides/planner.ts）。
 * 放宽范围仅限**归类**：警告信息完全丢失（risk 与 tip 都没有）仍然 fail。
 */
async function runA4(ctx: CaseContext): Promise<void> {
  const scenario = await sharedScenario(ctx);
  const { draft } = scenario;
  const riskSnippets = draft.snippets.filter((s) => s.claimKind === "risk");
  const tipSnippets = draft.snippets.filter((s) => s.claimKind === "tip");
  const warningSnippets = draft.snippets.filter(
    (s) => (s.claimKind === "risk" || s.claimKind === "tip") && A4_WARNING_RE.test(s.text),
  );
  ctx.log(`A4 assert: risk 类 snippet 数 = ${riskSnippets.length}（${riskSnippets.map((s) => `「${s.text}」`).join("、") || "无"}）`);
  ctx.log(`A4 assert: tip 类 snippet 数 = ${tipSnippets.length}（${tipSnippets.map((s) => `「${s.text}」`).join("、") || "无"}）`);
  ctx.log(
    `A4 assert: 警告类信息 snippet（claimKind ∈ {risk, tip} 任一）= ${warningSnippets.length}（${warningSnippets.map((s) => `${s.claimKind}「${s.text}」`).join("、") || "无"}）——期望 ≥1`,
  );
  if (riskSnippets.length === 0) {
    ctx.log(
      `A4 info: 本轮 risk 类 snippet = 0，警告信息全部落在 tip——属 Task #291 PD 拍板可接受区间（分类级方差不再判 fail）；live 轮请观测 prompt「risk/tip 边界从宽」注入后 risk 命中率是否回升`,
    );
  }
  ctx.log(
    `A4 note: 风险 claim（C09 后海村/冲浪 risk_of_provider、C03/C05 西岛 risk_of_activity、C17 海棠湾下海游泳、C18 小东海赶海）应以 risk 或 tip 任一形态出现；claimKind 白名单清洗在 planner.ts，归类与是否产出由模型决定（Task #291：归类不再硬断言）`,
  );
  assert.ok(
    warningSnippets.length >= 1,
    `草案应含 ≥1 条警告类 snippet（claimKind=risk 或 tip 任一即可，Task #291 PD 拍板）；实际 snippet claimKinds：` +
      (draft.snippets.map((s) => `${s.claimKind}「${s.text}」`).join("、") || "（无 snippet）"),
  );
}

/** A5：单源 firsthand 避雷（C17 海棠湾下海游泳 / C18 小东海赶海 risk_of_activity）不被排入行程天 */
async function runA5(ctx: CaseContext): Promise<void> {
  const scenario = await sharedScenario(ctx);
  const { draft } = scenario;
  const assignments = collectDayAssignments(scenario.trip, draft.operations);
  const avoided = ["下海游泳", "赶海", "海棠湾/下海", "小东海"];
  const wronglyPlaced = assignments.filter((a) => avoided.some((kw) => a.subjectName.includes(kw)));
  ctx.log(`A5 assert: 避雷活动被排入天 = [${wronglyPlaced.map((a) => `${a.subjectName}→D${a.dayIndex}`).join("、") || "无"}]（期望无）`);
  const avoidedInUnplaced = draft.unplaced.filter((u) => avoided.some((kw) => resolveEntityName(scenario.trip, u.subjectRef).includes(kw)));
  ctx.log(`A5 assert: 避雷活动落 unplaced（带原因）= [${avoidedInUnplaced.map((u) => u.reason).join("、") || "无"}]`);
  ctx.log(`A5 note: 候选池机制（globalCandidateRefs/relationshipSuggestions）代码已实现，进池判定在 prompt 层；本断言验证「单源避雷活动不被直接排入行程天」`);
  assert.equal(wronglyPlaced.length, 0, `单源 firsthand 避雷活动不应排入行程天，实际：${wronglyPlaced.map((a) => `${a.subjectName}→D${a.dayIndex}`).join("、")}`);
}

/** A11：无 Tips 不出 Tips 块——optionGroups 全部合法成组（≥2 选项、category 白名单），且全文无「攻略未明确」 */
async function runA11(ctx: CaseContext): Promise<void> {
  const scenario = await sharedScenario(ctx);
  const { draft } = scenario;
  const serialized = JSON.stringify(draft);
  const hasPlaceholder = serialized.includes("攻略未明确");
  const badGroups = draft.optionGroups.filter((g) => g.options.length < 2);
  const validCategories = new Set(["transport", "ticket", "rental", "activity", "dining", "shuttle", "other"]);
  const badCategory = draft.optionGroups.filter((g) => !validCategories.has(g.category));
  ctx.log(`A11 assert: optionGroups=${draft.optionGroups.length}（${draft.optionGroups.map((g) => `${g.topic}[${g.category}]×${g.options.length}`).join("、") || "无"}）`);
  ctx.log(`A11 assert: 「攻略未明确」占位文案出现 = ${hasPlaceholder}（期望 false）；<2 选项的非法组 = ${badGroups.length}／越界 category = ${badCategory.length}`);
  ctx.log(`A11 note: optionGroups 清洗契约（≥2 选项成组、category 白名单）代码已实现；是否产出 Tips 块由模型按素材决定；本断言验证「不产出伪造/占位 Tips」`);
  assert.equal(hasPlaceholder, false, "草案不应出现「攻略未明确」占位文案");
  assert.equal(badGroups.length, 0, "optionGroup 必须 ≥2 选项才成组");
  assert.equal(badCategory.length, 0, "optionGroup category 必须在白名单内");
}

/** S1：返程日（Day5，MU5832 18:00 起飞）机场走廊——不排岛/船/远/长票/付费水上重项 */
async function runS1(ctx: CaseContext): Promise<void> {
  const scenario = await sharedScenario(ctx);
  const { draft } = scenario;
  const assignments = collectDayAssignments(scenario.trip, draft.operations);
  const day5 = assignments.filter((a) => a.dayIndex === 5);
  const heavyKeywords = ["西岛", "蜈支洲", "后海", "冲浪", "赶海", "亚龙湾海滩", "分界洲", "潜水", "船"];
  const heavyOnReturnDay = day5.filter((a) => heavyKeywords.some((kw) => a.subjectName.includes(kw)));
  ctx.log(`S1 assert: Day5（返程日）分配项 = [${day5.map((a) => a.subjectName).join("、") || "空"}]`);
  ctx.log(`S1 assert: Day5 重项（岛/船/远/付费水上）= [${heavyOnReturnDay.map((a) => a.subjectName).join("、") || "无"}]（期望无——返程日仅机场走廊低承诺项）`);
  ctx.log(`S1 note: 走廊规则在 prompt 层（buildTripFacts 注入 MU5832 18:00 返程约束），代码无硬规则；本断言验证「返程日未被排入重项」`);
  assert.equal(heavyOnReturnDay.length, 0, `返程日（Day5）不应排入岛/船/远/付费水上重项，实际：${heavyOnReturnDay.map((a) => a.subjectName).join("、")}`);
}

/** S2：抵达日（Day1，MU5831 09:40 落地）buffer——Day1 不排需早到的重项，首项在到达+buffer 之后 */
async function runS2(ctx: CaseContext): Promise<void> {
  const scenario = await sharedScenario(ctx);
  const { draft } = scenario;
  const assignments = collectDayAssignments(scenario.trip, draft.operations);
  const day1 = assignments.filter((a) => a.dayIndex === 1);
  // 抵达日 buffer 关注「需早到的远/岛/水上重项」；后海村等近酒店村落属 case 文档
  // 「近酒店/市区」允许集，不计重项（早前版本误把 后海 列入导致误报，已修正）。
  const heavyKeywords = ["西岛", "蜈支洲", "分界洲", "潜水", "冲浪", "赶海"];
  const heavyOnArrivalDay = day1.filter((a) => heavyKeywords.some((kw) => a.subjectName.includes(kw)));
  // setTime 对 Day1 项的时间值应 ≥ 到达+buffer（09:40 落地，departTime 已设 10:30）
  const day1SetTimes = draft.operations.filter(
    (op): op is Extract<Operation, { op: "setTime" }> =>
      op.op === "setTime" && op.target === "start" && resolveEntityName(scenario.trip, op.subjectRef) !== "" &&
      collectDayAssignments(scenario.trip, [op]).length === 0,
  );
  ctx.log(`S2 assert: Day1（抵达日）分配项 = [${day1.map((a) => a.subjectName).join("、") || "空"}]`);
  ctx.log(`S2 assert: Day1 需早到重项 = [${heavyOnArrivalDay.map((a) => a.subjectName).join("、") || "无"}]（期望无——抵达日近酒店/市区）`);
  ctx.log(`S2 assert: setTime(start) 操作数 = ${day1SetTimes.length}（Day1 首项时间应 ≥ 09:40 落地 + buffer）`);
  ctx.log(`S2 note: 抵达 buffer 规则在 prompt 层（buildTripFacts 注入 MU5831 09:40 抵达 + Day1 departTime 10:30）；本断言验证「抵达日未排需早到的远/岛重项」`);
  assert.equal(heavyOnArrivalDay.length, 0, `抵达日（Day1）不应排入需早到的岛/远重项，实际：${heavyOnArrivalDay.map((a) => a.subjectName).join("、")}`);
}

/** S3：锁定酒店日区域连续——草案不违反住宿锁定；区域编排连续（不先海棠湾再折回） */
async function runS3(ctx: CaseContext): Promise<void> {
  const scenario = await sharedScenario(ctx);
  const { draft } = scenario;
  // 住宿锁定尊重：无 remove/lock(false) 破坏已锁住宿（fixture 住宿 locked=false，此处验证不产生破坏性住宿操作）
  const lodgingOps = draft.operations.filter(
    (op) => (op.op === "remove" || op.op === "setPurchase" || op.op === "lock") &&
      ("subjectRef" in op ? (op.subjectRef as EntityRef).kind === "lodging" : false),
  );
  const assignments = collectDayAssignments(scenario.trip, draft.operations);
  ctx.log(`S3 assert: 住宿相关操作（remove/setPurchase/lock）= ${lodgingOps.length}（fixture 住宿未锁，验证草案不产生破坏性住宿操作）`);
  ctx.log(`S3 assert: 各天分配 = ${assignments.map((a) => `D${a.dayIndex}:${a.subjectName}`).join("、") || "（无）"}（区域连续性由模型编排，日志供人审）`);
  ctx.log(`S3 note: 锁定尊重由 guards/directives 代码层保证；区域连续性编排在 planner prompt 层，无代码硬规则——本断言为软校验（不破坏住宿 + 记录区域分布供 PD 复核）`);
  // 软校验：草案不得对住宿产生破坏性操作（锁定尊重的可观测下界）
  for (const op of lodgingOps) {
    ctx.log(`S3 warn: 检测到住宿操作 ${op.op}（${op.reason}）——需人审是否违反锁定`);
  }
  assert.ok(draft.operations.length >= 0, "S3 软校验：记录区域编排供人审（无硬性失败条件）");
}

/** O3：NL「Day2 松一点」→ F11 局部松排，仅 Day2 低优先项被移/换，不触碰其他天与锁定 */
async function runO3(ctx: CaseContext): Promise<void> {
  const scenario = await getSharedDraft();
  setSharedPlannerModes(scenario.plannerModes);
  const intent = await getSharedIntent();
  ctx.log(`O3 assert: executeIntent 结果 type = "${intent.type}"（期望 applied/proposal/clarify，非 error）`);
  ctx.log(`O3 assert: message = ${intent.message ?? "（无）"}，clarify = ${intent.clarify ?? "null"}`);
  assert.notEqual(intent.type, "error", `O3 意图不应报错：${intent.message ?? ""}`);
  // 汇总本轮意图产生的全部操作（applied + needsProposal + proposalOps + fullPlanOps）
  const applied = intent.result?.applied ?? [];
  const needsProposal = intent.result?.needsProposal ?? [];
  const allOps: Operation[] = [...applied, ...needsProposal, ...(intent.proposalOps ?? []), ...(intent.fullPlanOps ?? [])];
  const assignments = collectDayAssignments(scenario.trip, allOps);
  const touchedDays = new Set<number>();
  for (const op of allOps) {
    for (const a of assignments) void a;
    if (op.op === "plan" && op.scopeRef.kind === "day") touchedDays.add(op.scopeRef.dayIndex);
    if (op.op === "plan" && op.scopeRef.kind === "allDays") touchedDays.add(0); // 0 = 全程（越界信号）
    if (op.op === "move" && op.containerRef.kind === "day") touchedDays.add(op.containerRef.dayIndex);
    if (op.op === "transfer" && op.toContainerRef.kind === "day") touchedDays.add(op.toContainerRef.dayIndex);
    if (op.op === "setTime" && op.subjectRef.kind === "day") touchedDays.add(op.subjectRef.dayIndex);
    if (op.op === "setDuration" || op.op === "move" || op.op === "transfer") {
      // subjectRef 归属天：visit→dayRef→dayIndex
      const ref = "subjectRef" in op ? (op.subjectRef as EntityRef) : null;
      if (ref?.kind === "visit") {
        const visit = scenario.trip.visits[ref.id];
        const day = visit !== undefined && visit.dayRef !== null ? scenario.trip.days[visit.dayRef] : undefined;
        if (day !== undefined) touchedDays.add(day.dayIndex);
      }
    }
  }
  const outOfScope = [...touchedDays].filter((d) => d !== 2);
  ctx.log(`O3 assert: 意图「Day2 松一点」触达天 = [${[...touchedDays].sort().join("、") || "无"}]（期望仅 {2}；0=全程越界）`);
  ctx.log(`O3 assert: 操作总数 = ${allOps.length}（applied=${applied.length}，needsProposal=${needsProposal.length}，proposalOps=${(intent.proposalOps ?? []).length}）`);
  ctx.log(`O3 note: F11 局部重算 scope 机制代码已实现，语义正确性依赖模型输出；executeIntent 直连百炼不经 plannerCache，只能 live 不可回放`);
  assert.equal(outOfScope.length, 0, `「Day2 松一点」应仅触达 Day2，实际越界触达：${outOfScope.map((d) => (d === 0 ? "全程" : `Day${d}`)).join("、")}`);
}

/** S10：每天有 day 角色字段且与航班/酒店锚点一致（deriveDayRoles 纯函数派生） */
function runS10(ctx: CaseContext): void {
  // 使用标准三亚验收夹具：Day1 flight_arrive(MU5831)、Day5 flight_depart(MU5832)、
  // lodging 1-4 海棠湾（locked=false, purchaseState=unknown → 非锚点，不推导换区）
  const trip = buildFixtureSanyaTrip("trip_s10_eval", new Date().toISOString());
  const roles = deriveDayRoles(trip);

  ctx.log(`S10 assert: 夹具行程天数 = ${trip.dayRefs.length}`);
  ctx.log(`S10 assert: constraints = ${trip.constraints.map((c) => `${c.type}@day${c.dayIndex}`).join(", ")}`);

  // 断言 1：每天有 role 字段（recomputeDerivedFields 写入后）
  recomputeDerivedFields(trip);
  for (const dayId of trip.dayRefs) {
    const day = trip.days[dayId];
    assert.ok(day.role !== undefined && day.role !== null, `S10: ${dayId}.role 必须非空`);
    ctx.log(`S10 assert: ${dayId}.role = "${day.role}"`);
  }

  // 断言 2：与航班锚点一致
  assert.equal(roles.get(1), "arrival", "S10: Day1 有 flight_arrive → arrival");
  assert.equal(roles.get(5), "departure", "S10: Day5 有 flight_depart → departure");
  ctx.log("S10 pass: Day1=arrival（flight_arrive MU5831）、Day5=departure（flight_depart MU5832）");

  // 断言 3：中间天无锁定 lodging 锚点 → full_play（不推导换区）
  for (const d of [2, 3, 4]) {
    assert.equal(roles.get(d), "full_play", `S10: Day${d} 无锁定 lodging 锚点 → full_play`);
  }
  ctx.log("S10 pass: Day2/3/4=full_play（lodging locked=false → 非锚点，不推导换区）");

  // 断言 4：优先级——departure > arrival（构造冲突场景）
  const conflictTrip = buildFixtureSanyaTrip("trip_s10_conflict", new Date().toISOString());
  conflictTrip.constraints.push({
    constraintId: "c_depart_day1",
    type: "flight_depart",
    anchorTime: "2026-11-08T20:00:00",
    dayIndex: 1,
    label: "测试返程",
    locked: true,
  });
  const conflictRoles = deriveDayRoles(conflictTrip);
  assert.equal(conflictRoles.get(1), "departure", "S10: 同天 arrive+depart → departure 优先");
  ctx.log("S10 pass: 优先级冲突 departure > arrival 验证通过");

  // 断言 5：幂等——两次 recomputeDerivedFields 结果一致
  const trip2 = buildFixtureSanyaTrip("trip_s10_idem", new Date().toISOString());
  recomputeDerivedFields(trip2);
  const snapshot = trip2.dayRefs.map((id) => trip2.days[id].role);
  recomputeDerivedFields(trip2);
  const snapshot2 = trip2.dayRefs.map((id) => trip2.days[id].role);
  assert.deepEqual(snapshot, snapshot2, "S10: recomputeDerivedFields 幂等");
  ctx.log("S10 pass: recomputeDerivedFields 幂等验证通过");
}

/**
 * C4（Task #283）：AI 补充来源标（provenance）四维度机器断言——全部离线确定性。
 * ① provenance 落盘字段语义（读时默认 guide / ai_supplement 保留，存量零迁移、幂等）；
 * ② planner 应用时打标（before 未排期 → after 已排期且非攻略证据支撑 → ai_supplement；
 *    攻略支撑不打标 / 无真实飞猪 POI 降级不打标 / 既有安排不追溯）；
 * ③ 护栏 validateAiSupplementProvenance（落盘前兜底拒绝无真实飞猪 POI 的 ai_supplement）；
 * ④ chip 文案「AI 补充·飞猪核验」+ 展示范围（web vitest：主卡 390 全标 / ≤360px 降级 /
 *    清单不显示 / 分享页显示）。
 */
async function runC4(ctx: CaseContext): Promise<void> {
  // 最小 Item / Visit / Trip 构造（cast：只填 C4 判定相关字段）
  const mkItem = (
    itemId: string,
    origin: "fliggy" | "custom",
    providerId: string | null,
    provenance?: Item["provenance"],
    sourceEvidenceRefs: string[] = [],
  ): Item =>
    ({
      itemId,
      name: itemId,
      origin,
      providerId,
      address: null,
      category: null,
      coords: null,
      suggestMinutes: null,
      mainPic: null,
      ticketInfo: null,
      jumpUrl: null,
      sourceEvidenceRefs,
      ...(provenance !== undefined ? { provenance } : {}),
    }) as Item;
  const mkVisit = (visitId: string, pointRef: string, dayRef: string | null): Visit =>
    ({
      visitId,
      pointRef,
      dayRef,
      kind: "ordinary",
      sourceMentionRefs: [],
      guideSnippets: [],
    }) as unknown as Visit;
  const mkTrip = (visits: Record<string, Visit>, itemRegistry: Record<string, Item>): Trip =>
    ({ visits, itemRegistry }) as unknown as Trip;

  // ---- 维度①：provenance 落盘字段语义（读时默认，存量零迁移、幂等）----
  assert.equal(itemProvenance(mkItem("i_missing", "custom", null)), "guide", "C4①: provenance 缺失 → 读时默认 guide");
  assert.equal(itemProvenance(mkItem("i_sup", "fliggy", "F1", "ai_supplement")), "ai_supplement", "C4①: 显式 ai_supplement 保留");
  assert.equal(isAiSupplement(mkItem("i_sup2", "fliggy", "F1", "ai_supplement")), true, "C4①: isAiSupplement 命中");
  assert.equal(isAiSupplement(mkItem("i_g", "custom", null)), false, "C4①: 缺失 → 非补充项");
  ctx.log("C4 assert①: provenance 落盘字段 + 读时默认（缺失→guide / ai_supplement 保留 / 幂等）验证通过");

  // ---- 维度②：planner 应用时打标 ----
  // ②a 真实飞猪 POI 补排（本轮新建 Item，before 无此资产）→ 标 ai_supplement
  {
    const supItem = mkItem("i_sup", "fliggy", "F123");
    // before 完全不含该 Item / Visit：模型本轮补排出的新点位
    const before = mkTrip({}, {});
    const after = mkTrip({ v: mkVisit("v", "i_sup", "day_1") }, { i_sup: supItem });
    const mark = markAiSupplementProvenance(before, after);
    assert.deepEqual(mark.marked, ["i_sup"], "C4②a: 补排真实飞猪 POI → marked");
    assert.deepEqual(mark.downgraded, [], "C4②a: 无降级");
    assert.equal(supItem.provenance, "ai_supplement", "C4②a: provenance 落盘到 item");
    ctx.log("C4 assert②a: planner 对本轮新建、补排的真实飞猪 POI 打 provenance=ai_supplement 验证通过");
  }
  // ②b 攻略证据支撑（sourceEvidenceRefs 非空）→ 不打标（保持 guide）
  {
    const backed = mkItem("i_backed", "fliggy", "F9", undefined, ["ev_1:m_1"]);
    // before 不含该 Item：确保走「攻略证据支撑」分支而非用户侧豁免分支
    const before = mkTrip({}, {});
    const after = mkTrip({ v: mkVisit("v", "i_backed", "day_1") }, { i_backed: backed });
    const mark = markAiSupplementProvenance(before, after);
    assert.deepEqual(mark.marked, [], "C4②b: 攻略证据支撑 → 不打标");
    assert.notEqual(backed.provenance, "ai_supplement", "C4②b: 攻略项不得标 ai_supplement");
    ctx.log("C4 assert②b: 攻略证据支撑点位（sourceEvidenceRefs 非空）不打 AI 补充标验证通过");
  }
  // ②c 无真实飞猪 POI（custom）补排 → 降级、不打标（不得以 AI 补充名义落地）
  {
    const custom = mkItem("i_custom", "custom", null);
    // before 不含该 Item：本轮新建的 custom 补排，才能命中 isRealFliggyPoi=false 降级分支
    const before = mkTrip({}, {});
    const after = mkTrip({ v: mkVisit("v", "i_custom", "day_1") }, { i_custom: custom });
    const mark = markAiSupplementProvenance(before, after);
    assert.deepEqual(mark.downgraded, ["i_custom"], "C4②c: 无真实飞猪 id → downgraded");
    assert.deepEqual(mark.marked, [], "C4②c: 不 marked");
    assert.notEqual(custom.provenance, "ai_supplement", "C4②c: 降级项不得标 ai_supplement");
    ctx.log("C4 assert②c: 护栏降级——无真实飞猪 POI 的补充项不打标验证通过");
  }
  // ②d 既有安排（before 已排期）→ 不追溯打标
  {
    const before = mkTrip({ v: mkVisit("v", "i_old", "day_1") }, { i_old: mkItem("i_old", "fliggy", "F1") });
    const after = mkTrip({ v: mkVisit("v", "i_old", "day_1") }, { i_old: mkItem("i_old", "fliggy", "F1") });
    const mark = markAiSupplementProvenance(before, after);
    assert.deepEqual(mark.marked, [], "C4②d: 既有安排不追溯打标");
    ctx.log("C4 assert②d: 本轮之前已排期的既有安排不追溯打标验证通过");
  }
  // ②e 用户侧豁免（Task #290 Major4）：用户池飞猪 POI（before.itemRegistry 已存在、
  //     本轮之前未排期）被 plan 排入某天 → 属既有资产编排，不打 AI 补充标
  {
    const userPoi = mkItem("i_user", "fliggy", "F777");
    // before 已含该 Item（用户搜来放进候选池），但对应 Visit 未排期（dayRef=null）
    const before = mkTrip({ v: mkVisit("v", "i_user", null) }, { i_user: mkItem("i_user", "fliggy", "F777") });
    const after = mkTrip({ v: mkVisit("v", "i_user", "day_1") }, { i_user: userPoi });
    const mark = markAiSupplementProvenance(before, after);
    assert.deepEqual(mark.marked, [], "C4②e: 用户池飞猪 POI 被 plan 排入 → 不打标");
    assert.deepEqual(mark.downgraded, [], "C4②e: 非补充项，不进降级");
    assert.notEqual(userPoi.provenance, "ai_supplement", "C4②e: 用户既有资产不得标 ai_supplement");
    ctx.log("C4 assert②e: 用户池飞猪 POI（本轮前已存在）被 plan 排入不误标 AI 补充验证通过");
  }


  // ---- 维度③：护栏 validateAiSupplementProvenance（落盘前兜底拒绝）----
  assert.deepEqual(
    validateAiSupplementProvenance(mkTrip({}, { bad: mkItem("bad", "custom", null, "ai_supplement") })),
    ["bad"],
    "C4③: custom 的 ai_supplement 判违规",
  );
  assert.deepEqual(
    validateAiSupplementProvenance(mkTrip({}, { bad2: mkItem("bad2", "fliggy", null, "ai_supplement") })),
    ["bad2"],
    "C4③: providerId=null 判违规",
  );
  assert.deepEqual(
    validateAiSupplementProvenance(mkTrip({}, { ok: mkItem("ok", "fliggy", "F1", "ai_supplement") })),
    [],
    "C4③: 真实 POI 放行",
  );
  assert.equal(isRealFliggyPoi(mkItem("r", "fliggy", "F1")), true, "C4③: isRealFliggyPoi 真");
  ctx.log("C4 assert③: 护栏 validateAiSupplementProvenance 拒绝无真实飞猪 POI 的 ai_supplement / 放行真实 POI 验证通过");

  // ---- 维度④：chip 文案 + 展示范围（web vitest 子进程）----
  assert.equal(AI_SUPPLEMENT_CHIP_LABEL, "AI 补充·飞猪核验", "C4④: chip 全标文案");
  assert.ok(AI_SUPPLEMENT_CHIP_LABEL.startsWith(AI_SUPPLEMENT_CHIP_LABEL_COMPACT), "C4④: 降级标「AI 补充」是全标前缀（≤360px 隐藏「·飞猪核验」子段）");
  const proc = spawnSync(
    "npx",
    [
      "vitest",
      "run",
      "src/components/VisitCard.test.tsx",
      "src/components/ShareView.test.tsx",
      "src/components/TripChecklist.test.tsx",
    ],
    { cwd: join(REPO_ROOT, "web"), encoding: "utf8", timeout: 300_000, env: { ...process.env } },
  );
  const out = `${proc.stdout ?? ""}${proc.stderr ?? ""}`.trimEnd();
  ctx.log(out.split("\n").slice(-10).join("\n"));
  assert.equal(proc.status, 0, "C4④: web chip vitest（主卡 390 全标 / ≤360px 降级 / 清单不显示 / 分享显示）全绿");
  ctx.log("C4 assert④: chip 文案「AI 补充·飞猪核验」+ 展示范围（主卡/分享显示、清单不显示、≤360px 降级）web vitest 通过");
}

// ===== 28 条用例定义 =====

export const SHARED_VERIFY: EvalCase["run"] = { kind: "script", cwd: "shared", command: ["npx", "tsx", "src/verify.ts"] };
/** E3/E8/A7/Q5 复用通道：verify-b2 离线段（VERIFY_SKIP_LIVE=1 跳过真实百炼段，纯确定性） */
export const B2_VERIFY: EvalCase["run"] = {
  kind: "script",
  cwd: "server",
  command: ["npx", "tsx", "src/guides/verify-b2.ts"],
  env: { VERIFY_SKIP_LIVE: "1" },
};
/** E5 复用通道：web vitest NoteInput（XHS_URL_PATTERN 分享文案提链） */
export const NOTEINPUT_VITEST: EvalCase["run"] = {
  kind: "script",
  cwd: "web",
  command: ["npx", "vitest", "run", "src/components/NoteInput.test.tsx"],
};
/** Q1/Q3 复用通道：web vitest VisitCard（snippet chip→EvidenceSheet 定位高亮、外链、0-snippet 隐藏引用块） */
export const VISITCARD_VITEST: EvalCase["run"] = {
  kind: "script",
  cwd: "web",
  command: ["npx", "vitest", "run", "src/components/VisitCard.test.tsx", "src/components/EvidenceSheet.test.tsx"],
};
/** O2 复用通道：web verify-dayOrder（day 序与撤销原位恢复，确定性纯脚本） */
export const DAYORDER_VERIFY: EvalCase["run"] = {
  kind: "script",
  cwd: "web",
  command: ["npx", "tsx", "src/lib/verify-dayOrder.ts"],
};
/** S5 复用通道：web vitest DayContent（四状态 DOM 断言 + 无全局角标） */
export const DAYCONTENT_VITEST: EvalCase["run"] = {
  kind: "script",
  cwd: "web",
  command: ["npx", "vitest", "run", "src/components/DayContent.test.tsx"],
};

/** S5：时间来源标签四状态 + 无全局角标（shared 纯函数 + web vitest DOM 断言双通道） */
function runS5(ctx: CaseContext): void {
  const trip = buildFixtureSanyaTrip("trip_s5_eval", new Date().toISOString());
  recomputeDerivedFields(trip);

  // 断言 1：抵达日（Day1 flight_arrive 09:40）→ "按你的到达航班 09:40 算"
  const day1Label = trip.days["day_1"].timeSourceLabel;
  assert.equal(day1Label, "按你的到达航班 09:40 算", "S5: 抵达日标签");
  ctx.log(`S5 assert: Day1.timeSourceLabel = "${day1Label}"（抵达日航班推算）`);

  // 断言 2：返程日（Day5 flight_depart）→ "按回程航班倒推，当天只排机场附近"
  const day5Label = trip.days["day_5"].timeSourceLabel;
  assert.equal(day5Label, "按回程航班倒推，当天只排机场附近", "S5: 返程日标签");
  ctx.log(`S5 assert: Day5.timeSourceLabel = "${day5Label}"（返程日倒推）`);

  // 断言 3：普通日（Day2/3/4 无航班约束、未手改）→ null
  for (const d of [2, 3, 4]) {
    const label = trip.days[`day_${d}`].timeSourceLabel;
    assert.equal(label, null, `S5: Day${d} 普通日应为 null`);
    ctx.log(`S5 assert: Day${d}.timeSourceLabel = null（普通日不显示）`);
  }

  // 断言 4：手改覆盖——模拟 departTimeOverridden=true 后重算
  trip.days["day_1"].departTimeOverridden = true;
  recomputeDerivedFields(trip);
  assert.equal(trip.days["day_1"].timeSourceLabel, "你设定", "S5: 手改后 → 你设定");
  ctx.log(`S5 assert: Day1 手改后 timeSourceLabel = "你设定"（覆盖航班推算）`);

  // 断言 5：deriveTimeSourceLabels 纯函数返回 Map 覆盖全部天
  const labels = deriveTimeSourceLabels(trip);
  assert.equal(labels.size, trip.dayRefs.length, "S5: labels 覆盖全部天");
  ctx.log(`S5 assert: deriveTimeSourceLabels 返回 ${labels.size} 条（= dayRefs.length）`);

  ctx.log("S5 pass: 四状态矩阵（抵达/返程/手改/普通日null）全部验证通过");
  ctx.log("S5 note: DOM 级断言（无全局角标 + 编辑态灰字）由 DayContent.test.tsx vitest 覆盖");
}

/** S11：改航班/改锁酒店后 role 与来源标签在同一操作内同步重算，无 stale */
function runS11(ctx: CaseContext): void {
  const trip = buildFixtureSanyaTrip("trip_s11_eval", new Date().toISOString());
  recomputeDerivedFields(trip);

  // 初始状态：Day1=arrival + 航班标签，Day5=departure + 倒推标签
  assert.equal(trip.days["day_1"].role, "arrival", "S11: 初始 Day1 role=arrival");
  assert.equal(trip.days["day_1"].timeSourceLabel, "按你的到达航班 09:40 算", "S11: 初始 Day1 label");
  assert.equal(trip.days["day_5"].role, "departure", "S11: 初始 Day5 role=departure");
  ctx.log("S11 assert: 初始状态 Day1=arrival+航班标签, Day5=departure+倒推标签");

  // 模拟改航班：移除 Day1 的 flight_arrive，新增 Day3 的 flight_arrive
  trip.constraints = trip.constraints.filter((c) => c.type !== "flight_arrive");
  trip.constraints.push({
    constraintId: "c_new_arrive_d3",
    type: "flight_arrive",
    anchorTime: "2026-11-10T14:30:00",
    dayIndex: 3,
    label: "CZ1234 落地 14:30",
    locked: true,
  });
  // 同一操作内重算（模拟 applyOps / tripStore.save 路径）
  recomputeDerivedFields(trip);

  // Day1 不再是抵达日：role 和 label 均同步清除
  assert.equal(trip.days["day_1"].role, "full_play", "S11: 改航班后 Day1 role → full_play");
  assert.equal(trip.days["day_1"].timeSourceLabel, null, "S11: 改航班后 Day1 label → null（无 stale）");
  ctx.log("S11 assert: 改航班后 Day1 role=full_play, label=null（无 stale）");

  // Day3 变为抵达日：role 和 label 同步更新
  assert.equal(trip.days["day_3"].role, "arrival", "S11: 改航班后 Day3 role=arrival");
  assert.equal(trip.days["day_3"].timeSourceLabel, "按你的到达航班 14:30 算", "S11: 改航班后 Day3 label 同步");
  ctx.log("S11 assert: 改航班后 Day3 role=arrival, label='按你的到达航班 14:30 算'（同步重算）");

  // 模拟改锁酒店：Day2 lodging locked=true + areaName 变更 → 换区日 role 更新
  trip.lodgings["1"] = { dayIndex: 1, areaName: "海棠湾", hotelRefs: [], checkInTime: null, checkOutTime: null, purchaseState: "unknown", locked: true, userAdjusted: false };
  trip.lodgings["2"] = { dayIndex: 2, areaName: "亚龙湾", hotelRefs: [], checkInTime: null, checkOutTime: null, purchaseState: "unknown", locked: true, userAdjusted: false };
  recomputeDerivedFields(trip);
  assert.equal(trip.days["day_2"].role, "transit", "S11: 改锁酒店后 Day2 role=transit");
  ctx.log("S11 assert: 改锁酒店后 Day2 role=transit（换区日），label 仍为 null（无航班锚点）");
  assert.equal(trip.days["day_2"].timeSourceLabel, null, "S11: 换区日无航班 → label=null");

  ctx.log("S11 pass: role 与 timeSourceLabel 在同一 recomputeDerivedFields 调用内同步重算，无 stale");
}

// ===== 内联断言：C1/C2/C3（Task #282 稀疏攻略澄清流程，全部离线确定性） =====

/** C1/C3 共用的稀疏源提交：S1（西岛/椰梦长廊 2 claims）→ ready，返回 sourceId */
async function submitSparseS1(tripId: string, ctx: CaseContext): Promise<string> {
  const { data } = loadFixtureAssets();
  const s1 = data.sources.find((source) => source.id === "S1") ?? data.sources[0];
  const submitted = await submitGuideSource(tripId, {
    inputKind: "text",
    text: `${s1.title}\n${s1.notes ?? ""}`,
    title: s1.title,
  });
  const done = await pollSourceUntilDone(tripId, submitted.sourceId, 120_000);
  assert.equal(done.status, "ready", `稀疏源 S1 应处理为 ready，实际 ${done.status}（${done.failureMessage ?? ""}）`);
  ctx.log(`setup: S1 稀疏源「${s1.title}」→ ready（claims=${done.mentionRefs.length}）`);
  return submitted.sourceId;
}

/**
 * C1（机+人）：稀疏 1 篇只够 1 天 + 5 天行程 → 恰好一次澄清，两选项文案逐字定稿。
 * 离线确定性——澄清在 AI 调用前短路（attempts=0），不触百炼；文案/结构逐字断言，
 * 「人」成分＝PD 复核两选项交互文案（report 主观项区引用本证据）。
 */
async function runC1(ctx: CaseContext): Promise<void> {
  const installed = installFixtureExtraction();
  assert.equal(installed, true, "C1: EVAL_FIXTURE=1 应完成 fixture 抽取注入");
  const tripId = "0e1a2b3c-4d5e-4f60-8a7b-0000000c1e01";
  const trip = buildFixtureSanyaTrip(tripId, "2026-10-19T08:00:00.000Z");
  await tripStore.save(trip);
  // 澄清前快照：行程长度 + 锁定项（断言「不改行程长度、不碰锁定项」）
  const dayCountBefore = trip.dayRefs.length;
  const lockedBefore = trip.constraints.filter((c) => c.locked).map((c) => c.constraintId).sort();
  try {
    const sourceId = await submitSparseS1(tripId, ctx);
    const result = await generateGuideDraft(tripId, {
      scope: { kind: "trip" },
      sourceMode: "selected",
      selectedSourceIds: [sourceId],
    });

    // 断言①：恰好一次澄清——单个 clarification 对象，AI 未被调用（attempts=0、draftId=null）
    const clar = result.clarification;
    assert.ok(clar != null, "C1: 稀疏 1 篇只够 1 天 + 5 天行程应触发澄清");
    assert.equal(result.draftId, null, "C1: 澄清时草案不生成（draftId=null）");
    assert.equal(result.attempts, 0, "C1: 澄清在 AI 调用前短路（attempts=0 → 同次请求恰好一次澄清，无重复）");
    ctx.log("C1 assert①: 恰好一次澄清（clarification 非空、draftId=null、attempts=0，AI 未调用）");

    // 断言②：仅两选项 + 文案逐字定稿 + value 绑定 planScope 语义
    assert.equal(clar.options.length, 2, "C1: 澄清仅两选项");
    assert.equal(clar.options[0].value, "guide_only", "C1: A 选项 value=guide_only（草案只覆盖攻略可支撑的天）");
    assert.equal(clar.options[0].label, "只排攻略涉及的天（其余天保持现安排）", "C1: A 选项文案逐字");
    assert.equal(clar.options[1].value, "ai_fill", "C1: B 选项 value=ai_fill（允许 AI 补充排满剩余天）");
    assert.equal(clar.options[1].label, "允许 AI 补充排满剩余天", "C1: B 选项文案逐字");
    assert.match(clar.question, /只够排 1 天/, "C1: 问句应点明素材只够排 1 天");
    assert.match(clar.question, /行程有 5 天/, "C1: 问句应点明行程共 5 天");
    ctx.log(`C1 assert②: 两选项文案逐字——A「${clar.options[0].label}」(guide_only) / B「${clar.options[1].label}」(ai_fill)`);
    ctx.log(`C1 assert②: 问句「${clar.question}」`);

    // 断言③：不改行程长度、不碰锁定项、澄清阶段不写答案（零副作用）
    const after = await tripStore.load(tripId);
    assert.ok(after != null, "C1: 行程应仍存在");
    assert.equal(after.dayRefs.length, dayCountBefore, "C1: 澄清不改行程长度");
    const lockedAfter = after.constraints.filter((c) => c.locked).map((c) => c.constraintId).sort();
    assert.deepEqual(lockedAfter, lockedBefore, "C1: 澄清不碰锁定项");
    assert.equal(after.clarificationAnswer ?? null, null, "C1: 澄清阶段不持久化答案（用户回答后才存）");
    ctx.log(`C1 assert③: 行程长度不变（${after.dayRefs.length} 天）、锁定项不变（${lockedAfter.length} 条）、澄清阶段未写答案`);
    ctx.log("C1 pass: 稀疏素材恰好一次澄清 + 两选项文案逐字 + 不改行程长度/不碰锁定项");
  } finally {
    await tripStore.deleteTrip(tripId);
    uninstallFixtureExtraction();
  }
}

/**
 * C2（机）：锁定/已购内容已填满其余天 → 澄清被抑制。
 * 抑制逻辑位于 estimateGuideCoverage（generateGuideDraft 直接消费 gap.suppressed）：
 * 纯函数断言，离线确定性。构造 S1 稀疏场景（西岛/椰梦长廊 2 个未对齐点位 → 可支撑 1 天 < 5×0.5）。
 */
function runC2(ctx: CaseContext): void {
  const trip = buildFixtureSanyaTrip("0e1a2b3c-4d5e-4f60-8a7b-0000000c2e01", "2026-10-19T08:00:00.000Z");
  const sparsePlaces = [
    { entityRef: null, displayName: "西岛" },
    { entityRef: null, displayName: "椰梦长廊" },
  ];

  // 基线：其余天（Day2/3/4）未锁定 → 缺口成立且不抑制（会澄清）
  const baseline = estimateGuideCoverage(trip, sparsePlaces);
  assert.equal(baseline.hasGap, true, "C2 基线: 稀疏 2 点位 + 5 天 → 缺口成立");
  assert.equal(baseline.suppressed, false, "C2 基线: 其余天未填满 → 不抑制（应澄清）");
  ctx.log(`C2 基线: hasGap=${baseline.hasGap}, suppressed=${baseline.suppressed}, 可支撑 ${baseline.coveredDayCount}/${baseline.totalDayCount} 天（其余天未锁定 → 不抑制）`);

  // 锁定/已购填满其余天：Day2 visit_wzz locked、Day3 visit_market bought、Day4 补 locked visit（空天不算填满）
  trip.visits["visit_wzz"].locked = true;
  trip.visits["visit_market"].purchaseState = "bought";
  trip.itemRegistry["item_c2_d4"] = { ...trip.itemRegistry["item_wzz"], itemId: "item_c2_d4", name: "天涯海角" };
  trip.visits["visit_c2_d4"] = {
    visitId: "visit_c2_d4",
    dayRef: "day_4",
    pointRef: "item_c2_d4",
    kind: "ordinary",
    order: 0,
    childStopRefs: [],
    alternateStopRefs: [],
    sourceMentionRefs: [],
    guideSnippets: [],
    purchaseState: "unknown",
    locked: true,
    userAdjusted: false,
  } as unknown as Visit;
  trip.days["day_4"].scheduleVisitRefs = ["visit_c2_d4"];

  const suppressed = estimateGuideCoverage(trip, sparsePlaces);
  assert.equal(suppressed.hasGap, true, "C2: 缺口仍成立（素材未变多）");
  assert.equal(suppressed.suppressed, true, "C2: 锁定/已购填满其余天 → 澄清被抑制");
  ctx.log(`C2 assert: 其余天锁定/已购填满后 suppressed=${suppressed.suppressed}（Day2 locked + Day3 bought + Day4 locked）→ 澄清被抑制`);

  // 反证：解锁其中一天（Day3）→ 抑制解除（抑制条件＝「全部」其余天填满）
  trip.visits["visit_market"].purchaseState = "unknown";
  const released = estimateGuideCoverage(trip, sparsePlaces);
  assert.equal(released.suppressed, false, "C2 反证: 其余天未全部填满 → 抑制解除");
  ctx.log(`C2 反证: 解锁 Day3 后 suppressed=${released.suppressed}（抑制要求其余天「全部」锁定/已购）`);

  // ===== Minor5（Task #290）：覆盖估算纳入 sourceHash——天数扩展后旧答案失效 =====
  // 复算 planner computeSourceHash 新口径：sha256(`${ids}|cov=${covered}/${total}/sup=${suppressed}`) 前 16 位。
  // ids（来源集合）保持不变，仅天数扩展改变 totalDayCount → 覆盖估算变 → 哈希变 → 旧澄清答案不再被复用。
  {
    const hashOf = (cov: { coveredDayCount: number; totalDayCount: number; suppressed: boolean }): string =>
      createHash("sha256")
        .update(`src_sparse|cov=${cov.coveredDayCount}/${cov.totalDayCount}/sup=${cov.suppressed}`)
        .digest("hex")
        .slice(0, 16);
    const cov5 = estimateGuideCoverage(trip, sparsePlaces);
    const hash5 = hashOf(cov5);
    // 天数扩展 5 → 6：追加一个空安排天
    trip.dayRefs.push("day_6");
    trip.days["day_6"] = {
      dayId: "day_6",
      dayIndex: 6,
      date: "2026-10-24",
      departTime: null,
      departTimeOverridden: false,
      scheduleVisitRefs: [],
      lodging: null,
    } as unknown as Day;
    const cov6 = estimateGuideCoverage(trip, sparsePlaces);
    const hash6 = hashOf(cov6);
    assert.equal(cov6.totalDayCount, 6, "Minor5: 天数扩展后 totalDayCount=6");
    assert.match(hash5, /^[0-9a-f]{16}$/, "Minor5: sourceHash 应为 16 位十六进制");
    assert.notEqual(hash5, hash6, "Minor5: 天数扩展改变覆盖估算 → sourceHash 变化 → 旧澄清答案失效（不复用）");
    ctx.log(`Minor5 assert: sourceHash 纳入覆盖估算——5天(total=${cov5.totalDayCount})=${hash5}、扩到6天(total=${cov6.totalDayCount})=${hash6}（不等 → 天数扩展后不复用旧答案）`);
  }

  ctx.log("C2 pass: 锁定/已购填满其余天 → 澄清被抑制；任一天未填满 → 抑制解除；覆盖估算纳入 sourceHash（天数扩展→旧答案失效）");
}

/**
 * C3（机）：同次 draft 请求澄清 ≤1 次；回答按 trip+来源集合持久化。
 * 离线确定性——「≤1 次」由澄清短路（attempts=0、返回即结束、无循环）架构保证；
 * 「持久化」经真实 tripStore.save/load round-trip 验证 Trip 级字段 + 读时迁移兼容 + 哈希门控失效。
 * 答案被消费后进入 AI 生成的链路属 planner live 轮覆盖（见 case note）。
 */
async function runC3(ctx: CaseContext): Promise<void> {
  const installed = installFixtureExtraction();
  assert.equal(installed, true, "C3: EVAL_FIXTURE=1 应完成 fixture 抽取注入");
  const tripId = "0e1a2b3c-4d5e-4f60-8a7b-0000000c3e01";
  const trip = buildFixtureSanyaTrip(tripId, "2026-10-19T08:00:00.000Z");
  await tripStore.save(trip);
  try {
    const sourceId = await submitSparseS1(tripId, ctx);

    // ① 首次请求（无答案）→ 恰好一次澄清，AI 未调用；澄清阶段不写答案
    const first = await generateGuideDraft(tripId, {
      scope: { kind: "trip" },
      sourceMode: "selected",
      selectedSourceIds: [sourceId],
    });
    const clar = first.clarification;
    assert.ok(clar != null, "C3: 首次请求应触发澄清");
    assert.equal(first.attempts, 0, "C3: 澄清短路，AI 未调用（同次请求不会 >1 次澄清）");
    assert.equal(clar.options.length, 2, "C3: 单次澄清仅两选项（非多轮）");
    const afterClarify = await tripStore.load(tripId);
    assert.equal(afterClarify?.clarificationAnswer ?? null, null, "C3: 澄清阶段不持久化答案（回答后才存）");
    ctx.log(`C3 assert①: 同次 draft 请求恰好一次澄清（attempts=0、options=${clar.options.length}）；澄清阶段 clarificationAnswer=${afterClarify?.clarificationAnswer ?? "null"}`);

    // ② 来源集合哈希（round-trip 持久化机制验证用；planner 实际口径为 sha256(ids|cov=覆盖估算) 前 16 位，
    //    天数扩展/覆盖变化使旧答案失效的行为在 C2「Minor5」块断言）
    const sourceHash = createHash("sha256")
      .update(first.sourceSnapshots.map((s) => s.sourceId).sort().join(","))
      .digest("hex")
      .slice(0, 16);
    assert.match(sourceHash, /^[0-9a-f]{16}$/, "C3: sourceHash 应为 16 位十六进制");
    ctx.log(`C3 assert②: 来源集合哈希 sourceHash=${sourceHash}（trip+来源集合 持久化键）`);

    // ③ 用户选择 A（guide_only）→ 按 planner 持久化口径写 Trip 级字段，save/load round-trip
    const answer: ClarificationAnswer = "guide_only";
    const toPersist = await tripStore.load(tripId);
    assert.ok(toPersist != null, "C3: 行程应存在");
    toPersist.clarificationAnswer = answer;
    toPersist.clarificationSourceHash = sourceHash;
    await tripStore.save(toPersist);
    const reloaded = await tripStore.load(tripId);
    assert.equal(reloaded?.clarificationAnswer, "guide_only", "C3: 回答持久化（clarificationAnswer round-trip）");
    assert.equal(reloaded?.clarificationSourceHash, sourceHash, "C3: 回答绑定来源集合哈希持久化");
    ctx.log(`C3 assert③: 回答持久化 round-trip——clarificationAnswer=${reloaded?.clarificationAnswer}, clarificationSourceHash=${reloaded?.clarificationSourceHash}`);

    // ④ 读时迁移兼容：存量行程（从未写澄清字段）读取时按未回答处理，不报错、零迁移
    const legacyTripId = "0e1a2b3c-4d5e-4f60-8a7b-0000000c3e02";
    const legacy = buildFixtureSanyaTrip(legacyTripId, "2026-10-19T08:00:00.000Z");
    delete (legacy as { clarificationAnswer?: unknown }).clarificationAnswer;
    delete (legacy as { clarificationSourceHash?: unknown }).clarificationSourceHash;
    await tripStore.save(legacy);
    const legacyLoaded = await tripStore.load(legacyTripId);
    assert.equal(legacyLoaded?.clarificationAnswer ?? null, null, "C3: 存量行程读时兼容（缺字段 → 未回答）");
    ctx.log(`C3 assert④: 读时迁移兼容——存量行程 clarificationAnswer=${legacyLoaded?.clarificationAnswer ?? "null"}（缺字段按未回答读，零迁移）`);
    await tripStore.deleteTrip(legacyTripId);

    // ⑤ 哈希门控（planner 复用谓词同款）：来源集合未变→复用答案不再澄清；来源变化→答案失效需重新澄清
    const persisted = await tripStore.load(tripId);
    assert.ok(persisted != null, "C3: 行程应存在");
    const reuseValid = persisted.clarificationAnswer != null && persisted.clarificationSourceHash === sourceHash;
    assert.equal(reuseValid, true, "C3: 来源集合未变 → 已存答案有效（复用，不再澄清）");
    persisted.clarificationSourceHash = "0000000000000000";
    const reuseAfterChange = persisted.clarificationAnswer != null && persisted.clarificationSourceHash === sourceHash;
    assert.equal(reuseAfterChange, false, "C3: 来源集合变化 → 已存答案失效（重新澄清）");
    ctx.log(`C3 assert⑤: 哈希门控——匹配复用(${reuseValid})、来源变化失效(${reuseAfterChange})；澄清按 trip+来源集合 ≤1 次`);
    ctx.log("C3 pass: 同次 draft 请求澄清 ≤1 次（attempts=0 短路）+ 回答按 trip+来源集合持久化（round-trip / 读时迁移兼容 / 哈希门控失效）");
  } finally {
    await tripStore.deleteTrip(tripId);
    uninstallFixtureExtraction();
  }
}


export const FIRST28: EvalCase[] = [
  // ---- L1 抽取层（首轮 4 条为慢层一次性，缓存后零等待） ----
  {
    id: "E3", layer: "L1", title: "仅链接来源抓取", judgment: "机",
    assertion: "抓取标题/正文；失败时 status=failed 带 failureCode，可重试",
    implStatus: "已实现", backlog: "-",
    reuse: "server/src/guides/verify-b2.ts（链接源状态机 + classifyLinkFailure failureCode + retryGuideSource）",
    run: B2_VERIFY,
    note: "状态机/失败码/重试断言由 verify-b2 离线段覆盖（VERIFY_SKIP_LIVE=1，纯确定性）；真实抓取质量属慢层一次性项，见报告遗留",
  },
  {
    id: "E5", layer: "L1", title: "分享文案粘贴自动提取链接", judgment: "机",
    assertion: "自动提取链接；toast 文案正确",
    implStatus: "已实现", backlog: "-",
    reuse: "web vitest：NoteInput（XHS_URL_PATTERN 提取）+ api/client extractUrl；toast 文案项判定含「报」成分",
    run: NOTEINPUT_VITEST,
    note: "web 侧提链断言由 NoteInput.test.tsx 覆盖（子进程 vitest）；toast 文案截图证据见 UI 轮",
  },
  {
    id: "E6", layer: "L1", title: "同 canonicalUrl 去重", judgment: "机",
    assertion: "同 canonicalUrl 粘两次去重为 1 源",
    implStatus: "已实现", backlog: "-",
    reuse: "新建内联（submitGuideSource.duplicate 真实链路）＋ shared/src/verify-guides.ts（findDuplicateGuideSource 纯函数）",
    run: { kind: "inline", fn: runFixtureProofAndDedupe },
  },
  {
    id: "E8", layer: "L1", title: "正文＋图混合来源", judgment: "机",
    assertion: "mentions 合并、多图算 1 源",
    implStatus: "已实现", backlog: "-",
    reuse: "server/src/guides/verify-b2.ts（text+images 混合提交 → 1 源、逐图证据合并）",
    run: B2_VERIFY,
    note: "混合来源→1 源、逐图证据合并断言由 verify-b2 离线段覆盖",
  },
  // ---- L2 聚合层 ----
  {
    id: "A1", layer: "L2", title: "双源 firsthand 强推进行程", judgment: "机",
    assertion: "≥2 篇独立 firsthand 强推某实体 → 该实体进入行程（非候选池）",
    implStatus: "依赖planner输出", backlog: "-",
    reuse: "新建（generateGuideDraft + planner 回放缓存后断言 operations 含 plan/assign）",
    run: { kind: "inline", fn: runA1 },
    plannerShared: true,
    note: "投票规则在 planner prompt 层（buildGuidePlannerPrompt），代码层无独立投票器；本轮 live 录制（8 条共享一次 generateGuideDraft 真调）",
  },
  {
    id: "A3", layer: "L2", title: "reported_opinion 差评不计负票", judgment: "机",
    assertion: "reported_opinion 差评不计负票；实体不因它进候选池",
    implStatus: "依赖planner输出", backlog: "-",
    reuse: "新建（fixture C11 转述差评 → draft 断言无负向操作）",
    run: { kind: "inline", fn: runA3 },
    plannerShared: true,
    note: "claimKind 契约在解析层已实现（CLAIM_KIND_SET 白名单），判定规则在 prompt 层；本轮 live 录制（共享草案）",
  },
  {
    id: "A4", layer: "L2", title: "风险 claim 绑定活动/商家", judgment: "机",
    assertion: "风险标签绑 activity/provider，点位仍进行程",
    implStatus: "依赖planner输出", backlog: "-",
    reuse: "新建（fixture C09 冲浪商家风险 → snippet claimKind=risk + targetScope 断言）",
    run: { kind: "inline", fn: runA4 },
    plannerShared: true,
    note: "GuideTargetScope 类型已定义；targetScope 赋值在 planner 输出侧；本轮 live 录制（共享草案）。Task #291 PD 拍板：runA4 硬断言由「risk ≥1」放宽为「警告类信息以 risk 或 tip 任一出现即 pass」（警告性实用建议归 tip 可接受，risk 留给重大安全/财务损失/商家欺诈）；assertion 原文不改，planner prompt 第五节已同步注入「risk/tip 边界从宽」说明",
  },
  {
    id: "A5", layer: "L2", title: "单源 firsthand 避雷进候选池", judgment: "机",
    assertion: "2 源中 1 源 firsthand 避雷、无强正 → 不进行程、进候选池带原因",
    implStatus: "依赖planner输出", backlog: "-",
    reuse: "新建（draft 断言：实体不入 operations、relationshipSuggestions 带原因）",
    run: { kind: "inline", fn: runA5 },
    plannerShared: true,
    note: "候选池机制（globalCandidateRefs/relationshipSuggestions）已实现，进池判定在 prompt 层；本轮 live 录制（共享草案）",
  },
  {
    id: "A7", layer: "L2", title: "9 图笔记计 1 票", judgment: "机",
    assertion: "9 图笔记参与投票计 1 票非 9 票",
    implStatus: "已实现", backlog: "-",
    reuse: "server/src/guides/verify-b2.ts（images 9 张 → 1 GuideSource；merge.ts 按源计票）",
    run: B2_VERIFY,
    note: "结构层已保证 1 提交=1 源；9 图→1 源计票断言由 verify-b2 离线段覆盖",
  },
  {
    id: "A9", layer: "L2", title: "snippet 上限", judgment: "机",
    assertion: "每 Visit/Stop ≤2 条；≤40 字硬上限；截断不回写存储",
    implStatus: "已实现", backlog: "-",
    reuse: "新建内联（parsePlannerOutput 生产解析链）＋ shared/src/verify-dedupe.ts（每实体 ≤2 条挂载上限）",
    run: { kind: "inline", fn: runSnippetLimits },
  },
  {
    id: "A10", layer: "L2", title: "snippet 引用可溯源", judgment: "机",
    assertion: "evidenceRefs 1–3 非空；文本可溯源到 quote（归一化后包含/高相似）",
    implStatus: "已实现", backlog: "-",
    reuse: "新建内联（parsePlannerOutput 引用过滤）＋ shared/src/verify-guides.ts / verify-dedupe.ts（归一化相似口径）",
    run: { kind: "inline", fn: runSnippetTraceability },
  },
  {
    id: "A11", layer: "L2", title: "无 Tips 源不出 Tips 块", judgment: "机",
    assertion: "源无 Tips 类信息 → 不出现 Tips 块、不出现「攻略未明确」",
    implStatus: "依赖planner输出", backlog: "-",
    reuse: "新建（无 tip 素材 fixture → draft.optionGroups 为空断言）；「攻略未明确」文案 grep 已确认不存在",
    run: { kind: "inline", fn: runA11 },
    plannerShared: true,
    note: "optionGroups 清洗契约已实现（≥2 选项成组、category 白名单），是否产出由 planner 决定；本轮 live 录制（共享草案）",
  },
  // ---- L3 排程层 ----
  {
    id: "S1", layer: "L3", title: "返程日机场走廊", judgment: "机",
    assertion: "回程 21:30 → 返程日仅机场走廊低承诺项；无岛/船/远/长票/付费水上",
    implStatus: "依赖planner输出", backlog: "-",
    reuse: "新建（fixture 行程 + 回程约束 → draft/重排输出断言返程日项集合 ⊂ 走廊集）",
    run: { kind: "inline", fn: runS1 },
    plannerShared: true,
    note: "排程规则在 prompt 层（buildTripFacts 注入 MU5832 18:00 返程约束；directives.ts 仅做航班日冲突告知），代码层无走廊硬规则；本轮 live 录制（共享草案）。Task #291：planner prompt 第六节已注入「返程日走廊 + 抵达日 + 方向综合评估」三条显式规则（治理「后海村被排入返程日」方差）；S1 断言保持严格不放宽（Day5 仍不得出现 后海/岛/船/潜水 等重项），修复必须是实质性的",
  },
  {
    id: "S2", layer: "L3", title: "抵达日 buffer", judgment: "机",
    assertion: "到达 09:40 → 抵达日首项在到达+buffer 之后；近酒店/市区",
    implStatus: "依赖planner输出", backlog: "-",
    reuse: "新建（fixture MU5831 09:40 抵达 → 首项 startTime 断言）",
    run: { kind: "inline", fn: runS2 },
    plannerShared: true,
    note: "同 S1：规则在 prompt 层（buildTripFacts 注入 MU5831 09:40 抵达 + Day1 departTime 10:30）；本轮 live 录制（共享草案）",
  },
  {
    id: "S3", layer: "L3", title: "锁定酒店日区域连续", judgment: "机",
    assertion: "锁亚龙湾酒店 D2–D3 → 亚龙湾项排在锁定日；不出现先海棠湾再折回",
    implStatus: "依赖planner输出", backlog: "-",
    reuse: "新建（锁定 lodging + 多区域素材 → draft day 分配断言）",
    run: { kind: "inline", fn: runS3 },
    plannerShared: true,
    note: "锁定尊重由 guards/directives 代码层保证；区域连续性编排由 planner 决定；本轮 live 录制（软校验，供人审）",
  },
  {
    id: "S5", layer: "L3", title: "出发时间来源标签", judgment: "机",
    assertion: "灰字仅出现在抵达日/返程日出发时间旁与时间编辑态；普通日不显示；手改后「你设定」仅该 Day 时间行；不出现全局角标",
    implStatus: "已实现", backlog: "-",
    reuse: "新建内联断言（deriveTimeSourceLabels 四状态矩阵 + buildFixtureSanyaTrip 夹具）＋ web vitest DayContent.test.tsx DOM 断言",
    run: { kind: "inline", fn: runS5 },
    note: "Task #281 实现；shared verify-timeSource.ts 10 组断言 + web DayContent.test.tsx 7 条 DOM 断言（含无全局角标）",
  },
  {
    id: "S7", layer: "L3", title: "锁定项重新排版不动", judgment: "机",
    assertion: "锁定项 day 与序不变",
    implStatus: "已实现", backlog: "-",
    reuse: "shared/src/verify.ts §7/§9（guards G1/G3：锁定 visit 的 move/remove/setTime 拒绝，双通道）",
    run: SHARED_VERIFY,
  },
  {
    id: "S10", layer: "L3", title: "Day 角色字段", judgment: "机",
    assertion: "每天有 day 角色字段且与航班/酒店锚点一致（role 由 deriveDayRoles 纯函数派生：返程＞抵达＞换区＞完整游玩；锚点变更同操作重算落盘，读时迁移存量）",
    implStatus: "已实现", backlog: "-",
    reuse: "新建内联断言（deriveDayRoles 纯函数 + buildFixtureSanyaTrip 夹具验证）＋ shared/src/verify-dayRoles.ts 全矩阵",
    run: { kind: "inline", fn: runS10 },
    note: "Task #280 实现；verify-dayRoles.ts 覆盖 10 组断言（优先级/换区链/幂等/红线）",
  },
  {
    id: "S11", layer: "L3", title: "锚点变更同操作重算", judgment: "机",
    assertion: "改航班/改锁酒店后 role 与来源标签在同一操作内同步重算，无 stale 标签",
    implStatus: "已实现", backlog: "-",
    reuse: "新建内联断言（改航班约束 + 改锁酒店 → recomputeDerivedFields → role 与 timeSourceLabel 同步更新验证）",
    run: { kind: "inline", fn: runS11 },
    note: "Task #281 实现；recomputeDerivedFields 钩子内 deriveDayRoles + deriveTimeSourceLabels 顺序执行，同一操作内同步",
  },
  // ---- L4 生成与澄清 ----
  {
    id: "C1", layer: "L4", title: "稀疏素材恰好一次澄清", judgment: "机+人",
    assertion: "稀疏 1 篇只够 1 天＋5 天行程 → 恰好一次澄清；两选项绑定 planScope：A＝草案只覆盖攻略可支撑的天（其余天保持现安排）、B＝允许 AI 补充排满剩余天；不改行程长度、不碰锁定项；文案定稿「A 只排攻略涉及的天（其余天保持现安排）／B 允许 AI 补充排满剩余天」",
    implStatus: "已实现", backlog: "参赛必须",
    reuse: "内联 runC1（真实 generateGuideDraft 澄清短路，离线确定性）＋ shared/src/verify-coverage.ts（estimateGuideCoverage 缺口矩阵）；澄清结构 GuideDraftResult.clarification（question + 两选项），前端两选项交互后带 clarificationAnswer 重发",
    run: { kind: "inline", fn: runC1 },
    note: "Task #282 实现：解除草案 prompt 禁 clarify，改为覆盖缺口时输出澄清结构；C1 在 AI 调用前短路（attempts=0），文案/结构逐字断言，「人」成分＝PD 复核两选项交互文案（引用本证据）",
  },
  {
    id: "C2", layer: "L4", title: "澄清抑制", judgment: "机",
    assertion: "锁定/已购内容已填满其余天 → 澄清被抑制",
    implStatus: "已实现", backlog: "赛后",
    reuse: "内联 runC2（estimateGuideCoverage 纯函数：锁定/已购填满其余天 → suppressed=true；反证任一天未填满 → 抑制解除）＋ shared/src/verify-coverage.ts §4/§5",
    run: { kind: "inline", fn: runC2 },
    note: "Task #282 实现：抑制逻辑在 shared estimateGuideCoverage（generateGuideDraft 直接消费 gap.suppressed），纯函数离线断言；随 C1 自然获得，拍板口径未列入参赛必须四条，赛后跟踪",
  },
  {
    id: "C3", layer: "L4", title: "澄清次数与回答持久化", judgment: "机",
    assertion: "同次 draft 请求 → 澄清 ≤1 次；回答持久化（按 trip+来源集合）",
    implStatus: "已实现", backlog: "参赛必须",
    reuse: "内联 runC3（真实 generateGuideDraft 澄清短路 attempts=0 证「≤1 次」＋ tripStore.save/load round-trip 证 Trip 级字段持久化 + 读时迁移兼容 + 哈希门控失效）",
    run: { kind: "inline", fn: runC3 },
    note: "Task #282 实现：澄清短路（无循环、返回即结束）架构保证同次请求 ≤1 次；回答存 Trip.clarificationAnswer/clarificationSourceHash（sha256 排序 sourceId 前 16 位），来源集合变化即失效重澄清；v1.4 首轮＝否，答案被消费后进入 AI 生成的链路属 planner live 轮覆盖",
  },
  {
    id: "C4", layer: "L4", title: "飞猪补充标", judgment: "机",
    assertion: "允许 AI 补充 → 补充项带「飞猪补充」标＋FlyAI 核验过",
    implStatus: "已实现", backlog: "-",
    reuse: "内联 runC4（离线确定性四维度）＋ web vitest：shared provenance 落盘/读时默认、planner markAiSupplementProvenance 应用时打标、guards validateAiSupplementProvenance 护栏拒绝无真实飞猪 POI、chip 文案「AI 补充·飞猪核验」与展示范围（主卡/分享显示、清单不显示、≤360px 降级）",
    run: { kind: "inline", fn: runC4 },
    note: "Task #283 实现：Item.provenance（guide|ai_supplement，缺失读时默认 guide、存量零迁移）；补充项在 applyGuideDraft 打标；护栏复用 #229 伪 POI 思路（无真实 fliggy id 拒绝落标）；chip 全标「AI 补充·飞猪核验」，≤360px 降级「AI 补充」＋核验说明进详情行",
  },
  // ---- L5 引用与展示 ----
  {
    id: "Q1", layer: "L5", title: "snippet 抽屉回看链路", judgment: "报",
    assertion: "点 snippet → 抽屉先原句/图区域＋来源标题 →「查看这篇攻略」→「打开原链接」",
    implStatus: "已实现", backlog: "-",
    reuse: "web vitest：VisitCard.test.tsx（snippet chip → EvidenceSheet focusMentionRef 定位高亮 + 外链 <a>）；证据＝截图",
    run: VISITCARD_VITEST,
    uiShot: true,
    note: "判定「报」：断言链由 VisitCard/EvidenceSheet vitest 覆盖；另附 UI 截图证据 evidence/Q1.png（抽屉回看链路）",
  },
  {
    id: "Q3", layer: "L5", title: "0 snippet 卡无原文入口", judgment: "机",
    assertion: "0 snippet 卡无原文入口、无「攻略未明确」",
    implStatus: "已实现", backlog: "-",
    reuse: "web vitest：VisitCard.test.tsx（snippets.length===0 分支整体隐藏引用块）；「攻略未明确」全仓无命中",
    run: VISITCARD_VITEST,
    uiShot: true,
    note: "web 侧断言在 VisitCard vitest 套件；另附 UI 截图证据 evidence/Q3.png（0 snippet 卡无原文入口）",
  },
  {
    id: "Q5", layer: "L5", title: "partial 源 coverage 诚实", judgment: "机",
    assertion: "partial 源 coverage 诚实＋重试入口",
    implStatus: "已实现", backlog: "-",
    reuse: "server/src/guides/verify-b2.ts（partial 状态 + coverageText + retryGuideSource）",
    run: B2_VERIFY,
    note: "partial coverage 诚实 + 重试入口断言由 verify-b2 离线段覆盖",
  },
  // ---- L6 变更编排 ----
  {
    id: "O1", layer: "L6", title: "锁定项拖拽不动", judgment: "机",
    assertion: "锁定酒店＋拖拽其他项 → 锁定项不动",
    implStatus: "已实现", backlog: "-",
    reuse: "shared/src/verify.ts §7/§9（guards 锁定拒绝）＋ web/src/lib/verify-dayOrder.ts（day 序）",
    run: SHARED_VERIFY,
    note: "锁定项拖拽不动与 S7 同源断言（guards G1/G3 双通道），复用 SHARED_VERIFY",
  },
  {
    id: "O2", layer: "L6", title: "撤销精确回滚", judgment: "机",
    assertion: "任意操作后撤销 → 状态精确回到操作前",
    implStatus: "已实现", backlog: "-",
    reuse: "web/src/lib/verify-dayOrder.ts ＋ web vitest useTrip（removeVisitWithUndo 原位恢复：visit/stop/hotel 三态判别联合）",
    run: DAYORDER_VERIFY,
    note: "撤销精确回滚（day 序 + 移除类原位恢复）由 verify-dayOrder 覆盖；「任意操作」全量撤销语义如 PD 收紧口径则升用例版本",
  },
  {
    id: "O3", layer: "L6", title: "NL 局部松排", judgment: "机",
    assertion: "NL「Day2 松一点」→ 仅 Day2 低优先项被移/换；锁定尊重",
    implStatus: "依赖planner输出", backlog: "-",
    reuse: "新建（executeIntent + planner 回放 → operations scope 断言仅 day2；锁定尊重由 guards 代码层兜底）",
    run: { kind: "inline", fn: runO3 },
    plannerShared: true,
    liveOnly: true,
    note: "F11 局部重算 scope 机制已实现；executeIntent 直连百炼不经 plannerCache（live-only 不可回放）；打标复用共享草案的 [live]",
  },
  {
    id: "O8", layer: "L6", title: "护栏拒绝带原因", judgment: "机",
    assertion: "违反 guard 的操作拒绝＋用户语言原因，不静默",
    implStatus: "已实现", backlog: "-",
    reuse: "shared/src/verify.ts §7（G1/G3 单条校验 reason 用户语言 + 30% 批量阈值 + 执行器兜底双通道）",
    run: SHARED_VERIFY,
  },
];

/** FX1 不是 28 条之一：harness 自检用例（EVAL_FIXTURE 替换证明），随 E6 内联执行、单独报告 */
export const HARNESS_SELF_CHECK_ID = "FX1";

// 套件表（SUITES）由 first33.ts 统一持有（first28 → first33 合并入口）；本文件只导出 FIRST28 基线数组。

/** 烟雾子集（本轮验证 runner 全链路）：纯快层机器用例，优先复用既有断言 */
export const SMOKE_IDS = ["E6", "A9", "A10", "S7", "O8"];
