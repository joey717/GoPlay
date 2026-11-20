/**
 * Task #304：小红书链接识别与归一化（@goplay/shared findXhsLink / normalizeXhsLinkInput）。
 *
 * 根因回归：小红书 App「复制链接」给出无 scheme 形态
 * （`xiaohongshu.com/discovery/item/{id}?…`），旧识别正则要求 `https?://` 前缀，
 * 导致 PD 粘贴被整段降级为文字来源（原文浮层显示 URL 字符串本身、无图片抓取）。
 * 本套件以 PD 现场原文形态为夹具，覆盖：无 scheme 识别、带 scheme 回归、
 * 普通文字 / 纯数字 / 伪造域名不误判、归一化只补 scheme 不改写域名路径。
 */
import { describe, expect, it } from "vitest";
import { findXhsLink, normalizeXhsLinkInput } from "@goplay/shared";

/** PD 现场粘贴原文（来源1，无 scheme，App「复制链接」产物；#385 打码：token/shareRedId 已 REDACTED，断言只依赖链接形态不依赖真值） */
const PD_BARE_URL =
  "xiaohongshu.com/discovery/item/6ace31c6000000001b0202f7?app_platform=ios&app_version=9.52&share_from_user_hidden=true&xsec_source=app_share&type=normal&xsec_token=REDACTED_NOTE_A=&author_share=1&xhsshare=CopyLink&shareRedId=REDACTED=&apptime=17933";

describe("findXhsLink：无 scheme 形态识别（Task #304 根因）", () => {
  it("PD 现场原文：识别命中并归一化补 https://，raw 保持原文子串", () => {
    const found = findXhsLink(PD_BARE_URL);
    expect(found).not.toBeNull();
    expect(found!.raw).toBe(PD_BARE_URL);
    expect(found!.url).toBe(`https://${PD_BARE_URL}`);
  });

  it("分享口令 + 无 scheme 链接混排：raw 只含链接，口令不被吞入", () => {
    const found = findXhsLink(`推荐看这篇 xiaohongshu.com/explore/6a93bde9000000002600105b?xsec_token=ABC123= 攻略`);
    expect(found).not.toBeNull();
    expect(found!.raw).toBe("xiaohongshu.com/explore/6a93bde9000000002600105b?xsec_token=ABC123=");
    expect(found!.url).toBe("https://xiaohongshu.com/explore/6a93bde9000000002600105b?xsec_token=ABC123=");
  });

  it("xhslink 短链无 scheme 同样命中", () => {
    const found = findXhsLink("xhslink.com/m/AbCdEf");
    expect(found).not.toBeNull();
    expect(found!.url).toBe("https://xhslink.com/m/AbCdEf");
  });

  it("无 scheme 子域形态（www.）命中", () => {
    const found = findXhsLink("www.xiaohongshu.com/discovery/item/6ace31c6");
    expect(found).not.toBeNull();
    expect(found!.url).toBe("https://www.xiaohongshu.com/discovery/item/6ace31c6");
  });

  it("链接尾部粘连中文标点：raw / url 均剔除", () => {
    const found = findXhsLink("看看这篇：xiaohongshu.com/explore/abc123。");
    expect(found).not.toBeNull();
    expect(found!.raw).toBe("xiaohongshu.com/explore/abc123");
    expect(found!.url).toBe("https://xiaohongshu.com/explore/abc123");
  });
});

describe("findXhsLink：带 scheme 形态回归（既有口径不变）", () => {
  it("https 长链原样识别，url 不加前缀", () => {
    const url = "https://www.xiaohongshu.com/explore/6a93bde9?xsec_token=XYZ=";
    const found = findXhsLink(url);
    expect(found).not.toBeNull();
    expect(found!.raw).toBe(url);
    expect(found!.url).toBe(url);
  });

  it("http 短链识别（保持 http，不改写协议）", () => {
    const found = findXhsLink("http://xhslink.com/m/AbCdEf");
    expect(found).not.toBeNull();
    expect(found!.url).toBe("http://xhslink.com/m/AbCdEf");
  });

  it("完整分享文案（口令 + https 链接）：只取链接", () => {
    const found = findXhsLink(
      "68 亚龙湾热带天堂森林公园 https://www.xiaohongshu.com/explore/6a93bde9?xsec_token=ABC= 复制本条信息打开小红书",
    );
    expect(found).not.toBeNull();
    expect(found!.url).toBe("https://www.xiaohongshu.com/explore/6a93bde9?xsec_token=ABC=");
  });
});

describe("findXhsLink：防误判（普通文字 / 纯数字 / 伪造域名不命中）", () => {
  it.each([
    ["普通中文攻略文字", "三亚五天四晚攻略：第一天亚龙湾沙滩，第二天蜈支洲岛潜水"],
    ["纯数字", "20261102666"],
    ["含域名字样但无路径", "我在xiaohongshu.com看到一篇不错的攻略"],
    ["伪造后缀域名", "notxiaohongshu.com/discovery/item/abc"],
    ["伪造前缀域名", "xiaohongshu.com.evil.io/explore/abc"],
    ["其他站点链接", "https://example.com/xiaohongshu.com/explore/abc"],
    ["空串与空白", "   "],
  ])("%s → null", (_label, value) => {
    expect(findXhsLink(value)).toBeNull();
  });

  it("短中文景点名（快速搜索语料）不命中", () => {
    expect(findXhsLink("亚龙湾热带天堂森林公园")).toBeNull();
  });
});

describe("normalizeXhsLinkInput：server 分流兜底归一化", () => {
  it("无 scheme 整串链接：补 https://", () => {
    expect(normalizeXhsLinkInput(PD_BARE_URL)).toBe(`https://${PD_BARE_URL}`);
    expect(normalizeXhsLinkInput(`  ${PD_BARE_URL}  `)).toBe(`https://${PD_BARE_URL}`);
  });

  it("带 scheme 整串链接：trim 后原样", () => {
    const url = "https://www.xiaohongshu.com/explore/6a93bde9?xsec_token=XYZ=";
    expect(normalizeXhsLinkInput(` ${url} `)).toBe(url);
  });

  it("非链接形态原样返回（由 isXhsUrl 校验报 LINK_INVALID，识别放宽 ≠ 校验放宽）", () => {
    expect(normalizeXhsLinkInput("三亚攻略")).toBe("三亚攻略");
    expect(normalizeXhsLinkInput("notxiaohongshu.com/abc")).toBe("notxiaohongshu.com/abc");
    expect(normalizeXhsLinkInput("")).toBe("");
  });

  it("口令 + 链接混排串不改写（只有整串是链接才归一化）", () => {
    const mixed = "推荐看这篇 xiaohongshu.com/explore/abc123";
    expect(normalizeXhsLinkInput(mixed)).toBe(mixed);
  });
});
