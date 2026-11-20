/**
 * Task #190 实用参考选项组纯函数验证（shared 层，全程离线）。
 *
 * 运行：npx tsx src/verify-optionGroups.ts；已接入 `npm run verify -w shared`。
 *
 * 覆盖：
 *  A. 文本清洗 normalizeOptionalText：非字符串 / 空串 → null、trim、按 Unicode 码点截断；
 *  B. 分类 / 可议价清洗：白名单外兜底 other（不臆造新分类）；字符串 "true" 不臆测为 boolean；
 *  C. 选项清洗 normalizeGuideOptionItem：label 必填（无 label → null）、label 截断、
 *     引用去重 / 非法形状过滤 / 截断到上限、可空字段缺失 → null（不臆测）；
 *  D. 价格解析与最低参考价：optionPriceNumber 取首个数字、「面议」不猜；
 *     guideOptionGroupMinPrice 全部缺失 → null（摘要只显示选项数）；
 *  E. 组键 guideOptionGroupKey：主题归一化（去成对括号 + 空白 + 小写）+ 分类；
 *     同主题不同分类是不同组；主题带括号变体（「西岛交通（环岛）」）与归一化后同键；
 *  F. 去重合并 mergeOptionGroupsIntoList：新组建组 / 同键组选项按 label 归一化去重追加
 *     / 组级引用并入去重 / 单选 incoming 跳过（不成组）/ 每实体组数上限先到先得
 *     / 不修改入参（历史 Trip 既有数组不被原地改写）。
 */

import assert from "node:assert/strict";
import type { GuideOptionGroup, GuideOptionItem } from "./types/index.js";
import {
  GUIDE_OPTION_GROUP_MAX_OPTIONS,
  GUIDE_OPTION_GROUP_MAX_PER_ENTITY,
  GUIDE_OPTION_LABEL_MAX_CHARS,
  GUIDE_OPTION_MAX_MENTION_REFS,
  GUIDE_OPTION_TEXT_MAX_CHARS,
  GUIDE_OPTION_TOPIC_MAX_CHARS,
  guideOptionGroupKey,
  guideOptionGroupMinPrice,
  mergeOptionGroupsIntoList,
  normalizeGuideOptionItem,
  normalizeOptionBargain,
  normalizeOptionCategory,
  normalizeOptionLabelKey,
  normalizeOptionalText,
  optionPriceNumber,
} from "./guides/index.js";

function pass(name: string): void {
  console.log(`✓ ${name}`);
}

function makeItem(label: string, priceText: string | null, refs: string[]): GuideOptionItem {
  return {
    label,
    priceText,
    routeText: null,
    sceneText: null,
    bargain: null,
    noteText: null,
    sourceMentionRefs: refs,
  };
}

function makeGroup(
  groupId: string,
  topic: string,
  options: GuideOptionItem[],
  groupRefs: string[],
): GuideOptionGroup {
  return {
    groupId,
    topic,
    category: "transport",
    options,
    sourceMentionRefs: groupRefs,
    collectedAt: "2026-10-20T08:00:00.000Z",
  };
}

// ===== A. 文本清洗 =====

{
  assert.equal(normalizeOptionalText("  西岛环岛交通  ", 24), "西岛环岛交通", "A1: trim");
  assert.equal(normalizeOptionalText(null, 24), null, "A2: null → null");
  assert.equal(normalizeOptionalText(undefined, 24), null, "A3: undefined → null");
  assert.equal(normalizeOptionalText(42, 24), null, "A4: 非字符串 → null");
  assert.equal(normalizeOptionalText("   ", 24), null, "A5: 空白串 → null");
  assert.equal(normalizeOptionalText("", 24), null, "A6: 空串 → null");
  const longText = "口".repeat(GUIDE_OPTION_TEXT_MAX_CHARS + 5);
  assert.equal(
    [...(normalizeOptionalText(longText, GUIDE_OPTION_TEXT_MAX_CHARS) ?? "")].length,
    GUIDE_OPTION_TEXT_MAX_CHARS,
    "A7: 按 Unicode 码点截断到上限",
  );
  const topicLong = "西".repeat(GUIDE_OPTION_TOPIC_MAX_CHARS + 10);
  assert.equal(
    [...(normalizeOptionalText(topicLong, GUIDE_OPTION_TOPIC_MAX_CHARS) ?? "")].length,
    GUIDE_OPTION_TOPIC_MAX_CHARS,
    "A8: 主题截断上限",
  );
  pass("A. normalizeOptionalText 清洗（null / trim / 码点截断）");
}

// ===== B. 分类与可议价清洗（不臆测） =====

{
  assert.equal(normalizeOptionCategory("transport"), "transport", "B1: 白名单内原样");
  assert.equal(normalizeOptionCategory("dining"), "dining", "B2: 餐饮分类");
  assert.equal(normalizeOptionCategory("shuttle"), "shuttle", "B3: 接驳分类");
  assert.equal(normalizeOptionCategory("vehicle"), "other", "B4: 白名单外兜底 other");
  assert.equal(normalizeOptionCategory(123), "other", "B5: 非字符串兜底 other");
  assert.equal(normalizeOptionCategory(null), "other", "B6: null 兜底 other");

  assert.equal(normalizeOptionBargain("true"), null, "B7: 字符串 \"true\" 不臆测为 boolean");
  assert.equal(normalizeOptionBargain(1), null, "B8: 数字不臆测");
  assert.equal(normalizeOptionBargain(true), true, "B9: boolean true 原样");
  assert.equal(normalizeOptionBargain(false), false, "B10: boolean false 原样");
  assert.equal(normalizeOptionBargain(null), null, "B11: null = 原文未提");
  pass("B. 分类兜底 other / bargain 三态（字符串 \"true\" 不臆测）");
}

// ===== C. 选项清洗 =====

{
  // C1: 无 label → null（单点推荐无选项名不成组）
  assert.equal(
    normalizeGuideOptionItem({
      label: "  ",
      priceText: "50元",
      routeText: null,
      sceneText: null,
      bargain: null,
      noteText: null,
      sourceMentionRefs: [],
    }),
    null,
    "C1: label 空白 → null",
  );
  // C2: 完整清洗：截断 + 引用去重 + 非法形状过滤 + 截断上限
  const manyRefs = [
    "ev_a:m1",
    "ev_a:m1",
    "bad-ref-no-colon",
    "ev_a:",
    ":m1",
    "ev_b:m2",
    "ev_c:m3",
    "ev_d:m4",
  ];
  const cleaned = normalizeGuideOptionItem({
    label: "三轮车（可坐四人）",
    priceText: " 50元/圈 ",
    routeText: "环岛一周",
    sceneText: "带老人小孩省力",
    bargain: true,
    noteText: "可随时停车",
    sourceMentionRefs: manyRefs,
  });
  assert.ok(cleaned !== null, "C2: 合法选项应清洗成功");
  assert.equal(cleaned.label, "三轮车（可坐四人）", "C2: 未超上限 label 原样保留（含括号，归一化在比对侧）");
  const overLong = normalizeGuideOptionItem({
    label: "超长选项名称".repeat(5),
    priceText: null,
    routeText: null,
    sceneText: null,
    bargain: null,
    noteText: null,
    sourceMentionRefs: [],
  });
  assert.ok(overLong !== null && [...overLong.label].length === GUIDE_OPTION_LABEL_MAX_CHARS, "C2b: 超长 label 截断到 20");
  assert.equal(cleaned.priceText, "50元/圈", "C2: priceText trim");
  assert.deepEqual(
    cleaned.sourceMentionRefs,
    ["ev_a:m1", "ev_b:m2", "ev_c:m3"],
    "C2: 引用去重 + 非法形状（无冒号/空段）过滤 + 截断到 3",
  );
  assert.equal(cleaned.sourceMentionRefs.length, GUIDE_OPTION_MAX_MENTION_REFS, "C2: 上限常量口径");
  // C3: 非数组引用 → 空数组（后续 parseDraftOptionGroups 用组级兜底）
  const noRefs = normalizeGuideOptionItem({
    label: "电动车",
    priceText: null,
    routeText: null,
    sceneText: null,
    bargain: null,
    noteText: null,
    sourceMentionRefs: "ev_a:m1",
  });
  assert.ok(noRefs !== null && noRefs.sourceMentionRefs.length === 0, "C3: 非数组引用 → 空数组");
  // C4: 字段全部缺失 → null（不臆测默认值）
  const bare = normalizeGuideOptionItem({
    label: "观光车",
    priceText: 123,
    routeText: {},
    sceneText: [],
    bargain: "true",
    noteText: null,
    sourceMentionRefs: null,
  });
  assert.ok(bare !== null, "C4: 基础清洗不应因字段类型错误失败");
  assert.equal(bare.priceText, null, "C4: 非字符串价格 → null");
  assert.equal(bare.routeText, null, "C4: 非字符串路线 → null");
  assert.equal(bare.sceneText, null, "C4: 非字符串场景 → null");
  assert.equal(bare.bargain, null, "C4: 字符串可议价 → null");
  assert.equal(bare.noteText, null, "C4: 缺失特点 → null");
  pass("C. normalizeGuideOptionItem（label 必填 / 引用清洗 / 可空字段不臆测）");
}

// ===== D. 价格解析与最低参考价 =====

{
  assert.equal(optionPriceNumber("50元/圈"), 50, "D1: 中文单位取数字");
  assert.equal(optionPriceNumber("¥120/人"), 120, "D2: ¥ 前缀取数字");
  assert.equal(optionPriceNumber("30.5元/小时"), 30.5, "D3: 小数价格");
  assert.equal(optionPriceNumber("价格面议"), null, "D4: 无数字不猜");
  assert.equal(optionPriceNumber(""), null, "D5: 空串 → null");

  const group = makeGroup(
    "gog_1",
    "西岛环岛交通",
    [
      makeItem("三轮车", "50元/圈", ["ev_xd:m_xd"]),
      makeItem("电动车", "30元/小时", ["ev_xd:m_xd"]),
      makeItem("观光车", "20元/圈", ["ev_xd:m_xd"]),
    ],
    ["ev_xd:m_xd"],
  );
  assert.equal(guideOptionGroupMinPrice(group), 20, "D6: 最低参考价取最小值（golden 摘要口径）");

  const noPrice = makeGroup(
    "gog_2",
    "日落观赏点",
    [makeItem("山顶平台", null, ["ev_xd:m_xd"]), makeItem("码头栈道", "面议", ["ev_xd:m_xd"])],
    ["ev_xd:m_xd"],
  );
  assert.equal(guideOptionGroupMinPrice(noPrice), null, "D7: 全部不可解析 → null（摘要只显示选项数）");
  pass("D. optionPriceNumber / guideOptionGroupMinPrice（面议不猜 / 最低价摘要）");
}

// ===== E. 组键归一化 =====

{
  assert.equal(
    guideOptionGroupKey("西岛环岛交通", "transport"),
    "西岛环岛交通::transport",
    "E1: 常规键",
  );
  assert.equal(
    guideOptionGroupKey("西岛环岛交通 ", "transport"),
    guideOptionGroupKey("西岛环岛交通", "transport"),
    "E2: 空白归一化",
  );
  assert.equal(
    guideOptionGroupKey("西岛交通（环岛）", "transport"),
    guideOptionGroupKey("西岛交通", "transport"),
    "E3: 成对括号内容不参与键（与 normalizePoiName 同口径）",
  );
  assert.notEqual(
    guideOptionGroupKey("西岛交通", "transport"),
    guideOptionGroupKey("西岛交通", "ticket"),
    "E4: 同主题不同分类是不同组",
  );
  assert.equal(
    guideOptionGroupKey("西岛交通", "transport").toLowerCase(),
    guideOptionGroupKey("西岛交通", "transport"),
    "E5: 键已小写（英文主题去重不区分大小写）",
  );
  assert.equal(normalizeOptionLabelKey("电动车（双人）"), "电动车", "E6: label 归一化去括号");
  pass("E. guideOptionGroupKey（主题归一化 + 分类维度）");
}

// ===== F. 去重合并 =====

{
  const collectedAt = "2026-10-20T09:00:00.000Z";

  // F1: 新组建组（历史 Visit.optionGroups 缺失 → 从空开始）
  const draftTransport = {
    topic: "西岛环岛交通",
    category: "transport" as const,
    options: [
      makeItem("三轮车", "50元/圈", ["ev_xd:m_xd"]),
      makeItem("电动车", "30元/小时", ["ev_xd:m_xd"]),
      makeItem("观光车", "20元/圈", ["ev_xd:m_xd"]),
    ],
    sourceMentionRefs: ["ev_xd:m_xd"],
  };
  const first = mergeOptionGroupsIntoList(undefined, [draftTransport], collectedAt);
  assert.equal(first.addedGroups, 1, "F1: 新组建组");
  assert.equal(first.addedOptions, 3, "F1: 选项计数");
  assert.equal(first.groups.length, 1, "F1: 单组");
  assert.equal(first.groups[0].collectedAt, collectedAt, "F1: 采集时间取应用落盘时间");
  assert.ok(first.groups[0].groupId.startsWith("gog_"), "F1: groupId 前缀");
  assert.ok(first.groups[0].groupId !== mergeOptionGroupsIntoList(null, [draftTransport], collectedAt).groups[0].groupId, "F1: groupId 每次新建唯一");

  // F2: 同键组合并：label 归一化去重（「双人自行车」新增、「电动车（双人）」视为已有）+ 组级引用并入
  const existing = first.groups;
  const existingSnapshot = JSON.stringify(existing);
  const second = mergeOptionGroupsIntoList(
    existing,
    [
      {
        topic: "西岛环岛交通",
        category: "transport" as const,
        options: [
          makeItem("双人自行车", "60元/小时", ["ev_xd:m_other"]),
          makeItem("电动车（双人）", "35元/小时", ["ev_xd:m_xd"]),
        ],
        sourceMentionRefs: ["ev_xd:m_other"],
      },
    ],
    collectedAt,
  );
  assert.equal(second.addedGroups, 0, "F2: 同键不新增组");
  assert.equal(second.addedOptions, 1, "F2: 仅 label 归一化未命中的选项计入新增");
  assert.equal(second.groups.length, 1, "F2: 组数不变");
  assert.deepEqual(
    second.groups[0].options.map((option) => option.label),
    ["三轮车", "电动车", "观光车", "双人自行车"],
    "F2: 选项合并顺序（已有在前，新选项追加；括号变体去重命中）",
  );
  assert.deepEqual(
    second.groups[0].sourceMentionRefs,
    ["ev_xd:m_xd", "ev_xd:m_other"],
    "F2: 组级引用并入去重",
  );
  assert.equal(second.groups[0].collectedAt, collectedAt, "F2: 组 collectedAt 保留首见值（不因合并覆盖）");
  assert.equal(JSON.stringify(existing), existingSnapshot, "F2: 入参 existing 不被原地修改（历史数据安全）");

  // F3: 单选 incoming 跳过（不成组）
  const singleSkip = mergeOptionGroupsIntoList(
    null,
    [
      {
        topic: "日落观赏点",
        category: "activity" as const,
        options: [makeItem("山顶平台", "免费", ["ev_xd:m_xd"])],
        sourceMentionRefs: ["ev_xd:m_xd"],
      },
    ],
    collectedAt,
  );
  assert.equal(singleSkip.addedGroups, 0, "F3: 单选不成组");
  assert.equal(singleSkip.groups.length, 0, "F3: 无组产出");

  // F4: 每实体组数上限先到先得（4 组满后第 5 组跳过）
  const fourGroups = [
    makeGroup("gog_a", "环岛交通A", [makeItem("a1", null, []), makeItem("a2", null, [])], []),
    makeGroup("gog_b", "环岛交通B", [makeItem("b1", null, []), makeItem("b2", null, [])], []),
    makeGroup("gog_c", "门票套餐C", [makeItem("c1", null, []), makeItem("c2", null, [])], []),
    makeGroup("gog_d", "租赁D", [makeItem("d1", null, []), makeItem("d2", null, [])], []),
  ];
  const capped = mergeOptionGroupsIntoList(
    fourGroups,
    [
      {
        topic: "餐饮套餐E",
        category: "dining" as const,
        options: [makeItem("e1", null, []), makeItem("e2", null, [])],
        sourceMentionRefs: [],
      },
    ],
    collectedAt,
  );
  assert.equal(capped.groups.length, GUIDE_OPTION_GROUP_MAX_PER_ENTITY, "F4: 上限为 4 组");
  assert.equal(capped.addedGroups, 0, "F4: 超限新组被跳过");
  assert.deepEqual(
    capped.groups.map((group) => group.groupId),
    ["gog_a", "gog_b", "gog_c", "gog_d"],
    "F4: 先到先得（已有组保留，新组丢弃）",
  );

  // F5: 非法入参防御（options 非数组）
  const weird = mergeOptionGroupsIntoList(
    null,
    [
      {
        topic: "异常组",
        category: "other" as const,
        options: undefined as unknown as GuideOptionItem[],
        sourceMentionRefs: [],
      },
    ],
    collectedAt,
  );
  assert.equal(weird.addedGroups, 0, "F5: options 非数组不产出组");
  pass("F. mergeOptionGroupsIntoList（建组 / 选项归一化合并 / 引用并入 / 上限 / 入参不可变）");
}

// ===== 常量口径 =====

{
  assert.ok(GUIDE_OPTION_GROUP_MAX_OPTIONS >= 2 && GUIDE_OPTION_GROUP_MAX_OPTIONS <= 10, "G1: 组内选项上限合理区间");
  assert.ok(GUIDE_OPTION_GROUP_MAX_PER_ENTITY >= 1, "G2: 每实体组上限");
  assert.ok(GUIDE_OPTION_MAX_MENTION_REFS === 3, "G3: 引用上限与 snippet 同口径");
  pass("G. 上限常量口径");
}

console.log("\n[verify] Task #190 shared 纯函数全部通过 ✓");
