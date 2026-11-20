/**
 * Task #276 / #285：「报」判定 UI 用例自动截图（Q1 抽屉回看 / Q3 零 snippet / S5 时间标签 / Q7 点位配图）。
 *
 * 独立于主 runner 执行（浏览器编排隔离，失败不影响主流程）：
 *   npm run eval:ui                    # 全场景
 *   npm run eval:ui scene=q7           # Task #293：只跑指定场景（q1/q3/s5/q7，可逗号多个）
 *
 * 流程：起 web vite dev（5173 strictPort）＋ server（8787，Q7 小图经 /api/uploads 由此提供）
 * → playwright chromium 打开 /eval-ui.html?scene=…
 * → Q1 点绿色 snippet chip 展开抽屉截图；Q3 直接截图；S5 双宽度取证；
 *   Q7（Task #293 真值表锚定）西岛 large_attraction 父卡 8 拍照线点位（页码＝笔记真实
 *   PX 标注，见 eval/harness/q7Truth.ts），逐点位 DOM 断言「点位名 ↔ 小图 src 文件名」
 *   等于真值表期望（内容级锚点），真实无标注点位「小吃街」断言回退占位（.ph-tile），
 *   390px 视口整页截图
 * → 产物落 eval-report/v2/evidence/{Q1,Q1-drawer,Q3,S5-390,S5-320,Q7}.png（gitignore）。
 *
 * 渲染源见 web/src/eval-ui.tsx（复用真实 VisitCard/StopRow/EvidenceSheet + styles.css）。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { Q7_NO_IMAGE_POINT_NAME, Q7_PARENT_MAINPIC, Q7_POINTS, q7ExpectedAssetPaths } from "./q7Truth.js";
// Task #301：E9 亚龙湾「页面落位」真值（scene=e9 DOM 断言用，与 web/src/eval-ui.tsx sceneE9 同源）
import { E9_CLAIM_MAPPING, E9_REGION_LABEL, E9_REGION_ORDER, E9_RECALL, E9_SUBSPOTS, e9ClaimsByRegion, e9SunkTips } from "./e9Truth.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WEB_DIR = join(REPO_ROOT, "web");
const EVIDENCE_DIR = join(REPO_ROOT, "eval-report/v2/evidence");
const PORT = 5173;
const BASE = `http://localhost:${PORT}/eval-ui.html`;
/** Q7 点位小图经 vite /api 代理到 server:8787 的 xhsAssetRoutes，故 Q7 需同时起 server */
const SERVER_PORT = 8787;
const XIDAO_NOTE_ID = "6ace31c6000000001b0202f7";
/** Task #293：Q7 取证视口＝390px（移动端主流宽度，与 S5-390 同口径） */
const Q7_VIEWPORT_WIDTH = 390;
/** Task #301：E9 页面落位取证视口＝390px（移动端主流宽度；含 11 条落位对照面板，整页截图） */
const E9_VIEWPORT_WIDTH = 390;

/** 场景过滤：`npm run eval:ui scene=q7`（npm 会把 `scene=q7` 原样透传进 argv）；缺省全场景 */
const ALL_SCENES = ["q1", "q3", "s5", "q7", "e9"] as const;
function parseScenes(argv: readonly string[]): Set<string> {
  for (const arg of argv) {
    if (arg.startsWith("scene=")) {
      const picked = arg.slice("scene=".length).split(",").map((s) => s.trim().toLowerCase()).filter((s) => s !== "");
      const unknown = picked.filter((s) => !(ALL_SCENES as readonly string[]).includes(s));
      if (unknown.length > 0) throw new Error(`[uiShot] 未知场景：${unknown.join(",")}（可用：${ALL_SCENES.join(", ")}）`);
      return new Set(picked);
    }
  }
  return new Set(ALL_SCENES);
}
const SCENES = parseScenes(process.argv.slice(2));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 轮询端口就绪（vite 冷启动 ~1-3s） */
async function waitForServer(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${BASE}?scene=q1`);
      if (res.ok) return;
    } catch {
      // 尚未监听：继续等
    }
    if (Date.now() > deadline) throw new Error(`vite dev 启动超时（${timeoutMs}ms，端口 ${PORT}）`);
    await sleep(500);
  }
}

function startVite(): ChildProcess {
  const child = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
    cwd: WEB_DIR,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => process.stdout.write(`[vite] ${d.toString()}`));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[vite:err] ${d.toString()}`));
  return child;
}

/** 起 server（8787）——Q7 点位小图经 /api/uploads 由此提供（xhsAssetRoutes 受控读取）。
 *  直接 tsx src/index.ts（非 watch 单进程，收尾 kill 干净，不留孤儿占端口） */
function startServer(): ChildProcess {
  const child = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: join(REPO_ROOT, "server"),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => process.stdout.write(`[server] ${d.toString()}`));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server:err] ${d.toString()}`));
  return child;
}

/** 轮询 server 上西岛真值首图（点位1 p4 → 4.jpg）可服务（200 即就绪；tsx 冷启动 ~2-5s） */
async function waitForServerImage(timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://localhost:${SERVER_PORT}/api/uploads/xhs_${XIDAO_NOTE_ID}/4.jpg`;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // 尚未监听：继续等
    }
    if (Date.now() > deadline) return false;
    await sleep(500);
  }
}

/** 截图阶段产物名（收尾日志用；与 SCENES 过滤联动） */
function shotNames(): string {
  const names: string[] = [];
  if (SCENES.has("q1")) names.push("Q1", "Q1-drawer");
  if (SCENES.has("q3")) names.push("Q3");
  if (SCENES.has("s5")) names.push("S5-390", "S5-320");
  if (SCENES.has("q7")) names.push("Q7");
  if (SCENES.has("e9")) names.push("E9-page-mapping");
  return names.join(",");
}

async function main(): Promise<void> {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const needServer = SCENES.has("q7");
  const vite = startVite();
  // Q7 小图需 server:8787；若已有 dev server 在跑则复用（避免 EADDRINUSE），否则临时起一个（收尾清理）
  const reusedServer = needServer ? await waitForServerImage(3000) : false;
  const server = needServer && !reusedServer ? startServer() : null;
  if (reusedServer) console.log(`[uiShot] 复用已在跑的 server:8787（Q7 小图源），不再另起`);
  let browser;
  try {
    await waitForServer();
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 440, height: 900 }, deviceScaleFactor: 2 });

    if (SCENES.has("q1")) {
      // ---- Q1：snippet 抽屉回看链路（chip → EvidenceSheet 原句 + 来源标题）----
      await page.goto(`${BASE}?scene=q1`, { waitUntil: "networkidle" });
      await page.waitForSelector(".guide-snippet-chip", { timeout: 15_000 });
      // 现场 1：卡片 + 绿色 snippet chip + 原文弱入口（抽屉未开）
      await page.screenshot({ path: join(EVIDENCE_DIR, "Q1.png"), fullPage: true });
      // 现场 2：点击 chip → EvidenceSheet 抽屉（原句 + 来源标题）
      await page.click(".guide-snippet-chip");
      await page.waitForSelector(".sheet.on", { timeout: 15_000 });
      await page.waitForSelector(".evidence-quote", { timeout: 15_000 });
      await sleep(400); // 等 smooth 滚动定位稳定
      await page.screenshot({ path: join(EVIDENCE_DIR, "Q1-drawer.png"), fullPage: true });
      const quoteText = await page.textContent(".evidence-quote");
      console.log(`[uiShot] Q1 抽屉原句：${(quoteText ?? "").trim().slice(0, 40)}`);
    }

    if (SCENES.has("q3")) {
      // ---- Q3：0 snippet 卡无原文入口（引用块整体隐藏）----
      await page.goto(`${BASE}?scene=q3`, { waitUntil: "networkidle" });
      await page.waitForSelector(".card, [class*=visit]", { timeout: 15_000 }).catch(() => {});
      await sleep(300);
      const chipCount = await page.locator(".guide-snippet-chip").count();
      const snippetsBlock = await page.locator(".guide-snippets").count();
      const sourceEntry = await page.locator(".evidence-link").count();
      console.log(`[uiShot] Q3 断言现场：snippet chip=${chipCount}，引用块=${snippetsBlock}，原文入口=${sourceEntry}（期望全 0）`);
      await page.screenshot({ path: join(EVIDENCE_DIR, "Q3.png"), fullPage: true });
    }

    if (SCENES.has("s5")) {
      // ---- S5：时间来源标签限场景展示（390px + 320px 宽度取证）----
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${BASE}?scene=s5`, { waitUntil: "networkidle" });
        await page.waitForSelector(".day-anchor", { timeout: 15_000 });
        await sleep(300);
        const anchorSrc = await page.locator(".anchor-src").textContent().catch(() => null);
        const anchorSrcBox = await page.locator(".anchor-src").boundingBox().catch(() => null);
        const overflow = anchorSrcBox !== null && anchorSrcBox.x + anchorSrcBox.width > width;
        console.log(`[uiShot] S5 @${width}px：灰字="${anchorSrc ?? "无"}"，box=${JSON.stringify(anchorSrcBox)}，溢出=${overflow}`);
        await page.screenshot({ path: join(EVIDENCE_DIR, `S5-${width}.png`), fullPage: true });
      }
      // 恢复默认视口
      await page.setViewportSize({ width: 440, height: 900 });
    }

    if (SCENES.has("q7")) {
      // ---- Q7：西岛点位配图（Task #293：逐点位「点位名 ↔ 小图文件名」真值表 DOM 断言）----
      // 小图经 vite /api 代理到 server:8787，先等 server 上西岛原图可服务再截图
      const serverReady = await waitForServerImage();
      console.log(`[uiShot] Q7 server 原图就绪=${serverReady}（http://localhost:${SERVER_PORT}/api/uploads/xhs_${XIDAO_NOTE_ID}/…）`);
      if (!serverReady) throw new Error("[uiShot] Q7：server:8787 西岛原图不可服务，截图会缺图（假现场），中止");
      await page.setViewportSize({ width: Q7_VIEWPORT_WIDTH, height: 1600 });
      await page.goto(`${BASE}?scene=q7`, { waitUntil: "networkidle" });
      await page.waitForSelector(".child-pic", { timeout: 15_000 });
      await sleep(1200); // 等 7 张点位小图（/api/uploads）加载完成
      // 渲染现场逐行采集：点位名 + 小图 src + 占位标记（DOM 序＝childStopRefs 序＝真值表序）
      const rows = await page.evaluate(() =>
        [...document.querySelectorAll(".child")].map((el) => ({
          name: (el.querySelector(".child-name")?.textContent ?? "").trim(),
          src: el.querySelector(".child-pic img")?.getAttribute("src") ?? null,
          placeholder: el.querySelector(".child-pic .ph-tile, .child-pic [role=img]") !== null,
        })),
      );
      if (rows.length !== Q7_POINTS.length) {
        throw new Error(`[uiShot] Q7：点位数 ${rows.length} ≠ 真值表 ${Q7_POINTS.length}（自造第 9「无图点位」已废，回退占位由小吃街真实触发）`);
      }
      let picCount = 0;
      let phCount = 0;
      rows.forEach((row, index) => {
        const point = Q7_POINTS[index]!;
        const expected = q7ExpectedAssetPaths(point);
        if (row.name !== point.name) {
          throw new Error(`[uiShot] Q7：第 ${index + 1} 行点位名「${row.name}」≠ 真值「${point.name}」（渲染顺序漂移）`);
        }
        if (expected.length === 0) {
          // 真实无标注点位（小吃街）：必须回退占位、不得挂任何图
          if (row.src !== null || !row.placeholder) {
            throw new Error(`[uiShot] Q7：「${point.name}」笔记无页码标注，应回退占位（.ph-tile）且不挂图，实际 src=${row.src} placeholder=${row.placeholder}`);
          }
          phCount += 1;
          console.log(`[uiShot] Q7 真值断言 ✓ 点位${index + 1}「${row.name}」无标注 → 回退占位（.ph-tile）`);
          return;
        }
        // 有图点位：src 必须逐字等于真值页码首图（内容级锚点，/api/ 前缀为 StopRow 受控读取路径）
        const expectedSrc = `/api/${expected[0]!}`;
        if (row.src !== expectedSrc) {
          throw new Error(`[uiShot] Q7：点位「${point.name}」小图 src=${row.src} ≠ 真值期望 ${expectedSrc}（错配即 #288 症状，截图不可信）`);
        }
        picCount += 1;
        console.log(`[uiShot] Q7 真值断言 ✓ 点位${index + 1}「${row.name}」pageRefs=[${point.pageRefs.join(",")}] → src=${row.src}`);
      });
      console.log(
        `[uiShot] Q7 断言现场：点位数=${rows.length}（期望 ${Q7_POINTS.length}＝拍照线全量），` +
          `小图 img=${picCount}（期望 ${Q7_POINTS.length - 1}，真值页码逐一相符），占位=${phCount}（期望 1＝「${Q7_NO_IMAGE_POINT_NAME}」真实无标注回退），视口=${Q7_VIEWPORT_WIDTH}px`,
      );
      // ---- Task #297：父卡飞猪主图确定性硬门（截图前必过，杜绝误导性降级截图）----
      // 父卡首图＝飞猪外链 mainPic（真实落盘 48275e19 西岛形态）。若 CDN 不可达，VisitCard 的
      // onError 会置 fliggyImgFailed→降级为 PX 攻略图，截图又会显示 PX（正是 PD 复核看到的症状）。
      // 故截图前硬断言：①.parent-banner img src 逐字＝飞猪真值（未降级）②naturalWidth>0（外链真加载成功）；
      // 任一不满足即抛错中止，绝不产出「父卡是 PX 图」的误导截图。
      const parentBanner = page.locator(".parent-banner img");
      await parentBanner.scrollIntoViewIfNeeded();
      await page
        .waitForFunction(
          (expected) => {
            const img = document.querySelector(".parent-banner img") as HTMLImageElement | null;
            return img !== null && img.getAttribute("src") === expected && img.naturalWidth > 0;
          },
          Q7_PARENT_MAINPIC,
          { timeout: 20_000 },
        )
        .catch(() => {
          throw new Error(
            `[uiShot] Q7：父卡飞猪外链图未在 20s 内加载成功（naturalWidth=0 或已 onError 降级 PX）——` +
              `拒绝产出误导性截图，中止。期望 src=${Q7_PARENT_MAINPIC}`,
          );
        });
      const parentSrc = await parentBanner.getAttribute("src");
      const parentNatural = await parentBanner.evaluate((el) => (el as HTMLImageElement).naturalWidth);
      if (parentSrc !== Q7_PARENT_MAINPIC) {
        throw new Error(`[uiShot] Q7：父卡 banner img src=${parentSrc} ≠ 飞猪真值 ${Q7_PARENT_MAINPIC}`);
      }
      console.log(`[uiShot] Q7 父卡断言 ✓ .parent-banner img src=${parentSrc}（＝飞猪真值），naturalWidth=${parentNatural}（>0 加载成功，非降级 PX）`);
      await page.screenshot({ path: join(EVIDENCE_DIR, "Q7.png"), fullPage: true });
      await page.setViewportSize({ width: 440, height: 900 });
    }

    if (SCENES.has("e9")) {
      // ---- E9：亚龙湾「页面落位」取证（Task #301：真实 VisitCard 现场 + 11 条 golden 落位对照面板）----
      // 无需 server:8787（父卡/子点位均无外链小图）。渲染源 web/src/eval-ui.tsx sceneE9，
      // 数据源 eval/harness/e9Truth.ts（与截图断言同源，杜绝口径漂移）。
      await page.setViewportSize({ width: E9_VIEWPORT_WIDTH, height: 1600 });
      await page.goto(`${BASE}?scene=e9`, { waitUntil: "networkidle" });
      // 落位对照面板必须渲染（我方可控 data-* 锚点）
      await page.waitForSelector("[data-e9-mapping]", { timeout: 15_000 });
      // 真实父卡 + 9 子点位（StopRow .child）渲染现场
      await page.waitForSelector(".child", { timeout: 15_000 });
      await sleep(400);

      // 断言 1：真实卡 9 子点位全渲染，且 #300 下沉相关子景点（过江龙索桥/玻璃栈道）在列
      const childNames = await page.evaluate(() =>
        [...document.querySelectorAll(".child .child-name")].map((el) => (el.textContent ?? "").trim()),
      );
      if (childNames.length !== E9_SUBSPOTS.length) {
        throw new Error(`[uiShot] E9：子点位数 ${childNames.length} ≠ 真值 ${E9_SUBSPOTS.length}（渲染漂移，截图不可信）`);
      }
      for (const must of ["过江龙索桥", "玻璃栈道"]) {
        if (!childNames.some((n) => n.includes(must))) {
          throw new Error(`[uiShot] E9：子点位缺「${must}」（#300 下沉重点子景点未在页面落位）`);
        }
      }
      console.log(`[uiShot] E9 子点位断言 ✓ ${childNames.length} 个（含 过江龙索桥/玻璃栈道），与真值表逐一相符`);

      // 断言 2：11 条 golden 落位对照行全渲染，且 data-entity/sim 逐条等于真值（内容级锚点）
      const claimRows = await page.evaluate(() =>
        [...document.querySelectorAll("[data-claim-id]")].map((el) => ({
          claimId: el.getAttribute("data-claim-id") ?? "",
          region: el.getAttribute("data-region") ?? "",
          entity: el.getAttribute("data-entity") ?? "",
          sim: (el.querySelector("[data-claim-sim]")?.textContent ?? "").trim(),
        })),
      );
      if (claimRows.length !== E9_CLAIM_MAPPING.length) {
        throw new Error(`[uiShot] E9：落位对照行 ${claimRows.length} ≠ golden ${E9_CLAIM_MAPPING.length} 条`);
      }
      // 面板 DOM 序＝按落位区域分组（E9_REGION_ORDER），非 claimId 升序；期望序须同构构造
      const expectedOrder = E9_REGION_ORDER.flatMap((region) => e9ClaimsByRegion(region));
      claimRows.forEach((row, index) => {
        const truth = expectedOrder[index]!;
        if (row.claimId !== truth.claimId || row.region !== truth.region || row.entity !== truth.matchedEntity) {
          throw new Error(
            `[uiShot] E9：第 ${index + 1} 行落位「${row.claimId}/${row.region}/${row.entity}」≠ 真值「${truth.claimId}/${truth.region}/${truth.matchedEntity}」`,
          );
        }
        if (row.sim !== String(truth.sim)) {
          throw new Error(`[uiShot] E9：${row.claimId} sim=${row.sim} ≠ 真值 ${truth.sim}`);
        }
      });
      console.log(`[uiShot] E9 落位对照断言 ✓ 11 条 claim（entity/region/sim 逐条等于真值表）`);

      // 断言 3：4 个落位区域分组条数与真值一致（父卡时长/父卡攻略提示/子点位详情/子点位贴士区）
      for (const region of E9_REGION_ORDER) {
        const expected = e9ClaimsByRegion(region).length;
        const actual = await page.locator(`[data-e9-region="${region}"] [data-claim-id]`).count();
        if (actual !== expected) {
          throw new Error(`[uiShot] E9：区域「${E9_REGION_LABEL[region]}」条数 ${actual} ≠ 真值 ${expected}`);
        }
        console.log(`[uiShot] E9 区域断言 ✓ ${E9_REGION_LABEL[region]}（${region}）＝${actual} 条`);
      }

      // 断言 4：#300 归属下沉实测 2 条（玻璃栈道/试婚房）＝子点位贴士区，与预测 3 条差异已归因
      const sunk = e9SunkTips();
      if (sunk.length !== E9_RECALL.sunkTipCount) {
        throw new Error(`[uiShot] E9：下沉 note_tip ${sunk.length} ≠ 真值 ${E9_RECALL.sunkTipCount}`);
      }
      console.log(
        `[uiShot] E9 下沉断言 ✓ ${sunk.length} 条下沉子点位贴士区（${sunk.map((t) => t.sunkTo).join("/")}）＋ ` +
          `${E9_RECALL.parentTipCount} 条父卡攻略提示；#300 预测 ${E9_RECALL.predictedSunkCount} 条，差异＝过江龙索桥排队信息被抽取器并入 in_attraction 子景点（无独立 note_tip 可下沉，YLW-06 落子点位详情行 sim=0.471 机器 HIT）`,
      );

      // 断言 5：recall 结论行含 pass（机器 8/11 未达标 → PD 裁量 3 条 boundary → 11/11 达标）
      const recallText = (await page.locator("[data-e9-recall]").textContent()) ?? "";
      if (!recallText.includes("pass")) {
        throw new Error(`[uiShot] E9：recall 结论行未含 pass（实际「${recallText.trim().slice(0, 60)}」）`);
      }
      console.log(`[uiShot] E9 recall 断言 ✓ 机器 ${E9_RECALL.machineHits}/${E9_RECALL.total}=${E9_RECALL.machineRecall} → PD 裁量 ${E9_RECALL.pdAdjudicatedCount} 条（${E9_RECALL.pdAdjudicatedIds.join("/")}）→ ${E9_RECALL.finalRecall} pass`);

      await page.screenshot({ path: join(EVIDENCE_DIR, "E9-page-mapping.png"), fullPage: true });
      console.log(`[uiShot] E9 截图完成 → ${join(EVIDENCE_DIR, "E9-page-mapping.png")}（视口 ${E9_VIEWPORT_WIDTH}px，整页）`);
      await page.setViewportSize({ width: 440, height: 900 });
    }

    console.log(`[uiShot] 截图完成 → ${EVIDENCE_DIR}/{${shotNames()}}.png`);
  } finally {
    await browser?.close();
    vite.kill("SIGTERM");
    server?.kill("SIGTERM");
    await sleep(300);
    if (vite.exitCode === null) vite.kill("SIGKILL");
    if (server !== null && server.exitCode === null) server.kill("SIGKILL");
  }
}

void main().catch((error) => {
  console.error("[uiShot] 失败：", error);
  process.exit(1);
});
