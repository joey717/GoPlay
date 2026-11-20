/**
 * Task #338 验收脚本（只读取证）：逐天切换，确认「内部玩法总时长超出游玩窗口…
 * 建议移一项到备选玩法（不会自动删除）」提醒已无渲染入口，同时确认其他提醒
 * （免票标签 / 攻略提示 chips / 推荐玩法待确认 / 查看详情按钮）仍正常渲染。
 *
 * 用法：node scripts/check-task338-overshoot.mjs
 * 截图输出 /tmp/task338-day<N>.png
 */
import { chromium } from "playwright";

const URL = "http://localhost:5173/?tripId=0a27f726-9c93-48e8-ab68-1d62e9bc685b";
/** 该行程 Day2 的亚龙湾热带天堂森林公园满足旧提醒触发条件（内部 228min > 窗口 210min） */
const TRIGGER_POI = "亚龙湾热带天堂森林公园";
const BANNED = ["游玩窗口", "建议移一项", "不会自动删除", "超出游玩窗口", "内部玩法总时长"];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".dchip", { timeout: 30000 });

const chips = page.locator(".dchip");
const dayCount = await chips.count();
let bannedHits = 0;
let overshootNodes = 0;
let triggerRendered = false;
const keep = { free: 0, snippetChip: 0, adoptHint: 0, detail: 0, statusRole: 0 };

for (let i = 0; i < dayCount; i++) {
  await chips.nth(i).click();
  await page.waitForTimeout(800);
  const probe = await page.evaluate(
    ([banned, triggerPoi]) => {
      const html = document.body.innerHTML;
      const text = document.body.innerText;
      return {
        bannedInHtml: banned.filter((kw) => html.includes(kw)),
        bannedInText: banned.filter((kw) => text.includes(kw)),
        overshootNodes: document.querySelectorAll(".overshoot").length,
        hasTriggerPoi: text.includes(triggerPoi),
        free: [...document.querySelectorAll(".tag")].filter((el) => el.textContent?.trim() === "免票")
          .length,
        snippetChip: document.querySelectorAll(".guide-snippet-chip").length,
        adoptHint: document.querySelectorAll(".adopt-hint").length,
        detail: [...document.querySelectorAll("button")].filter((el) =>
          (el.textContent ?? "").includes("查看详情"),
        ).length,
        statusRole: document.querySelectorAll('[role="status"]').length,
      };
    },
    [BANNED, TRIGGER_POI],
  );

  bannedHits += probe.bannedInHtml.length + probe.bannedInText.length;
  overshootNodes += probe.overshootNodes;
  if (probe.hasTriggerPoi) triggerRendered = true;
  keep.free += probe.free;
  keep.snippetChip += probe.snippetChip;
  keep.adoptHint += probe.adoptHint;
  keep.detail += probe.detail;
  keep.statusRole += probe.statusRole;

  console.log(
    `Day${i + 1}: banned=[${[...probe.bannedInHtml, ...probe.bannedInText].join(",") || "-"}] ` +
      `.overshoot=${probe.overshootNodes} triggerPoi=${probe.hasTriggerPoi} ` +
      `免票=${probe.free} snippetChip=${probe.snippetChip} adoptHint=${probe.adoptHint} ` +
      `查看详情=${probe.detail} role=status=${probe.statusRole}`,
  );
  await page.screenshot({ path: `/tmp/task338-day${i + 1}.png`, fullPage: true });
}

await browser.close();

console.log("===== Task #338 结论 =====");
console.log(`天数=${dayCount} 禁用文案命中=${bannedHits}（期望 0）`);
console.log(`.overshoot 节点=${overshootNodes}（期望 0）`);
console.log(`旧提醒触发 POI 是否被渲染=${triggerRendered}（期望 true，证明断言有效）`);
console.log(`保留项合计：免票标签=${keep.free} 攻略chips=${keep.snippetChip} 待确认提示=${keep.adoptHint} 查看详情=${keep.detail} role=status=${keep.statusRole}`);
const pass = bannedHits === 0 && overshootNodes === 0 && triggerRendered;
console.log(pass ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(pass ? 0 : 1);
