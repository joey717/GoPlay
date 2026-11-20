/**
 * Task #261 分享链接 OG 预览自检（`npx tsx server/src/share/verify-og.ts`）。
 *
 * 断言口径：
 * 1. 未命名行程：og:title 是「城市 N天行程」，og:description 是「城市 · N天N晚 · 日期区间」；
 * 2. 有名称 / 备忘：标题用行程名，描述取备忘单行摘要（前 100 字 + 省略号）；
 * 3. 封面：相对路径换算成绝对地址 `/api/uploads/...`，并带 `v=` 版本号；无封面不给 og:image；
 * 4. og:url 为当前分享链接，全部标签做 HTML 转义（用户文案不能注入标签）；
 * 5. 注入 SPA 模板后保留 root / 入口 script，只替换 title 与追加 meta；
 * 6. 无构建产物时退化为「最小壳 + 跳转 Vite dev server」；
 * 7. 路由：GET /share/:tripId 返回 text/html + OG 标签 + no-store；非法 / 不存在 404；
 *    GET /api/share/:tripId/og 返回同一份预览数据；脱敏 JSON 路由行为不变（回归）。
 */

import assert from "node:assert/strict";
import { Hono } from "hono";
import type { Day, Trip } from "@goplay/shared";
import { buildFixtureSanyaTrip, tripStore } from "../persistence/store.js";
import { shareHtmlRoutes, shareRoutes } from "./routes.js";
import {
  buildShareOgData,
  escapeHtml,
  injectOgIntoHtml,
  memoExcerpt,
  renderOgShell,
  renderOgTags,
} from "./og.js";

const TRIP_ID = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-10-23T06:00:00.000Z";
const ORIGIN = "https://goplay.example.com";

function buildTrip(overrides: Partial<Trip> = {}): Trip {
  return { ...buildFixtureSanyaTrip(TRIP_ID, NOW), ...overrides };
}

/** 由 Trip 自身推导「城市 · N天N晚 · 日期区间」，避免把固定日期写死在断言里 */
function expectedMetaLine(trip: Trip): string {
  const days = trip.dayRefs
    .map((ref) => trip.days[ref])
    .filter((day): day is Day => day !== undefined)
    .sort((a, b) => a.dayIndex - b.dayIndex);
  const dayCount = days.length;
  const short = (date: string) => `${date.slice(5, 7)}/${date.slice(8, 10)}`;
  const start = short(days[0].date);
  const end = short(days[days.length - 1].date);
  const span = `${dayCount}天${dayCount - 1}晚`;
  return `${trip.destination.city} · ${span} · ${start}-${end}`;
}

async function main(): Promise<void> {
  // 1. 未命名 / 无备忘 / 无封面
  const bare = buildTrip();
  const bareOg = buildShareOgData(bare, TRIP_ID, ORIGIN);
  const bareDays = bare.dayRefs.length;
  assert.equal(bareOg.title, `三亚 ${bareDays}天行程`, "未命名行程用「城市 N天行程」");
  assert.equal(bareOg.description, expectedMetaLine(bare), "无备忘时描述用城市 · 天数 · 日期区间");
  assert.equal(bareOg.image, null, "无封面不输出 og:image");
  assert.equal(bareOg.url, `${ORIGIN}/share/${TRIP_ID}`, "og:url 为当前分享链接");
  assert.equal(bareOg.type, "website");
  assert.equal(bareOg.siteName, "GoPlay 去玩");

  // 2. 有名称 / 长备忘（200 字）→ 标题用名称，描述压平截断到 100 字 + 省略号
  const longMemo = `${"提前订船票，带好证件".repeat(10)}\n\n最后一天留白`;
  const namedOg = buildShareOgData(
    buildTrip({ tripName: "三亚亲子五日", memo: longMemo }),
    TRIP_ID,
    ORIGIN,
  );
  assert.equal(namedOg.title, "三亚亲子五日");
  assert.equal(Array.from(namedOg.description).length, 101, "描述 = 前 100 码点 + 省略号");
  assert.equal(namedOg.description.endsWith("…"), true);
  assert.equal(namedOg.description.includes("\n"), false, "描述必须是单行");

  // 3. 短备忘原样（仅压平空白）
  const shortOg = buildShareOgData(buildTrip({ memo: "带证件和泳衣\n记得带晕船药" }), TRIP_ID, ORIGIN);
  assert.equal(shortOg.description, "带证件和泳衣 记得带晕船药");

  // 4. 封面：相对路径 → 受控读取接口的绝对地址 + 版本号
  const coverOg = buildShareOgData(
    buildTrip({ coverImage: `uploads/${TRIP_ID}/cover.jpg`, version: 7 }),
    TRIP_ID,
    ORIGIN,
  );
  assert.equal(coverOg.image, `${ORIGIN}/api/uploads/${TRIP_ID}/cover.jpg?v=7`);
  const absoluteCoverOg = buildShareOgData(
    buildTrip({ coverImage: "https://cdn.example.com/c.jpg", version: 7 }),
    TRIP_ID,
    ORIGIN,
  );
  assert.equal(absoluteCoverOg.image, "https://cdn.example.com/c.jpg", "外链封面原样保留");

  // 5. 标签转义 + 结构
  const escapedOg = buildShareOgData(
    buildTrip({ tripName: '<script>alert("x")</script>', memo: "$& 不是替换模式" }),
    TRIP_ID,
    ORIGIN,
  );
  const tags = renderOgTags(escapedOg);
  assert.equal(tags.includes("<script>"), false, "用户文案必须转义");
  assert.equal(tags.includes("&lt;script&gt;"), true);
  assert.ok(tags.includes('<meta property="og:type" content="website" />'));
  assert.ok(tags.includes('<meta property="og:title" content='));
  assert.ok(tags.includes('<meta property="og:description" content='));
  assert.ok(tags.includes('<meta property="og:url" content='));
  assert.ok(tags.includes('<meta name="twitter:card" content="summary" />'), "无图用 summary 卡片");
  const withImageTags = renderOgTags(coverOg);
  assert.ok(withImageTags.includes('<meta property="og:image" content='));
  assert.ok(withImageTags.includes('<meta name="twitter:card" content="summary_large_image" />'));
  assert.equal(escapeHtml('a"b&c<d>'), "a&quot;b&amp;c&lt;d&gt;");

  // 6. 注入 SPA 模板：替换 title、追加 meta，不破坏 root / 入口 script
  const template = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8" /><title>GoPlay 去玩</title></head><body><div id="root"></div><script type="module" src="/assets/index-abc.js"></script></body></html>`;
  const injected = injectOgIntoHtml(template, escapedOg);
  assert.equal(injected.includes("<title>GoPlay 去玩</title>"), false, "title 被行程名替换");
  assert.equal(injected.includes(`<title>${escapeHtml(escapedOg.title)}</title>`), true);
  assert.equal(injected.includes('<div id="root"></div>'), true, "SPA 挂载点必须保留");
  assert.equal(injected.includes('src="/assets/index-abc.js"'), true, "入口脚本必须保留");
  assert.equal(/og:title[\s\S]*<\/head>/u.test(injected), true, "meta 必须落在 head 内");
  assert.equal(injected.includes("$&amp;"), true, "文案里的 $& 不被当成替换模式");

  // 7. 无构建产物：最小壳 + 跳转（爬虫只读 meta，浏览器被 JS 带走）
  const shell = renderOgShell(bareOg, "http://localhost:5173/share/x");
  assert.equal(shell.startsWith("<!DOCTYPE html>"), true);
  assert.ok(shell.includes('<meta property="og:title"'));
  assert.ok(shell.includes('location.replace("http://localhost:5173/share/x")'));

  // 8. 路由：HTML 通道 / JSON 通道 / 回归
  const app = new Hono();
  app.route("/api/share", shareRoutes);
  app.route("/share", shareHtmlRoutes);

  const originalLoad = tripStore.load;
  tripStore.load = async (tripId: string) => (tripId === TRIP_ID ? buildTrip({ memo: "带证件" }) : null);
  try {
    // Hono 的 app.request 不带 Host 头，与真实请求一致地显式给 Host（生产由 nginx 透传）
    const html = await app.request(`http://play.example.com/share/${TRIP_ID}`, {
      headers: { host: "play.example.com" },
    });
    assert.equal(html.status, 200);
    assert.equal(html.headers.get("content-type")?.includes("text/html"), true);
    assert.equal(html.headers.get("cache-control"), "no-store");
    const body = await html.text();
    assert.ok(body.includes('<meta property="og:title" content="三亚 '));
    assert.ok(body.includes('<meta property="og:description" content="带证件" />'));
    assert.ok(
      body.includes(`<meta property="og:url" content="http://play.example.com/share/${TRIP_ID}" />`),
    );
    assert.equal(body.includes('<div id="root">'), true, "浏览器拿到的仍是 SPA 壳");

    // 反代场景：og:url / og:image 跟着 X-Forwarded-* 走绝对地址
    const proxied = await app.request(`http://127.0.0.1:8787/share/${TRIP_ID}`, {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "play.example.com" },
    });
    assert.ok((await proxied.text()).includes('<meta property="og:url" content="https://play.example.com/share/'));

    const ogJson = await app.request(`http://play.example.com/api/share/${TRIP_ID}/og`, {
      headers: { host: "play.example.com" },
    });
    assert.equal(ogJson.status, 200);
    assert.equal(ogJson.headers.get("cache-control"), "no-store");
    const ogPayload = (await ogJson.json()) as { title: string; description: string; url: string };
    assert.equal(ogPayload.description, "带证件");
    assert.equal(ogPayload.url, `http://play.example.com/share/${TRIP_ID}`);

    const json = await app.request(`http://localhost/api/share/${TRIP_ID}`);
    assert.equal(json.status, 200, "脱敏 JSON 路由行为不变");
    assert.equal((await json.json() as { tripId: string }).tripId, TRIP_ID);
  } finally {
    tripStore.load = originalLoad;
  }

  // 9. 非法 / 不存在：两条通道都 404，不区分原因，且不产生写盘
  const missingHtml = await app.request("http://localhost/share/44444444-4444-4444-8444-444444444444");
  assert.equal(missingHtml.status, 404);
  assert.equal(missingHtml.headers.get("content-type")?.includes("text/html"), true);
  const missingBody = await missingHtml.text();
  assert.equal(missingBody.includes("noindex"), true, "失效链接不得被索引入索引");
  assert.equal(missingBody.includes("og:title"), false, "错误页不输出 OG（不能当行程预览）");
  const invalidHtml = await app.request("http://localhost/share/not-a-uuid");
  assert.equal(invalidHtml.status, 404);
  const missingOg = await app.request("http://localhost/api/share/44444444-4444-4444-8444-444444444444/og");
  assert.equal(missingOg.status, 404);

  // 10. memoExcerpt 纯函数：码点截断不切 emoji
  assert.equal(memoExcerpt("🎫".repeat(3)), "🎫🎫🎫");
  assert.equal(Array.from(memoExcerpt("🎫".repeat(101))).length, 101);

  console.log("verify-og: 10 组断言全部通过（OG 文案 / 转义 / 模板注入 / 路由行为）");
}

await main();
