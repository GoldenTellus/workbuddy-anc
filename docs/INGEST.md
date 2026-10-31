# 入库进程

对应 [FORK-DIRECTION.md](./FORK-DIRECTION.md) §5.4 的入库管线与 D13。原则：**入库进程不调模型，只做确定性校验**；模型只负责在技能里把资料整理成结构化 markdown 并投进批次目录。

## 批次目录

公司 bot 把一批要入库的东西放进 `inbox\pending\<batch_id>\`：

```
inbox\pending\<batch_id>\
├─ meta.json
├─ 公司简介.md
└─ x.pdf
```

`meta.json`：

```json
{
  "batch_id": "20261031-001",
  "chat_id": "<chatid>",
  "from_userid": "<userid>",
  "received_at": "2026-10-31T09:00:00+08:00",
  "files": [
    { "src": "公司简介.md", "target": "company/简介.md", "kind": "markdown" },
    { "src": "x.pdf", "target": "_originals/x.pdf", "kind": "original" }
  ]
}
```

- `target` 是**共享区相对路径**；覆盖已有 markdown 时必须带 `base_hash`（读取时的 git blob hash），新文件不许带。
- `kind=original` 只能新建，已存在就拒绝。

## 校验规则（全部在落盘前完成）

- 路径规范化：反斜杠、盘符、冒号、`..`、结尾空格/点、Windows 保留名（CON/NUL/COM1…）、长度；
- 大小写冲突（Windows 上 `A.md` 与 `a.md` 视为冲突）；
- markdown ≤ 1MB，必须有 frontmatter（`title` / `source_file` / `updated_at`）；
- 覆盖写：`base_hash` 必须等于当前文件内容，否则 `BASE_HASH_MISMATCH`；
- 原件：目标已存在则 `ORIGINAL_EXISTS`。

## 用法

```powershell
node src\ingest\cli.ts apply --batch D:\anc\inbox\pending\20261031-001 --shared D:\anc\vault-shared --inbox D:\anc\inbox
```

输出 `added / modified / original` 三行，**不自动 git 提交**——起步阶段由管理员复核 diff 后再提交（FORK §5.4 第 4 步）。

带 `--inbox` 时：

- 成功：批次自动移到 `inbox\done\<batch>`；
- 失败：批次自动移到 `inbox\failed\<batch>` 并写 `reason.txt`（含错误码与原因）。

错误码：`BAD_PATH` / `BAD_META` / `MISSING_SRC` / `TOO_LARGE` / `BAD_FRONTMATTER` / `NEED_BASE_HASH` / `BASE_HASH_MISMATCH` / `ORIGINAL_EXISTS` / `CASE_CONFLICT`。

## 已实现 / 未实现

- 已实现：批次读取、全部校验、事务写入（失败回滚已写入与已覆盖的文件）、`added/modified/original` 结果；
- 未实现：git 提交（`-F` 传作者名）、失败批次进 `inbox\failed\` 并回执、管理员复核交互、附件清理任务、`reproject` 投影。

## 测试

```powershell
node --test src/ingest/ingest.test.ts
```

覆盖：正常入库、base hash 三种情形、路径穿越/保留名/冒号、原件已存在、缺 frontmatter 不落盘。
