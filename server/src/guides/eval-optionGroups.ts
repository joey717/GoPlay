/**
 * Task #269：optionGroups 解除降级后的百炼输出质量评测（一次性评测脚本，不改功能代码）。
 * Task #270：「内容感知解锁」落地后，本脚本改为复核生产链路——信号判定是否命中、
 * 生产 prompt 是否已注入完整第七节、解析后 snippet 去重是否生效；--replay 可离线重跑。
 *
 * 背景：Task #216 P1-C 起，guide planner 的第七节 optionGroups 契约在
 * 「素材提及 < 5」或「scope = attraction」时被替换成一行「本轮不适用」短声明。
 * 西岛这类「单景区 + 交通方式对比」素材恰好同时命中两个降级条件，于是
 * 「步行 / 电动车 / 观光车 / 三轮车」这种天然可成组的对比信息永远进不了
 * optionGroups。本脚本要回答的问题：解除降级后，百炼到底能不能稳定产出
 * ≥2 选项的有效组，还是会吐出一堆单选 / 空洞的垃圾组。
 *
 * 做法（评测最小面）：
 * 1. 读真实行程 48275e19-c7cb-417b-8ef7-57b04e097cf4，定位「西岛」visit；
 * 2. 用行程内已落的「西岛上交通方式」笔记证据（ev_note_6）作为唯一素材，
 *    构造与生产同构的 GuideMergeResult（提及 → visit / stop 对齐）；
 * 3. 先用 buildGuidePlannerPrompt 生成「现状（降级）」prompt，再把其中
 *    「七、optionGroups：本轮不适用…」整行替换为真实第七节全文——第七节文本
 *    不复制粘贴，直接从 planner.ts 源码里抓取，保证与生产逐字一致、
 *    未来改了规则本脚本自动跟随；
 * 4. 调用百炼（复用 bailian client）拿 finalText，用 parsePlannerOutput
 *    走生产同一条解析链路，产出 optionGroups 质量报告。
 *
 * 用法：
 *   npx tsx server/src/guides/eval-optionGroups.ts            # 发一次百炼（默认，约 40~70 秒）
 *   npx tsx server/src/guides/eval-optionGroups.ts --dry-run   # 只构造 prompt 并打印参数，不触网
 *   npx tsx server/src/guides/eval-optionGroups.ts --both      # 额外再发一次降级 prompt 做对照（双倍耗时）
 *   npx tsx server/src/guides/eval-optionGroups.ts --timeout=600000
 *   npx tsx server/src/guides/eval-optionGroups.ts --replay=/tmp/goplay-eval-optiongroups-response.txt
 *                                                             # 离线回放已保存的响应，重跑解析与评估
 *
 * 每次真实调用都会把 finalText 写到 /tmp/goplay-eval-optiongroups-response.txt，
 * 便于用 --replay 反复核对解析结论而不重复烧钱。
 *
 * 边界：只读行程 JSON 与 planner 源码，不写 Trip、不落草案、不改任何功能代码。
 */

import "../env.js";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DraftScope, Trip } from "@goplay/shared";
import { getMissingBailianVars } from "../env.js";
import { createBailianSession } from "../bailian/client.js";
import { lastBalancedJsonValue } from "../ai/lastJson.js";
import { normalizeOperationSet } from "../ai/pipeline.js";
import type { GuideMergeResult, MergedMention, MergedPlace } from "./merge.js";
import { buildGuidePlannerPrompt, parsePlannerOutput } from "./planner.js";
import {
  collectMergeSourceTexts,
  detectMergeOptionGroupSignals,
  dropSnippetsDuplicatedByOptionGroups,
} from "./optionSignals.js";

// ===== 参数 =====

const DEFAULT_TRIP_ID = "48275e19-c7cb-417b-8ef7-57b04e097cf4";
/** 与 GUIDE_DRAFT_TIMEOUT_MS 同量级（planner 单轮实测常 100s+） */
const DEFAULT_TIMEOUT_MS = 300_000;

interface EvalOptions {
  tripId: string;
  dryRun: boolean;
  both: boolean;
  timeoutMs: number;
  /** 离线回放：读取已保存的 finalText 文件，重跑解析与质量评估（不再触网） */
  replay: string | null;
}

function parseArgs(argv: readonly string[]): EvalOptions {
  let tripId = DEFAULT_TRIP_ID;
  let dryRun = false;
  let both = false;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let replay: string | null = null;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--both") both = true;
    else if (arg.startsWith("--trip=")) tripId = arg.slice("--trip=".length).trim();
    else if (arg.startsWith("--replay=")) replay = arg.slice("--replay=".length).trim();
    else if (arg.startsWith("--timeout=")) {
      const parsed = Number.parseInt(arg.slice("--timeout=".length), 10);
      if (Number.isFinite(parsed) && parsed > 0) timeoutMs = parsed;
    }
  }
  return { tripId, dryRun, both, timeoutMs, replay };
}

// ===== 素材：西岛交通攻略原文 =====

/** 用户提供的西岛交通攻略原文（评测素材基线，按行切成提及） */
const TRANSPORT_NOTE_TEXT = `西岛上交通方式
步行：西岛不大，核心打卡点集中在码头左侧的海岸线和渔村，步行即可轻松覆盖，适合不想花钱代步的人。
租电动车：约 25-40 元/天，适合想在渔村小巷深度逛、追求自由的人。注意：必须佩戴头盔，规范停车，否则会被交警罚款 50 元；且电动车无法直达牛王岭，只能停在 1 公里外再徒步。
观光车/三轮车：去牛王岭或乌龟滩建议坐观光车（约 25-35 元/人），省力且不晒；也可以坐岛上村民的电动三轮车（约 5-10 元/人），能直接送到牛王岭脚下。`;

// ===== 行程加载 =====

const SERVER_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function loadTrip(tripId: string): Trip {
  const path = join(SERVER_DIR, "data", `${tripId}.json`);
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as Trip;
}

/** 西岛 visit：名称含「西岛」且内部玩法最多的那个（三亚西岛 是空壳重复项） */
function findXidaoVisit(trip: Trip): { visitId: string; name: string; stopCount: number } {
  let best: { visitId: string; name: string; stopCount: number } | null = null;
  for (const visit of Object.values(trip.visits ?? {})) {
    const item = trip.itemRegistry?.[visit.pointRef];
    const name = typeof item?.name === "string" ? item.name : "";
    if (!name.includes("西岛")) continue;
    const stopCount = Array.isArray(visit.childStopRefs) ? visit.childStopRefs.length : 0;
    if (best === null || stopCount > best.stopCount) {
      best = { visitId: visit.visitId, name, stopCount };
    }
  }
  if (best === null) throw new Error("行程内未找到「西岛」visit，无法构造评测素材");
  return best;
}

// ===== 提及 → 实体对齐（评测场景：全部提及属于西岛整体） =====

function refOf(evidenceId: string, mentionId: string): string {
  return `${evidenceId}:${mentionId}`;
}

function placeDisplayName(trip: Trip, entityRef: MergedPlace["entityRef"], fallback: string): string {
  if (entityRef === null) return fallback;
  if (entityRef.kind === "visit") {
    const visit = trip.visits?.[entityRef.id];
    const item = visit !== undefined ? trip.itemRegistry?.[visit.pointRef] : undefined;
    return typeof item?.name === "string" ? item.name : fallback;
  }
  const stop = trip.stops?.[entityRef.id];
  const item = stop?.matchedPointRef !== undefined && stop?.matchedPointRef !== null
    ? trip.itemRegistry?.[stop.matchedPointRef]
    : undefined;
  return typeof item?.name === "string" ? item.name : (stop?.customName ?? fallback);
}

/**
 * 评测素材的提及切分：按用户原文的四个信息点切开（标题行 + 三种代步方式各自一行）。
 *
 * 为什么不用行程内同文本证据（ev_note_6）：那次抽取把内容切成了
 * 「西岛 / 渔村 / 牛王岭 / 乌龟滩」四条地点提及，电动车与三轮车的价格细节
 * 根本没进 quoteText——素材缺原料，评测就测不出 optionGroups 的真实能力。
 * 这里按原文行重切，四条提及（< 5，命中降级阈值）且保留全部价格 / 注意事项。
 */
const TRANSPORT_MENTIONS: { mentionId: string; extractedName: string; quoteText: string; claimKind: string }[] = [
  {
    mentionId: "m1",
    extractedName: "西岛",
    quoteText: "西岛上交通方式",
    claimKind: "route_listing",
  },
  {
    mentionId: "m2",
    extractedName: "西岛",
    quoteText: "步行：西岛不大，核心打卡点集中在码头左侧的海岸线和渔村，步行即可轻松覆盖，适合不想花钱代步的人。",
    claimKind: "tip",
  },
  {
    mentionId: "m3",
    extractedName: "西岛",
    quoteText:
      "租电动车：约 25-40 元/天，适合想在渔村小巷深度逛、追求自由的人。注意：必须佩戴头盔，规范停车，否则会被交警罚款 50 元；且电动车无法直达牛王岭，只能停在 1 公里外再徒步。",
    claimKind: "tip",
  },
  {
    mentionId: "m4",
    extractedName: "西岛",
    quoteText:
      "观光车/三轮车：去牛王岭或乌龟滩建议坐观光车（约 25-35 元/人），省力且不晒；也可以坐岛上村民的电动三轮车（约 5-10 元/人），能直接送到牛王岭脚下。",
    claimKind: "comparison",
  },
];

/** 评测证据 id（合成，不与行程内真实证据冲突） */
const EVAL_EVIDENCE_ID = "eval_transport";

/**
 * 构造与生产同构的 GuideMergeResult：四条交通提及全部对齐西岛 visit，
 * 合成单个地点——这正是 attraction scope 下「素材聚焦单实体」的真实形态。
 */
function buildEvalMerge(trip: Trip, xidaoVisitId: string): GuideMergeResult {
  const entityRef: MergedPlace["entityRef"] = { kind: "visit", id: xidaoVisitId };
  const place: MergedPlace = {
    key: `visit:${xidaoVisitId}`,
    displayName: placeDisplayName(trip, entityRef, "西岛"),
    entityRef,
    providerId: null,
    mentions: [],
  };
  for (const spec of TRANSPORT_MENTIONS) {
    place.mentions.push({
      ref: refOf(EVAL_EVIDENCE_ID, spec.mentionId),
      sourceId: "eval-transport",
      evidenceId: EVAL_EVIDENCE_ID,
      mentionId: spec.mentionId,
      mention: {
        mentionId: spec.mentionId,
        extractedName: spec.extractedName,
        quoteText: spec.quoteText,
        claimKind: spec.claimKind,
        targetScope: "attraction",
      } as unknown as MergedMention["mention"],
    });
  }
  return {
    sourceSnapshots: [{ sourceId: "eval-transport", sourceVersion: 1 }],
    mentions: placesToMentions(place),
    places: [place],
    mentionIds: place.mentions.map((entry) => entry.mentionId),
    mentionRefs: place.mentions.map((entry) => entry.ref),
  };
}

/** 单地点展开为提及数组（保持顺序，便于 prompt 与引用集合共用） */
function placesToMentions(place: MergedPlace): MergedMention[] {
  return [...place.mentions];
}

// ===== 第七节正文：直接从 planner.ts 源码取，避免与生产漂移 =====

interface OptionGroupsSections {
  full: string;
  skipped: string;
}

function readOptionGroupsSections(): OptionGroupsSections {
  const plannerPath = join(SERVER_DIR, "src", "guides", "planner.ts");
  const source = readFileSync(plannerPath, "utf8");
  const full = /const GUIDE_PLANNER_OPTION_GROUPS_RULES = `([\s\S]*?)`;/.exec(source)?.[1];
  const skipped = /const GUIDE_PLANNER_OPTION_GROUPS_SKIPPED_NOTE = `([\s\S]*?)`;/.exec(source)?.[1];
  if (full === undefined || skipped === undefined) {
    throw new Error("未能从 planner.ts 提取第七节文本（常量名或模板字符串形态已变更）");
  }
  return { full, skipped };
}

// ===== 质量评估 =====

/** 粗略 token 估算：中文按 1 字符 ≈ 0.6 token（Qwen 系 tokenizer 的经验值） */
function estimateTokens(chars: number): number {
  return Math.round(chars * 0.6);
}

interface RawGroupAnalysis {
  index: number;
  topic: string | null;
  category: string | null;
  optionCount: number;
  targetRefKind: string | null;
  groupRefs: number;
  invalidRefs: number;
  emptyFieldOptions: number;
  errors: string[];
}

interface QualityReport {
  rawGroupCount: number;
  parsedGroupCount: number;
  droppedGroups: RawGroupAnalysis[];
  keptGroups: RawGroupAnalysis[];
  transportCovered: boolean;
  expectedLabels: { label: string; hit: boolean }[];
  priceChecks: { label: string; expected: string; hit: boolean }[];
  hallucinatedRefs: string[];
  /** snippets 与 optionGroups 内容重复（同一信息两处展示，规则第七节明确禁止） */
  snippetDupes: string[];
  suspicion: string[];
}

const EXPECTED_LABELS = ["步行", "电动车", "观光车", "三轮车"];
const PRICE_CHECKS: { label: string; expected: string }[] = [
  { label: "电动车", expected: "25-40" },
  { label: "观光车", expected: "25-35" },
  { label: "三轮车", expected: "5-10" },
];

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readRawJson(finalText: string): Record<string, unknown> | null {
  const trimmed = finalText.trim();
  const candidates: string[] = [];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced !== undefined) candidates.push(fenced.trim());
  candidates.push(trimmed);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  // 回显场景：finalText = 完整 prompt 回显 + 模型真实输出。prompt 的规则示例里
  // 也带 {…}，上面「首 { → 末 }」的截取会从示例开始，切出非法 JSON；这里补两个
  // 尾部定位候选——平衡块扫描结果 + 末尾 {"operations" 截取，保证原始组统计不失真。
  const balanced = lastBalancedJsonValue(trimmed);
  if (balanced !== null) candidates.push(balanced);
  const tail = extractTailOperationsJson(trimmed);
  if (tail !== null) candidates.push(tail);
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 下一个候选
    }
  }
  return null;
}

function analyzeGroups(
  rawRecord: Record<string, unknown> | null,
  parsed: ReturnType<typeof parsePlannerOutput>,
  validRefs: ReadonlySet<string>,
): QualityReport {
  const rawGroups = asArray(rawRecord?.optionGroups);
  const rawAnalyses: RawGroupAnalysis[] = [];
  const hallucinatedRefs: string[] = [];

  rawGroups.forEach((entry, index) => {
    const errors: string[] = [];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      rawAnalyses.push({
        index,
        topic: null,
        category: null,
        optionCount: 0,
        targetRefKind: null,
        groupRefs: 0,
        invalidRefs: 0,
        emptyFieldOptions: 0,
        errors: ["组不是对象"],
      });
      return;
    }
    const record = entry as Record<string, unknown>;
    const topic = typeof record.topic === "string" && record.topic.trim() !== "" ? record.topic.trim() : null;
    if (topic === null) errors.push("topic 为空");
    const category = typeof record.category === "string" ? record.category : null;
    const targetRef = record.targetRef as Record<string, unknown> | undefined;
    const targetRefKind = typeof targetRef?.kind === "string" ? targetRef.kind : null;
    if (targetRefKind === null || !["visit", "stop", "point"].includes(targetRefKind)) {
      errors.push("targetRef 形状非法/缺失（整组会被丢弃）");
    }
    const groupRefs = asArray(record.sourceMentionRefs).filter((item): item is string => typeof item === "string");
    let invalidRefs = 0;
    for (const ref of groupRefs) {
      if (!validRefs.has(ref)) {
        invalidRefs += 1;
        hallucinatedRefs.push(ref);
      }
    }
    if (groupRefs.length === 0) errors.push("组级引用为空");
    const options = asArray(record.options);
    let emptyFieldOptions = 0;
    for (const rawOption of options) {
      if (typeof rawOption !== "object" || rawOption === null) continue;
      const option = rawOption as Record<string, unknown>;
      const label = typeof option.label === "string" ? option.label.trim() : "";
      const fills = ["priceText", "routeText", "sceneText", "noteText"].filter(
        (key) => typeof option[key] === "string" && (option[key] as string).trim() !== "",
      );
      if (label === "" || fills.length === 0) emptyFieldOptions += 1;
      const optionRefs = asArray(option.sourceMentionRefs).filter((item): item is string => typeof item === "string");
      for (const ref of optionRefs) {
        if (!validRefs.has(ref)) hallucinatedRefs.push(ref);
      }
    }
    if (options.length < 2) errors.push(`选项数 ${options.length} < 2（parseDraftOptionGroups 会丢弃）`);
    rawAnalyses.push({
      index,
      topic,
      category,
      optionCount: options.length,
      targetRefKind,
      groupRefs: groupRefs.length,
      invalidRefs,
      emptyFieldOptions,
      errors,
    });
  });

  const keptCount = parsed?.optionGroups.length ?? 0;
  const droppedGroups = rawAnalyses.filter((item) => item.errors.length > 0);
  const keptGroups = rawAnalyses.filter((item) => item.errors.length === 0);

  const allLabels = (parsed?.optionGroups ?? []).flatMap((group) => group.options.map((option) => option.label));
  const joinedLabels = allLabels.join("|");
  const transportCovered = (parsed?.optionGroups ?? []).some(
    (group) => group.category === "transport" && group.options.length >= 2,
  );
  const expectedLabels = EXPECTED_LABELS.map((label) => ({ label, hit: joinedLabels.includes(label) }));
  const priceChecks = PRICE_CHECKS.map(({ label, expected }) => {
    const option = (parsed?.optionGroups ?? [])
      .flatMap((group) => group.options)
      .find((candidate) => candidate.label.includes(label));
    const priceText = option?.priceText ?? "";
    const normalized = priceText.replace(/\s+/g, "");
    const expectedVariants = [expected, expected.replace("-", "~"), expected.replace("-", "—")];
    return { label, expected, hit: expectedVariants.some((variant) => normalized.includes(variant)) };
  });

  // snippets 与 optionGroups 重复：规则第七节禁止把已成组的内容再写进 snippets，
  // 违反会让用户在同一景区卡上看到两遍同一信息
  const optionLabels = (parsed?.optionGroups ?? []).flatMap((group) => group.options.map((option) => option.label));
  const optionPrices = (parsed?.optionGroups ?? [])
    .flatMap((group) => group.options.map((option) => option.priceText ?? ""))
    .map((price) => price.replace(/\s+/g, ""))
    .filter((price) => price !== "");
  const snippetDupes = (parsed?.snippets ?? [])
    .map((snippet) => snippet.text.replace(/\s+/g, ""))
    .filter(
      (text) =>
        optionLabels.some((label) => label !== "" && text.includes(label)) ||
        optionPrices.some((price) => text.includes(price)),
    );

  const suspicion: string[] = [];
  if (keptCount === 0) suspicion.push("解析后 0 组：解除降级后仍无可用 optionGroups");
  if (rawAnalyses.length > 0 && keptCount === 0) suspicion.push("原始有组但全部被清洗丢弃，需检查 targetRef / 选项数 / 引用");
  if (rawAnalyses.some((item) => item.optionCount === 1)) suspicion.push("存在单选组（应写 snippets 却写成 optionGroups）");
  if (rawAnalyses.some((item) => item.topic !== null && item.topic.length <= 2)) suspicion.push("存在过短 topic（信息量可疑）");
  if (hallucinatedRefs.length > 0) suspicion.push(`存在 ${hallucinatedRefs.length} 条编造/越界引用`);
  if (snippetDupes.length > 0) {
    suspicion.push(`${snippetDupes.length} 条 snippet 与 optionGroups 内容重复（同一信息两处展示，违反第七节禁令）`);
  }
  if (transportCovered && expectedLabels.filter((item) => item.hit).length < 3) {
    suspicion.push("有 transport 组但选项标签覆盖不全，可能漏掉原文方式");
  }

  return {
    rawGroupCount: rawGroups.length,
    parsedGroupCount: keptCount,
    droppedGroups,
    keptGroups,
    transportCovered,
    expectedLabels,
    priceChecks,
    hallucinatedRefs: [...new Set(hallucinatedRefs)],
    snippetDupes,
    suspicion,
  };
}

/**
 * 评测专用兜底：从响应里最后一个 `{"operations"` 起截出平衡 JSON 块。
 *
 * 生产侧不能这么做（模型输出不可信，必须走 normalizeOperationSet 全链路），
 * 评测侧只是要拿到「模型到底输出了什么 optionGroups」——回显 + 英文推理文本里
 * 的 `[stop]` 之类片段会让 lastBalancedJsonValue 误判，从而把可用的尾部 JSON 一起丢掉。
 */
function extractTailOperationsJson(text: string): string | null {
  const tailIndex = text.lastIndexOf('{"operations"');
  if (tailIndex < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = tailIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(tailIndex, i + 1);
    }
  }
  return null;
}

// ===== 报告输出 =====

function line(char = "─", length = 78): string {
  return char.repeat(length);
}

/**
 * 解析失败诊断：定位「回显 + 真实输出」拼接时各候选为何没救回来。
 * 生产侧同样会遇到该形态（lastJson.ts 注释记录过 SSE 回显），因此这里只读不修，
 * 把证据打全，避免把「解析失败」误判成「模型没输出 optionGroups」。
 */
function diagnoseParseFailure(finalText: string): void {
  const trimmed = finalText.trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  console.log(`  诊断：响应 ${trimmed.length} 字符，首个 { 在 ${firstBrace}，末个 } 在 ${lastBrace}`);
  console.log(`       回显判定：是否以系统规则开头 = ${trimmed.startsWith("【系统规则】")}`);
  const balanced = lastBalancedJsonValue(trimmed);
  console.log(`       lastBalancedJsonValue：${balanced === null ? "null" : `${balanced.length} 字符`}`);
  const tailIndex = trimmed.lastIndexOf('{"operations"');
  console.log(`       末尾 {"operations" 出现位置：${tailIndex}`);
  if (tailIndex >= 0) {
    const tail = trimmed.slice(tailIndex);
    try {
      JSON.parse(tail);
      console.log("       从该位置截到结尾是合法 JSON（解析器本应命中，需检查候选链顺序）");
    } catch (error) {
      console.log(`       从该位置截到结尾不是合法 JSON：${(error as Error).message.slice(0, 120)}`);
    }
  }
  if (balanced !== null) {
    try {
      const record = JSON.parse(balanced) as Record<string, unknown>;
      const keys = Object.keys(record).join(",");
      console.log(`       lastBalanced 解析成功，键=[${keys}]，normalizeOperationSet=${normalizeOperationSet(record) === null ? "null（结构不合契约）" : "ok"}`);
    } catch (error) {
      console.log(`       lastBalanced 解析失败：${(error as Error).message.slice(0, 120)}`);
    }
  }
}

function printPromptStats(label: string, prompt: string, baseChars: number): void {
  console.log(
    `  ${label}：${prompt.length} 字符（估算 ${estimateTokens(prompt.length)} token）` +
      (baseChars > 0 ? `，相对降级版 ${prompt.length - baseChars >= 0 ? "+" : ""}${prompt.length - baseChars} 字符` : ""),
  );
}

function printQualityReport(report: QualityReport): void {
  console.log(`\n${line()}\n【解析后的 optionGroups（生产 parsePlannerOutput 结果）】`);
  console.log(
    `  原始组数 ${report.rawGroupCount} → 保留 ${report.parsedGroupCount}，` +
      `被清洗丢弃 ${Math.max(0, report.rawGroupCount - report.parsedGroupCount)}`,
  );
  if (report.rawGroupCount === 0 && report.parsedGroupCount > 0) {
    console.log("  （注：原始响应中未能定位到 JSON 块，上方原始的组级明细不可用，以解析结果为准）");
  }
  console.log(
    `  期望方式标签覆盖：${report.expectedLabels.map((item) => `${item.label}${item.hit ? "✓" : "✗"}`).join(" ")}`,
  );
  console.log(
    `  价格核对：${report.priceChecks
      .map((item) => `${item.label}(${item.expected})${item.hit ? "✓" : "✗"}`)
      .join(" ")}`,
  );
  console.log(`  transport 类 ≥2 选项的组：${report.transportCovered ? "有" : "无"}`);

  if (report.droppedGroups.length > 0) {
    console.log("\n  ⚠ 被清洗丢弃的组：");
    for (const group of report.droppedGroups) {
      console.log(
        `    #${group.index} 「${group.topic ?? "(空 topic)"}」/${group.category ?? "?"} ` +
          `选项 ${group.optionCount}：${group.errors.join("；")}`,
      );
    }
  }

  console.log("\n  ✅ 保留的组：");
  if (report.keptGroups.length === 0) console.log("    （无）");
  for (const group of report.keptGroups) {
    console.log(
      `    #${group.index} 「${group.topic ?? ""}」/${group.category ?? "?"} ` +
        `选项 ${group.optionCount}，组级引用 ${group.groupRefs}（非法 ${group.invalidRefs}），` +
        `空洞选项 ${group.emptyFieldOptions}`,
    );
  }

  if (report.hallucinatedRefs.length > 0) {
    console.log(`\n  ⚠ 非法/编造引用：${report.hallucinatedRefs.join(", ")}`);
  }

  if (report.snippetDupes.length > 0) {
    console.log("\n  ⚠ 与 optionGroups 重复的 snippet：");
    for (const text of report.snippetDupes) console.log(`    - ${text}`);
  }

  console.log("\n  质量结论：");
  if (report.suspicion.length === 0) {
    console.log("    未发现垃圾组迹象；建议人工再核对价格与场景描述是否忠于原文。");
  } else {
    for (const item of report.suspicion) console.log(`    - ${item}`);
  }
}

// ===== 主流程 =====

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  console.log("=== Task #269 optionGroups 解除降级评测 ===");
  console.log(`行程：${options.tripId}`);

  const trip = loadTrip(options.tripId);
  const xidao = findXidaoVisit(trip);
  console.log(`目标景区：${xidao.name}（visit=${xidao.visitId}，内部玩法 ${xidao.stopCount} 个）`);

  console.log(
    `素材来源：用户原文按信息点切成 ${TRANSPORT_MENTIONS.length} 条提及（合成证据 ${EVAL_EVIDENCE_ID}，` +
      `行程内 ev_note_6 是同一段文本的抽取结果但漏掉了电动车 / 三轮车价格，仅作对照说明）`,
  );

  const merge = buildEvalMerge(trip, xidao.visitId);
  console.log("\n素材对齐：");
  for (const place of merge.places) {
    const aligned = place.entityRef !== null ? `对齐 ${place.entityRef.kind}=${place.entityRef.id}` : "未对齐行程实体";
    console.log(`  ▸ ${place.displayName}（${aligned}）${place.mentions.length} 条`);
  }

  // 评测目标 scope 固定为 attraction：这正是降级条件之一
  const scope: DraftScope = { kind: "attraction", visitId: xidao.visitId };
  const sections = readOptionGroupsSections();

  const degradedPrompt = buildGuidePlannerPrompt(trip, merge, scope);
  // Task #270 内容感知解锁已落地——素材含可比较选项信号时，生产 prompt 本身就是
  // 完整第七节（不再是降级短声明），评测不再需要手工替换；Task #273 起信号判定按
  // 来源聚合并优先用 sourceText（本脚本的合成来源没有 sourceText → 只用提及兜底）
  const signals = detectMergeOptionGroupSignals(merge, {
    sourceTexts: collectMergeSourceTexts(trip, merge),
  });
  const alreadyUnlocked = !degradedPrompt.includes(sections.skipped);
  const fullPrompt = alreadyUnlocked ? degradedPrompt : degradedPrompt.replace(sections.skipped, sections.full);

  const sectionDelta = sections.full.length - sections.skipped.length;
  console.log(`\n${line()}\n【Prompt 关键参数】`);
  console.log(`  scope：attraction（${xidao.name}）`);
  console.log(`  mentionCount：${merge.mentions.length}（生产阈值 OPTION_GROUPS_MIN_MENTIONS = 5）`);
  console.log(
    `  optionGroups 内容信号：${signals.hit ? "命中" : "未命中"}` +
      (signals.hit ? `（${signals.reasons.join("；")}）` : `（选项词 ${signals.optionTerms.length} 个，价格 ${signals.priceCount} 处）`),
  );
  console.log(
    alreadyUnlocked
      ? "  第七节：生产 prompt 已注入完整契约（Task #270 内容感知解锁），无需替换"
      : `  第七节：降级短声明 ${sections.skipped.length} 字符 ↔ 完整契约 ${sections.full.length} 字符（+${sectionDelta} 字符）`,
  );
  printPromptStats("生产 prompt", degradedPrompt, 0);
  if (!alreadyUnlocked) {
    printPromptStats("解除降级 prompt", fullPrompt, degradedPrompt.length);
    console.log(`  估算新增 token：约 ${estimateTokens(fullPrompt.length) - estimateTokens(degradedPrompt.length)}`);
  }

  const promptOut = join(tmpdir(), "goplay-eval-optiongroups-prompt-full.txt");
  writeFileSync(promptOut, fullPrompt, "utf8");
  console.log(`  完整 prompt 已写出：${promptOut}`);

  if (options.dryRun) {
    console.log("\n--dry-run：跳过百炼调用。");
    return;
  }

  const responseOut = join(tmpdir(), "goplay-eval-optiongroups-response.txt");
  const degradedResponseOut = join(tmpdir(), "goplay-eval-optiongroups-response-degraded.txt");
  let finalText: string;
  if (options.replay !== null) {
    finalText = readFileSync(options.replay, "utf8");
    console.log(`\n${line()}\n【离线回放】读取 ${options.replay}（${finalText.length} 字符），不触网`);
  } else {
    const missing = getMissingBailianVars();
    if (missing.length > 0) {
      console.error(`\n百炼凭证缺失：${missing.join(", ")}（请在仓库根目录 .env 配置后重跑）`);
      process.exitCode = 1;
      return;
    }

    const ask = async (prompt: string, tag: string): Promise<string> => {
      console.log(`\n${line()}\n【${tag}】发送百炼（timeout=${Math.round(options.timeoutMs / 1000)}s）…`);
      const startedAt = Date.now();
      const result = await createBailianSession(prompt, {
        timeoutMs: options.timeoutMs,
        title: `Task#269 optionGroups 评测·${tag}`,
      });
      console.log(
        `  返回：${result.finalText.length} 字符，耗时 ${result.latencyMs}ms（真实等待 ${Date.now() - startedAt}ms），` +
          `tool call ${result.toolCalls.length} 次`,
      );
      return result.finalText;
    };

    // 对照：降级 prompt（预期 optionGroups 恒空），按需执行
    if (options.both) {
      const degradedText = await ask(degradedPrompt, "降级 prompt（对照组）");
      writeFileSync(degradedResponseOut, degradedText, "utf8");
      const degradedParsed = parsePlannerOutput(degradedText, new Set(merge.mentionRefs));
      console.log(
        `  对照结果：operations=${degradedParsed?.operations.length ?? "解析失败"}，` +
          `snippets=${degradedParsed?.snippets.length ?? "-"}，optionGroups=${degradedParsed?.optionGroups.length ?? "-"}`,
      );
      console.log(`  对照组原始响应已写出：${degradedResponseOut}`);
    }

    finalText = await ask(fullPrompt, "解除降级 prompt");
    writeFileSync(responseOut, finalText, "utf8");
    console.log(`  原始响应已写出：${responseOut}（可用 --replay=${responseOut} 离线重跑分析）`);
  }

  console.log(`\n${line()}\n【百炼原始返回】\n${finalText}`);

  const validRefs = new Set(merge.mentionRefs);
  let parsed = parsePlannerOutput(finalText, validRefs);
  let analyzedText = finalText;
  let parseMode = "生产链路直接解析";
  console.log(`\n${line()}\n【生产解析结果】`);
  if (parsed === null) {
    console.log("  parsePlannerOutput 返回 null：整条响应不可解析（生产会触发 planner 重试一次）。");
    diagnoseParseFailure(finalText);
    const tail = extractTailOperationsJson(finalText);
    if (tail !== null) {
      parsed = parsePlannerOutput(tail, validRefs);
      analyzedText = tail;
      parseMode = "评测兜底：尾部 JSON 截取后解析";
      console.log(`  评测兜底：从末尾 {\"operations\"} 截出 ${tail.length} 字符后${parsed === null ? "仍解析失败" : "解析成功"}`);
    }
    if (parsed === null) return;
  }
  console.log(`  解析模式：${parseMode}`);
  console.log(`  operations：${parsed.operations.length} 条`);
  console.log(`  snippets：${parsed.snippets.length} 条`);
  console.log(`  optionGroups：${parsed.optionGroups.length} 组`);
  if (parsed.optionGroups.length > 0) {
    console.log(`\n${JSON.stringify(parsed.optionGroups, null, 2)}`);
  }
  if (parsed.snippets.length > 0) {
    console.log("\n  snippets 摘要：");
    for (const snippet of parsed.snippets) {
      const target = snippet.targetRef as { kind: string; id?: string; dayIndex?: number };
      const targetLabel = target.id ?? (target.dayIndex !== undefined ? `day_${target.dayIndex}` : "?");
      console.log(`    · [${snippet.claimKind}] ${snippet.text} → ${target.kind}=${targetLabel}`);
    }
  }

  // Task #270：与生产链路同一条去重规则（parse 之后、落草案之前）
  const dedupe = dropSnippetsDuplicatedByOptionGroups(parsed.snippets, parsed.optionGroups);
  if (dedupe.dropped.length > 0) {
    parsed = { ...parsed, snippets: dedupe.snippets };
    console.log(`\n  [Task #270 去重] 删除 ${dedupe.dropped.length} 条与选项组重复的提示：`);
    for (const entry of dedupe.dropped) console.log(`    - 「${entry.text}」（${entry.topic}：${entry.reason}）`);
    console.log(`  去重后 snippets：${parsed.snippets.length} 条（optionGroups 保留 ${parsed.optionGroups.length} 组）`);
  } else if (parsed.optionGroups.length > 0 && parsed.snippets.length > 0) {
    console.log("\n  [Task #270 去重] 未发现与选项组重复的提示（snippets 与 optionGroups 内容不重合）");
  }

  const report = analyzeGroups(readRawJson(analyzedText), parsed, validRefs);
  printQualityReport(report);

  console.log(`\n${line()}\n【风险提示】`);
  console.log(
    `  1. prompt 增量：+${sectionDelta} 字符（约 +${estimateTokens(sectionDelta)} token），` +
      `占本次 prompt 的 ${((sectionDelta / fullPrompt.length) * 100).toFixed(1)}%，单轮超时预算的压力可忽略。`,
  );
  console.log(
    `  2. 本轮只有 ${merge.mentions.length} 条提及（低于阈值 5）：这正是降级条件想规避的「原料不足」场景，` +
      `结果好坏直接决定阈值能否下调。`,
  );
  console.log(
    "  3. Task #270 已按本轮结论落地「内容感知解锁」：降级门槛保留，素材命中可比较选项信号时才注入完整第七节。",
  );
  console.log(
    "  4. 评测脚本不改功能代码；本脚本现与生产同链路（信号判定 + snippet 去重），--replay 可离线复核解析与去重结论。",
  );
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n评测失败：${message}`);
  process.exitCode = 1;
});
