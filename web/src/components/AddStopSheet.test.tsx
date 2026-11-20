/**
 * Task #334：AddStopSheet 手动添加点位——FlyAI 搜索传参形态与保守匹配。
 *
 * 验收口径：
 * - keyword 传用户输入的**裸词**，城市走 destination 结构化参数；父景区名不再
 *   拼进 keyword（拼接形态实测召回为空或不稳定，「三亚 西」0 条 vs 裸词 10 条）；
 * - 保守匹配：名称完全相等 > 名称互相包含；同档多候选用「地址含父景区名」
 *   字面包含收窄；严禁编辑距离/模糊相似度（#233 决策）——不相关名称即使
 *   排在结果首位也不采纳；
 * - 无命中 / 搜索报错维持静默降级 custom（不阻止添加），onConfirm 的
 *   meta.matchedPoi=false 供上层展示可感知提示（提示条链路见
 *   DayContent.addStopNotice.test.tsx，mock 隔离另文件）。
 */
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import AddStopSheet from "./AddStopSheet";
import type { CustomStopInput } from "../hooks/useTrip";
import { searchPoi, type PoiSearchResult } from "../api/client";

vi.mock("../api/client", async (importOriginal) => {
  // 保留 ApiError 等真实实现，仅桩掉网络函数
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, searchPoi: vi.fn() };
});

const searchPoiMock = vi.mocked(searchPoi);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ===== 夹具 =====

function makePoi(id: string, name: string, address: string | null = null): PoiSearchResult {
  return {
    id,
    name,
    address,
    category: "景点",
    description: null,
    freePoiStatus: null,
    poiLevel: null,
    coords: null,
    mainPic: null,
    listRank: null,
    ticketInfo: null,
    jumpUrl: null,
  };
}

function envelope(normalized: PoiSearchResult[]) {
  return {
    raw: {},
    normalized,
    toolName: "search_poi",
    params: {},
    capturedAt: "2026-11-03T00:00:00Z",
    latencyMs: 1,
    integrationPath: "cli" as const,
  };
}

function renderSheet(props: {
  visitName?: string;
  cityName?: string;
  onConfirm?: (input: CustomStopInput, meta: { matchedPoi: boolean }) => void;
  onClose?: () => void;
}) {
  return render(
    <AddStopSheet
      visitName={props.visitName ?? "蜈支洲岛"}
      cityName={props.cityName ?? "三亚"}
      onConfirm={props.onConfirm ?? (() => {})}
      onClose={props.onClose ?? (() => {})}
    />,
  );
}

/** 填名称并点击「添加」，等待搜索落地后断言 onConfirm 载荷 */
type ConfirmSpy = Mock<(input: CustomStopInput, meta: { matchedPoi: boolean }) => void>;

async function submitName(
  name: string,
  onConfirm: ConfirmSpy,
  props: { visitName?: string; cityName?: string } = {},
): Promise<CustomStopInput | null> {
  renderSheet({ ...props, onConfirm });
  fireEvent.change(screen.getByPlaceholderText("如：入口左转小吃店"), {
    target: { value: name },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
  });
  return onConfirm.mock.calls[0]?.[0] ?? null;
}

// ===== 传参形态（Task #334 核心缺陷） =====

describe("AddStopSheet 搜索传参：裸词 + destination", () => {
  it("keyword 传用户输入裸词，城市走 destination，父景区名不拼进 keyword", async () => {
    searchPoiMock.mockResolvedValue(envelope([makePoi("poi_1", "情人桥", "三亚蜈支洲岛旅游区")]));
    const onConfirm = vi.fn();
    const input = await submitName("情人桥", onConfirm);

    expect(searchPoiMock).toHaveBeenCalledTimes(1);
    expect(searchPoiMock).toHaveBeenCalledWith("情人桥", "三亚");
    // 缺陷回归锁：绝不允许把父景区名拼进 keyword（「蜈支洲岛 情人桥」形态）
    const query = searchPoiMock.mock.calls[0][0];
    expect(query).not.toContain("蜈支洲岛");
    expect(input?.matchedPoi?.id).toBe("poi_1");
    expect(onConfirm.mock.calls[0][1]).toEqual({ matchedPoi: true });
  });

  it("cityName 为空串时 destination 传 undefined（不误传空串）", async () => {
    searchPoiMock.mockResolvedValue(envelope([]));
    await submitName("情人桥", vi.fn(), { cityName: "" });
    expect(searchPoiMock).toHaveBeenCalledWith("情人桥", undefined);
  });
});

// ===== 保守匹配策略 =====

describe("AddStopSheet 保守匹配（严禁模糊相似度）", () => {
  it("同名多候选用「地址含父景区名」字面包含收窄", async () => {
    searchPoiMock.mockResolvedValue(
      envelope([
        makePoi("poi_other", "情人桥", "云南省丽江市玉龙雪山景区"),
        makePoi("poi_target", "情人桥", "海南省三亚市海棠区三亚蜈支洲岛旅游区"),
      ]),
    );
    const input = await submitName("情人桥", vi.fn());
    expect(input?.matchedPoi?.id).toBe("poi_target");
  });

  it("完全相等优先于互相包含（即使包含候选排在前面）", async () => {
    searchPoiMock.mockResolvedValue(
      envelope([
        makePoi("poi_contains", "蜈支洲岛情人桥观景台", "三亚蜈支洲岛"),
        makePoi("poi_exact", "情人桥", "三亚蜈支洲岛旅游区"),
      ]),
    );
    const input = await submitName("情人桥", vi.fn());
    expect(input?.matchedPoi?.id).toBe("poi_exact");
  });

  it("无完全相等时接受互相包含（搜索词 ⊂ POI 名）", async () => {
    searchPoiMock.mockResolvedValue(
      envelope([makePoi("poi_bath", "蜈支洲岛海滨浴场", "三亚蜈支洲岛")]),
    );
    const input = await submitName("海滨浴场", vi.fn());
    expect(input?.matchedPoi?.id).toBe("poi_bath");
  });

  it("不做模糊匹配：字面无包含关系的候选一律不采纳（#233 决策）", async () => {
    searchPoiMock.mockResolvedValue(
      envelope([
        makePoi("poi_unrelated_1", "三亚湾", "海南省三亚市"),
        makePoi("poi_unrelated_2", "情人岛码头", "三亚蜈支洲岛"),
      ]),
    );
    const onConfirm = vi.fn();
    const input = await submitName("亚龙湾", onConfirm);
    expect(input?.matchedPoi ?? null).toBeNull();
    expect(onConfirm.mock.calls[0][1]).toEqual({ matchedPoi: false });
  });
});

// ===== 降级 custom（静默不阻止 + 可感知） =====

describe("AddStopSheet 降级 custom", () => {
  it("0 结果：仍确认添加（matchedPoi=null），meta 标记未命中", async () => {
    searchPoiMock.mockResolvedValue(envelope([]));
    const onConfirm = vi.fn();
    const input = await submitName("入口左转小吃店", onConfirm);
    expect(input).not.toBeNull();
    expect(input?.name).toBe("入口左转小吃店");
    expect(input?.matchedPoi ?? null).toBeNull();
    expect(onConfirm.mock.calls[0][1]).toEqual({ matchedPoi: false });
  });

  it("搜索抛错：吞错降级 custom，不阻止添加", async () => {
    searchPoiMock.mockRejectedValue(new Error("FLYAI_QUOTA_EXHAUSTED"));
    const onConfirm = vi.fn();
    const input = await submitName("情人桥", onConfirm);
    expect(input?.matchedPoi ?? null).toBeNull();
    expect(onConfirm.mock.calls[0][1]).toEqual({ matchedPoi: false });
  });
});

