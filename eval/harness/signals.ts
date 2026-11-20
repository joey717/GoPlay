/**
 * Task #286：评测运行期信号——用例主动请求「非 pass/fail」的第三态处置。
 *
 * 独立小模块（runner 与 cases 双向引用它，避免 runner ↔ first33 ↔ v14Cases 循环导入）。
 */

/**
 * PD 裁定信号：用例机器部分已正确执行（matcher/断言无缺陷），但结论须由 PD 人工裁定，
 * 不宜自动判 pass（未达硬阈值）也不宜判 fail（非 harness/功能缺陷）。
 *
 * runner 捕获后落 **blocked**（result="blocked"），detail 取 reason，证据日志保留完整逐条清单。
 * 典型：E9 recall 修复评测侧 artifact 后仍 < 0.8，缺口为真实抽取质量问题（golden borderlineAdjudicator=PD）。
 */
export class PdAdjudicationSignal extends Error {
  /** 单列交 PD 裁的清单（逐条），进报告「PD 待裁项」 */
  readonly pdItems: string[];

  constructor(reason: string, pdItems: string[] = []) {
    super(reason);
    this.name = "PdAdjudicationSignal";
    this.pdItems = pdItems;
  }
}

/** 运行期错误是否为 PD 裁定信号（runner 据此区分 blocked 与 fail） */
export function isPdAdjudicationSignal(error: unknown): error is PdAdjudicationSignal {
  return error instanceof PdAdjudicationSignal;
}
