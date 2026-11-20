/**
 * Task #275：评测 fixture 注入器（EVAL_FIXTURE=1 时替换抽取层，慢层 L1 零等待）。
 *
 * 注入点（最小钩子，不改业务语义）：
 * - 主通道：`server/src/guides/service.ts` 的 GuideServiceDeps.extractEntries——
 *   攻略来源后台处理（processTextSource / processLinkSource）在「抽取结果 →
 *   assembleEntries 装配」边界统一经过该依赖，替换它即让全链路吃到 fixture
 *   claims，装配 / 去重 / mention 写入等业务逻辑保持原样执行；
 * - 可选通道：同文件 GuideServiceDeps.fetchNote——离线烟雾时桩掉小红书抓取，
 *   使 E3/E5/E6 类用例不触网（链接源文本仍走 extractEntries 注入）。
 *
 * 装配层 FlyAI 对齐不需要桩：fixture 实体名刻意选用验收行程既有 fliggy Item
 * 同名（如「蜈支洲岛」），assemble 的 findExistingFliggyItem 命中即跳过搜索；
 * 未命中时 alignWithFliggyCached 失败自动降级 custom（不阻塞、不触网伪造）。
 *
 * fixture 数据源：eval/assets/v{N}/（VERSION.json 校验 sha256，v1 = 2026-10-19 快照）。
 * claims → ParsedEntry 的映射是「产品口径 → 抽取契约」的确定性翻译：
 * - entity "西岛/木门与歪脖子椰子树" → name=子点位、parentAttraction=西岛（in_attraction）；
 * - stance → confidence：正向亲历=high、建议/条件/风险=medium、转述/待核=low；
 * - quote/summary 原样透传（A10 溯源断言直接消费）。
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ParsedEntry } from "../../server/src/ai/assemble.js";
import type { XhsNoteResult } from "../../server/src/ai/xhs.js";
import {
  resetGuideServiceDeps,
  setGuideServiceDeps,
} from "../../server/src/guides/service.js";

const EVAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS_ROOT = join(EVAL_ROOT, "assets");

// ===== fixture 资产模型（与 eval/assets/v1 JSON 契约对应） =====

export interface FixtureSource {
  id: string;
  noteId: string;
  url: string;
  title: string;
  author?: string;
  publishedAt?: string;
  coverage?: string;
  notes?: string;
}

export interface FixtureClaim {
  id: string;
  entity: string;
  source: string;
  locator: string | { imageIndex: number; section: string };
  quote: string;
  textKind?: string;
  stance: string;
  summary: string;
}

export interface FixtureAssets {
  sampleVersion: string;
  capturedDate: string;
  sources: FixtureSource[];
  claims: FixtureClaim[];
  westIslandPhotoRoute: {
    source: string;
    order: string[];
    walkPhotoMinutes: number;
    durationScope: string;
  };
  aggregationChecks: string[];
}

export interface AssetsVersionInfo {
  version: string;
  snapshotDate: string;
  contentHash: string;
  dir: string;
  /** fixture JSON 相对 dir 的文件名（VERSION.json files.fixture.path） */
  fixturePath: string;
}

// ===== 资产加载与完整性校验 =====

/** 选择最高版本资产目录（v1 < v2 < …，按数字序） */
export function latestAssetsVersion(): AssetsVersionInfo {
  const dirs = readdirSync(ASSETS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^v\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const latest = dirs[dirs.length - 1];
  if (latest === undefined) throw new Error(`[EVAL-FIXTURE] ${ASSETS_ROOT} 下没有 v{N} 资产目录`);
  const dir = join(ASSETS_ROOT, latest);
  const version = JSON.parse(readFileSync(join(dir, "VERSION.json"), "utf8")) as {
    version: string;
    snapshotDate: string;
    contentHash: string;
    files: Record<string, { path: string; sha256: string }>;
  };
  // 逐文件 sha256 完整性校验：改动资产＝用例文档升版本（v1.1 §6），哈希不符直接拒绝加载
  for (const [role, file] of Object.entries(version.files)) {
    const actual = createHash("sha256").update(readFileSync(join(dir, file.path))).digest("hex");
    if (actual !== file.sha256) {
      throw new Error(
        `[EVAL-FIXTURE] 资产完整性校验失败（${role}: ${file.path}）：期望 ${file.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…。` +
          "改动 eval/assets ＝ 用例文档升版本，请新建 v{N+1} 目录而不是修改既有快照。",
      );
    }
  }
  return {
    version: version.version,
    snapshotDate: version.snapshotDate,
    contentHash: version.contentHash,
    dir,
    fixturePath: version.files["fixture"]?.path ?? "",
  };
}

let cachedAssets: { info: AssetsVersionInfo; data: FixtureAssets } | null = null;

export function loadFixtureAssets(): { info: AssetsVersionInfo; data: FixtureAssets } {
  if (cachedAssets !== null) return cachedAssets;
  const info = latestAssetsVersion();
  if (info.fixturePath === "") throw new Error(`[EVAL-FIXTURE] ${info.dir}/VERSION.json 缺少 files.fixture.path`);
  const data = JSON.parse(readFileSync(join(info.dir, info.fixturePath), "utf8")) as FixtureAssets;
  cachedAssets = { info, data };
  return cachedAssets;
}

// ===== claims → ParsedEntry 确定性映射 =====

/** stance → confidence（产品口径翻译，见文件头注释；未知 stance 兜底 low 不猜测） */
const STANCE_CONFIDENCE: Record<string, ParsedEntry["confidence"]> = {
  positive_experience: "high",
  positive: "high",
  conditional_recommend: "medium",
  route_and_tip: "medium",
  tip: "medium",
  time_tip: "medium",
  access_tip_to_verify: "medium",
  safety_tip: "medium",
  budget_condition: "medium",
  conditional_risk: "medium",
  risk_of_activity: "medium",
  risk_of_provider: "medium",
  reported_or_unverified_experience: "low",
  operational_claim_to_verify: "low",
};

/** entity "西岛/木门与歪脖子椰子树" → 子点位 + 父景区；无 "/" 时整体为城市级点位 */
function splitEntity(entity: string): { name: string; parent: string | null } {
  const slash = entity.indexOf("/");
  if (slash <= 0 || slash === entity.length - 1) return { name: entity.trim(), parent: null };
  return { name: entity.slice(slash + 1).trim(), parent: entity.slice(0, slash).trim() };
}

export function claimToParsedEntry(claim: FixtureClaim): ParsedEntry {
  const { name, parent } = splitEntity(claim.entity);
  const confidence = STANCE_CONFIDENCE[claim.stance] ?? "low";
  return {
    name,
    type: parent !== null ? "in_attraction" : "attraction",
    parentAttraction: parent,
    scale: null,
    confidence,
    // 西岛拍照线（C04）：quote 内含明确时长的，翻译成 suggestMinutes 供排程消费
    suggestMinutes: /(\d+)\s*小时/.exec(claim.quote)?.[1] !== undefined && claim.id === "C04" ? 120 : null,
    locationHint: null,
    quote: claim.quote,
    summary: claim.summary,
    ticketRelation: "unknown",
    suggestedVisitName: null,
    bbox: null,
  };
}

/** 按来源取 fixture 抽取结果；sourceId 未收录时回退全量 claims（评测输入应显式使用 S1–S5） */
export function fixtureEntriesForSource(sourceId: string): ParsedEntry[] {
  const { data } = loadFixtureAssets();
  const claims = data.claims.filter((claim) => claim.source === sourceId);
  const picked = claims.length > 0 ? claims : data.claims;
  return picked.map(claimToParsedEntry);
}

// ===== 注入安装 / 卸载 =====

export interface FixtureExtractionStats {
  /** extractEntries 被业务链路调用的次数（>0 即证明抽取层已被 fixture 替换） */
  calls: number;
  lastTextPreview: string | null;
}

const stats: FixtureExtractionStats = { calls: 0, lastTextPreview: null };

export function isFixtureMode(): boolean {
  return process.env["EVAL_FIXTURE"] === "1";
}

export function getFixtureStats(): Readonly<FixtureExtractionStats> {
  return stats;
}

export function resetFixtureStats(): void {
  stats.calls = 0;
  stats.lastTextPreview = null;
}

export interface InstallFixtureOptions {
  /** 同时桩掉 fetchNote（小红书抓取），链接源用例完全离线；默认 true */
  stubFetchNote?: boolean;
}

/**
 * 安装 fixture 抽取（幂等）：EVAL_FIXTURE 未开启时直接返回 false，不做任何注入。
 * 每次注入调用打印 `[EVAL-FIXTURE]` 日志行——烟雾验证凭日志证明抽取层确实被替换。
 */
export function installFixtureExtraction(options: InstallFixtureOptions = {}): boolean {
  if (!isFixtureMode()) return false;
  const { data } = loadFixtureAssets();
  const stubFetchNote = options.stubFetchNote !== false;

  setGuideServiceDeps({
    extractEntries: async (text: string): Promise<ParsedEntry[]> => {
      stats.calls += 1;
      stats.lastTextPreview = text.slice(0, 60);
      // 来源匹配：提交文本里含 fixture 源标题 / noteId 时按源取 claims，否则全量
      const hit = data.sources.find(
        (source) => text.includes(source.title) || text.includes(source.noteId) || text.includes(source.url),
      );
      const entries = fixtureEntriesForSource(hit?.id ?? "");
      console.log(
        `[EVAL-FIXTURE] extractEntries 已替换为 fixture：来源=${hit?.id ?? "未识别(全量)"}，` +
          `条目=${entries.length}（${entries.map((entry) => entry.name).join("、")}）`,
      );
      return entries;
    },
    ...(stubFetchNote
      ? {
          fetchNote: async (url: string): Promise<XhsNoteResult> => {
            const hit = data.sources.find((source) => source.url === url || url.includes(source.noteId));
            console.log(`[EVAL-FIXTURE] fetchNote 已桩替换：url=${url} → ${hit?.id ?? "合成笔记"}`);
            return {
              success: true,
              title: hit?.title ?? "fixture 合成笔记",
              text: hit !== undefined ? `${hit.title}\n${hit.notes ?? ""}` : "fixture 合成笔记正文",
              images: [],
              imageSlots: [],
              sourceUrl: url,
            };
          },
        }
      : {}),
  });
  return true;
}

/** 卸载注入，恢复生产默认依赖（runner 收尾 / 用例间隔离调用） */
export function uninstallFixtureExtraction(): void {
  resetGuideServiceDeps();
  resetFixtureStats();
}
