import { useRef, useState } from "react";
import type { EntityRef, HotelCandidate, Item, Trip, Visit } from "@goplay/shared";
import { isFreeAdmissionItem, isFreeAdmissionPoi } from "@goplay/shared";
import {
  flyAiErrorMessage,
  isRetryableSearchError,
  searchHotels,
  searchPoi,
  type PoiSearchResult,
} from "../api/client";
import { suggestDurationLabel, todayIso } from "../lib/format";
import { SHOW_ESTIMATED_TIMES } from "../lib/displayFlags";
import {
  dayLodging,
  getPrimaryHotel,
  isParentCardVisit,
  orderedDays,
  pendingStops,
  poolEntries,
  stopDisplayName,
  visitsWithAlternates,
} from "../lib/trip";
import { ConfirmDialog } from "./ConfirmDialog";
import { PoiLevelTag, PoiRankChip } from "./PoiMeta";

interface CandidatePoolProps {
  open: boolean;
  trip: Trip;
  /** 「添加到 DayN」的目标天（当前选中的天） */
  currentDayIndex: number;
  onClose: () => void;
  onAddToPool: (item: Item) => void;
  /** 飞猪酒店结果直接选为当天住宿（F6 selectHotel 语义；酒店不入点位候选池） */
  onSelectHotel: (dayIndex: number, hotel: HotelCandidate) => void;
  /** 候选区条目（普通点位 / 大景区壳）排入当天末尾（plan + move） */
  onAddToDay: (dayIndex: number, ref: EntityRef) => void;
  /** 从候选区删除（point 走 remove op；大景区壳解除引用） */
  onDeleteFromPool: (ref: EntityRef) => void;
  /** 待定加入的内部玩法归类到指定大景区 */
  onAttachPendingStop: (stopId: string, visitId: string) => void;
  /** 备选玩法放回所属大景区的岛内行程末尾 */
  onRestoreStop: (stopId: string) => void;
}

/** 候选区条目 key（EntityRef 联合里 point/visit/stop/hotel 带 id，其余按 dayIndex） */
function entryKey(ref: EntityRef): string {
  if (
    ref.kind === "visit" ||
    ref.kind === "point" ||
    ref.kind === "stop" ||
    ref.kind === "hotel"
  ) {
    return `${ref.kind}-${ref.id}`;
  }
  return `${ref.kind}-${ref.dayIndex}`;
}

/** 飞猪搜索结果 → v1.1 Item 主数据（真实 jumpUrl/mainPic 原样保留，不伪造链接） */
function poiResultToItem(poi: PoiSearchResult): Item {
  return {
    itemId: crypto.randomUUID(),
    name: poi.name,
    origin: "fliggy",
    providerId: poi.id,
    address: poi.address,
    category: poi.category,
    coords: poi.coords,
    suggestMinutes: 60,
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

/** 搜索结果合并条目：景点（POI）与酒店统一 key 命名空间（poi:/hotel:，id 互不相通） */
type PoolSearchEntry =
  | { kind: "poi"; key: string; poi: PoiSearchResult }
  | { kind: "hotel"; key: string; hotel: HotelCandidate };

/** "YYYY-MM-DD" → 次日（UTC 构造避免时区偏移）；与 TripView.nextDate 同语义 */
function nextDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * 酒店搜索日期：目标天为入住日（次日退房）；行程缺日期时回退明天/后天（合理默认值）。
 */
function hotelSearchDates(trip: Trip, dayIndex: number): { checkIn: string; checkOut: string } {
  const days = orderedDays(trip);
  const date = (days.find((day) => day.dayIndex === dayIndex) ?? days[0])?.date ?? "";
  const checkIn = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : nextDate(todayIso());
  return { checkIn, checkOut: nextDate(checkIn) };
}

/** 删除确认弹窗的垃圾桶图标 */
function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16" />
      <path d="M10 11v6M14 11v6" />
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

/**
 * 候选池底部 Sheet（v1.1 三区，PRD §7.7）：
 * 1. 候选区（globalCandidateRefs）：普通点位 + 大景区壳 → 排入某天 / 删除；
 * 2. 待定加入（pendingStopRefs）：归属不确定的内部玩法 → 归类到某大景区；
 * 3. 备选玩法（各 Visit alternateStopRefs）→ 放回所属大景区。
 * 上方保留飞猪实时搜索（结构化目的地过滤）。
 */
export default function CandidatePool({
  open,
  trip,
  currentDayIndex,
  onClose,
  onAddToPool,
  onSelectHotel,
  onAddToDay,
  onDeleteFromPool,
  onAttachPendingStop,
  onRestoreStop,
}: CandidatePoolProps) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<PoolSearchEntry[]>([]);
  /** 搜索反馈：message 为安全文案；canRetry 为 true 时展示「重试」（空结果提示不展示） */
  const [searchError, setSearchError] = useState<{ message: string; canRetry: boolean } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ ref: EntityRef; name: string } | null>(null);
  /** 正在展开父景区选择列表的待定玩法 stopId */
  const [attachFor, setAttachFor] = useState<string | null>(null);
  /** 正在展开备选玩法列表的大景区 visitId */
  const [reserveOpenId, setReserveOpenId] = useState<string | null>(null);
  const flashTimerRef = useRef<number | null>(null);

  const entries = poolEntries(trip);
  const pendings = pendingStops(trip);
  const alternates = visitsWithAlternates(trip);

  /** 行程内的大景区（待定玩法可归类的目标）：已排期在前，全局池壳（未排期）在后 */
  const largeVisits = Object.values(trip.visits)
    .filter((visit): visit is Visit => visit.kind === "large_attraction")
    .sort((a, b) => (a.dayRef === null ? 1 : 0) - (b.dayRef === null ? 1 : 0));

  const showFlash = (text: string) => {
    setFlash(text);
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setFlash(null), 1600);
  };

  /** 结构化目的地：搜索请求必须携带，服务端据此做权威城市过滤 */
  const destinationCity = trip.destination.city.trim();

  /**
   * 并行双通道搜索：searchPoi（景点）与 searchHotels（酒店，按名称关键词直搜）。
   * 二者为独立搜索域（search-poi 搜不到酒店）；allSettled 保证互不拖累，
   * 单侧失败仍展示另一侧结果，双侧全失败（或 0 结果）才进错误/空态提示。
   */
  const doSearch = async () => {
    const keyword = query.trim();
    if (!keyword || searching) return;
    setSearching(true);
    setSearchError(null);
    const destination = destinationCity;
    const hotelAttempted = destination !== "";
    const [poiSettled, hotelSettled] = await Promise.allSettled([
      searchPoi(keyword, destination || undefined),
      hotelAttempted
        ? searchHotels({ destination, q: keyword, ...hotelSearchDates(trip, currentDayIndex) })
        : Promise.reject(new Error("酒店搜索需要结构化目的地")),
    ]);

    const entries: PoolSearchEntry[] = [];
    const failures: string[] = [];
    if (poiSettled.status === "fulfilled") {
      entries.push(
        ...poiSettled.value.normalized.map(
          (poi): PoolSearchEntry => ({ kind: "poi", key: `poi:${poi.id}`, poi }),
        ),
      );
    } else {
      failures.push(`景点搜索失败：${flyAiErrorMessage(poiSettled.reason)}`);
    }
    if (hotelSettled.status === "fulfilled") {
      entries.push(
        ...hotelSettled.value.normalized.map(
          (hotel): PoolSearchEntry => ({ kind: "hotel", key: `hotel:${hotel.id}`, hotel }),
        ),
      );
    } else if (hotelAttempted) {
      failures.push(`酒店搜索失败：${flyAiErrorMessage(hotelSettled.reason)}`);
    }

    if (entries.length === 0) {
      // 0 结果：区分「双侧失败」（可重试）与「真实空结果」（引导换关键词，不展示重试）
      const retryable =
        (poiSettled.status === "rejected" && isRetryableSearchError(poiSettled.reason)) ||
        (hotelSettled.status === "rejected" &&
          hotelAttempted &&
          isRetryableSearchError(hotelSettled.reason));
      setSearchError({
        message:
          failures.length > 0
            ? failures.join("；")
            : destination
              ? `在${destination}没有找到相关景点或酒店，换个关键词试试`
              : "没有找到相关景点或酒店，换个关键词试试",
        canRetry: failures.length > 0 && retryable,
      });
    } else if (failures.length > 0) {
      // 单侧失败仍有结果：仅作非阻塞提示，不打断已得结果（不展示重试按钮）
      setSearchError({ message: `${failures.join("；")}（已展示另一侧结果）`, canRetry: false });
    }
    setResults(entries);
    setSearching(false);
  };

  const handleAddToPool = (poi: PoiSearchResult) => {
    onAddToPool(poiResultToItem(poi));
    showFlash(`已加入候选池 · ${poi.name}`);
  };

  /** 飞猪酒店结果选为当天住宿（F6 语义）；酒店不进点位候选池 */
  const handleSelectHotel = (hotel: HotelCandidate) => {
    onSelectHotel(currentDayIndex, hotel);
    showFlash(`已选为 Day${currentDayIndex} 酒店 · ${hotel.name}`);
  };

  const handleAddToDay = (ref: EntityRef, name: string) => {
    onAddToDay(currentDayIndex, ref);
    showFlash(`已排入 Day${currentDayIndex} · ${name}`);
  };

  /** F12 彻底删除：确认后从候选区移除 */
  const confirmDelete = () => {
    if (!pendingDelete) return;
    onDeleteFromPool(pendingDelete.ref);
    showFlash(`已从候选区删除 · ${pendingDelete.name}`);
    setPendingDelete(null);
  };

  return (
    <>
      <div className={`backdrop ${open ? "on" : ""}`} onClick={onClose} aria-hidden="true" />
      <div className={`sheet ${open ? "on" : ""}`} role="dialog" aria-label="候选池">
        <div className="sh">
          <div>
            <div className="st1">候选池</div>
            <div className="st2">
              搜飞猪景点加入候选池、酒店选为当天住宿；「添加到 Day{currentDayIndex}」会排到当天末尾并重算时间。
            </div>
          </div>
          <button type="button" className="x" onClick={onClose} aria-label="关闭候选池">
            ✕
          </button>
        </div>

        <div className="sf-search">
          <input
            value={query}
            placeholder={
              destinationCity
                ? `在${destinationCity}范围内搜索飞猪景点或酒店，如：西岛`
                : "搜索飞猪景点或酒店"
            }
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void doSearch();
            }}
          />
          <button type="button" onClick={() => void doSearch()} disabled={searching || !query.trim()}>
            {searching ? "搜索中…" : "搜索"}
          </button>
        </div>

        <div className="sb">
          {searchError ? (
            <div className="pool-err">
              <span className="pool-err-msg">{searchError.message}</span>
              {searchError.canRetry ? (
                <button
                  type="button"
                  className="mini pool-retry"
                  onClick={() => void doSearch()}
                  disabled={searching}
                >
                  重试
                </button>
              ) : null}
            </div>
          ) : null}

          {results.length > 0 ? (
            <div className="pool-section">
              <div className="pool-title">飞猪搜索结果（{results.length}）</div>
              {(() => {
                const primaryHotelId =
                  getPrimaryHotel(trip, dayLodging(trip, currentDayIndex))?.id ?? null;
                return results.map((entry) => {
                  if (entry.kind === "poi") {
                    const poi = entry.poi;
                    const pooled = trip.globalCandidateRefs.some(
                      (ref) =>
                        ref.kind === "point" && trip.itemRegistry[ref.id]?.name === poi.name,
                    );
                    return (
                      <div className="poolitem" key={entry.key}>
                        <div className="pn">
                          <div className="n">
                            {poi.name}
                            <span className="tag clay pool-kind">景点</span>
                            {/* Task #330：4A/5A 等级徽标（与「景点/免票」tag 同排同尺寸） */}
                            <PoiLevelTag level={poi.poiLevel} />
                            {/* Task #329：免费场所搜索结果同口径标「免票」；#330 D 传入名称启用名称通道 */}
                            {isFreeAdmissionPoi(poi.freePoiStatus, poi.category, poi.name) ? (
                              <span className="tag slate">免票</span>
                            ) : null}
                          </div>
                          {/* Task #330：榜单行（名称下方独立一行暖色 chip，无则完全不占位） */}
                          <PoiRankChip rank={poi.listRank} />
                          <div className="m">
                            {poi.address ?? "地址待补全"}
                            {poi.category ? ` · ${poi.category}` : ""}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="mini"
                          disabled={pooled}
                          onClick={() => handleAddToPool(poi)}
                        >
                          {pooled ? "已在池中" : "添加到候选池"}
                        </button>
                      </div>
                    );
                  }
                  const hotel = entry.hotel;
                  const chosen = primaryHotelId === hotel.id;
                  const meta = [
                    hotel.priceText,
                    hotel.rate !== null && hotel.rate !== "" ? `评分 ${hotel.rate}` : null,
                    hotel.interestsPoi ?? hotel.address,
                  ]
                    .filter((part): part is string => typeof part === "string" && part !== "")
                    .join(" · ");
                  return (
                    <div className="poolitem" key={entry.key}>
                      <div className="pn">
                        <div className="n">
                          {hotel.name}
                          <span className="tag clay pool-kind">酒店</span>
                        </div>
                        <div className="m">
                          {meta !== "" ? meta : "价格与评分以飞猪页面为准"}
                          {hotel.detailUrl ? " · 可去飞猪看详情" : ""}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="mini"
                        disabled={chosen}
                        onClick={() => handleSelectHotel(hotel)}
                      >
                        {chosen ? `已选为 Day${currentDayIndex} 酒店` : `选为 Day${currentDayIndex} 酒店`}
                      </button>
                    </div>
                  );
                });
              })()}
            </div>
          ) : null}

          {/* 区一：候选区（普通点位 + 大景区壳） */}
          <div className="pool-section">
            <div className="pool-title">候选区（{entries.length}）</div>
            {entries.length === 0 ? (
              <div className="pool-empty">
                候选区是空的。从行程里移除的点位会回到这里，字段全保留。
              </div>
            ) : (
              entries.map((entry) => {
                // 建议时长未知（待定）时不渲染「建议 …」，避免出现无信息量的「建议 待定」
                // Task #343：候选区「建议 X」时长 chip 属估算时间，SHOW_ESTIMATED_TIMES=false 时
                // 一律不展示（渲染代码保留，开关改回 true 即恢复）；其余 chip（自定义 / 免票 /
                // 含 N 个岛内玩法 / 原 DayN）不受影响
                const suggestLabel = SHOW_ESTIMATED_TIMES
                  ? suggestDurationLabel(entry.item?.suggestMinutes ?? null)
                  : null;
                // 大景区壳已归入的岛内玩法数（验收问题修复）：排入某天后父卡会直接
                // 展示这些子玩法与亮点，候选行先如实声明
                const childCount =
                  entry.ref.kind === "visit"
                    ? (trip.visits[entry.ref.id]?.childStopRefs.length ?? 0)
                    : 0;
                const metaParts = [
                  entry.item?.origin === "custom" ? "自定义" : null,
                  // Task #329：候选卡同口径标「免票」（候选区无购票按钮，仅标签）
                  isFreeAdmissionItem(entry.item) ? "免票" : null,
                  childCount > 0 ? `含 ${childCount} 个岛内玩法` : null,
                  suggestLabel !== null ? `建议 ${suggestLabel}` : null,
                  entry.removedFrom !== null ? `原 Day${entry.removedFrom.dayIndex}` : null,
                ].filter((part): part is string => part !== null);
                return (
                  <div className="poolitem" key={entryKey(entry.ref)}>
                    <div className="pn">
                      <div className="n">
                        {entry.name}
                        {/* Task #348（PD 2026-11-04）：池内「大景区」标签同口径改为子玩法驱动，
                            与父卡渲染判定单点 isParentCardVisit 一致（本组件为死代码，无挂载） */}
                        {isParentCardVisit(
                          entry.ref.kind === "visit" ? trip.visits[entry.ref.id] : null,
                        ) ? (
                          <span className="tag clay pool-kind">大景区</span>
                        ) : null}
                      </div>
                      {metaParts.length > 0 ? (
                        <div className="m">{metaParts.join(" · ")}</div>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="mini"
                      onClick={() => handleAddToDay(entry.ref, entry.name)}
                    >
                      添加到 Day{currentDayIndex}
                    </button>
                    <button
                      type="button"
                      className="mini danger"
                      title="彻底删除（之后要再加得重新搜索）"
                      aria-label={`彻底删除 ${entry.name}`}
                      onClick={() => setPendingDelete({ ref: entry.ref, name: entry.name })}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                );
              })
            )}
          </div>

          {/* 区二：待定加入（归属不确定的内部玩法） */}
          {pendings.length > 0 ? (
            <div className="pool-section">
              <div className="pool-title">待定加入（{pendings.length}）</div>
              <div className="pool-empty">
                这些玩法来自你的攻略，但还不能确定属于哪个大景区；归类后才会进入岛内行程。
              </div>
              {pendings.map((stop) => {
                const suggested =
                  stop.suggestedVisitRef !== null ? trip.visits[stop.suggestedVisitRef] ?? null : null;
                // 建议时长未知（待定）时不渲染「建议 …」，避免出现无信息量的「建议 待定」
                // Task #343：待定加入区「建议 X」时长 chip 同为估算时间，开关关闭时不展示；
                // 归属语义（可能属于「X」/ 归属待确认）保留，故 .m 行不会变空
                const suggestLabel = SHOW_ESTIMATED_TIMES
                  ? suggestDurationLabel(stop.suggestMinutes)
                  : null;
                const metaParts = [
                  suggestLabel !== null ? `建议 ${suggestLabel}` : null,
                  suggested !== null ? `可能属于「${visitNameOf(trip, suggested)}」` : "归属待确认",
                ].filter((part): part is string => part !== null);
                return (
                  <div className="poolitem pending-stop" key={stop.stopId}>
                    <div className="pn">
                      <div className="n">{stopDisplayName(trip, stop)}</div>
                      <div className="m">{metaParts.join(" · ")}</div>
                    </div>
                    {suggested !== null ? (
                      <button
                        type="button"
                        className="mini"
                        onClick={() => {
                          onAttachPendingStop(stop.stopId, suggested.visitId);
                          showFlash(`已归类到「${visitNameOf(trip, suggested)}」`);
                        }}
                      >
                        归类
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="mini"
                        onClick={() => setAttachFor(attachFor === stop.stopId ? null : stop.stopId)}
                      >
                        {attachFor === stop.stopId ? "收起" : "归类…"}
                      </button>
                    )}
                    {attachFor === stop.stopId ? (
                      <div className="attach-options">
                        {largeVisits.length === 0 ? (
                          <div className="pool-empty">行程里还没有大景区，先排入一个大景区。</div>
                        ) : (
                          largeVisits.map((visit) => (
                            <button
                              type="button"
                              className="mini"
                              key={visit.visitId}
                              onClick={() => {
                                onAttachPendingStop(stop.stopId, visit.visitId);
                                setAttachFor(null);
                                showFlash(`已归类到「${visitNameOf(trip, visit)}」`);
                              }}
                            >
                              {visitNameOf(trip, visit)}
                              {visit.dayRef === null ? "（未排期）" : ""}
                            </button>
                          ))
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}

          {/* 区三：备选玩法（各父大景区的 alternateStopRefs） */}
          {alternates.length > 0 ? (
            <div className="pool-section">
              <div className="pool-title">备选玩法（{alternates.length} 个景区）</div>
              <div className="pool-empty">
                备选玩法只放在所属大景区里，不出现在城市路线中；可随时放回岛内行程。
              </div>
              {alternates.map((visit) => {
                const expanded = reserveOpenId === visit.visitId;
                const stopList = visit.alternateStopRefs
                  .map((stopId) => trip.stops[stopId])
                  .filter((stop) => stop !== undefined);
                return (
                  <div className="poolitem reserve-group" key={visit.visitId}>
                    <div className="pn">
                      <div className="n">{visitNameOf(trip, visit)}</div>
                      <div className="m">备选玩法 {stopList.length} 项</div>
                    </div>
                    <button
                      type="button"
                      className="mini"
                      onClick={() => setReserveOpenId(expanded ? null : visit.visitId)}
                    >
                      {expanded ? "收起" : "查看"}
                    </button>
                    {expanded ? (
                      <div className="attach-options">
                        {stopList.map((stop) => {
                          // 建议时长未知（待定）时不渲染「建议 …」，避免出现无信息量的「建议 待定」
                          // Task #343：备选玩法区「建议 X」时长 chip 属估算时间，开关关闭时
                          // 整个 .reserve-meta 行不渲染（名称与「放回」按钮保留）
                          const stopSuggest = SHOW_ESTIMATED_TIMES
                            ? suggestDurationLabel(stop.suggestMinutes)
                            : null;
                          return (
                            <div className="reserve-item" key={stop.stopId}>
                              <div className="reserve-info">
                                <div className="reserve-name">{stopDisplayName(trip, stop)}</div>
                                {stopSuggest !== null ? (
                                  <div className="reserve-meta">建议 {stopSuggest}</div>
                                ) : null}
                              </div>
                              <button
                                type="button"
                                className="mini"
                                onClick={() => {
                                  onRestoreStop(stop.stopId);
                                  showFlash(`已放回「${visitNameOf(trip, visit)}」岛内行程`);
                                }}
                              >
                                放回
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>

        {pendingDelete ? (
          <ConfirmDialog
            title="删除点位"
            description={`从这趟行程中删掉「${pendingDelete.name}」，之后要再加得重新搜索`}
            confirmText="删除"
            danger
            onConfirm={confirmDelete}
            onCancel={() => setPendingDelete(null)}
          />
        ) : null}

        {flash ? <div className="pool-flash">{flash}</div> : null}
      </div>
    </>
  );
}

/** Visit 可读名称（模块内辅助，避免额外导入 visitDisplayName 的循环依赖风险） */
function visitNameOf(trip: Trip, visit: Visit): string {
  return trip.itemRegistry[visit.pointRef]?.name ?? visit.visitId;
}
