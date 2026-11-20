/**
 * 从模型 finalText 中提取最后一个顶层平衡 JSON 值块（{...} 或 [...]）。
 *
 * 背景（2026-10-15 实测证据）：百炼 Managed Agent 的 SSE text 流存在间歇性
 * 用户输入回显——finalText 可能是「完整 prompt 回显 + 模型真实输出」拼接
 * （透传通道复现：finalText.startsWith(prompt) === true）。既有解析候选
 * 「首个 { → 末个 } 截取」会从回显 prompt 中的示例 JSON 开始，导致 F11
 * 两次真实调用全部解析失败。
 *
 * 本扫描器跳过字符串字面量内的括号，逐块记录回到深度 0 的完整块，
 * 返回最后一个——即位于回显之后的模型真实输出。无回显时行为与原候选一致。
 * 结果仍需经各调用方的结构归一化校验（normalizeOperationSet /
 * normalizeExtractedItem），模型输出一律不可信。
 */
export function lastBalancedJsonValue(text: string): string | null {
  let last: string | null = null;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" || ch === "]") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          last = text.slice(start, i + 1);
          start = -1;
        }
      }
    }
  }
  return last;
}
