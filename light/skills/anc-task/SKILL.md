---
name: anc-task
description: 公司任务的登记、查询、请求、审批、接受、完成与取消。用户在群里说「提醒我 / 登记任务 / 今天有什么任务 / 让某人帮忙 / 批准 / 接受 / #号任务完成 / 取消任务」时使用。触发词：登记任务、提醒我、今天任务、我的任务、请求同事、审批、接受、拒绝、完成任务、取消任务、task。
---

# anc-task

任务状态以本地小服务（SQLite）为准，不靠对话记忆。数据库固定为 `C:\ProgramData\anc\data\anc.db`，命令里一律显式带上 `--db`。

## 先确认当前群和人

每条消息开头有 `[anc:chat=<chatid> from=<userid>]`。先查 actor：

```powershell
node C:\ProgramData\anc\service\cli.ts --db C:\ProgramData\anc\data\anc.db --json bind actor --chat-id <chatid> --userid <from>
```

- 返回 `group.type`：`employee` / `department` / `company` / `boss_dm`；
- 返回 `person.system_role`：`boss` / `manager` / `employee`；
- 管理者额外返回 `manager_scopes`（管的部门）。
- 查不到：按「未识别」处理，回「这个群/这个人还没识别，请管理员先同步 org」，不要猜人。

角色边界：

- **老板**：全局，可派给任何人、审批任何跨部门请求；
- **管理者**：本部门，可派给本部门员工、审批本部门为执行人的跨部门请求；
- **员工**：只能给自己建任务；请同事走 `task request`，不能直接派活。

目标人用 `bind person-list` 按姓名/ID 找；同名或找不到就先问，不要猜。

## 登记任务

### 直接登记（老板 / 管理者 / 自己）

```powershell
node C:\ProgramData\anc\service\cli.ts --db C:\ProgramData\anc\data\anc.db --json task add --title "<事项>" --chat-id <chatid> --requester-id <当前 person_id> --assignee-id <目标 person_id> --dept-id <目标部门> --requester "<姓名>" --assignee "<姓名>" --requester-userid <当前 userid> --assignee-userid <目标 userid> --due-local "<YYYY-MM-DD HH:mm>"
```

- 老板可把 `--assignee-id` 设为任何人；管理者只能设本部门；员工只能设自己。
- **时间用 `--due-local` 传本地时间**（如 `2026-10-31 17:30`），由命令行换算成 UTC；不要自己写 ISO 或做时区换算。
- 用户只说「下午三点」就先问清是哪天，不要自行猜。
- 回显用返回里的 `due_local`，例如「已登记 #3：2026-10-31 17:30 提醒你喝水」。
- 同一群已有未完成任务时，先列出来让用户确认是哪一条，不要靠猜新建重复任务。

## 请求同事

```powershell
node C:\ProgramData\anc\service\cli.ts --db C:\ProgramData\anc\data\anc.db --json task request --title "<事项>" --requester-id <当前 person_id> --assignee-id <目标 person_id> --chat-id <origin_chat>
```

- 同部门：直接 `pending_acceptance`，对方接受后变 `open`；
- 跨部门：先 `pending_approval`，执行人部门管理者批准后转 `pending_acceptance`，再由执行人接受；
- 不要替员工绕过审批直接 `task add` 给别人。

## 审批 / 接受 / 拒绝

```powershell
node C:\ProgramData\anc\service\cli.ts --db C:\ProgramData\anc\data\anc.db --json task approve --id <N> --approver-id <当前 person_id>
node C:\ProgramData\anc\service\cli.ts --db C:\ProgramData\anc\data\anc.db --json task accept --id <N> --assignee-id <当前 person_id>
node C:\ProgramData\anc\service\cli.ts --db C:\ProgramData\anc\data\anc.db --json task reject --id <N> --actor-id <当前 person_id> --reason "<原因>"
```

- 审批人必须是执行人部门的管理者，或老板；服务端会校验。
- 只有执行人能 `accept`；拒绝必须带原因。
- 待审批/待接受的任务不能直接完成；先接受。

## 查任务

```powershell
node C:\ProgramData\anc\service\cli.ts --db C:\ProgramData\anc\data\anc.db --json task list --chat-id <chatid> --status <open|pending_approval|pending_acceptance|done|cancelled|rejected|needs_review>
```

- 只列当前人/当前群有权限看的任务；老板/管理者按范围，员工只看自己的。
- 一个人有多条待办时，先列出来问是哪一条。

## 完成 / 取消

```powershell
node C:\ProgramData\anc\service\cli.ts --db C:\ProgramData\anc\data\anc.db --json task done --id <N> --chat-id <chatid> --actor <from>
node C:\ProgramData\anc\service\cli.ts --db C:\ProgramData\anc\data\anc.db --json task cancel --id <N> --actor <from>
```

- 服务端会校验：只有 `assignee_userid` / `requester_userid` 能操作；被拒绝时原样转告「只有执行人或交办人能操作这个任务」。
- 待审批/待接受的任务可取消；已拒绝的任务不重复操作。

## 输出与边界

- 只调用上面的 CLI，不要直接读写 SQLite，也不要改服务端文件。
- 把 JSON 结果转成中文短句回给用户，不要贴原始 JSON。
- 失败时原样转告错误信息，不要臆断原因。
