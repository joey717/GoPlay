import { getMissingBailianVars } from "../env.js";

// Managed Agents 当前仅支持北京地域，Endpoint 必须包含业务空间 ID。
const BAILIAN_REGION = "cn-beijing";

export interface BailianEvent {
  type:
    | "model_request_start"
    | "model_request_end"
    | "tool_call"
    | "session_status"
    | "text"
    | "unknown";
  timestamp: string;
  data?: unknown;
  // tool_call 专有
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  // text 专有
  content?: string;
  // session_status 专有
  status?: string;
}

export interface BailianResult {
  events: BailianEvent[];
  finalText: string;
  toolCalls: BailianEvent[];
  latencyMs: number;
  /** 本轮实际使用的 Session ID（新建或复用，总是非空；多轮会话回传即可续接上下文） */
  sessionId: string;
}

/**
 * 超时专有错误类型（Task #42）：调用方可据类型区分「处理超时」与
 * 「响应格式异常」等其他失败，不再靠错误消息字符串匹配。
 */
export class BailianTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`百炼 Managed Agent 请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    this.name = "BailianTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * 会话选项：
 * - timeoutMs 默认 60000（F11 60s 预算），捕获 / 调试场景可放宽；
 * - sessionId（Task #70 多轮会话）：提供时复用已有 Session（跳过创建，直接订阅
 *   SSE + 追加 Event），百炼 idle 态 Session 支持多轮；不校验状态，由调用方
 *   （pipeline）先行 getSessionStatus 决定是否传入；
 * - title：新建 Session 时的标题（便于控制台识别行程来源）；复用时忽略。
 */
export interface BailianSessionOptions {
  timeoutMs?: number;
  sessionId?: string;
  title?: string;
}

/**
 * Managed Agent Event 的 content 块（Task #51 截图 OCR）：
 * - text：纯文本指令（与既有纯字符串输入等价）；
 * - image：引用已上传到百炼 File API 的图片（file_id；实测不支持 base64 直传）。
 */
export type BailianContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; file_id: string };

/** 待上传到百炼的图片（仅元信息进日志，绝不打印文件内容） */
export interface BailianFileInput {
  /** 文件二进制内容（仅用于上传，不进任何日志 / 错误消息） */
  data: Uint8Array;
  filename: string;
  mimeType: string;
}

/** File API 返回的文件记录（id + 状态 + 元信息，不含内容） */
export interface BailianFileRecord {
  id: string;
  status: "checking" | "available" | "rejected" | "type_rejected";
  filename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
}

/** 文件审核未通过（rejected / type_rejected）：调用方映射为 IMAGE_REJECTED */
export class BailianFileRejectedError extends Error {
  readonly fileStatus: string;

  constructor(fileStatus: string) {
    super(`百炼文件审核未通过（${fileStatus}），请更换图片后重试`);
    this.name = "BailianFileRejectedError";
    this.fileStatus = fileStatus;
  }
}

/** 文件等待 available 超时（状态轮询超出预算）：调用方映射为 OCR_TIMEOUT */
export class BailianFileWaitTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`百炼文件状态等待超时（${Math.round(timeoutMs / 1000)} 秒）`);
    this.name = "BailianFileWaitTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** 已解析的百炼连接配置：Session API 与 File API（Task #51）共用 */
interface BailianConfig {
  baseUrl: string;
  apiKey: string;
  agentId: string;
  environmentId: string;
}

/**
 * 解析并校验百炼环境变量：变量名缺失 / 前缀不合法直接抛错，
 * 只报告变量名，绝不打印或返回密钥值。
 */
function resolveBailianConfig(): BailianConfig {
  const missing = getMissingBailianVars();
  if (missing.length > 0) {
    // 只报告变量名，绝不打印或返回密钥值
    throw new Error(`百炼环境变量未配置：${missing.join("、")}（请检查仓库根目录 .env 后重启服务）`);
  }
  const apiKey = process.env.DASHSCOPE_API_KEY;
  const agentId = process.env.BAILIAN_APP_ID;
  const workspaceId = process.env.BAILIAN_WORKSPACE_ID;
  const environmentId = process.env.BAILIAN_ENVIRONMENT_ID;

  if (!apiKey) throw new Error("DASHSCOPE_API_KEY 未配置");
  if (!agentId) throw new Error("BAILIAN_APP_ID 未配置");
  if (!workspaceId) throw new Error("BAILIAN_WORKSPACE_ID 未配置");
  if (!environmentId) throw new Error("BAILIAN_ENVIRONMENT_ID 未配置");
  if (!agentId.startsWith("agent_")) {
    throw new Error("BAILIAN_APP_ID 必须是 agent_ 前缀的 Managed Agent ID");
  }
  // workspace ID 不强制前缀校验：文档示例 ws_ 开头，实际可为 llm- 等前缀
  if (!environmentId.startsWith("env_")) {
    throw new Error("BAILIAN_ENVIRONMENT_ID 必须是 env_ 前缀的运行环境 ID");
  }

  return {
    baseUrl: `https://${workspaceId}.${BAILIAN_REGION}.maas.aliyuncs.com/api/v1/agentstudio`,
    apiKey,
    agentId,
    environmentId,
  };
}

/**
 * 调用 Managed Agent 跑一轮会话并读取 SSE 事件流（Task #70 支持多轮复用）。
 *
 * 新建路径调用顺序：创建 Session -> 建立 SSE -> 发送用户 Event -> 等待 idle；
 * 复用路径（options.sessionId）：跳过创建 -> 建立 SSE -> 追加用户 Event -> 等待 idle
 * （顺序与新建一致：必须先订阅 SSE 再发 Event，否则错过全部事件）。
 * input 支持纯文本（既有调用不变）或 content blocks（text + image file_id，
 * Task #51 截图 OCR）。超时：默认 60 秒（F11 预算），可用 options.timeoutMs 放宽。
 * 失败不自动重放，避免重复执行工具并产生额外费用。
 */
export async function createBailianSession(
  input: string | BailianContentBlock[],
  options: BailianSessionOptions = {},
): Promise<BailianResult> {
  const config = resolveBailianConfig();
  const blocks: BailianContentBlock[] =
    typeof input === "string" ? [{ type: "text", text: input }] : input;
  if (blocks.length === 0) {
    throw new Error("百炼 Event 输入不能为空：至少需要一个 text 或 image 内容块");
  }
  return runManagedAgent(config, blocks, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, {
    sessionId: options.sessionId,
    title: options.title,
  });
}

async function runManagedAgent(
  config: BailianConfig,
  blocks: BailianContentBlock[],
  timeoutMs: number,
  session: { sessionId?: string; title?: string } = {},
): Promise<BailianResult> {
  const startTime = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  };

  try {
    let sessionId: string;
    if (session.sessionId !== undefined && session.sessionId !== "") {
      // 多轮复用（Task #70）：Session 已存在（idle 态），跳过创建直接续接上下文；
      // 本函数不校验状态——调用方应先经 getSessionStatus 确认可复用
      sessionId = session.sessionId;
    } else {
      const sessionBody: Record<string, unknown> = {
        agent: { type: "agent", id: config.agentId },
        environment_id: config.environmentId,
      };
      if (session.title !== undefined && session.title !== "") {
        sessionBody.title = session.title;
      }
      const created = await requestJson(
        `${config.baseUrl}/sessions`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(sessionBody),
          signal: controller.signal,
        },
        "创建 Session",
      );
      const createdId = typeof created.id === "string" ? created.id : undefined;
      if (!createdId?.startsWith("sesn_")) {
        throw new Error("百炼 Managed Agent 未返回有效的 Session ID");
      }
      sessionId = createdId;
    }

    const streamResponse = await fetch(
      `${config.baseUrl}/sessions/${sessionId}/events/stream`,
      {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          Accept: "text/event-stream",
        },
        signal: controller.signal,
      },
    );
    await assertResponseOk(streamResponse, "订阅 SSE");
    if (!streamResponse.body) {
      throw new Error("百炼 Managed Agent 未返回 SSE 流");
    }

    await requestJson(
      `${config.baseUrl}/sessions/${sessionId}/events`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          input: [
            {
              role: "user",
              type: "message",
              content: blocks,
            },
          ],
        }),
        signal: controller.signal,
      },
      "发送 Event",
    );

    const events = await readEventStream(streamResponse.body);
    const finalText = events
      .filter((event) => event.type === "text" && event.content)
      .map((event) => event.content)
      .join("");
    const toolCalls = events.filter((event) => event.type === "tool_call");

    return {
      events,
      finalText,
      toolCalls,
      latencyMs: Date.now() - startTime,
      sessionId,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new BailianTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestJson(
  url: string,
  init: RequestInit,
  operation: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  await assertResponseOk(response, operation);
  return (await response.json()) as Record<string, unknown>;
}

async function assertResponseOk(
  response: Response,
  operation: string,
): Promise<void> {
  if (response.ok) return;

  const body = await response.text();
  const requestId = response.headers.get("x-request-id");
  const requestSuffix = requestId ? `，request_id=${requestId}` : "";
  throw new Error(
    `百炼 Managed Agent ${operation}失败 ${response.status}${requestSuffix}: ${body}`,
  );
}

async function readEventStream(
  stream: ReadableStream<Uint8Array>,
): Promise<BailianEvent[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const events: BailianEvent[] = [];
  let buffer = "";
  let finished = false;

  while (!finished) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const event = parseSSEFrame(frame);
      if (!event) continue;
      events.push(event);
      if (
        event.type === "session_status" &&
        (event.status === "idle" || event.status === "terminated")
      ) {
        finished = true;
        break;
      }
    }
  }

  if (finished) await reader.cancel();
  return events;
}

function parseSSEFrame(frame: string): BailianEvent | undefined {
  const dataText = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!dataText || dataText === "[DONE]") return undefined;

  try {
    return parseSSEData(JSON.parse(dataText) as Record<string, unknown>);
  } catch {
    return {
      type: "unknown",
      timestamp: new Date().toISOString(),
      data: dataText,
    };
  }
}

function parseSSEData(data: Record<string, unknown>): BailianEvent {
  const timestamp =
    typeof data.created_at === "string"
      ? data.created_at
      : new Date().toISOString();
  const eventType = typeof data.type === "string" ? data.type : "unknown";
  const content = Array.isArray(data.content)
    ? (data.content as Array<Record<string, unknown>>)
    : [];

  if (eventType === "model_request_start" || eventType === "model_request_end") {
    return { type: eventType, timestamp, data };
  }

  if (eventType === "message") {
    const text = content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("");
    if (text) return { type: "text", timestamp, content: text, data };
  }

  if (
    eventType === "tool_call" ||
    eventType === "function_call" ||
    eventType === "mcp_call"
  ) {
    const payload = getDataBlock(content);
    return {
      type: "tool_call",
      timestamp,
      toolName:
        typeof payload?.name === "string" ? payload.name : eventType,
      toolInput: payload?.arguments,
      data,
    };
  }

  if (eventType === "session_status") {
    const payload = getDataBlock(content);
    return {
      type: "session_status",
      timestamp,
      status:
        typeof payload?.session_status === "string"
          ? payload.session_status
          : "unknown",
      data,
    };
  }

  return { type: "unknown", timestamp, data };
}

function getDataBlock(
  content: Array<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const block = content.find(
    (item) => item.type === "data" && typeof item.data === "object",
  );
  return block?.data as Record<string, unknown> | undefined;
}

// ===== Session 状态与归档（Task #70 多轮会话） =====

/**
 * 查询 Session 状态（GET /sessions/{id}，多轮复用前置检查）。
 * 正常返回 idle / running / terminated 等服务端原始状态；
 * 查询失败（网络 / 鉴权 / 404 / 响应形状未知）返回 { status: "unknown" }，
 * 不抛错——调用方（pipeline.executeIntent）对非 idle 一律按「不可复用、新建」处理，
 * 查询失败降级为新建不会阻塞业务。
 */
export interface BailianSessionStatus {
  status: string;
}

export async function getSessionStatus(sessionId: string): Promise<BailianSessionStatus> {
  try {
    const config = resolveBailianConfig();
    const response = await fetch(
      `${config.baseUrl}/sessions/${encodeURIComponent(sessionId)}`,
      { headers: { Authorization: `Bearer ${config.apiKey}` } },
    );
    if (!response.ok) {
      console.warn(`[Bailian] 查询 Session 状态失败 HTTP ${response.status}（sessionId=${sessionId}）`);
      return { status: "unknown" };
    }
    const data = (await response.json()) as Record<string, unknown>;
    // 状态字段位置不做单一假设：顶层 status / session_status / data 块内嵌套均可
    const nested = data.data;
    const nestedRecord =
      typeof nested === "object" && nested !== null
        ? (nested as Record<string, unknown>)
        : undefined;
    const rawStatus =
      typeof data.status === "string"
        ? data.status
        : typeof data.session_status === "string"
          ? data.session_status
          : typeof nestedRecord?.session_status === "string"
            ? nestedRecord.session_status
            : typeof nestedRecord?.status === "string"
              ? nestedRecord.status
              : undefined;
    if (rawStatus === undefined) {
      console.warn(`[Bailian] Session 状态响应缺少状态字段（sessionId=${sessionId}），按 unknown 处理`);
      return { status: "unknown" };
    }
    return { status: rawStatus };
  } catch (error) {
    console.warn(
      `[Bailian] 查询 Session 状态异常（sessionId=${sessionId}）：${error instanceof Error ? error.message : String(error)}`,
    );
    return { status: "unknown" };
  }
}

/**
 * 归档 Session（POST /sessions/{id}/archive，多轮会话收尾：行程完成 / 重开时调用）。
 * 归档失败不抛错、只返回 false：收尾动作不应阻塞业务主流程，
 * 与 deleteBailianFile 同一容错策略。
 */
export async function archiveSession(sessionId: string): Promise<boolean> {
  try {
    const config = resolveBailianConfig();
    const response = await fetch(
      `${config.baseUrl}/sessions/${encodeURIComponent(sessionId)}/archive`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
      },
    );
    if (response.ok) return true;
    console.warn(`[Bailian] 归档 Session 失败 HTTP ${response.status}（sessionId=${sessionId}）`);
    return false;
  } catch (error) {
    console.warn(
      `[Bailian] 归档 Session 异常（sessionId=${sessionId}）：${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

// ===== File API（Task #51 截图 OCR：上传 / 查状态 / 删除） =====

/** File API 默认超时（上传较大图片可能偏慢，比 Event 请求略放宽） */
const FILE_TIMEOUT_MS = 60_000;

/** 文件状态轮询间隔 */
const FILE_POLL_INTERVAL_MS = 1_000;

/** 把 File API 响应归一为 BailianFileRecord（未知状态按 checking 继续轮询） */
function normalizeFileRecord(value: Record<string, unknown>): BailianFileRecord {
  const status = value.status;
  return {
    id: typeof value.id === "string" ? value.id : "",
    status:
      status === "available" ||
      status === "rejected" ||
      status === "type_rejected" ||
      status === "checking"
        ? status
        : "checking",
    filename: typeof value.filename === "string" ? value.filename : null,
    mimeType: typeof value.mime_type === "string" ? value.mime_type : null,
    sizeBytes: typeof value.size_bytes === "number" ? value.size_bytes : null,
  };
}

/**
 * 上传图片到百炼 File API（multipart/form-data 的 file 字段）。
 * 日志只落文件名 / 大小 / 类型，绝不打印密钥与文件内容。
 * 返回 checking 态记录，由调用方轮询等待 available。
 */
export async function uploadBailianFile(
  file: BailianFileInput,
  options: { timeoutMs?: number } = {},
): Promise<BailianFileRecord> {
  const config = resolveBailianConfig();
  const timeoutMs = options.timeoutMs ?? FILE_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const form = new FormData();
    // new Uint8Array(file.data) 拷贝为 ArrayBuffer 背书的新数组：规避 TS 5.7 的
    // Uint8Array<ArrayBufferLike> 与 BlobPart 的泛型不兼容（拷贝成本远小于 OCR 耗时）
    form.append(
      "file",
      new Blob([new Uint8Array(file.data)], { type: file.mimeType }),
      file.filename,
    );
    const response = await fetch(`${config.baseUrl}/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: form,
      signal: controller.signal,
    });
    await assertResponseOk(response, "上传文件");
    const record = normalizeFileRecord((await response.json()) as Record<string, unknown>);
    if (record.id === "") {
      throw new Error("百炼 File API 未返回有效的文件 ID");
    }
    return record;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new BailianTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** 查询文件状态（checking / available / rejected / type_rejected） */
export async function getBailianFile(fileId: string): Promise<BailianFileRecord> {
  const config = resolveBailianConfig();
  const response = await fetch(`${config.baseUrl}/files/${encodeURIComponent(fileId)}`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  await assertResponseOk(response, "查询文件状态");
  return normalizeFileRecord((await response.json()) as Record<string, unknown>);
}

/**
 * 删除已上传文件（Task #51 隐私要求：识别完成即删，不在百炼侧留存）。
 * 删除失败仅记录服务端日志、不上抛：避免遮蔽主流程的真实错误；
 * 调用方应在 finally 中调用，保证主流程无论成败都执行删除。
 */
export async function deleteBailianFile(fileId: string): Promise<boolean> {
  const config = resolveBailianConfig();
  try {
    const response = await fetch(`${config.baseUrl}/files/${encodeURIComponent(fileId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (response.ok || response.status === 404) return true;
    console.warn(`[Bailian] 删除文件失败 HTTP ${response.status}（fileId=${fileId}）`);
    return false;
  } catch (error) {
    console.warn(
      `[Bailian] 删除文件异常（fileId=${fileId}）：${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/**
 * 轮询等待文件 available：
 * - rejected / type_rejected → BailianFileRejectedError（调用方映射 IMAGE_REJECTED）；
 * - 超出预算 → BailianFileWaitTimeoutError（调用方映射 OCR_TIMEOUT）；
 * - 查询本身失败直接上抛（调用方映射 BAILIAN_REQUEST_FAILED）。
 */
export async function waitForBailianFileAvailable(
  fileId: string,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<BailianFileRecord> {
  const timeoutMs = options.timeoutMs ?? FILE_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? FILE_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = await getBailianFile(fileId);
    if (record.status === "available") return record;
    if (record.status === "rejected" || record.status === "type_rejected") {
      throw new BailianFileRejectedError(record.status);
    }
    if (Date.now() + pollIntervalMs >= deadline) {
      throw new BailianFileWaitTimeoutError(timeoutMs);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
