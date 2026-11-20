import type {
  ApplyResult,
  ClarificationAnswer,
  FliggyPoi,
  GuideDraftAutoClassification,
  GuideDraftClarification,
  GuideDraftConflict,
  GuideDraftDayDirective,
  GuideDraftExplanation,
  GuideDraftRequirementCheck,
  GuideSource,
  HotelCandidate,
  Operation,
  SharedTrip,
  Trip,
} from "@goplay/shared";

const BASE = "";

/** FlyAI 搜索接口的统一响应外壳（server/src/flyai/client.ts FlyAISearchResult） */
export interface FlyAISearchEnvelope<T> {
  raw: unknown;
  normalized: T[];
  toolName: string;
  params: unknown;
  capturedAt: string;
  latencyMs: number;
  integrationPath: "cli" | "mcp" | "agent_proxy";
  /** 服务端权威过滤统计（非敏感计数；仅酒店搜索返回） */
  filter?: HotelSearchFilterStats;
}

/** 服务端城市/片区过滤计数（对齐 server/src/flyai/client.ts FlyAISearchFilterStats） */
export interface HotelSearchFilterStats {
  destination: string;
  areaName: string | null;
  rawCount: number;
  cityKept: number;
  cityRejected: number;
  areaKept: number | null;
  areaRejected: number | null;
  kept: number;
}

/** POI 名称是搜索结果展示字段，不属于 shared.FliggyPoi 商品字段 */
export type PoiSearchResult = FliggyPoi & { name: string };

/** fetch 网络层失败（连接拒绝、服务未启动、离线等）的稳定错误码 */
export const NETWORK_ERROR_CODE = "NETWORK" as const;

/**
 * 统一带网络层防护的 fetch：浏览器在连接失败时抛 TypeError（如 "Failed to fetch"），
 * 统一包装为中文可操作的 ApiError，避免把英文原文直接展示给用户。
 * HTTP 非 2xx 的错误响应不在此处理，保留原有 code/message 行为。
 */
async function fetchWithNetworkGuard(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${BASE}${path}`, init);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new ApiError(0, NETWORK_ERROR_CODE, "网络连接失败，请刷新页面后重试");
    }
    throw error;
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetchWithNetworkGuard(path);
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetchWithNetworkGuard(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetchWithNetworkGuard(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * 飞猪 POI 实时搜索（type=poi）；destination 为结构化目的地（Trip.destination.city）。
 * 失败抛出 ApiError：code 为服务端稳定错误码，message 为安全中文文案（如额度耗尽）。
 */
export async function searchPoi(
  query: string,
  destination?: string,
): Promise<FlyAISearchEnvelope<PoiSearchResult>> {
  const params = new URLSearchParams({ type: "poi", q: query });
  if (destination) params.set("destination", destination);
  return flyAiGet<FlyAISearchEnvelope<PoiSearchResult>>(`/api/flyai/search?${params.toString()}`);
}

/** 飞猪酒店实时搜索（type=hotel）：结构化携带目的地 + 片区/关键词 + 日期，不再拼接关键词。
 *  片区模式（area）：服务端按 shared 片区配置解析本地语义词，并叠加城市/片区权威过滤；
 *  关键词模式（q）：自由词直搜（快速搜索按名称搜酒店），服务端仅做城市权威过滤。
 *  二者与服务端路由契约一致（area 片区与 q 关键词二选一），area 必须是已配置片区。
 *  失败抛出 ApiError（安全 code/message；额度耗尽 code=FLYAI_QUOTA_EXHAUSTED）。 */
export async function searchHotels(
  params:
    | { destination: string; area: string; checkIn: string; checkOut: string }
    | { destination: string; q: string; checkIn: string; checkOut: string },
): Promise<FlyAISearchEnvelope<HotelCandidate>> {
  const search = new URLSearchParams({ type: "hotel", destination: params.destination });
  if ("area" in params) search.set("area", params.area);
  else search.set("q", params.q);
  search.set("checkIn", params.checkIn);
  search.set("checkOut", params.checkOut);
  return flyAiGet<FlyAISearchEnvelope<HotelCandidate>>(`/api/flyai/search?${search.toString()}`);
}

/**
 * 加载行程。
 * Task #158：启动加载需要区分「行程确实不存在（404）」与「临时连不上（网络 / 代理 502-504）」，
 * 因此这里不再走 apiGet 的 `API 404: {...}` 纯文本错误，而是抛出携带 HTTP status 的 ApiError；
 * 调用方仍按 Promise 拒绝处理，行为兼容。
 * signal 可选（启动加载用于单次请求超时中止）。
 */
export async function loadTrip(
  tripId: string,
  options: { signal?: AbortSignal } = {},
): Promise<Trip> {
  const res = await fetchWithNetworkGuard(
    `/api/trip/${encodeURIComponent(tripId)}`,
    options.signal === undefined ? undefined : { signal: options.signal },
  );
  if (!res.ok) {
    // 非 JSON 响应体（如 Vite 代理 502 纯文本）按无 message 处理，不把整页内容拼进错误
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(
      res.status,
      res.status === 404 ? "TRIP_NOT_FOUND" : "INTERNAL",
      body?.error ?? "行程加载失败，请稍后重试",
    );
  }
  const trip = (await res.json().catch(() => null)) as Trip | null;
  if (trip === null) {
    throw new ApiError(res.status, "INTERNAL", "服务端返回异常，请稍后重试");
  }
  return trip;
}

/** 保存整个行程（PUT 全量覆盖） */
export async function saveTrip(trip: Trip): Promise<Trip> {
  return apiPut<Trip>(`/api/trip/${encodeURIComponent(trip.tripId)}`, trip);
}

/**
 * 只读分享行程（Task #205）：GET /api/share/:tripId 返回脱敏 SharedTrip。
 * - 404 = 链接失效 / 行程已删除（接收方看到「链接已失效」，不进入初始化流程）；
 * - 其余失败（网络 / 5xx）抛 ApiError，由 ShareView 提供重试；
 * - 不依赖本地 tripId / localStorage，未登录浏览器同样可用。
 */
export async function loadShareTrip(tripId: string): Promise<SharedTrip> {
  const res = await fetchWithNetworkGuard(`/api/share/${encodeURIComponent(tripId)}`);
  const body = (await res.json().catch(() => null)) as (SharedTrip & { error?: string }) | null;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      res.status === 404 ? "TRIP_NOT_FOUND" : "INTERNAL",
      body?.error ?? "分享的行程加载失败，请稍后重试",
    );
  }
  if (body === null) {
    throw new ApiError(res.status, "INTERNAL", "服务端返回异常，请稍后重试");
  }
  return body;
}

/**
 * 分享页受限状态打标（Task #260）：PATCH /api/share/:tripId/status。
 *
 * 只能改 Visit / LodgingPlan 的 purchaseState（服务端整批校验、只写这两个字段），
 * 返回更新后的脱敏 SharedTrip。失败抛 ApiError：404 = 链接失效，其余按可读文案展示。
 */
export interface ShareStatusPatchBody {
  visits?: Array<{ visitId: string; purchaseState: Trip["visits"][string]["purchaseState"] }>;
  lodgings?: Array<{ dayIndex: number; purchaseState: Trip["lodgings"][string]["purchaseState"] }>;
}

export async function patchShareStatus(
  tripId: string,
  body: ShareStatusPatchBody,
): Promise<SharedTrip> {
  const res = await fetchWithNetworkGuard(`/api/share/${encodeURIComponent(tripId)}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => null)) as (SharedTrip & { error?: string }) | null;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      res.status === 404 ? "TRIP_NOT_FOUND" : "INTERNAL",
      payload?.error ?? "状态保存失败，请稍后重试",
    );
  }
  if (payload === null) {
    throw new ApiError(res.status, "INTERNAL", "服务端返回异常，请稍后重试");
  }
  return payload;
}

/** 创建行程（可传 Partial<Trip> seed，如 dateRange / constraints） */
export async function createTrip(seed: Partial<Trip> = {}): Promise<Trip> {
  return apiPost<Trip>("/api/trip", seed);
}

/**
 * 删除行程（Task #66）：服务端同步清理 Trip JSON 与攻略截图目录。
 * 行程不存在（404）等失败抛出 ApiError（message 为服务端安全文案）。
 */
export async function deleteTrip(tripId: string): Promise<void> {
  const res = await fetchWithNetworkGuard(`/api/trips/${encodeURIComponent(tripId)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, "INTERNAL", body?.error ?? "删除失败，请重试");
  }
}

/**
 * Task #257：上传 / 更换行程封面（multipart，字段名 cover；不传 Content-Type，
 * 由浏览器带 boundary）。服务端按 magic bytes 识别 JPG/PNG/WebP 并落盘
 * server/uploads/{tripId}/cover.{ext}，只返回受控相对路径——
 * 这里不双写 Trip：调用方拿到路径后经 store.updateTrip 写入 coverImage，
 * 复用既有 1s 防抖 PUT 链路，避免服务端 version 自增与前端快照互相覆盖。
 */
export async function uploadTripCover(tripId: string, file: File): Promise<{ coverImage: string }> {
  const form = new FormData();
  form.append("cover", file);
  const res = await fetchWithNetworkGuard(`/api/trip/${encodeURIComponent(tripId)}/cover`, {
    method: "POST",
    body: form,
  });
  const body = (await res.json().catch(() => null)) as { coverImage?: string; error?: string } | null;
  if (!res.ok) {
    throw new ApiError(res.status, "INTERNAL", body?.error ?? "封面上传失败，请重试");
  }
  if (typeof body?.coverImage !== "string" || body.coverImage === "") {
    throw new ApiError(res.status, "INTERNAL", "服务端返回异常，请重试");
  }
  return { coverImage: body.coverImage };
}

/**
 * Task #257：删除行程封面文件（幂等，三种格式一并清理）。
 * 同样只动文件不动 Trip：调用方清空 coverImage 后再走 PUT 落地。
 */
export async function deleteTripCover(tripId: string): Promise<void> {
  const res = await fetchWithNetworkGuard(`/api/trip/${encodeURIComponent(tripId)}/cover`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, "INTERNAL", body?.error ?? "封面删除失败，请重试");
  }
}

/** F11 意图编排结果（对齐 server/src/ai/pipeline.ts 的 IntentResult，原样 JSON 透传） */
export interface IntentResult {
  type: "clarify" | "applied" | "proposal" | "rejected" | "error";
  /**
   * 本轮实际使用的百炼 Session ID（Task #70 多轮会话，必填）：
   * 下一轮 sendIntent 原样回传即可续接同一会话上下文；
   * 仅极早失败（行程不存在 / 新建路径超时）为空串，空串视为新建会话。
   */
  sessionId: string;
  clarify?: string;
  result?: ApplyResult;
  /** 敏感操作（remove / setPurchase / lock）→ ProposalCard 逐条确认 */
  proposalOps?: Operation[];
  /**
   * 全量重排（op=plan 且 scope=all）挂起待确认的非敏感操作：
   * 前端弹 ConfirmDialog，确认后经 confirmProposal 二次下发（服务端仍重过四条护栏）；
   * 取消则不下发，不修改任何行程数据。
   */
  fullPlanOps?: Operation[];
  message?: string;
  /**
   * 本轮 G2 搜索命中并新入候选池的点位名称（Task #75，服务端有值才返回）：
   * proposedNew-only（无操作落地）时前端据此持久提示并自动打开候选池，
   * 不再只弹 3.2s 闪现通知。
   */
  newPoolItems?: string[];
}

/**
 * 发送自然语言意图，执行百炼 F11 流水线（clarify / applied / proposal / rejected）。
 * 支持可选 AbortSignal（Task #42）：前端取消等待时中止 fetch；取消只结束前端
 * 等待（服务端继续处理但结果被丢弃），不展示网络错误、不更新行程。
 * 其他接口不受影响（仍走无 signal 的 apiPost / fetchWithNetworkGuard）。
 * Task #72 多轮会话：传入上一轮结果的 sessionId 且服务端会话状态 idle 时复用
 * 百炼会话（只发增量意图），否则新建；响应必带本轮实际使用的 sessionId。
 */
export async function sendIntent(
  tripId: string,
  input: string,
  signal?: AbortSignal,
  sessionId?: string,
): Promise<IntentResult> {
  const payload: Record<string, string> = { tripId, input };
  if (sessionId !== undefined) payload.sessionId = sessionId;
  const res = await fetchWithNetworkGuard("/api/ai/intent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  const body = (await res.json().catch(() => null)) as
    | (IntentResult & { error?: string })
    | null;
  if (!res.ok) {
    // 非 2xx：优先透传服务端用户可读 message（如处理超时 / 响应格式异常）
    throw new ApiError(
      res.status,
      "BAILIAN_REQUEST_FAILED",
      body?.message ?? body?.error ?? "意图处理失败，请重试",
    );
  }
  if (body === null) {
    throw new ApiError(res.status, "INTERNAL", "服务端返回异常，请重试");
  }
  return body;
}

/** 提案确认：用户勾选后的敏感操作（remove / setPurchase / lock）二次下发 */
export async function confirmProposal(tripId: string, operations: Operation[]): Promise<IntentResult> {
  return apiPost<IntentResult>("/api/ai/intent/confirm", { tripId, operations });
}

// ===== Task #97 攻略草案（B3：多篇攻略合并与按上下文排版） =====

/** 草案作用域（对齐 shared DraftScope）：全程 / 单日 / 大景区内部，只限制输出不改变素材归属 */
export type GuideDraftScope =
  | { kind: "trip" }
  | { kind: "day"; dayIndex: number }
  | { kind: "attraction"; visitId: string };

/**
 * 面板入口上下文（Task #176，对齐 server planner.GuideDraftEntryContext）：
 * 前端不再有用户可见的手动 scope 控件，只上报打开来源；服务端按确定性规则
 * 自动判定 scope（日期指令 > 入口上下文 > 证据归属 > 整程）。
 * 结构与 NoteInput.OpenContext 兼容（global / day；attraction 预留给大景区入口）。
 */
export type GuideDraftEntryContext =
  | { type: "global" }
  | { type: "day"; dayIndex: number }
  | { type: "attraction"; visitId: string };

/**
 * 草案来源模式（Task #161，对齐 server planner.GuideDraftSourceMode）：
 * - "all"（缺省）：全部可用且非暂存（staged）来源整体重排，旧调用方不传即旧行为；
 * - "selected"：局部优化，只使用 selectedSourceIds 所选来源素材（允许暂存来源）。
 */
export type GuideDraftSourceMode = "all" | "selected";

/** 草案中的暂存攻略提示（应用时按 targetRef 挂载到 Visit/Stop.guideSnippets） */
export interface GuideDraftSnippet {
  /** 建议 ≤28 个中文字符，硬上限 40（服务端已截断） */
  text: string;
  /** experience | route_listing | tip | risk | comparison | reported_opinion */
  claimKind: string;
  /** 只允许 point / visit / stop 三种（应用时 point 反查 Visit） */
  targetRef: { kind: "point" | "visit" | "stop"; id: string };
  /** 1..3 条 "evidenceId:mentionId"，服务端已过滤到草案消费集合内 */
  sourceMentionRefs: string[];
}

/** POST /api/guides/trips/:tripId/draft 响应（错误时走空形状，同字段补零 / 空数组） */
export interface GuideDraftResult {
  draftId: string | null;
  /** 草案落盘后的行程版本（= baseTripVersion；刷新行程用） */
  tripVersion: number;
  baseTripVersion: number;
  /** 实际生成输入时的行程版本（Task #105：生成期间版本变化则服务端返回 DRAFT_STALE，不保存草案） */
  inputTripVersion: number;
  scope: GuideDraftScope | null;
  /** 复用 F11 applyOps 格式，由 ProposalCard 展示 / 应用 */
  operations: Operation[];
  snippets: GuideDraftSnippet[];
  unplaced: { subjectRef: unknown; reason: string }[];
  proposedNew: { name: string; reason: string | null }[];
  clarify: string | null;
  sourceSnapshots: { sourceId: string; sourceVersion: number }[];
  sourceCount: number;
  mentionCount: number;
  placeCount: number;
  mentionRefCount: number;
  latencyMs: number;
  promptChars: number;
  attempts: number;
  /** Task #123：从补充句解析出的日期硬性指令（无指令为空数组；任务 125 兼容旧服务端可缺省） */
  directives?: GuideDraftDayDirective[];
  /** 指令满足校验（生成时按草案操作终态推演；旧服务端可缺省） */
  requirementChecks?: GuideDraftRequirementCheck[];
  /** 排天冲突（含默认选中策略：sensitive 默认不选；勾选后随 apply 提交；旧服务端可缺省） */
  conflicts?: GuideDraftConflict[];
  /** 自动归类摘要（classifyVisitAsStop；旧服务端可缺省） */
  autoClassifications?: GuideDraftAutoClassification[];
  /** Task #161：本轮草案来源模式（"all" | "selected"；旧服务端 / 老调用可缺省 = all 语义） */
  sourceMode?: GuideDraftSourceMode;
  /** Task #161：局部模式下实际选中的来源 id（全部模式 = 空数组；旧服务端可缺省） */
  sourceIds?: string[];
  /** Task #193：是否命中确定性 snippet-only 快速路径（true = 未调用 AI、attempts=0；
   *  旧服务端 / 错误响应可缺省，对齐 server GuideDraftResult.fastPath 契约） */
  fastPath?: boolean;
  /** Task #250：结构化分类解释（移出 / 重排 / 新增 / 保留 / 仅补亮点 + replace 摘要；
   *  旧服务端可缺省，前端缺省时按原操作列表展示） */
  explanation?: GuideDraftExplanation | null;
  /**
   * Task #282：稀疏攻略澄清响应（非空时表示草案未生成，需前端弹两选项交互）。
   * 用户选择后带 clarificationAnswer 重发 draft 请求。
   */
  clarification?: GuideDraftClarification | null;
}

/** POST /api/guides/trips/:tripId/draft/apply 响应（错误时 type 收敛为 "error"） */
export interface GuideDraftApplyResult {
  type: "applied" | "proposal";
  tripVersion: number;
  draftId: string;
  applied: ApplyResult["applied"];
  rejected: ApplyResult["rejected"];
  /** 被护栏 / 执行器拒绝的操作条数（整批拒绝时 = 全部操作数） */
  rejectedCount: number;
  /** 拒绝原因摘要（按护栏分组 + 首条具体原因）；无拒绝时为 null */
  rejectSummary: string | null;
  /** applied=0 且 rejected>0：全部调整被拒绝，行程结构未变更 */
  allRejected: boolean;
  /** 敏感操作（remove / setPurchase / lock）→ ProposalCard 确认后走 confirmProposal */
  needsProposal: Operation[];
  /** 成功挂载到 Visit/Stop.guideSnippets 的提示条数 */
  attachedSnippetCount: number;
  /** 成功挂载到 Visit.optionGroups 的实用参考组数（Task #190；旧服务端可缺省） */
  attachedOptionGroupCount?: number;
  /** Task #123：应用后按真实行程重算的指令满足状态（met / partial / unmet；旧服务端可缺省） */
  requirementChecks?: GuideDraftRequirementCheck[];
  /** 自动归类摘要（classifyVisitAsStop；任务 125 展示用，旧服务端可缺省） */
  autoClassifications?: GuideDraftAutoClassification[];
  /** 实际以 user_confirmed 执行的冲突 id（旧服务端可缺省） */
  appliedConflictIds?: string[];
  /** 未选中 / 不可执行的冲突摘要（保持原状项；旧服务端可缺省） */
  unselectedConflicts?: { conflictId: string; subjectLabel: string; detail: string }[];
  /** 指令汇总：全部满足 → null；否则已满足 / 部分满足 / 未满足说明（旧服务端可缺省） */
  requirementSummary?: string | null;
  /** Task #250：实际执行操作的分类摘要（如「实际调整：移出 3 项、重排 1 项」；旧服务端可缺省） */
  appliedSummary?: string | null;
  message: string;
}

// （Task #176：手动 scope 上报已移除——请求不再携带 scope，由服务端按入口
// 上下文 + 日期指令 + 证据归属自动判定；旧的字符串简写归一化防御随之退役。）

/**
 * 生成攻略草案（Task #176：不再携带手动 scope；服务端按入口上下文 + 补充句
 * 日期指令 + 攻略证据归属自动判定影响范围，实际 scope 随响应返回）：
 * 合并全部可用来源 mentions → planner（百炼）→ 保存 Trip.pendingGuideDraft。
 * 长耗时（服务端 ≤180s 预算，多篇攻略合并耗时较长）同步返回；note 提供时先写入行程补充句再生成。
 * 失败抛出 ApiError：GUIDE_NO_SOURCES（无可用来源）/ INVALID_REQUEST（补充句
 * 日期指令缺数字等）等；signal 中止时只结束前端等待（服务端结果被丢弃），不展示为错误。
 *
 * Task #161/189：sourceMode="selected" 时携带 selectedSourceIds 只用所选来源
 * （局部优化，允许暂存来源）；sourceMode="all" 或缺省不带 id（服务端互斥校验：
 * all 不得携带 selectedSourceIds）。
 */
export async function generateGuideDraft(
  tripId: string,
  input: {
    entryContext?: GuideDraftEntryContext;
    note?: string;
    sourceMode?: GuideDraftSourceMode;
    selectedSourceIds?: string[];
    /** Task #282：稀疏攻略澄清用户回答（收到 clarification 响应后选择并重发） */
    clarificationAnswer?: ClarificationAnswer;
  },
  signal?: AbortSignal,
): Promise<GuideDraftResult> {
  const body: Record<string, unknown> = {};
  if (input.entryContext !== undefined) body.entryContext = input.entryContext;
  if (input.note !== undefined && input.note !== "") body.note = input.note;
  if (input.sourceMode === "selected") {
    body.sourceMode = "selected";
    body.selectedSourceIds = [...new Set(input.selectedSourceIds ?? [])];
  } else if (input.sourceMode === "all") {
    body.sourceMode = "all";
  }
  if (input.clarificationAnswer !== undefined) body.clarificationAnswer = input.clarificationAnswer;
  const res = await fetchWithNetworkGuard(`/api/guides/trips/${encodeURIComponent(tripId)}/draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const jsonBody = (await res.json().catch(() => null)) as (GuideDraftResult & { code?: string; message?: string }) | null;
  if (!res.ok) {
    throw new ApiError(res.status, (jsonBody?.code ?? "INTERNAL") as ApiErrorCode, jsonBody?.message ?? "攻略草案生成失败，请重试");
  }
  // Task #282：clarification 响应时 draftId 为 null 是合法的（草案未生成，需前端弹澄清交互）
  if (jsonBody === null || (jsonBody.draftId === null && jsonBody.clarification == null)) {
    throw new ApiError(res.status, "INTERNAL", "服务端返回异常，请重试");
  }
  return jsonBody;
}

/**
 * 应用当前草案：服务端版本保护（Trip.version / 来源版本 / mention / 补充句任一变化
 * 即 DRAFT_STALE）→ 四条护栏 → 敏感操作转 needsProposal（ProposalCard 确认后走
 * confirmProposal 二次下发），非敏感直接应用并挂载 snippets。
 * Task #123：selectedConflictIds 提供时，仅选中的冲突 resolution 以 user_confirmed
 * 执行，未选中冲突保持原状并在响应 unselectedConflicts 中回传摘要（任务 125 接线点）。
 * Task #253：replaceConfirm 必须在用户**明确勾选**整日替换时才传（{ draftId, confirmed: true }）；
 * 缺省 / false / draftId 与当前草案不一致时服务端不执行任何整日移回。
 */
export async function applyGuideDraft(
  tripId: string,
  selectedConflictIds?: string[],
  replaceConfirm?: { draftId: string; confirmed: boolean },
): Promise<GuideDraftApplyResult> {
  const payload: {
    selectedConflictIds?: string[];
    replaceConfirm?: { draftId: string; confirmed: boolean };
  } = {};
  if (selectedConflictIds !== undefined) payload.selectedConflictIds = selectedConflictIds;
  if (replaceConfirm !== undefined) payload.replaceConfirm = replaceConfirm;
  const res = await fetchWithNetworkGuard(`/api/guides/trips/${encodeURIComponent(tripId)}/draft/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => null)) as (GuideDraftApplyResult & { code?: string; message?: string }) | null;
  if (!res.ok) {
    throw new ApiError(res.status, (body?.code ?? "INTERNAL") as ApiErrorCode, body?.message ?? "攻略草案应用失败，请重试");
  }
  if (body === null) {
    throw new ApiError(res.status, "INTERNAL", "服务端返回异常，请重试");
  }
  return body;
}

// ===== Task #98 攻略来源（B4：来源列表 / 提交 / 状态轮询 / 重试 / 软移除） =====

/** 来源接口稳定错误码（对齐 server/src/guides/service.ts 的 AiError code） */
export type GuideSourceErrorCode =
  /** 仅支持小红书链接（xiaohongshu.com / xhslink.com） */
  | "LINK_INVALID"
  /** 单次最多提交 12 张图片 */
  | "IMAGE_COUNT_EXCEEDED"
  /** 来源不存在或已被删除 */
  | "SOURCE_NOT_FOUND"
  /** 来源正在处理中（409，稍后再试） */
  | "SOURCE_BUSY"
  /** 当前状态无可重试项（400，引导重新提交） */
  | "SOURCE_NOT_RETRYABLE";

/** 来源接口响应统一解析：非 2xx 抛 ApiError（稳定 code + 服务端安全 message） */
async function readGuideSourceBody<T>(res: Response, fallbackMessage: string): Promise<T> {
  const body = (await res.json().catch(() => null)) as (T & { code?: string; message?: string }) | null;
  if (!res.ok) {
    throw new ApiError(res.status, (body?.code ?? "INTERNAL") as ApiErrorCode, body?.message ?? fallbackMessage);
  }
  if (body === null) {
    throw new ApiError(res.status, "INTERNAL", "服务端返回异常，请重试");
  }
  return body;
}

/** 来源列表响应（GET sources；读取前服务端触发重启恢复扫描） */
export interface GuideSourceListResult {
  sources: GuideSource[];
  tripVersion: number;
}

/** 提交来源响应（两秒内返回 sourceId + 当前状态；抓取 / 抽取 / 图片识别后台异步） */
export interface GuideSourceSubmitResult {
  sourceId: string | null;
  status: GuideSource["status"] | null;
  /** 命中已有来源（canonicalUrl / contentHash 去重；ready/partial 复用缓存不重抓） */
  duplicate: boolean;
  source: GuideSource | null;
}

/** 来源列表（按导入时间排序；含已移除来源，调用方按 active 过滤展示） */
export async function listGuideSources(tripId: string): Promise<GuideSourceListResult> {
  const res = await fetchWithNetworkGuard(`/api/guides/trips/${encodeURIComponent(tripId)}/sources`);
  return readGuideSourceBody<GuideSourceListResult>(res, "攻略来源加载失败，请重试");
}

/** 提交文字来源：正文立即入库为 processing，AI 抽取与装配后台异步（轮询状态跟进度） */
export async function submitGuideSourceText(
  tripId: string,
  text: string,
  options: { title?: string; sourceUrl?: string } = {},
): Promise<GuideSourceSubmitResult> {
  const payload: Record<string, string> = { inputKind: "text", text };
  if (options.title !== undefined && options.title !== "") payload.title = options.title;
  if (options.sourceUrl !== undefined && options.sourceUrl !== "") payload.sourceUrl = options.sourceUrl;
  const res = await fetchWithNetworkGuard(`/api/guides/trips/${encodeURIComponent(tripId)}/sources`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return readGuideSourceBody<GuideSourceSubmitResult>(res, "攻略来源提交失败，请重试");
}

/** 提交链接来源（仅小红书）：抓取 → 正文抽取 → 图片队列全部后台异步 */
export async function submitGuideSourceLink(tripId: string, url: string): Promise<GuideSourceSubmitResult> {
  const res = await fetchWithNetworkGuard(`/api/guides/trips/${encodeURIComponent(tripId)}/sources`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inputKind: "link", url }),
  });
  return readGuideSourceBody<GuideSourceSubmitResult>(res, "攻略链接提交失败，请重试");
}

/** 提交截图来源（1..12 张）：原图先落盘，逐张 OCR 抽取后台异步（进度见 source.imageProgress） */
export async function submitGuideSourceImages(
  tripId: string,
  files: File[],
  options: { title?: string; sourceUrl?: string } = {},
): Promise<GuideSourceSubmitResult> {
  const form = new FormData();
  for (const file of files) form.append("images", file);
  if (options.title !== undefined && options.title !== "") form.append("title", options.title);
  if (options.sourceUrl !== undefined && options.sourceUrl !== "") form.append("sourceUrl", options.sourceUrl);
  const res = await fetchWithNetworkGuard(`/api/guides/trips/${encodeURIComponent(tripId)}/sources`, {
    method: "POST",
    body: form,
  });
  return readGuideSourceBody<GuideSourceSubmitResult>(res, "攻略截图提交失败，请重试");
}

/** 读取单来源响应并解包（source 为 null 的成功形状按不存在处理） */
async function readGuideSourceEntity(
  res: Response,
  fallbackMessage: string,
): Promise<GuideSource> {
  const body = await readGuideSourceBody<{ source: GuideSource | null }>(res, fallbackMessage);
  if (body.source === null) {
    throw new ApiError(res.status, "SOURCE_NOT_FOUND", "攻略来源不存在或已被删除");
  }
  return body.source;
}

/** 单个来源状态（含 imageProgress 明细；读取前服务端触发重启恢复扫描，轮询用） */
export async function getGuideSource(tripId: string, sourceId: string): Promise<GuideSource> {
  const res = await fetchWithNetworkGuard(
    `/api/guides/trips/${encodeURIComponent(tripId)}/sources/${encodeURIComponent(sourceId)}`,
  );
  return readGuideSourceEntity(res, "攻略来源状态获取失败");
}

/** 重试来源（partial 重跑失败图片；failed 重新抓取 / 重跑全部；状态回 processing） */
export async function retryGuideSource(tripId: string, sourceId: string): Promise<GuideSource> {
  const res = await fetchWithNetworkGuard(
    `/api/guides/trips/${encodeURIComponent(tripId)}/sources/${encodeURIComponent(sourceId)}/retry`,
    { method: "POST" },
  );
  return readGuideSourceEntity(res, "攻略来源重试失败，请稍后再试");
}

/** 手动触发图片解析（Task #215：图片默认不解析，一键启动全部待解析图；状态回 processing） */
export async function triggerGuideSourceOcr(tripId: string, sourceId: string): Promise<GuideSource> {
  const res = await fetchWithNetworkGuard(
    `/api/guides/trips/${encodeURIComponent(tripId)}/sources/${encodeURIComponent(sourceId)}/ocr-images`,
    { method: "POST" },
  );
  return readGuideSourceEntity(res, "图片解析启动失败，请稍后再试");
}

/** 单图重试（Task #231：只重跑指定失败图，不整批重来；状态回 processing） */
export async function retryGuideImage(
  tripId: string,
  sourceId: string,
  imageIndex: number,
): Promise<GuideSource> {
  const res = await fetchWithNetworkGuard(
    `/api/guides/trips/${encodeURIComponent(tripId)}/sources/${encodeURIComponent(sourceId)}/retry-image`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index: imageIndex }),
    },
  );
  return readGuideSourceEntity(res, "单图重试失败，请稍后再试");
}

/** 软移除来源（active=false；证据与原图保留供回看，可 restore 恢复） */
export async function removeGuideSource(tripId: string, sourceId: string): Promise<GuideSource> {
  const res = await fetchWithNetworkGuard(
    `/api/guides/trips/${encodeURIComponent(tripId)}/sources/${encodeURIComponent(sourceId)}/remove`,
    { method: "POST" },
  );
  return readGuideSourceEntity(res, "攻略来源移除失败，请重试");
}

/** 恢复已移除来源（幂等） */
export async function restoreGuideSource(tripId: string, sourceId: string): Promise<GuideSource> {
  const res = await fetchWithNetworkGuard(
    `/api/guides/trips/${encodeURIComponent(tripId)}/sources/${encodeURIComponent(sourceId)}/restore`,
    { method: "POST" },
  );
  return readGuideSourceEntity(res, "攻略来源恢复失败，请重试");
}

/**
 * 归档百炼多轮会话（Task #70 收尾：行程完成 / 重开时调用）。
 * 服务端归档失败不阻塞业务（恒返回 200 archived: boolean）；前端同语义：
 * 任何失败（网络 / 非 2xx）统一返回 false，不抛错，由调用方决定是否提示。
 */
export async function archiveAiSession(sessionId: string): Promise<boolean> {
  try {
    const body = await apiPost<{ archived?: boolean }>("/api/ai/session/archive", { sessionId });
    return body.archived === true;
  } catch {
    return false;
  }
}

/** F5 抽取的单个点位结果（对齐 server/src/ai/assemble.ts AssembleOutcome.items） */
export interface ExtractedItem {
  itemId: string;
  name: string;
  origin: "fliggy" | "custom";
  matched: boolean;
  /** 复用既有 Item（仅补充证据引用，非新建）；区分"新增/已收录过" */
  reused: boolean;
  suggestMinutes: number | null;
}

/** F5/OCR 抽取新增的到访壳（对齐 server AssembleOutcome.visits） */
export interface ExtractedVisit {
  visitId: string;
  pointRef: string;
  name: string;
  kind: "ordinary" | "large_attraction";
}

/** F5/OCR 抽取新增的内部玩法（对齐 server AssembleOutcome.stops） */
export interface ExtractedStop {
  stopId: string;
  name: string;
  state: "attached" | "pending";
  visitRef: string | null;
  suggestedVisitRef: string | null;
  level: "high" | "medium" | "low";
}

/** F5 攻略抽取结果：items/visits/stops 为本批实际写入的结构化视图（服务端已持久化） */
export interface ExtractResult {
  evidenceId: string;
  noteIndex: number;
  items: ExtractedItem[];
  visits: ExtractedVisit[];
  stops: ExtractedStop[];
  /** 本批新建 Visit（新入候选池）数量；既有 Visit 只补证据不计入 */
  newVisitCount: number;
  /** 本批复用既有 Visit（仅补充证据引用）数量 */
  reusedVisitCount: number;
  /** 本批新建且已自动挂入所属行程（attached）的 Stop 数量 */
  attachedStopCount: number;
  /** 本批新建且进入待定（pending）的 Stop 数量 */
  pendingStopCount: number;
  /** 本批复用既有 Stop（仅补充证据引用）数量 */
  reusedStopCount: number;
  errors: string[];
}

/** Task #51 截图 OCR 抽取结果（对齐 server/src/ai/ocr.ts OcrResult） */
export interface OcrExtractResult extends ExtractResult {
  ocrText: string;
  /** Task #65：原图保存的非阻塞提示（如单行程 50MB 配额超限）；null 表示无提示 */
  assetWarning: string | null;
}

/** /api/ai/extract、/api/ai/ocr 错误分类的稳定错误码（对齐 server/src/ai/errors.ts；NETWORK 为前端网络层专有） */
export type ExtractErrorCode =
  | "TRIP_NOT_FOUND"
  | "ENV_NOT_CONFIGURED"
  | "BAILIAN_REQUEST_FAILED"
  | "AI_PARSE_FAILED"
  | "PERSIST_FAILED"
  /** 请求参数不合法（400：缺 tripId / 正文为空），message 为服务端可读原因 */
  | "INVALID_REQUEST"
  // Task #51 截图 OCR 专用
  | "IMAGE_REQUIRED"
  | "IMAGE_FORMAT_UNSUPPORTED"
  | "IMAGE_TOO_LARGE"
  | "IMAGE_REJECTED"
  | "OCR_TIMEOUT"
  // Task #97 攻略草案（B3）专用：可用来源缺失 / 草案状态机与版本保护
  | "GUIDE_NO_SOURCES"
  | "DRAFT_NOT_FOUND"
  | "DRAFT_STALE"
  | "DRAFT_MISMATCH"
  | "INTERNAL"
  | "NETWORK";

/** FlyAI 搜索接口的稳定错误码（对齐 server/src/flyai/errors.ts FlyAiErrorCode） */
export type FlyAiErrorCode =
  /** 外部额度耗尽（HTTP 429 / 试用限额） */
  | "FLYAI_QUOTA_EXHAUSTED"
  /** 外部限流（429 但非额度类） */
  | "FLYAI_RATE_LIMITED"
  /** 搜索调用超时 */
  | "FLYAI_TIMEOUT"
  /** 服务端未完成配置（凭据 / 片区关键词配置缺失） */
  | "FLYAI_NOT_CONFIGURED"
  /** CLI 组件不可用 */
  | "FLYAI_CLI_UNAVAILABLE"
  /** 上游失败（其余错误兜底，含非法输出） */
  | "FLYAI_UPSTREAM_FAILED"
  /** 请求参数不合法（400，由路由校验产生） */
  | "FLYAI_INVALID_REQUEST";

/** ApiError 可携带的全部稳定错误码 */
export type ApiErrorCode = ExtractErrorCode | FlyAiErrorCode | GuideSourceErrorCode;

/** 额度耗尽时对用户展示的固定文案（与服务端安全 message 一致） */
export const FLYAI_QUOTA_MESSAGE = "搜索服务额度暂不可用，请稍后重试";

/** FlyAI 搜索失败的安全响应体（服务端契约：仅 code/message/retryable） */
export interface FlyAiSafeErrorBody {
  code?: FlyAiErrorCode;
  message?: string;
  retryable?: boolean;
}

/** 带稳定 code 与用户可读 message 的接口错误（message 不含密钥） */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  /** 是否建议重试（服务端 retryable 标记；网络层失败默认视为可重试） */
  readonly retryable: boolean;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    options: { retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryable = options.retryable ?? code === NETWORK_ERROR_CODE;
  }
}

/**
 * FlyAI 搜索专用 GET：失败响应按服务端安全契约 { code, message, retryable } 解析。
 * message 由服务端保证为简洁中文安全文案；缺失/畸形时回退通用文案——
 * 绝不把原始响应文本拼进错误消息（旧的 `API 502: {…}` 透传已移除）。
 */
async function flyAiGet<T>(path: string): Promise<T> {
  const res = await fetchWithNetworkGuard(path);
  const body = (await res.json().catch(() => null)) as (T & FlyAiSafeErrorBody) | null;
  if (!res.ok) {
    const code = (body?.code ?? "INTERNAL") as ApiErrorCode;
    const message =
      typeof body?.message === "string" && body.message.trim() !== ""
        ? body.message
        : "搜索服务暂时不可用，请稍后重试";
    throw new ApiError(res.status, code, message, { retryable: body?.retryable === true });
  }
  if (body === null) {
    throw new ApiError(res.status, "INTERNAL", "服务端返回异常，请重试");
  }
  return body;
}

/** 搜索类错误的用户可读文案：额度耗尽使用固定文案；其余使用服务端安全 message */
export function flyAiErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "FLYAI_QUOTA_EXHAUSTED") return FLYAI_QUOTA_MESSAGE;
    return error.message;
  }
  return "搜索服务暂时不可用，请稍后重试";
}

/** 搜索类错误是否可重试（网络层失败或服务端标记 retryable） */
export function isRetryableSearchError(error: unknown): boolean {
  return error instanceof ApiError && (error.retryable || error.code === NETWORK_ERROR_CODE);
}

/** F5 攻略笔记抽取：正文粘贴 → AI 抽取 → FlyAI 对齐 → 服务端自动入候选池。
 *  失败抛出 ApiError（code + message），由 NoteInput 分类展示可操作提示。
 *  AI_PARSE_FAILED（服务端两次解析均失败）时自动延迟 2s 重试一次，无需用户操作；
 *  重试开始前回调 onRetry（供 UI 显示"正在重试…"），重试仍失败才抛给调用方。 */
const EXTRACT_RETRY_DELAY_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 失败响应的用户可读原因（Task #90）：优先服务端 JSON 的 message / error；
 * 空响应（服务端进程中断 / 代理断开）与非 JSON 响应也必须带上 HTTP 状态，
 * 避免前端只展示「抽取失败，请重试」而丢失可诊断信息。
 */
function describeHttpFailure(status: number, raw: string): string {
  const text = raw.trim();
  if (text === "") {
    return `服务端未返回响应内容（HTTP ${status}），连接可能已中断，请重试`;
  }
  try {
    const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
    for (const value of [parsed.message, parsed.error]) {
      if (typeof value === "string" && value.trim() !== "") return value.trim();
    }
  } catch {
    // 非 JSON：按纯文本摘要展示（截断，避免把整页 HTML 铺进提示）
  }
  const condensed = text.replace(/\s+/g, " ").slice(0, 200);
  return `服务端返回异常（HTTP ${status}）：${condensed}`;
}

async function extractNotesOnce(tripId: string, text: string, sourceUrl?: string): Promise<ExtractResult> {
  const res = await fetchWithNetworkGuard("/api/ai/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Task #90：仅提交正文与来源链接；小红书代理图片不进入抽取请求（见 NoteInput 说明）
    body: JSON.stringify({ tripId, text, sourceUrl }),
  });
  // 先读文本再解析：空响应 / HTML / 纯文本错误页同样能给出可读原因
  const raw = await res.text().catch(() => "");
  let body: (ExtractResult & { code?: ExtractErrorCode; message?: string; error?: string }) | null = null;
  if (raw !== "") {
    try {
      body = JSON.parse(raw) as ExtractResult & { code?: ExtractErrorCode; message?: string; error?: string };
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    throw new ApiError(
      res.status,
      body?.code ?? "INTERNAL",
      body?.message ?? body?.error ?? describeHttpFailure(res.status, raw),
    );
  }
  if (body === null) {
    throw new ApiError(
      res.status,
      "INTERNAL",
      `服务端返回异常（HTTP ${res.status}），响应无法解析，请重试`,
    );
  }
  return body;
}

export async function extractNotes(
  tripId: string,
  text: string,
  sourceUrl?: string,
  onRetry?: () => void,
): Promise<ExtractResult> {
  try {
    return await extractNotesOnce(tripId, text, sourceUrl);
  } catch (error) {
    if (error instanceof ApiError && error.code === "AI_PARSE_FAILED") {
      onRetry?.();
      await sleep(EXTRACT_RETRY_DELAY_MS);
      return extractNotesOnce(tripId, text, sourceUrl);
    }
    throw error;
  }
}

// ===== Task #87 小红书链接抓取 =====

/** 服务端 /api/ai/extract-url 响应（抓取失败时 error 为可展示的中文原因） */
export interface ExtractUrlResult {
  success: boolean;
  title?: string;
  text?: string;
  /** 服务端代理下载后的图片路径（/api/uploads/xhs_xxx/1.jpg，由服务端 xhsAssetRoutes 受控读取） */
  images?: string[];
  /** 展开后的真实链接（短链跳转后的地址） */
  sourceUrl?: string;
  error?: string;
}

/**
 * 小红书链接 → 笔记标题 / 正文 / 本地图片路径（服务端抓取并落盘，不经过 AI）。
 * 失败抛出 ApiError（message 为服务端可读原因或通用降级文案），
 * 由 NoteInput 降级为手动粘贴 / 上传截图。
 */
export async function extractUrl(url: string): Promise<ExtractUrlResult> {
  const res = await fetchWithNetworkGuard("/api/ai/extract-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const body = (await res.json().catch(() => null)) as ExtractUrlResult | null;
  if (!res.ok || body === null || body.success !== true) {
    throw new ApiError(
      res.status,
      "INTERNAL",
      body?.error ?? "无法提取该链接内容，请手动粘贴文字或上传截图",
    );
  }
  return body;
}

// ===== Task #51 截图 OCR =====

/** 截图上传进度回调（loaded 已传字节 / total 总字节） */
export type OcrProgressHandler = (loaded: number, total: number) => void;

/**
 * Task #51 截图 OCR 抽取：multipart 上传图片（XHR 以获得上传进度事件）→
 * 服务端百炼 File API 上传 + 图文识别 → 三级归属写入（服务端已持久化）。
 * 失败抛出 ApiError（code + message），由 NoteInput 分类展示。
 * signal 中止时只结束前端等待（与 F11 等待取消同语义），服务端结果被丢弃。
 */
export async function extractScreenshot(
  tripId: string,
  file: File,
  options: { sourceUrl?: string; editedText?: string; onProgress?: OcrProgressHandler; signal?: AbortSignal } = {},
): Promise<OcrExtractResult> {
  const form = new FormData();
  form.append("image", file);
  form.append("tripId", tripId);
  if (options.sourceUrl !== undefined && options.sourceUrl !== "") {
    form.append("sourceUrl", options.sourceUrl);
  }
  if (options.editedText !== undefined && options.editedText !== "") {
    form.append("editedText", options.editedText);
  }

  return new Promise<OcrExtractResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    // 上传 + 识别总预算：服务端会话 120s + 上传余量
    xhr.timeout = 180_000;
    xhr.open("POST", "/api/ai/ocr");
    xhr.responseType = "json";

    const fail = (code: ExtractErrorCode, message: string, status: number): void => {
      reject(new ApiError(status, code, message));
    };

    if (options.onProgress !== undefined) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) options.onProgress?.(event.loaded, event.total);
      };
    }

    xhr.onload = () => {
      const body = (xhr.response ?? null) as
        | (OcrExtractResult & { code?: string; message?: string })
        | null;
      if (xhr.status >= 200 && xhr.status < 300) {
        if (body === null) {
          fail("INTERNAL", "服务端返回异常，请重试", xhr.status);
        } else {
          resolve(body);
        }
        return;
      }
      const code = (body?.code ?? "INTERNAL") as ExtractErrorCode;
      // Task #90：同 /extract，非 JSON / 空响应也带上 HTTP 状态，便于定位服务端中断
      fail(
        code,
        body?.message ??
          (body === null ? `图片识别失败（HTTP ${xhr.status}），响应无法解析，请重试` : "图片识别失败，请重试"),
        xhr.status,
      );
    };
    xhr.onerror = () => fail("NETWORK", "网络连接失败，请刷新页面后重试", 0);
    xhr.ontimeout = () => fail("OCR_TIMEOUT", "上传或识别超时，请稍后重试或换一张更小的截图", 0);
    xhr.onabort = () => fail("INTERNAL", "已取消本次识别", 0);

    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        fail("INTERNAL", "已取消本次识别", 0);
        return;
      }
      options.signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }

    xhr.send(form);
  });
}
