/**
 * Task #276：评测 UI 取证渲染器（非功能源码，仅供 playwright 截图）。
 *
 * 由 web/eval-ui.html 挂载，vite dev 直接服务 /eval-ui.html?scene=q1|q3。
 * 复用真实 VisitCard / EvidenceSheet 组件与 styles.css，用最小 mock 行程还原
 * 两条「报」判定用例的可视现场：
 * - scene=q1：西岛普通卡带一条绿色 snippet chip + 原文弱入口；点击 chip →
 *   EvidenceSheet 抽屉（原句 + 来源标题），对应 Q1「snippet 抽屉回看链路」。
 * - scene=q3：0 snippet 且无外部链接的卡 → 引用块与原文入口整体隐藏，
 *   对应 Q3「0 snippet 卡无原文入口」。
 *
 * 截图脚本见 eval/harness/uiShot.ts；产物落 eval-report/v1/evidence/{ID}.png（gitignore）。
 */

import React from "react";
import ReactDOM from "react-dom/client";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import type {
  Constraint,
  Day,
  GuideSource,
  Item,
  SourceEvidence,
  Stop,
  Trip,
  Visit,
} from "@goplay/shared";
import { recomputeDerivedFields } from "@goplay/shared";
import VisitCard from "./components/VisitCard";
import DayContent from "./components/DayContent";
// Task #293：Q7 真值表（与 eval/cases/v14Cases.ts buildQ7Trip 共用同一数据源；纯数据零 node 依赖）
// Task #297：新增父卡飞猪 mainPic 真值＋子点位 providerId 派生（对齐真实落盘 48275e19 形态）
import {
  Q7_IMAGE_COUNT,
  Q7_NOTE_ID,
  Q7_NOTE_TITLE,
  Q7_PARENT_MAINPIC,
  Q7_PARENT_PROVIDER_ID,
  Q7_POINTS,
  q7StopProviderId,
} from "../../eval/harness/q7Truth";
// Task #301：E9 亚龙湾「页面落位」真值表（与 eval/harness/uiShot.ts scene=e9 共用；纯数据零 node 依赖）
import {
  E9_NOTE_ID,
  E9_NOTE_TIPS,
  E9_NOTE_TITLE,
  E9_PARENT_MINUTES,
  E9_PARENT_NAME,
  E9_REGION_LABEL,
  E9_REGION_ORDER,
  E9_RECALL,
  E9_SUBSPOTS,
  e9ClaimsByRegion,
  type E9Region,
} from "../../eval/harness/e9Truth";
import "./styles.css";

const noop = (): void => {};

function makeItem(itemId: string, name: string, sourceEvidenceRefs: string[] = []): Item {
  return {
    itemId,
    name,
    origin: "custom",
    providerId: null,
    address: null,
    category: null,
    coords: null,
    suggestMinutes: null,
    mainPic: null,
    ticketInfo: null,
    jumpUrl: null,
    sourceEvidenceRefs,
  };
}

function makeVisit(visitId: string, pointRef: string, overrides: Partial<Visit> = {}): Visit {
  return {
    visitId,
    dayRef: "day_1",
    pointRef,
    kind: "ordinary",
    visitMode: "custom",
    order: 0,
    windowStart: null,
    windowEnd: null,
    startTime: "09:00",
    endTime: null,
    startTimeOverridden: false,
    endTimeOverridden: false,
    reservedMinutes: null,
    effectiveMinutes: 240,
    externalLeg: null,
    childStopRefs: [],
    alternateStopRefs: [],
    sourceMentionRefs: [],
    guideSnippets: [],
    purchaseState: "unknown",
    locked: false,
    userAdjusted: false,
    removedFrom: null,
    removedAt: null,
    ...overrides,
  };
}

function baseTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    tripId: "trip-eval-ui",
    schemaVersion: 2,
    version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: "2026-11-10", nights: 2 },
    dayRefs: ["day_1"],
    days: {
      day_1: {
        dayId: "day_1",
        dayIndex: 1,
        date: "2026-11-08",
        departTime: null,
        departTimeOverridden: false,
        scheduleVisitRefs: ["visit_xidao"],
        lodging: null,
      },
    },
    lodgings: {},
    itemRegistry: { item_xidao: makeItem("item_xidao", "西岛") },
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
  } as Trip;
}

/** Q1：西岛卡带 snippet + 外部原链来源，用于点击 chip 打开 EvidenceSheet 抽屉 */
function sceneQ1(): { trip: Trip; visit: Visit } {
  const evidence: SourceEvidence = {
    evidenceId: "ev_1",
    kind: "note_text",
    noteIndex: null,
    assetRef: null,
    sourceUrl: "https://www.xiaohongshu.com/explore/6a6812d3000000001101a289",
    ocrText: null,
    mentions: [
      {
        mentionId: "m_1",
        text: "",
        quoteText: "西岛渔村慢慢逛，别赶时间，走走拍拍大概2小时",
        bbox: null,
        extractedName: "西岛",
        locationHint: null,
        modelSummary: null,
      },
    ],
  };
  const source: GuideSource = {
    sourceId: "src_1",
    sourceVersion: 1,
    inputKind: "link",
    title: "西岛慢逛拍照攻略",
    sourceUrl: "https://www.xiaohongshu.com/explore/6a6812d3000000001101a289",
    canonicalUrl: "xhs://6a6812d3000000001101a289",
    active: true,
    status: "ready",
    evidenceRefs: ["ev_1"],
    mentionRefs: ["ev_1:m_1"],
    imageProgress: { total: 0, completed: 0, failed: 0, images: [] },
    importedAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    coverageText: "正文",
  };
  const visit = makeVisit("visit_xidao", "item_xidao", {
    sourceMentionRefs: ["ev_1:m_1"],
    guideSnippets: [
      {
        snippetId: "snip_1",
        text: "西岛渔村慢慢逛，走走拍拍约2小时",
        claimKind: "experience",
        sourceMentionRefs: ["ev_1:m_1"],
      },
    ],
  });
  const trip = baseTrip({
    itemRegistry: { item_xidao: makeItem("item_xidao", "西岛", ["ev_1"]) },
    visits: { visit_xidao: visit },
    evidences: { ev_1: evidence },
    guideSources: { src_1: source },
  });
  return { trip, visit };
}

/** Q3：0 snippet、无外部链接来源的卡 → 引用块与原文入口整体隐藏 */
function sceneQ3(): { trip: Trip; visit: Visit } {
  const visit = makeVisit("visit_xidao", "item_xidao", {
    sourceMentionRefs: [],
    guideSnippets: [],
  });
  const trip = baseTrip({
    itemRegistry: { item_xidao: makeItem("item_xidao", "西岛", []) },
    visits: { visit_xidao: visit },
    evidences: {},
    guideSources: {},
  });
  return { trip, visit };
}

// ===== Q7：西岛点位配图（Task #196 页码配图渲染现场，与 eval/cases/v14Cases.ts buildQ7Trip 同构）=====
// Task #293（修 #288「评测假绿」）：页码/原句一律取 eval/harness/q7Truth.ts 真值表（笔记
// 真实 PX 标注：p4 p5／p6／p2 p8 p9／p1 p3／小吃街无标注／p11 p12 p13／p16 p17／p14 15→产品口径 [14]），
// 废除旧 `Q7_PAGE_START(3)+序号` 顺序伪造。西岛笔记抓取产物 18 张落 server/uploads/xhs_6ace31c6…；
// 每点位 mention.pageRefs → imageProgress 槽位 → assetPath → StopRow `/api/${path}` 小图；
// 「小吃街」为真实无标注点位，验证「无对应图回退默认占位且不报错」（ImagePlaceholder .ph-tile）。

function sceneQ7(): { trip: Trip; visit: Visit } {
  const evidenceId = "ev_q7";
  const mentions = Q7_POINTS.map((point, index) => ({
    mentionId: `m${index}`,
    text: point.name,
    // 笔记原句逐字（真值表）；无专属原句的点位（小吃街）＝空串，不得编造
    quoteText: point.quoteText ?? "",
    bbox: null,
    extractedName: point.name,
    locationHint: null,
    modelSummary: null,
    // 真实 PX 标注页码；无标注点位不带 pageRefs（自然无绑定→回退占位）
    ...(point.pageRefs.length > 0 ? { pageRefs: [...point.pageRefs] } : {}),
  }));
  const evidence: SourceEvidence = {
    evidenceId,
    kind: "note_text",
    noteIndex: 31,
    assetRef: null,
    sourceUrl: `https://www.xiaohongshu.com/explore/${Q7_NOTE_ID}`,
    ocrText: mentions.map((mention) => mention.quoteText).filter((text) => text !== "").join("\n"),
    mentions,
  };
  const total = Q7_IMAGE_COUNT;
  const source: GuideSource = {
    sourceId: "src_q7",
    sourceVersion: 1,
    inputKind: "link",
    active: true,
    status: "ready",
    title: Q7_NOTE_TITLE,
    sourceUrl: `https://www.xiaohongshu.com/explore/${Q7_NOTE_ID}`,
    canonicalUrl: `xhs://${Q7_NOTE_ID}`,
    evidenceRefs: [evidenceId],
    mentionRefs: mentions.map((mention) => `${evidenceId}:${mention.mentionId}`),
    imageProgress: {
      total,
      completed: total,
      failed: 0,
      images: Array.from({ length: total }, (_unused, position) => ({
        index: position + 1,
        status: "ready" as const,
        evidenceId,
        assetPath: `uploads/xhs_${Q7_NOTE_ID}/${position + 1}.jpg`,
      })),
    },
    importedAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    coverageText: "正文与 18 张图",
  };
  const stopIds = Q7_POINTS.map((_point, index) => `stop_q7_${index}`);
  // Task #297：与 buildQ7Trip 同构——父卡西岛对齐真实落盘形态（origin=fliggy＋真实 mainPic），
  // 8 子点位命中飞猪 Item 但 mainPic=null（复刻真实「命中飞猪无图→PX 回退」形态）。
  const parentItemId = "item_q7_xidao";
  const parentItem: Item = {
    ...makeItem(parentItemId, "西岛", [evidenceId]),
    origin: "fliggy",
    providerId: Q7_PARENT_PROVIDER_ID,
    mainPic: Q7_PARENT_MAINPIC,
  };
  const stopItemIds = Q7_POINTS.map((_point, index) => `item_q7_stop_${index}`);
  const itemRegistry: Record<string, Item> = { [parentItemId]: parentItem };
  Q7_POINTS.forEach((point, index) => {
    itemRegistry[stopItemIds[index]!] = {
      ...makeItem(stopItemIds[index]!, point.name, [evidenceId]),
      origin: "fliggy",
      providerId: q7StopProviderId(index),
      mainPic: null,
    };
  });
  const visit = makeVisit("visit_xidao", parentItemId, {
    kind: "large_attraction",
    visitMode: "half_day",
    effectiveMinutes: Q7_POINTS.length * 15,
    childStopRefs: stopIds,
    sourceMentionRefs: [],
  });
  const stops: Record<string, Stop> = {};
  Q7_POINTS.forEach((point, index) => {
    stops[stopIds[index]!] = {
      stopId: stopIds[index]!,
      state: "attached",
      visitRef: "visit_xidao",
      suggestedVisitRef: null,
      // Task #297：命中飞猪 Item（customName 置空，显示名走主数据名＝point.name）
      matchedPointRef: stopItemIds[index]!,
      customName: null,
      order: index,
      suggestMinutes: null,
      locationHint: null,
      ticketRelation: "unknown",
      sourceEvidenceRefs: [evidenceId],
      sourceMentionRefs: [`${evidenceId}:m${index}`],
      guideSnippets: [],
      userAdjusted: false,
      removedFromOrder: null,
      removedAt: null,
    };
  });
  const trip = baseTrip({
    itemRegistry,
    visits: { visit_xidao: visit },
    stops,
    evidences: { [evidenceId]: evidence },
    guideSources: { src_q7: source },
  });
  return { trip, visit };
}

// ===== E9：亚龙湾「页面落位」现场（Task #301，与 eval/harness/e9Truth.ts + uiShot scene=e9 同构）=====
// 用 #301 重抽结果（#300 归属下沉生效）构造 large_attraction 父卡＋9 子点位行程，渲染真实 VisitCard；
// 下方附「E9 落位对照」面板：11 条 golden claim 按 4 个真实 UI 区域分组（父卡时长详情/父卡攻略提示区/
// 子点位详情行/子点位贴士区），逐条标注候选实体·sim·机器判定→PD 裁量·落位归因，并给出 9 条 note_tip
// 归属全貌（7 父卡/2 下沉）。重点：YLW-06 过江龙索桥下沉后落子点位详情行、YLW-08 玻璃栈道落下沉贴士区。

function sceneE9(): { trip: Trip; visit: Visit } {
  const evidenceId = "ev_e9";
  const mentions = E9_NOTE_TIPS.map((tip) => ({
    mentionId: tip.tipId,
    text: tip.name,
    quoteText: tip.quote,
    bbox: null,
    extractedName: tip.name,
    locationHint: null,
    modelSummary: tip.summary,
  }));
  const evidence: SourceEvidence = {
    evidenceId,
    kind: "note_text",
    noteIndex: null,
    assetRef: null,
    sourceUrl: `https://www.xiaohongshu.com/explore/${E9_NOTE_ID}`,
    ocrText: E9_NOTE_TIPS.map((tip) => tip.quote).join("\n"),
    mentions,
  };
  const source: GuideSource = {
    sourceId: "src_e9",
    sourceVersion: 1,
    inputKind: "link",
    active: true,
    status: "ready",
    title: E9_NOTE_TITLE,
    sourceUrl: `https://www.xiaohongshu.com/explore/${E9_NOTE_ID}`,
    canonicalUrl: `xhs://${E9_NOTE_ID}`,
    evidenceRefs: [evidenceId],
    mentionRefs: mentions.map((m) => `${evidenceId}:${m.mentionId}`),
    imageProgress: { total: 0, completed: 0, failed: 0, images: [] },
    importedAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    coverageText: "正文",
  };
  const parentItemId = "item_e9_ylw";
  const parentItem: Item = { ...makeItem(parentItemId, E9_PARENT_NAME, [evidenceId]), suggestMinutes: E9_PARENT_MINUTES };
  const stopIds = E9_SUBSPOTS.map((_spot, index) => `stop_e9_${index}`);
  const stopItemIds = E9_SUBSPOTS.map((_spot, index) => `item_e9_stop_${index}`);
  const itemRegistry: Record<string, Item> = { [parentItemId]: parentItem };
  E9_SUBSPOTS.forEach((spot, index) => {
    itemRegistry[stopItemIds[index]!] = makeItem(stopItemIds[index]!, spot.name, [evidenceId]);
  });
  // 父卡攻略提示区：7 条归属父景点的 note_tip（VisitCard Module C 合并引用块，chips 展示上限 2）
  const parentSnippets = E9_NOTE_TIPS.filter((tip) => !tip.sunk).map((tip, index) => ({
    snippetId: `snip_e9_parent_${index}`,
    text: tip.summary,
    claimKind: "tip" as const,
    sourceMentionRefs: [`${evidenceId}:${tip.tipId}`],
  }));
  const visit = makeVisit("visit_ylw", parentItemId, {
    kind: "large_attraction",
    visitMode: "half_day",
    effectiveMinutes: E9_PARENT_MINUTES,
    childStopRefs: stopIds,
    guideSnippets: parentSnippets,
    sourceMentionRefs: [],
  });
  const stops: Record<string, Stop> = {};
  E9_SUBSPOTS.forEach((spot, index) => {
    // 子点位贴士区：#300 下沉到该子景点的 note_tip（玻璃栈道/试婚房）
    const sunkForSpot = E9_NOTE_TIPS.filter((tip) => tip.sunk && tip.sunkTo === spot.name);
    stops[stopIds[index]!] = {
      stopId: stopIds[index]!,
      state: "attached",
      visitRef: "visit_ylw",
      suggestedVisitRef: null,
      matchedPointRef: stopItemIds[index]!,
      customName: null,
      order: index,
      suggestMinutes: spot.suggestMinutes,
      // 子点位详情行：in_attraction 的 summary（承载 YLW-02/03/04/06 的子景点描述）
      locationHint: spot.summary,
      ticketRelation: "unknown",
      sourceEvidenceRefs: [evidenceId],
      sourceMentionRefs: [],
      guideSnippets: sunkForSpot.map((tip, j) => ({
        snippetId: `snip_e9_sunk_${index}_${j}`,
        text: tip.summary,
        claimKind: "risk" as const,
        sourceMentionRefs: [`${evidenceId}:${tip.tipId}`],
      })),
      userAdjusted: false,
      removedFromOrder: null,
      removedAt: null,
    };
  });
  const trip = baseTrip({
    itemRegistry,
    visits: { visit_ylw: visit },
    stops,
    evidences: { [evidenceId]: evidence },
    guideSources: { src_e9: source },
  });
  return { trip, visit };
}

/** E9 落位对照面板：按 4 个真实 UI 区域分组，逐条标注候选实体/sim/机器判定→PD 裁量/归因 */
function E9MappingPanel(): React.ReactElement {
  const boxStyle: React.CSSProperties = { marginTop: 16, border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, background: "#fff" };
  const regionStyle: React.CSSProperties = { marginTop: 12 };
  const regionHeadStyle: React.CSSProperties = { fontSize: 13, fontWeight: 700, color: "#0f172a", borderBottom: "1px dashed #cbd5e1", paddingBottom: 4, marginBottom: 6 };
  const rowStyle: React.CSSProperties = { fontSize: 12, lineHeight: 1.5, padding: "6px 0", borderTop: "1px solid #f1f5f9" };
  const pillHit: React.CSSProperties = { display: "inline-block", padding: "0 6px", borderRadius: 6, background: "#dcfce7", color: "#166534", fontWeight: 700 };
  const pillPd: React.CSSProperties = { display: "inline-block", padding: "0 6px", borderRadius: 6, background: "#fef9c3", color: "#854d0e", fontWeight: 700 };
  return (
    <div data-e9-mapping style={boxStyle}>
      <div style={{ fontSize: 14, fontWeight: 800, color: "#0f172a" }}>
        E9 落位对照（Task #301 重抽·#300 归属下沉生效）
      </div>
      <div data-e9-recall style={{ fontSize: 12, color: "#475569", marginTop: 4 }}>
        机器 recall {E9_RECALL.machineHits}/{E9_RECALL.total}={E9_RECALL.machineRecall.toFixed(3)}（未达阈值 {E9_RECALL.threshold}）→
        PD 裁量 {E9_RECALL.pdAdjudicatedCount} 条 boundary（{E9_RECALL.pdAdjudicatedIds.join("/")}）全判命中 →
        {" "}{E9_RECALL.total}/{E9_RECALL.total}={E9_RECALL.finalRecall.toFixed(3)} ≥ {E9_RECALL.threshold} → <b>pass</b>
      </div>
      <div data-e9-tipdist style={{ fontSize: 12, color: "#475569", marginTop: 2 }}>
        note_tip 归属全貌：{E9_RECALL.parentTipCount} 条父卡攻略提示 ＋ {E9_RECALL.sunkTipCount} 条下沉子点位贴士区
        （#300 预测 {E9_RECALL.predictedSunkCount} 条下沉；过江龙索桥排队信息被抽取器直接并入 in_attraction 子景点，无独立 note_tip 可下沉）
      </div>
      {E9_REGION_ORDER.map((region: E9Region) => {
        const claims = e9ClaimsByRegion(region);
        return (
          <div key={region} data-e9-region={region} style={regionStyle}>
            <div style={regionHeadStyle}>
              {E9_REGION_LABEL[region]}（{claims.length} 条）
            </div>
            {claims.map((c) => (
              <div key={c.claimId} data-claim-id={c.claimId} data-region={c.region} data-entity={c.matchedEntity} style={rowStyle}>
                <div>
                  <b>{c.claimId}</b>（{c.kind}）→ <span data-claim-entity>{c.matchedEntity}</span>
                  <span style={{ color: "#64748b" }}>[{c.entityType}]</span> sim=<span data-claim-sim>{c.sim}</span>{" "}
                  {c.pdAdjudicated ? (
                    <span style={pillPd}>机器{c.machineDecision}→PD裁量HIT</span>
                  ) : (
                    <span style={pillHit}>机器HIT</span>
                  )}
                </div>
                <div style={{ color: "#334155" }}>golden：{c.goldenText}</div>
                <div style={{ color: "#64748b" }}>{c.note}</div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function renderE9(trip: Trip, visit: Visit): React.ReactElement {
  return (
    <div className="app">
      <div style={{ maxWidth: 440, margin: "0 auto", padding: 12 }}>
        <DndContext>
          <SortableContext items={[visit.visitId]}>
            <VisitCard
              trip={trip}
              visit={visit}
              isFirst
              index={0}
              total={1}
              onMoveItem={noop}
              selectMode={false}
              selected={false}
              onToggleSelect={noop}
              onRemove={noop}
              onPurchaseSelect={noop}
              onToggleLock={noop}
              onMoveStop={noop}
              onRemoveStop={noop}
              onRestoreStop={noop}
              onAddStop={noop}
              onOpenStopEvidence={noop}
            />
          </SortableContext>
        </DndContext>
        <E9MappingPanel />
      </div>
    </div>
  );
}

function renderCard(trip: Trip, visit: Visit): React.ReactElement {
  return (
    <div className="app">
      <div style={{ maxWidth: 420, margin: "0 auto", padding: 16 }}>
        <DndContext>
          <SortableContext items={[visit.visitId]}>
            <VisitCard
              trip={trip}
              visit={visit}
              isFirst
              index={0}
              total={1}
              onMoveItem={noop}
              selectMode={false}
              selected={false}
              onToggleSelect={noop}
              onRemove={noop}
              onPurchaseSelect={noop}
              onToggleLock={noop}
              onMoveStop={noop}
              onRemoveStop={noop}
              onRestoreStop={noop}
              onAddStop={noop}
              onOpenStopEvidence={noop}
            />
          </SortableContext>
        </DndContext>
      </div>
    </div>
  );
}

const scene = new URLSearchParams(window.location.search).get("scene") ?? "q1";

/** S5：时间来源标签限场景展示（DayContent 锚点行灰字取证） */
function sceneS5(): { trip: Trip; day: Day } {
  const constraints: Constraint[] = [
    { constraintId: "c_arr", type: "flight_arrive", anchorTime: "2026-11-08T09:40:00", dayIndex: 1, label: "MU5831 落地 09:40", locked: true },
    { constraintId: "c_dep", type: "flight_depart", anchorTime: "2026-11-12T18:00:00", dayIndex: 5, label: "MU5832 起飞 18:00", locked: true },
  ];
  const dayRefs = ["day_1", "day_2", "day_3", "day_4", "day_5"];
  const days: Record<string, Day> = {};
  for (let i = 1; i <= 5; i++) {
    days[`day_${i}`] = {
      dayId: `day_${i}`, dayIndex: i, date: `2026-11-${String(7 + i).padStart(2, "0")}`,
      departTime: "09:00", departTimeOverridden: i === 3, scheduleVisitRefs: [], lodging: null,
    };
  }
  const lodgings: Record<string, any> = {};
  for (let i = 1; i <= 4; i++) {
    lodgings[String(i)] = { dayIndex: i, areaName: "海棠湾", hotelRefs: [], checkInTime: null, checkOutTime: null, purchaseState: "unknown", locked: false, userAdjusted: false };
  }
  const trip = {
    tripId: "trip-eval-s5", schemaVersion: 2, version: 1,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: "2026-11-12", nights: 4 },
    dayRefs, days, lodgings,
    itemRegistry: {}, hotelRegistry: {}, visits: {}, stops: {}, evidences: {},
    globalCandidateRefs: [], pendingStopRefs: [], relationshipSuggestions: {},
    guideSources: {}, constraints,
    createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
  } as unknown as Trip;
  recomputeDerivedFields(trip);
  return { trip, day: trip.days["day_1"] };
}

function renderDayContent(trip: Trip, day: Day): React.ReactElement {
  return (
    <div className="app">
      <div style={{ maxWidth: 420, margin: "0 auto", padding: 8 }}>
        <DayContent
          trip={trip}
          day={day}
          onOpenNoteInput={noop}
          onRemoveVisit={noop}
          onBatchRemove={noop}
          onPurchaseSelect={noop}
          onToggleLock={noop}
          onLodgingPurchaseSelect={noop}
          onToggleLodgingLock={noop}
          onUpdateDepart={noop}
          onReorderDayItems={noop}
          onMoveDayItem={noop}
          onMoveStop={noop}
          onRemoveStop={noop}
          onRestoreStop={noop}
          onAddStop={noop}
          onSearchHotels={noop}
          onRemoveHotel={noop}
        />
      </div>
    </div>
  );
}

let root: React.ReactElement;
if (scene === "s5") {
  const { trip, day } = sceneS5();
  root = renderDayContent(trip, day);
} else if (scene === "q7") {
  const { trip, visit } = sceneQ7();
  root = renderCard(trip, visit);
} else if (scene === "e9") {
  const { trip, visit } = sceneE9();
  root = renderE9(trip, visit);
} else {
  const { trip, visit } = scene === "q3" ? sceneQ3() : sceneQ1();
  root = renderCard(trip, visit);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{root}</React.StrictMode>,
);
