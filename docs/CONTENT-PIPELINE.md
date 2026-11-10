# 内容流水线 — 渲染器与入库

> 类型：接口契约（内容生产）
> 入口：本文件合并原 `CONTENT-PIPELINE.md` 与 `CONTENT-PIPELINE.md`；两段职责不同，但都属于“内容从真相源到使用面”的流水线。
> 相关：[DECISIONS.md](./DECISIONS.md) D13/D15、[ARCHITECTURE.md](./ARCHITECTURE.md)、[CONTENT 模块契约](./modules/content.md)。

```text
org / members / depts  ──渲染器──>  persona + groups.json + 接入包
inbox/pending/<batch>  ──入库───>  vault 共享区（校验/锁/事务/可选提交）
```

## 1. 渲染器

> 类型：接口契约（渲染器）

对应 [DECISIONS.md](./DECISIONS.md) §5.9、[FUTURE-DESIGN.md](./FUTURE-DESIGN.md) 主干 1 与 [PLAN.md](./PLAN.md)。**渲染是唯一上线路径**（D15）：persona 和接入包只能由渲染器生成，手改线上文件视为事故。

## 输入（org 数据）

```
org/
├─ company.md            # 公司级字段 + 公司群/老板 1:1 配置
├─ roles/<role>.md       # 角色（可选，预留）
├─ depts/<dept>.md       # 部门（可选）+ 部门群配置
└─ members/<id>.md       # 每个员工一份
```

`company.md`（frontmatter）：

```yaml
---
name: 示例公司
company_bot_name: 公司bot
boss: zhangsan
vault_shared: '\\主机\anc-vault-shared'
vault_internal: 'D:\anc\vault-internal'
local_workdir: 'C:\Users\<用户>\WorkBuddy\Claw'
company_group_chat_id: <公司大群 chatid>
company_group_webhook_file: hook-company.txt
boss_dm_chat_id: <老板 1:1 或私有群 chatid>
boss_dm_webhook_file: hook-boss.txt
---
```

`members/<id>.md`：

```yaml
---
id: zhangsan
name: 张三
role: manager
userid: <userid>
chat_id: <chatid>
webhook_file: hook-zhangsan.txt
mention_userid: <企微通讯录 userid>  # 可选，用于 webhook 真 @，空值=不 @
dept: sales
manages: sales,cs          # 非空 = 管理者；老板由 company.boss 指定
seat: Enterprise
bot: 已接入
---
```

`depts/<id>.md`（可选）：

```yaml
---
id: sales
name: 销售部
vault_paths: shared/销售, internal/销售
skills: anc-task, anc-vault-read
chat_id: <部门群 chatid>
webhook_file: hook-dept-sales.txt
---
```

- 仓库里只放 `org.example/`，**真实 org 数据不进仓库**（人名、chatid、userid 都算敏感）；
- 真实数据放主机（如 `D:\anc\org\`），或放 vault 内部区，由运维指定 `--org` 路径。

## 产物

```
<out>/company-bot/CODEBUDDY.md      # 公司 bot persona
<out>/members/<id>/CODEBUDDY.md     # 个人 bot persona（接入包的一半）
<out>/groups.json                   # 员工投影 + 四类群（employee/department/company/boss_dm）
```

- 每个产物顶部带 `<!-- anc:input-sha256:<hash> -->`：hash 覆盖 company.md + roles/* + depts/* + members/*；
- **手改检测**：`<out>/manifest.json` 记下每个产物的内容 hash。下次渲染时若输入没变、文件 hash 变了，就报 `WARN 产物被手改过` 并以退出码 1 结束（原文件已备份）。manifest 本身损坏时报 `WARN manifest.json 无法解析`，不再静默关闭检测；
- **长度闸门**：按 UTF-8 **字节**算（比按字符保守，只会误拒），>6500 警告，>7500 报错并列出各段长度（T19）；公司 bot 与每个成员的 persona 都检查、都告警；
- **成员校验**：`id` 只许 `[a-z0-9_-]`（≤64，会进输出路径）；`name` / `role` / `userid` / `chat_id` 拒绝控制字符、反引号、`<!--`，≤100 字符；`webhook_file` 只能是 `xxx.txt` 文件名；`mention_userid` 字符集 `[A-Za-z0-9_@.-]`、≤64、可空、不进 persona 文本；
- **缺 userid**：该成员不出个人 persona，只告警（`groups.json` 里仍列出，`userid: null`），补上后重渲染；
- **落盘**：先备份 `.bak-<毫秒时间戳>`（同名不覆盖、每个产物只留最近 10 份）→ 临时文件 → 读回对拍 sha256 → 重命名（被占用时重试 5 次）；`groups.json` 与 `manifest.json` 同样原子写。

## 用法

```powershell
node src\render\cli.ts render --org org.example --out %TEMP%\anc-render
node src\render\cli.ts render --org D:\anc\org --out D:\anc\build --json

# 事务式部署：快照 → 渲染 → 逐产物对拍 → org→DB 同步/校验 → 任一失败整体回滚
node src\render\cli.ts deploy --org D:\anc\org --out D:\anc\build --db C:\ProgramData\anc\data\anc.db --json
# 不给 --db 时只渲染/部署，不碰数据库；--sync-db 必须同时给 --db
# 回滚到每个文件最新的一份 .bak-<时间>；先 --dry-run 看会动哪些
node src\render\cli.ts rollback --out D:\anc\build --dry-run
node src\render\cli.ts rollback --out D:\anc\build
```

## 真相归属（PLAN M3 第 2 项）

**`members/` 是成员与群对应的唯一真相**；本地小服务的 `chat_bindings` 是投影，由 `groups.json` 同步：

```powershell
# 推荐：从 org 直接同步 people/groups/manager_scopes，并双写 chat_bindings
node src\service\cli.ts --db C:\ProgramData\anc\data\anc.db bind sync-org --org D:\anc\org

# 或只导入渲染产物（groups.json 里的 groups[] 也会写入 groups 表）
node src\service\cli.ts --db C:\ProgramData\anc\data\anc.db bind import --from <out>\groups.json
```

- 运行期不再手改绑定表；要改群/人，改 org 数据 → 重渲染 → `bind sync-org`；
- `bind import` 幂等：同 chatid 更新为最新值，没有 chatid 的成员跳过；
- `groups.json` 的 `groups[]` 是四类群投影：员工群来自 `members.chat_id`，部门群来自 `depts.chat_id`，公司群/`boss_dm` 来自 `company.md`。没有 chat_id 的群不生成。

## 接入器（员工机）

渲染出的 `members/<id>/CODEBUDDY.md` 是接入包的一半；接入器把它和技能名片装到员工机：

```powershell
node src\render\cli.ts onboard --package <out>\members\<id> --home %USERPROFILE% --vault-shared \\主机\anc-vault-shared
node src\render\cli.ts verify  --home %USERPROFILE%
```

- 目标 `%USERPROFILE%\WorkBuddy\Claw\CODEBUDDY.md` 已存在时**必须加 `--adopt`**，否则拒绝；adopt 会先备份 `.bak-<时间>`；
- 名片从 `light/skill-cards/<名字>/SKILL.md` 复制到 `%USERPROFILE%\.workbuddy\skills\<名字>\SKILL.md`，并把 `{{vault_shared}}` 换成实际路径；
- 安装记录写到 `WorkBuddy\Claw\.anc-install.json`（persona 与每张名片的内容 hash）；
- `verify` 对拍记录：被手改或缺失即列出并以退出码 1 结束；
- 名片只放触发词与安全底线，正文留在共享区 `skills/`。

## 已实现 / 未实现

- 已实现：org 解析与校验（成员 id/文本字段/webhook 文件名）、公司/个人 persona 渲染、groups.json（members + 四类 groups）、指纹、长度闸门、原子写与备份（名字不撞、保留 10 份）、手改检测、个人接入包与技能名片（`--adopt` 闸门、`verify` 对拍）、**整组事务部署与回滚**（`deploy` / `rollback`，失败整体还原）；
- 未实现：渲染器自动把公司 persona 装到 WorkBuddy（仍由 `deploy-persona.ps1` 复制）；四类群的真实成员 API 校验。
- 现状说明：线上公司 bot 的 persona 由 `scripts/deploy/deploy-persona.ps1` 从 `light/personas/company-bot/CODEBUDDY.md` 部署；该文件已与 `light/templates/company-bot.md` 同步，但两者仍是两份正文。渲染器的 `company-bot/CODEBUDDY.md` 用于 `render deploy`/验证；合并成单一来源仍是一项收尾工作。

## 2. 入库进程

> 类型：接口契约（入库）

对应 [DECISIONS.md](./DECISIONS.md) §5.4 的入库管线与 D13。原则：**入库进程不调模型，只做确定性校验**；模型只负责在技能里把资料整理成结构化 markdown 并投进批次目录。

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
