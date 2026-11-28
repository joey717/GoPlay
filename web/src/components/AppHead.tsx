import { useEffect, useRef, useState } from "react";
import type { Trip } from "@goplay/shared";
import { shortDate } from "../lib/format";
import { canNativeShare, copyText, isShareCancelled, memoExcerpt, prefersNativeShare, shareUrlFor } from "../lib/share";
import { tripCoverInfo } from "../lib/tripCover";
import { dayVisits, orderedDays } from "../lib/trip";
import { ConfirmDialog } from "./ConfirmDialog";

interface AppHeadProps {
  trip: Trip;
  /** 近期操作 Sheet 入口（交互优化 Module A：从 chips 收敛进右上 ⋯ 菜单） */
  onOpenOpLog: () => void;
  /** 约束编辑入口（Task #206：从 ⋯ 菜单打开「修改约束」浮层） */
  onEditConstraints: () => void;
  /** 待办清单入口（Task #265：从 ⋯ 菜单打开门票 / 住宿 / 航班的盘点浮层） */
  onOpenChecklist: () => void;
  /**
   * 新建行程（Task #66）：由上层完成「删除服务端行程（含截图）→ 清本地缓存 → 回到初始化」，
   * 成功返回 true；失败（删除接口报错）返回 false，由本组件提示重试且不清任何本地状态。
   */
  onNewTrip: () => Promise<boolean>;
}

/**
 * 行程标题栏（交互优化 Module A）：标题由目的地与日期派生（`${城市} · N 天 N 晚`）。
 * 原 chips 统计行（点位/候选池/约束/已购票/新建行程）收敛为一行灰字状态
 * 「已排 X/Y 天 · 航班已确定 · 攻略素材 N 篇」；「新建行程」「近期操作」
 * 「待办清单」「修改约束」收进右上 ⋯ 菜单（点击外部关闭），新建行程仍走二次确认弹窗。
 */
export default function AppHead({
  trip,
  onOpenOpLog,
  onOpenChecklist,
  onEditConstraints,
  onNewTrip,
}: AppHeadProps) {
  const days = orderedDays(trip);
  const title = `${trip.destination.city} · ${days.length} 天 ${trip.dateRange.nights} 晚`;
  /** 状态行 X：有景点的天数（Y = days.length） */
  const scheduledDays = days.filter((day) => dayVisits(trip, day).length > 0).length;
  /** 状态行「航班已确定」：存在任一航班约束（去程 / 回程）即展示该段 */
  const hasFlight = trip.constraints.some(
    (constraint) => constraint.type === "flight_arrive" || constraint.type === "flight_depart",
  );
  /** 攻略素材篇数（active 来源；老 Trip 无 guideSources 视为 0） */
  const guideCount = Object.values(trip.guideSources ?? {}).filter((source) => source.active)
    .length;

  /** ⋯ 菜单展开态（点击外部关闭） */
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  /** 新建行程：确认弹窗 / 删除中 / 删除失败提示 */
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const errorTimerRef = useRef<number | null>(null);
  /** Task #205 分享行程：轻量提示（降级复制成功 / 失败两种语气） */
  const [shareNotice, setShareNotice] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
  const shareTimerRef = useRef<number | null>(null);
  /** Task #401 分享小面板（移动端：复制链接为主 + 系统分享为辅；复制失败时也用它展示 URL） */
  const [sharePanelOpen, setSharePanelOpen] = useState(false);
  const sharePanelRef = useRef<HTMLDivElement | null>(null);

  useEffect(
    () => () => {
      if (errorTimerRef.current !== null) window.clearTimeout(errorTimerRef.current);
      if (shareTimerRef.current !== null) window.clearTimeout(shareTimerRef.current);
    },
    [],
  );

  // ⋯ 菜单点击外部关闭：mousedown 落在菜单区域外即收起
  useEffect(() => {
    if (!menuOpen) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (menuRef.current !== null && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [menuOpen]);

  /**
   * 分享面板关闭途径（Task #401）：同 ⋯ 菜单的习惯——点面板外 / 按 Esc 收起。
   * 面板锚在 ⋯ 按钮下方，点 ⋯ 本身由「外部点击」处理（随后 click 再开菜单）。
   */
  useEffect(() => {
    if (!sharePanelOpen) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (sharePanelRef.current !== null && !sharePanelRef.current.contains(event.target as Node)) {
        setSharePanelOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSharePanelOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [sharePanelOpen]);

  const showDeleteError = () => {
    setDeleteError("删除失败，请重试");
    if (errorTimerRef.current !== null) window.clearTimeout(errorTimerRef.current);
    errorTimerRef.current = window.setTimeout(() => setDeleteError(null), 4000);
  };

  const showShareNotice = (text: string, tone: "ok" | "error" = "ok") => {
    setShareNotice({ text, tone });
    if (shareTimerRef.current !== null) window.clearTimeout(shareTimerRef.current);
    shareTimerRef.current = window.setTimeout(() => setShareNotice(null), 3000);
  };

  /**
   * 分享文案（Task #261）：标题 / 正文 / 链接三者都从 Trip 派生。
   * - 标题：行程名；未命名时用「城市 N天行程」（分享给朋友，不展示只对主人有意义的「我的行程」）；
   * - 正文：备忘压成单行摘要（前 100 字）；无备忘时用「城市 · N天N晚 · 日期区间」。
   */
  const coverInfo = tripCoverInfo(trip, `${trip.destination.city}行程`);
  const shareTitle = coverInfo.isDefaultName
    ? `${coverInfo.cityLabel}${coverInfo.dayCount > 0 ? ` ${coverInfo.dayCount}天` : ""}行程`.trim()
    : coverInfo.tripName;
  const shareText = coverInfo.hasMemo ? memoExcerpt(coverInfo.memo) : coverInfo.metaLine;
  const shareUrl = shareUrlFor(trip.tripId);

  /**
   * 复制只读链接（Task #401）：桌面端的默认动作，只写剪贴板，不唤起任何系统面板。
   * - 成功 → 收起分享面板 + 「链接已复制」；
   * - 失败（权限被拒且回退也失效）→ 打开小面板并提示手动复制（面板里是可全选的 URL）。
   */
  const copyShareUrl = () => {
    void copyText(shareUrl)
      .then(() => {
        setSharePanelOpen(false);
        showShareNotice("链接已复制");
      })
      .catch(() => {
        setSharePanelOpen(true);
        showShareNotice("复制失败，请手动复制链接", "error");
      });
  };

  /**
   * 系统分享（Task #401 次通道，仅触屏设备有意义）：标题 / 摘要 / 链接一并带走。
   * 用户取消（AbortError）静默返回；其余失败退回复制链接，保证总能拿到地址。
   */
  const shareViaSystem = () => {
    if (!canNativeShare()) {
      copyShareUrl();
      return;
    }
    void navigator
      .share({
        title: shareTitle,
        text: shareText,
        ...(shareUrl !== "" ? { url: shareUrl } : {}),
      })
      .then(() => setSharePanelOpen(false))
      .catch((error: unknown) => {
        if (isShareCancelled(error)) return;
        copyShareUrl();
      });
  };

  /**
   * 分享行程（Task #401 修正）：
   * - 桌面（含 macOS Safari / Chrome 等「有 navigator.share 但只会弹系统面板」）→
   *   直接复制 `${origin}/share/${tripId}` + 「链接已复制」，不再一上来弹系统面板；
   * - 触屏设备且有 Web Share → 打开小面板，「复制链接」为主按钮、系统分享为辅；
   * - 触屏但无 Web Share → 同样直接复制。
   */
  const shareTrip = () => {
    setMenuOpen(false);
    if (!prefersNativeShare()) {
      copyShareUrl();
      return;
    }
    setSharePanelOpen(true);
  };

  /** 确认新建：先关闭弹窗再执行删除；失败仅提示，不清理本地状态 */
  const confirmNewTrip = () => {
    setConfirmOpen(false);
    setDeleting(true);
    void onNewTrip()
      .then((succeeded) => {
        if (!succeeded) showDeleteError();
      })
      .catch(() => showDeleteError())
      .finally(() => setDeleting(false));
  };

  return (
    <header className="apphead">
      <div className="row1">
        <div className="name">{title}</div>
        <div className="head-right">
          <span className="ver">
            {trip.dateRange.start} → {shortDate(trip.dateRange.end)}
          </span>
          <div className="more-wrap" ref={menuRef}>
            <button
              type="button"
              className="head-more"
              aria-label="更多操作"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              ⋯
            </button>
            {menuOpen ? (
              <div className="head-menu" role="menu">
                <button
                  type="button"
                  className="head-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setConfirmOpen(true);
                  }}
                >
                  新建行程
                  <small>删除当前行程重新开始</small>
                </button>
                <button
                  type="button"
                  className="head-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenOpLog();
                  }}
                >
                  近期操作
                  <small>查看最近的改动记录</small>
                </button>
                <button
                  type="button"
                  className="head-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenChecklist();
                  }}
                >
                  待办清单
                  <small>门票 / 住宿 / 航班按天盘点</small>
                </button>
                <button
                  type="button"
                  className="head-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onEditConstraints();
                  }}
                >
                  修改约束
                  <small>航班、入住、退房等已定安排</small>
                </button>
                <button type="button" className="head-menu-item" role="menuitem" onClick={shareTrip}>
                  分享行程
                  <small>{prefersNativeShare() ? "复制链接或系统分享" : "复制只读链接，粘贴即可查看"}</small>
                </button>
              </div>
            ) : null}
            {sharePanelOpen ? (
              <div className="share-panel" role="dialog" aria-label="分享行程" ref={sharePanelRef}>
                <div className="share-panel-head">
                  <span className="share-panel-title">分享只读链接</span>
                  <button
                    type="button"
                    className="share-panel-close"
                    aria-label="关闭分享面板"
                    onClick={() => setSharePanelOpen(false)}
                  >
                    ×
                  </button>
                </div>
                <input
                  className="share-url"
                  type="text"
                  readOnly
                  aria-label="只读分享链接"
                  value={shareUrl}
                  onFocus={(event) => event.currentTarget.select()}
                  onClick={(event) => event.currentTarget.select()}
                />
                <p className="share-panel-hint">朋友打开即只读浏览，不会改到你的行程。</p>
                <div className="share-panel-actions">
                  <button type="button" className="share-action is-primary" onClick={copyShareUrl}>
                    复制链接
                  </button>
                  {canNativeShare() ? (
                    <button type="button" className="share-action" onClick={shareViaSystem}>
                      系统分享…
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <div className="app-meta">已排 {scheduledDays}/{days.length} 天{hasFlight ? " · 航班已确定" : ""} · 攻略素材 {guideCount} 篇</div>
      {shareNotice !== null ? (
        <div
          className={shareNotice.tone === "error" ? "share-toast is-error" : "share-toast"}
          role={shareNotice.tone === "error" ? "alert" : "status"}
        >
          {shareNotice.text}
        </div>
      ) : null}
      {deleteError ? (
        <div className="new-trip-error" role="alert">
          {deleteError}
        </div>
      ) : null}
      {confirmOpen ? (
        <ConfirmDialog
          title="新建行程"
          description="当前行程和攻略截图将被删除，确定要重新开始吗？"
          confirmText="确定新建"
          cancelText="取消"
          danger
          onConfirm={confirmNewTrip}
          onCancel={() => setConfirmOpen(false)}
        />
      ) : null}
    </header>
  );
}
