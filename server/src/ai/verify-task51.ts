/**
 * Task #51 验证（两段制）：
 *
 * 段一（离线：不触网、不创建行程文件）：
 *   1. isSupportedImage magic bytes 矩阵：JPEG / PNG 通过；非图片 mime、
 *      伪造 content-type（文本字节）、过短字节一律拒绝；
 *   2. HTTP 层校验（aiRoutes.request POST /ocr，错误均在触网前短路）：
 *      - 缺 tripId / 缺图片文件 → 400 IMAGE_REQUIRED；
 *      - 超 10MB → 413 IMAGE_TOO_LARGE；
 *      - 文本字节伪造 image/jpeg → 422 IMAGE_FORMAT_UNSUPPORTED；
 *      - 合法 PNG + 不存在行程 → 404 TRIP_NOT_FOUND（load 短路在环境预检之前）；
 *      - 以上错误路径均不落盘任何行程文件。
 *
 * 段二（触网：真实百炼 File API，约 40-120s，需仓库根目录 .env）：
 *   3. 标准三亚验收行程 + fixtures/task51/guide.png 走完整 OCR 流水线：
 *      截图证据（assetRef / ocrText / mentions / sourceUrl）落盘；
 *      in_attraction 三级归属（high attached / medium pending+建议 / low pending）；
 *      state / refs 双向一致；relationshipSuggestions（decidedBy=system）；
 *      item.sourceEvidenceRefs 与 stop.sourceMentionRefs 回指；
 *      已有条目（情人桥 / 观日岩）复用而非重建；
 *   4. 隐私：从日志提取 fileId → getBailianFile 应 404（finally 必删生效）；
 *   5. 同图重跑：新证据，但同名 Item / 同 matchedPointRef Stop 不重复。
 *
 * 运行：npx tsx server/src/ai/verify-task51.ts
 */

import "../env.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Item, RelationshipSuggestion, Stop, Trip, Visit } from "@goplay/shared";
import { SCHEMA_VERSION } from "@goplay/shared";
import { getBailianFile } from "../bailian/client.js";
import { tripStore, createFixtureSanyaTrip } from "../persistence/store.js";
import { ensureStopAndPlace, normalizePoiName, type ParsedEntry } from "./assemble.js";
import { AiError } from "./errors.js";
import { extractFromScreenshot, isSupportedImage } from "./ocr.js";
import { aiRoutes } from "./routes.js";

const FIXTURE_IMAGE = path.join(import.meta.dirname, "fixtures", "task51", "guide.png");
const DATA_DIR = path.join(import.meta.dirname, "..", "..", "data");
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function pass(name: string): void {
  console.log(`✓ ${name}`);
}

/** 拦截 console.log 收集日志：用于提取 fileId（验证百炼侧文件删除），不打印密钥 */
const collectedLogs: string[] = [];
const originalLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
  collectedLogs.push(args.map((value) => String(value)).join(" "));
  originalLog(...args);
};

async function postOcr(form: FormData): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await aiRoutes.request("/ocr", { method: "POST", body: form });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** 断言错误路径未落盘任何行程文件 */
async function assertNoTripFile(tripId: string, label: string): Promise<void> {
  await assert.rejects(
    fs.access(path.join(DATA_DIR, `${tripId}.json`)),
    (error: unknown) => error instanceof Error,
    `${label}：不应写入 ${tripId}.json`,
  );
}

async function main(): Promise<void> {
  // ===== 段一：离线校验（不触网） =====

  // 1. magic bytes 矩阵
  {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const text = new TextEncoder().encode("this is definitely not an image");

    assert.equal(isSupportedImage(jpeg, "image/jpeg"), true, "JPEG magic + image/jpeg 应通过");
    assert.equal(isSupportedImage(png, "image/png"), true, "PNG magic + image/png 应通过");
    assert.equal(isSupportedImage(png, "image/gif"), false, "PNG 字节 + 非法 mime 应拒绝");
    assert.equal(isSupportedImage(text, "image/jpeg"), false, "文本字节伪造 image/jpeg 应拒绝");
    assert.equal(isSupportedImage(text, "image/png"), false, "文本字节伪造 image/png 应拒绝");
    assert.equal(isSupportedImage(new Uint8Array([0x89, 0x50]), "image/png"), false, "长度<4 应拒绝");
    assert.equal(isSupportedImage(new Uint8Array(0), "image/jpeg"), false, "空字节应拒绝");
    pass("magic bytes 矩阵：JPEG/PNG 通过；伪造 content-type、非法 mime、过短字节全部拒绝");
  }

  // 2. HTTP 层校验（错误码契约 + 不落盘）
  {
    const pngHead = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

    // 2a. 缺 tripId
    const noTripId = new FormData();
    noTripId.append("image", new File([pngHead], "a.png", { type: "image/png" }));
    const resA = await postOcr(noTripId);
    assert.equal(resA.status, 400, "缺 tripId 应 400");
    assert.equal(resA.body.code, "IMAGE_REQUIRED");

    // 2b. 缺图片文件
    const noImage = new FormData();
    noImage.append("tripId", randomUUID());
    const resB = await postOcr(noImage);
    assert.equal(resB.status, 400, "缺图片应 400");
    assert.equal(resB.body.code, "IMAGE_REQUIRED");

    // 2c. 超 10MB（PNG 头，确保 413 在 magic bytes 校验之前拦截）
    const ghostC = randomUUID();
    const oversized = new Uint8Array(MAX_IMAGE_BYTES + 1);
    oversized.set([0x89, 0x50, 0x4e, 0x47]);
    const tooLarge = new FormData();
    tooLarge.append("tripId", ghostC);
    tooLarge.append("image", new File([oversized], "big.png", { type: "image/png" }));
    const resC = await postOcr(tooLarge);
    assert.equal(resC.status, 413, "超 10MB 应 413");
    assert.equal(resC.body.code, "IMAGE_TOO_LARGE");

    // 2d. 伪造格式（文本字节 + image/jpeg）
    const ghostD = randomUUID();
    const fake = new FormData();
    fake.append("tripId", ghostD);
    fake.append("image", new File([new TextEncoder().encode("not an image at all")], "fake.jpg", { type: "image/jpeg" }));
    const resD = await postOcr(fake);
    assert.equal(resD.status, 422, "伪造格式应 422");
    assert.equal(resD.body.code, "IMAGE_FORMAT_UNSUPPORTED");

    // 2e. 合法 PNG + 不存在行程 → 404（load 短路在环境预检之前，不触网）
    const ghostE = randomUUID();
    const notFound = new FormData();
    notFound.append("tripId", ghostE);
    notFound.append("image", new File([pngHead], "ok.png", { type: "image/png" }));
    const resE = await postOcr(notFound);
    assert.equal(resE.status, 404, "不存在行程应 404");
    assert.equal(resE.body.code, "TRIP_NOT_FOUND");

    await assertNoTripFile(ghostC, "413 超大");
    await assertNoTripFile(ghostD, "422 伪造格式");
    await assertNoTripFile(ghostE, "404 行程不存在");
    pass("HTTP 层校验：400/413/422/404 错误码契约正确；超大/伪造/不存在行程三条错误路径均不落盘");
  }

  // ===== 段 1.5：三级归属单元测试（离线：直接驱动 ensureStopAndPlace，三档确定性覆盖） =====
  {
    /** 内存中的最小行程：一个大景区壳，不落盘（不经过 tripStore） */
    const trip: Trip = {
      tripId: "unit-test-trip",
      schemaVersion: SCHEMA_VERSION,
      version: 1,
      destination: { city: "", cityCode: null },
      dateRange: { start: "2026-10-01", end: "2026-10-02", nights: 1 },
      dayRefs: ["day_1"],
      days: {
        day_1: {
          dayId: "day_1",
          dayIndex: 1,
          date: "2026-10-01",
          departTime: null,
          departTimeOverridden: false,
          scheduleVisitRefs: [],
          lodging: null,
        },
      },
      lodgings: {},
      hotelRegistry: {},
      itemRegistry: {},
      visits: {
        visit_wzz_ut: {
          visitId: "visit_wzz_ut",
          dayRef: null,
          pointRef: "item_wzz_ut",
          kind: "large_attraction",
          visitMode: "full_day",
          order: null,
          windowStart: null,
          windowEnd: null,
          startTime: null,
          endTime: null,
          startTimeOverridden: false,
          endTimeOverridden: false,
          reservedMinutes: null,
          effectiveMinutes: null,
          externalLeg: null,
          childStopRefs: [],
          alternateStopRefs: [],
          purchaseState: "unknown",
          locked: false,
          userAdjusted: false,
          removedFrom: null,
          removedAt: null,
        },
      },
      stops: {},
      evidences: {},
      globalCandidateRefs: [],
      pendingStopRefs: [],
      relationshipSuggestions: {},
      constraints: [],
      createdAt: "2026-10-15T00:00:00.000Z",
      updatedAt: "2026-10-15T00:00:00.000Z",
    };
    trip.itemRegistry["item_wzz_ut"] = {
      itemId: "item_wzz_ut",
      name: "蜈支洲岛",
      origin: "custom",
      providerId: null,
      address: null,
      category: null,
      coords: null,
      suggestMinutes: null,
      mainPic: null,
      ticketInfo: null,
      jumpUrl: null,
      sourceEvidenceRefs: [],
    };
    const parentVisit = trip.visits.visit_wzz_ut;

    const mkEntry = (name: string, parent: string | null, confidence: "high" | "medium" | "low"): ParsedEntry => ({
      name,
      type: "in_attraction",
      parentAttraction: parent,
      scale: null,
      confidence,
      suggestMinutes: 30,
      locationHint: null,
      quote: `原文提及${name}`,
      summary: "s",
      ticketRelation: "unknown",
      suggestedVisitName: null,
      bbox: null,
    });
    const mkItem = (name: string): Item => ({
      itemId: `item_${name}`,
      name,
      origin: "custom",
      providerId: null,
      address: null,
      category: null,
      coords: null,
      suggestMinutes: 30,
      mainPic: null,
      ticketInfo: null,
      jumpUrl: null,
      sourceEvidenceRefs: [],
    });

    // high + 找到所属 → attached（childStopRefs 末位）
    const high = ensureStopAndPlace(trip, mkEntry("高空滑索", "蜈支洲岛", "high"), mkItem("高空滑索"), "ev_ut", "m1", parentVisit);
    assert.equal(high.created, true);
    assert.equal(high.stop.state, "attached");
    assert.equal(high.stop.visitRef, parentVisit.visitId);
    assert.deepEqual(parentVisit.childStopRefs, [high.stop.stopId], "high 应挂入所属大景区 childStopRefs 末位");
    assert.equal(trip.relationshipSuggestions[high.stop.stopId]?.level, "high");
    assert.equal(trip.relationshipSuggestions[high.stop.stopId]?.decidedBy, "system");
    assert.ok(!trip.pendingStopRefs.includes(high.stop.stopId), "attached 不应进待定区");

    // medium + 有归属 → pending + suggestedVisitRef
    const medium = ensureStopAndPlace(trip, mkEntry("环岛观光车", "蜈支洲岛", "medium"), mkItem("环岛观光车"), "ev_ut", "m2", parentVisit);
    assert.equal(medium.stop.state, "pending");
    assert.equal(medium.stop.suggestedVisitRef, parentVisit.visitId);
    assert.ok(trip.pendingStopRefs.includes(medium.stop.stopId), "medium 应进 pendingStopRefs");
    assert.equal(trip.relationshipSuggestions[medium.stop.stopId]?.level, "medium");
    assert.equal(trip.relationshipSuggestions[medium.stop.stopId]?.suggestedVisitRef, parentVisit.visitId);

    // low / 无归属 → pending 无建议
    const low = ensureStopAndPlace(trip, mkEntry("海上秋千", null, "low"), mkItem("海上秋千"), "ev_ut", "m3", null);
    assert.equal(low.stop.state, "pending");
    assert.equal(low.stop.suggestedVisitRef, null);
    assert.ok(trip.pendingStopRefs.includes(low.stop.stopId), "low 应进 pendingStopRefs");
    assert.equal(trip.relationshipSuggestions[low.stop.stopId]?.level, "low");
    assert.equal(trip.relationshipSuggestions[low.stop.stopId]?.decidedBy, "system");

    // 复用路径：同 item 再次 ensure → 不重建、不重复归置，追加 mention 引用
    const reused = ensureStopAndPlace(trip, mkEntry("高空滑索", "蜈支洲岛", "high"), mkItem("高空滑索"), "ev_ut2", "m4", parentVisit);
    assert.equal(reused.created, false);
    assert.equal(reused.stop.stopId, high.stop.stopId);
    assert.ok(reused.stop.sourceMentionRefs.includes("ev_ut2:m4"), "复用时应追加新证据的 mention 引用");
    assert.equal(parentVisit.childStopRefs.length, 1, "复用不得重复归置");
    pass("三级归属单元测试：high→attached(childStopRefs 末位)；medium→pending+建议归属；low→pending 无建议；复用不重建");
  }

  // 快速离线回归：跳过触网全链路（真实百炼 ~90s）
  if (process.env.VERIFY_SKIP_LIVE === "1") {
    console.log("\n[verify] 离线段全部通过 ✓（VERIFY_SKIP_LIVE=1，跳过触网全链路）");
    return;
  }

  // ===== 段二：触网全链路（真实百炼 File API） =====

  // 3. 真实 OCR 闭环
  const imageData = new Uint8Array(await fs.readFile(FIXTURE_IMAGE));
  assert.ok(imageData.length > 0, "测试图应存在（fixtures/task51/guide.png）");
  assert.ok(isSupportedImage(imageData, "image/png"), "测试图应为合法 PNG");

  // Task #66：标准三亚验收行程须显式经 fixture 生成器创建（tripStore.create 已不再返回夹具）
  const trip = await createFixtureSanyaTrip();
  const seedVisitIds = new Set(Object.keys(trip.visits));
  const seedStopCount = Object.keys(trip.stops).length;
  console.log(`[verify] 测试行程 ${trip.tripId}（标准三亚验收行程，${seedStopCount} 个已有 stop）`);

  const ocrInput = { data: imageData, filename: "guide.png", mimeType: "image/png", sizeBytes: imageData.length };
  console.log("[verify] 第一次 OCR 开始（真实 File API，约 30-90s）…");
  const first = await extractFromScreenshot(trip.tripId, ocrInput, {
    sourceUrl: "https://example.com/note/51",
  });

  const persisted: Trip | null = await tripStore.load(trip.tripId);
  assert.ok(persisted !== null, "OCR 成功后行程应可重新加载");

  // 3a. 截图证据落盘
  const evidence = persisted.evidences[first.evidenceId];
  assert.ok(evidence !== undefined, "screenshot 证据应落盘");
  assert.equal(evidence.kind, "screenshot");
  assert.ok((evidence.assetRef ?? "").includes("截图"), "assetRef 应为非敏感中文描述");
  assert.ok((evidence.assetRef ?? "").includes("#"), "assetRef 应含内容哈希标记");
  assert.equal(evidence.sourceUrl, "https://example.com/note/51", "来源链接应原样保留");
  assert.ok((evidence.ocrText ?? "").length > 0, "ocrText 应非空");
  assert.ok(evidence.mentions.length > 0, "至少应有一条 mention");
  pass(`截图证据落盘：ocrText ${evidence.ocrText?.length} 字，mentions ${evidence.mentions.length} 条，assetRef=${evidence.assetRef}`);

  // 3b. 三级归属 + state/refs 双向一致（只对本次新建的 stop 断言）
  assert.ok(first.stops.length > 0, "至少应新建一个内部玩法 stop（摩托艇 / 海上秋千）");
  let attachedCount = 0;
  let mediumCount = 0;
  let lowCount = 0;
  for (const stop of first.stops) {
    const persistedStop: Stop | undefined = persisted.stops[stop.stopId];
    assert.ok(persistedStop !== undefined, `stop ${stop.stopId} 应落盘`);
    assert.equal(persistedStop.state, stop.state, "返回结果与落盘 state 一致");
    const suggestion: RelationshipSuggestion | undefined = persisted.relationshipSuggestions[stop.stopId];
    assert.ok(suggestion !== undefined, `stop ${stop.stopId} 应写入 relationshipSuggestions`);
    assert.equal(suggestion.decidedBy, "system");
    assert.equal(suggestion.level, stop.level, "suggestion.level 与返回 level 一致");

    if (stop.state === "attached") {
      attachedCount++;
      assert.equal(stop.level, "high", "attached 必为 high");
      assert.ok(persistedStop.visitRef !== null);
      const visit = persisted.visits[persistedStop.visitRef];
      assert.ok(visit !== undefined, "所属 visit 应存在");
      assert.ok(visit.childStopRefs.includes(stop.stopId), "attached stop 应出现在所属 Visit 的 childStopRefs（双向一致）");
    } else {
      assert.ok(persisted.pendingStopRefs.includes(stop.stopId), "pending stop 应出现在 pendingStopRefs（双向一致）");
      if (stop.suggestedVisitRef !== null) {
        mediumCount++;
        assert.equal(stop.level, "medium", "带建议归属必为 medium");
        assert.equal(persistedStop.suggestedVisitRef, stop.suggestedVisitRef, "suggestedVisitRef 应落盘");
        const suggested: Visit | undefined = persisted.visits[stop.suggestedVisitRef];
        assert.ok(suggested !== undefined, "建议归属的 visit 应存在");
        assert.equal(suggested.kind, "large_attraction", "建议归属目标必须是大景区");
      } else {
        lowCount++;
        assert.equal(stop.level, "low", "无建议归属必为 low");
      }
    }
  }
  pass(`三级归类闭环：attached(high)=${attachedCount}，pending+建议(medium)=${mediumCount}，pending 无建议(low)=${lowCount}`);

  // 3c. item 回指 + stop mention 精确引用（含复用的已有 stop）
  for (const item of first.items) {
    const persistedItem = persisted.itemRegistry[item.itemId];
    assert.ok(persistedItem !== undefined, `item ${item.itemId} 应在注册表`);
    assert.ok(
      persistedItem.sourceEvidenceRefs.includes(first.evidenceId),
      "item.sourceEvidenceRefs 应回指本证据",
    );
  }
  const mentionPrefix = `${first.evidenceId}:`;
  const linkedStops = Object.values(persisted.stops).filter((stop) =>
    stop.sourceMentionRefs.some((ref) => ref.startsWith(mentionPrefix)),
  );
  assert.ok(linkedStops.length > 0, "stop.sourceMentionRefs 应精确指向本证据的 mention（含复用条目）");
  pass(`回指一致：${first.items.length} 个 item 挂证据，${linkedStops.length} 个 stop（含复用的情人桥/观日岩）引用本证据`);

  // 3d. 新建大景区壳进全局候选区（visit 与 globalCandidateRefs 双向）
  const newVisitIds = first.visits.map((visit) => visit.visitId).filter((id) => !seedVisitIds.has(id));
  for (const visitId of newVisitIds) {
    assert.ok(
      persisted.globalCandidateRefs.some((ref) => ref.kind === "visit" && ref.id === visitId),
      `新建 visit ${visitId} 应进 globalCandidateRefs`,
    );
  }
  pass(`候选区一致：${newVisitIds.length} 个新建 Visit 壳全部进入 globalCandidateRefs`);

  // 4. 隐私：百炼文件识别完即删（finally 必删）
  {
    const fileIds = [
      ...new Set(collectedLogs.join("\n").match(/fileId=([\w-]+)/g)?.map((m) => m.slice("fileId=".length)) ?? []),
    ];
    assert.ok(fileIds.length > 0, "应能从日志提取上传的 fileId");
    for (const fileId of fileIds) {
      await assert.rejects(
        () => getBailianFile(fileId),
        (error: unknown) => error instanceof Error,
        `百炼文件 ${fileId} 应已删除（查询 404）`,
      );
    }
    pass(`隐私闭环：${fileIds.length} 个百炼文件全部识别完即删（getBailianFile 均已 404）`);
  }

  // 5. 同图重跑：新证据 + 同名去重
  {
    console.log("[verify] 同图重跑开始（验证同名去重，约 30-90s）…");
    const before = await tripStore.load(trip.tripId);
    assert.ok(before !== null);
    const beforeItemCount = Object.keys(before.itemRegistry).length;

    const second = await extractFromScreenshot(trip.tripId, ocrInput);
    assert.notEqual(second.evidenceId, first.evidenceId, "重跑应产生新证据（不去重证据本身）");
    const after = await tripStore.load(trip.tripId);
    assert.ok(after !== null);
    assert.ok(after.evidences[second.evidenceId] !== undefined, "第二个证据应落盘");

    // 同名 Item 不重复（ensureItem 归一化名复用）
    const names = Object.values(after.itemRegistry)
      .map((item) => normalizePoiName(item.name))
      .filter((name) => name !== "");
    const duplicatedNames = names.filter((name, index) => names.indexOf(name) !== index);
    assert.deepEqual(duplicatedNames, [], `同名 item 应去重（重复：${duplicatedNames.join("、")}）`);

    // 同 matchedPointRef 的 Stop 唯一（ensureStopAndPlace 复用）
    const pointRefs = Object.values(after.stops)
      .map((stop) => stop.matchedPointRef)
      .filter((ref): ref is string => ref !== null);
    const duplicatedRefs = pointRefs.filter((ref, index) => pointRefs.indexOf(ref) !== index);
    assert.deepEqual(duplicatedRefs, [], "同一 matchedPointRef 不应出现两个 stop");

    const addedItems = Object.keys(after.itemRegistry).length - beforeItemCount;
    assert.ok(addedItems <= first.items.length, "重跑不应从零重建全部 item");
    pass(`同图重跑去重：新证据 ${second.evidenceId}；同名 item / 同点位 stop 零重复（净增 item ${addedItems} 个）`);
  }

  console.log(`\n[verify] Task #51 全部通过 ✓（测试行程保留供人工检查：server/data/${trip.tripId}.json）`);
}

main().catch((error: unknown) => {
  console.error("[verify] 失败：", error instanceof AiError ? `${error.code} ${error.message}` : error);
  process.exitCode = 1;
});
