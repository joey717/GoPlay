/**
 * Task #107 回归验证脚本（纯函数，不依赖模型 / 网络 / 服务端进程）：
 *   1. isDisqualifiedEntry：平台水印词、纯泛化地理词、summary 自述非地点前置淘汰；
 *      后海海滩 / 西岛码头 / 第一市场 / 三亚湾 / 情人桥等具体点位不误杀；
 *   2. findBestMatch：纯泛化词与极短名不做 includes 降级（只接受 exact），
 *      正常具体名称仍保留互为包含的模糊匹配。
 *
 * 运行：npx tsx server/src/ai/verify-task107.ts
 */

import assert from "node:assert/strict";
import type { FlyAIPoi } from "../flyai/client.js";
import {
  findBestMatch,
  isDisqualifiedEntry,
  normalizeParsedEntry,
  type ParsedEntry,
} from "./assemble.js";

function entry(name: string, summary = "笔记提及"): ParsedEntry {
  const parsed = normalizeParsedEntry({ name, summary });
  assert.ok(parsed !== null, `条目「${name}」应通过结构归一化`);
  return parsed;
}

function poi(name: string): FlyAIPoi {
  return {
    id: `poi_${name}`,
    name,
    address: null,
    category: null,
    description: null,
    freePoiStatus: null,
    poiLevel: null,
    coords: null,
    mainPic: null,
    listRank: null,
    ticketInfo: null,
    jumpUrl: null,
  };
}

function pass(name: string): void {
  console.log(`✓ ${name}`);
}

// ---- 1. 前置淘汰：平台 / 泛化 / 自述非地点 ----
assert.equal(isDisqualifiedEntry(entry("小红书", "平台水印，非实际地点")), true);
assert.equal(isDisqualifiedEntry(entry("抖音")), true);
assert.equal(isDisqualifiedEntry(entry("海滩")), true);
assert.equal(isDisqualifiedEntry(entry("景点")), true);
assert.equal(isDisqualifiedEntry(entry("情人桥", "图片广告 logo，非实际地点")), true);
for (const name of ["后海海滩", "西岛码头", "第一市场", "三亚湾", "情人桥"]) {
  assert.equal(isDisqualifiedEntry(entry(name)), false, `「${name}」不应被淘汰`);
}
pass("isDisqualifiedEntry：脏词/泛化词/自述非地点被淘汰，具体点位保留");

// ---- 2. 模糊匹配收紧 ----
assert.equal(findBestMatch("海滩", [poi("后海海滩")]), undefined);
assert.equal(findBestMatch("后海", [poi("后海村")]), undefined);
assert.equal(findBestMatch("西岛码头", [poi("西岛")]), undefined);
assert.equal(findBestMatch("后海海滩", [poi("后海海滩")])?.name, "后海海滩");
assert.equal(findBestMatch("亚特兰蒂斯", [poi("三亚亚特兰蒂斯酒店")])?.name, "三亚亚特兰蒂斯酒店");
assert.equal(findBestMatch("第一市场", [poi("第一市场海鲜广场")])?.name, "第一市场海鲜广场");
pass("findBestMatch：泛化词/极短名仅 exact，具体名称保留 includes 降级");

console.log("\nTask #107 过滤纯函数验证全部通过");
