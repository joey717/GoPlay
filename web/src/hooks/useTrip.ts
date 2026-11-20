import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ApplyResult,
  EntityRef,
  HotelCandidate,
  Item,
  LodgingPlan,
  Operation,
  Stop,
  Trip,
  Visit,
} from "@goplay/shared";
import {
  applyOps,
  makeVisitId,
  recomputeDayTimeline,
  recomputeDerivedFields,
  stopName,
  visitName,
} from "@goplay/shared";
import { loadTrip, saveTrip } from "../api/client";
import { isLargeAttractionPoi } from "../lib/largeAttraction";
import { isV11Trip, getPrimaryHotel, recomputeAllDays } from "../lib/trip";
import { dayDisplayItems, placeDayDisplayRefs, reorderDayDisplay, syncDisplayOrders } from "../lib/dayOrder";
import {
  clearOpLogStore,
  loadOpLog,
  pushOpLog,
  type OpLogEntry,
  type OpLogKind,
} from "../lib/opLog";

const TRIP_CACHE_KEY = "goplay.trip";
const SAVE_DEBOUNCE_MS = 1000;
/** 手动移除的撤销窗口时长；窗口内 undoRemove 可原位恢复 */
const UNDO_WINDOW_MS = 5000;

/**
 * 清除本地行程线索与缓存（Task #66 新建行程成功后调用）：
 * goplay.tripId / goplay.trip 缓存与近期操作记录（sessionStorage 中的 opLog）。
 */
export function clearTripCache(): void {
  try {
    localStorage.removeItem("goplay.tripId");
    localStorage.removeItem(TRIP_CACHE_KEY);
  } catch {
    /* 存储不可用时静默 */
  }
  clearOpLogStore();
}

/** 手动添加点位（PRD §7.6）：名称必填；位置提示与攻略原文选填 */
export interface CustomStopInput {
  name: string;
  locationHint: string | null;
  noteText: string | null;
  /** FlyAI 搜索命中的飞猪 POI（Task #100）：存在时创建 fliggy Item 而非 custom；
   *  searchPoi 在前端调用，结果透传至此；null/undefined = 未搜索或无匹配 */
  matchedPoi?: {
    id: string;
    name: string;
    address: string | null;
    category: string | null;
    coords: { lng: number; lat: number } | null;
    mainPic: string | null;
    ticketInfo: string | null;
    jumpUrl: string | null;
    /** Task #329：飞猪免费状态透传；缺失视为 null（读时默认，不伪造） */
    freePoiStatus?: Item["freePoiStatus"];
    /** Task #330：飞猪 POI 元信息透传（等级/榜单/介绍）；缺失视为 null（读时默认，不伪造） */
    poiLevel?: Item["poiLevel"];
    listRank?: Item["listRank"];
    description?: Item["description"];
    suggestMinutes: number | null;
  } | null;
}

/** 一条待撤销的点位移除记录：visitId + 移除前在当天 scheduleVisitRefs / 混排列表中的位置（0-based） */
export interface VisitUndoEntry {
  visitId: string;
  name: string;
  order: number;
  /** 移除前在「景点 + 酒店」混排列表中的下标：撤销时只恢复该实体的原混排位置 */
  displayIndex: number;
}

/** 一条待撤销的内部玩法移除记录：stopId + 移除前在 childStopRefs 中的位置（0-based） */
export interface StopUndoEntry {
  stopId: string;
  name: string;
  order: number;
}

/** 撤销状态（判别联合）：城市级点位移回候选池 / 内部玩法移入备选玩法 / 酒店候选移出住宿规划 */
export type UndoState =
  | { kind: "visit"; dayIndex: number; entries: VisitUndoEntry[]; batch: boolean }
  | { kind: "stop"; visitId: string; visitLabel: string; entries: StopUndoEntry[] }
  | { kind: "hotel"; dayIndex: number; hotelId: string; order: number; displayIndex: number; name: string };

export interface UseTripResult {
  trip: Trip | null;
  loading: boolean;
  error: string | null;
  saving: boolean;
  /** 泛化编辑入口：乐观更新 + 写缓存 + debounce 保存 */
  updateTrip: (updater: (trip: Trip) => Trip) => void;
  /** 作废未触发的防抖保存（Task #66 删除行程前调用，避免延迟写把已删行程写回） */
  cancelPendingSave: () => void;
  /**
   * 服务端行程采纳（Task #106：来源刷新专用，非普通编辑）：
   * 先冲刷本地未保存编辑（立即 PUT 并等待在途 PUT 完成）→ 再 GET 权威行程 →
   * 直接替换本地状态并写缓存（不排队新的防抖 PUT）。
   * 冲刷失败时放弃本次刷新（保本地编辑优先，旧快照绝不覆盖未持久化的编辑）。
   */
  refreshFromServer: () => Promise<void>;
  /** 把候选区的 point / 大景区壳排入某天末尾（plan + move，重算当天时间轴） */
  addRefToDay: (dayIndex: number, ref: EntityRef) => void;
  /** 移除单个点位回候选池，并开启 5 秒撤销窗口 */
  removeVisitWithUndo: (dayIndex: number, visitId: string) => void;
  /** 批量移回候选池：保留 visit 及其子项图谱，整批共用一个撤销窗口 */
  removeVisitsWithUndo: (dayIndex: number, visitIds: string[]) => void;
  /** 撤销最近一次移除：点位按原位恢复 / 内部玩法按原序插回 */
  undoRemove: () => void;
  /** 当前可撤销的移除（5 秒窗口内有效，过期自动清空） */
  undoState: UndoState | null;
  /** F2 同日拖拽排序（城市级；大景区整体移动，内部玩法不受影响） */
  reorderVisit: (dayIndex: number, fromIndex: number, toIndex: number) => void;
  /**
   * 景点 + 酒店混合列表改序（拖拽落点；下标为 dayDisplayItems 的 0-based 展示下标）。
   * 同步维护 displayOrder、scheduleVisitRefs（重编 Visit.order）与 hotelRefs。
   */
  reorderDayItems: (dayIndex: number, fromIndex: number, toIndex: number) => void;
  /** 混合列表 ↑↓ 按钮：direction=-1 上移 / 1 下移 */
  moveDayItem: (dayIndex: number, itemIndex: number, direction: -1 | 1) => void;
  /** F7 购票状态明确选择（仅 Visit） */
  setPurchaseState: (visitId: string, state: Visit["purchaseState"]) => void;
  /** F3 锁定切换（仅 Visit；locked=true 后 AI 不改动） */
  toggleLock: (visitId: string) => void;
  /** 住宿预订状态（lodging 三档：unknown / toBuy / bought；noTicket 由 shared 显式拒绝） */
  setLodgingPurchaseState: (dayIndex: number, state: LodgingPlan["purchaseState"]) => void;
  /** 住宿锁定切换（lodging target；locked=true 后 AI 不改动） */
  toggleLodgingLock: (dayIndex: number) => void;
  /** 修改出发时间（setTime dayDepart，标记 departTimeOverridden） */
  updateDepartTime: (dayIndex: number, time: string) => void;
  /** 内部玩法父内改序（move stop；不支持跨父 / 跨天） */
  moveStop: (visitId: string, fromIndex: number, toIndex: number) => void;
  /** 移除内部玩法进入父 Visit 的备选玩法，并开启 5 秒撤销窗口 */
  removeStopWithUndo: (visitId: string, stopId: string) => void;
  /** 把备选玩法放回岛内行程末尾（transfer，非撤销窗口也可用） */
  restoreStop: (stopId: string) => void;
  /** 待定加入的内部玩法归类到指定大景区（transfer，同天才可归类） */
  attachPendingStop: (stopId: string, visitId: string) => void;
  /**
   * 一键采纳：把「suggestedVisitRef 指向该大景区 + relationshipSuggestions.level=high +
   * decidedBy≠user」的待定玩法批量落入 childStopRefs（一次 applyOps，全有或全无）。
   * 与 planner / 存量修复脚本同一保守口径；返回实际采纳条数（0 = 无可采纳项或被护栏拒绝）。
   */
  adoptSuggestedStops: (visitId: string) => number;
  /**
   * 把独立普通景点手动归入大景区内部玩法（Task #199 classifyVisitAsStop）：
   * 用户通道免强证据；原 Visit 会被删除转为 Stop，不可撤销，调用方须二次确认。
   * 返回是否真正应用（护栏拒绝 / 数据已变化时为 false）。
   */
  classifyVisitAsParentStop: (visitId: string, parentVisitId: string) => boolean;
  /** 手动添加点位（custom Stop + 可选攻略原文证据，PRD §7.6） */
  addCustomStop: (visitId: string, input: CustomStopInput) => void;
  /**
   * 把主数据确保进入候选区，返回可排期的引用（Task #219）：
   * 大景区（关键词/5A 判定）创建 large_attraction 壳返回 visit 引用，
   * 其余维持 point 引用；已有活跃壳时复用且不改动其既有 kind。
   */
  ensurePoolRef: (
    item: Item,
    opts?: { forceLargeAttraction?: boolean },
  ) => EntityRef | null;
  /** 追加进候选区（同名同 providerId 去重；已在 registry 时仅恢复引用） */
  addToPool: (item: Item, opts?: { forceLargeAttraction?: boolean }) => void;
  /** 从候选区删除：point 走 remove op（主数据保留）；visit 壳直接解除引用 */
  deleteFromPool: (ref: EntityRef) => void;
  /** F6 选定酒店：写入 lodgings[String(dayIndex)] 并持久化（新选定置首位，既有候选保留） */
  selectHotel: (dayIndex: number, hotel: HotelCandidate) => void;
  /** 更新/清除当天住宿片区意向（ lodging 专用行为，不套点位语义） */
  updateLodgingArea: (dayIndex: number, areaName: string | null) => void;
  /** 住宿候选列表内改序（上移/下移/拖拽；与 moveStop 同为触控可靠的最小排序） */
  moveHotelCandidate: (dayIndex: number, fromIndex: number, toIndex: number) => void;
  /** 移除住宿候选：仅移出规划（解除引用），酒店主数据保留，开 5 秒撤销窗口 */
  removeHotelCandidate: (dayIndex: number, hotelId: string) => void;
  /** AI 操作落地：用服务端返回的权威 trip 替换本地状态（服务端已持久化） */
  applyServerResult: (result: ApplyResult) => void;
  /** M2 F12 近期操作记录（本会话，最多 20 条，新的在前；仅供展示不提供回滚） */
  opLog: OpLogEntry[];
  /** 清空近期操作记录 */
  clearOpLog: () => void;
}

export function useTrip(tripId: string, initialTrip?: Trip): UseTripResult {
  const [trip, setTrip] = useState<Trip | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [undoState, setUndoState] = useState<UndoState | null>(null);
  /** 近期操作记录：初始化时从 sessionStorage 恢复本会话已记录内容 */
  const [opLog, setOpLog] = useState<OpLogEntry[]>(() => loadOpLog());
  const tripRef = useRef<Trip | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  /** 在途保存（Task #106）：防抖定时器触发后发出的 saveTrip，resolve 值为是否成功；
   *  refreshFromServer 需等它落地后再 GET，避免读到覆盖本地编辑的旧快照 */
  const inFlightSaveRef = useRef<Promise<boolean> | null>(null);
  const undoTimerRef = useRef<number | null>(null);

  // 首次加载：优先使用上游已取到的行程，否则请求服务端，失败时回退 localStorage 缓存。
  // adopt 前统一做 v1.1 结构校验：旧 schema / 脏数据不进入渲染，避免崩溃。
  useEffect(() => {
    const adopt = (value: Trip) => {
      // 先重算时间轴，再把 displayOrder 与 scheduleVisitRefs / hotelRefs 对齐
      // （老数据缺失 displayOrder 时在此补成「景点在前、酒店在后」）
      const normalized = syncDisplayOrders(recomputeAllDays(value));
      tripRef.current = normalized;
      setTrip(normalized);
      setLoading(false);
      try {
        localStorage.setItem(TRIP_CACHE_KEY, JSON.stringify(normalized));
      } catch {
        /* 存储不可用时静默 */
      }
    };

    if (initialTrip && initialTrip.tripId === tripId && isV11Trip(initialTrip)) {
      adopt(initialTrip);
      return;
    }

    let active = true;
    setLoading(true);
    setError(null);
    loadTrip(tripId)
      .then((loaded) => {
        if (!active) return;
        if (!isV11Trip(loaded)) {
          // 旧 schema（服务端并行适配中）：按不可用处理，交给上层清理重新初始化
          setError("行程数据是旧版本结构，请重新初始化行程");
          setLoading(false);
          return;
        }
        adopt(loaded);
      })
      .catch(() => {
        try {
          const cached = localStorage.getItem(TRIP_CACHE_KEY);
          const parsed = cached !== null ? (JSON.parse(cached) as unknown) : null;
          if (parsed !== null && isV11Trip(parsed) && parsed.tripId === tripId) {
            if (active) adopt(parsed);
            return;
          }
        } catch {
          /* 缓存损坏则视为无缓存 */
        }
        if (active) {
          setError("行程加载失败，请检查服务是否可用");
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId]);

  const commit = useCallback((next: Trip) => {
    // 所有编辑（手工 ops / 直接变更 / 撤销）统一过一遍混排同步：
    // displayOrder 只做展示排序，永远与 scheduleVisitRefs、hotelRefs 的权威顺序保持一致。
    // 派生字段（role / timeSourceLabel）在此唯一出口重算，覆盖 updateTrip 直改路径
    // （改航班约束 / 选酒店 / 自定义点位等），避免 timeSourceLabel 陈旧（S11 口径）。
    const normalized = recomputeDerivedFields(syncDisplayOrders(next));
    tripRef.current = normalized;
    setTrip(normalized);
    try {
      localStorage.setItem(TRIP_CACHE_KEY, JSON.stringify(normalized));
    } catch {
      /* 存储不可用时静默 */
    }
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      setSaving(true);
      const pending = saveTrip(normalized)
        .then(() => true)
        .catch(() => {
          /* 保存失败不打断交互；下一次编辑会再次尝试 */
          return false;
        })
        .finally(() => {
          setSaving(false);
          if (inFlightSaveRef.current === pending) inFlightSaveRef.current = null;
        });
      inFlightSaveRef.current = pending;
    }, SAVE_DEBOUNCE_MS);
  }, []);

  const updateTrip = useCallback(
    (updater: (trip: Trip) => Trip) => {
      const current = tripRef.current;
      if (!current) return;
      commit(updater(current));
    },
    [commit],
  );

  /** 作废未触发的防抖保存（不清缓存、不改数据）：删除行程成功前调用，防止 PUT 把已删行程写回 */
  const cancelPendingSave = useCallback(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, []);

  /**
   * 冲刷本地未保存编辑（Task #106）：未触发的防抖保存立即执行；在途保存等待完成。
   * 返回是否全部落地成功——失败时调用方不得用服务端快照覆盖本地（会丢编辑）。
   */
  const flushPendingSave = useCallback(async (): Promise<boolean> => {
    const current = tripRef.current;
    // 有未触发的防抖：立即冲刷（保存失败则明确返回 false）
    if (saveTimerRef.current !== null && current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      setSaving(true);
      const pending = saveTrip(current)
        .then(() => true)
        .catch(() => false)
        .finally(() => setSaving(false));
      inFlightSaveRef.current = pending;
      const ok = await pending;
      if (inFlightSaveRef.current === pending) inFlightSaveRef.current = null;
      if (!ok) return false;
    }
    // 防抖已触发但 PUT 在途：等它落地（失败同样放弃后续覆盖）
    const inFlight = inFlightSaveRef.current;
    if (inFlight !== null) {
      const ok = await inFlight;
      if (!ok) return false;
    }
    return true;
  }, []);

  /**
   * 服务端行程采纳（Task #106 来源刷新链路）：
   * 1. 冲刷本地未保存编辑（PUT 成功后才继续，失败则放弃刷新保本地编辑）；
   * 2. GET 权威行程（此刻必然同时包含本地编辑与服务端新数据，如攻略来源装配入池）；
   * 3. 直接替换本地状态 + 写缓存，**不排队防抖 PUT**（服务端已持久化，
   *    再 PUT 反而可能在图片队列等后台写入后把旧数据写回）。
   * 拉取失败时保持本地状态不打断交互。与 applyServerResult 的差异：
   * 不作废撤销窗口（刷新不打断用户进行中的撤销操作）。
   */
  const refreshFromServer = useCallback(async (): Promise<void> => {
    const current = tripRef.current;
    if (current === null) return;
    const flushed = await flushPendingSave();
    if (!flushed) return;
    try {
      const fresh = await loadTrip(current.tripId);
      if (!isV11Trip(fresh) || fresh.tripId !== current.tripId) return;
      const normalized = syncDisplayOrders(recomputeAllDays(fresh));
      tripRef.current = normalized;
      setTrip(normalized);
      try {
        localStorage.setItem(TRIP_CACHE_KEY, JSON.stringify(normalized));
      } catch {
        /* 存储不可用时静默 */
      }
    } catch {
      /* 刷新失败不打断交互：下次进入页面会取到服务端最新数据 */
    }
  }, [flushPendingSave]);

  /** 近期操作记录：只追加展示信息，不参与行程数据，不抛错打断交互 */
  const recordOp = useCallback((kind: OpLogKind, label: string, detail?: string) => {
    setOpLog((prev) =>
      pushOpLog(prev, {
        id: crypto.randomUUID(),
        time: new Date().toISOString(),
        kind,
        label,
        detail,
      }),
    );
  }, []);

  const clearOpLog = useCallback(() => {
    setOpLog(clearOpLogStore());
  }, []);

  const stopUndoTimer = useCallback(() => {
    if (undoTimerRef.current !== null) {
      window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    setUndoState(null);
  }, []);

  const startUndoTimer = useCallback(() => {
    undoTimerRef.current = window.setTimeout(() => {
      undoTimerRef.current = null;
      setUndoState(null);
    }, UNDO_WINDOW_MS);
  }, []);

  /**
   * 手工通道（PRD §10.1 双通道原则）：所有手工操作统一收敛 shared applyOps，
   * 以 actor=user_manual + confirmed=true 直接执行敏感操作。
   * 部分拒绝时不提交（保持全有或全无的手工语义），返回结果供调用方判断。
   */
  const runOps = useCallback(
    (ops: Operation[]): ApplyResult | null => {
      const current = tripRef.current;
      if (!current || ops.length === 0) return null;
      const result = applyOps(current, ops, { actor: "user_manual", confirmed: true });
      if (result.applied.length === 0 || result.consistencyErrors.length > 0) return result;
      commit(result.trip);
      return result;
    },
    [commit],
  );

  /** 实体可读名称（oplog / reason 用） */
  const refLabel = useCallback((current: Trip, ref: EntityRef): string => {
    if (ref.kind === "visit") return visitName(current, ref.id);
    if (ref.kind === "stop") return stopName(current, ref.id);
    if (ref.kind === "point") return current.itemRegistry[ref.id]?.name ?? ref.id;
    if (ref.kind === "day") return `Day${ref.dayIndex}`;
    if (ref.kind === "lodging") return `Day${ref.dayIndex} 住宿`;
    return current.hotelRegistry[ref.id]?.name ?? "酒店";
  }, []);

  // ===== 城市级 Visit 操作 =====

  const addRefToDay = useCallback(
    (dayIndex: number, ref: EntityRef) => {
      const current = tripRef.current;
      if (!current || (ref.kind !== "point" && ref.kind !== "visit")) return;
      const day = current.days[current.dayRefs[dayIndex - 1]];
      if (day === undefined) return;
      const label = refLabel(current, ref);
      // plan 的 order 语义是「批内相对序」（assigned 前置、其余追加），
      // 追加到当天末尾 = plan@0 + move(末尾)
      const ops: Operation[] = [
        {
          op: "plan",
          scopeRef: { kind: "day", dayIndex },
          assignments: [
            { subjectRef: ref, containerRef: { kind: "day", dayIndex }, order: 0 },
          ],
          reason: `将「${label}」排入 Day${dayIndex}`,
        },
        {
          op: "move",
          subjectRef: ref,
          containerRef: { kind: "day", dayIndex },
          toOrder: day.scheduleVisitRefs.length,
          reason: `「${label}」排到 Day${dayIndex} 末尾`,
        },
      ];
      const result = runOps(ops);
      if (result !== null && result.applied.length === ops.length) {
        recordOp("add", `「${label}」`, `排入 Day${dayIndex}`);
      }
    },
    [runOps, recordOp, refLabel],
  );

  const removeVisitWithUndo = useCallback(
    (dayIndex: number, visitId: string) => {
      const current = tripRef.current;
      if (!current) return;
      const day = current.days[current.dayRefs[dayIndex - 1]];
      if (day === undefined) return;
      const order = day.scheduleVisitRefs.indexOf(visitId);
      if (order === -1) return;
      const displayIndex = dayDisplayItems(current, day).findIndex(
        (item) => item.kind === "visit" && item.ref === visitId,
      );
      const label = visitName(current, visitId);

      stopUndoTimer();
      const result = runOps([
        {
          op: "remove",
          subjectRef: { kind: "visit", id: visitId },
          fromContainerRef: { kind: "day", dayIndex },
          reason: `手动移除「${label}」`,
        },
      ]);
      if (result === null || result.applied.length === 0) return;

      setUndoState({
        kind: "visit",
        dayIndex,
        entries: [{ visitId, name: label, order, displayIndex }],
        batch: false,
      });
      recordOp("remove", `「${label}」`, `Day${dayIndex} → 候选池`);
      startUndoTimer();
    },
    [runOps, recordOp, stopUndoTimer, startUndoTimer],
  );

  const removeVisitsWithUndo = useCallback(
    (dayIndex: number, visitIds: string[]) => {
      const current = tripRef.current;
      const day = current?.days[current.dayRefs[dayIndex - 1]];
      if (!current || day === undefined || visitIds.length === 0) return;
      const idSet = new Set(visitIds);
      const items = dayDisplayItems(current, day);
      const entries: VisitUndoEntry[] = day.scheduleVisitRefs
        .map((id, order) => ({ visitId: id, name: visitName(current, id), order }))
        .filter((entry) => idSet.has(entry.visitId))
        .map((entry) => ({
          ...entry,
          displayIndex: items.findIndex(
            (item) => item.kind === "visit" && item.ref === entry.visitId,
          ),
        }));
      if (entries.length === 0) return;

      stopUndoTimer();
      const result = runOps(
        entries.map(
          (entry): Operation => ({
            op: "remove",
            subjectRef: { kind: "visit", id: entry.visitId },
            fromContainerRef: { kind: "day", dayIndex },
            reason: `批量移除「${entry.name}」`,
          }),
        ),
      );
      if (result === null || result.applied.length === 0) return;

      const nameList =
        entries
          .slice(0, 3)
          .map((entry) => entry.name)
          .join("、") + (entries.length > 3 ? " 等" : "");
      setUndoState({ kind: "visit", dayIndex, entries, batch: entries.length > 1 });
      recordOp("batch-remove", `${entries.length} 项：${nameList}`, `Day${dayIndex} → 候选池`);
      startUndoTimer();
    },
    [runOps, recordOp, stopUndoTimer, startUndoTimer],
  );

  /**
   * 撤销最近一次移除（PRD §10.3：只恢复被移除实体和原位置，不用旧快照覆盖后续编辑）。
   * - visit：一条 plan（全部按 order 0..k-1 升序加入）+ 逐条 move 恢复原位（升序插入可证正确）；
   * - stop：transfer 从备选按原 order 升序插回 childStopRefs（真插入语义，天然恢复原序）；
   * - hotel：从 hotelRegistry 恢复引用到 hotelRefs 原位（无对应 op，直接变更）。
   */
  const undoRemove = useCallback(() => {
    if (!undoState) return;
    stopUndoTimer();
    setUndoState(null);
    const current = tripRef.current;
    if (!current) return;

    if (undoState.kind === "visit") {
      const day = current.days[current.dayRefs[undoState.dayIndex - 1]];
      if (day === undefined) return;
      const present = new Set(day.scheduleVisitRefs);
      const restore = undoState.entries.filter(
        (entry) => !present.has(entry.visitId) && current.visits[entry.visitId] !== undefined,
      );
      if (restore.length === 0) return;
      const sorted = [...restore].sort((a, b) => a.order - b.order);
      const ops: Operation[] = [
        {
          op: "plan",
          scopeRef: { kind: "day", dayIndex: undoState.dayIndex },
          assignments: sorted.map((entry, index) => ({
            subjectRef: { kind: "visit" as const, id: entry.visitId },
            containerRef: { kind: "day" as const, dayIndex: undoState.dayIndex },
            order: index,
          })),
          reason: `撤销移除，恢复 ${sorted.length} 项到 Day${undoState.dayIndex}`,
        },
        ...sorted.map(
          (entry): Operation => ({
            op: "move",
            subjectRef: { kind: "visit", id: entry.visitId },
            containerRef: { kind: "day", dayIndex: undoState.dayIndex },
            toOrder: entry.order,
            reason: `恢复「${entry.name}」到第 ${entry.order + 1} 位`,
          }),
        ),
      ];
      const result = runOps(ops);
      if (result === null || result.applied.length === 0) return;
      // 恢复原混排位置：plan/move 只恢复景点权威顺序，这里补回与酒店交错的展示下标
      updateTrip((trip) =>
        placeDayDisplayRefs(
          trip,
          undoState.dayIndex,
          sorted.map((entry) => ({
            kind: "visit" as const,
            ref: entry.visitId,
            index: entry.displayIndex,
          })),
        ),
      );
      recordOp(
        "undo",
        undoState.batch || restore.length > 1 ? `${restore.length} 项` : `「${restore[0].name}」`,
        `恢复到 Day${undoState.dayIndex}`,
      );
      return;
    }

    if (undoState.kind === "stop") {
      const visit = current.visits[undoState.visitId];
      if (visit === undefined) return;
      const ops: Operation[] = [...undoState.entries]
        .filter(
          (entry) =>
            visit.alternateStopRefs.includes(entry.stopId) && current.stops[entry.stopId] !== undefined,
        )
        .sort((a, b) => a.order - b.order)
        .map(
          (entry): Operation => ({
            op: "transfer",
            subjectRef: { kind: "stop", id: entry.stopId },
            fromContainerRef: { kind: "visitPool", visitId: undoState.visitId },
            toContainerRef: { kind: "visit", id: undoState.visitId },
            toOrder: entry.order,
            reason: `撤销移除，恢复「${entry.name}」到岛内行程第 ${entry.order + 1} 位`,
          }),
        );
      if (ops.length === 0) return;
      const result = runOps(ops);
      if (result === null || result.applied.length === 0) return;
      recordOp(
        "undo",
        undoState.entries.length > 1 ? `${undoState.entries.length} 项` : `「${undoState.entries[0].name}」`,
        `恢复到「${undoState.visitLabel}」`,
      );
      return;
    }

    // hotel：无对应 op（remove/move 均不支持 hotel subjectRef），直接变更恢复引用原位
    const plan = current.lodgings[String(undoState.dayIndex)];
    if (plan === undefined || plan.hotelRefs.includes(undoState.hotelId)) return;
    updateTrip((trip) => {
      const target = trip.lodgings[String(undoState.dayIndex)];
      if (target === undefined || target.hotelRefs.includes(undoState.hotelId)) return trip;
      const restored = [...target.hotelRefs];
      restored.splice(Math.min(undoState.order, restored.length), 0, undoState.hotelId);
      const next: Trip = {
        ...trip,
        lodgings: {
          ...trip.lodgings,
          [String(undoState.dayIndex)]: { ...target, hotelRefs: restored, userAdjusted: true },
        },
      };
      // 同时恢复移除前在混排列表中的位置（含与景点的交错顺序）
      return placeDayDisplayRefs(next, undoState.dayIndex, [
        { kind: "hotel", ref: undoState.hotelId, index: undoState.displayIndex },
      ]);
    });
    recordOp("undo", `「${undoState.name}」`, `恢复到 Day${undoState.dayIndex} 住宿候选`);
  }, [undoState, runOps, recordOp, stopUndoTimer, updateTrip]);

  const reorderVisit = useCallback(
    (dayIndex: number, fromIndex: number, toIndex: number) => {
      const current = tripRef.current;
      if (!current || fromIndex === toIndex) return;
      const day = current.days[current.dayRefs[dayIndex - 1]];
      const visitId = day?.scheduleVisitRefs[fromIndex];
      if (day === undefined || visitId === undefined) return;
      const label = visitName(current, visitId);
      const result = runOps([
        {
          op: "move",
          subjectRef: { kind: "visit", id: visitId },
          containerRef: { kind: "day", dayIndex },
          toOrder: toIndex,
          reason: `手动拖拽调整「${label}」在 Day${dayIndex} 内的顺序`,
        },
      ]);
      if (result !== null && result.applied.length > 0) {
        recordOp("reorder", `「${label}」`, `Day${dayIndex} 第 ${fromIndex + 1} → ${toIndex + 1} 位`);
      }
    },
    [runOps, recordOp],
  );

  const reorderDayItems = useCallback(
    (dayIndex: number, fromIndex: number, toIndex: number) => {
      const current = tripRef.current;
      if (!current || fromIndex === toIndex) return;
      const day = current.days[current.dayRefs[dayIndex - 1]];
      if (day === undefined) return;
      const items = dayDisplayItems(current, day);
      const moved = items[fromIndex];
      if (moved === undefined || items[toIndex] === undefined) return;
      const label = moved.kind === "visit" ? visitName(current, moved.ref) : moved.hotel.name;
      const next = reorderDayDisplay(current, dayIndex, fromIndex, toIndex);
      if (next === null) return;
      commit(next);
      recordOp("reorder", `「${label}」`, `Day${dayIndex} 第 ${fromIndex + 1} → ${toIndex + 1} 位`);
    },
    [commit, recordOp],
  );

  /** ↑↓ 按钮：复用拖拽改序的同一套写入（锁定/已购的二次确认由界面层把关） */
  const moveDayItem = useCallback(
    (dayIndex: number, itemIndex: number, direction: -1 | 1) => {
      reorderDayItems(dayIndex, itemIndex, itemIndex + direction);
    },
    [reorderDayItems],
  );

  const setPurchaseState = useCallback(
    (visitId: string, state: Visit["purchaseState"]) => {
      const current = tripRef.current;
      if (!current) return;
      const label = visitName(current, visitId);
      const result = runOps([
        {
          op: "setPurchase",
          subjectRef: { kind: "visit", id: visitId },
          value: state,
          reason: `手动标记「${label}」购票状态`,
        },
      ]);
      if (result !== null && result.applied.length > 0) {
        const stateLabel: Record<Visit["purchaseState"], string> = {
          unknown: "未确定",
          toBuy: "现场买",
          bought: "已购",
          noTicket: "无需购票",
        };
        recordOp("purchase", `「${label}」→ ${stateLabel[state]}`);
      }
    },
    [runOps, recordOp],
  );

  const toggleLock = useCallback(
    (visitId: string) => {
      const current = tripRef.current;
      if (!current) return;
      const visit = current.visits[visitId];
      if (visit === undefined) return;
      const label = visitName(current, visitId);
      const result = runOps([
        {
          op: "lock",
          subjectRef: { kind: "visit", id: visitId },
          value: !visit.locked,
          reason: `手动${visit.locked ? "解锁" : "锁定"}「${label}」`,
        },
      ]);
      if (result !== null && result.applied.length > 0) {
        recordOp("lock", `「${label}」${visit.locked ? "已解锁" : "已锁定"}`);
      }
    },
    [runOps, recordOp],
  );

  /**
   * 住宿预订状态（任务 213）：subjectRef 用 lodging + dayIndex 寻址，只改当天计划。
   * 与景点 setPurchase 同一 operation，noTicket 档由 shared 显式拒绝，界面只提供三档。
   */
  const setLodgingPurchaseState = useCallback(
    (dayIndex: number, state: LodgingPlan["purchaseState"]) => {
      const current = tripRef.current;
      if (!current) return;
      if (current.lodgings[String(dayIndex)] === undefined) return;
      const result = runOps([
        {
          op: "setPurchase",
          subjectRef: { kind: "lodging", dayIndex },
          value: state,
          reason: `手动标记 Day${dayIndex} 住宿预订状态`,
        },
      ]);
      if (result !== null && result.applied.length > 0) {
        const stateLabel: Record<LodgingPlan["purchaseState"], string> = {
          unknown: "未确定",
          toBuy: "现场订",
          bought: "已订房",
        };
        recordOp("purchase", `Day${dayIndex} 住宿 → ${stateLabel[state]}`);
      }
    },
    [runOps, recordOp],
  );

  /** 住宿锁定切换（任务 213）：lock op 支持 lodging target，同样走手工通道 */
  const toggleLodgingLock = useCallback(
    (dayIndex: number) => {
      const current = tripRef.current;
      if (!current) return;
      const plan = current.lodgings[String(dayIndex)];
      if (plan === undefined) return;
      const result = runOps([
        {
          op: "lock",
          subjectRef: { kind: "lodging", dayIndex },
          value: !plan.locked,
          reason: `手动${plan.locked ? "解锁" : "锁定"} Day${dayIndex} 住宿`,
        },
      ]);
      if (result !== null && result.applied.length > 0) {
        recordOp("lock", `Day${dayIndex} 住宿${plan.locked ? "已解锁" : "已锁定"}`);
      }
    },
    [runOps, recordOp],
  );

  const updateDepartTime = useCallback(
    (dayIndex: number, time: string) => {
      runOps([
        {
          op: "setTime",
          subjectRef: { kind: "day", dayIndex },
          value: time,
          target: "dayDepart",
          reason: `手动修改 Day${dayIndex} 出发时间`,
        },
      ]);
    },
    [runOps],
  );

  // ===== 内部 Stop 操作（不支持 setTime / purchase / lock / 跨天）=====

  const moveStop = useCallback(
    (visitId: string, fromIndex: number, toIndex: number) => {
      const current = tripRef.current;
      if (!current || fromIndex === toIndex) return;
      const stopId = stopIdOf(current, visitId, fromIndex);
      if (stopId === null) return;
      const label = stopName(current, stopId);
      const result = runOps([
        {
          op: "move",
          subjectRef: { kind: "stop", id: stopId },
          containerRef: { kind: "visit", id: visitId },
          toOrder: toIndex,
          reason: `手动调整「${label}」在岛内行程中的顺序`,
        },
      ]);
      if (result !== null && result.applied.length > 0) {
        recordOp("reorder", `「${label}」`, `第 ${fromIndex + 1} → ${toIndex + 1} 位`);
      }
    },
    [runOps, recordOp],
  );

  const removeStopWithUndo = useCallback(
    (visitId: string, stopId: string) => {
      const current = tripRef.current;
      if (!current) return;
      const visit = current.visits[visitId];
      const stop = current.stops[stopId];
      if (visit === undefined || stop === undefined) return;
      const order = visit.childStopRefs.indexOf(stopId);
      if (order === -1) return;
      const label = stopName(current, stopId);

      stopUndoTimer();
      const result = runOps([
        {
          op: "remove",
          subjectRef: { kind: "stop", id: stopId },
          fromContainerRef: { kind: "visit", id: visitId },
          reason: `手动移除「${label}」`,
        },
      ]);
      if (result === null || result.applied.length === 0) return;

      setUndoState({
        kind: "stop",
        visitId,
        visitLabel: visitName(current, visitId),
        entries: [{ stopId, name: label, order }],
      });
      recordOp("remove", `「${label}」`, `移入「${visitName(current, visitId)}」备选玩法`);
      startUndoTimer();
    },
    [runOps, recordOp, stopUndoTimer, startUndoTimer],
  );

  const restoreStop = useCallback(
    (stopId: string) => {
      const current = tripRef.current;
      if (!current) return;
      const stop = current.stops[stopId];
      if (stop === undefined || stop.visitRef === null) return;
      const label = stopName(current, stopId);
      const result = runOps([
        {
          op: "transfer",
          subjectRef: { kind: "stop", id: stopId },
          fromContainerRef: { kind: "visitPool", visitId: stop.visitRef },
          toContainerRef: { kind: "visit", id: stop.visitRef },
          toOrder: null,
          reason: `将「${label}」放回岛内行程末尾`,
        },
      ]);
      if (result !== null && result.applied.length > 0) {
        recordOp("transfer", `「${label}」`, `放回「${visitName(current, stop.visitRef)}」`);
      }
    },
    [runOps, recordOp],
  );

  const attachPendingStop = useCallback(
    (stopId: string, visitId: string) => {
      const current = tripRef.current;
      if (!current) return;
      const label = stopName(current, stopId);
      const result = runOps([
        {
          op: "transfer",
          subjectRef: { kind: "stop", id: stopId },
          fromContainerRef: { kind: "pendingPool" },
          toContainerRef: { kind: "visit", id: visitId },
          toOrder: null,
          reason: `将「${label}」归类到「${visitName(current, visitId)}」`,
        },
      ]);
      if (result !== null && result.applied.length > 0) {
        recordOp("transfer", `「${label}」`, `归类到「${visitName(current, visitId)}」`);
      }
    },
    [runOps, recordOp],
  );

  /**
   * 一键采纳大景区的高置信度推荐玩法（与存量修复脚本、planner 同一口径）：
   * 只认 level=high 且 decidedBy≠user（用户已表态的不覆盖），一次批量 transfer 到
   * 该景区 childStopRefs 末尾——applyOps 全有或全无，被护栏拒绝时不做任何改动。
   */
  const adoptSuggestedStops = useCallback(
    (visitId: string): number => {
      const current = tripRef.current;
      if (!current) return 0;
      const targets = Object.values(current.stops).filter((stop) => {
        if (stop.state !== "pending") return false;
        if (stop.suggestedVisitRef !== visitId) return false;
        const suggestion = current.relationshipSuggestions[stop.stopId];
        if (suggestion === undefined || suggestion.level !== "high") return false;
        return suggestion.decidedBy !== "user";
      });
      if (targets.length === 0) return 0;
      const visitLabel = visitName(current, visitId);
      const ops: Operation[] = targets.map((stop) => ({
        op: "transfer" as const,
        subjectRef: { kind: "stop" as const, id: stop.stopId },
        fromContainerRef: { kind: "pendingPool" as const },
        toContainerRef: { kind: "visit" as const, id: visitId },
        toOrder: null,
        reason: `一键采纳「${stopName(current, stop.stopId)}」到「${visitLabel}」`,
      }));
      const result = runOps(ops);
      if (result === null || result.applied.length === 0) return 0;
      const adopted = result.applied.length;
      recordOp("transfer", `「${visitLabel}」`, `一键采纳 ${adopted} 个推荐玩法`);
      return adopted;
    },
    [runOps, recordOp],
  );

  /**
   * 用户手动归入大景区（Task #199）：独立 ordinary Visit → 目标 large_attraction 的内部 Stop。
   * 与 AI 通道共用 classifyVisitAsStop，但走手工通道（actor=user_manual + confirmed），
   * 证据为空（用户的选择本身即依据）；成功后原 Visit 被删除，不可撤销，须由调用方二次确认。
   */
  const classifyVisitAsParentStop = useCallback(
    (visitId: string, parentVisitId: string) => {
      const current = tripRef.current;
      if (!current) return false;
      const label = visitName(current, visitId);
      const parentLabel = visitName(current, parentVisitId);
      const result = runOps([
        {
          op: "classifyVisitAsStop",
          visitId,
          parentVisitId,
          toOrder: null,
          evidenceMentionRefs: [],
          reason: "用户手动归入大景区",
        },
      ]);
      if (result === null || result.applied.length === 0) return false;
      recordOp("transfer", `「${label}」`, `归入「${parentLabel}」作为内部玩法`);
      return true;
    },
    [runOps, recordOp],
  );

  /**
   * 手动添加点位（PRD §7.6）：用户填写的名称本身即有效来源。
   * Task #100：如果 input.matchedPoi 非空（前端已搜索 FlyAI 命中），则创建 fliggy Item
   * 并把 Stop.matchedPointRef 指向它；否则创建 custom Stop（原行为）。
   * 无对应 op（applyOps 不创建实体）：直接变更 + 局部重算当天；
   * 攻略原文选填时同步创建 note_text 证据并关联（格式 evidenceId:mentionId）。
   */
  const addCustomStop = useCallback(
    (visitId: string, input: CustomStopInput) => {
      const name = input.name.trim();
      if (!name) return;
      const hint = input.locationHint?.trim() || null;
      const note = input.noteText?.trim() || null;
      const poi = input.matchedPoi ?? null;
      updateTrip((current) => {
        const visit = current.visits[visitId];
        if (visit === undefined || visit.dayRef === null) return current;

        let evidences = current.evidences;
        const evidenceRefs: string[] = [];
        const mentionRefs: string[] = [];
        if (note !== null) {
          const evidenceId = `ev_${crypto.randomUUID()}`;
          const mentionId = `m_${crypto.randomUUID()}`;
          evidences = {
            ...evidences,
            [evidenceId]: {
              evidenceId,
              kind: "note_text",
              noteIndex: null,
              assetRef: null,
              sourceUrl: null,
              ocrText: null,
              mentions: [
                {
                  mentionId,
                  text: "",
                  quoteText: note,
                  bbox: null,
                  extractedName: name,
                  locationHint: hint,
                  modelSummary: null,
                },
              ],
            },
          };
          evidenceRefs.push(evidenceId);
          mentionRefs.push(`${evidenceId}:${mentionId}`);
        }

        // Task #100：FlyAI 命中时创建 fliggy Item + 设 matchedPointRef
        let itemRegistry = current.itemRegistry;
        let matchedPointRef: string | null = null;
        if (poi !== null) {
          // 去重：同 providerId 或同名 fliggy Item 已在 registry 时复用
          const existing = Object.values(itemRegistry).find(
            (item) =>
              item.origin === "fliggy" &&
              (item.providerId === poi.id || item.name === poi.name),
          );
          if (existing !== undefined) {
            matchedPointRef = existing.itemId;
          } else {
            const itemId = crypto.randomUUID();
            const item: Item = {
              itemId,
              name: poi.name,
              origin: "fliggy",
              providerId: poi.id,
              address: poi.address,
              category: poi.category,
              coords: poi.coords,
              suggestMinutes: poi.suggestMinutes,
              mainPic: poi.mainPic,
              ticketInfo: poi.ticketInfo,
              jumpUrl: poi.jumpUrl,
              // Task #329：免费状态透传（未携带时缺省，读时默认 null）
              freePoiStatus: poi.freePoiStatus ?? undefined,
              // Task #330：飞猪 POI 元信息透传（等级/榜单/介绍）；未携带时缺省，读时默认 null
              poiLevel: poi.poiLevel ?? undefined,
              listRank: poi.listRank ?? undefined,
              description: poi.description ?? undefined,
              sourceEvidenceRefs: evidenceRefs,
            };
            itemRegistry = { ...itemRegistry, [itemId]: item };
            matchedPointRef = itemId;
          }
        }

        const stopId = `stop_${crypto.randomUUID()}`;
        const stop: Stop = {
          stopId,
          state: "attached",
          visitRef: visitId,
          suggestedVisitRef: null,
          matchedPointRef,
          customName: matchedPointRef !== null ? null : name,
          order: visit.childStopRefs.length,
          suggestMinutes: poi?.suggestMinutes ?? null, // fliggy 命中时可携带时长
          locationHint: hint,
          ticketRelation: "unknown",
          sourceEvidenceRefs: evidenceRefs,
          sourceMentionRefs: mentionRefs,
          userAdjusted: true,
          removedFromOrder: null,
          removedAt: null,
        };
        const dayIndex = current.days[visit.dayRef]?.dayIndex ?? null;
        let next: Trip = {
          ...current,
          evidences,
          itemRegistry,
          stops: { ...current.stops, [stopId]: stop },
          visits: {
            ...current.visits,
            [visitId]: { ...visit, childStopRefs: [...visit.childStopRefs, stopId] },
          },
        };
        if (dayIndex !== null) next = recomputeDayTimeline(next, dayIndex);
        return next;
      });
      const label = poi !== null ? "飞猪匹配添加" : "手动添加点位";
      recordOp("add", `「${name}」`, label);
    },
    [updateTrip, recordOp],
  );

  // ===== 候选区 =====

  /**
   * Task #219：搜索添加主数据的统一入口，返回可排期的池引用。
   * 背景不变量：shared 执行器 plan(point) 硬编码创建 kind:"ordinary" 壳，
   * 大景区必须先建 large_attraction 壳（直接变更先例，同 selectHotel），
   * 再用 visit 引用 plan 排期，壳 kind 才能保留。
   * 行为：
   * - 已有活跃壳（已排期或候选池中的 visit 壳）→ 复用其引用，不升级既有 kind
   *   （保护攻略抽取路径已正确设置的 kind）；
   * - 大景区（调用方 forceLargeAttraction 或名称命中关键词）→ 建 large_attraction 壳；
   * - 其余 → point 引用（含同名主数据已存在但壳已删时的引用恢复）。
   */
  const ensurePoolRef = useCallback(
    (item: Item, opts?: { forceLargeAttraction?: boolean }): EntityRef | null => {
      const current = tripRef.current;
      if (current === null) return null;
      // 同名同 providerId 已有主数据：复用其 id，绝不重复建 Item
      const existing = Object.values(current.itemRegistry).find(
        (candidate) =>
          candidate.name === item.name &&
          (candidate.providerId ?? null) === (item.providerId ?? null),
      );
      const target = existing ?? item;
      // 已有活跃壳（已排期或池中）→ 复用引用（不动已有 kind）
      const pooledVisit = Object.values(current.visits).find(
        (visit) =>
          visit.pointRef === target.itemId &&
          (visit.dayRef !== null ||
            current.globalCandidateRefs.some(
              (ref) => ref.kind === "visit" && ref.id === visit.visitId,
            )),
      );
      if (pooledVisit !== undefined) return { kind: "visit", id: pooledVisit.visitId };
      // 已在池中的 point 引用 → 幂等返回
      const pooledPoint = current.globalCandidateRefs.some(
        (ref) => ref.kind === "point" && ref.id === target.itemId,
      );
      if (pooledPoint) return { kind: "point", id: target.itemId };

      const wantLarge = opts?.forceLargeAttraction === true || isLargeAttractionPoi(target.name);
      if (wantLarge) {
        // makeVisitId 与 shared plan 同源（确定性：visit_{pointRef}_{n}），
        // 此处先建壳后 plan(visit)，id 与后续执行器视角一致
        const visitId = makeVisitId(current, target.itemId);
        const visit: Visit = {
          visitId,
          dayRef: null,
          pointRef: target.itemId,
          kind: "large_attraction",
          visitMode: "full_day",
          order: null,
          windowStart: null,
          windowEnd: null,
          startTime: null,
          endTime: null,
          startTimeOverridden: false,
          endTimeOverridden: false,
          reservedMinutes: null,
          effectiveMinutes: null,
          externalLeg: null,
          childStopRefs: [],
          alternateStopRefs: [],
          purchaseState: "unknown",
          locked: false,
          userAdjusted: false,
          removedFrom: null,
          removedAt: null,
        };
        updateTrip((trip) => ({
          ...trip,
          itemRegistry:
            existing !== undefined
              ? trip.itemRegistry
              : {
                  ...trip.itemRegistry,
                  [target.itemId]: {
                    ...target,
                    sourceEvidenceRefs: target.sourceEvidenceRefs ?? [],
                  },
                },
          visits: { ...trip.visits, [visitId]: visit },
          globalCandidateRefs: [
            ...trip.globalCandidateRefs,
            { kind: "visit" as const, id: visitId },
          ],
        }));
        return { kind: "visit", id: visitId };
      }
      // 普通点位：维持 point 引用现状
      updateTrip((trip) => {
        if (existing !== undefined) {
          return {
            ...trip,
            globalCandidateRefs: [
              ...trip.globalCandidateRefs,
              { kind: "point" as const, id: target.itemId },
            ],
          };
        }
        return {
          ...trip,
          itemRegistry: {
            ...trip.itemRegistry,
            [target.itemId]: {
              ...target,
              sourceEvidenceRefs: target.sourceEvidenceRefs ?? [],
            },
          },
          globalCandidateRefs: [
            ...trip.globalCandidateRefs,
            { kind: "point" as const, id: target.itemId },
          ],
        };
      });
      return { kind: "point", id: target.itemId };
    },
    [updateTrip],
  );

  const addToPool = useCallback(
    (item: Item, opts?: { forceLargeAttraction?: boolean }) => {
      ensurePoolRef(item, opts);
    },
    [ensurePoolRef],
  );

  const deleteFromPool = useCallback(
    (ref: EntityRef) => {
      if (ref.kind === "point") {
        const label = tripRef.current ? refLabel(tripRef.current, ref) : ref.id;
        const result = runOps([
          {
            op: "remove",
            subjectRef: ref,
            fromContainerRef: { kind: "globalPool" },
            reason: `从候选区删除「${label}」`,
          },
        ]);
        if (result !== null && result.applied.length > 0) {
          recordOp("remove", `「${label}」`, "从候选区删除（主数据保留）");
        }
        return;
      }
      if (ref.kind === "visit") {
        // 执行器不支持 visit from globalPool（候选壳无移除 op）：
        // 直接解除引用，visit 实体保留在 visits（M1 无不可逆删除）
        const label = tripRef.current ? refLabel(tripRef.current, ref) : ref.id;
        updateTrip((current) => ({
          ...current,
          globalCandidateRefs: current.globalCandidateRefs.filter(
            (candidate) => !(candidate.kind === "visit" && candidate.id === ref.id),
          ),
        }));
        recordOp("remove", `「${label}」`, "从候选区删除");
      }
    },
    [runOps, updateTrip, recordOp, refLabel],
  );

  // ===== 住宿（lodging 专用行为，不套点位候选语义）=====

  /**
   * 住宿候选列表内改序（住宿专用行为）：执行器 move op 不支持 hotel subjectRef，
   * 与 selectHotel / updateLodgingArea 同为直接变更先例（不走 applyOps）。
   * fromIndex / toIndex 为 plan.hotelRefs 原始下标；只改引用顺序不动 registry；
   * 住宿不参与时间链（timeline 不消费 lodging），无需重算当天时间轴。
   */
  const moveHotelCandidate = useCallback(
    (dayIndex: number, fromIndex: number, toIndex: number) => {
      const current = tripRef.current;
      const plan = current?.lodgings[String(dayIndex)];
      if (!current || plan === undefined || fromIndex === toIndex) return;
      const refs = plan.hotelRefs;
      if (
        !Number.isInteger(fromIndex) ||
        !Number.isInteger(toIndex) ||
        fromIndex < 0 ||
        fromIndex >= refs.length ||
        toIndex < 0 ||
        toIndex >= refs.length
      ) {
        return;
      }
      const hotelId = refs[fromIndex];
      const label = current.hotelRegistry[hotelId]?.name ?? hotelId;
      updateTrip((trip) => {
        const target = trip.lodgings[String(dayIndex)];
        if (target === undefined) return trip;
        const next = [...target.hotelRefs];
        const [moved] = next.splice(fromIndex, 1);
        if (moved === undefined) return trip;
        next.splice(toIndex, 0, moved);
        return {
          ...trip,
          lodgings: {
            ...trip.lodgings,
            [String(dayIndex)]: { ...target, hotelRefs: next, userAdjusted: true },
          },
        };
      });
      recordOp(
        "reorder",
        `「${label}」`,
        `Day${dayIndex} 住宿候选第 ${fromIndex + 1} → ${toIndex + 1} 位`,
      );
    },
    [updateTrip, recordOp],
  );

  /**
   * 移除住宿候选（「移除（住宿）」语义）：仅解除规划引用，不触发真实订单取消，
   * hotelRegistry 主数据保留（可重新搜索/选定恢复）；开 5 秒撤销窗口原位恢复。
   * 已订（plan.purchaseState === "bought")计划的二次确认由 UI 层把关（DayContent）。
   */
  const removeHotelCandidate = useCallback(
    (dayIndex: number, hotelId: string) => {
      const current = tripRef.current;
      const plan = current?.lodgings[String(dayIndex)];
      if (!current || plan === undefined) return;
      const order = plan.hotelRefs.indexOf(hotelId);
      if (order === -1) return;
      const day = current.days[current.dayRefs[dayIndex - 1]];
      const displayIndex =
        day === undefined
          ? -1
          : dayDisplayItems(current, day).findIndex(
              (item) => item.kind === "hotel" && item.ref === hotelId,
            );
      const label = current.hotelRegistry[hotelId]?.name ?? hotelId;

      stopUndoTimer();
      updateTrip((trip) => {
        const target = trip.lodgings[String(dayIndex)];
        if (target === undefined) return trip;
        return {
          ...trip,
          lodgings: {
            ...trip.lodgings,
            [String(dayIndex)]: {
              ...target,
              hotelRefs: target.hotelRefs.filter((id) => id !== hotelId),
              userAdjusted: true,
            },
          },
        };
      });
      // 移空时保留 LodgingPlan（areaName 片区意向仍在），LodgingBlock 自动回退片区占位展示
      setUndoState({ kind: "hotel", dayIndex, hotelId, order, displayIndex, name: label });
      recordOp("remove", `「${label}」`, `Day${dayIndex} 住宿候选 → 移出规划（酒店信息保留）`);
      startUndoTimer();
    },
    [updateTrip, recordOp, stopUndoTimer, startUndoTimer],
  );

  const selectHotel = useCallback(
    (dayIndex: number, hotel: HotelCandidate) => {
      updateTrip((current) => {
        const key = String(dayIndex);
        const prev = current.lodgings[key];
        const prevRefs = Array.isArray(prev?.hotelRefs) ? prev.hotelRefs : [];
        const plan: LodgingPlan = {
          dayIndex,
          areaName: prev?.areaName ?? null,
          // rev2 多候选：新选定的酒店置首位（当前展示位），既有候选保留在后
          // （与 addLodgingCandidate 幂等追加契约互补；旧候选可由卡片 × 移出清理）
          hotelRefs: [hotel.id, ...prevRefs.filter((id) => id !== hotel.id)],
          checkInTime: prev?.checkInTime ?? null,
          checkOutTime: prev?.checkOutTime ?? null,
          purchaseState: "unknown",
          locked: false,
          userAdjusted: true,
        };
        const day = current.days[current.dayRefs[dayIndex - 1]];
        const days =
          day === undefined
            ? current.days
            : { ...current.days, [day.dayId]: { ...day, lodging: { kind: "lodging" as const, dayIndex } } };
        return {
          ...current,
          days,
          lodgings: { ...current.lodgings, [key]: plan },
          // 酒店主数据入 registry（key = hotelId，飞猪酒店即 shId）
          hotelRegistry: { ...current.hotelRegistry, [hotel.id]: hotel },
        };
      });
      recordOp("add", `「${hotel.name}」`, `Day${dayIndex} 选定酒店`);
    },
    [updateTrip, recordOp],
  );

  const updateLodgingArea = useCallback(
    (dayIndex: number, areaName: string | null) => {
      updateTrip((current) => {
        const key = String(dayIndex);
        const prev = current.lodgings[key];
        const day = current.days[current.dayRefs[dayIndex - 1]];
        if (day === undefined) return current;
        if (areaName === null) {
          if (prev === undefined) return current;
          if (getPrimaryHotel(current, prev) !== null) {
            // 已选酒店的保留住宿计划，仅清片区意向
            return {
              ...current,
              lodgings: { ...current.lodgings, [key]: { ...prev, areaName: null } },
            };
          }
          const lodgings = { ...current.lodgings };
          delete lodgings[key];
          return {
            ...current,
            lodgings,
            days: { ...current.days, [day.dayId]: { ...day, lodging: null } },
          };
        }
        const plan: LodgingPlan = prev ?? {
          dayIndex,
          areaName: null,
          hotelRefs: [],
          checkInTime: null,
          checkOutTime: null,
          purchaseState: "unknown",
          locked: false,
          userAdjusted: false,
        };
        return {
          ...current,
          lodgings: { ...current.lodgings, [key]: { ...plan, areaName, userAdjusted: true } },
          days: {
            ...current.days,
            [day.dayId]: { ...day, lodging: { kind: "lodging" as const, dayIndex } },
          },
        };
      });
    },
    [updateTrip],
  );

  // ===== AI 结果落地 =====

  /** AI 操作落地：服务端已持久化，本地直接采纳权威 trip，并作废未触发的保存与撤销 */
  const applyServerResult = useCallback(
    (result: ApplyResult) => {
      stopUndoTimer();
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        setSaving(false);
      }
      // AI 可能重排 / 增删景点与酒店：采纳权威 trip 后同样对齐混排顺序
      const normalized = syncDisplayOrders(recomputeAllDays(result.trip));
      tripRef.current = normalized;
      setTrip(normalized);
      try {
        localStorage.setItem(TRIP_CACHE_KEY, JSON.stringify(normalized));
      } catch {
        /* 存储不可用时静默 */
      }
    },
    [stopUndoTimer],
  );

  // 卸载时清理未触发的保存/撤销定时器
  useEffect(
    () => () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
    },
    [],
  );

  return {
    trip,
    loading,
    error,
    saving,
    updateTrip,
    cancelPendingSave,
    refreshFromServer,
    addRefToDay,
    removeVisitWithUndo,
    removeVisitsWithUndo,
    undoRemove,
    undoState,
    reorderVisit,
    reorderDayItems,
    moveDayItem,
    setPurchaseState,
    toggleLock,
    setLodgingPurchaseState,
    toggleLodgingLock,
    updateDepartTime,
    moveStop,
    removeStopWithUndo,
    restoreStop,
    attachPendingStop,
    adoptSuggestedStops,
    classifyVisitAsParentStop,
    addCustomStop,
    ensurePoolRef,
    addToPool,
    deleteFromPool,
    selectHotel,
    updateLodgingArea,
    moveHotelCandidate,
    removeHotelCandidate,
    applyServerResult,
    opLog,
    clearOpLog,
  };
}

/** 取某 Visit 的 childStopRefs 中第 index 个 stopId（越界返回 null） */
function stopIdOf(trip: Trip, visitId: string, index: number): string | null {
  return trip.visits[visitId]?.childStopRefs[index] ?? null;
}
