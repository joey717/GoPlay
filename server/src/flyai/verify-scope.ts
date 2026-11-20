/**
 * 候选池目的地范围验证（Task #32）：searchPoi("西岛", { destination: "三亚" })。
 *
 * 通过标准：
 *   1. 结果中不得出现马尔代夫等非三亚条目（故障样本「马尔代夫甘格西度假岛」必须被过滤）；
 *   2. 若 FlyAI 返回真实三亚西岛则保留；空数组亦可接受；
 *   3. 幂等复核：过滤后结果再次过 filterByDestinationCity 必须零丢弃。
 *
 * 运行：npm run build 后 node server/dist/flyai/verify-scope.js
 *（或开发期 npx tsx server/src/flyai/verify-scope.ts）。
 */
import { searchPoi } from "./client.js";
import { filterByDestinationCity } from "./scope.js";

/** 明确不得出现的关键词（名称或地址命中即判定失败） */
const FORBIDDEN_MARKERS = ["马尔代夫", "马累", "Gangehi", "Maldives"];

async function main(): Promise<void> {
  console.log('开始验证：searchPoi("西岛", { destination: "三亚" })');
  const result = await searchPoi("西岛", { destination: "三亚" });

  console.log(
    `toolName=${result.toolName} params=${JSON.stringify(result.params)} latencyMs=${result.latencyMs}`,
  );
  console.log(`过滤后保留 ${result.normalized.length} 条：`);
  for (const poi of result.normalized) {
    const coords = poi.coords ? `${poi.coords.lng},${poi.coords.lat}` : "无坐标";
    console.log(`  - ${poi.name} | ${poi.address ?? "无地址"} | ${coords}`);
  }

  const violations = result.normalized.filter((poi) => {
    const text = `${poi.name}${poi.address ?? ""}`;
    return FORBIDDEN_MARKERS.some((marker) => text.includes(marker));
  });
  if (violations.length > 0) {
    throw new Error(`发现非三亚结果，目的地过滤失效：${violations.map((poi) => poi.name).join("、")}`);
  }

  // 幂等复核：保留结果再次过滤应零丢弃（过滤器与调用方契约自洽）
  const recheck = filterByDestinationCity(result.normalized, "三亚");
  if (recheck.rejected.length > 0) {
    throw new Error(
      `过滤结果不自洽：${recheck.rejected.map((item) => `${item.name}（${item.reason}）`).join("、")}`,
    );
  }

  console.log(
    result.normalized.length > 0
      ? "验证通过：无马尔代夫等非三亚结果，保留结果均可确认属于三亚"
      : "验证通过：无马尔代夫等非三亚结果（本次未返回可确认的三亚结果，空数组亦可接受）",
  );
}

main().catch((error: unknown) => {
  console.error("「西岛」目的地范围验证失败：", error);
  process.exitCode = 1;
});
