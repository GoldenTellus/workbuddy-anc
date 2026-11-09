# Main ↔ Executor 契约（主干 2）

> 类型：接口契约（草案，未实现）
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

## 2. CLI 命令（草案）

所有命令支持 `--db` / `--json`，退出码 0 成功、1 业务拒绝、2 参数/环境错误。

### 2.1 Host

```powershell
# 注册当天 host（第一版：已有对话，手动/启动器注册）
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

### 2.3 Report / end

```powershell
node src/service/cli.ts --json executor report `
  --assignment-id <assignment_id> `
  --json-file D:\anc\reports\<assignment>.json

node src/service/cli.ts --json executor notify `
  --chat-id <chatid> --text "<result summary>" [--dedupe-key <key>]

node src/service/cli.ts --json executor end `
  --assignment-id <assignment_id> --reason completed
```

`report` 只追加 Report，并按类型推进 Ticket；`end` 只结束 Assignment：

```text
report progress → Ticket state 不变
report waiting  → waiting_trigger
report ready    → waiting_review
report blocked  → blocked
report failed   → failed
report dropped  → done
```

- `report` 成功但 `end` 未调用：Assignment 仍 `running`，防止 host 重复派活；恢复时按超时/人工处理。
- `end` 只能从 `running → ended`；`interrupted/failed/cancelled` 是调度器/人工的终态。
- 迟到 Report（Assignment 已不是 active）只记录，不覆盖 Ticket 当前状态。

### 2.4 Human slot

```powershell
node src/service/cli.ts --json executor claim `
  --host-id <host_id> --slot human --limit 1
```

- human slot 只 claim **已有 Ticket** 的人工回复/续谈，不接新 Ticket。
- 新任务只走 normal slot；human slot 空闲也不能被新任务占用。

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

约束：

| 字段 | 必填 | 说明 |
|---|---|---|
| `type` | 是 | `progress` / `waiting` / `ready` / `blocked` / `failed` / `dropped` |
| `summary` | 是 | 一句结果，不超过 2000 字 |
| `evidence` | 否 | 相对任务目录的路径数组；不能是绝对路径 |
| `next_step` | 否 | `waiting/blocked` 时说明需要什么 |

解析失败：

- 找不到 JSON / 字段不合法 → 记 `failed` Report，summary 保留截断的原始输出；
- 不猜测成功，不把自由文本当 `ready`；
- Main 可发 Attention，但不直接改 Ticket。

## 4. Main 唤醒

第一版只允许两种唤醒：

1. 群消息到达（Main 处理完后顺手 claim 一次）；
2. WorkBuddy 定时任务/自动化，每分钟触发一次“`executor claim` 并派活”的短 prompt。

没有第 2 种时，后台任务不会自己启动；这是 `GAP-063`，不能假装已经解决。

`claim` 无任务时立即返回，不 sleep，不占住 Main 的回合。

## 5. 03:00 Host bootstrap

第一版：

- `executor host register` 由人工/启动器在已有对话里注册；
- `host cut` 由 03:00 定时任务或 Main 触发，负责数据库状态切换；
- **不负责创建 WorkBuddy 新对话**；创建对话是 `GAP-065`，先做 spike，失败则人工兜底。

完整自动 bootstrap 通过前，主干 2 的 7×24 无人值守不能算完成。

## 6. 不变量

- 本地服务**不创建** WorkBuddy 对话，**不直接调用** Agent tool。
- Main 是唯一 live host；subagent 只在当前 host 的对话里运行。
- 一个 Ticket 同时只能有一个 active Assignment。
- Ticket 状态不跟随 host/subagent 存活；Report/人的动作推进状态。
- 任务目录 `departments/<dept_id>/tasks/<ticket_id>/` 创建后不改。
- subagent 不直接进群、不 @ 人、不开新对话；所有对外说话经 Main。
- 先写 Assignment/Report/outbox，再做外部动作。

## 7. 待定

| 项 | 归属 |
|---|---|
| 自动创建 03:00 新对话 | GAP-065 |
| 定时唤醒用 WorkBuddy 哪个机制 | GAP-063 |
| Report 解析失败后的 Attention 话术 | 主干 3 |
| 强路径隔离/ACL | GAP-060 |
| 授权默认值（tools/vault_paths/budget） | GAP-054 |

本契约先解决 **GAP-062 / GAP-064** 的接口形状；实现和真实 spike 仍按 PLAN T2.1–T2.5 推进。
