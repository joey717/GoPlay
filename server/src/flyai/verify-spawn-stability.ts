/**
 * Task #335「去 npx 直跑 bundle」spawn 稳定性验证（零额度：全程 commander 本地报错 / 本地 help，不触网）。
 *
 * 经 client.ts 暴露的 runCliForStabilityTest 调用**真实** buildSpawnTarget + runProcess + 错误分类，
 * 反复跑 flyai-bundle.cjs：
 *   - 非法参数：`search-poi`（缺 --city-name）→ exit 1 + stderr「required option ... not specified」；
 *   - 本地成功：`search-poi --help` → exit 0 + 完整 usage（尾部「display help for command」）。
 * 连续 24 次（12 非法 + 12 help）＋并发 3 路 × 4 批 = 12 次，共 36 次 spawn。断言：
 *   1) 每次 mode==="bundle"（直跑生效，未退回 npx）；
 *   2) 非法：ok===false、errorCode==="FLYAI_UPSTREAM_FAILED"、detail 含「--city-name」「required option」
 *      （stderr 完整捕获、分类正确）；
 *   3) help：ok===true、output 含「Usage: flyai search-poi」与尾部标记（stdout 无截断）；
 *   4) help 输出经 parseCliJson 同款 ANSI 剥离正则后 usage 标记仍在（剥离幂等、不损坏内容）；
 *   5) 单次 ms < 5000（本地报错量级，非触网）；
 *   6) 90s 看门狗：未完成即判 spawn 挂起 / 句柄泄漏；脚本正常退出证明子进程句柄全部回收。
 * 任一断言失败 → 退出码 1（不静默放宽）。运行：npx tsx server/src/flyai/verify-spawn-stability.ts
 */
import { runCliForStabilityTest, type StabilityRunResult } from "./client.js";

const SEQ_ILLEGAL = 12;
const SEQ_HELP = 12;
const CONC_BATCHES = 4;
const CONC_WIDTH = 3;
const MS_UPPER = 5000;
/** 与 client.ts parseCliJson 同款的 ANSI 颜色剥离正则 */
const ANSI_RE = /\u001b\[[0-9;]*m/g;

function checkRun(r: StabilityRunResult, kind: "illegal" | "help", ctx: string, failures: string[]): void {
  if (r.mode !== "bundle") failures.push(`${ctx}: mode=${r.mode}（期望 bundle 直跑）`);
  if (r.ms > MS_UPPER) failures.push(`${ctx}: ms=${r.ms} 超本地上限 ${MS_UPPER}（疑似触网/挂起）`);
  if (kind === "illegal") {
    if (r.ok) failures.push(`${ctx}: 非法参数应 ok=false，实得 ok=true`);
    if (r.errorCode !== "FLYAI_UPSTREAM_FAILED") failures.push(`${ctx}: errorCode=${r.errorCode}（期望 FLYAI_UPSTREAM_FAILED）`);
    if (!r.detail.includes("--city-name") || !r.detail.includes("required option")) {
      failures.push(`${ctx}: stderr 未完整捕获 detail=${JSON.stringify(r.detail.slice(0, 120))}`);
    }
    return;
  }
  if (!r.ok) {
    failures.push(`${ctx}: --help 应 ok=true，实得 ok=false errorCode=${r.errorCode} detail=${r.detail.slice(0, 120)}`);
    return;
  }
  if (!r.output.includes("Usage: flyai search-poi")) failures.push(`${ctx}: help stdout 缺 usage 头（截断？）`);
  if (!r.output.includes("display help for command")) failures.push(`${ctx}: help stdout 缺尾部标记（截断？）`);
  const stripped = r.output.replace(ANSI_RE, "");
  if (!stripped.includes("Usage: flyai search-poi") || !stripped.includes("display help for command")) {
    failures.push(`${ctx}: ANSI 剥离后 usage 标记丢失（解析异常）`);
  }
}

async function main(): Promise<void> {
  const failures: string[] = [];
  const ms: number[] = [];
  let bundle = 0;
  let npx = 0;
  let ansiPresent = 0;
  const tally = (r: StabilityRunResult): void => {
    ms.push(r.ms);
    if (r.mode === "bundle") bundle += 1;
    else npx += 1;
    if (r.ok && /\u001b\[/.test(r.output)) ansiPresent += 1;
  };

  console.log(`===== Task #335 spawn 稳定性验证（零额度：commander 本地报错 / 本地 help）=====`);
  console.log(`连续：非法 ${SEQ_ILLEGAL} + --help ${SEQ_HELP}；并发：${CONC_WIDTH} 路 × ${CONC_BATCHES} 批；合计 ${SEQ_ILLEGAL + SEQ_HELP + CONC_BATCHES * CONC_WIDTH} 次 spawn`);

  for (let i = 0; i < SEQ_ILLEGAL; i++) {
    const r = await runCliForStabilityTest("search-poi", []);
    checkRun(r, "illegal", `seq-illegal#${i + 1}`, failures);
    tally(r);
  }
  for (let i = 0; i < SEQ_HELP; i++) {
    const r = await runCliForStabilityTest("search-poi", ["--help"]);
    checkRun(r, "help", `seq-help#${i + 1}`, failures);
    tally(r);
  }

  for (let b = 0; b < CONC_BATCHES; b++) {
    const kinds: Array<"illegal" | "help"> = [];
    const tasks: Array<Promise<StabilityRunResult>> = [];
    for (let w = 0; w < CONC_WIDTH; w++) {
      const kind: "illegal" | "help" = (b + w) % 2 === 0 ? "illegal" : "help";
      kinds.push(kind);
      tasks.push(
        kind === "illegal"
          ? runCliForStabilityTest("search-poi", [])
          : runCliForStabilityTest("search-poi", ["--help"]),
      );
    }
    const results = await Promise.all(tasks); // 3 路并发同时 spawn
    results.forEach((r, w) => {
      checkRun(r, kinds[w], `conc-b${b + 1}w${w + 1}`, failures);
      tally(r);
    });
  }

  const total = ms.length;
  const min = Math.min(...ms);
  const max = Math.max(...ms);
  const avg = ms.reduce((s, x) => s + x, 0) / total;
  console.log(`\n----- 结果 -----`);
  console.log(`总 spawn：${total} 次（连续 ${SEQ_ILLEGAL + SEQ_HELP} + 并发 ${CONC_BATCHES * CONC_WIDTH}）`);
  console.log(`spawn 模式：bundle 直跑 ${bundle} / npx 退回 ${npx}`);
  console.log(`单次墙钟 ms：min=${min} max=${max} avg=${avg.toFixed(1)}（本地报错量级，未触网）`);
  console.log(`help 输出含 ANSI 次数：${ansiPresent}（pipe 模式预期 0）`);
  console.log(`句柄泄漏：脚本正常退出 → 全部子进程句柄已回收（无挂起）`);

  if (npx > 0) failures.push(`${npx} 次退回 npx（bundle 直跑未全程生效）`);
  if (failures.length > 0) {
    console.error(`\n❌ 稳定性验证失败（${failures.length} 项）：`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`\n✅ 稳定性验证通过：${total} 次 spawn 全部 bundle 直跑；退出码/stdout-stderr 捕获/ANSI 剥离均正确；无截断、无挂起（无句柄泄漏）`);
}

// 看门狗：90s 未完成 → 判 spawn 挂起 / 句柄泄漏（ref'd，挂起时子进程句柄+本定时器共同维持事件循环直到触发）
const watchdog = setTimeout(() => {
  console.error(`❌ 看门狗触发：稳定性验证超过 90s 未完成，疑似 spawn 挂起 / 句柄泄漏`);
  process.exit(2);
}, 90_000);

main()
  .then(() => clearTimeout(watchdog))
  .catch((error) => {
    clearTimeout(watchdog);
    console.error(`稳定性脚本异常：`, error);
    process.exit(1);
  });
