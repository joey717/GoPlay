import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // 固定 5173：端口被占用时直接失败退出，禁止静默漂移到 5174
    // （否则旧会话浏览器仍连 5173，所有 fetch 连接拒绝表现为 Failed to fetch）
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    // Task #205：只读分享页 /share/:tripId 由 Vite 默认的 SPA 回退渲染
    // （appType: "spa"，无扩展名的未知路径返回 index.html），
    // 由 App.tsx 手动解析 pathname 进入 share phase。
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
      // 小红书笔记图片：规范路径 /api/uploads/... 已被上面的 /api 代理覆盖；
      // 这条 /uploads 前缀仅兼容服务端仍可能下发的旧路径，
      // 少了它 <img src="/uploads/xhs_xxx/1.jpg"> 会落到 Vite 的 SPA 回退，表现为坏图。
      "/uploads": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
      // Task #261：分享页的 OG 预览 HTML 由服务端 GET /share/:tripId 提供（爬虫不执行 JS）。
      // 但开发环境的浏览器必须留在 Vite 里（SPA 回退 + HMR），否则会拿到 web/dist 里的
      // 旧 bundle（改代码不生效）。因此按请求类型分流：
      // - 浏览器导航（Accept 含 text/html）→ bypass 返回原 URL，继续命中 Vite 的 SPA 回退；
      // - 爬虫 / curl 这类预览请求（Accept 为 */*）→ 转发到 8787，拿到带 OG meta 的 HTML。
      // 生产环境由网关把 /share/* 优先路由到服务端（静态 /assets/* 仍由静态服务提供）。
      "/share": {
        target: "http://localhost:8787",
        changeOrigin: true,
        bypass: (req) =>
          String(req.headers.accept ?? "").includes("text/html") ? (req.url ?? "/") : undefined,
      },
    },
  },
});