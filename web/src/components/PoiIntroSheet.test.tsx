/**
 * Task #372：景点介绍应用内浮层（PoiIntroSheet）单测。
 * 覆盖：portal 到 .app 根、挂载广播 "poiIntro" + 收到他 kind 自关（互斥）、
 * Esc / 遮罩 / ✕ 关闭、空文本不渲染（空浮层守卫）、副标题来源标注（fliggy vs custom）。
 * 骨架复刻 EvidenceSheet / TripCoverSheet，断言范式对齐 TripCoverSheet.test。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { notifySheetOpened, onSheetOpened } from "../lib/sheetBus";
import PoiIntroSheet from "./PoiIntroSheet";

/** 浮层经 anchorRef.closest(".app") portal，故包一层 .app 容器 */
function renderSheet(props: Partial<ComponentProps<typeof PoiIntroSheet>> = {}) {
  const onClose = props.onClose ?? vi.fn();
  const view = render(
    <div className="app">
      <PoiIntroSheet name="椰梦长廊" text="椰梦长廊适合傍晚骑行看日落。" onClose={onClose} {...props} />
    </div>,
  );
  return { ...view, onClose };
}

afterEach(() => {
  cleanup();
});

describe("PoiIntroSheet 景点介绍浮层（Task #372）", () => {
  it("标题「景点介绍」+ 正文（复用 .poi-desc-body）+ 关闭入口，portal 到 .app 内", () => {
    const { container } = renderSheet();
    const app = container.querySelector(".app") as HTMLElement;

    expect(screen.getByRole("dialog", { name: "景点介绍" })).toBeInTheDocument();
    expect(screen.getByText("景点介绍")).toBeInTheDocument();
    // 正文落在 .poi-desc-body（不嵌 PoiDescription 组件，只复用样式类）
    const body = app.querySelector(".poi-desc-body");
    expect(body?.textContent).toBe("椰梦长廊适合傍晚骑行看日落。");
    // sheet/backdrop A 族结构在位
    expect(app.querySelector(".sheet.on")).not.toBeNull();
    expect(app.querySelector(".backdrop.on")).not.toBeNull();
    expect(screen.getByRole("button", { name: "关闭景点介绍" })).toBeInTheDocument();
  });

  it("fliggy 来源副标题标注「介绍来自飞猪」，custom 省略后半", () => {
    const { unmount } = renderSheet({ name: "天涯海角", origin: "fliggy" });
    expect(screen.getByText("天涯海角 · 介绍来自飞猪")).toBeInTheDocument();
    unmount();

    renderSheet({ name: "后海村", origin: "custom" });
    expect(screen.getByText("后海村")).toBeInTheDocument();
    expect(screen.queryByText(/介绍来自飞猪/)).toBeNull();
  });

  it("空浮层守卫：text 为空白 / 空串时整层不渲染", () => {
    const { container } = render(
      <div className="app">
        <PoiIntroSheet name="国际免税城" text="   " onClose={vi.fn()} />
      </div>,
    );
    expect(container.querySelector(".sheet")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("点 ✕ 关闭", () => {
    const { onClose } = renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "关闭景点介绍" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("点遮罩关闭", () => {
    const { container, onClose } = renderSheet();
    fireEvent.click(container.querySelector(".backdrop.on") as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc 关闭", () => {
    const { onClose } = renderSheet();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("挂载即广播 poiIntro；其他浮层打开时自关（互斥）", () => {
    const seen: string[] = [];
    const off = onSheetOpened((kind) => seen.push(kind));
    const { onClose } = renderSheet();

    expect(seen).toContain("poiIntro");
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      notifySheetOpened("oplog");
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    off();
  });
});
