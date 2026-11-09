# dsh-superagent

> 类型：来源（`design`，no code copied）· 状态：active · 最后核对：2026-11-09

| 字段 | 值 |
|---|---|
| id | `dsh-superagent` |
| URL | https://github.com/deepseek-ai/dsh-superagent-prototype |
| 类型 | `design` |
| 许可证 | MIT（仓库 `LICENSE`） |
| 固定版本 | `8c32a9d` |
| 可见性 | public |
| 用了什么 | Source / Trigger / Thread / Ticket / Mandate / Assignment / Report / Attention / Executor Session / Effects / Outbox 等概念；`000-philosophy` 的注意力原则；`003-execution` 的工单/会话/并发模型 |
| 没用什么 | 没有拷贝代码；没有采用 GitHub/Feishu Source 实现、DSH Session API、面板实现 |
| 义务 | 文档引用；若以后拷贝代码，必须补 `THIRD_PARTY_NOTICES.md` 并重新评审 |
| 最后核对 | 2026-11-09 |

## 说明

这是研究原型，不是生产软件。我们借它的**领域模型和运行原则**，不把它的代码直接搬进本项目。

关键参考文档：`docs/000-philosophy.md`、`001-domain.md`、`002-authorization.md`、`003-execution.md`、`004-prompts.md`、`005-panel.md`、`007-architecture.md`。

设计落点见 [FUTURE-DESIGN.md](../FUTURE-DESIGN.md) 的主干 2 / 主干 3。

## 2026-11-09 复核：关键差异

| 维度 | dsh-superagent | 我们的 WorkBuddy 路线 |
|---|---|---|
| 执行单元 | 一个 Ticket 一个 Executor Session（`worker-<ticket>`）+ 一个目录 | 一天一条调度对话，一个任务一个 subagent，任务目录独立 |
| 主/执行分离 | Main/router Session 与 worker Session 分开 | 日对话兼 Main + 调度台，subagent 临时执行 |
| 并发 | `WorkerSlots`，正常 slot + 1 个人工续谈 slot；排队 | 全局 subagent 上限先按 4，另留人工续谈 slot |
| 后台工作 | 每轮后台任务最多 30 分钟；subagent 可继续 | 需要给每个任务设超时/重试，不能无限跑 |
| 恢复 | Session/目录/Assignment/Input 持久化；重启恢复 | 任务状态在 SQLite；subagent 临时，失败后按目录 + Report 重建 |
| 工具边界 | Main 14 个路由工具；worker 6 个执行工具；worker 不能 ask/notify | host 只派活/收报；subagent 禁止直接进群/@ 人 |
| 审批 | Mandate/Policy 版本；Ticket 独立于 Session 状态 | 沿用 Ticket/Assignment/Report；授权字段待定 |

**明确不照搬的**：

- 不采用“一 Ticket 一 WorkBuddy 对话”：WorkBuddy 只能稳定维持少量 live 会话，而且没有公开的会话创建 API。
- 不采用 DSH 的 Session/效果/来源实现；只借鉴模型和运行原则。
- 不把 subagent 当作可持久恢复的 Executor Session；它是临时执行体，恢复靠任务目录 + 数据库 + Report。

**要借鉴的**：

1. Ticket / Assignment / Report / Attention 的职责分离，尤其“Ticket 状态不跟随 Session”。
2. worker slot 并发模型：新任务排队，人工续谈有独立 slot，不被新任务挤掉。
3. 30 分钟后台上限、失败重试、重启恢复说明。
4. Main/router 与 worker 的工具边界；worker 不能直接对人说话。
5. “先落库、再做外部动作”的 stored-work 原则。
