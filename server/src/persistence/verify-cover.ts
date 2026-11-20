/**
 * Task #257 行程封面自检（全程离线，`npx tsx server/src/persistence/verify-cover.ts`）。
 *
 * 断言口径（对齐已批准方案）：
 *  1. 上传：multipart（cover 字段）→ 落盘 server/uploads/{tripId}/cover.{ext}，
 *     响应只回受控相对路径，**不修改 Trip JSON**（coverImage 由 web 侧写入）；
 *  2. 受控读取：GET /api/uploads/:tripId/cover.{ext} 200 + 正确 Content-Type + 字节一致；
 *  3. 更换：换格式上传后旧格式文件被清理（旧路径 404），新路径 200；
 *  4. 删除：DELETE 清理全部格式（幂等），文件读取 404；
 *  5. 校验：非图片字节 / 缺文件 / 非法 tripId / 不存在的行程分别 400 / 400 / 400 / 404；
 *  6. Trip 三字段（coverImage / tripName / memo）经 PUT 全量保存后 GET 可读，且
 *     缺字段的旧形态 Trip 保存不会被拒（读时兼容 = 缺字段等价空值，无需迁移脚本）；
 *  7. 分享脱敏随载荷下发封面三字段（分享首屏需要），其余脱敏口径不变。
 *
 * 临时行程与封面文件在 finally 全部清理，不影响 server/data 既有数据。
 */

import "../env.js";
import assert from "node:assert/strict";
import { Hono } from "hono";
import type { Trip } from "@goplay/shared";
import { persistenceRoutes } from "./routes.js";
import { tripStore } from "./store.js";
import { sanitizeTrip } from "../share/sanitize.js";

const app = new Hono();
app.route("/api", persistenceRoutes);

/** 1×1 透明 PNG（真实可解码，用于验证字节原样落盘） */
const PNG_BYTES = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64",
  ),
);
/** 最小 JPEG 头（FF D8 FF E0 ... FF D9）：路由按 magic bytes 识别，不做解码 */
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
/** 最小 WebP 头（RIFF....WEBP） */
const WEBP_BYTES = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);

function fileForm(bytes: Uint8Array<ArrayBuffer>, filename: string, type: string): FormData {
  const form = new FormData();
  form.append("cover", new File([bytes], filename, { type }));
  return form;
}

async function uploadCover(
  tripId: string,
  bytes: Uint8Array<ArrayBuffer>,
  filename = "cover.png",
  type = "image/png",
): Promise<Response> {
  return app.request(`http://localhost/api/trip/${tripId}/cover`, {
    method: "POST",
    body: fileForm(bytes, filename, type),
  });
}

async function readUpload(tripId: string, filename: string): Promise<Response> {
  return app.request(`http://localhost/api/uploads/${tripId}/${filename}`);
}

async function putTrip(trip: Trip): Promise<Response> {
  return app.request(`http://localhost/api/trip/${trip.tripId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(trip),
  });
}

const created: string[] = [];
let checks = 0;

function ok(label: string): void {
  checks += 1;
  console.log(`  ✓ ${label}`);
}

async function main(): Promise<void> {
  const trip = await tripStore.create({
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: "2026-11-12", nights: 4 },
  });
  created.push(trip.tripId);
  const tripId = trip.tripId;

  console.log("1. 上传封面（PNG）");
  const pngRes = await uploadCover(tripId, PNG_BYTES);
  assert.equal(pngRes.status, 200);
  const pngBody = (await pngRes.json()) as { coverImage: string };
  assert.equal(pngBody.coverImage, `uploads/${tripId}/cover.png`);
  // 路由不写 Trip：coverImage 的落盘由 web 侧 PUT 负责
  const afterUpload = await tripStore.load(tripId);
  assert.equal(afterUpload?.coverImage, undefined);
  ok("上传返回受控相对路径，且不改写 Trip JSON");

  console.log("2. 受控读取封面");
  const served = await readUpload(tripId, "cover.png");
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  const servedBytes = new Uint8Array(await served.arrayBuffer());
  assert.deepEqual([...servedBytes], [...PNG_BYTES]);
  ok("GET /api/uploads/:tripId/cover.png 200、Content-Type 与字节一致");

  console.log("3. 更换封面（PNG → JPEG，旧格式清理）");
  const jpgRes = await uploadCover(tripId, JPEG_BYTES, "cover.jpg", "image/jpeg");
  assert.equal(jpgRes.status, 200);
  const jpgBody = (await jpgRes.json()) as { coverImage: string };
  assert.equal(jpgBody.coverImage, `uploads/${tripId}/cover.jpg`);
  assert.equal((await readUpload(tripId, "cover.png")).status, 404);
  assert.equal((await readUpload(tripId, "cover.jpg")).status, 200);
  assert.equal((await readUpload(tripId, "cover.jpg")).headers.get("content-type"), "image/jpeg");
  ok("换格式后旧文件 404、新文件 200");

  console.log("4. 上传校验（非图片 / 缺文件 / WebP）");
  const notImage = await uploadCover(tripId, Uint8Array.from([0x00, 0x01, 0x02, 0x03]), "cover.png");
  assert.equal(notImage.status, 400);
  assert.match(((await notImage.json()) as { error: string }).error, /JPG \/ PNG \/ WebP/);
  // 被拒的上传不得破坏已有封面
  assert.equal((await readUpload(tripId, "cover.jpg")).status, 200);
  const emptyForm = await app.request(`http://localhost/api/trip/${tripId}/cover`, {
    method: "POST",
    body: new FormData(),
  });
  assert.equal(emptyForm.status, 400);
  const webpRes = await uploadCover(tripId, WEBP_BYTES, "cover.webp", "image/webp");
  assert.equal(webpRes.status, 200);
  assert.equal(
    ((await webpRes.json()) as { coverImage: string }).coverImage,
    `uploads/${tripId}/cover.webp`,
  );
  assert.equal((await readUpload(tripId, "cover.jpg")).status, 404);
  ok("非图片 400（不破坏已有封面）、缺文件 400、WebP 可上传");

  console.log("5. 路由边界（非法 tripId / 不存在的行程 / 未知文件名）");
  assert.equal((await uploadCover("not-a-uuid", PNG_BYTES)).status, 400);
  assert.equal((await uploadCover("22222222-2222-4222-8222-222222222222", PNG_BYTES)).status, 404);
  assert.equal((await readUpload(tripId, "cover.svg")).status, 400);
  // 含 "/" 的文件名在路由层就不匹配（404），同样是拒绝；关键是绝不 200
  const traversal = await readUpload(tripId, "..%2Ftrip.json");
  assert.notEqual(traversal.status, 200);
  assert.equal((await readUpload(tripId, "..%2F..%2Fdata%2Ftrip.json")).status, 400);
  ok("非法 tripId 400、行程不存在 404、非白名单 / 穿越文件名一律拒绝");

  console.log("6. Trip 三字段读写（PUT 全量保存）");
  const withCover = await tripStore.load(tripId);
  assert.ok(withCover !== null);
  const nextTrip: Trip = {
    ...withCover,
    coverImage: "uploads/" + tripId + "/cover.webp",
    tripName: "三亚亲子五日",
    memo: "第 1 天落地先去酒店放行李；防晒霜记得托运。",
  };
  const putRes = await putTrip(nextTrip);
  assert.equal(putRes.status, 200, await putRes.clone().text());
  const saved = await tripStore.load(tripId);
  assert.equal(saved?.coverImage, `uploads/${tripId}/cover.webp`);
  assert.equal(saved?.tripName, "三亚亲子五日");
  assert.equal(saved?.memo, "第 1 天落地先去酒店放行李；防晒霜记得托运。");
  assert.equal(saved?.schemaVersion, 2);
  ok("coverImage / tripName / memo 经 PUT 落盘并可读，schemaVersion 不变（无需迁移）");

  console.log("7. 旧形态 Trip（缺三字段）保存不被拒");
  const legacy = await tripStore.load(tripId);
  assert.ok(legacy !== null);
  const legacyTrip: Trip = { ...legacy };
  delete legacyTrip.coverImage;
  delete legacyTrip.tripName;
  delete legacyTrip.memo;
  assert.equal((await putTrip(legacyTrip)).status, 200);
  const reloaded = await tripStore.load(tripId);
  assert.equal(reloaded?.coverImage, undefined);
  assert.equal(reloaded?.tripName, undefined);
  assert.equal(reloaded?.memo, undefined);
  ok("缺字段等价空值：保存 / 读取均正常，无需迁移脚本");

  console.log("8. 分享载荷透传封面三字段");
  const shared = sanitizeTrip({
    ...(reloaded as Trip),
    coverImage: `uploads/${tripId}/cover.webp`,
    tripName: "三亚亲子五日",
    memo: "带娃节奏放缓",
  });
  assert.equal(shared.coverImage, `uploads/${tripId}/cover.webp`);
  assert.equal(shared.tripName, "三亚亲子五日");
  assert.equal(shared.memo, "带娃节奏放缓");
  assert.equal("evidences" in shared, false);
  ok("SharedTrip 含封面三字段，且不含 evidences 等敏感集合");

  console.log("9. 移除封面（幂等）");
  const delRes = await app.request(`http://localhost/api/trip/${tripId}/cover`, { method: "DELETE" });
  assert.equal(delRes.status, 200);
  assert.deepEqual(await delRes.json(), { coverImage: null });
  assert.equal((await readUpload(tripId, "cover.webp")).status, 404);
  assert.equal((await readUpload(tripId, "cover.jpg")).status, 404);
  assert.equal((await readUpload(tripId, "cover.png")).status, 404);
  const delAgain = await app.request(`http://localhost/api/trip/${tripId}/cover`, { method: "DELETE" });
  assert.equal(delAgain.status, 200);
  ok("DELETE 清理全部格式并可重复调用");

  console.log(`\n[verify-cover] 全部通过：${checks} 组断言`);
}

main()
  .catch((error: unknown) => {
    console.error("[verify-cover] 失败：", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    const removed: string[] = [];
    for (const tripId of created) {
      try {
        if (await tripStore.deleteTrip(tripId)) removed.push(tripId);
      } catch {
        /* 清理失败不掩盖主断言结果 */
      }
    }
    if (created.length > 0) {
      console.log(`[verify-cover] 已清理 ${removed.length}/${created.length} 个临时行程及其封面目录`);
    }
  });
