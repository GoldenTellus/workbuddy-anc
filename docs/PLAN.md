# PLAN — 当前主干：主干 2（Main + Executor）

> 类型：执行（当前主干）
> 状态：草案 · 2026-11-07
> 上游：[FUTURE-DESIGN.md](./FUTURE-DESIGN.md) 的主干 2（分支 2.1 / 2.2 / 2.4 / 2.5）
> 账本：[STATUS.md](./STATUS.md)
> 完成后：快照到 `archive/plans/TRUNK-2-<日期>.md`，本文件切下一个主干

## 1. 目标

跑通一条**最小但真实**的执行链：

```text
tasks 表里的 background 任务
  → runtime 产生候选
  → Main 接单，建 Task / Ticket / Assignment
  → Executor（先 fake，后 WorkBuddy）在任务目录执行
  → Report 落库
  → Main 通过 outbox 发出结果
```

这一版**不接群回复确认**（那是主干 3），结果先发到配置的测试群/1:1。

## 2. 本 PLAN 的范围

| 分支 | 本 PLAN 做到哪 | 说明 |
|---|---|---|
| 2.1 Main + Executor | 端口 + fake adapter + 真实 WorkBuddy spike | 两层结构落地；不追求完整生产适配 |
| 2.2 Task / Ticket / Assignment | 新表 + 迁移 + 状态机 | 只加表，不改旧 `tasks` 行为 |
| 2.3 任务来源与排期 | `background` 候选 + 最小策略接口 | 接单规则仍被 GAP-008 卡住；先留策略接口 |
| 2.4 双工作区 | 每 Ticket 一个目录 + `session_id` 映射 | 群交互工作区不动 |
| 2.5 状态 | Report / Attention 落库 + 状态流转 | Attention 只落库，不解析群回复 |

**不做**：

- 群回复确认、引用/短号解析（主干 3）。
- 公司大群 / 老板 1:1 的完整权限（主干 1/3）。
- 员工 bot。
- 自动抢占、完整 P0/P1/P2 调度（先做最小队列）。
- 生产部署；只在测试根/测试库验证。

## 3. 任务拆解

- [ ] **T2.1 领域表**：`ticket` / `assignment` / `report` / `attention` / `notification`；迁移只加表/列，可回滚。
- [ ] **T2.2 状态机**：Ticket 从 `queued` → `working` → `waiting_*` / `done` / `failed`；写测试。
- [ ] **T2.3 候选循环**：轮询 `tasks` 中 `kind=background`、`status=open` 的任务；产生候选；策略接口留空（GAP-008）。
- [ ] **T2.4 Executor 端口**：`ExecutorPort` + `FakeExecutor`（测试用）；一个 Ticket 对应一个 `session_id` + 目录。
- [ ] **T2.5 工作区管理器**：创建/复用/清理任务目录；路径待 GAP-007，先用临时根。
- [ ] **T2.6 Report 回传**：Report 落库；Main 根据 `ready` / `blocked` / `failed` 更新 Ticket。
- [ ] **T2.7 结果通知**：通过现有 outbox 发一条结果消息；不做确认链。
- [ ] **T2.8 集成测试**：一个 fake executor 端到端；现有 163 测试保持绿。
- [ ] **T2.9 WorkBuddy spike**：验证能否创建/恢复/停止一个 Executor Session；结论写进 STATUS；做不成记录阻塞。

## 4. 验收

- [ ] 现有 `npm test` 163/163 不退化；新增测试覆盖迁移、候选、状态、Report、outbox。
- [ ] fake executor 端到端：一个 `background` 任务 → Ticket → Assignment → Report → outbox 消息。
- [ ] `check:modules:deep` 0；`check:docs` 0 断链。
- [ ] 迁移可回滚；旧 `task` CLI 行为不变。
- [ ] WorkBuddy spike 有明确结论（可继续 / 阻塞在哪）。
- [ ] 本 PLAN 触发的旧行为/旧契约修正已登记 STATUS §3.3（GAP-034/035），没有静默覆盖。

## 5. 依赖与风险

| 风险 | 处理 |
|---|---|
| WorkBuddy 没有公开的会话管理 API | T2.9 先 spike；失败则把 GAP-006 标阻塞，主干 2 保持 🟡 |
| `background` 接单规则未定（GAP-008） | 先做策略接口 + 最小规则，不把规则写死 |
| 任务目录路径未定（GAP-007） | 先用 `%TEMP%/anc-tasks`，路径进配置 |
| 新表与旧 `tasks` 双状态 | 旧 `tasks` 仍是人可见状态；Ticket 不反向覆盖旧字段；差异登记 STATUS §3.3（GAP-034） |
| 现有 `runtime` tick 只做提醒/超时/投影 | 新分层不改旧行为；边界差异登记 STATUS §3.3（GAP-035） |
| 结果发错群 | 本 PLAN 只发测试目标；群路由在主干 3 |

## 6. 完成定义

- 分支 2.1 / 2.2 / 2.4 / 2.5：设计 ✅ + 实现 ✅。
- 分支 2.3：最小实现 ✅，但接单规则仍 🟡（GAP-008 未关）。
- **主干 2 不标完成**，直到 GAP-006 / GAP-007 / GAP-008 关闭；PLAN 可以先进下一阶段，但 FUTURE-DESIGN 主干 2 保持 🟡。
- 完成后：按 [DOC-SYNC.md](./DOC-SYNC.md) 填 STATUS 审计行，快照本文件，PLAN 切下一个主干。
