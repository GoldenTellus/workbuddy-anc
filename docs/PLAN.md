# 里程碑计划

版本:2.0(2026-11-02)。取代 1.1;1.1 的 M0–M4 交付记录留在 git 历史,需要时 `git show 52e816a:docs/PLAN.md`。上游旧计划在 `git show 90e4fb2:docs/PLAN.md`。
设计依据:[FORK-DIRECTION.md](./FORK-DIRECTION.md)(D1–D18)。本文只管**顺序、判据、退出条件**。

> **2.0 改了什么**:从「对账」转为**收尾 → 硬化 → 补齐 → 收口**四段推进,前面加一段「裁决补全」把 §9 五项清空;把「验收未闭合」从清单升级成**阶段 gate**;新增「证明有效性」(doctor 自测)与「不静默失败」两条工程判据;把散在各说明书「还没做」里的设计缺口收成 11 件事（含 D19 不上云的落地）。
>
> 依据:2026-11-02 全仓通读(代码 24 个 .ts、脚本 25 个、文档 16 份)与主机实测。审计明细在本机 `_research/audit/`(不进 git),本文只引用编号(P0-x / P1-x)。

---

## 0. 读法

### 0.1 三条原则

1. **先证明,再迁移,后扩张。** 任何环境变更(迁用户、开共享、改 ACL)之前,对应的检查项必须先在 doctor 里存在**并且**能证明它会失败;否则迁移完成后无法判断是否闭合,只能靠感觉。
2. **每条设计条款都要有一条可执行验收。** 终态不是"功能做完了",是"§1 的每条 DoD 都有证据"(证据 = 群消息 ID / 日志行 / 文件 hash / 时间戳,不接受口头记录)。
3. **不许悬空。** 任何待定项、任何"以后再说",在本计划里只有两种合法状态:「有结论并实现」或「有结论并明确不做 + 理由 + 回写 FORK」。第三种状态(没结论地漂着)视为未完成。

### 0.2 与 FORK 的关系

- FORK-DIRECTION 是**设计唯一真相源**:D1–D18 + §5 组件 + §8 安全基线 + §11 台账。
- 本文是**执行顺序与验收**:每条任务标注它实现的 FORK 条款;冲突时以 FORK 为准,但**本计划允许提议修订 FORK**(阶段 A 就是干这个),修订必须回写 FORK 并在 §11 记账。
- 1.1 的 M0–M4 不再单列;仍有效的验收项已并入 R 阶段。

### 0.3 阶段与 gate

```
A  裁决补全   §9 五项 → D19–D23,清空 §9          gate: §9 为空
R  收尾       M0–M4 的尾巴 + 让证明有效           gate: R0–R6、R8 全绿
H  硬化       审计 P0/P1 十三条                   gate: 每条都有会红的测试
C  补齐       FORK 已裁决、代码没有的 11 件        gate: 全部落地或有"不做"结论
V  收口       验收矩阵 + 故障注入 + 浸泡 + 重建    gate: 六条判据全绿
```

任何 gate 未过,不进入下一阶段。**唯一例外**:标了「事件触发型」的项(厂商发版、业务方一句话)不阻塞 gate,但必须挂在台账上带负责人与触发条件。

---

## 1. 终态:设计的完成定义(DoD)

七组,共 35 条。每条都有一个 ID,验收矩阵(§6 V1)按 ID 逐条给证据。

### 1.1 形态(E)

| ID | 条款 | 来源 |
|---|---|---|
| E-1 | 一台 Windows 主机 7×24 跑公司 bot;员工电脑跑个人 bot;两边都经企业微信 | D1/D2/D4 |
| E-2 | 一人一群(本人 + 公司 bot + 个人 bot + 提醒用群机器人);私聊公司 bot 仅管理员 | D7 |
| E-3 | 两个 bot 都 @ 才回应(D8/D20:不放宽,部门群/全员群同样) | D8/D20 |
| E-4 | 主机不开自动登录;重启后人工登录恢复;开机提醒兜底 | D5 |
| E-5 | 运行身份分开:公司 bot = 专用标准用户;小服务/入库 = 不存密码低权身份;都不在管理员组 | §5.1/§8 |

### 1.2 引擎(W)

| ID | 条款 | 来源 |
|---|---|---|
| W-1 | 群身份与发送人由 D17 补丁注入;`APPLIED mode=hash` 且 canary 有 chatId | D17/§11 |
| W-2 | 自动升级被拦;版本/hash 不符有运维告警;补丁可一键关闭 | D18/§11 |
| W-3 | 每处改动都有台账(版本 + build + 目标 hash + 开关 + 回滚);无漏账 | §11 |
| W-4 | 升级回归三段(原版 → 重放 → 改动后)有脚本化的检查单 | §8/§11 |

### 1.3 知识(K)

| ID | 条款 | 来源 |
|---|---|---|
| K-1 | vault 两区各自独立 git;共享区全员只读,内部区只有公司侧 | D12/§5.4 |
| K-2 | `_originals/` 永不进 git,且**代码层面**不会把它交给 `git add` | D14 |
| K-3 | 覆盖写必须带 base hash,语义与 FORK 写的一致 | §5.4/D13 |
| K-4 | 入库只做确定性校验,不调模型;失败进 `failed/` 并回执 | D13/§5.4 |
| K-5 | 入库崩溃/断电后可自愈,无需人工删锁 | §5.4/§5.10 |
| K-6 | 内部区 markdown 是可重建投影,`reproject` 能无损重建 | §5.5 |

### 1.4 确定性(S)

| ID | 条款 | 来源 |
|---|---|---|
| S-1 | 任务/提醒/完成判定/outbox 全在 SQLite;markdown 只是投影 | D10/§5.5 |
| S-2 | 「完成」只能由服务判定,且完成与出站消息同事务 | §5.5 |
| S-3 | 提醒不经过 WorkBuddy,主机无人登录也照发 | §5.7/T17 |
| S-4 | 默认规则(首次到点、15 分钟重复、4 次升级、当天截止、次日顺延)全部可运行 | §5.7 |
| S-5 | 时区/工作时段/节假日可配置,非法值不静默兜底 | §5.7 |
| S-6 | 出站前做凭据扫描,行为与 §8 文字一致(阻断或脱敏,二选一写死) | §8 |

### 1.5 流程(P)

| ID | 条款 | 来源 |
|---|---|---|
| P-1 | 员工在群里登记任务 → 到点 @ → 不回继续 → 回「完成」即停 | 历史 M1 |
| P-2 | 发文件说「入库」→ 复核 → 入库摘要 → 能按路由**定位到文件**并给出**本地生成的摘要/路径**(正文不进模型,见 D19),查不到说「尚未入库」 | 历史 M2/D19 |
| P-3 | 新员工一小时内拿到个人 bot 与三方群;渲染器是唯一上线路径 | 历史 M3/D15 |
| P-4 | 访谈 11 问经个人 bot 整理、员工转发、公司 bot 归档到内部区 | 历史 M4/D9 |
| P-5 | A2A 通道按 A5 结论执行(自动或员工转发) | §5.6/D9 |
| P-6 | 后台长任务:按发送者隔离,异常中断进 `needs_review`,不自动重试 | §5.5 |
| P-7 | 离职:`disabled:true` → 不重建 persona、任务转交、席位回收、账号删除 | §5.8 |

### 1.6 安全(A)

| ID | 条款 | 来源 |
|---|---|---|
| A-1 | 密钥只在 `%ProgramData%\anc\secrets`,NTFS 只给服务身份与管理员 | §8 |
| A-2 | org 数据只写引用名,值不进库、不进 git、不进日志 | §8 |
| A-3 | 入站文件与网页内容按敌意处理;提交权限在入库进程 | §8/D13 |
| A-4 | 本地小服务只监听 `127.0.0.1`,请求带 token,未配 token 全拒,常量时间比较 | §5.5 |
| A-5 | 转公开检查可执行、零输出、exit 0;`_research/` 未被跟踪 | 铁律 |
| A-6 | **资料不上云**:任何 vault 正文都不作为对话内容提交给模型;只传路径/标题/结构化字段,摘要由本地脚本生成 | D19/C13 |

### 1.7 运维(O)

| ID | 条款 | 来源 |
|---|---|---|
| O-1 | 9 个计划任务齐、principal 正确、`IgnoreNew` | OPS |
| O-2 | doctor 覆盖全部关键面,且**每项都能证明会 FAIL**(自测) | §5.10/2.0 新增 |
| O-3 | watchdog 覆盖 WorkBuddy/心跳/outbox 积压,同类告警有冷却 | §5.10 |
| O-4 | 备份离机(另一块物理盘或 UNC),含 vault 与 SQLite;恢复演练过 | §5.10/REBUILD |
| O-5 | 干净机按 REBUILD 重建成功并计时 | §5.10 |
| O-6 | 日志有轮转,不无限增长;失败路径都进告警面 | 2.0 新增 |

---

## 2. 阶段 A:裁决补全(先把 §9 清空)

**为什么排第一**:§9 五项里,资料上云、放宽 @、取消复核、后台任务形态、A2A 通道全部已裁决(D19–D23),A 阶段于 2026-11-02 收口。

| # | 裁决 | 现在的事实 | 怎么定 | 规模 |
|---|---|---|---|---|
| A1 | **D19 资料不上云(已裁决 2026-11-02)** | WorkBuddy 推理在腾讯云;正文进对话即上传 | **已定:不上云。** 任何 vault 正文都不作为对话内容;摘要由本地脚本生成;落地与验收见 C13 | 已落账 |
| A2 | **D20 不放宽 @(已裁决 2026-11-02)** | T7 已过;D8 是"两个 bot 都 @ 才回应" | **已定:维持 D8,不放宽。** 公司 bot 与个人 bot 都保持 @ 才回应;部门群/全员群同样不放开;提醒文案继续写 @ 写法 | 已落账 |
| A3 | **D21 复核永久保留(已裁决 2026-11-02)** | 现在每批人工看 diff 后手提交;P0-2 让 `--commit` 本身有 bug | **已定:复核不取消。** 入库永远走"校验 → 管理员看 diff → 手动提交";`--commit` 只作为复核通过后的一次性提交命令,不设自动模式;H1/H2 仍需修好它 | 已落账 |
| A4 | **D22 后台长任务形态(已裁决 2026-11-02)** | §5.5 只写了语义,没定执行器 | **已定:执行器仍是 WorkBuddy**,任务是 SQLite 行(`kind=background`),小服务只管状态/超时/`needs_review`/不自动重试;不写调度器 | 已落账 |
| A5 | **D23 A2A 通道(已裁决 2026-11-02)** | T14 未测;本机只有公司账号,无法测"个人 bot 以员工身份发群消息" | **已定:默认走员工转发(D9)**。只读探测到客户端有 `sendReply` 系列方法,但那只证明"能回复当前 AIBot 会话";T14 在第一个员工装好个人 bot 当天实测,通则由 C4 实现自动通道,不通则员工转发写死 | 已落账 |
| A6 | 回写 FORK §9 | — | §9 五项全部移入 D19–D23 或"不做";§9 只剩真正未解的技术未知 | XS |

**gate A ✅(2026-11-02 达成)**:§9 五项裁决全部落账(D19–D23);§9 只剩非裁决类的技术未知(访谈 bot 沿用 D22 的形态、改写上游 SPEC)。下一阶段:§3 的 R0。

---

## 3. 阶段 R:收尾(当前阶段应该做的事)

**核心判断**:收尾不是"把 7 项验收跑一遍"。`doctor` 现在只查它能看到的 5/8 任务、不验运行主体、不查 secrets ACL,却全 PASS —— 在这种状态下跑验收,跑完也说不清是否闭合。所以 R 的第一件事是**让证明有效**。

### R0 让证明有效(先做,1–2 天)

| # | 动作 | 判据 |
|---|---|---|
| R0.1 | doctor 任务覆盖 9/9,并校验 `Principal.UserId` 与服务身份 | 少一个任务必须 FAIL;principal 错必须 FAIL |
| R0.2 | 新增 `secrets-acl`:secrets 目录与其下全部文件对 `Users`/`Everyone`/`Authenticated Users` 无读权限 | 当前状态跑 → 必须 FAIL(P0-1 的证明) |
| R0.3 | 新增 `deploy-layout`:`%ProgramData%\anc\{ingest,render,service,bin,patch}` 是目录、patch 目录与仓库 `scripts/workbuddy-patch` 逐文件 hash 一致 | `ingest`/`render` 是文件时必须 FAIL |
| R0.4 | `dedicated-user` 拆三查:账号存在 / 非管理员 / **WorkBuddy 进程 owner == 配置账号** | 当前状态(Administrator)跑 → 必须 FAIL |
| R0.5 | `doctor.ps1 -SelfTest`:对每项检查用夹具注入破坏(临时改 ACL、停任务、改 manifest、改名目录),断言该检查 FAIL,结束后还原 | SelfTest 全绿才算"证明有效" |

> R0 是整份计划的信任基础。没有 R0,R1 迁移完成后你只能看到"doctor 全 PASS",而它已经骗过一次。

**R0 ✅ 2026-11-02**:`doctor` 从 18 项扩到 23 项(新增 `bot-process-owner`、`secrets-acl`、`deploy-layout`,任务从 5 个扩到 8 个并校验 principal),`-SelfTest` 六条全绿。首轮实测 **5 个 FAIL**,同日已修掉两个(见下),剩 **3 个**全部属于 R1:

| FAIL | 归属 | 状态 |
|---|---|---|
| `bot-process-owner`:WorkBuddy 跑在 Administrator,期望 `anc-bot` | R1 | 待迁 |
| `task-anc-patch-guard` / `task-anc-workbuddy-launch`:principal=Administrator | R1 | 待迁 |
| `secrets-acl`:secrets 与其下文件对 `BUILTIN\Users` 可读 | P0-1 | **已修**(三步 icacls;`LOCAL SERVICE` 读探针退出码 0) |
| `deploy-layout`:`ProgramData\anc\ingest` 与 `render` 是文件 | P1-3 | **已修**(删坏文件 + `scripts/deploy.ps1 -Apply` 部署 45 个文件并逐文件对拍) |

> 副产物:`-SelfTest` 顺带证伪了一条运维命令。只做 `icacls /inheritance:r /grant ...` **不会**移除 `BUILTIN\Users`(继承 ACE 会被转成显式 ACE 留住);必须再跑 `/remove:g "BUILTIN\Users" "Everyone" "Authenticated Users" /T`。doctor 的 FIX 文案与 OPS.md 已按正确的三步写。

### R1–R8

| # | 项 | 现状 | 闭合判据 | 依赖 | 规模 |
|---|---|---|---|---|---|
| R1 | 运行身份迁到 `anc-bot` **(blocker：需人工切换用户，2026-11-02 起挂起)** | 8 个 WorkBuddy 进程 owner = Administrator;`anc-patch-guard`/`anc-workbuddy-launch` principal = Administrator | REBUILD §4 走完;`APPLIED mode=hash`;群内应答正常;`anc-cleanup -MediaDir` 参数化;R0 四项全 PASS | R0 | M |
| R2 | 真机注销后无人登录 **（依赖 R1，挂起）** | 只做过"停 WorkBuddy"代理测试 | 注销 → 到点提醒照发(记时间戳 + 群消息 ID) | R1 | S |
| R3 | 升级通知 + 非执行人拒绝 | 只有单测 | 真实群第 4 次未回应 → 交办人收到通知;非执行人说「#n 完成」被拒 | — | S |
| R4 | 跨天访谈 | 11 题一晚做完 | 跨天一场访谈完整走完,报告只在内部区 | — | S |
| R5 | 干净机计时 **（依赖 R1，挂起）** | 未做 | 第二个 Windows 用户照 ONBOARDING 从零走完,记录耗时 | R1 | M |
| R6 | T13 同用户另一工作区 | 只验跨用户 | 同用户、另一项目工作区读不到 `Claw\CODEBUDDY.md` | — | S |
| R7 | 真升级回归 | 厂商 5.9.3 | **事件触发型**:发版后按 §11 三段回归;挂台账带负责人 | 厂商 | 待触发 |
| R8 | 收尾台账统一 | 清单分散;VERIFY 18/22 | 单一清单(R0–R7),每条带证据;VERIFY 补到 22/22,未测标"未测" | 全部 | S |

**gate R（2026-11-02 调整）**：R0 ✅；**R1/R2/R5 因「需人工切换用户」挂起**并记在台账；R3/R4/R6 待真实群与 UI 验收；R7 挂触发型标记。**H 阶段不依赖这些，先推进**——硬化是纯代码与测试，不受运行身份影响；等切换窗口再回来补 R1–R2、R5。

---

## 4. 阶段 H:硬化(审计 P0/P1 → 测试与告警)

> **不依赖 R1**：以下全部是代码与测试，可在运行身份迁移挂起时推进。做完 H，等切换窗口回来补 R1–R2、R5。

每条都要求"失败会红"的测试,不接受"改好了但没测"。

| # | 条目 | 文件:行 | 动作 | 测试 |
|---|---|---|---|---|
| H1 | 原件不进 git | `ingest/cli.ts:64`、`git.ts:19` | commit 只取 `added/modified`;vault 模板落 `.gitignore: _originals/` | `originals+commit` 用例:提交后 `git ls-files _originals` 为空 |
| H2 | 失败必须非 0 | `ingest/cli.ts:68-69`、`a2a` 同型 | 任一 fail 分支 `exit 1` + `ok:false` | 断言 exit code 与 JSON |
| H3 | `base_hash` 语义定死 | `apply.ts:74,83` | 二选一:按 HEAD 取字节,或改名 `base_content_hash` 并回写 FORK | HEAD≠工作区 用例 |
| H4 | 锁自愈 | `apply.ts:127-142` | 锁写 `{pid,started_at}`;pid 不存活或超 10 分钟 → `LOCK-STALE` 接管 + 告警 | 模拟残留锁 → 第二批成功 |
| H5 | 工作时段/跨天 | `loop.ts:91-128` | 非工作时段按"当天截止"语义处理;carry 判定不依赖 `pending` | 两条跨天链用例 |
| H6 | a2a 越区 | `service/cli.ts:175-179` | `assertInsideVault` + payload ≤256 KB | 传共享区路径必须被拒 |
| H7 | 出站扫描与 §8 对齐 | `outbound-scan.ts:44-51` | 定:阻断(改 §8 文字)或脱敏发送(改代码);留 `redacted` 事件 | 命中 → 行为与文档一致 |
| H8 | check-public 可执行且只有一份实现 | ~~`scripts/check-public.sh`~~ → `scripts/check-public.mjs` | **已落地**:删 `.sh`、写 Node 版(逐文件 JS 正则,不用 git grep——POSIX ERE 的 `[\s]` 会被当字符类);加 `.gitattributes`(`*.sh eol=lf`);`*.test.ts` 白名单保留 | 干净基线零输出 exit 0;注入假 webhook(经 `git add -N`)必须命中;清理后恢复 0 |
| H9 | 唯一来源 | `ProgramData\{ingest,render}`、技能、`doctor -Repo` | 删坏文件;新增 `deploy.ps1`;技能与 doctor 改部署路径;合并两份公司 persona | 移走工作副本后入库仍可用 |
| H10 | 技能 frontmatter | `light/skills/anc-ingest-company/SKILL.md:1-6` | 说明移出 frontmatter;`org.ts` 解析器加严格断言 | PyYAML 解析通过 |
| H11 | 任务注册脚本 | `OPS.md:20` | **已落地**：`scripts/register-tasks.ps1`，9 个任务、幂等覆盖、默认 dry-run；`-BotUser`/`-BackupDestination`/`-CleanupMediaDir` 可覆盖；交互类任务在 bot 用户没有配置目录时**拒绝** `-Apply`（避免 R1 前把守卫/启动器改到未登录用户） | dry-run 输出 9 行且 principal 正确；`-Apply` 前检查用户配置目录 |
| H12 | 日志与告警面 | `anc-loop.cmd`、`loop.log` 494 KB | `--no-warnings`;按天轮转;所有 `catch` 要么重试要么告警 | 注入异常 → 告警文件有记录 |
| H13 | 测试补 6 类缺口 | 测试矩阵 | 并发/多进程、跨天链、HEAD≠工作区、originals+commit、a2a 越区、`backup.ts` | 60 → 约 85–95 项 |

**H3 / H5 / H6 ✅ 2026-11-02**(语义与越区):

| 项 | 改了什么 | 验证 |
|---|---|---|
| H3 `base_hash` 语义 | **定为「读取时工作区内容的 git blob hash」，不是 HEAD**。理由：复核窗口里工作区会领先 HEAD（上一批已写入未提交），比 HEAD 会放过覆盖未复核改动——与 D13 的复核语义相反。FORK §5.4 措辞已按此改；错误信息带「当前/传入」前 12 位便于重读 | 既有 base hash 用例（比工作区）继续通过；篡改后 hash 被拒 |
| H5 工作时段/跨天 | carry 不再被 `pending` 挡住（正常续排的任务一整天都是 pending，"次日顺延并告知"永远发不出去）；顺延目标 = 次日同一时分，非工作时段再推到工作起点；去重键改**本地日期**（原来用 UTC，北京 00:00–08:00 会算成前一天） | 新用例：昨天有 pending 提醒也能收到顺延通知、提醒重排到 10:00；同日第二次 tick 不重复告知 |
| H6 a2a 越区 | 新增 `assertInternalDir`：绝对路径 → **越区（不依赖存在性）** → 存在 → 是 git 仓库；CLI 用 `--shared` 比对；payload ≤256 KB | 新用例：相对路径 / 非 git / 共享区或其子目录都拒；超限 payload 被拒且不落库 |

**H-1 批次（H7 / H10 / H12）✅ 2026-11-02**：

| 项 | 改了什么 | 验证 |
|---|---|---|
| H7 出站扫描 | 定「命中即阻断」为终态，`FORK §8` 文字已改；脱敏文本只用于日志与诊断，不用于发送 | 既有拦截/脱敏用例继续通过 |
| H10 技能 frontmatter | `light/skills/anc-ingest-company/SKILL.md` 的说明文字移出 `---`；`org.ts` 的 frontmatter 解析遇到非 `key: value` 行**报错**而不是静默跳过 | 新用例：frontmatter 混入说明文字 → `loadOrg` 抛错；技能文件现在可被标准 YAML 解析 |
| H12 日志与告警面 | `anc-loop.cmd` 加 `--no-warnings` + 5 MB 轮转（保留 `loop.log.1`）；`loop.ts` 的 `requeueTransientFailures` 失败不再空吞，改打 `WARN` | 6 MB 夹具验证轮转片段；**实测发现任务指向 `service\anc-loop.cmd`（旧副本）而不是 `bin`**——已把 `anc-service` 的 Action 改指 `<bin>\anc-loop.cmd`、删除旧副本，tick 增量从 239 B（带 warning）降到 70 B（单行 JSON）。这正是 H9 要消除的双份 |

**H9 / H13 ✅ 2026-11-02**（gate H 收口）：

| 项 | 改了什么 | 验证 |
|---|---|---|
| H9 唯一来源 | 技能里 4 处 `E:\workbuddy-anc\...` 改成 `C:\ProgramData\anc\{ingest,patch}\...`；`setup-anc-bot.ps1` 删掉第二份补丁副本（不再复制到 `%USERPROFILE%\anc\patch`），启动命令改指部署目录；`doctor` 的 `-Repo` 默认改空、manifest 改从 `%ProgramData%\anc\patch` 读（`-Repo` 只在和仓库比对时传）；两份公司 persona 内容对齐（只剩变量差异） | `doctor` 无参数不再依赖工作副本（`secrets-in-git` 转 WARN 并提示传 `-Repo`）；带 `-Repo` 时 `deploy-layout`/`secrets-in-git` 恢复 PASS |
| H13 测试补强 | 补 `backup.ts`（快照可打开且数据一致；目标已存在时不覆盖不破坏）与「两个连接同时领取只有一个拿到」的多进程语义；跨天链/HEAD≠工作区/originals+commit/a2a 越区已在 H1–H6 落地 | `npm test` 67 → **70**，全绿 |

**H1 / H2 / H4 ✅ 2026-11-02**(数据不可逆与 7×24 单点,先做):

| 项 | 改了什么 | 验证 |
|---|---|---|
| H1 原件不进 git | `ingest/cli.ts:64` 只把 `added`/`modified` 交给 `commitVault`;`git.ts` 收到 `_originals/` 路径直接抛错(D14 的代码级守卫) | 新用例:vault 带 `.gitignore: _originals/` 时正常提交,`git ls-files _originals` 为空,磁盘上原件仍在 |
| H2 失败必须非 0 | `commit 失败` 从"只记 `commit_error` 仍 `ok:true`"改成 `exit 1` + `ok:false` + `code=COMMIT_FAILED`,并说明"文件已写入、批次已归档、需人工提交" | 实测:对非 git 目录 `--commit` → `EXIT=1`,`ok:false`,文件确已写入(部分成功语义清楚) |
| H4 锁自愈 | 锁文件写 `{pid, started_at}`;`pid` 不存在或年龄 >10 分钟 → 接管,旧锁改名 `.stale-<ts>` 留档并打 `WARN`;解析不了的锁按占用处理(fail-closed) | 新用例:死 pid 的锁被接管后入库成功;活锁仍 `VAULT_BUSY` |

---

## 5. 阶段 C:补齐(FORK 已裁决、代码没有的 11 件)

| # | 缺口 | 来源 | 验收 | 依赖 | 规模 |
|---|---|---|---|---|---|
| C1 | HTTP 接口 + token + 存活探测 | §5.5 / LOCAL-SERVICE:100 | **已落地（2026-11-02）**：`src/service/http.ts` + `cli serve`，只监听 `127.0.0.1:17891`；未配 token 业务路由 503（fail-closed）、缺 401、错 403；`/__anc_health` 免 token；第 9 个任务 `anc-http`（LOCAL SERVICE，常驻）；doctor 加 `http-health`、watchdog 加探测 | `http.test.ts` 4 项；实机 health/401/403/200 实测 | M |
| C2 | vault 投影 + `reproject` | §5.5 / INGEST:80 | **已落地（2026-11-02）**：`src/service/project.ts`；内部区 `collab/tasks.md` 由库单向生成（**不含时间戳**，同库状态生成同字节），原子写；`project` / `--check` / `--rebuild`；配了 `vault_internal` 时 loop 每次 tick 顺手更新，失败只留 WARN；生产内部区 `.gitignore` 已排除该文件（派生数据，可从库重建） | 新用例 2 项（幂等、缺失/手改/库变三种 stale）；实机：生成 8 行 → check true → 手改后 false+exit1 → rebuild true | M |
| C3 | 后台任务 + `needs_review` | §5.5 / D22 | **已落地（2026-11-02）**：`tasks.kind/started_at/timeout_minutes` 三列（迁移加列）；`task add --kind background --timeout` + `task start`（重复 start 直接拒，刷新时间会掩盖卡住）+ tick 超时转 `needs_review` 并通知交办人（事件只记一次）+ `task review --decision retry|close` 才离开该状态；**不自动重试** | 新用例 2 项（超时→needs_review→不自动重试→retry 清 started_at；简单任务不能 start、重复 start 被拒）；实机：add→start→回拨 2 小时→tick（enqueued 1, needs_review）→retry 回 open | L |
| C4 | A2A 自动通道 | §5.6 / D23 | 若 T14 通:个人 bot 发群消息 → 自动归档;不通:员工转发写死 | A5 | L |
| C5 | 技能同步 T15 | §7 | 测通才做;不通则"技能只走名片 + vault"写死 | — | M |
| C6 | 真离机备份 | §5.10 / REBUILD §6 | **代码已落地（2026-11-02），物理上未成立**：脚本会比对两边 `DiskNumber`，同盘就发运维告警（只报一次）；失败必告警；离机保留日档 60 + 每月 1 号 12 份；`doctor` 新增 `backup-freshness`（超 30 小时 FAIL）。**卡点：本机 `E:` 与 `C:` 都在 Disk 0，「离机」还只是同盘拷贝** | 同盘告警实测触发、去重生效、`backup-freshness` PASS；待接独立盘或 UNC 后重跑一次 | M |
| C7 | 离职自动化 | §5.8 | **已落地（2026-11-02）**：`org.Member.disabled`（只认字符串 `true`，写 `1`/`yes` 不生效）；渲染跳过停用成员、**清掉其 persona 产物**、`groups.json` 不再含他（否则 `bind import` 会重建绑定）；`task reassign --from/--to/--to-name` 转交 open 任务并记 `reassigned` 事件；`scripts/offboard-member.ps1` 串起四步（重渲染 / 转交 / 解绑 / 可选删账号），默认 dry-run、前置校验 org 里已标 `disabled: true`、**不删 vault 数据**（D21） | 新用例 3 项（停用后产物清掉且 groups 排除、`disabled: 1` 不算停用、转交只动 open 且记事件）；临时 org 跑通 dry-run 三步 | M |
| C8 | 员工共享账号 | OPS:76 | **脚本侧已落地（2026-11-02）**：`provision-vault-accounts.ps1` 补两件——给 `anc-vault-readers` 授共享区 `RX`、把组 SID 写进 `SeDenyInteractiveLogonRight`（`secedit` 导出→改→导入，Deny 优先于 Users 的 Allow）；新增 `verify-vault-accounts.ps1` 验收读通 / 写拒 / 非管理员 / 拒绝登录，出 `accounts\verify-<时间>.json` 当上线证据。**真机验收待测试账号**（当前组与账号都不存在） | 前置检查实测：无组时报 ERROR 并给 FIX；`-DryRun` 输出两个待建账号 | S |
| C9 | 渲染器 `rollback` + 部署脚本 | RENDERER:95 | **已落地（2026-11-02）**：`deployOrg` 做整组事务——快照 → 渲染 → 逐产物读回对拍 → 任一失败**整体还原**（`writeAtomic` 只管单文件原子，渲染是一组文件，中途失败会留“一半新一半旧”）；`rollbackOutDir` 把每个文件最新的 `.bak-<stamp>` 还原，支持 `--dry-run`；CLI 加 `deploy` / `rollback` | 新用例 4 项（对拍通过、失败整体回滚不留半套、dry-run 不动文件、无备份不抛错）；`npm test` 全绿 | S |
| C10 | 配置化 | §5.7 / `config.ts:116`(isWorkTime 用系统本地时间) | **已落地（2026-11-02）**：新增 `timezone`（只收 Windows 时区 Id，`Asia/Shanghai` 这类 IANA 名会被拒并提示对照）与 `vault_internal`/`vault_shared`（绝对路径校验）；doctor 的时区检查改成「与配置比，不一致 = FAIL」，未配置时按设计默认给 WARN | 非法值实测被拒（IANA 名、相对路径）；doctor `timezone PASS` | S |
| C13 | 不上云的落地 | D19 / §8 | **部分落地（2026-11-02）**：persona 与 `anc-ingest` 技能已写死「只报路径与标题」；审计层上线——`src/shared/audit.ts` + 两个 CLI 的 exit 钩子，每次调用写 `%ProgramData%\anc\data\audit.log`（JSONL，只记命令与目标，不记参数值）；doctor 新增 `vault-ingest-audit`（vault 有未跟踪文件但 1 小时内无成功 ingest 记录 → WARN，**这就是绕过 CLI 的证据**）。待补：查库/问答路径的拒答计数（依赖 C4/C5 定形），以及"摘要由本地脚本生成"还没做 | 审计 3 项单测；实机 `EXIT_1/EXIT_2` 都留痕；doctor 当场抓到当前的 2 个未跟踪文件无入库记录 | M |

**gate C**:11 件全部落地,或带"不做 + 理由"回写 FORK;不存在第三种状态。（原 C11/C12 已按 D21/D20 移入 §8「不做的事」）

**2026-11-02 实测新增的两条待办（随 R1 一起做，已登记 FORK §11）**：

| 项 | 实测结论 | 待办 |
|---|---|---|
| T21 出站旁白 | 多步工具链会漏 6–15 段过程话；persona 禁止词表**无效** | 包 `sendReply` 做段落过滤（不碰 `sendStreamChunk`） |
| bot 直写 vault | 批次失败后 bot 把文件直接复制进 `collab/` 与 `_originals/`，绕过全部校验 | 权限隔离：vault 对 bot 只读，bot 只写 `inbox`，入库由服务侧执行（需新裁决） |

---

## 6. 阶段 V:收口(六条判据,全部可测)

| # | 判据 | 怎么测 | 通过线 |
|---|---|---|---|
| V1 | **验收矩阵 100%** | §1 的 35 条 × 证据(群消息 ID / 日志行 / hash / 时间戳) | 35/35,每条有证据路径 |
| V2 | **不静默失败** | 静态扫所有 `catch`;对每条 fail 分支注入 | 无 `catch` 空吞;`ok:true` 与实际一致 |
| V3 | **五类故障自恢复** | 断电 / 杀进程 / 磁盘满 / 时钟跳变 / webhook 404 | 恢复后无需人工删锁/改库;各留一份恢复日志 |
| V4 | **证明有效** | `doctor -SelfTest` + 三项抽查(ACL/任务/manifest) | 全绿;抽查的 FAIL 与自测一致 |
| V5 | **7×24 浸泡** | 连续 7 天不干预,每天记:outbox 对账、告警条数、doctor 快照 | 0 人工干预、0 丢消息、0 误报告警 |
| V6 | **可重建 + 可转公开** | 干净机 REBUILD 计时;`check-public.mjs` | 重建 ≤ 记录基线;检查零输出 exit 0 |

**gate V**:六条全绿 → 打 tag `v1.0`,FORK 与 PLAN 一起冻结为"已验收版本"。

---

## 7. 时间与规模(按 1 人全职估)

| 阶段 | 规模 | 关键路径 |
|---|---|---|
| A 裁决补全 | 2–3 天(含 T14 半天) | A5 等业务方一句话 |
| R 收尾 | 6–8 天 | R0 → R1 → R2/R5 |
| H 硬化 | 8–10 天 | H1/H3/H4 是数据不可逆,先做 |
| C 补齐 | 11–14 天 | C3、C4、C13 是重点 |
| V 收口 | 8 天 + 7 天浸泡 | 浸泡与开发可部分并行 |
| **合计** | **约 8 周**(不含业务方等待与厂商发版) | |

---

## 8. 不做的事(写死,防范围蔓延)

- 自研 agent、自研 IM 网关(归 WorkBuddy);
- 靠 WorkBuddy 官方 IM 读取工具拿群身份(服务端拒绝,D18 已结案);
- 把模型塞进确定性链路(状态/计时/判定/出站);
- 敌意多租户隔离(§8 信任模型:一个部署 = 一个互信公司);
- macOS / Linux 移植;
- 任何"先上线再补证明"的路径;
- 放宽 @(D20:两个 bot 都 @ 才回应,不分群类型);
- 取消入库复核(D21:每批仍人工看 diff 后提交)。

---

## 9. 与 1.1 的差异

| 维度 | 1.1 | 2.0 |
|---|---|---|
| 定位 | M0–M4 对账 | 收尾 → 硬化 → 补齐 → 收口 |
| 前置 | 无 | 阶段 A:§9 五项清空 |
| 验收未闭合 | 7 项清单 | 变成 R 的 gate,含 R0"让证明有效" |
| 假绿 | 未处理 | 明确列为 R0,doctor 必须能自证 FAIL |
| 审计发现 | 未纳入 | 阶段 H 13 条,每条带测试 |
| 设计缺口 | 散在各说明书"还没做" | 阶段 C 11 件,全部有验收 |
| 无 bug 定义 | 无 | V 段六条可测判据 |
| 事件触发项 | 混在验收里 | 单列(R7),不阻塞 gate |

---

## 10. 风险登记(新增)

| 风险 | 等级 | 对策 |
|---|---|---|
| §9 全纳入后范围膨胀,PLAN 变成愿望清单 | 高 | A 阶段先把五项定成裁决;此后任何新需求进 backlog,不插队 C 阶段 |
| R0 自测本身写错,给出新的假绿 | 中 | 自测夹具必须来自真实故障(改 ACL/停任务/改 manifest),不接受 mock |
| R1 迁移期间 bot 离线,提醒中断 | 中 | 先放 `maintenance.flag`,迁完清;迁移窗口选非工作时段 |
| H3 改 `base_hash` 语义会推翻已入库批次的理解 | 中 | 只改代码 + 回写 FORK,不迁移历史数据;文档标注"语义以 2.0 起为准" |
| A5 无结论导致 C 阶段卡住 | 中 | 默认按最保守执行(内部区不上云),允许后续修订 |
| 7 天浸泡期间出现一次告警,判定标准被稀释 | 中 | 告警分类:真故障 vs 已知噪音;噪音必须在 H12 清完 |
| 厂商升级正好落在 C 阶段,补丁失配 | 中 | R7 台账提前挂触发条件;升级窗口冻结 C 阶段变更 |

---

## 附:本计划与审计的对应

| 审计编号 | 计划位置 |
|---|---|
| P0-1 secrets ACL | R0.2(先补证明)、随后按 §8 收紧 |
| P0-2 commit 原件 | H1 + K-2 + A4 前置 |
| P0-3 锁无失效 | H4 + K-5 + A4 前置 |
| P0-4 base_hash 语义 | H3 |
| P0-5 check-public CRLF | H8 + A-5 |
| P0-6 运行身份 / doctor 盲区 | R0.1–R0.4 + R1 |
| P1-1 工作时段跨天 | H5 + S-4 |
| P1-2 a2a 越区 | H6 |
| P1-3 部署布局坏 | R0.3 + H9 |
| P1-4 工作副本依赖 | H9 |
| P1-5 技能 frontmatter | H10 |
| P1-6 出站扫描语义 | H7 + S-6 |
| P1-7 失败仍 exit 0 | H2 + V2 |
| P1-8 无任务注册脚本 | H11 + O-1 |
| P1-9 第二份补丁副本 | H9 |
| P1-10 文档硬冲突 | R8 + V6 |
| P2 十二条 | C 阶段各条 + V6 |
