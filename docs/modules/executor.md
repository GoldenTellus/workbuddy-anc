# executor — 执行调度

> 状态：现行（主干 2 第一批）
> 代码：`src/modules/executor/{executor}.ts`
> 入口：`src/modules/executor/index.ts`

## 职责

把“人可见的 Task”变成可执行的 Ticket，管理 03:00 日程 host、任务 Assignment、subagent Report 和排队槽位。**不直接调用 WorkBuddy Agent，不直接进群。**

## 拥有

| 数据/文件 | 说明 |
|---|---|
| `executor_hosts` 表 | 当天调度对话；`active / closing / closed`；全库只能有一个 active |
| `tickets` 表 | 执行单元；`department_id`、`task_dir`、优先级、状态；不替代 `tasks` |
| `assignments` 表 | 一次 subagent 尝试；一个 Ticket 同时只能有一个 pending/running |
| `reports` 表 | 只追加：`progress / waiting / ready / blocked / failed / dropped` |

## 公开契约

- `createHost` / `getHost` / `listHosts` / `cutHost` / `closeHostIfIdle`
- `createTicket` / `getTicket` / `listTickets`
- `claim({hostId, slot, limit})` → `{ticket, assignment}` / `null`
- `startAssignment({assignmentId, subagentId})`
- `appendReport({assignmentId, type, summary, evidence, nextStep})`
- `endAssignment({assignmentId, reason})`
- `recoverHost({hostId, reason})`：把旧 host 的 pending/running 全部中断并回 queued
- `sweepStaleAssignments({now, graceMinutes})`：旧 host 超 grace 的 Assignment 自动中断
- `listExecutorEvents({ticketId, hostId, limit})`：审计查询
- `recordEvaluation({taskId, decision, reason, priority, ticketId})` / `listEvaluations`：Main 评估记录
- `interruptAssignment({assignmentId, reason})`

## 不变量

- 同一时间只有一个 `executor_hosts.status='active'`（唯一索引）。
- 一个 Ticket 同时只能有一个 `pending/running` Assignment（唯一索引）。
- `department_id`、`task_id`、`task_dir` 创建后不可变。
- `tickets` 状态不跟随 host/subagent 存活；Report/人的动作推进状态。
- Report 只追加；`latest_report_id` 只指向最新一条。
- `cancel`/`done` 不删除历史 Assignment/Report。
- 任务目录必须等于服务端推导的 `departments/<dept_id>/tasks/<ticket_id>/`；跨部门、`..`、自定义路径都拒绝。
- normal slot 上限 4；human slot 上限 1，human 不接新 Ticket。

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
| `EXEC_TICKET_NOT_FOUND` | ticket 不存在 |
| `EXEC_BAD_REPORT_TYPE` | 未知 Report 类型 |

## 依赖

- 允许：core
- 不 import `tasks` / `identity` / `delivery`；Task 的 `task_id` 只作为外部键传入。
- 不写 WorkBuddy 对话、不调用 Agent；由 Main 通过 `MAIN-EXECUTOR.md` 调这里。

## 测试

`npm run test:executor`：schema 索引、host 生命周期、唯一 active assignment、slot 上限、03:00 日切、interrupt 重派。

## 改动指南

- 改状态：同步 `FUTURE-DESIGN 2.3`、`MAIN-EXECUTOR.md`、本文件、所有 switch。
- 改并发：同步 `FUTURE-DESIGN 2.4`、`main-executor` 契约。
- 改目录：同步 `FUTURE-DESIGN 2.2` 的目录约定。

## 变更记录

| 日期 | 改了什么 | 为什么 |
|---|---|---|
| 2026-11-09 | 建档；加 host/ticket/assignment/report 与 slot/日切 | 主干 2 T2.1/T2.2 |
