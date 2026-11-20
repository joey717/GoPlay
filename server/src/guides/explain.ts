/**
 * Task #250：攻略草案可解释性分类（纯函数，无 IO / 无锁）。
 *
 * 目标：用户在应用草案前就能区分「将移出 / 重新排入 / 本轮新增 / 既有保留 /
 * 仅补亮点」，应用后也能说明实际发生了什么。业务语义全部由服务端按
 * 「生成前行程快照 + 最终操作」确定性计算，前端只展示，不推断。
 *
 * 分类口径（先模拟操作终态，再按以下优先级判定）：
 * 1. classifyVisitAsStop 的目标 → rearrange（归入父景区内部行程，不再单独占一天）；
 * 2. 原先在某天、终态不在任何天 → remove（移出并回到候选池）；
 * 3. 原先不在任何天、终态在某天 → new（本轮新增）；
 * 4. 原在某天、终态在另一天 → rearrange（从其他 Day 移动）；
 * 5. 原天 === 终天但出现在结构操作中（plan / move / transfer）→ rearrange
 *    （原已在目标 Day 且参与本轮重排）；
 * 6. Task #253：出现在属性 / 内部路线操作中（setTime / setDuration / setPurchase /
 *    lock / 同天 move / 内部 Stop 排入与改挂）→ adjust（真实调整，展示依据）；
 *    这类实体**绝不能**被当成「仅补亮点」；
 * 7. 有真实保留依据（replaceKeptVisitIds 锁定 / 已购保护、指令点名锚点）→ retain；
 *    注意：绝不移列表外未参与草案的既有 Visit；
 * 8. 本轮有 snippet 且**无任何**结构 / 属性 / 内部路线操作 → snippet_only。
 *
 * replace 摘要只消费 directive.replaceRemovedVisitIds / replaceKeptVisitIds
 * （append 指令不产生摘要，避免被误标为整日替换）。
 */

import type {
  EntityRef,
  GuideDraftClassifiedItem,
  GuideDraftDayDirective,
  GuideDraftEntityClassification,
  GuideDraftExplanation,
  GuideDraftReplaceSummary,
  Operation,
  PendingGuideDraftSnippet,
  Trip,
} from "@goplay/shared";
import { visitDayIndex } from "@goplay/shared";

/** 分类展示顺序（前端分组同序） */
const CLASSIFICATION_ORDER: GuideDraftEntityClassification[] = [
  "remove",
  "rearrange",
  "new",
  "adjust",
  "retain",
  "snippet_only",
];

/** 分类计数零值（固定包含全部键，前端无需兜底分支） */
function emptyCounts(): Record<GuideDraftEntityClassification, number> {
  return { remove: 0, rearrange: 0, new: 0, adjust: 0, retain: 0, snippet_only: 0 };
}

/** 实体引用键（只用于 visit / point / stop；其余 kind 退化为 kind 字符串） */
function refKey(ref: EntityRef): string {
  if (ref.kind === "visit") return `visit:${ref.id}`;
  if (ref.kind === "stop") return `stop:${ref.id}`;
  if (ref.kind === "point") return `point:${ref.id}`;
  return ref.kind;
}

function visitDisplayName(trip: Trip, visitId: string): string {
  const visit = trip.visits[visitId];
  if (visit === undefined) return visitId;
  return trip.itemRegistry[visit.pointRef]?.name ?? visitId;
}

function stopDisplayName(trip: Trip, stopId: string): string {
  const stop = trip.stops[stopId];
  if (stop === undefined) return stopId;
  if (stop.matchedPointRef !== null) {
    const name = trip.itemRegistry[stop.matchedPointRef]?.name;
    if (name !== undefined && name !== "") return name;
  }
  return stop.customName ?? stopId;
}

function pointDisplayName(trip: Trip, pointId: string): string {
  const name = trip.itemRegistry[pointId]?.name;
  return name !== undefined && name !== "" ? name : pointId;
}

function entityDisplayName(trip: Trip, ref: EntityRef): string {
  if (ref.kind === "visit") return visitDisplayName(trip, ref.id);
  if (ref.kind === "stop") return stopDisplayName(trip, ref.id);
  if (ref.kind === "point") return pointDisplayName(trip, ref.id);
  return ref.kind;
}

/** Visit 的保护原因（锁定 / 已购）；均无时返回 null */
function protectionReason(trip: Trip, visitId: string): string | null {
  const visit = trip.visits[visitId];
  if (visit === undefined) return null;
  const locked = visit.locked === true;
  const bought = visit.purchaseState === "bought";
  if (locked && bought) return "已锁定且已购票";
  if (locked) return "已锁定";
  if (bought) return "已购票";
  return null;
}

interface DaySimulation {
  /** 实体终态天号（不在任何天为 null）；缺省 = 以生成前位置为准 */
  finalDay: Map<string, number | null>;
  /** 出现在结构操作（plan / move / transfer / remove / classify）中的实体键 */
  structural: Set<string>;
  /** 被 remove 移出的来源天（key = visit:<id>） */
  removedFromDay: Map<string, number>;
  /** classifyVisitAsStop 目标 → 父 Visit */
  classifiedInto: Map<string, string>;
  /**
   * Task #253：属性 / 内部路线操作触碰的实体（key → 用户语言的调整依据）。
   * 只要这里有条目，该实体就是「真实调整」，不能归为 snippet_only。
   */
  adjustments: Map<string, string[]>;
}

/** setTime 目标容器 → 用户语言 */
const SET_TIME_TARGET_LABEL: Record<"start" | "end" | "dayDepart", string> = {
  start: "开始时间",
  end: "结束时间",
  dayDepart: "出发时间",
};

/** setPurchase 目标状态 → 用户语言 */
const PURCHASE_LABEL: Record<"bought" | "toBuy" | "unknown" | "noTicket", string> = {
  bought: "已购票",
  toBuy: "待购票",
  unknown: "票务待定",
  noTicket: "无需门票",
};

/**
 * 模拟结构操作的终态位置（只关心实体在哪个 Day，不重放排序细节），
 * 同时记录属性 / 内部路线操作的调整依据（Task #253）。
 * 属性类操作（setDuration / setTime / setPurchase / lock / addLodgingCandidate）不改天，
 * 但一定是「真实调整」。
 */
function simulateOperations(trip: Trip, operations: Operation[]): DaySimulation {
  const finalDay = new Map<string, number | null>();
  const structural = new Set<string>();
  const removedFromDay = new Map<string, number>();
  const classifiedInto = new Map<string, string>();
  const adjustments = new Map<string, string[]>();

  const noteAdjustment = (key: string, reason: string): void => {
    const existing = adjustments.get(key);
    if (existing === undefined) adjustments.set(key, [reason]);
    else if (!existing.includes(reason)) existing.push(reason);
  };
  const noteEntityAdjustment = (ref: EntityRef, reason: string): void => {
    if (ref.kind !== "visit" && ref.kind !== "stop" && ref.kind !== "point") return;
    noteAdjustment(refKey(ref), reason);
  };
  /** Stop 所属父 Visit 的 key（无法解析时不记） */
  const parentVisitKey = (ref: EntityRef): string | null => {
    if (ref.kind !== "stop") return null;
    const parentVisitId = trip.stops[ref.id]?.visitRef ?? null;
    return parentVisitId === null ? null : `visit:${parentVisitId}`;
  };

  const setDay = (ref: EntityRef, dayIndex: number | null): void => {
    if (ref.kind !== "visit" && ref.kind !== "point") return;
    finalDay.set(refKey(ref), dayIndex);
    structural.add(refKey(ref));
  };

  for (const op of operations) {
    switch (op.op) {
      case "plan": {
        for (const assignment of op.assignments) {
          if (assignment.containerRef.kind === "day") {
            setDay(assignment.subjectRef, assignment.containerRef.dayIndex);
            continue;
          }
          // 内部玩法排入父景区：父 Visit 的内部路线被真实修改
          if (assignment.containerRef.kind === "visit") {
            const label = entityDisplayName(trip, assignment.subjectRef);
            noteAdjustment(`visit:${assignment.containerRef.id}`, `内部玩法排入「${label}」`);
            noteEntityAdjustment(assignment.subjectRef, "内部玩法所属景区变更");
          }
        }
        break;
      }
      case "move": {
        if (op.containerRef.kind === "day") {
          setDay(op.subjectRef, op.containerRef.dayIndex);
          break;
        }
        // 同容器内改序：不改天，但属于真实调整
        noteEntityAdjustment(op.subjectRef, "同天顺序调整");
        const parentKey = parentVisitKey(op.subjectRef);
        if (parentKey !== null) noteAdjustment(parentKey, "内部玩法顺序调整");
        break;
      }
      case "transfer": {
        if (op.toContainerRef.kind === "day") {
          setDay(op.subjectRef, op.toContainerRef.dayIndex);
        } else if (
          op.toContainerRef.kind === "globalPool" ||
          op.toContainerRef.kind === "visitPool" ||
          op.toContainerRef.kind === "pendingPool"
        ) {
          setDay(op.subjectRef, null);
        } else if (op.toContainerRef.kind === "visit") {
          // 内部玩法改挂到另一个父景区
          const parentName = visitDisplayName(trip, op.toContainerRef.id);
          noteEntityAdjustment(op.subjectRef, `内部玩法改挂到「${parentName}」`);
          noteAdjustment(`visit:${op.toContainerRef.id}`, "内部玩法变更");
          const fromParentKey = parentVisitKey(op.subjectRef);
          if (fromParentKey !== null) noteAdjustment(fromParentKey, "内部玩法被移出");
        }
        break;
      }
      case "remove": {
        if (op.fromContainerRef.kind !== "day") {
          // 内部玩法被移出（不改天）——仍属于真实调整
          noteEntityAdjustment(op.subjectRef, "内部玩法移出");
          const parentKey = parentVisitKey(op.subjectRef);
          if (parentKey !== null) noteAdjustment(parentKey, "内部玩法被移出");
          break;
        }
        setDay(op.subjectRef, null);
        if (op.subjectRef.kind === "visit") {
          removedFromDay.set(op.subjectRef.id, op.fromContainerRef.dayIndex);
        }
        break;
      }
      case "setTime": {
        noteEntityAdjustment(op.subjectRef, `${SET_TIME_TARGET_LABEL[op.target]}改为 ${op.value}`);
        break;
      }
      case "setDuration": {
        noteEntityAdjustment(op.subjectRef, `停留时长改为 ${op.minutes} 分钟`);
        break;
      }
      case "setPurchase": {
        noteEntityAdjustment(op.subjectRef, `票务状态改为${PURCHASE_LABEL[op.value]}`);
        break;
      }
      case "lock": {
        noteEntityAdjustment(op.subjectRef, op.value ? "设为锁定" : "解除锁定");
        break;
      }
      case "classifyVisitAsStop": {
        classifiedInto.set(op.visitId, op.parentVisitId);
        structural.add(`visit:${op.visitId}`);
        // 父景区的内部玩法被真实新增
        noteAdjustment(`visit:${op.parentVisitId}`, `内部玩法新增「${visitDisplayName(trip, op.visitId)}」`);
        break;
      }
      default:
        break;
    }
  }
  return { finalDay, structural, removedFromDay, classifiedInto, adjustments };
}

/**
 * Visit 的模拟终态天：优先取本批操作推演结果；被 classify 删除的子 Visit 跟随父 Visit
 * 的模拟终态（父同批再被移动时也要正确）；深度上限防御环引用。
 */
function simulatedVisitDay(trip: Trip, simulation: DaySimulation, visitId: string, depth = 0): number | null {
  const key = `visit:${visitId}`;
  if (simulation.finalDay.has(key)) return simulation.finalDay.get(key) ?? null;
  if (depth >= 4) return visitDayIndex(trip, visitId);
  const parentVisitId = simulation.classifiedInto.get(visitId);
  if (parentVisitId !== undefined) return simulatedVisitDay(trip, simulation, parentVisitId, depth + 1);
  return visitDayIndex(trip, visitId);
}

/** 保留依据（key = visit:<id> → 用户语言原因） */
function collectRetainEvidence(
  trip: Trip,
  directives: GuideDraftDayDirective[] | undefined,
): Map<string, string> {
  const evidence = new Map<string, string>();
  for (const directive of directives ?? []) {
    // replace：锁定 / 已购保护项（与冲突 replace_kept_protected 同源）
    for (const visitId of directive.replaceKeptVisitIds ?? []) {
      const reason = protectionReason(trip, visitId);
      evidence.set(
        `visit:${visitId}`,
        reason !== null
          ? `${reason}，整日替换时保留在原天`
          : "整日替换时按保护规则保留在原天",
      );
    }
    // 指令点名锚点：已在目标天且未被移回，作为本轮重排的固定参考
    const removed = new Set(directive.replaceRemovedVisitIds ?? []);
    for (const visitId of directive.resolvedVisitIds) {
      if (removed.has(visitId)) continue;
      if (visitDayIndex(trip, visitId) !== directive.dayIndex) continue;
      if (evidence.has(`visit:${visitId}`)) continue;
      evidence.set(
        `visit:${visitId}`,
        directive.mode === "replace"
          ? `指令点名的既有安排，保留在 Day${directive.dayIndex} 并作为重排参考`
          : `指令点名且已在 Day${directive.dayIndex}，本轮保留原样`,
      );
    }
  }
  return evidence;
}

/** 本轮有 snippet 的目标计数（key = refKey） */
function collectSnippetCounts(snippets: PendingGuideDraftSnippet[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const snippet of snippets) {
    const ref = snippet.targetRef;
    if (ref.kind !== "visit" && ref.kind !== "stop" && ref.kind !== "point") continue;
    const key = refKey(ref);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** 分类项构造（分类 + 天号 + 依据） */
function makeItem(input: {
  classification: GuideDraftEntityClassification;
  targetRef: EntityRef;
  displayName: string;
  dayIndex: number | null;
  detail: string;
}): GuideDraftClassifiedItem {
  return {
    key: `${input.classification}:${refKey(input.targetRef)}`,
    classification: input.classification,
    targetRef: input.targetRef,
    displayName: input.displayName,
    dayIndex: input.dayIndex,
    detail: input.detail,
  };
}

/** 整日替换摘要文案（数量 + 名称 + 保留原因） */
function buildReplaceSummaryText(
  dayIndex: number,
  removedNames: string[],
  kept: { displayName: string; reason: string }[],
): string {
  const segments: string[] = [];
  if (removedNames.length > 0) {
    segments.push(`将移回 ${removedNames.length} 项（${removedNames.join("、")}）`);
  }
  if (kept.length > 0) {
    segments.push(
      `保留 ${kept.length} 项（${kept.map((entry) => `${entry.displayName}，${entry.reason}`).join("、")}）`,
    );
  }
  const action =
    segments.length > 0 ? `${segments.join("，")}，再按所选攻略重排` : "将按所选攻略整体重排";
  return `Day${dayIndex} ${action}`;
}

/**
 * replace 摘要（仅 mode="replace" 指令）。Task #253：按目标日**合并去重**——
 * 同一天可能有多条 replace 指令（「重排DAY3，DAY3安排第一市场」），它们共享同一份
 * 移回集合，分别生成会让预览重复出现多份相同的「Day3 将移回…」。
 */
function buildReplaceSummaries(
  trip: Trip,
  directives: GuideDraftDayDirective[] | undefined,
): GuideDraftReplaceSummary[] {
  interface DayReplaceSummary {
    dayIndex: number;
    directiveId: string;
    placeTexts: string[];
    removed: GuideDraftReplaceSummary["removed"];
    removedIds: Set<string>;
    kept: GuideDraftReplaceSummary["kept"];
    keptIds: Set<string>;
  }
  const order: number[] = [];
  const byDay = new Map<number, DayReplaceSummary>();
  for (const directive of directives ?? []) {
    if (directive.mode !== "replace") continue;
    let entry = byDay.get(directive.dayIndex);
    if (entry === undefined) {
      entry = {
        dayIndex: directive.dayIndex,
        directiveId: directive.directiveId,
        placeTexts: [],
        removed: [],
        removedIds: new Set<string>(),
        kept: [],
        keptIds: new Set<string>(),
      };
      byDay.set(directive.dayIndex, entry);
      order.push(directive.dayIndex);
    }
    if (directive.placeText !== "" && !entry.placeTexts.includes(directive.placeText)) {
      entry.placeTexts.push(directive.placeText);
    }
    for (const visitId of directive.replaceRemovedVisitIds ?? []) {
      if (entry.removedIds.has(visitId)) continue;
      entry.removedIds.add(visitId);
      entry.removed.push({
        targetRef: { kind: "visit" as const, id: visitId },
        displayName: visitDisplayName(trip, visitId),
      });
    }
    for (const visitId of directive.replaceKeptVisitIds ?? []) {
      if (entry.keptIds.has(visitId)) continue;
      entry.keptIds.add(visitId);
      entry.kept.push({
        targetRef: { kind: "visit" as const, id: visitId },
        displayName: visitDisplayName(trip, visitId),
        reason: protectionReason(trip, visitId) ?? "受保护",
      });
    }
  }
  const summaries: GuideDraftReplaceSummary[] = [];
  for (const dayIndex of order) {
    const entry = byDay.get(dayIndex);
    if (entry === undefined) continue;
    summaries.push({
      directiveId: entry.directiveId,
      dayIndex,
      placeText: entry.placeTexts.join("、"),
      removed: entry.removed,
      kept: entry.kept,
      text: buildReplaceSummaryText(
        dayIndex,
        entry.removed.map((item) => item.displayName),
        entry.kept,
      ),
    });
  }
  return summaries;
}

export interface BuildDraftExplanationInput {
  /** 生成前 / 应用前的行程快照（版本保护保证与实际输入一致） */
  trip: Trip;
  /** 最终操作集（生成 = enforced.operations；应用 = 实际 applied 操作） */
  operations: Operation[];
  /** 本轮草案的攻略提示（应用侧不需要传） */
  snippets?: PendingGuideDraftSnippet[];
  /** 生成侧注解后的日期指令（应用侧不传 = 不计算保留项） */
  directives?: GuideDraftDayDirective[];
}

/**
 * 计算草案可解释性分类（生成与 apply 共用同一口径）。
 * 旧草案 / 旧客户端不传 explanation 时前端按原 UI 展示，本函数不影响任何护栏。
 */
export function buildDraftExplanation(input: BuildDraftExplanationInput): GuideDraftExplanation {
  const { trip, operations, snippets = [], directives } = input;
  const simulation = simulateOperations(trip, operations);
  const retainEvidence = collectRetainEvidence(trip, directives);
  const snippetCounts = collectSnippetCounts(snippets);
  const items: GuideDraftClassifiedItem[] = [];

  const snippetOnlyDetail = (count: number): string =>
    `仅补充 ${count} 条攻略亮点，不调整行程结构`;

  // 1) Visit：位移 / 移出 / 参与重排 / 保留 / 仅补亮点
  const visitIds = new Set<string>([
    ...Object.keys(trip.visits),
    ...operations.flatMap((op) =>
      op.op === "plan"
        ? op.assignments
            .map((assignment) =>
              assignment.subjectRef.kind === "visit" ? assignment.subjectRef.id : null,
            )
            .filter((id): id is string => id !== null)
        : [],
    ),
    ...[...snippetCounts.keys()]
      .filter((key) => key.startsWith("visit:"))
      .map((key) => key.slice("visit:".length)),
  ]);

  for (const visitId of visitIds) {
    const ref: EntityRef = { kind: "visit", id: visitId };
    const key = refKey(ref);
    const displayName = visitDisplayName(trip, visitId);
    const startDay = visitDayIndex(trip, visitId);
    const endDay = simulation.finalDay.has(key) ? (simulation.finalDay.get(key) ?? null) : startDay;
    const structural = simulation.structural.has(key);
    const snippetCount = snippetCounts.get(key) ?? 0;
    const parentVisitId = simulation.classifiedInto.get(visitId);

    if (parentVisitId !== undefined) {
      // Task #253：预览日期取父 Visit 的**模拟终态天**（父同批被移动时也要正确）
      const parentDay = simulatedVisitDay(trip, simulation, parentVisitId);
      items.push(
        makeItem({
          classification: "rearrange",
          targetRef: ref,
          displayName,
          dayIndex: parentDay,
          detail: `归入「${visitDisplayName(trip, parentVisitId)}」内部行程，不再单独占一天`,
        }),
      );
      continue;
    }
    if (startDay !== null && endDay === null) {
      const fromDay = simulation.removedFromDay.get(visitId) ?? startDay;
      items.push(
        makeItem({
          classification: "remove",
          targetRef: ref,
          displayName,
          dayIndex: null,
          detail: `从 Day${fromDay} 移回候选池`,
        }),
      );
      continue;
    }
    if (startDay === null && endDay !== null) {
      items.push(
        makeItem({
          classification: "new",
          targetRef: ref,
          displayName,
          dayIndex: endDay,
          detail: `此前不在任何 Day，本轮排入 Day${endDay}`,
        }),
      );
      continue;
    }
    if (startDay !== null && endDay !== null && startDay !== endDay) {
      items.push(
        makeItem({
          classification: "rearrange",
          targetRef: ref,
          displayName,
          dayIndex: endDay,
          detail: `从 Day${startDay} 调整到 Day${endDay}`,
        }),
      );
      continue;
    }
    if (structural && endDay !== null) {
      items.push(
        makeItem({
          classification: "rearrange",
          targetRef: ref,
          displayName,
          dayIndex: endDay,
          detail: `原已在 Day${endDay}，参与本轮重排`,
        }),
      );
      continue;
    }
    // Task #253：属性 / 内部路线操作 → 真实调整（绝不归为「仅补亮点」）
    const adjustmentReasons = simulation.adjustments.get(key);
    if (adjustmentReasons !== undefined && adjustmentReasons.length > 0) {
      items.push(
        makeItem({
          classification: "adjust",
          targetRef: ref,
          displayName,
          dayIndex: endDay,
          detail: `本轮调整：${adjustmentReasons.join("；")}`,
        }),
      );
      continue;
    }
    const retainReason = retainEvidence.get(key);
    if (retainReason !== undefined) {
      items.push(
        makeItem({
          classification: "retain",
          targetRef: ref,
          displayName,
          dayIndex: endDay,
          detail: retainReason,
        }),
      );
      continue;
    }
    if (snippetCount > 0) {
      items.push(
        makeItem({
          classification: "snippet_only",
          targetRef: ref,
          displayName,
          dayIndex: endDay,
          detail: snippetOnlyDetail(snippetCount),
        }),
      );
    }
  }

  // 2) Point：草案中由 plan 新建 Visit（此前不在任何 Day）→ new；无结构操作则仅补亮点
  const pointIds = new Set<string>([
    ...operations.flatMap((op) =>
      op.op === "plan"
        ? op.assignments
            .map((assignment) =>
              assignment.subjectRef.kind === "point" ? assignment.subjectRef.id : null,
            )
            .filter((id): id is string => id !== null)
        : [],
    ),
    ...[...snippetCounts.keys()]
      .filter((key) => key.startsWith("point:"))
      .map((key) => key.slice("point:".length)),
  ]);

  for (const pointId of pointIds) {
    const ref: EntityRef = { kind: "point", id: pointId };
    const key = refKey(ref);
    const displayName = pointDisplayName(trip, pointId);
    const endDay = simulation.finalDay.get(key) ?? null;
    const snippetCount = snippetCounts.get(key) ?? 0;
    if (endDay !== null) {
      items.push(
        makeItem({
          classification: "new",
          targetRef: ref,
          displayName,
          dayIndex: endDay,
          detail: `从候选池新建点位并排入 Day${endDay}`,
        }),
      );
      continue;
    }
    if (snippetCount > 0) {
      items.push(
        makeItem({
          classification: "snippet_only",
          targetRef: ref,
          displayName,
          dayIndex: null,
          detail: snippetOnlyDetail(snippetCount),
        }),
      );
    }
  }

  // 3) Stop：内部玩法挪动 / 属性调整属于真实调整；只有**完全没有任何操作**的 Stop
  //    才能标「仅补亮点」（Task #253）。预览日期取父 Visit 的模拟终态天。
  const stopKeys = new Set<string>([
    ...[...snippetCounts.keys()].filter((key) => key.startsWith("stop:")),
    ...[...simulation.adjustments.keys()].filter((key) => key.startsWith("stop:")),
  ]);
  for (const key of stopKeys) {
    const stopId = key.slice("stop:".length);
    const parentVisitId = trip.stops[stopId]?.visitRef ?? null;
    const dayIndex = parentVisitId !== null ? simulatedVisitDay(trip, simulation, parentVisitId) : null;
    const reasons = simulation.adjustments.get(key) ?? [];
    const count = snippetCounts.get(key) ?? 0;
    if (reasons.length > 0) {
      items.push(
        makeItem({
          classification: "adjust",
          targetRef: { kind: "stop", id: stopId },
          displayName: stopDisplayName(trip, stopId),
          dayIndex,
          detail: `本轮调整：${reasons.join("；")}${count > 0 ? `；另补充 ${count} 条攻略亮点` : ""}`,
        }),
      );
      continue;
    }
    items.push(
      makeItem({
        classification: "snippet_only",
        targetRef: { kind: "stop", id: stopId },
        displayName: stopDisplayName(trip, stopId),
        dayIndex,
        detail: snippetOnlyDetail(count),
      }),
    );
  }

  // 稳定排序：分类 → 天号 → 名称（前端按分组渲染时顺序可预期）
  items.sort((left, right) => {
    const orderDiff =
      CLASSIFICATION_ORDER.indexOf(left.classification) - CLASSIFICATION_ORDER.indexOf(right.classification);
    if (orderDiff !== 0) return orderDiff;
    const dayDiff = (left.dayIndex ?? Number.MAX_SAFE_INTEGER) - (right.dayIndex ?? Number.MAX_SAFE_INTEGER);
    if (dayDiff !== 0) return dayDiff;
    return left.displayName.localeCompare(right.displayName, "zh-Hans-CN");
  });

  const counts = emptyCounts();
  for (const item of items) counts[item.classification] += 1;

  return { items, counts, replaceSummaries: buildReplaceSummaries(trip, directives) };
}

/**
 * apply 结果摘要：只统计实际执行的操作（不传 snippets / directives），
 * 让用户看到「这次真正发生了什么」。无结构变更返回 null。
 */
export function summarizeAppliedExplanation(explanation: GuideDraftExplanation): string | null {
  const parts: string[] = [];
  if (explanation.counts.remove > 0) parts.push(`移出 ${explanation.counts.remove} 项`);
  if (explanation.counts.rearrange > 0) parts.push(`重排 ${explanation.counts.rearrange} 项`);
  if (explanation.counts.new > 0) parts.push(`新增 ${explanation.counts.new} 项`);
  if (explanation.counts.adjust > 0) parts.push(`调整 ${explanation.counts.adjust} 项`);
  if (explanation.counts.retain > 0) parts.push(`保留 ${explanation.counts.retain} 项`);
  if (explanation.counts.snippet_only > 0) parts.push(`仅补亮点 ${explanation.counts.snippet_only} 项`);
  return parts.length > 0 ? `实际调整：${parts.join("、")}` : null;
}
