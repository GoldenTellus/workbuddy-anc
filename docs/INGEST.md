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

- 路径规范化：反斜杠、盘符、冒号、`..`、结尾空格/点、Windows 保留名（CON/NUL/COM1/CONIN$…）、非法字符 `<>"|?*` 与控制字符、长度；
- **不许写进 `.git`**：任何一段是 `.git`（不分大小写）或 8.3 短名（`GIT~1` 这类）一律 `BAD_PATH`——写进 `.git/hooks` 等于能在下次提交时执行代码；
- **不跟链接**：批次里的源文件必须是普通文件，真实路径在批次目录内；vault 侧目标路径上已有的每一级都不能是 junction / 符号链接，真实路径必须在 vault 内；
- 批次内同一目标出现两次（`DUPLICATE_TARGET`）或仅大小写不同（`CASE_CONFLICT`）都拒绝；
- markdown ≤ 1MB，必须有 frontmatter（`title` / `source_file` / `updated_at`）；
- 覆盖写：`base_hash` 必须等于当前文件内容，否则 `BASE_HASH_MISMATCH`；
- 原件：目标已存在则 `ORIGINAL_EXISTS`。

## 写入（拿锁后）

- vault 级独占锁 `.git\anc-ingest.lock`（非 git 目录时是 `.anc-ingest.lock`）：另一个入库在跑就 `VAULT_BUSY`。确认没有进程在跑而锁还在（进程被杀）时，手动删掉锁文件；
- 拿锁后对每个目标**再核一次**内容，计划阶段之后被改过就 `BASE_HASH_MISMATCH`；
- 每个文件先写同目录临时文件再改名，进程中途退出不会留下写了一半的目标；
- 中途失败按反序回滚（删新建的文件与目录、恢复被覆盖的文件）；**回滚本身失败时报 `ROLLBACK_INCOMPLETE`**，错误信息列出没恢复的文件，vault 需人工检查。

## 用法

```powershell
node src\ingest\cli.ts apply --batch D:\anc\inbox\pending\20261031-001 --shared D:\anc\vault-shared --inbox D:\anc\inbox
```

输出 `added / modified / original` 三行，**不自动 git 提交**——起步阶段由管理员复核 diff 后再提交（FORK §5.4 第 4 步）。

带 `--inbox` 时：

- 成功：批次自动移到 `inbox\done\<batch>`；
- 失败：批次自动移到 `inbox\failed\<batch>` 并写 `reason.txt`（含错误码与原因）。

带 `--commit` 时（可选，默认不提交）：

- **只暂存并提交本批写入的文件**（含原件）：别的批次还在等复核、或有人手改过的内容不会被顺带提交；
- git 以 `core.hooksPath=NUL`、`core.fsmonitor=false` 运行：vault 里的 hook 一律不执行；
- 作者固定 `anc-ingest <anc-ingest@localhost>`，提交信息经 `-F` 文件传入，参数用数组、不经 shell；
- 提交信息形如 `ingest: company/术语.md`；没有改动时返回 `commit: null`。

起步阶段建议**不带** `--commit`，由管理员复核 diff 后手动提交；跑顺了再打开。

错误码：`BAD_PATH` / `BAD_META` / `MISSING_SRC` / `TOO_LARGE` / `BAD_FRONTMATTER` / `NEED_BASE_HASH` / `BASE_HASH_MISMATCH` / `ORIGINAL_EXISTS` / `CASE_CONFLICT` / `DUPLICATE_TARGET` / `VAULT_BUSY` / `WRITE_FAILED` / `ROLLBACK_INCOMPLETE`。

失败批次转移到 `failed\` 本身失败时，错误信息会注明「批次仍在 pending」，避免调度反复重试同一个坏批次而无人察觉。

## 已实现 / 未实现

- 已实现：批次读取、全部校验（含 `.git`、短名、非法字符、重复目标、链接越界）、vault 级锁、锁内复核、事务写入（临时文件 + 改名，失败回滚并报告回滚失败）、只提交本批文件的 git 提交（关 hooks）、失败批次进 `inbox\failed\` 并写 `reason.txt`、`added/modified/original` 结果；
- 未实现：写入前的 journal（进程被强杀或断电后自动恢复 vault；目前靠临时文件 + 改名把残留降到最低，回滚失败会明确报 `ROLLBACK_INCOMPLETE`）、管理员复核的交互界面（现在是人工看 diff）、`reproject` 投影。

## 测试

```powershell
node --test src/ingest/ingest.test.ts
```

覆盖：正常入库、base hash 三种情形、路径穿越/保留名/冒号、原件已存在、缺 frontmatter 不落盘。
