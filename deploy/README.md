# GoPlay 部署参考（VPS）

> **状态：参考模板，待发布路径（沙箱 / VPS）定稿后细化。**
> 本文档描述单机 VPS 上以 Node 22 LTS + nginx/Caddy 部署 GoPlay 的参考步骤，
> 不含域名、TLS 证书、CI/CD 等定稿后才能确定的内容。

## 1. 架构概览

- **server**（Hono + @hono/node-server）：编译产物 `server/dist/index.js`，监听 `PORT`（默认 **8787**），只提供 API 与 `/share/*` 的 OG HTML，**不托管前端静态资源**。
- **web**（React + Vite）：构建产物 `web/dist/`（纯静态），由 nginx/Caddy 直接托管。
- **shared**：编译产物 `shared/dist/`，被 server 运行时引用（`npm run build` 已保证 shared → server → web 的构建顺序）。

## 2. 部署步骤（Node 22 LTS）

```bash
# 1) 准备 Node 22 LTS（示例用 nvm；发行版包管理器亦可）
nvm install 22 && nvm use 22
node -v   # 期望 v22.x

# 2) 拉取代码后安装依赖（锁定 package-lock.json，勿用 npm install）
npm ci

# 3) 构建（根级脚本，顺序 shared → server → web，不可拆开乱序）
npm run build
#   产物核对：shared/dist/index.js、server/dist/index.js、web/dist/index.html 均应存在
#   注意：server 运行时会读取 web/dist/index.html 作为分享页 SPA 模板（注入 OG meta），
#   所以 web 也必须构建，缺产物时分享页 OG 预览退化。

# 4) 配置环境变量（见第 3 节），然后启动
npm start          # 等价于 npm run start -w server → node dist/index.js
```

启动成功标志（stdout）：

```
[env] 已加载仓库根目录 .env，百炼变量 4/4 项已配置，FlyAI 变量 1/1 项已配置
GoPlay server starting on port 8787
GoPlay server running at http://0.0.0.0:8787
```

冒烟探活：

```bash
curl -sS http://127.0.0.1:8787/api/health
# 期望：{"status":"ok","timestamp":"..."} 且 HTTP 200
```

## 3. 环境变量注入清单（5 项必需）

**安全红线：以下取值一律通过部署环境的 `.env` 文件或进程环境注入，绝不写入代码库、绝不提交 git（仓库 `.gitignore` 已排除 `.env`）。** 模板见仓库根目录 `.env.example`。

| 变量 | 用途 | 取值来源 |
| --- | --- | --- |
| `DASHSCOPE_API_KEY` | 百炼 / DashScope API 调用凭证 | 阿里云百炼控制台「API-KEY 管理」 |
| `BAILIAN_APP_ID` | 百炼 Managed Agent 应用 ID | 百炼控制台对应应用详情页 |
| `BAILIAN_WORKSPACE_ID` | 百炼工作空间 ID | 百炼控制台工作空间管理页 |
| `BAILIAN_ENVIRONMENT_ID` | 百炼应用环境 ID | 百炼控制台应用的环境配置页 |
| `FLYAI_API_KEY` | FlyAI 正式搜索通道凭证 | FlyAI 平台密钥页；**缺失时搜索接口返回 503 FLYAI_NOT_CONFIGURED，不会回落共享试用通道** |

加载机制（`server/src/env.ts`）：

- 进程内已存在的环境变量**优先**，仓库根目录 `.env` 仅补缺（dotenv 默认不覆盖）——systemd `Environment=` / PM2 `env` 注入与 `.env` 文件二选一即可。
- `.env` 定位不依赖启动时的工作目录：从 `import.meta.url`（即 `server/dist`）向上查找含 `workspaces` 字段的 `package.json`，因此保持 monorepo 目录结构完整即可。
- 可选变量（有默认值，非部署必需）：`GUIDE_IMAGE_CONCURRENCY`（默认 6）、`ASSEMBLE_CONCURRENCY`（默认 6）、`PORT`（默认 8787），说明见 `.env.example`。

## 4. nginx / Caddy 反向代理要点

与 `web/vite.config.ts` 的 dev proxy 三条规则一一对应（`/api`、`/uploads`、`/share`），生产由网关承担同样职责；另见 `server/src/index.ts:40-44` 注释。

1. **静态托管 `web/dist`**：站点根指向 `web/dist/`，SPA 回退（无扩展名的未知路径 → `index.html`）；`/assets/*` 等带扩展名静态资源直接由静态服务提供，**不要**转给后端。
2. **`/api` 与 `/uploads` → `127.0.0.1:8787`**：
   - `/api/*`：全部业务接口（含规范图片路径 `/api/uploads/...`）。
   - `/uploads/*`：兼容历史已下发的旧图片路径，同样转后端。
3. **`/share/*` 按 Accept / UA 分流**（对应 dev proxy 的 bypass 规则）：
   - **社交平台爬虫**（Accept 为 `*/*`、UA 为爬虫）→ 转 `127.0.0.1:8787`，拿到服务端注入 OG meta 的首屏 HTML（爬虫不执行 JS，预览信息必须在首屏）。
   - **浏览器导航**（Accept 含 `text/html`）→ 静态 `index.html`（SPA 前端路由渲染分享页）。
   - 简化替代：后端 `/share/:tripId` 本身返回的就是注入了 OG meta 的 SPA 模板（`web/dist/index.html`），浏览器直接走后端渲染行为也不变；分流只是让浏览器请求少过一道后端。定稿时二选一即可。

nginx 参考片段（分流版）：

```nginx
server {
    listen 80;
    root /srv/goplay/web/dist;
    index index.html;

    location /api     { proxy_pass http://127.0.0.1:8787; }
    location /uploads { proxy_pass http://127.0.0.1:8787; }

    location /share/ {
        # 浏览器（Accept 含 text/html）走 SPA 静态回退；其余（爬虫）转后端拿 OG HTML
        if ($http_accept ~* "text/html") {
            rewrite ^ /index.html last;
        }
        proxy_pass http://127.0.0.1:8787;
    }

    location / { try_files $uri /index.html; }
}
```

Caddy 参考片段（分流版）：

```caddyfile
example.com {
    root * /srv/goplay/web/dist

    # /api 与 /uploads：全部转后端
    @backend path /api/* /uploads/*
    handle @backend {
        reverse_proxy 127.0.0.1:8787
    }

    # /share/*：浏览器导航（Accept 含 text/html）→ 静态 SPA 回退；
    # 其余（爬虫 Accept 为 */*）→ 后端注入 OG meta 的 HTML（与 vite dev bypass 同构）
    @shareBrowser {
        path /share/*
        header Accept *text/html*
    }
    handle @shareBrowser {
        try_files /index.html
        file_server
    }
    @shareCrawler path /share/*
    handle @shareCrawler {
        reverse_proxy 127.0.0.1:8787
    }

    # 其余路径：静态托管 + SPA 回退
    handle {
        try_files {path} /index.html
        file_server
    }
}
```

> Caddy 的 Accept 分流写法待定稿时按最终 Caddy 版本核对（`header` 匹配器 + 路由优先级），此处仅示意职责划分。

## 5. systemd / PM2 守护要点

**systemd**（推荐，`/etc/systemd/system/goplay.service`）：

```ini
[Unit]
Description=GoPlay server
After=network.target

[Service]
Type=simple
User=goplay
WorkingDirectory=/srv/goplay
Environment=PORT=8787
# 密钥用独立文件注入（chmod 600，属同用户），不要写进本 unit 文件
EnvironmentFile=/srv/goplay/.env.deploy
ExecStart=/usr/bin/node server/dist/index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

要点：

- `EnvironmentFile` 的文件格式是 `KEY=VALUE` 每行一条（与 `.env` 兼容，但**不支持** `export` 前缀与引号包裹值），权限 600，绝不入 git。
- 若走仓库根 `.env`（`server/src/env.ts` 自动加载），可省略 `EnvironmentFile`，二者并存时进程环境优先。
- 部署更新流程：`git pull && npm ci && npm run build && systemctl restart goplay`。

**PM2**（无 root / 不便用 systemd 时的替代）：

```bash
pm2 start server/dist/index.js --name goplay
pm2 save && pm2 startup   # 开机自启
```

要点：env 通过仓库根 `.env` 注入（同上机制）；改 env 后需 `pm2 restart goplay --update-env`。

## 6. 已知边界

- 数据落盘在 `server/data/`（行程 JSON），VPS 上需纳入备份策略；本文档不覆盖。
- server 绑定 `0.0.0.0`，公网暴露必须前置网关（不要裸奔 8787）。
- Node 版本下限 22 LTS：`server/dist` 为 ESM 产物，且 `@goplay/shared` 通过 `exports` 条件在原生 node 下解析到 `shared/dist`（tsx 开发态仍走源码，两条链路互不干扰）。
