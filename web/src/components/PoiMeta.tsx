import { useState } from "react";
import { normalizePoiLevel } from "@goplay/shared";

/**
 * Task #330：飞猪 POI 元信息展示组件（poiLevel 徽标 / listRank 榜单 chip / description 折叠区）。
 *
 * 四处卡片共用（VisitCard 普通卡 + 大景区父卡、StopRow 岛内玩法行、CandidatePool 搜索结果卡、
 * NoteInput 快速搜索卡），保证展示口径与样式一致。三个组件在数据缺失 / 无法识别时一律返回
 * null——**完全不占位**（不产生空白行、不渲染 null 文本、不输出原始脏值），与「有则显示、
 * 无则不占位」的 PD 口径一致。
 */

/**
 * poiLevel → 4A/5A 徽标：与所在卡片的现有 tag（自定义 / AI 补充 / 免票）同排同尺寸。
 * variant="tag" 复用 .tag 体系（VisitCard / StopRow / CandidatePool）；
 * variant="quick" 复用 .quick-result-cat 体系（NoteInput 快速搜索卡，字号略大）。
 * 归一化交给 shared.normalizePoiLevel（兼容 "4"/"5"/"AAAA"/"AAAAA" 等形态）；
 * 无法识别的形态返回 null，绝不把原始脏值渲染到界面。
 */
export function PoiLevelTag({
  level,
  variant = "tag",
}: {
  level: string | null | undefined;
  variant?: "tag" | "quick";
}) {
  const label = normalizePoiLevel(level);
  if (label === null) return null;
  const base = variant === "quick" ? "quick-result-cat" : "tag";
  return (
    <span className={`${base} poi-level`} title={`飞猪景点等级 ${label}`}>
      {label}
    </span>
  );
}

/**
 * listRank → 名称下方独立一行暖色 chip（如「🏆 海南4A/5A景点榜第2名」）。
 * 有则显示、无则完全不占位（空 / null / 空白返回 null）；文本过长由 CSS 截断（title 保留全文），
 * 移动端不破版。根节点用 span（display:flex）以便安全嵌入 NoteInput 的 <button> 内。
 */
export function PoiRankChip({ rank }: { rank: string | null | undefined }) {
  if (typeof rank !== "string" || rank.trim() === "") return null;
  const text = rank.trim();
  return (
    <span className="poi-rank" title={text}>
      <span className="poi-rank-icon" aria-hidden="true">
        🏆
      </span>
      <span className="poi-rank-text">{text}</span>
    </span>
  );
}

/**
 * description → 卡片底部「介绍 ▾」弱入口折叠区：默认收起，点击展开全文，可再次收起。
 * 长文本绝不默认展开；空 / 缺失时整个入口不出现（返回 null）。仅用于 VisitCard（div 容器，
 * 无嵌套 button 问题）——搜索结果行是 <button>，不放置本组件。
 */
export function PoiDescription({ text }: { text: string | null | undefined }) {
  const [open, setOpen] = useState(false);
  if (typeof text !== "string" || text.trim() === "") return null;
  return (
    <div className="poi-desc">
      <button
        type="button"
        className="poi-desc-toggle"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span>介绍</span>
        <span className="poi-desc-arrow" aria-hidden="true">
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open ? <div className="poi-desc-body">{text.trim()}</div> : null}
    </div>
  );
}
