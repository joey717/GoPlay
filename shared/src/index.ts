export * from "./types/index.js";
export * from "./areas/index.js";
// Task #325：地理计算模块（haversine / POI 片区归属 / 单日地理统计 / 容量评估）
export * from "./geo/index.js";
// Task #280：天角色派生（S10/S11 参赛必须）——deriveDayRoles 纯函数 + recomputeDerivedFields 钩子
export * from "./dayRoles/index.js";
// Task #233：POI 名称保守归一化 + 显式别名映射（前后端唯一数据源）
export * from "./poiAlias.js";
// Task #253：区域占位点位判定（自定义区域主题不作为指令锚点 / planner 候选 / 操作目标）
export * from "./areaPlaceholder.js";
// Task #283 / C4：AI 补充来源（provenance）展示文案与只读判定助手
export * from "./provenance.js";
// Task #329：免费场所（购物/免税类）判定 —— freePoiStatus 读时默认与三态口径
export * from "./freePoi.js";
// Task #330：飞猪 POI 元信息（poiLevel / listRank / description）读时默认与等级归一化
export * from "./poiMeta.js";
export * from "./guides/index.js";
export * from "./timeline/index.js";
export * from "./operations/index.js";
export * from "./consistency/index.js";
export * from "./guards/index.js";
export * from "./rejections/index.js";
