/**
 * GoPlay 领域类型 —— PRD v1.1 父子 POI 核心模型（大景区 Visit + 一层内部 Stop）。
 *
 * 建模约定（项目规范）：
 * - 领域实体统一 interface 声明；判别联合用具名 kind 字段；
 * - 可选字段显式 `| null`（不用 `?`），并以行内注释说明业务含义；
 * - ID 语义清晰：GoPlay 自有 ID 为 itemId / visitId / stopId / evidenceId / mentionId / dayId；
 *   供应商 ID 为 providerId（飞猪景点）与 shId（飞猪酒店，见 HotelCandidate），互不混用；
 *   hotelId 为 GoPlay 酒店主键（飞猪酒店 = shId / 自定义酒店 = UUID），作 hotelRegistry 的 key；
 * - 时间统一 "HH:MM"（24h 制）；时间戳 ISO8601；日期 ISO 日期字符串；
 * - 一切「未知」显式用 null 表达，绝不用 0 / 空串冒充（PRD §8.1：必要输入未知不得当作 0）。
 *
 * 版本契约（rev2）：schemaVersion 为数字迁移版本号，缺失视为 1；存量 JSON 读时自动迁移、
 * 保存时写最新版本号（迁移铁律：只覆盖契约差量、幂等、不丢数据，见修订附录 A rev2）。
 */

// ===== 版本 =====

/** Trip 数据结构迁移版本号（rev2）：数字自增；缺失视为 1（v1 存量），读时自动迁移 */
export type SchemaVersion = number;

/** B3 草案输出快照引用的操作类型（仅类型级依赖；operations.ts 已反向引用本文件，无运行时循环） */
import type { Operation } from "./operations.js";

/** Trip.schemaVersion 的最新版本（创建 / 保存统一引用；读侧低版本迁移至此） */
export const SCHEMA_VERSION: SchemaVersion = 2;

// ===== 技术引用（PRD §9.3） =====

/**
 * 实体引用：操作寻址统一入口。
 * - point.id = itemRegistry 的 itemId（未安排的城市级点位主数据）；
 * - lodging 通过 trip.lodgings[String(dayIndex)] 寻址，同一酒店连住多晚逐日独立寻址；
 * - hotel.id = trip.hotelRegistry 的 hotelId（飞猪酒店 = shId / 自定义酒店 = UUID）。
 */
export type EntityRef =
  | { kind: "day"; dayIndex: number }
  | { kind: "point"; id: string }
  | { kind: "visit"; id: string }
  | { kind: "stop"; id: string }
  | { kind: "lodging"; dayIndex: number }
  | { kind: "hotel"; id: string };

/**
 * 容器引用：
 * - day：城市级 Visit 的排期位置；
 * - visit：大景区内部玩法（childStopRefs）的编排位置；
 * - globalPool：城市级候选区（未安排的 Point / Visit 壳）；
 * - pendingPool：待定加入（medium/low，尚未归入任何大景区的 Stop）；
 * - visitPool：某大景区的备选玩法池（alternateStopRefs）。
 */
export type ContainerRef =
  | { kind: "day"; dayIndex: number }
  | { kind: "visit"; id: string }
  | { kind: "globalPool" }
  | { kind: "pendingPool" }
  | { kind: "visitPool"; visitId: string };

// ===== 住宿寻址（保持 v1.0 用户已确认语义） =====

/** 住宿引用：dayIndex 粒度独立寻址；酒店 shId 是供应商商品标识，不作为 GoPlay 排程 ID */
export interface LodgingRef {
  kind: "lodging";
  dayIndex: number;
}

// ===== 核心数据模型（PRD §11.1） =====

export interface Trip {
  tripId: string;
  /** 数据结构迁移版本号（rev2）；缺失视为 1（v1 存量），保存时写最新版本号 */
  schemaVersion?: number;
  version: number;
  destination: { city: string; cityCode: string | null };
  dateRange: { start: string; end: string; nights: number };
  /** dayId 有序数组，顺序即行程顺序；与 days 的 key 一一对应 */
  dayRefs: string[];
  /** key = dayId */
  days: Record<string, Day>;
  /** key = String(dayIndex)；同一酒店连住多晚逐日各一条 */
  lodgings: Record<string, LodgingPlan>;
  /** key = itemId */
  itemRegistry: Record<string, Item>;
  /** 酒店主数据注册表，key = hotelId（飞猪酒店 = shId / 自定义酒店 = UUID）；与 itemRegistry 对齐 */
  hotelRegistry: Record<string, HotelCandidate>;
  /** Day1 首程起点描述（S3 消费，先占位）；缺失 = 未采集 */
  arrivalInfo?: { description: string };
  /** key = visitId */
  visits: Record<string, Visit>;
  /** key = stopId */
  stops: Record<string, Stop>;
  /** key = evidenceId */
  evidences: Record<string, SourceEvidence>;
  /** 城市级候选区：未安排到具体日期的普通景点 Point 或大景区 Visit 壳 */
  globalCandidateRefs: EntityRef[];
  /** 待定加入：medium/low 尚未归入任何大景区的 Stop（stopId 列表） */
  pendingStopRefs: string[];
  /** 大景区归属判断记录（后台三级，不直接暴露给用户）；key = stopId */
  relationshipSuggestions: Record<string, RelationshipSuggestion>;
  /** 攻略来源注册表（修订附录 B v0.3）；key = sourceId；缺失 = 空表（老 Trip 兼容） */
  guideSources?: Record<string, GuideSource>;
  /** 当前行程的攻略排程补充句；缺失 = 无补充句 */
  guideDraftNote?: string;
  /** 最近一次攻略草案的输入快照（应用前校验版本）；缺失 = 无待应用草案 */
  pendingGuideDraft?: PendingGuideDraft;
  /**
   * Task #282：稀疏攻略澄清用户回答（按 trip+来源集合持久化；缺失 = 未回答过）。
   * 回答绑定 planScope 语义：
   * - "guide_only" = 草案只覆盖攻略可支撑的天（A 选项，其余天保持现安排）
   * - "ai_fill"    = 允许 AI 补充排满剩余天（B 选项）
   * 可选——旧 Trip 缺失视为未回答（读时零迁移），不提升 schemaVersion。
   */
  clarificationAnswer?: ClarificationAnswer | null;
  /**
   * Task #282：澄清回答绑定的来源集合哈希（SHA256 前 16 位）。
   * 回答只在该来源集合下有效；来源变化后需重新澄清。缺失 = 无有效答案。
   */
  clarificationSourceHash?: string | null;
  /**
   * 行程封面（Task #257）：服务端相对路径 "uploads/{tripId}/cover.{ext}"，
   * 由 POST /api/trip/:tripId/cover 落盘后由 web 写入；缺失 = 使用渐变兜底背景。
   * 三个封面字段均为可选新增（不提升 schemaVersion，旧 Trip 缺字段按空值读）。
   */
  coverImage?: string;
  /** 行程名称（Task #257）：≤50 字；缺失 / 空串 = 前端展示默认「我的行程」 */
  tripName?: string;
  /** 备忘录纯文本（Task #257）：≤500 字，不做 Markdown / 富文本；缺失 = 无备忘 */
  memo?: string;
  constraints: Constraint[];
  createdAt: string;
  updatedAt: string;
}

/**
 * 天内容混合展示引用：景点（scheduleVisitRefs）与当日住宿候选（hotelRefs）
 * 在同一列表中交错排序时的条目形状。
 * 注意：displayOrder 只是「展示顺序」的附加控制，存储事实源仍是
 * scheduleVisitRefs / hotelRefs —— 前者的下标决定时间轴与 Visit.order，
 * 后者的首位决定当前选定酒店。
 */
export type DayDisplayItemRef =
  | { kind: "visit"; visitRef: string }
  | { kind: "hotel"; hotelRef: string };

/**
 * 天角色（Task #280，S10/S11）：由 deriveDayRoles 纯函数按航班约束＋锁定酒店派生，
 * 优先级 返程＞抵达＞换区＞完整游玩。派生数据——任何 op 不得手改，
 * recomputeDerivedFields 在保存 / 操作应用 / 读时迁移路径统一重算覆盖。
 * 缺失（旧数据）视为未派生，读侧按 full_play 降级展示，不报错。
 */
export type DayRole = "arrival" | "departure" | "transit" | "full_play";

export interface Day {
  dayId: string; // 约定 "day_{dayIndex}"
  dayIndex: number; // 从 1 开始
  date: string; // ISO 日期
  departTime: string | null; // 离开住宿/出发点的时间 "HH:MM"；null = 待定（无锚点则整天待定）
  departTimeOverridden: boolean;
  /** 城市级 Visit 顺序；大景区只出现一次，内部玩法不重复成为城市节点 */
  scheduleVisitRefs: string[];
  lodging: LodgingRef | null; // 指向 trip.lodgings[String(dayIndex)]
  /**
   * 天角色（Task #280 派生字段）：由 recomputeDerivedFields → deriveDayRoles 写入；
   * 可选——旧 Trip 缺失视为未派生（读侧降级 full_play），不提升 schemaVersion。
   * 幕二「约束编排」理由标签的唯一数据源（S10 断言口径）。
   */
  role?: DayRole | null;
  /**
   * 时间来源标签（Task #281 派生字段，S5 参赛必须）：由 recomputeDerivedFields →
   * deriveTimeSourceLabels 写入；可选——旧 Trip 缺失视为未派生（读侧不显示灰字），
   * 不提升 schemaVersion。四状态文案：手改"你设定"（不限锚点日，普通日手改同样显示）/
   * 抵达日"按你的到达航班 HH:MM 算" / 返程日"按回程航班倒推，当天只排机场附近" /
   * 普通日且未手改 null（不显示）。
   * 展示限场景：仅抵达日/返程日出发时间旁＋时间编辑态＋手改 Day 时间行；无全局角标。
   */
  timeSourceLabel?: string | null;
  /**
   * 景点 + 住宿候选的混合展示顺序（可选，缺失 = 老数据）。
   * 存在时按本数组渲染；缺失/悬空条目由 web 侧按存储顺序补全。
   * 缺失时默认「景点在前、酒店在后」（兼容老数据的原渲染顺序）。
   * 新增 / 移除景点或酒店时须同步维护（见 web/src/lib/dayOrder.ts）。
   */
  displayOrder?: DayDisplayItemRef[];
}

// ===== Item：地点 / 商品主数据（PRD §11.2） =====

/**
 * Item 来源出处（Task #283 / 验收用例 C4）：
 * - "guide"（默认；缺失视为此值）：由攻略证据抽取或用户手动添加的点位；
 * - "ai_supplement"：攻略未覆盖、由 AI 补排且已通过飞猪核验（引用真实 POI）的点位。
 * 展示范围＝主行程卡片 ＋ 分享页显示「AI 补充·飞猪核验」标；待办清单不显示。
 * 不变量（guards.validateAiSupplementProvenance）：标 ai_supplement 的 Item 必须
 * origin=fliggy 且 providerId 非空——无真实飞猪 POI 者不得标 ai_supplement（降级 custom）。
 */
export type ItemProvenance = "guide" | "ai_supplement";

/** Item 是主数据，不承担排程容器；排程状态全部在 Visit / Stop / LodgingPlan 上 */
export interface Item {
  itemId: string; // GoPlay 自有稳定标识
  name: string;
  origin: "fliggy" | "custom";
  providerId: string | null; // 飞猪景点 ID；custom 时为 null（不伪造）
  address: string | null;
  category: string | null;
  coords: { lng: number; lat: number } | null;
  suggestMinutes: number | null; // 建议游玩时长（分钟）；null = 待定
  mainPic: string | null;
  ticketInfo: string | null;
  jumpUrl: string | null; // 飞猪景点 H5；custom 时为 null
  /** 地址填写者（Task #221）：user = 自定义点位表单手填（展示免加「AI 提取」声明）；
   *  缺失视为 ai（AI 抽取 / 历史数据），历史 Trip 零迁移 */
  addressSource?: "user" | "ai";
  /**
   * 来源出处（Task #283 / C4）：缺失视为 "guide"（存量零迁移、读时默认，遵守迁移铁律：
   * 默认值安全、幂等、不丢数据）。仅草案应用时对「本轮新排入且非攻略证据支撑」的点位
   * 标 "ai_supplement"，且必须通过飞猪核验（见 ItemProvenance 说明与 guards 护栏）。
   */
  provenance?: ItemProvenance;
  /**
   * 飞猪免费状态（Task #329）：缺失视为 null（存量零迁移、读时默认，遵守迁移铁律，
   * 与 provenance 同模式；读侧统一经 shared/freePoi.ts 的 itemFreePoiStatus 取值）。
   * 仅由飞猪 POI 装配 / 升级路径写入；custom 点位恒缺失或 null，不伪造。
   * 展示口径：FREE（或 category 命中购物类兜底）→ 免票标签、隐藏购票语义按钮。
   */
  freePoiStatus?: FreePoiStatus;
  /**
   * 飞猪景点等级（Task #330）：原始值形如 "4" / "5" / "4A" / "AAAA" / "AAAAA"；
   * 缺失视为 null（存量零迁移、读时默认，遵守迁移铁律，与 freePoiStatus 同模式；
   * 读侧统一经 shared/poiMeta.ts 的 itemPoiLevel / normalizePoiLevel 取值归一化）。
   * 仅由飞猪 POI 装配 / 升级路径写入；custom 点位恒缺失或 null，不伪造。
   * 展示口径：归一化为 "4A"/"5A" 徽标，无法识别的形态不展示（不输出原始脏值）。
   */
  poiLevel?: string | null;
  /**
   * 飞猪榜单文案（Task #330）：形如 "海南4A/5A景点榜第2名"；覆盖率低（同批多条
   * 常常仅一条有值），缺失视为 null（读时默认，存量零迁移）。展示为名称下方独立
   * 一行暖色 chip——有则显示、无则完全不占位（不产生空白行或 null 文本）。
   */
  listRank?: string | null;
  /**
   * 飞猪景点介绍（Task #330）：长文本（可达百字，内含门票 / 玩法线索）；缺失视为
   * null（读时默认，存量零迁移）。展示为卡片底部「介绍」折叠区，默认收起、点击
   * 展开全文、可再次收起；空 / 缺失时整个入口不出现（长文本绝不默认展开）。
   */
  description?: string | null;
  sourceEvidenceRefs: string[];
}

// ===== 城市级交通段 =====

/**
 * 外部交通（城市级）：只挂在 Visit 上（到本站的交通），只计算到景区入口。
 * Stop 没有交通字段——大景区内部不重复计算城市交通。
 * minutes = null 表示时间待定，时间轴不得当作 0。
 */
export interface Leg {
  mode: string; // 如 "驾车" / "打车" / "景区接驳"
  minutes: number | null; // null = 时间待定
  note: string | null;
  /** 数据来源："user" = 用户填写（重算不得覆盖）；"ai_estimate" = AI 估算（可重估）；迁移默认 "user" */
  source?: "user" | "ai_estimate";
}

// ===== Visit：一天中的城市级到访单元（PRD §11.3） =====

export interface Visit {
  visitId: string;
  dayRef: string | null; // 所属 dayId；null = 在 globalPool（城市级候选）
  pointRef: string; // 关联 itemRegistry 的 itemId
  kind: "ordinary" | "large_attraction"; // 普通景点 / 大景区；大景区深度只有一层
  visitMode: "full_day" | "half_day" | "custom"; // 大景区游玩窗口；ordinary 恒 custom
  order: number | null; // 天内位置（与 scheduleVisitRefs 下标一致）；globalPool 时为 null
  windowStart: string | null; // 用户/约束给出的计划窗口起点
  windowEnd: string | null; // 用户/约束给出的计划窗口终点
  startTime: string | null; // 计算值或覆写值；null = 待定
  endTime: string | null; // windowEnd 或 startTime + effectiveMinutes；null = 待定
  startTimeOverridden: boolean;
  endTimeOverridden: boolean;
  reservedMinutes: number | null; // 用户显式设定的时长（setDuration 写入）
  effectiveMinutes: number | null; // 实际生效时长：reserved → item → childStops 汇总；null = 待定
  externalLeg: Leg | null; // 从上一站/出发点到本站；null 视为 0 分钟
  /** 大景区内部玩法（游玩路径，一层，始终展开） */
  childStopRefs: string[];
  /** 备选玩法：挂在同一 Visit 下，不进入城市候选区 */
  alternateStopRefs: string[];
  /** 攻略原文提及引用，格式 "evidenceId:mentionId"（同 Stop.sourceMentionRefs）；缺失视为空 */
  sourceMentionRefs?: string[];
  /** 卡片攻略补充：0..2 条（附录 B §3.3，展示层按容器宽度截断）；缺失视为空 */
  guideSnippets?: GuideSnippet[];
  /**
   * 实用参考主题组（Task #190）：同主题 ≥2 个可比较选项的参考信息卡；
   * 缺失 = 无数据（历史 Trip 零迁移），前端不渲染。只展示不参与排程。
   */
  optionGroups?: GuideOptionGroup[];
  purchaseState: "unknown" | "toBuy" | "bought" | "noTicket";
  locked: boolean;
  userAdjusted: boolean; // G4 重排保护：自动 plan 不得静默省略
  /** 移入 globalPool 时的原位置（撤销 / 重新加入恢复参考）；在行程内为 null */
  removedFrom: { dayIndex: number; order: number } | null;
  removedAt: string | null; // ISO8601
}

// ===== Stop：Visit 内部的一层玩法（PRD §11.4，用户已确认裁剪） =====

/**
 * Stop 只维护：顺序、建议时长、位置提示、票务关系、归属与证据。
 * 不支持 startTime / setTime（不显示具体开始时间）、purchase、locked、跨天移动
 * ——这些状态属于 Visit（任务 #48 用户已确认）。
 */
export interface Stop {
  stopId: string;
  state: "attached" | "pending"; // attached = 归属明确（child 或 alternate）；pending = 在全局待定区
  /** attached 时必填（child 与 alternate 所属 Visit）；pending 时必须为 null */
  visitRef: string | null;
  /** medium 级建议归属（仅 pending 时可携带）；low / attached 为 null */
  suggestedVisitRef: string | null;
  matchedPointRef: string | null; // 命中飞猪时的 itemRegistry key；custom 点位为 null
  customName: string | null; // 自定义点位名称（手工添加 / 未命中飞猪）；matched 时为 null
  /** attached 时 = 所在数组（child/alternate）下标；pending 时为 null */
  order: number | null;
  suggestMinutes: number | null; // 建议时长（分钟）；null = 待定（手工添加默认待定）
  locationHint: string | null; // 攻略位置提示（如「入口左转」），不冒充精确地址
  ticketRelation: "included" | "separate" | "unknown"; // 与父景区票务关系；父景区已购不代表包含
  sourceEvidenceRefs: string[];
  /** 精确指向截图/正文原句：格式 "evidenceId:mentionId" */
  sourceMentionRefs: string[];
  /** 卡片攻略补充：0..2 条（内部玩法细节挂 Stop）；缺失视为空 */
  guideSnippets?: GuideSnippet[];
  userAdjusted: boolean;
  /** 从 childStopRefs 移入 alternateStopRefs 时的原位置（5 秒撤销恢复用）；child 内为 null */
  removedFromOrder: number | null;
  removedAt: string | null; // ISO8601
  /**
   * 归类溯源（Task #122）：由 ordinary Visit 经 classifyVisitAsStop 转换而来时记录
   * 原 visitId；其余（原生 Stop / 旧数据缺失）= 非转换产物。仅用于幂等重放识别与
   * 溯源，不参与一致性校验——原 Visit 已删除，且确定性 visitId 可能在同点位重新
   * 排期时被重建复用，不得按「指向存在的 visit」做悬空判定。
   */
  classifiedFromVisitRef?: string | null;
}

// ===== 来源证据（PRD §11.5） =====

/** 证据中的单条提及：用户原文 / OCR 原句与区域，模型总结必须与原文分开 */
export interface EvidenceMention {
  mentionId: string;
  text: string;
  quoteText: string; // 用户原文 / OCR 原句
  bbox: [number, number, number, number] | null; // 截图区域；正文类证据为 null
  extractedName: string | null;
  locationHint: string | null;
  modelSummary: string | null; // 与 quoteText 分开保存，不能冒充原文
  /**
   * 附录 B v0.3 §5 最小增补（全部可选，旧证据缺失即按未标注处理）：
   * 事实类型 / 最小适用范围 / 是否作者亲历。用于避免把路线列举、转述或局部风险
   * 误读成强推或整座景点结论；不要求前端固定展示。
   */
  claimKind?: GuideClaimKind;
  targetScope?: GuideTargetScope;
  firsthand?: boolean;
  /**
   * Task #123 强证据父子关系：抽取/OCR 模型给出的从属关系原文依据
   * （如「位于后海村内部」「三亚后海村里面的海滩」）；null/缺失 = 模型未标注。
   * 仅当上下文明示从属关系（位于 / 内部 / 附近 / 某景区内）时非空；
   * 同日、同篇提及或名称相似不构成依据，不得标注。
   */
  relationEvidence?: string | null;
  /**
   * Task #181：明确 Day 归属（1 起始，来自攻略文本的行首显式 Day 标题，
   * 仅本地结构化抽取产出）。可选（附录 B v0.3 §5 同模式）：旧证据 /
   * 模型路径缺失或 null = 未标注；不凭空推断日期。
   */
  dayIndex?: number | null;
  /**
   * Task #196：正文明确页码引用（1-based，从原句 quoteText 确定性解析 pN / PN /
   * P N 形式，可多个如 p2 p8 p9；仅正文类证据提取，截图 OCR 原句中的类似字样
   * 与图片队列页码无关不提取）。可选字段——旧证据缺失 / 非数组 = 无页码，读侧
   * 按「无绑定」处理，历史 Trip 零迁移。页码到图片的绑定不在此存储：读取侧按
   * 所属 GuideSource 的 imageProgress 槽位动态解析（shared/guides/pageImages.ts），
   * 图片重试成功后自动恢复绑定。
   */
  pageRefs?: number[];
}

/** 附录 B 的 SourceMention 命名与本仓 EvidenceMention 同义（保留别名便于上层引用） */
export type SourceMention = EvidenceMention;

export interface SourceEvidence {
  evidenceId: string;
  kind: "note_text" | "screenshot" | "source_link";
  noteIndex: number | null; // kind=note_text 时的笔记序号；其余为 null
  assetRef: string | null; // 截图资源引用（tripId 对应空间）；非 screenshot 为 null
  sourceUrl: string | null; // 仅保存不抓取
  ocrText: string | null; // OCR 全文（截图类）
  mentions: EvidenceMention[];
  /**
   * Task #65 攻略截图原图持久化：以下资产字段为可选（旧证据无此字段，
   * 读侧须按「无值」处理而非报错），未保存原图时为 null，不得用空串 / 0 冒充。
   */
  /** 原图服务端相对路径 "uploads/{tripId}/{evidenceId}.jpg|png"；未保存为 null */
  assetPath?: string | null;
  /** 原图 MIME 类型（"image/jpeg" | "image/png"）；未保存为 null */
  assetMimeType?: string | null;
  /** 原始文件字节数；未保存为 null */
  assetSizeBytes?: number | null;
  /** 原图 sha256 前 16 位（完整性校验用，不可还原原图）；未保存为 null */
  assetHash?: string | null;
}

// ===== 攻略来源编组与攻略提示（修订附录 B v0.3，B1 契约） =====

/** 攻略来源输入形态：一条链接 / 一次文字粘贴 / 一组图片提交各构成一个来源 */
export type GuideSourceInputKind = "link" | "text" | "images";

/**
 * 攻略来源状态（附录 B §5）：
 * - processing：已保存，正文或图片仍在处理（正文可用后仍可为 processing，直到本篇全部完成）；
 * - ready：本篇处理完成且无失败项；
 * - partial：正文可用但部分图片失败 / 超时，或超过图片上限；
 * - failed：未取回任何可规划内容（属于读取失败，不是攻略内容价值不足）。
 * 流转限定 processing → ready | partial | failed；重试回到 processing 并递增 sourceVersion。
 */
export type GuideSourceStatus = "processing" | "ready" | "partial" | "failed";

/** 来源级失败原因（附录 B §5 固定集合；不臆造更多码值） */
export type GuideFailureCode = "blocked" | "not_found" | "timeout" | "extract_failed";

/** 单张图片处理状态（图片队列：并发 4、来源总预算 180s、单图 120s 超时，失败不阻塞同篇其他图片） */
export type GuideImageStatus = "pending" | "processing" | "ready" | "failed" | "skipped";

/**
 * 单图失败原因：模型拒绝 / 超时 / 抽取失败 / 格式不支持 / 下载失败；未知兜底为 unknown。
 * download_failed（Task #175）：链接抓取阶段单图下载失败——该图不进入识别队列，
 * 且必须保留原始页码占位（后续图片不得前移）。
 */
export type GuideImageFailureCode =
  | "rejected"
  | "timeout"
  | "extract_failed"
  | "unsupported"
  | "download_failed"
  | "unknown";

/**
 * 单图进度：成功时记录 evidenceId，失败时记录 failureCode 或 failureMessage（二者至少一项）。
 * status=skipped（Task #175 预筛）：仅表示「未送模型识别」，原图与空证据保留可回看；
 * failureMessage 承载可解释的跳过原因，不计入 completed / failed 计数，可按需重试。
 */
export interface GuideImageProgressEntry {
  /** 1-based 原图顺序；「重试剩余图片」按此顺序补跑 */
  index: number;
  status: GuideImageStatus;
  /** status=ready 时必须指向 trip.evidences 中且已列入来源 evidenceRefs 的证据 */
  evidenceId: string | null;
  /**
   * 任务 186 原文回看：原图受控相对路径（提交上传落盘时即写入；重试复用同一原图
   * 不变；配额超限 / 落盘失败为 null）。可选字段——历史来源缺失，读侧按「无值」
   * 处理并回退证据的 assetPath，不得报错。
   */
  assetPath?: string | null;
  failureCode?: GuideImageFailureCode;
  failureMessage?: string;
}

/** 图片队列进度：随 Trip 持久化，刷新后仍能显示进度并重试剩余图片 */
export interface GuideImageProgress {
  /** 本次来源纳入处理的图片总数（≤ maxGuideImages）；纯文字来源为 0 */
  total: number;
  /** 成功完成数（= status=ready 的条目数） */
  completed: number;
  /** 失败数（= status=failed 的条目数；skipped 不计入成功或失败） */
  failed: number;
  /** 每图明细，长度须等于 total；按 index 升序保存 */
  images: GuideImageProgressEntry[];
}

/**
 * 来源硬范围：仅当用户明确表达「只用于某天 / 某景区」时写入；
 * 缺失 = 无硬范围（素材仍属当前 Trip，可参与全程排程）。
 */
export type GuideHardScope =
  | { kind: "day"; dayIndex: number }
  | { kind: "attraction"; visitId: string };

/** 攻略来源：只做编组与状态，不复制证据正文 */
export interface GuideSource {
  sourceId: string;
  /** 来源内容版本：重试成功、覆盖范围变化或证据替换时递增；草案快照据此判过期 */
  sourceVersion: number;
  inputKind: GuideSourceInputKind;
  title?: string;
  /** 用户提交时的原链接（短链 / 分享链接原样保留；字段名沿用附录 B，即任务中的 originalUrl） */
  sourceUrl?: string;
  /** 规范化链接（服务端展开短链后用 noteId 等稳定标识生成）；同链接去重优先比对本字段 */
  canonicalUrl?: string;
  /** 正文 / OCR 内容哈希（服务端计算）；与 canonicalUrl 任一相同即视为同一篇 */
  contentHash?: string;
  /** false = 已从当前行程移除（只解除引用、不物理删除证据；undo 恢复 active） */
  active: boolean;
  removedAt?: string;
  status: GuideSourceStatus;
  /** 本篇全部证据（正文 / 截图 / 仅链接占位），指向 trip.evidences；来源只编组不复制正文 */
  evidenceRefs: string[];
  /** 本篇可消费提及，格式 "evidenceId:mentionId"（与 Visit/Stop.sourceMentionRefs 同构） */
  mentionRefs: string[];
  /** 图片队列持久化进度；纯文字来源为 total=0 的空进度 */
  imageProgress: GuideImageProgress;
  /** 创建时间（附录 B 字段名 importedAt，即任务中的 createdAt） */
  importedAt: string;
  updatedAt: string;
  /** 处理覆盖说明，如「正文 + 9/9张图」；只陈述处理范围，不做内容价值判断 */
  coverageText?: string;
  /**
   * 任务 186 / Task #217 原文与重抽凭据：
   * - text 来源：用户提交的完整原文（创建 / failed 重新导入时原样持久化，上限同
   *   正文 50_000 字）；
   * - link 来源：Task #217 起抓取成功时保存的小红书笔记正文，用于 partial 来源
   *   补正文时本地重抽（免于重新抓取，不受原链接时效 / WAF 影响）；web 原文入口
   *   仍按 inputKind 门控（链接来源继续走外链，不展示本地正文）。
   * 可选字段——历史来源缺失（旧数据不迁移），读侧按「无完整原文」降级
   *（不显示无效原文入口），不得报错。
   */
  sourceText?: string;
  failureCode?: GuideFailureCode;
  failureMessage?: string;
  /** 显式硬范围；缺失 = 无硬范围 */
  hardScope?: GuideHardScope;
  /**
   * Task #161 暂存标记：新增来源保存成功后默认 true——不参与默认（全部模式）草案
   * 合并与候选支撑，仅可被本轮显式 selectedSourceIds 选中参与局部优化。
   * 与 active（软移除语义）正交；缺省 / false = 历史来源（全部模式可正常消费），
   * 旧数据零迁移、默认行为不变。用户明确整合后（后续任务提供解除通道）置 false。
   */
  staged?: boolean;
  /**
   * Task #215 图片 OCR 延迟：图片已下载落盘但未启动 OCR（进度明细保持 pending），
   * 等待用户在来源卡片手动触发「解析图片」一键启动（triggerImageOcr）。
   * 缺省 / false = 历史来源（无延迟语义，行为不变）；触发解析或确认无待解析图
   * 后置回 false。与 staged / active 正交。
   */
  imageOcrDeferred?: boolean;
}

/** 攻略提示的事实类型（附录 B §3.2 / §5）：原文事实与 AI 判断分开 */
export type GuideClaimKind =
  | "experience"
  | "route_listing"
  | "tip"
  | "risk"
  | "comparison"
  | "reported_opinion";

/** 提及的最小适用范围：风险不得从玩法 / 供应商升级为整座景点 */
export type GuideTargetScope = "place" | "activity" | "provider" | "time_window";

/** 卡片攻略提示：短文本 + 事实类型 + 原文提及引用（必须可定位） */
export interface GuideSnippet {
  snippetId: string;
  /** 建议 ≤28 个中文字符，硬上限 40；展示截断不回写本字段 */
  text: string;
  claimKind: GuideClaimKind;
  /** 1..3 条，格式 "evidenceId:mentionId"；必须能定位到原句或原图区域 */
  sourceMentionRefs: string[];
}

/** 本次草案作用域：全程 / 单日 / 大景区内部（入口默认值，不永久隔离素材） */
export type DraftScope =
  | { kind: "trip" }
  | { kind: "day"; dayIndex: number }
  | { kind: "attraction"; visitId: string };

// ===== 攻略实用参考选项组（Task #190） =====

/**
 * 实用参考分类（任务 148 泛化边界）：同主题多选项的非标内容，
 * 覆盖交通、门票套餐、租赁、玩法档位、餐饮套餐、接驳等；
 * 白名单外兜底 other，不臆造新分类。
 */
export type GuideOptionCategory =
  | "transport" // 交通（观光车 / 三轮车 / 电动车 / 船班等）
  | "ticket" // 门票与套餐
  | "rental" // 租赁（电动车 / 潜水装备等）
  | "activity" // 玩法档位 / 体验项目
  | "dining" // 餐饮与套餐
  | "shuttle" // 接驳 / 摆渡
  | "other"; // 其他实用信息（兜底）

/** 实用参考单选项：字段全部来自原文，缺失为 null（绝不从无证据内容臆测） */
export interface GuideOptionItem {
  /** 选项名（如「观光车」），非空 */
  label: string;
  /** 原文价格与单位（如「50元/圈」），原样保留措辞；原文未提 = null */
  priceText: string | null;
  /** 路线或覆盖范围（如「环岛一周」）；原文未提 = null */
  routeText: string | null;
  /** 适用场景（如「带老人小孩省力」）；原文未提 = null */
  sceneText: string | null;
  /** 可议价：原文明说可议 true / 不可议 false；原文未提 = null */
  bargain: boolean | null;
  /** 其他特点补充（如「可随时停车拍照」）；原文未提 = null */
  noteText: string | null;
  /** 证据引用 "evidenceId:mentionId"（≥1 条，必须可定位到原句或原图区域） */
  sourceMentionRefs: string[];
}

/**
 * 实用参考主题组：同一主题下 ≥2 个可比较选项才成组（任务 190）；
 * 只作为参考信息挂在 Visit 上展示，绝不创建 POI / Stop / childStop / 内部行程。
 * 可选字段：历史 Trip 无此字段 = 无数据（零迁移），读侧按空处理。
 */
export interface GuideOptionGroup {
  groupId: string;
  /** 主题（如「西岛环岛交通」），非空 */
  topic: string;
  category: GuideOptionCategory;
  /** 2..GUIDE_OPTION_GROUP_MAX_OPTIONS 个可比较选项 */
  options: GuideOptionItem[];
  /** 组级证据引用兜底（选项级引用的并集超集；允许为空，选项级必须非空） */
  sourceMentionRefs: string[];
  /** 采集时间 ISO8601（应用落盘时间） */
  collectedAt: string;
}

/** 草案暂存形态的实用参考选项：与 GuideOptionItem 同构（无 groupId） */
export interface PendingGuideDraftOptionItem {
  label: string;
  priceText: string | null;
  routeText: string | null;
  sceneText: string | null;
  bargain: boolean | null;
  noteText: string | null;
  sourceMentionRefs: string[];
}

/**
 * B3 草案中的实用参考主题组（Task #190 暂存形态）：应用时按 targetRef 归一
 * 挂到 Visit.optionGroups（stop → 父 Visit；point → 反查 Visit）；
 * 与 PendingGuideDraftSnippet 同模式：targetRef 允许 point（应用时按 plan 结果解析）。
 */
export interface PendingGuideDraftOptionGroup {
  topic: string;
  category: GuideOptionCategory;
  /** 2..GUIDE_OPTION_GROUP_MAX_OPTIONS 个可比较选项（生成侧已清洗截断） */
  options: PendingGuideDraftOptionItem[];
  /** 归属目标：只允许 visit / stop / point（day / lodging / hotel 不承载） */
  targetRef: EntityRef;
  /** 组级证据引用（选项级引用为空时的兜底；清洗后可为空） */
  sourceMentionRefs: string[];
}

/**
 * 本次草案的攻略来源模式（Task #161）。
 * - "all"：全部可用攻略整体重排（缺省）——可用且非暂存（staged）来源全集，
 *   保持既有「全部可用攻略」语义，旧调用方不传 sourceMode 即旧行为；
 * - "selected"：局部优化——只使用 selectedSourceIds 所选来源的素材（允许暂存来源），
 *   未选历史来源不进入 prompt、关系匹配或草案证据。
 */
export type GuideDraftSourceMode = "all" | "selected";

/** 草案冻结的来源版本（sourceVersion 变化即过期，应用时拒绝） */
export interface GuideSourceVersionSnapshot {
  sourceId: string;
  sourceVersion: number;
}

/**
 * B3 草案生成的攻略提示（应用时按 targetRef 挂载到 Visit/Stop.guideSnippets）。
 * 与 GuideSnippet 的差异： GuideSnippet 是已落位实体的存储形态（snippetId + 无 target），
 * 本类型是草案中的暂存形态——targetRef 允许指向 point（应用时按 plan 结果解析为新建 Visit）。
 */
export interface PendingGuideDraftSnippet {
  /** 建议 ≤28 个中文字符，硬上限 40（生成侧已截断） */
  text: string;
  claimKind: GuideClaimKind;
  /** visit/stop 应用后直接挂载；point 按 pointRef 反查应用后的 Visit */
  targetRef: EntityRef;
  /** 1..3 条，格式 "evidenceId:mentionId"；必须能定位到原句或原图区域 */
  sourceMentionRefs: string[];
}

/** B3 草案输出快照：生成时冻结的操作集与提示，应用端点据此执行与挂载（前端无需回传） */
export interface PendingGuideDraftOutput {
  /**
   * 生成时冻结的操作集（OperationSet.operations 同构；baseVersion 已归一为
   * baseTripVersion）。应用时仍重过四条护栏，本字段不豁免任何校验。
   */
  operations: Operation[];
  snippets: PendingGuideDraftSnippet[];
  /**
   * 实用参考主题组（Task #190；可选——旧草案缺失 = 无该输出，读侧按空处理）。
   * 应用时按 targetRef 归一挂载到 Visit.optionGroups，不参与护栏（非行程结构变更）。
   */
  optionGroups?: PendingGuideDraftOptionGroup[];
}

// ===== 日期指令 / 满足校验 / 冲突契约（Task #123） =====

/**
 * 从用户补充句解析出的明确排天指令。仅属于 pendingGuideDraft 快照，
 * 不写入 Trip.constraints（草案级意图，应用与否由用户决定）。
 */
export interface GuideDraftDayDirective {
  directiveId: string; // dir_1、dir_2…
  /** 用户指定的目标天（1-based，生成时已校验在行程范围内） */
  dayIndex: number;
  /** 目标短语：日期词之后的地点文本（用户原话切片，前导动词「去/安排/放到」已剥离） */
  placeText: string;
  /**
   * placeText 拆分（「和 / 与 / 、」）后逐段匹配到的行程 Visit id（0..N 个；
   * 空 = 行程中无匹配，requirementCheck 将为 unmet）。
   */
  resolvedVisitIds: string[];
  /** 原句溯源（补充句中的分句原文） */
  rawSentence: string;
  /**
   * Task #248：本指令的排天语义（可选，缺省 = "append"，兼容 Task #123 起的旧草案）：
   * - "append"：目标天既有安排保留，本轮结果追加到当天末尾（旧行为）；
   * - "replace"：整日替换重排——目标天的未锁定 / 未购买 / 非受保护 Visit 移回候选池后，
   *   再按本轮规划重排该天；锁定 / 已购项保留在原天并生成确认信息。
   */
  mode?: "append" | "replace";
  /**
   * Task #248：整日替换时服务端确定性移回候选池的 Visit id（草案预览展示用；
   * 旧数据 / append 指令缺省 = 无移回）。apply 时这些移除仍逐条过护栏并计入 30% 阈值。
   */
  replaceRemovedVisitIds?: string[];
  /**
   * Task #248：整日替换时因锁定 / 已购保留在原天的 Visit id（确认信息
   * replace_kept_protected 的数据源；旧数据 / append 指令缺省）。
   */
  replaceKeptVisitIds?: string[];
  /**
   * Task #253：整日替换被门控跳过时的原因（缺省 = 正常执行）。
   * 只有「本轮确实有新安排能排进目标天」才允许移回旧安排：模型规划为空、
   * 全部被安全规则拒绝或待用户确认时，整日替换不得退化为「只清空不重排」。
   * 跳过时 replaceRemovedVisitIds 为空数组，requirementCheck 降级为非 met 并带出该原因。
   */
  replaceSkippedReason?: string;
}

/** 指令满足状态：met=达标 / partial=部分达标 / unmet=未达标 / pending=需用户勾选冲突后才能确定 */
export type GuideDraftRequirementStatus = "met" | "partial" | "unmet" | "pending";

/**
 * 单条指令的校验结果：生成时按「草案操作全部成功应用」的终态推演；
 * apply 响应中由服务端按应用后的真实行程重算（pending 收敛为三态）。
 */
export interface GuideDraftRequirementCheck {
  directiveId: string;
  dayIndex: number;
  placeText: string;
  status: GuideDraftRequirementStatus;
  /** 用户语言说明（为什么满足 / 不满足 / 待确认），可直接展示 */
  detail: string;
}

/** 排天冲突种类 */
export type GuideDraftConflictKind =
  | "subject_locked" // 指令目标 Visit 自身锁定
  | "subject_bought" // 指令目标 Visit 已购
  | "child_locked" // 待自动归类的子 Visit 锁定（classify 被护栏拒绝，只能用户手动处理）
  | "child_bought" // 待自动归类的子 Visit 已购
  | "target_day_occupied" // 目标 Day 已有普通安排（新项追加不覆盖，纯告知）
  | "target_day_locked" // 目标 Day 有锁定项（可勾选挪走：resolution 以 user_confirmed 执行）
  | "target_day_bought" // 目标 Day 有已购项（可勾选挪走）
  | "target_day_flight" // 目标 Day 有航班约束（不可调整，纯告知）
  | "target_day_replace" // Task #248：整日替换摘要（普通安排将移回候选池，纯告知）
  | "replace_kept_protected"; // Task #248：整日替换时锁定 / 已购项保留在原天（纯告知）

/**
 * 排天冲突（任务 125 勾选渲染契约）：sensitive=true 默认不选，普通冲突可默认选，
 * 但最终以用户提交的 selectedConflictIds 为准。resolution 非空时，选中后由服务端
 * 以 user_confirmed 执行（G3 对 move/transfer 放行；remove 红线不变）；
 * null = 纯告知项，前端可展示但不可勾选执行。
 */
export interface GuideDraftConflict {
  conflictId: string; // cf_1、cf_2…
  /** 关联指令 id；与日期指令无关的冲突为 null */
  directiveId: string | null;
  kind: GuideDraftConflictKind;
  /** 受影响实体引用；无实体可指的冲突为 null */
  subjectRef: EntityRef | null;
  /** 受影响实体展示名（前端直接渲染） */
  subjectLabel: string;
  /** 用户语言说明冲突内容与勾选后果 */
  detail: string;
  /** 敏感冲突（涉及锁定 / 已购 / 航班）默认不选 */
  sensitive: boolean;
  /** 默认选中策略：!sensitive && resolution !== null；前端可覆盖但以此渲染初值 */
  defaultSelected: boolean;
  /** 选中后执行的调整操作（user_confirmed 通道）；纯告知项为 null */
  resolution: Operation | null;
}

// ===== 草案可解释性分类（Task #250） =====

/**
 * 单个实体的本轮改动分类（服务端按「生成前行程快照 + 最终操作」确定性计算，
 * 前端只展示不推断）：
 * - remove：原在某天、终态不在任何天（移出回候选池）；
 * - rearrange：天级重排（换天 / 原天参与本轮重排 / 归入父景区）；
 * - new：此前不在任何天、本轮排入；
 * - retain：有真实保留依据（锁定 / 已购保护、指令点名锚点）；
 * - adjust：真实调整——没有换天，但被 setTime / setDuration / setPurchase / lock /
 *   内部 Stop 路线操作等改动（不得归入 snippet_only）；
 * - snippet_only：完全没有任何结构 / 时间 / 时长 / 内部路线操作，仅补攻略亮点。
 */
export type GuideDraftEntityClassification =
  | "remove"
  | "rearrange"
  | "new"
  | "retain"
  | "adjust"
  | "snippet_only";

/** 分类项（草案预览 / apply 结果解释的结构化条目） */
export interface GuideDraftClassifiedItem {
  /** 稳定键（classification + 实体引用），前端列表 key */
  key: string;
  classification: GuideDraftEntityClassification;
  targetRef: EntityRef;
  displayName: string;
  /** 终态所在天（1-based）；移出 / 无天可指为 null */
  dayIndex: number | null;
  /** 用户语言依据（服务端生成，前端直接展示） */
  detail: string;
}

/** 整日替换摘要中的实体引用 */
export interface GuideDraftReplaceItemRef {
  targetRef: EntityRef;
  displayName: string;
}

/** 整日替换摘要中的保留项（带保护原因） */
export interface GuideDraftReplaceKeptRef extends GuideDraftReplaceItemRef {
  /** 保留原因（已锁定 / 已购票） */
  reason: string;
}

/** 整日替换摘要（只由 mode="replace" 指令生成；append 指令不产生） */
export interface GuideDraftReplaceSummary {
  directiveId: string;
  dayIndex: number;
  /** 指令点名地点（裸「重排 DayN」为空串） */
  placeText: string;
  /** 本轮移回候选池的旧安排 */
  removed: GuideDraftReplaceItemRef[];
  /** 锁定 / 已购保留在原天的项 */
  kept: GuideDraftReplaceKeptRef[];
  /** 用户语言摘要（如「Day3 将移回 3 项（…），保留 1 项（…），再按所选攻略重排」） */
  text: string;
}

/**
 * 草案可解释性（可选字段；旧草案 / 旧服务端缺省时前端按原操作列表展示）。
 * 只用于预览解释，不参与 apply 校验与护栏。
 */
export interface GuideDraftExplanation {
  items: GuideDraftClassifiedItem[];
  /** 分类计数（固定包含全部六个键，便于前端分组标题） */
  counts: Record<GuideDraftEntityClassification, number>;
  /** 整日替换摘要（append 草案为空数组） */
  replaceSummaries: GuideDraftReplaceSummary[];
}

/** 草案中 AI 自动归类（classifyVisitAsStop）摘要：草案预览展示 + apply 响应回传 */
export interface GuideDraftAutoClassification {
  visitId: string;
  visitName: string;
  parentVisitId: string;
  parentName: string;
  evidenceMentionRefs: string[];
  reason: string;
}

/**
 * 攻略草案输入快照（附录 B §2.4）：冻结 Trip.version、可用来源版本、消费的提及与补充句。
 * 历史 Trip 允许保留过期快照（版本过期属于应用时拒绝，不阻止加载）。
 */
export interface PendingGuideDraft {
  draftId: string;
  /**
   * 应用时的比对基准：草案落盘后的 Trip.version（tripStore.save 恰自增 1）。
   * 应用时与当前 Trip.version 不一致即按版本保护拒绝（无后续变化才 fresh）。
   */
  baseTripVersion: number;
  /**
   * 实际生成输入时的 Trip.version（Task #105）：素材冻结并构建 prompt 时的版本快照。
   * 与 baseTripVersion 的分工：落盘前用本字段比对——生成期间行程被并发修改
   * （version 已不同）时旧输出不得绑定最新版本，草案不保存并返回 DRAFT_STALE；
   * 应用时仍以 baseTripVersion 比对（两者在正常路径上恒满足 base = input + 1）。
   * 旧存量草案可为缺失。
   */
  inputTripVersion?: number;
  /** 本次草案作用域 */
  scope: DraftScope;
  /** 冻结的可用来源及版本 */
  sourceSnapshots: GuideSourceVersionSnapshot[];
  /**
   * 实际消费的 mentionId 集合（附录 B §2.4）。存量 mentionId 仅在单条证据内唯一，
   * 因此同时保存 mentionRefs 作为精确寻址；应用阶段优先使用 mentionRefs。
   */
  mentionIds: string[];
  /** 与 mentionIds 对应的 "evidenceId:mentionId" 精确引用（可选，B1 增补） */
  mentionRefs?: string[];
  /** 补充句快照；null = 无补充句 */
  note: string | null;
  createdAt: string;
  /**
   * Task #123：从补充句解析出的日期硬性指令（可选，旧草案 / 无指令时缺失）。
   * 只属于草案快照，不写入 Trip.constraints；生成时已注入 planner prompt 且
   * 服务端后校验（目标 Visit 终态必须位于指定 Day）。
   */
  directives?: GuideDraftDayDirective[];
  /** 生成时的指令满足校验（按草案操作终态推演）；应用响应按真实行程重算返回 */
  requirementChecks?: GuideDraftRequirementCheck[];
  /** 生成时检测的排天冲突（任务 125 勾选数据源；apply 按 selectedConflictIds 部分应用） */
  conflicts?: GuideDraftConflict[];
  /**
   * B3 草案输出快照（可选增补；旧 Trip / 未生成输出时缺失 = 无可复用结果，
   * 应用端点要求重新生成）。包含生成时冻结的 operations 与 snippets。
   */
  output?: PendingGuideDraftOutput;
  /**
   * Task #250：生成时按「生成前行程快照 + 最终操作」计算的结构化分类（可选；
   * 旧草案缺失 = 前端按原操作列表展示）。只用于预览解释，不参与 apply 校验。
   */
  explanation?: GuideDraftExplanation;
  /**
   * Task #161：本轮草案的来源模式；旧草案缺失 = 视为 "all" 语义。
   * 与 sourceSnapshots 配合核对："selected" 时 sourceSnapshots 应与 sourceIds 一致。
   */
  sourceMode?: GuideDraftSourceMode;
  /**
   * Task #161：局部模式下用户显式选中的来源 id（sourceMode="selected" 时非空）；
   * 全部模式 / 旧草案缺失。用于结果召回与重复提交核对（同一选择重提应得到
   * 可比对的 sourceSnapshots），不参与 freshness 判定（来源版本变化由快照负责）。
   */
  sourceIds?: string[];
}

// ===== 大景区归属判断（PRD §11.6，后台三级 / 界面两态） =====

export interface RelationshipSuggestion {
  stopRef: string; // = stopId
  suggestedVisitRef: string | null; // medium 可填；high 已落 attached、low 为 null
  level: "high" | "medium" | "low";
  positiveSignals: string[];
  negativeSignals: string[];
  decidedBy: "system" | "user"; // 用户归类纠正后置 user，自动判断不得再覆盖
}

// ===== 住宿计划（PRD §11.7） =====

export interface LodgingPlan {
  dayIndex: number;
  /** 住宿区域名；可选（缺失 = 未设置） */
  areaName?: string | null;
  /** 酒店候选引用列表（指向 trip.hotelRegistry 的 hotelId；rev2 多候选契约） */
  hotelRefs: string[];
  /**
   * @deprecated rev2 改用 hotelRefs + trip.hotelRegistry（多候选）；暂保留，
   * 待迁移函数与全部消费方适配后删除。选中仅代表住宿意向，非真实订单。
   */
  hotelCandidate?: HotelCandidate | null;
  /**
   * @deprecated rev2 后住宿选中态由 hotelRegistry / hotelRefs 推导；暂保留，
   * 待全部消费方适配后删除。booked 仍须用户确认已订及入住/退房时间，
   * 并生成 hotel_checkin/hotel_checkout 约束。
   */
  status?: "placeholder" | "chosen" | "booked";
  /** 入住时间 "HH:MM"；可选（缺失 = 待定） */
  checkInTime?: string | null;
  /** 退房时间 "HH:MM"；可选（缺失 = 待定） */
  checkOutTime?: string | null;
  purchaseState: "unknown" | "toBuy" | "bought";
  locked: boolean;
  userAdjusted: boolean;
}

// ===== 约束（保持 v1.0 语义） =====

export interface Constraint {
  constraintId: string;
  type:
    | "flight_arrive"
    | "flight_depart"
    | "hotel_checkin"
    | "hotel_checkout"
    | "ticket_date"
    | "custom";
  anchorTime: string; // ISO8601
  dayIndex: number;
  label: string;
  locked: true;
}

// ===== 飞猪映射（供应商原始字段 → GoPlay 主数据，供 server 适配层使用） =====

/**
 * 飞猪 POI 免费状态（Task #329）：NOT_FREE = 收费在售；FREE = 免费入场；
 * UNKNOWN = 飞猪未标注；null = 记录未携带该字段（归一化层非法值也回落 null）。
 */
export type FreePoiStatus = "NOT_FREE" | "FREE" | "UNKNOWN" | null;

export interface FliggyPoi {
  id: string;
  address: string | null;
  category: string | null;
  description: string | null;
  freePoiStatus: FreePoiStatus;
  poiLevel: string | null;
  coords: { lng: number; lat: number } | null;
  mainPic: string | null;
  listRank: string | null;
  ticketInfo: string | null;
  jumpUrl: string | null;
}

export interface HotelCandidate {
  /** GoPlay 酒店主键：飞猪酒店 = shId，自定义酒店 = UUID（即 hotelRegistry 的 key） */
  id: string;
  shId: string; // 供应商酒店标识；飞猪酒店时与 id 一致，不是 itemId
  name: string;
  brandName: string | null;
  star: string | null;
  priceText: string | null; // 原样字符串如 "¥501"
  priceBasis: string; // 固定 "价格与库存以飞猪详情页为准"
  address: string | null;
  interestsPoi: string | null; // 如「近后海村」，不改名为 nearby
  decorationTime: string | null;
  coords: { lng: number; lat: number } | null;
  mainPic: string | null;
  detailUrl: string | null; // 飞猪酒店 H5，不重命名为 jumpUrl
  rate: string | null;
}

// ===== 只读分享（Task #205） =====

/**
 * 只读分享行程：`GET /api/share/:tripId` 返回的脱敏 Trip 子集。
 *
 * 与 Trip 的差异（由服务端 sanitizeTrip 保证）：
 * - 完全不含 evidences / guideSources / pendingGuideDraft / guideDraftNote
 *   —— 攻略原文、原图、来源链接与待应用草案不外泄；
 * - 不含 globalCandidateRefs / pendingStopRefs / relationshipSuggestions
 *   —— 候选池与来源归属溯源不进入分享页；
 * - visits / stops / items 的 sourceMentionRefs / sourceEvidenceRefs 恒为空数组，
 *   guideSnippets 只保留展示文本（攻略亮点），不再携带原文定位引用。
 *
 * 接收方（web ShareView）只读渲染：不写回、不持锁、不提供购票 / 锁定 / 拖拽操作。
 * schemaVersion 保留，供接收方做结构一致性闸门。
 */
export interface SharedTrip {
  tripId: string;
  schemaVersion: SchemaVersion;
  version: number;
  /** 行程封面三字段（Task #257）：与 Trip 同语义随分享下发，缺失 = 空值兜底 */
  coverImage?: string;
  tripName?: string;
  memo?: string;
  destination: Trip["destination"];
  dateRange: Trip["dateRange"];
  dayRefs: string[];
  days: Record<string, Day>;
  lodgings: Record<string, LodgingPlan>;
  itemRegistry: Record<string, Item>;
  hotelRegistry: Record<string, HotelCandidate>;
  visits: Record<string, Visit>;
  stops: Record<string, Stop>;
  constraints: Constraint[];
  createdAt: string;
  updatedAt: string;
}

// ===== Task #282：稀疏攻略澄清类型（C1/C2/C3 参赛必须） =====

/**
 * 澄清回答值（绑定 planScope 语义）：
 * - "guide_only" = A 选项：草案只覆盖攻略可支撑的天（其余天保持现安排）
 * - "ai_fill"    = B 选项：允许 AI 补充排满剩余天
 */
export type ClarificationAnswer = "guide_only" | "ai_fill";

/** 澄清选项（前端渲染用） */
export interface GuideDraftClarificationOption {
  value: ClarificationAnswer;
  label: string;
}

/**
 * 澄清响应结构（服务端检测到覆盖缺口时随 GuideDraftResult 返回；
 * 非空时表示草案未生成，前端须弹两选项交互，用户选择后带 answer 重发）。
 */
export interface GuideDraftClarification {
  question: string;
  options: GuideDraftClarificationOption[];
}

// ===== F11 操作集类型（applyOps 执行器契约） =====

export * from "./operations.js";
