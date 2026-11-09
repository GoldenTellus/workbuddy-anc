# 这个项目能做什么

> 类型：现状能力（能做什么、不做什么）

> **读者**：刚部署完、或者想知道"这东西到底能干什么"的人。
> **不是**部署手册（那是 `DEPLOY-COMPANY.md`），**不是**设计裁决（那是 `DECISIONS.md`）。
> 本文只回答两件事：**部署完有哪些能力**、**怎么用**。

---

## 0. 一句话

**一台 7×24 的 Windows 主机上跑一个「公司 bot」，每个员工电脑上跑一个「个人 bot」，两个 bot 都在企业微信的群里和员工说话；公司知识放在主机上的两个 markdown vault 里；所有"确定性的事"（任务状态、计时提醒、完成判定、消息发送）都由本地小服务决定，不交给模型猜。**

**它不做什么**：不自己实现 agent 框架（用腾讯 WorkBuddy），不写 IM 网关（用 WorkBuddy 自带的企微机器人）。

---

## 1. 三层能力视图

| 层 | 谁 | 在哪用 | 能力来源 |
|---|---|---|---|
| **① 群里的对话能力** | 员工 | 企微群里 @ bot | **8 个技能**（`light/skills/`） |
| **② 命令行能力** | 管理员 / 脚本 | 主机上 `node service\cli.ts` | **17 个命令组** |
| **③ 自动运行能力** | 没人 | 主机后台 | **10 个计划任务** |

**三层是叠加的**：技能内部调 CLI，CLI 写 SQLite，计划任务读 SQLite 并做时间驱动的事。

---

## 2. ① 群里的对话能力 —— 8 个技能

**每个技能 = 一类能被自然语言触发的动作。** 触发词由技能的 `description` 声明，模型按语义匹配（不是关键词硬匹配）。

### 2.1 `anc-task` —— 任务登记与查询

| 你能说 | 它做什么 |
|---|---|
| 「登记任务：明天 10:00 提醒我交周报」 | 写进 `tasks` 表，回「已登记 #6：2026-11-06 10:00 提醒你交周报。」 |
| 「今天有什么任务」 | 查本群的 open 任务，列出来 |
| 「我的任务」 | 同上，按你的 userid 过滤 |
| 「#6 完成了」 | 标记完成 |
| 「取消任务 #6」 | 标记取消 |
| 「让张三帮我看下报价」 | 员工走 `task request`：同部门等对方接受，跨部门先由张三部门管理者审批 |
| 「批准 #12 / 接受 #12 / 拒绝 #12，原因是…」 | 管理者审批、执行人接受、带原因拒绝 |
| 「提醒我 18:52 做 X」 | 登记带 `due_at` 的任务，到点由 `loop` 发提醒 |

**角色边界**：老板可全局派活；管理者只能本部门；员工只能给自己建任务，请同事走 `task request`。公司 bot 每轮先 `bind actor` 拿群类型和角色，不靠记忆。

**关键设计**：**任务状态在 SQLite 里，不在模型记忆里**。模型只负责"把话翻译成 CLI 调用"，状态由服务端判定。
**实测**：从注入到写库 + 回复，**49 秒**（`VERIFY §85.2`）。

### 2.2 `anc-dayend` —— 下班记录

| 你能说 | 它做什么 |
|---|---|
| 「下班」「我走了」「收工」「今天到这」「先撤了」 | 记一条 `dayend`，回「下班记下了（18:30）。」 |
| 同一天再说 | 回「今天已经记过了（18:30）。」（服务端幂等） |

**明确不做的**（技能里的硬约束）：**不总结你今天干了什么、不评价效率、不催你明天早点来**。

**不算下班的话**：「还有多久下班」（在问时间）、「我今天不来了」（是请假）、「下班前把这个弄完」（是布置任务）。

**它的真正用途是给机器看的**：全员都记了下班 → `dayend all-off` 返回 `allOff: true` → 夜间 devbot 才允许跑。

**注意**：这个技能**只给个人 bot 用**（公司 bot 是所有人共用的一个实例，不替谁记下班）。

### 2.3 `anc-feedback` —— 报问题（迭代闭环的入口）

| 你能说 | 它做什么 |
|---|---|
| 引用某条 bot 回复/某个文件 + 「这个不对 / 没按预期 / 漏了 / 应该……」 | 落成一条 `submission` 记录 |

**这是整个"自我改进"链条的起点**：
```
员工报问题 → submission → issue（规则表分诊）→ patch draft → devbot 出分支 → 人 review → 合入
```
**实测**：端到端 12 分钟（`VERIFY §27`）。

### 2.4 `anc-ingest-company` —— 资料入库

| 你能说 | 它做什么 |
|---|---|
| 「入库」「把这个存进公司库」「归档」「ingest」 | 把引用的文件/内容结构化后写进共享区 vault，带路径、hash、schema 校验 |

**关键设计**：**入库进程不调模型**，只做校验和 commit；覆盖写必须带读取时的 base hash（防止你改的时候别人也改了）。

### 2.5 `anc-vault-read` —— 查公司知识库

| 你能说 | 它做什么 |
|---|---|
| 「查一下……」「库里有吗」「公司资料」「按库答」 | 从 `D:\anc\vault-shared` 检索并回答 |

**这是"按库答"而不是"按记忆答"** —— 回答的依据来自 vault 里的 markdown，不是模型训练数据。

> **设计修正（2026-11-07）**：员工 bot 不再承担查库；员工直接在小群 @ 公司 bot。当前员工侧 `anc-vault-read` 卡片仍在，差异见 `STATUS` 的 `GAP-037` / `GAP-039`。

### 2.6 `anc-interview` —— 结构访谈

| 你能说 | 它做什么 |
|---|---|
| 「访谈」「做个访谈」「建档」 | 按固定结构问一轮问题，把回答归档到**内部区** vault |

**内部区只有公司侧能读写**，员工看不到别人的访谈记录。

### 2.7 `anc-wb-patch` —— 补丁重放（运维用）

| 触发条件 | 它做什么 |
|---|---|
| 发现 WorkBuddy 版本变化、日志出现 `INJECTED mode=anchor` 或 `ANCHOR-MISS`、`doctor` 报补丁失败 | 重放补丁 + 做回归 |

**这是唯一一个"修自己"的技能** —— 用来应对厂商升级把补丁打坏。

---

## 3. ② 命令行能力 —— 17 个命令组

**入口**：`node C:\ProgramData\anc\service\cli.ts --db <db> <组> <子命令> [参数]`

| 命令组 | 子命令 | 能做什么 |
|---|---|---|
| **`task`** | `add` `list` `get` `done` `start` `reassign` `cancel` `review` `request` `approve` `accept` `reject` | 任务生命周期 + 两阶段请求：同部门待接受，跨部门先审批；拒绝必须带原因 |
| **`executor`** | `host` `ticket` `claim` `start` `report` `notify` `end` | 主干 2 日对话/Ticket/Assignment/Report；4+1 slot 与 03:00 日切 |
| **`reminder`** | `add` `due` `sent` | 计时提醒的入队与发送记录 |
| **`outbox`** | `list` `flush` `create` `submit` `status` | 出站消息队列。**真正的发送通道**，所有提醒都经它 |
| **`submission`** | `add` `list` `set-status` | 员工报的问题（原始记录） |
| **`a2a`** | `create` `status` `submit` `list` | 结构访谈的 A2A 信封：建调查、逐题提交到内部区、查进度、列答卷。规则版本冻结后不可改 |
| **`issue`** | `draft` `list` `triage` `set-status` `close` | 问题分诊成 issue（规则表，不调模型） |
| **`patch`** | `draft` `list` `show` `prune-closed` `prune` | 补丁草稿管理 |
| **`eval`** | `run` `list` `history` | 判 devbot 产出 pass/fail |
| **`dayend`** | `add` `list` `all-off` | 下班记录 + **全员判定** |
| **`bind`** | `set` `resolve` `actor` `unbind` `list` `import` `sync-org` `verify-org` `backfill` `group-set` `group-list` `person-list` | 群/人/角色/部门真相同步。员工群兼容 `chat_bindings`，新代码优先 `people/groups/manager_scopes` |
| **`config`** | `list` `get` `set` | 运行时配置（工作时段、时区等） |
| **`summary`** | — | 汇总视图 |
| **`backup`** | — | 触发备份 |
| **`project`** | — | 项目级视图 |
| **`serve`** | — | 起服务（`anc-service` 调它） |
| **`loop`** | — | 跑一轮计时/发送（`anc-http` 定时调它） |

**`dayend all-off` 的输出长这样**（实测）：
```json
{"ok":true,"allOff":false,"roster":["管理员"],"off":[],"pending":["管理员"],"day":"2026-11-05"}
```
**注意 `allOff` 的判定**：名册为空时返回 `false`（不是"全员下班"），因为**没配员工时说"全员下班"没意义，而且会让 devbot 在没人用过的系统上半夜乱改**。

---

## 4. ③ 自动运行能力 —— 10 个计划任务

| 任务 | 频率 | 运行身份 | 干什么 | 失败时 |
|---|---|---|---|---|
| **`anc-service`** | 每日 + 开机 | LOCAL SERVICE | 主服务（状态、提醒、完成判定） | — |
| **`anc-http`** | 每日 + 开机 | LOCAL SERVICE | 定时触发 `loop` 跑一轮（发到点的提醒） | — |
| **`anc-backup`** | 每日 | LOCAL SERVICE | 数据库一致性快照（`VACUUM INTO`）+ 本地保留 + 可选离机复制 | 离机失败但本地成功 = 仍算成功 |
| **`anc-watchdog`** | 每日 | LOCAL SERVICE | 盯心跳、outbox 积压、WorkBuddy 进程；异常发运维群（带冷却） | 每 10 分钟一轮，5 项检查 |
| **`anc-boot-alert`** | 开机 | LOCAL SERVICE | 开机后检查 WorkBuddy 在不在跑，不在就告警（每 10 分钟重试，2 小时后停） | — |
| **`anc-update-watch`** | 每日 | LOCAL SERVICE | 主动查 WorkBuddy 新版（204=无新版；200=有新版，发运维群，同版本只告警一次） | — |
| **`anc-cleanup`** | 每日 | SYSTEM | 清媒体缓存 | — |
| **`anc-workbuddy-launch`** | 登录时 | Administrator | 启动 WorkBuddy（**自愈链第 1 层**） | — |
| **`anc-patch-guard`** | 每分钟（登录后） | Administrator | 看 WorkBuddy 在跑但补丁对不上 → 触发自愈（**第 2 层**） | — |
| **`anc-devbot`** | 每日 22:00 | Administrator | 夜间迭代闭环（**需满足三个条件**，见下） | — |

### 自愈链（四层，实测 55–88 秒恢复）

```
① anc-workbuddy-launch   登录时拉起
② anc-patch-guard        每分钟检查，补丁不对就触发
③ anc-selfheal           停全部 WorkBuddy → 用补丁启动器重启 → 最多重试 4 次
④ anc-watchdog           每 10 分钟兜底检查，异常告警
```

**为什么要重试 4 次**：`--inspect-brk` 注入**单次成功率约 66%**（`VERIFY §59` 实测 210 次 `env set` / 140 次 `APPLIED`）。3 次全败概率 ≈ 3.7%，4 次重试是**设计**，不是补丁坏了。

### `anc-devbot` 的三道闸（**任何一道不过就不跑**）

```
① maintenance.flag 在吗？        → 有就不跑（人工维护期）
② 时间在 22:00~06:00？           → 不在就不跑
③ dayend all-off 返回 true？     → 还有人上班且没过零点，就不跑
④ 有 status=open 的 issue？      → 没有就不跑（没活干）
```

**实测跳过时会明确说理由**：
```
WOULD SKIP
  - 当前 19:35 不在窗口内（22:00 ~ 次日 06:00）
  - 还有人在上班（管理员），且还没过零点
  - 没有 status=open 的 issue，没活干
```

---

## 5. 能力域逐项说明

### 5.1 任务与提醒

| 能力 | 怎么用 | 边界 |
|---|---|---|
| 登记任务 | 群里说「登记任务：…」 | 时间必须能被解析（`明天 10:00` / `2026-11-06 10:00`） |
| 到点提醒 | 自动，无需操作 | 提醒从**本群的 webhook** 发出，不退回默认群 |
| 查任务 | 「今天有什么任务」 | 只有本群绑定的员工的任务 |
| 完成任务 | 「#6 完成了」 | — |
| 取消任务 | 「取消任务 #6」 | — |
| 离职转交 | `task reassign --from <离职者> --to <接手人>` | 幂等，再转返回 `moved:0` |
| 逾期提醒 | 自动 | 超过 `due_at` 未完成会进逾期队列 |

**关键**：**任务状态由服务端事务保证，模型不参与"这个任务算不算完成"的判断。**

### 5.2 公司知识库（vault 两区）

| 区 | 路径 | 权限 | 放什么 |
|---|---|---|---|
| **共享区** | `D:\anc\vault-shared` | **全员只读** | 制度、模板、公共资料 |
| **内部区** | `D:\anc\vault-internal` | **只有公司侧能读写** | 访谈记录、个人定制、任务投影 |

**两个独立的 git 仓库**，原件不进 git（只在 markdown 里登记来源路径）。

| 能力 | 怎么用 |
|---|---|
| 入库 | 群里说「入库」+ 引用文件 |
| 查询 | 「查一下……」「库里有吗」 |
| 结构访谈 | 「做个访谈」→ 归档到内部区 |
| 历史与回滚 | 每区都是 git，`git log` / `git checkout` 都能用 |

**关键设计**：**覆盖写必须带读取时的 base hash** —— 你读的时候是 A 版，写的时候如果已经是 B 版，会被拒绝并要求你重读、合并、重投。

### 5.3 组织与接入

| 能力 | 怎么用 |
|---|---|
| 一个员工的全部配置 | `D:\anc\org\members\<id>.md`（`userid` / `chat_id` / `dept` / `manages` / `webhook_file`） |
| 部门 | `D:\anc\org\depts\<id>.md`（`vault_paths` / `skills` / `chat_id` / `webhook_file`） |
| 公司级字段 | `D:\anc\org\company.md`（`name` / `company_bot_name` / vault 路径 / `boss` / 公司群/`boss_dm` 配置） |
| 生成 persona + 群投影 | `render deploy --org D:\anc\org --out D:\anc\build --db C:\ProgramData\anc\data\anc.db` |
| 员工机接入 | `onboard --package <员工目录> --home %USERPROFILE%` + `verify --home %USERPROFILE%` |
| 群/人/角色同步 | `bind sync-org --org D:\anc\org`；校验 `bind verify-org --org D:\anc\org` |
| 旧库回填 | `bind backfill`（按 userid 匹配 people，不猜未知人） |

**实测时间**（`VERIFY §82`）：
```
写成员记录 0.1s / render 5.6s / bind sync-org 0.8s / onboard 0.3s / verify 0.3s = 7.5 秒
```
判据是「新员工一小时内拿到员工 bot 与员工群」——**自动化部分 7.5 秒，用了判据的 0.2%**。

**"渲染器是唯一上线路径"**：persona 和接入包只能由 `src/render` 生成，**手改线上文件视为事故**。

### 5.4 迭代闭环（自我改进）

```
员工报问题
   ↓ anc-feedback
submission（原始记录）
   ↓ issue triage（规则表分诊，不调模型）
issue
   ↓ patch draft
补丁草稿
   ↓ devbot（用 WorkBuddy 自己跑）
分支 + diff
   ↓ eval（判 pass/fail）
通过 → 人 review 合入
```

| 能力 | 命令 |
|---|---|
| 收问题 | 群里说「这个不对」（`anc-feedback`） |
| 分诊 | `issue triage` |
| 生成补丁草稿 | `patch draft` |
| 跑 devbot | `scripts/devbot/devbot.ps1`（切 persona → 注入 issue → 等 → 检查 → 恢复） |
| 端到端 | `scripts/devbot/e2e-loop.ps1`（L1→L2→L3→L4→L6，12 分钟） |
| 判结果 | `eval run` / `eval list` |

**这个闭环只改技能**，不改代码 —— `PLAN` 阶段 L 的原话是「devbot 用一个现成 agent 去改技能，项目里没有 agent 框架代码」。

### 5.5 入职 / 离职

**入职 8 步**（`docs/ONBOARDING.md`）：

| # | 做什么 | 谁做 |
|---|---|---|
| 0 | 备齐：姓名 + ASCII id + 企微 userid + 员工群 + 部门 + 该群 webhook 文件 | 人 |
| 1 | 开只读共享账号（`provision-vault-accounts.ps1 -Csv team.csv`） | 人 |
| 2 | 写 `org/members/<id>.md`（`dept` / `manages`） | 人 |
| 3 | `render deploy --org --out --db` | 自动 |
| 4 | 部门群/公司群/`boss_dm` 用 `bind group-set` 配 | 自动/人 |
| 5 | 员工机装 WorkBuddy 并登录 | 员工 |
| 6 | 员工机 `onboard` + `verify` | 自动 |
| 7 | 群里验：登记任务 / 同部门请求 / 跨部门审批 / 入库 | 人 |
| 8 | 收尾：`bot: 已接入`、删 `provisioned-*.csv`、确认当晚备份 | 人 |

**离职 4 步**（`VERIFY §84`）：

| # | 步骤 | 实测 |
|---|---|---|
| 1 | `disabled: true` → **不重建 persona、不进 groups.json** | ✅ `disabled:1` 不生效（只认字符串 `true`） |
| 2 | **任务转交** `task reassign` | ✅ `moved:1`，再转 `moved:0` |
| 3 | **席位回收**（企微后台删席位） | 人做 |
| 4 | **账号删除**（企微侧） | 人做 |

### 5.6 运维与自愈

| 能力 | 命令 / 触发 | 说明 |
|---|---|---|
| 体检 | `doctor.ps1 -Root <r> -Repo <r> -Json` | **31 项检查**，`ok=True fails=0` 才算好 |
| 部署 | `deploy.ps1 -Side company [-Apply]` | 逐文件对拍 hash，任一失败整体回滚 |
| 设权限 | `set-acl.ps1 -Root <r> -Apply` | `secrets` 断继承 + 三方授权；`data` 保留继承 |
| 备份 | `backup-anc.ps1` | `VACUUM INTO` 一致性快照 |
| 重建 | `prepare-wipe.ps1 [-Apply]` | **只改名不删除**，回滚 = 去掉 `-prewipe` 后缀 |
| 自愈 | `anc-selfheal.ps1 -DryRun / -Apply` | 先 dry-run 看锚点，再决定是否重启 |
| 故障注入 | `doctor-fault-matrix.mjs` | 30/31 项已注入验证 |
| 进度台账 | `deploy-state.ps1 -Mark <step> -AsDone/-AsFailed` | **不要手改 JSON** |
| 程序化测试 | `POST 127.0.0.1:17999/emit` | 模拟"有人 @ 了 bot"，需 `test-emit.flag` |

**`prepare-wipe.ps1` 的回滚**：它把目录改名成 `*-prewipe-<时间戳>`，回滚就是把后缀去掉 + `register-tasks.ps1 -Apply` 重注册任务。

### 5.7 补丁与升级

| 能力 | 命令 | 说明 |
|---|---|---|
| 打补丁 | `launch-patched.ps1` | 启动 WorkBuddy 并注入群身份补丁 |
| 自愈 | `anc-selfheal.ps1 -Apply` | 停全部 → 重启 → 最多重试 4 次 |
| 守卫 | `anc-patch-guard`（每分钟） | 补丁对不上就触发自愈 |
| 关闭补丁 | `launch-patched.ps1 -NoPatch` | 或设环境变量 |
| 重放 | `anc-wb-patch` 技能 | 升级后重放并回归 |

**补丁做什么**：在 WorkBuddy 收到的每条群消息前加 `[anc:chat=<chatid> from=<userid>]`，让 bot 知道"这条消息来自哪个群、谁发的" —— **这是四类群身份隔离的基础**。

---

## 6. 能力边界（明确做不到的）

| 做不到 | 为什么 | 影响 |
|---|---|---|
| **同一台机器跑两个 bot** | WorkBuddy 用原生层全局互斥体（`asar` 里 `CreateMutex` 11 处），**`--user-data-dir` 绕不过** | E-1 只能标「0 成」，要真第二台机器 |
| **私聊公司 bot** | 真 1:1 还没在企微验证；当前用 `boss_dm` 私有群 fallback，不开放给全员 | 老板的私有控制台先用私有群替代 |
| **验证码 / 批量注册** | 不涉及 | — |
| **脱离企微工作** | IM 层完全依赖 WorkBuddy 的企微机器人 | — |
| **模型不犯错** | 出站约束只能靠 persona，不能确定性拦截 | `DECISIONS` §17 记过这个代价 |
| **`test-emit` 当持续对话通道** | 需要先有真实群消息（否则 409），连续注入会排队，中文会 mojibake | 复杂指令必须走真实群消息（`VERIFY §85.3`） |
| **超长会话保持一致** | 会话压缩后 persona 可能丢 | 夜间轮换必须**重建会话**（`§18`） |

---

## 7. 典型一天

```
08:30  员工在群里：「登记任务：今天 18:00 提醒我发日报」
       → bot 回「已登记 #12：2026-11-05 18:00 提醒你发日报。」

10:15  员工引用一份文件：「入库」
       → bot 结构化后写进共享区 vault，回入库摘要

14:00  员工：「这个不对，上周那个模板没了」
       → bot 记一条 submission

17:20  anc-patch-guard 发现 WorkBuddy 重启过、补丁对不上
       → 触发 anc-selfheal → 55 秒后补丁重新生效（员工无感）

18:00  loop 扫到 #12 到点 → 经本群 webhook 发出提醒，@ 该员工

18:30  员工：「下班」
       → 个人 bot 记一条 dayend，回「下班记下了（18:30）。」

22:00  anc-devbot 醒来，三道闸：
       - 在窗口内（22:00）
       - allOff=true（全员都记了下班）
       - 有 open issue（14:00 那条）
       → 跑一轮：切 persona → 改技能 → 出分支 → eval

02:00  anc-backup 做数据库快照

03:00  anc-cleanup 清媒体缓存

每 10 分钟  anc-watchdog 检查心跳 / outbox 积压 / WorkBuddy 进程
```

---

## 8. 谁知道什么（权限模型）

| 角色 | 能看 | 能改 |
|---|---|---|
| **老板** | 全公司；公司群/部门群/`boss_dm` | 全局派活、审批、停任务、改优先级 |
| **管理者** | 本部门 + 公司级 | 本部门派活/审批/改派；无独立私聊 |
| **员工** | 自己的员工群、可读的公司/部门级 | 自己的任务、`task request`、报问题、入库（共享区） |
| **公司 bot** | 四类群的消息 | 任务、提醒、入库结构化、按角色/群路由 |
| **员工 bot** | 自己那个员工群（旧实现） | 本机资料/下班记录；待主干 4 返工 |
| **入库进程** | 待入库内容 | 只做校验和 commit（**不调模型**） |

**群/人/角色的真相在 `people` / `groups` / `manager_scopes`**；`chat_bindings` 只保留为员工群兼容层。未识别/未绑定的群直接失败，不退回默认群。

---

## 9. 怎么确认这些能力真的能用

| 想验什么 | 怎么验 |
|---|---|
| 整体是否健康 | `doctor.ps1 -Repo <r>` → `ok=True fails=0` |
| 部署是否完整 | `deploy-verify.ps1 -Side company -Json` → `ok: true` |
| 补丁是否生效 | `patch-state.json` 里 `applied=true` **且那个 `pid` 还活着**（只看 `applied` 会被骗） |
| 任务链路是否通 | 群里说「登记任务：明天 10:00 提醒我交周报」→ 49 秒内应回任务号 |
| 自愈是否工作 | `anc-selfheal.ps1 -DryRun` → `hashMatches=True anchorsOk=True` |
| 备份是否做过 | `doctor` 的 `backup-freshness` 必须是 PASS（**要本地备份，不是离机副本**） |
| 单元与集成测试 | `npm test` → 202/202 |

---

## 10. 相关文档

| 想知道什么 | 读哪份 |
|---|---|
| 怎么装 | `docs/DEPLOY-COMPANY.md`（给 agent）、`docs/REBUILD.md`（手工步骤） |
| 为什么这么设计 | `docs/DECISIONS.md`（改名后是 `DECISIONS.md`） |
| 做到什么程度 | `docs/archive/history/ACCEPTANCE.md`（40 条 DoD 逐条状态） |
| 怎么验 | `docs/archive/history/VERIFY.md`（87 节实测记录） |
| 入职离职 | `docs/ONBOARDING.md` |
| 主机运维 | `docs/OPS.md`、`docs/REBUILD.md` |
| 补丁原理 | `docs/WORKBUDDY-PATCH.md` |
| 发布流程 | `docs/RELEASE-CHECKLIST.md` |
| 换机器/换 agent | `docs/archive/history/AGENT-VERIFY-HANDOFF.md` |
