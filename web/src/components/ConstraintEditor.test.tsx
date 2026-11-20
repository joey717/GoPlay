import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Constraint } from "@goplay/shared";
import { notifySheetOpened, onSheetOpened } from "../lib/sheetBus";
import ConstraintEditor from "./ConstraintEditor";

afterEach(cleanup);

function makeConstraint(overrides: Partial<Constraint> = {}): Constraint {
  return {
    constraintId: "c-1",
    type: "flight_arrive",
    anchorTime: "2026-11-08T09:40:00",
    dayIndex: 1,
    label: "MU5831 落地 09:40",
    locked: true,
    ...overrides,
  };
}

function renderSheet(props: Partial<ComponentProps<typeof ConstraintEditor>> = {}) {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConstraintEditor
      initialConstraints={[makeConstraint()]}
      totalDays={5}
      startDate="2026-11-08"
      onSave={onSave}
      onCancel={onCancel}
      {...props}
    />,
  );
  return { onSave, onCancel };
}

describe("ConstraintEditor 约束编辑（Task #206）", () => {
  it("已有约束映射为草稿：标签 / Day / 时间；新增表单默认落行程首日 09:00", () => {
    renderSheet();

    expect(screen.getByRole("dialog", { name: "修改约束" })).toBeInTheDocument();
    expect(screen.getByText(/MU5831 落地 09:40/)).toBeInTheDocument();
    expect(screen.getByText("Day1 · 2026-11-08 09:40")).toBeInTheDocument();
    // 「时间」是新增条目的输入框（已有约束只展示在列表行内，不在此回填）
    expect(screen.getByLabelText("时间")).toHaveValue("2026-11-08T09:00");
    expect(screen.getByLabelText("第几天")).toHaveValue(1);
  });

  it("删除一条后保存：交回不含该条的完整列表", () => {
    const { onSave } = renderSheet();

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith([]);
  });

  it("改时间自动推导第几天；新增项保存时补 :00 秒、locked=true，原约束 id 不变", () => {
    const { onSave } = renderSheet();

    fireEvent.change(screen.getByLabelText("时间"), { target: { value: "2026-11-10T15:30" } });
    expect(screen.getByLabelText("第几天")).toHaveValue(3);

    fireEvent.change(screen.getByLabelText("备注（可选）"), {
      target: { value: "海棠湾酒店入住 15:30" },
    });
    fireEvent.click(screen.getByRole("button", { name: /添加这条约束/ }));
    expect(screen.getByText(/海棠湾酒店入住 15:30/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    const saved = onSave.mock.calls[0][0] as Constraint[];
    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject({
      constraintId: "c-1",
      type: "flight_arrive",
      anchorTime: "2026-11-08T09:40:00",
      dayIndex: 1,
      label: "MU5831 落地 09:40",
      locked: true,
    });
    expect(saved[1]).toMatchObject({
      type: "flight_arrive",
      anchorTime: "2026-11-10T15:30:00",
      dayIndex: 3,
      label: "海棠湾酒店入住 15:30",
      locked: true,
    });
    expect(saved[1].constraintId).not.toBe("");
  });

  it("备注留空时用「类型 + 时间」兜底，不会存空标签", () => {
    const { onSave } = renderSheet({ initialConstraints: [] });

    fireEvent.change(screen.getByLabelText("时间"), { target: { value: "2026-11-09T12:00" } });
    fireEvent.click(screen.getByRole("button", { name: /添加这条约束/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    const saved = onSave.mock.calls[0][0] as Constraint[];
    expect(saved).toHaveLength(1);
    expect(saved[0].label).toBe("航班到达 12:00");
    expect(saved[0].dayIndex).toBe(2);
  });

  it("时间超出行程区间时「第几天」收敛到总天数上界", () => {
    renderSheet({ totalDays: 3 });

    fireEvent.change(screen.getByLabelText("时间"), { target: { value: "2026-11-20T10:00" } });

    expect(screen.getByLabelText("第几天")).toHaveValue(3);
  });

  it("取消只回调 onCancel，不交回任何约束", () => {
    const { onSave, onCancel } = renderSheet();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("inline 形态不渲染遮罩 / 标题 / 自带按钮，增删即时经 onChange 上抛", () => {
    const onChange = vi.fn();
    render(
      <ConstraintEditor
        variant="inline"
        initialConstraints={[]}
        totalDays={5}
        startDate="2026-11-08"
        onSave={vi.fn()}
        onCancel={vi.fn()}
        onChange={onChange}
      />,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
    expect(screen.getByText(/还没有录入约束/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /添加这条约束/ }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as Constraint[];
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      type: "flight_arrive",
      anchorTime: "2026-11-08T09:00:00",
      dayIndex: 1,
      label: "航班到达 09:00",
      locked: true,
    });
  });

  it("sheet 形态挂载即广播 constraint；其他浮层打开时自关（互斥）", () => {
    const seen: string[] = [];
    const off = onSheetOpened((kind) => seen.push(kind));
    const { onCancel } = renderSheet();

    expect(seen).toContain("constraint");
    expect(onCancel).not.toHaveBeenCalled();

    act(() => {
      notifySheetOpened("oplog");
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    off();
  });
});

// ===== Task #378：移动端适配 —— 320 视口 InitFlow / 约束编辑器无横向溢出契约 =====
// jsdom 无真实布局，「不越屏」这类布局事实只能对样式源断言（同 ShareView.test 范式）：
// - `.init-dates` 的 1fr 隐含最小值 auto，date 控件固有宽 ≈140px，320 视口两列撑破卡片、
//   结束日期越出屏幕右缘（改前实测越界 9px）；minmax(0,1fr) 才允许轨道收缩；
// - `.init-crow .grow` flex 项默认 min-width:auto，备注内容长时不收缩会把行撑出屏幕；
// - `.init-field input/select` 必须允许在 grid/flex 轨道内收缩到比控件固有宽更窄。
describe("ConstraintEditor 移动端无横向溢出样式契约（Task #378）", () => {
  it("样式契约：日期两列轨道可收缩、备注行可收缩、输入框允许收缩", () => {
    const css = readStylesCss();
    expect(cssRuleBody(css, ".init-dates")).toContain(
      "grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)",
    );
    expect(cssRuleBody(css, ".init-crow .grow")).toContain("min-width: 0");
    expect(cssRuleBody(css, ".init-field input,\n.init-field select")).toContain("min-width: 0");
  });
});

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
