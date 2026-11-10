# executor — 执行调度

> 状态：现行（主干 2 第一批）
> 代码：`src/modules/executor/{executor}.ts`
> 入口：`src/modules/executor/index.ts`
> 部署：`%ProgramData%\anc\modules\executor\`（`deploy.ps1` 映射 `modules\executor`）

## 职责

把“人可见的 Task”变成可执行的 Ticket，管理 03:00 日程 host、任务 Assignment、subagent Report 和排队槽位。**不直接调用 WorkBuddy Agent，不直接进群。**

## 拥有

| 数据/文件 | 说明 |
|---|---|
| `executor_hosts` 表 | 当天调度对话；`active / closing / closed`；全库只能有一个 active |
| `tickets` 表 | 执行单元；`department_id`、`task_dir`、优先级、状态；不替代 `tasks` |
| `assignments` 表 | 一次 subagent 尝试；一个 Ticket 同时只能有一个 pending/running |
| `reports` 表 | 只追加：`progress / waiting / ready / blocked / failed / dropped` |
| `executor_events` 表 | 只追加审计：claim / start / report / end / interrupt / recover |
| `executor_evaluations` 表 | Main 对 background 候选的评估记录（accept/defer/ask/reject） |
| `attentions` 表 | 人在环路里的待确认：answer/review/responsibility；短号、确认人、回执、提醒/升级状态（主干 3） |

## 公开契约

- `createHost` / `getHost` / `listHosts` / `cutHost` / `closeHostIfIdle`
- `createTicket` / `getTicket` / `listTickets`
- `claim({hostId, slot, limit, ticketId?})` → `{ticket, assignment}` / `null`；human slot 带 `ticketId` 时只领该 Ticket，并校验已有 answered/rejected Attention
- `startAssignment({assignmentId, subagentId})`
- `appendReport({assignmentId, type, summary, evidence, nextStep})`
- `endAssignment({assignmentId, reason})`
- `recoverHost({hostId, reason})`：把旧 host 的 pending/running 全部中断并回 queued
- `sweepStaleAssignments({now, graceMinutes})`：旧 host 超 grace 的 Assignment 自动中断
- `listExecutorEvents({ticketId, hostId, limit})`：审计查询
- `recordEvaluation({taskId, decision, reason, priority, ticketId})` / `listEvaluations`：Main 评估记录
- `getTicketScope(ticketId)`：只返回 task_dir/allowed_roots/tools/vault_paths/group_access=false
- `expireTickets({now})`：过期 Ticket 中断 Assignment 并转 failed
- `closeTicket({ticketId, decision})`：人工收口 done/cancelled；CLI 负责同步 Task
- `expireAssignmentsByBudget({now})`：超 budget.max_minutes 中断 Assignment 并 block Ticket
- `interruptAssignment({assignmentId, reason})`
- `createAttention({purpose, question, requiredConfirmerId, ticketId?, taskId?, ...})`：建 Attention，并按 purpose 推进 Ticket 状态（answer→waiting_answer、review 校验 waiting_review、require_ack→waiting_ack）
- `getAttention` / `getAttentionByCode` / `listAttentions` / `attentionContext`
- `answerAttention({attentionId, action, answeredBy, text?, onBehalfOf?})`：answer/approve/reject/ack；幂等；approve/ack 收口 Ticket，reject 回 queued
- `cancelAttention` / `closeAttentionsForTicket`
- `listDueAttentions({now})`：只算 2h/8h/24h 到期与级别，不发消息
- `markAttentionNotified` / `markAttentionReminded`

## 不变量

- 同一时间只有一个 `executor_hosts.status='active'`（唯一索引）。
- host 的 `conversation_id` 是真实 WorkBuddy 会话 UUID（`new-host.ps1` 预生成）；`conv-…` 旧占位值只能靠 wake `/new` 兜底（D46）。
- `cutHost`：新 host 的 `started_at` = 切换时刻、`cut_at` = 下次日切；旧 host 进 `closing`、`accepting_new=0`（GAP-088 修正）。
- 一个 Ticket 同时只能有一个 `pending/running` Assignment（唯一索引）。
- `department_id`、`task_id`、`task_dir` 创建后不可变。
- `tickets` 状态不跟随 host/subagent 存活；Report/人的动作推进状态。
- Report 只追加；`latest_report_id` 只指向最新一条。
- `cancel`/`done` 不删除历史 Assignment/Report。
- 任务目录必须等于服务端推导的 `departments/<dept_id>/tasks/<ticket_id>/`；跨部门、`..`、自定义路径都拒绝。
- normal slot 上限 4；human slot 上限 1，human 不接新 Ticket。
- Attention 短号 `A<seq>` 全局单调、不复用；只有 `open` 进提醒扫描。
- Attention 状态：`open` → `answered` / `approved` / `rejected` / `acked` / `notified` / `expired` / `cancelled`；`notified` 是无需回执的责任终态。
- `answer` 只从 `working` / `waiting_trigger` 进入 `waiting_answer`；`review` 只在 `waiting_review` 建；`require_ack` 只从 `waiting_review` / `working` 进入 `waiting_ack`。
- `answerAttention` 幂等：同一人、同一动作、同一内容重复投递返回当前状态。
- Report `question` → Ticket `waiting_answer`；human-slot Assignment 不计入 `max_attempts`（D43）。
- `startAssignment` 只接受 Agent tool 返回的 subagent id；`main` / `self` / `company-bot` 一律拒绝，防止 Main 自己干活。
- CLI `attention answer` 的确认动作必须由 `--source-msg` 绑定 `patch-in.log` 的真实入站消息；动作、发送人、聊天从该行重新推导，模型自述的 `--action/--userid/--text` 一律不采信（GAP-107）。
- normal `claim` 即把 Ticket 从 `queued` 置 `working`（reserve，GAP-106）；`startAssignment` 再写 working 幂等；`interrupt`/`recover`/`sweep` 把 Ticket 放回 `queued`。claim 后只剩 `pending/running` Assignment，不存在“queued+pending assignment”中间态。
- `closeTicket` / `expireTickets` 会把该 Ticket 还挂着的 `open`/`notified` Attention 置 `cancelled`/`expired`。

## 失败模式

| 错误码 | 含义 |
|---|---|
| `EXEC_HOST_ACTIVE` | 已有 active host |
| `EXEC_HOST_NOT_FOUND` | host 不存在 |
| `EXEC_HOST_NOT_ACTIVE` | 不是 active host，不能日切 |
| `EXEC_HOST_NOT_ACCEPTING` | host 已 closing/不接新任务 |
| `EXEC_BAD_TASK_DIR` | 任务目录不是部门相对路径 |
| `EXEC_ASSIGNMENT_NOT_FOUND` | assignment 不存在 |
| `EXEC_ASSIGNMENT_BAD_STATE` | Assignment 状态不允许该动作 |
| `EXEC_BAD_SUBAGENT` | subagentId 为空，或写成 main/self/company-bot（必须是 Agent tool 返回的 id） |
| `EXEC_TICKET_NOT_FOUND` | ticket 不存在 |
| `EXEC_BAD_REPORT_TYPE` | 未知 Report 类型 |
| `EXEC_HUMAN_NO_INPUT` | human 定向领取前没有 answered/rejected Attention |
| `EXEC_BAD_ATTENTION` | Attention 必填字段缺失或 options 非法 |
| `EXEC_BAD_ATTENTION_PURPOSE` | 未知 Attention purpose |
| `EXEC_ATTENTION_NOT_FOUND` | Attention 不存在 |
| `EXEC_ATTENTION_BAD_STATE` | Ticket 当前状态不能建该 purpose 的 Attention |
| `EXEC_ATTENTION_BAD_ACTION` | action 与 purpose 不匹配 |
| `EXEC_ATTENTION_NOT_OPEN` | Attention 已不是 open，不能再处理 |
| `EXEC_ATTENTION_ALREADY_ANSWERED` | 已被他人/其他内容处理 |

## 依赖

- 允许：core
- 不 import `tasks` / `identity` / `delivery`；Task 的 `task_id` 只作为外部键传入。
- 不写 WorkBuddy 对话、不调用 Agent；由 Main 通过 `MAIN-EXECUTOR.md` 调这里。

## 测试

`npm run test:executor`：schema 索引、host 生命周期、唯一 active assignment、slot 上限、03:00 日切、interrupt 重派；Attention 短号/入口/回答/回执/到期扫描。

## 改动指南

- 改状态：同步 `FUTURE-DESIGN 2.3`、`MAIN-EXECUTOR.md`、本文件、所有 switch。
- 改并发：同步 `FUTURE-DESIGN 2.4`、`main-executor` 契约。
- 改目录：同步 `FUTURE-DESIGN 2.2` 的目录约定。

## 变更记录

| 日期 | 改了什么 | 为什么 |
|---|---|---|
| 2026-11-09 | 建档；加 host/ticket/assignment/report 与 slot/日切 | 主干 2 T2.1/T2.2 |
| 2026-11-09 | 「拥有」补 `executor_events` / `executor_evaluations`；补部署目标 | 契约与实现（`schema.ts` 6 表）对齐 |
| 2026-11-10 | `cutHost` 修正：新 host `started_at=切换时刻`、`cut_at=下次日切`；host `conversation_id` 要求真实 UUID | GAP-088（DEV-01 实测）+ D46（wake 定向 daily host） |
| 2026-11-10 | normal `claim` 即置 Ticket `working`（reserve），`start` 幂等；`interrupt/recover/sweep` 回 queued | GAP-106（wake 重复唤醒窗口）+ D50 |
| 2026-11-09 | 加 `attentions` 表与 Attention API/不变量/错误码；短号、status、入口状态 | 主干 3 T3.1 数据层 |
| 2026-11-09 | 加 `question` Report、human slot 定向领取、human 不计 `max_attempts`、收口 Attention | 主干 3 T3.4 执行器接线 |
