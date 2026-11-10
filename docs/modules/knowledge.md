# knowledge — 知识与入库

> 类型：模块契约

> 状态：现行（P4 已迁入 `src/modules/knowledge/`；`src/ingest/cli.ts` 是入口薄壳）
> 代码：`src/modules/knowledge/{a2a,summarize}.ts`、`src/modules/knowledge/ingest/*`
> 入口：`src/modules/knowledge/index.ts`

## 职责

Vault 的读写边界：入库批次校验与写入、覆盖保护、vault 锁、失败归档；本地检索与摘要；A2A 访谈信封的校验与归档。**全程不调模型。**

## 拥有

| 数据/文件 | 说明 |
|---|---|
| vault 共享区 / 内部区文件 | 两区是两个独立 git 目录；原件在 `_originals/`，不进 git |
| `.git/anc-ingest.lock` | 入库独占锁；`{pid, started_at}`，pid 不存在或 >10 分钟可接管 |
| `a2a_surveys` / `a2a_messages` 表 | 规则版本冻结；按 `(survey_id, message_id)` 去重 |
| 本地摘要规则 | `summarizeMarkdown` / `searchAndSummarize`，无网络 import |

## 公开契约

- `applyBatch(batchDir, vaultDir)` → `{added, modified, originals}`
- `archiveBatch` / `failBatch` / `inferInbox`
- `normalizeTarget` / `assertTextSize` / `assertFrontmatter` / `blobHash`
- `summarizeMarkdown(text, opts)` / `searchAndSummarize(docs, keyword, opts)`
- `createSurvey` / `parseEnvelope` / `submit` / `surveyStatus` / `listSubmissions` / `assertInternalDir`

## 不变量

- 目标路径**必须在 vault 内**；每一级都不能是链接（junction/符号链接会穿到 vault 外）。
- 覆盖已有 markdown **必须带 `base_hash`**，且与**工作区当前内容**一致（不是 HEAD）；不一致 → 拒写并让人重读。
- `_originals/` 已存在 → **拒绝覆盖**；新文件不许带 `base_hash`。
- 单个文本 ≤ **1 MB**；必须过 frontmatter schema；路径不许是保留名/结尾点空格/大小写冲突。
- 失败**回滚已写入/覆盖的文件**；回滚失败要标 `ROLLBACK_INCOMPLETE`，不能吞。
- 入库**不做 git commit**；人复核 diff 后才提交。
- 内部区必须是**独立 git 目录**，不能是共享区或其子目录。

## 失败模式

| 错误码 | 含义 | 出路 |
|---|---|---|
| `BAD_PATH` / `MISSING_SRC` | 批次文件越界/缺失 | 重投批次；检查 meta.json |
| `NEED_BASE_HASH` / `BASE_HASH_MISMATCH` | 覆盖缺 hash / 内容已变 | 重读 → 合并 → 重投 |
| `ORIGINAL_EXISTS` | 原件已存在 | 不覆盖；改名或走新批次 |
| `VAULT_BUSY` / `VAULT_NOT_WRITABLE` | 锁被占 / 没写权限 | 等锁；检查服务身份 ACL |
| `ROLLBACK_INCOMPLETE` | 回滚没做完 | **人工检查 vault**，不要当普通失败重试 |

## 依赖

- 允许：core
- 禁止：tasks / delivery / org（知识层不知道任务与人的存在）
- 注意：`interfaces` 的动态 `import('../ingest/apply.ts')` 是组合根，不是 knowledge 反向依赖它。

## 测试

`npm run test:ingest`（路径穿越、base hash、孤儿锁、回滚）；`npm run test:service` 里的 A2A 与摘要用例。

## 改动指南

- 改 vault 规范：同步 `docs/CONTENT-PIPELINE.md`、`anc-ingest-company` 技能、`DECISIONS` §5.4。
- 加校验：先加 `validate.ts` 的纯函数与测试，再进 `apply.ts` 的 plan。
- 改摘要：不能引入网络/模型；D19 是硬约束。

## 变更记录

| 日期 | 改了什么 | 为什么 |
|---|---|---|
| 2026-11-06 | 建档 | 模块化立项 |
| 2026-11-06 | P4 迁入 `src/modules/knowledge/` 与 `ingest/` | 模块化 |
