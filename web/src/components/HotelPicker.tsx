import { useEffect, useState } from "react";
import { SANYA_AREAS, findAreaByName } from "@goplay/shared";
import type { HotelCandidate, Trip } from "@goplay/shared";
import {
  flyAiErrorMessage,
  isRetryableSearchError,
  searchHotels,
  type HotelSearchFilterStats,
} from "../api/client";

interface HotelPickerProps {
  dayIndex: number;
  /** Task #354：当天住宿片区意向；null（或非已配置片区）时渲染片区选择态，不直接搜索。 */
  areaName: string | null;
  /** "YYYY-MM-DD"（当天为入住日） */
  checkIn: string;
  /** "YYYY-MM-DD"（次日为退房日） */
  checkOut: string;
  trip: Trip;
  /** Task #354：选定片区后写回 lodging（恢复 updateLodgingArea 接线，下次直接打开该片区）。 */
  onUpdateArea: (dayIndex: number, areaName: string | null) => void;
  /** 选定酒店：写入 lodging 并关闭 Sheet（由上层处理） */
  onSelect: (dayIndex: number, hotel: HotelCandidate) => void;
  onClose: () => void;
}

/** star "5" → "★★★★★"；非数字原样返回，最多 5 颗 */
function starBadge(star: string | null): string {
  if (!star) return "";
  const count = Math.round(Number.parseFloat(star));
  return Number.isFinite(count) && count > 0 ? "★".repeat(Math.min(count, 5)) : star;
}

/** Task #69：飞猪酒店搜索页跳转链接（城市 + 片区为关键词，带上入住/离店日期） */
function buildFliggySearchUrl(city: string, area: string, checkIn: string, checkOut: string): string {
  const keyword = `${city} ${area}`.trim();
  const params = new URLSearchParams({ keyword, checkIn, checkOut });
  return `https://www.fliggy.com/hotel/?${params.toString()}`;
}

/** 候选主图：加载失败或缺失时退回占位底色 */
function HotelThumb({ hotel }: { hotel: HotelCandidate }) {
  const [failed, setFailed] = useState(false);
  if (!hotel.mainPic || failed) return <div className="hotel-pic" aria-hidden="true" />;
  return (
    <img
      className="hotel-pic"
      src={hotel.mainPic}
      alt={hotel.name}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

/**
 * F6 酒店候选比选：底部 Sheet，打开即调 FlyAI searchHotels，最多取 3 家纵列卡片。
 * 参考价/评分仅供比选，常驻文案提醒以飞猪页面为准；detailUrl 缺失时隐藏跳转按钮。
 */
export default function HotelPicker({
  dayIndex,
  areaName,
  checkIn,
  checkOut,
  trip,
  onUpdateArea,
  onSelect,
  onClose,
}: HotelPickerProps) {
  const [loading, setLoading] = useState(true);
  /** 失败态：message 为安全文案（额度耗尽使用固定文案）；canRetry 决定是否展示「重试」 */
  const [error, setError] = useState<{ message: string; canRetry: boolean } | null>(null);
  const [hotels, setHotels] = useState<HotelCandidate[]>([]);
  const [filterStats, setFilterStats] = useState<HotelSearchFilterStats | null>(null);
  /** 「重试」按钮：自增触发重新搜索（保持 Sheet 不关闭） */
  const [reloadKey, setReloadKey] = useState(0);
  const destinationCity = trip.destination.city;
  // Task #354：当前生效片区。areaName 为 null 或不是已配置片区（findAreaByName 解析失败
  // 的防御分支）时为 null → 渲染片区选择态；点选湾区后写回 lodging 并置为该名进入搜索。
  const [area, setArea] = useState<string | null>(
    areaName !== null && findAreaByName(areaName) !== undefined ? areaName : null,
  );

  const chooseArea = (name: string) => {
    // 写回当天 lodging.areaName（恢复孤儿 API 接线），随即进入 area 搜索流程
    onUpdateArea(dayIndex, name);
    setArea(name);
  };

  useEffect(() => {
    if (area === null) {
      // 片区选择态：不发起搜索，退出 loading
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    setHotels([]);
    setFilterStats(null);
    // 结构化参数：目的地 + 片区 + 日期；服务端按片区配置解析本地语义关键词并做权威过滤，
    // 空结果不回退展示境外/非本片区酒店（宁可空，不可错）；失败只展示安全中文文案
    searchHotels({ destination: destinationCity, area, checkIn, checkOut })
      .then((res) => {
        if (active) {
          setHotels(res.normalized.slice(0, 3));
          setFilterStats(res.filter ?? null);
        }
      })
      .catch((err: unknown) => {
        // 不展示底层报错：额度耗尽等只展示固定/安全文案，原始细节留给服务端日志
        if (active) {
          setError({ message: flyAiErrorMessage(err), canRetry: isRetryableSearchError(err) });
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [area, checkIn, checkOut, destinationCity, reloadKey]);

  return (
    <>
      <div className="hotel-picker-overlay" onClick={onClose} />
      <div className="hotel-picker-sheet" role="dialog" aria-label={`Day${dayIndex} 酒店候选`}>
        <div className="hotel-picker-head">
          <span>
            {area === null
              ? `选择入住片区 · ${checkIn.slice(5)}`
              : `${area} · ${checkIn.slice(5)} 入住`}
          </span>
          <button type="button" className="hotel-picker-x" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        {area === null ? (
          <div className="hotel-area-select">
            <div className="hotel-area-hint">选一个今晚想住的片区，选好后自动为你查酒店</div>
            <div className="hotel-area-options">
              {SANYA_AREAS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className="area-option"
                  onClick={() => chooseArea(option.name)}
                >
                  <span className="area-name">{option.name}</span>
                  <span className="area-desc">{option.description}</span>
                </button>
              ))}
            </div>
            <div className="hotel-area-footer">
              <button type="button" className="ghost" onClick={onClose}>
                知道了
              </button>
            </div>
          </div>
        ) : loading ? (
          <div className="hotel-loading">
            {[0, 1, 2].map((index) => (
              <div key={index} className="hotel-candidate" aria-hidden="true">
                <div className="hotel-pic skeleton" />
                <div className="hotel-info">
                  <div className="skeleton skeleton-line w70" />
                  <div className="skeleton skeleton-line w50" />
                  <div className="skeleton skeleton-line w40" />
                </div>
              </div>
            ))}
            <div className="hotel-picker-footer">正在向飞猪查询实时酒店…</div>
          </div>
        ) : error ? (
          <div className="hotel-empty">
            {error.message}
            <div className="hotel-error-actions">
              {error.canRetry ? (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setReloadKey((key) => key + 1)}
                >
                  重试
                </button>
              ) : null}
              <button type="button" className="ghost" onClick={onClose}>
                知道了
              </button>
            </div>
          </div>
        ) : hotels.length === 0 ? (
          <div className="hotel-empty">
            在{destinationCity}
            {area}暂时没找到合适酒店，试试其他片区
            <button type="button" className="ghost" onClick={onClose}>
              知道了
            </button>
            <a
              className="hotel-more-link"
              href={buildFliggySearchUrl(destinationCity, area, checkIn, checkOut)}
              target="_blank"
              rel="noopener noreferrer"
            >
              去搜索 {destinationCity}{area} 酒店
            </a>
          </div>
        ) : (
          <>
            {hotels.map((hotel) => {
              const star = starBadge(hotel.star);
              const detailUrl = hotel.detailUrl;
              return (
                <div key={hotel.shId} className="hotel-candidate">
                  <HotelThumb hotel={hotel} />
                  <div className="hotel-info">
                    <div className="hotel-name">{hotel.name}</div>
                    {star ? <div className="hotel-star">{star}</div> : null}
                    {hotel.priceText ? (
                      <div className="hotel-price">
                        {hotel.priceText}
                        <span>/晚</span>
                      </div>
                    ) : null}
                    {hotel.rate ? <div className="hotel-rate">评分 {hotel.rate}</div> : null}
                    <div className="hotel-actions">
                      {detailUrl ? (
                        <button
                          type="button"
                          className="detail-btn"
                          onClick={() => window.open(detailUrl, "_blank", "noopener")}
                        >
                          去看看
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="select-btn"
                        onClick={() => onSelect(dayIndex, hotel)}
                      >
                        选这家
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
            <div className="hotel-picker-footer">
              价格与库存以飞猪页面为准
              {filterStats && filterStats.cityRejected + (filterStats.areaRejected ?? 0) > 0
                ? ` · 已过滤 ${filterStats.cityRejected + (filterStats.areaRejected ?? 0)} 家非${destinationCity}或非${area}结果`
                : ""}
              <a
                className="hotel-more-link"
                href={buildFliggySearchUrl(destinationCity, area, checkIn, checkOut)}
                target="_blank"
                rel="noopener noreferrer"
              >
                查看更多 {destinationCity}{area} 酒店 →
              </a>
            </div>
          </>
        )}
      </div>
    </>
  );
}
