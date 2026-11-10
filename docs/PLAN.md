# PLAN — 当前批次：收口补齐 + 双机全量回归

> 类型：执行（当前批次）
> 状态：**公司侧收口完成（2026-11-10）；ACC-18 真实群通过；剩 ACC-17/20/21（D48 书面例外）**
> 上游：[FUTURE-DESIGN.md](./FUTURE-DESIGN.md) 主干 4 / 横切；[STATUS.md](./STATUS.md) §3.3b / §3.5
> 账本：[STATUS.md](./STATUS.md)
> 决策：[DECISIONS.md](./DECISIONS.md) D40–D45；GAP-079/080/084/087
> 上一个主干：[archive/plans/TRUNK-3-20261109.md](./archive/plans/TRUNK-3-20261109.md)
> 完成后：快照到 `archive/plans/BATCH-<日期>.md`

## 1. 目标

这轮不是新功能主干，是**收口批次**，做三件事：

1. 把主干 0 的复检结论写进 PLAN，作为本批的起始账本。
2. 把主干 2/3 留下的偏差补齐，不把“已收口”当成“没有欠账”。
3. 用**两台电脑**（公司侧 + 员工侧）从环境、部署、群、任务、执行、确认、入库、运维到员工 bot，做一次全量回归，产出机器证据。

**完成定义**：

- 主干 2 的 D45 偏差修正：wake 定向唤醒**已有 daily host**，不再每个 Ticket 新建 host；`/new` 只用于 03:00 日切。
- GAP-079（`msgId`/引用文本增强）、GAP-080（通知 @ 真 userid）补齐；8h/24h 实际投递补测。
- 双机全量回归矩阵全部通过，或有**书面例外**并登记 GAP；不能拿口述/单测冒充真实验收。
- `npm test` 全绿（当前 252/252，新增项继续加）、`npm run check` 通过、`check-public` 零输出。
- `STATUS` / `FUTURE-DESIGN` / `PLAN` / 模块契约 / `LOCAL-SERVICE` / `MAIN-EXECUTOR` / `OPS` / `PRODUCT` / `DECISIONS` 同步。
- 员工 bot 仍是旧 1.0 的部分，明确记为**主干 4 缺口**，不伪装成通过。

## 2. 起始基线（2026-11-10）

```text
主干：0 / 1 / 2 / 3 已收口（主干 2 ACC-16、主干 3 ACC-13/14/15 真实群通过）
测试：252 / 252
模块：13 / 13 current
CLI：17 组
技能：8
计划任务：13
公司主机：deploy 142 文件；doctor 非提权 FAIL=0 WARN=13
员工电脑：旧 1.0，已按 D35 用户实测；主干 4 未实现
open：D45 单一日对话偏差；GAP-079/080 接受但未做；8h/24h 只验级别
```

## 3. 主干 0 当前状态（2026-11-10 复检）

> 详细判定见 `STATUS` §3.3b / §3.4；这里只留本批 PLAN 要用的结论。

**已关闭 / 已接受**：

| 处理 | GAP | 结论 |
|---|---|---|
| 关闭 | 026 / 029 / 036 / 056 | 主干 2/3 已落四表、Attention/outbox、确认接口 |
| 关闭 | 084 | A10 中文问题落库/群显示正常；A1 乱码是本机直传参数，不是 bot 路径 |
| 接受 | 079 | 短号主路径已通过；`msgId`/引用增强留本轮补齐 |
| 接受 | 080 | v1 不 @；本轮补 `mention_userid` 或明确回退 |
| 接受 | 071 | running 允许多条 report、late=1；不改状态机 |
| 关闭 | 087 | 非提权 doctor 对服务任务报 WARN，不再假 FAIL；FAIL=0 WARN=13 |
| 移出 | 005 / 016 / 017 / 018 / 019 / 020 / 037 / 038 / 039 | 归主干 4，不计入主干 0 |

**当前结论**：按现有范围，主干 0 开放 GAP = 0，保持 ✅。本批双机回归如果发现新缺口，**自动重开主干 0**，不压到下一轮。

## 4. 需要补齐的偏差（不是重做主干）

| ID | 现状 | 目标 | 验收 |
|---|---|---|---|
| **DEV-01** D45 单一日对话 | wake 每个 queued Ticket 用 `/new` 新建一个 Agent host；`sessions` 会随 Ticket 增长 | wake 定向唤醒**已有 active daily host**；`/new` 只用于 03:00 日切；host conversation id 稳定 | 连续 3 个 Ticket：只产生 1 个 daily host 会话；3 个 subagent；无重复 host；`sessions` 不按 Ticket 增长 |
| **DEV-02** GAP-079 msgId/quote | 补丁只注入 `chat/from`；短号主路径可用，引用文本不能兜底 | 补丁注入 `msgId`/quote 文本；`attention match` 在无短号时可用引用文本命中；短号仍是主路径 | 真实群引用 A10 回复“可以”不带短号 → 命中；短号路径不回归 |
| **DEV-03** GAP-080 mention userid | v1 通知不 @ 人；`people.userid` 是会话级 `wok…` | org 增加/采集 `mention_userid`；webhook `mentioned_list` 真 @；拿不到就回退中性短号 | 真实员工收到 @；失败时回退不报错 |
| **DEV-04** 8h/24h 实际投递 | 2h 真实群已过；8h/24h 只算级别，没真发 | 回拨 Attention 时间，跑 sweep --apply，测试群收到 8h 管理者/24h 老板文案 | outbox `sent`；文案/收件人正确；不重复 |
| **DEV-05** ACC-01/06/08 证据 | 口述/书面例外，无机器日志 | 双机回归用日志/截图/DB 证据重跑 | 每项有机器证据；不能口述 |
| **DEV-06** 员工 bot 旧 1.0 | 员工侧仍是旧实现，主干 4 未做 | 本批只按现状测，缺口登记；**不在本批实现主干 4** | EMP 项通过或登记 GAP，不伪装通过 |

**规则**：DEV-01/02/03/04 是本批必须补齐的偏差；DEV-05 用双机回归补证据；DEV-06 只记录，不扩成本批实现。

**本批结论（2026-11-10）**：
- DEV-01 ✅ 单一日对话（D46）：wake bridge 2.0 定向 host，真实 3 Ticket / 1 host / 3 subagent；`/new` 只用于 03:00。证据 `STATUS` §1.10。
- DEV-02 ✅ GAP-079：补丁注入 `msg=`/`quote=`，match 引用兜底；**真实群引用「可以」不带短号 approved（ACC-18）**。
- DEV-03 ✅ GAP-080：`mention_userid` + webhook `mentioned_list` + 回退；老板账号已配并实发带 mentions 通知；**员工侧真 @ 归 ACC-17**。
- DEV-04 ✅ 8h/24h 实际投递：A12/A13 sweep + outbox sent=2 + webhook errcode 0（ACC-19 达成）。
- DEV-05 ✅（公司侧机器证据）/ ACC：矩阵 70/70×2、ING 16/16、门禁全绿；员工侧/03:00/真实群安全 → ACC-17/20/21（D48）。
- DEV-06 记录：员工 bot 仍是旧 1.0，主干 4 未实现；本批不伪装通过（ACC-17）。

## 5. 双机全量回归：环境与角色

### 5.1 两台机器

| 机器 | 角色 | 要求 |
|---|---|---|
| **公司主机** | 公司 bot / Main / Executor host / 计划任务 | 7×24 Windows；管理员只用于部署/注册任务；日常 WorkBuddy 用普通权限；`D:\anc` 数据；13 任务；webhook 可用 |
| **员工电脑** | 员工 bot | Windows；普通用户；WorkBuddy 普通权限；员工群；本地资料；员工侧补丁；不查公司库 |

### 5.2 账号与群

```text
老板：guoshuai（全局）
管理者：zhangjiayi（tech）
员工：wuqiong（tech）
群：员工群（wuqiong）、部门群（tech）、公司大群、老板 1:1、anc测试群
```

### 5.3 前置

- 两台机器在同一企业微信主体；公司主机 webhook / secrets 可用。
- 公司主机：`deploy.ps1 -Apply`、`register-tasks.ps1 -Apply`、doctor FAIL=0；patch/bridge 正常。
- 员工电脑：WorkBuddy 安装、员工侧部署、补丁、首次绑定；`bind actor` 能返回 employee。
- 测试数据只进测试群/测试 Task；生产 vault 只读；跑完清理测试 Task/Ticket/Attention。
- 开始前备份 `C:\ProgramData\anc\data\anc.db` 与 `D:\anc` 测试目录。

### 5.4 干净部署路径（可选，不碰生产）

如果要验“从零装起来”，用独立根（例如 `%ProgramData%\anc-e2e` + `D:\anc-e2e`）跑 `deploy.ps1` / `render deploy` / `doctor` / `backup`；不接真实群，只验安装/渲染/权限/回滚。真实群回归仍用生产测试群。

## 6. 双机全量回归：测试矩阵

> 每项都要有证据：DB 查询、日志、截图、产物路径。没有证据 = 未通过。

### 6.1 环境与身份

| ID | 场景 | 预期 | 证据 |
|---|---|---|---|
| ENV-01 | 公司主机干净部署 | 142 文件 hash 全过；13 任务 Ready；doctor FAIL=0 | deploy 日志、doctor |
| ENV-02 | 员工电脑干净部署 | WorkBuddy + 员工侧部署 + 补丁；首次绑定成功 | 安装日志、bind actor |
| ENV-03 | 补丁/前缀 | 群消息带 `[anc:chat/from]`；不是“身份识别暂不可用” | 消息截图、patch 日志 |
| ID-01 | 四类群 bind actor | employee/department/company/boss_dm 的 type/role 正确 | `bind actor` JSON |
| ID-02 | 角色越权 | 员工不能看别人/别部门；管理者只本部门 | 拒绝回复、DB |

### 6.2 任务与请求

| ID | 场景 | 预期 | 证据 |
|---|---|---|---|
| TASK-01 | 老板派任务 | Task open，assignee 正确 | `task list` |
| TASK-02 | 员工自建任务 | 只登记给自己 | `task list` |
| TASK-03 | 同部门请求 | `pending_acceptance` → 接受 → open | 状态/审计 |
| TASK-04 | 跨部门审批 | `pending_approval` → 管理者批准 → 接受 → open | 状态/审计 |
| TASK-05 | 完成/取消权限 | 只有执行人/交办人可操作；越权拒绝 | CLI/群回复 |

### 6.3 Main / Executor

| ID | 场景 | 预期 | 证据 |
|---|---|---|---|
| EXE-01 | background 全链路 | Main 只建 Ticket；wake 定向 daily host；host 起真实 subagent；产物；review；done | Task/Ticket/Assignment/Report、产物 |
| EXE-02 | 队列与 slot | 4+1 slot；P0 队首；不抢占；同优先级 FIFO | DB/日志 |
| EXE-03 | 失败与重试 | failed 自动重试至 max_attempts；不假成功 | DB/Report |
| EXE-04 | 窗口重启恢复 | 旧 Assignment interrupted；Ticket queued；新 host 重派 | recover 日志 |
| EXE-05 | 03:00 日切 | `/new` 建新 host；旧任务继续；新任务进新 host | host/日志 |

### 6.4 Attention / 确认

| ID | 场景 | 预期 | 证据 |
|---|---|---|---|
| ATT-01 | review approve | Ticket/Task done | A 短号、审计 |
| ATT-02 | review reject | Ticket 回 queued，带返工意见 | 状态/审计 |
| ATT-03 | answer + human slot | 同一 Ticket 恢复，不重开 | Assignment/Ticket |
| ATT-04 | responsibility ack | 责任转移；Ticket done | 审计 |
| ATT-05 | 非确认人拒绝 | 只回“需要 XX 确认”，不执行、不泄露 | 群截图 |
| ATT-06 | 老板代确认 | `on_behalf_of` 记录 | 审计 |
| ATT-07 | 2h/8h/24h | 2h 本人；8h 管理者；24h 老板；不重复 | outbox/截图 |
| ATT-08 | 多义/多短号 | 只反问一次，最多列 3 条 | 群截图 |
| ATT-09 | 静默/上限 | 22–08 顺延；每日上限 10；首条 ask 不占 | 配置/日志 |

### 6.5 入库 / 知识

| ID | 场景 | 预期 | 证据 |
|---|---|---|---|
| ING-01 | 文件入库 | 共享区批次、审计、原件不入 git | git/审计 |
| ING-02 | 覆盖写 base hash | 不带 base hash 拒绝；带对才写 | 错误/审计 |
| ING-03 | 权限边界 | 员工只读共享区；内部区只有公司侧 | ACL/拒绝 |

### 6.6 运维 / 安全

| ID | 场景 | 预期 | 证据 |
|---|---|---|---|
| OPS-01 | 备份/恢复 | 备份可读；恢复演练通过 | backup 日志 |
| OPS-02 | doctor / patch guard | 管理员 13 任务 PASS；非提权 WARN 不假 FAIL | doctor 输出 |
| OPS-03 | 重启 | 服务恢复；Task/Ticket 不丢 | 重启前后 DB |
| SEC-01 | 跨群泄露 | 个人/内部数据不出正确群 | 群截图 |
| SEC-02 | 注入 | 文档/群消息里的指令不执行 | 回复/审计 |
| SEC-03 | 伪造确认 | 非确认人/伪造短号不生效 | 状态不变 |

### 6.7 员工 bot（现状）

| ID | 场景 | 预期 | 证据 |
|---|---|---|---|
| EMP-01 | 员工群边界 | 只服务本人；不查公司库；不越权 | 群截图 |
| EMP-02 | 员工→公司 handoff | 若旧 1.0 没有 handoff，登记为**主干 4 缺口**，不算通过 | GAP |

## 7. 任务分解

| 任务 | 内容 | 完成条件 |
|---|---|---|
| **T5.1** 主干 0 记录 | 把 §3.3b 复检、GAP-087、trunk-4 移出写进 PLAN/STATUS | 账本一致；check 通过 |
| **T5.2** 单一日对话 | 改 wake 定向已有 daily host；`/new` 只 03:00 | 3 Ticket 只 1 host；无重复；EXE-01/05 通过 |
| **T5.3** GAP-079 | 补丁 `msgId`/quote；match 兜底 | 引用无短号命中；短号不回归 |
| **T5.4** GAP-080 | org `mention_userid` + webhook mention | 真人员工收到 @；回退可用 |
| **T5.5** 8h/24h | 回拨 Attention；sweep 真发 | 8h/24h 文案/收件人正确 |
| **T5.6** 双机环境 | 公司主机 + 员工电脑按 §5 准备 | ENV-01/02/03、ID-01 通过 |
| **T5.7** 全量回归 | 按 §6 矩阵跑 | 全部通过或书面例外 + GAP |
| **T5.8** 缺口收口 | 新 GAP 修/接受/移出；文档同步 | STATUS/FUTURE/模块/接口同步 |
| **T5.9** 发布门禁 | 测试 3 次、check、check-public、doctor、快照 | 全绿；PLAN 快照 |

**任务状态（2026-11-10）**：T5.1 ✅ / T5.2 ✅（DEV-01）/ T5.3 ✅（DEV-02）/ T5.4 ✅（DEV-03）/ T5.5 ✅（DEV-04）/ T5.6 ✅ 公司主机侧（员工侧 ACC-17）/ T5.7 ✅ 公司主机侧矩阵 + **ACC-18 真实群通过**（ACC-17/20/21 书面例外，D48）/ T5.8 ✅（本批新 GAP 已处置；GAP-091 留后续）/ T5.9 ✅（248/248、check、check-public、doctor、deploy-state、快照）。

## 8. 测试与门禁

```text
npm test                  # 当前 252/252；新增项继续加
npm run check             # modules + docs
npm run coverage
node scripts/checks/check-public.mjs
doctor.ps1 -Repo ...      # 管理员 + 非提权各一次
deploy-verify.ps1
```

- 双机矩阵每项必须有证据；口述不算。
- 新增代码必须有测试；修 bug 必须有回归。
- 失败项进 `STATUS` GAP，不静默跳过。
- 测试数据清理；生产 vault 不被测试写。

## 9. 文档联动

- `STATUS` §3.3b（主干 0 复检）、§3.4（本批执行记录）、§3.5（双机 ACC/矩阵）。
- `FUTURE-DESIGN` 主干 4 / 横切：员工 bot 缺口、单一日对话、GAP-079/080。
- `DECISIONS`：D45 修订/补充；如单一日对话实现方式变化，登记 D46。
- `MAIN-EXECUTOR` / `OPS` / `LOCAL-SERVICE`：wake 定向、mention、8h/24h。
- `PRODUCT`：补齐后的能力边界。
- 完成后归档 `archive/plans/BATCH-<日期>.md`。

## 10. 风险与不做

- **员工 bot 旧 1.0**：双机回归会暴露主干 4 缺口；本批只记录，不实现主干 4。若要“全部功能通过”，需另开主干 4 PLAN。
- **定向唤醒 UI 脆弱**：如果 WorkBuddy 无法稳定定位 daily host tab，先做 `/new` 兜底但必须书面登记 D46，不静默接受。
- **GAP-080 可能拿不到通讯录 userid**：拿不到就回退中性短号，明确记录“未 @”，不算通过。
- **测试数据**：只用测试群/测试 Task；生产数据先备份；跑完清理。
- **不重做已收口主干**：除 DEV-01..06 外，不改主干 1/2/3 的已验收行为；发现缺陷按 GAP 修。

## 11. 执行记录

| 日期 | 事项 | 变更 | 证据 | 备注 |
|---|---|---|---|---|
| 2026-11-10 | PLAN 切“收口补齐 + 双机全量回归” | 写入主干 0 复检、DEV-01..06、双机矩阵 | 本文件 | 待开工 |
| 2026-11-10 | 本批开工 | T5.1 沿用 §3 主干 0 结论；DEV-01 改为 `wb.conversations` / `sendPrompt` 定向唤醒（不再每票 `/new`）；DEV-02/03/04 并行；公司主机侧回归由 teammate 跑 | `STATUS` §3.4；`%ProgramData%\anc\stage\batch-20261110\` | 进行中；部署+重启点在 DEV-01/02 代码齐后统一做 |
| 2026-11-10 | 本批部署 + 重启 + 验收 | 142 文件 ×3 部署 hash 全过；patch-state applied=true runId=78eecdc3…；wake bridge 2.0；DEV-01 3 Ticket/1 host/3 subagent；DEV-02/03/04 完成；回归 70/70×2 + ING 16/16；GAP-088/089 修复，090/092 接受，091 留后续 | `STATUS` §1.10；`dev01/EVIDENCE.md`、`dev02/EVIDENCE.md`、`dev04/EVIDENCE.md`、`regression/REPORT.md`、`gates/` | 门禁：248/248、coverage 88.87/78.87/93.85、check、check-public 0、doctor FAIL=0 WARN=3、deploy-state 11/11 |
| 2026-11-10 | 本批快照 | PLAN 归档到 `archive/plans/BATCH-20261110.md`；双机项转 ACC-17/18/20/21（D48） | 本文件 | 批次收口（公司侧） |
| 2026-11-10 | ACC-18 真实群补丁/引用/@ 通过 | 真实群 5 条入站带 `msg=`；引用 A11/A12 只回「可以」→ approved；`A13可以` 短号 → approved；老板 `mention_userid` 配置并实发 mentions 通知 | `STATUS` §1.10/§3.5；`%ProgramData%\anc\stage\batch-20261110\dev01\acc18\` | 测试 Attention/outbox 已清理；剩 ACC-17/20/21 |
| 2026-11-10 | 主干 2 D46 后复验 | EXE-01 真实 Main 群链路（Task#20 → Ticket → 定向 wake → subagent `trunk2-accept.md` → A11 → done）；EXE-04 两次真实重启恢复（interrupted → 同会话新 host → attempt2 完成）；EXE-02/03 复用 70/70；EXE-05 机制已验证 | `STATUS` §1.11；`%ProgramData%\anc\stage\batch-20261110\trunk2-accept\EVIDENCE.md` | 发现 GAP-106（wake 重复唤醒窗口）open；真实 03:00 跨夜归 ACC-20 |
| 2026-11-10 | ACC-20 日切补测（模拟 03:00） | `new-host.ps1 -Now` 触发：新会话 `827caa80…`、新 host `h-435a1107…`（11-11）、旧 host closing；旧任务切后仍 start/report；新任务 wake 定向新 host 完成 | `STATUS` §1.13；`%ProgramData%\anc\stage\batch-20261110\acc20\` | 未改系统时钟；明早真实 03:00 幂等跳过，下一次真实日切 11-12 |
| 2026-11-10 | ACC-21 安全回归（注入→误批→修复→复测） | 第一轮注入让 bot 直接批准 A11（GAP-107，S1）；修复 `attention answer` 绑定 `--source-msg` + 服务端重推导；复测注入/伪短号/非确认人均失效、老板真实消息才通过 | `STATUS` §1.14/§3.5；`%ProgramData%\anc\stage\batch-20261110\acc21\` | 全量 252/252；CLI/技能/persona 已部署；ACC-21 达成 |
| 2026-11-10 | GAP-106 修复 + 部署自动化 rollout | normal `claim` 即置 Ticket working（D50）；新增回归测试（249/249）；新清单 156 文件部署、14 任务注册（含 `anc-elevate` SYSTEM）、doctor FAIL=0 WARN=3、deploy-verify PASS（1 SKIP）、部署版 CLI claim 冒烟通过 | `STATUS` §1.12；`%ProgramData%\anc\stage\batch-20261110\rollout-20261110-1420\` | 部署自动化 rollout 完成；`deploy-state` 11/13（brief/answers 存量 N/A） |
