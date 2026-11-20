import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Item, PendingGuideDraft, Trip, Visit } from "@goplay/shared";
import type { GuideDraftApplyResult, GuideDraftResult } from "../api/client";
import type { WaitStageSnapshot } from "../lib/waitStages";
import { ApiError, deleteTripCover, generateGuideDraft, uploadTripCover } from "../api/client";
import { notifySheetOpened } from "../lib/sheetBus";
import TripView from "./TripView";

const { useTripMock } = vi.hoisted(() => ({ useTripMock: vi.fn() }));

vi.mock("../hooks/useTrip", () => ({
  clearTripCache: vi.fn(),
  useTrip: useTripMock,
}));

// api client：仅替换草案生成（长耗时请求）与封面上传（Task #257），其余保留真实实现
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  generateGuideDraft: vi.fn(),
  uploadTripCover: vi.fn(),
  deleteTripCover: vi.fn(),
}));

// 重组件替换为轻 stub：本测试验证浮层接线（⋯ 菜单 / OpLog 条件渲染 / sheetBus 互斥）
// 与任务 135 行程级草案会话（关闭不取消 / 浮条 / 召回 / 超时）
// DayContent stub：暴露日卡「+」入口（任务 204 用于把 noteContext 残留为 day）与
// 归入大景点入口（任务 199 验证 TripView 浮层串联）
vi.mock("./DayContent", () => ({
  default: ({
    onOpenNoteInput,
    onClassifyIntoParent,
  }: {
    onOpenNoteInput?: (dayIndex: number) => void;
    onClassifyIntoParent?: (visitId: string) => void;
  }) => (
    <div data-testid="day-content-stub">
      <button type="button" onClick={() => onOpenNoteInput?.(1)}>
        打开 Day 添加面板
      </button>
      <button type="button" onClick={() => onClassifyIntoParent?.("visit_child")}>
        打开归类
      </button>
    </div>
  ),
}));
vi.mock("./IntentBar", () => ({ default: () => <div data-testid="intent-bar-stub" /> }));
// NoteInput 交互 stub：暴露生成 / 关闭 / 取消草案入口，并回显草案与生成会话视图
vi.mock("./NoteInput", () => ({
  default: ({
    onClose,
    onGenerateDraft,
    onDraftDismiss,
    onDraftApplied,
    draft,
    generation,
    openContext,
  }: {
    onClose: () => void;
    onGenerateDraft: (input: {
      entryContext: { type: "global" };
      note: string;
      usableCount: number;
    }) => void;
    onDraftDismiss: () => void;
    /** Task #263：暴露应用结果回吐入口，验证父级结算不把 snippet-only 当失败 */
    onDraftApplied: (result: GuideDraftApplyResult) => void;
    draft: { draftId: string | null } | null;
    generation: {
      active: boolean;
      text: string | null;
      error: string | null;
      /** Task #224：分级反馈快照（面板与底部浮条同源） */
      stage?: WaitStageSnapshot | null;
    };
    openContext: { type: "global" } | { type: "day"; dayIndex: number };
  }) => (
    <div data-testid="note-input-stub">
      <button type="button" onClick={onClose}>
        stub-close
      </button>
      <button type="button" onClick={() => onDraftApplied({
        type: "applied",
        tripVersion: 3,
        draftId: "draft-recall",
        applied: [],
        rejected: [],
        rejectedCount: 0,
        rejectSummary: null,
        allRejected: false,
        needsProposal: [],
        attachedSnippetCount: 3,
        attachedOptionGroupCount: 0,
        message: "行程结构无需变更，已添加 3 条攻略提示",
      })}>
        stub-apply
      </button>
      <button
        type="button"
        onClick={() =>
          onGenerateDraft({ entryContext: { type: "global" }, note: "stub-note", usableCount: 2 })
        }
      >
        stub-generate
      </button>
      <button type="button" onClick={onDraftDismiss}>stub-dismiss</button>
      <span data-testid="stub-draft-id">{draft === null ? "none" : draft.draftId}</span>
      <span data-testid="stub-generation-active">{String(generation.active)}</span>
      <span data-testid="stub-generation-error">{generation.error ?? ""}</span>
      {/* Task #224：回显分级快照「站名|已等|分级」——验证面板与浮条同源、
          离开返回后计时不重置、结束后不残留 */}
      <span data-testid="stub-generation-stage">
        {generation.stage
          ? `${generation.stage.stage.name}|${generation.stage.elapsedText}|${generation.stage.tier}`
          : "-"}
      </span>
      <span data-testid="stub-open-context">{openContext.type}</span>
    </div>
  ),
}));

function makeTrip(): Trip {
  const day = (index: number): Trip["days"][string] => ({
    dayId: `day_${index}`,
    dayIndex: index,
    date: `2026-11-0${7 + index}`,
    departTime: null,
    departTimeOverridden: false,
    scheduleVisitRefs: [],
    lodging: null,
  });
  return {
    tripId: "trip-test",
    schemaVersion: 2,
    version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: "2026-11-10", nights: 2 },
    dayRefs: ["day_1", "day_2"],
    days: { day_1: day(1), day_2: day(2) },
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

function fakeStore(trip: Trip | null = makeTrip()) {
  return {
    trip,
    loading: false,
    error: null,
    saving: false,
    undoState: null,
    opLog: [],
    clearOpLog: vi.fn(),
    updateTrip: vi.fn(),
    cancelPendingSave: vi.fn(),
    refreshFromServer: vi.fn(async () => {}),
    addRefToDay: vi.fn(),
    removeVisitWithUndo: vi.fn(),
    removeVisitsWithUndo: vi.fn(),
    undoRemove: vi.fn(),
    reorderVisit: vi.fn(),
    reorderDayItems: vi.fn(),
    moveDayItem: vi.fn(),
    setPurchaseState: vi.fn(),
    toggleLock: vi.fn(),
    updateDepartTime: vi.fn(),
    moveStop: vi.fn(),
    removeStopWithUndo: vi.fn(),
    restoreStop: vi.fn(),
    attachPendingStop: vi.fn(),
    adoptSuggestedStops: vi.fn(() => 0),
    classifyVisitAsParentStop: vi.fn(() => true),
    addCustomStop: vi.fn(),
    ensurePoolRef: vi.fn(() => null),
    addToPool: vi.fn(),
    deleteFromPool: vi.fn(),
    selectHotel: vi.fn(),
    updateLodgingArea: vi.fn(),
    moveHotelCandidate: vi.fn(),
    removeHotelCandidate: vi.fn(),
    applyServerResult: vi.fn(),
  };
}

function openOpLogFromMenu() {
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /近期操作/ }));
}

beforeEach(() => {
  // 任务 #211：已关闭草案记录存 localStorage，逐测清理避免相互污染
  localStorage.removeItem("goplay.dismissedDraftIds");
  useTripMock.mockReturnValue(fakeStore());
});

afterEach(() => {
  cleanup();
  useTripMock.mockReset();
});

describe("TripView 浮层互斥（Task #109）", () => {
  it("初始 DOM 中不存在近期操作 Sheet（不再常驻关闭态）", () => {
    render(<TripView tripId="trip-test" onNewTrip={vi.fn(async () => true)} />);
    expect(screen.queryByRole("dialog", { name: "近期操作" })).not.toBeInTheDocument();
    expect(document.querySelector(".sheet")).toBeNull();
  });

  it("⋯ 菜单可独立打开近期操作；Evidence 打开事件强制其关闭；随后仍可再打开并用 × 关闭", () => {
    render(<TripView tripId="trip-test" onNewTrip={vi.fn(async () => true)} />);

    openOpLogFromMenu();
    expect(screen.getByRole("dialog", { name: "近期操作" })).toBeInTheDocument();

    // 模拟攻略原文 Sheet 挂载（真实 EvidenceSheet 挂载即派发同一事件）
    act(() => {
      notifySheetOpened("evidence");
    });
    expect(screen.queryByRole("dialog", { name: "近期操作" })).not.toBeInTheDocument();

    openOpLogFromMenu();
    expect(screen.getByRole("dialog", { name: "近期操作" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭近期操作" }));
    expect(screen.queryByRole("dialog", { name: "近期操作" })).not.toBeInTheDocument();
  });

  it("近期操作打开时点遮罩可关闭", () => {
    render(<TripView tripId="trip-test" onNewTrip={vi.fn(async () => true)} />);
    openOpLogFromMenu();
    expect(screen.getByRole("dialog", { name: "近期操作" })).toBeInTheDocument();
    fireEvent.click(document.querySelector(".backdrop.on") as Element);
    expect(screen.queryByRole("dialog", { name: "近期操作" })).not.toBeInTheDocument();
  });
});

// Task #265：待办清单盘点浮层——⋯ 菜单入口 + 挂载即渲染 + sheetBus 互斥
describe("TripView 待办清单浮层（Task #265）", () => {
  it("⋯ 菜单可打开待办清单，✕ 关闭后从 DOM 移除", () => {
    render(<TripView tripId="trip-test" onNewTrip={vi.fn(async () => true)} />);

    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /待办清单/ }));

    const dialog = screen.getByRole("dialog", { name: "待办清单" });
    // 两天无内容行程：每天住宿待安排 + 首/末日航班待录入 → 待办 4 项
    expect(within(dialog).getByRole("tab", { name: /^待办/ }).textContent).toContain("4");
    expect(within(dialog).getByRole("region", { name: "Day 1" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关闭待办清单" }));
    expect(screen.queryByRole("dialog", { name: "待办清单" })).not.toBeInTheDocument();
  });

  it("待办清单挂载广播使近期操作让位（互斥）", () => {
    render(<TripView tripId="trip-test" onNewTrip={vi.fn(async () => true)} />);
    openOpLogFromMenu();
    expect(screen.getByRole("dialog", { name: "近期操作" })).toBeInTheDocument();

    act(() => {
      notifySheetOpened("checklist");
    });
    expect(screen.queryByRole("dialog", { name: "近期操作" })).not.toBeInTheDocument();
  });
});

// ===== 任务 135：行程级草案生成会话（关闭不取消 / 浮条 / 召回 / 兕底超时） =====

function makeDraftResult(overrides: Partial<GuideDraftResult> = {}): GuideDraftResult {
  return {
    draftId: "draft-t1",
    tripVersion: 2,
    baseTripVersion: 2,
    inputTripVersion: 1,
    scope: { kind: "trip" },
    operations: [],
    snippets: [],
    unplaced: [],
    proposedNew: [],
    clarify: null,
    sourceSnapshots: [],
    sourceCount: 2,
    mentionCount: 0,
    placeCount: 0,
    mentionRefCount: 0,
    latencyMs: 0,
    promptChars: 0,
    attempts: 1,
    ...overrides,
  };
}

function makePendingDraft(overrides: Partial<PendingGuideDraft> = {}): PendingGuideDraft {
  return {
    draftId: "draft-recall",
    baseTripVersion: 2,
    scope: { kind: "trip" },
    sourceSnapshots: [],
    mentionIds: [],
    note: null,
    createdAt: "2026-11-02T00:00:00Z",
    output: { operations: [], snippets: [] },
    ...overrides,
  };
}

function tripWithPendingDraft(pending: PendingGuideDraft): Trip {
  const trip = makeTrip();
  trip.version = 2; // fresh 条件：baseTripVersion === trip.version
  (trip as { pendingGuideDraft?: PendingGuideDraft | null }).pendingGuideDraft = pending;
  return trip;
}

function renderTripView(): void {
  render(<TripView tripId="trip-test" onNewTrip={vi.fn(async () => true)} />);
}

function openNoteInput(): void {
  fireEvent.click(screen.getByRole("button", { name: /添加攻略/ }));
}

describe("TripView 行程级草案会话（任务 135）", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("生成中关闭面板不取消：浮条接管进度，完成后可点开直达草案，重开不重复请求", async () => {
    const store = fakeStore();
    useTripMock.mockReturnValue(store);
    let resolveDraft!: (draft: GuideDraftResult) => void;
    vi.mocked(generateGuideDraft).mockImplementation(
      () => new Promise<GuideDraftResult>((resolve) => { resolveDraft = resolve; }),
    );
    renderTripView();

    // 面板内发起生成：请求上抛到行程级会话（NoteInput 自身不持请求）
    openNoteInput();
    fireEvent.click(screen.getByRole("button", { name: "stub-generate" }));
    expect(vi.mocked(generateGuideDraft)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(generateGuideDraft)).toHaveBeenCalledWith(
      "trip-test",
      { entryContext: { type: "global" }, note: "stub-note" },
      expect.anything(),
    );
    // 面板开着：浮条隐藏（进度由面板内展示，避免重复噪音）
    expect(screen.queryByRole("status", { name: "攻略生成进度" })).not.toBeInTheDocument();
    expect(screen.getByTestId("stub-generation-active")).toHaveTextContent("true");

    // 生成中点浮条不可用（隐藏），关闭面板：请求不被取消，浮条接管进度
    fireEvent.click(screen.getByRole("button", { name: "stub-close" }));
    expect(screen.queryByTestId("note-input-stub")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "攻略生成进度" })).toBeInTheDocument();

    // 生成中点浮条重开面板：可继续等待，请求仍在途（不重发）
    fireEvent.click(screen.getByRole("button", { name: /正在读取攻略素材/ }));
    expect(screen.getByTestId("note-input-stub")).toBeInTheDocument();
    expect(screen.getByTestId("stub-generation-active")).toHaveTextContent("true");
    expect(vi.mocked(generateGuideDraft)).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "stub-close" }));

    // 完成：浮条转就绪，行程已刷新（草案已持久化）
    await act(async () => {
      resolveDraft(makeDraftResult());
    });
    expect(screen.getByRole("status", { name: "攻略草案已就绪" })).toBeInTheDocument();
    expect(store.refreshFromServer).toHaveBeenCalled();

    // 点就绪浮条重开：直达草案预览，不重新生成
    fireEvent.click(screen.getByRole("button", { name: /攻略排好了/ }));
    expect(screen.getByTestId("stub-draft-id")).toHaveTextContent("draft-t1");
    expect(vi.mocked(generateGuideDraft)).toHaveBeenCalledTimes(1);

    // 关闭再重开：仍不重复请求（活动草案在会话内保持）
    fireEvent.click(screen.getByRole("button", { name: "stub-close" }));
    fireEvent.click(screen.getByRole("button", { name: /攻略排好了/ }));
    expect(screen.getByTestId("stub-draft-id")).toHaveTextContent("draft-t1");
    expect(vi.mocked(generateGuideDraft)).toHaveBeenCalledTimes(1);

    // 取消草案：活动草案清空，就绪浮条消失（草案未被应用）
    fireEvent.click(screen.getByRole("button", { name: "stub-dismiss" }));
    expect(screen.queryByRole("status", { name: "攻略草案已就绪" })).not.toBeInTheDocument();
  });

  it("失败浮条与重试：面板内展示原因，关闭后浮条可一键按原参数重发并转就绪", async () => {
    useTripMock.mockReturnValue(fakeStore());
    vi.mocked(generateGuideDraft)
      .mockRejectedValueOnce(new ApiError(409, "DRAFT_STALE", "行程已变化，请重新生成草案"))
      .mockResolvedValueOnce(makeDraftResult({ draftId: "draft-t2" }));
    renderTripView();

    openNoteInput();
    fireEvent.click(screen.getByRole("button", { name: "stub-generate" }));
    // 失败原因在面板内就地展示（服务端安全 message 透传）
    await act(async () => {});
    expect(screen.getByTestId("stub-generation-error")).toHaveTextContent(
      "行程已变化，请重新生成草案",
    );

    // 关闭面板：failed 浮条接管，提供重试入口
    fireEvent.click(screen.getByRole("button", { name: "stub-close" }));
    expect(screen.getByRole("alert", { name: "攻略生成失败" })).toBeInTheDocument();

    // 重试：按上一轮入口上下文 / 补充句重发（不打开面板）
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(vi.mocked(generateGuideDraft)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(generateGuideDraft)).toHaveBeenLastCalledWith(
      "trip-test",
      { entryContext: { type: "global" }, note: "stub-note" },
      expect.anything(),
    );

    // 重试成功：失败浮条消失，转就绪
    await act(async () => {});
    expect(screen.queryByRole("alert", { name: "攻略生成失败" })).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "攻略草案已就绪" })).toBeInTheDocument();
  });

  it("任务 204：失败浮条「查看」强制重开 global 面板，不被日卡残留上下文劫持", async () => {
    useTripMock.mockReturnValue(fakeStore());
    vi.mocked(generateGuideDraft).mockRejectedValueOnce(
      new ApiError(500, "INTERNAL", "排程服务这会儿没响应"),
    );
    renderTripView();

    // global 面板发起生成并失败（原因在面板内就地展示）
    openNoteInput();
    expect(screen.getByTestId("stub-open-context")).toHaveTextContent("global");
    fireEvent.click(screen.getByRole("button", { name: "stub-generate" }));
    await act(async () => {});
    expect(screen.getByTestId("stub-generation-error")).toHaveTextContent(
      "排程服务这会儿没响应",
    );

    // 之后从日卡打开面板（noteContext 被残留为 day），关闭 → failed 浮条接管
    fireEvent.click(screen.getByRole("button", { name: "打开 Day 添加面板" }));
    expect(screen.getByTestId("stub-open-context")).toHaveTextContent("day");
    fireEvent.click(screen.getByRole("button", { name: "stub-close" }));
    expect(screen.getByRole("alert", { name: "攻略生成失败" })).toBeInTheDocument();

    // 浮条「查看」：重开为 global 面板（有攻略来源列表与失败原因），而非「添加到 DayN」
    fireEvent.click(screen.getByRole("button", { name: /这一版没排成/ }));
    expect(screen.getByTestId("stub-open-context")).toHaveTextContent("global");
    expect(screen.getByTestId("stub-generation-error")).toHaveTextContent(
      "排程服务这会儿没响应",
    );
  });

  it("兕底超时（315s）：挂死的等待转失败浮条，重开面板见超时文案，迟到成功不假成功", async () => {
    vi.useFakeTimers();
    useTripMock.mockReturnValue(fakeStore());
    let resolveDraft!: (draft: GuideDraftResult) => void;
    vi.mocked(generateGuideDraft).mockImplementation(
      () => new Promise<GuideDraftResult>((resolve) => { resolveDraft = resolve; }),
    );
    renderTripView();

    openNoteInput();
    fireEvent.click(screen.getByRole("button", { name: "stub-generate" }));
    fireEvent.click(screen.getByRole("button", { name: "stub-close" }));
    expect(screen.getByRole("status", { name: "攻略生成进度" })).toBeInTheDocument();

    // 超过服务端 300s 预算 + 缓冲：前端转失败（不假成功）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(315_000);
    });
    expect(screen.getByRole("alert", { name: "攻略生成失败" })).toBeInTheDocument();

    // 重开面板：兜底超时文案（用户语言，不含技术词）
    fireEvent.click(screen.getByRole("button", { name: /这一版没排成/ }));
    expect(screen.getByTestId("stub-generation-error")).toHaveTextContent(
      "等了快五分钟还没排好，可能是网络不稳定，请重试",
    );

    // 迟到的成功响应被丢弃：不转就绪、不误报草案
    await act(async () => {
      resolveDraft(makeDraftResult({ draftId: "draft-late" }));
    });
    expect(screen.queryByRole("status", { name: "攻略草案已就绪" })).not.toBeInTheDocument();
    expect(screen.getByTestId("stub-generation-error")).toHaveTextContent(
      "等了快五分钟还没排好，可能是网络不稳定，请重试",
    );
  });

  it("重载召回：行程已挂新鲜待应用草案时浮条直接就绪，点开直达预览且不重新生成", () => {
    useTripMock.mockReturnValue(fakeStore(tripWithPendingDraft(makePendingDraft())));
    renderTripView();

    expect(screen.queryByTestId("note-input-stub")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "攻略草案已就绪" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /攻略排好了/ }));
    expect(screen.getByTestId("stub-draft-id")).toHaveTextContent("draft-recall");
    expect(vi.mocked(generateGuideDraft)).not.toHaveBeenCalled();
  });

  it("任务 #211：已关闭的草案跨刷新持久化——重载后不再重新召回弹浮条", () => {
    // 第一轮「会话」：召回 → 点开 → 取消草案（draftId 入 localStorage）
    useTripMock.mockReturnValue(fakeStore(tripWithPendingDraft(makePendingDraft())));
    const { unmount } = render(<TripView tripId="trip-test" onNewTrip={vi.fn(async () => true)} />);
    expect(screen.getByRole("status", { name: "攻略草案已就绪" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /攻略排好了/ }));
    fireEvent.click(screen.getByRole("button", { name: "stub-dismiss" }));
    expect(screen.queryByRole("status", { name: "攻略草案已就绪" })).not.toBeInTheDocument();
    unmount();

    // 第二轮「刷新」：同一行程 pendingGuideDraft 仍在（未应用），但不再自动召回弹浮条
    useTripMock.mockReturnValue(fakeStore(tripWithPendingDraft(makePendingDraft())));
    renderTripView();
    expect(screen.queryByRole("status", { name: "攻略草案已就绪" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("note-input-stub")).not.toBeInTheDocument();
  });

  it("Task #263：snippet-only 应用不误报失败——旧生成失败不残留，成功文案按成功展示", async () => {
    const store = fakeStore();
    useTripMock.mockReturnValue(store);
    vi.mocked(generateGuideDraft).mockRejectedValueOnce(
      new ApiError(500, "INTERNAL", "排程服务这会儿没响应"),
    );
    const rendered = render(
      <TripView tripId="trip-test" onNewTrip={vi.fn(async () => true)} />,
    );

    // 1）上一轮确实生成失败：面板内展示原因，关闭后失败浮条接管
    openNoteInput();
    fireEvent.click(screen.getByRole("button", { name: "stub-generate" }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "stub-close" }));
    expect(screen.getByRole("alert", { name: "攻略生成失败" })).toBeInTheDocument();

    // 2）行程刷新带来一份新鲜待应用草案（snippet-only）：就绪优先于旧失败态，
    //    否则「应用成功」与「这一版没排成」会同屏，形成假失败提示
    store.trip = tripWithPendingDraft(makePendingDraft());
    rendered.rerender(<TripView tripId="trip-test" onNewTrip={vi.fn(async () => true)} />);
    expect(screen.queryByRole("alert", { name: "攻略生成失败" })).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "攻略草案已就绪" })).toBeInTheDocument();

    // 3）应用结果 applied=[] + attachedSnippetCount=3：按成功提示，无错误提示
    fireEvent.click(screen.getByRole("button", { name: /攻略排好了/ }));
    fireEvent.click(screen.getByRole("button", { name: "stub-apply" }));
    expect(screen.getByText("行程结构无需变更，已添加 3 条攻略提示")).toBeInTheDocument();
    expect(screen.queryByRole("alert", { name: "攻略生成失败" })).not.toBeInTheDocument();
    expect(screen.queryByText(/失败/)).toBeNull();
    // 应用成功后刷新权威行程（挂载的攻略提示已落盘）
    expect(store.refreshFromServer).toHaveBeenCalled();
  });

  it("过期草案（版本已变化）不召回：无就绪浮条，不给假可用入口", () => {
    const stale = makePendingDraft({ baseTripVersion: 1 });
    const trip = makeTrip();
    trip.version = 3; // ≠ pending.baseTripVersion → stale
    (trip as { pendingGuideDraft?: PendingGuideDraft | null }).pendingGuideDraft = stale;
    useTripMock.mockReturnValue(fakeStore(trip));
    renderTripView();

    expect(screen.queryByRole("status", { name: "攻略草案已就绪" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("note-input-stub")).not.toBeInTheDocument();
  });
});

// ===== Task #224：生成等待分级反馈（离开返回 / 超时衔接） =====

/**
 * 分级快照由行程级会话（useGuideDraftGeneration）持有，面板与底部浮条消费同一份：
 * - 面板开着时浮条隐藏（进度只在面板里说一次，避免重复噪音）；
 * - 关闭面板后浮条接管，时钟继续走（会话不随面板卸载中断，Task #135 既有能力）；
 * - 返回面板时读数接着走，不从 0 重来、也不重发请求；
 * - 315s 兜底超时后分级读数让位给既有失败浮条与重试入口，两者不并存。
 */
describe("TripView 生成等待分级反馈（Task #224）", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 挂起生成请求（不 resolve）：等待时长完全由 fake timers 控制 */
  function startPendingGeneration(): void {
    useTripMock.mockReturnValue(fakeStore());
    vi.mocked(generateGuideDraft).mockImplementation(
      () => new Promise<GuideDraftResult>(() => {}),
    );
    renderTripView();
    openNoteInput();
    fireEvent.click(screen.getByRole("button", { name: "stub-generate" }));
  }

  function toastReading(): string | null {
    return document.querySelector(".draft-toast-stage")?.textContent ?? null;
  }

  it("面板内先走到第三站，离开后浮条接管同一份读数，返回时接着走不重置", async () => {
    vi.useFakeTimers();
    startPendingGeneration();
    expect(vi.mocked(generateGuideDraft)).toHaveBeenCalledTimes(1);

    // 面板开着：浮条隐藏，分级快照在面板视图里（stub 回显）
    expect(screen.queryByRole("status", { name: "攻略生成进度" })).not.toBeInTheDocument();
    expect(screen.getByTestId("stub-generation-stage")).toHaveTextContent("读料|0 秒|steady");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(screen.getByTestId("stub-generation-stage")).toHaveTextContent("排线|20 秒|steady");

    // 离开面板：请求不取消，浮条接管（Task #135），并带上分级读数
    fireEvent.click(screen.getByRole("button", { name: "stub-close" }));
    expect(screen.getByRole("status", { name: "攻略生成进度" })).toHaveAttribute(
      "data-tier",
      "steady",
    );
    expect(toastReading()).toBe("排线 · 已等 20 秒 · 预计还要 2 分钟左右");

    // 离开期间时钟继续走：进入末站，计时改分秒制
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(toastReading()).toBe("成稿 · 已等 1 分 00 秒 · 预计还要 50 秒左右");

    // 返回面板：读数接着走（不回首站、不清零），且不重发请求
    fireEvent.click(screen.getByRole("button", { name: /生成攻略提示和注意事项/ }));
    expect(screen.getByTestId("stub-generation-stage")).toHaveTextContent("成稿|1 分 00 秒|steady");
    expect(vi.mocked(generateGuideDraft)).toHaveBeenCalledTimes(1);
    // 面板打开时浮条让位（同一份进度不在两处重复播报）
    expect(screen.queryByRole("status", { name: "攻略生成进度" })).not.toBeInTheDocument();
  });

  it("兜底超时衔接（315s）：critical 先预警，超时后分级读数让位给失败浮条与重试入口", async () => {
    vi.useFakeTimers();
    startPendingGeneration();
    fireEvent.click(screen.getByRole("button", { name: "stub-close" }));

    // 240s：critical 档先一步给出「取消再试」的出路（离 315s 还有 75s 决策窗口）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(240_000);
    });
    expect(screen.getByRole("status", { name: "攻略生成进度" })).toHaveAttribute(
      "data-tier",
      "critical",
    );
    expect(toastReading()).toContain("等得有点久了，可以先取消再试一次");
    // 软进度轨封顶：等到 critical 也没满格（完成前永不显示 100%）
    const fill = document.querySelector(".draft-toast-rail > i") as HTMLElement;
    expect(Number.parseFloat(fill.style.width)).toBeLessThan(100);

    // 315s：转既有失败浮条，分级读数与进度轨一并收起（不与失败提示并存）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(75_000);
    });
    expect(screen.queryByRole("status", { name: "攻略生成进度" })).not.toBeInTheDocument();
    expect(screen.getByRole("alert", { name: "攻略生成失败" })).toBeInTheDocument();
    expect(toastReading()).toBeNull();
    expect(document.querySelector(".draft-toast-rail")).toBeNull();

    // 既有重试入口照旧可用：重发后新一轮分级读数从头开始
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(vi.mocked(generateGuideDraft)).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status", { name: "攻略生成进度" })).toHaveAttribute(
      "data-tier",
      "steady",
    );
    expect(toastReading()).toContain("读料 · 已等 0 秒");
  });

  it("秒回（不足首站阈值）：完成后浮条直接就绪，不残留任何分级读数", async () => {
    vi.useFakeTimers();
    useTripMock.mockReturnValue(fakeStore());
    let resolveDraft!: (draft: GuideDraftResult) => void;
    vi.mocked(generateGuideDraft).mockImplementation(
      () => new Promise<GuideDraftResult>((resolve) => { resolveDraft = resolve; }),
    );
    renderTripView();
    openNoteInput();
    fireEvent.click(screen.getByRole("button", { name: "stub-generate" }));
    fireEvent.click(screen.getByRole("button", { name: "stub-close" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
      resolveDraft(makeDraftResult());
    });
    expect(screen.getByRole("status", { name: "攻略草案已就绪" })).toBeInTheDocument();
    expect(toastReading()).toBeNull();
    expect(document.querySelector(".draft-toast-rail")).toBeNull();

    // 面板视图也不残留（重开直达草案预览，不再是生成中）
    fireEvent.click(screen.getByRole("button", { name: /攻略排好了/ }));
    expect(screen.getByTestId("stub-generation-active")).toHaveTextContent("false");
    expect(screen.getByTestId("stub-generation-stage")).toHaveTextContent("-");
  });
});

// ===== Task #206：行程内编辑管理约束 =====

describe("TripView 约束编辑（Task #206）", () => {
  it("⋯ 菜单「修改约束」打开浮层；保存经 updateTrip 写回 constraints 并关闭", () => {
    const store = fakeStore();
    useTripMock.mockReturnValue(store);
    renderTripView();

    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /修改约束/ }));
    expect(screen.getByRole("dialog", { name: "修改约束" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("备注（可选）"), {
      target: { value: "酒店退房 12:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: /添加这条约束/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(store.updateTrip).toHaveBeenCalledTimes(1);
    const updater = store.updateTrip.mock.calls[0][0] as (current: Trip) => Trip;
    const next = updater(makeTrip());
    expect(next.constraints).toHaveLength(1);
    expect(next.constraints[0]).toMatchObject({
      type: "flight_arrive",
      anchorTime: "2026-11-08T09:00:00",
      dayIndex: 1,
      label: "酒店退房 12:00",
      locked: true,
    });
    expect(screen.queryByRole("dialog", { name: "修改约束" })).not.toBeInTheDocument();
  });

  it("与近期操作互斥：打开修改约束时近期操作让位；✕ 关闭不写回", () => {
    const store = fakeStore();
    useTripMock.mockReturnValue(store);
    renderTripView();

    openOpLogFromMenu();
    expect(screen.getByRole("dialog", { name: "近期操作" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /修改约束/ }));

    expect(screen.queryByRole("dialog", { name: "近期操作" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "修改约束" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关闭修改约束" }));
    expect(screen.queryByRole("dialog", { name: "修改约束" })).not.toBeInTheDocument();
    expect(store.updateTrip).not.toHaveBeenCalled();
  });
});

// ===== 任务 199：独立景点归入大景点 =====

function makeItem(itemId: string, name: string): Item {
  return {
    itemId,
    name,
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
  };
}

function makeVisit(
  visitId: string,
  pointRef: string,
  kind: Visit["kind"],
  dayRef: string | null,
): Visit {
  return {
    visitId,
    dayRef,
    pointRef,
    kind,
    visitMode: "custom",
    order: 0,
    windowStart: null,
    windowEnd: null,
    startTime: "09:00",
    endTime: null,
    startTimeOverridden: false,
    endTimeOverridden: false,
    reservedMinutes: null,
    effectiveMinutes: 120,
    externalLeg: null,
    childStopRefs: [],
    alternateStopRefs: [],
    sourceMentionRefs: [],
    guideSnippets: [],
    purchaseState: "unknown",
    locked: false,
    userAdjusted: false,
    removedFrom: null,
    removedAt: null,
  };
}

/** 行程：Day1 上一个独立普通景点「情人桥」+ 一个大景点「蜈支洲岛」 */
function tripWithClassifyFixture(): Trip {
  const trip = makeTrip();
  trip.itemRegistry = {
    item_child: makeItem("item_child", "情人桥"),
    item_parent: makeItem("item_parent", "蜈支洲岛"),
  };
  trip.visits = {
    visit_child: makeVisit("visit_child", "item_child", "ordinary", "day_1"),
    visit_parent: makeVisit("visit_parent", "item_parent", "large_attraction", "day_1"),
  };
  trip.days.day_1!.scheduleVisitRefs = ["visit_child", "visit_parent"];
  return trip;
}

describe("TripView 独立景点归入大景点（任务 199）", () => {
  it("选目标后先二次确认，确认才调用 classifyVisitAsParentStop", () => {
    const store = fakeStore(tripWithClassifyFixture());
    useTripMock.mockReturnValue(store);
    renderTripView();

    fireEvent.click(screen.getByRole("button", { name: "打开归类" }));
    const dialog = screen.getByRole("dialog", { name: "选择目标大景点" });

    // 日卡 chip 的 flag 也会渲染大景点名，故在浮层作用域内定位选项
    fireEvent.click(within(dialog).getByRole("button", { name: /蜈支洲岛/ }));
    // 选择只打开二次确认，不直接执行（原 Visit 会被删除，不可逆）
    expect(store.classifyVisitAsParentStop).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "归入大景点" })).toBeInTheDocument();
    expect(
      screen.getByText(/将「情人桥」归入「蜈支洲岛」？归入后将显示为蜈支洲岛的内部玩法/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认归入" }));
    expect(store.classifyVisitAsParentStop).toHaveBeenCalledTimes(1);
    expect(store.classifyVisitAsParentStop).toHaveBeenCalledWith("visit_child", "visit_parent");
    expect(screen.queryByRole("dialog", { name: "归入大景点" })).not.toBeInTheDocument();
  });

  it("取消目标选择不产生归类", () => {
    const store = fakeStore(tripWithClassifyFixture());
    useTripMock.mockReturnValue(store);
    renderTripView();

    fireEvent.click(screen.getByRole("button", { name: "打开归类" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "选择目标大景点" })).getByRole("button", {
        name: "取消",
      }),
    );
    expect(screen.queryByRole("dialog", { name: "选择目标大景点" })).not.toBeInTheDocument();
    expect(store.classifyVisitAsParentStop).not.toHaveBeenCalled();
  });

  it("已锁定的大景点不可作为目标，候选池（dayRef=null）不列入选项", () => {
    const trip = tripWithClassifyFixture();
    trip.visits.visit_parent = { ...trip.visits.visit_parent!, locked: true };
    trip.visits.visit_pool = makeVisit("visit_pool", "item_parent", "large_attraction", null);
    const store = fakeStore(trip);
    useTripMock.mockReturnValue(store);
    renderTripView();

    fireEvent.click(screen.getByRole("button", { name: "打开归类" }));
    const dialog = screen.getByRole("dialog", { name: "选择目标大景点" });
    expect(within(dialog).getByRole("button", { name: /蜈支洲岛.*已锁定/ })).toBeDisabled();
    // 候选池的大景点壳不列入选项（dayRef=null 归入后不可见）
    expect(within(dialog).getAllByRole("button", { name: /蜈支洲岛/ })).toHaveLength(1);
  });

  /**
   * Task #360（PD 2026-11-10 拍板）：浮层目标列表由全局常量改为随源 visit 过滤，
   * 只列距离合格（双方有坐标 ≤2km；任一方无坐标→同天）的大景点。
   * 坐标取自验收行程 server/data/0a27f726。
   */
  function tripWithDistanceFixture(): Trip {
    const trip = tripWithClassifyFixture();
    trip.itemRegistry = {
      // 源：玻璃栈道（与森林公园 0.20km，与鹿回头 超 2km）
      item_child: { ...makeItem("item_child", "玻璃栈道"), coords: { lng: 109.643092, lat: 18.251821 } },
      item_parent: {
        ...makeItem("item_parent", "亚龙湾热带天堂森林公园"),
        coords: { lng: 109.643059, lat: 18.253643 },
      },
      item_far: { ...makeItem("item_far", "鹿回头"), coords: { lng: 109.50131, lat: 18.225639 } },
    };
    trip.visits.visit_far = makeVisit("visit_far", "item_far", "large_attraction", "day_1");
    trip.days.day_1!.scheduleVisitRefs = ["visit_child", "visit_parent", "visit_far"];
    return trip;
  }

  it("Task #360：浮层只列 2km 内的合格目标，同天但超阈的大景点不入列", () => {
    const store = fakeStore(tripWithDistanceFixture());
    useTripMock.mockReturnValue(store);
    renderTripView();

    fireEvent.click(screen.getByRole("button", { name: "打开归类" }));
    const dialog = screen.getByRole("dialog", { name: "选择目标大景点" });
    const options = within(dialog).getAllByRole("button", { name: /Day1/ });
    expect(options).toHaveLength(1);
    expect(options[0]?.textContent).toContain("亚龙湾热带天堂森林公园");
    // 鹿回头同天但 >2km → 不再作为可选目标（旧全局列表会列出两个）
    expect(within(dialog).queryByRole("button", { name: /鹿回头/ })).toBeNull();
  });

  it("Task #360：无坐标双方同天仍入列（兜底）；跨天则不入列", () => {
    const sameDay = fakeStore(tripWithClassifyFixture());
    useTripMock.mockReturnValue(sameDay);
    renderTripView();
    fireEvent.click(screen.getByRole("button", { name: "打开归类" }));
    expect(
      within(screen.getByRole("dialog", { name: "选择目标大景点" })).getByRole("button", {
        name: /亚龙湾热带天堂森林公园|蜈支洲岛/,
      }),
    ).toBeInTheDocument();
    cleanup();

    const crossDay = tripWithClassifyFixture();
    crossDay.visits.visit_parent = makeVisit(
      "visit_parent",
      "item_parent",
      "large_attraction",
      "day_2",
    );
    useTripMock.mockReturnValue(fakeStore(crossDay));
    renderTripView();
    fireEvent.click(screen.getByRole("button", { name: "打开归类" }));
    const dialog = screen.getByRole("dialog", { name: "选择目标大景点" });
    expect(within(dialog).queryAllByRole("button", { name: /蜈支洲岛/ })).toHaveLength(0);
  });
});

// ===== Task #258：行程封面紧凑入口 + 浮层（取代 #257 的顶部内嵌封面卡） =====

describe("TripView 行程封面（Task #258）", () => {
  it("顶部只有一行紧凑入口，位于 Day 切换条之前；封面大图不再内嵌在行程页", () => {
    renderTripView();

    const bar = document.querySelector(".cover-bar");
    const daystrip = document.querySelector(".daystrip-wrap");
    expect(bar).not.toBeNull();
    expect(daystrip).not.toBeNull();
    // DOM 顺序：入口行在 Day 标签条之前
    expect(bar!.compareDocumentPosition(daystrip!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // 内嵌封面卡（.trip-cover / 封面图 / 备忘块）已彻底移出页面，首屏高度还给 Day 内容
    expect(document.querySelector(".trip-cover")).toBeNull();
    expect(document.querySelector(".trip-cover-wash")).toBeNull();

    // 旧行程（无 coverImage / tripName / memo）→ 默认名 + 信息行 + 渐变缩略块
    expect(screen.getByRole("button", { name: /行程封面：我的行程/ })).toBeInTheDocument();
    expect(screen.getByText("三亚 · 2天1晚")).toBeInTheDocument();
    expect(document.querySelector(".cover-bar-wash")).not.toBeNull();
    // 浮层默认不挂载（不占 DOM、不遮行程）
    expect(screen.queryByRole("dialog", { name: "行程封面" })).toBeNull();
  });

  it("点入口打开浮层；改名与备忘失焦后经 updateTrip 写回，关闭后入口行实时更新", () => {
    const store = fakeStore();
    useTripMock.mockReturnValue(store);
    const { rerender } = render(<TripView tripId="trip-test" onNewTrip={vi.fn(async () => true)} />);

    fireEvent.click(screen.getByRole("button", { name: /行程封面/ }));
    expect(screen.getByRole("dialog", { name: "行程封面" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /行程名称：我的行程/ }));
    const nameInput = screen.getByLabelText("行程名称");
    fireEvent.change(nameInput, { target: { value: "三亚亲子五日" } });
    fireEvent.blur(nameInput);

    expect(store.updateTrip).toHaveBeenCalledTimes(1);
    const nameUpdater = store.updateTrip.mock.calls[0][0] as (current: Trip) => Trip;
    expect(nameUpdater(makeTrip()).tripName).toBe("三亚亲子五日");

    // 备忘在浮层内默认展开，无需先点「展开 / 写备忘」
    const memoInput = screen.getByLabelText("备忘录");
    fireEvent.change(memoInput, { target: { value: "记得带身份证" } });
    fireEvent.blur(memoInput);

    expect(store.updateTrip).toHaveBeenCalledTimes(2);
    const memoUpdater = store.updateTrip.mock.calls[1][0] as (current: Trip) => Trip;
    expect(memoUpdater(makeTrip()).memo).toBe("记得带身份证");

    // 关闭浮层 → 回到行程：Day 标签仍在，入口行接上新的 trip 状态
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    expect(screen.queryByRole("dialog", { name: "行程封面" })).toBeNull();
    expect(document.querySelector(".daystrip-wrap")).not.toBeNull();

    useTripMock.mockReturnValue({ ...store, trip: { ...makeTrip(), tripName: "三亚亲子五日" } });
    rerender(<TripView tripId="trip-test" onNewTrip={vi.fn(async () => true)} />);
    expect(screen.getByText("三亚亲子五日")).toBeInTheDocument();
  });

  it("封面浮层与近期操作互斥：任一浮层打开时另一个让位", () => {
    renderTripView();

    openOpLogFromMenu();
    expect(screen.getByRole("dialog", { name: "近期操作" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /行程封面/ }));
    expect(screen.getByRole("dialog", { name: "行程封面" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "近期操作" })).toBeNull();

    // 反向：近期操作打开时，封面浮层自关（挂载广播 → TripView 收口）
    openOpLogFromMenu();
    expect(screen.getByRole("dialog", { name: "近期操作" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "行程封面" })).toBeNull();
  });

  it("上传封面：在浮层内选图，落盘后把受控路径写回 Trip.coverImage；移除时清空字段并调删除接口", async () => {
    const store = fakeStore({ ...makeTrip(), coverImage: "uploads/trip-test/cover.jpg" });
    useTripMock.mockReturnValue(store);
    vi.mocked(uploadTripCover).mockResolvedValue({ coverImage: "uploads/trip-test/cover.png" });
    vi.mocked(deleteTripCover).mockResolvedValue(undefined);
    renderTripView();

    fireEvent.click(screen.getByRole("button", { name: /行程封面/ }));
    const file = new File(["x"], "cover.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("选择封面图片"), { target: { files: [file] } });

    await waitFor(() => expect(uploadTripCover).toHaveBeenCalledWith("trip-test", file));
    await waitFor(() => expect(store.updateTrip).toHaveBeenCalledTimes(1));
    const uploadUpdater = store.updateTrip.mock.calls[0][0] as (current: Trip) => Trip;
    expect(uploadUpdater({ ...makeTrip(), coverImage: "uploads/trip-test/cover.jpg" }).coverImage).toBe(
      "uploads/trip-test/cover.png",
    );

    // 删除文件先清字段（UI 立即回到渐变兜底）
    fireEvent.click(screen.getByRole("button", { name: "移除封面" }));
    const removeUpdater = store.updateTrip.mock.calls[1][0] as (current: Trip) => Trip;
    const tripWithCover = { ...makeTrip(), coverImage: "uploads/trip-test/cover.png" };
    expect(removeUpdater(tripWithCover).coverImage).toBeUndefined();
    expect(deleteTripCover).toHaveBeenCalledWith("trip-test");
  });

  it("上传失败：把服务端文案展示在浮层内，不修改 Trip", async () => {
    const store = fakeStore();
    useTripMock.mockReturnValue(store);
    vi.mocked(uploadTripCover).mockRejectedValue(new ApiError(400, "INTERNAL", "请选择 JPG / PNG / WebP 图片"));
    renderTripView();

    fireEvent.click(screen.getByRole("button", { name: /行程封面/ }));
    const file = new File(["x"], "cover.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("选择封面图片"), { target: { files: [file] } });

    expect(await screen.findByRole("alert")).toHaveTextContent("请选择 JPG / PNG / WebP 图片");
    expect(store.updateTrip).not.toHaveBeenCalled();
  });
});
