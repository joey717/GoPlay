import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { OpLogEntry } from "../lib/opLog";
import { onSheetOpened } from "../lib/sheetBus";
import OpLogSheet from "./OpLogSheet";

afterEach(cleanup);

function makeEntry(id: string): OpLogEntry {
  return { id, time: "2026-10-20T08:30:00Z", kind: "add", label: "「潜水体验」", detail: "排入 Day1" };
}

function renderSheet() {
  const onClose = vi.fn();
  const onClear = vi.fn();
  render(<OpLogSheet entries={[makeEntry("op-1")]} onClose={onClose} onClear={onClear} />);
  return { onClose, onClear };
}

describe("OpLogSheet（近期操作，Task #109 互斥改造）", () => {
  it("挂载即打开：sheet/backdrop 直接带 on，无关闭态常驻", () => {
    renderSheet();
    expect(screen.getByRole("dialog", { name: "近期操作" })).toHaveClass("sheet", "on");
    expect(document.querySelector(".backdrop.on")).not.toBeNull();
  });

  it("挂载即广播 oplog 打开事件（供攻略原文 Sheet 让位）", () => {
    const seen: string[] = [];
    const off = onSheetOpened((kind) => seen.push(kind));
    renderSheet();
    expect(seen).toContain("oplog");
    off();
  });

  it("点 × 仅调用 onClose，不触发清空", () => {
    const { onClose, onClear } = renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "关闭近期操作" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClear).not.toHaveBeenCalled();
  });

  it("点遮罩调用 onClose", () => {
    const { onClose } = renderSheet();
    const backdrop = document.querySelector(".backdrop.on");
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
