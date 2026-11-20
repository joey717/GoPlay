import { memo, useCallback, useMemo, useState } from "react";
import type { GuideSource, Trip } from "@goplay/shared";
import { isGuideSourceStaged, isGuideSourceUsable } from "@goplay/shared";
import type { GuideDraftEntryContext, GuideDraftSourceMode } from "../api/client";
import { draftScopeHintLabel, resolveDraftScopeHint } from "../lib/draftScopeHint";
import { DRAFT_WAIT_LEAVE_HINT } from "../lib/waitPlans";
import type { WaitStageSnapshot } from "../lib/waitStages";
import WaitStageProgress from "./WaitStageProgress";
import { ConfirmDialog } from "./ConfirmDialog";

/** 攻略补充句上限（对齐 server/src/guides/service.ts DRAFT_NOTE_MAX_CHARS，超出由服务端拒绝） */
const DRAFT_NOTE_MAX_CHARS = 500;

/** 行程级生成会话的视图状态（由 TripView 的 useGuideDraftGeneration 驱动，经 NoteInput 透传） */
export interface GuideDraftGenerationView {
  /** 生成进行中（面板关闭也不中断；期间补充句 / 主行动均禁用） */
  active: boolean;
  /** 当前思考链文案（时间线递进；null = 非生成中） */
  text: string | null;
  /** 上一轮失败原因（服务端安全 message / 兕底超时文案；null = 无失败待处理） */
  error: string | null;
  /**
   * Task #224 分级反馈快照（站点 / 已等计时 / 预计剩余 / 分级）；
   * 缺省或 null 时退回单行思考链展示，保证既有调用方与测试不受影响。
   */
  stage?: WaitStageSnapshot | null;
}

/** 生成上抛载荷：请求在行程级会话发起，面板只负责收集入口上下文与补充句
 *  （Task #176：scope 由服务端自动判定，不再手动选择；Task #236：主 CTA 恒为
 *  sourceMode="selected" + selectedSourceIds，全部模式只保留次级整体重排） */
export interface GuideDraftGenerateInput {
  /** 面板打开来源（顶栏 global / DayContent 入口 day） */
  entryContext: GuideDraftEntryContext;
  note: string;
  /** 思考链文案用的篇数（本次所选篇数 / 全部模式 = 非暂存可用篇数） */
  usableCount: number;
  /** 来源模式；缺省 = 旧语义（不携带 sourceMode，服务端归一 "all"） */
  sourceMode?: GuideDraftSourceMode;
  /** sourceMode="selected" 时的来源 id 列表（局部优化，允许暂存来源） */
  selectedSourceIds?: string[];
}

/**
 * 正文区与底部行动区共用的受控入参（Task #242）。
 *
 * 为什么拆成两个组件：底部主 CTA 必须真正常驻在 Sheet 可视区域底部。此前行动区
 * （.draft-actions）虽然 sticky 吸底，但它是 .draft-panel 的子元素——sticky 只能在
 * 父盒范围内位移，父盒本身已经落到滚动区之外时按钮无法被「拉」进首屏，于是需要
 * 先下滑几十像素才出现。Task #242 把 Sheet 改成「固定头部 / 单一滚动正文 / 固定行动区」
 * 三段式，行动区由 NoteInput 直接挂在 Sheet 尾部（滚动容器之外），因此本组件只保留
 * 正文（补充要求输入框 / 错误 / 生成中），行动区由 GuideDraftActions 渲染。
 *
 * 两个组件都只消费 props（选择集合与补充要求状态都由 NoteInput 持有），派生状态
 * 统一走 useDraftPanelModel，避免两侧口径漂移。
 */
export interface GuideDraftPanelProps {
  trip: Trip;
  /** 当前 active 来源（父组件已过滤排序；processing 轮询更新驱动按钮文案刷新） */
  sources: GuideSource[];
  /** 面板打开来源（Task #176：服务端按「日期指令 > 入口上下文 > 证据归属 > 整程」
   *  自动判定影响范围） */
  openContext: GuideDraftEntryContext;
  /** 提交 / 重试来源 / 移除等互斥操作进行中（生成按钮暂避让） */
  busy: boolean;
  /** 输入区有待保存内容（正文或截图）：排版区退让为引导文案，全屏唯一橙钮让位给「保存攻略」 */
  textHasContent: boolean;
  /** 行程级生成会话视图（任务 135：状态在 TripView，关闭面板不中断） */
  generation: GuideDraftGenerationView;
  /** 已消费来源 id（TripView 行程级，selected 生成成功后并入）——已参与过已完成
   *  生成的暂存来源不再计入「新攻略已暂存」提示 */
  consumedSourceIds?: readonly string[];
  /**
   * Task #236：已勾选要参与本次生成的来源 id（唯一选择状态在 NoteInput，
   * 列表与本面板都只消费受控 props；不可选来源已在调用侧剔除）。
   */
  selectedSourceIds: readonly string[];
  /** 发起生成（行程级会话；面板关闭后请求继续等待） */
  onGenerate: (input: GuideDraftGenerateInput) => void;
  /** 取消等待（仅结束前端等待，不展示为错误） */
  onCancelGenerate: () => void;
  /** 次要出口「仅暂存，稍后处理」：关闭面板，不改后端状态（来源保持 staged） */
  onSaveLater: () => void;
}

/** 正文区入参：补充要求为受控输入（状态在 NoteInput，行动区提交时读同一份） */
export interface GuideDraftPanelBodyProps extends GuideDraftPanelProps {
  note: string;
  onNoteChange: (value: string) => void;
}

/** 行动区入参：只读补充要求（提交时 trim 后随请求上抛） */
export interface GuideDraftActionsProps extends GuideDraftPanelProps {
  note: string;
}

/** 两个区域共用的派生状态（全部 useMemo：避免每次 render 重建集合 / 重复预判） */
interface GuideDraftModel {
  usableCount: number;
  processingCount: number;
  fullMergeCount: number;
  newlyStagedCount: number;
  selectedCount: number;
  effectiveSelectedIds: string[];
  /** 行动区是否可见：待保存输入时让位给「保存攻略」（生成中不中断思考链） */
  showActions: boolean;
  primaryLabel: string;
  primaryDisabled: boolean;
  /** 影响范围一句文案：仅局部入口（Day / 大景区）展示；整程返回 null（Task #242） */
  scopeNote: string | null;
}

/**
 * 面板派生状态（正文区与行动区共用）。
 *
 * Task #242 性能整改：此前这些推导全部在 render 里裸算——10 篇来源的可用性过滤、
 * 每次新建 Set、以及会遍历全部 visits / stops 的影响范围预判，都会在「主输入框每敲
 * 一个字符」「trip 轮询刷新」「生成中每 500ms 思考链 tick」时重复执行一遍。改成
 * useMemo 按内容依赖缓存，输入框打字不再连带重算列表侧推导。
 */
function useDraftPanelModel({
  trip,
  sources,
  openContext,
  busy,
  textHasContent,
  generation,
  consumedSourceIds,
  selectedSourceIds,
}: GuideDraftPanelProps): GuideDraftModel {
  const generating = generation.active;

  // ===== 来源集合推导（纯计算，随 sources / trip 刷新；删除 / 重试后自动一致） =====
  const consumedSet = useMemo(() => new Set(consumedSourceIds ?? []), [consumedSourceIds]);
  /** 可用来源（active + ready/partial + 有可读证据）：可参与本次生成的范围 */
  const usableSources = useMemo(
    () => sources.filter((source) => isGuideSourceUsable(trip, source)),
    [sources, trip],
  );
  const usableCount = usableSources.length;
  /**
   * 本轮新增暂存（staged + 可用 + 未消费）：只用于「N 篇新攻略已暂存，还没有改动
   * 行程」提示，帮助用户理解保存 ≠ 改行程；勾选状态以 selectedSourceIds 为准。
   */
  const newlyStagedCount = useMemo(
    () =>
      usableSources.filter(
        (source) => isGuideSourceStaged(source) && !consumedSet.has(source.sourceId),
      ).length,
    [usableSources, consumedSet],
  );
  /** 全部模式可消费来源（可用且非暂存）：次级整体重排的素材（服务端同口径） */
  const fullMergeCount = useMemo(
    () => usableSources.filter((source) => !isGuideSourceStaged(source)).length,
    [usableSources],
  );
  const processingCount = useMemo(
    () => sources.filter((source) => source.status === "processing").length,
    [sources],
  );

  /** 有效勾选：与可用来源取交集并按来源顺序输出（防残留失效 id 进入请求体） */
  const selectedSet = useMemo(() => new Set(selectedSourceIds), [selectedSourceIds]);
  const effectiveSelectedIds = useMemo(
    () =>
      usableSources
        .filter((source) => selectedSet.has(source.sourceId))
        .map((source) => source.sourceId),
    [usableSources, selectedSet],
  );
  const selectedCount = effectiveSelectedIds.length;

  /** 行动区可见：还有来源可排（或正在生成，思考链不中断）；有待保存输入时让位 */
  const showActions = !textHasContent || generating;

  /** 主 CTA 文案：动态篇数优先；无选中时给出可执行的明确提示 */
  const primaryLabel = generating
    ? "正在生成行程…"
    : sources.length === 0
      ? "先添加一篇攻略"
      : selectedCount > 0
        ? `AI 生成行程 · 已选 ${selectedCount} 篇`
        : usableCount > 0
          ? "请勾选要用的攻略"
          : processingCount > 0
            ? "攻略处理中，完成后亮起"
            : "重试失败攻略后可排版";
  const primaryDisabled = generating || busy || selectedCount === 0;

  /**
   * 影响范围一句文案：跟随本次勾选的来源集合自动预判（无勾选不展示）。
   * Task #242：整程回退时 draftScopeHintLabel 返回 null，「将调整整段行程」不再出现；
   * 影响范围仍由补充说明 + 服务端自动判定，没有新增任何范围 chips。
   */
  const scopeNote = useMemo(
    () =>
      selectedCount > 0
        ? draftScopeHintLabel(resolveDraftScopeHint(trip, effectiveSelectedIds, openContext))
        : null,
    [selectedCount, trip, effectiveSelectedIds, openContext],
  );

  return {
    usableCount,
    processingCount,
    fullMergeCount,
    newlyStagedCount,
    selectedCount,
    effectiveSelectedIds,
    showActions,
    primaryLabel,
    primaryDisabled,
    scopeNote,
  };
}

/**
 * 统一添加 Sheet 的攻略生成正文区（Task #98 B4 §2/§4；任务 135 生成会话上抛；
 * 任务 176 scope 服务端自动判定；Task #236 核心版：列表内勾选 + 底部固定 CTA；
 * Task #242 与行动区拆分）。
 *
 * 交互层级（与 DEMO 一致，视觉沿用项目体系）：
 * - 素材选择在来源列表完成（勾选框 / 全选 / 全不选 / 只选新的），本面板不再维护
 *   第二份选择状态，只消费 selectedSourceIds；
 * - 补充要求（自然语言）留在正文流里（随 Sheet 单滚动容器滚动）；
 * - 主 CTA 与次要出口在 Sheet 固定行动区（GuideDraftActions），打开面板即可见；
 * - 输入区有待保存内容时整个行动区退让为引导文案，保证全屏同一时刻只有一个橙色实心钮。
 */
function GuideDraftPanel(props: GuideDraftPanelBodyProps) {
  const {
    sources,
    generation,
    note,
    onNoteChange,
    onCancelGenerate,
  } = props;
  const model = useDraftPanelModel(props);
  const { active: generating, text: thinkingText, error: generateError } = generation;

  /** 正文是否有内容：有待保存输入时整块攻略区让位（与行动区退让同步） */
  const showBody = model.showActions && sources.length > 0;
  // 退让态且无错误 / 生成中：正文区整体不占位（引导文案在固定行动区里）
  if (!showBody && generateError === null && !generating) return null;

  return (
    <div className="draft-panel" aria-label="攻略排版">
      {showBody ? (
        <>
          {/* 暂存语义说明（一行，role=status）：保存本身没有改行程 */}
          {model.newlyStagedCount > 0 ? (
            <div className="draft-staged-note" role="status">
              <span className="draft-staged-text">
                {model.newlyStagedCount} 篇新攻略已暂存，还没有改动行程
              </span>
            </div>
          ) : null}

          {/* 补充要求（自然语言，不引入结构化偏好 chips） */}
          <textarea
            className="draft-note-input"
            value={note}
            rows={2}
            maxLength={DRAFT_NOTE_MAX_CHARS}
            disabled={generating}
            placeholder="补充要求（可选）：不想太赶 / 带娃 / 避开周一闭馆"
            onChange={(event) => onNoteChange(event.target.value)}
          />

          {/* processing 混合提示：勾选里已有就绪素材时，提示还有几篇会补进来 */}
          {model.usableCount > 0 && model.processingCount > 0 ? (
            <div className="draft-cta-note">
              还有 {model.processingCount} 篇处理中，完成后可重新优化
            </div>
          ) : null}
        </>
      ) : null}

      {generateError !== null ? (
        <div className="draft-error" role="alert">
          {generateError}
        </div>
      ) : null}

      {generating ? (
        generation.stage ? (
          /* Task #224 分级反馈：路线站点 + 已等计时 + 预计剩余 + 三档分级；
             句子仍用既有思考链文案（带可用篇数），口径与底部浮条一致 */
          <WaitStageProgress
            snapshot={generation.stage}
            sentence={thinkingText}
            variant="panel"
            onCancel={onCancelGenerate}
            hint={DRAFT_WAIT_LEAVE_HINT}
            ariaLabel="草案生成进度"
          />
        ) : (
          /* 无分级快照时的原单行展示（老调用方 / 既有测试路径，行为不变） */
          <div className="draft-generating" role="status">
            <span className="draft-thinking-dot" aria-hidden="true" />
            <span key={thinkingText ?? ""} className="draft-thinking-text">
              {thinkingText}
            </span>
            <button type="button" onClick={onCancelGenerate}>
              取消等待
            </button>
          </div>
        )
      ) : null}
    </div>
  );
}

/**
 * Sheet 固定行动区（Task #242）：影响范围一句 → 唯一主 CTA → 两个弱化出口。
 *
 * 由 NoteInput 挂在 Sheet 尾部（.note-input-foot，滚动容器之外），打开面板即完整可见，
 * 不再依赖 sticky 在父盒内的位移能力；软键盘弹出时 Sheet 随 --app-height 收缩，
 * 行动区仍贴在 Sheet 底边、不被键盘遮住。
 */
function GuideDraftActions(props: GuideDraftActionsProps) {
  const { sources, generation, busy, openContext, note, onGenerate, onSaveLater } = props;
  const model = useDraftPanelModel(props);
  const { active: generating } = generation;
  /** 整体重排二次确认弹窗（次级操作） */
  const [confirmReplan, setConfirmReplan] = useState(false);

  /** 主 CTA：恒走 selected 模式，请求体带真实选中的 sourceIds */
  const handlePrimary = useCallback(() => {
    if (generating || model.primaryDisabled || model.selectedCount === 0) return;
    onGenerate({
      entryContext: openContext,
      note: note.trim(),
      usableCount: model.selectedCount,
      sourceMode: "selected",
      selectedSourceIds: model.effectiveSelectedIds,
    });
  }, [
    generating,
    model.primaryDisabled,
    model.selectedCount,
    model.effectiveSelectedIds,
    onGenerate,
    openContext,
    note,
  ]);

  /** 次级整体重排确认：sourceMode="all"（服务端只消费非暂存来源），沿用整程
   *  重排二次确认文案；安全护栏不变——生成的仍是草案，需预览确认后才应用 */
  const handleReplanConfirm = useCallback(() => {
    setConfirmReplan(false);
    if (generating || busy || model.fullMergeCount === 0) return;
    onGenerate({
      entryContext: openContext,
      note: note.trim(),
      usableCount: model.fullMergeCount,
      sourceMode: "all",
    });
  }, [generating, busy, model.fullMergeCount, note, onGenerate, openContext]);

  // 退让态（输入有待保存内容）：灰底引导文案替代生成控件，保证「保存攻略」
  // 是此刻全屏唯一橙色主钮
  if (!model.showActions) {
    return <div className="draft-hint-line">保存后，可在此一键排行程</div>;
  }

  /** 整体重排确认描述：明确素材边界（不含本轮暂存的新攻略）与既有覆盖语义 */
  const replanDescription = `将用已整合的 ${model.fullMergeCount} 篇攻略重新编排整段行程，会覆盖你手动调整过的顺序与时间；已定项与已购状态不受影响${
    model.newlyStagedCount > 0 ? `，刚添加的 ${model.newlyStagedCount} 篇不会用上` : ""
  }。`;

  return (
    <>
      <div className="draft-actions">
        {model.scopeNote !== null ? <div className="draft-scope-note">{model.scopeNote}</div> : null}
        <button
          type="button"
          className="draft-primary"
          disabled={model.primaryDisabled}
          onClick={handlePrimary}
        >
          {model.primaryLabel}
        </button>
        <div className="draft-foot-exits">
          {/* 次要出口：关闭面板，不改后端状态（来源保持 staged） */}
          {sources.length > 0 ? (
            <button
              type="button"
              className="draft-save-link"
              disabled={generating || busy}
              onClick={onSaveLater}
            >
              仅暂存，稍后处理
            </button>
          ) : null}
          {/* 次级保留能力：整体重排（非暂存来源），二次确认后才发起 */}
          {model.fullMergeCount > 0 ? (
            <button
              type="button"
              className="draft-replan-link"
              disabled={generating || busy}
              onClick={() => setConfirmReplan(true)}
            >
              使用全部攻略整体重排
            </button>
          ) : null}
        </div>
      </div>

      {/* 整体重排二次确认：沿用整体重排确认弹窗与安全护栏，取消 / 遮罩关闭不发起 */}
      {confirmReplan ? (
        <ConfirmDialog
          title="整体重排确认"
          description={replanDescription}
          confirmText="确认重排"
          cancelText="取消"
          onConfirm={handleReplanConfirm}
          onCancel={() => setConfirmReplan(false)}
        />
      ) : null}
    </>
  );
}

/** 正文区随「输入框打字」以外的 props 变化才重渲染（memo + 上游 useCallback） */
const MemoGuideDraftPanel = memo(GuideDraftPanel);

/** 固定行动区（NoteInput 直接挂到 Sheet 尾部） */
export const GuideDraftActionsBar = memo(GuideDraftActions);

export default MemoGuideDraftPanel;
