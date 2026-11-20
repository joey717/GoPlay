/**
 * 护栏 / 执行器拒绝原因的「用户可读映射」（Task #35 / Task #48）。
 *
 * 服务端返回的拒绝项格式为 `[guard] reason`（guard ∈ G1 / G3 / threshold；
 * 执行器自拒条目无前缀）。本模块把常见冲突映射为面向用户的一句话；
 * 未命中已知模式时保留原文（含 guard 标注），绝不吞掉原因。
 *
 * 覆盖的常见冲突：
 * - locked 项：已锁定的大景区/景点不可被 AI 改动；
 * - bought 项：已购票的 Visit / 住宿不可移除 / 转移；
 * - 非法目标：ref / dayIndex / order 不存在或越界、容器矩阵不匹配；
 * - Stop 越权：内部玩法不支持设置开始时间 / 购买 / 锁定 / 跨天移动；
 * - 归类纠正：待定加入、换景区（同天）；
 * - 整批拒绝：可操作引导文案（BATCH_REJECTION_GUIDANCE，不出现阈值数字）。
 */

/**
 * 整批拒绝（丢弃占比超阈值）的用户文案单点常量（Task #379 / 老队列 #324）。
 *
 * 口径：原因一句 + 可操作动作建议一句；不出现阈值数字等技术细节。
 * 消费面（共用本常量，避免两处文案漂移）：
 * - 本模块 describeRejection 的 threshold 分支（草案 / 意图两通道的拒绝明细）；
 * - server 意图通道整批拒绝响应的 message（用户提示主行）。
 */
export const BATCH_REJECTION_GUIDANCE =
  "本次改动涉及范围较大，被安全护栏整批拦截未生效。建议缩小单次改动范围，或拆成多条指令分步执行；已被锁定点位与已购项目不会被 AI 改动。";

/** 描述单条拒绝原因（输入为服务端原文，输出面向用户的一句文案） */
export function describeRejection(raw: string): string {
  const matched = raw.match(/^\[(G1|G3|threshold)\]\s*([\s\S]*)$/);
  const guard = matched?.[1] ?? null;
  const reason = (matched?.[2] ?? raw).trim();

  if (guard === "threshold" || reason.includes("30%")) {
    return BATCH_REJECTION_GUIDANCE;
  }
  if (reason.includes("内部玩法不支持设置具体开始时间")) {
    return "内部玩法不显示具体开始时间，只维护顺序、建议时长、位置提示和票务关系，该条未执行";
  }
  if (reason.includes("内部玩法不支持独立购买状态")) {
    return "内部玩法不支持单独购买，门票由大景区承担，该条未执行";
  }
  if (reason.includes("内部玩法不支持锁定")) {
    return "内部玩法不支持单独锁定，锁定跟随大景区整体生效，该条未执行";
  }
  if (reason.includes("内部玩法不支持跨天移动")) {
    return "内部玩法不能跨天移动；如需调整请移动大景区本身，该条未执行";
  }
  if (reason.includes("待定加入")) {
    return "待定加入的内部玩法须先由你确认归类，AI 不能自动挂入，该条未执行";
  }
  if (reason.includes("归类纠正") || reason.includes("换景区")) {
    return "内部玩法换景区属于归类纠正，不能改变所在日期，该条未执行";
  }
  if (reason.includes("已在备选玩法")) {
    return "该内部玩法已在备选玩法中，无需再次移除";
  }
  if (reason.includes("住宿专用")) {
    return "酒店移除或更换须走住宿专用流程，不套用点位候选池语义";
  }
  if (reason.includes("locked") || reason.includes("锁定") || reason.includes("已被锁定")) {
    return "该内容已锁定，AI 不会改动（如需调整请先手动解锁或明确指定）";
  }
  if (reason.includes("已购买") || reason.includes("已购") || reason.includes("bought")) {
    return "该内容已购票，不能被移除或转移（如行程有变，请走改订流程）";
  }
  if (reason.includes("已在全局候选区") || reason.includes("已在候选")) {
    return "该内容已在候选区，无需再次移除";
  }
  if (
    reason.includes("不存在") ||
    reason.includes("不在") ||
    reason.includes("越界") ||
    reason.includes("超出") ||
    reason.includes("非法") ||
    reason.includes("白名单") ||
    reason.includes("重复") ||
    reason.includes("不是") ||
    reason.includes("未排入")
  ) {
    return "AI 指向了行程中不存在或不合法的目标，该条未执行";
  }
  return guard !== null ? `[${guard}] ${reason}` : reason;
}

/** 批量映射并去重（整批拒绝时逐条原因相同，列表只展示一行） */
export function describeRejections(rawReasons: string[]): string[] {
  const seen = new Set<string>();
  const described: string[] = [];
  for (const raw of rawReasons) {
    const text = describeRejection(raw);
    if (seen.has(text)) continue;
    seen.add(text);
    described.push(text);
  }
  return described;
}
