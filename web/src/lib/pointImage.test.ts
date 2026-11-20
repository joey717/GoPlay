/**
 * Task #296：点位配图来源优先级纯函数单测（resolvePointImage / fliggyMainPic）。
 *
 * 覆盖 PD 口径四场景：飞猪图优先（即使同时有 PX 关联图）、无飞猪图（custom /
 * 飞猪记录无图 / item 缺失）回退 PX 攻略图、外链加载失败按来源降级（飞猪失败
 * →PX→PX 失败→占位，不留白）、两者皆无落占位。全程内存对象，不触网。
 */
import { describe, expect, it } from "vitest";
import type { Item } from "@goplay/shared";
import { fliggyMainPic, resolvePointImage, type PointImageFailures } from "./pointImage";

// ===== 工厂 =====

function makeItem(overrides: Partial<Item> & Pick<Item, "itemId" | "name" | "origin">): Item {
  return {
    providerId: null,
    address: null,
    category: null,
    coords: null,
    suggestMinutes: null,
    mainPic: null,
    ticketInfo: null,
    jumpUrl: null,
    sourceEvidenceRefs: [],
    ...overrides,
  };
}

const FLIGGY_PIC = "https://img.alicdn.com/tfscom/TB1xidao.jpg";
const GUIDE_PATH = "uploads/xhs_6ace31c6000000001b0202f7/6.jpg";
const NO_FAILURES: PointImageFailures = { fliggyFailed: false, guideFailed: false };

const fliggyItemWithPic = makeItem({
  itemId: "item_xidao",
  name: "西岛",
  origin: "fliggy",
  providerId: "poi_123",
  mainPic: FLIGGY_PIC,
});
const fliggyItemNoPic = makeItem({
  itemId: "item_xidaoqiang",
  name: "西岛墙",
  origin: "fliggy",
  providerId: "poi_456",
  mainPic: null,
});
const customItem = makeItem({ itemId: "item_custom", name: "小吃街", origin: "custom" });

// ===== fliggyMainPic 取用口径 =====

describe("fliggyMainPic", () => {
  it("origin=fliggy 且 mainPic 非空 → 返回主图 URL", () => {
    expect(fliggyMainPic(fliggyItemWithPic)).toBe(FLIGGY_PIC);
  });

  it("origin=fliggy 但 mainPic 为 null / 空白 → 视为无飞猪图", () => {
    expect(fliggyMainPic(fliggyItemNoPic)).toBeNull();
    expect(
      fliggyMainPic(makeItem({ itemId: "i", name: "x", origin: "fliggy", mainPic: "   " })),
    ).toBeNull();
  });

  it("origin=custom 即使脏数据带 mainPic 也不冒充飞猪实图", () => {
    expect(
      fliggyMainPic(makeItem({ itemId: "i", name: "x", origin: "custom", mainPic: FLIGGY_PIC })),
    ).toBeNull();
  });

  it("item 缺失（null / undefined）→ null", () => {
    expect(fliggyMainPic(null)).toBeNull();
    expect(fliggyMainPic(undefined)).toBeNull();
  });
});

// ===== resolvePointImage 优先级状态机 =====

describe("resolvePointImage 优先级", () => {
  it("飞猪有图 → 用飞猪图（即使同时有 PX 关联图，飞猪优先）", () => {
    expect(resolvePointImage(fliggyItemWithPic, GUIDE_PATH, NO_FAILURES)).toEqual({
      kind: "fliggy",
      src: FLIGGY_PIC,
    });
  });

  it("飞猪记录无图（命中飞猪但 mainPic 空）→ 回退 PX 攻略图（不再要求 custom）", () => {
    expect(resolvePointImage(fliggyItemNoPic, GUIDE_PATH, NO_FAILURES)).toEqual({
      kind: "guide",
      assetPath: GUIDE_PATH,
    });
  });

  it("自定义点（custom 无飞猪图）→ 回退 PX 攻略图", () => {
    expect(resolvePointImage(customItem, GUIDE_PATH, NO_FAILURES)).toEqual({
      kind: "guide",
      assetPath: GUIDE_PATH,
    });
  });

  it("item 缺失但有 PX 关联图 → 回退 PX 攻略图", () => {
    expect(resolvePointImage(null, GUIDE_PATH, NO_FAILURES)).toEqual({
      kind: "guide",
      assetPath: GUIDE_PATH,
    });
  });

  it("两者皆无 → 占位符", () => {
    expect(resolvePointImage(customItem, null, NO_FAILURES)).toEqual({ kind: "placeholder" });
    expect(resolvePointImage(null, null, NO_FAILURES)).toEqual({ kind: "placeholder" });
  });
});

describe("resolvePointImage 加载失败降级", () => {
  it("飞猪外链失败 → 降级 PX 攻略图（不直接占位、不留白）", () => {
    expect(
      resolvePointImage(fliggyItemWithPic, GUIDE_PATH, { fliggyFailed: true, guideFailed: false }),
    ).toEqual({ kind: "guide", assetPath: GUIDE_PATH });
  });

  it("飞猪外链失败且无 PX 图 → 占位符", () => {
    expect(
      resolvePointImage(fliggyItemWithPic, null, { fliggyFailed: true, guideFailed: false }),
    ).toEqual({ kind: "placeholder" });
  });

  it("PX 图失败（无飞猪图场景）→ 占位符", () => {
    expect(
      resolvePointImage(customItem, GUIDE_PATH, { fliggyFailed: false, guideFailed: true }),
    ).toEqual({ kind: "placeholder" });
  });

  it("飞猪失败 + PX 也失败 → 占位符（降级链终点）", () => {
    expect(
      resolvePointImage(fliggyItemWithPic, GUIDE_PATH, { fliggyFailed: true, guideFailed: true }),
    ).toEqual({ kind: "placeholder" });
  });

  it("PX 失败不影响飞猪图（飞猪有图时 guideFailed 无关）", () => {
    expect(
      resolvePointImage(fliggyItemWithPic, GUIDE_PATH, { fliggyFailed: false, guideFailed: true }),
    ).toEqual({ kind: "fliggy", src: FLIGGY_PIC });
  });
});
