/**
 * Task #341 取证脚本（只读 + 拖拽回归）：
 * 1) 父卡/普通卡两变体的左缘 + 整卡 3x 截图（before/after 对比）；
 * 2) 计算样式审计（把手条背景/边框、左列背景、banner margin/radius、缩略图 margin/radius）；
 * 3) after 模式附加：拖拽排序回归（Day2 两点位互换再换回）+ 备选分隔线方案截图（addStyleTag 注入，不落代码）。
 * 用法：node scripts/check-task341.mjs <before|after>
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
  const gripP = parentItem ? parentItem.querySelector(":scope > .grip") : null;
  const normal = [...document.querySelectorAll('.item:not(.parent-item)')][0] ?? null;
  const gripN = normal ? normal.querySelector(":scope > .grip") : null;
  const thumb = normal ? normal.querySelector(":scope > .thumb") : null;
  const frame = normal ? normal.querySelector(":scope > .thumb-frame") : null;
  const pack = (el, keys) => {
    if (!el) return null;
    const s = cs(el);
    const o = { rect: rect(el) };
    for (const k of keys) o[k] = s[k];
    return o;
  };
  return {
    parentItem: pack(parentItem, ["backgroundColor", "borderTopWidth", "borderRadius", "overflow"]),
    gripParent: pack(gripP, ["backgroundColor", "borderRightWidth", "borderRightColor"]),
    parentCard: pack(parentCard, ["borderTopWidth", "borderRadius", "overflow", "backgroundColor"]),
    banner: pack(banner, ["marginTop", "marginLeft", "borderRadius", "overflow"]),
    bannerInset:
      banner && parentCard
        ? {
            left: Math.round(banner.getBoundingClientRect().x - parentCard.getBoundingClientRect().x),
            top: Math.round(banner.getBoundingClientRect().y - parentCard.getBoundingClientRect().y),
          }
        : null,
    normalItem: pack(normal, ["backgroundColor", "borderTopWidth", "borderRadius"]),
    gripNormal: pack(gripN, ["backgroundColor", "borderRightWidth"]),
    thumb: pack(thumb, ["backgroundColor"]),
    thumbFrame: pack(frame, ["borderRadius"]),
    frameInset:
      frame && thumb
        ? {
            left: Math.round(frame.getBoundingClientRect().x - thumb.getBoundingClientRect().x),
            top: Math.round(frame.getBoundingClientRect().y - thumb.getBoundingClientRect().y),
          }
        : null,
    gripSpan: (() => {
      const sp = document.querySelector(".grip span");
      return sp ? { backgroundColor: cs(sp).backgroundColor } : null;
    })(),
    hOverflow: document.documentElement.scrollWidth > window.innerWidth,
  };
};

const shootTarget = async (page, t, vtag) => {
  const sel = t.variant === "parent" ? ".parent-item" : '.item:not(.parent-item)';
  const loc = page.locator(sel, { hasText: t.text }).first();
  if ((await loc.count()) === 0) return;
  await loc.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(400);
  const name = `d${t.day}-${t.variant}`;
  await loc.screenshot({ path: `/tmp/task341-${tag}-${vtag}-${name}-card.png` });
  // 左缘取证：把手列元素截图（3x），避免 clip 越界问题
  const grip = loc.locator(":scope > .grip");
  if ((await grip.count()) > 0) {
    await grip.screenshot({ path: `/tmp/task341-${tag}-${vtag}-${name}-leftedge.png` });
  }
};

const reserveCheck = async (page) => {
  await page.locator(".dchip").nth(2).click();
  await page.waitForTimeout(700);
  const parent = page.locator(".parent-item", { hasText: "亚龙湾" }).first();
  const toggle = parent.locator(".reserve-toggle").first();
  if ((await toggle.count()) === 0) return { found: false };
  await toggle.click();
  await page.waitForTimeout(400);
  const meta = await parent.locator(".reserve-meta").allTextContents();
  return { found: true, meta, hasSuggest: meta.some((t) => t.includes("建议")) };
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
  const dragBy = async (nameText, toText) => {
    const from = page.locator(".row", { hasText: nameText }).first();
    await from.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(300);
    const grip = from.locator(".grip");
    const gb = await grip.boundingBox();
    // 把手列贯穿整行：取视口内可见点（父卡 700+px 高时中心可能在视口外）
    const gy = Math.min(Math.max(gb.y + gb.height / 2, 80), 820);
    const to = page.locator(".row", { hasText: toText }).first();
    const tb = await to.boundingBox();
    const ty = Math.min(Math.max(tb.y + tb.height / 2, 80), 820);
    await page.mouse.move(gb.x + gb.width / 2, gy);
    await page.mouse.down();
    // 先移动 20px 越过 PointerSensor 的 8px 激活阈值
    await page.mouse.move(gb.x + gb.width / 2, gy + 20, { steps: 4 });
    // dnd-kit sortable 拖拽中实时回流：迭代重测目标行中心再逼近，避免落点偏移
    for (let i = 0; i < 3; i++) {
      const tb2 = await page.locator(".row", { hasText: toText }).first().boundingBox();
      const ty2 = Math.min(Math.max(tb2.y + tb2.height / 2, 80), 820);
      await page.mouse.move(tb2.x + tb2.width / 2, ty2, { steps: 8 });
      await page.waitForTimeout(200);
    }
    await page.mouse.up();
    await page.waitForTimeout(700);
  };
  // dnd 回流有偶发落空：每次拖拽后校验顺序，未生效则重试（最多 3 次）
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
  return { before, swapped, restored, ok: JSON.stringify(before) === JSON.stringify(restored) && JSON.stringify(before) !== JSON.stringify(swapped) };
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
    await shootTarget(page, t, vtag);
  }
  let drag = null;
  let reserve = null;
  if (tag === "after" && vtag === "desktop") {
    reserve = await reserveCheck(page);
    await page.locator(".dchip").nth(1).click();
    await page.waitForTimeout(700);
    drag = await dragRegression(page);
    // 备选方案：把手列右侧极浅分隔线（仅截图注入，不进代码）
    await page.addStyleTag({
      content: `.item > .grip { border-right: 1px solid color-mix(in srgb, var(--line) 55%, transparent) !important; }`,
    });
    await page.waitForTimeout(300);
    for (const t of TARGETS.filter((x) => x.day === 2)) {
      await shootTarget(page, t, `${vtag}-altline`);
    }
  }
  await browser.close();
  return { audits, drag, reserve };
};

const desktop = await run({ width: 1280, height: 900 }, "desktop");
const mobile = await run({ width: 390, height: 844 }, "mobile");

writeFileSync(`/tmp/task341-audit-${tag}.json`, JSON.stringify({ desktop: desktop.audits, mobile: mobile.audits, drag: desktop.drag, reserve: desktop.reserve }, null, 2));
console.log(`===== task341 ${tag} =====`);
console.log(JSON.stringify(desktop.audits, null, 1));
if (desktop.reserve) console.log("RESERVE:", JSON.stringify(desktop.reserve));
if (desktop.drag) console.log("DRAG:", JSON.stringify(desktop.drag));
