/**
 * Task #275 烟雾自检：planner 录制/回放缓存（完全离线，桩响应驱动）。
 *
 * 验证三件事（用例文档 v1.1 §0 拍板口径）：
 * 1. 录制/回放键一致性：同 prompt 两次调用 → 第一次 live 录制、第二次 replay 命中，
 *    响应逐字一致，桩只被真调一次；
 * 2. 键敏感性：prompt 变一个字符 → 键不同 → 不命中（自动重录，即 prompt 回归检测）；
 * 3. EVAL_LIVE=1 旁路：缓存存在也强制真调并重新录制（里程碑轮语义）。
 *
 * 运行：npx tsx eval/harness/selfCheck.ts（缓存写入 eval/cache/planner/，gitignore 可再生）
 */

import assert from "node:assert/strict";
import {
  clearCache,
  drainCallModes,
  installPlannerCache,
  plannerCacheKey,
  readCache,
  type PlannerCacheHandle,
} from "./plannerCache.js";

const PROMPT_A = "【自检】planner 缓存桩 prompt A：三亚 5 天行程草案请求";
const PROMPT_B = `${PROMPT_A}（变体）`;
const STUB_RESPONSE = JSON.stringify({ baseVersion: 1, operations: [], unplaced: [], proposedNew: [], clarify: null, snippets: [], optionGroups: [] });

/** 当前安装的缓存 handle（callPlanner 经它驱动包装本体） */
let activeHandle: PlannerCacheHandle | null = null;

async function main(): Promise<void> {
  let stubCalls = 0;
  const stub = async (_prompt: string, _timeoutMs: number): Promise<string> => {
    stubCalls += 1;
    return STUB_RESPONSE;
  };

  // ---- 1. replay 模式（EVAL_REPLAY=1）：未命中录制 → 命中回放 ----
  process.env["EVAL_REPLAY"] = "1";
  delete process.env["EVAL_LIVE"];
  let handle = installPlannerCache();
  handle.setInner(stub);
  activeHandle = handle;
  assert.equal(handle.mode, "replay", "EVAL_REPLAY=1 应为 replay 模式");

  const keyA = plannerCacheKey(PROMPT_A);
  // 清场：自检键的残留缓存删掉，保证脚本可重复跑
  clearCache(keyA);
  clearCache(plannerCacheKey(PROMPT_B));
  assert.equal(readCache(keyA), null, "清场后缓存应无 PROMPT_A");

  const first = await callPlanner(PROMPT_A);
  const modes1 = drainCallModes();
  assert.equal(stubCalls, 1, "第一次调用应真调（录制）");
  assert.deepEqual(modes1, ["live"], "第一次调用应标 [live]");
  assert.equal(first, STUB_RESPONSE);
  const recorded = readCache(keyA);
  assert.ok(recorded !== null, "录制后缓存文件应存在");
  assert.equal(recorded.response, STUB_RESPONSE, "录制内容应与响应一致");

  const second = await callPlanner(PROMPT_A);
  const modes2 = drainCallModes();
  assert.equal(stubCalls, 1, "第二次调用应命中回放（桩不再被调）");
  assert.deepEqual(modes2, ["replay"], "第二次调用应标 [replay]");
  assert.equal(second, first, "回放响应应与录制逐字一致（键一致性）");
  console.log(`selfCheck 1 pass: 同 prompt 键一致（${keyA.slice(0, 12)}…），live 录制 → replay 命中，响应逐字一致`);

  // ---- 2. 键敏感性：prompt 变一个字符即不命中 ----
  const keyB = plannerCacheKey(PROMPT_B);
  assert.notEqual(keyA, keyB, "prompt 变化应产生不同缓存键");
  const third = await callPlanner(PROMPT_B);
  const modes3 = drainCallModes();
  assert.equal(stubCalls, 2, "变体 prompt 应真调重录");
  assert.deepEqual(modes3, ["live"], "变体 prompt 应标 [live]");
  assert.equal(third, STUB_RESPONSE);
  console.log(`selfCheck 2 pass: prompt 变更 → 键 ${keyB.slice(0, 12)}… ≠ ${keyA.slice(0, 12)}…，自动重录（prompt 回归检测）`);
  handle.uninstall();

  // ---- 3. EVAL_LIVE=1 旁路：缓存存在也强制真调并重录 ----
  process.env["EVAL_LIVE"] = "1";
  handle = installPlannerCache();
  handle.setInner(stub);
  activeHandle = handle;
  assert.equal(handle.mode, "live", "EVAL_LIVE=1 应为 live 模式");
  const fourth = await callPlanner(PROMPT_A);
  const modes4 = drainCallModes();
  assert.equal(stubCalls, 3, "live 模式应绕过缓存真调");
  assert.deepEqual(modes4, ["live"], "live 模式应标 [live]");
  assert.equal(fourth, STUB_RESPONSE);
  const rerecorded = readCache(keyA);
  assert.ok(rerecorded !== null && rerecorded.mode === "live", "live 真调后应重新录制");
  console.log(`selfCheck 3 pass: EVAL_LIVE=1 旁路缓存强制真调（里程碑轮语义），并刷新录制`);
  handle.uninstall();
  activeHandle = null;
  delete process.env["EVAL_LIVE"];
  delete process.env["EVAL_REPLAY"];

  console.log("selfCheck 全部通过：录制/回放键一致性与 EVAL_LIVE 旁路验证 OK");
}

/** 经 handle 暴露的缓存包装本体调用（与注入到 GuidePlannerDeps.callPlanner 的同一函数） */
async function callPlanner(prompt: string): Promise<string> {
  assert.ok(activeHandle !== null, "callPlanner 需在 installPlannerCache 之后调用");
  return activeHandle.callPlanner(prompt, 30_000);
}

void main().catch((error) => {
  console.error("selfCheck 失败：", error);
  process.exit(1);
});
