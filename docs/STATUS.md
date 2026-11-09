# 状态与缺口

> 类型：账本（已完成 / 进行中 / 缺口 / 风险）
> 最后更新：2026-11-08
>
> 规则：这里只记**事实和证据**。计划和排期在 [PLAN.md](./PLAN.md)；设计意图在 [FUTURE-DESIGN.md](./FUTURE-DESIGN.md)。
> 每个缺口都有 `GAP-###`，主干完成时必须逐条处理：修掉、进主干 0、或明确接受不修。

---

## 1. 已完成

### 1.1 代码基线（2026-11-06）

- [x] 13 个模块全部 `current`；`src/service` / `src/render` / `src/ingest` 只剩入口薄壳。
- [x] `core` 拆出 `schema` / `migrate` / `tx` / `fs`；两份 `writeAtomic` 下沉。
- [x] 深导入 0、模块违规 0、环 0。
- [x] 2026-11-06 基线 `npm test` 163/163；当前 201/201；`check:modules:deep` 通过；`check-public` 零输出。
- [x] 部署 dry-run 125 个文件；部署布局跑通 `task list` / `loop --once` / `render` / `ingest`。
证据：[ARCHITECTURE.md](./ARCHITECTURE.md)、[archive/history/REFACTOR-ROADMAP.md](./archive/history/REFACTOR-ROADMAP.md)、[archive/history/VERIFY.md](./archive/history/VERIFY.md)。

### 1.2 文档基线（2026-11-07）

- [x] 文档分层：方向 / 执行 / 账本 / 现状 / 运维 / 来源 / 历史。
- [x] `FUTURE-DESIGN` 加主干 0、进度标记和叶子清单。
- [x] 旧 PLAN / ROADMAP / 验收 / 实测 / 上游盘点归档。
- [x] `INDEX.md` 合并旧文档地图与仓库导航。
- [x] `PRODUCT` / `DECISIONS` / `DEPLOY-*` 改名；现行文档加类型 banner。
- [x] `check:docs` 0 断链（以最后一次运行为准）。

### 1.3 主干 1 第一批实现（2026-11-07）

- [x] `org` 解析 `company.boss` 与 `members.manages`；校验唯一老板、部门存在、停用老板。
- [x] `people` / `groups` / `manager_scopes` 表与 `chat_bindings` 兼容；schema 测试。
- [x] `identity` 的群/人 resolver、`manager_scopes`、权限策略、隐私路由；策略测试。
- [x] 隐私路由到具体 `chat_id`：`resolvePrivateChat`（员工群 / boss_dm），找不到 fail closed。
- [x] `tasks` 两阶段请求状态机：`pending_approval` → `pending_acceptance` → `open/rejected`；拒绝原因；测试。
- [x] org→DB 同步：`bind sync-org` 写 people / employee groups / manager_scopes / 兼容 `chat_bindings`；`bind group-set/group-list/person-list`。
- [x] 两阶段任务请求 CLI：`task request|approve|accept|reject`；跨部门自动要求审批。
- [x] 旧绑定回填：`bind backfill` 按 userid 匹配 people，补 employee 群，未知人不猜。
- [x] Bot 接线：`bind actor`；公司 bot persona + `anc-task` 技能接四类群/三角色/隐私路由/两阶段任务。
- [x] 群配置投影：`groups.json` 输出四类群；`bind import`/`sync-org` 写 groups；发送按 `groups.webhook_file` fallback。
- [x] `render deploy --db` 自动 `sync-org` + `verify-org`；本地一致性校验失败即退出 1。
- [x] `npm test` **201/201**；`npm run check` 通过。
- [ ] 企微 API 群成员校验、`boss_dm` spike（GAP-042）；T1.9 文档已关闭。

---

## 2. 进行中

| 事项 | 状态 | 证据 / 下一步 |
|---|---|---|
| 主干 1 的 PLAN | 草案 | [PLAN.md](./PLAN.md) |
| 主干 0 的缺口清理 | 常驻 | 见 §3；按严重度进批次 |
| 文档联动检查 | 规则已建 | [DOC-SYNC.md](./DOC-SYNC.md)；待主干 2 首次审计 |

---

## 3. 缺口

### 3.1 设计叶子（来自 FUTURE-DESIGN §6）

| ID | 缺口 | 类型 | 严重度 | 来源 | 阻塞 | 下一步 |
|---|---|---|---|---|---|---|
| GAP-001 | 公司大群/部门级隐私分级与路由 | 验收 | S1 | 主干 1 | 否 | 隐私 router 已有；接实际员工群/1:1 渠道并入 ACC-05 |
| GAP-002 | 员工请求同事的两阶段审批/接受 | 验收 | S1 | 主干 1 | 否 | 状态机/CLI/通知链已完成；真实群接线并入 ACC-03/04 |
| GAP-003 | 公司大群/部门群成员与 org 同步 | 实现 | S2 | 主干 1 | 否 | org 为准；企微成员校验告警；入群/退群/换号 |
| GAP-004 | 老板 1:1 真通道 / 私有群 fallback | 验收 | S1 | 主干 1 | 否 | 类型/配置已有；真 1:1 spike 并入 ACC-06 |
| GAP-005 | 员工群两个 bot 的触发分工 | 实现 | S1 | 主干 4 | 是 | 员工 bot 只服务员工；补丁/移除查库（GAP-037–039） |
| GAP-006 | WorkBuddy 日对话 + 任务 subagent 适配 | 实现 | S0 | 主干 2 | 是 | 先验证 subagent 并发/工具边界/日切 |
| GAP-007 | 部门/任务目录路径、命名、清理、权限 | 实现 | S1 | 主干 2 | 是 | 定 departments/<dept>/tasks/<ticket> |
| GAP-008 | `background` 任务接单规则 | 设计 | S1 | 主干 2 | 是 | 自动接 vs Main 评估；谁授权 |
| GAP-009 | subagent 全局并发/模型/预算 | 后续 | S2 | 主干 2 | 否 | 定默认 4 与重试 |
| GAP-010 | 是否预留人工续谈 slot | 后续 | S3 | 主干 2 | 否 | 压测后定 |
| GAP-011 | 主动任务 observe/auto 规则 | 后续 | S2 | 主干 0 | 否 | 规则与审批 |
| GAP-012 | `require_ack` 任务类型与升级 | 设计 | S1 | 主干 3 | 是 | 定义必须回执的类型 |
| GAP-013 | 通知对象按事件类型细分 | 设计 | S1 | 主干 3 | 是 | review/answer/responsibility 分别定 |
| GAP-014 | 多条 Attention 歧义/超时 | 实现 | S2 | 主干 3 | 否 | 反问格式与超时 |
| GAP-015 | 通知频率/合并/静默时段 | 后续 | S2 | 主干 3 | 否 | 定上限与合并规则 |
| GAP-016 | 员工 bot 本地执行/离线行为 | 设计 | S1 | 主干 4 | 是 | 本地任务队列？离线怎么恢复？ |
| GAP-017 | 员工 bot handoff 协议/补丁实现 | 设计 | S1 | 主干 4 | 是 | 员工 bot 发什么、公司 bot 怎么确认归属 |
| GAP-018 | 入站消息路由（两个 bot） | 实现 | S1 | 横切 | 是 | 定义谁接收哪条 |
| GAP-019 | 说话人身份映射（people/groups） | 实现 | S1 | 横切 | 是 | resolver + sync 已有；补旧 chat_bindings 回填 |
| GAP-020 | 知识/数据边界 | 设计 | S1 | 横切 | 是 | 角色/群可读范围 |
| GAP-021 | 群消息注入/代确认伪造/冒用 | 后续 | S1 | 横切 | 否 | 安全评审 |
| GAP-022 | 多公司/多主机 | 后续 | S3 | 横切 | 否 | 暂不支持 |
| GAP-023 | 工作时段/时区/节假日 | 后续 | S3 | 横切 | 否 | 沿用现有 config |
| GAP-024 | 审计/报告/任务目录保留期 | 后续 | S3 | 横切 | 否 | 定清理策略 |
| GAP-025 | 审计面板/最小可观测字段 | 后续 | S2 | 横切 | 否 | 定最小字段 |
| GAP-053 | Task / Ticket / Assignment 的基数与重试/重开/拆分语义 | 设计 | S1 | 主干 2 | 是 | 状态机/唯一索引/claim-start-report-end 已落；重试/拆分待做 |
| GAP-054 | Ticket 授权范围字段（tools/vault_paths/budget/expires_at/max_attempts） | 设计 | S1 | 主干 2 | 是 | DDL 字段已定；默认值/校验待做 |
| GAP-055 | Main↔Executor 传输与投递语义（DB+tick 已选方向） | 设计 | S1 | 主干 2 | 是 | 定表/命令/ack/重试 |
| GAP-056 | Attention 与主干 3 的最终接口（谁存/谁发/谁确认） | 设计 | S1 | 主干 2 | 是 | 与主干 3 共同定契约 |
| GAP-057 | 外部副作用幂等键与 at-most-once 保证 | 实现 | S1 | 主干 2 | 是 | 定 effect_key 与重试边界 |
| GAP-058 | 产物/证据保留、清理、权限 | 后续 | S2 | 主干 2 | 否 | 定保留策略 |
| GAP-059 | 主机重启后 Assignment/Ticket 恢复语义 | 实现 | S1 | 主干 2 | 是 | 定 interrupted/queued 转换 |
| GAP-060 | subagent 并发能力、路径隔离、日切交接未验证 | 实现 | S1 | 主干 2 | 是 | 4 并发/日切已验证；强路径隔离仍待验证 |
| GAP-061 | 03:00 日切时旧 host 运行中 subagent 是否继续、新 host 如何接管 | 实现 | S1 | 主干 2 | 否 | 用户实测通过：旧任务继续，新任务进新 host；关闭 |
| GAP-062 | Main ↔ 本地服务的 claim/report 边界未定 | 设计 | S1 | 主干 2 | 否 | 契约已写：MAIN-EXECUTOR.md；实现待做 |
| GAP-063 | Main 无消息时如何唤醒并 claim 队列未定 | 设计 | S1 | 主干 2 | 是 | 定时任务/自动化/本地提示三选一 |
| GAP-064 | subagent Report JSON 契约与解析失败策略未定 | 设计 | S1 | 主干 2 | 否 | 契约已写；解析实现待做 |
| GAP-065 | 03:00 自动创建新 host 对话未定 | 实现 | S1 | 主干 2 | 是 | 自动/人工/注册 host；先做 spike |

### 3.2 实现缺口（现状 vs 目标）

| ID | 缺口 | 类型 | 严重度 | 来源 | 阻塞 | 下一步 |
|---|---|---|---|---|---|---|
| GAP-026 | 没有 Ticket / Assignment / Report / Attention / Notification 表 | 实现 | S0 | 主干 2 | 是 | 四表 + 仓储 + CLI 已落；Attention/Notification 未落 |
| GAP-027 | 没有 Main / Executor 运行时 | 实现 | S0 | 主干 2 | 是 | D2 执行器 |
| GAP-028 | 没有 company/department/boss_dm 群模型 | 验收 | S1 | 主干 1 | 否 | people/groups/CLI/render 已完成；真实群配置并入 ACC-01 |
| GAP-029 | 没有群回复确认解析 / Attention 存储 | 实现 | S1 | 主干 3 | 是 | D3 群与确认 |
| GAP-030 | 没有 boss/manager/employee 角色模型 | 验收 | S1 | 主干 1 | 否 | people/policy/sync/persona 已完成；真实群接线并入 ACC |
| GAP-031 | 没有日对话调度 / subagent 管理 | 实现 | S1 | 主干 2 | 是 | 真实 subagent 单条已通；唤醒/自动 host 未接 |
| GAP-032 | `npm test` 并发偶发 100s 级挂起 | Bug/回归 | S1 | 主干 0 | 否 | 已改 `--test-concurrency=1`；连续 3 次通过（当时 191/191），关闭 |
| GAP-040 | org 角色源未同步到 people/manager_scopes | 实现 | S1 | 主干 1 | 否 | 已解析并同步；文档/边界已收口；关闭 |
| GAP-041 | 公司 bot persona / skills 未接新角色、群类型、任务请求 | 验收 | S1 | 主干 1 | 否 | persona/anc-task/通知链已完成；真实消息回归并入 ACC |
| GAP-042 | 四类群真实成员/部署验收未做 | 验收 | S1 | 主干 1 | 否 | render/import/sync/send/deploy 自动 sync 已做；企微成员 API 对账待 ACC-08 |
| GAP-050 | 四类群真实端到端验收批次 | 验收 | S1 | 主干 1 | 否 | 按 §3.5 ACC-01..08 统一收尾；不阻塞代码推进 |
| GAP-051 | FUTURE-DESIGN 内部状态/规则不一致（0.8/主干1/叶子/差距表） | 文档/契约 | S1 | 主干 0 | 否 | 已修：0.8/三态/树/叶子/差距表；check 通过；关闭 |
| GAP-052 | 全仓文档语义漂移（一人一群/私聊/命令/计数） | 文档/契约 | S1 | 主干 0 | 否 | 已批量修 README/AGENTS/PRODUCT/DECISIONS/部署/契约/计数；check 通过；关闭 |

> `S0` 阻断主流程；`S1` 高；`S2` 中；`S3` 低。`阻塞=是` 表示不解决就不能完成对应主干/分支。

### 3.3 设计反哺（未来主干修正现状）

> 这一节不是新功能清单，是**未来设计纠正现阶段项目**的账。类型 `现状修正` 表示旧行为/旧契约被新设计取代，不是新增能力。每项必须写清旧行为、目标行为、影响文件/契约、回归测试；不允许在新主干里静默改掉旧行为。

| ID | 修正对象 | 旧行为 / 旧契约 | 目标行为 | 来源主干 | 阻塞 | 下一步 |
|---|---|---|---|---|---|---|
| GAP-033 | 文档 / 身份契约 | 文档把“一人一群”写成完整模型 | 员工群 + 部门群 + 公司大群 + 老板 1:1 + 角色 | 主干 1 | 否 | 已同步 README/AGENTS/PRODUCT/DECISIONS/部署/契约；关闭 |
| GAP-034 | `tasks` 状态 | open / done / cancelled / needs_review | Task + Ticket / Assignment 状态 | 主干 2 | 是 | 定义映射；旧字段不反向覆盖 |
| GAP-035 | `runtime` tick | 只做提醒 / 超时 / 投影 | Main / Executor 分层；tick 只做通知与调度 | 主干 2 | 是 | 在 D2 拆边界，保留旧行为兼容 |
| GAP-036 | outbox / 通知 | 单向消息 | Attention / 确认 / 回执 | 主干 3 | 是 | 不覆盖旧 outbox；新增 Attention 层 |
| GAP-037 | 员工 bot 技能集 | 现有员工侧 `anc-vault-read` 卡片 | 移除；员工查库直接 @ 公司 bot | 主干 4 | 是 | 改 member persona / skill cards / DEPLOY-EMPLOYEE |
| GAP-038 | 员工侧补丁 | 现有员工侧不装补丁 | 员工侧打补丁，保证 handoff 归属 | 主干 4 | 是 | 补丁方案、版本绑定、回归测试 |
| GAP-039 | 员工 bot 文档/职责 | 现有 `member-bot` 职责含“查公司知识库” | 本机资料 + handoff；不查公司库 | 主干 4 | 是 | 改模板与部署文档，加回归 |

---

### 3.4 主干 0 复检记录

> 触发：讨论形成结论 / 任务完成 / 主干完成。逐项看 0.1–0.8；新增或关闭 `GAP` 要写清楚，没有变化也留一行“已核对无变化”。

| 日期 | 触发 | 0.x 变化 | 新增/关闭 GAP | 备注 |
|---|---|---|---|---|
| 2026-11-07 | 主干 1 设计讨论 + 复检规则 | 0.3 文档已同步（FUTURE-DESIGN / PLAN / STATUS / AGENTS）；0.7 无新增 | 更新 GAP-001/002/003/004/005/019/028/030/033；新增 GAP-040 | 0.1/0.2/0.4/0.5/0.6 已核对无新增；实现缺口随主干 1 的 PLAN |
| 2026-11-07 | 主干 1 第一批实现（T1.1/T1.2/T1.4/T1.5/T1.6 + 部分 T1.3）；org→DB 同步 + bind CLI | 0.6 测试 193/193；0.3 identity/tasks/core/interfaces 契约已同步；0.7 无新增 | GAP-040 已解析并同步；GAP-028/030 表/策略/CLI 基础已有 | 0.1/0.2/0.4/0.5 无新增；T1.7/T1.9 未完成 |
| 2026-11-07 | 主干 1 第二批：任务请求 CLI、旧绑定回填、测试串行门禁 | 0.6 193/193；0.1 GAP-032 已关闭（串行 3 次通过）；0.3 LOCAL-SERVICE/模块契约已同步 | GAP-002/019/040 更新 | T1.7 `boss_dm` spike、T1.9 剩余文档 |
| 2026-11-07 | 主干 1 第三批：`bind actor` + company-bot persona + anc-task 技能 | 0.3 persona/skill/LOCAL-SERVICE 已同步；0.6 193/193 | GAP-041 已改，真实消息回归待 T1.11 | 无新增 0.1/0.2/0.4/0.5/0.7 |
| 2026-11-07 | 主干 1 第四批：render groups[] + bind import + send fallback | 0.3 RENDERER/org/identity 契约已同步；0.6 193/193 | GAP-042 大部分完成；deploy 自动同步/成员校验待做 | 无新增 0.1/0.2/0.4/0.5/0.7 |
| 2026-11-07 | 主干 1 第五批：deploy --db 自动 sync-org + verify-org | 0.3 RENDERER/OPS/LOCAL-SERVICE 已同步；0.6 193/193 | GAP-042 只剩企微 API 成员校验 | 无新增 0.1/0.2/0.4/0.5/0.7 |
| 2026-11-08 | 全仓文档批量修复 | 0.3 20 份文档同步：概念/部署/契约/计数；0.6 193/193；0.4/0.8 未变 | GAP-033/052 关闭；GAP-042 仍在 ACC | check 通过；真实群验收未跑 |
| 2026-11-08 | 主干1本地收口：通知链 + task add 权限 | 0.3 LOCAL-SERVICE/anc-task/tasks 契约；0.6 196/196 | GAP-002/041 转验收；GAP-040 关闭 | 真实群 ACC 未跑 |
| 2026-11-08 | 主干2 分支重构（5 分支） | 0.3 FUTURE 主干2/树/进度表/6.2 叶子；0.6 196/196 | 无新增 GAP；新增叶子 26–32 | 结构已定，细节待设计 |
| 2026-11-08 | 收尾方式改为“先做完、验收后置” | 0.8 真实环境验收加入主干 0；0.3 流程文档同步；0.6 代码测试不变 | 新增 GAP-050 验收批次；GAP-003/004/042 映射到 ACC | 验收不阻塞推进；统一收尾跑 ACC-01..08 |
| 2026-11-08 | 完成即更新规则 | 0.3 STATUS §3.6 / FUTURE / DOC-SYNC / AGENTS / skill 同步；0.6 代码测试不变 | 无新增 GAP | 只改代码不算完成；check 通过 |
| 2026-11-08 | FUTURE-DESIGN 全量审计 + 修复 | 0.3 统一 0.8/三态/树/分支计数/叶子/差距表/D 阶段 | 新增并关闭 GAP-051 | 设计正文已修；代码测试未动 |
| 2026-11-08 | 全仓文档语义扫描 | 0.3 发现 11 份重大漂移、11 份小问题、15 份当前；0.4/0.8 仅记录 | 新增 GAP-052 | 扫描后已批量修复，GAP-052 关闭 |
| 2026-11-09 | 主干2 Executor 改为“日对话 + 任务 subagent” | 0.3 FUTURE 2.2/2.3；0.6 196/196 | GAP-006/007/009/031 更新；新增 GAP-060 | 部门只做标签/输出目录；并发待验 |
| 2026-11-09 | 主干2 并发/落盘 spike：4 subagent | 0.3 FUTURE 2.2；0.6 196/196 | GAP-060 部分关闭 | 销售/财务各 2 任务；无串写 |
| 2026-11-09 | 调研 `dsh-superagent` 原型 | 0.3 upstream/2.2；0.6 196/196 | GAP-060 保持 | 借鉴 Ticket/Assignment/worker slot/工具边界；不照搬一 Ticket 一 Session |
| 2026-11-09 | 定日切规则：03:00 新对话接新任务 | 0.3 FUTURE 2.2/2.3；0.6 196/196 | 新增 GAP-061 | 旧任务继续；新任务进新 host；跨日切待验 |
| 2026-11-09 | 日切实测通过：旧任务继续 + 新任务进新对话 | 0.3 FUTURE 2.2；0.6 196/196 | GAP-061 关闭 | 用户实测；跨日切不再是阻塞项 |
| 2026-11-09 | 写定主干 2 PLAN：日对话 + 任务 subagent | 0.3 FUTURE 2.2/2.3 + PLAN；0.6 196/196 | PLAN 已切主干 2；dsh 调研入 PLAN | 未动代码 |
| 2026-11-09 | 主干0复检（主干2设计/PLAN/契约后） | 0.1–0.8 | 0.3 已更新（MAIN-EXECUTOR/upstream/PLAN）；0.7 无新增；0.8 仍待 ACC-01..08 | 0.1/0.2/0.4/0.5/0.6 无变化 |
| 2026-11-09 | T2.5 真实 WorkBuddy subagent：Ticket → Agent → Report → outbox | 0.3 PLAN/anc-executor；0.6 201/201 | GAP-031 更新 | 临时库实测；start 在 Agent 完成后补记 |
| 2026-11-09 | T2.3/T2.4 CLI 端到端：host → ticket → claim → start → report → notify → end | 0.3 LOCAL-SERVICE/interfaces/PLAN；0.6 201/201 | GAP-026/031/053 更新 | 临时库实测通过，outbox 1；真实 Runner 未接 |
| 2026-11-09 | T2.1/T2.2 领域层：executor 四表 + 仓储 | 0.3 ARCHITECTURE/modules/executor/PLAN；0.6 201/201 | GAP-026/053/031 更新 | 表/唯一索引/状态机/日切仓库；未接 CLI/WorkBuddy |
| 2026-11-09 | 写定 Main↔Executor 契约 | 0.3 MAIN-EXECUTOR；0.6 196/196 | GAP-062/064 设计关闭；063/065 保持 | 实现未动 |
| 2026-11-09 | 主干2 开工门禁审计 | 0.3 PLAN；0.6 196/196 | 新增 GAP-062..065 | T2.1 可开工；T2.4/2.5 等待契约 |
| 2026-11-09 | 主干2 表草案/状态机：host + assignment | 0.3 FUTURE 2.3；0.6 196/196 | GAP-026/053/054 更新 | 唯一 active assignment；03:00 日切序列已定 |
| 2026-11-08 | 文件驱动工作法显式化 | 0.3 AGENTS §3.5、DOC-SYNC、FUTURE 规则 14；0.6/0.8 未变 | 无新增 GAP | 聊天是临时、文件是持久；check 通过 |

### 3.5 真实环境验收批次（统一收尾）

> 这些是 `0.8` 验收项：需要真实群、真实凭据或公司主机。它们**不阻塞代码推进**；统一收尾时按 ACC 顺序一次跑。通过前主干保持 🟡 待验收，不能标 ✅。

| 编号 | 验收项 | 前置 | 通过标准 | 对应 GAP |
|---|---|---|---|---|
| ACC-01 | 四类群配置 | 四类群 chat_id + secrets webhook + org 字段 | `bind actor` 在四类群返回正确 type/role；`verify-org` 通过 | GAP-003/042 |
| ACC-02 | 员工群任务 + 个人数据 | 员工群可用 | 登记任务成功；个人数据只在本人员工群答 | GAP-001/002 |
| ACC-03 | 同部门请求 | 两个同部门员工 | A 请 B → `pending_acceptance` → B 接受 → `open` | GAP-002 |
| ACC-04 | 跨部门审批 | 执行人部门管理者在群 | A 请 C → `pending_approval` → 管理者批准 → C 接受 → `open` | GAP-002/003 |
| ACC-05 | 公司/部门群隐私 | 公司群、部门群可用 | 公司/部门级直接答；个人级转员工群；内部级只回 1:1 | GAP-001 |
| ACC-06 | 老板 1:1 | 真 1:1 或私有群 | 内部数据只在 1:1 答；公司群不泄露 | GAP-004 |
| ACC-07 | 部署 / 重启 / 回滚 | 公司主机管理员 | `deploy.ps1 -Apply` + `render deploy --db` + 服务重启；失败可回滚 | GAP-042 |
| ACC-08 | 企微成员对账 | 可读群成员的企微应用凭据 | org 成员与企微群成员一致；差异有清单 | GAP-003 |

### 3.6 完成时的更新清单

> **完成 = 做完 + 账本更新 + 检查通过。** 只改代码/文档、不改下面这些，不算完成。

| 完成了什么 | 必须同步更新 |
|---|---|
| 代码 / 测试 | 对应 `GAP` 状态、证据、测试数；`README` / `AGENTS` / `INDEX` / `PRODUCT` 里的当前数字 |
| 模块契约 / 文档 | 对应 `docs/modules/<module>.md`、`DOC-SYNC` §4 审计行、`INDEX` 入口 |
| 设计分支 / 主干 | `FUTURE-DESIGN` 分支与汇总状态；`PLAN` 勾选 / 快照 |
| 真实环境验收 | `STATUS` §3.5 的 ACC 行；不能拿本地测试关 `GAP-050` |
| 每次完成 | §3.4 复检行；`npm run check`；必要时 `check-public` |
| 部署 / 群配置 | `LOCAL-SERVICE` / `RENDERER` / `OPS`；旧 `groups.json` 兼容说明 |

规则：

- 先更新账本，再宣布完成；顺序反了就会漏。
- 没有 `GAP` 可关，也要在 §3.4 写“已核对无变化”。
- 一次完成涉及多个分支时，逐个分支改状态，不要只改总表。
- 验收项只更新 ACC，不能把主干标 ✅。

## 4. 文档同步审计

> 每完成一个主干填一行。`✅` 已更新，`◎` 已核对无变化，`—` 不适用。规则见 [DOC-SYNC.md](./DOC-SYNC.md)。

| 日期 | 事项 | FUTURE-DESIGN | PLAN | STATUS | PRODUCT | ARCHITECTURE | modules | 接口 | 运维 | INDEX | DECISIONS | 上游 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-07 | 文档分层重组 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 2026-11-09 | 主干 2 PLAN 切换 + dsh-superagent 复核 | ✅ | ✅ | ✅ | ◎ | ◎ | ◎ | ✅ | ◎ | ✅ | ◎ | ✅ |
| 待填 | 主干 2 完成 |  |  |  |  |  |  |  |  |  |  |  |

---

## 5. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| `npm test` 偶发挂起 | 门禁不稳定 | 先单文件定位；必要时拆分/串行化 PowerShell 用例 |
| WorkBuddy subagent 并发/路径隔离未验证 | 多任务吞吐和部门边界受影响 | 先做 2 并发 + 目录写入 spike；必要时降为串行队列 |
| 企微 1:1 / 入站路由未验证 | 老板控制台和确认链可能不可用 | 在 D3 前做最小实验 |
| 未来上游许可证不明 | 不能合法二创 | `UPSTREAM.md` 的许可证门禁：不明只学概念 |
| 文档再次漂移 | 又回到“多份真相” | `DOC-SYNC` + `check:docs` + 主干完成定义 |

---

## 6. 更新规则

1. 完成一项 → 先在 §1 加证据；不要把“计划完成”写进已完成。
2. 发现新缺口 → 在 §3 加 `GAP-###`，写清类型/严重度/来源/是否阻塞/下一步。
3. 未来主干修正现状 → 在 §3.3 加 `GAP-###`，写清旧行为/目标行为/影响文件；不能静默改旧契约。
4. 缺口修掉 → 状态改为 `closed`（可保留一行历史），并在 §1 加证据。
5. 主干完成 → 按 [DOC-SYNC.md](./DOC-SYNC.md) 填 §4 一行。
6. 只改 STATUS 不够：同步改 `FUTURE-DESIGN` 的进度和 `PLAN` 的任务状态。
7. 每次讨论形成结论、或完成一个任务/主干后，在 §3.4 做一次主干 0 复检；没有变化也留痕。
8. 需要真实群/凭据/主机的验收，登记到 §3.5，不阻塞代码推进；统一收尾时按 ACC 批次跑。
9. 完成任何事项后，按 §3.6 清单逐项更新；只改代码/文档不算完成。
