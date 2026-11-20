/**
 * 任务 198：day 添加面板（日卡「+」/ 空 Day 卡「添加到 DayN」入口）布局与文案收敛测试。
 *
 * 验收口径：
 * - 不重复攻略管理：day 面板不渲染「已添加攻略」来源列表，也不渲染攻略排版区；
 * - 首屏顺序：标题「添加到 DayN」→ 输入框 → 常驻「提交」→ 推荐候选，DOM 顺序可判定；
 * - 按钮文案统一「提交」（空输入灰禁），短文本提交仍走飞猪搜索勾选，长文仍存为攻略来源；
 * - global 面板（顶栏入口）保持原布局与文案，不受本次改造影响。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GuideSource, Item, Trip } from "@goplay/shared";
import NoteInput, { type OpenContext } from "./NoteInput";
import type { GuideDraftGenerationView } from "./GuideDraftPanel";
import {
  listGuideSources,
  searchHotels,
  searchPoi,
  submitGuideSourceText,
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

function makeSource(sourceId: string, title: string): GuideSource {
  return {
    sourceId,
    sourceVersion: 1,
    inputKind: "text",
    active: true,
    status: "ready",
    title,
    evidenceRefs: [],
    mentionRefs: [],
    imageProgress: { total: 0, completed: 0, failed: 0, images: [] },
    importedAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
  };
}

function makeItem(itemId: string, name: string): Item {
  return {
    itemId,
    name,
    origin: "fliggy",
    providerId: `sh_${itemId}`,
    address: "三亚市海棠区",
    category: "景点",
    coords: null,
    suggestMinutes: null,
    mainPic: null,
    ticketInfo: null,
    jumpUrl: null,
    sourceEvidenceRefs: [],
  };
}

/** 三天行程：两篇就绪攻略 + 两个未排期候选点位（day 面板推荐区数据源） */
function makeTrip(): Trip {
  const sources = {
    src_1: makeSource("src_1", "三亚后海村攻略"),
    src_2: makeSource("src_2", "西岛半日游"),
  };
  const days: Trip["days"] = {};
  for (let index = 1; index <= 3; index += 1) {
    const dayId = `day_${index}`;
    days[dayId] = {
      dayId,
      dayIndex: index,
      date: `2026-11-${String(7 + index).padStart(2, "0")}`,
      departTime: null,
      departTimeOverridden: false,
      scheduleVisitRefs: [],
      lodging: null,
    };
  }
  return {
    tripId: "trip-test",
    schemaVersion: 2,
    version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: "2026-11-10", nights: 2 },
    dayRefs: ["day_1", "day_2", "day_3"],
    days,
    lodgings: {},
    itemRegistry: {
      item_1: makeItem("item_1", "陵风姐帆船俱乐部"),
      item_2: makeItem("item_2", "云上栖"),
    },
    hotelRegistry: {},
    visits: {},
    stops: {},
    evidences: {},
    globalCandidateRefs: [
      { kind: "point", id: "item_1" },
      { kind: "point", id: "item_2" },
    ],
    pendingStopRefs: [],
    relationshipSuggestions: {},
    guideSources: sources,
    constraints: [],
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
  };
}

const idleGeneration: GuideDraftGenerationView = { active: false, text: null, error: null };

const DAY_INPUT_PLACEHOLDER = "输入景点/酒店名直接搜索，或粘贴攻略链接/文字";
const GLOBAL_INPUT_PLACEHOLDER = "粘贴攻略链接 / 文字，或输入景点、酒店名";

function renderPanel(openContext: OpenContext) {
  return render(
    <NoteInput
      tripId="trip-test"
      trip={makeTrip()}
      cityName="三亚"
      dayIndex={3}
      checkIn="2026-11-10"
      checkOut="2026-11-11"
      openContext={openContext}
      onExtracted={vi.fn()}
      onAddCandidate={vi.fn()}
      onUndoAddCandidate={vi.fn()}
      onQuickAdd={vi.fn()}
      onDraftApplied={vi.fn()}
      onProposalNeeded={vi.fn()}
      generation={idleGeneration}
      onGenerateDraft={vi.fn()}
      onCancelGenerateDraft={vi.fn()}
      draft={null}
      onDraftDismiss={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}

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

function poiEnvelope() {
  return {
    raw: {},
    normalized: [poiResult],
    toolName: "search_poi",
    params: {},
    capturedAt: "2026-11-01T00:00:00Z",
    latencyMs: 1,
    integrationPath: "cli" as const,
  };
}

beforeEach(() => {
  const trip = makeTrip();
  vi.mocked(listGuideSources).mockResolvedValue({
    sources: Object.values(trip.guideSources ?? {}),
    tripVersion: 1,
  });
  vi.mocked(searchPoi).mockResolvedValue(poiEnvelope());
  vi.mocked(searchHotels).mockResolvedValue({
    raw: {},
    normalized: [],
    toolName: "search_hotel",
    params: {},
    capturedAt: "2026-11-01T00:00:00Z",
    latencyMs: 1,
    integrationPath: "cli",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("day 添加面板（任务 198）", () => {
  it("隐藏攻略来源与排版区，首屏顺序为 标题 → 输入 → 提交 → 推荐候选", async () => {
    renderPanel({ type: "day", dayIndex: 3 });

    expect(screen.getByRole("heading", { name: "添加到 Day3" })).toBeInTheDocument();
    // 攻略管理不在 day 面板重复：来源列表与攻略排版均不渲染
    await waitFor(() => {
      expect(vi.mocked(listGuideSources)).toHaveBeenCalled();
    });
    expect(screen.queryByLabelText("已添加的攻略来源")).toBeNull();
    expect(screen.queryByText(/攻略素材/)).toBeNull();
    expect(screen.queryByRole("button", { name: /优化行程/ })).toBeNull();
    expect(screen.queryByText(/整体重排/)).toBeNull();
    // 排版区（补充要求输入）同样不在 day 面板出现
    expect(screen.queryByPlaceholderText(/补充要求/)).toBeNull();

    const textarea = screen.getByPlaceholderText(DAY_INPUT_PLACEHOLDER);
    const submit = screen.getByRole("button", { name: "提交" });
    const candidateHead = screen.getByText("推荐添加到 Day3");
    // 输入框 在 提交 之前，提交 在 推荐候选 之前（同一父容器内的视觉顺序）
    expect(textarea.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(submit.compareDocumentPosition(candidateHead) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 空白打开时「提交」常驻但灰禁
    expect(submit).toBeDisabled();
    expect(screen.getByText("陵风姐帆船俱乐部")).toBeInTheDocument();
  });

  it("day 面板短文本提交走飞猪搜索：显示结果勾选，候选推荐让位", async () => {
    renderPanel({ type: "day", dayIndex: 3 });

    fireEvent.change(screen.getByPlaceholderText(DAY_INPUT_PLACEHOLDER), {
      target: { value: "亚龙湾" },
    });
    const submit = screen.getByRole("button", { name: "提交" });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(vi.mocked(searchPoi)).toHaveBeenCalledWith("亚龙湾", "三亚");
    });
    expect(
      await screen.findByText("「亚龙湾」找到 1 个结果，勾选后加入 Day3"),
    ).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "景点 亚龙湾热带天堂森林公园" })).toBeInTheDocument();
    // 短文本没有被当作攻略素材提交
    expect(vi.mocked(submitGuideSourceText)).not.toHaveBeenCalled();
    // 搜索态只保留结果列表，推荐候选让位
    expect(screen.queryByText("推荐添加到 Day3")).toBeNull();
    // 标题稳定为「添加到 DayN」，不随搜索阶段改写
    expect(screen.getByRole("heading", { name: "添加到 Day3" })).toBeInTheDocument();
  });

  it("day 面板长文提交仍存为攻略来源，按钮文案保持「提交」", async () => {
    vi.mocked(submitGuideSourceText).mockResolvedValue({
      sourceId: "src_new",
      status: "ready",
      duplicate: false,
      source: makeSource("src_new", "新攻略"),
    });
    renderPanel({ type: "day", dayIndex: 3 });

    const longText =
      "第一天先去后海村吃清补凉，然后去西岛看海，晚上回到亚龙湾住酒店，第二天去森林公园看云海。";
    fireEvent.change(screen.getByPlaceholderText(DAY_INPUT_PLACEHOLDER), {
      target: { value: longText },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交" }));

    await waitFor(() => {
      expect(vi.mocked(submitGuideSourceText)).toHaveBeenCalledWith("trip-test", longText, {
        sourceUrl: undefined,
      });
    });
    expect(await screen.findByText("已保存，正在识别要点")).toBeInTheDocument();
    expect(vi.mocked(searchPoi)).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "提交" })).toBeInTheDocument();
  });

  it("global 面板保持原布局：来源列表与排版区照常，按钮文案不变", async () => {
    renderPanel({ type: "global" });

    expect(await screen.findByLabelText("已添加的攻略来源")).toBeInTheDocument();
    expect(screen.getByText("已添加 2 篇")).toBeInTheDocument();
    // 攻略排版区照常（补充要求输入 + 排版主钮）
    expect(screen.getByPlaceholderText(/补充要求/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "提交" })).toBeNull();

    fireEvent.change(screen.getByPlaceholderText(GLOBAL_INPUT_PLACEHOLDER), {
      target: { value: "亚龙湾" },
    });
    expect(screen.getByRole("button", { name: "搜索点位" })).toBeInTheDocument();
  });
});
