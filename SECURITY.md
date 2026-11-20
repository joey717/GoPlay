# 安全与密钥治理

本文件说明 GoPlay 仓库的密钥治理口径。**本仓库不包含任何真实密钥、Token 或凭证**，可安全公开。

## 1. 密钥一律不入库

- 所有外部服务凭证（阿里云百炼 / DashScope、飞猪 FlyAI）只在**部署者本机**通过 `.env` 或进程环境注入，从不提交到 Git。
- `.env` 已在 [`.gitignore`](.gitignore) 中排除；仓库只提供 [`.env.example`](.env.example) 模板。
- `.env.example` **只有变量名、值全为空**，不含任何真实值：

  | 变量 | 用途 |
  |---|---|
  | `DASHSCOPE_API_KEY` | 百炼 / DashScope 鉴权（Bearer） |
  | `BAILIAN_APP_ID` | 百炼 Managed Agent 应用 ID |
  | `BAILIAN_WORKSPACE_ID` | 百炼工作空间 ID |
  | `BAILIAN_ENVIRONMENT_ID` | 百炼环境 ID |
  | `FLYAI_API_KEY` | 飞猪 FlyAI 搜索 API Key |

- 运行时行程数据（`server/data/*.json`）、上传产物（`server/uploads/`）同样不入库，仅保留 `.gitkeep` 占位。

## 2. 缺失密钥时安全降级，不静默回落

- 百炼侧凭证缺失 → 抛 `ENV_NOT_CONFIGURED`（HTTP 503，安全中文文案），不发起上游请求。
- FlyAI 侧 `FLYAI_API_KEY` 缺失 → 在调用 CLI 子进程**之前**即抛 `FLYAI_NOT_CONFIGURED`（HTTP 503、不可重试），不启动子进程、不回落任何共享试用通道。
- 降级路径只返回可读错误提示，不崩溃、不伪造数据。

## 3. 日志与错误响应不打印明文密钥

- 启动与验证脚本只报告变量的「已配置 / 未配置」计数，绝不打印密钥值（见 [`server/src/env.ts`](server/src/env.ts)）。
- 错误响应体经安全化封装（`AiError` / `FlyAiError`），对外只暴露稳定错误码与安全文案。
- 日志脱敏器 [`redactSecretsForLog()`](server/src/flyai/errors.ts) 会把 `sk-` 令牌、`Bearer` 头、`key=value` 赋值形态替换为 `[已脱敏]` 后再落日志。

## 4. 测试桩令牌规范

- 单元测试 / 验证脚本中的**假令牌**禁止使用真实厂商的生产前缀（即 `sk-` 后紧跟 `live` / `proj` / `ant` 等形态），以免被 GitHub Secret Scanning / gitleaks 误判为泄漏。
- 统一使用明显不可能为真的占位形态，例如 `sk-FAKE-NOT-A-REAL-KEY-000000`、`Bearer FAKE-NOT-A-REAL-TOKEN`——仍满足脱敏正则 `\bsk-[A-Za-z0-9_-]{8,}\b`，但前缀绝不会与真实密钥重合。

## 5. 复现者须知

要在本机跑通真实的 AI 与搜索链路，请自行到阿里云百炼控制台与飞猪 FlyAI 平台申请密钥，`cp .env.example .env` 后填入本地 `.env`。密钥不随仓库提供，也不应提交回仓库。
