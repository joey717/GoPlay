/**
 * Task #175 图片预筛（prefilter）：把「纯风景 / 人像等低信息图片」的筛选
 * 前移到昂贵百炼 OCR 之前（目标一）。
 *
 * 两层结构（由廉到贵）：
 *   1. 本地零成本硬筛（assessLocalInformation）：字节数与像素信息密度（bpp）
 *      两类确定性信号——极小文件（<8KB）与近似纯色 / 渐变图（bpp < 0.02）
 *      直接跳过；尺寸解析失败一律保守保留。
 *   2. 整批一次分类调用（prefilterBatch 第二层）：把本层保留图分批（≤12 张 / 批）
 *      上传百炼 File API 后用一次图文会话批量分类——1 次会话替代 N 次单图 OCR，
 *      模型按保守规则只允许跳过「人像 / 风景 且画面无可读文字」的图片。
 *
 * 保守原则（宁可多送模型，不可漏掉含文字线索的图）：
 *   - 本地信号只删确定性低信息（极小 / 极低密度）；任何解析失败保留；
 *   - 分类响应解析失败 / 会话失败 / 环境变量未配置 → 该批全部保守保留；
 *   - 响应条目缺失或非法 → 仅缺失图保留，不放大跳过范围；
 *   - 跳过只影响是否送 OCR，不删除原图、不影响原文回看（由 service 层保证），
 *     用户可按需重试（重试走 processRetryImages，不再预筛）。
 *
 * 隐私铁律（与 ocr.ts 同源）：预筛上传的百炼 file_id 在 finally 中全部删除，
 * 不留存云端副本；上传失败的图不会进入分类会话。
 *
 * 依赖取舍（Task #175）：不新增任何图像处理库——JPEG SOF / PNG IHDR 尺寸
 * 读取用手写字节解析（~60 行，仅读头部无需解码像素），避免 sharp / jimp
 * 等原生或纯 JS 大依赖进入 server 包。
 */

import {
  createBailianSession,
  deleteBailianFile,
  uploadBailianFile,
  waitForBailianFileAvailable,
  type BailianContentBlock,
} from "../bailian/client.js";
import { getMissingBailianVars } from "../env.js";
import { repairJsonCandidates } from "./jsonRepair.js";
import { lastBalancedJsonValue } from "./lastJson.js";

// ===== 参数（全部显式命名导出，供验证脚本断言） =====

/** 本地硬筛：低于该字节数的图片几乎不可能含有可读的菜单 / 地图 / 招牌文字 */
export const PREFILTER_MIN_IMAGE_BYTES = 8 * 1024;
/** 本地硬筛：像素信息密度下限（bytes per pixel）；真实照片量级为 0.1~0.5 B/px */
export const PREFILTER_MIN_BYTES_PER_PIXEL = 0.02;
/** 整批分类：单次图文会话最多图片数（沿用旧 12 张上限的已验证规模） */
export const PREFILTER_BATCH_CLASSIFY_SIZE = 12;
/** 整批分类：File API 上传并发（与 GUIDE_IMAGE_CONCURRENCY 对齐） */
export const PREFILTER_UPLOAD_CONCURRENCY = 4;
/** 整批分类：单次图文会话超时（与 OCR_SESSION_TIMEOUT_MS 同量级） */
export const PREFILTER_SESSION_TIMEOUT_MS = 120_000;

/** 与 ocr.ts 的 CODE_FENCE_PATTERN 同源（该常量未导出，此处本地定义） */
const CODE_FENCE_PATTERN = /```(?:json)?\s*([\s\S]*?)```/i;

// ===== 输入 / 输出形状 =====

/** 预筛输入项（与 OcrScreenshotInput 同构；透传上传，不重复校验） */
export interface PrefilterImageInput {
  /** 图片二进制（仅用于本地解析与上传，不进任何日志 / 错误消息） */
  data: Uint8Array;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

/** 单张跳过决定：只有被跳过的图才进入返回 Map（缺省 = 保留） */
export interface PrefilterSkipDecision {
  /** 用户可读的可解释原因（写入 imageProgress.failureMessage 展示） */
  reason: string;
  /** 触发层：local = 本地零成本硬筛；batch = 整批分类调用 */
  stage: "local" | "batch";
}

/** 本地硬筛单图结论 */
export type LocalPrefilterVerdict = { skip: false } | { skip: true; reason: string };

// ===== 尺寸解析（零依赖字节读取） =====

/**
 * 读取图片像素尺寸：仅支持 JPEG（扫描 SOF 段）与 PNG（IHDR 固定偏移），
 * 其余格式 / 畸形数据返回 null（调用方保守保留）。
 * 不解码像素、不引入图像库：预筛只需要宽高做密度估算。
 */
export function parseImageDimensions(
  data: Uint8Array,
): { width: number; height: number } | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return parseJpegDimensions(data);
  }
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return parsePngDimensions(data);
  }
  return null;
}

/**
 * JPEG：从 SOI 后逐段扫描标记，读到首个 SOF 段（SOF0~SOF15，排除
 * DHT=0xC4 / JPG=0xC8 / DAC=0xCC）即取宽高；SOS（0xDA）后是扫描数据，
 * SOF 必然在其之前，直接终止。任一步越界 / 畸形返回 null。
 */
function parseJpegDimensions(
  data: Uint8Array,
): { width: number; height: number } | null {
  let offset = 2; // 跳过 SOI（FF D8）
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) {
      offset += 1; // 容忍填充字节
      continue;
    }
    const marker = data[offset + 1];
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      // TEM / RST0-7 / SOI 等无长度段
      offset += 2;
      continue;
    }
    if (marker === 0xda) return null; // SOS：SOF 未出现，放弃
    if (offset + 4 > data.length) return null;
    const segmentLength = (data[offset + 2] << 8) | data[offset + 3];
    if (segmentLength < 2) return null; // 畸形段长度
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof) {
      // SOF 段：长度(2B) + 精度(1B) + 高(2B) + 宽(2B)
      if (offset + 9 > data.length) return null;
      const height = (data[offset + 5] << 8) | data[offset + 6];
      const width = (data[offset + 7] << 8) | data[offset + 8];
      if (width > 0 && height > 0) return { width, height };
      return null;
    }
    offset += 2 + segmentLength;
  }
  return null;
}

/** PNG：签名(8B) + IHDR 长度(4B) + "IHDR"(4B) + 宽(4B, offset 16..19) + 高(4B, offset 20..23)，大端 */
function parsePngDimensions(
  data: Uint8Array,
): { width: number; height: number } | null {
  if (data.length < 24) return null;
  const width =
    (((data[16] << 24) | (data[17] << 16) | (data[18] << 8) | data[19]) >>> 0);
  const height =
    (((data[20] << 24) | (data[21] << 16) | (data[22] << 8) | data[23]) >>> 0);
  // 10 万像素上限：真实图片远小于此，超出按畸形数据保守保留
  if (width > 0 && height > 0 && width <= 100_000 && height <= 100_000) {
    return { width, height };
  }
  return null;
}

// ===== 第一层：本地零成本硬筛 =====

/**
 * 本地硬筛（不触网、零模型成本）：R1 极小文件；R2 像素信息密度过低。
 * 尺寸解析失败 / 其余全部情况保守保留。
 */
export function assessLocalInformation(
  item: PrefilterImageInput,
): LocalPrefilterVerdict {
  if (item.sizeBytes < PREFILTER_MIN_IMAGE_BYTES) {
    return {
      skip: true,
      reason: `图片体积过小（约 ${Math.max(1, Math.round(item.sizeBytes / 1024))}KB，低于 8KB 预筛下限），预判不含可读文字信息`,
    };
  }
  const dimensions = parseImageDimensions(item.data);
  if (dimensions !== null) {
    const bpp = item.sizeBytes / (dimensions.width * dimensions.height);
    if (bpp < PREFILTER_MIN_BYTES_PER_PIXEL) {
      return {
        skip: true,
        reason: `图片信息密度过低（${bpp.toFixed(3)} 字节/像素 < 0.02，近似纯色或渐变图），预判不含可读文字`,
      };
    }
  }
  return { skip: false };
}

// ===== 第二层：整批一次分类调用 =====

/**
 * 批量分类 prompt（保守规则定稿）：只有「人像 / 风景 且 textClue=false」
 * 允许跳过；info 类、任何文字线索、不确定情况一律保留。
 */
export function buildBatchClassifyPrompt(count: number): string {
  return [
    `你是一次行程攻略图片导入的预筛选分类器。下面按顺序给出 ${count} 张图片：第 1 张图片对应 index 1，第 2 张对应 index 2，以此类推。`,
    "",
    "对每张图片输出两项判断：",
    '1. category（图片类型）："info" 表示含有对行程有实际帮助的信息（菜单、价目表、地图、导览图、路线图、营业时间、地址门牌、店铺招牌、告示、票券、二维码、表格、攻略文字等）；"portrait" 表示以人物为主的自拍或人像合影；"landscape" 表示纯风景、建筑、美食特写等以画面为主的内容。',
    "2. textClue（画面中是否出现任何可读文字）：包括背景中的店铺招牌、地名路牌、景点名称石刻、建筑匾额、包装文字等。只要出现任何文字（哪怕模糊、哪怕只有一个词），textClue 必须为 true。",
    "",
    "判定规则（务必保守）：",
    "- 只有 category 为 portrait 或 landscape 且 textClue 为 false 的图片才会被跳过，不再送 OCR 识别；",
    "- 只要你不确定该图是否含文字，必须把 textClue 设为 true（保留该图）；",
    "- 宁可多保留一张图，也绝不允许漏掉任何含文字线索的图片。",
    "",
    "只输出严格 JSON，不要输出任何其他文字，格式如下：",
    '{"images":[{"index":1,"category":"info","textClue":true},{"index":2,"category":"landscape","textClue":false}]}',
  ].join("\n");
}

/** 模型侧单图判定（index 为 1-based） */
interface ParsedBatchImageVerdict {
  index: number;
  category: string;
  textClue: boolean;
}

/** 结构归一化：images 数组 + 每项 { index(1..count), category(string), textClue(boolean) }；缺条目不视为失败（缺失图保守保留） */
function normalizeBatchVerdicts(
  value: unknown,
  count: number,
): ParsedBatchImageVerdict[] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const images = (value as Record<string, unknown>).images;
  if (!Array.isArray(images)) return null;
  const verdicts: ParsedBatchImageVerdict[] = [];
  for (const entry of images) {
    if (typeof entry !== "object" || entry === null) return null;
    const record = entry as Record<string, unknown>;
    const index = record.index;
    const category = record.category;
    const textClue = record.textClue;
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 1 ||
      index > count
    ) {
      return null;
    }
    if (typeof category !== "string") return null;
    if (typeof textClue !== "boolean") return null;
    verdicts.push({ index, category, textClue });
  }
  return verdicts;
}

/**
 * 解析批量分类响应（与 ocr.parseOcrResponse 同款候选链：直接 parse →
 * code fence → 最后一个平衡 JSON 块 → 保守修复候选）。
 * 返回 Map<index(1-based), 跳过原因>，仅含被跳过的图（保守规则内过滤）；
 * 全部候选都无法解析出 images 数组时返回 null（调用方整批保守保留）。
 */
export function parseBatchClassifyResponse(
  finalText: string,
  count: number,
): Map<number, string> | null {
  const trimmed = finalText.trim();
  const candidates: string[] = [];
  const fenced = trimmed.match(CODE_FENCE_PATTERN)?.[1];
  if (fenced) candidates.push(fenced.trim());
  candidates.push(trimmed);
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
    const verdicts = normalizeBatchVerdicts(parsed, count);
    if (verdicts === null) continue;
    const skips = new Map<number, string>();
    for (const verdict of verdicts) {
      // 保守过滤：info 类 / 有文字线索 / 其余未知类别一律保留
      if (verdict.textClue) continue;
      if (verdict.category === "portrait") {
        skips.set(
          verdict.index,
          "预筛判定为纯人像图且画面无可读文字线索，跳过 OCR 识别（可按需重试）",
        );
      } else if (verdict.category === "landscape") {
        skips.set(
          verdict.index,
          "预筛判定为纯风景图且画面无可读文字线索，跳过 OCR 识别（可按需重试）",
        );
      }
    }
    return skips;
  }
  return null;
}

/** 批内一条待分类条目：候选序号（0-based）+ 已审核可用的 file_id */
type ClassifyEntry = readonly [candidateIndex: number, fileId: string];

/** 单批图文会话：解析成功按保守规则记录跳过；调用 / 解析失败整批保守保留（不抛错） */
async function classifyOneBatch(
  batch: readonly ClassifyEntry[],
  skips: Map<number, string>,
): Promise<void> {
  const count = batch.length;
  const blocks: BailianContentBlock[] = [
    { type: "text", text: buildBatchClassifyPrompt(count) },
    ...batch.map(([, fileId]) => ({ type: "image" as const, file_id: fileId })),
  ];
  let finalText: string;
  try {
    const result = await createBailianSession(blocks, {
      timeoutMs: PREFILTER_SESSION_TIMEOUT_MS,
    });
    finalText = result.finalText;
    console.log(
      `[AI] 预筛批量分类返回（${count} 张 / ${finalText.length} 字符，耗时 ${result.latencyMs}ms）`,
    );
  } catch (error) {
    console.warn(
      `[AI] 预筛批量分类调用失败，${count} 张保守保留：${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  const batchSkips = parseBatchClassifyResponse(finalText, count);
  if (batchSkips === null) {
    console.error(
      `[AI] 预筛批量分类响应无法解析，${count} 张保守保留，前 200 字符：${finalText.slice(0, 200)}`,
    );
    return;
  }
  for (const [oneBasedIndex, reason] of batchSkips) {
    const entry = batch[oneBasedIndex - 1];
    if (entry === undefined) continue; // 非法 index 防御：忽略该条目
    skips.set(entry[0], reason);
  }
}

/**
 * 第二层实现：把候选图全部上传百炼 File API（并发 4 / 批），然后每
 * ≤12 张一组跑一次批量分类会话；无论成败 finally 删除全部已上传 file_id。
 * 返回 Map<候选序号(0-based), 跳过原因>，仅含被跳过的图。
 * 环境变量未配置（离线验证等）直接返回空 Map——全部保守保留。
 */
async function classifyRemainingByBatch(
  images: readonly PrefilterImageInput[],
): Promise<Map<number, string>> {
  const skips = new Map<number, string>();
  if (images.length === 0) return skips;

  const missingVars = getMissingBailianVars();
  if (missingVars.length > 0) {
    console.warn(
      `[AI] 图片预筛跳过整批分类（百炼环境变量未配置：${missingVars.join("、")}），${images.length} 张全部保守保留`,
    );
    return skips;
  }

  // 上传 + 轮询审核（分批并发；单张失败只保守保留该张）
  const uploadedIds = new Set<string>();
  const entries: ClassifyEntry[] = [];
  for (
    let batchStart = 0;
    batchStart < images.length;
    batchStart += PREFILTER_UPLOAD_CONCURRENCY
  ) {
    const uploadBatch = images
      .slice(batchStart, batchStart + PREFILTER_UPLOAD_CONCURRENCY)
      .map((image, offset) => ({ image, index: batchStart + offset }));
    await Promise.all(
      uploadBatch.map(async ({ image, index }) => {
        try {
          const uploaded = await uploadBailianFile({
            data: image.data,
            filename: image.filename,
            mimeType: image.mimeType,
          });
          uploadedIds.add(uploaded.id);
          await waitForBailianFileAvailable(uploaded.id);
          entries.push([index, uploaded.id]);
        } catch (error) {
          console.warn(
            `[AI] 预筛上传失败（${image.filename}），该图保守保留：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );
  }

  try {
    for (
      let batchStart = 0;
      batchStart < entries.length;
      batchStart += PREFILTER_BATCH_CLASSIFY_SIZE
    ) {
      await classifyOneBatch(
        entries.slice(batchStart, batchStart + PREFILTER_BATCH_CLASSIFY_SIZE),
        skips,
      );
    }
  } finally {
    // 隐私铁律：无论成败删除全部已上传 file_id，不留存云端副本
    await Promise.all(
      [...uploadedIds].map(async (fileId) => {
        const deleted = await deleteBailianFile(fileId);
        if (deleted) {
          console.log(`[AI] 预筛百炼文件已删除（fileId=${fileId}）`);
        }
      }),
    );
  }
  return skips;
}

// ===== 预筛主入口 =====

/**
 * 图片预筛主入口（service.guideServiceDeps.prefilterBatch 的默认实现）：
 * 先本地零成本硬筛，再对保留图跑整批一次分类调用。
 * 返回 Map<输入序号, 跳过决定>，只含被跳过的图——Map 中不出现的序号
 * 一律视为保留；本函数自身不抛错（任何内部失败都等价于保守保留）。
 */
export async function prefilterBatch(
  items: readonly PrefilterImageInput[],
): Promise<Map<number, PrefilterSkipDecision>> {
  const startedAt = Date.now();
  const skips = new Map<number, PrefilterSkipDecision>();

  // 第一层：本地硬筛
  items.forEach((item, index) => {
    const verdict = assessLocalInformation(item);
    if (verdict.skip) {
      skips.set(index, { reason: verdict.reason, stage: "local" });
    }
  });

  // 第二层：整批分类（只送本层保留的图）
  const candidates = items
    .map((item, index) => ({ item, index }))
    .filter(({ index }) => !skips.has(index));
  if (candidates.length > 0) {
    const batchSkips = await classifyRemainingByBatch(
      candidates.map(({ item }) => item),
    );
    for (const [candidateIndex, reason] of batchSkips) {
      const target = candidates[candidateIndex];
      if (target === undefined) continue; // 防御：序号越界忽略
      skips.set(target.index, { reason, stage: "batch" });
    }
  }

  console.log(
    `[AI] 图片预筛完成：共 ${items.length} 张，跳过 ${skips.size} 张（本地硬筛 ${
      [...skips.values()].filter((decision) => decision.stage === "local").length
    } / 批量分类 ${
      [...skips.values()].filter((decision) => decision.stage === "batch").length
    }），保留 ${items.length - skips.size} 张送模型，预筛耗时 ${Date.now() - startedAt}ms`,
  );
  return skips;
}
