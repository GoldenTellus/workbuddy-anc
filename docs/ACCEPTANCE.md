# V1 验收矩阵（PLAN 2.0 §1 的 DoD，共 40 条）

> 每条的"证据"必须是仓库里能查到的具体位置。查不到的标 ⬜ 并写清卡点，不记成通过。

本文件是 PLAN §6 判据 V1 的落地件：按 §1 的 ID 逐条给证据路径，**不写口头结论**。

## 0. 先看两件事

**（1）条数：40 条，PLAN 的计数已修正。** PLAN §1 原文写"七组，共 35 条"、§6 V1 写"35/35"，但七张表实际列出 **40 个 ID**：
E 5 + W 4 + K 6 + S 6 + P 7 + A 6 + O 6 = 40（A 组只到 A-6、O 组只到 O-6，所以不是"多列了几行"，是计数写错了）。
处理方式：**按实际 40 条全覆盖，不删条款**——删掉任何一条等于放过一条 DoD；同时把 PLAN 的 35 改成 40（2026-11-02）。
当初发现这个矛盾时，先把"按 40 条写、并向维护者报计数不一致"这件事固定下来，再等确认，而不是先凑成 35 行。

**（2）状态判据（本矩阵自用，避免把"有代码"当"已验收"）：**

| 状态 | 含义 |
|---|---|
| ✅ 有证据 | 代码/测试/脚本/文档条款能逐字核对，且条款成立**不依赖**尚未发生的实机事实 |
| 🟡 部分 | 实现或检查项存在，但条款成立还差实机产物（日志行/真实群消息 ID/迁移后的账号/干净机） |
| ⬜ 待证据 | 仓库里没有对应实现，或只有"待做/部分落地" |

> 本矩阵**不复制**任何主机产物内容（`audit.log`、`backup\`、`loop.log`、`patch-canary.json` 等只写路径）。
> 主机产物的实际值在主机上，不在仓库；凡只靠主机产物才能闭合的条款，一律 🟡 或 ⬜。

## 1. 矩阵

| # | DoD 条款（简写） | 状态 | 证据 | 卡点 |
|---|---|---|---|---|
| E-1 | 一台 Windows 主机 7×24 跑公司 bot；员工电脑跑个人 bot；两边都经企微 | 🟡 | `docs/OPS.md:7-19`（9 个任务）`scripts/register-tasks.ps1:71-136`；`docs/VERIFY.md:305`（T4 锁屏整夜照常收发） | 员工侧个人 bot 尚未部署（本机只有一个账号）；7×24 连续运行无浸泡记录（V5 未做） |
| E-2 | 一人一群；私聊公司 bot 仅管理员 | 🟡 | `src/service/bindings.ts:30`、`src/service/loop.ts:281-290`（只发本群 webhook，不退回默认群）；测试「隔离：未绑定群的消息不退回默认 webhook」`src/service/service.test.ts:278`；`docs/CHAT-BINDINGS.md:52-56`；`docs/FORK-DIRECTION.md:62` | 私聊限管理员属企微后台配置，VERIFY T11 未测（`docs/VERIFY.md:312`） |
| E-3 | 两个 bot 都 @ 才回应 | ✅ | `docs/FORK-DIRECTION.md:63`（D20 不放宽）；`docs/VERIFY.md:303`（T2）、`:308`（T7） | — |
| E-4 | 主机不开自动登录；重启后人工登录恢复；开机提醒兜底 | 🟡 | `scripts/boot-alert.ps1:1-24`（60 秒后查 WorkBuddy，发运维群）；`scripts/register-tasks.ps1:86-89`；`docs/OPS.md:185` | "不开自动登录"是主机侧配置，仓库无证据；真注销→恢复未测（R2 挂起） |
| E-5 | 运行身份分开，都不在管理员组 | 🟡 | `scripts/doctor.ps1:194-206`（`dedicated-user` / `bot-process-owner`）；`scripts/register-tasks.ps1:62-66`（Service/Interactive principal）；`docs/FORK-DIRECTION.md:275` | R1 未完成：WorkBuddy 仍跑在 Administrator，两个交互任务 principal=Administrator（`docs/PLAN.md:158-159`） |
| W-1 | D17 注入群身份；`APPLIED mode=hash` 且 canary 有 chatId | ✅ | `scripts/workbuddy-patch/preload.cjs:98-104`、`:188`；`scripts/workbuddy-patch/manifest.json`（版本/hash/target）；`scripts/doctor.ps1:265-269`（patch）、`:347-355`（canary）；`docs/VERIFY.md:318`（T16b 两段成立） | 日志行与 chatId 值不入仓，只在主机（`%USERPROFILE%\anc\workbuddy-patch.log`、`%ProgramData%\anc\data\patch-canary.json`） |
| W-2 | 自动升级被拦；版本/hash 不符告警；补丁可一键关闭 | ✅ | `scripts/workbuddy-patch/preload.cjs:143-152`（拦 `/v2/update`，`ANC_WB_BLOCK_UPDATE` 开关）；`scripts/workbuddy-patch/launch-patched.ps1:80-91`（版本不符告警）；`scripts/check-workbuddy-update.ps1:48`；`scripts/workbuddy-patch/restore.ps1`；`docs/FORK-DIRECTION.md:326` | 真升级告警尚未触发过（R7 事件触发型）；运行期告警记录在主机 |
| W-3 | 每处改动都有台账（版本+build+目标 hash+开关+回滚） | ✅ | `docs/FORK-DIRECTION.md:320-332`（§11 台账逐项 7 列）；`scripts/workbuddy-patch/manifest.json`（版本 5.9.3 / target / sha256 / toggleEnv） | "无漏账"靠人工比对，仓库里没有自动核对台账的脚本 |
| W-4 | 升级回归三段（原版→重放→改动后）有脚本化检查单 | 🟡 | `docs/WORKBUDDY-PATCH.md:114-120`（升级流程）；`light/skills/anc-wb-patch/SKILL.md`（侦察→三种情况→四条回归→台账→回滚）；`docs/FORK-DIRECTION.md:316` | 检查单是文档 + 技能文本，没有可执行脚本；R7 未跑过真升级 |
| K-1 | vault 两区各自独立 git；共享区全员只读、内部区只有公司侧 | ✅ | `src/service/a2a.ts:10-23`（内部区必须是独立 git，不能是共享区或其子目录）；测试「A2A：内部区必须是独立 git 目录，且不能是共享区」`src/service/service.test.ts:561`；`scripts/doctor.ps1:273-293`（`smb` / `vault-acl`）；`docs/OPS.md:121-126` | — |
| K-2 | `_originals/` 永不进 git，代码层面拒绝 | ✅ | `src/ingest/git.ts:17-18`（收到 `_originals/` 直接抛错）；`src/ingest/cli.ts:81-83`（只把 added/modified 交给 commit）；测试 `src/ingest/ingest.test.ts:282`、`:304` | — |
| K-3 | 覆盖写必须带 base hash | ✅ | `src/ingest/apply.ts:82-88`（缺/不符/新文件带 hash 三种都拒）、`:187-188`（锁内再核一次）；测试 `src/ingest/ingest.test.ts:45`；语义定死见 `docs/PLAN.md:208`（H3，按工作区内容而非 HEAD） | — |
| K-4 | 入库只做确定性校验、不调模型；失败进 `failed/` 并回执 | ✅ | `src/ingest/validate.ts:35-36` 等校验；`src/ingest/apply.ts:212`（失败归 `failed/` 并写 reason）；测试 `src/ingest/ingest.test.ts:112`、`:95`；`docs/INGEST.md:62` | — |
| K-5 | 入库崩溃/断电后可自愈，无需人工删锁 | ✅ | `src/ingest/apply.ts:126-158`（锁写 `{pid,started_at}`，pid 不存在或 >10 分钟接管，旧锁改名 `.stale-`）；测试 `src/ingest/ingest.test.ts:314`（死锁接管、活锁仍拒）；`docs/PLAN.md:233`（H4 实测） | 断电只做到"杀进程 + 留锁"代理，真断电未复现（V3 同一取舍） |
| K-6 | 内部区 markdown 是可重建投影，能无损重建 | ✅ | `src/service/project.ts:75-106`（原子写、`check`、`rebuild`）；`src/service/cli.ts:252-265`（`project` / `--check` / `--rebuild`）；测试「投影：生成 markdown、幂等、check 能识别缺失与手改」`src/service/project.test.ts:10`；`docs/PLAN.md:242`（C2 实机：8 行→check true→手改 false→rebuild true） | 命令名是 `project`/`--rebuild`，不是 PLAN 正文里的 `reproject`（同一件事，命名未统一） |
| S-1 | 任务/提醒/完成判定/outbox 全在 SQLite；markdown 只是投影 | ✅ | `src/service/db.ts:12-96`（meta/config/a2a/tasks/task_events/reminders/outbox 各表）；`docs/FORK-DIRECTION.md:150`；`src/service/project.ts:52`（投影单向生成） | — |
| S-2 | 「完成」只能由服务判定，且完成与出站消息同事务 | ✅ | `src/service/tasks.ts:103-137`（`tx()` 内写 done + 事件 + 取消提醒 + 入队）；测试「任务：完成与出站消息同事务，重复完成幂等」`src/service/service.test.ts:33` | — |
| S-3 | 提醒不经 WorkBuddy，主机无人登录也照发 | 🟡 | `src/service/loop.ts:256-310`（按群绑定直连企微群 webhook，不经 WorkBuddy）；测试 `src/service/service.test.ts:252`；`scripts/anc-loop.cmd`（`loop --once`） | "无人登录照发"需注销实测（R2，依赖 R1），现只有"停 WorkBuddy"代理测试 |
| S-4 | 默认规则（首次到点/15 分钟重复/4 次升级/当天截止/次日顺延）全部可运行 | ✅ | `src/service/reminders.ts:29-30`（默认 15 分钟，非法值兜底）、`:63-65`（跨天停）；`src/service/loop.ts:169-189`（第 4 次后通知交办人并改每小时）、`:99-127`（次日顺延并告知）；测试 `src/service/service.test.ts:57`、`:352`、`:438`、`:597` | — |
| S-5 | 时区/工作时段/节假日可配置，非法值不静默兜底 | ✅ | `src/service/config.ts:57-84`（写入即校验：HH:mm / weekdays / Windows 时区 Id / 绝对路径 / holidays 日期）、`:123-139`（isWorkTime/nextWorkStart）；测试 `src/service/service.test.ts:396`；`scripts/doctor.ps1:216-218`（`work-hours`）、`:316-320`（`timezone`） | — |
| S-6 | 出站前凭据扫描，行为与 §8 一致（二选一写死） | ✅ | `src/service/outbound-scan.ts:24-48`（命中即 `OUTBOUND_SECRET_BLOCKED`）；`src/service/outbox.ts:31`（入队前统一过扫描）；测试 `src/service/service.test.ts:72`、`:242`；`docs/FORK-DIRECTION.md:278`（终态=阻断）；`docs/PLAN.md:216`（H7 定为阻断） | 盲区已文档化：WorkBuddy 自己在群里的回复不经过本地小服务 |
| P-1 | 群里登记任务 → 到点 @ → 不回继续 → 回「完成」即停 | ✅ | `light/skills/anc-task/SKILL.md:21-39`（登记/完成/取消的 CLI 用法）；`src/service/loop.ts:147-190`（@ 绑定人、连续提醒、升级）；测试 `src/service/service.test.ts:252`、`:352`、`:331`；`docs/VERIFY.md:292`（T6 真实群触发成功）、`:322`（T20 数十轮后仍按流程） | — |
| P-2 | 发文件说「入库」→ 复核 → 入库摘要 → 按路由定位并给本地生成的摘要/路径；查不到说「尚未入库」 | 🟡 | `src/ingest/cli.ts:81-93`（写入/归档/提交，默认不提交）；`docs/INGEST.md:57-71`（复核 diff 后手提交）；`light/skills/anc-ingest-company/SKILL.md`；「尚未入库」条款 `light/skills/anc-vault-read/SKILL.md:8` | 「摘要由本地脚本生成」未做（`docs/PLAN.md:251` C13 自述）；"按路由定位到文件并给出摘要/路径"没有对应实现与用例 |
| P-3 | 新员工一小时内拿到个人 bot 与三方群；渲染器是唯一上线路径 | 🟡 | `src/render/onboard.ts:29-72`（installPackage / verifyInstall）；`src/render/index.ts:230-251`（deployOrg 整组事务 + rollback）；测试 `src/render/onboard.test.ts:23`、`:40`、`:54`、`src/render/deploy.test.ts:35`、`:52`；`docs/ONBOARDING.md` | "一小时"无计时记录（R5 未做）；`D:\anc\org` 尚未建（`docs/OPS.md:166`），端到端只在临时 org 上跑过 |
| P-4 | 访谈 11 问经个人 bot 整理、员工转发、公司 bot 归档到内部区 | ✅ | `light/skills/anc-interview/questions.md`（11 问）、`light/skills/anc-interview/SKILL.md`；`src/service/a2a.ts:116-144`（信封解析、按 `message_id` 去重、落内部区）；测试 `src/service/service.test.ts:104`、`:119`；`docs/VERIFY.md:322`（T20 真群跑过 11 题访谈） | 跨天场景未跑（R4） |
| P-5 | A2A 通道按 A5 结论执行（自动或员工转发） | ✅ | `docs/PLAN.md:131`（A5 = D23：默认员工转发）；`docs/FORK-DIRECTION.md:160-165`（§5.6）；`src/service/a2a.ts:11-23`、`:89-144`；测试 `src/service/service.test.ts:104`、`:561`、`:580` | 自动通道 C4 未做（依赖 T14 实测），按裁决走转发，不算未完成 |
| P-6 | 后台长任务按发送者隔离，异常进 `needs_review`，不自动重试 | ✅ | `src/service/tasks.ts:155-199`（`kind=background`、`start` 拒绝重复、超时转 `needs_review`、`review retry/close`）；`src/service/loop.ts:194-198`；测试 `src/service/service.test.ts:672`、`:699` | — |
| P-7 | 离职：`disabled:true` → 不重建 persona、任务转交、席位回收、账号删除 | 🟡 | `src/render/org.ts:106`（只认字符串 `true`）；`src/render/offboard.test.ts:29`、`:65`；`src/service/tasks.ts:208-221`（转交只动 open）；测试 `src/service/service.test.ts:715`；`scripts/offboard-member.ps1:52-101`（四步，默认 dry-run） | 账号删除与"席位回收"要真实账号与 `D:\anc\org`；目前只在临时 org 上跑过 dry-run（`docs/PLAN.md:247`） |
| A-1 | 密钥只在 `%ProgramData%\anc\secrets`，NTFS 只给服务身份与管理员 | ✅ | `scripts/doctor.ps1:295-297`（`secrets-acl`）；`docs/OPS.md:70-76`（收紧必须三步，含 `/remove:g`）；`docs/PLAN.md:160`（R0 实测转 PASS，LOCAL SERVICE 读探针退出码 0） | ACL 明细与探针输出在主机与 `_research/`（不进 git），仓库只能引 PLAN 记录 |
| A-2 | org 数据只写引用名，值不进库/不进 git/不进日志 | ✅ | `src/render/org.ts:40-66`（文本字段拒控制字符/反引号/HTML 注释；`webhook_file` 只能是文件名）；测试 `src/render/render.test.ts:137`、`:117`；`docs/FORK-DIRECTION.md:279` | — |
| A-3 | 入站文件与网页按敌意处理；提交权限在入库进程 | ✅ | `src/ingest/validate.ts`（短名/非法字符/大小/前后缀）；测试 `src/ingest/ingest.test.ts:68`（路径穿越）、`:183`（越界 src）、`:242`（junction 双侧越界）；`docs/FORK-DIRECTION.md:277` | 已知缺口：bot 曾绕过 CLI 直写 vault（`docs/PLAN.md:260`，待权限隔离裁决）——本条约定的"提交权限在入库进程"目前是纪律 + 事后审计，不是权限隔离 |
| A-4 | 小服务只监听 `127.0.0.1`，带 token，未配 token 全拒，常量时间比较 | ✅ | `src/service/http.ts:31-35`（`timingSafeEqual`）、`:50`（默认 host）、`:77`（无 token → 503）、`:81`（错 token → 403）；测试 `src/service/http.test.ts:7`、`:25`、`:42` | — |
| A-5 | 转公开检查可执行、零输出、exit 0；`_research/` 未被跟踪 | ✅ | `scripts/check-public.mjs:16-71`；`.gitignore:9-10`；本次落盘后实跑：零输出、退出码 0（见本文 §2） | — |
| A-6 | 资料不上云：正文不作为对话内容；只传路径/标题/结构化字段，摘要本地生成 | 🟡 | `docs/PLAN.md:251`（C13：persona/技能写死只报路径与标题 + 审计）；`src/shared/summarize.ts` + `cli summary`（本地摘要；`--path` 单篇、`--find` 按关键词定位并给路径+摘要，7 条单测，无模型无网络）；`light/personas/company-bot/CODEBUDDY.md:28`；`src/shared/audit.ts:26-30`（JSONL 只记命令与目标）；`scripts/doctor.ps1:370-392`（`vault-ingest-audit` 抓绕过 CLI 的写入） | 「摘要由本地脚本生成」明确未做；"正文不外发"只有 persona/技能文字约束，没有机制性证据（无测试、无网关拦截） |
| O-1 | 9 个计划任务齐、principal 正确、`IgnoreNew` | 🟡 | `scripts/register-tasks.ps1:58`（`-MultipleInstances IgnoreNew`）、`:71-136`（9 个任务定义）；`scripts/doctor.ps1:133-143`（9 项期望 principal）；`docs/OPS.md:5-19` | 两个交互任务 principal 仍是 Administrator（R1 挂起，`docs/PLAN.md:159`），故"principal 正确"未闭合 |
| O-2 | doctor 覆盖全部关键面，且每项都能证明会 FAIL | 🟡 | `scripts/doctor.ps1:145-190`（`-SelfTest` 夹具注入）；`scripts/verify-doctor.mjs:69+`（真注入 ACL/任务/补丁）；`docs/PLAN.md:271`（V4：3 PASS 0 FAIL） | SelfTest 只覆盖 5 类断言（secrets-acl / deploy-layout / task-coverage / bot-process-owner / secrets-in-git），不是 R0.5 要求的"每项都注入"；其余检查项的 FAIL 能力未逐项证明 |
| O-3 | watchdog 覆盖 WorkBuddy/心跳/outbox 积压，同类告警有冷却 | ✅ | `scripts/watchdog.ps1:19`（心跳 >10 分钟）、`:27`（积压 ≥50）、`:41`（WorkBuddy 不在跑）、`:76`（30 分钟冷却）；`docs/OPS.md:15` | 告警实发记录在主机与运维群，不在仓库 |
| O-4 | 备份离机（另一块盘或 UNC），含 vault 与 SQLite；恢复演练过 | 🟡 | `scripts/backup-anc.ps1:88-124`（保留策略、`DiskNumber` 比对、同盘告警、离机复制）；`src/service/backup.ts`；测试 `src/service/service.test.ts:620`、`:640`；`docs/OPS.md:157-162` | 当前 `E:` 与 `C:` 同在 Disk 0，"离机"只是同盘拷贝（`docs/PLAN.md:246`）；恢复演练无记录（REBUILD §2 只有步骤） |
| O-5 | 干净机按 REBUILD 重建成功并计时 | ⬜ | `docs/REBUILD.md:1-71`（步骤齐） | 干净机重建未做（R5 挂起，依赖 R1）；无计时记录 |
| O-6 | 日志有轮转；失败路径都进告警面 | ✅ | `scripts/anc-loop.cmd`（>5 MB → `loop.log.1`，只留一份）；`scripts/anc-http.cmd`（`http.log` 同规则）；`scripts/watchdog.ps1`；`scripts/scan-catch.mjs:2-14`（catch 分类）；`docs/VERIFY.md:387+`（V2 静态扫结论） | V2 自己写明"注入只覆盖关键路径，未做到 53 个 catch 逐个注入"——"都进告警面"是静态结论 + 关键路径抽测 |

## 2. 统计与转公开检查

**统计**：✅ 26 · 🟡 13 · ⬜ 1（合计 40 = PLAN §1 实际的 40 个 ID）

**卡在真实群/环境上的条目**（只要这几条不闭合，V1 就不是 100%）：

| 类别 | 条目 | 缺的东西 |
|---|---|---|
| 换用户 / 注销（R1、R2、R5） | E-4、E-5、S-3、O-1、O-5 | 以 `anc-bot` 登录并迁移 WorkBuddy；注销后到点提醒的时间戳 + 群消息 ID；干净机计时 |
| 企微后台 / 真实群（T11） | E-2 | 私聊限管理员的后台配置（T11 未测）；另 R3/R4 的真实群验收还没跑，但那属 R 段台账，不是本条 DoD |
| 账号与 org 未落地 | P-3、P-7 | `D:\anc\org` 未建；真实员工账号与席位（P-3 的"一小时"、P-7 的账号删除都要它们） |
| 物理条件 | O-4 | 独立物理盘或 UNC 目标；一次恢复演练记录 |
| 代码未落地 | P-2、A-6 | 本地摘要脚本 + 按路由定位的实现与用例（C13 剩余部分） |
| 检查覆盖/无脚本 | O-2、W-4 | 逐项 FAIL 自测；可执行的升级回归检查单 |
| 长跑未做 | E-1 | 7×24 连续运行记录（V5 浸泡，未开始） |

**转公开检查**：本文件落盘后跑 `node scripts/check-public.mjs`——零输出、退出码 0。

## 3. 本矩阵刻意不写的东西

- 不复制任何主机产物内容（`%ProgramData%\anc\data\audit.log`、`backup\`、`loop.log`、`patch-canary.json` 只写路径）。
- 不写真实主机名、真实用户名路径、企微 webhook、chatid/userid、人名；一律 `<userid>` / `%ProgramData%` / `%USERPROFILE%` 占位。
- 不把"代码存在"写成"已验收"：凡需要主机事实的，一律 🟡/⬜ 并在卡点列写清谁能给。
