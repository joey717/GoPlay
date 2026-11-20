import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { notifySheetOpened, onSheetOpened } from "../lib/sheetBus";

interface PoiIntroSheetProps {
  /** 点位名称（副标题用） */
  name: string;
  /** 介绍正文（复用 .poi-desc-body 样式；空白文本时整层不渲染——空浮层守卫） */
  text: string;
  /** 来源：fliggy → 副标题标注「介绍来自飞猪」；custom → 省略来源后半 */
  origin?: "fliggy" | "custom" | null;
  onClose: () => void;
}

/**
 * 景点介绍应用内浮层（Task #372）：无购票通道 / 免费入场且有介绍文本的点位，
 * 主按钮由「去购票」降级为「查看介绍」，点击打开本浮层（不跳飞猪外链）。
 *
 * 骨架复刻 EvidenceSheet（A 族 .backdrop/.sheet，z-index 8/9，以 .app 为包含块）：
 * - anchorRef.closest(".app") + createPortal：调用处可能在 positioned 卡片内，
 *   直接渲染会把 absolute Sheet 限制在卡片内，故 portal 到 .app 根；
 * - 挂载即广播 notifySheetOpened("poiIntro")，收到非自身 kind 时自关（浮层互斥总线）；
 * - Esc + 遮罩点击关闭（EvidenceSheet 无 Esc，本浮层按 #372 规格自加 keydown）。
 *
 * 正文**复用 .poi-desc-body 样式类，不嵌 PoiDescription 组件**——保 verify-task330
 * 对 PoiDescription 折叠区的断言与 #356 可逆性（介绍区块组件与样式仍保留备用）。
 */
export default function PoiIntroSheet({ name, text, origin = null, onClose }: PoiIntroSheetProps) {
  // portal 宿主：.app 根（paint 前定位，避免首帧闪烁）
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const host = anchorRef.current?.closest(".app");
    setPortalHost(host instanceof HTMLElement ? host : null);
  }, []);

  // 浮层互斥：挂载即广播本 Sheet 打开，其他浮层打开时本 Sheet 让位关闭。onClose 走 ref 只订阅一次。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    notifySheetOpened("poiIntro");
    return onSheetOpened((kind) => {
      if (kind !== "poiIntro") onCloseRef.current();
    });
  }, []);

  // Esc 关闭（keydown 走 ref，避免 onClose 变化重订阅）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // 空浮层守卫：全部 hooks 之后的 early return（合法，不违反 Rules of Hooks）——
  // 介绍文本为空白时整层不渲染（shouldShowIntroEntry 已守卫，此为二重保险）。
  const body = text.trim();
  if (body === "") return null;

  const subtitle = origin === "custom" ? name : `${name} · 介绍来自飞猪`;

  const content = (
    <>
      <div className="backdrop on" onClick={onClose} aria-hidden="true" />
      <div className="sheet on" role="dialog" aria-modal="true" aria-label="景点介绍">
        <div className="sh">
          <div>
            <div className="st1">景点介绍</div>
            <div className="st2">{subtitle}</div>
          </div>
          <button type="button" className="x" onClick={onClose} aria-label="关闭景点介绍">
            ×
          </button>
        </div>
        <div className="sb">
          <div className="poi-desc-body">{body}</div>
        </div>
      </div>
    </>
  );

  return (
    <>
      {/* 定位锚点：渲染在调用处（可能位于 positioned 卡片内），据此把内容 portal 到 .app 根 */}
      <div ref={anchorRef} aria-hidden="true" style={{ display: "none" }} />
      {portalHost !== null ? createPortal(content, portalHost) : content}
    </>
  );
}
