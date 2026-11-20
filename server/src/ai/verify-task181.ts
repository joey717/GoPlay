/**
 * Task #181 回归验证脚本（纯 agent 桩注入，不依赖模型 / 网络 / 服务端进程）：
 *   1. 高置信结构化文本走本地快速路径：不调用百炼（桩收到调用即抛错），条目
 *      带本地来源标记（extractSource="local"），装配字段保持保守兜底；
 *   2. 明确 Day 归属：Day N / DN / 第 N 天 / 中文数字标题的条目拿到正确 dayIndex，
 *      标题前条目 dayIndex=null（不凭空推断日期）；
 *   3. 证据保留与去重：quote 原样保留整行原文；同名（归一化）去重只留首条并计数；
 *   4. 自由文本仍走远端：无结构条目的散文 quality=insufficient，百炼被正常调用，
 *      远端成功结果原样采用（不注入本地标记）；
 *   5. 低置信文本不安全降级：条目数 / 结构化占比不达 fallback 底线时，百炼两次
 *      解析失败后仍抛 AI_PARSE_FAILED（维持既有整篇失败语义）；
 *   6. 远端失败时高置信候选 partial 降级：百炼两次解析失败后返回本地候选并标记
 *      local_fallback（guides 结算 partial / F5 errors 提示的判据）；
 *   7. 远端成功时不降级：即便本地达到 fallback 标准，远端解析成功结果优先；
 *   8. 约 700 字真实形态攻略端到端：quality=high、Day 映射、随身物品词过滤、
 *      快速路径耗时远低于百炼预算。
 *
 * 运行：npx tsx server/src/ai/verify-task181.ts
 */

import assert from "node:assert/strict";
import type { ParsedEntry } from "./assemble.js";
import { AiError } from "./errors.js";
import {
  assessLocalExtract,
  hasLocalFallbackEntries,
  LOCAL_FALLBACK_MIN_ENTRIES,
  LOCAL_FALLBACK_MIN_RATIO,
  LOCAL_FAST_PATH_MIN_ENTRIES,
  LOCAL_FAST_PATH_MIN_RATIO,
  markLocalFallbackEntries,
} from "./localExtract.js";
import { extractNoteEntries, type ExtractAgentResponse, type ExtractCallDeps } from "./extract.js";

function pass(name: string): void {
  console.log(`✓ ${name}`);
}

// ---- 测试基建：百炼 agent 桩（脚本化响应；收到超脚本调用立即抛错） ----

type AgentScript = "garbage" | { finalText: string };

function agentStub(scripts: AgentScript[]): { deps: ExtractCallDeps; callCount: () => number; prompts: string[] } {
  const calls = { count: 0 };
  const prompts: string[] = [];
  const callAgent = async (
    prompt: string,
    _options: { timeoutMs: number },
  ): Promise<ExtractAgentResponse> => {
    const script = scripts[calls.count];
    calls.count += 1;
    prompts.push(prompt);
    if (script === undefined) {
      throw new Error(`百炼桩收到第 ${calls.count} 次调用，不应发生（本地路径不得调用远端）`);
    }
    if (script === "garbage") {
      return { finalText: "抱歉，这篇笔记我无法按照要求的格式输出结果。", latencyMs: 5 };
    }
    return { finalText: script.finalText, latencyMs: 5 };
  };
  return { deps: { callAgent, now: () => Date.now() }, callCount: () => calls.count, prompts };
}

const REMOTE_OUTPUT = JSON.stringify([
  { name: "鹿回头", type: "attraction" },
  { name: "大东海", type: "attraction" },
]);

// ---- 1. 高置信结构化文本：走本地快速路径，不调用远端 ----
{
  const text = `三亚5天4晚保姆级攻略🌊

Day 1 后海村
后海村：冲浪初学者天堂，浪况友好不呛水
藤海小学：网红打卡墙

Day 2 西岛
西岛：潜水圣地，海水清澈见底
牛王岭：看日落绝佳的小众机位

Day 3 市区
第一市场：海鲜加工便宜又新鲜
`;
  const assessment = assessLocalExtract(text);
  assert.equal(assessment.quality, "high", "5 条结构化条目 + 占比 83% 应达 high");
  assert.equal(assessment.entries.length, 5);
  assert.equal(assessment.dayHeadingCount, 3);

  const stub = agentStub([]); // 空脚本：任何一次远端调用都会抛错
  const entries = await extractNoteEntries(text, stub.deps);
  assert.equal(stub.callCount(), 0, "高置信结构化文本不得调用百炼");
  assert.equal(entries.length, 5);
  assert.deepEqual(entries.map((entry) => entry.name), [
    "后海村",
    "藤海小学",
    "西岛",
    "牛王岭",
    "第一市场",
  ]);
  for (const entry of entries) {
    assert.equal(entry.extractSource, "local", "快速路径条目应带 local 标记");
    assert.equal(entry.type, "attraction", "本地抽取不推断父子：一律 attraction");
    assert.equal(entry.parentAttraction, null);
    assert.equal(entry.scale, null, "不推断大景区规模");
    assert.equal(entry.suggestMinutes, null, "不推断建议时长");
  }
  pass("高置信结构化文本：本地快速抽取，零远端调用，装配字段保守兜底");
}

// ---- 2. 明确 Day 归属：多形态标题正确映射，标题前条目为 null ----
{
  const text = `凤凰机场：落地先吃一碗抱罗粉
第一天 抵达
第一市场：夜宵加餐
Day 2 后海村
后海村：冲浪初学者天堂
D3 市区
解放路步行街：逛吃一整晚
第4天 离岛
免税城：临走前最后一波购物
第十二天 环岛
日月湾：冲浪进阶
`;
  const assessment = assessLocalExtract(text);
  assert.equal(assessment.quality, "high");
  assert.equal(assessment.dayHeadingCount, 5, "第一天 / Day 2 / D3 / 第4天 / 第十二天");
  const dayByName = new Map(assessment.entries.map((entry) => [entry.name, entry.dayIndex]));
  assert.equal(dayByName.get("凤凰机场"), null, "首个标题之前的条目不得凭空推断日期");
  assert.equal(dayByName.get("第一市场"), 1);
  assert.equal(dayByName.get("后海村"), 2);
  assert.equal(dayByName.get("解放路步行街"), 3);
  assert.equal(dayByName.get("免税城"), 4);
  assert.equal(dayByName.get("日月湾"), 12, "中文数字「十二」应解析为 12");
  pass("明确 Day 归属：Day N / DN / 第N天 / 中文数字标题逐一映射，标题前条目保持 null");
}

// ---- 3. 证据保留与去重：quote 原样整行；同名只留首条并计数 ----
{
  const text = `Day 1
后海村：冲浪初学者天堂
后海村：浪点更多更适合进阶
第一市场：海鲜便宜又新鲜
`;
  const assessment = assessLocalExtract(text);
  assert.equal(assessment.entries.length, 2, "同名去重后只保留首条");
  assert.equal(assessment.duplicateCount, 1, "重复条目应计数");
  const first = assessment.entries[0];
  assert.equal(first.name, "后海村");
  assert.equal(first.quote, "后海村：冲浪初学者天堂", "证据文本必须原样保留首次出现的整行");
  assert.equal(first.dayIndex, 1, "去重保留首条的 Day 归属");
  assert.equal(assessment.entries[1].quote, "第一市场：海鲜便宜又新鲜");
  // 标记翻转不改动原对象
  const marked = markLocalFallbackEntries(assessment.entries);
  assert.equal(marked[0].extractSource, "local_fallback");
  assert.equal(assessment.entries[0].extractSource, "local", "翻转应返回新数组，不改动原条目");
  pass("证据保留与去重：quote 原样整行、同名留首条计数、标记翻转不可变");
}

// ---- 4. 自由文本：仍走百炼，远端成功结果原样采用 ----
{
  const proseText =
    "今天一整天的安排都比较随意，早上睡到自然醒之后才慢悠悠出门，先在住宿附近随便逛了一圈，" +
    "中午找了一家看起来本地人很多的小馆子吃饭，味道还不错但是排队挺久的，吃完又在附近走了走消食。" +
    "下午本来打算去海边走走，结果突然下起了很大的雨，只能临时改变计划钻进商场的咖啡馆坐了一下午，" +
    "看着窗外发呆也挺舒服，晚上回酒店早早休息，为明天养足精神。";
  const assessment = assessLocalExtract(proseText);
  assert.equal(assessment.quality, "insufficient", "无结构条目的散文不得进入本地快速路径");
  assert.equal(assessment.entries.length, 0);

  const stub = agentStub([{ finalText: REMOTE_OUTPUT }]);
  const entries = await extractNoteEntries(proseText, stub.deps);
  assert.equal(stub.callCount(), 1, "自由文本应恰好调用一次百炼");
  assert.ok(stub.prompts[0].includes(proseText), "百炼收到的 prompt 应包含原文");
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["鹿回头", "大东海"],
  );
  assert.ok(
    entries.every((entry) => entry.extractSource === undefined),
    "远端成功结果不得注入本地来源标记",
  );
  assert.equal(hasLocalFallbackEntries(entries), false);
  pass("自由文本：quality=insufficient，照常走百炼并原样采用远端结果");
}

// ---- 5. 低置信文本：不安全降级，百炼失败后维持整篇失败 ----
{
  const lowConfText =
    "今天一整天的安排都比较随意，早上睡到自然醒之后才慢悠悠出门，先在住宿附近随便逛了一圈，" +
    "中午找了一家看起来本地人很多的小馆子吃饭，味道还不错但是排队挺久的。\n" +
    "亚龙湾：真的很美。";
  const assessment = assessLocalExtract(lowConfText);
  assert.equal(assessment.entries.length, 1, "仅 1 条结构化条目");
  assert.equal(
    assessment.quality,
    "insufficient",
    `条目数 ${assessment.entries.length} < 降级底线 ${LOCAL_FALLBACK_MIN_ENTRIES}，应为 insufficient`,
  );

  const stub = agentStub(["garbage", "garbage"]);
  const error = await extractNoteEntries(lowConfText, stub.deps).then(
    () => {
      throw new Error("低置信文本在百炼失败后应抛错而非降级");
    },
    (err: unknown) => err,
  );
  assert.ok(error instanceof AiError, `应为 AiError，实际 ${String(error)}`);
  assert.equal(error.code, "AI_PARSE_FAILED", "低置信文本必须维持既有 AI_PARSE_FAILED 失败语义");
  assert.equal(stub.callCount(), 2, "既有解析重试行为不变（初次 + 一次重试）");
  pass("低置信文本：不安全降级，百炼两次解析失败后仍整篇抛 AI_PARSE_FAILED");
}

// ---- 6. 远端失败时：达到 fallback 标准的高置信候选安全降级 partial ----
{
  const fallbackText = `后海村：冲浪初学者的天堂
第一市场：海鲜加工集中又便宜`;
  const assessment = assessLocalExtract(fallbackText);
  assert.equal(assessment.entries.length, 2);
  assert.equal(
    assessment.quality,
    "fallback",
    `2 条全结构化条目应达 fallback（底线 ${LOCAL_FALLBACK_MIN_ENTRIES} 条 / 占比 ${LOCAL_FALLBACK_MIN_RATIO}），但未达快速路径 ${LOCAL_FAST_PATH_MIN_ENTRIES} 条`,
  );
  assert.notEqual(assessment.quality, "high", "未达快速路径门槛（3 条），必须先尝试远端");

  const stub = agentStub(["garbage", "garbage"]);
  const entries = await extractNoteEntries(fallbackText, stub.deps);
  assert.equal(stub.callCount(), 2, "降级前应先走完既有两次百炼尝试");
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.name), ["后海村", "第一市场"]);
  assert.ok(
    entries.every((entry) => entry.extractSource === "local_fallback"),
    "降级条目必须标记 local_fallback",
  );
  assert.equal(hasLocalFallbackEntries(entries), true, "guides 结算 partial / F5 errors 的判据应命中");
  assert.equal(entries[0].quote, "后海村：冲浪初学者的天堂", "降级结果同样保留原文证据");
  pass("远端解析失败：fallback 标准候选标记 local_fallback 安全降级（partial 通道）");
}

// ---- 7. 远端成功时不降级：远端结果优先于本地候选 ----
{
  const fallbackText = `后海村：冲浪初学者的天堂
第一市场：海鲜加工集中又便宜`;
  const stub = agentStub([{ finalText: REMOTE_OUTPUT }]);
  const entries = await extractNoteEntries(fallbackText, stub.deps);
  assert.equal(stub.callCount(), 1);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["鹿回头", "大东海"],
    "远端解析成功时应采用远端结果",
  );
  assert.equal(hasLocalFallbackEntries(entries), false);
  pass("远端成功：结果优先，本地候选不注入、不降级");
}

// ---- 8. 约 700 字真实形态攻略端到端：快速路径 + Day 映射 + 物品词过滤 ----
{
  const sample = `三亚五天四夜保姆级攻略｜人均3000畅玩不踩雷

【行前准备】
防晒霜：安耐晒小金瓶，两小时补涂一次
墨镜：凹造型必备单品

Day 1 后海村
后海村：冲浪初学者天堂，浪况友好不呛水
拳馆巷清补凉：本地人从小吃到大的老味道
海边秋千：日落时分拍照超出片

Day 2 西岛
西岛：潜水圣地，海水能见度很高
牛王岭：看日落绝佳的小众机位

Day 3 亚龙湾
亚龙湾热带天堂森林公园：过江龙索桥值得排队
百花谷商业街：晚上有夜市氛围很好逛

Day 4 市区
第一市场：海鲜加工便宜又新鲜
解放路步行街：逛吃逛吃一整晚

第5天 返程
免税城：临走前最后一波购物
凤凰机场：记得提前两小时到柜台

【碎碎念】
整体节奏很松弛，完全不用赶行程，每天睡到自然醒再出发也很舒服，强烈建议大家错峰出行体验会更好。`;

  const startedAt = Date.now();
  const assessment = assessLocalExtract(sample);
  const elapsedMs = Date.now() - startedAt;
  assert.equal(assessment.quality, "high", `实际指标：${JSON.stringify({ ...assessment, entries: assessment.entries.length })}`);
  assert.equal(assessment.entries.length, 11, "防晒霜 / 墨镜（随身物品词）应被过滤");
  assert.equal(assessment.dayHeadingCount, 5);
  assert.equal(assessment.dayMappedEntryCount, 11, "全部条目都有明确 Day 标题归属");
  assert.equal(assessment.duplicateCount, 0);
  assert.equal(assessment.truncated, false);
  const byName = new Map(assessment.entries.map((entry) => [entry.name, entry]));
  for (const blocked of ["防晒霜", "墨镜"]) {
    assert.equal(byName.has(blocked), false, `${blocked} 是随身物品词，不得当作地点`);
  }
  assert.equal(byName.get("后海村")?.dayIndex, 1);
  assert.equal(byName.get("西岛")?.dayIndex, 2);
  assert.equal(byName.get("亚龙湾热带天堂森林公园")?.dayIndex, 3);
  assert.equal(byName.get("第一市场")?.dayIndex, 4);
  assert.equal(byName.get("免税城")?.dayIndex, 5);
  assert.equal(byName.get("凤凰机场")?.dayIndex, 5);

  const stub = agentStub([]);
  const entries: ParsedEntry[] = await extractNoteEntries(sample, stub.deps);
  assert.equal(stub.callCount(), 0, "真实形态样例必须命中快速路径，零远端调用");
  assert.equal(entries.length, 11);
  console.log(
    `  （本地评估耗时 ${elapsedMs}ms，远低于百炼 120s 预算；条目 ${assessment.structuredLineCount} 行 / 散文 ${assessment.proseLineCount} 行，占比 ${(assessment.structuredRatio * 100).toFixed(0)}%）`,
  );
  pass("约 700 字真实形态攻略：quality=high、Day 全映射、物品词过滤、零远端调用");
}

console.log("\nTask #181 结构化文字攻略本地快速抽取验证全部通过");
