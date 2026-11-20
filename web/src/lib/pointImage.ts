/**
 * Task #296：点位配图来源优先级纯函数（web 展示层统一口径）。
 *
 * PD 口径：飞猪有图的点位优先取飞猪主图（origin=fliggy 且 mainPic 非空，外链）；
 * 自定义点（custom）或飞猪记录无图的点位，才回退攻略 PX 页码关联原图（任务 196
 * resolveEntityPageImages 产物，受控 /api/uploads 路径）；两者皆无（或加载失败
 * 降级完毕）用统一占位 ImagePlaceholder，绝不空白。
 *
 * 与旧行为的差异（本任务修复的两个缺口）：
 * 1. 旧逻辑 PX 回退被 isCustom 门槛卡死——命中飞猪但飞猪无图的点位（真实数据中
 *    西岛墙/木门/歪脖子椰子树/临海公路/孤独的树等拍照线子点位）有 PX 关联图也
 *    不展示，直接掉占位；现改为「无飞猪图即回退 PX」，不再要求 custom。
 * 2. 旧逻辑飞猪外链图与 PX 图共用一个失败标志——外链图 onError 后连带禁掉 PX
 *    回退（直接占位）；现按来源分别记账（PointImageFailures），飞猪图失败仍可
 *    降级 PX 图，PX 图再失败才落占位。
 *
 * 纯函数零状态：失败标志由调用方组件以 useState 持有（渲染级、行级隔离），
 * 本模块只做「当前该渲染哪张图」的判定，可被 vitest 直接单测。
 */

import type { Item } from "@goplay/shared";

/** 点位配图的三种落点（判别联合，调用方按 kind 渲染） */
export type PointImage =
  /** 飞猪主图（外链，item.mainPic 原样作 img src） */
  | { readonly kind: "fliggy"; readonly src: string }
  /** 攻略 PX 页码关联原图（受控相对路径，渲染按 `/api/${assetPath}` 读取） */
  | { readonly kind: "guide"; readonly assetPath: string }
  /** 皆无 / 降级完毕：统一占位（ImagePlaceholder） */
  | { readonly kind: "placeholder" };

/** 各来源图片的加载失败记账（组件 state 持有；按来源独立，互不连带） */
export interface PointImageFailures {
  /** 飞猪外链图加载失败（onError）——触发降级 PX 攻略图 */
  readonly fliggyFailed: boolean;
  /** PX 攻略图加载失败（onError）——触发降级占位符 */
  readonly guideFailed: boolean;
}

/**
 * 飞猪主图取用口径：仅 origin=fliggy 且 mainPic 非空白才视为「飞猪有图」。
 * custom 点位按契约 mainPic 恒为 null（server 创建路径核实），此判定为防御性
 * 收紧——即使历史脏数据给 custom 点塞了 mainPic，也不冒充飞猪实图（无
 * 「飞猪实图」标注语义），按 PD 口径走 PX 回退链。
 */
export function fliggyMainPic(item: Item | null | undefined): string | null {
  if (item === null || item === undefined) return null;
  if (item.origin !== "fliggy") return null;
  const pic = item.mainPic;
  return typeof pic === "string" && pic.trim() !== "" ? pic : null;
}

/**
 * 解析点位当前应渲染的配图（优先级状态机）：
 * 1. 有飞猪图且未失败 → fliggy；
 * 2. 无飞猪图（custom / 飞猪记录无图）或飞猪外链加载失败 → 有 PX 关联图且未失败 → guide；
 * 3. 两者皆无 / 全部失败 → placeholder。
 */
export function resolvePointImage(
  item: Item | null | undefined,
  guideAssetPath: string | null,
  failures: PointImageFailures,
): PointImage {
  const fliggyPic = fliggyMainPic(item);
  if (fliggyPic !== null && !failures.fliggyFailed) {
    return { kind: "fliggy", src: fliggyPic };
  }
  if (guideAssetPath !== null && !failures.guideFailed) {
    return { kind: "guide", assetPath: guideAssetPath };
  }
  return { kind: "placeholder" };
}
