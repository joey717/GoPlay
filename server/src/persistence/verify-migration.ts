/**
 * S1-6 迁移验证（rev2）——migrateV1toV2 差量 / 幂等 / 拒载 完整单测。
 *
 * 运行：npx tsx server/src/persistence/verify-migration.ts
 *
 * 覆盖（任务 #83）：
 * A. 差量迁移（合成 v1 存量）：hotelCandidate → hotelRegistry + hotelRefs、
 *    删除 status / hotelCandidate、Leg.source 补 "user"、sourceMentionRefs 补 []、
 *    hotelRegistry 缺失初始化、schemaVersion 缺失 / "1.1" → 2；
 *    自定义酒店（无 shId）生成 UUID 并经 candidate.id / registry / hotelRefs 三处固定；
 * B. 幂等：migrateV1toV2(migrateV1toV2(x)) 与 migrateV1toV2(x) 深度相等；
 * C. 已是 v2 不重迁：已有 hotelRefs（多候选）/ hotelRegistry / Leg.source /
 *    sourceMentionRefs 一律不被覆盖；
 * D. 损坏文件拒载（真实 load 路径 + 临时文件，finally 清理；拒载时 console.error
 *    为预期输出）：JSON 损坏 / 内容非对象 / 未来版本 → 抛错且原文件保留；
 *    v1 文件 load 迁移 → save 落盘写回 v2 闭环；save 拒写未来版本；
 * E. 真实存量数据只读回归：server/data/*.json 全量 —— 迁移幂等 + 迁移后
 *    schemaVersion=2 + validateConsistency 通过（不写回任何文件）；
 * F. 攻略契约兼容补齐（B1，修订附录 B v0.3）：缺失 / null guideSources 补空表、
 *    已有来源表与草案快照原样保留、不反推历史 evidence、不写 guideSnippets、
 *    幂等；真实 load / save 路径落盘写回且 schemaVersion 保持 2。
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { SCHEMA_VERSION, validateConsistency } from "@goplay/shared";
import { ensureGuideContract, migrateV1toV2, tripStore } from "./store.js";

const DATA_DIR = path.join(import.meta.dirname, "../../data");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let passed = 0;
function pass(name: string): void {
  passed += 1;
  console.log(`✓ ${name}`);
}

/** JSON 深拷贝（与「落盘再读回」语义一致：剥离 undefined 键，避免引用共享） */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ===== 合成 v1 存量 fixture（形状对齐 server/data 真实文件） =====

function makeItem(itemId: string, name: string): Record<string, unknown> {
  return {
    itemId,
    name,
    origin: "custom",
    providerId: null,
    address: null,
    category: null,
    coords: null,
    suggestMinutes: 90,
    mainPic: null,
    ticketInfo: null,
    jumpUrl: null,
    sourceEvidenceRefs: [],
  };
}

/** v1 候选（有 shId；无 id 字段） */
function makeV1HotelCandidateWithShId(shId: string): Record<string, unknown> {
  return {
    shId,
    name: "三亚湾智选假日酒店",
    brandName: null,
    star: "舒适型",
    priceText: "¥183",
    priceBasis: "价格与库存以飞猪详情页为准",
    address: "解放路580号",
    interestsPoi: "近解放路步行街",
    decorationTime: null,
    coords: null,
    mainPic: null,
    detailUrl: null,
    rate: null,
  };
}

/** v1 候选（无 shId 的脏数据 / 自定义酒店：hotelId 须由迁移生成 UUID） */
function makeV1HotelCandidateNoShId(): Record<string, unknown> {
  const candidate = makeV1HotelCandidateWithShId("");
  delete (candidate as { shId?: unknown }).shId;
  candidate.name = "自家民宿";
  return candidate;
}

/**
 * v1 lodging 三种形态：
 * - candidate 对象：有候选（chosen）；
 * - candidate 显式 null：占位未选（placeholder）；
 * - candidate 传 undefined：键完全缺失（delete hotelCandidate）。
 */
function makeV1Lodging(dayIndex: number, candidate: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const lodging: Record<string, unknown> = {
    dayIndex,
    areaName: dayIndex === 1 ? "老城" : null,
    status: candidate === null ? "placeholder" : "chosen",
    checkInTime: null,
    checkOutTime: null,
    purchaseState: "unknown",
    locked: false,
    userAdjusted: false,
  };
  if (candidate !== undefined) lodging.hotelCandidate = candidate;
  if (candidate === undefined) delete lodging.status; // 键缺失形态：status 随 hotelCandidate 一起缺失
  return lodging;
}

function makeV1Visit(
  visitId: string,
  pointRef: string,
  dayRef: string,
  order: number,
  externalLeg: Record<string, unknown> | null,
  sourceMentionRefs: string[] | undefined,
): Record<string, unknown> {
  const visit: Record<string, unknown> = {
    visitId,
    dayRef,
    pointRef,
    kind: "ordinary",
    visitMode: "custom",
    order,
    windowStart: null,
    windowEnd: null,
    startTime: null,
    endTime: null,
    startTimeOverridden: false,
    endTimeOverridden: false,
    reservedMinutes: null,
    effectiveMinutes: null,
    externalLeg,
    childStopRefs: [],
    alternateStopRefs: [],
    purchaseState: "unknown",
    locked: false,
    userAdjusted: false,
    removedFrom: null,
    removedAt: null,
  };
  if (sourceMentionRefs !== undefined) visit.sourceMentionRefs = sourceMentionRefs;
  return visit;
}

/** 合成 v1 存量行程（hotelRegistry 缺失、lodging/visit 均 v1 形态） */
function makeV1Trip(tripId: string): Record<string, unknown> {
  const days: Record<string, unknown> = {};
  for (let dayIndex = 1; dayIndex <= 4; dayIndex++) {
    days[`day_${dayIndex}`] = {
      dayId: `day_${dayIndex}`,
      dayIndex,
      date: `2026-11-0${dayIndex + 7}`,
      departTime: "09:00",
      departTimeOverridden: false,
      scheduleVisitRefs: dayIndex <= 2 ? [`visit_${dayIndex}`] : [],
      lodging: { kind: "lodging", dayIndex },
    };
  }
  return {
    tripId,
    schemaVersion: "1.1",
    version: 3,
    destination: { city: "三亚", cityCode: null },
    dateRange: { start: "2026-11-08", end: "2026-11-11", nights: 3 },
    dayRefs: ["day_1", "day_2", "day_3", "day_4"],
    days,
    lodgings: {
      "1": makeV1Lodging(1, makeV1HotelCandidateWithShId("54082019")),
      "2": makeV1Lodging(2, makeV1HotelCandidateNoShId()),
      "3": makeV1Lodging(3, null),
      "4": makeV1Lodging(4, undefined),
    },
    itemRegistry: { item_1: makeItem("item_1", "大小洞天"), item_2: makeItem("item_2", "西岛") },
    visits: {
      visit_1: makeV1Visit("visit_1", "item_1", "day_1", 0, { mode: "驾车", minutes: 30, note: null }, undefined),
      // 防御性混合样本：已有 source / sourceMentionRefs 时迁移不得覆盖（幂等保护分支）
      visit_2: makeV1Visit("visit_2", "item_2", "day_2", 0, { mode: "打车", minutes: 20, note: null, source: "ai_estimate" }, ["ev_x:m1"]),
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
}

/** 已是 v2 的合成行程（多候选 / source 完整 / registry 有内容） */
function makeV2Trip(tripId: string): Record<string, unknown> {
  const trip = makeV1Trip(tripId);
  trip.schemaVersion = 2;
  trip.lodgings = {
    "1": {
      dayIndex: 1,
      areaName: "老城",
      hotelRefs: ["h1", "h2"],
      checkInTime: null,
      checkOutTime: null,
      purchaseState: "unknown",
      locked: false,
      userAdjusted: false,
    },
  };
  trip.hotelRegistry = {
    h1: { id: "h1", shId: "h1", name: "首选酒店", brandName: null, star: null, priceText: null, priceBasis: "价格与库存以飞猪详情页为准", address: null, interestsPoi: null, decorationTime: null, coords: null, mainPic: null, detailUrl: null, rate: null },
    h2: { id: "h2", shId: "h2", name: "备选酒店", brandName: null, star: null, priceText: null, priceBasis: "价格与库存以飞猪详情页为准", address: null, interestsPoi: null, decorationTime: null, coords: null, mainPic: null, detailUrl: null, rate: null },
  };
  const visits = trip.visits as Record<string, Record<string, unknown>>;
  visits.visit_1.externalLeg = { mode: "驾车", minutes: 30, note: null, source: "ai_estimate" };
  visits.visit_1.sourceMentionRefs = ["ev_y:m2"];
  return trip;
}

// ===== 临时文件管理（D 段用；finally 必删） =====

const tmpTripIds: string[] = [];

async function writeTempTrip(contents: (tripId: string) => string): Promise<string> {
  const tripId = crypto.randomUUID();
  tmpTripIds.push(tripId);
  await fs.writeFile(path.join(DATA_DIR, `${tripId}.json`), contents(tripId), "utf8");
  return tripId;
}

async function cleanupTempTrips(): Promise<void> {
  for (const tripId of tmpTripIds) {
    await fs.rm(path.join(DATA_DIR, `${tripId}.json`), { force: true });
  }
  tmpTripIds.length = 0;
}

// ===== 主流程 =====

async function main(): Promise<void> {
  try {
    // ---- A. 差量迁移（合成 v1 存量） ----
    {
      const migrated = migrateV1toV2(clone(makeV1Trip("11111111-1111-4111-8111-111111111111")));

      assert.equal(SCHEMA_VERSION, 2);
      assert.equal(migrated.schemaVersion, SCHEMA_VERSION, "缺失 / \"1.1\" 迁移后须为数字 2");
      assert.equal(typeof migrated.schemaVersion, "number");

      // 差量 f：hotelRegistry 缺失初始化（含两个被上移的候选）
      assert.equal(typeof migrated.hotelRegistry, "object");
      // 差量 a：有 shId 候选 → hotelId = shId，三处固定
      assert.deepEqual(migrated.lodgings["1"]!.hotelRefs, ["54082019"]);
      assert.equal(migrated.hotelRegistry["54082019"]!.id, "54082019");
      assert.equal(migrated.hotelRegistry["54082019"]!.shId, "54082019");
      assert.equal(migrated.hotelRegistry["54082019"]!.name, "三亚湾智选假日酒店");
      // 差量 a：无 shId 候选 → UUID 生成，candidate.id / registry key / hotelRefs[0] 三处一致
      const uuidRef = migrated.lodgings["2"]!.hotelRefs[0]!;
      assert.match(uuidRef, UUID_PATTERN, "无 shId 候选须生成 UUID 作为 hotelId");
      assert.equal(migrated.hotelRegistry[uuidRef]!.id, uuidRef);
      assert.equal(migrated.hotelRegistry[uuidRef]!.name, "自家民宿");
      // 无候选形态：hotelRefs 补空
      assert.deepEqual(migrated.lodgings["3"]!.hotelRefs, []);
      assert.deepEqual(migrated.lodgings["4"]!.hotelRefs, []);
      // 差量 b/c：v1 专属字段同次迁移内删除
      assert.equal("hotelCandidate" in migrated.lodgings["1"]!, false);
      assert.equal("status" in migrated.lodgings["1"]!, false);
      assert.equal("hotelCandidate" in migrated.lodgings["3"]!, false);
      assert.equal("status" in migrated.lodgings["3"]!, false);
      // 差量 d：Leg.source 补 "user"（缺失才补）
      assert.equal(migrated.visits.visit_1!.externalLeg!.source, "user");
      // 差量 e：sourceMentionRefs 缺失才补空
      assert.deepEqual(migrated.visits.visit_1!.sourceMentionRefs, []);
      // 幂等保护分支：已有值不改写
      assert.equal(migrated.visits.visit_2!.externalLeg!.source, "ai_estimate");
      assert.deepEqual(migrated.visits.visit_2!.sourceMentionRefs, ["ev_x:m1"]);
      // 其余字段不动
      assert.equal(migrated.version, 3);
      assert.deepEqual(migrated.destination, { city: "三亚", cityCode: null });
      assert.deepEqual(migrated.days.day_1!.date, "2026-11-08");
      pass("差量迁移：候选上移 registry + hotelRefs（shId / UUID / 补空三形态）、v1 字段删除、Leg.source 与 sourceMentionRefs 补全、版本号 → 2");

      // ---- B. 幂等（合成 v1） ----
      const once = clone(migrated);
      const twice = migrateV1toV2(clone(migrated));
      assert.deepEqual(twice, once, "migrate(migrate(x)) 须与 migrate(x) 深度相等");
      const thrice = migrateV1toV2(clone(twice));
      assert.deepEqual(thrice, twice, "第三次迁移仍须无操作");
      pass("幂等：migrate(migrate(x)) === migrate(x)（深度相等，含 UUID 候选与补全字段）");
    }

    // ---- C. 已是 v2 的数据不被重复迁移 ----
    {
      const v2 = makeV2Trip("22222222-2222-4222-8222-222222222222");
      const after = migrateV1toV2(clone(v2));
      assert.deepEqual(after, v2, "v2 数据过迁移函数须完全无变化");
      // 显式断言关键保护点
      assert.deepEqual(after.lodgings["1"]!.hotelRefs, ["h1", "h2"], "已有多候选不重建");
      assert.equal(Object.keys(after.hotelRegistry).length, 2, "已有 registry 不覆盖不合并");
      assert.equal(after.visits.visit_1!.externalLeg!.source, "ai_estimate", "已有 source 不改");
      assert.deepEqual(after.visits.visit_1!.sourceMentionRefs, ["ev_y:m2"], "已有 sourceMentionRefs 不改");
      pass("已是 v2 不重迁：hotelRefs 多候选 / hotelRegistry / Leg.source / sourceMentionRefs 全部原样保留");

      // 坏入参防御
      assert.throws(() => migrateV1toV2(null), /入参必须是 Trip 形状的对象/);
      assert.throws(() => migrateV1toV2([1, 2]), /入参必须是 Trip 形状的对象/);
      assert.throws(() => migrateV1toV2("x"), /入参必须是 Trip 形状的对象/);
      pass("坏入参防御：null / 数组 / 字符串直接抛可识别错误");
    }

    // ---- D. 损坏文件拒载 + 落盘闭环（真实 load / save 路径） ----
    console.log("（以下 console.error 为拒载用例的预期输出）");
    {
      // 拒载 1：JSON 解析失败 → 抛错且原文件保留
      const brokenId = await writeTempTrip(() => "{ not-json !!!");
      await assert.rejects(tripStore.load(brokenId), /行程文件损坏（JSON 解析失败）/);
      assert.equal(await fs.readFile(path.join(DATA_DIR, `${brokenId}.json`), "utf8"), "{ not-json !!!");

      // 拒载 2：内容非对象 → 抛错且原文件保留
      const arrId = await writeTempTrip(() => "[1,2,3]");
      await assert.rejects(tripStore.load(arrId), /行程文件损坏（内容不是 Trip 对象）/);
      assert.equal(await fs.readFile(path.join(DATA_DIR, `${arrId}.json`), "utf8"), "[1,2,3]");

      // 拒载 3：未来版本 → 抛错（不可降级载入）
      const futureId = await writeTempTrip((tripId) =>
        JSON.stringify({ tripId, schemaVersion: 99, version: 1 }),
      );
      await assert.rejects(tripStore.load(futureId), /schemaVersion 异常/);
      pass("损坏文件拒载：JSON 损坏 / 非对象 / 未来版本均抛错，原文件保留未改动");

      // 正向闭环：v1 文件 load（内存迁移）→ save（落盘写回 v2）
      const fixtureId = await writeTempTrip((tripId) => JSON.stringify(makeV1Trip(tripId), null, 2));
      const loaded = await tripStore.load(fixtureId);
      assert.ok(loaded !== null);
      assert.equal(loaded.schemaVersion, 2);
      assert.deepEqual(loaded.lodgings["1"]!.hotelRefs, ["54082019"]);
      assert.equal("status" in loaded.lodgings["1"]!, false);
      assert.equal(loaded.visits.visit_1!.externalLeg!.source, "user");
      assert.deepEqual(validateConsistency(loaded), []);
      await tripStore.save(loaded);
      const onDisk = JSON.parse(await fs.readFile(path.join(DATA_DIR, `${fixtureId}.json`), "utf8")) as {
        schemaVersion: unknown;
        version: unknown;
        lodgings: Record<string, Record<string, unknown>>;
        hotelRegistry: Record<string, Record<string, unknown>>;
      };
      assert.equal(onDisk.schemaVersion, 2, "save 落盘须写最新版本号");
      assert.equal(onDisk.version, 4, "save 须自增 version（3 → 4）");
      assert.equal("hotelCandidate" in onDisk.lodgings["1"]!, false, "v1 字段不落盘");
      assert.deepEqual(onDisk.lodgings["1"]!.hotelRefs, ["54082019"]);
      assert.equal(onDisk.hotelRegistry["54082019"]!.name, "三亚湾智选假日酒店");
      pass("落盘闭环：v1 文件 load 内存迁移 → validateConsistency 通过 → save 写回 v2（无 v1 字段残留）");

      // save 拒写未来版本（不落盘）
      const futureTrip = clone(makeV2Trip(crypto.randomUUID())) as Record<string, unknown>;
      futureTrip.schemaVersion = 99;
      await assert.rejects(tripStore.save(futureTrip as never), /拒绝保存未来版本/);
      await assert.rejects(fs.access(path.join(DATA_DIR, `${String(futureTrip.tripId)}.json`)));
      pass("save 拒写未来版本：抛错且不产生任何文件");
    }

    // ---- F. 攻略契约兼容补齐（B1，不提升 schemaVersion） ----
    {
      const v1 = clone(makeV1Trip("33333333-3333-4333-8333-333333333333"));
      const migrated = ensureGuideContract(migrateV1toV2(clone(v1)));
      assert.equal(migrated.schemaVersion, 2, "攻略契约不提升 schemaVersion");
      assert.deepEqual(migrated.guideSources, {}, "缺失 guideSources 须在读取边界补空表");
      const migratedVisit = migrated.visits.visit_1 as unknown as Record<string, unknown>;
      assert.equal("guideSnippets" in migratedVisit, false, "不得为可选 guideSnippets 写空数组");

      // 幂等：第二次补齐必须无变化
      assert.deepEqual(ensureGuideContract(clone(migrated)), migrated, "ensureGuideContract 须幂等");

      // 已有来源表 / 补充句 / 草案快照原样保留
      const withRegistry = clone(migrated) as unknown as Record<string, unknown>;
      const sourceStub = {
        sourceId: "gs_1",
        sourceVersion: 1,
        inputKind: "text",
        active: true,
        status: "processing",
        evidenceRefs: [],
        mentionRefs: [],
        imageProgress: { total: 0, completed: 0, failed: 0, images: [] },
        importedAt: "2026-10-19T00:00:00.000Z",
        updatedAt: "2026-10-19T00:00:00.000Z",
      };
      withRegistry.guideSources = { gs_1: sourceStub };
      withRegistry.guideDraftNote = "只安排海边";
      withRegistry.pendingGuideDraft = {
        draftId: "draft_1",
        baseTripVersion: 3,
        scope: { kind: "trip" },
        sourceSnapshots: [{ sourceId: "gs_1", sourceVersion: 1 }],
        mentionIds: [],
        note: null,
        createdAt: "2026-10-19T00:00:00.000Z",
      };
      const preserved = ensureGuideContract(clone(withRegistry));
      assert.deepEqual(preserved.guideSources, { gs_1: sourceStub }, "已有来源表不得被覆盖");
      assert.equal(preserved.guideDraftNote, "只安排海边", "补充句不得被清理");
      assert.equal(preserved.pendingGuideDraft?.draftId, "draft_1", "草案快照不得被清理");

      // 不反推历史 evidence：即使已有证据，来源表仍为空
      const withEvidence = clone(migrated);
      withEvidence.evidences = {
        ev_hist: {
          evidenceId: "ev_hist",
          kind: "note_text",
          noteIndex: 1,
          assetRef: null,
          sourceUrl: null,
          ocrText: null,
          mentions: [
            {
              mentionId: "m1",
              text: "西岛",
              quoteText: "西岛很好",
              bbox: null,
              extractedName: "西岛",
              locationHint: null,
              modelSummary: null,
            },
          ],
        },
      };
      ensureGuideContract(withEvidence);
      assert.deepEqual(withEvidence.guideSources, {}, "不得把历史 evidence 反推成 GuideSource");

      // null 视为缺失；数组等损坏形态保留，交给一致性校验报错（不静默丢数据）
      const nulled = clone(migrated) as unknown as Record<string, unknown>;
      nulled.guideSources = null;
      assert.deepEqual(ensureGuideContract(nulled).guideSources, {});
      const broken = clone(migrated) as unknown as Record<string, unknown>;
      broken.guideSources = [];
      assert.deepEqual(
        (ensureGuideContract(broken) as unknown as Record<string, unknown>).guideSources,
        [],
        "损坏形态不得静默覆盖",
      );
      assert.throws(() => ensureGuideContract(null), /入参必须是 Trip 形状的对象/);
      pass("攻略契约补齐：缺失/null 补空表、已有来源与草案保留、不反推证据、不写 guideSnippets、幂等");

      // 真实 load / save 路径：v2 文件缺 guideSources → 读时补齐 → 落盘写回（版本不变）
      const legacyV2Id = await writeTempTrip((tripId) => JSON.stringify(makeV2Trip(tripId), null, 2));
      const legacyLoaded = await tripStore.load(legacyV2Id);
      assert.ok(legacyLoaded !== null);
      assert.deepEqual(legacyLoaded.guideSources, {}, "load 须在读取边界补齐空表");
      const versionBeforeSave = legacyLoaded.version;
      await tripStore.save(legacyLoaded);
      const legacyOnDisk = JSON.parse(
        await fs.readFile(path.join(DATA_DIR, `${legacyV2Id}.json`), "utf8"),
      ) as { guideSources?: unknown; schemaVersion?: unknown; version?: unknown };
      assert.deepEqual(legacyOnDisk.guideSources, {}, "save 落盘须写回 guideSources 空表");
      assert.equal(legacyOnDisk.schemaVersion, 2, "攻略补齐不得提升 schemaVersion");
      assert.equal(legacyOnDisk.version, versionBeforeSave + 1, "save 仍按原契约自增 version");
      pass("读取边界：v2 缺 guideSources → load 补齐 → save 落盘写回（schemaVersion 保持 2）");
    }

    // D/F 段临时文件即时清理（E 段只遍历真实存量文件；finally 仍兜底）
    await cleanupTempTrips();

    // ---- E. 真实存量数据只读回归 ----
    {
      const files = (await fs.readdir(DATA_DIR))
        .filter((name) => name.endsWith(".json") && !name.endsWith(".tmp.json"))
        .sort();
      assert.ok(files.length > 0, "server/data 下应存在存量行程文件");
      for (const file of files) {
        const raw = JSON.parse(await fs.readFile(path.join(DATA_DIR, file), "utf8")) as unknown;
        const once = ensureGuideContract(migrateV1toV2(clone(raw)));
        const twice = ensureGuideContract(migrateV1toV2(clone(once)));
        assert.deepEqual(twice, once, `${file}：迁移 + 攻略契约补齐非幂等`);
        assert.equal(once.schemaVersion, SCHEMA_VERSION, `${file}：迁移后版本须为 2`);
        assert.equal(typeof once.guideSources, "object", `${file}：guideSources 须补齐为对象`);
        assert.ok(once.guideSources !== null && !Array.isArray(once.guideSources), `${file}：guideSources 形态非法`);
        const errors = validateConsistency(once);
        assert.deepEqual(errors, [], `${file}：迁移后一致性失败（${errors.slice(0, 2).join("；")}）`);
      }
      pass(`真实存量数据回归：${files.length} 个文件迁移幂等 + 版本正确 + 一致性通过（只读，未写回）`);
    }

    console.log(`\n[verify-migration] S1-6 全部通过 ✓（共 ${passed} 组）`);
  } finally {
    await cleanupTempTrips();
  }
}

main().catch((error: unknown) => {
  console.error("[verify-migration] 失败：", error);
  process.exitCode = 1;
});
