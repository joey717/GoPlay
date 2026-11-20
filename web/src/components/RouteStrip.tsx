import type { Day, Trip } from "@goplay/shared";
import { dayRouteNodes } from "../lib/dayOrder";

interface RouteStripProps {
  trip: Trip;
  day: Day;
}

/**
 * 当天路线顺序总览（Task #108）：
 * 唯一的路线顺序展示位，按页面下方混排列表（displayOrder）的实际顺序展开——
 * 住宿、机场起点/终点、普通景点、大景区父卡，以及父卡之后的大景区岛内玩法；
 * 大景区内部玩法只在这里出现一次（卡片内不再渲染路线 chips）。
 *
 * 样式沿用编号节点（圆点序号 + 虚线连接 + 点位短名），节点多时横向滚动。
 */
export default function RouteStrip({ trip, day }: RouteStripProps) {
  const nodes = dayRouteNodes(trip, day);
  if (nodes.length === 0) return null;
  const hasHotel = nodes.some((node) => node.kind === "hotel");
  const hasStop = nodes.some((node) => node.kind === "stop");
  return (
    <div className="mapcard">
      <div className="mh">
        <b>Day{day.dayIndex} 路线顺序</b>
        <span>{nodes.length} 个点位</span>
      </div>
      <div className="routebar" role="list" aria-label={`Day${day.dayIndex} 路线顺序`}>
        {nodes.map((node, index) => (
          <div
            className={`routepoint ${node.kind}`}
            key={node.key}
            role="listitem"
            title={node.hint}
          >
            <span className="dot">{index + 1}</span>
            {/* 长名由 CSS 省略号截断；完整名称在 title 中 */}
            <span className="rname">{node.label}</span>
          </div>
        ))}
      </div>
      <div className="mapnote">
        仅表示先后顺序 · 非等比地图 / 非导航
        {hasHotel ? " · 含当晚住宿" : ""}
        {hasStop ? " · 含大景区岛内玩法" : ""}
      </div>
    </div>
  );
}
