# eval/case-mapping.md — 首轮 33 条用例实现映射（Task #275 T1 建档，Task #285 同步 v1.4）

- 用例版本：用例文档 **v1.4**（2026-10-28）｜ assets：**eval/assets/v2**（2026-10-28 快照，含 E9 golden v1.1）
- 套件：`eval/cases/first33.ts` FIRST33（runner 默认 `--suite=first33`）＝ v1.4 §5「首轮 33 条」权威清单
- 核实方式：逐条对照代码（不凭猜测）；关键核实点见文末「代码核实记录」
- 绿判据（v1.1 拍板，沿用）：**首轮绿 ＝ 已实现子集全绿**；依赖planner输出项回放/live 就绪后转绿；未实现项 blocked 带 backlog 标签
- 状态分布（首轮 33 条）：**已实现 19 ／ 依赖planner输出 9 ／ 未实现 5**（未实现中参赛必须 C1/C4 → Task #278，赛后 C2/E10 类跟踪；详见下表）

## v1.4 §5 首轮 33 条构成核对（与文档逐条对）

首轮清单（文档 line 156 逐条枚举，标「首轮＝是」者，共 33 条）：
`E3 E5 E6 E8 E9 · A1 A3 A4 A5 A7 A9 A10 A11 A13 · S1 S2 S3 S5 S7 S10 S12 S13 · C1 C2 C4 · Q1 Q3 Q5 Q7 · O1 O2 O3 O8`

- v1.3 新增 E9/A13/S12/S13（+C7），v1.4 新增 Q7；首轮范围 28→32→33。
- **FIRST33 按 §5 id 清单显式选取**（`first33.ts FIRST33_IDS`），天然排除下列两条 v1.4 标「首轮＝否」者：
  - **S11**（锚点变更同操作重算，L3/机）：v1.2 新增、Task #281 **已实现**，但文档标「首轮＝否（随 #278 转绿入回归）」——保留在 `first28.ts FIRST28` 数组（29 条）作转绿回归基线，**不计入首轮 33**。
  - **C7**（自定义景点误判，L4/机）：v1.3 新增、文档标「首轮＝否」——**未实现**（依赖 C4 provenance 路径，见下），仅在本文档标注状态，**不进可运行套件**。
- 故 `FIRST28` 数组（29 条，含 S11）去掉 S11 恰为 28 条 ＝ §5 33 条减去 v1.4 新增 5 条（E9/A13/S12/S13/Q7），逐条吻合。

## 映射表（首轮 33 条 ＋ S11/C7 状态标注）

| 用例ID | 层 | 判定 | 首轮 | 实现状态 | backlog | 复用脚本或新建 |
| --- | --- | --- | --- | --- | --- | --- |
| E3 | L1 | 机 | 是 | 已实现 | - | 复用 `server/src/guides/verify-b2.ts`（链接源状态机、classifyLinkFailure failureCode、retryGuideSource 重试） |
| E5 | L1 | 机 | 是 | 已实现 | - | 复用 web vitest（NoteInput `XHS_URL_PATTERN` 分享文案提链 + `api/client.extractUrl`） |
| E6 | L1 | 机 | 是 | 已实现 | - | **新建内联**（`submitGuideSource.duplicate` 真实链路，烟雾已绿）＋ 复用 `shared/src/verify-guides.ts`（findDuplicateGuideSource 纯函数） |
| E8 | L1 | 机 | 是 | 已实现 | - | 复用 `server/src/guides/verify-b2.ts`（text+images 混合提交 → 1 源、逐图证据合并） |
| **E9** | **L1** | **机** | **是** | **已实现** | **-** | **新建内联**（`eval/harness/e9Recall.ts` 召回纯函数：抽取缓存 entries vs golden expectedClaims，bigram Dice 语义命中＋canonicalGroups 实体归一）＋ `eval/tools/build-corpus.ts` 慢层缓存（`npm run eval:corpus`）。**慢层依赖：缓存已建（亚龙湾 6a93bde9），本套件内不触网；重跑慢层全量留 Task #286** |
| A1 | L2 | 机 | 是 | 依赖planner输出 | - | 新建（generateGuideDraft + planner 回放后断言 operations 含 plan/assign；投票规则在 prompt 层） |
| A3 | L2 | 机 | 是 | 依赖planner输出 | - | 新建（fixture C11 转述差评 → 无负向操作断言；claimKind 白名单 `planner.ts CLAIM_KIND_SET`） |
| A4 | L2 | 机 | 是 | 依赖planner输出 | - | 新建（fixture C09 → snippet claimKind=risk + targetScope 断言） |
| A5 | L2 | 机 | 是 | 依赖planner输出 | - | 新建（不入 operations、进 globalCandidateRefs 带原因；进池判定在 prompt 层） |
| A7 | L2 | 机 | 是 | 已实现 | - | 复用 `verify-b2.ts`（images 9 张 → 1 GuideSource）；merge.ts 按源计票 |
| A9 | L2 | 机 | 是 | 已实现 | - | **新建内联**（parsePlannerOutput：40 字硬截断、引用 >3 整条丢弃、非法 targetRef 丢弃）＋ `shared/src/verify-dedupe.ts` |
| A10 | L2 | 机 | 是 | 已实现 | - | **新建内联**（evidenceRefs 1–3 非空且全 ∈ 消费集合）＋ `verify-guides.ts`/`verify-dedupe.ts` |
| A11 | L2 | 机 | 是 | 依赖planner输出 | - | 新建（无 tip 素材 → optionGroups 空断言；`shared/src/verify-optionGroups.ts` 可复用） |
| **A13** | **L2** | **机** | **是** | **已实现** | **-** | **新建内联**（`eval/harness/a13Groups.ts` canonicalGroups 死判校验器 ＋ server `mergeGuideMentions` 真实聚合层，golden rawList 全串输入）。**两档：duplicate_split 同名散票硬 FAIL／alias_gap 别名缺口 finding 单列（poiAlias.ts 功能源码门禁零改动）。烟雾已绿** |
| S1 | L3 | 机 | 是 | 依赖planner输出 | - | 新建（返程日项集合 ⊂ 走廊集断言；规则在 prompt 层） |
| S2 | L3 | 机 | 是 | 依赖planner输出 | - | 新建（fixture MU5831 09:40 → 首项时间断言） |
| S3 | L3 | 机 | 是 | 依赖planner输出 | - | 新建（锁定 lodging D2–D3 + 多区域素材 → day 分配断言） |
| S5 | L3 | 机 | 是 | 已实现 | - | Task #279 实现（`DayContent.tsx` 出发时间来源标签限场景展示：抵达/返程/编辑态灰字、无全局角标）；`eval-ui.tsx scene=s5` 双宽度截图取证 |
| S7 | L3 | 机 | 是 | 已实现 | - | 复用 `shared/src/verify.ts` §7/§9（guards G1/G3 锁定 visit move/remove/setTime 拒绝；烟雾已绿） |
| S10 | L3 | 机 | 是 | 已实现 | - | Task #280 实现（`deriveDayRoles` 纯函数派生 day 角色 + `shared/src/verify-dayRoles.ts` 全矩阵 10 组断言） |
| S11 | L3 | 机 | **否** | 已实现 | - | Task #281 实现（改航班/改锁酒店 → `recomputeDerivedFields` 内 deriveDayRoles + deriveTimeSourceLabels 同操作重算，无 stale）。**v1.4 首轮＝否（随 #278 转绿入回归）→ 在 FIRST28 数组、不计入首轮 33** |
| **S12** | **L3** | **机** | **是** | **依赖planner输出** | **-** | **新建内联**（共享草案 5 源 fixture 全量生成 ＋ fixture claims stance 词表圈定 firsthand 强推 `{positive_experience, positive}`，断言 100% 进 items、缺失清单含实体名＋源URL＋原文位置）。C6 机器版，与 C6 人审并存 |
| **S13** | **L3** | **机** | **是** | **依赖planner输出（部分实现）** | **-** | **新建内联**（共享草案 itemRegistry+proposedNew 名称合法性 ＋ `resolvePoiAlias` 别名折叠）。**名称合法性机器可查；`provenance=ai_supplement` 回退断言 blocked-by-C4（Item 无 provenance 字段，Task #278 落点）——非法名清单单列透出，不静默 fail** |
| C1 | L4 | 机+人 | 是 | **未实现** | **参赛必须** | draft 路径 prompt 显式禁止 clarify（`planner.ts GUIDE_PLANNER_RULES_HEAD`）；F11 `pipeline.ts` 澄清机制可借鉴 → **Task #278** |
| C2 | L4 | 机 | 是 | **未实现** | 赛后 | 澄清抑制依赖 C1 落地后才有可抑制对象；随 Task #278 自然获得 |
| C4 | L4 | 机 | 是 | **未实现** | **参赛必须** | 全仓 grep「飞猪补充」无命中；`Item.origin="fliggy"` + provenance 字段（v1.2 加）为基础 → **Task #278** |
| C7 | L4 | 机 | **否** | **未实现** | **参赛必须** | 真 POI 不得落 custom_poi、无供给须走 C4 ai_supplement 路径标「AI 补充·飞猪核验」。**依赖 C4 provenance 落盘（Task #278）→ blocked；v1.4 首轮＝否，仅标注状态不进可运行套件** |
| Q1 | L5 | 报 | 是 | 已实现 | - | 复用 web vitest `VisitCard.test.tsx`（snippet chip → EvidenceSheet 定位高亮、外链 `<a>`）；证据＝`evidence/Q1.png` |
| Q3 | L5 | 机 | 是 | 已实现 | - | 复用 web vitest `VisitCard.test.tsx`（snippets.length===0 隐藏引用块）；「攻略未明确」全仓无命中 |
| Q5 | L5 | 机 | 是 | 已实现 | - | 复用 `verify-b2.ts`（partial 状态 + coverageText 诚实 + 重试入口） |
| **Q7** | **L5** | **报** | **是** | **已实现** | **-** | **新建内联**（Task #293 夹具保真修复：真值表 `eval/harness/q7Truth.ts` 固化笔记真实 PX 标注，`buildQ7Trip` 与 `eval-ui.tsx sceneQ7` 共用同一数据源，废除旧 `Q7_PAGE_START(3)+序号` 自造页码/原句；四段硬断言＝逐点位 pageRefs＝真值、firstAssetPath＝期望文件名（内容级锚点）、夹具 quoteText 逐字存在于抽取缓存原文、真实无标注点位「小吃街」空绑定回退占位）＋ `eval-ui.tsx scene=q7`（西岛 large_attraction 父卡＋8 拍照线点位，小吃街真实回退占位）＋ `uiShot.ts` playwright 390px 截 `evidence/Q7.png` 并逐点位 DOM 断言「点位名↔小图文件名」。**判定「报」：机器断言全绿（#288 假绿根因已修）；截图点位数 8／小图 7／占位 1（小吃街），PD 目视核对「点位名＋对应小图」；旧假图留 `evidence/Q7-old-fake.png` 供对照。孤独的树只绑 p14（「p14 15」任一皆可口径，PD 已裁不扩展 `PAGE_REF_PATTERN`）** |
| O1 | L6 | 机 | 是 | 已实现 | - | 复用 `shared/src/verify.ts`（guards 锁定拒绝）＋ `web/src/lib/verify-dayOrder.ts`；与 S7 同源 |
| O2 | L6 | 机 | 是 | 已实现 | - | 复用 `verify-dayOrder.ts` ＋ web vitest useTrip（removeVisitWithUndo 三态判别联合原位恢复） |
| O3 | L6 | 机 | 是 | 依赖planner输出 | - | 新建（executeIntent + 回放 → operations scope 仅 day2；F11 局部重算机制已实现，live-only 不可回放） |
| O8 | L6 | 机 | 是 | 已实现 | - | 复用 `shared/src/verify.ts` §7（G1/G3 reason 用户语言、30% 阈值、执行器兜底；烟雾已绿）＋ `verify-task35.ts` |

## 参赛必须未实现（→ Task #278 本周功能任务）

| 用例 | 首轮 | 缺口 | 实现落点（核实过） |
| --- | --- | --- | --- |
| C1 | 是 | draft 路径禁 clarify | `server/src/guides/planner.ts`（开放 clarify + 恰好一次 + 两选项文案绑定 planScope）；F11 pipeline 机制可借鉴 |
| C4 | 是 | 无「AI 补充·飞猪核验」标 + provenance 落盘 | draft 补充项 provenance=ai_supplement 落盘 + chip + FlyAI 真实 POI 引用（复用 #229 伪 POI 过滤） |
| C7 | 否 | 依赖 C4 provenance 路径 | C4 落地后：真 POI 无供给走 ai_supplement，不落 custom_poi |
| S13（回退分支） | 是 | Item.provenance 字段未实现 | 随 C4：provenance 落盘后 S13 回退断言由 blocked 转全量硬断言 |

> 注：v1.1 建档时 S5/S10 曾列参赛必须未实现，现已分别由 Task #279/#280 实现转绿，移出本表。

## 复用脚本清单（既有 verify 资产 → 用例族）

| 脚本 | 覆盖用例族 |
| --- | --- |
| `shared/src/verify.ts` | S7、O1、O8（guards G1/G3、30% 阈值、锁定、时间线、父子 POI 模型） |
| `shared/src/verify-dayRoles.ts` | S10、S11（day 角色派生全矩阵、锚点变更重算） |
| `shared/src/verify-guides.ts` | E6（去重纯函数）、A10（引用契约）、C5 族（freshness，非首轮） |
| `shared/src/verify-dedupe.ts` | A9（每实体 ≤2 条）、A12/E6 族（内容去重）、A10（归一化相似口径） |
| `shared/src/verify-optionGroups.ts` | A9/A11 相关（optionGroups 清洗契约、category 白名单、≥2 选项成组） |
| `server/src/guides/verify-b2.ts` | E3、E6、E8、A7、Q5（GuideSource 状态机、失败码、重试、多图 1 源） |
| `server/src/guides/verify-b3.ts` | L2/L4 族（merge + planner 契约）；A13 直接复用 `merge.ts mergeGuideMentions` 聚合层 |
| `server/src/guides/verify-task190/270/273.ts` | A9/A11 相关（optionGroups 信号与降级解除） |
| `server/src/guides/verify-task193/202.ts` | C5 族（snippet 快速路径、stale draft） |
| `server/src/ai/verify-task35.ts` | O8（AI 通道 baseVersion/guards/30%） |
| `server/src/ai/verify-task170/181/187.ts` | E 族抽取入口（ExtractCallDeps 桩模式、本地快速抽取、Day 归属） |
| `server/src/ai/verify-task107/233.ts` | E8/A 族辅助（候选脏数据过滤、别名归一） |
| `server/src/ai/verify-task40/42.ts` | O3 族（全量/局部重排 scope） |
| `web/src/lib/verify-dayOrder.ts` | O1、O2（day 序与撤销） |
| **`eval/harness/e9Recall.ts`** | **E9（召回纯函数：golden 加载、实体归一、claimKind 词法推断、bigram Dice 相似度、evaluateE9Recall）** |
| **`eval/harness/a13Groups.ts`** | **A13（canonicalGroups 死判：buildSurfacePlacement、checkCanonicalGroupViolations 两档、checkDuplicateSurfaceMerged）** |
| **`eval/harness/extractionCache.ts`** | **E9/Q7 语料缓存（L1 抽取按 contentHash 缓存；`eval/tools/build-corpus.ts` 一次性真实抓取＋抽取建缓存）** |

runner 接入方式：`EvalCase.run = { kind: "script", cwd, command }` 子进程执行、解析退出码；或 `{ kind: "inline" }` 直接调用断言函数（E9/A13/S12/S13/Q7 均 inline）。`uiShot:true` 用例（Q1/Q3/Q7）由 `npm run eval:ui` 独立产出 `evidence/{ID}.png`，report 引路径供 PD 复核。

## 代码核实记录（判定依据，全部实读代码）

1. **S5 已实现（Task #279）**：`web/src/components/DayContent.tsx` 出发时间来源标签限场景展示（抵达/返程/编辑态灰字、无全局角标）；`eval-ui.tsx scene=s5` 双宽度截图取证溢出=false。
2. **S10 已实现（Task #280）**：`shared/src/verify-dayRoles.ts` 覆盖 deriveDayRoles 10 组断言（优先级 返程＞抵达＞换区＞完整游玩、换区链、幂等、红线）。
3. **S11 已实现（Task #281）**：recomputeDerivedFields 钩子内 deriveDayRoles + deriveTimeSourceLabels 顺序执行，同一操作内同步重算无 stale。**v1.4 首轮＝否**。
4. **C1 未实现（draft 路径）**：`planner.ts` GUIDE_PLANNER_RULES_HEAD 明示「不要输出 clarify」；澄清机制仅存于 F11 `pipeline.ts`。
5. **C4/C7/S13 回退未实现**：`shared/src/types/index.ts` Item 接口无 provenance 字段（v1.2 文档要求加，代码未落）；全仓 grep「飞猪补充」零命中；基础为 `Item.origin: "fliggy"` + 「待飞猪匹配」灰标（assemble.ts）→ Task #278。
6. **E9 召回口径**：抽取契约 `ParsedEntry` 无 PD 五类字段（时间/亮点/小景点/避雷/TIPS），claimKind 用确定性词法信号推断（duration>pitfall>tip>highlight）；命中＝实体+claimKind 语义命中不逐字比（bigram Dice≥0.30，评测侧标定）；boundary（kind 存疑/一对多）单列交 PD 裁不自动 fail；golden v1.1 亚龙湾 11 条 expectedClaims，阈值 0.8。西岛篇 PD 未按五类补全，暂不进 E9（golden openQuestions）。**Task #298（2026-10-30）：recall 实测 7/11=0.636（miss 0、boundary 4＝YLW-02/04/10/11），四条边界逐条 golden vs 抽取原文并排对照＋机器为何判存疑＋勾选位已产出人话审阅文档 `eval-report/v2/evidence/E9-boundary-review.md`，待 PD 阅后裁（判 YLW-02/11 为 hit → 0.818 达标；再判 04/10 → 1.0）。** **Task #299（2026-10-30）：PD 已裁——四条边界 YLW-02/04/10/11 全部判命中（原话意译「攻略文案系我自己提炼规整、字面无法完全对应，可算评测通过」）→ recall=11/11=1.000 达标，E9 由 blocked 转 pass；裁量落 `eval/harness/e9Recall.ts` `PD_ADJUDICATION` override 表（machineDecision/machineRecall 双字段留痕、`E9.log` 打「原始机器判定 vs PD 裁量」双行，非静默放宽，机器阈值/词表零改动）；YLW-06 归属下沉子景点「过江龙索桥」为 PD 同日发现的归属细化项，走 Task #300（`server/src/ai/noteAttribution.ts`），不在本裁量范围、不影响 recall。**
7. **A13 归一化表来源**：`shared/src/poiAlias.ts` POI_ALIAS_ROWS 仅含亚龙湾森林公园两类别名，**无「山顶婚礼草坪==婚礼礼堂大草坪」别名**；`merge.ts mergeGuideMentions` nameIndex 走 `canonicalPoiMatchKey`（poiAlias 折叠）先到先得。实测：沧海观景台同名 2 次去重为 1（duplicate_split 硬断言绿）；山顶公园/山顶婚礼草坪/婚礼礼堂大草坪 未折叠成 3 地点（alias_gap finding 1 条，功能源码缺口，门禁零改动交后续任务补别名）。
8. **Q7 配图链**：`shared/src/guides/pageImages.ts resolveMentionPageImages`（页码 1–24、顺序可靠、槽位 ready、evidenceId 属本来源、assetPath 优先明细回退证据）→ `web/src/lib/entityImages.ts resolveEntityPageImages`（Stop 分支按 sourceMentionRefs 收集）→ `StopRow.tsx` 渲染 `/api/${guidePicPath}`（isCustom && picUrl===null && !picFailed → firstAssetPath），无图回退 `ImagePlaceholder`（.ph-tile）。西岛笔记抓取产物 18 张落 `server/uploads/xhs_6ace31c6…`，经 server:8787 xhsAssetRoutes 受控读取。**Q7 v2 渲染（#296 配图三级优先 飞猪图→PX→占位，`evidence/Q7.png`）PD 已复核通过（2026-10-30）；v1 `Q7-v1-parentpx.png` 早前已通过。**
9. **语料前置（PD 口头拍板 v1.4）**：fixture sourceUrl 全串两条小红书 link（亚龙湾 6a93bde9、西岛 6ace31c6）加入 L1 抽取语料，文档口径 8 源→10 源；西岛与 fixture S4 同一笔记不重复计源。缓存 `eval/cache/extraction/{noteId}.json`：亚龙湾 status=cached（contentHash 复算一致，正文 1032 字/图 9/entries 11）、西岛 status=built（真实抓取＋真实抽取 44423ms，正文 544 字/图片 18 复用既有产物免重抓/entries 5）。contentHash=sha256(正文)，与语料清单/资产版本无关，语料变更不改既有缓存键。
10. **A/S 系列投票/排程规则在 prompt/planner 层**：代码无独立投票器/走廊排程；claimKind/firsthand/stance 契约类型已定义（shared types），fixture 提供字段值，判定规则依赖 planner 输出（S12/S13 同此，标依赖planner输出）。
11. **方差收敛口径固化（PD 已拍板 2026-10-30，选项 B 多轮制）**：里程碑验收 S1（返程日走廊）须连跑 5 轮全绿、A4（警告类 snippet）须连跑 3 轮全绿，单轮绿不算过；部分轮次失败必须归因（区分模型输出方差／评测断言缺陷／功能缺陷三类）并修复优化后重跑，不接受「反复重跑碰运气」。本轮 S1 5/5、A4 5/5 全绿满足基线（详见 `eval-report/v2/report.md` 第三轮「方差收敛口径固化」）。
