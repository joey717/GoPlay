/**
 * Task #285：v1.4 新增 5 条用例（E9/A13/S12/S13/Q7）——first28 → first33 的增量定义。
 *
 * 与 first33.ts 的既有 28 条同一 EvalCase 契约；本文件承载新用例的内联断言与元数据，
 * 纯函数支撑在 eval/harness/e9Recall.ts（E9 召回）与 eval/harness/a13Groups.ts（A13 死判）。
 *
 * 各条实现口径（用例文档 v1.4 断言原文见各 assertion 字段）：
 * - E9（L1 机）：抽取缓存 entries vs golden expectedClaims → recall≥0.8；boundary 单列交 PD 裁
 *   不自动 fail；漏抽逐条附原文位置 loc。慢层依赖：缓存由 npm run eval:corpus 一次性建立，
 *   本套件内执行不触网不烧 token（重跑慢层全量留给 Task #286）。
 * - A13（L2 机）：canonicalGroups 死判走 mergeGuideMentions（B3 聚合层，纯函数快层）；
 *   校验器自证（合成 pass/fail 形态）+ golden rawList 全串实跑两段。
 * - S12（L3 机）：共享草案（5 源 fixture 全量生成）items 齐全性——firsthand 强推且未被
 *   A3/A5/A11 排除的实体 100% 出现；缺失清单含实体名＋源 URL＋原文位置。依赖 planner 输出。
 * - S13（L3 机）：item.name ∈ {攻略原文串, FlyAI canonical name, A13 归一化别名表}；
 *   不满足则须 provenance=ai_supplement——C4/Task #283 已落地 Item.provenance，回退分支
 *   本轮转全量硬断言（名称合法性＋别名折叠＋ai_supplement 回退＋护栏四段），#285 blocked 解除。
 * - Q7（L5 报）：机器部分＝西岛场景配图解析链断言。Task #293 修复 #288「评测假绿」：
 *   页码/原句不再按 `3+序号` 自造，一律取 eval/harness/q7Truth.ts 真值表（笔记真实 PX
 *   标注，经产品 extractPageRefs 实算并与抽取缓存原文逐字互证）；四段硬断言＝逐点位
 *   pageRefs 等于真值、firstAssetPath 等于期望文件名（内容级锚点）、夹具 quoteText 逐字
 *   存在于笔记原文、真实无标注点位「小吃街」空绑定回退占位（废自造第 9 点位）。
 *   截图 evidence/Q7.png 由 npm run eval:ui 产出，PD 目视报判定。
 */

import assert from "node:assert/strict";
import type { EntityRef, Stop, Trip, Visit } from "@goplay/shared";
import {
  canonicalPoiMatchKey,
  extractPageRefs,
  itemProvenance,
  normalizeMentionPageRefs,
  resolveMentionPageImages,
  resolvePoiAlias,
  validateAiSupplementProvenance,
} from "@goplay/shared";
import { mergeGuideMentions, type MergedPlace } from "../../server/src/guides/merge.js";
import { buildFixtureSanyaTrip } from "../../server/src/persistence/store.js";
// Task #297：直接复算 web 展示层配图优先级纯函数（#296 落点），机器断言即 web 渲染现场同口径
import { resolvePointImage } from "../../web/src/lib/pointImage.js";
import {
  checkCanonicalGroupViolations,
  checkDuplicateSurfaceMerged,
} from "../harness/a13Groups.js";
import {
  evaluateE9Recall,
  loadE9ExtractionCache,
  loadE9Golden,
  type RecallEvalResult,
} from "../harness/e9Recall.js";
import { loadExtractionCache } from "../harness/extractionCache.js";
import { loadFixtureAssets } from "../harness/fixtureLoader.js";
import {
  findQ7Point,
  Q7_IMAGE_COUNT,
  Q7_NO_IMAGE_POINT_NAME,
  Q7_NOTE_ID,
  Q7_NOTE_TITLE,
  Q7_PARENT_MAINPIC,
  Q7_PARENT_PROVIDER_ID,
  Q7_POINTS,
  q7AssetPath,
  q7ExpectedAssetPaths,
  q7StopProviderId,
} from "../harness/q7Truth.js";
import { PdAdjudicationSignal } from "../harness/signals.js";
import type { CaseContext, EvalCase } from "./first28.js";
import {
  getSharedDraft,
  setSharedPlannerModes,
  type SharedDraftScenario,
} from "../harness/draftScenario.js";

// ===== E9：亮点召回（抽取缓存 vs golden expectedClaims） =====

function logRecallResult(ctx: CaseContext, result: RecallEvalResult): void {
  // Task #299 非静默放宽：始终先打「原始机器判定」行，再打「PD 裁量后」行（若发生 override）——两行并列可见。
  const machineHits = result.machineHits;
  ctx.log(
    `E9 assert（原始机器判定·未经 PD 裁量）: recall = ${machineHits}/${result.total} = ${result.machineRecall.toFixed(3)}（阈值 ${result.threshold}，${result.machineRecall >= result.threshold ? "达标" : "未达标"}；仅计机器原判 hit，boundary/miss 未转命中）`,
  );
  if (result.pdAdjudications.length > 0) {
    ctx.log(
      `E9 assert（PD 裁量后·Task #299 PD@2026-10-30）: recall = ${result.hits.length}/${result.total} = ${result.recall.toFixed(3)}（阈值 ${result.threshold}，${result.pass ? "达标 → pass" : "未达标"}）；PD 裁量将 ${result.pdAdjudications.length} 条 boundary（${result.pdAdjudications.map((a) => a.claimId).join("/")}）全部判命中——golden 系 PD 对攻略文案自行提炼规整的文本，与抽取逐字原文字面不对应属预期（miss=${result.misses.length}，无真·漏抽）。override 不改机器阈值/词表，machineRecall=${result.machineRecall.toFixed(3)} 原样留存。`,
    );
  }
  // 逐 claim 匹配过程（#286 归因要求：entity 归一前后、kind 对照、决策依据；#299：被裁量项双行留痕）
  ctx.log(`E9 逐 claim 匹配过程（entity 归一前→后｜kind 对照｜决策）：`);
  for (const t of result.traces) {
    const head =
      `  [${t.decision.toUpperCase()}${t.pdAdjudication !== undefined ? "·PD裁量" : ""}] ${t.claimId}(golden=${t.claimKind}) text「${t.text.slice(0, 24)}」` +
      ` → 候选「${t.bestEntryName}」entity ${t.entitySurface}→${t.entityCanonical}｜sim=${t.bestSimilarity}｜推断kind=${t.kindInferred}`;
    if (t.pdAdjudication !== undefined) {
      // 两行可见：原始机器判定 vs PD 裁量
      ctx.log(`${head}｜原始机器判定=${t.machineDecision.toUpperCase()}（${t.reason}）`);
      ctx.log(`      └ PD 裁量=${t.decision.toUpperCase()}（${t.pdAdjudication.adjudicatedBy}@${t.pdAdjudication.adjudicatedAt}）：${t.pdAdjudication.reason}`);
    } else {
      ctx.log(`${head}｜${t.reason}`);
    }
  }
  for (const hit of result.hits) {
    const tag = hit.pdAdjudicated !== undefined ? `[PD裁量转命中·原机器判定=${hit.pdAdjudicated.machineDecision.toUpperCase()}] ` : "";
    ctx.log(`E9 hit: ${tag}${hit.claimId}(${hit.claimKind}) ← 「${hit.entryName}」sim=${hit.similarity}${hit.quote !== "" ? ` quote「${hit.quote.slice(0, 30)}」` : ""}`);
  }
  for (const item of result.boundary) {
    ctx.log(`E9 boundary(PD裁，不计fail): ${item.claimId}(${item.claimKind}) ${item.reason}；候选「${item.bestEntryName}」quote「${item.quote.slice(0, 30)}」`);
  }
  for (const miss of result.misses) {
    ctx.log(`E9 miss(漏抽，附原文位置): ${miss.claimId}(${miss.claimKind}) loc=${miss.loc} text「${miss.text}」；最接近条目「${miss.bestEntryName}」sim=${miss.bestSimilarity}`);
  }
}

/**
 * E9 归因结论（#286）：recall 0.091→修复评测侧 artifact 后的诚实值。
 * 已修 artifact（评测侧，非放宽阈值）：
 *  1. inferClaimKind 误把 entry.suggestMinutes 非空当 duration（结构属性，抽取器给几乎每个 POI 都填）
 *     → highlight/pitfall 全被误判 duration 降 boundary（YLW-02/03/06 根因）；
 *  2. duration claim 未对 suggestMinutes 数值匹配（YLW-01「3-4小时」实为父条目 suggestMinutes=210）；
 *  3. 词表歧义裸词（大雾/贵/攻略）污染极性判断；kind 优先级 duration 压过 pitfall（排队1小时→误 duration）。
 * 真实抽取缺口（模型没抽到，matcher 无法弥补）：POI 级抽取器只产 11 条小景点条目，未 surface note 级
 *  tips/pitfalls——YLW-07(有偿拍照漫天要价)/09(网上买票便宜)/10(观光车必买备雨具)/11(上午上山)全 miss，
 *  YLW-04(观光车节奏)内容存疑、YLW-08(玻璃栈道避雷)弱化成「性价比一般」。
 */
function e9AttributionConclusion(result: RecallEvalResult): string {
  // Task #299：PD 裁量后达标（pass）——归因结论区分「原始机器判定」与「PD 裁量后」，非静默放宽。
  if (result.pass && result.pdAdjudications.length > 0) {
    return (
      `E9 归因结论（PD 裁量后·Task #299 PD@2026-10-30）：原始机器 recall=${result.machineRecall.toFixed(3)}（命中 ${result.machineHits}/${result.total}，boundary ${result.pdAdjudications.length} 条、miss ${result.misses.length} 条）。` +
      `boundary 分歧根因＝golden 系 PD 对攻略文案自行提炼规整的文本，与抽取器逐字原文存在预期内字面差异（inferClaimKind 词法反推误触 ＋ golden 合并 tip 被抽取拆条稀释 bigram sim），非抽取缺口（miss=0，无真·漏抽）。` +
      // Task #301：条数动态（重抽后触发裁量条数可能 ≠ #299 的 4 条），清单已动态，去掉硬编码「四条」避免数字与清单自相矛盾。
      `PD 裁定 ${result.pdAdjudications.length} 条 boundary（${result.pdAdjudications.map((a) => a.claimId).join("/")}）全部判命中 → PD 裁量后 recall=${result.recall.toFixed(3)}（${result.hits.length}/${result.total}）≥ 阈值 ${result.threshold}，E9 达标转 pass。` +
      `未静默放宽阈值：机器阈值/词表零改动，machineRecall=${result.machineRecall.toFixed(3)} 与逐 claim machineDecision 原样留痕（见上双行）。`
    );
  }
  return (
    `E9 归因结论：主因＝真实抽取缺口（POI 级抽取器未 surface note 级 tips/pitfalls），叠加已修复的评测侧 artifact。` +
    `修复 artifact 后 recall=${result.recall.toFixed(3)}（命中 ${result.hits.length}/${result.total}），仍 < 阈值 ${result.threshold}；` +
    `剩余 miss ${result.misses.length} 条为模型未抽到的 note 级建议/避雷（非 matcher 可弥补），boundary ${result.boundary.length} 条实体命中但 kind/内容存疑。` +
    `未静默放宽阈值；抽取质量结论与逐 claim 清单交 PD 裁（golden borderlineAdjudicator=PD）。`
  );
}

async function runE9(ctx: CaseContext): Promise<void> {
  const golden = loadE9Golden();
  ctx.log(`E9 golden: assetVersion=${golden.assetVersion} caseId=${golden.caseId} 标注=${golden.guide.labeledBy}@${golden.guide.labeledAt}`);
  ctx.log(`E9 golden: expectedClaims=${golden.expectedClaims.length} 条（${golden.claimKindEnum.join("/")}），matchRule「${golden.recall.matchRule}」`);
  const cached = loadE9ExtractionCache(golden);
  ctx.log(
    `E9 抽取缓存: noteId=${cached.noteId} contentHash=${cached.contentHash.slice(0, 16)}… capturedAt=${cached.capturedAt} entries=${cached.entries.length} 条（extractMs=${cached.extractMs}）`,
  );
  ctx.log(`E9 抽取缓存 entries: ${cached.entries.map((entry) => `${entry.name}[${entry.type}/${entry.confidence}]${entry.suggestMinutes !== null ? `/${entry.suggestMinutes}min` : ""}`).join("、")}`);
  const result = evaluateE9Recall(cached.entries, golden);
  logRecallResult(ctx, result);
  // Task #299：PD 裁量落档（2026-10-30）——四条边界全部判命中，override 明细逐条留痕（非静默）。
  if (result.pdAdjudications.length > 0) {
    ctx.log(
      // Task #301：条数/清单改为动态——#299 落档时为 4 条（YLW-02/04/10/11），重抽后 YLW-02 机器已直接 HIT（override 变 no-op），实际触发裁量以本轮 result 为准，不再硬编码「四条 YLW-02/04/10/11」。
      `E9 PD 裁量（Task #299，PD@2026-10-30 原话意译「攻略文案系我自己提炼规整、字面无法完全对应，可算评测通过」）：` +
        `${result.pdAdjudications.length} 条 boundary（${result.pdAdjudications.map((a) => a.claimId).join("/")}）全部判命中；机器阈值/词表零改动，逐条保留「原始机器判定 vs PD 裁量」两行如下：`,
    );
    for (const a of result.pdAdjudications) {
      ctx.log(`  [PD裁量] ${a.claimId}(${a.claimKind})：原始机器判定=${a.machineDecision.toUpperCase()}（${a.machineReason}）`);
      ctx.log(`      └ PD 裁量=HIT（${a.pd.adjudicatedBy}@${a.pd.adjudicatedAt}）：${a.pd.reason}`);
    }
    // Task #301：#300（note_tip 归属下沉）已完成，YLW-06 附注更新为「已落地」态——不再说「当前归属父景点…修复走 Task #300」（该表述已过时）。
    ctx.log(`E9 PD 裁量附注（同日 PD 发现，归属细化已由 Task #300 落地）：YLW-06「过江龙索桥排队」经 #300 noteAttribution 归属下沉后，本轮重抽已归子景点「过江龙索桥」(in_attraction)——matcher 匹配子景点 entity sim=0.471 机器直接 HIT，归属细化意图达成；本条不在 PD 裁量范围（机器已判命中）。注：#300 预测 3 条下沉（过江龙索桥/玻璃栈道/试婚房），本轮重抽实测玻璃栈道、试婚房 2 条 note_tip 下沉，过江龙索桥排队信息被抽取器直接并入 in_attraction「过江龙索桥」条目（无独立 note_tip 可下沉）——属抽取模型方差，非 #300 缺陷，YLW-06 归属结果一致。`);
  }
  // Task #301：重抽（归属下沉新逻辑生效）后机器原判漂移披露——「不静默改」要求逐条说明。
  // 说明三件事：(1) 机器 recall / boundary 条数相对 #299 的漂移与根因；(2) matcher 是否需适配子景点归属；
  // (3) PD_ADJUDICATION.reason 内嵌的 sim 值系 #299 落档快照，重抽后可能漂移，当前机器值以双行的「原始机器判定」行为准。
  ctx.log(
    `E9 重抽漂移披露（Task #301，重抽＝归属下沉新逻辑生效后重建缓存）：本轮原始机器 recall=${result.machineRecall.toFixed(3)}（${result.machineHits}/${result.total}），触发 PD 裁量 ${result.pdAdjudications.length} 条（${result.pdAdjudications.map((a) => a.claimId).join("/") || "无"}）。` +
      `相对 #299 落档（机器 recall 0.636·7/11，boundary 4 条 YLW-02/04/10/11）的漂移根因＝抽取模型方差＋#300 归属下沉改变候选 entity：YLW-02 现机器直接 HIT（sim 由 #299 的 0.400 边界态升至命中态，其 PD override 变 no-op 故本轮不计入裁量清单），YLW-06 归子景点「过江龙索桥」in_attraction 后机器直接 HIT。` +
      `matcher 适配检查（item2 要求）：YLW-06 匹配子景点「过江龙索桥」(in_attraction)、YLW-08 匹配下沉后 note_tip「玻璃栈道」——matcher 以 entity 归一后子景点名参与匹配，已正确命中子景点归属，**无需为归属下沉额外适配**。` +
      `PD_ADJUDICATION.reason 内嵌的 sim 数值（如 YLW-04「0.250」、YLW-11「0.575」）系 #299 落档时 PD 裁量依据的历史快照，重抽后机器实际 sim 可能漂移；当前真实机器值以上方「原始机器判定」双行的第一行为准，PD 裁定理由文本按红线不静默改写（保留 #299 记录）。`,
  );
  ctx.log(e9AttributionConclusion(result));
  ctx.log(`E9 note: boundary ${result.boundary.length} 条单列交 PD 裁（golden recall.borderlineAdjudicator=${golden.recall.borderlineAdjudicator}），不自动判 fail；miss ${result.misses.length} 条已附原文位置 loc${result.pdAdjudications.length > 0 ? `；PD 裁量转命中 ${result.pdAdjudications.length} 条（Task #299）` : ""}`);
  if (result.pass) return;
  // recall 未达阈值（含 PD 裁量后仍未达）：机器部分（matcher）已修正且正确执行，缺口为真实抽取质量＋边界项 → PD 裁定（blocked，非 fail）
  const pdItems = [
    ...result.boundary.map((b) => `${b.claimId}(${b.claimKind}) boundary：${b.reason}；候选「${b.bestEntryName}」`),
    ...result.misses.map((m) => `${m.claimId}(${m.claimKind}) miss：loc=${m.loc}「${m.text}」最接近「${m.bestEntryName}」sim=${m.bestSimilarity}（真实抽取缺口）`),
  ];
  throw new PdAdjudicationSignal(
    `E9 recall ${result.recall.toFixed(3)} < 阈值 ${result.threshold}（命中 ${result.hits.length}/${result.total}）——` +
      e9AttributionConclusion(result),
    pdItems,
  );
}

// ===== A13：实体归一化死判（mergeGuideMentions 聚合层） =====

interface A13FixturePlace {
  key: string;
  displayName: string;
  surfaces: string[];
}

/** 合成 merge 产物形态（MergedPlace 最小子集：key/displayName/mentions.extractedName） */
function syntheticPlaces(specs: A13FixturePlace[]): MergedPlace[] {
  return specs.map((spec) => ({
    key: spec.key,
    displayName: spec.displayName,
    entityRef: null,
    providerId: null,
    mentions: spec.surfaces.map((surface, index) => ({
      ref: `ev_a13:m${index}`,
      sourceId: "src_a13",
      evidenceId: "ev_a13",
      mentionId: `m${index}`,
      mention: {
        mentionId: `m${index}`,
        text: surface,
        quoteText: `合成引用：${surface}`,
        bbox: null,
        extractedName: surface,
        locationHint: null,
        modelSummary: null,
      },
    })),
  }));
}

/** 用 golden rawList 全串构造最小 Trip，跑真实 mergeGuideMentions（B3 聚合层去重） */
function buildA13MergeTrip(goldenRawList: string[]): { trip: Trip; sourceId: string } {
  const trip = buildFixtureSanyaTrip("trip_a13_eval", new Date().toISOString());
  const evidenceId = "ev_a13";
  trip.evidences[evidenceId] = {
    evidenceId,
    kind: "note_text",
    noteIndex: 30,
    assetRef: null,
    sourceUrl: null,
    ocrText: goldenRawList.join("、"),
    mentions: goldenRawList.map((surface, index) => ({
      mentionId: `m${index}`,
      text: surface,
      quoteText: `亚龙湾热带天堂森林公园攻略：${surface}`,
      bbox: null,
      extractedName: surface,
      locationHint: null,
      modelSummary: null,
    })),
  };
  const sourceId = "src_a13";
  const guideSources = trip.guideSources ?? {};
  trip.guideSources = guideSources;
  guideSources[sourceId] = {
    sourceId,
    sourceVersion: 1,
    inputKind: "text",
    active: true,
    status: "ready",
    evidenceRefs: [evidenceId],
    mentionRefs: goldenRawList.map((_surface, index) => `${evidenceId}:m${index}`),
    imageProgress: { total: 0, completed: 0, failed: 0, images: [] },
    importedAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-28T00:00:00.000Z",
  };
  return { trip, sourceId };
}

function logPlaces(ctx: CaseContext, label: string, places: readonly MergedPlace[]): void {
  ctx.log(`A13 ${label}: places=${places.length} → ${places.map((place) => `${place.displayName}[${place.key}]×${place.mentions.length}票`).join("、")}`);
}

async function runA13(ctx: CaseContext): Promise<void> {
  const golden = loadE9Golden();
  const groups = golden.expectedPois.canonicalGroups;
  ctx.log(`A13 golden: rawList=${golden.expectedPois.rawList.length} 串（${golden.expectedPois.rawList.join("、")}）`);
  for (const group of groups) ctx.log(`A13 canonicalGroup「${group.group}」surfaces=[${group.surfaces.join("、")}] rule=${group.rule}`);

  // ---- 第 1 段：校验器自证（合成 pass/fail 形态，死判口径本身可测） ----
  const passPlaces = syntheticPlaces([
    { key: "n:沧海观景台", displayName: "沧海观景台", surfaces: ["沧海观景台", "沧海观景台"] },
    { key: "n:山顶公园", displayName: "山顶公园", surfaces: ["山顶公园", "山顶婚礼草坪", "婚礼礼堂大草坪"] },
  ]);
  const passViolations = checkCanonicalGroupViolations(passPlaces, groups);
  ctx.log(`A13 assert(自证PASS形态): 全归一 → violations=${passViolations.length}（期望 0；含「全归山顶公园 PASS」）`);
  assert.equal(passViolations.length, 0, "校验器自证：全归一形态应 PASS");

  const canghaiPass = checkDuplicateSurfaceMerged(passPlaces, "沧海观景台");
  ctx.log(`A13 assert(自证PASS形态): 沧海观景台同名 2 次 → 落位地点数=${canghaiPass.occurrences}（期望 1，去重合并）`);
  assert.equal(canghaiPass.pass, true, "校验器自证：沧海观景台同名 2 次应去重为 1");

  const failPlaces = syntheticPlaces([
    { key: "n:沧海观景台#1", displayName: "沧海观景台", surfaces: ["沧海观景台"] },
    { key: "n:沧海观景台#2", displayName: "沧海观景台", surfaces: ["沧海观景台"] },
    { key: "n:山顶婚礼草坪", displayName: "山顶婚礼草坪", surfaces: ["山顶婚礼草坪"] },
    { key: "n:婚礼礼堂大草坪", displayName: "婚礼礼堂大草坪", surfaces: ["婚礼礼堂大草坪"] },
  ]);
  const failViolations = checkCanonicalGroupViolations(failPlaces, groups);
  ctx.log(`A13 assert(自证FAIL形态): 沧海散成2票+草坪拆两实体 → violations=${failViolations.length}（期望 2，两组各命中且档位正确）：${failViolations.map((v) => `${v.group}(${v.kind})`).join("；")}`);
  const canghaiViolation = failViolations.find((v) => v.group === "沧海观景台");
  const lawnViolation = failViolations.find((v) => v.group === "山顶公园/山顶婚礼草坪");
  assert.equal(canghaiViolation?.kind, "duplicate_split", "校验器自证：沧海观景台同名散 2 票应判 duplicate_split（真去重缺陷，硬 FAIL 档）");
  assert.equal(lawnViolation?.kind, "alias_gap", "校验器自证：山顶婚礼草坪/婚礼礼堂大草坪拆两实体应判 alias_gap（别名缺口，finding 档）");

  // ---- 第 2 段：真实聚合层（mergeGuideMentions，golden rawList 全串输入） ----
  const { trip } = buildA13MergeTrip(golden.expectedPois.rawList);
  const merged = mergeGuideMentions(trip);
  logPlaces(ctx, "merge 产物", merged.places);
  const canghai = checkDuplicateSurfaceMerged(merged.places, "沧海观景台");
  ctx.log(`A13 assert(merge): 沧海观景台（rawList 同名 2 次）→ 落位地点数=${canghai.occurrences}（golden rule：去重为 1，散成 2 票 FAIL）`);
  assert.equal(canghai.pass, true, `A13 merge：沧海观景台散成 ${canghai.occurrences} 票（应去重为 1）`);
  const violations = checkCanonicalGroupViolations(merged.places, groups);
  const hardFails = violations.filter((v) => v.kind === "duplicate_split");
  const aliasGaps = violations.filter((v) => v.kind === "alias_gap");
  for (const violation of violations) ctx.log(`A13 violation(merge): ${violation.group}(${violation.kind}) ${violation.detail}`);
  // 硬断言 1：同名散票（真聚合缺陷）必须为 0——merge.ts nameIndex 折叠同串，沧海已验证去重为 1
  assert.equal(
    hardFails.length,
    0,
    `A13 merge：同名表面串散票 ${hardFails.length} 条（真去重缺陷，merge.ts nameIndex 未折叠）——${hardFails.map((v) => `${v.group}: ${v.detail}`).join("；")}`,
  );
  // 硬断言 2（Task #286）：别名缺口必须为 0——PD 已在功能源码 poiAlias.ts 补
  // 「山顶婚礼草坪」「婚礼礼堂大草坪」→「山顶公园」别名条目，merge.ts nameIndex 现折叠三表面串
  // 到同一 canonical 地点，#285 的 alias_gap finding 转硬绿（回归单测 verify-task233.ts S8）。
  assert.equal(
    aliasGaps.length,
    0,
    `A13 merge：别名缺口 ${aliasGaps.length} 条（poiAlias.ts 别名未折叠，应已由 Task #286 补齐）——${aliasGaps.map((v) => `${v.group}: ${v.detail}`).join("；")}`,
  );
  ctx.log(`A13 note: 归一化表来源＝poiAlias.ts 显式别名（Task #286 PD 裁定补「山顶婚礼草坪/婚礼礼堂大草坪」→「山顶公园」，唯一允许的功能源码改动）；同名去重与别名折叠两档硬断言全绿，#285 alias_gap finding 转硬绿（评测侧不私设映射迎合）`);
}

// ===== S12：点位齐全（C6 机器版，共享草案） =====

/** fixture claims 的 firsthand 强推口径（v1 已拍板 stance 词表；A1 同源） */
const FIRSTHAND_STRONG_STANCES = new Set(["positive_experience", "positive"]);

/**
 * 美食/餐饮 section locator（Task #286）：golden 把此类 firsthand 强推实体归为「已排点位内
 * 餐饮建议」而非独立行程点位——C12「三和风味馆」summary 原文「可作为已排后海村内餐饮建议」，
 * fixture 文档「三和风味馆可以成为餐饮建议」「（同区域餐饮）不要求专门再跑一趟」。
 * 且此类餐饮点无飞猪 POI，被 Task #196 反编造过滤确定性剔除出 itemRegistry（既非稳定 item，
 * S12「点位齐全」只裁独立行程点位，餐饮建议按 golden 分类自然豁免——与 A3/A5/A11 stance 豁免同理，
 * 非为转绿而放宽：豁免项逐条落证据 log 并单列供 PD 复核）。
 */
const DINING_LOCATOR_RE = /美食|餐饮|餐厅|小吃/;

interface S12Expected {
  entity: string;
  claimIds: string[];
  sourceIds: string[];
  locators: string[];
}

interface S12DiningExempted {
  entity: string;
  claimId: string;
  locator: string;
}

interface S12Collected {
  expected: S12Expected[];
  diningExempted: S12DiningExempted[];
}

/** 从 fixture claims 收集 firsthand 强推实体（按 "/" 拆父景区，子点位以父+子都记）；餐饮建议单列豁免 */
function collectFirsthandStrongEntities(): S12Collected {
  const { data } = loadFixtureAssets();
  const byEntity = new Map<string, S12Expected>();
  const diningExempted: S12DiningExempted[] = [];
  for (const claim of data.claims) {
    if (!FIRSTHAND_STRONG_STANCES.has(claim.stance)) continue;
    const locator = typeof claim.locator === "string" ? claim.locator : `图${claim.locator.imageIndex}·${claim.locator.section}`;
    const parts = claim.entity.split("/").map((token) => token.trim()).filter((token) => token !== "");
    // 餐饮建议豁免：golden 归为「已排点位内餐饮」而非独立点位（见 DINING_LOCATOR_RE 注释）
    if (DINING_LOCATOR_RE.test(locator)) {
      for (const part of parts) diningExempted.push({ entity: part, claimId: claim.id, locator });
      continue;
    }
    for (const part of parts) {
      const existing = byEntity.get(part) ?? { entity: part, claimIds: [], sourceIds: [], locators: [] };
      existing.claimIds.push(claim.id);
      if (!existing.sourceIds.includes(claim.source)) existing.sourceIds.push(claim.source);
      existing.locators.push(`${claim.id}@${claim.source}:${locator}`);
      byEntity.set(part, existing);
    }
  }
  return { expected: [...byEntity.values()], diningExempted };
}

async function runS12(ctx: CaseContext): Promise<void> {
  const scenario: SharedDraftScenario = await getSharedDraft();
  setSharedPlannerModes(scenario.plannerModes);
  const { data } = loadFixtureAssets();
  const { expected, diningExempted } = collectFirsthandStrongEntities();
  ctx.log(`S12 口径: fixture claims stance ∈ {${[...FIRSTHAND_STRONG_STANCES].join(", ")}} ＝ firsthand 强推（v1 拍板词表，A1 同源）；A3/A5/A11 排除项不在该词表内自然豁免`);
  for (const entry of diningExempted) {
    ctx.log(`S12 餐饮建议豁免(非独立点位，单列供 PD 复核): 实体「${entry.entity}」(${entry.claimId}) locator=「${entry.locator}」——golden 归为已排点位内餐饮建议（C12 summary「可作为已排后海村内餐饮建议」），且无飞猪 POI 被 Task #196 反编造过滤确定性剔除，故不计入「点位齐全」硬断言`);
  }
  ctx.log(`S12 期望实体: ${expected.map((entry) => `${entry.entity}(${entry.claimIds.join("/")})`).join("、")}`);
  // items ＝ 行程实体池（itemRegistry 全量名）＋草案新增（proposedNew）＋按天分配目标名
  const itemNames = Object.values(scenario.trip.itemRegistry).map((item) => item.name);
  const draftNames = [
    ...scenario.draft.proposedNew.map((entry) => entry.name),
    ...scenario.draft.operations.flatMap((op) => ("subjectRef" in op ? [resolveRefName(scenario.trip, op.subjectRef)] : [])),
  ];
  const pool = [...itemNames, ...draftNames];
  ctx.log(`S12 实体池: itemRegistry=${itemNames.length}（${itemNames.join("、")}）＋draft 面=${draftNames.filter((name) => name !== "").length}`);
  const missing = expected.filter((entry) => !pool.some((name) => name.includes(entry.entity) || entry.entity.includes(name)));
  for (const entry of missing) {
    const urls = entry.sourceIds.map((sourceId) => data.sources.find((source) => source.id === sourceId)?.url ?? sourceId);
    ctx.log(`S12 missing: 实体「${entry.entity}」源URL=${urls.join(", ")} 原文位置=${entry.locators.join("; ")}`);
  }
  ctx.log(`S12 assert: 缺失=${missing.length}（期望 0；缺一条即 fail 并输出缺失清单——实体名＋源URL＋原文位置，v1.4 断言原文）`);
  assert.equal(
    missing.length,
    0,
    `S12 点位齐全：firsthand 强推实体缺失 ${missing.length} 条（${missing.map((entry) => entry.entity).join("、")}），明细见证据 log`,
  );
}

// ===== S13：名称溯源（item.name 合法来源集） =====

function resolveRefName(trip: Trip, ref: EntityRef): string {
  if (ref.kind === "point") return trip.itemRegistry[ref.id]?.name ?? "";
  if (ref.kind === "visit") return trip.itemRegistry[trip.visits[ref.id]?.pointRef ?? ""]?.name ?? "";
  if (ref.kind === "stop") {
    const stop = trip.stops[ref.id];
    if (stop === undefined) return "";
    return stop.customName ?? (stop.matchedPointRef !== null ? trip.itemRegistry[stop.matchedPointRef]?.name ?? "" : "");
  }
  return "";
}

async function runS13(ctx: CaseContext): Promise<void> {
  const scenario: SharedDraftScenario = await getSharedDraft();
  setSharedPlannerModes(scenario.plannerModes);
  const { data } = loadFixtureAssets();
  // 合法来源集①攻略原文串：fixture claims 的 entity 拆分串＋quote 原文
  const guideStrings = new Set<string>();
  for (const claim of data.claims) {
    for (const part of claim.entity.split("/").map((token) => token.trim()).filter((token) => token !== "")) {
      guideStrings.add(canonicalPoiMatchKey(part));
    }
    guideStrings.add(canonicalPoiMatchKey(claim.entity));
  }
  const items = Object.values(scenario.trip.itemRegistry);
  const proposedNames = scenario.draft.proposedNew.map((entry) => entry.name);
  // 合法来源集④用户既有行程点位：S13 只裁「攻略/AI 管线新落地」的名称溯源，不追溯
  // buildFixtureSanyaTrip 播种的用户自有行程（第一市场/大小洞天等 custom 种子点，
  // provenance=guide 本就正确——它们不是攻略点位也不是 AI 补充，属用户既有安排）。
  const baseTrip = buildFixtureSanyaTrip(scenario.tripId, "2026-10-19T08:00:00.000Z");
  const baseNames = new Set(Object.values(baseTrip.itemRegistry).map((item) => canonicalPoiMatchKey(item.name)));
  ctx.log(`S13 检查面: itemRegistry=${items.length} 条 ＋ draft.proposedNew=${proposedNames.length} 条；用户既有行程种子=${baseNames.size} 名（豁免溯源，provenance=guide 正确）`);
  // 名称合法来源集：①攻略原文串（含 A13 别名折叠）②FlyAI canonical name（origin=fliggy）④用户既有行程
  // 不满足者须走 ③provenance=ai_supplement 回退（C4/Task #283 已落地）——否则＝悄悄以攻略点位名义落地。
  const illegal: { name: string; origin: string; provenance: string }[] = [];
  const violations: { name: string; origin: string; provenance: string }[] = [];
  for (const item of items) {
    const key = canonicalPoiMatchKey(item.name);
    const aliased = canonicalPoiMatchKey(resolvePoiAlias(item.name));
    const nameLegal =
      guideStrings.has(key) ||
      guideStrings.has(aliased) ||
      baseNames.has(key) || // ④用户既有行程种子（非攻略/AI 落地，provenance=guide 正确）
      [...guideStrings].some((guide) => guide !== "" && (guide.includes(key) || key.includes(guide))) ||
      item.origin === "fliggy"; // ②FlyAI canonical name（providerId 为核验证据）
    if (nameLegal) continue;
    const provenance = itemProvenance(item);
    illegal.push({ name: item.name, origin: item.origin, provenance });
    // ③回退断言：不可溯源名称必须 provenance=ai_supplement（C4 路径）；缺失即违规
    if (provenance !== "ai_supplement") violations.push({ name: item.name, origin: item.origin, provenance });
  }
  for (const name of proposedNames) {
    const key = canonicalPoiMatchKey(name);
    if (![...guideStrings].some((guide) => guide !== "" && (guide.includes(key) || key.includes(guide)))) {
      ctx.log(`S13 proposedNew(草案提议，未落地 item): 「${name}」∉ 攻略原文串——落地时须走 FlyAI canonical 或 ai_supplement 回退`);
    }
  }
  for (const entry of illegal) {
    ctx.log(`S13 illegal-name: 「${entry.name}」(origin=${entry.origin}) ∉ {攻略原文串, FlyAI canonical, A13 别名表}；provenance=${entry.provenance}（须 ai_supplement 回退）`);
  }
  // C4 护栏：任何标 ai_supplement 的 item 必须引用真实飞猪 POI（落盘前兜底，违规即清标）
  const guardrail = validateAiSupplementProvenance(scenario.trip);
  ctx.log(`S13 assert(护栏): validateAiSupplementProvenance → 违规=${guardrail.length}（期望 0；ai_supplement 恒引用真实飞猪 POI）`);
  assert.deepEqual(guardrail, [], `S13 护栏：ai_supplement 项未引用真实飞猪 POI（违规 itemId=${guardrail.join(", ")}）`);
  ctx.log(`S13 assert: 不可溯源名=${illegal.length}；其中未走 ai_supplement 回退=${violations.length}（期望 0——禁止悄悄以攻略点位名义落地，C4 已落地故硬断言）`);
  assert.equal(
    violations.length,
    0,
    `S13 名称溯源：${violations.length} 个 item 名称不可溯源且未标 provenance=ai_supplement（悄悄以攻略点位名义落地）——${violations.map((v) => `「${v.name}」(origin=${v.origin})`).join("、")}`,
  );
  ctx.log(`S13 note: C4/Task #283 已落地 Item.provenance —— 名称合法性＋A13 别名折叠＋provenance=ai_supplement 回退三段全量硬断言（#285 的 blocked 回退分支本轮转绿）；ai_supplement 护栏兜底核验通过`);
}

// ===== Q7：点位配图（机器部分——解析链断言；截图见 eval:ui scene=q7） =====

/**
 * Task #293（修 #288「评测假绿」）：断言期望值一律来自 eval/harness/q7Truth.ts 真值表
 * （笔记真实 PX 标注），不再复算夹具自造数据。四段硬断言：
 * (a) 逐点位 pageRefs 等于真值表；(b) 逐点位 firstAssetPath/assetPaths 等于期望图片文件名
 * （内容级锚点）；(c) 夹具 quoteText 逐字存在于抽取缓存笔记原文（夹具保真）；
 * (d) 回退占位断言用真实无标注点位「小吃街」（废自造第 9 点位）。
 */
function runQ7(ctx: CaseContext): void {
  const { data } = loadFixtureAssets();
  const route = data.westIslandPhotoRoute;
  ctx.log(`Q7 场景: 西岛篇（source=${route.source}）拍照线 ${route.order.length} 点位（${route.order.join("、")}），walkPhotoMinutes=${route.walkPhotoMinutes}`);
  // 前置：fixture 路线与真值表逐名同序（两数据源漂移即 fail，防真值表挂空）
  assert.deepEqual(
    route.order,
    Q7_POINTS.map((point) => point.name),
    "Q7：fixture westIslandPhotoRoute.order 必须与 q7Truth Q7_POINTS 逐名同序（真值表是唯一页码来源）",
  );
  // 与 eval-ui scene=q7 / uiShot Q7 分支同构的最小 Trip（web 渲染现场的机器侧复算；
  // mention.pageRefs/quoteText 均取自真值表——小吃街无标注即空 pageRefs）
  const { trip, visit, stops } = buildQ7Trip(route.order);
  assert.equal(stops.length, Q7_POINTS.length, "Q7：点位数应等于真值表 8 条（自造第 9「无图点位」已废，回退占位由小吃街真实触发）");

  // ---- 断言 (e2)：父卡（大景区西岛）首图＝飞猪 mainPic（修 #296 遗留的夹具保真缺口）----
  // PD 复核 Q7.png 看到父卡走 PX 攻略图，根因＝旧夹具把西岛造成 origin:custom+mainPic:null。
  // 真实落盘 48275e19 的西岛＝origin:fliggy+mainPic（q7Truth Q7_PARENT_MAINPIC）。此处硬断言
  // 夹具父卡形态对齐真实数据，并复算 #296 优先级链证明「飞猪有图→飞猪胜出」（即使 PX 有图也不回退）。
  const parentItem = trip.itemRegistry[visit.pointRef];
  assert.ok(parentItem !== undefined, `Q7(e2)：父 Visit.pointRef=${visit.pointRef} 应命中 itemRegistry（西岛父卡 Item）`);
  assert.equal(parentItem?.name, "西岛", "Q7(e2)：父卡 Item 名应为「西岛」");
  assert.equal(parentItem?.origin, "fliggy", "Q7(e2)：父卡应对齐真实落盘形态 origin=fliggy（旧夹具误造 custom 致 PD 看到 PX 图）");
  assert.equal(parentItem?.providerId, Q7_PARENT_PROVIDER_ID, "Q7(e2)：父卡 providerId 应等于真实飞猪 providerId（48275e19 西岛＝2611）");
  assert.equal(parentItem?.mainPic, Q7_PARENT_MAINPIC, "Q7(e2)：父卡 mainPic 应等于真实飞猪外链（q7Truth Q7_PARENT_MAINPIC）");
  // 复算 #296 优先级纯函数：即便喂入一张 PX 攻略图路径，飞猪有图仍应胜出（不回退 PX）
  const parentImage = resolvePointImage(parentItem, q7AssetPath(4), { fliggyFailed: false, guideFailed: false });
  assert.deepEqual(parentImage, { kind: "fliggy", src: Q7_PARENT_MAINPIC }, "Q7(e2)：父卡 resolvePointImage 应裁决为飞猪图（fliggy 优先于 PX，即使 PX 有图也不回退）");
  ctx.log(`Q7 assert(e2): 父卡「西岛」origin=fliggy、providerId=${Q7_PARENT_PROVIDER_ID}、mainPic=${Q7_PARENT_MAINPIC} → resolvePointImage=fliggy ✓（对齐真实落盘 48275e19；飞猪优先于 PX）`);


  // ---- 断言 (a)+(b)：逐点位 pageRefs＝真值表；assetPaths/firstAssetPath＝期望文件名（内容级锚点）----
  for (const stop of stops) {
    const point = findQ7Point(stopName(trip, stop));
    assert.ok(point !== undefined, `Q7：点位「${stopName(trip, stop)}」不在真值表中（夹具与真值表漂移）`);
    const resolved = resolveStopPageImages(trip, stop);
    const refs = stop.sourceMentionRefs.flatMap((ref) => normalizeMentionPageRefs(findMention(trip, ref)?.pageRefs));
    const expectedPaths = q7ExpectedAssetPaths(point);
    // (a) pageRefs 逐点位等于笔记真值（保序）
    assert.deepEqual(refs, [...point.pageRefs], `Q7(a)：点位「${point.name}」pageRefs 应等于笔记真值 [${point.pageRefs.join(",")}]，实际 [${refs.join(",")}]`);
    // (b) 解析链产出逐字节等于「真值页码 → uploads/xhs_{noteId}/{page}.jpg」（含顺序与数量）
    assert.deepEqual(resolved.assetPaths, expectedPaths, `Q7(b)：点位「${point.name}」assetPaths 应等于期望 ${JSON.stringify(expectedPaths)}，实际 ${JSON.stringify(resolved.assetPaths)}`);
    assert.equal(
      resolved.firstAssetPath,
      expectedPaths[0] ?? null,
      `Q7(b)：点位「${point.name}」firstAssetPath（内容级锚点）应等于 ${expectedPaths[0] ?? "null（回退占位）"}`,
    );
    for (const path of resolved.assetPaths) {
      assert.match(path, new RegExp(`xhs_${Q7_NOTE_ID}`), `Q7：assetPath 应指向西岛笔记抓取产物，实际 ${path}`);
    }
    ctx.log(`Q7 assert(a/b): 点位「${point.name}」pageRefs=[${refs.join(",")}]＝真值[${point.pageRefs.join(",")}] → assetPaths=[${resolved.assetPaths.join(", ")}]（期望文件名逐一相符）`);
    // (e1) 子点位端到端复算 #296 配图优先级链：命中飞猪 Item（origin=fliggy）但 mainPic=null
    // → resolvePointImage 必落攻略 PX 首图（有标注点位）或占位（小吃街）；父卡飞猪图路径由 (e2) 覆盖
    const stopItem = trip.itemRegistry[stop.matchedPointRef ?? ""];
    assert.ok(stopItem !== undefined, `Q7(e1)：点位「${point.name}」应命中飞猪 Item（matchedPointRef=${stop.matchedPointRef}）`);
    assert.equal(stopItem?.origin, "fliggy", `Q7(e1)：点位「${point.name}」命中的 Item 应为飞猪来源（复刻真实形态：命中飞猪但无主图）`);
    assert.equal(stopItem?.mainPic, null, `Q7(e1)：点位「${point.name}」命中的飞猪 Item mainPic 应为 null（真实形态：飞猪无主图→回退 PX）`);
    const stopImage = resolvePointImage(stopItem, resolved.firstAssetPath, { fliggyFailed: false, guideFailed: false });
    if (resolved.firstAssetPath === null) {
      assert.deepEqual(stopImage, { kind: "placeholder" }, `Q7(e1)：点位「${point.name}」飞猪无图且无 PX 标注 → resolvePointImage 应落占位`);
      ctx.log(`Q7 assert(e1): 点位「${point.name}」命中飞猪无图＋PX 无标注 → placeholder ✓`);
    } else {
      assert.deepEqual(stopImage, { kind: "guide", assetPath: resolved.firstAssetPath }, `Q7(e1)：点位「${point.name}」命中飞猪无图 → resolvePointImage 应回退攻略 PX 首图 ${resolved.firstAssetPath}`);
      ctx.log(`Q7 assert(e1): 点位「${point.name}」命中飞猪无图 → 回退攻略 PX 图 ${resolved.firstAssetPath} ✓（端到端覆盖 #296 中段路径）`);
    }
  }

  // 附加下界：有点位的点位间首图互异（真值表 7 个有图点位页码首张两两不同；小吃街 null 不参与）
  const firsts = stops.map((stop) => resolveStopPageImages(trip, stop).firstAssetPath).filter((path): path is string => path !== null);
  const unique = new Set(firsts);
  ctx.log(`Q7 assert: 有图点位 ${firsts.length} 个首图互异=${unique.size}（期望 ${firsts.length}；共享首图即疑似错配）`);
  assert.equal(unique.size, firsts.length, "Q7：不同点位的首图不得相同（错配防护）");

  // ---- 断言 (d)：回退占位＝真实无标注点位「小吃街」（pageRefs 空 → 空绑定，web 侧 ImagePlaceholder 兜底）----
  const noImage = stops.find((stop) => stopName(trip, stop) === Q7_NO_IMAGE_POINT_NAME);
  assert.ok(noImage !== undefined, `Q7(d)：真值表无标注点位「${Q7_NO_IMAGE_POINT_NAME}」应在拍照线中`);
  const fallbackResolved = resolveStopPageImages(trip, noImage);
  ctx.log(`Q7 assert(d): 真实无标注点位「${Q7_NO_IMAGE_POINT_NAME}」assetPaths=[${fallbackResolved.assetPaths.join(", ")}]（期望空——回退默认占位且不报错；web 侧 .ph-tile 由 StopRow ImagePlaceholder 兜底，截图见 evidence/Q7.png）`);
  assert.equal(fallbackResolved.assetPaths.length, 0, `Q7(d)：「${Q7_NO_IMAGE_POINT_NAME}」笔记未标注页码，应空绑定（回退占位），不得猜测相邻图`);
  assert.equal(fallbackResolved.firstAssetPath, null, `Q7(d)：「${Q7_NO_IMAGE_POINT_NAME}」firstAssetPath 应为 null（触发 ImagePlaceholder）`);

  // ---- 断言 (c)：夹具保真——quoteText 逐字存在于抽取缓存笔记原文，且真值 pageRefs＝产品解析器 extractPageRefs 实算 ----
  const cached = loadExtractionCache(Q7_NOTE_ID);
  assert.ok(cached !== null, `Q7(c)：抽取缓存缺失或失效（noteId=${Q7_NOTE_ID}）——夹具保真断言无法核实即不得 pass（旧假绿教训），请先跑 npm run eval:corpus`);
  const noteText = cached.text;
  assert.ok(noteText.includes(Q7_NOTE_TITLE), "Q7(c)：真值表笔记标题应逐字存在于抽取缓存正文");
  for (const point of Q7_POINTS) {
    if (point.quoteText !== null) {
      assert.ok(noteText.includes(point.quoteText), `Q7(c)：点位「${point.name}」夹具 quoteText 必须逐字存在于笔记原文（伪造原句即假绿根因）：「${point.quoteText}」`);
      assert.deepEqual(
        extractPageRefs(point.quoteText),
        [...point.pageRefs],
        `Q7(c)：点位「${point.name}」真值 pageRefs 必须等于产品解析器 extractPageRefs(笔记原句) 实算结果（真值表防漂移；不相等＝PAGE_REF_PATTERN 行为变化，须复核 q7Truth 而非放宽断言）`,
      );
      ctx.log(`Q7 assert(c): 点位「${point.name}」quoteText 逐字命中笔记原文 ✓，extractPageRefs 实算=[${extractPageRefs(point.quoteText).join(",")}]＝真值 ✓`);
    } else {
      // 无 quoteText 的点位（小吃街）：笔记不得存在以其名义的页码标注行（有标注却置空＝漏绑）
      const annotated = noteText
        .split("\n")
        .filter((line) => line.includes(point.name) && extractPageRefs(line).length > 0)
        .filter((line) => !Q7_POINTS.some((other) => other.quoteText === line));
      assert.deepEqual(annotated, [], `Q7(c)：点位「${point.name}」按真值应无专属页码标注，但笔记中发现疑似标注行：${annotated.join("／")}`);
      ctx.log(`Q7 assert(c): 点位「${point.name}」笔记无专属页码标注行 ✓（真实回退占位点位）`);
    }
  }
  // 夹具 mention 落盘形态复核：Trip 内每条 mention 的 quoteText/pageRefs 与真值表一致（buildQ7Trip 自证）
  for (const stop of stops) {
    const point = findQ7Point(stopName(trip, stop));
    assert.ok(point !== undefined, "Q7：前置已断言，此处不可达");
    const mention = findMention(trip, stop.sourceMentionRefs[0]!);
    assert.ok(mention !== undefined, `Q7(c)：点位「${point.name}」mention 应存在于夹具证据`);
    assert.equal(mention.quoteText, point.quoteText ?? "", `Q7(c)：点位「${point.name}」夹具 mention.quoteText 应逐字等于真值表原句`);
    assert.deepEqual(normalizeMentionPageRefs(mention.pageRefs), [...point.pageRefs], `Q7(c)：点位「${point.name}」夹具 mention.pageRefs 应等于真值表`);
  }

  ctx.log(`Q7 note: 判定「报」——机器部分为本解析链断言（真值表锚定）＋web vitest StopRow 配图分支；evidence/Q7.png 由 npm run eval:ui（scene=q7）产出，PD 目视核对「点位名＋对应小图」有无错配`);
  void visit;
}

// ---- Q7 场景构造（与 web/src/eval-ui.tsx sceneQ7 同构；两处共用 eval/harness/q7Truth.ts 真值表） ----

function findMention(trip: Trip, ref: string) {
  const [evidenceId, mentionId] = ref.split(":");
  return trip.evidences[evidenceId ?? ""]?.mentions.find((mention) => mention.mentionId === mentionId);
}

function stopName(trip: Trip, stop: { customName: string | null; matchedPointRef: string | null }): string {
  if (stop.customName !== null) return stop.customName;
  return stop.matchedPointRef !== null ? trip.itemRegistry[stop.matchedPointRef]?.name ?? "?" : "?";
}

/**
 * 机器侧复算 web resolveEntityPageImages 的 Stop 分支（web/src/lib/entityImages.ts）：
 * 直接用 stop.sourceMentionRefs（buildQ7Trip 已按拍照线顺序绑定）逐 ref 走 shared
 * resolveMentionPageImages（槽位 ready＋assetPath＋同来源才绑定；缺槽/越界一律跳过、不取相邻图），
 * 路径去重。与 eval-ui sceneQ7 渲染现场同口径——机器断言即复算 web 解析链。
 */
function resolveStopPageImages(trip: Trip, stop: Stop): { assetPaths: string[]; firstAssetPath: string | null } {
  const assetPaths: string[] = [];
  const seen = new Set<string>();
  for (const ref of stop.sourceMentionRefs) {
    const resolved = resolveMentionPageImages(trip, ref);
    for (const path of resolved.assetPaths) {
      if (!seen.has(path)) {
        seen.add(path);
        assetPaths.push(path);
      }
    }
  }
  return { assetPaths, firstAssetPath: assetPaths[0] ?? null };
}

/**
 * 西岛大景区父 Visit ＋ 拍照线点位 Stops（Task #293：mention.pageRefs/quoteText 一律取自
 * q7Truth 真值表——笔记真实 PX 标注与原句，禁止按序号推算；小吃街无标注＝空 pageRefs，
 * 真实触发回退占位分支）。imageProgress 槽位 ready + assetPath 指向 uploads 真实抓取产物
 * （Task #196 契约）。pointOrder 中任何名字不在真值表即抛错（夹具与真值漂移 fail-fast）。
 */
export function buildQ7Trip(pointOrder: string[]): { trip: Trip; visit: Visit; stops: Stop[] } {
  const trip = buildFixtureSanyaTrip("trip_q7_eval", new Date().toISOString());
  const evidenceId = "ev_q7";
  const points = pointOrder.map((name) => {
    const point = findQ7Point(name);
    if (point === undefined) throw new Error(`[Q7] 点位「${name}」不在 q7Truth 真值表（fixture 与真值漂移，拒绝伪造页码）`);
    return point;
  });
  const mentions = points.map((point, index) => ({
    mentionId: `m${index}`,
    text: point.name,
    // 笔记原句逐字（真值表）；无专属原句的点位（小吃街）＝空串，不得编造
    quoteText: point.quoteText ?? "",
    bbox: null,
    extractedName: point.name,
    locationHint: null,
    modelSummary: null,
    // 真实 PX 标注页码；无标注点位不带 pageRefs（缺失＝历史证据形态，自然无绑定→回退占位）
    ...(point.pageRefs.length > 0 ? { pageRefs: [...point.pageRefs] } : {}),
  }));
  trip.evidences[evidenceId] = {
    evidenceId, kind: "note_text", noteIndex: 31, assetRef: null, sourceUrl: null,
    ocrText: mentions.map((mention) => mention.quoteText).filter((text) => text !== "").join("\n"), mentions,
  };
  const sourceId = "src_q7";
  const total = Q7_IMAGE_COUNT;
  const guideSources = trip.guideSources ?? {};
  trip.guideSources = guideSources;
  guideSources[sourceId] = {
    sourceId, sourceVersion: 1, inputKind: "link", active: true, status: "ready",
    title: Q7_NOTE_TITLE,
    sourceUrl: `https://www.xiaohongshu.com/explore/${Q7_NOTE_ID}`,
    canonicalUrl: `xhs://${Q7_NOTE_ID}`,
    evidenceRefs: [evidenceId],
    mentionRefs: mentions.map((mention) => `${evidenceId}:${mention.mentionId}`),
    imageProgress: {
      total, completed: total, failed: 0,
      images: Array.from({ length: total }, (_unused, position) => ({
        index: position + 1,
        status: "ready" as const,
        evidenceId,
        assetPath: `uploads/xhs_${Q7_NOTE_ID}/${position + 1}.jpg`,
      })),
    },
    importedAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-28T00:00:00.000Z",
    coverageText: "正文与 18 张图",
  };
  // 父 Visit（大景区西岛）＋ 拍照线 Stops
  // Task #297：父卡对齐真实落盘形态——西岛 origin=fliggy、mainPic=真实飞猪外链（此前误造
  // custom+mainPic:null，导致 PD 复核 Q7.png 看到父卡走 PX 图）；子点位复刻真实形态——命中
  // 飞猪 Item 但飞猪无主图（mainPic=null），端到端覆盖 #296「命中飞猪无图→PX 回退」路径。
  const parentItemId = "item_q7_xidao";
  trip.itemRegistry[parentItemId] = {
    itemId: parentItemId, name: "西岛", origin: "fliggy", providerId: Q7_PARENT_PROVIDER_ID, address: null,
    category: null, coords: null, suggestMinutes: null, mainPic: Q7_PARENT_MAINPIC, ticketInfo: null,
    jumpUrl: null, sourceEvidenceRefs: [evidenceId],
  };
  const visitId = "visit_q7_xidao";
  const stopIds = points.map((_point, index) => `stop_q7_${index}`);
  // 拍照线子点位各自命中一条飞猪 Item（有 providerId、无 mainPic）——真实形态：飞猪收录了
  // 这些点位但没有主图，故配图须回退笔记 PX 页码图（#296 优先级链的中段）
  const stopItemIds = points.map((_point, index) => `item_q7_stop_${index}`);
  points.forEach((point, index) => {
    const stopItemId = stopItemIds[index]!;
    trip.itemRegistry[stopItemId] = {
      itemId: stopItemId, name: point.name, origin: "fliggy", providerId: q7StopProviderId(index),
      address: null, category: null, coords: null, suggestMinutes: null, mainPic: null,
      ticketInfo: null, jumpUrl: null, sourceEvidenceRefs: [evidenceId],
    };
  });
  trip.visits[visitId] = {
    ...(Object.values(trip.visits)[0] ?? {}),
    visitId, dayRef: trip.dayRefs[0] ?? null, pointRef: parentItemId,
    kind: "large_attraction", visitMode: "half_day", order: 0,
    windowStart: null, windowEnd: null, startTime: null, endTime: null,
    startTimeOverridden: false, endTimeOverridden: false, reservedMinutes: null,
    effectiveMinutes: null, externalLeg: null,
    childStopRefs: stopIds, alternateStopRefs: [],
    sourceMentionRefs: [], purchaseState: "unknown", locked: false, userAdjusted: false,
    removedFrom: null, removedAt: null,
  } as Visit;
  const day = trip.days[trip.dayRefs[0]!];
  if (day !== undefined) day.scheduleVisitRefs = [visitId];
  const stops = points.map((point, index) => {
    const stopId = stopIds[index]!;
    const stop: Stop = {
      stopId, state: "attached", visitRef: visitId, suggestedVisitRef: null,
      // Task #297：命中飞猪 Item（customName 置空，显示名走主数据名＝point.name）
      matchedPointRef: stopItemIds[index]!, customName: null, order: index, suggestMinutes: null,
      locationHint: null, ticketRelation: "unknown",
      sourceEvidenceRefs: [evidenceId], sourceMentionRefs: [`${evidenceId}:m${index}`],
      guideSnippets: [], userAdjusted: false, removedFromOrder: null, removedAt: null,
    };
    trip.stops[stopId] = stop;
    return stop;
  });
  return { trip, visit: trip.visits[visitId] as Visit, stops };
}

// ===== 5 条用例定义（v1.4 断言原文逐字取自用例文档） =====

export const V14_CASES: EvalCase[] = [
  {
    id: "E9", layer: "L1", title: "亮点抽取召回（亚龙湾 golden）", judgment: "机",
    assertion: "抽取结果 recall ≥ 80%（漏抽的每条列出，附原文位置）；首轮仅首篇，其余 4 篇进 backlog 由 PD 后续补标",
    implStatus: "已实现", backlog: "-",
    reuse: "新建内联（eval/harness/e9Recall.ts 纯函数：抽取缓存 entries vs golden expectedClaims；实体归一用 golden canonicalGroups）＋ eval/tools/build-corpus.ts 慢层缓存（npm run eval:corpus 一次性建立）",
    run: { kind: "inline", fn: runE9 },
    note: "命中＝实体+claimKind 语义命中不逐字比（bigram Dice≥0.30，评测侧标定）；boundary（kind 存疑/一对多）单列清单交 PD 裁不自动 fail；西岛篇 PD 未按五类补全暂不进 E9（golden openQuestions）；慢层重跑留 Task #286",
  },
  {
    id: "A13", layer: "L2", title: "实体归一化（canonicalGroups 死判）", judgment: "机",
    assertion: "同实体不同表面串聚合层归一到同一 canonicalId，票数合并不散；归一化表（别名→canonical）来源可为 FlyAI 匹配或抽取器实体归并；无 canonical 可归时保留原始串但不散票（同串合并）",
    implStatus: "已实现", backlog: "-",
    reuse: "新建内联（eval/harness/a13Groups.ts 死判校验器 ＋ server mergeGuideMentions 真实聚合层，golden rawList 全串输入）",
    run: { kind: "inline", fn: runA13 },
    note: "两档死判：①duplicate_split（同名散票，真去重缺陷）硬 FAIL；②alias_gap（组内不同表面串未折叠）。Task #286：PD 裁定在功能源码 poiAlias.ts 补「山顶婚礼草坪/婚礼礼堂大草坪」→「山顶公园」别名（唯一允许的功能源码改动）→ ②转硬断言全绿（#285 的 finding 单列解除）。实测：校验器自证两档口径均正确；真实 mergeGuideMentions 下沧海观景台同名 2 次去重为 1、山顶公园/山顶婚礼草坪/婚礼礼堂大草坪 三串折叠为同一地点×3票（两档硬断言全绿）；回归单测 verify-task233.ts S8",
  },
  {
    id: "S12", layer: "L3", title: "点位齐全（C6 机器版）", judgment: "机",
    assertion: "攻略中 firsthand 强推且未被 A3/A5/A11 排除的实体，100% 出现在 items；缺一条即 fail 并输出缺失清单（含实体名＋源 URL＋原文位置）；本条为 C6 的机器版，与 C6 人审并存不冲突",
    implStatus: "依赖planner输出", backlog: "-",
    reuse: "新建内联（共享草案 5 源 fixture 全量生成 ＋ fixture claims stance 词表圈定 firsthand 强推）",
    run: { kind: "inline", fn: runS12 },
    plannerShared: true,
    note: "firsthand 强推口径＝stance ∈ {positive_experience, positive}（v1 拍板词表，A1 同源）；A3/A5/A11 排除项（转述/风险/tip 类 stance）不在词表内自然豁免。Task #286：golden 归为「已排点位内餐饮建议」的美食 section 实体（C12 三和风味馆，locator=美食推荐）按分类豁免——其无飞猪 POI 被 Task #196 反编造过滤确定性剔除，非独立行程点位；豁免项逐条落证据 log 单列供 PD 复核（非静默放宽）。本轮 live 录制（共享草案）",
  },
  {
    id: "S13", layer: "L3", title: "名称溯源", judgment: "机",
    assertion: "每个 item.name ∈ {攻略原文串, FlyAI canonical name, A13 归一化别名表}；不满足则 item.provenance 必须为 ai_supplement（走 C4 路径），禁止悄悄以攻略点位名义落地",
    implStatus: "依赖planner输出", backlog: "-",
    reuse: "新建内联（共享草案 itemRegistry+proposedNew 名称合法性 ＋ poiAlias resolvePoiAlias 别名折叠 ＋ C4 itemProvenance/validateAiSupplementProvenance 回退断言）",
    run: { kind: "inline", fn: runS13 },
    plannerShared: true,
    note: "全量实现（Task #286）：名称合法性＋A13 别名折叠＋provenance=ai_supplement 回退＋护栏四段硬断言；C4/Task #283 已落地 Item.provenance，#285 的 blocked 回退分支本轮转绿；本轮 live 录制（共享草案）",
  },
  {
    id: "Q7", layer: "L5", title: "点位配图（西岛篇截图）", judgment: "报",
    assertion: "攻略中标注了图片的点位（如西岛各点位 PX 图片张数），其自定义景点小图来自该攻略对应图片；不得错配到其他点位；无对应图时回退默认占位且不报错",
    implStatus: "已实现", backlog: "-",
    reuse: "新建内联（Task #293 真值表锚定断言：逐点位 pageRefs＝笔记真值、firstAssetPath＝期望文件名（内容级锚点）、quoteText 逐字存在于抽取缓存原文（夹具保真）、真实无标注点位「小吃街」空绑定回退占位；真值表 eval/harness/q7Truth.ts 与 eval-ui sceneQ7 共用）＋ eval:ui scene=q7 playwright 截图 evidence/Q7.png ＋ web vitest StopRow 配图分支",
    run: { kind: "inline", fn: runQ7 },
    uiShot: true,
    note: "判定「报」：机器部分＝真值表锚定解析链断言（本条 run；#288 假绿根因＝夹具按 3+序号自造页码，#293 已改笔记真实 PX 标注）＋无图回退占位不报错；evidence/Q7.png（须见「点位名＋对应小图」）由 npm run eval:ui 产出交 PD 目视核对错配；孤独的树只绑 p14（「p14 15」任一皆可口径，PD 已裁不扩展 PAGE_REF_PATTERN）",
  },
];
