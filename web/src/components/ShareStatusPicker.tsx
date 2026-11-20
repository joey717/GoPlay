import { useEffect, useRef, useState } from "react";

/** 分享页允许打标的状态值（景点四态 / 住宿三态，与 View/LodgingPlan.purchaseState 同源） */
export type ShareStatusValue = "unknown" | "toBuy" | "bought" | "noTicket";

/** 打标对象：景点门票 / 住宿订房（两套字典不混用，住宿没有免票档） */
export type ShareStatusKind = "poi" | "hotel";

interface StatusOption {
  value: ShareStatusValue;
  label: string;
}

/** 景点：无需购票 / 待购 / 已购票 / 未定 */
const POI_OPTIONS: StatusOption[] = [
  { value: "noTicket", label: "无需购票" },
  { value: "toBuy", label: "待购" },
  { value: "bought", label: "已购票" },
  { value: "unknown", label: "未定" },
];

/** 住宿：待订 / 已订房 / 未定 */
const HOTEL_OPTIONS: StatusOption[] = [
  { value: "toBuy", label: "待订" },
  { value: "bought", label: "已订房" },
  { value: "unknown", label: "未定" },
];

const TITLES: Record<ShareStatusKind, string> = {
  poi: "门票状态",
  hotel: "订房状态",
};

interface ShareStatusPickerProps {
  kind: ShareStatusKind;
  /** 当前状态（文案与高亮都以它为准，父组件负责乐观更新） */
  value: ShareStatusValue;
  /** 选中新状态（同值不回调，由调用方直接发 PATCH） */
  onChange: (next: ShareStatusValue) => void;
}

/**
 * 分享页状态打标控件（Task #260）。
 *
 * - 收起态：一颗 pill 展示当前状态（「已购票」「待订」「未定」…），点击展开选项；
 * - 展开态：同一行下方铺开选项胶囊，当前项高亮（clay 底 + 对勾），再点即收起；
 * - 点击区域 ≥ 34px 高、选项 ≥ 38px，移动端可直接点；
 * - 选项用普通文档流排布（不 portal / 不绝对定位），避让 `.share-card.is-large`
 *   的 overflow:hidden 裁剪，展开时卡片自然增高。
 */
export default function ShareStatusPicker({ kind, value, onChange }: ShareStatusPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const options = kind === "hotel" ? HOTEL_OPTIONS : POI_OPTIONS;
  const title = TITLES[kind];
  const current = options.find((option) => option.value === value) ?? options[options.length - 1];

  // 展开后：点外部 / Escape 收起（不阻塞其它按钮）
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const select = (next: ShareStatusValue) => {
    setOpen(false);
    if (next !== value) onChange(next);
  };

  return (
    <div className={`share-status${open ? " is-open" : ""}`} ref={rootRef}>
      <span className="share-status-label">{title}</span>
      <button
        type="button"
        className={`share-status-pill tone-${value}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${title}：${current.label}，点击修改`}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="share-status-text">{current.label}</span>
        <span className="share-status-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open ? (
        <div className="share-status-menu" role="listbox" aria-label={`选择${title}`}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`share-status-option${option.value === value ? " active" : ""}`}
              onClick={() => select(option.value)}
            >
              {option.value === value ? <span className="share-status-tick">✓</span> : null}
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
