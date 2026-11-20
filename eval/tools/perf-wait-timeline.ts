/**
 * Task #277: #224 等待分级反馈时间线重建脚本
 * 使用 web/src/lib/waitStages.ts 的真实 resolveWaitStage 函数
 */
import { resolveWaitStage, PROGRESS_CAP } from "../../web/src/lib/waitStages.js";
import { DRAFT_WAIT_PLAN } from "../../web/src/lib/waitPlans.js";
import { sourceWaitMeter, SOURCE_STALL_AFTER_MS } from "../../web/src/lib/sourceWait.js";

// 草案生成实测 52.5s，按 10s 间隔重建时间线
const DRAFT_ELAPSED_MS = 52_500;
const POLL_INTERVAL_MS = 10_000;

console.log("=== #224 草案生成等待阶段时间线（实测 52.5s） ===");
console.log(`PROGRESS_CAP = ${PROGRESS_CAP}`);
console.log(`DRAFT_WAIT_PLAN: estimate=${DRAFT_WAIT_PLAN.estimateMs}ms slow=${DRAFT_WAIT_PLAN.slowAfterMs}ms critical=${DRAFT_WAIT_PLAN.criticalAfterMs}ms`);
console.log("");
console.log("时刻(s) | 阶段 | 站名 | 文案 | tier | progress | remainText");
console.log("--------|------|------|------|------|----------|----------");

let monotonic = true;
let prevIndex = -1;
let capViolated = false;
let slowBeforeThreshold = false;

for (let elapsed = 0; elapsed <= DRAFT_ELAPSED_MS; elapsed += POLL_INTERVAL_MS) {
  const snapshot = resolveWaitStage(DRAFT_WAIT_PLAN, elapsed);
  const seconds = (elapsed / 1000).toFixed(0);
  console.log(
    `${seconds.padStart(5)}s | ${snapshot.index} | ${snapshot.stage.name} | ${snapshot.stage.sentence} | ${snapshot.tier} | ${(snapshot.progress * 100).toFixed(1)}% | ${snapshot.remainText}`
  );

  // 断言：阶段单调推进
  if (snapshot.index < prevIndex) {
    monotonic = false;
    console.log(`  !! 阶段回退: ${prevIndex} -> ${snapshot.index}`);
  }
  prevIndex = snapshot.index;

  // 断言：PROGRESS_CAP 不提前到 100%
  if (snapshot.progress >= 1.0) {
    capViolated = true;
    console.log(`  !! progress 达到 100%: ${snapshot.progress}`);
  }

  // 断言：slow 档仅在超 130s 后出现（DRAFT_WAIT_PLAN.slowAfterMs=130000）
  if (snapshot.tier === "slow" && elapsed < (DRAFT_WAIT_PLAN.slowAfterMs ?? DRAFT_WAIT_PLAN.estimateMs)) {
    slowBeforeThreshold = true;
    console.log(`  !! slow 档提前出现: elapsed=${elapsed}ms < slowAfter=${DRAFT_WAIT_PLAN.slowAfterMs}ms`);
  }
}

console.log("");
console.log("=== 断言结果 ===");
console.log(`阶段单调推进: ${monotonic ? "PASS" : "FAIL"}`);
console.log(`PROGRESS_CAP 不提前到 100%: ${!capViolated ? "PASS" : "FAIL"}`);
console.log(`slow 档仅在超 ${DRAFT_WAIT_PLAN.slowAfterMs}ms 后出现: ${!slowBeforeThreshold ? "PASS" : "FAIL"}`);
console.log(`SOURCE_STALL_AFTER_MS = ${SOURCE_STALL_AFTER_MS}ms (来源侧 stalled 阈值)`);

// 来源侧等待分级（纯文字来源，无图片队列）
console.log("");
console.log("=== 来源侧等待分级（纯文字 source，status=processing） ===");
const mockTextSource = {
  sourceId: "src_mock",
  sourceVersion: 1,
  inputKind: "text" as const,
  title: "测试",
  sourceUrl: null,
  canonicalUrl: null,
  active: true,
  staged: true,
  status: "processing" as const,
  evidenceRefs: [],
  mentionRefs: [],
  imageProgress: { total: 0, completed: 0, failed: 0, images: [] },
  importedAt: new Date().toISOString(),
  updatedAt: new Date(Date.now() - 30_000).toISOString(),
  failureCode: null,
  failureMessage: null,
  coverageText: null,
  sourceText: "三亚攻略正文...",
  imageOcrDeferred: undefined,
};

const meter = sourceWaitMeter(mockTextSource as any, Date.now());
if (meter) {
  console.log(`phase: ${meter.phase}, name: ${meter.name}`);
  console.log(`sentence: ${meter.sentence}`);
  console.log(`ratio: ${meter.ratio}, mode: ${meter.mode}`);
  console.log(`stalled: ${meter.stalled} (updatedAt 30s ago, threshold=${SOURCE_STALL_AFTER_MS}ms)`);
}
