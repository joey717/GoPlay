import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  GuideImageProgressEntry,
  GuideSource,
  Item,
  SourceEvidence,
  Stop,
  Trip,
  Visit,
} from "@goplay/shared";
import StopRow from "./StopRow";

afterEach(cleanup);

// jsdom 未实现 scrollIntoView：绿色 chip 打开 EvidenceSheet 定位提及时会调用，测试内打桩
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

/**
 * 任务 124：StopRow「查看攻略原文 ›」外链语义。
 * 来源解析按本玩法自身范围（不合并父 Visit / 兄弟玩法）：
 * 单源直开外链 <a>、多源极简列表、无链接隐藏；绿色 chips 打开 EvidenceSheet 不回归。
 */
function makeEvidence(evidenceId: string, mentionId: string, extractedName: string): SourceEvidence {
  return {
    evidenceId,
    kind: "note_text",
    noteIndex: null,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions: [
      {
        mentionId,
        text: "",
        quoteText: `Q_${mentionId}`,
        bbox: null,
        extractedName,
        locationHint: null,
        modelSummary: null,
      },
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

function makeVisit(visitId: string, overrides: Partial<Visit> = {}): Visit {
  return {
    visitId,
    dayRef: "day_1",
    pointRef: "item_1",
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

function makeStop(stopId: string, customName: string, overrides: Partial<Stop> = {}): Stop {
  return {
    stopId,
    state: "attached",
    visitRef: "visit_1",
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

function makeTrip(parts: {
  evidences?: Record<string, SourceEvidence>;
  items?: Record<string, Item>;
  visits?: Record<string, Visit>;
  stops?: Record<string, Stop>;
  guideSources?: Record<string, GuideSource>;
}): Trip {
  return {
    tripId: "trip-stoprow",
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
    itemRegistry: parts.items ?? {},
    hotelRegistry: {},
    visits: parts.visits ?? {},
    stops: parts.stops ?? {},
    evidences: parts.evidences ?? {},
    globalCandidateRefs: [],
    pendingStopRefs: [],
    relationshipSuggestions: {},
    guideSources: parts.guideSources ?? {},
    constraints: [],
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
  };
}

function renderRow(trip: Trip, stop: Stop) {
  render(
    <StopRow
      trip={trip}
      stop={stop}
      index={0}
      total={1}
      timeRange={{ start: "09:00", end: "10:30" }}
      onMove={vi.fn()}
      onRemove={vi.fn()}
    />,
  );
}

describe("StopRow 原文入口（任务 124 外链语义）", () => {
  it("单一来源：入口为外链 <a>（target=_blank + noopener noreferrer），不弹 EvidenceSheet", () => {
    const stop = makeStop("stop_1", "情人桥", {
      sourceMentionRefs: ["ev_a:m_a"],
      sourceEvidenceRefs: ["ev_a"],
    });
    const trip = makeTrip({
      evidences: { ev_a: makeEvidence("ev_a", "m_a", "情人桥") },
      guideSources: {
        s_a: makeSource("s_a", {
          title: "情人桥玩法攻略",
          sourceUrl: "https://www.xiaohongshu.com/explore/a",
          evidenceRefs: ["ev_a"],
        }),
      },
    });
    renderRow(trip, stop);

    const entry = document.querySelector(".child-evidence");
    expect(entry).not.toBeNull();
    expect(entry?.tagName).toBe("A");
    expect(entry?.getAttribute("href")).toBe("https://www.xiaohongshu.com/explore/a");
    expect(entry?.getAttribute("target")).toBe("_blank");
    expect(entry?.getAttribute("rel")).toContain("noopener");
    expect(entry?.getAttribute("rel")).toContain("noreferrer");
    expect(screen.queryByRole("dialog", { name: "攻略原文" })).not.toBeInTheDocument();
  });

  it("多来源：点击弹极简列表（标题 + 打开原文），每条为新标签外链", () => {
    const stop = makeStop("stop_1", "情人桥", {
      sourceMentionRefs: ["ev_a:m_a", "ev_b:m_b"],
      sourceEvidenceRefs: ["ev_a", "ev_b"],
    });
    const trip = makeTrip({
      evidences: {
        ev_a: makeEvidence("ev_a", "m_a", "情人桥"),
        ev_b: makeEvidence("ev_b", "m_b", "情人桥"),
      },
      guideSources: {
        s_a: makeSource("s_a", {
          title: "情人桥篇",
          sourceUrl: "https://www.xiaohongshu.com/explore/a",
          evidenceRefs: ["ev_a"],
        }),
        s_b: makeSource("s_b", {
          title: "潜水篇",
          sourceUrl: "https://www.xiaohongshu.com/explore/b",
          evidenceRefs: ["ev_b"],
        }),
      },
    });
    renderRow(trip, stop);

    const entry = document.querySelector(".child-evidence");
    expect(entry?.tagName).toBe("BUTTON");
    fireEvent.click(entry as Element);

    const menu = document.querySelector(".source-menu");
    expect(menu).not.toBeNull();
    expect(screen.getByText("情人桥篇")).toBeInTheDocument();
    expect(screen.getByText("潜水篇")).toBeInTheDocument();
    const openLinks = [...document.querySelectorAll<HTMLAnchorElement>(".source-menu-open")];
    expect(openLinks.map((link) => link.getAttribute("href"))).toEqual([
      "https://www.xiaohongshu.com/explore/a",
      "https://www.xiaohongshu.com/explore/b",
    ]);
    for (const link of openLinks) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
    }
    expect(screen.queryByRole("dialog", { name: "攻略原文" })).not.toBeInTheDocument();
  });

  it("无外部链接（text 来源）：入口隐藏，不再降级打开 EvidenceSheet", () => {
    const stop = makeStop("stop_1", "情人桥", {
      sourceMentionRefs: ["ev_a:m_a"],
      sourceEvidenceRefs: ["ev_a"],
    });
    const trip = makeTrip({
      evidences: { ev_a: makeEvidence("ev_a", "m_a", "情人桥") },
      guideSources: {
        s_text: makeSource("s_text", { inputKind: "text", evidenceRefs: ["ev_a"] }),
      },
    });
    renderRow(trip, stop);

    expect(document.querySelector(".child-evidence")).toBeNull();
    expect(screen.queryByText(/查看攻略原文/)).toBeNull();
    expect(screen.queryByRole("dialog", { name: "攻略原文" })).not.toBeInTheDocument();
  });

  it("Stop 隔离：父 Visit 与兄弟玩法的来源不并入本玩法入口", () => {
    const target = makeStop("stop_a", "情人桥", {
      sourceMentionRefs: ["ev_a:m_a"],
      sourceEvidenceRefs: ["ev_a"],
    });
    const sibling = makeStop("stop_b", "观日岩", {
      sourceMentionRefs: ["ev_b:m_b"],
      sourceEvidenceRefs: ["ev_b"],
    });
    const parent = makeVisit("visit_1", {
      kind: "large_attraction",
      sourceMentionRefs: ["ev_p:m_p"],
      childStopRefs: ["stop_a", "stop_b"],
    });
    const trip = makeTrip({
      items: { item_1: makeItem("item_1", "蜈支洲岛") },
      visits: { visit_1: parent },
      stops: { stop_a: target, stop_b: sibling },
      evidences: {
        ev_p: makeEvidence("ev_p", "m_p", "蜈支洲岛"),
        ev_a: makeEvidence("ev_a", "m_a", "情人桥"),
        ev_b: makeEvidence("ev_b", "m_b", "观日岩"),
      },
      guideSources: {
        s_p: makeSource("s_p", {
          title: "父卡来源",
          sourceUrl: "https://parent.example/1",
          evidenceRefs: ["ev_p"],
        }),
        s_a: makeSource("s_a", {
          title: "情人桥来源",
          sourceUrl: "https://a.example/2",
          evidenceRefs: ["ev_a"],
        }),
        s_b: makeSource("s_b", {
          title: "观日岩来源",
          sourceUrl: "https://b.example/3",
          evidenceRefs: ["ev_b"],
        }),
      },
    });
    renderRow(trip, target);

    const entry = document.querySelector(".child-evidence");
    expect(entry).not.toBeNull();
    expect(entry?.getAttribute("href")).toBe("https://a.example/2");
  });

  it("绿色 chip 不回归：点击 chip 打开 EvidenceSheet 并定位对应提及", () => {
    const stop = makeStop("stop_1", "情人桥", {
      sourceMentionRefs: ["ev_a:m_a"],
      sourceEvidenceRefs: ["ev_a"],
      guideSnippets: [
        {
          snippetId: "snip_1",
          text: "情人桥要赶早",
          claimKind: "tip",
          sourceMentionRefs: ["ev_a:m_a"],
        },
      ],
    });
    const trip = makeTrip({
      evidences: { ev_a: makeEvidence("ev_a", "m_a", "情人桥") },
      guideSources: {
        s_text: makeSource("s_text", { inputKind: "text", evidenceRefs: ["ev_a"] }),
      },
    });
    renderRow(trip, stop);

    // 无外链 → 灰色入口隐藏；绿色 chip 仍在
    expect(document.querySelector(".child-evidence")).toBeNull();
    const chip = document.querySelector(".guide-snippet-chip");
    expect(chip).not.toBeNull();

    fireEvent.click(chip as Element);

    expect(screen.getByRole("dialog", { name: "攻略原文" })).toBeInTheDocument();
    expect(screen.getByText(/Q_m_a/)).toBeInTheDocument();
    const hit = document.querySelector(".evidence-snippet.hit");
    expect(hit).not.toBeNull();
    expect(hit?.textContent).toContain("情人桥要赶早");
  });
});

describe("StopRow 小方图统一占位（任务 128）", () => {
  it("无 mainPic（custom）：渲染占位（generic 地图钉 + 短名），无 <img>", () => {
    renderRow(makeTrip({}), makeStop("stop_1", "情人桥"));

    const pic = document.querySelector(".child-pic");
    expect(pic?.querySelector(".ph-tile.ph-generic")).not.toBeNull();
    expect(pic?.querySelector("svg.ph-pin")).not.toBeNull();
    expect(pic?.querySelector("img")).toBeNull();
    expect(pic?.querySelector(".ph-name")?.textContent).toBe("情人桥");
  });

  it("有 mainPic：渲染 <img>，不渲染占位", () => {
    const trip = makeTrip({
      items: {
        // Task #296：mainPic 仅飞猪点位有（custom 契约恒 null），夹具按 origin=fliggy 构造
        item_1: { ...makeItem("item_1", "情人桥"), origin: "fliggy", providerId: "F1", mainPic: "https://img.example/1.jpg" },
      },
    });
    renderRow(trip, makeStop("stop_1", "情人桥", { matchedPointRef: "item_1", customName: null }));

    const pic = document.querySelector(".child-pic");
    expect(pic?.querySelector("img")).not.toBeNull();
    expect(pic?.querySelector(".ph-tile")).toBeNull();
  });

  it("图片加载失败：切换为统一占位，不空白不跳布局", () => {
    const trip = makeTrip({
      items: {
        item_1: { ...makeItem("item_1", "情人桥"), origin: "fliggy", providerId: "F1", mainPic: "https://img.example/broken.jpg" },
      },
    });
    renderRow(trip, makeStop("stop_1", "情人桥", { matchedPointRef: "item_1", customName: null }));

    const img = document.querySelector(".child-pic img");
    expect(img).not.toBeNull();
    fireEvent.error(img as Element);

    const pic = document.querySelector(".child-pic");
    expect(pic?.querySelector(".ph-tile")).not.toBeNull();
    expect(pic?.querySelector("img")).toBeNull();
  });

  it("命中飞猪且带类别：占位按 category 归类（餐饮）", () => {
    const trip = makeTrip({
      items: {
        item_2: { ...makeItem("item_2", "林姐海鲜加工"), category: "美食" },
      },
    });
    renderRow(trip, makeStop("stop_2", "林姐海鲜加工", { matchedPointRef: "item_2", customName: null }));

    expect(document.querySelector(".child-pic .ph-tile.ph-dining")).not.toBeNull();
  });
});

describe("StopRow 攻略原图首图（任务 196 页码配图）", () => {
  /** 13 槽来源中哪些页 ready（assetPath 与页码一一对应，模拟服务端下载落盘形态） */
  const READY_PAGES = [2, 3, 6, 7, 11];

  /** 带页码引用的正文证据（服务端 pushMention 落盘形态：pageRefs 仅 note_text 提取） */
  function makePageEvidence(evidenceId: string, pageRefs: number[] | undefined): SourceEvidence {
    const base = makeEvidence(evidenceId, "m_a", "西岛墙");
    const mention = { ...base.mentions[0], quoteText: "上岛第一站去西岛墙 p6 拍照" };
    if (pageRefs !== undefined) mention.pageRefs = pageRefs;
    return { ...base, mentions: [mention] };
  }

  /** 1..total 顺序槽位；readyPages 内的页 ready 且带明细 assetPath，其余 pending 占位 */
  function makeImages(total: number, readyPages: number[]): GuideImageProgressEntry[] {
    return Array.from({ length: total }, (_, i) => {
      const index = i + 1;
      if (!readyPages.includes(index)) {
        return { index, status: "pending" as const, evidenceId: null };
      }
      return {
        index,
        status: "ready" as const,
        evidenceId: `ev_img${index}`,
        assetPath: `uploads/t196/img-${String(index).padStart(2, "0")}.jpg`,
      };
    });
  }

  function pageSource(): GuideSource {
    return makeSource("s_a", {
      evidenceRefs: ["ev_a", ...READY_PAGES.map((page) => `ev_img${page}`)],
      imageProgress: {
        total: 13,
        completed: READY_PAGES.length,
        failed: 0,
        images: makeImages(13, READY_PAGES),
      },
    });
  }

  it("正文页码 p6：custom 点位小方图展示第 6 张攻略原图（/api 受控路径 + title 标注）", () => {
    const stop = makeStop("stop_1", "西岛墙", {
      sourceMentionRefs: ["ev_a:m_a"],
      sourceEvidenceRefs: ["ev_a"],
    });
    const trip = makeTrip({
      evidences: { ev_a: makePageEvidence("ev_a", [6]) },
      guideSources: { s_a: pageSource() },
    });
    renderRow(trip, stop);

    const img = document.querySelector(".child-pic img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("/api/uploads/t196/img-06.jpg");
    expect(img?.getAttribute("title")).toBe("攻略原图（原文页码关联）");
    expect(document.querySelector(".child-pic .ph-tile")).toBeNull();
  });

  it("页码槽位下载失败：不绑定也不前移取相邻 ready 图（p6 失败、p5 ready → 统一占位）", () => {
    const stop = makeStop("stop_1", "西岛墙", {
      sourceMentionRefs: ["ev_a:m_a"],
      sourceEvidenceRefs: ["ev_a"],
    });
    const images = makeImages(13, [5]);
    images[5] = { index: 6, status: "failed", evidenceId: null }; // 占位槽保留原始页码
    const trip = makeTrip({
      evidences: { ev_a: makePageEvidence("ev_a", [6]) },
      guideSources: {
        s_a: makeSource("s_a", {
          evidenceRefs: ["ev_a", "ev_img5"],
          imageProgress: { total: 13, completed: 1, failed: 1, images },
        }),
      },
    });
    renderRow(trip, stop);

    expect(document.querySelector(".child-pic img")).toBeNull();
    // 名称「西岛墙」被占位归类为非 generic 类别，只断言统一占位存在
    expect(document.querySelector(".child-pic .ph-tile")).not.toBeNull();
  });

  it("历史证据无 pageRefs 字段：零迁移不绑定任何图，沿用统一占位兜底", () => {
    const stop = makeStop("stop_1", "情人桥", {
      sourceMentionRefs: ["ev_a:m_a"],
      sourceEvidenceRefs: ["ev_a"],
    });
    const trip = makeTrip({
      evidences: { ev_a: makeEvidence("ev_a", "m_a", "情人桥") },
      guideSources: {
        s_a: makeSource("s_a", {
          evidenceRefs: ["ev_a", "ev_img6"],
          imageProgress: { total: 13, completed: 1, failed: 0, images: makeImages(13, [6]) },
        }),
      },
    });
    renderRow(trip, stop);

    expect(document.querySelector(".child-pic img")).toBeNull();
    expect(document.querySelector(".child-pic .ph-tile.ph-generic")).not.toBeNull();
  });

  it("命中飞猪（有 mainPic）：即使证据带页码也优先飞猪主图，不用原图替代", () => {
    const trip = makeTrip({
      items: { item_1: { ...makeItem("item_1", "西岛墙"), origin: "fliggy", providerId: "F1", mainPic: "https://img.example/wall.jpg" } },
      evidences: { ev_a: makePageEvidence("ev_a", [6]) },
      guideSources: { s_a: pageSource() },
    });
    renderRow(trip, makeStop("stop_1", "西岛墙", { matchedPointRef: "item_1", customName: null }));

    const img = document.querySelector(".child-pic img");
    expect(img?.getAttribute("src")).toBe("https://img.example/wall.jpg");
    expect(img?.getAttribute("title")).toBeNull();
  });

  // ===== Task #296：配图来源优先级（飞猪图优先，无飞猪图才用攻略 PX 图） =====

  it("Task #296 命中飞猪但飞猪无图：回退攻略 PX 原图（旧逻辑误落占位）", () => {
    const trip = makeTrip({
      items: { item_1: { ...makeItem("item_1", "西岛墙"), origin: "fliggy", providerId: "F1", mainPic: null } },
      evidences: { ev_a: makePageEvidence("ev_a", [6]) },
      guideSources: { s_a: pageSource() },
    });
    renderRow(
      trip,
      makeStop("stop_1", "西岛墙", {
        matchedPointRef: "item_1",
        customName: null,
        sourceMentionRefs: ["ev_a:m_a"],
        sourceEvidenceRefs: ["ev_a"],
      }),
    );

    const img = document.querySelector(".child-pic img");
    expect(img?.getAttribute("src")).toBe("/api/uploads/t196/img-06.jpg");
    expect(img?.getAttribute("title")).toBe("攻略原图（原文页码关联）");
    expect(document.querySelector(".child-pic .ph-tile")).toBeNull();
  });

  it("Task #296 飞猪外链加载失败：降级攻略 PX 原图（不直接占位、不留白）", () => {
    const trip = makeTrip({
      items: { item_1: { ...makeItem("item_1", "西岛墙"), origin: "fliggy", providerId: "F1", mainPic: "https://img.example/broken.jpg" } },
      evidences: { ev_a: makePageEvidence("ev_a", [6]) },
      guideSources: { s_a: pageSource() },
    });
    renderRow(
      trip,
      makeStop("stop_1", "西岛墙", {
        matchedPointRef: "item_1",
        customName: null,
        sourceMentionRefs: ["ev_a:m_a"],
        sourceEvidenceRefs: ["ev_a"],
      }),
    );

    fireEvent.error(document.querySelector(".child-pic img") as Element);

    const img = document.querySelector(".child-pic img");
    expect(img?.getAttribute("src")).toBe("/api/uploads/t196/img-06.jpg");
    expect(document.querySelector(".child-pic .ph-tile")).toBeNull();
  });

  it("Task #296 飞猪外链失败且 PX 图也失败：落统一占位（降级链终点）", () => {
    const trip = makeTrip({
      items: { item_1: { ...makeItem("item_1", "西岛墙"), origin: "fliggy", providerId: "F1", mainPic: "https://img.example/broken.jpg" } },
      evidences: { ev_a: makePageEvidence("ev_a", [6]) },
      guideSources: { s_a: pageSource() },
    });
    renderRow(
      trip,
      makeStop("stop_1", "西岛墙", {
        matchedPointRef: "item_1",
        customName: null,
        sourceMentionRefs: ["ev_a:m_a"],
        sourceEvidenceRefs: ["ev_a"],
      }),
    );

    fireEvent.error(document.querySelector(".child-pic img") as Element); // 飞猪外链失败
    fireEvent.error(document.querySelector(".child-pic img") as Element); // PX 图失败

    expect(document.querySelector(".child-pic img")).toBeNull();
    expect(document.querySelector(".child-pic .ph-tile")).not.toBeNull();
  });
});

// ===== Task #329：岛内玩法行的免费场所标签 =====

describe("StopRow 免费场所标签（任务 329）", () => {
  function freeStopItem(extra: Partial<Item> = {}): Item {
    return {
      ...makeItem("item_free", "国际免税城"),
      origin: "fliggy",
      providerId: "199649345",
      jumpUrl: "https://router.feizhu.com/multi/webview?url=dutyfree",
      ...extra,
    };
  }

  function renderFree(item: Item, stopOverrides: Partial<Stop> = {}) {
    const trip = makeTrip({ items: { item_free: item } });
    renderRow(
      trip,
      makeStop("stop_free", "国际免税城", {
        matchedPointRef: "item_free",
        customName: null,
        ...stopOverrides,
      }),
    );
  }

  it("FREE：渲染「免票」标签（沿用 .tag.slate 体系），且与「门票已含/需另购票」互斥共存不报错", () => {
    renderFree(freeStopItem({ freePoiStatus: "FREE" }));
    expect(document.querySelector(".child-time .tag.slate")?.textContent).toBe("免票");
    expect(document.querySelector(".child-time .tag.sage")).toBeNull();
    expect(document.querySelector(".child-time .tag.clay")).toBeNull();
  });

  it("FREE + ticketRelation=included：免票与「门票已含」同行共存（不另起一套标签体系）", () => {
    renderFree(freeStopItem({ freePoiStatus: "FREE" }), { ticketRelation: "included" });
    const tags = [...document.querySelectorAll(".child-time .tag")].map((tag) => tag.textContent);
    expect(tags).toEqual(["免票", "门票已含"]);
  });

  it("免票标签纳入时间行渲染条件：无时间文本且非 custom / ticketRelation=unknown 时仍渲染 .child-time", () => {
    const trip = makeTrip({ items: { item_free: freeStopItem({ freePoiStatus: "FREE" }) } });
    const stop = makeStop("stop_free", "国际免税城", {
      matchedPointRef: "item_free",
      customName: null,
      suggestMinutes: null, // timeLabel 为 null，否则无法隔离 freeAdmission 对 showTimeRow 的贡献
    });
    render(
      <StopRow
        trip={trip}
        stop={stop}
        index={0}
        total={1}
        timeRange={null}
        onMove={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(document.querySelector(".child-time")).not.toBeNull();
    expect(document.querySelector(".child-time-text")).toBeNull();
    expect(document.querySelector(".child-time .tag.slate")?.textContent).toBe("免票");

    // 反向对照：同一玩法但非免费（NOT_FREE）→ 三个条件全不成立，.child-time 不渲染
    cleanup();
    const paid = makeTrip({
      items: { item_free: freeStopItem({ freePoiStatus: "NOT_FREE" }) },
    });
    render(
      <StopRow
        trip={paid}
        stop={stop}
        index={0}
        total={1}
        timeRange={null}
        onMove={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(document.querySelector(".child-time")).toBeNull();
  });

  it("NOT_FREE / 非购物名存量无字段：不渲染免票标签（不制造回归）", () => {
    renderFree(freeStopItem({ freePoiStatus: "NOT_FREE", category: "购物中心" }));
    expect(screen.queryByText("免票")).toBeNull();

    cleanup();
    // Task #330 D：存量样例改用非购物名真实景点（蜈支洲岛）——名称通道接入后，购物名
    // 场所（国际免税城）即便缺 freePoiStatus 也会经名称兜底判免费（见下一断言），故隔离
    // 读时默认「不制造回归」需用非购物名。
    renderFree(freeStopItem({ name: "蜈支洲岛" })); // 存量形态：无 freePoiStatus 字段
    expect(screen.queryByText("免票")).toBeNull();

    cleanup();
    // Task #330 D 口径变更（PD 批准，与 #329 原断言相反）：存量购物名场所（国际免税城）
    // 缺 freePoiStatus 时经名称通道判免费，不再透出购票语义。
    renderFree(freeStopItem());
    expect(document.querySelector(".child-time .tag.slate")?.textContent).toBe("免票");
  });

  it("免费场所仍保留 jumpUrl 弱入口（.child-link 可跳详情，不失去跳转能力）", () => {
    renderFree(freeStopItem({ freePoiStatus: "FREE" }));
    const link = document.querySelector(".child-name a.child-link");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("https://router.feizhu.com/multi/webview?url=dutyfree");
    expect(link?.getAttribute("target")).toBe("_blank");
  });

  it("category 兜底：UNKNOWN + 购物类 category 同样出免票标签；UNKNOWN + 非购物（景点类 category + 非购物名）不出", () => {
    renderFree(freeStopItem({ freePoiStatus: "UNKNOWN", category: "购物中心" }));
    expect(document.querySelector(".child-time .tag.slate")?.textContent).toBe("免票");

    cleanup();
    // Task #330 D：隔离 category 通道需用非购物名（否则名称通道会先命中）：UNKNOWN +
    // 景点类 category + 非购物名 → 双通道均无信号 → 不出免票。
    renderFree(freeStopItem({ freePoiStatus: "UNKNOWN", category: "沙滩海岛", name: "蜈支洲岛" }));
    expect(screen.queryByText("免票")).toBeNull();
  });
});

// ===== Task #330：岛内玩法行的等级徽标与榜单行 =====

describe("StopRow 飞猪元信息展示（任务 330）", () => {
  function poiStopItem(extra: Partial<Item> = {}): Item {
    return {
      ...makeItem("item_poi", "西岛"),
      origin: "fliggy",
      providerId: "2611",
      ...extra,
    };
  }

  function renderPoi(item: Item, stopOverrides: Partial<Stop> = {}) {
    const trip = makeTrip({ items: { item_poi: item } });
    renderRow(
      trip,
      makeStop("stop_poi", "西岛", {
        matchedPointRef: "item_poi",
        customName: null,
        ...stopOverrides,
      }),
    );
  }

  /** 无推算时间区间（timeRange=null）：隔离 poiLevelLabel 对 showTimeRow 的贡献 */
  function renderPoiNoTime(item: Item, stopOverrides: Partial<Stop> = {}) {
    const trip = makeTrip({ items: { item_poi: item } });
    render(
      <StopRow
        trip={trip}
        stop={makeStop("stop_poi", "西岛", {
          matchedPointRef: "item_poi",
          customName: null,
          suggestMinutes: null,
          ...stopOverrides,
        })}
        index={0}
        total={1}
        timeRange={null}
        onMove={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
  }

  it("poiLevel=\"5\" 渲染 5A 徽标（.child-time 内 .tag.poi-level，与时间/自定义 tag 同排）", () => {
    renderPoi(poiStopItem({ poiLevel: "5" }));
    expect(document.querySelector(".child-time .tag.poi-level")?.textContent).toBe("5A");
    expect(screen.queryByText("5")).toBeNull();
  });

  it("poiLevel 无法识别（AAA）/ 缺失：不渲染徽标，也不因它而多出时间行", () => {
    renderPoiNoTime(poiStopItem({ poiLevel: "AAA" }));
    expect(document.querySelector(".child-time .poi-level")).toBeNull();
    cleanup();
    // 无时间文本 + 非 custom + ticketRelation=unknown + 无等级 → 时间行不渲染（徽标不凭空占位）
    renderPoiNoTime(poiStopItem());
    expect(document.querySelector(".child-time")).toBeNull();
  });

  it("poiLevel 存在但无时间文本：等级徽标仍撑起 .child-time 行（showTimeRow 纳入 poiLevelLabel）", () => {
    renderPoiNoTime(poiStopItem({ poiLevel: "4" }));
    expect(document.querySelector(".child-time")).not.toBeNull();
    expect(document.querySelector(".child-time-text")).toBeNull();
    expect(document.querySelector(".child-time .tag.poi-level")?.textContent).toBe("4A");
  });

  it("listRank 渲染名称下方 .poi-rank 暖色 chip（🏆 + 榜单文本）", () => {
    renderPoi(poiStopItem({ listRank: "海南4A/5A景点榜第2名" }));
    const chip = document.querySelector(".child-main .poi-rank");
    expect(chip).not.toBeNull();
    expect(chip?.querySelector(".poi-rank-icon")?.textContent).toBe("🏆");
    expect(chip?.querySelector(".poi-rank-text")?.textContent).toBe("海南4A/5A景点榜第2名");
  });

  it("listRank 缺失时完全不占位（无 .poi-rank、无 null 文本）", () => {
    renderPoi(poiStopItem());
    expect(document.querySelector(".poi-rank")).toBeNull();
    expect(screen.queryByText("null")).toBeNull();
  });
});

/**
 * Task #342：同实体相似亮点卡内合并为 1 条 chip + 诚实标注（仅展示层收敛）；
 * 攻略原文 sheet（EvidenceSheet）仍逐条全量展示，信息不丢。
 * 现场形态：过江龙索桥两条同提及改写（LCS 0.421 / 连续段「可走旁边」4 字）。
 * Task #352 处/篇规则：每篇恰好提及一次且 ≥2 篇 →「N篇攻略提及」；其余按
 * 总提及次数 →「N处攻略提及」；总提及 ≤1（含同一句原文的重复抽取并存对）不标注。
 */
describe("StopRow 相似亮点展示层聚类（Task #342）", () => {
  function snippetStop(refs: string[]): Stop {
    return makeStop("stop_bridge", "过江龙索桥", {
      sourceMentionRefs: refs,
      sourceEvidenceRefs: refs.map((r) => r.split(":")[0]),
      guideSnippets: [
        {
          snippetId: "gsn_a",
          text: "不想花钱排队可走旁边平行木栈道，景色差不多",
          claimKind: "tip",
          sourceMentionRefs: [refs[0]],
        },
        {
          snippetId: "gsn_b",
          text: "索桥20元排队久，可走旁边栈道免费绕过",
          claimKind: "tip",
          sourceMentionRefs: [refs[refs.length - 1]],
        },
      ],
    });
  }

  it("同一句原文的重复抽取两条：卡内仅 1 chip，总提及 1 次 → 不标注（#352）；点开原文 sheet 仍 2 条", () => {
    // 两条引用同一 mention（同篇攻略重复抽取）→ sourceCount=1、mentionCount=1
    const stop = snippetStop(["ev_a:m_x"]);
    stop.guideSnippets![1].sourceMentionRefs = ["ev_a:m_x"];
    const trip = makeTrip({
      stops: { stop_bridge: stop },
      evidences: { ev_a: makeEvidence("ev_a", "m_x", "过江龙索桥") },
      guideSources: { s_a: makeSource("s_a", { inputKind: "text", evidenceRefs: ["ev_a"] }) },
    });
    renderRow(trip, stop);

    const chips = [...document.querySelectorAll(".guide-snippet-chip")];
    expect(chips.length).toBe(1);
    // 代表取更长文本（gsn_a）；#352：同一句原文被重复抽取只计 1 次提及 → 不标注
    expect(chips[0]?.textContent).toContain("不想花钱排队可走旁边平行木栈道");
    expect(chips[0]?.querySelector(".guide-snippet-note")).toBeNull();

    // 原文 sheet 全量不变：点开后 2 条 evidence-snippet 都在
    fireEvent.click(chips[0] as Element);
    expect(screen.getByRole("dialog", { name: "攻略原文" })).toBeInTheDocument();
    const sheetSnippets = [...document.querySelectorAll(".evidence-snippet")];
    expect(sheetSnippets.length).toBe(2);
    expect(sheetSnippets.map((s) => s.textContent)).toEqual([
      "不想花钱排队可走旁边平行木栈道，景色差不多",
      "索桥20元排队久，可走旁边栈道免费绕过",
    ]);
  });

  it("跨两篇攻略各提及一次：卡内仅 1 chip + 「2篇攻略提及」（#352 无空格）", () => {
    // 两条引用不同证据、归属不同 guide source → sourceCount=2
    const stop = makeStop("stop_bridge", "过江龙索桥", {
      sourceMentionRefs: ["ev_a:m_a", "ev_b:m_b"],
      sourceEvidenceRefs: ["ev_a", "ev_b"],
      guideSnippets: [
        {
          snippetId: "gsn_a",
          text: "不想花钱排队可走旁边平行木栈道，景色差不多",
          claimKind: "tip",
          sourceMentionRefs: ["ev_a:m_a"],
        },
        {
          snippetId: "gsn_b",
          text: "索桥20元排队久，可走旁边栈道免费绕过",
          claimKind: "tip",
          sourceMentionRefs: ["ev_b:m_b"],
        },
      ],
    });
    const trip = makeTrip({
      stops: { stop_bridge: stop },
      evidences: {
        ev_a: makeEvidence("ev_a", "m_a", "过江龙索桥"),
        ev_b: makeEvidence("ev_b", "m_b", "过江龙索桥"),
      },
      guideSources: {
        s_a: makeSource("s_a", { inputKind: "text", evidenceRefs: ["ev_a"] }),
        s_b: makeSource("s_b", { inputKind: "text", evidenceRefs: ["ev_b"] }),
      },
    });
    renderRow(trip, stop);

    const chips = [...document.querySelectorAll(".guide-snippet-chip")];
    expect(chips.length).toBe(1);
    expect(chips[0]?.querySelector(".guide-snippet-note")?.textContent).toBe("（2篇攻略提及）");
  });

  it("单篇攻略两处不同提及：卡内仅 1 chip + 「2处攻略提及」（#352 单篇多处一律处）", () => {
    // 两条引用组合完全相同但含同篇攻略的两处不同提及 → sourceCount=1、mentionCount=2
    const stop = snippetStop(["ev_a:m_x", "ev_a:m_y"]);
    stop.guideSnippets![0].sourceMentionRefs = ["ev_a:m_x", "ev_a:m_y"];
    stop.guideSnippets![1].sourceMentionRefs = ["ev_a:m_x", "ev_a:m_y"];
    const trip = makeTrip({
      stops: { stop_bridge: stop },
      evidences: {
        ev_a: {
          ...makeEvidence("ev_a", "m_x", "过江龙索桥"),
          mentions: [
            ...makeEvidence("ev_a", "m_x", "过江龙索桥").mentions,
            ...makeEvidence("ev_a", "m_y", "过江龙索桥").mentions,
          ],
        },
      },
      guideSources: { s_a: makeSource("s_a", { inputKind: "text", evidenceRefs: ["ev_a"] }) },
    });
    renderRow(trip, stop);

    const chips = [...document.querySelectorAll(".guide-snippet-chip")];
    expect(chips.length).toBe(1);
    expect(chips[0]?.querySelector(".guide-snippet-note")?.textContent).toBe("（2处攻略提及）");
  });

  it("不相似的两条：卡内仍 2 chip，均无标注（N=1 不标注）", () => {
    const stop = makeStop("stop_x", "亚龙湾", {
      sourceMentionRefs: ["ev_a:m_a"],
      sourceEvidenceRefs: ["ev_a"],
      guideSnippets: [
        { snippetId: "gsn_p", text: "优先早上9-10点上山，下午容易起雾", claimKind: "tip", sourceMentionRefs: ["ev_a:m_a"] },
        { snippetId: "gsn_q", text: "观光车必买，盘山陡坡步行又远又危险", claimKind: "risk", sourceMentionRefs: ["ev_a:m_a"] },
      ],
    });
    const trip = makeTrip({
      stops: { stop_x: stop },
      evidences: { ev_a: makeEvidence("ev_a", "m_a", "亚龙湾") },
      guideSources: { s_a: makeSource("s_a", { inputKind: "text", evidenceRefs: ["ev_a"] }) },
    });
    renderRow(trip, stop);

    const chips = [...document.querySelectorAll(".guide-snippet-chip")];
    expect(chips.length).toBe(2);
    expect(document.querySelector(".guide-snippet-note")).toBeNull();
  });
});
