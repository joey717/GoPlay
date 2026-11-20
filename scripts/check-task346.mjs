/**
 * Task #346 取证脚本（只读 + 拖拽回归）：
 * 1) 父卡/普通卡两变体整卡 + 左缘特写 3x 截图（before/after 对比：无把手列、内容全宽）；
 * 2) 计算样式审计（.grip 是否仍存在、普通卡栅格列、banner/thumb 左内缩、clay tag 文案、键盘把手）；
 * 3) after 模式附加：整卡拖拽面回归（Day2 西岛↔天涯小镇 互换再换回，鼠标走卡片表面而非把手）。
 * 用法：node scripts/check-task346.mjs <before|after>
 */
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const tag = process.argv[2] ?? "before";
const URL = "http://localhost:5173/?tripId=0a27f726-9c93-48e8-ab68-1d62e9bc685b";

const TARGETS = [
  { day: 2, variant: "parent", text: "天涯海角" },
  { day: 2, variant: "normal", text: "天涯小镇" },
  { day: 3, variant: "parent", text: "亚龙湾" },
  { day: 3, variant: "normal", text: "亚龙湾" },
];

const auditProbe = () => {
  const cs = (el) => getComputedStyle(el);
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const parentItem = document.querySelector(".parent-item");
  const parentCard = document.querySelector(".parent-card");
  const banner = document.querySelector(".parent-banner");
  const normal = [...document.querySelectorAll(".item:not(.parent-item)")][0] ?? null;
  const thumb = normal ? normal.querySelector(":scope > .thumb") : null;
  const kbd = document.querySelector(".row .drag-kbd");
  return {
    gripInRows: document.querySelectorAll(".row .grip, .hotelcard .grip").length,
    parentItem: parentItem
      ? { rect: rect(parentItem), display: cs(parentItem).display, backgroundColor: cs(parentItem).backgroundColor }
      : null,
    parentCard: parentCard ? { rect: rect(parentCard) } : null,
    banner: banner ? { rect: rect(banner), borderRadius: cs(banner).borderRadius } : null,
    bannerInsetLeft:
      banner && parentCard
        ? Math.round(banner.getBoundingClientRect().x - parentCard.getBoundingClientRect().x)
        : null,
    normalItem: normal
      ? { rect: rect(normal), gridTemplateColumns: cs(normal).gridTemplateColumns, gridTemplateAreas: cs(normal).gridTemplateAreas }
      : null,
    thumb: thumb ? { rect: rect(thumb) } : null,
    thumbInsetLeft: thumb && normal ? Math.round(thumb.getBoundingClientRect().x - normal.getBoundingClientRect().x) : null,
    clayTag: document.querySelector(".parent-tags .tag.clay")?.textContent ?? null,
    dragKbd: kbd ? { ariaLabel: kbd.getAttribute("aria-label"), tabIndex: kbd.tabIndex } : null,
    hOverflow: document.documentElement.scrollWidth > window.innerWidth,
  };
};

const shootTarget = async (page, t, vtag, viewport) => {
  const sel = t.variant === "parent" ? ".parent-item" : '.item:not(.parent-item)';
  const loc = page.locator(sel, { hasText: t.text }).first();
  if ((await loc.count()) === 0) return;
  await loc.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(400);
  const name = `d${t.day}-${t.variant}`;
  await loc.screenshot({ path: `/tmp/task346-${tag}-${vtag}-${name}-card.png` });
  // 左缘特写：卡左 64px 宽条（clamp 到视口内），证明无把手列/无浅灰 ≡
  const b = await loc.boundingBox();
  if (b) {
    const y = Math.min(Math.max(b.y, 0), viewport.height - 120);
    await page.screenshot({
      path: `/tmp/task346-${tag}-${vtag}-${name}-leftedge.png`,
      clip: { x: Math.max(0, b.x - 4), y, width: 64, height: Math.min(120, viewport.height - y) },
    });
  }
};

const dragRegression = async (page) => {
  const order = async () =>
    page.evaluate(() =>
      [...document.querySelectorAll(".daycontent .row")].map((r) => {
        const p = r.querySelector(".parent-name");
        const n = r.querySelector(".nm .t");
        return (p ?? n)?.textContent?.trim() ?? "?";
      }),
    );
  // 粘性 dchip 栏底部约 y=280，坐标必须低于此值才能命中卡片
  const STICKY_BOTTOM = 290;
  // 整卡拖拽面：mousedown 落在卡片表面（缩略图/空白区），守卫会排除 button/a 等交互元素
  const dragBy = async (nameText, toText) => {
    const from = page.locator(".row", { hasText: nameText }).first();
    await from.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(400);
    const fb = await from.boundingBox();
    // 保证 fy 在粘性栏下方且在行范围内
    const fy = Math.min(Math.max(fb.y + 20, STICKY_BOTTOM + 10), fb.y + fb.height - 10);
    const fx = fb.x + 60; // 缩略图区域，避开右侧按钮/链接
    await page.mouse.move(fx, fy);
    await page.mouse.down();
    // 分两步越过 8px 激活阈值，每步间留待传感器响应
    await page.mouse.move(fx, fy + 12, { steps: 3 });
    await page.waitForTimeout(80);
    await page.mouse.move(fx, fy + 25, { steps: 3 });
    await page.waitForTimeout(200);
    // dnd-kit sortable 拖拽中实时回流：迭代重测目标行中心再逼近（同 #341）
    // 父卡行可达 800px，回流震荡剧烈，5 次迭代确保落点稳定
    for (let i = 0; i < 5; i++) {
      const tb = await page.locator(".row", { hasText: toText }).first().boundingBox();
      // 目标行中心（必须到真实中心才触发 sortable 碰撞检测）
      const ty = Math.min(Math.max(tb.y + tb.height / 2, STICKY_BOTTOM + 10), 820);
      await page.mouse.move(tb.x + tb.width / 2, ty, { steps: 8 });
      await page.waitForTimeout(300);
    }
    await page.mouse.up();
    await page.waitForTimeout(2500); // 等待持久化写入
  };
  const dragUntil = async (fromText, toText, expectOrder) => {
    for (let i = 0; i < 3; i++) {
      await dragBy(fromText, toText);
      const cur = await order();
      if (JSON.stringify(cur) === JSON.stringify(expectOrder)) return cur;
    }
    return order();
  };
  const before = await order();
  const expectSwapped = [...before];
  const ia = expectSwapped.indexOf("西岛");
  const ib = expectSwapped.indexOf("天涯小镇");
  [expectSwapped[ia], expectSwapped[ib]] = [expectSwapped[ib], expectSwapped[ia]];
  const swapped = await dragUntil("西岛", "天涯小镇", expectSwapped);
  const restored = await dragUntil("天涯小镇", "西岛", before);
  return {
    before,
    swapped,
    restored,
    ok: JSON.stringify(before) === JSON.stringify(restored) && JSON.stringify(before) !== JSON.stringify(swapped),
  };
};

const run = async (viewport, vtag) => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport, deviceScaleFactor: 3 });
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".dchip", { timeout: 30000 });
  const audits = {};
  for (const t of TARGETS) {
    await page.locator(".dchip").nth(t.day - 1).click();
    await page.waitForTimeout(700);
    audits[`d${t.day}-${t.variant}`] = await page.evaluate(auditProbe);
    await shootTarget(page, t, vtag, viewport);
  }
  let drag = null;
  if (tag === "after" && vtag === "desktop") {
    await page.locator(".dchip").nth(1).click();
    await page.waitForTimeout(700);
    drag = await dragRegression(page);
  }
  await browser.close();
  return { audits, drag };
};

const desktop = await run({ width: 1280, height: 900 }, "desktop");
const mobile = await run({ width: 390, height: 844 }, "mobile");

writeFileSync(
  `/tmp/task346-audit-${tag}.json`,
  JSON.stringify({ desktop: desktop.audits, mobile: mobile.audits, drag: desktop.drag }, null, 2),
);
console.log(`===== task346 ${tag} =====`);
console.log(JSON.stringify(desktop.audits, null, 1));
if (desktop.drag) console.log("DRAG:", JSON.stringify(desktop.drag));
