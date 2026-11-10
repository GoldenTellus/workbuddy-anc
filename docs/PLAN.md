# PLAN — 当前批次：正式生产部署 + 零起点装机 + 主干 1/2/3 设计符合性检验

> 类型：执行（当前批次）
> 状态：**待开工（2026-11-10）；阶段 1 公司侧部署 + 零起点装机检验**
> 上游：[FUTURE-DESIGN.md](./FUTURE-DESIGN.md) 主干 0 §0.0；[STATUS.md](./STATUS.md) §2 / §3.5
> 账本：[STATUS.md](./STATUS.md)
> 决策：[DECISIONS.md](./DECISIONS.md) D25 / D32 / D35 / D36 / D40–D52
> 上一个批次：[archive/completed/BATCH-20261110-FINAL.md](./archive/completed/BATCH-20261110-FINAL.md)
> 完成后：快照到 `archive/plans/BATCH-DEPLOY-<日期>.md`

## 1. 目标

用户决定（2026-11-10，原话）：「正式给我的公司部署这个项目，并且在部署过程中看看有什么问题，并检验主干 1/2/3 是否符合了我的设计」；规划「先部署公司侧，公司侧没问题了再去部署员工侧」。同日追加：还要检验「**一台主机从 0 开始部署这个项目的过程**」，并请项目侧补充他没想到的检验维度（见 §6.5）。

本批**不是新功能主干**，仍归主干 0（常驻清债），做四件事：

1. 把**公司侧**按 `BOOTSTRAP.md` 四步正式装到生产主机，走通部署自动化全链路；
2. **单独验一台主机从 0 开始的完整装机链路**（干净机 + 未参与过开发的 agent），补上 GAP-104 留的遗留；
3. 在真实生产运行里**逐项检验主干 1/2/3 是否符合设计**，并按 §6.5 补充维度检验长期运行、真实负载、安全、可移交等（范围由用户挑定）；
4. 公司侧**准出后**再部署员工侧，补齐 ACC-17（此前为 D48 书面例外）。

**完成定义**：

- 公司侧与员工侧部署均有机器证据；公司侧 7 条准出条件逐项有结论；
- **零起点装机链路有独立证据**（`Z-01..Z-12`），且卡点记录完整；
- 主干 1/2/3 符合性矩阵（§6）每项有 `符合 / 偏离且已登记 GAP / 用户裁决接受` 的判定与证据；§6.5 中用户挑定纳入本批的补充项逐项有结论；
- 部署与检验中发现的每个问题都进 `STATUS` 的 `GAP-###` 并处置，不静默跳过；
- ACC-17 用员工侧真实机器证据收口，`STATUS` §3.5 的 ACC 行按真实现状更新；
- `npm test` 全绿（当前 253/253）、`npm run check` 通过、`check-public` 零输出；
- `STATUS` / `FUTURE-DESIGN` / `PLAN` / `PRODUCT` / `ARCHITECTURE` / 模块契约 / 接口 / 运维 / `RELEASE-CHECKLIST` / `DECISIONS` 同步，`STATUS` §4 填审计行；
- 员工 bot 仍是旧员工侧实现 的部分，明确记为**主干 4 缺口**，不伪装成通过。

## 2. 起始基线（2026-11-10 18:00）

```text
主干：0 / 1 / 2 / 3 已收口；主干 4（员工 bot handoff / 本地执行）未实现
测试：252 / 252；覆盖率 88.97 / 79.03 / 93.95；测试文件 29
模块：13 / 13 current；CLI 17 组；技能 9（含 anc-update）；运行时依赖 0
计划任务：14（9 LOCAL SERVICE / 2 SYSTEM / 3 交互，含 anc-elevate）
部署清单：158 文件（bin 21 运行时 / tools 26 装机维护）；deploy-state 12/14
doctor：35 项（21 字面量 + 14 个 task-* 覆盖项）
Node：v22.22.2（设计基线 22 LTS）
ACC：ACC-01..22；仅 ACC-17（员工侧双机全量）按 D48 书面例外
员工电脑：旧员工侧实现，未正式部署
开放 GAP：091（ingest 审计字段，S3，不阻塞）；090 / 092 已接受
遗留：全新机器首次完整部署链路（install-company → patch 重启 → patch-guard）
      仅在存量本机验过，干净机未实跑（GAP-104）
文档：2026-11-10 已完成全量核对（GAP-108 已修，check:docs 41 份通过）
```

## 3. 主干 0 本批定位

方向、准出条件、符合性判据与归账规则**以 [FUTURE-DESIGN.md](./FUTURE-DESIGN.md) §0.0 为唯一来源**，本文件不复制结论，只写怎么执行、怎么留证据。

- 主干 0 验收状态已由 ✅ 回到 **🟡 待验收**，直到 §1 完成定义全部满足。
- 0.4（运维/部署）、0.7（设计反哺）、0.8（真实环境验收）三个分支随本批保持 🟡。
- 主干 1/2/3 的设计与实现状态保持 ✅；本批复核的是**生产环境符合性**，发现偏离按 0.7 登记 `GAP`，不改设计去迁就实现。

## 4. 两阶段与闸门

| 阶段 | 内容 | 准入 | 准出 |
|---|---|---|---|
| **阶段 1** | 公司侧正式部署（§5）+ **零起点装机检验（§5.1）** | 生产主机就绪、WorkBuddy 以管理员打开、企微后台已配好群机器人 | 14 任务 Ready、doctor 35 项 FAIL=0、deploy-verify PASS、`executor-deploy.json ok:true`；Z 系列有独立证据 |
| **阶段 2** | 主干 1/2/3 设计符合性检验（§6.1–6.3）+ 补充维度（§6.5 中用户挑定部分） | 阶段 1 准出 | 符合性矩阵逐项有证据与判定；偏离项已登记 `GAP` 并处置或由用户裁决 |
| **闸门** | 公司侧准出评审（§4.1） | 阶段 1 + 2 完成 | **7 条全过才允许开阶段 3** |
| **阶段 3** | 员工侧部署 + ACC-17（§7） | 闸门通过 | 员工侧 EMP 项通过、ACC-17 有机器证据 |
| **阶段 4** | 问题收口 + 文档同步 + 门禁 + 快照（§8–§11） | 阶段 3 完成 | §1 完成定义全满足 |

### 4.1 准出评审（公司侧 → 员工侧的闸门）

按 `FUTURE-DESIGN` §0.0 的 7 条逐项判定，每条写 `符合 / 不符合 / 例外（须用户书面确认）`：

1. 14 个计划任务 Ready、doctor 35 项 FAIL=0、`deploy-verify` PASS、`setup-executor` 自动收尾 `ok:true`；
2. 四类群 + 三角色在生产环境 `bind actor` 全部正确，隐私路由不串群；
3. 主干 1/2/3 符合性清单在生产环境逐项有证据，偏离项已登记 `GAP` 并完成处置或由用户明确接受；
4. 至少一次真实任务全链路：派活 → Main 只建 Ticket → 定向 wake → host 起 subagent 产物 → review 短号确认 → Task done；
5. 备份/恢复、升级、回滚各演练一次，生产数据零丢失；
6. 没有 `S0` / `S1` 的开放 `GAP`；
7. **零起点装机链路有独立证据**：干净机（或备用机）上由未参与过开发的 agent 只拿仓库链接 + `BOOTSTRAP.md` 独立装完，记录卡点；生产机不是干净机时不得拿生产机充当此证据。

评审结论写进 `STATUS` §1 与 §3.4；**未过闸门不得开员工侧**，若用户决定带例外推进，必须写进 `DECISIONS` 并在 §13 留痕。

## 5. 阶段 1：公司侧正式部署

> 证据根：`%ProgramData%\anc\stage\deploy-<日期>\company\`。每台机器一个目录，按步骤建子目录；命令输出、JSON、DB 快照、截图都留原文件。

| ID | 步骤 | 命令 / 动作 | 预期 | 证据 |
|---|---|---|---|---|
| **C-01** | 定 side 与身份 | 确认这是「公司那台常开的主机」；WorkBuddy 以管理员身份打开 | `preflight` 的 `agent-elevated` 不是 blocker；机器画像 `admin-elevated` | `preflight.json` |
| **C-02** | 环境 | `scripts\deploy\bootstrap.ps1 -InstallDeps` | Node ≥22 / Git 就绪，缺的由 winget 装好并刷 PATH | `bootstrap.json` |
| **C-03** | 体检 | `preflight.ps1 -Side company -Json` | `ok:true`，`blockers:[]`；5 类画像与 `guidance` 正常 | `preflight.json` |
| **C-04** | 访谈 | `deploy-kickoff.ps1 -Phase identity/prepare/collect/check` | 准备清单已给人且确认做完；`deploy-answers.json` 通过校验（webhook 只存文件名） | `kickoff/` |
| **C-05** | 一条命令装 | `scripts\deploy\install-company.ps1 -VaultRoot <vault 根> -Apply` | 11 步按序跑完（`preflight` 只跑不记账）；失败即停，用 `-From` 续跑不从头来 | `install-company.log`、`deploy-state.json` |
| **C-06** | 补丁重启后自动收尾 | `patch` 重启 WorkBuddy → `anc-patch-guard` 自动跑 `setup-executor -Apply -Marker` | 工作区自动加入、TEST 收到回复、当天 host 注册；`executor-deploy.json ok:true`、marker 已删 | `executor-deploy.json`、`wb-wake.log` |
| **C-07** | 自证 | `tools\deploy-verify.ps1 -Side company -Json`；`doctor.ps1 -Json` | 14/14 任务 Ready；doctor 35 项 FAIL=0；`deploy-verify` PASS（`bot-reply` 无绑定群可 SKIP） | `deploy-verify.json`、`doctor.json` |
| **C-08** | 安全边界 | 检查 secrets ACL、vault 两区权限、webhook 文件内容无 BOM/换行、`check-public` 零输出 | secrets 不进 git；共享区只读、内部区仅公司侧 | `acl/`、`check-public.out` |
| **C-09** | 演练 | 备份 → 副本恢复 → `upgrade -Action apply` → `rollback` 各一次 | 生产 DB / org / vault 数据零丢失；`version.json` 记 rev/prevRev | `drill/` |
| **C-10** | 真实群接线 | 四类群加机器人、采集真实 sender id、`org-write` / `sync-org` / `verify-org` | 四类群 `bind actor` 正确；首次绑定可由 bot 自动完成 | `bind-actor/`、`verify-org.json` |

**易踩的坑**（来自本机实测，正式机要复核）：`wb-wake-workspace.txt` 必须是**绝对路径**；`register-tasks.ps1` 从部署根 `tools\` 跑要传 `-Repo`；员工侧部署根不存在会卡在 files；`anc-executor-host-tick` 指向 `host-tick.ps1`；`backup-anc.ps1` 默认 20h 间隔会跳过迁移后备份，部署/迁移后要 `-MinIntervalHours 0`。

### 5.1 零起点装机检验（Z 系列，用户点名）

此前所有部署都在**存量本机**（已有 Node / Git / WorkBuddy / 项目数据），GAP-104 明确留了「全新机器首次完整部署链路尚未在干净机实跑」。这项要单独留证据：

| 情形 | 怎么做 | 证据 |
|---|---|---|
| **A** 生产主机本身是干净机 | C-01..C-10 即为零起点全过程，额外按 Z-01..Z-12 逐项记录 | `zero/` |
| **B** 生产主机已有环境 | 另用备用机 / 虚拟机做独立演练，**不碰生产数据**；生产机只验 C 系列 | `zero/` + `company/` |

| ID | 检验点 | 预期 |
|---|---|---|
| Z-01 | 起点干净：无 Node / Git / WorkBuddy / `%ProgramData%\anc` / vault / org | 现场截图 + 目录清单 |
| Z-02 | 让**未参与过开发的 agent 或人**，只拿仓库链接 + `BOOTSTRAP.md`，不额外口述提示，独立装完 | 记录每一步问了什么、卡在哪、是否要靠仓库外的信息；这是 README「第二个人能不能独立装起来」的真答案 |
| Z-03 | `bootstrap.ps1 -InstallDeps` 自动装 Node/Git 并刷 PATH | 同一会话内 `node -v` / `git --version` 可用；无 winget 时给出官方链接 |
| Z-04 | `preflight` 的 5 类机器画像与 blocker/fix | 与实际机器一致；未提权时公司侧确实拦住 |
| Z-05 | `deploy-kickoff` 四段访谈 | 准备清单人能看懂、问题集够用、缺信息时明确卡在哪节 |
| Z-06 | `install-company -Apply` 11 步一次跑完 | 每步 `deploy-state` 记账；`preflight` 只跑不记账 |
| Z-07 | 中途失败 → `-From <阶段>` 续跑 | 已完成阶段不重做、数据不丢（断点续装的核心承诺） |
| Z-08 | `patch` 重启 → `anc-patch-guard` 自动 `setup-executor -Marker` | 工作区自动加入、TEST 收到回复、当天 host 注册、`ok:true`、marker 删除——**全新机器首次完整链路，此前未验** |
| Z-09 | 全新机的 `deploy-state` | `brief` / `answers` / `executor` 应有值（存量机为 N/A），目标 14/14 或明确说明例外 |
| Z-10 | 产物自证与边界 | 158 文件 hash 全过、bin 21 / tools 26、清单外脚本不上生产、secrets 不进 git、check-public 零输出 |
| Z-11 | 重装 / 回滚幂等 | 再跑一次 `-Apply` 或 `-Rollback` 后仍能自证，数据不丢 |
| Z-12 | 卸载 | 卸载清单能回到干净状态，vault 数据按规则保留 |

> **Z-02 的卡点记录是本批最有价值的产物之一**：它直接回答部署手册是否真的够用。发现一处就按 §8 登记 `GAP`，不要现场口头补一句就过去。

## 6. 阶段 2：主干 1/2/3 设计符合性检验

> **判据来自 `FUTURE-DESIGN` §0.0 的符合性清单**；下表是把它拆成可在生产环境逐项跑的动作。每项都要有机器证据，口述不算。
> 证据根：`%ProgramData%\anc\stage\deploy-<日期>\conformance\`，按 ID 建子目录。

### 6.1 主干 1：四类群 + 三角色 + 隐私路由

| ID | 设计点 | 生产环境验证动作 | 预期 / 证据 |
|---|---|---|---|
| TR1-1 | 四类群、三角色 | 在员工群 / 部门群 / 公司大群 / 老板 1:1 各发一条 @，跑 `bind actor` | 四个 JSON 的 type/role 正确；`verify-org ok` |
| TR1-2 | 公司大群可答公司级 + 部门级 | 公司大群问公司级问题、部门级问题 | 直接答，不转私聊 |
| TR1-3 | 个人级转员工群、内部级只回 1:1 | 公司大群问个人级 / 内部级数据 | 个人级不在大群泄露；内部级只在 1:1；群截图 |
| TR1-4 | 同部门接受 / 跨部门审批 | A 请同部门 B；A 请跨部门 C | `pending_acceptance` → 接受 → `open`；`pending_approval` → 管理者批准 → 接受 → `open`；状态/审计 JSON |
| TR1-5 | 角色越权 | 员工查别人/别部门；管理者查别部门 | 拒绝回复 + DB 无越权记录 |
| TR1-6 | org 是真相 | 改一个成员后 `render deploy --db` | `sync-org` / `verify-org` 通过；`people/groups/manager_scopes` 与 org 一致 |
| TR1-7 | 老板 1:1 用真 1:1（D32） | 老板 1:1 发内部问题 | 可识别、可答；不建私有群；无主动推送（D32 已知限制） |
| TR1-8 | 未知人 fail closed | 未绑定群发一句 | 不猜人、不退回默认群 |

### 6.2 主干 2：两层结构、单一日对话、执行与恢复

| ID | 设计点 | 生产环境验证动作 | 预期 / 证据 |
|---|---|---|---|
| TR2-1 | Main 只建 Ticket、只对人说话 | 公司群派一个真实任务 | Task open + Ticket `queued`，Main 不执行；`task list` / DB |
| TR2-2 | 单一日对话（D46） | 连续派 3 个 Ticket，观察 host 与会话 | 1 个 daily host、3 个 subagent；wake 日志 `via=wb` 同一会话；窗口内无新建会话；`executor_hosts` 总量不按 Ticket 增长 |
| TR2-3 | `/new` 只用于 03:00 | 观察一个工作日 + 03:00 前后 | 日切前不新建；03:00 由 `new-host` / `host-tick` 触发；`host_cut` 事件 |
| TR2-4 | 一 Ticket 一 subagent | 查 Assignment 与产物 | `subagent_id` 不是 main/self；产物 + Report 落在 `departments/<dept>/tasks/<ticket>` |
| TR2-5 | 4+1 slot、P0 队首、同优先级 FIFO | 造 5+ 个不同优先级 Ticket | 不抢占、顺序正确；DB 快照 |
| TR2-6 | 失败自动重试至 `max_attempts` | 造一次 failed Report | 回 `queued` 重派（attempt+1），到上限才 `failed`；Task 不假 done |
| TR2-7 | 真实重启恢复 | 重启 WorkBuddy 后 `recover` | 旧 Assignment `interrupted`、Ticket 回 `queued`、新 host 重派完成 |
| TR2-8 | 03:00 日切语义 | 真实跨夜观察（不用 `-Now` 模拟） | 旧任务继续、新任务进新 host；`business_date` 正确 |
| TR2-9 | 确认后 Task done | review 短号通过 | Ticket/Task 单向终止（D38） |

### 6.3 主干 3：确认协议、通知、安全

| ID | 设计点 | 生产环境验证动作 | 预期 / 证据 |
|---|---|---|---|
| TR3-1 | 短号为主 | 真实群 `A12 可以` | approve → Ticket/Task done；`answer_message_id` 指向真实 `msg=` |
| TR3-2 | 引用文本增强 | 引用通知只回「可以」不带短号 | 补丁入站带 `quote=`；`attention match --quote-text` 命中；短号路径不回归 |
| TR3-3 | 只有 `required_confirmer`/老板能确认 | 非确认人、伪造短号、提示注入三类 | 均不能改动 Attention（D52 / GAP-107 修复后）；审计 `EXIT_2` |
| TR3-4 | 老板代确认 | 老板代管理者回执 | `on_behalf_of` 落库并通知本人 |
| TR3-5 | `question` → human slot | 造一个缺信息任务并回答 | 同一 Ticket 恢复不重开；human 不计 `max_attempts` |
| TR3-6 | 2h / 8h / 24h 升级 | 回拨 Attention 时间跑 `sweep --apply` | 2h 本人、8h 管理者、24h 老板；outbox `sent`，webhook `errcode 0`，不重复 |
| TR3-7 | 降噪 | 静默时段 / 每日上限 | 22–08 顺延；每日 10 条；首条 ask 不占上限 |
| TR3-8 | `require_ack` 默认关 + 三类开 | 分别造普通交接与三类交接 | 普通只记 `notified`；三类进待办并回执 |
| TR3-9 | 真 @ | 填 `mention_userid` 后发通知 | webhook `mentioned_list` 真 @；拿不到时回退不 @、不报错 |

### 6.4 证据与判定规范

- 每项至少一条：DB 查询 JSON / 日志原文件 / 群截图 / 产物路径。**口述、单测通过、本机历史 ACC 都不能替代生产环境证据**。
- 判定只有三种：`符合` / `偏离（已登记 GAP-###）` / `接受（用户裁决，写进 DECISIONS）`。
- 测试数据只进测试 Task / Ticket / 测试群；生产数据先备份；跑完清理测试行并留清理报告。
- 发现实现与设计不符 → 按 §8 处置，**不在现场改设计去迁就实现**。

### 6.5 补充检验维度（项目侧建议，范围由用户挑定）

以下是主干 1/2/3 设计点之外的横切风险，用户的原话是「还有一些我没有想到，你可以帮我想想」。**不默认全做**：标 `本批` 的建议纳入，标 `后置` 的建议另开观察期；用户可以删减，删掉的项目在 §13 留一行「用户决定不纳入本批」。

**A. 长期运行（7×24 主机的真实风险，此前都是短时演练）**

| ID | 检验点 | 为什么要验 | 建议 |
|---|---|---|---|
| S-A1 | 连续运行 ≥48h 不重启 | 计划任务是否漏跑、wake 是否重复唤醒、DB/日志增长、句柄泄漏 | 本批 |
| S-A2 | 连续 ≥2 次真实 03:00 日切 | host 不重复创建、旧任务不丢、`business_date` 连续 | 本批 |
| S-A3 | 22–08 静默与工作时段跨日 | 半夜把人叫醒是最容易挨骂的事故 | 本批 |
| S-A4 | 主机重启 / 断电后恢复 | D5「不开自动登录」的代价：开机提醒是否真能把人叫回来 | 本批 |
| S-A5 | 备份轮换跑满周期（日档 60 / 月档 12） | 不炸盘、旧档真能恢复 | 后置 |
| S-A6 | 7 天连续运行 + 一次任务耗时 / token 成本基线 | D37 金额预算未设，正式用起来才知道贵不贵 | 后置 |

**B. 真实业务负载（此前产物都是 `hello*.md` 之类测试件）**

| ID | 检验点 | 为什么要验 | 建议 |
|---|---|---|---|
| S-B1 | 至少一个**真任务**全链路 | 产物质量、目录规范、确认话术在真实内容下是否可用 | 本批 |
| S-B2 | 并发多任务跨部门 / 跨优先级 | 4+1 slot 在真实负载下不串写 | 本批 |
| S-B3 | 大文件 / PDF 入库 + 覆盖写 base hash + 原件不进 git | ING 16/16 只在本机验过 | 本批 |
| S-B4 | 中文 / 长文本 / 特殊字符 / 表情 | GAP-084 只验过一例，正式群消息更复杂 | 本批 |
| S-B5 | webhook 失败 / 限流 / 重复消息 | outbox 退避重试、dedupe、幂等 | 本批 |
| S-B6 | AI Bot 与群机器人两个发送者 | 用户能否分清、通知与回复不打架（D41 已知代价） | 本批 |
| S-B7 | 高频消息 / 刷屏 / 大量 Attention 压测 | 上限与降噪在压力下是否仍有效 | 后置 |

**C. 安全与隐私（第一次有真实公司数据）**

| ID | 检验点 | 为什么要验 | 建议 |
|---|---|---|---|
| S-C1 | 文档 / PDF / 文件名里夹带指令 | ACC-21 只验了群消息确认注入，**入库文档注入未验** | 本批 |
| S-C2 | 出站凭据扫描 | webhook / token / 真实姓名不出现在群消息、日志、git | 本批 |
| S-C3 | 在**生产机**跑 `check-public` | 此前只在仓库扫 | 本批 |
| S-C4 | secrets ACL 在真实部署账号下 | 本机管理员账号可能掩盖权限问题 | 本批 |
| S-C5 | `anc-elevate` SYSTEM 提权通道 | 白名单 / TTL / GUID / 每小时 6 条 / 审计（GAP-102 只在临时根验过） | 本批 |
| S-C6 | 伪造 sender id / 冒用老板 | GAP-072 的会话级 id 是真实攻击面 | 本批 |
| S-C7 | 入职 → 离职 → 成员变更全流程 | 档案不动、open 任务转交、groups 停用 | 本批 |
| S-C8 | 内部区数据不出现在员工侧 | D12 / D19 在生产 ACL 下复核 | 本批 |

**D. 可运维 / 可移交**

| ID | 检验点 | 为什么要验 | 建议 |
|---|---|---|---|
| S-D1 | 陌生人接手（与 Z-02 合并取证） | 只给仓库链接 + 文档，能否看懂现状、找到日志、处理常见故障 | 本批 |
| S-D2 | 故障注入：doctor 每项故意弄坏一处 | 是否都能 FAIL（RELEASE-CHECKLIST 四阶段之一） | 本批 |
| S-D3 | 备份恢复到**另一台**机器 | REBUILD 路径真实可用 | 本批 |
| S-D4 | 升级后配置与数据保留 | `upgrade` 数据零覆盖只在临时根验过 | 本批 |
| S-D5 | 出问题时能否从日志 / DB / audit 快速定位 | GAP-025 审计面板未做，记录实际排查耗时就知道要不要补 | 本批 |
| S-D6 | 审计面板 / 最小可观测字段 | 设计叶子 GAP-025，正式用起来暴露痛点再定 | 后置 |

**E. 设计元约束与验收口径**

| ID | 检验点 | 为什么要验 | 建议 |
|---|---|---|---|
| S-E1 | 「只有 Main 对人说话」 | 生产里是否有 subagent / devbot / 群机器人越权对人说话 | 本批 |
| S-E2 | 「确定性的事不交给模型」 | 抽查状态 / 计时 / 完成判定 / 出站是否真在本地服务 | 本批 |
| S-E3 | 「SQLite 是真相、markdown 是投影」 | 手改 vault 后是否被正确覆盖回去 | 本批 |
| S-E4 | D35/D36 的口述 / 人工对账例外逐条换机器证据 | 历史验收口径偏软，正式部署要补硬证据 | 本批 |
| S-E5 | 已定但未实现的设计项清点 | 自动评估器（D29）、强 ACL（D28）、通知合并/日报（D41）、金额预算（D37）逐项标「有意不做 / 漏做」 | 本批 |
| S-E6 | 主干 4 缺口书面确认 | 员工 bot 哪些能力明确不做，写进 STATUS / PRODUCT，避免部署后被当成 bug | 本批 |

> 标「本批」的约 30 项多数可**共用取证**：S-A1/A2/A3 在同一个连续运行窗口里看，S-B1/B2/B4/B6 在同一轮真实任务里跑，S-C1/C2/C6 在同一轮安全回归里跑，S-D1 与 Z-02 合并。不是 30 个独立大工程。标「后置」的 4 项需要长周期或额外机器，不阻塞本批准出。

## 7. 阶段 3：员工侧部署（闸门通过后）

| ID | 步骤 | 预期 / 证据 |
|---|---|---|
| **E-01** | 按 [BOOTSTRAP.md](../BOOTSTRAP.md) 四步 + [DEPLOY-EMPLOYEE.md](./DEPLOY-EMPLOYEE.md) 装员工侧 | 员工电脑 WorkBuddy 普通权限；员工侧 `deploy-state` 10 阶段；首次绑定成功 |
| **E-02** | EMP-01 员工群边界 | 只服务本人；不查公司库（旧员工侧实现 按现状验）；不越权 |
| **E-03** | EMP-02 handoff | 旧员工侧实现 没有 handoff → 明确登记为**主干 4 缺口**，不算通过 |
| **E-04** | 两机真实群/任务（ACC-17） | 真实员工群 / 部门群 / 公司群；任务产物只在对应目录；**机器证据**替代 D48 书面例外 |
| **E-05** | 员工侧自证 | doctor、群回应、任务落库、补丁/前缀按员工侧口径（员工侧不装补丁不试 17999） |

> 员工侧发现的问题单独登记，不回退公司侧准出结论；若需改公司侧配置，重新走一次 §4.1 的相关项。

## 8. 问题登记与处置流程

```text
发现问题 → 现场留证据 → STATUS §3 建 GAP-###（类型/严重度/来源/阻塞/下一步）
  → 分类：实现偏离设计 → §3.3 设计反哺 + 0.7
          部署 / 运维问题 → 0.4
          真实验收缺口 → §3.5 ACC 行
          安全 / 合规 → 0.5
  → 处置：S0/S1 立即修；S2/S3 排期或进主干 0；接受不修须用户裁决并写 DECISIONS
  → 回写：受影响文档（PRODUCT / ARCHITECTURE / 模块契约 / 接口 / 运维）
          + STATUS §3.4 复检行 + §4 审计行 + 测试数
```

**问题登记表**（放在证据根 `issues.md`，每发现一条就追加一行）：

| ID | 发现阶段 | 现象 | 证据路径 | GAP | 分类 | 处置 | 状态 |
|---|---|---|---|---|---|---|---|

规则：

- **S0/S1 未关闭，公司侧不准出**；带例外推进必须用户书面确认并写 `DECISIONS`。
- 修 bug 必须有回归测试；新代码必须带测试。
- 每个 GAP 都要有「修掉 / 接受 / 移出主干 4」的结论，不允许悬空。
- 部署过程中若发现「设计本身定错了」，由用户裁决：改设计则同步 `FUTURE-DESIGN` + `DECISIONS` + 受影响的现状文档，不允许静默改。

## 9. 任务分解

| 任务 | 内容 | 完成条件 |
|---|---|---|
| **T6.1** | 开批留痕 | 本 PLAN + `FUTURE-DESIGN` 主干 0 + `STATUS` §3.4 复检行已落盘；旧 PLAN 已快照 |
| **T6.2** | **零起点装机检验** | Z-01..Z-12 有独立证据（干净机 / 备用机，不碰生产）；Z-02 卡点记录完整 |
| **T6.3** | 公司侧环境准备 | C-01..04 全过，证据齐 |
| **T6.4** | 公司侧安装与自证 | C-05..07 全过；14 任务 / doctor 35 项 / deploy-verify / executor-deploy |
| **T6.5** | 安全、演练、真实群接线 | C-08..10 全过；备份/恢复/升级/回滚数据零丢失 |
| **T6.6** | 主干 1 符合性 | TR1-1..8 逐项判定 + 证据 |
| **T6.7** | 主干 2 符合性 | TR2-1..9 逐项判定 + 证据（含真实 03:00 跨夜） |
| **T6.8** | 主干 3 符合性 | TR3-1..9 逐项判定 + 证据 |
| **T6.9** | 补充检验维度 | §6.5 中**用户挑定**的「本批」项逐项有结论；未纳入项在 §13 留痕 |
| **T6.10** | 公司侧准出评审 | §4.1 七条逐项结论；闸门通过或有用户书面例外 |
| **T6.11** | 员工侧部署 | E-01..05；ACC-17 机器证据 |
| **T6.12** | 收口 | 新增 GAP 全部处置；文档全量同步；门禁全绿；PLAN 快照 |

**任务状态（2026-11-10）**：T6.1 ✅（本文件）；T6.2–T6.12 待开工；T6.9 的范围待用户挑定。

## 10. 测试与门禁

```text
npm test                  # 当前 253/253；新增回归继续加
npm run check             # check:modules:deep + check:docs
npm run coverage
node scripts/checks/check-public.mjs   # 零输出且退出码 0
doctor.ps1 -Json          # 公司侧 35 项 FAIL=0；非提权 FAIL=0 WARN=13
deploy-verify.ps1 -Side company -Json
deploy-state.ps1 -Side company -Status -Json
backup-anc.ps1 -MinIntervalHours 0    # 迁移/部署后强制备份
```

- 生产环境每项要有证据；本地 `npm test` 通过只证明代码，不证明部署与真实群。
- 新增代码必须有测试；修 bug 必须有回归。
- 失败项进 `STATUS` GAP，不静默跳过。
- 测试数据清理；生产 vault 不被测试写。

## 11. 文档联动

按 [DOC-SYNC.md](./DOC-SYNC.md) §3 清单全量核对：

- `STATUS`：§1 证据、§3.2/§3.3 新 GAP、§3.4 复检行、§3.5 ACC-17 与新增 ACC、§4 审计行、§5 风险。
- `FUTURE-DESIGN`：本批完成时把主干 0 汇总与 0.4/0.7/0.8 分支标回 ✅（或按新缺口保持 🟡）。
- `DECISIONS`：部署中的新裁决（尤其「接受不修」与「改设计」）。
- `PRODUCT` / `ARCHITECTURE` / `modules/*`：若生产行为与契约不符，先修实现或登记 0.7，再改文档。
- `LOCAL-SERVICE` / `MAIN-EXECUTOR` / `WORKBUDDY-PATCH` / `RENDERER`：命令、前缀、状态机若有变化。
- `DEPLOY-COMPANY` / `DEPLOY-EMPLOYEE` / `OPS` / `REBUILD` / `BOOTSTRAP` / `RELEASE-CHECKLIST`：部署步骤、门禁、ACC 判定；**零起点 Z 系列的卡点要回写手册**。
- `INDEX` / `README` / `AGENTS`：现状数字与「现在到哪了」。
- 完成后归档 `archive/plans/BATCH-DEPLOY-<日期>.md`，并在 `archive/plans/README.md` 登记。

## 12. 风险与不做

- **不在本批实现主干 4**：员工 bot handoff / 本地执行 / 双 bot 路由继续记缺口；员工侧按旧员工侧能力验。
- **公司侧没准出就不开员工侧**：这是用户定的顺序，不因为进度压力跳过。
- **零起点演练不碰生产**：生产机不是干净机时用备用机 / 虚拟机；绝不为了拿证据重装生产机。
- **§6.5 补充维度范围由用户挑定**：项目侧只给建议，不默认把 30 项全塞进本批，也不因为「后置」就悄悄漏掉——删减要在 §13 留痕。
- **不改设计迁就实现**：发现偏离先登记 GAP；要改设计必须用户裁决并写 `DECISIONS`。
- **D35/D36 的历史验收口径偏软**（口述 / 人工对账书面例外）：正式部署很可能暴露未覆盖的问题，按 GAP 登记而不是掩盖；ACC-17 要补机器证据。
- **生产数据**：先备份；测试只进测试 Task/Ticket/测试群；跑完清理并留报告。
- **WorkBuddy 内部 `window.wb` API 无公开契约（D46）**：正式机若版本不同，wake bridge 2.0 可能失效；bridge 有 DOM fallback，升级后按 `WORKBUDDY-PATCH` 回归。
- **真实 03:00 跨夜**：TR2-8 / S-A2 要等真实跨夜，不能用 `new-host -Now` 模拟顶替（D51 只允许用于补测）。
- **首次正式部署链路**：`install-company` → `patch` 重启 → `patch-guard` 自动收尾此前只在本机验过，干净机第一次跑要重点看 Z-08 / C-06。

## 13. 执行记录

| 日期 | 事项 | 变更 | 证据 | 备注 |
|---|---|---|---|---|
| 2026-11-10 18:1x | 开启正式生产部署批次 | 按用户决定更新 `FUTURE-DESIGN` 主干 0（当前批次 / 准出闸门 / 主干 1/2/3 符合性清单 / 规则 15）；PLAN 切本批；旧 PLAN 归档 `BATCH-20261110-FINAL.md` | 本文件、`FUTURE-DESIGN` §0 | T6.1 完成；待 C-01 开工 |
| 2026-11-10 18:2x | 追加零起点与补充检验维度 | 用户追加「一台主机从 0 开始部署的过程」并请项目侧补充未想到的检验项；`FUTURE-DESIGN` §0.0 加目标 1/5 与准出第 7 条；PLAN 加 §5.1（Z-01..12）与 §6.5（S-A/B/C/D/E 五类，本批 / 后置分层）；任务分解重排 T6.1–T6.12 | 本文件、`FUTURE-DESIGN` §0.0 | **T6.9 范围待用户挑定**；闸门由 6 条变 7 条 |
