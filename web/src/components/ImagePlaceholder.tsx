import type { ReactElement } from "react";
import {
  classifyPlace,
  shortPlaceLabel,
  type PlaceCategoryKey,
} from "../lib/placeCategory";

interface ImagePlaceholderProps {
  /** 完整点位名：aria-label / title 保留全文，画面上只展示精简短名 */
  name: string;
  /** 主数据类别文本（item.category；custom/缺失传 null） */
  category?: string | null;
  /** 大景区父卡兜底为「景点」类（visit.kind === "large_attraction"） */
  isLargeAttraction?: boolean;
}

/**
 * 任务 130：类别 SVG 线条图标（任务 128 的单字「景/食/咖」降为克制小图）。
 * 统一 24 viewBox 描边渲染（stroke=currentColor 继承类别字色），尺寸由
 * styles.css 按场景收敛（横幅 20px / 普通卡 18px / 内部玩法方图 15px）。
 * generic 类别不在此表内，继续使用地点图钉（.ph-pin）。
 */
const CATEGORY_ICONS: Partial<Record<PlaceCategoryKey, ReactElement>> = {
  /** 餐饮：叉 + 勺 */
  dining: (
    <>
      <path d="M7.5 3v4.6a2.2 2.2 0 0 0 4.4 0V3" />
      <path d="M9.7 3v18" />
      <path d="M16.8 3c-1.6 1.5-2.4 3.4-2.4 5 0 1.8 1.1 3 2.4 3s2.4-1.2 2.4-3c0-1.6-.8-3.5-2.4-5Z" />
      <path d="M16.8 11v10" />
    </>
  ),
  /** 咖啡茶饮：杯 + 把手 + 双缕蒸汽 */
  coffee: (
    <>
      <path d="M5.2 10.5h10.6v4.3a4.8 4.8 0 0 1-4.8 4.8h-1a4.8 4.8 0 0 1-4.8-4.8v-4.3Z" />
      <path d="M15.8 11.6h1.3a2.4 2.4 0 0 1 0 4.8h-1.3" />
      <path d="M8.6 3.2c-.9 1.3.9 2 0 3.4" />
      <path d="M12.4 3.2c-.9 1.3.9 2 0 3.4" />
    </>
  ),
  /** 海滩海岛：两道波浪 + 太阳 */
  beach: (
    <>
      <circle cx="17" cy="6.8" r="2.1" />
      <path d="M3 13.2c1.5-1.7 3.1-1.7 4.6 0s3.1 1.7 4.6 0 3.1-1.7 4.6 0 3.1 1.7 4.6 0" />
      <path d="M6.2 18.6c1.5-1.7 3.1-1.7 4.6 0s3.1 1.7 4.6 0" />
    </>
  ),
  /** 景点：山脊轮廓 + 太阳 */
  sight: (
    <>
      <path d="M2.8 18.6 9.2 8.2l3.9 6.1 2-3 6.1 7.3" />
      <circle cx="17.6" cy="6" r="2.1" />
    </>
  ),
  /** 购物：袋身 + 提手 */
  shopping: (
    <>
      <path d="M5.6 8.4h12.8l-.9 12.2H6.5L5.6 8.4Z" />
      <path d="M9.2 8.4V6.9a2.8 2.8 0 0 1 5.6 0v1.5" />
    </>
  ),
  /** 住宿交通：屋顶 + 房体 + 门 */
  stay: (
    <>
      <path d="M4.4 11.2 12 4.4l7.6 6.8" />
      <path d="M6.4 9.6v10h11.2v-10" />
      <path d="M10.4 19.6v-4.8h3.2v4.8" />
    </>
  ),
};

/**
 * 任务 128：统一无图占位（普通卡主图窗 / StopRow 56×56 / 大景区横幅共用）。
 * 纯 CSS+JSX，不请求网络、不依赖图片生成；尺寸完全由外层容器决定
 * （.ph-tile 铺满 100%），图片加载失败切换占位时布局零跳动。
 * 视觉（任务 130 调整）：低饱和渐变底保留，类别图形由大单字改为克制线条
 * SVG 图标（generic 仍用地图钉），短名字号与权重降低；完整名称经
 * role="img" + aria-label 提供给读屏；装饰性图标与短名 aria-hidden 避免重复播报。
 */
export default function ImagePlaceholder({
  name,
  category,
  isLargeAttraction = false,
}: ImagePlaceholderProps) {
  const info = classifyPlace({ category, name, isLargeAttraction });
  const short = shortPlaceLabel(name);
  const icon = CATEGORY_ICONS[info.key];
  return (
    <div
      className={`ph-tile ph-${info.key}`}
      role="img"
      aria-label={`暂无图片：${name}（${info.label}）`}
      title={`暂无图片 · ${name}`}
    >
      {icon ? (
        <svg
          className="ph-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {icon}
        </svg>
      ) : (
        <svg className="ph-pin" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M12 21s-6.5-5.4-6.5-10a6.5 6.5 0 1 1 13 0c0 4.6-6.5 10-6.5 10Z"
            fill="currentColor"
          />
          <circle cx="12" cy="10.6" r="2.4" fill="#FBF7F1" />
        </svg>
      )}
      <span className="ph-name" aria-hidden="true">
        {short}
      </span>
    </div>
  );
}
