/**
 * Task #275：planner（百炼）响应录制 / 回放缓存——快层回归零 token 的标配。
 *
 * 注入点（最小钩子）：`server/src/guides/planner.ts` 的 GuidePlannerDeps.callPlanner
 * （callAndParsePlanner 全部尝试统一经过该依赖，即百炼调用的唯一收口），
 * 用 setGuidePlannerDeps 包一层缓存，生产语义不变。
 *
 * 键：sha256(prompt + 配置指纹)。配置指纹取百炼非机密环境项
 * （APP_ID / WORKSPACE_ID / ENVIRONMENT_ID / MODEL），prompt 或模型配置一变
 * 键即失效自动重录——顺带获得 prompt 回归检测（用例文档 v1.1 §0）。
 * API Key 等机密绝不入指纹、不落盘。
 *
 * 模式（env 开关）：
 * - EVAL_LIVE=1        → live：强制真调百炼并录制（里程碑周中/演示前用；回放结论不作里程碑结论）；
 * - EVAL_REPLAY        → 默认随 EVAL_FIXTURE=1 开启（可显式 =0 关闭）：命中回放、未命中真调并录制；
 * - 两者都关           → passthrough：直接真调，不读缓存（仍录制，供后续回放）。
 * 缓存文件：eval/cache/planner/{key}.json（gitignore，可再生）。
 * 报告标注：runner 逐用例调 drainCallModes() 拿 [replay]/[live] 标签写进 report.md。
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resetGuidePlannerDeps,
  setGuidePlannerDeps,
} from "../../server/src/guides/planner.js";

const CACHE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../cache/planner");

export type PlannerCallMode = "replay" | "live";

export interface PlannerCacheRecord {
  key: string;
  mode: PlannerCallMode;
  /** prompt 前 120 字（人工排查用；全文不入盘，缓存键即内容寻址） */
  promptPreview: string;
  configFingerprint: string;
  response: string;
  durationMs: number;
  recordedAt: string;
}

export interface PlannerCacheStats {
  replayHits: number;
  liveCalls: number;
  /** 本次进程内逐次调用的模式序列（runner 按用例分段收割） */
  callModes: PlannerCallMode[];
}

const stats: PlannerCacheStats = { replayHits: 0, liveCalls: 0, callModes: [] };

export function plannerCacheMode(): "live" | "replay" | "passthrough" {
  if (process.env["EVAL_LIVE"] === "1") return "live";
  const explicit = process.env["EVAL_REPLAY"];
  if (explicit === "0") return "passthrough";
  if (explicit === "1") return "replay";
  return process.env["EVAL_FIXTURE"] === "1" ? "replay" : "passthrough";
}

/** 百炼配置指纹：只取非机密项；模型/应用配置变更 → 缓存整体失效重录 */
function configFingerprint(): string {
  const parts = [
    process.env["BAILIAN_APP_ID"] ?? "",
    process.env["BAILIAN_WORKSPACE_ID"] ?? "",
    process.env["BAILIAN_ENVIRONMENT_ID"] ?? "",
    process.env["BAILIAN_MODEL"] ?? "",
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

export function plannerCacheKey(prompt: string): string {
  return createHash("sha256").update(`${configFingerprint()}\n${prompt}`).digest("hex");
}

function cachePath(key: string): string {
  return join(CACHE_DIR, `${key}.json`);
}

export function readCache(key: string): PlannerCacheRecord | null {
  try {
    return JSON.parse(readFileSync(cachePath(key), "utf8")) as PlannerCacheRecord;
  } catch {
    return null;
  }
}

export function writeCache(record: PlannerCacheRecord): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath(record.key), JSON.stringify(record, null, 2), "utf8");
}

/** 删除指定键的缓存文件（selfCheck 清场用）；不存在时静默 */
export function clearCache(key: string): void {
  rmSync(cachePath(key), { force: true });
}

/** 收割并清空本段调用模式（runner 每条用例结束调用，写 [replay]/[live] 标注） */
export function drainCallModes(): PlannerCallMode[] {
  const modes = [...stats.callModes];
  stats.callModes.length = 0;
  return modes;
}

export function getPlannerCacheStats(): Readonly<PlannerCacheStats> {
  return stats;
}

export interface PlannerCacheHandle {
  mode: "live" | "replay" | "passthrough";
  /** 指定真调通道（默认＝真百炼）；烟雾验证注入桩后可完全离线测录制/回放 */
  setInner: (fn: (prompt: string, timeoutMs: number) => Promise<string>) => void;
  /**
   * 缓存包装本体（与注入到 GuidePlannerDeps.callPlanner 的是同一个函数）：
   * 生产链路由 planner.ts 依赖注入驱动；selfCheck 无业务入口时经此直接驱动，
   * 验证的是同一段录制/回放逻辑。
   */
  callPlanner: (prompt: string, timeoutMs: number) => Promise<string>;
  uninstall: () => void;
}

/** 默认真调通道：与 planner.ts defaultCallPlanner 同语义（同一 bailian client，零行为差） */
async function defaultInnerCall(prompt: string, timeoutMs: number): Promise<string> {
  const { createBailianSession } = await import("../../server/src/bailian/client.js");
  const result = await createBailianSession(prompt, { timeoutMs });
  return result.finalText;
}

/**
 * 安装缓存包装（幂等）：用 setGuidePlannerDeps 把 callPlanner 换成缓存包装，
 * 真调通道默认＝真百炼（defaultInnerCall），可用 handle.setInner 注入桩。
 * uninstall 恢复 planner.ts 默认依赖。
 */
export function installPlannerCache(): PlannerCacheHandle {
  const mode = plannerCacheMode();
  let inner: (prompt: string, timeoutMs: number) => Promise<string> = defaultInnerCall;

  const callPlannerWithCache = async (prompt: string, timeoutMs: number): Promise<string> => {
    const key = plannerCacheKey(prompt);

    if (mode === "replay") {
      const hit = readCache(key);
      if (hit !== null) {
        stats.replayHits += 1;
        stats.callModes.push("replay");
        console.log(`[EVAL-PLANNER] replay 命中：key=${key.slice(0, 12)}…（录制于 ${hit.recordedAt}，${hit.durationMs}ms）`);
        return hit.response;
      }
      console.log(`[EVAL-PLANNER] replay 未命中，转真调录制：key=${key.slice(0, 12)}…`);
    }

    const started = Date.now();
    const response = await inner(prompt, timeoutMs);
    const durationMs = Date.now() - started;
    stats.liveCalls += 1;
    stats.callModes.push("live");
    writeCache({
      key,
      mode: "live",
      promptPreview: prompt.slice(0, 120),
      configFingerprint: configFingerprint(),
      response,
      durationMs,
      recordedAt: new Date().toISOString(),
    });
    console.log(`[EVAL-PLANNER] live 真调并录制：key=${key.slice(0, 12)}…（${durationMs}ms）`);
    return response;
  };

  setGuidePlannerDeps({ callPlanner: callPlannerWithCache });
  return {
    mode,
    setInner: (fn) => {
      inner = fn;
    },
    callPlanner: callPlannerWithCache,
    uninstall: () => {
      inner = defaultInnerCall;
      resetGuidePlannerDeps();
    },
  };
}
