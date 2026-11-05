# 公司侧部署手册（给 agent 读）

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
| [1](#1-开工前问清这张表缺一不可) | — | **要问人的清单** | 读 1 分钟 + 等人回答 |
| [2](#2-第-0-步装一个空-workbuddy只有人能做) | `workbuddy` | 装空 WorkBuddy | 5–15 分钟（人做） |
| [3](#3-preflight前置检查) | `preflight` | 前置检查 | 10 秒 |
| [4](#4-dirs建目录) | `dirs` | 建 20 个目录 | 5 秒 |
| [5](#5-files部署运行件) | `files` | 部署运行件 + 渲染 | 30 秒 |
| [6](#6-skills装技能) | `skills` | 装 7 个技能（8 个文件，第 8 个是 .anc-backup） | 10 秒 |
| [7](#7-patch装补丁) | `patch` | 打 WorkBuddy 补丁 | 1–3 分钟 |
| [8](#8-tasks注册计划任务) | `tasks` | 注册 10 个任务 | 10 秒 |
| [9](#9-vault建两区) | `vault` | 建两区 vault | 30 秒 |
| [10](#10-org写-org-数据) | `org` | 写 org 数据 | 5–10 分钟 |
| [11](#11-wecom配企微) | `wecom` | 配企微（要人给值） | 5 分钟 + 等人 |
| [12](#12-verify自证) | `verify` | 自证 | 30 秒 |
| [13](#13-装到一半失败怎么办) | — | 断点续装 | — |
| [14](#14-重装与卸载) | — | 回滚 | — |

---

## 0. 你要装出什么

一台 7×24 的 Windows 主机，上面有：

```
C:\ProgramData\anc\        部署目录（15 个子目录）
D:\anc\                    vault + org + build
%USERPROFILE%\.workbuddy\  WorkBuddy 本体 + 技能
```

装完的状态：

- **公司 bot 在企微群里能回话**
- **10 个计划任务在跑**
- **`doctor` 30 项 FAIL=0**
- **能登记任务、能到点提醒、能入库**

**你不会做的事**：不装员工侧（那是另一份文档）、不配企微后台（人做，见 §11）。

---

## 1. 开工前：问清这张表（缺一不可）

**这一步不能跳。** 下面的值**只有人知道**，你不能编、不能猜、不能用占位符糊过去。

**做法**：把这张表整段发给用户，让他填。**填不全就先停在这里**，别往下做。

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
| 10 | **每个员工的群 chatId** | 群绑定 | 建群后从群设置里拿；**32 字符，不要截断** | 见 §10 |
| 11 | **管理员自己的 userid** | 私聊权限 | 企微通讯录 | `________________` |

**填不全时的行为**：

- **1、4、5、6 缺** → 停下来问。这些没有合理默认值。
- **2、3 缺** → 可以继续到 §10，但 §11 会卡住；`verify` 的 `bot-reply` 那项会是 SKIP。
- **7、8、9、10 缺** → 可以装出一个"没有员工"的公司侧（`groups.json` 0 个成员）。**能用，但没人能 @ 它**。装完告诉用户"员工还没配，配好之后重跑 §10 和 §12"。
- **11 缺** → 不影响装，但私聊谁都能用。**告诉用户这是安全缺口**。

---

## 2. 第 0 步：装一个空 WorkBuddy（只有人能做）

> **这一步 agent 做不了。** WorkBuddy 装不了自己。

**做什么**：让用户装 WorkBuddy，**装完不要配任何东西**。

**为什么强调"不要配"**：`§5` 会部署 persona 覆盖它；`§7` 会打补丁改它的行为。提前配的东西都会被覆盖掉，白费功夫，而且可能让后面对不上。

**给用户的原话**（可直接转述）：

```
请在这台机器上装腾讯 WorkBuddy（企业版），用管理员账号登录。
装完就停，不要建机器人、不要配企业、不要改设置——后面会自动配。
装好告诉我。
```

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

**失败了怎么办**：

- **找不到 exe** → 让用户确认装了；WorkBuddy 可能装在别的路径，用 `Get-ChildItem -Path C:\,D:\ -Filter WorkBuddy.exe -Recurse -ErrorAction SilentlyContinue` 找
- **没登录过** → 让用户启动它并登录企微
- **版本低于 5.9.3** → 补丁的锚点是按 5.9.3 写的。**先让用户升级**，或者告诉用户"这个版本没验过，装完可能要手工调锚点"（见 §7）

**装完**：

```powershell
powershell -File scripts\deploy-state.ps1 -Side company -Mark workbuddy -AsDone
```

---

## 3. preflight（前置检查）

**做什么**：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\preflight.ps1 -Side company -Json
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
powershell -File scripts\deploy-state.ps1 -Side company -Mark preflight -AsDone
```

---

## 4. dirs（建目录）

**做什么**：建 15 个部署子目录 + 5 个 vault 目录。

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
#   render        —— 渲染产物（§10.6 的 --out 指到 %ProgramData%ancender，
#                    但 vault 根下也可能有一个历史遗留的 render）
#   _acl-verify   —— D24 验 ACL 时的测试目录（可以删）
#   inbox/_originals 等运行时目录
@(Get-ChildItem $VaultRoot -Directory).Count   # 期望 >= 5
```

**失败了怎么办**：上一级的盘不存在（§3 的 `disk` blocker 应该已经拦住了）→ 回 §3。

**装完**：

```powershell
powershell -File scripts\deploy-state.ps1 -Side company -Mark dirs -AsDone
```

---

## 5. files（部署运行件）

**做什么**：

```powershell
# 先看计划（dry-run，不写任何东西）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Side company

# 确认无误再落盘
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Side company -Apply
```

**这一步做什么**：把 `src/` 和 `scripts/` 复制到 `%ProgramData%\anc\`，落盘前备份、落盘后**逐文件对拍 hash**、任一失败**整体回滚**。

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
powershell -File scripts\deploy.ps1 -Rollback
```

**装完**：

```powershell
powershell -File scripts\deploy-state.ps1 -Side company -Mark files -AsDone
```

---

## 6. skills（装技能）

**做什么**：

```powershell
# 预检（只比对，不写）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy-skills.ps1

# 落盘
#   默认目标 %USERPROFILE%\.workbuddy\skills（WorkBuddy 只读这里）
#   -Target 可指到别处（演练 / 多用户机）
#
# ⚠ 这个脚本**没有 -Side 参数**（VERIFY §76）。它不是按 side 分的，因为它只往用户目录写。
#   照别的小节的习惯顺手加 -Side company 会直接报 'A parameter cannot be found'。
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy-skills.ps1 -Apply
```

**这一步做什么**：把 `light\skills\*\` 复制到 `%USERPROFILE%\.workbuddy\skills\<技能名>\`。

**关键**：**落盘目录用 `SKILL.md` 里的 `name:` 字段，不是仓库目录名**。例：仓库目录是 `anc-ingest-company`，但 `SKILL.md` 写 `name: anc-ingest`，persona 也引用 `anc-ingest`。按目录名落盘会造出两个同名技能，bot 侧会冲突。

**成功判据**：

```powershell
# 应该是 7 个技能：anc-dayend / anc-feedback / anc-ingest / anc-interview / anc-task / anc-vault-read / anc-wb-patch
# 另外还会有 1 个 .anc-backup 目录（deploy-skills 的备份），它不是技能，别算进来。
# 早先这里写「8 个」，是把 .anc-backup 当成技能了 —— 照它做会一直以为少装了一个（VERIFY §55 P9）。
# 所以下面这条数目录的判据是 >= 7 且有 .anc-backup 之外的 7 个 SKILL.md：
@(Get-ChildItem (Join-Path $env:USERPROFILE '.workbuddy\skills') -Directory).Count
```

**失败了怎么办**：

- **数量不对** → 跑 `deploy-skills.ps1 -Apply -RemoveExtra`（顺便删掉线上多出来的技能）
- **误删了技能** → `deploy-skills.ps1 -Rollback` 恢复最近一次备份

**装完**：

```powershell
powershell -File scripts\deploy-state.ps1 -Side company -Mark skills -AsDone
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
powershell -File scripts\deploy-state.ps1 -Side company -Mark patch -AsDone
```

---

## 8. tasks（注册计划任务）

**做什么**：

```powershell
# dry-run：列出 10 个任务和它们的 principal，先看
powershell -NoProfile -ExecutionPolicy Bypass -File "$Root\bin\register-tasks.ps1" -Root $Root

# 落盘
powershell -NoProfile -ExecutionPolicy Bypass -File "$Root\bin\register-tasks.ps1" -Root $Root -Apply
```

> **交互类任务的运行身份（2026-11-05 校正，`VERIFY §76`）**：
> 三个交互类任务（`anc-workbuddy-launch` / `anc-patch-guard` / `anc-devbot`）的 principal 是
> `-BotUser` 指定的那个用户，而且**要求该用户已登录过**（要有 `C:\Users\<user>` 目录）。
>
> **按 D25，`-BotUser` 的默认值已经是 `Administrator`** —— 直接用管理员账号部署时不用再传。
> 早先默认值是 `anc-bot`，与 D25 矛盾：照默认值跑会报
> 「交互类任务要求 anc-bot 已登录过（当前没有用户配置目录）」，而 `REBUILD §4` 又写着不建专用用户。
> **如果确实要回到专用用户方案**：先切到那个用户跑一次（让它有配置目录），再
> `-BotUser <那个用户> -ForceInteractive`。

> **注意**：这里用的是**部署目录里的** `register-tasks.ps1`（`%ProgramData%\anc\bin\`），不是仓库里的。
> 部署目录那份运行时路径正确（§5 已经把它复制过去了）。

**这 10 个是什么**：

| 任务 | 干什么 | 频率 |
|---|---|---|
| `anc-service` | 本地小服务（tick） | 每分钟 |
| `anc-http` | HTTP 面（只绑 127.0.0.1） | 每分钟 + 开机 |
| `anc-watchdog` | 心跳/积压/进程告警 | 每 10 分钟 |
| `anc-backup` | SQLite + vault 备份 | 每小时（02:00 起） |
| `anc-boot-alert` | 开机后 WorkBuddy 没起来就告警 | 每 10 分钟 |
| `anc-cleanup` | 清企微附件（7 天前） | 每天 03:00 |
| `anc-update-watch` | 查厂商新版 | 每天 09:00 |
| `anc-workbuddy-launch` | 登录后拉起 WorkBuddy | 登录时 |
| `anc-patch-guard` | 补丁自愈 | 每分钟 |
| `anc-devbot` | devbot 自动启动 | 22:00 起每 30 分钟 × 8h |

**成功判据**：

```powershell
$t = @(Get-ScheduledTask -TaskName 'anc-*')
if ($t.Count -ne 10) { throw "应该是 10 个，实际 $($t.Count)" }
$bad = $t | Where-Object { $_.State -notin @('Ready','Running') }
if ($bad) { throw ('这些任务状态不对: ' + (($bad | ForEach-Object { $_.TaskName + '=' + $_.State }) -join ', ')) }
```

**失败了怎么办**：

- **任务被禁用** → `Enable-ScheduledTask -TaskName <名字>`
- **principal 不对**（应该是 LOCAL SERVICE 或 SYSTEM）→ 重新跑 `-Apply`；如果提示交互类任务要 `anc-bot` 用户，加 `-ForceInteractive`（但**先确认那个用户存在且登录过**，否则守卫和启动器不工作）
- **`register-tasks.ps1` 本身报参数错** → 说明部署的那份是旧版本。回 §5 重新部署

**装完**：

```powershell
powershell -File scripts\deploy-state.ps1 -Side company -Mark tasks -AsDone
```

---

## 9. vault（建两区）

**做什么**：两个**独立的 git 目录**——共享区（全员只读）、内部区（只有公司侧读写）。

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

**成功判据**：

```powershell
# 两个都要是 true
Test-Path (Join-Path $VaultRoot 'vault-shared\.git')
Test-Path (Join-Path $VaultRoot 'vault-internal\.git')
# 内部区必须有 collab（任务投影会写这里，没有就会报错）
Test-Path (Join-Path $VaultRoot 'vault-internal\collab')
```

**失败了怎么办**：

- **`git init` 失败** → 检查 git 装了没（§3 应该已经拦住了）、vault 盘可写
- **内部区和共享区路径相同** → `cli` 会拒绝（A2A 要求内部区是独立 git 目录且不能是共享区）。改成两个不同目录

**装完**：

```powershell
powershell -File scripts\deploy-state.ps1 -Side company -Mark vault -AsDone
```

---

## 10. org（写 org 数据）

**做什么**：写 `company.md` + `members/*.md` + `depts/*.md` + `roles/*.md`，然后渲染。

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

### 10.5 webhook 文件（每个群一个）

```powershell
# 从 §1 第 3 项拿到的 webhook，写到 secrets 目录
# 一个员工一个文件，文件名和 member 的 webhook_file 对上
Set-Content "$Root\secrets\zhangsan-bot.txt" -Value '<完整 webhook URL>' -Encoding UTF8 -NoNewline
```

### 10.6 渲染 + 装 persona

**这两步是分开的，别混**：

```powershell
# ① 渲染：从 org 数据生成 persona 和 groups.json
#    用仓库里的 cli.ts（渲染器本体），不是 deploy-persona.ps1
node --no-warnings "$Repo\src\render\cli.ts" render --org $org --out "$Root\render"

# ② 装：把渲染出来的公司 bot persona 复制到 WorkBuddy 读的位置
#    deploy-persona.ps1 只做这一步（它不渲染）
powershell -NoProfile -ExecutionPolicy Bypass -File "$Root\bin\deploy-persona.ps1" -Source "$Root\render\company-bot\CODEBUDDY.md"
```

**成功判据**：

```powershell
# 渲染产物存在
Test-Path "$Root\render\company-bot\CODEBUDDY.md"
Test-Path "$Root\render\groups.json"
# groups.json 里的成员数 = 你写的 member 文件数
# ⚠ 别用 (Get-Content ... -Raw | ConvertFrom-Json) 验这个文件 —— 见下面的说明

# 用 node 读（纯 ASCII 判定，不受控制台代码页影响）
node -e "const j=require('fs').readFileSync(process.argv[1],'utf8');const o=JSON.parse(j);console.log('members=',o.members.length,o.members.map(m=>m.name).join(','))" "$Root\render\groups.json"
# 每条的 dept/skills 都在（没部门的是 null/[]）
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
| `persona 超过 7500 字节` | 模板太长 | 删掉 persona 里不必要的段落 |
| `成员没有 userid，跳过` | 只是警告 | 补上 userid 后重跑 |

**装完**：

```powershell
powershell -File scripts\deploy-state.ps1 -Side company -Mark org -AsDone
```

---

## 11. wecom（配企微）

**这一节有一半是人在企微后台做的，你做不了。** 分清楚：

### 11.1 人做的（企微管理后台）

| 做什么 | 在哪 | 为什么 |
|---|---|---|
| ~~建自建应用，拿 `corpId` + `secret`~~ | 管理后台 → 应用管理 | **⚠ 不需要，见下面的说明** |
| 建**每个员工的群**（本人 + 公司 bot + 个人 bot + 群机器人） | 企微客户端 | 一人一群 = 身份边界 |
| 群里加**群机器人**，拿 webhook | 群设置 → 群机器人 | 提醒从这个 webhook 发 |
| 设**私聊限管理员** | 管理后台 → 应用 → 可见范围 | 否则谁都能私聊公司 bot |
| 通讯录里查每个员工的 **userid** | 管理后台 → 通讯录 | §10.4 要用 |

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
> powershell -NoProfile -ExecutionPolicy Bypass -File scripts\set-acl.ps1 -Root $Root -Apply
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
    if ($adm.Count -eq 0) { throw "$($_.Name) 没给管理员权限 —— 重跑 scripts\set-acl.ps1 -Apply" }
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
powershell -File scripts\deploy-state.ps1 -Side company -Mark wecom -AsDone
# 没拿到（正常，等用户给）
powershell -File scripts\deploy-state.ps1 -Side company -Mark wecom -AsFailed -Reason "等用户提供 corpid/secret"
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
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy-verify.ps1 -Side company -Json
```

**成功判据**：`"ok": true`（`fail` 为 0）。

> **`backup-freshness` 需要"本地"备份存在。** `doctor` 查的是 `%ProgramData%\anc\backup\anc-*.db`
> （部署目录里的本地备份），**不是** `E:\anc-backup` 那个离机副本。
> 新装的机器还没跑过备份，所以第一次 `deploy-verify` 会在这里 FAIL。
> 按 fix 跑一次 `anc-backup`（或等 02:00 的定时任务），再重跑本脚本即可：
>
> ```powershell
> powershell -NoProfile -ExecutionPolicy Bypass -File "$Root\bin\backup-anc.ps1" -Root $Root
> ```
>
> **不要为了让它变绿去改判据** —— 2026-11-05 那次就是先诊断出"`E:\anc-backup` 不算数"，
> 跑了一次备份后自然转绿（`VERIFY §81.4` #6）。

**输出长这样**：

```
database       PASS  库存在: C:\ProgramData\anc\data\anc.db
doctor         PASS  FAIL=0 WARN=3（30 项）
task-write     PASS  task #68 写进去了，查得回来
bot-reply      SKIP  还没有实例引用（需先在群里收到一条真实消息）
tasks          PASS  10 个任务全部 Ready/Running

结果  PASS=4  FAIL=0  SKIP=1
NEXT  有 1 项没验（bot-reply），原因见 detail。

# 说明（2026-11-05 实测校正，见 VERIFY §62）：
#  · WARN 是 3 不是 2：secrets-in-git（未指定 -Repo）、canary（需先收到真实群消息）、
#    vault-ingest-audit（3 个未跟踪文件，1 小时内无入库记录）。三个都是设计内的，不是缺陷。
#  · bot-reply 在「干净的机器上」通常是 SKIP 而不是 PASS —— 409 表示还没有实例引用，
#    即 bot 还没收到过任何真实群消息。这不是故障（VERIFY §62.5）。
#  · 任务数是 10 不是 9。
```

**每一项什么意思**：

| 项 | 验什么 | FAIL 说明什么 |
|---|---|---|
| `database` | 库在 | 部署没做完 |
| `doctor` | 30 项体检全过 | 有具体项坏了，看 detail |
| `task-write` | 写一条能查回来 | **库能写才是真能干活**；写不进去说明服务起不来或库锁了 |
| `bot-reply` | 注入一条消息 | 409（还没有实例引用）是 SKIP 不是 FAIL；端口没监听也是 SKIP；只有真正注入失败才 FAIL。**「没等到回复」仍是 PASS**（回复慢是模型行为） |
| `tasks` | 10 个任务 Ready/Running | 有一个卡住就说明装机不完整 |

**`SKIP` 不是通过**——它是"没验"。常见 SKIP：

- `bot-reply` SKIP → 看 `detail` 字段，**两种原因**：
  - **「还没有实例引用」**（后端是 409）→ 正常。`test-emit` 依赖一个活的 `WecomAiBotClient` 实例，
    而它只在 bot 收到过**真实群消息**之后才有值。**先去群里 @ 一次 bot，再重跑本脚本。**
    只建 `test-emit.flag` 解决不了这个。
  - **「test-emit 关闭」** → 建 `%ProgramData%\anc\data\test-emit.flag`，重启 WorkBuddy，等 8–30 秒。
    注意 flag 是**启动时读一次**，建完必须重启，再跑。
- 有 SKIP 时告诉用户"这几项没验，原因是 X"。

**失败了怎么办**：按每项的 `fix` 处理。改完**只重跑那一项也行**（`-SkipBot` 可以跳过 bot 那项）。

**装完**：

```powershell
powershell -File scripts\deploy-state.ps1 -Side company -Mark verify -AsDone
```

**§12 全绿之后**，把这段告诉用户：

```
公司侧部署完成。
  doctor: FAIL=0 WARN=X（30 项）
  群回应: <PASS/SKIP 及原因>
  任务落库: OK
  计划任务: 10/10
未完成: <列出来，没有就写"无">
```

---

## 13. 装到一半失败怎么办

**不要从头重装。** 进度记在 `%ProgramData%\anc\data\deploy-state.json`：

```powershell
# 看现在到哪了
powershell -File scripts\deploy-state.ps1 -Side company -Json
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
powershell -File scripts\deploy-state.ps1 -Side company -Mark patch -AsFailed -Reason "ANCHOR-MISS: 版本 5.9.5"
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
powershell -File scripts\deploy-state.ps1 -Side company -Reset -Apply
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
powershell -File scripts\deploy.ps1 -Rollback
# 技能回滚
powershell -File scripts\deploy-skills.ps1 -Rollback
# 补丁关闭（不改文件，只让 preload 不注入）。两种等价做法：
powershell -File "$Root\patch\launch-patched.ps1" -NoPatch      # 本次不带补丁启动
# 或设环境变量 ANC_WB_PATCH=0（preload.cjs 看到它就 module.exports={} 直接退出）
```

---

## 附：全部命令速查

```powershell
# ── 只读检查（任何时候都能跑）──
powershell -File scripts\preflight.ps1 -Side company -Json        # 装之前
powershell -File scripts\deploy-state.ps1 -Side company -Json     # 进度
powershell -File scripts\deploy-verify.ps1 -Side company -Json    # 装完之后
powershell -File "$Root\bin\doctor.ps1" -Json                     # 健康

# ── 按顺序装 ──
powershell -File scripts\preflight.ps1 -Side company              # §3
# §4 建目录（见文档里的命令块）
powershell -File scripts\deploy.ps1 -Apply                         # §5
powershell -File scripts\deploy-skills.ps1 -Apply                  # §6
powershell -File "$Root\patch\launch-patched.ps1"                 # §7（会重启 WorkBuddy，自己等 patch-state）
powershell -File "$Root\bin\register-tasks.ps1" -Root $Root -Apply # §8
# §9 建 vault（见文档）
# §10 是两步，别只跑第二步：
node --no-warnings "$Repo\src\render\cli.ts" render --org $org --out "$Root\render"   # §10.6 ① 渲染
powershell -File "$Root\bin\deploy-persona.ps1" -Source "$Root\render\company-bot\CODEBUDDY.md"  # §10.6 ② 装
# §11 写企微凭据（见文档）
powershell -File scripts\deploy-verify.ps1 -Side company          # §12

# ── 每一步之后 ──
powershell -File scripts\deploy-state.ps1 -Side company -Mark <id> -AsDone
```

**退出码约定**（所有脚本一致）：

| 码 | 意思 |
|---|---|
| 0 | 成功（含 dry-run、含"决定不做"） |
| 1 | 校验失败 / 有 FAIL / 决定要做但失败了 |
| 2 | 用法或环境错误 |
