/**
 * shared 一致性校验 —— PRD v1.1 §12.5「提交前一致性校验」的纯函数实现。
 *
 * 由 applyOps 在最终接受集应用后调用：任一条目失败即视为一致性失败，
 * 调用方（applyOps）将整批回滚，不留下半写入。
 *
 * 检查清单（每条违规返回一句可读原因）：
 * 1. dayRefs 与 days 双向一致，dayIndex 唯一且连续（1..N），dayRefs 顺序与 dayIndex 一致；
 * 2. Day.scheduleVisitRefs ↔ Visit.dayRef 双向一致，Visit.order 与下标一致；
 * 3. lodgings 的 key 与 LodgingPlan.dayIndex 一致，dayIndex 落在行程内；每天最多一条（Record 结构保证）；
 * 3a. 住宿多候选（rev2，Task #80）：每个 LodgingPlan.hotelRefs 元素必须存在于
 *     trip.hotelRegistry（悬空引用 = error）；同一天内 hotelRefs 不得重复；
 *     deprecated 的 hotelCandidate / status 不参与一致性校验（以 hotelRefs +
 *     hotelRegistry 为唯一事实源）；hotelRegistry 孤儿条目（无任何 hotelRefs 引用）
 *     属 warning 级，由 collectConsistencyWarnings 单独收集，不阻断提交、不触发
 *     applyOps 整批回滚；
 * 4. 每个 Visit 恰好属于一个 Day 或 globalPool（互斥）；globalPool 的 Visit 仍保持子项挂载；
 * 5. Stop.state=attached 时必须且只属于一个 Visit 的 childStopRefs 或 alternateStopRefs，
 *    visitRef 指向该 Visit，order 与下标一致；state=pending 时 visitRef 为空且只出现于 pendingStopRefs；
 * 6. Item / Visit / Stop / Evidence / EvidenceMention / RelationshipSuggestion 引用无悬空；
 * 7. 层级深度为一（Stop 只出现在 stops 注册表，绝不嵌套）；
 * 8. order 无重复且连续（schedule / child / alternate 的下标即权威顺序）；
 * 9. 已加入与待定候选不重复占用（同一实体不同时出现在多个容器）；
 * 10. 时间轴可计算或明确处于待定（startTime/endTime/effectiveMinutes 为 null 是合法待定态）；
 * 11. 攻略来源（修订附录 B v0.3）：evidenceRefs / mentionRefs 必须可解析；
 *     ready 至少有正文或可用证据（不要求图片全部成功），partial 保留成功部分；
 *     图片进度逐图记录 evidenceId 或失败原因，计数与明细一致；
 * 12. 攻略提示与草案快照：GuideSnippet 的 mention 引用必须存在；
 *     pendingGuideDraft 的来源快照必须可解析——版本过期属于应用时拒绝，
 *     不作为一致性 error，避免历史 Trip 无法加载。
 */

import type { GuideSource, HotelCandidate, Trip } from "../types/index.js";
import {
  GUIDE_SNIPPET_MAX_CHARS,
  GUIDE_SNIPPET_MAX_MENTION_REFS,
  findMentionsById,
  hasUsableGuideEvidence,
  parseMentionRef,
  resolveMentionRef,
} from "../guides/index.js";

/** 校验 trip 结构一致性；返回违规原因列表（空数组 = 通过） */
export function validateConsistency(trip: Trip): string[] {
  const errors: string[] = [];
  const dayIndexById = new Map<string, number>(); // dayId -> dayIndex
  const scheduleSeen = new Set<string>(); // 已被某天 schedule 占用的 visitId

  // ---- 1. dayRefs / days ----
  const totalDays = trip.dayRefs.length;
  trip.dayRefs.forEach((dayId, position) => {
    const day = trip.days[dayId];
    if (day === undefined) {
      errors.push(`dayRefs 引用了不存在的 dayId：${dayId}`);
      return;
    }
    if (day.dayId !== dayId) errors.push(`days["${dayId}"].dayId 与 key 不一致：${day.dayId}`);
    if (dayIndexById.has(day.dayId)) errors.push(`dayId 重复：${day.dayId}`);
    dayIndexById.set(day.dayId, day.dayIndex);
    if (day.dayIndex !== position + 1) {
      errors.push(`Day${day.dayIndex} 的 dayIndex 与 dayRefs 顺序不一致（期望 ${position + 1}）`);
    }
  });
  const dayIndexes = [...dayIndexById.values()].sort((a, b) => a - b);
  dayIndexes.forEach((value, index) => {
    if (value !== index + 1) {
      errors.push(`dayIndex 不连续：排序后第 ${index + 1} 位为 ${value}`);
    }
  });
  for (const dayId of Object.keys(trip.days)) {
    if (!trip.dayRefs.includes(dayId)) errors.push(`days 中存在 dayRefs 未包含的 dayId：${dayId}`);
  }

  // ---- 2. scheduleVisitRefs ↔ Visit.dayRef 双向一致 + order 一致 ----
  for (const dayId of trip.dayRefs) {
    const day = trip.days[dayId];
    if (day === undefined) continue;
    day.scheduleVisitRefs.forEach((visitId, order) => {
      const visit = trip.visits[visitId];
      if (visit === undefined) {
        errors.push(`Day${day.dayIndex}.scheduleVisitRefs 引用了不存在的 visit：${visitId}`);
        return;
      }
      if (scheduleSeen.has(visitId)) {
        errors.push(`visit ${visitId} 同时出现在多天的行程中`);
      }
      scheduleSeen.add(visitId);
      if (visit.dayRef !== dayId) {
        errors.push(`visit ${visitId} 的 dayRef=${String(visit.dayRef)} 与所在天 Day${day.dayIndex} 不一致`);
      }
      if (visit.order !== order) errors.push(`visit ${visitId} 的 order=${String(visit.order)} 与天内下标 ${order} 不一致`);
    });
  }

  // ---- 3. lodgings key / dayIndex ----
  for (const [key, plan] of Object.entries(trip.lodgings)) {
    if (key !== String(plan.dayIndex)) {
      errors.push(`lodgings["${key}"].dayIndex=${plan.dayIndex} 与 key 不一致`);
    }
    if (!(plan.dayIndex >= 1 && plan.dayIndex <= totalDays)) {
      errors.push(`lodgings["${key}"].dayIndex=${plan.dayIndex} 超出行程范围（1-${totalDays}）`);
    }
  }

  // ---- 3a. 住宿多候选（rev2，Task #80）：hotelRefs ↔ hotelRegistry 引用完整性 ----
  // deprecated 的 hotelCandidate / status 不参与校验（rev2 以 hotelRefs + hotelRegistry
  // 为唯一事实源）；hotelRegistry 主数据只增不删，孤儿条目（无引用）走 warning
  //（collectConsistencyWarnings），不在此报 error、不触发整批回滚。
  // 运行时防御：registry 缺失/非法先报 error，后续引用检查用安全访问，避免二次崩溃。
  const registry = trip.hotelRegistry as Record<string, HotelCandidate> | undefined;
  if (registry === undefined || registry === null || Array.isArray(registry)) {
    errors.push("trip.hotelRegistry 缺失或非法（rev2 契约要求为对象，允许为空对象）");
  }
  for (const [key, plan] of Object.entries(trip.lodgings)) {
    if (!Array.isArray(plan.hotelRefs)) {
      errors.push(`lodgings["${key}"].hotelRefs 缺失或非法（rev2 契约要求为字符串数组）`);
      continue;
    }
    const seenInDay = new Set<string>();
    for (const hotelId of plan.hotelRefs) {
      if (typeof hotelId !== "string" || hotelId === "") {
        errors.push(`lodgings["${key}"].hotelRefs 存在非法 hotelId：${String(hotelId)}`);
        continue;
      }
      if (seenInDay.has(hotelId)) {
        errors.push(`lodgings["${key}"].hotelRefs 中酒店重复：${hotelId}`);
      }
      seenInDay.add(hotelId);
      if (registry === undefined || registry === null || registry[hotelId] === undefined) {
        errors.push(`lodgings["${key}"].hotelRefs 引用了 hotelRegistry 中不存在的酒店：${hotelId}`);
      }
    }
  }

  // ---- 4. Visit 归属互斥：day 或 globalPool 恰居其一 ----
  const poolVisitIds = new Set<string>();
  const poolPointIds = new Set<string>();
  trip.globalCandidateRefs.forEach((ref, index) => {
    if (ref.kind === "visit") {
      const visit = trip.visits[ref.id];
      if (visit === undefined) {
        errors.push(`globalCandidateRefs[${index}] 引用了不存在的 visit：${ref.id}`);
        return;
      }
      if (poolVisitIds.has(ref.id)) errors.push(`globalCandidateRefs 中 visit 重复：${ref.id}`);
      poolVisitIds.add(ref.id);
      if (visit.dayRef !== null) {
        errors.push(`visit ${ref.id} 已排入 Day（dayRef=${visit.dayRef}）却仍在 globalPool`);
      }
    } else if (ref.kind === "point") {
      if (trip.itemRegistry[ref.id] === undefined) {
        errors.push(`globalCandidateRefs[${index}] 引用了不存在的 point：${ref.id}`);
      }
      if (poolPointIds.has(ref.id)) errors.push(`globalCandidateRefs 中 point 重复：${ref.id}`);
      poolPointIds.add(ref.id);
    } else {
      errors.push(`globalCandidateRefs[${index}] 类型非法：${String(ref.kind)}（只允许 point / visit）`);
    }
  });
  for (const visitId of Object.keys(trip.visits)) {
    const visit = trip.visits[visitId]!;
    if (visit.dayRef === null && !poolVisitIds.has(visitId)) {
      errors.push(`visit ${visitId} 不属于任何天，也不在 globalPool`);
    }
    if (visit.dayRef !== null && poolVisitIds.has(visitId)) {
      errors.push(`visit ${visitId} 同时出现在天与 globalPool`);
    }
    if (visit.dayRef !== null && trip.days[visit.dayRef] === undefined) {
      errors.push(`visit ${visitId}.dayRef 指向不存在的 dayId：${visit.dayRef}`);
    }
    if (visit.dayRef === null && visit.order !== null) {
      errors.push(`visit ${visitId} 在 globalPool 时 order 必须为 null（当前 ${String(visit.order)}）`);
    }
    if (trip.itemRegistry[visit.pointRef] === undefined) {
      errors.push(`visit ${visitId}.pointRef 指向不存在的 item：${visit.pointRef}`);
    }
    validateGuideSnippets(`visit ${visitId}`, (visit as { guideSnippets?: unknown }).guideSnippets, trip, errors);
    // 大景区壳进入 globalPool 时子项保持挂载（PRD §10.3）：只校验子引用存在性
    for (const stopId of [...visit.childStopRefs, ...visit.alternateStopRefs]) {
      if (trip.stops[stopId] === undefined) errors.push(`visit ${visitId} 引用了不存在的 stop：${stopId}`);
    }
  }

  // ---- 5. Stop 状态 / 容器唯一归属 / order ----
  const stopSeen = new Map<string, string>(); // stopId -> 容器描述（child:visitX / alternate:visitY / pending）
  for (const visitId of Object.keys(trip.visits)) {
    const visit = trip.visits[visitId]!;
    visit.childStopRefs.forEach((stopId, order) => {
      const stop = trip.stops[stopId];
      if (stop === undefined) return; // 悬空已在第 4 步报告
      if (stopSeen.has(stopId)) {
        errors.push(`stop ${stopId} 同时出现在多个容器（${stopSeen.get(stopId)} 与 child:${visitId}）`);
      }
      stopSeen.set(stopId, `child:${visitId}`);
      if (stop.state !== "attached") errors.push(`stop ${stopId} 位于 childStopRefs 但 state=${stop.state}`);
      if (stop.visitRef !== visitId) errors.push(`stop ${stopId}.visitRef=${String(stop.visitRef)} 与 child 容器 ${visitId} 不一致`);
      if (stop.order !== order) errors.push(`stop ${stopId}.order=${String(stop.order)} 与 child 下标 ${order} 不一致`);
    });
    visit.alternateStopRefs.forEach((stopId, order) => {
      const stop = trip.stops[stopId];
      if (stop === undefined) return;
      if (stopSeen.has(stopId)) {
        errors.push(`stop ${stopId} 同时出现在多个容器（${stopSeen.get(stopId)} 与 alternate:${visitId}）`);
      }
      stopSeen.set(stopId, `alternate:${visitId}`);
      if (stop.state !== "attached") errors.push(`stop ${stopId} 位于 alternateStopRefs 但 state=${stop.state}`);
      if (stop.visitRef !== visitId) errors.push(`stop ${stopId}.visitRef=${String(stop.visitRef)} 与 alternate 容器 ${visitId} 不一致`);
      if (stop.order !== order) errors.push(`stop ${stopId}.order=${String(stop.order)} 与 alternate 下标 ${order} 不一致`);
    });
  }
  trip.pendingStopRefs.forEach((stopId) => {
    const stop = trip.stops[stopId];
    if (stop === undefined) {
      errors.push(`pendingStopRefs 引用了不存在的 stop：${stopId}`);
      return;
    }
    if (stopSeen.has(stopId)) {
      errors.push(`stop ${stopId} 同时出现在容器 ${stopSeen.get(stopId)} 与 pendingStopRefs`);
    }
    stopSeen.set(stopId, "pending");
    if (stop.state !== "pending") errors.push(`stop ${stopId} 位于 pendingStopRefs 但 state=${stop.state}`);
    if (stop.visitRef !== null) errors.push(`stop ${stopId} 为 pending 但 visitRef=${stop.visitRef} 非空`);
    if (stop.order !== null) errors.push(`stop ${stopId} 为 pending 但 order=${String(stop.order)} 非空`);
  });
  for (const stopId of Object.keys(trip.stops)) {
    const stop = trip.stops[stopId]!;
    if (!stopSeen.has(stopId)) {
      errors.push(`stop ${stopId} 不属于任何容器（child / alternate / pending 均未包含）`);
      continue;
    }
    if (stop.matchedPointRef !== null && trip.itemRegistry[stop.matchedPointRef] === undefined) {
      errors.push(`stop ${stopId}.matchedPointRef 指向不存在的 item：${stop.matchedPointRef}`);
    }
    if (stop.matchedPointRef === null && (stop.customName === null || stop.customName === "")) {
      errors.push(`stop ${stopId} 既未命中飞猪点位也无自定义名称`);
    }
    if (stop.suggestedVisitRef !== null && trip.visits[stop.suggestedVisitRef] === undefined) {
      errors.push(`stop ${stopId}.suggestedVisitRef 指向不存在的 visit：${stop.suggestedVisitRef}`);
    }
    if (stop.state === "attached" && stop.suggestedVisitRef !== null) {
      errors.push(`stop ${stopId} 为 attached 但仍携带 suggestedVisitRef（应仅 pending 时保留）`);
    }
    validateGuideSnippets(`stop ${stopId}`, (stop as { guideSnippets?: unknown }).guideSnippets, trip, errors);
  }

  // ---- 6. Evidence / Mention / RelationshipSuggestion 引用无悬空 ----
  for (const itemId of Object.keys(trip.itemRegistry)) {
    const item = trip.itemRegistry[itemId]!;
    for (const evidenceId of item.sourceEvidenceRefs) {
      if (trip.evidences[evidenceId] === undefined) {
        errors.push(`item ${itemId}.sourceEvidenceRefs 引用了不存在的证据：${evidenceId}`);
      }
    }
  }
  for (const stopId of Object.keys(trip.stops)) {
    const stop = trip.stops[stopId]!;
    for (const evidenceId of stop.sourceEvidenceRefs) {
      if (trip.evidences[evidenceId] === undefined) {
        errors.push(`stop ${stopId}.sourceEvidenceRefs 引用了不存在的证据：${evidenceId}`);
      }
    }
    for (const mentionRef of stop.sourceMentionRefs) {
      const separator = mentionRef.indexOf(":");
      if (separator <= 0 || separator === mentionRef.length - 1) {
        errors.push(`stop ${stopId}.sourceMentionRefs 格式非法（须为 evidenceId:mentionId）：${mentionRef}`);
        continue;
      }
      const evidenceId = mentionRef.slice(0, separator);
      const mentionId = mentionRef.slice(separator + 1);
      const evidence = trip.evidences[evidenceId];
      if (evidence === undefined) {
        errors.push(`stop ${stopId}.sourceMentionRefs 引用了不存在的证据：${evidenceId}`);
        continue;
      }
      if (!evidence.mentions.some((m) => m.mentionId === mentionId)) {
        errors.push(`stop ${stopId}.sourceMentionRefs 引用了证据 ${evidenceId} 中不存在的提及：${mentionId}`);
      }
    }
  }
  for (const [stopId, suggestion] of Object.entries(trip.relationshipSuggestions)) {
    if (trip.stops[stopId] === undefined) {
      errors.push(`relationshipSuggestions["${stopId}"] 引用了不存在的 stop`);
    }
    if (suggestion.stopRef !== stopId) {
      errors.push(`relationshipSuggestions["${stopId}"].stopRef=${suggestion.stopRef} 与 key 不一致`);
    }
    if (suggestion.suggestedVisitRef !== null && trip.visits[suggestion.suggestedVisitRef] === undefined) {
      errors.push(`relationshipSuggestions["${stopId}"].suggestedVisitRef 指向不存在的 visit`);
    }
  }

  // ---- 7/8/9. 深度为一 + order 唯一 + 候选不重复占用 ----
  // 深度为一由类型结构保证：childStopRefs / alternateStopRefs 的成员只可能来自 stops 注册表，
  // Stop 上不存在子级引用字段；上文已校验这些 id 均真实存在于 stops（无 visit 混入）。
  // order 唯一且连续已由第 2/5 步的下标比对覆盖；容器唯一归属由 stopSeen / scheduleSeen 覆盖。

  // ---- 10. 时间轴可计算或明确待定：null 即待定态，结构合法（无需数值断言） ----
  // startTime / endTime / effectiveMinutes 的推导正确性由 timeline 模块与重算流程保证。

  // ---- 11. 攻略来源编组（修订附录 B v0.3）----
  const guideSources = trip.guideSources;
  if (guideSources !== undefined && guideSources !== null) {
    if (!isPlainObject(guideSources)) {
      errors.push("trip.guideSources 非法（契约要求为对象，允许为空对象）");
    } else {
      for (const [key, rawSource] of Object.entries(guideSources)) {
        if (!isPlainObject(rawSource)) {
          errors.push(`guideSources["${key}"] 不是合法来源对象`);
          continue;
        }
        const label = `guideSources["${key}"]`;
        const source = rawSource as unknown as GuideSource;

        if (source.sourceId !== key) {
          errors.push(`${label}.sourceId=${String(source.sourceId)} 与 key 不一致`);
        }
        if (typeof source.inputKind !== "string" || !GUIDE_INPUT_KINDS.has(source.inputKind)) {
          errors.push(`${label}.inputKind 非法：${String(source.inputKind)}`);
        }
        if (!Number.isInteger(source.sourceVersion) || source.sourceVersion < 1) {
          errors.push(`${label}.sourceVersion 须为 ≥1 的整数（当前 ${String(source.sourceVersion)}）`);
        }
        if (typeof source.status !== "string" || !GUIDE_SOURCE_STATUSES.has(source.status)) {
          errors.push(`${label}.status 非法：${String(source.status)}`);
        }
        if (typeof source.active !== "boolean") {
          errors.push(`${label}.active 须为布尔值`);
        }
        if (source.active === false && (typeof source.removedAt !== "string" || source.removedAt === "")) {
          errors.push(`${label} 已移除（active=false）但缺少 removedAt`);
        }
        if (typeof source.importedAt !== "string" || source.importedAt === "") {
          errors.push(`${label}.importedAt 缺失`);
        }
        if (typeof source.updatedAt !== "string" || source.updatedAt === "") {
          errors.push(`${label}.updatedAt 缺失`);
        }

        const evidenceRefs = Array.isArray(source.evidenceRefs) ? source.evidenceRefs : null;
        if (evidenceRefs === null) {
          errors.push(`${label}.evidenceRefs 缺失或非法（契约要求为字符串数组）`);
        } else {
          for (const evidenceId of evidenceRefs) {
            if (typeof evidenceId !== "string" || evidenceId === "") {
              errors.push(`${label}.evidenceRefs 存在非法 evidenceId：${String(evidenceId)}`);
            } else if (trip.evidences[evidenceId] === undefined) {
              errors.push(`${label}.evidenceRefs 引用了不存在的证据：${evidenceId}`);
            }
          }
        }

        const mentionRefs = Array.isArray(source.mentionRefs) ? source.mentionRefs : null;
        if (mentionRefs === null) {
          errors.push(`${label}.mentionRefs 缺失或非法（契约要求为字符串数组）`);
        } else {
          for (const ref of mentionRefs) {
            const parsed = parseMentionRef(ref);
            if (parsed === null) {
              errors.push(`${label}.mentionRefs 格式非法（须为 evidenceId:mentionId）：${String(ref)}`);
              continue;
            }
            if (resolveMentionRef(trip, ref) === null) {
              errors.push(`${label}.mentionRefs 无法定位原文：${ref}`);
              continue;
            }
            if (evidenceRefs !== null && !evidenceRefs.includes(parsed.evidenceId)) {
              errors.push(`${label}.mentionRefs 的证据未列入 evidenceRefs：${parsed.evidenceId}`);
            }
          }
        }

        validateGuideImageProgress(label, source, trip, errors);

        // Task #215 图片 OCR 延迟：待解析（pending）图是确定的等待状态而非失败，
        // 纯图上传 / 正文抽取失败的延迟来源允许在无任何可读证据时结算 ready / partial
        // （用户可随时触发「解析图片」补齐证据）。豁免要求确实存在 pending 待解析图，
        // 防止 deferred 标记残留误放行空来源。
        const deferredImages = (source as unknown as { imageProgress?: { images?: unknown[] } })
          .imageProgress?.images;
        const deferredPendingImages =
          source.imageOcrDeferred === true &&
          Array.isArray(deferredImages) &&
          deferredImages.some((entry) => isPlainObject(entry) && entry.status === "pending");

        if (
          source.status === "ready" &&
          !hasUsableGuideEvidence(trip, source) &&
          !deferredPendingImages
        ) {
          errors.push(`${label} 状态为 ready，但没有任何可读正文 / OCR 文本 / 提及证据`);
        }
        if (
          source.status === "partial" &&
          evidenceRefs !== null &&
          evidenceRefs.length === 0 &&
          !deferredPendingImages
        ) {
          errors.push(`${label} 状态为 partial，但没有任何成功保留的证据（应落为 failed）`);
        }

        if (source.hardScope !== undefined && source.hardScope !== null) {
          validateGuideScope(`${label}.hardScope`, source.hardScope, trip, errors, false);
        }
      }
    }
  }
  if (trip.guideDraftNote !== undefined && typeof trip.guideDraftNote !== "string") {
    errors.push("trip.guideDraftNote 须为字符串（缺失 = 无补充句）");
  }

  // ---- 12. 攻略草案快照（只校验可解析性；版本过期由应用阶段拒绝）----
  const draft = trip.pendingGuideDraft;
  if (draft !== undefined && draft !== null) {
    if (!isPlainObject(draft)) {
      errors.push("trip.pendingGuideDraft 非法（须为对象）");
    } else {
      if (typeof draft.draftId !== "string" || draft.draftId === "") {
        errors.push("pendingGuideDraft.draftId 缺失");
      }
      if (!Number.isInteger(draft.baseTripVersion) || (draft.baseTripVersion as number) < 1) {
        errors.push(`pendingGuideDraft.baseTripVersion 须为 ≥1 的整数（当前 ${String(draft.baseTripVersion)}）`);
      }
      validateGuideScope("pendingGuideDraft.scope", draft.scope, trip, errors, true);

      const snapshots = Array.isArray(draft.sourceSnapshots) ? draft.sourceSnapshots : null;
      if (snapshots === null) {
        errors.push("pendingGuideDraft.sourceSnapshots 缺失或非法（须为数组）");
      } else {
        for (const snapshot of snapshots) {
          if (!isPlainObject(snapshot)) {
            errors.push("pendingGuideDraft.sourceSnapshots 存在非法条目");
            continue;
          }
          if (typeof snapshot.sourceId !== "string" || snapshot.sourceId === "") {
            errors.push("pendingGuideDraft.sourceSnapshots 存在空 sourceId");
            continue;
          }
          // 只要求来源仍可解析；sourceVersion 与当前不一致属正常过期，不在加载时拒绝
          if (guideSources === undefined || guideSources === null || guideSources[snapshot.sourceId] === undefined) {
            errors.push(`pendingGuideDraft.sourceSnapshots 引用了不存在的来源：${snapshot.sourceId}`);
          }
          if (!Number.isInteger(snapshot.sourceVersion) || (snapshot.sourceVersion as number) < 1) {
            errors.push(`pendingGuideDraft.sourceSnapshots[${snapshot.sourceId}].sourceVersion 须为 ≥1 的整数`);
          }
        }
      }

      const mentionIds = Array.isArray(draft.mentionIds) ? draft.mentionIds : null;
      if (mentionIds === null) {
        errors.push("pendingGuideDraft.mentionIds 缺失或非法（须为数组）");
      } else {
        for (const mentionId of mentionIds) {
          if (typeof mentionId !== "string" || mentionId === "") {
            errors.push("pendingGuideDraft.mentionIds 存在空 mentionId");
            continue;
          }
          if (findMentionsById(trip, mentionId).length === 0) {
            errors.push(`pendingGuideDraft.mentionIds 无法在现有证据中解析：${mentionId}`);
          }
        }
      }

      if (draft.mentionRefs !== undefined && draft.mentionRefs !== null) {
        if (!Array.isArray(draft.mentionRefs)) {
          errors.push("pendingGuideDraft.mentionRefs 非法（须为字符串数组）");
        } else {
          for (const ref of draft.mentionRefs) {
            if (resolveMentionRef(trip, ref) === null) {
              errors.push(`pendingGuideDraft.mentionRefs 无法定位原文：${String(ref)}`);
            }
          }
        }
      }
      if (draft.note !== null && typeof draft.note !== "string") {
        errors.push("pendingGuideDraft.note 须为字符串或 null");
      }
      if (typeof draft.createdAt !== "string" || draft.createdAt === "") {
        errors.push("pendingGuideDraft.createdAt 缺失");
      }
    }
  }

  return errors;
}

// ===== 攻略契约校验辅助（修订附录 B v0.3） =====

const GUIDE_SOURCE_STATUSES: ReadonlySet<string> = new Set(["processing", "ready", "partial", "failed"]);
const GUIDE_INPUT_KINDS: ReadonlySet<string> = new Set(["link", "text", "images"]);
const GUIDE_IMAGE_STATUSES: ReadonlySet<string> = new Set(["pending", "processing", "ready", "failed", "skipped"]);
const GUIDE_CLAIM_KINDS: ReadonlySet<string> = new Set([
  "experience",
  "route_listing",
  "tip",
  "risk",
  "comparison",
  "reported_opinion",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 图片进度校验：计数与明细一致；成功图必须指向来源 evidenceRefs内的证据，
 * 失败图必须给 failureCode 或 failureMessage（支持刷新后重试剩余图片）。
 */
function validateGuideImageProgress(
  label: string,
  source: GuideSource,
  trip: Trip,
  errors: string[],
): void {
  const progress = (source as unknown as { imageProgress?: unknown }).imageProgress;
  if (!isPlainObject(progress)) {
    errors.push(`${label}.imageProgress 缺失或非法（契约要求持久化图片进度）`);
    return;
  }
  const total = progress.total;
  const completed = progress.completed;
  const failed = progress.failed;
  if (!Number.isInteger(total) || (total as number) < 0) {
    errors.push(`${label}.imageProgress.total 须为 ≥0 的整数`);
  }
  if (!Number.isInteger(completed) || (completed as number) < 0) {
    errors.push(`${label}.imageProgress.completed 须为 ≥0 的整数`);
  }
  if (!Number.isInteger(failed) || (failed as number) < 0) {
    errors.push(`${label}.imageProgress.failed 须为 ≥0 的整数`);
  }
  if (
    Number.isInteger(total) &&
    Number.isInteger(completed) &&
    Number.isInteger(failed) &&
    (completed as number) + (failed as number) > (total as number)
  ) {
    errors.push(`${label}.imageProgress completed + failed 超过 total`);
  }

  if (!Array.isArray(progress.images)) {
    errors.push(`${label}.imageProgress.images 缺失或非法（须为数组）`);
    return;
  }
  if (Number.isInteger(total) && progress.images.length !== total) {
    errors.push(
      `${label}.imageProgress.images 条数（${progress.images.length}）与 total（${String(total)}）不一致`,
    );
  }

  const seenIndexes = new Set<number>();
  let readyCount = 0;
  let failedCount = 0;
  for (const rawEntry of progress.images) {
    if (!isPlainObject(rawEntry)) {
      errors.push(`${label}.imageProgress.images 存在非法条目`);
      continue;
    }
    if (!Number.isInteger(rawEntry.index) || (rawEntry.index as number) < 1) {
      errors.push(`${label}.imageProgress.images 存在非法 index：${String(rawEntry.index)}`);
    } else if (Number.isInteger(total) && (rawEntry.index as number) > (total as number)) {
      errors.push(`${label}.imageProgress.images index 超出 total：${String(rawEntry.index)}`);
    } else if (seenIndexes.has(rawEntry.index as number)) {
      errors.push(`${label}.imageProgress.images index 重复：${String(rawEntry.index)}`);
    } else {
      seenIndexes.add(rawEntry.index as number);
    }

    if (typeof rawEntry.status !== "string" || !GUIDE_IMAGE_STATUSES.has(rawEntry.status)) {
      errors.push(`${label}.imageProgress.images 存在非法状态：${String(rawEntry.status)}`);
      continue;
    }

    if (rawEntry.status === "ready") {
      readyCount += 1;
      const evidenceId = rawEntry.evidenceId;
      if (typeof evidenceId !== "string" || evidenceId === "") {
        errors.push(`${label}.imageProgress 成功图片缺少 evidenceId`);
      } else if (trip.evidences[evidenceId] === undefined) {
        errors.push(`${label}.imageProgress 成功图片引用了不存在的证据：${evidenceId}`);
      } else if (!Array.isArray(source.evidenceRefs) || !source.evidenceRefs.includes(evidenceId)) {
        errors.push(`${label}.imageProgress 成功图片的证据未列入 evidenceRefs：${evidenceId}`);
      }
    } else if (rawEntry.status === "failed") {
      failedCount += 1;
      const hasCode = typeof rawEntry.failureCode === "string" && rawEntry.failureCode !== "";
      const hasMessage =
        typeof rawEntry.failureMessage === "string" && rawEntry.failureMessage.trim() !== "";
      if (!hasCode && !hasMessage) {
        errors.push(`${label}.imageProgress 失败图片缺少 failureCode / failureMessage`);
      }
    }
  }

  if (Number.isInteger(completed) && readyCount !== completed) {
    errors.push(`${label}.imageProgress.completed=${String(completed)} 与成功图片数 ${readyCount} 不一致`);
  }
  if (Number.isInteger(failed) && failedCount !== failed) {
    errors.push(`${label}.imageProgress.failed=${String(failed)} 与失败图片数 ${failedCount} 不一致`);
  }
}

/** 来源硬范围 / 草案作用域：dayIndex 或 visitId 必须落在当前 Trip 内 */
function validateGuideScope(
  label: string,
  rawScope: unknown,
  trip: Trip,
  errors: string[],
  allowTripScope: boolean,
): void {
  if (!isPlainObject(rawScope)) {
    errors.push(`${label} 缺失或非法（须为对象）`);
    return;
  }
  if (allowTripScope && rawScope.kind === "trip") return;
  if (rawScope.kind === "day") {
    if (
      !Number.isInteger(rawScope.dayIndex) ||
      (rawScope.dayIndex as number) < 1 ||
      (rawScope.dayIndex as number) > trip.dayRefs.length
    ) {
      errors.push(`${label}.dayIndex 超出行程范围（1-${trip.dayRefs.length}）：${String(rawScope.dayIndex)}`);
    }
    return;
  }
  if (rawScope.kind === "attraction") {
    if (typeof rawScope.visitId !== "string" || trip.visits[rawScope.visitId] === undefined) {
      errors.push(`${label}.visitId 指向不存在的 visit：${String(rawScope.visitId)}`);
    }
    return;
  }
  errors.push(`${label}.kind 非法：${String(rawScope.kind)}`);
}

/** GuideSnippet 校验：短文本硬上限、claimKind、1..3 条可解析 mention 引用 */
function validateGuideSnippets(label: string, raw: unknown, trip: Trip, errors: string[]): void {
  if (raw === undefined || raw === null) return;
  if (!Array.isArray(raw)) {
    errors.push(`${label}.guideSnippets 非法（须为数组）`);
    return;
  }
  const seenSnippetIds = new Set<string>();
  raw.forEach((rawSnippet, position) => {
    const itemLabel = `${label}.guideSnippets[${position}]`;
    if (!isPlainObject(rawSnippet)) {
      errors.push(`${itemLabel} 不是合法对象`);
      return;
    }
    if (typeof rawSnippet.snippetId !== "string" || rawSnippet.snippetId === "") {
      errors.push(`${itemLabel}.snippetId 缺失`);
    } else if (seenSnippetIds.has(rawSnippet.snippetId)) {
      errors.push(`${itemLabel}.snippetId 重复：${rawSnippet.snippetId}`);
    } else {
      seenSnippetIds.add(rawSnippet.snippetId);
    }
    if (typeof rawSnippet.text !== "string" || rawSnippet.text.trim() === "") {
      errors.push(`${itemLabel}.text 缺失`);
    } else if ([...rawSnippet.text].length > GUIDE_SNIPPET_MAX_CHARS) {
      errors.push(
        `${itemLabel}.text 超过硬上限 ${GUIDE_SNIPPET_MAX_CHARS} 字符（当前 ${[...rawSnippet.text].length}）`,
      );
    }
    if (typeof rawSnippet.claimKind !== "string" || !GUIDE_CLAIM_KINDS.has(rawSnippet.claimKind)) {
      errors.push(`${itemLabel}.claimKind 非法或缺失：${String(rawSnippet.claimKind)}`);
    }
    const refs = Array.isArray(rawSnippet.sourceMentionRefs) ? rawSnippet.sourceMentionRefs : null;
    if (refs === null || refs.length === 0) {
      errors.push(`${itemLabel}.sourceMentionRefs 至少需要 1 条原文提及`);
      return;
    }
    if (refs.length > GUIDE_SNIPPET_MAX_MENTION_REFS) {
      errors.push(`${itemLabel}.sourceMentionRefs 超过上限 ${GUIDE_SNIPPET_MAX_MENTION_REFS} 条`);
    }
    for (const ref of refs) {
      if (resolveMentionRef(trip, ref) === null) {
        errors.push(`${itemLabel}.sourceMentionRefs 无法定位原文：${String(ref)}`);
      }
    }
  });
}

/**
 * 一致性 warning 收集（rev2 住宿多候选，Task #80）：报告不阻断提交、不触发
 * applyOps 整批回滚的软性问题，供诊断与界面提示；与 validateConsistency（error 级）
 * 分离——applyOps / tripStore.save 只消费后者。
 *
 * 当前检查：hotelRegistry 孤儿条目（未被任何一天 LodgingPlan.hotelRefs 引用）。
 * 多候选模型下候选移除仅解除引用、registry 主数据保留，孤儿属合法中间态
 *（如全部候选被移除后的残留），保留无害，仅提示可清理。
 */
export function collectConsistencyWarnings(trip: Trip): string[] {
  const warnings: string[] = [];
  if (
    typeof trip.hotelRegistry !== "object" ||
    trip.hotelRegistry === null ||
    Array.isArray(trip.hotelRegistry)
  ) {
    return warnings; // registry 非法属 error 级，由 validateConsistency 报告
  }
  const referenced = new Set<string>();
  for (const plan of Object.values(trip.lodgings)) {
    if (!Array.isArray(plan.hotelRefs)) continue;
    for (const hotelId of plan.hotelRefs) referenced.add(hotelId);
  }
  for (const [hotelId, candidate] of Object.entries(trip.hotelRegistry)) {
    if (!referenced.has(hotelId)) {
      warnings.push(
        `hotelRegistry 孤儿条目：${candidate?.name ?? hotelId}（hotelId=${hotelId}）未被任何一天的候选列表引用，可清理`,
      );
    }
  }
  return warnings;
}
