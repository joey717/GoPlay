/**
 * Task #229 确定性验证（离线：不调用百炼 / FlyAI / 小红书）。
 *
 * 两项优化：
 *   1. planner 输出格式规则追加「禁用工具」指令——百炼 Managed Agent 会自作主张
 *      用 bash cat + python3 验证 JSON，白白浪费 ~35 秒；规则区明确禁止后行为收敛。
 *   2. 候选池伪 POI 过滤（西岛案例：15 个候选里大量「步行」「景区观光车」「首班船约8」
 *      「租电动车」「村民三轮车」「备选（乌龟滩）」类非景点条目，徒增 prompt 噪音与
 *      推理复杂度）：
 *      - 抽取侧：EXTRACT / OCR 规则文本增加伪 POI 禁令（前置减少入池）；
 *      - 组装侧：formatGlobalPool 兜底过滤（isFilteredNonPoiCandidate）——只影响
 *        prompt 组装，数据保留；飞猪真实 POI（providerId）、用户手动添加
 *        （custom 且无证据来源）、大景区壳（kind=large_attraction）绝不过滤。
 *
 * 验证矩阵：
 *   S1 禁用工具指令：buildGuidePlannerRulesText 四种拼装形态（含 optionGroups
 *      降级声明形态）均携带完整指令；
 *   S2 组装侧过滤（F11 全量形态）：六类伪 POI 样本全部不进入 prompt；受保护
 *      条目（真实自定义 POI / 含「步行街」的正常名称 / 飞猪 providerId / 手动添加 /
 *      大景区壳）全部保留；行程数据零改动（globalCandidateRefs 与 itemRegistry 不变）；
 *   S3 planner 同构形态（guideRelevantOnly + mention 分层 + 瘦身）：伪 POI 即使
 *      被素材 mention 关联仍被滤；关联真实 POI 保持完整行；无关真实 POI 进紧凑名册；
 *   S4 抽取侧禁令：buildExtractPrompt / buildOcrPrompt 均携带伪 POI 禁令文本。
 *
 * 运行：npx tsx server/src/guides/verify-task229.ts
 * 临时行程（server/data）在 finally 全部清理，不影响用户既有数据。
 */

import "../env.js";
import assert from "node:assert/strict";
import type { Item, Trip, Visit } from "@goplay/shared";
import { buildExtractPrompt, buildOcrPrompt, buildTripFacts } from "../ai/prompt.js";
import { createFixtureSanyaTrip, tripStore } from "../persistence/store.js";
import { buildGuidePlannerRulesText } from "./planner.js";

function pass(name: string): void {
  console.log(`✓ ${name}`);
}

/** 本脚本创建的临时行程：finally 统一清理 */
const createdTripIds: string[] = [];

/** 注入条目构造（Task #229 夹具）：evidence=false 模拟用户手动添加（无攻略证据来源） */
function makeItem(
  itemId: string,
  name: string,
  opts?: { origin?: "fliggy" | "custom"; providerId?: string | null; evidence?: boolean },
): Item {
  return {
    itemId,
    name,
    origin: opts?.origin ?? "custom",
    providerId: opts?.providerId ?? null,
    address: null,
    category: null,
    coords: null,
    suggestMinutes: 60,
    mainPic: null,
    ticketInfo: null,
    jumpUrl: null,
    sourceEvidenceRefs: opts?.evidence === false ? [] : ["ev_229"],
  };
}

/** 候选池 visit 构造（西岛同构：dayRef=null + order=null） */
function makeCandidateVisit(visitId: string, pointRef: string, kind: "ordinary" | "large_attraction"): Visit {
  return {
    visitId,
    dayRef: null,
    pointRef,
    kind,
    visitMode: kind === "large_attraction" ? "full_day" : "custom",
    order: null,
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

/** 向夹具内存对象注入 Task #229 候选集：六类伪 POI + 五类受保护条目 + 名册对照 */
function injectTask229Candidates(trip: Trip): number {
  const before = trip.globalCandidateRefs.length;
  // 伪 POI（Task #229 西岛案例实测样本：custom + 攻略证据来源 → 应被兜底过滤）
  trip.itemRegistry["item_walk"] = makeItem("item_walk", "步行");
  trip.itemRegistry["item_bus"] = makeItem("item_bus", "景区观光车");
  trip.itemRegistry["item_boat"] = makeItem("item_boat", "首班船约8");
  trip.itemRegistry["item_ev"] = makeItem("item_ev", "租电动车");
  trip.itemRegistry["item_trike"] = makeItem("item_trike", "村民三轮车");
  trip.itemRegistry["item_backup"] = makeItem("item_backup", "备选（乌龟滩）");
  // 受保护条目（绝不过滤）
  trip.itemRegistry["item_real"] = makeItem("item_real", "牛王岭"); // 普通真实自定义 POI（对照）
  trip.itemRegistry["item_street"] = makeItem("item_street", "第一市场步行街"); // 「步行」仅前缀命中，不误伤
  trip.itemRegistry["item_station"] = makeItem("item_station", "观光车站", { origin: "fliggy", providerId: "fp_station" }); // 飞猪硬保护
  trip.itemRegistry["item_manual"] = makeItem("item_manual", "村民三轮车体验", { evidence: false }); // 用户手动添加
  trip.itemRegistry["item_large"] = makeItem("item_large", "电动车环岛游"); // 大景区壳保护
  // 名册对照（真实 POI，S3 中不关联素材 → 进紧凑名册）
  trip.itemRegistry["item_fall"] = makeItem("item_fall", "后海村");

  for (const [visitId, itemId, kind] of [
    ["visit_walk", "item_walk", "ordinary"],
    ["visit_bus", "item_bus", "ordinary"],
    ["visit_boat", "item_boat", "ordinary"],
    ["visit_ev", "item_ev", "ordinary"],
    ["visit_trike", "item_trike", "ordinary"],
    ["visit_backup", "item_backup", "ordinary"],
    ["visit_real", "item_real", "ordinary"],
    ["visit_street", "item_street", "ordinary"],
    ["visit_station", "item_station", "ordinary"],
    ["visit_manual", "item_manual", "ordinary"],
    ["visit_large", "item_large", "large_attraction"],
    ["visit_fall", "item_fall", "ordinary"],
  ] as const) {
    trip.visits[visitId] = makeCandidateVisit(visitId, itemId, kind);
    trip.globalCandidateRefs.push({ kind: "visit", id: visitId });
  }
  return before;
}

/** Task #229 注入的全部伪 POI visit id（应从 prompt 消失） */
const FAKE_POI_VISIT_IDS = [
  "visit_walk",
  "visit_bus",
  "visit_boat",
  "visit_ev",
  "visit_trike",
  "visit_backup",
];

/** Task #229 注入的全部受保护 visit id（必须保留在 prompt） */
const PROTECTED_VISIT_IDS = [
  "visit_real",
  "visit_street",
  "visit_station",
  "visit_manual",
  "visit_large",
];

async function main(): Promise<void> {
  try {
    await runScenarios();
    console.log("\nTask #229 全部验证通过 ✅");
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

async function runScenarios(): Promise<void> {
  // ============ S1：planner 规则文本各类拼装形态均携带禁用工具指令 ============
  {
    const forms: Array<[string, string]> = [
      ["素材不足 + trip scope（optionGroups 降级）", buildGuidePlannerRulesText(3, { kind: "trip" })],
      ["attraction scope（optionGroups 降级）", buildGuidePlannerRulesText(10, { kind: "attraction", visitId: "visit_real" })],
      ["素材充足 + trip scope（完整契约）", buildGuidePlannerRulesText(10, { kind: "trip" })],
      ["素材不足 + day scope（optionGroups 降级）", buildGuidePlannerRulesText(3, { kind: "day", dayIndex: 2 })],
      // Task #270：内容感知解锁形态同样要找得到禁用工具指令
      [
        "素材不足但含选项组信号（完整契约）",
        buildGuidePlannerRulesText(3, { kind: "attraction", visitId: "visit_real" }, true),
      ],
    ];
    for (const [label, rules] of forms) {
      assert.ok(
        rules.includes("【重要】直接输出合法 JSON 文本即可，不要调用任何工具（bash、python、文件读写等），不要验证 JSON，不要输出任何解释性文字。"),
        `拼装形态「${label}」应携带完整禁用工具指令`,
      );
    }
    pass("S1 禁用工具指令：五种拼装形态（含 optionGroups 降级声明与内容感知解锁）均携带完整指令");
  }

  // ============ S2：组装侧兜底过滤（F11 全量形态）——伪 POI 消失 + 保护条目保留 + 数据零改动 ============
  {
    const trip = await createFixtureSanyaTrip();
    createdTripIds.push(trip.tripId);
    const candidateCountBefore = injectTask229Candidates(trip);
    const itemsBefore = Object.keys(trip.itemRegistry).length;

    const prompt = buildTripFacts(trip).join("\n");

    for (const visitId of FAKE_POI_VISIT_IDS) {
      assert.ok(!prompt.includes(`id=${visitId}`), `伪 POI ${visitId} 不应进入 prompt`);
    }
    assert.ok(!prompt.includes("首班船约8"), "伪 POI 名称不应出现在候选区");
    for (const visitId of PROTECTED_VISIT_IDS) {
      assert.ok(prompt.includes(`id=${visitId}`), `受保护条目 ${visitId} 应保留在 prompt`);
    }
    // 数据零改动：过滤只影响 prompt 组装，候选池与主数据原样
    assert.equal(trip.globalCandidateRefs.length, candidateCountBefore + 12, "候选池条目不得被删除");
    assert.equal(Object.keys(trip.itemRegistry).length, itemsBefore, "主数据不得被删除");
    pass("S2 组装侧过滤（F11 全量）：六类伪 POI 不进入 prompt，五类受保护条目保留，行程数据零改动");
  }

  // ============ S3：planner 同构形态——mention 关联的伪 POI 仍被滤，分层压缩行为正确 ============
  {
    const trip = await createFixtureSanyaTrip();
    createdTripIds.push(trip.tripId);
    injectTask229Candidates(trip);

    // 伪 POI visit_walk 与真实 POI visit_real 被素材 mention 关联（Task #216 P0-B 分层输入）
    const prompt = buildTripFacts(trip, {
      includePending: false,
      guideRelevantCandidatesOnly: true,
      scope: { kind: "trip" },
      slimVisitFormat: true,
      candidateMentionEntityRefs: new Set(["visit:visit_walk", "visit:visit_real"]),
    }).join("\n");

    for (const visitId of FAKE_POI_VISIT_IDS) {
      assert.ok(!prompt.includes(`id=${visitId}`), `mention 关联的伪 POI ${visitId} 仍应被滤出 prompt`);
    }
    assert.ok(prompt.includes("id=visit_real"), "mention 关联的真实 POI 应保持完整行");
    assert.ok(prompt.includes("visit_fall 后海村"), "无 mention 关联的真实 POI 应进紧凑名册");
    assert.ok(prompt.includes("visit_large 电动车环岛游"), "planner 形态下大景区壳保护仍生效（进名册）");
    pass("S3 planner 同构形态：mention 关联不豁免伪 POI 过滤，关联真实 POI 完整行、无关真实 POI 进名册");
  }

  // ============ S4：抽取侧禁令——正文与 OCR 规则文本均携带伪 POI 禁令 ============
  {
    const extractPrompt = buildExtractPrompt("（笔记正文）");
    assert.ok(extractPrompt.includes("严禁将以下内容提取为地点"), "正文抽取规则应携带伪 POI 禁令");
    assert.ok(extractPrompt.includes("“首班船”"), "禁令应列举交通/服务样本关键词");
    const ocrPrompt = buildOcrPrompt();
    assert.ok(ocrPrompt.includes("严禁将以下内容提取为地点"), "OCR 抽取规则应携带伪 POI 禁令");
    pass("S4 抽取侧禁令：buildExtractPrompt / buildOcrPrompt 均携带伪 POI 禁令文本");
  }
}

main()
  .catch((error) => {
    console.error("✗ Task #229 验证失败：", error);
    process.exitCode = 1;
  });
