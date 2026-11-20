/**
 * Task #340 验收脚本（只读取证）：暂停展示所有估算时间（SHOW_ESTIMATED_TIMES=false）。
 *
 * 逐天（5 天）+ 分享页断言：
 * - DOM 不得出现 "HH:MM–HH:MM" / "HH:MM – HH:MM" 时间区间、"约 X 小时"、
 *   "估算" 徽标、"X 小时游玩" 时长汇总、"按你的到达航班 HH:MM 算" 来源灰字；
 * - "岛内 N 个点" 计数仍在；
 * - 约束时间（.constraint 内 HH:MM，如「航班到达 09:00」）仍可见；
 * - 日期（Day N · MM/DD 周X）仍可见；出发时间锚点（.anchor-time）仍可见。
 *
 * 用法：node scripts/check-task340-times.mjs
 * 截图输出 /tmp/task340-day<N>.png 与 /tmp/task340-share.png
 */
import { chromium } from "playwright";

const TRIP_ID = "0a27f726-9c93-48e8-ab68-1d62e9bc685b";
const URL = `http://localhost:5173/?tripId=${TRIP_ID}`;
const SHARE_URL = `http://localhost:5173/share/${TRIP_ID}`;

/** 违规模式：估算时间区间 / 约X小时 / 估算徽标 / 小时游玩汇总 / 带时间来源灰字 */
const VIOLATIONS = [
  { name: "时间区间 HH:MM–HH:MM", re: /\d{1,2}:\d{2}\s*[–—-]\s*\d{1,2}:\d{2}/ },
  { name: "约 X 小时", re: /约\s*\d+(\.\d+)?\s*(小时|分钟)/ },
  { name: "估算徽标", re: /估算/ },
  { name: "X 小时游玩", re: /\d+(\.\d+)?\s*小时游玩/ },
  { name: "部分游玩时长待定", re: /部分游玩时长待定/ },
  { name: "带时间的来源灰字", re: /按你的到达航班\s*\d{1,2}:\d{2}\s*算/ },
];

/** 时间戳类豁免（事实非估算）：最后更新 MM/DD HH:MM */
function stripFacts(text) {
  return text.replace(/最后更新\s*\d{2}\/\d{2}\s*\d{2}:\d{2}/g, "");
}

function scan(text) {
  const stripped = stripFacts(text);
  return VIOLATIONS.filter((v) => v.re.test(stripped)).map((v) => v.name);
}

/**
 * 定向扫描：只检查时间渲染点所在的 UI 元素，不扫攻略原文/snippet/操作日志
 * 等用户内容（它们可能合法含时间文本，不属估算时间渲染点）。
 */
const SCAN_SELECTORS = [
  ".dayhead .s",
  ".dayhead .t",
  ".parent-sub",
  ".prodrow",
  ".child-time",
  ".anchor-src",
  ".share-meta",
  ".share-stop-dur",
  ".share-day-head",
  ".dchip",
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

let failures = 0;
const report = [];

// ===== 主行程页：逐天 =====
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".dchip", { timeout: 30000 });
const chips = page.locator(".dchip");
const dayCount = await chips.count();
console.log(`主行程页 Day 数：${dayCount}`);

let parentSubSeen = 0;
let constraintTimeSeen = 0;

for (let i = 0; i < dayCount; i++) {
  await chips.nth(i).click();
  await page.waitForTimeout(900);
  const probe = await page.evaluate((selectors) => {
    const text = document.body.innerText;
    const scanned = [...document.querySelectorAll(selectors.join(","))].map((el) => ({
      sel: el.className,
      text: el.textContent ?? "",
    }));
    const dayhead = document.querySelector(".dayhead .t")?.textContent ?? "";
    const dayheadSub = document.querySelector(".dayhead .s")?.textContent ?? "";
    const parentSubs = [...document.querySelectorAll(".parent-sub")].map((el) => el.textContent ?? "");
    const constraints = [...document.querySelectorAll(".constraint")].map((el) => el.textContent ?? "");
    const anchorTimes = [...document.querySelectorAll(".anchor-time")].map((el) => el.textContent ?? "");
    const anchorSrcs = [...document.querySelectorAll(".anchor-src")].map((el) => el.textContent ?? "");
    const scheduleNodes = document.querySelectorAll(".prodrow .schedule").length;
    const childTimeTexts = [...document.querySelectorAll(".child-time-text")].map((el) => el.textContent ?? "");
    return { text, scanned, dayhead, dayheadSub, parentSubs, constraints, anchorTimes, anchorSrcs, scheduleNodes, childTimeTexts };
  }, SCAN_SELECTORS);

  // 定向元素扫描（UI 渲染点）+ 全文兼容扫描（只计违规模式，命中时列出供人工判断是否攻略原文）
  const hits = [];
  for (const node of probe.scanned) {
    for (const name of scan(node.text)) hits.push(`[${node.sel}] ${name}: ${node.text.slice(0, 40)}`);
  }
  if (hits.length > 0) {
    failures++;
    report.push(`Day${i + 1} 违规渲染：${hits.join("；")}`);
  }
  // 保留项断言
  if (!/Day\d+\s*·\s*\d{2}\/\d{2}\s*周./.test(probe.dayhead)) {
    failures++;
    report.push(`Day${i + 1} 日期行缺失/形态异常：${probe.dayhead}`);
  }
  for (const sub of probe.parentSubs) {
    parentSubSeen++;
    if (!/岛内 \d+ 个点/.test(sub) || /约/.test(sub)) {
      failures++;
      report.push(`Day${i + 1} 父卡汇总行异常：${sub}`);
    }
  }
  for (const c of probe.constraints) {
    if (/\d{1,2}:\d{2}/.test(c)) constraintTimeSeen++;
  }
  if (probe.scheduleNodes > 0) {
    failures++;
    report.push(`Day${i + 1} 仍渲染 .schedule 估算时间行 x${probe.scheduleNodes}`);
  }
  for (const t of probe.childTimeTexts) {
    failures++;
    report.push(`Day${i + 1} 岛内玩法仍渲染时间文本：${t}`);
  }
  for (const s of probe.anchorSrcs) {
    if (/\d{1,2}:\d{2}/.test(s)) {
      failures++;
      report.push(`Day${i + 1} 仍渲染带时间来源灰字：${s}`);
    }
  }
  await page.screenshot({ path: `/tmp/task340-day${i + 1}.png`, fullPage: true });
  report.push(
    `Day${i + 1} OK：dayhead="${probe.dayheadSub}"，父卡汇总=[${probe.parentSubs.join(" | ")}]，` +
      `约束=[${probe.constraints.join(" | ")}]，出发锚点=[${probe.anchorTimes.join(",")}]，来源灰字=[${probe.anchorSrcs.join(",")}]`,
  );
}

if (parentSubSeen === 0) {
  failures++;
  report.push("全程未见「岛内 N 个点」父卡汇总行（保留项断言失效）");
}
if (constraintTimeSeen === 0) {
  failures++;
  report.push("全程未见带时间的约束条（保留项断言失效）");
}

// ===== 分享页 =====
await page.goto(SHARE_URL, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".share-day, .boot-error", { timeout: 30000 });
const shareChips = page.locator(".dchip");
const shareDayCount = await shareChips.count();
for (let i = 0; i < shareDayCount; i++) {
  await shareChips.nth(i).click();
  await page.waitForTimeout(500);
  const probe = await page.evaluate((selectors) => ({
    scanned: [...document.querySelectorAll(selectors.join(","))].map((el) => ({
      sel: el.className,
      text: el.textContent ?? "",
    })),
    meta: document.querySelectorAll(".share-meta").length,
    stopDur: document.querySelectorAll(".share-stop-dur").length,
    depart: [...document.querySelectorAll(".share-depart")].map((el) => el.textContent ?? ""),
  }), SCAN_SELECTORS);
  const hits = [];
  for (const node of probe.scanned) {
    for (const name of scan(node.text)) hits.push(`[${node.sel}] ${name}: ${node.text.slice(0, 40)}`);
  }
  if (hits.length > 0 || probe.meta > 0 || probe.stopDur > 0) {
    failures++;
    report.push(`分享页 Day${i + 1} 违规：${hits.join("；")} share-meta=${probe.meta} share-stop-dur=${probe.stopDur}`);
  } else {
    report.push(`分享页 Day${i + 1} OK：无时间窗/时长，出发锚点=[${probe.depart.join(",")}]`);
  }
}
await page.screenshot({ path: "/tmp/task340-share.png", fullPage: true });

await browser.close();

console.log(report.map((line) => `  ${line}`).join("\n"));
console.log(failures === 0 ? "\n✅ Task #340 浏览器验收全部通过" : `\n❌ Task #340 浏览器验收失败 ${failures} 项`);
process.exit(failures === 0 ? 0 : 1);
