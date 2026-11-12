# 员工侧部署手册（给 agent 读）

> 类型：运维手册（员工侧部署）

> **零起点先读 ../BOOTSTRAP.md 四步；访谈走 `deploy-kickoff.ps1`，逐节手工命令仅作对照。**

> **2026-11-12 修正（主干 4）**：员工 bot **不读公司主机上的库**；公司资料/公司任务由主人在员工群 @ 公司 bot。员工侧不再从公司侧同步 `render/groups.json` / `org/company.md` / persona；安装人访谈回答字段后，由 `scripts\deploy\employee-bootstrap.ps1` 本地生成 persona。员工侧技能最小集为 `anc-dayend、anc-feedback、anc-update`，不装 `anc-vault-read` / `anc-executor` / `anc-ingest`。

> **设计修正（2026-11-07）**：目标设计要求员工侧也打补丁，用于 handoff 时识别资料归属；当前部署步骤仍按“员工侧不装补丁”执行，差异见 `STATUS` 的 `GAP-038`。`GAP-038` 关闭前以本文当前步骤为准，不要把目标当成现状。

> **这份文档的读者是 agent，不是人。**
>
> 如果你是人：把仓库链接发给这台电脑上的 agent，让它自己读这份文档。
>
> 如果你是 agent：按顺序做。每节有「做什么 / 成功判据 / 失败了怎么办」。
> 每做完一节调一次 `deploy-state.ps1 -Side employee -Mark <节id> -AsDone`。

---

## 目录

| 节 | id | 内容 | 耗时 |
|---|---|---|---|
| [0](#0-你要装出什么) | — | 装完是什么样 | 读 1 分钟 |
| [1](#1-brief-与-answers先访谈再收信息) | `brief` `answers` | **访谈：递清单 → 收信息 → 校验** | 5 分钟 + 等人 |
| [2](#2-preflight前置检查) | `preflight` | 前置检查 | 10 秒 |
| [3](#3-workbuddy确认-workbuddy-已登录) | `workbuddy` | 确认 WorkBuddy 在 | 1 分钟 |
| [4](#4-files部署运行件) | `files` | 部署运行件 | 30 秒 |
| [5](#5-skills装技能) | `skills` | 装员工侧最小集 3 个技能 | 10 秒 |
| [5.5](#55-本地生成个人-persona2026-11-12-修正取代公司侧同步) | `sync` | **本地生成个人 persona** | 1 分钟 |
| [6](#6-persona部署个人-persona) | `persona` | 部署个人 persona | 1 分钟 |
| [7](#7-bind绑定本人的群) | `bind` | 绑定群 | 1 分钟 |
| [8](#8-verify自证) | `verify` | 自证 | 30 秒 |
| [9](#9-装到一半失败怎么办) | — | 断点续装 | — |
| [10](#10-卸载) | — | 回滚 | — |
| [11](#11-升级不重装不丢数据) | — | **升级不重装**（保留数据） | 1–2 分钟 |

---

## 0. 员工侧装出什么

**整个部署分三段，不是一口气 8 步**：

1. **brief** — 先把「人要做的事」清单递给他（§1.2）
2. **answers** — 再把只有他知道的信息一次问全并校验（§1.3 / §1.4）
3. **执行** — 从 §2 起连续跑完 8 个技术阶段

**这是员工自己那台办公电脑，不是主机。**

装完的状态：

- **个人 bot 在这台电脑上跑，只服务本人**
- **不读公司主机上的库**；公司资料/公司任务由主人在员工群 @ 公司 bot
- **能整理本机资料、写草稿，需要入库的资料由主人转给公司 bot**

**你不做的事**：

- **不装服务**（不注册计划任务、不开 HTTP 面、不建 vault）——那是公司侧的事
- **不装补丁**——个人 bot 不需要群身份注入；它只在私聊和「本人+公司bot」的群里工作
- **不碰 `C:\ProgramData\anc`**——那是主机的东西，员工机上没有

**员工侧用的是 `%LOCALAPPDATA%\anc`**（不是 `%ProgramData%`）。这是故意的：个人电脑上不该有 ProgramData 级别的写入。

---

## 1. brief 与 answers：先访谈，再收信息

**填不全就别往下做。** 但顺序改成：先递清单（人去做准备）→ 再收信息（一次问全）→ 校验齐了才开装。

### 1.1 第一问：这台电脑是谁的

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\deploy-kickoff.ps1 -Phase identity
```

员工侧通常落在两个选项上：

| 他的回答 | side | 意味着 |
|---|---|---|
| 我是员工，装自己的办公电脑 | `employee` | 只要不是共用电脑就能装 |
| 我在帮同事装 | `employee` | **memberId / userid / chatId 必须问本人**，不能从产物猜 |

### 1.2 把准备清单递给他

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\deploy-kickoff.ps1 -Phase prepare -Side employee
```

五项：确认不是共用电脑、确认 WorkBuddy 已登录、抄员工群 chatId、拿到本人 userid、问清公司名/公司 bot 名/部门（不再问公司共享区）。每项都带「怎么算做好了」。

### 1.3 员工侧收信息

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\deploy-kickoff.ps1 -Phase collect -Side employee -Json
```

必填三项：`employee.memberId`、`employee.userid`、`employee.chatId`；建议同时提供 `name`、`companyName`、`companyBotName`、`deptId`/`deptName`、`localWorkdir`。**不再需要共享区 / vault 路径。**

答案写进 **`%LOCALAPPDATA%\anc\data\deploy-answers.json`**。**必须是嵌套的 `employee` 对象，扁平点号键不认**（2026-11-11 员工机实测：`.` 开头的 key 会被判“employee 整段缺失”）：

```json
{
  "side": "employee",
  "employee": {
    "memberId": "guoshuai",
    "name": "郭帅",
    "userid": "guoshuai",
    "chatId": "<32 字符员工群 chatId>",
    "companyName": "新未来智能",
    "companyBotName": "公司bot",
    "deptId": "dnt",
    "deptName": "新未来智能",
    "localWorkdir": "C:\\Users\\<用户>\\WorkBuddy\\Claw"
  }
}
```

### 1.4 校验

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\deploy-kickoff.ps1 -Phase check -Side employee
# ok=true 才继续
```

`ok=true` 通过后，把访谈两阶段记账：

```powershell
powershell -File scripts\deploy\deploy-state.ps1 -Side employee -Mark brief -AsDone
powershell -File scripts\deploy\deploy-state.ps1 -Side employee -Mark answers -AsDone
```

### 1.5 字段对照与「问不到时的规矩」

下面这张表是 §1.3 问题集的人类可读版。**这些值只有人知道**，实际收集以脚本输出的 `questions` 为准。

> **问不到时的规矩（2026-11-12 修正）**
>
> 员工侧不再有公司侧 `render\groups.json` / `org\company.md` 可读；所有身份字段都**必须问安装人**，不能从公司产物猜。
> 拿不到 `memberId / userid / chatId` 时唯一的正确动作是停下来问。

| # | 要什么 | 用在哪 | 怎么来的 | 填这里 |
|---|---|---|---|---|
| 1 | **这台电脑是你自己的吗**（不是共用的） | 前提 | 问人 | ☐ 是 / ☐ 不是 |
| 2 | **你的企微 userid** | persona 认主人 | 企微通讯录；**不是**姓名、**不是**手机号 | `________________` |
| 3 | **你的员工群 chatId**（32 字符） | 绑定 | 群里 → 群设置；**不要截断** | `________________` |
| 4 | **公司名 / 公司 bot 名** | persona 说明你与公司 bot 的关系 | 问公司侧 | `________________` |
| 5 | **你在哪个部门** | persona 里写；只影响本机技能/范围 | 问公司侧 | `________________` |
| 6 | **本机工作目录**（默认 `%USERPROFILE%\WorkBuddy\Claw`） | persona 里写 | 一般不用改 | `________________` |
| 7 | **本机成员 id**（如 guoshuai） | 本地 persona/记录 | 安装人给；不要用姓名猜 | `________________` |

**缺的时候**：

- **2、3、7 缺** → 停下来问。persona 认不出主人，个人 bot 会「听所有人的话」——这是安全问题。
- **4、5 缺** → 可先按默认「公司 / 公司bot / 未分部门」生成，但要在报告里标出，让安装人补。
- **1 是「不是」** → **停下来**。共用电脑上装个人 bot 会让别人也能用你的身份。
- **不再需要公司共享区 / vault 路径**；员工 bot 不读公司库。

---

## 2. preflight（前置检查）

> **员工侧不需要管理员权限。** preflight 会先给这台机器出画像（`facts.machineProfile`），但员工侧即使 agent 是普通权限也只 **WARN 一条**、不拦——因为写的是你自己的 `%LOCALAPPDATA%\anc` 和 `%USERPROFILE%\.workbuddy\skills`。
>
> 顺带会查两件跟你有关的事：**这台机器有几个用户配置目录**（≥3 会提醒"确认不是共用电脑"），以及**登录账号是不是内置 Administrator**（是则提示：共享身份，多机无法归因）。

**做什么**：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\preflight.ps1 -Side employee -Json
```

**成功判据**：`"ok": true`。

**员工侧和公司侧的区别**（preflight 自己会处理，这里说明为什么）：

| 项 | 公司侧 | 员工侧 |
|---|---|---|
| 管理员权限 | **必需**（注册任务、写 ProgramData） | **不要求**（只写 `%LOCALAPPDATA%`） |
| 部署根 | `%ProgramData%\anc` | **`%LOCALAPPDATA%\anc`** |
| vault 盘 | 必需 | 不检查（员工读网络路径） |
| 计划任务 | 检查已有几个 | 不检查 |

**有 blocker 时**：看 `next`。常见的和公司侧一样（node / git / 版本 / workbuddy）。

**装完**：

```powershell
powershell -File scripts\deploy\deploy-state.ps1 -Side employee -Mark preflight -AsDone
```

---

## 3. workbuddy（确认 WorkBuddy 已登录）

**为什么员工侧不用"装"**：员工本来就在用 WorkBuddy，它已经装好了。

**做什么**：只确认三件事。

```powershell
# ① exe 在
$wb = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\WorkBuddy\WorkBuddy.exe'),
  (Join-Path $env:ProgramFiles 'WorkBuddy\WorkBuddy.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $wb) { throw 'WorkBuddy 没装——先装它再回来' }

# ② 登录过
# 注意：这一条**只是目录存在性检查**，不是真的登录判据。
# 目录在 = 启动过至少一次；真登录要看能不能收到企微消息（§8 的 bot-online/bot-reply）。
if (-not (Test-Path (Join-Path $env:USERPROFILE 'WorkBuddy'))) { throw 'WorkBuddy 装了但没启动过' }

# ③ 进程在
if (-not (Get-Process -Name 'WorkBuddy' -ErrorAction SilentlyContinue)) {
  throw 'WorkBuddy 没在跑——让用户启动它'
}
```

**成功判据**：三条都不抛。

**失败了怎么办**：

- **没装** → 让用户装，装完回来重跑本检查
- **没登录** → 让用户启动并登录企微
- **进程不在** → 启动它。**注意**：装完 §6 的 persona 之后**必须重启 WorkBuddy 才生效**（persona 是每会话首次注入时读一次，`VERIFY §18`）

**装完**：

```powershell
powershell -File scripts\deploy\deploy-state.ps1 -Side employee -Mark workbuddy -AsDone
```

---

## 4. files（部署运行件）

**做什么**：

```powershell
# dry-run
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\deploy.ps1 -Side employee

# 落盘
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\deploy.ps1 -Side employee -Apply
```

**注意 `-Side employee`**：它让部署根变成 `%LOCALAPPDATA%\anc`，而不是 `%ProgramData%\anc`。

**部署根不用手工建**（2026-11-10 修）：`%LOCALAPPDATA%\anc` 不存在时，dry-run 只提示「-Apply 时会创建」，`-Apply` 会自己建。以前这里一律报「部署根不存在」，而员工侧手册从头到尾没有建目录的步骤，新机器第一次装必然卡在 files 这一步。公司侧仍要求先建（那边要预设 ACL / vault 盘）。

**成功判据**：退出码 0，且：

```powershell
$db = "$env:LOCALAPPDATA\anc\data\anc.db"
node --no-warnings "$env:LOCALAPPDATA\anc\service\cli.ts" --db $db

# 期望最后两行提示：
#   ERROR 缺少命令组（…）
#   FIX   看 docs/LOCAL-SERVICE.md
# 退出码 2 —— 这是用法提示，不是故障。
#
# 三条硬要求：
#  1. 必须带 --db。不带的话 cli 用默认库 %ProgramData%\anc\data\anc.db，
#     员工侧就会建出公司侧的目录 —— 违反 §0「不碰 ProgramData」和 §2「只写 LOCALAPPDATA」。
#  2. 不要加 2>&1。PS 5.1 会把 node 的 stderr 变成 NativeCommandError，
#     中文还会按默认代码页乱码，你会把一条正常提示当成故障。
#  3. 这条命令**顺便建库**：cli 在检查命令组之前就 openDb($db)，跑完 data\anc.db 就存在了。
#     §8 的 database 检查靠的就是它 —— 手册没有别的建库步骤，不要去找。
# 期望 "ERROR 缺少命令组（...）" —— 这是用法提示，不是故障
```

**失败了怎么办**：同公司侧 §5（文件占用 / 磁盘满 / 映射漏文件），看 `ERROR` 和 `FIX`。

**回滚**：

```powershell
# 注意：deploy.ps1 没有 -Rollback 参数（param 只有 -Side / -Root / -Apply），
# 照抄会报 NamedParameterNotFound。-Rollback 是 deploy-skills.ps1 的参数，别混用。
#
# deploy.ps1 落盘前自己在 backup\ 下留了完整副本，回滚就是把它拷回去：
$root = "$env:LOCALAPPDATA\anc"
$bak  = Get-ChildItem "$root\backup" -Directory | Sort-Object Name -Descending | Select-Object -First 1
if (-not $bak) { throw "没有 backup 目录，无从回滚" }
"这次回滚会用: $($bak.FullName)"
# 确认是那一次之后，再执行：
#   Copy-Item "$($bak.FullName)\*" $root -Recurse -Force
#
# 技能单独回滚（这个才有 -Rollback）：
powershell -File scripts\deploy\deploy-skills.ps1 -Rollback
```

**装完**：

```powershell
powershell -File scripts\deploy\deploy-state.ps1 -Side employee -Mark files -AsDone
```

---

## 5. skills（装技能）

**做什么**：

```powershell
# 预检（只比对，不写）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\deploy-skills.ps1 -Side employee

# 落盘（员工侧最小集；-RemoveExtra 会清掉旧的 9 技能残留）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\deploy-skills.ps1 -Apply -Side employee -RemoveExtra
```

**成功判据**：员工侧技能只有 3 个：

```powershell
@(Get-ChildItem (Join-Path $env:USERPROFILE '.workbuddy\skills') -Directory |
    Where-Object { Test-Path (Join-Path $_.FullName 'SKILL.md') }).Name
# 期望：anc-dayend / anc-feedback / anc-update
```

**员工侧和公司侧的区别**：员工侧不装 `anc-vault-read`、`anc-executor`、`anc-ingest`、`anc-interview`、`anc-task`、`anc-wb-patch`；公司侧仍装全量 9 个。由 `deploy-skills.ps1 -Side employee` 做物理过滤。

**失败了怎么办**：同公司侧 §6。

**装完**：

```powershell
powershell -File scripts\deploy\deploy-state.ps1 -Side employee -Mark skills -AsDone
```

---

## 5.5 本地生成个人 persona（2026-11-12 修正，取代公司侧同步）

> **主干 4 修正**：员工 bot **不读公司主机上的库**；公司资料/公司任务由主人在员工群 @ 公司 bot。
> 员工侧不再需要从公司侧同步 `render/groups.json`、`org/company.md`、`render/members/<id>/CODEBUDDY.md`。
> 旧 §5.5 的“公司共享 / 公司只读共享”流程作废；员工侧只依赖安装人访谈回答 + GitHub 代码。

安装人需要回答这些字段（写进 `%LOCALAPPDATA%\anc\data\deploy-answers.json` 的嵌套 `employee`）：

```json
{
  "side": "employee",
  "employee": {
    "memberId": "guoshuai",
    "name": "郭帅",
    "userid": "guoshuai",
    "chatId": "<32 字符员工群 chatId>",
    "companyName": "新未来智能",
    "companyBotName": "公司bot",
    "deptId": "dnt",
    "deptName": "新未来智能",
    "localWorkdir": "C:\\Users\\<用户>\\WorkBuddy\\Claw"
  }
}
```

然后在仓库根运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\employee-bootstrap.ps1 -Repo <仓库根> -Apply
```

它会：

- 用 `light\templates\member-bot.md` 在本地生成个人 persona；
- 写到 `%LOCALAPPDATA%\anc\render\members\<memberId>\CODEBUDDY.md`；
- 备份旧文件后覆盖 `%USERPROFILE%\WorkBuddy\Claw\CODEBUDDY.md`；
- 员工侧最小技能集为 `anc-dayend、anc-feedback、anc-update`，不装 `anc-vault-read`。

**不需要**公司共享、`anc-share`、`render/groups.json`、`org/company.md`。员工 bot 不知道公司库路径，这是预期。

装完记账：

```powershell
powershell -File scripts\deploy\deploy-state.ps1 -Side employee -Mark persona -AsDone
```

## 6. persona 生效与重启

`employee-bootstrap.ps1` 只写文件；WorkBuddy 在**新会话/重启**后才读取 `CODEBUDDY.md`。

- 若安装 agent 不在 WorkBuddy 内：重启 WorkBuddy；
- 若在 WorkBuddy 内：写 `%LOCALAPPDATA%\anc\data\pending-persona-reload.json`，让用户在桌面重启，不要杀自己。
- 成功判据：`CODEBUDDY.md` 存在、包含“不读公司”“公司 bot”引导，且不再出现 `vault_shared` / `anc-vault-read`。
## 7. bind（绑定本人的群）

**做什么**：把「你的群 chatId」和「你的身份」登记到本地库，这样个人 bot 知道哪条消息来自你的群。

```powershell
$Root = Join-Path $env:LOCALAPPDATA 'anc'
$cli = "$Root\service\cli.ts"
$db = "$Root\data\anc.db"

node --no-warnings $cli --db $db --json bind set --chat-id '<§1 第 3 项>' --employee '<你的成员 id>' --userid '<§1 第 2 项>'
```

**成功判据**：

```powershell
node --no-warnings $cli --db $db --json bind list
# 应该有一条，employee / chat_id / userid 都对
```

**失败了怎么办**：

| 报错 | 意思 | 怎么做 |
|---|---|---|
| `未知 bind 子命令` | 少了 `set` | 用 `bind set --chat-id …`。`bind` 只认 `set` / `resolve` / `unbind` / `list` / `import` |
| 短 chatId **被静默接受** | **代码里没有长度校验** | `bindings.ts` 的 `clean()` 只查非空 / ≤200 字符 / 控制字符。「32 字符」是 §1 的**约定，不是校验** —— 截断值会原样写入，绑完 bot 认不出群。绑之前自己数字符 |
| 绑定成功但 bot 不认 | 补丁没装 | **员工侧不装补丁**，但个人 bot 需要 `from` 前缀才能认人。检查：WorkBuddy 里 persona 的「每轮先做的三件事」那段——如果消息里没有 `[anc:chat=... from=...]` 前缀，说明个人 bot 也没拿到群身份。**这是已知限制**，见下方说明 |

> **员工侧的身份来源**：公司 bot 靠补丁（D17）拿到群身份。个人 bot **不装补丁**——它靠 WorkBuddy 自己带的企微身份。
> **但是**：WorkBuddy 自带的消息里有没有 `from` 字段，取决于版本。`VERIFY §15` 记过企业版和个人版在这一点上行为一样。
> **如果个人 bot 认不出主人**，说明需要补丁，那就按公司侧 §7 装补丁。

**装完**：

```powershell
powershell -File scripts\deploy\deploy-state.ps1 -Side employee -Mark bind -AsDone
```

---

## 8. verify（自证）

**做什么**：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\deploy-verify.ps1 -Side employee -Json
```

**成功判据**：`"ok": true`。

**四项**（早先版本写「三项」，漏了 `database`）：

| 项 | 验什么 | 说明 |
|---|---|---|
| `database` | `data\anc.db` 存在 | 不存在 → FAIL。**由 §4 那条 `cli.ts --db` 顺带创建**，手册没有单独的建库步骤 |
| `bot-online` | WorkBuddy 进程在 | 不在就 FAIL |
| `bot-reply` | 注入一条消息 | **员工侧永远 SKIP** —— `test-emit` 是补丁提供的，而员工侧不装补丁（见下面「为什么员工侧验不了这一项」） |
| `persona` | 本地 `CODEBUDDY.md` 存在、含公司 bot 引导、不含 `vault_shared`/`anc-vault-read` | 缺 → 回去跑 §5.5 的 `employee-bootstrap.ps1` |

**SKIP 不是通过。** 有 SKIP 时告诉用户"这几项没验，原因是 X"。

**失败了怎么办**：

- **`bot-online` FAIL** → 启动 WorkBuddy
- **`persona` FAIL** → 重新运行 `employee-bootstrap.ps1 -Repo <仓库> -Apply`；员工侧不再检查 vault-read
- **`bot-reply` SKIP** → **员工侧这是正常的，不是故障。**
  **员工侧不读公司库**，所以没有 `vault-read` 这一项；公司知识请员工在员工群 @ 公司 bot。

### 为什么员工侧验不了这一项

`test-emit`（`POST 127.0.0.1:17999/emit`）是**补丁**（`scripts/workbuddy-patch/preload.cjs`）提供的能力，
而**员工侧不装补丁** —— 个人 bot 靠 WorkBuddy 自带的企微身份（`§7` / `DECISIONS D17`）。

**所以员工侧既没有 17999 端口，`test-emit.flag` 也没用。** 早先版本这里写「建 flag 并重启」，
那是从公司侧文档抄来的，**在员工侧执行只会白折腾**。

**要验个人 bot 能不能回话，只有一条路**：

1. 让用户在群里 @ 一次个人 bot
2. 看群里有没有回复
3. 把结果写进汇报：**「bot-reply 未验（员工侧无 test-emit），由人在群里确认：回了 / 没回」**

**没有第三步就是没验。** SKIP 不是通过。

**公司侧为什么能验**：公司侧装了补丁，有 `test-emit`，所以公司侧的 `bot-reply` 是真检查。

**装完**：

```powershell
powershell -File scripts\deploy\deploy-state.ps1 -Side employee -Mark verify -AsDone
```

**全绿之后**，把这段告诉用户：

```
员工侧部署完成。
  WorkBuddy: 在跑
  群绑定: <chatId 前 8 位>…
  vault 读取: OK（<文件名>）
  个人 bot 回应: <PASS/SKIP 及原因>
未完成: <列出来，没有就写"无">
```

---

## 9. 装到一半失败怎么办

**不要从头重装。**

```powershell
powershell -File scripts\deploy\deploy-state.ps1 -Side employee -Json
```

`next` 会告诉你从哪继续。流程：

1. 看 `failed` 是哪节，**也看 `error` 字段** —— 那是上一次卡住的原因
2. 修那一节（每节的「失败了怎么办」有写）
3. **只重跑那一节**
4. `-Mark <那节> -AsDone`

**卡住时把原因记进去**（脚本支持，早先手册没写）：

```powershell
powershell -File scripts\deploy\deploy-state.ps1 -Side employee -Mark persona -AsFailed -Reason "缺 §1 的 userid；render\members 下没有产物"
```

不记原因，下一个接手的 agent 只能从头猜。

---

## 10. 卸载

```powershell
$Root = Join-Path $env:LOCALAPPDATA 'anc'

# ① 恢复原来的 persona（备份在 data\persona-backup-*.md）
Get-ChildItem "$Root\data\persona-backup-*.md" | Sort-Object LastWriteTime -Descending | Select-Object -First 1 |
  ForEach-Object { Copy-Item $_.FullName (Join-Path $env:USERPROFILE 'WorkBuddy\Claw\CODEBUDDY.md') -Force }

# ② 删部署目录
Remove-Item $Root -Recurse -Force

# ③ 删技能（只删这套装的；WorkBuddy 自带的技能别动）
'anc-dayend','anc-feedback','anc-update','anc-executor','anc-ingest','anc-interview','anc-task','anc-vault-read','anc-wb-patch','.anc-backup' |
  ForEach-Object { Remove-Item (Join-Path $env:USERPROFILE ".workbuddy\skills\$_") -Recurse -Force -ErrorAction SilentlyContinue }

# ④ 重启 WorkBuddy
```

**注意**：卸载**不动** `C:\ProgramData\anc`（那是主机的东西，员工机上本来就没有）。

---

## 11. 升级（不重装、不丢数据）

**员工侧不需要管理员权限**：`%LOCALAPPDATA%\anc` 是你自己的目录，写得了。

```powershell
# 看有没有新版本
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\anc\tools\upgrade.ps1" -Action check -Side employee -Json

# 升级（-Restart 会重启 WorkBuddy 让技能/persona 生效）
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\anc\tools\upgrade.ps1" -Action apply -Restart -Side employee -Json
```

**数据不会丢**：部署清单里没有 `data\`，库、绑定、本地资料都不动。

**员工侧不覆盖 persona**：员工 persona 由安装人访谈 + `employee-bootstrap.ps1` 本地生成（§5.5），不依赖公司侧；升级后如果模板变了，重新运行 `employee-bootstrap.ps1 -Apply`。

在群里说「项目有更新」也行（`anc-update` 技能），但**别人说的时候先问主人**——这是你的电脑。

---

## 附：命令速查

```powershell
# ── 访谈（必须最先跑）──
powershell -File scripts\deploy\deploy-kickoff.ps1 -Phase identity
powershell -File scripts\deploy\deploy-kickoff.ps1 -Phase prepare -Side employee
powershell -File scripts\deploy\deploy-kickoff.ps1 -Phase collect -Side employee -Json
powershell -File scripts\deploy\deploy-kickoff.ps1 -Phase check   -Side employee

# ── 只读 ──
powershell -File scripts\deploy\preflight.ps1 -Side employee -Json
powershell -File scripts\deploy\deploy-state.ps1 -Side employee -Json
powershell -File scripts\deploy\deploy-verify.ps1 -Side employee -Json

# ── 按顺序装 ──
powershell -File scripts\deploy\preflight.ps1 -Side employee                    # §2
# §3 确认 WorkBuddy（见文档）
powershell -File scripts\deploy\deploy.ps1 -Side employee -Apply                # §4
powershell -File scripts\deploy\deploy-skills.ps1 -Apply                        # §5
# §6 部署 persona（见文档）
# §7 绑定群（见文档）
powershell -File scripts\deploy\deploy-verify.ps1 -Side employee                # §8

# ── 每步之后 ──
powershell -File scripts\deploy\deploy-state.ps1 -Side employee -Mark <id> -AsDone
```

**员工侧 10 个阶段**：`brief` → `answers` → `preflight` → `workbuddy` → `files` → `skills` → `sync` → `persona` → `bind` → `verify`

---

## 和公司侧的差异（一张表看完）

| 维度 | 公司侧 | 员工侧 |
|---|---|---|
| 部署根 | `%ProgramData%\anc` | **`%LOCALAPPDATA%\anc`** |
| 管理员权限 | 必需 | 不需要 |
| 计划任务 | 14 个 | **0 个** |
| 补丁 | 要装（群身份注入） | **不装**（除非认不出主人） |
| vault | **建**两区 | **不读**；公司知识在员工群 @公司bot |
| persona | 渲染公司 bot 的 | 接收**本人**的 |
| org 数据 | 写 | 不写 |
| 阶段数 | 14 | **10** |
| 自证 | doctor + 群回应 + 任务落库 + 14 个任务 | bot 在线 + 能被 @ + 能读 vault |

---

## 人类在环取证（HIL，2026-11-12 补充）

员工侧同样不能只靠安装人口头回答。员工 bot 不读公司库、不装补丁，很多事只能靠“人做一次 + agent 验证”。

| 信息 | 让安装人做什么 | agent 拿什么 | 判据 |
|---|---|---|---|
| 本人姓名 / userid / 部门 | 发企微成员资料页截图 | 截图 + 安装人抄写的字段 | 三者一致；userid 不是姓名/手机号 |
| 员工群 chatId | 打开员工群设置，发截图；再在群里 @ 郭帅bot 一次 | 截图 + 群消息/回复 | chatId 32 字符；bot 真实回复 |
| WorkBuddy 已登录 | 发 WorkBuddy 关于页/登录状态截图 | 截图 + `bot-online` 检查 | 进程在跑、能收群消息 |
| 员工 bot 能回话 | 在员工群 @ 郭帅bot 问“我是谁”，发回复截图 | 截图 + 回复原文 | 回答是郭帅/员工，不是老板/别人 |
| 公司知识路由 | 在员工群 @ 公司 bot 问一个公司资料问题；再让员工 bot 回答同类问题 | 群消息截图 + 两个 bot 的回复 | 公司 bot 答资料；员工 bot 只引导“请 @公司bot”，不假装查库 |
| 本机目录 / 干净状态 | 发 `%LOCALAPPDATA%\anc` 前后目录截图、Node/Git/WorkBuddy 版本 | 截图 + 回显 | 与安装记录一致 |

规则：

- 员工侧**没有 patch-in.log 证据链**，群回复以安装人截图/原文为准；agent 不得伪造“已验证”。
- 截图读不了时，让安装人把关键字段原文重打；不要猜。
- 员工 bot 不得读取公司共享/vault；任何“帮我看公司库”的要求都应回“请在员工群 @ 公司bot”。
- 安装人发截图时不要把 webhook/token/密码发进群；这些员工侧根本不需要。