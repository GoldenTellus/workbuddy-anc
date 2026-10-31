# 本地小服务（第一切片）

对应 [FORK-DIRECTION.md](./FORK-DIRECTION.md) §5.5 与 D10/D11。目标是把 WorkBuddy 里没有、又必须确定性的部分接过来：任务状态、提醒、outbox、群绑定。

**当前是第一切片**：SQLite 真相源 + 核心规则 + 命令行。还没有 HTTP 监听、守护进程、Windows 服务、vault 投影（`reproject`）、附件清理与 watchdog——那些等 T6/T17 落地后再加。

## 数据模型（SQLite）

| 表 | 作用 | 关键约束 |
|---|---|---|
| `chat_bindings` | chatid → 员工 | 管理员写；agent 只读；与 `scripts/anc-bind` 同一张表 |
| `tasks` | 任务 | `status` 只走 `open → done/cancelled`；完成/取消都写 `task_events` |
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
npm run service -- bind set --chat-id <chatid> --employee <姓名> --userid <企微 userid> --webhook-file wecom-webhook.txt
npm run service -- bind resolve --chat-id <chatid>
npm run service -- bind list

# 任务（时间用 --due-local 传本地时间，由 CLI 换算 UTC）
npm run service -- task add --title "写周报" --chat-id <chatid> --assignee <姓名> --assignee-userid <userid> --requester <姓名> --requester-userid <userid> --due-local "2026-10-31 09:00"
npm run service -- task list --status open
npm run service -- task done --id 1 --actor <userid>
npm run service -- task cancel --id 1 --actor <userid>

# 提醒
npm run service -- reminder due --now "2026-10-31T09:00:00+08:00"
npm run service -- reminder sent --id 1

# 出站
npm run service -- outbox list
npm run service -- outbox flush --webhook-file C:\ProgramData\anc\secrets\wecom-webhook.txt

# 循环：到期提醒入队并发出（--once 只跑一次，便于联调）
npm run service -- loop --once --webhook-file C:\ProgramData\anc\secrets\wecom-webhook.txt
npm run service -- loop --interval-ms 60000

# A2A（访谈/交回；信封先写文件，避开引号问题）
npm run service -- a2a create --survey <survey_id> --rule-version v1 --rule-file <问题清单.md> --expected <userid,...>
npm run service -- a2a submit --text-file <信封.json> --internal D:\anc\vault-internal --from-userid <userid>
npm run service -- a2a status --survey <survey_id>
npm run service -- a2a list --survey <survey_id>

# 工作时段（默认为全天，需管理员显式开启）
npm run service -- config list
npm run service -- config set --key work_start --value 09:00
npm run service -- config set --key work_end --value 18:00
npm run service -- config set --key weekdays --value 1-5
npm run service -- config set --key holidays --value 2026-10-01,2026-10-02
```

所有命令支持 `--db <path>` 与 `--json`。默认库 `%USERPROFILE%\anc\anc.db`。

`loop` 每次 tick 做四件事：

0. 昨天没完成、又没有 pending 提醒的任务 → 顺延到下一次同一时刻，并发一条「上次定在 … 没完成，已顺延到 …」；
0.5 到点但不在工作时段（`work_start`–`work_end`、`weekdays`、`holidays`）→ 改排到下一个工作时段起点，不打扰；默认是全天，需管理员显式开启；
1. 到期提醒 → 生成 outbox 消息（带绑定人的 `userid` 作为 `mentioned_list`），提醒标为已发（同日续排，跨天停）；
2. 连续 4 次没回应 → 在同一个群通知交办人一次（`escalate:<任务号>` 去重），之后每小时提醒一次；
3. 把到点且退避已过的 pending 消息发出去：按消息的 `chat_id` 查绑定，用绑定里的 `webhook_file`（默认 `wecom-webhook.txt`）去 `%ProgramData%\anc\secrets\` 找；失败的按 1/5/15/30/60 分钟退避，5 次后置 `failed`。

**权限**：`task done` / `task cancel` 必须带 `--actor <userid>`；只有任务的 `assignee_userid` 或 `requester_userid` 能操作，否则返回「只有执行人或交办人能操作这个任务」。未登记 userid 的旧任务不校验（兼容）。

**常驻**：主机上用计划任务 `anc-service`（`LOCAL SERVICE`，开机启动 + 每分钟跑一次 `loop --once`）。部署脚本与 ACL 见下节。

`outbox flush` 读的是**文件**里的 webhook（不接命令行明文），发给群机器人；返回 `errcode: 0` 才算成功。

## 运行要求

- Node 22 LTS（D11）。`node:sqlite` 在 Node 22 上要带 `--experimental-sqlite`；类型剥离在 Node 22.6+ 要带 `--experimental-strip-types`。Node 24 两者都默认可用，直接 `node src/service/cli.ts`。
- 零运行时依赖（只用 Node 内置模块）。

## 测试

```powershell
npm run test:service
```

覆盖：绑定增删查、完成与出站同事务、重复完成幂等、取消连带停提醒、提醒同日续/跨天停、outbox 去重、凭据拦截与脱敏。

## 还没做

- HTTP 接口与 token 校验、存活探测（§5.5）；
- 连续 4 次无回应 → 通知交办人、之后每小时提醒一次；未完成任务次日顺延并告知交办人；时区/工作时段/节假日配置；
- 附件清理、开机提醒、watchdog；Windows 服务形态（当前是计划任务 `anc-service`）；
- vault 内部区的 markdown 投影与 `reproject`；
- 规则冻结的 `policy_version` / `rule_content_hash` 目前只落字段，还没有规则源；
- 公司 bot 侧怎么调它（T6：skill → 脚本，或 JSON 投递目录）。

## 安全

- webhook 只从文件读，路径默认 `%ProgramData%\anc\secrets\wecom-webhook.txt`；不写入日志、不进 git。
- 出站凭据扫描覆盖：企微 webhook、app_secret/corpsecret、api_key、Bearer、Cookie、私钥、带口令的连接串、`sk-*`、`AKIA*`、`xox*-`、飞书 `cli_/ou_`。
- 数据库里只有任务与绑定关系；`*.db` 已在 `.gitignore`。
