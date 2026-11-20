import { useEffect, useRef, useState } from "react";
import type { GuideSource } from "@goplay/shared";
import type { SourceOriginal } from "../lib/sourceOriginal";
import { notifySheetOpened, onSheetOpened } from "../lib/sheetBus";
import { sourceTitle } from "./GuideSourceList";

interface SourceOriginalSheetProps {
  /** 被回看的来源（标题 / 状态徽章口径与来源列表一致） */
  source: GuideSource;
  /** 已解析的原文内容（resolveSourceOriginal；调用方保证至少一项非空） */
  original: SourceOriginal;
  onClose: () => void;
}

/**
 * 来源原文查看层（任务 186）：统一添加面板里截图 / 粘贴文字来源的「原文」入口。
 *
 * - 复用既有底部 Sheet 观感（.backdrop/.sheet 同一套样式，.source-original-*
 *   仅抬高 z-index 盖过 NoteInput 面板 61 层）与 .evidence-zoom 原图全屏回看，
 *   不另造弹层体系；与 EvidenceSheet 的提炼证据视图继续分离——这里只有
 *   用户提交的原始内容（完整文本 / 原始截图），不混入 mentions / OCR 摘要；
 * - 文本保留换行（pre-wrap）与基本排版；多图按上传顺序纵向排列，单图同样适用；
 * - 附带的外部来源链接（文字 / 截图提交时识别到的链接）作为次要信息展示；
 * - Task #109 浮层互斥同 EvidenceSheet：挂载广播 evidence，其他浮层打开时让位。
 */
export default function SourceOriginalSheet({ source, original, onClose }: SourceOriginalSheetProps) {
  const [zoomedPath, setZoomedPath] = useState<string | null>(null);

  // 浮层互斥：挂载即广播（与 EvidenceSheet 同 kind——本层在 NoteInput 之上，
  // 底层浮层本就被覆盖；订阅仅为一致性防御）
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    notifySheetOpened("evidence");
    return onSheetOpened((kind) => {
      if (kind !== "evidence") onCloseRef.current();
    });
  }, []);

  const subtitleParts: string[] = [sourceTitle(source)];
  if (original.images.length > 0) subtitleParts.push(`截图 ${original.images.length} 张`);
  if (original.text !== null) subtitleParts.push("你粘贴的原文");
  subtitleParts.push("仅作参考");

  return (
    <>
      <div className="backdrop on source-original-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="sheet on source-original-sheet" role="dialog" aria-modal="true" aria-label="来源原文">
        <div className="sh">
          <div>
            <div className="st1">原文</div>
            <div className="st2">{subtitleParts.join(" · ")}</div>
          </div>
          <button type="button" className="x" onClick={onClose} aria-label="关闭原文">
            ×
          </button>
        </div>
        <div className="sb">
          {original.text !== null ? (
            <div className="source-original-text">{original.text}</div>
          ) : null}

          {original.images.length > 0 ? (
            <div className="source-original-images">
              {original.images.map((image, position) => (
                <div className="source-original-image" key={`${image.index}:${image.path}`}>
                  <button
                    type="button"
                    className="source-original-thumb"
                    onClick={() => setZoomedPath(image.path)}
                    aria-label={`查看第 ${image.index} 张截图原图`}
                  >
                    <img src={`/api/${image.path}`} alt={`攻略截图 ${image.index}`} loading="lazy" />
                  </button>
                  <div className="source-original-caption">
                    截图 {position + 1}/{original.images.length}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {original.externalUrl !== null ? (
            <div className="source-original-ext">
              来源链接：
              <a href={original.externalUrl} target="_blank" rel="noreferrer">
                {original.externalUrl}
              </a>
            </div>
          ) : null}
        </div>
      </div>
      {/* 原图全屏回看：复用 .evidence-zoom（fixed z-90，高于本层），点击任意处关闭 */}
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
}
