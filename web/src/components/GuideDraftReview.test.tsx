import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GuideDraftConflict, GuideDraftExplanation, Trip } from "@goplay/shared";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../api/client", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    constructor(message: string, status: number, code = "INTERNAL") {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  applyGuideDraft: vi.fn(),
}));

import GuideDraftReview from "./GuideDraftReview";
import {
  applyGuideDraft,
  type GuideDraftApplyResult,
  type GuideDraftResult,
} from "../api/client";

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
    dayRefs: ["day_1", "day_2", "day_3", "day_4"],
    days: { day_1: day(1), day_2: day(2), day_3: day(3), day_4: day(4) },
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

/** 草案响应工厂：Task #123 新字段不传即为 undefined（同时覆盖旧服务端兼容路径） */
function makeDraft(overrides: Partial<GuideDraftResult> = {}): GuideDraftResult {
  return {
    draftId: "draft-1",
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
    mentionCount: 5,
    placeCount: 3,
    mentionRefCount: 5,
    latencyMs: 100,
    promptChars: 1000,
    attempts: 1,
    ...overrides,
  };
}

/** 冲突工厂：默认为「锁定主体可执行冲突」（sensitive + resolution 非 null） */
function makeConflict(overrides: Partial<GuideDraftConflict> = {}): GuideDraftConflict {
  return {
    conflictId: "cf_1",
    directiveId: "dir_1",
    kind: "subject_locked",
    subjectRef: { kind: "visit", id: "visit_houhai" },
    subjectLabel: "三亚后海村",
    detail: "「三亚后海村」当前已锁定，默认不会移动；勾选后将把它移入 Day 3（锁定状态保留）",
    sensitive: true,
    defaultSelected: false,
    resolution: {
      op: "transfer",
      subjectRef: { kind: "visit", id: "visit_houhai" },
      fromContainerRef: { kind: "day", dayIndex: 1 },
      toContainerRef: { kind: "day", dayIndex: 3 },
      toOrder: null,
      reason: "用户确认：按补充句指令把「三亚后海村」移入 Day 3",
    },
    ...overrides,
  };
}

/** 可执行非敏感冲突（目标天锁定项挪走，服务端 defaultSelected=!sensitive&&resolution!==null） */
const PLAIN_CONFLICT = makeConflict({
  conflictId: "cf_plain",
  kind: "target_day_locked",
  subjectRef: { kind: "visit", id: "visit_market" },
  subjectLabel: "第一市场",
  detail: "Day 3 已有锁定的「第一市场」；勾选后将把它挪到 Day 4（锁定状态保留），给指令项腾出空间",
  sensitive: false,
  defaultSelected: true,
});

function makeApplyResult(overrides: Partial<GuideDraftApplyResult> = {}): GuideDraftApplyResult {
  return {
    type: "applied",
    tripVersion: 3,
    draftId: "draft-1",
    applied: [],
    rejected: [],
    rejectedCount: 0,
    rejectSummary: null,
    allRejected: false,
    needsProposal: [],
    attachedSnippetCount: 0,
    message: "已按攻略草案更新行程",
    ...overrides,
  };
}

/**
 * Task #250：分类解释工厂（覆盖五种分类 + 一条 replace 摘要）。
 * 旧草案不传 explanation 即为 undefined，覆盖旧 UI 兼容路径。
 */
function makeExplanation(overrides: Partial<GuideDraftExplanation> = {}): GuideDraftExplanation {
  return {
    items: [
      {
        key: "remove:visit:visit_market",
        classification: "remove",
        targetRef: { kind: "visit", id: "visit_market" },
        displayName: "第一市场",
        dayIndex: null,
        detail: "从 Day3 移回候选池",
      },
      {
        key: "rearrange:visit:visit_houhai",
        classification: "rearrange",
        targetRef: { kind: "visit", id: "visit_houhai" },
        displayName: "三亚后海村",
        dayIndex: 3,
        detail: "从 Day1 调整到 Day3",
      },
      {
        key: "new:visit:visit_ylw",
        classification: "new",
        targetRef: { kind: "visit", id: "visit_ylw" },
        displayName: "亚龙湾热带天堂森林公园",
        dayIndex: 3,
        detail: "此前不在任何 Day，本轮排入 Day3",
      },
      {
        key: "adjust:visit:visit_sanya",
        classification: "adjust",
        targetRef: { kind: "visit", id: "visit_sanya" },
        displayName: "天涯海角",
        dayIndex: 2,
        detail: "本轮调整：开始时间改为 08:30；停留时长改为 90 分钟",
      },
      {
        key: "retain:visit:visit_locked",
        classification: "retain",
        targetRef: { kind: "visit", id: "visit_locked" },
        displayName: "西岛",
        dayIndex: 3,
        detail: "已锁定，整日替换时保留在原天",
      },
      {
        key: "snippet_only:visit:visit_wzz",
        classification: "snippet_only",
        targetRef: { kind: "visit", id: "visit_wzz" },
        displayName: "蜈支洲岛",
        dayIndex: 2,
        detail: "仅补充 1 条攻略亮点，不调整行程结构",
      },
    ],
    counts: { remove: 1, rearrange: 1, new: 1, adjust: 1, retain: 1, snippet_only: 1 },
    replaceSummaries: [
      {
        directiveId: "dir_1",
        dayIndex: 3,
        placeText: "亚龙湾",
        removed: [
          { targetRef: { kind: "visit", id: "visit_market" }, displayName: "第一市场" },
        ],
        kept: [
          { targetRef: { kind: "visit", id: "visit_locked" }, displayName: "西岛", reason: "已锁定" },
        ],
        text: "Day3 将移回 1 项（第一市场），保留 1 项（西岛，已锁定），再按所选攻略重排",
      },
    ],
    ...overrides,
  };
}

function renderReview(draft: GuideDraftResult) {
  const onApplied = vi.fn();
  const onProposalNeeded = vi.fn();
  const onCancel = vi.fn();
  render(
    <GuideDraftReview
      tripId="trip-test"
      trip={makeTrip()}
      draft={draft}
      onApplied={onApplied}
      onProposalNeeded={onProposalNeeded}
      onCancel={onCancel}
    />,
  );
  return { onApplied, onProposalNeeded, onCancel };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GuideDraftReview 冲突勾选（任务 125）", () => {
  it("默认选择：普通可执行冲突默认勾选，敏感冲突默认不选", () => {
    const sensitive = makeConflict(); // sensitive + defaultSelected=false
    renderReview(makeDraft({ conflicts: [PLAIN_CONFLICT, sensitive] }));
    expect((screen.getByRole("checkbox", { name: "第一市场" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "三亚后海村" }) as HTMLInputElement).checked).toBe(false);
  });

  it("敏感项显示短原因徽章与原因明细；纯告知项无勾选框", () => {
    const told = makeConflict({
      conflictId: "cf_told",
      kind: "target_day_occupied",
      subjectRef: null,
      subjectLabel: "Day 3",
      detail: "Day 3 已有安排：第一市场；「后海」将追加到当天末尾，不会覆盖既有项",
      sensitive: false,
      defaultSelected: false,
      resolution: null,
    });
    renderReview(makeDraft({ conflicts: [PLAIN_CONFLICT, makeConflict(), told] }));
    // 敏感可执行项：徽章（已锁定）+ 短原因 detail 完整可见
    expect(screen.getByText("已锁定")).toBeInTheDocument();
    expect(screen.getByText(/当前已锁定，默认不会移动/)).toBeInTheDocument();
    // 纯告知项（resolution=null）：无 checkbox，detail 照常展示
    expect(screen.queryByRole("checkbox", { name: "Day 3" })).toBeNull();
    expect(screen.getByText(/已有安排：第一市场/)).toBeInTheDocument();
  });

  it("总开关：开=只选中可执行且非敏感项（敏感不自动选）；关=清空全部；敏感项可逐项覆盖", () => {
    const sensitive = makeConflict();
    renderReview(makeDraft({ conflicts: [PLAIN_CONFLICT, sensitive] }));
    const all = screen.getByRole("checkbox", { name: "按新要求调整全部" }) as HTMLInputElement;
    const plainBox = screen.getByRole("checkbox", { name: "第一市场" }) as HTMLInputElement;
    const sensitiveBox = screen.getByRole("checkbox", { name: "三亚后海村" }) as HTMLInputElement;

    // 初始：普通项默认勾选 → 先逐项取消，让总开关从未选中态开始
    fireEvent.click(plainBox);
    expect(plainBox.checked).toBe(false);

    // 开：批量选中非敏感可执行项
    fireEvent.click(all);
    expect(plainBox.checked).toBe(true);
    expect(sensitiveBox.checked).toBe(false);

    // 逐项覆盖：用户手动勾选敏感项
    fireEvent.click(sensitiveBox);
    expect(sensitiveBox.checked).toBe(true);

    // 关：清空全部（含手动勾选的敏感项）
    fireEvent.click(all);
    expect(plainBox.checked).toBe(false);
    expect(sensitiveBox.checked).toBe(false);
  });

  it("逐项勾选后提交勾选集合：取消默认项、勾选敏感项后按最终勾选提交", async () => {
    vi.mocked(applyGuideDraft).mockResolvedValue(makeApplyResult());
    const sensitive = makeConflict(); // sensitive + defaultSelected=false
    const { onApplied } = renderReview(makeDraft({ conflicts: [PLAIN_CONFLICT, sensitive] }));

    fireEvent.click(screen.getByRole("checkbox", { name: "第一市场" })); // 取消默认勾选
    fireEvent.click(screen.getByRole("checkbox", { name: "三亚后海村" })); // 手动勾选敏感项
    fireEvent.click(screen.getByRole("button", { name: "应用草案及已选调整" }));
    await waitFor(() => {
      expect(applyGuideDraft).toHaveBeenCalledWith("trip-test", ["cf_1"], undefined);
    });
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it("全部不勾时显式提交空数组（语义=确认都不执行，而非缺省 body）", async () => {
    vi.mocked(applyGuideDraft).mockResolvedValue(makeApplyResult());
    renderReview(makeDraft({ conflicts: [PLAIN_CONFLICT] }));

    fireEvent.click(screen.getByRole("checkbox", { name: "第一市场" })); // 取消唯一默认勾选
    fireEvent.click(screen.getByRole("button", { name: "应用草案及已选调整" }));
    await waitFor(() => {
      expect(applyGuideDraft).toHaveBeenCalledWith("trip-test", [], undefined);
    });
  });

  it("无冲突时按钮保持简洁文案「应用草案到行程」，apply body 不带 selectedConflictIds", async () => {
    vi.mocked(applyGuideDraft).mockResolvedValue(makeApplyResult());
    renderReview(makeDraft({}));
    fireEvent.click(screen.getByRole("button", { name: "应用草案到行程" }));
    await waitFor(() => {
      expect(applyGuideDraft).toHaveBeenCalledWith("trip-test", undefined, undefined);
    });
  });

  it("明确要求：directives 展示一句话要求 + 用户语言满足详情，不出现内部状态码", () => {
    renderReview(
      makeDraft({
        directives: [
          {
            directiveId: "dir_1",
            dayIndex: 3,
            placeText: "后海",
            resolvedVisitIds: ["visit_houhai"],
            rawSentence: "DAY安排后海",
          },
        ],
        requirementChecks: [
          {
            directiveId: "dir_1",
            dayIndex: 3,
            placeText: "后海",
            status: "pending",
            detail: "「后海」已按 Day 3 生成排天，但该到访处于锁定状态，需在冲突清单中确认后才会实际移动",
          },
        ],
        conflicts: [PLAIN_CONFLICT],
      }),
    );
    expect(screen.getByText("你的明确要求")).toBeInTheDocument();
    expect(screen.getByText("「后海」安排到 Day3")).toBeInTheDocument();
    expect(screen.getByText(/需在冲突清单中确认后才会实际移动/)).toBeInTheDocument();
    // 不显示内部状态码（met/partial/unmet/pending 英文码不出现在界面）
    expect(screen.queryByText("met")).toBeNull();
    expect(screen.queryByText("pending")).toBeNull();
  });

  it("旧服务端兼容：directives/conflicts 缺省（undefined）时正常渲染，无确认区块", () => {
    renderReview(makeDraft({})); // 新字段全部缺省
    expect(screen.queryByText("需要你确认")).toBeNull();
    expect(screen.queryByText("你的明确要求")).toBeNull();
    expect(screen.getByRole("button", { name: "应用草案到行程" })).toBeInTheDocument();
  });

  it("应用成功：结果经 onApplied 上抛；仍有敏感操作时转交 onProposalNeeded", async () => {
    const op = {
      op: "lock" as const,
      subjectRef: { kind: "visit" as const, id: "visit_houhai" },
      value: true,
      reason: "敏感操作",
    };
    const result = makeApplyResult({ type: "proposal", needsProposal: [op] });
    vi.mocked(applyGuideDraft).mockResolvedValue(result);
    const { onApplied, onProposalNeeded } = renderReview(makeDraft({}));
    fireEvent.click(screen.getByRole("button", { name: "应用草案到行程" }));
    await waitFor(() => {
      expect(onApplied).toHaveBeenCalledWith(result);
    });
    expect(onProposalNeeded).toHaveBeenCalledWith([op]);
  });

  it("应用失败（DRAFT_STALE 等）：透传服务端 message 且可重试（按钮恢复可用）", async () => {
    const { ApiError } = await import("../api/client");
    vi.mocked(applyGuideDraft).mockRejectedValue(
      new (ApiError as unknown as new (message: string, status: number, code: string) => Error)(
        "行程已变化，请重新生成草案",
        409,
        "DRAFT_STALE",
      ),
    );
    renderReview(makeDraft({}));
    const apply = screen.getByRole("button", { name: "应用草案到行程" });
    fireEvent.click(apply);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("行程已变化，请重新生成草案");
    });
    expect(screen.getByRole("button", { name: "应用草案到行程" })).not.toBeDisabled();
  });
});

describe("GuideDraftReview 分类解释（Task #250）", () => {
  it("五类分组渲染：标签、项目、天号与依据可见，分类内部码不出现在界面", () => {
    renderReview(makeDraft({ explanation: makeExplanation() }));

    expect(screen.getByRole("group", { name: "这轮会怎么调整" })).toBeInTheDocument();
    for (const label of ["移出并回到候选池", "重新排入", "本轮新增", "调整细节", "既有保留", "仅补攻略亮点"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // Task #253：属性 / 内部路线调整单独成组，依据可见
    expect(screen.getByText(/本轮调整：开始时间改为 08:30/)).toBeInTheDocument();
    expect(screen.getByText("第一市场")).toBeInTheDocument();
    expect(screen.getByText("亚龙湾热带天堂森林公园")).toBeInTheDocument();
    expect(screen.getByText("西岛")).toBeInTheDocument();
    expect(screen.getByText("蜈支洲岛")).toBeInTheDocument();
    expect(screen.getByText("从 Day3 移回候选池")).toBeInTheDocument();
    expect(screen.getByText("此前不在任何 Day，本轮排入 Day3")).toBeInTheDocument();
    // 内部分类码不外泄
    expect(screen.queryByText("snippet_only")).toBeNull();
    expect(screen.queryByText("rearrange")).toBeNull();
  });

  it("replace 摘要直接展示数量与名称，保护项带原因；指令行区分整日重排", () => {
    renderReview(
      makeDraft({
        explanation: makeExplanation(),
        directives: [
          {
            directiveId: "dir_1",
            dayIndex: 3,
            placeText: "亚龙湾",
            resolvedVisitIds: ["visit_ylw"],
            rawSentence: "重新做下DAY3的亚龙湾行程",
            mode: "replace",
            replaceRemovedVisitIds: ["visit_market"],
            replaceKeptVisitIds: ["visit_locked"],
          },
        ],
      }),
    );

    expect(screen.getByText("整日替换")).toBeInTheDocument();
    expect(
      screen.getByText(/Day3 将移回 1 项（第一市场），保留 1 项（西岛，已锁定），再按所选攻略重排/),
    ).toBeInTheDocument();
    expect(screen.getByText("整日重排 Day3（以「亚龙湾」为主题）")).toBeInTheDocument();
    expect(screen.queryByText("「亚龙湾」安排到 Day3")).toBeNull();
  });

  it("append 草案：不出现整日替换摘要，仅展示本轮分类", () => {
    renderReview(
      makeDraft({
        explanation: makeExplanation({
          items: [
            {
              key: "new:visit:visit_ylw",
              classification: "new",
              targetRef: { kind: "visit", id: "visit_ylw" },
              displayName: "亚龙湾热带天堂森林公园",
              dayIndex: 3,
              detail: "此前不在任何 Day，本轮排入 Day3",
            },
          ],
          counts: { remove: 0, rearrange: 0, new: 1, adjust: 0, retain: 0, snippet_only: 0 },
          replaceSummaries: [],
        }),
        directives: [
          {
            directiveId: "dir_1",
            dayIndex: 3,
            placeText: "亚龙湾",
            resolvedVisitIds: ["visit_ylw"],
            rawSentence: "DAY3安排亚龙湾",
          },
        ],
      }),
    );

    expect(screen.queryByText("整日替换")).toBeNull();
    expect(screen.queryByText(/将移回/)).toBeNull();
    expect(screen.getByText("本轮新增")).toBeInTheDocument();
    expect(screen.getByText("「亚龙湾」安排到 Day3")).toBeInTheDocument();
  });

  it("旧草案无 explanation：解释区不渲染，原操作列表与主按钮保持不变", () => {
    renderReview(
      makeDraft({
        operations: [
          {
            op: "lock",
            subjectRef: { kind: "visit", id: "visit_houhai" },
            value: true,
            reason: "锁定后海",
          },
        ],
      }),
    );

    expect(screen.queryByText("这轮会怎么调整")).toBeNull();
    expect(screen.getByText("攻略草案")).toBeInTheDocument();
    expect(screen.getByText("锁定")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "应用草案到行程" })).toBeInTheDocument();
  });
});

/**
 * 读取 styles.css 源文本供样式契约断言（jsdom 无真实布局，sticky/遮挡契约只能
 * 对样式源断言）；vitest 从 web 包目录运行，兼容从仓库根运行时的路径。
 */
function readStylesCss(): string {
  for (const relative of ["src/styles.css", "web/src/styles.css"]) {
    const absolute = resolve(process.cwd(), relative);
    if (existsSync(absolute)) return readFileSync(absolute, "utf8");
  }
  throw new Error("styles.css not found from cwd");
}

describe("GuideDraftReview 面板头部 sticky 契约（任务 142：操作项多时标题与取消钮固定）", () => {
  it("样式契约：Sheet 顶部留白移交头部，内部滚动容器与圆角不变", () => {
    const css = readStylesCss();
    const sheetRule = css.match(/\.proposal-sheet \{[^}]*\}/)?.[0] ?? "";
    // 顶部 padding 归零：sticky 头部吸顶时背景铺满圆角顶缘，不藏透缝；
    // 底部 14px 原样保留
    expect(sheetRule).toContain("padding: 0 16px 14px");
    expect(sheetRule).toContain("overflow-y: auto");
    expect(sheetRule).toContain("border-radius: 22px 22px 0 0");
  });

  it("样式契约：头部 sticky 吸顶——top 0、层级、不透明背景与 hairline 分隔", () => {
    const css = readStylesCss();
    const headRule = css.match(/\.proposal-head \{[^}]*\}/)?.[0] ?? "";
    expect(headRule).toContain("position: sticky");
    expect(headRule).toContain("top: 0");
    expect(headRule).toContain("z-index: 2");
    expect(headRule).toContain("background: var(--card)");
    expect(headRule).toContain("border-bottom: 1px solid var(--line)");
    // 顶部 16px（原 Sheet padding-top）；原 margin-bottom 10px 并入 padding-bottom
    expect(headRule).toContain("padding: 16px 0 10px");
  });

  it("样式契约：取消按钮触控区不缩小（26px 命中尺寸保持原样）", () => {
    const css = readStylesCss();
    const closeRule = css.match(/\.proposal-head \.x \{[^}]*\}/)?.[0] ?? "";
    expect(closeRule).toContain("width: 26px");
    expect(closeRule).toContain("height: 26px");
    expect(closeRule).toContain("flex: 0 0 26px");
  });

  it("结构契约：头部是 Sheet 第一个子元素（sticky 生效前提），标题与取消按钮同在头部", () => {
    renderReview(makeDraft({}));

    const sheet = document.querySelector(".proposal-sheet");
    expect(sheet).not.toBeNull();
    const head = sheet?.firstElementChild;
    expect(head?.classList.contains("proposal-head")).toBe(true);
    // 标题与取消按钮都在吸顶头部内：操作项/冲突较多时始终可见可取消
    expect(head?.querySelector(".t1")?.textContent).toBe("攻略草案");
    expect(head?.contains(screen.getByRole("button", { name: "取消草案" }))).toBe(true);
  });

  it("样式契约：行动区 sticky 吸底——内容溢出 60vh 时取消/应用按钮仍可见（任务 #211）", () => {
    const css = readStylesCss();
    const actionsRule = css.match(/\.proposal-actions \{[^}]*\}/)?.[0] ?? "";
    expect(actionsRule).toContain("position: sticky");
    expect(actionsRule).toContain("bottom: 0");
    // 不透明背景 + hairline：滚动内容从按钮下方穿过时被遮挡（与 sticky 头部同手法）
    expect(actionsRule).toContain("background: var(--card)");
    expect(actionsRule).toContain("border-top: 1px solid var(--line)");
  });

  it("任务 #211 回归：仅攻略提示（无 operations）且冲突均为纯告知时，行动区仍渲染且可应用", async () => {
    vi.mocked(applyGuideDraft).mockResolvedValue(makeApplyResult());
    const told = makeConflict({
      conflictId: "cf_told",
      kind: "target_day_occupied",
      subjectRef: null,
      subjectLabel: "Day 1",
      detail: "Day 1 已有安排：后海海滩；「这个攻略的景点、亮点」将追加到当天末尾，不会覆盖既有项",
      sensitive: false,
      defaultSelected: false,
      resolution: null,
    });
    renderReview(
      makeDraft({
        operations: [],
        snippets: [
          {
            text: "后海海滩适合傍晚去看日落",
            claimKind: "experience",
            targetRef: { kind: "visit", id: "visit_houhai" },
            sourceMentionRefs: ["ev_1:m_1"],
          },
        ],
        conflicts: [told],
      }),
    );

    const sheet = document.querySelector(".proposal-sheet");
    // 行动区是 Sheet 最后一个子元素（sticky 吸底生效前提）
    expect(sheet?.lastElementChild?.classList.contains("proposal-actions")).toBe(true);
    // 纯告知冲突不产生可勾选项：按钮保持简洁文案且可点击调用 apply 接口
    const apply = screen.getByRole("button", { name: "应用草案到行程" }) as HTMLButtonElement;
    expect(apply).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();
    fireEvent.click(apply);
    await waitFor(() => {
      expect(applyGuideDraft).toHaveBeenCalledWith("trip-test", undefined, undefined);
    });
  });
});

describe("GuideDraftReview snippet-only 应用（Task #263）", () => {
  /** 3 条只补充、不动结构的攻略提示（服务端快速路径 / 百炼都可能产出） */
  const SNIPPETS = [
    {
      text: "蜈支洲岛建议早去避排队",
      claimKind: "tip" as const,
      targetRef: { kind: "visit" as const, id: "visit_wzz" },
      sourceMentionRefs: ["ev_1:m_1"],
    },
    {
      text: "后海海滩适合傍晚看日落",
      claimKind: "experience" as const,
      targetRef: { kind: "visit" as const, id: "visit_houhai" },
      sourceMentionRefs: ["ev_1:m_2"],
    },
    {
      text: "第一市场晚上人多，避峰去",
      claimKind: "tip" as const,
      targetRef: { kind: "visit" as const, id: "visit_market" },
      sourceMentionRefs: ["ev_1:m_3"],
    },
  ];

  it("预览说明读作「仅补充 N 条攻略提示」，而不是空草案 / 没排成", () => {
    renderReview(makeDraft({ operations: [], snippets: SNIPPETS }));
    expect(screen.getByText("仅补充 3 条攻略提示，不改动行程结构")).toBeInTheDocument();
    expect(screen.queryByText("本草案不调整行程结构")).toBeNull();
  });

  it("operations=[] + 攻略提示应用成功：结果照常上抛，界面不出现错误提示", async () => {
    const result = makeApplyResult({
      applied: [],
      rejected: [],
      attachedSnippetCount: 3,
      message: "行程结构无需变更，已添加 3 条攻略提示",
    });
    vi.mocked(applyGuideDraft).mockResolvedValue(result);
    const { onApplied } = renderReview(makeDraft({ operations: [], snippets: SNIPPETS }));

    fireEvent.click(screen.getByRole("button", { name: "应用草案到行程" }));

    await waitFor(() => {
      expect(onApplied).toHaveBeenCalledTimes(1);
    });
    expect(onApplied).toHaveBeenCalledWith(result);
    // 不报错：没有 alert 区块，也没有「失败」字样（applied 为空不代表失败）
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/失败/)).toBeNull();
    // 成功也要复位提交态：按钮回到可点状态，不卡在「应用中…」
    const applyButton = screen.getByRole("button", { name: "应用草案到行程" });
    expect(applyButton).not.toBeDisabled();
  });
});

describe("GuideDraftReview 整日替换明确确认（Task #253）", () => {
  /** 单条 replace 指令（确认控件只在 mode="replace" 时出现） */
  const REPLACE_DIRECTIVE = {
    directiveId: "dir_1",
    dayIndex: 3,
    placeText: "亚龙湾",
    resolvedVisitIds: ["visit_ylw"],
    rawSentence: "重新做下DAY3的亚龙湾行程",
    mode: "replace" as const,
    replaceRemovedVisitIds: ["visit_market"],
    replaceKeptVisitIds: [],
  };

  it("replace 草案：默认不勾选，按钮改为「仅应用新增安排」，提交不带 replaceConfirm", async () => {
    vi.mocked(applyGuideDraft).mockResolvedValue(makeApplyResult());
    renderReview(makeDraft({ directives: [REPLACE_DIRECTIVE] }));

    const confirmBox = screen.getByRole("checkbox", { name: "确认整日替换" }) as HTMLInputElement;
    expect(confirmBox.checked).toBe(false);
    expect(screen.getByText(/确认整日替换 Day3：原有安排将被移回候选池后按攻略重排/)).toBeInTheDocument();
    expect(screen.getByText(/不勾选时只应用本轮新增安排，原有安排保持不变/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "仅应用新增安排" }));
    await waitFor(() => {
      expect(applyGuideDraft).toHaveBeenCalledWith("trip-test", undefined, undefined);
    });
  });

  it("勾选确认后才提交与当前草案绑定的 replaceConfirm", async () => {
    vi.mocked(applyGuideDraft).mockResolvedValue(makeApplyResult());
    renderReview(makeDraft({ directives: [REPLACE_DIRECTIVE] }));

    fireEvent.click(screen.getByRole("checkbox", { name: "确认整日替换" }));
    fireEvent.click(screen.getByRole("button", { name: "应用草案到行程" }));
    await waitFor(() => {
      expect(applyGuideDraft).toHaveBeenCalledWith("trip-test", undefined, {
        draftId: "draft-1",
        confirmed: true,
      });
    });
  });

  it("草案 id 缺失：确认控件禁用并提示只能应用新增安排", async () => {
    vi.mocked(applyGuideDraft).mockResolvedValue(makeApplyResult());
    renderReview(makeDraft({ draftId: null, directives: [REPLACE_DIRECTIVE] }));

    const confirmBox = screen.getByRole("checkbox", { name: "确认整日替换" }) as HTMLInputElement;
    expect(confirmBox).toBeDisabled();
    expect(screen.getByText(/需要草案编号，本次只能应用新增安排/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "应用草案到行程" }));
    await waitFor(() => {
      expect(applyGuideDraft).toHaveBeenCalledWith("trip-test", undefined, undefined);
    });
  });

  it("append 草案：不出现整日替换确认控件，也不会发送 replaceConfirm", async () => {
    vi.mocked(applyGuideDraft).mockResolvedValue(makeApplyResult());
    renderReview(
      makeDraft({
        directives: [
          {
            directiveId: "dir_1",
            dayIndex: 3,
            placeText: "亚龙湾",
            resolvedVisitIds: ["visit_ylw"],
            rawSentence: "DAY3安排亚龙湾",
          },
        ],
      }),
    );

    expect(screen.queryByRole("checkbox", { name: "确认整日替换" })).toBeNull();
    expect(screen.queryByText("整日替换确认")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "应用草案到行程" }));
    await waitFor(() => {
      expect(applyGuideDraft).toHaveBeenCalledWith("trip-test", undefined, undefined);
    });
  });
});
