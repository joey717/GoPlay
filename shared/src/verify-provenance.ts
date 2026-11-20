/**
 * Task #283 / C4：AI 补充来源（provenance）验证脚本 —— 读时默认（迁移幂等）＋ 护栏拒绝。
 *
 * 运行：npx tsx src/verify-provenance.ts（shared 目录下）
 *
 * 覆盖场景：
 *  1. 读时默认：provenance 缺失 / null / 非法值一律回落 "guide"（存量零迁移，读时默认）；
 *  2. 迁移幂等：itemProvenance 对同一 Item 多次取值稳定；显式 ai_supplement 不被降级；
 *  3. isRealFliggyPoi：origin=fliggy 且 providerId 非空才为真；custom / providerId 空为假；
 *  4. 护栏拒绝：标 ai_supplement 但无真实飞猪 POI（custom / providerId=null / 空串）→ 违规；
 *  5. 护栏放行：标 ai_supplement 且引用真实飞猪 POI → 无违规；guide 项不参与判定；
 *  6. 展示常量：全标 "AI 补充·飞猪核验" 以降级标 "AI 补充" 为前缀（chip 降级切分一致）。
 */

import assert from "node:assert/strict";
import type { Item, Trip } from "./types/index.js";
import { isRealFliggyPoi, validateAiSupplementProvenance } from "./guards/index.js";
import {
  AI_SUPPLEMENT_CHIP_LABEL,
  AI_SUPPLEMENT_CHIP_LABEL_COMPACT,
  isAiSupplement,
  itemProvenance,
} from "./provenance.js";

function makeItem(partial: Partial<Item> & { itemId: string }): Item {
  return {
    name: partial.itemId,
    origin: "custom",
    providerId: null,
    address: null,
    category: null,
    coords: null,
    suggestMinutes: null,
    mainPic: null,
    ticketInfo: null,
    jumpUrl: null,
    sourceEvidenceRefs: [],
    ...partial,
  } as Item;
}

function makeTrip(items: Item[]): Trip {
  const itemRegistry: Record<string, Item> = {};
  for (const item of items) itemRegistry[item.itemId] = item;
  return { itemRegistry } as unknown as Trip;
}

// ===== §1 读时默认：缺失 / null / 非法值 → guide =====
{
  assert.equal(itemProvenance(makeItem({ itemId: "a" })), "guide", "§1: 缺失 provenance → guide");
  assert.equal(itemProvenance(null), "guide", "§1: null item → guide");
  assert.equal(itemProvenance(undefined), "guide", "§1: undefined item → guide");
  assert.equal(
    itemProvenance(makeItem({ itemId: "b", provenance: "guide" })),
    "guide",
    "§1: 显式 guide → guide",
  );
  assert.equal(
    itemProvenance(makeItem({ itemId: "c", provenance: "ai_supplement" })),
    "ai_supplement",
    "§1: 显式 ai_supplement → ai_supplement",
  );
  // 非法值回落 guide（读侧不信任脏数据）
  assert.equal(
    itemProvenance(makeItem({ itemId: "d", provenance: "bogus" as never })),
    "guide",
    "§1: 非法值 → guide",
  );
  assert.equal(isAiSupplement(makeItem({ itemId: "e" })), false, "§1: 缺失 → 非补充项");
  assert.equal(
    isAiSupplement(makeItem({ itemId: "f", provenance: "ai_supplement" })),
    true,
    "§1: ai_supplement → 补充项",
  );
  console.log("§1 读时默认（缺失/非法→guide，ai_supplement 保留）pass");
}

// ===== §2 迁移幂等：多次取值稳定 =====
{
  const guide = makeItem({ itemId: "g" });
  const supplement = makeItem({ itemId: "s", origin: "fliggy", providerId: "F123", provenance: "ai_supplement" });
  // 连续取值不改变结果（读时默认是纯读取，不写回，天然幂等）
  assert.equal(itemProvenance(guide), itemProvenance(guide), "§2: guide 幂等");
  assert.equal(itemProvenance(supplement), itemProvenance(supplement), "§2: ai_supplement 幂等");
  assert.equal(itemProvenance(supplement), "ai_supplement", "§2: ai_supplement 不被降级");
  // 存量 guide 项读取后字段仍缺失（零改写存量，符合迁移铁律「不丢数据、幂等」）
  assert.equal(guide.provenance, undefined, "§2: 读时默认不改写存量字段");
  console.log("§2 迁移幂等（读时默认稳定、零改写存量）pass");
}

// ===== §3 isRealFliggyPoi =====
{
  assert.equal(
    isRealFliggyPoi(makeItem({ itemId: "p1", origin: "fliggy", providerId: "F1" })),
    true,
    "§3: fliggy + providerId → 真实 POI",
  );
  assert.equal(isRealFliggyPoi(makeItem({ itemId: "p2", origin: "custom", providerId: null })), false, "§3: custom → 非真实 POI");
  assert.equal(
    isRealFliggyPoi(makeItem({ itemId: "p3", origin: "fliggy", providerId: null })),
    false,
    "§3: fliggy 但 providerId=null → 非真实 POI",
  );
  assert.equal(
    isRealFliggyPoi(makeItem({ itemId: "p4", origin: "fliggy", providerId: "   " })),
    false,
    "§3: providerId 空白串 → 非真实 POI",
  );
  console.log("§3 isRealFliggyPoi（fliggy+非空 providerId 才真）pass");
}

// ===== §4 护栏拒绝：ai_supplement 无真实飞猪 POI =====
{
  const trip = makeTrip([
    makeItem({ itemId: "bad_custom", origin: "custom", providerId: null, provenance: "ai_supplement" }),
    makeItem({ itemId: "bad_nullid", origin: "fliggy", providerId: null, provenance: "ai_supplement" }),
    makeItem({ itemId: "bad_emptyid", origin: "fliggy", providerId: "", provenance: "ai_supplement" }),
  ]);
  const violations = validateAiSupplementProvenance(trip);
  assert.deepEqual(
    violations.sort(),
    ["bad_custom", "bad_emptyid", "bad_nullid"],
    "§4: 三项无真实飞猪 POI 的 ai_supplement 全部判违规",
  );
  console.log("§4 护栏拒绝（无 fliggy id 的 ai_supplement）pass");
}

// ===== §5 护栏放行：ai_supplement 引用真实 POI；guide 不参与 =====
{
  const trip = makeTrip([
    makeItem({ itemId: "ok_sup", origin: "fliggy", providerId: "F999", provenance: "ai_supplement" }),
    makeItem({ itemId: "guide_custom", origin: "custom", providerId: null, provenance: "guide" }),
    makeItem({ itemId: "guide_missing", origin: "custom", providerId: null }),
  ]);
  const violations = validateAiSupplementProvenance(trip);
  assert.deepEqual(violations, [], "§5: 真实 POI 的 ai_supplement + guide 项 → 无违规");
  console.log("§5 护栏放行（真实 POI 补充项 + guide 项）pass");
}

// ===== §6 展示常量：降级标是全标前缀 =====
{
  assert.equal(AI_SUPPLEMENT_CHIP_LABEL, "AI 补充·飞猪核验", "§6: 全标文案");
  assert.equal(AI_SUPPLEMENT_CHIP_LABEL_COMPACT, "AI 补充", "§6: 降级标文案");
  assert.ok(
    AI_SUPPLEMENT_CHIP_LABEL.startsWith(AI_SUPPLEMENT_CHIP_LABEL_COMPACT),
    "§6: 降级标是全标前缀（chip 切分一致）",
  );
  assert.equal(
    AI_SUPPLEMENT_CHIP_LABEL.slice(AI_SUPPLEMENT_CHIP_LABEL_COMPACT.length),
    "·飞猪核验",
    "§6: chip-verify 子段 = ·飞猪核验",
  );
  console.log("§6 展示常量（全标/降级标/核验段）pass");
}

console.log("\n✅ verify-provenance 全部 6 组断言通过");
