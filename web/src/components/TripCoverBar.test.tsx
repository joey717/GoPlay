/**
 * Task #258：行程封面紧凑入口（TripCoverBar）单测。
 * 口径——顶部只占一行：缩略图 + 行程名 + 城市·N天N晚 + 展开箭头，点击拉起浮层。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TripCoverInfo } from "../lib/tripCover";
import { tripCoverInfo } from "../lib/tripCover";
import TripCoverBar from "./TripCoverBar";

afterEach(cleanup);

function makeInfo(overrides: Partial<TripCoverInfo> = {}): TripCoverInfo {
  return {
    ...tripCoverInfo({
      destination: { city: "三亚" },
      dateRange: { start: "2026-11-08", end: "2026-11-10", nights: 2 },
      dayRefs: [],
      days: {},
      version: 4,
    }),
    ...overrides,
  };
}

describe("TripCoverBar 紧凑入口", () => {
  it("一行展示行程名与城市·天数，无封面时用渐变缩略块兜底", () => {
    const { container } = render(<TripCoverBar info={makeInfo()} onOpen={vi.fn()} />);

    expect(screen.getByText("我的行程")).toBeInTheDocument();
    expect(screen.getByText("三亚 · 3天2晚")).toBeInTheDocument();
    expect(container.querySelector(".cover-bar-wash")).not.toBeNull();
    expect(container.querySelector(".cover-bar-thumb img")).toBeNull();
    // 有封面时才有图片；入口本身不含任何输入控件
    expect(container.querySelectorAll("input, textarea, select")).toHaveLength(0);
  });

  it("有封面时缩略图走受控路径 + 版本号（revision 击穿同路径缓存）", () => {
    const { container, rerender } = render(
      <TripCoverBar
        info={makeInfo({ coverImage: "uploads/trip-c/cover.jpg", coverVersion: 9 })}
        onOpen={vi.fn()}
      />,
    );

    const img = () => container.querySelector(".cover-bar-thumb img");
    expect(img()?.getAttribute("src")).toBe("/api/uploads/trip-c/cover.jpg?v=9");
    expect(container.querySelector(".cover-bar-wash")).toBeNull();

    rerender(
      <TripCoverBar
        info={makeInfo({ coverImage: "uploads/trip-c/cover.jpg", coverVersion: 9 })}
        revision={2}
        onOpen={vi.fn()}
      />,
    );
    expect(img()?.getAttribute("src")).toBe("/api/uploads/trip-c/cover.jpg?v=9-2");
  });

  it("点击整行打开浮层，aria-expanded 跟随浮层开关", () => {
    const onOpen = vi.fn();
    const { rerender } = render(<TripCoverBar info={makeInfo()} onOpen={onOpen} />);
    const bar = screen.getByRole("button", { name: /行程封面：我的行程/ });

    expect(bar).toHaveAttribute("aria-haspopup", "dialog");
    expect(bar).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(bar);
    expect(onOpen).toHaveBeenCalledTimes(1);

    rerender(<TripCoverBar info={makeInfo()} expanded onOpen={onOpen} />);
    expect(screen.getByRole("button", { name: /行程封面/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("有备忘时给一个轻量标记，名称随 Trip 变化实时更新（只读同理）", () => {
    const { rerender } = render(
      <TripCoverBar
        info={makeInfo({ memo: "带证件", hasMemo: true })}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText("备忘")).toBeInTheDocument();

    rerender(
      <TripCoverBar
        info={makeInfo({ tripName: "三亚亲子五日", isDefaultName: false })}
        readOnly
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText("三亚亲子五日")).toBeInTheDocument();
    expect(screen.queryByText("备忘")).toBeNull();
    // 只读入口同样可打开（只是浮层内没有编辑能力）
    expect(screen.getByRole("button", { name: /行程封面：三亚亲子五日/ })).toBeInTheDocument();
  });
});
