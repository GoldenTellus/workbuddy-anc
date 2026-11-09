---
name: anc-executor
description: 公司 bot 的 Main 派发执行任务。发现队列里有 Ticket 时，用 executor CLI claim，随后用 Agent tool 起一个任务 subagent，收固定 JSON Report，再 notify/end。触发词：执行队列、派活、claim、executor、ticket、subagent、跑任务。
---

# anc-executor

任务状态在本地服务；**Main 是唯一活着的调度台**。本地服务不会开 WorkBuddy 对话，也不会替你调 Agent。

## 前置

- 当前 host 必须已经由部署/启动器注册为 `active`；不要自己编 `conversation_id`。
- 先查：

```powershell
node C:\ProgramData\anc\service\cli.ts --db C:\ProgramData\anc\data\anc.db --json executor host status
```

如果你在**新对话的首个 turn**，先用当前 conversation id 调 `executor host bootstrap`；它同一天同一对话幂等，跨日会自动把旧 host 置 closing、新 host 置 active。

03:00 新对话尚未出现时，外部 tick 调 `executor host tick`：旧 host 标记 `cut_deferred`，**继续接单**；不要把它当成切失败。

没有 active host：停，回报“执行 host 未注册”，不要猜测或新建对话。

## background 任务

background 任务不自动接。先由 Main 评估：谁要求的、是否在本部门授权范围内、优先级、预算；评估通过后再 `executor ticket create`。没有评估就不建 Ticket。

## 一个 tick

```powershell
node C:\ProgramData\anc\service\cli.ts --db C:\ProgramData\anc\data\anc.db --json executor claim --host-id <active_host_id> --limit 1
```

- `data: null`：队列空，本轮结束，不 sleep。
- 有返回：拿 `ticket` 和 `assignment`，不要绕过 assignment 自己找 Ticket。
- 人工回答/退回后续谈：`claim --slot human --ticket-id <ticket>`，只领这一条；先跑 `attention context` 把问答带进 prompt。

## 起 subagent

按 [subagent.md](./subagent.md) 生成 prompt，用 **Agent tool** 起任务 subagent：

```text
description: 执行 <ticket_id> <department_id>
prompt: <subagent.md 填充后的内容>
```

- 一个 Ticket 一个 subagent；不要按部门拆 subagent 类型。
- subagent 只做当前 Ticket；不直接进群、不 @ 人、不新开对话。
- 拿到 Agent id 后：

```powershell
node C:\ProgramData\anc\service\cli.ts --db C:\ProgramData\anc\data\anc.db --json executor start --assignment-id <assignment_id> --subagent-id <agent_id>
```

## 收 Report

subagent 必须返回一个 fenced JSON：

```json
{"type":"ready","summary":"...","evidence":["departments/<dept>/tasks/<ticket>/..."],"next_step":null}
```

解析失败就按 `failed` 处理，不猜成功。然后：

```powershell
node C:\ProgramData\anc\service\cli.ts --db C:\ProgramData\anc\data\anc.db --json executor report --assignment-id <assignment_id> --json-file <report.json>
node C:\ProgramData\anc\service\cli.ts --db C:\ProgramData\anc\data\anc.db --json executor end --assignment-id <assignment_id> --reason completed
```

需要对外发结果时，先 `executor notify --chat-id <原请求 chat> --text "<摘要>" --dedupe-key "exec:<ticket_id>"`，再 end；不要贴大文件/敏感内容。

## 需要人时建 Attention

`report` 之后按类型建 Attention；不要只发一条群消息就算通知。

```powershell
# ready → 交办人核查
node C:\ProgramData\anc\service\cli.ts --db C:\ProgramData\anc\data\anc.db --json executor attention create --purpose review --ticket-id <ticket> --required-confirmer <交办人 person_id> --question "<一句话：结果是否可以>"

# question → 能回答的人
node C:\ProgramData\anc\service\cli.ts --db C:\ProgramData\anc\data\anc.db --json executor attention create --purpose answer --ticket-id <ticket> --required-confirmer <能回答的人 person_id> --question "<next_step 里的问题>"

# 责任交接：默认只通知；三类才加 --require-ack
node C:\ProgramData\anc\service\cli.ts --db C:\ProgramData\anc\data\anc.db --json executor attention create --purpose responsibility --ticket-id <ticket> --required-confirmer <接手人 person_id> --question "<交接说明>" [--require-ack]
```

- `review`：`ready` 默认要人核查；低风险自用任务可以直接 `executor close --decision done` 并记理由，不硬造 Attention。交办人用 `task get --id <task_id>` 取 `requester_id`。
- `answer`：`question` Report 后建；`required-confirmer` 选最懂这个事实的人，不要默认发给老板。
- `responsibility`：默认 `require_ack=0`；责任从 bot 转给具体人、跨部门交接、对外/财务/生产变更时才加 `--require-ack`。
- 老板可直接确认任何 Attention；CLI 自动记 `on_behalf_of`。
- 人回答后：`executor attention context --ticket-id <ticket>` → `claim --slot human --ticket-id <ticket>` → 起 subagent，把问答放进 prompt。

## 边界

- 不调用本地服务来创建 WorkBuddy 对话；不假设子 agent 可恢复。
- 失败/超时就写 `failed` 或让 scheduler `interrupt`，不要静默重试。
- 03:00 日切由 host 生命周期处理；旧 host running assignment 不迁移。
