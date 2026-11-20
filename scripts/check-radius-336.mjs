/**
 * Task #336 一次性校验脚本：对比大景区父卡与普通景点卡的 border-radius 计算样式。
 * 用法：node scripts/check-radius-336.mjs
 * 只读校验，不改动任何数据；输出桌面 / 390x844 两种视口下的证据并截图到 /tmp。
 */
import { chromium } from "playwright";

const URL = "http://localhost:5173/?tripId=0a27f726-9c93-48e8-ab68-1d62e9bc685b";

const probe = () => {
  const pick = (el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      cls: el.className,
      borderRadius: cs.borderRadius,
      overflow: cs.overflow,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    };
  };
  const parentCards = [...document.querySelectorAll(".parent-card")];
  const target = parentCards.find((el) => el.textContent.includes("天涯海角")) ?? parentCards[0];
  const parentItem = target ? target.closest(".parent-item") : null;
  const normals = [...document.querySelectorAll('.item:not(.parent-item)')];
  const normal = normals.find((el) => el.textContent.includes("天涯小镇")) ?? normals[0];
  const banner = target ? target.querySelector(".parent-banner") : null;
  const bannerImg = banner ? banner.querySelector("img") : null;
  const rr = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  return {
    foundParent: target ? target.textContent.includes("天涯海角") : false,
    foundNormal: normal ? normal.textContent.includes("天涯小镇") : false,
    parentItem: parentItem ? pick(parentItem) : null,
    parentCard: target ? pick(target) : null,
    normalItem: normal ? pick(normal) : null,
    banner: banner ? pick(banner) : null,
    bannerImgRect: bannerImg ? rr(bannerImg) : null,
    hOverflow: document.documentElement.scrollWidth > window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  };
};

const run = async (viewport, tag) => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport });
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".dchip", { timeout: 30000 });
  // 目标卡在 Day2：先切标签再测量
  await page.locator(".dchip", { hasText: "Day2" }).first().click();
  await page.waitForSelector(".parent-card", { timeout: 30000 });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const t = [...document.querySelectorAll(".parent-card")].find((el) =>
      el.textContent.includes("天涯海角"),
    );
    t?.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(600);
  const data = await page.evaluate(probe);
  console.log(`===== ${tag} (${viewport.width}x${viewport.height}) =====`);
  console.log(JSON.stringify(data, null, 2));
  await page
    .locator(".parent-item", { hasText: "天涯海角" })
    .first()
    .screenshot({ path: `/tmp/task336-${tag}-parent.png` });
  await page
    .locator('.item:not(.parent-item)', { hasText: "天涯小镇" })
    .first()
    .screenshot({ path: `/tmp/task336-${tag}-normal.png` });
  await page.screenshot({ path: `/tmp/task336-${tag}.png` });
  await browser.close();
};

await run({ width: 1280, height: 900 }, "desktop");
await run({ width: 390, height: 844 }, "mobile");
