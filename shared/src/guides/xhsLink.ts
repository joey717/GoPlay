/**
 * 小红书链接识别与归一化（Task #304）——web 提交分流与 server link 校验共用的
 * 纯函数口径，两侧不再各自维护正则。
 *
 * 背景：小红书 App「复制链接」在部分版本给出**无 scheme** 形态
 * （`xiaohongshu.com/discovery/item/{id}?xsec_token=…`）。旧前端识别正则要求
 * `https?://` 前缀，无 scheme 粘贴被整段当成文字来源提交（原文浮层显示 URL
 * 字符串本身、无图片抓取）。本模块把「无 scheme 但形如 域名/路径」的粘贴
 * 归一化补 `https://` 后走链接链路。
 *
 * 边界（与 guides/index.ts 同规约）：纯函数、只读，不做展开 / 抓取 / 校验
 * 笔记页路径（服务端 isXhsUrl / extractXhsNote 仍按域名白名单与路径规则把关，
 * 归一化只补 scheme，绝不改写域名与路径）。
 */

/** 带 scheme 的小红书链接（既有口径：xhslink 短链与 xiaohongshu.com 长链。
 *  Task #394：小红书 App 现行分享口令的短链域名为 `xhslink.cn`（.cn 后缀），
 *  旧口径只认 `.com` 导致口令里的 .cn 短链识别失败、整段被当纯文本提交
 *  （链接链路不启动 → 图片不抓取 → 移动端看不到「解析图片」入口）。 */
const XHS_SCHEMED_PATTERN =
  /https?:\/\/(?:[a-z0-9-]+\.)*(?:xiaohongshu\.com|xhslink\.(?:com|cn))\/[^\s"'<>]*/i;

/**
 * 无 scheme 形态（Task #304）：行首或分隔符后的 `xiaohongshu.com/…`、`xhslink.com/…`、
 * `xhslink.cn/…`（Task #394 补 .cn 短链域名）。
 * 防误判设计：
 * - 前界负向断言 `(?<![a-zA-Z0-9._:/?=&-])`：域名不得紧跟字母 / 数字 / 点 / 冒号 /
 *   斜杠 / 查询分隔符——`notxiaohongshu.com/…`（伪造后缀域）、
 *   `http://xiaohongshu.com`（冒号——由带 scheme 分支处理）、
 *   `https://example.com/xiaohongshu.com/…`（其他站点 URL 的内嵌路径 / 参数）
 *   都不会从无 scheme 分支命中；中文与前导空白不受影响；
 * - 域名后必须跟 `/路径`：纯域名提及（"我在xiaohongshu.com看到"无路径）不命中；
 * - 域名后缀负向断言 `(?![a-zA-Z0-9-]|\.(?=[a-zA-Z0-9-]))`：白名单域名后不得继续
 *   接域名字符或「点 + 域名字符」，`xiaohongshu.com.evil.io/…`（伪造后缀域）不命中；
 *   路径 / 查询里合法出现的 `.`（后随 `=`、`/` 等）不受影响；
 * - 子域仅允许 `[a-z0-9-]+.` 标签（www. / 任意子域），不吞前缀字符。
 */
const XHS_BARE_PATTERN =
  /(?<![a-zA-Z0-9._:/?=&-])(?:[a-z0-9-]+\.)*(?:xiaohongshu\.com|xhslink\.(?:com|cn))(?![a-zA-Z0-9-]|\.(?=[a-zA-Z0-9-]))\/[^\s"'<>]*/i;

/** 链接尾部可能粘连的中文标点（分享文案常见「…链接。」收尾） */
const TRAILING_CJK_PUNCTUATION = /[，。！？、）】》]+$/u;

/** 识别结果：raw 为原文中被识别的子串（剔除用），url 为归一化补 scheme 后的链接（提交用） */
export interface XhsLinkMatch {
  /** 原文中命中的子串（已剔除尾部中文标点）：调用方按原文剔除时须用本字段而非 url */
  raw: string;
  /** 归一化链接：无 scheme 形态补 `https://`，其余保持原样 */
  url: string;
}

/**
 * 在任意文本中识别第一个小红书链接（带 scheme 优先，其次无 scheme 形态）。
 * 未命中返回 null；普通中文文字、纯数字不含域名 + 路径，不会命中。
 */
export function findXhsLink(value: string): XhsLinkMatch | null {
  if (typeof value !== "string" || value === "") return null;
  const match = XHS_SCHEMED_PATTERN.exec(value) ?? XHS_BARE_PATTERN.exec(value);
  if (match === null) return null;
  const raw = match[0].replace(TRAILING_CJK_PUNCTUATION, "");
  if (raw === "") return null;
  return { raw, url: /^https?:\/\//i.test(raw) ? raw : `https://${raw}` };
}

/**
 * 无 scheme 链接归一化（server 分流兜底）：整串是「域名/路径」形态的小红书链接
 * 则补 `https://`；已带 scheme 原样返回（trim）；不是链接形态原样返回（trim），
 * 交由上层 isXhsUrl 校验报告 LINK_INVALID——识别放宽不等于校验放宽。
 */
export function normalizeXhsLinkInput(raw: string): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed === "") return trimmed;
  const found = findXhsLink(trimmed);
  // 整串就是链接本身才归一化，避免把「口令 + 链接」混排串改写
  if (found !== null && found.raw === trimmed) return found.url;
  return trimmed;
}
