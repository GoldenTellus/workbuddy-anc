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

没有 active host：停，回报“执行 host 未注册”，不要猜测或新建对话。

## 一个 tick

```powershell
node C:\ProgramData\anc\service\cli.ts --db C:\ProgramData\anc\data\anc.db --json executor claim --host-id <active_host_id> --limit 1
```

- `data: null`：队列空，本轮结束，不 sleep。
- 有返回：拿 `ticket` 和 `assignment`，不要绕过 assignment 自己找 Ticket。

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

## 边界

- 不调用本地服务来创建 WorkBuddy 对话；不假设子 agent 可恢复。
- 失败/超时就写 `failed` 或让 scheduler `interrupt`，不要静默重试。
- 03:00 日切由 host 生命周期处理；旧 host running assignment 不迁移。
