/**
 * Task #285：L1 抽取语料缓存（v1.4 语料前置：8 源→10 源，新增亚龙湾/西岛两条真实笔记）。
 *
 * 缓存语义（用例文档 v1.4 §0）：慢层 L1 抽取结果按 **contentHash＝sha256(笔记正文)** 缓存，
 * 抽取 prompt/代码不变则重复评测零等待、零 token；语料清单变更（v2 新增 S6）不改变
 * 既有缓存条目的键与内容——contentHash 由正文决定，与语料清单/资产版本无关。
 *
 * 落盘形态：eval/cache/extraction/{noteId}.json（正文全文 + 抽取产物 + 抓取元信息），
 * 读回时重算 sha256(text) 与缓存键比对，不符即视为失效（返回 null，由调用方决定重建）。
 *
 * 建缓存工具：eval/tools/build-corpus.ts（一次性真实抓取＋真实百炼抽取；西岛笔记
 * server/uploads 已有同 noteId 抓取产物时图片复用免重抓，正文仍真实抓取一次以固定 contentHash）。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ParsedEntry } from "../../server/src/ai/assemble.js";

const EVAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const EXTRACTION_CACHE_DIR = join(EVAL_ROOT, "cache/extraction");

/** 单篇笔记的抽取缓存条目（正文原样保存，供 contentHash 复算与 E9 漏抽定位回看） */
export interface ExtractionCacheNote {
  noteId: string;
  /** 语料清单里的来源全串（含 xsec_token；canonical 归一前的原始输入） */
  sourceUrl: string;
  title: string;
  text: string;
  /** sha256(text)——慢层缓存键（抽取 prompt/代码不变即有效） */
  contentHash: string;
  capturedAt: string;
  /** 抓取产物：server/uploads/xhs_{noteId}/ 下的图片数（西岛复用既有产物时同样记录） */
  imageCount: number;
  /** 图片是否复用了既有 uploads 产物（true＝本次未重新下载） */
  imagesReused: boolean;
  /** 真实抽取产物（extractNoteEntries 原样返回，normalizeParsedEntry 前的原始形态） */
  entries: ParsedEntry[];
  /** 抽取耗时（ms，慢层一次性成本记录） */
  extractMs: number;
}

export function noteContentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function extractionCachePath(noteId: string): string {
  return join(EXTRACTION_CACHE_DIR, `${noteId}.json`);
}

/** 读缓存并校验 contentHash；缺失/损坏/正文哈希不符一律返回 null（不猜测、不部分采信） */
export function loadExtractionCache(noteId: string): ExtractionCacheNote | null {
  const path = extractionCachePath(noteId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ExtractionCacheNote;
    if (typeof parsed.text !== "string" || !Array.isArray(parsed.entries)) return null;
    if (noteContentHash(parsed.text) !== parsed.contentHash) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveExtractionCache(note: ExtractionCacheNote): string {
  mkdirSync(EXTRACTION_CACHE_DIR, { recursive: true });
  const path = extractionCachePath(note.noteId);
  writeFileSync(path, `${JSON.stringify(note, null, 2)}\n`, "utf8");
  return path;
}
