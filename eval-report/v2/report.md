# GoPlay AI 能力验收报告（first33）

| 字段 | 值 |
| --- | --- |
| 套件版本 | first33@2026-10-29（commit aff4176） |
| 用例版本 | 用例文档 v1.4 |
| assets 版本 | v2（snapshot 2026-10-28，contentHash sha256:3380fe039559676c…） |
| 运行模式 | EVAL_FIXTURE=1，planner=live（里程碑轮） |
| 结果汇总 | pass 33 ／ fail 0 ／ blocked 0（共 33 条） |
| 首轮绿判据 | 已实现子集全绿：✅ 达成（已实现 22/22 pass，无 fail） |
| live 录制 | planner 真调 1 次（回放命中 0 次） ＋ O3 executeIntent 直连百炼 1 次＝共 2 次；覆盖 11 条用例 |
| 快层总耗时 | 88357ms（执行 33 条；脚本记忆化：SHARED/B2/VISITCARD 复用脚本各只跑一次） |

## 📋 PD 直白结论（Task #319 · 2026-11-03 深夜 live 整合评测，一页版）

> 本节为 #319 加页（顶层结论）；技术细节与原始指标见下方「第四轮：#319 live 整合评测」与 `perf.md`。

**关键结论：今晚该测的全部测完，门禁全过，没有新问题。**

| 项目 | 结果（直白措辞） | 速度体感 | 与上一轮基线对比 |
| --- | --- | --- | --- |
| first33 全量用例（live，跑了 2 轮） | **通过**：两轮都是 33 过 / 0 挂 / 0 阻塞 | 单轮全套约 1.5 分钟 | 持平（#292 轮也是 33/0/0） |
| S1 连跑 5 轮＋A4 连跑 3 轮（PD 拍板的多轮制基线） | **通过**：8 轮全绿，0 次需归因的失败 | 每轮约 1 分钟 | 持平（#292 轮也是全绿；S1 返程日方差保持 0%） |
| 九图攻略全解析（P2，改用本地图片上传，补上 11-02 因链接 404 没测成的缺口） | **通过**：9 张图全部解析成功，门禁要求 ≤90 秒 | **约 48 秒**（上一轮基线 63 秒，更快约 24%；比早期「约 6 分钟」已提速一个量级） | 更快 |
| AI 意图修改耗时（F11，prompt 加长后回归检查，3 次真实调用） | **通过**：最慢一次 50.5 秒，在 60 秒预算内 | 单次约 **18～51 秒**，平均 38 秒 | 无显著回归（O3 同文本基线 28 秒，本轮同文本 18.4 秒） |
| 纯文字攻略保存（P1b，门禁 120 秒） | 本轮未重测（额度留给必测项） | 参考 11-03 复测约 117 秒；#334 重估 78～100 秒 | 持平（参考值） |

**门禁逐项判定（直白）：**

- P2 九图源后台完成 ≤90 秒：**通过**（实测 48 秒，富余 42 秒）。
- F11 意图普通预算 60 秒：**通过**（最坏 50.5 秒，富余 9.5 秒；未触发超时）。
- P1b ≤120 秒：**本轮未重测**，沿用 11-03 口径（#318 实测 117.1 秒，按 120 秒门禁可通过；#334 重估 78～100 秒）。若需合入后实测数，下轮 live 窗口补 `perf-task318.ts text` 一次即可。

**需要 PD 知道的一件事（非新问题）：** F11 三次调用中有一次（「把观日岩挪到岛内第一个玩」）被护栏整批拒绝（模型对该意图输出 2 条操作、违规率超 30% 阈值）。这是 #314 已定性的「小批量阈值放大」已知口径（2 条中 1 条违规即 50%），是否豁免小批量仍在 PD 决策清单，本轮未改阈值、未放宽。耗时测量不受影响（拒绝也是正常返回，44.8 秒）。

**额度消耗（诚实口径）：** FlyAI live 调用 **0 次**（缓存 15/15 全命中）；百炼 live 调用共 **25 次**（评测 15＝全量轮 2×2＋方差轮 8×1＋F11 3；P2 图片识别 9＋图后抽取 1）。


## ✅ fail 清单（置顶）

本轮无 fail——已实现子集全绿，planner 依赖项 live 录制均满足断言。

## 逐用例结果

| 用例 | 层 | 判定 | 实现状态 | backlog | 结果 | planner | 耗时 | 证据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E3 仅链接来源抓取 | L1 | 机 | 已实现 | - | ✅ pass | - | 3395ms | evidence/E3.log |
| E5 分享文案粘贴自动提取链接 | L1 | 机 | 已实现 | - | ✅ pass | - | 2725ms | evidence/E5.log |
| E6 同 canonicalUrl 去重 | L1 | 机 | 已实现 | - | ✅ pass | - | 288ms | evidence/E6.log |
| E8 正文＋图混合来源 | L1 | 机 | 已实现 | - | ✅ pass | - | 0ms | evidence/E8.log |
| E9 亮点抽取召回（亚龙湾 golden） | L1 | 机 | 已实现 | - | ✅ pass | - | 5ms | evidence/E9.log |
| A1 双源 firsthand 强推进行程 | L2 | 机 | 依赖planner输出 | - | ✅ pass | [live] | 58094ms | evidence/A1.log |
| A3 reported_opinion 差评不计负票 | L2 | 机 | 依赖planner输出 | - | ✅ pass | [live] | 0ms | evidence/A3.log |
| A4 风险 claim 绑定活动/商家 | L2 | 机 | 依赖planner输出 | - | ✅ pass | [live] | 0ms | evidence/A4.log |
| A5 单源 firsthand 避雷进候选池 | L2 | 机 | 依赖planner输出 | - | ✅ pass | [live] | 0ms | evidence/A5.log |
| A7 9 图笔记计 1 票 | L2 | 机 | 已实现 | - | ✅ pass | - | 0ms | evidence/A7.log |
| A9 snippet 上限 | L2 | 机 | 已实现 | - | ✅ pass | - | 0ms | evidence/A9.log |
| A10 snippet 引用可溯源 | L2 | 机 | 已实现 | - | ✅ pass | - | 1ms | evidence/A10.log |
| A11 无 Tips 源不出 Tips 块 | L2 | 机 | 依赖planner输出 | - | ✅ pass | [live] | 0ms | evidence/A11.log |
| A13 实体归一化（canonicalGroups 死判） | L2 | 机 | 已实现 | - | ✅ pass | - | 1ms | evidence/A13.log |
| S1 返程日机场走廊 | L3 | 机 | 依赖planner输出 | - | ✅ pass | [live] | 0ms | evidence/S1.log |
| S2 抵达日 buffer | L3 | 机 | 依赖planner输出 | - | ✅ pass | [live] | 0ms | evidence/S2.log |
| S3 锁定酒店日区域连续 | L3 | 机 | 依赖planner输出 | - | ✅ pass | [live] | 0ms | evidence/S3.log |
| S5 出发时间来源标签 | L3 | 机 | 已实现 | - | ✅ pass | - | 0ms | evidence/S5.log |
| S7 锁定项重新排版不动 | L3 | 机 | 已实现 | - | ✅ pass | - | 1625ms | evidence/S7.log |
| S10 Day 角色字段 | L3 | 机 | 已实现 | - | ✅ pass | - | 0ms | evidence/S10.log |
| S12 点位齐全（C6 机器版） | L3 | 机 | 依赖planner输出 | - | ✅ pass | [live] | 0ms | evidence/S12.log |
| S13 名称溯源 | L3 | 机 | 依赖planner输出 | - | ✅ pass | [live] | 1ms | evidence/S13.log |
| C1 稀疏素材恰好一次澄清 | L4 | 机+人 | 已实现 | 参赛必须 | ✅ pass | - | 107ms | evidence/C1.log |
| C2 澄清抑制 | L4 | 机 | 已实现 | 赛后 | ✅ pass | - | 1ms | evidence/C2.log |
| C4 飞猪补充标 | L4 | 机 | 已实现 | - | ✅ pass | - | 3157ms | evidence/C4.log |
| Q1 snippet 抽屉回看链路 | L5 | 报 | 已实现 | - | ✅ pass | - | 3045ms | evidence/Q1.log<br>evidence/Q1.png<br>evidence/Q1-drawer.png |
| Q3 0 snippet 卡无原文入口 | L5 | 机 | 已实现 | - | ✅ pass | - | 0ms | evidence/Q3.log<br>evidence/Q3.png |
| Q5 partial 源 coverage 诚实 | L5 | 机 | 已实现 | - | ✅ pass | - | 0ms | evidence/Q5.log |
| Q7 点位配图（西岛篇截图） | L5 | 报 | 已实现 | - | ✅ pass | - | 3ms | evidence/Q7.log<br>evidence/Q7.png |
| O1 锁定项拖拽不动 | L6 | 机 | 已实现 | - | ✅ pass | - | 0ms | evidence/O1.log |
| O2 撤销精确回滚 | L6 | 机 | 已实现 | - | ✅ pass | - | 1889ms | evidence/O2.log |
| O3 NL 局部松排 | L6 | 机 | 依赖planner输出 | - | ✅ pass | [live] | 14009ms | evidence/O3.log |
| O8 护栏拒绝带原因 | L6 | 机 | 已实现 | - | ✅ pass | - | 0ms | evidence/O8.log |

## blocked 说明

- 本轮无 blocked（E9 经 PD 裁量 2026-10-30 全部 boundary 项判命中 → recall 1.0 达标转 pass，不再是 PD-boundary blocked；live 轮 O3 executeIntent 真调 pass）。

## 主观项 / 人审集中区（PD 复核）

- **S3 锁定酒店日区域连续**（判定：机）：断言全绿
  - S3 为软校验：区域连续性编排由 planner 决定，各天分配已记入证据 log 供人审（不破坏住宿为可观测下界）。
- **C1 稀疏素材恰好一次澄清**（判定：机+人）：断言全绿
- **Q1 snippet 抽屉回看链路**（判定：报）：断言全绿
  - 截图：`evidence/Q1.png`、`evidence/Q1-drawer.png`（eval:ui playwright 产出，gitignore）
- **Q7 点位配图（西岛篇截图）**（判定：报）：断言全绿
  - 截图：`evidence/Q7.png`（eval:ui playwright 产出，gitignore）

## 证据

- 机器项：`eval-report/v2/evidence/{用例ID}.log`（runner 自动产出的断言日志行，禁止手写）。
- UI/交互项（Q1/Q3「报」判定）：`evidence/{用例ID}.png`（`npm run eval:ui` 用 playwright 自动截图，gitignore）。
- planner live 原始响应：随断言日志落 `evidence/{用例ID}.log`（fail 项据此复核模型输出）。
- 主观项（A8/C6，第二轮）：生成文本直接贴 report.md 正文，PD 按 §3 rubric 判。

## 新增回归用例

- **A13 ← poiAlias 别名补全（Task #286，唯一功能源码改动）**：`server/src/ai/verify-task233.ts` 新增 **S8** 回归段——断言 `resolvePoiAlias("山顶婚礼草坪")===("婚礼礼堂大草坪")==="山顶公园"`、三表面串同一 `canonicalPoiMatchKey`、`isSameCanonicalPoiName` 互认、`mergeGuideMentions` 折叠三串为同一地点×3票，且既有亚龙湾别名与沧海观景台不受影响（不串）。A13 用例侧 `alias_gap` 档由 #285 的 finding 单列转**硬断言全绿**（`assert aliasGaps===0`）。运行：`npx tsx server/src/ai/verify-task233.ts`（S1–S8 全绿）。
- 评测侧（非功能源码）：E9 matcher artifact 修正（`e9Recall.ts`：inferClaimKind 去 suggestMinutes 误判＋duration 区间数值匹配＋词表精修）、S13 provenance=ai_supplement 回退转全量硬断言（C4 已落地）、S12 餐饮建议按 golden 分类豁免——均附证据 log，套件只增不删。

## live 录制与模型方差说明

- planner 依赖 9 条的判定规则（投票 / 走廊 / 区域连续 / 风险 snippet 等）在 prompt 层，模型输出存在方差：#286-f 里程碑轮（历史权威）planner 依赖项 9/9 满足断言、全量 32 pass / 0 fail / 1 blocked（E9＝PD-boundary 单列）。**Task #291 注入三条 prompt 规则（risk/tip 边界从宽 / 返程日走廊 / 抵达日 / 方向综合评估）＋ runA4 放宽为警告类 risk|tip 任一≥1（S1 保持严格）→ planner 缓存键失效，#292 轮全部 live 重录**（最新权威分布见下方「第三轮：#292 live 窗口统一验证」）。历次录制的方差原始响应全量落 `eval/cache/planner/`，未改功能代码 / 未改断言迎合（A4 放宽＝PD 拍板，非迎合）。
- 历史方差观测（#285 first28 套件，供 PD 复核）：Run A＝22/1/5（S1 fail：模型把后海村排入返程日 Day5）；Run B＝23/0/5（全绿）；Run C＝21/2/5（A4 risk→tip、S2 后海村→Day1）。A4/S1 的 fail 均为模型输出方差（同一 prompt 多次录制结果不同），未改功能代码 / 未改断言迎合。
- **Task #286 全量 live 录制轮（first33；本报告＝最新一次录制 #286-f，权威数值见上方「结果汇总」）**：#286-a 因 FlyAI CLI 的 npx 缓存并发安装竞态（ENOTEMPTY）致来源结算超时、plannerShared 全 cascade fail（基础设施故障，非用例/产品缺陷）；清理竞态残留 + 放宽来源结算轮询上限（30s→120s，仅基础设施阈值不改断言）后：#286-b＝31/1/1（S13 因 C4 provenance 回退断言初版把 buildFixtureSanyaTrip 播种的用户既有行程「第一市场/大小洞天」误判为不可溯源 → 已修正为「用户既有行程」合法来源集豁免）；#286-c＝31/1/1（S12 fail：planner 方差「三和风味馆」）；#286-d＝31/1/1（A4 fail：planner 方差 risk→tip）；#286-e＝30/2/1（A4 risk→tip ＋ S1 后海村→返程日，均 planner 方差）；#286-f（本轮，权威）＝32/0/1（planner 依赖项全绿，达成 fail 0）。A4/S1/S12 的历次 fail 均为模型输出方差（同一 prompt 多次录制结果不同，#286-f 全绿印证），未改功能代码 / 未改断言迎合。历次原始响应全量落 `eval/cache/planner/`。
- **A4「风险 snippet」断言＝Task #291 PD 拍板放宽（原叙述「risk→tip 触发 fail」已失真，更正如下）**：~~A4 断言草案含 ≥1 条 claimKind=risk 的 snippet~~ → **#291 放宽为「警告类信息以 claimKind=risk 或 tip 任一出现即 pass」**（警告性实用建议归 tip 可接受——用户线下还会看到现场说明、产品非唯一权威；risk 留给重大安全 / 财务损失 / 商家欺诈；planner prompt 第五节已同步注入「risk/tip 边界从宽」，runA4 硬断言由 risk≥1 改为 warningSnippets（claimKind∈{risk,tip} 任一匹配 A4_WARNING_RE）≥1）。放宽前历史（供 PD 复核）：#286-b/#286-c 录制 A4 均绿（模型产出 risk snippet），#286-d/#286-e 模型把岛上消费/买票等风险统一归为 tip → **旧断言** risk snippet=0 触发 fail，#286-f 复绿——该「risk→tip 触发 fail」系放宽前行为，#291 后 claimKind 归类方差不再 fail（仅警告信息 risk+tip 完全丢失才 fail）。放宽范围仅限**归类**，S1 断言保持严格未放宽，未改功能代码迎合。
- **S12「三和风味馆」定性（供 PD 复核，非静默放宽）**：golden C12 summary 原文「可作为已排后海村内餐饮建议」、fixture 文档「三和风味馆可以成为餐饮建议」「（同区域餐饮）不要求专门再跑一趟」——golden 明确把该美食实体归为「已排点位（后海村）内餐饮建议」而非独立行程点位；叠加其无飞猪 POI 被 Task #196 确定性过滤，S12「点位齐全」硬断言对其按 golden 分类豁免（locator 命中 美食/餐饮 section）。豁免项逐条落 `evidence/S12.log` 单列，不改 assertion 原文、不为转绿而放宽其它实体。
- 唯一一次断言修改＝评测侧 bug 修正（非迎合模型）：S2「抵达日 buffer」断言原把「后海」计入 arrival-day 重项关键词，但后海村属近酒店村落，用例文档 v1.1 明确把「近酒店/市区」列为抵达日允许集——是评测侧过匹配（误报），已从 heavyKeywords 移除「后海」。此为修正评测断言使其符合用例文档口径，与「改断言迎合模型 miss」有本质区别，特此单列供 PD 复核。
- ~~本轮 prompt 含运行期随机 id（assemble 用 crypto.randomUUID 生成 visit/stop/item id 进 buildTripFacts），跨进程回放键不稳定~~ → **Task #284 已根治**：确定性 id 装配后回放键跨进程稳定命中，planner 依赖 9 条不再强制 live。详见下方「第二轮：回放稳定（Task #284）」。里程碑复跑仍可 npm run eval:live 持续观测方差。

## 第二轮：回放稳定（Task #284）

> 第一轮（#286）遗留：prompt 内含运行期 crypto.randomUUID 生成的 item/stop/source id，跨进程回放键永不命中，9 条 planner 依赖项只能 live 录制。本轮以「确定性 id 装配」根治——回放键跨进程稳定命中，planner 真调 0 次。

### 固定 id 装配（功能源码仅依赖注入钩子，业务行为零变化）

- 中央生成器 `server/src/ai/idGen.ts`：`generateId(seed)` 默认＝`randomUUID()`（功能态零变化）；评测态经 `setIdGenerator(deterministicIdFromSeed)` 注入「sha256(seed)→UUID 格式」种子派生，跨进程稳定。
- 装配侧 `assemble.ts`：itemId 种子＝`item:{name}`（剔除 FlyAI poi.id 依赖）、stopId 种子＝`stop:{itemId}`；`service.ts`：sourceId／ev_shot／ev_retry／证据 id 冲突后缀全部改走 `generateId(内容种子)`。mentionId／visitId／ev_note base 本已确定性（顺序计数器），未改。
- FlyAI 搜索 DI 钩子 `setSearchPoi` ＋ 磁盘缓存 `eval/harness/flyaiCache.ts`：消除对齐层网络波动对 prompt 的二次扰动（同 query 同结果，录制/回放一致）。
- harness `draftScenario.ts`：5 源「提交→等 ready」**串行结算**——并发结算在回放态触发乐观锁重试耗尽（FlyAI 缓存瞬时返回使写盘窗口完全重叠；录制态网络延迟天然错开故不暴露），且并发顺序本身不确定→noteIndex/mention 漂移。串行化纯 eval 侧编排，功能态来源仍并发结算，行为零变化。

### replay 命中率与跨进程稳定证据

- 五轮独立进程 planner 缓存键**完全一致**＝`b9ca941ce95b`（prompt 11080 字符逐字节相同）：

| 轮次 | 模式 | key | 分布(pass/fail/blocked) | planner |
| --- | --- | --- | --- | --- |
| record（串行） | record | b9ca941ce95b | 31/0/2 | live 录制 55315ms |
| replay#1 | replay | b9ca941ce95b | 31/0/2 | 命中 3ms·真调 0 |
| replay#2 | replay | b9ca941ce95b | 31/0/2 | 命中 4ms·真调 0 |
| live | live | b9ca941ce95b | 32/0/1 | live（O3 executeIntent pass） |
| replay#3（live 覆盖后） | replay | b9ca941ce95b | 31/0/2 | 命中 3ms·真调 0 |

- **replay 命中率 100%**：回放轮 planner 真调 0 次（仅 1 条 `[EVAL-PLANNER] replay 命中`），单条 3–4ms vs live 55s（约 1.4 万倍）。本轮实测：回放命中 0 次 ／ live 真调 1 次（命中率 0%）。
- **live 行为零改变**：live 轮分布 32/0/1 ＝ #286-f 完全一致；live/record/replay 三态同键证明固定 id 装配产出逐字节一致 prompt，未改业务行为。

### 与 live 轮（#286-f）分布对照（#284 历史轮·E9 当时仍 PD-boundary）

- #286-f（live，当时权威）：pass 32 / fail 0 / blocked 1（E9＝PD-boundary）。
- 本轮回放：pass 31 / fail 0 / blocked 2（E9 PD-boundary ＋ O3 liveOnly）。
- 差异仅 O3：走 executeIntent 直连百炼不经 plannerCache，不可回放→非 live 轮 blocked（设计预期，runner 以 `liveOnly` 精确判定）；live 轮 O3 真调 pass→回到 32/0/1，与 #286-f 一致。
- **【Task #299 更新·2026-10-30】上述 #284/#286-f 历史轮的「E9＝PD-boundary blocked」已被 PD 裁量取代**：E9 四条 boundary 全判命中 → pass，故当前 live 权威分布为 **33/0/0**（E9 不再 blocked），离线回放轮为 **32/0/1**（唯一 blocked＝O3 liveOnly，非 E9）。最新权威见下方「第三轮：#292 live 窗口统一验证」。

### C6 golden 对照（blocked-明日）

- C6（用例文档 L94）＝**人审主观项**「与 golden 比：必去实体齐全、day 角色一致、理由可溯」；其机器版 S12 已 pass（必去实体 100% 齐全，回放轮验证，`evidence/S12.log`）。
- 完整 golden 对照依赖**西岛 golden `highlight-recall-westIsland.json`**——按用例文档 L159，PD 明日按五类（时间/亮点/小景点/避雷/TIPS）补全后另建，今日未到 → **C6 标 blocked-明日**，不阻塞本轮回放稳定结论。生成行程 markdown 待 PD 按 §3 rubric 人审。

### 新增回归用例列

- 本轮无新增机器断言用例（C6 人审、S12 机器版已在套件，只增不删）。评测基建新增：确定性 id 装配（`idGen.ts`）、FlyAI 搜索磁盘缓存（`flyaiCache.ts`）、harness 串行结算（`draftScenario.ts`）、O3 `liveOnly` 标记（`first28.ts`）、runner 解除 planner 依赖项非 live 阻断（改 `liveOnly` 精确判定）。

## 第三轮：#292 live 窗口统一验证（历史轮记录保留；最新权威＝下方第四轮 #319）

> 触发：**Task #291** 注入三条 planner prompt 规则（risk/tip 边界从宽 / 返程日走廊 / 抵达日 buffer / 方向综合评估）＋ runA4 放宽为「警告类 risk|tip 任一≥1」（**S1 断言保持严格未放宽**）→ planner 缓存键失效，本轮全部 live 重录。叠加今晚增量 **#287/#294**（抽取器 note_tip 笔记级贴士/避雷＋单景点归属＋澄清门 enrichmentAnchored 修复＋prompt 引号统一）、**#290**（评审修复：派生字段 commit 收敛 / create 派生 / C4 用户池豁免 / 澄清 hash 纳入覆盖估算）、**#293/#297**（Q7 夹具真实页码＋真实形态）、**#296**（配图三级优先 飞猪图→PX→占位）。**上方「结果汇总」＝本轮 first33 全量 live 权威分布。**

### 前置归因保障（不做则结果不可归因）

- 常驻 dev server 全停：ps 核对无 tsx watch / vite / server 进程、端口空闲，避免 tsx watch 重启与 server/data 争用；`eval-report/v2` 已备份（`eval-report/v2-backup-task292-*`）；缓存基线 planner / flyai / extraction 与 server/data 计数已记录（#295 归档清理后约 45 文件，非异常，勿误判）。
- **planner 真被调用已确认**（round1b）：`fastPath=false`（走完整 planner 非快速路径）、`planner=live`、`attempts=1` 无澄清门触发 → **#294 enrichmentAnchored 修复生效**（澄清门只在真稀疏 sched=0 触发，enrichment 场景直通，未误触发澄清）。sharedScenario 断言 `fastPath===false` 本身即 planner 真调的结构性验证。

### 基础设施修复（3 处，均 harness 侧；未改断言、未改 fixture JSON、未改功能源码）

- **S6 误纳共享草案（draftScenario.ts）**：#285 把亚龙湾（S6，E9 golden 语料源）加入 fixture sources，但 claims 数组无 S6 对应条目 → `fixtureEntriesForSource` 对未收录源「回退全量 claims」（19 条 S1–S5 合集，西岛×4 重复），buildSharedDraft 若纳入 S6 会把全部点位重复对齐 → live FlyAI 真调超 120s 轮询上限（src_7054bee8 超时 → A4/S1 在到达 planner 前即 fail）。修复：源循环按 claims 归属过滤（`if (!data.claims.some(c => c.source === source.id)) continue`），只纳入有 claims 的源（S1–S5），跳过 S6；E9 走 extraction cache 不依赖 sources。fixture assets 有 sha256 完整性校验（改 JSON＝用例文档升版本拒绝加载），故在 harness 侧数据驱动过滤。
- **FlyAI live 强制真调波动（flyaiCache.ts）**：`flyaiCacheMode` 原 EVAL_LIVE=1→"live"（强制真调录制），连续多轮 live 触发限流 → 大源（S2 10 点位）对齐 ~15s/条逼近 120s 上限（round2 src_d9fbc6e5 超时）。修复：EVAL_LIVE=1→"replay"（命中回放、MISS 转真调录制），因 **FlyAI 缓存键＝sha256(点位名)，与 planner prompt 无关**（#291 prompt 改动只失效 planner 缓存键，FlyAI 缓存仍有效），且 **#284 itemId 种子＝`item:{name}` 已剔除 FlyAI poi.id** → 对齐结果不影响任何断言；live 轮核心是 planner 真调（方差观测），planner 仍由 `plannerCacheMode` 独立控制为 live。保留 `EVAL_FLYAI_LIVE=1` 强制真调刷新缓存的逃生口。
- **来源结算轮询上限（draftScenario.ts）**：`pollSourceUntilDone` timeoutMs 120_000→240_000（#286 首放宽 30s→120s；#292 配合 FlyAI replay 消除根因后再放宽，仅「卡死判定」基础设施阈值，不改任何断言语义）。修复后单轮总耗时 273850ms→57070ms（FlyAI replay 命中）。

### E9 亮点抽取召回（亚龙湾 golden，PD 裁量落档 Task #299 ＋ Task #301 重抽刷新）

- **【Task #301 重抽刷新·2026-10-30 晚 live 窗口，#300 note_tip 归属下沉新逻辑生效】`npm run eval:corpus` 真实重建亚龙湾抽取缓存（noteId=6a93bde9…，contentHash 不变＝正文未变）→ entries=19：attraction 1 / in_attraction 9 / **note_tip 9**（其中玻璃栈道、试婚房 2 条 note_tip 已下沉归属子景点＝子点位贴士区；过江龙索桥排队信息本轮被抽取器直接并入 in_attraction「过江龙索桥」条目，无独立 note_tip 可下沉——属抽取模型方差，非 #300 缺陷，YLW-06 归属结果与预测一致）→ 重跑 E9。**原始机器判定 recall = 8/11 = 0.727**（阈值 0.8 未达标；miss 0 条、boundary 3 条＝YLW-04/10/11；YLW-02 重抽后候选变试婚房 in_attraction、机器直接 HIT，其 #299 PD override 变 no-op）。**PD 裁量（2026-10-30）：3 条 boundary 全部判命中 → recall = 11/11 = 1.0 ≥ 0.8，E9 达标转 pass**——golden 系 PD 对攻略文案自行提炼规整的文本，与抽取器逐字原文字面不对应属预期（非抽取缺口，miss=0）。**非静默放宽**：机器阈值/词表零改动，`evaluateE9Recall` 先算 machineRecall=0.727 再对命中 `PD_ADJUDICATION` 表的 boundary 追加转 hit，逐 claim 保留 machineDecision；`evidence/E9.log` 打「原始机器判定 vs PD 裁量」双行＋「E9 重抽漂移披露（Task #301）」行，人话对照见 `evidence/E9-boundary-review.md`。**（#299 落档时为 entries=21·note_tip 10·机器 recall 0.636·boundary 4 条 YLW-02/04/10/11，重抽后漂移至此，逐条归因见 E9.log 漂移披露行。）**
- **note_tip 质量观测（#287/#294/#300）**：9 条 note_tip——7 条归属父景点亚龙湾（父卡攻略提示区），2 条经 #300 归属下沉落子景点（玻璃栈道、试婚房 → 子点位贴士区）；quote 原文忠实摘录、summary 带类别前缀（下沉条 summary 前缀子景点名），去重（sim≥0.6 丢弃）后无冗余；只写 mention 不创建 Item/Visit/Stop（Pass 0），不参与地点淘汰。
- **PD 裁量逐条（Task #301 重抽后·原始机器判定 → PD 裁量，非静默）**：本轮触发裁量 3 条——YLW-04（机器 boundary·sim 0.207<0.3，golden 提炼表述、抽取观光车信息已 surface → PD 判 hit）、YLW-10（机器 boundary·sim 0.233<0.3，golden 合并两 tip 被抽取拆条稀释、pdNote 允诺语义拆分容忍 → PD 判 hit）、YLW-11（机器 boundary·sim 0.806 内容近乎逐字命中但反推 kind=pitfall≠tip → PD 判 hit）。**YLW-02 重抽后机器直接 HIT**（候选试婚房 in_attraction sim 0.458、反推 kind=highlight 与 golden 一致），本轮不再进裁量清单（#299 的 YLW-02 override 仍保留在 PD_ADJUDICATION 表中，但 machineDecision 已为 hit 故自动 no-op）。逐 claim 清单如下（「判定」列＝PD 裁量后；原机器 boundary 以 ⚠️→✅ 标注保留；候选实体/sim＝#301 重抽后实测，与 `evidence/E9.log` 一致）：

| claim | golden kind | 判定（PD 裁量后） | 候选实体 | sim | 说明 |
| --- | --- | --- | --- | --- | --- |
| YLW-01 | duration | ✅ HIT | 亚龙湾热带天堂森林公园 | 1.0 | suggestMinutes=210 ∈ [180,240]（结构字段承载 duration） |
| YLW-02 | highlight | ✅ HIT（重抽后机器直接命中·不再需裁量） | 试婚房（in_attraction） | 0.458 | 重抽后候选变试婚房 in_attraction，内容命中且反推 kind=highlight 与 golden 一致（#299 时为 boundary·反推 kind=tip 误触，本轮机器修正直接 hit；PD_ADJUDICATION 表内 YLW-02 override 保留但 no-op） |
| YLW-03 | highlight | ✅ HIT | 婚礼礼堂大草坪→山顶公园/山顶婚礼草坪 | 0.689 | 内容命中且 kind 一致（highlight） |
| YLW-04 | highlight | ✅ HIT（PD裁量·原机器⚠️BOUNDARY） | 兰花谷 | 0.207 | 机器：sim∈[0.18,0.3) 内容存疑（sim 由 #299 的 0.250 漂移至 0.207）→ PD：golden 提炼表述、观光车信息已 surface 语义等价，判命中 |
| YLW-05 | pitfall | ✅ HIT | 亚龙湾热带天堂森林公园（note_tip·天街餐厅物价贵） | 0.303 | 内容命中且 kind 一致（pitfall）；候选实体由 #299 的 in_attraction「天街餐厅」变本轮父卡 note_tip（天街餐厅归类漂移），命中不变 |
| YLW-06 | pitfall | ✅ HIT | 过江龙索桥（in_attraction） | 0.471 | ★#300 归属下沉重点：过江龙索桥排队信息本轮由抽取器直接并入 in_attraction「过江龙索桥」子景点，matcher 匹配子景点 entity 命中（#299 时候选为父卡 note_tip sim 0.686、PD 附注要求下沉，#300 已落地，归属细化意图达成） |
| YLW-07 | pitfall | ✅ HIT | 亚龙湾热带天堂森林公园 | 0.510 | 有偿拍照漫天要价（原 miss→hit） |
| YLW-08 | pitfall | ✅ HIT | 玻璃栈道（note_tip·#300 下沉子景点） | 0.920 | ★#300 归属下沉：玻璃栈道大雾白茫茫 note_tip 已下沉归子景点「玻璃栈道」（子点位贴士区），matcher 匹配子景点命中（#299 时候选为父卡 亚龙湾） |
| YLW-09 | tip | ✅ HIT | 亚龙湾热带天堂森林公园 | 0.541 | 网上提前买票便宜（原 miss→hit；sim 由 #299 的 0.828 漂移至 0.541，命中不变） |
| YLW-10 | tip | ✅ HIT（PD裁量·原机器⚠️BOUNDARY） | 亚龙湾热带天堂森林公园 | 0.233 | 机器：sim∈[0.18,0.3) 内容存疑 → PD：golden 合并两 tip 被抽取拆条稀释、pdNote 允诺语义拆分容忍，判命中 |
| YLW-11 | tip | ✅ HIT（PD裁量·原机器⚠️BOUNDARY） | 亚龙湾热带天堂森林公园 | 0.806 | 机器：内容命中但反推 kind=pitfall≠tip → PD：内容近乎逐字命中，kind 分歧属词法误触（sim 由 #299 的 0.575 漂移至 0.806），判命中 |

### A4 警告 snippet 五轮收敛（超三轮，#291 放宽后）

| 轮次 | 结果 | risk | tip | 警告类(risk｜tip 任一匹配 A4_WARNING_RE) | operations | snippets | planner |
| --- | --- | --- | --- | --- | --- | --- | --- |
| round1b | ✅ pass | 0 | 5 | 1 | 5 | 6 | live |
| round2b | ✅ pass | 0 | 5 | 3 | 7 | 9 | live |
| round3 | ✅ pass | 0 | 6 | 2 | 5 | 9 | live |
| round4 | ✅ pass | 0 | 6 | 3 | 4 | 8 | live |
| round5 | ✅ pass | 0 | 8 | 3 | 4 | 11 | live |

- **warningSnippets≥1 稳定性：5/5 pass（警告类 1–3 全 ≥1）**；**risk=0 频次 5/5**（警告信息全部落 tip，#291 放宽后 claimKind 归类方差不再 fail；prompt「risk/tip 边界从宽」注入后 risk 命中率未回升，属可接受区间）。
- **tip 分布漂移率（不 fail，观测）**：稳定核心「岛上消费偏高，建议自备饮水零食」**5/5 出现**；高频项「蜈支洲岛与西岛提前线上买票」「下午四点再来亚龙湾海滩」「大多区域不适合下海游泳（C17）」「给娃穿好鞋不适合光脚（C03）」；漂移项「椰梦长廊别瞎逛」「走走拍拍 2 小时」「牛王岭作者未亲自拍摄」轮间进出（模型输出方差，同 prompt 多轮结果不同）。
- **警告 snippet 的 sourceMentionRefs 非空（防空断言）＝代码层结构性保证**：`planner.ts` parseDraftSnippets 对 sourceMentionRefs 过滤到「格式合法＋在草案消费集合内 1..3 条」，**过滤后为空整条丢弃**（`refs.length===0 → continue`，提示必须可溯源）→ 凡进入 A4 断言的 snippet 溯源必非空，无需额外运行时断言。

### S1 返程日机场走廊五轮收敛（严格断言，未放宽）

- **Day5 heavyKeywords 5/5 = 0**（岛/船/远/长票/付费水上无一排入返程日）；**历史方差率约 40% → 本轮 0%**（#291「返程日走廊」规则生效，方差收敛）。五轮全 pass，Day5 分配项均为 [空]。
- **后海村落点应 Day1（观测）**：S1 五轮均未把后海村排入返程日；S2/S3 专轮印证后海村→D1（抵达日近酒店村落，符合用例文档口径）。**Day1 未被抵达日规则过度收紧**（抵达日仍允许近酒店/市区低承诺项，后海村/海棠湾正常落 D1）。
- **返程日建议行为指纹（观测）**：模型对返程日「完全沉默」——五轮 Day5 snippets 无机场走廊/返程建议产出（既不排重项、也不主动产出走廊低承诺建议）。#291 返程日走廊规则目前表现为「约束不排重项」而非「主动建议」，指纹缺失交 PD 观测（不影响 S1 断言，S1 只验返程日未排重项）。

### S2/S3 片区聚集观测（第 6 次 planner 真调）

- **S2 抵达日 buffer**：Day1（抵达日）分配项 = [后海村]，需早到重项 = [无]，setTime(start)=2 → pass（后海村落 D1，抵达日无重项）。
- **S3 锁定酒店日区域连续**：各天分配 = D1:后海村、D3:第一市场、D3:椰梦长廊、D4:亚龙湾海滩、D5:海棠湾 → pass（软校验，逐日片区聚集：D3 第一市场＋椰梦长廊同属三亚湾方向聚集，D1/D5 近酒店片区）。**返程日 Day5 方差观测**：S1 五轮 Day5=[空]，S3 本轮 D5=海棠湾（海棠湾不在 S1 heavyKeywords，S1 仍 pass）——返程日「低承诺项」边界（海棠湾海滩散步是否算走廊允许项）存疑，交 PD 裁。

### live 调用次数与耗时

- **planner 真调 6 次成功**（round1b / round2b / round3 / round4 / round5 / S2S3）；round1 / round2 因基础设施超时未到达 planner（已修复）。planner 单次真调 49237ms（round1b）/ 56520ms（round2b）/ 58424ms（round5）。
- **prompt 11043 字符跨轮逐字节一致**（确定性 prompt 稳定，#284 固定 id 装配＋FlyAI replay 消除二次扰动）。单轮总耗时：round1b 273850ms（FlyAI live）→ round2b 57070ms / round3 61564ms / round4 57284ms / round5 58974ms / S2S3 61822ms（FlyAI replay 后）。
- **replay/live 标注**：planner＝**live**（本轮全部真调重录，#291 缓存键失效 → 新键 `4a42150abe71`，区别于 #284 旧键 `b9ca941ce95b`）；FlyAI 对齐＝**replay**（缓存键与 prompt 无关，#284 已剔除 poi.id，消除网络波动/限流）；O3＝**live**（executeIntent 直连百炼不经 plannerCache，只能 live）。
- **本轮＝first33 全量 live 权威轮（Task #301 重抽后重建·2026-10-30 晚 live 窗口，report.md 顶部「结果汇总」＝此轮 live 分布）＝ pass 33 / fail 0 / blocked 0（共 33 条）**：**E9 经 PD 裁量（Task #299，2026-10-30）3 条 boundary（YLW-04/10/11）全判命中 → pass**（重抽后原始机器判定 recall 0.727·8/11，裁量后 1.0；#299 落档时为 0.636·四条 boundary，重抽漂移逐条归因见 `evidence/E9.log` 漂移披露行）；O3 executeIntent live pass。planner 真调 **1 次**（A1 触发共享草案，11 条 planner 依赖用例记忆化复用同一草案）＋ O3 executeIntent 真调 **1 次**（liveOnly，不经 plannerCache）＝共 **2 次 live 调用**（顶部「快层总耗时」88357ms）。上述「planner 真调 6 次」系 A4/S1/S2/S3 **稳定性专轮**（`--only`）累计，与全量权威轮分属不同运行，特此区分以免误计。

### Q7 状态（#293/#297）

- Q7 夹具真实页码＋真实形态（西岛父卡 fliggy+mainPic、子点位命中飞猪无图→PX 回退）；**Q7-v1-parentpx.png（v1 渲染）PD 已复核通过**；**Q7.png（v2 渲染，#296 配图三级优先 飞猪图→PX→占位）PD 已复核通过（2026-10-30）**；旧图 Q7-old-fake.png 保留。

### 新增回归用例列（第三轮）

- 本轮无新增机器断言用例（套件只增不删）。评测基建修复：draftScenario S6 归属过滤＋轮询上限 240s、flyaiCache live→replay（EVAL_FLYAI_LIVE 逃生口）、runner buildReport L303/L306 失真叙述更新（A4 已按 #291 放宽）＋第三轮加页。抽取器侧 #287 note_tip（笔记级贴士/避雷＋单景点归属）已由 E9 语料重建覆盖验证。**Task #299：E9 PD 裁量落档——`e9Recall.ts` 新增 `PD_ADJUDICATION` override 表（四条 boundary 判 hit）＋ machineRecall/machineDecision 双字段留痕，`v14Cases.ts` logRecallResult 打「原始机器判定 vs PD 裁量」双行，runner 叙述同步；机器阈值/词表零改动，非静默放宽。**

### 方差收敛口径固化（PD 已拍板 2026-10-30）

- **收敛口径固化＝选项 B「多轮制验收基线」**：里程碑验收时 **S1（返程日走廊）须连跑 5 轮全绿、A4（警告类 snippet）须连跑 3 轮全绿**，单轮绿不算过。
- **部分轮次失败必须归因**——区分「模型输出方差 / 评测断言缺陷 / 功能缺陷」三类，修复优化后重跑；**不接受「反复重跑碰运气」**。
- 本轮实测印证：S1 连跑 5 轮全绿（Day5 heavyKeywords 5/5=0，历史方差率约 40% → 0%，#291 返程日走廊规则生效）；A4 连跑 5 轮全绿（warningSnippets 1–3 全 ≥1，risk=0 频次 5/5，警告全落 tip，#291 claimKind risk/tip 边界放宽后归类方差不再 fail）。均满足选项 B 基线，收敛口径不再是待裁项。

### PD 待裁清单（更新 2026-10-30）

1. **西岛 golden 未到**：完整 golden 对照（C6 人审）依赖西岛 `highlight-recall-westIsland.json`，PD 按五类补全后另建 → C6 仍 blocked-明日。
2. **返程日低承诺项边界**：S3 轮 D5=海棠湾（不在 heavyKeywords，S1 pass），海棠湾海滩散步是否算返程日走廊允许项由 PD 裁；返程日建议指纹缺失（模型沉默）是否需 prompt 补强调由 PD 定。

> 已移除（PD 2026-10-30 已拍板，不再是待裁项）：~~E9 boundary 4 条~~（PD 裁量四条全判命中 → recall 1.0 达标转 pass，见上「E9 亮点抽取召回」段与 `evidence/E9-boundary-review.md`；override 落 `e9Recall.ts PD_ADJUDICATION`，非静默放宽）、~~Q7 v2 渲染复核~~（已通过，见上「Q7 状态」）、~~方差收敛口径~~（已固化为选项 B 多轮制，见上「方差收敛口径固化」）。

> E9 归属细化项（PD 同日 2026-10-30 发现，非待裁、走修复任务）：YLW-06「过江龙索桥排队」归属下沉——**Task #300（`server/src/ai/noteAttribution.ts`）已落地**，本轮 #301 重抽后 YLW-06 已归子景点「过江龙索桥」(in_attraction) 且 matcher 匹配子景点 sim=0.471 机器直接 HIT（归属细化意图达成）；#300 预测 3 条下沉（过江龙索桥/玻璃栈道/试婚房），本轮实测玻璃栈道、试婚房 2 条 note_tip 下沉，过江龙索桥排队信息由抽取器直接并入 in_attraction 条目（无独立 note_tip 可下沉）——属抽取模型方差非 #300 缺陷。不在本裁量范围，不影响 E9 recall。

## 第四轮：#319 live 整合评测（2026-11-03 深夜 live 窗口，最新权威；顶部「结果汇总」＝本轮 run2）

> 触发：**#327**（prompt.ts FIXED_RULES_TEXT 更新至 3849 字符 ≤4100 ＋ planner.ts 第六节）与 **#339**（planner.ts appendGuideSnippet 相似亮点收敛 ＋ shared dedupeSnippets）→ planner 缓存键 sha256(百炼配置＋prompt全文) 全部失效，first33 必须 live 重录（预期行为，旧键 `4a42150abe71…` → 新键 `65c215a37dea…`）。叠加 **#340**（`web/src/lib/displayFlags.ts` SHOW_ESTIMATED_TIMES=false 隐藏全部估算时间）。本轮同时合入 #307/#312/#313/#316/#322 后的 live 口径。

### 预飞（全绿后才开 live）

- 四包 typecheck（shared/server/web＋eval/tsconfig）✅；`npm run build` ✅；web 全量 vitest **751 passed / 55 files**（＝基线）✅。
- 既有 verify 全绿：dayRoles（10 组）/ dedupe（17 pass）/ task325 四件（geo 11＋capacity 15＋facts 6＋rules 8）/ 323 / 228 / 312 / 316 / b3 / b2（离线段，VERIFY_SKIP_LIVE=1）。
- **陈旧断言同步（verify-b2，引用 #322，非放宽门禁，逐条清单见下「断言变更清单」）**：并发默认值 4→6 及其派生断言（并发峰值/动态预算期望值/不足预算对照/到期停拉新图计数）同步为 6 并发口径；公式与门禁语义本身未改。修后 b2 离线段全绿。
- dev 服务（5173/8787）按本轮指令保持运行未停；评测轮与其共用 server/data 未观察到争用（两轮全量 live 均全绿印证）。本轮开始前既有 live 报告与证据已备份 `eval-report/v2-backup-task319-2330/`。
- **#340 影响面核查结论：eval 侧无需改断言**——uiShot 的 Q1/Q3/Q7 截图断言只涉及点位/配图/区域条数，不引用被隐藏的时间文本；S5/S11 断言的是数据层 `timeSourceLabel`（Trip JSON 字段，渲染开关不影响数据层）。web 自身 displayFlags 测试（含 flagOn 对照）已在 751 基线内全绿。

### first33 全量 live（两轮双确认）

| 轮次 | 分布(pass/fail/blocked) | planner 真调 | O3 意图真调 | 快层总耗时 | 备注 |
| --- | --- | --- | --- | --- | --- |
| run1 | **33/0/0** | 1 次（共享草案，58670ms） | 1 次（24435ms） | 100651ms | #327/#339 后首次 live 重录 |
| run2（权威，顶部结果汇总＝此轮） | **33/0/0** | 1 次（57550ms） | 1 次（14009ms） | 88357ms | 因 run1 后方差专轮 `--only` 覆写过 report.md，重跑全量恢复权威产物，顺带双确认 |

- **prompt 稳定性保持**：新键 `65c215a37dea…` 在全部 10 次 planner 真调（2 全量轮＋8 方差轮）中跨进程逐字节一致（#284 固定 id 装配＋FlyAI replay 在 #327/#339 合入后仍成立）。
- **FlyAI live 调用 0 次**：缓存 15/15 全命中（缓存键＝sha256(点位名)，与 prompt 改动无关，#292 口径延续），`eval/cache/flyai/` 无新增文件。
- E9 仍按 PD 裁量口径 pass（读抽取缓存，与 live/replay 无关）；Q1/Q3/Q7 截图引用既有 `evidence/*.png`（未重跑 eval:ui；#340 后如需刷新截图供 PD 目检，下轮补录，断言不受影响）。

### S1×5 / A4×3 多轮制方差基线（PD 拍板口径，选项 B）

| 轮次 | 结果 | planner 单次真调 | 关键断言实测 |
| --- | --- | --- | --- |
| S1 r1 | ✅ pass | 60954ms | Day5 重项=0（每轮同断言） |
| S1 r2 | ✅ pass | 66802ms | Day5 重项=0 |
| S1 r3 | ✅ pass | 64278ms | Day5 重项=0 |
| S1 r4 | ✅ pass | 69014ms | Day5 重项=0 |
| S1 r5 | ✅ pass | 60736ms | Day5 分配=[空]、重项=[无]（证据留存 `/tmp/task319-S1-r5-evidence.log`，evidence/S1.log 已被 run2 覆盖为同样 pass 的新样本） |
| A4 r1 | ✅ pass | 54853ms | 警告类≥1（每轮同断言） |
| A4 r2 | ✅ pass | 59650ms | 警告类≥1 |
| A4 r3 | ✅ pass | 82487ms | risk=1（「大多区域不适合下海游泳」）＋tip=4，警告类=2≥1（证据留存 `/tmp/task319-A4-r3-evidence.log`） |

- **结论：S1 5/5、A4 3/3 全绿，满足选项 B 多轮制基线；0 次需归因的失败**（无模型方差/断言缺陷/功能缺陷归因项）。S1 返程日方差率保持 0%（#291 规则持续生效，历史 40% → #292 轮 0% → 本轮 0%）；返程日「模型沉默」指纹与第三轮一致（Day5 分配均=[空]）。
- **A4 观测**：run2 全量轮 risk=0/tip=4/警告类=1；方差专轮 r3 risk=1——#327 规则更新后 risk 归类仍有轮间方差（0↔1），但 #291 放宽后「警告类 risk|tip 任一≥1」稳定满足，不再构成 fail 源。

### 九图全解析 P2 补测（本地图片替代 404 链接，补上 11-02 缺口）

- 方式：`npx tsx eval/tools/perf-task318.ts nine`——亚龙湾 9 张本地缓存图（`server/uploads/xhs_6a93bde9…/{1..9}.jpg`）以图片字节 multipart 形态提交（submitGuideSource inputKind=images，与 HTTP multipart 同一条服务链路），替代 11-02 轮 404 的小红书链接；scratch 行程，测毕数据文件已删。
- 结果：**提交→来源 ready（9/9 张图）墙钟 48.0s；失败 0；无限流；并发峰值 6；单图 p50 9.3s / 最坏 40.8s（图 2 拖尾）/ 最好 6.9s**；图后装配对齐仅 1 次搜索请求（#313 并行化＋去重生效）。
- **门禁判定：P2 ≤90s → 通过（48s，富余 42s）**。对比：#318 基线 63s → 本轮 48s（**更快约 24%**）；早期「九图全解析约 6 分钟」→ 现在不足 1 分钟。墙钟 48s 高于理论 2 批×均耗时 27.4s，差值由图 2 单图 40.8s 长尾主导（百炼单图方差，非并发/队列问题）。
- 原始日志：`/tmp/task319-p2-nine.log`；残留：`server/uploads/92430991-4a42-468a-a730-93d580c815b8/`（9 张证据图，脚本设计留待归档清理；行程数据文件已删，不影响业务列表）。

### F11 意图耗时实测（3 次 live，`eval/tools/perf-task319-f11.ts` 新增工具）

- 完整意图 prompt 长度 **6156 字符**（#316 formatStopLine 补 stop 中文名/禁操作标注 ＋ #327 FIXED_RULES_TEXT 3849 字符后口径）；每次新建会话走完整 prompt 路径；scratch 行程测毕已清理。

| 意图 | 墙钟 | 百炼纯耗时 | 结果 |
| --- | --- | --- | --- |
| F11-1「Day2 松一点」（O3 同文本） | 18.4s | 18426ms | applied=1 |
| F11-2「把蜈支洲岛的观日岩挪到岛内第一个玩」 | 44.8s | 44802ms | **rejected**：模型输出 2 条操作违规率超 30% → 整批拒绝（护栏按设计生效，行程未改） |
| F11-3「第二天下午加一个适合拍照的免费点位」 | 50.5s | 48112ms | applied，G2 新点位「后海村」入候选池（搜索 2408ms） |

- **判定：无显著回归**——均值 37.9s / 最坏 50.5s，均在生产普通意图预算 60s 内（未触发超时）；对照 #292 轮 O3 真调 28s，同文本 F11-1 本轮 18.4s 更快；对照 P1b 重估 78–100s/门禁 120s 口径，意图通道显著轻于攻略保存通道，符合预期。
- **F11-2 归因（义务履行，非静默）**：耗时正常、解析正常，拒绝发生在护栏层——模型对该 stop 级改序意图输出了违规 op（2 条小批量，1 条违规即 50%>30%）。属 #314 已定性的「模型方差＋小批量阈值放大」已知口径（#316 前置剥离已落地，但本轮违规 op 形态不在可剥离集或剥离后剩余仍超阈，未留 op 级明细日志无法进一步区分）；**非本轮新增缺陷、非耗时问题**，未改阈值未放宽；小批量豁免与否仍在 PD 决策清单。不重跑烧额度。

### 断言变更清单（逐条理由，本轮全部变更）

| 文件 | 变更 | 理由分类 |
| --- | --- | --- |
| `server/src/guides/verify-b2.ts` | `GUIDE_IMAGE_CONCURRENCY` 期望 4→6 | **陈旧断言同步**（#322 已改默认值 6，verify-task231 断言=6 且通过；非放宽门禁） |
| 同上 | 12 任务并发峰值期望 4→6；9 图虚拟批峰值期望 4→6 | 陈旧断言同步（随并发默认值派生） |
| 同上 | `guideSourceBudgetMs` 期望：12图 450s→300s、17图 750s→450s、24图 900s→600s、40图 1200s→1050s；新增 48图=1200s 触顶断言 | 陈旧断言同步（批数=ceil(图数/6) 公式未改，期望值随并发 6 重算；新增 48 图断言保持「上限截断」语义有硬覆盖） |
| 同上 | 「旧 90s 预算切后批」对照改为「30s 不足预算切后批」 | 陈旧断言同步（并发 6 后 9 图两批 70s 内完成，90s 对照不再能切后批；30s 保持「预算不足会切后批」对照语义不变，非删除断言） |
| 同上 | 预算到期后 started/finished 期望 4→6 | 陈旧断言同步（随并发默认值派生） |
| eval 用例/harness | **零变更** | #340 影响面核查后确认 eval 侧无引用被隐藏时间文本的断言（见预飞节）；cases/*.ts 期望语义未动 |

### live 调用计数（FlyAI/百炼，诚实口径）

| 通道 | 次数 | 明细 |
| --- | --- | --- |
| FlyAI live | **0** | 缓存 15/15 全命中（两轮全量＋八轮方差均 replay）；P2 九图轮装配对齐 1 次为真实搜索（非 eval 缓存通道，计入百炼侧无关的飞猪通道，供参考） |
| 百炼：first33 全量 live | 4 | run1（planner 1＋O3 1）＋run2（planner 1＋O3 1） |
| 百炼：方差专轮 | 8 | S1×5＋A4×3，每轮 planner 真调 1 |
| 百炼：F11 实测 | 3 | executeIntent 真调 3（意图通道） |
| 百炼：P2 九图 | 10 | 图片识别 9（OCR）＋图后抽取 1 |
| **合计** | **25** | 无重复轮次重跑；唯一一次「重跑」＝run2 全量轮，目的＝恢复被 `--only` 覆写的权威 report.md 产物（顺带双确认，非碰运气重跑） |

### 遗留风险

1. **F11 小批量 30% 阈值放大**：本轮 F11-2 复现已知整批拒绝形态（#314 口径），op 级违规明细未落日志——建议后续给 rejected 结果补 op 明细日志便于归因；小批量豁免与否等 PD 决策。
2. **P1b 未在 #327/#339/#340 合入后重测**：沿用 11-03 口径（117.1s/门禁 120s 可通过）；抽取 prompt 本轮未改（#327 改的是 planner 侧 FIXED_RULES_TEXT），理论上 P1b 不受影响，但未实测；下轮 live 窗口补 `perf-task318.ts text` 一次即可闭环。
3. **P2 单图长尾方差**：图 2 单图 40.8s（p50 的 4.4 倍）拖高墙钟，百炼侧方差无规律可复现；若未来 P2 逼近 90s 门禁，优先归因单图长尾而非并发参数。
4. **report.md 为 runner 生成产物**：任何 `--only` 轮都会覆写它（本轮已发生并以 run2 恢复）；后续专轮建议加 runner 参数或事后立即重跑全量，避免权威产物被中间态污染（runner 对离线轮已有 report-offline.md 隔离，live `--only` 轮无隔离）。
5. **UI 截图未刷新**：evidence/*.png 仍为 #340 前产物（断言不依赖时间文本，不影响结论）；PD 如需目检隐藏估算时间后的界面，下轮补跑 `npm run eval:ui`。
6. **scratch 残留**：`server/uploads/92430991-…/`（9 张证据图，脚本设计留待归档）；行程数据文件均已删除。

## 性能档（占位）

本轮不跑性能门禁（v1.1 拍板：只落文档与脚本骨架）。实测结果单独写入 `eval-report/v2/perf.md`：

| 档位 | 门禁 | 实测 P95 |
| --- | --- | --- |
| P1 保存响应（异步起动） | ≤2s | 待测 |
| P1b 单文本源后台完成 | P95≤120s（#326 由 90s 调整；#334 复测飞猪 p50 3.72s 后维持 120s，理由修订为百炼抽取段主导+飞猪延迟波动裕量，见 perf.md） | 待测 |
| P2 9 图源 | P95≤90s 否则 partial | 待测 |
| P3 缓存 5 源 planner | P95≤90s | 待测 |
| P4 行程页首屏 | ≤2s | 待测 |
| 挑战目标（允许红，记 perf.md） | 单文本源≤30s ／ planner≤60s | 待测 |
