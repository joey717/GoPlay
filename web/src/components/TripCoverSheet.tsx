import { useCallback, useEffect, useRef, useState } from "react";
import type { TripCoverInfo, TripCoverPatch } from "../lib/tripCover";
import { MEMO_MAX, TRIP_NAME_MAX, coverImageUrl, normalizeTripName } from "../lib/tripCover";
import { notifySheetOpened, onSheetOpened } from "../lib/sheetBus";

/** 名称 / 备忘的编辑落库防抖（失焦立即落地，输入中 1s 静默后落地） */
const SAVE_DEBOUNCE_MS = 1000;
/** 与服务端 COVER_MAX_BYTES 对齐（8MB）：选图时先拦下，不发无谓请求 */
const COVER_MAX_BYTES = 8 * 1024 * 1024;
const COVER_ACCEPT = "image/jpeg,image/png,image/webp";
const MEMO_PLACEHOLDER = "记下想提醒自己的事：证件、预约、带娃节奏…";

interface TripCoverSheetProps {
  /** tripCoverInfo() 推导出的展示数据（Trip / SharedTrip 共用） */
  info: TripCoverInfo;
  /** 只读（分享访客）：隐藏上传、改名、备忘输入与全部编辑入口 */
  readOnly?: boolean;
  /** 封面上传中（父层持有，避免重复选图） */
  uploading?: boolean;
  /** 上传 / 保存失败提示（父层透传） */
  error?: string | null;
  /** 本地封面版本（父层每次上传成功后 +1），用于击穿浏览器缓存 */
  revision?: number;
  /**
   * 名称 / 备忘的变更补丁。父层走 store.updateTrip → 既有 1s 防抖 PUT，
   * 本组件不直接发请求（与行程其他字段的保存链路保持一致）。
   */
  onChange?: (patch: TripCoverPatch) => void;
  /** 用户选好封面图（父层调 uploadTripCover 并写回 coverImage） */
  onUploadCover?: (file: File) => void;
  /** 移除封面（父层调 deleteTripCover 并清空 coverImage） */
  onRemoveCover?: () => void;
  /** 关闭浮层（关闭前会冲刷未落地的编辑，避免「打完字立刻关」丢改动） */
  onClose: () => void;
}

/**
 * 行程封面浮层（Task #258，取代 Task #257 的顶部内嵌封面卡）。
 *
 * 为什么收进浮层：内嵌封面卡（16:9 图 + 三日信息 + 备忘预览）常年占掉首屏
 * 一百多像素，Day 标签与当天内容被挤到折叠线以下。改为「紧凑入口 + 浮层」后，
 * 行程页顶部只剩 TripCoverBar 一行，封面/名称/备忘按需展开。
 *
 * 编辑模式（行程主人）
 * - 封面：点击图片区或「添加 / 更换封面」选图（JPG/PNG/WebP，≤8MB），可一键移除；
 *   无封面时渲染 CSS 渐变兜底，不引入任何外部图片资源；
 * - 名称：点标题进入行内编辑，失焦 / 回车落地（50 字上限）；
 * - 信息行：城市 · N天N晚 · 起止日期，全部由 Trip.days / destination 推导；
 * - 备忘：浮层空间足够，默认就是 textarea（500 字上限），输入 1s 静默或失焦即保存。
 *
 * 只读模式（分享访客）：没有输入框、上传入口与移除按钮，备忘直接展示全文。
 *
 * 浮层互斥（sheetBus）：挂载即广播 "cover"，近期操作 / 约束编辑 / 攻略原文让位；
 * 反向收到别家 kind 时自关，保证任意时刻至多一个浮层可见。
 */
export default function TripCoverSheet({
  info,
  readOnly = false,
  uploading = false,
  error = null,
  revision = 0,
  onChange,
  onUploadCover,
  onRemoveCover,
  onClose,
}: TripCoverSheetProps) {
  /** 名称 / 备忘的本地草稿（null = 未改动，直接展示 info） */
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [memoDraft, setMemoDraft] = useState<string | null>(null);
  const [nameEditing, setNameEditing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** 待落地补丁（同一轮防抖内多字段合并）与定时器 */
  const pendingRef = useRef<TripCoverPatch | null>(null);
  const timerRef = useRef<number | null>(null);
  /** 始终指向最新 onChange / onClose，避免定时器闭包拿到过期回调 */
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  /** 上一次的 props 值：仅在 Trip 真的刷新（保存成功 / 外部刷新）时清草稿 */
  const lastPropNameRef = useRef(info.tripName);
  const lastPropMemoRef = useRef(info.memo);

  /** 立即落地待保存补丁（失焦 / 关闭 / 卸载时调用） */
  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const patch = pendingRef.current;
    pendingRef.current = null;
    if (patch !== null) onChangeRef.current?.(patch);
  }, []);

  /** 排队一次保存：1s 内继续输入则重新计时（字段合并，避免相互覆盖） */
  const queueSave = useCallback((patch: TripCoverPatch) => {
    pendingRef.current = { ...(pendingRef.current ?? {}), ...patch };
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending !== null) onChangeRef.current?.(pending);
    }, SAVE_DEBOUNCE_MS);
  }, []);

  // 卸载时把未落地的编辑冲刷掉，避免「打完字立刻离开」丢改动
  useEffect(() => flush, [flush]);

  // 浮层互斥：挂载即广播 "cover"，其余底部浮层让位；收到别家 kind 时自关
  useEffect(() => {
    notifySheetOpened("cover");
    return onSheetOpened((kind) => {
      if (kind !== "cover") onCloseRef.current();
    });
  }, []);

  // Esc 关闭（改名输入框内自己处理 Esc = 取消改名，见 onKeyDown）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || nameEditing) return;
      flush();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [flush, nameEditing]);

  // Trip 侧名称 / 备忘变化（保存落地或外部刷新）→ 丢弃本地草稿，回到 props 为准
  useEffect(() => {
    if (lastPropNameRef.current !== info.tripName) {
      lastPropNameRef.current = info.tripName;
      setNameDraft(null);
    }
  }, [info.tripName]);
  useEffect(() => {
    if (lastPropMemoRef.current !== info.memo) {
      lastPropMemoRef.current = info.memo;
      setMemoDraft(null);
    }
  }, [info.memo]);

  // 进入改名态：聚焦并全选，方便直接覆盖默认名
  useEffect(() => {
    if (!nameEditing) return;
    nameInputRef.current?.focus();
    nameInputRef.current?.select();
  }, [nameEditing]);

  const displayName = nameDraft ?? info.tripName;
  const displayMemo = memoDraft ?? info.memo;
  const memoChars = Array.from(displayMemo).length;
  const coverSrc = coverImageUrl(
    info.coverImage,
    revision > 0 ? `${info.coverVersion}-${revision}` : info.coverVersion,
  );
  const notice = localError ?? error;
  const canPickCover = !readOnly && !uploading;

  /** 关闭浮层：先把防抖窗口里的编辑冲刷掉，再交给父层卸载 */
  const close = () => {
    flush();
    onCloseRef.current();
  };

  const startNameEditing = () => {
    if (readOnly) return;
    setNameDraft(info.isDefaultName ? "" : info.tripName);
    setNameEditing(true);
  };

  /** 结束改名：归一后落地（空串 = 清除名称，展示回默认名） */
  const commitName = () => {
    if (!nameEditing) return;
    setNameEditing(false);
    const next = normalizeTripName(nameDraft ?? "");
    // 归一后的结果回写草稿：标题立即按「单空格 / 去首尾空白」展示；
    // 清空则丢掉草稿，回落到 info.tripName（父层刷新后即默认名）
    setNameDraft(next === "" ? null : next);
    queueSave({ tripName: next });
    flush();
  };

  const cancelNameEditing = () => {
    setNameEditing(false);
    setNameDraft(null);
    // 取消编辑：丢弃本轮尚未落地的补丁（否则 1s 后仍会把草稿写完）
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
  };

  const pickCover = () => {
    if (!canPickCover) return;
    setLocalError(null);
    fileInputRef.current?.click();
  };

  const handleFile = (file: File | undefined) => {
    if (file === undefined) return;
    if (!/^image\/(jpeg|png|webp)$/u.test(file.type)) {
      setLocalError("请选择 JPG / PNG / WebP 图片");
      return;
    }
    if (file.size > COVER_MAX_BYTES) {
      setLocalError("图片不能超过 8MB");
      return;
    }
    setLocalError(null);
    onUploadCover?.(file);
  };

  return (
    <>
      <div className="proposal-overlay" onClick={close} aria-hidden="true" />
      <div
        className="proposal-sheet trip-cover-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="行程封面"
      >
        <div className="proposal-head">
          <div>
            <div className="t1">{readOnly ? "行程封面" : "行程封面与备忘"}</div>
            <div className="t2">
              {readOnly ? "朋友分享的行程 · 只读展示" : "改完自动保存，关闭后回到行程"}
            </div>
          </div>
          <button type="button" className="x" onClick={close} aria-label="关闭封面">
            ✕
          </button>
        </div>

        <div
          className={`trip-cover-media${canPickCover ? " is-editable" : ""}${coverSrc === null ? " is-fallback" : ""}`}
          onClick={canPickCover ? pickCover : undefined}
          title={canPickCover ? (coverSrc === null ? "点击添加封面" : "点击更换封面") : undefined}
        >
          {coverSrc !== null ? (
            <>
              {/* Task #377：底层同图模糊放大，填充 contain 完整显示时非 16:9 源图的留白，
                  避免竖图两侧出现平板色块（业界「完整显示不裁切」标准处理）。装饰性，alt="" */}
              <img
                className="trip-cover-blur"
                src={coverSrc}
                alt=""
                aria-hidden="true"
                decoding="async"
              />
              {/* 主图 object-fit:contain —— 任何比例源图都完整可见，不再被 16:9 盒子裁掉上下 */}
              <img className="trip-cover-img" src={coverSrc} alt={info.tripName} decoding="async" />
            </>
          ) : (
            <div className="trip-cover-wash" aria-hidden="true" />
          )}
          <div className="trip-cover-scrim" aria-hidden="true" />
          <div className="trip-cover-kicker">{readOnly ? "朋友分享的行程" : "本次行程"}</div>

          {!readOnly ? (
            <div className="trip-cover-tools" onClick={(event) => event.stopPropagation()}>
              {uploading ? (
                <span className="trip-cover-tool is-busy" role="status">
                  上传中…
                </span>
              ) : (
                <>
                  <button type="button" className="trip-cover-tool" onClick={pickCover}>
                    {coverSrc === null ? "添加封面" : "更换封面"}
                  </button>
                  {coverSrc !== null ? (
                    <button type="button" className="trip-cover-tool" onClick={() => onRemoveCover?.()}>
                      移除封面
                    </button>
                  ) : null}
                </>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept={COVER_ACCEPT}
                className="trip-cover-file"
                aria-label="选择封面图片"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  // 清空 value：连续选择同一张图也能再次触发 change
                  event.target.value = "";
                  handleFile(file);
                }}
              />
            </div>
          ) : null}

        </div>

        {notice !== null ? (
          <p className="trip-cover-error" role="alert">
            {notice}
          </p>
        ) : null}

        <div className="trip-cover-body">
          {nameEditing && !readOnly ? (
            <input
              ref={nameInputRef}
              className="trip-cover-name-input"
              aria-label="行程名称"
              value={nameDraft ?? ""}
              maxLength={TRIP_NAME_MAX}
              placeholder={info.tripName}
              onChange={(event) => {
                setNameDraft(event.target.value);
                queueSave({ tripName: event.target.value });
              }}
              onBlur={commitName}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitName();
                } else if (event.key === "Escape") {
                  // 改名态 Esc 只取消本次改名，不关闭浮层
                  event.preventDefault();
                  event.stopPropagation();
                  cancelNameEditing();
                }
              }}
            />
          ) : readOnly ? (
            <h1 className="trip-cover-title">{displayName}</h1>
          ) : (
            <button
              type="button"
              className="trip-cover-title as-button"
              aria-label={`行程名称：${displayName}，点击修改`}
              title="点击修改行程名称"
              onClick={startNameEditing}
            >
              {displayName}
              <span className="trip-cover-pen" aria-hidden="true">
                ✎
              </span>
            </button>
          )}

          {info.metaLine !== "" ? <p className="trip-cover-meta">{info.metaLine}</p> : null}

          <div className="trip-cover-memo">
            <div className="trip-cover-memo-head">
              <span className="trip-cover-memo-label">备忘</span>
              {!readOnly ? (
                <span className="trip-cover-memo-count">
                  {memoChars}/{MEMO_MAX}
                </span>
              ) : null}
            </div>
            {readOnly ? (
              <p className="trip-cover-memo-body is-open">{info.hasMemo ? displayMemo : "没有写备忘"}</p>
            ) : (
              <textarea
                className="trip-cover-memo-input"
                aria-label="备忘录"
                value={displayMemo}
                maxLength={MEMO_MAX}
                rows={4}
                placeholder={MEMO_PLACEHOLDER}
                onChange={(event) => {
                  setMemoDraft(event.target.value);
                  queueSave({ memo: event.target.value });
                }}
                onBlur={flush}
              />
            )}
          </div>
          {!readOnly ? <p className="trip-cover-hint">行程名称与备忘会自动保存</p> : null}
        </div>

        {!readOnly ? (
          <div className="proposal-actions">
            <button type="button" className="cta" onClick={close}>
              完成
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}
