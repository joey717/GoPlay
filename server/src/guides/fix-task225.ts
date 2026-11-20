/**
 * Task #225 一次性数据修复：存量行程大景区 kind 纠正 + 高置信度 pending 子玩法自动采纳。
 *
 * ## 修复一：大景区 kind 纠正
 * 现场：西岛、蜈支洲岛等景点当初经「搜索 → 候选池 → 排入」路径添加，该路径
 * 不经过 AI 抽取的 scale 判定（server/src/ai/assemble.ts），plan(point) 在 shared
 * 执行器里硬编码创建 kind:"ordinary" 壳，导致存量行程里这类知名大景区仍是普通
 * 景点——情人桥等内部玩法失去可挂载的父卡，卡片也不按大景区父卡样式渲染。
 * Task #219 已修新搜索的识别（web/src/lib/largeAttraction.ts），存量数据由本脚本纠正。
 * 修复内容：遍历 server/data/*.json 的每个 Trip，把 itemRegistry 名称命中
 * KNOWN_LARGE_ATTRACTION_KEYWORDS 且当前 kind === "ordinary" 的 Visit 就地升级为
 * "large_attraction"。只动 kind 一个字段，visitMode 等其他字段一律不改；
 * 已有 childStopRefs 的与 globalPool 候选壳同样适用。
 *
 * ## 修复二：高置信度 pending 子玩法自动采纳（验收问题修复）
 * 现场：西岛 Visit 已升级为 large_attraction，但抽取出的 7 个岛内玩法（牛王岭、
 * 珊瑚石墙、海上书屋…）仍是 state="pending"（visitRef=null）躺在待定区，
 * relationshipSuggestions 早已判定 level="high"（归属明确）。结果是子 Stop 上的
 * guideSnippets（攻略亮点）无处展示——父卡只渲染 childStopRefs 里的岛内小行程。
 * 修复内容：对每个 large_attraction Visit，把「suggestedVisitRef 指向它 + state=pending
 * + relationshipSuggestions.level="high"」的 Stop 直接落为 attached：
 *   - state → "attached"（Stop 合法状态只有 attached / pending，见 shared/src/types），
 *     visitRef → 该 Visit，order → 追加到 childStopRefs 末尾的下标；
 *   - 从 trip.pendingStopRefs 移除；suggestedVisitRef 置 null（attached 携带
 *     suggestedVisitRef 会被一致性校验拒绝），relationshipSuggestions 同步置 null
 *     （类型约定 high = 已落 attached），level / decidedBy 保留便于溯源；
 *   - 同时把证据中「本尊提及」（extractedName 归一化后等于 Visit 名，或仅多出
 *     三亚/海南等目的地前缀与旅游区/景区等通用后缀）的 mentionRef 并入
 *     Visit.sourceMentionRefs——父卡的攻略引用块与证据范围以它为准。
 *
 * 采纳边界（保守策略）：
 * - 只认 level="high"；medium / low 保留在待定区由用户归类（CandidatePool 有入口）；
 * - decidedBy="user" 跳过——用户已经表过态（例如手动从某景区移回待定），自动通道
 *   不得再覆盖；
 * - 已排期与候选区壳一视同仁（规格要求「对每个 large_attraction Visit」）：候选区
 *   壳的采纳结果由 CandidatePool 行内的「含 N 个岛内玩法」昭示，排入某天后即可在
 *   父卡看到全部子玩法与亮点，不会静默隐藏；
 * - locked / purchaseState 不设门槛：本脚本是存量数据修复而非 AI 操作，锁保护
 *   针对的是模型改动，与这里补齐归属无关（日志会标注已锁定）。
 *
 * 幂等：kind 已是 large_attraction / Stop 已 attached / 提及已存在均天然跳过；
 * 无变更的行程不写盘（不做无意义的迁移回写与 version 自增）。
 *
 * 写盘纪律：逐文件经 tripStore.load / save——load 自带读时迁移与损坏拒载；save 内置
 * 一致性校验 + version 自增 + updatedAt + 临时文件原子写。采纳子玩法会改变父 Visit
 * 的 effectiveMinutes（reserved → item → 子玩法汇总），因此采纳时就地按同一口径
 * （resolveEffectiveMinutes）刷新，写盘前再对受影响的天重算时间轴
 * （recomputeDayTimeline），避免父卡「约 X 小时」与后续节点时间失真。
 * 单个文件损坏或校验失败只记录并继续，不中断整批；有失败时退出码非零。
 *
 * 可复用纯函数：upgradeLargeAttractionVisits / applyTask225Fixes（无 IO，
 * server/src/guides/verify-task225.ts 直接 import 回归）。子玩法采纳纯函数
 * adoptHighConfidenceChildStops 已于 Task #312 抽到正式模块 server/src/guides/adoptStops.ts
 *（运行时 planner.ts applyGuideDraft 复用同一份），本脚本从该模块导入。
 *
 * 运行：npx tsx server/src/guides/fix-task225.ts
 * 预演：npx tsx server/src/guides/fix-task225.ts --dry-run（只打印将发生的变更，不写盘）
 */

import "../env.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Trip } from "@goplay/shared";
import { recomputeDayTimeline, visitDayIndex } from "@goplay/shared";
import { isValidTripId, tripStore } from "../persistence/store.js";
// Task #312：adoptHighConfidenceChildStops 及其依赖纯函数已抽到正式模块 adoptStops.ts
//（运行时 planner.ts applyGuideDraft 也复用同一份），本脚本改为从新模块导入。
import { adoptHighConfidenceChildStops, normalizePoiName, type ChildAdoption } from "./adoptStops.js";

/**
 * 知名大景区关键词：与 web/src/lib/largeAttraction.ts 的 KNOWN_LARGE_ATTRACTION_KEYWORDS 保持完全一致。
 * 2026-11-04 PD 名单更新（Task #349），旧名单见 git 历史。
 */
const KNOWN_LARGE_ATTRACTION_KEYWORDS = [
  "西岛",
  "蜈支洲岛",
  "分界洲岛",
  "南山文化旅游区",
  "呀诺达",
  "亚龙湾热带天堂森林公园",
] as const;

/** 单个 Visit 的 kind 升级记录（日志与回归验证用） */
export interface KindUpgrade {
  visitId: string;
  name: string;
  /** 升级前是否已挂岛内玩法（日志标注用） */
  hasChildren: boolean;
}

/**
 * 纯函数：把名称命中大景区关键词且 kind 为 "ordinary" 的 Visit 就地升级为
 * "large_attraction"。返回升级列表；kind 已是 large_attraction、名称未命中
 * 或 pointRef 悬空 / 名称为空的跳过（调用方据列表是否为空决定是否写盘）。
 */
export function upgradeLargeAttractionVisits(trip: Trip): KindUpgrade[] {
  const upgraded: KindUpgrade[] = [];
  for (const visit of Object.values(trip.visits)) {
    if (visit.kind !== "ordinary") continue; // 已是大景区（或未来新枚举值）：幂等跳过
    const name = trip.itemRegistry[visit.pointRef]?.name;
    if (name === undefined || name === "") continue;
    const target = normalizePoiName(name);
    if (target === "") continue;
    const hit = KNOWN_LARGE_ATTRACTION_KEYWORDS.some((keyword) =>
      target.includes(normalizePoiName(keyword)),
    );
    if (!hit) continue;
    visit.kind = "large_attraction";
    upgraded.push({
      visitId: visit.visitId,
      name,
      hasChildren: visit.childStopRefs.length > 0,
    });
  }
  return upgraded;
}

/** 一次修复的全部结果（kind 升级 + 子玩法采纳 + 需要重算的天） */
export interface Task225FixResult {
  kindUpgrades: KindUpgrade[];
  adoptions: ChildAdoption[];
  /** 需要局部重算时间轴的天（子玩法参与父 Visit 的 effectiveMinutes 汇总） */
  affectedDayIndexes: number[];
}

/** Stop 的展示名（日志用；无主数据时退 id） */
function stopDisplayName(trip: Trip, stopId: string): string {
  const stop = trip.stops[stopId];
  if (stop === undefined) return stopId;
  if (stop.customName !== null && stop.customName !== "") return stop.customName;
  const matched = stop.matchedPointRef === null ? undefined : trip.itemRegistry[stop.matchedPointRef];
  return matched?.name ?? stopId;
}

/**
 * 纯函数：一次跑完 Task #225 的两项修复（先纠正 kind，再采纳子玩法——顺序不可
 * 颠倒，否则本轮刚升级的大景区要等下次运行才会采纳其高置信度玩法）。
 */
export function applyTask225Fixes(trip: Trip): Task225FixResult {
  const kindUpgrades = upgradeLargeAttractionVisits(trip);
  const adoptions = adoptHighConfidenceChildStops(trip);
  const affected = new Set<number>();
  for (const adoption of adoptions) {
    const dayIndex = adoption.dayIndex ?? visitDayIndex(trip, adoption.visitId);
    if (dayIndex !== null) affected.add(dayIndex);
  }
  return {
    kindUpgrades,
    adoptions,
    affectedDayIndexes: [...affected].sort((a, b) => a - b),
  };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const dataDir = path.join(import.meta.dirname, "../../data");
  const files = (await fs.readdir(dataDir)).filter(
    (file) => file.endsWith(".json") && isValidTripId(file.slice(0, -".json".length)),
  );
  console.log(
    `[FIX-225] 扫描 ${dataDir}：共 ${files.length} 个行程文件${dryRun ? "（dry-run：不写盘）" : ""}`,
  );

  let scanned = 0;
  let changedTrips = 0;
  let changedVisits = 0;
  let adoptedStops = 0;
  const failures: string[] = [];

  for (const file of files) {
    const tripId = file.slice(0, -".json".length);
    let trip: Trip | null;
    try {
      trip = await tripStore.load(tripId);
    } catch (error) {
      failures.push(tripId);
      console.error(`[FIX-225] ${tripId} 读取失败（损坏拒载？），跳过：`, error);
      continue;
    }
    if (trip === null) continue;
    scanned += 1;

    const result = applyTask225Fixes(trip);
    if (result.kindUpgrades.length === 0 && result.adoptions.length === 0) continue; // 无变更不写盘

    for (const item of result.kindUpgrades) {
      console.log(
        `[FIX-225] ${tripId} visit ${item.visitId}「${item.name}」：ordinary → large_attraction` +
          `${item.hasChildren ? "（含岛内玩法）" : ""}`,
      );
    }
    for (const adoption of result.adoptions) {
      const names = adoption.stopRefs.map((stopId) => stopDisplayName(trip, stopId)).join("、");
      const visit = trip.visits[adoption.visitId];
      const flags = [
        visit?.dayRef === null ? "候选区壳" : null,
        visit?.locked === true ? "父卡已锁定，仅补归属" : null,
      ].filter((part): part is string => part !== null);
      console.log(
        `[FIX-225] ${tripId} visit ${adoption.visitId}「${adoption.visitName}」：` +
          `采纳 ${adoption.stopRefs.length} 个高置信度玩法 → childStopRefs〔${names}〕` +
          `${adoption.addedBodyMentionRefs > 0 ? `，回填本尊提及 ${adoption.addedBodyMentionRefs} 条` : ""}` +
          `${flags.length > 0 ? `（${flags.join("；")}）` : ""}`,
      );
    }

    if (dryRun) {
      changedTrips += 1;
      changedVisits += result.kindUpgrades.length;
      adoptedStops += result.adoptions.reduce((sum, item) => sum + item.stopRefs.length, 0);
      continue;
    }

    // 采纳改变父 Visit 的 effectiveMinutes：写盘前重算受影响的天，保证时间轴新鲜
    let next: Trip = trip;
    for (const dayIndex of result.affectedDayIndexes) {
      next = recomputeDayTimeline(next, dayIndex);
    }

    try {
      await tripStore.save(next); // 一致性校验 + version 自增 + 原子写
      changedTrips += 1;
      changedVisits += result.kindUpgrades.length;
      adoptedStops += result.adoptions.reduce((sum, item) => sum + item.stopRefs.length, 0);
    } catch (error) {
      failures.push(tripId);
      console.error(`[FIX-225] ${tripId} 写盘失败（一致性校验拒绝？），内存变更已丢弃：`, error);
    }
  }

  console.log(
    [
      `[FIX-225] 完成：扫描 ${scanned} 个行程，升级 ${changedTrips} 个行程 / ${changedVisits} 个 Visit 的 kind，` +
        `采纳 ${adoptedStops} 个子玩法`,
      failures.length > 0
        ? `  失败 ${failures.length} 个（未写入）：${failures.join("、")}`
        : "  无失败",
    ].join("\n"),
  );
  if (failures.length > 0) process.exitCode = 1;
}

// 主模块守卫：被 import（回归验证复用纯函数）时不触发真实数据修复，
// 只有直接运行（npx tsx server/src/guides/fix-task225.ts）才执行。
const invokedAsMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedAsMain) {
  main().catch((error: unknown) => {
    console.error("[FIX-225] 失败：", error);
    process.exitCode = 1;
  });
}
