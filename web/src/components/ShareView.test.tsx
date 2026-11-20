import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  Day,
  HotelCandidate,
  Item,
  LodgingPlan,
  SharedTrip,
  Stop,
  Visit,
} from "@goplay/shared";
import {
  AI_SUPPLEMENT_CHIP_LABEL,
  AI_SUPPLEMENT_CHIP_LABEL_COMPACT,
  AI_SUPPLEMENT_VERIFY_NOTE,
} from "@goplay/shared";
import { ApiError, loadShareTrip, patchShareStatus } from "../api/client";
import ShareView from "./ShareView";

// 只替换分享读/写网络调用；ApiError 保持真实实现（404 分支依赖 instanceof）
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  loadShareTrip: vi.fn(),
  patchShareStatus: vi.fn(),
}));

const loadShareTripMock = vi.mocked(loadShareTrip);
const patchShareStatusMock = vi.mocked(patchShareStatus);
const TRIP_ID = "11111111-1111-4111-8111-111111111111";

/**
 * 读取 styles.css 源文本供样式契约断言（jsdom 无布局），兼容 vitest 从 web 包或仓库根运行。
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

function makeDay(overrides: Partial<Day> & Pick<Day, "dayId" | "dayIndex" | "date">): Day {
  return {
    departTime: null,
    departTimeOverridden: false,
    scheduleVisitRefs: [],
    lodging: null,
    ...overrides,
  };
}

function makeVisit(overrides: Partial<Visit> & Pick<Visit, "visitId" | "pointRef">): Visit {
  return {
    dayRef: "day_1",
    kind: "ordinary",
    visitMode: "custom",
    order: 0,
    windowStart: null,
    windowEnd: null,
    startTime: null,
    endTime: null,
    startTimeOverridden: false,
    endTimeOverridden: false,
    reservedMinutes: null,
    effectiveMinutes: null,
    externalLeg: null,
    childStopRefs: [],
    alternateStopRefs: [],
    purchaseState: "unknown",
    locked: false,
    userAdjusted: false,
    removedFrom: null,
    removedAt: null,
    ...overrides,
  };
}

function makeStop(overrides: Partial<Stop> & Pick<Stop, "stopId" | "visitRef">): Stop {
  return {
    state: "attached",
    suggestedVisitRef: null,
    matchedPointRef: null,
    customName: "未命名玩法",
    order: 0,
    suggestMinutes: null,
    locationHint: null,
    ticketRelation: "unknown",
    sourceEvidenceRefs: [],
    sourceMentionRefs: [],
    userAdjusted: false,
    removedFromOrder: null,
    removedAt: null,
    ...overrides,
  };
}

function makeItem(overrides: Partial<Item> & Pick<Item, "itemId" | "name">): Item {
  return {
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
    ...overrides,
  };
}

function makeLodging(overrides: Partial<LodgingPlan> & Pick<LodgingPlan, "dayIndex">): LodgingPlan {
  return {
    areaName: null,
    hotelRefs: [],
    purchaseState: "unknown",
    locked: false,
    userAdjusted: false,
    ...overrides,
  };
}

function makeHotel(overrides: Partial<HotelCandidate> & Pick<HotelCandidate, "id" | "name">): HotelCandidate {
  return {
    shId: overrides.id,
    brandName: null,
    star: null,
    priceText: null,
    priceBasis: "价格与库存以飞猪详情页为准",
    address: null,
    interestsPoi: null,
    decorationTime: null,
    coords: null,
    mainPic: null,
    detailUrl: null,
    rate: null,
    ...overrides,
  };
}

/** 与 sanitizeTrip 输出形态一致的最小 SharedTrip（无证据 / 无候选池） */
function makeSharedTrip(overrides: Partial<SharedTrip> = {}): SharedTrip {
  return {
    tripId: TRIP_ID,
    schemaVersion: 2,
    version: 3,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: "2026-11-10", nights: 1 },
    dayRefs: ["day_1", "day_2"],
    days: {
      day_1: makeDay({
        dayId: "day_1",
        dayIndex: 1,
        date: "2026-11-08",
        departTime: "08:30",
        scheduleVisitRefs: ["visit_wzz", "visit_market"],
        lodging: { kind: "lodging", dayIndex: 1 },
      }),
      day_2: makeDay({
        dayId: "day_2",
        dayIndex: 2,
        date: "2026-11-09",
        scheduleVisitRefs: ["visit_houhai"],
      }),
    },
    lodgings: {
      "1": makeLodging({ dayIndex: 1, areaName: "海棠湾", hotelRefs: ["hotel_1"], purchaseState: "bought" }),
    },
    itemRegistry: {
      item_wzz: makeItem({
        itemId: "item_wzz",
        name: "蜈支洲岛",
        address: "海南省三亚市海棠区蜈支洲岛",
        category: "海岛",
        suggestMinutes: 180,
      }),
      item_market: makeItem({ itemId: "item_market", name: "第一市场" }),
      item_houhai: makeItem({ itemId: "item_houhai", name: "后海村" }),
      item_qingren: makeItem({ itemId: "item_qingren", name: "情人桥" }),
    },
    hotelRegistry: {
      hotel_1: makeHotel({ id: "hotel_1", name: "海棠湾某度假酒店", priceText: "¥880", star: "五星级" }),
    },
    visits: {
      visit_wzz: makeVisit({
        visitId: "visit_wzz",
        pointRef: "item_wzz",
        kind: "large_attraction",
        visitMode: "full_day",
        startTime: "09:00",
        endTime: "12:00",
        effectiveMinutes: 180,
        childStopRefs: ["stop_bridge"],
        purchaseState: "bought",
        guideSnippets: [
          {
            snippetId: "sn_1",
            text: "早上第一班船上岛，人少不排队",
            claimKind: "tip",
            sourceMentionRefs: [],
          },
        ],
      }),
      visit_market: makeVisit({
        visitId: "visit_market",
        pointRef: "item_market",
        order: 1,
        effectiveMinutes: 90,
      }),
      visit_houhai: makeVisit({
        visitId: "visit_houhai",
        pointRef: "item_houhai",
        dayRef: "day_2",
        effectiveMinutes: 60,
      }),
    },
    stops: {
      stop_bridge: makeStop({
        stopId: "stop_bridge",
        visitRef: "visit_wzz",
        matchedPointRef: "item_qingren",
        customName: null,
        suggestMinutes: 20,
        locationHint: "入口左转",
      }),
    },
    constraints: [],
    createdAt: "2026-11-01T02:00:00.000Z",
    updatedAt: "2026-11-02T06:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  loadShareTripMock.mockReset();
  patchShareStatusMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("ShareView 只读分享页（Task #205）", () => {
  it("渲染目的地、天数、更新时间与底部来源，并按 tripId 请求脱敏数据", async () => {
    loadShareTripMock.mockResolvedValue(makeSharedTrip());

    render(<ShareView tripId={TRIP_ID} />);

    // Task #258：顶部紧凑入口（封面行）即就绪信号；未命名时回退为「{城市}行程」
    const bar = await screen.findByRole("button", { name: /行程封面：三亚行程/ });
    expect(loadShareTripMock).toHaveBeenCalledWith(TRIP_ID);
    // 入口只保留城市 · 天数（日期区间已按天展示在 Day 标签上）
    expect(bar).toHaveTextContent("三亚 · 2天1晚");
    // 无封面内容 → 不自动弹浮层，直接看行程
    expect(screen.queryByRole("dialog", { name: "行程封面" })).toBeNull();
    expect(screen.getByText("朋友分享的行程 · 只能标记购票 / 订房状态")).toBeInTheDocument();
    // 更新时间按本地时区格式化，只校验形状（跨时区断言不脆）
    expect(screen.getAllByText(/最后更新 \d{2}\/\d{2} \d{2}:\d{2}/)).toHaveLength(2);
    expect(screen.getByText("由 GoPlay 生成")).toBeInTheDocument();
  });

  it("景点卡展示名称、地址、内部玩法与攻略亮点；估算时间/时长不展示（Task #340 开关关闭）", async () => {
    loadShareTripMock.mockResolvedValue(makeSharedTrip());

    const { container } = render(<ShareView tripId={TRIP_ID} />);
    await screen.findByRole("button", { name: /行程封面：/ });

    expect(screen.getByRole("heading", { name: "蜈支洲岛" })).toBeInTheDocument();
    expect(screen.getByText("海南省三亚市海棠区蜈支洲岛")).toBeInTheDocument();
    // Task #340：原断言 getByText("09:00 – 12:00") / getByText("建议 3h") / getByText("20min")
    // 改为开关关闭口径：时间窗、建议时长、内部玩法时长均为 AI 推导不渲染
    //（开关打开时的恢复断言见 ShareView.flagOn.test.tsx）
    expect(screen.queryByText("09:00 – 12:00")).not.toBeInTheDocument();
    expect(screen.queryByText("建议 3h")).not.toBeInTheDocument();
    expect(screen.queryByText("20min")).not.toBeInTheDocument();
    expect(container.querySelector(".share-meta")).toBeNull();
    expect(container.querySelector(".share-stop-dur")).toBeNull();
    // DOM 全文不得出现任何 HH:MM–HH:MM 区间（更新时间戳除外，它是事实非估算）
    const textNoStamp = (container.textContent ?? "").replace(/最后更新 \d{2}\/\d{2} \d{2}:\d{2}/g, "");
    expect(textNoStamp).not.toMatch(/\d{1,2}:\d{2}\s*[–-]\s*\d{1,2}:\d{2}/);
    // Task #344：原断言 getByText("全天")——PD「每个大景区都标了『全天』…把『全天』二字去掉」，
    // 改为断言不渲染；同用例其余徽标断言（「已购票」等）原样保留，不静默放宽。
    // 取值保留与 Day 条 / 徽标形态的正向断言见下一条用例。
    expect(screen.queryByText("全天")).not.toBeInTheDocument();
    expect(screen.getByText("已购票")).toBeInTheDocument();
    // 内部玩法：编号 / 名称 / 位置提示（时长被 Task #340 gate）
    expect(screen.getByText("情人桥")).toBeInTheDocument();
    expect(screen.getByText("入口左转")).toBeInTheDocument();
    // 攻略亮点只展示文本，不携带来源
    expect(screen.getByText("攻略亮点")).toBeInTheDocument();
    expect(screen.getByText("早上第一班船上岛，人少不排队")).toBeInTheDocument();
    expect(container.textContent).not.toContain("ev_note");

    // 住宿卡：酒店名 / 价格 / 区域 / 已订房（状态胶囊文案）
    expect(screen.getByRole("heading", { name: "海棠湾某度假酒店" })).toBeInTheDocument();
    expect(screen.getByText("海棠湾 · ¥880 · 五星级")).toBeInTheDocument();
    expect(screen.getByText("已订房")).toBeInTheDocument();
  });

  /**
   * Task #344（PD：「每个大景区都标了『全天』在景区名字下面的标、以及 DAY N 里都有，
   * 把『全天』二字去掉」）：分享页两处同形态落点——
   * ① Day 切换条 .dchip .flag（原「名称 · 全天」）；② 父卡 .share-badge（原「全天」）。
   * 仅展示层去字：「半天」「自定义」两个取值必须原样保留（证明没误伤）。
   */
  describe("大景区 mode 标签去掉「全天」（Task #344）", () => {
    /** 只改 visit_wzz 的 visitMode，其余夹具沿用 makeSharedTrip */
    function tripWithMode(visitMode: Visit["visitMode"]): SharedTrip {
      const base = makeSharedTrip();
      return {
        ...base,
        visits: { ...base.visits, visit_wzz: { ...base.visits.visit_wzz, visitMode } },
      };
    }

    async function renderMode(visitMode: Visit["visitMode"]) {
      loadShareTripMock.mockResolvedValue(tripWithMode(visitMode));
      const { container } = render(<ShareView tripId={TRIP_ID} />);
      await screen.findByRole("button", { name: /行程封面：/ });
      return container;
    }

    it("full_day：Day 条只剩景区名（无悬空「· 」），大景区徽标整块不渲染", async () => {
      const container = await renderMode("full_day");

      const flag = container.querySelector(".dchip .flag");
      expect(flag?.textContent).toBe("蜈支洲岛");
      // 去掉「全天」后不得留下悬空分隔符（原形态为「蜈支洲岛 · 全天」）
      expect(flag?.textContent).not.toContain("·");
      expect(container.textContent).not.toContain("全天");
      // mode 段为空时不留空白徽标占位
      const largeCard = container.querySelector(".share-card.is-large");
      expect(largeCard).not.toBeNull();
      expect(largeCard?.querySelector(".share-badge")).toBeNull();
    });

    it("half_day 保留：Day 条为「名称 · 半天」、徽标为「半天」（只去掉「全天」一个取值）", async () => {
      const container = await renderMode("half_day");

      expect(container.querySelector(".dchip .flag")?.textContent).toBe("蜈支洲岛 · 半天");
      expect(container.querySelector(".share-card.is-large .share-badge")?.textContent).toBe("半天");
      expect(container.textContent).not.toContain("全天");
    });

    it("custom 保留：Day 条为「名称 · 自定义」、徽标为「自定义」", async () => {
      const container = await renderMode("custom");

      expect(container.querySelector(".dchip .flag")?.textContent).toBe("蜈支洲岛 · 自定义");
      expect(container.querySelector(".share-card.is-large .share-badge")?.textContent).toBe("自定义");
    });

    it("普通景点卡不受影响：Day 条仍显示处数，无 mode 徽标", async () => {
      const container = await renderMode("full_day");

      // day_2 只有 visit_houhai（ordinary）→ 短标签为「1 处」
      const flags = [...container.querySelectorAll(".dchip .flag")].map((el) => el.textContent ?? "");
      expect(flags).toContain("1 处");
      const ordinaryCard = [...container.querySelectorAll(".share-card")].find(
        (el) => !el.className.includes("is-large"),
      );
      expect(ordinaryCard?.querySelector(".share-badge")).toBeNull();
    });
  });

  it("除封面入口、切天与状态标记外，没有任何其他可编辑控件", async () => {
    loadShareTripMock.mockResolvedValue(makeSharedTrip());

    const { container } = render(<ShareView tripId={TRIP_ID} />);
    await screen.findByRole("button", { name: /行程封面：/ });

    // 封面入口 + 两个 Day 标签始终存在
    expect(screen.getByRole("button", { name: /行程封面：/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Day1/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Day2/ })).toBeInTheDocument();
    // Task #260：只有「状态标记」新增了交互（门票 / 订房），仍是 pill 按钮，不是输入框
    const statusPills = screen.getAllByRole("button", { name: /状态：.*点击修改/ });
    expect(statusPills).toHaveLength(3);
    for (const pill of statusPills) expect(pill).toHaveAttribute("aria-haspopup", "listbox");
    // 没有任何自由输入控件；也没有编辑 / 拖拽 / 锁定类入口
    expect(container.querySelectorAll("input, textarea, select, [contenteditable]")).toHaveLength(0);
    expect(screen.queryByText(/编辑|拖拽|锁定/)).not.toBeInTheDocument();
  });

  it("切换 Day 后只展示当天内容，未安排住宿时给出提示", async () => {
    loadShareTripMock.mockResolvedValue(makeSharedTrip());

    render(<ShareView tripId={TRIP_ID} />);
    await screen.findByRole("button", { name: /行程封面：/ });
    expect(screen.getByRole("heading", { name: "蜈支洲岛" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Day2/ }));

    expect(screen.getByRole("heading", { name: "后海村" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "蜈支洲岛" })).not.toBeInTheDocument();
    // Task #340：原断言 getByText("时间待定")——时间窗整段被估算时间开关 gate（含无时间时的
    // 占位文案），开关关闭后 .share-meta 不渲染（恢复断言见 displayFlags.flagOn.test.tsx）
    expect(screen.queryByText("时间待定")).not.toBeInTheDocument();
    expect(screen.getByText("当晚无住宿安排")).toBeInTheDocument();
  });

  it("tripId 不存在（404）时显示链接已失效，不显示重试", async () => {
    loadShareTripMock.mockRejectedValue(new ApiError(404, "TRIP_NOT_FOUND", "行程不存在"));

    render(<ShareView tripId="22222222-2222-4222-8222-222222222222" />);

    expect(await screen.findByText("链接已失效")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("请让分享的朋友重新发一次");
    expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
  });

  it("加载失败可重试，成功后进入只读视图", async () => {
    loadShareTripMock
      .mockRejectedValueOnce(new ApiError(500, "INTERNAL", "分享的行程读取失败，请稍后重试"))
      .mockResolvedValueOnce(makeSharedTrip());

    render(<ShareView tripId={TRIP_ID} />);

    expect(await screen.findByText("暂时打不开")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByRole("button", { name: /行程封面：三亚行程/ })).toBeInTheDocument();
    expect(loadShareTripMock).toHaveBeenCalledTimes(2);
  });
});

// ===== Task #258：分享页封面浮层（有内容时首屏自动展示，只读无编辑入口） =====

describe("ShareView 封面浮层（Task #258）", () => {
  const COVERED = {
    tripName: "三亚亲子五日",
    memo: "记得带身份证和泳衣",
    coverImage: "uploads/trip-c/cover.jpg",
  } as const;

  it("有封面内容时首次打开自动展示只读浮层：封面图 / 名称 / 日期信息 / 备忘全可见", async () => {
    loadShareTripMock.mockResolvedValue(makeSharedTrip(COVERED));

    render(<ShareView tripId={TRIP_ID} />);

    // 首屏即浮层（无需点入口）
    const dialog = await screen.findByRole("dialog", { name: "行程封面" });
    expect(within(dialog).getByText("朋友分享的行程 · 只读展示")).toBeInTheDocument();
    // 名称（只读用标题展示，不是输入框）
    expect(within(dialog).getByRole("heading", { level: 1, name: "三亚亲子五日" })).toBeInTheDocument();
    // 日期信息行：城市 · N天N晚 · 起止日期
    expect(within(dialog).getByText("三亚 · 2天1晚 · 11/08-11/09")).toBeInTheDocument();
    // 备忘全文（浮层内默认展开）
    expect(within(dialog).getByText("备忘")).toBeInTheDocument();
    expect(within(dialog).getByText("记得带身份证和泳衣")).toBeInTheDocument();
    // 封面图走受控路径并带版本号
    const img = within(dialog).getByAltText("三亚亲子五日");
    expect(img.getAttribute("src")).toBe("/api/uploads/trip-c/cover.jpg?v=3");

    // 只读：没有任何编辑控件与编辑入口
    expect(dialog.querySelectorAll("input, textarea, select, [contenteditable]")).toHaveLength(0);
    expect(within(dialog).queryByText(/添加封面|更换封面|移除封面/)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "完成" })).not.toBeInTheDocument();
    expect(within(dialog).queryByText("行程名称与备忘会自动保存")).not.toBeInTheDocument();
  });

  it("关闭浮层后进入行程（Day 标签与内容可见），点紧凑入口可再次打开", async () => {
    loadShareTripMock.mockResolvedValue(makeSharedTrip(COVERED));

    render(<ShareView tripId={TRIP_ID} />);
    const dialog = await screen.findByRole("dialog", { name: "行程封面" });

    fireEvent.click(within(dialog).getByRole("button", { name: "关闭封面" }));

    expect(screen.queryByRole("dialog", { name: "行程封面" })).toBeNull();
    // 行程本身始终在 DOM 里，关闭后就能看到当天内容
    expect(screen.getByRole("button", { name: /Day1/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "蜈支洲岛" })).toBeInTheDocument();

    // 已手动关闭 → 不会再次自动弹出；点入口才重新打开
    const bar = screen.getByRole("button", { name: /行程封面：三亚亲子五日/ });
    expect(bar).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(bar);
    expect(screen.getByRole("dialog", { name: "行程封面" })).toBeInTheDocument();
  });

  it("只有行程名（无封面图 / 无备忘）时不自动弹浮层，名称由紧凑入口常驻展示", async () => {
    loadShareTripMock.mockResolvedValue(makeSharedTrip({ tripName: "三亚亲子五日" }));

    render(<ShareView tripId={TRIP_ID} />);

    const bar = await screen.findByRole("button", { name: /行程封面：三亚亲子五日/ });
    expect(bar).toHaveTextContent("三亚亲子五日");
    expect(screen.queryByRole("dialog", { name: "行程封面" })).toBeNull();
    // 没有备忘 → 入口不出「备忘」标记
    expect(screen.queryByText("备忘")).not.toBeInTheDocument();
  });

  // Task #264：jsdom 无真实布局，浮层高度 / 封面图裁切这类「布局事实」只能对样式源断言。
  // 回归点：`.share-sheet-layer` 若用 inset: 0，高度取的是 iOS Safari 的「大视口」，
  // 地址栏展开时浮层底部落到可视区之外，封面图与备忘被底栏裁掉。
  it("样式契约：浮层高绑视觉视口（--app-height），封面图不裁切且底部留安全区", () => {
    const css = readStylesCss();
    const layer = cssRuleBody(css, ".share-sheet-layer");
    expect(layer).toContain("height: var(--app-height, 100dvh)");
    expect(layer).not.toMatch(/inset:\s*0/);
    expect(layer).toContain("position: fixed");

    // 只读浮层最大高度按这层高度取百分比，不再被大视口撑高
    const sheet = cssRuleBody(css, ".share-sheet-layer .trip-cover-sheet");
    expect(sheet).toContain("max-height: 88%");
    expect(sheet).toContain("env(safe-area-inset-bottom");
    expect(sheet).toContain("overscroll-behavior: contain");

    // 封面图完整展示：只读态取消 clamp 限高（16:9 原比例），编辑态仍保留
    const media = cssRuleBody(css, ".share-sheet-layer .trip-cover-media");
    expect(media).toContain("max-height: none");
    expect(cssRuleBody(css, ".trip-cover-media")).toContain("max-height: clamp(");

    // Task #377：#264 只锁了盒子 max-height，却漏锁 object-fit —— 主图仍是 cover，
    // 非 16:9 源图上下被裁（竖图最多 68%）却从未被断言发现。此处补齐真正的「不裁切」契约：
    // 主图必须 contain（完整可见），并保留同图模糊层填充留白。
    expect(cssRuleBody(css, ".trip-cover-img")).toContain("object-fit: contain");
    expect(cssRuleBody(css, ".trip-cover-img")).not.toContain("object-fit: cover");
    expect(cssRuleBody(css, ".trip-cover-blur")).toContain("object-fit: cover");
    expect(cssRuleBody(css, ".trip-cover-blur")).toContain("blur(");
  });
});

// ===== Task #260：分享页受限状态打标（只能改 purchaseState） =====

describe("ShareView 状态打标（Task #260）", () => {
  it("景点：展开选项、乐观更新，并只提交该 visitId 的 purchaseState", async () => {
    const base = makeSharedTrip();
    loadShareTripMock.mockResolvedValue(base);
    const pending: { resolve?: (trip: SharedTrip) => void } = {};
    patchShareStatusMock.mockImplementation(
      () =>
        new Promise<SharedTrip>((resolve) => {
          pending.resolve = resolve;
        }),
    );

    render(<ShareView tripId={TRIP_ID} />);
    const trigger = await screen.findByRole("button", { name: "门票状态：已购票，点击修改" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const listbox = screen.getByRole("listbox", { name: "选择门票状态" });
    // 四态全在，当前项高亮
    expect(within(listbox).getAllByRole("option")).toHaveLength(4);
    expect(within(listbox).getByRole("option", { name: /已购票/ })).toHaveAttribute("aria-selected", "true");
    expect(within(listbox).getByRole("option", { name: "无需购票" })).toHaveAttribute("aria-selected", "false");

    fireEvent.click(within(listbox).getByRole("option", { name: "无需购票" }));

    // 乐观更新：胶囊立即换成新状态，选项收起，且只发一条针对该景点的补丁
    expect(screen.getByRole("button", { name: "门票状态：无需购票，点击修改" })).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(patchShareStatusMock).toHaveBeenCalledTimes(1);
    expect(patchShareStatusMock).toHaveBeenCalledWith(TRIP_ID, {
      visits: [{ visitId: "visit_wzz", purchaseState: "noTicket" }],
    });

    // 服务端返回后不回滚、不弹失败提示
    pending.resolve?.({ ...base, version: 9, updatedAt: "2026-11-03T00:00:00.000Z" });
    await waitFor(() => expect(screen.queryByText(/未能保存/)).toBeNull());
    expect(screen.getByRole("button", { name: "门票状态：无需购票，点击修改" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "订房状态：已订房，点击修改" })).toBeInTheDocument();
  });

  it("保存失败时回滚到原状态并弹提示", async () => {
    loadShareTripMock.mockResolvedValue(makeSharedTrip());
    patchShareStatusMock.mockRejectedValue(new ApiError(500, "INTERNAL", "状态保存失败，请稍后重试"));

    render(<ShareView tripId={TRIP_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "门票状态：未定，点击修改" }));
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "选择门票状态" })).getByRole("option", { name: "待购" }),
    );

    // 乐观更新先行
    expect(screen.getByRole("button", { name: "门票状态：待购，点击修改" })).toBeInTheDocument();
    expect(patchShareStatusMock).toHaveBeenCalledWith(TRIP_ID, {
      visits: [{ visitId: "visit_market", purchaseState: "toBuy" }],
    });

    // 失败：回滚到原状态 + 底部提示
    const toast = await screen.findByRole("status");
    expect(toast).toHaveTextContent("门票状态未能保存，已恢复原状态");
    expect(screen.getByRole("button", { name: "门票状态：未定，点击修改" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "门票状态：待购，点击修改" })).toBeNull();
  });

  it("住宿：三态选项（无免票档），选中后只提交 dayIndex + purchaseState", async () => {
    loadShareTripMock.mockResolvedValue(makeSharedTrip());
    const pending: { resolve?: (trip: SharedTrip) => void } = {};
    patchShareStatusMock.mockImplementation(
      () =>
        new Promise<SharedTrip>((resolve) => {
          pending.resolve = resolve;
        }),
    );

    render(<ShareView tripId={TRIP_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "订房状态：已订房，点击修改" }));
    const listbox = screen.getByRole("listbox", { name: "选择订房状态" });
    expect(within(listbox).getAllByRole("option")).toHaveLength(3);
    expect(within(listbox).queryByRole("option", { name: "无需购票" })).toBeNull();

    fireEvent.click(within(listbox).getByRole("option", { name: "待订" }));

    expect(screen.getByRole("button", { name: "订房状态：待订，点击修改" })).toBeInTheDocument();
    expect(patchShareStatusMock).toHaveBeenCalledWith(TRIP_ID, {
      lodgings: [{ dayIndex: 1, purchaseState: "toBuy" }],
    });

    pending.resolve?.(makeSharedTrip());
    await waitFor(() => expect(screen.queryByText(/未能保存/)).toBeNull());
    expect(screen.getByRole("button", { name: "订房状态：待订，点击修改" })).toBeInTheDocument();
  });

  it("重复选中当前状态不发起请求", async () => {
    loadShareTripMock.mockResolvedValue(makeSharedTrip());

    render(<ShareView tripId={TRIP_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "门票状态：已购票，点击修改" }));
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "选择门票状态" })).getByRole("option", { name: /已购票/ }),
    );

    expect(patchShareStatusMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("button", { name: "门票状态：已购票，点击修改" })).toBeInTheDocument();
  });
});

// ===== Task #283 / C4：分享页 AI 补充·飞猪核验标（展示范围含分享页） =====

describe("ShareView AI 补充·飞猪核验标（Task #283 / C4）", () => {
  /** 把 first-market 项改为真实飞猪 POI 补充项（脱敏 sanitizeItem 用 spread 保留 provenance） */
  function supplementTrip(): SharedTrip {
    const base = makeSharedTrip();
    const market = base.itemRegistry.item_market;
    return {
      ...base,
      itemRegistry: {
        ...base.itemRegistry,
        item_market: { ...market, origin: "fliggy", providerId: "F777", provenance: "ai_supplement" },
      },
    };
  }

  it("分享页展示补充项全标 chip「AI 补充·飞猪核验」（与主行程卡同源常量）", async () => {
    loadShareTripMock.mockResolvedValue(supplementTrip());

    render(<ShareView tripId={TRIP_ID} />);
    await screen.findByRole("button", { name: /行程封面：/ });

    const chip = document.querySelector(".share-badge.ai-supplement-chip");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe(AI_SUPPLEMENT_CHIP_LABEL);
    expect(chip?.querySelector(".chip-verify")?.textContent).toBe(
      AI_SUPPLEMENT_CHIP_LABEL.slice(AI_SUPPLEMENT_CHIP_LABEL_COMPACT.length),
    );
    expect(chip?.getAttribute("title")).toBe(AI_SUPPLEMENT_VERIFY_NOTE);
    // 只有补充项带 chip，其余默认 guide 项不带
    expect(document.querySelectorAll(".share-badge.ai-supplement-chip")).toHaveLength(1);
  });

  it("无补充项（全部默认 guide）时分享页不渲染 AI 补充 chip", async () => {
    loadShareTripMock.mockResolvedValue(makeSharedTrip());

    render(<ShareView tripId={TRIP_ID} />);
    await screen.findByRole("button", { name: /行程封面：/ });

    expect(document.querySelector(".ai-supplement-chip")).toBeNull();
    expect(screen.queryByText(AI_SUPPLEMENT_CHIP_LABEL)).toBeNull();
  });
});

// ===== Task #348（PD 2026-11-04）：分享页父卡形态由岛内子玩法驱动（三态）=====
describe("ShareView 父卡形态由岛内子玩法驱动（Task #348 三态）", () => {
  /** 三态同页：鹿回头（large+0子）/ 西岛（large+1子）/ 第一市场（ordinary+0子） */
  function threeStateTrip(): SharedTrip {
    const base = makeSharedTrip();
    return {
      ...base,
      dayRefs: ["day_1"],
      days: {
        day_1: makeDay({
          dayId: "day_1",
          dayIndex: 1,
          date: "2026-11-08",
          scheduleVisitRefs: ["visit_lh", "visit_xidao", "visit_market"],
        }),
      },
      itemRegistry: {
        ...base.itemRegistry,
        item_lh: makeItem({ itemId: "item_lh", name: "鹿回头", category: "山景" }),
        item_xidao: makeItem({ itemId: "item_xidao", name: "西岛", category: "海岛" }),
      },
      visits: {
        visit_lh: makeVisit({
          visitId: "visit_lh",
          pointRef: "item_lh",
          kind: "large_attraction",
          visitMode: "half_day",
          childStopRefs: [],
          guideSnippets: [
            { snippetId: "lh_1", text: "鹿回头日落时分俯瞰三亚湾最佳", claimKind: "tip", sourceMentionRefs: [] },
            { snippetId: "lh_2", text: "山顶咖啡馆可久坐看夜景", claimKind: "experience", sourceMentionRefs: [] },
          ],
        }),
        visit_xidao: makeVisit({
          visitId: "visit_xidao",
          pointRef: "item_xidao",
          kind: "large_attraction",
          visitMode: "full_day",
          childStopRefs: ["stop_niuwang"],
        }),
        visit_market: makeVisit({
          visitId: "visit_market",
          pointRef: "item_market",
          kind: "ordinary",
          childStopRefs: [],
        }),
      },
      stops: {
        stop_niuwang: makeStop({ stopId: "stop_niuwang", visitRef: "visit_xidao", customName: "牛王岭" }),
      },
    };
  }

  function cardOf(container: HTMLElement, name: string): Element | undefined {
    return [...container.querySelectorAll(".share-card")].find(
      (el) => el.querySelector(".share-card-name")?.textContent === name,
    );
  }

  async function renderThreeState() {
    loadShareTripMock.mockResolvedValue(threeStateTrip());
    const { container } = render(<ShareView tripId={TRIP_ID} />);
    await screen.findByRole("button", { name: /行程封面：/ });
    return container;
  }

  it("large+0子（鹿回头）→ 普通卡形态：无 is-large、无内部玩法列表，攻略亮点正常渲染", async () => {
    const container = await renderThreeState();

    const lh = cardOf(container, "鹿回头");
    expect(lh).not.toBeUndefined();
    // #348：0 子玩法 → 不带 is-large（普通卡形态），无父卡 mode 徽标
    expect(lh?.className).not.toContain("is-large");
    expect(lh?.querySelector(".share-badge")).toBeNull();
    // 无内部玩法列表
    expect(lh?.querySelector(".share-stops")).toBeNull();
    // 鹿回头 2 条 guideSnippets 在普通卡形态正常渲染为攻略亮点
    const highlights = lh?.querySelector(".share-highlights");
    expect(highlights).not.toBeNull();
    expect(highlights?.textContent).toContain("鹿回头日落时分俯瞰三亚湾最佳");
    expect(highlights?.textContent).toContain("山顶咖啡馆可久坐看夜景");
  });

  it("large+≥1子（西岛）→ 父卡形态：is-large 且渲染内部玩法列表", async () => {
    const container = await renderThreeState();

    const xidao = cardOf(container, "西岛");
    expect(xidao?.className).toContain("is-large");
    expect(xidao?.querySelector(".share-stops")).not.toBeNull();
    expect(xidao?.querySelector(".share-stops")?.textContent).toContain("牛王岭");
  });

  it("ordinary+0子（第一市场）→ 普通卡形态：无 is-large", async () => {
    const container = await renderThreeState();

    const market = cardOf(container, "第一市场");
    expect(market).not.toBeUndefined();
    expect(market?.className).not.toContain("is-large");
  });

  it("#348 先验保留：鹿回头（large+0子）所在 Day 条仍显景区名而非「N 处」（dayFlag 读 kind 不改）", async () => {
    const container = await renderThreeState();

    // dayFlag 取该天首个 large_attraction 的名称（先验驱动，与渲染形态解耦）
    expect(container.querySelector(".dchip .flag")?.textContent).toContain("鹿回头");
  });
});
