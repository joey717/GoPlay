/**
 * Task #257：行程封面纯函数单测（读时兼容 / 限长 / 路径换算 / 补丁应用）。
 */

import { describe, expect, it } from "vitest";
import type { Trip } from "@goplay/shared";
import {
  DEFAULT_TRIP_NAME,
  MEMO_MAX,
  TRIP_NAME_MAX,
  applyCoverPatch,
  coverImageUrl,
  memoNeedsExpand,
  normalizeMemo,
  normalizeTripName,
  tripCoverInfo,
} from "./tripCover";

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  const day = (index: number, date: string): Trip["days"][string] => ({
    dayId: `day_${index}`,
    dayIndex: index,
    date,
    departTime: null,
    departTimeOverridden: false,
    scheduleVisitRefs: [],
    lodging: null,
  });
  return {
    tripId: "trip-cover",
    schemaVersion: 2,
    version: 3,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: "2026-11-12", nights: 4 },
    dayRefs: ["day_1", "day_2", "day_3", "day_4", "day_5"],
    days: {
      day_1: day(1, "2026-11-08"),
      day_2: day(2, "2026-11-09"),
      day_3: day(3, "2026-11-10"),
      day_4: day(4, "2026-11-11"),
      day_5: day(5, "2026-11-12"),
    },
    lodgings: {},
    itemRegistry: {},
    hotelRegistry: {},
    visits: {},
    stops: {},
    evidences: {},
    globalCandidateRefs: [],
    pendingStopRefs: [],
    relationshipSuggestions: {},
    guideSources: {},
    constraints: [],
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    ...overrides,
  };
}

describe("tripCoverInfo：旧数据兼容与自动信息行", () => {
  it("缺三字段的旧 Trip：默认名称、无备忘、渐变兜底、信息行自动推导", () => {
    const info = tripCoverInfo(makeTrip());
    expect(info.tripName).toBe(DEFAULT_TRIP_NAME);
    expect(info.isDefaultName).toBe(true);
    expect(info.memo).toBe("");
    expect(info.hasMemo).toBe(false);
    expect(info.coverImage).toBeNull();
    expect(info.dayCount).toBe(5);
    expect(info.nightCount).toBe(4);
    expect(info.dateLabel).toBe("11/08-11/12");
    expect(info.metaLine).toBe("三亚 · 5天4晚 · 11/08-11/12");
    expect(info.coverVersion).toBe(3);
  });

  it("有封面 / 名称 / 备忘时按原值展示，空串按空值处理", () => {
    const info = tripCoverInfo(
      makeTrip({
        coverImage: "uploads/trip-cover/cover.jpg",
        tripName: "  三亚亲子五日  ",
        memo: "带娃节奏放缓",
      }),
    );
    expect(info.coverImage).toBe("uploads/trip-cover/cover.jpg");
    expect(info.tripName).toBe("三亚亲子五日");
    expect(info.isDefaultName).toBe(false);
    expect(info.hasMemo).toBe(true);
    expect(info.memoOverflows).toBe(false);
  });

  it("空白字符串字段等价于空值（读时兼容，无需迁移）", () => {
    const info = tripCoverInfo(makeTrip({ coverImage: "   ", tripName: "  ", memo: "   " }));
    expect(info.coverImage).toBeNull();
    expect(info.tripName).toBe(DEFAULT_TRIP_NAME);
    expect(info.isDefaultName).toBe(true);
    expect(info.hasMemo).toBe(false);
  });

  it("单日行程：只有「N天」，日期只显示起始日", () => {
    const one = makeTrip({
      dayRefs: ["day_1"],
      days: { day_1: makeTrip().days.day_1 },
      dateRange: { start: "2026-11-08", end: "2026-11-08", nights: 0 },
    });
    const info = tripCoverInfo(one);
    expect(info.dayCount).toBe(1);
    expect(info.nightCount).toBe(0);
    expect(info.dateLabel).toBe("11/08");
    expect(info.metaLine).toBe("三亚 · 1天 · 11/08");
  });

  it("days 为空时用 dateRange.nights 兜底天数，避免信息行缺项", () => {
    const info = tripCoverInfo(
      makeTrip({ dayRefs: [], days: {}, dateRange: { start: "2026-11-08", end: "2026-11-12", nights: 4 } }),
    );
    expect(info.dayCount).toBe(5);
    expect(info.nightCount).toBe(4);
    expect(info.metaLine).toBe("三亚 · 5天4晚 · 11/08-11/12");
  });

  it("按 dayRefs 顺序取首末日（days 键顺序不可信）", () => {
    const base = makeTrip();
    const info = tripCoverInfo({
      ...base,
      days: { day_2: base.days.day_2, day_1: base.days.day_1 },
      dayRefs: ["day_1", "day_2"],
      dateRange: { start: "2026-11-08", end: "2026-11-09", nights: 1 },
    });
    expect(info.dateLabel).toBe("11/08-11/09");
    expect(info.metaLine).toBe("三亚 · 2天1晚 · 11/08-11/09");
  });

  it("城市为空时不出现空段（不产生「· ·」）", () => {
    const info = tripCoverInfo(makeTrip({ destination: { city: "  ", cityCode: null } }));
    expect(info.cityLabel).toBe("");
    expect(info.metaLine).toBe("5天4晚 · 11/08-11/12");
  });
});

describe("normalizeTripName / normalizeMemo：限长与归一", () => {
  it("名称压平换行并去首尾空白", () => {
    expect(normalizeTripName("  三亚\n亲子  ")).toBe("三亚 亲子");
  });

  it("名称按码点截断到 50（不切坏 emoji）", () => {
    const raw = "🌴".repeat(TRIP_NAME_MAX + 5);
    const next = normalizeTripName(raw);
    expect(Array.from(next)).toHaveLength(TRIP_NAME_MAX);
    expect(next).toBe("🌴".repeat(TRIP_NAME_MAX));
  });

  it("备忘统一换行符并截断到 500 码点", () => {
    expect(normalizeMemo("第一行\r\n第二行\r第三行")).toBe("第一行\n第二行\n第三行");
    expect(Array.from(normalizeMemo("备".repeat(MEMO_MAX + 20)))).toHaveLength(MEMO_MAX);
  });

  it("空输入归一为空串（表示清除字段）", () => {
    expect(normalizeTripName("   \n ")).toBe("");
    expect(normalizeMemo("\n\n  ")).toBe("");
  });
});

describe("memoNeedsExpand：两行预览的展开判定", () => {
  it("短备忘不展开", () => {
    expect(memoNeedsExpand("带娃节奏放缓")).toBe(false);
    expect(memoNeedsExpand("第一行\n第二行")).toBe(false);
    expect(memoNeedsExpand("")).toBe(false);
  });

  it("超过两行或超过两行容量时展开", () => {
    expect(memoNeedsExpand("一\n二\n三")).toBe(true);
    expect(memoNeedsExpand("备".repeat(80))).toBe(true);
  });
});

describe("coverImageUrl：受控读取地址", () => {
  it("空值返回 null（渲染渐变兜底，不发请求）", () => {
    expect(coverImageUrl(null)).toBeNull();
    expect(coverImageUrl(undefined)).toBeNull();
    expect(coverImageUrl("  ")).toBeNull();
  });

  it("相对路径拼 /api 前缀，并带版本参数击穿缓存", () => {
    expect(coverImageUrl("uploads/t/c.jpg")).toBe("/api/uploads/t/c.jpg");
    expect(coverImageUrl("uploads/t/c.jpg", 7)).toBe("/api/uploads/t/c.jpg?v=7");
  });

  it("根路径 / 绝对地址原样保留（仅追加版本参数）", () => {
    expect(coverImageUrl("/api/uploads/t/c.png")).toBe("/api/uploads/t/c.png");
    expect(coverImageUrl("https://cdn.example.com/c.jpg", "8")).toBe(
      "https://cdn.example.com/c.jpg?v=8",
    );
  });
});

describe("applyCoverPatch：不可变写入与清除", () => {
  it("写入三字段并归一", () => {
    const trip = makeTrip();
    const next = applyCoverPatch(trip, {
      coverImage: " uploads/t/cover.png ",
      tripName: "  三亚亲子  ",
      memo: "第一行\r\n第二行",
    });
    expect(next).not.toBe(trip);
    expect(next.coverImage).toBe("uploads/t/cover.png");
    expect(next.tripName).toBe("三亚亲子");
    expect(next.memo).toBe("第一行\n第二行");
    // 原 Trip 不被修改
    expect(trip.coverImage).toBeUndefined();
    expect(trip.tripName).toBeUndefined();
    expect(trip.memo).toBeUndefined();
  });

  it("null / 空串清除字段（恢复缺字段形态）", () => {
    const trip = makeTrip({ coverImage: "uploads/t/c.jpg", tripName: "旧名", memo: "旧备忘" });
    const next = applyCoverPatch(trip, { coverImage: null, tripName: "", memo: "  " });
    expect("coverImage" in next).toBe(false);
    expect("tripName" in next).toBe(false);
    expect("memo" in next).toBe(false);
  });

  it("无实际变化时返回原引用（调用方据此跳过多余 PUT）", () => {
    const trip = makeTrip({ coverImage: "uploads/t/c.jpg", tripName: "三亚", memo: "备忘" });
    expect(applyCoverPatch(trip, { tripName: " 三亚 ", memo: "备忘", coverImage: "uploads/t/c.jpg" })).toBe(
      trip,
    );
    expect(applyCoverPatch(trip, {})).toBe(trip);
    expect(applyCoverPatch(makeTrip(), { tripName: "", coverImage: null, memo: "" })).not.toBe(trip);
  });

  it("patch 未提供的字段保持原值", () => {
    const trip = makeTrip({ tripName: "旧名", memo: "旧备忘" });
    const next = applyCoverPatch(trip, { tripName: "新名" });
    expect(next.tripName).toBe("新名");
    expect(next.memo).toBe("旧备忘");
    expect(next.coverImage).toBeUndefined();
  });
});
