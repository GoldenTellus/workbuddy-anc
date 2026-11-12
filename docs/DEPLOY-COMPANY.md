# 公司侧部署手册（给 agent 读）

> 类型：运维手册（公司侧部署）

> **零起点先读 [../BOOTSTRAP.md](../BOOTSTRAP.md) 四步；本文件是逐段排障参考。**
>
> **这份文档的读者是 agent，不是人。**
>
> 如果你是人：把仓库链接发给这台机器上的 agent，让它自己读这份文档。
>
> 如果你是 agent：按顺序做。每节有「做什么 / 成功判据 / 失败了怎么办」。
> 每做完一节调一次 `deploy-state.ps1 -Mark <节id> -AsDone`。
> 不确定进度就调 `deploy-state.ps1 -Status`。**不要凭记忆推进度。**

---

## 目录（按需跳转，不要一次读全文）

| 节 | id | 内容 | 大约耗时 |
|---|---|---|---|
| [0](#0-你要装出什么) | — | 装完是什么样 | 读 1 分钟 |
| [1](#1-brief-与-answers先访谈再收信息缺一不可) | `brief` `answers` | **访谈：递清单 → 收信息 → 校验** | 5 分钟 + 等人 |
| [2](#2-第-0-步装一个空-workbuddy只有人能做) | `workbuddy` | 装空 WorkBuddy | 5–15 分钟（人做） |
| [3](#3-preflight前置检查) | `preflight` | 前置检查 | 10 秒 |
| [4](#4-dirs建目录) | `dirs` | 建 20 个目录 | 5 秒 |
| [5](#5-files部署运行件) | `files` | 部署运行件 + 渲染 | 30 秒 |
| [6](#6-skills装技能) | `skills` | 装 9 个技能（11 个 md 文件；另有 `.anc-backup` 备份目录，不是技能） | 10 秒 |
| [7](#7-patch装补丁) | `patch` | 打 WorkBuddy 补丁 | 1–3 分钟 |
| [8](#8-tasks注册计划任务) | `tasks` | 注册 14 个任务 | 10 秒 |
| [9](#9-vault建两区) | `vault` | 建两区 vault | 30 秒 |
| [10](#10-org写-org-数据) | `org` | 写 org 数据 | 5–10 分钟 |
| [11](#11-wecom配企微) | `wecom` | 配企微（要人给值） | 5 分钟 + 等人 |
| [12](#12-verify自证) | `verify` | 自证 | 30 秒 |
| [13](#13-装到一半失败怎么办) | — | 断点续装 | — |
| [14](#14-重装与卸载) | — | 回滚 | — |
| [15](#15-日常升级不重装不丢数据) | — | **升级不重装**（保留数据） | 1–2 分钟 |

---

## 0. 公司侧装出什么

**整个部署分三段，不是一口气 11 步**：

1. **brief** — 先把「人要做的事」清单递给他（§1.2）
2. **answers** — 再把只有他知道的信息一次问全并校验（§1.3 / §1.4）
3. **执行** — 从 §2 起连续跑完 11 个技术阶段，中途只在 UAC 和企微后台停

> **信息齐了之后，其实可以一条命令装完。** §1.4 的 `check` 通过后：
>
> ```powershell
> powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\install-company.ps1 -VaultRoot D:\anc -Apply
> ```
>
> 它按固定顺序跑 `preflight → dirs → files → skills → tasks → vault → org → wecom → verify → executor → patch`（11 步），每步自动 `deploy-state -Mark`，失败即停。修好后用 `-From <阶段>` 续跑，**不要从头重装**。其中 `executor` 只写 marker（不真正建 host），`patch` 重启 WorkBuddy 后由 `anc-patch-guard` 收尾。
>
> 两个注意：① 必须管理员会话（首次部署的固有限制，注册 SYSTEM 任务本身要提权）；② `patch` 放在最后，因为它会用启动器重启 WorkBuddy，当前会话会断——不想重启就加 `-Skip patch`。
>
> 下面 §2–§12 保留为**逐段手工做法和排障参考**，编排脚本就是把这些步骤按同样顺序串起来。

一台 7×24 的 Windows 主机，上面有：

```
C:\ProgramData\anc\        部署目录（15 个子目录）
D:\anc\                    vault + org + build
%USERPROFILE%\.workbuddy\  WorkBuddy 本体 + 技能
```

装完的状态：

- **公司 bot 在企微群里能回话**
- **14 个计划任务在跑**
- **`doctor` 35 项（21 字面量 + 14 个 task-* 覆盖项）FAIL=0**
- **能登记任务、能到点提醒、能入库**

**你不会做的事**：不装员工侧（那是另一份文档）、不配企微后台（人做，见 §11）。

---

## 1. brief 与 answers：先访谈，再收信息（缺一不可）

**这一步不能跳，但也不再是「把一张表甩给人填」。** 顺序是：先递清单（人去做准备）→ 再收信息（一次问全）→ 校验齐了才开始装。

把后面的 6 次打断（§5.5 缺 members、§6 不知道装谁、§10.5 webhook 对不上、§11 企微后台没配…）提前到这里一次说完。

### 1.1 第一问：这台机器是谁在用

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\deploy-kickoff.ps1 -Phase identity
```

**不要问人「你要 company 还是 employee」**——那是内部术语。用他的语言问：

| 他的回答 | side | 意味着 |
|---|---|---|
| 我是老板/负责人，装公司那台常开的机器 | `company` | 要管理员、14 个任务、两区 vault、配企微后台 |
| 我是公司 IT，装或重装公司主机 | `company` | 同上，另外可能要处理重装与回滚 |
| 我是员工，装自己的办公电脑 | `employee` | 不要管理员、0 任务、只读共享区 |
| 我在帮同事装 | `employee` | 同上，但 memberId / userid / chatId 必须问本人 |

### 1.2 把准备清单递给人（这一步他会离开一会儿）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\deploy-kickoff.ps1 -Phase prepare -Side company -Role boss
```

输出是一段可以直接转发到群里的文字：装一个**空的** WorkBuddy、建群并把 bot 拉进去、抄 chatId（32 字符）、拿群机器人 webhook、备人员名单、确认管理员权限。每项都带「怎么算做好了」。

**等他说做完再往下。** 这一步的唯一目的就是把串行打断改成一次并行。

### 1.3 公司侧收信息

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\deploy-kickoff.ps1 -Phase collect -Side company -Json
```

问题集每项都标了 `who`：

- `installer` — **必须问人**，不能猜
- `self` — agent 自己查（OS、node、盘符、WorkBuddy 路径、vault 盘可用空间）
- `optional` — 缺了也能装，只是对应功能变弱

答案统一写进 **`%ProgramData%\anc\data\deploy-answers.json`**，后面 `dirs / files / org / wecom` 各节都从这里读，不再各自问一遍。

> **重装 / 换机 / 迁移时不用重新填表**：机器上已经有 `org\` 的话，可以直接反推：
> ```powershell
> powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\deploy-kickoff.ps1 -Phase collect -FromOrg D:\anc\org -Answers "$Root\data\deploy-answers.json"
> ```
> 它读 `company.md` + `members/*.md` + `depts/*.md`，生成同结构的 answers（`vaultRoot` 从 `vault_shared` 的父目录推）。已存在 answers 时要加 `-Force` 才覆盖。

> **webhook 只存文件名，不存明文。** 明文留在 `%ProgramData%\anc\secrets\`，那里 ACL 已收紧（§10.5）。

### 1.4 校验：齐了才允许开始装

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\deploy-kickoff.ps1 -Phase check -Side company
# exit 0 且 ok=true 才继续；exit 1 = 有必填项没齐
```

`check` 通过后，把访谈两阶段记账（手工分步时装）：

```powershell
powershell -File scripts\deploy\deploy-state.ps1 -Side company -Mark brief -AsDone
powershell -File scripts\deploy\deploy-state.ps1 -Side company -Mark answers -AsDone
```

> 走 `install-company.ps1 -Apply` 一条命令时由脚本自动记账，不用手敲上面两条。

`errors` 必须补齐；`warnings` 是提醒（例如 chatId 不是 32 字符——截断值会被静默接受，绑完 bot 认不出群）。

### 1.5 字段对照：answers 与老手填表

下面这张表是 §1.3 问题集的**人类可读版**，字段与 `answers` 一一对应。实际收集以脚本输出的 `questions` 为准；这里保留是为了让人看懂"为什么要这个值"。

**这张表只有人知道，你不能编、不能猜、不能用占位符糊过去。**

| # | 要什么 | 用在哪 | 怎么来的 | 填这里 |
|---|---|---|---|---|
| 1 | **这台机器能当 7×24 主机吗**（不会关机/睡眠） | 整个方案的前提 | 问人 | ☐ 能 / ☐ 不能 |
| 2 | ~~企业微信 corpId~~ **（不需要）** | — | 见 `§11.1` 的说明：出站走 webhook、入站走 WorkBuddy，都不用 corpId | — |
| 3 | **公司 bot 的企微机器人 webhook** 或 **应用 secret** | bot 发消息 | 企微群 → 群机器人 → 复制 webhook；或自建应用拿 secret | `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=______` |
| 4 | **公司名** | persona、备份目录名 | 问人 | `________________` |
| 5 | **公司 bot 叫什么** | persona、群映射 | 问人 | `________________` |
| 6 | **vault 放哪个盘**（默认 `D:\anc`） | 两区 vault | 问人；没有 D 盘就给个别的盘 | `____:\anc` |
| 7 | **部门列表** | org 数据 | 问人（例：研发部 / 行政部 / 销售部） | 见 §10 |
| 8 | **员工名单 + 每个人的 userid** | org 数据 | 企微通讯录里的 userid（**不是**姓名、**不是**手机号） | 见 §10 |
| 9 | **每个员工属于哪个部门** | org 数据 | 问人 | 见 §10 |
| 10 | **每个员工的员工群 chatId** | 员工群绑定 | 建群后从群设置里拿；**32 字符，不要截断** | 见 §10 |
| 10b | **部门群 / 公司大群 / 老板 1:1 的 chatId + webhook 文件名** | org 群配置 | 企微群设置；`boss_dm` 真 1:1 不可用时用私有群 | 见 §10 |
| 11 | **老板自己的 userid** | `boss_dm` / 全局权限 | 企微通讯录 | `________________` |
| 12 | **主干2 host 工作区（绝对路径，可选）** | `new-host.ps1` 新建对话 | 问人；不启用自动建 host 就留空。**写独立绝对路径**（默认 `<仓库父目录>\anc-executor-ws`，如 `D:\anc-executor-ws`），不要写 WorkBuddy 里的显示名，也不要写仓库目录本身——wake bridge 2.0 把它当会话 `cwd` 传给 `conversations.create`；显示名会被解析到自动生成工作区 | `D:\workbuddy-anc` / 空 |
| 13 | **是否开启 wake bridge**（可选） | 有 queued 时唤醒当前对话 | 问人；默认关闭 | ☐ 开 / ☑ 关 |

**填不全时的行为**：

- **1、4、5、6 缺** → 停下来问。这些没有合理默认值。
- **2、3 缺** → 可以继续到 §10，但 §11 会卡住；`verify` 的 `bot-reply` 那项会是 SKIP。
- **7、8、9、10 缺** → 可以装出一个"没有员工"的公司侧（`groups.json` 0 个成员）。**能用，但没人能 @ 它**。装完告诉用户"员工还没配，配好之后重跑 §10 和 §12"。
- **10b 缺** → 员工群能跑；部门群/公司大群/`boss_dm` 还不能用。**不要假装四类群已经通了**，在交付说明里列出来。
- **11 缺** → `boss_dm`/全局权限无法校验；先问老板 userid，不要用管理员自己的 userid 猜。

---

## 2. 第 0 步：装一个空 WorkBuddy（只有人能做）

> **这一步 agent 做不了。** WorkBuddy 装不了自己。

**做什么**：让用户装 WorkBuddy，**装完不要配任何东西**。

**为什么强调"不要配"**：`§5` 会部署 persona 覆盖它；`§7` 会打补丁改它的行为。提前配的东西都会被覆盖掉，白费功夫，而且可能让后面对不上。

**给用户的原话**（可直接转述）：

```
请在这台机器上装腾讯 WorkBuddy（企业版），用管理员账号登录。
装完就停，不要建机器人、不要配企业、不要改设置——后面会自动配。

装好之后，请【右键 WorkBuddy 图标 →「以管理员身份运行」】把它打开，
再用这个会话把项目链接发给我。部署期间我需要管理员权限
（要写 ProgramData、注册计划任务、改 ACL），普通权限做不了。

UAC 弹框点「是」就行，不要输入另一个管理员账号的密码——
那会把我的工作目录换成别人的，后面读不到你的配置。
```

> **部署完要切回普通权限。** 管理员打开的 WorkBuddy 会让 `anc-patch-guard` 让不出手（普通权限杀不掉提权进程），补丁自愈在部署期间是关闭的。部署收尾（§12）之后，关掉 WorkBuddy，用正常方式重新打开——`anc-workbuddy-launch` 登录时拉起的本来就是普通权限实例。

**成功判据**（你自己验，不要听用户说"装好了"）：

```powershell
# 三个都满足才算装了
$wb = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\WorkBuddy\WorkBuddy.exe'),
  (Join-Path $env:ProgramFiles 'WorkBuddy\WorkBuddy.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $wb) { throw 'WorkBuddy 没装（两个常见位置都没有）' }
if (-not (Test-Path (Join-Path $env:USERPROFILE 'WorkBuddy'))) { throw 'WorkBuddy 装了但没登录过（没有 %USERPROFILE%\WorkBuddy）' }
& $wb --version   # 能打印版本
```

> **WorkBuddy 可以装在非标准路径。** 本机实测装在 `D:\App\WorkBuddy`，在
> `%LOCALAPPDATA%\Programs\WorkBuddy` 建了一个 **Junction** 指过去：
>
> ```powershell
> New-Item -ItemType Junction -Path "$env:LOCALAPPDATA\Programs\WorkBuddy" -Target 'D:\App\WorkBuddy'
> # 回滚 = 删 Junction（只删链接，不动 D:\App\WorkBuddy 本体）
> # Remove-Item "$env:LOCALAPPDATA\Programs\WorkBuddy"
> ```
>
> 上面那段检测与后面的补丁启动器都按 `%LOCALAPPDATA%\Programs\WorkBuddy` 找，所以 Junction 能让它们正常工作。
> 不建 Junction 时，补丁启动后会把实际 exe 路径写进 `%ProgramData%\anc\data\workbuddy-path.txt`，
> `doctor` 的 `workbuddy` 检查优先读它、读不到才回落 `%LOCALAPPDATA%\Programs\WorkBuddy`。
> **重装 WorkBuddy 或换机器后要重建 Junction**——它是机器相关状态，git 里没有。

**失败了怎么办**：

- **找不到 exe** → 让用户确认装了；WorkBuddy 可能装在别的路径，用 `Get-ChildItem -Path C:\,D:\ -Filter WorkBuddy.exe -Recurse -ErrorAction SilentlyContinue` 找；找到非标准路径就按上面的 Junction 说明指回来
- **没登录过** → 让用户启动它并登录企微
- **版本低于 5.9.3** → 补丁的锚点是按 5.9.3 写的。**先让用户升级**，或者告诉用户"这个版本没验过，装完可能要手工调锚点"（见 §7）

**装完**：

```powershell
powershell -File scripts\deploy\deploy-state.ps1 -Side company -Mark workbuddy -AsDone
```

---

## 3. preflight（前置检查）

> **先看 agent 的权限。** 本节的第一件事是给这台机器出一份**画像**（`facts.machineProfile`）。因为同样是「不是管理员」，可能是两件完全不同的事：

| 画像 | 含义 | preflight 的结论 |
|---|---|---|
| `admin-elevated` | agent 以管理员运行，账号在管理员组 | 通过 |
| `admin-not-elevated` | 账号在管理员组，但 agent 是普通权限 | **拦住**（`agent-elevated`）：关掉 WorkBuddy，右键「以管理员身份运行」重开 |
| `standard-user` | 账号不在管理员组 | **拦住**：UAC 也提不上去，换有管理员权限的账号 |
| `builtin-admin-uac-off` | 内置 Administrator + UAC 关闭 | 能装，强警告：整机没有拦截层，bot 长期以最高权限运行 |
| `builtin-admin` | 内置 Administrator + UAC 开启 | 能装，提示：共享身份，多台机器都这样会无法归因 |

`facts.guidance` 里是**给人看的做法**（一两句人话），直接转述，不要自己推断。

**为什么要单列 `agent-elevated`**：agent 跑在 WorkBuddy 里，它执行的命令继承 WorkBuddy 的 token。所以 `isAdmin=false` 就等于「WorkBuddy 不是以管理员打开的」——不是"PowerShell 没提权"这么简单。部署要写 `%ProgramData%\anc`、注册计划任务、改 ACL，普通权限一样都做不到。

**做什么**：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\preflight.ps1 -Side company -Json
```

**成功判据**：输出里 `"ok": true`。

**输出结构**（你只需要看这三个字段）：

```json
{
  "ok": true,
  "blockers": [],          // 非空 = 别装了，先修
  "warnings": [ ... ],     // 能装，但要知道
  "next": "可以继续。",     // 下一步做什么
  "facts": { ... }         // 原始检测值
}
```

**有 blocker 时**：`next` 会告诉你该干什么。常见的：

| blocker | 意思 | 怎么做 |
|---|---|---|
| `admin` | 不是管理员 | 让用户以管理员身份重开 PowerShell |
| `node` / `node-version` | 没装 Node 或版本 < 22 | 装 Node 22 LTS |
| `git` | 没装 git | 装 Git for Windows |
| `disk` | 部署盘剩余 < 200MB | 清空间 |
| `vault-drive` | vault 盘不存在 | **这是 blocker 不是警告**——装完什么都写不进去 |
| `workbuddy` | 没装 | 回 §2 |
| `os` / `powershell` | 版本太旧 | 换机器或升级 |

**warnings 怎么处理**：

- `already-installed` → **这是重装/升级，不是首装**。先备份，然后问用户"要升级还是重建"。**重建见 §14。**
- `port-17999` → 如果占用者是旧 WorkBuddy，先关掉（否则 §7 的补丁会打架）
- `tasks` → 已有 `anc-*` 任务，§8 会覆盖

**失败了怎么办**：按 `next` 和上表处理，然后**重跑本检查**。不 ok 不要往下走。

**装完**：

```powershell
powershell -File scripts\deploy\deploy-state.ps1 -Side company -Mark preflight -AsDone
```

---

## 4. dirs（建目录）

**做什么**：建 15 个部署子目录 + 5 个 vault 目录。

```powershell
# 推荐：脚本建（幂等，已存在的跳过）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\setup-dirs.ps1 -VaultRoot D:\anc -Apply
```

脚本做的是下面这段，保留作为对照（出问题时看它到底建了什么）：

```powershell
$Root = Join-Path $env:ProgramData 'anc'
$VaultRoot = 'D:\anc'   # 按 §1 第 6 项填的值

# 部署目录（15 个）。为什么这么多：deploy.ps1 只写其中 7 个，
# 其余是运行时才会被写的（evals/stage/inbox/...），提前建好免得运行时才发现没有。
'accounts','backup','bin','data','evals','inbox','ingest','light','patch','render','secrets','service','shared','skills','stage' |
  ForEach-Object { New-Item -ItemType Directory -Path (Join-Path $Root $_) -Force | Out-Null }

# vault 目录（5 个）
'vault-shared','vault-internal','inbox','org','build' |
  ForEach-Object { New-Item -ItemType Directory -Path (Join-Path $VaultRoot $_) -Force | Out-Null }
```

**成功判据**：

```powershell
# 部署目录：应该是 15
@(Get-ChildItem $Root -Directory).Count

# vault 目录：**至少 5**，不是「正好 5」。
# 运行时还会多出这些，它们不是建错了：
#   render        —— 渲染产物（§10.6 的 --out 指到 %ProgramData%anc
ender，
#                    但 vault 根下也可能有一个历史遗留的 render）
#   _acl-verify   —— D24 验 ACL 时的测试目录（可以删）
#   inbox/_originals 等运行时目录
@(Get-ChildItem $VaultRoot -Directory).Count   # 期望 >= 5
```

**失败了怎么办**：上一级的盘不存在（§3 的 `disk` blocker 应该已经拦住了）→ 回 §3。

**装完**：

```powershell
powershell -File scripts\deploy\deploy-state.ps1 -Side company -Mark dirs -AsDone
```

---

## 5. files（部署运行件）

**做什么**：

```powershell
# 先看计划（dry-run，不写任何东西）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\deploy.ps1 -Side company

# 确认无误再落盘
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\deploy.ps1 -Side company -Apply
```

**这一步做什么**：把**运行件**复制到 `%ProgramData%\anc\`，落盘前备份、落盘后**逐文件对拍 hash**、任一失败**整体回滚**。

> **只部署运行件，不部署仓库。** `docs/`、`_research/`、`reference/`、`AGENTS.md`、`reference/upstream/SPEC.md`、`package.json` 这些开发维护内容一个都不进来；`src/**/*.test.ts` 和 `patch/*.test.mjs` 也被排除。现在一共 158 个文件。

落盘分两处，看目录名就知道哪些是「系统在跑」、哪些是「工具」：

| 目录 | 放什么 | 数量 |
|---|---|---|
| `bin\` | **运行时**：14 个计划任务的动作、`.cmd/.vbs` 启动器、技能直接调的脚本 | 21 |
| `tools\` | **装机与维护**：部署、自检、重装、账号、演练、回归。装完就闲置 | 25 |

`scripts\` 下**不在清单里的脚本不会部署**。部署末尾会列出「未归类」的脚本，提醒你归类，或确认它本来就不该上线。新增运行件要改 `deploy.ps1` 的 `$BinScripts`（运行时）或 `$ToolScripts`（装机维护）。

**成功判据**：退出码 **0**，并且输出里没有 `ERROR`。

```powershell
# 自己验一遍：部署的 cli 能起来
node --no-warnings "$Root\service\cli.ts" 2>&1 | Select-Object -First 1
# 期望看到 "ERROR 缺少命令组（...）" —— 这是正常的用法提示，不是故障

```
> **⚠ 如果你的脚本里设了 `$ErrorActionPreference = 'Stop'`，上面这条探针会把它打断。**
>
> `cli.ts` 无参数时会往 **stderr** 写用法提示。PowerShell 5.1 把原生命令的 stderr 当成
> `NativeCommandError` 记录，在 `Stop` 策略下会**终止整个脚本** —— 于是你后面的
> `-Mark files -AsDone` 不会执行，进度卡在 `files` 这一步，看起来像部署失败。
>
> **这不是部署故障**（`deploy.ps1` 的退出码是 0、hash 对拍也过了），是探针写法的问题。三种绕法：
>
> ```powershell
> # ① 最省事：探针时临时放宽策略
> $ErrorActionPreference = 'Continue'
> node --no-warnings "$Root\service\cli.ts" 2>&1 | Select-Object -First 1
> $ErrorActionPreference = 'Stop'
>
> # ② 把 stderr 合进 stdout 再判（不在 PowerShell 层报错）
> $out = & node --no-warnings "$Root\service\cli.ts" 2>&1 | Out-String
> if ($out -notmatch '缺少命令组|Usage|用法') { throw "探针输出不对: $out" }
>
> # ③ 干脆跳过探针 —— deploy.ps1 自己已经逐文件对拍过 hash
> ```
>
> 2026-11-05 一次真机从零装就踩了这个：`deploy.ps1 -Apply` 本身成功（73 文件 hash 全过），
> 但探针把脚本打断、`-Mark files` 没执行（`VERIFY §81.4` #3）。

**失败了怎么办**：

| 退出码 | 意思 | 怎么做 |
|---|---|---|
| 1 | 校验失败，**已回滚** | 看输出里的 `ERROR`：通常是文件被占用（关掉占用进程）或磁盘满 |
| 2 | 用法/环境错误 | 看 `FIX` 那行 |
| 3 | 已应用但探针失败，**已回滚** | 部署出来的东西起不来。看 `FIX`；通常是映射漏了文件（`deploy.ps1` 自带这个检查） |

**回滚**（如果 `-Apply` 之后你发现错了）：

```powershell
powershell -File scripts\deploy\deploy.ps1 -Rollback
```

**装完**：

```powershell
powershell -File scripts\deploy\deploy-state.ps1 -Side company -Mark files -AsDone
```

---

## 6. skills（装技能）

**做什么**：

```powershell
# 预检（只比对，不写）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\deploy-skills.ps1

# 落盘
#   默认目标 %USERPROFILE%\.workbuddy\skills（WorkBuddy 只读这里）
#   -Target 可指到别处（演练 / 多用户机）
#
# ⚠ 这个脚本**没有 -Side 参数**（VERIFY §76）。它不是按 side 分的，因为它只往用户目录写。
#   照别的小节的习惯顺手加 -Side company 会直接报 'A parameter cannot be found'。
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\deploy-skills.ps1 -Apply
```

**这一步做什么**：把 `light\skills\*\` 复制到 `%USERPROFILE%\.workbuddy\skills\<技能名>\`。

**关键**：**落盘目录用 `SKILL.md` 里的 `name:` 字段，不是仓库目录名**。例：仓库目录是 `anc-ingest-company`，但 `SKILL.md` 写 `name: anc-ingest`，persona 也引用 `anc-ingest`。按目录名落盘会造出两个同名技能，bot 侧会冲突。

**成功判据**：

```powershell
# 应该是 9 个技能目录 + 1 个 .anc-backup（备份目录，不算技能）= 10：
#   anc-dayend / anc-feedback / anc-ingest / anc-interview / anc-task / anc-executor / anc-vault-read / anc-wb-patch / anc-update
# 源文件是 11 个 md（9 个 SKILL.md + anc-executor 多一份 subagent.md、anc-interview 多一份 questions.md）。
@(Get-ChildItem (Join-Path $env:USERPROFILE '.workbuddy\skills') -Directory).Count
# 期望 10（9 技能 + .anc-backup）。第一次装还没有备份目录时是 9，两种都正常。
# 想数准就只数带 SKILL.md 的：
@(Get-ChildItem (Join-Path $env:USERPROFILE '.workbuddy\skills') -Directory |
    Where-Object { Test-Path (Join-Path $_.FullName 'SKILL.md') }).Count
# 期望 9
```

**失败了怎么办**：

- **数量不对** → 跑 `deploy-skills.ps1 -Apply -RemoveExtra`（顺便删掉线上多出来的技能）
- **误删了技能** → `deploy-skills.ps1 -Rollback` 恢复最近一次备份

**装完**：

```powershell
powershell -File scripts\deploy\deploy-state.ps1 -Side company -Mark skills -AsDone
```

---

## 7. patch（装补丁）

**做什么**：WorkBuddy 是闭源的，群身份靠**补丁**注入（消息开头加 `[anc:chat=<chatid> from=<userid>]`）。

```powershell
# 装补丁并启动 WorkBuddy（会重启它）。
#
# 注意：早先文档写的 patch\launch-patched.ps1 从来不存在，照着做会报"文件不存在"。
# 实际入口是 launch-patched.ps1（2026-11-05 校正，VERIFY §59）。
# 它自己会轮询 patch-state，最多等 150 秒再报结论，不需要你在外面猜时间。
powershell -NoProfile -ExecutionPolicy Bypass -File "$Root\patch\launch-patched.ps1"

# 确认补丁生效
Get-Content "$Root\data\patch-state.json" | ConvertFrom-Json
```

> **⚠ 这一步可能失败 1–2 次，属正常，不要急着找根因。**
>
> `--inspect-brk` 注入的**单次成功率约 66%**（`VERIFY §59` 实测：210 次 `env set` 对应 140 次 `APPLIED`）。
> 失败的表现：日志里有 `env set: "OK:<某pid>"` 但**没有本轮的 `APPLIED`**，
> 常伴 `inspector close skipped: Cannot find context with specified id`，
> 且 `patch-state.json` 不出现、`9229` 不监听。
>
> **这不是脚本有 bug，是注入本身的时序竞争。** 系统靠 `anc-selfheal` 重试 4 次兜住
> （3 次全败概率 `(1/3)³ ≈ 3.7%`）。所以直跑失败后**不要反复跑同一个启动器**，改走自愈：
>
> ```powershell
> powershell -NoProfile -ExecutionPolicy Bypass -File "$Root\bin\anc-selfheal.ps1" -DryRun   # 先确认锚点可用
> powershell -NoProfile -ExecutionPolicy Bypass -File "$Root\bin\anc-selfheal.ps1" -Apply    # 真跑（bot 会短暂离线）
> ```
>
> 自愈会「停全部 WorkBuddy → 用补丁启动器重启 → 最多重试 4 次」。
> 2026-11-05 一次真机从零装：`§7` 直跑两次都失败（各 156 秒），改走自愈后**第 3 次成功**，
> `§7` 共耗 523 秒 = 全流程 40% 的执行时间。**那份台账当时的归因是错的**（猜成"单实例锁"），
> 真因就是这 66%（`VERIFY §81.5`）。
>
> **教训**：一个正确但只解释 66% 的假设，和一个人错但解释 100% 的假设摆在一起，人会选后者。
> 文档没给"这是随机"的锚点时，读者就会去构造确定性解释。

**成功判据**：`patch-state.json` 里 `"applied": true`，**并且那个 `pid` 还活着**：

```powershell
$st = Get-Content "$Root\data\patch-state.json" -Raw | ConvertFrom-Json
if (-not $st.applied) { throw 'patch 没生效' }
if (-not (Get-Process -Id $st.pid -ErrorAction SilentlyContinue)) { throw "patch 说的 pid $($st.pid) 已经不在了（残留状态，别信 applied:true）" }
```

> **只看 `applied:true` 会被骗**——`VERIFY §16` 记过：进程死了但状态文件还写着 applied。

**失败了怎么办**：

| 现象 | 原因 | 怎么做 |
|---|---|---|
| `ANCHOR-MISS` | WorkBuddy 版本不是 5.9.3（锚点对不上） | **不重启、不硬套**。告诉用户"这个版本没验过"，把 `patch\manifest.json` 里的锚点按新版本调（看 `docs/WORKBUDDY-PATCH.md`） |
| hash 不符但锚点还在 | 厂商改了这个文件 | 会自动降级成 `mode: "anchor"`，**仍然生效**（`VERIFY §37`）。日志里会有说明 |
| 进程反复崩 | preload 在主进程里劫持 https 出事 | `patch-guard` 每分钟自愈（重试 4 次）。要彻底关补丁：用 `launch-patched.ps1 -NoPatch` 启动，或设环境变量 `ANC_WB_PATCH=0`（`apply.ps1 -Disable` 不存在，早先文档写错了） |

**装完**：

```powershell
powershell -File scripts\deploy\deploy-state.ps1 -Side company -Mark patch -AsDone
```

---

## 8. tasks（注册计划任务）

**做什么**：

```powershell
# dry-run：列出 14 个任务和它们的 principal，先看
# 从部署目录跑必须显式传 -Repo（部署目录里探测不到仓库根；仓库内跑可省略）
powershell -NoProfile -ExecutionPolicy Bypass -File "$Root\tools\register-tasks.ps1" -Root $Root -Repo '<仓库根>'

# 落盘
powershell -NoProfile -ExecutionPolicy Bypass -File "$Root\tools\register-tasks.ps1" -Root $Root -Repo '<仓库根>' -Apply
```

> **交互类任务的运行身份（2026-11-05 校正，`VERIFY §76`；2026-11-09 更新）**：
> 三个交互类任务（`anc-workbuddy-launch` / `anc-patch-guard` / `anc-devbot`）的 principal 是
> `-BotUser` 指定的那个用户，而且**要求该用户已登录过**（要有 `C:\Users\<user>` 目录）。
>
> **按 D25，`-BotUser` 默认取「当前部署账号」（`$env:USERNAME`）** —— 直接用管理员账号部署时不用再传；
> 本机实测就是当前登录用户 `DNT`。早先默认值 `anc-bot` / `Administrator` 都与 D25 矛盾：
> 照旧默认值跑会报「交互类任务要求 <用户> 已登录过（当前没有用户配置目录）」，
> 而 `REBUILD §4` 又写着不建专用用户。**如果确实要回到专用用户方案**：先切到那个用户跑一次
> （让它有配置目录），再 `-BotUser <那个用户> -ForceInteractive`。

> **从部署目录跑必须显式传 `-Repo <仓库根>`**：脚本按「从自己所在目录向上找 `.git`」探测仓库根，
> 部署目录（`C:\ProgramData\anc` 下）找不到仓库，`anc-devbot` 的动作会指不到
> `scripts\devbot\devbot-scheduler.ps1`。本机实测要从部署目录跑 `-Repo D:\workbuddy-anc`；
> 在仓库里直接跑可自动探测、不用传。

> **注意**：这里用的是**部署目录里的** `register-tasks.ps1`（`%ProgramData%\anc\tools\`），不是仓库里的。
> 部署目录那份运行时路径正确（§5 已经把它复制过去了）。

**这 14 个是什么**：

| 任务 | 干什么 | 频率 |
|---|---|---|
| `anc-service` | 本地小服务（tick） | 每分钟 |
| `anc-elevate` | 提权执行器（SYSTEM，白名单运维请求） | 开机 + 每分钟 |
| `anc-executor-new-host` | 主干2 自动创建新 host 对话（可选） | 每天 03:00 |
| `anc-executor-host-tick` | 主干2 无新 host 时旧 host 继续接单 | 每天 03:00 |
| `anc-executor-wake` | 有 queued Ticket 时唤醒当前对话（需 wake bridge） | 每分钟 |
| `anc-http` | HTTP 面（只绑 127.0.0.1） | 每分钟 + 开机 |
| `anc-watchdog` | 心跳/积压/进程告警 | 每 10 分钟 |
| `anc-backup` | SQLite + vault 备份 | 每小时（02:00 起） |
| `anc-boot-alert` | 开机后 WorkBuddy 没起来就告警 | 每 10 分钟 |
| `anc-cleanup` | 清企微附件（7 天前） | 每天 03:00 |
| `anc-update-watch` | 查厂商新版 | 每天 09:00 |
| `anc-workbuddy-launch` | 登录后拉起 WorkBuddy | 登录时 |
| `anc-patch-guard` | 补丁自愈 + 部署后自动 executor 收尾 | 每分钟 |
| `anc-devbot` | devbot 自动启动 | 22:00 起每 30 分钟 × 8h |

**主干 2 自动 host（默认开启，安装时自动完成，不需要人手动加工作区）**：

- `install-company` 的 `executor` 阶段（在 `patch` 之前）会调用 `setup-executor.ps1 -PrepareOnly`：
  - 写 `data\wb-wake.flag`（启用 bridge）；
  - 写 `data\wb-wake-workspace.txt` = **独立工作区绝对路径**（默认 `<仓库父目录>\anc-executor-ws`，如 `D:\anc-executor-ws`；`-ExecutorWorkspace` 或 answers 的 `executor.workspace` 可覆盖）；
  - 写 `data\deploy-executor-pending.json`（交给重启后的 patch-guard）。
- `patch` 阶段重启 WorkBuddy 后，`anc-patch-guard` 检测到补丁 `applied=true` 且 marker 存在 → 运行 `tools\setup-executor.ps1 -Apply -Marker`：
  - 用 wake bridge `/new` 在**该工作区**建一个会话并发 `TEST`；bot 回「收到，TEST 正常」；
  - WorkBuddy 因此**自动把该目录注册成工作区**（无需 UI 手动添加）；
  - 若还没有 active host，用这个会话注册**当天 host**（`business_date=今天`、`cut_at=明天 03:00`）；
  - 写 `data\executor-deploy.json`（ok/workspace/conversation_id/test_reply/host）；成功后删 marker，并把 deploy-state 的 `executor` 阶段记为 done。
- 失败不静默：marker 保留、每分钟重试；`executor-deploy.log` 记原因；20 次仍失败写 `deploy-executor-failed.json`。人工修好后跑 `tools\setup-executor.ps1 -Apply` 即可。

> **工作区不需要先在 WorkBuddy UI 里“添加”**：2.0 的 `/new` 直接按 `cwd` 建会话并自动注册工作区，只要该目录存在即可；只有旧 DOM fallback（`window.wb` 不可用）才要求 UI 工作区列表里有同名项。
> **后台任务产物不看这个工作区**：Ticket 的 `task_dir` 由服务端按 `departments/<dept>/tasks/<ticket>/` 推导（相对 §1 第 6 项的 vault 根，本机 `D:\anc`），subagent 直接写绝对路径；WorkBuddy 工作区只决定 host 会话的 cwd/上下文。

> 不想启用自动 host：answers 里 `executor.enabled=否`，或手工不建 `wb-wake.flag`。此时 `new-host` / `wake` 任务存在但静默跳过，等人工开 host。

**成功判据**：

```powershell
$t = @(Get-ScheduledTask -TaskName 'anc-*')
if ($t.Count -ne 14) { throw "应该是 14 个，实际 $($t.Count)" }
$bad = $t | Where-Object { $_.State -notin @('Ready','Running') }
if ($bad) { throw ('这些任务状态不对: ' + (($bad | ForEach-Object { $_.TaskName + '=' + $_.State }) -join ', ')) }
```

主干 2 的部署后证据（patch 重启后 1 分钟内出现）：

```powershell
Get-Content (Join-Path $Root 'data\executor-deploy.json') -Raw   # ok:true / workspace / conversation_id / test_reply / host
Get-Content (Join-Path $Root 'data\executor-deploy.log') -Tail 5
```

**失败了怎么办**：

- **任务被禁用** → `Enable-ScheduledTask -TaskName <名字>`
- **principal 不对**（应该是 LOCAL SERVICE 或 SYSTEM）→ 重新跑 `-Apply`；如果提示交互类任务要 `anc-bot` 用户，加 `-ForceInteractive`（但**先确认那个用户存在且登录过**，否则守卫和启动器不工作）
- **`register-tasks.ps1` 本身报参数错** → 说明部署的那份是旧版本。回 §5 重新部署

**装完**：

```powershell
powershell -File scripts\deploy\deploy-state.ps1 -Side company -Mark tasks -AsDone
```

> **其中 `anc-elevate` 是给 bot 用的提权通道，先说清代价。**
>
> bot 在群里回话时是普通权限（WorkBuddy 以登录用户跑），改不了 `%ProgramData%\anc`、注册不了计划任务。所以注册了这个 SYSTEM 任务：它每分钟从 `data\elevate\queue\` 取**一条**请求，只执行三个白名单动作（`upgrade` / `register-tasks` / `deploy`），脚本路径固定从 `tools\` 取，请求里的路径字段一概忽略；请求文件必须是 `<GUID>.json` 且不能是链接；TTL 30 分钟、每小时最多 6 条、每条写审计。
>
> **能防住什么**：任意命令注入、路径穿越、积压的旧请求半夜执行、性能被刷爆。
> **防不住什么**：**能以部署用户身份写 `queue\` 的进程，就能触发这三个动作提权执行。** 这是刻意选的取舍——换来「bot 一句话就能升级」，代价是这条通道属于部署用户。所以动作清单必须保持短，**不要往里加「执行任意命令」**。
>
> 授权在 `set-acl.ps1` 里：只给 `data\elevate\queue` 和 `done` 授部署用户 Modify，执行器本身不开放。

---

## 9. vault（建两区）

**做什么**：两个**独立的 git 目录**——共享区（全员只读）、内部区（只有公司侧读写）。

```powershell
# 推荐：脚本做（目录 + 模板 + git + ACL + SMB + token 一条龙，幂等）
# 默认 dry-run；-Apply 才落盘，要管理员
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\vault-init.ps1 -VaultRoot D:\anc
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\vault-init.ps1 -VaultRoot D:\anc -Apply
```

脚本按固定顺序做（顺序不能乱，每条都有踩过的原因）：建目录 → **铺模板（必须在 git init 之前）** → 两区各自 git init + 首次提交 → 断继承设 ACL → 建 SMB 共享 → 生成 `service-token` 并重设 secrets 的 ACL。

**幂等**：已存在的目录/git/模板跳过；SMB 存在则校正权限；`service-token` **已存在就保留**（换了 token，正在跑的 `anc-http` 会全部 401）。

下面是从零手写的版本，作为对照和排障用。

```powershell
$VaultRoot = 'D:\anc'   # §1 第 6 项

# 两区各自 git init + 首次提交
foreach ($v in 'vault-shared','vault-internal') {
    $p = Join-Path $VaultRoot $v
    if (-not (Test-Path (Join-Path $p '.git'))) {
        git -C $p init -q
        # .gitignore：原件不进 git（D14）
        Set-Content (Join-Path $p '.gitignore') -Value "_originals/" -Encoding UTF8
        Set-Content (Join-Path $p 'README.md') -Value "# $v`n" -Encoding UTF8
        git -C $p add -A
        git -C $p -c user.name='anc' -c user.email='anc@localhost' commit -q -m 'init'
    }
}

# 内部区的协作目录（任务投影落这里）
New-Item -ItemType Directory -Path (Join-Path $VaultRoot 'vault-internal\collab') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $VaultRoot 'vault-shared\_originals') -Force | Out-Null

# ★ 铺模板：空 vault 只有一句 README，员工进去没东西可用。
#   模板来源是 deploy.ps1 落下来的 <Root>\light\templates\vault\（2026-11-10 起才真正部署，
#   之前 light\templates\vault\ 这 5 份一份都没铺到线上）。
$tpl = Join-Path $env:ProgramData 'anc\light\templates\vault'
if (-not (Test-Path $tpl)) {
    Write-Host "WARN 没有 $tpl —— 先跑 deploy.ps1 -Apply 把模板部署下来；本次跳过铺模板"
} else {
    New-Item -ItemType Directory -Path (Join-Path $VaultRoot 'vault-shared\company') -Force | Out-Null
    Copy-Item (Join-Path $tpl 'collab\*.md')  (Join-Path $VaultRoot 'vault-internal\collab') -Force
    Copy-Item (Join-Path $tpl 'company\*.md') (Join-Path $VaultRoot 'vault-shared\company')  -Force
    foreach ($v in 'vault-shared', 'vault-internal') {
        $p = Join-Path $VaultRoot $v
        git -C $p add -A
        git -C $p -c user.name='anc' -c user.email='anc@localhost' commit -q -m 'templates' 2>$null
    }
}

# ★ 共享区必须是「全员只读」。它默认继承父目录的权限，而父目录一般给了
#   Authenticated Users: Modify —— 那等于谁都能改共享区（doctor 的 vault-acl 会 FAIL）。
#   ⚠ 必须 /inheritance:r 断继承：/grant:r 只管显式 ACE，改不动继承来的那条。
#   ⚠ 断继承会一起砍掉 Administrators / SYSTEM，所以要在同一条命令里重新授予。
icacls "$VaultRoot\vault-shared" /inheritance:r `
    /grant:r "SYSTEM:(OI)(CI)F" "BUILTIN\Administrators:(OI)(CI)F" `
            "NT AUTHORITY\Authenticated Users:(OI)(CI)RX" "BUILTIN\Users:(OI)(CI)RX"
```

> **这一步不做会怎样**（`VERIFY §74.4` 实测）：`doctor` 的 `vault-acl` 报
> 「共享区对广泛组有写权限: NT AUTHORITY\Authenticated Users」，`deploy-verify` 连带 FAIL。
> **而且用 `/grant:r` 修不好** —— 继承来的那条不受它影响，必须先 `/inheritance:r`。

**内部区 NTFS 收紧**（内部区只有公司侧读写，普通用户与 `Authenticated Users` 不放进来）：

```powershell
icacls "$VaultRoot\vault-internal" /inheritance:r `
    /grant:r "SYSTEM:(OI)(CI)F" "BUILTIN\Administrators:(OI)(CI)F" "$env:USERNAME:(OI)(CI)F"
```

> 本机 2026-11-09 实测 `D:\anc\vault-internal` 的 ACL 就是 `SYSTEM` / `BUILTIN\Administrators` /
> 当前登录用户（`DNT`）三条完全控制。员工只读访问走下面的 SMB 共享，不直接碰内部区。

**SMB 共享**（员工机 / 其他授权账号用 `\\<主机>\anc-vault-shared` 只读访问共享区）：

```powershell
# 共享层：Administrators 完全控制；Authenticated Users 只读。
# 共享层 + NTFS 层叠加后才是「全员只读」（NTFS 已在上一段收紧）。
# 已有同名共享时先删：Remove-SmbShare -Name 'anc-vault-shared' -Force
New-SmbShare -Name 'anc-vault-shared' -Path "$VaultRoot\vault-shared" `
    -FullAccess 'BUILTIN\Administrators' -ReadAccess 'Authenticated Users'
```

> 本机实测：`Get-SmbShareAccess -Name anc-vault-shared` → `BUILTIN\Administrators` Full、
> `NT AUTHORITY\Authenticated Users` Read；`doctor` 的 `smb` 项按这个判 PASS。
> 共享名固定为 `anc-vault-shared`（doctor 查的就是这个名字），路径由 `-VaultRoot` 推出 `<VaultRoot>\vault-shared`。

**HTTP 面 token**（`%ProgramData%\anc\secrets\service-token.txt`）：

```powershell
# 32 字节随机数 → 64 个 hex 字符；无 BOM、无换行
$Root = Join-Path $env:ProgramData 'anc'
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$hex = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
Set-Content "$Root\secrets\service-token.txt" -Value $hex -Encoding ASCII -NoNewline
# 新文件不继承 secrets 的 ACE，写完必须重跑 set-acl（否则 doctor 的 secrets-acl 会红）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\set-acl.ps1 -Root $Root -Apply
```

> **未配置 token 时 `anc-http` 的业务路由一律 503**，只有 `/__anc_health` 可用；
> `/__anc_status` 需要 `Authorization: Bearer <token>`（契约见 `LOCAL-SERVICE.md`）。
> 本机实测 token 文件为 64 个 hex 字符（32 字节），`doctor` 的 `secrets-acl` PASS。

**成功判据**：

```powershell
# 两个都要是 true
Test-Path (Join-Path $VaultRoot 'vault-shared\.git')
Test-Path (Join-Path $VaultRoot 'vault-internal\.git')
# 内部区必须有 collab（任务投影会写这里，没有就会报错）
Test-Path (Join-Path $VaultRoot 'vault-internal\collab')
# 模板铺进去了（4 份 collab + 1 份 company）
Test-Path (Join-Path $VaultRoot 'vault-internal\collab\任务看板.md')
Test-Path (Join-Path $VaultRoot 'vault-shared\company\problem-model.md')
# SMB 共享存在（doctor 的 smb 项也查这个）
Get-SmbShare -Name 'anc-vault-shared'
# service-token 是 64 个 hex 字符（32 字节）
(Get-Content (Join-Path $env:ProgramData 'anc\secrets\service-token.txt') -Raw).Trim() -match '^[0-9a-f]{64}$'
```

**失败了怎么办**：

- **`git init` 失败** → 检查 git 装了没（§3 应该已经拦住了）、vault 盘可写
- **内部区和共享区路径相同** → `cli` 会拒绝（A2A 要求内部区是独立 git 目录且不能是共享区）。改成两个不同目录

**装完**：

```powershell
powershell -File scripts\deploy\deploy-state.ps1 -Side company -Mark vault -AsDone
```

---

## 10. org（写 org 数据）

**做什么**：写 `company.md` + `members/*.md` + `depts/*.md` + `roles/*.md`，然后渲染。

### 10.0 先让脚本生成，不要手抄

这些字段访谈阶段**已经全问过一遍**了（`data\deploy-answers.json`），没有理由再手写十几份 frontmatter——字段漏一个、拼错一个，要到 render 才报错。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$Root\tools\org-write.ps1" -VaultRoot D:\anc -Json
```

它会生成：`company.md`（`boss` 自动取唯一 owner 成员的 id）、`members/<id>.md`、`depts/<id>.md`（从成员的 `dept` 去重）、`roles/{owner,manager,employee}.md`（从 `org.example\roles` 复制，三份缺一不可）。

**默认不覆盖已存在且内容不同的文件。** org 是运行数据，可能有人手改过（补 userid、改 `manages`）。冲突会列出来、`ok:false`、退出码 1；确认要以 answers 为准再加 `-Force`。全部一致时第二次跑只报 `skipped`（幂等）。

生成后仍要手工补 answers 里没有的字段：`manages`、部门的 `skills` / `vault_paths` / `note`。下面是从零手写的完整做法，作为兜底保留。

```powershell
$VaultRoot = 'D:\anc'
$org = Join-Path $VaultRoot 'org'
```

### 10.1 company.md（必需）

```yaml
---
name: <公司名>                    # §1 第 4 项
company_bot_name: <bot 名字>      # §1 第 5 项
vault_shared: D:\anc\vault-shared
vault_internal: D:\anc\vault-internal
local_workdir: C:\Users\<用户名>\WorkBuddy\Claw
---
```

**这 5 个字段都是必需的**，少一个渲染会报"缺少字段"。

**怎么写这个文件**（编码值得注意）：

```powershell
$org = "$VaultRoot\org"
New-Item -ItemType Directory -Path $org -Force | Out-Null

# 用 .NET 写无 BOM 的 UTF-8。不要用 Set-Content -Encoding UTF8 ——
# PS 5.1 下它会加 BOM。渲染器虽然已经兼容 BOM（VERIFY §34 修过），
# 但无 BOM 更干净，也省得以后换工具再踩一次。
$body = @'
---
name: <公司名>
company_bot_name: <bot 名字>
vault_shared: D:\anc\vault-shared
vault_internal: D:\anc\vault-internal
local_workdir: C:\Users\<用户名>\WorkBuddy\Claw
---
'@
[IO.File]::WriteAllText("$org\company.md", $body, (New-Object Text.UTF8Encoding($false)))

# 确认没 BOM（前三个字节不应该是 EF BB BF）
$b = [IO.File]::ReadAllBytes("$org\company.md")
if ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { Write-Host "有 BOM（渲染器兼容，但不理想）" } else { Write-Host "无 BOM，OK" }
```

**depts / members / roles 的 `.md` 同样用这个写法。**

**`local_workdir` 是什么**：WorkBuddy 的工作目录。默认是 `%USERPROFILE%\WorkBuddy\Claw`。不确定就先跑一次 `Get-ChildItem "$env:USERPROFILE\WorkBuddy"` 看实际名字。

### 10.2 roles/*.md（可选，但建议至少一个）

```yaml
---
id: eng
name: 工程师
duties: 写代码、看工艺文档
---
```

### 10.3 depts/*.md（可选；有部门就写）

```yaml
---
id: engineering
name: 研发部
vault_paths: shared/工艺, internal/研发
skills: anc-task, anc-vault-read, anc-feedback
---
```

**注意**：`vault_paths` 和 `skills` 是**逗号分隔的字符串**，不是 YAML 数组（解析器只接受 `key: value`）。

**这两个字段决定什么**：
- `skills` 为空 → 该部门的 bot 用**全部**技能
- `vault_paths` 为空 → 能看**全部** vault 目录
- **空不是"什么都不给"**

### 10.4 members/*.md（每个人都有）

```yaml
---
id: zhangsan                    # 小写字母数字 _ -，≤64
name: 张三
role: eng                       # 必须对应 roles/ 里存在的 id
userid: <企微 userid>            # §1 第 8 项
chat_id: <32 字符 chatId>        # §1 第 10 项
dept: engineering                # 必须对应 depts/ 里存在的 id
webhook_file: zhangsan-bot.txt   # secrets 目录下的文件名（不是路径）
---
```

**校验会拦住的**：
- `dept` 指向不存在的部门 → **报错**（技能集和 vault 范围会落空）
- `role` 指向不存在的角色 → **报错**
- 拼错字段名 → **报错**（`skill` 少个 `s` 就会被拒）
- `webhook_file` 写成路径 → **报错**（只能是文件名）

> ⚠ **`userid` 用哪个值（2026-11-09 实测校正，GAP-072）**：WorkBuddy 的企微 AI Bot 把发送者归一成 `wok…` 形式的**会话级 open id**，补丁注入到消息前缀的 `from=` 就是这个值，**不是企微通讯录里的账号 userid**。`bind actor` 按 `member.userid` 精确匹配，所以：
> 1. 先让本人在目标群发一条消息（或私聊 bot），从 `%ProgramData%\anc\data\patch-in.log` 读实际 `from=`；
> 2. 把 `member.userid` 写成这个实际值（通讯录账号仅作人工对照，不要写进去）；
> 3. 重跑 `render deploy --db` + `bind verify-org`，再用 `bind actor` 验证。
> 通讯录账号在员工机侧/人工沟通里仍有意义，但公司侧的入站身份以 AI Bot 上报值为准。
>
> **首次绑定已自动化（2026-11-09，GAP-074）**：不用管理员手工读日志。公司 bot 在 `bind actor` 查不到人时，会请对方回复一次姓名（若第一条消息已自报「我是X」则直接绑），然后执行：
> ```powershell
> powershell -NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\anc\bin\bind-member-identity.ps1 -Name "<姓名>" -Userid "<from>"
> ```
> 脚本按姓名/成员 ID 找 `D:\anc\org\members\<id>.md`，把 `userid` 写成实际 sender id → 重渲染 → `sync-org`；下一条消息即可识别。找不到/重名时返回 `person-not-found` / `ambiguous`，bot 会请老板/管理员确认，不猜人。

### 10.5 webhook 文件（每个群一个）

```powershell
# 推荐：脚本写（校验文件名与 https、UTF-8 无 BOM 无换行、写完自动重设 secrets 的 ACL）
powershell -NoProfile -ExecutionPolicy Bypass -File "$Root\tools\wecom-setup.ps1" -Set 'zhangsan-bot.txt=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx;company-bot.txt=https://...' -Apply
# 多个条目也可以走文件：{"zhangsan-bot.txt":"https://...","company-bot.txt":"https://..."}
powershell -NoProfile -ExecutionPolicy Bypass -File "$Root\tools\wecom-setup.ps1" -FromFile hooks.json -Apply
# 只看现有的（只显示域名与 key 前 6 位，不打印完整地址）
powershell -NoProfile -ExecutionPolicy Bypass -File "$Root\tools\wecom-setup.ps1" -List
```

> **为什么必须无 BOM、无结尾换行**：读方把整个文件内容当 URL 用，末尾多一个 `\r` 就是 400。手写 `Set-Content` 很容易带上，脚本替你处理掉。

手写版本（对照）：

```powershell
# 从 §1 第 3 项拿到的 webhook，写到 secrets 目录
# 一个员工一个文件，文件名和 member 的 webhook_file 对上
Set-Content "$Root\secrets\zhangsan-bot.txt" -Value '<完整 webhook URL>' -Encoding UTF8 -NoNewline
```

### 10.6 渲染 + 装 persona

**这两步是分开的，别混**：

```powershell
# ① 渲染 + 事务部署 + org→DB 同步/校验
#    用仓库里的 cli.ts（渲染器本体），不是 deploy-persona.ps1
node --no-warnings "$Repo\src\render\cli.ts" deploy --org $org --out "$Root\render" --db "$Root\data\anc.db"

# ② 装：把渲染出来的公司 bot persona 复制到 WorkBuddy 读的位置
#    deploy-persona.ps1 只做这一步（它不渲染）
powershell -NoProfile -ExecutionPolicy Bypass -File "$Root\tools\deploy-persona.ps1" -Source "$Root\render\company-bot\CODEBUDDY.md"
```

**成功判据**：

```powershell
# 渲染产物存在
Test-Path "$Root\render\company-bot\CODEBUDDY.md"
Test-Path "$Root\render\groups.json"
# members / groups 都要有：groups 里应出现 employee/department/company/boss_dm（没有配的群不会生成）
node -e "const j=require('fs').readFileSync(process.argv[1],'utf8');const o=JSON.parse(j);console.log('members=',o.members.length,'groups=',(o.groups||[]).map(g=>g.type).join(','))" "$Root\render\groups.json"
```

> **⚠ 验证 `groups.json` 时不要用 `Get-Content -Raw | ConvertFrom-Json`。**
>
> PowerShell 5.1 的 `Get-Content -Raw` **默认按 ANSI（本机代码页）解码**，而这个文件是 UTF-8。
> 结果是中文姓名/部门名变成 `绠＄悊鍛?` 这类 mojibake，**mojibake 里的引号会破坏 JSON 结构**，
> `ConvertFrom-Json` 报「传入的对象无效」—— 看起来像渲染产物坏了，**其实产物是好的**。
>
> **判据要放在"读数方式没错"的前提下才有效。** 三种正确读法：
>
> ```powershell
> # ① 用 node（推荐，纯 ASCII 判定）—— 上面那条就是
> # ② PowerShell 里显式指定编码
> [IO.File]::ReadAllText("$Root\render\groups.json", [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
> # ③ 只验结构不验中文（避开编码）
> (Get-Content "$Root\render\groups.json" -Raw -Encoding UTF8 | ConvertFrom-Json).members.Count
> ```
>
> **同一个坑还会打到 `bind list` 的 JSON 输出**：`cli.ts` 打 UTF-8 到 stdout，
> PS 5.1 按 GBK 解码 → 中文变乱码 → `ConvertFrom-Json` 失败 → 你会以为「库里没有绑定」，
> 从而误判 `bot-reply` 的 SKIP 原因。**判断"库里有没有绑定"要用 `bind list` 的退出码和原始输出，**
> **或者直接用 node 读库**（`VERIFY §81.4` #4）。
>
> 2026-11-05 一次真机从零装：他先报 `bindings` WARN「读绑定失败」，自己查清是编码问题
> 而不是库坏了 —— **这个区分很重要**，因为前者要改代码、后者只要换读法。

**失败了怎么办**：

| 报错 | 意思 | 怎么做 |
|---|---|---|
| `缺少字段: name` | `company.md` 少了字段 | **注意**：也可能是文件带 BOM 导致解析失败（`VERIFY §34`）。用 `Set-Content -Encoding utf8NoBOM` 或 node 写 |
| `有不认识的字段: skill` | 拼错了 | 改成 `skills` |
| `引用了不存在的部门: xxx` | `depts/` 里没有 | 建那个部门文件，或改 member 的 `dept` |
| `persona 超过 7500 字节` | 模板太长 | 删掉 persona 里不必要的段落。**渲染器和 `deploy-persona.ps1` 现在闸门同值**（7500 报错 / 6500 警告）：2026-11-10 之前 `deploy-persona` 在 6500 就硬失败，于是渲染「成功」的 persona 到安装这一步装不上（当时线上 6470B，差 30 字节就卡死） |
| `成员没有 userid，跳过` | 只是警告 | 补上 userid 后重跑 |

**装完**：

```powershell
powershell -File scripts\deploy\deploy-state.ps1 -Side company -Mark org -AsDone
```

---

## 11. wecom（配企微）

**这一节有一半是人在企微后台做的，你做不了。** 分清楚：

### 11.1 人做的（企微管理后台）

| 做什么 | 在哪 | 为什么 |
|---|---|---|
| ~~建自建应用，拿 `corpId` + `secret`~~ | 管理后台 → 应用管理 | **⚠ 不需要，见下面的说明** |
| 建**员工群**（本人 + 公司 bot + 个人 bot + 群机器人） | 企微客户端 | 员工群 = 一人一群的兼容层 |
| 建**部门群 / 公司大群 / 老板 1:1**（或私有群 fallback） | 企微客户端 | 四类群的身份边界 |
| 群里加**群机器人**，拿 webhook | 群设置 → 群机器人 | 提醒/通知从这个 webhook 发 |
| 把四类群 chatId + webhook 文件名交给 agent | 见 §1 第 10/10b 项 | 写进 `company.md` / `depts/*.md` |
| 通讯录里查每个员工的 **userid** | 管理后台 → 通讯录 | §10.4 要用 |
| 给需要和公司 bot 对话的员工分配 **WorkBuddy 席位 / 可使用成员** | 管理后台 → 智能专区 → 智能机器人 → 机器人管理 → WorkBuddy | 未分配时员工发消息会被企微拦截：**“你不在该智能机器人的可使用范围，无法与它聊天”**（2026-11-09 实测）；也可开启「成员领用设置」让员工自己领，减少逐个手工分配 |

> **⚠ `corpId` / `corpSecret` 其实不需要（2026-11-05 查证，`VERIFY §77`）**
>
> §11.1 原来写着「建自建应用，拿 corpId + secret —— bot 要用它发消息」。**这句是错的。**
> 实际两条路都不用它：
>
> | 方向 | 走什么 | 凭据在哪 |
> |---|---|---|
> | **出站**（机器人发消息） | **群机器人 webhook** | `secrets\webhook.txt` / `ops-webhook.txt` |
> | **入站**（bot 收群消息） | **WorkBuddy 自带的企微机器人** | WorkBuddy 自己的 `settings.json`（`automation.wecomPushConfig`） |
>
> 全仓库代码里 `corpid.txt` / `corpsecret.txt` 的引用数是 **0**（`outbound-scan.ts` 只是扫描出站内容里
> 出现 `corpsecret` 字样**防泄密**，`doctor.ps1` 只是 `git grep` 查它**有没有进 git** —— 都不是在用）。
>
> **什么时候才需要**：要用**自建应用 API** 主动给某个人发私信、或查通讯录时。当前架构不走这条路。
> 真要用再建，建完写进 `secrets\corpid.txt` / `corpsecret.txt` 即可（ACL 已经覆盖这个目录）。

### 11.2 你做的（写配置）

```powershell
# 群机器人 webhook（这是唯一的必需凭据，放 secrets 目录，不进 git）
Set-Content "$Root\secrets\wecom-webhook.txt" -Value '<群机器人 webhook>' -Encoding UTF8 -NoNewline
#
# 出站还要两份同样的地址（脚本按名字找）：
Copy-Item "$Root\secrets\wecom-webhook.txt" "$Root\secrets\webhook.txt" -Force
Copy-Item "$Root\secrets\wecom-webhook.txt" "$Root\secrets\ops-webhook.txt" -Force
```

> **`corpid.txt` / `corpsecret.txt` 不用建** —— `§11.1` 已说明当前架构不用自建应用（`VERIFY §77`）。
> 早先这一节的代码块还在教人写这两个文件、成功判据也要求它们存在且 ≥8 字节，
> 结果会逼人编一个假的 corpId 出来。**2026-11-05 已删（`VERIFY §81.8`）。**

> **⚠ 建完 `secrets` 目录后必须再跑一次 `set-acl.ps1`** —— 这是 §11 最容易漏的一步。
>
> `deploy.ps1` 里调 `set-acl.ps1` 的那一刻，`secrets` 目录还不存在（仓库里没有 `secrets/` 源目录），
> 所以它会打印 `secrets 不存在，跳过（建完 secrets 要再跑一次本脚本）` 然后继续。
> **你在这里手动 `New-Item` / `Set-Content` 建出来的目录和文件，继承的是父目录的 ACE，**
> **不是 `secrets` 该有的那三条。** 症状：`Copy-Item` / `icacls` / `SetAccessControl` /
> `takeown` / `Remove-Item` 全被拒（管理员连 WRITE_DAC 都拿不到），`doctor` 的 `secrets-acl` 会红。
>
> ```powershell
> powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\set-acl.ps1 -Root $Root -Apply
> ```
>
> 2026-11-05 一次真机上从零装就卡在这：那位 agent 试了五种方法全被拒，
> 最后靠一次性 SYSTEM 计划任务重置 DACL 才解决（`VERIFY §81.4` #5）。

**成功判据**：

```powershell
# 三个 webhook 文件存在且非空（wecom 是主，webhook/ops 是脚本按名字找的副本）
@('wecom-webhook.txt','webhook.txt','ops-webhook.txt') | ForEach-Object {
    $f = Join-Path $Root "secrets\$_"
    if (-not (Test-Path $f)) { throw "缺 $_" }
    if ((Get-Item $f).Length -lt 40) { throw "$_ 太短，webhook 应该 80+ 字符" }
    if ((Get-Content $f -Raw) -notmatch 'qyapi\.weixin\.qq\.com/cgi-bin/webhook/send\?key=') { throw "$_ 不是群机器人 webhook 形态" }
}
# 新建的文件必须继承到三条 ACE（管理员可读）—— 这一条能抓到"忘了重跑 set-acl"
Get-ChildItem "$Root\secrets" -File | Where-Object { $_.Name -like '*webhook*' } | ForEach-Object {
    $adm = @((Get-Acl $_.FullName).Access | Where-Object { $_.IdentityReference.Value -match 'Administrators' -and $_.AccessControlType -eq 'Allow' })
    if ($adm.Count -eq 0) { throw "$($_.Name) 没给管理员权限 —— 重跑 scripts\deploy\set-acl.ps1 -Apply" }
}
# ACL：secrets 不能对广泛组可读（Everyone / BUILTIN\Users / Authenticated Users）
#
# ⚠ 但 LOCAL SERVICE 必须保留读权限 —— anc-service 和 anc-http 都是以它运行的。
#   少了它，服务读不到 token，症状是 doctor 的 heartbeat FAIL，而任务记录显示
#   「每分钟成功、退出码 0」，日志文件却不动。这条是 2026-11-05 实测踩出来的（VERIFY §62.3）。
#
# ① 有没有广泛可读（期望空）
(Get-Acl "$Root\secrets").Access | Where-Object { $_.IdentityReference -match 'Everyone|BUILTIN\\Users|Authenticated' }
#
# ② 服务身份有没有读权限（期望至少一条；缺了就是收得太窄）
(Get-Acl "$Root\secrets").Access | Where-Object { $_.IdentityReference -match 'LOCAL SERVICE' }
#
# 收紧用的命令（两个方向都要顾到）：
#   icacls "$Root\secrets" /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' 'LOCAL SERVICE:(OI)(CI)RX'
```

**失败了怎么办**：

- **ACL 不对** → `doctor` 的 `secrets-acl` 项会 FAIL。按它的 `fix` 收紧
- **还没拿到 secret** → **可以跳过这一节，标记为 failed 并写清原因**。§12 的自证里 `bot-reply` 会是 SKIP。**不要编一个假 secret**

**装完**：

```powershell
# 拿到值了
powershell -File scripts\deploy\deploy-state.ps1 -Side company -Mark wecom -AsDone
# 没拿到（正常，等用户给）
powershell -File scripts\deploy\deploy-state.ps1 -Side company -Mark wecom -AsFailed -Reason "等用户提供 corpid/secret"
```

---

### 11.3 别忘了 data 目录的写权限（同一个坑的另一半）

`secrets` 是「服务要读」，`data` 是「服务要写」。**两个方向都要顾**，否则都会以伪装的方式失败：

```powershell
# 服务身份要能写日志，否则 anc-loop.cmd 的 >> loop.log 重定向失败，
# 任务显示"成功运行、退出码 0"，但 loop.log 的 mtime 不动 → doctor 的 heartbeat FAIL
icacls "$Root\data" /grant 'LOCAL SERVICE:(OI)(CI)M'

# 已经存在的日志文件不继承新 ACE，要逐个补
foreach ($f in 'loop.log','http.log','patch-in.log','patch-out.log','selfheal.log','audit.log') {
    $p = Join-Path "$Root\data" $f
    if (Test-Path $p) { icacls $p /grant 'LOCAL SERVICE:(M)' | Out-Null }
}
```

**验证方式**（读 ACL 不够，要实地跑）：造一个 `LOCAL SERVICE` 身份的临时任务跑 `anc-loop.cmd`，看 `loop.log` 的 mtime 有没有变。完整脚本见 `REBUILD.md §2.5`。

---

## 12. verify（自证）

**做什么**：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\deploy-verify.ps1 -Side company -Json
```

**成功判据**：`"ok": true`（`fail` 为 0）。

> **`backup-freshness` 需要"本地"备份存在。** `doctor` 查的是 `%ProgramData%\anc\backup\anc-*.db`
> （部署目录里的本地备份），**不是**离机副本（本机实测离机目标是 `D:\anc-backup`，而且它与本地同盘，
> 只发 WARN 不算真正离机，见 `OPS.md`「备份」）。
> 新装的机器还没跑过备份，所以第一次 `deploy-verify` 会在这里 FAIL。
> 按 fix 跑一次备份（或等 02:00 起的定时任务），再重跑本脚本即可：
>
> ```powershell
> # backup-anc.ps1 没有 -Root 参数：本地备份默认落 $Root\backup，-Destination 才是离机目标
> powershell -NoProfile -ExecutionPolicy Bypass -File "$Root\bin\backup-anc.ps1" -Destination '<独立盘或 UNC>'
> ```
>
> **不要为了让它变绿去改判据** —— 2026-11-05 那次就是先诊断出"`E:\anc-backup` 不算数"，
> 跑了一次备份后自然转绿（`VERIFY §81.4` #6）。

**输出长这样**（2026-11-09 本机实测；从仓库跑 `deploy-verify` 会把 `-Repo` 传给 `doctor`，WARN 数与直跑一致；从部署目录跑没有 `.git`，`secrets-in-git` 会多一条 WARN，总数 +1）：

```
=== deploy-verify (company) ===
根: C:\ProgramData\anc

  database       PASS  库存在: C:\ProgramData\anc\data\anc.db
  doctor         PASS  FAIL=0 WARN=3（34 项；2026-11-09 历史实测，现状 35 项 = 21 字面量 + 14 个 task-* 覆盖项）
  task-write     PASS  task #2 写进去了，查得回来
  bot-reply      SKIP  没有已绑定的群，也没有传 -ChatId
  tasks          PASS  14 个任务全部 Ready/Running

结果  PASS=4  FAIL=0  SKIP=1
NEXT  没有 FAIL，但有 1 项 SKIP——那不是通过，是没验。列在下面了。

# 说明（2026-11-09 本机实测；早先 2026-11-05 读数见 VERIFY §62）：
#  · doctor 直跑 34 项（2026-11-09 历史实测；现状 35 项 = 21 字面量 + 14 个 task-* 覆盖项）FAIL=0 WARN=3：work-hours（未配工作时段）、patch（没有补丁日志）、
#    bindings（没有群绑定）——都是设计内的，不是缺陷。
#  · canary 在 15:37 快照时还是 WARN；15:38 收到首条真实群消息（补丁注入到前缀）后转 PASS，
#    所以复跑 doctor 是 WARN=3。这也证明补丁的群身份注入在真实消息路径上生效。
#  · deploy-verify 2026-11-09 起给 doctor 传 -Repo；此前不传时 secrets-in-git 会多报一条 WARN（5 vs 4）。
#  · bot-reply 在「干净的机器上」通常是 SKIP 而不是 PASS —— 没有已绑定的群、也没有传 -ChatId。
#    这不是故障（VERIFY §62.5）。
#  · 任务是 14 个：9 LOCAL SERVICE / 2 SYSTEM / 3 交互类（DNT）。
#  · tasks 这项 2026-11-10 起按 OPS 任务表逐个核对名称（原来只判「拿到的都 Ready」，
#    只注册 3 个也会 PASS —— GAP-081 就是这么漏过去的）。非提权会话看不到服务任务时
#    这项是 SKIP 而不是 PASS/FAIL，要用管理员会话重跑才能核对全量。
```

**每一项什么意思**：

| 项 | 验什么 | FAIL 说明什么 |
|---|---|---|
| `database` | 库在 | 部署没做完 |
| `doctor` | 35 项（21 字面量 + 14 个 task-* 覆盖项）体检全过 | 有具体项坏了，看 detail |
| `task-write` | 写一条能查回来 | **库能写才是真能干活**；写不进去说明服务起不来或库锁了 |
| `bot-reply` | 注入一条消息 | 409（还没有实例引用）是 SKIP 不是 FAIL；端口没监听也是 SKIP；只有真正注入失败才 FAIL。**「没等到回复」仍是 PASS**（回复慢是模型行为） |
| `tasks` | 14 个任务 Ready/Running | 有一个卡住就说明装机不完整 |
| `executor` | 主干2 部署后自动收尾 | 有 `data\executor-deploy.json` 且 `ok:true` = 工作区已加入、TEST 已回、当天 host 已建；WARN 表示还等 patch-guard 或需手动 `tools\setup-executor.ps1 -Apply`；SKIP = 未启用主干2（无 `wb-wake.flag`） |

**`SKIP` 不是通过**——它是"没验"。常见 SKIP：

- `bot-reply` SKIP → 看 `detail` 字段，**三种原因**：
  - **「没有已绑定的群，也没有传 -ChatId」** → 群还没配；装完群后用 `-ChatId <真实chatId>` 重跑这一项。
  - **「还没有实例引用」**（后端是 409）→ 正常。`test-emit` 依赖一个活的 `WecomAiBotClient` 实例，
    而它只在 bot 收到过**真实群消息**之后才有值。**先去群里 @ 一次 bot，再重跑本脚本。**
    只建 `test-emit.flag` 解决不了这个。
  - **「test-emit 关闭」** → 建 `%ProgramData%\anc\data\test-emit.flag`，重启 WorkBuddy，等 8–30 秒。
    注意 flag 是**启动时读一次**，建完必须重启，再跑。
- 有 SKIP 时告诉用户"这几项没验，原因是 X"。

**失败了怎么办**：按每项的 `fix` 处理。改完**只重跑那一项也行**（`-SkipBot` 可以跳过 bot 那项）。

**装完**：

```powershell
powershell -File scripts\deploy\deploy-state.ps1 -Side company -Mark verify -AsDone
```

**§12 全绿之后**，把这段告诉用户：

```
公司侧部署完成。
  doctor: FAIL=0 WARN=3（35 项，21 字面量 + 14 个 task-* 覆盖项）
  群回应: <PASS/SKIP 及原因>
  任务落库: OK
  计划任务: 14/14
未完成: <列出来，没有就写"无">
```

---

## 13. 装到一半失败怎么办

**不要从头重装。** 进度记在 `%ProgramData%\anc\data\deploy-state.json`：

```powershell
# 看现在到哪了
powershell -File scripts\deploy\deploy-state.ps1 -Side company -Json
```

输出里的 `next` 会明确说：

| 情况 | `next` 说什么 |
|---|---|
| 没开始 | `还没开始。先跑 preflight.ps1...` |
| 卡在某节 | `上次卡在 patch（ANCHOR-MISS）。修好之后重跑那一步，再 -Mark patch -AsDone。**不要从头来**。` |
| 做完了 | `全部阶段已完成。` |

**流程**：

1. `-Status` 看 `failed` 是哪节
2. 修那一节的问题（每节的「失败了怎么办」有写）
3. **只重跑那一节**
4. `-Mark <那节> -AsDone`

**`-Mark -AsFailed` 要带原因**：

```powershell
powershell -File scripts\deploy\deploy-state.ps1 -Side company -Mark patch -AsFailed -Reason "ANCHOR-MISS: 版本 5.9.5"
```

**原因要具体**，因为下次（可能是你，也可能是别的 agent）要靠它判断怎么修。

---

## 14. 重装与卸载

### 只想重跑某一节

直接重跑那节的命令，不用 `-Mark` 重置——`-Mark -AsDone` 是幂等的（重复 mark 同一个不会出错）。

### 完全重装（会丢数据）

**先备份**：

```powershell
# 库 + secrets + vault 的 git
powershell -File "$Root\bin\backup-anc.ps1" -Destination 'E:\anc-backup'
Copy-Item "$Root\secrets" 'E:\anc-backup\secrets' -Recurse
```

**清进度**（不删数据，只让状态归零）：

```powershell
powershell -File scripts\deploy\deploy-state.ps1 -Side company -Reset -Apply
```

**真删数据**（`anc.db` / vault 都删）：

```powershell
# 任务
Get-ScheduledTask -TaskName 'anc-*' | Unregister-ScheduledTask -Confirm:$false
# WorkBuddy 补丁
# 补丁是**运行时注入**（内存里给模块源码拼接，不写盘），所以没有"卸载补丁"这个动作。
# 重装时只需要：① 删掉状态文件 ② 之后用 -NoPatch 启动一次
Remove-Item "$Root\data\patch-state.json" -Force -ErrorAction SilentlyContinue
powershell -File "$Root\patch\launch-patched.ps1" -NoPatch   # 不带补丁启动
# 部署目录（保留 backup 和 secrets）
Remove-Item "$Root\service","$Root\ingest","$Root\render","$Root\shared","$Root\bin","$Root\light","$Root\patch","$Root\data" -Recurse -Force
# vault：**想清楚再删**，这是公司资料
```

### 回滚到部署前

```powershell
# 运行件回滚（用 deploy.ps1 的备份）
powershell -File scripts\deploy\deploy.ps1 -Rollback
# 技能回滚
powershell -File scripts\deploy\deploy-skills.ps1 -Rollback
# 补丁关闭（不改文件，只让 preload 不注入）。两种等价做法：
powershell -File "$Root\patch\launch-patched.ps1" -NoPatch      # 本次不带补丁启动
# 或设环境变量 ANC_WB_PATCH=0（preload.cjs 看到它就 module.exports={} 直接退出）
```

---

## 15. 日常升级（不重装、不丢数据）

> 前提：这台机器已经部署过，仓库在本机（`git clone` 过）。首次部署不用看这节。

### 15.1 先看有没有新版本

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$Root\tools\upgrade.ps1" -Action check -Side company -Json
```

- `behind: 0` → 已是最新，不用动
- `behind: N` → 远端领先 N 个提交；`incoming` 里是提交标题，念给人听

### 15.2 升级

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$Root\tools\upgrade.ps1" -Action apply -Restart -Json
```

脚本按顺序做，每步独立报结果：

1. **备份数据库**（强制，跳过幂等间隔；显式传 `-SourceDb`，不依赖脚本默认的 `%ProgramData%`）
2. `git pull --ff-only`（本地有未提交改动会失败——这是对的）
3. **铺运行件**（`deploy.ps1 -Apply`，逐文件 hash 对拍，任一失败整体回滚）
4. 同步技能
5. 重渲染 + 安装 persona
6. 重启 WorkBuddy（`-Restart` 才有）
7. `deploy-verify` 自证

不加 `-Restart` 就只铺文件，技能与 persona 在**下一次会话**生效。

### 15.3 为什么数据不会丢

部署清单里**没有** `data\`、`org\`、`backup\`、`secrets\`、vault 两区。升级只覆盖 `core / modules / service / interfaces / shared / bin / tools / patch / light\templates`。

- 数据库 schema 变化由 `src/core/migrate.ts` 在 cli 打开时自动做，**只增不改**（加表加列，不删数据）
- 升级前强制备份一份到 `$Root\backup`
- 任一步失败，`deploy.ps1` 会把运行件整体回滚；数据库在升级过程中根本没被写过

### 15.4 权限：为什么第一次要管理员

bot 在群里回话时是**普通权限**（WorkBuddy 以登录用户跑，普通 token 的 Administrators 是 deny-only），而 `C:\ProgramData\anc` 默认只有管理员能写。

```powershell
# 管理员跑一次；只给运行件目录授 Modify，secrets\ / data\ 不动
powershell -NoProfile -ExecutionPolicy Bypass -File "$Root\tools\upgrade.ps1" -Action apply -GrantDeployWrite
```

不授权也能升级，但只能升 `%USERPROFILE%` 那部分（技能、persona），运行件会返回**退出码 3** 并提示这句。

### 15.5 在群里一句话升级

装了 `anc-update` 技能之后，群里说「项目有更新」/「升级一下」/「更新到最新」即可。

> **只有 boss / manager 能触发。** 升级会重启主机上的 WorkBuddy；群里任何人都能发消息，不能让人随便重启公司主机。员工侧（自己电脑）本人说就做。

### 15.6 回滚

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$Root\tools\upgrade.ps1" -Action rollback -Json
```

读 `data\version.json` 的 `prevRev`，`git checkout` 回去再重铺运行件。

> **这不是恢复数据库。** 升级全程没写过库；要恢复数据用 `backup-anc.ps1` 的快照。

---

## 附：全部命令速查

```powershell
# ── 访谈（必须最先跑）──
powershell -File scripts\deploy\deploy-kickoff.ps1 -Phase identity                    # 第一问：谁装、哪一侧
powershell -File scripts\deploy\deploy-kickoff.ps1 -Phase prepare -Side company -Role boss   # 递准备清单给人
powershell -File scripts\deploy\deploy-kickoff.ps1 -Phase collect -Side company -Json        # 要问的信息
powershell -File scripts\deploy\deploy-kickoff.ps1 -Phase check   -Side company              # 校验，ok 才继续

# ── 只读检查（任何时候都能跑）──
powershell -File scripts\deploy\preflight.ps1 -Side company -Json        # 装之前
powershell -File scripts\deploy\deploy-state.ps1 -Side company -Json     # 进度
powershell -File scripts\deploy\deploy-verify.ps1 -Side company -Json    # 装完之后
powershell -File "$Root\bin\doctor.ps1" -Json                     # 健康

# ── 按顺序装 ──
powershell -File scripts\deploy\preflight.ps1 -Side company              # §3
# §4 建目录（见文档里的命令块）
powershell -File scripts\deploy\deploy.ps1 -Apply                         # §5
powershell -File scripts\deploy\deploy-skills.ps1 -Apply                  # §6
powershell -File "$Root\patch\launch-patched.ps1"                 # §7（会重启 WorkBuddy，自己等 patch-state）
powershell -File "$Root\tools\register-tasks.ps1" -Root $Root -Repo '<仓库根>' -Apply # §8（部署目录跑必须传 -Repo）
# §9 建 vault（见文档）
# §10 是两步，别只跑第二步：
node --no-warnings "$Repo\src\render\cli.ts" render --org $org --out "$Root\render"   # §10.6 ① 渲染
powershell -File "$Root\tools\deploy-persona.ps1" -Source "$Root\render\company-bot\CODEBUDDY.md"  # §10.6 ② 装
# §11 写企微凭据（见文档）
powershell -File scripts\deploy\deploy-verify.ps1 -Side company          # §12

# ── 每一步之后 ──
powershell -File scripts\deploy\deploy-state.ps1 -Side company -Mark <id> -AsDone
```

**退出码约定**（所有脚本一致）：

| 码 | 意思 |
|---|---|
| 0 | 成功（含 dry-run、含"决定不做"） |
| 1 | 校验失败 / 有 FAIL / 决定要做但失败了 |
| 2 | 用法或环境错误 |

---

## 人类在环取证（HIL，2026-11-12 补充）

**自动取证优先**：agent 先读 `deploy-answers.json`、`anc.db`/bind、`org`/`render`、`patch-in.log`、WorkBuddy 数据；能自己确认的 chatId、userid、成员身份、bot 是否在群，不要再让人截图。只有自动拿不到、或自动结果与安装人说法冲突时，才让人发截图 / 在群里 @bot / 口述关键字段。

安装 agent **不能只靠安装人的口头回答**。群 chatId、userid、管理员身份、bot 是否真在群里回应、机器是否干净，这些都要让安装人做一个**可交叉验证的动作**：

| 信息 | 让安装人做什么 | agent 拿什么 | 判据 |
|---|---|---|---|
| 群 chatId / webhook | 打开群设置，发截图；建群机器人后发“只显示文件名”的截图 | 截图 + 群里实际消息 | chatId 32 字符；webhook 明文不进群、只进 secrets |
| 成员 userid / 姓名 / 部门 | 发企微成员资料页截图 | 截图 + `bind actor` 结果 | 三者一致；不一致停下来问 |
| 管理员 / 提权 | 发管理员 PowerShell 截图或 `IsAdmin=True` 回显 | 截图/命令回显 + preflight | preflight 无 blocker |
| 公司 bot 在群里回话 | 让安装人在目标群 @ 公司 bot 发一条“我是谁” | `patch-in.log` 的真实入站与回复 | 有 chatId/from/msg 前缀，bot 有回复 |
| 干净机 / Z | 发目录清单、安装前截图、Node/Git/WorkBuddy 版本截图 | 截图 + 命令回显 | 与 Z-01 判据一致 |

规则：

- **口头“我发了”不算证据**；截图、群消息、日志、命令回显至少有一种。
- 截图看不清/模型读不了时，让安装人把**关键字段原文**再打一遍；不要猜。
- webhook/token/secret 一律不进群消息；只发“文件名/路径”，值走 secrets。
- 对不上时**停下**，让安装人重做；不要为推进而静默采用。