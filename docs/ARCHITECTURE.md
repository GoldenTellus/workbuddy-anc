# 项目架构与模块边界

> 类型：现状架构（不是未来设计）

> **读者**：要改这个项目的人 / agent。
> **状态**：2026-11-06 立项。fork 阶段（对齐上游、证明能跑）已收口；本文定义"从现状往下走"的模块划分。**最后整理：2026-11-10（BATCH-20261110 后；主干 0/1/2/3 已收口）**
> **关系**：本文管**现在代码怎么分、边界在哪**；未来方向看 [FUTURE-DESIGN.md](./FUTURE-DESIGN.md)；当前主干看 [PLAN.md](./PLAN.md)；完成/缺口看 [STATUS.md](./STATUS.md)。旧 `PLAN-1.0` / `REFACTOR-ROADMAP` / `ACCEPTANCE` / `VERIFY` 已进 [archive/history/](./archive/history/)，只读。
> **可执行部分**：`module-map.json` + `scripts/checks/check-modules.mjs`。边界不是口号，能跑出报告、能进 CI。

---

## 0. 为什么现在分块

> 下面这组数字是 **P0 前的基线（2026-11-06）**，不是现状；现状见 §2 模块总表与 §5 部署布局。

P0 前能跑，但"改一处要读半个仓库"：

- `src/service/cli.ts` **627 行**，17 组命令在一个 if/else 里；
- `src/service/loop.ts` **367 行**，一次 tick 干 6 件事；
- `src/render/index.ts` **324 行**，渲染 + 事务部署 + 回滚 + 孤儿清理混在一起；
- 48 个脚本平铺在 `scripts/`；
- 23 份文档（当时），契约、验收、实测、路线混在一起。

分块的目的不是"好看"，是四件事：

1. 每块有**唯一入口**和**契约**，改它不用读别的块；
2. 每块能**单独测**；
3. 依赖**单向**，不会被反向拖死；
4. 换实现（尤其 WorkBuddy 适配层）时**只动一块**。

---

## 1. 分块原则

1. **按变更原因切，不按技术层切。** 同一个人、同一个理由会一起改的文件，放一块。
2. **一块一个契约。** 跨块只认 `index.ts` 导出的函数/类型；文件路径、表名、内部函数都不是契约。
3. **数据有主。** 每张表、每类文件只有一个模块能写；别的模块要读，走拥有者的查询函数。
4. **依赖单向。** `core ← 能力 ← 编排 ← 接口`；`ops` 只通过 CLI/文件契约调用，不 import `src`。
5. **部署路径是公开契约。** `%ProgramData%\anc\service\cli.ts`、`render\cli.ts`、`ingest\cli.ts`、`bin\*.ps1`、`tools\*.ps1` 被技能、persona、计划任务引用，**不能改**；源码怎么搬都行，入口用薄壳保住。
6. **不为分而分。** 小于约 150 行、只被一个模块用的文件，不单独成块。

---

## 2. 模块总表

| ID | 模块 | 一句话 | 拥有（数据/文件） | 依赖 |
|---|---|---|---|---|
| `core` | 平台底座 | 库、迁移、事务、时间、配置、审计、出站扫描、备份 | `meta`/`config` 表、schema、`audit.log` 格式 | 无 |
| `identity` | 身份与群绑定 | chatid ↔ 群类型 ↔ 人/角色/部门 ↔ webhook | `people`/`groups`/`manager_scopes`；`chat_bindings` 兼容 | core |
| `tasks` | 任务与提醒 | 任务生命周期、提醒排期、后台任务超时、离职转交；两阶段请求 | `tasks`/`task_events`/`reminders` | core · delivery |
| `executor` | 执行调度 | 03:00 host、Ticket、Assignment、Report、4+1 slot、Attention | `executor_hosts`/`tickets`/`assignments`/`reports`；`executor_events`/`executor_evaluations`/`attentions` | core |
| `delivery` | 出站投递 | 队列、去重、领取、退避、过期、按群选 webhook、发送 | `outbox` | core · identity |
| `knowledge` | 知识与入库 | 入库校验/写入/锁/归档；本地检索与摘要；A2A 归档 | vault 两区文件、ingest 锁、`a2a_*` 表 | core |
| `org` | 组织与渲染 | org 解析、persona/接入包、`groups.json`、事务部署与回滚 | org 输入、render 产物、manifest | core |
| `improvement` | 自我改进 | submission → issue → patch draft → eval；dayend；devbot 契约 | `submissions`/`issues`/`patch_drafts`/`eval_runs`/`dayend` | core |
| `runtime` | 运行编排 | 一次 tick：回收、顺延、提醒、升级、发送、超时、投影 | 无表；读各能力模块 | core · identity · tasks · delivery · knowledge |
| `interfaces` | 服务接口 | 17 组 CLI + 3 条 HTTP 路由 + 审计包装 + ERROR/FIX 格式 | 无 | 能力模块（含 executor） + runtime + org（仅 `bind sync-org`） |
| `workbuddy` | WorkBuddy 适配 | 群身份注入、旁白过滤、升级拦截、补丁状态、canary、test-emit | `scripts/workbuddy-patch/*`、`patch-*.json/log` | 无（只写状态文件） |
| `ops` | 主机运维 | 部署、体检、备份、自愈、重建、账号、计划任务 | `%ProgramData%\anc\` 布局、任务、ACL、备份 | 无（只走 CLI/文件） |
| `content` | 业务内容 | 9 个技能、2 个 persona、模板、eval 用例、vault 模板 | `light/`、`org.example/` | 无代码依赖；依赖 CLI 契约 |

**不是模块**：`docs/`（地图本身）、`reference/upstream/`（历史参考）、`_research/`（本地敏感，不入库）。

---

## 3. 依赖图

```
interfaces（service CLI / HTTP）
   ├─ runtime（tick）
   │    ├─ tasks ────── delivery
   │    ├─ identity
   │    └─ knowledge
   └─ org（仅 bind sync-org；组合根例外，不反向依赖）

tasks / delivery / identity / knowledge / org / improvement
   └─ core（db / config / audit / scan / backup）

workbuddy   独立：只写状态文件，不 import src
ops         独立：只调 CLI 与文件契约
content     独立：只依赖 CLI 命令契约
```

规则：**箭头只能向下**。出现环先改设计，不加例外。

---

## 4. 边界规则（硬）

| # | 规则 | 怎么检查 |
|---|---|---|
| R1 | 跨模块只能 import 对方的 `index.ts`；禁止 `../tasks/tasks.ts` 这类深导入 | `check:modules` 报深导入；迁移完成后 `--strict` 失败 |
| R2 | 不直接读写别的模块的表；要读走拥有者的查询函数 | 代码评审 + 表的 `OWNER` 注释 |
| R3 | 不改别的模块拥有的文件/目录 | 代码评审 + 模块文档的"拥有"表 |
| R4 | 每个模块的错误码带前缀：`TASK_` / `OUTBOX_` / `INGEST_` / `RENDER_` / `WB_` | 新增错误码时检查；存量在 P1–P4 迁移时补（当前多数是中文 `Error`，没有 `code`） |
| R5 | 不允许反向依赖；不允许环 | `check:modules` 读 `module-map.json` 的 `dependsOn` |
| R6 | `content` 里的技能只能调 CLI，不能调内部函数；CLI 命令改名 = 破坏性变更，必须同步技能与文档 | `check:modules` 不查内容，靠 `cli.smoke.test.ts` + eval |
| R7 | `workbuddy` 是唯一能碰 WorkBuddy 本体的模块；别的模块只读它写的状态文件 | 代码评审 + FORK §11 台账 |
| R8 | 入口薄壳不算模块：`src/service/cli.ts`、`render/cli.ts`、`ingest/cli.ts` 只做参数解析与转发，不写业务 | 代码评审；薄壳超过 ~80 行即报警 |

**为什么 R6 重要**：技能里写的是 `node C:\ProgramData\anc\service\cli.ts ... task add ...`，这是内容与代码之间**唯一允许的耦合**。CLI 是公开契约，不能随手改名。

---

## 5. 源码布局 vs 部署布局

源码可以按模块搬，**部署入口不能动**：

| 源码 | 部署位置 | 说明 |
|---|---|---|
| `src/service/cli.ts`（薄壳） | `%ProgramData%\anc\service\cli.ts` | 稳定入口，技能/persona 引用 |
| `src/interfaces/cli/*` | `%ProgramData%\anc\interfaces\cli\*` | 17 组命令实现 |
| `src/modules/*` | `%ProgramData%\anc\modules\*` | 能力模块 |
| `src/core/*` | `%ProgramData%\anc\core\*` | 底座 |
| `src/render/cli.ts`（薄壳） | `%ProgramData%\anc\render\cli.ts` | 稳定入口 |
| `src/ingest/cli.ts`（薄壳） | `%ProgramData%\anc\ingest\cli.ts` | 稳定入口 |
| `scripts/<domain>/*.ps1`（运行时） | `%ProgramData%\anc\bin\<name>.ps1`（**扁平**） | 文件名不变，计划任务引用 |
| `scripts/deploy/*.ps1`（装机维护） | `%ProgramData%\anc\tools\<name>.ps1`（**显式清单**） | 清单外不上生产 |
| `light/*` | 由 `deploy-skills.ps1` / 渲染器部署 | 内容 |

`deploy.ps1` 的复制表已包含 `core` / `modules` / `interfaces`（2026-11-09 补上 `modules\executor` 映射）；**部署清单 158 文件（2026-11-10）；`bin\` 21 个运行时、`tools\` 26 个装机维护；用显式清单，清单外不上生产**。**先改部署脚本并跑通临时根，再搬源码**——顺序不能反。

---

## 6. 每块的"迭代单元"

一个模块算"可迭代"，要同时满足：

- [ ] `index.ts` 只导出公开 API（不导出内部类型/表句柄）
- [ ] `docs/modules/<id>.md` 有契约：目的 / 拥有 / 公开契约 / 不变量 / 失败模式 / 依赖 / 测试 / 改动指南
- [ ] 能单独跑测试（现在先挂在 `test:service` / `test:ingest` / `test:render` 下，迁移后加 `test:<id>`）
- [ ] 无反向依赖（`npm run check:modules -- --strict` 通过）；深导入已归零（`npm run check:modules:deep`）
- [ ] 变更记录在模块文档底部加一行
- [ ] 文档里写清"改动影响面"：改这块要同步哪些块

---

## 7. 现状盘点（P0 历史快照）

> 行数是 P0（2026-11-06）读数；P1–P7 已拆 core / CLI / loop / org / knowledge / scripts，进度见 §8。

| 文件 | 行数 | 问题 | 目标 |
|---|---:|---|---|
| `src/service/cli.ts` | 2 | P2 已拆：17 组在 `interfaces/cli/`，这里只剩转发 | 保持薄壳；超过 ~30 行就是业务写回来了 |
| `src/service/loop.ts` | 2 | P3 已拆：tick/run/carry/escalation/guard 在 `modules/runtime/`，sendPending 在 `modules/delivery/` | 保持薄壳；P4 后删 |
| `src/service/patch-drafts.ts` | 356 | diff 生成 + 模板插入 + prune 混在一起 | `improvement/patch/{draft,insert,prune}.ts` |
| `src/render/index.ts` | 324 | 渲染 + 事务部署 + 回滚 + 孤儿清理 | `org/{render,deploy,rollback}.ts` |
| `src/core/db.ts` | 304 | schema 字符串 + 迁移 + 事务（已迁） | `core/{db,schema,migrate}.ts` |
| `src/ingest/apply.ts` | 287 | 计划 + 锁 + 写入 + 回滚 + 归档 | `knowledge/ingest/{plan,lock,write,archive}.ts` |
| `src/service/eval.ts` | 251 | 用例加载 + emit + 轮询 + 判定 | `improvement/eval/{runner,judge}.ts` |
| `src/service/issues.ts` | 246 | 规则表 + 抽取 + 状态机 | 可保留，规则表单独 `rules.ts` |
| `src/service/tasks.ts` | 231 | 任务生命周期 | 保留，按需拆 `timeout.ts` |
| `src/service/a2a.ts` | 223 | 信封 + 归档 + 查询 | `knowledge/a2a.ts`，按需拆 |
| `src/interfaces/http.ts` | 165 | HTTP 面（P2 已迁入） | 保持薄；只做路由与鉴权 |
| `src/core/config.ts` | 156 | 配置校验 + 工作时段（已迁） | 保持；只放配置与工作时段 |
| `src/service/outbox.ts` | 153 | 队列机械 | `delivery/outbox.ts` |
| `src/service/submissions.ts` | 143 | 收集端 | `improvement/submissions.ts` |
| `src/service/dayend.ts` | 121 | 下班记录 | `improvement/dayend.ts` |
| `src/service/project.ts` | 107 | 任务投影 | `runtime/projection.ts` |

**重复实现**：

- `writeAtomic` 在 `src/render/render.ts` 与 `src/ingest/apply.ts` 各有一份 → 下沉 `core/fs.ts`。
- `sendPending` 在 `loop.ts`，但它是投递机制 → 归 `delivery`。

**已经比较干净的部分**：`bindings` / `reminders` / `outbox` / `config` 的依赖方向本来就是对的；**问题不是乱，是文件太大、入口混杂、没有契约**。

---

## 8. 迁移路线

原则：**每一步都不改行为，测试必须全绿；先改部署脚本，再搬源码。**

| 阶段 | 做什么 | 验收 | 回滚 |
|---|---|---|---|
| **P0 冻基线** | 打 tag；`package.json` 版本；README 分"现行/档案"；加 `module-map.json` + `check:modules`（只报告） | `npm test` 163；checker 0 违规 | 无代码改动 |
| **P1 抽 core** | **✅ 2026-11-06**：`src/core/{db,schema,migrate,tx,fs,config,outbound-scan,backup,audit}.ts`；旧路径薄壳已删除；P1b 拆完 schema/migrate/tx 与 `core/fs` | `npm test` 163；`check:modules:deep` 0 | `git revert` 单提交 |
| **P2 拆 service CLI** | **✅ 2026-11-06**：16 组拆到 `src/interfaces/cli/<group>.ts` + `registry.ts`；`src/service/cli.ts` 变薄壳；help 从注册表 `order` 生成；HTTP 面也迁入 `src/interfaces/http.ts` | `npm test` 163；`cli.smoke` 16 组断言过；serve 健康/鉴权实测 | 恢复旧 `cli.ts` |
| **P3 拆 runtime** | **✅ 2026-11-06**：`runtime/{tick,run,carry,escalation,guard}.ts` + `delivery/{send,index}.ts`；`service/loop.ts` 变薄壳；`sendPending` 归 delivery；core 旧薄壳删除，**深导入归零** | `npm test` 163；`check --strict-deep` 通过（0 深导入） | 恢复旧 `loop.ts` |
| **P4 拆 org / knowledge** | **✅ 2026-11-06**：`org/{persona,deploy,org,render,onboard,cli}.ts`、`knowledge/{a2a,summarize}.ts` + `knowledge/ingest/*`；`render/cli.ts` 与 `ingest/cli.ts` 变薄壳；identity/tasks/outbox/improvement/projection 一并迁入 `src/modules/`；`core/fs` 仍未下沉 | `npm test` 163；`check --strict-deep` 0；部署布局跑通 task/loop/render/ingest | 恢复旧 `render` / `ingest` |
| **P5 scripts 分组** | **✅ 2026-11-06**：49 个脚本按域分到 `deploy/doctor/selfheal/backup/rebuild/accounts/devbot/workbuddy/checks/launch`；`deploy.ps1` 递归收集并**扁平复制到 `bin\`**，文件名不变；`deploy.ps1` 自动从脚本位置向上找 `.git` | `deploy` dry-run 121 文件 / `bin` 32 个；`deploy-verify` 自动定位仓库；`npm test` 163 | 目录移回 |
| **P6 文档收口** | **✅ 2026-11-06**：12 份模块契约状态/路径/变更记录对齐；新增 `ROADMAP.md`（后于 2026-11-07 归档）；8 份基线文档加"历史快照"banner；README 换入口；新增 `npm run check:docs`（相对链接 0 断链） | `check:docs` 40 份 Markdown 0 断链；`check:modules --strict` 通过 | 文档可回退 |
| **P7 边界强制** | **✅ 2026-11-06**：`npm test` 的 `pretest` 自动跑 `npm run check`（`check:modules:deep` + `check:docs`）；深导入/文档断链直接红 | 故意造 `interfaces -> modules/tasks/tasks.ts` 深导入 → `npm run check` 退出 1；删除后 `npm test` 163 | 去掉 `pretest` |

**为什么 P1 先做 core**：它被所有模块依赖，先把它固定下来，后面的搬迁才不会反复改 import。

> **P0 进度（2026-11-06）**：`ARCHITECTURE.md`、`module-map.json`、12 份模块契约、`check:modules` 已落地；tag 与 `package.json` 版本号待维护者确认。
>
> **P1 进度（2026-11-06）**：`src/core/` 已建立，旧薄壳已在 P3 删除；P1b 又把 `db.ts` 拆成 `schema.ts` / `migrate.ts` / `tx.ts`，并把两份 `writeAtomic` 下沉到 `fs.ts`。`npm test` 163/163、`check:modules:deep` 0。
>
> **P2 进度（2026-11-06）**：service CLI 的 16 组命令已拆到 `src/interfaces/cli/<group>.ts` + `registry.ts` + `context.ts`；`src/service/cli.ts` 只剩 8 行转发；HTTP 面也迁到 `src/interfaces/http.ts`。`deploy.ps1` 增加 `interfaces` / `interfaces\cli` 映射，doctor 增加入口依赖检查。源码与部署布局都实测过 `task list`、`serve` 健康与 401/200 鉴权。
>
> **P3 进度（2026-11-06）**：`loop.ts` 拆成 `runtime/{tick,run,carry,escalation,guard}.ts`；`sendPending` 迁到 `delivery/send.ts`；`service/loop.ts` 变 2 行薄壳。`deploy.ps1` 增加 `modules\runtime` / `modules\delivery` 映射，doctor 增加对应入口依赖检查。同时把 core 的 5 个旧薄壳和所有 capability 模块的 `./db.ts` 引用清掉，**深导入 17→0，`--strict-deep` 已能通过**。
>
> **P4 进度（2026-11-06）**：identity / tasks / delivery.outbox / improvement / knowledge / org 全部迁入 `src/modules/`；`render/index.ts` 拆成 `persona.ts`（渲染）与 `deploy.ts`（事务部署/回滚），`render/cli.ts`、`ingest/cli.ts`、`service/cli.ts`、`service/loop.ts` 都只剩薄壳。`deploy.ps1` 增加 7 个模块映射，doctor 增加 3 个入口依赖检查。部署布局实测 `task list` / `loop --once` / `render`（persona + groups.json）/ `ingest` 全通。**12 个模块全部 `current`，深导入 0，违规 0（2026-11-09 新增 `executor`，现 13 个）。**
>
> **P5 进度（2026-11-06）**：49 个脚本按域分组；`deploy.ps1` 的 `bin` 映射改为递归 + `SkipDirs`，目标仍是扁平的 `bin\<原文件名>`；`deploy.ps1` / `register-tasks.ps1` / `rebuild-drill.ps1` / `devbot-scheduler.ps1` 改为从脚本位置向上找 `.git`；`deploy-verify.ps1` 增加 repo/部署两种布局的根探测；`deploy-persona.ps1` 的源路径、`rebuild-z.ps1` 的 `set-acl` 路径都加了仓库/部署候选。`npm test` 163、`check:modules:deep` OK、`check-public` 零输出。
>
> **P6 进度（2026-11-06）**：12 份模块契约统一到 P4/P5 后的真实路径，并补了各自的迁移变更记录；新增 `docs/archive/history/REFACTOR-ROADMAP.md`（P0–P5 已完成、P1b/P6/P7 剩余工作）；`VERIFY` / `ACCEPTANCE` / `PLAN` / `DECISIONS` / `RELEASE-CHECKLIST` / `REUSE-MAP` / `UPSTREAM-COVERAGE` / `VERIFY-INDEX` 顶部加"历史基线"banner；README 的"代码在哪"改指 `src/modules/` 并新增"架构与路线"；新增 `scripts/checks/check-docs.mjs`（`npm run check:docs`），40 份 Markdown 0 断链。
>
> **P7 进度（2026-11-06）**：`package.json` 增加 `check` = `check:modules:deep` + `check:docs`，并用 `pretest` / `precoverage` 挂到 `npm test` / `npm run coverage`；新增 `npm run check` 供手动跑。故意在 `interfaces/cli/summary.ts` 造一条 `modules/tasks/tasks.ts` 深导入，`npm run check` 退出 1 并点名该文件；删除后 `npm test` 恢复 163/163。
>
> **P1b 进度（2026-11-06）**：`core/db.ts` 拆成 `db.ts`（`openDb` + 时间函数）、`schema.ts`（全量建表）、`migrate.ts`（只加列/主键重建）、`tx.ts`（SAVEPOINT/IMMEDIATE）；两家 `writeAtomic` 下沉到 `core/fs.ts`（org 保留备份/读回校验/5 次重试，ingest 保留 `wx` + 单次 rename）。`npm test` 163/163、`check:modules:deep` 0。**模块化 P0–P7 + P1b 全部完成。**

---

## 9. 每阶段的回归

不涉及部署：

```powershell
npm test                       # 252/252，不得少
npm run check:modules          # 0 违规
```

涉及部署（P1 / P5）：

```powershell
powershell -File scripts\deploy\deploy.ps1                     # dry-run，先看复制表
powershell -File scripts\deploy\deploy.ps1 -Root <临时根> -Apply
powershell -File scripts\deploy\deploy-verify.ps1 -Root <临时根> -Side company -Json
powershell -File scripts\doctor\doctor.ps1 -SelfTest
```

上主机后：

```powershell
powershell -File scripts\deploy\deploy-verify.ps1 -Side company -Json   # ok: true
powershell -File scripts\doctor\doctor.ps1 -Repo <仓库> -Json            # FAIL=0
```

**硬门槛**：`node C:\ProgramData\anc\service\cli.ts --json task list` 这条命令在任何阶段都必须照旧可用——它是技能与 persona 的入口。

---

## 10. 不做什么

- **不引构建链 / 打包器**：Node 22 直接跑 `.ts`，保持零依赖。
- **不引第三方运行时依赖**：`npm ls --depth=0` 必须还是空。
- **不改运行时入口路径**：技能、persona、计划任务都引用它们。
- **不拆微服务 / 多进程**：单机、函数调用足够；拆进程只会把事务与幂等变复杂。
- **不为每块建独立 npm 包**：这是单仓库单产品，不是库生态。
- **不为了好看重命名所有文件**：只搬必须搬的。
- **不编辑 `archive/history/VERIFY.md` 正文**：混合换行 + 大量行尾 CR，编辑风险高；要追加只能用字节级脚本。现行结论摘要看 [STATUS.md](./STATUS.md)。

---

## 11. 模块索引

| 模块 | 契约 |
|---|---|
| core | [modules/core.md](./modules/core.md) |
| identity | [modules/identity.md](./modules/identity.md) |
| tasks | [modules/tasks.md](./modules/tasks.md) |
| executor | [modules/executor.md](./modules/executor.md) |
| delivery | [modules/delivery.md](./modules/delivery.md) |
| knowledge | [modules/knowledge.md](./modules/knowledge.md) |
| org | [modules/org.md](./modules/org.md) |
| improvement | [modules/improvement.md](./modules/improvement.md) |
| runtime | [modules/runtime.md](./modules/runtime.md) |
| interfaces | [modules/interfaces.md](./modules/interfaces.md) |
| workbuddy | [modules/workbuddy.md](./modules/workbuddy.md) |
| ops | [modules/ops.md](./modules/ops.md) |
| content | [modules/content.md](./modules/content.md) |

模板与填写规则见 [modules/README.md](./modules/README.md)。

---

## 变更记录

| 日期 | 改了什么 | 为什么 |
|---|---|---|
| 2026-11-06 | 建档：12 个模块、依赖规则、源码/部署布局、P0–P7 迁移路线 | fork 阶段收口，后续按块迭代 |
| 2026-11-09 | executor 的 owns 补 `executor_events`/`executor_evaluations`；§11 补 executor 行；§5 补部署实测 158 文件（2026-11-10 部署清单） | 主干 0 文档收口（GAP-066，13 模块现状对齐） |
| 2026-11-09 | executor 增加 `attentions` 表与 Attention API | 主干 3 T3.1 数据层 |
| 2026-11-10 | `attention answer` 强制 `--source-msg`、服务端从 `patch-in.log` 重推导入站消息；补丁入站前缀补 `msg=` / `quote=`；部署清单拆 `bin\`（运行时）/ `tools\`（装机维护）；D46–D52 已登记 | BATCH-20261110 公司侧收口（主干 0/1/2/3 已收口），ACC-17 按 D48 书面例外 |
