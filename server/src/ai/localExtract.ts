/**
 * Task #181：结构化文字攻略的保守本地快速抽取（纯确定性，不触网、不调用百炼）。
 * Task #187：扩展到「主题段 + 项目符号 + 表情」型长攻略（真实样例约 700 字）。
 *
 * 背景：约 700 字、结构清晰（「地点名：描述」条目 + 明确 Day 标题）的攻略会反复
 * 耗尽百炼预算（首轮长耗时 + 不可解析输出）导致整篇失败；Task #187 的真实验收
 * 样例进一步以「主题标题 + 项目符号 + 装饰表情」组织，冒号条目不足以支撑占比，
 * 之前只能回落百炼并再次超时。本模块用纯确定性规则从此类文本直接产出条目：
 * - 质量达到 high（快速路径门槛）时，extractNoteEntries 直接采用本地结果，
 *   不调用百炼，耗时为毫秒级（明显低于 120s 预算）；
 * - 百炼解析失败后，若本地候选达到 fallback（明确最低可信标准），标记
 *   local_fallback 安全降级返回（上层据此落 partial 并提示重试）；否则维持失败，
 *   避免把不可靠解析误提交进行程。
 *
 * 保守原则（只认显式证据，绝不推断）：
 * - Day 归属只认行首的明确标题（Day N / DN / 第 N 天），行中提及不构成归属；
 *   标题前条目与无标题文本一律 dayIndex=null，不凭空推断日期；
 * - Task #187 新增三类「行首明确结构」：主题标题（如「海边咖啡｜坐着就不想走」）
 *   只作段落上下文，本身不是 POI；主题下的项目符号行可产出条目；正文句只认
 *   「行首地点 + 强地理/地标后缀 + 谓词或停顿」的明确地点句，不做自然语言猜测；
 * - 玩法 / 分类主题词（冲浪、赶海、海边咖啡、特色小店、拍照打卡、实用 TIPS…）
 *   以及随身物品 / 装备 / 价格 / 时段 / 停车 / 季节词一律不作为地点；这些信息
 *   仍保留在所属条目引用的原始整行 quote 中；
 * - 原始整行（含项目符号与表情）作为 quote 证据文本原样保留——清洗只作用于
 *   解析用的副本，绝不把清洗后的片段冒充原文；
 * - 条目只认行首结构（冒号条目 / 强锚点项目符号 / 强锚点正文句），不推断 type
 *   （一律 attraction）、父子关系（parentAttraction=null）、建议时长
 *   （suggestMinutes=null）与大景区规模（scale=null）；不产出 OCR 扩展字段；
 * - 名称校验宁缺勿滥：平台词 / 泛化词 / 主题词 / 行程标题词 / 随身物品词 / 含
 *   列表分隔符与竖线结构的候选一律拒绝——被拒文本自然回落既有百炼路径；
 * - 快速路径另需至少 1 条「强锚点」条目（地理 / 地标 / 经营场所后缀或英文店名），
 *   防止「人物：动作」这类混乱清单被误当结构化攻略顶替模型产出。
 */

import {
  DEFAULT_SUMMARY,
  isPlatformOrGenericPlaceName,
  normalizePoiName,
  type ParsedEntry,
} from "./assemble.js";

// ===== 置信档位 =====

/** 本地抽取质量分级：high=可跳过百炼；fallback=仅百炼解析失败后安全降级可用；insufficient=维持远端路径 */
export type LocalExtractQuality = "high" | "fallback" | "insufficient";

/** 高置信（本地快速路径）最低条目数 */
export const LOCAL_FAST_PATH_MIN_ENTRIES = 3;
/** 高置信（本地快速路径）最低结构化占比：条目行 /（条目行 + 散文行） */
export const LOCAL_FAST_PATH_MIN_RATIO = 0.6;

/**
 * 百炼解析失败后安全降级（partial）的最低可信标准。
 * 刻意严格低于快速路径门槛：快速路径替代模型产出，必须文本高度结构化；
 * 降级是远端失败后的兜底，只需「候选明确可信」，门槛略放宽但仍有硬底线。
 */
export const LOCAL_FALLBACK_MIN_ENTRIES = 2;
/** 降级最低结构化占比 */
export const LOCAL_FALLBACK_MIN_RATIO = 0.4;

/** 本地条目上限（防御病态超长输入；超出丢弃并标记 truncated，不让搜索额度爆掉） */
export const LOCAL_MAX_ENTRIES = 30;

/**
 * Task #187：高置信（本地快速路径）最低强锚点条目数。
 * 「阿明：开车 / 小美：拍照 / 老王：吃饭」这类混乱清单也能通过名称校验，但没有任何
 * 地理 / 地标 / 经营场所锚点——只允许降到 fallback（百炼失败后的 partial 兜底），
 * 不得直接顶替模型产出。
 */
export const LOCAL_FAST_PATH_MIN_ANCHORED = 1;

const NAME_MIN_CHARS = 2;
const NAME_MAX_CHARS = 16;
/** 描述最小长度：空描述 / 单字描述不构成可信条目 */
const DESC_MIN_CHARS = 2;
/** 剥除装饰后达到该长度的非条目内容行按散文计（短行多为小标题，不计入惩罚） */
const PROSE_MIN_CHARS = 10;
/** 主题标题行最大长度（超出按正文处理，避免把长散文当标题白送占比） */
const SECTION_HEADING_MAX_CHARS = 30;

// ===== 行级解析：装饰剥除 / Day 标题 / 「地点名：描述」条目 =====

/** 行首装饰与编号前缀（井号标题 / 列表符号 / 「1.」编号 / 空白），可重复出现 */
const LINE_DECOR_PREFIX =
  /^(?:\s|#{1,6}|\*{1,3}|-{1,3}|[•·▪▫◦‣∙●○◉◆◇■□▸▹►▶✔✓☑>]+|\d{1,2}[.、)）])+/;

/**
 * 行首装饰表情（Task #187）：emoji / 变体选择符 / 零宽连接符 / 肤色修饰 / 键帽，
 * 连同其后的空白一并剥除。只作用于解析副本，quote 始终保留原始整行。
 */
const EMOJI_LEAD = /^(?:\p{Extended_Pictographic}|\uFE0F|\u200D|[\u{1F3FB}-\u{1F3FF}]|\u20E3|\s)+/u;

/** 项目符号 / 编号 / 标题前缀（Task #187：判定「这一行是项目符号行」） */
const BULLET_LEAD = /^(?:#{1,6}|\*{1,3}|-{1,3}|[•·▪▫◦‣∙●○◉◆◇■□▸▹►▶✔✓☑>]+|\d{1,2}[.、)）])/;

/**
 * Day 标题（day 词形态）：Day 1 / Day1 / Day-2 / DAY 3。数字后不得紧跟字母数字
 * （「Day1 三亚」✓、「Day1st」✗）；标题后允许跟标题文字（如「Day 1 后海村」）。
 */
const DAY_HEADING_WORD = /^day\s*[-–—]?\s*([0-9０-９]{1,2})(?![0-9A-Za-z])/i;

/**
 * Day 标题（单字母形态）：D1 / d 2 / D1、市区。数字后必须是分隔符或行尾——
 * 防止把「D2咖啡馆：好喝」这类地点行误吞成标题。
 */
const DAY_HEADING_BARE =
  /^d\s*([0-9０-９]{1,2})(?![0-9A-Za-z])(?:$|[\s:：、.。·，,\-–—~～(（【])/i;

/** Day 标题（中文形态）：第一天 / 第2天 / 第十二日（数字或中文数字，解析后限 1..99） */
const DAY_HEADING_CN = /^第\s*([0-9０-９]{1,3}|[零一二两三四五六七八九十]{1,3})\s*[天日](?![0-9A-Za-z])/;

const CN_DIGIT: Record<string, number> = {
  零: 0,
  一: 1,
  两: 2,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 中文数字 / 全角数字转数值（支持 1..99 的「十」组合，如 十/十一/二十三）；无法解析返回 null */
export function parseDayNumber(raw: string): number | null {
  const text = raw.trim();
  if (text === "") return null;
  const ascii = text.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  if (/^\d+$/.test(ascii)) {
    const value = Number(ascii);
    return value >= 1 && value <= 99 ? value : null;
  }
  if (!/^[零一二两三四五六七八九十]+$/.test(text)) return null;
  if (text === "十") return 10;
  const tenIndex = text.indexOf("十");
  if (tenIndex < 0) {
    const digit = CN_DIGIT[text];
    return digit === undefined ? null : digit;
  }
  const leftPart = text.slice(0, tenIndex);
  const rightPart = text.slice(tenIndex + 1);
  const left = leftPart === "" ? 1 : CN_DIGIT[leftPart];
  const right = rightPart === "" ? 0 : CN_DIGIT[rightPart];
  if (left === undefined || right === undefined) return null;
  const value = left * 10 + right;
  return value >= 1 && value <= 99 ? value : null;
}

/** 剥除行首装饰（表情 + 符号 / 编号前缀，交替出现时循环剥到稳定） */
function stripLineDecor(line: string): string {
  let text = line;
  for (let round = 0; round < 6; round++) {
    const next = text.replace(EMOJI_LEAD, "").replace(LINE_DECOR_PREFIX, "");
    if (next === text) break;
    text = next;
  }
  return text;
}

/** 项目符号行判定（表情剥除后仍以符号 / 编号 / 井号开头） */
function isBulletLine(line: string): boolean {
  return BULLET_LEAD.test(line.replace(EMOJI_LEAD, ""));
}

// ===== Task #187：主题标题（玩法 / 分类段落）=====

/**
 * 主题 / 分类标题词（归一化 exact）：默认是玩法或分类，不是可到访地点。
 * 只做 exact 判定——「麦芽洞穴咖啡」这类具体店名不等于「咖啡」，不得误杀。
 */
const THEME_TITLE_WORDS = new Set([
  "冲浪",
  "赶海",
  "浮潜",
  "潜水",
  "海钓",
  "citywalk",
  "度假",
  "玩法",
  "玩乐",
  "海边咖啡",
  "咖啡",
  "特色小店",
  "小店",
  "购物",
  "买买买",
  "拍照打卡",
  "拍照",
  "打卡",
  "出片",
  "观景",
  "机位",
  "实用tips",
  "tips",
  "小贴士",
  "注意事项",
  "行前准备",
  "穿搭",
  "住宿",
  "美食",
  "交通",
  "路线",
  "行程",
  "攻略",
  "总结",
  "必吃",
  "必逛",
  "夜生活",
]);

/** 名称归一化键（去空白 / 小写）：主题词、锚点、同名去重共用口径 */
function normalizeNameKey(name: string): string {
  return normalizePoiName(name).replace(/\s+/g, "").toLowerCase();
}

/** 主题 / 分类名判定：exact，或「主题｜副标题」前段为 exact（Task #187） */
function isThemeName(name: string): boolean {
  const key = normalizeNameKey(name);
  if (key === "") return false;
  if (THEME_TITLE_WORDS.has(key)) return true;
  const barIndex = key.search(/[｜|]/);
  return barIndex > 0 && THEME_TITLE_WORDS.has(key.slice(0, barIndex));
}

interface SectionHeadingMatch {
  title: string;
  theme: boolean;
}

/**
 * 主题标题行判定（Task #187）：短行、无冒号、无句末标点，且带结构标记
 * （竖线 ｜/| 或 【】包裹）或归一化后是主题词。
 * 标题行不计散文惩罚，也永远不产出条目——避免「海边咖啡｜坐着就不想走」这类
 * 分类标题被当成 POI，同时不让标题行拉低结构化占比。
 */
function matchSectionHeading(line: string): SectionHeadingMatch | null {
  const stripped = stripLineDecor(line).trim();
  if (stripped === "" || stripped.length > SECTION_HEADING_MAX_CHARS) return null;
  if (/[:：]/.test(stripped)) return null;
  if (/[。！？!?；;]/.test(stripped)) return null;
  const bracketed = /^[【\[][^】\]]+[】\]]$/.test(stripped);
  const hasBar = /[｜|]/.test(stripped);
  const theme = isThemeName(stripped);
  if (!bracketed && !hasBar && !theme) return null;
  return { title: stripped, theme };
}

interface DayHeadingMatch {
  dayIndex: number;
  /** 标题行剥除标题后的剩余文本（可能内嵌「地点名：描述」条目，如「第1天：第一市场：吃海鲜」） */
  rest: string;
}

/** 行首明确 Day 标题判定（三种形态任一命中；行中提及一律不算归属） */
function matchDayHeading(line: string): DayHeadingMatch | null {
  const stripped = stripLineDecor(line);
  for (const pattern of [DAY_HEADING_WORD, DAY_HEADING_BARE, DAY_HEADING_CN]) {
    const match = stripped.match(pattern);
    if (match === null) continue;
    const dayIndex = parseDayNumber(match[1]);
    if (dayIndex === null) return null;
    return { dayIndex, rest: stripped.slice(match[0].length) };
  }
  return null;
}

// ===== 名称清洗与校验（宁缺勿滥的守门员） =====

/** 名称两端噪音（emoji / 引号 / 标点 / 时间与编号前缀）：只剥两端，不动名称内部 */
const NAME_LEAD_NOISE = /^[^\u4e00-\u9fa5A-Za-z0-9（【「『]+/;
const NAME_TAIL_NOISE = /[^\u4e00-\u9fa5A-Za-z0-9）】」』%]+$/;
/** 名称内嵌的日期前缀（D1 / d2）：如「D1后海村」按「后海村」处理 */
const NAME_DAY_PREFIX = /^d\s*[0-9０-９]{1,2}\s*(?=[\u4e00-\u9fa5A-Za-z])/;

/** 行程标题词（含即拒绝）：是笔记结构词而非地点 */
const NAME_TITLE_WORDS = [
  "攻略",
  "行程",
  "游记",
  "指南",
  "清单",
  "合集",
  "避雷",
  "总结",
  "日记",
  "路线",
  "规划",
];

/**
 * 英文标题词（Task #187）：只做整词判定——之前用 includes 会把「tipsy」当成
 * 「tips」误杀，而 tipsy 是真实店名。
 */
const NAME_TITLE_WORDS_EN_PATTERN = /(?:^|[^a-z])(?:vlog|tips)(?:[^a-z]|$)/i;

/** 散文指示词（含即拒绝）：地点名不会包含人称 / 时序 / 推介措辞 */
const NAME_STOPWORDS = [
  "我们",
  "我",
  "你",
  "大家",
  "今天",
  "昨天",
  "明天",
  "早上",
  "上午",
  "中午",
  "下午",
  "傍晚",
  "晚上",
  "然后",
  "接着",
  "首先",
  "最后",
  "另外",
  "此外",
  "这里",
  "那里",
  "推荐",
  "必去",
  "必吃",
  "必逛",
];

/** 随身物品 / 信息标签词（含即拒绝）：常见「物品：描述」行不是可到访地点 */
const NAME_LABEL_WORDS = [
  "防晒",
  "防晒霜",
  "泳衣",
  "泳镜",
  "冲浪服",
  "装备",
  "教练",
  "浪高",
  "停车",
  "电驴",
  "季节",
  "墨镜",
  "太阳镜",
  "帽子",
  "裙子",
  "相机",
  "充电宝",
  "雨伞",
  "护照",
  "签证",
  "身份证",
  "驾照",
  "拖鞋",
  "外套",
  "美食",
  "小吃",
  "早餐",
  "午餐",
  "晚餐",
  "宵夜",
  "住宿",
  "交通",
  "费用",
  "门票",
  "备注",
  "地址",
  "电话",
  "营业时间",
  "时间",
  "人均",
  "预算",
];

/** 行程天数标题形态开头（三天两夜 / 5天4晚）→ 笔记总标题而非地点 */
const NAME_TRIP_TITLE = /^[0-9０-９一二两三四五六七八九十]+\s*[天日晚夜]/;

/** 名称内列表 / 分句分隔符（含冒号）→ 一行多地点或多句，无法归属单点（保守拒绝） */
const NAME_LIST_SEPARATOR = /[、，,;；/:：]/;

/** 名称必须至少含一个汉字或字母（排除纯数字 / 纯时间 / 纯符号） */
const NAME_HAS_WORD = /[A-Za-z\u4e00-\u9fa5]/;

// ===== Task #187：地点锚点（强证据后缀，宁缺勿滥）=====

/**
 * 强地理 / 地标后缀（白名单）：正文地点句与无冒号项目符号的抽取锚点。
 * 只收「几乎只出现在地名尾部」的后缀；单字「路 / 街 / 巷 / 山 / 湖 / 桥」等
 * 歧义词不做正文锚点（仍可由冒号条目 + 名称校验收下）。
 */
const PLACE_ANCHOR_SUFFIXES = [
  "礁石区",
  "礁石滩",
  "礁石",
  "森林公园",
  "观景台",
  "步行街",
  "博物馆",
  "美术馆",
  "图书馆",
  "度假区",
  "保护区",
  "海滩",
  "沙滩",
  "海岸",
  "码头",
  "堤坝",
  "灯塔",
  "栈桥",
  "浴场",
  "古城",
  "古镇",
  "夜市",
  "市场",
  "公园",
  "广场",
  "景区",
  "景点",
  "机场",
  "车站",
  "港口",
  "小学",
  "中学",
  "大学",
  "村",
  "镇",
  "湾",
  "滩",
  "岛",
  "岭",
  "峰",
  "城",
];

/**
 * 经营场所 / 设施后缀：与地理后缀一起构成「强锚点」，只用于快速路径门槛
 * （不用于正文抽取），让「麦芽洞穴咖啡」「海边秋千」这类线索也能证明文本
 * 是地点攻略而不是混乱清单。
 */
const VENUE_ANCHOR_SUFFIXES = [
  "咖啡馆",
  "咖啡",
  "餐厅",
  "餐馆",
  "酒馆",
  "酒吧",
  "茶馆",
  "书店",
  "民宿",
  "酒店",
  "客栈",
  "市集",
  "集市",
  "小馆",
  "面馆",
  "食堂",
  "甜品店",
  "甜品",
  "烧烤",
  "大排档",
  "排档",
  "清补凉",
  "秋千",
  "营地",
  "农场",
  "花园",
];

/** 名称是否以强地理 / 地标后缀收尾（事件词剥除只看地理后缀，不认经营场所） */
function endsWithPlaceAnchor(name: string): boolean {
  const key = normalizeNameKey(name);
  if (key === "") return false;
  return PLACE_ANCHOR_SUFFIXES.some((suffix) => key.endsWith(suffix));
}

/** 地理 / 地标 / 经营场所后缀（正文地点句的锚点：英文短句不参与） */
function hasPlaceOrVenueAnchor(name: string): boolean {
  const key = normalizeNameKey(name);
  if (key === "") return false;
  return (
    PLACE_ANCHOR_SUFFIXES.some((suffix) => key.endsWith(suffix)) ||
    VENUE_ANCHOR_SUFFIXES.some((suffix) => key.endsWith(suffix))
  );
}

/** 强锚点条目（项目符号行 / 快速路径门槛）：地理 / 经营场所后缀，或英文店名 */
export function hasStrongPlaceAnchor(name: string): boolean {
  const key = normalizeNameKey(name);
  if (key === "") return false;
  if (/[a-z]{3,}/.test(key)) return true;
  return hasPlaceOrVenueAnchor(name);
}

/**
 * 事件 / 活动后缀（Task #187）：仅当剥除后仍是强地理名称才生效
 * （「皇后湾日出」→「皇后湾」；「麦芽洞穴咖啡打卡」不生效，保持原样）。
 */
const NAME_EVENT_SUFFIXES = ["看日出", "看日落", "日出", "日落", "夜景", "打卡", "拍照"];

/** 剥除名称尾部的事件词（地理锚点不成立时原样返回，不做泛化裁剪） */
function stripEventSuffix(name: string): string {
  for (const suffix of NAME_EVENT_SUFFIXES) {
    if (!name.endsWith(suffix)) continue;
    const base = name.slice(0, -suffix.length);
    if (base.length >= NAME_MIN_CHARS && endsWithPlaceAnchor(base)) return base;
  }
  return name;
}

/** 名称清洗：剥两端噪音 / 整体括号包裹 / 日期前缀 / 尾部事件词 */
function cleanName(rawName: string): string {
  let name = rawName.trim().replace(NAME_LEAD_NOISE, "").replace(NAME_TAIL_NOISE, "");
  const wrapped = name.match(/^[（【「『](.+)[）】」』]$/);
  if (wrapped !== null) name = wrapped[1];
  name = name.replace(NAME_DAY_PREFIX, "");
  return stripEventSuffix(name.trim());
}

/** 名称校验：长度 / 必须含词 / 无分隔符与句末标点 / 非标题词与非地点词 */
function isValidPlaceName(name: string): boolean {
  if (name.length < NAME_MIN_CHARS || name.length > NAME_MAX_CHARS) return false;
  if (!NAME_HAS_WORD.test(name)) return false;
  if (NAME_LIST_SEPARATOR.test(name)) return false;
  if (/[｜|]/.test(name)) return false;
  if (/[。！？!?；;…]/.test(name)) return false;
  // 「后海村的沙滩」这类带「的」的短语不是单一地点名（保守拒绝）
  if (name.includes("的")) return false;
  if (NAME_TRIP_TITLE.test(name)) return false;
  const lowered = name.toLowerCase();
  if (NAME_TITLE_WORDS_EN_PATTERN.test(name)) return false;
  for (const word of NAME_TITLE_WORDS) {
    if (lowered.includes(word)) return false;
  }
  for (const word of NAME_STOPWORDS) {
    if (name.includes(word)) return false;
  }
  for (const word of NAME_LABEL_WORDS) {
    if (name.includes(word)) return false;
  }
  // Task #187：玩法 / 分类主题词（exact）默认不是地点
  if (isThemeName(name)) return false;
  // 与装配层同口径：平台 / 媒体词与纯泛化地理类型词不作为地点
  if (isPlatformOrGenericPlaceName(name)) return false;
  return true;
}

interface EntryLineMatch {
  name: string;
  /** 原始整行（trim 后），作为证据文本原样保留 */
  quote: string;
}

/**
 * 「地点名：描述」行匹配：按冒号（全角/半角）切分，名称校验是唯一守门员。
 * 逐个冒号尝试「上一冒号后的段」与「行首全前缀」两种名称候选——兼容
 * 「9:30-12:00 后海村：冲浪」「今天行程：后海村：冲浪」等前缀场景；
 * URL 行（ scheme:// ）不参与，避免把链接当条目。
 */
function matchEntryLine(line: string): EntryLineMatch | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) return null;
  // 解析副本剥除行首项目符号 / 表情（Task #187）；quote 仍用原始整行
  const parsed = stripLineDecor(trimmed).trim();
  if (parsed === "") return null;

  const colonPattern = /[:：]/g;
  const colonIndexes: number[] = [];
  let colonMatch: RegExpExecArray | null;
  while ((colonMatch = colonPattern.exec(parsed)) !== null) colonIndexes.push(colonMatch.index);

  for (let i = 0; i < colonIndexes.length; i++) {
    const colonIndex = colonIndexes[i];
    const rest = parsed.slice(colonIndex + 1).trim();
    if (rest.length < DESC_MIN_CHARS) continue;
    const prevColonIndex = i > 0 ? colonIndexes[i - 1] : -1;
    const candidates = [
      parsed.slice(prevColonIndex + 1, colonIndex),
      parsed.slice(0, colonIndex),
    ];
    for (const candidate of candidates) {
      const name = cleanName(candidate);
      if (!isValidPlaceName(name)) continue;
      return { name, quote: trimmed };
    }
  }
  return null;
}

// ===== Task #187：项目符号行 / 正文明确地点句 =====

/** 正文句地点候选的谓词边界（「后海村是…」「皇后湾适合…」）：只切行首首个分句 */
const PROSE_PREDICATE = /是|有|在|能|可以|适合|位于|靠近|附近|值得|很|非常/;

/**
 * 无冒号的项目符号条目（Task #187）：「• 纯白灯塔 村口最出名的机位」。
 * 名称（行首到首个空白 / 标点）必须命中强锚点才收——「停车20元一天」
 * 「防晒霜 SPF50」这类装备 / 价格 / 时段行一律拒绝。
 */
function matchBulletEntry(line: string): EntryLineMatch | null {
  const trimmed = line.trim();
  if (!isBulletLine(trimmed)) return null;
  const stripped = stripLineDecor(trimmed).trim();
  const match = stripped.match(/^([^，,。；;：:、\s]{2,16})(?:\s+|[，,。；;、])(.+)$/);
  if (match === null) return null;
  const rest = match[2].trim();
  if (rest.length < DESC_MIN_CHARS) return null;
  const name = cleanName(match[1]);
  if (!isValidPlaceName(name) || !hasStrongPlaceAnchor(name)) return null;
  return { name, quote: trimmed };
}

/**
 * 正文内明确地点句（Task #187，有限支持）：行首首个分句的前缀，以地理 /
 * 经营场所锚点收尾，且紧接着谓词或停顿。只认「地名打头」的句子；句中出现的
 * 其他名词、价格、教练、装备、时段一概不抽取（它们留在该条目的原始 quote 里）。
 */
function matchProsePlaceLine(line: string): EntryLineMatch | null {
  const trimmed = line.trim();
  const stripped = stripLineDecor(trimmed).trim();
  if (stripped.length < NAME_MIN_CHARS + DESC_MIN_CHARS) return null;
  const boundary = stripped.search(/[，,。；;：:、！？!?]/);
  if (boundary === 0) return null;
  const head = (boundary > 0 ? stripped.slice(0, boundary) : stripped).trim();
  const predicateIndex = head.search(PROSE_PREDICATE);
  const candidate = predicateIndex > 0 ? head.slice(0, predicateIndex) : head;
  const rest = stripped.slice(candidate.length).trim();
  if (rest.length < DESC_MIN_CHARS) return null;
  const name = cleanName(candidate);
  if (!isValidPlaceName(name) || !hasPlaceOrVenueAnchor(name)) return null;
  return { name, quote: trimmed };
}

// ===== 评估结果与主入口 =====

/** 本地结构化抽取评估结果（含指标，供测试与日志观测） */
export interface LocalExtractAssessment {
  quality: LocalExtractQuality;
  /** 去重后的本地条目（quote=原始整行证据；dayIndex=明确 Day 归属或 null） */
  entries: ParsedEntry[];
  /** 命中结构化条目（冒号 / 项目符号 / 正文句）的内容行数（去重前） */
  structuredLineCount: number;
  /** 其中：「地点名：描述」冒号条目行数 */
  colonEntryCount: number;
  /** 其中：无冒号项目符号条目行数 */
  bulletEntryCount: number;
  /** 其中：正文明确地点句行数 */
  proseEntryCount: number;
  /** 按散文计的内容行数（剥装饰后较长、既非标题也非条目） */
  proseLineCount: number;
  /** 结构化占比：structuredLineCount / (structuredLineCount + proseLineCount) */
  structuredRatio: number;
  /** 命中的明确 Day 标题数 */
  dayHeadingCount: number;
  /** 主题 / 分类标题行数（Task #187：不计散文惩罚，也不产出条目） */
  sectionHeadingCount: number;
  /** 带 Day 归属的条目数（去重后） */
  dayMappedEntryCount: number;
  /** 同名去重丢弃的条目数 */
  duplicateCount: number;
  /** 条目数超上限发生截断 */
  truncated: boolean;
  /** 强锚点条目数（Task #187：快速路径门槛之一） */
  anchoredEntryCount: number;
}

/**
 * 保守本地抽取主入口：逐行解析 Day 标题、主题标题、冒号条目、强锚点项目符号
 * 与正文明确地点句，统计结构化占比并分级。纯函数、零副作用、毫秒级；不满足
 * high 时不产出任何副作用，调用方继续走既有百炼路径。
 */
export function assessLocalExtract(text: string): LocalExtractAssessment {
  const lines = text.split(/\r?\n/);
  let currentDay: number | null = null;
  let structuredLineCount = 0;
  let colonEntryCount = 0;
  let bulletEntryCount = 0;
  let proseEntryCount = 0;
  let proseLineCount = 0;
  let dayHeadingCount = 0;
  let sectionHeadingCount = 0;
  let duplicateCount = 0;
  let truncated = false;
  const entries: ParsedEntry[] = [];
  const seenNames = new Set<string>();

  const addEntry = (name: string, quote: string, dayIndex: number | null): void => {
    // Task #187：英文店名大小写不敏感去重（Tipsy / tipsy 是同一家）
    const key = normalizeNameKey(name);
    if (key === "") return;
    if (seenNames.has(key)) {
      duplicateCount += 1;
      return;
    }
    if (entries.length >= LOCAL_MAX_ENTRIES) {
      truncated = true;
      return;
    }
    seenNames.add(key);
    entries.push({
      name,
      type: "attraction",
      parentAttraction: null,
      scale: null,
      confidence: "high",
      suggestMinutes: null,
      locationHint: null,
      quote,
      summary: DEFAULT_SUMMARY,
      ticketRelation: "unknown",
      suggestedVisitName: null,
      bbox: null,
      relationEvidence: null,
      dayIndex,
      extractSource: "local",
    });
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    // 1. Day 标题：更新当前归属；标题行内嵌条目（如「第1天：第一市场：吃海鲜」）
    //    仍须通过完整名称校验才算条目
    const heading = matchDayHeading(trimmed);
    if (heading !== null) {
      currentDay = heading.dayIndex;
      dayHeadingCount += 1;
      const restEntry = matchEntryLine(heading.rest.replace(/^[:：\s]+/, ""));
      if (restEntry !== null) {
        structuredLineCount += 1;
        colonEntryCount += 1;
        addEntry(restEntry.name, trimmed, heading.dayIndex);
      }
      continue;
    }

    // 2. 主题 / 分类标题（Task #187）：只作段落上下文，不产出条目、不计散文惩罚
    const section = matchSectionHeading(trimmed);
    if (section !== null) {
      sectionHeadingCount += 1;
      continue;
    }

    // 3. 「地点名：描述」条目：归属当前 Day（无标题 → null，不推断）
    const entry = matchEntryLine(trimmed);
    if (entry !== null) {
      structuredLineCount += 1;
      colonEntryCount += 1;
      addEntry(entry.name, trimmed, currentDay);
      continue;
    }

    // 4. 无冒号项目符号条目（Task #187）：名称必须命中强锚点
    const bullet = matchBulletEntry(trimmed);
    if (bullet !== null) {
      structuredLineCount += 1;
      bulletEntryCount += 1;
      addEntry(bullet.name, trimmed, currentDay);
      continue;
    }

    // 5. 正文明确地点句（Task #187）：只认「地名打头 + 强锚点 + 谓词/停顿」
    const proseEntry = matchProsePlaceLine(trimmed);
    if (proseEntry !== null) {
      structuredLineCount += 1;
      proseEntryCount += 1;
      addEntry(proseEntry.name, trimmed, currentDay);
      continue;
    }

    // 6. 其余内容行：长行按散文计（拉低占比），短行视为小标题不计惩罚
    if (stripLineDecor(trimmed).length >= PROSE_MIN_CHARS) proseLineCount += 1;
  }

  // 快速路径门槛（Task #187 新增强锚点下限）：无序列表清单（「人物：动作」）
  // 即便条目数与占比达标，也因缺少地理 / 经营场所锚点而不得顶替模型产出
  const anchoredEntryCount = entries.filter((entry) => hasStrongPlaceAnchor(entry.name)).length;
  const denominator = structuredLineCount + proseLineCount;
  const structuredRatio = denominator > 0 ? structuredLineCount / denominator : 0;
  const quality: LocalExtractQuality =
    entries.length >= LOCAL_FAST_PATH_MIN_ENTRIES &&
    structuredRatio >= LOCAL_FAST_PATH_MIN_RATIO &&
    anchoredEntryCount >= LOCAL_FAST_PATH_MIN_ANCHORED
      ? "high"
      : entries.length >= LOCAL_FALLBACK_MIN_ENTRIES && structuredRatio >= LOCAL_FALLBACK_MIN_RATIO
        ? "fallback"
        : "insufficient";

  return {
    quality,
    entries,
    structuredLineCount,
    colonEntryCount,
    bulletEntryCount,
    proseEntryCount,
    proseLineCount,
    structuredRatio,
    dayHeadingCount,
    sectionHeadingCount,
    dayMappedEntryCount: entries.filter((entry) => typeof entry.dayIndex === "number").length,
    duplicateCount,
    truncated,
    anchoredEntryCount,
  };
}

/**
 * 把本地条目标记为「百炼解析失败后的降级结果」（仅降级路径使用）：
 * 快速路径条目保持 extractSource="local"，降级条目翻转为 "local_fallback"，
 * 上层（guides 结算 / F5 errors）据此落 partial 并提示重试。
 */
export function markLocalFallbackEntries(entries: ParsedEntry[]): ParsedEntry[] {
  return entries.map((entry) =>
    entry.extractSource === "local" ? { ...entry, extractSource: "local_fallback" } : entry,
  );
}

/** 是否包含百炼失败降级产出的本地条目（guides 结算 partial / F5 errors 提示的判据） */
export function hasLocalFallbackEntries(entries: readonly ParsedEntry[]): boolean {
  return entries.some((entry) => entry.extractSource === "local_fallback");
}
