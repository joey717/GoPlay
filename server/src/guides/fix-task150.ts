/**
 * Task #150 一次性数据修复：情人岛归属纠正 + 错误 snippet 清除。
 *
 * 现场（trip d0174797-f87f-4726-8c55-833840235e51，任务 149 诊断）：
 * - 情人岛（matchedPointRef=7fa7cd13…，地址属蜈支洲岛度假中心内）被挂在西岛
 *   visit_0626fa43… 的 childStopRefs 下（order=2）；
 * - 该 Stop 携带 snippet gsn_cd04b25b（「穿过小吃街左手边就是珊瑚墙」），
 *   引用 ev_note_11:m6/m7（西岛珊瑚墙/小吃街提及）——与情人岛完全无关；
 * - 正确的情人桥数据（stop_7499e93d… child / stop_9bf0f99d… alternate，均在
 *   蜈支洲岛 visit_315d0b82… 下）必须原样保留。
 *
 * 修复内容（最小字段集，不触及其他行程与其他字段）：
 * 1. 情人岛 Stop 从西岛 childStopRefs 迁至蜈支洲岛 childStopRefs 末尾，
 *    visitRef / order 同步更新，双侧剩余 children 的 order 重排为下标；
 * 2. 删除错误 snippet gsn_cd04b25b（其余字段与真实相关证据——珊瑚墙 Stop
 *   stop_c731367e… 自身的 snippet 与 mention 归属——一律不动）。
 *
 * 边界说明：
 * - shared 的 transfer 操作禁止 stop 跨天迁移（Day2 西岛 → Day3 蜈支洲岛），
 *   本脚本是一次性数据修复而非行程操作，直接做结构等价的最小字段搬移；
 * - 不重算 visit 时间字段（effectiveMinutes / startTime / endTime 保持持久值，
 *   validateConsistency 第 10 条不做数值断言；西岛 locked=true 本就不随 children 变化）；
 * - tripStore.save 落盘前过一致性校验，任何结构错误都会拒绝写入。
 *
 * 可复用纯函数（verify-task150.ts 对 fixture 复测同一实现）：
 * - transferAttachedStopAcrossVisits：child 数组间迁移 + 双侧 order 重排；
 * - removeStopGuideSnippets：按 snippetId 精确删除，删空则移除字段。
 *
 * 幂等：前置状态不满足（已修复 / 数据形态不符）时直接跳过不写盘。
 *
 * 运行：npx tsx server/src/guides/fix-task150.ts
 */

import "../env.js";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { Stop, Trip } from "@goplay/shared";
import { tripStore } from "../persistence/store.js";

// ===== 可复用纯函数 =====

/**
 * 把 attached child Stop 从当前所在 Visit 迁到目标 Visit 的 childStopRefs 末尾，
 * 双侧剩余 children 的 order 重排为下标（一致性校验第 5/8 条要求的结构等价搬移）。
 *
 * 仅支持 child → child（alternate 数组不参与）；跨天限制是 shared transfer 的
 * 操作语义（防 AI 越权），本函数是一次性修复工具、调用方自负其责。
 *
 * 返回迁移来源 visitId；前置不满足（stop 不存在 / 非 attached child / 目标 visit
 * 不存在 / 已在目标下）返回 null 且不修改 trip。
 */
export function transferAttachedStopAcrossVisits(trip: Trip, stopId: string, toVisitId: string): string | null {
  const stop = trip.stops[stopId];
  if (stop === undefined || stop.state !== "attached" || stop.visitRef === null) return null;
  const fromVisitId = stop.visitRef;
  if (fromVisitId === toVisitId) return null; // 已在目标下（幂等）
  const toVisit = trip.visits[toVisitId];
  if (toVisit === undefined) return null;
  const fromVisit = trip.visits[fromVisitId];
  if (fromVisit === undefined) return null;
  const childIndex = fromVisit.childStopRefs.indexOf(stopId);
  if (childIndex === -1) return null; // 不在 child 数组（alternate / 悬空结构不处理）

  fromVisit.childStopRefs = fromVisit.childStopRefs.filter((id) => id !== stopId);
  fromVisit.childStopRefs.forEach((id, order) => {
    const sibling = trip.stops[id];
    if (sibling !== undefined) sibling.order = order;
  });
  toVisit.childStopRefs = [...toVisit.childStopRefs, stopId];
  stop.visitRef = toVisitId;
  stop.order = toVisit.childStopRefs.length - 1;
  return fromVisitId;
}

/**
 * 按 snippetId 删除指定 Stop 的攻略提示；删空则整体移除 guideSnippets 字段
 * （类型契约 0..N 条、缺失视为空）。返回删除条数；stop / snippet 不存在返回 0。
 */
export function removeStopGuideSnippets(trip: Trip, stopId: string, snippetIds: string[]): number {
  const stop = trip.stops[stopId];
  if (stop === undefined || !Array.isArray(stop.guideSnippets)) return 0;
  const removeSet = new Set(snippetIds);
  const kept = stop.guideSnippets.filter((snippet) => !removeSet.has(snippet.snippetId));
  const removed = stop.guideSnippets.length - kept.length;
  if (removed === 0) return 0;
  if (kept.length === 0) delete stop.guideSnippets;
  else stop.guideSnippets = kept;
  return removed;
}

// ===== 现场常量（trip d0174797 硬编码，幂等校验后使用） =====

const TRIP_ID = "d0174797-f87f-4726-8c55-833840235e51";
const LOVERS_ISLAND_STOP = "stop_25f5c195-9bd9-4a1d-838a-3d03ae86c42c";
const LOVERS_ISLAND_POINT = "7fa7cd13-de37-4512-92a2-35b4d71d55c3"; // itemRegistry「情人岛」
const XIDAO_VISIT = "visit_0626fa43-75a1-4bba-b6a1-5de64459e8e4_1";
const WUZZ_VISIT = "visit_315d0b82-b587-466a-930d-e99b4bc4b932_1";
const BRIDGE_STOP_CHILD = "stop_7499e93d-6908-4d79-a407-bb423c0b0e55"; // 情人桥（child，须保留）
const WRONG_SNIPPET_ID = "gsn_cd04b25b";
/** 错误 snippet 引用的西岛提及（珊瑚墙 m6 / 小吃街 m7），删除前须逐条核验 */
const WRONG_SNIPPET_REFS = ["ev_note_11:m7", "ev_note_11:m6"];

async function main(): Promise<void> {
  const trip = await tripStore.load(TRIP_ID);
  if (trip === null) {
    console.error(`[FIX-150] 行程 ${TRIP_ID} 不存在，退出`);
    process.exitCode = 1;
    return;
  }

  const island = trip.stops[LOVERS_ISLAND_STOP];
  const xidao = trip.visits[XIDAO_VISIT];
  const wuzz = trip.visits[WUZZ_VISIT];
  assert.ok(island !== undefined, "情人岛 Stop 应存在");
  assert.ok(xidao !== undefined && wuzz !== undefined, "西岛 / 蜈支洲岛 Visit 应存在");
  // 张冠李戴防御：确认 stop 确实指向「情人岛」点位而非其他
  assert.equal(
    island.matchedPointRef,
    LOVERS_ISLAND_POINT,
    "stop_25f5c195 应命中情人岛点位（数据形态与诊断不符，中止）",
  );
  assert.equal(
    trip.itemRegistry[LOVERS_ISLAND_POINT]?.name,
    "情人岛",
    "itemRegistry 7fa7cd13 应为情人岛",
  );

  const wrongSnippet = (island.guideSnippets ?? []).find((snippet) => snippet.snippetId === WRONG_SNIPPET_ID);
  const alreadyMoved = island.visitRef === WUZZ_VISIT;

  if (alreadyMoved && wrongSnippet === undefined) {
    console.log("[FIX-150] 情人岛已在蜈支洲岛下且错误 snippet 已清除，幂等跳过");
    return;
  }

  // ---- 修复前快照（变更外实体全字段不变的证据） ----
  const beforeVersion = trip.version;
  const bridgeChildBefore = JSON.parse(JSON.stringify(trip.stops[BRIDGE_STOP_CHILD])) as Stop;
  const otherStopsBefore = new Map<string, Stop | undefined>(
    Object.keys(trip.stops)
      .filter((id) => id !== LOVERS_ISLAND_STOP)
      .map((id) => [id, JSON.parse(JSON.stringify(trip.stops[id])) as Stop]),
  );
  const xidaoChildrenBefore = [...xidao.childStopRefs];
  const wuzzChildrenBefore = [...wuzz.childStopRefs];

  // ---- 前置断言：现场形态必须与诊断一致，否则中止不写盘 ----
  assert.equal(island.visitRef, XIDAO_VISIT, "修复前情人岛应挂在西岛下");
  assert.ok(xidao.childStopRefs.includes(LOVERS_ISLAND_STOP), "情人岛应在西岛 childStopRefs 中");
  if (wrongSnippet !== undefined) {
    assert.deepEqual(
      [...wrongSnippet.sourceMentionRefs].sort(),
      [...WRONG_SNIPPET_REFS].sort(),
      "错误 snippet 应引用西岛珊瑚墙/小吃街提及",
    );
  }
  const bridgeChild = trip.stops[BRIDGE_STOP_CHILD];
  assert.ok(bridgeChild !== undefined && bridgeChild.visitRef === WUZZ_VISIT, "情人桥 child 应挂在蜈支洲岛下");

  // ---- 执行修复（最小字段集） ----
  const fromVisitId = transferAttachedStopAcrossVisits(trip, LOVERS_ISLAND_STOP, WUZZ_VISIT);
  assert.equal(fromVisitId, XIDAO_VISIT, "迁移来源应为西岛 visit");
  const removedSnippets = removeStopGuideSnippets(trip, LOVERS_ISLAND_STOP, [WRONG_SNIPPET_ID]);
  assert.ok(removedSnippets === 0 || removedSnippets === 1, "snippet 删除数应为 0（已清）或 1");
  if (wrongSnippet !== undefined) assert.equal(removedSnippets, 1, "错误 snippet 应被删除");

  // ---- save 前结构断言（save 内部还有一致性校验兜底） ----
  assert.deepEqual(xidao.childStopRefs, xidaoChildrenBefore.filter((id) => id !== LOVERS_ISLAND_STOP));
  assert.deepEqual(wuzz.childStopRefs, [...wuzzChildrenBefore, LOVERS_ISLAND_STOP]);
  assert.equal(island.visitRef, WUZZ_VISIT);
  assert.equal(island.order, wuzz.childStopRefs.length - 1);
  assert.equal((island.guideSnippets ?? []).length, 0, "情人岛不应再携带任何 snippet（本就无相关证据）");

  await tripStore.save(trip); // 一致性校验 + version 自增 + updatedAt

  // ---- 回读断言（落盘后的最终证据） ----
  const saved = await tripStore.load(TRIP_ID);
  assert.ok(saved !== null);
  const savedIsland = saved.stops[LOVERS_ISLAND_STOP]!;
  const savedXidao = saved.visits[XIDAO_VISIT]!;
  const savedWuzz = saved.visits[WUZZ_VISIT]!;
  assert.equal(savedIsland.visitRef, WUZZ_VISIT, "落盘后情人岛应归属蜈支洲岛");
  assert.equal(savedIsland.order, 1, "落盘后情人岛 order 应为蜈支洲岛 child 下标 1");
  assert.equal(savedIsland.guideSnippets, undefined, "落盘后情人岛 guideSnippets 字段应整体移除");
  assert.equal(savedIsland.suggestMinutes, island.suggestMinutes, "建议时长不变");
  assert.equal(savedIsland.userAdjusted, island.userAdjusted, "用户调整标记不变");
  assert.deepEqual(savedXidao.childStopRefs, ["stop_0ccfce0a-607b-4add-9c4d-6d03fe111b2a", "stop_dc6c2bfa-79ca-4bdb-8dfe-434707ec0d1c"]);
  assert.equal(savedXidao.effectiveMinutes, xidao.effectiveMinutes, "西岛时长字段保持持久值不重算");
  assert.deepEqual(savedWuzz.childStopRefs, ["stop_7499e93d-6908-4d79-a407-bb423c0b0e55", LOVERS_ISLAND_STOP]);
  // 西岛剩余 children order 重排为连续下标
  savedXidao.childStopRefs.forEach((id, order) => {
    assert.equal(saved.stops[id]?.order, order, `西岛剩余 child ${id} order 应为 ${order}`);
  });
  // 情人桥与变更外 Stop 全字段不变
  assert.deepEqual(saved.stops[BRIDGE_STOP_CHILD], bridgeChildBefore, "情人桥 child 应逐字段不变");
  for (const [stopId, before] of otherStopsBefore) {
    assert.deepEqual(saved.stops[stopId], before, `变更外 Stop ${stopId} 应逐字段不变`);
  }
  assert.equal(saved.version, beforeVersion + 1, "version 应恰好自增 1");

  console.log(
    [
      "[FIX-150] 修复完成并落盘：",
      `  情人岛 ${LOVERS_ISLAND_STOP}：西岛 child(order 2) → 蜈支洲岛 child(order 1)`,
      `  西岛 childStopRefs：${xidaoChildrenBefore.length} → ${savedXidao.childStopRefs.length} 个（order 重排连续）`,
      `  蜈支洲岛 childStopRefs：${wuzzChildrenBefore.length} → ${savedWuzz.childStopRefs.length} 个`,
      `  错误 snippet ${WRONG_SNIPPET_ID}（引用 ${WRONG_SNIPPET_REFS.join("，")}）：已删除`,
      `  Trip.version：${beforeVersion} → ${saved.version}`,
      "  情人桥（child + alternate）、珊瑚墙等真实相关证据：逐字段未变",
    ].join("\n"),
  );
}

// 主模块守卫：被 import（如 verify-task150.ts 复用纯函数）时不触发真实数据修复，
// 只有直接运行（npx tsx server/src/guides/fix-task150.ts）才执行。
const invokedAsMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedAsMain) {
  main().catch((error: unknown) => {
    console.error("[FIX-150] 失败：", error);
    process.exitCode = 1;
  });
}
