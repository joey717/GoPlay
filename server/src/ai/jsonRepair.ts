/**
 * 保守 JSON 结构修复（Task #42）。
 *
 * 背景（task40 夹具实测）：全量重排场景下模型输出损坏的根因是括号层级错误
 * （多条 plan 丢失 op 包裹导致碎片交错），不是 SSE 截断。这类交错碎片无法在
 * 不猜测业务字段归属（哪条 assign 属于哪个 plan、scope 是什么）的前提下安全
 * 重建，因此本模块明确不做碎片重组，此类输入必须整体拒绝。
 *
 * 本模块只提供两类可验证的纯语法修复，绝不猜测 itemId / dayIndex / scope /
 * 数值等业务字段，也绝不改写字符串字面量内容：
 *   A. 去除数组 / 对象末尾的多余逗号（含 EOF 处的悬空逗号）；
 *   B. 为 EOF 处未闭合的结构补齐关闭符——仅在两种「干净截断点」下生效：
 *      - 扫描结束时位于字符串字面量内部（补关闭引号后逐层闭合，字符串内容
 *        原样保留，截断只损失展示用 reason 尾部，无业务语义）；
 *      - 最后一个非空白字符是 } ] " 之一（刚结束一个完整值 / 容器 / 字符串）。
 *      EOF 落在数字、字面量（true/false/null 片段）、冒号或逗号之后时不修复
 *      ——数字截断（180→1）会产生看似合法但数值错误的字段，宁可拒绝。
 *
 * 所有修复候选必须由调用方重新 JSON.parse + normalizeOperationSet 校验，并
 * 经四条护栏（G1 拒绝缺失 order / 未知 itemId / 非法 scope）后才会落地；
 * 修复只提高解析率，不放宽任何语义校验。安全优先于修复率。
 */

/** 扫描状态：字符串感知，跳过字符串字面量内的括号与逗号 */
interface ScanState {
  /** 未闭合括号栈（"{" 或 "["），EOF 处按逆序补齐关闭符 */
  stack: string[];
  inString: boolean;
  escaped: boolean;
  /** 最后一个非空白且位于字符串外的字符；null 表示尚无 */
  lastSignificant: string | null;
}

function scanJson(text: string): ScanState {
  const state: ScanState = { stack: [], inString: false, escaped: false, lastSignificant: null };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (state.inString) {
      if (state.escaped) state.escaped = false;
      else if (ch === "\\") state.escaped = true;
      else if (ch === '"') state.inString = false;
      continue;
    }
    if (ch === '"') {
      state.inString = true;
      state.lastSignificant = ch;
      continue;
    }
    if (ch === "{" || ch === "[") state.stack.push(ch);
    else if (ch === "}" || ch === "]") state.stack.pop();
    if (!/\s/.test(ch)) state.lastSignificant = ch;
  }
  return state;
}

/** 修复 A：去除结构末尾的多余逗号（字符串外遇到后继为 ] } 或 EOF 的逗号） */
function removeTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (j >= text.length || text[j] === "]" || text[j] === "}") continue; // 丢弃悬空逗号
    }
    out += ch;
  }
  return out;
}

/** 修复 B：为 EOF 处未闭合结构补齐关闭符；截断点不干净时返回 null（不修复） */
function closeUnbalancedTail(text: string): string | null {
  const state = scanJson(text);
  const closers = state.stack
    .slice()
    .reverse()
    .map((opener) => (opener === "{" ? "}" : "]"))
    .join("");
  if (state.inString) {
    // 截断发生在字符串内部：补关闭引号后逐层闭合。悬空转义符（尾部单个 \）
    // 会把补上的引号转义导致 parse 失败，由调用方整体拒绝，此处不做内容改写。
    return text + '"' + closers;
  }
  // 仅在刚结束一个完整值 / 容器 / 字符串时闭合；EOF 落在数字、字面量片段、
  // 冒号或逗号后 → 可能产生半截数值字段，拒绝修复。
  if (state.lastSignificant === "}" || state.lastSignificant === "]" || state.lastSignificant === '"') {
    return closers.length > 0 ? text + closers : null;
  }
  return null;
}

/**
 * 生成保守修复候选（不改变原文本，只追加修复后的版本）。
 * 返回的每个候选仍须通过 JSON.parse + 结构归一化才算有效；全部无效即拒绝。
 */
export function repairJsonCandidates(finalText: string): string[] {
  const trimmed = finalText.trim();
  if (trimmed === "") return [];

  // 与解析主链路同源的基础候选：整体文本 + markdown code fence 内容
  const bases: string[] = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced && fenced.trim() !== "" && fenced.trim() !== trimmed) bases.push(fenced.trim());

  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => {
    if (value !== "" && !seen.has(value)) {
      seen.add(value);
      candidates.push(value);
    }
  };

  for (const base of bases) {
    // A：去悬空逗号（仅在产生变化时作为候选）
    const commaFixed = removeTrailingCommas(base);
    const commaChanged = commaFixed !== base;
    if (commaChanged) push(commaFixed);

    // B：补齐 EOF 未闭合结构（基于原文与去逗号后文本各试一次，组合覆盖）
    const closed = closeUnbalancedTail(base);
    if (closed !== null) push(closed);
    if (commaChanged) {
      const closedAfterCommaFix = closeUnbalancedTail(commaFixed);
      if (closedAfterCommaFix !== null) push(closedAfterCommaFix);
    }
  }

  return candidates;
}
