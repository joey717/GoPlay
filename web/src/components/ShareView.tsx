import { useEffect, useRef, useState } from "react";
import type { Day, LodgingPlan, SharedTrip, Stop, Visit } from "@goplay/shared";
import {
  AI_SUPPLEMENT_CHIP_LABEL,
  AI_SUPPLEMENT_CHIP_LABEL_COMPACT,
  AI_SUPPLEMENT_VERIFY_NOTE,
  GUIDE_SNIPPET_DISPLAY_LIMIT,
  isAiSupplement,
} from "@goplay/shared";
import { ApiError, loadShareTrip, patchShareStatus } from "../api/client";
import { shortDate, suggestDurationLabel, weekdayLabel } from "../lib/format";
import { SHOW_ESTIMATED_TIMES } from "../lib/displayFlags";
import {
  dayLodging,
  dayVisits,
  getPrimaryHotel,
  isParentCardVisit,
  joinTagParts,
  orderedDays,
  stopDisplayName,
  visitDisplayName,
  visitModeLabel,
} from "../lib/trip";
import { hasCoverContent, tripCoverInfo } from "../lib/tripCover";
import ImagePlaceholder from "./ImagePlaceholder";
import ShareStatusPicker from "./ShareStatusPicker";
import TripCoverBar from "./TripCoverBar";
import TripCoverSheet from "./TripCoverSheet";

interface ShareViewProps {
  /** URL /share/:tripId 解析出的行程 ID（接收方无需本地 Trip） */
  tripId: string;
}

type ShareState =
  | { kind: "loading" }
  | { kind: "ready"; trip: SharedTrip }
  | { kind: "missing" }
  | { kind: "error"; message: string };

/** 底部短提示（保存失败回滚说明）：id 保证同样文案重复触发也能重新计时 */
type ShareNotice = { id: number; text: string };

/** ISO 时间戳 → "10/23 14:05"（本地时区；非法值如实显示「未知」） */
function formatStamp(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "未知";
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Visit 展示时间窗：优先服务端计算出的 startTime/endTime（时间轴），
 * 缺失时回退用户给定的 windowStart/windowEnd；都没有则如实写「时间待定」。
 * Task #340：估算时间开关关闭时返回 null（整段不渲染；代码保留可恢复）。
 */
function timeRangeLabel(visit: Visit): string | null {
  if (!SHOW_ESTIMATED_TIMES) return null;
  const start = visit.startTime ?? visit.windowStart;
  const end = visit.endTime ?? visit.windowEnd;
  if (start !== null && end !== null) return `${start} – ${end}`;
  if (start !== null) return `${start} 起`;
  if (visit.windowStart !== null && visit.windowEnd !== null) {
    return `${visit.windowStart} – ${visit.windowEnd}`;
  }
  return "时间待定";
}

/**
 * Day 切换条短标签：大景区显示景区名，普通景点显示处数。
 * Task #344（PD：「把『全天』二字去掉」）：原「名称 · 全天/半天」去掉「全天」取值，
 * full_day 时经 joinTagParts 过滤后只剩名称；「半天」「自定义」保留。
 */
function dayFlag(trip: SharedTrip, day: Day): string {
  const visits = dayVisits(trip, day);
  const large = visits.find((visit) => visit.kind === "large_attraction");
  if (large !== undefined) return joinTagParts(visitDisplayName(trip, large), visitModeLabel(large));
  return visits.length > 0 ? `${visits.length} 处` : "空";
}

/** 单个 Visit 卡片：图片 / 名称 / 地址 / 时间 / 建议时长 / 门票状态标记 / 内部玩法 / 攻略亮点 */
function ShareVisitCard({
  trip,
  visit,
  onStatusChange,
}: {
  trip: SharedTrip;
  visit: Visit;
  /** 状态切换（Task #260）：previous 用于保存失败回滚 */
  onStatusChange: (visitId: string, previous: Visit["purchaseState"], next: Visit["purchaseState"]) => void;
}) {
  const item = trip.itemRegistry[visit.pointRef] ?? null;
  const name = visitDisplayName(trip, visit);
  const address = item?.address?.trim() ?? "";
  // Task #340：建议时长为 AI 推导，估算时间开关关闭时不展示
  const duration = SHOW_ESTIMATED_TIMES ? suggestDurationLabel(visit.effectiveMinutes) : null;
  // Task #344：full_day 不再产出「全天」（空串），下方徽标按空则整块不渲染处理
  const modeLabel = visitModeLabel(visit);
  const timeRange = timeRangeLabel(visit);
  const snippets = (visit.guideSnippets ?? []).slice(0, GUIDE_SNIPPET_DISPLAY_LIMIT);
  const stops = visit.childStopRefs
    .map((stopId) => trip.stops[stopId])
    .filter((stop): stop is Stop => stop !== undefined);

  // Task #348（PD 2026-11-04）：分享页父卡形态同口径——由岛内子玩法驱动，
  // large_attraction 但 0 子玩法的空壳（鹿回头类）按普通卡形态渲染。
  const parentForm = isParentCardVisit(visit);
  return (
    <article className={`share-card${parentForm ? " is-large" : ""}`}>
      <div className="share-thumb">
        {item?.mainPic !== null && item?.mainPic !== undefined ? (
          <img src={item.mainPic} alt="" loading="lazy" />
        ) : (
          <ImagePlaceholder
            name={name}
            category={item?.category ?? null}
            isLargeAttraction={parentForm}
          />
        )}
      </div>
      <div className="share-card-body">
        <div className="share-card-top">
          <h3 className="share-card-name">{name}</h3>
          <span className="share-card-badges">
            {/* Task #344：大景区徽标去掉「全天」后可能为空串，空则不留空白徽标占位；
                Task #348：只父卡形态（子玩法驱动）才显 mode 徽标，普通卡形态不显 */}
            {parentForm && modeLabel !== "" ? (
              <span className="share-badge">{modeLabel}</span>
            ) : null}
            {/* C4：分享页同样展示 AI 补充标（与主行程卡同源常量；≤360px 由全局媒体查询降级） */}
            {isAiSupplement(item) ? (
              <span className="share-badge ai-supplement-chip" title={AI_SUPPLEMENT_VERIFY_NOTE}>
                {AI_SUPPLEMENT_CHIP_LABEL_COMPACT}
                <span className="chip-verify">
                  {AI_SUPPLEMENT_CHIP_LABEL.slice(AI_SUPPLEMENT_CHIP_LABEL_COMPACT.length)}
                </span>
              </span>
            ) : null}
          </span>
        </div>
        {address !== "" ? <p className="share-addr">{address}</p> : null}
        {/* Task #340：时间窗与建议时长均被 gate 时整行不渲染 */}
        {timeRange !== null || duration !== null ? (
          <div className="share-meta">
            {timeRange !== null ? <span>{timeRange}</span> : null}
            {duration !== null ? <span>建议 {duration}</span> : null}
          </div>
        ) : null}
        <ShareStatusPicker
          kind="poi"
          value={visit.purchaseState}
          onChange={(next) => onStatusChange(visit.visitId, visit.purchaseState, next)}
        />
        {stops.length > 0 ? (
          <ol className="share-stops">
            {stops.map((stop, index) => {
              // Task #340：内部玩法建议时长同为 AI 推导，开关关闭时不展示
              const stopMinutes = SHOW_ESTIMATED_TIMES
                ? suggestDurationLabel(stop.suggestMinutes)
                : null;
              const hint = stop.locationHint?.trim() ?? "";
              return (
                <li key={stop.stopId}>
                  <span className="share-stop-no">{String(index + 1).padStart(2, "0")}</span>
                  <span className="share-stop-main">
                    <span className="share-stop-name">{stopDisplayName(trip, stop)}</span>
                    {hint !== "" ? <span className="share-stop-hint">{hint}</span> : null}
                  </span>
                  {stopMinutes !== null ? <span className="share-stop-dur">{stopMinutes}</span> : null}
                </li>
              );
            })}
          </ol>
        ) : null}
        {snippets.length > 0 ? (
          <div className="share-highlights">
            <span className="share-highlights-label">攻略亮点</span>
            <ul>
              {snippets.map((snippet) => (
                <li key={snippet.snippetId}>{snippet.text}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </article>
  );
}

/** 当晚住宿卡：酒店名 / 价格 / 区域（未选酒店时降级为片区说明）+ 订房状态标记 */
function ShareStayCard({
  trip,
  plan,
  onStatusChange,
}: {
  trip: SharedTrip;
  plan: LodgingPlan;
  onStatusChange: (
    dayIndex: number,
    previous: LodgingPlan["purchaseState"],
    next: LodgingPlan["purchaseState"],
  ) => void;
}) {
  const hotel = getPrimaryHotel(trip, plan);
  const area = plan.areaName?.trim() ?? "";
  if (hotel === null && area === "") return null;
  // 未选酒店时标题已包含片区，避免「海棠湾住宿待定 · 海棠湾」重复
  const metaParts =
    hotel === null ? [] : [area, hotel.priceText ?? "", hotel.star ?? ""].filter((part) => part !== "");

  return (
    <article className="share-stay">
      <div className="share-stay-head">
        <span className="share-label">当晚住宿</span>
      </div>
      <div className="share-stay-main">
        {hotel?.mainPic !== null && hotel?.mainPic !== undefined ? (
          <img className="share-stay-pic" src={hotel.mainPic} alt="" loading="lazy" />
        ) : null}
        <div className="share-stay-text">
          <h4>{hotel?.name ?? `${area}住宿待定`}</h4>
          {metaParts.length > 0 ? <p>{metaParts.join(" · ")}</p> : null}
        </div>
      </div>
      <ShareStatusPicker
        kind="hotel"
        value={plan.purchaseState}
        onChange={(next) => {
          // 住宿字典没有免票档，拦截类型上的越界值
          if (next === "noTicket") return;
          onStatusChange(plan.dayIndex, plan.purchaseState, next);
        }}
      />
    </article>
  );
}

/**
 * 分享页：/share/:tripId（Task #205 只读分享 + Task #260 受限状态打标）。
 *
 * 数据来自 GET /api/share/:tripId（脱敏 SharedTrip，每次现读最新行程）。
 * 可交互的只有三件事：切天、查看封面浮层、给景点 / 住宿标记购票与订房状态
 * （PATCH /api/share/:tripId/status，只改 purchaseState）。
 * 没有编辑 / 拖拽 / AI 输入 / 候选池 / 攻略面板 / 锁定等任何其他编辑能力；
 * 未登录、无本地 Trip 的浏览器同样可打开。
 *
 * Task #258：封面不再是首屏大卡，而是顶部一行紧凑入口（TripCoverBar）。
 * 首次打开时若有封面内容（封面图 / 备忘）自动拉起只读封面浮层作首屏，
 * 关闭后进入行程；浮层内没有任何编辑入口，也可随时点入口重新查看。
 */
export default function ShareView({ tripId }: ShareViewProps) {
  const [state, setState] = useState<ShareState>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [dayIndex, setDayIndex] = useState(1);
  /** 封面浮层开关 + 「首次自动展示」只做一次（用户手动关掉后不再弹） */
  const [coverOpen, setCoverOpen] = useState(false);
  const coverAutoOpenedRef = useRef(false);
  /** 状态保存失败提示（底部短条，2.8s 自动消失） */
  const [notice, setNotice] = useState<ShareNotice | null>(null);
  /** 状态补丁请求序号：只有最后一次请求的结果负责回滚 / 刷新版本，避免乱序覆盖 */
  const patchSeqRef = useRef(0);

  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => setNotice(null), 2800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    let active = true;
    setState({ kind: "loading" });
    void loadShareTrip(tripId)
      .then((trip) => {
        if (active) setState({ kind: "ready", trip });
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiError && error.status === 404) {
          setState({ kind: "missing" });
          return;
        }
        setState({
          kind: "error",
          message: error instanceof ApiError ? error.message : "分享的行程加载失败，请稍后重试",
        });
      });
    return () => {
      active = false;
    };
  }, [tripId, reloadKey]);

  const shareCity = state.kind === "ready" ? state.trip.destination.city : null;
  useEffect(() => {
    if (shareCity === null) return;
    const previous = document.title;
    document.title = `${shareCity}行程 · GoPlay`;
    return () => {
      document.title = previous;
    };
  }, [shareCity]);

  // Task #258：有内容（封面图 / 备忘）的分享行程首次自动展示封面浮层作首屏，
  // 用户关闭后即进入行程；无内容时不打扰（名称已在紧凑入口常驻可见）。
  useEffect(() => {
    if (state.kind !== "ready" || coverAutoOpenedRef.current) return;
    coverAutoOpenedRef.current = true;
    const info = tripCoverInfo(state.trip, `${state.trip.destination.city}行程`);
    if (hasCoverContent(info)) setCoverOpen(true);
  }, [state]);

  if (state.kind === "loading") {
    return (
      <div className="boot" aria-live="polite">
        <div className="boot-mark">G</div>
        正在打开分享的行程…
      </div>
    );
  }

  if (state.kind === "missing") {
    return (
      <div className="boot boot-error" role="alert">
        <div className="boot-mark">G</div>
        <p className="boot-title">链接已失效</p>
        <p className="boot-note">这份行程可能已被删除，或链接不完整。请让分享的朋友重新发一次。</p>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="boot boot-error" role="alert">
        <div className="boot-mark">G</div>
        <p className="boot-title">暂时打不开</p>
        <p className="boot-note">{state.message}</p>
        <button type="button" onClick={() => setReloadKey((key) => key + 1)}>
          重试
        </button>
      </div>
    );
  }

  const trip = state.trip;
  const days = orderedDays(trip);
  const day = days.find((item) => item.dayIndex === dayIndex) ?? days[0] ?? null;
  const visits = day === null ? [] : dayVisits(trip, day);
  const lodging = day === null ? null : dayLodging(trip, day.dayIndex);
  // Task #257：封面卡即分享首屏（只读）；未命名时用「{城市}行程」充当标题，
  // 避免访客看到只对自己有意义的「我的行程」。
  const coverInfo = tripCoverInfo(trip, `${trip.destination.city}行程`);

  /** 只替换目标字段（乐观更新与回滚共用），其余对象引用保持不变 */
  const setVisitStatus = (visitId: string, value: Visit["purchaseState"]) => {
    setState((prev) => {
      if (prev.kind !== "ready") return prev;
      const target = prev.trip.visits[visitId];
      if (target === undefined) return prev;
      return {
        kind: "ready",
        trip: {
          ...prev.trip,
          visits: { ...prev.trip.visits, [visitId]: { ...target, purchaseState: value } },
        },
      };
    });
  };

  const setLodgingStatus = (dayIndex: number, value: LodgingPlan["purchaseState"]) => {
    setState((prev) => {
      if (prev.kind !== "ready") return prev;
      const key = String(dayIndex);
      const plan = prev.trip.lodgings[key];
      if (plan === undefined) return prev;
      return {
        kind: "ready",
        trip: {
          ...prev.trip,
          lodgings: { ...prev.trip.lodgings, [key]: { ...plan, purchaseState: value } },
        },
      };
    });
  };

  /**
   * 景点门票状态打标（Task #260）：先乐观更新，再走 PATCH；
   * 失败则回滚到 previous 并弹提示；成功只回写版本号与更新时间
   * （不回写整份载荷，避免晚到的响应回滚其它已成功修改的字段）。
   */
  const changeVisitStatus = (
    visitId: string,
    previous: Visit["purchaseState"],
    next: Visit["purchaseState"],
  ) => {
    if (previous === next) return;
    setVisitStatus(visitId, next);
    const seq = ++patchSeqRef.current;
    void patchShareStatus(tripId, { visits: [{ visitId, purchaseState: next }] })
      .then((updated) => {
        if (seq !== patchSeqRef.current) return;
        setState((prev) =>
          prev.kind === "ready"
            ? { kind: "ready", trip: { ...prev.trip, version: updated.version, updatedAt: updated.updatedAt } }
            : prev,
        );
      })
      .catch(() => {
        if (seq !== patchSeqRef.current) return;
        setVisitStatus(visitId, previous);
        setNotice({ id: Date.now(), text: "门票状态未能保存，已恢复原状态" });
      });
  };

  /** 住宿订房状态打标：与景点同构（3 态字典，回滚文案区分对象） */
  const changeLodgingStatus = (
    dayIndex: number,
    previous: LodgingPlan["purchaseState"],
    next: LodgingPlan["purchaseState"],
  ) => {
    if (previous === next) return;
    setLodgingStatus(dayIndex, next);
    const seq = ++patchSeqRef.current;
    void patchShareStatus(tripId, { lodgings: [{ dayIndex, purchaseState: next }] })
      .then((updated) => {
        if (seq !== patchSeqRef.current) return;
        setState((prev) =>
          prev.kind === "ready"
            ? { kind: "ready", trip: { ...prev.trip, version: updated.version, updatedAt: updated.updatedAt } }
            : prev,
        );
      })
      .catch(() => {
        if (seq !== patchSeqRef.current) return;
        setLodgingStatus(dayIndex, previous);
        setNotice({ id: Date.now(), text: "订房状态未能保存，已恢复原状态" });
      });
  };

  return (
    <div className="share-app">
      <TripCoverBar info={coverInfo} readOnly expanded={coverOpen} onOpen={() => setCoverOpen(true)} />
      <div className="share-head share-head-slim">
        <p className="share-hint">朋友分享的行程 · 只能标记购票 / 订房状态</p>
        <span className="share-stamp">最后更新 {formatStamp(trip.updatedAt)}</span>
      </div>

      {/* 复用主应用的 Day 切换条样式（.daystrip / .dchip），不引入拖拽与编辑能力 */}
      <div className="daystrip-wrap share-daystrip">
        <div className="daystrip">
          {days.map((item) => (
            <button
              key={item.dayId}
              type="button"
              className={`dchip${item.dayIndex === day?.dayIndex ? " on" : ""}`}
              aria-pressed={item.dayIndex === day?.dayIndex}
              onClick={() => setDayIndex(item.dayIndex)}
            >
              <span className="d">Day{item.dayIndex}</span>
              <span className="w">
                {shortDate(item.date)} {weekdayLabel(item.date)}
              </span>
              <span className="flag">{dayFlag(trip, item)}</span>
            </button>
          ))}
        </div>
      </div>

      <main className="share-screen">
        {day === null ? (
          <p className="share-empty">这份行程还没有日程</p>
        ) : (
          <section className="share-day" key={day.dayIndex}>
            <div className="share-day-head">
              <div className="share-day-title">
                <span className="share-day-no">Day {day.dayIndex}</span>
                <span className="share-day-date">
                  {shortDate(day.date)} {weekdayLabel(day.date)}
                </span>
              </div>
              {day.departTime !== null ? <span className="share-depart">{day.departTime} 出发</span> : null}
            </div>
            {visits.length === 0 && lodging === null ? <p className="share-empty">这天还没有安排</p> : null}
            {visits.map((visit) => (
              <ShareVisitCard
                key={visit.visitId}
                trip={trip}
                visit={visit}
                onStatusChange={changeVisitStatus}
              />
            ))}
            {lodging !== null ? (
              <ShareStayCard trip={trip} plan={lodging} onStatusChange={changeLodgingStatus} />
            ) : (
              <p className="share-no-stay">当晚无住宿安排</p>
            )}
          </section>
        )}
      </main>

      <footer className="share-foot">
        <span>由 GoPlay 生成</span>
        <span>最后更新 {formatStamp(trip.updatedAt)}</span>
      </footer>

      {/* 状态保存失败提示：固定底部短条，不拦截任何按钮 */}
      {notice !== null ? (
        <div className="share-status-toast" role="status" key={notice.id}>
          {notice.text}
        </div>
      ) : null}

      {/* 封面浮层：分享页无固定高度容器，用 fixed 层模拟 .app 的包含块，
          避开 .proposal-sheet 的 absolute 落到整个文档底部（长行程会跑到屏外） */}
      {coverOpen ? (
        <div className="share-sheet-layer">
          <TripCoverSheet info={coverInfo} readOnly onClose={() => setCoverOpen(false)} />
        </div>
      ) : null}
    </div>
  );
}
