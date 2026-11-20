/**
 * Task #212 一次性数据修复：攻略亮点 snippets 与原文引用存量去重。
 *
 * 现场（trip d0174797-f87f-4726-8c55-833840235e51，用户验收截图）：
 * - 同一篇攻略删除来源后重新添加（src_61ddc9ff → src_64380471），旧来源挂在实体上的
 *   snippet 按设计不级联删除，重新应用草案后同类亮点成对出现：
 *   「可以 走过江龙索桥」×2（亚龙湾热带天堂森林公园）；
 * - AI 生成文本带随机空格 / 局部改写，多次应用草案后相似亮点叠加：
 *   「丹姐清补凉甜度恰到好处…」×2、「赶海要下午退潮后再去」×2 等（共 5 组）；
 * - 早期数据同一句提及在两条证据中重复提取并被实体同时引用（ev_note_1:m2 +
 *   ev_note_2:m2），原文弹层出现重复提及 / 重复来源 tab。
 *
 * 修复内容：对全部 Visit / Stop 跑 shared 纯函数
 * deduplicateSnippets / deduplicateStopSnippets（归一化 + 子序列重合率 ≥ 0.9 判近似；
 * 引用同一 sourceMentionRef 时放宽为重合率 ≥ 0.8 或公共前缀 ≥ 10 字且覆盖较短串 ≥ 60%，
 * 覆盖「三和风味馆招牌马头鱼鲜嫩入味，强烈安利」vs「…，尖椒炒蛋巨下饭」这类同句两次
 * 截取；代表挑选 active 来源引用优先 → 更长文本 → 引用更多；sourceMentionRefs 按
 * 归属来源 + 归一化提及文本组合键去重，悬空引用保留）。只清洗上述字段，
 * 不触碰行程结构、证据原始数据与 optionGroups。
 *
 * 安全边界：
 * - 写盘前把原 JSON 复制为 <tripId>.json.bak-task212（data/ 不在 git 内，必须文件级备份）；
 * - tripStore.save 内置一致性校验，任何结构错误拒绝写入；
 * - 幂等：修复后回读再跑一遍去重必须全部无变化，否则视为失败退出。
 *
 * 运行：npx tsx server/src/guides/fix-task212.ts [tripId]
 * （缺省 tripId 为现场行程；传入其他 tripId 可清理任意行程）
 */

import "../env.js";
import assert from "node:assert/strict";
import { copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deduplicateSnippets, deduplicateStopSnippets } from "@goplay/shared";
import type { Visit } from "@goplay/shared";
import { tripStore } from "../persistence/store.js";

const DEFAULT_TRIP_ID = "d0174797-f87f-4726-8c55-833840235e51";
const DATA_DIR = path.join(import.meta.dirname, "../../data");

/** 实体清洗前的摘要行（id / 文本 / 引用），用于控制台前后对比 */
function snippetLines(entity: { guideSnippets?: unknown; sourceMentionRefs?: unknown }): string[] {
  const snippets = Array.isArray(entity.guideSnippets)
    ? (entity.guideSnippets as Array<{ snippetId: string; text: string; sourceMentionRefs: string[] }>)
    : [];
  const refs = Array.isArray(entity.sourceMentionRefs) ? (entity.sourceMentionRefs as string[]) : [];
  const lines = snippets.map(
    (snippet) => `      snippet ${snippet.snippetId}「${snippet.text}」refs=${JSON.stringify(snippet.sourceMentionRefs)}`,
  );
  if (refs.length > 0) lines.push(`      refs=${JSON.stringify(refs)}`);
  return lines;
}

async function main(): Promise<void> {
  const tripId = process.argv[2] !== undefined && process.argv[2] !== "" ? process.argv[2] : DEFAULT_TRIP_ID;
  const trip = await tripStore.load(tripId);
  if (trip === null) {
    console.error(`[FIX-212] 行程 ${tripId} 不存在，退出`);
    process.exitCode = 1;
    return;
  }

  const visitEntries = Object.entries(trip.visits ?? {});
  const stopEntries = Object.entries(trip.stops ?? {});
  const report: string[] = [];
  let changedEntities = 0;

  for (const [id, visit] of visitEntries) {
    const before = snippetLines(visit);
    const cleaned = deduplicateSnippets(visit as Visit, trip);
    if (cleaned !== visit) {
      changedEntities += 1;
      trip.visits[id] = cleaned;
      report.push(
        [`  [visit ${id}]`, `    修复前：`, ...before, `    修复后：`, ...snippetLines(cleaned)].join("\n"),
      );
    }
  }
  for (const [id, stop] of stopEntries) {
    const before = snippetLines(stop);
    const cleaned = deduplicateStopSnippets(stop, trip);
    if (cleaned !== stop) {
      changedEntities += 1;
      trip.stops[id] = cleaned;
      report.push([`  [stop ${id}]`, `    修复前：`, ...before, `    修复后：`, ...snippetLines(cleaned)].join("\n"));
    }
  }

  if (changedEntities === 0) {
    console.log(`[FIX-212] 行程 ${tripId} 无重复亮点 / 引用，幂等跳过（不写盘）`);
    return;
  }

  // data/ 不在 git 内：写盘前文件级备份原 JSON
  const tripFile = path.join(DATA_DIR, `${tripId}.json`);
  copyFileSync(tripFile, `${tripFile}.bak-task212`);

  await tripStore.save(trip); // 一致性校验 + version 自增 + updatedAt

  // 回读断言：落盘数据再跑一遍去重必须全部无变化（幂等证明）
  const saved = await tripStore.load(tripId);
  assert.ok(saved !== null, "回读应命中刚落盘的行程");
  for (const visit of Object.values(saved.visits ?? {})) {
    assert.ok(deduplicateSnippets(visit, saved) === visit, `回读后 visit ${visit.visitId} 应已无重复`);
  }
  for (const stop of Object.values(saved.stops ?? {})) {
    assert.ok(deduplicateStopSnippets(stop, saved) === stop, `回读后 stop ${stop.stopId} 应已无重复`);
  }

  console.log(
    [`[FIX-212] 修复完成并落盘（原文件已备份为 .bak-task212）：`, `  清洗实体 ${changedEntities} 个：`, ...report].join(
      "\n",
    ),
  );
}

// 主模块守卫：被 import（如验证脚本复用）时不触发真实数据修复，
// 只有直接运行（npx tsx server/src/guides/fix-task212.ts）才执行。
const invokedAsMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedAsMain) {
  main().catch((error: unknown) => {
    console.error("[FIX-212] 失败：", error);
    process.exitCode = 1;
  });
}
