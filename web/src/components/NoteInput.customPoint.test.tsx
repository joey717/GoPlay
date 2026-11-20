/**
 * Task #221：搜索结果底部「都不是，添加自定义点位」端到端链路测试。
 *
 * 验收口径：
 * - 搜索结果（>0）底部渲染次要文字入口，点击在结果下方展开内联表单（不弹新面板）；
 * - 名称必填且默认带入当前搜索关键词，地址选填；表单展开期间隐藏「添加选中的」
 *   主行动行（同一时刻只有一个橙色主钮）；
 * - 确认：经 onQuickAdd 上抛名称与地址（父组件构造 origin=custom 的 Item 排入目标天），
 *   面板保持打开（不调 onClose），表单收起并显示已添加提示；
 * - 取消：收起表单不调 onQuickAdd，主行动行恢复；
 * - 0 结果一键添加（既有行为不受影响）：customAddress 为 null，提交后关闭面板；
 * - 新一轮搜索重置表单与已添加提示。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Trip } from "@goplay/shared";
import NoteInput from "./NoteInput";
import type { GuideDraftGenerationView } from "./GuideDraftPanel";
import {
  listGuideSources,
  searchHotels,
  searchPoi,
  type PoiSearchResult,
} from "../api/client";

vi.mock("../api/client", async (importOriginal) => {
  // 保留 ApiError 等真实实现，仅桩掉网络函数
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    listGuideSources: vi.fn(),
    getGuideSource: vi.fn(),
    retryGuideSource: vi.fn(),
    removeGuideSource: vi.fn(),
    searchPoi: vi.fn(),
    searchHotels: vi.fn(),
    submitGuideSourceImages: vi.fn(),
    submitGuideSourceLink: vi.fn(),
    submitGuideSourceText: vi.fn(),
  };
});

/** 单天行程：无来源、无候选，专注快速搜索链路 */
function makeTrip(): Trip {
  return {
    tripId: "trip-test",
    schemaVersion: 2,
    version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: "2026-11-09", nights: 1 },
    dayRefs: ["day_1"],
    days: {
      day_1: {
        dayId: "day_1",
        dayIndex: 1,
        date: "2026-11-08",
        departTime: null,
        departTimeOverridden: false,
        scheduleVisitRefs: [],
        lodging: null,
      },
    },
    lodgings: {},
    itemRegistry: {},
    hotelRegistry: {},
    visits: {},
    stops: {},
    evidences: {},
    globalCandidateRefs: [],
    pendingStopRefs: [],
    relationshipSuggestions: {},
    guideSources: {},
    constraints: [],
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
  };
}

const idleGeneration: GuideDraftGenerationView = { active: false, text: null, error: null };

const DAY_INPUT_PLACEHOLDER = "输入景点/酒店名直接搜索，或粘贴攻略链接/文字";
const NAME_PLACEHOLDER = "如：第一市场夜市入口";
const ADDR_PLACEHOLDER = "可稍后补充，也可留空";

const poiResult: PoiSearchResult = {
  id: "poi_1",
  name: "亚龙湾热带天堂森林公园",
  address: "三亚市吉阳区亚龙湾",
  category: "景点",
  description: null,
  freePoiStatus: null,
  poiLevel: null,
  coords: null,
  mainPic: null,
  listRank: null,
  ticketInfo: null,
  jumpUrl: null,
};

function poiEnvelope(normalized: PoiSearchResult[] = [poiResult]) {
  return {
    raw: {},
    normalized,
    toolName: "search_poi",
    params: {},
    capturedAt: "2026-11-01T00:00:00Z",
    latencyMs: 1,
    integrationPath: "cli" as const,
  };
}

function emptyHotelEnvelope() {
  return {
    raw: {},
    normalized: [],
    toolName: "search_hotel",
    params: {},
    capturedAt: "2026-11-01T00:00:00Z",
    latencyMs: 1,
    integrationPath: "cli" as const,
  };
}

function renderPanel() {
  const onQuickAdd = vi.fn();
  const onClose = vi.fn();
  render(
    <NoteInput
      tripId="trip-test"
      trip={makeTrip()}
      cityName="三亚"
      dayIndex={1}
      checkIn="2026-11-08"
      checkOut="2026-11-09"
      openContext={{ type: "day", dayIndex: 1 }}
      onExtracted={vi.fn()}
      onAddCandidate={vi.fn()}
      onUndoAddCandidate={vi.fn()}
      onQuickAdd={onQuickAdd}
      onDraftApplied={vi.fn()}
      onProposalNeeded={vi.fn()}
      generation={idleGeneration}
      onGenerateDraft={vi.fn()}
      onCancelGenerateDraft={vi.fn()}
      draft={null}
      onDraftDismiss={vi.fn()}
      onClose={onClose}
    />,
  );
  return { onQuickAdd, onClose };
}

/** 走一轮短文本搜索并等待结果面板出现（1 个景点结果） */
async function searchFor(term: string): Promise<void> {
  fireEvent.change(screen.getByPlaceholderText(DAY_INPUT_PLACEHOLDER), {
    target: { value: term },
  });
  fireEvent.click(screen.getByRole("button", { name: "提交" }));
  await screen.findByText(`「${term}」找到 1 个结果，勾选后加入 Day1`);
}

beforeEach(() => {
  vi.mocked(listGuideSources).mockResolvedValue({ sources: [], tripVersion: 1 });
  vi.mocked(searchPoi).mockResolvedValue(poiEnvelope());
  vi.mocked(searchHotels).mockResolvedValue(emptyHotelEnvelope());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("搜索结果底部自定义点位表单（Task #221）", () => {
  it("结果底部渲染入口：展开内联表单，名称默认带入搜索关键词，主行动行让位", async () => {
    renderPanel();
    await searchFor("情人桥");

    // 主行动行在场时入口同屏（次要文字按钮，不抢主操作）
    expect(screen.getByRole("button", { name: "添加选中的 0 项" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "都不是，添加自定义点位" }));

    // 表单就在搜索结果下方展开：名称默认带入搜索关键词，地址留空
    expect(screen.getByPlaceholderText(NAME_PLACEHOLDER)).toHaveValue("情人桥");
    expect(screen.getByPlaceholderText(ADDR_PLACEHOLDER)).toHaveValue("");
    // 表单展开期间「添加选中的」主行动行让位（同一时刻只有一个橙色主钮）
    expect(screen.queryByRole("button", { name: /添加选中的/ })).toBeNull();
    expect(screen.getByRole("button", { name: "添加到 Day1" })).toBeInTheDocument();
  });

  it("名称必填：清空名称后确认禁用，重新填写恢复", async () => {
    renderPanel();
    await searchFor("情人桥");
    fireEvent.click(screen.getByRole("button", { name: "都不是，添加自定义点位" }));

    const confirm = screen.getByRole("button", { name: "添加到 Day1" });
    expect(confirm).toBeEnabled();

    fireEvent.change(screen.getByPlaceholderText(NAME_PLACEHOLDER), {
      target: { value: "  " },
    });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(NAME_PLACEHOLDER), {
      target: { value: "情人桥观景台" },
    });
    expect(confirm).toBeEnabled();
  });

  it("确认提交：onQuickAdd 收到名称与地址，面板保持打开，表单收起并显示已添加提示", async () => {
    const { onQuickAdd, onClose } = renderPanel();
    await searchFor("情人桥");
    fireEvent.click(screen.getByRole("button", { name: "都不是，添加自定义点位" }));

    // 用户可改写默认名称（搜索词只是初始值）
    fireEvent.change(screen.getByPlaceholderText(NAME_PLACEHOLDER), {
      target: { value: "情人桥观景台" },
    });
    fireEvent.change(screen.getByPlaceholderText(ADDR_PLACEHOLDER), {
      target: { value: "后海村码头" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加到 Day1" }));

    expect(onQuickAdd).toHaveBeenCalledWith({
      pois: [],
      hotels: [],
      customName: "情人桥观景台",
      customAddress: "后海村码头",
    });
    expect(onQuickAdd).toHaveBeenCalledTimes(1);
    // 面板保持打开：不走 onClose（可继续搜索或手动关闭）
    expect(onClose).not.toHaveBeenCalled();
    // 表单收起
    expect(screen.queryByPlaceholderText(NAME_PLACEHOLDER)).toBeNull();
    expect(screen.queryByPlaceholderText(ADDR_PLACEHOLDER)).toBeNull();
    // 已添加提示（含地址）+ 主行动行恢复
    expect(screen.getByText("已添加「情人桥观景台」到 Day1（含地址）")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加选中的 0 项" })).toBeInTheDocument();
  });

  it("地址留空：customAddress 传 null，提示不带地址后缀", async () => {
    const { onQuickAdd } = renderPanel();
    await searchFor("情人桥");
    fireEvent.click(screen.getByRole("button", { name: "都不是，添加自定义点位" }));

    fireEvent.click(screen.getByRole("button", { name: "添加到 Day1" }));

    expect(onQuickAdd).toHaveBeenCalledWith({
      pois: [],
      hotels: [],
      customName: "情人桥",
      customAddress: null,
    });
    expect(screen.getByText("已添加「情人桥」到 Day1")).toBeInTheDocument();
  });

  it("取消：表单收起不调 onQuickAdd，主行动行恢复", async () => {
    const { onQuickAdd, onClose } = renderPanel();
    await searchFor("情人桥");
    fireEvent.click(screen.getByRole("button", { name: "都不是，添加自定义点位" }));
    fireEvent.change(screen.getByPlaceholderText(ADDR_PLACEHOLDER), {
      target: { value: "后海村码头" },
    });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(screen.queryByPlaceholderText(NAME_PLACEHOLDER)).toBeNull();
    expect(onQuickAdd).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "添加选中的 0 项" })).toBeInTheDocument();
  });

  it("新一轮搜索重置表单与已添加提示", async () => {
    renderPanel();
    await searchFor("情人桥");
    fireEvent.click(screen.getByRole("button", { name: "都不是，添加自定义点位" }));
    fireEvent.click(screen.getByRole("button", { name: "添加到 Day1" }));
    expect(screen.getByText("已添加「情人桥」到 Day1")).toBeInTheDocument();

    // 返回修改 → 重新搜索：提示清除，入口按钮回归
    fireEvent.click(screen.getByRole("button", { name: "返回修改" }));
    await searchFor("西岛");

    expect(screen.queryByText(/已添加「/)).toBeNull();
    expect(screen.getByRole("button", { name: "都不是，添加自定义点位" })).toBeInTheDocument();
    // 再次展开：名称默认带入新一轮搜索词
    fireEvent.click(screen.getByRole("button", { name: "都不是，添加自定义点位" }));
    expect(screen.getByPlaceholderText(NAME_PLACEHOLDER)).toHaveValue("西岛");
  });

  it("0 结果仍走一键添加（既有行为）：customAddress 为 null，提交后关闭面板", async () => {
    vi.mocked(searchPoi).mockResolvedValue(poiEnvelope([]));
    const { onQuickAdd, onClose } = renderPanel();

    fireEvent.change(screen.getByPlaceholderText(DAY_INPUT_PLACEHOLDER), {
      target: { value: "无名小渔村" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交" }));

    expect(await screen.findByText("未找到相关景点或酒店")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加为自定义点位" }));

    expect(onQuickAdd).toHaveBeenCalledWith({
      pois: [],
      hotels: [],
      customName: "无名小渔村",
      customAddress: null,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
