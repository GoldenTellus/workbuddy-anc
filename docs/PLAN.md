# 里程碑计划

版本:1.0(2026-10-31)。取代上游的 M0–M5(Mac mini + cc-connect + 飞书);上游原文在 git 历史里,需要时 `git show 90e4fb2:docs/PLAN.md`。设计依据是 [FORK-DIRECTION.md](./FORK-DIRECTION.md),本文只管顺序和验收。

## 排序原则

- **先让员工用上**:每个里程碑结束时,员工在企业微信里能多做一件事。
- **先测后做**:里程碑依赖的待实测项(T#)排在它的第一步,不成立就先改设计。
- **上线门槛跟着里程碑走**:部署加固不单独排期,每个里程碑列出上线前必须满足的条件。
- **WorkBuddy 只有补丁一条路**(D18):企业版与个人版实测结果一样,群身份、发送人都要靠 D17 补丁。所以凡是上主机的版本,必须先过 §11 的升级回归。

## M0 方向与阻断项 ✅

- [x] 方向定稿(FORK-DIRECTION D1–D18)、上游复用盘点([REUSE-MAP.md](./REUSE-MAP.md))
- [x] 阻断项实测([VERIFY.md](./VERIFY.md)):T1–T5、T7、T17 通过;T16 不通过,改由 D17 补丁注入群标识与发送人(T16b)
- [x] WorkBuddy 补丁(D17,[WORKBUDDY-PATCH.md](./WORKBUDDY-PATCH.md))、群绑定表([CHAT-BINDINGS.md](./CHAT-BINDINGS.md))
- [x] 本地小服务第一切片([LOCAL-SERVICE.md](./LOCAL-SERVICE.md)):任务、提醒、outbox、绑定、循环;`npm test` 21 项

## M1 当日任务与提醒,端到端

**目标**:员工在自己的群里 @ 公司 bot 说「7 点半提醒 B 开工」,到点 B 被 @;没回就继续提醒;B 回「完成」就停。

**第一步:T6**——公司 bot 能否经技能调用本地脚本(`npm run service -- task add …`)。不成立就改走 JSON 投递目录(FORK §5.5),再做下面的事。**T6 已通过(2026-10-31)**:公司 bot 经 `anc-task` 技能调用 CLI,真实群里登记成功。

**进度(2026-10-31)**:T6 通过;真实群里登记 #2,到点 #3 由 `anc-service` 发出并被 @;权限校验、outbox 退避、按群选 webhook 已上线。

交付:

- [x] 公司 bot 的 `CODEBUDDY.md` 第一版:身份、职责边界;每轮先读消息开头的 `[anc:chat=… from=…]`,用 chatid 查绑定表,查不到就按未绑定处理,不猜人;私聊只处理管理员;诚实条款。控制在 6500 字符以内。M3 之前用仓库里的模板 + 部署脚本(带指纹、先备份、可回滚),M3 起改由渲染器生成。(`light/personas/company-bot/CODEBUDDY.md` + `scripts/deploy-persona.ps1`)
- [x] 任务技能:把一句话转成 `task add / list / done / cancel`;回显写全的时间;执行人有多条待办时先问是哪条。(`light/skills/anc-task/SKILL.md`)
- [x] 本地小服务补齐 FORK §5.7 的默认规则:
  - [x] 权限:只有执行人或交办人能标完成、取消(用前缀里的 `from` 对照任务的 `assignee_userid` / `requester_userid`)
  - [x] 连续 4 次无回应,在交办人群里通知一次,之后每小时提醒一次
  - [x] 未完成任务次日顺延并告知交办人
  - [x] 时区、工作时段、节假日配置(`config` 表:`work_start`/`work_end`/`weekdays`/`holidays`;非工作时段到点改排到下一个工作起点)
  - [x] outbox 失败重试退避(1/5/15/30/60 分钟,5 次后 failed)
- [x] 每个员工群一个 webhook,按 chatid 选用;密钥文件放 `%ProgramData%\anc\secrets\`,文件名登记在绑定表里,值不进库。(`bind set --webhook-file`,loop 按绑定选文件)
- [x] 数据库从 `%USERPROFILE%\anc\` 挪到 `%ProgramData%\anc\data\`,NTFS 只给本地小服务、公司 bot 用户和管理员。
- [x] 本地小服务常驻:`loop` 注册成开机即运行的计划任务(`LOCAL SERVICE`),失败重启;补测「没人登录时照样发」(T17 当时是推定)。(已注册 `anc-service`,每分钟一次;无人登录待补测)

**上线前必须满足**:

- [~] 公司 bot 换到专用标准用户下运行;补丁启动器与 T4 在该用户下复测。(标准用户 `anc-bot` 已建、ACL 已配;交互登录与 T4 复测待做,清单见 [OPS.md](./OPS.md))
- [x] 主机上的 WorkBuddy 关闭自动升级;补丁 hash 对不上时除了写日志,还要在运维群告警。(网络层拦 `/v2/update`;hash 不符与版本不符都发 `ops-webhook.txt`)
- [x] 开机提醒(FORK §5.1)、绑定表与数据库的离机备份。(`anc-boot-alert` 已注册;`anc-backup` 每日 02:00 本地保留 14 份并复制到第二块盘 `E:\anc-backup`;真正的离机目标待接 UNC,见 [OPS.md](./OPS.md))

**验收**:在真实的三方群里走一遍——登记、到点 @ 人、连续不回后交办人收到通知、回「完成」后停止、问「今天的任务」能列出;主机重启后没人登录,到点提醒照样发出;非执行人、非交办人说「#n 完成」被拒绝。

**验收记录(2026-10-31)**:登记/到点 @/完成/列表已在真实群跑通;「bot 进程为 0 时到点提醒照发」用停掉 WorkBuddy 的方式实测通过(见 VERIFY T17 无人登录代理);升级通知与非执行人拒绝目前只有单元测试;真机注销后的无人登录待上线窗口。

## M2 vault 与入库

**目标**:员工在群里把资料发给公司 bot 说「入库」,管理员复核后入库;两个 bot 都能按路由查到。

- [x] 两区 vault:共享区、内部区各一个独立 git 目录;共享区 SMB 只读共享,员工用主机本地共享账号读(FORK §5.4)。(已建 `D:\anc\vault-shared` / `D:\anc\vault-internal` 并各自提交;共享 `anc-vault-shared` 已开、NTFS 已加固;账号用 `scripts/provision-vault-accounts.ps1` 按名单开)
- [x] 共享区骨架:根路由、`CONTRIBUTING.md`、`company/`(简介、名单、术语、问题模型模板)。来源:上游 `anc-onboard` 的目录骨架与根路由纪律
- [x] 入库技能:改写上游 `anc-ingest` 正文;原件从 `%TEMP%\workbuddy-wecom-media\` 复制进 `inbox\pending\<id>\`,附元数据。(`light/skills/anc-ingest-company/SKILL.md`,已装到 `~/.workbuddy/skills/anc-ingest`)
- [x] 入库进程:路径规范化、base hash 拒写、原件只许新建、管理员复核、提交、`inbox\failed\` 回执(FORK §5.4 的七步)。(核心已实现:校验 + 事务写入 + 回滚,`src/ingest`;git 提交、失败回执、管理员复核交互待补)
- [x] 附件清理定时任务(`anc-cleanup`,每天 03:00,SYSTEM,清 7 天前的企微附件)
- [ ] 实测 T12(个人 bot 读网络路径)、T19(8000 字符的计数方式)、T20(长会话后规则是否还在)。(T12 只读代理已通过:标准账号读 UNC 成功、写入被拒;个人 bot 端待员工机器)

**验收**:发一份 PDF → 入库摘要回到群里 → 公司 bot 能回答其中的问题、查不到的说「尚未入库」;两个批次改同一个文件,后到的那个被拒并回执。

**验收记录(2026-10-31)**:PDF(16 页)引用 + @ 入库成功(原件 352KB 进 `_originals/`,整理稿 `collab/洞洞鞋理论.md`);问「ANC 是什么」能按库作答;问「报销制度」明确回「尚未入库」;改同一文件不带 base hash → `NEED_BASE_HASH`,错误 hash → `BASE_HASH_MISMATCH`,批次进 `failed` 并带 `reason.txt`。T19/T20 仍待长会话/员工机器。

## M3 渲染器与个人 bot 接入

**目标**:新员工入职,一小时内有自己的个人 bot 和三方群。

- [x] 渲染器:改写上游 `feat-m1-w1`,从 `roles/` × `members/` 生成公司 bot 的 `CODEBUDDY.md`、每人的接入包、群映射(FORK §5.9)。上游把这部分排在它自己的 M1(设计见 [M1-DESIGN.md](./M1-DESIGN.md) §2–§4),在本库排在 M3;名字里的「m1」都指上游,和本计划的 M1 无关。(第一切片:`src/render`,org → 公司/个人 persona + groups.json,指纹 + 长度闸门 + 原子写;见 [RENDERER.md](./RENDERER.md))
- [x] 先定:成员与群的对应以谁为真相——`members/` 的 frontmatter(FORK §5.8)还是绑定表(CHAT-BINDINGS)。两处都写会漂移,只能留一处,另一处由它生成。(定:`members/` 是真相,`chat_bindings` 由 `bind import --from groups.json` 同步)
- [x] 接入脚本(FORK §5.3);技能名片(`render onboard --package … --home …`;名片在 `light/skill-cards/`,带 `--adopt` 备份闸门与 `verify` 手改对拍)
- [x] 入职、离职 runbook(FORK §5.8)。([ONBOARDING.md](./ONBOARDING.md):入库前置、开账号、org 登记、渲染、bind import、接入、群内验收、离职六步)
- [~] 实测 T13(其他项目读不到 Claw 的 `CODEBUDDY.md`)、T18(技能名片放哪才认)。(T18 已通过:`%USERPROFILE%\.workbuddy\skills\<name>\SKILL.md` 被识别;T13 跨用户代理已验证——临时标准用户读不到 Administrator 的 persona,同用户下「另一个项目工作区」待 UI 实测)

**验收**:用第二个 Windows 用户当干净机,照接入手册从零走一遍并计时;渲染产物被手改后,下一次渲染能发现。

## M4 访谈与 A2A

**目标**:按问题模型做员工访谈,员工的个人 bot 整理本机资料,经员工转发交给公司 bot。

- [x] 访谈技能:上游 `anc-onboard` 的访谈 11 问 + 问题模型(`light/skills/anc-interview/`:11 问 + 逐题提交;问题模型沿用 `light/skills/anc-onboard/vault-templates` 的模板)
- [x] A2A v1:七字段信封、schema 校验、去重、归档到内部区、完成判定(FORK §5.6)。(`src/service/a2a.ts` + `a2a create/submit/status/list`;按 `message_id` 去重,按 `survey_id` 归档到 `vault-internal\surveys\`)
- [x] 规则冻结的规则源(`policy_version` 与内容 hash,FORK §5.5)。(`a2a create --rule-version --rule-file` 记 `rule_hash`;版本不符的提交被 `RULE_MISMATCH` 拒)
- [ ] 实测 T22(群会话会不会过期或重置)

**验收**:一场跨天的访谈完整走完,访谈报告只在内部区,问题模型里对应要素回填了证据。

**验收记录(2026-10-31)**:11 题全部归档到 `vault-internal\surveys\interview-<userid>-20261031\`(q1–q11 + 公司画像 + ANC 落地建议),`a2a status complete=true`;`company/problem-model.md` 已按访谈回填瓶颈、因果链、量化影响、相关方、已有尝试与首批立项,证据全部指向内部区。同一晚完成,未跨天;T22 待明早验证。待补:高频问题补到 3–5 类、一周耗时补到 3 件、确认是否有 ERP 可对接、一份脱敏对账样例。

## 贯穿各里程碑的运维

- [x] 主机体检、watchdog、重建 runbook(FORK §5.10)。(`scripts/doctor.ps1` 十项只读体检全 PASS;`anc-watchdog` 每 10 分钟查心跳/积压/进程;[REBUILD.md](./REBUILD.md))
- [ ] WorkBuddy 升级一律按 §11 三段回归:原版回归 → 重放补丁 → 改动后回归
- [x] 新增文件类型时同步扩 `scripts/check-public.sh`。(已覆盖 md/json/ts/mjs/cjs/ps1/sh)

## 暂不排期

- 后台长任务(依赖 T6 的结果再设计)
- 公司 bot 在员工群里放宽到不用 @(T7 已通过,可在 M1 之后评估)
- A2A 自动通道(T14)
- 入库的管理员复核何时取消
- 公司资料能否上云(FORK §9)
