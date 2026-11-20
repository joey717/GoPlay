/**
 * Task #260 分享页受限状态打标自检（`npx tsx server/src/share/verify-status.ts`）。
 *
 * 断言口径：
 * 1. 合法补丁：只能改动 purchaseState，其余字段（锁定 / 排期 / 证据引用等）原样不变，
 *    响应为脱敏 SharedTrip（不含 evidences / guideSources 等敏感集合），
 *    并只发生一次 save（读 → 改 → 原子写）；
 * 2. 非法 visitId / 非法 dayIndex（无住宿计划）/ 非法枚举值 → 400 且不写盘；
 * 3. 整批语义：一条非法即整批拒绝，合法项也不落地（无半批量写入）；
 * 4. 请求体里的其他字段被忽略，无法借这个端点改其他数据；
 * 5. 非法 tripId / 行程不存在 → 404；请求体非 JSON / 空对象 → 400；
 * 6. GET 只读行为不受影响（仍 200 + no-store + 脱敏）。
 */

import assert from "node:assert/strict";
import { Hono } from "hono";
import type { Trip } from "@goplay/shared";
import { buildFixtureSanyaTrip, tripStore } from "../persistence/store.js";
import { shareRoutes } from "./routes.js";

const TRIP_ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-10-26T06:00:00.000Z";

const app = new Hono();
app.route("/api/share", shareRoutes);

/** 每次用例独立行程 + 记录 save 次数（不打桩真实磁盘写入，避免污染 server/data） */
function setupTrip(): { trip: Trip; saves: () => number } {
  const trip = buildFixtureSanyaTrip(TRIP_ID, NOW);
  let saveCount = 0;
  tripStore.load = async (tripId: string) => (tripId === TRIP_ID ? trip : null);
  tripStore.save = async (input: Trip) => {
    saveCount += 1;
    // 复刻真实 store 的可观测副作用（版本自增 + 更新时间），但绝不落盘
    input.version = (Number.isInteger(input.version) ? input.version : 0) + 1;
    input.updatedAt = new Date().toISOString();
  };
  return { trip, saves: () => saveCount };
}

function patchRequest(body: string, tripId = TRIP_ID): Promise<Response> {
  return Promise.resolve(
    app.request(`http://localhost/api/share/${tripId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body,
    }),
  );
}

interface SharePayload {
  version: number;
  visited?: unknown;
  evidences?: unknown;
  guideSources?: unknown;
  visits: Record<string, { purchaseState: string; locked: boolean; dayRef: string | null }>;
  lodgings: Record<string, { purchaseState: string; hotelRefs: string[] }>;
  [key: string]: unknown;
}

async function main(): Promise<void> {
  const originalLoad = tripStore.load;
  const originalSave = tripStore.save;
  try {
    // ===== 1. 合法更新（景点 + 住宿同批） =====
    {
      const { trip, saves } = setupTrip();
      const versionBefore = trip.version;
      const beforeMarket = JSON.parse(JSON.stringify(trip.visits.visit_market)) as Record<string, unknown>;
      const beforeLodging2 = JSON.parse(JSON.stringify(trip.lodgings["2"])) as Record<string, unknown>;

      const res = await patchRequest(
        JSON.stringify({
          visits: [{ visitId: "visit_wzz", purchaseState: "noTicket" }],
          lodgings: [{ dayIndex: 1, purchaseState: "bought" }],
        }),
      );
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      const payload = (await res.json()) as SharePayload;

      assert.equal(payload.visits.visit_wzz.purchaseState, "noTicket");
      assert.equal(payload.lodgings["1"].purchaseState, "bought");
      assert.equal(payload.version, versionBefore + 1, "保存后版本必须自增");
      assert.equal(saves(), 1, "一次补丁只允许一次 save（原子写）");
      assert.equal("evidences" in payload, false, "响应仍是脱敏载荷");
      assert.equal("guideSources" in payload, false);

      // 只动 purchaseState：其余字段保持不变
      assert.equal(payload.visits.visit_wzz.locked, false);
      assert.equal(payload.visits.visit_wzz.dayRef, "day_2");

      // 未在补丁里的对象完全不受影响
      assert.equal(payload.visits.visit_market.purchaseState, beforeMarket.purchaseState);
      assert.equal(payload.visits.visit_market.locked, beforeMarket.locked);
      assert.equal(payload.lodgings["2"].purchaseState, beforeLodging2.purchaseState);
      assert.deepEqual(payload.lodgings["1"].hotelRefs, []);
      assert.equal(trip.visits.visit_wzz.locked, false);
    }

    // ===== 2. 非法 visitId → 400 且不写盘 =====
    {
      const { trip, saves } = setupTrip();
      const res = await patchRequest(
        JSON.stringify({ visits: [{ visitId: "visit_not_exists", purchaseState: "bought" }] }),
      );
      assert.equal(res.status, 400);
      const payload = (await res.json()) as { error?: string };
      assert.match(payload.error ?? "", /景点不在行程中/);
      assert.equal(saves(), 0, "校验失败不得写盘");
      assert.equal(trip.visits.visit_wzz.purchaseState, "unknown");
    }

    // ===== 3. 非法枚举值 → 400（景点 / 住宿都不接受越界值） =====
    {
      const { saves } = setupTrip();
      const badVisit = await patchRequest(
        JSON.stringify({ visits: [{ visitId: "visit_wzz", purchaseState: "refunded" }] }),
      );
      assert.equal(badVisit.status, 400);
      const badLodging = await patchRequest(
        JSON.stringify({ lodgings: [{ dayIndex: 1, purchaseState: "noTicket" }] }),
      );
      assert.equal(badLodging.status, 400, "住宿没有免票档，noTicket 必须拒绝");
      assert.equal(saves(), 0);
    }

    // ===== 4. 非法 dayIndex（无住宿计划）→ 400 =====
    {
      const { saves } = setupTrip();
      const noPlan = await patchRequest(
        JSON.stringify({ lodgings: [{ dayIndex: 5, purchaseState: "bought" }] }),
      );
      assert.equal(noPlan.status, 400);
      assert.match(((await noPlan.json()) as { error?: string }).error ?? "", /没有住宿计划/);
      const outOfRange = await patchRequest(
        JSON.stringify({ lodgings: [{ dayIndex: 99, purchaseState: "bought" }] }),
      );
      assert.equal(outOfRange.status, 400);
      assert.equal(saves(), 0);
    }

    // ===== 5. 整批拒绝：一条非法 → 合法项也不落地 =====
    {
      const { trip, saves } = setupTrip();
      const res = await patchRequest(
        JSON.stringify({
          visits: [
            { visitId: "visit_wzz", purchaseState: "bought" },
            { visitId: "visit_market", purchaseState: "nope" },
          ],
        }),
      );
      assert.equal(res.status, 400);
      assert.equal(saves(), 0);
      assert.equal(trip.visits.visit_wzz.purchaseState, "unknown", "整批拒绝时合法项也不得写入");
    }

    // ===== 6. 其他字段被忽略（不能借端点改锁定 / 排期） =====
    {
      const { trip } = setupTrip();
      const res = await patchRequest(
        JSON.stringify({
          visits: [{ visitId: "visit_wzz", purchaseState: "bought", locked: true, dayRef: "day_5", order: 9 }],
          lodgings: [{ dayIndex: 1, purchaseState: "toBuy", locked: true, areaName: "亚龙湾" }],
        }),
      );
      assert.equal(res.status, 200);
      assert.equal(trip.visits.visit_wzz.purchaseState, "bought");
      assert.equal(trip.visits.visit_wzz.locked, false, "锁定期不得被分享端点改动");
      assert.equal(trip.visits.visit_wzz.dayRef, "day_2");
      assert.equal(trip.visits.visit_wzz.order, 0);
      assert.equal(trip.lodgings["1"].locked, false);
      assert.equal(trip.lodgings["1"].areaName, "海棠湾");
    }

    // ===== 7. 非法 tripId / 行程不存在 → 404；空体 / 非 JSON → 400 =====
    {
      setupTrip();
      const invalidId = await patchRequest(JSON.stringify({ visits: [] }), "not-a-uuid");
      assert.equal(invalidId.status, 404);
      const missingTrip = await patchRequest(
        JSON.stringify({ visits: [{ visitId: "visit_wzz", purchaseState: "bought" }] }),
        "22222222-2222-4222-8222-222222222222",
      );
      assert.equal(missingTrip.status, 404);
      const emptyBody = await patchRequest(JSON.stringify({}));
      assert.equal(emptyBody.status, 400);
      assert.match(((await emptyBody.json()) as { error?: string }).error ?? "", /没有要更新的状态/);
      const malformed = await patchRequest("not-json");
      assert.equal(malformed.status, 400);
      const wrongShape = await patchRequest(JSON.stringify({ visits: "visit_wzz" }));
      assert.equal(wrongShape.status, 400);
    }

    // ===== 8. GET 只读行为不受影响 =====
    {
      setupTrip();
      const res = await app.request(`http://localhost/api/share/${TRIP_ID}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      const payload = (await res.json()) as SharePayload;
      assert.equal("evidences" in payload, false);
    }

    console.log(
      "verify-status: 8 组断言全部通过（合法更新 / 只写 purchaseState / 整批拒绝 / 枚举与 id 校验 / 404 / 400 / 原子写 / GET 不变）",
    );
  } finally {
    tripStore.load = originalLoad;
    tripStore.save = originalSave;
  }
}

await main();
