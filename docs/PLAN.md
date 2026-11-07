# PLAN — 当前主干：主干 1（角色 / 群 / 权限）

> 类型：执行（当前主干）
> 状态：草案 · 2026-11-07
> 上游：[FUTURE-DESIGN.md](./FUTURE-DESIGN.md) 的主干 1（分支 1.1–1.4）
> 账本：[STATUS.md](./STATUS.md)
> 完成后：快照到 `archive/plans/TRUNK-1-<日期>.md`，本文件切下一个主干

## 1. 目标

把现在“一群一人”的身份模型升级成：

```text
people（老板/管理者/员工）
  + groups（员工群/部门群/公司大群/老板 1:1）
  + manager_scopes（管理者按部门）
  + 角色权限 + 两阶段任务请求
```

**不接 Main / Executor**（那是主干 2），只把群、角色、权限、任务归属的地基打对。

## 2. 本 PLAN 的范围

| 分支 | 本 PLAN 做到哪 | 说明 |
|---|---|---|
| 1.1 谁部署在哪 | org 增加 `boss` / `manages`；角色校验 | 老板唯一、管理者多部门 |
| 1.2 群模型与成员 | 四类群 + 成员解析 + org 校验 | 员工/部门/公司/老板 1:1 |
| 1.3 隐私路由与老板 1:1 | 数据级别 → 渠道路由；`boss_dm` fallback | 公司/部门级可在公司群；个人/内部私密 |
| 1.4 任务请求与权限 | 两阶段审批/接受 + 权限矩阵 + 优先级 | B：同部门直接接受，跨部门先审批 |

**不做**：

- Main / Executor、Ticket / Assignment / Report（主干 2）。
- 群回复确认解析（主干 3）。
- 员工 bot 补丁、移除查库（主干 4，GAP-037–039）。
- 新 UI / 面板；先 CLI + DB + 测试。
- 真正的企微 1:1 接入；本 PLAN 先做 `boss_dm` 类型与私有群 fallback。

## 3. 任务拆解

- [x] **T1.1 org 角色源**：`company.md` 加 `boss`；`members/<id>.md` 加 `manages`（逗号分隔部门）；校验 boss 唯一、manages 引用存在的部门。
- [x] **T1.2 领域表**：`people` / `groups` / `manager_scopes`；迁移只加表/列，可回滚；`chat_bindings` 保留兼容。
- [ ] **T1.3 群解析**：`group.type = employee | department | company | boss_dm`；`department` 带 `dept_id`；从 org 解析成员，企微成员只做校验。**resolver + org→DB 同步已完成；真实群配置/成员校验待 T1.7。**
- [x] **T1.4 权限策略**：boss / manager / employee；管理者按 `manager_scopes` 判范围；P0/P1/P2/P3 优先级。
- [x] **T1.5 任务请求状态机**：`pending_approval` / `pending_acceptance` / `open` / `rejected`；审批人 = 执行人部门任一管理者；老板兜底；拒绝带原因。
- [x] **T1.6 隐私路由**：数据级别（公司/部门/个人/内部/未知）→ 渠道；公司群可答公司+部门；个人/内部转员工群/1:1；无权限拒绝。**router + `resolvePrivateChat` + 测试已完成；真实群配置由 T1.7/T1.8 接。**
- [ ] **T1.7 `boss_dm`**：加群类型与配置；真 1:1 可用则用，不可用走私有群；记录 spike 结论。**类型/表已完成；企微 spike 未做。**
- [x] **T1.8 CLI / 迁移**：`bind`/`list`/`show` 支持群类型；旧 `chat_bindings` 数据迁移；不破坏旧命令。**sync-org / backfill / group-set / group-list / person-list / task request|approve|accept|reject 已完成。**
- [ ] **T1.9 文档同步**：`identity` / `org` / `tasks` 契约、`LOCAL-SERVICE`、`ARCHITECTURE`、`PRODUCT` 更新；`GAP-001/002/003/004/019/028/030/033/040` 状态更新。

## 4. 验收

- [ ] 现有 `npm test` 163/163 不退化；新增测试覆盖 org 角色、群类型、管理者范围、两阶段任务、隐私路由。
- [ ] 一个脚本化场景：员工群 / 部门群 / 公司大群 / `boss_dm` 各解析一次，权限符合矩阵。
- [ ] 同部门请求：`pending_acceptance` → 接受/拒绝；跨部门：`pending_approval` → `pending_acceptance`。
- [ ] 公司大群可答公司级 + 任意部门级；个人级/内部级转私密；无权限拒绝。
- [ ] 迁移可回滚；旧 `chat_bindings` / 旧 CLI 行为不变。
- [ ] `npm run check` 通过。

## 5. 依赖与风险

| 风险 | 处理 |
|---|---|
| 企微真 1:1 不可用 | T1.7 先 spike；`boss_dm` 私有群 fallback，不改类型 |
| 公司大群可答任意部门级 = 部门级全员可见 | 文档明确：部门级不是保密级；敏感标个人/内部 |
| 旧 `chat_bindings` 一群一人 | 保留兼容层；新 `groups` 双写/迁移；旧命令继续可用 |
| org 成员与企微群成员不一致 | org 为准；校验告警，不自动踢人 |
| 管理者管多部门/部门无管理者 | `manager_scopes` 多对多；无管理者时老板兜底 |
| 员工 bot 补丁/移除查库未完成 | 主干 4 处理，不阻塞主干 1；handoff 归属先记录 GAP-038 |

## 6. 完成定义

- 分支 1.1–1.4：设计 ✅ + 实现 ✅。
- 主干 1 标 ✅ 前，必须有关闭/更新的 GAP 证据；不能只看 PLAN 勾选。
- 完成后按 [DOC-SYNC.md](./DOC-SYNC.md) 填 STATUS 审计行，快照本文件，PLAN 切下一个主干。
