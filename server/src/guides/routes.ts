/**
 * 攻略来源路由（Task #96，挂载于 /api/guides）。
 *
 * - POST /trips/:tripId/sources                     提交来源
 *   · application/json：{ inputKind: "link" | "text", url?, text?, title?, sourceUrl? }
 *   · multipart/form-data：images 模式（images 文件字段 1..12 张 + 可选 title / sourceUrl）
 *   · 先原子创建 processing 来源并保存，两秒内返回 sourceId 与当前状态；
 *     抓取 / 抽取 / 图片识别全部后台异步，前端用状态接口轮询。
 * - GET  /trips/:tripId/sources                     来源列表（读取前触发重启恢复扫描）
 * - GET  /trips/:tripId/sources/:sourceId           单个来源状态
 * - POST /trips/:tripId/sources/:sourceId/retry     重试剩余图片（failed 来源重跑全流程）
 * - POST /trips/:tripId/sources/:sourceId/ocr-images 一键解析待解析图片（Task #215：
 *   图片默认不自动 OCR，imageOcrDeferred 来源手动触发全部待解析图）
 * - POST /trips/:tripId/sources/:sourceId/retry-image 单图重试（Task #231：
 *   body { index }，只重跑指定失败图，不整批重来）
 * - POST /trips/:tripId/sources/:sourceId/remove    软移除（active=false；证据与原图保留）
 * - POST /trips/:tripId/sources/:sourceId/restore   恢复已移除来源
 * - PUT  /trips/:tripId/draft-note                  保存攻略补充句（空串 / 缺省清除）
 *
 * B3 攻略草案（Task #97）：
 * - POST /trips/:tripId/draft                       生成草案：合并 mentions → planner prompt
 *   → 百炼生成 → 保存 Trip.pendingGuideDraft（body: { scope?: DraftScope, note?,
 *   sourceMode?: "all" | "selected", selectedSourceIds?: string[],
 *   entryContext?: GuideDraftEntryContext }；Task #161 局部优化；Task #176 scope
 *   可缺省自动判定，entryContext 为面板入口上下文非用户可见控件）；
 *   长耗时（≤300s，Task #110 自 180s 放宽；多篇攻略合并耗时较长）同步返回，不做两秒异步模式（草案是用户显式触发的低频动作）；
 * - POST /trips/:tripId/draft/apply                 应用当前草案：版本保护（附录 B §2.4）
 *   → 四条护栏 → applyOps 确认分流（敏感转 ProposalCard）→ 挂载 snippets。
 *
 * 错误契约与 /api/ai 一致：稳定 code + 用户可读 message + 与成功响应同形的
 * 结构化空形状；上游细节（原始堆栈 / 抓取失败详情）只进服务端日志。
 */

import type { Context } from "hono";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { DraftScope } from "@goplay/shared";
import { AiError, condenseErrorDetail } from "../ai/errors.js";
import { applyGuideDraft, generateGuideDraft, type GuideDraftEntryContext } from "./planner.js";
import {
  getGuideSource,
  listGuideSources,
  removeGuideSource,
  restoreGuideSource,
  retryGuideImage,
  retryGuideSource,
  saveGuideDraftNote,
  submitGuideSource,
  triggerImageOcr,
  type SubmitGuideImageInput,
  type SubmitGuideSourceInput,
} from "./service.js";

export const guideRoutes = new Hono();

// ===== 错误响应空形状（与成功响应同契约，前端按稳定字段读取不判空形状） =====

/** 提交接口错误形状 */
function submitErrorBody(code: string, message: string): Record<string, unknown> {
  return { code, message, sourceId: null, status: null, duplicate: false, source: null };
}

/** 列表接口错误形状 */
function listErrorBody(code: string, message: string): Record<string, unknown> {
  return { code, message, sources: [], tripVersion: 0 };
}

/** 单来源 / 重试 / 移除 / 恢复接口错误形状 */
function sourceErrorBody(code: string, message: string): Record<string, unknown> {
  return { code, message, source: null };
}

/** 补充句接口错误形状 */
function draftNoteErrorBody(code: string, message: string): Record<string, unknown> {
  return { code, message, tripVersion: 0 };
}

/** 草案生成接口错误形状（与 GuideDraftResult 同契约，统计与列表字段补零 / 空数组） */
function draftErrorBody(code: string, message: string): Record<string, unknown> {
  return {
    code,
    message,
    draftId: null,
    tripVersion: 0,
    baseTripVersion: 0,
    inputTripVersion: 0,
    scope: null,
    sourceMode: null,
    sourceIds: [],
    operations: [],
    snippets: [],
    // Task #190：实用参考选项组与成功响应同契约（空数组）
    optionGroups: [],
    unplaced: [],
    proposedNew: [],
    clarify: null,
    sourceSnapshots: [],
    sourceCount: 0,
    mentionCount: 0,
    placeCount: 0,
    mentionRefCount: 0,
    latencyMs: 0,
    promptChars: 0,
    attempts: 0,
    // Task #193：快速路径标记与成功响应同契约
    fastPath: false,
    finalTextChars: 0,
    directives: [],
    requirementChecks: [],
    conflicts: [],
    autoClassifications: [],
    // Task #250：分类解释与成功响应同契约（可选字段，错误时为空）
    explanation: null,
  };
}

/** 草案应用接口错误形状（与 GuideDraftApplyResult 同契约，type 收敛为 "error"） */
function draftApplyErrorBody(code: string, message: string): Record<string, unknown> {
  return {
    code,
    message,
    type: "error",
    tripVersion: 0,
    draftId: null,
    applied: [],
    rejected: [],
    rejectedCount: 0,
    rejectSummary: null,
    allRejected: false,
    needsProposal: [],
    attachedSnippetCount: 0,
    // Task #190：与应用成功响应同契约（空计数）
    attachedOptionGroupCount: 0,
    requirementChecks: [],
    autoClassifications: [],
    appliedConflictIds: [],
    unselectedConflicts: [],
    requirementSummary: null,
    // Task #250：应用结果分类摘要与成功响应同契约（错误时为空）
    appliedSummary: null,
  };
}

/**
 * scope 请求形状校验（三选一 + 字段类型）；业务边界（dayIndex 范围 /
 * visitId 存在性）由 planner.validateDraftScope 在锁内校验。
 * Task #176：scope 可缺省（缺省 = 自动判定）；提供时为显式范围锁定，
 * entryContext 被忽略（旧调用方 body { scope } 行为不变）。
 */
function parseDraftScope(value: unknown): DraftScope | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AiError(
      "INVALID_REQUEST",
      'scope 必须是 {"kind":"trip"} | {"kind":"day","dayIndex":N} | {"kind":"attraction","visitId":"..."} 之一',
    );
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "trip") return { kind: "trip" };
  if (record.kind === "day") {
    if (typeof record.dayIndex !== "number" || !Number.isInteger(record.dayIndex) || record.dayIndex < 1) {
      throw new AiError("INVALID_REQUEST", 'scope.kind=day 时 dayIndex 必须是正整数');
    }
    return { kind: "day", dayIndex: record.dayIndex };
  }
  if (record.kind === "attraction") {
    if (typeof record.visitId !== "string" || record.visitId.trim() === "") {
      throw new AiError("INVALID_REQUEST", 'scope.kind=attraction 时 visitId 必须是非空字符串');
    }
    return { kind: "attraction", visitId: record.visitId };
  }
  throw new AiError("INVALID_REQUEST", "scope.kind 必须是 trip / day / attraction 之一");
}

/** Task #176：面板入口上下文形状校验（非用户可见控件，仅自动 scope 判定输入）；
 *  业务有效性（天号越界 / visitId 不存在）由 planner.resolveDraftScope 静默降级 */
function parseEntryContext(value: unknown): GuideDraftEntryContext | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AiError(
      "INVALID_REQUEST",
      'entryContext 必须是 {"type":"global"} | {"type":"day","dayIndex":N} | {"type":"attraction","visitId":"..."} 之一',
    );
  }
  const record = value as Record<string, unknown>;
  if (record.type === "global") return { type: "global" };
  if (record.type === "day") {
    if (typeof record.dayIndex !== "number" || !Number.isInteger(record.dayIndex) || record.dayIndex < 1) {
      throw new AiError("INVALID_REQUEST", 'entryContext.type=day 时 dayIndex 必须是正整数');
    }
    return { type: "day", dayIndex: record.dayIndex };
  }
  if (record.type === "attraction") {
    if (typeof record.visitId !== "string" || record.visitId.trim() === "") {
      throw new AiError("INVALID_REQUEST", 'entryContext.type=attraction 时 visitId 必须是非空字符串');
    }
    return { type: "attraction", visitId: record.visitId };
  }
  throw new AiError("INVALID_REQUEST", "entryContext.type 必须是 global / day / attraction 之一");
}

/**
 * AiError 分类响应：稳定 code + 默认状态码 + 指定空形状。
 * 未预期异常压成单行摘要（INTERNAL 500），完整堆栈只进服务端日志。
 */
function errorResponse(
  c: Context,
  emptyBody: (code: string, message: string) => Record<string, unknown>,
  err: unknown,
) {
  const isAiError = err instanceof AiError;
  const code = isAiError ? err.code : "INTERNAL";
  const message = isAiError ? err.message : `服务内部错误：${condenseErrorDetail(err)}`;
  const status = (isAiError ? err.status : 500) as ContentfulStatusCode;
  return c.json(emptyBody(code, message), status);
}

/** AiError 是预期业务拒绝（warn 级单行）；未预期异常打完整堆栈 */
function logRouteError(action: string, err: unknown): void {
  if (err instanceof AiError) {
    console.warn(`[GUIDES] ${action}被拒绝：[${err.code}] ${err.message}`);
  } else {
    console.error(`[GUIDES] ${action}异常:`, err);
  }
}

// ===== 请求体解析 =====

async function parseJsonBody<T extends object>(c: Context): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

/** multipart 字段读取字符串值（空串 / 缺省 / 非字符串一律 undefined） */
function readFormString(
  form: Record<string, string | File | (string | File)[]>,
  field: string,
): string | undefined {
  const value = form[field];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** multipart 文件字段归一化：单值或数组里的全部 File（保持表单顺序） */
function collectFormFiles(
  form: Record<string, string | File | (string | File)[]>,
  field: string,
): File[] {
  const value = form[field];
  if (value instanceof File) return [value];
  if (Array.isArray(value)) return value.filter((item): item is File => item instanceof File);
  return [];
}

/**
 * 提交请求解包：按 Content-Type 分流。
 * - multipart/form-data → images 模式（图片文件 + 可选 title / sourceUrl）；
 * - 其余按 JSON 解析 link / text（images 模式要求 multipart，二进制走表单）。
 * 解包失败 / 形态缺失抛 AiError（INVALID_REQUEST），由外层统一分类响应。
 */
async function parseSubmitInput(c: Context): Promise<SubmitGuideSourceInput> {
  const contentType = c.req.header("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    let form: Record<string, string | File | (string | File)[]>;
    try {
      form = (await c.req.parseBody({ all: true })) as Record<string, string | File | (string | File)[]>;
    } catch (err) {
      console.error("[GUIDES] 提交来源 multipart 解析失败:", err);
      throw new AiError("INVALID_REQUEST", "请求必须是合法的 multipart/form-data 表单");
    }
    const files = collectFormFiles(form, "images");
    if (files.length === 0) {
      throw new AiError("INVALID_REQUEST", "图片来源必须包含至少一张图片文件（images 字段）");
    }
    const images: SubmitGuideImageInput[] = [];
    for (const file of files) {
      let data: Uint8Array;
      try {
        data = new Uint8Array(await file.arrayBuffer());
      } catch (err) {
        console.error("[GUIDES] 提交来源读取图片字节失败:", err);
        throw new AiError("INVALID_REQUEST", "图片读取失败，请重新选择后重试");
      }
      images.push({
        data,
        filename: file.name !== "" ? file.name : `image-${images.length + 1}`,
        // 客户端声明值仅存档；服务端按 magic bytes 复核（detectImageKind）
        mimeType: file.type === "image/jpg" ? "image/jpeg" : file.type,
      });
    }
    return {
      inputKind: "images",
      images,
      title: readFormString(form, "title"),
      sourceUrl: readFormString(form, "sourceUrl"),
    };
  }

  const body = await parseJsonBody<{
    inputKind?: unknown;
    url?: unknown;
    text?: unknown;
    title?: unknown;
    sourceUrl?: unknown;
  }>(c);
  if (body === null) {
    throw new AiError(
      "INVALID_REQUEST",
      '请求必须是 JSON 对象（link / text 来源），如 { "inputKind": "link", "url": "..." }',
    );
  }
  const inputKind = body.inputKind;
  if (inputKind !== "link" && inputKind !== "text" && inputKind !== "images") {
    throw new AiError("INVALID_REQUEST", "inputKind 必须是 link / text / images 之一");
  }
  if (inputKind === "images") {
    throw new AiError("INVALID_REQUEST", "图片来源请使用 multipart/form-data 提交（images 文件字段）");
  }
  return {
    inputKind,
    url: typeof body.url === "string" ? body.url : undefined,
    text: typeof body.text === "string" ? body.text : undefined,
    title: typeof body.title === "string" ? body.title : undefined,
    sourceUrl: typeof body.sourceUrl === "string" ? body.sourceUrl : undefined,
  };
}

// ===== 路由 =====

// POST /trips/:tripId/sources — 提交来源（两秒内返回 sourceId + 当前状态；处理后台异步）
guideRoutes.post("/trips/:tripId/sources", async (c) => {
  try {
    const input = await parseSubmitInput(c);
    const result = await submitGuideSource(c.req.param("tripId"), input);
    return c.json(result);
  } catch (err) {
    logRouteError("提交来源", err);
    return errorResponse(c, submitErrorBody, err);
  }
});

// GET /trips/:tripId/sources — 来源列表（按导入时间排序；读取前触发重启恢复扫描）
guideRoutes.get("/trips/:tripId/sources", async (c) => {
  try {
    return c.json(await listGuideSources(c.req.param("tripId")));
  } catch (err) {
    logRouteError("来源列表", err);
    return errorResponse(c, listErrorBody, err);
  }
});

// GET /trips/:tripId/sources/:sourceId — 单个来源状态（含 imageProgress 明细）
guideRoutes.get("/trips/:tripId/sources/:sourceId", async (c) => {
  try {
    const source = await getGuideSource(c.req.param("tripId"), c.req.param("sourceId"));
    return c.json({ source });
  } catch (err) {
    logRouteError("来源详情", err);
    return errorResponse(c, sourceErrorBody, err);
  }
});

// POST /trips/:tripId/sources/:sourceId/retry — 重试剩余图片（只跑未成功项，不重复已完成）
guideRoutes.post("/trips/:tripId/sources/:sourceId/retry", async (c) => {
  try {
    const source = await retryGuideSource(c.req.param("tripId"), c.req.param("sourceId"));
    return c.json({ source });
  } catch (err) {
    logRouteError("来源重试", err);
    return errorResponse(c, sourceErrorBody, err);
  }
});

// POST /trips/:tripId/sources/:sourceId/ocr-images — 一键解析待解析图片（Task #215：
// 图片默认不自动 OCR；仅 imageOcrDeferred 来源可触发，启动后状态回 processing）
guideRoutes.post("/trips/:tripId/sources/:sourceId/ocr-images", async (c) => {
  try {
    const source = await triggerImageOcr(c.req.param("tripId"), c.req.param("sourceId"));
    return c.json({ source });
  } catch (err) {
    logRouteError("解析来源图片", err);
    return errorResponse(c, sourceErrorBody, err);
  }
});

// POST /trips/:tripId/sources/:sourceId/retry-image — 单图重试（Task #231：
// body { index: number }，只重置指定失败图为 pending 并启动队列）
guideRoutes.post("/trips/:tripId/sources/:sourceId/retry-image", async (c) => {
  try {
    const body = await c.req.json<{ index?: unknown }>().catch(() => null);
    const index = typeof body?.index === "number" ? body.index : NaN;
    if (!Number.isInteger(index) || index < 1) {
      return c.json({ error: "请求体须包含 index（正整数，图片序号）" }, 400);
    }
    const source = await retryGuideImage(c.req.param("tripId"), c.req.param("sourceId"), index);
    return c.json({ source });
  } catch (err) {
    logRouteError("单图重试", err);
    return errorResponse(c, sourceErrorBody, err);
  }
});

// POST /trips/:tripId/sources/:sourceId/remove — 软移除（active=false + removedAt；不删证据）
guideRoutes.post("/trips/:tripId/sources/:sourceId/remove", async (c) => {
  try {
    const source = await removeGuideSource(c.req.param("tripId"), c.req.param("sourceId"));
    return c.json({ source });
  } catch (err) {
    logRouteError("来源移除", err);
    return errorResponse(c, sourceErrorBody, err);
  }
});

// POST /trips/:tripId/sources/:sourceId/restore — 恢复已移除来源（幂等）
guideRoutes.post("/trips/:tripId/sources/:sourceId/restore", async (c) => {
  try {
    const source = await restoreGuideSource(c.req.param("tripId"), c.req.param("sourceId"));
    return c.json({ source });
  } catch (err) {
    logRouteError("来源恢复", err);
    return errorResponse(c, sourceErrorBody, err);
  }
});

// POST /trips/:tripId/draft — 生成攻略草案（合并 mentions → planner → 保存 pendingGuideDraft）
// Task #161：body 可选 { sourceMode: "all" | "selected", selectedSourceIds?: string[] }——
// 缺省 = "all"（全部可用攻略整体重排，旧调用方零变化）；"selected" = 局部优化，
// 只使用所选来源素材（允许新增暂存来源）。形状校验在此处，存在性 / 可用性在 planner 锁内。
// Task #176：scope 可缺省（缺省 = 服务端自动判定：日期指令 > 入口上下文 > 证据归属
// > 整程）；body 可选 entryContext（面板打开来源，非用户可见控件）。显式携带 scope
// 时优先使用（旧调用方 body { scope } 行为不变，entryContext 被忽略）。
guideRoutes.post("/trips/:tripId/draft", async (c) => {
  try {
    const body = await parseJsonBody<{
      scope?: unknown;
      note?: unknown;
      sourceMode?: unknown;
      selectedSourceIds?: unknown;
      entryContext?: unknown;
      clarificationAnswer?: unknown;
    }>(c);
    if (body === null) {
      throw new AiError("INVALID_REQUEST", '请求必须是 JSON 对象，如 { "entryContext": { "type": "global" } }');
    }
    const scope = parseDraftScope(body.scope);
    const entryContext = parseEntryContext(body.entryContext);
    // note 缺省沿用现有 trip.guideDraftNote；提供时先写入（与 PUT /draft-note 同校验）
    const note = typeof body.note === "string" ? body.note : undefined;

    // Task #282：澄清答案形状校验（业务校验在 planner 锁内）
    let clarificationAnswer: "guide_only" | "ai_fill" | undefined;
    if (body.clarificationAnswer !== undefined) {
      if (body.clarificationAnswer !== "guide_only" && body.clarificationAnswer !== "ai_fill") {
        throw new AiError("INVALID_REQUEST", 'clarificationAnswer 必须是 "guide_only" 或 "ai_fill"');
      }
      clarificationAnswer = body.clarificationAnswer;
    }

    // Task #161：来源模式形状校验（业务校验在 planner 锁内；此处只保证类型与组合合法）
    let sourceMode: "all" | "selected" | undefined;
    if (body.sourceMode !== undefined) {
      if (body.sourceMode !== "all" && body.sourceMode !== "selected") {
        throw new AiError('INVALID_REQUEST', 'sourceMode 必须是 "all" 或 "selected"');
      }
      sourceMode = body.sourceMode;
    }
    let selectedSourceIds: string[] | undefined;
    if (body.selectedSourceIds !== undefined) {
      if (
        !Array.isArray(body.selectedSourceIds) ||
        body.selectedSourceIds.some((id) => typeof id !== "string" || id.trim() === "")
      ) {
        throw new AiError("INVALID_REQUEST", "selectedSourceIds 必须是非空字符串数组（来源 id 列表）");
      }
      selectedSourceIds = [...new Set(body.selectedSourceIds as string[])];
      if (sourceMode === undefined) {
        // 携带选择但未声明模式：拒绝而不是猜测（避免误把局部优化当全部重排）
        throw new AiError('INVALID_REQUEST', '携带 selectedSourceIds 时必须显式声明 sourceMode="selected"');
      }
    }
    if (sourceMode === "selected" && (selectedSourceIds === undefined || selectedSourceIds.length === 0)) {
      throw new AiError("INVALID_REQUEST", 'sourceMode="selected" 时 selectedSourceIds 必须是非空数组');
    }
    if (sourceMode === "all" && selectedSourceIds !== undefined) {
      throw new AiError("INVALID_REQUEST", 'sourceMode="all" 不得携带 selectedSourceIds（两种模式互斥）');
    }

    const result = await generateGuideDraft(c.req.param("tripId"), {
      scope,
      note,
      sourceMode,
      selectedSourceIds,
      entryContext,
      clarificationAnswer,
    });
    return c.json(result);
  } catch (err) {
    logRouteError("生成攻略草案", err);
    return errorResponse(c, draftErrorBody, err);
  }
});

// POST /trips/:tripId/draft/apply — 应用当前草案（版本保护 + 护栏 + 敏感分流 + 挂载提示）
// Task #123：body 可选 { selectedConflictIds: string[] }——仅选中的冲突 resolution 以
// user_confirmed 执行，未选中保持原状；缺省 / 空数组 = 不执行任何冲突调整。
// Task #253：body 可选 { replaceConfirm: { draftId, confirmed } }——整日替换（replace）的
// 旧安排移回必须由前端明确确认且 draftId 匹配当前草案；缺省 / confirmed=false / draftId
// 不一致时服务端不移出（旧安排保持原样，requirementChecks 带出原因）。
guideRoutes.post("/trips/:tripId/draft/apply", async (c) => {
  try {
    let selectedConflictIds: string[] | undefined;
    let replaceConfirm: { draftId: string; confirmed: boolean } | undefined;
    const body = await parseJsonBody<{ selectedConflictIds?: unknown; replaceConfirm?: unknown }>(c);
    if (body !== null && body.selectedConflictIds !== undefined) {
      if (
        !Array.isArray(body.selectedConflictIds) ||
        body.selectedConflictIds.some((id) => typeof id !== "string" || id.trim() === "")
      ) {
        throw new AiError("INVALID_REQUEST", "selectedConflictIds 必须是非空字符串数组（冲突 id 列表）");
      }
      selectedConflictIds = [...new Set(body.selectedConflictIds as string[])];
    }
    if (body !== null && body.replaceConfirm !== undefined && body.replaceConfirm !== null) {
      const raw = body.replaceConfirm;
      if (typeof raw !== "object" || Array.isArray(raw)) {
        throw new AiError("INVALID_REQUEST", "replaceConfirm 必须是对象，如 { \"draftId\": \"dr_1\", \"confirmed\": true }");
      }
      const candidate = raw as { draftId?: unknown; confirmed?: unknown };
      if (typeof candidate.draftId !== "string" || candidate.draftId.trim() === "") {
        throw new AiError("INVALID_REQUEST", "replaceConfirm.draftId 必须是非空字符串（当前草案 id）");
      }
      if (typeof candidate.confirmed !== "boolean") {
        throw new AiError("INVALID_REQUEST", "replaceConfirm.confirmed 必须是布尔值");
      }
      replaceConfirm = { draftId: candidate.draftId, confirmed: candidate.confirmed };
    }
    const result = await applyGuideDraft(c.req.param("tripId"), selectedConflictIds, replaceConfirm);
    return c.json(result);
  } catch (err) {
    logRouteError("应用攻略草案", err);
    return errorResponse(c, draftApplyErrorBody, err);
  }
});

// PUT /trips/:tripId/draft-note — 保存攻略补充句（note 空串 / null / 缺省 = 清除）
guideRoutes.put("/trips/:tripId/draft-note", async (c) => {
  try {
    const body = await parseJsonBody<{ note?: unknown }>(c);
    if (body === null) {
      throw new AiError("INVALID_REQUEST", '请求必须是 JSON 对象，如 { "note": "带老人出游，节奏放慢" }');
    }
    let note: string | null = null;
    if (body.note !== undefined && body.note !== null) {
      if (typeof body.note !== "string") {
        throw new AiError("INVALID_REQUEST", "note 必须是字符串（空串或 null 表示清除）");
      }
      note = body.note;
    }
    const result = await saveGuideDraftNote(c.req.param("tripId"), note);
    return c.json(result);
  } catch (err) {
    logRouteError("保存攻略补充句", err);
    return errorResponse(c, draftNoteErrorBody, err);
  }
});
