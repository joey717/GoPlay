/**
 * Task #285：v1.4 语料前置——亚龙湾＋西岛两条小红书笔记的一次性真实抓取＋抽取建缓存。
 *
 * 用法（仓库根目录）：
 *   npm run eval:corpus            # 处理语料清单全部笔记（已有有效缓存则跳过，幂等）
 *   npx tsx eval/tools/build-corpus.ts --force   # 强制重抓重抽（缓存内容变更时用）
 *
 * 流程（每篇）：
 *   1. 缓存命中（eval/cache/extraction/{noteId}.json 且 contentHash 复算一致）→ 跳过；
 *   2. 真实抓取 extractXhsNote（移动端 UA，与生产同链路）——西岛笔记 server/uploads
 *      已有同 noteId 抓取产物：图片按既有文件计数、产物同源 CDN 幂等覆盖不变，
 *      注明 imagesReused（免重抓口径）；
 *   3. 真实抽取 extractNoteEntries（百炼，与生产 deps.extractEntries 同实现）；
 *   4. 落缓存：正文全文 + contentHash=sha256(正文) + entries + 抓取元信息。
 *
 * 语料口径（PD 口头拍板 v1.4）：文档 8 源（5 真攻略＋3 合成边界源）→ 10 源；
 * 西岛 6ace31c6 与 fixture S4 为同一笔记（语料串＝历史成功抓取的分享全串，
 * 见 server/data 行程源快照），报告注明不重复计源。
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractNoteEntries } from "../../server/src/ai/extract.js";
import { extractXhsNote } from "../../server/src/ai/xhs.js";
import { UPLOADS_DIR } from "../../server/src/persistence/store.js";
// 加载根 .env（百炼四项 + FLYAI；抽取真调必需）
import "../../server/src/env.js";
import {
  loadExtractionCache,
  noteContentHash,
  saveExtractionCache,
  type ExtractionCacheNote,
} from "../harness/extractionCache.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Task #374 安全口径：清单内真实 xsec_token 已打码（参赛公开仓库对真实串零容忍）；离线抽取缓存键如失配需 live 重抓。
/** v1.4 语料前置清单（fixture v2 的 S6 与 S4 分享全串；亚龙湾 URL 原样来自 E9 golden sourceUrl） */
const CORPUS: ReadonlyArray<{ noteId: string; url: string; label: string }> = [
  {
    noteId: "6a93bde9000000002600105b",
    url: "https://www.xiaohongshu.com/explore/6a93bde9000000002600105b?xsec_token=REDACTED_NOTE_A=&xsec_source=pc_search&source=web_explore_feed",
    label: "S6 亚龙湾热带天堂森林公园（E9 golden 输入源）",
  },
  {
    noteId: "6ace31c6000000001b0202f7",
    // 分享全串取自历史成功抓取记录（server/data 行程源快照，xsec_token 与笔记绑定；
    // 亚龙湾 token 拼到本笔记会 404——token 不可跨笔记复用，2026-10-28 实测）
    url: "https://www.xiaohongshu.com/explore/6ace31c6000000001b0202f7?xsec_token=REDACTED_NOTE_B=&xsec_source=pc_search&source=web_explore_feed",
    label: "S4 西岛 seawalk 攻略（Q7 点位配图输入源；与 fixture S4 同一笔记，不重复计源）",
  },
];

function uploadsImageCount(noteId: string): number {
  const dir = join(UPLOADS_DIR, `xhs_${noteId}`);
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((name) => /\.(jpe?g|png|webp)$/i.test(name)).length;
}

interface BuildResult {
  noteId: string;
  status: string;
  contentHash: string;
  coverage: string;
}

async function buildOne(entry: (typeof CORPUS)[number], force: boolean): Promise<BuildResult> {
  const cached = loadExtractionCache(entry.noteId);
  if (cached !== null && !force) {
    return {
      noteId: entry.noteId,
      status: "cached（跳过，contentHash 复算一致）",
      contentHash: cached.contentHash,
      coverage: `正文 ${cached.text.length} 字／图 ${cached.imageCount} 张／entries ${cached.entries.length} 条`,
    };
  }

  const imagesBefore = uploadsImageCount(entry.noteId);
  const note = await extractXhsNote(entry.url);
  if (!note.success || typeof note.text !== "string" || note.text.trim() === "") {
    throw new Error(`${entry.noteId} 抓取失败或正文为空：${JSON.stringify(note).slice(0, 200)}`);
  }
  const imagesAfter = uploadsImageCount(entry.noteId);
  const imagesReused = imagesBefore > 0 && imagesAfter === imagesBefore;
  const readySlots = (note.imageSlots ?? []).filter((slot) => slot.path !== null).length;

  const started = Date.now();
  const entries = await extractNoteEntries(note.text);
  const extractMs = Date.now() - started;

  const record: ExtractionCacheNote = {
    noteId: entry.noteId,
    sourceUrl: entry.url,
    title: note.title ?? "",
    text: note.text,
    contentHash: noteContentHash(note.text),
    capturedAt: new Date().toISOString(),
    imageCount: imagesAfter,
    imagesReused,
    entries,
    extractMs,
  };
  const path = saveExtractionCache(record);
  return {
    noteId: entry.noteId,
    status: `built（真实抓取＋真实抽取 ${extractMs}ms → ${path.replace(`${REPO_ROOT}/`, "")}）`,
    contentHash: record.contentHash,
    coverage:
      `标题「${record.title}」正文 ${record.text.length} 字／图片槽位 ready ${readySlots}、uploads 计 ${imagesAfter}` +
      `${imagesReused ? "（复用既有产物，未新增下载）" : ""}／entries ${entries.length} 条（${entries.map((e) => e.name).join("、")}）`,
  };
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  console.log(`[corpus] v1.4 语料前置建缓存：${CORPUS.length} 篇（force=${force}）`);
  const results: BuildResult[] = [];
  for (const entry of CORPUS) {
    console.log(`[corpus] —— ${entry.label}`);
    results.push(await buildOne(entry, force));
  }
  console.log("\n[corpus] 汇总：");
  for (const r of results) {
    console.log(`  ${r.noteId}  status=${r.status}`);
    console.log(`    contentHash=${r.contentHash}`);
    console.log(`    coverage=${r.coverage}`);
  }
}

void main().catch((error) => {
  console.error("[corpus] 失败：", error);
  process.exit(1);
});
