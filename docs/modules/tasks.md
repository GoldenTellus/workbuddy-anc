# tasks — 任务与提醒

> 类型：模块契约

> 状态：现行（P4 已迁入 `src/modules/tasks/`）
> 代码：`src/modules/tasks/{tasks,reminders}.ts`
> 入口：`src/modules/tasks/index.ts`

## 职责

任务从登记到结束的完整状态机，以及提醒的排期。**"完成"只能由这里判定**；模型无权宣布完成。

## 拥有

| 数据/文件 | 说明 |
|---|---|
| `tasks` 表 | `status`: open / pending_approval / pending_acceptance / done / cancelled / rejected / needs_review；`kind`: simple / background |
| `task_events` 表 | 只追加：created / requested / approved / accepted / rejected / completed / cancelled / reminder_scheduled / reminder_sent / notify_blocked / escalate_no_group |
| `reminders` 表 | 一个任务同时只有一条 `pending` |

## 公开契约

- `createTask(db, input)` / `getTask` / `listTasks`
- `createTaskRequest(db, input)`：同部门 `pending_acceptance`，跨部门 `pending_approval`
- `approveTaskRequest` / `acceptTaskRequest` / `rejectTaskRequest`：两阶段审批/接受
- `completeTask(db, id, {chatId?, text}, actor?)` → `{task, enqueued}`；**完成与出站消息同事务**
- `cancelTask` / `reassignTasks`（离职转交，幂等）
- `startBackgroundTask` / `markTimedOut` / `reviewTask(id, 'retry'|'close')`
- `scheduleReminder` / `dueReminders` / `markReminderSent`
- `taskEvents(db, id)`

## 不变量

- `status` 只走：`open → done/cancelled`；后台任务可 `open → needs_review`。
- 请求任务：`pending_approval → pending_acceptance → open`；任一阶段可 `rejected`，拒绝必须带原因。
- `completeTask` 不能完成待审批/待接受/已拒绝的任务；`cancelTask` 可取消待审批/待接受。
- **完成 + 写事件 + 停提醒 + 入队公告在同一个事务里**；重复完成幂等，不重复入队。
- 取消任务**连带**取消它未发的提醒，不允许"任务取消了提醒还在响"。
- `needs_review` 只能由人复核离开（`review`），系统**不自动重试**。
- 权限：只有 `assignee_userid` 或 `requester_userid` 能完成/取消；两个都没登记的旧任务不校验（兼容存量）。新请求任务额外用 `assignee_id` 校验接受人。
- 提醒同日按 `repeat_minutes` 续排，**跨天停**；夜里不推送。

## 失败模式

| 错误码 | 含义 | 出路 |
|---|---|---|
| `TASK_NOT_FOUND` | 任务号不存在 | 先 `task list` |
| `TASK_FORBIDDEN` | 不是执行人/交办人 | 让本人操作 |
| `TASK_BAD_STATE` | 已完成/已取消又操作 | 查 `task get` 的事件流 |
| `TASK_NOT_BACKGROUND` | 对 simple 任务调 `start` | 建任务时 `--kind background` |

## 依赖

- 允许：core、**delivery**
- 说明：`tasks → delivery` 是**有意**的边——完成公告要与完成同事务入队，不能挪到 runtime。
- 说明：权限校验只用传进来的 `userid` 字符串，**不 import identity**；需要"这个 userid 属于谁"时由调用方（interfaces / runtime）先查好再传。
- 禁止：interfaces / ops（它们只能调函数或 CLI）

## 测试

`npm run test:service` 里的任务生命周期、提醒续排、后台超时、离职转交用例；`src/modules/tasks/requests.test.ts` 的两阶段请求用例；迁移后加 `npm run test:tasks`。

## 改动指南

- 加状态：先改 `db.ts` 的注释、本文件、所有 switch，再补测试。
- 改提醒规则：同步 `DECISIONS` §5.7 的默认规则表、`docs/LOCAL-SERVICE.md`。
- 改权限：同步 `anc-task` 技能里的提示文案。

## 变更记录

| 日期 | 改了什么 | 为什么 |
|---|---|---|
| 2026-11-06 | 建档 | 模块化立项 |
| 2026-11-06 | P4 迁入 `src/modules/tasks/` | 模块化 |
| 2026-11-07 | 加两阶段请求状态与字段 | 主干 1 |
