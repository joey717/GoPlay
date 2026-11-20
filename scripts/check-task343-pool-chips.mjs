/**
 * Task #343 验收脚本（只读取证，不做任何写操作）：
 * PD 拍板「候选池/备选区『建议 X 小时』chip 也都藏」后，确认页面上不出现任何
 * 「建议 X 小时/分钟」时长文本，并给出 CandidatePool 为死代码（无挂载点）的 DOM 证据。
 *
 * 断言分三组：
 * A. 违规扫描：全 DOM + 定向选择器均不得出现「建议 X 小时/分钟」形态时长文本；
 * B. 死代码证据：任何一天、任何可打开面板下都不得出现候选池 UI
 *    （.pool-section / .pool-title / .poolitem / 「候选区（」/「待定加入（」/「备选玩法（N 个景区）」）；
 * C. 保留项：其他 chip（名称 / 免票 / 片区 / 4A5A / 榜单 / 「含 N 个岛内玩法」/ 站数 /
 *    「岛内 N 个点」）与日期、约束时间仍正常渲染（证明没有误伤）。
 *
 * 用法：node scripts/check-task343-pool-chips.mjs
 * 截图输出 /tmp/task343-day<N>.png、/tmp/task343-addpanel.png、/tmp/task343-moremenu.png
 */
import { chromium } from "playwright";

const TRIP_ID = "0a27f726-9c93-48e8-ab68-1d62e9bc685b";
const URL = `http://localhost:5173/?tripId=${TRIP_ID}`;

/** A. 违规模式：任何「建议 X 小时/分钟」时长文本（含中英文单位与小数）。
 *  注意：.test() 用非全局版（全局正则的 lastIndex 会跨调用污染导致漏检），
 *  全文计数另用 global 副本走 match()。 */
const SUGGEST_SRC = String.raw`建议\s*\d+(\.\d+)?\s*(h|min|小时|分钟)`;
const SUGGEST_RE = new RegExp(SUGGEST_SRC);
const SUGGEST_RE_G = new RegExp(SUGGEST_SRC, "g");
/** 宽松版：只要出现「建议」后紧跟数字即视为可疑（防止单位变体漏网） */
const SUGGEST_LOOSE_RE = /建议\s*[\d.]/;
const SUGGEST_LOOSE_RE_G = /建议\s*[\d.]/g;

/** A. 定向选择器：所有已知的「建议 X」时长 chip 渲染落点 */
const SCAN_SELECTORS = [
  ".reserve-meta", // 备选玩法区（VisitCard L813 / CandidatePool L562）
  ".poolitem .m", // 候选池区一/区二 metaParts 行
  ".prodrow .schedule .du", // 普通卡建议时长
  ".child-time-text", // 岛内玩法行时间文本（回退「建议 X」）
  ".parent-sub", // 父卡「岛内 N 个点 · 约 X 小时」
  ".share-meta", // 分享页时间窗 + 建议时长
  ".share-stop-dur", // 分享页内部玩法时长
  ".candidate-meta", // NoteInput 候选池推荐区块第二行
  ".dayhead .s", // 天头「N 站 · X 小时游玩」
];

/** B. 候选池 UI 特征（出现即说明 CandidatePool 被挂载，死代码判定不成立）。
 *  只用 CandidatePool 独有的结构类名与文案：「候选池」一词在 DayContent
 *  「移回候选池 N 项」按钮、GuideDraftReview「移出并回到候选池」、UndoToast
 *  撤销文案里都会合法出现，不能作为判据。 */
const POOL_SELECTORS = [".pool-section", ".pool-title", ".poolitem", ".reserve-group", ".pending-stop"];
const POOL_TEXTS = [
  "候选区（",
  "待定加入（",
  "个景区）",
  "这些玩法来自你的攻略",
  "备选玩法只放在所属大景区里",
  "候选区是空的",
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

let failures = 0;
const report = [];

/** 在页面内采集一次快照：违规文本 / 候选池特征 / 保留项计数 */
async function probe(label) {
  return page.evaluate(
    ([selectors, poolSelectors, poolTexts]) => {
      const bodyText = document.body.innerText || "";
      const nodes = [...document.querySelectorAll(selectors.join(","))].map((el) => ({
        sel: typeof el.className === "string" ? el.className : "",
        text: el.textContent ?? "",
      }));
      const poolNodes = [...document.querySelectorAll(poolSelectors.join(","))].map((el) => ({
        sel: typeof el.className === "string" ? el.className : "",
        text: (el.textContent ?? "").slice(0, 60),
      }));
      return {
        bodyText,
        nodes,
        poolNodes,
        poolTextHits: poolTexts.filter((t) => bodyText.includes(t)),
        // C. 保留项计数（证明没误伤）
        keep: {
          reserveBlock: document.querySelectorAll(".reserve-block").length,
          reserveToggle: document.querySelectorAll(".reserve-toggle").length,
          tags: document.querySelectorAll(".tag").length,
          freeTags: [...document.querySelectorAll(".tag")].filter((el) => el.textContent?.trim() === "免票").length,
          poiLevel: document.querySelectorAll(".tag.poi-level, .poi-level").length,
          poiRank: document.querySelectorAll(".poi-rank").length,
          parentSub: [...document.querySelectorAll(".parent-sub")].map((el) => el.textContent ?? ""),
          dayheadSub: [...document.querySelectorAll(".dayhead .s")].map((el) => el.textContent ?? ""),
          dayheadTitle: [...document.querySelectorAll(".dayhead .t")].map((el) => el.textContent ?? ""),
          constraints: [...document.querySelectorAll(".constraint")].map((el) => el.textContent ?? ""),
          candidateItems: document.querySelectorAll(".candidate-item").length,
          candidateMeta: [...document.querySelectorAll(".candidate-meta")].map((el) => el.textContent ?? ""),
          childCountChips: (bodyText.match(/含 \d+ 个岛内玩法/g) ?? []).length,
        },
      };
    },
    [SCAN_SELECTORS, POOL_SELECTORS, POOL_TEXTS],
  );
}

/** 校验一次快照：返回违规条目数组（空 = 通过） */
function audit(label, snap) {
  const bad = [];
  // A1. 定向选择器逐个查
  for (const node of snap.nodes) {
    if (SUGGEST_RE.test(node.text) || SUGGEST_LOOSE_RE.test(node.text)) {
      bad.push(`A [${label}] .${node.sel} 出现时长 chip：${node.text.slice(0, 60)}`);
    }
  }
  // A2. 全 DOM 兜底扫（攻略原文/snippet 属用户内容，命中时原文列出供人工判断）
  const bodyHits = snap.bodyText.match(SUGGEST_RE_G) ?? [];
  const looseHits = snap.bodyText.match(SUGGEST_LOOSE_RE_G) ?? [];
  if (bodyHits.length > 0 || looseHits.length > 0) {
    bad.push(`A [${label}] 全文出现「建议 X」时长文本：${[...new Set([...bodyHits, ...looseHits])].join(" / ")}`);
  }
  // B. 候选池 UI 不得出现（死代码证据）
  if (snap.poolNodes.length > 0) {
    bad.push(`B [${label}] 候选池 UI 被挂载：${snap.poolNodes.map((n) => `.${n.sel}="${n.text}"`).join("；")}`);
  }
  if (snap.poolTextHits.length > 0) {
    bad.push(`B [${label}] 候选池文案出现：${snap.poolTextHits.join(" / ")}`);
  }
  return bad;
}

/**
 * 关闭当前浮层：依次尝试组件自带的关闭按钮 → 遮罩点击 → Escape。
 * NoteInput 不绑 Escape（浮层 .note-input-overlay 会持续拦截指针事件），
 * 必须走 aria-label="关闭添加攻略" 按钮或遮罩 onClick。
 */
async function closeOverlay(targetPage) {
  for (const selector of [
    'button[aria-label="关闭添加攻略"]',
    'button[aria-label^="关闭"]',
    ".note-input-overlay",
    '[role="presentation"].note-input-overlay',
  ]) {
    const btn = targetPage.locator(selector).first();
    if ((await btn.count()) > 0) {
      try {
        await btn.click({ timeout: 2500, force: selector.includes("overlay") });
        await targetPage.waitForTimeout(700);
      } catch {
        /* 换下一个候选关闭方式 */
      }
    }
    const stillOpen = await targetPage.evaluate(
      () => document.querySelectorAll(".note-input-overlay, .sheet-overlay").length,
    );
    if (stillOpen === 0) break;
  }
  await targetPage.keyboard.press("Escape");
  await targetPage.waitForTimeout(400);
}

// ===== 主行程页：逐天 =====
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".dchip", { timeout: 30000 });
const chips = page.locator(".dchip");
const dayCount = await chips.count();
console.log(`主行程页 Day 数：${dayCount}`);

const totals = { reserveBlock: 0, tags: 0, freeTags: 0, poiLevel: 0, poiRank: 0, candidateItems: 0, childCountChips: 0 };
let parentSubSeen = 0;
let constraintTimeSeen = 0;
let dateRowOk = 0;

for (let i = 0; i < dayCount; i++) {
  await chips.nth(i).click();
  await page.waitForTimeout(900);
  const snap = await probe(`Day${i + 1}`);
  const bad = audit(`Day${i + 1}`, snap);
  if (bad.length > 0) {
    failures += bad.length;
    report.push(...bad);
  }

  // C. 保留项累计
  totals.reserveBlock += snap.keep.reserveBlock;
  totals.tags += snap.keep.tags;
  totals.freeTags += snap.keep.freeTags;
  totals.poiLevel += snap.keep.poiLevel;
  totals.poiRank += snap.keep.poiRank;
  totals.childCountChips += snap.keep.childCountChips;
  for (const sub of snap.keep.parentSub) {
    parentSubSeen++;
    if (!/岛内 \d+ 个点/.test(sub) || /约/.test(sub)) {
      failures++;
      report.push(`C Day${i + 1} 父卡汇总行异常（应保留计数、不含「约」）：${sub}`);
    }
  }
  for (const c of snap.keep.constraints) if (/\d{1,2}:\d{2}/.test(c)) constraintTimeSeen++;
  for (const t of snap.keep.dayheadTitle) if (/Day\d+\s*·\s*\d{2}\/\d{2}\s*周./.test(t)) dateRowOk++;

  await page.screenshot({ path: `/tmp/task343-day${i + 1}.png`, fullPage: true });
  report.push(
    `Day${i + 1} OK：dayhead=[${snap.keep.dayheadSub.join(" | ")}]，父卡=[${snap.keep.parentSub.join(" | ")}]，` +
      `约束=[${snap.keep.constraints.join(" | ")}]，.reserve-block=${snap.keep.reserveBlock}，` +
      `.tag=${snap.keep.tags}（免票 ${snap.keep.freeTags} / 等级 ${snap.keep.poiLevel} / 榜单 ${snap.keep.poiRank}），` +
      `候选池节点=${snap.poolNodes.length}`,
  );
}

// ===== 打开「＋ 添加攻略 / 地点」面板：NoteInput 候选池推荐区块取证 =====
const addBtn = page.locator("button", { hasText: "添加攻略" }).first();
if ((await addBtn.count()) > 0) {
  await addBtn.click();
  await page.waitForTimeout(1200);
  const snap = await probe("添加面板");
  const bad = audit("添加面板", snap);
  if (bad.length > 0) {
    failures += bad.length;
    report.push(...bad);
  }
  totals.candidateItems += snap.keep.candidateItems;
  await page.screenshot({ path: "/tmp/task343-addpanel.png", fullPage: true });
  report.push(
    `添加面板 OK：.candidate-item=${snap.keep.candidateItems}，` +
      `.candidate-meta=[${snap.keep.candidateMeta.slice(0, 4).join(" | ")}]，` +
      `「含 N 个岛内玩法」chip=${snap.keep.childCountChips}，候选池节点=${snap.poolNodes.length}（应为 0）`,
  );
  // 关闭浮层：用组件自带的关闭按钮（Escape 不绑在该浮层上），兼容回退到遮罩点击
  await closeOverlay(page);
} else {
  report.push("添加面板：未找到「＋ 添加攻略 / 地点」入口（跳过）");
}

// ===== 打开「更多操作」⋯ 菜单：确认无候选池入口 =====
const moreBtn = page.locator('button[aria-label="更多操作"]').first();
if ((await moreBtn.count()) > 0) {
  await moreBtn.click();
  await page.waitForTimeout(900);
  const snap = await probe("更多菜单");
  const bad = audit("更多菜单", snap);
  if (bad.length > 0) {
    failures += bad.length;
    report.push(...bad);
  }
  const menuTexts = await page.evaluate(() =>
    [...document.querySelectorAll('[role="menuitem"], .menu-item, .sheet-item, button')].map((el) =>
      (el.textContent ?? "").trim(),
    ).filter((t) => t !== "" && t.length < 30),
  );
  await page.screenshot({ path: "/tmp/task343-moremenu.png", fullPage: true });
  report.push(
    `更多菜单 OK：候选池节点=${snap.poolNodes.length}（应为 0），候选池文案命中=${snap.poolTextHits.length}，` +
      `菜单项=[${[...new Set(menuTexts)].slice(0, 18).join(" / ")}]`,
  );
  await closeOverlay(page);
} else {
  report.push("更多菜单：未找到「更多操作」入口（跳过）");
}

// ===== 保留项哨兵：断言不能全部为空跑 =====
if (parentSubSeen === 0) {
  failures++;
  report.push("C 全程未见「岛内 N 个点」父卡汇总行（保留项断言失效，可能页面未正常渲染）");
}
if (constraintTimeSeen === 0) {
  failures++;
  report.push("C 全程未见带时间的约束条（保留项断言失效）");
}
if (dateRowOk === 0) {
  failures++;
  report.push("C 全程未见日期行 Day N · MM/DD 周X（保留项断言失效）");
}
if (totals.tags === 0) {
  failures++;
  report.push("C 全程未见任何 .tag chip（保留项断言失效，可能误伤其他 chip）");
}

await browser.close();

console.log(report.map((line) => `  ${line}`).join("\n"));
console.log(`\n保留项汇总：父卡汇总行 ${parentSubSeen} 处 / 带时间约束 ${constraintTimeSeen} 处 / 日期行 ${dateRowOk} 处 / .tag ${totals.tags} 个（免票 ${totals.freeTags}、等级 ${totals.poiLevel}、榜单 ${totals.poiRank}）/ .candidate-item ${totals.candidateItems} 个 / 「含 N 个岛内玩法」${totals.childCountChips} 处 / .reserve-block ${totals.reserveBlock} 处`);
console.log(
  failures === 0
    ? "\n✅ Task #343 浏览器验收全部通过：无「建议 X」时长文本，候选池 UI 无挂载点（死代码判定成立），其余 chip 与保留项未误伤"
    : `\n❌ Task #343 浏览器验收失败 ${failures} 项`,
);
process.exit(failures === 0 ? 0 : 1);
