import { describe, expect, it } from "vitest";
import type { Operation } from "@goplay/shared";
import { BATCH_REJECTION_GUIDANCE } from "@goplay/shared";
import type { GuideDraftApplyResult } from "../api/client";
import { buildDraftApplyNotice, isSnippetOnlyApplySuccess } from "./draftApplyNotice";

function makeResult(overrides: Partial<GuideDraftApplyResult> = {}): GuideDraftApplyResult {
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
    attachedOptionGroupCount: 0,
    // 服务端 buildApplyMessage 已把 requirementSummary 拼进 message（前端不重复展开）
    message: "已按攻略草案更新行程。日期指令：「后海」Day 3 已满足",
    ...overrides,
  };
}

const lockOp: Operation = {
  op: "lock",
  subjectRef: { kind: "visit", id: "visit_houhai" },
  value: true,
  reason: "锁定项",
};

describe("buildDraftApplyNotice（任务 125 应用结果摘要）", () => {
  it("未选冲突逐条「保持原状」+ 自动归类逐条，head 沿用服务端 message", () => {
    const notice = buildDraftApplyNotice(
      makeResult({
        appliedConflictIds: ["cf_1"],
        unselectedConflicts: [
          {
            conflictId: "cf_2",
            subjectLabel: "三亚后海村",
            detail: "「三亚后海村」当前已锁定，默认不会移动",
          },
          { conflictId: "cf_3", subjectLabel: "第一市场", detail: "" },
        ],
        autoClassifications: [
          {
            visitId: "visit_sanhe",
            visitName: "三和风味馆",
            parentVisitId: "visit_houhai",
            parentName: "三亚后海村",
            evidenceMentionRefs: [],
            reason: "补充句提到后海内用餐",
          },
        ],
      }),
    );
    expect(notice.head).toBe("已按攻略草案更新行程。日期指令：「后海」Day 3 已满足");
    expect(notice.details).toEqual([
      "「三亚后海村」保持原状：「三亚后海村」当前已锁定，默认不会移动",
      "「第一市场」保持原状",
      "三和风味馆 已归入「三亚后海村」内部行程",
    ]);
  });

  it("有拒绝时 head 切换为拒绝计数文案，details 前置拒绝摘要与逐条可读原因", () => {
    const notice = buildDraftApplyNotice(
      makeResult({
        applied: [lockOp],
        rejected: [{ op: lockOp, reason: "[G1] visit locked" }],
        rejectedCount: 1,
        rejectSummary: "1 项调整因安全规则被跳过（已锁定项）",
        message: "已应用 1 项",
      }),
    );
    expect(notice.head).toBe("已应用 1 项，另有 1 项调整因安全规则被跳过");
    expect(notice.details).toEqual([
      "1 项调整因安全规则被跳过（已锁定项）",
      "该内容已锁定，AI 不会改动（如需调整请先手动解锁或明确指定）",
    ]);
  });

  it("整批拒绝：head 明示行程结构未变更并附带攻略提示计数", () => {
    const notice = buildDraftApplyNotice(
      makeResult({
        rejected: [{ op: lockOp, reason: "[threshold] 违规率 45%" }],
        rejectedCount: 1,
        allRejected: true,
        attachedSnippetCount: 2,
      }),
    );
    expect(notice.head).toBe("1 项调整因安全规则被跳过，行程结构未变更（已添加 2 条攻略提示）");
  });

  it("旧服务端响应：unselectedConflicts/autoClassifications 缺省时 details 为空，可退回轻提示", () => {
    const notice = buildDraftApplyNotice(makeResult());
    expect(notice.head).toBe("已按攻略草案更新行程。日期指令：「后海」Day 3 已满足");
    expect(notice.details).toEqual([]);
  });

  it("Task #250 appliedSummary：message 未包含时补为首条明细（说明实际发生了什么）", () => {
    const notice = buildDraftApplyNotice(
      makeResult({
        applied: [lockOp],
        message: "已按攻略草案更新行程",
        appliedSummary: "实际调整：移出 3 项、新增 2 项",
        unselectedConflicts: [{ conflictId: "cf_2", subjectLabel: "西岛", detail: "" }],
      }),
    );
    expect(notice.head).toBe("已按攻略草案更新行程");
    expect(notice.details).toEqual(["实际调整：移出 3 项、新增 2 项", "「西岛」保持原状"]);
  });

  it("Task #250 appliedSummary：message 已拼接时不重复展示；空串按缺省处理", () => {
    const summary = "实际调整：移出 3 项、新增 2 项";
    const included = buildDraftApplyNotice(
      makeResult({ message: `已按攻略草案更新行程。${summary}`, appliedSummary: summary }),
    );
    expect(included.details).toEqual([]);

    const empty = buildDraftApplyNotice(makeResult({ appliedSummary: "" }));
    expect(empty.details).toEqual([]);
  });

  it("Task #253 部分拒绝：head 被本地文案替换时仍保留 appliedSummary（不能丢实际调整）", () => {
    const summary = "实际调整：移出 1 项、新增 2 项";
    const notice = buildDraftApplyNotice(
      makeResult({
        applied: [lockOp],
        rejected: [{ op: lockOp, reason: "[G1] visit locked" }],
        rejectedCount: 1,
        rejectSummary: "1 项调整因安全规则被跳过（已锁定项）",
        // 服务端 message 里带 summary，但 head 会被部分拒绝文案覆盖
        message: `已应用 1 项。${summary}`,
        appliedSummary: summary,
      }),
    );
    expect(notice.head).toBe("已应用 1 项，另有 1 项调整因安全规则被跳过");
    // 最终 head 不含 summary → 必须补进 details，且拒绝明细排在最前
    expect(notice.details[0]).toBe("1 项调整因安全规则被跳过（已锁定项）");
    expect(notice.details).toContain(summary);
  });

  it("Task #253 整批拒绝：head 与 message 都无 summary 时仍补进 details", () => {
    const summary = "实际调整：移出 2 项";
    const notice = buildDraftApplyNotice(
      makeResult({
        rejected: [{ op: lockOp, reason: "[threshold] 违规率 45%" }],
        rejectedCount: 1,
        allRejected: true,
        message: "",
        appliedSummary: summary,
      }),
    );
    expect(notice.head).toContain("行程结构未变更");
    expect(notice.details).toContain(summary);
  });
});

describe("Task #263 snippet-only 应用成功语义", () => {
  it("applied 为空但攻略提示已挂载：kind=success，文案按「行程结构无需变更 + N 条攻略提示」", () => {
    const result = makeResult({
      applied: [],
      attachedSnippetCount: 3,
      // 服务端 message 即便是空串（旧版本 / 异常），也不能让成功结果变成空白或失败提示
      message: "",
    });
    expect(isSnippetOnlyApplySuccess(result)).toBe(true);

    const notice = buildDraftApplyNotice(result);
    expect(notice.kind).toBe("success");
    expect(notice.head).toBe("行程结构无需变更，已添加 3 条攻略提示");
    expect(notice.details).toEqual([]);
  });

  it("旧服务端 no-op 措辞不会污染 snippet-only 成功文案", () => {
    const notice = buildDraftApplyNotice(
      makeResult({
        applied: [],
        attachedSnippetCount: 2,
        message: "草案无可应用的变更（可能已被应用过）",
      }),
    );
    expect(notice.kind).toBe("success");
    expect(notice.head).toBe("行程结构无需变更，已添加 2 条攻略提示");
  });

  it("攻略提示与实用参考同时挂载时一并计数（与后端 supplement 同口径）", () => {
    const notice = buildDraftApplyNotice(
      makeResult({
        applied: [],
        attachedSnippetCount: 2,
        attachedOptionGroupCount: 1,
        message: "",
      }),
    );
    expect(notice.kind).toBe("success");
    expect(notice.head).toBe("行程结构无需变更，已添加 2 条攻略提示和 1 组实用参考");
  });

  it("确实零变更（无操作 / 无提示）不是成功：kind=noop，保留服务端 message", () => {
    const result = makeResult({ applied: [], attachedSnippetCount: 0, message: "草案无可应用的变更（可能已被应用过）" });
    expect(isSnippetOnlyApplySuccess(result)).toBe(false);

    const notice = buildDraftApplyNotice(result);
    expect(notice.kind).toBe("noop");
    expect(notice.head).toBe("草案无可应用的变更（可能已被应用过）");
  });

  it("有实际操作时 kind=success；message 缺失时兜底本地成功文案", () => {
    const notice = buildDraftApplyNotice(
      makeResult({ applied: [lockOp], attachedSnippetCount: 1, message: "" }),
    );
    expect(notice.kind).toBe("success");
    expect(notice.head).toBe("已按攻略草案更新行程（1 项操作）");
  });

  it("部分拒绝 kind=partial、整批拒绝 kind=skipped（与成功语义互斥）", () => {
    const partial = buildDraftApplyNotice(
      makeResult({
        applied: [lockOp],
        rejected: [{ op: lockOp, reason: "[G1] visit locked" }],
        rejectedCount: 1,
        attachedSnippetCount: 1,
      }),
    );
    expect(partial.kind).toBe("partial");

    const skipped = buildDraftApplyNotice(
      makeResult({
        rejected: [{ op: lockOp, reason: "[threshold] 违规率 45%" }],
        rejectedCount: 1,
        allRejected: true,
        attachedSnippetCount: 1,
      }),
    );
    expect(skipped.kind).toBe("skipped");
    expect(skipped.head).toContain("（已添加 1 条攻略提示）");
  });
});

// ===== Task #379（老队列 #324）：整批拒绝用户文案改为可操作引导 =====
// 单点常量契约：原因一句 + 动作建议一句 + 安抚一句；不得出现阈值数字 / 违规率等技术措辞；
// 草案通道整批拒绝时 details 经 shared describeRejections 单点映射携带该引导。
describe("整批拒绝文案契约（Task #379）", () => {
  it("单点常量：原因 + 动作建议齐备、不提阈值；整批拒绝 details 携带引导", () => {
    // 原因一句
    expect(BATCH_REJECTION_GUIDANCE).toContain("被安全护栏整批拦截未生效");
    // 动作建议一句
    expect(BATCH_REJECTION_GUIDANCE).toContain("建议缩小单次改动范围，或拆成多条指令分步执行");
    // 安抚一句（锁定 / 已购不受影响）
    expect(BATCH_REJECTION_GUIDANCE).toContain("已被锁定点位与已购项目不会被 AI 改动");
    // 不得出现阈值数字与「违规率」等技术措辞
    expect(BATCH_REJECTION_GUIDANCE).not.toContain("30%");
    expect(BATCH_REJECTION_GUIDANCE).not.toContain("违规率");

    const notice = buildDraftApplyNotice(
      makeResult({
        rejected: [{ op: lockOp, reason: "[threshold] 违规率超过30%，整批拒绝" }],
        rejectedCount: 1,
        allRejected: true,
      }),
    );
    expect(notice.kind).toBe("skipped");
    expect(notice.details).toContain(BATCH_REJECTION_GUIDANCE);
    // 服务端 threshold 占位原文不得透传给用户
    expect(notice.details.join("\n")).not.toContain("违规率超过30%");
  });
});
