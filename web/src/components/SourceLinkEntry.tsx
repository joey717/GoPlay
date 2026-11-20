/**
 * 任务 124：灰色「查看攻略原文」入口的统一实现（VisitCard / StopRow 共用）。
 *
 * 语义：只负责打开用户导入的外部原链，与绿色 snippet 亮点（打开 EvidenceSheet
 * 定位提炼片段）彻底分离。
 * - 单一来源：入口渲染为语义 <a>，直接新标签页打开（noopener noreferrer）；
 * - 多来源：点击弹出极简来源列表，只列来源标题与「打开原文」，不展示任何
 *   AI 提炼内容，也不复用 EvidenceSheet（避免把「看原链」误做成「看证据」）；
 * - 无外部链接：resolveEntitySourceLinks 返回空，调用方不渲染本入口。
 *
 * 浮层互斥：来源列表用固定定位挂视口层（父卡 overflow:hidden 会裁剪 absolute
 * 浮层），层级与购票菜单同档（51，高于 .sheet 9）；除遮罩点击关闭外，还订阅
 * sheetBus——任一底部浮层（攻略原文 / 近期操作）打开时立即让位关闭，
 * 保证不会叠在 Sheet 上方。
 */

import { useEffect, useRef, useState } from "react";
import type { EntitySourceLink } from "../lib/sourceLinks";
import { onSheetOpened } from "../lib/sheetBus";

interface SourceLinkEntryProps {
  /** 目标实体解析出的外部原文链接（空数组由调用方不渲染，此处仅兜底） */
  links: EntitySourceLink[];
  /** 入口样式类（沿用各卡位现有入口类：guide-quote-link / evidence-link / child-evidence） */
  className: string;
  /** 入口文案（「查看攻略原文」/「查看攻略原文 ›」） */
  label: string;
}

/** 极简来源列表宽度与行高估算（视口内收敛定位用，与购票菜单同手法） */
const MENU_WIDTH = 248;
const MENU_ROW_HEIGHT = 38;

export default function SourceLinkEntry({ links, className, label }: SourceLinkEntryProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // 任一底部浮层打开时让位关闭（含 EvidenceSheet / OpLogSheet），防止同屏叠层
  useEffect(
    () =>
      onSheetOpened(() => {
        setMenuOpen(false);
      }),
    [],
  );

  if (links.length === 0) return null;

  // 单一来源：入口即链接，原生新标签页打开外部原链
  if (links.length === 1) {
    const link = links[0]!;
    return (
      <a className={className} href={link.url} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    );
  }

  /** 多来源菜单打开：按触发钮位置计算 fixed 定位，向视口内收敛（同购票菜单） */
  const openMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const menuHeight = links.length * MENU_ROW_HEIGHT + 8;
      const left = Math.min(Math.max(8, rect.right - MENU_WIDTH), window.innerWidth - MENU_WIDTH - 8);
      const top =
        window.innerHeight - rect.bottom >= menuHeight + 12
          ? rect.bottom + 6
          : Math.max(8, rect.top - menuHeight - 6);
      setMenuPos({ top, left });
    }
    setMenuOpen(true);
  };

  return (
    <>
      <button ref={triggerRef} type="button" className={className} onClick={openMenu}>
        {label}
      </button>
      {menuOpen ? (
        <>
          <div
            className="purchase-menu-overlay"
            onClick={() => setMenuOpen(false)}
            aria-hidden="true"
          />
          <div
            className="source-menu"
            role="menu"
            aria-label="攻略原文来源"
            style={{ top: menuPos.top, left: menuPos.left }}
          >
            {links.map((link) => (
              <div className="source-menu-item" key={link.sourceId}>
                <span className="source-menu-title" title={link.title}>
                  {link.title}
                </span>
                <a
                  className="source-menu-open"
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setMenuOpen(false)}
                >
                  打开原文
                </a>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}
