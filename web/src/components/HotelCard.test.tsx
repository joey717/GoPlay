import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { HotelCandidate } from "@goplay/shared";
import HotelCard from "./HotelCard";

afterEach(cleanup);

function makeHotel(overrides: Partial<HotelCandidate> = {}): HotelCandidate {
  return {
    id: "hotel_1",
    shId: "hotel_1",
    name: "三亚湾红树林度假世界",
    brandName: null,
    star: "5星",
    priceText: "¥501",
    priceBasis: "价格与库存以飞猪详情页为准",
    address: "三亚湾路 1 号",
    interestsPoi: "近三亚湾",
    decorationTime: null,
    coords: null,
    mainPic: null,
    detailUrl: "https://h5.m.fliggy.com/hotel?shId=hotel_1",
    rate: null,
    ...overrides,
  };
}

function renderCard(props: Parameters<typeof HotelCard>[0]) {
  return render(<HotelCard {...props} />);
}

describe("HotelCard 预订状态管理（任务 220 定宽动作区 / #373 去锁定钮）", () => {
  it("unknown：灰短按钮「订」+ 订房入口同处 .card-actions", () => {
    renderCard({
      hotel: makeHotel(),
      purchaseState: "unknown",
      onPurchaseSelect: vi.fn(),
    });

    // 未确定：灰短按钮显示简写「订」，仍可点开三档菜单（不再分 unknown 方钮/文字药丸两套）
    const stateBtn = screen.getByTitle("点击选择预订状态");
    expect(stateBtn.classList.contains("act-status")).toBe(true);
    expect(stateBtn.classList.contains("pending")).toBe(true);
    expect(stateBtn.textContent).toBe("订");

    // 与景点卡共用 .booklink（任务 220：定宽 128px，两处样式一致）
    const book = screen.getByRole("button", { name: "去订房" });
    expect(book.classList.contains("booklink")).toBe(true);

    // 状态 / 订房两件套同排右侧（分享钮任务 225 起隐藏，锁定钮 #373 起移除），
    // 且整行动作区是 .hotelcard 的直接子节点
    const actions = document.querySelector(".hotelcard > .card-actions");
    expect(actions).not.toBeNull();
    expect(document.querySelector(".hotelcard .hfoot .card-actions")).toBeNull();
    expect(actions?.querySelectorAll("button")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "分享" })).not.toBeInTheDocument();
  });

  it("toBuy：灰短按钮显示「现场订」，订房按钮仍是「去订房」", () => {
    renderCard({
      hotel: makeHotel(),
      purchaseState: "toBuy",
      onPurchaseSelect: vi.fn(),
    });

    const pill = document.querySelector(".card-actions .act-status");
    expect(pill?.textContent).toBe("现场订");
    expect(pill?.classList.contains("pending")).toBe(false);
    expect(screen.getByRole("button", { name: "去订房" })).toBeInTheDocument();
  });

  it("bought：灰短按钮显示「已订房」，按钮文案分流为「查看详情」（浅橙降级）", () => {
    renderCard({
      hotel: makeHotel(),
      purchaseState: "bought",
      onPurchaseSelect: vi.fn(),
    });

    const pill = document.querySelector(".card-actions .act-status");
    expect(pill?.textContent).toBe("已订房");
    const detail = screen.getByRole("button", { name: "查看详情" });
    expect(detail.classList.contains("booklink")).toBe(true);
    expect(detail.classList.contains("dim")).toBe(true);
    expect(screen.queryByRole("button", { name: "去订房" })).toBeNull();
  });

  it("三档菜单不含免票：选择「已订房」回调 onPurchaseSelect(bought) 并关闭菜单", () => {
    const onPurchaseSelect = vi.fn();
    renderCard({
      hotel: makeHotel(),
      purchaseState: "unknown",
      onPurchaseSelect,
    });

    fireEvent.click(screen.getByTitle("点击选择预订状态"));
    const menu = screen.getByRole("menu", { name: "选择预订状态" });
    const items = [...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
    expect(items).toEqual(["未确定", "现场订", "已订房"]);

    fireEvent.click(screen.getByRole("menuitem", { name: "已订房" }));
    expect(onPurchaseSelect).toHaveBeenCalledTimes(1);
    expect(onPurchaseSelect).toHaveBeenCalledWith("bought");
    expect(screen.queryByRole("menu", { name: "选择预订状态" })).toBeNull();
  });

  it("无飞猪详情链接：订房按钮隐藏，状态切换保留（#373 锁定钮已移除）", () => {
    renderCard({
      hotel: makeHotel({ detailUrl: null }),
      purchaseState: "unknown",
      onPurchaseSelect: vi.fn(),
    });

    expect(document.querySelector(".card-actions .booklink")).toBeNull();
    expect(screen.getByTitle("点击选择预订状态")).toBeInTheDocument();
    expect(screen.queryByTitle("锁定为已定项：AI 不会改动它")).toBeNull();
  });
});
