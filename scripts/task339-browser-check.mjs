/**
 * Task #339 浏览器验证：PD 行程 0a27f726 玻璃栈道相似亮点已收敛为 1 条。
 * 步骤：打开行程 → 切到 Day3（玻璃栈道所在天）→ 定位「玻璃栈道」子玩法行
 *      → 统计其 .guide-snippet-chip 数量，断言 = 1 → 截图。
 */
import { chromium } from "playwright";

const BASE = "http://localhost:5173";
const TRIP_ID = "0a27f726-9c93-48e8-ab68-1d62e9bc685b";
const TARGET = "玻璃栈道";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on("pageerror", (err) => console.log("[pageerror]", err.message));

await page.goto(`${BASE}/?tripId=${TRIP_ID}`);
await page.waitForSelector(".dchip", { timeout: 15000 });

// 玻璃栈道在 Day3（dayIndex=2）亚龙湾热带天堂森林公园父卡下；逐天查找目标子玩法行。
let found = false;
const dayChips = await page.locator(".dchip").count();
for (let i = 0; i < dayChips && !found; i += 1) {
  await page.locator(".dchip").nth(i).click();
  await page.waitForTimeout(400);
  const rows = page.locator(".child");
  const n = await rows.count();
  for (let j = 0; j < n; j += 1) {
    const row = rows.nth(j);
    const nameText = ((await row.locator(".child-name").first().textContent()) ?? "").trim();
    if (nameText.includes(TARGET)) {
      found = true;
      const chips = row.locator(".guide-snippet-chip");
      const chipCount = await chips.count();
      const chipTexts = [];
      for (let k = 0; k < chipCount; k += 1) {
        chipTexts.push(((await chips.nth(k).textContent()) ?? "").trim());
      }
      console.log(`定位：Day${i + 1} · 子玩法「${nameText}」`);
      console.log(`亮点 chip 数量：${chipCount}`);
      chipTexts.forEach((t, idx) => console.log(`  [${idx + 1}] ${t}`));
      check("玻璃栈道只展示 1 条亮点 chip", chipCount === 1, `实际 ${chipCount}`);
      check(
        "保留者为更长/更完整的表述",
        chipCount === 1 && chipTexts[0].includes("大雾天玻璃栈道白茫茫拍不到"),
        chipTexts[0] ?? "",
      );
      await row.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await row.screenshot({ path: "/tmp/task339-glasswalk-chip.png" });
      await page.screenshot({ path: "/tmp/task339-day3-full.png", fullPage: false });
      console.log("截图：/tmp/task339-glasswalk-chip.png");
      console.log("截图：/tmp/task339-day3-full.png");
      break;
    }
  }
}
check("在行程中找到玻璃栈道子玩法行", found);

await browser.close();
console.log(failures === 0 ? "\n全部验证通过 ✅" : `\n存在 ${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
