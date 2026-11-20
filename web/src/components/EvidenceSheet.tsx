import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { GuideSnippet, GuideSource, SourceEvidence, Stop, Trip, Visit } from "@goplay/shared";
import { parseMentionRef } from "@goplay/shared";
import { stopDisplayName, visitDisplayName } from "../lib/trip";
import { buildEvidenceMentionScope } from "../lib/evidenceScope";
import { notifySheetOpened, onSheetOpened } from "../lib/sheetBus";
import { sourceTitle } from "./GuideSourceList";

interface EvidenceSheetProps {
  trip: Trip;
  /** 查看攻略原文的内部玩法（DayContent 既有调用通道，保持向后兼容） */
  stop?: Stop;
  /** 查看攻略原文的行程点位（B4：VisitCard 大景区父卡 / 普通卡攻略提示回看） */
  visit?: Visit;
  /** 打开时定位并高亮的提及（"evidenceId:mentionId"；来自 guideSnippets.sourceMentionRefs） */
  focusMentionRef?: string | null;
  onClose: () => void;
}

/** 证据来源标签：笔记正文 / 攻略截图 / 笔记链接 */
function evidenceLabel(evidence: SourceEvidence): string {
  if (evidence.kind === "note_text") {
    return evidence.noteIndex !== null ? `笔记 ${evidence.noteIndex} · 粘贴原文` : "粘贴原文";
  }
  if (evidence.kind === "screenshot") return "攻略截图";
  return "笔记链接（仅记录来源）";
}

/** 来源切换 tab：同一攻略来源下的全部证据（截图 + 正文提及）编为一组 */
interface SourceTab {
  key: string;
  label: string;
  status: GuideSource["status"] | null;
  evidences: SourceEvidence[];
}

const LEGACY_TAB_KEY = "__legacy__";

/**
 * 攻略原文 Sheet（B4 攻略提示证据回看）：
 * - 目标实体二选一：stop（DayContent 既有通道）或 visit（VisitCard 攻略提示）；
 * - 攻略来源切换：证据按 trip.guideSources 编组为 tabs，显示对应原文与截图；
 *   无来源归属的早期证据归「早期添加的素材」组；
 * - focusMentionRef 定位：打开时切到对应来源 tab，滚动到提及并高亮
 *  （点击 VisitCard/StopRow 的攻略提示 chips 进入）；
 * - 顶部展示实体挂载的攻略提示（guideSnippets），点击可跳转对应原文；
 * - 提及按点位层级筛选（任务 116）：普通景点/内部玩法只看自身相关提及，
 *   大景点合并内部玩法的提及；同篇证据中的其他地点不再因「同篇」混入；
 * - 内容经 portal 挂到 .app 根（StopRow 的 .child 等卡片容器是 positioned，
 *   直接渲染会把 absolute Sheet 限制在行卡片内）。
 */
export default function EvidenceSheet({ trip, stop, visit, focusMentionRef, onClose }: EvidenceSheetProps) {
  const target = stop ?? visit;
  const [zoomedPath, setZoomedPath] = useState<string | null>(null);
  /** 当前定位的提及（初始为 props.focusMentionRef；点击提示 chip 可切换） */
  const [focusRef, setFocusRef] = useState<string | null>(focusMentionRef ?? null);
  const focusedNodeRef = useRef<HTMLDivElement | null>(null);

  // portal 宿主：.app 根（paint 前定位，避免首帧闪烁）
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const host = anchorRef.current?.closest(".app");
    setPortalHost(host instanceof HTMLElement ? host : null);
  }, []);

  // Task #109 浮层互斥：挂载即广播本 Sheet 打开（上层 TripView 收到后关近期操作），
  // 其他浮层（近期操作等）打开时本 Sheet 让位关闭。onClose 走 ref 保证只订阅一次。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    notifySheetOpened("evidence");
    return onSheetOpened((kind) => {
      if (kind !== "evidence") onCloseRef.current();
    });
  }, []);

  const name =
    target === undefined
      ? ""
      : stop !== undefined
        ? stopDisplayName(trip, stop)
        : visit !== undefined
          ? visitDisplayName(trip, visit)
          : "";

  /**
   * 任务 116：按点位层级构建提及范围（精确 ref 优先，旧数据按名称降级）：
   * - 普通景点 Visit / Stop：仅自身提及，不合并同证据其他地点；
   * - 大景点 Visit：自身 + 内部玩法（childStopRefs）的提及；
   * - Stop 不合并父 Visit；
   * - 旧数据缺精确 ref → 目标名称与 mention.extractedName 规范化匹配；
   *   无法匹配 → 空态，不回退整篇所有 mentions。
   */
  const scope = useMemo(() => buildEvidenceMentionScope(trip, stop, visit), [trip, stop, visit]);

  /** 展示证据：范围返回的有序 id（每条至少含 1 个可见提及），悬空引用已在范围构建时剔除 */
  const evidences = useMemo(() => {
    return scope.evidenceIds
      .map((id) => trip.evidences[id])
      .filter((evidence): evidence is SourceEvidence => evidence !== undefined);
  }, [trip, scope]);

  /** 证据按攻略来源编组（B4 §3 来源切换）：无来源归属归「早期添加的素材」 */
  const tabs = useMemo<SourceTab[]>(() => {
    const sourceByEvidence = new Map<string, GuideSource>();
    for (const source of Object.values(trip.guideSources ?? {})) {
      for (const evidenceId of source.evidenceRefs) sourceByEvidence.set(evidenceId, source);
    }
    const groups = new Map<string, SourceTab>();
    for (const evidence of evidences) {
      const source = sourceByEvidence.get(evidence.evidenceId);
      const key = source !== undefined ? source.sourceId : LEGACY_TAB_KEY;
      let tab = groups.get(key);
      if (tab === undefined) {
        tab = {
          key,
          label: source !== undefined ? sourceTitle(source) : "早期添加的素材",
          status: source !== undefined ? source.status : null,
          evidences: [],
        };
        groups.set(key, tab);
      }
      tab.evidences.push(evidence);
    }
    return [...groups.values()];
  }, [trip, evidences]);

  // 初始 tab：focus 提及所在的来源；否则第一组
  const [activeKey, setActiveKey] = useState<string>(() => {
    const parsed = focusMentionRef !== undefined && focusMentionRef !== null ? parseMentionRef(focusMentionRef) : null;
    if (parsed !== null) {
      const hit = tabs.find((tab) => tab.evidences.some((evidence) => evidence.evidenceId === parsed.evidenceId));
      if (hit !== undefined) return hit.key;
    }
    return tabs[0]?.key ?? "";
  });
  const activeTab = tabs.find((tab) => tab.key === activeKey) ?? tabs[0];

  // 定位提及变化（打开定位 / 点击提示 chip）：滚动到该提及并居中
  useEffect(() => {
    if (focusRef === null) return;
    focusedNodeRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusRef, activeKey]);

  /** 点击攻略提示 chip：切换定位提及（并跳到其所属来源 tab） */
  function focusSnippet(snippet: GuideSnippet): void {
    const ref = snippet.sourceMentionRefs[0];
    if (ref === undefined) return;
    setFocusRef(ref);
    const parsed = parseMentionRef(ref);
    if (parsed !== null) {
      const tab = tabs.find((item) => item.evidences.some((evidence) => evidence.evidenceId === parsed.evidenceId));
      if (tab !== undefined) setActiveKey(tab.key);
    }
  }

  if (target === undefined) return null;

  const snippets = target.guideSnippets ?? [];

  const content = (
    <>
      <div className="backdrop on" onClick={onClose} aria-hidden="true" />
      <div className="sheet on" role="dialog" aria-modal="true" aria-label="攻略原文">
        <div className="sh">
          <div>
            <div className="st1">攻略原文</div>
            <div className="st2">{name} · 来自你的攻略，仅作参考</div>
          </div>
          <button type="button" className="x" onClick={onClose} aria-label="关闭攻略原文">
            ×
          </button>
        </div>
        <div className="sb">
          {/* 攻略提示（B4 §3）：点击定位到对应原文提及 */}
          {snippets.length > 0 ? (
            <div className="evidence-snippets" aria-label="攻略提示">
              {snippets.map((snippet) => (
                <button
                  key={snippet.snippetId}
                  type="button"
                  className={`evidence-snippet${focusRef !== null && snippet.sourceMentionRefs.includes(focusRef) ? " hit" : ""}`}
                  onClick={() => focusSnippet(snippet)}
                >
                  {snippet.text}
                </button>
              ))}
            </div>
          ) : null}

          {/* 来源切换（B4 §3）：多来源时展示 tabs；单来源直接展示 */}
          {tabs.length > 1 ? (
            <div className="evidence-source-tabs" role="tablist" aria-label="攻略来源">
              {tabs.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={activeTab?.key === tab.key}
                  className={`evidence-source-tab${activeTab?.key === tab.key ? " active" : ""}`}
                  onClick={() => setActiveKey(tab.key)}
                  title={tab.label}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          ) : null}

          {activeTab === undefined || activeTab.evidences.length === 0 ? (
            <div className="evidence-empty">这条{visit !== undefined ? "点位" : "玩法"}暂无原文摘录。</div>
          ) : (
            activeTab.evidences.map((evidence) => (
              <div className="evidence-group" key={evidence.evidenceId}>
                <div className="evidence-src">{evidenceLabel(evidence)}</div>
                {/* 截图类证据展示 OCR 全文 + 来源元信息；原图缩略图可点开回看 */}
                {evidence.kind === "screenshot" ? (
                  <div className="evidence-shot">
                    {evidence.assetPath ? (
                      <button
                        type="button"
                        className="evidence-thumb"
                        onClick={() => setZoomedPath(evidence.assetPath ?? null)}
                        aria-label="查看攻略截图原图"
                      >
                        <img src={`/api/${evidence.assetPath}`} alt="攻略截图缩略图" loading="lazy" />
                        <span className="evidence-thumb-hint">点击查看原图</span>
                      </button>
                    ) : null}
                    {evidence.assetRef !== null ? (
                      <div className="evidence-asset">来源：{evidence.assetRef}</div>
                    ) : null}
                    {evidence.sourceUrl !== null ? (
                      <div className="evidence-asset">笔记链接：{evidence.sourceUrl}</div>
                    ) : null}
                    {evidence.ocrText !== null && evidence.ocrText !== "" ? (
                      <div className="evidence-ocr">{evidence.ocrText}</div>
                    ) : null}
                    {evidence.assetPath ? null : (
                      <div className="evidence-privacy">原图仅用于本次识别，未在服务端保存。</div>
                    )}
                  </div>
                ) : null}
                {/* 任务 116：只展示范围内提及（精确 ref 或降级名称匹配），
                    同一篇证据里的其他地点不再因「同篇」混入 */}
                {evidence.mentions
                  .filter((mention) => scope.isVisible(evidence.evidenceId, mention))
                  .map((mention) => {
                    const hit = scope.preciseRefs.has(`${evidence.evidenceId}:${mention.mentionId}`);
                    const focused = focusRef === `${evidence.evidenceId}:${mention.mentionId}`;
                    const quote = mention.quoteText !== "" ? mention.quoteText : mention.text;
                    return (
                      <div
                        className={`evidence-quote${hit ? " hit" : ""}${focused ? " focused" : ""}`}
                        key={mention.mentionId}
                        ref={focused ? focusedNodeRef : undefined}
                      >
                        {quote !== "" ? <p>“{quote}”</p> : null}
                        {mention.modelSummary !== null ? (
                          <div className="evidence-sum">AI 概括：{mention.modelSummary}</div>
                        ) : null}
                      </div>
                    );
                  })}
              </div>
            ))
          )}
          {stop !== undefined && stop.locationHint !== null ? (
            <div className="evidence-note">位置提示：{stop.locationHint}（来自原文，仅作参考）</div>
          ) : null}
          {stop !== undefined && stop.matchedPointRef === null ? (
            <div className="evidence-note">自定义添加点位：飞猪里没找到，仍保留在行程里。</div>
          ) : null}
        </div>
      </div>
      {/* 原图全屏回看 overlay，点击任意处关闭 */}
      {zoomedPath !== null ? (
        <div
          className="evidence-zoom"
          role="dialog"
          aria-modal="true"
          aria-label="攻略截图原图"
          onClick={() => setZoomedPath(null)}
        >
          <img src={`/api/${zoomedPath}`} alt="攻略截图原图" />
          <button
            type="button"
            className="evidence-zoom-close"
            aria-label="关闭原图"
            onClick={(event) => {
              event.stopPropagation();
              setZoomedPath(null);
            }}
          >
            ×
          </button>
        </div>
      ) : null}
    </>
  );

  return (
    <>
      {/* 定位锚点：渲染在调用处（可能位于 positioned 卡片内），据此把内容 portal 到 .app 根 */}
      <div ref={anchorRef} aria-hidden="true" style={{ display: "none" }} />
      {portalHost !== null ? createPortal(content, portalHost) : content}
    </>
  );
}
