# Main ↔ Executor 契约（主干 2）

> 类型：接口契约（现行；executor 侧已实现（本机 2026-11-09 部署通过），Main 行为由 `light/skills/anc-executor` 落地）
> 最后整理：2026-11-09
> 上游：[FUTURE-DESIGN.md](./FUTURE-DESIGN.md) 主干 2 / [PLAN.md](./PLAN.md) T2.1–T2.5
> 参考：[upstreams/dsh-superagent.md](./upstreams/dsh-superagent.md)（只借模型，不拷贝代码）

## 0. 边界

```text
WorkBuddy 日对话（Main，唯一 live host）
  │  调本地 CLI：claim / start / report / end
  ▼
本地服务（SQLite：ExecutorHost / Ticket / Assignment / Report）
  │  只存状态、排队列、校验状态机
  │  不创建 WorkBuddy 对话、不直接调 Agent
  ▼
Main 用 WorkBuddy Agent tool 起 subagent
  └─ subagent 只做当前 Ticket，返回固定 JSON
```

**一句话**：本地服务是账本和调度器，Main 是唯一执行者；subagent 由 Main 用 Agent tool 启动，不由本地服务启动。

## 0.1 background 任务

background 任务**不自动接单**。候选先由 Main 评估，决定是否建 Ticket、优先级和授权；`executor` 只接收已经授权的 Ticket。夜里没有消息时由 wake 触发 Main 评估，不绕过 Main 直接派活。

### 评估输入

```text
task 行（title / requester_id / assignee_id / dept_id / due_at / kind=background）
请求人角色与部门范围
已有 Ticket / Assignment（去重）
当前 slot（4 normal + 1 human）
授权默认值（tools / vault_paths / budget / max_attempts / expires_at，见 §2.2）
```

### 硬门槛（任一不过就不接）

1. 请求人已登记、在职，且有权发起 background 任务；
2. 标题不是空话，至少能说清“交付物”或“验收标准”；
3. `dept_id` 明确，数据级别允许进入该部门任务目录；
4. 同一 `task_id` 没有已存在的 open Ticket；
5. 当前工具/路径授权足以完成；不需要 Main 临时提权；
6. 预计不会产生未授权的外部副作用（发群、写共享区、动钱、动生产）。
7. 有可用 slot；没有就排队，不抢占。

### 判断（硬门槛之后）

| 维度 | 判断 |
|---|---|
| 价值 | 做了是否解决一个真实问题；没有交付物就 `defer`/`ask` |
| 风险 | 外部可见、跨部门、写共享区、凭据/财务 → `ask`，不直接接 |
| 优先级 | P0 老板 / P1 管理者 / P2 员工 / P3 系统；同层按截止时间 |
| 成本 | 预计超时、需要多轮工具、依赖外部系统 → 降级或 `defer` |
| 可验证 | 有没有明确产物/证据路径；没有就 `ask` |

### 决策输出

```json
{
  "decision": "accept | defer | ask | reject",
  "reason": "一句话",
  "priority": "P0..P3",
  "ticket": {
    "title": "...",
    "task_id": 12,
    "department_id": "sales",
    "tools": ["read", "write"],
    "vault_paths": ["departments/sales/..."],
    "budget": {"max_minutes": 30},
    "max_attempts": 3
  }
}
```

- `accept`：才建 Ticket；
- `defer`：任务保持候选，下一次 wake 再评估；
- `ask`：需要人补充信息/确认，进主干 3 的 Attention；
- `reject`：说明原因，不静默取消。

默认策略：**不确定就 `ask` 或 `defer`，不猜、不自动接。**

### 当前实现边界

评估流程是 Main 技能行为；每次判断用 `executor evaluate` 落 `executor_evaluations`，形成可追溯记录。`GAP-008` 设计已定，评估记录已落；自动评估器仍未做。

## 0.2 Main brief

Main 每轮先跑：

```text
node src/service/cli.ts --json executor brief
```

返回 active host、queued、waiting_review、blocked、background 候选；再按 §0.1 评估。`brief` 只提供事实，不替 Main 做判断。

## 1. Main 的一个 tick

```text
1. 收到群消息 / 定时唤醒
2. executor claim --host-id <id> --slot normal --limit 1
3. 有 assignment：
   a. 用 Agent tool 起 subagent（prompt 里带 ticket/assignment/任务目录）
   b. executor start --assignment-id <id> --subagent-id <agent-id>
4. subagent 返回 JSON Report
5. executor report --assignment-id <id> --json-file <report.json>
6. executor end --assignment-id <id> --reason completed
7. 回到 2，直到没有空槽或没有任务
```

- Main **不等待**长任务：subagent 用后台 Agent 运行；完成后再 report。
- 没有任务时 `claim` 返回 `data: null`，不阻塞、不 sleep。
- 一个 tick 最多 claim `normal limit` 个；human slot 单独走 `--slot human`。

## 2. CLI 命令（现行）

所有命令支持 `--db` / `--json`，退出码 0 成功、1 业务拒绝、2 参数/环境错误。

### 2.1 Host

```powershell
# 新对话首个 turn：幂等注册/日切（推荐）
node src/service/cli.ts --json executor host bootstrap `
  --conversation-id <WorkBuddy conversation id> `
  --date 2026-11-09 `
  --cut-at "2026-11-10T03:00:00+08:00"

# 03:00 没有新对话：旧 host 继续接单，标记 deferred（自动兜底）
node src/service/cli.ts --json executor host tick --now "2026-11-10T03:00:00+08:00"

# 或者显式注册当天 host（已有 active host 时拒绝）
node src/service/cli.ts --json executor host register `
  --conversation-id <WorkBuddy conversation id> `
  --date 2026-11-09 `
  --cut-at "2026-11-10T03:00:00+08:00"

# 03:00 日切：旧 host closing + 新 host active
node src/service/cli.ts --json executor host cut `
  --old-host <host_id> `
  --new-conversation-id <new conversation id> `
  --date 2026-11-10

node src/service/cli.ts --json executor host status
```

- `host register` 校验只允许一个 `active`；若已有 active，返回 409。
- `host cut` 原子完成：旧 host `active → closing`、`accepting_new=0`；新 host `active`。
- 旧 host 只收尾；`claim` 只能拿新 host 的 queued Ticket。

### 2.2 Claim / start

```powershell
node src/service/cli.ts --json executor claim `
  --host-id <host_id> --slot normal --limit 1

node src/service/cli.ts --json executor start `
  --assignment-id <assignment_id> --subagent-id <agent-id>
```

`claim` 返回：

```json
{
  "ok": true,
  "data": {
    "host": { "host_id": "h-...", "status": "active" },
    "ticket": {
      "ticket_id": "t-...",
      "task_id": 12,
      "department_id": "sales",
      "title": "整理报价",
      "state": "queued",
      "priority": "P1",
      "task_dir": "departments/sales/tasks/t-..."
    },
    "assignment": {
      "assignment_id": "a-...",
      "slot": "normal",
      "state": "pending"
    },
    "prompt": {
      "ticket": { "...": "..." },
      "report_schema": { "...": "..." }
    }
  }
}
```

- `claim` 原子创建 `pending` Assignment，并保留 slot；唯一索引保证一个 Ticket 只有一个 active Assignment。
- `pending` 超过 60 秒未 `start`，回到 `queued`，Assignment 标 `failed`（reason `start-timeout`）。
- `start` 只能把 `pending → running`；重复 start 幂等返回当前状态。

**Ticket 授权字段（GAP-054 / D31）**：DDL 兜底默认值为 `tools=[]`、`vault_paths=[]`、`budget=null`、`max_attempts=3`、`expires_at=null`（`src/core/schema.ts` 的 `tickets` 段）。**这些默认值不是授权**——Main 每次派单建 Ticket 时必须显式填写上述字段，并在决策输出与 claim 返回里展示；不得先建空授权 Ticket、再靠 DDL 默认值放行。

### 2.2.1 Task ↔ Ticket 映射（GAP-034）

- `tickets.task_id → tasks.id` 是唯一关联（外键）；Ticket 是 Task 的执行单元，一个 Task 可以有多个历史 Ticket，同一 Task 不并存两个 open Ticket 由 Main 派单去重保证。
- Ticket 状态机**不反向覆盖** Task 状态；Task 沿用现行 `tasks.status`（`open / pending_approval / pending_acceptance / done / cancelled / rejected / needs_review`，见 [LOCAL-SERVICE.md](./LOCAL-SERVICE.md) 数据模型）。
- 完成 / 取消仍由 `task` 命令判定，Ticket 的 `done / failed` 只是执行证据。
- 完整双向映射、状态机统一与数据迁移归**主干 2 后续**（GAP-034，不假关）。

### 2.3 Report / end

```powershell
node src/service/cli.ts --json executor report `
  --assignment-id <assignment_id> `
  --json-file D:\anc\reports\<assignment>.json

node src/service/cli.ts --json executor notify `
  --chat-id <chatid> --text "<result summary>" [--dedupe-key <key>]

# 进程重启后，旧 host 的 pending/running 统一中断并回到队列
node src/service/cli.ts --json executor scope --ticket-id <ticket>

node src/service/cli.ts --json executor expire --now "<now>"

node src/service/cli.ts --json executor sweep --now "<now>" --grace-minutes 10

node src/service/cli.ts --json executor recover --host-id <old-host> --reason host-restart

node src/service/cli.ts --json executor end `
  --assignment-id <assignment_id> --reason completed
```

`report` 只追加 Report，并按类型推进 Ticket；`end` 只结束 Assignment：

```text
report progress → Ticket state 不变
report waiting  → waiting_trigger
report question → waiting_answer
report ready    → waiting_review
report blocked  → blocked
report failed   → failed
report dropped  → done
```

- `report` 成功但 `end` 未调用：Assignment 仍 `running`，防止 host 重复派活；恢复时按超时/人工处理。
- `end` 只能从 `running → ended`；`interrupted/failed/cancelled` 是调度器/人工的终态。
- 迟到 Report（Assignment 已不是 active）只记录，不覆盖 Ticket 当前状态。

**投递语义（GAP-055 / D31）：at-least-once**

- Main ↔ 本地服务**没有独立 ack**：`claim` 返回 Assignment 即视为投递；Main 崩溃后同一 Ticket 可能被再次 claim，靠下面的幂等收敛。
- `claim` / `start` / `report` / `end` 全部幂等：重复 `start` 不新建 Assignment（返回当前状态）；同一 running Assignment 重复 `report` 目前允许多条（GAP-071 待补）；已结束 Assignment 的迟到 Report 记 `late=1`，只留证不推进 Ticket。
- 迟到 Report（Assignment 已结束/被接管）记 `reports.late=1`，**只留证**：不覆盖新 Assignment 状态，也不覆盖 Ticket 当前状态。

### 2.4 Human slot

```powershell
node src/service/cli.ts --json executor claim `
  --host-id <host_id> --slot human --limit 1 [--ticket-id <ticket>]
```

- human slot 只 claim **已有 Ticket** 的人工回复/续谈，不接新 Ticket。
- 带 `--ticket-id` 时只领这一条，并要求该 Ticket 已有 `answered` / `rejected` 的 Attention；没有就报 `EXEC_HUMAN_NO_INPUT`。
- human-slot Assignment 不计入 `max_attempts`；三轮问答不会把 Ticket 跑成 `failed`。
- 新任务只走 normal slot；human slot 空闲也不能被新任务占用。

## 2.5 Attention（主干 3）

```powershell
# 建：Main 判断需要人回答/核查/接手时
node src/service/cli.ts --json executor attention create `
  --purpose answer|review|responsibility `
  --question "<一句话问题>" `
  --required-confirmer <person_id> `
  [--ticket-id <ticket>] [--origin-chat <chatid>] [--require-ack]

# 群消息到达：先匹配，不执行
node src/service/cli.ts --json executor attention match `
  --chat-id <chatid> --userid <userid> --text "<消息>" [--quote-text "<引用文本>"]

# 匹配到唯一一条且 allowed=true 才执行
node src/service/cli.ts --json executor attention answer `
  --code A12 --chat-id <chatid> --userid <userid> `
  --action answer|approve|reject|ack [--text "<内容>"]

# 恢复同一 Ticket 前取上下文
node src/service/cli.ts --json executor attention context --ticket-id <ticket>
```

- `match` 只做确定性匹配：正文短号 > 引用文本短号 > 当前人当前群唯一 open；多条返回 `ambiguous:true`，Main 只反问一次，不猜。
- `allowed=false` 时不要执行：`not-confirmer` 回“这条需要 XX 确认”；`not-in-chat` 回“要在原会话确认”。
- 老板可代确认；CLI 记 `on_behalf_of`，并给原确认人非阻塞通知。
- review `approve` / responsibility `ack` 会收口 Ticket 并同步 Task；`reject` 把 Ticket 回 `queued`，下一次 claim 带退回意见。
- `attention sweep` 默认只算到期/升级级别；带 `--apply` 才入 outbox。生产由 `anc-executor-wake` 每分钟跑 `--apply`，Main 不直接发群。

## 3. Subagent Report JSON

Main 给 subagent 的 prompt 要求最后输出一个 fenced JSON：

```json
{
  "type": "ready",
  "summary": "已完成报价整理，产物在 tasks/t-.../quote.md",
  "evidence": ["departments/sales/tasks/t-.../quote.md"],
  "next_step": null
}
```

需要人回答才能继续时用 `question`：

```json
{
  "type": "question",
  "summary": "需要 Q3 成本数才能继续",
  "evidence": ["departments/sales/tasks/t-.../quote.md"],
  "next_step": "请提供 Q3 报价的成本数（含税/不含税）"
}
```

`question` 会推进 Ticket `waiting_answer`；Main 随后建 `purpose=answer` 的 Attention，回答后走 human slot 定向恢复。

约束：

| 字段 | 必填 | 说明 |
|---|---|---|
| `type` | 是 | `progress` / `waiting` / `question` / `ready` / `blocked` / `failed` / `dropped` |
| `summary` | 是 | 一句结果，不超过 2000 字 |
| `evidence` | 否 | 相对任务目录的路径数组；不能是绝对路径 |
| `next_step` | 否 | `question` / `waiting` / `blocked` 时说明需要什么 |

解析失败（GAP-064：契约与实现对齐，已接受的偏差）：

- 找不到 JSON / 字段不合法 → CLI 报错并以非 0 退出，**不落 failed Report**；
- 原始输出与错误信息保留在 CLI `stderr` / 主机日志里，作为证据，不进库；
- Main 检测到该失败后决定重试（重新起 subagent）或降级（发 Attention / 人工处理）；不猜测成功，不把自由文本当 `ready`；
- Main 可发 Attention，但不直接改 Ticket。

## 4. Main 唤醒（Main / Host 分工）

**角色分工**：

- **Main**（公司群 / 老板 1:1，Claw 会话，通常没有 Agent tool）：只做 `brief` / `evaluate` / `ticket create` / 通知；**不 claim/start，不自己写产物**。
- **Host**（每日或 `/new` 新建的 Agent 模式会话，有 Agent tool）：才做 `claim/start` + Agent tool 起 subagent。

两条唤醒路：

1. 群消息到达（Main 处理完后建 Ticket，交给 wake）；
2. `anc-executor-wake` 计划任务每分钟跑一次：先查 `executor ticket list --state queued`，**只有 queued > 0** 才唤醒 Host：
   - 有 `%ProgramData%\anc\data\wb-wake-workspace.txt`：调 `POST /new`，在该 workspace 新建一个 Agent 会话，prompt 带 `active host=<host_id>`，要求“不要 host bootstrap、用这个 host id claim、只做一个 tick”；
   - 没有 workspace 文件：回退 `POST /wake` 注入当前会话（仅兼容旧部署）。

依赖 opt-in 的 WorkBuddy wake bridge：

- `%ProgramData%\anc\data\wb-wake.flag` 存在才启用；
- token 在 `wb-wake-token`；只监听 loopback；
- `/wake` 的 composer 非空时拒绝，不覆盖人的草稿；`/new` 新建任务，不碰当前草稿。

没有 flag / bridge 时 `wake-if-queued.ps1` 静默退出；任务仍会落库，等下一次消息或人工唤醒。

**2026-11-10 实测**：`/new` 新会话 `mode=craft`、`cwd=D:/workbuddy-anc`，Agent tool 可用；host tick 用真实 `agent-19d61bd4…` 写 `hello3.md`，Task #16 done。`/wake` 仍会落到“当前窗口”，所以生产默认走 `/new`。

`claim` 无任务时立即返回，不 sleep，不占住 Main 的回合。

## 5. 03:00 Host bootstrap

自动创建：`anc-executor-new-host` 每天 03:00 调 wake bridge 的 `/new`，在指定 workspace 新建对话并注入 bootstrap 命令。

兜底：如果 `/new` 失败或新对话没出现，`host tick` 只把旧 host 标成 `cut_deferred=1`，**不切、不停止接单**；旧 host 继续接新 Ticket。等新对话出现后 `host bootstrap` 再切。

- `executor host register` 由人工/启动器在已有对话里注册；
- `host cut` 由 03:00 定时任务或 Main 触发，负责数据库状态切换；
- **不负责创建 WorkBuddy 新对话**；创建对话是 `GAP-065`，先做 spike，失败则人工兜底。

完整自动 bootstrap 通过前，主干 2 的 7×24 无人值守不能算完成。

## 6. 不变量

- 本地服务**不创建** WorkBuddy 对话，**不直接调用** Agent tool。
- Main 是唯一 live host；subagent 只在当前 host 的对话里运行。
- 一个 Ticket 同时只能有一个 active Assignment。
- Ticket 状态不跟随 host/subagent 存活；Report/人的动作推进状态。
- 任务目录 `departments/<dept_id>/tasks/<ticket_id>/` 由服务端从部门 + ticket_id 推导，创建后不改；传自定义 `task-dir` 会被拒绝。
- subagent 不直接进群、不 @ 人、不开新对话；所有对外说话经 Main。
- 先写 Assignment/Report/outbox，再做外部动作。

## 6.1 Task ↔ Ticket 映射（D38）

- `Ticket state=done` 或 Report `dropped` → 对应 `Task` 置 `done`；blocked/failed 不自动关 Task。
- `failed` Report 且 attempts < `max_attempts` → Ticket 回 `queued`；下一次 claim 新建 Assignment（attempt+1）。
- 达到 `max_attempts` → Ticket `failed`，不再自动重试；不做 Ticket 拆分。
- `executor close --ticket-id <id> --decision done|cancelled` 可显式收口。

## 7. 待定

| 项 | 归属 |
|---|---|
| 自动创建 03:00 新对话 | GAP-065 |
| 定时唤醒用 WorkBuddy 哪个机制 | 已落：`anc-executor-wake` + opt-in wake bridge |
| Report 解析失败后的 Attention 话术 | 主干 3 |
| Attention 接口（问答 / 确认 / 超时） | 主干 3（占位；本契约只留 `waiting` Report 信号） |
| 强路径隔离/ACL | D28：接受逻辑隔离；OS/ACL 留作部署选项 |
| 授权默认值（tools/vault_paths/budget/expires_at） | 已定：DDL 兜底 + Main 每次显式填（GAP-054 / D31，见 §2.2） |
| Ticket 授权字段的 CLI 入参（`--tools` / `--vault-paths` / `--budget` / `--max-attempts` / `--expires-at`） | 归主干 2（GAP-071）：模块 `createTicket` 已支持，CLI `ticket create` 尚未暴露 |
| 重复 Report 的 409/拒绝收敛 | 归主干 2（GAP-071）：当前 `appendReport` 对同一 running Assignment 允许多条、对已结束 Assignment 记 `late=1` 不拒绝 |
| 产物/证据保留与清理 | GAP-058 / D31：任务目录 **90 天**、executor reports/events 审计 **180 天**、vault 投影**长期**；清理责任 = 主机管理员 / 运维计划任务；**自动清理未实现（待实现）** |
| Task ↔ Ticket 完整映射与迁移 | 主干 2 后续（GAP-034，见 §2.2.1） |

本契约解决 **GAP-062 / GAP-064** 的接口形状；executor 侧已实现（本机 2026-11-09 部署通过），Main 行为由 `light/skills/anc-executor` 落地。03:00 自动 bootstrap、重复投递收敛等真实 spike 仍按 PLAN T2.x / 主干 2 后续推进。
