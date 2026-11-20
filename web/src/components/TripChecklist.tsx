import { useEffect, useMemo, useRef, useState } from "react";
import type { Trip } from "@goplay/shared";
import { shortDate, weekdayLabel } from "../lib/format";
import { notifySheetOpened, onSheetOpened } from "../lib/sheetBus";
import type { CheckCategory, CheckItem, CheckStatus, DayCheckItems } from "../lib/tripChecklist";
import { buildTripChecklist, checklistCount, dayCheckCount } from "../lib/tripChecklist";

type Tab = "pending" | "done";

const TABS: Tab[] = ["pending", "done"];

const TAB_LABEL: Record<Tab, string> = {
  pending: "待办",
  done: "已完成",
};

const EMPTY_TEXT: Record<Tab, string> = {
  pending: "太棒了，没有待办！",
  done: "还没有已完成的事项",
};

/** 分类的图标与标题（固定顺序：住宿 → 景点 → 交通） */
const CATEGORY_META: Record<CheckCategory, { icon: string; label: string }> = {
  hotel: { icon: "🏨", label: "住宿" },
  attraction: { icon: "🎫", label: "景点" },
  transport: { icon: "✈️", label: "交通" },
};

/** 分类展示顺序：与需求约定的「酒店→景点→交通」一致 */
const CATEGORY_ORDER: CheckCategory[] = ["hotel", "attraction", "transport"];

/** 分类 → DayCheckItems 上的字段名（transport 不带 s，不能按类名拼） */
const CATEGORY_ITEMS_KEY: Record<CheckCategory, "hotels" | "attractions" | "transport"> = {
  hotel: "hotels",
  attraction: "attractions",
  transport: "transport",
};

/**
 * 状态胶囊语气：
 * - is-open：待处理但已有明确意向（未确定 / 现场买 / 现场订）；
 * - is-missing：还没内容（住宿未安排 / 航班待录入）；
 * - is-done：已闭环（已购 / 无需购票 / 已订房 / 航班已录入）。
 */
function statusTone(status: CheckStatus): string {
  if (status === "missing") return "is-missing";
  if (status === "flight" || status === "bought" || status === "noTicket") return "is-done";
  return "is-open";
}

interface TripChecklistProps {
  trip: Trip;
  onClose: () => void;
}

/**
 * 待办清单盘点浮层（Task #265，只读）。
 *
 * 为什么是盘点而不是操作台：门票 / 住宿 / 航班的「买没买、订没订」分散在每天
 * 的卡片与约束里，行前想知道「还差什么」要逐天翻。这里把 Trip 一次性摊平成
 * 待办 / 已完成两组，按天分组、按 住宿→景点→交通 固定顺序列出，只读不改数据
 * （改状态仍回卡片上操作，避免同一状态出现两处写入入口）。
 *
 * 浮层互斥：挂载即广播 "checklist"，近期操作 / 封面 / 约束编辑 / 攻略原文让位；
 * 反向收到别家 kind 时自关，保证任意时刻至多一个浮层可见。
 */
export default function TripChecklist({ trip, onClose }: TripChecklistProps) {
  const [tab, setTab] = useState<Tab>("pending");
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ pending: null, done: null });
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const checklist = useMemo(() => buildTripChecklist(trip), [trip]);
  const pendingCount = checklistCount(checklist.pending);
  const doneCount = checklistCount(checklist.done);
  const groups: DayCheckItems[] = tab === "pending" ? checklist.pending : checklist.done;
  const counts: Record<Tab, number> = { pending: pendingCount, done: doneCount };

  // 浮层互斥：挂载广播自身 kind；收到别家 kind 立即自关
  useEffect(() => {
    notifySheetOpened("checklist");
    return onSheetOpened((kind) => {
      if (kind !== "checklist") onCloseRef.current();
    });
  }, []);

  // Esc 关闭
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  /** 左右方向键在 tab 间切换（tablist 的键盘约定），焦点跟随 */
  const moveTab = (next: Tab) => {
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <>
      <div className="proposal-overlay" onClick={onClose} aria-hidden="true" />
      <div
        className="proposal-sheet checklist-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="待办清单"
      >
        <div className="proposal-head">
          <div>
            <div className="t1">待办清单</div>
            <div className="t2">
              {/* 已完成数量已由 tab 承载，副标题只留「还剩多少 + 只读」一行，不换行 */}
              {pendingCount > 0 ? `还有 ${pendingCount} 项要处理` : "全部处理完了"}
              {" · 只读盘点，改状态在卡片上"}
            </div>
          </div>
          <button type="button" className="x" onClick={onClose} aria-label="关闭待办清单">
            ✕
          </button>
        </div>

        <div className="checklist-tabs" role="tablist" aria-label="待办清单分组">
          {TABS.map((key) => (
            <button
              key={key}
              ref={(node) => {
                tabRefs.current[key] = node;
              }}
              type="button"
              role="tab"
              id={`checklist-tab-${key}`}
              aria-selected={tab === key}
              aria-controls="checklist-panel"
              tabIndex={tab === key ? 0 : -1}
              className={`checklist-tab${tab === key ? " on" : ""}`}
              onClick={() => setTab(key)}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" && key === "done") {
                  event.preventDefault();
                  moveTab("pending");
                } else if (event.key === "ArrowRight" && key === "pending") {
                  event.preventDefault();
                  moveTab("done");
                }
              }}
            >
              {TAB_LABEL[key]}
              <span className="n">{counts[key]}</span>
            </button>
          ))}
        </div>

        <div
          className="checklist-body"
          id="checklist-panel"
          role="tabpanel"
          aria-labelledby={`checklist-tab-${tab}`}
        >
          {groups.length === 0 ? (
            <div className={`checklist-empty${tab === "done" ? " is-done" : ""}`}>
              <span className="checklist-empty-icon" aria-hidden="true">
                {tab === "pending" ? "🎉" : "🗒"}
              </span>
              <p className="checklist-empty-text">{EMPTY_TEXT[tab]}</p>
              <p className="checklist-empty-hint">
                {tab === "pending"
                  ? "门票、住宿与航班都有明确状态后，这里会空下来。"
                  : "买好门票、订好住宿、录入航班后，会归档到这里。"}
              </p>
            </div>
          ) : (
            groups.map((day) => (
              <section className="checklist-day" key={day.dayIndex} aria-label={`Day ${day.dayIndex}`}>
                <div className="checklist-day-head">
                  <span className="checklist-day-num">Day {day.dayIndex}</span>
                  <span className="checklist-day-date">
                    {shortDate(day.date)}
                    {weekdayLabel(day.date) !== "" ? ` ${weekdayLabel(day.date)}` : ""}
                  </span>
                  <span className="checklist-day-count">{dayCheckCount(day)} 项</span>
                </div>
                {CATEGORY_ORDER.map((category) => {
                  const items = day[CATEGORY_ITEMS_KEY[category]];
                  if (items.length === 0) return null;
                  const meta = CATEGORY_META[category];
                  return (
                    <div className="checklist-group" key={category}>
                      <div className="checklist-group-head">
                        <span className="checklist-icon" aria-hidden="true">
                          {meta.icon}
                        </span>
                        <span className="checklist-group-label">{meta.label}</span>
                        <span className="checklist-group-count">{items.length}</span>
                      </div>
                      <ul className="checklist-items">
                        {items.map((item: CheckItem) => (
                          <li className="checklist-item" key={item.id}>
                            <span className="checklist-item-name" title={item.name}>
                              {item.name}
                            </span>
                            <span className={`checklist-pill ${statusTone(item.status)}`}>
                              {item.statusLabel}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </section>
            ))
          )}
        </div>

        <div className="proposal-actions">
          <button type="button" className="cta" onClick={onClose}>
            知道了
          </button>
        </div>
      </div>
    </>
  );
}
