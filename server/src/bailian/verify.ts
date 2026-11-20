import "../env.js";
import { createBailianSession } from "./client.js";

async function verify() {
  console.log("=== 百炼 Managed Agent SSE 验证 ===\n");

  // 检查环境变量（不打印值）
  const hasApiKey = !!process.env.DASHSCOPE_API_KEY;
  const hasAppId = !!process.env.BAILIAN_APP_ID;
  const hasWorkspaceId = !!process.env.BAILIAN_WORKSPACE_ID;
  const hasEnvironmentId = !!process.env.BAILIAN_ENVIRONMENT_ID;
  console.log(`DASHSCOPE_API_KEY: ${hasApiKey ? "✅ 已配置" : "❌ 未配置"}`);
  console.log(`BAILIAN_APP_ID: ${hasAppId ? "✅ 已配置" : "❌ 未配置"}`);
  console.log(
    `BAILIAN_WORKSPACE_ID: ${hasWorkspaceId ? "✅ 已配置" : "❌ 未配置"}`,
  );
  console.log(
    `BAILIAN_ENVIRONMENT_ID: ${hasEnvironmentId ? "✅ 已配置" : "❌ 未配置"}`,
  );

  if (!hasApiKey) {
    console.error("\n请先在 .env 中配置 DASHSCOPE_API_KEY");
    process.exit(1);
  }
  if (!hasAppId) {
    console.error("\n请先在 .env 中配置 BAILIAN_APP_ID（agent_ 前缀）");
    process.exit(1);
  }
  if (!hasWorkspaceId) {
    console.error("\n请先在 .env 中配置 BAILIAN_WORKSPACE_ID（ws_ 前缀）");
    process.exit(1);
  }
  if (!hasEnvironmentId) {
    console.error("\n请先在 .env 中配置 BAILIAN_ENVIRONMENT_ID（env_ 前缀）");
    process.exit(1);
  }

  const testInput = "帮我查三亚有什么好玩的";
  console.log(`\n发送测试意图: "${testInput}"\n`);

  try {
    const result = await createBailianSession(testInput);

    console.log("--- SSE 事件序列 ---");
    for (const event of result.events) {
      console.log(
        `[${event.timestamp}] ${event.type}`,
        event.type === "tool_call" ? `-> ${event.toolName}` : "",
        event.type === "text"
          ? `-> ${(event.content || "").slice(0, 100)}...`
          : "",
      );
    }

    console.log("\n--- 结果摘要 ---");
    console.log(`Session ID: ${result.sessionId || "N/A"}`);
    console.log(`总事件数: ${result.events.length}`);
    console.log(`Tool Call 数: ${result.toolCalls.length}`);
    console.log(`最终文本长度: ${result.finalText.length} 字符`);
    console.log(`总耗时: ${result.latencyMs}ms`);

    if (result.toolCalls.length > 0) {
      console.log("\n--- Tool Calls 详情 ---");
      for (const tc of result.toolCalls) {
        console.log(`工具: ${tc.toolName}`);
        console.log(`输入: ${JSON.stringify(tc.toolInput, null, 2)}`);
        const toolOutput = JSON.stringify(tc.toolOutput, null, 2);
        console.log(
          `输出预览: ${toolOutput?.slice(0, 500) ?? "N/A（见完整原始事件）"}`,
        );
        console.log("---");
      }
    }

    if (result.finalText) {
      console.log("\n--- 最终文本 ---");
      console.log(result.finalText);
    }

    // Step 0 记录完整原始事件，冻结 Managed Agent 实际 SSE 契约。
    console.log("\n--- 原始事件数据（完整） ---");
    for (const event of result.events) {
      console.log(JSON.stringify(event.data, null, 2));
      console.log("---");
    }

    console.log("\n✅ 百炼会话验证通过");
  } catch (err) {
    console.error("\n❌ 百炼会话验证失败:", (err as Error).message);
    // 打印完整错误以便调试
    console.error(err);
    process.exit(1);
  }
}

verify();
