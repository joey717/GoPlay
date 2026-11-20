import { useEffect, useState } from "react";
import type { Day } from "@goplay/shared";

interface DepartTimeProps {
  day: Day;
  onChange: (time: string) => void;
}

const TIME_PATTERN = /^\d{2}:\d{2}$/;

/** 出发时间行：展示 + 点击进入 input[type=time] 编辑；修改后标记 departTimeOverridden 并重算后续时间 */
export default function DepartTime({ day, onChange }: DepartTimeProps) {
  const [editing, setEditing] = useState(false);
  // departTime 可为 null（待定）；draft 保持 string，避免受控 input 出现 null 值
  const [draft, setDraft] = useState(day.departTime ?? "");

  useEffect(() => {
    if (!editing) setDraft(day.departTime ?? "");
  }, [day.departTime, editing]);

  const submit = () => {
    const value = draft.trim();
    if (TIME_PATTERN.test(value) && value !== day.departTime) onChange(value);
    setEditing(false);
  };

  return (
    <div className="depart">
      <div className="lb">
        当日出发时间{day.departTimeOverridden ? "（你手改过，AI 不覆盖）" : ""}
      </div>
      {editing ? (
        <input
          className="depart-input"
          type="time"
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onBlur={submit}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
            if (event.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <div
          className={`val ${day.departTimeOverridden ? "override" : ""}`}
          onClick={() => setEditing(true)}
          role="button"
          aria-label="修改当日出发时间"
        >
          {day.departTime || "--:--"}
          <span className="ed">改</span>
        </div>
      )}
    </div>
  );
}
