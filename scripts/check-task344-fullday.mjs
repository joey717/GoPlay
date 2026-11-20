/**
 * Task #344 验收脚本（只读取证，不做任何写操作）：
 * PD 原话「目前发现每个大景区都标了『全天』在景区名字下面的标、以及 DAY N 里都有，
 * 把『全天』二字去掉」——确认主行程页与分享页均不再出现「全天」，且「自定义」等其他
 * 取值、日期行的「· 」分隔符、抵达日约束信息全部保留。
 *
 * 断言分三组：
 * A. 违规扫描：全 DOM + 定向选择器均不得出现「全天」；被去字的标签不得留下悬空「· 」。
 *    覆盖 4 个渲染落点——主行程页父卡 .parent-tags .tag.clay、Day 条 .dchip .flag、
 *    分享页 .dchip .flag 与 .share-badge。
 * B. 保留项：Day2 天涯海角（数据侧 visitMode=custom）父卡标签仍为「大景区 · 自定义」；
 *    「大景区」基础段、日期行 Day N · MM/DD 周X、站数汇总、其他 .tag（免票/等级）仍在。
 * C. 抵达日：Day1（role=arrival）的航班约束条与「你设定」灰字仍显示——本次只去掉
 *    visitMode 的「全天」取值，天角色（抵达日/返程日）语义与展示一律未动。
 *
 * 数据基线（server/data/0a27f726-….json，只读核对）：
 *   Day1 role=arrival，鹿回头[large/full_day]；Day2 西岛[full_day] + 天涯海角[custom]；
 *   Day3 亚龙湾热带天堂森林公园[full_day]；Day4 蜈支洲岛[full_day] + 国际免税城[full_day]；
 *   Day5 南山文化旅游区[full_day] + 大小洞天[full_day]。
 *   该行程 JSON 内「全天」「半天」均为 0 命中 → 全 DOM 扫「全天」无内容侧假阳性。
 *
 * 用法：node scripts/check-task344-fullday.mjs
 * 截图输出 /tmp/task344-day<N>.png、/tmp/task344-share-day<N>.png、/tmp/task344-share-top.png
 */
import { chromium } from "playwright";

const TRIP_ID = "0a27f726-9c93-48e8-ab68-1d62e9bc685b";
const MAIN_URL = `http://localhost:5173/?tripId=${TRIP_ID}`;
const SHARE_URL = `http://localhost:5173/share/${TRIP_ID}`;

/** A. 违规模式：整词「全天」。.test() 用非全局版（全局正则 lastIndex 会跨调用污染导致漏检） */
const FULLDAY_RE = /全天/;
const FULLDAY_RE_G = /全天/g;

/**
 * B. 每天 .dchip .flag 的期望值（Day 条只取当天第一个大景区；数据侧这 5 天的
 * 首个大景区 visitMode 全是 full_day，故去字后 5 个 flag 都只剩景区名、都不含「·」）
 */
const EXPECTED_FLAGS = ["鹿回头", "西岛", "亚龙湾热带天堂森林公园", "蜈支洲岛", "南山文化旅游区"];

/** B. 每天应出现的大景区父卡名（.parent-name），用于证明页面确实渲染了内容（防空跑） */
const EXPECTED_PARENTS = [
  ["鹿回头"],
  ["西岛", "天涯海角"],
  ["亚龙湾热带天堂森林公园"],
  ["蜈支洲岛", "国际免税城"],
  ["南山文化旅游区", "大小洞天"],
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

let failures = 0;
const report = [];

function fail(msg) {
  failures++;
  report.push(`❌ ${msg}`);
}

/** 采集一次快照：Day 条 / 父卡标签 / 天头 / 约束 / 分享页徽标 / 全文 */
async function probe() {
  return page.evaluate(() => {
    const texts = (sel) => [...document.querySelectorAll(sel)].map((el) => (el.textContent ?? "").trim());
    const parentCards = [...document.querySelectorAll(".parent-card")].map((card) => ({
      name: (card.querySelector(".parent-name")?.textContent ?? "").trim(),
      clay: (card.querySelector(".parent-tags .tag.clay")?.textContent ?? "").trim(),
      hasClay: card.querySelector(".parent-tags .tag.clay") !== null,
    }));
    return {
      bodyText: document.body.innerText || "",
      flags: texts(".dchip .flag"),
      chipDays: texts(".dchip .d"),
      chipWeeks: texts(".dchip .w"),
      parentCards,
      shareBadges: texts(".share-badge:not(.ai-supplement-chip)"),
      shareCards: [...document.querySelectorAll(".share-card")].map((card) => ({
        name: (card.querySelector(".share-card-name")?.textContent ?? "").trim(),
        isLarge: card.className.includes("is-large"),
        // 只取 mode 徽标：.share-badge.ai-supplement-chip（AI 补充·飞猪核验）不属本次口径
        badge: (card.querySelector(".share-badge:not(.ai-supplement-chip)")?.textContent ?? "").trim(),
        hasBadge: card.querySelector(".share-badge:not(.ai-supplement-chip)") !== null,
      })),
      dayheadT: texts(".dayhead .t"),
      dayheadS: texts(".dayhead .s"),
      constraints: texts(".constraint"),
      anchorSrcs: texts(".anchor-src"),
      allTags: texts(".tag"),
    };
  });
}

/** A. 违规扫描：任何落点出现「全天」或留下悬空分隔符即失败 */
function auditFullDay(label, snap) {
  if (FULLDAY_RE.test(snap.bodyText)) {
    const hits = snap.bodyText.match(FULLDAY_RE_G) ?? [];
    fail(`A [${label}] 全 DOM 出现「全天」${hits.length} 次`);
  }
  for (const flag of snap.flags) {
    if (FULLDAY_RE.test(flag)) fail(`A [${label}] .dchip .flag 含「全天」：${flag}`);
    if (/[·]\s*$/.test(flag) || /^\s*[·]/.test(flag)) fail(`A [${label}] .dchip .flag 留下悬空「·」：${flag}`);
  }
  for (const card of snap.parentCards) {
    if (FULLDAY_RE.test(card.clay)) fail(`A [${label}] 父卡「${card.name}」标签含「全天」：${card.clay}`);
    if (/[·]\s*$/.test(card.clay) || /^\s*[·]/.test(card.clay)) {
      fail(`A [${label}] 父卡「${card.name}」标签留下悬空「·」：${card.clay}`);
    }
  }
  for (const badge of snap.shareBadges) {
    if (FULLDAY_RE.test(badge)) fail(`A [${label}] .share-badge 含「全天」：${badge}`);
    if (badge === "") fail(`A [${label}] .share-badge 渲染了空白徽标（应整块不渲染）`);
  }
  for (const tag of snap.allTags) {
    if (FULLDAY_RE.test(tag)) fail(`A [${label}] .tag 含「全天」：${tag}`);
  }
}

// ===== 1. 主行程页：逐天 =====
await page.goto(MAIN_URL, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".dchip", { timeout: 30000 });
const chips = page.locator(".dchip");
const dayCount = await chips.count();
console.log(`主行程页 Day 数：${dayCount}`);

if (dayCount !== EXPECTED_FLAGS.length) {
  fail(`主行程页 Day 数 ${dayCount} ≠ 期望 ${EXPECTED_FLAGS.length}（夹具/数据已变，断言需同步）`);
}

// Day 条常驻，先在初始状态整体校验一次
const stripSnap = await probe();
auditFullDay("DayStrip", stripSnap);
if (JSON.stringify(stripSnap.flags) !== JSON.stringify(EXPECTED_FLAGS)) {
  fail(`B Day 条 .flag 不符期望：实际 [${stripSnap.flags.join(" | ")}]，期望 [${EXPECTED_FLAGS.join(" | ")}]`);
} else {
  report.push(`B Day 条 .flag 全部命中期望（无「全天」、无悬空「·」）：[${stripSnap.flags.join(" | ")}]`);
}
for (let i = 0; i < stripSnap.chipDays.length; i++) {
  if (!/^Day\d+$/.test(stripSnap.chipDays[i])) fail(`B .dchip .d 异常：${stripSnap.chipDays[i]}`);
  if (!/^\d{2}\/\d{2}\s*周.$/.test(stripSnap.chipWeeks[i])) fail(`B .dchip .w 异常：${stripSnap.chipWeeks[i]}`);
}

let clayTotal = 0;
let tagTotal = 0;
let dayheadOk = 0;
let customKept = 0;
let arrivalConstraintOk = 0;
let arrivalAnchorOk = 0;
const expectedParentHits = [];

for (let i = 0; i < dayCount; i++) {
  await chips.nth(i).click();
  await page.waitForTimeout(900);
  const snap = await probe();
  const label = `Day${i + 1}`;
  auditFullDay(label, snap);

  // B. 父卡：期望的大景区名逐个到位，且 clay 标签以「大景区」开头
  const names = snap.parentCards.map((c) => c.name);
  for (const expected of EXPECTED_PARENTS[i] ?? []) {
    if (names.includes(expected)) expectedParentHits.push(`Day${i + 1}/${expected}`);
    else fail(`B ${label} 未见期望的大景区父卡「${expected}」（实际：[${names.join(" | ")}]）`);
  }
  for (const card of snap.parentCards) {
    clayTotal++;
    if (!card.hasClay) fail(`B ${label} 父卡「${card.name}」缺 .tag.clay 标签`);
    if (!card.clay.startsWith("大景区")) fail(`B ${label} 父卡「${card.name}」标签未以「大景区」开头：${card.clay}`);
    // PD 明确「自定义」等其他段保留：Day2 天涯海角数据侧 visitMode=custom
    if (card.clay === "大景区 · 自定义") customKept++;
  }
  tagTotal += snap.allTags.length;

  // B. 天头：日期行的「· 」分隔符与站数汇总不能被连带删掉
  for (const t of snap.dayheadT) if (/^Day\d+\s*·\s*\d{2}\/\d{2}\s*周.$/.test(t)) dayheadOk++;
  for (const s of snap.dayheadS) {
    if (!/\d+\s*站|无内容|空/.test(s)) fail(`B ${label} 天头站数汇总异常：${s}`);
  }

  // C. 抵达日（Day1 role=arrival）：航班约束条 + 「你设定」灰字仍显示
  if (i === 0) {
    if (snap.constraints.some((c) => /航班到达\s*09:00/.test(c))) arrivalConstraintOk++;
    else fail(`C Day1 抵达日约束条丢失（实际：[${snap.constraints.join(" | ")}]）`);
    if (snap.anchorSrcs.some((s) => s.includes("你设定"))) arrivalAnchorOk++;
    else fail(`C Day1「你设定」灰字丢失（实际：[${snap.anchorSrcs.join(" | ")}]）`);
  }

  await page.screenshot({ path: `/tmp/task344-day${i + 1}.png`, fullPage: true });
  report.push(
    `Day${i + 1} OK：父卡=[${snap.parentCards.map((c) => `${c.name}→「${c.clay}」`).join("；")}]，` +
      `天头=[${snap.dayheadT.join(" | ")} / ${snap.dayheadS.join(" | ")}]，` +
      `约束=[${snap.constraints.join(" | ") || "无"}]，灰字=[${snap.anchorSrcs.join(" | ") || "无"}]，` +
      `.tag=${snap.allTags.length} 个`,
  );
}

// ===== 2. 分享页：Day 条 + 父卡 .share-badge =====
await page.goto(SHARE_URL, { waitUntil: "domcontentloaded" });
try {
  await page.waitForSelector(".share-card", { timeout: 20000 });
} catch {
  fail("分享页未渲染出 .share-card（路由或数据异常，分享页断言无法执行）");
}
const shareSnap = await probe();
auditFullDay("分享页", shareSnap);
if (JSON.stringify(shareSnap.flags) !== JSON.stringify(EXPECTED_FLAGS)) {
  fail(`B 分享页 Day 条 .flag 不符期望：实际 [${shareSnap.flags.join(" | ")}]`);
} else {
  report.push(`B 分享页 Day 条 .flag 命中期望：[${shareSnap.flags.join(" | ")}]`);
}
await page.screenshot({ path: "/tmp/task344-share-top.png", fullPage: true });

const shareChips = page.locator(".dchip");
const shareDayCount = await shareChips.count();
let shareBadgeTotal = 0;
let shareCustomKept = 0;
for (let i = 0; i < shareDayCount; i++) {
  await shareChips.nth(i).click();
  await page.waitForTimeout(800);
  const snap = await probe();
  auditFullDay(`分享页Day${i + 1}`, snap);
  for (const card of snap.shareCards) {
    if (!card.isLarge) {
      // 普通景点卡本就没有 mode 徽标，出现即为回归
      if (card.hasBadge && (card.badge === "全天" || card.badge === "半天" || card.badge === "自定义")) {
        fail(`A 分享页Day${i + 1} 普通卡「${card.name}」意外渲染 mode 徽标：${card.badge}`);
      }
      continue;
    }
    if (card.hasBadge) {
      shareBadgeTotal++;
      if (card.badge === "自定义") shareCustomKept++;
      if (card.badge !== "半天" && card.badge !== "自定义") {
        fail(`A 分享页Day${i + 1} 大景区「${card.name}」徽标取值异常：${card.badge}`);
      }
    }
  }
  await page.screenshot({ path: `/tmp/task344-share-day${i + 1}.png`, fullPage: true });
  report.push(
    `分享页Day${i + 1} OK：卡片=[${snap.shareCards
      .map((c) => `${c.name}${c.isLarge ? "(大景区)" : ""}→${c.hasBadge ? `「${c.badge}」` : "无徽标"}`)
      .join("；")}]`,
  );
}

// ===== 3. 保留项哨兵：任一为 0 即判定「页面没渲染所以扫不到违规」的假绿 =====
if (clayTotal === 0) fail("B 全程未见任何 .parent-tags .tag.clay（保留项断言失效）");
if (tagTotal === 0) fail("B 全程未见任何 .tag chip（可能误伤其他标签）");
if (dayheadOk === 0) fail("B 全程未见日期行「Day N · MM/DD 周X」（日期行的「· 」可能被误删）");
if (customKept === 0) fail("B 全程未见「大景区 · 自定义」（「自定义」段应保留，断言失效或已误伤）");
if (expectedParentHits.length === 0) fail("B 全程未命中任何期望的大景区父卡（页面可能未正常渲染）");
if (arrivalConstraintOk === 0) fail("C 全程未见 Day1 抵达日约束条（抵达日信息应保留）");
if (arrivalAnchorOk === 0) fail("C 全程未见 Day1「你设定」灰字（抵达日信息应保留）");
// 分享页：Day2 天涯海角为 custom，应保留「自定义」徽标
if (shareBadgeTotal === 0) fail("A/B 分享页全程未见任何 mode 徽标（「半天/自定义」应保留，可能误伤）");
if (shareCustomKept === 0) fail("B 分享页全程未见「自定义」徽标（Day2 天涯海角应保留）");

await browser.close();

console.log(report.map((line) => `  ${line}`).join("\n"));
console.log(
  `\n保留项汇总：父卡 .tag.clay ${clayTotal} 个（其中「大景区 · 自定义」${customKept} 个）/ ` +
    `.tag 共 ${tagTotal} 个 / 日期行 ${dayheadOk} 处 / 期望大景区命中 ${expectedParentHits.length} 处` +
    `（${expectedParentHits.join("、")}）/ Day1 抵达日约束 ${arrivalConstraintOk} 处 + 「你设定」灰字 ${arrivalAnchorOk} 处 / ` +
    `分享页 mode 徽标 ${shareBadgeTotal} 个（其中「自定义」${shareCustomKept} 个）`,
);
console.log(
  failures === 0
    ? "\n✅ Task #344 浏览器验收全部通过：主行程页 + 分享页均无「全天」，无悬空「· 」；「大景区」基础段、「自定义」取值、日期行分隔符与 Day1 抵达日信息全部保留"
    : `\n❌ Task #344 浏览器验收失败 ${failures} 项`,
);
process.exit(failures === 0 ? 0 : 1);
