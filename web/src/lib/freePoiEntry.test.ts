/**
 * Task #372：shared/freePoi.ts 新增 itemPurchaseChannel / shouldShowIntroEntry 用例。
 *
 * 落点说明：shared 包 main 直指 src/index.ts，既往 shared 纯函数用例均放 web/src/lib
 * （随 `vitest run --root web` 基线统计），本文件沿用该惯例。
 *
 * 判定口径（单一数据源 shared/freePoi.ts）：
 * - itemPurchaseChannel：jumpUrl 非空 → "fliggy"；null/缺失/item 空 → "none"；
 * - shouldShowIntroEntry：（无通道 或 isFreeAdmissionItem）且 itemDescription !== null。
 *   description 判空为空浮层守卫（国际免税城 FREE 无介绍 → 维持现状「查看详情」）。
 */
import { describe, expect, it } from "vitest";
import type { Item } from "@goplay/shared";
import {
  isFreeAdmissionItem,
  itemPurchaseChannel,
  shouldShowIntroEntry,
} from "@goplay/shared";

const JUMP = "https://h5.m.taobao.com/trip/poi?id=2611";

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    itemId: "item_t372",
    name: "测试点位",
    origin: "custom",
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

describe("itemPurchaseChannel（Task #372）", () => {
  it("jumpUrl 非空 → fliggy（西岛等有通道点位）", () => {
    expect(itemPurchaseChannel(makeItem({ jumpUrl: JUMP, origin: "fliggy" }))).toBe("fliggy");
  });

  it("jumpUrl null → none（无购票通道；存量数据中与 origin=custom 完全等价）", () => {
    expect(itemPurchaseChannel(makeItem({ jumpUrl: null }))).toBe("none");
  });

  it("item 为 null / undefined → none（读时默认，不抛错）", () => {
    expect(itemPurchaseChannel(null)).toBe("none");
    expect(itemPurchaseChannel(undefined)).toBe("none");
  });
});

describe("shouldShowIntroEntry（Task #372）", () => {
  it("无通道 + 有 description → true（后海村/凤凰岛桥头公园等 custom 点位形态）", () => {
    const item = makeItem({ jumpUrl: null, description: "后海村是冲浪胜地。" });
    expect(shouldShowIntroEntry(item)).toBe(true);
  });

  it("有通道 NOT_FREE + 有 description → false（西岛：原购票路径零变化）", () => {
    const item = makeItem({
      name: "西岛",
      origin: "fliggy",
      jumpUrl: JUMP,
      freePoiStatus: "NOT_FREE",
      description: "西岛有海上项目。",
    });
    expect(isFreeAdmissionItem(item)).toBe(false);
    expect(shouldShowIntroEntry(item)).toBe(false);
  });

  it("有通道 FREE + 有 description → true（天涯海角/椰梦长廊回填后形态）", () => {
    const item = makeItem({
      name: "天涯海角游览区",
      origin: "fliggy",
      jumpUrl: JUMP,
      freePoiStatus: "FREE",
      description: "天涯海角以石刻闻名。",
    });
    expect(shouldShowIntroEntry(item)).toBe(true);
  });

  it("空浮层守卫：FREE 但 description null → false（国际免税城维持「查看详情」）", () => {
    const item = makeItem({
      name: "国际免税城",
      origin: "fliggy",
      jumpUrl: JUMP,
      freePoiStatus: "FREE",
      description: null,
    });
    expect(shouldShowIntroEntry(item)).toBe(false);
  });

  it("空浮层守卫：description 为空白串 / 缺失字段同样不展示（itemDescription 归一化口径）", () => {
    expect(shouldShowIntroEntry(makeItem({ description: "   " }))).toBe(false);
    expect(shouldShowIntroEntry(makeItem({ jumpUrl: null }))).toBe(false);
  });

  it("名称通道兜底命中（UNKNOWN + 购物名 + 有 description）→ true，与 isFreeAdmissionItem 同口径", () => {
    const item = makeItem({
      name: "国际免税城",
      origin: "fliggy",
      jumpUrl: JUMP,
      freePoiStatus: "UNKNOWN",
      description: "免税城购物介绍。",
    });
    expect(isFreeAdmissionItem(item)).toBe(true);
    expect(shouldShowIntroEntry(item)).toBe(true);
  });

  it("UNKNOWN 非购物名 + 有通道 + 有 description → false（亚龙湾海滩：零变化对照）", () => {
    const item = makeItem({
      name: "亚龙湾海滩",
      origin: "fliggy",
      jumpUrl: JUMP,
      freePoiStatus: "UNKNOWN",
      description: "亚龙湾沙滩细软。",
    });
    expect(shouldShowIntroEntry(item)).toBe(false);
  });

  it("item 为 null / undefined → false（读时默认，不抛错）", () => {
    expect(shouldShowIntroEntry(null)).toBe(false);
    expect(shouldShowIntroEntry(undefined)).toBe(false);
  });
});
