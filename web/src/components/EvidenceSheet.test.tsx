import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Item, SourceEvidence, Stop, Trip, Visit } from "@goplay/shared";
import { notifySheetOpened, onSheetOpened } from "../lib/sheetBus";
import EvidenceSheet from "./EvidenceSheet";

afterEach(cleanup);

/**
 * 同一篇证据里混排多个地点的提及（任务 116 真实缺陷形态）：
 * 旧实现按 evidenceId 整篇展示，导致椰梦长廊混入天涯海角等片段。
 */
function makeEvidence(): SourceEvidence {
  const mention = (mentionId: string, extractedName: string, quoteText: string) => ({
    mentionId,
    text: "",
    quoteText,
    bbox: null,
    extractedName,
    locationHint: null,
    modelSummary: null,
  });
  return {
    evidenceId: "ev_1",
    kind: "note_text",
    noteIndex: null,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions: [
      mention("m_1", "蜈支洲岛", "蜈支洲岛潜水要赶早，10 点后人最多"),
      mention("m_2", "椰梦长廊", "椰梦长廊适合傍晚骑行看日落"),
      mention("m_3", "天涯海角", "天涯海角石头打卡人多，建议早去"),
      mention("m_4", "情人桥", "情人桥在蜈支洲岛东侧，排队半小时"),
    ],
  };
}

function makeStop(overrides: Partial<Stop> = {}): Stop {
  return {
    stopId: "stop_1",
    state: "attached",
    visitRef: "visit_1",
    suggestedVisitRef: null,
    matchedPointRef: null,
    customName: "潜水体验",
    order: 0,
    suggestMinutes: null,
    locationHint: null,
    ticketRelation: "unknown",
    sourceEvidenceRefs: ["ev_1"],
    sourceMentionRefs: ["ev_1:m_1"],
    userAdjusted: true,
    removedFromOrder: null,
    removedAt: null,
    ...overrides,
  };
}

function makeItem(itemId: string, name: string, sourceEvidenceRefs: string[] = []): Item {
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
    sourceEvidenceRefs,
  };
}

function makeVisit(visitId: string, pointRef: string, overrides: Partial<Visit> = {}): Visit {
  return {
    visitId,
    dayRef: "day_1",
    pointRef,
    kind: "ordinary",
    visitMode: "custom",
    order: 0,
    windowStart: null,
    windowEnd: null,
    startTime: "09:00",
    endTime: null,
    startTimeOverridden: false,
    endTimeOverridden: false,
    reservedMinutes: null,
    effectiveMinutes: 90,
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
    ...overrides,
  };
}

function makeTrip(
  overrides: Partial<Pick<Trip, "itemRegistry" | "visits" | "stops">> = {},
): Trip {
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
    itemRegistry: {
      item_wuzhi: makeItem("item_wuzhi", "蜈支洲岛"),
      item_yemeng: makeItem("item_yemeng", "椰梦长廊"),
      ...(overrides.itemRegistry ?? {}),
    },
    hotelRegistry: {},
    visits: { ...(overrides.visits ?? {}) },
    stops: { ...(overrides.stops ?? {}) },
    evidences: { ev_1: makeEvidence() },
    globalCandidateRefs: [],
    pendingStopRefs: [],
    relationshipSuggestions: {},
    guideSources: {},
    constraints: [],
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
  };
}

function renderSheet() {
  const onClose = vi.fn();
  render(<EvidenceSheet trip={makeTrip()} stop={makeStop()} onClose={onClose} />);
  return { onClose };
}

describe("EvidenceSheet（攻略原文，Task #109 互斥改造）", () => {
  it("挂载即渲染攻略原文 Sheet，证据摘录可见", () => {
    renderSheet();
    expect(screen.getByRole("dialog", { name: "攻略原文" })).toHaveClass("sheet", "on");
    expect(screen.getByText(/蜈支洲岛潜水要赶早/)).toBeInTheDocument();
  });

  it("挂载即广播 evidence 打开事件（供近期操作让位）", () => {
    const seen: string[] = [];
    const off = onSheetOpened((kind) => seen.push(kind));
    renderSheet();
    expect(seen).toContain("evidence");
    off();
  });

  it("自身广播的 evidence 事件不会触发自关（按 kind 过滤）", () => {
    const { onClose } = renderSheet();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("收到其他浮层（近期操作）打开事件时自关，实现互斥", () => {
    const { onClose } = renderSheet();
    act(() => {
      notifySheetOpened("oplog");
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("点 × 调用 onClose（仅关自己）", () => {
    const { onClose } = renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "关闭攻略原文" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("点遮罩调用 onClose", () => {
    const { onClose } = renderSheet();
    const backdrop = document.querySelector(".backdrop.on");
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("EvidenceSheet 按点位层级筛选提及（任务 116）", () => {
  it("普通景点 Visit：只显示自身提及，椰梦长廊不混入天涯海角", () => {
    const visit = makeVisit("visit_yemeng", "item_yemeng", { sourceMentionRefs: ["ev_1:m_2"] });
    render(
      <EvidenceSheet
        trip={makeTrip({ visits: { visit_yemeng: visit } })}
        visit={visit}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/椰梦长廊适合傍晚骑行/)).toBeInTheDocument();
    expect(screen.queryByText(/天涯海角/)).not.toBeInTheDocument();
    expect(screen.queryByText(/蜈支洲岛潜水要赶早/)).not.toBeInTheDocument();
    expect(screen.queryByText(/情人桥/)).not.toBeInTheDocument();
  });

  it("大景点 Visit：显示自身与内部 Stop 的提及，不显示外部地点", () => {
    const bridge = makeStop({
      stopId: "stop_bridge",
      customName: "情人桥",
      visitRef: "visit_wuzhi",
      sourceMentionRefs: ["ev_1:m_4"],
    });
    const visit = makeVisit("visit_wuzhi", "item_wuzhi", {
      kind: "large_attraction",
      sourceMentionRefs: ["ev_1:m_1"],
      childStopRefs: ["stop_bridge"],
    });
    render(
      <EvidenceSheet
        trip={makeTrip({ visits: { visit_wuzhi: visit }, stops: { stop_bridge: bridge } })}
        visit={visit}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/蜈支洲岛潜水要赶早/)).toBeInTheDocument();
    expect(screen.getByText(/情人桥在蜈支洲岛东侧/)).toBeInTheDocument();
    expect(screen.queryByText(/椰梦长廊/)).not.toBeInTheDocument();
    expect(screen.queryByText(/天涯海角/)).not.toBeInTheDocument();
  });

  it("内部 Stop：只显示自身提及，不合并父 Visit 与同证据其他地点", () => {
    const bridge = makeStop({
      stopId: "stop_bridge",
      customName: "情人桥",
      sourceMentionRefs: ["ev_1:m_4"],
    });
    render(
      <EvidenceSheet
        trip={makeTrip({ stops: { stop_bridge: bridge } })}
        stop={bridge}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/情人桥在蜈支洲岛东侧/)).toBeInTheDocument();
    expect(screen.queryByText(/蜈支洲岛潜水要赶早/)).not.toBeInTheDocument();
    expect(screen.queryByText(/椰梦长廊/)).not.toBeInTheDocument();
    expect(screen.queryByText(/天涯海角/)).not.toBeInTheDocument();
  });

  it("旧数据降级：Stop 缺精确 mention ref 时按名称匹配 extractedName，不回退整篇", () => {
    const legacy = makeStop({
      stopId: "stop_legacy",
      customName: "椰梦长廊",
      sourceMentionRefs: [],
    });
    render(
      <EvidenceSheet
        trip={makeTrip({ stops: { stop_legacy: legacy } })}
        stop={legacy}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/椰梦长廊适合傍晚骑行/)).toBeInTheDocument();
    expect(screen.queryByText(/天涯海角/)).not.toBeInTheDocument();
    expect(screen.queryByText(/蜈支洲岛潜水要赶早/)).not.toBeInTheDocument();
  });

  it("旧数据无法匹配：显示清晰空态，不展示任何提及", () => {
    const nomatch = makeStop({
      stopId: "stop_nomatch",
      customName: "亚龙湾玫瑰谷",
      sourceMentionRefs: [],
    });
    render(
      <EvidenceSheet
        trip={makeTrip({ stops: { stop_nomatch: nomatch } })}
        stop={nomatch}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("这条玩法暂无原文摘录。")).toBeInTheDocument();
    expect(screen.queryByText(/天涯海角/)).not.toBeInTheDocument();
    expect(screen.queryByText(/椰梦长廊/)).not.toBeInTheDocument();
  });

  it("Visit 仅凭 guideSnippets 的提及引用也能精确定位原文", () => {
    const visit = makeVisit("visit_yemeng", "item_yemeng", {
      sourceMentionRefs: [],
      guideSnippets: [
        {
          snippetId: "gsn_1",
          text: "傍晚骑行看日落",
          claimKind: "experience",
          sourceMentionRefs: ["ev_1:m_2"],
        },
      ],
    });
    render(
      <EvidenceSheet
        trip={makeTrip({ visits: { visit_yemeng: visit } })}
        visit={visit}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/椰梦长廊适合傍晚骑行/)).toBeInTheDocument();
    expect(screen.queryByText(/天涯海角/)).not.toBeInTheDocument();
  });

  it("大景点旧数据降级：父缺 refs 时按名称匹配自身，内部 Stop 精确 refs 照常并入", () => {
    const bridge = makeStop({
      stopId: "stop_bridge",
      customName: "情人桥",
      visitRef: "visit_wuzhi",
      sourceMentionRefs: ["ev_1:m_4"],
    });
    const visit = makeVisit("visit_wuzhi", "item_wuzhi", {
      kind: "large_attraction",
      sourceMentionRefs: [],
      childStopRefs: ["stop_bridge"],
    });
    render(
      <EvidenceSheet
        trip={makeTrip({
          itemRegistry: { item_wuzhi: makeItem("item_wuzhi", "蜈支洲岛", ["ev_1"]) },
          visits: { visit_wuzhi: visit },
          stops: { stop_bridge: bridge },
        })}
        visit={visit}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/蜈支洲岛潜水要赶早/)).toBeInTheDocument();
    expect(screen.getByText(/情人桥在蜈支洲岛东侧/)).toBeInTheDocument();
    expect(screen.queryByText(/天涯海角/)).not.toBeInTheDocument();
    expect(screen.queryByText(/椰梦长廊/)).not.toBeInTheDocument();
  });
});
