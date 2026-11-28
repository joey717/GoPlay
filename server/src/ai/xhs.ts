/**
 * Task #88 小红书笔记链接抓取：链接 → 标题 / 正文 / 图片（图片由服务端代理下载到本地）。
 *
 * 执行顺序：
 *   URL 校验（域名白名单）→ 短链展开（xhslink.com 手动跟 30x，最多 5 跳）
 *   → 抓取笔记页 HTML（15s 超时，5MB 上限）→ 解析
 *   → 图片代理下载到 server/uploads/xhs_{noteId}/N.{jpg|png|webp}（每张 5MB 上限）
 *   → 返回 /api/uploads/xhs_{noteId}/N.jpg 形式的可访问路径（xhsAssetRoutes 受控读取）。
 *
 * 解析策略（按优先级）：
 *   1. window.__INITIAL_STATE__ JSON：
 *      形状 A（桌面 SSR）：note.noteDetailMap[noteId].note → title / desc / imageList；
 *      形状 B（移动端 SSR，2026-10 实测）：noteData.data.noteData → title / desc / imageList，
 *        以及 noteData.normalNotePreloadData（title / desc / imagesList）；
 *      最后兜底广度搜索含 desc + imageList 的对象。
 *   2. meta 标签兜底：og:title / og:description / og:image（页面被降级或结构变更时）。
 *
 * 实测备注（2026-10-19，真实分享链接）：
 * - 桌面 UA 一律 302 到 /login 登录墙；移动端 UA 才返回含笔记数据的 SSR 页面，
 *   故此处统一使用移动端 UA（注释保留原因，避免后续被改回桌面 UA 而静默失效）。
 * - 图片 CDN（*.xhscdn.com）无需 Cookie，带 Referer 即可直接下载。
 *
 * 安全：
 * - 域名白名单（xiaohongshu.com / xhslink.com），跳转每一跳都复检，防开放重定向到内网；
 * - 图片只从可信 CDN 域名下载（*.xhscdn.com / *.xhscdn.net / *.xiaohongshu.com）；
 * - 单请求 15s 超时、页面与单图均 5MB 上限（流式读取，超限立即中止）；
 * - 错误消息面向用户可读，不含响应头 / Cookie / 堆栈等内部细节。
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { UPLOADS_DIR } from "../persistence/store.js";

/**
 * 移动端 UA：实测桌面 UA 会被重定向到登录页（/login?redirectPath=…），
 * 只有移动端 UA 才返回含 __INITIAL_STATE__ 笔记数据的服务端渲染页面。
 */
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

/** 单次请求超时（页面 / 每一跳短链 / 每张图片） */
const REQUEST_TIMEOUT_MS = 15_000;
/** 页面与单张图片的字节上限 */
const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** 短链最多跟随跳数 */
const MAX_REDIRECTS = 5;
/**
 * 单篇笔记最多代理下载的图片数（Task #175：12 → 24，完整覆盖 17 图长笔记；
 * 仍设硬上限防御异常大报文与无限制落盘）。
 */
const MAX_IMAGES = 24;

/** 允许抓取的站点根域（含其子域。Task #394：补 xhslink.cn——小红书 App 现行
 *  分享口令短链域名为 .cn 后缀，缺它则口令链接被拒 / 被降级为纯文本来源） */
const ALLOWED_SITE_SUFFIXES = ["xiaohongshu.com", "xhslink.com", "xhslink.cn"] as const;
/** 允许代理下载的图片 CDN 根域（含其子域） */
const ALLOWED_IMAGE_SUFFIXES = ["xhscdn.com", "xhscdn.net", "xiaohongshu.com"] as const;

/** 笔记页路径：/explore/{noteId} 或 /discovery/item/{noteId} */
const NOTE_PATH_PATTERN = /^\/(?:explore|discovery\/item)\/([0-9a-zA-Z]+)/;

/** 抓取失败：message 面向用户可直接展示 */
export class XhsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "XhsError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** POST /api/ai/extract-url 的响应体 */
export interface XhsNoteResult {
  success: boolean;
  title?: string;
  text?: string;
  /** 服务端代理下载后的可访问路径（/api/uploads/xhs_{noteId}/1.jpg）；仅含下载成功项（兼容既有消费者） */
  images?: string[];
  /**
   * Task #175：按原 imageList 顺序对齐的下载槽位（index = 1-based 原始页码）。
   * 下载失败的槽位 path=null 且携带 error，后续图片的页码不得前移；
   * 攻略来源链路消费本字段建立页码映射，/api/ai/extract-url 旧消费者不受影响。
   */
  imageSlots?: XhsImageSlot[];
  sourceUrl?: string;
  error?: string;
}

/** 单张图片下载槽位：index 固定为原始页码，失败时 path=null 并携带可读原因 */
export interface XhsImageSlot {
  index: number;
  path: string | null;
  error?: string;
}

// ===== URL 校验 =====

function hostMatches(hostname: string, suffixes: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** 是否小红书站点链接（http/https + 域名白名单） */
export function isXhsUrl(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return hostMatches(url.hostname, ALLOWED_SITE_SUFFIXES);
  } catch {
    return false;
  }
}

/** 从 /explore/{id} 或 /discovery/item/{id} 提取笔记 ID */
function noteIdFromUrl(url: URL): string | null {
  return url.pathname.match(NOTE_PATH_PATTERN)?.[1] ?? null;
}

/** 从任意笔记链接（/explore/{id} 或 /discovery/item/{id}）提取笔记 ID；非法链接返回 null。
 *  Task #222：攻略来源重试据此按落盘约定（uploads/xhs_{noteId}/{页码}.{ext}）
 *  探测仍在本地的原图 */
export function extractXhsNoteId(rawUrl: string): string | null {
  try {
    return noteIdFromUrl(new URL(rawUrl.trim()));
  } catch {
    return null;
  }
}

// ===== HTTP 基础能力 =====

function requestHeaders(): Record<string, string> {
  return {
    "User-Agent": MOBILE_UA,
    "Accept-Language": "zh-CN,zh;q=0.9",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    Referer: "https://www.xiaohongshu.com/",
  };
}

/** 单次请求（统一 15s 超时）；网络层失败 / 超时统一转为可读 XhsError */
async function fetchOnce(url: URL, redirect: RequestRedirect): Promise<Response> {
  try {
    return await fetch(url, {
      redirect,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: requestHeaders(),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new XhsError(
      timedOut ? "小红书页面读取超时（15 秒），请稍后重试" : "无法连接小红书，请检查网络后重试",
      { cause: error },
    );
  }
}

/** 流式读取响应体并执行 5MB 上限（超限立即取消剩余流，不把大文件读进内存） */
async function readCappedBody(res: Response, label: string): Promise<Uint8Array> {
  if (res.body === null) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceeded = false;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (error) {
      // 超时（AbortSignal）或连接中断：统一转为可读错误，不透传底层 DOMException
      throw new XhsError(`${label}读取中断（可能超时），请重试`, { cause: error });
    }
    const { done, value } = chunk;
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      exceeded = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  if (exceeded) throw new XhsError(`${label}超过 5MB 上限，已中止`);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function decodeUtf8(data: Uint8Array): string {
  return new TextDecoder("utf-8").decode(data);
}

/** 释放不打算读取的响应体，避免连接悬挂 */
async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

// ===== 短链展开 =====

/**
 * 把分享链接归一化为笔记页地址：
 * - 已是 /explore/{id} 或 /discovery/item/{id} → 直接返回；
 * - xhslink.com 短链 → 手动跟 30x（每跳复检域名白名单），或从 200 响应 HTML 中提取笔记地址。
 * 返回的 finalUrl 可能是移动端跳转后的地址，调用方以其为准。
 */
async function resolveNotePage(start: URL): Promise<URL> {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isXhsUrl(current.toString())) {
      throw new XhsError("链接跳转到了非小红书域名，已中止");
    }
    if (noteIdFromUrl(current) !== null) return current;

    const res = await fetchOnce(current, "manual");
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location !== null) {
      await discard(res);
      try {
        current = new URL(location, current);
      } catch {
        throw new XhsError("小红书短链返回了无法识别的跳转地址");
      }
      continue;
    }
    if (res.status !== 200) {
      await discard(res);
      throw new XhsError(`小红书短链跳转失败（HTTP ${res.status}）`);
    }

    // 少数短链返回 200 + JS 跳转：从 HTML 里找笔记地址
    const html = decodeUtf8(await readCappedBody(res, "短链页面"));
    const matched = html.match(
      /https?:\/\/[^\s"'<>\\]*xiaohongshu\.com\/(?:explore|discovery\/item)\/[0-9a-zA-Z]+[^\s"'<>\\]*/,
    );
    if (matched === null) {
      throw new XhsError("链接里没有找到笔记地址，请粘贴小红书笔记详情页链接");
    }
    return new URL(matched[0].replace(/\\u002F/g, "/"));
  }
  throw new XhsError("小红书短链跳转次数过多，已中止");
}

/** 抓取笔记页 HTML；登录墙 / 404 页提前给出可读原因 */
async function fetchNoteHtml(noteUrl: URL): Promise<{ html: string; finalUrl: string }> {
  const res = await fetchOnce(noteUrl, "follow");
  if (!res.ok) {
    await discard(res);
    throw new XhsError(
      res.status === 404
        ? "小红书返回 404：笔记不存在或已删除"
        : `小红书返回 HTTP ${res.status}（可能被风控拦截），请稍后重试`,
    );
  }
  const finalUrl = res.url === "" ? noteUrl.toString() : res.url;
  const html = decodeUtf8(await readCappedBody(res, "页面"));

  let pathname = "";
  try {
    pathname = new URL(finalUrl).pathname;
  } catch {
    pathname = noteUrl.pathname;
  }
  if (/^\/login\b/.test(pathname)) {
    throw new XhsError("小红书要求登录后才能查看该笔记（被登录墙拦截）");
  }
  if (/^\/404\b/.test(pathname)) {
    throw new XhsError("该笔记不存在或已删除（小红书返回 404 页面）");
  }
  return { html, finalUrl };
}

// ===== HTML 解析 =====

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 宽松 JSON 解析：SSR 数据里含裸 undefined（JS 字面量），逐个候选清理后重试 */
function parseLooseJson(raw: string): unknown | null {
  const candidates = [
    raw,
    raw.replace(/:\s*undefined(?=\s*[,}])/g, ":null"),
    raw.replace(/\bundefined\b/g, "null"),
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
  }
  return null;
}

/** 提取 window.__INITIAL_STATE__ 的对象（截取到 </script>，去掉尾部多余分号） */
function extractInitialState(html: string): unknown | null {
  const marker = /window\.__INITIAL_STATE__\s*=\s*/g;
  const match = marker.exec(html);
  if (match === null) return null;
  const rest = html.slice(match.index + match[0].length);
  const end = rest.indexOf("</script>");
  const raw = (end >= 0 ? rest.slice(0, end) : rest).trim().replace(/;$/, "");
  if (raw === "") return null;
  return parseLooseJson(raw);
}

/** 笔记对象的最小形状：有 desc，且有图片列表（imageList / imagesList） */
function isNoteLike(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.desc === "string" &&
    (Array.isArray(value.imageList) || Array.isArray(value.imagesList))
  );
}

/** 兜底：广度优先找第一个笔记形状的对象（限制节点数，避免遍历爆炸） */
function searchNoteLike(root: unknown): Record<string, unknown> | null {
  const queue: unknown[] = [root];
  let visited = 0;
  while (queue.length > 0 && visited < 5_000) {
    const node = queue.shift();
    visited += 1;
    if (Array.isArray(node)) {
      queue.push(...node);
      continue;
    }
    if (!isRecord(node)) continue;
    if (isNoteLike(node)) return node;
    queue.push(...Object.values(node));
  }
  return null;
}

/** 从 InitialState 中定位笔记对象：已知两条 SSR 形状优先，广度搜索兜底 */
function findNoteObject(state: unknown): Record<string, unknown> | null {
  if (!isRecord(state)) return null;

  // 形状 A：note.noteDetailMap[noteId].note（桌面 SSR / 常规详情页）
  if (isRecord(state.note)) {
    const detailMap = state.note.noteDetailMap;
    if (isRecord(detailMap)) {
      for (const value of Object.values(detailMap)) {
        const note = isRecord(value) && isRecord(value.note) ? value.note : value;
        if (isNoteLike(note)) return note;
      }
    }
    if (isNoteLike(state.note)) return state.note;
  }

  // 形状 B：noteData.data.noteData 直接是笔记对象（移动端 SSR，实测形状）
  if (isRecord(state.noteData)) {
    const data = state.noteData.data;
    if (isRecord(data) && isNoteLike(data.noteData)) return data.noteData;
    if (isNoteLike(state.noteData.normalNotePreloadData)) return state.noteData.normalNotePreloadData;
  }

  return searchNoteLike(state);
}

/** 从笔记对象里收集图片 URL（url / 多档清晰度 / infoList 兜底），保序去重 */
function imageUrlsFromNote(note: Record<string, unknown>): string[] {
  const list = Array.isArray(note.imageList)
    ? note.imageList
    : Array.isArray(note.imagesList)
      ? note.imagesList
      : [];
  const urls: string[] = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      if (entry !== "") urls.push(entry);
      continue;
    }
    if (!isRecord(entry)) continue;
    const direct = [entry.url, entry.urlSizeLarge, entry.urlDefault, entry.urlPre, entry.masterUrl].find(
      (value): value is string => typeof value === "string" && value.trim() !== "",
    );
    if (direct !== undefined) {
      urls.push(direct);
      continue;
    }
    const infoList = Array.isArray(entry.infoList) ? entry.infoList : [];
    const fromInfo = infoList
      .map((item) => (isRecord(item) && typeof item.url === "string" ? item.url : ""))
      .find((value) => value !== "");
    if (fromInfo !== undefined) urls.push(fromInfo);
  }
  return [...new Set(urls)];
}

/** HTML 实体解码（meta 兜底用；只处理常见几种） */
function decodeHtmlEntities(raw: string): string {
  return raw
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** 提取指定 meta 的全部 content（兼容 property/name 与 content 的两种书写顺序） */
function metaContents(html: string, key: string): string[] {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']*)["']`, "gi"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${escaped}["']`, "gi"),
  ];
  const values: string[] = [];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const value = decodeHtmlEntities(match[1]).trim();
      if (value !== "") values.push(value);
    }
  }
  return [...new Set(values)];
}

/** 正文清洗：统一换行、去掉话题标记后缀（#西岛攻略[话题]# → #西岛攻略）、压缩空行 */
function cleanNoteText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/\[话题\]#/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface ParsedNote {
  noteId: string | null;
  title: string;
  desc: string;
  imageUrls: string[];
}

/**
 * 解析笔记页：先走 __INITIAL_STATE__（标题 + 正文 + 多图），
 * 失败再退回 og:title / og:description / og:image（可能只有部分字段）。
 */
function parseNotePage(html: string): ParsedNote | null {
  const note = findNoteObject(extractInitialState(html));
  if (note !== null) {
    const title = typeof note.title === "string" ? note.title.trim() : "";
    const desc = typeof note.desc === "string" ? note.desc : "";
    const noteId = typeof note.noteId === "string" && note.noteId !== "" ? note.noteId : null;
    const imageUrls = imageUrlsFromNote(note);
    if (title !== "" || desc !== "" || imageUrls.length > 0) {
      return { noteId, title, desc, imageUrls };
    }
  }

  // meta 兜底：og:title 常见「标题 - 小红书」后缀，剥掉
  const title =
    metaContents(html, "og:title")
      .map((value) => value.replace(/\s*[-|–]\s*小红书\s*$/, "").trim())
      .find((value) => value !== "") ?? "";
  const desc = metaContents(html, "og:description").join("\n").trim();
  const imageUrls = metaContents(html, "og:image").filter(
    // og:image 占位图（ci.xiaohongshu.com/?imageMogr2/... 无实际路径）不算笔记图片
    (value) => !/^https?:\/\/ci\.xiaohongshu\.com\/\?/.test(value),
  );
  if (title === "" && desc === "" && imageUrls.length === 0) return null;
  return { noteId: null, title, desc, imageUrls };
}

// ===== 图片代理下载 =====

/** 是否可信图片 CDN（域名白名单，防 SSRF） */
function isTrustedImageUrl(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return hostMatches(url.hostname, ALLOWED_IMAGE_SUFFIXES);
}

/** 图片扩展名：优先 content-type，其次 magic bytes，兜底 jpg */
function imageExtension(contentType: string | null, data: Uint8Array): string {
  const type = (contentType ?? "").toLowerCase();
  if (type.includes("png")) return "png";
  if (type.includes("webp")) return "webp";
  if (type.includes("gif")) return "gif";
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  if (data.length >= 4) {
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "png";
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpg";
    if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) return "webp";
    if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return "gif";
  }
  return "jpg";
}

/** 单图下载结果：成功携带保存后的 API 路径，失败携带可读原因（不抛错） */
interface DownloadedImage {
  path: string | null;
  error?: string;
}

/** 下载单张图片到本地；任何失败（非可信域名 / HTTP 错误 / 超限）降级为 null + 原因 */
async function downloadOneImage(
  noteId: string,
  dir: string,
  rawUrl: string,
  index: number,
): Promise<DownloadedImage> {
  let url: URL;
  try {
    url = new URL(rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl);
  } catch {
    return { path: null, error: "图片地址无法解析" };
  }
  if (!isTrustedImageUrl(url)) {
    console.warn(`[XHS] 跳过非可信域名的图片：${url.hostname}`);
    return { path: null, error: `非可信图片域名（${url.hostname}）` };
  }
  try {
    const res = await fetchOnce(url, "follow");
    if (!res.ok) {
      await discard(res);
      console.warn(`[XHS] 图片 ${index} 下载失败：HTTP ${res.status}`);
      return { path: null, error: `下载失败（HTTP ${res.status}）` };
    }
    const data = await readCappedBody(res, `图片 ${index}`);
    if (data.byteLength === 0) return { path: null, error: "下载内容为空" };
    const filename = `${index}.${imageExtension(res.headers.get("content-type"), data)}`;
    await fs.writeFile(path.join(dir, filename), data);
    return { path: `/api/uploads/xhs_${noteId}/${filename}` };
  } catch (error) {
    const message = error instanceof XhsError ? error.message : "下载中断";
    console.warn(`[XHS] 图片 ${index} 下载失败：`, error instanceof Error ? error.message : error);
    return { path: null, error: message.includes("5MB") ? "图片超过 5MB 上限" : message };
  }
}

/**
 * 批量代理下载笔记图片：清空目录后重新落盘（同一笔记重复提取不产生孤儿文件）。
 * Task #175：返回按原始页码对齐的槽位——文件名 = {原始页码}.{ext}，下载失败的槽位
 * 保持 null 占位，绝不把后续图片前移（防 P 页码映射错乱）；分批并发（每批 5 张）
 * 避免 17+ 张同时打 CDN 触发风控。
 * options.outDir 供验证脚本下载到临时目录（缺省 uploads/xhs_{noteId}）；
 * options.baseUrl 供验证脚本改写返回路径前缀（缺省 /api/uploads）。
 * 全程不抛错：目录创建失败或单图失败只降级为空槽位。
 */
export async function downloadNoteImages(
  noteId: string,
  urls: string[],
  options: { outDir?: string; baseUrl?: string } = {},
): Promise<{ slots: XhsImageSlot[]; saved: string[] }> {
  if (urls.length === 0) return { slots: [], saved: [] };
  const targets = urls.slice(0, MAX_IMAGES);
  const dir = options.outDir ?? path.join(UPLOADS_DIR, `xhs_${noteId}`);
  const baseUrl = options.baseUrl ?? "/api/uploads";
  try {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
  } catch (error) {
    console.error("[XHS] 图片目录准备失败（不影响正文提取）:", error);
    return {
      slots: targets.map((_, position) => ({ index: position + 1, path: null, error: "图片目录准备失败" })),
      saved: [],
    };
  }
  // 分批并发下载，保持 index 与原始页码一一对应
  const slots: XhsImageSlot[] = [];
  const saved: string[] = [];
  const DOWNLOAD_CONCURRENCY = 5;
  for (let start = 0; start < targets.length; start += DOWNLOAD_CONCURRENCY) {
    const batch = targets.slice(start, start + DOWNLOAD_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((url, offset) => downloadOneImage(noteId, dir, url, start + offset + 1)),
    );
    results.forEach((result, offset) => {
      const index = start + offset + 1;
      if (result.status === "fulfilled" && result.value.path !== null) {
        const apiPath = `${baseUrl}/xhs_${noteId}/${result.value.path.split("/").pop()}`;
        slots.push({ index, path: apiPath });
        saved.push(apiPath);
      } else {
        const error =
          result.status === "rejected"
            ? "下载异常"
            : (result.value.error ?? "下载失败");
        slots.push({ index, path: null, error });
      }
    });
  }
  const failedCount = slots.filter((slot) => slot.path === null).length;
  console.log(
    `[XHS] 图片代理下载完成：${saved.length}/${targets.length} 张${failedCount > 0 ? `（失败 ${failedCount} 张保留原始页码占位）` : ""}`,
  );
  return { slots, saved };
}

// ===== 图片受控读取（挂载于 /uploads） =====

/** 图片目录名：xhs_{noteId}（noteId 字母数字，兜底为 16 位十六进制） */
const ASSET_DIR_PATTERN = /^xhs_[0-9a-zA-Z]{1,32}$/;
/** 图片文件名：本模块生成的 {序号}.{ext}，不接受任何外部命名 */
const ASSET_FILENAME_PATTERN = /^\d{1,2}\.(jpg|jpeg|png|webp|gif)$/;
const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

/**
 * 小红书笔记图片的受控读取（index.ts 挂载于 /api/uploads 与 /uploads）。
 * 不开放静态目录：目录名必须命中 xhs_{noteId} 命名约定、文件名必须是 {序号}.{ext}，
 * 显式拒绝 ".." 与路径分隔符，并二次校验解析后的绝对路径仍在该目录内（防目录穿越）。
 */
export const xhsAssetRoutes = new Hono();

xhsAssetRoutes.get("/:dir/:filename", async (c, next) => {
  const dir = c.req.param("dir");
  const filename = c.req.param("filename");
  // 目录不是 xhs_{noteId} 时（如行程截图 /api/uploads/{uuid}/ev_shot_xxx.jpg）
  // 必须交还给后续路由（persistence/routes.ts 的 GET /uploads/:tripId/:filename），
  // 否则本路由挂在 /api/uploads 上会把所有非笔记图片的请求一律 400 掉。
  if (!ASSET_DIR_PATTERN.test(dir)) {
    await next();
    return;
  }
  if (!ASSET_FILENAME_PATTERN.test(filename)) {
    return c.json({ error: "非法的图片路径" }, 400);
  }
  const baseDir = path.join(UPLOADS_DIR, dir);
  const filePath = path.join(baseDir, filename);
  if (!path.resolve(filePath).startsWith(path.resolve(baseDir) + path.sep)) {
    return c.json({ error: "非法的图片路径" }, 400);
  }
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return c.json({ error: "图片不存在" }, 404);
    const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
    c.header("Content-Type", MIME_BY_EXT[ext] ?? "application/octet-stream");
    c.header("Content-Length", String(stat.size));
    c.header("Cache-Control", "private, max-age=86400");
    const stream = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream<Uint8Array>;
    return c.body(stream, 200);
  } catch {
    return c.json({ error: "图片不存在" }, 404);
  }
});

// ===== 入口 =====

/** 无笔记 ID 时按链接生成稳定的目录名（同链接重复提取复用同一目录） */
function fallbackNoteId(rawUrl: string): string {
  return createHash("sha1").update(rawUrl).digest("hex").slice(0, 16);
}

/**
 * 抓取小红书笔记：标题 + 正文 + 本地化图片路径。
 * 失败抛 XhsError（message 可直接展示给用户）。
 */
export async function extractXhsNote(rawUrl: string): Promise<XhsNoteResult> {
  const trimmed = rawUrl.trim();
  if (!isXhsUrl(trimmed)) {
    throw new XhsError("仅支持小红书笔记链接（xiaohongshu.com / xhslink.com / xhslink.cn）");
  }

  const noteUrl = await resolveNotePage(new URL(trimmed));
  console.log(`[XHS] 开始抓取笔记页：${noteUrl.origin}${noteUrl.pathname}`);
  const { html, finalUrl } = await fetchNoteHtml(noteUrl);

  const parsed = parseNotePage(html);
  if (parsed === null) {
    throw new XhsError("未能从页面中解析出笔记内容（可能需要登录或页面结构已调整）");
  }

  const noteId =
    parsed.noteId ??
    noteIdFromUrl(noteUrl) ??
    noteIdFromUrl(new URL(finalUrl)) ??
    fallbackNoteId(trimmed);

  const text = cleanNoteText([parsed.title, parsed.desc].filter((part) => part !== "").join("\n\n"));
  const { slots, saved } = await downloadNoteImages(noteId, parsed.imageUrls);
  if (text === "" && saved.length === 0) {
    throw new XhsError("页面里没有可用的笔记正文与图片（可能需要登录后查看）");
  }

  console.log(
    `[XHS] 提取成功：noteId=${noteId}，标题 ${parsed.title.length} 字，正文 ${text.length} 字，图片 ${saved.length}/${slots.length} 张`,
  );
  return {
    success: true,
    title: parsed.title === "" ? undefined : parsed.title,
    text,
    images: saved,
    imageSlots: slots,
    sourceUrl: finalUrl,
  };
}
