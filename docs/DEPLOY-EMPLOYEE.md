# 员工侧部署手册（给 agent 读）

> 类型：运维手册（员工侧部署）

> **当前文档描述的是 1.0 员工 bot 旧实现**：仍装 7 个技能（含 `anc-vault-read`），员工 bot 仍会查公司库。主干 4 已决定“员工 bot 不查公司库、改用 handoff”（见 `FUTURE-DESIGN` 4.3、`GAP-037–039`），但代码/技能还没返工。**在 GAP-037–039 关闭前，按本文装；不要以为新设计已经生效。**

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
| [1](#1-开工前问清这张表) | — | **要问人的清单** | 读 + 等人 |
| [2](#2-preflight前置检查) | `preflight` | 前置检查 | 10 秒 |
| [3](#3-workbuddy确认-workbuddy-已登录) | `workbuddy` | 确认 WorkBuddy 在 | 1 分钟 |
| [4](#4-files部署运行件) | `files` | 部署运行件 | 30 秒 |
| [5](#5-skills装技能) | `skills` | 装 7 个技能（8 个文件） | 10 秒 |
| [6](#6-persona部署个人-persona) | `persona` | 部署个人 persona | 1 分钟 |
| [7](#7-bind绑定本人的群) | `bind` | 绑定群 | 1 分钟 |
| [8](#8-verify自证) | `verify` | 自证 | 30 秒 |
| [9](#9-装到一半失败怎么办) | — | 断点续装 | — |
| [10](#10-卸载) | — | 回滚 | — |

---

## 0. 你要装出什么

**这是员工自己那台办公电脑，不是主机。**

装完的状态：

- **个人 bot 在这台电脑上跑，只服务本人**
- **能读公司共享区的 vault（只读）**
- **能把自己的问题提交给公司侧（迭代闭环的入口）**

**你不做的事**：

- **不装服务**（不注册计划任务、不开 HTTP 面、不建 vault）——那是公司侧的事
- **不装补丁**——个人 bot 不需要群身份注入；它只在私聊和「本人+公司bot」的群里工作
- **不碰 `C:\ProgramData\anc`**——那是主机的东西，员工机上没有

**员工侧用的是 `%LOCALAPPDATA%\anc`**（不是 `%ProgramData%`）。这是故意的：个人电脑上不该有 ProgramData 级别的写入。

---

## 1. 开工前：问清这张表

**填不全就别往下做。** 这些值只有人知道。

> **问不到时的规矩（第二轮走查暴露的漏洞）**
>
> 早先版本没说清「哪些能从同步过来的产物读、哪些不能」，agent 就自己从
> `render\groups.json` 里读 userid / chatId / 成员 id，然后推断着装 —— 装错人不会报错，
> 只会静默地让个人 bot 去服务别人。**现在的分界**：
>
> | 项 | 能不能从产物读 | 为什么 |
> |---|---|---|
> | 2 userid、3 chatId、2′ 成员 id | **不能，必须问人** | 这三个决定「bot 服务谁、消息从哪来、装哪份 persona」。读错了不报错，只装错 |
> | 4 共享区路径 | 可以 | 由 `org\company.md` 的 `vault_shared:` 决定，§5.5 会同步过来 |
> | 5 公司 bot 名、6 部门 | 可以 | 渲染 persona 时已写死，读 persona 即可 |
>
> **拿不到 2 / 3 / 2′ 时唯一的正确动作是停下来问**，不是从产物里猜。

| # | 要什么 | 用在哪 | 怎么来的 | 填这里 |
|---|---|---|---|---|
| 1 | **这台电脑是你自己的吗**（不是共用的） | 前提 | 问人 | ☐ 是 / ☐ 不是 |
| 2 | **你的企微 userid** | persona 认主人 | 企微通讯录；**不是**姓名、**不是**手机号 | `________________` |
| 3 | **你的群 chatId**（32 字符） | 绑定 | 群里 → 群设置；**不要截断** | `________________` |
| 4 | **公司共享区的网络路径** | 读 vault | 公司侧装完会给（形如 `\\主机\vault-shared`；也可能是 `D:\anc\vault-shared` 如果是同机） | `________________` |
| 5 | **公司 bot 叫什么** | persona 里说明"你和它是两个实例" | 公司侧给的 | `________________` |
| 6 | **你在哪个部门** | 决定你的技能集和 vault 可见范围 | 问公司侧 | `________________` |
| 7 | **本机工作目录**（默认 `%USERPROFILE%\WorkBuddy\Claw`） | persona 里写 | 一般不用改 | `________________` |

**缺的时候**：

- **2、3 缺** → 停下来问。persona 认不出主人，个人 bot 会「听所有人的话」——这是安全问题
- **4 缺** → 可以装；`verify` 的 `vault-read` **不一定** FAIL ——
  它读的路径来自 `org\company.md` 的 `vault_shared:`（§5.5 同步过来的那份），不是从你这里问到的值。
  早先版本这里写「会 FAIL」，第二轮走查时没填第 4 项却 PASS 了，所以改了。
- **6 缺** → 按"未分部门"处理（全部技能、全部 vault）。**能用，但范围没收窄**
- **1 是"不是"** → **停下来**。共用电脑上装个人 bot 会让别人也能用你的身份

---

## 2. preflight（前置检查）

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
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\deploy-skills.ps1

# 落盘
#   默认目标 %USERPROFILE%\.workbuddy\skills（员工机上就是这里，一般不用改）
#   -Target 可以指到别处（演练时用）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\deploy-skills.ps1 -Apply
```

**成功判据**：

```powershell
@(Get-ChildItem (Join-Path $env:USERPROFILE '.workbuddy\skills') -Directory).Count
# 期望 7：light/skills 下有 7 个技能、8 个文件，第 8 个是 .anc-backup 备份目录，不是技能。
# 原来写「≥ 1」太松：漏装 6 个也能过。低于 7 就回去看 deploy-skills.ps1 的输出。
```

**员工侧和公司侧的区别**：**员工侧的技能集应该更小**。具体装哪些由**公司侧** `org/depts/<id>.md` 的 `skills` 决定（见 `DEPLOY-COMPANY.md §10.3`；仓库里没有裸 `depts/`），但 `deploy-skills.ps1` 是**全量复制**的——**这个差别目前由 persona 约束，不是由部署物理隔离**。

> **已知限制**：技能是物理全量装的，部门差异只体现在 persona 里写的"你能用的技能"。
> 想真正物理隔离，需要在 `deploy-skills.ps1` 加 `-Only <技能列表>` 参数。**现在没有。**

**失败了怎么办**：同公司侧 §6。

**装完**：

```powershell
powershell -File scripts\deploy\deploy-state.ps1 -Side employee -Mark skills -AsDone
```

---

## 5.5 从公司侧同步三个渲染产物（漏了必卡 §6 和 §8）

**为什么有这一节**：`deploy.ps1 -Apply` 只把**渲染器源码**（`cli.ts` / `index.ts` / `org.ts` …）放进 `render\`，
**不生成任何渲染产物**。而下面两节硬依赖三个文件，它们只能来自公司侧的渲染：

| 文件 | 谁要它 | 缺了会怎样 |
|---|---|---|
| `render\members\<你的 id>\CODEBUDDY.md` | §6 装 persona | §6 直接抛「没有你的 persona」 |
| `render\groups.json` | §8 `vault-read` | §8 FAIL「没有 render\groups.json」 |
| `org\company.md`（至少要有 `vault_shared:`） | §8 靠它找共享区 | 同上 |

**先确认缺不缺**：

```powershell
$Root = "$env:LOCALAPPDATA\anc"
foreach ($p in "render\groups.json", "org\company.md", "render\members") {
    "{0,-22} {1}" -f $p, $(if (Test-Path (Join-Path $Root $p)) { "有" } else { "缺" })
}
```

**三个都「有」时**：不要直接跳过。先看它们是不是**你自己同步来的**。

- 如果是你刚按下面的通道拷的 → 跳过后续，往下走
- 如果是**别人预先放好的**（你不知道来源）→ **仍然照 A-1 重跑一遍并核对哈希**，
  因为「有文件」不等于「是对的人的那份」。产物放错人（装成别人的 persona）比缺文件更糟。

核对方法：

```powershell
$Root      = "$env:LOCALAPPDATA\anc"
$company   = "D:\anc"        # 公司侧根，按实际填
foreach ($rel in "render\groups.json", "org\company.md") {
    $a = (Get-FileHash (Join-Path $Root $rel)    -Algorithm SHA256).Hash
    $b = (Get-FileHash (Join-Path $company $rel) -Algorithm SHA256).Hash
    "{0,-22} {1}" -f $rel, $(if ($a -eq $b) { "MATCH" } else { "MISMATCH —— 员工侧这份不是公司侧当前产物" })
}
```

### 通道 A：直接从公司主机拷（同机装、或公司主机开了 SMB 共享）

> **先看这一条，能省你一次失败**：`vault-shared` 对 `BUILTIN\Administrators` **也只有读权限**
> （`D24` 的设计：vault 对 bot 只读，bot 只能写 `inbox`）。
> 所以「公司侧把产物丢进共享区、员工侧从共享区取」这个最直觉的做法，
> 会报 `UnauthorizedAccessException` —— **这是故意的，不是配错了**。别在这上面浪费时间。

**A-1 同机**（本机既有公司侧数据又在装员工侧）：

```powershell
$Root    = "$env:LOCALAPPDATA\anc"
$company = "D:\anc"        # 公司侧根，按实际填

New-Item -ItemType Directory -Path "$Root\render\members" -Force | Out-Null
New-Item -ItemType Directory -Path "$Root\org" -Force | Out-Null
Copy-Item (Join-Path $company "render\groups.json") "$Root\render\groups.json" -Force
Copy-Item (Join-Path $company "org\company.md")     "$Root\org\company.md"     -Force
Copy-Item (Join-Path $company "render\members\*")  "$Root\render\members"     -Recurse -Force
```

**A-2 网络共享**（公司主机把 anc 根开成**只读**共享）：把 `$company` 换成 `\\<公司主机>\anc-share`，其余同上。

### 通道 B：U 盘 / 远程桌面手工拷

照上面的目录结构摆进去即可。

### 通道 C：走 `inbox`（不推荐）

`inbox` 是 bot 唯一可写的目录，但入库进程会把里面的东西当待处理批次。
除非 A / B 都不通，否则别用。

**拷完复核**：

```powershell
$Root = "$env:LOCALAPPDATA\anc"
foreach ($p in "render\groups.json", "org\company.md", "render\members") {
    "{0,-22} {1}" -f $p, $(if (Test-Path (Join-Path $Root $p)) { "OK" } else { "仍然缺" })
}
```

**注意**：`org\company.md` 只有公司名和 vault 路径，没有凭据，可以拷。
`%ProgramData%\anc\secrets\` 里的东西**绝不能拷到员工机**。

---

## 6. persona（部署个人 persona）

**做什么**：把公司侧渲染出来的**你自己的** persona 复制到 WorkBuddy 的读取位置。

**关键概念**：persona 由**公司侧**渲染（因为要读 org 数据），员工侧只是**接收 + 安装**。

### 先确定「哪个成员是我」—— 这一步不能推断

`render\members\` 下可能有多个成员（公司里有几个人就有几份）。**装错了就是装了别人的身份**，
个人 bot 会去服务别人、把任务记到别人名下。

**判定顺序**（前一条不成立才走下一��）：

1. **问用户**：「你在 org 里是哪个成员 id？」—— §1 的第 2′ 项。**这是首选，不允许用推断代替。**
2. 只有一种情况可以自己定：`render\groups.json` 里 **userid 唯一**，且你从别处确切知道本人 userid。
   这时按 userid 反查成员 id。
3. **`groups.json` 里多个成员共用同一个 userid 时（同机测试常见），必须问人** ——
   这时任何「按 userid 匹配」都会同时匹配到多份，等于没匹配。

```powershell
$Root = "$env:LOCALAPPDATA\anc"
$g = Get-Content "$Root\render\groups.json" -Raw | ConvertFrom-Json
$arr = if ($g -is [array]) { $g } else { $g.members }
"在 render\members 下的成员："
Get-ChildItem "$Root\render\members" -Directory | ForEach-Object { "  - " + $_.Name }
"groups.json 里的 userid 分布："
$arr | Group-Object userid | ForEach-Object {
    "  userid=" + $_.Name + "  成员=" + (($_.Group | ForEach-Object { $_.employee }) -join ", ")
    if ($_.Count -gt 1) { "    ⚠ 多个成员共用同一个 userid —— 不能用它区分，必须问用户哪个 id 是本人" }
}
```

```powershell
$Root = Join-Path $env:LOCALAPPDATA 'anc'
$LivePersona = Join-Path $env:USERPROFILE 'WorkBuddy\Claw\CODEBUDDY.md'

# ① 先备份现有的（WorkBuddy 自带的默认 persona，别弄丢）
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (Test-Path $LivePersona) {
    Copy-Item $LivePersona "$Root\data\persona-backup-$stamp.md" -Force
}

# ② 从公司侧拿到你的 persona，放到这里
#    公司侧产物在：<公司主机>\render\members\<你的 id>\CODEBUDDY.md
#    员工侧应放在：%LOCALAPPDATA%\anc\render\members\<你的 id>\CODEBUDDY.md
# ⚠ 把 REPLACE_ME 换成真实成员 id（小写字母/数字/下划线/连字符）。
#   别留尖括号：< 和 > 是 Windows 路径非法字符，会先抛「路径中具有非法字符」，
#   而不是下面预设的「没有你的 persona」，方向就看错了。
$myId = 'REPLACE_ME'   # §1 第 2 项对应的成员 id（不是 userid）
$src = Join-Path $Root "render\members\$myId\CODEBUDDY.md"
if (-not (Test-Path $src)) {
    throw "没有你的 persona: $src —— 要么公司侧还没渲染你，要么 id 不对"
}
Copy-Item $src $LivePersona -Force
```

**成功判据**：

> **第 ① 条只在你的 userid 唯一时才算证明。**
> 如果 `groups.json` 里多个成员共用同一个 userid（同机测试常见），
> 「persona 含这个 userid」对所有成员的 persona 同时为 True —— **它证明不了这份是你的**。
> 那种情况下只能用「你告诉我是哪个成员 id」来确认，别靠这条判据。

```powershell
# ① persona 里有你的 userid（userid 唯一时才证明是你的）
$uid = '<你的 userid>'
$hits = @(Get-ChildItem "$Root\render\members" -Directory | Where-Object {
    (Get-Content (Join-Path $_.FullName 'CODEBUDDY.md') -Raw) -match [regex]::Escape($uid)
})
"含该 userid 的 persona 份数: " + $hits.Count + "（>1 说明这条判据没区分力，必须问人确认成员 id）"

# ② 有部门段
Select-String -Path $LivePersona -Pattern '你属于哪个部门' -Quiet
# ③ 字节数在 7500 以内
(Get-Item $LivePersona).Length
```

**失败了怎么办**：

- **没有 persona 文件** → 让公司侧先渲染；或者告诉用户"公司侧还没把你的账号配进 org"
- **persona 里有别人的 userid** → **停**。这说明公司侧渲染错了，装上去个人 bot 会认错主人
- **超过 7500 字节** → WorkBuddy 可能截断。让公司侧缩减 persona

**重启 WorkBuddy**（必须，否则 persona 不生效）—— 但**先判断你自己在不在里面**：

> **不要直接执行 `Get-Process WorkBuddy | Stop-Process`。**
> 这份手册的读者是 agent，多半就跑在 WorkBuddy 里。那条命令杀掉的是**你自己**，
> 当前会话当场终止，后面 §7 绑定 / §8 自证 没人继续 —— 走查时正是卡在这里。

**情况 A：你跑在 WorkBuddy 里**（大多数）→ 只标记，不重启：

```powershell
$marker = Join-Path $Root "data\pending-persona-reload.json"
$obj = [ordered]@{
    persona = $LivePersona
    at      = (Get-Date).ToString("o")
    reason  = "persona 改动要重启 WorkBuddy 才生效（VERIFY §18）"
}
$obj | ConvertTo-Json | Set-Content $marker -Encoding UTF8
"persona 已装，待重启后生效。§7 / §8 不依赖 persona，先做完。"
```

然后继续做 §7 和 §8，最后在汇报里明确写：
「persona 已落盘，**未生效** —— 需要用户重启 WorkBuddy 后再验一次」。

**情况 B：你不是跑在 WorkBuddy 里**（Claude Code / Codex CLI 等）→ 自己重启：

```powershell
Get-Process WorkBuddy -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 3
Start-Process "$env:LOCALAPPDATA\Programs\WorkBuddy\WorkBuddy.exe"
```

**启动前先看这条**：如果进程 0.5 秒就退出、`ExitCode=0`、日志一行不写 —— 查 `ELECTRON_RUN_AS_NODE`。
它设成 1 时 Electron 走纯 Node 模式，应用根本不初始化（`VERIFY §54`）。
起进程时用 `ProcessStartInfo` 并 `$psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE")`。

> **为什么必须重启**：persona 是**每会话首次注入时读一次**（`VERIFY §18`）。不重启的话，当前会话还是旧 persona。

**装完**：

```powershell
powershell -File scripts\deploy\deploy-state.ps1 -Side employee -Mark persona -AsDone
```

---

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
| `vault-read` | 读 `render\groups.json` + `org\company.md` 里 `vault_shared:` 指到的目录 | 缺这两个文件 → FAIL，回去做 §5.5 |

**SKIP 不是通过。** 有 SKIP 时告诉用户"这几项没验，原因是 X"。

**失败了怎么办**：

- **`bot-online` FAIL** → 启动 WorkBuddy
- **`vault-read` FAIL** → 先看缺的是哪个：
  - 「没有 render\groups.json」→ 回去做 §5.5
  - 「company.md 里没有 vault_shared」→ §5.5 同步的 `org\company.md` 不完整，重新同步
  - 「路径不可读」→ `org\company.md` 里那个路径在这台机器上访问不了（网络共享要 `net use` 或凭据）
  **注意**：这个路径来自 `org\company.md`，不是 §1 第 4 项 —— 别去改 §1。
- **`bot-reply` SKIP** → **员工侧这是正常的，不是故障。**

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
'anc-dayend','anc-feedback','anc-ingest','anc-interview','anc-task','anc-vault-read','anc-wb-patch','.anc-backup' |
  ForEach-Object { Remove-Item (Join-Path $env:USERPROFILE ".workbuddy\skills\$_") -Recurse -Force -ErrorAction SilentlyContinue }

# ④ 重启 WorkBuddy
```

**注意**：卸载**不动** `C:\ProgramData\anc`（那是主机的东西，员工机上本来就没有）。

---

## 附：命令速查

```powershell
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

**员工侧 7 个阶段**：`preflight` → `workbuddy` → `files` → `skills` → `persona` → `bind` → `verify`

---

## 和公司侧的差异（一张表看完）

| 维度 | 公司侧 | 员工侧 |
|---|---|---|
| 部署根 | `%ProgramData%\anc` | **`%LOCALAPPDATA%\anc`** |
| 管理员权限 | 必需 | 不需要 |
| 计划任务 | 10 个 | **0 个** |
| 补丁 | 要装（群身份注入） | **不装**（除非认不出主人） |
| vault | **建**两区 | 只**读**共享区 |
| persona | 渲染公司 bot 的 | 接收**本人**的 |
| org 数据 | 写 | 不写 |
| 阶段数 | 11 | **7** |
| 自证 | doctor + 群回应 + 任务落库 + 10 个任务 | bot 在线 + 能被 @ + 能读 vault |
