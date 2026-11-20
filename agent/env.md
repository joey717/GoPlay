# 环境变量

完整模板见根目录 [.env.example](../.env.example)：复制为 `.env` 后填写。`.env` 已被 [.gitignore](../.gitignore) 排除，不入库。

## 百炼 Managed Agent（必填，4 个）

| 变量名 | 用途 | 约束 |
|---|---|---|
| `DASHSCOPE_API_KEY` | DashScope API Key，Bearer 鉴权 | 必填 |
| `BAILIAN_APP_ID` | Managed Agent 应用 ID | 必填，`agent_` 前缀（代码强制校验） |
| `BAILIAN_WORKSPACE_ID` | 业务空间 ID | 必填，不强制前缀（实际值可为 `ws_`、`llm-` 等） |
| `BAILIAN_ENVIRONMENT_ID` | 运行环境 ID | 必填，`env_` 前缀（代码强制校验） |

值从阿里云百炼控制台获取，本文档不记录任何密钥或 ID 值。

## 其他

| 变量名 | 默认 | 用途 |
|---|---|---|
| `PORT` | `8787` | Server 监听端口 |

## FlyAI

`@fly-ai/flyai-cli` 子进程继承服务端进程环境变量（`process.env` 整体透传，见 `server/src/flyai/client.ts`）；专用变量名以 CLI 要求为准，试用额度耗尽时到 flyai.open.fliggy.com 控制台申请正式 API Key。
