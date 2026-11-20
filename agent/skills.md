# Skills

## @fly-ai/flyai-cli

- 版本：1.0.16（CLI 不支持 `--version`，查询用 `npm view @fly-ai/flyai-cli version`）
- 接入方式：`server/src/flyai/client.ts` 以 `npx --yes @fly-ai/flyai-cli` 子进程直连，透传 `process.env`，90 秒超时
- 子命令：
  - `search-poi --city-name <城市> --keyword <关键词>`
  - `search-hotels --dest-name <目的地> --key-words <关键词> --check-in-date <YYYY-MM-DD> --check-out-date <YYYY-MM-DD>`
- 验证入口：
  - `npx tsx server/src/flyai/verify.ts`（search_poi + search_hotels 端到端，真实报文落盘）
  - `npx tsx server/src/flyai/verify-scope.ts`（目的地过滤回归验证）
- 真实样本路径：
  - [docs/flyai-samples/search-toolcall.json](../docs/flyai-samples/search-toolcall.json)（verify.ts 写入的原始报文 + 字段漂移对比）
- 已知坑：试用额度耗尽报 `MCP HTTP 429: Trial limit reached`，到 flyai.open.fliggy.com 控制台申请正式 API Key，不要当接口故障排查
