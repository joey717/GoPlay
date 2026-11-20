import { useEffect } from "react";
import type { OpLogEntry, OpLogKind } from "../lib/opLog";
import { notifySheetOpened } from "../lib/sheetBus";

interface OpLogSheetProps {
  entries: OpLogEntry[];
  onClose: () => void;
  onClear: () => void;
}

/** 操作类型的展示文案与配色（k-* 对应 styles.css 中的标签色） */
const KIND_META: Record<OpLogKind, { label: string; tone: string }> = {
  add: { label: "加入", tone: "k-sage" },
  remove: { label: "单项移除", tone: "k-warn" },
  "batch-remove": { label: "批量移除", tone: "k-warn" },
  undo: { label: "撤销", tone: "k-sage" },
  reorder: { label: "拖拽改序", tone: "k-slate" },
  transfer: { label: "转移", tone: "k-slate" },
  lock: { label: "锁定", tone: "k-lock" },
  purchase: { label: "购买状态", tone: "k-clay" },
};

/** ISO 时间 → 当日 HH:mm */
function formatLogTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * M2 F12 近期操作记录 Sheet：本会话最近 20 条操作的时间/类型/点位名（或数量）。
 * 仅作记录展示，不提供时间旅行或任意回滚；清空后不可恢复。
 *
 * Task #109 互斥改造：由 TripView 条件渲染（挂载即打开，关闭即卸载，DOM 中
 * 不再有常驻的关闭态 Sheet），替代旧的 open 常驻 + class 切换——后者曾与
 * portal 挂载的攻略原文 Sheet 叠层（见 ../lib/sheetBus 说明）。挂载时广播
 * "oplog" 打开事件，让已打开的攻略原文 Sheet 让位关闭。
 */
export default function OpLogSheet({ entries, onClose, onClear }: OpLogSheetProps) {
  useEffect(() => {
    notifySheetOpened("oplog");
  }, []);

  return (
    <>
      <div className="backdrop on" onClick={onClose} aria-hidden="true" />
      <div className="sheet on" role="dialog" aria-modal="true" aria-label="近期操作">
        <div className="sh">
          <div>
            <div className="st1">近期操作</div>
            <div className="st2">
              本会话的编辑记录，仅作回顾，不提供回滚；刷新后保留，关闭页面后清空。
            </div>
          </div>
          <button type="button" className="x" onClick={onClose} aria-label="关闭近期操作">
            ✕
          </button>
        </div>

        <div className="sb">
          {entries.length === 0 ? (
            <div className="pool-empty">还没有操作记录。移动、移除、锁定等改动会记在这里。</div>
          ) : (
            <div className="oplog-list">
              {entries.map((entry) => {
                const meta = KIND_META[entry.kind];
                return (
                  <div className="oplog-item" key={entry.id}>
                    <span className={`oplog-kind ${meta.tone}`}>{meta.label}</span>
                    <div className="oplog-main">
                      <div className="oplog-label">{entry.label}</div>
                      {entry.detail ? <div className="oplog-detail">{entry.detail}</div> : null}
                    </div>
                    <span className="oplog-time">{formatLogTime(entry.time)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {entries.length > 0 ? (
          <div className="oplog-foot">
            <button type="button" className="mini danger" onClick={onClear}>
              清空记录
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}
