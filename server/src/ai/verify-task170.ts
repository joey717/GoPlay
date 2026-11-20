/**
 * Task #170 回归验证脚本（纯虚拟时钟 + agent 桩注入，不依赖模型 / 网络 / 服务端进程）：
 *   1. 共享总预算：每次百炼调用只分到剩余预算，任何调用的「发起时刻 + 单次超时」
 *      都不越过 deadline，本轮总耗时被封顶在预算内（120s）；
 *   2. 解析失败保留至多一次重试；网络超时一次即失败、不得重试；
 *   3. 剩余预算不足 MIN_RETRY_BUDGET_MS 时不再发起无意义重试，错误文案报告
 *      本轮总耗时 / 总预算 / 尝试次数（不暗示单次尝试）；
 *   4. 解析候选尾部优先：回显 prompt（自带「输出空数组 []」示例与 schema 对象）
 *      后跟真实数组仍正确提取；回显后模型无输出时不得把示例 [] 误当空结果；
 *   5. 既有格式兼容：纯数组 / markdown code fence / 对象包裹 / 带解释文字 / 空数组。
 *
 * 运行：npx tsx server/src/ai/verify-task170.ts
 */

import assert from "node:assert/strict";
import { BailianTimeoutError } from "../bailian/client.js";
import { AiError } from "./errors.js";
import { buildExtractPrompt } from "./prompt.js";
import {
  callAndParseExtract,
  DEFAULT_EXTRACT_TIMEOUT_MS,
  MIN_RETRY_BUDGET_MS,
  parseExtractedArray,
  type ExtractAgentResponse,
  type ExtractCallDeps,
} from "./extract.js";

function pass(name: string): void {
  console.log(`✓ ${name}`);
}

// ---- 测试基建：虚拟时钟 + 百炼 agent 桩 ----

interface VirtualClock {
  now: () => number;
  advance: (ms: number) => void;
}

function virtualClock(startMs = 0): VirtualClock {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

/** 桩记录的一次 agent 调用 */
interface AgentCall {
  prompt: string;
  timeoutMs: number;
  calledAtMs: number;
}

/**
 * agent 桩：按序消费响应脚本（每个脚本项自行推进时钟后返回响应或抛出异常），
 * 收到超出脚本数量的调用立即抛错——用于断言「不得多发起无意义重试」。
 */
function agentStub(
  clock: VirtualClock,
  scripts: Array<(call: AgentCall) => Promise<ExtractAgentResponse>>,
): { deps: ExtractCallDeps; calls: AgentCall[] } {
  const calls: AgentCall[] = [];
  let index = 0;
  const callAgent = async (
    prompt: string,
    options: { timeoutMs: number },
  ): Promise<ExtractAgentResponse> => {
    const call: AgentCall = { prompt, timeoutMs: options.timeoutMs, calledAtMs: clock.now() };
    calls.push(call);
    const script = scripts[index];
    index += 1;
    if (script === undefined) {
      throw new Error(`百炼桩收到超出脚本的第 ${index} 次调用，不应发生`);
    }
    return script(call);
  };
  return { deps: { callAgent, now: clock.now }, calls };
}

/** 模拟一次耗时 elapsedMs、返回 finalText 的成功调用 */
function respondWith(clock: VirtualClock, elapsedMs: number, finalText: string) {
  return async (): Promise<ExtractAgentResponse> => {
    clock.advance(elapsedMs);
    return { finalText, latencyMs: elapsedMs };
  };
}

/** 模拟一次在单次超时点 abort 的调用（createBailianSession 的超时行为） */
function timeoutAfter(clock: VirtualClock) {
  return async (call: AgentCall): Promise<ExtractAgentResponse> => {
    clock.advance(call.timeoutMs);
    throw new BailianTimeoutError(call.timeoutMs);
  };
}

/** AiError 断言辅助：校验 code 与 message 关键片段 */
function assertAiError(error: unknown, messagePattern: RegExp): AiError {
  assert.ok(error instanceof AiError, `应为 AiError，实际 ${String(error)}`);
  assert.equal(error.code, "BAILIAN_REQUEST_FAILED");
  assert.match(error.message, messagePattern);
  return error;
}

// 用真实抽取 prompt 驱动回显场景（EXTRACT_RULES 自带「输出空数组 []」示例与 schema 对象）
const PROMPT = buildExtractPrompt(
  "三天两夜三亚之旅：第一天后海村冲浪，傍晚去第一市场吃海鲜；第二天西岛潜水，情人桥看日落。",
);
const REAL_OUTPUT = JSON.stringify([
  { name: "后海村", type: "attraction", summary: "冲浪胜地" },
  { name: "第一市场", type: "attraction", summary: "海鲜市场" },
]);

// ---- 1. 首轮解析失败 → 重试一次成功；第二轮只使用剩余预算 ----
{
  const clock = virtualClock();
  const firstCostMs = 70_000; // 首轮 70s 返回不可解析文本，剩余 20s（总预算 90s）
  const { deps, calls } = agentStub(clock, [
    respondWith(clock, firstCostMs, "抱歉，我无法按要求的格式处理这篇笔记。"),
    respondWith(clock, 15_000, REAL_OUTPUT),
  ]);
  const entries = await callAndParseExtract(PROMPT, DEFAULT_EXTRACT_TIMEOUT_MS, deps);
  assert.equal(calls.length, 2, "解析失败应触发恰好一次重试");
  assert.deepEqual(entries?.map((e) => e.name), ["后海村", "第一市场"]);
  assert.equal(calls[0].timeoutMs, DEFAULT_EXTRACT_TIMEOUT_MS, "首轮获得完整预算 90s");
  assert.equal(
    calls[1].timeoutMs,
    DEFAULT_EXTRACT_TIMEOUT_MS - firstCostMs,
    "第二轮只分到剩余预算（90s - 70s = 20s），不再是独立 90s",
  );
  pass("首轮解析失败重试：第二轮仅使用剩余预算 20s 并成功提取");
}

// ---- 2. 总耗时封顶：任何调用的发起时刻 + 单次超时 ≤ 总预算 ----
{
  const clock = virtualClock();
  const { deps, calls } = agentStub(clock, [
    respondWith(clock, 60_000, "无法解析的输出"),
    respondWith(clock, 25_000, REAL_OUTPUT),
  ]);
  await callAndParseExtract(PROMPT, DEFAULT_EXTRACT_TIMEOUT_MS, deps);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(
      call.calledAtMs + call.timeoutMs <= DEFAULT_EXTRACT_TIMEOUT_MS,
      `调用（发起 ${call.calledAtMs}ms + 超时 ${call.timeoutMs}ms）不得越过 90s deadline`,
    );
  }
  assert.ok(clock.now() <= DEFAULT_EXTRACT_TIMEOUT_MS, "虚拟时钟总推进不超过总预算");
  pass("总耗时封顶：两次调用的 deadline 均不越过 90s 总预算");
}

// ---- 3. 首轮超时：一次即失败，不重试；文案报总耗时/总预算/尝试次数 ----
{
  const clock = virtualClock();
  const { deps, calls } = agentStub(clock, [timeoutAfter(clock)]);
  const error = await callAndParseExtract(PROMPT, DEFAULT_EXTRACT_TIMEOUT_MS, deps).then(
    () => {
      throw new Error("首轮超时应抛 AiError");
    },
    (err: unknown) => err,
  );
  assertAiError(error, /本轮已等待 90 秒、总预算 90 秒，共尝试 1 次/);
  assert.ok(
    error instanceof AiError && error.cause instanceof BailianTimeoutError,
    "cause 携带 BailianTimeoutError（routes 层据此不再自动重试）",
  );
  assert.equal(calls.length, 1, "网络超时一次即失败，不得发起第二次调用");
  pass("首轮超时：只调用一次即报错，文案报总耗时 90s / 总预算 90s / 共尝试 1 次");
}

// ---- 4. 第二轮用尽剩余预算后超时：文案报整轮口径（90s / 90s / 2 次） ----
{
  const clock = virtualClock();
  const { deps, calls } = agentStub(clock, [
    respondWith(clock, 70_000, "无法解析的输出"),
    timeoutAfter(clock),
  ]);
  const error = await callAndParseExtract(PROMPT, DEFAULT_EXTRACT_TIMEOUT_MS, deps).then(
    () => {
      throw new Error("预算耗尽应抛 AiError");
    },
    (err: unknown) => err,
  );
  assertAiError(error, /本轮已等待 90 秒、总预算 90 秒，共尝试 2 次/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].timeoutMs, 20_000, "第二轮超时上限 = 剩余预算 20s，而非新的 90s");
  pass("重试轮超时：以剩余预算 20s 为限失败，错误报整轮 90s / 90s / 2 次");
}

// ---- 5. 预算耗尽错误文案：剩余不足阈值时不发起无意义重试 ----
{
  const clock = virtualClock();
  const firstCostMs = DEFAULT_EXTRACT_TIMEOUT_MS - (MIN_RETRY_BUDGET_MS - 5_000); // 85s，剩 5s < 10s
  assert.equal(firstCostMs, 85_000);
  const { deps, calls } = agentStub(clock, [
    respondWith(clock, firstCostMs, "无法解析的输出"),
  ]);
  const error = await callAndParseExtract(PROMPT, DEFAULT_EXTRACT_TIMEOUT_MS, deps).then(
    () => {
      throw new Error("剩余预算不足应抛 AiError");
    },
    (err: unknown) => err,
  );
  assertAiError(error, /本轮已等待 85 秒、总预算 90 秒，共尝试 1 次/);
  assert.equal(calls.length, 1, "剩余 5s 低于最小重试预算 10s，不得发起注定超时的重试");
  pass("预算耗尽：剩余 5s < 10s 阈值时不重试，报总耗时 85s / 总预算 90s / 共尝试 1 次");
}

// ---- 6. 两次解析均失败：恰好在第二次后放弃（返回 null 交上层抛 AI_PARSE_FAILED） ----
{
  const clock = virtualClock();
  const { deps, calls } = agentStub(clock, [
    respondWith(clock, 20_000, "垃圾输出一"),
    respondWith(clock, 20_000, "垃圾输出二"),
  ]);
  const result = await callAndParseExtract(PROMPT, DEFAULT_EXTRACT_TIMEOUT_MS, deps);
  assert.equal(result, null, "两次解析失败返回 null");
  assert.equal(calls.length, 2, "解析失败最多重试一次（不超发第三次）");
  assert.equal(calls[1].timeoutMs, 70_000, "重试使用剩余预算 70s");
  pass("两次解析均失败：恰好两次后返回 null（上层抛 AI_PARSE_FAILED）");
}

// ---- 7. 回显 prompt（含示例 [] 与 schema 对象）后的提取 ----
{
  // 7a. 完整回显 + 真实数组：剥离回显后提取真实条目
  const echoed = `${PROMPT}${REAL_OUTPUT}`;
  const parsedEcho = parseExtractedArray(echoed, PROMPT);
  assert.deepEqual(
    parsedEcho?.map((e) => e.name),
    ["后海村", "第一市场"],
    "回显 prompt 含「输出空数组 []」后跟真实数组，应提取真实数组而非误判空结果",
  );

  // 7b. 回显后模型无输出：回显内的示例 [] 不得被当作最终空结果
  const echoedOnly = parseExtractedArray(PROMPT, PROMPT);
  assert.equal(echoedOnly, null, "纯回显（无模型输出）应解析失败触发重试，而非返回空结果");

  // 7c. 部分回显（无整段前缀锚点）：由尾部平衡 JSON 候选兜底
  const partialEcho = `……如果笔记中没有任何可识别的地点，输出空数组 []\n\n${REAL_OUTPUT}`;
  const parsedPartial = parseExtractedArray(partialEcho);
  assert.deepEqual(parsedPartial?.map((e) => e.name), ["后海村", "第一市场"]);
  pass("回显防御：示例 [] 不再干扰——真实数组正确提取，纯回显不再误判为空结果");
}

// ---- 8. 既有格式兼容：纯数组 / code fence / 对象包裹 / 解释文字 / 空数组 ----
{
  const cases: Array<{ label: string; finalText: string; expectedNames: string[] }> = [
    { label: "纯数组", finalText: REAL_OUTPUT, expectedNames: ["后海村", "第一市场"] },
    { label: "code fence", finalText: "```json\n" + REAL_OUTPUT + "\n```", expectedNames: ["后海村", "第一市场"] },
    { label: "对象包裹", finalText: JSON.stringify({ entries: JSON.parse(REAL_OUTPUT) }), expectedNames: ["后海村", "第一市场"] },
    { label: "带解释文字", finalText: `以下是提取结果：\n${REAL_OUTPUT}\n希望对你有帮助`, expectedNames: ["后海村", "第一市场"] },
    { label: "合法空数组", finalText: "[]", expectedNames: [] },
  ];
  for (const { label, finalText, expectedNames } of cases) {
    const parsed = parseExtractedArray(finalText, PROMPT);
    assert.ok(parsed !== null, `${label}应可解析`);
    assert.deepEqual(parsed.map((e) => e.name), expectedNames, label);
  }
  // 多字段对象（回显 prompt 中的 schema 示例形态）不得被解包成条目
  const schemaObject = `{ "name": "地点本名", "type": "attraction", "parentAttraction": null, "suggestMinutes": 90 }`;
  assert.equal(parseExtractedArray(schemaObject), null, "schema 示例对象（多字段）不得被提取");
  pass("既有格式兼容：纯数组 / fence / 对象包裹 / 解释文字 / 空数组；schema 示例对象仍被拒绝");
}

console.log("\nTask #170 抽取总预算与回显解析验证全部通过");
