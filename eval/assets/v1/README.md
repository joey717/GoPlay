# eval/assets/v1 — 验收资产快照（v1 = 2026-10-19）

本目录是 AI 能力验收的**只读基线资产**，与用例文档 v1.1 配套：

| 文件 | 角色 |
| --- | --- |
| `GoPlay_五篇攻略取证样本_20261019.json` | fixture：S1–S5 五篇攻略来源、C01–C19 claims、westIslandPhotoRoute、aggregationChecks（机器映射） |
| `GoPlay_攻略直出行程与原文回看_五篇实测整理_20261019.md` | golden：五篇攻略直出行程与原文回看的实测整理（C6 对照用） |
| `VERSION.json` | 版本标：snapshotDate、sourcePath、逐文件 sha256 与合并 contentHash |

## 版本规则（用例文档 v1.1 §6 拍板口径）

- **改动本目录任何文件 ＝ 用例文档升版本**（v1.1 → v1.2 …），并新建 `eval/assets/v2/`
  目录承载新快照；旧版本目录只增不改，保证历史报告可复现。
- harness（`eval/harness/fixtureLoader.ts`）默认读取最高版本目录；报告头必须写明
  所用 assets 版本与 contentHash。
- 校验完整性：`shasum -a 256 -c` 对照 `VERSION.json` 中的逐文件哈希。
