/**
 * Task #42 回归验证（离线：无模型调用、不触网、不创建行程文件）：
 *   1. 分级超时识别：isFullReplanIntent 对真实全量重排意图命中（90s 预算）；
 *      单日 / 局部 / 移除类意图不误报（保持 60s）；
 *   2. 保守 JSON 修复（可安全修复类，修复后仍须过 normalizeOperationSet；
 *      样本为 v1.1 EntityRef/ContainerRef 形状的 Stop 级 move）：
 *      - EOF 悬空逗号 → 去除后解析成功；
 *      - EOF 干净截断（完整条目后缺闭合符）→ 补闭合后解析成功；
 *      - 字符串字面量内截断 → 补关闭引号后解析成功（仅损失展示用 reason 尾部）；
 *      - 合法 JSON 不产生修复候选（修复只兜底，不多事）；
 *   3. 保守 JSON 修复（必须拒绝类，安全优先于修复率）：
 *      - EOF 落在数字后（toOrder 可能被截断 10→1）→ 不修复，整体失败；
 *      - 截断在 key 上（补引号后 JSON 仍非法）→ JSON.parse 失败，整体失败；
 *      - 语法可修复但语义非法（孤儿条目缺 op 字段）→ 归一化拒绝，整体失败；
 *   4. v1.1 专项（inline 样本，替代已删除的旧 fixtures/task40 目录）：
 *      - 两条 op 间缺逗号的括号交错损坏 → 解析为 null（不猜测碎片归属）；
 *      - baseVersion 缺失 → 解析成功且归一为 0（由 baseVersion 乐观锁门槛整批拒绝）；
 *      - 合法 v1.1 样本解析后 subjectRef.kind === "stop" 且不误判全量重排。
 *
 * 运行：npx tsx server/src/ai/verify-task42.ts
 */

import assert from "node:assert/strict";
import type { Operation } from "@goplay/shared";
import { isFullReplanIntent, parseOperationSet } from "./pipeline.js";
import { repairJsonCandidates } from "./jsonRepair.js";
import { isFullPlanBatch } from "./planScope.js";

/** v1.1 合法 OperationSet（Stop 级 move，形状与 fixtures/v11/stop-reorder.txt 一致） */
const VALID_V11_SET =
  '{"baseVersion":1,"operations":[{"op":"move","subjectRef":{"kind":"stop","id":"stop_rock"},"containerRef":{"kind":"visit","id":"visit_wzz"},"toOrder":0,"reason":"同日改序"}],"unplaced":[],"proposedNew":[],"clarify":null}';

/** v1.1 move 操作公共前缀（subjectRef=stop 实体，containerRef=visit 容器） */
const MOVE_PREFIX =
  '{"op":"move","subjectRef":{"kind":"stop","id":"stop_rock"},"containerRef":{"kind":"visit","id":"visit_wzz"}';

function pass(name: string): void {
  console.log(`✓ ${name}`);
}

async function main(): Promise<void> {
  // ---- 1. 分级超时识别（原始意图关键词 → 90s / 60s） ----
  {
    const fullReplanIntents = [
      "全部重排行程",
      "重新排一版整个行程",
      "帮我把五天的行程全部重新安排一遍",
      "整体重新规划这个行程",
      "把整个行程从头排一遍",
    ];
    for (const intent of fullReplanIntents) {
      assert.equal(isFullReplanIntent(intent), true, `「${intent}」应识别为全量重排（90s 预算）`);
    }
    const narrowIntents = [
      "把Day2重新安排一下",
      "把整个行程的Day2改到上午出发",
      "把Day2的景点全部移除",
      "全部锁定",
      "帮我把情人桥挪到Day3",
      "",
    ];
    for (const intent of narrowIntents) {
      assert.equal(isFullReplanIntent(intent), false, `「${intent}」不应识别为全量重排（保持 60s）`);
    }
    pass("分级超时识别：5 条真实全量重排意图命中 90s；单日/局部/移除意图不误报");
  }

  // ---- 2. 保守修复：可安全修复类（v1.1 opSet 形状） ----
  {
    // 2a. EOF 悬空逗号：顶层末尾 ",}" → 去除后解析成功
    const trailingComma = `${VALID_V11_SET.slice(0, -1)},}`;
    assert.ok(parseOperationSet(trailingComma) !== null, "悬空逗号应经修复解析成功");
    pass("修复 A（悬空逗号）：EOF 处 ',}' 去除后解析成功（v1.1 opSet 形状）");

    // 2b. EOF 干净截断：完整 stop-reorder 条目之后缺失闭合符 → 补齐后解析成功
    const truncatedTail = `{"baseVersion":1,"operations":[${MOVE_PREFIX},"toOrder":0,"reason":"先去观日岩看海"}]`;
    assert.ok(repairJsonCandidates(truncatedTail).length > 0, "干净截断应产生修复候选");
    const repairedTail = parseOperationSet(truncatedTail);
    assert.ok(repairedTail !== null, "干净截断应经补闭合解析成功");
    assert.equal(
      (repairedTail.operations[0] as Extract<Operation, { op: "move" }>).subjectRef.kind,
      "stop",
      "补闭合后操作形状不受影响",
    );
    pass("修复 B（EOF 补闭合）：完整条目后的缺失闭合符补齐后解析成功，subjectRef.kind=stop 保持");

    // 2c. 字符串字面量内截断：补关闭引号后解析成功（仅损失展示用 reason 尾部）
    const truncatedString = `{"baseVersion":1,"operations":[${MOVE_PREFIX},"toOrder":0,"reason":"调整顺`;
    const repairedString = parseOperationSet(truncatedString);
    assert.ok(repairedString !== null, "字符串内截断应经补引号解析成功");
    assert.match(
      (repairedString.operations[0] as { reason: string }).reason,
      /^调整顺/,
      "字符串内容应原样保留",
    );
    pass("修复 B（字符串截断）：补关闭引号后解析成功，字符串内容未被改写");

    // 2d. 完全合法的文本不产生修复候选（修复只兜底，不多事）
    assert.deepEqual(repairJsonCandidates(VALID_V11_SET), [], "合法 JSON 不应产生修复候选");
    pass("修复无副作用：合法 v1.1 JSON 不进入修复候选");
  }

  // ---- 3. 保守修复：必须拒绝类（安全优先于修复率） ----
  {
    // 3a. EOF 落在数字后：数值可能被截断（如 toOrder 10→1），拒绝修复
    const truncatedNumber = `{"baseVersion":1,"operations":[${MOVE_PREFIX},"toOrder":1`;
    assert.deepEqual(repairJsonCandidates(truncatedNumber), [], "数字截断不应产生修复候选");
    assert.equal(parseOperationSet(truncatedNumber), null, "数字截断必须整体失败");
    pass("拒绝数字截断：EOF 落在数字后不修复，避免产生看似合法的错误数值");

    // 3b. 截断在 key 上：补引号后 JSON 仍非法，parse 失败
    const truncatedKey = `{"baseVersion":1,"operations":[${MOVE_PREFIX},"toOrd`;
    assert.equal(parseOperationSet(truncatedKey), null, "key 截断必须整体失败");
    pass("拒绝 key 截断：补引号后仍非法，候选被 JSON.parse 淘汰");

    // 3c. 语法可修复但语义非法：孤儿条目（缺 op 字段）不得被放行
    const orphanEntry =
      `{"baseVersion":1,"operations":[${MOVE_PREFIX},"toOrder":0,"reason":"r"},` +
      '{"kind":"stop","id":"stop_beach"}],}';
    assert.equal(parseOperationSet(orphanEntry), null, "缺 op 的孤儿条目必须被归一化拒绝");
    pass("拒绝孤儿条目：修复仅到语法层，缺 op 的条目被 normalizeOperationSet 拒绝");
  }

  // ---- 4. v1.1 专项（inline 样本，替代已删除的旧 fixtures/task40 目录） ----
  {
    // 4a. 括号交错损坏（两条 op 之间缺逗号，对应真实 full-replan-3 的碎片形状）→ 整体 null
    const interlaced =
      '{"baseVersion":1,"operations":[\n' +
      `${MOVE_PREFIX},"toOrder":0,"reason":"先去观日岩看海"}\n` +
      '{"op":"move","subjectRef":{"kind":"stop","id":"stop_beach"},"containerRef":{"kind":"visit","id":"visit_wzz"},"toOrder":1,"reason":"再去海滨浴场"}\n' +
      '],"unplaced":[],"proposedNew":[],"clarify":null}';
    assert.equal(
      parseOperationSet(interlaced),
      null,
      "括号交错（缺逗号）碎片必须解析为 null，不得输出错误操作",
    );
    pass("v1.1 坏样本不被错误执行：两条 op 间缺逗号的交错碎片维持整体拒绝 → AI_PARSE_FAILED");

    // 4b. baseVersion 缺失 → 归一为 0（必然与任何行程版本不符，由乐观锁门槛整批拒绝）
    const noBaseVersion =
      `{"operations":[${MOVE_PREFIX},"toOrder":0,"reason":"改序"}],"unplaced":[],"proposedNew":[],"clarify":null}`;
    const parsedNoVersion = parseOperationSet(noBaseVersion);
    assert.ok(parsedNoVersion !== null, "baseVersion 缺失不应阻断解析（归一为 0）");
    assert.equal(parsedNoVersion.baseVersion, 0, "baseVersion 缺失应归一为 0");
    pass("v1.1 baseVersion 缺失：解析成功且归一为 0，落地前由 baseVersion 门槛整批拒绝");

    // 4c. 合法 v1.1 样本：EntityRef/ContainerRef 形状正确 + 不误判全量重排
    const legal = parseOperationSet(VALID_V11_SET);
    assert.ok(legal !== null, "v1.1 合法样本应可解析");
    assert.equal(legal.baseVersion, 1);
    assert.equal(legal.operations.length, 1);
    assert.equal(legal.operations[0].op, "move");
    const legalMove = legal.operations[0] as Extract<Operation, { op: "move" }>;
    assert.equal(legalMove.subjectRef.kind, "stop", "v1.1 Stop 级操作 subjectRef.kind 应为 stop");
    assert.equal(legalMove.containerRef.kind, "visit", "v1.1 Stop 改序容器应为 visit（childStopRefs 内排序）");
    assert.ok(!isFullPlanBatch(legal.operations), "Stop 级 move 不得误判为全量重排");
    pass("v1.1 合法样本：EntityRef(subjectRef.kind=stop) + ContainerRef(visit) 解析正确，不误判全量");
  }

  console.log(`\n[verify] Task #42 全部通过 ✓（离线运行，未创建任何行程文件）`);
}

main().catch((error) => {
  console.error("[verify] 失败：", error);
  process.exitCode = 1;
});
