/**
 * Task #284：确定性 ID 生成器（依赖注入钩子）。
 *
 * 功能态（默认）：generateId(seed) 等价于 crypto.randomUUID()，seed 被忽略，
 * 行为零变化——生产链路不引入任何可观测差异。
 *
 * 评测态（EVAL_FIXTURE/EVAL_RECORD）：harness 通过 setIdGenerator 注入
 * 内容种子派生函数（deterministicIdFromSeed），保证同一种子跨进程产出同一
 * UUID → planner prompt 稳定 → 回放缓存键命中 → 零 token 回归。
 *
 * 设计约束：
 * - 不引入新依赖，只用 node:crypto（createHash + randomUUID）；
 * - seed→ID 映射是纯函数（sha256 截断为 UUID 8-4-4-4-12 格式）；
 * - 调用侧负责提供有意义的 seed（实体名 / 内容哈希 / 序号等），
 *   功能态下 seed 被忽略所以不影响现有行为。
 */

import { createHash, randomUUID } from "node:crypto";

/** ID 生成器签名：接受内容种子，返回 UUID 格式字符串 */
export type IdGenerator = (seed: string) => string;

/** 当前活跃的 ID 生成器（默认 = randomUUID，功能态零变化） */
let currentGenerator: IdGenerator = () => randomUUID();

/** 注入评测态确定性生成器（harness 调用） */
export function setIdGenerator(gen: IdGenerator): void {
  // Task #290 Nit9①：环境闸门——只允许评测态注入。currentGenerator 是进程内全局可变态，
  // 若功能态（server 自身或误引入的代码）改写它，种子派生 id 会泄漏到后续真实请求。
  // 非评测态直接抛错，让误用在第一时间暴露，而非静默产生不可回放的 id。
  if (process.env.EVAL_FIXTURE !== "1" && process.env.EVAL_RECORD !== "1") {
    throw new Error(
      "setIdGenerator 仅允许在评测态（EVAL_FIXTURE=1 或 EVAL_RECORD=1）调用；功能态禁止改写 ID 生成器",
    );
  }
  currentGenerator = gen;
}

/** 恢复默认生成器（功能态 / 测试隔离） */
export function resetIdGenerator(): void {
  currentGenerator = () => randomUUID();
}

/** 生成 ID：功能态忽略 seed 返回 randomUUID；评测态由注入的生成器决定 */
export function generateId(seed: string): string {
  return currentGenerator(seed);
}

/**
 * 确定性种子→UUID 格式派生（评测态用）：
 * sha256(seed) 截断为 8-4-4-4-12 格式，保证同种子同输出、不同种子极低碰撞率。
 */
export function deterministicIdFromSeed(seed: string): string {
  const hash = createHash("sha256").update(seed).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}
