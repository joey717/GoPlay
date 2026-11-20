import type { CreateTripSeed } from "./store.js";
import type { Trip } from "@goplay/shared";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { isValidTripId, tripStore, tripUploadsDir } from "./store.js";

export const persistenceRoutes = new Hono();

/** 受控图片扩展名 → Content-Type（截图 / 封面共用） */
const IMAGE_CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "行程存储操作失败";
}

/**
 * Trip 结构预检（rev2）：只做宽松形状检查，深度一致性与版本终检由 tripStore.save
 * 把关并整次拒绝。schemaVersion 接受两类请求体：数字（v2 正式契约；未来版本由
 * save 拒写）与 v1 存量形态（缺失视为 1 / "1.1" 字符串，save 会先防御性迁移）。
 */
function isTripLike(value: unknown): value is Trip {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Trip> & { schemaVersion?: unknown };
  const schemaVersionOk =
    candidate.schemaVersion === undefined ||
    typeof candidate.schemaVersion === "number" ||
    candidate.schemaVersion === "1.1";
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  return (
    typeof candidate.tripId === "string" &&
    schemaVersionOk &&
    typeof candidate.version === "number" &&
    Array.isArray(candidate.dayRefs) &&
    isRecord(candidate.days) &&
    isRecord(candidate.lodgings) &&
    isRecord(candidate.itemRegistry) &&
    isRecord(candidate.visits) &&
    isRecord(candidate.stops) &&
    isRecord(candidate.evidences) &&
    Array.isArray(candidate.globalCandidateRefs) &&
    Array.isArray(candidate.pendingStopRefs) &&
    Array.isArray(candidate.constraints)
  );
}

async function parseOptionalJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return {};
  return JSON.parse(text) as unknown;
}

persistenceRoutes.get("/trip/:tripId", async (c) => {
  try {
    const trip = await tripStore.load(c.req.param("tripId"));
    if (!trip) return c.json({ error: "行程不存在" }, 404);
    return c.json(trip);
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400);
  }
});

persistenceRoutes.put("/trip/:tripId", async (c) => {
  try {
    const body = (await c.req.json()) as unknown;
    if (!isTripLike(body)) {
      return c.json({ error: "请求体不是合法的 Trip 结构（schemaVersion 须为数字，或可迁移的 v1 存量形态）" }, 400);
    }
    if (body.tripId !== c.req.param("tripId")) {
      return c.json({ error: "路径 tripId 与请求体 tripId 不一致" }, 400);
    }
    await tripStore.save(body);
    return c.json(body);
  } catch (error) {
    // 一致性 / 版本校验失败时错误信息含全部可读原因（如「行程一致性校验失败，已拒绝写入：…」）
    return c.json({ error: errorMessage(error) }, 400);
  }
});

persistenceRoutes.post("/trip", async (c) => {
  try {
    const body = await parseOptionalJson(c.req.raw);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return c.json({ error: "创建参数必须是 JSON 对象" }, 400);
    }
    const seed = body as CreateTripSeed;
    return c.json(await tripStore.create(seed), 201);
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400);
  }
});

/**
 * DELETE /api/trips/:id —— 删除行程（Task #66）：Trip JSON 与该行程的攻略截图目录
 * 一并清理（store.deleteTrip 内部同步处理）。
 * - 非法 tripId → 400；
 * - 行程不存在（幂等 false）→ 404；
 * - 其余删除失败 → 500 + 安全文案（不透传底层错误细节）。
 */
persistenceRoutes.delete("/trips/:id", async (c) => {
  const tripId = c.req.param("id");
  if (!isValidTripId(tripId)) return c.json({ error: "非法的行程 ID" }, 400);
  try {
    const deleted = await tripStore.deleteTrip(tripId);
    if (!deleted) return c.json({ error: "行程不存在" }, 404);
    return c.json({ deleted: true });
  } catch {
    return c.json({ error: "删除行程失败，请稍后重试" }, 500);
  }
});

// ===== Task #65：攻略截图原图受控读取（不开放静态目录） =====

/** 截图文件名白名单：ev_shot_ + 8 位十六进制 + jpg/png（与 evidenceId 命名约定一致） */
const UPLOAD_FILENAME_PATTERN = /^ev_shot_[0-9a-f]{8}\.(jpg|png)$/;
/** 封面文件名白名单（Task #257）：cover.jpg / cover.png / cover.webp 三种格式互斥 */
const COVER_FILENAME_PATTERN = /^cover\.(jpg|png|webp)$/;

/** 受控读取允许的全部文件名（其余一律 400，不做目录列举） */
function isReadableUpload(filename: string): boolean {
  return UPLOAD_FILENAME_PATTERN.test(filename) || COVER_FILENAME_PATTERN.test(filename);
}

/**
 * GET /api/uploads/:tripId/:filename — 回看攻略截图原图（Task #65）。
 * 受控路由而非 serve-static：tripId 必须合法 UUID、filename 必须命中 evidenceId
 * 命名约定；显式拒绝 ".." 与路径分隔符杜绝目录穿越，二次校验解析后的绝对
 * 路径仍位于目标目录内；文件缺失返回 404。
 *
 * 注：小红书笔记图片（Task #87，/api/uploads/xhs_{noteId}/N.jpg）由
 * ai/xhs.ts 的 xhsAssetRoutes 先行处理，本路由只负责行程截图。
 */
persistenceRoutes.get("/uploads/:tripId/:filename", async (c) => {
  const tripId = c.req.param("tripId");
  const filename = c.req.param("filename");
  if (!isValidTripId(tripId) || !isReadableUpload(filename)) {
    return c.json({ error: "非法的截图路径" }, 400);
  }
  const dir = tripUploadsDir(tripId);
  const filePath = path.join(dir, filename);
  // 兜底校验：解析后的绝对路径必须仍在该目录内（防任何形式的路径穿越）
  if (!path.resolve(filePath).startsWith(path.resolve(dir) + path.sep)) {
    return c.json({ error: "非法的截图路径" }, 400);
  }
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return c.json({ error: "截图不存在" }, 404);
    const ext = path.extname(filename).slice(1).toLowerCase();
    c.header("Content-Type", IMAGE_CONTENT_TYPES[ext] ?? "application/octet-stream");
    c.header("Content-Length", String(stat.size));
    c.header("Cache-Control", "private, max-age=86400");
    const stream = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream<Uint8Array>;
    return c.body(stream, 200);
  } catch {
    return c.json({ error: "截图不存在" }, 404);
  }
});

// ===== Task #257：行程封面图（行程主人上传，写入 server/uploads/{tripId}/cover.{ext}） =====

/** 封面单图上限 8MB（手机原图直传足够，且与截图配额同量级） */
const COVER_MAX_BYTES = 8 * 1024 * 1024;
/** 三种封面文件的候选扩展名（更换格式时删除其余旧文件） */
const COVER_EXTS = ["jpg", "png", "webp"] as const;

/**
 * 按 magic bytes 识别图片格式（不信任客户端声明的 MIME / 文件名扩展）：
 * JPEG(FF D8 FF) / PNG(89 50 4E 47) / WEBP(RIFF....WEBP)；其余一律拒绝。
 */
function detectCoverExt(data: Uint8Array): "jpg" | "png" | "webp" | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpg";
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return "png";
  }
  if (
    data.length >= 12 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return "webp";
  }
  return null;
}

/** 删除该行程的旧封面文件（换格式 / 移除封面时清理，不存在则忽略） */
async function removeCoverFiles(tripId: string): Promise<void> {
  const dir = tripUploadsDir(tripId);
  await Promise.all(
    COVER_EXTS.map((ext) => fs.rm(path.join(dir, `cover.${ext}`), { force: true }).catch(() => undefined)),
  );
}

/**
 * POST /api/trip/:tripId/cover —— 上传 / 更换封面（multipart，文件字段 cover）。
 *
 * 职责边界：本路由只负责「文件落盘 + 返回受控相对路径」，不修改 Trip JSON——
 * coverImage 由 web 侧写入并走既有 PUT /api/trip/:tripId 全量保存，避免同一次操作
 * 双写导致 version 自增与前端本地快照互相覆盖。
 * 失败口径：非法 tripId 400 / 行程不存在 404 / 缺文件或格式不支持 400 / 超过 8MB 400。
 */
persistenceRoutes.post("/trip/:tripId/cover", async (c) => {
  const tripId = c.req.param("tripId");
  if (!isValidTripId(tripId)) return c.json({ error: "非法的行程 ID" }, 400);
  try {
    const trip = await tripStore.load(tripId);
    if (trip === null) return c.json({ error: "行程不存在" }, 404);
    const form = (await c.req.parseBody({ all: true }).catch(() => null)) as
      | Record<string, string | File | (string | File)[]>
      | null;
    if (form === null) {
      return c.json({ error: "请求必须是合法的 multipart/form-data 表单" }, 400);
    }
    const value = form.cover;
    const file = value instanceof File ? value : Array.isArray(value) ? value.find((item) => item instanceof File) : null;
    if (!(file instanceof File) || file.size === 0) {
      return c.json({ error: "请选择一张封面图片（cover 字段）" }, 400);
    }
    if (file.size > COVER_MAX_BYTES) {
      return c.json({ error: "封面图不能超过 8MB，请先压缩后重试" }, 400);
    }
    const data = new Uint8Array(await file.arrayBuffer());
    const ext = detectCoverExt(data);
    if (ext === null) {
      return c.json({ error: "仅支持 JPG / PNG / WebP 图片" }, 400);
    }
    const dir = tripUploadsDir(tripId);
    await fs.mkdir(dir, { recursive: true });
    // 先清旧格式再写新文件：两条格式同时存在会让前端缓存到过期图
    await removeCoverFiles(tripId);
    await fs.writeFile(path.join(dir, `cover.${ext}`), data);
    return c.json({ coverImage: `uploads/${tripId}/cover.${ext}` });
  } catch (error) {
    console.error("[persistence] 封面上传失败：", error);
    return c.json({ error: "封面上传失败，请稍后重试" }, 500);
  }
});

/**
 * DELETE /api/trip/:tripId/cover —— 移除封面文件（幂等）。
 * 同上传口径：只删文件，Trip.coverImage 由 web 侧清空并经 PUT 落盘。
 */
persistenceRoutes.delete("/trip/:tripId/cover", async (c) => {
  const tripId = c.req.param("tripId");
  if (!isValidTripId(tripId)) return c.json({ error: "非法的行程 ID" }, 400);
  try {
    const trip = await tripStore.load(tripId);
    if (trip === null) return c.json({ error: "行程不存在" }, 404);
    await removeCoverFiles(tripId);
    return c.json({ coverImage: null });
  } catch (error) {
    console.error("[persistence] 封面删除失败：", error);
    return c.json({ error: "移除封面失败，请稍后重试" }, 500);
  }
});
