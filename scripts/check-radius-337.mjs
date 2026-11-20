/**
 * Task #337 审计脚本（只读取证）：逐层列出大景区父卡 / 普通景点卡 / 酒店卡
 * 每一层的计算 border-radius 与 overflow，并对「卡内图片」角部做放大截图。
 * 用法：node scripts/check-radius-337.mjs <before|after>
 * 截图输出 /tmp/task337-<tag>-*.png，审计表输出 stdout + /tmp/task337-audit-<tag>.json
 */
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const tag = process.argv[2] ?? "before";
const URL = "http://localhost:5173/?tripId=0a27f726-9c93-48e8-ab68-1d62e9bc685b";

const SELECTORS = [
  ".parent-item",
  ".parent-item > .grip",
  ".parent-card",
  ".parent-banner",
  ".parent-banner img",
  ".parent-top",
  ".item:not(.parent-item)",
  ".item:not(.parent-item) > .grip",
  ".thumb",
  ".thumb-frame",
  ".thumb-frame img",
  ".thumb > .ph-tile",
  ".ibody",
  ".child-pic",
  ".child-pic img",
  ".hotelcard",
  ".hotelphoto",
  ".hotelphoto img",
];

const cornerShots = async (page, viewport, vtag) => {
  // 父卡 banner 左上角
  const pc = page.locator(".parent-card").first();
  if ((await pc.count()) > 0) {
    const b = await pc.boundingBox();
    if (b) {
      await page.screenshot({
        path: `/tmp/task337-${tag}-${vtag}-parent-corner.png`,
        clip: { x: Math.max(0, b.x - 4), y: Math.max(0, b.y - 4), width: 56, height: 56 },
      });
    }
  }
  // 普通卡缩略图窗口左上角
  const tf = page.locator(".thumb-frame").first();
  if ((await tf.count()) > 0) {
    await tf.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const b = await tf.boundingBox();
    if (b) {
      await page.screenshot({
        path: `/tmp/task337-${tag}-${vtag}-normal-corner.png`,
        clip: { x: Math.max(0, b.x - 4), y: Math.max(0, b.y - 4), width: 56, height: 56 },
      });
    }
  }
};

const run = async (viewport, vtag) => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport, deviceScaleFactor: 3 });
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".dchip", { timeout: 30000 });
  const chips = page.locator(".dchip");
  const n = await chips.count();
  const table = {};
  for (let i = 0; i < n; i++) {
    await chips.nth(i).click();
    await page.waitForTimeout(700);
    const dayAudit = await page.evaluate((sels) => {
      window.__SELECTORS__ = sels;
      const out = {};
      for (const sel of window.__SELECTORS__) {
        const el = document.querySelector(sel);
        if (!el) {
          out[sel] = null;
          continue;
        }
        const cs = getComputedStyle(el);
        out[sel] = { borderRadius: cs.borderRadius, overflow: cs.overflow };
      }
      return out;
    }, SELECTORS);
    table[`Day${i + 1}`] = dayAudit;
    if (vtag === "desktop" && i === 1) {
      // Day2：父卡（天涯海角）+ 普通卡（天涯小镇）同屏，截角部
      await cornerShots(page, viewport, vtag);
    }
    if (vtag === "mobile" && i === 0) {
      // Day1：椰梦长廊普通卡（PD 截图对象）
      await cornerShots(page, viewport, vtag);
    }
  }
  await browser.close();
  return table;
};

const desktop = await run({ width: 1280, height: 900 }, "desktop");
await run({ width: 390, height: 844 }, "mobile");

writeFileSync(`/tmp/task337-audit-${tag}.json`, JSON.stringify(desktop, null, 2));
// 控制台输出压缩表：selector → 各 Day 的 radius（overflow 仅列关键层）
const rows = {};
for (const sel of SELECTORS) {
  rows[sel] = {};
  for (const [day, data] of Object.entries(desktop)) {
    rows[sel][day] = data[sel] ? `${data[sel].borderRadius}/${data[sel].overflow}` : "-";
  }
}
console.log(`===== audit ${tag} (desktop, radius/overflow) =====`);
console.log(JSON.stringify(rows, null, 1));
