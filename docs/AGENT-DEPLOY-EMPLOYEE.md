# 员工侧部署手册（给 agent 读）

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
| [5](#5-skills装技能) | `skills` | 装 8 个技能 | 10 秒 |
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
- **4 缺** → 可以装，但读不了公司资料；`verify` 的 `vault-read` 会 FAIL
- **6 缺** → 按"未分部门"处理（全部技能、全部 vault）。**能用，但范围没收窄**
- **1 是"不是"** → **停下来**。共用电脑上装个人 bot 会让别人也能用你的身份

---

## 2. preflight（前置检查）

**做什么**：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\preflight.ps1 -Side employee -Json
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
powershell -File scripts\deploy-state.ps1 -Side employee -Mark preflight -AsDone
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
if (-not (Test-Path (Join-Path $env:USERPROFILE 'WorkBuddy'))) { throw 'WorkBuddy 装了但没登录过' }

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
powershell -File scripts\deploy-state.ps1 -Side employee -Mark workbuddy -AsDone
```

---

## 4. files（部署运行件）

**做什么**：

```powershell
# dry-run
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Side employee

# 落盘
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Side employee -Apply
```

**注意 `-Side employee`**：它让部署根变成 `%LOCALAPPDATA%\anc`，而不是 `%ProgramData%\anc`。

**成功判据**：退出码 0，且：

```powershell
node --no-warnings "$env:LOCALAPPDATA\anc\service\cli.ts" 2>&1 | Select-Object -First 1
# 期望 "ERROR 缺少命令组（...）" —— 这是用法提示，不是故障
```

**失败了怎么办**：同公司侧 §5（文件占用 / 磁盘满 / 映射漏文件），看 `ERROR` 和 `FIX`。

**回滚**：

```powershell
powershell -File scripts\deploy.ps1 -Side employee -Rollback
```

**装完**：

```powershell
powershell -File scripts\deploy-state.ps1 -Side employee -Mark files -AsDone
```

---

## 5. skills（装技能）

**做什么**：

```powershell
# 预检（只比对，不写）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy-skills.ps1

# 落盘
#   默认目标 %USERPROFILE%\.workbuddy\skills（员工机上就是这里，一般不用改）
#   -Target 可以指到别处（演练时用）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy-skills.ps1 -Apply
```

**成功判据**：

```powershell
@(Get-ChildItem (Join-Path $env:USERPROFILE '.workbuddy\skills') -Directory).Count
# 期望 ≥ 1（至少 anc-task / anc-vault-read / anc-feedback 里你的部门用得上的那些）
```

**员工侧和公司侧的区别**：**员工侧的技能集应该更小**。具体装哪些由 §6 的 `depts/<id>.md` 的 `skills` 决定，但 `deploy-skills.ps1` 是**全量复制**的——**这个差别目前由 persona 约束，不是由部署物理隔离**。

> **已知限制**：技能是物理全量装的，部门差异只体现在 persona 里写的"你能用的技能"。
> 想真正物理隔离，需要在 `deploy-skills.ps1` 加 `-Only <技能列表>` 参数。**现在没有。**

**失败了怎么办**：同公司侧 §6。

**装完**：

```powershell
powershell -File scripts\deploy-state.ps1 -Side employee -Mark skills -AsDone
```

---

## 6. persona（部署个人 persona）

**做什么**：把公司侧渲染出来的**你自己的** persona 复制到 WorkBuddy 的读取位置。

**关键概念**：persona 由**公司侧**渲染（因为要读 org 数据），员工侧只是**接收 + 安装**。

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
$myId = '<你的 id>'   # §1 第 2 项对应的成员 id（不是 userid）
$src = Join-Path $Root "render\members\$myId\CODEBUDDY.md"
if (-not (Test-Path $src)) {
    throw "没有你的 persona: $src —— 要么公司侧还没渲染你，要么 id 不对"
}
Copy-Item $src $LivePersona -Force
```

**成功判据**：

```powershell
# ① persona 里有你的 userid（证明是你的，不是别人的）
Select-String -Path $LivePersona -Pattern '<你的 userid>' -Quiet
# ② 有部门段（§10.4 里我们加的）
Select-String -Path $LivePersona -Pattern '你属于哪个部门' -Quiet
# ③ 字节数在 7500 以内
(Get-Item $LivePersona).Length
```

**失败了怎么办**：

- **没有 persona 文件** → 让公司侧先渲染；或者告诉用户"公司侧还没把你的账号配进 org"
- **persona 里有别人的 userid** → **停**。这说明公司侧渲染错了，装上去个人 bot 会认错主人
- **超过 7500 字节** → WorkBuddy 可能截断。让公司侧缩减 persona

**重启 WorkBuddy**（必须，否则不生效）：

```powershell
Get-Process WorkBuddy -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 3
# 让用户重新启动它（或找到 exe 路径自己启动）
```

> **为什么必须重启**：persona 是**每会话首次注入时读一次**（`VERIFY §18`）。不重启的话，当前会话还是旧 persona。

**装完**：

```powershell
powershell -File scripts\deploy-state.ps1 -Side employee -Mark persona -AsDone
```

---

## 7. bind（绑定本人的群）

**做什么**：把「你的群 chatId」和「你的身份」登记到本地库，这样个人 bot 知道哪条消息来自你的群。

```powershell
$Root = Join-Path $env:LOCALAPPDATA 'anc'
$cli = "$Root\service\cli.ts"
$db = "$Root\data\anc.db"

node --no-warnings $cli --db $db bind --chat-id '<§1 第 3 项>' --employee '<你的成员 id>' --userid '<§1 第 2 项>'
```

**成功判据**：

```powershell
node --no-warnings $cli --db $db --json bind list
# 应该有一条，employee / chat_id / userid 都对
```

**失败了怎么办**：

| 报错 | 意思 | 怎么做 |
|---|---|---|
| `缺少 --chat-id` | 没传 | 补上 |
| `chat_id 不是 32 字符` | 截断了 | 重新拿完整 chatId（群设置里复制整段） |
| 绑定成功但 bot 不认 | 补丁没装 | **员工侧不装补丁**，但个人 bot 需要 `from` 前缀才能认人。检查：WorkBuddy 里 persona 的「每轮先做的三件事」那段——如果消息里没有 `[anc:chat=... from=...]` 前缀，说明个人 bot 也没拿到群身份。**这是已知限制**，见下方说明 |

> **员工侧的身份来源**：公司 bot 靠补丁（D17）拿到群身份。个人 bot **不装补丁**——它靠 WorkBuddy 自己带的企微身份。
> **但是**：WorkBuddy 自带的消息里有没有 `from` 字段，取决于版本。`VERIFY §15` 记过企业版和个人版在这一点上行为一样。
> **如果个人 bot 认不出主人**，说明需要补丁，那就按公司侧 §7 装补丁。

**装完**：

```powershell
powershell -File scripts\deploy-state.ps1 -Side employee -Mark bind -AsDone
```

---

## 8. verify（自证）

**做什么**：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy-verify.ps1 -Side employee -Json
```

**成功判据**：`"ok": true`。

**三项**：

| 项 | 验什么 | 说明 |
|---|---|---|
| `bot-online` | WorkBuddy 进程在 | 不在就 FAIL |
| `bot-reply` | 注入一条消息 | `test-emit` 默认关着 → SKIP 是正常的 |
| `vault-read` | 能读公司共享区里一个文件 | 路径不对或没权限 → FAIL；共享区空的 → SKIP（不算错） |

**SKIP 不是通过。** 有 SKIP 时告诉用户"这几项没验，原因是 X"。

**失败了怎么办**：

- **`bot-online` FAIL** → 启动 WorkBuddy
- **`vault-read` FAIL** → 检查 §1 第 4 项的路径；网络共享要能访问（`net use` 或凭据）
- **`bot-reply` SKIP** → 正常。要验的话建 `%LOCALAPPDATA%\anc\data\test-emit.flag` 并重启 WorkBuddy

**装完**：

```powershell
powershell -File scripts\deploy-state.ps1 -Side employee -Mark verify -AsDone
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
powershell -File scripts\deploy-state.ps1 -Side employee -Json
```

`next` 会告诉你从哪继续。流程：

1. 看 `failed` 是哪节
2. 修那一节（每节的「失败了怎么办」有写）
3. **只重跑那一节**
4. `-Mark <那节> -AsDone`

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
powershell -File scripts\preflight.ps1 -Side employee -Json
powershell -File scripts\deploy-state.ps1 -Side employee -Json
powershell -File scripts\deploy-verify.ps1 -Side employee -Json

# ── 按顺序装 ──
powershell -File scripts\preflight.ps1 -Side employee                    # §2
# §3 确认 WorkBuddy（见文档）
powershell -File scripts\deploy.ps1 -Side employee -Apply                # §4
powershell -File scripts\deploy-skills.ps1 -Apply                        # §5
# §6 部署 persona（见文档）
# §7 绑定群（见文档）
powershell -File scripts\deploy-verify.ps1 -Side employee                # §8

# ── 每步之后 ──
powershell -File scripts\deploy-state.ps1 -Side employee -Mark <id> -AsDone
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
