/**
 * Task #262：粘贴文字攻略的默认标题（纯函数层测试，离线）。
 *
 * 覆盖（对应任务验收口径）：
 * - 长正文：取前 GUIDE_SOURCE_TEXT_TITLE_CHARS 个字并以「…」收尾；
 * - 短正文：标题就是完整正文，不加省略号；
 * - 首尾空白 / 换行：标题单行（内部换行压成单空格），且不出现「 …」；
 * - 空白正文：兜底 GUIDE_SOURCE_TEXT_TITLE_FALLBACK；
 * - 码点安全：emoji 不会被截成半个；
 * - 自定义上限：maxChars 生效，非法上限回退默认值。
 */
import { describe, expect, it } from "vitest";
import {
  deriveTextSourceTitle,
  GUIDE_SOURCE_TEXT_TITLE_CHARS,
  GUIDE_SOURCE_TEXT_TITLE_FALLBACK,
} from "@goplay/shared";

describe("deriveTextSourceTitle（Task #262）", () => {
  it("长正文：前 N 个字 + 省略号", () => {
    const longText =
      "第一天下机直奔亚龙湾，第二天早起去蜈支洲岛，记得提前订船票，下午去观日岩看海。";
    const title = deriveTextSourceTitle(longText);
    expect(title.endsWith("…")).toBe(true);
    expect(Array.from(title).length).toBe(GUIDE_SOURCE_TEXT_TITLE_CHARS + 1);
    expect(title).toBe(`${Array.from(longText).slice(0, GUIDE_SOURCE_TEXT_TITLE_CHARS).join("")}…`);
  });

  it("短正文：完整正文，不加省略号", () => {
    expect(deriveTextSourceTitle("后海村冲浪小店清单")).toBe("后海村冲浪小店清单");
    // 恰好等于上限也不截断
    const exact = "三".repeat(GUIDE_SOURCE_TEXT_TITLE_CHARS);
    expect(deriveTextSourceTitle(exact)).toBe(exact);
  });

  it("首尾空白与换行：去掉首尾、压成单空格，标题单行", () => {
    const title = deriveTextSourceTitle("\n  三亚亲子五日游\n\n带娃必看  \n");
    expect(title).toBe("三亚亲子五日游 带娃必看");
    expect(title.includes("\n")).toBe(false);
  });

  it("截断点落在空格：省略号前不留空白", () => {
    // 第 20 个字恰好是空格：先 trimEnd 再补「…」
    const text = `${"甲".repeat(19)} 乙丙丁`;
    const title = deriveTextSourceTitle(text);
    expect(title).toBe(`${"甲".repeat(19)}…`);
    expect(title.endsWith(" …")).toBe(false);
  });

  it("空白正文：兜底为「粘贴的文字」", () => {
    expect(deriveTextSourceTitle("")).toBe(GUIDE_SOURCE_TEXT_TITLE_FALLBACK);
    expect(deriveTextSourceTitle("   \n\t  ")).toBe(GUIDE_SOURCE_TEXT_TITLE_FALLBACK);
    expect(GUIDE_SOURCE_TEXT_TITLE_FALLBACK).toBe("粘贴的文字");
  });

  it("码点安全：emoji 不被截成半个", () => {
    const text = "🌴".repeat(30);
    const title = deriveTextSourceTitle(text, 3);
    expect(title).toBe("🌴🌴🌴…");
  });

  it("自定义上限生效，非法上限回退默认值", () => {
    expect(deriveTextSourceTitle("一二三四五六七八九十", 5)).toBe("一二三四五…");
    expect(deriveTextSourceTitle("一二三四五六七八九十", 0)).toBe("一二三四五六七八九十");
    expect(deriveTextSourceTitle("一".repeat(30), Number.NaN)).toBe(
      `${"一".repeat(GUIDE_SOURCE_TEXT_TITLE_CHARS)}…`,
    );
  });
});
