/**
 * Task #187 回归验证脚本（纯 agent 桩注入，不依赖模型 / 网络 / 服务端进程）：
 * 修复对象——「主题标题 + 项目符号 + 装饰表情」组织的长文字攻略仍走百炼并超时。
 *
 * 覆盖矩阵：
 *   1. 真实等价样例（约 700 字，「三亚后海｜冲浪+赶海+citywalk =度假」结构）：
 *      quality=high、毫秒级、零远端调用、可靠地点集合精确、主题名 / 装备 / 价格 /
 *      时段 / 停车 / 季节不成为 POI、价格时段保留在原始 quote、皇后湾去重；
 *   2. 装饰清理：emoji / ▪️ / 「1.」编号前缀可剥除，Evidence quote 必须保留原始
 *      整行（不得把清洗后的片段冒充原文）；
 *   3. 中英文店名：麦芽洞穴咖啡 / Tipsy / Tree House 均可提取，大小写不敏感去重；
 *   4. 正文内明确地点句：后海村 / 渔村码头东侧礁石区 / 皇后湾可提取；逗号枚举的
 *      店铺（tree house、椰子树夏、red truck、vintage复古市集）不猜；
 *   5. 负向：主题词、防晒霜、泳衣、教练、浪高、停车、电瓶、季节不成为地点；
 *   6. 回落：普通散文、单条弱线索仍走百炼；百炼解析失败且低置信时维持整篇失败；
 *   7. 混乱清单（「阿明：开车」）即便条目数与占比达标，也因缺强锚点只到 fallback，
 *      不得顶替模型产出；
 *   8. Task #181 Day 形态回归：明确 Day 归属与既有快速路径不被本任务破坏。
 *
 * 运行：npx tsx server/src/ai/verify-task187.ts
 */

import assert from "node:assert/strict";
import type { ParsedEntry } from "./assemble.js";
import { AiError } from "./errors.js";
import {
  assessLocalExtract,
  hasStrongPlaceAnchor,
  LOCAL_FAST_PATH_MIN_ANCHORED,
} from "./localExtract.js";
import { extractNoteEntries, type ExtractAgentResponse, type ExtractCallDeps } from "./extract.js";

function pass(name: string): void {
  console.log(`✓ ${name}`);
}

// ---- 测试基建：百炼 agent 桩（脚本化响应；超出脚本的调用立即抛错） ----

type AgentScript = "garbage" | { finalText: string };

function agentStub(scripts: AgentScript[]): {
  deps: ExtractCallDeps;
  callCount: () => number;
  prompts: string[];
} {
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

/** 真实失败样例的等价文本（结构与用户提供的一致：标题 / 前言 / 六个主题段 / TIPS） */
const REAL_SAMPLE = `三亚后海｜冲浪+赶海+citywalk =度假

后海村是三亚最松弛的村子，村内小巷藏着不少咖啡馆和小店，走出去就是皇后湾的沙滩。

🌊 海边咖啡｜坐着就不想走
• 麦芽洞穴咖啡：洞穴风设计，白墙配绿植，出片率很高，冰美式35元一杯
• tipsy：体验感极强，二楼露台正对海面，适合傍晚看日落

🛍 特色小店｜饰品服饰古着
tree house、椰子树夏、red truck、vintage复古市集，都集中在村里主巷，慢慢逛一个下午刚好

🏄 冲浪｜新手天堂
皇后湾是新手最适合的浪点，浪高0.5-1米，教练一对一380元两小时，建议早上7-9点人少浪好，记得穿长袖冲浪服

🦀 赶海｜0元快乐
渔村码头东侧礁石区，退潮后能捡到小螃蟹和海螺，海鲜加工25元一斤

📷 拍照打卡
• 皇后湾日出：5:50前到位，日出方向正好对着海面
• 纯白灯塔：村口最出名的机位，白墙蓝海很出片
• 码头堤坝：涨潮时不要下水，退潮后可以走到尽头
• 网红涂鸦墙：村内小巷尽头，涂鸦每年都会换新

✅ 实用 TIPS
• 停车20元一天，租电驴50元一天，防晒霜一定要两小时补一次，11月到3月是最舒服的季节`;

const REAL_PLACES = [
  "后海村",
  "麦芽洞穴咖啡",
  "tipsy",
  "皇后湾",
  "渔村码头东侧礁石区",
  "纯白灯塔",
  "码头堤坝",
  "网红涂鸦墙",
];

// ---- 1. 真实等价样例：快速路径命中、零远端、可靠地点集合与证据原文 ----
{
  assert.equal(LOCAL_FAST_PATH_MIN_ANCHORED, 1, "快速路径强锚点下限应为 1");
  assert.equal(hasStrongPlaceAnchor("麦芽洞穴咖啡"), true, "经营场所后缀应构成强锚点");
  assert.equal(hasStrongPlaceAnchor("阿明"), false, "人名不构成强锚点");

  const startedAt = Date.now();
  const assessment = assessLocalExtract(REAL_SAMPLE);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(
    assessment.quality,
    "high",
    `真实样例应命中本地快速路径，实际指标：${JSON.stringify({
      ...assessment,
      entries: assessment.entries.map((entry) => entry.name),
    })}`,
  );
  assert.deepEqual(
    assessment.entries.map((entry) => entry.name),
    REAL_PLACES,
    "可靠地点集合应与真实样例一致（主题名 / 装备 / 价格不得混入）",
  );
  assert.equal(assessment.duplicateCount, 1, "「皇后湾日出」应归并为「皇后湾」并计数");
  assert.equal(assessment.sectionHeadingCount, 7, "标题 + 六个主题段共 7 个主题标题");
  assert.equal(assessment.colonEntryCount, 6, "带冒号的项目符号 6 行");
  assert.equal(assessment.proseEntryCount, 3, "正文明确地点句 3 行（后海村 / 皇后湾 / 礁石区）");
  assert.equal(assessment.bulletEntryCount, 0, "本样例的项目符号均带冒号");
  assert.equal(assessment.structuredLineCount, 9);
  assert.equal(assessment.proseLineCount, 2, "只有小店枚举行与 TIPS 行按散文计");
  // 「网红涂鸦墙」以「墙」收尾，不在保守锚点白名单内——它靠冒号项目符号结构而非后缀收下；
  // 快速路径只要求至少 1 条强锚点（防止整篇都是无锚点的人物清单）
  assert.equal(assessment.anchoredEntryCount, 7, "7 条地点带地理 / 经营场所锚点");
  assert.ok(assessment.anchoredEntryCount >= LOCAL_FAST_PATH_MIN_ANCHORED);
  assert.equal(assessment.truncated, false);
  assert.ok(elapsedMs < 100, `本地评估必须是毫秒级（实际 ${elapsedMs}ms）`);

  const blockedNames = [
    "冲浪",
    "赶海",
    "海边咖啡",
    "特色小店",
    "拍照打卡",
    "实用 TIPS",
    "防晒霜",
    "泳衣",
    "教练",
    "浪高",
    "停车",
    "电驴",
    "季节",
    "装备",
  ];
  for (const entry of assessment.entries) {
    assert.equal(blockedNames.includes(entry.name), false, `「${entry.name}」不得成为地点`);
    for (const fragment of ["防晒", "教练", "浪高", "停车", "电驴", "季节", "TIPS", "｜"]) {
      assert.equal(
        entry.name.includes(fragment),
        false,
        `地点名「${entry.name}」不得包含主题 / 装备 / 价格词「${fragment}」`,
      );
    }
    assert.equal(entry.type, "attraction", "本任务不新造父子 POI 推断：一律 attraction");
    assert.equal(entry.parentAttraction, null, "不得推断父级区域关系");
    assert.equal(entry.dayIndex, null, "没有 Day 标题时不凭空推断日期");
    assert.equal(entry.suggestMinutes, null, "不推断建议时长");
    assert.equal(entry.extractSource, "local");
    assert.ok(
      REAL_SAMPLE.includes(entry.quote),
      `quote 必须是原文片段（不得用清洗后的文本冒充原文）：${entry.quote}`,
    );
  }

  const byName = new Map(assessment.entries.map((entry) => [entry.name, entry]));
  assert.ok(byName.get("后海村")?.quote.includes("村内小巷"), "前言原文应完整保留");
  assert.ok(byName.get("麦芽洞穴咖啡")?.quote.startsWith("• "), "项目符号属于原文，应保留在 quote");
  assert.ok(byName.get("麦芽洞穴咖啡")?.quote.includes("35元"), "价格不得丢失");
  assert.ok(byName.get("tipsy")?.quote.includes("体验感极强"));
  assert.ok(byName.get("皇后湾")?.quote.includes("380元"), "冲浪价格必须保留在所属地点 quote");
  assert.ok(byName.get("皇后湾")?.quote.includes("7-9点"), "时段必须保留在所属地点 quote");
  assert.ok(byName.get("皇后湾")?.quote.includes("冲浪服"), "装备信息必须保留在所属地点 quote");
  assert.ok(byName.get("渔村码头东侧礁石区")?.quote.includes("海鲜加工25元一斤"), "海鲜加工价不得丢失");
  assert.ok(byName.get("纯白灯塔")?.quote.includes("村口最出名的机位"));
  assert.ok(byName.get("码头堤坝")?.quote.includes("涨潮时不要下水"));
  assert.ok(byName.get("网红涂鸦墙")?.quote.includes("涂鸦每年都会换新"));

  const stub = agentStub([]); // 任何远端调用都会抛错
  const entries: ParsedEntry[] = await extractNoteEntries(REAL_SAMPLE, stub.deps);
  assert.equal(stub.callCount(), 0, "真实样例必须命中本地路径，远端调用零次");
  assert.deepEqual(entries.map((entry) => entry.name), REAL_PLACES);
  console.log(
    `  （本地评估耗时 ${elapsedMs}ms，远低于百炼 120s 预算；` +
      `结构化 ${assessment.structuredLineCount} 行 / 散文 ${assessment.proseLineCount} 行，` +
      `占比 ${(assessment.structuredRatio * 100).toFixed(0)}%）`,
  );
  pass("1. 真实等价样例：high / 零远端 / 8 条可靠地点 / 主题与装备不误识别 / 原文与价格保留");
}

// ---- 2. 装饰清理：emoji / ▪️ / 编号可剥除，quote 保留原始整行 ----
{
  const text = `🎯 打卡点｜拍照不踩雷
▪️ 纯白灯塔：白墙蓝海很出片
1. 码头堤坝：退潮后能走到尽头
✅ 网红涂鸦墙：小巷尽头，每年换新`;
  const assessment = assessLocalExtract(text);
  assert.equal(assessment.quality, "high", JSON.stringify(assessment));
  assert.deepEqual(assessment.entries.map((entry) => entry.name), ["纯白灯塔", "码头堤坝", "网红涂鸦墙"]);
  assert.equal(assessment.sectionHeadingCount, 1);
  assert.ok(assessment.entries[0].quote.startsWith("▪️ "), "▪️ 属于原文，应保留在 quote");
  assert.ok(assessment.entries[1].quote.startsWith("1. "), "编号前缀属于原文，应保留在 quote");
  assert.ok(assessment.entries[2].quote.startsWith("✅ "), "emoji 属于原文，应保留在 quote");
  for (const entry of assessment.entries) {
    assert.ok(text.includes(entry.quote), "quote 必须是原文片段");
  }
  pass("2. 装饰清理：emoji / ▪️ / 编号可剥除，quote 保留原始整行");
}

// ---- 3. 中英文店名：具体店名可提取，大小写不敏感去重 ----
{
  const text = `☕ 海边咖啡｜坐着就不想走
• 麦芽洞穴咖啡：洞穴风设计，冰美式35元一杯
• Tipsy：二楼露台看海，体验感极强
• Tree House：手冲稳定，老板会聊豆子
• tipsy：傍晚看日落最舒服`;
  const assessment = assessLocalExtract(text);
  assert.equal(assessment.quality, "high", JSON.stringify(assessment));
  assert.deepEqual(assessment.entries.map((entry) => entry.name), ["麦芽洞穴咖啡", "Tipsy", "Tree House"]);
  assert.equal(assessment.duplicateCount, 1, "Tipsy / tipsy 应视为同一家");
  assert.ok(assessment.entries[0].quote.includes("35元"));
  assert.ok(assessment.entries[1].quote.includes("体验感极强"));
  pass("3. 中英文店名：麦芽洞穴咖啡 / Tipsy / Tree House 可提取，大小写不敏感去重");
}

// ---- 4. 正文明确地点句：可提取；逗号枚举店铺不猜 ----
{
  const text = `后海村是三亚最松弛的村子，村内小巷藏着不少咖啡馆和小店。
tree house、椰子树夏、red truck、vintage复古市集，都集中在村里主巷，慢慢逛一个下午刚好。
渔村码头东侧礁石区，退潮后能捡到小螃蟹和海螺，海鲜加工25元一斤。
皇后湾适合新手，浪高0.5-1米，教练一对一380元两小时。`;
  const assessment = assessLocalExtract(text);
  assert.equal(assessment.quality, "high", JSON.stringify(assessment));
  assert.deepEqual(
    assessment.entries.map((entry) => entry.name),
    ["后海村", "渔村码头东侧礁石区", "皇后湾"],
  );
  assert.equal(assessment.proseEntryCount, 3);
  assert.equal(assessment.proseLineCount, 1, "枚举店铺行无法证明名称边界 → 按散文计、不猜");
  for (const entry of assessment.entries) {
    for (const ambiguous of ["tree", "house", "椰子树夏", "red truck", "vintage"]) {
      assert.equal(
        entry.name.toLowerCase().includes(ambiguous.toLowerCase()),
        false,
        `逗号枚举的店铺边界不可靠时不得猜测：${entry.name}`,
      );
    }
  }
  assert.ok(assessment.entries[1].quote.includes("海鲜加工25元一斤"));
  assert.ok(assessment.entries[2].quote.includes("380元"));
  pass("4. 正文地点句：后海村 / 礁石区 / 皇后湾可提取；逗号枚举店铺不猜");
}

// ---- 5. 负向：主题词 / 装备 / 价格 / 时段 / 停车 / 季节不成为地点 ----
{
  const text = `🏄 冲浪：新手天堂
防晒霜：安耐晒两小时补涂
泳衣：带两套
教练：提前一天约
浪高：0.5-1米
停车：20元一天
季节：11月到3月`;
  const assessment = assessLocalExtract(text);
  assert.equal(assessment.entries.length, 0, `不得产出任何条目：${JSON.stringify(assessment.entries)}`);
  assert.equal(assessment.quality, "insufficient", "无地点证据必须维持远端路径");

  const stub = agentStub(["garbage", "garbage"]);
  const error = await extractNoteEntries(text, stub.deps).then(
    () => {
      throw new Error("无地点证据的文本在百炼失败后应抛错而非降级");
    },
    (err: unknown) => err,
  );
  assert.ok(error instanceof AiError, `应为 AiError，实际 ${String(error)}`);
  assert.equal(error.code, "AI_PARSE_FAILED");
  assert.equal(stub.callCount(), 2, "既有「初次 + 一次重试」行为不变");
  pass("5. 负向：主题 / 防晒 / 泳衣 / 教练 / 浪高 / 停车 / 季节均不成地点，百炼失败后安全失败");
}

// ---- 6. 普通散文仍走远端 ----
{
  const prose =
    "早上睡到自然醒，出门随便逛了逛，中午在小馆子吃了海鲜，下午突然下雨，只能在商场咖啡店坐了一下午，" +
    "晚上回酒店早早休息，第二天再继续安排。";
  const assessment = assessLocalExtract(prose);
  assert.equal(assessment.quality, "insufficient", "散文不得进入本地快速路径");
  assert.equal(assessment.entries.length, 0);

  const stub = agentStub([{ finalText: REMOTE_OUTPUT }]);
  const entries = await extractNoteEntries(prose, stub.deps);
  assert.equal(stub.callCount(), 1, "散文应恰好调用一次百炼");
  assert.deepEqual(entries.map((entry) => entry.name), ["鹿回头", "大东海"], "远端结果原样采用");
  assert.ok(entries.every((entry) => entry.extractSource === undefined), "不得注入本地标记");
  pass("6. 普通散文：quality=insufficient，照常走百炼并原样采用远端结果");
}

// ---- 7. 单条弱线索：不降级，维持整篇失败 ----
{
  const weak = "亚龙湾：真的很美。\n今天天气不错，出门随便走了走，海边的风很舒服。";
  const assessment = assessLocalExtract(weak);
  assert.equal(assessment.entries.length, 1, "仅 1 条弱线索");
  assert.equal(assessment.quality, "insufficient");

  const stub = agentStub(["garbage", "garbage"]);
  const error = await extractNoteEntries(weak, stub.deps).then(
    () => {
      throw new Error("单条弱线索在百炼失败后应抛错而非降级");
    },
    (err: unknown) => err,
  );
  assert.ok(error instanceof AiError);
  assert.equal(error.code, "AI_PARSE_FAILED");
  assert.equal(stub.callCount(), 2);
  pass("7. 单条弱线索：不达降级底线，百炼两次失败后仍抛 AI_PARSE_FAILED");
}

// ---- 8. 混乱清单：缺强锚点只到 fallback，不得顶替模型产出 ----
{
  const chaos = `阿明：开车
小美：拍照
老王：吃饭`;
  const assessment = assessLocalExtract(chaos);
  assert.equal(assessment.entries.length, 3);
  assert.equal(assessment.anchoredEntryCount, 0, "人名清单没有任何地理 / 经营场所锚点");
  assert.equal(assessment.quality, "fallback", "允许远端失败后 partial 兜底，但不得直接走快速路径");

  const stub = agentStub([{ finalText: REMOTE_OUTPUT }]);
  const entries = await extractNoteEntries(chaos, stub.deps);
  assert.equal(stub.callCount(), 1, "混乱清单必须先尝试百炼");
  assert.deepEqual(entries.map((entry) => entry.name), ["鹿回头", "大东海"], "不得用本地清单顶替模型产出");
  pass("8. 混乱清单：无强锚点只到 fallback，仍先走百炼");
}

// ---- 9. 主题标题写成冒号形态也不产出 POI ----
{
  const text = `海边咖啡：坐着就不想走
• 麦芽洞穴咖啡：洞穴风设计，冰美式35元一杯
• 素咫咖啡：二楼看海，浅烘豆子很香
• 小满咖啡：院子里的躺椅最好坐`;
  const assessment = assessLocalExtract(text);
  assert.equal(assessment.quality, "high", JSON.stringify(assessment));
  assert.deepEqual(assessment.entries.map((entry) => entry.name), ["麦芽洞穴咖啡", "素咫咖啡", "小满咖啡"]);
  assert.equal(assessment.proseLineCount, 1, "冒号形态的主题标题按散文计（不产出条目）");
  pass("9. 主题标题（冒号形态）：不成为 POI，只是段落说明");
}

// ---- 10. Task #181 Day 形态回归 ----
{
  const text = `Day 1 后海村
后海村：冲浪初学者天堂，浪况友好不呛水
藤海小学：网红打卡墙
Day 2 西岛
西岛：潜水圣地，海水清澈见底
牛王岭：看日落绝佳的小众机位
Day 3 市区
第一市场：海鲜加工便宜又新鲜`;
  const assessment = assessLocalExtract(text);
  assert.equal(assessment.quality, "high", JSON.stringify(assessment));
  assert.equal(assessment.entries.length, 5);
  assert.equal(assessment.dayHeadingCount, 3);
  const dayByName = new Map(assessment.entries.map((entry) => [entry.name, entry.dayIndex]));
  assert.equal(dayByName.get("后海村"), 1);
  assert.equal(dayByName.get("藤海小学"), 1);
  assert.equal(dayByName.get("西岛"), 2);
  assert.equal(dayByName.get("牛王岭"), 2);
  assert.equal(dayByName.get("第一市场"), 3);
  pass("10. Task #181 回归：Day 标题归属与既有「地点名：描述」快速路径不受影响");
}

// ---- 11. 无冒号项目符号：名称必须命中强锚点，装备 / 停车行拒绝 ----
{
  const text = `🌊 拍照打卡｜机位合集
• 纯白灯塔 村口最出名的机位，白墙蓝海
• 码头堤坝 涨潮别下水，退潮能走到尽头
• 皇后湾 浪高0.5-1米，新手友好
• 防晒霜 SPF50 两小时补一次
• 停车 20元一天`;
  const assessment = assessLocalExtract(text);
  assert.equal(assessment.quality, "high", JSON.stringify(assessment));
  assert.deepEqual(assessment.entries.map((entry) => entry.name), ["纯白灯塔", "码头堤坝", "皇后湾"]);
  assert.equal(assessment.bulletEntryCount, 3, "三行无冒号项目符号命中强锚点");
  assert.equal(assessment.proseLineCount, 1, "防晒霜行按散文计（停车行太短不计惩罚）");
  for (const entry of assessment.entries) {
    assert.ok(entry.quote.startsWith("• "), "项目符号属于原文，应保留在 quote");
    assert.ok(text.includes(entry.quote), "quote 必须是原文片段");
  }
  pass("11. 无冒号项目符号：强锚点才收，防晒霜 / 停车行拒绝");
}

console.log("\nTask #187 主题段 + 项目符号 + 表情型攻略本地快速抽取验证全部通过");
