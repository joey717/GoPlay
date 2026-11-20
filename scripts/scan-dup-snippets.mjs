/** 只读扫描：分析 trip JSON 中 snippets / sourceMentionRefs / guideSources 的重复形态 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dataDir = "/Users/zhengying/goplay/server/data";

function lcsRatio(a, b) {
  const m = a.length, n = b.length;
  if (m === 0 || n === 0) return 0;
  let prev = new Array(n + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1).fill(0);
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      if (cur[j] > best) best = cur[j];
    }
    prev = cur;
  }
  return best / Math.min(m, n);
}

for (const file of readdirSync(dataDir)) {
  if (!file.endsWith(".json")) continue;
  const trip = JSON.parse(readFileSync(join(dataDir, file), "utf8"));
  const findings = [];

  // guideSources 概览
  const sources = trip.guideSources ?? {};
  const textSources = Object.values(sources).filter((s) => s.inputKind === "text" && s.active !== false);
  const srcSummary = textSources.map((s) => `${s.sourceId} title=${JSON.stringify(s.title ?? null)} hash=${String(s.contentHash ?? "").slice(0, 10)} evs=${s.evidenceRefs.length}`);

  // 实体级重复检测
  const entities = [
    ...Object.entries(trip.visits ?? {}).map(([id, v]) => ["visit", id, v]),
    ...Object.entries(trip.stops ?? {}).map(([id, s]) => ["stop", id, s]),
  ];
  for (const [kind, id, entity] of entities) {
    const snippets = entity.guideSnippets ?? [];
    if (snippets.length >= 2) {
      for (let i = 0; i < snippets.length; i++) {
        for (let j = i + 1; j < snippets.length; j++) {
          const a = snippets[i].text.trim(), b = snippets[j].text.trim();
          const ratio = lcsRatio(a, b);
          if (a === b || ratio >= 0.9) {
            findings.push(`  [${kind} ${id}] snippet 重合 ${ratio.toFixed(2)}: "${a.slice(0, 25)}" vs "${b.slice(0, 25)}" refsA=${JSON.stringify(snippets[i].sourceMentionRefs)} refsB=${JSON.stringify(snippets[j].sourceMentionRefs)}`);
          }
        }
      }
    }
    const refs = entity.sourceMentionRefs ?? [];
    if (refs.length >= 2) {
      // 解析每个 ref → evidence → source
      const evToSrc = new Map();
      for (const s of Object.values(sources)) for (const ev of s.evidenceRefs) evToSrc.set(ev, s.sourceId);
      const keys = refs.map((r) => {
        const [evId, mId] = r.split(":");
        const ev = (trip.evidences ?? {})[evId];
        const idx = ev ? (ev.mentions ?? []).findIndex((m) => m.mentionId === mId) : -1;
        return `${evToSrc.get(evId) ?? "?"}:${idx}`;
      });
      const dupKeys = keys.filter((k, i) => keys.indexOf(k) !== i);
      if (dupKeys.length > 0) {
        findings.push(`  [${kind} ${id}] sourceMentionRefs 组合键重复: refs=${JSON.stringify(refs)} keys=${JSON.stringify(keys)}`);
      }
    }
  }

  if (findings.length > 0 || srcSummary.length > 0) {
    console.log(`\n=== ${file} (updatedAt=${trip.updatedAt}) ===`);
    for (const line of srcSummary) console.log(`  source: ${line}`);
    for (const line of findings) console.log(line);
  }
}
