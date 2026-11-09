# 本地小服务

> 类型：接口契约（现行）

对应 [DECISIONS.md](./DECISIONS.md) §5.5 与 D10/D11。目标是把 WorkBuddy 里没有、又必须确定性的部分接过来：任务状态、提醒、outbox、群绑定。

**当前已落地**：SQLite 真相源、17 组命令、HTTP 面（`serve`）、任务投影（`project`）、常驻 `loop`、A2A 访谈归档、迭代闭环。**没有** Windows 服务形态（用计划任务 `anc-service` 每分钟跑 `loop --once`）；发送队列的多进程协调靠 SQLite 领取，不靠进程间锁。

## 数据模型（SQLite）

| 表 | 作用 | 关键约束 |
|---|---|---|
| `people` | 人 → 角色/部门/userid | `person_id` 主键；`system_role`: boss/manager/employee；`userid` 唯一 |
| `groups` | 群 → 类型/员工/部门/webhook | `type`: employee/department/company/boss_dm；employee 群必须有 employee_id，department 群必须有 dept_id |
| `manager_scopes` | 管理者 → 部门 | 多对多；管理者范围以此为准 |
| `chat_bindings` | 员工群 chatid → 员工 | 兼容层；管理员写、agent 只读；`bind sync-org`/`backfill` 双写 |
| `tasks` | 任务 | `status`: open / pending_approval / pending_acceptance / done / cancelled / rejected / needs_review；完成/取消都写 `task_events` |
| `task_events` | 事件流 | 只追加，不修改 |
| `reminders` | 提醒 | 一个任务同时只有一条 `pending`；同日按 `repeat_minutes` 续，跨天停 |
| `outbox` | 出站消息 | `dedupe_key` 唯一；入队前过凭据扫描 |
| `config` | 工作时段/节假日 | `work_start` / `work_end` / `weekdays`（1–7）/ `holidays`（逗号分隔日期）；默认全天 |
| `a2a_surveys` | 调查（访谈） | `rule_version` + `rule_hash` 冻结规则；`expected` 是应交回的人员 |
| `a2a_messages` | 交回的信封 | 按 `message_id` 去重；文件归档在内部区 `surveys/<survey_id>/` |

原则（§5.5）：

- **「完成」与对应出站消息在同一个事务里提交**；重复点完成是幂等的，不会重复入队。
- **提醒只发到当天结束**，夜里不推送；取消/完成会连带把 `pending` 提醒置为 `cancelled`。
- **outbox 先入队再发**；发送前再扫一次凭据，扫描器异常就不发。

## 命令

```powershell
# 绑定（管理员；userid 用于提醒时 @ 人，webhook-file 是该群自己的密钥文件名）
npm run service -- bind set --chat-id <chatid> --employee <姓名> --userid <企微 userid> --webhook-file hook-<姓名拼音>.txt
npm run service -- bind resolve --chat-id <chatid>
# 主干 1：群 + 人 + 角色 + 管理者范围（bot 每轮先查这个）
npm run service -- bind actor --chat-id <chatid> --userid <userid>
npm run service -- bind list

# 主干 1：org → people/groups/manager_scopes（同时双写 chat_bindings 兼容旧技能）
npm run service -- bind sync-org --org <org 目录>
# 校验 org 与库里 people/groups/manager_scopes 是否漂移；有差异退出 1
npm run service -- bind verify-org --org <org 目录>
# 旧库回填：chat_bindings → groups(type=employee)，按 userid 匹配 people，不猜未知人
npm run service -- bind backfill
# 非员工群：company / department / boss_dm
npm run service -- bind group-set --chat-id <chatid> --type company --webhook-file hook-company.txt
npm run service -- bind group-set --chat-id <chatid> --type department --dept-id sales --name 销售部 --webhook-file hook-dept-sales.txt
npm run service -- bind group-set --chat-id <chatid> --type boss_dm --name 老板1:1 --webhook-file hook-boss.txt
npm run service -- bind group-list [--type department]
npm run service -- bind person-list

# 主干 2：Executor 调度（T2.3，先落 CLI；Runner 仍由 Main 接）
npm run service -- --json executor host bootstrap --conversation-id <conv-id> --date 2026-11-09 --cut-at "2026-11-10T03:00:00+08:00"
npm run service -- --json executor host tick --now "2026-11-10T03:00:00+08:00"
npm run service -- --json executor host register --conversation-id <conv-id> --date 2026-11-09 --cut-at "2026-11-10T03:00:00+08:00"
npm run service -- --json executor host cut --old-host <host-id> --new-conversation-id <new-conv-id> --date 2026-11-10
npm run service -- --json executor host status
npm run service -- --json executor ticket create --task-id <n> --department-id sales --title "整理报价"
npm run service -- --json executor ticket list [--state queued]
npm run service -- --json executor claim --host-id <host-id> [--slot human] [--limit 1]
npm run service -- --json executor start --assignment-id <id> --subagent-id <agent-id>
npm run service -- --json executor report --assignment-id <id> --json-file <report.json>
npm run service -- --json executor report --assignment-id <id> --type ready --summary "完成"
npm run service -- --json executor notify --chat-id <chatid> --text "结果摘要" [--dedupe-key <key>]
npm run service -- --json executor recover --host-id <old-host> --reason host-restart
npm run service -- --json executor end --assignment-id <id> --reason completed

# 本地摘要（D19/C13）：正文不出本机。只读文件、按规则抽要点，不调模型、不发网络请求
npm run service -- --json summary --path <vault 里的 .md> [--max-lines 8] [--max-chars 160]
# 按关键词在 vault 里定位（标题命中优先），每条给路径 + 摘要；不带 --root 时用 config 里的两个 vault
npm run service -- --json summary --find <关键词> [--root <目录>] [--max-docs 5]

# 任务（时间用 --due-local 传本地时间，由 CLI 换算 UTC）
# 带 --requester-id/--assignee-id 时服务端校验派活权限：老板全局、管理者本部门、员工只能给自己
npm run service -- task add --title "写周报" --chat-id <chatid> --assignee <姓名> --assignee-userid <userid> --requester <姓名> --requester-userid <userid> --due-local "2026-10-31 09:00" [--requester-id <person_id> --assignee-id <person_id> --dept-id <dept>]
# 主干 1：员工请求同事；跨部门会自动要求先审批
npm run service -- task request --title "帮我看下报价" --requester-id <person_id> --assignee-id <person_id> --chat-id <origin_chat> [--requires-approval]
npm run service -- task approve --id <n> --approver-id <manager_person_id>
npm run service -- task accept --id <n> --assignee-id <person_id>
npm run service -- task reject --id <n> --actor-id <person_id> --reason "没资源"
# 通知链：请求→执行人；跨部门→执行人部门管理者；批准→执行人；接受/拒绝→交办人。通知走 outbox，发到对方员工群。
# 后台任务（D22）：执行器仍是 WorkBuddy，小服务只管超时；start 由 bot 动手时调一次
npm run service -- task add --title "跑月度汇总" --chat-id <chatid> --requester <姓名> --requester-userid <userid> --kind background --timeout 30
npm run service -- task start --id 9
npm run service -- task review --id 9 --decision retry --actor <userid>   # 超时后：retry 重排 / close 关掉
npm run service -- task list --status open
npm run service -- task list --status needs_review
npm run service -- task done --id 1 --actor <userid>
npm run service -- task cancel --id 1 --actor <userid>

# 提醒
npm run service -- reminder due --now "2026-10-31T09:00:00+08:00"
npm run service -- reminder sent --id 1

# 出站
npm run service -- outbox list
npm run service -- outbox flush    # 与 loop 同一套：按每条消息的群绑定选 webhook

# 循环：到期提醒入队并发出（--once 只跑一次）
npm run service -- loop --once
# 联调单个群：--webhook-file 必须配 --chat-id，只发这个群的消息
npm run service -- loop --once --chat-id <chatid> --webhook-file C:\ProgramData\anc\secrets\<该群>.txt
npm run service -- loop --interval-ms 60000

# A2A（访谈/交回；信封先写文件，避开引号问题）
npm run service -- a2a create --survey <survey_id> --rule-version v1 --rule-file <问题清单.md> --expected <userid,...> --questions 11
npm run service -- a2a submit --text-file <信封.json> --internal D:\anc\vault-internal --from-userid <userid>
npm run service -- a2a status --survey <survey_id>
npm run service -- a2a list --survey <survey_id>

# 工作时段（默认为全天，需管理员显式开启）
npm run service -- config list
npm run service -- config set --key work_start --value 09:00
npm run service -- config set --key work_end --value 18:00
npm run service -- config set --key weekdays --value 1-5
npm run service -- config set --key holidays --value 2026-10-01,2026-10-02
# 时区必须是 Windows 时区 Id（Get-TimeZone 查当前值）；IANA 名（Asia/Shanghai）会被拒
npm run service -- config set --key timezone --value "China Standard Time"
# 内部区绝对路径：投影与 A2A 都往这里落
npm run service -- config set --key vault_internal --value D:\anc\vault-internal

# 任务投影：SQLite → 内部区 collab/tasks.md（配置了 vault_internal 时 loop 每次 tick 顺手更新）
npm run service -- project
npm run service -- project --check      # 只校验：投影缺失/被手改/库变了没重投影 → 非 0
npm run service -- project --rebuild    # 删了重建（从库恢复视图）

# HTTP 面（长驻；只监听 127.0.0.1:17891）
npm run service -- serve
# token 在 %ProgramData%\anc\secrets\service-token.txt；未配置时业务路由全 503，只有 /__anc_health 可用
```

> **`timezone` 是部署一致性断言**：只用于 `doctor` 校验主机系统时区是否等于配置值，
> **不参与运行时时间计算**（`isWorkTime` / 提醒排期 / `localDay` 一律按主机系统本地时区）。
> 改它不会改变行为；要让提醒换时区，得改主机系统时区。见 `ACCEPTANCE S-5`、`VERIFY §87 #1`。

所有命令支持 `--db <path>` 与 `--json`。默认库 `%ProgramData%\anc\data\anc.db`（可用 `--db` 或环境变量 `ANC_DB` 覆盖）。

`loop` 每次 tick 做四件事：

0. 昨天没完成、又没有 pending 提醒的任务 → 顺延到下一次同一时刻，并发一条「上次定在 … 没完成，已顺延到 …」；
0.5 到点但不在工作时段（`work_start`–`work_end`、`weekdays`、`holidays`）→ 改排到下一个工作时段起点，不打扰；默认是全天，需管理员显式开启；
1. 到期提醒 → 生成 outbox 消息（带绑定人的 `userid` 作为 `mentioned_list`），提醒标为已发（同日续排，跨天停）；
2. 连续 4 次没回应 → 在**交办人自己的群**（按 `requester_userid` 反查绑定）通知交办人一次（`escalate:<任务号>` 去重；查不到交办人的群才退回任务所在群，并记 `escalate_no_group` 事件），之后每小时提醒一次（下一次直接排到一小时后）；
   顺延和升级这类系统主动发的通知，在非工作时段入队时最早可发时间排到下一个工作起点，夜里不推；
3. 把到点且退避已过的 pending 消息发出去：按消息的 `chat_id` 查 `chat_bindings`；员工群优先用绑定的 `webhook_file`，公司/部门/`boss_dm` 群 fallback 到 `groups.webhook_file`，再去 `%ProgramData%\anc\secrets\` 找（只能是纯文件名：字母数字 `._-`、`.txt` 结尾）。**两类都查不到时标 `NO_WEBHOOK_FOR_CHAT` 失败，不退回任何默认群**。发送前先「领取」（`pending → sending`），重叠的 tick 或 `outbox flush` 不会重复发；领取后 10 分钟没回写的视为发送方退出、可重领。到点提醒有一小时有效期，迟到超过就标 `EXPIRED` 不补发。`last_error` 进库前去掉 URL 与文件原文；失败的按 1/5/15/30/60 分钟退避，5 次后置 `failed`（网络类含超时给 10 次；开机后网络类失败**每条只回收一次**，不会每分钟重置）。

**权限**：`task done` / `task cancel` 必须带 `--actor <userid>`；只有任务的 `assignee_userid` 或 `requester_userid` 能操作，否则返回「只有执行人或交办人能操作这个任务」。`task add` 必须带 `--requester-userid`（消息前缀里的 `from`），`--due-local` 必须是完整的 `YYYY-MM-DD HH:mm`；带 `--requester-id`/`--assignee-id` 时写新角色字段。`task request` 由 `--requester-id`/`--assignee-id` 驱动：同部门 `pending_acceptance`，跨部门 `pending_approval`；`task approve` 校验执行人部门管理者/老板，`task accept` 校验执行人，`task reject` 必须带原因。两个 userid 都没登记的旧任务仍不校验（兼容存量数据）；`actor` 来自模型从前缀里抄的 `from`，可信度取决于 D17 补丁（伪造前缀已在补丁里中和）。

**常驻**：主机上用计划任务 `anc-service`（`LOCAL SERVICE`，开机启动 + 每分钟跑一次 `loop --once`）。部署脚本与 ACL 见下节。

`outbox flush` 与 `loop` 走同一段发送逻辑：webhook 只从 secrets 目录的**文件**读（不接命令行明文），按群选择；返回 `errcode: 0` 才算成功。

## 运行要求

- Node 22 LTS（D11）。实测 v22.22.2 起 `node:sqlite` 与类型剥离均默认可用，直接 `node src/service/cli.ts`（`process.features.typescript === 'strip'`）；更老的 22.x 才需 `--experimental-sqlite --experimental-strip-types`。
- 零运行时依赖（只用 Node 内置模块）。

## 测试

```powershell
npm run test:service
```

覆盖：绑定增删查、完成与出站同事务、重复完成幂等、取消连带停提醒、提醒同日续/跨天停、outbox 去重、凭据拦截与脱敏。

## 还没做

- Windows 服务形态（当前是计划任务 `anc-service` 每分钟跑一次 `loop --once`，外加常驻的 `anc-http`）；
- 发送队列的**多进程**协调（同一时刻只靠 SQLite 的领取保证不重复发；已用两个连接验证"只有一个拿到"）。

## 安全

- webhook 只从 `%ProgramData%\anc\secrets\<群的文件名>.txt` 读，没有全局默认；不写入日志、不进 git。
- 出站凭据扫描覆盖：企微 webhook、app_secret/corpsecret、api_key、Bearer、Cookie、私钥、带口令的连接串、`sk-*`、`AKIA*`、`xox*-`、飞书 `cli_/ou_`。
- 数据库里只有任务与绑定关系；`*.db` 已在 `.gitignore`。
