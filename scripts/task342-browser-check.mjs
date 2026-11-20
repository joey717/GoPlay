/**
 * Task #342 浏览器验证：跨攻略/同篇相似亮点「卡内合并为 1 条 + 诚实标注」，
 * 且攻略原文 sheet 仍逐条全量展示（信息不丢）。
 *
 * 断言：
 *  A. Day3 过江龙索桥子玩法行：卡内只 1 条 .guide-snippet-chip；
 *     该 chip 带 .guide-snippet-note 标注（两条同出一篇攻略 → 「同篇攻略 2 处提及」）；
 *  B. 点开该 chip → EvidenceSheet 打开，.evidence-snippet 仍为 2 条（原文全量不变）；
 *  C. 玻璃栈道（同来源，#339 后已收敛为 1 条）chip 不出现「篇/处提及」标注（N=1 不标注）；
 *  D. 截图 /tmp/task342-*.png。
 */
import { chromium } from "playwright";

const BASE = "http://localhost:5173";
const TRIP_ID = "0a27f726-9c93-48e8-ab68-1d62e9bc685b";
const BRIDGE = "过江龙索桥";
const GLASS = "玻璃栈道";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
};

/** 逐天查找指定名称的子玩法行，返回 { dayIndex, row } 或 null */
async function findChildRow(page, target) {
  const dayChips = await page.locator(".dchip").count();
  for (let i = 0; i < dayChips; i += 1) {
    await page.locator(".dchip").nth(i).click();
    await page.waitForTimeout(350);
    const rows = page.locator(".child");
    const n = await rows.count();
    for (let j = 0; j < n; j += 1) {
      const row = rows.nth(j);
      const nameText = ((await row.locator(".child-name").first().textContent()) ?? "").trim();
      if (nameText.includes(target)) return { dayIndex: i + 1, row, nameText };
    }
  }
  return null;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on("pageerror", (err) => console.log("[pageerror]", err.message));

await page.goto(`${BASE}/?tripId=${TRIP_ID}`);
await page.waitForSelector(".dchip", { timeout: 15000 });

// ===== A/B. 过江龙索桥：卡内 1 chip + 标注；原文 sheet 仍 2 条 =====
const bridge = await findChildRow(page, BRIDGE);
check("在行程中找到过江龙索桥子玩法行", bridge !== null, bridge ? `Day${bridge.dayIndex}` : "未找到");
if (bridge) {
  const chips = bridge.row.locator(".guide-snippet-chip");
  const chipCount = await chips.count();
  console.log(`定位：Day${bridge.dayIndex} · 子玩法「${bridge.nameText}」`);
  console.log(`卡内亮点 chip 数量：${chipCount}`);
  for (let k = 0; k < chipCount; k += 1) {
    console.log(`  [${k + 1}] ${((await chips.nth(k).textContent()) ?? "").trim()}`);
  }
  check("过江龙索桥卡内只展示 1 条亮点 chip", chipCount === 1, `实际 ${chipCount}`);

  const note = bridge.row.locator(".guide-snippet-chip .guide-snippet-note");
  const noteCount = await note.count();
  const noteText = noteCount > 0 ? ((await note.first().textContent()) ?? "").trim() : "";
  console.log(`标注文本：${noteText || "(无)"}`);
  check("合并 chip 带诚实标注", noteCount === 1 && noteText.length > 0, noteText);
  check(
    "两条同出一篇攻略 → 标注为「同篇攻略 2 处提及」（不冒充 2 篇）",
    noteText === "（同篇攻略 2 处提及）",
    noteText,
  );

  await bridge.row.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await bridge.row.screenshot({ path: "/tmp/task342-bridge-chip.png" });
  await page.screenshot({ path: "/tmp/task342-bridge-day.png" });

  // 点开 chip → EvidenceSheet 仍逐条全量展示 2 条
  await chips.first().click();
  await page.waitForTimeout(500);
  const sheetSnippets = page.locator(".evidence-snippet");
  const sheetCount = await sheetSnippets.count();
  const sheetTexts = [];
  for (let k = 0; k < sheetCount; k += 1) {
    sheetTexts.push(((await sheetSnippets.nth(k).textContent()) ?? "").trim());
  }
  console.log(`原文 sheet 亮点条数：${sheetCount}`);
  sheetTexts.forEach((t, idx) => console.log(`  [${idx + 1}] ${t}`));
  check("点开原文 sheet 仍展示 2 条（信息不丢）", sheetCount === 2, `实际 ${sheetCount}`);
  await page.screenshot({ path: "/tmp/task342-bridge-sheet.png" });
  // 关闭 sheet（关闭按钮 aria-label="关闭攻略原文"；兜底点 backdrop）
  const closeBtn = page.locator('.sheet[role="dialog"] button.x[aria-label="关闭攻略原文"]').first();
  if (await closeBtn.count()) await closeBtn.click();
  else await page.locator(".backdrop.on").first().click();
  await page.waitForSelector(".backdrop.on", { state: "detached", timeout: 5000 });
  await page.waitForTimeout(300);
}

// ===== C. 玻璃栈道（#339 后 1 条，同来源）：不出现「篇/处提及」标注 =====
const glass = await findChildRow(page, GLASS);
check("在行程中找到玻璃栈道子玩法行", glass !== null, glass ? `Day${glass.dayIndex}` : "未找到");
if (glass) {
  const gChips = glass.row.locator(".guide-snippet-chip");
  const gCount = await gChips.count();
  const gNote = glass.row.locator(".guide-snippet-chip .guide-snippet-note");
  const gNoteCount = await gNote.count();
  console.log(`定位：Day${glass.dayIndex} · 玻璃栈道 chip=${gCount} 标注=${gNoteCount}`);
  check("玻璃栈道 #339 后卡内为 1 条 chip", gCount === 1, `实际 ${gCount}`);
  check("玻璃栈道不出现「篇/处提及」标注（N=1 不标注）", gNoteCount === 0, `实际 ${gNoteCount}`);
  await glass.row.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await glass.row.screenshot({ path: "/tmp/task342-glass-chip.png" });
}

console.log("\n截图：/tmp/task342-bridge-chip.png, /tmp/task342-bridge-day.png, /tmp/task342-bridge-sheet.png, /tmp/task342-glass-chip.png");
await browser.close();
console.log(failures === 0 ? "\n全部验证通过 ✅" : `\n存在 ${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
