import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { normalizePoiLevel } from "@goplay/shared";
import { PoiDescription, PoiLevelTag, PoiRankChip } from "./PoiMeta";

afterEach(cleanup);

/**
 * Task #330：飞猪 POI 元信息展示组件的展示口径单测。
 * 三个组件共用「有则显示、无则完全不占位」原则——数据缺失 / 无法识别时返回 null，
 * 不产生空白行、不渲染 null 文本、不输出原始脏值。
 */

// ===== poiLevel → 4A/5A 徽标 =====

describe("PoiLevelTag 等级徽标（任务 330）", () => {
  it("归一化对照表：4/5/4A/5A/AAAA/AAAAA 及带修饰文案 → 4A/5A", () => {
    const cases: Array<[string, "4A" | "5A"]> = [
      ["4", "4A"],
      ["4A", "4A"],
      ["4a", "4A"],
      ["AAAA", "4A"],
      ["4A级景区", "4A"],
      ["国家4A级旅游景区", "4A"],
      ["5", "5A"],
      ["5A", "5A"],
      ["AAAAA", "5A"],
      ["国家5A级旅游景区", "5A"],
    ];
    for (const [raw, label] of cases) {
      expect(normalizePoiLevel(raw)).toBe(label);
    }
  });

  it("无法识别的形态归一化为 null（3A/AAA/6A/空/脏值），绝不渲染原始脏值", () => {
    for (const raw of ["3", "3A", "AAA", "AAAAAA", "2A", "", "   ", "无等级", "未知"]) {
      expect(normalizePoiLevel(raw)).toBeNull();
    }
    expect(normalizePoiLevel(null)).toBeNull();
    expect(normalizePoiLevel(undefined)).toBeNull();
  });

  it("4A：渲染 .tag.poi-level 徽标，文本为归一化后的「4A」，带 title 说明", () => {
    render(<PoiLevelTag level="4" />);
    const tag = document.querySelector(".tag.poi-level");
    expect(tag).not.toBeNull();
    expect(tag?.textContent).toBe("4A");
    expect(tag?.getAttribute("title")).toBe("飞猪景点等级 4A");
  });

  it("5A：AAAAA 形态渲染为「5A」（不输出原始 AAAAA）", () => {
    render(<PoiLevelTag level="AAAAA" />);
    expect(document.querySelector(".tag.poi-level")?.textContent).toBe("5A");
    expect(screen.queryByText("AAAAA")).toBeNull();
  });

  it("无法识别 / 缺失：整个徽标不渲染（不占位、不输出脏值）", () => {
    for (const level of ["3A", "", null, undefined]) {
      cleanup();
      render(<PoiLevelTag level={level} />);
      expect(document.querySelector(".poi-level")).toBeNull();
    }
  });

  it('variant="quick"：复用 .quick-result-cat 体系（NoteInput 快速搜索卡字号）', () => {
    render(<PoiLevelTag level="5" variant="quick" />);
    const tag = document.querySelector(".quick-result-cat.poi-level");
    expect(tag).not.toBeNull();
    expect(tag?.textContent).toBe("5A");
    // 不应同时带 .tag（两套体系互斥）
    expect(tag?.classList.contains("tag")).toBe(false);
  });
});

// ===== listRank → 榜单行 =====

describe("PoiRankChip 榜单行（任务 330）", () => {
  it("有值：渲染 .poi-rank 暖色 chip，含 🏆 图标 + 榜单文本，title 保留全文", () => {
    render(<PoiRankChip rank="海南4A/5A景点榜第2名" />);
    const chip = document.querySelector(".poi-rank");
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute("title")).toBe("海南4A/5A景点榜第2名");
    expect(chip?.querySelector(".poi-rank-icon")?.textContent).toBe("🏆");
    expect(chip?.querySelector(".poi-rank-text")?.textContent).toBe("海南4A/5A景点榜第2名");
  });

  it("首尾空白被 trim（不产生多余空格文本）", () => {
    render(<PoiRankChip rank="  海南4A/5A景点榜第2名  " />);
    expect(document.querySelector(".poi-rank-text")?.textContent).toBe("海南4A/5A景点榜第2名");
  });

  it("缺失 / 空 / 纯空白：完全不渲染（不产生空 chip、不渲染 null 文本）", () => {
    for (const rank of [null, undefined, "", "   "]) {
      cleanup();
      render(<PoiRankChip rank={rank} />);
      expect(document.querySelector(".poi-rank")).toBeNull();
      expect(screen.queryByText("🏆")).toBeNull();
    }
  });

  it("根节点为 span（可安全嵌入 NoteInput 的 <button> 内，不产生嵌套 button）", () => {
    render(<PoiRankChip rank="某榜第1名" />);
    expect(document.querySelector(".poi-rank")?.tagName).toBe("SPAN");
  });
});

// ===== description → 介绍折叠区 =====

describe("PoiDescription 介绍折叠区（任务 330）", () => {
  const LONG =
    "西岛门票 98 元，含往返船票。岛上以渔村风情和水上项目为主，适合慢慢逛半天，别赶时间。";

  it("默认收起：渲染「介绍 ▾」弱入口，正文不可见", () => {
    render(<PoiDescription text={LONG} />);
    const toggle = screen.getByRole("button", { name: /介绍/ });
    expect(toggle).toBeInTheDocument();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.querySelector(".poi-desc-arrow")?.textContent).toBe("▾");
    // 长文本默认绝不展开
    expect(document.querySelector(".poi-desc-body")).toBeNull();
    expect(screen.queryByText(LONG)).toBeNull();
  });

  it("点击展开：显示全文，箭头翻转，aria-expanded=true", () => {
    render(<PoiDescription text={LONG} />);
    const toggle = screen.getByRole("button", { name: /介绍/ });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.querySelector(".poi-desc-arrow")?.textContent).toBe("▴");
    expect(document.querySelector(".poi-desc-body")?.textContent).toBe(LONG);
  });

  it("展开后可再次收起（折叠态可逆）", () => {
    render(<PoiDescription text={LONG} />);
    const toggle = screen.getByRole("button", { name: /介绍/ });
    fireEvent.click(toggle);
    expect(document.querySelector(".poi-desc-body")).not.toBeNull();
    fireEvent.click(toggle);
    expect(document.querySelector(".poi-desc-body")).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("正文首尾空白被 trim", () => {
    render(<PoiDescription text={`  ${LONG}  `} />);
    fireEvent.click(screen.getByRole("button", { name: /介绍/ }));
    expect(document.querySelector(".poi-desc-body")?.textContent).toBe(LONG);
  });

  it("空 / 缺失 / 纯空白：整个入口不出现（无「介绍」按钮）", () => {
    for (const text of [null, undefined, "", "   "]) {
      cleanup();
      render(<PoiDescription text={text} />);
      expect(document.querySelector(".poi-desc")).toBeNull();
      expect(screen.queryByRole("button", { name: /介绍/ })).toBeNull();
    }
  });
});
