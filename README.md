# workbuddy-anc

> 类型：入口（项目概览）

小团队的「AI native 公司」落地仓库：一台 7×24 的 Windows 主机跑一个**公司 bot**，每个员工电脑跑一个**个人 bot**，执行引擎是腾讯 **WorkBuddy（企业版）**，IM 是**企业微信**，公司知识放在主机上的 markdown vault 里。

基于 [HA7CH/ai-native-company](https://github.com/HA7CH/ai-native-company)@`90e4fb2`（MIT）二次开发，结构照搬上游的制造企业试点；上游写的是 Mac mini + cc-connect + Claude Code，和本库的形态不同，上游原文只作参考（见 [reference/upstream/](./reference/upstream/README.md)）。

## 想装一套？把仓库链接发给你的 agent

> **先读这份**：[`docs/PRODUCT.md`](./docs/PRODUCT.md) —— 部署完能干什么、每项能力怎么用。

**不用照文档一步步做。** 把这个链接发给本机的 agent（**首选这台机器上的 WorkBuddy 自己**，
也可以用 Claude Code / Codex），让它读完仓库自己装：

```
https://github.com/GoldenTellus/workbuddy-anc
照这个仓库把自己装成【公司侧 / 员工侧】。装完告诉我装到哪一步、哪一步卡住了。
```

| 你要装 | 第 0 步（只有人做） | 之后 |
|---|---|---|
| **公司侧**（一台 7×24 的主机） | 装一个**空的** WorkBuddy，装完不要配任何东西 | agent 从建目录一路做到自证 |
| **员工侧**（你的办公电脑） | 无——WorkBuddy 本来就在用 | agent 装 persona、技能、绑定你自己的群 |

**agent 会问你这几件事**（提前准备好）：企微 corpid 与群机器人 webhook、部门划分、员工名单与 userid。

细节见 [docs/PRODUCT.md](./docs/PRODUCT.md)（能做什么）与 [docs/DEPLOY-COMPANY.md](./docs/DEPLOY-COMPANY.md) / [docs/DEPLOY-EMPLOYEE.md](./docs/DEPLOY-EMPLOYEE.md)（怎么装）。

### 装完之后：验一遍（★ 新机器必读）

**如果你是一台新机器、一个新 agent**，除了装，还请你帮忙验证——这个项目现在最缺的就是"第二个人能不能独立装起来"这件事被真正验过。

**读这份**：[docs/RELEASE-CHECKLIST.md](./docs/RELEASE-CHECKLIST.md)（现行发布门禁）；历史交接记录在 [docs/archive/history/AGENT-VERIFY-HANDOFF.md](./docs/archive/history/AGENT-VERIFY-HANDOFF.md)。

它包含：

- **这台机器能验什么、不能验什么**（先确认角色，别白干）
- **待验证任务清单**（D4.6 / O-5 / E-1 的员工机一半 / devbot 22:00 自动触发 / REBUILD 复验）
- **25 条踩过的坑**（PowerShell 大小写敏感、CRLF、`if` 解包数组、Interactive 任务静默不执行…）
- **6 个可复用的测试方法**（故障注入、注入时间而不是改系统时间、真关掉而不是伪造 SKIP…）

**装的时候会问你的**：机器是干净机还是员工机、有没有管理员权限。

---

## 本库做什么、不做什么

**不自己实现** agent 框架、**不写** IM 网关——这两样都用现成的：IM 用 WorkBuddy 自带的企微机器人，
agent 用 WorkBuddy 本身（迭代闭环里的 devbot 也用它，不另造一个）。本库只做它们之外、必须确定性完成的部分：

> 「不写」和「不用」是两件事。项目里没有一行 agent 框架代码，但**会用一个现成 agent 去改技能**
> （迭代闭环里的 devbot）。两者的区别是"造工具"与"用工具"。

| 部分 | 位置 | 作用 |
|---|---|---|
| 本地小服务 | `src/modules/{tasks,identity,delivery,runtime}` | 任务与提醒、完成判定、outbox（经群机器人 webhook 发消息）、群/人/角色/部门、工作时段、A2A 访谈归档。SQLite 为真相；`src/service/cli.ts` 只是入口薄壳 |
| 入库进程 | `src/modules/knowledge/ingest/` | 校验公司 bot 整理好的批次并写进 vault：路径校验、覆盖写必须带 base hash、原件只许新建、事务回滚。不调模型 |
| 渲染器 | `src/modules/org/` | 从 org 数据（角色 × 成员）生成 persona（`CODEBUDDY.md`）、个人接入包、群映射 |
| WorkBuddy 补丁 | `scripts/workbuddy-patch/`、`scripts/workbuddy/` | 把群标识与发送人注入消息正文（D17）、拦自动升级；带版本绑定、一键关闭、自愈与守卫 |
| 主机运维 | `scripts/<domain>/` | 体检、watchdog、备份、开机提醒、附件清理、更新探测、自愈；部署仍扁平到 `bin\` |
| 技能与 persona | `light/` | 公司 bot 的技能、persona、渲染模板、vault 模板、个人 bot 的技能名片 |

## 架构与进度

- **现行切分**：[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) —— 13 个模块的边界、依赖规则、部署布局。
- **模块契约**：[docs/modules/](./docs/modules/) —— 改某块之前必须知道的约束；机器可读版是 [`module-map.json`](./module-map.json)。
- **未来发展设计**：[docs/FUTURE-DESIGN.md](./docs/FUTURE-DESIGN.md) —— 主干（你的想法）、分支（讨论细节）、叶子（待定问题）。
- **当前计划**：[docs/PLAN.md](./docs/PLAN.md) —— 当前主干怎么落地。
- **已完成 / 缺口**：[docs/STATUS.md](./docs/STATUS.md) —— 做完什么、还缺什么。
- **文档联动规则**：[docs/DOC-SYNC.md](./docs/DOC-SYNC.md) —— 主干完成时哪些文档要跟着更新。
- **来源与许可证**：[docs/UPSTREAM.md](./docs/UPSTREAM.md) + [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。
- **仓库导航**：[docs/INDEX.md](./docs/INDEX.md) —— 哪个文件管什么、命令怎么跑。
- **边界检查**：`npm test` 的 `pretest` 会自动跑 `npm run check`（模块边界 + 文档检查），0 违规、0 深导入才继续跑测试。

## 能实现什么（举例）

一句话：**员工在群里说人话，公司拿到确定的结果。** 凡是"该不该提醒、算不算做完、消息发没发出去、资料有没有进库"这种不能靠猜的事，都由本地代码判定，模型只负责听懂和复述。

### 员工视角：在群里 @ 公司 bot

| 你说 | 系统实际做什么 | 结果落在哪里 |
|---|---|---|
| `提醒我明天 10 点交周报` | 登记成任务并把 `due_at` 换算成 UTC；到点由本地服务入队，经**该群自己的**群机器人 webhook 发出并 @ 你 | `tasks` / `reminders` / `outbox` 三张表 |
| `今天有什么任务` | 只列 `status=open`，不把已完成的翻出来 | 库；同一份内容投影到 `<内部区>/collab/tasks.md` |
| `做完了` | 状态转 `done`、停掉未发的提醒、往群里发一条完成公告；同一个人重复说只算一次 | `task_events` 留一条 `completed` |
| `这周先不催了` | 任务转 `cancelled`，**连带**取消它还没发出的提醒，不会出现"任务取消了但提醒还在响" | `task_events` 留 `cancelled` |
| 引用一份 PDF 说 `入库` | 整理成 markdown + `meta.json` 写进批次目录 → 入库进程校验（路径不许跳出 vault、覆盖写必须带读取时的 base hash、原件只许新建）→ 写进共享区**工作区** | 批次归档到 `inbox/done`；文件等人复核后才 `--commit` |
| `上次那个报价模型在哪` | 只回**路径与标题**，正文不喂给模型（D19：资料不上云），要看内容在本机打开文件 | vault 里的文件 |
| （访谈到点，不用你说） | 按规则版本、题数、`expected` 名单校验答案，归档到内部区；答不上来超时进 `needs_review` | `a2a` / `outbox` |

工作时段外说"提醒我 3 点"，不会 3 点把人叫起来——自动推到下一个工作起点。节假日同理。

### 后台长任务（D22）

| 场景 | 行为 |
|---|---|
| `跑一下月度汇总` | 登记成 `kind=background` 的任务；bot 动手时调 `task start` 记下开始时间 |
| 跑了 40 分钟没动静 | 超过 `timeout_minutes` 自动转 `needs_review`，通知交办人**一次**（`dedupe_key` 带开始时间，重排后再卡住会重新报） |
| 你回 `重排` / `关掉` | `task review --decision retry` 回到 open 并清掉开始时间；`close` 直接取消并停提醒 |
| 关键约束 | `needs_review` 只能由人复核离开；系统**不自动重试**，避免死循环里反复烧钱 |

### 管理员视角

| 操作 | 效果 |
|---|---|
| 改 `org/members/*.md` 后 `render deploy --db ...` | 整组事务：快照 → 渲染 → 逐产物读回对拍 → org→DB 同步/校验 → 任一失败**整体还原**，不会留"一半新一半旧" |
| `render verify` | 用指纹 + manifest 检出产物被手改（改过就说明线上与 git 不一致） |
| 有人离职：org 加 `disabled: true` 再跑 `offboard-member.ps1` | 清掉他的 persona 产物、从 `groups.json` 移除、解绑员工群（groups 表停用还没自动化）、open 任务转交新人；**vault 里的档案不动** |
| `doctor.ps1` | **31 项**体检：12 个计划任务的运行主体、补丁 `APPLIED`、secrets 目录 ACL、备份新鲜度、**入库绕过检测** 等；故意弄坏一处必须能 FAIL |
| `backup-anc.ps1` | `VACUUM INTO` 一致性快照 + 完整性校验；离机目标与本地**同盘时告警**（同盘不算离机）；失败必发运维告警；日档 60 份 + 每月 1 号留 12 份 |
| 查"谁动过库" | `%ProgramData%\anc\data\audit.log` 每次 CLI 调用留一行（只记命令与目标，不记参数值） |
| 查"资料是不是被绕过入库" | vault 里出现未跟踪文件、但 1 小时内没有成功的 `ingest apply` 记录 → `doctor` 直接 WARN |
| 探活 | `GET http://127.0.0.1:<端口>/__anc_health` 不用 token；业务路由必须带 token，未配置 token 时一律 503 |

### 明确做不到的

- **不产出文档内容**：入库只做校验、归档与索引，整理稿由 bot 写、由人复核。
- **没有公网入口**：HTTP 面只绑 `127.0.0.1`，公司 bot 与本机服务都在内网。
- **模型的旁白挡不住**：多步工具链里它仍会说「我先看一下」这类过程话，persona 禁止词表已验证无效。**2026-11-04 查清：出站过滤在代码层也做不到**——企微走流式（`sendStreamChunk`），整句在发出前就发完了（`VERIFY §17`）。所以这条降级成 persona 约束，是**已知代价**，不是待办。
- **未实测的四项**：员工转发的 A2A 通道（T14）、技能同步到员工机（T15）、两个群同时提问（T8）、企微真 1:1 的 `boss_dm` 通道（T11）。**全卡外部条件**——要员工机、企业版后台、第二个群、企微管理后台，不是代码没写完。

## 架构一览

```
企业微信
  ├─ 员工群：本人 + 公司 bot + 本人的员工 bot（加提醒用群机器人）
  ├─ 部门群：部门员工 + 部门管理者 + 老板 + 公司 bot
  ├─ 公司大群：老板 + 全体员工 + 公司 bot
  └─ 老板 1:1（不可用时退化为“老板 + 公司 bot”的私有群）

Windows 主机（7×24）
  ├─ 公司 bot：WorkBuddy + D17 补丁（消息开头带 [anc:chat=<chatid> from=<userid>]）
  ├─ 本地小服务：计划任务每分钟一次 tick
  ├─ vault 共享区（全员只读，SMB）/ 内部区（只有公司侧读写），各是一个 git 目录
  └─ inbox：公司 bot 投递 → 入库进程校验后写入

员工电脑：员工 bot（WorkBuddy），只服务本人，只读 vault 共享区
```

群/人/角色的真相在 `people` / `groups` / `manager_scopes`；`chat_bindings` 只保留为员工群的兼容层。**未识别/未绑定的群不猜人、不退回默认群。**

**四类群与角色不是靠记忆**：公司 bot 每轮先跑 `bind actor`，用 `group.type`（employee/department/company/boss_dm）和 `person.system_role`（boss/manager/employee）决定能看什么、能在哪答；真实群验收见 `STATUS §3.5`。

确定性的事（状态、计时、「完成」判定、出站消息）一律归本地小服务，不交给模型。

## 现状

- 13 个模块全部 `current`；`npm test` **204/204**；`npm run check`（模块边界 + 文档检查）通过。
- 1.0 的历史计划、验收、实测已归档：见 [PLAN-1.0](./docs/archive/history/PLAN-1.0.md)、[ACCEPTANCE](./docs/archive/history/ACCEPTANCE.md)、[VERIFY](./docs/archive/history/VERIFY.md)。
- **未来方向**看 [docs/FUTURE-DESIGN.md](./docs/FUTURE-DESIGN.md)；**当前主干**看 [docs/PLAN.md](./docs/PLAN.md)；**已完成/缺口**看 [docs/STATUS.md](./docs/STATUS.md)。
- 文档已分层：方向 / 执行 / 账本 / 现状 / 运维 / 来源 / 历史；入口是 [docs/INDEX.md](./docs/INDEX.md)。

## 从哪里开始读

| 想了解 | 读 |
|---|---|
| **项目怎么分块、边界在哪、怎么按块迭代** | **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)**（`module-map.json` + `npm run check:modules`） |
| 为什么这么设计、所有已定裁决 | [docs/DECISIONS.md](./docs/DECISIONS.md)（决策台账） |
| **未来要建什么** | [docs/FUTURE-DESIGN.md](./docs/FUTURE-DESIGN.md)（主干/分支/叶子） |
| 做到哪了、下一步做什么 | [docs/STATUS.md](./docs/STATUS.md) + [docs/PLAN.md](./docs/PLAN.md) |
| 实测记录 | [docs/archive/history/VERIFY.md](./docs/archive/history/VERIFY.md) |
| **发布前要查什么** | **[docs/RELEASE-CHECKLIST.md](./docs/RELEASE-CHECKLIST.md)**（bug/漏洞视角，四阶段：补代码缺口 → 证明能自愈 → 清空重装 → 陌生 agent） |
| 主机怎么运维、怎么重建 | [docs/OPS.md](./docs/OPS.md)、[docs/REBUILD.md](./docs/REBUILD.md) |
| 各组件用法 | [LOCAL-SERVICE](./docs/LOCAL-SERVICE.md)、[INGEST](./docs/INGEST.md)、[RENDERER](./docs/RENDERER.md)、[ONBOARDING](./docs/ONBOARDING.md)、[WORKBUDDY-PATCH](./docs/WORKBUDDY-PATCH.md) |
| 借了上游什么、许可证 | [docs/UPSTREAM.md](./docs/UPSTREAM.md) + [docs/upstreams/](./docs/upstreams/) |
| 陌生 agent 接手 / 交班提示词 | [docs/INDEX.md](./docs/INDEX.md)、[docs/archive/history/AGENT-VERIFY-HANDOFF.md](./docs/archive/history/AGENT-VERIFY-HANDOFF.md)（历史坑） |
| 上游 4 份原样文档什么时候才看 | [docs/UPSTREAM.md](./docs/UPSTREAM.md) |
| **仓库导航 / 现状数字 / VERIFY 检索** | **[docs/INDEX.md](./docs/INDEX.md)**、[docs/archive/history/VERIFY-INDEX.md](./docs/archive/history/VERIFY-INDEX.md) |

上游原文（仅作参考）：[SPEC.md](./SPEC.md)、[reference/upstream/originals/M1-DESIGN.md](./reference/upstream/originals/M1-DESIGN.md)、[reference/upstream/originals/LESSONS-MANUFACTURING-PILOT.md](./reference/upstream/originals/LESSONS-MANUFACTURING-PILOT.md)、[reference/upstream/originals/LIGHT-MVP.md](./reference/upstream/originals/LIGHT-MVP.md)、[reference/upstream/originals/RESEARCH.md](./reference/upstream/originals/RESEARCH.md)。

## 开发约定

- 文档中文为主；TypeScript + Node 22 LTS，零运行时依赖；主机脚本用 PowerShell 5.1（`.ps1` 必须带 UTF-8 BOM，`.json` 不带）。
- 开发流程：分支 → PR → 验证 → squash merge。
- 部署：从仓库复制到 `%ProgramData%\anc\`（命令见 REBUILD §3），主机上手改线上文件视为事故。
- 泄密防线：生产细节只放 `_research/`（不进 git）；转公开前跑 `node scripts/checks/check-public.mjs` 并人工过一遍全量 diff。

`package.json` 保持 `"private": true`，不发 npm。

## License

MIT。上游版权 © HA7CH，见 [LICENSE](./LICENSE)。
