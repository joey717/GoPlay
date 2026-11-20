import { useMemo, useState } from "react";
import type { Constraint, Day, LodgingPlan, Trip } from "@goplay/shared";
import { SANYA_AREAS, SCHEMA_VERSION, findAreaById } from "@goplay/shared";
import { createTrip, saveTrip, ApiError } from "../api/client";
import { orderedDays } from "../lib/trip";
import ConstraintEditor from "./ConstraintEditor";

interface InitFlowProps {
  /** 上层闸门提示（如服务端尚未适配 v1.1 / 检测到旧 schema） */
  notice?: string | null;
  onComplete: (trip: Trip) => void;
}

const DAY_MS = 86_400_000;

/** v1.1 三步：目的地日期 → 已定约束与确认 → 住宿片区意向（同行人/偏好/预算随 v1.0 模型移除） */
const STEP_TITLES: Record<1 | 2 | 3, string> = {
  1: "目的地与日期",
  2: "已定约束与确认",
  3: "住宿片区意向",
};

/** 统一把错误转为用户可读中文（client 层已包装网络错误，此处兜底防御残余英文原文） */
function friendlyError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && /failed to fetch|networkerror|load failed/i.test(error.message)) {
    return "网络连接失败，请刷新页面后重试";
  }
  return error instanceof Error ? error.message : "创建行程失败，请重试";
}

/**
 * F0 初始化三步（v1.1）：
 * 1. 目的地 + 日期区间 → 2. 已定约束录入 + 摘要确认 → 创建行程 → 3. 住宿片区意向（可跳过）。
 * Step 3 选定片区在行程创建后经 saveTrip 写入 lodgings[String(dayIndex)]（placeholder）。
 * seed 只发送 v1.1 规范字段（schemaVersion/destination/dateRange/constraints）。
 */
export default function InitFlow({ notice = null, onComplete }: InitFlowProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [startDate, setStartDate] = useState("2026-11-08");
  const [endDate, setEndDate] = useState("2026-11-12");
  /** Step 2 已录入的约束（由 ConstraintEditor 即时同步，提交时原样进 seed） */
  const [constraints, setConstraints] = useState<Constraint[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Step 3：行程创建后的片区意向（dayIndex → 片区 id）
  const [createdTrip, setCreatedTrip] = useState<Trip | null>(null);
  const [areaChoices, setAreaChoices] = useState<Record<number, string>>({});
  const [savingAreas, setSavingAreas] = useState(false);

  const dateError = useMemo(() => {
    if (!startDate || !endDate) return null;
    return endDate < startDate ? "结束日期不能早于开始日期" : null;
  }, [startDate, endDate]);

  /** 约束编辑器「第几天」上界：日期区间已填时为区间天数（含首尾），缺省按 1 天 */
  const dayCount = useMemo(() => {
    if (!startDate || !endDate) return 1;
    const nights = Math.round((Date.parse(endDate) - Date.parse(startDate)) / DAY_MS);
    return nights >= 0 ? nights + 1 : 1;
  }, [startDate, endDate]);

  /** 创建行程：seed 按 rev2 结构发送（schemaVersion 数字 + destination + dateRange + constraints） */
  const submit = async (withDrafts: boolean) => {
    if (dateError || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const seed: Partial<Trip> = {
        schemaVersion: SCHEMA_VERSION,
        destination: { city: "三亚", cityCode: null },
      };
      if (startDate && endDate) {
        seed.dateRange = {
          start: startDate,
          end: endDate,
          nights: Math.round((Date.parse(endDate) - Date.parse(startDate)) / DAY_MS),
        };
      }
      if (withDrafts && constraints.length > 0) {
        seed.constraints = constraints;
      }
      const trip = await createTrip(seed);
      setCreatedTrip(trip);
      setAreaChoices({});
      setStep(3);
    } catch (error) {
      setSubmitError(friendlyError(error));
    } finally {
      setSubmitting(false);
    }
  };

  /** Step 3 完成：选定片区的天写入 lodgings[String(dayIndex)]（placeholder）并持久化后进入行程 */
  const finalize = async () => {
    if (!createdTrip || savingAreas) return;
    const hasChoice = orderedDays(createdTrip).some((day) => areaChoices[day.dayIndex]);
    if (!hasChoice) {
      onComplete(createdTrip);
      return;
    }
    const lodgings: Record<string, LodgingPlan> = { ...createdTrip.lodgings };
    const days: Record<string, Day> = { ...createdTrip.days };
    for (const day of orderedDays(createdTrip)) {
      const areaId = areaChoices[day.dayIndex];
      if (!areaId) continue;
      const area = findAreaById(areaId);
      if (!area) continue;
      lodgings[String(day.dayIndex)] = {
        dayIndex: day.dayIndex,
        areaName: area.name,
        hotelRefs: [],
        checkInTime: null,
        checkOutTime: null,
        purchaseState: "unknown",
        locked: false,
        userAdjusted: false,
      };
      days[day.dayId] = { ...day, lodging: { kind: "lodging", dayIndex: day.dayIndex } };
    }
    const updated: Trip = { ...createdTrip, lodgings, days };
    setSavingAreas(true);
    setSubmitError(null);
    try {
      const saved = await saveTrip(updated);
      onComplete(saved);
    } catch {
      // 片区意向保存失败不阻塞进入行程（行程本体已创建）
      onComplete(updated);
    } finally {
      setSavingAreas(false);
    }
  };

  return (
    <div className="init">
      <div className="init-brand">
        <div className="init-mark">G</div>
        <div>
          <b>GoPlay · 去玩</b>
          <span>先把日期立住，约束锁住，剩下的慢慢排</span>
        </div>
      </div>

      <div className="init-card">
        {notice ? <div className="init-error">{notice}</div> : null}
        <div className="step-dots" aria-hidden="true">
          {([1, 2, 3] as const).map((n) => (
            <span key={n} className={`step-dot${step === n ? " active" : step > n ? " done" : ""}`} />
          ))}
        </div>
        <div className="init-steptitle">{STEP_TITLES[step]}</div>

        {step === 1 ? (
          <>
            <label className="init-field">
              <span>目的地（当前版本仅开放三亚）</span>
              <input className="ro" value="三亚" readOnly />
            </label>
            <div className="init-dates">
              <label className="init-field">
                <span>开始日期</span>
                <input
                  type="date"
                  value={startDate}
                  onChange={(event) => setStartDate(event.target.value)}
                />
              </label>
              <label className="init-field">
                <span>结束日期</span>
                <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
              </label>
            </div>
            {dateError ? <div className="init-error">{dateError}</div> : null}
            {submitError ? <div className="init-error">{submitError}</div> : null}
            <div className="init-actions">
              <button type="button" className="ghost" onClick={() => submit(false)} disabled={submitting}>
                跳过
              </button>
              <button
                type="button"
                className="cta"
                onClick={() => setStep(2)}
                disabled={submitting || Boolean(dateError)}
              >
                下一步
              </button>
            </div>
          </>
        ) : null}

        {step === 2 ? (
          <>
            {/* Step 2 与行程内「修改约束」共用同一编辑器：内嵌形态不带遮罩 / 自带按钮，
                录入即同步到本步 constraints，提交由下方步骤按钮完成 */}
            <ConstraintEditor
              variant="inline"
              initialConstraints={constraints}
              totalDays={dayCount}
              startDate={startDate}
              onChange={setConstraints}
              onSave={setConstraints}
              onCancel={() => setStep(1)}
            />

            {submitError ? <div className="init-error">{submitError}</div> : null}
            <div className="init-actions">
              <button type="button" className="ghost" onClick={() => setStep(1)} disabled={submitting}>
                上一步
              </button>
              <button type="button" className="ghost" onClick={() => submit(false)} disabled={submitting}>
                跳过约束
              </button>
              <button type="button" className="cta" onClick={() => submit(true)} disabled={submitting}>
                {submitting ? "创建中…" : "开始规划"}
              </button>
            </div>
          </>
        ) : null}

        {step === 3 && createdTrip ? (
          <>
            <div className="init-hint">
              行程已创建。想好住哪个片区了吗？选定后 AI 会围绕片区安排当天的点；
              每天都可以不选，之后再改。
            </div>

            <div className="area-intent-list">
              {orderedDays(createdTrip).map((day) => (
                <div className="area-intent-row" key={day.dayIndex}>
                  <span className="day-label">Day{day.dayIndex}</span>
                  <span className="day-date">{day.date.slice(5)}</span>
                  <select
                    value={areaChoices[day.dayIndex] ?? ""}
                    onChange={(event) =>
                      setAreaChoices((prev) => ({ ...prev, [day.dayIndex]: event.target.value }))
                    }
                  >
                    <option value="">暂不指定</option>
                    {SANYA_AREAS.map((area) => (
                      <option key={area.id} value={area.id}>
                        {area.name} · {area.description}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            {submitError ? <div className="init-error">{submitError}</div> : null}
            <div className="init-actions">
              <button
                type="button"
                className="ghost"
                onClick={() => onComplete(createdTrip)}
                disabled={savingAreas}
              >
                跳过
              </button>
              <button type="button" className="cta" onClick={() => void finalize()} disabled={savingAreas}>
                {savingAreas ? "保存中…" : "完成"}
              </button>
            </div>
          </>
        ) : null}
      </div>

      <p className="init-foot">
        M1 Day1 · 目的地锁三亚 · 创建后日期与约束都还可以随时调整
      </p>
    </div>
  );
}
