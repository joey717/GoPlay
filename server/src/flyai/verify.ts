import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  extractRawRecords,
  getFlyAiCliVersion,
  searchHotels,
  searchPoi,
  type FlyAISearchResult,
} from "./client.js";

interface NormalizationSample {
  poiSearch: { reportedFirstItemSubset: Record<string, unknown> };
  hotelSearch: { reportedFirstItem: Record<string, unknown> };
}

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const SAMPLE_PATH = path.join(PROJECT_ROOT, "handover/GoPlay_FlyAI_归一化样本_v1.0.json");
const OUTPUT_PATH = path.join(PROJECT_ROOT, "docs/flyai-samples/search-toolcall.json");

function assertJson(value: unknown, label: string): void {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error(`${label} 无法序列化为 JSON`);
  JSON.parse(serialized);
}

function fieldDrift(expected: Record<string, unknown>, actual: Record<string, unknown> | undefined): string[] {
  if (!actual) return ["missing: first result"];
  const expectedKeys = new Set(Object.keys(expected));
  const actualKeys = new Set(Object.keys(actual));
  return [
    ...[...expectedKeys].filter((key) => !actualKeys.has(key)).map((key) => `missing: ${key}`),
    ...[...actualKeys].filter((key) => !expectedKeys.has(key)).map((key) => `added: ${key}`),
  ];
}

function firstLink<T extends { jumpUrl?: string | null; detailUrl?: string | null }>(
  result: FlyAISearchResult<T>,
  key: "jumpUrl" | "detailUrl",
): string | null {
  for (const item of result.normalized) {
    const link = item[key];
    if (typeof link === "string") return link;
  }
  return null;
}

async function main(): Promise<void> {
  console.log("开始验证 FlyAI CLI 直连：search_poi");
  const poiAttempt = await searchPoi("三亚 蜈支洲岛").then(
    (value) => ({ value, error: null }),
    (error: unknown) => ({ value: null, error }),
  );

  console.log("开始验证 FlyAI CLI 直连：search_hotels");
  const hotelAttempt = await searchHotels(
    { destination: "三亚", keyword: "海棠湾" },
    "2026-11-08",
    "2026-11-09",
  ).then(
    (value) => ({ value, error: null }),
    (error: unknown) => ({ value: null, error }),
  );

  if (!poiAttempt.value || !hotelAttempt.value) {
    const failures = [poiAttempt.error, hotelAttempt.error].filter((error) => error !== null);
    throw new AggregateError(failures, "FlyAI 搜索未全部通过，无法生成完整契约样本");
  }

  const poi = poiAttempt.value;
  const hotel = hotelAttempt.value;
  assertJson(poi.raw, "search_poi 原始报文");
  assertJson(hotel.raw, "search_hotels 原始报文");

  // Task #386：handover/ 内部交接目录已移出公开仓库，归一化契约样本随之删除。
  // 样本缺失时跳过字段漂移对比；verify.ts 其余真实验证（search_poi/search_hotels + 写 search-toolcall.json）保持可跑，不 ENOENT 崩溃。
  const sample: NormalizationSample | null = existsSync(SAMPLE_PATH)
    ? (JSON.parse(await fs.readFile(SAMPLE_PATH, "utf8")) as NormalizationSample)
    : null;
  if (!sample) {
    console.warn(`归一化契约样本不存在（${SAMPLE_PATH}）：handover/ 已随 Task #386 移出公开仓库，本轮跳过字段漂移对比。`);
  }
  const poiActual = extractRawRecords(poi.raw, "poi")[0];
  const hotelActual = extractRawRecords(hotel.raw, "hotel")[0];
  const sampleJumpUrl = firstLink(poi, "jumpUrl");
  const sampleDetailUrl = firstLink(hotel, "detailUrl");
  const cliVersion = await getFlyAiCliVersion();

  const capture = {
    capturedAt: new Date().toISOString(),
    integrationPath: "cli" as const,
    cliVersion,
    searches: [
      {
        tool: "search_poi",
        input: { query: "三亚 蜈支洲岛" },
        output: poi.raw,
        latencyMs: poi.latencyMs,
        normalizedCount: poi.normalized.length,
        sampleJumpUrl,
        fieldDrift: sample
          ? fieldDrift(sample.poiSearch.reportedFirstItemSubset, poiActual)
          : ["sample unavailable: 归一化契约样本已随 Task #386 移除"],
      },
      {
        tool: "search_hotels",
        input: {
          destination: "三亚",
          keyword: "海棠湾",
          checkInDate: "2026-11-08",
          checkOutDate: "2026-11-09",
        },
        output: hotel.raw,
        latencyMs: hotel.latencyMs,
        normalizedCount: hotel.normalized.length,
        filter: hotel.filter ?? null,
        sampleDetailUrl,
        fieldDrift: sample
          ? fieldDrift(sample.hotelSearch.reportedFirstItem, hotelActual)
          : ["sample unavailable: 归一化契约样本已随 Task #386 移除"],
      },
    ],
  };

  assertJson(capture, "验证结果");
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(capture, null, 2)}\n`, "utf8");

  console.log(`FlyAI CLI v${cliVersion} 验证完成`);
  console.log(`POI jumpUrl: ${sampleJumpUrl ?? "未返回"}`);
  console.log(`酒店 detailUrl: ${sampleDetailUrl ?? "未返回"}`);
  console.log(`原始报文已写入 ${OUTPUT_PATH}`);
}

main().catch((error: unknown) => {
  console.error("FlyAI 验证失败；未写入伪造或不完整的搜索样本。", error);
  process.exitCode = 1;
});
