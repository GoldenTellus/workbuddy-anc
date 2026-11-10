# 上游与参考来源

> 类型：来源政策（怎么收录、怎么授权、怎么引用）
> 最后更新：2026-11-07
>
> 上游不是单数。除了初始 fork 基线，还包括以后用于学习、借鉴、二创的项目、库、设计文档。每一份来源都要有记录，不能只在聊天里说“参考了某个项目”。

---

## 1. 来源类型

| 类型 | 含义 | 许可证义务 |
|---|---|---|
| `fork-base` | 本仓库从它 fork/派生 | 保留原许可证与版权声明 |
| `code` | 拷贝/改编了代码或配置 | 按许可证署名/NOTICE/同许可证 |
| `design` | 借鉴了架构、流程、交互 | 引用来源；不拷代码 |
| `reference` | 只用于学习/论证 | 引用来源；不拷代码 |
| `tool` | 运行时/构建依赖 | 由包管理器与依赖清单管理 |

## 2. 来源索引

| id | 类型 | 许可证 | 固定版本 | 状态 | 记录 |
|---|---|---|---|---|---|
| `ai-native-company` | `fork-base` | MIT | `90e4fb2` | active | [§7.1](#ai-native-company) |
| `dsh-superagent` | `design` | MIT | `8c32a9d` | active | [§7.2](#dsh-superagent) |
| `openai-future-of-the-firm` | `reference` | 无代码 | — | reference | [§7.3](#openai-future-of-the-firm) |

> 新增来源必须同时更新本表、`docs/UPSTREAM.md` §7；如果拷贝了代码，还要更新根目录 `THIRD_PARTY_NOTICES.md`。

## 3. 硬规则

1. **先定许可证，再决定怎么用。**
   - MIT / Apache-2.0：可借鉴/拷贝，保留版权与许可声明。
   - GPL / AGPL：可能要求衍生作品同许可证；未评审不得拷贝。
   - 许可证不明：**只学概念，不拷代码**。
2. **上游必须钉版本。** 记录 commit/tag，不写 `latest`；升级是显式动作，进 `DECISIONS.md`。
3. **代码来源和灵感来源分开记。**
   - 拷了/改了代码 → `THIRD_PARTY_NOTICES.md` + `UPSTREAM.md` §7。
   - 只借鉴设计/思路 → `UPSTREAM.md` §7，注明 `no code copied`。
4. **私有/本地来源也要登记。** 加 `visibility: private`，不写敏感 URL；记录可见范围。
5. **文档引用统一写 `upstream:<slug>`**，不写“参考了某个项目”这种无法追溯的话。

## 4. 新增一个来源

1. 在 `docs/UPSTREAM.md` §7 按模板建条目。
2. 在本文件 §2 加一行。
3. 若拷贝代码：在 `THIRD_PARTY_NOTICES.md` 加许可证与版权。
4. 若改变了设计：在 `DECISIONS.md` 记一条（为什么用、为什么不用别的）。
5. 若影响某个主干：在 `STATUS.md` 的文档同步审计里标“上游已更新”。

## 5. 原始资料放哪

- 上游原样文档/未合并分支：`reference/upstream/`，只读，不参与构建。
- 本项目对来源的判断：`docs/UPSTREAM.md` §7。
- 历史盘点（第一个上游的旧版）：`docs/archive/history/REUSE-MAP.md`、`UPSTREAM-COVERAGE.md`、`UPSTREAM-ORIGINALS.md`。

## 6. 许可证与归属

根目录 `LICENSE` 是本项目当前许可证；第三方代码归属见 [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)。
本文件不是法律意见；引入 GPL/AGPL/商业许可证前必须单独评审。
## 7. 来源详情


### 7.1 ai-native-company
> 类型：来源（`fork-base`）· 状态：active · 最后核对：2026-11-07

| 字段 | 值 |
|---|---|
| id | `ai-native-company` |
| URL | https://github.com/HA7CH/ai-native-company |
| 类型 | `fork-base` |
| 许可证 | MIT（根目录 `LICENSE`，Copyright (c) 2026 HA7CH） |
| 固定版本 | `90e4fb2` |
| 可见性 | public |
| 用了什么 | 初始仓库结构、业务领域（制造企业试点）、部分上游文档与技能样本 |
| 没用什么 | 上游的 Mac mini + cc-connect + Claude Code 运行形态；本仓库改为 Windows + 企业微信 + WorkBuddy |
| 义务 | 保留 MIT 许可证与版权声明；见根目录 `LICENSE` / `THIRD_PARTY_NOTICES.md` |
| 最后核对 | 2026-11-07 |

## 说明

本仓库是它的二次开发，不是原样复制。初始 fork 之后，代码已按本项目的模块化方案重构（P0–P7 + P1b），当前结构以 [ARCHITECTURE.md](./ARCHITECTURE.md) 为准。

上游原文与未合并分支放在 `reference/upstream/`，只读；历史复用盘点在 [archive/history/REUSE-MAP.md](./archive/history/REUSE-MAP.md)。


### 7.2 dsh-superagent
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

设计落点见 [FUTURE-DESIGN.md](./FUTURE-DESIGN.md) 的主干 2 / 主干 3。

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


### 7.3 openai-future-of-the-firm
> 类型：来源（`reference`，no code copied）· 状态：reference · 最后核对：2026-11-07

| 字段 | 值 |
|---|---|
| id | `openai-future-of-the-firm` |
| 来源 | OpenAI 文章《The Future of the Firm》（Hemanth Asirvatham & Elliott Mokski） |
| 类型 | `reference` |
| 许可证 | 无代码；仅引用观点 |
| 固定版本 | —（文章，无代码版本） |
| 可见性 | public |
| 用了什么 | “between us” 的组织位置：AI 位于人与人之间，做协调层；不是 beneath（工具），也不是 beside（同事） |
| 没用什么 | 没有拷贝任何代码、提示词或内部实现 |
| 义务 | 观点引用；不声称是 OpenAI 官方产品/立场 |
| 最后核对 | 2026-11-07 |

## 说明

这篇文章是组织设计参考，不是代码上游。它帮助我们定义“公司 bot 是老板与员工之间的协调层”，但不代表 OpenAI 对本项目的背书。

参考摘要：https://www.llms.blog/posts/openai-future-of-the-firm-essay-ai-org-chart

设计落点见 [FUTURE-DESIGN.md](./FUTURE-DESIGN.md) 的主干 3。
