/**
 * F11 操作集类型契约（PRD v1.1 §9：七类意图 / 八个 op 名，EntityRef/ContainerRef 寻址）。
 *
 * 位置约定（PRD §9.4/§9.5）：
 * - order / toOrder 统一 0-based，界面展示时 +1；
 * - dayIndex 从 1 开始；越界索引一律拒绝（reject），不默默夹取；
 * - 每条操作必须携带 reason（模型输出与人审均依赖）；
 * - toOrder 在 transfer 中可空（null = 追加到目标容器末尾）。
 *
 * 确认策略（PRD §10.2，与 v1.0 needsProposal 语义保持一致）：
 * - 低风险 plan/move/transfer/setTime/setDuration 可直接应用；
 * - remove/setPurchase/lock 默认归入 needsProposal，由用户确认后
 *   以 confirmed=true 二次下发执行。
 *
 * 适用矩阵（PRD §9.4）：
 * - Day：setTime(target=dayDepart)；
 * - 普通/大景区 Visit：plan、move、transfer、remove、setTime、setDuration、setPurchase、lock；
 *   普通 Visit 另支持 classifyVisitAsStop（强证据归入大景区，Task #122 归类族）；
 * - 内部 Stop：plan、move、remove、setDuration；transfer 仅归类纠正
 *   （Visit ↔ pendingPool / 另一 Visit / visitPool，不得改变 dayIndex）；
 * - Lodging：setTime、setPurchase、lock（移除/更换走住宿专用行为，不套点位语义）；
 * - 未安排 Point：plan / transfer（进入 Day 时创建 Visit）、remove（仅候选管理阶段）。
 *
 * 归类族红线（Task #122/#199）：classifyVisitAsStop 只消费 ordinary Visit；AI 通道必须
 * 携带可追溯至来源与目标两侧的强关系证据，弱证据一律拒绝；用户手动通道（user_manual /
 * user_confirmed）允许证据为空，但来源 locked / bought 仍一律拒绝（用户确认也不豁免）。
 * 它不触碰既有 Stop，不放松 pending 的 G1/G3 禁令。
 */

import type { ContainerRef, EntityRef, Trip } from "./index.js";

/** 操作来源（PRD §9.6）：G3 锁定护栏按此分流——AI 不得动已购/已锁，用户明确操作可以 */
export type OperationActor = "user_manual" | "ai_proposed" | "user_confirmed";

/** plan 影响范围声明：单天或全程（全量重排须用户明确提出并二次确认，由上层把关） */
export type PlanScopeRef = { kind: "day"; dayIndex: number } | { kind: "allDays" };

/** plan 单条安排：把 subjectRef 放到 containerRef 的 order 位（0-based） */
export interface PlanAssignment {
  /** visit（已排期/候选壳）、point（globalPool 中，进入 Day 时创建 ordinary Visit）或 attached stop */
  subjectRef: EntityRef;
  /** day（visit/point 的编排位置）或 visit（stop 的父内编排位置） */
  containerRef: ContainerRef;
  order: number; // 0-based
}

/** setTime 的目标语义：start/end 只适用于 Visit 与 Lodging；dayDepart 只适用于 Day */
export type SetTimeTarget = "start" | "end" | "dayDepart";

/**
 * 八个 op 名（PRD §9.3：保留七个意图类与八个操作名）。
 * rev2 附录 A 住宿多候选扩展：新增创建族 op addLodgingCandidate——按目标容器
 * （lodging）扩展创建族（与 plan 将 point 编入 Day 时创建 Visit 壳同族），
 * 用户语义分类不变，不新增语义动词。
 */
export type Operation =
  | { op: "plan"; scopeRef: PlanScopeRef; assignments: PlanAssignment[]; reason: string }
  | { op: "move"; subjectRef: EntityRef; containerRef: ContainerRef; toOrder: number; reason: string }
  | {
      op: "transfer";
      subjectRef: EntityRef;
      fromContainerRef: ContainerRef;
      toContainerRef: ContainerRef;
      /** null = 追加到目标容器末尾；仅 toContainerRef=visit 时有意义 */
      toOrder: number | null;
      reason: string;
    }
  | { op: "remove"; subjectRef: EntityRef; fromContainerRef: ContainerRef; reason: string }
  | { op: "setTime"; subjectRef: EntityRef; value: string; target: SetTimeTarget; reason: string }
  | { op: "setDuration"; subjectRef: EntityRef; minutes: number; reason: string }
  | {
      op: "setPurchase";
      subjectRef: EntityRef;
      /** LodgingPlan 无 noTicket 档，setPurchase 对 lodging 使用前三档 */
      value: "bought" | "toBuy" | "unknown" | "noTicket";
      reason: string;
    }
  | { op: "lock"; subjectRef: EntityRef; value: boolean; reason: string }
  /** 创建族（rev2 住宿多候选）：向 dayIndex 当天住宿区追加酒店候选；hotelId 指向 trip.hotelRegistry 的 key */
  | { op: "addLodgingCandidate"; dayIndex: number; hotelId: string; reason: string }
  /**
   * 归类族（Task #122）：把 ordinary Visit 原子转换为 large_attraction Visit 的内部 Stop。
   * 证据门槛（Task #199 按通道分流）：AI 通道 evidenceMentionRefs 必须全部可在
   * trip.evidences/mentions 中解析，且可追溯至来源与目标两侧（弱证据一律拒绝，AI
   * 不得自动归类）；用户手动通道允许为空（用户的选择本身即依据），显式引用仍须可解析。
   * 来源 locked / bought 一律拒绝。执行后原 Visit 删除、身份转为 Stop（证据与 snippets
   * 全量迁移），详见 applyClassifyVisitAsStop。
   */
  | {
      op: "classifyVisitAsStop";
      /** 被归类的普通 Visit（ordinary）；执行后原 Visit 从行程移除、身份转为 Stop */
      visitId: string;
      /** 目标大景区 Visit（large_attraction）；生成的 Stop 挂入其 childStopRefs */
      parentVisitId: string;
      /** 插入位置（0-based，parent.childStopRefs）；null = 追加到末尾；复用既有 Stop 时忽略 */
      toOrder: number | null;
      /** 强关系证据，格式 "evidenceId:mentionId"；须可追溯至来源与目标（G1 校验） */
      evidenceMentionRefs: string[];
      reason: string;
    };

/** F11 模型输出契约（PRD §9.5）：operations + unplaced + proposedNew + clarify */
export interface OperationSet {
  /** 模型输出必带；服务端按其校验 baseVersion 一致性后才可应用 */
  baseVersion: number;
  operations: Operation[];
  unplaced: { subjectRef: EntityRef; reason: string }[];
  /**
   * AI 推荐的新点位：name 为点位本名；reason 为 AI 给出的位置/推荐描述
   * （如「距第一市场约3公里，登顶可俯瞰三亚全景」）。FlyAI 搜索未命中时，
   * 该描述降级为自定义点位的 address 依据（前端标注「为AI提取」），无则 null。
   */
  proposedNew: { name: string; reason: string | null }[];
  clarify: string | null;
}

/** applyOps 执行结果 */
export interface ApplyResult {
  trip: Trip;
  applied: Operation[];
  rejected: { op: Operation; reason: string }[];
  /** remove/setPurchase/lock 默认分流至此，等待用户确认后二次下发 */
  needsProposal: Operation[];
  /** 非空 = 应用后一致性校验失败，已整批回滚（trip 与入参逐字段一致，applied 清空） */
  consistencyErrors: string[];
}
