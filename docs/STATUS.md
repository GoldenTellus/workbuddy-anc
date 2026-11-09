# 状态与缺口

> 类型：账本（已完成 / 进行中 / 缺口 / 风险）
> 最后更新：2026-11-09
>
> 规则：这里只记**事实和证据**。计划和排期在 [PLAN.md](./PLAN.md)；设计意图在 [FUTURE-DESIGN.md](./FUTURE-DESIGN.md)。
> 每个缺口都有 `GAP-###`，主干完成时必须逐条处理：修掉、进主干 0、或明确接受不修。

---

## 1. 已完成

### 1.1 代码基线（2026-11-06）

- [x] 13 个模块全部 `current`；`src/service` / `src/render` / `src/ingest` 只剩入口薄壳。
- [x] `core` 拆出 `schema` / `migrate` / `tx` / `fs`；两份 `writeAtomic` 下沉。
- [x] 深导入 0、模块违规 0、环 0。
- [x] 2026-11-06 基线 `npm test` 163/163；当前 212/212；`check:modules:deep` 通过；`check-public` 零输出。
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
- [x] `npm test` **212/212**；`npm run check` 通过。
- [ ] 企微 API 群成员校验、`boss_dm` spike（GAP-042）；T1.9 文档已关闭。

### 1.4 主干 1/2 本机收口（2026-11-09）

- [x] 主干 1 本地：T1.3 群类型/org→DB resolver、T1.7 `boss_dm` 类型/`resolvePrivateChat`、T1.11 render/deploy groups 均有测试。
- [x] 主干 2 本地：executor 四表 + evaluations/events、host bootstrap/cut/deferred、claim/start/report/end/recover/sweep/expire、4+1 slot、队列顺序、human slot、迟到 Report、scope、Main 评估记录。
- [x] 真实 WorkBuddy：单条 subagent、4 并发、wake bridge、`/new` 新建 host；跨进程 recover drill。
- [x] `npm test` **212/212**；`check` 通过；13 个计划任务、17 组 CLI、8 个技能、13 个模块。
- [ ] 真实群/1:1/成员 API、部署、03:00、窗口重启、两机群 → ACC-01..12。

### 1.5 公司侧部署与自证（2026-11-09，本机）

- [x] `deploy.ps1 -Apply` 成功：**138 个文件**逐一 hash 对拍通过（含 `bind-member-identity.ps1`；日志 `%ProgramData%\anc\stage\elevated-*.log`、后一次部署 `deploy-20261109-170700`）。
- [x] `deploy-skills.ps1 -Apply`：8 个技能 / 10 个文件落盘（`%USERPROFILE%\.workbuddy\skills`）。
- [x] `register-tasks.ps1 -Apply`：**13 个计划任务**全部 Ready（LOCAL SERVICE×9 / SYSTEM×1 / DNT 交互×3）。
- [x] WorkBuddy 补丁：`patch-state.json` → `applied=true mode=hash pid=24140 version=5.9.3`，进程活着（由 `anc-patch-guard` 自愈拉起）。
- [x] vault 两区：`D:\anc\vault-shared` / `vault-internal` 各自 git 仓库就绪；共享区 NTFS 只读、SMB 共享 `anc-vault-shared`（Authenticated Users 只读）；内部区仅 SYSTEM/Administrators/运行用户。
- [x] org / persona：`name=新未来`、`company_bot_name=公司bot`，`groups.json members=0`（无员工版）；公司 bot persona 已装到 `%USERPROFILE%\WorkBuddy\Claw\CODEBUDDY.md`。
- [x] wecom secrets：`wecom-webhook.txt` / `webhook.txt` / `ops-webhook.txt` + `service-token.txt`，`secrets-acl` PASS、不进 git。
- [x] `backup-anc.ps1` 跑通：本地 `backup\anc-20261109-153622.db`；离机 `D:\anc-backup` 与本地同物理盘（WARN，需独立盘/UNC）。
- [x] `deploy.ps1 -Rollback` 已实现并在临时根演练：首次部署回滚删除 137 个文件；升级回滚恢复备份文件（`%ProgramData%\anc\stage\rollback-drill.log`）。
- [x] `doctor`（34 项）FAIL=0 WARN=3（work-hours / patch 日志落点 / bindings；canary 在 15:38 收到首条真实消息后转 PASS）；`deploy-verify` `ok:true pass=4 fail=0 skip=1`（bot-reply：无已绑定群，SKIP）。
- [x] 真实消息路径：15:38:34 补丁处理了一条真实企微消息（`patch-canary.json` chatId/user/contentStr 三项 true，`patch-in.log` 记录前缀注入），随后 doctor 的 canary 转 PASS —— 群身份注入在真实入站路径生效；因为没有群绑定，`bot-reply` 仍 SKIP。
- [x] 代码修复后重新 `deploy.ps1 -Apply`：137 文件 hash 全过（备份 `backup\deploy-20261109-155502`），线上脚本与仓库一致；后续加自动绑定脚本后为 **138 文件**（备份 `deploy-20261109-170700`）。
- [x] 提交 `0ed1938`（29 文件）；**干净树最终门禁**：`npm test` **212/212 ×3**（39.5/39.1/38.8s）、`npm run check`、coverage **90.85/80.43/94.99**、`check-public` 零输出、`doctor -SelfTest` ALL PASS、`doctor` 34 项 FAIL=0 WARN=3、`deploy-verify` `ok:true pass=4 fail=0 skip=1`、`deploy-state` 11/11。
- [ ] 真实两机群 / 员工数据 / 03:00 日切 / 窗口重启恢复 / 生产回滚窗口 → 仍归 ACC（本机无真实群、无员工名单、无第二台电脑）。

### 1.6 org 与真实群接线（2026-11-09，本机）

- [x] org 真相写入 `D:\anc\org`：company（boss + 公司大群 + boss_dm 1:1）、1 个部门（技术部，管理者 1 人）、3 个成员（老板 1 / 管理者 1 / 员工 1）、3 个角色（owner / manager / employee）。真实姓名、userid、chatid 只在本机 org，不进仓库。
- [x] `render deploy --db`：4 个产物对拍通过，`sync-org` 同步 people/groups/manager_scopes 并校验通过；`bind verify-org` → `ok:true checked=5`。
- [x] `bind actor` 验证（公司大群）：老板 → boss；技术部管理者 → manager（scopes=tech）；员工 → employee；`boss_dm` 1:1 → 老板。身份映射链路通。
- [x] 校正项：公司群 chatid 与老板的 `userid` 以**真实入站消息**为准 —— 企微 AI Bot 上报的发送者是 `wok…` 形式的**会话级 id**，不是通讯录账号；org 的 `member.userid` 写实际上报值后 `bind actor` 才匹配到人（GAP-072；真实 id/姓名只在本机 org）。
- [x] 公司 persona 重新渲染并部署到 `%USERPROFILE%\WorkBuddy\Claw\CODEBUDDY.md`（含公司名/四类群规则/隐私路由）；WorkBuddy 已干净重启并重新打补丁（`applied=true`，新 pid；runId 变化）。
- [x] `boss_dm` 用老板与公司 bot 的 1:1：已识别通过（老板/boss，2026-11-09 16:33 实测）；**不建老板私有群**（用户决定，D32）；1:1 无群机器人，主动推送不做承诺。
- [x] **ACC-07 生产回滚窗口已演练**：`deploy.ps1 -Rollback` 恢复 137 文件（回滚源 `backup\deploy-20261109-155502`）→ 再 `-Apply` 137 文件 hash 全过（新备份 `deploy-20261109-164051`）；演练后 `deploy-verify ok:true 4/0/1`、`doctor 34 项 FAIL=0 WARN=3`。证据 `.workbuddy/verify/final/acc07-rollback-*.log`。
- [x] **备份恢复演练通过（0.4）**：强制新建备份 `anc-20261109-171512.db` → 停 DB 任务 → VACUUM 安全副本 `stage\anc-safety-171512.db` → 用备份替换 `anc.db` → 重启任务；验证：`doctor 34 项 FAIL=0 WARN=3`、`deploy-verify ok:true 4/0/1`、org 重渲染 `verify-org ok`。证据 `.workbuddy/verify/final/restore-drill-clean-171512.log`。
- [x] **wake bridge 已修复（GAP-075 closed）**：`inject.cjs` 在主进程暂停点直接 `require(preload.cjs)` → `wake-bridge.cjs` 在 Electron 主进程启动；实测 `18187` 监听、`wb-wake.log` 有 listening、token 已生成（修法：启动注入同时覆盖主进程与子进程）。
- [x] **ACC-09 达成（本机）**：13 任务 Ready + 补丁 `applied=true` + wake bridge `127.0.0.1:18187` 监听。
- [x] **ACC-10 机制验证**：`bin\new-host.ps1` 经 bridge `/new` 成功新建 host 对话（`executor_hosts` active，`conv-20261109-172231`），bot 在新对话执行 `executor host bootstrap`；03:00 自动触发待夜间首次观察（任务已注册、flag+workspace 已配）。
- [x] **ACC-11 真实窗口重启演练**：重启 WorkBuddy（新 runId）→ 旧 host 仍 active、Assignment running（重启前状态）→ `executor recover` → host closed、Ticket 回 queued；新 host `bootstrap` 后 claim→start→report→end，Ticket `waiting_review`；证据 `%ProgramData%\anc\stage\acc11-*.log`。
- [x] **ACC-10 达成（本机，定时任务实测）**：把 `anc-executor-new-host` trigger 临时改到 now+2 分钟后运行 → 任务自动建新 host 对话（workspace `workbuddy-anc`，`conv-20261109-173355`）+ bot `host bootstrap`（约 13s 后 host active）；新 ticket 在新 host claim→start→report→end；trigger 已恢复 Daily 03:00（next 2026-11-10 03:00）；证据 `stage/acc10-scheduled.log`、`stage/acc10-result.log`。
- [x] 员工 @ 已打通：用户调整企微智能机器人「可使用范围」后，16:55 收到吴琼在群里的真实消息（`patch-in.log` 有入站）；按实际 sender id 更新 `member.userid`（`wok…` 会话级 id），`bind actor` → 吴琼 / employee，`verify-org` ok。**GAP-073 关闭**（新成员仍需在企微后台分配/领用，见 DEPLOY-COMPANY §11.1）。
- [x] **首次身份绑定已自动化（GAP-074）**：新增 `bin\bind-member-identity.ps1`（按姓名/ID 把 sender id 写进 org → 重渲染 → sync），persona 与 `anc-task` 技能已加「首次绑定」流程：未识别成员第一次 @ 时，bot 请对方回复一次姓名（若消息自带姓名则直接绑），随后自动写 org，下一条消息即识别。已部署（138 文件）、临时 org 验证匹配/未匹配两种返回；`deploy-persona` + `deploy-skills` 已更新（新会话生效）。
- [x] 张佳艺已绑定：17:09 收到她「我是张佳艺」入站，已按实际 sender id 写入 org（manager / tech / scopes=tech），`bind actor` 通过；同时清理了 groups 表里一条旧公司群 chatid 残留。自动绑定流程（GAP-074）尚待在**新会话**（`/new` 后）首次触发验证——本次消息发生在旧会话，脚本未自动执行，属人工补绑。
- [ ] 员工群（每人一个：本人 + 公司 bot + 员工 bot）与部门群 chatId 未建 → 员工侧 @ 链路待建群。
- [ ] 真实群消息回归：需老板/员工在群里 `@公司 bot` 验证新 persona（新会话生效；旧会话需 `/new`）。

### 1.7 员工侧验收（用户实测，2026-11-09）

> 用户口述：员工侧测试全部通过。**没有机器日志/截图入账**（本机未留存员工机与员工群日志）；本记录只是按用户验收结论记账，不冒充本地测试证据。正式部署前建议补一次机器留痕。

- [x] 员工侧安装 / 技能 / persona / 卸载回滚 —— 用户实测通过（口述）。
- [x] ACC-02 员工群任务 + 个人数据；ACC-03 同部门请求；ACC-04 跨部门审批；ACC-05 公司/部门群隐私；ACC-06 老板 1:1；ACC-12 两机真实群/任务 —— 用户实测通过（口述，无机器日志）。
- [ ] 四类群 chatId/webhook 未登记到本机 org（ACC-01 本机侧只验了公司群 + boss_dm）；ACC-08 只有人工对账（公司群，见 §3.5），员工/部门群未覆盖。
- [x] **ACC-08 按用户选择 B 记书面例外（D36）**：人工对账公司群差异 0；员工群/部门群未覆盖；无企微成员 API 凭据。不再要求自建应用。

---

## 2. 进行中

| 事项 | 状态 | 证据 / 下一步 |
|---|---|---|
| 主干 0 | **已收口（2026-11-09）** | 0.1–0.7 按证据处置；ACC-07/09/10/11 本机达成，ACC-01/02/03/04/05/06/12 用户实测通过（D35），ACC-08 人工对账书面例外（D36）；见 [PLAN.md](./PLAN.md) 与快照 |
| 主干 1/2 本机 | 已收口 | 见 §1.4；待两机 ACC |
| 公司侧部署（本机） | 已完成 11/11 | 见 §1.5；`deploy-state` `ok:true progress 11/11` |
| 文档联动检查 | 已建并审计 | [DOC-SYNC.md](./DOC-SYNC.md)；2026-11-09 收口审计行 |

---

## 3. 缺口

### 3.1 设计叶子（来自 FUTURE-DESIGN §6）

| ID | 缺口 | 类型 | 严重度 | 来源 | 阻塞 | 下一步 |
|---|---|---|---|---|---|---|
| GAP-001 | 公司大群/部门级隐私分级与路由 | 验收 | S1 | 主干 1 | 否 | 隐私 router 已有；接实际员工群/1:1 渠道并入 ACC-05 |
| GAP-002 | 员工请求同事的两阶段审批/接受 | 验收 | S1 | 主干 1 | 否 | 状态机/CLI/通知链已完成；真实群接线并入 ACC-03/04 |
| GAP-003 | 公司大群/部门群成员与 org 同步 | 实现 | S2 | 主干 1 | 否 | org→DB 同步/测试已做；企微 API 成员对账并入 ACC-08 |
| GAP-004 | 老板 1:1 真通道 / 私有群 fallback | 验收 | S1 | 主干 1 | 否 | 类型/表/resolvePrivateChat 已测；真 1:1 spike 并入 ACC-06 |
| GAP-005 | 员工群两个 bot 的触发分工 | 实现 | S1 | 主干 4 | 是 | 员工 bot 只服务员工；补丁/移除查库（GAP-037–039） |
| GAP-006 | WorkBuddy 日对话 + 任务 subagent 适配 | 实现 | S0 | 主干 2 | 是 | 先验证 subagent 并发/工具边界/日切 |
| GAP-007 | 部门/任务目录路径、命名、清理、权限 | 实现 | S1 | 主干 2 | 是 | 定 departments/<dept>/tasks/<ticket> |
| GAP-008 | `background` 任务接单规则 | 设计 | S1 | 主干 2 | 否 | D29：Main 评估后接；evaluations 记录已落，自动评估器未做 |
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
| GAP-057 | 外部副作用幂等键与 at-most-once 保证 | 实现 | S1 | 主干 2 | 否 | 当前外部副作用仅结果通知，outbox dedupe 已落；其他副作用未接 |
| GAP-058 | 产物/证据保留、清理、权限 | 后续 | S2 | 主干 2 | 否 | 定保留策略 |
| GAP-059 | 主机重启后 Assignment/Ticket 恢复语义 | 实现 | S1 | 主干 2 | 是 | 跨进程 drill + sweep 通过；WorkBuddy 窗口重启待做 |
| GAP-060 | subagent 并发能力、路径隔离、日切交接未验证 | 实现 | S1 | 主干 2 | 否 | D28 接受逻辑隔离；强 ACL 改为部署选项 |
| GAP-061 | 03:00 日切时旧 host 运行中 subagent 是否继续、新 host 如何接管 | 实现 | S1 | 主干 2 | 否 | 用户实测通过：旧任务继续，新任务进新 host；关闭 |
| GAP-062 | Main ↔ 本地服务的 claim/report 边界未定 | 设计 | S1 | 主干 2 | 否 | 契约已写：MAIN-EXECUTOR.md；实现待做 |
| GAP-063 | Main 无消息时如何唤醒并 claim 队列未定 | 设计 | S1 | 主干 2 | 否 | 真实窗口注入通过；opt-in wake bridge，默认关闭 |
| GAP-064 | subagent Report JSON 契约与解析失败策略未定 | 设计 | S1 | 主干 2 | 否 | 契约已写；解析实现待做 |
| GAP-065 | 03:00 自动创建新 host 对话未定 | 实现 | S1 | 主干 2 | 否 | `/new` + new-host 任务已落；部署 -Apply 后生效 |

### 3.2 实现缺口（现状 vs 目标）

| ID | 缺口 | 类型 | 严重度 | 来源 | 阻塞 | 下一步 |
|---|---|---|---|---|---|---|
| GAP-026 | 没有 Ticket / Assignment / Report / Attention / Notification 表 | 实现 | S0 | 主干 2 | 是 | 四表 + 仓储 + CLI 已落；Attention/Notification 未落 |
| GAP-027 | 没有 Main / Executor 运行时 | 实现 | S0 | 主干 2 | 是 | D2 执行器 |
| GAP-028 | 没有 company/department/boss_dm 群模型 | 验收 | S1 | 主干 1 | 否 | 本地群模型/CLI/render/测试已完成；真实群配置并入 ACC-01 |
| GAP-029 | 没有群回复确认解析 / Attention 存储 | 实现 | S1 | 主干 3 | 是 | D3 群与确认 |
| GAP-030 | 没有 boss/manager/employee 角色模型 | 验收 | S1 | 主干 1 | 否 | people/policy/sync/persona 已完成；真实群接线并入 ACC |
| GAP-031 | 没有日对话调度 / subagent 管理 | 实现 | S1 | 主干 2 | 是 | 真实 subagent 单条已通；唤醒/自动 host 未接 |
| GAP-032 | `npm test` 并发偶发 100s 级挂起 | Bug/回归 | S1 | 主干 0 | 否 | 已改 `--test-concurrency=1`；连续 3 次通过（当时 191/191），关闭 |
| GAP-040 | org 角色源未同步到 people/manager_scopes | 实现 | S1 | 主干 1 | 否 | 已解析并同步；文档/边界已收口；关闭 |
| GAP-041 | 公司 bot persona / skills 未接新角色、群类型、任务请求 | 验收 | S1 | 主干 1 | 否 | persona/anc-task/通知链已完成；真实消息回归并入 ACC |
| GAP-042 | 四类群真实成员/部署验收未做 | 验收 | S1 | 主干 1 | 否 | render/import/sync/send/deploy 自动 sync 已做；企微成员 API 对账待 ACC-08 |
| GAP-050 | 四类群真实端到端验收批次 | 验收 | S1 | 主干 1 | 否 | 按 §3.5 ACC-01..12 统一收尾；不阻塞代码推进（2026-11-09：ACC-07/09 部分达成，其余未跑） |
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
| GAP-039 | 员工 bot 文档/职责 | 现有 `member-bot` 职责含“查公司知识库” | 本机资料 + handoff；不查公司库 | 主干 4 | 是 | 改模板与部署文档，加回归；0.7 的文档警告已补 |

### 3.3a 主干 0 收口处置（2026-11-09）

> 本轮按 `PLAN.md` 主干 0 收口，逐条处置 §3.1–§3.3 的 GAP。`closed` = 已修/已接受并有证据；`acc` = 只能等 0.8 真实验收；`trunk-N` = 明确移出主干 0、归后续主干；`open` = 仍开放但不阻塞主干 0。

| GAP | 判定 | 证据 / 说明 |
|---|---|---|
| 001 / 002 / 004 | **closed（用户实测通过，口述；无机器日志）** | ACC-05 / ACC-03/04 / ACC-06；用户 2026-11-09 确认员工侧全部测试通过 |
| 003 | accepted（人工对账例外，D36） | ACC-08：公司群人工对账差异 0；员工/部门群未覆盖；无 member API；用户选择 B |
| 005 | trunk-4 | 员工 bot 仍按旧实现；PLAN §3 明示不在主干 0 做 |
| 006 / 031 / 042 / 050 / 065 | **closed（本机达成 + 用户验收 + 书面例外）** | 006/031/065 随 ACC-09/10 达成；042/050 由用户实测（D35）+ ACC-08 例外（D36）收口 |
| 059 | **closed（ACC-11 重启演练通过）** | 真实窗口重启 → recover → host closed / Assignment interrupted / Ticket queued → 新 host 重派；证据 `stage/acc11-*.log` |
| 041 | **closed（用户实测通过，口述；无机器日志）** | persona / 真实群消息回归由用户验收 |
| 007 | **closed** | `executor.ts` 的 task_dir 由部门 + ticket_id 推导；测试覆盖；`MAIN-EXECUTOR.md` |
| 008 | **closed（接受）** | D29：Main 评估后接；`executor_evaluations` + `evaluate` CLI 已落；自动评估器不做 |
| 009 | 收窄 | 4 normal + 1 human slot 已落；模型/预算默认值留主干 2 |
| 010 | **closed** | human slot 只接等待人工的 Ticket（测试） |
| 011 / 021 / 022 | accepted | 主动任务规则 / 注入评审 / 多公司多主机：接受现状，不阻塞 |
| 012 / 013 / 014 / 015 | trunk-3 | `require_ack`、通知细分、多 Attention、频率合并 |
| 016 / 017 / 018 / 020 | trunk-4 | 员工 bot 本地执行、handoff、双 bot 路由、知识边界 |
| 019 | acc + trunk-4 | resolver/sync/backfill 已测；大群/1:1 成员同步留 ACC-08 || 023 | **closed** | 工作时段/时区走 config；`service.test.ts` |
| 024 | 并入 058 | 保留期统一由 GAP-058 定 |
| 025 | 收窄（接受） | `executor_events` 审计已落；面板/最小字段留后续 |
| 026 | **主干 0 部分 closed** | 四表 + 仓储 + CLI 已落；Attention/Notification 归主干 3 |
| 027 | **closed** | executor 655 行 / 16 测试 / 17 CLI 子命令 / `anc-executor` 技能 |
| 028 / 030 | **closed（用户实测通过，口述；无机器日志）** | ACC-01 / 真实群接线由用户验收；本机 org 仅登记公司群 + boss_dm |
| 029 / 036 | trunk-3 | 群确认解析 / Attention 层 |
| 032 / 033 / 040 / 051 / 052 / 061 | **closed（保持）** | 原证据仍成立；032 本轮补 3 次 212/212 证据 |
| 034 | open（归主干 2 后续） | Ticket↔Task 映射已在 `MAIN-EXECUTOR` 说明；实现不假关 |
| 035 | **closed** | runtime 不再引用 executor/Ticket；模块分层成立 |
| 037 / 038 / 039 | trunk-4 | 员工侧补丁/handoff 归主干 4；文档警告已补（0.7 部分完成） |
| 053 | **主干 0 关「基数/状态机」** | 状态机/唯一索引/claim-start-report-end 已落；重试/拆分归 GAP-070 |
| 054 | **closed（定值）** | DDL 兜底 + Main 每次显式填（D31） |
| 055 | **closed（定值）** | at-least-once、无独立 ack、幂等规则（D31） |
| 056 | **主干 0 占位 closed** | Attention/Notification 接口归主干 3；主干 0 只留占位 |
| 057 | **closed（接受）** | outbox dedupe_key 已落；其他外部副作用未接 |
| 058 | **closed（接受默认值）** | 任务目录 90 天 / reports·events 180 天 / vault 长期；自动清理未实现（D31） |
| 060 | **closed（接受）** | D28 逻辑隔离；强 ACL 留部署选项 |
| 062 / 063 | **closed** | MAIN-EXECUTOR 契约 + CLI + 技能已落；wake bridge opt-in |
| 064 | **closed（契约对齐）** | 解析失败 CLI 报错、不落 failed Report，由 Main 重试/降级（D31） |

**本轮新增并关闭的 GAP（发现于部署收口）**：

| ID | 缺口 | 处置 |
|---|---|---|
| GAP-066 | 文档计数漂移（doctor 31/34、scripts 49/54、覆盖率旧值、部署 125/137、Node 22/26、契约 12/13、PLAN §10.3 Linux 命令不可用） | 本轮全量同步，关闭 |
| GAP-067 | 设计/现状文档状态漂移（FUTURE 主干 2「未开始实现」、MAIN-EXECUTOR「草案」、RELEASE-CHECKLIST ACC-01..08） | 本轮改文档，关闭 |
| GAP-068 | 部署脚本缺陷：deploy.ps1 缺 executor 映射且无 -Rollback 实现；doctor.ps1 缺 executor 布局检查；deploy-skills.ps1 仓库根探测错；register-tasks.ps1 3 处漏参、BotUser 默认与 D25 冲突；deploy-verify 调 doctor 未传 -Repo | 本轮修复 + 临时根回滚演练，关闭 |
| GAP-069 | DEPLOY-EMPLOYEE 卸载清单缺 `anc-executor` | 本轮改文档，关闭 |
| GAP-070 | GAP-034/053 残留：Task↔Ticket 映射实现、Ticket 重试/重开/拆分语义 | 文档写明归主干 2 后续；主干 0 接受暂不实现 |
| GAP-071 | executor 实现与契约对齐项：`ticket create` CLI 尚未暴露授权字段（模块层已支持）；「重复 report 409/拒绝」未实现（running 允许多条，结束后的记 late=1） | 归主干 2 后续；已在 `MAIN-EXECUTOR.md` §7 标「待补」，不阻塞主干 0 |
| GAP-072 | 企微 AI Bot 上报的发送者 id 是会话级 open id（`wok…`），不是通讯录 userid；org 的 `member.userid` 必须写实际上报值，否则 `bind actor` 找不到人 | 已按真实入站消息校正老板映射并写进 WORKBUDDY-PATCH / DEPLOY-COMPANY；首次绑定已自动化（GAP-074）：员工第一次 @ 时由 bot 调脚本写入 org |
| GAP-073 | 员工未分配 WorkBuddy 企业版席位/可使用成员 → 企微智能机器人拦截（“你不在该智能机器人的可使用范围”），员工侧 ACC 无法开始 | **closed**：用户已调整企微机器人可使用范围；16:55 吴琼消息入站，采集实际 sender id 并绑定，`bind actor` 通过。新成员仍需按 DEPLOY-COMPANY §11.1 分配/领用 |
| GAP-074 | 首次身份绑定原需人工读日志采集 sender id（员工第一次 @ 后要管理员操作），不满足“公司 bot 自己完成采集绑定” | **closed（已实现）**：`bin\bind-member-identity.ps1` + persona/`anc-task` 首次绑定流程；部署 138 文件；临时 org 验证匹配/未匹配返回；下一条消息即识别 |
| GAP-075 | wake bridge 在当前 `--inspect-brk` 注入路径下不可用：preload 只进子进程，Electron 主进程不加载 → 18187 不监听、无 token；`anc-executor-wake`/`new-host` 静默跳过 | **closed（已修复）**：`inject.cjs` 增加主进程 `require(preload.cjs)`，wake-bridge 正常启动；实测 18187 监听 + token；ACC-09 达成、ACC-10 机制验证、ACC-11 重启演练通过 |

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
| 2026-11-09 | wake bridge 测试收尾：临时桥关闭，正式 opt-in 保留 | 0.3 STATUS；0.6 203/203 | GAP-063 证据补齐 | 18187/18188 均关闭；部署后按 flag 启用 |
| 2026-11-09 | T2.7 审计/幂等收口：events + notify dedupe | 0.3 LOCAL-SERVICE/MAIN-EXECUTOR/PLAN；0.6 209/209 | GAP-057 接受范围 | 其他副作用未实现 |
| 2026-11-09 | T2.5/T2.6 收口：ticket scope + expire | 0.3 executor/LOCAL-SERVICE/MAIN-EXECUTOR；0.6 212/212 | GAP-054 部分收窄 | 物理隔离仍按 D28 |
| 2026-11-09 | Main 评估落库：executor_evaluations + evaluate CLI | 0.3 MAIN-EXECUTOR/modules；0.6 210/210 | GAP-008 更新 | 自动评估器仍未做 |
| 2026-11-09 | GAP-008 决策：background 由 Main 评估后接 | 0.3 DECISIONS/D29、MAIN-EXECUTOR、anc-executor；0.6 209/209 | GAP-008 设计关闭 | 不自动接；评估器实现待做 |
| 2026-11-09 | T1 本地收口核对：T1.3/T1.7/T1.11 本地部分已有测试 | 0.3 PLAN/STATUS；0.6 209/209 | GAP-003/004/028 更新 | 真实群/1:1/成员 API 仍留 ACC-01/06/08 |
| 2026-11-09 | 主干0复检（本机收口后） | 0.1–0.8 | 0.1/0.2/0.4/0.5/0.6 无新增；0.3/0.7 已同步；0.8 待 ACC-09..12 | 本机不关 ACC |
| 2026-11-09 | PLAN 切主干 0：全量收尾 + 两机验收 | 0.3 PLAN 重写/归档 TRUNK-2；0.6 212/212 | 主干 0 成为当前 PLAN | ACC-01..12 未跑 |
| 2026-11-09 | 收口方式定为：本机收口 → 主干0回馈 → 两机验收 | 0.3 PLAN/STATUS §3.5；0.6 209/209 | 新增 ACC-09..12 | 本机不关 ACC；两机前主干保持 🟡 |
| 2026-11-09 | T2 收口批次：sweep/队列/human slot/审计 | 0.3 PLAN、executor 契约；0.6 209/209 | GAP-057/059 更新；验收项大部分勾选 | 真实部署/窗口重启/强 ACL 仍留 |
| 2026-11-09 | T2.3/T2.4/T2.7 补测：sweep、队列顺序、human slot、审计事件 | 0.3 executor/PLAN/模块契约；0.6 209/209 | GAP-057/059 更新 | effect_key 仍待做 |
| 2026-11-09 | GAP-065 真实新建对话：`/new` → workbuddy-anc → NEW_OK | 0.3 WORKBUDDY-PATCH/MAIN-EXECUTOR/OPS；0.6 206/206 | GAP-065 收窄 | 新 host 任务脚本已加，未 -Apply 注册 |
| 2026-11-09 | 路径隔离选 A：接受逻辑隔离，不做专用账号/ACL | 0.3 DECISIONS/D28、FUTURE 2.2、PLAN；0.6 206/206 | GAP-060 接受风险 | 不需要重启；以后可重评 B |
| 2026-11-09 | T2.7 跨进程重启 drill：recover → bootstrap → 重新 claim | 0.3 executor/PLAN；0.6 206/206 | GAP-059 收窄 | 旧 host closed，Ticket 回 queued，新 host 完成 |
| 2026-11-09 | T2.7 recoverHost：旧 host 统一 interrupted + 回 queued | 0.3 executor/LOCAL-SERVICE/MAIN-EXECUTOR/PLAN；0.6 206/206 | GAP-059 更新 | 真实主机重启未做 |
| 2026-11-09 | T2.7 迟到 Report：旧 Assignment 只留证不覆盖新状态 | 0.3 executor/PLAN；0.6 205/205 | GAP-059 更新 | reports.late；真实重启演练待做 |
| 2026-11-09 | T2.6 task_dir 收紧：部门 + ticket_id 推导 | 0.3 executor/MAIN-EXECUTOR/LOCAL-SERVICE；0.6 204/204 | GAP-060 收窄 | 跨部门/穿越/自定义拒绝；物理 ACL 未做 |
| 2026-11-09 | T2.3 wake bridge 真实窗口注入：composer 清空/消息可见 | 0.3 MAIN-EXECUTOR/WORKBUDDY-PATCH；0.6 203/203 | GAP-063 更新 | Slate placeholder 误判已修；默认 flag 控制 |
| 2026-11-09 | T2.3 自动唤醒兜底：每分钟查 queued，有任务才唤醒 | 0.3 OPS/PRODUCT/MAIN-EXECUTOR/WORKBUDDY-PATCH；0.6 203/203 | GAP-063 设计关闭 | wake bridge opt-in；无 flag 时静默 |
| 2026-11-09 | T2.3 自动兜底：03:00 无新 host 旧 host 继续接单 | 0.3 FUTURE/MAIN-EXECUTOR/LOCAL-SERVICE；0.6 203/203 | GAP-065 更新 | cut_deferred；创建新对话仍未解 |
| 2026-11-09 | T2.3 host bootstrap：同对话幂等/跨日自动切 | 0.3 MAIN-EXECUTOR/LOCAL-SERVICE/PLAN；0.6 202/202 | GAP-065 更新 | 自动创建新对话仍未解 |
| 2026-11-09 | T2.5 真实 WorkBuddy subagent：Ticket → Agent → Report → outbox | 0.3 PLAN/anc-executor；0.6 201/201 | GAP-031 更新 | 临时库实测；start 在 Agent 完成后补记 |
| 2026-11-09 | T2.3/T2.4 CLI 端到端：host → ticket → claim → start → report → notify → end | 0.3 LOCAL-SERVICE/interfaces/PLAN；0.6 201/201 | GAP-026/031/053 更新 | 临时库实测通过，outbox 1；真实 Runner 未接 |
| 2026-11-09 | T2.1/T2.2 领域层：executor 四表 + 仓储 | 0.3 ARCHITECTURE/modules/executor/PLAN；0.6 201/201 | GAP-026/053/031 更新 | 表/唯一索引/状态机/日切仓库；未接 CLI/WorkBuddy |
| 2026-11-09 | 写定 Main↔Executor 契约 | 0.3 MAIN-EXECUTOR；0.6 196/196 | GAP-062/064 设计关闭；063/065 保持 | 实现未动 |
| 2026-11-09 | 主干2 开工门禁审计 | 0.3 PLAN；0.6 196/196 | 新增 GAP-062..065 | T2.1 可开工；T2.4/2.5 等待契约 |
| 2026-11-09 | 主干2 表草案/状态机：host + assignment | 0.3 FUTURE 2.3；0.6 196/196 | GAP-026/053/054 更新 | 唯一 active assignment；03:00 日切序列已定 |
| 2026-11-08 | 文件驱动工作法显式化 | 0.3 AGENTS §3.5、DOC-SYNC、FUTURE 规则 14；0.6/0.8 未变 | 无新增 GAP | 聊天是临时、文件是持久；check 通过 |
| 2026-11-09 | 公司侧部署收口 + 主干 0 处置 | 0.1–0.7 按证据处置；0.6 212/212×3、覆盖率 90.85/80.43/94.99（干净树 0ed1938）；0.4 部署/13 任务/补丁/备份/回滚演练 | 新增并关闭 GAP-066/067/068/069/070；关闭/接受 007/008/010/023/026/027/032/035/054/055/057/060/062/063/064 等；034/053 残留归 GAP-070，实现对齐项 GAP-071 | 0.8 ACC-07/09 部分达成；其余 10 项未跑（缺真实群/员工/第二台电脑） |
| 2026-11-09 | org 与真实群接线（公司大群 + boss_dm + 3 成员/技术部） | 0.3 STATUS §1.6/§3.5、PLAN §13；0.8 真实群接线推进 | 无新增 GAP；ACC-01/05/06 转「部分达成」 | 员工群/部门群/成员 API 仍缺；需真实群消息回归 |
| 2026-11-09 | 用户决定 boss_dm 简化为老板 1:1（不建私有群） | 0.3 DECISIONS D32、STATUS §1.6/§3.5；0.8 ACC-06 口径 | 无新增 GAP | 1:1 无主动推送，按 D32 接受；收口期不扩配置 |
| 2026-11-09 | ACC-07 生产回滚演练（rollback 137 → re-apply 137） | 0.4 部署回滚；0.8 ACC-07 达成 | 无新增 GAP | 演练后 doctor/verify 全绿；证据 `verify/final/acc07-rollback-*.log` |
| 2026-11-09 | 员工入站打通：企微机器人可使用范围调整 + 吴琼 sender id 绑定 | 0.3 STATUS §1.6/§3.5；0.8 员工链路推进 | GAP-073 关闭 | `patch-in.log` 有吴琼入站；`bind actor` 通过；张佳艺 id 待采集 |
| 2026-11-09 | 首次身份绑定自动化：bind-member-identity.ps1 + persona/技能流程 | 0.2/0.3 脚本/技能/persona；0.6 部署 138 文件；0.8 员工链路 | 新增并关闭 GAP-074 | 未识别成员第一次 @ 时自动绑定；临时 org 验证两种返回；张佳艺本次为旧会话，人工补绑 |
| 2026-11-09 | 备份恢复演练 + wake bridge 限制查清 | 0.4 备份恢复；0.8 ACC-09/10 口径；D33 | 新增 GAP-075（wake bridge 不可用，按例外） | 恢复演练后 doctor/verify/verify-org 全绿；wake bridge 不监听，flag 已移除 |
| 2026-11-09 | 用户实测员工侧全部通过（口述，无机器日志） | 0.3 STATUS §1.7/§3.5；0.8 ACC-02/03/04/05/06/12 记用户验收 | GAP-001/002/004/028/030/041 关闭；003 留 ACC-08 | 用户明确要求按实测通过记账并注明无机器日志 |
| 2026-11-09 | ACC-08 按用户选择 B 记书面例外（人工对账） | 0.8 ACC-08；0.3 STATUS §3.5；D36 | GAP-003 accepted（例外） | 公司群对账差异 0；员工/部门群未覆盖；不自建应用 |
| 2026-11-09 | ACC-10 定时任务实测达成；主干 0 收口 | 0.8 ACC-10；FUTURE 主干 0 全分支；PLAN 快照 | GAP-006/031/042/050/065 关闭；主干 0 ✅ | trigger 临时改 now+2min 实测后恢复 03:00；文档全量同步 |
| 2026-11-09 | wake bridge 修复（inject 主进程加载 preload）+ ACC-09/10/11 演练 | 0.8 ACC-09/10/11；0.3 WORKBUDDY-PATCH；D34 | GAP-075 关闭 | 18187 监听；new-host 机制成功；真实窗口重启 recover→queued→新 host 重派通过 |

### 3.5 真实环境验收批次（统一收尾）

> 这些是 `0.8` 验收项：需要真实群、真实凭据或公司主机。它们**不阻塞代码推进**；统一收尾时按 ACC 顺序一次跑。通过前主干保持 🟡 待验收，不能标 ✅。
>
> **2026-11-09 本机（单机）执行记录**：ACC-07 部分达成（部署/重启完成，回滚仅临时根演练，未做生产回滚窗口）；ACC-09 基本达成但按标准未达成（13 任务 Ready、补丁 applied、doctor FAIL=0；wake bridge 18187 未启用，默认关）；其余未达成。详见 §1.5 与 `.workbuddy/verify/gap/gap-audit.md` §C。

| 编号 | 验收项 | 前置 | 通过标准 | 对应 GAP | 2026-11-09 本机结果 |
|---|---|---|---|---|---|
| ACC-01 | 四类群配置 | 四类群 chat_id + secrets webhook + org 字段 | `bind actor` 在四类群返回正确 type/role；`verify-org` 通过 | GAP-003/042 | **用户实测通过（口述，无机器日志）**；本机侧只验了公司群 + boss_dm（`bind actor` 正确、`verify-org` ok），员工/部门群 chatId 未入本机 org |
| ACC-02 | 员工群任务 + 个人数据 | 员工群可用 | 登记任务成功；个人数据只在本人员工群答 | GAP-001/002 | **用户实测通过（2026-11-09，口述；无机器日志）**：员工身份链路已通、首次绑定自动化 |
| ACC-03 | 同部门请求 | 两个同部门员工 | A 请 B → `pending_acceptance` → B 接受 → `open` | GAP-002 | **用户实测通过（2026-11-09，口述；无机器日志）** |
| ACC-04 | 跨部门审批 | 执行人部门管理者在群 | A 请 C → `pending_approval` → 管理者批准 → C 接受 → `open` | GAP-002/003 | **用户实测通过（2026-11-09，口述；无机器日志）** |
| ACC-05 | 公司/部门群隐私 | 公司群、部门群可用 | 公司/部门级直接答；个人级转员工群；内部级只回 1:1 | GAP-001 | **用户实测通过（2026-11-09，口述；无机器日志）**；本机公司群身份/角色映射已验 |
| ACC-06 | 老板 1:1 | 真 1:1 或私有群 | 内部数据只在 1:1 答；公司群不泄露 | GAP-004 | **用户实测通过（2026-11-09，口述；无机器日志）**；本机 1:1 识别通过，私有群 fallback 不做（D32） |
| ACC-07 | 部署 / 重启 / 回滚 | 公司主机管理员 | `deploy.ps1 -Apply` + `render deploy --db` + 服务重启；失败可回滚 | GAP-042 | **达成（本机）**：部署 137 文件、`render deploy --db`、WorkBuddy 重启（补丁 applied）均完成；`deploy.ps1 -Rollback` 恢复 137 文件 → 再 `-Apply` 137 文件 hash 全过；演练后 doctor 34/FAIL=0、deploy-verify ok 4/0/1 |
| ACC-08 | 企微成员对账 | 可读群成员的企微应用凭据 | org 成员与企微群成员一致；差异有清单 | GAP-003 | **书面例外接受（用户选择 B，D36）**：人工对账公司群成员（3 人 + 公司 bot）与 org 3 人一致、差异 0；员工群/部门群 chatId 未入账本，未覆盖；无企微成员 API 凭据 |
| ACC-09 | 公司主机部署 + 13 个任务 | 公司主机管理员 | `deploy.ps1 -Apply` + `register-tasks.ps1 -Apply`；13 个任务 Ready；带补丁重启后 wake bridge 监听 18187 | GAP-006/065 | **达成（本机）**：138 文件 / 13 任务 Ready / `patch-state applied=true` / doctor 34 项 FAIL=0 / wake bridge `127.0.0.1:18187` 监听（GAP-075 已修） |
| ACC-10 | 03:00 自动日切 | ACC-09 + workspace 配置 | `/new` 自动建新对话；host bootstrap；旧任务继续、新任务进新 host | GAP-031/061/065 | **达成（本机，定时任务实测）**：临时 trigger now+2min → 任务自动建新 host（`conv-20261109-173355`）+ bootstrap；新 ticket 在新 host claim/report/end；trigger 已恢复 03:00 |
| ACC-11 | 真实窗口重启恢复 | 公司主机 | 重启 WorkBuddy 后 `recoverHost` 生效；旧 Assignment interrupted；Ticket 回 queued 并由新 host 重派 | GAP-059 | **达成（本机演练）**：真实窗口重启 → `recover` → host closed、Assignment interrupted、Ticket queued → 新 host claim/start/report/end；证据 `stage/acc11-*.log` |
| ACC-12 | 两机真实群/任务 | 公司主机 + 员工电脑 | 真实员工群/部门群/公司群；员工 bot 不越界；任务产物只在对应目录 | GAP-050/006 | **用户实测通过（2026-11-09，口述；无机器日志）** |

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
| 2026-11-09 | 主干 2 第一批收口：表/CLI/恢复/审计 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ◎ | ✅ | ✅ | ✅ |
| 2026-11-09 | 全量文档/部署计数：13 任务、17 CLI、8 技能、212 测试 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 2026-11-09 | 主干 0 本机收口 + 公司侧部署 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ◎ |
| 2026-11-09 | **主干 0 收口完成**（8 分支 + ACC-01..12 通过或书面例外） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ◎ |
| 待填 | 主干 2 完成 |  |  |  |  |  |  |  |  |  |  |  |

---

## 5. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| `npm test` 偶发挂起 | 门禁不稳定 | 先单文件定位；必要时拆分/串行化 PowerShell 用例 |
| WorkBuddy subagent 并发/路径隔离未验证 | 多任务吞吐和部门边界受影响 | 先做 2 并发 + 目录写入 spike；必要时降为串行队列 |
| 企微 1:1 / 入站路由未验证 | 老板控制台和确认链可能不可用 | 在 D3 前做最小实验 |
| 未来上游许可证不明 | 不能合法二创 | `UPSTREAM.md` 的许可证门禁：不明只学概念 |
| 文档再次漂移 | 又回到“多份真相” | `DOC-SYNC` + `check:docs` + 主干完成定义；本轮已关闭 GAP-066/067 |
| 离机备份与本地同物理盘（本机 D:\anc-backup） | 盘坏时本地与离机一起丢 | 换独立盘或 UNC；本机实测已在 `backup.log` 告警，D30 暂接受 |
| WorkBuddy 非标准安装路径依赖 Junction（本机 D:\App\WorkBuddy） | 换机/重装/升级后路径假设失效 | DEPLOY-COMPANY §2 已写建法；回滚=删 Junction；doctor 每次体检覆盖 |
| Node v26 与设计基线 v22 差异（本机实测） | 未在 v22 上复测本轮脚本改动 | 212/212 在 v26 通过；发布机建议仍用 Node 22 LTS |
| 真实群/员工数据/第二台电脑缺失 | ACC-01..06/08/10/12 无法通过 | 用户补齐后按 DEPLOY-COMPANY §10/§12 + STATUS §3.5 跑 |

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
