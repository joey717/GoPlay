import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import type {
  GuideOptionGroup,
  GuideSource,
  Item,
  RelationshipSuggestion,
  SourceEvidence,
  Stop,
  Trip,
  Visit,
} from "@goplay/shared";
import {
  AI_SUPPLEMENT_CHIP_LABEL,
  AI_SUPPLEMENT_CHIP_LABEL_COMPACT,
  AI_SUPPLEMENT_VERIFY_NOTE,
  isFreeAdmissionItem,
} from "@goplay/shared";
import VisitCard from "./VisitCard";
import { cardMainActionLabel, isDimMainAction, type CardCommerce } from "./CardActions";
import {
  REFUND_ASSURANCE_POI_WHITELIST,
  REFUND_ASSURANCE_TEXT,
  showRefundAssurance,
} from "../lib/refundAssurance";

afterEach(cleanup);

// jsdom 未实现 scrollIntoView：绿色 chip 打开 EvidenceSheet 定位提及时会调用，测试内打桩
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

/**
 * 任务 118 现场形态：西岛是大景点（large_attraction），父 Visit 自身没有
 * sourceMentionRefs / guideSnippets，攻略原文只挂在内部玩法（Stop）上。
 * 同一篇证据里还混排了无关地点，用于校验聚合范围未退化为「整篇展示」。
 * 任务 124 起父卡灰色入口改为「打开外部原链」语义（单源直开 / 多源极简列表 /
 * 无链接隐藏），EvidenceSheet 只由绿色 snippet chips 打开。
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
      mention("m_1", "西岛", "西岛渔村慢慢逛，别赶时间"),
      mention("m_2", "牛王岛", "牛王岛看日出要早起，船票提前买"),
      mention("m_3", "椰梦长廊", "椰梦长廊适合傍晚骑行看日落"),
    ],
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
    effectiveMinutes: 240,
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

function makeStop(stopId: string, customName: string, overrides: Partial<Stop> = {}): Stop {
  return {
    stopId,
    state: "attached",
    visitRef: "visit_xidao",
    suggestedVisitRef: null,
    matchedPointRef: null,
    customName,
    order: 0,
    suggestMinutes: 90,
    locationHint: null,
    ticketRelation: "unknown",
    sourceEvidenceRefs: [],
    sourceMentionRefs: [],
    guideSnippets: [],
    userAdjusted: true,
    removedFromOrder: null,
    removedAt: null,
    ...overrides,
  };
}

function makeSource(sourceId: string, overrides: Partial<GuideSource> = {}): GuideSource {
  return {
    sourceId,
    sourceVersion: 1,
    inputKind: "link",
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

function makeTrip(
  overrides: Partial<
    Pick<
      Trip,
      "itemRegistry" | "visits" | "stops" | "evidences" | "guideSources" | "relationshipSuggestions"
    >
  > = {},
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
    dayRefs: ["day_1"],
    days: { day_1: day(1) },
    lodgings: {},
    itemRegistry: { item_xidao: makeItem("item_xidao", "西岛"), ...(overrides.itemRegistry ?? {}) },
    hotelRegistry: {},
    visits: { ...(overrides.visits ?? {}) },
    stops: { ...(overrides.stops ?? {}) },
    evidences: overrides.evidences ?? { ev_1: makeEvidence() },
    globalCandidateRefs: [],
    pendingStopRefs: [],
    relationshipSuggestions: overrides.relationshipSuggestions ?? {},
    guideSources: overrides.guideSources ?? {},
    constraints: [],
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
  };
}

type CardHandler = Mock<() => void>;

/**
 * 读取 styles.css 源文本供样式契约断言（jsdom 无真实布局，间距/字号契约只能
 * 对样式源断言）；vitest 从 web 包目录运行，兼容从仓库根运行时的路径。
 */
function readStylesCss(): string {
  for (const relative of ["src/styles.css", "web/src/styles.css"]) {
    const absolute = resolve(process.cwd(), relative);
    if (existsSync(absolute)) return readFileSync(absolute, "utf8");
  }
  throw new Error("styles.css not found from cwd");
}

/** 读组件源文本供渲染契约断言（兼容从 web 包目录 / 仓库根运行 vitest） */
function readComponentSource(fileName: string): string {
  for (const relative of [`src/components/${fileName}`, `web/src/components/${fileName}`]) {
    const absolute = resolve(process.cwd(), relative);
    if (existsSync(absolute)) return readFileSync(absolute, "utf8");
  }
  throw new Error(`${fileName} not found from cwd`);
}

/**
 * VisitCard 内部用 useSortable：包一层 DndContext + SortableContext 还原真实挂载环境；
 * handlers 可注入自定义 mock（购票/锁定/移除断言用），返回实际挂载的 mock 实例
 */
function renderCard(
  trip: Trip,
  visit: Visit,
  handlers: {
    onPurchaseSelect?: CardHandler;
    onToggleLock?: CardHandler;
    onRemove?: CardHandler;
    onClassifyIntoParent?: Mock<(visitId: string) => void>;
    onAdoptSuggestedStops?: Mock<(visitId: string) => void>;
  } = {},
) {
  const mocks = {
    onPurchaseSelect: handlers.onPurchaseSelect ?? vi.fn(),
    onToggleLock: handlers.onToggleLock ?? vi.fn(),
    onRemove: handlers.onRemove ?? vi.fn(),
    onClassifyIntoParent: handlers.onClassifyIntoParent ?? vi.fn(),
    onAdoptSuggestedStops: handlers.onAdoptSuggestedStops ?? vi.fn(),
  };
  render(
    <DndContext>
      <SortableContext items={[visit.visitId]}>
        <VisitCard
          trip={trip}
          visit={visit}
          isFirst={false}
          index={0}
          total={1}
          onMoveItem={vi.fn()}
          selectMode={false}
          selected={false}
          onToggleSelect={vi.fn()}
          onRemove={mocks.onRemove}
          onPurchaseSelect={mocks.onPurchaseSelect}
          onToggleLock={mocks.onToggleLock}
          onMoveStop={vi.fn()}
          onRemoveStop={vi.fn()}
          onRestoreStop={vi.fn()}
          onClassifyIntoParent={mocks.onClassifyIntoParent}
          onAdoptSuggestedStops={mocks.onAdoptSuggestedStops}
          onAddStop={vi.fn()}
          onOpenStopEvidence={vi.fn()}
        />
      </SortableContext>
    </DndContext>,
  );
  return mocks;
}

/** 父卡（.parent-card）上的原文入口：区分内部玩法 StopRow 自己的入口 */
function parentEvidenceEntry(): Element | null {
  return document.querySelector(".parent-card .evidence-link");
}

describe("VisitCard 大景点原文入口（任务 124 外链语义）", () => {
  it("单一来源（挂在内部玩法上）：父卡入口为外链 <a>，直接指向来源 sourceUrl，不弹 EvidenceSheet", () => {
    const niuwang = makeStop("stop_niuwang", "牛王岛", { sourceMentionRefs: ["ev_1:m_2"] });
    const visit = makeVisit("visit_xidao", "item_xidao", {
      kind: "large_attraction",
      sourceMentionRefs: [],
      guideSnippets: [],
      childStopRefs: ["stop_niuwang"],
    });
    renderCard(
      makeTrip({
        visits: { visit_xidao: visit },
        stops: { stop_niuwang: niuwang },
        guideSources: {
          s_1: makeSource("s_1", {
            title: "西岛一日游攻略",
            sourceUrl: "https://www.xiaohongshu.com/explore/xidao",
            evidenceRefs: ["ev_1"],
          }),
        },
      }),
      visit,
    );

    const entry = parentEvidenceEntry();
    expect(entry).not.toBeNull();
    expect(entry?.tagName).toBe("A");
    expect(entry?.getAttribute("href")).toBe("https://www.xiaohongshu.com/explore/xidao");
    expect(entry?.getAttribute("target")).toBe("_blank");
    expect(entry?.getAttribute("rel")).toContain("noopener");
    expect(entry?.getAttribute("rel")).toContain("noreferrer");
    // 聚合子玩法来源已生效，但灰色入口不再打开 EvidenceSheet
    expect(screen.queryByRole("dialog", { name: "攻略原文" })).not.toBeInTheDocument();
  });

  it("父卡引用块内的灰色入口同样渲染为外链 <a>（snippets 合并块场景）", () => {
    const village = makeStop("stop_village", "西岛渔村", { sourceMentionRefs: ["ev_1:m_1"] });
    const visit = makeVisit("visit_xidao", "item_xidao", {
      kind: "large_attraction",
      sourceMentionRefs: [],
      guideSnippets: [
        {
          snippetId: "snip_1",
          text: "西岛渔村慢慢逛",
          claimKind: "experience",
          sourceMentionRefs: ["ev_1:m_1"],
        },
      ],
      childStopRefs: ["stop_village"],
    });
    renderCard(
      makeTrip({
        visits: { visit_xidao: visit },
        stops: { stop_village: village },
        guideSources: {
          s_1: makeSource("s_1", {
            title: "西岛攻略",
            sourceUrl: "https://www.xiaohongshu.com/explore/quote",
            evidenceRefs: ["ev_1"],
          }),
        },
      }),
      visit,
    );

    const entry = document.querySelector(".parent-card .guide-quote-link");
    expect(entry).not.toBeNull();
    expect(entry?.tagName).toBe("A");
    expect(entry?.getAttribute("href")).toBe("https://www.xiaohongshu.com/explore/quote");
    expect(entry?.getAttribute("rel")).toContain("noopener");
    expect(screen.queryByRole("dialog", { name: "攻略原文" })).not.toBeInTheDocument();
  });

  it("多来源：点击灰色入口弹极简来源列表（只列标题与打开原文），不弹 EvidenceSheet", () => {
    // 同一玩法引用两篇来源的证据 → 父卡聚合出两个外部原链
    const village = makeStop("stop_village", "西岛渔村", {
      sourceMentionRefs: ["ev_1:m_1", "ev_2:n_1"],
      sourceEvidenceRefs: ["ev_1", "ev_2"],
    });
    const visit = makeVisit("visit_xidao", "item_xidao", {
      kind: "large_attraction",
      sourceMentionRefs: [],
      guideSnippets: [],
      childStopRefs: ["stop_village"],
    });
    renderCard(
      makeTrip({
        visits: { visit_xidao: visit },
        stops: { stop_village: village },
        guideSources: {
          s_1: makeSource("s_1", {
            title: "西岛渔村篇",
            sourceUrl: "https://www.xiaohongshu.com/explore/s1",
            evidenceRefs: ["ev_1"],
          }),
          s_2: makeSource("s_2", {
            title: "西岛交通篇",
            canonicalUrl: "https://www.xiaohongshu.com/explore/s2",
            evidenceRefs: ["ev_2"],
          }),
        },
        evidences: {
          ev_1: makeEvidence(),
          ev_2: {
            ...makeEvidence(),
            evidenceId: "ev_2",
            mentions: [
              {
                mentionId: "n_1",
                text: "",
                quoteText: "上岛船班在西门码头",
                bbox: null,
                extractedName: "西岛",
                locationHint: null,
                modelSummary: null,
              },
            ],
          },
        },
      }),
      visit,
    );

    const entry = parentEvidenceEntry();
    expect(entry).not.toBeNull();
    expect(entry?.tagName).toBe("BUTTON");
    expect(document.querySelector(".source-menu")).toBeNull();

    fireEvent.click(entry as Element);

    const menu = document.querySelector(".source-menu");
    expect(menu).not.toBeNull();
    // 只列来源标题 + 打开原文，不出现 AI 提炼内容（攻略原文面板未打开）
    expect(screen.getByText("西岛渔村篇")).toBeInTheDocument();
    expect(screen.getByText("西岛交通篇")).toBeInTheDocument();
    const openLinks = [...document.querySelectorAll<HTMLAnchorElement>(".source-menu-open")];
    expect(openLinks.map((link) => link.getAttribute("href"))).toEqual([
      "https://www.xiaohongshu.com/explore/s1",
      "https://www.xiaohongshu.com/explore/s2",
    ]);
    for (const link of openLinks) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
      expect(link.getAttribute("rel")).toContain("noreferrer");
    }
    expect(screen.queryByRole("dialog", { name: "攻略原文" })).not.toBeInTheDocument();

    // 点遮罩关闭
    fireEvent.click(document.querySelector(".purchase-menu-overlay") as Element);
    expect(document.querySelector(".source-menu")).toBeNull();
  });

  it("无外部链接（text 来源）：父卡入口隐藏，不再降级打开 EvidenceSheet", () => {
    const village = makeStop("stop_village", "西岛渔村", { sourceMentionRefs: ["ev_1:m_1"] });
    const visit = makeVisit("visit_xidao", "item_xidao", {
      kind: "large_attraction",
      sourceMentionRefs: [],
      guideSnippets: [],
      childStopRefs: ["stop_village"],
    });
    renderCard(
      makeTrip({
        visits: { visit_xidao: visit },
        stops: { stop_village: village },
        guideSources: {
          s_text: makeSource("s_text", { inputKind: "text", evidenceRefs: ["ev_1"] }),
        },
      }),
      visit,
    );

    // 有可回看证据，但无外部原链 → 灰色入口整体隐藏
    expect(parentEvidenceEntry()).toBeNull();
    expect(screen.queryByText(/查看攻略原文/)).toBeNull();
    expect(screen.queryByRole("dialog", { name: "攻略原文" })).not.toBeInTheDocument();
  });

  it("父 Visit 与内部玩法都没有可展示内容：不渲染空入口", () => {
    const village = makeStop("stop_village", "西岛渔村", {
      sourceMentionRefs: [],
      sourceEvidenceRefs: [],
    });
    const visit = makeVisit("visit_xidao", "item_xidao", {
      kind: "large_attraction",
      sourceMentionRefs: [],
      guideSnippets: [],
      childStopRefs: ["stop_village"],
    });
    renderCard(
      makeTrip({ visits: { visit_xidao: visit }, stops: { stop_village: village } }),
      visit,
    );

    expect(parentEvidenceEntry()).toBeNull();
    expect(document.querySelector(".guide-quote")).toBeNull();
    expect(screen.queryByText(/查看攻略原文/)).toBeNull();
  });

  it("父 Visit 缺精确 refs 但 sourceEvidenceRefs 名称降级可命中：入口照常显示（外链语义）", () => {
    const visit = makeVisit("visit_xidao", "item_xidao", {
      kind: "large_attraction",
      sourceMentionRefs: [],
      guideSnippets: [],
      // #348 渲染判定改为子玩法驱动，夹具补 children 维持原断言语义（悬空 ref 即保持父卡形态、不新增可见子玩法）
      childStopRefs: ["stop_kid"],
    });
    renderCard(
      makeTrip({
        itemRegistry: { item_xidao: makeItem("item_xidao", "西岛", ["ev_1"]) },
        visits: { visit_xidao: visit },
        guideSources: {
          s_1: makeSource("s_1", {
            title: "降级命中来源",
            sourceUrl: "https://www.xiaohongshu.com/explore/legacy",
            evidenceRefs: ["ev_1"],
          }),
        },
      }),
      visit,
    );

    const entry = parentEvidenceEntry();
    expect(entry).not.toBeNull();
    expect(entry?.tagName).toBe("A");
    expect(entry?.getAttribute("href")).toBe("https://www.xiaohongshu.com/explore/legacy");
  });
});

describe("VisitCard 普通景点（任务 124：绿色 chip 与灰色入口分离）", () => {
  it("无外部链接来源：灰色入口隐藏，绿色 chip 仍打开 EvidenceSheet 并定位对应提及", () => {
    const visit = makeVisit("visit_1", "item_xidao", {
      sourceMentionRefs: ["ev_1:m_1"],
      guideSnippets: [
        {
          snippetId: "snip_1",
          text: "西岛渔村慢慢逛",
          claimKind: "experience",
          sourceMentionRefs: ["ev_1:m_1"],
        },
      ],
    });
    renderCard(
      makeTrip({
        visits: { visit_1: visit },
        guideSources: {
          s_text: makeSource("s_text", { inputKind: "text", evidenceRefs: ["ev_1"] }),
        },
      }),
      visit,
    );

    // 灰色入口隐藏（无外部原链），绿色 chip 保留
    expect(document.querySelector(".evidence-link")).toBeNull();
    const chip = document.querySelector(".guide-snippet-chip");
    expect(chip).not.toBeNull();

    fireEvent.click(chip as Element);

    expect(screen.getByRole("dialog", { name: "攻略原文" })).toBeInTheDocument();
    expect(screen.getByText(/西岛渔村慢慢逛，别赶时间/)).toBeInTheDocument();
    // focusMentionRef 命中：面板内对应攻略提示高亮
    const hit = document.querySelector(".evidence-snippet.hit");
    expect(hit).not.toBeNull();
    expect(hit?.textContent).toContain("西岛渔村慢慢逛");
  });

  it("有外部链接来源：灰色入口为外链 <a>；绿色 chip 打开 EvidenceSheet 互不干扰", () => {
    const visit = makeVisit("visit_1", "item_xidao", {
      sourceMentionRefs: ["ev_1:m_1"],
      guideSnippets: [
        {
          snippetId: "snip_1",
          text: "西岛渔村慢慢逛",
          claimKind: "experience",
          sourceMentionRefs: ["ev_1:m_1"],
        },
      ],
    });
    renderCard(
      makeTrip({
        visits: { visit_1: visit },
        guideSources: {
          s_1: makeSource("s_1", {
            title: "西岛攻略",
            sourceUrl: "https://www.xiaohongshu.com/explore/ordinary",
            evidenceRefs: ["ev_1"],
          }),
        },
      }),
      visit,
    );

    const entry = document.querySelector(".evidence-link");
    expect(entry).not.toBeNull();
    expect(entry?.tagName).toBe("A");
    expect(entry?.getAttribute("href")).toBe("https://www.xiaohongshu.com/explore/ordinary");
    expect(screen.queryByRole("dialog", { name: "攻略原文" })).not.toBeInTheDocument();

    const chip = document.querySelector(".guide-snippet-chip");
    fireEvent.click(chip as Element);
    expect(screen.getByRole("dialog", { name: "攻略原文" })).toBeInTheDocument();
    expect(screen.getByText(/西岛渔村慢慢逛，别赶时间/)).toBeInTheDocument();
  });
});

describe("VisitCard 大景点购票入口（任务 127）", () => {
  function largeVisit(overrides: Partial<Visit> = {}): Visit {
    return makeVisit("visit_xidao", "item_xidao", {
      kind: "large_attraction",
      // #348 渲染判定改为子玩法驱动，夹具补 children 维持原断言语义（「父卡操作行」等用例须真走父卡）
      childStopRefs: ["stop_kid"],
      ...overrides,
    });
  }

  it("有飞猪跳转：父卡操作行显示购票状态/购票入口，未确定状态默认「去购票」并新窗口打开 jumpUrl", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const visit = largeVisit();
    renderCard(
      makeTrip({
        itemRegistry: {
          item_xidao: {
            ...makeItem("item_xidao", "西岛"),
            jumpUrl: "https://h5.m.fliggy.com/detail.html?shId=123",
          },
        },
        visits: { visit_xidao: visit },
      }),
      visit,
    );

    expect(screen.getByTitle("点击选择购票状态")).toBeInTheDocument();
    const book = screen.getByRole("button", { name: "去购票" });
    expect(book).toBeInTheDocument();

    fireEvent.click(book);
    expect(openSpy).toHaveBeenCalledWith(
      "https://h5.m.fliggy.com/detail.html?shId=123",
      "_blank",
      "noopener",
    );
    openSpy.mockRestore();
  });

  it("无 provider/detail URL：购票入口隐藏，购票状态切换保留", () => {
    const visit = largeVisit();
    renderCard(makeTrip({ visits: { visit_xidao: visit } }), visit);

    expect(document.querySelector(".parent-card .booklink")).toBeNull();
    expect(screen.getByTitle("点击选择购票状态")).toBeInTheDocument();
  });

  it("购票状态菜单选择「已购」：调用 onPurchaseSelect(\"bought\")，与普通卡同一 operation", () => {
    const onPurchaseSelect = vi.fn();
    const visit = largeVisit();
    renderCard(makeTrip({ visits: { visit_xidao: visit } }), visit, { onPurchaseSelect });

    fireEvent.click(screen.getByTitle("点击选择购票状态"));
    expect(screen.getByRole("menu", { name: "选择购票状态" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "已购" }));
    expect(onPurchaseSelect).toHaveBeenCalledTimes(1);
    expect(onPurchaseSelect).toHaveBeenCalledWith("bought");
  });

  it("已锁定且已购：父卡 ✕ 触发护栏，确认后先解锁、购票改未确定、再移除（不回归）", () => {
    const onToggleLock = vi.fn();
    const onPurchaseSelect = vi.fn();
    const onRemove = vi.fn();
    const visit = largeVisit({ locked: true, purchaseState: "bought" });
    renderCard(makeTrip({ visits: { visit_xidao: visit } }), visit, {
      onToggleLock,
      onPurchaseSelect,
      onRemove,
    });

    fireEvent.click(screen.getByTitle("移除（移回候选池）"));
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "已锁定且已购票，不能直接移除" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "先处理并移出" }));
    expect(onToggleLock).toHaveBeenCalledTimes(1);
    expect(onPurchaseSelect).toHaveBeenCalledTimes(1);
    expect(onPurchaseSelect).toHaveBeenCalledWith("unknown");
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("普通景点行为不变：右上只剩 ✕，购票状态入口统一在整卡底部 .card-actions（任务 220 / 225 移除分享钮 / #373 去锁定钮）", () => {
    const visit = makeVisit("visit_1", "item_xidao");
    renderCard(makeTrip({ visits: { visit_1: visit } }), visit);

    expect(document.querySelector(".parent-card")).toBeNull();
    expect(document.querySelector(".parent-iact")).toBeNull();
    // 右上操作列只剩移除 ✕（购票入口已下沉到卡片底部操作区）
    const iact = document.querySelector(".iact");
    expect(iact).not.toBeNull();
    expect(iact?.querySelectorAll("button")).toHaveLength(1);
    expect(iact?.querySelector("button")?.getAttribute("title")).toBe("移除（移回候选池）");

    // 底部整行动作区：状态入口（无 jumpUrl 时没有主按钮；分享钮 225 起隐藏；锁定钮 #373 起移除）
    const actions = document.querySelector(".item:not(.parent-item) > .card-actions");
    expect(actions).not.toBeNull();
    expect(document.querySelector(".prodrow .card-actions")).toBeNull();
    expect(actions?.querySelectorAll("button")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "分享" })).not.toBeInTheDocument();
    expect(screen.getByTitle("点击选择购票状态")).toBeInTheDocument();
  });
});

describe("VisitCard 无图统一占位（任务 128）", () => {
  it("普通卡无 mainPic：主图窗渲染占位（西岛 → 海滩类），无 <img>", () => {
    const visit = makeVisit("visit_1", "item_xidao");
    renderCard(makeTrip({ visits: { visit_1: visit } }), visit);

    const thumb = document.querySelector(".thumb");
    expect(thumb?.querySelector(".ph-tile.ph-beach")).not.toBeNull();
    expect(thumb?.querySelector("img")).toBeNull();
    // 短名在占位内（完整名同时在卡片标题，不能全局 getByText）
    expect(thumb?.querySelector(".ph-name")?.textContent).toBe("西岛");
  });

  it("普通卡有 mainPic：渲染 thumb-frame 图片与「飞猪实图」角标，不渲染占位", () => {
    const trip = makeTrip({
      itemRegistry: {
        // Task #296：mainPic 仅飞猪点位有（custom 契约恒 null），夹具按 origin=fliggy 构造
        item_xidao: { ...makeItem("item_xidao", "西岛"), origin: "fliggy", providerId: "F1", mainPic: "https://img.example/xidao.jpg" },
      },
    });
    const visit = makeVisit("visit_1", "item_xidao");
    renderCard(trip, visit);

    expect(document.querySelector(".thumb .thumb-frame img")).not.toBeNull();
    expect(document.querySelector(".thumb .ph-tile")).toBeNull();
    expect(screen.getByText("飞猪实图")).toBeInTheDocument();
  });

  it("普通卡图片加载失败：切换为统一占位填满同一窗口", () => {
    const trip = makeTrip({
      itemRegistry: {
        item_xidao: { ...makeItem("item_xidao", "西岛"), origin: "fliggy", providerId: "F1", mainPic: "https://img.example/broken.jpg" },
      },
    });
    const visit = makeVisit("visit_1", "item_xidao");
    renderCard(trip, visit);

    const img = document.querySelector(".thumb .thumb-frame img");
    expect(img).not.toBeNull();
    fireEvent.error(img as Element);

    expect(document.querySelector(".thumb .ph-tile")).not.toBeNull();
    expect(document.querySelector(".thumb img")).toBeNull();
  });

  it("大景区横幅无图：占位填满 154px 横幅窗口，aria 保留完整名称", () => {
    const visit = makeVisit("visit_xidao", "item_xidao", {
      kind: "large_attraction",
      visitMode: "full_day",
      // #348 渲染判定改为子玩法驱动，夹具补 children 维持原断言语义
      childStopRefs: ["stop_kid"],
    });
    renderCard(makeTrip({ visits: { visit_xidao: visit } }), visit);

    const banner = document.querySelector(".parent-banner");
    const tile = banner?.querySelector(".ph-tile");
    expect(tile).not.toBeNull();
    expect(tile?.getAttribute("aria-label")).toBe("暂无图片：西岛（海滩海岛）");
  });

  it("大景区横幅有图：渲染 <img>，不渲染占位", () => {
    const trip = makeTrip({
      itemRegistry: {
        item_xidao: { ...makeItem("item_xidao", "西岛"), origin: "fliggy", providerId: "F1", mainPic: "https://img.example/xidao.jpg" },
      },
    });
    const visit = makeVisit("visit_xidao", "item_xidao", {
      kind: "large_attraction",
      visitMode: "full_day",
      // #348 渲染判定改为子玩法驱动，夹具补 children 维持原断言语义
      childStopRefs: ["stop_kid"],
    });
    renderCard(trip, visit);

    expect(document.querySelector(".parent-banner img")).not.toBeNull();
    expect(document.querySelector(".parent-banner .ph-tile")).toBeNull();
  });

  /**
   * Task #297：真实落盘数据形态回归——server/data/48275e19….json 的西岛父卡＝
   * origin:"fliggy"、providerId:"2611"、mainPic:真实 alicdn 外链。#296 交付时 Q7 夹具误造
   * custom+mainPic:null 致 PD 复核 Q7.png 看到父卡走 PX 攻略图；此用例以真实形态锚定
   * 「fliggy+mainPic → 父卡渲染飞猪图（非 PX、非占位）」，防夹具保真缺口再次逃逸到组件层。
   */
  it("大景区横幅（真实 48275e19 西岛形态：fliggy+mainPic）：渲染飞猪外链图，src 逐字等于真实 mainPic", () => {
    const REAL_XIDAO_MAINPIC = "https://img.alicdn.com/tfscom/TB1lyRxfZbI8KJjy1zdSuve1VXa";
    const trip = makeTrip({
      itemRegistry: {
        item_xidao: {
          ...makeItem("item_xidao", "西岛"),
          origin: "fliggy",
          providerId: "2611",
          mainPic: REAL_XIDAO_MAINPIC,
        },
      },
    });
    const visit = makeVisit("visit_xidao", "item_xidao", {
      kind: "large_attraction",
      visitMode: "full_day",
      // #348 渲染判定改为子玩法驱动，夹具补 children 维持原断言语义
      childStopRefs: ["stop_kid"],
    });
    renderCard(trip, visit);

    const bannerImg = document.querySelector(".parent-banner img");
    expect(bannerImg).not.toBeNull();
    // jsdom 不加载外链、不触发 onError，故 src 属性即渲染裁决结果：必须是飞猪真实外链
    expect(bannerImg?.getAttribute("src")).toBe(REAL_XIDAO_MAINPIC);
    // 父卡不得回退占位（fliggy 有图优先级最高）
    expect(document.querySelector(".parent-banner .ph-tile")).toBeNull();
  });

  it("大景区横幅无图占位：类别线条图标替代单字，aria 完整名称保留", () => {
    const visit = makeVisit("visit_xidao", "item_xidao", {
      kind: "large_attraction",
      visitMode: "full_day",
      // #348 渲染判定改为子玩法驱动，夹具补 children 维持原断言语义
      childStopRefs: ["stop_kid"],
    });
    renderCard(makeTrip({ visits: { visit_xidao: visit } }), visit);

    const tile = document.querySelector(".parent-banner .ph-tile");
    expect(tile?.querySelector("svg.ph-icon")).not.toBeNull();
    expect(tile?.getAttribute("role")).toBe("img");
    expect(tile?.getAttribute("aria-label")).toBe("暂无图片：西岛（海滩海岛）");
  });
});

describe("VisitCard 操作行布局与占位图标（任务 130）", () => {
  /** 有飞猪跳转链接的父卡：购票药丸出现，锁/购/票三钮同行 */
  function renderLargeWithJump() {
    const trip = makeTrip({
      itemRegistry: {
        item_xidao: {
          ...makeItem("item_xidao", "西岛"),
          jumpUrl: "https://h5.m.fliggy.com/detail.html?shId=123",
        },
      },
    });
    // #348 渲染判定改为子玩法驱动，夹具补 children 维持原断言语义
    const visit = makeVisit("visit_xidao", "item_xidao", {
      kind: "large_attraction",
      childStopRefs: ["stop_kid"],
    });
    renderCard(trip, visit);
  }

  it("父卡：无独立操作行，状态/飞猪入口统一在底部 .parent-foot .card-actions（任务 220 / 225 移除分享钮 / #373 去锁定钮）", () => {
    renderLargeWithJump();

    // 旧父卡操作行已退役
    expect(document.querySelector(".parent-iact")).toBeNull();

    // 底部信息行同排两件套：状态入口 → 飞猪按钮（分享钮 225 起隐藏，锁定钮 #373 起移除）
    const row = document.querySelector(".parent-card .parent-foot .card-actions");
    expect(row).not.toBeNull();
    const buttons = [...row!.querySelectorAll("button")];
    expect(buttons).toHaveLength(2);
    expect(buttons[0].getAttribute("title")).toBe("点击选择购票状态");
    expect(buttons[1].className).toBe("booklink");
    // fixture 默认 purchaseState unknown → 任务 220 文案「去购票」
    expect(buttons[1].textContent).toBe("去购票");
    // 分享圆钮不再渲染（Task #225：分享功能未落地前隐藏，样式保留备用）
    expect(row!.querySelector(".act-share")).toBeNull();

    // 0 内部点位：不显示「岛内 0 个点」文案（任务 213 补充）
    expect(document.querySelector(".parent-sub")).toBeNull();
  });

  it("点击行为不回归：购票入口仍触发原处理器（#373 锁定钮已移除）", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const trip = makeTrip({
      itemRegistry: {
        item_xidao: {
          ...makeItem("item_xidao", "西岛"),
          jumpUrl: "https://h5.m.fliggy.com/detail.html?shId=123",
        },
      },
    });
    const visit = makeVisit("visit_xidao", "item_xidao", { kind: "large_attraction" });
    renderCard(trip, visit);

    // 锁定钮不再渲染（Task #373）
    expect(screen.queryByTitle("锁定为已定项：AI 不会改动它")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "去购票" }));
    expect(openSpy).toHaveBeenCalledWith(
      "https://h5.m.fliggy.com/detail.html?shId=123",
      "_blank",
      "noopener",
    );
    openSpy.mockRestore();
  });

  // ===== 任务 200：购票入口文案按状态分流（未确定/现场买 → 去购票） =====
  /** 有飞猪跳转链接的普通卡：按给定购票状态与 ticketInfo 渲染，读取购票按钮文本 */
  function renderNormalWithJump(
    purchaseState: Visit["purchaseState"],
    ticketInfo: string | null = null,
  ) {
    const trip = makeTrip({
      itemRegistry: {
        item_xidao: {
          ...makeItem("item_xidao", "西岛"),
          jumpUrl: "https://h5.m.fliggy.com/detail.html?shId=123",
          ...(ticketInfo !== null ? { ticketInfo } : {}),
        },
      },
    });
    const visit = makeVisit("visit_xidao", "item_xidao", { purchaseState });
    renderCard(trip, visit);
  }

  it("未确定 / 现场买（原「想买」）：购票按钮文案为「去购票」，与 ticketInfo 无关", () => {
    renderNormalWithJump("unknown");
    expect(screen.getByRole("button", { name: "去购票" })).toBeInTheDocument();

    cleanup(); // 同一用例内重渲染前先卸载上一棵树（afterEach 只管用例之间）
    renderNormalWithJump("toBuy");
    expect(screen.getByRole("button", { name: "去购票" })).toBeInTheDocument();
  });

  it("已购「查看详情」；无需购票与价格未知统一降级为「查票价」（与 ticketInfo 无关）", () => {
    renderNormalWithJump("bought");
    expect(screen.getByRole("button", { name: "查看详情" })).toBeInTheDocument();

    cleanup();
    renderNormalWithJump("noTicket", "成人票 100 元");
    expect(screen.getByRole("button", { name: "查票价" })).toBeInTheDocument();

    cleanup();
    renderNormalWithJump("noTicket");
    expect(screen.getByRole("button", { name: "查票价" })).toBeInTheDocument();
  });

  it("普通卡 thumb 无图占位：类别线条图标替代单字", () => {
    const visit = makeVisit("visit_1", "item_xidao");
    renderCard(makeTrip({ visits: { visit_1: visit } }), visit);

    expect(document.querySelector(".thumb .ph-tile svg.ph-icon")).not.toBeNull();
    expect(document.querySelector(".thumb .ph-glyph")).toBeNull();
  });

  it("操作区样式契约：景点/酒店共用 .card-actions，按钮定宽 28/60/128、高 32（styles.css 源断言）", () => {
    const css = readStylesCss();
    // 整行右对齐，间距 8px，右/下内缩到卡片右 padding 线
    const actionsRule = css.match(/^\.card-actions \{[^}]*\}/m);
    expect(actionsRule).not.toBeNull();
    expect(actionsRule?.[0]).toContain("display: flex");
    expect(actionsRule?.[0]).toContain("justify-content: flex-end");
    expect(actionsRule?.[0]).toContain("gap: 8px");
    expect(actionsRule?.[0]).toContain("padding: 0 9px 9px");
    expect(actionsRule?.[0]).toContain("margin-left: auto");

    // 灰短按钮定宽 60px、高 32px；橙主按钮定宽 128px、高 32px
    const statusRule = css.match(/^\.card-actions \.act-status \{[^}]*\}/m);
    expect(statusRule).not.toBeNull();
    expect(statusRule?.[0]).toContain("width: 60px");
    expect(statusRule?.[0]).toContain("height: 32px");
    expect(statusRule?.[0]).toContain("border-radius: 8px");

    // 分享圆钮 28px
    const shareRule = css.match(/^\.card-actions \.act-share \{[^}]*\}/m);
    expect(shareRule).not.toBeNull();
    expect(shareRule?.[0]).toContain("width: 28px");
    expect(shareRule?.[0]).toContain("height: 28px");
    expect(shareRule?.[0]).toContain("border-radius: 50%");

    // 景点「去购票」与酒店「去订房」共用同一类名、同一档定宽样式
    const bookRule = css.match(/^\.booklink \{[^}]*\}/m);
    expect(bookRule).not.toBeNull();
    expect(bookRule?.[0]).toContain("width: 128px");
    expect(bookRule?.[0]).toContain("height: 32px");
    expect(bookRule?.[0]).toContain("background: var(--cta)");
    expect(bookRule?.[0]).toContain("color: #fff");

    // 降级主按钮（查票价 / 查看详情）浅橙
    const dimRule = css.match(/^\.booklink\.dim \{[^}]*\}/m);
    expect(dimRule).not.toBeNull();
    expect(dimRule?.[0]).toContain("background: #fde8d8");

    // 两套旧类名与旧父卡操作行已退役，避免视觉再次分叉
    expect(css).not.toMatch(/\.hotelbody \.hbook\s*\{/);
    expect(css).not.toMatch(/\.hotelbody \.hstate\s*\{/);
    expect(css).not.toMatch(/\.hfoot-actions\s*\{/);
    expect(css).not.toMatch(/\.parent-iact\s*\{/);

    // 父卡底部信息行（Task #356 DEMO v0.6）：改为横向——时长摘要居左、动作区居右同一行，右缘与其他卡片对齐
    const footRule = css.match(/^\.parent-foot \{[^}]*\}/m);
    expect(footRule).not.toBeNull();
    expect(footRule?.[0]).toContain("flex-direction: row");
    const footActionsRule = css.match(/^\.parent-foot \.card-actions \{[^}]*\}/m)?.[0];
    expect(footActionsRule).toContain("padding: 0");
    // Task #365：无话术父卡（常态，SHOW_ESTIMATED_TIMES 关→.parent-foot 单子）按钮组占满行宽——
    // #356 row 化后若沿用基类 flex:0 0 auto，space-between 单子落 flex-start 左缩（亚龙湾回归）；
    // flex:1 1 auto + min-width:0 拉伸后内部基类 justify-content:flex-end 右排，与普通卡转化行一致；
    // 有话术父卡（西岛/蜈支洲岛）由 .buy-assure margin-right:auto 维持 #356 形态
    expect(footActionsRule).toContain("flex: 1 1 auto");
    expect(footActionsRule).toContain("min-width: 0");
    expect(footActionsRule).toContain("margin-left: 0");

    // 普通卡两行栅格（Task #346 把手列移除后）：上行「缩略图 · 正文」，动作区仍占整行
    expect(css).toMatch(/grid-template-areas:\s*"thumb body"\s*"acts acts"/);
    // 把手列整体退役（PD 2026-11-04 决策）：styles 中不再残留 .grip 规则
    expect(css).not.toMatch(/^\.grip[\s,{:]/m);
    // 酒店卡动作区整行换行
    const hotelActionsRule = css.match(/^\.hotelcard > \.card-actions \{[^}]*\}/m);
    expect(hotelActionsRule).not.toBeNull();
    expect(hotelActionsRule?.[0]).toContain("flex: 0 0 100%");
  });

  it("占位样式契约：三场景收敛 .ph-icon 尺寸并降权 .ph-name（styles.css 源断言）", () => {
    const css = readStylesCss();
    expect(css.match(/\.thumb \.ph-icon \{[^}]*\}/)?.[0]).toContain("width: 18px");
    expect(css.match(/\.child-pic \.ph-icon \{[^}]*\}/)?.[0]).toContain("width: 15px");
    expect(css.match(/\.parent-banner \.ph-icon \{[^}]*\}/)?.[0]).toContain("width: 20px");
    const nameRule = css.match(/^\.ph-name \{[^}]*\}/m);
    expect(nameRule).not.toBeNull();
    expect(nameRule?.[0]).toContain("font-weight: 500");
    // 单字时代的 .ph-glyph 规则应已移除
    expect(css).not.toContain(".ph-glyph");
  });
});

describe("VisitCard 岛内小行程空态（任务 176）", () => {
  /** 无内部玩法的大景区：横幅 + 父卡结构仍完整，仅岛内小行程块不渲染 */
  function renderLarge(childStopRefs: string[], stops: Record<string, Stop> = {}): void {
    const visit = makeVisit("visit_xidao", "item_xidao", {
      kind: "large_attraction",
      visitMode: "full_day",
      childStopRefs,
    });
    renderCard(makeTrip({ visits: { visit_xidao: visit }, stops }), visit);
  }

  it("大景点没有任何内部 child stop：不渲染岛内小行程标题、容器与空态引导", () => {
    renderLarge([]);

    expect(document.querySelector(".child-head")).toBeNull();
    expect(document.querySelector(".child-list")).toBeNull();
    expect(screen.queryByText("岛内小行程")).toBeNull();
    // #348（PD 2026-11-04）：0 子玩法的大景区改渲染普通卡形态——.parent-card 不再出现。
    // 原「父卡本体不受影响」断言随渲染判定改为子玩法驱动而反转（非静默放宽）；岛内小行程
    // 空态块本就为 null，语义不变。「悬空 childStopRefs → 仍父卡但岛内小行程整块隐藏」的
    // 父卡空态覆盖由下一用例（childStopRefs 全部悬空）保留。
    expect(document.querySelector(".parent-card")).toBeNull();
    expect(document.querySelector(".parent-sub")).toBeNull();
  });

  it("childStopRefs 全部悬空（stops 中不存在）：同样整块不渲染", () => {
    renderLarge(["stop_ghost_1", "stop_ghost_2"]);

    expect(document.querySelector(".child-head")).toBeNull();
    expect(document.querySelector(".child-list")).toBeNull();
    expect(screen.queryByText("岛内小行程")).toBeNull();
    expect(document.querySelector(".parent-sub")).toBeNull();
  });

  it("有内部 child stop：岛内小行程标题与容器照常渲染（行为保持）", () => {
    const bridge = makeStop("stop_bridge", "情人桥");
    const beach = makeStop("stop_beach", "海滨浴场", { order: 1 });
    renderLarge(["stop_bridge", "stop_beach"], { stop_bridge: bridge, stop_beach: beach });

    expect(document.querySelector(".child-head")).not.toBeNull();
    expect(screen.getByText("岛内小行程")).toBeInTheDocument();
    const list = document.querySelector(".child-list");
    expect(list?.textContent).toContain("情人桥");
    expect(list?.textContent).toContain("海滨浴场");
  });

  it("alternate 备选玩法不误算为已排内部行程：仅备选时仍隐藏岛内小行程", () => {
    const alt = makeStop("stop_alt", "夜潜观鱼");
    const visit = makeVisit("visit_xidao", "item_xidao", {
      kind: "large_attraction",
      visitMode: "full_day",
      // #348 渲染判定改为子玩法驱动：本用例须维持父卡形态才能验证「备选玩法区（.reserve-block）
      // 独立渲染、且 alternate 不计入岛内小行程」。补一个悬空 childStopRefs 保持父卡（childStops
      // 过滤后仍为空 → 岛内小行程整块隐藏），原「alternate 不误算为已排内部行程」断言语义不变。
      childStopRefs: ["stop_ghost"],
      alternateStopRefs: ["stop_alt"],
    });
    renderCard(makeTrip({ visits: { visit_xidao: visit }, stops: { stop_alt: alt } }), visit);

    // 备选玩法区独立渲染（折叠态入口）
    expect(document.querySelector(".reserve-block")).not.toBeNull();
    expect(screen.getByText(/备选玩法 1 项/)).toBeInTheDocument();
    // Task #343（PD 拍板，#341 顺带 gate）：估算时间开关关闭时展开备选区不出现「建议 X」chip
    // （makeStop 默认 suggestMinutes=90，gate 前展开会渲染「建议 …」）
    fireEvent.click(document.querySelector(".reserve-toggle") as HTMLElement);
    expect(document.querySelector(".reserve-list")).not.toBeNull();
    expect(document.querySelector(".reserve-list")?.textContent).not.toContain("建议");
    // alternate 不计入已排内部行程：岛内小行程整块隐藏，0 点位文案也不显示
    expect(document.querySelector(".child-head")).toBeNull();
    expect(document.querySelector(".child-list")).toBeNull();
    expect(screen.queryByText("岛内小行程")).toBeNull();
    expect(document.querySelector(".parent-sub")).toBeNull();
  });

  it("样式契约：空态引导 .child-empty 已随任务 176 退役（styles.css 源断言）", () => {
    const css = readStylesCss();
    expect(css).not.toMatch(/\.child-empty\s*\{/);
  });
});

/**
 * 任务 190 实用参考选项组：可折叠主题卡（默认摘要：主题 / 选项数 / 最低参考价），
 * 展开后每选项一行 + 底部原文入口与「价格仅供参考」；无数据不渲染（历史 Trip 兼容）。
 * golden sample：西岛环岛交通（三轮车 / 电动车 / 观光车）。
 */
describe("VisitCard 实用参考选项组（任务 190）", () => {
  function makeOptionGroup(overrides: Partial<GuideOptionGroup> = {}): GuideOptionGroup {
    return {
      groupId: "gog_transport",
      topic: "西岛环岛交通",
      category: "transport",
      options: [
        {
          label: "三轮车",
          priceText: "50元/圈",
          routeText: null,
          sceneText: "带老人小孩省力",
          bargain: true,
          noteText: null,
          sourceMentionRefs: ["ev_1:m_1"],
        },
        {
          label: "电动车",
          priceText: "30元/小时",
          routeText: null,
          sceneText: null,
          bargain: null,
          noteText: null,
          sourceMentionRefs: ["ev_1:m_1"],
        },
        {
          label: "观光车",
          priceText: "20元/圈",
          routeText: "环岛一周",
          sceneText: null,
          bargain: null,
          noteText: null,
          sourceMentionRefs: ["ev_1:m_1"],
        },
      ],
      sourceMentionRefs: ["ev_1:m_1"],
      collectedAt: "2026-10-20T08:00:00.000Z",
      ...overrides,
    };
  }

  it("golden 折叠态摘要：主题 / 选项数 / 最低参考价一行，展开前不渲染选项明细", () => {
    const visit = makeVisit("visit_xidao", "item_xidao", {
      sourceMentionRefs: ["ev_1:m_1"],
      optionGroups: [makeOptionGroup()],
    });
    renderCard(makeTrip({ visits: { visit_xidao: visit } }), visit);

    const head = document.querySelector(".og-head");
    expect(head).not.toBeNull();
    expect(head?.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("西岛环岛交通")).toBeInTheDocument();
    // 摘要 = 选项数 + 最低参考价（Task #274 拆成两段，中间「·」由 CSS 伪元素补，
    // 窄屏可上下两行，故这里按内容分别断言）
    expect(screen.getByText("3 个选项")).toBeInTheDocument();
    expect(screen.getByText("低至 ¥20")).toBeInTheDocument();
    // 折叠态不渲染选项行：避免常驻大段文字
    expect(screen.queryByText("三轮车")).toBeNull();
    expect(screen.queryByText("50元/圈")).toBeNull();
    expect(screen.queryByText("价格仅供参考")).toBeNull();
  });

  it("展开：每选项一行 + 可议价标记 + 分类 chip + 「价格仅供参考」；收起复原", () => {
    const visit = makeVisit("visit_xidao", "item_xidao", {
      sourceMentionRefs: ["ev_1:m_1"],
      optionGroups: [makeOptionGroup()],
    });
    renderCard(makeTrip({ visits: { visit_xidao: visit } }), visit);

    fireEvent.click(document.querySelector(".og-head") as Element);

    expect(document.querySelector(".og-head")?.getAttribute("aria-expanded")).toBe("true");
    // 每选项一行：选项名 + 原文价格与单位 + 场景/路线补充
    const rows = [...document.querySelectorAll(".og-row")];
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain("三轮车");
    expect(rows[0]?.textContent).toContain("50元/圈");
    expect(rows[0]?.textContent).toContain("可议价");
    expect(rows[0]?.textContent).toContain("带老人小孩省力");
    expect(rows[2]?.textContent).toContain("观光车");
    expect(rows[2]?.textContent).toContain("20元/圈");
    expect(rows[2]?.textContent).toContain("环岛一周");
    // 底部：分类 chip + 原文入口 + 免责声明
    expect(screen.getByText("交通")).toBeInTheDocument();
    expect(screen.getByText("价格仅供参考")).toBeInTheDocument();
    expect(document.querySelector(".og-evidence")?.textContent).toContain("查看原文");

    // 再点收起：明细隐藏
    fireEvent.click(document.querySelector(".og-head") as Element);
    expect(screen.queryByText("三轮车")).toBeNull();
  });

  it("Task #270 展开态按「路线 / 适合 / 说明」分行展示，字段缺失不渲染空行", () => {
    const group = makeOptionGroup({
      groupId: "gog_walk",
      topic: "西岛环岛交通方式",
      options: [
        {
          label: "步行",
          priceText: null,
          routeText: "码头左侧海岸线和渔村",
          sceneText: "不想花钱代步的人",
          bargain: null,
          noteText: "西岛不大，可轻松覆盖以上区域",
          sourceMentionRefs: ["ev_1:m_1"],
        },
        {
          label: "电动车",
          priceText: null,
          routeText: null,
          sceneText: null,
          bargain: null,
          noteText: null,
          sourceMentionRefs: ["ev_1:m_1"],
        },
      ],
    });
    const visit = makeVisit("visit_xidao", "item_xidao", {
      sourceMentionRefs: ["ev_1:m_1"],
      optionGroups: [group],
    });
    renderCard(makeTrip({ visits: { visit_xidao: visit } }), visit);
    fireEvent.click(document.querySelector(".og-head") as Element);

    const rows = [...document.querySelectorAll(".og-row")];
    expect(rows).toHaveLength(2);
    const walkLines = [...(rows[0]?.querySelectorAll(".og-line") ?? [])];
    expect(walkLines).toHaveLength(3);
    expect(walkLines[0]?.querySelector(".og-key")?.textContent).toBe("路线");
    expect(walkLines[0]?.querySelector(".og-val")?.textContent).toBe("码头左侧海岸线和渔村");
    expect(walkLines[1]?.querySelector(".og-key")?.textContent).toBe("适合");
    expect(walkLines[1]?.querySelector(".og-val")?.textContent).toBe("不想花钱代步的人");
    expect(walkLines[2]?.querySelector(".og-key")?.textContent).toBe("说明");
    expect(walkLines[2]?.querySelector(".og-val")?.textContent).toBe("西岛不大，可轻松覆盖以上区域");
    // 只有名称的选项：不渲染任何标注行，也不渲染空价格节点（避免「路线：」空标签）
    expect(rows[1]?.querySelectorAll(".og-line")).toHaveLength(0);
    expect(rows[1]?.querySelector(".og-price")).toBeNull();
  });

  it("「查看原文」打开 EvidenceSheet 定位对应提及（复用既有原文证据链路）", () => {
    const visit = makeVisit("visit_xidao", "item_xidao", {
      sourceMentionRefs: ["ev_1:m_1"],
      optionGroups: [makeOptionGroup()],
    });
    renderCard(makeTrip({ visits: { visit_xidao: visit } }), visit);

    expect(screen.queryByRole("dialog", { name: "攻略原文" })).not.toBeInTheDocument();
    fireEvent.click(document.querySelector(".og-head") as Element);
    fireEvent.click(document.querySelector(".og-evidence") as Element);

    expect(screen.getByRole("dialog", { name: "攻略原文" })).toBeInTheDocument();
    expect(screen.getByText(/西岛渔村慢慢逛，别赶时间/)).toBeInTheDocument();
  });

  it("历史 Trip 兼容：visit 无 optionGroups 字段（或空数组）不渲染主题卡", () => {
    const legacy = makeVisit("visit_xidao", "item_xidao");
    renderCard(makeTrip({ visits: { visit_xidao: legacy } }), legacy);
    expect(document.querySelector(".option-groups")).toBeNull();

    cleanup();
    const empty = makeVisit("visit_xidao", "item_xidao", { optionGroups: [] });
    renderCard(makeTrip({ visits: { visit_xidao: empty } }), empty);
    expect(document.querySelector(".option-groups")).toBeNull();
  });

  it("Task #274 收起态：分类图标 + 分类小字（transport / ticket 映射不同）", () => {
    const ticket = makeOptionGroup({
      groupId: "gog_ticket",
      topic: "西岛门票套餐",
      category: "ticket",
      options: [
        {
          label: "门票+观光车",
          priceText: "98元/人",
          routeText: null,
          sceneText: null,
          bargain: null,
          noteText: null,
          sourceMentionRefs: ["ev_1:m_1"],
        },
        {
          label: "门票单买",
          priceText: "60元/人",
          routeText: null,
          sceneText: null,
          bargain: null,
          noteText: null,
          sourceMentionRefs: ["ev_1:m_1"],
        },
      ],
    });
    const visit = makeVisit("visit_xidao", "item_xidao", {
      sourceMentionRefs: ["ev_1:m_1"],
      optionGroups: [makeOptionGroup(), ticket],
    });
    renderCard(makeTrip({ visits: { visit_xidao: visit } }), visit);

    // 收起态即渲染图标与分类小字（不依赖展开）
    const icons = [...document.querySelectorAll(".og-icon")];
    expect(icons).toHaveLength(2);
    expect(icons[0]?.getAttribute("data-category")).toBe("transport");
    expect(icons[1]?.getAttribute("data-category")).toBe("ticket");
    // 图标是装饰性：aria-hidden，读屏只读按钮 aria-label
    expect(icons[0]?.getAttribute("aria-hidden")).toBe("true");
    expect(icons[0]?.querySelector("svg")).not.toBeNull();
    // 不同分类落到不同图形（不是同一个占位图标）
    expect(icons[0]?.innerHTML).not.toBe(icons[1]?.innerHTML);

    expect(screen.getByText("交通参考")).toBeInTheDocument();
    expect(screen.getByText("门票参考")).toBeInTheDocument();
    // 摘要与原文入口在收起态仍然可见 / 明细仍未渲染
    expect(screen.getByText("3 个选项")).toBeInTheDocument();
    expect(screen.getByText("低至 ¥20")).toBeInTheDocument();
    expect(screen.queryByText("三轮车")).toBeNull();
  });

  it("Task #274 按钮 aria-label 保留主题 + 分类 + 展开语义；展开后仍显示同一图标", () => {
    const visit = makeVisit("visit_xidao", "item_xidao", {
      sourceMentionRefs: ["ev_1:m_1"],
      optionGroups: [makeOptionGroup()],
    });
    renderCard(makeTrip({ visits: { visit_xidao: visit } }), visit);

    const head = document.querySelector(".og-head") as Element;
    const collapsedLabel = head.getAttribute("aria-label") ?? "";
    expect(collapsedLabel).toContain("西岛环岛交通");
    expect(collapsedLabel).toContain("交通参考");
    expect(collapsedLabel).toContain("展开选项明细");
    expect(collapsedLabel).toContain("3 个选项");

    fireEvent.click(head);
    expect(document.querySelector(".og-head")?.getAttribute("aria-label")).toContain("收起选项明细");
    // 展开态标题头保留图标 + 分类小字（与选项内容互不影响）
    expect(document.querySelector(".og-icon")?.getAttribute("data-category")).toBe("transport");
    expect(screen.getByText("交通参考")).toBeInTheDocument();

    fireEvent.click(document.querySelector(".og-head") as Element);
    expect(document.querySelector(".og-head")?.getAttribute("aria-label")).toBe(collapsedLabel);
  });

  it("Task #274 分类映射覆盖全部白名单分类（含 other 兜底不臆造）", () => {
    const categories = ["transport", "shuttle", "ticket", "rental", "dining", "activity", "other"] as const;
    const expected: Record<(typeof categories)[number], string> = {
      transport: "交通参考",
      shuttle: "接驳参考",
      ticket: "门票参考",
      rental: "租赁参考",
      dining: "餐饮参考",
      activity: "玩法参考",
      other: "实用参考",
    };
    const groups = categories.map((category, index) =>
      makeOptionGroup({ groupId: `gog_${category}`, topic: `主题 ${index}`, category }),
    );
    const visit = makeVisit("visit_xidao", "item_xidao", {
      sourceMentionRefs: ["ev_1:m_1"],
      optionGroups: groups,
    });
    renderCard(makeTrip({ visits: { visit_xidao: visit } }), visit);

    const icons = [...document.querySelectorAll(".og-icon")];
    expect(icons).toHaveLength(categories.length);
    const shapes = icons.map((icon) => icon.innerHTML);
    // 每类都有图标，且互不相同（transport/shuttle 也不共用图形）
    expect(new Set(shapes).size).toBe(categories.length);
    for (const category of categories) {
      expect(screen.getByText(expected[category])).toBeInTheDocument();
    }
  });

  it("Task #274 样式契约：图标圆底 / 分类小字 / 浅色底 / 360px 紧凑规则存在于 styles.css", () => {
    const css = readStylesCss();
    expect(css).toMatch(/\.og-icon\s*\{[^}]*border-radius:\s*50%/);
    expect(css).toMatch(/\.og-hint\s*\{/);
    // 标题头浅色底（sage 薄底，不是主 CTA 级别的强色）
    expect(css).toMatch(/\.og-head\s*\{[^}]*background:\s*rgba\(227,\s*233,\s*226/);
    // 左侧极轻强调线
    expect(css).toMatch(/\.option-group\s*\{[^}]*border-left:\s*3px solid var\(--clay-line\)/);
    expect(css).toMatch(/@media \(max-width: 360px\)\s*\{[\s\S]*?\.og-sum/);
  });

  it("多主题组各一张卡；非交通分类 chip（餐饮）；父卡同样渲染", () => {
    const dining = makeOptionGroup({
      groupId: "gog_dining",
      topic: "渔村食堂套餐",
      category: "dining",
      options: [
        {
          label: "双人套餐",
          priceText: "68元",
          routeText: null,
          sceneText: null,
          bargain: null,
          noteText: null,
          sourceMentionRefs: ["ev_1:m_1"],
        },
        {
          label: "单点",
          priceText: "人均50元左右",
          routeText: null,
          sceneText: null,
          bargain: null,
          noteText: null,
          sourceMentionRefs: ["ev_1:m_1"],
        },
      ],
    });
    const visit = makeVisit("visit_xidao", "item_xidao", {
      kind: "large_attraction",
      visitMode: "full_day",
      sourceMentionRefs: ["ev_1:m_1"],
      optionGroups: [makeOptionGroup(), dining],
      // #348 渲染判定改为子玩法驱动，夹具补 children 维持原断言语义（父卡同样渲染主题卡）
      childStopRefs: ["stop_kid"],
    });
    renderCard(makeTrip({ visits: { visit_xidao: visit } }), visit);

    expect(document.querySelectorAll(".option-group")).toHaveLength(2);
    expect(screen.getByText("西岛环岛交通")).toBeInTheDocument();
    expect(screen.getByText("渔村食堂套餐")).toBeInTheDocument();
    // 非交通分类在展开态显示中文 chip
    fireEvent.click(document.querySelector(".og-head") as Element);
    fireEvent.click([...document.querySelectorAll(".og-head")][1] as Element);
    expect(screen.getByText("餐饮")).toBeInTheDocument();
    // 父卡（large_attraction）同样渲染主题卡
    expect(document.querySelector(".parent-card .option-groups")).not.toBeNull();
  });

  it("最低价摘要：全部价格缺失时只显示选项数，不虚造低价", () => {
    const group = makeOptionGroup({
      groupId: "gog_noprice",
      topic: "日落观赏点",
      category: "activity",
      options: [
        {
          label: "山顶平台",
          priceText: null,
          routeText: null,
          sceneText: null,
          bargain: null,
          noteText: null,
          sourceMentionRefs: ["ev_1:m_1"],
        },
        {
          label: "码头栈道",
          priceText: "面议",
          routeText: null,
          sceneText: null,
          bargain: null,
          noteText: null,
          sourceMentionRefs: ["ev_1:m_1"],
        },
      ],
    });
    const visit = makeVisit("visit_xidao", "item_xidao", {
      sourceMentionRefs: ["ev_1:m_1"],
      optionGroups: [group],
    });
    renderCard(makeTrip({ visits: { visit_xidao: visit } }), visit);

    expect(screen.getByText("2 个选项")).toBeInTheDocument();
    expect(screen.queryByText(/低至/)).toBeNull();
  });

  it("样式契约：折叠卡关键类已落 styles.css（源断言）", () => {
    const css = readStylesCss();
    for (const selector of [
      ".og-head",
      ".og-body",
      ".og-row",
      ".og-price",
      ".og-bargain",
      ".og-evidence",
      ".og-disclaimer",
      ".parent-card .option-groups",
      // Task #270：展开态分行渲染（路线 / 适合 / 说明）
      ".og-main",
      ".og-line",
      ".og-key",
      ".og-val",
    ]) {
      expect(css).toContain(selector);
    }
    // Task #270 用分行替代了「·」拼接的单一说明节点，旧类不应再残留
    expect(css).not.toContain(".og-note");
  });
});

describe("VisitCard 攻略原图（任务 196 页码配图）", () => {
  /** m_1（西岛）带上页码引用，其余提及保留（不可见，精确 ref 模式只认 m_1） */
  function evidenceWithPages(pageRefs: number[]): SourceEvidence {
    const base = makeEvidence();
    return {
      ...base,
      mentions: base.mentions.map((mention) =>
        mention.mentionId === "m_1" ? { ...mention, pageRefs } : mention,
      ),
    };
  }

  /** 1..13 顺序槽位；readyPages 内的页 ready 且带明细 assetPath，其余 pending 占位 */
  function pageImages(readyPages: number[]): GuideSource["imageProgress"]["images"] {
    return Array.from({ length: 13 }, (_, i) => {
      const index = i + 1;
      if (!readyPages.includes(index)) {
        return { index, status: "pending" as const, evidenceId: null };
      }
      return {
        index,
        status: "ready" as const,
        evidenceId: `ev_img${index}`,
        assetPath: `uploads/t_vc/img-${String(index).padStart(2, "0")}.jpg`,
      };
    });
  }

  function pageSource(readyPages: number[]): GuideSource {
    return makeSource("s_a", {
      evidenceRefs: ["ev_1", ...readyPages.map((page) => `ev_img${page}`)],
      imageProgress: {
        total: 13,
        completed: readyPages.length,
        failed: 0,
        images: pageImages(readyPages),
      },
    });
  }

  it("custom 点位：thumb 展示首个有效页码关联图并标注「攻略原图」（多页保留全部关联）", () => {
    const visit = makeVisit("visit_1", "item_xidao", { sourceMentionRefs: ["ev_1:m_1"] });
    const trip = makeTrip({
      visits: { visit_1: visit },
      evidences: { ev_1: evidenceWithPages([6, 11]) },
      guideSources: { s_a: pageSource([6, 11]) },
    });
    renderCard(trip, visit);

    const img = document.querySelector(".thumb .thumb-frame img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("/api/uploads/t_vc/img-06.jpg");
    expect(screen.getByText("攻略原图")).toBeInTheDocument();
    expect(document.querySelector(".thumb .ph-tile")).toBeNull();
    expect(screen.queryByText("飞猪实图")).toBeNull();
  });

  it("页码槽位下载失败：无有效关联图 → 统一占位兜底，不出现「攻略原图」标注", () => {
    const visit = makeVisit("visit_1", "item_xidao", { sourceMentionRefs: ["ev_1:m_1"] });
    const source = pageSource([5]);
    source.imageProgress.images[5] = { index: 6, status: "failed", evidenceId: null }; // p6 失败占位
    source.imageProgress.failed = 1;
    const trip = makeTrip({
      visits: { visit_1: visit },
      evidences: { ev_1: evidenceWithPages([6]) },
      guideSources: { s_a: source },
    });
    renderCard(trip, visit);

    expect(document.querySelector(".thumb .thumb-frame img")).toBeNull();
    expect(document.querySelector(".thumb .ph-tile")).not.toBeNull();
    expect(screen.queryByText("攻略原图")).toBeNull();
  });
});

describe("VisitCard 归入大景点入口（Task #199）", () => {
  function parentVisit(overrides: Partial<Visit> = {}): Visit {
    return makeVisit("visit_parent", "item_parent", {
      kind: "large_attraction",
      ...overrides,
    });
  }

  /** 普通景点卡 + 可选大景点目标（null = 行程中没有大景点） */
  function renderOrdinary(
    visitOverrides: Partial<Visit> = {},
    parent: Visit | null = parentVisit(),
  ) {
    const visit = makeVisit("visit_child", "item_xidao", visitOverrides);
    const visits: Record<string, Visit> = { visit_child: visit };
    if (parent !== null) visits[parent.visitId] = parent;
    const trip = makeTrip({
      visits,
      itemRegistry: parent !== null ? { item_parent: makeItem("item_parent", "蜈支洲岛") } : undefined,
    });
    const onClassifyIntoParent = vi.fn();
    renderCard(trip, visit, { onClassifyIntoParent });
    return onClassifyIntoParent;
  }

  it("普通景点且行程中存在已排期大景点：展示入口，点击上抛 visitId", () => {
    const handler = renderOrdinary();
    const entry = screen.getByRole("button", { name: "归入大景点" });
    expect(entry.classList.contains("classify-entry")).toBe(true);
    fireEvent.click(entry);
    expect(handler).toHaveBeenCalledWith("visit_child");
  });

  it("锁定 / 已购票的普通景点不展示入口", () => {
    const lockedHandler = renderOrdinary({ locked: true });
    expect(screen.queryByRole("button", { name: "归入大景点" })).toBeNull();
    cleanup();
    const boughtHandler = renderOrdinary({ purchaseState: "bought" });
    expect(screen.queryByRole("button", { name: "归入大景点" })).toBeNull();
    expect(lockedHandler).not.toHaveBeenCalled();
    expect(boughtHandler).not.toHaveBeenCalled();
  });

  it("无可选目标不展示：无大景点 / 大景点仅在候选池（dayRef=null）", () => {
    renderOrdinary({}, null);
    expect(screen.queryByRole("button", { name: "归入大景点" })).toBeNull();
    cleanup();
    renderOrdinary({}, parentVisit({ dayRef: null }));
    expect(screen.queryByRole("button", { name: "归入大景点" })).toBeNull();
  });

  it("大景点父卡自身不展示归入入口", () => {
    const parent = parentVisit();
    const trip = makeTrip({
      visits: { visit_parent: parent },
      itemRegistry: { item_parent: makeItem("item_parent", "蜈支洲岛") },
    });
    renderCard(trip, parent, { onClassifyIntoParent: vi.fn() });
    expect(screen.queryByRole("button", { name: "归入大景点" })).toBeNull();
  });

  it("样式契约：入口与目标选择浮层关键类已落 styles.css", () => {
    const css = readStylesCss();
    for (const selector of [
      ".classify-entry",
      ".classify-overlay",
      ".classify-dialog",
      ".classify-option",
      ".classify-option-name",
      ".classify-option-meta",
      ".classify-cancel",
    ]) {
      expect(css).toContain(selector);
    }
  });

  /**
   * Task #360（PD 2026-11-10 拍板）：入口显示改由距离资格决定。
   * 坐标取自验收行程 server/data/0a27f726 的 itemRegistry，与
   * lib/largeAttraction.test.ts 的距离矩阵同源。
   */
  const COORD_YEMENG = { lng: 109.475755, lat: 18.274345 };
  const COORD_LUHUITOU = { lng: 109.50131, lat: 18.225639 };
  const COORD_YALONGWAN_BEACH = { lng: 109.646004, lat: 18.229188 };
  const COORD_FOREST = { lng: 109.643059, lat: 18.253643 };
  const COORD_GLASS = { lng: 109.643092, lat: 18.251821 };
  // Task #362：天涯小镇/天涯海角真实坐标（1.89km——过距离闸但被既有 bought 闸隐藏的最近误报侧）
  const COORD_TIANYA_TOWN = { lng: 109.332659, lat: 18.303548 };
  const COORD_TIANYA_CORNER = { lng: 109.348143, lat: 18.294988 };
  /** 该 POI 名首字以 \u8708 码点转义写入（规避编辑链路字形替换），值与真实 POI 名一致 */
  const WUZHIZHOU_ISLAND = "\u8708支洲岛";

  function renderCoordPair(
    source: { name: string; coords: { lng: number; lat: number } | null },
    target: {
      name: string;
      coords: { lng: number; lat: number } | null;
      dayRef?: string | null;
    },
    sourceOverrides: Partial<Visit> = {},
  ) {
    const visit = makeVisit("visit_child", "item_source", sourceOverrides);
    const parent = makeVisit("visit_parent", "item_target", {
      kind: "large_attraction",
      dayRef: target.dayRef ?? "day_1",
    });
    const trip = makeTrip({
      visits: { visit_child: visit, visit_parent: parent },
      itemRegistry: {
        item_source: { ...makeItem("item_source", source.name), coords: source.coords },
        item_target: { ...makeItem("item_target", target.name), coords: target.coords },
      },
    });
    const onClassifyIntoParent = vi.fn();
    renderCard(trip, visit, { onClassifyIntoParent });
    return onClassifyIntoParent;
  }

  it("Task #360：椰梦长廊 → 鹿回头 6.05km 超 2km 阈值，入口隐藏", () => {
    const handler = renderCoordPair(
      { name: "椰梦长廊", coords: COORD_YEMENG },
      { name: "鹿回头", coords: COORD_LUHUITOU },
    );
    expect(screen.queryByRole("button", { name: "归入大景点" })).toBeNull();
    expect(handler).not.toHaveBeenCalled();
  });

  it("Task #360：亚龙湾海滩 → 亚龙湾森林公园 2.74km（误报最近侧），入口隐藏", () => {
    renderCoordPair(
      { name: "亚龙湾海滩", coords: COORD_YALONGWAN_BEACH },
      { name: "亚龙湾热带天堂森林公园", coords: COORD_FOREST },
    );
    expect(screen.queryByRole("button", { name: "归入大景点" })).toBeNull();
  });

  it("Task #360：玻璃栈道 → 亚龙湾森林公园 0.20km 在阈值内，入口展示且可上抛", () => {
    const handler = renderCoordPair(
      { name: "玻璃栈道", coords: COORD_GLASS },
      { name: "亚龙湾热带天堂森林公园", coords: COORD_FOREST },
    );
    const entry = screen.getByRole("button", { name: "归入大景点" });
    fireEvent.click(entry);
    expect(handler).toHaveBeenCalledWith("visit_child");
  });

  it("Task #362：天涯小镇 → 天涯海角 1.89km 过距离闸——未购票显示入口，已购票被既有 bought 闸隐藏", () => {
    renderCoordPair(
      { name: "天涯小镇", coords: COORD_TIANYA_TOWN },
      { name: "天涯海角", coords: COORD_TIANYA_CORNER },
    );
    expect(screen.getByRole("button", { name: "归入大景点" })).toBeInTheDocument();
    cleanup();
    renderCoordPair(
      { name: "天涯小镇", coords: COORD_TIANYA_TOWN },
      { name: "天涯海角", coords: COORD_TIANYA_CORNER },
      { purchaseState: "bought" },
    );
    expect(screen.queryByRole("button", { name: "归入大景点" })).toBeNull();
  });

  it("Task #360：双方有坐标时只看距离不看同天——同天但超阈仍隐藏", () => {
    renderCoordPair(
      { name: "后海村", coords: { lng: 109.72963, lat: 18.272223 } },
      { name: WUZHIZHOU_ISLAND, coords: { lng: 109.765947, lat: 18.310381 }, dayRef: "day_1" },
    );
    expect(screen.queryByRole("button", { name: "归入大景点" })).toBeNull();
  });

  it("Task #360：无坐标源 + 跨天目标（day_2）→ 同天兜底不成立，入口隐藏", () => {
    renderCoordPair(
      { name: "情人桥", coords: null },
      { name: WUZHIZHOU_ISLAND, coords: null, dayRef: "day_2" },
    );
    expect(screen.queryByRole("button", { name: "归入大景点" })).toBeNull();
  });

  it("Task #360：仅目标无坐标 → 同天兜底成立，入口展示", () => {
    renderCoordPair(
      { name: "玻璃栈道", coords: COORD_GLASS },
      { name: "亚龙湾热带天堂森林公园", coords: null, dayRef: "day_1" },
    );
    expect(screen.getByRole("button", { name: "归入大景点" })).not.toBeNull();
  });

  it("Task #360 样式契约不受影响：入口类名仍在，距离阈值常量单点维护在 lib/largeAttraction.ts", () => {
    const libSource = readFileSync(
      resolve(process.cwd(), existsSync("src/lib/largeAttraction.ts") ? "src/lib/largeAttraction.ts" : "web/src/lib/largeAttraction.ts"),
      "utf8",
    );
    expect(libSource).toContain("export const CLASSIFY_MAX_DISTANCE_KM = 2;");
    // VisitCard 不再自己扫全局大景点，改为消费资格函数（口径单点）
    const cardSource = readComponentSource("VisitCard.tsx");
    expect(cardSource).toContain("eligibleClassifyTargets(trip, visit).length > 0");
    expect(cardSource).not.toMatch(/other\.kind === "large_attraction"/);
  });
});

/**
 * Task #267：回滚 Task #266 的父卡 snippet 聚合。父景区卡只读 visit.guideSnippets，
 * 子景点的提示仍在各自的内部玩法行（StopRow）里展示，不在父卡重复出现。
 */
describe("VisitCard 父卡只展示景区自身攻略提示（Task #267 回滚）", () => {
  it("父卡引用块只含 visit.guideSnippets，子景点提示留在 StopRow chips", () => {
    const niuwang = makeStop("stop_niuwang", "牛王岭", {
      guideSnippets: [
        {
          snippetId: "sn_stop_1",
          text: "去牛王岭建议坐观光车",
          claimKind: "tip",
          sourceMentionRefs: ["ev_1:m_2"],
        },
      ],
    });
    const visit = makeVisit("visit_xidao", "item_xidao", {
      kind: "large_attraction",
      visitMode: "half_day",
      childStopRefs: ["stop_niuwang"],
      guideSnippets: [
        {
          snippetId: "sn_visit_1",
          text: "上岛船班在西门码头",
          claimKind: "tip",
          sourceMentionRefs: [],
        },
      ],
    });
    renderCard(
      makeTrip({ visits: { visit_xidao: visit }, stops: { stop_niuwang: niuwang } }),
      visit,
    );

    const quote = document.querySelector(".parent-card .guide-quote");
    expect(quote?.textContent).toContain("上岛船班在西门码头");
    expect(quote?.textContent).not.toContain("去牛王岭建议坐观光车");
    // 父卡不再逐条列出子景点提示（无来源标注 / 折叠计数）
    expect(document.querySelector(".guide-quote-list")).toBeNull();
    expect(document.querySelector(".guide-quote-source")).toBeNull();
    // 子景点提示仍在自己的内部玩法行里
    const childChips = [...document.querySelectorAll(".child .guide-snippet-chip")];
    expect(childChips.map((chip) => chip.textContent)).toEqual(["去牛王岭建议坐观光车"]);
  });

  it("景区自身无提示时不渲染父卡引用块（不因子景点提示凭空出现）", () => {
    const niuwang = makeStop("stop_niuwang", "牛王岭", {
      guideSnippets: [
        {
          snippetId: "sn_stop_1",
          text: "去牛王岭建议坐观光车",
          claimKind: "tip",
          sourceMentionRefs: [],
        },
      ],
    });
    const visit = makeVisit("visit_xidao", "item_xidao", {
      kind: "large_attraction",
      visitMode: "half_day",
      childStopRefs: ["stop_niuwang"],
      guideSnippets: [],
    });
    renderCard(makeTrip({ visits: { visit_xidao: visit }, stops: { stop_niuwang: niuwang } }), visit);

    expect(document.querySelector(".parent-card .guide-quote")).toBeNull();
  });
});

/**
 * 验收问题修复：大景区升级后，高置信度 pending 子玩法应在父卡上提示并可一键采纳。
 * 口径与 useTrip.adoptSuggestedStops / server/src/guides/fix-task225.ts 完全一致：
 * 只认 level="high" 且 decidedBy≠"user"，已 attached 的不再计入。
 */
describe("VisitCard 推荐玩法待确认与一键采纳（验收修复）", () => {
  function suggestion(
    stopId: string,
    level: RelationshipSuggestion["level"],
    decidedBy: RelationshipSuggestion["decidedBy"],
  ): RelationshipSuggestion {
    return {
      stopRef: stopId,
      suggestedVisitRef: "visit_xidao",
      level,
      positiveSignals: [],
      negativeSignals: [],
      decidedBy,
    };
  }

  function pendingStop(stopId: string, name: string): Stop {
    return makeStop(stopId, name, {
      state: "pending",
      visitRef: null,
      suggestedVisitRef: "visit_xidao",
      order: null,
      guideSnippets: [],
    });
  }

  function renderParent(
    stops: Record<string, Stop>,
    suggestions: Record<string, RelationshipSuggestion>,
    onAdoptSuggestedStops?: Mock<(visitId: string) => void>,
  ): void {
    const visit = makeVisit("visit_xidao", "item_xidao", {
      kind: "large_attraction",
      // #348 渲染判定改为子玩法驱动：推荐玩法待确认提示（.adopt-hint）在父卡分支内，
      // 补悬空 children 维持父卡形态；suggestedChildStops 只计 state=pending 的 Stop，
      // 悬空 ref 不污染待确认计数，原断言语义不变。
      childStopRefs: ["stop_ghost"],
      guideSnippets: [],
    });
    const trip = makeTrip({
      visits: { visit_xidao: visit },
      stops,
      relationshipSuggestions: suggestions,
    });
    renderCard(trip, visit, { onAdoptSuggestedStops });
  }

  it("父卡提示「有 N 个推荐玩法待确认」并列出前三个名称，点击一键采纳上抛 visitId", () => {
    const onAdopt = vi.fn();
    renderParent(
      {
        stop_1: pendingStop("stop_1", "牛王岭"),
        stop_2: pendingStop("stop_2", "珊瑚石墙"),
      },
      {
        stop_1: suggestion("stop_1", "high", "system"),
        stop_2: suggestion("stop_2", "high", "system"),
      },
      onAdopt,
    );
    const hint = document.querySelector(".parent-card .adopt-hint");
    expect(hint?.textContent).toContain("有 2 个推荐玩法待确认");
    expect(hint?.textContent).toContain("牛王岭、珊瑚石墙");
    fireEvent.click(screen.getByRole("button", { name: "一键采纳" }));
    expect(onAdopt).toHaveBeenCalledWith("visit_xidao");
  });

  it("保守口径：medium / 用户已表态 / 已 attached 的玩法不计入，无待确认项不渲染提示", () => {
    renderParent(
      {
        stop_medium: pendingStop("stop_medium", "海上书屋"),
        stop_user: pendingStop("stop_user", "渔村"),
        stop_attached: makeStop("stop_attached", "牛王岭"),
      },
      {
        stop_medium: suggestion("stop_medium", "medium", "system"),
        stop_user: suggestion("stop_user", "high", "user"),
        stop_attached: suggestion("stop_attached", "high", "system"),
      },
    );
    expect(document.querySelector(".adopt-hint")).toBeNull();
    expect(screen.queryByRole("button", { name: "一键采纳" })).toBeNull();
  });

  it("样式契约：提示条与按钮关键类已落 styles.css", () => {
    const css = readStylesCss();
    for (const selector of [
      ".adopt-hint",
      ".adopt-hint-text",
      ".adopt-hint-names",
      ".adopt-hint-btn",
    ]) {
      expect(css).toContain(selector);
    }
  });
});

// ===== Task #283 / C4：AI 补充·飞猪核验标（主行程卡） =====

describe("VisitCard AI 补充·飞猪核验标（Task #283 / C4）", () => {
  /** 补充项通常是 AI 补排的真实飞猪 POI：origin=fliggy + providerId 非空 */
  function makeSupplementItem(itemId: string, name: string, provenance?: Item["provenance"]): Item {
    return {
      itemId,
      name,
      origin: "fliggy",
      providerId: "F123456",
      address: "海南省三亚市",
      category: "海岛",
      coords: null,
      suggestMinutes: 120,
      mainPic: null,
      ticketInfo: null,
      jumpUrl: null,
      sourceEvidenceRefs: [],
      ...(provenance !== undefined ? { provenance } : {}),
    };
  }

  it("补充项（provenance=ai_supplement）：主行程卡渲染全标 chip「AI 补充·飞猪核验」＋核验说明详情行（390 全标）", () => {
    const item = makeSupplementItem("item_sup", "补充海岛", "ai_supplement");
    const trip = makeTrip({
      itemRegistry: { item_sup: item },
      visits: { visit_sup: makeVisit("visit_sup", "item_sup", { kind: "ordinary" }) },
    });
    renderCard(trip, trip.visits.visit_sup);

    const chip = document.querySelector(".ai-supplement-chip");
    expect(chip).not.toBeNull();
    // 默认（宽屏 ≥361px）两段都在：全标 = 降级标 + chip-verify 子段
    expect(chip?.textContent).toBe(AI_SUPPLEMENT_CHIP_LABEL);
    expect(chip?.querySelector(".chip-verify")?.textContent).toBe(
      AI_SUPPLEMENT_CHIP_LABEL.slice(AI_SUPPLEMENT_CHIP_LABEL_COMPACT.length),
    );
    // 核验说明详情行存在（宽屏由 CSS 隐藏、DOM 里仍在，供 ≤360px 降级时显示）
    expect(document.querySelector(".ai-supplement-note")?.textContent).toBe(AI_SUPPLEMENT_VERIFY_NOTE);
  });

  it("攻略项（provenance 缺失 → 读时默认 guide）：不渲染 AI 补充 chip 与核验行", () => {
    const item = makeSupplementItem("item_guide", "普通海岛"); // 无 provenance 字段
    const trip = makeTrip({
      itemRegistry: { item_guide: item },
      visits: { visit_guide: makeVisit("visit_guide", "item_guide", { kind: "ordinary" }) },
    });
    renderCard(trip, trip.visits.visit_guide);

    expect(document.querySelector(".ai-supplement-chip")).toBeNull();
    expect(document.querySelector(".ai-supplement-note")).toBeNull();
    expect(screen.queryByText(AI_SUPPLEMENT_CHIP_LABEL)).toBeNull();
  });

  it("样式契约：≤360px 降级——隐藏 .chip-verify（chip 回落「AI 补充」），核验行改由 .ai-supplement-note 显示（320/360 降级）", () => {
    const css = readStylesCss();
    // 宽屏基线：核验行默认隐藏（chip 全标已含「·飞猪核验」）
    expect(css).toMatch(/\.ai-supplement-note\s*\{[^}]*display:\s*none/);
    // ≤360px 媒体查询块内：chip-verify display:none（降级为「AI 补充」）+ note display:block
    const media = /@media \(max-width: 360px\)\s*\{([\s\S]*?)\n\}/.exec(css);
    expect(media).not.toBeNull();
    const body = media?.[1] ?? "";
    expect(body).toMatch(/\.ai-supplement-chip \.chip-verify\s*\{[^}]*display:\s*none/);
    expect(body).toMatch(/\.ai-supplement-note\s*\{[^}]*display:\s*block/);
  });
});

// ===== Task #329：免费场所（国际免税城）三态展示 =====

/**
 * PD 现场：国际免税城是免费购物中心、不是景点，但卡片仍透出「去购票」。
 * 修复口径：commerce 由两态（fliggy/unknown）扩为三态（free/fliggy/unknown）——
 * free → 主按钮降级为「查看详情」弱入口（保留 jumpUrl 跳转）+ 「免票」标签；
 * NOT_FREE → 维持「去购票」；null/UNKNOWN → 维持既有 jumpUrl 行为（不制造回归）。
 * 判定单一数据源：shared/freePoi.ts（isFreeAdmissionItem）。
 */
describe("VisitCard 免费场所三态（任务 329）", () => {
  const JUMP = "https://router.feizhu.com/multi/webview?url=dutyfree";

  function freeItem(extra: Partial<Item> = {}): Item {
    return {
      ...makeItem("item_free", "国际免税城"),
      origin: "fliggy",
      providerId: "199649345",
      jumpUrl: JUMP,
      ...extra,
    };
  }

  function renderWith(item: Item, overrides: Partial<Visit> = {}) {
    const visit = makeVisit("visit_free", "item_free", overrides);
    renderCard(
      makeTrip({ itemRegistry: { item_free: item }, visits: { visit_free: visit } }),
      visit,
    );
    return visit;
  }

  it("cardMainActionLabel：commerce=free 对四种购票状态恒为「查看详情」，且属降级弱入口样式", () => {
    const states: Visit["purchaseState"][] = ["unknown", "toBuy", "bought", "noTicket"];
    for (const state of states) {
      expect(cardMainActionLabel("poi", state, "free")).toBe("查看详情");
      expect(isDimMainAction(cardMainActionLabel("poi", state, "free"))).toBe(true);
    }
  });

  it("cardMainActionLabel 不回归：fliggy 与 unknown 两态在加入 free 后文案逐条不变", () => {
    const expected: Record<CardCommerce, Record<Visit["purchaseState"], string>> = {
      fliggy: { unknown: "去购票", toBuy: "去购票", bought: "查看详情", noTicket: "查票价" },
      unknown: { unknown: "查票价", toBuy: "查票价", bought: "查看详情", noTicket: "查票价" },
      free: { unknown: "查看详情", toBuy: "查看详情", bought: "查看详情", noTicket: "查看详情" },
    };
    for (const commerce of Object.keys(expected) as CardCommerce[]) {
      for (const [state, label] of Object.entries(expected[commerce]!)) {
        expect(
          cardMainActionLabel("poi", state as Visit["purchaseState"], commerce),
        ).toBe(label);
      }
    }
    // 默认参数仍为 fliggy（未传 commerce 的旧调用点不回归）
    expect(cardMainActionLabel("poi", "unknown")).toBe("去购票");
    // 酒店卡不受 free 影响（恒飞猪在售）
    expect(cardMainActionLabel("hotel", "unknown", "free")).toBe("去订房");
  });

  it("FREE：隐藏「去购票」，主按钮降级为「查看详情」但仍可跳 jumpUrl，并展示「免票」标签", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    renderWith(freeItem({ freePoiStatus: "FREE" }));

    expect(screen.queryByRole("button", { name: "去购票" })).toBeNull();
    expect(screen.queryByRole("button", { name: "查票价" })).toBeNull();
    const detail = screen.getByRole("button", { name: "查看详情" });
    expect(detail).toBeInTheDocument();
    expect(detail.className).toBe("booklink dim");
    fireEvent.click(detail);
    expect(openSpy).toHaveBeenCalledWith(JUMP, "_blank", "noopener");
    openSpy.mockRestore();

    const tags = [...document.querySelectorAll(".item .nm .tag")].map((tag) => tag.textContent);
    expect(tags).toContain("免票");
    expect(document.querySelector(".item .nm .tag.slate")?.textContent).toBe("免票");
  });

  it("category 兜底：UNKNOWN + 购物类 category 同样降级（FlyAI 免税城实测即 UNKNOWN + 无 category，靠兜底表或存量回填）", () => {
    renderWith(freeItem({ freePoiStatus: "UNKNOWN", category: "购物中心" }));
    expect(screen.queryByRole("button", { name: "去购票" })).toBeNull();
    expect(screen.getByRole("button", { name: "查看详情" })).toBeInTheDocument();
    expect(document.querySelector(".item .nm .tag.slate")?.textContent).toBe("免票");
  });

  it("NOT_FREE：保留「去购票」，无免票标签（供应商明确信号优先于兜底）", () => {
    renderWith(freeItem({ freePoiStatus: "NOT_FREE", category: "购物中心" }));
    expect(screen.getByRole("button", { name: "去购票" })).toBeInTheDocument();
    expect(screen.queryByText("免票")).toBeNull();
    expect(isFreeAdmissionItem(freeItem({ freePoiStatus: "NOT_FREE", category: "购物中心" }))).toBe(false);
  });

  it("存量无 freePoiStatus 字段（读时默认 null）：非购物名景点维持既有 jumpUrl 行为，不制造回归", () => {
    // Task #330 D 口径变更（PD 批准，与 #329 原断言相反）：本用例原以「国际免税城」为存量样例，
    // 断言其维持「去购票」。名称通道接入运行时判定后，购物名场所（名命中「免税」等）即便
    // 缺 freePoiStatus 也判免费——这正是任务 D 要修的原始症状。为保留「读时默认不制造回归」的
    // 原意，存量样例改用真实景点（蜈支洲岛，非购物名）：无 freePoiStatus → 读时默认 null →
    // 双通道均无信号 → 维持「去购票」。国际免税城的口径变更由下一用例专门覆盖。
    const legacyAttraction: Item = {
      ...makeItem("item_free", "蜈支洲岛"),
      origin: "fliggy",
      providerId: "F_WZD",
      jumpUrl: JUMP,
    };
    expect("freePoiStatus" in legacyAttraction).toBe(false);
    renderWith(legacyAttraction);
    expect(screen.getByRole("button", { name: "去购票" })).toBeInTheDocument();
    expect(screen.queryByText("免票")).toBeNull();
  });

  it("存量购物名场所（国际免税城，无 freePoiStatus）：经名称通道判免费，降级为「查看详情」+ 免票标签（Task #330 D）", () => {
    // 与上一用例互补：存量快照缺 freePoiStatus 的购物名场所，名称通道兜底使其不再透出购票按钮。
    const legacy = freeItem();
    expect("freePoiStatus" in legacy).toBe(false);
    renderWith(legacy);
    expect(screen.queryByRole("button", { name: "去购票" })).toBeNull();
    expect(screen.getByRole("button", { name: "查看详情" })).toBeInTheDocument();
    expect(document.querySelector(".item .nm .tag.slate")?.textContent).toBe("免票");
  });

  it("无 jumpUrl 的免费场所：不凭空造出主按钮（主按钮仍隐藏），免票标签照常显示", () => {
    renderWith(freeItem({ jumpUrl: null, freePoiStatus: "FREE" }));
    expect(screen.queryByRole("button", { name: "查看详情" })).toBeNull();
    expect(document.querySelector(".item .booklink")).toBeNull();
    expect(document.querySelector(".item .nm .tag.slate")?.textContent).toBe("免票");
  });

  it("大景区父卡：同口径降级 + .parent-tags 内「免票」标签", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    // #348 渲染判定改为子玩法驱动，夹具补 children 维持父卡形态（本用例断言 .parent-tags/.parent-foot）
    renderWith(freeItem({ freePoiStatus: "FREE" }), { kind: "large_attraction", childStopRefs: ["stop_kid"] });

    expect(screen.queryByRole("button", { name: "去购票" })).toBeNull();
    const foot = document.querySelector(".parent-card .parent-foot .card-actions");
    expect(foot).not.toBeNull();
    const buttons = [...foot!.querySelectorAll("button")];
    // dim = 浅橙弱入口样式（与「查票价」同一降级态），不再是强转化购票按钮
    expect(buttons.at(-1)?.className).toBe("booklink dim");
    expect(buttons.at(-1)?.textContent).toBe("查看详情");
    fireEvent.click(buttons.at(-1) as Element);
    expect(openSpy).toHaveBeenCalledWith(JUMP, "_blank", "noopener");
    openSpy.mockRestore();

    expect(document.querySelector(".parent-tags .tag.slate")?.textContent).toBe("免票");
  });

  it("样式契约：免票标签沿用现有 .tag.slate 体系（styles.css 集中管理，未新增类）", () => {
    expect(readStylesCss()).toMatch(/\.tag\.slate\s*\{/);
    const source = readComponentSource("VisitCard.tsx");
    expect((source.match(/<span className="tag slate">免票<\/span>/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

// ===== Task #330：poiLevel 徽标 / listRank 榜单 chip（#356 起同行 .badge-row）/ description（#356 起不再渲染） =====

/**
 * 飞猪 POI 三项元信息在景点卡的展示口径（PD 已批准层级方案）：
 * ① poiLevel → 4A/5A 徽标（归一化，脏值不显示；Task #356 起与榜单 chip 同落 .badge-row 徽章行）；
 * ② listRank → 暖色榜单 chip（有则显示、无则完全不占位；#356 起与徽标同行，双缺整行收起）；
 * ③ description → Task #356（PD DEMO v0.5）起不再渲染「介绍 ▾」折叠区（数据字段保留，仅移除展示）。
 * 判定单一数据源：shared/poiMeta.ts；展示组件：web/components/PoiMeta.tsx。
 */
describe("VisitCard 飞猪元信息展示（任务 330）", () => {
  const DESC =
    "西岛门票 98 元，含往返船票。岛上以渔村风情和水上项目为主，适合慢慢逛半天，别赶时间。";

  function poiItem(extra: Partial<Item> = {}): Item {
    return {
      ...makeItem("item_poi", "西岛"),
      origin: "fliggy",
      providerId: "2611",
      ...extra,
    };
  }

  function renderWith(item: Item, overrides: Partial<Visit> = {}) {
    const visit = makeVisit("visit_poi", "item_poi", overrides);
    renderCard(
      makeTrip({ itemRegistry: { item_poi: item }, visits: { visit_poi: visit } }),
      visit,
    );
    return visit;
  }

  it("普通卡：poiLevel=\"4\" 渲染 4A 徽标（.badge-row 内 .tag.poi-level），不再落名称行且不输出原始脏值", () => {
    renderWith(poiItem({ poiLevel: "4" }));
    // Task #356（PD DEMO v0.6 Z2）：徽标移出名称行，落徽章行
    const tag = document.querySelector(".item .badge-row .tag.poi-level");
    expect(tag?.textContent).toBe("4A");
    expect(document.querySelector(".item .nm .tag.poi-level")).toBeNull();
    expect(screen.queryByText("4")).toBeNull();
  });

  it("普通卡：poiLevel 缺失 / 无法识别（3A）时不渲染徽标（不占位、不输出脏值）", () => {
    renderWith(poiItem());
    expect(document.querySelector(".item .badge-row .poi-level")).toBeNull();
    cleanup();
    renderWith(poiItem({ poiLevel: "3A" }));
    expect(document.querySelector(".item .badge-row .poi-level")).toBeNull();
  });

  it("普通卡：listRank 渲染 .poi-rank 暖色 chip（🏆 + 榜单文本），#356 起落 .badge-row", () => {
    renderWith(poiItem({ listRank: "海南4A/5A景点榜第2名" }));
    const chip = document.querySelector(".item .ibody .poi-rank");
    expect(chip).not.toBeNull();
    expect(chip?.querySelector(".poi-rank-icon")?.textContent).toBe("🏆");
    expect(chip?.querySelector(".poi-rank-text")?.textContent).toBe("海南4A/5A景点榜第2名");
    expect(document.querySelector(".item .badge-row .poi-rank")).not.toBeNull();
  });

  it("普通卡：#356 徽标与榜单 chip 同落一个 .badge-row（DEMO Z2 同行）", () => {
    renderWith(poiItem({ poiLevel: "5", listRank: "海南4A/5A景点榜第2名" }));
    const rows = document.querySelectorAll(".item .badge-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.querySelector(".tag.poi-level")?.textContent).toBe("5A");
    expect(rows[0]?.querySelector(".poi-rank-text")?.textContent).toBe("海南4A/5A景点榜第2名");
  });

  it("普通卡：#358 平台分类标签 chip 不再渲染（.meta/.tag.sage 消失，item.category 数据保留）", () => {
    renderWith(poiItem({ category: "山湖田园" }));
    // 分类 chip 容器与节点均移除，不留空白行
    expect(document.querySelector(".item .meta")).toBeNull();
    expect(document.querySelector(".item .tag.sage")).toBeNull();
    expect(screen.queryByText("山湖田园")).toBeNull();
  });

  it("普通卡：listRank 缺失时完全不占位（无 .poi-rank、无空白行、无 null 文本）", () => {
    renderWith(poiItem());
    expect(document.querySelector(".poi-rank")).toBeNull();
    expect(screen.queryByText("null")).toBeNull();
  });

  it("普通卡：#356 description 有值也不再渲染介绍区块（数据字段保留、仅移除展示）", () => {
    renderWith(poiItem({ description: DESC }));
    expect(document.querySelector(".poi-desc")).toBeNull();
    // #356 指介绍**折叠区**（PoiDescription 的 .poi-desc-toggle），非 #372 新增的「查看介绍」主按钮；
    // 原宽匹配 /介绍/ 会被 #372 合法主按钮命中，故收窄为折叠区专属选择器。
    expect(document.querySelector(".poi-desc-toggle")).toBeNull();
    // 折叠区正文不渲染（#372 浮层未打开时 DESC 也不在页面）
    expect(document.querySelector(".poi-desc-body")).toBeNull();
  });

  it("普通卡：description 缺失时同样无任何介绍痕迹", () => {
    renderWith(poiItem());
    expect(document.querySelector(".poi-desc")).toBeNull();
    expect(screen.queryByRole("button", { name: /介绍/ })).toBeNull();
  });

  it("大景区父卡：#356 徽标与榜单 chip 同落 .badge-row，介绍区块不再渲染", () => {
    renderWith(
      poiItem({ poiLevel: "AAAA", listRank: "海南4A/5A景点榜第2名", description: DESC }),
      // #348 渲染判定改为子玩法驱动，夹具补 children 维持父卡形态
      { kind: "large_attraction", childStopRefs: ["stop_kid"] },
    );
    const row = document.querySelector(".parent-card .badge-row");
    expect(row?.querySelector(".tag.poi-level")?.textContent).toBe("4A");
    expect(row?.querySelector(".poi-rank-text")?.textContent).toBe("海南4A/5A景点榜第2名");
    // #356：徽标不再落 .parent-tags；介绍折叠区移除（description 数据保留）
    expect(document.querySelector(".parent-tags .tag.poi-level")).toBeNull();
    expect(document.querySelector(".poi-desc")).toBeNull();
    // 同普通卡：收窄为折叠区专属选择器，不与 #372「查看介绍」主按钮混淆
    expect(document.querySelector(".poi-desc-toggle")).toBeNull();
  });

  it("样式契约：Task #330/#356 类集中在 styles.css，且 390px 名称行有 flex-wrap 兜底", () => {
    const css = readStylesCss();
    expect(css).toMatch(/\.tag\.poi-level\s*\{/);
    expect(css).toMatch(/\.poi-rank\s*\{/);
    expect(css).toMatch(/\.poi-desc-toggle\s*\{/);
    // #356：徽章行与 MOCK 退票话术；Task #368：有话术时行上方浅分隔线（:has 门控）已除——
    // 无话术卡片无线、观感不一致（PD 反馈），话术文本/色/居左布局保留仅去线
    expect(css).toMatch(/\.badge-row\s*\{/);
    expect(css).toMatch(/\.badge-row:empty\s*\{/);
    expect(css).toMatch(/\.card-actions > \.buy-assure\s*\{/);
    expect(css).not.toMatch(/\.card-actions:has\(> \.buy-assure\)\s*\{/);
    expect(css).toMatch(/@media\s*\(max-width:\s*390px\)/);
  });
});

/**
 * Task #356（PD 2026-11-10，DEMO v0.6 转化行）：MOCK 退票话术「先囤票，改期全额退」——
 * 仅白名单景点（西岛/蜈支洲岛，name includes 匹配）的购票动作区展示；无真实退改
 * 逻辑支撑，接入真实逻辑时替换 lib/refundAssurance 单点。
 */
describe("VisitCard MOCK 退票话术（Task #356）", () => {
  it("白名单判定：西岛/蜈支洲岛（含组合名）命中，其余景点与空名不命中", () => {
    expect(showRefundAssurance("西岛")).toBe(true);
    expect(showRefundAssurance("蜈支洲岛")).toBe(true);
    expect(showRefundAssurance("西岛渔村码头")).toBe(true);
    expect(showRefundAssurance("鹿回头风景区")).toBe(false);
    expect(showRefundAssurance("亚龙湾热带天堂森林公园")).toBe(false);
    expect(showRefundAssurance("")).toBe(false);
    expect(showRefundAssurance(null)).toBe(false);
    expect(REFUND_ASSURANCE_POI_WHITELIST).toEqual(["西岛", "蜈支洲岛"]);
    expect(REFUND_ASSURANCE_TEXT).toBe("先囤票，改期全额退");
  });

  it("西岛普通卡：动作区渲染 .buy-assure 话术（✓ 前缀 + MOCK 文案）", () => {
    const item: Item = { ...makeItem("item_poi", "西岛"), origin: "fliggy", providerId: "2611" };
    const visit = makeVisit("visit_poi", "item_poi");
    renderCard(makeTrip({ itemRegistry: { item_poi: item }, visits: { visit_poi: visit } }), visit);
    const assure = document.querySelector(".card-actions .buy-assure");
    expect(assure?.textContent).toBe(`✓ ${REFUND_ASSURANCE_TEXT}`);
  });

  it("西岛大景区父卡：同一口径在 .parent-foot 动作区展示话术", () => {
    const item: Item = { ...makeItem("item_poi", "西岛"), origin: "fliggy", providerId: "2611" };
    const visit = makeVisit("visit_poi", "item_poi", {
      kind: "large_attraction",
      childStopRefs: ["stop_kid"],
    });
    renderCard(makeTrip({ itemRegistry: { item_poi: item }, visits: { visit_poi: visit } }), visit);
    expect(document.querySelector(".parent-foot .card-actions .buy-assure")?.textContent).toBe(
      `✓ ${REFUND_ASSURANCE_TEXT}`,
    );
  });

  it("非白名单景点（鹿回头）：动作区无任何话术（.buy-assure 不渲染）", () => {
    const item: Item = { ...makeItem("item_poi", "鹿回头风景区"), origin: "fliggy", providerId: "999" };
    const visit = makeVisit("visit_poi", "item_poi");
    renderCard(makeTrip({ itemRegistry: { item_poi: item }, visits: { visit_poi: visit } }), visit);
    expect(document.querySelector(".buy-assure")).toBeNull();
    expect(screen.queryByText(/先囤票/)).toBeNull();
  });
});

/**
 * Task #342：相似亮点卡内合并为 1 条 + 诚实标注（仅展示层收敛）。
 * 现场形态：过江龙索桥两条同提及改写（LCS 0.421 / 连续段「可走旁边」4 字）。
 * Task #352 处/篇规则：同一句原文的重复抽取并存对总提及只计 1 次 → 不标注；
 * 每篇恰好提及一次且 ≥2 篇 →「N篇攻略提及」；其余按总提及次数 →「N处攻略提及」。
 */
describe("VisitCard 相似亮点展示层聚类（Task #342）", () => {
  const BRIDGE_A = "不想花钱排队可走旁边平行木栈道，景色差不多";
  const BRIDGE_B = "索桥20元排队久，可走旁边栈道免费绕过";

  function bridgeSnippets(refs: string[] = ["ev_1:m_1"]): Visit["guideSnippets"] {
    return [
      { snippetId: "gsn_a", text: BRIDGE_A, claimKind: "tip", sourceMentionRefs: [...refs] },
      { snippetId: "gsn_b", text: BRIDGE_B, claimKind: "tip", sourceMentionRefs: [...refs] },
    ];
  }

  it("普通卡：相似两条同一句原文重复抽取 → 1 chip，总提及 1 次 → 不标注（#352）", () => {
    const visit = makeVisit("visit_1", "item_xidao", {
      sourceMentionRefs: ["ev_1:m_1"],
      guideSnippets: bridgeSnippets(),
    });
    renderCard(
      makeTrip({
        visits: { visit_1: visit },
        guideSources: { s_text: makeSource("s_text", { inputKind: "text", evidenceRefs: ["ev_1"] }) },
      }),
      visit,
    );

    const chips = [...document.querySelectorAll(".guide-snippet-chip")];
    expect(chips.length).toBe(1);
    expect(chips[0]?.textContent).toContain(BRIDGE_A); // 代表取更长文本
    expect(chips[0]?.querySelector(".guide-snippet-note")).toBeNull();
  });

  it("普通卡：单篇攻略两处不同提及 → 1 chip + 「2处攻略提及」（#352 单篇多处一律处）", () => {
    const visit = makeVisit("visit_1", "item_xidao", {
      sourceMentionRefs: ["ev_1:m_1", "ev_1:m_2"],
      guideSnippets: bridgeSnippets(["ev_1:m_1", "ev_1:m_2"]),
    });
    renderCard(
      makeTrip({
        visits: { visit_1: visit },
        guideSources: { s_text: makeSource("s_text", { inputKind: "text", evidenceRefs: ["ev_1"] }) },
      }),
      visit,
    );

    const chips = [...document.querySelectorAll(".guide-snippet-chip")];
    expect(chips.length).toBe(1);
    expect(chips[0]?.querySelector(".guide-snippet-note")?.textContent).toBe("（2处攻略提及）");
  });

  it("父卡引用块：相似两条收敛为代表条，同一句重复抽取不再拼接也不标注（#352）", () => {
    const visit = makeVisit("visit_1", "item_xidao", {
      kind: "large_attraction",
      sourceMentionRefs: ["ev_1:m_1"],
      guideSnippets: bridgeSnippets(),
      // #348 渲染判定改为子玩法驱动，夹具补 children 维持原断言语义（父卡引用块）
      childStopRefs: ["stop_kid"],
    });
    renderCard(
      makeTrip({
        visits: { visit_1: visit },
        guideSources: { s_text: makeSource("s_text", { inputKind: "text", evidenceRefs: ["ev_1"] }) },
      }),
      visit,
    );

    const quote = document.querySelector(".parent-card .guide-quote-text");
    expect(quote).not.toBeNull();
    expect(quote?.textContent).toContain(BRIDGE_A);
    // #352：同一句原文的重复抽取总提及只计 1 次 → 引用块不带标注
    expect(quote?.textContent).not.toContain("提及）");
    // 收敛后不再把第二条原文拼接进引用块（避免重复），但原文 sheet 仍全量
    expect(quote?.textContent).not.toContain(BRIDGE_B);
  });

  it("点开原文 sheet：父卡引用块背后的 EvidenceSheet 仍逐条全量展示 2 条", () => {
    const visit = makeVisit("visit_1", "item_xidao", {
      kind: "large_attraction",
      sourceMentionRefs: ["ev_1:m_1"],
      guideSnippets: bridgeSnippets(),
      // #348 渲染判定改为子玩法驱动，夹具补 children 维持原断言语义（父卡引用块）
      childStopRefs: ["stop_kid"],
    });
    renderCard(
      makeTrip({
        visits: { visit_1: visit },
        guideSources: { s_text: makeSource("s_text", { inputKind: "text", evidenceRefs: ["ev_1"] }) },
      }),
      visit,
    );

    // 无外部原链 → 父卡引用块的「查看攻略原文」为 button，点击打开 EvidenceSheet
    const link = document.querySelector(".parent-card .guide-quote-link");
    expect(link?.tagName).toBe("BUTTON");
    fireEvent.click(link as Element);
    expect(screen.getByRole("dialog", { name: "攻略原文" })).toBeInTheDocument();
    const sheetSnippets = [...document.querySelectorAll(".evidence-snippet")];
    expect(sheetSnippets.length).toBe(2);
    expect(sheetSnippets.map((s) => s.textContent)).toEqual([BRIDGE_A, BRIDGE_B]);
  });
});

/**
 * Task #346（PD 2026-11-04：「把『大景区』这几个字也去掉」）——反转 #344 口径，非静默放宽：
 * 父卡名字下的 .tag.clay 只渲染 mode 段：full_day 空串→整枚不渲染；
 * half_day / custom 只显「半天」/「自定义」（「大景区」前缀移除）。
 * 分享页同款徽标核实只显 modeLabel（#344 审计结论），本次无需同步。
 *
 * 仅展示层去字：visitMode 数据本身未动（下面用例直接断言夹具的 visitMode 仍为 full_day）。
 */
describe("VisitCard 大景区父卡 clay 标签去掉「大景区」（Task #346，反转 #344）", () => {
  function renderParent(visitMode: Visit["visitMode"]) {
    const visit = makeVisit("visit_xidao", "item_xidao", {
      kind: "large_attraction",
      visitMode,
      // #348 渲染判定改为子玩法驱动，夹具补 children 维持原断言语义（clay 标签在 .parent-tags）
      childStopRefs: ["stop_kid"],
    });
    renderCard(makeTrip({ visits: { visit_xidao: visit } }), visit);
    return visit;
  }

  function clayTagText(): string | null {
    return document.querySelector(".parent-tags .tag.clay")?.textContent ?? null;
  }

  it("full_day：clay 标签整枚不渲染（无「大景区」字样），全文不出现「全天」", () => {
    const visit = renderParent("full_day");

    expect(clayTagText()).toBeNull();
    // Task #356：full_day 无 clay 标签且非免票时 .parent-tags 整行不渲染（不留空白行）
    expect(document.querySelector(".parent-tags")?.textContent ?? "").not.toContain("大景区");
    expect(screen.queryByText("全天")).toBeNull();
    expect(document.body.textContent).not.toContain("全天");
    // 仅展示层去字：数据侧 visitMode 仍是 full_day（推导 / prompt / 规则语义未动）
    expect(visit.visitMode).toBe("full_day");
  });

  it("half_day：只渲染「半天」（无「大景区」前缀、无悬空「· 」）", () => {
    renderParent("half_day");

    expect(clayTagText()).toBe("半天");
    expect(document.querySelector(".parent-tags")?.textContent).not.toContain("大景区");
    expect(document.body.textContent).not.toContain("全天");
  });

  it("custom：只渲染「自定义」", () => {
    renderParent("custom");

    expect(clayTagText()).toBe("自定义");
    expect(document.querySelector(".parent-tags")?.textContent).not.toContain("大景区");
  });

  it("同排其他徽标不受影响：等级 / 免票 / 榜单 chip 仍渲染（没误伤）", () => {
    const visit = makeVisit("visit_xidao", "item_xidao", {
      kind: "large_attraction",
      visitMode: "full_day",
      // #348 渲染判定改为子玩法驱动，夹具补 children 维持原断言语义（同排徽标在 .parent-tags）
      childStopRefs: ["stop_kid"],
    });
    renderCard(
      makeTrip({
        itemRegistry: {
          item_xidao: {
            ...makeItem("item_xidao", "西岛"),
            origin: "fliggy",
            providerId: "2611",
            freePoiStatus: "FREE",
            poiLevel: "AAAAA",
            listRank: "海南4A/5A景点榜第1名",
          },
        },
        visits: { visit_xidao: visit },
      }),
      visit,
    );

    expect(clayTagText()).toBeNull();
    // Task #356：等级徽标移入 .badge-row（与榜单 chip 同行）；免票标签仍留 .parent-tags
    expect(document.querySelector(".parent-card .badge-row .tag.poi-level")?.textContent).toBe("5A");
    expect(document.querySelector(".parent-tags .tag.slate")?.textContent).toBe("免票");
    expect(document.querySelector(".parent-card .badge-row .poi-rank-text")?.textContent).toBe("海南4A/5A景点榜第1名");
  });

  it("Task #346 把手列移除：DOM 无 .grip，sr-only 键盘把手 .drag-kbd 可聚焦且带 aria-label", () => {
    renderParent("full_day");

    expect(document.querySelector(".row .grip")).toBeNull();
    const kbd = document.querySelector(".row .drag-kbd") as HTMLButtonElement | null;
    expect(kbd).not.toBeNull();
    // dnd-kit attributes 注入 tabIndex=0 / role=button，视觉隐藏但键盘可达
    expect(kbd?.tabIndex).toBe(0);
    expect(kbd?.getAttribute("aria-label")).toContain("拖动调整顺序");
  });
});

// ===== Task #348（PD 2026-11-04）：父卡渲染形态由岛内子玩法驱动（三态）=====
describe("VisitCard 父卡渲染形态由岛内子玩法驱动（Task #348 三态）", () => {
  // 鹿回头类存量大景区：kind=large_attraction 但 childStopRefs 为空（白名单升级、无内容）。
  const LH_SNIPPETS: Visit["guideSnippets"] = [
    { snippetId: "gsn_lh_1", text: "鹿回头日落时分俯瞰三亚湾最佳", claimKind: "tip", sourceMentionRefs: [] },
    { snippetId: "gsn_lh_2", text: "山顶咖啡馆可久坐看夜景", claimKind: "experience", sourceMentionRefs: [] },
  ];

  it("large_attraction + 0 子玩法：渲染普通卡形态（无 .parent-item/.parent-card），guideSnippets 正常显 chips", () => {
    const visit = makeVisit("visit_luhuitou", "item_xidao", {
      kind: "large_attraction",
      childStopRefs: [],
      guideSnippets: LH_SNIPPETS,
    });
    renderCard(makeTrip({ visits: { visit_luhuitou: visit } }), visit);

    // 空壳父卡消失：不再有父卡容器 / 横幅 / 「岛内 N 个点」空态
    expect(document.querySelector(".parent-item")).toBeNull();
    expect(document.querySelector(".parent-card")).toBeNull();
    expect(document.querySelector(".parent-banner")).toBeNull();
    expect(document.querySelector(".parent-sub")).toBeNull();
    // 普通卡本体在（.item 但非 .parent-item）
    expect(document.querySelector(".item")).not.toBeNull();
    // 鹿回头的 2 条 guideSnippets 在普通卡形态正常渲染为 chips
    const chips = [...document.querySelectorAll(".guide-snippet-chip")];
    expect(chips).toHaveLength(2);
    expect(chips[0]?.textContent).toContain("鹿回头日落时分俯瞰三亚湾最佳");
    expect(chips[1]?.textContent).toContain("山顶咖啡馆可久坐看夜景");
  });

  it("large_attraction + ≥1 子玩法：渲染父卡形态（.parent-item/.parent-card + 岛内小行程）", () => {
    const child = makeStop("stop_child", "情人桥");
    const visit = makeVisit("visit_xidao", "item_xidao", {
      kind: "large_attraction",
      childStopRefs: ["stop_child"],
    });
    renderCard(
      makeTrip({ visits: { visit_xidao: visit }, stops: { stop_child: child } }),
      visit,
    );

    expect(document.querySelector(".parent-item")).not.toBeNull();
    expect(document.querySelector(".parent-card")).not.toBeNull();
    expect(document.querySelector(".parent-banner")).not.toBeNull();
    // 岛内小行程渲染子玩法
    expect(screen.getByText("岛内小行程")).toBeInTheDocument();
    expect(document.querySelector(".child-list")?.textContent).toContain("情人桥");
  });

  it("ordinary + 0 子玩法：渲染普通卡形态（无 .parent-item）", () => {
    const visit = makeVisit("visit_1", "item_xidao", {
      kind: "ordinary",
      childStopRefs: [],
    });
    renderCard(makeTrip({ visits: { visit_1: visit } }), visit);

    expect(document.querySelector(".parent-item")).toBeNull();
    expect(document.querySelector(".parent-card")).toBeNull();
    expect(document.querySelector(".item")).not.toBeNull();
  });
});

describe("媒体盒 D 档 120-160 区间 + 顶对齐（Task #364）", () => {
  /** 取 styles.css 里以指定选择器开头的单条规则体（精确到 “selector {”，不吞同前缀类名） */
  function ruleOf(css: string, selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return css.match(new RegExp(`^${escaped} \\{[^}]*\\}`, "m"))?.[0] ?? "";
  }

  it("样式契约：三窗口盒 D 档区间高（height:100% + min 120 + max 160）", () => {
    const css = readStylesCss();

    // 景点卡图片窗口：图高在 120-160 区间内跟随内容行数，cover + 10px 圆角保留
    const frame = ruleOf(css, ".thumb-frame");
    expect(frame).not.toBe("");
    expect(frame).toContain("width: 100%");
    expect(frame).toContain("height: 100%");
    expect(frame).toContain("min-height: 120px");
    expect(frame).toContain("max-height: 160px");
    expect(frame).toContain("overflow: hidden");
    expect(frame).toContain("border-radius: 10px");
    // 图片仍铺满窗口 + cover 不变形
    const frameImg = ruleOf(css, ".thumb-frame img");
    expect(frameImg).toContain("height: 100%");
    expect(frameImg).toContain("object-fit: cover");

    // 酒店卡：图片即窗口盒（#355 同族），D 档区间高同步
    const hotel = ruleOf(css, ".hotelphoto img");
    expect(hotel).not.toBe("");
    expect(hotel).toContain("width: 100%");
    expect(hotel).toContain("height: 100%");
    expect(hotel).toContain("min-height: 120px");
    expect(hotel).toContain("max-height: 160px");
    expect(hotel).toContain("object-fit: cover");
    expect(hotel).toContain("border-radius: 10px");

    // 无图占位变体：同一窗口盒 D 档区间高同步（有图/无图切换零跳动）
    const ph = ruleOf(css, ".thumb > .ph-tile");
    expect(ph).not.toBe("");
    expect(ph).toContain("height: 100%");
    expect(ph).toContain("min-height: 120px");
    expect(ph).toContain("max-height: 160px");
    expect(ph).toContain("border-radius: 10px");
  });

  it("同族列宽口径不变：.thumb / .hotelphoto 均 132 = 12 内缩 + 120 窗，#364 顶对齐", () => {
    const css = readStylesCss();
    for (const selector of [".thumb", ".hotelphoto"]) {
      const rule = ruleOf(css, selector);
      expect(rule).not.toBe("");
      expect(rule).toContain("width: 132px");
      expect(rule).toContain("flex: 0 0 132px");
      expect(rule).toContain("padding: 8px 0 8px 12px");
      expect(rule).toContain("align-items: flex-start");
    }
    // photo-note（飞猪实图角标）仍绝对定位在窗口左下角，位置不变
    const note = ruleOf(css, ".thumb .photo-note");
    expect(note).toContain("position: absolute");
    expect(note).toContain("left: 4px");
    expect(note).toContain("bottom: 4px");
  });

  it("分享页图片为独立形态（.share-thumb 92×92 / .share-stay-pic 46×46），不随 #364 D 档区间", () => {
    const css = readStylesCss();
    const shareThumb = ruleOf(css, ".share-thumb");
    expect(shareThumb).toContain("width: 92px");
    expect(shareThumb).toContain("height: 92px");
    const shareStay = ruleOf(css, ".share-stay-pic");
    expect(shareStay).toContain("width: 46px");
    expect(shareStay).toContain("height: 46px");
    // 分享页不复用 .thumb-frame / .hotelphoto（已全仓检索确认），故无需同步固定
    expect(shareThumb).not.toContain("120px");
    expect(shareStay).not.toContain("120px");
  });

  it("占位基类铺满窗口 + 内容居中，120-160 区间盒内不会顶部对齐", () => {
    const css = readStylesCss();
    const base = ruleOf(css, ".ph-tile");
    expect(base).toContain("width: 100%");
    expect(base).toContain("display: flex");
    expect(base).toContain("align-items: center");
    expect(base).toContain("justify-content: center");
  });

  it("Task #362：文字列顶排（.ibody justify-content: flex-start），酒店卡同族无垂直居中", () => {
    const css = readStylesCss();
    const ibody = ruleOf(css, ".ibody");
    expect(ibody).not.toBe("");
    expect(ibody).toContain("justify-content: flex-start");
    expect(ibody).not.toContain("justify-content: center");
    // .hotelbody 本就顶排（默认 flex-start），#362 同族无同病不需改
    expect(ruleOf(css, ".hotelbody")).not.toContain("justify-content: center");
    // Task #364：图列与标题同顶（#347 列内居中废弃——长卡标题悬空）
    for (const selector of [".thumb", ".hotelphoto"]) {
      expect(ruleOf(css, selector)).toContain("align-items: flex-start");
    }
  });
});

// ===== Task #372：无购票通道 / 免费入场 →「查看介绍」应用内浮层 =====

/**
 * PD 拍板：无购票通道点位主按钮由「去购票」改为「查看介绍」，点击开应用内浮层
 * （不跳飞猪外链）。判定单一数据源：shared/freePoi.ts shouldShowIntroEntry
 * =（无通道 或 免费入场）且 itemDescription !== null（空浮层守卫）。
 * 「购」下拉保留（标记无需购票/已购的唯一入口，PD 休息期自主决策口径）。
 */
describe("VisitCard 查看介绍入口（任务 372）", () => {
  const JUMP = "https://router.feizhu.com/multi/webview?url=poi";

  function introItem(extra: Partial<Item> = {}): Item {
    return {
      ...makeItem("item_intro", "后海村"),
      description: "后海村是冲浪胜地，傍晚很惬意。",
      ...extra,
    };
  }

  function renderWith(item: Item, overrides: Partial<Visit> = {}) {
    const visit = makeVisit("visit_intro", "item_intro", overrides);
    renderCard(
      makeTrip({ itemRegistry: { item_intro: item }, visits: { visit_intro: visit } }),
      visit,
    );
    return visit;
  }

  it("无购票通道（jumpUrl null）+ 有 description：主按钮「查看介绍」浅橙，点击开浮层（不跳外链）", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    renderWith(introItem({ jumpUrl: null, origin: "custom", providerId: null }));

    expect(screen.queryByRole("button", { name: "去购票" })).toBeNull();
    const intro = screen.getByRole("button", { name: "查看介绍" });
    expect(intro.className).toBe("booklink dim");
    expect(isDimMainAction("查看介绍")).toBe(true);

    // 点击前无浮层
    expect(screen.queryByRole("dialog", { name: "景点介绍" })).toBeNull();
    fireEvent.click(intro);
    // 点击后浮层打开，正文来自 description，且不触发 window.open
    expect(screen.getByRole("dialog", { name: "景点介绍" })).toBeInTheDocument();
    expect(screen.getByText("后海村是冲浪胜地，傍晚很惬意。")).toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it("免费入场（FREE）+ 有 jumpUrl + 有 description：降级「查看介绍」，点击开浮层而非跳飞猪", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    renderWith(
      introItem({ name: "椰梦长廊", jumpUrl: JUMP, origin: "fliggy", providerId: "163575", freePoiStatus: "FREE" }),
    );

    expect(screen.queryByRole("button", { name: "去购票" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看介绍" }));
    expect(screen.getByRole("dialog", { name: "景点介绍" })).toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it("零变化：NOT_FREE 有通道点位（西岛）维持「去购票」原 window.open 路径，无查看介绍入口", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    renderWith(
      introItem({ name: "西岛", jumpUrl: JUMP, origin: "fliggy", providerId: "2611", freePoiStatus: "NOT_FREE" }),
    );

    expect(screen.queryByRole("button", { name: "查看介绍" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "去购票" }));
    expect(openSpy).toHaveBeenCalledWith(JUMP, "_blank", "noopener");
    openSpy.mockRestore();
  });

  it("空浮层守卫：免费但无 description（国际免税城形态）不显示查看介绍，维持「查看详情」", () => {
    renderWith(
      introItem({ name: "国际免税城", jumpUrl: JUMP, origin: "fliggy", providerId: "199649345", freePoiStatus: "FREE", description: null }),
    );
    expect(screen.queryByRole("button", { name: "查看介绍" })).toBeNull();
    expect(screen.getByRole("button", { name: "查看详情" })).toBeInTheDocument();
  });

  it("「购」下拉入口保留：命中查看介绍的点位仍可标记购票状态（noTicket 唯一入口不删）", () => {
    renderWith(introItem({ jumpUrl: null, origin: "custom", providerId: null }));
    // 状态下拉（PurchaseToggle）仍在——unknown 态显示「购」；主按钮为「查看介绍」
    expect(screen.getByRole("button", { name: "购" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看介绍" })).toBeInTheDocument();
  });

  it("cardMainActionLabel：hasIntro=true 对 unknown/toBuy/noTicket 恒「查看介绍」，bought 仍优先「查看详情」，hotel 短路", () => {
    expect(cardMainActionLabel("poi", "unknown", "fliggy", true)).toBe("查看介绍");
    expect(cardMainActionLabel("poi", "noTicket", "fliggy", true)).toBe("查看介绍");
    expect(cardMainActionLabel("poi", "bought", "fliggy", true)).toBe("查看详情");
    expect(cardMainActionLabel("hotel", "unknown", "fliggy", true)).toBe("去订房");
    // hasIntro 默认 false → 原逻辑不回归
    expect(cardMainActionLabel("poi", "unknown", "fliggy")).toBe("去购票");
  });
});
