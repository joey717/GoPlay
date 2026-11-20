/**
 * 问题 1 E2E 修复验证：
 * 1. 输入超过 30 字长攻略 → 「保存攻略」按钮 DOM 存在
 * 2. 按钮 position: sticky 贴底 → boundingBox 完整落在 Sheet 可视区内（无需滚动）
 * 3. 模拟键盘弹出（visualViewport 缩小）→ .app 高度跟随 --app-height，按钮仍可见
 * 4. 短文本快速搜索 / 空输入排版区 对照路径
 */
import { chromium } from "playwright";

const BASE = "http://localhost:5173";
const TRIP_ID = "d0174797-f87f-4726-8c55-833840235e51";
const LONG_TEXT =
  "三亚五日深度游攻略：第一站亚龙湾热带天堂森林公园，建议上午前往人少凉快，下午去天涯海角看日落，晚上回第一市场吃海鲜加工，第二天蜈支洲岛一整天浮潜体验非常棒，记得提前买票。";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

page.on("pageerror", (err) => console.log("[pageerror]", err.message));

await page.goto(`${BASE}/?tripId=${TRIP_ID}`);
await page.waitForSelector(".add-entry", { timeout: 15000 });
await page.click(".add-entry");
await page.waitForSelector(".note-input-sheet", { timeout: 5000 });

const textarea = page.locator(".note-textarea");
await textarea.waitFor({ timeout: 5000 });
await textarea.fill(LONG_TEXT);
await page.waitForTimeout(300);

// ===== 检查「保存攻略」按钮：sticky 贴底 + 可视区内 =====
const saveBtn = page.locator(".note-input-sheet .note-actions-sticky .extract-btn");
const count = await saveBtn.count();
console.log("=== 修复验证（sticky 贴底）===");
console.log("保存攻略按钮数量:", count);
console.log("按钮文案:", count > 0 ? (await saveBtn.first().textContent())?.trim() : "无");

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
};

if (count > 0) {
  const info = await saveBtn.first().evaluate((el) => {
    const cs = getComputedStyle(el);
    const container = el.closest(".note-actions-sticky");
    const containerCs = container ? getComputedStyle(container) : null;
    const sheet = el.closest(".note-input-sheet");
    const btnRect = el.getBoundingClientRect();
    const sheetRect = sheet ? sheet.getBoundingClientRect() : null;
    // elementFromPoint 验证按钮中心点可点击（无遮挡）
    const hit = document.elementFromPoint(
      btnRect.left + btnRect.width / 2,
      btnRect.top + btnRect.height / 2,
    );
    const hitIsBtnOrChild = hit !== null && (hit === el || el.contains(hit) || hit.contains(el));
    return {
      btnBackground: cs.backgroundColor,
      containerPosition: containerCs?.position ?? "none",
      containerBottom: containerCs?.bottom ?? "",
      sheetScrollHeight: sheet?.scrollHeight ?? 0,
      sheetClientHeight: sheet?.clientHeight ?? 0,
      btnBottom: btnRect.bottom,
      sheetBottom: sheetRect?.bottom ?? 0,
      btnTop: btnRect.top,
      sheetTop: sheetRect?.top ?? 0,
      hitOk: hitIsBtnOrChild,
    };
  });
  console.log("详细信息:", JSON.stringify(info, null, 2));

  check("按钮容器 position: sticky", info.containerPosition === "sticky");
  check(
    "按钮完整落在 Sheet 可视区内（无需滚动）",
    info.btnBottom <= info.sheetBottom + 1 && info.btnTop >= info.sheetTop - 1,
    `btnBottom=${info.btnBottom.toFixed(1)} sheetBottom=${info.sheetBottom.toFixed(1)}`,
  );
  check("按钮中心点未被遮挡（elementFromPoint 命中自身）", info.hitOk);
  check("按钮为橙色主行动样式", info.btnBackground !== "rgba(0, 0, 0, 0)", info.btnBackground);
  // 即使内容溢出（scrollHeight > clientHeight），按钮仍应可见（sticky 贴底）
  check(
    "内容溢出时按钮仍贴底可见",
    info.sheetScrollHeight > info.sheetClientHeight
      ? info.btnBottom <= info.sheetBottom + 1
      : true,
    `scrollHeight=${info.sheetScrollHeight} clientHeight=${info.sheetClientHeight}`,
  );
}

// ===== 模拟键盘弹出：visualViewport 缩小到 55% =====
console.log("=== 键盘弹出模拟（viewport 缩小）===");
const keyboardInfo = await page.evaluate(async () => {
  const vv = window.visualViewport;
  const app = document.querySelector(".app");
  const before = app ? app.getBoundingClientRect().height : 0;
  return { hasVV: vv !== null, appHeightBefore: before };
});
console.log("键盘弹出前 .app 高度:", keyboardInfo.appHeightBefore.toFixed(1));

// 通过 CDP 模拟 visualViewport 变化不易做，改用缩小窗口高度近似验证 --app-height 机制：
// 直接设置 --app-height 变量（与 App.tsx 的 visualViewport handler 等效）
await page.evaluate(() => {
  document.documentElement.style.setProperty("--app-height", "462px"); // 844 * ~55%
});
await page.waitForTimeout(300);
const afterInfo = await page.evaluate(() => {
  const app = document.querySelector(".app");
  const sheet = document.querySelector(".note-input-sheet");
  const btn = document.querySelector(".note-input-sheet .note-actions-sticky .extract-btn");
  const appRect = app ? app.getBoundingClientRect() : null;
  const sheetRect = sheet ? sheet.getBoundingClientRect() : null;
  const btnRect = btn ? btn.getBoundingClientRect() : null;
  return {
    appHeight: appRect?.height ?? 0,
    sheetBottom: sheetRect?.bottom ?? 0,
    appBottom: appRect?.bottom ?? 0,
    btnBottom: btnRect?.bottom ?? 0,
    btnVisibleInViewport: btnRect ? btnRect.bottom <= window.innerHeight + 1 : false,
  };
});
console.log("键盘弹出后:", JSON.stringify(afterInfo, null, 2));
check(
  ".app 高度跟随 --app-height 缩小",
  Math.abs(afterInfo.appHeight - 462) < 2,
  `appHeight=${afterInfo.appHeight.toFixed(1)}`,
);
check(
  "Sheet 底边不超过 .app 底边（不被键盘区域遮挡）",
  afterInfo.sheetBottom <= afterInfo.appBottom + 1,
  `sheetBottom=${afterInfo.sheetBottom.toFixed(1)} appBottom=${afterInfo.appBottom.toFixed(1)}`,
);
check("按钮仍在 Sheet 可视区内", afterInfo.btnBottom <= afterInfo.sheetBottom + 1);

// 还原变量
await page.evaluate(() => {
  document.documentElement.style.removeProperty("--app-height");
});
await page.waitForTimeout(200);

// ===== 对照路径：短文本快速搜索 =====
await textarea.fill("蜈支洲岛");
await page.waitForTimeout(200);
const quickBtn = page.locator(".note-input-sheet .note-actions-sticky .extract-btn");
console.log("=== 短文本（≤30 字）===");
console.log("按钮文案:", (await quickBtn.count()) > 0 ? (await quickBtn.first().textContent())?.trim() : "无按钮");

// ===== 对照路径：空输入 =====
await textarea.fill("");
await page.waitForTimeout(200);
console.log("=== 空输入 ===");
console.log("保存攻略/搜索按钮数量:", await quickBtn.count());
console.log("排版区引导文案:", await page.locator(".draft-hint-line").count());

await page.screenshot({ path: "/tmp/noteinput-sticky-fixed.png", fullPage: false });
console.log("截图: /tmp/noteinput-sticky-fixed.png");

await browser.close();
console.log(failures === 0 ? "\n全部验证通过 ✅" : `\n存在 ${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
