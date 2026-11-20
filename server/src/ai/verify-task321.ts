/**
 * Task #321 回归验证脚本（纯函数，不依赖模型 / 网络 / 服务端进程 / 落盘）：
 * 打卡点过滤器第 3 层「虚词误杀」修复——三档定位（逐字包含 → 去虚词包含 →
 * bigram 重叠相似度 ≥ MIN_BIGRAM_OVERLAP）在放宽误杀的同时不放行编造专名。
 *
 * 覆盖：
 *   1. 缺陷本体（Iris #320 定案）：彩色西岛字母 / 原文「沙滩上彩色西岛的字母」→ keep；
 *   2. b 档双向：name 带虚词而 quote 不带（彩色西岛的字母 / 沙滩彩色西岛字母）→ keep；
 *   3. c 档阈值边界：bigram 命中 4/5=0.80 → keep；3/4=0.75 → reject（阈值 0.8 的两侧）；
 *   4. 泛化拒绝不回归：椰林沙滩 / 普通沙滩 / 小吃街 / 海边公路 / 入口旁 / 码头左侧 → reject；
 *   5. 编造拒绝不回归：quote 中字面零痕迹（粉红沙滩 / 神秘灯塔 / 海上秋千 / 彩虹玻璃球 /
 *      彩色西岛字母 vs「海边有一排字母装置」）→ reject；冗长定名形态（真实落盘曾过滤的
 *      「码头出岛内口后左转的彩色西岛字母」）行为不变，作为锚点单列；
 *   6. 虚词占满的片段不放行：之上灯塔（stem 为空）/ 海上秋千（stem=「海」）→ reject；
 *   7. 既有通过形态不回归：西岛墙 / 珊瑚墙 / 木门歪椰树 / 灯塔 / 第一市场 / 六角亭 /
 *      白墙 / 孤独的树 / 珊瑚墙前椰林沙滩 / 临海公路 → keep；
 *   8. quote 为空：缺原文佐证的专名一律 reject（与修复前同口径）。
 *
 * 运行：npx tsx server/src/ai/verify-task321.ts（或 npm run verify:checkpoint -w server）
 */

import assert from "node:assert/strict";
import { shouldRejectCustomCheckpoint } from "./checkpointFilter.js";

function pass(name: string): void {
  console.log(`✓ ${name}`);
}

/** 西岛笔记原句（逐字取自 eval/harness/q7Truth.ts 真值表，含 ➡️ 前缀与全角括号页码） */
const QUOTE_XIDAO_LETTERS =
  "➡️出码头左转出来就能看到沙滩上彩色西岛的字母（p4 p5）不想排队可以学我的角度错位拍 再把后面人消除就行";
const QUOTE_SEA_ROAD = "➡️再往前沿海边走是临海公路随手拍都很美 还特别蓝（p16 p17）";
const QUOTE_CORAL_BEACH = "➡️再去珊瑚墙前会经过一个沙滩有很多椰子树这里很出片！而且不排队！（p1 p3）";

function assertKeep(name: string, quote: string, label: string): void {
  assert.equal(
    shouldRejectCustomCheckpoint({ name, quote }),
    false,
    `「${name}」应保留（${label}）`,
  );
}

function assertReject(name: string, quote: string, label: string): void {
  assert.equal(
    shouldRejectCustomCheckpoint({ name, quote }),
    true,
    `「${name}」应被过滤（${label}）`,
  );
}

// ---- 1. 缺陷本体：差一个「的」不再误杀 ----
assertKeep("彩色西岛字母", QUOTE_XIDAO_LETTERS, "b 档：原文「彩色西岛的字母」多一个的");
assertKeep("彩色西岛字母", "沙滩上彩色西岛的字母", "b 档：最短形态同样命中");
assertKeep("彩色西岛字母", "沙滩上彩色西岛的字母（p4 p5）", "b 档：括号页码归一化后命中");
pass("缺陷本体：彩色西岛字母 / 原文含「的」→ keep（Task #321 修复目标）");

// ---- 2. b 档双向：name 侧带虚词、quote 侧不带 ----
assertKeep("彩色西岛的字母", "沙滩彩色西岛字母很出片", "b 档：name 侧虚词同样被削除");
assertKeep("西岛之中灯塔", "岛尾有座西岛灯塔 p3", "b 档：多虚词削除后包含");
pass("b 档双向：name / quote 任一侧夹带闭集虚词均可定位");

// ---- 3. c 档阈值边界（MIN_BIGRAM_OVERLAP = 0.8）----
// 去虚词后 quote = 「沙滩彩色西岛大字母」（「大」为实词插入，b 档子串包含失败）
const QUOTE_INSERTED = "沙滩上彩色西岛的大字母";
// stem「彩色西岛字母」5 个 bigram 命中 4 个（彩色/色西/西岛/字母）= 0.80 ≥ 0.8 → keep
assertKeep("彩色西岛字母", QUOTE_INSERTED, "c 档：bigram 命中 4/5=0.80，恰在阈值上");
// stem「彩色西岛牌」4 个 bigram 命中 3 个（彩色/色西/西岛）= 0.75 < 0.8 → reject
assertReject("彩色西岛牌", QUOTE_INSERTED, "c 档：bigram 命中 3/4=0.75，恰在阈值下");
pass("c 档边界：0.80 keep / 0.75 reject（阈值两侧各一条）");

// ---- 4. 泛化拒绝不回归（第 1 层，虚词削除不参与该层判定）----
const GENERIC_REJECTED: ReadonlyArray<readonly [string, string]> = [
  ["椰林沙滩", "椰林沙滩有椰子树出片且不排队"],
  ["普通沙滩", "普通沙滩踩踩水"],
  ["小吃街", "晚上逛小吃街"],
  ["路过椰林", "路过椰林拍了两张"],
  ["海边公路", "骑车经过海边公路"],
  ["随手拍处", "有个随手拍处"],
  ["入口旁", "入口旁有块石头"],
  ["码头左侧", "码头左侧下去就是"],
  ["网红沙滩", "网红沙滩人很多"],
  ["日落", "在屋顶看日落"],
];
for (const [name, quote] of GENERIC_REJECTED) {
  assertReject(name, quote, "第 1 层泛化拒绝口径不变");
}
pass("泛化拒绝不回归：椰林沙滩 / 普通沙滩 / 小吃街 / 海边公路 / 入口旁 等 10 条");

// ---- 5. 编造拒绝不回归（quote 中字面零痕迹）----
assertReject("粉红沙滩", "沙滩很美", "第 1 层：泛化词 + 无专名主体");
assertReject("神秘灯塔", "风很大", "第 2 层：锚点在原文无字样");
assertReject("海上秋千", "拍了好多照片", "stem 仅 1 字，信息量不足按不可定位");
assertReject("彩虹玻璃球", QUOTE_XIDAO_LETTERS, "三档全不命中（bigram 0）");
assertReject("彩色西岛字母", "海边有一排字母装置", "去虚词后仅 1/5 bigram 命中，仍不可定位");
assertReject("粉色贝壳沙滩", "沙滩上有很多贝壳", "编造修饰 + 语序打散不构成定位");
// 冗长定名形态（真实落盘 48275e19 曾被过滤的名字）：专名主体前挂了整段方位描述，
// 三档均不可定位（bigram 6/11=0.55）→ 行为与修复前一致（仍 reject）。属「模型命名
// 冗长」问题，不在 #321（虚词误杀）范围，此处仅作行为锚点，防止后续误判为回归。
assertReject("码头出岛内口后左转的彩色西岛字母", QUOTE_XIDAO_LETTERS, "冗长定名：非虚词误杀，行为不变");
pass("编造拒绝不回归：字面零痕迹 / 语序打散 / 修饰编造 / 冗长定名 7 条仍 reject");

// ---- 6. 虚词占满的片段不放行（防「削除后空串恒包含」漏洞）----
assertReject("之上灯塔", "岛上有一座灯塔 p3", "stem 为空串，不得按恒包含放行");
assertReject("之中灯塔", "灯塔在岛尾", "stem 为空串（quote 有锚点也不放行专名主体）");
pass("虚词占满片段：stem 长度 < 2 → reject（不放宽成无痕迹放行）");

// ---- 7. 既有通过形态不回归 ----
const KEPT: ReadonlyArray<readonly [string, string]> = [
  ["西岛墙", "➡️沿海边路线走右手边能看到西岛墙（p6）"],
  ["珊瑚墙", "➡️穿过小吃街左手边就是珊瑚墙 这里很好看（p11 p12 p13）"],
  ["木门歪椰树", "进门是木门，旁边歪椰树 p2 p8 p9"],
  ["木门与歪脖子椰子树", "➡️往前走左边就能看到木门和歪脖子椰子树（p2 p8 p9）人很多要排队！"],
  ["灯塔", "岛尾有座灯塔 p3"],
  ["第一市场", "晚上去第一市场吃海鲜"],
  ["六角亭", "山顶有个六角亭"],
  ["白墙", "巷子里全是白墙"],
  ["孤独的树", "➡️再往前走就会看到孤独的树（p14 15）"],
  ["珊瑚墙前椰林沙滩", QUOTE_CORAL_BEACH],
  ["临海公路", QUOTE_SEA_ROAD],
];
for (const [name, quote] of KEPT) {
  assertKeep(name, quote, "既有通过形态");
}
pass("既有通过形态不回归：西岛墙 / 木门歪椰树 / 珊瑚墙前椰林沙滩 / 临海公路 等 11 条");

// ---- 8. quote 为空：缺原文佐证一律不建点位（同修复前口径）----
assertReject("彩色西岛字母", "", "quote 为空 → 不可定位");
assertReject("西岛墙", "", "quote 为空 → 锚点亦不可定位");
assert.equal(shouldRejectCustomCheckpoint({ name: "椰林沙滩", quote: "" }), true, "泛化名 quote 为空仍拒（仅第 1 层生效）");
assert.equal(shouldRejectCustomCheckpoint({ name: "", quote: QUOTE_XIDAO_LETTERS }), false, "空名不属本过滤职责");
pass("quote 为空 / 空名：判定确定且不抛错（缺佐证的专名仍 reject）");

console.log("\nTask #321 打卡点过滤虚词误杀修复验证全部通过");
