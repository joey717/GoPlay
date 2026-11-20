/**
 * Task #205 只读分享脱敏自检（`npx tsx server/src/share/verify-share.ts`）。
 *
 * 断言口径：
 * 1. 敏感集合与候选池完全不出现在分享载荷（键都不存在）；
 * 2. Visit / Stop / Item 的 sourceMentionRefs、sourceEvidenceRefs 全部清空，
 *    guideSnippets 保留 text 但剥离原句定位；
 * 3. 只保留排进行程的 Visit 与其引用的 Stop（待定玩法不随分享外泄）；
 * 4. 住宿 purchaseState / 酒店主数据 / 约束等公开事实保留；
 * 5. sanitizeTrip 不改写入参 Trip；
 * 6. 路由对不存在 / 非法 tripId 一律 404（不写盘、不探测）。
 */

import assert from "node:assert/strict";
import { Hono } from "hono";
import type { GuideSource, PendingGuideDraft, Trip, Visit } from "@goplay/shared";
import { buildFixtureSanyaTrip, tripStore } from "../persistence/store.js";
import { shareRoutes } from "./routes.js";
import { sanitizeTrip } from "./sanitize.js";

const TRIP_ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-10-23T06:00:00.000Z";

function buildSampleTrip(): Trip {
  const trip = buildFixtureSanyaTrip(TRIP_ID, NOW);

  // 攻略亮点（应保留 text、剥离引用）
  const wzz = trip.visits.visit_wzz as Visit;
  wzz.guideSnippets = [
    {
      snippetId: "sn_wzz_1",
      text: "早上第一班船上岛，人少不排队",
      claimKind: "tip",
      sourceMentionRefs: ["ev_note_1:m1"],
    },
  ];
  // 实用参考选项组（分享页不展示，应整组删除）
  wzz.optionGroups = [
    {
      groupId: "og_1",
      topic: "岛内交通",
      category: "transport",
      options: [
        {
          label: "观光车",
          priceText: "¥50",
          routeText: "环岛一周",
          sceneText: null,
          bargain: null,
          noteText: null,
          sourceMentionRefs: ["ev_note_1:m1"],
        },
      ],
      sourceMentionRefs: ["ev_note_1:m1"],
      collectedAt: NOW,
    },
  ];
  const bridge = trip.stops.stop_bridge;
  bridge.guideSnippets = [
    {
      snippetId: "sn_bridge_1",
      text: "铁索桥有点晃，扶好手机",
      claimKind: "experience",
      sourceMentionRefs: ["ev_note_1:m2"],
    },
  ];

  // 未排期 Visit（globalPool 壳）：不应出现在分享载荷
  trip.visits.visit_pool = {
    ...wzz,
    visitId: "visit_pool",
    dayRef: null,
    order: null,
    childStopRefs: [],
    alternateStopRefs: [],
    guideSnippets: undefined,
    optionGroups: undefined,
  };
  trip.itemRegistry.item_pool = {
    ...trip.itemRegistry.item_wzz,
    itemId: "item_pool",
    name: "未排期景点",
    sourceEvidenceRefs: ["ev_note_1"],
  };

  // 攻略来源 / 草案 / 补充句：全部应被删除
  trip.guideSources = {
    src_1: {
      sourceId: "src_1",
      sourceVersion: 1,
      inputKind: "text",
      active: true,
      status: "ready",
      evidenceRefs: ["ev_note_1"],
      mentionRefs: ["ev_note_1:m1"],
      imageProgress: { total: 0, completed: 0, failed: 0, images: [] },
      importedAt: NOW,
      updatedAt: NOW,
      sourceText: "攻略原文本不应外泄",
    } satisfies GuideSource,
  };
  trip.guideDraftNote = "把第二天留给岛上";
  trip.pendingGuideDraft = {
    draftId: "draft_1",
    baseTripVersion: 1,
    scope: { kind: "trip" },
    sourceSnapshots: [{ sourceId: "src_1", sourceVersion: 1 }],
    mentionIds: ["m1"],
    mentionRefs: ["ev_note_1:m1"],
    note: null,
    createdAt: NOW,
  } satisfies PendingGuideDraft;

  // 住宿：已订 + 关联酒店主数据（公开信息，应保留）
  const plan = trip.lodgings["2"];
  plan.purchaseState = "bought";
  plan.hotelRefs = ["hotel_1"];
  trip.hotelRegistry.hotel_1 = {
    id: "hotel_1",
    shId: "hotel_1",
    name: "海棠湾某度假酒店",
    brandName: null,
    star: "五星级",
    priceText: "¥880",
    priceBasis: "价格与库存以飞猪详情页为准",
    address: "海南省三亚市海棠区",
    interestsPoi: "近后海村",
    decorationTime: null,
    coords: null,
    mainPic: null,
    detailUrl: null,
    rate: null,
  };
  return trip;
}

function assertNoSensitiveKeys(payload: object): void {
  const record = payload as Record<string, unknown>;
  for (const key of [
    "evidences",
    "guideSources",
    "pendingGuideDraft",
    "guideDraftNote",
    "pendingStopRefs",
    "globalCandidateRefs",
    "relationshipSuggestions",
  ]) {
    assert.equal(key in record, false, `分享载荷不得包含 ${key}`);
  }
}

async function main(): Promise<void> {
  const trip = buildSampleTrip();
  const shared = sanitizeTrip(trip);

  // 1. 敏感键完全不存在
  assertNoSensitiveKeys(shared);

  // 2. 引用清空、亮点保留
  const sharedWzz = shared.visits.visit_wzz;
  assert.ok(sharedWzz, "已排期的大景区 Visit 必须保留");
  assert.deepEqual(sharedWzz.sourceMentionRefs, []);
  assert.equal(sharedWzz.guideSnippets?.[0]?.text, "早上第一班船上岛，人少不排队");
  assert.deepEqual(sharedWzz.guideSnippets?.[0]?.sourceMentionRefs, []);
  assert.equal(sharedWzz.optionGroups, undefined, "实用参考选项组不进入分享载荷");
  assert.equal(shared.stops.stop_bridge.guideSnippets?.[0]?.text, "铁索桥有点晃，扶好手机");
  assert.deepEqual(shared.stops.stop_bridge.sourceMentionRefs, []);
  assert.deepEqual(shared.stops.stop_bridge.sourceEvidenceRefs, []);
  assert.deepEqual(shared.itemRegistry.item_wzz.sourceEvidenceRefs, []);

  // 3. 只保留排进行程的 Visit / Stop；待定池不外泄
  assert.equal(shared.visits.visit_pool, undefined, "未排期 Visit 不进入分享载荷");
  assert.equal(shared.visits.visit_market !== undefined, true);
  assert.equal(shared.stops.stop_snack, undefined, "待定 Stop 不进入分享载荷");
  assert.equal(shared.stops.stop_bridge !== undefined, true);

  // 4. 公开事实保留
  assert.equal(shared.lodgings["2"].purchaseState, "bought");
  assert.equal(shared.hotelRegistry.hotel_1?.name, "海棠湾某度假酒店");
  assert.equal(shared.constraints.length, trip.constraints.length);
  assert.equal(shared.destination.city, "三亚");
  assert.equal(shared.updatedAt, trip.updatedAt);

  // 5. 纯函数：入参未被改写
  assert.deepEqual(trip.visits.visit_wzz.sourceMentionRefs, []);
  assert.equal(trip.visits.visit_wzz.guideSnippets?.[0]?.sourceMentionRefs[0], "ev_note_1:m1");
  assert.equal(trip.visits.visit_wzz.optionGroups?.[0]?.topic, "岛内交通");
  assert.ok(trip.evidences.ev_note_1, "原 Trip 证据必须原样保留");
  assert.ok(trip.guideSources?.src_1, "原 Trip 来源必须原样保留");

  // 6. 路由：不存在 / 非法 tripId → 404（只读，不产生写盘）
  const app = new Hono();
  app.route("/api/share", shareRoutes);
  const missing = await app.request("http://localhost/api/share/22222222-2222-4222-8222-222222222222");
  assert.equal(missing.status, 404);
  const invalid = await app.request("http://localhost/api/share/not-a-uuid");
  assert.equal(invalid.status, 404);

  // 7. 路由成功路径：200 + no-store + 脱敏载荷（load 打桩，全程不碰磁盘）
  const originalLoad = tripStore.load;
  tripStore.load = async (tripId: string) => (tripId === TRIP_ID ? trip : null);
  try {
    const ok = await app.request(`http://localhost/api/share/${TRIP_ID}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "no-store", "分享路由必须禁用缓存，始终取最新行程");
    const payload = (await ok.json()) as Record<string, unknown>;
    assert.equal(payload.tripId, TRIP_ID);
    assertNoSensitiveKeys(payload);
    assert.equal(payload.evidences, undefined);
    assert.equal(payload.version, trip.version);
  } finally {
    tripStore.load = originalLoad;
  }

  console.log("verify-share: 12 组断言全部通过（脱敏 / 只读 / 无写盘 / 路由行为）");
}

await main();
