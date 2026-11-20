/**
 * Task #313 live 取证（Run A）：dev server 全链路——scratch 行程提交一条真实纯文字
 * 攻略来源（eval 语料 6ace31c6 西岛 seawalk 笔记原文），轮询提交→ready 总秒数。
 *
 * 对照基线（Cole #277）：纯文字攻略后台处理 ~180s（抽取 ~55s ＋ 装配 ~126s 串行）。
 *
 * 用法：node scripts/perf-task313-submit.mjs [runTag]
 * 输出：JSON 摘要（stdout）——tripId / sourceId / 总秒数 / 终态 / mention 数。
 */
const BASE = "http://localhost:8787";
const runTag = process.argv[2] ?? "runA";

// eval 语料：西岛笔记原文（1 attraction + 5 in_attraction + 3 note_tip——与基线
// 6 mention 同量级）；加 run 标记使 contentHash 与历史源不同（避免撞 PD 已有来源去重）
import { readFileSync } from "node:fs";
const corpus = JSON.parse(
  readFileSync(new URL("../eval/cache/extraction/6ace31c6000000001b0202f7.json", import.meta.url), "utf8"),
);
const text = `${corpus.text}\n\n（Task #313 并行装配提速取证 ${runTag}， scratch 行程，测毕归档）`;

const post = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const get = async (path) => {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
};

const t0 = Date.now();
const tripRes = await post("/api/trip", {
  destination: { city: "三亚" },
  dateRange: { start: "2026-11-10", end: "2026-11-14", nights: 4 },
});
if (tripRes.status !== 201) {
  console.error("创建 scratch 行程失败：", tripRes.status, JSON.stringify(tripRes.body).slice(0, 300));
  process.exit(1);
}
const tripId = tripRes.body?.tripId ?? tripRes.body?.trip?.tripId;

const submitRes = await post(`/api/guides/trips/${tripId}/sources`, { inputKind: "text", text });
const submittedAt = Date.now();
if (submitRes.status >= 400 || !submitRes.body?.sourceId) {
  console.error("提交来源失败：", submitRes.status, JSON.stringify(submitRes.body).slice(0, 300));
  process.exit(1);
}
const sourceId = submitRes.body.sourceId;
console.log(
  `[${runTag}] tripId=${tripId} sourceId=${sourceId} 提交响应 ${((submittedAt - t0) / 1000).toFixed(2)}s，开始轮询…`,
);

// 轮询（2s 间隔，上限 400s）：直到来源离开 processing
let source = null;
for (;;) {
  await new Promise((r) => setTimeout(r, 2000));
  const poll = await get(`/api/guides/trips/${tripId}/sources/${sourceId}`);
  source = poll.body?.source ?? poll.body;
  const elapsed = ((Date.now() - submittedAt) / 1000).toFixed(1);
  if (!source || source.status !== "processing") {
    console.log(`[${runTag}] 终态 ${source?.status ?? "unknown"} @ ${elapsed}s`);
    break;
  }
  if (Date.now() - submittedAt > 400_000) {
    console.log(`[${runTag}] 轮询超时（400s），末次状态 ${source.status}`);
    break;
  }
}

const totalSec = (Date.now() - submittedAt) / 1000;
const trip = (await get(`/api/trip/${tripId}`)).body?.trip ?? (await get(`/api/trip/${tripId}`)).body ?? null;
const summary = {
  runTag,
  tripId,
  sourceId,
  textChars: text.length,
  status: source?.status ?? "unknown",
  totalSeconds: Number(totalSec.toFixed(1)),
  mentionRefs: source?.mentionRefs?.length ?? null,
  evidenceRefs: source?.evidenceRefs?.length ?? null,
  items: trip ? Object.keys(trip.itemRegistry ?? {}).length : null,
  visits: trip ? Object.keys(trip.visits ?? {}).length : null,
  stops: trip ? Object.keys(trip.stops ?? {}).length : null,
  finishedAt: new Date().toISOString(),
};
console.log(`[${runTag}] SUMMARY ${JSON.stringify(summary)}`);
