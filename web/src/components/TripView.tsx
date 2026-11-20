import { useEffect, useRef, useState } from "react";
import type { ApplyResult, ClarificationAnswer, Constraint, Item, Operation, Trip } from "@goplay/shared";
import { checkPendingGuideDraftFreshness, describeRejections } from "@goplay/shared";
import {
  archiveAiSession,
  confirmProposal,
  deleteTrip,
  deleteTripCover,
  type GuideDraftApplyResult,
  type GuideDraftResult,
  type IntentResult,
  type PoiSearchResult,
  uploadTripCover,
} from "../api/client";
import { useGuideDraftGeneration, type GuideDraftGenerationInput } from "../hooks/useGuideDraftGeneration";
import { draftResultFromTrip } from "../lib/draftRecall";
import { loadDismissedDraftIds, saveDismissedDraftIds } from "../lib/dismissedDrafts";
import { clearTripCache, useTrip, type UndoState } from "../hooks/useTrip";
import { buildDraftApplyNotice } from "../lib/draftApplyNotice";
import {
  eligibleClassifyTargets,
  findChildStopParentVisit,
  findMatchingLargeVisit,
  largeVisitDisplayName,
} from "../lib/largeAttraction";
import { todayIso } from "../lib/format";
import { onSheetOpened } from "../lib/sheetBus";
import { dayVisits, orderedDays, visitDisplayName } from "../lib/trip";
import { getTripPhase } from "../lib/tripPhase";
import { applyCoverPatch, tripCoverInfo, type TripCoverPatch } from "../lib/tripCover";
import AppHead from "./AppHead";
import { ClarificationDialog } from "./ClarificationDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import ConstraintEditor from "./ConstraintEditor";
import DayContent from "./DayContent";
import DayStrip from "./DayStrip";
import DraftStatusToast, { type DraftToastState } from "./DraftStatusToast";
import HotelPicker from "./HotelPicker";
import IntentBar from "./IntentBar";
import NoteInput, { type OpenContext, type QuickAddSelection } from "./NoteInput";
import OpLogSheet from "./OpLogSheet";
import ProposalCard from "./ProposalCard";
import TripChecklist from "./TripChecklist";
import TripCoverBar from "./TripCoverBar";
import TripCoverSheet from "./TripCoverSheet";
import UndoToast from "./UndoToast";

interface TripViewProps {
  tripId: string;
  /** 上游（App 启动路由或 InitFlow 创建）已拿到的行程，避免重复请求 */
  initialTrip?: Trip;
  /** 新建行程（Task #66）：删除并清缓存后，由上层重回初始化流程 */
  onNewTrip: () => void;
}

/** "2026-11-08" → "2026-11-09"（退房日 = 入住次日；UTC 构造避免时区偏移） */
function nextDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** 飞猪搜索结果 → 候选池主数据 Item（字段映射对齐 Task #100 matchedPoi） */
function poiToItem(poi: PoiSearchResult): Item {
  return {
    itemId: crypto.randomUUID(),
    name: poi.name,
    origin: "fliggy",
    providerId: poi.id,
    address: poi.address,
    category: poi.category,
    coords: poi.coords,
    suggestMinutes: null,
    mainPic: poi.mainPic,
    ticketInfo: poi.ticketInfo,
    jumpUrl: poi.jumpUrl,
    // Task #329：免费状态透传（免税城等免费场所不得透出购票语义）
    freePoiStatus: poi.freePoiStatus ?? undefined,
    // Task #330：飞猪 POI 元信息透传（等级/榜单/介绍）；未携带时缺省，读时默认 null
    poiLevel: poi.poiLevel ?? undefined,
    listRank: poi.listRank ?? undefined,
    description: poi.description ?? undefined,
    sourceEvidenceRefs: [],
  };
}

/** 自定义点位 → 候选池主数据 Item（providerId 不伪造，飞猪字段全空；
 *  地址为表单手填时标记 addressSource="user"，展示层免加「AI 提取」声明） */
function customToItem(name: string, address: string | null): Item {
  return {
    itemId: crypto.randomUUID(),
    name,
    origin: "custom",
    providerId: null,
    address,
    addressSource: address !== null ? "user" : undefined,
    category: null,
    coords: null,
    suggestMinutes: null,
    mainPic: null,
    ticketInfo: null,
    jumpUrl: null,
    sourceEvidenceRefs: [],
  };
}

/** 撤销提示文案：城市级点位 → 移回候选池；内部玩法 → 移入父备选玩法；酒店候选 → 移出住宿规划 */
function undoText(state: UndoState): string {
  if (state.kind === "stop") {
    const name = state.entries[0]?.name ?? "玩法";
    return `已将「${name}」移入「${state.visitLabel}」备选玩法`;
  }
  if (state.kind === "hotel") {
    return `已将「${state.name}」移出 Day${state.dayIndex} 住宿规划`;
  }
  return state.batch || state.entries.length > 1
    ? `已将 ${state.entries.length} 项移回候选池`
    : `已将「${state.entries[0]?.name ?? "点位"}」移回候选池`;
}

/** Task #219 方案 1：快速搜索点位与行程已有大景区的一条匹配明细 */
interface ChildAttachAskItem {
  poi: PoiSearchResult;
  visitId: string;
  parentName: string;
  /** name = 与大景区本名相近；child = 与其岛内玩法同名 */
  reason: "name" | "child";
}

/** 挂起中的归属确认：items 待确认项 + 其余无歧义勾选项（确认/取消后一并落地） */
interface ChildAttachAsk {
  items: ChildAttachAskItem[];
  rest: QuickAddSelection;
}

/**
 * 主界面容器：标题栏 + Day 切换 + 当天内容 + 意图栏。
 * 交互优化 Module A/E：头部 chips 收敛为灰字状态行 + ⋯ 菜单；「添加攻略/地点」
 * 升级为通栏浅橙描边入口；候选池抽屉入口移除（CandidatePool 组件保留待
 * 面板融入时复用）；AI 栏按钮文案随是否有行程切换（AI 调整 / AI 排一版）。
 * AI 链路：IntentBar 结果分发（applied 采纳 / proposal 确认 / rejected·error 提示）；
 * 全量重排（op=plan 且 scope=all）经 ConfirmDialog 确认后走 /intent/confirm
 * 二次下发，取消不落地任何修改；未执行原因可展开查看，不静默。
 * 手动链路：点位移除与内部玩法移入备选均走 5 秒撤销窗口。
 */
export default function TripView({ tripId, initialTrip, onNewTrip }: TripViewProps) {
  const store = useTrip(tripId, initialTrip);
  const { trip, loading, error, saving } = store;
  const [currentDay, setCurrentDay] = useState(1);
  /** 首次默认选天是否已定（行中定位今天 / 其余 Day1），之后不再干预用户切换 */
  const initialDaySetRef = useRef(false);
  /** F5：攻略粘贴抽取 Sheet */
  const [showNoteInput, setShowNoteInput] = useState(false);
  /** 交互优化 Module F：统一面板打开来源（顶栏→global 维持原布局；空 Day 卡→day 候选池置顶）。
   *  Task #176：同时作为草案生成的入口上下文上报（服务端自动判定 scope），
   *  不再有手动 scope 选择 */
  const [noteContext, setNoteContext] = useState<OpenContext>({ type: "global" });
  /** M2 F12：近期操作记录 Sheet（仅展示，不提供回滚） */
  const [opLogOpen, setOpLogOpen] = useState(false);
  /** Task #206：约束编辑浮层（⋯ 菜单「修改约束」，保存后经 updateTrip 自动防抖持久化） */
  const [constraintEditorOpen, setConstraintEditorOpen] = useState(false);
  /** F4/F6：从片区标签「看酒店」发起的酒店候选 Sheet（记录目标天与片区）。
   *  Task #354：areaName 为 null 表示当天未设片区，HotelPicker 内渲染片区选择态。 */
  const [hotelPicker, setHotelPicker] = useState<{ dayIndex: number; areaName: string | null } | null>(
    null,
  );
  const [proposalOps, setProposalOps] = useState<Operation[] | null>(null);
  /** F11 全量重排（op=plan 且 scope=all）：挂起待确认的操作，弹 ConfirmDialog 后经确认端点执行 */
  const [fullPlanOps, setFullPlanOps] = useState<Operation[] | null>(null);
  /** Task #219 方案 1：快速搜索命中行程已有大景区/岛内玩法的点位，挂起待用户确认归属 */
  const [childAttachAsk, setChildAttachAsk] = useState<ChildAttachAsk | null>(null);
  /** Task #199：待选择目标大景点的独立景点（打开目标选择浮层） */
  const [classifySourceId, setClassifySourceId] = useState<string | null>(null);
  /** Task #199：已选定目标、待二次确认的归类（确认后原 Visit 删除，不可撤销） */
  const [classifyConfirm, setClassifyConfirm] = useState<{
    visitId: string;
    parentVisitId: string;
  } | null>(null);
  /** 与全量重排同批返回的敏感操作：待确认弹窗结束（确认或取消）后转交 ProposalCard 逐条确认 */
  const [queuedProposalOps, setQueuedProposalOps] = useState<Operation[] | null>(null);
  /** 本批「未执行」的原因列表（服务端原文经可读映射），可展开查看；不为空时不自动消失 */
  const [rejectedReasons, setRejectedReasons] = useState<string[] | null>(null);
  const [showRejectedReasons, setShowRejectedReasons] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  /** 持久提示标记（Task #75）：true 时 flash 不自动消失，需用户点 × 关闭 */
  const [flashSticky, setFlashSticky] = useState(false);
  /** 可展开明细行的开关文案（默认「查看原因」；草案应用结果明细用「查看明细」） */
  const [flashReasonsLabel, setFlashReasonsLabel] = useState("查看原因");
  const flashTimerRef = useRef<number | null>(null);
  /** Task #72 多轮会话：IntentBar 上报的最新百炼 Session ID（新建行程前归档用；不参与渲染） */
  const aiSessionRef = useRef<string | null>(null);
  /** 任务 135：行程级活动草案（生成成功结果 / 重载召回的新鲜待应用草案） */
  const [activeDraft, setActiveDraft] = useState<GuideDraftResult | null>(null);
  /** 用户已关闭过的草案：不再自动召回（任务 #211 起跨刷新持久化——否则未应用草案
   *  每次刷新都重新召回并弹「攻略排好了」浮条，重复打扰；应用成功由服务端消费
   *  pendingGuideDraft，此处记录自然失效） */
  const [dismissedDraftIds, setDismissedDraftIds] = useState<Set<string>>(loadDismissedDraftIds);
  /**
   * 任务 189：已消费来源 id（selected 生成成功后并入）——暂存来源参与过已完成的
   * 生成后退出本轮默认聚焦（贡献已在待应用草案中）；行程级状态，面板关闭重开不丢。
   */
  const [consumedSourceIds, setConsumedSourceIds] = useState<string[]>([]);
  /** Task #257 封面卡：上传中与上传错误（名称 / 备忘走 store.updateTrip 的防抖保存，无需本地态） */
  const [coverUploading, setCoverUploading] = useState(false);
  const [coverError, setCoverError] = useState<string | null>(null);
  /** 同格式重换封面时路径不变，靠本地递增版本击穿浏览器缓存（Trip.version 会话内不变） */
  const [coverRevision, setCoverRevision] = useState(0);
  /** Task #258：封面浮层开关（顶部紧凑入口点开；挂载即渲染，关闭即卸载） */
  const [coverOpen, setCoverOpen] = useState(false);
  /** Task #265：待办清单盘点浮层开关（⋯ 菜单入口；只读，不改行程数据） */
  const [checklistOpen, setChecklistOpen] = useState(false);
  /**
   * Task #282：稀疏攻略澄清挂起状态——服务端返回 clarification 时暂存响应与入参，
   * 弹 ClarificationDialog；用户选择后带 clarificationAnswer 重发 draft 请求。
   */
  const [clarificationPending, setClarificationPending] = useState<{
    clarification: NonNullable<GuideDraftResult["clarification"]>;
    input: GuideDraftGenerationInput;
  } | null>(null);
  /** 任务 135：行程级生成会话——请求与状态不随面板关闭中断 */
  const generation = useGuideDraftGeneration({
    tripId,
    onSuccess: (draft, input) => {
      // Task #282：澄清响应——草案未生成，弹两选项交互
      if (draft.clarification != null) {
        setClarificationPending({ clarification: draft.clarification, input });
        return;
      }
      setActiveDraft(draft);
      // 任务 189：局部优化成功 → 本次所选来源进入已消费集合（退出本轮默认聚焦）；
      // 全部模式不带 id（服务端返回空数组），消费集合不变
      if (draft.sourceMode === "selected" && (draft.sourceIds?.length ?? 0) > 0) {
        const consumed = draft.sourceIds ?? [];
        setConsumedSourceIds((prev) => {
          const merged = new Set(prev);
          for (const id of consumed) merged.add(id);
          return merged.size === prev.length ? prev : [...merged];
        });
      }
      // 草案已持久化（服务端保存 pendingGuideDraft）：刷新权威行程（badge / 候选池同步）
      void store.refreshFromServer();
    },
  });

  // 行程就绪后：首次默认选天（行中定位今天，出发前/行后 Day1）；
  // 之后保持用户当前选择，非法时默认落到第一个有安排的天，否则第 1 天
  useEffect(() => {
    if (!trip) return;
    const days = orderedDays(trip);
    setCurrentDay((prev) => {
      if (!initialDaySetRef.current) {
        initialDaySetRef.current = true;
        if (getTripPhase(trip) === "during") {
          const todayDay = days.find((day) => day.date === todayIso());
          if (todayDay) return todayDay.dayIndex;
        }
      }
      if (days.some((day) => day.dayIndex === prev)) return prev;
      const withVisits = days.find((day) => dayVisits(trip, day).length > 0);
      return withVisits ? withVisits.dayIndex : (days[0]?.dayIndex ?? 1);
    });
  }, [trip]);

  useEffect(
    () => () => {
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    },
    [],
  );

  // Task #109/#206/#258/#265 浮层互斥：攻略原文 / 约束编辑 / 封面浮层 / 待办清单挂载时
  // 分别广播 "evidence" / "constraint" / "cover" / "checklist"，这里收到后关闭自家浮层，
  // 保证面板不同时存在（避免同层级 Sheet 叠层、底层 × 被上层遮挡无法点击）。任一别家
  // 浮层打开都要收起近期操作；封面 / 清单浮层只在没有任何别家浮层要打开时才保留
  // （kind 即自身时不动）。
  useEffect(
    () =>
      onSheetOpened((kind) => {
        if (kind !== "oplog") setOpLogOpen(false);
        if (kind !== "cover") setCoverOpen(false);
        if (kind !== "checklist") setChecklistOpen(false);
      }),
    [],
  );

  // 任务 135 重载召回：行程已挂新鲜待应用草案（版本 / 来源 / 补充句均未变化）且
  // 当前无活动草案、非生成中时，重建为可查看草案——用户点浮条即可直接进入预览，
  // 无需重新生成。过期草案不召回（应用会被 DRAFT_STALE 拒绝，不得给假可用入口）。
  const sessionKind = generation.session.kind;
  useEffect(() => {
    if (trip === null) return;
    if (activeDraft !== null || sessionKind === "generating") return;
    const pending = trip.pendingGuideDraft;
    if (pending === undefined || pending === null || pending.output === undefined) return;
    if (dismissedDraftIds.has(pending.draftId)) return;
    if (!checkPendingGuideDraftFreshness(pending, trip).fresh) return;
    setActiveDraft(draftResultFromTrip(trip));
  }, [trip, activeDraft, sessionKind, dismissedDraftIds]);

  /** 关闭当前提示（带未执行原因 / 持久提示均由用户手动关闭） */
  const clearFlash = () => {
    setFlash(null);
    setRejectedReasons(null);
    setShowRejectedReasons(false);
    setFlashSticky(false);
    setFlashReasonsLabel("查看原因");
  };

  const notify = (message: string) => {
    setRejectedReasons(null);
    setShowRejectedReasons(false);
    setFlashSticky(false);
    setFlashReasonsLabel("查看原因");
    setFlash(message);
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => {
      setFlash(null);
      setRejectedReasons(null);
    }, 3200);
  };

  /** 带可展开明细的提示：不自动消失（明细需可查看），由用户点 × 关闭；
   *  label 定制展开开关文案（默认「查看原因」，草案应用明细用「查看明细」） */
  const notifyWithReasons = (message: string, reasons: string[], label = "查看原因") => {
    if (flashTimerRef.current !== null) {
      window.clearTimeout(flashTimerRef.current);
      flashTimerRef.current = null;
    }
    // Task #379：整批拒绝时 head（服务端 message）已是单点引导常量，明细去重同句，
    // 避免「主行 + 展开明细」重复同一句话；其余场景 head 与明细不同文，不受影响
    setRejectedReasons(reasons.filter((reason) => reason !== message));
    setShowRejectedReasons(false);
    setFlashReasonsLabel(label);
    setFlash(message);
  };

  // ===== Task #257 封面卡：名称 / 备忘走 updateTrip（既有 1s 防抖 PUT），
  // 封面文件由服务端落盘后只回受控路径，再写入 Trip.coverImage（不双写） =====

  /** 名称 / 备忘补丁（无实际变化时 applyCoverPatch 返回原引用，不会触发多余保存） */
  const handleCoverChange = (patch: TripCoverPatch) => {
    store.updateTrip((current) => applyCoverPatch(current, patch));
  };

  /** 上传 / 更换封面：先落盘文件，再把受控相对路径写回 Trip */
  const handleCoverUpload = (file: File) => {
    setCoverUploading(true);
    setCoverError(null);
    void uploadTripCover(tripId, file)
      .then((result) => {
        store.updateTrip((current) => applyCoverPatch(current, { coverImage: result.coverImage }));
        setCoverRevision((revision) => revision + 1);
      })
      .catch((error_: unknown) => {
        setCoverError(error_ instanceof Error ? error_.message : "封面上传失败，请重试");
      })
      .finally(() => setCoverUploading(false));
  };

  /** 移除封面：先清 coverImage（UI 立即回到渐变兜底），再删文件（失败无感知但无痕） */
  const handleCoverRemove = () => {
    setCoverError(null);
    store.updateTrip((current) => applyCoverPatch(current, { coverImage: null }));
    void deleteTripCover(tripId).catch(() => {
      setCoverError("封面文件清理失败，下次上传会自动覆盖");
    });
  };

  /** 持久提示（Task #75）：不自动消失，由用户点 × 关闭；用于候选池新入点位等需要留意的结果 */
  const notifyPersistent = (message: string) => {
    if (flashTimerRef.current !== null) {
      window.clearTimeout(flashTimerRef.current);
      flashTimerRef.current = null;
    }
    setRejectedReasons(null);
    setShowRejectedReasons(false);
    setFlash(message);
    setFlashSticky(true);
  };

  /** 统一汇总执行结果：有 rejected 时提示「有 N 条未执行」并可展开逐条查看原因，不静默 */
  const reportOutcome = (successMessage: string, result: ApplyResult) => {
    const rejectedCount = result.rejected.length;
    if (rejectedCount > 0) {
      const head = result.applied.length > 0 ? `已应用 ${result.applied.length} 项` : "本次未应用任何操作";
      notifyWithReasons(
        `${head}，有 ${rejectedCount} 条未执行`,
        describeRejections(result.rejected.map((rejection) => rejection.reason)),
      );
    } else {
      notify(successMessage);
    }
  };

  /** 意图结果分发：clarify 已由 IntentBar 气泡就地处理，不会到达这里 */
  const handleIntentResult = (result: IntentResult) => {
    switch (result.type) {
      case "applied": {
        const poolItems = result.newPoolItems ?? [];
        const appliedCount = result.result?.applied.length ?? 0;
        if (result.result) {
          store.applyServerResult(result.result);
        }
        if (appliedCount === 0 && poolItems.length > 0) {
          // proposedNew-only（Task #75）：无操作落地、仅 AI 推荐点位入候选池 →
          // 持久提示（交互优化 Module A：候选池抽屉入口已移除，不再自动打开）
          notifyPersistent(
            `AI 推荐了 ${poolItems.length} 个新点位（${poolItems.join("、")}），已加入候选池`,
          );
        } else if (result.result) {
          reportOutcome(
            poolItems.length > 0
              ? `已按你的意图更新行程，另有 ${poolItems.length} 个新点位加入候选池`
              : "已按你的意图更新行程",
            result.result,
          );
        } else {
          notify("AI 已处理，但未返回行程结果");
        }
        break;
      }
      case "proposal": {
        const fullPlan = result.fullPlanOps ?? [];
        if (fullPlan.length > 0) {
          // 全量重排：先弹 ConfirmDialog，不直接应用；同批敏感操作排队等弹窗结束
          setFullPlanOps(fullPlan);
          const sensitive = result.proposalOps ?? [];
          setQueuedProposalOps(sensitive.length > 0 ? sensitive : null);
        } else {
          setProposalOps(result.proposalOps ?? []);
        }
        // 同批被护栏拒绝的条目同样不得静默：提示「有 N 条未执行」并可展开查看原因
        const reasons = result.result?.rejected.map((rejection) => rejection.reason) ?? [];
        if (reasons.length > 0) {
          notifyWithReasons(`有 ${reasons.length} 条未执行`, describeRejections(reasons));
        }
        break;
      }
      case "rejected": {
        const reasons = result.result?.rejected.map((rejection) => rejection.reason) ?? [];
        if (reasons.length > 0) {
          notifyWithReasons(result.message ?? "该请求被安全护栏拒绝", describeRejections(reasons));
        } else {
          notify(result.message ?? "该请求被安全护栏拒绝");
        }
        break;
      }
      case "error":
        notify(result.message ?? "意图处理失败，请重试");
        break;
      case "clarify":
        break;
    }
  };

  /** 提案确认完成：采纳服务端权威结果并关闭 Sheet；未执行项随提示可展开查看原因 */
  const handleProposalConfirm = (result: IntentResult) => {
    setProposalOps(null);
    if (result.type === "applied" && result.result) {
      store.applyServerResult(result.result);
      reportOutcome("已按你的确认执行完成", result.result);
    } else {
      notify(result.message ?? "确认执行失败");
    }
  };

  /** 全量重排弹窗结束后，把同批敏感操作转交 ProposalCard（保持逐条确认行为不变） */
  const flushQueuedProposalOps = () => {
    if (queuedProposalOps !== null && queuedProposalOps.length > 0) {
      setProposalOps(queuedProposalOps);
    }
    setQueuedProposalOps(null);
  };

  /** 全量重排取消：不再二次下发，服务端未应用任何操作（取消不修改行程数据） */
  const handleFullPlanCancel = () => {
    setFullPlanOps(null);
    notify("已取消整体重排，行程未修改");
    flushQueuedProposalOps();
  };

  /** 全量重排确认：经服务端确认端点二次下发（服务端仍重新经过四条护栏），客户端不自行应用 */
  const handleFullPlanConfirm = () => {
    const operations = fullPlanOps;
    if (operations === null) return;
    setFullPlanOps(null);
    confirmProposal(tripId, operations)
      .then((result) => {
        if (result.type === "applied" && result.result) {
          store.applyServerResult(result.result);
          reportOutcome("已按你的确认完成整体重排", result.result);
        } else {
          notify(result.message ?? "整体重排执行失败");
        }
      })
      .catch(() => notify("网络错误，整体重排未执行，请重试"))
      .finally(() => flushQueuedProposalOps());
  };

  /**
   * 来源到达终态 / 来源增删后的权威刷新（Task #106）：
   * 改用 store.refreshFromServer——先把本地未保存编辑冲刷到服务端（含在途 PUT）
   * 再拉取，避免 GET 到旧快照把防抖窗口内的本地编辑覆盖掉；采纳结果不排队防抖
   * PUT（服务端已持久化，普通 updateTrip 会把旧快照再写回覆盖后台装配数据）。
   */
  const handleNotesExtracted = () => {
    void store.refreshFromServer();
  };

  /**
   * B4 草案应用完成（任务 125 扩展）：不能笼统显示成功——服务端 message 作主行，
   * 未选冲突逐条「保持原状」/ 自动归类逐条结果 / 拒绝原因进可展开明细
   * （buildDraftApplyNotice 构建，有明细时用「查看明细」开关且不自动消失）；
   * 随后刷新权威行程（已应用操作 / 挂载的攻略提示已落盘）。
   * 任务 135：草案已被服务端一次性消费，清除行程级活动草案（刷新后也不会再召回）。
   * Task #263：snippet-only 结果（applied=0 但攻略提示已挂载）由 notice.kind=success
   * 统一展示成功文案，这里不得用 applied 是否为空判定失败；同时清掉上一轮生成失败
   * 残留——generation.error 只表示「生成本身失败」，不能被草案应用的结果污染。
   */
  const handleDraftApplied = (result: GuideDraftApplyResult) => {
    setActiveDraft(null);
    generation.dismissFailure();
    const notice = buildDraftApplyNotice(result);
    if (notice.details.length > 0) {
      notifyWithReasons(notice.head, notice.details, "查看明细");
    } else {
      notify(notice.head);
    }
    handleNotesExtracted();
  };

  /** 任务 135：取消草案预览（不应用）——清除活动草案；任务 #211：draftId 跨刷新持久化，
   *  重载后不再自动召回同一份草案（不再重复弹「攻略排好了」浮条） */
  const handleDraftDismiss = () => {
    if (activeDraft !== null && activeDraft.draftId !== null) {
      const next = new Set(dismissedDraftIds);
      next.add(activeDraft.draftId);
      setDismissedDraftIds(next);
      saveDismissedDraftIds(next);
    }
    setActiveDraft(null);
  };

  /** B4 草案应用后仍有敏感操作：转交全局 ProposalCard 逐条确认（NoteInput 已关闭） */
  const handleDraftProposalNeeded = (operations: Operation[]) => {
    if (operations.length > 0) setProposalOps(operations);
  };

  /**
   * 快速搜索落地：把一个点位（飞猪命中 / 自定义）排入目标天末尾。
   * 主数据按既有语义复用（fliggy：同 providerId 或同名；custom：同名），
   * 但不做去重拦截——已存在时仍执行排入（换天重排 / 再次加入）。
   */
  const quickAddOne = (buildItem: () => Item, opts?: { forceLargeAttraction?: boolean }) => {
    const current = store.trip;
    if (current === null) return;
    const fresh = buildItem();
    const existing =
      fresh.origin === "fliggy"
        ? Object.values(current.itemRegistry).find(
            (item) =>
              item.origin === "fliggy" &&
              (item.providerId === fresh.providerId || item.name === fresh.name),
          )
        : Object.values(current.itemRegistry).find(
            (item) => item.origin === "custom" && item.name === fresh.name,
          );
    const target = existing ?? fresh;

    // 已有活跃壳（已排期或候选池的 visit 壳）→ 用 visit 引用排入：plan 对 point
    // 要求「在全局候选区」，已在行程中的点位会被拒；visit 引用无此约束。
    // 复用既有壳时不改动其 kind（保护攻略抽取路径已正确设置的大景区）。
    const pooledVisitIds = new Set<string>();
    for (const ref of current.globalCandidateRefs) {
      if (ref.kind === "visit") pooledVisitIds.add(ref.id);
    }
    const shell = Object.values(current.visits).find(
      (visit) =>
        visit.pointRef === target.itemId &&
        (visit.dayRef !== null || pooledVisitIds.has(visit.visitId)),
    );
    if (shell !== undefined) {
      store.addRefToDay(day.dayIndex, { kind: "visit", id: shell.visitId });
      return;
    }
    // Task #219 方案 3：搜索添加统一走 ensurePoolRef——大景区（关键词/5A 判定）
    // 先建 large_attraction 壳再用 visit 引用排入（plan(point) 只会建 ordinary 壳），
    // 其余维持 point 引用现状；壳进池后由防抖保存持久化。
    const poolRef = store.ensurePoolRef(target, opts);
    if (poolRef !== null) {
      store.addRefToDay(day.dayIndex, poolRef);
    }
  };

  /**
   * 归属判定后的实际落地：POI 逐个排入目标天（5A 景区辅助判定大景区，
   * 关键词判定在 ensurePoolRef 内部兜底）；酒店/自定义同现状。
   */
  const doQuickAdd = (selection: QuickAddSelection) => {
    if (store.trip === null) return;
    for (const poi of selection.pois) {
      quickAddOne(() => poiToItem(poi), { forceLargeAttraction: poi.poiLevel === "AAAAA" });
    }
    for (const hotel of selection.hotels) {
      store.selectHotel(day.dayIndex, hotel);
    }
    const custom = selection.customName?.trim() ?? "";
    if (custom !== "") {
      const customAddress = selection.customAddress?.trim() || null;
      quickAddOne(() => customToItem(custom, customAddress));
    }
  };

  /**
   * 快速搜索确认：先与行程已有大景区交叉比对（Task #219 方案 1）——勾选 POI
   * 与某大景区本名或其岛内玩法名称相近时挂起待确认，确认后作为子景点加入，
   * 取消则全部按独立点位排入；无歧义项直接落地。
   */
  const handleQuickAdd = (selection: QuickAddSelection) => {
    const current = store.trip;
    if (current === null) return;
    const items: ChildAttachAskItem[] = [];
    const restPois: PoiSearchResult[] = [];
    for (const poi of selection.pois) {
      const nameParent = findMatchingLargeVisit(current, poi.name);
      const parent = nameParent ?? findChildStopParentVisit(current, poi.name);
      const parentName = parent !== null ? largeVisitDisplayName(current, parent) : null;
      if (parent !== null && parentName !== null) {
        items.push({
          poi,
          visitId: parent.visitId,
          parentName,
          reason: nameParent !== null ? "name" : "child",
        });
        continue;
      }
      restPois.push(poi);
    }
    if (items.length > 0) {
      setChildAttachAsk({ items, rest: { ...selection, pois: restPois } });
      return;
    }
    doQuickAdd(selection);
  };

  /** 确认作为子景点：挂入对应大景区岛内行程（复用 addCustomStop 的飞猪命中通道），其余项照常落地 */
  const confirmChildAttach = () => {
    const ask = childAttachAsk;
    setChildAttachAsk(null);
    if (ask === null) return;
    for (const item of ask.items) {
      store.addCustomStop(item.visitId, {
        name: item.poi.name,
        locationHint: item.poi.address,
        noteText: null,
        matchedPoi: {
          id: item.poi.id,
          name: item.poi.name,
          address: item.poi.address,
          category: item.poi.category,
          coords: item.poi.coords,
          mainPic: item.poi.mainPic,
          ticketInfo: item.poi.ticketInfo,
          jumpUrl: item.poi.jumpUrl,
          freePoiStatus: item.poi.freePoiStatus ?? undefined, // Task #329 透传
          // Task #330：飞猪 POI 元信息透传（等级/榜单/介绍）
          poiLevel: item.poi.poiLevel ?? undefined,
          listRank: item.poi.listRank ?? undefined,
          description: item.poi.description ?? undefined,
          suggestMinutes: null,
        },
      });
    }
    notify(`已将「${ask.items.map((item) => item.poi.name).join("、")}」加入对应大景区`);
    doQuickAdd(ask.rest);
  };

  /** 取消挂入：全部按独立点位排入（大景区关键词/5A 判定仍会建 large_attraction 壳） */
  const declineChildAttach = () => {
    const ask = childAttachAsk;
    setChildAttachAsk(null);
    if (ask === null) return;
    doQuickAdd({ ...ask.rest, pois: [...ask.items.map((item) => item.poi), ...ask.rest.pois] });
  };

  /**
   * 新建行程（Task #66/#72）：先归档旧百炼多轮会话 → 删除服务端行程（含攻略截图
   * 目录）→ 清本地缓存 → 回到初始化。
   * 删除前先作废未触发的防抖保存，避免延迟 PUT 把已删行程写回；
   * 归档失败不阻塞主流程（archiveAiSession 内部兜底返回 false，不抛错）；
   * 任一步失败返回 false（本地状态保持不动，由 AppHead 提示重试）。
   */
  const handleNewTrip = async (): Promise<boolean> => {
    const current = store.trip;
    if (current === null) return false;
    store.cancelPendingSave();
    // Task #72：行程切换弃用旧多轮会话——先归档再删行程，避免遗留孤儿会话
    const sessionId = aiSessionRef.current;
    if (sessionId !== null) {
      aiSessionRef.current = null;
      await archiveAiSession(sessionId);
    }
    try {
      await deleteTrip(current.tripId);
    } catch {
      return false;
    }
    clearTripCache();
    onNewTrip();
    return true;
  };

  /**
   * Task #206 约束保存：整体替换 constraints（纯前端管理），关闭浮层并提示结果。
   * updateTrip 走路内既有链路（乐观更新 + 写缓存 + debounce PUT），无需额外保存调用。
   */
  const handleSaveConstraints = (next: Constraint[]) => {
    store.updateTrip((current) => ({ ...current, constraints: next }));
    setConstraintEditorOpen(false);
    notify(next.length > 0 ? `已更新约束（${next.length} 条）` : "已清空全部约束");
  };

  if (loading) {
    return (
      <div className="boot">
        <div className="boot-mark">G</div>
        正在打开行程…
      </div>
    );
  }

  if (error || !trip) {
    return (
      <div className="boot">
        <div className="boot-mark">G</div>
        {error ?? "行程不存在或已失效"}
        <button type="button" onClick={() => window.location.reload()}>
          重试
        </button>
      </div>
    );
  }

  const days = orderedDays(trip);
  const day = days.find((item) => item.dayIndex === currentDay) ?? days[0];
  /** Task #257：封面卡展示数据（名称 / 备忘 / 封面 / 自动信息行） */
  const coverInfo = tripCoverInfo(trip);
  /** Module E：是否已有行程内容（任意 Day 有景点）→ AI 栏按钮「AI 调整」/「AI 排一版」 */
  const hasItinerary = days.some((item) => dayVisits(trip, item).length > 0);
  /** 统一添加入口角标：active 的攻略来源篇数（老 Trip 无 guideSources 视为 0）；入口名不随素材数变化 */
  const guideCount = Object.values(trip.guideSources ?? {}).filter((source) => source.active)
    .length;
  /** 底部浮条状态（任务 135）：面板关闭时，行程级生成会话 / 待查看草案在这里持续可见；
   *  面板打开时隐藏（进度 / 结果 / 错误由面板内展示，避免重复噪音） */
  const draftToastState: DraftToastState | null = (() => {
    if (showNoteInput) return null;
    if (generation.session.kind === "generating") {
      // Task #224：浮条与面板消费同一份分级快照，离开面板后仍看得到站点 / 计时 / 预计剩余
      return { kind: "generating", text: generation.thinkingText ?? "", stage: generation.stage };
    }
    // Task #263：已有可查看草案时，「就绪」优先于旧的生成失败态——否则面板前脚应用完
    // snippet-only 草案，底面浮条后脚又弹 role=alert 的「这一版没排成」，形成假失败提示。
    if (activeDraft !== null) return { kind: "ready" };
    if (generation.session.kind === "failed") return { kind: "failed" };
    return null;
  })();
  // HotelPicker 的入住天以发起片区标签所在天为准（可能与当前显示天不同）
  const pickerDay = hotelPicker
    ? (days.find((item) => item.dayIndex === hotelPicker.dayIndex) ?? null)
    : null;

  /**
   * Task #199：独立景点归入大景点。
   * - classifySource：触发归类的普通景点（浮层打开期间保持引用，已删除则自动关闭）；
   * - classifyTargets：可选目标只取「已排期」的大景点——候选池里的壳归入后不可见；
   *   Task #360（PD 2026-11-10 拍板）：由全局常量改为随源 visit 计算，仅保留距离合格
   *   的目标（双方有坐标 ≤2km；任一方无坐标→同天兜底），与 VisitCard 按钮显示口径一致；
   * - classifyPending*：二次确认弹窗的双方实体（任一消失则不弹，交由执行通道驳回）。
   */
  const classifySource = classifySourceId !== null ? (trip.visits[classifySourceId] ?? null) : null;
  const classifyTargets =
    classifySource !== null ? eligibleClassifyTargets(trip, classifySource) : [];
  const classifyPendingSource =
    classifyConfirm !== null ? (trip.visits[classifyConfirm.visitId] ?? null) : null;
  const classifyPendingParent =
    classifyConfirm !== null ? (trip.visits[classifyConfirm.parentVisitId] ?? null) : null;

  /** 选定目标后关选择浮层、弹二次确认（归入会删除原 Visit，不可逆） */
  const pickClassifyParent = (parentVisitId: string) => {
    if (classifySourceId === null) return;
    setClassifyConfirm({ visitId: classifySourceId, parentVisitId });
    setClassifySourceId(null);
  };

  /** 确认归类：执行 classifyVisitAsStop（用户通道免强证据）并提示结果 */
  const confirmClassifyIntoParent = () => {
    const pending = classifyConfirm;
    setClassifyConfirm(null);
    if (pending === null) return;
    const source = trip.visits[pending.visitId];
    const parent = trip.visits[pending.parentVisitId];
    if (source === undefined || parent === undefined) {
      notify("归入未执行：点位或大景点已变化，请刷新后重试");
      return;
    }
    const sourceName = visitDisplayName(trip, source);
    const parentName = visitDisplayName(trip, parent);
    if (store.classifyVisitAsParentStop(pending.visitId, pending.parentVisitId)) {
      notify(`已将「${sourceName}」归入「${parentName}」`);
    } else {
      notify("归入未执行：请检查该景点是否已锁定/已购票，或目标大景点是否可用");
    }
  };

  return (
    <div className="app">
      <AppHead
        trip={trip}
        onOpenOpLog={() => setOpLogOpen(true)}
        onOpenChecklist={() => setChecklistOpen(true)}
        onEditConstraints={() => setConstraintEditorOpen(true)}
        onNewTrip={handleNewTrip}
      />
      {/* Task #258：顶部只保留一行封面紧凑入口（缩略图 + 名称 + 城市·N天N晚 + 箭头），
          封面图 / 名称编辑 / 备忘全部收进浮层，Day 标签与当天内容不再被挤压 */}
      <TripCoverBar
        info={coverInfo}
        revision={coverRevision}
        expanded={coverOpen}
        onOpen={() => setCoverOpen(true)}
      />
      {/* 交互优化 Module A：通栏浅橙描边入口，页面唯一强调入口（门）；
          已有攻略素材时右侧数字徽章标识篇数 */}
      <button
        type="button"
        className="add-entry"
        onClick={() => {
          setNoteContext({ type: "global" });
          setShowNoteInput(true);
        }}
      >
        ＋ 添加攻略 / 地点
        {guideCount > 0 ? (
          <span className="add-entry-badge" aria-label={`已有 ${guideCount} 篇攻略素材`}>
            {guideCount}
          </span>
        ) : null}
      </button>
      <DayStrip trip={trip} currentDay={day.dayIndex} onSelect={setCurrentDay} />
      {/* key 保证切天时滚动位置重置并触发入场动画 */}
      <div className="screen" key={day.dayIndex}>
        <DayContent
          trip={trip}
          day={day}
          onOpenNoteInput={(dayIndex) => {
            setNoteContext({ type: "day", dayIndex });
            setShowNoteInput(true);
          }}
          onRemoveVisit={store.removeVisitWithUndo}
          onBatchRemove={store.removeVisitsWithUndo}
          onPurchaseSelect={(visitId, state) => store.setPurchaseState(visitId, state)}
          onToggleLock={store.toggleLock}
          onLodgingPurchaseSelect={store.setLodgingPurchaseState}
          onToggleLodgingLock={store.toggleLodgingLock}
          onUpdateDepart={store.updateDepartTime}
          onReorderDayItems={store.reorderDayItems}
          onMoveDayItem={store.moveDayItem}
          onMoveStop={store.moveStop}
          onRemoveStop={store.removeStopWithUndo}
          onRestoreStop={store.restoreStop}
          onClassifyIntoParent={setClassifySourceId}
          onAdoptSuggestedStops={store.adoptSuggestedStops}
          onAddStop={store.addCustomStop}
          onSearchHotels={(dayIndex, areaName) => setHotelPicker({ dayIndex, areaName })}
          onRemoveHotel={store.removeHotelCandidate}
        />
      </div>
      <IntentBar
        tripId={tripId}
        hasContent={hasItinerary}
        onResult={handleIntentResult}
        onSessionChange={(id) => {
          aiSessionRef.current = id;
        }}
      />
      {store.undoState ? (
        <UndoToast text={undoText(store.undoState)} onUndo={store.undoRemove} />
      ) : null}
      {flash ? (
        <div className="ai-flash" role="status">
          <div className="flash-line">
            <span>{flash}</span>
            {rejectedReasons !== null && rejectedReasons.length > 0 ? (
              <button
                type="button"
                className="flash-toggle"
                onClick={() => setShowRejectedReasons((open) => !open)}
              >
                {showRejectedReasons ? "收起" : flashReasonsLabel}
              </button>
            ) : null}
            {rejectedReasons !== null || flashSticky ? (
              <button type="button" className="flash-close" onClick={clearFlash} aria-label="关闭提示">
                ×
              </button>
            ) : null}
          </div>
          {showRejectedReasons && rejectedReasons !== null ? (
            <ul className="flash-reasons">
              {rejectedReasons.map((reason, index) => (
                <li key={`${index}-${reason}`}>{reason}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {proposalOps !== null && proposalOps.length > 0 ? (
        <ProposalCard
          tripId={tripId}
          operations={proposalOps}
          trip={trip}
          onConfirm={handleProposalConfirm}
          onCancel={() => setProposalOps(null)}
        />
      ) : null}
      {fullPlanOps !== null ? (
        <ConfirmDialog
          title="整体重排确认"
          description="会覆盖你手动调整过的顺序与时间；已定项与已购状态不受影响"
          confirmText="确认重排"
          cancelText="取消"
          onConfirm={handleFullPlanConfirm}
          onCancel={handleFullPlanCancel}
        />
      ) : null}
      {/* Task #282：稀疏攻略澄清对话框——服务端检测到覆盖缺口时弹出，用户选择后重发 draft */}
      {clarificationPending !== null ? (
        <ClarificationDialog
          clarification={clarificationPending.clarification}
          onAnswer={(answer: ClarificationAnswer) => {
            const { input } = clarificationPending;
            setClarificationPending(null);
            generation.start({ ...input, clarificationAnswer: answer });
          }}
          onCancel={() => setClarificationPending(null)}
        />
      ) : null}
      {childAttachAsk !== null ? (
        <ConfirmDialog
          title="确认点位归属"
          description={`${childAttachAsk.items
            .map((item) =>
              item.reason === "name"
                ? `「${item.poi.name}」与行程中大景区「${item.parentName}」名称相近`
                : `「${item.poi.name}」与「${item.parentName}」岛内玩法同名`,
            )
            .join(
              "；",
            )}。确认后作为对应大景区的子景点加入（跟随大景区所在天）；独立排入则加入所选天。`}
          confirmText="作为子景点加入"
          cancelText="独立排入"
          onConfirm={confirmChildAttach}
          onCancel={declineChildAttach}
        />
      ) : null}
      {/* Task #199：独立景点归入大景点——先选目标（已排期大景点），再二次确认 */}
      {classifySource !== null ? (
        <>
          <div
            className="classify-overlay"
            onClick={() => setClassifySourceId(null)}
            aria-hidden="true"
          />
          <div
            className="classify-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="选择目标大景点"
          >
            <h3 className="classify-title">归入大景点</h3>
            <p className="classify-desc">
              选择要把「{visitDisplayName(trip, classifySource)}」归入的大景点：
            </p>
            {classifyTargets.length > 0 ? (
              <div className="classify-list">
                {classifyTargets.map((target) => {
                  const targetDay =
                    target.dayRef !== null ? (trip.days[target.dayRef]?.dayIndex ?? null) : null;
                  return (
                    <button
                      key={target.visitId}
                      type="button"
                      className="classify-option"
                      disabled={target.locked}
                      onClick={() => pickClassifyParent(target.visitId)}
                    >
                      <span className="classify-option-name">{visitDisplayName(trip, target)}</span>
                      <span className="classify-option-meta">
                        {targetDay !== null ? `Day${targetDay}` : "未排期"}
                        {target.childStopRefs.length > 0
                          ? ` · 已有 ${target.childStopRefs.length} 个内部玩法`
                          : " · 暂无内部玩法"}
                        {target.locked ? " · 已锁定，需先解锁" : ""}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="classify-empty">行程里还没有可归入的大景点，先把大景点排进某一天。</p>
            )}
            <button
              type="button"
              className="classify-cancel"
              onClick={() => setClassifySourceId(null)}
            >
              取消
            </button>
          </div>
        </>
      ) : null}
      {/* Task #199：归入不可逆（原 Visit 删除转为内部玩法），执行前必须二次确认 */}
      {classifyConfirm !== null && classifyPendingSource !== null && classifyPendingParent !== null ? (
        <ConfirmDialog
          title="归入大景点"
          description={`将「${visitDisplayName(trip, classifyPendingSource)}」归入「${visitDisplayName(
            trip,
            classifyPendingParent,
          )}」？归入后将显示为${visitDisplayName(
            trip,
            classifyPendingParent,
          )}的内部玩法，原卡片会从当前天移除，且不可撤销。`}
          confirmText="确认归入"
          cancelText="再想想"
          danger
          onConfirm={confirmClassifyIntoParent}
          onCancel={() => setClassifyConfirm(null)}
        />
      ) : null}
      {/* Task #258：封面浮层（挂载即打开；与近期操作 / 约束编辑 / 攻略原文经 sheetBus 互斥） */}
      {coverOpen ? (
        <TripCoverSheet
          info={coverInfo}
          uploading={coverUploading}
          error={coverError}
          revision={coverRevision}
          onChange={handleCoverChange}
          onUploadCover={handleCoverUpload}
          onRemoveCover={handleCoverRemove}
          onClose={() => setCoverOpen(false)}
        />
      ) : null}
      {/* Task #265：待办清单盘点浮层（挂载即打开；与近期操作 / 封面 / 约束编辑 / 攻略原文经 sheetBus 互斥） */}
      {checklistOpen ? (
        <TripChecklist trip={trip} onClose={() => setChecklistOpen(false)} />
      ) : null}
      {/* Task #109：条件渲染（挂载即打开，关闭即卸载），DOM 中不再常驻关闭态 Sheet；
          打开前 EvidenceSheet 已被 sheetBus 互斥事件关闭（或反之），两者不同时存在 */}
      {opLogOpen ? (
        <OpLogSheet
          entries={store.opLog}
          onClose={() => setOpLogOpen(false)}
          onClear={store.clearOpLog}
        />
      ) : null}
      {/* Task #206：约束编辑浮层（挂载即打开；与近期操作 / 攻略原文经 sheetBus 互斥） */}
      {constraintEditorOpen ? (
        <ConstraintEditor
          initialConstraints={trip.constraints}
          totalDays={days.length}
          startDate={trip.dateRange.start}
          onSave={handleSaveConstraints}
          onCancel={() => setConstraintEditorOpen(false)}
        />
      ) : null}
      {showNoteInput ? (
        <NoteInput
          tripId={tripId}
          trip={trip}
          cityName={trip.destination.city}
          dayIndex={day.dayIndex}
          checkIn={day.date}
          checkOut={nextDate(day.date)}
          openContext={noteContext}
          onAddCandidate={store.addRefToDay}
          onUndoAddCandidate={store.removeVisitWithUndo}
          onExtracted={handleNotesExtracted}
          onQuickAdd={handleQuickAdd}
          onDraftApplied={handleDraftApplied}
          onProposalNeeded={handleDraftProposalNeeded}
          consumedSourceIds={consumedSourceIds}
          generation={{
            active: generation.session.kind === "generating",
            text: generation.thinkingText,
            error: generation.session.kind === "failed" ? generation.session.message : null,
            // Task #224：面板内路线与底部浮条同源快照（缺省时面板自动退回单行思考链）
            stage: generation.stage,
          }}
          onGenerateDraft={(input) => generation.start(input)}
          onCancelGenerateDraft={generation.cancel}
          draft={activeDraft}
          onDraftDismiss={handleDraftDismiss}
          onClose={() => setShowNoteInput(false)}
        />
      ) : null}
      {/* 任务 135：底部草案状态浮条——生成中可点击重开面板继续等待；完成后点开直接看
          已持久化草案；失败态提供直接重试（按上一轮入口上下文与补充句重发）。非阻塞，
          z-index 在 Sheet 之下，不拦截其他浮层 */}
      {draftToastState !== null ? (
        <DraftStatusToast
          state={draftToastState}
          onOpen={() => {
            // 任务 204：浮条是行程级生成会话入口，进度 / 草案 / 失败原因都渲染在 global
            // 面板的攻略区（day 面板经任务 198 收口后不含攻略区）。重开前强制回 global，
            // 避免上次从日卡打开面板残留的 day 上下文让「查看」落进「添加到 DayN」。
            setNoteContext({ type: "global" });
            setShowNoteInput(true);
          }}
          onRetry={() => {
            if (generation.session.kind !== "failed") return;
            // 任务 189：按上一轮入参快照原样重发（含 sourceMode / selectedSourceIds），
            // 不重新构造——局部优化的重试必须仍是同一批来源
            generation.start(generation.session.input);
          }}
        />
      ) : null}
      {hotelPicker && pickerDay ? (
        <HotelPicker
          dayIndex={pickerDay.dayIndex}
          areaName={hotelPicker.areaName}
          checkIn={pickerDay.date}
          checkOut={nextDate(pickerDay.date)}
          trip={trip}
          onUpdateArea={store.updateLodgingArea}
          onSelect={(selectedDayIndex, hotel) => {
            store.selectHotel(selectedDayIndex, hotel);
            setHotelPicker(null);
          }}
          onClose={() => setHotelPicker(null)}
        />
      ) : null}
      {saving ? <div className="saving-flag">保存中…</div> : null}
    </div>
  );
}
