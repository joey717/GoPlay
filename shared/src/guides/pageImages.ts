/**
 * 攻略正文页码配图纯函数（Task #196）——页码提取与「页码 → 原图路径」确定性解析。
 *
 * 边界（与 guides/index.ts 同约定）：不写 Trip、不依赖 fs / crypto、不触网，
 * 可被 web 与 server 以同一份源码消费。
 *
 * 契约（产品要求，服务端确定性校验为准、不信任模型输出）：
 * - 仅当正文明确写出 pN / PN / P N（可多个，如 "p2 p8 p9"）时提取 pageRefs，
 *   保持原始一基页码（正文中第 1 张图 = 页码 1）；
 * - mention 只能绑定同一 GuideSource 中「顺序确定且 assetPath 存在」的第 N 张图：
 *   绑定条件 = 槽位存在且 index 严格等于页码 + status=ready + evidenceId 属于本
 *   来源 evidenceRefs + assetPath（明细缺失回退证据字段）非空；
 * - 页码不得因下载失败、预筛跳过或缺图而前移——解析严格按 index 定位，绝不取
 *   「相邻」或「最接近」的图；缺失槽保持占位语义；
 * - 正文无页码 / 页码越界 / 来源顺序不可靠 / 证据跨来源时返回空，不猜测。
 */

import type { GuideSource, Trip } from "../types/index.js";
import { resolveMentionRef } from "./index.js";

/**
 * 页码上限：与 server 端 GUIDE_MAX_IMAGES（server/src/guides/jobs.ts，= 24）同值。
 * 纯函数库不反向依赖 server，防漂移由 server/src/guides/verify-task196.ts 断言两侧相等。
 */
export const GUIDE_PAGE_MAX_INDEX = 24;

/**
 * 页码引用形态：p6 / P6 / p 6（允许 p 后一个空白），数字 1-2 位；
 * lookbehind 排除紧邻英文字母（iPhone6 / op6 / map 6 不误匹配），允许紧跟
 * 数字（连写 p6p7 / p2p8p9 中后续页码同样有效）。
 */
const PAGE_REF_PATTERN = /(?<![a-zA-Z])[pP]\s?(\d{1,2})/g;

/**
 * 从原句提取明确页码引用：保序（按原文出现顺序）去重，仅保留 1..GUIDE_PAGE_MAX_INDEX
 * 的整数（超出按非页码处理，与图片上限同口径；越界不进入 pageRefs，绑定层同样拒绝）。
 * 非字符串 / 无命中返回空数组。
 */
export function extractPageRefs(text: string): number[] {
  if (typeof text !== "string" || text === "") return [];
  const seen = new Set<number>();
  const refs: number[] = [];
  for (const match of text.matchAll(PAGE_REF_PATTERN)) {
    const page = Number(match[1]);
    if (
      Number.isInteger(page) &&
      page >= 1 &&
      page <= GUIDE_PAGE_MAX_INDEX &&
      !seen.has(page)
    ) {
      seen.add(page);
      refs.push(page);
    }
  }
  return refs;
}

/**
 * 归一 mention.pageRefs（读取侧防御）：数组内 1..GUIDE_PAGE_MAX_INDEX 的整数才保留，
 * 保序去重；字段缺失（历史证据）/ 非数组 / 全部非法 = 无页码（空数组）。
 */
export function normalizeMentionPageRefs(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const refs: number[] = [];
  for (const raw of value) {
    const page = typeof raw === "number" ? raw : Number(raw);
    if (Number.isInteger(page) && page >= 1 && page <= GUIDE_PAGE_MAX_INDEX && !seen.has(page)) {
      seen.add(page);
      refs.push(page);
    }
  }
  return refs;
}

/**
 * 来源图片明细顺序是否可靠（任务 175 槽位契约）：明细长度等于 total 且 index
 * 严格为 1..total 升序唯一。不满足时「第 N 张」语义不可信，该来源全部不绑定。
 */
export function isGuideImageProgressOrderReliable(source: GuideSource): boolean {
  const progress = source?.imageProgress;
  if (progress === null || progress === undefined || typeof progress !== "object") return false;
  const images = Array.isArray(progress.images) ? progress.images : [];
  if (typeof progress.total !== "number" || images.length !== progress.total) return false;
  return images.every((entry, position) => entry?.index === position + 1);
}

/**
 * 解析来源中第 page 页的受控图片路径；任一条件不满足返回 null（不猜测相邻/最接近）：
 * - 页码必须是 1..GUIDE_PAGE_MAX_INDEX 的整数（越界拒绝）；
 * - 来源顺序必须可靠（防槽位被压缩 / 重排后页码错位）；
 * - 槽位必须存在（download_failed / skipped 占位槽保留原始页码，绝不前移）；
 * - 槽位 status 必须为 ready（失败 / 预筛跳过 / 处理中不绑定）；
 * - evidenceId 必须属于本来源 evidenceRefs（跨来源防护）；
 * - assetPath 优先取明细自带（任务 186 提交落盘即写入），缺失回退证据字段
 *   （历史来源），两者皆无 = 无绑定。
 */
export function resolvePageAssetPath(trip: Trip, source: GuideSource, page: number): string | null {
  if (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > GUIDE_PAGE_MAX_INDEX) {
    return null;
  }
  if (!isGuideImageProgressOrderReliable(source)) return null;
  const entry = source.imageProgress.images.find((candidate) => candidate?.index === page);
  if (entry === undefined) return null;
  if (entry.status !== "ready") return null;
  const evidenceId = entry.evidenceId;
  if (evidenceId === null || !Array.isArray(source.evidenceRefs) || !source.evidenceRefs.includes(evidenceId)) {
    return null;
  }
  const direct = typeof entry.assetPath === "string" && entry.assetPath.trim() !== "" ? entry.assetPath.trim() : null;
  if (direct !== null) return direct;
  const viaEvidence = trip.evidences?.[evidenceId]?.assetPath;
  return typeof viaEvidence === "string" && viaEvidence.trim() !== "" ? viaEvidence.trim() : null;
}

/** 一条 mention 的页码关联图解析结果 */
export interface MentionPageImages {
  /** 原始页码引用（无页码 / 引用失效 = 空数组） */
  readonly pageRefs: readonly number[];
  /** 有效绑定的受控图片路径（按页码顺序去重；无效页码静默跳过，绝不前移补位） */
  readonly assetPaths: readonly string[];
  /** 首张有效关联图（UI 展示用；无 = null） */
  readonly firstAssetPath: string | null;
}

const EMPTY_MENTION_PAGE_IMAGES: MentionPageImages = {
  pageRefs: [],
  assetPaths: [],
  firstAssetPath: null,
};

/**
 * 解析一条 mention（"evidenceId:mentionId"）的全部有效页码关联图：
 * - mention 不存在 / 无有效 pageRefs → 空（不绑定）；
 * - 所属 GuideSource 按证据反查唯一确定（严格限定同一来源，不允许跨来源拼图）；
 *   证据不属于任何来源（历史装配产物）→ 有页码但无绑定；
 * - 逐页 resolvePageAssetPath，保持页码顺序、按路径去重。
 */
export function resolveMentionPageImages(trip: Trip, ref: string): MentionPageImages {
  const resolved = resolveMentionRef(trip, ref);
  if (resolved === null) return EMPTY_MENTION_PAGE_IMAGES;
  const pageRefs = normalizeMentionPageRefs(resolved.mention.pageRefs);
  if (pageRefs.length === 0) return { pageRefs, assetPaths: [], firstAssetPath: null };
  const evidenceId = resolved.evidenceId;
  const source = Object.values(trip.guideSources ?? {}).find(
    (candidate) =>
      candidate !== null &&
      typeof candidate === "object" &&
      Array.isArray(candidate.evidenceRefs) &&
      candidate.evidenceRefs.includes(evidenceId),
  );
  if (source === undefined) {
    return { pageRefs, assetPaths: [], firstAssetPath: null };
  }
  const assetPaths: string[] = [];
  const seen = new Set<string>();
  for (const page of pageRefs) {
    const assetPath = resolvePageAssetPath(trip, source, page);
    if (assetPath !== null && !seen.has(assetPath)) {
      seen.add(assetPath);
      assetPaths.push(assetPath);
    }
  }
  return { pageRefs, assetPaths, firstAssetPath: assetPaths[0] ?? null };
}
