# PLAN 快照 — 主干 0 进行中（2026-11-09）

> 类型：历史（快照，只读；主本在 [../../PLAN.md](../../PLAN.md)）
> 快照原因：本机收口完成、0.8 ACC 未全过，主干 0 仍在进行中，先落进度快照。

> 状态：2026-11-09 本机收口执行完成 · 0.8 ACC-07/09 部分达成，其余待真实环境
> 上游：[FUTURE-DESIGN.md](./FUTURE-DESIGN.md) 主干 0（分支 0.1–0.8）
> 账本：[STATUS.md](./STATUS.md) §3.1–§3.5
> 上一个主干：[archive/plans/TRUNK-2-INPROGRESS-20261109.md](./archive/plans/TRUNK-2-INPROGRESS-20261109.md)
> 完成后：快照到 `archive/plans/TRUNK-0-<日期>.md`，再切下一个主干

## 1. 目标

主干 0 不是新功能，是把主干 1/2 和现有 1.0 留下的债收干净，并在两台电脑上完成现场验收：

```text
公司主机（7×24）
├─ 代码 / CLI / DB / 13 个计划任务
├─ WorkBuddy 补丁 + 当日 host
└─ 真实群 / 03:00 / 重启 / 回滚

员工电脑
├─ 员工侧安装 / 技能 / persona / vault 只读
├─ 不装公司服务、不装 13 个任务、不碰公司库
└─ 安装 / 升级 / 卸载 / 回滚
```

**主干 0 的完成定义**：

- 0.1–0.7 的开放 `GAP` 已修、已关或明确接受；
- 0.8 的 `ACC-01..12` 全部通过，或有书面接受的例外；
- 文档、计数、部署手册全部同步；
- 不把“本机单测通过”当成“两机验收通过”。

## 2. 起始基线

```text
测试：212 / 212
模块：13 / 13 current
CLI：17 组
技能：8
计划任务：13
文档：40 份，check 通过
WorkBuddy：5.9.3
```

本机已验证、但**不算**两机验收：

```text
4 个 subagent 并发
真实 Ticket → Agent → result.md → Report → outbox
03:00 日切（用户人工实测一次）
跨进程 recover → bootstrap → 重新 claim
/new 新建对话 → workbuddy-anc → NEW_OK
wake bridge 当前窗口注入
```

**2026-11-09 本机收口实测（执行本 PLAN 后更新）**：

```text
测试：212 / 212 ×3      模块：13 / 13 current
CLI：17 组               技能：8
计划任务：13 个 Ready     部署：137 文件（hash 对拍通过）
doctor：34 项 FAIL=0 WARN=4
deploy-verify：ok:true pass=4 fail=0 skip=1（bot-reply 无群 SKIP）
补丁：applied=true mode=hash pid=24140 活着
覆盖率：行 90.83 / 分支 80.43 / 函数 94.99
```

## 3. 两侧职责

| 范围 | 公司主机 | 员工电脑 |
|---|---|---|
| 系统根 | `%ProgramData%\anc` | `%LOCALAPPDATA%\anc` |
| WorkBuddy | 公司 bot + 补丁 | 员工 bot，不装公司补丁 |
| 本地服务 | 13 个计划任务 + SQLite | **0 个计划任务、无公司库** |
| 技能 | 8 个（含 `anc-executor`） | 8 个（`anc-executor` 不触发） |
| vault | 建两区，写内部区 | 只读共享区 |
| org | 写 org / 同步 people/groups | 不写 |
| 群 | 员工群/部门群/公司群/老板 1:1 | 员工群 |
| 主干 0 验收 | ACC-01..11 | ACC-12 + 本机安装/回滚 |

**不在主干 0 做**：

- 员工 bot handoff 协议（GAP-037–039，归主干 4）；
- 员工 bot 移除查库；
- 员工侧补丁身份注入；
- Attention/确认全链路（归主干 3，只做接口占位）。

## 4. 分支全量清单（0.1–0.8）

### 0.1 Bug / 回归

| 项 | 公司侧 | 员工侧 |
|---|---|---|
| 现有测试 | `npm test` 212/212；连续跑 3 次 | 安装脚本、技能加载、vault 只读 smoke |
| 已知 bug | GAP-032 已关；其余 S0/S1 清零或接受 | 员工侧安装/卸载问题 |
| 回归 | CLI 17 组 smoke、schema 迁移、doctor | 升级/回滚后 persona 不残留 |

完成条件：`0.1` 开放 `GAP` = 0，或全部有接受理由。

### 0.2 技术债 / 重构

| 项 | 要做什么 |
|---|---|
| executor | 保持一个模块、一个入口；不引空壳 Port |
| CLI | 17 组仍走 `interfaces/cli/` + registry，不把业务写回薄壳 |
| schema | 只增表/列；迁移 `addCol` 兼容旧库 |
| 文档 | 同一条规则只在一处定义，其他文档链接过去 |
| 员工侧 | 不复制公司侧代码；只装运行件/技能/persona |

完成条件：无重复实现、无深导入、无未归属文件；`check:modules:deep` 通过。

### 0.3 文档 / 契约

必须覆盖：

```text
README / AGENTS / INDEX
FUTURE-DESIGN / PLAN / STATUS / DOC-SYNC
PRODUCT / ARCHITECTURE / modules/*
LOCAL-SERVICE / MAIN-EXECUTOR / WORKBUDDY-PATCH / RENDERER / INGEST
DEPLOY-COMPANY / DEPLOY-EMPLOYEE / OPS / REBUILD / RELEASE-CHECKLIST
DECISIONS / UPSTREAM（如来源变化）
doc-map.json / INDEX 入口
```

完成条件：

- 文档断链 0；
- 计数与命令一致：212 测试 / 13 模块 / 17 CLI / 8 技能 / 13 任务；
- 公司侧和员工侧的命令、路径、权限不互相污染；
- `npm run check` 通过。

### 0.4 运维 / 部署

| 项 | 公司主机 | 员工电脑 |
|---|---|---|
| 部署 | `deploy.ps1 -Apply` + `register-tasks.ps1 -Apply` | `deploy.ps1 -Side employee -Apply` |
| 任务 | 13 个 Ready，principal 正确 | 0 个 |
| 补丁 | 补丁启动器，`applied=true` 且 pid 活着 | 不装 |
| wake/new | `wb-wake.flag` + workspace；重启后 18187 | 不配置 |
| 体检 | `doctor` 31 项 FAIL=0 | 员工侧 verify |
| 备份 | 本地 + 离机；恢复演练 | 无公司库，仅本机资料 |
| 日志 | `loop.log` / `executor` 日志轮转 | 安装日志 |
| 回滚 | 部署回滚、任务注销、DB 快照 | 卸载/恢复 persona |

完成条件：公司主机一条命令可部署/回滚；员工电脑可装、可卸、不碰公司数据。

### 0.5 安全 / 合规

| 项 | 要求 |
|---|---|
| 凭据 | webhook/secret 只在 secrets，不落库、不进日志、不进 git |
| 出站扫描 | outbox 入队/发送前扫描；命中阻断 |
| 权限 | `secrets` 断继承；vault 对 bot 只读；D28 接受逻辑隔离 |
| 注入 | 群前缀防伪；入站按敌意处理 |
| 仓库 | `check-public.mjs` 零输出；`_research/` 未跟踪 |
| 许可证 | 上游只借设计不拷代码；第三方归属清楚 |

完成条件：安全检查零未处理项；D28/D29 等接受风险在 `DECISIONS` 有记录。

### 0.6 测试 / 覆盖

```text
npm test               212/212
npm run check          modules + docs
npm run coverage       关键模块；覆盖率下降要解释
check-public.mjs       零输出
doctor -SelfTest       ALL PASS
deploy-verify          公司侧 ok:true；员工侧 smoke
```

补齐：

- 员工侧安装/卸载 smoke；
- 公司侧 13 任务/18187/03:00 现场测试；
- 真实窗口重启恢复；
- 两机真实群/任务。

完成条件：本地门禁全绿；真实项转入 0.8，不冒充。

### 0.7 设计反哺 / 现状修正

| 项 | 旧行为 | 目标 |
|---|---|---|
| GAP-034 | `tasks` 只有 open/done/... | Task + Ticket/Assignment 映射，不反向覆盖 |
| GAP-035 | runtime tick 只做提醒 | tick 只做通知/调度，Main/Executor 分层 |
| GAP-037–039 | 员工 bot 查公司库 | 主干 4 改 handoff；主干 0 只修文档警告 |
| D28 | 路径逻辑隔离 | 接受风险，ACL 留部署选项 |
| D29 | background 自动接 | Main 评估后接，记录 evaluations |

完成条件：旧契约被新设计取代时，有兼容层或明确 0.7 记录；不静默改行为。

### 0.8 真实环境验收

必须两机完成，详见 §6。没有通过前，主干 0 保持 🟡。

## 5. 公司主机侧：完成清单

### 5.1 代码与数据库

- [x] `npm test` 212/212；连续 3 次不挂起（`baseline/01-npm-test-run{1,2,3}`，40.6/43.7/40.7s）。
- [x] `npm run check`、`check-public.mjs` 通过（零输出 exit 0）。
- [x] schema 迁移能在旧库上跑；`executor_hosts/tickets/assignments/reports/events/evaluations` 可查（`deploy-verify` task-write PASS；`doctor database` PASS）。
- [x] 17 组 CLI smoke；`executor claim/start/report/end/recover/sweep/expire/evaluate` 可用（`cli.smoke` + registry order=17）。
- [x] `doctor` **34 项** FAIL=0；13 个任务 principal 正确（9 LOCAL SERVICE / 1 SYSTEM / 3 DNT 交互）。

### 5.2 部署与运行

- [x] `deploy.ps1` dry-run 通过，`-Apply` 后逐文件 hash 对拍通过（137 文件；`stage/elevated-*.log`）。
- [x] `register-tasks.ps1 -Apply` 后 13 个任务 Ready/Running（`stage/tasks-elevated.json`）。
- [x] 补丁启动器：`patch-state.applied=true` 且 pid 活着（pid 24140，mode=hash，version 5.9.3）。
- [ ] 需要自动 host 时：创建 `wb-wake.flag`、`wb-wake-workspace.txt`，重启后 `18187/health` 通（**未启用**，默认关；ACC-09 差此项）。
- [ ] `anc-executor-host-tick` 在无新 host 时标 `cut_deferred`，旧 host 继续接单（脚本/单测已有；未在真实 03:00 触发）。
- [ ] `anc-executor-new-host` 在 03:00 能新建 host 对话（任务已注册；未到点验证；ACC-10）。
- [ ] `anc-executor-wake` 只在 queued>0 时唤醒；不覆盖人的草稿（脚本已落、真实窗口注入曾验；本机 bridge 未启用）。
- [x] 备份跑通：本地 `backup\anc-20261109-153622.db` + 离机 `D:\anc-backup`（同物理盘 WARN）；回滚在临时根演练通过（首次部署删 137 文件 / 升级恢复备份，`stage/rollback-drill.log`）。
- [ ] 恢复演练（从备份覆盖回库）；日志轮转实测（脚本已有，未专门演练）。

### 5.3 真实群与人工通道

- [ ] 四类群 chatid + webhook：员工群、部门群、公司群、老板 1:1/`boss_dm`。
- [ ] `bind actor` 在四类群返回正确 type/role。
- [ ] `bind verify-org` 通过；企微成员差异有清单（ACC-08）。
- [ ] 老板 1:1 真通道可用；不可用走私有群并记录。
- [ ] 真实员工请求：同部门接受、跨部门审批。
- [ ] 隐私路由：公司/部门可答；个人/内部不泄露。

### 5.4 03:00 与重启

- [ ] 跨 03:00：旧任务继续，新任务进新 host，不重复派。
- [ ] 新 host 自动创建；失败时旧 host deferred 继续接单。
- [ ] 真实 WorkBuddy 窗口重启：旧 running → interrupted，Ticket 回 queued，新 host 重派。
- [ ] 回滚：部署回滚、任务注销、DB 快照恢复。

## 6. 员工电脑侧：完成清单

### 6.1 安装

- [ ] 前置检查：WorkBuddy 已装、Node/技能目录可写、vault 共享区可读。
- [ ] 部署根为 `%LOCALAPPDATA%\anc`，不写 `%ProgramData%\anc`。
- [ ] 装 8 个技能；`anc-executor` 不触发（公司侧专用）。
- [ ] 渲染本人 persona；不覆盖公司 bot persona。
- [ ] 不安装公司 service、13 个任务、公司 DB、公司补丁。

### 6.2 使用与边界

- [ ] 员工群能 @ 员工 bot；本人资料只在本人会话。
- [ ] vault 共享区只读；不读内部区、不查公司库。
- [ ] 不上传正文；本地摘要/路径可用。
- [ ] 员工 bot 不进部门群/公司大群。
- [ ] 主干 4 handoff 未实现：文档明确警告，不假装已支持。

### 6.3 卸载/回滚

- [ ] 卸载技能/persona 后不残留、不误删 WorkBuddy。
- [ ] 恢复旧 persona/配置可用。
- [ ] 卸载不影响公司主机。

## 7. 两机 ACC 对照

| 编号 | 公司主机 | 员工电脑 | 通过标准 |
|---|---|---|---|
| ACC-01 | ✅ | — | 四类群 chatid/角色/verify-org |
| ACC-02 | ✅ | ✅ | 员工群登记任务 + 个人数据不泄漏 |
| ACC-03 | ✅ | ✅ | 同部门请求 pending_acceptance → 接受 |
| ACC-04 | ✅ | ✅ | 跨部门 pending_approval → 管理者批准 → 接受 |
| ACC-05 | ✅ | — | 公司/部门群隐私路由 |
| ACC-06 | ✅ | — | 老板 1:1 或私有群 fallback |
| ACC-07 | ✅ | — | 部署/重启/回滚 |
| ACC-08 | ✅ | — | 企微成员与 org 对账 |
| ACC-09 | ✅ | — | 13 任务 Ready；补丁；wake 18187 |
| ACC-10 | ✅ | — | 03:00 自动新 host + 旧任务继续 |
| ACC-11 | ✅ | — | 真实窗口重启 recoverHost |
| ACC-12 | ✅ | ✅ | 两机真实群/任务；员工 bot 不越界；产物只在任务目录 |

## 8. 需要拍板/接受的事项

| 项 | 现状 | 主干 0 处理 |
|---|---|---|
| GAP-054 tools/vault_paths/budget 默认值 | DDL 有字段 | **已定（D31）**：DDL 兜底（tools=[]、vault_paths=[]、budget=null、max_attempts=3、expires_at=null）；Main 每次派单显式填并展示 |
| GAP-055 Main↔Executor ack/重试 | claim/report 已落 | **已定（D31）**：at-least-once、无独立 ack、start/report 幂等、迟到 Report 只留证 |
| GAP-026/056 Attention/Notification | 主干 3 接口 | 主干 0 只定占位，不实现全链路；接口归主干 3 |
| GAP-058 产物/证据保留 | 未定 | **已定（D31）**：任务目录 90 天 / reports·events 180 天 / vault 长期；清理责任=运维；自动清理未实现（接受） |
| D28 强 ACL | 已接受逻辑隔离 | 不阻塞；B 方案留以后 |
| GAP-008 background | 已定 Main 评估 | 已落 evaluations；自动评估器不做 |

## 9. 完成定义

主干 0 可以标 ✅ 的条件，全部满足：

1. `0.1–0.7` 开放 `GAP` = 0，或已记录“接受不修”；
2. `0.8` 的 `ACC-01..12` 通过，或有明确例外；
3. `npm test` 212/212；`npm run check`；`check-public` 零输出；
4. `doctor` 31 项 FAIL=0；13 任务 Ready；
5. 公司主机部署/回滚各一次成功；员工电脑安装/卸载各一次成功；
6. `STATUS` §3.4/§3.5 已回填；`DOC-SYNC` 审计全绿；
7. 本 PLAN 快照到 `archive/plans/TRUNK-0-<日期>.md`。

## 10. 主干 0 完成后，文档怎么更新

### 10.1 必更文档

| 文档 | 必须写什么 |
|---|---|
| `FUTURE-DESIGN.md` | 0.1–0.8 分支状态、主干 0 汇总、0.8 验收结果 |
| `STATUS.md` | 所有 `GAP` 状态/证据；ACC-01..12；§3.4 复检；§3.6 完成清单 |
| `PLAN.md` | 快照本文件；切下一个主干或写“无当前主干” |
| `PRODUCT.md` | 实际能力、13 任务/17 CLI/8 技能、员工侧边界 |
| `ARCHITECTURE.md` | 13 模块、部署布局、入口 |
| `docs/modules/*` | 有改动的模块契约（至少 executor/tasks/interfaces/ops/content） |
| `LOCAL-SERVICE.md` | 17 组 CLI、新表、executor 命令 |
| `MAIN-EXECUTOR.md` | 最终 claim/report/wake/new-host 契约 |
| `WORKBUDDY-PATCH.md` | wake bridge、18187、flag/token、版本 |
| `DEPLOY-COMPANY.md` | 13 任务、wake/workspace、部署/回滚、ACC-09..11 |
| `DEPLOY-EMPLOYEE.md` | 员工侧安装/卸载、8 技能、无公司任务、trunk4 警告 |
| `OPS.md` | 13 任务、doctor、备份、日志、回滚 |
| `REBUILD.md` | 重建步骤、13 任务、wake 配置 |
| `RELEASE-CHECKLIST.md` | 发布门禁加 212/212、13 任务、ACC |
| `INDEX.md` / `README.md` / `AGENTS.md` | 计数、入口、当前主干 |
| `DECISIONS.md` | D28/D29 及新增接受风险 |
| `DOC-SYNC.md` | §4 审计行全绿 |
| `doc-map.json` | 新文档/入口 |
| `archive/plans/README.md` | 新快照入口 |

### 10.2 更新顺序

```text
1. 回填 STATUS：GAP、ACC、§3.4、§3.5
2. 改 FUTURE-DESIGN 分支/主干状态
3. 改 PRODUCT / ARCHITECTURE / modules
4. 改 LOCAL-SERVICE / MAIN-EXECUTOR / WORKBUDDY-PATCH
5. 改 DEPLOY-COMPANY / DEPLOY-EMPLOYEE / OPS / REBUILD / RELEASE
6. 改 INDEX / README / AGENTS 计数
7. 填 DOC-SYNC §4 审计行
8. 快照 PLAN 到 archive/plans/
9. npm test / npm run check / check-public
10. 最后才改主干 0 状态
```

### 10.3 计数取数命令（PowerShell 5.1 / node，2026-11-09 校正）

> 原版用了 `grep` / `ls -d | wc -l` 等 Linux 命令，Windows 主机上不可用（GAP-066）。

```powershell
npm.cmd test
npm.cmd run check
node scripts/checks/check-public.mjs
(Select-String -Path scripts\deploy\register-tasks.ps1 -Pattern "Name = 'anc-").Count
node -e "const m=require('./module-map.json'); console.log(m.modules.length)"
@(Get-ChildItem light\skills -Directory).Count
node -e "import('./src/interfaces/cli/registry.ts').then(m => console.log(m.order.length))"
node -e "import('./src/service/deploy-verify.ps1')"   # 不适用；deploy-verify 用:
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\deploy-verify.ps1 -Side company -Json
```

### 10.4 不许做的事

- 不许把 `ACC` 未跑写成“通过”；
- 不许只改 `STATUS` 不改 `FUTURE/PLAN`；
- 不许把员工侧写的“主干 4 待做”删掉；
- 不许在主干 0 静默改旧 CLI/旧表行为；
- 不许把 `_research/`、凭据、真实主机路径写进仓库。

## 11. 风险

| 风险 | 处理 |
|---|---|
| 两机环境不可用 | 主干保持 🟡；ACC 不通过不标完成 |
| WorkBuddy 版本变化 | 补丁锚点回归；失败回退未打补丁版本 |
| 03:00 自动建对话不稳定 | `host-tick` deferred 兜底；人工可接手 |
| 员工侧 old 1.0 误导 | 文档保留警告；主干 4 再改 |
| 强 ACL 未做 | D28 接受逻辑隔离；B 方案留部署选项 |

## 12. 收尾

```text
主干 0 完成
→ 快照 archive/plans/TRUNK-0-<日期>.md
→ PLAN 切下一个主干
→ STATUS 写“主干 0 已收口”
```

本 PLAN 不把“本机测试通过”当成“主干 0 完成”。

> **2026-11-09 执行状态**：本机收口（0.1–0.7）已按证据执行完；0.8 的 ACC-07/09 部分达成，其余 10 项待真实环境。主干 0 **仍未完成**，PLAN 保持进行中；本轮进度快照见 [archive/plans/TRUNK-0-INPROGRESS-20261109.md](./archive/plans/TRUNK-0-INPROGRESS-20261109.md)。

## 13. 执行记录（2026-11-09，本机）

### 13.1 代码 / 门禁

- `npm test` 212/212 ×3（40.6/43.7/40.7s），`npm run check` 通过，`check-public` 零输出，`scan-catch` 空吞 0，`check-modules --strict-deep` 通过，`doctor -SelfTest` ALL PASS，coverage 90.83/80.43/94.99。
- 证据：`.workbuddy/verify/baseline/SUMMARY.md` + 13 个日志（gitignored）。

### 13.2 部署 / 运维（公司侧本机）

- `deploy.ps1 -Apply` 137 文件（hash 全过）；`deploy-skills.ps1 -Apply` 8 技能；`register-tasks.ps1 -Apply` 13 任务 Ready；补丁 `applied=true pid=24140`；vault 两区 + SMB；org（新未来/公司bot，0 成员）+ persona；secrets 4 文件；`backup-anc.ps1` 跑通；`deploy.ps1 -Rollback` 临时根演练（首次/升级）。
- `doctor` 34 项 FAIL=0 WARN=4；`deploy-verify` `ok:true pass=4 fail=0 skip=1`（bot-reply 无群）。
- 证据：`%ProgramData%\anc\stage\elevated-*.log`、`stage\elevated-done.json`、`.workbuddy/verify/deploy/`。

### 13.3 本轮修复（GAP-068，随本提交）

- `deploy.ps1`：`$Map` 补 `modules\executor`；新增 `-Rollback`（首次=按清单删除，升级=恢复最近备份）。
- `doctor.ps1`：`Test-DeployLayout` 补 `modules/executor/index.ts` 入口检查。
- `deploy-skills.ps1`：仓库根改为向上找 `.git`（原写死两级 → 报“没有 light\skills”）。
- `register-tasks.ps1`：2 处 `New-ServicePrincipal` 补 `$ServiceAccount`；`$BotUser` 默认改 `$env:USERNAME`。
- `deploy-verify.ps1`：给 doctor 传 `-Repo`（消除 WARN 数不一致）。
- 注意：`.ps1` 改完必须补回 UTF-8 BOM 再跑门禁。

### 13.4 仍未完成（0.8 真实环境）

| 项 | 缺什么 | 下一步 |
|---|---|---|
| ACC-01..06 / 08 / 12 | 四类群 chatid + webhook、员工名单/userid/部门、老板 userid、企微成员 API、第二台电脑 | 用户补数据后按 DEPLOY-COMPANY §10–§12 跑 |
| ACC-09 剩余 | wake bridge 18187（默认关） | 用户确认启用后建 flag/workspace + 补丁重启 |
| ACC-10 | 真实队列 + 03:00 + bridge | 依赖 ACC-01/09 |
| ACC-11 | 真实 host 会话 + WorkBuddy 窗口重启 | 依赖 ACC-09/10 |
| ACC-07 生产回滚窗口 | 一次生产回滚窗口（当前仅临时根演练） | 用户确认窗口后跑 `deploy.ps1 -Rollback` → `-Apply` |
| 备份恢复演练 / 独立备份盘 | 恢复演练 + 独立盘/UNC | 用户提供盘后跑 |
| GAP-034/053/070 | Task↔Ticket 映射实现、重试/拆分 | 归主干 2 后续 |
| GAP-009/011/025 等 | 模型/预算、主动任务、审计面板 | 留后续主干 |
