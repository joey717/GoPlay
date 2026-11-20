/**
 * Task #285：首轮评测套件 first28 → first33（用例文档 v1.4 §5「首轮 33 条」权威清单）。
 *
 * v1.4 §5 首轮 33 条（line 156 逐条枚举，标「首轮＝是」者）：
 *   E3 E5 E6 E8 E9 · A1 A3 A4 A5 A7 A9 A10 A11 A13 · S1 S2 S3 S5 S7 S10 S12 S13 ·
 *   C1 C2 C4 · Q1 Q3 Q5 Q7 · O1 O2 O3 O8
 *
 * 与既有 FIRST28 数组的差异（核对结论，写进 Task #285 报告）：
 * - FIRST28 数组实为 29 条——多含 **S11**（v1.2 新增、Task #281 实现，但 v1.4 标
 *   「首轮＝否（随 #278 转绿入回归）」，**不在首轮 33 条内**）；
 * - FIRST28 去掉 S11 恰为 28 条 ＝ §5 33 条减去 v1.4 新增 5 条（E9/A13/S12/S13/Q7），逐条吻合；
 * - C7（v1.3 新增、L4/机）v1.4 标「首轮＝否」，同样不在 33 条内（仅 case-mapping 标注实现状态）。
 *
 * 故 FIRST33 按 §5 权威 id 清单**显式选取**（而非 FIRST28 全量 ＋ 新增），天然排除 S11/C7，
 * 并防止后续用例增删导致首轮集合漂移。SUITES.first28 保留原 29 条数组（含 S11，作转绿回归基线）。
 */

import {
  FIRST28,
  SMOKE_IDS as FIRST28_SMOKE_IDS,
  type EvalCase,
} from "./first28.js";
import { V14_CASES } from "./v14Cases.js";

// 用例元数据类型统一从 first28.ts（定义处）转出，供 runner / v14Cases 复用
export type {
  EvalCase,
  CaseContext,
  ImplStatus,
  BacklogTag,
  Judgment,
  Layer,
} from "./first28.js";
export { HARNESS_SELF_CHECK_ID } from "./first28.js";

/**
 * v1.4 §5 首轮 33 条 id 清单（权威枚举，顺序＝文档 §5 分层序）。
 * S11（首轮＝否，随 #278 转绿入回归）与 C7（首轮＝否）刻意不列入。
 */
export const FIRST33_IDS: readonly string[] = [
  "E3", "E5", "E6", "E8", "E9",
  "A1", "A3", "A4", "A5", "A7", "A9", "A10", "A11", "A13",
  "S1", "S2", "S3", "S5", "S7", "S10", "S12", "S13",
  "C1", "C2", "C4",
  "Q1", "Q3", "Q5", "Q7",
  "O1", "O2", "O3", "O8",
];

/** 全量用例池（既有 FIRST28 数组 ＋ v1.4 新增 5 条），按 id 建索引供首轮清单选取 */
const CASE_POOL: ReadonlyMap<string, EvalCase> = new Map(
  [...FIRST28, ...V14_CASES].map((evalCase) => [evalCase.id, evalCase]),
);

/** 首轮 33 条：按 §5 权威清单显式选取（缺条即抛错，杜绝静默漏项） */
export const FIRST33: EvalCase[] = FIRST33_IDS.map((id) => {
  const found = CASE_POOL.get(id);
  if (found === undefined) {
    throw new Error(`[first33] v1.4 §5 首轮清单 id「${id}」在用例池中缺失（FIRST28 ＋ V14_CASES 未覆盖）`);
  }
  return found;
});

/** runner 套件表（唯一来源）：默认 first33；first28 保留原数组（含 S11）作转绿回归基线 */
export const SUITES: Record<string, EvalCase[]> = {
  first28: FIRST28,
  first33: FIRST33,
};

/**
 * 烟雾子集（纯快层机器用例，验证 runner 全链路）：
 * first28 五条（E6/A9/A10/S7/O8）＋ v1.4 新增 A13（canonicalGroups 死判，纯代码无 planner/无网）。
 * E9/Q7 依赖抽取缓存与 UI 截图，其重跑留 Task #286，不进本轮烟雾。
 */
export const SMOKE_IDS: string[] = [...FIRST28_SMOKE_IDS, "A13"];
