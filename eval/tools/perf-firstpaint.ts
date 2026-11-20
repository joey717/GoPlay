/**
 * Task #277: 页面首屏可交互耗时测量（Playwright）
 * 量 http://localhost:5173 的 goto → 首屏可交互（networkidle + 首个可点击元素可见）
 * 3 次取中位
 */
import { chromium } from "playwright";

const URL = "http://localhost:5173";
const RUNS = 3;

async function measureOnce(browser: any): Promise<number> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const start = Date.now();
  await page.goto(URL, { waitUntil: "networkidle", timeout: 30000 });
  // 等待首个可交互元素（行程页的创建按钮或已有行程卡片）
  await page.waitForSelector('button, [role="button"], a[href]', { timeout: 10000 }).catch(() => {});
  const elapsed = Date.now() - start;
  await context.close();
  return elapsed;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const results: number[] = [];

  console.log(`=== 首屏可交互耗时测量（${RUNS} 次） ===`);
  console.log(`URL: ${URL}`);
  console.log("");

  for (let i = 0; i < RUNS; i++) {
    const ms = await measureOnce(browser);
    results.push(ms);
    console.log(`[${i + 1}] ${(ms / 1000).toFixed(2)}s`);
    // 间隔 2s 避免缓存干扰
    if (i < RUNS - 1) await new Promise((r) => setTimeout(r, 2000));
  }

  await browser.close();

  results.sort((a, b) => a - b);
  const median = results[Math.floor(results.length / 2)];
  console.log("");
  console.log(`--- 统计 ---`);
  console.log(`中位: ${(median / 1000).toFixed(2)}s`);
  console.log(`最快: ${(results[0] / 1000).toFixed(2)}s`);
  console.log(`最慢: ${(results[results.length - 1] / 1000).toFixed(2)}s`);
  console.log(`全部: ${results.map((r) => (r / 1000).toFixed(2) + "s").join(", ")}`);
}

main().catch((err) => {
  console.error("Playwright measurement failed:", err);
  process.exit(1);
});
