/**
 * Task #236：攻略来源「选择参与本次 AI 生成」的纯函数层。
 *
 * 背景：来源面板此前把默认聚焦 / 更换攻略两套选择状态留在 GuideDraftPanel 内部，
 * 来源列表本身没有勾选能力；本次把选择状态唯一上提到 NoteInput（单一状态源），
 * 列表与底部 CTA 都只消费受控 props，这里沉淀与 UI 无关的判定与收敛规则。
 *
 * 关键口径（与 Task #161 / #189 服务端契约一致）：
 * - 可选 = isGuideSourceUsable（active + ready/partial + 至少一条可读证据）；
 *   processing / failed / 已软删除来源不可选，勾选框禁用；
 * - staged（暂存）来源允许被显式选中（selected 模式），但不会被 all 模式消费；
 * - 本轮默认聚焦 = 暂存 + 可选 + 未消费（沿用任务 189「新攻略默认聚焦」语义）。
 */
import type { GuideSource, Trip } from "@goplay/shared";
import { isGuideSourceStaged, isGuideSourceUsable } from "@goplay/shared";

/** 来源是否可作为本次生成素材（勾选框可用性 + 请求参数过滤的统一口径） */
export function isGuideSourceSelectable(trip: Trip, source: GuideSource): boolean {
  return isGuideSourceUsable(trip, source);
}

/** 可选来源 id（保持 sources 顺序，稳定） */
export function selectableGuideSourceIds(
  trip: Trip,
  sources: readonly GuideSource[],
): string[] {
  return sources
    .filter((source) => isGuideSourceSelectable(trip, source))
    .map((source) => source.sourceId);
}

/**
 * 本轮默认选择：暂存（staged）+ 可选 + 未消费。
 * 与服务端 staged 契约对应——新增来源保存后只暂存、不自动影响行程，
 * 但仍默认勾选，交给用户一键生成（可取消）。
 */
export function defaultGuideSelection(
  trip: Trip,
  sources: readonly GuideSource[],
  consumedSourceIds: readonly string[] = [],
): string[] {
  const consumed = new Set(consumedSourceIds);
  return sources
    .filter(
      (source) =>
        isGuideSourceStaged(source) &&
        !consumed.has(source.sourceId) &&
        isGuideSourceSelectable(trip, source),
    )
    .map((source) => source.sourceId);
}

/**
 * 「只选新的」：仅 staged=true 的可选来源（长列表批量操作）。
 * staged 来源允许被 selected 模式显式选中（服务端契约 Task #161）。
 */
export function stagedGuideSourceIds(
  trip: Trip,
  sources: readonly GuideSource[],
): string[] {
  return sources
    .filter((source) => isGuideSourceStaged(source) && isGuideSourceSelectable(trip, source))
    .map((source) => source.sourceId);
}

export interface ReconcileGuideSelectionInput {
  /** 当前选择（唯一的受控状态来源） */
  previous: readonly string[];
  trip: Trip;
  sources: readonly GuideSource[];
  /** 已参与过已完成生成的来源（任务 189 行程级消费集合） */
  consumedSourceIds?: readonly string[];
  /**
   * 上一轮已进入可选集合的 id。null = 首次推导（不自动并入，默认聚焦由
   * defaultGuideSelection 给出）；非 null 时对「新变为可选」的暂存来源自动勾选。
   */
  seenSelectableIds: ReadonlySet<string> | null;
}

export interface ReconcileGuideSelectionResult {
  /** 收敛后的选择（按 sources 顺序；已剔除不可选 / 已删除来源） */
  selectedIds: string[];
  /** 当前可选来源 id（调用方记录为下一轮 seenSelectableIds） */
  selectableIds: string[];
}

/**
 * 选择集合收敛（用户新增来源 / 软删除 / 状态轮询更新 / trip 刷新时调用）：
 *
 * 1. 与当前可选来源取交集——删除、处理中、失败、证据消失的来源不会残留无效 id；
 * 2. 首次推导（seenSelectableIds = null）只做交集，避免把用户默认选择覆盖成「全选」；
 * 3. 之后「新变为可选」的暂存且未消费来源自动并入（例如新提交攻略处理完成、
 *    失败来源重试成功）；用户主动取消勾选过的来源在上一轮已进入 seen，不会回弹。
 *
 * 返回值顺序固定按 sources 顺序，保证请求体与列表展示稳定。
 */
export function reconcileGuideSelection(
  input: ReconcileGuideSelectionInput,
): ReconcileGuideSelectionResult {
  const selectableIds = selectableGuideSourceIds(input.trip, input.sources);
  const selectable = new Set(selectableIds);
  const previous = new Set(input.previous);
  const consumed = new Set(input.consumedSourceIds ?? []);

  const next = new Set<string>();
  for (const id of selectableIds) {
    if (previous.has(id)) next.add(id);
  }

  if (input.seenSelectableIds !== null) {
    const seen = input.seenSelectableIds;
    for (const source of input.sources) {
      const id = source.sourceId;
      if (!selectable.has(id) || seen.has(id) || next.has(id)) continue;
      if (isGuideSourceStaged(source) && !consumed.has(id)) next.add(id);
    }
  }

  return {
    selectedIds: selectableIds.filter((id) => next.has(id)),
    selectableIds,
  };
}

/**
 * 紧凑列表（≥4 篇）排序优先级：待处理来源置顶。
 * - 0 处理中（processing，轮询跟踪中）
 * - 1 待重试（failed，需要用户操作）
 * - 2 新增暂存（staged，等待生成本轮行程）
 * - 3 其余已整合来源
 * 同优先级内保持传入顺序（导入时间升序），因此是稳定排序。
 */
export function guideSourceRowPriority(source: GuideSource): number {
  if (source.status === "processing") return 0;
  if (source.status === "failed") return 1;
  if (isGuideSourceStaged(source)) return 2;
  return 3;
}

/** 紧凑列表稳定排序（不修改入参） */
export function sortGuideSourcesForCompactList(
  sources: readonly GuideSource[],
): GuideSource[] {
  return sources
    .map((source, index) => ({ source, index }))
    .sort((left, right) => {
      const delta =
        guideSourceRowPriority(left.source) - guideSourceRowPriority(right.source);
      return delta !== 0 ? delta : left.index - right.index;
    })
    .map((entry) => entry.source);
}
