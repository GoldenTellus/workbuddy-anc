# PLAN — 当前主干：主干 2（公司 bot 是 super-agent）

> 类型：执行（当前主干）
> 状态：草案 · 2026-11-09
> 上游：[FUTURE-DESIGN.md](./FUTURE-DESIGN.md) 的主干 2（分支 2.1–2.5）
> 账本：[STATUS.md](./STATUS.md)
> 参考：[upstreams/dsh-superagent.md](./upstreams/dsh-superagent.md)
> 完成后：快照到 `archive/plans/TRUNK-2-<日期>.md`，本文件切下一个主干

## 1. 目标

在公司主机上跑一个 7×24 的公司 bot，使用**一个 WorkBuddy 登录**：

```text
一个 WorkBuddy 登录
└─ 当天调度对话（03:00 日切）
   ├─ Task 1 [部门 A] → subagent 1 → departments/A/tasks/<ticket>/
   ├─ Task 2 [部门 B] → subagent 2 → departments/B/tasks/<ticket>/
   └─ Task 3 [部门 A] → subagent 3 → departments/A/tasks/<ticket>/
```

- 一天一条调度对话；03:00 开新对话接新任务。
- 一个任务一个 subagent；不按部门拆 subagent 类型。
- 部门只是任务标签和输出目录；多个部门共用同一个调度台和全局并发槽。
- 旧对话在 03:00 后停止接新任务，但旧任务继续；新任务只进新对话。
- 任务状态、队列、Report 在 SQLite；日对话只是上下文边界，不是任务身份。

**本 PLAN 先打通确定性骨架**：表/仓储/状态机/调度器 + fake executor；再接 WorkBuddy 真实 subagent 适配。

## 2. 参考实现：dsh-superagent

`upstream:dsh-superagent` 是 DeepSeek 的 super-agent 研究原型，不是 WorkBuddy 多对话控制层。它对本 PLAN 的价值是模型和运行规则，不是代码。

### 可借鉴

| 点 | 参考做法 | 本 PLAN 采用 |
|---|---|---|
| 领域分离 | Task / Ticket / Assignment / Report / Attention | Task、Ticket、Assignment、Report 分层 |
| 状态独立 | Ticket 状态不跟随 Session | Ticket 不跟随 host/subagent 存活 |
| 并发 | worker slot；正常 slot + 1 个人工续谈 slot | 全局 4 个 normal slot + 1 个 human slot |
| 排队 | 没 slot 就 queued；不自动抢占 | 队列 + P0 排队首；不抢占正在跑的 subagent |
| 后台时限 | 每轮后台任务最多 30 分钟 | 每个 Assignment 设超时/重试 |
| 工具边界 | Main/router 工具与 worker 工具分开；worker 不能 ask/notify | host 只派活/收报；subagent 不直接进群、不 @ 人 |
| 先落库再做 | stored work / effects / outbox | 先写 Assignment/Report/outbox，再做外部动作 |
| 恢复 | Session/目录/Input 持久化；重启恢复 | 任务目录 + SQLite + Report；subagent 临时，失败后按目录重建 |

### 明确不照搬

- **不采用“一 Ticket 一 WorkBuddy 对话”**：WorkBuddy 无法稳定提供多个 live 会话，也没有公开的会话创建 API。
- 不采用 DSH 的 Session/来源/效果实现；不拷贝代码。
- 不把 subagent 当作可持久恢复的 Executor Session；它是临时执行体。
- 不照搬 DSH 的 GitHub/Feishu Source、面板和部署方式。

这一节的结论已登记在 [upstreams/dsh-superagent.md](./upstreams/dsh-superagent.md) 和 [FUTURE-DESIGN 2.2](./FUTURE-DESIGN.md)。

## 3. 本 PLAN 的范围

| 分支 | 本 PLAN 做到哪 | 说明 |
|---|---|---|
| 2.1 Main：入站、判断与派活 | 最小接单/建 Ticket/派活/收 Report | 先接现有 tasks；不接群回复确认 |
| 2.2 Executor：日对话 + 任务 subagent | host 生命周期 + fake executor + 真实 subagent spike | 不实现“一 Ticket 一 Session” |
| 2.3 工作模型与生命周期 | 表/迁移/仓储/状态机 | 只加表，不改旧 tasks 行为 |
| 2.4 调度与资源控制 | 队列、4+1 slot、03:00 日切 | 不做自动抢占 |
| 2.5 执行安全、恢复与审计 | 路径/tool 边界、interrupted、迟到 Report | 强路径隔离仍待 GAP-060 |

**不做**：

- 群回复确认、引用/短号/@ 解析（主干 3）。
- 员工 bot（主干 4）。
- 新 UI/面板。
- 自动抢占、完整 P0/P1/P2/P3 策略（先做最小队列）。
- 自动创建 WorkBuddy 日对话的完整适配（先做 host 注册/fake，真实 bootstrap 单独 spike）。

## 4. 任务拆解

### T2.1 领域表与迁移

- [ ] `executor_hosts` / `tickets` / `assignments` / `reports` 迁移；只加表/列，可回滚。
- [ ] 唯一索引：一个 active host；一个 Ticket 同时一个 active Assignment。
- [ ] 仓储：`createTicket` / `claim` / `startAssignment` / `appendReport` / `endAssignment`。
- [ ] 测试：迁移幂等、唯一索引、旧 tasks 不退化。

### T2.2 状态机与 Report

- [ ] Ticket：`queued → working → waiting_* / blocked / failed / done / cancelled`。
- [ ] Assignment：`pending → running → ended / interrupted / failed / cancelled`。
- [ ] Report → Ticket 映射：`progress / waiting / ready / blocked / failed / dropped`。
- [ ] 测试：非法迁移拒绝；Ticket 不跟随 host/subagent 状态。

### T2.3 Host 生命周期与 03:00 日切

- [ ] Host：`active / closing / closed`；只允许一个 active。
- [ ] 03:00：旧 host `active → closing`，新 host `active`；旧任务继续，新任务进新 host。
- [ ] 旧 host 无 running Assignment → `closed`；失联超 grace → Assignment `interrupted`。
- [ ] 测试：日切序列、旧任务继续、新任务不重复派活。
- [ ] 真实 host bootstrap：先支持“注册已有对话 id”；自动开新对话留 spike。

### T2.4 调度器与并发

- [ ] 队列：按优先级 + 截止时间 + FIFO；P0 排队首，不抢占。
- [ ] 4 个 normal slot + 1 个 human slot；human 不接新任务。
- [ ] FakeExecutor 端到端：Task → Ticket → Assignment → Report → outbox。
- [ ] 测试：slot 满时 queued；human 续谈不被新任务挤掉；重复 claim 被唯一索引挡住。

### T2.5 WorkBuddy subagent 适配

- [ ] `ExecutorPort`：`start(ticket, assignment)`、`report`、`interrupt`。
- [ ] 真实 subagent：把 Ticket、部门、任务目录、工具边界、Report 格式写进 prompt。
- [ ] 解析 Report；超时、失败、重试、`interrupted` 回写。
- [ ] 并发 spike：4 个 subagent 同时跑；两个部门各 2 个任务；只写各自目录（已完成一次，需重复）。
- [ ] 日切 spike：旧任务继续 + 新任务新 host（用户已实测一次，纳入回归）。

### T2.6 路径与工具边界

- [ ] 任务目录：`departments/<dept_id>/tasks/<ticket_id>/`。
- [ ] 共享区只读；任务只写自己目录；跨目录写入拒绝。
- [ ] subagent 不直接进群、不 @ 人、不开新对话。
- [ ] 测试：两个同部门任务不同目录；跨目录写入被拒。
- [ ] 强隔离（OS/ACL）仍按 GAP-060 单独决定。

### T2.7 恢复与审计

- [ ] 主机重启：running Assignment → interrupted；新 host 按 Ticket/目录/Report 重派。
- [ ] 迟到 Report 只记录，不覆盖新 Assignment 状态。
- [ ] 外部副作用幂等键；outbox 先落库。
- [ ] 审计：每次 claim/start/report/end 有事件记录。

### T2.8 文档同步与收尾

- [ ] 更新 `FUTURE-DESIGN` 分支状态、`STATUS` GAP/证据、`ARCHITECTURE`/模块契约。
- [ ] 填 `STATUS §4` 审计行；快照本 PLAN。
- [ ] `npm run check` + `npm test`。

## 5. 验收

- [ ] 迁移可回滚；唯一索引生效；旧 `tasks`/CLI 行为不变。
- [ ] FakeExecutor 端到端：一个 background 任务 → Ticket → Assignment → Report → outbox。
- [ ] 03:00 日切：旧任务继续，新任务进新 host，不重复派活。
- [ ] 4 个 subagent 并发；同一部门 2 个任务不串写；任务目录正确。
- [ ] human slot 不被新任务占用；P0 不抢占。
- [ ] `npm test` 196/196 不退化；新增测试覆盖迁移、状态机、队列、日切、恢复。
- [ ] `npm run check` 通过。
- [ ] WorkBuddy 真实 subagent spike 有明确结论；做不成的部分登记 GAP，不静默降级。

## 6. 依赖与风险

| 风险 | 处理 |
|---|---|
| WorkBuddy 只能稳定一个 live 对话 | 采用日对话 + subagent，不做一 Ticket 一 Session |
| 03:00 自动创建新对话无公开 API | T2.3 先支持注册已有 host；自动 bootstrap 单独 spike，失败则人工/计划任务兜底 |
| subagent 路径隔离只是指令约束 | GAP-060；先做目录校验/工具白名单，再决定 ACL |
| 旧 tasks 与 Ticket 双状态 | Ticket 不反向覆盖 tasks；差异登记 STATUS §3.3 |
| 旧 host 迟到 Report | Assignment 归属 + 唯一 active 索引 + 迟到 Report 只记录 |
| subagent 并发不可控 | 先 4 并发 spike；失败降为串行队列，不假装并发 |
| DSH 参考模型比我们强 | 明确不照搬 per-ticket Session；只借模型/规则，不把差异藏起来 |

## 7. 开工门禁（2026-11-09）

T2.1（表/迁移/仓储/状态机）不依赖 WorkBuddy，可先开工。
T2.4 / T2.5 开工前必须先定这三项：

| 门禁 | 要定什么 | 不定会怎样 |
|---|---|---|
| **Main ↔ 本地服务** | 谁 claim、谁起 subagent、谁写 Report；建议 Main 通过 CLI 调 `claim/report`，本地服务只存状态，不直接调 WorkBuddy Agent | 本地服务无法创建 WorkBuddy subagent；实现会卡在适配层 |
| **Main 唤醒/claim 循环** | 无群消息时，谁让 Main 去看队列；用 WorkBuddy 定时任务/自动化，还是本地服务发提示 | 后台任务永远不启动，只有人来消息才跑 |
| **Report 契约** | subagent 返回的 JSON 字段、终态、解析失败怎么办 | 文本无法稳定落库，Ticket 状态会漂 |
| **Host bootstrap** | 03:00 新对话由谁创建；自动/人工/已注册 host | 7×24 无人值守会断在日切 |

建议先补一页 `Main ↔ Executor` 契约，再开 T2.4/T2.5；T2.1 现在可以开始。

## 8. 完成定义

- 分支 2.1–2.5：设计 ✅ + 实现 ✅ + 验收 ✅。
- 至少一条真实 WorkBuddy 日对话 + 4 并发 subagent + 03:00 日切回归通过。
- GAP-006 / GAP-007 / GAP-008 / GAP-060 按实际结果关闭或保留；不能只看勾选。
- 完成后按 DOC-SYNC 填审计行，快照本文件，PLAN 切下一个主干。
