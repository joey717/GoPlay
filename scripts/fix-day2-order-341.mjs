/**
 * Task #341 一次性数据恢复脚本：把 Day2 顺序恢复为 PD 视角原序
 * [西岛, 天涯小镇, 天涯海角]（此前拖拽回归调试曾改动真实顺序）。
 * 做法：把天涯海角逐位右移到 index 2（拖拽即产品自身能力，不走服务端直改）。
 * 用法：node scripts/fix-day2-order-341.mjs
 */
import { chromium } from "playwright";

const URL = "http://localhost:5173/?tripId=0a27f726-9c93-48e8-ab68-1d62e9bc685b";
const CANON = ["西岛", "天涯小镇", "天涯海角"];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".dchip", { timeout: 30000 });
await page.locator(".dchip").nth(1).click();
await page.waitForTimeout(800);

const order = async () =>
  page.evaluate(() =>
    [...document.querySelectorAll(".daycontent .row")].map((r) => {
      const p = r.querySelector(".parent-name");
      const n = r.querySelector(".nm .t");
      return (p ?? n)?.textContent?.trim() ?? "?";
    }),
  );

const dragTo = async (fromText, toText) => {
  const from = page.locator(".row", { hasText: fromText }).first();
  await from.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(300);
  const gb = await from.locator(".grip").boundingBox();
  const gy = Math.min(Math.max(gb.y + gb.height / 2, 80), 820);
  await page.mouse.move(gb.x + gb.width / 2, gy);
  await page.mouse.down();
  await page.mouse.move(gb.x + gb.width / 2, gy + 20, { steps: 4 });
  for (let i = 0; i < 3; i++) {
    const tb = await page.locator(".row", { hasText: toText }).first().boundingBox();
    const ty = Math.min(Math.max(tb.y + tb.height / 2, 80), 820);
    await page.mouse.move(tb.x + tb.width / 2, ty, { steps: 8 });
    await page.waitForTimeout(200);
  }
  await page.mouse.up();
  await page.waitForTimeout(700);
};

for (let attempt = 0; attempt < 4; attempt++) {
  const cur = await order();
  console.log("current:", JSON.stringify(cur));
  if (JSON.stringify(cur) === JSON.stringify(CANON)) break;
  const idx = cur.indexOf("天涯海角");
  if (idx === -1 || idx === 2) {
    console.log("unexpected order, abort");
    break;
  }
  await dragTo("天涯海角", cur[idx + 1]);
}
console.log("final:", JSON.stringify(await order()));
await browser.close();
