/**
 * Task #347 取证：普通景点卡 thumb 区内缩（PD：照片贴边似溢出）。
 * 实测两变体外缘内距（计算样式/几何）+ 双视口整卡与左缘特写截图。
 * 变体 A：有图普通卡（亚龙湾海滩 .thumb-frame）；变体 B：无图占位（太阳湾公路 .child-pic>.ph-tile，
 * demo 数据中其为 Day3 父卡内部玩法 stop；普通卡无图变体 .thumb>.ph-tile 与 A 同槽同盒）。
 * 用法：node scripts/check-task347.mjs
 */
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const URL = "http://localhost:5173/?tripId=0a27f726-9c93-48e8-ab68-1d62e9bc685b";

const probe = () => {
  const r = (el) => {
    const b = el.getBoundingClientRect();
    return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) };
  };
  const out = { photo: null, ph: null, banner: null };
  for (const item of document.querySelectorAll(".daycontent .item:not(.parent-item)")) {
    const nm = item.querySelector(".nm .t")?.textContent?.trim() ?? "";
    if (nm !== "亚龙湾海滩") continue;
    const frame = item.querySelector(".thumb-frame");
    const thumb = item.querySelector(".thumb");
    const ir = item.getBoundingClientRect();
    const fr = frame.getBoundingClientRect();
    out.photo = {
      nm,
      thumbPadding: getComputedStyle(thumb).padding,
      gridCols: getComputedStyle(item).gridTemplateColumns,
      win: r(frame),
      inset: {
        left: +(fr.x - ir.x - 1).toFixed(1),
        top: +(fr.y - ir.y - 1).toFixed(1),
        bottom: +(ir.y + ir.height - 1 - fr.y - fr.height).toFixed(1),
      },
      item: r(item),
    };
  }
  for (const pic of document.querySelectorAll(".daycontent .child-pic")) {
    if (!pic.querySelector(".ph-tile")) continue;
    const child = pic.closest(".child");
    const nm = child?.querySelector(".child-name")?.textContent?.trim() ?? "";
    if (nm !== "太阳湾公路") continue;
    const pitem = pic.closest(".parent-item");
    const pr = pic.getBoundingClientRect();
    const cr = child.getBoundingClientRect();
    const pir = pitem.getBoundingClientRect();
    out.ph = {
      nm,
      win: r(pic),
      insetFromCard: { left: +(pr.x - pir.x - 1).toFixed(1) },
      insetFromRow: {
        top: +(pr.y - cr.y).toFixed(1),
        bottom: +(cr.y + cr.height - pr.y - pr.height).toFixed(1),
      },
      parentItem: r(pitem),
      row: r(child),
    };
  }
  const pitem = document.querySelector(".daycontent .parent-item");
  const banner = pitem?.querySelector(".parent-banner");
  if (pitem && banner) {
    out.banner = { insetLeft: +(banner.getBoundingClientRect().x - pitem.getBoundingClientRect().x - 1).toFixed(1) };
  }
  return out;
};

const shoot = async (page, vtag, viewport) => {
  // 整卡：亚龙湾海滩 row（locator.screenshot 自动滚入视口）
  const rowLoc = page.locator(".daycontent .row", { hasText: "亚龙湾海滩" }).first();
  await rowLoc.screenshot({ path: `/tmp/task347-${vtag}-photo-card.png` });
  const pb = await rowLoc.boundingBox();
  if (pb) {
    const y = Math.min(Math.max(pb.y, 0), viewport.height - 120);
    await page.screenshot({
      path: `/tmp/task347-${vtag}-photo-leftedge.png`,
      clip: { x: Math.max(0, pb.x - 6), y, width: 72, height: Math.min(140, viewport.height - y) },
    });
  }
  // 无图 stop 行（太阳湾公路 .child）
  const childLoc = page.locator(".daycontent .child", { hasText: "太阳湾公路" }).first();
  await childLoc.screenshot({ path: `/tmp/task347-${vtag}-ph-row.png` });
  const cb = await childLoc.boundingBox();
  const pitemLoc = page.locator(".daycontent .parent-item").first();
  const pib = await pitemLoc.boundingBox();
  if (cb && pib) {
    const y = Math.min(Math.max(cb.y, 0), viewport.height - 80);
    await page.screenshot({
      path: `/tmp/task347-${vtag}-ph-leftedge.png`,
      clip: { x: Math.max(0, pib.x - 6), y, width: 72, height: Math.min(90, viewport.height - y) },
    });
  }
  // 组合左缘特写：重新滚到 tile 与照片窗同屏后再测坐标（元素截图会改滚动位）
  await page.evaluate(() => {
    const pic = [...document.querySelectorAll(".daycontent .child-pic")].find((p) =>
      p.closest(".child")?.querySelector(".child-name")?.textContent?.includes("太阳湾公路"),
    );
    pic?.scrollIntoView({ block: "start" });
    pic?.closest(".screen")?.scrollBy?.(0, -60);
  });
  await page.waitForTimeout(400);
  const data = await page.evaluate(probe);
  if (data.photo && data.ph && pib) {
    const top = data.ph.win.y - 10;
    const bottom = data.photo.win.y + data.photo.win.h + 10;
    if (top >= 0 && bottom <= viewport.height && bottom - top > 120) {
      await page.screenshot({
        path: `/tmp/task347-${vtag}-leftedge-combo.png`,
        clip: { x: Math.max(0, pib.x - 6), y: top, width: 72, height: bottom - top },
      });
    }
  }
  return data;
};

const run = async (viewport, vtag) => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport, deviceScaleFactor: 3 });
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".dchip", { timeout: 30000 });
  await page.locator(".dchip").nth(2).click(); // Day3
  await page.waitForTimeout(900);
  const data = await shoot(page, vtag, viewport);
  await browser.close();
  return data;
};

const desktop = await run({ width: 1280, height: 900 }, "desktop");
const mobile = await run({ width: 390, height: 844 }, "mobile");
writeFileSync("/tmp/task347-audit.json", JSON.stringify({ desktop, mobile }, null, 2));
console.log("===== task347 after =====");
console.log(JSON.stringify({ desktop, mobile }, null, 1));
