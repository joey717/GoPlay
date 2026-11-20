# GoPlay 去玩

AI 旅行行程编排移动端网页应用：粘贴攻略 → 候选池 → 说一句话排一版 → 拖拽只动受影响的天。

- 亮点：渐进式细化（候选池 → 每日安排）、拖拽局部重算（改一处只动一处）、约束锁定（已定项不被 AI 推翻）。
- 商品数据全部来自飞猪 FlyAI 实时搜索，POI 与酒店带真实 `jumpUrl` / `detailUrl` 跳转，不写死假数据。

产品需求、验收口径与参赛说明见 [docs/contest/submission.md](docs/contest/submission.md)。

## 环境要求

- Node.js 22+（自带 npm 与 npx）
- 可访问阿里云百炼与飞猪 FlyAI 的网络环境

## 快速开始

```bash
# 1. 安装依赖（npm workspaces，一次性安装 shared / server / web 三个包）
npm install

# 2. 配置环境变量：复制模板并填入四个百炼变量（变量名见下文，密钥不入库）
cp .env.example .env

# 3. 一键启动（concurrently 同时拉起 server 与 web）
npm run dev
```

启动后访问地址：

| 服务 | 地址 | 说明 |
|---|---|---|
| Web | http://localhost:5173 | Vite dev server（`vite --host`，支持局域网访问） |
| Server | http://localhost:8787 | Hono 后端，持有密钥；`PORT` 可覆盖端口 |
| 健康检查 | http://localhost:8787/api/health | `GET /api/health`，返回 `{"status":"ok"}` |

Vite 将浏览器侧的 `/api` 请求代理到 `http://localhost:8787`（见 [web/vite.config.ts](web/vite.config.ts)），前端不直接读环境变量。

## 常用命令

均以 npm workspaces 编排，定义在根 [package.json](package.json)：

```bash
npm run dev        # 同时启动 server（tsx watch）与 web（vite）
npm run typecheck  # 按 shared → server → web 串行执行 tsc --noEmit
npm run build      # 按 shared → server → web 串行构建（shared 产物供另两个包消费）
```

## 环境变量

复制 [.env.example](.env.example) 为 `.env` 后填写。`.env` 已被 [.gitignore](.gitignore) 排除，严禁提交。

### 百炼 Managed Agent（必填，共 4 个）

| 变量名 | 约束 |
|---|---|
| `DASHSCOPE_API_KEY` | DashScope API Key（Bearer 鉴权） |
| `BAILIAN_APP_ID` | `agent_` 前缀的 Managed Agent ID（代码强制校验前缀） |
| `BAILIAN_WORKSPACE_ID` | 业务空间 ID（不强制前缀，实际值可能为 `ws_`、`llm-` 等） |
| `BAILIAN_ENVIRONMENT_ID` | `env_` 前缀的运行环境 ID（代码强制校验前缀） |

变量值从阿里云百炼控制台获取；本文档不记录任何密钥或 ID 值。

### FlyAI（飞猪）

- FlyAI 走 `@fly-ai/flyai-cli` CLI 子进程，服务端把当前进程环境变量整体透传给子进程（见 [server/src/flyai/client.ts](server/src/flyai/client.ts)）。
- CLI 试用额度耗尽时会报 `Trial limit reached`（MCP HTTP 429），需到 flyai.open.fliggy.com 控制台申请正式 API Key，按 CLI 自身要求配置后即可被透传环境命中。
- 专用变量名以 CLI 要求为准，定案后在 [.env.example](.env.example) 中补充。

### 其他

| 变量名 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | Server 监听端口 |

## 外部服务接入

### 百炼 Managed Agent（AI 意图与抽取）

- 不走普通应用的 completion 端点，走 Managed Agent 专用端点 `/api/v1/agentstudio`（北京地域），完整 base URL 形如 `https://{BAILIAN_WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com/api/v1/agentstudio`。
- 采用**短会话 SSE**：每次意图调用 `创建 Session → 订阅 SSE 流（Accept: text/event-stream）→ POST 用户 Event → 读取事件直到 session_status 为 idle/terminated`。事件类型含 `session_status` / `text` / `model_request_start` / `model_request_end` / `tool_call` 等，`text` 事件拼接为最终输出。
- 整链路 60 秒超时；失败不自动重放，避免重复执行工具产生额外费用（计费按会话时长）。实现见 [server/src/bailian/client.ts](server/src/bailian/client.ts)。
- 连通性验证入口（发送一条测试意图并打印 SSE 事件序列，不打印任何密钥）：

```bash
npx tsx server/src/bailian/verify.ts
```

### FlyAI（飞猪 POI / 酒店实时搜索）

- 通过 `@fly-ai/flyai-cli`（v1.0.16，已作为 server 依赖安装）子进程直连：Task #335 起用 `node dist/flyai-bundle.cjs search-poi / search-hotels` 直跑，省去每次 npx 的 npm 解析开销（单次搜索 3.7s → 0.8〜1.7s）；bundle 解析失败自动退回 `npx --yes @fly-ai/flyai-cli`，主链路不挂。90 秒超时，输出按契约归一化为 `FliggyPoi` / `HotelCandidate`，不做任何本地伪造。
- `@fly-ai/flyai-cli` 已发布在公网 npm（registry.npmjs.org），`npm install` 直接安装即可，无需任何自定义 `.npmrc` registry 配置（Task #381 已实证公网可下载、同版本同 shasum）。
- 服务端搜索缓存（Task #335）：同一「城市 + 关键词」（酒店含入离日期）24 小时内复用，命中零额度、零延迟，落盘 `server/cache/flyai/`（可再生、不入库）；设 `FLYAI_SEARCH_CACHE=0` 可整体禁用退回每次真调。与评测录制/回放缓存 `eval/cache/flyai/` 物理隔离、语义不同（见 [server/src/flyai/searchCache.ts](server/src/flyai/searchCache.ts)）。
- POI 搜索带服务端目的地过滤；酒店搜索为结构化参数（目的地 + 片区 + 日期），服务端叠加城市权威过滤与片区半径/本地标记过滤，无法确认归属的结果一律丢弃。
- 验证入口（真实调用并落盘原始报文，失败不写样本）：

```bash
npx tsx server/src/flyai/verify.ts         # search_poi + search_hotels 端到端验证
npx tsx server/src/flyai/verify-scope.ts   # 「西岛」目的地过滤回归验证
npx tsx server/src/flyai/verify-hotels.ts  # 全部 6 片区酒店候选过滤回归验证（Task #45）
```

- 真实报文样本：[docs/flyai-samples/search-toolcall.json](docs/flyai-samples/search-toolcall.json)（由 `verify.ts` 写入）。

## 服务端 API 一览

| 方法与路径 | 说明 | 实现文件 |
|---|---|---|
| `GET /api/health` | 健康检查 | [server/src/index.ts](server/src/index.ts) |
| `POST /api/ai/intent` | F11 意图编排：`{tripId, input}` → clarify / applied / proposal / rejected | [server/src/ai/routes.ts](server/src/ai/routes.ts) |
| `POST /api/ai/intent/confirm` | 提案确认二次下发：敏感操作落地，确认不豁免护栏 | [server/src/ai/routes.ts](server/src/ai/routes.ts) |
| `POST /api/ai/extract` | F5 攻略正文抽取：`{tripId, text, sourceUrl?}` → 点位入候选池 | [server/src/ai/extract.ts](server/src/ai/extract.ts) |
| `POST /api/bailian/intent` | 百炼 SSE 透传调试通道（跳过护栏，仅排障用） | [server/src/bailian/routes.ts](server/src/bailian/routes.ts) |
| `GET /api/flyai/search` | `type=poi&q=...[&destination=...]` 或 `type=hotel&q=...&checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD` | [server/src/flyai/routes.ts](server/src/flyai/routes.ts) |
| `POST /api/trip` / `GET·PUT /api/trip/:tripId` | 行程创建 / 读取 / 全量保存 | [server/src/persistence/routes.ts](server/src/persistence/routes.ts) |

持久化为每 `tripId` 一份 JSON 文件（`server/data/{tripId}.json`），先写 `.tmp.json` 再 rename 的原子写入。

## 演示指引

### F5 攻略粘贴抽取

前置：已完成初始化向导（目的地与日期 → 同行人与偏好 → 已定约束 → 住宿片区意向，见 [web/src/components/InitFlow.tsx](web/src/components/InitFlow.tsx)）。

1. 在行程页点「粘贴攻略」打开底部弹层。
2. **只粘贴笔记/攻略正文**到文本框（推荐直接复制小红书等平台的文字内容）。
3. 笔记链接输入框**可选**：链接仅记录为 `sourceUrl` 用于来源展示，系统不解析、不抓取，也**不会向小红书等站点发起任何请求**（可在浏览器网络面板核验）。
4. 点「抽取点位」：百炼抽取点位 → 逐个走 FlyAI `search_poi` 真实对齐 → 同名去重 → 自动入候选池。
5. 结果中「飞猪已收录」的点位带真实 `jumpUrl`；未命中的降级为「自定义点位」（不伪造链接与图片，无坐标不参与交通估算）。

### F11 说一句话改行程

前置：候选池已有若干点位（可来自 F5 或候选池搜索框）。

1. 在意图输入框用自然语言下指令，七类操作均可触发：

| 意图类型 | 例句 |
|---|---|
| `plan` 整排 | 「Day2 重点去蜈支洲岛一整天，Day4 带我妈别太累，其他随便排」 |
| `move` 同日改序 | 「把鹿回头放到最后」 |
| `transfer` 跨天移动 | 「把蜈支洲岛挪到明天」 |
| `remove` 移除 | 「把水上项目都去掉」→ 出提案卡片，确认后移回候选池（非删除） |
| `setTime` 改时间 | 「Day2 早点出发」 |
| `setDuration` 改时长 | 「水世界玩半天就行」 |
| `setPurchase` / `lock` 状态 | 「蜈支洲岛门票我买好了」「锁定蜈支洲岛」→ 提案确认后生效 |

2. `remove` / `setPurchase` / `lock` 属敏感操作，先渲染提案卡片，确认后才经 `/api/ai/intent/confirm` 落地；说「随便改改」这类模糊意图时系统只反问、不执行。
3. 任何失败路径（超时 60s、JSON 解析失败重试一次后仍失败、整批拒绝）都不会清空或打乱已有行程。

### 四条护栏（服务端强制，前端不信任模型输出）

1. **操作合法性**：`itemId` 必须存在于当前行程或候选池，`dayIndex`/`toDay` 落在行程范围内，`op` 限于白名单（七类意图、八个 op 名，`setPurchase` 与 `lock` 同属状态切换类），否则该条丢弃并计数。
2. **候选池边界**：`proposedNew` 名称必须先经真实 `search_poi` 验证，命中才入候选池（标 `addedBy=ai_proposed`），未命中直接丢弃，绝不静默新增未经验证的点位。
3. **锁定与约束**：自动 `plan` 不得动已锁/已购项；对 `locked=true` 或 `purchaseState=bought` 项的操作须用户点名并逐项确认，且保留锁标记、不自动改真实订单。
4. **重排保护**：`userAdjusted=true` 的项只有被**显式**操作（带 `reason`）才可改动；`plan` 中悄悄省略视为越界，该项保留原位。

被丢弃操作占比超过 30% 时整批拒绝、行程逐字段不变；未超阈值时丢弃违规条目、其余照常应用并提示。实现见 [shared/src/guards/index.ts](shared/src/guards/index.ts) 与 [server/src/ai/pipeline.ts](server/src/ai/pipeline.ts)。

## 项目结构

```
shared/   前后端共享契约：类型定义、操作执行器 applyOps、四条护栏、时间轴计算（唯一实现）
server/   Hono 后端（端口 8787）：ai/（F5+F11 流水线）、bailian/（百炼 SSE）、flyai/（CLI 直连）、persistence/
web/      Vite + React 前端（端口 5173，dnd-kit 触控拖拽）
agent/    AI 编码助手复现说明（环境变量 / 技能 / 提示词）
docs/     技术文档与 FlyAI 真实报文样本
```

手工操作与 AI 操作统一收敛到 `shared` 的 `applyOps`：前端乐观更新、服务端权威校验，差异仅允许出现在确认时机。

## 安全与数据

- `.env` 含密钥，已被 [.gitignore](.gitignore) 排除，不入库；仓库只保留 `.env.example` 模板。
- `server/data/*.json` 为运行时行程数据，不入库（目录保留 `.gitkeep`）；`node_modules/`、`dist/`、`*.tmp.json` 同样被排除。
- 日志与验证脚本只打印变量「已配置/未配置」，不打印明文密钥。

## 当前限制（如实说明）

- **截图抽取未上线**：F5 目前仅支持粘贴正文，界面上的「截图抽取」按钮为禁用态（视觉模型可用性待核实，见 PRD R9）。
- 笔记链接只记录来源，不做链接抓取（小红书无公开正文接口，属合规与稳定性选择，见 PRD「不做项」）。
- 酒店价格与库存以飞猪详情页为准，应用内不承诺实时库存；订单不同步，「已购」为用户手动确认状态。
- F11 依赖百炼 Managed Agent 输出稳定性，解析失败自动重试一次，仍失败则保留原行程。
- 交通时长在无路线服务时按坐标估算并在界面标注「估算」；轮渡等特殊交通段不参与时间累加。
