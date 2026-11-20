import type { Trip } from "@goplay/shared";
import { shortDate, weekdayLabel } from "../lib/format";
import { dayVisits, joinTagParts, orderedDays, visitDisplayName, visitModeLabel } from "../lib/trip";

interface DayStripProps {
  trip: Trip;
  currentDay: number;
  onSelect: (dayIndex: number) => void;
}

/**
 * Day 横向切换条；站数只计城市级 scheduleVisitRefs。
 * 含大景区时显示景区名而不是子项站数（PRD §6：内部玩法不重复成为城市节点）。
 * Task #344（PD：「把『全天』二字去掉」）：原「景区名 · 全天/半天」去掉「全天」取值，
 * full_day 时经 joinTagParts 过滤后只剩景区名（不留悬空的「· 」）；「半天」「自定义」保留。
 */
export default function DayStrip({ trip, currentDay, onSelect }: DayStripProps) {
  return (
    <div className="daystrip-wrap">
      <div className="daystrip">
        {orderedDays(trip).map((day) => {
          const visits = dayVisits(trip, day);
          const large = visits.find((visit) => visit.kind === "large_attraction");
          const flag =
            large !== undefined
              ? joinTagParts(visitDisplayName(trip, large), visitModeLabel(large))
              : visits.length > 0
                ? `${visits.length} 站`
                : "空";
          return (
            <button
              type="button"
              key={day.dayIndex}
              className={`dchip ${day.dayIndex === currentDay ? "on" : ""}`}
              onClick={() => onSelect(day.dayIndex)}
            >
              <span className="d">Day{day.dayIndex}</span>
              <span className="w">
                {shortDate(day.date)} {weekdayLabel(day.date)}
              </span>
              <span className="flag">{flag}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
