/**
 * Task #354：HotelPicker 无片区（areaName=null）时渲染片区选择态，
 * 点选湾区后写回 updateLodgingArea 并进入 area 搜索流程；有片区的天行为不变。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SANYA_AREAS } from "@goplay/shared";
import type { HotelCandidate, Trip } from "@goplay/shared";
import HotelPicker from "./HotelPicker";
import { searchHotels } from "../api/client";

vi.mock("../api/client", async (importOriginal) => {
  // 保留 ApiError / flyAiErrorMessage 等真实实现，仅桩掉网络函数
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    searchHotels: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const trip = {
  tripId: "trip_354",
  destination: { city: "三亚", cityCode: null },
} as unknown as Trip;

function envelope(hotels: HotelCandidate[]) {
  return {
    raw: null,
    normalized: hotels,
    toolName: "hotel_search",
    params: {},
    capturedAt: "",
    latencyMs: 0,
    integrationPath: "cli" as const,
  };
}

function makeHotel(name: string): HotelCandidate {
  return {
    id: `h_${name}`,
    shId: `sh_${name}`,
    name,
    mainPic: null,
    star: null,
    priceText: null,
    rate: null,
    detailUrl: null,
  } as unknown as HotelCandidate;
}

function renderPicker(props: {
  areaName: string | null;
  onUpdateArea?: (dayIndex: number, areaName: string | null) => void;
}) {
  return render(
    <HotelPicker
      dayIndex={4}
      areaName={props.areaName}
      checkIn="2026-11-11"
      checkOut="2026-11-12"
      trip={trip}
      onUpdateArea={props.onUpdateArea ?? (() => {})}
      onSelect={() => {}}
      onClose={() => {}}
    />,
  );
}

describe("Task #354 HotelPicker 片区选择态", () => {
  it("无片区渲染 6 湾区选择态且不发起搜索", () => {
    renderPicker({ areaName: null });
    // 标题为「选择入住片区 · 11-11」
    expect(screen.getByText(/选择入住片区/)).toBeTruthy();
    // shared 6 个湾区全部渲染为可点 chip
    const chips = document.querySelectorAll(".hotel-area-options .area-option");
    expect(chips.length).toBe(SANYA_AREAS.length);
    for (const area of SANYA_AREAS) {
      expect(screen.getByText(area.name)).toBeTruthy();
    }
    // 保留「知道了」关闭交互
    expect(screen.getByText("知道了")).toBeTruthy();
    // 未设片区不发起酒店搜索（不再传城市名 → 不会 400）
    expect(searchHotels).not.toHaveBeenCalled();
  });

  it("点选湾区触发 updateLodgingArea 写回并进入搜索态", async () => {
    const onUpdateArea = vi.fn();
    vi.mocked(searchHotels).mockResolvedValue(envelope([makeHotel("海棠湾大酒店")]));
    renderPicker({ areaName: null, onUpdateArea });

    fireEvent.click(screen.getByText("海棠湾"));

    // 写回 lodging（恢复孤儿 API 接线）
    expect(onUpdateArea).toHaveBeenCalledWith(4, "海棠湾");
    // 进入 area 搜索流程（携带所选片区，不再是城市名）
    await waitFor(() => expect(searchHotels).toHaveBeenCalledTimes(1));
    expect(vi.mocked(searchHotels).mock.calls[0][0]).toMatchObject({
      destination: "三亚",
      area: "海棠湾",
    });
    // 搜索结果正常展示
    await waitFor(() => expect(screen.getByText("海棠湾大酒店")).toBeTruthy());
  });

  it("有片区的天直接搜索，不渲染选择态", async () => {
    vi.mocked(searchHotels).mockResolvedValue(envelope([makeHotel("亚龙湾度假酒店")]));
    renderPicker({ areaName: "亚龙湾" });
    // 不出现片区选择态
    expect(document.querySelector(".hotel-area-select")).toBeNull();
    await waitFor(() => expect(searchHotels).toHaveBeenCalledTimes(1));
    expect(vi.mocked(searchHotels).mock.calls[0][0]).toMatchObject({ area: "亚龙湾" });
    await waitFor(() => expect(screen.getByText("亚龙湾度假酒店")).toBeTruthy());
  });
});
