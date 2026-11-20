/**
 * 任务 186：GuideSourceList「原文」入口门控测试。
 *
 * 重点覆盖：
 * - 文字 / 截图来源有可回看原文 → 按钮入口，点击上抛 onOpenOriginal；
 * - 链接来源恒为外链 <a>（即使存在下载图，行为与任务 124 前一致）；
 * - 历史来源无完整原文且无链接 → 不渲染入口（不显示无效按钮）；
 * - 历史文字来源无 sourceText 但有 sourceUrl → 降级为外链 <a>。
 *
 * 任务 188：✕ 删除二次确认测试（确认弹窗复用 ConfirmDialog）：
 * - 点 ✕ 先弹确认（不立即上抛 onRemove）；取消 / 遮罩关闭均不调删除；
 * - 确认才上抛一次并关弹窗；确认按钮连点只上抛一次（重复请求保护）；
 * - 描述文案区分链接攻略 / 上传截图 / 粘贴文字，超长标题截断；
 * - processing / ready / partial / failed 各状态 ✕ 均先确认后上抛。
 *
 * Task #224：来源「处理中」分级反馈（详见文件末尾同名 describe）：
 * - 阶段说明与底边进度轨只在 processing 出现，其余状态零改动；
 * - 只有图片队列给确定百分比，纯文字来源走不确定扫光（不画假进度条）；
 * - 落盘静默超阈值只升级措辞与配色，进度数字不谎报；
 * - 样式契约：行容器只加 position 不加 overflow（focus ring 不被裁）。
 */
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { GuideSource, SourceEvidence, Trip } from "@goplay/shared";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import GuideSourceList from "./GuideSourceList";
import { hasSourceOriginalContent, resolveSourceOriginal } from "../lib/sourceOriginal";

/**
 * 读取 styles.css 源文本供样式契约断言（jsdom 无真实布局，滚动容器只能对样式源断言）；
 * vitest 从 web 包目录运行，兼容从仓库根运行时的路径。
 */
function readStylesCss(): string {
  for (const relative of ["src/styles.css", "web/src/styles.css"]) {
    const absolute = resolve(process.cwd(), relative);
    if (existsSync(absolute)) return readFileSync(absolute, "utf8");
  }
  throw new Error("styles.css not found from cwd");
}

function makeEvidence(evidenceId: string, assetPath: string | null): SourceEvidence {
  return {
    evidenceId,
    kind: "screenshot",
    noteIndex: null,
    assetRef: null,
    sourceUrl: null,
    ocrText: null,
    mentions: [],
    assetPath,
  };
}

function makeTrip(evidences: Record<string, SourceEvidence> = {}): Trip {
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
    active: true,
    status: "ready",
    evidenceRefs: [],
    mentionRefs: [],
    imageProgress: { total: 0, completed: 0, failed: 0, images: [] },
    importedAt: "2026-11-01T00:00:00Z",
    // 相对时间：距今 5 秒，远小于 SOURCE_STALL_AFTER_MS（60s），stalled 判定不随系统时钟漂移
    updatedAt: new Date(Date.now() - 5_000).toISOString(),
    ...overrides,
  };
}

/** 与 NoteInput 相同口径的 getOriginal（真实链路：resolveSourceOriginal + 门控） */
interface SelectionStub {
  selectedIds?: ReadonlySet<string>;
  locked?: boolean;
  onToggleSource?: (sourceId: string) => void;
  onSelectAll?: () => void;
  onSelectNone?: () => void;
  onSelectStaged?: () => void;
}

function renderList(
  trip: Trip,
  sources: GuideSource[],
  onOpenOriginal = vi.fn(),
  onRemove = vi.fn(),
  onTriggerOcr = vi.fn(),
  onRetry = vi.fn(),
  selection: SelectionStub = {},
  onRetryImage = vi.fn(),
) {
  const getOriginal = (source: GuideSource) => {
    const original = resolveSourceOriginal(trip, source);
    return hasSourceOriginalContent(original) ? original : null;
  };
  return render(
    <GuideSourceList
      trip={trip}
      sources={sources}
      selectedIds={selection.selectedIds ?? new Set<string>()}
      locked={selection.locked ?? false}
      busy={false}
      getOriginal={getOriginal}
      onOpenOriginal={onOpenOriginal}
      onToggleSource={selection.onToggleSource ?? vi.fn()}
      onSelectAll={selection.onSelectAll ?? vi.fn()}
      onSelectNone={selection.onSelectNone ?? vi.fn()}
      onSelectStaged={selection.onSelectStaged ?? vi.fn()}
      onRetry={onRetry}
      onTriggerOcr={onTriggerOcr}
      onRetryImage={onRetryImage}
      onRemove={onRemove}
    />,
  );
}

/** 有可读证据的行程（isGuideSourceUsable 口径：active + ready/partial + ocrText/mentions） */
function usableTrip(): Trip {
  return makeTrip({
    ev_1: {
      evidenceId: "ev_1",
      kind: "note_text",
      noteIndex: null,
      assetRef: null,
      sourceUrl: null,
      ocrText: "第一天 亚龙湾",
      mentions: [],
      assetPath: null,
    },
  });
}

/** 可用来源（引用 ev_1 证据） */
function usableSource(overrides: Partial<GuideSource> = {}): GuideSource {
  return makeSource({ evidenceRefs: ["ev_1"], ...overrides });
}

/** 四篇可用来源（达到紧凑列表阈值） */
function fourSources(): GuideSource[] {
  return [
    usableSource({ sourceId: "s1", title: "攻略一" }),
    usableSource({ sourceId: "s2", title: "攻略二" }),
    usableSource({ sourceId: "s3", title: "攻略三" }),
    usableSource({ sourceId: "s4", title: "攻略四" }),
  ];
}

describe("GuideSourceList 原文入口（任务 186）", () => {
  it("文字来源有 sourceText：渲染「查看攻略原文」按钮，点击上抛该来源", () => {
    const onOpenOriginal = vi.fn();
    renderList(
      makeTrip(),
      [makeSource({ inputKind: "text", sourceText: "第一天 亚龙湾" })],
      onOpenOriginal,
    );
    const button = screen.getByLabelText("查看攻略原文");
    expect(button.tagName).toBe("BUTTON");
    fireEvent.click(button);
    expect(onOpenOriginal).toHaveBeenCalledTimes(1);
    expect(onOpenOriginal).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "src_1" }));
  });

  it("截图来源有明细 assetPath：渲染原文按钮（processing 中也可回看已落盘原图）", () => {
    renderList(
      makeTrip(),
      [
        makeSource({
          inputKind: "images",
          status: "processing",
          imageProgress: {
            total: 1,
            completed: 0,
            failed: 0,
            images: [{ index: 1, status: "pending", evidenceId: null, assetPath: "uploads/trip-test/ev_shot_a.png" }],
          },
        }),
      ],
    );
    expect(screen.getByLabelText("查看攻略原文").tagName).toBe("BUTTON");
  });

  it("链接来源恒为外链 <a>：即使存在下载图也不改走本地回看", () => {
    const trip = makeTrip({ ev_1: makeEvidence("ev_1", "uploads/trip-test/ev_1.png") });
    renderList(trip, [
      makeSource({
        inputKind: "link",
        sourceUrl: "https://example.com/guide",
        imageProgress: {
          total: 1,
          completed: 1,
          failed: 0,
          images: [{ index: 1, status: "ready", evidenceId: "ev_1", assetPath: "uploads/trip-test/ev_shot_b.png" }],
        },
      }),
    ]);
    const link = screen.getByLabelText("打开攻略原文链接");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("https://example.com/guide");
    expect(screen.queryByLabelText("查看攻略原文")).toBeNull();
  });

  it("历史文字来源无 sourceText 且无 sourceUrl：不渲染任何原文入口（不显示无效按钮）", () => {
    renderList(makeTrip(), [makeSource({ inputKind: "text" })]);
    expect(screen.queryByLabelText("查看攻略原文")).toBeNull();
    expect(screen.queryByLabelText("打开攻略原文链接")).toBeNull();
  });

  it("历史文字来源无 sourceText 但有 sourceUrl：降级为外链 <a>", () => {
    renderList(makeTrip(), [
      makeSource({ inputKind: "text", sourceUrl: "https://example.com/note/123" }),
    ]);
    const link = screen.getByLabelText("打开攻略原文链接");
    expect(link.tagName).toBe("A");
    expect(screen.queryByLabelText("查看攻略原文")).toBeNull();
  });
});

describe("GuideSourceList 解析图片入口（Task #215）", () => {
  it("imageOcrDeferred 且有待解析图：渲染「解析图片」，点击上抛并隐藏重试", () => {
    const onTriggerOcr = vi.fn();
    renderList(
      makeTrip(),
      [
        makeSource({
          inputKind: "link",
          status: "partial",
          imageOcrDeferred: true,
          imageProgress: {
            total: 2,
            completed: 0,
            failed: 1,
            images: [
              { index: 1, status: "pending", evidenceId: null, assetPath: "uploads/xhs_a/1.jpg" },
              {
                index: 2,
                status: "failed",
                evidenceId: null,
                failureCode: "download_failed",
                failureMessage: "图片下载失败",
              },
            ],
          },
        }),
      ],
      vi.fn(),
      vi.fn(),
      onTriggerOcr,
    );
    const button = screen.getByLabelText("解析该攻略的图片");
    fireEvent.click(button);
    expect(onTriggerOcr).toHaveBeenCalledTimes(1);
    expect(onTriggerOcr).toHaveBeenCalledWith("src_1");
    // deferred 优先：同屏不出现重试入口（避免两个入口做几乎同一件事）
    expect(screen.queryByLabelText("重试处理该攻略")).toBeNull();
    // 进度行展示待解析张数（pending ≠ 失败）
    expect(screen.getByText("1 张图片待解析")).toBeInTheDocument();
  });

  it("deferred 但无待解析图：不渲染解析图片，partial 恢复重试入口", () => {
    renderList(
      makeTrip(),
      [
        makeSource({
          inputKind: "images",
          status: "partial",
          imageOcrDeferred: true,
          imageProgress: {
            total: 1,
            completed: 1,
            failed: 0,
            images: [{ index: 1, status: "ready", evidenceId: "ev_1" }],
          },
        }),
      ],
    );
    expect(screen.queryByLabelText("解析该攻略的图片")).toBeNull();
    expect(screen.getByLabelText("重试处理该攻略")).toBeInTheDocument();
  });

  it("非 deferred 来源：不渲染解析图片入口", () => {
    renderList(
      makeTrip(),
      [
        makeSource({
          inputKind: "images",
          status: "ready",
          imageProgress: {
            total: 1,
            completed: 1,
            failed: 0,
            images: [{ index: 1, status: "ready", evidenceId: "ev_1" }],
          },
        }),
      ],
    );
    expect(screen.queryByLabelText("解析该攻略的图片")).toBeNull();
  });
});

describe("GuideSourceList 图片解析模式提示（Task #225）", () => {
  it("ocrDeferred 来源（卡片视图）：渲染模式提示块，含当前模式与可选模式说明", () => {
    renderList(
      makeTrip(),
      [
        makeSource({
          inputKind: "link",
          status: "partial",
          imageOcrDeferred: true,
          imageProgress: {
            total: 3,
            completed: 0,
            failed: 0,
            images: [
              { index: 1, status: "pending", evidenceId: null },
              { index: 2, status: "pending", evidenceId: null },
              { index: 3, status: "pending", evidenceId: null },
            ],
          },
        }),
      ],
    );
    const hint = screen.getByRole("note", { name: "图片解析选项说明" });
    expect(hint).toBeInTheDocument();
    expect(hint.textContent).toContain("当前：仅解析正文（快速）");
    expect(hint.textContent).toContain("可选：解析 3 张图片获取更完整信息（约1-2分钟/张）");
  });

  it("模式提示块内的「解析图片」按钮点击上抛 onTriggerOcr", () => {
    const onTriggerOcr = vi.fn();
    renderList(
      makeTrip(),
      [
        makeSource({
          inputKind: "link",
          status: "partial",
          imageOcrDeferred: true,
          imageProgress: {
            total: 2,
            completed: 0,
            failed: 0,
            images: [
              { index: 1, status: "pending", evidenceId: null },
              { index: 2, status: "pending", evidenceId: null },
            ],
          },
        }),
      ],
      vi.fn(),
      vi.fn(),
      onTriggerOcr,
    );
    const hintBtn = screen.getByLabelText("解析该攻略的 2 张图片");
    fireEvent.click(hintBtn);
    expect(onTriggerOcr).toHaveBeenCalledTimes(1);
    expect(onTriggerOcr).toHaveBeenCalledWith("src_1");
  });

  it("非 ocrDeferred 来源不渲染模式提示块", () => {
    renderList(makeTrip(), [makeSource({ status: "ready" })]);
    expect(screen.queryByRole("note", { name: "图片解析选项说明" })).toBeNull();
  });

  it("紧凑列表（>=4篇）：不渲染提示块，但解析图片按钮带 title 说明", () => {
    renderList(usableTrip(), [
      usableSource({ sourceId: "s1", title: "攻略一" }),
      usableSource({ sourceId: "s2", title: "攻略二" }),
      usableSource({ sourceId: "s3", title: "攻略三" }),
      usableSource({
        sourceId: "s4",
        title: "攻略四",
        status: "partial",
        inputKind: "link",
        imageOcrDeferred: true,
        imageProgress: {
          total: 5,
          completed: 0,
          failed: 0,
          images: [
            { index: 1, status: "pending", evidenceId: null },
            { index: 2, status: "pending", evidenceId: null },
            { index: 3, status: "pending", evidenceId: null },
            { index: 4, status: "pending", evidenceId: null },
            { index: 5, status: "pending", evidenceId: null },
          ],
        },
      }),
    ]);
    expect(document.querySelector(".guide-source-list")).toHaveClass("compact");
    // 紧凑视图不渲染提示块
    expect(screen.queryByRole("note", { name: "图片解析选项说明" })).toBeNull();
    // 但按钮带 title 说明两种模式
    const btn = screen.getByLabelText("解析该攻略的图片");
    expect(btn.getAttribute("title")).toContain("当前仅解析正文");
    expect(btn.getAttribute("title")).toContain("5 张图片");
  });
});

/**
 * Task #303：图片解析入口预告态。
 *
 * PD 现场：链接来源 processing（「正在抓取攻略正文… 图片 0/9」+ 逐图网格 1-9），
 * 服务端此时图片已全部下载落盘（pending + assetPath），但 imageOcrDeferred 要到
 * 结算才置 true——旧渲染条件下整个 processing 期间「解析图片」入口完全不可见，
 * PD 以为功能被改丢。修复：processing 且图片 pending、OCR 队列未启动（无任何
 * processing 图）时渲染预告态提示块（卡片视图）/ 禁用小按钮（紧凑视图），
 * 按钮不可点（服务端 triggerImageOcr 拒绝 processing 来源），但入口可见。
 */
describe("GuideSourceList 图片解析入口预告态（Task #303）", () => {
  /** PD 来源2 现场夹具：链接来源 processing，9 图已下载全部 pending */
  function pdSource2(): GuideSource {
    return makeSource({
      sourceId: "src_pd2",
      inputKind: "link",
      status: "processing",
      imageProgress: {
        total: 9,
        completed: 0,
        failed: 0,
        images: Array.from({ length: 9 }, (_, i) => ({
          index: i + 1,
          status: "pending" as const,
          evidenceId: null,
          assetPath: `uploads/xhs_pd2/${i + 1}.jpg`,
        })),
      },
    });
  }

  it("PD 现场复现（卡片视图）：processing + 9 图 pending → 预告块可见，按钮禁用", () => {
    renderList(makeTrip(), [pdSource2()]);
    const hint = screen.getByRole("note", { name: "图片解析选项说明" });
    expect(hint).toBeInTheDocument();
    expect(hint).toHaveClass("preview");
    expect(hint.textContent).toContain("9 张图片已下载，正文解析进行中");
    expect(hint.textContent).toContain("正文完成后即可一键解析图片");
    // 预告态按钮禁用（服务端拒绝 processing 来源触发 OCR），且不与可点入口混淆
    const previewBtn = screen.getByLabelText("正文完成后可解析 9 张图片");
    expect(previewBtn).toBeDisabled();
    expect(screen.queryByLabelText("解析该攻略的图片")).toBeNull();
    // 既有元素不受影响：逐图网格与状态胶囊照常渲染
    expect(document.querySelector(".img-progress-grid")).not.toBeNull();
    expect(screen.getByText("处理中")).toBeInTheDocument();
  });

  it("预告态点击不上抛 onTriggerOcr（按钮禁用）", () => {
    const onTriggerOcr = vi.fn();
    renderList(makeTrip(), [pdSource2()], vi.fn(), vi.fn(), onTriggerOcr);
    fireEvent.click(screen.getByLabelText("正文完成后可解析 9 张图片"));
    expect(onTriggerOcr).not.toHaveBeenCalled();
  });

  it("紧凑视图：processing + 图 pending → 禁用小按钮带预告 title", () => {
    renderList(usableTrip(), [
      usableSource({ sourceId: "s1", title: "攻略一" }),
      usableSource({ sourceId: "s2", title: "攻略二" }),
      usableSource({ sourceId: "s3", title: "攻略三" }),
      pdSource2(),
    ]);
    expect(document.querySelector(".guide-source-list")).toHaveClass("compact");
    const btn = screen.getByLabelText("正文完成后可解析 9 张图片");
    expect(btn).toBeDisabled();
    expect(btn.getAttribute("title")).toContain("9 张图片已下载");
    expect(btn.getAttribute("title")).toContain("正文解析完成后即可一键解析图片");
  });

  it("手动 OCR 进行中（有 processing 图）：不渲染预告（解析已在跑）", () => {
    renderList(
      makeTrip(),
      [
        makeSource({
          sourceId: "src_ocr_running",
          inputKind: "link",
          status: "processing",
          imageProgress: {
            total: 3,
            completed: 1,
            failed: 0,
            images: [
              { index: 1, status: "ready", evidenceId: "ev_1" },
              { index: 2, status: "processing", evidenceId: null },
              { index: 3, status: "pending", evidenceId: null },
            ],
          },
        }),
      ],
    );
    expect(screen.queryByRole("note", { name: "图片解析选项说明" })).toBeNull();
    expect(screen.queryByLabelText(/正文完成后可解析/)).toBeNull();
  });

  it("ocrDeferred（已结算）：仍走 #225 可操作提示块，而非预告态", () => {
    renderList(
      makeTrip(),
      [
        makeSource({
          inputKind: "link",
          status: "ready",
          imageOcrDeferred: true,
          imageProgress: {
            total: 2,
            completed: 0,
            failed: 0,
            images: [
              { index: 1, status: "pending", evidenceId: null },
              { index: 2, status: "pending", evidenceId: null },
            ],
          },
        }),
      ],
    );
    const hint = screen.getByRole("note", { name: "图片解析选项说明" });
    expect(hint).not.toHaveClass("preview");
    expect(screen.getByLabelText("解析该攻略的 2 张图片")).toBeEnabled();
    expect(screen.queryByLabelText(/正文完成后可解析/)).toBeNull();
  });

  it("processing 纯文字来源（无图）：不渲染预告块", () => {
    renderList(makeTrip(), [makeSource({ status: "processing", inputKind: "text" })]);
    expect(screen.queryByRole("note", { name: "图片解析选项说明" })).toBeNull();
  });
});

describe("GuideSourceList 删除二次确认（任务 188）", () => {
  it("点 ✕ 先弹二次确认，不立即上抛删除", () => {
    const onRemove = vi.fn();
    renderList(makeTrip(), [makeSource({ title: "三亚三日游攻略" })], vi.fn(), onRemove);
    fireEvent.click(screen.getByLabelText("移除该攻略"));
    expect(screen.getByRole("dialog", { name: "移除攻略来源" })).toBeInTheDocument();
    expect(screen.getByText(/将移除粘贴文字「三亚三日游攻略」/)).toBeInTheDocument();
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("链接攻略：确认文案标注类型与来源标题", () => {
    renderList(
      makeTrip(),
      [
        makeSource({
          inputKind: "link",
          title: "三亚环岛自驾攻略",
          sourceUrl: "https://www.xiaohongshu.com/explore/abc",
        }),
      ],
    );
    fireEvent.click(screen.getByLabelText("移除该攻略"));
    expect(screen.getByText(/将移除链接攻略「三亚环岛自驾攻略」/)).toBeInTheDocument();
  });

  it("上传截图：无标题时用短标签兜底，不展示超长正文", () => {
    renderList(makeTrip(), [makeSource({ inputKind: "images" })]);
    fireEvent.click(screen.getByLabelText("移除该攻略"));
    expect(screen.getByText(/将移除上传截图「上传的攻略截图」/)).toBeInTheDocument();
  });

  it("粘贴文字：无标题时用短标签兜底", () => {
    renderList(makeTrip(), [makeSource({ inputKind: "text" })]);
    fireEvent.click(screen.getByLabelText("移除该攻略"));
    expect(screen.getByText(/将移除粘贴文字「粘贴的攻略文字」/)).toBeInTheDocument();
  });

  it("超长标题截断：描述只展示前 24 字 + 略号", () => {
    const longTitle = "超".repeat(30);
    renderList(makeTrip(), [makeSource({ title: longTitle })]);
    fireEvent.click(screen.getByLabelText("移除该攻略"));
    expect(screen.getByText(/「超{24}…」/)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(`「${longTitle}」`))).toBeNull();
  });

  it("取消按钮：关闭弹窗且不上抛删除，来源仍在列表", () => {
    const onRemove = vi.fn();
    renderList(makeTrip(), [makeSource({ title: "攻略" })], vi.fn(), onRemove);
    fireEvent.click(screen.getByLabelText("移除该攻略"));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog", { name: "移除攻略来源" })).toBeNull();
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.getByText("已添加 1 篇")).toBeInTheDocument();
  });

  it("点遮罩关闭：不上抛删除，来源仍在列表", () => {
    const onRemove = vi.fn();
    renderList(makeTrip(), [makeSource({ title: "攻略" })], vi.fn(), onRemove);
    fireEvent.click(screen.getByLabelText("移除该攻略"));
    fireEvent.click(document.querySelector(".confirm-overlay") as Element);
    expect(screen.queryByRole("dialog", { name: "移除攻略来源" })).toBeNull();
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.getByText("已添加 1 篇")).toBeInTheDocument();
  });

  it("确认移除：上抛一次 onRemove(sourceId) 并关闭弹窗", () => {
    const onRemove = vi.fn();
    renderList(makeTrip(), [makeSource({ sourceId: "src_9", title: "攻略" })], vi.fn(), onRemove);
    fireEvent.click(screen.getByLabelText("移除该攻略"));
    fireEvent.click(screen.getByRole("button", { name: "移除" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith("src_9");
    expect(screen.queryByRole("dialog", { name: "移除攻略来源" })).toBeNull();
  });

  it("确认按钮快速连点：同批只上抛一次（重复请求保护）", () => {
    const onRemove = vi.fn();
    renderList(makeTrip(), [makeSource({ title: "攻略" })], vi.fn(), onRemove);
    fireEvent.click(screen.getByLabelText("移除该攻略"));
    const confirmBtn = screen.getByRole("button", { name: "移除" });
    // 同一 act 内连点两次：setState 批处理尚未生效，验证 confirmLockRef 互斥
    act(() => {
      confirmBtn.click();
      confirmBtn.click();
    });
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "移除攻略来源" })).toBeNull();
  });

  it("processing / ready / partial / failed 各状态 ✕ 均先确认后上抛", () => {
    const onRemove = vi.fn();
    renderList(
      makeTrip(),
      [
        makeSource({ sourceId: "s_processing", status: "processing" }),
        makeSource({ sourceId: "s_ready", status: "ready" }),
        makeSource({ sourceId: "s_partial", status: "partial" }),
        makeSource({ sourceId: "s_failed", status: "failed", failureMessage: "识别失败" }),
      ],
      vi.fn(),
      onRemove,
    );
    const removes = screen.getAllByLabelText("移除该攻略");
    expect(removes).toHaveLength(4);
    removes.forEach((button) => {
      fireEvent.click(button);
      // 先弹确认，未直接上抛
      expect(screen.getByRole("dialog", { name: "移除攻略来源" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "移除" }));
    });
    expect(onRemove).toHaveBeenCalledTimes(4);
    // 4 篇达阈值为紧凑列表：DOM 顺序为待处理置顶（processing → failed → 其余导入序），
    // 逐行 ✕ 仍先确认后上抛（不能因排序改变而丢行）
    expect(onRemove).toHaveBeenNthCalledWith(1, "s_processing");
    expect(onRemove).toHaveBeenNthCalledWith(2, "s_failed");
    expect(onRemove).toHaveBeenNthCalledWith(3, "s_ready");
    expect(onRemove).toHaveBeenNthCalledWith(4, "s_partial");
  });
});

describe("GuideSourceList 勾选与长列表（Task #236）", () => {
  it("少于 4 篇保持大卡片：勾选框可用，无批量栏与紧凑行容器", () => {
    renderList(usableTrip(), [
      usableSource({ sourceId: "s1", title: "攻略一" }),
      usableSource({ sourceId: "s2", title: "攻略二" }),
      usableSource({ sourceId: "s3", title: "攻略三" }),
    ]);

    const list = document.querySelector(".guide-source-list");
    expect(list?.classList.contains("compact")).toBe(false);
    expect(document.querySelector(".guide-compact-rows")).toBeNull();
    expect(screen.queryByRole("button", { name: "全选" })).toBeNull();
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    expect(screen.getByLabelText("选择攻略 攻略一")).toBeEnabled();
  });

  it("4 篇切紧凑单行列表：批量栏展示已选 N / M 篇，列表不自建滚动容器（Task #242）", () => {
    renderList(usableTrip(), fourSources(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), {
      selectedIds: new Set(["s1", "s3"]),
    });

    const list = document.querySelector(".guide-source-list");
    expect(list?.classList.contains("compact")).toBe(true);
    const rows = document.querySelector(".guide-compact-rows");
    expect(rows).not.toBeNull();
    expect(screen.getAllByRole("checkbox")).toHaveLength(4);
    const count = document.querySelector(".guide-source-selcount")?.textContent ?? "";
    expect(count.replace(/\s+/g, " ").trim()).toBe("已选 2 / 4 篇");
    expect(document.querySelectorAll(".guide-compact-title")).toHaveLength(4);
  });

  it("样式契约：紧凑列表不再设 max-height / overflow（外层 Sheet 单滚动，避免嵌套滚动陷阱）", () => {
    const css = readStylesCss();
    // 旧的内部滚动容器已退役：不得再出现任何 .guide-source-scroll 规则
    expect(css).not.toMatch(/\.guide-source-scroll\s*\{/);
    const compactRows = css.match(/^\.guide-compact-rows \{[^}]*\}/m)?.[0] ?? "";
    expect(compactRows).not.toBe("");
    for (const forbidden of ["max-height", "overflow", "overscroll-behavior", "-webkit-overflow-scrolling"]) {
      expect(compactRows).not.toContain(forbidden);
    }
  });

  it("全选 / 全不选 / 只选新的：分别上抛对应回调", () => {
    const onSelectAll = vi.fn();
    const onSelectNone = vi.fn();
    const onSelectStaged = vi.fn();
    renderList(usableTrip(), fourSources(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), {
      onSelectAll,
      onSelectNone,
      onSelectStaged,
    });

    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    fireEvent.click(screen.getByRole("button", { name: "全不选" }));
    fireEvent.click(screen.getByRole("button", { name: "只选新的" }));

    expect(onSelectAll).toHaveBeenCalledTimes(1);
    expect(onSelectNone).toHaveBeenCalledTimes(1);
    expect(onSelectStaged).toHaveBeenCalledTimes(1);
  });

  it("长列表把待处理来源置顶，同级保持导入顺序（稳定排序）", () => {
    renderList(usableTrip(), [
      usableSource({ sourceId: "s_ready", title: "历史攻略" }),
      usableSource({ sourceId: "s_failed", title: "失败攻略", status: "failed" }),
      usableSource({ sourceId: "s_new", title: "新增攻略", staged: true }),
      usableSource({ sourceId: "s_processing", title: "处理中攻略", status: "processing" }),
      usableSource({ sourceId: "s_new2", title: "另一篇新增", staged: true }),
    ]);

    const titles = Array.from(document.querySelectorAll(".guide-compact-title")).map(
      (element) => element.textContent,
    );
    expect(titles).toEqual([
      "处理中攻略",
      "失败攻略",
      "新增攻略",
      "另一篇新增",
      "历史攻略",
    ]);
  });

  it("紧凑行内点删除 / 重试 / 勾选框不会误触行切换；点行空白才切换", () => {
    const onToggleSource = vi.fn();
    const onRemove = vi.fn();
    const onRetry = vi.fn();
    renderList(
      usableTrip(),
      [
        usableSource({ sourceId: "s1", title: "攻略一" }),
        usableSource({ sourceId: "s_fail", title: "失败攻略", status: "failed" }),
        usableSource({ sourceId: "s3", title: "攻略三" }),
        usableSource({ sourceId: "s4", title: "攻略四" }),
      ],
      vi.fn(),
      onRemove,
      vi.fn(),
      onRetry,
      { onToggleSource },
    );

    // ✕ 先弹确认，不触发勾选
    fireEvent.click(screen.getAllByLabelText("移除该攻略")[0] as Element);
    expect(onToggleSource).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    // 重试下发请求，不触发勾选
    fireEvent.click(screen.getByLabelText("重试处理该攻略"));
    expect(onRetry).toHaveBeenCalledWith("s_fail");
    expect(onToggleSource).not.toHaveBeenCalled();

    // 勾选框只切换一次（label 命中块 + input 冒泡不重复）
    fireEvent.click(screen.getByLabelText("选择攻略 攻略一"));
    expect(onToggleSource).toHaveBeenCalledTimes(1);
    expect(onToggleSource).toHaveBeenCalledWith("s1");

    // 点标题（非交互区）才走整行切换
    fireEvent.click(screen.getByText("攻略三"));
    expect(onToggleSource).toHaveBeenCalledTimes(2);
    expect(onToggleSource).toHaveBeenCalledWith("s3");
  });

  it("不可选来源勾选框禁用并带原因说明", () => {
    renderList(usableTrip(), [
      usableSource({ sourceId: "s1", title: "可用攻略" }),
      usableSource({ sourceId: "s_p", title: "处理中攻略", status: "processing" }),
      makeSource({ sourceId: "s_empty", title: "无要点攻略", evidenceRefs: [] }),
    ]);

    expect(screen.getByLabelText("选择攻略 可用攻略")).toBeEnabled();
    const processing = screen.getByLabelText(/选择攻略 处理中攻略/);
    expect(processing).toBeDisabled();
    expect(processing.getAttribute("aria-label")).toContain("该攻略还在解析，完成后可选择");
    const noEvidence = screen.getByLabelText(/选择攻略 无要点攻略/);
    expect(noEvidence).toBeDisabled();
    expect(noEvidence.getAttribute("aria-label")).toContain("该攻略暂无可用于排版的要点");
  });

  // Task #240：浏览器在「1 篇 failed」时误判为「没有勾选框」。产品语义是：
  // 不可选 ≠ 隐藏——勾选框照常渲染但禁用，并给出「请先重试」的原因。
  it("Task #240：单篇 failed 来源仍渲染勾选框（禁用 + 原因），不是没有勾选框", () => {
    renderList(makeTrip(), [
      makeSource({
        sourceId: "s_fail",
        title: "失败攻略",
        status: "failed",
        failureMessage: "链接抓取失败",
      }),
    ]);

    const failed = screen.getByLabelText(/选择攻略 失败攻略/);
    expect(failed).toBeDisabled();
    expect(failed.getAttribute("aria-label")).toContain("该攻略解析失败，请先重试");
    // 少于 4 篇保持大卡片，失败状态与重试入口同时可见
    expect(document.querySelector(".guide-source-list")?.classList.contains("compact")).toBe(
      false,
    );
    expect(screen.getByText("失败")).toBeInTheDocument();
    expect(screen.getByLabelText("重试处理该攻略")).toBeInTheDocument();
  });

  it("生成进行中（locked）：全部勾选框与批量入口禁用", () => {
    renderList(usableTrip(), fourSources(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), {
      locked: true,
      selectedIds: new Set(["s1"]),
    });

    for (const checkbox of screen.getAllByRole("checkbox")) {
      expect(checkbox).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: "全选" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "全不选" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "只选新的" })).toBeDisabled();
  });
});

/**
 * Task #224：来源「处理中」分级反馈。
 * 夹具的 updatedAt 默认取「距今 5 秒」的相对时间，远小于 60s stalled 阈值，因此
 * stalled 恒为 false，不随系统时钟漂移；慢档用例显式给一个远古时间戳确定性断言。
 */
describe("GuideSourceList 处理中分级反馈（Task #224）", () => {
  const ANCIENT = "2020-01-01T00:00:00Z";

  it("大卡片 processing：阶段说明 + 底边进度轨（纯文字来源走不确定扫光）", () => {
    renderList(makeTrip(), [makeSource({ status: "processing", inputKind: "text" })]);
    expect(screen.getByText("正在提炼文字里的地点和玩法…")).toBeInTheDocument();
    const meter = document.querySelector(".source-wait-meter");
    expect(meter).not.toBeNull();
    expect(meter).toHaveAttribute("data-mode", "indeterminate");
    expect(meter).toHaveAttribute("data-phase", "extract");
    expect(meter).toHaveAttribute("aria-hidden", "true");
    // 无确定信号时不写死宽度，交给 CSS 扫光（不画假百分比）
    expect((meter?.querySelector("i") as HTMLElement | null)?.style.width).toBe("");
  });

  it("图片队列推进中：轨道按真实结算比例填充（唯一给确定百分比的场景）", () => {
    renderList(
      makeTrip(),
      [
        makeSource({
          status: "processing",
          inputKind: "images",
          imageProgress: { total: 5, completed: 2, failed: 1, images: [] },
        }),
      ],
    );
    expect(screen.getByText("正在读取图片 3/5…")).toBeInTheDocument();
    const meter = document.querySelector(".source-wait-meter");
    expect(meter).toHaveAttribute("data-mode", "determinate");
    expect(meter).toHaveAttribute("data-phase", "images");
    // jsdom 会把 "60.0%" 归一成 "60%"，故按数值断言（3/5 = 0.6）
    expect(Number.parseFloat((meter?.querySelector("i") as HTMLElement).style.width)).toBeCloseTo(60, 5);
    // 既有张数读数不被顶掉：completed/total + 失败数（分级读数另起一行，两者并存）
    expect(screen.getByText("图片 2/5 · 1 张失败")).toBeInTheDocument();
  });

  it("落盘静默超阈值：措辞升级 + 轨道标记 stalled，但进度数字不谎报", () => {
    renderList(
      makeTrip(),
      [
        makeSource({
          status: "processing",
          inputKind: "images",
          updatedAt: ANCIENT,
          imageProgress: { total: 4, completed: 3, failed: 0, images: [] },
        }),
      ],
    );
    expect(screen.getByText("图片还在读取（3/4），这一步比较慢…")).toBeInTheDocument();
    const meter = document.querySelector(".source-wait-meter");
    expect(meter).toHaveAttribute("data-stalled", "true");
    expect(Number.parseFloat((meter?.querySelector("i") as HTMLElement).style.width)).toBeCloseTo(75, 5);
    expect(document.querySelector(".guide-source-stage")).toHaveAttribute("data-stalled", "true");
  });

  it("非 processing 来源不渲染任何等待元素（就绪 / 部分完成 / 失败都不受影响）", () => {
    renderList(makeTrip(), [
      makeSource({ sourceId: "s_ready", status: "ready" }),
      makeSource({ sourceId: "s_partial", status: "partial" }),
      makeSource({ sourceId: "s_failed", status: "failed", failureMessage: "识别失败" }),
    ]);
    expect(document.querySelector(".source-wait-meter")).toBeNull();
    expect(document.querySelector(".guide-source-stage")).toBeNull();
  });

  it("紧凑列表：短读数（站名 + 张数）+ 整句挂在状态胶囊 title，不撑破 46% 宽度", () => {
    renderList(usableTrip(), [
      usableSource({ sourceId: "s1", title: "攻略一" }),
      usableSource({ sourceId: "s2", title: "攻略二" }),
      usableSource({
        sourceId: "s3",
        title: "攻略三",
        status: "processing",
        inputKind: "images",
        imageProgress: { total: 6, completed: 1, failed: 0, images: [] },
      }),
      usableSource({ sourceId: "s4", title: "攻略四", status: "processing" }),
    ]);
    expect(document.querySelector(".guide-source-list")).toHaveClass("compact");
    // 图片来源：既有张数读数优先（含失败数信息）
    expect(screen.getByText("图片 1/6")).toBeInTheDocument();
    // 纯文字来源原本什么都没有，现在补阶段短名
    expect(screen.getByText("提炼")).toBeInTheDocument();
    // 每行都有底边轨道
    expect(document.querySelectorAll(".source-wait-meter")).toHaveLength(2);
    // 整句说明通过 title 承载（移动端无 hover，但至少不丢信息）
    const pills = Array.from(document.querySelectorAll(".guide-source-status.processing"));
    expect(pills).toHaveLength(2);
    expect(pills.some((pill) => (pill.getAttribute("title") ?? "").includes("正在提炼文字里的地点和玩法"))).toBe(true);
  });

  it("样式契约：行容器只加 position 不加 overflow（focus ring 不被裁），轨道压住分隔线", () => {
    const css = readStylesCss();
    for (const selector of [".guide-source-item", ".guide-compact-item"]) {
      const block = css.match(new RegExp(`^${selector.replace(".", "\\.")} \\{[^}]*\\}`, "m"))?.[0] ?? "";
      expect(block).not.toBe("");
      expect(block).toContain("position: relative");
      // 只禁 overflow 声明本身（注释里提到这个词是为了说明为什么不加）
      expect(block).not.toMatch(/overflow\s*:/);
    }
    const meter = css.match(/^\.source-wait-meter \{[^}]*\}/m)?.[0] ?? "";
    expect(meter).toContain("position: absolute");
    expect(meter).toContain("bottom: -1px");
    expect(meter).toContain("pointer-events: none");
    // 不确定态有扫光动效，且 reduced-motion 下关停
    expect(css).toMatch(/\.source-wait-meter\[data-mode="indeterminate"\] > i \{[^}]*source-wait-sweep/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.source-wait-meter/);
    // 360px 窄屏降档存在
    expect(css).toMatch(/@media \(max-width: 359px\)[\s\S]*?\.guide-source-stage/);
  });

  it("处理中胶囊的高光掠动是纯 CSS（不新增 markup、不改胶囊尺寸）", () => {
    const css = readStylesCss();
    const pill = css.match(/^\.guide-source-status\.processing \{[^}]*\}/m)?.[0] ?? "";
    expect(pill).toContain("position: relative");
    expect(pill).toContain("overflow: hidden");
    expect(css).toMatch(/\.guide-source-status\.processing::after/);
    renderList(makeTrip(), [makeSource({ status: "processing" })]);
    // 胶囊文本仍是既有状态词，未新增节点
    expect(screen.getByText("处理中").childElementCount).toBe(0);
  });

  it("整行点击语义不变：进度轨是 pointer-events:none 的装饰，不参与勾选切换", () => {
    const onToggleSource = vi.fn();
    renderList(
      usableTrip(),
      [usableSource({ sourceId: "s1", title: "可用攻略", status: "processing" })],
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      { onToggleSource },
    );
    const meter = document.querySelector(".source-wait-meter");
    expect(meter).toHaveAttribute("aria-hidden", "true");
    // 处理中来源本就不可选，点轨道不得触发切换
    fireEvent.click(meter as Element);
    expect(onToggleSource).not.toHaveBeenCalled();
  });
});

// ===== Task #231：逐图解析进度网格 + 单图重试 =====

describe("GuideSourceList 逐图进度网格（Task #231）", () => {
  it("processing 来源展示逐图网格：每图一个方块，状态 class 正确", () => {
    renderList(
      makeTrip(),
      [
        makeSource({
          inputKind: "images",
          status: "processing",
          imageProgress: {
            total: 3,
            completed: 1,
            failed: 1,
            images: [
              { index: 1, status: "ready", evidenceId: "ev_1" },
              { index: 2, status: "failed", evidenceId: null, failureCode: "extract_failed", failureMessage: "解析失败" },
              { index: 3, status: "processing", evidenceId: null },
            ],
          },
        }),
      ],
    );
    const grid = screen.getByLabelText("图片解析进度");
    expect(grid).toBeInTheDocument();
    const cells = grid.querySelectorAll(".img-progress-cell");
    expect(cells).toHaveLength(3);
    expect(cells[0]).toHaveClass("ready");
    expect(cells[1]).toHaveClass("failed");
    expect(cells[2]).toHaveClass("processing");
  });

  it("failed 图方块可点击触发单图重试（onRetryImage 上抛 sourceId + index）", () => {
    const onRetryImage = vi.fn();
    renderList(
      makeTrip(),
      [
        makeSource({
          sourceId: "src_img",
          inputKind: "images",
          status: "partial",
          imageProgress: {
            total: 2,
            completed: 1,
            failed: 1,
            images: [
              { index: 1, status: "ready", evidenceId: "ev_1" },
              { index: 2, status: "failed", evidenceId: null, failureCode: "timeout", failureMessage: "超时" },
            ],
          },
        }),
      ],
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      {},
      onRetryImage,
    );
    const retryBtn = screen.getByLabelText("重试第2张：失败");
    fireEvent.click(retryBtn);
    expect(onRetryImage).toHaveBeenCalledTimes(1);
    expect(onRetryImage).toHaveBeenCalledWith("src_img", 2);
  });

  it("ready 来源（无失败图）不展示逐图网格", () => {
    renderList(
      makeTrip(),
      [
        makeSource({
          inputKind: "images",
          status: "ready",
          imageProgress: {
            total: 2,
            completed: 2,
            failed: 0,
            images: [
              { index: 1, status: "ready", evidenceId: "ev_1" },
              { index: 2, status: "ready", evidenceId: "ev_2" },
            ],
          },
        }),
      ],
    );
    expect(screen.queryByLabelText("图片解析进度")).toBeNull();
  });

  it("纯文字来源（total=0）不展示逐图网格", () => {
    renderList(
      makeTrip(),
      [makeSource({ inputKind: "text", status: "ready" })],
    );
    expect(screen.queryByLabelText("图片解析进度")).toBeNull();
  });

  it("busy 时 failed 方块禁用（不可点击）", () => {
    const onRetryImage = vi.fn();
    render(
      <GuideSourceList
        trip={makeTrip()}
        sources={[
          makeSource({
            sourceId: "src_busy",
            inputKind: "images",
            status: "partial",
            imageProgress: {
              total: 1,
              completed: 0,
              failed: 1,
              images: [
                { index: 1, status: "failed", evidenceId: null, failureCode: "timeout", failureMessage: "超时" },
              ],
            },
          }),
        ]}
        selectedIds={new Set()}
        locked={false}
        busy={true}
        getOriginal={() => null}
        onOpenOriginal={vi.fn()}
        onToggleSource={vi.fn()}
        onSelectAll={vi.fn()}
        onSelectNone={vi.fn()}
        onSelectStaged={vi.fn()}
        onRetry={vi.fn()}
        onTriggerOcr={vi.fn()}
        onRetryImage={onRetryImage}
        onRemove={vi.fn()}
      />,
    );
    const retryBtn = screen.getByLabelText("重试第1张：失败");
    expect(retryBtn).toBeDisabled();
    fireEvent.click(retryBtn);
    expect(onRetryImage).not.toHaveBeenCalled();
  });
});

describe("GuideSourceList 链接抓取失败态（Task #304 诚实失败）", () => {
  it("抓取失败来源：失败原因可见 + 重试入口，不静默降级", () => {
    const onRetry = vi.fn();
    renderList(
      makeTrip(),
      [
        makeSource({
          sourceId: "src_link_failed",
          inputKind: "link",
          status: "failed",
          sourceUrl: "https://xiaohongshu.com/discovery/item/6ace31c6",
          failureCode: "not_found",
          failureMessage: "笔记抓取失败：链接可能已失效或需要登录，可重试",
        }),
      ],
      vi.fn(),
      vi.fn(),
      vi.fn(),
      onRetry,
    );

    // 失败徽章 + 失败原因整句可见（不是被吞掉的静默降级）
    expect(screen.getByText("失败")).toBeInTheDocument();
    expect(
      screen.getByText("笔记抓取失败：链接可能已失效或需要登录，可重试"),
    ).toBeInTheDocument();

    // 重试入口可点并上抛 sourceId
    fireEvent.click(screen.getByLabelText("重试处理该攻略"));
    expect(onRetry).toHaveBeenCalledWith("src_link_failed");
  });

  it("抓取失败来源勾选框禁用并给出原因提示", () => {
    renderList(
      makeTrip(),
      [
        makeSource({
          sourceId: "src_link_failed",
          inputKind: "link",
          status: "failed",
          sourceUrl: "https://xiaohongshu.com/discovery/item/6ace31c6",
          failureMessage: "笔记抓取失败",
        }),
      ],
    );

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeDisabled();
    // 禁用原因同时进 label title 与 checkbox aria-label（避免「点了没反应」）
    expect(checkbox.getAttribute("aria-label")).toContain("该攻略解析失败，请先重试");
    expect(checkbox.closest("label")?.getAttribute("title")).toContain("解析失败");
  });
});

/**
 * Task #308：图片格失败 / 待处理原因对用户可见，消除「点了重试没反应」的困惑。
 *
 * PD 现场取证：来源 src_50db7a42 第 6 格 failureCode=rejected（内容审核拒绝，
 * 重试确定性再失败），来源2 第 7 格 pending（灰格，尚未就绪无需操作）。四种
 * 「无反应」均为设计行为，本组用例验证前端把原因与「重试是否有效」讲清楚：
 * - failed 格：网格下方短原因 + tooltip；
 * - 审核类确定性失败：重试入口禁用并标注「重试无效」；
 * - 瞬时失败（超时等）：仍可重试；
 * - pending / processing 格：title 说明「尚未就绪 / 解析中」，区分 deferred 需手动。
 * 夹具时间沿用文件顶部 makeSource 的相对时间（距今 5 秒），不硬编码绝对日期。
 */
describe("GuideSourceList 图片失败/待处理原因可见（Task #308）", () => {
  it("审核类确定性失败（rejected）：重试入口禁用并标注「重试无效」，网格下方给出用户语言原因", () => {
    const onRetryImage = vi.fn();
    renderList(
      makeTrip(),
      [
        makeSource({
          sourceId: "src_50db7a42",
          inputKind: "link",
          status: "partial",
          imageProgress: {
            total: 18,
            completed: 17,
            failed: 1,
            images: [
              { index: 5, status: "ready", evidenceId: "ev_5" },
              {
                index: 6,
                status: "failed",
                evidenceId: "ev_retry_3e1ea3a9",
                failureCode: "rejected",
                failureMessage: "图片未通过 AI 平台审核",
              },
              { index: 7, status: "ready", evidenceId: "ev_7" },
            ],
          },
        }),
      ],
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      {},
      onRetryImage,
    );

    // 失败格重试入口禁用（审核拒绝重试必然再失败）
    const futileCell = screen.getByLabelText("第6张：内容审核未通过，重试无效");
    expect(futileCell).toBeDisabled();
    expect(futileCell).toHaveClass("futile");
    // tooltip 标注「重试无效：<原因>」，不暴露英文码值
    expect(futileCell.getAttribute("title")).toBe("重试无效：图片未通过 AI 平台审核");
    fireEvent.click(futileCell);
    expect(onRetryImage).not.toHaveBeenCalled();

    // 网格下方短原因文案（用户语言）
    const note = document.querySelector(".img-failure-note.futile");
    expect(note?.textContent).toContain("第 6 张：内容审核未通过");
    expect(note?.textContent).toContain("重试无效");
  });

  it("非确定性失败（timeout）：仍可重试，网格下方标注「可重试」", () => {
    const onRetryImage = vi.fn();
    renderList(
      makeTrip(),
      [
        makeSource({
          sourceId: "src_b2fcdce9",
          inputKind: "images",
          status: "partial",
          imageProgress: {
            total: 9,
            completed: 8,
            failed: 1,
            images: [
              { index: 6, status: "ready", evidenceId: "ev_6" },
              {
                index: 7,
                status: "failed",
                evidenceId: null,
                failureCode: "timeout",
                failureMessage: "图片处理未完成（中断残留），可重试",
              },
            ],
          },
        }),
      ],
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      {},
      onRetryImage,
    );

    // 瞬时失败保留可重试入口（aria-label 与既有 #231 口径一致）
    const retryCell = screen.getByLabelText("重试第7张：失败");
    expect(retryCell).toBeEnabled();
    expect(retryCell).not.toHaveClass("futile");
    // tooltip 用服务端 failureMessage（用户语言）
    expect(retryCell.getAttribute("title")).toBe("图片处理未完成（中断残留），可重试");
    fireEvent.click(retryCell);
    expect(onRetryImage).toHaveBeenCalledTimes(1);
    expect(onRetryImage).toHaveBeenCalledWith("src_b2fcdce9", 7);

    // 网格下方标注可重试
    const note = document.querySelector(".img-failure-note:not(.futile)");
    expect(note?.textContent).toContain("第 7 张：处理超时");
    expect(note?.textContent).toContain("可重试");
  });

  it("pending 格 title 说明「尚未就绪」：预告态（processing 中）与常规就绪流程均无需手动操作", () => {
    renderList(
      makeTrip(),
      [
        makeSource({
          sourceId: "src_pd2",
          inputKind: "link",
          status: "processing",
          imageProgress: {
            total: 9,
            completed: 0,
            failed: 0,
            images: [
              { index: 6, status: "ready", evidenceId: "ev_6" },
              { index: 7, status: "pending", evidenceId: null, assetPath: "uploads/xhs_pd2/7.jpg" },
            ],
          },
        }),
      ],
    );
    const pendingCell = screen.getByLabelText("第7张：待解析");
    expect(pendingCell.tagName).toBe("SPAN");
    expect(pendingCell.getAttribute("title")).toContain("无需手动操作");
  });

  it("pending 格 title 区分 ocrDeferred：待解析图需点「解析图片」，不误导为无需操作", () => {
    renderList(
      makeTrip(),
      [
        makeSource({
          sourceId: "src_deferred",
          inputKind: "link",
          status: "partial",
          imageOcrDeferred: true,
          imageProgress: {
            total: 2,
            completed: 0,
            failed: 0,
            images: [
              { index: 1, status: "pending", evidenceId: null, assetPath: "uploads/xhs_d/1.jpg" },
              { index: 2, status: "pending", evidenceId: null, assetPath: "uploads/xhs_d/2.jpg" },
            ],
          },
        }),
      ],
    );
    const pendingCell = screen.getByLabelText("第1张：待解析");
    expect(pendingCell.getAttribute("title")).toContain("点上方「解析图片」按钮");
  });

  it("processing 格 title 说明「正在解析中」", () => {
    renderList(
      makeTrip(),
      [
        makeSource({
          sourceId: "src_proc",
          inputKind: "images",
          status: "processing",
          imageProgress: {
            total: 2,
            completed: 0,
            failed: 0,
            images: [
              { index: 1, status: "processing", evidenceId: null },
              { index: 2, status: "pending", evidenceId: null },
            ],
          },
        }),
      ],
    );
    const processingCell = screen.getByLabelText("第1张：解析中");
    expect(processingCell.getAttribute("title")).toContain("正在解析中");
  });

  it("确定性失败（unsupported 格式不支持）同样禁用重试并标注「重试无效」", () => {
    renderList(
      makeTrip(),
      [
        makeSource({
          sourceId: "src_fmt",
          inputKind: "images",
          status: "partial",
          imageProgress: {
            total: 1,
            completed: 0,
            failed: 1,
            images: [
              { index: 1, status: "failed", evidenceId: null, failureCode: "unsupported" },
            ],
          },
        }),
      ],
    );
    const cell = screen.getByLabelText("第1张：图片格式不支持，重试无效");
    expect(cell).toBeDisabled();
    // 无服务端 failureMessage 时用码值兜底的用户语言，不暴露 "unsupported"
    expect(cell.getAttribute("title")).toBe("重试无效：图片格式不支持");
    expect(cell.getAttribute("title")).not.toContain("unsupported");
  });
});

