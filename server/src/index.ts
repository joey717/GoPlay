import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import "./env.js";
import { aiRoutes } from "./ai/routes.js";
import { xhsAssetRoutes } from "./ai/xhs.js";
import { bailianRoutes } from "./bailian/routes.js";
import { flyaiRoutes } from "./flyai/routes.js";
import { persistenceRoutes } from "./persistence/routes.js";
import { guideRoutes } from "./guides/routes.js";
import { shareHtmlRoutes, shareRoutes } from "./share/routes.js";

const app = new Hono();

app.use("/*", cors());

// 健康检查
app.get("/api/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));

// F11 意图编排主链路（prompt 组装 → 百炼 SSE → 护栏 → applyOps）
app.route("/api/ai", aiRoutes);
// Task #96：攻略来源（提交 / 状态 / 重试 / 移除 / 恢复 / 补充句）。
// 后台异步处理 GuideSource（抓取 / 抽取 / 图片队列），接口只做原子创建与状态读取。
app.route("/api/guides", guideRoutes);
// Task #87：小红书笔记图片受控读取（仅 xhs_{noteId}/{序号}.{ext}）。
// 同一实现挂两个前缀：
// - /api/uploads/...：返回给前端的规范路径（/api 前缀由 vite dev proxy 覆盖，
//   即使 dev server 未加载新增 proxy 规则也能出图）；
// - /uploads/...：兼容已下发过的旧路径（vite.config.ts 保留该前缀代理）。
// 非 xhs_ 目录的请求会在 xhsAssetRoutes 里 next() 交还给下方的 persistenceRoutes，
// 行程截图 /api/uploads/{uuid}/ev_shot_xxx.jpg 不受影响。
app.route("/api/uploads", xhsAssetRoutes);
app.route("/uploads", xhsAssetRoutes);
// 百炼底层 SSE 调试通道（Step 0 透传验证，跳过护栏）
app.route("/api/bailian", bailianRoutes);
app.route("/api/flyai", flyaiRoutes);
// Task #205：只读分享（每次现读最新行程，返回脱敏 SharedTrip，不落快照）。
// 挂在 /api 持久化路由之前，语义独立，不与 /api/trip/:tripId 共享可写入口。
app.route("/api/share", shareRoutes);
// Task #261：分享页 HTML（带 OG meta，根路径非 /api）。
// 社交平台爬虫不执行 JS，预览信息必须由服务端写进首屏；浏览器拿到的仍是
// 注入了 meta 的 SPA 模板（web/dist/index.html），页面渲染行为不变。
// 生产环境需要网关/nginx 把 /share/* 优先路由到这里（静态资源 /assets/* 仍由静态服务提供）。
app.route("/share", shareHtmlRoutes);
app.route("/api", persistenceRoutes);

const port = Number(process.env.PORT) || 8787;
console.log(`GoPlay server starting on port ${port}`);
serve({ fetch: app.fetch, hostname: "0.0.0.0", port }, (info) => {
  console.log(`GoPlay server running at http://0.0.0.0:${info.port}`);
});

export default app;