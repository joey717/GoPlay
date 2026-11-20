/**
 * Task #301：E9 亚龙湾「页面落位」真值表（唯一数据源，纯数据零 node/fs 依赖）。
 *
 * 用途：`web/src/eval-ui.tsx sceneE9`（渲染现场）与 `eval/harness/uiShot.ts scene=e9`
 * （DOM 断言 + 截图 E9-page-mapping.png）共用同一份源码，杜绝两处口径漂移——与 q7Truth.ts 同构。
 *
 * 数据来源（两条独立证据链）：
 * 1. 抽取缓存 `eval/cache/extraction/6a93bde9….json`（Task #301 重抽：#300 note_tip 归属下沉
 *    新逻辑生效后 `npm run eval:corpus` 真实重建，capturedAt=2026-10-30T14:17:03Z，entries=19：
 *    attraction 1 / in_attraction 9 / note_tip 9；contentHash 未变＝正文未变，纯抽取方差＋归属下沉）；
 * 2. E9 recall 判定 `eval-report/v2/evidence/E9.log`（机器 recall 8/11=0.727，PD 裁量 3 条 boundary
 *    YLW-04/10/11 全判命中 → 11/11=1.0 pass；逐 claim 候选实体/sim/decision 与本表 mapping 一致）。
 *
 * 落位区域（真实 UI 语义，与 VisitCard/StopRow 渲染区对应）：
 * - parent_duration 父卡时长详情行：attraction.suggestMinutes（YLW-01 duration）
 * - parent_tips    父卡攻略提示区：归属父景点的 note_tip（VisitCard Module C 合并引用块，chips ≤2）
 * - stop_detail    子点位详情行：in_attraction 子景点的 quote/summary（StopRow locationHint 位）
 * - stop_tips      子点位贴士区：#300 下沉归属子景点的 note_tip（StopRow .guide-snippet-chip）
 *
 * 红线：本表为 #301 重抽快照；若再次重抽（抽取模型方差）导致 entries/归属变化，须同步刷新本表
 * 并在 uiShot 断言中体现，不得静默沿用旧值。
 */

/** 亚龙湾笔记 id（小红书原链 / 抽取缓存文件名共用） */
export const E9_NOTE_ID = "6a93bde9000000002600105b";

/** 笔记标题（取自抽取缓存 attraction 条目 quote 首行） */
export const E9_NOTE_TITLE = "亚龙湾热带天堂森林公园｜完整攻略+避坑指南";

/** 父景点（大景区父卡）名 */
export const E9_PARENT_NAME = "亚龙湾热带天堂森林公园";

/** 父卡时长（YLW-01 duration：suggestMinutes=210 ∈ golden [180,240]） */
export const E9_PARENT_MINUTES = 210;

/** 落位区域枚举（真实 UI 语义） */
export type E9Region = "parent_duration" | "parent_tips" | "stop_detail" | "stop_tips";

/** 落位区域中文标签（截图/对照表用） */
export const E9_REGION_LABEL: Readonly<Record<E9Region, string>> = {
  parent_duration: "父卡时长详情行",
  parent_tips: "父卡攻略提示区",
  stop_detail: "子点位详情行",
  stop_tips: "子点位贴士区（#300 下沉）",
};

/** in_attraction 子景点（重抽缓存 [1]..[9]，保序） */
export interface E9SubSpot {
  readonly name: string;
  readonly quote: string;
  readonly summary: string;
  readonly suggestMinutes: number | null;
  readonly confidence: string;
}

/**
 * 9 个 in_attraction 子景点（重抽快照）。过江龙索桥（YLW-06 落位）与试婚房（YLW-02 落位）、
 * 婚礼礼堂大草坪（YLW-03）、兰花谷（YLW-04）承载 golden claim 的子点位详情行内容。
 */
export const E9_SUBSPOTS: readonly E9SubSpot[] = [
  { name: "兰花谷", quote: "大门入园→坐观光车第一站：兰花谷（雨林植物，简单逛15-20分钟，可略过）", summary: "雨林植物区，简单逛可略过", suggestMinutes: 20, confidence: "high" },
  { name: "过江龙索桥", quote: "索桥（过江龙索桥）：20元，电影取景吊桥，人多排队；不想走可以旁边栈道绕过去不用花钱", summary: "电影取景吊桥，20元，人多可绕栈道", suggestMinutes: null, confidence: "high" },
  { name: "试婚房", quote: "试婚房：免费参观，就是你拍的这套木屋，内部还原电影陈设", summary: "《非诚勿扰2》木屋原址，免费参观很出片", suggestMinutes: null, confidence: "high" },
  { name: "鸟巢雨林栈道", quote: "📸打卡点：《非诚勿扰2》试婚房、鸟巢雨林栈道、山顶婚礼草坪、玻璃观景台", summary: "雨林栈道打卡点", suggestMinutes: null, confidence: "medium" },
  { name: "玻璃栈道", quote: "玻璃栈道：98元，追求拍照好看可以体验，性价比一般", summary: "玻璃观景台，98元，拍照好看但性价比一般", suggestMinutes: null, confidence: "high" },
  { name: "山顶公园", quote: "→观光车终点站：山顶公园｜山顶必逛：婚礼礼堂大草坪、沧海观景台、天街商业街", summary: "观光车终点，山顶核心游览区", suggestMinutes: null, confidence: "high" },
  { name: "婚礼礼堂大草坪", quote: "山顶草坪很适合拍照，大雾天云雾缭绕，晴天山海同框。", summary: "山顶大草坪，晴天山海同框很出片", suggestMinutes: null, confidence: "high" },
  { name: "沧海观景台", quote: "山顶天气好可以俯瞰整片亚龙湾大海", summary: "山顶观景台，可俯瞰亚龙湾大海", suggestMinutes: null, confidence: "high" },
  { name: "天街商业街", quote: "山顶必逛：婚礼礼堂大草坪、沧海观景台、天街商业街", summary: "山顶商业街，物价偏贵", suggestMinutes: null, confidence: "high" },
];

/** note_tip（重抽缓存 [10]..[18]，共 9 条：7 归父景点 + 2 下沉子景点） */
export interface E9NoteTip {
  /** 稳定序号（截图 DOM data-tip-id 用；非 golden claimId） */
  readonly tipId: string;
  /** 归属景点名（下沉后＝子景点名；父卡＝亚龙湾） */
  readonly name: string;
  readonly quote: string;
  readonly summary: string;
  /** 是否经 #300 归属下沉到子景点（true→子点位贴士区；false→父卡攻略提示区） */
  readonly sunk: boolean;
  /** 下沉目标子景点（sunk=true 时非空） */
  readonly sunkTo: string | null;
}

/**
 * 9 条 note_tip 归属全貌（7 父卡 / 2 下沉）——PD「3 条下沉预测 vs 2 条实测」核对锚点。
 * 下沉：玻璃栈道（YLW-08）、试婚房（防骗贴士）。过江龙索桥无独立 note_tip（排队信息被抽取器
 * 直接并入 in_attraction「过江龙索桥」条目，见 E9_SUBSPOTS，故 YLW-06 落子点位详情行而非贴士区）。
 */
export const E9_NOTE_TIPS: readonly E9NoteTip[] = [
  { tipId: "tip10", name: E9_PARENT_NAME, quote: "门票+往返观光车：140元左右，网上提前买比现场窗口便宜", summary: "门票省钱：网上提前购票比现场便宜", sunk: false, sunkTo: null },
  { tipId: "tip11", name: E9_PARENT_NAME, quote: "⚠️重点：观光车必买！！景区全是盘山陡坡，千万不要想着步行上山，走路又远又危险。", summary: "观光车必买，步行上山又远又危险", sunk: false, sunkTo: null },
  { tipId: "tip12", name: E9_PARENT_NAME, quote: "山上气温比山下低3-5℃，经常起雾、阵雨。大雾天山顶看不到亚龙湾大海！优先早上9-10点上山；随身带薄外套", summary: "天气避雷：山上低温多雾阵雨，带外套雨伞，早上上山", sunk: false, sunkTo: null },
  { tipId: "tip13", name: E9_PARENT_NAME, quote: "山上天街餐厅物价贵，矿泉水、零食建议山下提前买好带上去。", summary: "消费避雷：山上物价贵，水和零食山下买好带上去", sunk: false, sunkTo: null },
  { tipId: "tip14", name: "玻璃栈道", quote: "玻璃栈道谨慎买，如果遇到大雾，上去白茫茫什么都拍不到，钱就白花。", summary: "玻璃栈道避雾：大雾天别买玻璃栈道票，上去什么都看不到", sunk: true, sunkTo: "玻璃栈道" },
  { tipId: "tip15", name: "试婚房", quote: "试婚房是免费！不要被路边人忽悠花钱带你参观。", summary: "试婚房防骗：试婚房免费，别被忽悠花钱", sunk: true, sunkTo: "试婚房" },
  { tipId: "tip16", name: E9_PARENT_NAME, quote: "观光车是盘山公路，弯道特别多，容易晕车，晕车的提前备好晕车药。站点是单向行驶，不能倒回去坐，按顺序游玩。", summary: "晕车备忘：盘山公路易晕车需备药，站点单向不可倒回", sunk: false, sunkTo: null },
  { tipId: "tip17", name: E9_PARENT_NAME, quote: "山顶很多有偿拍照的小贩，先问清楚价格再拍，避免拍完漫天要价；自己手机完全足够出片。", summary: "拍照避雷：有偿拍照先问价，手机足够出片", sunk: false, sunkTo: null },
  { tipId: "tip18", name: E9_PARENT_NAME, quote: "建议上午上山，下午容易起雾；下午晚一点来，阳光柔和拍照好看，但遇上雾就看不到海。", summary: "时间规划建议：上午上山最佳，下午易起雾但阳光柔", sunk: false, sunkTo: null },
];

/** 归属父景点的 note_tip（父卡攻略提示区，7 条） */
export function e9ParentTips(): readonly E9NoteTip[] {
  return E9_NOTE_TIPS.filter((tip) => !tip.sunk);
}

/** 下沉子景点的 note_tip（子点位贴士区，2 条） */
export function e9SunkTips(): readonly E9NoteTip[] {
  return E9_NOTE_TIPS.filter((tip) => tip.sunk);
}

/** 单条 golden claim 的落位映射（与 evidence/E9.log 逐 claim 判定一致） */
export interface E9ClaimMapping {
  readonly claimId: string;
  readonly kind: "duration" | "highlight" | "poi" | "pitfall" | "tip";
  /** golden 期望文本（截断展示用完整取自 golden expectedClaims.text） */
  readonly goldenText: string;
  /** 落位区域 */
  readonly region: E9Region;
  /** 命中的抽取候选实体名 */
  readonly matchedEntity: string;
  /** 候选实体类型 */
  readonly entityType: "attraction" | "in_attraction" | "note_tip";
  /** 机器 bigram Dice 相似度（E9.log 实测） */
  readonly sim: number;
  /** 原始机器判定（未经 PD 裁量） */
  readonly machineDecision: "HIT" | "BOUNDARY";
  /** 最终判定（PD 裁量后，本套件全 HIT） */
  readonly finalDecision: "HIT";
  /** 是否经 PD 裁量转命中（machineDecision=BOUNDARY 者为 true） */
  readonly pdAdjudicated: boolean;
  /** 逐条说明（落位归因，含 #300 下沉/重抽漂移标注） */
  readonly note: string;
}

/**
 * 11 条 golden claim 落位对照（Task #301 重抽后，与 evidence/E9.log 一致）。
 * 分布：父卡时长详情 1（YLW-01）／父卡攻略提示区 5（YLW-05/07/09/10/11）／
 *       子点位详情行 4（YLW-02/03/04/06★）／子点位贴士区 1（YLW-08★）。
 * ★＝#300 归属下沉直接相关：YLW-06 过江龙索桥落子景点详情行、YLW-08 玻璃栈道落下沉贴士区。
 */
export const E9_CLAIM_MAPPING: readonly E9ClaimMapping[] = [
  { claimId: "YLW-01", kind: "duration", goldenText: "游玩时长3-4小时", region: "parent_duration", matchedEntity: E9_PARENT_NAME, entityType: "attraction", sim: 1.0, machineDecision: "HIT", finalDecision: "HIT", pdAdjudicated: false, note: "suggestMinutes=210 ∈ [180,240]，抽取器以结构字段承载 duration（父卡时长详情行）" },
  { claimId: "YLW-02", kind: "highlight", goldenText: "《非诚勿扰2》拍摄原址，试婚房免费，木屋栈道氛围感很出片", region: "stop_detail", matchedEntity: "试婚房", entityType: "in_attraction", sim: 0.458, machineDecision: "HIT", finalDecision: "HIT", pdAdjudicated: false, note: "重抽后候选变试婚房 in_attraction，机器直接 HIT（#299 时为 boundary·kind=tip 误触，本轮 kind=highlight 修正；PD override 变 no-op）" },
  { claimId: "YLW-03", kind: "highlight", goldenText: "山顶草坪很适合拍照，大雾天云雾缭绕，晴天山海同框", region: "stop_detail", matchedEntity: "婚礼礼堂大草坪", entityType: "in_attraction", sim: 0.689, machineDecision: "HIT", finalDecision: "HIT", pdAdjudicated: false, note: "内容命中且 kind 一致（highlight），子点位详情行" },
  { claimId: "YLW-04", kind: "highlight", goldenText: "观光车一站一站停靠，节奏可以自己把控", region: "stop_detail", matchedEntity: "兰花谷", entityType: "in_attraction", sim: 0.207, machineDecision: "BOUNDARY", finalDecision: "HIT", pdAdjudicated: true, note: "机器 sim=0.207∈[0.18,0.3) 内容存疑（#299 为 0.250）→ PD 判命中：golden 提炼表述、观光车信息（站点单向/按序游玩/盘山公路）已 surface 语义等价" },
  { claimId: "YLW-05", kind: "pitfall", goldenText: "物价贵，建议水、零食自备", region: "parent_tips", matchedEntity: E9_PARENT_NAME, entityType: "note_tip", sim: 0.303, machineDecision: "HIT", finalDecision: "HIT", pdAdjudicated: false, note: "note_tip「山上天街餐厅物价贵」归父卡攻略提示区；候选实体由 #299 的 in_attraction「天街餐厅」漂移为父卡 note_tip，命中不变" },
  { claimId: "YLW-06", kind: "pitfall", goldenText: "过江龙索桥排队人巨多，节假日排1小时以上，不想排可走旁边栈道绕过去不用花钱", region: "stop_detail", matchedEntity: "过江龙索桥", entityType: "in_attraction", sim: 0.471, machineDecision: "HIT", finalDecision: "HIT", pdAdjudicated: false, note: "★#300 归属下沉重点：排队信息本轮被抽取器直接并入 in_attraction「过江龙索桥」子景点，matcher 匹配子景点 entity sim=0.471 机器直接 HIT（#299 时候选为父卡 note_tip sim 0.686、PD 附注要求下沉，#300 已落地，归属细化意图达成）" },
  { claimId: "YLW-07", kind: "pitfall", goldenText: "有偿拍照漫天要价，先问清楚价格再拍", region: "parent_tips", matchedEntity: E9_PARENT_NAME, entityType: "note_tip", sim: 0.51, machineDecision: "HIT", finalDecision: "HIT", pdAdjudicated: false, note: "note_tip「有偿拍照先问价」归父卡攻略提示区，内容命中且 kind 一致（pitfall）" },
  { claimId: "YLW-08", kind: "pitfall", goldenText: "玻璃栈道谨慎买，如果遇到大雾，上去白茫茫什么都拍不到", region: "stop_tips", matchedEntity: "玻璃栈道", entityType: "note_tip", sim: 0.92, machineDecision: "HIT", finalDecision: "HIT", pdAdjudicated: false, note: "★#300 归属下沉：note_tip「玻璃栈道谨慎买大雾」已下沉归子景点「玻璃栈道」（子点位贴士区），matcher 匹配子景点 sim=0.92 命中（#299 时候选为父卡 亚龙湾）" },
  { claimId: "YLW-09", kind: "tip", goldenText: "网上提前买票比现场窗口便宜", region: "parent_tips", matchedEntity: E9_PARENT_NAME, entityType: "note_tip", sim: 0.541, machineDecision: "HIT", finalDecision: "HIT", pdAdjudicated: false, note: "note_tip「门票网上提前买便宜」归父卡攻略提示区（sim 由 #299 的 0.828 漂移至 0.541，命中不变）" },
  { claimId: "YLW-10", kind: "tip", goldenText: "观光车一定要买全是盘山陡坡，备好雨具，山上天气变幻莫测", region: "parent_tips", matchedEntity: E9_PARENT_NAME, entityType: "note_tip", sim: 0.233, machineDecision: "BOUNDARY", finalDecision: "HIT", pdAdjudicated: true, note: "机器 sim=0.233<0.3 内容存疑 → PD 判命中：golden 合并两 tip（观光车必买／备雨具）被抽取拆条稀释 bigram，pdNote 允诺语义拆分容忍" },
  { claimId: "YLW-11", kind: "tip", goldenText: "建议上午上山，下午容易起大雾看不到海；下午晚一点来，阳光柔和拍照好看", region: "parent_tips", matchedEntity: E9_PARENT_NAME, entityType: "note_tip", sim: 0.806, machineDecision: "BOUNDARY", finalDecision: "HIT", pdAdjudicated: true, note: "机器 sim=0.806 内容近乎逐字命中但反推 kind=pitfall≠tip（quote「看不到海」误触 PITFALL 词表）→ PD 判命中：词法误触，抽取归 note_tip 与 golden TIPS 归类一致（sim 由 #299 的 0.575 漂移至 0.806）" },
];

/** 按落位区域分组（对照表/截图分区渲染用；保持区域内 claimId 升序） */
export function e9ClaimsByRegion(region: E9Region): readonly E9ClaimMapping[] {
  return E9_CLAIM_MAPPING.filter((c) => c.region === region);
}

/** 落位区域展示顺序（截图分区从上到下） */
export const E9_REGION_ORDER: readonly E9Region[] = ["parent_duration", "parent_tips", "stop_detail", "stop_tips"];

/** E9 结果口径常量（截图页眉/对照表头用，与 evidence/E9.log 一致） */
export const E9_RECALL = {
  machineHits: 8,
  total: 11,
  machineRecall: 0.727,
  pdAdjudicatedCount: 3,
  pdAdjudicatedIds: ["YLW-04", "YLW-10", "YLW-11"] as readonly string[],
  finalRecall: 1.0,
  threshold: 0.8,
  sunkTipCount: 2,
  parentTipCount: 7,
  predictedSunkCount: 3,
} as const;
