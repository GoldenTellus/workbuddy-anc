# 状态与缺口

> 类型：账本（已完成 / 进行中 / 缺口 / 风险）
> 最后更新：2026-11-07
>
> 规则：这里只记**事实和证据**。计划和排期在 [PLAN.md](./PLAN.md)；设计意图在 [FUTURE-DESIGN.md](./FUTURE-DESIGN.md)。
> 每个缺口都有 `GAP-###`，主干完成时必须逐条处理：修掉、进主干 0、或明确接受不修。

---

## 1. 已完成

### 1.1 代码基线（2026-11-06）

- [x] 12 个模块全部 `current`；`src/service` / `src/render` / `src/ingest` 只剩入口薄壳。
- [x] `core` 拆出 `schema` / `migrate` / `tx` / `fs`；两份 `writeAtomic` 下沉。
- [x] 深导入 0、模块违规 0、环 0。
- [x] 2026-11-06 基线 `npm test` 163/163；当前 191/191；`check:modules:deep` 通过；`check-public` 零输出。
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
- [x] `npm test` **191/191**；`npm run check` 通过。
- [ ] `boss_dm` spike、真实群成员校验、T1.9 剩余文档。

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
| GAP-001 | 公司大群/部门级隐私分级与路由 | 实现 | S1 | 主干 1 | 是 | 隐私 router 已有；接实际员工群/1:1 渠道 |
| GAP-002 | 员工请求同事的两阶段审批/接受 | 实现 | S1 | 主干 1 | 是 | 状态机 + CLI 已有；补通知/真实群接线 |
| GAP-003 | 公司大群/部门群成员与 org 同步 | 实现 | S2 | 主干 1 | 否 | org 为准；企微成员校验告警；入群/退群/换号 |
| GAP-004 | 老板 1:1 真通道 / 私有群 fallback | 实现 | S1 | 主干 1 | 是 | 验证真 1:1；不可用走 boss_dm 私有群 |
| GAP-005 | 员工群两个 bot 的触发分工 | 实现 | S1 | 主干 4 | 是 | 员工 bot 只服务员工；补丁/移除查库（GAP-037–039） |
| GAP-006 | WorkBuddy Executor Session 适配 | 实现 | S0 | 主干 2 | 是 | 先做 adapter spike |
| GAP-007 | 任务工作区路径/命名/清理 | 实现 | S1 | 主干 2 | 是 | 定 C 盘路径与生命周期 |
| GAP-008 | `background` 任务接单规则 | 设计 | S1 | 主干 2 | 是 | 自动接 vs Main 评估；谁授权 |
| GAP-009 | Executor 并发/模型/预算 | 后续 | S2 | 主干 2 | 否 | 定上限与重试 |
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

### 3.2 实现缺口（现状 vs 目标）

| ID | 缺口 | 类型 | 严重度 | 来源 | 阻塞 | 下一步 |
|---|---|---|---|---|---|---|
| GAP-026 | 没有 Ticket / Assignment / Report / Attention / Notification 表 | 实现 | S0 | 主干 2 | 是 | D1 领域模型 |
| GAP-027 | 没有 Main / Executor 运行时 | 实现 | S0 | 主干 2 | 是 | D2 执行器 |
| GAP-028 | 没有 company/department/boss_dm 群模型 | 实现 | S1 | 主干 1 | 是 | people/groups 表 + CLI 已有；补真实群配置/spike |
| GAP-029 | 没有群回复确认解析 / Attention 存储 | 实现 | S1 | 主干 3 | 是 | D3 群与确认 |
| GAP-030 | 没有 boss/manager/employee 角色模型 | 实现 | S1 | 主干 1 | 是 | people/policy/sync 已有；补文档与真实群接线 |
| GAP-031 | 没有任务工作区 / 会话管理 | 实现 | S1 | 主干 2 | 是 | 每 Ticket 一目录/会话 |
| GAP-032 | `npm test` 并发偶发 100s 级挂起 | Bug/回归 | S1 | 主干 0 | 否 | 已改 `--test-concurrency=1`；连续 3 次 191/191 通过，关闭 |
| GAP-040 | org 角色源未同步到 people/manager_scopes | 实现 | S1 | 主干 1 | 是 | 已解析并同步；仅剩文档/边界收口 |

> `S0` 阻断主流程；`S1` 高；`S2` 中；`S3` 低。`阻塞=是` 表示不解决就不能完成对应主干/分支。

### 3.3 设计反哺（未来主干修正现状）

> 这一节不是新功能清单，是**未来设计纠正现阶段项目**的账。类型 `现状修正` 表示旧行为/旧契约被新设计取代，不是新增能力。每项必须写清旧行为、目标行为、影响文件/契约、回归测试；不允许在新主干里静默改掉旧行为。

| ID | 修正对象 | 旧行为 / 旧契约 | 目标行为 | 来源主干 | 阻塞 | 下一步 |
|---|---|---|---|---|---|---|
| GAP-033 | 文档 / 身份契约 | 文档把“一人一群”写成完整模型 | 员工群 + 部门群 + 公司大群 + 老板 1:1 + 角色 | 主干 1 | 是 | 同步改 PRODUCT / ARCHITECTURE / identity 契约 |
| GAP-034 | `tasks` 状态 | open / done / cancelled / needs_review | Task + Ticket / Assignment 状态 | 主干 2 | 是 | 定义映射；旧字段不反向覆盖 |
| GAP-035 | `runtime` tick | 只做提醒 / 超时 / 投影 | Main / Executor 分层；tick 只做通知与调度 | 主干 2 | 是 | 在 D2 拆边界，保留旧行为兼容 |
| GAP-036 | outbox / 通知 | 单向消息 | Attention / 确认 / 回执 | 主干 3 | 是 | 不覆盖旧 outbox；新增 Attention 层 |
| GAP-037 | 员工 bot 技能集 | 现有员工侧 `anc-vault-read` 卡片 | 移除；员工查库直接 @ 公司 bot | 主干 4 | 是 | 改 member persona / skill cards / DEPLOY-EMPLOYEE |
| GAP-038 | 员工侧补丁 | 现有员工侧不装补丁 | 员工侧打补丁，保证 handoff 归属 | 主干 4 | 是 | 补丁方案、版本绑定、回归测试 |
| GAP-039 | 员工 bot 文档/职责 | 现有 `member-bot` 职责含“查公司知识库” | 本机资料 + handoff；不查公司库 | 主干 4 | 是 | 改模板与部署文档，加回归 |

---

### 3.4 主干 0 复检记录

> 触发：讨论形成结论 / 任务完成 / 主干完成。逐项看 0.1–0.7；新增或关闭 `GAP` 要写清楚，没有变化也留一行“已核对无变化”。

| 日期 | 触发 | 0.x 变化 | 新增/关闭 GAP | 备注 |
|---|---|---|---|---|
| 2026-11-07 | 主干 1 设计讨论 + 复检规则 | 0.3 文档已同步（FUTURE-DESIGN / PLAN / STATUS / AGENTS）；0.7 无新增 | 更新 GAP-001/002/003/004/005/019/028/030/033；新增 GAP-040 | 0.1/0.2/0.4/0.5/0.6 已核对无新增；实现缺口随主干 1 的 PLAN |
| 2026-11-07 | 主干 1 第一批实现（T1.1/T1.2/T1.4/T1.5/T1.6 + 部分 T1.3）；org→DB 同步 + bind CLI | 0.6 测试 191/191；0.3 identity/tasks/core/interfaces 契约已同步；0.7 无新增 | GAP-040 已解析并同步；GAP-028/030 表/策略/CLI 基础已有 | 0.1/0.2/0.4/0.5 无新增；T1.7/T1.9 未完成 |
| 2026-11-07 | 主干 1 第二批：任务请求 CLI、旧绑定回填、测试串行门禁 | 0.6 191/191；0.1 GAP-032 已关闭（串行 3 次 191/191）；0.3 LOCAL-SERVICE/模块契约已同步 | GAP-002/019/040 更新 | T1.7 `boss_dm` spike、T1.9 剩余文档 |

## 4. 文档同步审计

> 每完成一个主干填一行。`✅` 已更新，`◎` 已核对无变化，`—` 不适用。规则见 [DOC-SYNC.md](./DOC-SYNC.md)。

| 日期 | 事项 | FUTURE-DESIGN | PLAN | STATUS | PRODUCT | ARCHITECTURE | modules | 接口 | 运维 | INDEX | DECISIONS | 上游 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-07 | 文档分层重组 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 待填 | 主干 2 完成 |  |  |  |  |  |  |  |  |  |  |  |

---

## 5. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| `npm test` 偶发挂起 | 门禁不稳定 | 先单文件定位；必要时拆分/串行化 PowerShell 用例 |
| WorkBuddy 没有公开的会话管理 API | Executor 无法落地 | 先做 adapter spike，再定 D2 范围 |
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
