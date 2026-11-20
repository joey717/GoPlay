/**
 * Task #258：行程封面浮层（TripCoverSheet）单测。
 * 口径——封面 / 名称 / 信息行 / 备忘收进浮层；备忘默认展开；
 * 名称与备忘都保持「失焦立即落地 + 1s 静默自动保存」，关闭浮层前冲刷未落地补丁；
 * 只读模式无任何编辑入口。互斥沿用 sheetBus（挂载广播 "cover"）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TripCoverInfo } from "../lib/tripCover";
import { MEMO_MAX, TRIP_NAME_MAX, tripCoverInfo } from "../lib/tripCover";
import { notifySheetOpened, onSheetOpened } from "../lib/sheetBus";
import TripCoverSheet from "./TripCoverSheet";

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

/** 渲染浮层（默认编辑模式），返回 onClose 以便断言关闭链路 */
function renderSheet(props: Partial<ComponentProps<typeof TripCoverSheet>> = {}) {
  const onClose = props.onClose ?? vi.fn();
  const view = render(<TripCoverSheet info={makeInfo()} onClose={onClose} {...props} />);
  return { ...view, onClose };
}

function picFile(name = "cover.png", type = "image/png", size = 1024): File {
  const file = new File(["x"], name, { type });
  // jsdom 的 File.size 由内容长度决定，需要超限场景时用 defineProperty 覆盖
  Object.defineProperty(file, "size", { value: size });
  return file;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("TripCoverSheet 浮层（编辑模式）", () => {
  it("封面 / 名称 / 信息行 / 备忘同屏可见，备忘默认就是可写 textarea", () => {
    const { container } = renderSheet({ info: makeInfo({ memo: "旧备忘", hasMemo: true }) });

    expect(screen.getByRole("dialog", { name: "行程封面" })).toBeInTheDocument();
    // 无封面 → 渐变兜底（不请求任何图片资源）
    expect(container.querySelector(".trip-cover-wash")).not.toBeNull();
    expect(container.querySelector(".trip-cover-img")).toBeNull();
    expect(screen.getByText("三亚 · 3天2晚 · 11/08-11/10")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /行程名称：我的行程/ })).toBeInTheDocument();

    // 备忘默认展开（浮层空间足够），无需再点「展开」
    const memo = screen.getByLabelText("备忘录") as HTMLTextAreaElement;
    expect(memo.value).toBe("旧备忘");
    expect(memo.maxLength).toBe(MEMO_MAX);
    expect(screen.getByText("3/500")).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "添加封面" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "移除封面" })).toBeNull();
    // 浮层自带关闭 / 完成两个出口
    expect(screen.getByRole("button", { name: "关闭封面" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "完成" })).toBeInTheDocument();
  });

  it("有封面时用受控路径 + 版本号击穿缓存，并提供移除入口", () => {
    const onRemoveCover = vi.fn();
    renderSheet({
      info: makeInfo({ coverImage: "uploads/trip-c/cover.jpg", coverVersion: 9 }),
      onRemoveCover,
    });

    const img = screen.getByAltText("我的行程");
    expect(img.getAttribute("src")).toBe("/api/uploads/trip-c/cover.jpg?v=9");
    expect(document.querySelector(".trip-cover-wash")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "移除封面" }));
    expect(onRemoveCover).toHaveBeenCalledTimes(1);
  });

  it("同格式重换封面靠本地版本号击穿缓存（Trip.version 会话内不变）", () => {
    renderSheet({
      info: makeInfo({ coverImage: "uploads/trip-c/cover.jpg", coverVersion: 9 }),
      revision: 2,
      readOnly: true,
    });
    expect(screen.getByAltText("我的行程").getAttribute("src")).toBe(
      "/api/uploads/trip-c/cover.jpg?v=9-2",
    );
  });

  it("选图后回传 onUploadCover，非图片与超限文件给出错误且不上传", () => {
    const onUploadCover = vi.fn();
    renderSheet({ onUploadCover });
    const input = screen.getByLabelText("选择封面图片") as HTMLInputElement;

    const good = picFile();
    fireEvent.change(input, { target: { files: [good] } });
    expect(onUploadCover).toHaveBeenCalledWith(good);

    onUploadCover.mockClear();
    fireEvent.change(input, { target: { files: [picFile("cover.gif", "image/gif")] } });
    expect(onUploadCover).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("请选择 JPG / PNG / WebP 图片");

    fireEvent.change(input, {
      target: { files: [picFile("big.png", "image/png", 9 * 1024 * 1024)] },
    });
    expect(onUploadCover).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("图片不能超过 8MB");
  });

  it("上传中显示「上传中…」并收起更换入口", () => {
    renderSheet({ uploading: true });
    expect(screen.getByRole("status")).toHaveTextContent("上传中…");
    expect(screen.queryByRole("button", { name: "添加封面" })).toBeNull();
  });

  it("点名称改名：失焦立即保存（上限 50 字）", () => {
    const onChange = vi.fn();
    renderSheet({ onChange });

    fireEvent.click(screen.getByRole("button", { name: /行程名称：我的行程/ }));
    const input = screen.getByLabelText("行程名称") as HTMLInputElement;
    expect(input.maxLength).toBe(TRIP_NAME_MAX);
    // 默认名视为空，直接输入即覆盖
    expect(input.value).toBe("");

    fireEvent.change(input, { target: { value: "  三亚亲子五日  " } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ tripName: "三亚亲子五日" });
    // 退出改名态后标题立即显示新名称（不等 Trip 刷新回传）
    expect(screen.getByRole("button", { name: /行程名称：三亚亲子五日/ })).toBeInTheDocument();
    expect(screen.queryByLabelText("行程名称")).toBeNull();
  });

  it("改名输入停顿 1s 自动保存（debounce），回车立即落地", () => {
    const onChange = vi.fn();
    renderSheet({ onChange });

    fireEvent.click(screen.getByRole("button", { name: /行程名称：我的行程/ }));
    const input = screen.getByLabelText("行程名称");
    fireEvent.change(input, { target: { value: "周末逃离" } });

    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onChange).toHaveBeenCalledWith({ tripName: "周末逃离" });

    onChange.mockClear();
    fireEvent.change(input, { target: { value: "周末逃离2" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith({ tripName: "周末逃离2" });
  });

  it("改名态 Esc 只取消本次改名（不关闭浮层），浮层内其他位置 Esc 关闭", () => {
    const onChange = vi.fn();
    const { onClose } = renderSheet({ onChange });

    fireEvent.click(screen.getByRole("button", { name: /行程名称：我的行程/ }));
    const input = screen.getByLabelText("行程名称");
    fireEvent.change(input, { target: { value: "临时名字" } });
    fireEvent.keyDown(input, { key: "Escape" });
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("行程名称")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("备忘失焦立即保存，输入停顿 1s 也会自动保存并实时显示字数", () => {
    const onChange = vi.fn();
    renderSheet({ onChange, info: makeInfo({ memo: "旧备忘", hasMemo: true }) });

    const textarea = screen.getByLabelText("备忘录");
    fireEvent.change(textarea, { target: { value: "新备忘内容" } });
    expect(screen.getByText("5/500")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onChange).toHaveBeenCalledWith({ memo: "新备忘内容" });

    fireEvent.change(textarea, { target: { value: "失焦即保存" } });
    fireEvent.blur(textarea);
    expect(onChange).toHaveBeenLastCalledWith({ memo: "失焦即保存" });
  });

  it("关闭前冲刷未落地的编辑：「完成」先 onChange 再 onClose", () => {
    const onChange = vi.fn();
    const { onClose } = renderSheet({ onChange });

    const textarea = screen.getByLabelText("备忘录");
    fireEvent.change(textarea, { target: { value: "记得带身份证" } });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    expect(onChange).toHaveBeenCalledWith({ memo: "记得带身份证" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("点 ✕ 与点遮罩同样先落地编辑再关闭", () => {
    const onChange = vi.fn();
    const { onClose } = renderSheet({ onChange });

    fireEvent.change(screen.getByLabelText("备忘录"), { target: { value: "A" } });
    fireEvent.click(screen.getByRole("button", { name: "关闭封面" }));
    expect(onChange).toHaveBeenCalledWith({ memo: "A" });
    expect(onClose).toHaveBeenCalledTimes(1);

    onChange.mockClear();
    fireEvent.change(screen.getByLabelText("备忘录"), { target: { value: "B" } });
    fireEvent.click(document.querySelector(".proposal-overlay") as Element);
    expect(onChange).toHaveBeenCalledWith({ memo: "B" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("挂载即广播 cover；其他浮层打开时自关（互斥）", () => {
    const seen: string[] = [];
    const off = onSheetOpened((kind) => seen.push(kind));
    const { onClose } = renderSheet();

    expect(seen).toContain("cover");
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      notifySheetOpened("oplog");
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    off();
  });
});

describe("TripCoverSheet 只读模式（分享访客）", () => {
  it("展示名称 / 信息行 / 备忘全文，但没有上传、改名、备忘输入与移除入口", () => {
    const { container } = render(
      <TripCoverSheet
        info={makeInfo({
          coverImage: "uploads/trip-c/cover.webp",
          coverVersion: 2,
          tripName: "三亚亲子五日",
          isDefaultName: false,
          memo: "带娃节奏放缓",
          hasMemo: true,
        })}
        readOnly
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("三亚亲子五日");
    expect(screen.getByText("三亚 · 3天2晚 · 11/08-11/10")).toBeInTheDocument();
    expect(screen.getByText("带娃节奏放缓")).toBeInTheDocument();

    expect(container.querySelectorAll("input, textarea, select")).toHaveLength(0);
    expect(screen.queryByLabelText("备忘录")).toBeNull();
    expect(screen.queryByRole("button", { name: /行程名称/ })).toBeNull();
    expect(screen.queryByText("添加封面")).toBeNull();
    expect(screen.queryByText("移除封面")).toBeNull();
    expect(screen.queryByRole("button", { name: "完成" })).toBeNull();
    // 只读页不出现「编辑 / 拖拽 / 锁定」类文案；关闭入口仍保留
    expect(screen.queryByText(/编辑|拖拽|锁定/)).toBeNull();
    expect(screen.getByRole("button", { name: "关闭封面" })).toBeInTheDocument();
  });

  it("无备忘时给出空态说明，仍然没有任何输入控件", () => {
    const { container } = render(<TripCoverSheet info={makeInfo()} readOnly onClose={vi.fn()} />);

    expect(screen.getByText("没有写备忘")).toBeInTheDocument();
    expect(container.querySelectorAll("input, textarea, select")).toHaveLength(0);
    // 无封面也保留渐变兜底，浮层不是空白页
    expect(container.querySelector(".trip-cover-wash")).not.toBeNull();
  });
});
