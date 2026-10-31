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

原则（§5.5）：

- **「完成」与对应出站消息在同一个事务里提交**；重复点完成是幂等的，不会重复入队。
- **提醒只发到当天结束**，夜里不推送；取消/完成会连带把 `pending` 提醒置为 `cancelled`。
- **outbox 先入队再发**；发送前再扫一次凭据，扫描器异常就不发。

## 命令

```powershell
# 绑定（管理员；userid 用于提醒时 @ 人）
npm run service -- bind set --chat-id <chatid> --employee <姓名> --userid <企微 userid>
npm run service -- bind resolve --chat-id <chatid>
npm run service -- bind list

# 任务
npm run service -- task add --title "写周报" --chat-id <chatid> --assignee <姓名> --due "2026-10-31T09:00:00+08:00"
npm run service -- task list --status open
npm run service -- task done --id 1
npm run service -- task cancel --id 1

# 提醒
npm run service -- reminder due --now "2026-10-31T09:00:00+08:00"
npm run service -- reminder sent --id 1

# 出站
npm run service -- outbox list
npm run service -- outbox flush --webhook-file C:\ProgramData\anc\secrets\wecom-webhook.txt

# 循环：到期提醒入队并发出（--once 只跑一次，便于联调）
npm run service -- loop --once --webhook-file C:\ProgramData\anc\secrets\wecom-webhook.txt
npm run service -- loop --interval-ms 60000
```

所有命令支持 `--db <path>` 与 `--json`。默认库 `%USERPROFILE%\anc\anc.db`。

`loop` 每次 tick 做三件事：

1. 到期提醒 → 生成 outbox 消息（带绑定人的 `userid` 作为 `mentioned_list`），提醒标为已发（同日续排，跨天停）；
2. 有 webhook 文件 → 把 pending 消息发出去；失败的记 `last_error`，留在表里等下次；
3. 任务已完成/取消却还挂着的提醒 → 直接取消，不发。

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

- HTTP 接口与 token 校验、存活探测（§5.5，等 T17 定运行身份）；
- 常驻循环已有最小版（`loop`：扫到期提醒 → outbox → webhook，默认每分钟）；还缺 outbox 重试退避、附件清理、开机提醒、watchdog、以及注册成 Windows 服务/计划任务的实际落地；
- vault 内部区的 markdown 投影与 `reproject`；
- 规则冻结的 `policy_version` / `rule_content_hash` 目前只落字段，还没有规则源；
- 公司 bot 侧怎么调它（T6：skill → 脚本，或 JSON 投递目录）。

## 安全

- webhook 只从文件读，路径默认 `%ProgramData%\anc\secrets\wecom-webhook.txt`；不写入日志、不进 git。
- 出站凭据扫描覆盖：企微 webhook、app_secret/corpsecret、api_key、Bearer、Cookie、私钥、带口令的连接串、`sk-*`、`AKIA*`、`xox*-`、飞书 `cli_/ou_`。
- 数据库里只有任务与绑定关系；`*.db` 已在 `.gitignore`。
