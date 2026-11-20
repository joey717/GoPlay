/**
 * Task #329 一次性数据修复：存量行程免费购物场所回填 freePoiStatus="FREE"。
 *
 * ## 现场
 * PD 反馈行程 server/data/0a27f726-9c93-48e8-ab68-1d62e9bc685b.json 的 Day5 有
 * 「国际免税城」已排点位，卡片透出「去飞猪购票」按钮——它是免费购物中心，不是景点。
 * 根因链：FlyAI search_poi 实测返回该 POI 的 freePoiStatus="UNKNOWN"、category=null
 * （但携带 jumpUrl），而 freePoiStatus 在 FliggyPoi → Item 装配时被丢弃，前端 commerce
 * 判定又只看 jumpUrl !== null，于是任何有飞猪链接的点位都被当成在售景点。
 *
 * ## 修复内容
 * 遍历 server/data/*.json，把命中「明显购物类」判定且**会透出购票按钮**（jumpUrl 非空）
 * 的 Item 回填 freePoiStatus="FREE"。运行时判定（shared/freePoi.ts）随后即可让卡片
 * 降级为「查看详情」弱入口 + 「免票」标签。
 *
 * ## 判定口径（保守，双通道）
 * - 名称通道：命中 FREE_NAME_KEYWORDS（免税 / 奥特莱斯 / 购物中心 / 商场 / 商城 /
 *   超市 / 百货 / 商业街 / 步行街）；
 * - category 通道：复用 shared 严格表 SHOPPING_CATEGORY_KEYWORDS（购物 / 免税 / 商场 /
 *   商城 / 超市 / 卖场 / 奥特莱斯 / 商业街 / 步行街）——与前端展示同一数据源。
 *
 * ## 不误杀论证（基于 server/data 全量实测扫描）
 * 任务口径提到的宽词「中心 / 广场 / 街」**刻意不入表**：存量数据里它们命中真实景点
 * ——「海棠广场」category="地标建筑"、「天涯小镇」category="文创街区"（含"街"），
 * 误杀代价（真实景点被标免票、失去购票入口）高于漏判。全量扫描下本脚本口径的命中集为：
 * 国际免税城 ×2（0a27f726 / 48275e19，fliggy + jumpUrl → 回填）、
 * 旺豪超市（48275e19，fliggy + jumpUrl → 回填，飞猪 category 脏标"公园乐园"，名称通道命中）、
 * 天街商业街 / 百花谷商业街（custom + 无 jumpUrl → 跳过，本就不渲染购票按钮，不改写）。
 * 真实景点命中数 0。另外飞猪明确标 NOT_FREE 的点位一律不覆盖（尊重供应商信号）。
 *
 * ## 范围收敛（任务要求「只修 PD 行程与明显购物类点位，不要大范围改写其他行程」）
 * 只回填 jumpUrl 非空的 Item：症状面就是「有飞猪链接 → 渲染购票按钮」，无链接的点位
 * 本来就没有购票按钮，改它只会扩大写盘面而无收益。
 *
 * 幂等：freePoiStatus 已是 "FREE" 的跳过；无变更的行程不写盘（不做无意义的 version 自增）。
 * 备份：写盘前把原文件复制为 `<tripId>.json.bak-task329`（与 .bak-task212 同命名范式；
 * 后缀不以 .json 结尾，因此不会被任何遍历 data 目录的脚本误读为行程）。
 *
 * 写盘纪律：逐文件经 tripStore.load / save——load 自带读时迁移与损坏拒载；save 内置
 * 一致性校验 + version 自增 + updatedAt + 临时文件原子写。本修复只动 Item 的一个可选
 * 字段，不影响时间轴 / 派生字段，无需重算。单个文件损坏或校验失败只记录并继续，
 * 不中断整批；有失败时退出码非零。
 *
 * 可复用纯函数：isShoppingNameHit / applyTask329Fixes（无 IO，
 * server/src/ai/verify-task329.ts 直接 import 做回归断言）。
 *
 * 运行：npx tsx server/src/guides/fix-task329.ts
 * 预演：npx tsx server/src/guides/fix-task329.ts --dry-run（只打印将发生的变更，不写盘、不备份）
 */

import "../env.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Item, Trip } from "@goplay/shared";
// Task #330 D：FREE_NAME_KEYWORDS / isShoppingNameHit 已提到 shared/freePoi.ts 单一数据源
// （运行时展示层也复用同一名称通道），本脚本改为引入，不再本地定义，避免双处漂移。
import { isShoppingCategory, isShoppingNameHit } from "@goplay/shared";
import { isValidTripId, tripStore } from "../persistence/store.js";

/**
 * 名称通道关键词（明显购物类场所）已迁至 shared/freePoi.ts 的 FREE_NAME_KEYWORDS。
 * 不含宽词「中心 / 广场 / 街」——存量数据里「海棠广场」「天涯小镇」是真实景点，
 * 宽词会误杀（见 shared/freePoi.ts 与本文件头论证）。isShoppingNameHit 同由 shared 提供。
 */

/**
 * 该 Item 是否应回填 freePoiStatus="FREE"（纯判定，不改动入参）：
 * - 已是 FREE → false（幂等）；
 * - 飞猪明确标 NOT_FREE → false（尊重供应商明确信号，名称兜底不得覆盖——
 *   与展示层 isFreeAdmissionPoi 同口径：NOT_FREE 时任何兜底均不介入）；
 * - jumpUrl 为空 → false（无购票按钮，不在症状面内）；
 * - 名称或 category 任一命中购物类（且状态为 UNKNOWN / null / 缺失）→ true。
 */
export function shouldMarkFree(item: Item): boolean {
  if (item.freePoiStatus === "FREE") return false;
  if (item.freePoiStatus === "NOT_FREE") return false;
  if (item.jumpUrl === null || item.jumpUrl === "") return false;
  return isShoppingNameHit(item.name) || isShoppingCategory(item.category);
}

/** 一条回填记录（日志与回归验证共用） */
export interface FreeStatusBackfill {
  itemId: string;
  name: string;
  category: string | null;
  /** 命中通道（日志归因用） */
  hitBy: Array<"name" | "category">;
  /** 回填前的值（缺失 / null / UNKNOWN；NOT_FREE 被短路跳过，不会出现） */
  before: Item["freePoiStatus"];
}

/**
 * 纯函数：就地把命中判定的 Item 回填 freePoiStatus="FREE"，返回回填明细。
 * 只动这一个字段，name / category / jumpUrl / sourceEvidenceRefs 等一律不改。
 */
export function applyTask329Fixes(trip: Trip): FreeStatusBackfill[] {
  const backfilled: FreeStatusBackfill[] = [];
  for (const item of Object.values(trip.itemRegistry)) {
    if (!shouldMarkFree(item)) continue;
    const hitBy: Array<"name" | "category"> = [];
    if (isShoppingNameHit(item.name)) hitBy.push("name");
    if (isShoppingCategory(item.category)) hitBy.push("category");
    backfilled.push({
      itemId: item.itemId,
      name: item.name,
      category: item.category,
      hitBy,
      before: item.freePoiStatus,
    });
    item.freePoiStatus = "FREE";
  }
  return backfilled;
}

/** 回填前的值可读化（日志用） */
function beforeText(before: Item["freePoiStatus"]): string {
  if (before === undefined) return "字段缺失";
  if (before === null) return "null";
  return before;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const dataDir = path.join(import.meta.dirname, "../../data");
  const files = (await fs.readdir(dataDir)).filter(
    (file) => file.endsWith(".json") && isValidTripId(file.slice(0, -".json".length)),
  );
  console.log(
    `[FIX-329] 扫描 ${dataDir}：共 ${files.length} 个行程文件${dryRun ? "（dry-run：不写盘、不备份）" : ""}`,
  );

  let scanned = 0;
  let changedTrips = 0;
  let changedItems = 0;
  const failures: string[] = [];

  for (const file of files) {
    const tripId = file.slice(0, -".json".length);
    let trip: Trip | null;
    try {
      trip = await tripStore.load(tripId);
    } catch (error) {
      failures.push(tripId);
      console.error(`[FIX-329] ${tripId} 读取失败（损坏拒载？），跳过：`, error);
      continue;
    }
    if (trip === null) continue;
    scanned += 1;

    const backfilled = applyTask329Fixes(trip);
    if (backfilled.length === 0) {
      console.log(`[FIX-329] ${tripId}：改动 0 条`);
      continue; // 无变更不写盘
    }

    for (const entry of backfilled) {
      console.log(
        `[FIX-329] ${tripId} item ${entry.itemId}「${entry.name}」` +
          `（category=${JSON.stringify(entry.category)}）：` +
          `freePoiStatus ${beforeText(entry.before)} → FREE（命中：${entry.hitBy.join("+")}）`,
      );
    }
    console.log(`[FIX-329] ${tripId}：改动 ${backfilled.length} 条`);

    if (dryRun) {
      changedTrips += 1;
      changedItems += backfilled.length;
      continue;
    }

    try {
      // 备份先行：写盘失败也能原样回滚（后缀 .bak-task329 不被行程遍历误读）
      const jsonPath = path.join(dataDir, file);
      await fs.copyFile(jsonPath, `${jsonPath}.bak-task329`);
      await tripStore.save(trip); // 一致性校验 + version 自增 + 原子写
      changedTrips += 1;
      changedItems += backfilled.length;
      console.log(`[FIX-329] ${tripId}：已备份 ${path.basename(jsonPath)}.bak-task329 并写盘`);
    } catch (error) {
      failures.push(tripId);
      console.error(`[FIX-329] ${tripId} 写盘失败（一致性校验拒绝？），内存变更已丢弃：`, error);
    }
  }

  console.log(
    [
      `[FIX-329] 完成：扫描 ${scanned} 个行程，回填 ${changedTrips} 个行程 / ${changedItems} 个 Item 的 freePoiStatus=FREE`,
      failures.length > 0
        ? `  失败 ${failures.length} 个（未写入）：${failures.join("、")}`
        : "  无失败",
    ].join("\n"),
  );
  if (failures.length > 0) process.exitCode = 1;
}

// 主模块守卫：被 import（回归验证复用纯函数）时不触发真实数据修复，
// 只有直接运行（npx tsx server/src/guides/fix-task329.ts）才执行。
const invokedAsMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedAsMain) {
  main().catch((error: unknown) => {
    console.error("[FIX-329] 失败：", error);
    process.exitCode = 1;
  });
}
