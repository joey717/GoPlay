/**
 * AI 路由（挂载于 /api/ai）。
 *
 * - POST /intent          ：自然语言意图 → F11 流水线 → clarify / applied / proposal / rejected；
 *   请求体可选 sessionId（Task #70 多轮会话）：传入上一轮响应的 sessionId 且状态 idle
 *   时复用百炼会话（只发增量意图），响应体必带本轮实际使用的 sessionId，前端回传即可续接。
 * - POST /intent/confirm  ：提案确认后的二次下发通道，敏感操作（remove / setPurchase /
 *   lock）在此落地；服务端不信任客户端提交的操作，执行前仍过四条护栏。
 * - POST /session/archive ：归档百炼会话（Task #70 多轮收尾：行程完成 / 重开时调用）；
 *   归档失败不阻塞业务，恒返回 200（archived: true/false）。
 * - POST /extract         ：攻略笔记正文 → F5 抽取流水线 → AI 抽取点位 →
 *   FlyAI 真实搜索对齐 → 去重后入候选池。契约只接受正文（text）+ 来源链接
 *   （sourceUrl）；小红书代理图片不进入本接口，仅作前端来源参考，
 *   任何图片缺失/删除都不影响文字抽取（Task #90）。
 * - POST /extract-url     ：Task #87 小红书链接 → 抓取笔记标题 / 正文 / 图片 →
 *   图片落盘 server/uploads/xhs_{noteId}/；结果仅回填前端输入区，用户确认后
 *   再走 /extract 既有流水线（本接口不调用任何 AI）。
 * - POST /ocr             ：攻略截图 → Task #51 OCR 流水线 → 百炼 File API 上传 +
 *   图文识别 → OCR 原文 + 三级归属写入；百炼侧文件识别完即删，压缩图副本
 *   落盘 server/uploads/{tripId}/（Task #65，单行程 50MB 配额，失败只降级）。
 */

import type { Operation } from "@goplay/shared";
import { applyOps, checkGuards } from "@goplay/shared";
import { archiveSession, BailianTimeoutError } from "../bailian/client.js";
import type { Context } from "hono";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { tripStore } from "../persistence/store.js";
import { AiError, condenseErrorDetail } from "./errors.js";
import { extractFromNote } from "./extract.js";
import { extractFromScreenshot, isSupportedImage } from "./ocr.js";
import { executeIntent } from "./pipeline.js";
import { extractXhsNote, XhsError } from "./xhs.js";

export const aiRoutes = new Hono();

/** 请求体结构守卫：非法 JSON / 缺字段统一返回 400 */
async function parseJsonBody<T extends object>(c: Context): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

/** 提案确认操作的最小结构校验（完整语义校验交给护栏与执行器） */
function isOperationLike(value: unknown): value is Operation {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { op?: unknown }).op === "string"
  );
}

// POST /intent — 接收自然语言意图，执行 F11 流水线（Task #70：可选 sessionId 续接多轮会话）
aiRoutes.post("/intent", async (c) => {
  const body = await parseJsonBody<{ tripId?: string; input?: string; sessionId?: string }>(c);
  if (!body?.tripId || !body.input) {
    return c.json({ error: "tripId and input required" }, 400);
  }
  // sessionId 非字符串 / 空串一律视为新建（pipeline 对空值降级新建）
  const sessionId = typeof body.sessionId === "string" && body.sessionId !== "" ? body.sessionId : undefined;

  try {
    const result = await executeIntent(body.tripId, body.input, sessionId);
    // IntentResult.sessionId 必填：前端保存并在下一轮 /intent 原样回传续接会话
    return c.json(result);
  } catch (err) {
    console.error("[AI] Intent pipeline error:", err);
    return c.json({ type: "error", message: "意图处理失败，请重试" }, 500);
  }
});

// POST /intent/confirm — 用户确认提案后执行（敏感操作 / 全量重排落地通道）
aiRoutes.post("/intent/confirm", async (c) => {
  const body = await parseJsonBody<{ tripId?: string; operations?: unknown[]; baseVersion?: number }>(c);
  if (!body?.tripId || !Array.isArray(body.operations)) {
    return c.json({ error: "tripId and operations required" }, 400);
  }

  try {
    const trip = await tripStore.load(body.tripId);
    if (trip === null) return c.json({ error: "Trip not found" }, 404);

    // 乐观锁（PRD §9.5）：客户端携带的 baseVersion 与当前版本不符时拒绝，
    // 防止基于旧快照的确认覆盖并发修改；未携带时兼容旧客户端跳过此检查
    if (typeof body.baseVersion === "number" && body.baseVersion !== trip.version) {
      return c.json(
        {
          type: "error",
          message: `行程版本已更新（当前 v${trip.version}，请求基于 v${body.baseVersion}），请刷新后重试`,
        },
        409,
      );
    }

    // 确认不豁免护栏：客户端回传的操作仍须过 G1/G3（锁定项、已购项红线）
    const ops = body.operations.filter(isOperationLike);
    const guardResult = checkGuards(ops, trip);
    for (const rejection of guardResult.rejected) {
      console.warn(`[AI] confirm 护栏丢弃 ${rejection.guard}：${rejection.reason}`);
    }

    // confirmed=true + actor=user_confirmed：用户已在提案卡片确认，敏感操作直接落地
    const result = applyOps(trip, guardResult.passed, { confirmed: true, actor: "user_confirmed" });
    // 护栏拒绝项并入 rejected（形状对齐 ApplyResult，供前端逐条提示）
    for (const rejection of guardResult.rejected) {
      result.rejected.push({ op: rejection.op, reason: `[${rejection.guard}] ${rejection.reason}` });
    }

    // 一致性校验失败（shared 已整批回滚）：不落盘并显式报错，绝不静默保存不一致状态
    if (result.consistencyErrors.length > 0) {
      console.error(`[AI] confirm 应用后一致性校验失败，已整批回滚：${result.consistencyErrors.join("；")}`);
      return c.json(
        { type: "error", message: "操作应用后一致性校验失败，已整批回滚，行程未修改", result },
        409,
      );
    }

    if (result.applied.length > 0) {
      await tripStore.save(result.trip);
    }
    return c.json({ type: "applied", result });
  } catch (err) {
    console.error("[AI] Confirm pipeline error:", err);
    return c.json({ type: "error", message: "确认执行失败" }, 500);
  }
});

// POST /session/archive — 归档百炼会话（Task #70 多轮收尾：行程完成 / 重开时调用）
// 归档失败不影响业务：恒返回 200（archived: true/false），仅缺 sessionId 时 400
aiRoutes.post("/session/archive", async (c) => {
  const body = await parseJsonBody<{ sessionId?: string }>(c);
  if (!body?.sessionId || typeof body.sessionId !== "string" || body.sessionId === "") {
    return c.json({ error: "sessionId required" }, 400);
  }

  const archived = await archiveSession(body.sessionId);
  console.log(`[AI] 归档百炼 Session ${body.sessionId}：${archived ? "成功" : "失败（不阻塞业务）"}`);
  return c.json({ archived });
});

// POST /extract — 攻略笔记正文抽取（F5：AI 抽取 → FlyAI 对齐 → 去重入候选池）

/** BAILIAN_REQUEST_FAILED 自动重试的等待时长（ms）：多为瞬时网络/超时抖动 */
const EXTRACT_RETRY_DELAY_MS = 2_000;

/** /extract 错误响应的空形状：与成功响应同契约，统计字段补零保持前端读取稳定 */
function extractErrorBody(
  code: string,
  message: string,
): Record<string, unknown> {
  return {
    code,
    message,
    evidenceId: null,
    noteIndex: null,
    items: [],
    visits: [],
    stops: [],
    newVisitCount: 0,
    reusedVisitCount: 0,
    attachedStopCount: 0,
    pendingStopCount: 0,
    reusedStopCount: 0,
    errors: [message],
  };
}

aiRoutes.post("/extract", async (c) => {
  const body = await parseJsonBody<{ tripId?: string; text?: string; sourceUrl?: string }>(c);
  if (
    !body?.tripId ||
    typeof body.tripId !== "string" ||
    body.tripId.trim() === "" ||
    typeof body.text !== "string" ||
    body.text.trim() === ""
  ) {
    // Task #90：参数错误也走统一错误契约（code + 中文可读 message），
    // 不再返回只有英文 error 字段的 400——那会让前端只能显示兜底文案「请稍后重试」
    return c.json(
      extractErrorBody("INVALID_REQUEST", "缺少行程 ID 或笔记正文（正文不能为空），请补充后重试"),
      400,
    );
  }

  try {
    let result;
    try {
      result = await extractFromNote(body.tripId, body.text, body.sourceUrl);
    } catch (firstError) {
      // 仅对百炼请求失败自动重试一次（间隔 2s）：瞬时抖动无感恢复，前端无需手动重试；
      // 其余错误（配置/解析/持久化/行程不存在）语义明确，直接返回。
      // Task #91：超时已按放宽后的预算（120s）等待过一轮，再重试会让用户多等一个
      // 完整预算且大概率同样慢；仅对快速失败的请求抖动重试。
      const timedOut =
        firstError instanceof AiError && firstError.cause instanceof BailianTimeoutError;
      if (
        !(firstError instanceof AiError) ||
        firstError.code !== "BAILIAN_REQUEST_FAILED" ||
        timedOut
      ) {
        throw firstError;
      }
      console.warn(
        `[AI] Extract 百炼请求失败（${firstError.message}），${EXTRACT_RETRY_DELAY_MS / 1000}s 后自动重试一次`,
      );
      await new Promise((resolve) => setTimeout(resolve, EXTRACT_RETRY_DELAY_MS));
      result = await extractFromNote(body.tripId, body.text, body.sourceUrl);
    }
    return c.json(result);
  } catch (err) {
    console.error("[AI] Extract pipeline error:", err);
    // 分类错误响应：稳定 code + 用户可读 message；保留 v1.1 结构化字段的空形状
    //（evidenceId/noteIndex/items/visits/stops/errors + 统计零值），前端按新契约读取。
    // 上游原始堆栈仅进服务端日志；message 只附单行可读摘要（不含密钥）。
    const isAiError = err instanceof AiError;
    const code = isAiError ? err.code : "INTERNAL";
    // Task #90：非 AiError 的未预期异常也带真实原因（单行截断），
    // 不再统一“抽取失败，请重试”丢失诊断信息；完整堆栈已在上方日志中
    const message = isAiError ? err.message : `抽取失败（服务端内部错误：${condenseErrorDetail(err)}）`;
    const status = (isAiError ? err.status : 500) as ContentfulStatusCode;
    return c.json(extractErrorBody(code, message), status);
  }
});

// ===== Task #87 小红书链接抓取 =====

/** 链接长度上限：正常分享链接远小于此值，超长直接拒绝 */
const MAX_SOURCE_URL_LENGTH = 2_048;

// POST /extract-url — 小红书链接 → 标题 / 正文 / 本地图片路径（不经过 AI）
aiRoutes.post("/extract-url", async (c) => {
  const body = await parseJsonBody<{ url?: string }>(c);
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  if (url === "") {
    return c.json({ success: false, error: "请粘贴小红书笔记链接" }, 400);
  }
  if (url.length > MAX_SOURCE_URL_LENGTH) {
    return c.json({ success: false, error: "链接过长，请检查后重试" }, 400);
  }

  try {
    const note = await extractXhsNote(url);
    return c.json({
      success: true,
      title: note.title,
      text: note.text,
      images: note.images,
      sourceUrl: note.sourceUrl,
    });
  } catch (err) {
    // 抓取失败是常态（私密笔记 / 登录墙 / 页面改版）：返回可操作提示，前端降级为手动粘贴
    const message =
      err instanceof XhsError ? err.message : "无法提取该链接内容，请手动粘贴文字或上传截图";
    if (err instanceof XhsError) {
      console.warn(`[AI] 小红书链接抓取失败：${message}`);
    } else {
      console.error("[AI] 小红书链接抓取异常:", err);
    }
    return c.json({ success: false, error: message });
  }
});

// ===== Task #51 截图 OCR =====

/** 前端建议上限同服务端硬上限：JPEG / PNG ≤ 10MB（百炼侧上限 50MB，留足余量） */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** OCR 失败响应的空形状（与 /extract 契约对齐，多一个 ocrText 字段） */
function ocrErrorBody(code: string, message: string): Record<string, unknown> {
  return {
    code,
    message,
    evidenceId: null,
    ocrText: null,
    items: [],
    visits: [],
    stops: [],
    errors: [message],
  };
}

// POST /ocr — 攻略截图抽取（multipart：image 文件 + tripId + 可选 sourceUrl / editedText）
aiRoutes.post("/ocr", async (c) => {
  // multipart 解析失败（非 multipart / 损坏）统一按缺少图片处理
  let form: Record<string, string | File>;
  try {
    form = (await c.req.parseBody({ all: false })) as Record<string, string | File>;
  } catch (err) {
    console.error("[AI] OCR multipart parse error:", err);
    return c.json(ocrErrorBody("IMAGE_REQUIRED", "请求必须是 multipart/form-data 且包含图片文件"), 400 as ContentfulStatusCode);
  }

  const tripId = typeof form.tripId === "string" ? form.tripId.trim() : "";
  if (tripId === "") {
    return c.json(ocrErrorBody("IMAGE_REQUIRED", "缺少 tripId，无法定位行程"), 400 as ContentfulStatusCode);
  }

  const file = form.image instanceof File ? form.image : form.file instanceof File ? form.file : undefined;
  if (file === undefined) {
    return c.json(ocrErrorBody("IMAGE_REQUIRED", "请选择一张 JPEG / PNG 截图后再抽取"), 400 as ContentfulStatusCode);
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return c.json(
      ocrErrorBody("IMAGE_TOO_LARGE", `图片超过 10MB 上限（当前 ${(file.size / 1024 / 1024).toFixed(1)}MB），请压缩后重试`),
      413 as ContentfulStatusCode,
    );
  }

  const mimeType = file.type === "image/jpg" ? "image/jpeg" : file.type;
  let data: Uint8Array;
  try {
    data = new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    console.error("[AI] OCR read file error:", err);
    return c.json(ocrErrorBody("IMAGE_REQUIRED", "图片读取失败，请重新选择后重试"), 400 as ContentfulStatusCode);
  }
  // 服务端二次校验（防伪造 content-type）：magic bytes 判定 JPEG / PNG
  if (!isSupportedImage(data, mimeType)) {
    return c.json(
      ocrErrorBody("IMAGE_FORMAT_UNSUPPORTED", "仅支持 JPEG / PNG 图片，请转换格式后重试"),
      422 as ContentfulStatusCode,
    );
  }

  const sourceUrl = typeof form.sourceUrl === "string" ? form.sourceUrl : undefined;
  const editedText = typeof form.editedText === "string" ? form.editedText : undefined;

  try {
    const result = await extractFromScreenshot(
      tripId,
      {
        data,
        filename: file.name !== "" ? file.name : "screenshot",
        mimeType,
        sizeBytes: file.size,
      },
      { sourceUrl, editedText },
    );
    return c.json(result);
  } catch (err) {
    console.error("[AI] OCR pipeline error:", err);
    // 分类错误响应：稳定 code + 用户可读 message；上游细节仅进服务端日志
    const isAiError = err instanceof AiError;
    const code = isAiError ? err.code : "INTERNAL";
    const message = isAiError ? err.message : "图片识别失败，请重试";
    const status = (isAiError ? err.status : 500) as ContentfulStatusCode;
    return c.json(ocrErrorBody(code, message), status);
  }
});
