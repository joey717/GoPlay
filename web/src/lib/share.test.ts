/**
 * Task #401：分享链路的纯函数单测（不依赖真实剪贴板 / 系统分享面板）。
 *
 * 覆盖三件事：
 * - 分享 URL 恒为同源绝对地址 `${origin}/share/${tripId}`，与 OG 路由同一个地址；
 * - copyText 的两级通道：clipboard API 优先 → 隐藏 textarea + execCommand 回退 → 都失败才 reject；
 * - 平台判定：桌面（无触屏）即使有 navigator.share 也不默认走系统面板，触屏才走系统分享。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canNativeShare,
  copyText,
  isShareCancelled,
  isTouchLike,
  prefersNativeShare,
  shareUrlFor,
} from "./share";

function setMaxTouchPoints(value: number) {
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value });
}

function setCoarsePointer(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

function setExecCommand(impl: () => boolean) {
  Object.defineProperty(document, "execCommand", { configurable: true, value: impl });
}

beforeEach(() => {
  // jsdom 没有这两个 API，按需在用例里安装
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(navigator, "share");
  Reflect.deleteProperty(navigator, "maxTouchPoints");
  Reflect.deleteProperty(window, "matchMedia");
  Reflect.deleteProperty(document, "execCommand");
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(navigator, "share");
  Reflect.deleteProperty(navigator, "maxTouchPoints");
  Reflect.deleteProperty(window, "matchMedia");
  Reflect.deleteProperty(document, "execCommand");
  vi.restoreAllMocks();
});

describe("shareUrlFor（只读分享地址）", () => {
  it("按 origin 拼绝对地址，路径为 /share/:tripId", () => {
    expect(shareUrlFor("abc-123", "https://goplay.example")).toBe(
      "https://goplay.example/share/abc-123",
    );
  });

  it("不传 origin 时用当前页面 location.origin（localhost 也是合法安全上下文）", () => {
    expect(shareUrlFor("0a27f726-9c93-48e8-ab68-1d62e9bc685b")).toBe(
      `${window.location.origin}/share/0a27f726-9c93-48e8-ab68-1d62e9bc685b`,
    );
  });

  it("tripId 内的特殊字符做 URL 编码，不产生额外查询参数", () => {
    expect(shareUrlFor("a b/c", "https://goplay.example")).toBe(
      "https://goplay.example/share/a%20b%2Fc",
    );
  });
});

describe("copyText（剪贴板两级通道）", () => {
  it("有 clipboard.writeText 时优先用它，不再走 execCommand", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const execCommand = vi.fn(() => true);
    setExecCommand(execCommand);

    await copyText("https://goplay.example/share/abc");

    expect(writeText).toHaveBeenCalledWith("https://goplay.example/share/abc");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("clipboard API 缺失时回退隐藏 textarea + execCommand，且清理临时节点", async () => {
    const execCommand = vi.fn(() => true);
    setExecCommand(execCommand);

    await expect(copyText("hello")).resolves.toBeUndefined();

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.body.querySelector("textarea")).toBeNull();
  });

  it("clipboard 被拒（非安全上下文 / 权限拒绝）时仍尝试 execCommand 回退", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("NotAllowedError");
    });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const execCommand = vi.fn(() => true);
    setExecCommand(execCommand);

    await expect(copyText("hello")).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("两条通道都不可用时 reject 为 copy-unavailable（调用方给可读提示）", async () => {
    await expect(copyText("hello")).rejects.toThrow("copy-unavailable");
  });

  it("execCommand 返回 false 或抛错都算失败，且不留临时 textarea", async () => {
    setExecCommand(() => false);
    await expect(copyText("hello")).rejects.toThrow("copy-unavailable");
    expect(document.body.querySelector("textarea")).toBeNull();

    setExecCommand(() => {
      throw new Error("unsupported");
    });
    await expect(copyText("hello")).rejects.toThrow("copy-unavailable");
    expect(document.body.querySelector("textarea")).toBeNull();
  });
});

describe("平台判定（桌面默认复制 / 触屏才走系统分享）", () => {
  it("jsdom 默认环境（无触屏、无 matchMedia）判为桌面", () => {
    expect(isTouchLike()).toBe(false);
    expect(prefersNativeShare()).toBe(false);
  });

  it("maxTouchPoints > 0 或 coarse pointer 判为触屏", () => {
    setMaxTouchPoints(5);
    expect(isTouchLike()).toBe(true);
    Reflect.deleteProperty(navigator, "maxTouchPoints");

    setCoarsePointer(true);
    expect(isTouchLike()).toBe(true);
  });

  it("桌面即使实现了 navigator.share 也不默认弹系统面板", () => {
    Object.defineProperty(navigator, "share", { configurable: true, value: vi.fn() });
    expect(canNativeShare()).toBe(true);
    expect(prefersNativeShare()).toBe(false);
  });

  it("触屏且有 navigator.share 才默认系统分享；触屏无 share 仍走复制", () => {
    setMaxTouchPoints(1);
    expect(prefersNativeShare()).toBe(false);

    Object.defineProperty(navigator, "share", { configurable: true, value: vi.fn() });
    expect(prefersNativeShare()).toBe(true);
  });
});

describe("isShareCancelled", () => {
  it("只认 AbortError，其余错误算失败", () => {
    expect(isShareCancelled(Object.assign(new Error("cancelled"), { name: "AbortError" }))).toBe(true);
    expect(isShareCancelled(new Error("NotAllowedError"))).toBe(false);
    expect(isShareCancelled(null)).toBe(false);
  });
});