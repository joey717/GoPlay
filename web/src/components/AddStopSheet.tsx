import { useState } from "react";
import type { CustomStopInput } from "../hooks/useTrip";
import { searchPoi, type PoiSearchResult } from "../api/client";

interface AddStopSheetProps {
  /** 目标大景区名称（展示用 + 匹配结果的同名收窄上下文，Task #334） */
  visitName: string;
  /** Trip.destination.city（如「三亚」），传给 FlyAI searchPoi 做城市过滤 */
  cityName: string;
  /**
   * meta.matchedPoi：本次提交是否命中飞猪 POI（false = 降级 custom）。
   * Task #334：上层据此展示降级提示，让「未匹配到飞猪点位」可感知。
   */
  onConfirm: (input: CustomStopInput, meta: { matchedPoi: boolean }) => void;
  onClose: () => void;
}

/**
 * 手动添加点位（PRD §7.6）：名称必填；位置提示 / 攻略原文选填。
 * Task #100：提交时先调 FlyAI searchPoi，命中则透传 matchedPoi 使上层创建
 * fliggy Item；无命中才降级 custom。
 * Task #334：搜索词改传用户输入的**裸词**，城市走 destination 参数——此前把
 * 父景区名拼进 keyword（「蜈支洲岛 情人桥」）会在服务端 explicit destination
 * 路径下整串透传给 FlyAI --keyword，短词/多词拼接形态实测召回为空或不稳定
 * （「三亚 西」0 条 vs 裸词「西」10 条），导致岛内点位静默降级 custom。
 */
export default function AddStopSheet({ visitName, cityName, onConfirm, onClose }: AddStopSheetProps) {
  const [name, setName] = useState("");
  const [hint, setHint] = useState("");
  const [note, setNote] = useState("");
  const [searching, setSearching] = useState(false);
  const canConfirm = name.trim() !== "" && !searching;

  /** 尝试匹配 FlyAI POI；匹配失败或搜索报错均降级 custom（不阻止添加） */
  const submit = async () => {
    if (!canConfirm) return;
    const trimmedName = name.trim();
    setSearching(true);
    let matchedPoi: CustomStopInput["matchedPoi"] = null;
    try {
      // Task #334：keyword 传裸词（仅用户输入），城市走 destination 结构化参数；
      // 父景区名不再拼进 keyword（FlyAI 对拼接形态召回为空或不稳定）
      const result = await searchPoi(trimmedName, cityName === "" ? undefined : cityName);
      // 保守匹配策略（严禁编辑距离/模糊相似度，见 #233 决策）：
      // 名称完全相等 > 名称互相包含；裸词召回变宽后，同档多候选用
      // 「地址含父景区名」收窄（仍是字面包含判定，不引入相似度）
      const normalized = result.normalized;
      const pickWithParentHint = (
        candidates: PoiSearchResult[],
      ): PoiSearchResult | undefined => {
        const inParent = candidates.find(
          (poi) => visitName.trim() !== "" && (poi.address ?? "").includes(visitName.trim()),
        );
        return inParent ?? candidates[0];
      };
      const exactMatches = normalized.filter((poi) => poi.name.trim() === trimmedName);
      // 互相包含：如搜索「情人桥」命中 POI「情人桥」，或搜索「海滨浴场」命中「蜈支洲岛海滨浴场」
      const containsMatches =
        exactMatches.length === 0
          ? normalized.filter(
              (poi) => poi.name.includes(trimmedName) || trimmedName.includes(poi.name),
            )
          : [];
      const poi = pickWithParentHint(exactMatches.length > 0 ? exactMatches : containsMatches);
      if (poi !== undefined) {
        matchedPoi = {
          id: poi.id,
          name: poi.name,
          address: poi.address,
          category: poi.category,
          coords: poi.coords,
          mainPic: poi.mainPic,
          ticketInfo: poi.ticketInfo,
          jumpUrl: poi.jumpUrl,
          freePoiStatus: poi.freePoiStatus ?? undefined, // Task #329 透传
          // Task #330：飞猪 POI 元信息透传（等级/榜单/介绍）
          poiLevel: poi.poiLevel ?? undefined,
          listRank: poi.listRank ?? undefined,
          description: poi.description ?? undefined,
          suggestMinutes: null, // FlyAI POI 不返回时长，由用户后续设定
        };
      }
    } catch {
      // 搜索失败降级为 custom，不阻止添加操作
    }
    setSearching(false);
    onConfirm(
      {
        name: trimmedName,
        locationHint: hint.trim() === "" ? null : hint.trim(),
        noteText: note.trim() === "" ? null : note.trim(),
        matchedPoi,
      },
      { matchedPoi: matchedPoi !== null },
    );
  };

  return (
    <>
      <div className="backdrop on" onClick={onClose} aria-hidden="true" />
      <div className="sheet on" role="dialog" aria-modal="true" aria-label="添加点位">
        <div className="sh">
          <div>
            <div className="st1">添加点位</div>
            <div className="st2">加入「{visitName}」的岛内行程末尾；名称命中飞猪景点时自动关联详情</div>
          </div>
          <button type="button" className="x" onClick={onClose} aria-label="关闭添加点位">
            ×
          </button>
        </div>
        <div className="sb">
          <div className="addstop-form">
            <label>
              <span>
                名称 <em>必填</em>
              </span>
              <input
                value={name}
                placeholder="如：入口左转小吃店"
                maxLength={30}
                autoFocus
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submit();
                }}
              />
            </label>
            <label>
              <span>
                位置提示 <em>选填</em>
              </span>
              <input
                value={hint}
                placeholder="如：入口进门后左转"
                maxLength={40}
                onChange={(event) => setHint(event.target.value)}
              />
            </label>
            <label>
              <span>
                攻略原文 <em>选填</em>
              </span>
              <textarea
                value={note}
                placeholder="粘贴提到这个点位的原文，方便回看"
                rows={3}
                maxLength={200}
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
          </div>
          <div className="addstop-actions">
            <button type="button" className="ghost" onClick={onClose}>
              取消
            </button>
            <button type="button" className="cta" disabled={!canConfirm} onClick={() => void submit()}>
              {searching ? "搜索中…" : "添加"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
