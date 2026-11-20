import { Hono } from "hono";
import { createBailianSession } from "./client.js";

export const bailianRoutes = new Hono();

// POST /intent — 接收意图文本，调用百炼，返回事件序列和结果
// Step 0 仅做 SSE 透传验证，不接四条护栏
bailianRoutes.post("/intent", async (c) => {
  const body = await c.req.json<{ input: string }>();

  if (!body.input) {
    return c.json({ error: "缺少 input 字段" }, 400);
  }

  try {
    const result = await createBailianSession(body.input);
    return c.json({
      success: true,
      sessionId: result.sessionId,
      finalText: result.finalText,
      toolCalls: result.toolCalls,
      eventCount: result.events.length,
      latencyMs: result.latencyMs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});
