import { useEffect, useRef, useState } from "react";
import type { Trip } from "@goplay/shared";
import { shortDate } from "../lib/format";
import { copyText, isShareCancelled, memoExcerpt, shareUrlFor } from "../lib/share";
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
   * 降级复制链接（Task #264）：只写剪贴板，不唤起系统面板。
   * 独立菜单项已移除——链接能力收进「分享行程」的降级分支，菜单不再重复提供。
   */
  const copyShareUrl = () => {
    void copyText(shareUrl)
      .then(() => showShareNotice("链接已复制"))
      .catch(() => showShareNotice("复制失败，请手动复制", "error"));
  };

  /**
   * 分享行程（Task #205 / Task #264）：稳定链接 /share/:tripId，始终展示最新行程。
   * 菜单只保留这一个入口，不再单列「复制链接」：
   * - 有 Web Share API（移动端 Safari / Chrome）→ 系统面板，标题 / 摘要 / 链接一并带走，
   *   成功后不再额外提示（面板本身已完成分享动作）；
   * - 用户取消（AbortError）→ 静默返回，既不提示成功也不降级复制；
   * - 不支持 Web Share（桌面浏览器 / 非 HTTPS）或系统面板调用失败（非取消）→
   *   降级为复制链接 + 「链接已复制」，保证用户仍能拿到可分享的地址。
   */
  const shareTrip = () => {
    setMenuOpen(false);
    if (typeof navigator === "undefined" || typeof navigator.share !== "function") {
      copyShareUrl();
      return;
    }
    void navigator
      .share({
        title: shareTitle,
        text: shareText,
        ...(shareUrl !== "" ? { url: shareUrl } : {}),
      })
      .catch((error: unknown) => {
        if (isShareCancelled(error)) return;
        copyShareUrl();
      });
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
                  <small>发给朋友，不支持分享时自动复制链接</small>
                </button>
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
