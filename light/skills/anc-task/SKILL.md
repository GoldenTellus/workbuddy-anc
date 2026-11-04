---
name: anc-task
description: 公司任务的登记、查询、完成与取消。用户在群里说「提醒我 / 登记任务 / 今天有什么任务 / #号任务完成 / 取消任务」时使用。触发词：登记任务、提醒我、今天任务、我的任务、完成任务、取消任务、task。
---

# anc-task

任务状态以本地小服务（SQLite）为准，不靠对话记忆。数据库固定为 `C:\ProgramData\anc\data\anc.db`，命令里一律显式带上 `--db`。

## 先确认这个群是谁

每条消息开头有 `[anc:chat=<chatid> from=<userid>]`。先查绑定：

```powershell
node C:\ProgramData\anc\service\cli.ts --db C:\ProgramData\anc\data\anc.db --json bind resolve --chat-id <chatid>
```

- 查到：`employee` 是本群主人，`userid` 是他本人；
- 查不到：按「未绑定」处理，回「这个群还没绑定员工，请管理员先绑定」，不要猜人。

## 登记任务

```powershell
node C:\ProgramData\anc\service\cli.ts --db C:\ProgramData\anc\data\anc.db --json task add --title "<事项>" --chat-id <chatid> --assignee "<本群主人>" --assignee-userid "<绑定的 userid>" --requester "<发起人>" --requester-userid "<from>" --due-local "<YYYY-MM-DD HH:mm>"
```

- **时间用 `--due-local` 传本地时间**（如 `2026-10-31 17:30`），由命令行换算成 UTC；不要自己写 ISO 或做时区换算。
- 用户只说「下午三点」就先问清是哪天，不要自行猜。
- 回显用返回里的 `due_local`，例如「已登记 #3：2026-10-31 17:30 提醒你喝水」。
- 同一群已有未完成任务时，先列出来让用户确认是哪一条，不要靠猜新建重复任务。
- 查不到绑定时：仍可按用户明确要求登记，但 `--assignee`/`--assignee-userid` 留空，并在回显里注明「本群未绑定员工，提醒不会 @ 人」。

## 查任务

```powershell
node C:\ProgramData\anc\service\cli.ts --db C:\ProgramData\anc\data\anc.db --json task list --chat-id <chatid> --status open
```

## 完成 / 取消

```powershell
node C:\ProgramData\anc\service\cli.ts --db C:\ProgramData\anc\data\anc.db --json task done --id <N> --chat-id <chatid> --actor <from>
node C:\ProgramData\anc\service\cli.ts --db C:\ProgramData\anc\data\anc.db --json task cancel --id <N> --actor <from>
```

- 服务端会校验：只有 `assignee_userid` 或 `requester_userid` 能操作；被拒绝时原样转告「只有执行人或交办人能操作这个任务」。

## 输出与边界

- 只调用上面的 CLI，不要直接读写 SQLite，也不要改服务端文件。
- 把 JSON 结果转成中文短句回给用户，不要贴原始 JSON。
- 失败时原样转告错误信息，不要臆断原因。
