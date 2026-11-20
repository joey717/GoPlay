import { useState } from "react";
import { SANYA_AREAS } from "@goplay/shared";

interface AreaTagProps {
  dayIndex: number;
  /** 当天住宿片区意向（来自 trip.lodgings[String(dayIndex)].areaName）；null = 未设置 */
  areaName: string | null;
  /** 写入/清除当天片区意向（null 表示清除；lodging 专用行为） */
  onUpdateArea: (dayIndex: number, areaName: string | null) => void;
  /** 选定片区后点「看酒店」：由上层打开 HotelPicker Sheet */
  onSearchHotels: (dayIndex: number, areaName: string) => void;
}

/**
 * F4 片区标签：路线条下方、Visit 列表上方。
 * 已有片区 → 彩色 badge + 「换」「x」+「看酒店」；
 * 无片区 → 灰色虚线「+ 设置片区」。点击展开内联选择器（6 预设片区横向滑动 + 自定义输入）。
 *
 * @deprecated Task #354：本组件已被 Module B 当日锚点行（DayContent 内「看酒店 ›」）取代，
 * 当前无任何引用；写片区入口改为 HotelPicker 无片区时的片区选择态（写回 useTrip.updateLodgingArea）。
 * 按最小改动原则本次不删除该文件及其 CSS（.area-add/.area-tag/.area-selector 等），仅标注废弃。
 */
export default function AreaTag({ dayIndex, areaName, onUpdateArea, onSearchHotels }: AreaTagProps) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");

  const choose = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onUpdateArea(dayIndex, trimmed);
    setOpen(false);
    setCustom("");
  };

  return (
    <div className="area-wrap">
      {areaName !== null ? (
        <span className="area-tag">
          {areaName}
          <span className="area-actions">
            <button type="button" title="更换片区" onClick={() => setOpen((prev) => !prev)}>
              换
            </button>
            <button
              type="button"
              title="清除片区"
              onClick={() => {
                onUpdateArea(dayIndex, null);
                setOpen(false);
              }}
            >
              x
            </button>
          </span>
          <button
            type="button"
            className="area-hotels"
            onClick={() => onSearchHotels(dayIndex, areaName)}
          >
            看酒店
          </button>
        </span>
      ) : (
        <button type="button" className="area-add" onClick={() => setOpen((prev) => !prev)}>
          + 设置片区
        </button>
      )}

      {open ? (
        <div className="area-selector">
          <div className="area-options">
            {SANYA_AREAS.map((area) => (
              <button
                key={area.id}
                type="button"
                className={`area-option${areaName === area.name ? " selected" : ""}`}
                onClick={() => choose(area.name)}
              >
                <span className="area-name">{area.name}</span>
                <span className="area-desc">{area.description}</span>
              </button>
            ))}
          </div>
          <div className="area-custom">
            <input
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
              placeholder="自定义片区，如：后海村"
              maxLength={16}
            />
            <button type="button" disabled={!custom.trim()} onClick={() => choose(custom)}>
              确定
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
