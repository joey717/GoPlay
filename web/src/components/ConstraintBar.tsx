import type { Constraint } from "@goplay/shared";

/** 约束条：锁图标 + label + anchorTime（label 已含时间时不重复展示） */
export default function ConstraintBar({ constraint }: { constraint: Constraint }) {
  const time = constraint.anchorTime.length >= 16 ? constraint.anchorTime.slice(11, 16) : "";
  const showTime = time !== "" && !constraint.label.includes(time);
  return (
    <div className="constraint">
      <span className="lk" aria-hidden="true">
        🔒
      </span>
      <span>
        {constraint.label}
        {showTime ? ` · ${time}` : ""}
      </span>
    </div>
  );
}
