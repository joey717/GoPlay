import type { TripCoverInfo } from "../lib/tripCover";
import { coverImageUrl } from "../lib/tripCover";

interface TripCoverBarProps {
  /** tripCoverInfo() 推导出的展示数据（Trip / SharedTrip 共用） */
  info: TripCoverInfo;
  /**
   * 本地封面版本（父层每次上传成功后 +1）：Trip.version 在同一次会话内不会变
   * （saveTrip 的响应被丢弃），同格式重换封面时路径不变 → 必须靠它击穿浏览器缓存。
   */
  revision?: number;
  /** 只读（分享访客）：入口本身不变形，仅语义上标注「只能查看」 */
  readOnly?: boolean;
  /** 封面浮层当前是否已打开（仅用于 aria-expanded） */
  expanded?: boolean;
  /** 点击打开封面浮层 */
  onOpen: () => void;
}

/**
 * 行程封面紧凑入口（Task #258）：
 * 行程页顶部只留这一行（约 46px）——封面缩略图 + 行程名称 + 城市 · N 天 N 晚 + 展开箭头，
 * 点击拉起 TripCoverSheet 浮层。封面图 / 名称编辑 / 备忘录全部收进浮层，
 * Day 标签与当天内容不再被封面卡挤压。
 *
 * 只读（分享访客）同样可点开查看，但浮层内没有任何编辑入口。
 * 名称取自主视图的 Trip（store 乐观更新），编辑落地后本行实时跟随。
 */
export default function TripCoverBar({
  info,
  revision = 0,
  readOnly = false,
  expanded = false,
  onOpen,
}: TripCoverBarProps) {
  const coverSrc = coverImageUrl(
    info.coverImage,
    revision > 0 ? `${info.coverVersion}-${revision}` : info.coverVersion,
  );
  /** 信息行去掉日期区间：入口只有一行高度预算，日期已在 Day 标签上逐天可见 */
  const spanLabel =
    info.dayCount > 0 ? (info.nightCount > 0 ? `${info.dayCount}天${info.nightCount}晚` : `${info.dayCount}天`) : "";
  const summary = [info.cityLabel, spanLabel].filter((part) => part !== "").join(" · ");

  return (
    <button
      type="button"
      className={`cover-bar${readOnly ? " is-readonly" : ""}`}
      aria-label={`行程封面：${info.tripName}${summary !== "" ? `，${summary}` : ""}，${readOnly ? "点击查看" : "点击展开"}`}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      onClick={onOpen}
    >
      <span className="cover-bar-thumb" aria-hidden="true">
        {coverSrc !== null ? (
          <img src={coverSrc} alt="" decoding="async" />
        ) : (
          <span className="cover-bar-wash" />
        )}
      </span>
      <span className="cover-bar-text">
        <span className="cover-bar-title">{info.tripName}</span>
        {summary !== "" ? <span className="cover-bar-meta">{summary}</span> : null}
      </span>
      {info.hasMemo ? (
        <span className="cover-bar-memo" aria-hidden="true">
          备忘
        </span>
      ) : null}
      <span className="cover-bar-arrow" aria-hidden="true">
        <svg viewBox="0 0 12 12" width="12" height="12">
          <path
            d="M2.6 7.4 6 4l3.4 3.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </button>
  );
}
