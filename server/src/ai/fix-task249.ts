/**
 * Task #249 存量安全修复：别名命中的 custom Item 原地升级为飞猪实体。
 *
 * 现场（trip 48275e19-c7cb-417b-8ef7-57b04e097cf4）：
 * - 「亚龙湾森林公园」此前被抽取为 custom 点位（providerId=null，地址为空），
 *   但它命中 shared/poiAlias 的显式别名表，官方名是「亚龙湾热带天堂森林公园」；
 * - 「亚龙湾」等纯片区描述同样是 custom 点位，属于区域消歧对象，但它不在别名表内，
 *   本脚本一律不碰（不在扫描范围内）。
 *
 * 修复口径（保守，只做一件事）：
 * 1. 只扫描 `origin === "custom" && providerId === null && isPoiAlias(name)` 的 Item；
 * 2. 搜索走既有契约 planPoiSearchQueries + searchPoi（简称 + 正式名两轮），
 *    不自行拼 CLI 参数、不打印密钥；
 * 3. 升级判定与在线装配共用 decidePoiUpgradeTarget（完整候选集 + canonical 全等 +
 *    providerId 去重后唯一 + 未被其他 Item 占用）；
 *    Task #254：任一搜索轮次报错（包括「简称成功、正式名超时」）一律 status=search-error
 *    并保持 custom，绝不拿半截候选集升级、绝不吞掉错误；
 * 4. 升级只写供应商字段（origin / providerId / address / category / coords / mainPic /
 *    ticketInfo / jumpUrl），itemId、name（攻略原文名）、sourceEvidenceRefs、
 *    Visit / Stop / 排序逐字段不变；
 * 5. 默认 dry-run（只打印拟更新字段，不写盘）；`--apply` 才落盘，落盘前断言
 *    变更外实体全等，落盘后回读校验；
 * 6. 必须显式 `--trip <tripId>`（拒绝无参 / 通配批量修改），一次只处理一个行程；
 * 7. 幂等：升级后不再是 custom，重复执行直接「无待修复项」。
 *
 * 运行：
 *   npx tsx server/src/ai/fix-task249.ts --trip 48275e19-c7cb-417b-8ef7-57b04e097cf4            # dry-run
 *   npx tsx server/src/ai/fix-task249.ts --trip 48275e19-c7cb-417b-8ef7-57b04e097cf4 --apply    # 实际落盘
 */

import "../env.js";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { Item, Trip } from "@goplay/shared";
import { isPoiAlias, resolvePoiAlias } from "@goplay/shared";
import { searchPoi, type FlyAIPoi } from "../flyai/client.js";
import { tripStore } from "../persistence/store.js";
import {
  aggregatePoiCandidates,
  collectOccupiedProviderIds,
  decidePoiUpgradeTarget,
  type PoiUpgradeDecision,
} from "./poiUpgrade.js";
import {
  applyPoiUpgradeToCustomItem,
  planPoiSearchQueries,
  type PoiUpgradeFieldChange,
} from "./assemble.js";

// ===== 参数解析（显式 trip，无默认值、无通配） =====

export interface FixArgs {
  tripId: string | null;
  apply: boolean;
  help: boolean;
  /** 参数错误信息；非 null 时不得触碰任何数据 */
  error: string | null;
}

export function parseFixArgs(argv: string[]): FixArgs {
  let tripId: string | null = null;
  let apply = false;
  let help = false;
  let error: string | null = null;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--trip") {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        error = "--trip 需要一个行程 ID";
        continue;
      }
      tripId = next.trim();
      index += 1;
      continue;
    }
    if (arg.startsWith("--trip=")) {
      tripId = arg.slice("--trip=".length).trim();
      continue;
    }
    error = `未知参数 ${arg}（只支持 --trip <id> / --apply）`;
  }

  if (error === null && tripId === "") error = "--trip 的行程 ID 不能为空";
  return { tripId, apply, help, error };
}

const USAGE = [
  "用法：npx tsx server/src/ai/fix-task249.ts --trip <tripId> [--apply]",
  "",
  "  默认 dry-run：只打印拟更新字段，不写盘；",
  "  --apply：仅当别名 FlyAI 结果 canonical 全等且唯一时才原地升级并落盘。",
].join("\n");

// ===== 候选决策（唯一 / 高置信才更新）=====
// 判定本身在 ./poiUpgrade.ts（decidePoiUpgradeTarget）：在线装配与脚本共用同一实现，
// 本文件不再自带一份决策逻辑（Task #254 防口径漂移）。

// ===== 搜索（既有契约：简称 + 正式名两轮，候选聚合与在线装配同一实现） =====

export interface AliasSearchOutcome {
  pois: FlyAIPoi[];
  queries: string[];
  /** 任一查询轮次抛错时的错误信息（不含密钥，仅错误文案） */
  error: string | null;
}

/** 可注入的搜索函数（verify 脚本用它离线复现多义 / 无结果 / 部分失败 / 全部失败） */
export type AliasPoiSearcher = (itemName: string) => Promise<AliasSearchOutcome>;

/**
 * 生产搜索：与 alignWithFliggyCached 同一契约（planPoiSearchQueries + 候选聚合），
 * 只是不做「包含」降级匹配——本脚本要求比装配链路更严格的全等唯一。
 * Task #254：聚合口径（失败即停、错误上报、providerId 去重）与在线路径共用
 * aggregatePoiCandidates，避免两处再次漂移。
 */
export function createAliasPoiSearcher(city: string): AliasPoiSearcher {
  return async (itemName) => {
    const queries = planPoiSearchQueries(city, itemName);
    const aggregate = await aggregatePoiCandidates(queries, async (query) => {
      const result = await searchPoi(query);
      return result.normalized;
    });
    return { pois: aggregate.candidates, queries, error: aggregate.error };
  };
}

// ===== 扫描 / 报告 =====

export interface AliasCustomItem {
  itemId: string;
  name: string;
  canonicalName: string;
}

/** 只认别名表命中的 custom Item（区域名「亚龙湾」不在别名表内，天然排除） */
export function listAliasCustomItems(trip: Trip): AliasCustomItem[] {
  const found: AliasCustomItem[] = [];
  for (const item of Object.values(trip.itemRegistry)) {
    if (item.origin !== "custom" || item.providerId !== null) continue;
    if (!isPoiAlias(item.name)) continue;
    found.push({ itemId: item.itemId, name: item.name, canonicalName: resolvePoiAlias(item.name) });
  }
  return found.sort((left, right) => left.itemId.localeCompare(right.itemId));
}

/** 除自身外，已占用某 providerId 的 Item（重复 providerId 防御） */
function occupiedProviderIds(trip: Trip, excludeItemId: string): Map<string, string> {
  return collectOccupiedProviderIds(trip, excludeItemId);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export interface PlannedUpgrade {
  item: AliasCustomItem;
  status: "upgrade" | "no-candidate" | "ambiguous" | "occupied" | "search-error";
  providerId: string | null;
  poiName: string | null;
  /** 唯一命中的 POI 原始对象（apply 直接复用，供应商字段不二次拼装） */
  poi: FlyAIPoi | null;
  changes: PoiUpgradeFieldChange[];
  note: string;
}

/** 在副本上推演升级结果（dry-run 与 apply 共用同一实现，保证打印即所得） */
function planUpgrade(
  item: Item,
  decision: PoiUpgradeDecision,
): { changes: PoiUpgradeFieldChange[]; providerId: string; poiName: string } | null {
  if (decision.kind !== "upgrade") return null;
  const clone = JSON.parse(JSON.stringify(item)) as Item;
  const upgrade = applyPoiUpgradeToCustomItem(clone, decision.poi, item.name);
  if (upgrade === null) return null;
  return { changes: upgrade.changes, providerId: upgrade.providerId, poiName: decision.poi.name };
}

/** 逐个候选评估（导出供 verify-task249 注入搜索桩，离线复现无结果 / 多义 / 异常） */
export async function evaluateTrip(
  trip: Trip,
  searcher: AliasPoiSearcher,
): Promise<PlannedUpgrade[]> {
  const plans: PlannedUpgrade[] = [];
  for (const candidate of listAliasCustomItems(trip)) {
    const item = trip.itemRegistry[candidate.itemId]!;
    const search = await searcher(candidate.name);
    const base = {
      item: candidate,
      changes: [] as PoiUpgradeFieldChange[],
      poiName: null as string | null,
      providerId: null as string | null,
      poi: null as FlyAIPoi | null,
    };

    // Task #254：任一搜索轮次失败（含「简称查询成功、正式名查询超时」）一律
    // search-error——半截候选集不得充当唯一命中，错误原文进报告不吞掉
    if (search.error !== null) {
      plans.push({
        ...base,
        status: "search-error",
        note: `搜索失败（已获候选 ${search.pois.length} 条不作数），保持 custom：${search.error}`,
      });
      continue;
    }

    const decision = decidePoiUpgradeTarget(
      candidate.name,
      search.pois,
      occupiedProviderIds(trip, candidate.itemId),
    );
    if (decision.kind !== "upgrade") {
      const note =
        decision.kind === "no-candidate"
          ? `无 canonical 全等的 FlyAI 结果（查询：${search.queries.join(" / ")}）`
          : decision.kind === "ambiguous"
            ? `多义结果（providerId：${decision.providerIds.join("，")}），不更新`
            : decision.kind === "occupied"
              ? `providerId ${decision.providerId} 已被 Item ${decision.occupiedBy} 占用，不更新`
              : `搜索失败，保持 custom：${decision.error}`;
      plans.push({ ...base, status: decision.kind, note });
      continue;
    }

    const planned = planUpgrade(item, decision);
    if (planned === null) {
      plans.push({ ...base, status: "no-candidate", note: "升级前置条件不满足（名称 / 别名 / providerId 校验未通过）" });
      continue;
    }
    plans.push({
      ...base,
      status: "upgrade",
      providerId: planned.providerId,
      poiName: planned.poiName,
      poi: decision.poi,
      changes: planned.changes,
      note: `唯一 canonical 命中「${planned.poiName}」（查询：${search.queries.join(" / ")}）`,
    });
  }
  return plans;
}

function reportPlans(plans: PlannedUpgrade[], apply: boolean): void {
  const verb = apply ? "实际升级" : "拟升级（dry-run）";
  console.log(`[FIX-249] 扫描结果：${plans.length} 个别名命中的 custom Item`);
  for (const plan of plans) {
    const fields = plan.changes.map((change) => change.field).join(" / ");
    console.log(`\n[FIX-249] ${plan.item.name}（itemId=${plan.item.itemId}，canonical=${plan.item.canonicalName}）`);
    console.log(`  状态：${plan.status}${plan.status === "upgrade" ? ` → ${verb}` : ""}`);
    console.log(`  说明：${plan.note}`);
    if (plan.status === "upgrade") {
      for (const change of plan.changes) {
        console.log(`    ${String(change.field)}: ${formatValue(change.before)} → ${formatValue(change.after)}`);
      }
      console.log(`  变更字段（${plan.changes.length}）：${fields === "" ? "无（已是最新）" : fields}`);
    }
  }
}

// ===== 落盘（最小字段集 + 变更外全等断言） =====

async function applyPlans(tripId: string, plans: PlannedUpgrade[]): Promise<void> {
  const targets = plans.filter((plan) => plan.status === "upgrade");
  if (targets.length === 0) {
    console.log("\n[FIX-249] 没有可安全升级的目标，保持 dry-run 结果，未写盘");
    return;
  }

  const trip = await tripStore.load(tripId);
  assert.ok(trip !== null, "行程在 dry-run 后消失，中止");
  const beforeVersion = trip.version;
  const snapshots = {
    itemIds: Object.keys(trip.itemRegistry).sort(),
    visits: JSON.stringify(trip.visits),
    stops: JSON.stringify(trip.stops),
    days: JSON.stringify(trip.days),
    evidences: JSON.stringify(trip.evidences),
    globalCandidateRefs: JSON.stringify(trip.globalCandidateRefs),
    pendingStopRefs: JSON.stringify(trip.pendingStopRefs),
  };

  const upgraded: Array<{ planner: PlannedUpgrade; itemBefore: Item }> = [];
  for (const plan of targets) {
    const item: Item | undefined = trip.itemRegistry[plan.item.itemId];
    assert.ok(item !== undefined, `Item ${plan.item.itemId} 不存在，中止`);
    assert.equal(item.origin, "custom", `Item ${item.itemId} 已非 custom（幂等检查失败），中止`);
    assert.equal(item.providerId, null, `Item ${item.itemId} 已有 providerId，中止`);
    assert.equal(item.name, plan.item.name, "Item 名称与 dry-run 不一致，中止");

    // 落盘前复检：唯一性 / 占用情况必须仍成立（数据漂移即中止）
    assert.ok(plan.poi !== null, "dry-run 目标缺少 POI 详情，中止");
    const decision = decidePoiUpgradeTarget(plan.item.name, [plan.poi], occupiedProviderIds(trip, item.itemId));
    assert.equal(decision.kind, "upgrade", "dry-run 目标在落盘前复检未通过，中止");

    const itemBefore = JSON.parse(JSON.stringify(item)) as Item;
    // 显式注解：assert.deepEqual 的断言签名会把两边类型互相约束，避免推断环
    const refsBefore: string[] = [...item.sourceEvidenceRefs];
    const upgrade = applyPoiUpgradeToCustomItem(item, plan.poi, item.name);
    assert.ok(upgrade !== null, `Item ${item.itemId} 升级未生效，中止`);
    assert.equal(item.itemId, itemBefore.itemId, "itemId 必须保持不变");
    assert.equal(item.name, itemBefore.name, "name 必须保持不变");
    assert.equal(item.suggestMinutes, itemBefore.suggestMinutes, "suggestMinutes 必须保持不变");
    assert.deepEqual(item.sourceEvidenceRefs, refsBefore, "证据引用必须保持不变");
    assert.equal(item.origin, "fliggy");
    assert.equal(item.providerId, upgrade.providerId);
    upgraded.push({ planner: plan, itemBefore });
  }

  // 变更外实体全等断言（排序 / 归属 / 证据 / 集合一律不动）
  assert.deepEqual(Object.keys(trip.itemRegistry).sort(), snapshots.itemIds, "Item 集合不得变化");
  assert.equal(JSON.stringify(trip.visits), snapshots.visits, "visits 必须逐字段不变");
  assert.equal(JSON.stringify(trip.stops), snapshots.stops, "stops 必须逐字段不变");
  assert.equal(JSON.stringify(trip.days), snapshots.days, "days（排序 / 行程表）必须逐字段不变");
  assert.equal(JSON.stringify(trip.evidences), snapshots.evidences, "evidences 必须逐字段不变");
  assert.equal(JSON.stringify(trip.globalCandidateRefs), snapshots.globalCandidateRefs);
  assert.equal(JSON.stringify(trip.pendingStopRefs), snapshots.pendingStopRefs);

  // 重复 providerId 防御（全库维度）
  const seen = new Map<string, string>();
  for (const item of Object.values(trip.itemRegistry)) {
    if (item.providerId === null) continue;
    const previous = seen.get(item.providerId);
    assert.equal(previous, undefined, `providerId ${item.providerId} 同时被 ${previous} 与 ${item.itemId} 占用`);
    seen.set(item.providerId, item.itemId);
  }

  await tripStore.save(trip);

  // 回读校验（落盘后的最终证据）
  const saved = await tripStore.load(tripId);
  assert.ok(saved !== null, "回读失败");
  for (const { planner, itemBefore } of upgraded) {
    const after: Item | undefined = saved.itemRegistry[planner.item.itemId];
    assert.ok(after !== undefined, `回读缺少 Item ${planner.item.itemId}`);
    assert.equal(after.origin, "fliggy");
    assert.equal(after.providerId, planner.providerId);
    assert.equal(after.name, itemBefore.name, "回读 name 必须与升级前一致");
    assert.deepEqual(after.sourceEvidenceRefs, itemBefore.sourceEvidenceRefs, "回读证据引用必须一致");
  }
  assert.deepEqual(Object.keys(saved.itemRegistry).sort(), snapshots.itemIds, "回读 Item 集合必须不变");
  assert.equal(JSON.stringify(saved.visits), snapshots.visits, "回读 visits 必须不变");
  assert.equal(JSON.stringify(saved.stops), snapshots.stops, "回读 stops 必须不变");
  assert.equal(JSON.stringify(saved.days), snapshots.days, "回读 days 必须不变");
  assert.equal(saved.version, beforeVersion + 1, "version 应恰好自增 1");

  console.log(
    [
      "",
      "[FIX-249] 落盘完成：",
      ...upgraded.map(
        ({ planner }) =>
          `  ${planner.item.name}：custom → fliggy（providerId=${planner.providerId}，字段：${planner.changes
            .map((change) => String(change.field))
            .join(" / ")}）`,
      ),
      "  itemId / name / sourceEvidenceRefs / Visit / Stop / 排序：回读逐字段未变",
      `  Trip.version：${beforeVersion} → ${saved.version}`,
    ].join("\n"),
  );
}

// ===== 入口 =====

async function main(): Promise<void> {
  const args = parseFixArgs(process.argv.slice(2));
  if (args.error !== null) {
    console.error(`[FIX-249] 参数错误：${args.error}`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.tripId === null) {
    console.error("[FIX-249] 必须显式指定 --trip <tripId>（拒绝无参批量修改）");
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const trip = await tripStore.load(args.tripId);
  if (trip === null) {
    console.error(`[FIX-249] 行程 ${args.tripId} 不存在，中止`);
    process.exitCode = 1;
    return;
  }

  const city = trip.destination.city;
  const searcher = createAliasPoiSearcher(city);
  const plans = await evaluateTrip(trip, searcher);
  console.log(`[FIX-249] 行程 ${args.tripId}（${city}），模式：${args.apply ? "apply" : "dry-run"}`);
  reportPlans(plans, args.apply);

  if (!args.apply) {
    console.log(
      "\n[FIX-249] dry-run 结束，未写盘。确认无误后追加 --apply 落盘（只处理本行程）。",
    );
    return;
  }

  // apply 前重新加载（dry-run 期间行程可能被写入），保证断言基于最新数据
  await applyPlans(args.tripId, plans);
}

// 主模块守卫：被 verify-task249.ts import 复用纯函数时不触发真实数据修复
const invokedAsMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedAsMain) {
  main().catch((error: unknown) => {
    console.error("[FIX-249] 执行失败（未写盘）：", error);
    process.exitCode = 1;
  });
}
