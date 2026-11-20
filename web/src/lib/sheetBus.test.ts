import { describe, expect, it, vi } from "vitest";
import { notifySheetOpened, onSheetOpened } from "./sheetBus";

describe("sheetBus 浮层互斥事件总线", () => {
  it("notifySheetOpened 广播 kind，订阅者按序收到", () => {
    const seen: string[] = [];
    const off = onSheetOpened((kind) => seen.push(kind));
    notifySheetOpened("evidence");
    notifySheetOpened("oplog");
    expect(seen).toEqual(["evidence", "oplog"]);
    off();
  });

  it("取消订阅后不再收到广播", () => {
    const handler = vi.fn();
    const off = onSheetOpened(handler);
    off();
    notifySheetOpened("oplog");
    expect(handler).not.toHaveBeenCalled();
  });

  it("poiIntro kind（Task #372 景点介绍浮层）可广播并被订阅者收到", () => {
    const seen: string[] = [];
    const off = onSheetOpened((kind) => seen.push(kind));
    notifySheetOpened("poiIntro");
    expect(seen).toEqual(["poiIntro"]);
    off();
  });
});
