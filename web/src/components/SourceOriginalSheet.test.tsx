/**
 * 任务 186：SourceOriginalSheet 来源原文查看层测试。
 *
 * 重点覆盖：
 * - 文本原文渲染（完整文本可见，不混入结构化摘要）；
 * - 多图按上传顺序渲染（N/M 说明与 aria-label），单图同样正常；
 * - 点击缩略图进入 .evidence-zoom 全屏回看，可关闭；
 * - 关闭按钮与 backdrop 点击回调 onClose；
 * - 外部来源链接作为次要信息渲染。
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { GuideSource } from "@goplay/shared";
import type { SourceOriginal } from "../lib/sourceOriginal";
import SourceOriginalSheet from "./SourceOriginalSheet";

function makeSource(): GuideSource {
  return {
    sourceId: "src_1",
    sourceVersion: 1,
    inputKind: "text",
    active: true,
    status: "ready",
    evidenceRefs: [],
    mentionRefs: [],
    imageProgress: { total: 0, completed: 0, failed: 0, images: [] },
    importedAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
  };
}

function makeOriginal(overrides: Partial<SourceOriginal> = {}): SourceOriginal {
  return { text: null, images: [], externalUrl: null, ...overrides };
}

function renderSheet(original: SourceOriginal, onClose = vi.fn()) {
  return render(
    <SourceOriginalSheet source={makeSource()} original={original} onClose={onClose} />,
  );
}

describe("SourceOriginalSheet（任务 186）", () => {
  it("文本原文完整渲染（含换行），且不含结构化摘要内容", () => {
    const { container } = renderSheet(makeOriginal({ text: "第一天 亚龙湾\n第二天 蜈支洲岛" }));
    expect(screen.getByRole("dialog", { name: "来源原文" })).not.toBeNull();
    // getByText 默认折叠空白，改用 textContent 验证换行原样保留
    const textEl = container.querySelector(".source-original-text");
    expect(textEl?.textContent).toBe("第一天 亚龙湾\n第二天 蜈支洲岛");
  });

  it("多图按上传顺序渲染：N/M 说明与逐张 aria-label", () => {
    renderSheet(
      makeOriginal({
        images: [
          { index: 2, path: "uploads/trip-test/ev_shot_b.png" },
          { index: 4, path: "uploads/trip-test/ev_shot_d.png" },
        ],
      }),
    );
    expect(screen.getByText("截图 1/2")).not.toBeNull();
    expect(screen.getByText("截图 2/2")).not.toBeNull();
    expect(screen.getByLabelText("查看第 2 张截图原图")).not.toBeNull();
    expect(screen.getByLabelText("查看第 4 张截图原图")).not.toBeNull();
    // alt 按 index 标注
    expect(screen.getByAltText("攻略截图 2").getAttribute("src")).toBe(
      "/api/uploads/trip-test/ev_shot_b.png",
    );
  });

  it("单图正常渲染，无 N/M 序号歧义", () => {
    renderSheet(makeOriginal({ images: [{ index: 1, path: "uploads/trip-test/ev_shot_a.png" }] }));
    expect(screen.getByText("截图 1/1")).not.toBeNull();
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  it("点击缩略图进入全屏回看，点关闭按钮退出", () => {
    renderSheet(makeOriginal({ images: [{ index: 1, path: "uploads/trip-test/ev_shot_a.png" }] }));
    expect(screen.queryByLabelText("攻略截图原图")).toBeNull();
    fireEvent.click(screen.getByLabelText("查看第 1 张截图原图"));
    const zoom = screen.getByLabelText("攻略截图原图");
    expect(zoom.className).toContain("evidence-zoom");
    fireEvent.click(screen.getByLabelText("关闭原图"));
    expect(screen.queryByLabelText("攻略截图原图")).toBeNull();
  });

  it("外部来源链接渲染为次要信息 <a>", () => {
    renderSheet(makeOriginal({ externalUrl: "https://example.com/note" }));
    const link = screen.getByText("https://example.com/note");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("https://example.com/note");
  });

  it("✕ 关闭按钮与 backdrop 点击都回调 onClose", () => {
    const onClose = vi.fn();
    const { container } = renderSheet(makeOriginal({ text: "原文" }), onClose);
    fireEvent.click(screen.getByLabelText("关闭原文"));
    expect(onClose).toHaveBeenCalledTimes(1);
    const backdrop = container.querySelector(".source-original-backdrop");
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop as Element);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
