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
 * Task #264：⋯ 菜单不再单列「复制链接」（与「分享行程」重复），copyText 作为
 * 「分享行程」的桌面主通道 / 系统分享的降级分支使用。
 *
 * Task #401：桌面浏览器（含 macOS Safari / Chrome）同样实现了 navigator.share，
 * 直接调它只会弹出「隔空投送 / 邮件 / 信息」系统面板，用户拿不到可粘贴的链接。
 * 因此新增平台判定：桌面一律默认「复制只读链接」，只有触屏设备才把系统分享
 * 当主通道，且必须同时能复制链接。复制保留 execCommand 回退（非安全上下文 /
 * 权限被拒时仍能写剪贴板）。
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
 * 复制纯文本到剪贴板（Task #261 / #264 / #401）：不唤起系统分享面板。
 *
 * 通道顺序：
 * 1) navigator.clipboard.writeText —— 安全上下文（https / localhost）正常路径；
 * 2) 隐藏 textarea + document.execCommand("copy") —— 非安全上下文、iframe
 *    权限策略或用户拒绝剪贴板权限时仍可用（不依赖异步 API）；
 * 3) 都不可用 → reject，由调用方提示「复制失败，请手动复制」，不静默吞错。
 */
export async function copyText(text: string): Promise<void> {
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (clipboard !== undefined && typeof clipboard.writeText === "function") {
    try {
      await clipboard.writeText(text);
      return;
    } catch {
      // 权限被拒 / 非安全上下文：继续走 execCommand 回退，不直接失败
    }
  }
  if (legacyCopy(text)) return;
  throw new Error("copy-unavailable");
}

/**
 * 隐藏 textarea + execCommand("copy") 回退（Task #401）。
 * 只在同步调用栈内工作（浏览器要求复制动作紧贴用户手势），因此 copyText
 * 先用剪贴板 API 但失败后立即同步重试这条路径。
 * 返回是否复制成功；DOM/execCommand 不可用时返回 false，由调用方给可读提示。
 */
function legacyCopy(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") {
    return false;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  // 固定定位到视口外，避免 iOS 键盘弹起与页面滚动
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.left = "0";
  area.style.opacity = "0";
  document.body.appendChild(area);
  let copied = false;
  try {
    area.select();
    area.setSelectionRange(0, area.value.length);
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    document.body.removeChild(area);
  }
  return copied;
}

/** 是否有 Web Share API（移动端 Safari / Chrome；桌面 Chrome / Safari 也可能有） */
export function canNativeShare(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

/**
 * 是否为触屏 / 移动设备：coarse pointer 或 maxTouchPoints > 0。
 * 桌面（含 macOS Safari 的「支持 Web Share」）判为 false —— 系统分享面板在桌面
 * 只能选隔空投送 / 邮件等应用，拿不到链接文本（Task #401 的根因）。
 */
export function isTouchLike(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  if (typeof navigator.maxTouchPoints === "number" && navigator.maxTouchPoints > 0) return true;
  if (typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

/**
 * 分享默认通道（Task #401）：只有触屏设备且有 Web Share 才默认弹系统面板，
 * 其余情况（桌面 / 无 Web Share）一律默认复制只读链接。
 */
export function prefersNativeShare(): boolean {
  return isTouchLike() && canNativeShare();
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
  try {
    await copyText(lines.join("\n"));
    return "clipboard";
  } catch {
    throw new Error("share-unavailable");
  }
}
