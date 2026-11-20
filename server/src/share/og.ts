/**
 * Task #261：分享链接的 OG 预览数据与 HTML 壳（纯函数 + 模板注入，无框架依赖）。
 *
 * 为什么需要服务端 HTML：
 * - 只读分享页是 SPA，`/share/:tripId` 直接返回 index.html 时，社交平台爬虫
 *   （不执行 JS）只能拿到通用标题，转发出去没有预览；
 * - 因此服务端在 `/share/:tripId` 返回 HTML 时把 OG meta 注入进去：
 *   有 `web/dist/index.html`（生产构建产物）→ 注入后原样返回，浏览器仍由 SPA 渲染；
 *   没有构建产物（本地纯开发）→ 返回最小壳 + 跳转到 Vite dev server 的同一路径。
 *
 * 文案口径与前端一致（web/src/lib/tripCover.ts / web/src/lib/share.ts）：
 * - 标题：行程名；未命名时「城市 N天行程」；
 * - 描述：备忘压成单行前 100 字；无备忘时「城市 · N天N晚 · 日期区间」；
 * - 图片：封面受控读取地址（/api/uploads/...）转绝对地址，无封面则不给 og:image。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Day, Trip } from "@goplay/shared";

/** 描述上限（与 web/src/lib/share.ts 的 SHARE_DESC_MAX 同口径） */
export const OG_DESC_MAX = 100;
/** 站点名（og:site_name） */
export const OG_SITE_NAME = "GoPlay 去玩";
/** 未配置时的前端开发地址（只在没有构建产物的环境里用于跳转） */
export const DEFAULT_DEV_ORIGIN = "http://localhost:5173";

export interface ShareOgData {
  /** og:title：行程名，未命名时「城市 N天行程」 */
  title: string;
  /** og:description：备忘摘要或「城市 · N天N晚 · 日期区间」 */
  description: string;
  /** og:image：封面绝对地址；无封面为 null（此时不输出该标签） */
  image: string | null;
  /** og:url：当前分享链接绝对地址 */
  url: string;
  type: "website";
  siteName: string;
}

/** 按 Unicode 码点截断（不切断 emoji / 组合字符） */
function clampCodePoints(value: string, max: number): string {
  const points = Array.from(value);
  return points.length <= max ? value : `${points.slice(0, max).join("")}…`;
}

/** 备忘摘要：连续空白压成单空格 → 前 100 码点 → 省略号 */
export function memoExcerpt(memo: string, max: number = OG_DESC_MAX): string {
  const text = memo.replace(/\s+/gu, " ").trim();
  return clampCodePoints(text, max);
}

/** "2026-11-08" → "11/08"（与 web/src/lib/format.ts 的 shortDate 同口径） */
function shortDate(date: string): string {
  const value = date.trim();
  return value.length >= 10 ? `${value.slice(5, 7)}/${value.slice(8, 10)}` : value;
}

/** 按 dayRefs 顺序（其次 dayIndex）取出每天的日期；缺失时用空数组 */
function orderedDayDates(trip: Trip): string[] {
  const fromRefs = trip.dayRefs
    .map((ref) => trip.days[ref])
    .filter((day): day is Day => day !== undefined);
  const days = fromRefs.length > 0 ? fromRefs : Object.values(trip.days);
  return [...days].sort((a, b) => a.dayIndex - b.dayIndex).map((day) => day.date);
}

/**
 * 封面路径 → OG 需要的绝对地址：
 * - 已是绝对地址（http(s):// 等）/ data-URL → 原样返回；
 * - 根路径 → 拼 origin；
 * - 相对路径（uploads/{tripId}/cover.jpg）→ 拼 `${origin}/api/...`（受控读取接口）；
 * - 有 version 时追加 `v=`，让换封面后爬虫缓存也能刷新。
 */
function coverImageAbsolute(origin: string, coverImage: string, version?: number): string {
  const path = coverImage.trim();
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(path)) return path;
  const base = path.startsWith("/")
    ? `${origin}${path}`
    : `${origin}/api/${path.replace(/^\/+/u, "")}`;
  if (version === undefined || !Number.isFinite(version)) return base;
  return `${base}${base.includes("?") ? "&" : "?"}v=${encodeURIComponent(String(version))}`;
}

/**
 * 由 Trip 推导 OG 数据。origin 为当前请求的外部地址（`https://host`），
 * 用于把相对封面路径与分享链接拼成绝对地址（爬虫要求绝对 URL）。
 */
export function buildShareOgData(trip: Trip, tripId: string, origin: string): ShareOgData {
  const dates = orderedDayDates(trip);
  const dayCount =
    dates.length > 0 ? dates.length : trip.dateRange.nights > 0 ? trip.dateRange.nights + 1 : 0;
  const nightCount = Math.max(0, dayCount - 1);
  const city = trip.destination.city.trim();

  const tripName = (trip.tripName ?? "").trim();
  const title =
    tripName !== ""
      ? tripName
      : [`${city}`, dayCount > 0 ? `${dayCount}天行程` : "行程"].filter((part) => part !== "").join(" ");

  const spanLabel = dayCount > 0 ? (nightCount > 0 ? `${dayCount}天${nightCount}晚` : `${dayCount}天`) : "";
  const startDate = dates[0] ?? trip.dateRange.start;
  const endDate = dates[dates.length - 1] ?? trip.dateRange.end;
  const dateLabel = (() => {
    if (startDate === "" && endDate === "") return "";
    if (startDate === "" || startDate === endDate) return shortDate(startDate || endDate);
    if (endDate === "") return shortDate(startDate);
    return `${shortDate(startDate)}-${shortDate(endDate)}`;
  })();
  const metaLine = [city, spanLabel, dateLabel].filter((part) => part !== "").join(" · ");

  const memo = memoExcerpt(trip.memo ?? "");
  const description = memo !== "" ? memo : metaLine !== "" ? metaLine : OG_SITE_NAME;

  const cover = (trip.coverImage ?? "").trim();
  const image = cover === "" ? null : coverImageAbsolute(origin, cover, trip.version);

  return {
    title,
    description,
    image,
    url: `${origin}/share/${encodeURIComponent(tripId)}`,
    type: "website",
    siteName: OG_SITE_NAME,
  };
}

/** HTML 文本转义（标题/描述/URL 都来自用户数据） */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

/** OG / Twitter 预览标签块（不含 <title>，见 renderShareHtml）；每行自带 4 空格缩进 */
export function renderOgTags(og: ShareOgData): string {
  const tags = [
    `<meta property="og:type" content="${escapeHtml(og.type)}" />`,
    `<meta property="og:site_name" content="${escapeHtml(og.siteName)}" />`,
    `<meta property="og:title" content="${escapeHtml(og.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(og.description)}" />`,
    `<meta property="og:url" content="${escapeHtml(og.url)}" />`,
  ];
  // 只声明抓取到的封面地址，不编造宽高（错报尺寸会让部分平台裁切预览图）
  if (og.image !== null) {
    tags.push(`<meta property="og:image" content="${escapeHtml(og.image)}" />`);
  }
  tags.push(
    `<meta name="twitter:card" content="${og.image !== null ? "summary_large_image" : "summary"}" />`,
    `<meta name="twitter:title" content="${escapeHtml(og.title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(og.description)}" />`,
  );
  if (og.image !== null) {
    tags.push(`<meta name="twitter:image" content="${escapeHtml(og.image)}" />`);
  }
  return tags.map((tag) => `    ${tag}`).join("\n");
}

/**
 * 把 <title> 与额外的 head 标签注入已有的 SPA 模板（web/dist/index.html）：
 * 替换 <title>，并在 </head> 前插入 extraTags（已带缩进的标签块）。
 * 用函数式替换，避免文案里的 `$&` 被 String.replace 当成替换模式。
 */
function injectHead(template: string, title: string, extraTags: string): string {
  const titleTag = `<title>${escapeHtml(title)}</title>`;

  let html = template;
  html = /<title>[\s\S]*?<\/title>/iu.test(html)
    ? html.replace(/<title>[\s\S]*?<\/title>/iu, () => titleTag)
    : html.replace(/<head[^>]*>/iu, (head) => `${head}\n    ${titleTag}`);

  return /<\/head>/iu.test(html)
    ? html.replace(/<\/head>/iu, () => `${extraTags}\n  </head>`)
    : `${extraTags}\n${html}`;
}

/** 把 OG 标签注入 SPA 模板（生产环境浏览器与爬虫拿同一份 HTML） */
export function injectOgIntoHtml(template: string, og: ShareOgData): string {
  return injectHead(template, og.title, renderOgTags(og));
}

/**
 * 没有构建产物时的最小壳：爬虫只读 meta（拿到预览），浏览器被 JS 跳到开发服务器
 * 的同一路径（开发服务器接管 SPA 渲染）。此时不做整页渲染，避免依赖不存在的 bundle。
 */
export function renderOgShell(og: ShareOgData, redirectUrl: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(og.title)}</title>
${renderOgTags(og)}
  </head>
<body>
    <div id="root"></div>
    <p style="font-family: system-ui, sans-serif; padding: 24px; color: #57534E;">正在打开行程…</p>
    <script>location.replace(${JSON.stringify(redirectUrl)});</script>
  </body>
</html>
`;
}

/** 分享链接不可用时的最简页面（不输出 OG，避免把错误页当成行程预览） */
export function renderShareErrorHtml(message: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex" />
    <title>${escapeHtml(message)} · ${OG_SITE_NAME}</title>
  </head>
<body>
    <div style="font-family: system-ui, -apple-system, 'PingFang SC', sans-serif; max-width: 420px; margin: 18vh auto 0; padding: 0 24px; color: #57534E;">
      <h1 style="font-size: 17px; color: #1C1917;">${escapeHtml(message)}</h1>
      <p style="font-size: 13px; line-height: 1.7;">请让分享的朋友重新发一次链接。</p>
    </div>
  </body>
</html>
`;
}

/**
 * 候选的 SPA 模板路径：允许环境变量覆盖，其余按「仓库根启动 / server 目录启动 /
 * 源码运行 / 编译后运行」四种常见 cwd 与模块位置兜底。
 */
export function webIndexCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.WEB_DIST_INDEX,
    resolve(process.cwd(), "web/dist/index.html"),
    resolve(process.cwd(), "../web/dist/index.html"),
    resolve(here, "../../../web/dist/index.html"),
    resolve(here, "../../../../web/dist/index.html"),
  ];
  return candidates.filter((candidate): candidate is string => candidate !== undefined && candidate !== "");
}

/** 读取 SPA 模板（web/dist/index.html）；没有构建产物返回 null */
export function loadWebIndexTemplate(): { path: string; html: string } | null {
  for (const candidate of webIndexCandidates()) {
    try {
      if (existsSync(candidate)) {
        return { path: candidate, html: readFileSync(candidate, "utf8") };
      }
    } catch {
      // 读不到就当不存在，继续下一个候选路径
    }
  }
  return null;
}

/** 开发服务器地址（无构建产物时用于跳转；可用 WEB_DEV_ORIGIN 覆盖） */
export function devOrigin(): string {
  const configured = process.env.WEB_DEV_ORIGIN?.trim();
  return configured !== undefined && configured !== "" ? configured.replace(/\/+$/u, "") : DEFAULT_DEV_ORIGIN;
}

/** 分享页最终 HTML：有模板则注入 meta，无模板则返回跳转壳 */
export function renderShareHtml(og: ShareOgData, tripId: string): string {
  const template = loadWebIndexTemplate();
  if (template !== null) return injectOgIntoHtml(template.html, og);
  return renderOgShell(og, `${devOrigin()}/share/${encodeURIComponent(tripId)}`);
}

/**
 * 行程不存在 / 读取失败时的 HTML：有构建产物时仍返回 SPA 模板（浏览器留在应用内看
 * 已有的「这份行程可能已被删除」状态，不断裂体验），但标 noindex 且不输出任何 OG ——
 * 避免把错误页当成行程预览发给朋友；无构建产物时退回静态错误页。
 */
export function renderShareUnavailableHtml(message: string): string {
  const template = loadWebIndexTemplate();
  if (template === null) return renderShareErrorHtml(message);
  return injectHead(template.html, `${message} · ${OG_SITE_NAME}`, `    <meta name="robots" content="noindex" />`);
}

/**
 * 请求的外部地址（`https://host`）：优先反代头（nginx / 网关），其次 Host。
 * 社交平台要求 og:url / og:image 是绝对地址，因此必须按请求推导而不是写死。
 */
export function requestOrigin(headers: Headers, fallbackHost = "localhost:8787"): string {
  const proto = (headers.get("x-forwarded-proto") ?? "").split(",")[0]?.trim() || "http";
  const host =
    (headers.get("x-forwarded-host") ?? "").split(",")[0]?.trim() ||
    (headers.get("host") ?? "").trim() ||
    fallbackHost;
  return `${proto === "https" ? "https" : "http"}://${host}`;
}
