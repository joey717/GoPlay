/**
 * Task #245 浏览器级复现/验收（临时脚本）：真实 Vite served module + 真实打开 NoteInput。
 * 断言：无 ReferenceError / 选择状态与 footer CTA 同源 / Task #242 五项结构契约。
 */
import { chromium } from "playwright";

const BASE = "http://localhost:5173";
const TRIP_ID = "48275e19-c7cb-417b-8ef7-57b04e097cf4";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const pageErrors = [];
const consoleErrors = [];
page.on("pageerror", (err) => pageErrors.push(`${err.name}: ${err.message}`));
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
};

await page.goto(`${BASE}/?tripId=${TRIP_ID}`, { waitUntil: "networkidle" });
await page.waitForSelector(".add-entry", { timeout: 20000 });
await page.click(".add-entry");
await page.waitForSelector(".note-input-sheet", { timeout: 8000 });
await page.waitForTimeout(1200);

// ===== 1. 运行时错误（核心回归） =====
check("无 pageerror", pageErrors.length === 0, pageErrors.join(" | "));
check(
  "无 ReferenceError / selectedSourceIdsRef 报错",
  ![...pageErrors, ...consoleErrors].some((text) => /is not defined|ReferenceError/.test(text)),
  [...pageErrors, ...consoleErrors].filter((t) => /is not defined|ReferenceError/.test(t)).join(" | "),
);

// ===== 2. 真实渲染路径：勾选变化 → 列表与 footer CTA 同源 =====
const readState = () =>
  page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.guide-source-list input[type="checkbox"]')];
    const checked = boxes.filter((box) => box.checked).length;
    const primary = document.querySelector(".note-input-foot .draft-primary");
    const sheet = document.querySelector(".note-input-sheet");
    const body = document.querySelector(".note-input-body");
    const foot = document.querySelector(".note-input-foot");
    const textarea = document.querySelector(".note-textarea");
    const sheetCs = sheet ? getComputedStyle(sheet) : null;
    const bodyCs = body ? getComputedStyle(body) : null;
    const taCs = textarea ? getComputedStyle(textarea) : null;
    // 除 .note-input-body 外的内部滚动容器（textarea 自己滚动是允许的）
    const innerScrollers = [...(body?.querySelectorAll("*") ?? [])]
      .filter((el) => {
        const cs = getComputedStyle(el);
        const scrollable = /(auto|scroll)/.test(cs.overflowY);
        if (!scrollable) return false;
        return !(el.tagName === "TEXTAREA");
      })
      .map((el) => `${el.tagName}.${el.className}`);
    const sheetRect = sheet?.getBoundingClientRect() ?? null;
    const footRect = foot?.getBoundingClientRect() ?? null;
    return {
      total: boxes.length,
      checked,
      primaryLabel: primary?.textContent?.trim() ?? null,
      primaryDisabled: primary instanceof HTMLButtonElement ? primary.disabled : null,
      footVisible:
        footRect !== null &&
        sheetRect !== null &&
        footRect.bottom <= sheetRect.bottom + 1 &&
        footRect.top >= sheetRect.top - 1 &&
        footRect.bottom <= window.innerHeight + 1,
      sheetOverflowY: sheetCs?.overflowY ?? null,
      bodyOverflowY: bodyCs?.overflowY ?? null,
      bodyMinHeight: bodyCs?.minHeight ?? null,
      footFlex: getComputedStyle(foot).flex,
      textareaRows: textarea?.getAttribute("rows") ?? null,
      textareaMinHeight: taCs?.minHeight ?? null,
      textareaHeight: textarea ? Math.round(textarea.getBoundingClientRect().height) : null,
      innerScrollers,
      scopeNoteCount: document.querySelectorAll(".draft-scope-note, .draft-scope-chips, .scope-chip")
        .length,
      rangeTextPresent: document.body.innerText.includes("将调整整段行程"),
      sheetChildren: sheet ? [...sheet.children].map((el) => el.className) : [],
    };
  });

const before = await readState();
console.log("初始状态:", JSON.stringify(before, null, 2));
check("来源列表已加载（≥1 篇）", before.total >= 1, `total=${before.total}`);
check(
  "footer CTA 篇数与列表勾选一致",
  before.primaryLabel !== null && before.primaryLabel.includes(`已选 ${before.checked} 篇`),
  `label=${before.primaryLabel} checked=${before.checked}`,
);
check("footer 完整落在 Sheet/视口内（打开即见）", before.footVisible);
check("Sheet 自身不滚动（overflow: hidden）", before.sheetOverflowY === "hidden", String(before.sheetOverflowY));
check("正文 .note-input-body 唯一滚动", before.bodyOverflowY === "auto", String(before.bodyOverflowY));
check("footer 为 flex 尾部不收缩", before.footFlex.startsWith("0 0 auto"), before.footFlex);
check("Sheet 直接子节点含 body + foot", before.sheetChildren.some((c) => c.includes("note-input-body")) && before.sheetChildren.some((c) => c.includes("note-input-foot")), before.sheetChildren.join(" | "));
check("无内层滚动容器（除 textarea）", before.innerScrollers.length === 0, before.innerScrollers.join(" | "));
check("输入框 rows=2", before.textareaRows === "2", String(before.textareaRows));
check("输入框 min-height 64px", before.textareaMinHeight === "64px", String(before.textareaMinHeight));
check("无范围文案 / 范围 chips", before.scopeNoteCount === 0 && !before.rangeTextPresent);

// 勾选一篇（真实点击）→ 选择状态与 footer 同源刷新
const firstBox = page.locator('.guide-source-list input[type="checkbox"]').first();
if (await firstBox.isEnabled()) {
  await firstBox.click();
  await page.waitForTimeout(250);
  const after = await readState();
  console.log("取消一篇后:", JSON.stringify({ checked: after.checked, label: after.primaryLabel }, null, 2));
  check("取消勾选后 CTA 篇数同步收敛", after.checked === before.checked - 1 && after.primaryLabel === `AI 生成行程 · 已选 ${after.checked} 篇`, `${before.checked} → ${after.checked} / ${after.primaryLabel}`);
  // 再勾回来，避免改动用户数据视图状态（纯前端，不落库）
  await firstBox.click();
  await page.waitForTimeout(200);
}

// ===== 3. 最终错误复查（覆盖整个交互过程） =====
check("交互后仍无 pageerror", pageErrors.length === 0, pageErrors.join(" | "));
check(
  "交互后仍无 ReferenceError",
  ![...pageErrors, ...consoleErrors].some((text) => /is not defined|ReferenceError/.test(text)),
);

await page.screenshot({ path: "/tmp/task245-noteinput.png" });
console.log("截图: /tmp/task245-noteinput.png");
await browser.close();
console.log(failures === 0 ? "\n全部通过 ✅" : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
