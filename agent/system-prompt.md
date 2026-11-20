# System Prompt

百炼 Managed Agent 会话**没有独立的 system 通道**：系统指令作为固定规则文本嵌入 user message 顶部，实现位置为 `server/src/ai/prompt.ts`：

- `FIXED_RULES_TEXT`：OperationSet JSON 输出契约（八个 op 名、索引与范围约定、引用规则），文本与 `shared/src/types/operations.ts` 严格一致
- `buildIntentPrompt(trip, intentText)`：F11 意图编排的行程摘要 + 候选池 + 用户意图组装
- `buildExtractPrompt(noteText)`：F5 攻略正文抽取的点位数组输出契约组装

模型输出由 `server/src/ai/pipeline.ts` / `server/src/ai/extract.ts` 解析归一化，并经 `shared/src/guards/index.ts` 四条护栏校验；prompt 规则只是前置引导，不是信任边界。修改输出契约时必须同步更新 `shared/src/types/operations.ts` 与本文件的实现位置，避免 prompt 与护栏脱节。
