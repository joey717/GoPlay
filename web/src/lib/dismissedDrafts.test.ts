import { afterEach, describe, expect, it } from "vitest";
import { loadDismissedDraftIds, saveDismissedDraftIds } from "./dismissedDrafts";

const KEY = "goplay.dismissedDraftIds";

afterEach(() => {
  localStorage.removeItem(KEY);
});

describe("dismissedDrafts（任务 #211：已关闭草案跨刷新持久化）", () => {
  it("无记录时返回空集；save 后 load 回读一致", () => {
    expect(loadDismissedDraftIds().size).toBe(0);
    saveDismissedDraftIds(new Set(["draft-a", "draft-b"]));
    expect([...loadDismissedDraftIds()].sort()).toEqual(["draft-a", "draft-b"]);
  });

  it("损坏 JSON / 非数组 / 非字符串元素：静默退化为空集或过滤坏元素", () => {
    localStorage.setItem(KEY, "{not-json");
    expect(loadDismissedDraftIds().size).toBe(0);

    localStorage.setItem(KEY, JSON.stringify({ x: 1 }));
    expect(loadDismissedDraftIds().size).toBe(0);

    localStorage.setItem(KEY, JSON.stringify(["draft-ok", 42, null]));
    expect([...loadDismissedDraftIds()]).toEqual(["draft-ok"]);
  });

  it("超出 50 条上限：写入时保留最近的记录（FIFO 裁剪）", () => {
    const ids = new Set(Array.from({ length: 60 }, (_, index) => `draft-${index}`));
    saveDismissedDraftIds(ids);
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as string[];
    expect(raw.length).toBe(50);
    expect(raw[raw.length - 1]).toBe("draft-59");
    expect(loadDismissedDraftIds().has("draft-10")).toBe(true);
    expect(loadDismissedDraftIds().has("draft-0")).toBe(false);
  });
});
