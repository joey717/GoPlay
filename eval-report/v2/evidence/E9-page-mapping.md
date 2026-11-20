# E9 页面落位对照表（Task #301 重抽 · #300 归属下沉生效）

> 截图：`eval-report/v2/evidence/E9-page-mapping.png`（390px 整页，真实 VisitCard 现场 + 落位对照面板）
> 渲染源：`web/src/eval-ui.tsx sceneE9`；数据源：`eval/harness/e9Truth.ts`（与截图 DOM 断言同源）
> 断言：`eval/harness/uiShot.ts scene=e9`（5 组断言全过：9 子点位 / 11 claim entity·region·sim / 4 区域条数 / 下沉 2 条 / recall=pass）

## 0. 重抽快照（数据基线）

| 字段 | 值 |
| --- | --- |
| 笔记 id | `6a93bde9000000002600105b`（亚龙湾热带天堂森林公园） |
| contentHash | `ae22909b88f8d927…`（正文未变；重抽差异＝抽取模型方差 + #300 归属下沉） |
| capturedAt | 2026-10-30T14:17:03.120Z（extractMs=63295） |
| entries | 19 条＝attraction 1 / in_attraction 9 / note_tip 9 |
| note_tip 归属全貌 | **7 条父卡攻略提示区 ＋ 2 条下沉子点位贴士区**（#300 预测 3 条下沉） |

**预测 vs 实测（PD 核对锚点）**：#300 离线预测 3 条下沉（过江龙索桥 YLW-06 / 玻璃栈道 YLW-08 / 试婚房），实测 **2 条下沉（玻璃栈道 / 试婚房）＋ 7 条父卡**。差异归因：本轮重抽中百炼未产出独立的「过江龙索桥」note_tip，而是把排队信息直接并入 in_attraction「过江龙索桥」子景点条目（quote「索桥（过江龙索桥）：20元，电影取景吊桥，人多排队…」），故无独立 note_tip 可下沉——YLW-06 落**子点位详情行**（matcher 匹配子景点 entity sim=0.471 机器直接 HIT），归属细化意图已达成。属抽取方差，非 #300 缺陷。

## 1. 落位区域分布（11 条 golden）

| 落位区域 | 条数 | claim |
| --- | --- | --- |
| 父卡时长详情行（parent_duration） | 1 | YLW-01 |
| 父卡攻略提示区（parent_tips） | 5 | YLW-05 / YLW-07 / YLW-09 / YLW-10 / YLW-11 |
| 子点位详情行（stop_detail） | 4 | YLW-02 / YLW-03 / YLW-04 / **YLW-06★** |
| 子点位贴士区·#300 下沉（stop_tips） | 1 | **YLW-08★** |

★＝#300 归属下沉直接相关：YLW-06 过江龙索桥落子景点详情行、YLW-08 玻璃栈道落下沉贴士区。

## 2. 逐条落位对照（11 条）

| claim | kind | 落位区域 | 命中候选实体 [类型] | sim | 机器判定 | PD 裁量 | 最终 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| YLW-01 | duration | 父卡时长详情行 | 亚龙湾热带天堂森林公园 [attraction] | 1.0 | HIT | — | HIT |
| YLW-02 | highlight | 子点位详情行 | 试婚房 [in_attraction] | 0.458 | HIT | — | HIT |
| YLW-03 | highlight | 子点位详情行 | 婚礼礼堂大草坪 [in_attraction] | 0.689 | HIT | — | HIT |
| YLW-04 | highlight | 子点位详情行 | 兰花谷 [in_attraction] | 0.207 | BOUNDARY | HIT | HIT |
| YLW-05 | pitfall | 父卡攻略提示区 | 亚龙湾热带天堂森林公园 [note_tip] | 0.303 | HIT | — | HIT |
| YLW-06★ | pitfall | 子点位详情行 | 过江龙索桥 [in_attraction] | 0.471 | HIT | — | HIT |
| YLW-07 | pitfall | 父卡攻略提示区 | 亚龙湾热带天堂森林公园 [note_tip] | 0.51 | HIT | — | HIT |
| YLW-08★ | pitfall | 子点位贴士区 | 玻璃栈道 [note_tip·下沉] | 0.92 | HIT | — | HIT |
| YLW-09 | tip | 父卡攻略提示区 | 亚龙湾热带天堂森林公园 [note_tip] | 0.541 | HIT | — | HIT |
| YLW-10 | tip | 父卡攻略提示区 | 亚龙湾热带天堂森林公园 [note_tip] | 0.233 | BOUNDARY | HIT | HIT |
| YLW-11 | tip | 父卡攻略提示区 | 亚龙湾热带天堂森林公园 [note_tip] | 0.806 | BOUNDARY | HIT | HIT |

### 逐条说明（落位归因，含重抽漂移 / #300 下沉标注）

- **YLW-01**（游玩时长3-4小时）：suggestMinutes=210 ∈ golden [180,240]，抽取器以结构字段承载 duration → 父卡时长详情行（页面显示「约 3.5 小时」）。
- **YLW-02**（《非诚勿扰2》拍摄原址…）：重抽后候选变试婚房 in_attraction，机器直接 HIT（#299 时为 boundary·kind=tip 误触，本轮 kind=highlight 修正；PD override 变 no-op）→ 子点位详情行。
- **YLW-03**（山顶草坪很适合拍照…）：内容命中且 kind 一致（highlight）→ 子点位详情行（婚礼礼堂大草坪）。
- **YLW-04**（观光车一站一站停靠…）：机器 sim=0.207∈[0.18,0.3) 内容存疑（#299 为 0.250）→ PD 判命中：golden 提炼表述、观光车信息（站点单向/按序游玩/盘山公路）已 surface 语义等价 → 子点位详情行（兰花谷）。
- **YLW-05**（物价贵，建议水、零食自备）：note_tip「山上天街餐厅物价贵」归父卡攻略提示区；候选实体由 #299 的 in_attraction「天街餐厅」漂移为父卡 note_tip，命中不变。
- **YLW-06★**（过江龙索桥排队人巨多…）：#300 归属下沉重点——排队信息本轮被抽取器直接并入 in_attraction「过江龙索桥」子景点，matcher 匹配子景点 entity sim=0.471 机器直接 HIT（#299 时候选为父卡 note_tip sim 0.686、PD 附注要求下沉，#300 已落地，归属细化意图达成）→ 子点位详情行。
- **YLW-07**（有偿拍照漫天要价…）：note_tip「有偿拍照先问价」归父卡攻略提示区，内容命中且 kind 一致（pitfall）。
- **YLW-08★**（玻璃栈道谨慎买…）：#300 归属下沉——note_tip「玻璃栈道谨慎买大雾」已下沉归子景点「玻璃栈道」（子点位贴士区 chip），matcher 匹配子景点 sim=0.92 命中（#299 时候选为父卡 亚龙湾）。
- **YLW-09**（网上提前买票比现场窗口便宜）：note_tip「门票网上提前买便宜」归父卡攻略提示区（sim 由 #299 的 0.828 漂移至 0.541，命中不变）。
- **YLW-10**（观光车一定要买…备好雨具…）：机器 sim=0.233<0.3 内容存疑 → PD 判命中：golden 合并两 tip（观光车必买／备雨具）被抽取拆条稀释 bigram，pdNote 允诺语义拆分容忍 → 父卡攻略提示区。
- **YLW-11**（建议上午上山，下午容易起大雾…）：机器 sim=0.806 内容近乎逐字命中但反推 kind=pitfall≠tip（quote「看不到海」误触 PITFALL 词表）→ PD 判命中：词法误触，抽取归 note_tip 与 golden TIPS 归类一致（sim 由 #299 的 0.575 漂移至 0.806）→ 父卡攻略提示区。

## 3. recall 结论（与 evidence/E9.log 一致）

机器 recall **8/11=0.727**（未达阈值 0.8）→ PD 裁量 **3 条 boundary（YLW-04/YLW-10/YLW-11）**全判命中 → **11/11=1.000 ≥ 0.8 → pass**。机器阈值/词表零改动，machineRecall 与逐 claim machineDecision 原样留痕（双行）。

## 4. 页面落位视觉要点（看图验收指引）

- **父卡**：亚龙湾热带天堂森林公园「大景区·半天」，时长详情行「约 3.5 小时」（YLW-01）；攻略提示区合并引用块（门票省钱／观光车必买…）＋「查看攻略原文」入口（YLW-05/07/09/10/11 归属父卡）。
- **子点位详情行**：过江龙索桥「电影取景吊桥，20元，人多可绕栈道」（YLW-06★）、试婚房「《非诚勿扰2》木屋原址，免费参观很出片」（YLW-02）、婚礼礼堂大草坪（YLW-03）、兰花谷（YLW-04）。
- **子点位贴士区（#300 下沉 chip）**：试婚房下挂「试婚房防骗：试婚房免费…」、玻璃栈道下挂「玻璃栈道避雾：大雾天别…」（YLW-08★）——下沉 note_tip 落在子点位而非父卡。
- **落位对照面板**：截图下半部按 4 区域分组逐条标注候选实体/sim/机器判定→PD 裁量/归因，含 recall 结论行与 note_tip 归属全貌（7 父 / 2 下沉）。
