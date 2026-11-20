/**
 * F6 酒店候选范围验证（Task #45）：三亚全部 6 个片区真实酒店搜索。
 *
 * 通过标准（安全优先：宁可空结果，不可错误结果）：
 *   1. 每个片区返回的每一条酒店都必须通过 filterByDestinationCity 幂等复核（可确认属于三亚）；
 *   2. 每条都通过 filterByAreaCenter 幂等复核（片区半径/本地标记归属）；
 *   3. 名称或地址不得命中境外标记——Task #45 故障样本（爱沙尼亚塔林 Old Town 的
 *      「CRU 酒店」「梅查特斯家庭酒店」「美利通老城花园酒店」）必须被过滤，重点验证老城；
 *   4. 单个片区 0 条可接受，出现错误结果即失败；
 *   5. 每条结果的 detailUrl 需可打开（HTTP < 400），落地页含对应 shId 视为强通过。
 *
 * 运行：npx tsx server/src/flyai/verify-hotels.ts（真实调用 FlyAI CLI，约 1-2 分钟）。
 */
import { SANYA_AREAS, type HotelCandidate } from "@goplay/shared";
import { searchHotels } from "./client.js";
import { filterByAreaCenter, filterByDestinationCity, haversineKm } from "./scope.js";

const DESTINATION = "三亚";
const CHECK_IN = "2026-11-10";
const CHECK_OUT = "2026-11-11";

/** 明确不得出现的关键词（名称或地址命中即判定失败）：Task #45 故障样本 + 同类境外标记 */
const FORBIDDEN_MARKERS = [
  "马尔代夫",
  "马累",
  "Maldives",
  "Gangehi",
  "塔林",
  "Tallinn",
  "爱沙尼亚",
  "Estonia",
  "拉脱维亚",
  "Latvia",
  "立陶宛",
  "Lithuania",
  "葡萄牙",
  "Portugal",
  "里斯本",
  "Lisboa",
  "CRU 酒店",
  "梅查特斯",
  "美利通",
];

/** 逐条 GET 校验 detailUrl（HEAD 会被飞猪路由层拒绝为 500，必须 GET） */
async function checkDetailUrl(hotel: HotelCandidate): Promise<string> {
  if (!hotel.detailUrl) return "无 detailUrl（前端隐藏跳转按钮，可接受）";
  try {
    const res = await fetch(hotel.detailUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status >= 400) return `FAIL HTTP ${res.status}`;
    const landedShid = res.url.match(/shid=(\d+)/)?.[1] ?? null;
    if (landedShid === hotel.shId) {
      return `PASS HTTP ${res.status}，落地页 shid=${landedShid} 与 shId 一致`;
    }
    return `WARN HTTP ${res.status}，落地页未含 shid=${hotel.shId}（${res.url.slice(0, 72)}…）`;
  } catch (error) {
    return `FAIL 请求失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

async function main(): Promise<void> {
  const violations: string[] = [];
  console.log(
    `开始验证：三亚全部 ${SANYA_AREAS.length} 个片区的酒店候选（${CHECK_IN} → ${CHECK_OUT}）`,
  );

  for (const area of SANYA_AREAS) {
    console.log(`\n===== 片区「${area.name}」关键词「${area.hotelKeyword}」半径 ${area.hotelRadiusKm}km =====`);
    const result = await searchHotels({ destination: DESTINATION, area }, CHECK_IN, CHECK_OUT);
    console.log(
      `toolName=${result.toolName} latencyMs=${result.latencyMs} filter=${JSON.stringify(result.filter ?? null)}`,
    );

    if (result.normalized.length === 0) {
      console.log("  （0 条：按契约可接受——宁可空结果，不可错误结果）");
      continue;
    }

    for (const hotel of result.normalized) {
      const distance = hotel.coords
        ? `距中心 ${haversineKm(hotel.coords, area.center).toFixed(1)}km`
        : "无坐标（本地标记确认）";
      console.log(`  - ${hotel.name} | ${hotel.address ?? "无地址"} | ${distance}`);
    }

    // 1. 城市过滤幂等复核：保留结果再过一遍必须零丢弃
    const cityRecheck = filterByDestinationCity(result.normalized, DESTINATION);
    if (cityRecheck.rejected.length > 0) {
      violations.push(
        `「${area.name}」城市过滤不自洽：${cityRecheck.rejected
          .map((item) => `${item.name}（${item.reason}）`)
          .join("、")}`,
      );
    }

    // 2. 片区过滤幂等复核：半径/标记必须仍然全部通过
    const areaRecheck = filterByAreaCenter(result.normalized, area);
    if (areaRecheck.rejected.length > 0) {
      violations.push(
        `「${area.name}」片区过滤不自洽：${areaRecheck.rejected
          .map((item) => `${item.name}（${item.reason}）`)
          .join("、")}`,
      );
    }

    // 3. 境外标记硬断言（重点：老城不得再出现塔林 Old Town 样本）
    for (const hotel of result.normalized) {
      const text = `${hotel.name}${hotel.address ?? ""}`;
      const hit = FORBIDDEN_MARKERS.find((marker) => text.includes(marker));
      if (hit) violations.push(`「${area.name}」出现境外结果「${hotel.name}」：命中「${hit}」`);
    }

    // 4. detailUrl 可打开性 + 落地页 shId 对应
    for (const hotel of result.normalized) {
      const detail = await checkDetailUrl(hotel);
      console.log(`    detailUrl[${hotel.shId}]：${detail}`);
      if (detail.startsWith("FAIL")) {
        violations.push(`「${area.name}」${hotel.name} detailUrl 不可用：${detail}`);
      }
    }
  }

  if (violations.length > 0) {
    console.error("\n验证失败：");
    for (const violation of violations) console.error(`  - ${violation}`);
    process.exitCode = 1;
    return;
  }
  console.log("\n验证通过：全部片区保留结果均可确认属于三亚且属于对应片区；老城无国外酒店。");
}

main().catch((error: unknown) => {
  console.error("酒店候选范围验证失败：", error);
  process.exitCode = 1;
});
