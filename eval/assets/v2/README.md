# eval/assets/v2 — 验收资产快照（v2 = 2026-10-28，配套用例文档 v1.4）

改动＝用例文档升版本（v1.1 → v1.4，Task #285）：新增 E9 golden fixture 与语料前置源 S6；
v1 目录只增不改，本目录为新的最高版本（harness `latestAssetsVersion()` 自动选中）。

| 文件 | 角色 | 相对 v1 的变化 |
| --- | --- | --- |
| `GoPlay_五篇攻略取证样本_20261019.json` | fixture：S1–S6 来源、C01–C19 claims、westIslandPhotoRoute、aggregationChecks | **新增 S6 亚龙湾源**（v1.4 语料前置，E9 golden 输入）；S1–S5 与 claims 逐字节不变。西岛语料串（6ace31c6，历史成功抓取的分享全串）与 S4 为同一笔记，不重复计源 |
| `GoPlay_攻略直出行程与原文回看_五篇实测整理_20261019.md` | golden：C6 对照用实测整理 | 与 v1 逐字节相同（sha256 一致） |
| `highlight-recall-yalongwan.json` | **E9 golden（新增，assetVersion v1.1）**：PD 人工标 11 条 expectedClaims（时间1/亮点3/避雷4/TIPS3）＋小景点原始清单＋canonicalGroups（A13 归一化裁定）＋sourceUrl 全串 | PD 交付原件**原样入库**（sha256 与 outputs 源文件一致，未改一字节） |
| `VERSION.json` | 版本标：snapshotDate、sourcePath、逐文件 sha256 与合并 contentHash | files 新增 `goldenE9`；contentHash ＝ 三文件哈希串接 |

## 语料口径（v1.4 §0 / §5 PD 配合项，PD 口头拍板）

- L1 抽取语料 **8 源 → 10 源**：文档口径 8 源＝5 篇真攻略＋3 篇合成边界源；v1.4 前置新增
  亚龙湾（S6，6a93bde9）与西岛分享全串（6ace31c6，与 S4 同一笔记，报告注明不重复计源）。
- 真实抓取＋抽取产物按笔记正文 contentHash 缓存于 `eval/cache/extraction/`（一次性建立，
  抽取 prompt/代码不变则零 token 复用）；西岛笔记 `server/uploads/xhs_6ace31c6…/` 已有
  18 张抓取图，复用免重抓。

## 版本规则（用例文档 v1.1 §6 拍板口径，沿用）

- **改动本目录任何文件 ＝ 用例文档升版本**，并新建 `eval/assets/v{N+1}/` 承载新快照；
  旧版本目录只增不改，保证历史报告可复现。
- harness 默认读取最高版本目录并逐文件校验 sha256；报告头写明 assets 版本与 contentHash。
- E9 golden 的 assetVersion（v1.1）是 PD 标注件自身的版本标，与资产目录版本（v2）独立。
