/**
 * Task #224：来源「处理中」分级读数测试。
 *
 * 重点覆盖：
 * - 阶段推断只依赖确实可靠的信号（图片结算数 / 已提交证据与提及 / 落盘静默时长）；
 * - 只有图片队列给确定比例，其余一律 ratio=null（不画假进度条）；
 * - stalled 边界与异常时间戳兜底（缺失 / 不可解析 / 未来时间一律不误报）；
 * - 计数越界（completed+failed > total、负数）夹紧后不产出非法读数；
 * - Task #215 延迟解析来源不按 done/total 画进度（队列未启动，会显得卡住）。
 */
import { describe, expect, it } from "vitest";
import type { GuideSource } from "@goplay/shared";
import { SOURCE_STALL_AFTER_MS, sourceWaitMeter, sourceWaitShortText } from "./sourceWait";

/** 固定「当前时刻」：所有 updatedAt 都相对它构造，测试不依赖真实时钟 */
const NOW = Date.parse("2026-11-01T00:10:00Z");

function iso(offsetMs: number): string {
  return new Date(NOW - offsetMs).toISOString();
}

function makeSource(overrides: Partial<GuideSource> = {}): GuideSource {
  return {
    sourceId: "src_1",
    sourceVersion: 1,
    inputKind: "text",
    active: true,
    status: "processing",
    evidenceRefs: [],
    mentionRefs: [],
    imageProgress: { total: 0, completed: 0, failed: 0, images: [] },
    importedAt: iso(120_000),
    updatedAt: iso(3_000),
    ...overrides,
  };
}

describe("sourceWaitMeter 状态门控", () => {
  it("非 processing 来源返回 null（UI 不渲染任何等待元素）", () => {
    for (const status of ["ready", "partial", "failed"] as const) {
      expect(sourceWaitMeter(makeSource({ status }), NOW)).toBeNull();
    }
  });

  it("processing 来源必有读数", () => {
    expect(sourceWaitMeter(makeSource({ status: "processing" }), NOW)).not.toBeNull();
  });
});

describe("sourceWaitMeter 阶段推断", () => {
  it("纯文字来源尚未产出：提炼（无确定比例，走扫光）", () => {
    const meter = sourceWaitMeter(makeSource({ inputKind: "text" }), NOW);
    expect(meter).toMatchObject({
      phase: "extract",
      name: "提炼",
      ratio: null,
      mode: "indeterminate",
      done: 0,
      total: 0,
      stalled: false,
    });
    expect(meter?.sentence).toBe("正在提炼文字里的地点和玩法…");
  });

  it("链接来源尚未取到正文：取料（而不是文字口径的提炼）", () => {
    const meter = sourceWaitMeter(makeSource({ inputKind: "link" }), NOW);
    expect(meter?.phase).toBe("fetch");
    expect(meter?.name).toBe("取料");
    expect(meter?.sentence).toBe("正在抓取攻略正文…");
  });

  it("截图来源队列未开始结算：取料 + 下载口径", () => {
    const meter = sourceWaitMeter(
      makeSource({
        inputKind: "images",
        imageProgress: { total: 5, completed: 0, failed: 0, images: [] },
      }),
      NOW,
    );
    expect(meter?.phase).toBe("fetch");
    expect(meter?.sentence).toBe("正在下载攻略图片…");
    expect(meter?.ratio).toBeNull();
  });

  it("图片队列推进中：唯一给确定比例的阶段（done = completed + failed）", () => {
    const meter = sourceWaitMeter(
      makeSource({
        inputKind: "images",
        imageProgress: { total: 5, completed: 2, failed: 1, images: [] },
      }),
      NOW,
    );
    expect(meter).toMatchObject({
      phase: "images",
      name: "读图",
      done: 3,
      total: 5,
      mode: "determinate",
    });
    expect(meter?.ratio).toBeCloseTo(0.6, 6);
    expect(meter?.sentence).toBe("正在读取图片 3/5…");
  });

  it("图片全部结算但还没有提及：明确告知「图片读完了」，避免用户以为卡在图上", () => {
    const meter = sourceWaitMeter(
      makeSource({
        inputKind: "images",
        evidenceRefs: ["ev_1"],
        imageProgress: { total: 2, completed: 2, failed: 0, images: [] },
      }),
      NOW,
    );
    expect(meter?.phase).toBe("extract");
    expect(meter?.sentence).toBe("图片读完了，正在提炼地点和玩法…");
    expect(meter?.ratio).toBeNull();
  });

  it("已有提及产出：阶段前推到归拢（收尾口径）", () => {
    const text = sourceWaitMeter(
      makeSource({ evidenceRefs: ["ev_1"], mentionRefs: ["ev_1:m1"] }),
      NOW,
    );
    expect(text?.phase).toBe("assemble");
    expect(text?.name).toBe("归拢");
    expect(text?.sentence).toBe("内容读到了，正在归拢地点和玩法…");

    const images = sourceWaitMeter(
      makeSource({
        inputKind: "images",
        evidenceRefs: ["ev_1"],
        mentionRefs: ["ev_1:m1"],
        imageProgress: { total: 2, completed: 2, failed: 0, images: [] },
      }),
      NOW,
    );
    expect(images?.phase).toBe("assemble");
  });

  it("Task #215 延迟解析：队列未启动，不按 done/total 画进度（否则显得卡住）", () => {
    const meter = sourceWaitMeter(
      makeSource({
        inputKind: "link",
        imageOcrDeferred: true,
        imageProgress: { total: 4, completed: 0, failed: 0, images: [] },
      }),
      NOW,
    );
    expect(meter?.phase).not.toBe("images");
    expect(meter?.ratio).toBeNull();
    expect(meter?.mode).toBe("indeterminate");
    expect(meter?.total).toBe(4);
  });
});

describe("sourceWaitMeter 正文已抓到窗口（Task #305 hasSourceText）", () => {
  // commitNoteMeta 已落 sourceText、finalize（写证据）尚未完成的窗口：
  // 正文其实已在手，真正在跑的是提炼/装配，不得再报「正在抓取…」。
  it("链接来源已落 sourceText 但无证据：判提炼而非取料", () => {
    const meter = sourceWaitMeter(
      makeSource({ inputKind: "link", sourceText: "三天两夜三亚之旅：第一天后海村冲浪…" }),
      NOW,
    );
    expect(meter?.phase).toBe("extract");
    expect(meter?.name).toBe("提炼");
    expect(meter?.sentence).toBe("正在提炼文字里的地点和玩法…");
  });

  it("图片来源 done===0 无证据但已落 sourceText：判提炼而非下载", () => {
    const meter = sourceWaitMeter(
      makeSource({
        inputKind: "images",
        sourceText: "笔记正文已抓到",
        imageProgress: { total: 5, completed: 0, failed: 0, images: [] },
      }),
      NOW,
    );
    expect(meter?.phase).toBe("extract");
    expect(meter?.sentence).toBe("正在提炼图片里的地点和玩法…");
    expect(meter?.ratio).toBeNull();
  });

  it("图片来源 done===0 无证据且 sourceText 为空：仍判取料（正文尚未抓到）", () => {
    const meter = sourceWaitMeter(
      makeSource({
        inputKind: "images",
        imageProgress: { total: 5, completed: 0, failed: 0, images: [] },
      }),
      NOW,
    );
    expect(meter?.phase).toBe("fetch");
    expect(meter?.sentence).toBe("正在下载攻略图片…");
  });

  it("sourceText 仅空白（未真正抓到正文）等同于无正文：不误判提炼", () => {
    const meter = sourceWaitMeter(
      makeSource({ inputKind: "link", sourceText: "   \n  " }),
      NOW,
    );
    expect(meter?.phase).toBe("fetch");
    expect(meter?.sentence).toBe("正在抓取攻略正文…");
  });
});

describe("sourceWaitMeter 慢档（stalled）", () => {
  it("落盘静默达阈值即升级措辞，但不改进度数字", () => {
    const fresh = sourceWaitMeter(makeSource({ updatedAt: iso(SOURCE_STALL_AFTER_MS - 1_000) }), NOW);
    expect(fresh?.stalled).toBe(false);
    expect(fresh?.sentence).toBe("正在提炼文字里的地点和玩法…");

    const stalled = sourceWaitMeter(makeSource({ updatedAt: iso(SOURCE_STALL_AFTER_MS + 1_000) }), NOW);
    expect(stalled?.stalled).toBe(true);
    expect(stalled?.sentence).toBe("还在提炼要点，这一步比较慢…");
    expect(stalled?.ratio).toBeNull();
  });

  it("阈值边界：恰好 SOURCE_STALL_AFTER_MS 算慢，前一毫秒不算", () => {
    // Task #305：慢档阈值由 60s 上调到 180s——正文抽取 + FlyAI 装配是 2~5 分钟长操作，
    // 60s 会把正常长耗时误报成「这一步比较慢」（Adam #302 诊断的体感差主因之一）
    expect(SOURCE_STALL_AFTER_MS).toBe(180_000);
    expect(sourceWaitMeter(makeSource({ updatedAt: iso(SOURCE_STALL_AFTER_MS - 1) }), NOW)?.stalled)
      .toBe(false);
    expect(sourceWaitMeter(makeSource({ updatedAt: iso(SOURCE_STALL_AFTER_MS) }), NOW)?.stalled)
      .toBe(true);
  });

  it("各阶段的慢档措辞都给出「还在做」的确认，不谎报进度", () => {
    const slow = SOURCE_STALL_AFTER_MS + 10_000;
    const cases: Array<[GuideSource, string]> = [
      [makeSource({ inputKind: "link", updatedAt: iso(slow) }), "抓取比较慢，还在等攻略内容…"],
      [
        makeSource({
          inputKind: "images",
          updatedAt: iso(slow),
          imageProgress: { total: 5, completed: 1, failed: 0, images: [] },
        }),
        "图片还在读取（1/5），这一步比较慢…",
      ],
      [
        makeSource({
          inputKind: "images",
          updatedAt: iso(slow),
          imageProgress: { total: 2, completed: 2, failed: 0, images: [] },
        }),
        "还在提炼要点，这一步比较慢…",
      ],
      [
        makeSource({ updatedAt: iso(slow), mentionRefs: ["ev_1:m1"] }),
        "还在归拢要点，快好了…",
      ],
    ];
    for (const [source, expected] of cases) {
      const meter = sourceWaitMeter(source, NOW);
      expect(meter?.stalled).toBe(true);
      expect(meter?.sentence).toBe(expected);
    }
  });

  it("确定进度在慢档仍按真实比例给（图片队列不受措辞影响）", () => {
    const meter = sourceWaitMeter(
      makeSource({
        inputKind: "images",
        updatedAt: iso(SOURCE_STALL_AFTER_MS + 10_000),
        imageProgress: { total: 4, completed: 3, failed: 0, images: [] },
      }),
      NOW,
    );
    expect(meter?.mode).toBe("determinate");
    expect(meter?.ratio).toBeCloseTo(0.75, 6);
  });

  it("时间戳缺失 / 不可解析 / 在未来（时钟偏移）一律不误报慢档", () => {
    expect(sourceWaitMeter(makeSource({ updatedAt: "" }), NOW)?.stalled).toBe(false);
    expect(sourceWaitMeter(makeSource({ updatedAt: "not-a-date" }), NOW)?.stalled).toBe(false);
    expect(sourceWaitMeter(makeSource({ updatedAt: iso(-300_000) }), NOW)?.stalled).toBe(false);
  });
});

describe("sourceWaitMeter 计数兜底", () => {
  it("completed + failed 超过 total 时夹紧到 total，比例不越界", () => {
    const meter = sourceWaitMeter(
      makeSource({
        inputKind: "images",
        imageProgress: { total: 5, completed: 10, failed: 10, images: [] },
      }),
      NOW,
    );
    expect(meter?.done).toBe(5);
    expect(meter?.total).toBe(5);
    expect(meter?.phase).toBe("extract");
    expect(meter?.ratio).toBeNull();
  });

  it("负数计数归零，落回取料阶段", () => {
    const meter = sourceWaitMeter(
      makeSource({
        inputKind: "images",
        imageProgress: { total: 5, completed: -3, failed: -2, images: [] },
      }),
      NOW,
    );
    expect(meter?.done).toBe(0);
    expect(meter?.phase).toBe("fetch");
  });

  it("total 为负按 0 处理（历史脏数据不炸）", () => {
    const meter = sourceWaitMeter(
      makeSource({ imageProgress: { total: -4, completed: 0, failed: 0, images: [] } }),
      NOW,
    );
    expect(meter?.total).toBe(0);
    expect(meter?.done).toBe(0);
    expect(Number.isFinite(meter?.done ?? Number.NaN)).toBe(true);
  });

  it("now 缺省取真实时钟：updatedAt 很久以前的处理中来源判为慢档", () => {
    const meter = sourceWaitMeter(
      makeSource({ updatedAt: new Date(Date.now() - 600_000).toISOString() }),
    );
    expect(meter?.stalled).toBe(true);
  });
});

describe("sourceWaitShortText 紧凑列表短读数", () => {
  it("有确定比例时带张数，否则只给站名（46% 宽度容不下整句）", () => {
    const determinate = sourceWaitMeter(
      makeSource({
        inputKind: "images",
        imageProgress: { total: 5, completed: 2, failed: 1, images: [] },
      }),
      NOW,
    );
    expect(determinate).not.toBeNull();
    expect(sourceWaitShortText(determinate!)).toBe("读图 3/5");

    const indeterminate = sourceWaitMeter(makeSource(), NOW);
    expect(indeterminate).not.toBeNull();
    expect(sourceWaitShortText(indeterminate!)).toBe("提炼");
  });
});
