/**
 * 攻略来源服务层（Task #96，修订附录 B v0.3 B2）：提交 / 去重 / 异步图片处理 /
 * 状态机 / 重启恢复 / 重试 / 移除 / 恢复 / 补充句。
 *
 * 核心语义（附录 B §3.1 / §5）：
 * - 提交三种输入（link / text / images）先原子创建 processing 来源并保存，
 *   接口两秒内返回 sourceId 与当前状态；抓取 / 抽取 / 图片识别全部后台异步；
 * - canonicalUrl（规范化链接）与 contentHash（内容哈希）任一相同即同一篇：
 *   命中返回已有 sourceId 不重抓不重计数；已移除来源仍命中（恢复 active 复用成果）；
 *   命中 failed 来源视为重新导入（无成果可复用，重跑并 sourceVersion+1）；
 * - 状态机 processing → ready | partial | failed：
 *   正文可用而图片未完 → processing；全部成功 → ready；
 *   部分图片失败或预算耗尽 → partial；无任何可用内容 → failed；
 *   skipped（预筛跳过，Task #175）是确定状态：不算成功也不算失败，
 *   不阻塞 ready 判定，可按需重试；
 * - 图片预筛（Task #175，目标一）：在昂贵百炼 OCR 之前用低成本信号
 *   （本地字节/密度硬筛 + 整批一次分类）跳过纯风景 / 人像等低信息图：
 *   跳过只影响是否送模型，原图与空证据保留可回看，可按需重试；
 *   任何预筛失败一律保守保留，绝不用 OCR 后空文本冒充预筛；
 * - 图片 OCR 延迟（Task #215）：link / images 来源默认只解析正文，图片照常
 *   下载落盘但不自动启动 OCR（imageOcrDeferred=true，进度保持 pending，
 *   正文可用即结算 ready）；来源卡片「解析图片」按钮经 triggerImageOcr
 *   一键启动全部待解析图（复用重试队列，不预筛）；
 * - 正文证据补偿（Task #217）：链接抓取成功即把正文持久化到 sourceText；partial
 *   来源若从未创建 note_text 证据，重试优先补正文（有原文→本地重抽零网络，历史
 *   来源→兜底重抓链接），同一篇笔记重抓沿用已完成的图结果（不重复识别、不重建
 *   截图证据）；
 * - 残留图收敛（Task #222）：非延迟来源结算时残留的 pending / processing 图
 *   统一收敛为 failed(timeout)（pending 既不计失败也不可重试，来源会永远卡在
 *   partial）；partial 重试兜底纳入残留未完成图；原图定位增加小红书落盘约定
 *   探测（uploads/xhs_{noteId}/{页码}.{ext}），证据与进度明细均无 assetPath
 *   的存量图可重新定位；
 * - 图片队列（jobs.ts）：并发 4 / 单图 120s / 总预算按送模型图数动态伸缩
 *   （guideSourceBudgetMs，Task #175）；单图失败记录具体 failureCode
 *   不阻塞其他图；每图完成即写盘；预算耗尽即结算，仍在跑的识别结果
 *   凭运行令牌失效丢弃（不迟到回写、不重叠重试）；
 * - 链接来源下载（Task #175，目标二）：单图下载失败保留原始页码占位
 *   （failed / download_failed），后续图片绝不前移错映射 P 页码；
 * - 后台只补 GuideSource / evidence / mentions 与候选池（suppressAttach：
 *   高置信玩法一律 pending 待用户确认，不自动改动已生成行程），
 *   不触碰 pendingGuideDraft（sourceVersion 递增使旧快照自然过期，
 *   支撑「发现新的攻略细节，可重新优化」提示）；
 * - 写一致性：tripStore.save 无乐观锁比对，本层用 per-trip 锁串行化全部
 *   「load → 改 → save」临界区；装配（含 FlyAI 搜索）在锁外跑，
 *   以「版本未变才落盘，变了重试装配」的乐观提交收口（MAX_COMMIT_ATTEMPTS 次）；
 * - 重启恢复：读取列表时扫描 processing 来源，无活跃 job（进程内注册表为空）
 *   即视为重启遗留：保留已成功证据转 partial（或无成果转 failed），
 *   未完成图标 timeout 失败，提示可重试；不自动发送任何百炼请求。
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { FlyAIPoi } from "../flyai/client.js";
import type {
  GuideFailureCode,
  GuideImageFailureCode,
  GuideImageProgress,
  GuideImageProgressEntry,
  GuideSource,
  GuideSourceStatus,
  SourceEvidence,
  Trip,
} from "@goplay/shared";
import {
  createEmptyGuideImageProgress,
  deriveTextSourceTitle,
  findDuplicateGuideSource,
  hasUsableGuideEvidence,
  normalizeCanonicalUrl,
  normalizeXhsLinkInput,
} from "@goplay/shared";
import { AiError, condenseErrorDetail } from "../ai/errors.js";
import { assembleEntries, nextNoteIndex, type ParsedEntry } from "../ai/assemble.js";
import { generateId } from "../ai/idGen.js";
import { extractNoteEntries } from "../ai/extract.js";
import { hasLocalFallbackEntries } from "../ai/localExtract.js";
import {
  detectImageKind,
  persistTripAsset,
  recognizeImageContent,
  type OcrScreenshotInput,
  type PersistedTripAsset,
  type RecognizedImageContent,
} from "../ai/ocr.js";
import { extractXhsNote, extractXhsNoteId, isXhsUrl, XhsError, type XhsImageSlot, type XhsNoteResult } from "../ai/xhs.js";
import {
  prefilterBatch,
  type PrefilterImageInput,
  type PrefilterSkipDecision,
} from "../ai/prefilter.js";
import { UPLOADS_DIR, tripStore } from "../persistence/store.js";
import {
  GUIDE_IMAGE_CONCURRENCY,
  GUIDE_IMAGE_TIMEOUT_MS,
  GUIDE_MAX_IMAGES,
  GUIDE_SOURCE_BUDGET_MS,
  guideSourceBudgetMs,
  hasActiveGuideJob,
  registerGuideJob,
  runGuideImageQueueForSource,
  unregisterGuideJob,
  withSourceImageRun,
  withTripLock,
  type GuideImageQueueOutcome,
  type GuideImageRunContext,
  type GuideImageTask,
  type GuideImageTaskResult,
} from "./jobs.js";

// ===== 参数上限 =====

/** 攻略正文长度上限：超长正文拒绝（防误粘贴整本书 / 攻击性大报文） */
const MAX_TEXT_CHARS = 50_000;
/** 来源标题上限：超长截断（不报错，标题只是展示辅助） */
const MAX_TITLE_CHARS = 100;
/** 链接长度上限（与 ai/routes.ts 的 extract-url 一致） */
const MAX_SOURCE_URL_LENGTH = 2_048;
/** 单图大小上限（与 /api/ai/ocr 的 10MB 一致） */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** 乐观提交（装配后版本校验落盘）的最大重试次数：Task #121 图片并发 3 → 4 后
 *  同一来源的写盘窗口重叠更密，4 次会出现个别图“重试耗尽”而被误记失败，故放宽到 12 */
const MAX_COMMIT_ATTEMPTS = 12;
/** 攻略补充句长度上限（导出供 B3 草案生成入口的顺手保存同限校验） */
export const DRAFT_NOTE_MAX_CHARS = 500;

function nowIso(): string {
  return new Date().toISOString();
}

/** 毫秒等待（乐观提交冲突后的随机退避，避免多 worker 同步重抢） */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha16(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

// ===== 依赖注入（验证脚本可用桩替换，不触网驱动状态机） =====

/**
 * 服务层外部依赖的最小面：抓取 / 正文抽取 / 单图识别 / 图片预筛（Task #175）。
 * prefilterBatch 返回 Map<0-based 序号, 跳过决定>，只含被跳过的图
 * （Map 中不出现的序号一律保留）；实现自身不抛错（失败等价于全保留）。
 */
export interface GuideServiceDeps {
  fetchNote: (url: string) => Promise<XhsNoteResult>;
  extractEntries: (text: string) => Promise<ParsedEntry[]>;
  recognizeImage: (image: OcrScreenshotInput, options?: { editedText?: string }) => Promise<RecognizedImageContent>;
  prefilterBatch: (items: readonly PrefilterImageInput[]) => Promise<Map<number, PrefilterSkipDecision>>;
}

const defaultDeps: GuideServiceDeps = {
  fetchNote: extractXhsNote,
  extractEntries: extractNoteEntries,
  recognizeImage: recognizeImageContent,
  prefilterBatch,
};

let deps: GuideServiceDeps = defaultDeps;

/** 替换部分依赖（桩注入）；传空对象无操作 */
export function setGuideServiceDeps(overrides: Partial<GuideServiceDeps>): void {
  deps = { ...deps, ...overrides };
}

/** 恢复默认依赖 */
export function resetGuideServiceDeps(): void {
  deps = defaultDeps;
}

// ===== 输入类型 =====

export interface SubmitGuideImageInput {
  data: Uint8Array;
  filename: string;
  /** 客户端声明的 MIME；服务端按 magic bytes 复核，不信任此值 */
  mimeType: string;
}

export interface SubmitGuideSourceInput {
  inputKind: "link" | "text" | "images";
  /** link 必填 */
  url?: string;
  /** text 必填 */
  text?: string;
  /** images 必填（1..GUIDE_MAX_IMAGES，Task #175 起 24） */
  images?: SubmitGuideImageInput[];
  /** 展示标题（可选） */
  title?: string;
  /** text / images 可选附带来源链接（只保存不抓取） */
  sourceUrl?: string;
}

export interface SubmitGuideSourceResult {
  sourceId: string;
  status: GuideSourceStatus;
  /** 命中已有来源（canonicalUrl / contentHash 去重） */
  duplicate: boolean;
  source: GuideSource;
}

// ===== 提交 =====

/** 提交参数校验：非法请求在创建任何来源之前拒绝（不落盘） */
function validateSubmitInput(input: SubmitGuideSourceInput): void {
  if (input.inputKind === "link") {
    const url = typeof input.url === "string" ? input.url.trim() : "";
    if (url === "") {
      throw new AiError("INVALID_REQUEST", "链接来源必须提供小红书笔记链接");
    }
    if (url.length > MAX_SOURCE_URL_LENGTH || !isXhsUrl(url)) {
      throw new AiError("LINK_INVALID", "仅支持小红书笔记链接（xiaohongshu.com / xhslink.com / xhslink.cn）");
    }
    return;
  }
  if (input.inputKind === "text") {
    const text = typeof input.text === "string" ? input.text : "";
    if (text.trim() === "") {
      throw new AiError("INVALID_REQUEST", "文字来源的正文不能为空");
    }
    if (text.length > MAX_TEXT_CHARS) {
      throw new AiError("INVALID_REQUEST", `正文超过 ${MAX_TEXT_CHARS} 字上限，请分段粘贴`);
    }
  } else if (input.inputKind === "images") {
    const images = Array.isArray(input.images) ? input.images : [];
    if (images.length === 0) {
      throw new AiError("INVALID_REQUEST", "图片来源至少需要一张图片");
    }
    if (images.length > GUIDE_MAX_IMAGES) {
      throw new AiError("IMAGE_COUNT_EXCEEDED", `单次最多提交 ${GUIDE_MAX_IMAGES} 张图片（当前 ${images.length} 张）`);
    }
    for (const [position, image] of images.entries()) {
      if (image.data.length === 0) {
        throw new AiError("INVALID_REQUEST", `第 ${position + 1} 张图片内容为空`);
      }
      if (image.data.length > MAX_IMAGE_BYTES) {
        throw new AiError(
          "IMAGE_TOO_LARGE",
          `第 ${position + 1} 张图片超过 10MB 上限（当前 ${(image.data.length / 1024 / 1024).toFixed(1)}MB），请压缩后重试`,
        );
      }
    }
  } else {
    throw new AiError("INVALID_REQUEST", "inputKind 必须是 link / text / images 之一");
  }
  const sourceUrl = typeof input.sourceUrl === "string" ? input.sourceUrl.trim() : "";
  if (sourceUrl.length > MAX_SOURCE_URL_LENGTH) {
    throw new AiError("INVALID_REQUEST", "来源链接过长，请检查后重试");
  }
}

/** 图片组内容哈希：全部字节按序拼接后取 sha256 前 16 位 */
function hashImagesContent(images: SubmitGuideImageInput[]): string {
  const hasher = createHash("sha256");
  for (const image of images) hasher.update(image.data);
  return hasher.digest("hex").slice(0, 16);
}

/** 提交时已准备好的单图资产：evidenceId（= 落盘文件名）+ 原图字节 + 落盘结果 */
interface PreparedImageAsset {
  index: number;
  evidenceId: string;
  data: Uint8Array;
  filename: string;
  sizeBytes: number;
  asset: PersistedTripAsset;
}

/** 全 pending 的图片进度（提交 images / 抓取到图片列表时初始化） */
function buildPendingImageProgress(total: number): GuideImageProgress {
  const images: GuideImageProgressEntry[] = [];
  for (let index = 1; index <= total; index++) {
    images.push({ index, status: "pending", evidenceId: null });
  }
  return { total, completed: 0, failed: 0, images };
}

/**
 * 槽位版图片进度（Task #175，目标二）：页码 = 槽位序号（1-based），
 * 下载失败的槽位直接标 failed / download_failed 占位（保留原始页码，
 * 后续图片绝不前移错映射 P 页码），其余 pending。
 */
function buildSlotImageProgress(
  total: number,
  failedSlots: ReadonlyMap<number, string>,
): GuideImageProgress {
  const images: GuideImageProgressEntry[] = [];
  for (let index = 1; index <= total; index++) {
    const error = failedSlots.get(index);
    images.push(
      error !== undefined
        ? {
            index,
            status: "failed",
            evidenceId: null,
            failureCode: "download_failed",
            failureMessage: error,
          }
        : { index, status: "pending", evidenceId: null },
    );
  }
  const progress: GuideImageProgress = { total, completed: 0, failed: 0, images };
  recountImageProgress(progress);
  return progress;
}

/** 从 images 明细重算 completed / failed 计数（保持校验口径一致） */
function recountImageProgress(progress: GuideImageProgress): void {
  let completed = 0;
  let failed = 0;
  for (const entry of progress.images) {
    if (entry.status === "ready") completed += 1;
    else if (entry.status === "failed") failed += 1;
  }
  progress.completed = completed;
  progress.failed = failed;
}

async function loadTripOrThrow(tripId: string): Promise<Trip> {
  let trip: Trip | null;
  try {
    trip = await tripStore.load(tripId);
  } catch {
    throw new AiError("TRIP_NOT_FOUND", "行程不存在或已被删除，请刷新页面后重试");
  }
  if (trip === null) {
    throw new AiError("TRIP_NOT_FOUND", "行程不存在或已被删除，请刷新页面后重试");
  }
  return trip;
}

/**
 * 提交攻略来源：
 * 1. 参数校验（失败不落盘）；
 * 2. per-trip 锁内 load → 去重 → 命中处理 / 创建 processing 来源 → （images 模式
 *    同步落盘原图）→ save；临界区只有内存与本地文件操作，两秒内返回；
 * 3. 需要处理时注册活跃 job 并 fire-and-forget 后台流水线；
 * 4. 返回 sourceId + 当前状态（duplicate 标记命中已有来源）。
 */
export async function submitGuideSource(
  tripId: string,
  rawInput: SubmitGuideSourceInput,
): Promise<SubmitGuideSourceResult> {
  // Task #304：link 提交入口归一化——无 scheme 形态（App 复制出的
  // `xiaohongshu.com/…`）补 `https://` 后再校验与分流；非链接形态原样透传，
  // 仍由 validateSubmitInput 的 isXhsUrl 把关（识别放宽 ≠ 校验放宽）。
  const input: SubmitGuideSourceInput =
    rawInput.inputKind === "link" && typeof rawInput.url === "string"
      ? { ...rawInput, url: normalizeXhsLinkInput(rawInput.url) }
      : rawInput;
  validateSubmitInput(input);

  // 身份字段（去重比对候选）
  const identity: { sourceUrl?: string | null; canonicalUrl?: string | null; contentHash?: string | null } = {};
  if (input.inputKind === "link") {
    identity.canonicalUrl = normalizeCanonicalUrl(input.url!.trim());
    identity.sourceUrl = input.url!.trim();
  } else if (input.inputKind === "text") {
    identity.contentHash = sha16(input.text!);
    if (typeof input.sourceUrl === "string" && input.sourceUrl.trim() !== "") {
      identity.sourceUrl = input.sourceUrl.trim();
      identity.canonicalUrl = normalizeCanonicalUrl(input.sourceUrl.trim());
    }
  } else {
    identity.contentHash = hashImagesContent(input.images!);
    if (typeof input.sourceUrl === "string" && input.sourceUrl.trim() !== "") {
      identity.sourceUrl = input.sourceUrl.trim();
      identity.canonicalUrl = normalizeCanonicalUrl(input.sourceUrl.trim());
    }
  }

  const submitted = await withTripLock(tripId, async (): Promise<
    SubmitGuideSourceResult & { plan: SourceJobPlan | null }
  > => {
    const trip = await loadTripOrThrow(tripId);
    trip.guideSources ??= {};
    const duplicate = findDuplicateGuideSource(trip.guideSources, identity);

    if (duplicate !== null) {
      return handleDuplicateSource(trip, duplicate, input, identity);
    }

    // 创建 processing 来源（原子保存）
    // Task #284：sourceId 经中央生成器——功能态＝randomUUID 零变化；评测态注入
    // 内容种子派生（contentHash/canonicalUrl），跨进程稳定 → prompt 可回放。
    // 同文不同链的极端场景在确定性派生下才会撞键，按既有来源数追加派生轮次防御
    //（功能态随机 id 首次即空闲，不进循环，行为与原先逐 bit 一致）。
    const identitySeed = identity.contentHash ?? identity.canonicalUrl ?? identity.sourceUrl ?? "";
    let idAttempt = 0;
    let sourceId = `src_${generateId(`src:${tripId}:${identitySeed}:${idAttempt}`).slice(0, 8)}`;
    while (trip.guideSources[sourceId] !== undefined) {
      idAttempt += 1;
      sourceId = `src_${generateId(`src:${tripId}:${identitySeed}:${idAttempt}`).slice(0, 8)}`;
    }
    const now = nowIso();
    const title = resolveSourceTitle(input);
    const source: GuideSource = {
      sourceId,
      sourceVersion: 1,
      inputKind: input.inputKind,
      ...(title !== undefined && title !== "" ? { title } : {}),
      ...(input.inputKind === "link"
        ? { sourceUrl: input.url!.trim(), canonicalUrl: identity.canonicalUrl! }
        : typeof input.sourceUrl === "string" && input.sourceUrl.trim() !== ""
          ? { sourceUrl: input.sourceUrl.trim(), ...(identity.canonicalUrl ? { canonicalUrl: identity.canonicalUrl } : {}) }
          : {}),
      ...(identity.contentHash ? { contentHash: identity.contentHash } : {}),
      // 任务 186 原文回看：文字来源创建时原样持久化用户提交的完整原文
      //（上限同 MAX_TEXT_CHARS，已由 validateSubmitInput 保证）；历史来源无此字段
      ...(input.inputKind === "text" ? { sourceText: input.text! } : {}),
      active: true,
      // Task #161：新增来源默认暂存——不参与默认（全部模式）草案合并与候选支撑，
      // 仅可被本轮显式 selectedSourceIds 选中参与局部优化；历史来源无此字段（非暂存）
      staged: true,
      status: "processing",
      evidenceRefs: [],
      mentionRefs: [],
      imageProgress:
        input.inputKind === "images"
          ? buildPendingImageProgress(input.images!.length)
          : createEmptyGuideImageProgress(),
      importedAt: now,
      updatedAt: now,
    };

    // images 模式：提交时同步落盘原图（文件名 = 每图 evidenceId，复用受控回看路由）；
    // 配额超限只降级 assetPath 并附提示，不阻塞识别。
    // 任务 186：落盘路径同步写入 imageProgress 明细（原文回看按上传顺序展示全部原图）
    let assets: PreparedImageAsset[] = [];
    if (input.inputKind === "images") {
      assets = await prepareUploadAssets(tripId, input.images!);
      for (const asset of assets) {
        const entry = source.imageProgress.images[asset.index - 1];
        if (entry !== undefined) entry.assetPath = asset.asset.assetPath;
      }
    }

    trip.guideSources[sourceId] = source;
    await tripStore.save(trip);

    const plan: SourceJobPlan =
      input.inputKind === "link"
        ? { kind: "link", url: input.url!.trim() }
        : input.inputKind === "text"
          ? { kind: "text", text: input.text!, sourceUrl: typeof input.sourceUrl === "string" && input.sourceUrl.trim() !== "" ? input.sourceUrl.trim() : null }
          : { kind: "images" };
    return { sourceId, status: source.status, duplicate: false, source, plan };
  });

  if (submitted.plan !== null) {
    scheduleSourceJob(tripId, submitted.sourceId, submitted.plan);
  }
  return {
    sourceId: submitted.sourceId,
    status: submitted.status,
    duplicate: submitted.duplicate,
    source: submitted.source,
  };
}

/**
 * 新建来源的展示标题（Task #262）：
 * - 调用方显式传 title：去首尾空白后按 MAX_TITLE_CHARS 截断（既有行为不变）；
 * - 文字来源未传 title：用正文开头若干字派生默认标题
 *   （不再让多篇粘贴攻略统一无标题、靠前端兜底显示同一句「粘贴的攻略文字」）；
 * - 其他形态（link / images）无标题时保持 undefined，由前端按输入形态兜底展示。
 * 只作用于新建来源：历史来源存量标题不改（重复命中 / 重试不回写标题）。
 */
function resolveSourceTitle(input: SubmitGuideSourceInput): string | undefined {
  if (typeof input.title === "string") {
    const explicit = input.title.trim().slice(0, MAX_TITLE_CHARS);
    if (explicit !== "") return explicit;
  }
  if (input.inputKind === "text" && typeof input.text === "string") {
    return deriveTextSourceTitle(input.text).slice(0, MAX_TITLE_CHARS);
  }
  return undefined;
}

/** 提交时同步落盘图片原图（evidenceId 即文件名）；落盘失败 / 配额超限只降级不阻塞 */
async function prepareUploadAssets(
  tripId: string,
  images: SubmitGuideImageInput[],
): Promise<PreparedImageAsset[]> {
  const assets: PreparedImageAsset[] = [];
  for (const [position, image] of images.entries()) {
    const evidenceId = `ev_shot_${generateId(`ev_shot:${tripId}:${position}`).slice(0, 8)}`;
    const kind = detectImageKind(image.data);
    // 按字节实际类型决定扩展名（png → .png，其余统一 .jpg；识别阶段再按字节分类）
    const persistInput: OcrScreenshotInput = {
      data: image.data,
      filename: image.filename !== "" ? image.filename : `image-${position + 1}`,
      mimeType: kind === "png" ? "image/png" : "image/jpeg",
      sizeBytes: image.data.length,
    };
    const asset = await persistTripAsset(tripId, evidenceId, persistInput);
    assets.push({
      index: position + 1,
      evidenceId,
      data: image.data,
      filename: persistInput.filename,
      sizeBytes: image.data.length,
      asset,
    });
  }
  return assets;
}

/** 命中已有来源：复用缓存不重抓；failed 视为重新导入（重跑）；inactive 恢复 active */
async function handleDuplicateSource(
  trip: Trip,
  existing: GuideSource,
  input: SubmitGuideSourceInput,
  identity: { sourceUrl?: string | null; canonicalUrl?: string | null; contentHash?: string | null },
): Promise<SubmitGuideSourceResult & { plan: SourceJobPlan | null }> {
  const rerun = existing.status === "failed";
  // 已移除来源重新提交：恢复 active（成果仍在，不重抓）
  if (existing.active === false) {
    existing.active = true;
    delete existing.removedAt;
    existing.updatedAt = nowIso();
  }

  if (!rerun) {
    // ready / partial / processing：直接返回当前状态，不重抓、不重计数。
    // 任务 186：历史文字来源缺 sourceText 时顺手补齐——仅当本次提交与存量来源
    // contentHash 一致（同一篇文本）才回填，URL 命中但正文不同的不冒充原文
    if (
      existing.inputKind === "text" &&
      (existing.sourceText === undefined || existing.sourceText.trim() === "") &&
      typeof input.text === "string" &&
      input.text !== "" &&
      typeof existing.contentHash === "string" &&
      existing.contentHash !== "" &&
      typeof identity.contentHash === "string" &&
      identity.contentHash.toLowerCase() === existing.contentHash.toLowerCase()
    ) {
      existing.sourceText = input.text;
    }
    await tripStore.save(trip);
    return { sourceId: existing.sourceId, status: existing.status, duplicate: true, source: existing, plan: null };
  }

  // failed 来源无成果可复用：重新导入（sourceVersion+1、清失败标记、回 processing）
  existing.sourceVersion += 1;
  existing.status = "processing";
  delete existing.failureCode;
  delete existing.failureMessage;
  existing.updatedAt = nowIso();

  let plan: SourceJobPlan;
  if (input.inputKind === "link") {
    // imageProgress 由抓取成功后的 commitNoteMeta 重建
    plan = { kind: "link", url: input.url!.trim() };
  } else if (input.inputKind === "text") {
    plan = { kind: "text", text: input.text!, sourceUrl: typeof input.sourceUrl === "string" && input.sourceUrl.trim() !== "" ? input.sourceUrl.trim() : null };
    // 任务 186：重新导入时同步刷新持久化原文（与本次抽取正文一致）
    existing.sourceText = input.text!;
  } else {
    existing.imageProgress = buildPendingImageProgress(input.images!.length);
    const assets = await prepareUploadAssets(trip.tripId, input.images!);
    for (const asset of assets) {
      const entry = existing.imageProgress.images[asset.index - 1];
      if (entry !== undefined) entry.assetPath = asset.asset.assetPath;
    }
    // Task #215：图片不自动 OCR（job 内直接延迟结算），plan 不再携带字节引用
    plan = { kind: "images" };
  }
  await tripStore.save(trip);
  return { sourceId: existing.sourceId, status: existing.status, duplicate: true, source: existing, plan };
}

// ===== 后台流水线 =====

type SourceJobPlan =
  | { kind: "link"; url: string }
  | { kind: "text"; text: string; sourceUrl: string | null }
  | { kind: "images" }
  | { kind: "retryImages" };

/** fire-and-forget 调度：注册活跃 job（先于任何 await，防读取端误判过期）再异步执行 */
function scheduleSourceJob(tripId: string, sourceId: string, plan: SourceJobPlan): void {
  registerGuideJob(tripId, sourceId);
  void processSourceJob(tripId, sourceId, plan)
    .catch((error: unknown) => {
      console.error(`[GUIDES] 来源任务异常逃逸（${tripId}/${sourceId}）:`, error);
    })
    .finally(() => {
      unregisterGuideJob(tripId, sourceId);
    });
}

async function processSourceJob(tripId: string, sourceId: string, plan: SourceJobPlan): Promise<void> {
  try {
    if (plan.kind === "link") {
      await processLinkSource(tripId, sourceId, plan.url);
    } else if (plan.kind === "text") {
      await processTextSource(tripId, sourceId, plan);
    } else if (plan.kind === "images") {
      await processImagesSource(tripId, sourceId);
    } else {
      await processRetryImages(tripId, sourceId);
    }
  } catch (error) {
    console.error(`[GUIDES] 来源任务失败（${tripId}/${sourceId}）:`, error);
    // 兜底结算：已有成功证据则保留为 partial，否则 failed；绝不永久卡在 processing
    await finalizeSourceSafe(tripId, sourceId, error);
  }
}

/** 链接来源：抓取（立即保存元信息与正文进度）→ 正文抽取 → Task #215 图片延迟结算 */
async function processLinkSource(tripId: string, sourceId: string, rawUrl: string): Promise<void> {
  let note: XhsNoteResult;
  try {
    note = await deps.fetchNote(rawUrl);
  } catch (error) {
    const failure = classifyLinkFailure(error);
    await finalizeSource(tripId, sourceId, { forceFailure: failure });
    return;
  }

  // 抓取成功：先把标题 / 规范化链接 / contentHash / 图片列表进度落盘（不等抽取与图片）
  await commitNoteMeta(tripId, sourceId, note, rawUrl);

  // 正文抽取（锁外网络调用；失败不阻塞图片队列）
  let noteExtractFailed: string | null = null;
  if (typeof note.text === "string" && note.text.trim() !== "") {
    try {
      const entries = await deps.extractEntries(note.text);
      const committed = await commitAssembledNote(tripId, sourceId, entries, note.sourceUrl ?? rawUrl);
      if (!committed) {
        noteExtractFailed = "正文证据未能写入行程（并发冲突），可重试";
      } else if (hasLocalFallbackEntries(entries)) {
        // Task #181：百炼解析失败后的本地降级结果——条目可用但非完整 AI 解析，
        // 结算落 partial（证据保留，与正文抽取失败同一结算通道）
        noteExtractFailed = "AI 解析失败，正文已按本地结构化解析降级（原文证据已保留），可重试";
      }
    } catch (error) {
      noteExtractFailed = error instanceof AiError ? error.message : condenseErrorDetail(error, 160);
      console.warn(`[GUIDES] 链接来源正文抽取失败（不阻塞图片）: ${noteExtractFailed}`);
    }
  }

  // 槽位仅用于判定是否有可下载图（槽位 index 即 1-based 原始页码，与 imageList
  // 一一对应；下载失败槽位已在 commitNoteMeta 占位，assetPath 已写入进度明细）。
  // Task #215：图片默认不启动 OCR——有可下载图即标记延迟并直接结算，
  // 全部图保持 pending 待解析；用户点「解析图片」后经 triggerImageOcr 启动队列
  const slots = Array.isArray(note.imageSlots)
    ? note.imageSlots
    : (Array.isArray(note.images) ? note.images : []).map((apiPath, position): XhsImageSlot => ({
        index: position + 1,
        path: apiPath,
      }));
  const downloadableSlots = slots.filter((slot) => slot.path !== null);
  if (downloadableSlots.length > 0) {
    await finalizeSource(tripId, sourceId, { noteExtractFailed, deferImageOcr: true });
    return;
  }

  await finalizeSource(tripId, sourceId, { noteExtractFailed });
}

/** 文字来源：正文抽取 → 结算（无图片参与） */
async function processTextSource(
  tripId: string,
  sourceId: string,
  plan: { text: string; sourceUrl: string | null },
): Promise<void> {
  let noteExtractFailed: string | null = null;
  try {
    // Task #313：P1b 分段计时（抽取段 / 装配写盘段）——性能门禁取证用，仅日志零行为变化
    const extractStartedAt = Date.now();
    const entries = await deps.extractEntries(plan.text);
    const extractMs = Date.now() - extractStartedAt;
    const assembleStartedAt = Date.now();
    const committed = await commitAssembledNote(tripId, sourceId, entries, plan.sourceUrl);
    console.log(
      `[GUIDES] 文字来源分段耗时（Task #313）：抽取 ${extractMs}ms ＋ 装配写盘 ${Date.now() - assembleStartedAt}ms` +
        `（entries=${entries.length}，committed=${committed}）`,
    );
    if (!committed) {
      noteExtractFailed = "正文证据未能写入行程（并发冲突），可重试";
    } else if (hasLocalFallbackEntries(entries)) {
      // Task #181：百炼解析失败后的本地降级结果——条目可用但非完整 AI 解析，
      // 结算落 partial（证据保留，与正文抽取失败同一结算通道）
      noteExtractFailed = "AI 解析失败，正文已按本地结构化解析降级（原文证据已保留），可重试";
    }
  } catch (error) {
    noteExtractFailed = error instanceof AiError ? error.message : condenseErrorDetail(error, 160);
    console.warn(`[GUIDES] 文字来源正文抽取失败: ${noteExtractFailed}`);
  }
  await finalizeSource(tripId, sourceId, { noteExtractFailed });
}

/**
 * 图片来源（Task #215：图片默认不启动 OCR）：原图已在提交时落盘（进度明细带
 * assetPath），标记延迟直接结算——全部图保持 pending 待解析，等用户在来源
 * 卡片点「解析图片」经 triggerImageOcr 启动队列。
 */
async function processImagesSource(tripId: string, sourceId: string): Promise<void> {
  await finalizeSource(tripId, sourceId, { deferImageOcr: true });
}

/**
 * 重试剩余图片：只跑 pending（failed / 预筛跳过后被重置）且原图可定位的图，
 * 不重复已完成项；明确的重试指令不再预筛（Task #175：预筛只发生在首轮）。
 */
async function processRetryImages(tripId: string, sourceId: string): Promise<void> {
  const inputs = await collectPendingImageInputs(tripId, sourceId);
  if (inputs.length === 0) {
    // 没有可执行的图（原图均不可定位）：直接按当前进度结算
    await finalizeSource(tripId, sourceId, {});
    return;
  }
  const queued = await runQueueAndAwait(tripId, sourceId, inputs);
  const timedOutInputs = inputs.filter((input) => queued.outcome.timedOutIndexes.includes(input.index));
  await finalizeSource(tripId, sourceId, { timedOutInputs, budgetMs: queued.budgetMs });
}

/** 队列运行 + 动态预算：预算按实际送模型图片数伸缩（Task #175），返回预算供结算文案引用 */
async function runQueueAndAwait(
  tripId: string,
  sourceId: string,
  inputs: ImageJobInput[],
): Promise<{ outcome: GuideImageQueueOutcome; budgetMs: number }> {
  const budgetMs = guideSourceBudgetMs(inputs.length);
  const tasks: GuideImageTask[] = inputs.map((input) => ({
    index: input.index,
    run: (run) => processOneImage(tripId, sourceId, input, run),
  }));
  // 带来源级运行令牌：预算耗尽 / 新一轮重试接管后，迟到识别结果不再写盘
  const outcome = await runGuideImageQueueForSource(tripId, sourceId, tasks, {
    concurrency: GUIDE_IMAGE_CONCURRENCY,
    budgetMs,
    perTaskTimeoutMs: GUIDE_IMAGE_TIMEOUT_MS,
  });
  return { outcome, budgetMs };
}

// ===== 图片预筛阶段（Task #175，目标一） =====

/**
 * 预筛候选构造：读原图字节（任务持有的优先，否则从受控路径读盘）；
 * 读不到字节的图保守保留（不入预筛，直接进队列按既有流程记失败）。
 */
async function collectPrefilterItems(
  inputs: readonly ImageJobInput[],
): Promise<Array<{ input: ImageJobInput; item: PrefilterImageInput }>> {
  const pairs: Array<{ input: ImageJobInput; item: PrefilterImageInput }> = [];
  for (const input of inputs) {
    const data = input.data ?? (input.assetPath !== null ? await readAssetBytes(input.assetPath) : null);
    if (data === null || data.length === 0) continue;
    const kind = detectImageKind(data);
    pairs.push({
      input,
      item: {
        data,
        filename: input.filename,
        mimeType: kind === "png" ? "image/png" : "image/jpeg",
        sizeBytes: data.length,
      },
    });
  }
  return pairs;
}

/**
 * 预筛 + 队列 + 结算的公共流程（link / images 来源共用；重试不预筛）：
 * 1. 预筛（本地硬筛 + 整批一次分类；运行令牌窗口内——预筛属于本轮图片任务，
 *    期间重试被 SOURCE_BUSY 挡住，接管清理兜底）；
 * 2. 跳过图写盘（空证据保留原图回看 + entry.status="skipped" + 可解释原因）；
 *    写盘未成功的图保守并入队列（宁多识别，不可静默丢失）；
 * 3. 保留图队列识别（动态预算）→ 结算。
 */
async function runPrefilteredQueue(
  tripId: string,
  sourceId: string,
  inputs: ImageJobInput[],
  finalizeOptions: { noteExtractFailed?: string | null } = {},
): Promise<void> {
  const pairs = await collectPrefilterItems(inputs);
  let decisions = new Map<number, PrefilterSkipDecision>();
  if (pairs.length > 0) {
    decisions = await withSourceImageRun(tripId, sourceId, () =>
      deps.prefilterBatch(pairs.map((pair) => pair.item)),
    );
  }
  // 预筛输入序号 → 原始页码（决策 Map 按输入序号返回）
  const decisionByIndex = new Map<number, PrefilterSkipDecision>();
  for (const [position, decision] of decisions) {
    const pair = pairs[position];
    if (pair !== undefined) decisionByIndex.set(pair.input.index, decision);
  }

  const skippedInputs = inputs.filter((input) => decisionByIndex.has(input.index));
  const stillKept = inputs.filter((input) => !decisionByIndex.has(input.index));
  if (skippedInputs.length > 0) {
    const unresolved = await commitSkippedImages(tripId, sourceId, skippedInputs, decisionByIndex);
    stillKept.push(...unresolved);
  }

  let timedOutInputs: ImageJobInput[] = [];
  let budgetMs = guideSourceBudgetMs(Math.max(1, stillKept.length));
  if (stillKept.length > 0) {
    const queued = await runQueueAndAwait(tripId, sourceId, stillKept);
    timedOutInputs = stillKept.filter((input) => queued.outcome.timedOutIndexes.includes(input.index));
    budgetMs = queued.budgetMs;
  }
  await finalizeSource(tripId, sourceId, { ...finalizeOptions, timedOutInputs, budgetMs });
}

/**
 * 预筛跳过图逐张写盘：返回未成功落盘的输入（调用方并入队列保守识别）。
 * 跳过只影响是否送模型：空证据保留 assetPath 原图回看，entry.status="skipped"
 * + failureMessage 承载可解释原因（不计入 completed / failed，可按需重试）。
 */
async function commitSkippedImages(
  tripId: string,
  sourceId: string,
  skippedInputs: readonly ImageJobInput[],
  decisionByIndex: ReadonlyMap<number, PrefilterSkipDecision>,
): Promise<ImageJobInput[]> {
  const unresolved: ImageJobInput[] = [];
  for (const input of skippedInputs) {
    const decision = decisionByIndex.get(input.index);
    if (decision === undefined) {
      unresolved.push(input);
      continue;
    }
    const committed = await commitSkippedEvidence(tripId, sourceId, input, decision);
    if (!committed) {
      console.warn(`[GUIDES] 图片 ${input.index} 预筛跳过写盘未成功（并发冲突 / 来源已终态），转入队列保守识别`);
      unresolved.push(input);
    }
  }
  return unresolved;
}

/** 单张跳过图写盘（乐观提交；无装配——mentions 为空，纯证据与进度字段更新） */
async function commitSkippedEvidence(
  tripId: string,
  sourceId: string,
  input: ImageJobInput,
  decision: PrefilterSkipDecision,
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt++) {
    const trip = await loadTripOrThrow(tripId);
    const source = trip.guideSources?.[sourceId];
    if (source === undefined || source.status !== "processing") return false;
    const entry = source.imageProgress.images.find((candidate) => candidate.index === input.index);
    if (entry === undefined) return false;

    const evidenceId = allocateImageEvidenceId(trip, input.evidenceIdBase);
    const contentHash8 = createHash("sha256")
      .update(`${input.evidenceIdBase}:${evidenceId}:prefilter`)
      .digest("hex")
      .slice(0, 8);
    trip.evidences[evidenceId] = {
      evidenceId,
      kind: "screenshot",
      noteIndex: null,
      assetRef: `来源图片 ${input.index} · ${input.filename} · #${contentHash8}`,
      sourceUrl: input.sourceUrl,
      ocrText: null,
      mentions: [],
      assetPath: input.assetPath,
      assetMimeType: null,
      assetSizeBytes: null,
      assetHash: null,
    };
    if (!source.evidenceRefs.includes(evidenceId)) source.evidenceRefs.push(evidenceId);
    entry.evidenceId = evidenceId;
    entry.status = "skipped";
    delete entry.failureCode;
    entry.failureMessage = decision.reason;
    recountImageProgress(source.imageProgress);
    source.sourceVersion += 1;
    source.updatedAt = nowIso();

    if (await commitTripIfVersionUnchanged(trip)) {
      console.log(`[GUIDES] 图片 ${input.index} 预筛跳过（${decision.stage}）写盘：${decision.reason}`);
      return true;
    }
    await delay(3 + Math.floor(Math.random() * 17));
  }
  return false;
}

// ===== 单图处理 =====

/** 单图任务输入：原图字节优先（提交时持有），否则从受控 assetPath 读盘 */
interface ImageJobInput {
  index: number;
  /** 证据 ID 基名（同 ID 的空证据会被原位升级，历史证据不覆盖） */
  evidenceIdBase: string;
  data: Uint8Array | null;
  assetPath: string | null;
  assetHash: string | null;
  assetMimeType: string | null;
  filename: string;
  sourceUrl: string | null;
}

/** 受控 assetPath 白名单：xhs 笔记图目录 / 行程截图（与两套受控路由口径一致） */
const SAFE_ASSET_PATH_PATTERN =
  /^uploads\/(?:xhs_[0-9a-zA-Z]{1,32}\/\d{1,2}\.(?:jpg|jpeg|png|webp|gif)|[0-9a-fA-F-]{36}\/ev_shot_[0-9a-f]{8}\.(?:jpg|png))$/;

/** 从受控相对路径读原图字节；路径不合规 / 文件缺失返回 null（绝不抛错） */
async function readAssetBytes(assetPath: string): Promise<Uint8Array | null> {
  if (!SAFE_ASSET_PATH_PATTERN.test(assetPath)) return null;
  const filePath = path.join(UPLOADS_DIR, assetPath.slice("uploads/".length));
  if (!path.resolve(filePath).startsWith(path.resolve(UPLOADS_DIR) + path.sep)) return null;
  try {
    return new Uint8Array(await fs.readFile(filePath));
  } catch {
    return null;
  }
}

/** 受控相对路径是否在盘上（只探测存在性，不读内容；Task #222 原图定位兜底用） */
async function assetFileExists(assetPath: string): Promise<boolean> {
  if (!SAFE_ASSET_PATH_PATTERN.test(assetPath)) return false;
  const filePath = path.join(UPLOADS_DIR, assetPath.slice("uploads/".length));
  if (!path.resolve(filePath).startsWith(path.resolve(UPLOADS_DIR) + path.sep)) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** 小红书落盘约定的图片扩展名（与 xhs.ts imageExtension 的产出集合一致） */
const XHS_ASSET_EXTENSIONS = ["jpg", "png", "webp", "gif", "jpeg"] as const;

/**
 * Task #222 原图定位兜底：链接来源按小红书落盘约定（uploads/xhs_{noteId}/{页码}.{ext}）
 * 探测原图。存量残留的 pending 图可能既无证据也无进度 assetPath（Task #215 之前的
 * 落盘形态，如 4/5 完成后第 1 张卡在 pending 的存量来源），但文件实际仍在盘上；
 * 探测命中返回受控相对路径，否则 null。非链接来源不适用。
 */
async function probeXhsAssetPath(source: GuideSource, index: number): Promise<string | null> {
  if (source.inputKind !== "link") return null;
  const urls = [source.canonicalUrl, source.sourceUrl].filter(
    (value): value is string => typeof value === "string" && value !== "",
  );
  for (const url of urls) {
    const noteId = extractXhsNoteId(url);
    if (noteId === null) continue;
    for (const ext of XHS_ASSET_EXTENSIONS) {
      const candidate = `uploads/xhs_${noteId}/${index}.${ext}`;
      if (await assetFileExists(candidate)) return candidate;
    }
  }
  return null;
}

/** 重试场景：收集 pending 状态图的任务输入（字节来源 = 失败证据的受控 assetPath） */
async function collectPendingImageInputs(tripId: string, sourceId: string): Promise<ImageJobInput[]> {
  const trip = await tripStore.load(tripId);
  if (trip === null) return [];
  const source = trip.guideSources?.[sourceId];
  if (source === undefined || source.status !== "processing") return [];
  const inputs: ImageJobInput[] = [];
  for (const entry of source.imageProgress.images) {
    if (entry.status !== "pending") continue;
    const evidenceId = entry.evidenceId;
    const evidence = evidenceId !== null ? trip.evidences[evidenceId] : undefined;
    // Task #215：延迟解析的 pending 图尚无证据，回退进度明细的受控 assetPath；
    // Task #222：两者皆缺时链接来源按小红书落盘约定探测原图（存量残留 pending
    // 图由此重新定位，不再永久卡死）
    const assetPath =
      evidence?.assetPath ?? entry.assetPath ?? (await probeXhsAssetPath(source, entry.index));
    if (assetPath === null) {
      console.warn(`[GUIDES] 重试图 ${entry.index} 无受控原图路径，跳过`);
      continue;
    }
    inputs.push({
      index: entry.index,
      evidenceIdBase: evidenceId ?? `ev_retry_${generateId(`ev_retry:${tripId}:${sourceId}:${entry.index}`).slice(0, 8)}`,
      data: null,
      assetPath,
      assetHash: evidence?.assetHash ?? null,
      assetMimeType: evidence?.assetMimeType ?? null,
      filename: assetPath.split("/").pop() ?? `image-${entry.index}`,
      sourceUrl: evidence?.sourceUrl ?? null,
    });
  }
  return inputs;
}

/** 识别异常 → 单图 failureCode（契约固定集合，未知兜底 unknown） */
function classifyImageFailure(error: unknown): { failureCode: GuideImageFailureCode; failureMessage: string } {
  const message = error instanceof AiError ? error.message : condenseErrorDetail(error, 160);
  if (error instanceof AiError) {
    switch (error.code) {
      case "IMAGE_REJECTED":
        return { failureCode: "rejected", failureMessage: "图片未通过 AI 平台审核" };
      case "OCR_TIMEOUT":
        return { failureCode: "timeout", failureMessage: message };
      case "AI_PARSE_FAILED":
        return { failureCode: "extract_failed", failureMessage: message };
      case "BAILIAN_REQUEST_FAILED":
        return { failureCode: "extract_failed", failureMessage: message };
      case "IMAGE_FORMAT_UNSUPPORTED":
        return { failureCode: "unsupported", failureMessage: message };
      default:
        return { failureCode: "unknown", failureMessage: message };
    }
  }
  return { failureCode: "unknown", failureMessage: message };
}

/** 链接抓取异常 → 来源级 GuideFailureCode（XhsError 文案语义映射） */
function classifyLinkFailure(error: unknown): { failureCode: GuideFailureCode; failureMessage: string } {
  const message = error instanceof XhsError ? error.message : condenseErrorDetail(error, 160);
  if (/登录|风控|拦截/.test(message)) return { failureCode: "blocked", failureMessage: message };
  if (/404|不存在|已删除/.test(message)) return { failureCode: "not_found", failureMessage: message };
  if (/超时/.test(message)) return { failureCode: "timeout", failureMessage: message };
  return { failureCode: "extract_failed", failureMessage: message };
}

/**
 * 单图任务：定位字节 → 格式检测（仅 JPEG/PNG 可识别）→ 识别 → 逐图写盘。
 * 任务永不 reject；识别失败也建「空证据」保留原图回看（assetPath），
 * entry.evidenceId 始终填充（重试据此定位原图，契约不禁止 failed 携带 evidenceId）。
 */
async function processOneImage(
  tripId: string,
  sourceId: string,
  input: ImageJobInput,
  run: GuideImageRunContext,
): Promise<GuideImageTaskResult> {
  let data = input.data;
  if (data === null && input.assetPath !== null) {
    data = await readAssetBytes(input.assetPath);
  }
  if (data === null || data.length === 0) {
    return commitImageEvidence(
      tripId,
      sourceId,
      input,
      {
        kind: "failure",
        failureCode: "unknown",
        failureMessage: "原图不可读（文件缺失或路径不合规），无法识别",
        assetSizeBytes: null,
        assetHash: input.assetHash,
      },
      run,
    );
  }

  const kind = detectImageKind(data);
  if (kind !== "jpeg" && kind !== "png") {
    return commitImageEvidence(
      tripId,
      sourceId,
      input,
      {
        kind: "failure",
        failureCode: "unsupported",
        failureMessage: `仅支持 JPEG / PNG 图片识别（检测到 ${kind === "unknown" ? "未知格式" : kind.toUpperCase()}），原图已保留`,
        assetSizeBytes: data.length,
        assetHash: input.assetHash ?? sha16(data),
      },
      run,
    );
  }

  try {
    const content = await deps.recognizeImage({
      data,
      filename: input.filename,
      mimeType: kind === "png" ? "image/png" : "image/jpeg",
      sizeBytes: data.length,
    });
    return await commitImageEvidence(
      tripId,
      sourceId,
      input,
      {
        kind: "success",
        content,
        assetSizeBytes: data.length,
        assetHash: input.assetHash ?? sha16(data),
        assetMimeType: kind === "png" ? "image/png" : "image/jpeg",
      },
      run,
    );
  } catch (error) {
    const failure = classifyImageFailure(error);
    return commitImageEvidence(
      tripId,
      sourceId,
      input,
      {
        kind: "failure",
        ...failure,
        assetSizeBytes: data.length,
        assetHash: input.assetHash ?? sha16(data),
        assetMimeType: kind === "png" ? "image/png" : "image/jpeg",
      },
      run,
    );
  }
}

/** commitImageEvidence 的处理结果描述 */
type ImageOutcomeInput =
  | {
      kind: "success";
      content: RecognizedImageContent;
      assetSizeBytes: number | null;
      assetHash: string | null;
      assetMimeType: string | null;
    }
  | {
      kind: "failure";
      failureCode: GuideImageFailureCode;
      failureMessage: string;
      assetSizeBytes: number | null;
      assetHash: string | null;
      assetMimeType?: string | null;
    };

/** 证据是否为「空证据」（无 OCR 文本且无提及）：重试成功时原位升级，不覆盖有内容的历史证据 */
function isEmptyEvidence(evidence: SourceEvidence): boolean {
  const ocrText = typeof evidence.ocrText === "string" ? evidence.ocrText.trim() : "";
  return ocrText === "" && evidence.mentions.length === 0;
}

/**
 * 单图结果写盘（乐观提交）：锁外装配 + 锁内「版本未变才保存」。
 * - 建证据（成功带 ocrText / mentions；失败为空证据保留 assetPath 回看）；
 * - 装配 suppressAttach：不自动改动已生成行程，只进候选池 / 待定区；
 * - 更新 imageProgress 明细与计数、evidenceRefs / mentionRefs、sourceVersion+1；
 * - 来源已离开 processing（结算 / 重试竞态）或本轮令牌失效（预算耗尽 / 被新一轮接管）：
 *   返回 skipped 丢弃结果，不写盘。
 */
async function commitImageEvidence(
  tripId: string,
  sourceId: string,
  input: ImageJobInput,
  outcome: ImageOutcomeInput,
  run: GuideImageRunContext,
): Promise<GuideImageTaskResult> {
  const searchCache = new Map<string, FlyAIPoi[]>();
  if (!run.isActive()) return skippedForRun(input.index);
  for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt++) {
    const trip = await loadTripOrThrow(tripId);
    // 令牌可能在识别期间失效（预算到期 / 用户重试接管），失效即丢弃
    if (!run.isActive()) return skippedForRun(input.index);
    const source = trip.guideSources?.[sourceId];
    if (source === undefined || source.status !== "processing") {
      // 已终态（预算结算 / 移除后的迟到结果）：丢弃，不写盘
      return { index: input.index, outcome: { kind: "skipped", reason: "来源已离开处理中状态，结果已丢弃" } };
    }

    const evidenceId = allocateImageEvidenceId(trip, input.evidenceIdBase);
    const kind = outcome.kind === "success" ? outcome.assetMimeType ?? "image/jpeg" : outcome.assetMimeType ?? null;
    const contentHash8 = createHash("sha256").update(`${input.evidenceIdBase}:${evidenceId}`).digest("hex").slice(0, 8);
    const evidence: SourceEvidence = {
      evidenceId,
      kind: "screenshot",
      noteIndex: null,
      assetRef: `来源图片 ${input.index} · ${input.filename} · #${contentHash8}`,
      sourceUrl: input.sourceUrl,
      ocrText: outcome.kind === "success" && outcome.content.ocrText !== "" ? outcome.content.ocrText : null,
      mentions: [],
      assetPath: input.assetPath,
      assetMimeType: kind,
      assetSizeBytes: outcome.assetSizeBytes,
      assetHash: outcome.assetHash,
    };

    const mentions: ParsedEntry[] = outcome.kind === "success" ? outcome.content.mentions : [];
    const errors: string[] = [];
    const assembled = await assembleEntries(trip, mentions, evidence, evidenceId, errors, searchCache, {
      useSuggestedVisitName: true,
      suppressAttach: true,
      logPrefix: "GUIDES",
    });

    trip.evidences[evidenceId] = evidence;
    if (!source.evidenceRefs.includes(evidenceId)) source.evidenceRefs.push(evidenceId);
    for (const mention of evidence.mentions) {
      source.mentionRefs.push(`${evidenceId}:${mention.mentionId}`);
    }

    const entry = source.imageProgress.images.find((candidate) => candidate.index === input.index);
    if (entry !== undefined) {
      entry.evidenceId = evidenceId;
      if (outcome.kind === "success") {
        entry.status = "ready";
        delete entry.failureCode;
        delete entry.failureMessage;
      } else {
        entry.status = "failed";
        entry.failureCode = outcome.failureCode;
        entry.failureMessage = outcome.failureMessage;
      }
      recountImageProgress(source.imageProgress);
    }
    source.sourceVersion += 1;
    source.updatedAt = nowIso();

    // 装配（FlyAI 搜索等）耗时较长：落盘前再校一次令牌，确定没被结算 / 重试赶超
    if (!run.isActive()) return skippedForRun(input.index);
    const committed = await commitTripIfVersionUnchanged(trip);
    if (committed) {
      const stopsSuffix = assembled.stops.length > 0 ? `，stops ${assembled.stops.length}` : "";
      console.log(
        `[GUIDES] 图片 ${input.index} 写盘（${
          outcome.kind === "success" ? `ready，mentions ${evidence.mentions.length}` : `failed：${outcome.failureCode}`
        }${stopsSuffix}）`,
      );
      return outcome.kind === "success"
        ? { index: input.index, outcome: { kind: "ready", evidenceId } }
        : {
            index: input.index,
            outcome: {
              kind: "failed",
              failureCode: outcome.failureCode,
              failureMessage: outcome.failureMessage,
            },
          };
    }
    // 并发冲突：丢弃本副本重新 load 重试（searchCache 已热，重复装配成本低）；
    // 加随机退避打破多个 worker 的同步重抢，否则固定并发下可能连续撞版
    await delay(3 + Math.floor(Math.random() * 17));
  }
  console.error(`[GUIDES] 图片 ${input.index} 乐观提交重试耗尽（${tripId}/${sourceId}）`);
  return {
    index: input.index,
    outcome: {
      kind: "failed",
      failureCode: "unknown",
      failureMessage: "写入行程时持续遇到并发修改，请重试",
    },
  };
}

/** 令牌失效（本轮队列已结束 / 被新一轮任务接管）时的丢弃结果 */
function skippedForRun(index: number): GuideImageTaskResult {
  return {
    index,
    outcome: { kind: "skipped", reason: "本轮图片任务已结束或已被新一轮接管，结果已丢弃" },
  };
}

/** 图片证据 ID 分配：基名可用则用（空证据原位升级），有内容则新 ID 不覆盖历史 */
function allocateImageEvidenceId(trip: Trip, baseId: string): string {
  const existing = trip.evidences[baseId];
  if (existing === undefined) return baseId;
  if (isEmptyEvidence(existing)) return baseId;
  // Task #284：冲突后缀经中央生成器（评测态种子派生，跨进程稳定）
  let attempt = 0;
  let candidate = `${baseId}_${generateId(`evimg:${baseId}:${attempt}`).slice(0, 6)}`;
  while (trip.evidences[candidate] !== undefined) {
    attempt += 1;
    candidate = `${baseId}_${generateId(`evimg:${baseId}:${attempt}`).slice(0, 6)}`;
  }
  return candidate;
}

/** 正文证据 ID 分配（ev_note_N，冲突加随机后缀，与 extract.ts 同模式） */
function allocateNoteEvidenceId(trip: Trip, noteIndex: number): string {
  const base = `ev_note_${noteIndex}`;
  if (trip.evidences[base] === undefined) return base;
  // Task #284：冲突后缀经中央生成器（评测态种子派生，跨进程稳定）
  let attempt = 0;
  let candidate = `ev_note_${noteIndex}_${generateId(`evnote:${base}:${attempt}`).slice(0, 8)}`;
  while (trip.evidences[candidate] !== undefined) {
    attempt += 1;
    candidate = `ev_note_${noteIndex}_${generateId(`evnote:${base}:${attempt}`).slice(0, 8)}`;
  }
  return candidate;
}

/**
 * 正文抽取结果写盘（乐观提交）：note_text 证据 + 装配 + evidenceRefs / mentionRefs
 * + sourceVersion+1。来源已终态返回 false（结果丢弃）。
 */
async function commitAssembledNote(
  tripId: string,
  sourceId: string,
  entries: ParsedEntry[],
  sourceUrl: string | null,
): Promise<boolean> {
  const searchCache = new Map<string, FlyAIPoi[]>();
  for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt++) {
    const trip = await loadTripOrThrow(tripId);
    const source = trip.guideSources?.[sourceId];
    if (source === undefined || source.status !== "processing") return false;

    const noteIndex = nextNoteIndex(trip);
    const evidenceId = allocateNoteEvidenceId(trip, noteIndex);
    const evidence: SourceEvidence = {
      evidenceId,
      kind: "note_text",
      noteIndex,
      assetRef: null,
      sourceUrl,
      ocrText: null,
      mentions: [],
    };
    const errors: string[] = [];
    await assembleEntries(trip, entries, evidence, evidenceId, errors, searchCache, {
      suppressAttach: true,
      logPrefix: "GUIDES",
    });

    trip.evidences[evidenceId] = evidence;
    if (!source.evidenceRefs.includes(evidenceId)) source.evidenceRefs.push(evidenceId);
    for (const mention of evidence.mentions) {
      source.mentionRefs.push(`${evidenceId}:${mention.mentionId}`);
    }
    source.sourceVersion += 1;
    source.updatedAt = nowIso();

    if (await commitTripIfVersionUnchanged(trip)) {
      console.log(
        `[GUIDES] 正文证据写盘：${evidenceId}（mentions ${evidence.mentions.length}）`,
      );
      return true;
    }
  }
  console.error(`[GUIDES] 正文证据乐观提交重试耗尽（${tripId}/${sourceId}）`);
  return false;
}

/**
 * 链接抓取成功后的元信息提交（锁内短临界区，纯字段更新）：
 * title / canonicalUrl（短链展开后的稳定链接）/ contentHash / 抓取正文 sourceText /
 * 图片进度初始化（同一篇笔记重抓时沿用已完成的图结果，Task #217）。
 * 来源已终态（竞态）时静默跳过。
 */
async function commitNoteMeta(
  tripId: string,
  sourceId: string,
  note: XhsNoteResult,
  rawUrl: string,
): Promise<void> {
  await withTripLock(tripId, async () => {
    const trip = await loadTripOrThrow(tripId);
    const source = trip.guideSources?.[sourceId];
    if (source === undefined || source.status !== "processing") return;
    const title = typeof note.title === "string" ? note.title.trim().slice(0, MAX_TITLE_CHARS) : "";
    if (title !== "" && !source.title) source.title = title;
    source.sourceUrl = rawUrl;
    source.canonicalUrl = normalizeCanonicalUrl(note.sourceUrl ?? rawUrl);
    const previousHash = typeof source.contentHash === "string" ? source.contentHash : null;
    const previousProgress = source.imageProgress;
    const noteText = typeof note.text === "string" && note.text.trim() !== "" ? note.text : null;
    if (noteText !== null) {
      source.contentHash = sha16(noteText);
      // Task #217：抓取到的正文与文字来源共用 sourceText 持久化——partial 来源补正文
      // 时可直接本地重抽，无需重新抓取小红书页面（原链接 xsec_token 时效 / WAF 拦截）
      source.sourceText = noteText;
    }
    // Task #175：按下载槽位构建进度——槽位 index 即 1-based 原始页码（与
    // imageList 一一对应），下载失败槽位以 failed / download_failed 占位
    // （不前移后续图片页码）
    const slots = Array.isArray(note.imageSlots)
      ? note.imageSlots
      : (Array.isArray(note.images) ? note.images : []).map((apiPath, position): XhsImageSlot => ({
          index: position + 1,
          path: apiPath,
        }));
    const failedSlots = new Map<number, string>();
    for (const slot of slots) {
      if (slot.path === null && typeof slot.error === "string" && slot.error !== "") {
        const page = slot.index;
        failedSlots.set(
          page,
          `图片下载失败：${slot.error}。原始页码 P${page} 已保留占位，未影响后续图片页码；可重新提交链接重试`,
        );
      }
    }
    const total = slots.length;
    const progress = buildSlotImageProgress(total, failedSlots);
    // Task #217：同一篇笔记重抓（补正文兜底重抓 / failed 重新导入）时沿用已完成的图
    // 结果——否则已识别的图被打回 pending，用户再点「解析图片」会重复识别并重复建
    // 截图证据（提及翻倍）。仅在「正文未变（contentHash 一致）+ 图数一致」时沿用；
    // 槽位本次下载失败（download_failed 无证据）一律以本次抓取为准，保留重下重试语义。
    const canReuseImages =
      previousHash !== null &&
      noteText !== null &&
      previousHash === sha16(noteText) &&
      previousProgress.total === total;
    let reusedImages = 0;
    if (canReuseImages) {
      for (const entry of progress.images) {
        if (entry.failureCode === "download_failed") continue;
        const previous = previousProgress.images.find((candidate) => candidate.index === entry.index);
        if (previous === undefined) continue;
        const reusable =
          previous.status === "ready" ||
          previous.status === "skipped" ||
          (previous.status === "failed" && previous.evidenceId !== null);
        if (!reusable) continue;
        entry.status = previous.status;
        entry.evidenceId = previous.evidenceId;
        if (previous.failureCode !== undefined) entry.failureCode = previous.failureCode;
        if (previous.failureMessage !== undefined) entry.failureMessage = previous.failureMessage;
        reusedImages += 1;
      }
      recountImageProgress(progress);
    }
    source.imageProgress = progress;
    // Task #215：可下载图已在抓取阶段落盘——assetPath 写入进度明细，延迟解析
    // （triggerImageOcr）与重试都能直接从进度定位原图，不依赖先建证据
    for (const slot of slots) {
      if (slot.path === null) continue;
      const entry = source.imageProgress.images.find((candidate) => candidate.index === slot.index);
      if (entry === undefined) continue;
      entry.assetPath = slot.path.startsWith("/api/") ? slot.path.slice("/api/".length) : slot.path;
    }
    source.updatedAt = nowIso();
    await tripStore.save(trip);
    console.log(
      `[GUIDES] 链接抓取元信息已保存（${sourceId}，图片 ${total} 张，沿用已完成 ${reusedImages} 张，` +
        `下载失败 ${failedSlots.size} 张页码占位）`,
    );
  });
}

// ===== 结算（状态机终态） =====

interface FinalizeOptions {
  /** 总预算耗尽未完成的图（结算时建空证据 + 标 timeout，保留重试入口） */
  timedOutInputs?: ImageJobInput[];
  /** 队列实际使用的动态预算（timeout 文案引用；缺省回落 GUIDE_SOURCE_BUDGET_MS，Task #175） */
  budgetMs?: number;
  /** 正文抽取失败说明（不阻塞图片；有其他可用内容时落 partial） */
  noteExtractFailed?: string | null;
  /** 来源级强制失败（链接抓取失败等）：已有可用证据时自动降级为 partial */
  forceFailure?: { failureCode: GuideFailureCode; failureMessage: string };
  /** Task #215：结算时标记图片 OCR 延迟——图片已落盘，pending 待解析不算未完成 */
  deferImageOcr?: boolean;
}

/** 图片覆盖文案：skipped（预筛跳过）单独计数展示，避免「12/17」被误读为缺图（Task #175） */
function imageCoverageText(progress: GuideImageProgress): string {
  const skippedCount = progress.images.filter((entry) => entry.status === "skipped").length;
  const base = `${progress.completed}/${progress.total}张图`;
  return skippedCount > 0 ? `${base}（${skippedCount}张预筛跳过）` : base;
}

/** 处理覆盖说明，如「正文 + 9/9张图」（只陈述处理范围，不做内容价值判断）；
 *  Task #215 延迟解析场景 pending 图是「待解析」，如「正文 + 10张图片待解析」 */
function buildCoverageText(trip: Trip, source: GuideSource): string {
  const hasNoteEvidence = source.evidenceRefs.some((evidenceId) => {
    const evidence = trip.evidences[evidenceId];
    return evidence?.kind === "note_text" && evidence.mentions.length > 0;
  });
  const progress = source.imageProgress;
  if (source.inputKind === "text") return "正文";

  // Task #215：延迟解析——待解析张数单独呈现（pending ≠ 未完成异常），
  // 下载失败图如实计数（可重试）；Task #217：无待解析图时回到常规覆盖文案
  // （重抓沿用已完成图后不应只显示「正文」而丢掉 N/N 张图）
  if (source.imageOcrDeferred === true) {
    const pendingCount = progress.images.filter((entry) => entry.status === "pending").length;
    if (pendingCount > 0) {
      const deferredParts: string[] = [];
      if (hasNoteEvidence) deferredParts.push("正文");
      deferredParts.push(`${pendingCount}张图片待解析`);
      if (progress.failed > 0) deferredParts.push(`${progress.failed}张图下载失败`);
      return deferredParts.join(" + ");
    }
  }

  if (source.inputKind === "images") return imageCoverageText(progress);
  const parts: string[] = [];
  if (hasNoteEvidence) parts.push("正文");
  if (progress.total > 0) parts.push(imageCoverageText(progress));
  return parts.length > 0 ? parts.join(" + ") : "链接";
}

/**
 * 终态结算（锁内）：
 * - timedOut 图建空证据并标 timeout 失败（保留原图回看与重试入口）；
 * - 无任何可用内容 → failed（forceFailure 优先取原因）；
 * - 有可用内容 + 图片全部成功且无正文失败 → ready；否则 partial；
 * - Task #215 延迟解析（imageOcrDeferred）：pending 图是「待解析」的确定等待
 *   状态——不算未完成、不算失败，也不触发无可用内容的 failed；正文可用即
 *   ready，覆盖文案由 buildCoverageText 输出「N张图片待解析」；
 * - processing 之外的来源不动（重试竞态 / 移除后照常保留状态）。
 */
async function finalizeSource(tripId: string, sourceId: string, options: FinalizeOptions): Promise<void> {
  await withTripLock(tripId, async () => {
    const trip = await tripStore.load(tripId);
    if (trip === null) return;
    const source = trip.guideSources?.[sourceId];
    if (source === undefined || source.status !== "processing") return;

    // Task #215：结算时打延迟解析标记（图片已落盘，pending 等待用户手动触发）
    if (options.deferImageOcr === true) source.imageOcrDeferred = true;

    // 总预算耗尽的图：建空证据（回看原图）+ entry 标 timeout
    for (const input of options.timedOutInputs ?? []) {
      const entry = source.imageProgress.images.find((candidate) => candidate.index === input.index);
      if (entry === undefined || entry.status === "ready") continue;
      const evidenceId = allocateImageEvidenceId(trip, input.evidenceIdBase);
      const contentHash8 = createHash("sha256")
        .update(`${input.evidenceIdBase}:${evidenceId}:timeout`)
        .digest("hex")
        .slice(0, 8);
      trip.evidences[evidenceId] = {
        evidenceId,
        kind: "screenshot",
        noteIndex: null,
        assetRef: `来源图片 ${input.index} · ${input.filename} · #${contentHash8}`,
        sourceUrl: input.sourceUrl,
        ocrText: null,
        mentions: [],
        assetPath: input.assetPath,
        assetMimeType: input.assetMimeType,
        assetSizeBytes: null,
        assetHash: input.assetHash,
      };
      if (!source.evidenceRefs.includes(evidenceId)) source.evidenceRefs.push(evidenceId);
      entry.status = "failed";
      entry.evidenceId = evidenceId;
      entry.failureCode = "timeout";
      entry.failureMessage = `来源图片处理超时（总预算 ${Math.round((options.budgetMs ?? GUIDE_SOURCE_BUDGET_MS) / 1000)} 秒已用尽），可重试剩余图片`;
    }
    // Task #222：非延迟来源结算时残留的 pending / processing 图（历史中断 / 预算外
    // 未启动 / 原图不可定位被重试队列跳过 / 令牌失效丢弃的迟到结果）统一收敛为
    // failed(timeout)——pending 既不计失败也不可重试，会让来源永远卡在 partial
    // 且重试报「没有可重试的失败项」。延迟解析（imageOcrDeferred）的 pending 是
    // 「待解析」等待态，保持不动。
    if (source.imageOcrDeferred !== true) {
      for (const entry of source.imageProgress.images) {
        if (entry.status !== "pending" && entry.status !== "processing") continue;
        entry.status = "failed";
        entry.failureCode = "timeout";
        entry.failureMessage = "图片处理未完成（中断残留），可重试";
      }
    }
    recountImageProgress(source.imageProgress);

    const usable = hasUsableGuideEvidence(trip, source);
    const progress = source.imageProgress;
    const noteFailed = typeof options.noteExtractFailed === "string" && options.noteExtractFailed !== "";
    // Task #215：延迟解析场景 pending 图是「待解析」的确定等待状态——不算
    // 未完成异常、不算失败，也不触发「无可用内容」的 failed（纯图来源待解析
    // 同样是正常待命，用户可随时点「解析图片」）
    const deferred = source.imageOcrDeferred === true;
    const deferredPendingCount = deferred
      ? progress.images.filter((entry) => entry.status === "pending").length
      : 0;
    // 全部图片拿到确定结果（ready / failed / skipped；延迟解析时 pending 同样
    // 视作确定等待）且零失败、正文无失败、无强制失败 → ready；skipped 是确定
    // 状态（预筛跳过，不算失败，Task #175）；纯文字来源（total=0）自动满足；
    // 异常残留未完成图 → partial 提示可重试
    const allImagesSettled = progress.images.every(
      (entry) =>
        entry.status === "ready" ||
        entry.status === "failed" ||
        entry.status === "skipped" ||
        (deferred && entry.status === "pending"),
    );

    if (!usable && deferredPendingCount === 0) {
      source.status = "failed";
      if (options.forceFailure) {
        source.failureCode = options.forceFailure.failureCode;
        source.failureMessage = options.forceFailure.failureMessage;
      } else {
        source.failureCode = "extract_failed";
        source.failureMessage =
          options.noteExtractFailed && options.noteExtractFailed !== ""
            ? options.noteExtractFailed
            : "未能取回任何可规划内容，请重新提交或重试";
      }
    } else if (allImagesSettled && progress.failed === 0 && !noteFailed && !options.forceFailure) {
      source.status = "ready";
      delete source.failureCode;
      delete source.failureMessage;
    } else {
      source.status = "partial";
      delete source.failureCode;
      source.failureMessage =
        progress.failed > 0
          ? `部分图片处理失败（${progress.failed}/${progress.total}），成功内容已保留，可重试剩余图片`
          : noteFailed
            ? "正文抽取失败，其余内容已保留，可重试"
            : options.forceFailure
              ? options.forceFailure.failureMessage
              : "部分内容处理未完成，成功部分已保留";
    }
    source.coverageText = buildCoverageText(trip, source);
    source.updatedAt = nowIso();
    await tripStore.save(trip);
    console.log(`[GUIDES] 来源结算：${sourceId} → ${source.status}（${source.coverageText}）`);
  });
}

/** 任务级异常兜底结算：保留已有成功证据为 partial，无成果则 failed；自身异常只记日志 */
async function finalizeSourceSafe(tripId: string, sourceId: string, error: unknown): Promise<void> {
  try {
    await finalizeSource(tripId, sourceId, {
      forceFailure: { failureCode: "extract_failed", failureMessage: condenseErrorDetail(error, 160) },
    });
  } catch (nested) {
    console.error(`[GUIDES] 兜底结算也失败（${tripId}/${sourceId}），来源将留在 processing 待重启恢复:`, nested);
  }
}

// ===== 乐观提交（锁外装配 + 锁内版本验证落盘） =====

/**
 * 锁内短临界区：版本未变才保存。
 * 装配（FlyAI 搜索等网络调用）发生在锁外的 trip 副本上；落盘前校验该副本
 * 的基线 version 仍是最新——期间有并发写入则放弃本次结果由调用方重试装配，
 * 杜绝「基于旧快照的整份覆盖」（tripStore.save 无乐观锁比对，后写胜出）。
 */
async function commitTripIfVersionUnchanged(trip: Trip): Promise<boolean> {
  return withTripLock(trip.tripId, async () => {
    const latest = await tripStore.load(trip.tripId);
    if (latest === null) return false;
    if (latest.version !== trip.version) return false;
    await tripStore.save(trip);
    return true;
  });
}

// ===== 读取 / 重启恢复 =====

/**
 * 读取前恢复扫描核心（调用方须已持有 tripId 锁）：识别重启遗留的 processing 来源
 * （无活跃 job 即视为过期），保留已成功证据转 partial（或无成果转 failed），
 * 未完成图标 timeout 并提示可重试。不发送任何百炼请求；返回恢复后的最新 Trip。
 * 导出供 B3 草案生成（guides/planner.ts）在自身锁内复用——promise 链锁不可重入，
 * 已持锁调用方若再走 recoverStaleProcessing 会同 tripId 嵌套死锁。
 */
export async function recoverStaleProcessingLocked(tripId: string): Promise<Trip | null> {
  let trip: Trip | null;
  try {
    trip = await tripStore.load(tripId);
  } catch {
    throw new AiError("TRIP_NOT_FOUND", "行程不存在或已被删除，请刷新页面后重试");
  }
  if (trip === null) return null;

  let changed = false;
  for (const source of Object.values(trip.guideSources ?? {})) {
    if (source.status !== "processing") continue;
    if (hasActiveGuideJob(tripId, source.sourceId)) continue;

    for (const entry of source.imageProgress.images) {
      if (entry.status === "pending" || entry.status === "processing") {
        entry.status = "failed";
        entry.failureCode = "timeout";
        entry.failureMessage = "服务重启导致处理中断，可重试剩余图片";
      }
    }
    recountImageProgress(source.imageProgress);
    if (hasUsableGuideEvidence(trip, source)) {
      source.status = "partial";
      source.failureMessage = "服务重启导致处理中断，成功内容已保留，可重试剩余图片";
    } else {
      source.status = "failed";
      source.failureCode = "extract_failed";
      source.failureMessage = "服务重启导致处理中断且无可用内容，可重新提交";
    }
    source.updatedAt = nowIso();
    changed = true;
    console.warn(`[GUIDES] 重启恢复：过期 processing 来源 ${source.sourceId} → ${source.status}`);
  }
  if (changed) await tripStore.save(trip);
  return trip;
}

/**
 * 读取前列表扫描（自带锁，B2 路由直接用）；返回恢复后的最新 Trip。
 * 已持有 tripId 锁的调用方（B3 planner）请用 recoverStaleProcessingLocked。
 */
export async function recoverStaleProcessing(tripId: string): Promise<Trip | null> {
  return withTripLock(tripId, () => recoverStaleProcessingLocked(tripId));
}

export interface ListGuideSourcesResult {
  sources: GuideSource[];
  tripVersion: number;
}

/** 获取来源列表（按导入时间稳定排序；读取前先做重启恢复扫描） */
export async function listGuideSources(tripId: string): Promise<ListGuideSourcesResult> {
  const trip = await recoverStaleProcessing(tripId);
  if (trip === null) {
    throw new AiError("TRIP_NOT_FOUND", "行程不存在或已被删除，请刷新页面后重试");
  }
  const sources = Object.values(trip.guideSources ?? {})
    .filter((source): source is GuideSource => source !== null && typeof source === "object")
    .sort((left, right) => {
      if (left.importedAt !== right.importedAt) return left.importedAt < right.importedAt ? -1 : 1;
      return left.sourceId < right.sourceId ? -1 : 1;
    });
  return { sources, tripVersion: trip.version };
}

/** 获取单个来源（含重启恢复扫描） */
export async function getGuideSource(tripId: string, sourceId: string): Promise<GuideSource> {
  const trip = await recoverStaleProcessing(tripId);
  if (trip === null) {
    throw new AiError("TRIP_NOT_FOUND", "行程不存在或已被删除，请刷新页面后重试");
  }
  const source = trip.guideSources?.[sourceId];
  if (source === undefined) {
    throw new AiError("SOURCE_NOT_FOUND", "攻略来源不存在或已被删除");
  }
  return source;
}

// ===== 重试 =====

/**
 * 正文证据缺失时构造重抽计划（Task #217）：
 * - 有持久化原文（链接抓取成功即写 sourceText / 文字来源提交原文）→ 文本重抽，
 *   零网络抓取，不受原链接 xsec_token 时效与小红书 WAF 影响；
 * - 历史链接来源无持久化原文 → 兜底按原链接重新抓取（失败由抓取错误分类兜底
 *   结算，已有证据保留为 partial）；
 * - 其他（历史文字 / 图片来源无原文）→ null，交由既有图片重试逻辑判定是否可重试。
 */
function buildNoteRetryPlan(source: GuideSource): SourceJobPlan | null {
  const persisted = typeof source.sourceText === "string" ? source.sourceText : "";
  if (persisted.trim() !== "") {
    return {
      kind: "text",
      text: persisted,
      sourceUrl: typeof source.sourceUrl === "string" && source.sourceUrl !== "" ? source.sourceUrl : null,
    };
  }
  if (source.inputKind !== "link") return null;
  const url = typeof source.sourceUrl === "string" && source.sourceUrl !== "" ? source.sourceUrl : null;
  return url === null ? null : { kind: "link", url };
}

/**
 * 重试（附录 B §5；Task #175 扩展预筛跳过图；Task #217 扩展正文补抽）：
 * - processing → 409 SOURCE_BUSY（正在处理，稍后再试）；
 * - text 来源 failed：任务 186 起已持久化完整原文（sourceText），可凭原文重新抽取；
 *   历史来源无 sourceText → 400 SOURCE_NOT_RETRYABLE（引导重新提交）；
 * - partial 正文证据缺失（从未创建 note_text 证据，Task #217）：优先补正文——有
 *   持久化原文（链接抓取时保存）直接文本重抽，历史链接来源无原文则重新抓取；
 *   正文证据已存在时才走下方图片重跑逻辑；
 * - partial 图片：只重置 failed 图为 pending（无 failed 但有 skipped 时改跑跳过图；
 *   Task #222 再兜一层：非延迟来源残留的 pending / processing 图也纳入重跑，
 *   避免存量中断图既不算失败也不可重试），重跑剩余图片（不重复已完成项）；
 *   明确的重试指令不再预筛；
 * - 无可重试项（无 failed / 无 skipped / 无残留未完成图 / 正文证据已齐备）/
 *   原图不可定位（含 Task #222 兜底探测仍找不到）→ 400 SOURCE_NOT_RETRYABLE；
 * - ready：仅当存在预筛跳过图（Task #175）时允许按需重试——只跑 skipped，
 *   不重复已完成项；无跳过图的 ready 仍拒绝；
 * - failed：link 重新抓取全流程（下载失败图随之重新下载）；images 重跑全部图；
 * - 状态回 processing 且 sourceVersion+1（旧草案快照自然过期）。
 */
export async function retryGuideSource(tripId: string, sourceId: string): Promise<GuideSource> {
  const scheduled = await withTripLock(tripId, async (): Promise<{ source: GuideSource; plan: SourceJobPlan | null }> => {
    const trip = await loadTripOrThrow(tripId);
    const source = trip.guideSources?.[sourceId];
    if (source === undefined) {
      throw new AiError("SOURCE_NOT_FOUND", "攻略来源不存在或已被删除");
    }
    if (source.status === "processing") {
      throw new AiError("SOURCE_BUSY", "该来源正在处理中，请稍后再试");
    }

    let plan: SourceJobPlan | null = null;
    if (source.status === "failed") {
      if (source.inputKind === "text") {
        // 任务 186：来源已持久化完整原文时可直接重新抽取；历史来源无原文仍拒绝
        const sourceText = typeof source.sourceText === "string" ? source.sourceText : "";
        if (sourceText.trim() === "") {
          throw new AiError("SOURCE_NOT_RETRYABLE", "文字来源未保存原文，无法重新抽取，请重新提交正文");
        }
        plan = {
          kind: "text",
          text: sourceText,
          sourceUrl: typeof source.sourceUrl === "string" && source.sourceUrl !== "" ? source.sourceUrl : null,
        };
      } else if (source.inputKind === "link") {
        const url = typeof source.sourceUrl === "string" && source.sourceUrl !== "" ? source.sourceUrl : null;
        if (url === null) {
          throw new AiError("SOURCE_NOT_RETRYABLE", "来源未保存原始链接，无法重新抓取，请重新提交");
        }
        plan = { kind: "link", url };
      } else {
        // Task #222：除证据外，进度明细带 assetPath 的图也可定位原图（残留收敛为
        // failed 且未建证据的图，凭提交时写入的 assetPath 仍可重跑）
        const retryable = source.imageProgress.images.filter(
          (entry) => entry.evidenceId !== null || (entry.assetPath ?? null) !== null,
        );
        if (retryable.length === 0) {
          throw new AiError("SOURCE_NOT_RETRYABLE", "没有可重试的图片（原图均不可定位），请重新提交");
        }
        for (const entry of retryable) {
          entry.status = "pending";
          delete entry.failureCode;
          delete entry.failureMessage;
        }
        recountImageProgress(source.imageProgress);
        plan = { kind: "retryImages" };
      }
    } else if (source.status === "partial") {
      // Task #217：正文证据缺失补偿——partial 来源若从未创建 note_text 证据（正文
      // 抽取超时 / 解析失败），旧逻辑只重跑 failed|skipped 图片，导致「正文里的打卡点
      // 全部丢失、只剩截图提及」永久不可修复（无失败图时甚至直接不可重试）。
      // 判定口径：只认「是否存在 note_text 证据」，不动已成功写入的正文证据。
      const hasNoteText = source.evidenceRefs.some((evidenceId) => {
        const evidence = trip.evidences[evidenceId];
        return evidence !== undefined && evidence.kind === "note_text";
      });
      const notePlan = hasNoteText ? null : buildNoteRetryPlan(source);
      if (notePlan !== null) {
        plan = notePlan;
      } else {
        const failedEntries = source.imageProgress.images.filter((entry) => entry.status === "failed");
        // 无失败图但存在预筛跳过图（如正文失败 partial）→ 重试跑跳过图（Task #175）
        const skippedEntries = source.imageProgress.images.filter((entry) => entry.status === "skipped");
        // Task #222：非延迟来源残留的 pending / processing 图（历史中断 / 结算前未
        // 收敛的存量数据）也纳入重试——此前既不算失败也不可重试，来源会永远卡在
        // partial 且重试报「没有可重试的失败项」；延迟来源的 pending 是「待解析」
        // 等待态，仍走「解析图片」入口（triggerImageOcr），不在此重试
        const stuckEntries =
          source.imageOcrDeferred === true
            ? []
            : source.imageProgress.images.filter(
                (entry) => entry.status === "pending" || entry.status === "processing",
              );
        const candidates =
          failedEntries.length > 0
            ? failedEntries
            : skippedEntries.length > 0
              ? skippedEntries
              : stuckEntries;
        if (candidates.length === 0) {
          throw new AiError("SOURCE_NOT_RETRYABLE", "该来源没有可重试的失败项");
        }
        // 原图可定位才可重试：证据（既有口径，failed / skipped 均建证据）→ 进度明细
        // assetPath → 链接来源按小红书落盘约定探测（Task #222：残留 pending 图
        // 两者皆缺但文件仍在盘上时可由此重新定位）
        const retryable: GuideImageProgressEntry[] = [];
        for (const entry of candidates) {
          if (entry.evidenceId !== null || (entry.assetPath ?? null) !== null) {
            retryable.push(entry);
            continue;
          }
          if ((await probeXhsAssetPath(source, entry.index)) !== null) retryable.push(entry);
        }
        if (retryable.length === 0) {
          throw new AiError(
            "SOURCE_NOT_RETRYABLE",
            candidates === failedEntries
              ? "失败图片的原图均不可定位，无法重试，请重新提交"
              : candidates === skippedEntries
                ? "跳过图片的原图不可定位，无法重试，请重新提交"
                : "未完成图片的原图均不可定位，无法重试，请重新提交",
          );
        }
        for (const entry of retryable) {
          entry.status = "pending";
          delete entry.failureCode;
          delete entry.failureMessage;
        }
        recountImageProgress(source.imageProgress);
        plan = { kind: "retryImages" };
      }
    } else if (source.status === "ready") {
      // Task #175：ready 且存在预筛跳过图 → 按需重试（只跑 skipped，不重复已完成项）
      const skippedEntries = source.imageProgress.images.filter((entry) => entry.status === "skipped");
      if (skippedEntries.length === 0) {
        throw new AiError("SOURCE_NOT_RETRYABLE", "该来源已处理完成，无需重试");
      }
      const retryable = skippedEntries.filter((entry) => entry.evidenceId !== null);
      if (retryable.length === 0) {
        throw new AiError("SOURCE_NOT_RETRYABLE", "跳过图片的原图不可定位，无法重试，请重新提交");
      }
      for (const entry of retryable) {
        entry.status = "pending";
        delete entry.failureCode;
        delete entry.failureMessage;
      }
      recountImageProgress(source.imageProgress);
      plan = { kind: "retryImages" };
    } else {
      throw new AiError("SOURCE_NOT_RETRYABLE", "该来源已处理完成，无需重试");
    }

    source.status = "processing";
    source.sourceVersion += 1;
    delete source.failureCode;
    delete source.failureMessage;
    source.updatedAt = nowIso();
    await tripStore.save(trip);
    return { source, plan };
  });

  if (scheduled.plan !== null) {
    scheduleSourceJob(tripId, sourceId, scheduled.plan);
  }
  return scheduled.source;
}

// ===== 手动触发图片解析（Task #215） =====

/**
 * 手动触发图片 OCR（Task #215）：图片默认不解析，此处一键启动全部待解析图。
 * - 仅 imageOcrDeferred=true 的来源可触发（其他一律拒绝）；
 * - processing 来源拒绝（SOURCE_BUSY）；
 * - 无待解析图（历史残留）→ 幂等解除延迟标记，状态与进度不动；
 * - 有待解析图 → 解除延迟标记、回 processing、sourceVersion+1（旧草案快照
 *   自然过期），复用 retryImages 计划启动队列（明确的一键解析指令不预筛，
 *   待解析图经进度明细 assetPath / 证据 assetPath 定位原图）；
 * - 结算仍由 processRetryImages 内的 finalizeSource 统一收口。
 */
export async function triggerImageOcr(tripId: string, sourceId: string): Promise<GuideSource> {
  const scheduled = await withTripLock(tripId, async (): Promise<{ source: GuideSource; run: boolean }> => {
    const trip = await loadTripOrThrow(tripId);
    const source = trip.guideSources?.[sourceId];
    if (source === undefined) {
      throw new AiError("SOURCE_NOT_FOUND", "攻略来源不存在或已被删除");
    }
    if (source.status === "processing") {
      throw new AiError("SOURCE_BUSY", "该来源正在处理中，请稍后再试");
    }
    if (source.imageOcrDeferred !== true) {
      throw new AiError("SOURCE_NOT_RETRYABLE", "该来源的图片没有待解析项");
    }
    const pendingCount = source.imageProgress.images.filter((entry) => entry.status === "pending").length;
    source.imageOcrDeferred = false;
    source.updatedAt = nowIso();
    if (pendingCount === 0) {
      // 没有待解析图（历史残留）：幂等解除延迟标记即可，状态与进度不动
      await tripStore.save(trip);
      return { source, run: false };
    }
    source.status = "processing";
    source.sourceVersion += 1;
    delete source.failureCode;
    delete source.failureMessage;
    await tripStore.save(trip);
    console.log(`[GUIDES] 手动触发图片解析：${sourceId}（${pendingCount} 张待解析）`);
    return { source, run: true };
  });

  if (scheduled.run) {
    scheduleSourceJob(tripId, sourceId, { kind: "retryImages" });
  }
  return scheduled.source;
}

// ===== 单图重试（Task #231） =====

/**
 * 单图重试（Task #231）：只重置指定 index 的失败/跳过图为 pending 并启动队列。
 * - processing 来源拒绝（SOURCE_BUSY）；
 * - 目标图必须处于 failed / skipped / pending 状态（ready 图不可重试）；
 * - 目标图的原图必须可定位（evidenceId / assetPath / 小红书落盘约定探测）；
 * - 重置目标图为 pending，来源回 processing、sourceVersion+1；
 * - 复用 retryImages 计划启动队列（collectPendingImageInputs 只收 pending 图，
 *   因此仅跑被重置的这一张，其余已成功的图不受影响）。
 */
export async function retryGuideImage(
  tripId: string,
  sourceId: string,
  imageIndex: number,
): Promise<GuideSource> {
  if (!Number.isInteger(imageIndex) || imageIndex < 1) {
    throw new AiError("INVALID_REQUEST", "图片序号必须是正整数");
  }

  const scheduled = await withTripLock(tripId, async (): Promise<{ source: GuideSource; run: boolean }> => {
    const trip = await loadTripOrThrow(tripId);
    const source = trip.guideSources?.[sourceId];
    if (source === undefined) {
      throw new AiError("SOURCE_NOT_FOUND", "攻略来源不存在或已被删除");
    }
    if (source.status === "processing") {
      throw new AiError("SOURCE_BUSY", "该来源正在处理中，请稍后再试");
    }

    const entry = source.imageProgress.images.find((img) => img.index === imageIndex);
    if (entry === undefined) {
      throw new AiError("INVALID_REQUEST", `图片 ${imageIndex} 不存在于该来源`);
    }
    if (entry.status === "ready") {
      throw new AiError("INVALID_REQUEST", `图片 ${imageIndex} 已解析成功，无需重试`);
    }
    if (entry.status === "processing") {
      throw new AiError("SOURCE_BUSY", `图片 ${imageIndex} 正在解析中，请稍后再试`);
    }

    // 原图可定位性校验
    const hasAsset =
      entry.evidenceId !== null ||
      (entry.assetPath ?? null) !== null ||
      (await probeXhsAssetPath(source, entry.index)) !== null;
    if (!hasAsset) {
      throw new AiError("SOURCE_NOT_RETRYABLE", `图片 ${imageIndex} 的原图不可定位，无法重试`);
    }

    // 重置目标图
    entry.status = "pending";
    delete entry.failureCode;
    delete entry.failureMessage;
    recountImageProgress(source.imageProgress);

    // 延迟来源首次单图重试：解除延迟标记
    if (source.imageOcrDeferred === true) {
      source.imageOcrDeferred = false;
    }

    source.status = "processing";
    source.sourceVersion += 1;
    delete source.failureCode;
    delete source.failureMessage;
    source.updatedAt = nowIso();
    await tripStore.save(trip);
    console.log(`[GUIDES] 单图重试：${sourceId} 图片 ${imageIndex}（来源回 processing）`);
    return { source, run: true };
  });

  if (scheduled.run) {
    scheduleSourceJob(tripId, sourceId, { kind: "retryImages" });
  }
  return scheduled.source;
}

// ===== 移除 / 恢复 =====

/**
 * 软移除来源：active=false + removedAt；不删除 evidence 原始数据（证据与原图保留
 * 供回看），planner / 重新排版经 isGuideSourceUsable 不再使用（active=false 即不可用）。
 * processing 来源也可移除：后台任务只补来源字段，不触碰 active。
 */
export async function removeGuideSource(tripId: string, sourceId: string): Promise<GuideSource> {
  return withTripLock(tripId, async () => {
    const trip = await loadTripOrThrow(tripId);
    const source = trip.guideSources?.[sourceId];
    if (source === undefined) {
      throw new AiError("SOURCE_NOT_FOUND", "攻略来源不存在或已被删除");
    }
    if (source.active) {
      source.active = false;
      source.removedAt = nowIso();
      source.updatedAt = nowIso();
      await tripStore.save(trip);
    }
    return source;
  });
}

/** 恢复已移除来源：active=true、清 removedAt；幂等（已激活直接返回） */
export async function restoreGuideSource(tripId: string, sourceId: string): Promise<GuideSource> {
  return withTripLock(tripId, async () => {
    const trip = await loadTripOrThrow(tripId);
    const source = trip.guideSources?.[sourceId];
    if (source === undefined) {
      throw new AiError("SOURCE_NOT_FOUND", "攻略来源不存在或已被删除");
    }
    if (!source.active) {
      source.active = true;
      delete source.removedAt;
      source.updatedAt = nowIso();
      await tripStore.save(trip);
    }
    return source;
  });
}

// ===== 攻略补充句 =====

export interface SaveDraftNoteResult {
  tripVersion: number;
}

/**
 * 保存攻略补充句（trip.guideDraftNote）：空串 / null 清除。
 * 不触碰 pendingGuideDraft（补充句变化由 checkPendingGuideDraftFreshness 的
 * note_changed 判定让旧草案自然过期，前端提示重新生成）。
 */
export async function saveGuideDraftNote(tripId: string, note: string | null): Promise<SaveDraftNoteResult> {
  if (typeof note === "string" && note.length > DRAFT_NOTE_MAX_CHARS) {
    throw new AiError("INVALID_REQUEST", `攻略补充句超过 ${DRAFT_NOTE_MAX_CHARS} 字上限`);
  }
  return withTripLock(tripId, async () => {
    const trip = await loadTripOrThrow(tripId);
    const normalized = typeof note === "string" ? note.trim() : "";
    if (normalized === "") {
      delete trip.guideDraftNote;
    } else {
      trip.guideDraftNote = normalized;
    }
    await tripStore.save(trip);
    return { tripVersion: trip.version };
  });
}
