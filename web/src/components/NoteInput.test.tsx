/**
 * 任务 188：统一添加面板攻略来源删除二次确认——NoteInput 端到端链路测试。
 *
 * GuideSourceList 层单测已覆盖弹窗交互本身（打开 / 取消 / 遮罩 / 连点 / 文案）；
 * 这里聚焦确认后走既有软移除链路的行为语义：
 * - 确认成功：removeGuideSource 调用一次，列表剔除并 onExtracted 通知父组件刷新；
 * - 确认失败（ApiError）：保留现有错误提示语义（submitError 展示服务端 message），
 *   来源仍留在列表，sourceBusy 复位后可再次发起；
 * - 删除进行中：列表全部 ✕ 禁用（busy 含 sourceBusy，防重复请求），完成后恢复；
 * - 取消 / 点遮罩关闭：不调删除 API、不改来源状态、不影响当前行程。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Profiler } from "react";
import type { GuideSource, SourceEvidence, Trip } from "@goplay/shared";
import NoteInput from "./NoteInput";
import type { GuideDraftGenerateInput, GuideDraftGenerationView } from "./GuideDraftPanel";
import {
  ApiError,
  applyGuideDraft,
  listGuideSources,
  removeGuideSource,
  submitGuideSourceLink,
  submitGuideSourceText,
  type GuideDraftApplyResult,
  type GuideDraftResult,
} from "../api/client";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../api/client", async (importOriginal) => {
  // 保留 ApiError / flyAiErrorMessage 等真实实现，仅桩掉网络函数
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    applyGuideDraft: vi.fn(),
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

function makeSource(overrides: Partial<GuideSource> = {}): GuideSource {
  return {
    sourceId: "src_1",
    sourceVersion: 1,
    inputKind: "text",
    active: true,
    status: "ready",
    evidenceRefs: [],
    mentionRefs: [],
    imageProgress: { total: 0, completed: 0, failed: 0, images: [] },
    importedAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    ...overrides,
  };
}

function makeTripWithSources(
  sources: GuideSource[],
  evidences: Record<string, SourceEvidence> = {},
): Trip {
  const guideSources: Record<string, GuideSource> = {};
  for (const source of sources) guideSources[source.sourceId] = source;
  return {
    tripId: "trip-test",
    schemaVersion: 2,
    version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: "2026-11-10", nights: 2 },
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
    evidences,
    globalCandidateRefs: [],
    pendingStopRefs: [],
    relationshipSuggestions: {},
    guideSources,
    constraints: [],
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
  };
}

const idleGeneration: GuideDraftGenerationView = { active: false, text: null, error: null };

interface NoteInputOverrides {
  onGenerateDraft?: (input: GuideDraftGenerateInput) => void;
  onClose?: () => void;
  /** Task #263：预置活动草案，直接渲染 GuideDraftReview 以覆盖「应用」链路 */
  draft?: GuideDraftResult | null;
  onDraftApplied?: (result: GuideDraftApplyResult) => void;
}

/** NoteInput 元素构造（Task #245）：rerender 复用同一棵树，模拟父组件轮询刷新 trip */
function noteInputElement(
  trip: Trip,
  onExtracted: () => void = vi.fn(),
  overrides: NoteInputOverrides = {},
) {
  return (
    <NoteInput
      tripId="trip-test"
      trip={trip}
      cityName="三亚"
      dayIndex={1}
      checkIn="2026-11-08"
      checkOut="2026-11-09"
      openContext={{ type: "global" }}
      onExtracted={onExtracted}
      onAddCandidate={vi.fn()}
      onUndoAddCandidate={vi.fn()}
      onQuickAdd={vi.fn()}
      onDraftApplied={overrides.onDraftApplied ?? vi.fn()}
      onProposalNeeded={vi.fn()}
      generation={idleGeneration}
      onGenerateDraft={overrides.onGenerateDraft ?? vi.fn()}
      onCancelGenerateDraft={vi.fn()}
      draft={overrides.draft ?? null}
      onDraftDismiss={vi.fn()}
      onClose={overrides.onClose ?? vi.fn()}
    />
  );
}

function renderNoteInput(
  trip: Trip,
  onExtracted: () => void = vi.fn(),
  overrides: NoteInputOverrides = {},
) {
  return render(noteInputElement(trip, onExtracted, overrides));
}

/**
 * 读取 styles.css 源文本供样式契约断言：jsdom 无真实布局，单滚动容器 / 输入框
 * 高度这类「布局事实」只能对样式源断言。vitest 从 web 包目录运行，兼容仓库根。
 */
function readStylesCss(): string {
  for (const relative of ["src/styles.css", "web/src/styles.css"]) {
    const absolute = resolve(process.cwd(), relative);
    if (existsSync(absolute)) return readFileSync(absolute, "utf8");
  }
  throw new Error("styles.css not found from cwd");
}

/** 取出某个选择器的规则体（只匹配行首选择器，避免命中后代选择器） */
function cssRuleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, "m").exec(css);
  return match?.[1] ?? "";
}

beforeEach(() => {
  vi.mocked(listGuideSources).mockResolvedValue({ sources: [], tripVersion: 1 });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("NoteInput 来源删除二次确认端到端（任务 188）", () => {
  it("确认移除成功：软移除 API 调用一次，列表剔除并通知父组件刷新", async () => {
    const source = makeSource({ sourceId: "src_1", title: "三亚攻略" });
    vi.mocked(listGuideSources).mockResolvedValue({ sources: [source], tripVersion: 1 });
    vi.mocked(removeGuideSource).mockResolvedValue({ ...source, active: false });
    const onExtracted = vi.fn();
    renderNoteInput(makeTripWithSources([source]), onExtracted);

    // 点 ✕ 只弹确认，API 未被调用
    fireEvent.click(await screen.findByLabelText("移除该攻略"));
    expect(screen.getByRole("dialog", { name: "移除攻略来源" })).toBeInTheDocument();
    expect(vi.mocked(removeGuideSource)).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "移除" }));

    await waitFor(() => {
      expect(vi.mocked(removeGuideSource)).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(removeGuideSource)).toHaveBeenCalledWith("trip-test", "src_1");
    // 列表剔除（唯一来源移除后回落空态，可访问树中不再有已添加来源容器）
    await waitFor(() => {
      expect(screen.queryByLabelText("已添加的攻略来源")).toBeNull();
    });
    expect(onExtracted).toHaveBeenCalledTimes(1);
  });

  it("确认移除失败：展示服务端错误提示，来源保留且可再次发起", async () => {
    const source = makeSource({ sourceId: "src_1", title: "三亚攻略" });
    vi.mocked(listGuideSources).mockResolvedValue({ sources: [source], tripVersion: 1 });
    vi.mocked(removeGuideSource)
      .mockRejectedValueOnce(new ApiError(404, "SOURCE_NOT_FOUND", "来源已不存在"))
      .mockResolvedValue({ ...source, active: false });
    renderNoteInput(makeTripWithSources([source]));

    fireEvent.click(await screen.findByLabelText("移除该攻略"));
    fireEvent.click(screen.getByRole("button", { name: "移除" }));

    // 既有错误提示语义：ApiError.message 展示在 alert 区
    expect(await screen.findByRole("alert")).toHaveTextContent("来源已不存在");
    // 来源仍在列表（软移除未生效，状态不变）
    expect(screen.getByText("已添加 1 篇")).toBeInTheDocument();

    // sourceBusy 复位后可再次发起第二次确认重试
    fireEvent.click(screen.getByLabelText("移除该攻略"));
    fireEvent.click(screen.getByRole("button", { name: "移除" }));
    await waitFor(() => {
      expect(vi.mocked(removeGuideSource)).toHaveBeenCalledTimes(2);
    });
  });

  it("删除进行中：列表全部 ✕ 禁用（防重复请求），完成后恢复且来源剔除", async () => {
    const sourceA = makeSource({ sourceId: "src_a", title: "攻略A" });
    const sourceB = makeSource({ sourceId: "src_b", title: "攻略B" });
    vi.mocked(listGuideSources).mockResolvedValue({
      sources: [sourceA, sourceB],
      tripVersion: 1,
    });
    let resolveRemove: (value: GuideSource) => void = () => {};
    vi.mocked(removeGuideSource).mockImplementation(
      () =>
        new Promise<GuideSource>((resolve) => {
          resolveRemove = resolve;
        }),
    );
    renderNoteInput(makeTripWithSources([sourceA, sourceB]));

    const removes = await screen.findAllByLabelText("移除该攻略");
    expect(removes).toHaveLength(2);
    fireEvent.click(removes[0] as Element);
    fireEvent.click(screen.getByRole("button", { name: "移除" }));

    // 删除请求进行中：所有来源的 ✕ 均禁用（busy 含 sourceBusy），不能重复发起
    await waitFor(() => {
      const buttons = screen.getAllByLabelText("移除该攻略");
      expect(buttons).toHaveLength(2);
      for (const button of buttons) expect(button).toBeDisabled();
    });

    // 请求完成：按钮恢复可点，来源 A 已剔除
    resolveRemove({ ...sourceA, active: false });
    await waitFor(() => {
      expect(screen.getByLabelText("移除该攻略")).toBeEnabled();
    });
    expect(screen.getByText("已添加 1 篇")).toBeInTheDocument();
    expect(vi.mocked(removeGuideSource)).toHaveBeenCalledTimes(1);
  });

  it("取消确认：不调用删除 API，来源与列表状态不变", async () => {
    const source = makeSource({ sourceId: "src_1", title: "三亚攻略" });
    vi.mocked(listGuideSources).mockResolvedValue({ sources: [source], tripVersion: 1 });
    renderNoteInput(makeTripWithSources([source]));

    fireEvent.click(await screen.findByLabelText("移除该攻略"));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(screen.queryByRole("dialog", { name: "移除攻略来源" })).toBeNull();
    expect(vi.mocked(removeGuideSource)).not.toHaveBeenCalled();
    expect(screen.getByText("已添加 1 篇")).toBeInTheDocument();
  });

  it("点遮罩关闭确认：不调用删除 API，来源不变", async () => {
    const source = makeSource({ sourceId: "src_1", title: "三亚攻略" });
    vi.mocked(listGuideSources).mockResolvedValue({ sources: [source], tripVersion: 1 });
    renderNoteInput(makeTripWithSources([source]));

    fireEvent.click(await screen.findByLabelText("移除该攻略"));
    fireEvent.click(document.querySelector(".confirm-overlay") as Element);

    expect(screen.queryByRole("dialog", { name: "移除攻略来源" })).toBeNull();
    expect(vi.mocked(removeGuideSource)).not.toHaveBeenCalled();
    expect(screen.getByText("已添加 1 篇")).toBeInTheDocument();
  });
});

function makeEvidence(evidenceId: string): SourceEvidence {
  return {
    evidenceId,
    kind: "note_text",
    noteIndex: null,
    assetRef: null,
    sourceUrl: null,
    ocrText: "第一天 亚龙湾",
    mentions: [],
    assetPath: null,
  };
}

/** 新保存的攻略（staged=true）+ 可读证据：默认可选、默认勾选 */
function stagedUsableSource(sourceId: string, title: string, evidenceId: string): GuideSource {
  return makeSource({ sourceId, title, staged: true, evidenceRefs: [evidenceId] });
}

describe("NoteInput 攻略勾选 → 底部 CTA（Task #236）", () => {
  it("新攻略默认暂存且默认勾选：列表受控，CTA 篇数随勾选变化并真实携带 sourceIds", async () => {
    const sources = [
      stagedUsableSource("src_a", "新攻略A", "ev_a"),
      stagedUsableSource("src_b", "新攻略B", "ev_b"),
    ];
    vi.mocked(listGuideSources).mockResolvedValue({ sources, tripVersion: 1 });
    const onGenerateDraft = vi.fn();
    renderNoteInput(
      makeTripWithSources(sources, { ev_a: makeEvidence("ev_a"), ev_b: makeEvidence("ev_b") }),
      vi.fn(),
      { onGenerateDraft },
    );

    // 默认勾选两篇暂存来源（保存 ≠ 改行程，仍需用户点 CTA）
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "AI 生成行程 · 已选 2 篇" })).toBeEnabled();
    });
    expect(screen.getByLabelText("选择攻略 新攻略A")).toBeChecked();
    expect(screen.getByLabelText("选择攻略 新攻略B")).toBeChecked();

    // 取消勾选一篇：CTA 与请求体同步收敛
    fireEvent.click(screen.getByLabelText("选择攻略 新攻略A"));
    expect(screen.getByLabelText("选择攻略 新攻略A")).not.toBeChecked();
    const primary = screen.getByRole("button", { name: "AI 生成行程 · 已选 1 篇" });
    expect(primary).toBeEnabled();
    fireEvent.click(primary);

    expect(onGenerateDraft).toHaveBeenCalledTimes(1);
    expect(onGenerateDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceMode: "selected",
        selectedSourceIds: ["src_b"],
        usableCount: 1,
      }),
    );
  });

  it("软移除来源后选择集合安全收敛：CTA 篇数随动，请求体无残留 id", async () => {
    const sources = [
      stagedUsableSource("src_a", "新攻略A", "ev_a"),
      stagedUsableSource("src_b", "新攻略B", "ev_b"),
    ];
    vi.mocked(listGuideSources).mockResolvedValue({ sources, tripVersion: 1 });
    vi.mocked(removeGuideSource).mockResolvedValue({ ...sources[0]!, active: false });
    const onGenerateDraft = vi.fn();
    renderNoteInput(
      makeTripWithSources(sources, { ev_a: makeEvidence("ev_a"), ev_b: makeEvidence("ev_b") }),
      vi.fn(),
      { onGenerateDraft },
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "AI 生成行程 · 已选 2 篇" })).toBeEnabled();
    });

    // 两篇大卡片：第一行对应 src_a
    fireEvent.click(screen.getAllByLabelText("移除该攻略")[0] as Element);
    fireEvent.click(screen.getByRole("button", { name: "移除" }));

    const primary = await screen.findByRole("button", { name: "AI 生成行程 · 已选 1 篇" });
    expect(screen.queryByLabelText("选择攻略 新攻略A")).toBeNull();
    fireEvent.click(primary);
    expect(onGenerateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ sourceMode: "selected", selectedSourceIds: ["src_b"] }),
    );
  });

  it("「仅暂存，稍后处理」只关闭面板：不发起生成、不改后端状态", async () => {
    const sources = [stagedUsableSource("src_a", "新攻略A", "ev_a")];
    vi.mocked(listGuideSources).mockResolvedValue({ sources, tripVersion: 1 });
    const onGenerateDraft = vi.fn();
    const onClose = vi.fn();
    renderNoteInput(
      makeTripWithSources(sources, { ev_a: makeEvidence("ev_a") }),
      vi.fn(),
      { onGenerateDraft, onClose },
    );

    fireEvent.click(await screen.findByRole("button", { name: "仅暂存，稍后处理" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onGenerateDraft).not.toHaveBeenCalled();
    // 只调了一次关闭（没有额外删除 / 重试请求）
    expect(vi.mocked(removeGuideSource)).not.toHaveBeenCalled();
  });

  it("暂无可用素材：CTA 禁用并提示先勾选 / 处理中，点击不发起生成", async () => {
    const sources = [
      makeSource({ sourceId: "src_p", title: "处理中攻略", staged: true, status: "processing" }),
    ];
    vi.mocked(listGuideSources).mockResolvedValue({ sources, tripVersion: 1 });
    const onGenerateDraft = vi.fn();
    renderNoteInput(makeTripWithSources(sources), vi.fn(), { onGenerateDraft });

    const primary = await screen.findByRole("button", { name: "攻略处理中，完成后亮起" });
    expect(primary).toBeDisabled();
    fireEvent.click(primary);
    expect(onGenerateDraft).not.toHaveBeenCalled();
    // 处理中来源勾选框禁用，不会被默默选中
    expect(screen.getByLabelText(/选择攻略 处理中攻略/)).toBeDisabled();
  });

  it("面板层级：录入区在上 → 带勾选的素材列表 → 底部生成 CTA；保存/图片按钮收在录入框内", async () => {
    const sources = [stagedUsableSource("src_a", "新攻略A", "ev_a")];
    vi.mocked(listGuideSources).mockResolvedValue({ sources, tripVersion: 1 });
    renderNoteInput(makeTripWithSources(sources, { ev_a: makeEvidence("ev_a") }));

    const textarea = screen.getByPlaceholderText("粘贴攻略链接 / 文字，或输入景点、酒店名");
    const list = await screen.findByLabelText("已添加的攻略来源");
    const primary = screen.getByRole("button", { name: "AI 生成行程 · 已选 1 篇" });
    expect(
      textarea.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(list.compareDocumentPosition(primary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // 录入区动作（🖼 + 保存）在 textarea 之后的同一操作行内，不再占满整行
    const box = document.querySelector(".note-input-box");
    const actions = document.querySelector(".note-input-actions");
    expect(box).not.toBeNull();
    expect(actions).not.toBeNull();
    expect(box?.contains(textarea)).toBe(true);
    expect(box?.contains(actions)).toBe(true);
    expect(actions?.contains(screen.getByLabelText("上传截图"))).toBe(true);
    expect(
      textarea.compareDocumentPosition(actions as Element) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // Task #240：浏览器验收曾看到「攻略列表在录入区之上」。源码顺序由本用例锁定：
  // 断言的是两个区块元素本身在滚动正文 .note-input-body 直接子节点中的先后，
  // 不是「同一父容器存在」。
  it("Task #240：录入区 .note-input-box 必须排在攻略列表 .guide-source-list 之前", async () => {
    const sources = [stagedUsableSource("src_a", "新攻略A", "ev_a")];
    vi.mocked(listGuideSources).mockResolvedValue({ sources, tripVersion: 1 });
    renderNoteInput(makeTripWithSources(sources, { ev_a: makeEvidence("ev_a") }));

    const sheet = document.querySelector(".note-input-sheet");
    expect(sheet).not.toBeNull();
    const body = sheet?.querySelector(".note-input-body") ?? null;
    expect(body).not.toBeNull();
    const box = body?.querySelector(".note-input-box") ?? null;
    const list = await screen.findByLabelText("已添加的攻略来源");

    // 两者必须同属滚动正文的直接子区块，且互不包裹（排除嵌套造成的假顺序）
    const children = Array.from(body?.children ?? []);
    expect(children).toContain(box);
    expect(children).toContain(list);
    expect(box?.contains(list)).toBe(false);
    expect(list.contains(box)).toBe(false);

    // DOM 顺序：录入区 → 攻略列表 → 底部生成 CTA
    const boxIndex = box === null ? -1 : children.indexOf(box);
    const listIndex = children.indexOf(list);
    expect(boxIndex).toBeGreaterThanOrEqual(0);
    expect(listIndex).toBeGreaterThan(boxIndex);
    expect(
      (box as Element).compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const primary = screen.getByRole("button", { name: "AI 生成行程 · 已选 1 篇" });
    expect(list.compareDocumentPosition(primary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("单篇 failed 来源：勾选框仍渲染但禁用（不可选 ≠ 隐藏），提示需先重试", async () => {
    const failed = makeSource({
      sourceId: "src_f",
      title: "失败攻略",
      status: "failed",
      staged: true,
      evidenceRefs: ["ev_f"],
      failureMessage: "链接抓取失败",
    });
    vi.mocked(listGuideSources).mockResolvedValue({ sources: [failed], tripVersion: 1 });
    renderNoteInput(makeTripWithSources([failed], { ev_f: makeEvidence("ev_f") }));

    const checkbox = await screen.findByLabelText(/选择攻略 失败攻略/);
    expect(checkbox).toBeDisabled();
    expect(checkbox).not.toBeChecked();
    expect(checkbox.getAttribute("aria-label")).toContain("解析失败");
    // 少于 4 篇仍是大卡片列表（不是紧凑单行），失败原因可见
    expect(document.querySelector(".guide-source-list.compact")).toBeNull();
    expect(screen.getByText("链接抓取失败")).toBeInTheDocument();
  });
});

/** 4 篇暂存可用来源：触发紧凑列表（>=4 篇阈值） */
function fourStagedSources(): { sources: GuideSource[]; evidences: Record<string, SourceEvidence> } {
  const sources = [
    stagedUsableSource("src_a", "新攻略A", "ev_a"),
    stagedUsableSource("src_b", "新攻略B", "ev_b"),
    stagedUsableSource("src_c", "新攻略C", "ev_c"),
    stagedUsableSource("src_d", "新攻略D", "ev_d"),
  ];
  return {
    sources,
    evidences: {
      ev_a: makeEvidence("ev_a"),
      ev_b: makeEvidence("ev_b"),
      ev_c: makeEvidence("ev_c"),
      ev_d: makeEvidence("ev_d"),
    },
  };
}

describe("NoteInput 统一添加面板首屏与单滚动（Task #242）", () => {
  // 用户验收：“打开面板看不见 AI 排行程 / 暂存攻略”。根因是行动区放在
  // .draft-panel 内靠 sticky 吸底，父盒已在滚动区外时 sticky 无法把它拉进首屏。
  // 修复后行动区是 Sheet 的直接子节点 .note-input-foot，本用例锁定这一结构。
  it("首屏结构：主 CTA 与「仅暂存，稍后处理」在 Sheet 固定 footer，不被来源列表包裹", async () => {
    const { sources, evidences } = fourStagedSources();
    vi.mocked(listGuideSources).mockResolvedValue({ sources, tripVersion: 1 });
    renderNoteInput(makeTripWithSources(sources, evidences));

    const primary = await screen.findByRole("button", { name: "AI 生成行程 · 已选 4 篇" });
    const saveLater = screen.getByRole("button", { name: "仅暂存，稍后处理" });
    const sheet = document.querySelector(".note-input-sheet") as HTMLElement | null;
    const body = document.querySelector(".note-input-body") as HTMLElement | null;
    const foot = document.querySelector(".note-input-foot") as HTMLElement | null;
    const list = screen.getByLabelText("已添加的攻略来源");

    expect(sheet).not.toBeNull();
    expect(body).not.toBeNull();
    expect(foot).not.toBeNull();
    const children = Array.from(sheet?.children ?? []);

    // footer 与滚动正文是 Sheet 的平级直接子节点（footer 不在滚动区内，无需滚动即可见）
    expect(children).toContain(body);
    expect(children).toContain(foot);
    expect(body?.contains(foot)).toBe(false);
    expect(children.indexOf(foot as Element)).toBeGreaterThan(children.indexOf(body as Element));

    // 两个行动都在视觉 footer 里，且 footer 不在来源列表内部
    expect(foot?.contains(primary)).toBe(true);
    expect(foot?.contains(saveLater)).toBe(true);
    expect(list.contains(foot as Element)).toBe(false);
    expect(list.contains(primary)).toBe(false);
  });

  it("样式契约：Sheet 自身不滚动，只有 .note-input-body 单滚动", () => {
    const css = readStylesCss();
    const sheetRule = cssRuleBody(css, ".note-input-sheet");
    expect(sheetRule).toContain("display: flex");
    expect(sheetRule).toContain("flex-direction: column");
    expect(sheetRule).toContain("overflow: hidden");
    // Sheet 不能自己变成滚动容器（否则 footer 会随内容滑走）
    expect(sheetRule).not.toMatch(/overflow-y:\s*(auto|scroll)/);

    const bodyRule = cssRuleBody(css, ".note-input-body");
    expect(bodyRule).toMatch(/overflow-y:\s*auto/);
    expect(bodyRule).toContain("min-height: 0");

    // 行动区是 flex 尾部（不收缩、不在滚动链上）
    expect(cssRuleBody(css, ".note-input-foot")).toContain("flex: 0 0 auto");
  });

  it("样式契约：紧凑列表无内部滚动/高度上限，手势交给外层 Sheet", async () => {
    const { sources, evidences } = fourStagedSources();
    vi.mocked(listGuideSources).mockResolvedValue({ sources, tripVersion: 1 });
    renderNoteInput(makeTripWithSources(sources, evidences));

    const list = await screen.findByLabelText("已添加的攻略来源");
    expect(list.className).toContain("compact");
    expect(list.querySelector(".guide-compact-rows")).not.toBeNull();
    // 旧的内层滚动容器已不存在
    expect(list.querySelector(".guide-source-scroll")).toBeNull();

    const css = readStylesCss();
    expect(css).not.toContain(".guide-source-scroll {");
    const rowsRule = cssRuleBody(css, ".guide-compact-rows");
    expect(rowsRule).not.toMatch(/overflow(-y)?:\s*(auto|scroll)/);
    expect(rowsRule).not.toContain("max-height");
    expect(rowsRule).not.toContain("overscroll-behavior");
    expect(rowsRule).not.toContain("-webkit-overflow-scrolling");
  });

  it("输入框默认高度约减半：rows=2 且 min-height 64px，长文仍能在框内滚动", async () => {
    const sources = [stagedUsableSource("src_a", "新攻略A", "ev_a")];
    vi.mocked(listGuideSources).mockResolvedValue({ sources, tripVersion: 1 });
    renderNoteInput(makeTripWithSources(sources, { ev_a: makeEvidence("ev_a") }));

    const textarea = await screen.findByPlaceholderText("粘贴攻略链接 / 文字，或输入景点、酒店名");
    expect(textarea.tagName).toBe("TEXTAREA");
    // 原 rows=4 / min-height 120px → 现 rows=2 / 64px
    expect(textarea.getAttribute("rows")).toBe("2");

    const rule = cssRuleBody(readStylesCss(), ".note-textarea");
    expect(rule).toContain("min-height: 64px");
    expect(rule).toContain("max-height: 40vh");
    expect(rule).toMatch(/overflow-y:\s*auto/);
  });

  it("范围文案已移除：不渲染「将调整整段行程」，也不新增范围 chips", async () => {
    const sources = [stagedUsableSource("src_a", "新攻略A", "ev_a")];
    vi.mocked(listGuideSources).mockResolvedValue({ sources, tripVersion: 1 });
    renderNoteInput(makeTripWithSources(sources, { ev_a: makeEvidence("ev_a") }));

    await screen.findByRole("button", { name: "AI 生成行程 · 已选 1 篇" });
    // 整程范围不再用一句话告诉用户；范围仍由 note + 服务端自动判定
    expect(screen.queryByText(/将调整整段行程/)).toBeNull();
    expect(document.querySelector(".draft-scope-note")).toBeNull();
    expect(
      document.querySelectorAll(".draft-scope-note, .draft-scope-chips, .scope-chip"),
    ).toHaveLength(0);
  });

  // 保留契约：紧凑列表的批量选择仍可用，主 CTA 恒为 sourceMode="selected"
  it("4 篇紧凑列表：全不选 / 只选新的与 selected 请求契约不回归", async () => {
    const { sources, evidences } = fourStagedSources();
    vi.mocked(listGuideSources).mockResolvedValue({ sources, tripVersion: 1 });
    const onGenerateDraft = vi.fn();
    renderNoteInput(makeTripWithSources(sources, evidences), vi.fn(), { onGenerateDraft });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "AI 生成行程 · 已选 4 篇" })).toBeEnabled();
    });

    // 全不选：勾选集合清空，CTA 退化为「请勾选要用的攻略」且不可点
    fireEvent.click(screen.getByRole("button", { name: "全不选" }));
    expect(screen.getByRole("button", { name: "请勾选要用的攻略" })).toBeDisabled();
    expect(onGenerateDraft).not.toHaveBeenCalled();

    // 只选新的：4 篇均 staged → 全部重新勾上，请求体带全部 id
    fireEvent.click(screen.getByRole("button", { name: "只选新的" }));
    const primary = screen.getByRole("button", { name: "AI 生成行程 · 已选 4 篇" });
    expect(primary).toBeEnabled();
    fireEvent.click(primary);
    expect(onGenerateDraft).toHaveBeenCalledTimes(1);
    expect(onGenerateDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceMode: "selected",
        selectedSourceIds: ["src_a", "src_b", "src_c", "src_d"],
        usableCount: 4,
      }),
    );
  });
});

/** 长攻略正文（>30 字、无链接）：走文字来源提交，产生真实的来源变化 */
const LONG_GUIDE_TEXT =
  "第一天亚龙湾热带天堂森林公园，第二天蜈支洲岛浮潜，第三天南山寺与天涯海角，晚上回第一市场吃海鲜加工，节奏放慢一点不要赶。";

/** 当前列表里被勾选的来源篇数（与 footer CTA 文案必须始终一致） */
function checkedSourceCount(): number {
  return screen
    .getAllByRole("checkbox")
    .filter((box) => (box as HTMLInputElement).checked).length;
}

/**
 * Task #245：浏览器打开 NoteInput 曾报 `selectedSourceIdsRef is not defined`。
 *
 * 任务 242 把选择状态从 ref 改成 useState 时，reconcile effect 里残留了一行
 * `previous: selectedSourceIdsRef.current`——它是 effect 内的自由变量引用，只有
 * 真组件渲染并真正跑过该 effect 才会抛 ReferenceError。历史用例虽然渲染了
 * NoteInput，但当时该版本没有被测试跑过；这里把「挂载 → 父组件刷新 trip →
 * 保存新来源 → 勾选变化」的完整运行路径固化下来，并显式断言零 ReferenceError。
 */
describe("NoteInput 真实渲染运行时回归（Task #245）", () => {
  it("挂载 / 父组件刷新 trip / 新增来源全程无 ReferenceError", async () => {
    const errorSpy = vi.spyOn(console, "error");
    const sources = [
      stagedUsableSource("src_a", "新攻略A", "ev_a"),
      stagedUsableSource("src_b", "新攻略B", "ev_b"),
    ];
    const evidences = { ev_a: makeEvidence("ev_a"), ev_b: makeEvidence("ev_b") };
    const added = stagedUsableSource("src_c", "新攻略C", "ev_c");
    vi.mocked(listGuideSources).mockResolvedValue({ sources, tripVersion: 1 });
    vi.mocked(submitGuideSourceText).mockResolvedValue({
      sourceId: "src_c",
      status: "ready",
      duplicate: false,
      source: added,
    });

    let trip = makeTripWithSources(sources, evidences);
    let rerenderTree: (node: JSX.Element) => void = () => {};
    // 父组件在来源变化后刷新权威 trip（新对象 + 新证据），与真实 TripView 一致
    const onExtracted = () => {
      trip = makeTripWithSources([...sources, added], {
        ...evidences,
        ev_c: makeEvidence("ev_c"),
      });
      rerenderTree(noteInputElement(trip, onExtracted));
    };
    const rendered = render(noteInputElement(trip, onExtracted));
    rerenderTree = rendered.rerender;

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "AI 生成行程 · 已选 2 篇" })).toBeEnabled();
    });

    // 1）父组件轮询刷新 trip：reconcile effect 重新执行（旧版在这里读未声明的 ref）
    rendered.rerender(noteInputElement(trip, onExtracted));
    expect(screen.getByRole("button", { name: "AI 生成行程 · 已选 2 篇" })).toBeEnabled();

    // 2）来源变化：保存一篇新攻略 → 列表 2 → 3 篇，新来源可用后自动并入选择集合
    fireEvent.change(screen.getByPlaceholderText("粘贴攻略链接 / 文字，或输入景点、酒店名"), {
      target: { value: LONG_GUIDE_TEXT },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存攻略" }));

    await waitFor(() => {
      expect(screen.getByLabelText("选择攻略 新攻略C")).toBeChecked();
    });
    expect(screen.getByRole("button", { name: "AI 生成行程 · 已选 3 篇" })).toBeEnabled();
    expect(checkedSourceCount()).toBe(3);

    // 3）再刷新一次（内容等价的新 trip 引用）仍不应抛任何运行时错误
    rendered.rerender(noteInputElement(trip, onExtracted));
    expect(screen.getByRole("button", { name: "AI 生成行程 · 已选 3 篇" })).toBeEnabled();

    const logged = errorSpy.mock.calls
      .flat()
      .map((value) => (value instanceof Error ? value.message : String(value)))
      .join("\n");
    expect(logged).not.toMatch(/is not defined/);
    expect(logged).not.toMatch(/ReferenceError/);
    expect(logged).not.toMatch(/The above error occurred/);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("来源刷新后单一选择状态不回退：列表勾选与固定 footer CTA 同源", async () => {
    const { sources, evidences } = fourStagedSources();
    vi.mocked(listGuideSources).mockResolvedValue({ sources, tripVersion: 1 });
    const onGenerateDraft = vi.fn();
    const rendered = render(
      noteInputElement(makeTripWithSources(sources, evidences), vi.fn(), { onGenerateDraft }),
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "AI 生成行程 · 已选 4 篇" })).toBeEnabled();
    });

    // 用户主动取消一篇：列表与 footer 同步收敛（唯一状态在 NoteInput）
    fireEvent.click(screen.getByLabelText("选择攻略 新攻略B"));
    expect(checkedSourceCount()).toBe(3);
    expect(screen.getByRole("button", { name: "AI 生成行程 · 已选 3 篇" })).toBeEnabled();

    // 父组件刷新 trip（新引用、内容等价）：不得把用户取消过的来源重新勾上
    rendered.rerender(
      noteInputElement(makeTripWithSources(sources, evidences), vi.fn(), { onGenerateDraft }),
    );
    expect(screen.getByLabelText("选择攻略 新攻略B")).not.toBeChecked();
    expect(checkedSourceCount()).toBe(3);
    const primary = screen.getByRole("button", { name: "AI 生成行程 · 已选 3 篇" });
    expect(primary).toBeEnabled();

    // 请求体与列表勾选完全一致（按来源顺序）
    fireEvent.click(primary);
    expect(onGenerateDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceMode: "selected",
        selectedSourceIds: ["src_a", "src_c", "src_d"],
        usableCount: 3,
      }),
    );
  });

  it("性能缓存无回归：内容等价的 trip 刷新只提交一次（选择集合不写新数组）", async () => {
    const { sources, evidences } = fourStagedSources();
    vi.mocked(listGuideSources).mockResolvedValue({ sources, tripVersion: 1 });
    const phases: string[] = [];
    const rendered = render(
      <Profiler id="note-input" onRender={(_id, phase) => phases.push(phase)}>
        {noteInputElement(makeTripWithSources(sources, evidences))}
      </Profiler>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "AI 生成行程 · 已选 4 篇" })).toBeEnabled();
    });

    // 稳定后清空：父组件刷新 trip（来源内容不变）应只有 1 次 props 提交；
    // 若 reconcile effect 每次写入新数组，会再多一次状态提交（移动端输入卡顿来源）
    phases.length = 0;
    rendered.rerender(
      <Profiler id="note-input" onRender={(_id, phase) => phases.push(phase)}>
        {noteInputElement(makeTripWithSources(sources, evidences))}
      </Profiler>,
    );
    expect(phases).toHaveLength(1);
    expect(checkedSourceCount()).toBe(4);
  });
});

/**
 * Task #263：snippet-only 草案（operations=[] + snippets）在 NoteInput 全链路不被误报失败。
 *
 * 百炼 / 快速路径可能只返回攻略提示：后端应用时把 snippets 挂到点位上并返回
 * attachedSnippetCount > 0，前端必须按成功处理。这里覆盖完整链路：
 * NoteInput → GuideDraftReview.handleApply → applyGuideDraft（桩）→ onApplied →
 * NoteInput.handleDraftConfirm → props.onDraftApplied + onClose。
 * 断言：结果照常上抛（applied 为空）、面板关闭、界面无 role="alert" 与「失败」文案。
 */
describe("NoteInput snippet-only 草案应用（Task #263）", () => {
  const SNIPPET_ONLY_DRAFT: GuideDraftResult = {
    draftId: "draft-snippet-only",
    tripVersion: 1,
    baseTripVersion: 1,
    inputTripVersion: 1,
    scope: { kind: "trip" },
    operations: [],
    snippets: [
      {
        text: "岛上建议早去避排队",
        claimKind: "tip",
        targetRef: { kind: "visit", id: "visit_wzz" },
        sourceMentionRefs: ["ev_1:m_1"],
      },
      {
        text: "后海海滩适合傍晚看日落",
        claimKind: "experience",
        targetRef: { kind: "visit", id: "visit_houhai" },
        sourceMentionRefs: ["ev_1:m_2"],
      },
      {
        text: "第一市场晚上人多，避峰去",
        claimKind: "tip",
        targetRef: { kind: "visit", id: "visit_market" },
        sourceMentionRefs: ["ev_1:m_3"],
      },
    ],
    unplaced: [],
    proposedNew: [],
    clarify: null,
    sourceSnapshots: [],
    sourceCount: 2,
    mentionCount: 5,
    placeCount: 3,
    mentionRefCount: 5,
    latencyMs: 120,
    promptChars: 1000,
    attempts: 0,
    fastPath: true,
  };

  it("operations=[] + 攻略提示：应用成功上抛结果并关闭面板，不出现失败提示", async () => {
    const result: GuideDraftApplyResult = {
      type: "applied",
      tripVersion: 2,
      draftId: "draft-snippet-only",
      applied: [],
      rejected: [],
      rejectedCount: 0,
      rejectSummary: null,
      allRejected: false,
      needsProposal: [],
      attachedSnippetCount: 3,
      attachedOptionGroupCount: 0,
      message: "行程结构无需变更，已添加 3 条攻略提示",
    };
    vi.mocked(applyGuideDraft).mockResolvedValue(result);
    const onDraftApplied = vi.fn();
    const onClose = vi.fn();
    renderNoteInput(makeTripWithSources([]), vi.fn(), {
      draft: SNIPPET_ONLY_DRAFT,
      onDraftApplied,
      onClose,
    });

    // 预览读作「仅补充」（而不是空草案 / 没排成）
    expect(await screen.findByText("仅补充 3 条攻略提示，不改动行程结构")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "应用草案到行程" }));

    await waitFor(() => expect(onDraftApplied).toHaveBeenCalledTimes(1));
    expect(applyGuideDraft).toHaveBeenCalledWith("trip-test", undefined, undefined);
    expect(onDraftApplied).toHaveBeenCalledWith(result);
    // applied 为空也算成功：结果照常上抛，面板关闭，不弹错误
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/失败/)).toBeNull();
  });
});

/**
 * Task #225：提交含待解析图片的来源时，submitNotice 提示用户有两种模式可选。
 */
describe("NoteInput 图片解析模式提示（Task #225）", () => {
  const LONG_TEXT = "这是一段超过三十个字的攻略正文内容，用来触发文字来源提交而非快速搜索";

  it("提交后来源含 imageOcrDeferred：通知提及图片张数与解析选项", async () => {
    const deferredSource = makeSource({
      sourceId: "src_new",
      inputKind: "link",
      status: "processing",
      imageOcrDeferred: true,
      imageProgress: {
        total: 4,
        completed: 0,
        failed: 0,
        images: [
          { index: 1, status: "pending", evidenceId: null },
          { index: 2, status: "pending", evidenceId: null },
          { index: 3, status: "pending", evidenceId: null },
          { index: 4, status: "pending", evidenceId: null },
        ],
      },
    });
    vi.mocked(submitGuideSourceText).mockResolvedValue({
      sourceId: "src_new",
      status: "processing",
      duplicate: false,
      source: deferredSource,
    });
    renderNoteInput(makeTripWithSources([]));

    fireEvent.change(
      screen.getByPlaceholderText("粘贴攻略链接 / 文字，或输入景点、酒店名"),
      { target: { value: LONG_TEXT } },
    );
    fireEvent.click(screen.getByRole("button", { name: "保存攻略" }));

    await waitFor(() => {
      const notice = screen.getByRole("status");
      expect(notice.textContent).toContain("4 张图片");
      expect(notice.textContent).toContain("解析图片");
      expect(notice.textContent).toContain("约1-2分钟/张");
    });
  });

  it("提交后来源无待解析图片：通知保持原有简洁文案", async () => {
    const normalSource = makeSource({
      sourceId: "src_normal",
      inputKind: "text",
      status: "processing",
    });
    vi.mocked(submitGuideSourceText).mockResolvedValue({
      sourceId: "src_normal",
      status: "processing",
      duplicate: false,
      source: normalSource,
    });
    renderNoteInput(makeTripWithSources([]));

    fireEvent.change(
      screen.getByPlaceholderText("粘贴攻略链接 / 文字，或输入景点、酒店名"),
      { target: { value: LONG_TEXT } },
    );
    fireEvent.click(screen.getByRole("button", { name: "保存攻略" }));

    await waitFor(() => {
      const notice = screen.getByRole("status");
      expect(notice.textContent).toBe("已保存，正在识别要点");
    });
  });
});

describe("NoteInput 无 scheme 链接分流（Task #304）", () => {
  /** PD 现场粘贴原文：App「复制链接」产物，无 https:// 前缀（#385 打码：token/shareRedId 已 REDACTED，断言只依赖链接形态） */
  const PD_BARE_URL =
    "xiaohongshu.com/discovery/item/6ace31c6000000001b0202f7?app_platform=ios&app_version=9.52&share_from_user_hidden=true&xsec_source=app_share&type=normal&xsec_token=REDACTED_NOTE_A=&author_share=1&xhsshare=CopyLink&shareRedId=REDACTED=&apptime=17933";
  const LONG_TEXT = "这是一段超过三十个字的攻略正文内容，用来触发文字来源提交而非快速搜索";

  function mockLinkResult(): void {
    vi.mocked(submitGuideSourceLink).mockResolvedValue({
      sourceId: "src_link",
      status: "processing",
      duplicate: false,
      source: makeSource({ sourceId: "src_link", inputKind: "link", status: "processing" }),
    });
  }

  async function typeAndSave(value: string): Promise<void> {
    fireEvent.change(
      screen.getByPlaceholderText("粘贴攻略链接 / 文字，或输入景点、酒店名"),
      { target: { value } },
    );
    fireEvent.click(screen.getByRole("button", { name: "保存攻略" }));
    await waitFor(() => {
      expect(
        vi.mocked(submitGuideSourceLink).mock.calls.length +
          vi.mocked(submitGuideSourceText).mock.calls.length,
      ).toBeGreaterThan(0);
    });
  }

  it("PD 现场无 scheme 链接：走链接来源并提交归一化 https:// URL", async () => {
    mockLinkResult();
    renderNoteInput(makeTripWithSources([]));

    await typeAndSave(PD_BARE_URL);

    expect(submitGuideSourceText).not.toHaveBeenCalled();
    expect(submitGuideSourceLink).toHaveBeenCalledWith("trip-test", `https://${PD_BARE_URL}`);
  });

  it("口令 + 无 scheme 链接（≤30 字）：仍走链接来源，口令不进 URL", async () => {
    mockLinkResult();
    renderNoteInput(makeTripWithSources([]));

    await typeAndSave("推荐看这篇 xiaohongshu.com/explore/6a93bde9?xsec_token=ABC123=");

    expect(submitGuideSourceText).not.toHaveBeenCalled();
    expect(submitGuideSourceLink).toHaveBeenCalledWith(
      "trip-test",
      "https://xiaohongshu.com/explore/6a93bde9?xsec_token=ABC123=",
    );
  });

  it("带 scheme 链接回归：行为与既有口径一致", async () => {
    mockLinkResult();
    renderNoteInput(makeTripWithSources([]));

    const url = "https://www.xiaohongshu.com/explore/6a93bde9?xsec_token=XYZ=";
    await typeAndSave(url);

    expect(submitGuideSourceLink).toHaveBeenCalledWith("trip-test", url);
  });

  it("普通长文字不误判：仍走文字来源且不带 sourceUrl", async () => {
    vi.mocked(submitGuideSourceText).mockResolvedValue({
      sourceId: "src_text",
      status: "processing",
      duplicate: false,
      source: makeSource({ sourceId: "src_text", status: "processing" }),
    });
    renderNoteInput(makeTripWithSources([]));

    await typeAndSave(LONG_TEXT);

    expect(submitGuideSourceLink).not.toHaveBeenCalled();
    expect(submitGuideSourceText).toHaveBeenCalledWith("trip-test", LONG_TEXT, {
      sourceUrl: undefined,
    });
  });

  it("长文字 + 无 scheme 链接：走文字来源，sourceUrl 记归一化链接", async () => {
    vi.mocked(submitGuideSourceText).mockResolvedValue({
      sourceId: "src_text",
      status: "processing",
      duplicate: false,
      source: makeSource({ sourceId: "src_text", status: "processing" }),
    });
    renderNoteInput(makeTripWithSources([]));

    const text = `${LONG_TEXT} 详情见 xiaohongshu.com/explore/6a93bde9?xsec_token=ABC123=`;
    await typeAndSave(text);

    expect(submitGuideSourceLink).not.toHaveBeenCalled();
    expect(submitGuideSourceText).toHaveBeenCalledWith("trip-test", text, {
      sourceUrl: "https://xiaohongshu.com/explore/6a93bde9?xsec_token=ABC123=",
    });
  });
});
