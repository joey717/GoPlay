/**
 * Task #150（情人岛归属修复 + snippet 强证据挂载）确定性回归（全程离线）：
 *
 * Part 1 迁移纯函数（fix-task150.ts 同一实现，fixture 复测）：
 *   1. 跨 Visit 迁移：child → 目标 child 末尾，visitRef / order 同步，
 *      来源剩余 children order 重排连续；变更外 Stop（情人桥）逐字段不变；
 *   2. 幂等与前置拒绝：已迁 / pending / alternate / 不存在实体返回 null 不改结构；
 *   3. snippet 精确删除：只删指定 snippetId，真实相关 snippet 保留；删空移除字段。
 *
 * Part 2 attachDraftSnippets 强证据校验（Task #150，planner 桩注入不触网，
 *   经 POST /draft + /draft/apply 全链路，复刻现场错挂形态）：
 *   4. 无关实体拒挂：情人桥 mention → 观日岩 Stop（珊瑚墙错挂情人岛同构）不挂载；
 *   5. 兄弟实体拒挂：后海村 mention → 情人桥 Stop（无归属无父子无名称匹配）不挂载；
 *   6. 名称全等挂载：情人桥 mention → 情人桥 Stop 正常挂载（相关证据保留）；
 *   7. 名称整体包含挂载：「海滨浴场」→「蜈支洲岛海滨浴场」正常挂载；
 *   8. 明确父子挂载：子 Stop 已归属的情人桥 mention → 父大景区 Visit（父卡聚合）挂载；
 *   9. 既有归属挂载：ref 已写入实体 sourceMentionRefs（名称不匹配）仍挂载。
 *
 * 运行：npx tsx server/src/guides/verify-task150.ts
 * 临时行程（server/data）在脚本末尾全部清理，不影响用户既有数据。
 */

import "../env.js";
import assert from "node:assert/strict";
import type { GuideSource, PendingGuideDraft, SourceEvidence, Stop, Trip } from "@goplay/shared";
import { createEmptyGuideImageProgress } from "@goplay/shared";
import { createFixtureSanyaTrip, tripStore } from "../persistence/store.js";
import { removeStopGuideSnippets, transferAttachedStopAcrossVisits } from "./fix-task150.js";
import { setGuidePlannerDeps } from "./planner.js";
import { guideRoutes } from "./routes.js";

function pass(name: string): void {
  console.log(`✓ ${name}`);
}

/** 本脚本创建的临时行程：finally 统一清理 */
const createdTripIds: string[] = [];

async function requestJson(
  routePath: string,
  method: "POST",
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await guideRoutes.request(routePath, init);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function load(tripId: string): Promise<Trip> {
  const trip = await tripStore.load(tripId);
  assert.ok(trip !== null, `行程 ${tripId} 应存在`);
  return trip;
}

// ===== Part 1：迁移 / 删除纯函数 =====

async function runPart1(): Promise<void> {
  const trip = await createFixtureSanyaTrip();
  createdTripIds.push(trip.tripId);

  // 现场同构：stop_rock 携带一条错误 snippet（无关引用）+ 一条真实相关 snippet
  const rock = trip.stops.stop_rock!;
  rock.guideSnippets = [
    {
      snippetId: "gsn_wrong",
      text: "穿过小吃街左手边就是珊瑚墙，很好看",
      claimKind: "route_listing",
      sourceMentionRefs: ["ev_note_1:m4"], // 借用同证据其他地点的提及（模拟 m6/m7 错挂形态）
    },
    {
      snippetId: "gsn_right",
      text: "观日岩下午视野最好",
      claimKind: "tip",
      sourceMentionRefs: ["ev_note_1:m4"],
    },
  ];
  const bridgeBefore = JSON.parse(JSON.stringify(trip.stops.stop_bridge)) as Stop;
  const beachBefore = JSON.parse(JSON.stringify(trip.stops.stop_beach)) as Stop;

  // 1. 跨 Visit 迁移（child → child 末尾；夹具 stop_rock 在 day2 的 visit_wzz 下，
  //    目标 visit_market 在 day3 —— 与现场「西岛 Day2 → 蜈支洲岛 Day3」同构）
  const fromVisitId = transferAttachedStopAcrossVisits(trip, "stop_rock", "visit_market");
  assert.equal(fromVisitId, "visit_wzz", "迁移来源应为 visit_wzz");
  assert.deepEqual(trip.visits.visit_wzz?.childStopRefs, ["stop_bridge", "stop_beach"], "来源剩余 children 应为两人");
  assert.deepEqual(trip.visits.visit_market?.childStopRefs, ["stop_rock"], "目标 children 应含迁移项");
  assert.equal(rock.visitRef, "visit_market");
  assert.equal(rock.order, 0, "目标末尾 order 应为新下标 0");
  assert.equal(trip.stops.stop_bridge?.order, 0, "来源剩余 child order 应重排 0");
  assert.equal(trip.stops.stop_beach?.order, 1, "来源剩余 child order 应重排 1");
  assert.deepEqual(trip.stops.stop_bridge, bridgeBefore, "情人桥应逐字段不变");
  assert.deepEqual(trip.stops.stop_beach, beachBefore, "海滨浴场应逐字段不变");
  pass("1. 跨 Visit 迁移：child 末尾追加 / 来源 order 重排 / 情人桥等变更外 Stop 逐字段不变");

  // 2. 幂等与前置拒绝
  assert.equal(transferAttachedStopAcrossVisits(trip, "stop_rock", "visit_market"), null, "已在目标下应返回 null");
  assert.equal(transferAttachedStopAcrossVisits(trip, "stop_ghost", "visit_market"), null, "不存在的 stop 返回 null");
  assert.equal(transferAttachedStopAcrossVisits(trip, "stop_snack", "visit_market"), null, "pending stop 返回 null");
  assert.equal(
    transferAttachedStopAcrossVisits(trip, "stop_rock", "visit_nowhere"),
    null,
    "不存在的目标 visit 返回 null",
  );
  assert.deepEqual(trip.visits.visit_market?.childStopRefs, ["stop_rock"], "拒绝路径不得改结构");
  pass("2. 幂等与前置拒绝：已迁 / pending / 幽灵实体 / 幽灵目标均返回 null 且不改结构");

  // 3. snippet 精确删除：只删错误条目，真实相关条目保留
  const removed = removeStopGuideSnippets(trip, "stop_rock", ["gsn_wrong"]);
  assert.equal(removed, 1);
  assert.deepEqual(
    (trip.stops.stop_rock?.guideSnippets ?? []).map((snippet) => snippet.snippetId),
    ["gsn_right"],
    "真实相关 snippet 应保留",
  );
  assert.equal(removeStopGuideSnippets(trip, "stop_rock", ["gsn_absent"]), 0, "不存在的 snippetId 返回 0");
  const removedLast = removeStopGuideSnippets(trip, "stop_rock", ["gsn_right"]);
  assert.equal(removedLast, 1);
  assert.equal(trip.stops.stop_rock?.guideSnippets, undefined, "删空后应整体移除 guideSnippets 字段");
  assert.equal(removeStopGuideSnippets(trip, "stop_bridge", ["gsn_any"]), 0, "无 snippet 的 stop 返回 0");
  pass("3. snippet 精确删除：指定条目删除 / 相关条目保留 / 删空移除字段");
}

// ===== Part 2：attachDraftSnippets 强证据校验（HTTP 全链路） =====

function mkMention(
  mentionId: string,
  text: string,
  quoteText: string,
  extractedName: string | null,
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

async function runPart2(): Promise<void> {
  const created = await createFixtureSanyaTrip();
  createdTripIds.push(created.tripId);
  const tripId = created.tripId;
  const trip = await load(tripId);

  // 夹具实体：stop_bridge=情人桥（child of visit_wzz 蜈支洲岛）；
  // stop_beach=蜈支洲岛海滨浴场；stop_rock=蜈支洲岛旅游风景区-观日岩
  trip.visits.visit_wzz.sourceMentionRefs = ["ev_note_1:m1"];
  trip.stops.stop_bridge.sourceMentionRefs = ["ev_note_1:m2", "ev_shot_2:n1"];
  trip.stops.stop_beach.sourceMentionRefs = ["ev_note_1:m3"];
  trip.stops.stop_rock.sourceMentionRefs = ["ev_note_1:m4", "ev_note_3:c2"]; // c2 = 既有归属案例（名称不匹配）
  trip.evidences["ev_shot_2"] = {
    evidenceId: "ev_shot_2",
    kind: "screenshot",
    noteIndex: null,
    assetRef: null,
    sourceUrl: null,
    ocrText: "蜈支洲岛攻略",
    mentions: [
      mkMention("n1", "情人桥", "情人桥一定要早上8点前上去，人最少", "情人桥"),
      mkMention("n2", "蜈支洲岛", "下午两点后旅行团走了人也少", "蜈支洲岛"),
      mkMention("n3", "后海村", "后海村夜市晚上7点后热闹", "后海村"),
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
      mkMention("c1", "后海村", "后海村吃海鲜推荐林姐香味", "后海村"),
      mkMention("c2", "风险提示", "码头旁边那家摊位海鲜可能不新鲜，谨慎", null),
    ],
  };
  const sources = (trip.guideSources ??= {});
  const mkSource = (sourceId: string, evidenceRefs: string[], mentionRefs: string[]): GuideSource => ({
    sourceId,
    sourceVersion: 1,
    inputKind: "text",
    title: `来源${sourceId}`,
    active: true,
    status: "ready",
    evidenceRefs,
    mentionRefs,
    imageProgress: createEmptyGuideImageProgress(),
    importedAt: "2026-10-19T08:00:00.000Z",
    updatedAt: "2026-10-19T08:00:00.000Z",
  });
  sources["src_p2a"] = mkSource("src_p2a", ["ev_note_1"], [
    "ev_note_1:m1",
    "ev_note_1:m2",
    "ev_note_1:m3",
    "ev_note_1:m4",
  ]);
  sources["src_p2b"] = mkSource("src_p2b", ["ev_shot_2"], ["ev_shot_2:n1", "ev_shot_2:n2", "ev_shot_2:n3"]);
  sources["src_p2c"] = mkSource("src_p2c", ["ev_note_3"], ["ev_note_3:c1", "ev_note_3:c2"]);
  await tripStore.save(trip);

  // 桩草案：6 条 snippet = 4 条强证据挂载 + 2 条无关拒挂
  const stubDraft = JSON.stringify({
    operations: [],
    snippets: [
      {
        text: "情人桥早上8点前上去人最少", // 6. 名称全等（情人桥 = 情人桥）
        claimKind: "tip",
        targetRef: { kind: "stop", id: "stop_bridge" },
        sourceMentionRefs: ["ev_shot_2:n1"],
      },
      {
        text: "穿过小吃街左手边就是珊瑚墙，很好看", // 4. 无关拒挂（情人桥 mention → 观日岩）
        claimKind: "route_listing",
        targetRef: { kind: "stop", id: "stop_rock" },
        sourceMentionRefs: ["ev_shot_2:n1"],
      },
      {
        text: "海滨浴场留足一个半小时", // 7. 名称整体包含（海滨浴场 ⊂ 蜈支洲岛海滨浴场）
        claimKind: "tip",
        targetRef: { kind: "stop", id: "stop_beach" },
        sourceMentionRefs: ["ev_note_1:m3"],
      },
      {
        text: "上岛先走情人桥再到海滨浴场", // 8. 父子挂载（子 stop_bridge 已归属 m2 → 父 visit_wzz）
        claimKind: "route_listing",
        targetRef: { kind: "visit", id: "visit_wzz" },
        sourceMentionRefs: ["ev_note_1:m2"],
      },
      {
        text: "码头摊位海鲜可能不新鲜", // 9. 既有归属（c2 已写入 stop_rock.sourceMentionRefs，名称不匹配）
        claimKind: "risk",
        targetRef: { kind: "stop", id: "stop_rock" },
        sourceMentionRefs: ["ev_note_3:c2"],
      },
      {
        text: "后海村夜市晚上7点后热闹", // 5. 兄弟实体拒挂（后海村 → 情人桥：无任何强证据）
        claimKind: "experience",
        targetRef: { kind: "stop", id: "stop_bridge" },
        sourceMentionRefs: ["ev_shot_2:n3"],
      },
    ],
  });

  setGuidePlannerDeps({
    callPlanner: async () => stubDraft,
  });

  const genRes = await requestJson(`/trips/${tripId}/draft`, "POST", { scope: { kind: "trip" } });
  assert.equal(genRes.status, 200, `生成应 200（实际 ${JSON.stringify(genRes.body)}）`);
  const applyRes = await requestJson(`/trips/${tripId}/draft/apply`, "POST");
  assert.equal(applyRes.status, 200, `应用应 200（实际 ${JSON.stringify(applyRes.body)}）`);
  assert.equal(applyRes.body.attachedSnippetCount, 4, "仅 4 条强证据 snippet 应挂载（2 条无关拒挂）");

  const saved = await load(tripId);
  const bridgeSnippets = saved.stops.stop_bridge?.guideSnippets ?? [];
  assert.equal(bridgeSnippets.length, 1, "情人桥只应挂名称全等的 1 条（后海村条目拒挂）");
  assert.equal(bridgeSnippets[0]?.text, "情人桥早上8点前上去人最少");
  assert.deepEqual(bridgeSnippets[0]?.sourceMentionRefs, ["ev_shot_2:n1"]);

  const rockSnippets = saved.stops.stop_rock?.guideSnippets ?? [];
  assert.equal(rockSnippets.length, 1, "观日岩只应挂既有归属的 1 条（情人桥借引条目拒挂）");
  assert.equal(rockSnippets[0]?.text, "码头摊位海鲜可能不新鲜");

  const beachSnippets = saved.stops.stop_beach?.guideSnippets ?? [];
  assert.equal(beachSnippets.length, 1, "海滨浴场应挂名称整体包含的 1 条");
  assert.equal(beachSnippets[0]?.text, "海滨浴场留足一个半小时");

  const wzzSnippets = saved.visits.visit_wzz?.guideSnippets ?? [];
  assert.equal(wzzSnippets.length, 1, "父景区应挂子 stop 已归属提及的 1 条（父卡聚合方向）");
  assert.deepEqual(wzzSnippets[0]?.sourceMentionRefs, ["ev_note_1:m2"]);

  const draft = saved.pendingGuideDraft as PendingGuideDraft | undefined;
  assert.equal(draft, undefined, "草案应一次性消费");
  pass("4-9. 强证据校验：无关/兄弟拒挂；名称全等/整体包含/父子/既有归属正常挂载");
}

// ===== 入口 =====

async function main(): Promise<void> {
  await runPart1();
  await runPart2();
  console.log("\nverify-task150 全部通过。");
}

main()
  .catch((error: unknown) => {
    console.error("verify-task150 失败：", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const tripId of createdTripIds) {
      try {
        await tripStore.deleteTrip(tripId);
      } catch (error) {
        console.warn(`[verify] 清理临时行程 ${tripId} 失败:`, error);
      }
    }
  });
