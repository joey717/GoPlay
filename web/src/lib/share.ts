/**
 * 卡片分享（任务 220）：点位/酒店卡片的分享图标钮统一走这里。
 *
 * - 有 Web Share API（移动端 Safari/Chrome）→ 系统分享面板；
 * - 无系统分享（桌面浏览器）→ 复制「标题 + 描述 + 链接」到剪贴板；
 * - 用户取消系统分享或环境不支持时 reject，由调用方静默处理（不提示成功）。
 *
 * 文案只来自卡片自身数据（名称/地址/价格/飞猪链接），不经过 AI。
 *
 * Task #261 追加两个入口：
 * - shareUrlFor：只读分享链接（同源 /share/:tripId），复制链接与系统分享共用同一 URL；
 * - copyText：只复制文本、不唤起系统面板。
 *
 * Task #264：⋯ 菜单不再单列「复制链接」（与「分享行程」重复），copyText 只作为
 * 「分享行程」在不支持 Web Share 时的降级分支使用。
 */

export interface SharePayload {
  /** 分享标题：POI / 酒店名称 / 行程名 */
  title: string;
  /** 正文：地址、价格等一行摘要 */
  text: string;
  /** 飞猪详情链接 / 只读分享链接；无外链时为 null */
  url: string | null;
}

/** 分享摘要上限（与 OG og:description 同一口径：备忘前 100 字） */
export const SHARE_DESC_MAX = 100;

/**
 * 只读分享链接：`${origin}/share/${tripId}`。
 * 社交平台的预览信息由服务端 GET /share/:tripId 注入 OG meta（Task #261），
 * 因此这里只拼稳定 URL，不带任何查询参数（避免同一行程出现多个分享地址）。
 */
export function shareUrlFor(tripId: string, origin?: string): string {
  const base = origin ?? (typeof window !== "undefined" ? window.location.origin : "");
  return `${base}/share/${encodeURIComponent(tripId)}`;
}

/**
 * 备忘摘要：连续空白（含换行）压成单空格 → 按 Unicode 码点截断 100 字 → 省略号。
 * 系统分享面板的 text 与 OG 描述都只吃一行摘要，整段备忘要压平。
 */
export function memoExcerpt(memo: string, max: number = SHARE_DESC_MAX): string {
  const text = memo.replace(/\s+/gu, " ").trim();
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max).join("")}…`;
}

/**
 * 复制纯文本到剪贴板（Task #261 / Task #264）：不唤起系统分享面板。
 * 环境不支持（http 页面 / 无 clipboard API）或被用户/浏览器拒绝时 reject，
 * 由调用方提示「复制失败，请手动复制」，不静默吞错。
 */
export async function copyText(text: string): Promise<void> {
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (clipboard === undefined || typeof clipboard.writeText !== "function") {
    throw new Error("clipboard-unavailable");
  }
  await clipboard.writeText(text);
}

export async function shareCard(payload: SharePayload): Promise<void> {
  await shareLink(payload);
}

/** 分享通道：native = 系统分享面板；clipboard = 已复制到剪贴板（调用方提示「链接已复制」） */
export type ShareChannel = "native" | "clipboard";

/** 用户主动取消系统分享（AbortError）：调用方应静默处理，不当成失败提示 */
export function isShareCancelled(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

/**
 * 通用分享（Task #205 分享行程复用）：
 * - 有 Web Share API → 系统面板，返回 "native"；用户取消时原样抛出 AbortError；
 * - 系统分享不可用 / 失败（桌面浏览器实现了但调不起）→ 降级复制链接，返回 "clipboard"；
 * - 两者都不可用 → 抛 share-unavailable，由调用方给出可操作提示。
 * 文案只来自调用方数据，不经过 AI。
 */
export async function shareLink(payload: SharePayload): Promise<ShareChannel> {
  const lines = [payload.title, payload.text, payload.url ?? ""].filter((line) => line !== "");
  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      await navigator.share({
        title: payload.title,
        text: payload.text,
        ...(payload.url !== null && payload.url !== "" ? { url: payload.url } : {}),
      });
      return "native";
    } catch (error) {
      // 取消不降级（用户明确不要分享）；其余失败继续尝试剪贴板
      if (isShareCancelled(error)) throw error;
    }
  }
  if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
    await navigator.clipboard.writeText(lines.join("\n"));
    return "clipboard";
  }
  throw new Error("share-unavailable");
}
