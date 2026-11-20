/**
 * Task #236：GuideDraftPanel 底部固定主 CTA + 次要出口测试。
 *
 * 选择状态已上提到 NoteInput（单一来源），本面板只消费受控 selectedSourceIds：
 * - 主 CTA 文案随「有效勾选篇数」动态变化，无选中时禁用并给出可执行提示；
 * - 主 CTA 恒走 sourceMode="selected" + 真实 selectedSourceIds（不是只改文案）；
 * - 不可用来源（failed / processing / 已移除 / 不存在的 id）不进入请求体；
 * - 「仅暂存，稍后处理」只关闭面板，不发起生成、不改后端状态；
 * - 「使用全部攻略整体重排」保留为次级出口：二次确认 + sourceMode="all"，
 *   且不携带 selectedSourceIds（全部模式排除 staged 来源）；
 * - 生成中 / 失败 / 输入区有待保存内容时的状态互斥与文案不回归。
 *
 * Task #224：生成中若带上分级快照（generation.stage），面板改画「路线站点 +
 * 已等计时 + 预计剩余 + 可离开提示」；没有快照则严格退回既有单行思考链。
 */
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { GuideSource, SourceEvidence, Trip } from "@goplay/shared";
import GuideDraftPanel, {
  GuideDraftActionsBar,
  type GuideDraftGenerationView,
} from "./GuideDraftPanel";
import { DRAFT_WAIT_LEAVE_HINT, DRAFT_WAIT_PLAN } from "../lib/waitPlans";
import { resolveWaitStage } from "../lib/waitStages";

function makeEvidence(evidenceId: string, overrides: Partial<SourceEvidence> = {}): SourceEvidence {
  return {
    evidenceId,
    kind: "note_text",
    noteIndex: null,
    assetRef: null,
    sourceUrl: null,
    ocrText: "第一天 亚龙湾细沙滩",
    mentions: [],
    assetPath: null,
    ...overrides,
  };
}

function makeTrip(evidences: Record<string, SourceEvidence> = {}): Trip {
  return {
    tripId: "trip-test",
    schemaVersion: 2,
    version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: "2026-11-10", nights: 2 },
    dayRefs: ["day_1", "day_2"],
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
      day_2: {
        dayId: "day_2",
        dayIndex: 2,
        date: "2026-11-09",
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
    guideSources: {},
    constraints: [],
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
  };
}

function makeSource(overrides: Partial<GuideSource> = {}): GuideSource {
  return {
    sourceId: "src_1",
    sourceVersion: 1,
    inputKind: "text",
    title: "三亚攻略",
    active: true,
    status: "ready",
    evidenceRefs: ["ev_1"],
    mentionRefs: [],
    imageProgress: { total: 0, completed: 0, failed: 0, images: [] },
    importedAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    ...overrides,
  };
}

/** 暂存新来源（staged=true，服务端新增来源的默认形态） */
function stagedSource(overrides: Partial<GuideSource> = {}): GuideSource {
  return makeSource({ staged: true, ...overrides });
}

/** 历史来源（无 staged 字段 = 已整合，全部模式可消费） */
function historySource(overrides: Partial<GuideSource> = {}): GuideSource {
  return makeSource({ ...overrides });
}

const idleGeneration: GuideDraftGenerationView = { active: false, text: null, error: null };

interface RenderOptions {
  openContext?: { type: "global" } | { type: "day"; dayIndex: number };
  consumedSourceIds?: readonly string[];
  generation?: GuideDraftGenerationView;
  /** 受控选择集合（真实链路由 NoteInput 推导 / 用户在列表勾选） */
  selectedSourceIds?: readonly string[];
  onSaveLater?: () => void;
  textHasContent?: boolean;
  /** 取消等待回调（Task #224：分级进度里的取消按钮沿用同一出口） */
  onCancelGenerate?: () => void;
}

function renderPanel(
  trip: Trip,
  sources: GuideSource[],
  onGenerate = vi.fn(),
  {
    openContext = { type: "global" },
    consumedSourceIds,
    generation = idleGeneration,
    selectedSourceIds = [],
    onSaveLater = vi.fn(),
    textHasContent = false,
    onCancelGenerate = vi.fn(),
  }: RenderOptions = {},
) {
  /** Task #242：正文区与固定行动区拆成两个组件，补充要求状态由调用方（真实链路是
   *  NoteInput）持有——测试用一个受控壳子还原同一份值，并保持「行动区在滚动区之外」
   *  的真实层级（.note-input-body / .note-input-foot） */
  function Harness() {
    const [note, setNote] = useState("");
    const shared = {
      trip,
      sources,
      openContext,
      busy: false,
      textHasContent,
      generation,
      consumedSourceIds,
      selectedSourceIds,
      onGenerate,
      onCancelGenerate,
      onSaveLater,
    };
    return (
      <>
        <div className="note-input-body">
          <GuideDraftPanel {...shared} note={note} onNoteChange={setNote} />
        </div>
        <div className="note-input-foot">
          <GuideDraftActionsBar {...shared} note={note} />
        </div>
      </>
    );
  }

  return render(<Harness />);
}

/** 两篇暂存 + 一篇历史，全部有可读证据（模拟列表勾选 2 篇新攻略后的面板） */
function makeMixedFixture() {
  const sources = [
    stagedSource({ sourceId: "src_a", title: "攻略A", evidenceRefs: ["ev_a"] }),
    stagedSource({ sourceId: "src_b", title: "攻略B", evidenceRefs: ["ev_b"] }),
    historySource({ sourceId: "src_h", title: "历史1", evidenceRefs: ["ev_h"] }),
  ];
  const trip = makeTrip({
    ev_a: makeEvidence("ev_a"),
    ev_b: makeEvidence("ev_b"),
    ev_h: makeEvidence("ev_h"),
  });
  return { sources, trip };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("GuideDraftPanel 主 CTA（Task #236）", () => {
  it("按有效勾选篇数显示动态文案，点击走 selected 模式并携带真实 sourceIds", () => {
    const { sources, trip } = makeMixedFixture();
    const onGenerate = vi.fn();
    // 勾选顺序与来源顺序相反：请求体按来源顺序输出，便于服务端与列表对齐
    renderPanel(trip, sources, onGenerate, {
      selectedSourceIds: ["src_b", "src_a"],
    });

    const primary = screen.getByRole("button", { name: "AI 生成行程 · 已选 2 篇" });
    expect(primary).toBeEnabled();
    fireEvent.click(primary);

    expect(onGenerate).toHaveBeenCalledTimes(1);
    expect(onGenerate).toHaveBeenCalledWith({
      entryContext: { type: "global" },
      note: "",
      usableCount: 2,
      sourceMode: "selected",
      selectedSourceIds: ["src_a", "src_b"],
    });
  });

  it("选中集合里的不可用来源 / 失效 id 被剔除，不进入请求体", () => {
    const sources = [
      stagedSource({ sourceId: "src_a", title: "攻略A", evidenceRefs: ["ev_a"] }),
      stagedSource({
        sourceId: "src_fail",
        title: "失败攻略",
        status: "failed",
        evidenceRefs: ["ev_f"],
      }),
    ];
    const trip = makeTrip({
      ev_a: makeEvidence("ev_a"),
      ev_f: makeEvidence("ev_f"),
    });
    const onGenerate = vi.fn();
    renderPanel(trip, sources, onGenerate, {
      selectedSourceIds: ["src_a", "src_fail", "src_missing"],
    });

    const primary = screen.getByRole("button", { name: "AI 生成行程 · 已选 1 篇" });
    fireEvent.click(primary);
    expect(onGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        usableCount: 1,
        sourceMode: "selected",
        selectedSourceIds: ["src_a"],
      }),
    );
  });

  it("无勾选：CTA 禁用并给出明确提示，点击不发起生成", () => {
    const { sources, trip } = makeMixedFixture();
    const onGenerate = vi.fn();
    renderPanel(trip, sources, onGenerate, { selectedSourceIds: [] });

    const primary = screen.getByRole("button", { name: "请勾选要用的攻略" });
    expect(primary).toBeDisabled();
    fireEvent.click(primary);
    expect(onGenerate).not.toHaveBeenCalled();
  });

  it("无可选素材：处理中 / 仅失败 / 无来源各自给出可执行文案且禁用", () => {
    const processing = stagedSource({
      sourceId: "src_p",
      title: "处理中攻略",
      status: "processing",
    });
    const first = renderPanel(makeTrip({ ev_1: makeEvidence("ev_1") }), [processing]);
    expect(screen.getByRole("button", { name: "攻略处理中，完成后亮起" })).toBeDisabled();
    first.unmount();

    const failed = stagedSource({
      sourceId: "src_f",
      title: "失败攻略",
      status: "failed",
    });
    const second = renderPanel(makeTrip({ ev_1: makeEvidence("ev_1") }), [failed]);
    expect(screen.getByRole("button", { name: "重试失败攻略后可排版" })).toBeDisabled();
    second.unmount();

    renderPanel(makeTrip(), []);
    expect(screen.getByRole("button", { name: "先添加一篇攻略" })).toBeDisabled();
  });

  it("补充要求（自然语言）透传到生成请求", () => {
    const { sources, trip } = makeMixedFixture();
    const onGenerate = vi.fn();
    renderPanel(trip, sources, onGenerate, { selectedSourceIds: ["src_a"] });

    fireEvent.change(screen.getByPlaceholderText(/补充要求/), {
      target: { value: "带娃，不想太赶" },
    });
    fireEvent.click(screen.getByRole("button", { name: "AI 生成行程 · 已选 1 篇" }));

    expect(onGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ note: "带娃，不想太赶", selectedSourceIds: ["src_a"] }),
    );
  });

  it("「仅暂存，稍后处理」只关闭面板：不发起生成、不上抛任何请求", () => {
    const { sources, trip } = makeMixedFixture();
    const onGenerate = vi.fn();
    const onSaveLater = vi.fn();
    renderPanel(trip, sources, onGenerate, {
      selectedSourceIds: ["src_a"],
      onSaveLater,
    });

    fireEvent.click(screen.getByRole("button", { name: "仅暂存，稍后处理" }));
    expect(onSaveLater).toHaveBeenCalledTimes(1);
    expect(onGenerate).not.toHaveBeenCalled();
  });

  it("没有任何来源时不渲染「仅暂存」出口（无内容可暂存）", () => {
    renderPanel(makeTrip(), []);
    expect(screen.queryByRole("button", { name: "仅暂存，稍后处理" })).toBeNull();
  });
});

describe("GuideDraftPanel 次级整体重排（能力保留）", () => {
  it("点击先二次确认：说明素材边界，取消不发请求", () => {
    const { sources, trip } = makeMixedFixture();
    const onGenerate = vi.fn();
    renderPanel(trip, sources, onGenerate, { selectedSourceIds: ["src_a"] });

    fireEvent.click(screen.getByRole("button", { name: "使用全部攻略整体重排" }));
    const dialog = screen.getByRole("dialog", { name: "整体重排确认" });
    expect(dialog).toHaveTextContent("已整合的 1 篇攻略");
    expect(dialog).toHaveTextContent("刚添加的 2 篇不会用上");
    expect(onGenerate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog", { name: "整体重排确认" })).toBeNull();
    expect(onGenerate).not.toHaveBeenCalled();
  });

  it("确认重排：sourceMode=all 且不携带 selectedSourceIds", () => {
    const sources = [
      historySource({ sourceId: "src_h1", title: "历史1", evidenceRefs: ["ev_h1"] }),
      historySource({ sourceId: "src_h2", title: "历史2", evidenceRefs: ["ev_h2"] }),
    ];
    const trip = makeTrip({
      ev_h1: makeEvidence("ev_h1"),
      ev_h2: makeEvidence("ev_h2"),
    });
    const onGenerate = vi.fn();
    renderPanel(trip, sources, onGenerate, { selectedSourceIds: ["src_h1"] });

    fireEvent.click(screen.getByRole("button", { name: "使用全部攻略整体重排" }));
    fireEvent.click(screen.getByRole("button", { name: "确认重排" }));

    expect(onGenerate).toHaveBeenCalledTimes(1);
    expect(onGenerate).toHaveBeenCalledWith({
      entryContext: { type: "global" },
      note: "",
      usableCount: 2,
      sourceMode: "all",
    });
    const call = onGenerate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.selectedSourceIds).toBeUndefined();
  });

  it("仅暂存来源（all 模式无素材）不渲染整体重排入口", () => {
    const sources = [stagedSource({ sourceId: "src_new", title: "新攻略" })];
    renderPanel(makeTrip({ ev_1: makeEvidence("ev_1") }), sources, vi.fn(), {
      selectedSourceIds: ["src_new"],
    });
    expect(screen.queryByRole("button", { name: "使用全部攻略整体重排" })).toBeNull();
  });
});

describe("GuideDraftPanel 状态互斥与文案（不回归）", () => {
  it("生成中：CTA 与两个出口禁用，思考链与取消等待可见", () => {
    const { sources, trip } = makeMixedFixture();
    renderPanel(trip, sources, vi.fn(), {
      selectedSourceIds: ["src_a"],
      generation: { active: true, text: "正在读取攻略素材…", error: null },
    });

    expect(screen.getByRole("button", { name: "正在生成行程…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "仅暂存，稍后处理" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "使用全部攻略整体重排" })).toBeDisabled();
    expect(screen.getByText("正在读取攻略素材…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消等待" })).toBeEnabled();
  });

  it("失败重试：generation.error 就地展示，CTA 恢复可点即重试", () => {
    const { sources, trip } = makeMixedFixture();
    const onGenerate = vi.fn();
    renderPanel(trip, sources, onGenerate, {
      selectedSourceIds: ["src_a"],
      generation: { active: false, text: null, error: "行程已变化，请重新生成草案" },
    });

    expect(screen.getByRole("alert")).toHaveTextContent("行程已变化，请重新生成草案");
    fireEvent.click(screen.getByRole("button", { name: "AI 生成行程 · 已选 1 篇" }));
    expect(onGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ sourceMode: "selected", selectedSourceIds: ["src_a"] }),
    );
  });

  it("输入区有待保存内容时退让：只留引导文案，不出现 CTA 与出口", () => {
    const { sources, trip } = makeMixedFixture();
    renderPanel(trip, sources, vi.fn(), {
      selectedSourceIds: ["src_a"],
      textHasContent: true,
    });

    expect(screen.getByText("保存后，可在此一键排行程")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /AI 生成行程/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "仅暂存，稍后处理" })).toBeNull();
  });

  it("本轮新增暂存提示按未消费篇数展示，消费后消失", () => {
    const { sources, trip } = makeMixedFixture();
    const first = renderPanel(trip, sources, vi.fn(), { selectedSourceIds: ["src_a"] });
    expect(screen.getByText("2 篇新攻略已暂存，还没有改动行程")).toBeInTheDocument();
    first.unmount();

    renderPanel(trip, sources, vi.fn(), {
      selectedSourceIds: ["src_a"],
      consumedSourceIds: ["src_a", "src_b"],
    });
    expect(screen.queryByText(/篇新攻略已暂存/)).toBeNull();
  });

  it("影响范围文案：Day 入口给出局部预判；整程不再展示「将调整整段行程」（Task #242）", () => {
    const { sources, trip } = makeMixedFixture();
    const day = renderPanel(trip, sources, vi.fn(), {
      openContext: { type: "day", dayIndex: 2 },
      selectedSourceIds: ["src_a"],
    });
    expect(screen.getByText("将优先优化 Day2 的安排")).toBeInTheDocument();
    day.unmount();

    // Task #242：整程范围交由补充说明 + 服务端自动判定，不再用冗余占位句解释
    renderPanel(trip, sources, vi.fn(), { selectedSourceIds: ["src_h"] });
    expect(screen.queryByText("将调整整段行程")).toBeNull();
    expect(document.querySelector(".draft-scope-note")).toBeNull();
  });

  it("无勾选时不展示影响范围文案（素材未定）", () => {
    const { sources, trip } = makeMixedFixture();
    renderPanel(trip, sources, vi.fn(), { selectedSourceIds: [] });
    expect(screen.queryByText(/将调整整段行程|将优先优化/)).toBeNull();
  });

  it("processing 混合提示：已勾选可用素材时提示还有几篇处理中", () => {
    const sources = [
      stagedSource({ sourceId: "src_a", title: "攻略A", evidenceRefs: ["ev_a"] }),
      stagedSource({
        sourceId: "src_p",
        title: "处理中攻略",
        status: "processing",
        evidenceRefs: ["ev_p"],
      }),
    ];
    const trip = makeTrip({
      ev_a: makeEvidence("ev_a"),
      ev_p: makeEvidence("ev_p"),
    });
    renderPanel(trip, sources, vi.fn(), { selectedSourceIds: ["src_a"] });
    expect(screen.getByText("还有 1 篇处理中，完成后可重新优化")).toBeInTheDocument();
  });
});

/**
 * Task #224：面板内生成等待的分级反馈。
 * generation.stage 由 useGuideDraftGeneration 按已等待时长解析（与底部浮条同源）；
 * 面板拿到快照就画路线站点，拿不到就严格退回既有单行思考链——既有测试路径不变。
 */
describe("GuideDraftPanel 分级等待反馈（Task #224）", () => {
  function generatingWith(stageMs: number | null, text = "根据行程约束规划最佳路线…") {
    return {
      active: true,
      text,
      error: null,
      stage: stageMs === null ? null : resolveWaitStage(DRAFT_WAIT_PLAN, stageMs),
    } satisfies GuideDraftGenerationView;
  }

  it("有快照：画四站路线 + 已等计时 + 预计剩余，句子沿用既有思考链文案", () => {
    const { sources, trip } = makeMixedFixture();
    renderPanel(trip, sources, vi.fn(), {
      selectedSourceIds: ["src_a"],
      generation: generatingWith(20_000),
    });

    const root = screen.getByRole("status", { name: "草案生成进度" });
    expect(root).toHaveAttribute("data-variant", "panel");
    expect(root).toHaveAttribute("data-tier", "steady");
    // 四站路线（站名是用户语言，不是技术术语）
    expect(Array.from(document.querySelectorAll(".wait-stop-name")).map((n) => n.textContent)).toEqual([
      "读料",
      "选点",
      "排线",
      "成稿",
    ]);
    // 句子仍是思考链文案（带可用篇数的既有口径），不是站点兜底句
    expect(document.querySelector(".wait-panel-sentence")).toHaveTextContent(
      "根据行程约束规划最佳路线…",
    );
    expect(document.querySelector(".wait-panel-clock")).toHaveTextContent("已等 20 秒");
    expect(document.querySelector(".wait-panel-remain")).toHaveTextContent("预计还要 2 分钟左右");
    // 可离开等待（Task #135 既有能力）被显式说出来
    expect(document.querySelector(".wait-panel-hint")).toHaveTextContent(DRAFT_WAIT_LEAVE_HINT);
    // 状态互斥不回归：生成中 CTA 与两个出口仍禁用
    expect(screen.getByRole("button", { name: "正在生成行程…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "仅暂存，稍后处理" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "使用全部攻略整体重排" })).toBeDisabled();
  });

  it("取消等待沿用既有出口：点击上抛 onCancelGenerate 一次", () => {
    const { sources, trip } = makeMixedFixture();
    const onCancelGenerate = vi.fn();
    renderPanel(trip, sources, vi.fn(), {
      selectedSourceIds: ["src_a"],
      generation: generatingWith(20_000),
      onCancelGenerate,
    });

    fireEvent.click(screen.getByRole("button", { name: "取消等待" }));
    expect(onCancelGenerate).toHaveBeenCalledTimes(1);
  });

  it("偏慢与接近兜底：只换分级与剩余口径，路线结构与取消入口不变", () => {
    const { sources, trip } = makeMixedFixture();
    renderPanel(trip, sources, vi.fn(), {
      selectedSourceIds: ["src_a"],
      generation: generatingWith(140_000, "内容较多，还需要一点时间…"),
    });
    expect(screen.getByRole("status", { name: "草案生成进度" })).toHaveAttribute(
      "data-tier",
      "slow",
    );
    expect(document.querySelector(".wait-panel-remain")).toHaveTextContent("比预计久一些，还在处理");
    expect(document.querySelectorAll(".wait-stop")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "取消等待" })).toBeEnabled();
  });

  it("接近兜底超时（critical）：先一步给出「取消再试」的出路，衔接既有重试入口", () => {
    const { sources, trip } = makeMixedFixture();
    renderPanel(trip, sources, vi.fn(), {
      selectedSourceIds: ["src_a"],
      generation: generatingWith(240_000, "内容较多，还需要一点时间…"),
    });
    expect(screen.getByRole("status", { name: "草案生成进度" })).toHaveAttribute(
      "data-tier",
      "critical",
    );
    expect(document.querySelector(".wait-panel-remain")).toHaveTextContent(
      "等得有点久了，可以先取消再试一次",
    );
    // 出路口径与文案对齐：取消按钮此刻仍然可用（点下去即回到可重试的 idle）
    expect(screen.getByRole("button", { name: "取消等待" })).toBeEnabled();
  });

  it("没有快照严格退回单行思考链：不画路线、不显示可离开提示（既有行为零回归）", () => {
    const { sources, trip } = makeMixedFixture();
    renderPanel(trip, sources, vi.fn(), {
      selectedSourceIds: ["src_a"],
      generation: { active: true, text: "正在读取攻略素材…", error: null },
    });

    expect(document.querySelector(".wait-stage")).toBeNull();
    expect(document.querySelector(".wait-panel-hint")).toBeNull();
    expect(document.querySelector(".draft-generating")).not.toBeNull();
    expect(screen.getByText("正在读取攻略素材…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消等待" })).toBeEnabled();
  });

  it("stage 显式为 null 同样退回单行（调用方未接分级时不必改类型）", () => {
    const { sources, trip } = makeMixedFixture();
    renderPanel(trip, sources, vi.fn(), {
      selectedSourceIds: ["src_a"],
      generation: generatingWith(null),
    });
    expect(document.querySelector(".wait-stage")).toBeNull();
    expect(document.querySelector(".draft-generating")).not.toBeNull();
  });
});
