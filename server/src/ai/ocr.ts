/**
 * Task #51 截图 OCR 抽取流水线（PRD v1.1 §5：图片 → OCR 原文 + 结构化点位）。
 *
 * 执行顺序：
 *   loadTrip → 环境预检 → 上传百炼 File API（multipart，日志仅元信息）
 *   → 轮询 checking → available（rejected / type_rejected → IMAGE_REJECTED）
 *   → 图文会话（text 指令块 + image file_id 块；实测约 33s，预算 120s；
 *     解析失败自动重试一次）→ 解析 { ocrText, mentions[] }（候选链含
 *     lastBalanced + jsonRepair 兜底）→ 归一化
 *   → 复用 assemble.ts 装配（Item / Visit / Stop 三级归属，与 F5 同源）
 *   → evidences 新增一条 screenshot（assetRef 仅非敏感描述 + 内容哈希，
 *     ocrText 全文、mentions 含 bbox / modelSummary；Task #65 起原图压缩
 *     副本落盘 server/uploads/{tripId}/，assetPath 供前端回看原图）
 *   → tripStore.save（内部 validateConsistency 把关）→ 返回 OcrResult。
 *
 * 安全与隐私：
 * - finally 必删百炼侧文件：主流程无论成败，识别完立即 DELETE；
 * - 原图本地持久化（Task #65）：识别前把前端压缩图写入
 *   server/uploads/{tripId}/{evidenceId}.{jpg|png}（单行程 50MB 配额，
 *   超限或写盘失败只降级 assetPath 并附提示，不阻塞 OCR 识别）；
 * - 安全失败不落盘：上传 / 审核 / 会话 / 解析任一步失败都在 save 之前抛出，
 *   加载的 trip 副本直接丢弃；save 内一致性校验失败同样整次拒绝；
 *   这些失败路径统一回滚删除已落盘的本地截图。
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { FlyAIPoi } from "../flyai/client.js";
import type { SourceEvidence, Trip } from "@goplay/shared";
import {
  assembleEntries,
  normalizeParsedEntry,
  type ParsedEntry,
} from "./assemble.js";
import {
  BailianFileRejectedError,
  BailianFileWaitTimeoutError,
  BailianTimeoutError,
  createBailianSession,
  deleteBailianFile,
  uploadBailianFile,
  waitForBailianFileAvailable,
  type BailianContentBlock,
} from "../bailian/client.js";
import { getMissingBailianVars } from "../env.js";
import { tripStore, tripUploadsDir } from "../persistence/store.js";
import { AiError, isBailianConfigError } from "./errors.js";
import { repairJsonCandidates } from "./jsonRepair.js";
import { lastBalancedJsonValue } from "./lastJson.js";
import { buildOcrPrompt } from "./prompt.js";

/** 图片判定的 magic bytes：JPEG（FF D8 FF）与 PNG（89 50 4E 47） */
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

/** OCR 会话超时预算：file_id 路径实测约 33s，识别 + 结构化输出放宽到 120s */
const OCR_SESSION_TIMEOUT_MS = 120_000;

/** 解析失败后的最大百炼重试次数（初次 + 1 次重试，与 F5 流水线一致） */
const MAX_BAILIAN_ATTEMPTS = 2;

/** Task #65：单行程截图总量上限（50MB），超限拒绝保存原图但不阻塞识别 */
const TRIP_UPLOAD_QUOTA_BYTES = 50 * 1024 * 1024;
/** 配额超限时随结果返回的用户提示（非错误态，前端展示后识别结果照常可用） */
const TRIP_UPLOAD_QUOTA_MESSAGE = "本行程截图已达上限（50MB），本次不保存原图，文字识别不受影响";

const CODE_FENCE_PATTERN = /```(?:json)?\s*([\s\S]*?)```/i;

/** 调用方（routes 层）已校验过的图片输入；此处只透传，不重复业务校验 */
export interface OcrScreenshotInput {
  /** 图片二进制（仅用于上传与哈希，不进任何日志 / 错误消息） */
  data: Uint8Array;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

/** OCR 抽取结果（routes 层原样 JSON 返回给前端） */
export interface OcrResult {
  evidenceId: string;
  ocrText: string;
  items: Array<{
    itemId: string;
    name: string;
    origin: "fliggy" | "custom";
    matched: boolean;
    /** 复用既有 Item（仅补充证据引用，非新建）；与 F5 契约同步 */
    reused: boolean;
    suggestMinutes: number | null;
  }>;
  visits: Array<{ visitId: string; pointRef: string; name: string; kind: "ordinary" | "large_attraction" }>;
  stops: Array<{
    stopId: string;
    name: string;
    state: "attached" | "pending";
    visitRef: string | null;
    suggestedVisitRef: string | null;
    level: "high" | "medium" | "low";
  }>;
  /** 以下统计字段与 F5 ExtractResult 同契约（assembleEntries 透传） */
  newVisitCount: number;
  reusedVisitCount: number;
  attachedStopCount: number;
  pendingStopCount: number;
  reusedStopCount: number;
  errors: string[];
  /** Task #65：原图保存的非阻塞提示（如单行程配额超限）；null 表示无提示 */
  assetWarning: string | null;
}

/** 服务端二次校验（前端已校验，此处防伪造 content-type 的直接 POST） */
export function isSupportedImage(data: Uint8Array, mimeType: string): boolean {
  if (mimeType !== "image/jpeg" && mimeType !== "image/png") return false;
  if (data.length < 4) return false;
  const jpegMatch = JPEG_MAGIC.every((byte, index) => data[index] === byte);
  if (jpegMatch) return true;
  const pngMatch = PNG_MAGIC.every((byte, index) => data[index] === byte);
  return pngMatch;
}

/**
 * 图片字节分类（Task #96 攻略来源图片队列）：按 magic bytes 判定，不信任扩展名 / 
 * content-type。只有 jpeg / png 可走百炼识别；webp / gif 标记 unsupported 跳过识别
 * （仍保留原图供回看）；无法识别的字节兜底 unknown。
 */
export type TripImageKind = "jpeg" | "png" | "webp" | "gif" | "unknown";

export function detectImageKind(data: Uint8Array): TripImageKind {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpeg";
  if (data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return "png";
  }
  if (data.length >= 4 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) {
    return "webp";
  }
  if (data.length >= 3 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return "gif";
  return "unknown";
}

// ===== 模型输出解析与归一化 =====

interface ParsedOcrResponse {
  ocrText: string;
  mentions: ParsedEntry[];
}

/** 结构归一化：mentions 必须是数组（空数组合法）；ocrText 缺省为空串 */
function normalizeOcrResponse(value: unknown): ParsedOcrResponse | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.mentions)) return null;
  const mentions = record.mentions
    .map(normalizeParsedEntry)
    .filter((entry): entry is ParsedEntry => entry !== null);
  const ocrText = typeof record.ocrText === "string" ? record.ocrText.trim() : "";
  return { ocrText, mentions };
}

/**
 * 从模型 finalText 中解析 { ocrText, mentions }：
 * 直接 parse → markdown code block 提取 → 首尾大括号截取 → 最后一个平衡 JSON 块
 * （兜底百炼 SSE 间歇性 prompt 回显，见 lastJson.ts）→ 保守结构修复候选
 * （悬空逗号 / EOF 补闭合，见 jsonRepair.ts），逐个候选尝试。
 * 全部失败返回 null（由调用方决定重试）。
 */
function parseOcrResponse(finalText: string): ParsedOcrResponse | null {
  const trimmed = finalText.trim();
  const candidates: string[] = [];
  const fenced = trimmed.match(CODE_FENCE_PATTERN)?.[1];
  if (fenced) candidates.push(fenced.trim());
  candidates.push(trimmed);
  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(trimmed.slice(objectStart, objectEnd + 1));
  }
  const lastBalanced = lastBalancedJsonValue(trimmed);
  if (lastBalanced !== null) candidates.push(lastBalanced);

  const allCandidates = [...candidates, ...repairJsonCandidates(trimmed)];
  for (const candidate of allCandidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const normalized = normalizeOcrResponse(parsed);
    if (normalized !== null) return normalized;
  }
  return null;
}

// ===== 错误分类 =====

/** 会话阶段（上传 / 等待 / 图文识别）的异常分类：AiError 透传，其余按类型映射 */
function classifyOcrError(error: unknown): AiError {
  if (error instanceof AiError) return error;
  if (error instanceof BailianTimeoutError) {
    return new AiError("OCR_TIMEOUT", "图片识别超时，请稍后重试或换一张更小的截图", { cause: error });
  }
  if (error instanceof BailianFileRejectedError) {
    return new AiError("IMAGE_REJECTED", "图片未通过 AI 平台审核，请更换图片后重试", { cause: error });
  }
  if (error instanceof BailianFileWaitTimeoutError) {
    return new AiError("OCR_TIMEOUT", "图片上传后长时间未完成审核，请稍后重试", { cause: error });
  }
  if (isBailianConfigError(error)) {
    const detail = error instanceof Error ? error.message : "环境变量未配置";
    return new AiError("ENV_NOT_CONFIGURED", `服务端百炼配置不可用：${detail}`, { cause: error });
  }
  return new AiError("BAILIAN_REQUEST_FAILED", "百炼请求失败，请稍后重试", { cause: error });
}

// ===== 图文会话调用（带一次解析重试；Task #231 回显检测 + 短纠错重试） =====

/**
 * 检测百炼是否回显了 prompt 原文（Task #230 实测：模型偶发返回 prompt 正文
 * 而非 JSON 结果）。判定口径：响应前 200 字符包含 OCR prompt 的标志性开头。
 */
const PROMPT_ECHO_SIGNATURE = "你是旅行攻略图片识别助手";
function isPromptEcho(finalText: string): boolean {
  return finalText.slice(0, 200).includes(PROMPT_ECHO_SIGNATURE);
}

/**
 * 回显纠错 prompt（Task #231）：检测到模型回显 prompt 后，用极短指令重试，
 * 只要求输出 JSON 结果。比重发完整 prompt 省 token、降低再次回显概率。
 */
const OCR_CORRECTION_PROMPT =
  "你刚才回显了指令原文而非结果。请重新审视图片，直接输出符合契约的 JSON 对象（{ocrText, mentions}），不要输出任何解释。";

/** 调百炼图文会话并解析 OCR 响应；解析失败时按回显 vs 非回显分策略重试 */
async function callAndParseOcr(blocks: BailianContentBlock[]): Promise<ParsedOcrResponse | null> {
  let previousWasEcho = false;
  for (let attempt = 1; attempt <= MAX_BAILIAN_ATTEMPTS; attempt++) {
    // Task #231：第二次尝试时，若上一轮是 prompt 回显，换用短纠错 prompt
    const currentBlocks =
      attempt > 1 && previousWasEcho
        ? [{ type: "text" as const, text: OCR_CORRECTION_PROMPT }, ...blocks.filter((b) => b.type === "image")]
        : blocks;

    let finalText: string;
    let latencyMs: number;
    try {
      const result = await createBailianSession(currentBlocks, { timeoutMs: OCR_SESSION_TIMEOUT_MS });
      finalText = result.finalText;
      latencyMs = result.latencyMs;
    } catch (error) {
      throw classifyOcrError(error);
    }
    console.log(
      `[AI] 百炼 OCR 返回 ${finalText.length} 字符（第 ${attempt}/${MAX_BAILIAN_ATTEMPTS} 次${attempt > 1 && previousWasEcho ? "，纠错 prompt" : ""}），耗时 ${latencyMs}ms`,
    );
    const parsed = parseOcrResponse(finalText);
    if (parsed !== null) return parsed;

    previousWasEcho = isPromptEcho(finalText);
    console.error(
      `[AI] 第 ${attempt} 次 OCR 响应无法解析为 {ocrText, mentions}${previousWasEcho ? "（检测到 prompt 回显）" : ""}，前 200 字符：${finalText.slice(0, 200)}`,
    );
  }
  return null;
}

// ===== 可复用的单图识别（Task #96） =====

/** recognizeImageContent 的结果：OCR 全文 + 结构化条目（未装配、未落盘） */
export interface RecognizedImageContent {
  ocrText: string;
  mentions: ParsedEntry[];
}

/**
 * 单图「上传 → 轮询审核 → 图文识别 → 解析 → finally 删远端文件」的可复用函数
 * （Task #96）：不重复实现 File API、不建证据、不落盘，供 /api/ai/ocr 与
 * 攻略来源图片队列共用。失败按分类抛 AiError（ENV_NOT_CONFIGURED /
 * IMAGE_REJECTED / OCR_TIMEOUT / BAILIAN_REQUEST_FAILED / AI_PARSE_FAILED）；
 * 无论成败 finally 删除百炼侧文件（隐私铁律：不留存云端副本）。
 */
export async function recognizeImageContent(
  image: OcrScreenshotInput,
  options: { editedText?: string } = {},
): Promise<RecognizedImageContent> {
  // 环境预检：变量名报告缺失项，不触碰密钥值
  const missingVars = getMissingBailianVars();
  if (missingVars.length > 0) {
    throw new AiError(
      "ENV_NOT_CONFIGURED",
      `服务端百炼环境变量未配置：${missingVars.join("、")}（请检查仓库根目录 .env 后重启服务）`,
    );
  }

  let uploadedFileId: string | null = null;
  let parsed: ParsedOcrResponse | null = null;
  try {
    const uploaded = await uploadBailianFile({
      data: image.data,
      filename: image.filename,
      mimeType: image.mimeType,
    });
    uploadedFileId = uploaded.id;
    console.log(
      `[AI] OCR 文件已上传（${image.filename}，${(image.sizeBytes / 1024).toFixed(0)}KB，fileId=${uploaded.id}），等待平台审核…`,
    );

    try {
      await waitForBailianFileAvailable(uploaded.id);
    } catch (error) {
      throw classifyOcrError(error);
    }
    console.log(`[AI] OCR 文件审核通过（fileId=${uploaded.id}），开始图文识别…`);

    // 图文会话：text 指令块 + image file_id 块（解析失败自动重试一次）
    const prompt = buildOcrPrompt(options.editedText);
    const blocks: BailianContentBlock[] = [
      { type: "text", text: prompt },
      { type: "image", file_id: uploaded.id },
    ];
    parsed = await callAndParseOcr(blocks);
  } catch (error) {
    throw classifyOcrError(error);
  } finally {
    if (uploadedFileId !== null) {
      // 无论主流程成败：识别完立即删除百炼侧文件，不留存云端副本
      const deleted = await deleteBailianFile(uploadedFileId);
      if (deleted) {
        console.log(`[AI] OCR 百炼文件已删除（fileId=${uploadedFileId}）`);
      }
    }
  }

  if (parsed === null) {
    throw new AiError("AI_PARSE_FAILED", "AI 响应解析失败（已自动重试一次），请重试或换一张更清晰的截图");
  }
  return { ocrText: parsed.ocrText, mentions: parsed.mentions };
}

// ===== Task #65：原图本地持久化（server/uploads/{tripId}/） =====

/** 原图落盘结果：配额超限 / 写盘失败时 assetPath 为 null 并附 warning，绝不抛错 */
export interface PersistedTripAsset {
  assetPath: string | null;
  assetMimeType: string | null;
  assetSizeBytes: number | null;
  assetHash: string | null;
  /** 非空时前端原样展示（如配额超限提示）；不影响识别结果 */
  warning: string | null;
}

/** 统计目录下全部文件字节总量；目录不存在按 0 处理（首张截图必然放行） */
async function directorySizeBytes(dir: string): Promise<number> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return 0;
  let total = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const stat = await fs.stat(path.join(dir, entry.name)).catch(() => null);
    if (stat !== null) total += stat.size;
  }
  return total;
}

/**
 * Task #65：把前端已压缩的图片保存到 server/uploads/{tripId}/{evidenceId}.{jpg|png}。
 * Task #96 泛化为 persistTripAsset（供 F5/OCR 流水线与攻略来源图片队列共用）：
 * - 写盘前检查该行程 uploads 目录总量，超过 50MB 拒绝保存并返回提示（不阻塞 OCR）；
 * - 任何写盘异常都不阻塞主流程：assetPath 置 null 并 console.error；
 * 返回值永不 reject。文件名与 evidenceId 同名（ev_shot_{8hex}），
 * 受 persistence 路由的 UPLOAD_FILENAME_PATTERN 白名单保护。
 */
export async function persistTripAsset(
  tripId: string,
  evidenceId: string,
  image: OcrScreenshotInput,
): Promise<PersistedTripAsset> {
  const hash = createHash("sha256").update(image.data).digest("hex").slice(0, 16);
  const degraded: PersistedTripAsset = {
    assetPath: null,
    assetMimeType: null,
    assetSizeBytes: null,
    assetHash: hash,
    warning: null,
  };
  const ext = image.mimeType === "image/png" ? "png" : "jpg";
  try {
    const dir = tripUploadsDir(tripId);
    const existingBytes = await directorySizeBytes(dir);
    if (existingBytes + image.sizeBytes > TRIP_UPLOAD_QUOTA_BYTES) {
      console.warn(
        `[AI] OCR 截图保存被拒：行程 ${tripId} 的 uploads 已占 ${existingBytes} 字节，超过 50MB 配额`,
      );
      return { ...degraded, warning: TRIP_UPLOAD_QUOTA_MESSAGE };
    }
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${evidenceId}.${ext}`), image.data);
    return {
      ...degraded,
      assetPath: `uploads/${tripId}/${evidenceId}.${ext}`,
      assetMimeType: image.mimeType,
      assetSizeBytes: image.sizeBytes,
    };
  } catch (error) {
    console.error("[AI] OCR 截图本地保存失败（不影响识别结果）:", error);
    return degraded;
  }
}

/** 回滚删除单张已落盘截图（识别 / 装配 / 持久化失败路径）；幂等，绝不抛错 */
async function removeScreenshotAssetFile(tripId: string, evidenceId: string): Promise<void> {
  try {
    const dir = tripUploadsDir(tripId);
    for (const ext of ["jpg", "png"] as const) {
      await fs.rm(path.join(dir, `${evidenceId}.${ext}`), { force: true });
    }
  } catch (error) {
    console.error("[AI] OCR 截图回滚删除失败:", error);
  }
}

// ===== 流水线入口 =====

/**
 * Task #51 截图 OCR 抽取：图片 → 百炼 File API 上传 + 图文识别 →
 * OCR 原文 + 结构化条目 → 复用 F5 装配层三级归属写入
 * SourceEvidence(screenshot) / itemRegistry / visits / stops /
 * pendingStopRefs / relationshipSuggestions。
 *
 * 失败按分类抛出 AiError（稳定错误码 + 用户可读 message）：
 * 行程不存在 / 环境变量未配置 / 图片审核拒绝 / 百炼请求失败 /
 * 识别超时 / AI 响应解析失败 / 持久化失败。
 * 任何失败（含 save 拒绝）均不写行程；已落盘的本地截图统一回滚删除；
 * 百炼侧文件在 finally 中无条件删除。
 */
export async function extractFromScreenshot(
  tripId: string,
  image: OcrScreenshotInput,
  options: { sourceUrl?: string; editedText?: string } = {},
): Promise<OcrResult> {
  let trip: Trip | null;
  try {
    trip = await tripStore.load(tripId);
  } catch {
    // 含 tripId 非法 UUID 等加载异常，对外统一按行程不存在提示
    throw new AiError("TRIP_NOT_FOUND", "行程不存在或已被删除，请刷新页面后重试");
  }
  if (trip === null) {
    throw new AiError("TRIP_NOT_FOUND", "行程不存在或已被删除，请刷新页面后重试");
  }

  // 0. 环境预检：变量名报告缺失项，不触碰密钥值
  const missingVars = getMissingBailianVars();
  if (missingVars.length > 0) {
    throw new AiError(
      "ENV_NOT_CONFIGURED",
      `服务端百炼环境变量未配置：${missingVars.join("、")}（请检查仓库根目录 .env 后重启服务）`,
    );
  }

  // 1. Task #65：识别前先把前端压缩图落盘（server/uploads/{tripId}/）；
  //    配额超限或写盘失败只降级 assetPath 并附提示，不阻塞 OCR 文字识别；
  //    后续任一步失败统一回滚删除该文件（安全失败不落盘）
  const evidenceId = `ev_shot_${randomUUID().slice(0, 8)}`;
  const asset = await persistTripAsset(tripId, evidenceId, image);
  try {
    // 2. 单图识别（上传 → 轮询 → 图文会话 → 解析；finally 必删百炼侧文件，Task #96 抽出共用）
    const contentHash = createHash("sha256").update(image.data).digest("hex").slice(0, 8);
    const parsed = await recognizeImageContent(image, { editedText: options.editedText });

    // 3. 新建 screenshot 证据：assetRef 仅非敏感描述（文件名 / 大小 / 内容哈希前 8 位）；
    //    Task #65 起原图压缩副本已落盘本地，资产字段随证据保存（保存失败时 assetPath 为 null）
    const evidence: SourceEvidence = {
      evidenceId,
      kind: "screenshot",
      noteIndex: null,
      assetRef: `截图 ${image.filename} · ${(image.sizeBytes / 1024).toFixed(0)}KB · #${contentHash}`,
      sourceUrl: typeof options.sourceUrl === "string" && options.sourceUrl.trim() !== "" ? options.sourceUrl.trim() : null,
      ocrText: parsed.ocrText === "" ? null : parsed.ocrText,
      mentions: [],
      assetPath: asset.assetPath,
      assetMimeType: asset.assetMimeType,
      assetSizeBytes: asset.assetSizeBytes,
      assetHash: asset.assetHash,
    };

    // 4. 复用 F5 装配层（OCR 开启 suggestedVisitName 兜底解析）
    const errors: string[] = [];
    const searchCache = new Map<string, FlyAIPoi[]>();
    const assembled = await assembleEntries(trip, parsed.mentions, evidence, evidenceId, errors, searchCache, {
      useSuggestedVisitName: true,
      logPrefix: "OCR",
    });

    // 5. 证据入注册表 + 持久化（一致性校验失败会在 save 内整次拒绝并抛错）
    trip.evidences[evidenceId] = evidence;
    console.log(
      `[AI] OCR 抽取落盘：${evidenceId}（ocrText ${parsed.ocrText.length} 字），items=${assembled.items.length}，visits=${assembled.visits.length}，stops=${assembled.stops.length}（attached=${assembled.stops.filter((s) => s.state === "attached").length}）`,
    );
    try {
      await tripStore.save(trip);
    } catch (error) {
      throw new AiError("PERSIST_FAILED", "点位已识别但保存失败，请重试", { cause: error });
    }

    return {
      evidenceId,
      ocrText: parsed.ocrText,
      ...assembled,
      errors,
      assetWarning: asset.warning,
    };
  } catch (error) {
    // 识别 / 装配 / 持久化任一步失败：回滚已落盘的本地截图，保持「失败不落盘」
    if (asset.assetPath !== null) {
      await removeScreenshotAssetFile(tripId, evidenceId);
    }
    throw error;
  }
}
