/**
 * 任务 186：按来源解析「原文回看」内容（纯函数，统一添加面板原文入口消费）。
 *
 * 职责边界（与任务 124 的 resolveEntitySourceLinks 分工）：
 * - 本模块只服务来源列表的「原文」按钮：文字来源回看用户提交的完整原文，
 *   截图来源按上传顺序回看全部持久化原图——都不是结构化提炼结果；
 * - 外部原链（sourceUrl→canonicalUrl）保持任务 124 语义：链接来源的「原文」
 *   仍是外链 <a>；文字 / 截图来源的原文查看层内如附带来源链接仅作次要信息。
 *
 * 历史兼容（可选字段零迁移）：
 * - sourceText 缺失 / 空白 → text=null（不冒充原文）；
 * - imageProgress 明细的 assetPath 缺失（历史来源）→ 回退证据的 assetPath
 *   （trip.evidences[entry.evidenceId]）；两者都拿不到 → 该图不展示；
 * - 结果无任何内容时调用方隐藏入口，不得渲染无效按钮。
 */

import type { GuideSource, Trip } from "@goplay/shared";

/** 来源关联的一张持久化原图（index 为 1-based 上传 / 页码顺序） */
export interface SourceOriginalImage {
  readonly index: number;
  /** 服务端受控相对路径（web 端按 /api/${path} 读取） */
  readonly path: string;
}

/** 来源可回看的原文内容：文本与原图至少其一非空才有意义 */
export interface SourceOriginal {
  /** 用户提交的完整原文；无完整原文（历史来源）为 null */
  readonly text: string | null;
  /** 持久化原图，按上传顺序（index 升序） */
  readonly images: SourceOriginalImage[];
  /** 来源附带的外部链接（sourceUrl 优先，canonicalUrl 兜底）；缺失为 null */
  readonly externalUrl: string | null;
}

/** 非空 URL 才算外部链接；空白串按缺失处理（与 sourceLinks.ts 同口径） */
function nonEmptyUrl(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed !== "" ? trimmed : null;
}

/**
 * 解析来源的原文回看内容（只读，不抛错）：
 * - text：仅文字来源消费 sourceText；截图 / 链接来源无文本原文；
 * - images：按 imageProgress 明细 index 升序收集（明细已按序保存，仍显式排序
 *   防御乱序持久化）；assetPath 优先取明细自带（提交落盘时写入），
 *   缺失回退证据 assetPath（历史来源）；
 * - 链接来源的下载图也可被收集（通用能力），但入口展示由调用方按 inputKind 门控。
 */
export function resolveSourceOriginal(trip: Trip, source: GuideSource): SourceOriginal {
  const text =
    source.inputKind === "text" && typeof source.sourceText === "string" && source.sourceText.trim() !== ""
      ? source.sourceText
      : null;

  const entries = Array.isArray(source.imageProgress?.images) ? source.imageProgress.images : [];
  const ordered = [...entries].sort((left, right) => left.index - right.index);
  const images: SourceOriginalImage[] = [];
  for (const entry of ordered) {
    const fromEntry = typeof entry.assetPath === "string" ? entry.assetPath.trim() : "";
    const evidence = entry.evidenceId !== null ? trip.evidences?.[entry.evidenceId] : undefined;
    const fromEvidence = typeof evidence?.assetPath === "string" ? evidence.assetPath.trim() : "";
    const path = fromEntry !== "" ? fromEntry : fromEvidence;
    if (path === "") continue;
    images.push({ index: entry.index, path });
  }

  return {
    text,
    images,
    externalUrl: nonEmptyUrl(source.sourceUrl) ?? nonEmptyUrl(source.canonicalUrl),
  };
}

/** 是否有可回看内容（调用方据此决定渲染「原文」按钮还是降级 / 隐藏） */
export function hasSourceOriginalContent(original: SourceOriginal): boolean {
  return original.text !== null || original.images.length > 0;
}
