import { useEffect, useRef, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Day, HotelCandidate, LodgingPlan, Trip, Visit } from "@goplay/shared";
import { shortDate, weekdayLabel } from "../lib/format";
import { SHOW_ESTIMATED_TIMES } from "../lib/displayFlags";
import { buildDragSurfaceListeners } from "../lib/dragSurface";
import { emptyDayTitle } from "../lib/tripPhase";
import { dayLodging, dayVisits, getPrimaryHotel, visitDisplayName } from "../lib/trip";
import { dayDisplayItems, hotelSortableId, type DayDisplayItem } from "../lib/dayOrder";
import type { CustomStopInput } from "../hooks/useTrip";
import AddStopSheet from "./AddStopSheet";
import { ConfirmDialog } from "./ConfirmDialog";
import ConstraintBar from "./ConstraintBar";
import EmptyDay from "./EmptyDay";
import EvidenceSheet from "./EvidenceSheet";
import HotelCard from "./HotelCard";
import RouteStrip from "./RouteStrip";
import VisitCard from "./VisitCard";

interface DayContentProps {
  trip: Trip;
  day: Day;
  /**
   * 打开统一添加面板（交互优化 Module A/D：空天卡与 dayhead「添加」共入口；
   * dayIndex 供上层设置 openContext）。
   */
  onOpenNoteInput: (dayIndex: number) => void;
  /** 移除单个点位回候选池（5 秒撤销窗口由上层管理） */
  onRemoveVisit: (dayIndex: number, visitId: string) => void;
  /** M2 F12 批量移回候选池：整批共用一个撤销窗口 */
  onBatchRemove: (dayIndex: number, visitIds: string[]) => void;
  /** F7 购票状态明确选择（站外已购携带备注） */
  onPurchaseSelect: (visitId: string, state: Visit["purchaseState"], externalNote?: string) => void;
  /** F3 锁定切换 */
  onToggleLock: (visitId: string) => void;
  /** 住宿预订状态三档选择（lodging target；同一 LodgingPlan 由当天所有候选卡共享） */
  onLodgingPurchaseSelect: (dayIndex: number, state: LodgingPlan["purchaseState"]) => void;
  /** 住宿锁定切换（lodging target） */
  onToggleLodgingLock: (dayIndex: number) => void;
  onUpdateDepart: (dayIndex: number, time: string) => void;
  /** 景点 + 酒店混合列表改序（拖拽落点；下标为当天展示列表的 0-based 下标） */
  onReorderDayItems: (dayIndex: number, fromIndex: number, toIndex: number) => void;
  /** 混合列表 ↑↓ 按钮（direction=-1 上移 / 1 下移） */
  onMoveDayItem: (dayIndex: number, itemIndex: number, direction: -1 | 1) => void;
  /** 内部玩法父内改序（上移/下移） */
  onMoveStop: (visitId: string, fromIndex: number, toIndex: number) => void;
  /** 内部玩法移入父备选玩法 */
  onRemoveStop: (visitId: string, stopId: string) => void;
  /** 备选玩法放回岛内行程 */
  onRestoreStop: (stopId: string) => void;
  /** Task #199：把独立普通景点归入大景区（上层弹目标选择 + 二次确认） */
  onClassifyIntoParent?: (visitId: string) => void;
  /** 验收修复：父卡一键采纳高置信度待定玩法（批量 transfer 进 childStopRefs） */
  onAdoptSuggestedStops?: (visitId: string) => void;
  /** 手动添加点位（PRD §7.6） */
  onAddStop: (visitId: string, input: CustomStopInput) => void;
  /** 从锚点行「看酒店」发起酒店搜索：上层打开 HotelPicker Sheet。
   *  Task #354：areaName 传 null 表示当天未设片区，由 HotelPicker 渲染片区选择态；
   *  不再回退城市名（城市名会被服务端 findAreaByName 判为未知片区而 400）。 */
  onSearchHotels: (dayIndex: number, areaName: string | null) => void;
  /** 移除住宿候选：仅移出规划（registry 主数据保留，不触发真实订单取消） */
  onRemoveHotel: (dayIndex: number, hotelId: string) => void;
}

/** 混合列表条目的 sortable id：景点沿用 visitId，酒店加前缀避免两套 id 空间混淆 */
function sortableIdOf(item: DayDisplayItem): string {
  return item.kind === "visit" ? item.ref : hotelSortableId(item.ref);
}

/** 拖动已锁定/已购票点位时待二次确认的操作（确认后才真正执行 reorder） */
interface PendingReorder {
  oldIndex: number;
  newIndex: number;
  visit: Visit;
}

/** M2 F12 批量移除含已定/已购项时，待二次确认的执行载荷（取消不修改） */
interface PendingBatch {
  ids: string[];
  riskyNames: string[];
}

/** 待二次确认的住宿候选移除（当天计划已标记已订时；确认后才真正移出规划） */
interface PendingHotelRemove {
  hotelId: string;
  name: string;
}

/**
 * 酒店候选行（混合列表成员）：useSortable 挂整张卡；Task #346 起拖拽面为整卡行容器
 * （listeners 经 dragSurface 守卫），键盘路径透传给卡内 sr-only .drag-kbd 把手。
 * sortable id 用 hotelRef（registry key）而非 hotel.id —— rev2 迁移后两者可能不一致，
 * 用错会让 SortableContext 与 sortable 节点失联，表现为拖拽无效。
 */
function SortableHotelRow({
  hotel,
  hotelId,
  index,
  total,
  candidateTotal,
  primary,
  purchaseState,
  locked,
  onMove,
  onRemove,
  onPurchaseSelect,
  onToggleLock,
}: {
  hotel: HotelCandidate;
  hotelId: string;
  index: number;
  total: number;
  candidateTotal: number;
  primary: boolean;
  purchaseState: LodgingPlan["purchaseState"];
  locked: boolean;
  onMove: (fromIndex: number, toIndex: number) => void;
  onRemove: () => void;
  onPurchaseSelect: (state: LodgingPlan["purchaseState"]) => void;
  onToggleLock: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: hotelSortableId(hotelId),
  });
  const surfaceListeners = buildDragSurfaceListeners(listeners);
  const dragStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 100 : undefined,
  };
  return (
    <div
      ref={setNodeRef}
      className="hotelcard-wrap"
      style={dragStyle}
      data-dragging={isDragging ? "true" : undefined}
      {...surfaceListeners}
    >
      <HotelCard
        hotel={hotel}
        index={index}
        total={total}
        candidateTotal={candidateTotal}
        primary={primary}
        purchaseState={purchaseState}
        locked={locked}
        onMove={onMove}
        onRemove={onRemove}
        onPurchaseSelect={onPurchaseSelect}
        onToggleLock={onToggleLock}
        dragKeyboardProps={{ ...attributes, onKeyDown: listeners?.onKeyDown }}
      />
    </div>
  );
}

const DEPART_TIME_PATTERN = /^\d{2}:\d{2}$/;

/** 出发地名称：优先前一晚酒店（Day>1）；Day1 有抵达航班回退「机场」，否则中性「住宿地」 */
function departureFromName(trip: Trip, day: Day): string {
  if (day.dayIndex > 1) {
    const prevHotel = getPrimaryHotel(trip, dayLodging(trip, day.dayIndex - 1));
    if (prevHotel !== null) return prevHotel.name;
    const currentHotel = getPrimaryHotel(trip, dayLodging(trip, day.dayIndex));
    if (currentHotel !== null) return currentHotel.name;
  }
  const arrivesByFlight = trip.constraints.some(
    (constraint) => constraint.type === "flight_arrive" && constraint.dayIndex === day.dayIndex,
  );
  return arrivesByFlight ? "机场" : "住宿地";
}

/** 出发时间来源灰字（Task #281 S5）：直接读取派生字段 day.timeSourceLabel。
 *  四状态：手改"你设定" / 抵达日"按你的到达航班 HH:MM 算" / 返程日"按回程航班倒推…" / 普通日 null（不显示）。
 *  展示限场景：仅抵达日/返程日出发时间旁＋时间编辑态＋手改 Day 时间行；无全局角标。
 *  Task #340：带具体时间（HH:MM）的标签属估算时间来源徽标，开关关闭时不展示；
 *  不带时间的语义标签（"你设定" / "按回程航班倒推…"）保留。 */
function departSourceText(_trip: Trip, day: Day): string | null {
  const label = day.timeSourceLabel ?? null;
  if (label === null) return null;
  if (!SHOW_ESTIMATED_TIMES && /\d{1,2}:\d{2}/.test(label)) return null;
  return label;
}

interface DayAnchorProps {
  trip: Trip;
  day: Day;
  /** 当天住宿计划（null = 尚无住宿意向） */
  lodging: LodgingPlan | null;
  /** 当前展示酒店（hotelRefs[0] 查表；null = 未选酒店） */
  hotel: HotelCandidate | null;
  /** 当天第一站名称（展示顺序首个景点；无景点时 null，出发行不展示箭头段） */
  firstVisitName: string | null;
  onSearchHotels: (dayIndex: number, areaName: string | null) => void;
  onUpdateDepart: (dayIndex: number, time: string) => void;
}

/**
 * Module B 当日锚点容器（两行）：
 * 第一行出发：🏨 从 X 出发 → 第一站；右侧出发时间（点「改」进 time 输入）+ 来源灰字；
 * 第二行住宿：🛏 今晚住 · 酒店名（待定/已锁定）；右侧「看酒店 ›」打开 HotelPicker。
 * 替代原 DepartTime / AreaTag / 住宿占位三个分散块。
 */
function DayAnchor({
  trip,
  day,
  lodging,
  hotel,
  firstVisitName,
  onSearchHotels,
  onUpdateDepart,
}: DayAnchorProps) {
  const [editing, setEditing] = useState(false);
  // departTime 可为 null（待定）；draft 保持 string，避免受控 input 出现 null 值
  const [draft, setDraft] = useState(day.departTime ?? "");

  useEffect(() => {
    if (!editing) setDraft(day.departTime ?? "");
  }, [day.departTime, editing]);

  const submit = () => {
    const value = draft.trim();
    if (DEPART_TIME_PATTERN.test(value) && value !== day.departTime) {
      onUpdateDepart(day.dayIndex, value);
    }
    setEditing(false);
  };

  /** 住宿状态：已选酒店且已锁定/已订 → 已锁定；其余（含未选酒店）→ 待定 */
  const lodgingStatus =
    hotel !== null && lodging !== null && (lodging.locked || lodging.purchaseState === "bought")
      ? "已锁定"
      : "待定";

  return (
    <div className="day-anchor">
      <div className="anchor-line">
        <span className="anchor-text">
          🏨 从 {departureFromName(trip, day)} 出发
          {firstVisitName !== null ? ` → ${firstVisitName}` : ""}
        </span>
        {editing ? (
          <span className="anchor-side editing">
            <input
              className="depart-input"
              type="time"
              value={draft}
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              onBlur={submit}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit();
                if (event.key === "Escape") setEditing(false);
              }}
              aria-label="修改当日出发时间"
            />
            {departSourceText(trip, day) !== null ? (
              <span className="anchor-src editing-hint">{departSourceText(trip, day)}</span>
            ) : null}
          </span>
        ) : (
          <span className="anchor-side">
            <span className="anchor-time-col">
              <span className={`anchor-time${day.departTimeOverridden ? " overridden" : ""}`}>
                {day.departTime || "--:--"}
              </span>
              {departSourceText(trip, day) !== null ? (
                <span className="anchor-src">{departSourceText(trip, day)}</span>
              ) : null}
            </span>
            <button
              type="button"
              className="anchor-edit-btn"
              onClick={() => setEditing(true)}
              aria-label="修改当日出发时间"
            >
              改
            </button>
          </span>
        )}
      </div>
      <div className="anchor-line">
        <span className="anchor-text">
          🛏 今晚住 · {hotel !== null ? hotel.name : "…"}
          <span className={`anchor-lodging-status${lodgingStatus === "已锁定" ? " locked" : ""}`}>
            （{lodgingStatus}）
          </span>
        </span>
        <button
          type="button"
          className="anchor-hotels-btn"
          onClick={() => onSearchHotels(day.dayIndex, lodging?.areaName ?? null)}
        >
          看酒店 ›
        </button>
      </div>
    </div>
  );
}

/**
 * 当天内容区（v1.1 父子模型 + 景点/酒店混合排序）：
 * 约束条 → 两行锚点容器（出发 + 住宿，交互优化 Module B）→
 * 路线顺序总览（按混排顺序展开住宿 / 机场 / 景点 / 大景区岛内玩法，仅此一处）→
 * 统一混合列表（景点卡与住宿候选卡同列，可拖拽 / ↑↓ 任意调换先后）；
 * 空 Day 只展示一张紧凑虚线空态卡（Module D）；
 * 支持批量管理模式（已锁定/已购票项不可勾选——remove op 会拒绝）。
 */
export default function DayContent({
  trip,
  day,
  onOpenNoteInput,
  onRemoveVisit,
  onBatchRemove,
  onPurchaseSelect,
  onToggleLock,
  onLodgingPurchaseSelect,
  onToggleLodgingLock,
  onUpdateDepart,
  onReorderDayItems,
  onMoveDayItem,
  onMoveStop,
  onRemoveStop,
  onRestoreStop,
  onClassifyIntoParent,
  onAdoptSuggestedStops,
  onAddStop,
  onSearchHotels,
  onRemoveHotel,
}: DayContentProps) {
  const visits = dayVisits(trip, day);
  /** 当天统一展示列表：景点 + 酒店候选（displayOrder 优先，缺失时景点在前酒店在后） */
  const displayItems = dayDisplayItems(trip, day);
  /** 酒店候选数（与混合列表长度区分：单酒店时仍隐藏 ↑↓） */
  const hotelCandidateTotal = displayItems.filter((item) => item.kind === "hotel").length;
  /** 首个景点：其交通行显示「从住处出发」（列表首位可能是酒店） */
  const firstVisitRef = displayItems.find((item) => item.kind === "visit")?.ref ?? null;
  const dayConstraints = trip.constraints.filter(
    (constraint) => constraint.dayIndex === day.dayIndex,
  );
  const lodging = dayLodging(trip, day.dayIndex);
  /** Module B 锚点行：第一站名称（展示顺序里的首个景点） */
  const firstVisitItem = displayItems.find((item) => item.kind === "visit");
  const firstVisitName =
    firstVisitItem?.kind === "visit" ? visitDisplayName(trip, firstVisitItem.visit) : null;
  /** Module B 锚点行：当前展示酒店（hotelRefs[0] 查表） */
  const primaryHotel = getPrimaryHotel(trip, lodging);

  // 游玩时长：仅统计已知 effectiveMinutes（未知不当作 0）
  const knownVisits = visits.filter((visit) => visit.effectiveMinutes !== null);
  const totalMinutes = knownVisits.reduce((sum, visit) => sum + (visit.effectiveMinutes ?? 0), 0);

  const [pendingReorder, setPendingReorder] = useState<PendingReorder | null>(null);
  const [pendingHotelRemove, setPendingHotelRemove] = useState<PendingHotelRemove | null>(null);
  /** M2 F12 批量管理：进入后当天点位可多选（默认不选），底部操作栏提交移除 */
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [pendingBatch, setPendingBatch] = useState<PendingBatch | null>(null);
  /** 攻略原文 Sheet 的目标内部玩法 */
  const [evidenceStopId, setEvidenceStopId] = useState<string | null>(null);
  /** 手动添加点位 Sheet 的目标大景区 */
  const [addStopVisitId, setAddStopVisitId] = useState<string | null>(null);
  /**
   * Task #334：添加点位未命中飞猪 POI 时的降级提示（内联小条，3 秒自动消失，
   * 不新增弹框）——让「静默降级 custom」可感知
   */
  const [customStopNotice, setCustomStopNotice] = useState<string | null>(null);
  const customStopNoticeTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (customStopNoticeTimerRef.current !== null) {
        window.clearTimeout(customStopNoticeTimerRef.current);
      }
    },
    [],
  );

  const evidenceStop = evidenceStopId !== null ? trip.stops[evidenceStopId] ?? null : null;
  const addStopVisit = addStopVisitId !== null ? trip.visits[addStopVisitId] ?? null : null;

  const enterBatchMode = () => {
    setSelectedIds(new Set());
    setBatchMode(true);
  };

  const exitBatchMode = () => {
    setBatchMode(false);
    setSelectedIds(new Set());
    setPendingBatch(null);
  };

  /** 已锁定/已购票项不可勾选：v1.1 remove op 会拒绝，入口直接禁用 */
  const selectable = (visit: Visit) => !visit.locked && visit.purchaseState !== "bought";

  const toggleSelect = (visitId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(visitId)) next.delete(visitId);
      else next.add(visitId);
      return next;
    });
  };

  /** 含已定/已购项时先二次确认（取消不修改），否则直接执行 */
  const requestBatchRemove = () => {
    const ids = visits
      .filter((visit) => selectedIds.has(visit.visitId))
      .map((visit) => visit.visitId);
    if (ids.length === 0) return;
    const riskyNames = visits
      .filter(
        (visit) =>
          selectedIds.has(visit.visitId) &&
          (visit.locked || visit.purchaseState === "bought"),
      )
      .map((visit) => visitDisplayName(trip, visit));
    if (riskyNames.length > 0) {
      setPendingBatch({ ids, riskyNames });
      return;
    }
    onBatchRemove(day.dayIndex, ids);
    exitBatchMode();
  };

  const confirmBatchRemove = () => {
    const pending = pendingBatch;
    if (!pending) return;
    onBatchRemove(day.dayIndex, pending.ids);
    exitBatchMode();
  };

  // Task #346（PD：把手列移除、拖拽保留，整卡作为拖拽面）后的 sensors 取舍：
  // - MouseSensor distance 8：桌面鼠标手感与原 PointerSensor 完全一致；
  // - TouchSensor delay 200 / tolerance 5：整卡面无法再给把手设 touch-action: none，
  //   触摸改长按激活——pending 期 dnd-kit 不 preventDefault（AbstractPointerSensor 源码），
  //   竖向滚动完全让路给浏览器；激活后 handleMove 对 touchmove preventDefault 阻断滚动；
  // - 绝不混挂 PointerSensor + TouchSensor：触摸手势会先后派发 pointerdown + touchstart，
  //   两 sensor 同时 pending 且 dnd-kit 不互斥清理，TouchSensor 超 tolerance 会 dispatch
  //   DragCancel 误杀进行中的拖拽会话（本项目酒店卡历史缺陷的根因）；MouseSensor 只认
  //   mousedown，与 touchstart 不同源，不构成该竞争；
  // - KeyboardSensor：sr-only .drag-kbd 把手承载 onKeyDown，键盘可达性不丢。
  // 景点与酒店共用同一 DndContext / sensors：混合列表拖拽在两端的触发方式一致。
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /**
   * 落地下标移动：相邻一步走 moveDayItem（↑↓ 按钮的语义入口），
   * 跨位（拖拽落点）走 reorderDayItems；两者最终共用同一套写入。
   */
  const applyMove = (fromIndex: number, toIndex: number) => {
    if (toIndex === fromIndex + 1) onMoveDayItem(day.dayIndex, fromIndex, 1);
    else if (toIndex === fromIndex - 1) onMoveDayItem(day.dayIndex, fromIndex, -1);
    else onReorderDayItems(day.dayIndex, fromIndex, toIndex);
  };

  /** 混合列表改序入口（拖拽与 ↑↓ 共用）：锁定/已购景点先二次确认 */
  const requestMoveItem = (fromIndex: number, toIndex: number) => {
    const item = displayItems[fromIndex];
    if (item === undefined || fromIndex === toIndex) return;
    if (item.kind === "visit" && (item.visit.locked || item.visit.purchaseState === "bought")) {
      setPendingReorder({ oldIndex: fromIndex, newIndex: toIndex, visit: item.visit });
      return;
    }
    applyMove(fromIndex, toIndex);
  };

  /** 酒店移除：已订计划先二次确认（仅解除规划引用，不取消真实订单） */
  const requestHotelRemove = (hotelId: string, name: string) => {
    if (lodging !== null && lodging.purchaseState === "bought") {
      setPendingHotelRemove({ hotelId, name });
      return;
    }
    onRemoveHotel(day.dayIndex, hotelId);
  };

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = displayItems.findIndex((item) => sortableIdOf(item) === String(active.id));
    const newIndex = displayItems.findIndex((item) => sortableIdOf(item) === String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    requestMoveItem(oldIndex, newIndex);
  }

  return (
    <div className="daycontent">
      <div className="dayhead">
        <div>
          <div className="t">
            Day{day.dayIndex} · {shortDate(day.date)} {weekdayLabel(day.date)}
          </div>
          <div className="s">
            {/* Task #340：游玩时长汇总（X 小时游玩 / 部分游玩时长待定）为 AI 推导，
                开关关闭时只保留站数计数（代码保留可恢复） */}
            {visits.length > 0
              ? SHOW_ESTIMATED_TIMES
                ? `${visits.length} 站 · ${
                    knownVisits.length === visits.length
                      ? `${(totalMinutes / 60).toFixed(1)} 小时游玩`
                      : "部分游玩时长待定"
                  }`
                : `${visits.length} 站`
              : emptyDayTitle(trip)}
          </div>
        </div>
        {visits.length > 0 && !batchMode ? (
          <button type="button" className="day-add" onClick={() => onOpenNoteInput(day.dayIndex)}>
            添加
          </button>
        ) : null}
        {/* M2 F12 批量管理入口：Task #71 暂时隐藏以精简页面行动点（false && 短路不渲染）。
            批量模式状态机、勾选与底部操作栏逻辑全部保留，恢复时移除 false && 即可 */}
        {false && visits.length > 0 && !batchMode ? (
          <button type="button" className="batch-entry" onClick={enterBatchMode}>
            批量管理
          </button>
        ) : null}
      </div>

      {dayConstraints.map((constraint) => (
        <ConstraintBar key={constraint.constraintId} constraint={constraint} />
      ))}

      {/* Module B 当日锚点容器：出发 + 住宿两行（替代原 DepartTime / AreaTag / 住宿占位） */}
      <DayAnchor
        trip={trip}
        day={day}
        lodging={lodging}
        hotel={primaryHotel}
        firstVisitName={firstVisitName}
        onSearchHotels={onSearchHotels}
        onUpdateDepart={onUpdateDepart}
      />

      <RouteStrip trip={trip} day={day} />

      {visits.length === 0 ? (
        /* Module D 空天紧凑虚线卡：单按钮打开统一面板（dayIndex 供上层设置 openContext） */
        <EmptyDay dayIndex={day.dayIndex} onOpenNote={onOpenNoteInput} />
      ) : null}

      {displayItems.length > 0 ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={displayItems.map((item) => sortableIdOf(item))}
            strategy={verticalListSortingStrategy}
          >
            <div className="items">
              {displayItems.map((item, index) =>
                item.kind === "visit" ? (
                  <VisitCard
                    key={`visit:${item.ref}`}
                    trip={trip}
                    visit={item.visit}
                    isFirst={item.ref === firstVisitRef}
                    index={index}
                    total={displayItems.length}
                    onMoveItem={requestMoveItem}
                    selectMode={batchMode}
                    selected={selectedIds.has(item.ref)}
                    onToggleSelect={() => {
                      if (selectable(item.visit)) toggleSelect(item.ref);
                    }}
                    onRemove={() => onRemoveVisit(day.dayIndex, item.ref)}
                    onPurchaseSelect={(state, externalNote) =>
                      onPurchaseSelect(item.ref, state, externalNote)
                    }
                    onToggleLock={() => onToggleLock(item.ref)}
                    onMoveStop={(fromIndex, toIndex) =>
                      onMoveStop(item.ref, fromIndex, toIndex)
                    }
                    onRemoveStop={(stopId) => onRemoveStop(item.ref, stopId)}
                    onRestoreStop={onRestoreStop}
                    onClassifyIntoParent={onClassifyIntoParent}
                    onAdoptSuggestedStops={onAdoptSuggestedStops}
                    onAddStop={() => setAddStopVisitId(item.ref)}
                    onOpenStopEvidence={setEvidenceStopId}
                  />
                ) : (
                  <SortableHotelRow
                    key={`hotel:${item.ref}`}
                    hotelId={item.ref}
                    hotel={item.hotel}
                    index={index}
                    total={displayItems.length}
                    candidateTotal={hotelCandidateTotal}
                    primary={lodging?.hotelRefs[0] === item.ref}
                    purchaseState={lodging?.purchaseState ?? "unknown"}
                    locked={lodging?.locked ?? false}
                    onMove={requestMoveItem}
                    onRemove={() => requestHotelRemove(item.ref, item.hotel.name)}
                    onPurchaseSelect={(state) => onLodgingPurchaseSelect(day.dayIndex, state)}
                    onToggleLock={() => onToggleLodgingLock(day.dayIndex)}
                  />
                ),
              )}
            </div>
          </SortableContext>
        </DndContext>
      ) : null}

      {pendingReorder ? (
        <ConfirmDialog
          title={pendingReorder.visit.locked ? "移动已定项" : "移动已购项"}
          description={
            pendingReorder.visit.locked
              ? `「${visitDisplayName(trip, pendingReorder.visit)}」已锁定，确定要调整位置吗？`
              : `「${visitDisplayName(trip, pendingReorder.visit)}」已购票，确定要调整位置吗？`
          }
          confirmText="确定移动"
          onConfirm={() => {
            const pending = pendingReorder;
            setPendingReorder(null);
            if (pending) applyMove(pending.oldIndex, pending.newIndex);
          }}
          onCancel={() => setPendingReorder(null)}
        />
      ) : null}

      {pendingHotelRemove ? (
        <ConfirmDialog
          title="移除已订住宿候选"
          description={`当前住宿计划已标记为已订。确定将「${pendingHotelRemove.name}」移出规划吗？仅解除规划引用，不会取消真实订单，酒店信息仍会保留。`}
          confirmText="确定移出"
          danger
          onConfirm={() => {
            const pending = pendingHotelRemove;
            setPendingHotelRemove(null);
            if (pending) onRemoveHotel(day.dayIndex, pending.hotelId);
          }}
          onCancel={() => setPendingHotelRemove(null)}
        />
      ) : null}

      {/* M2 F12 批量移除含已定/已购项时的二次确认；正常入口已不可勾选，此处为防御 */}
      {pendingBatch ? (
        <ConfirmDialog
          title={pendingBatch.riskyNames.length > 1 ? "移除已定/已购项" : "移出已定/已购项"}
          description={`本次选择包含 ${pendingBatch.riskyNames.length} 个已定或已购点位：${pendingBatch.riskyNames
            .map((name) => `「${name}」`)
            .join("、")}，确认全部移出当天？移除后可立即撤销。`}
          confirmText={`确认移除 ${pendingBatch.ids.length} 项`}
          danger
          onConfirm={confirmBatchRemove}
          onCancel={() => setPendingBatch(null)}
        />
      ) : null}

      {/* M2 F12 批量模式底部操作栏：固定在 IntentBar 上方，N=0 禁用 */}
      {batchMode ? (
        <div className="batch-bar" role="toolbar" aria-label="批量移除操作栏">
          <span className="batch-count">
            已选 {selectedIds.size} / {visits.length} 项
          </span>
          <button type="button" className="batch-cancel" onClick={exitBatchMode}>
            取消
          </button>
          <button
            type="button"
            className="batch-confirm"
            disabled={selectedIds.size === 0}
            onClick={requestBatchRemove}
          >
            移回候选池 {selectedIds.size} 项
          </button>
        </div>
      ) : null}

      {/* 手动添加点位（PRD §7.6）：仅大景区父卡发起 */}
      {addStopVisit !== null ? (
        <AddStopSheet
          visitName={visitDisplayName(trip, addStopVisit)}
          cityName={trip.destination.city}
          onConfirm={(input, meta) => {
            onAddStop(addStopVisit.visitId, input);
            setAddStopVisitId(null);
            // Task #334：降级 custom 时展示可感知提示（3 秒自动消失）
            if (!meta.matchedPoi) {
              if (customStopNoticeTimerRef.current !== null) {
                window.clearTimeout(customStopNoticeTimerRef.current);
              }
              setCustomStopNotice(`「${input.name}」未匹配到飞猪点位，已作为自定义点位添加`);
              customStopNoticeTimerRef.current = window.setTimeout(() => {
                setCustomStopNotice(null);
                customStopNoticeTimerRef.current = null;
              }, 3_000);
            }
          }}
          onClose={() => setAddStopVisitId(null)}
        />
      ) : null}

      {/* Task #334：降级提示条（候选池 toast 同款深色样式，非弹框不阻断操作） */}
      {customStopNotice !== null ? (
        <div className="candidate-toast addstop-fallback-toast" role="status">
          <span className="candidate-toast-text">{customStopNotice}</span>
        </div>
      ) : null}

      {/* 攻略原文 Sheet：内部玩法证据弱入口 */}
      {evidenceStop !== null ? (
        <EvidenceSheet trip={trip} stop={evidenceStop} onClose={() => setEvidenceStopId(null)} />
      ) : null}
    </div>
  );
}
