import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import ImagePlaceholder from "./ImagePlaceholder";

afterEach(cleanup);

describe("ImagePlaceholder 统一无图占位", () => {
  it("按名称分类渲染类别线条图标 + 精简短名（蜈支洲岛 → 海滩类）", () => {
    render(<ImagePlaceholder name="蜈支洲岛旅游区" category={null} />);

    const tile = document.querySelector(".ph-tile.ph-beach");
    expect(tile).not.toBeNull();
    expect(tile?.getAttribute("role")).toBe("img");
    // aria-label / title 保留完整名称；画面只见 4 字短名
    expect(tile?.getAttribute("aria-label")).toBe("暂无图片：蜈支洲岛旅游区（海滩海岛）");
    expect(tile?.getAttribute("title")).toBe("暂无图片 · 蜈支洲岛旅游区");
    // 任务 130：类别图形为 svg 线条图标（不再是单字），装饰性 aria-hidden
    const icon = tile?.querySelector("svg.ph-icon");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(tile?.querySelector(".ph-glyph")).toBeNull();
    expect(screen.getByText("蜈支洲岛")).toBeInTheDocument();
  });

  it("generic 类别（无关键词）渲染地图钉 svg 而非类别图标", () => {
    render(<ImagePlaceholder name="后海村" category={null} />);

    const tile = document.querySelector(".ph-tile.ph-generic");
    expect(tile).not.toBeNull();
    expect(tile?.querySelector("svg.ph-pin")).not.toBeNull();
    expect(tile?.querySelector(".ph-icon")).toBeNull();
    expect(screen.getByText("后海村")).toBeInTheDocument();
  });

  it("category 文本参与分类（美食 → 餐饮线条图标）", () => {
    render(<ImagePlaceholder name="某摊位" category="美食" />);

    const tile = document.querySelector(".ph-tile.ph-dining");
    expect(tile).not.toBeNull();
    expect(tile?.querySelector("svg.ph-icon")).not.toBeNull();
  });

  it("isLargeAttraction 兜底为景点类", () => {
    render(<ImagePlaceholder name="某某胜地" category={null} isLargeAttraction />);

    const tile = document.querySelector(".ph-tile.ph-sight");
    expect(tile).not.toBeNull();
    expect(tile?.querySelector("svg.ph-icon")).not.toBeNull();
  });

  it("六类非通用类别均映射到线条图标（无单字残留）", () => {
    const cases: Array<[string, string | null, string]> = [
      ["林姐香味餐厅", null, "dining"],
      ["海边咖啡馆", null, "coffee"],
      ["蜈支洲岛", null, "beach"],
      ["南山寺", null, "sight"],
      ["三亚国际免税城", null, "shopping"],
      ["凤凰机场", null, "stay"],
    ];
    for (const [name, category, key] of cases) {
      render(<ImagePlaceholder name={name} category={category} />);
      const tile = document.querySelector(`.ph-tile.ph-${key}`);
      expect(tile).not.toBeNull();
      expect(tile?.querySelector("svg.ph-icon")).not.toBeNull();
      expect(tile?.querySelector(".ph-glyph")).toBeNull();
      cleanup();
    }
  });
});
