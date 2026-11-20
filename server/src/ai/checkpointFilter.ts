/**
 * Task #196 自定义打卡点过滤（确定性规则，服务端兜底校验——不信任模型输出）。
 *
 * 只作用于「FlyAI 未命中且无既有同名 Item（即将新建 custom 点位）」的抽取条目：
 * 命中飞猪 POI 或复用既有 Item 的真实点位不经过本过滤（不误删真实 POI / 父子景点）。
 *
 * 三层判定（保守、可测试）：
 * 1. 名称完全由泛化成分（场景 / 方位 / 动作 / 修饰词）构成 → 拒绝
 *    （普通沙滩、小吃街、路过椰林、海边公路、随手拍处、入口旁、码头左侧…）；
 * 2. 名称完全由锚点成分（墙 / 门 / 树 / 灯塔 / 观景台 / 装置…含组合词，如
 *    「木门歪椰树」）构成 → 要求至少一个锚点成分在原文 quote 中可定位，
 *    定位不到视为模型为泛化描述编造专名 → 拒绝；
 * 3. 名称含词典外片段（具体专名主体，如「西岛」「珊瑚」）→ 每个片段（≥2 字）
 *    须在 quote 中可定位，定位不到视为编造 → 拒绝；全部可定位 → 保留。
 *    定位采用多档判定（Task #321）：a) 逐字子串包含（快路）；b) 不命中时
 *    「去虚词包含」——从片段与 quote 归一化串中同时删除闭集虚词后再做子串
 *    包含，容忍「沙滩上彩色西岛的字母」vs「彩色西岛字母」这类差一个「的」
 *    的确定性误杀（Iris #320 定案）；c) 仍不命中时按 bigram 重叠相似度
 *    ≥ MIN_BIGRAM_OVERLAP 兜底（容忍原文中间多插一个实词字符）。
 *    三档均不命中才判编造；放宽是单调的（旧口径 keep 的条目新口径必 keep）。
 *
 * 名称归一化与 server normalizePoiName 同口径（去成对括号内容与空白 + 转小写）；
 * 本模块私有实现以避免与 assemble.ts 循环依赖（assemble 只导入判定函数）。
 */

/** 归一化（与 assemble.normalizePoiName 同口径 + 小写，判定在大小写不敏感层进行） */
function normalizeCheckpointName(name: string): string {
  return name
    .replace(/[（(【\[{][^）)】\]}]*[）)】\]}]/g, "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

/** 泛化场景（无专名的打卡场景，产品明示过滤对象） */
const GENERIC_SCENE_WORDS: readonly string[] = [
  "沙滩", "海滩", "海边", "海岸", "海景", "海风", "日落", "日出", "夕阳", "夜景",
  "小吃街", "美食街", "夜市街", "夜市", "椰林", "椰子林", "椰树林",
  "海边公路", "沿海公路", "环岛公路", "公路", "马路", "街道", "老街",
  "海边栈道", "海边小路", "停车场", "公交站", "码头", "路口", "桥洞", "天桥",
];

/** 纯方位参照（不构成独立点位） */
const GENERIC_POSITION_WORDS: readonly string[] = [
  "入口", "出口", "门口", "门前", "大门", "检票口", "售票处", "路边", "路旁",
  "转角", "尽头", "旁边", "左侧", "右侧", "左手边", "右手边", "对面", "附近",
  "途中", "沿途", "旁", "处", "边上",
];

/** 动作 / 指示词（描述行为而非地点） */
const GENERIC_ACTION_WORDS: readonly string[] = [
  "路过", "途经", "经过", "随手拍", "出片", "机位", "拍照", "打卡",
];

/** 修饰词（不构成专名主体） */
const GENERIC_MODIFIER_WORDS: readonly string[] = [
  "普通", "网红", "超美", "最美", "必去", "小众", "宝藏", "隐藏", "神秘", "免费",
  "大", "小", "老", "新", "野", "木",
];

/**
 * 打卡点锚点（可辨识的相对固定装置 / 构造物；组合词在前保证贪心最长匹配）：
 * 「西岛墙」「珊瑚墙」「木门歪椰树」回归样例中的墙 / 门 / 树由此承载。
 */
const CHECKPOINT_ANCHOR_WORDS: readonly string[] = [
  "歪椰树", "歪脖子树", "木门", "铁门", "玻璃栈道", "旋转木马", "老爷车",
  "摩天轮", "电话亭", "灯塔", "观景台", "秋千", "雕塑", "雕像", "牌坊",
  "石碑", "滑梯", "邮筒", "栈桥", "吊桥", "椰树", "索道", "缆车", "泳池",
  "温泉池", "鸟巢", "吊床", "网床", "邮轮", "沉船", "天梯", "装置",
  "涂鸦", "壁画", "栈道", "步道", "台阶", "楼梯", "亭", "塔", "门",
  "墙", "树", "桥",
];

const ANCHOR_SET: ReadonlySet<string> = new Set(CHECKPOINT_ANCHOR_WORDS);
const SEGMENT_WORDS: readonly string[] = [
  ...CHECKPOINT_ANCHOR_WORDS,
  ...GENERIC_SCENE_WORDS,
  ...GENERIC_POSITION_WORDS,
  ...GENERIC_ACTION_WORDS,
  ...GENERIC_MODIFIER_WORDS,
].sort((left, right) => right.length - left.length);

type CheckpointSegment =
  | { kind: "anchor"; word: string }
  | { kind: "generic"; word: string }
  | { kind: "raw"; word: string };

/** 贪心最长匹配切分：词典命中归 anchor / generic，剩余字符聚成 raw 段（专名候选） */
function segmentCheckpointName(nameNorm: string): CheckpointSegment[] {
  const segments: CheckpointSegment[] = [];
  let buffer = "";
  let position = 0;
  outer: while (position < nameNorm.length) {
    for (const word of SEGMENT_WORDS) {
      if (nameNorm.startsWith(word, position)) {
        if (buffer !== "") {
          segments.push({ kind: "raw", word: buffer });
          buffer = "";
        }
        segments.push({ kind: ANCHOR_SET.has(word) ? "anchor" : "generic", word });
        position += word.length;
        continue outer;
      }
    }
    buffer += nameNorm[position];
    position += 1;
  }
  if (buffer !== "") segments.push({ kind: "raw", word: buffer });
  return segments;
}

/**
 * 单字片段不做 quote 定位验证（信息量不足，如「木栈道」的「木」）；
 * ≥2 字片段不可定位即视为编造。
 */
const MIN_RAW_PROBE_LENGTH = 2;

/**
 * 虚词闭集（Task #321，禁止扩集——扩集即改变第 3 层判定口径，须同步单测）：
 * 模型定名常在专名主体中省略 / 夹带结构助词与方位助词，原文
 * 「沙滩上彩色西岛的字母」被定名为「彩色西岛字母」，逐字包含因多一个「的」
 * 确定性误杀（Iris #320 定案：live 重放模型能抽到该名字且 confidence=high）。
 *   的 / 之：结构助词；和 / 与：并列连词；
 *   里 / 中 / 上 / 下 / 内 / 外 / 旁 / 边：方位助词。
 * 只用于第 3 层定位兜底（name 与 quote 两侧同时删除后再比对），不参与切分、
 * 不参与第 1 层泛化判定，故「椰林沙滩」等泛化拒绝口径零变化。
 */
const CHECKPOINT_FUNCTION_CHARS: readonly string[] = [
  "的", "之", "和", "与", "里", "中", "上", "下", "内", "外", "旁", "边",
];

const FUNCTION_CHAR_SET: ReadonlySet<string> = new Set(CHECKPOINT_FUNCTION_CHARS);

/** 删除闭集虚词（逐码点过滤，非 BMP 字符不在闭集内故原样保留） */
function stripFunctionChars(text: string): string {
  let stripped = "";
  for (const char of text) {
    if (!FUNCTION_CHAR_SET.has(char)) stripped += char;
  }
  return stripped;
}

/**
 * bigram 重叠相似度阈值（第 3 层 c 档兜底，Task #321）：
 * 命中比例 = 「片段 bigram 中出现在 quote bigram 里的个数 / 片段 bigram 总数」，
 * ≥0.8 视为可定位。取 0.8 而非更低值：3 字片段（2 个 bigram）与 4~5 字片段
 * 实际要求全部命中（0.5 / 0.75 均 < 0.8），仅 ≥6 字片段容忍 1 个 bigram 缺失
 * （原文中间多插一个实词字符，如「彩色西岛的大字母」），编造专名（字面零痕迹）
 * 命中率恒为 0，不会因此被放行。
 */
const MIN_BIGRAM_OVERLAP = 0.8;

function toBigrams(text: string): Set<string> {
  const grams = new Set<string>();
  for (let index = 0; index + 1 < text.length; index += 1) {
    grams.add(text.slice(index, index + 2));
  }
  return grams;
}

/** 片段 bigram（去重集合）在 quote bigram 中的命中比例；片段不足 2 字时无 bigram，返回 0 */
function bigramOverlapRatio(word: string, quote: string): number {
  const wordGrams = toBigrams(word);
  if (wordGrams.size === 0) return 0;
  const quoteGrams = toBigrams(quote);
  let hits = 0;
  for (const gram of wordGrams) {
    if (quoteGrams.has(gram)) hits += 1;
  }
  return hits / wordGrams.size;
}

/**
 * 第 3 层「专名片段可在原文定位」三档判定（纯函数、确定性、无 IO）：
 *   a) 逐字子串包含（快路，原口径）；
 *   b) 去虚词包含——片段与 quote 归一化串同时删除闭集虚词后子串包含；
 *   c) bigram 重叠相似度 ≥ MIN_BIGRAM_OVERLAP（去虚词后仍差一个实词字符时兜底）。
 * b/c 档只在去虚词后片段仍 ≥ MIN_RAW_PROBE_LENGTH 时生效：虚词占满的片段
 * （如「海上」→「海」）信息量不足，按不可定位处理，避免放宽成「无痕迹也放行」。
 */
function isRawWordLocatable(word: string, quoteNorm: string, quoteStripped: string): boolean {
  if (quoteNorm.includes(word)) return true; // a 档
  const stem = stripFunctionChars(word);
  if (stem.length < MIN_RAW_PROBE_LENGTH) return false;
  if (quoteStripped.includes(stem)) return true; // b 档
  return bigramOverlapRatio(stem, quoteStripped) >= MIN_BIGRAM_OVERLAP; // c 档
}

/**
 * 判定一条「将新建 custom 点位」的抽取条目是否应被过滤（true = 跳过该条）。
 * 判定只依赖 name 与 quote 原文，确定性可测；quote 为空时仅层 1 生效，
 * 其余场景按「不可定位」处理（缺原文佐证的定名一律不建点位——禁止编造）。
 */
export function shouldRejectCustomCheckpoint(input: { name: string; quote: string }): boolean {
  const nameNorm = normalizeCheckpointName(input.name);
  if (nameNorm === "") return false;
  const quoteNorm = normalizeCheckpointName(typeof input.quote === "string" ? input.quote : "");
  const segments = segmentCheckpointName(nameNorm);

  const hasGeneric = segments.some((segment) => segment.kind === "generic");
  const hasAnchor = segments.some((segment) => segment.kind === "anchor");
  const rawWords = segments
    .filter((segment): segment is { kind: "raw"; word: string } => segment.kind === "raw")
    .map((segment) => segment.word);

  // 层 1：泛化成分 + 无专名主体 → 泛化场景 / 纯方位参照 / 动作指示，拒绝
  if (hasGeneric && rawWords.length === 0) return true;

  // 层 2：纯锚点复合（装置描述，如「木门歪椰树」）——至少一个锚点成分在原文中
  // 可定位；quote 无任何锚点字样 = 模型凭空给名，拒绝（禁止为泛化描述编造专名）
  if (!hasGeneric && rawWords.length === 0 && hasAnchor) {
    const located = segments.some(
      (segment) => segment.kind === "anchor" && quoteNorm.includes(segment.word),
    );
    if (!located) return true;
  }

  // 层 3：专名片段逐一在原文中验证（「西岛墙」的「西岛」、「珊瑚墙」的「珊瑚」）；
  // 三档定位（逐字包含 → 去虚词包含 → bigram 重叠）见 isRawWordLocatable（Task #321）
  if (rawWords.some((word) => word.length >= MIN_RAW_PROBE_LENGTH)) {
    const quoteStripped = stripFunctionChars(quoteNorm);
    for (const word of rawWords) {
      if (word.length >= MIN_RAW_PROBE_LENGTH && !isRawWordLocatable(word, quoteNorm, quoteStripped)) {
        return true;
      }
    }
  }
  return false;
}
