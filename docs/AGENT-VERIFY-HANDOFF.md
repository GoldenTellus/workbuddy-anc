# 验证交接手册（给新机器上的 agent 读）

> **你在一台新机器上，你没参与过这个项目，你要做的是"验证"而不是"开发"。**
>
> 这份文档是上一台机器（下文叫**主机**）上的 agent 写的交接。
> 它把三样东西交给你：**① 这台机器能验什么 ② 它踩过的坑 ③ 可复用的测试方法**。
>
> **先读 §1——如果你这台机器不适合做验证，后面全都不用看。**

---

## 目录

| 节 | 内容 | 什么时候读 |
|---|---|---|
| [1](#1-先判断这台机器能干什么) | **这台机器能验什么 / 不能验什么**、基础条件、做不了的 | **现在，先读这个** |
| [2](#2-开工前十分钟) | 装起来、跑通、看进度 | 确认能做之后 |
| [3](#3-待验证任务清单) | 按优先级排的任务 | 干活时逐条看 |
| [4](#4-我踩过的坑) | **24 个坑，照抄会错**（含 2026-11-05 新增的 8 条环境类） | **动手前通读一遍** |
| [5](#5-测试方法) | 6 个可复用的思路 | 想不出怎么验时看 |
| [6](#6-工具速查) | 每个脚本干什么、怎么调 | 随手查 |
| [7](#7-交回什么) | 你要产出什么 | 收尾 |

---

## 1. 先判断这台机器能干什么

### 1.1 主机为什么需要你

主机上能自己做的，**都做完了**（`VERIFY §42`–`§48`）。剩下的全部卡在一个东西上：**没有第二台机器**。

主机只有一个 WorkBuddy、一个企微群、一个账号。**它造不出"陌生环境"**。它试过用 `Z:` 盘符模拟新机（`§34`），但那只能验"文件能不能落地"，验不了"真人/真 agent 在真机器上能不能装完"。

**你这台机器补的就是这个洞。**（`§33` 分析过为什么一台机器当不了干净机。）

### 1.2 你这台机器是哪种？

先跑这条，判断角色：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\preflight.ps1 -Side company -Json
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\preflight.ps1 -Side employee -Json
```

看输出里的 `facts` 和 `blockers`，然后对表：

| 你看到 | 你是什么 | 能做哪些任务 |
|---|---|---|
| 没装过 `%ProgramData%\anc`，有管理员权限 | **干净的公司侧机** | **★ 最有价值：D4.6 公司侧全部** + O-5 |
| 没装过 `%LOCALAPPDATA%\anc`，是普通员工的办公电脑 | **员工侧机** | **★ D4.6 员工侧 + E-1 的员工机一半** |
| 已经装过（`already-installed` 警告） | **升级/重装场景** | 只能验 §3 里标 `[升级]` 的项 |
| 不是 Windows | — | **停下来**，这个项目只跑 Windows |

### 1.3 先确认三件基础条件

新机器最容易卡在这些地方，**先确认，省得做一半发现做不了**：

```powershell
# ① Node 22+（低于 22 跑不了 .ts）
node --version

# ② git（要 clone 仓库、devbot 要出分支）
git --version

# ③ 能不能装东西（npm 装依赖时如果没有外网会卡住）
npm config get registry
```

**这个项目运行时零外部依赖**（`package.json` 里没有 dependencies），所以**只要有 node + git 就能跑**。
`npm install` 只是给开发用的（测试也只用 node 内置的 `node:test`）。

### 1.4 明确做不了的（别硬凑）

这几项**在任何单台机器上都做不了**，不要试图硬凑证据：

| 项 | 为什么做不了 |
|---|---|
| **真升级回归（R7）** | 要腾讯**真发一个新版 WorkBuddy**。`§37` 只验了三种**伪造**失效路径（ANCHOR-MISS / hash 不符 / 进程崩），伪造只证明"处理逻辑对"，不证明"面对真升级也对" |
| **E-2 私聊仅管理员** | 企微管理后台的开关。你没有那个后台权限 |
| **P-3 真员工上线** | 要一个**真的企微账号**和一个**真人**。你能验代码路径，验不了"一小时"这个 SLA |
| **P-7 席位回收** | 要企微管理后台删席位。其余三步主机已经验了（`§35`） |

**遇到这些，写"做不了 + 卡在哪"，不要写"应该没问题"。**

---

## 2. 开工前十分钟

### 2.1 装运行件

```powershell
# 只读检查（不写任何东西）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\preflight.ps1 -Side company -Json

# 三段式部署（dry-run → 落盘 → 自证）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Side company
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Side company -Apply
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy-verify.ps1 -Side company -Json
```

### 2.2 看进度（★ 别凭记忆推进度）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy-state.ps1 -Side company -Json
```

输出里的 `next` 字段**明确告诉你下一步做什么**。卡住了它会说：

```
上次卡在 patch（ANCHOR-MISS）。修好之后重跑那一步，再 -Mark patch -AsDone。**不要从头来**。
```

**这是给你的指令，照做。** 不要因为失败就从头重装——那样会覆盖已经改好的东西。

### 2.3 装完的判据

```powershell
# 这三条都过才算装好了
node scripts/check-public.mjs                                 # 零输出、exit 0
npm test                                                       # 127/127
powershell -File scripts\deploy-verify.ps1 -Side company -Json # ok: true
```

**`SKIP` 不算通过**——它是"没验"。输出里的 `next` 会提醒你这一点。

---

## 3. 待验证任务清单

**按"这台机器能不能做"排序**，不是按重要性。

### 3.1 ★ D4.6：一个没参与过的人/agent 拿到 URL 能装完

**这是 1.0 第 4 条判据，也是唯一完全没人验过的。**

**你的处境本身就是这个实验**：你在一台新机器上，你只拿到了仓库 URL 和这份文档。**你装完装不装得上，就是这个判据的答案。**

**怎么做**：

1. **严格按 `docs/AGENT-DEPLOY-COMPANY.md` 走**（620 行，11 节，节 id 和 `deploy-state` 的阶段一一对应）
2. **每卡一次就记一条**：卡在哪节、报什么错、文档里缺什么
3. **不要凭经验跳过步骤**——那样验不出文档的问题

**成功判据**：

```powershell
powershell -File scripts\deploy-state.ps1 -Side company -Json   # progress 到 11/11
powershell -File scripts\deploy-verify.ps1 -Side company -Json  # ok: true
```

**你有优势，主机没有**：主机写这份文档的人知道所有坑，他自己走的时候会下意识绕开。**你不知道，所以你能暴露他看不见的问题。**

**主机走 `AGENT-DEPLOY-COMPANY.md` 时找出了 4 个错**（`§47.3`）：

- `deploy.ps1` 没有 `-Side` 参数（文档写了）
- `FIX` 文案写死 `%ProgramData%`，员工侧看到会误导
- `deploy-skills.ps1` 的 `-Target` 参数没写
- **§10.6 的渲染命令完全写错**（`deploy-persona.ps1` 只装不渲染）

**这 4 个是"知道的人走一遍"找出来的。你能找出第 5、第 6 个。**

### 3.2 ★ O-5：干净机按 REBUILD 重建成功并计时

**现状**：主机用 `Z:` 盘符模拟过（`§34`：11/11 步、31.9 秒、56 文件、`deploy-layout PASS`），但**真机没做**，所以 ACCEPTANCE 里仍是 🟡。

**怎么做**：

```powershell
# 演练脚本（不写 ProgramData，在空目录里建全套）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\rebuild-drill.ps1 -Root <演练目录>
```

**但真正的 O-5 不是跑这个脚本**——那个脚本只验"文件能落地"。O-5 要的是：

> **按 `docs/REBUILD.md` 在一台真的干净机器上从零建起来，并记下用了多久。**

**`§34` 记过两个只有真机才能验的手工步骤**：

- **`§2` 数据恢复**（要真的备份文件）
- **`§4` bot 登录**（要真的扫码）

**所以你在真机器上要做的**：

1. 照着 `REBUILD.md` 从头做，**每节记时间**
2. 遇到"这一步只有在跑着的主机上才有数据"的地方，**明确标出来**（这是文档的缺口）
3. 最后给出总耗时

### 3.3 ★ E-1 的一半：员工机跑个人 bot

**E-1 的完整判据**是"一台主机跑公司 bot + 员工电脑跑个人 bot"。主机验不了后半句。

**如果你是一台员工办公电脑**：

1. 按 `docs/AGENT-DEPLOY-EMPLOYEE.md` 装（357 行，7 节）
2. 关键判据：

```powershell
powershell -File scripts\deploy-verify.ps1 -Side employee -Json
# bot-online / bot-reply / vault-read
```

**`§33` 记过一个关键结论**：**同一台机器当不了"员工机"**——因为 WorkBuddy 用 asar 里的全局互斥体（`CreateMutex` ×11）保证单实例，两个 bot 在同一台机器上会互相挡住。**所以你必须是一台独立的机器。**

### 3.4 真到 22:00 的 devbot 自动触发

**现状**：`anc-devbot` 计划任务是"每天 22:00 起每 30 分钟"，主机验过：

- 触发链路（`Start-ScheduledTask` → `LastTaskResult=0`）
- 四种时间分支（`-AsOf` 注入）
- 真跑链路（435 秒，issue → `drafted`）

**但没验过"真到 22:00 由计划任务自己触发一次完整跑"。**

**怎么做**（成本最低的一个，只要等）：

1. 装完后**造一条 `status='open'` 的 issue**（`cli` 没有直接造 issue 的命令，可以从 submission 走一遍，或者直接写库——**说明你用了哪种**）
2. 保证机器开着、部署账号保持登录
3. **等到 22:00**（或改任务触发器到几分钟后）
4. 第二天早上看：

```powershell
Get-ScheduledTaskInfo -TaskName 'anc-devbot' | Select-Object LastRunTime, LastTaskResult
Get-Content (Join-Path $env:ProgramData 'anc\data\devbot-scheduler.json')
node src\service\cli.ts --db <库> --json issue list --status open
```

**成功判据**：`devbot-scheduler.json` 里 `lastResult: "ok"`，且原来那条 issue 变成 `drafted`。

### 3.5 `◐` REBUILD 走查复验

**现状**：`§29` 假装新人照 `REBUILD.md` 走过一遍，卡在四处并**全部修掉**。但**修完没有再走一遍**。

**所以 PLAN 里这一项标的是 `◐` 不是 `☑`。**

**你能做**：在你这台机器上**照修好的 `REBUILD.md` 走一遍**，看那四处还卡不卡。

这跟 §3.2（O-5）其实是同一件事——**你走 REBUILD 的过程同时验了 O-5 和这一项**。

### 3.6 `[升级]` 如果你这台机器已经装过

只有这种情况才做：

```powershell
# 升级前先备份
powershell -File <根>\bin\backup-anc.ps1 -Destination <备份目录>
# 部署新版
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Side company -Apply
# 验
powershell -File scripts\deploy-verify.ps1 -Side company -Json
```

**要看的是"数据没丢 + 提醒照常 + bot 能上线"**（`REBUILD` 开头那句）。

---

## 4. 我踩过的坑

**这一节是最值钱的部分。** 下面每一条都是真踩过、真调试过的，**照直觉写会错**。

### 4.1 PowerShell 的坑（重灾区）

#### ① 参数名不能和脚本里的变量重名（大小写不敏感）★ 踩了 6 次

```powershell
param([switch]$Done)
...
$done = @()          # ← 这就是同一个变量！赋值会抛类型错
```

```powershell
param([string]$Now)
...
$now = Get-Date      # ← $Now 的 [string] 约束把 DateTime 强制转回字符串
$now.ToString('yyyy-MM-dd')   # → Cannot find an overload
```

**踩过的**：`$V`/`$v`、`$PSItem`、`$pid`、`$args`、`$Done`/`$done`、`$Failed`/`$failed`、`$Now`/`$now`。

**规矩**：`param()` 里声明的名字，脚本里**不能有大小写不同的同名变量**。给参数加前缀（`-AsDone`、`-AsOf`）最省事。

#### ② `if` 表达式返回单元素数组会解包成标量 ★ 最隐蔽

```powershell
$a = if ($true) { @('x') } else { @() }
# $a 是 String 'x'，不是 Object[] @('x')
```

**后果**：

```powershell
$doneList = if ($st.done) { @($st.done) } else { @() }   # 单元素时是字符串
$doneList += 'workbuddy'                                  # 变成字符串拼接
# → 'preflightworkbuddy'
$ids | Where-Object { $doneList -contains $_ }            # 全部不匹配 → done 被清空
```

**症状极具误导性**：**第一次对、第二次开始错、不报错、数据悄悄变少**。表现成"功能没实现"。

**改法**：数组显式初始化，不靠 `if` 返回值：

```powershell
$doneList = @()
if ($null -ne $st -and $null -ne $st.done) { $doneList = @($st.done) }
```

#### ③ `\` 不是续行符

PowerShell 的续行是反引号 `` ` ``，不是 `\`。

```powershell
# ✗ 错：反斜杠不是续行符
Fail "长消息" \
     "第二行" 2

# ✓ 对：反引号才是续行符
Fail "长消息" `
     "第二行" 2

# ✓ 更好：先算进变量，一行传
$msg = "长消息第二行"
Fail $msg "fix" 2
```

**建议**：能写成一行就写一行，或者先把变量算出来再传。

#### ④ `New-ScheduledTaskAction -Argument ('-xxx ...')` 会变空 ★

```powershell
New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -File x.ps1')
# → Action.Argument 是空字符串
```

**原因**：**括号表达式以 `-` 开头，被当成参数名**。

**还有第二层**：如果这个字符串定义在 `$defs = @(...)` **之后**，`@{}` 里的表达式在赋值时**就已经求值了**，那时变量还是 `$null` → 报 `Argument is null or empty`。

**正确写法**：**先算进变量，且定义在 `$defs` 之前**。

#### ⑤ `$pid` / `$PSItem` / `$args` / `$Error` 是自动变量

不能赋值。`$Error` 尤其危险——写 `-Error` 参数会撞。

#### ⑥ `Join-Path` 的 drive-not-found 是「非终止错误」

```powershell
try { Join-Path 'Z:\nope' 'x' } catch { }   # catch 抓不住！
```

它会往 **stderr** 写一行。后果：agent 用 `2>&1` 调用时 **JSON 被污染**，表现成"脚本崩了"而实际成功。

**改法**：`$ErrorActionPreference = 'SilentlyContinue'` + 每个路径操作加 `-ErrorAction SilentlyContinue`。

#### ⑦ `.ps1` 必须带 UTF-8 BOM

PowerShell 5.1 读无 BOM 的中文 `.ps1` 会乱码，而且**报错信息指向莫名奇妙的位置**。

```powershell
$t = [IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)
[IO.File]::WriteAllText($p, $t, (New-Object Text.UTF8Encoding($true)))   # $true = 带 BOM
```

**注意**：`.json` **不许**带 BOM（`check-public` 会查这个）。

### 4.2 文本/文件的坑

#### ⑧ CRLF 会让多行锚点匹配不上 ★ 踩了 4 次

```javascript
s.includes('## 知识在哪\n\n- 公司共享区…')   // ✗ 文件是 CRLF，匹配不上
```

**症状**：锚点替换"成功执行了但没变化"。

**规矩**：**凡是多行字符串做锚点 replace 文件，先归一化再还原**：

```javascript
const crlf = raw.includes('\r\n');
let s = raw.replace(/\r\n/g, '\n');
// ... 改 ...
writeFileSync(p, s.replace(/\n/g, crlf ? '\r\n' : '\n'));
```

#### ⑨ `git commit -m "长中文"` 会被 PowerShell 拆参数

用 `-F <文件>`：

```powershell
$p = Join-Path $env:TEMP 'msg.txt'
[IO.File]::WriteAllText($p, $msg, (New-Object Text.UTF8Encoding($false)))
git commit -F $p -q
```

#### ⑩ 工具 `edit` / `write` 会弄坏中文 `.ps1`

乱码 + 丢 BOM。**改用 node 读写**（`fs.readFileSync(p, 'utf8')` → 改 → `writeFileSync`）。

#### ⑪ `check-public` 只扫 `git ls-files`

**自测前必须先 `git add`**，否则新文件不扫。

### 4.3 逻辑/判据的坑（这几条最容易让结论错）

#### ⑫ `test-emit.flag` 是「下次启动时读一次」，不是「现在开不开」★

`OPS.md` 记过。**flag 存在 ≠ 端口在监听**。

**正确判法**：先探端口，不是先看文件。

```powershell
$listening = [bool](Get-NetTCPConnection -LocalPort 17999 -State Listen -ErrorAction SilentlyContinue)
```

**踩过的**：`deploy-verify` 第一版按 flag 判，真机上报 FAIL，实际手工注入立刻成功——**把"要重启"当成了"坏了"**（`§45`）。

#### ⑬ `patch-guard` 用 15 秒窗口判补丁新旧

```powershell
if ($okMode -and $at -ge $main.CreationDate.AddSeconds(-15)) { $patched = $true }
```

**不是只看 `applied: true`**。所以"状态文件里 pid 已死"不必然导致误判——`at` 是注入后才写的，本来就晚于进程创建。

#### ⑭ Interactive 计划的 `Start-ScheduledTask` 可能静默不执行 ★

`Principal.LogonType = Interactive` 的任务，在某些会话状态下 `Start-ScheduledTask` **返回成功但根本没跑**。

**怎么发现**：看 `Get-ScheduledTaskInfo` 的 `LastRunTime` **有没有变**。

**踩过的**：以为"重启了 WorkBuddy 但补丁没生效"，实际是**那次启动根本没执行**（`§48.5` 记录了这个推翻过程）。

#### ⑮ 「恢复手段有效」≠「识别出的原因正确」★★ 最重要

主机犯过这个错：看到"删掉 `patch-state.json` 就好了"，就写成"陈旧状态导致误判"。

**复查三条证据全推翻**：

- `patch-guard` 有 15 秒窗口校验，`applied` 不是唯一判据
- `selfheal.log` 在声称的时间段**一条记录都没有**
- `Get-ScheduledTaskInfo` 的 `LastRunTime` 停在更早的时间——**那次触发根本没执行**

**「删了就好了」是巧合。**

**规矩**：下了因果结论之后，**去查这个文件/变量被谁读、读的时候怎么判**。`grep` 一遍成本极低。

#### ⑯ 「跑过了」≠「有效」

`deploy-state` 记的是"哪些步骤跑过了"，但**跑过 ≠ 能用**。所以要 `deploy-verify` 再验一遍"能不能用"。

**两条判据的区别**：

| | `deploy-state` | `deploy-verify` |
|---|---|---|
| 回答 | 装到第几步 | **装出来的东西能用吗** |
| 失败含义 | 那步没做成 | **系统不可用** |

---

### 4.4 环境与外部工具（2026-11-05 新增，8 条）

这几条不在 PowerShell / 文本 / 判据里，属于「环境与外部工具」。**共同特征：失败时不报错。**

#### ⑰ `ELECTRON_RUN_AS_NODE=1` 会让 Electron 应用静默退出

**症状**：`Start-Process WorkBuddy.exe` 之后进程 0.5 秒消失，`ExitCode=0`，**stderr 空、崩溃日志无、连 userData 都不重建**。

**根因**：这个环境变量让 Electron 以纯 Node 模式运行 —— 不启动 Chromium、不初始化应用、直接退 0。而它常常是**父进程带下来的**（某些 IDE / CI / 终端本身就是 Electron 派生）。

**怎么避**：

```powershell
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $exe
$psi.UseShellExecute = $false
$psi.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE') | Out-Null
[void][System.Diagnostics.Process]::Start($psi)
```

**诊断顺序**：进程 0 秒退出 + 无日志 → **先查这个变量**，别去查单实例锁 / 崩溃转储 / Defender / asar 完整性。我在这上面耗了一小时，全部方向都是错的。

#### ⑱ 补丁注入不是 100%，实测约 66%

**症状**：`workbuddy-patch.log` 只有 `[inject] env set: OK:<pid>`，然后**没有** `INJECTED` / `APPLIED`；`patch-state.json` 不写、17999 不监听、`WorkBuddy 进程: 0`。

**根因**：`--inspect-brk` 暂停 → inject 设 `process.env.NODE_OPTIONS` → resume 这条路，有约 1/3 概率让主进程崩（事件日志留 `0xc0000005`）。

**实测数据**：210 次 `env set` / 140 次 `APPLIED` = **66.7%**（`VERIFY §59`）。

**怎么避**：

- **别等固定时间。** 从放行到 `APPLIED` **约 60 秒**；等 25 秒就判失败是错的。
- 用 `launch-patched.ps1`，它现在自己轮询 `patch-state.json`（最多 150 秒）再报结论。
- `anc-selfheal.ps1` 已把重试 2 → 4 次：全失败概率 11.1% → **1.23%**。

#### ⑲ 判「注入失败」前，先看日志有没有 `APPLIED`

**症状**：`patch-state.json` 不存在，你就判注入失败 —— 但**日志里其实有 `APPLIED`**，只是没等到。

**怎么避**：

```powershell
# 先看日志，再看状态文件
Get-Content "$env:USERPROFILE\anc\workbuddy-patch.log" -Tail 20 | Select-String "APPLIED|INJECTED|ERROR"
```

看到 `APPLIED mode=hash` 就是成功了。**`patch-state.json` 不存在 ≠ 注入失败。**

#### ⑳ `patch-state.json` 会跨版本残留，`doctor` 也信它

**症状**：它写着 `applied=True`、`mode=hash`、`pid=6880`，而**那个 pid 早死了**。`doctor` 却报 `[PASS] patch: APPLIED(hash) + update-hook`。

**根因**：自愈失败时只写了 `selfheal.state.json`，没回写 `patch-state.json`，所以它留着上一次成功的内容。

**已修**（`VERIFY §61`）：`anc-selfheal.ps1` 的失败分支现在会覆盖成 `applied=false` + `error`。

**怎么避**：判补丁是否真在，**必须同时满足**「`applied=true`」**和**「那个 `pid` 还活着」。只看前者会被骗。

#### ㉑ `robocopy /E` 不带 ACL，恢复完权限会同时太宽和太窄

**症状**：从备份恢复 `%ProgramData%\anc` 后 `doctor` 报两个 FAIL：

- `secrets-acl`：`secrets` 对 `BUILTIN\Users` 可写（**太宽**）
- `heartbeat`：`loop.log` 不更新（**太窄** —— 服务身份没写权限）

**怎么避**：`robocopy` 只拷数据不拷权限，恢复完必须补 ACL。完整命令见 `REBUILD.md §2.5`。

#### ㉒ `LOCAL SERVICE` 读不到 secrets，表现是「任务成功但日志不动」

**症状**：`anc-service` 的 `LastRun` 每分钟在变、`LastResult=0x0`，但 `loop.log` 的 mtime 一直不动。

**根因**：`secrets` 或 `data` 的 ACL 里漏了 `LOCAL SERVICE`。服务跑得起来，但 `cli.ts` 读不到 token / 写不了日志；而 `anc-loop.cmd` 的 `>> "%LOGF%" 2>&1` 重定向失败会让 `cmd` 提前退出 —— **任务计划那侧仍然显示成功**。

**怎么避**：

```powershell
icacls "$env:ProgramData\anc\secrets" /grant:r 'LOCAL SERVICE:(OI)(CI)RX'   # 读
icacls "$env:ProgramData\anc\data"    /grant    'LOCAL SERVICE:(OI)(CI)M'    # 写
# 已有日志文件不继承新 ACE，逐个补
foreach ($f in 'loop.log','http.log','patch-in.log','patch-out.log','selfheal.log','audit.log') {
    $p = Join-Path "$env:ProgramData\anc\data" $f
    if (Test-Path $p) { icacls $p /grant 'LOCAL SERVICE:(M)' | Out-Null }
}
```

**验证别只读 ACL —— 造探针实地跑**（见下一条）。

#### ㉓ 造同身份探针任务，比读 ACL 猜快得多

**场景**：不确定「某个身份能不能跑某个命令」时。

```powershell
$act  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c "<要验的脚本>"'
$prin = New-ScheduledTaskPrincipal -UserId 'LOCAL SERVICE' -LogonType ServiceAccount
Register-ScheduledTask -TaskName 'anc-probe-xxx' -Action $act -Principal $prin -Force | Out-Null
Start-ScheduledTask -TaskName 'anc-probe-xxx'; Start-Sleep -Seconds 18
"LastResult=0x{0:X}" -f (Get-ScheduledTaskInfo -TaskName 'anc-probe-xxx').LastTaskResult
Unregister-ScheduledTask -TaskName 'anc-probe-xxx' -Confirm:$false
```

**看什么**：① 退出码 ② **副作用**（目标文件的 mtime 变没变）。

**退出码 0 不代表副作用发生了** —— 这正是 ㉒ 那个坑能藏那么久的原因。

#### ㉔ 文档里会引用「不存在的脚本」

**症状**：照 `AGENT-DEPLOY-COMPANY.md §7` 跑 `patch\apply.ps1 -Apply` → 报「文件不存在」。

**根因**：`apply.ps1` 从来不存在，实际入口是 `launch-patched.ps1`。**文档长期没被真跑过，所以没人发现。**

**已修**（`VERIFY §62`）：六处引用全部改正。

**通用教训**：照文档做之前，先扫一遍它引用的脚本是否真的存在：

```powershell
Select-String -Path docs\*.md -Pattern '[\w\\\.\-]+\.(ps1|mjs)' -AllMatches |
  ForEach-Object { $_.Matches.Value } | Sort-Object -Unique |
  ForEach-Object { "{0,-46} {1}" -f $_, (Test-Path $_) }
```

---

## 5. 测试方法

主机验证 `VERIFY §42`–`§48` 时用的思路，你可以直接复用。

### 5.1 弄坏它，看会不会报（故障注入）

**这是最核心的方法。** 一个检查项如果"弄坏了也不报"，它就不是检查项。

```powershell
# 例：验 doctor 真的覆盖了 anc-devbot
Disable-ScheduledTask -TaskName 'anc-devbot'
powershell -File scripts\doctor.ps1 -Json   # 期望 ok=False, fails=1，且只报这一项
Enable-ScheduledTask -TaskName 'anc-devbot'
powershell -File scripts\doctor.ps1 -Json   # 期望 ok=True
```

**判断标准**：`fails` 增加了**且只增加这一项**。如果增加了很多项，说明它跟别的检查耦合了；如果没增加，说明它根本没接上。

**主机做到 29/30**（剩 1 项是 `vault-ingest-audit`，它的上限设计就是 WARN）。

### 5.2 注入时间，而不是改系统时间

验"22:00 才跑""周末不跑""节假日不跑"这类分支，**不要改系统时间**——会影响 service、提醒、备份所有定时逻辑。

**给脚本加一个可注入的"现在"**：

```powershell
powershell -File scripts\devbot-scheduler.ps1 -AsOf '2026-11-04 22:30' -Json
```

**参数名别叫 `-Now`**（会撞 `$now`，见 §4.1 ①）。

### 5.3 真关掉，而不是伪造 SKIP

验"某个依赖不在时的降级行为"，**把依赖真的关掉**，不要改代码或者造状态文件。

```powershell
# 例：验 deploy-verify 的 SKIP 分支
Remove-Item <根>\data\test-emit.flag
Stop-Process WorkBuddy -Force; 触发 launch; 等 45-80 秒
powershell -File scripts\deploy-verify.ps1 -Side company -Json   # 期望 bot-reply = SKIP
# 恢复
Set-Content <根>\data\test-emit.flag -Value 'enabled'
```

### 5.4 `SKIP` 不是 `PASS`

**`SKIP` 的意思是"没验"，不是"没问题"。**

`deploy-verify` 的输出里，`ok: true` + `skip: 1` 的 `next` 会写：

```
没有 FAIL，但有 1 项 SKIP——那不是通过，是没验。列在下面了。
```

**报告时也要这么说**，不要写"全绿"。

### 5.5 最小诊断脚本（5 秒定位）

当"看起来该成功但失败"，**不要读错误消息猜**，写个探针把所有相关变量打出来：

```powershell
$probe = @'
$out = @()
$out += 'PWD=' + (Get-Location)
$out += 'USERPROFILE=' + $env:USERPROFILE
$out += 'target-exists=' + (Test-Path $target)
$out += 'actual=' + (Get-Content $target -Raw -ErrorAction SilentlyContinue)
[IO.File]::WriteAllLines($outFile, $out, (New-Object Text.UTF8Encoding($false)))
'@
```

主机用这个 5 秒定位了一个"退出码 `0xFFFF0000`"的问题——**那个退出码看起来像权限问题，实际是"文件路径不存在"**（测试里 `import.meta.dirname` 上溯级别写错）。

### 5.6 三段验证法（并说明局限）

一个"自动化任务"其实有三段，**分开验，别混**：

| 段 | 验什么 | 怎么验 |
|---|---|---|
| **触发链路** | 计划任务能不能被触发 | `Start-ScheduledTask` + 看 `LastTaskResult` |
| **判定逻辑** | 该跑的时候会不会跑 | `-AsOf` 注入不同时间 |
| **真跑链路** | 跑起来能不能成 | `-Force` 强制跑一次看产出 |

**三段都过 ≠ 端到端通过**。**要明确写出"没有一条时间轴串起来"**（`§48.2` 就是这么标的）。

**不要因为三段都绿就说"端到端验过"。**

---

## 6. 工具速查

### 6.1 脚本清单

| 脚本 | 干什么 | 关键参数 | 输出 |
|---|---|---|---|
| `preflight.ps1` | 装之前查这台机器行不行 | `-Side company\|employee` `-Json` | `{ok, blockers[], warnings[], next, facts}` |
| `deploy.ps1` | 部署运行件（备份+对拍+失败回滚） | `-Side` `-Root` `-Apply` `-Rollback` | 退出码 0/1/2/3 |
| `deploy-skills.ps1` | 装技能到 `~/.workbuddy/skills` | `-Apply` `-RemoveExtra` `-Rollback` `-Target` | 逐文件对拍 |
| `deploy-persona.ps1` | **装** persona（不渲染） | `-Source` `-Target` `-Rollback` `-DryRun` | sha256 对照 |
| `deploy-state.ps1` | 记进度、断点续装 | `-Side` `-Mark <id>` `-AsDone`/`-AsFailed` `-Reset` `-Json` | `{progress, done[], failed, next, stages[]}` |
| `deploy-verify.ps1` | **自证**装出来的能不能用 | `-Side` `-ChatId` `-SkipBot` `-KeepData` `-Json` | `{ok, pass, fail, skip, checks[], next}` |
| `doctor.ps1` | 健康检查（30 项） | `-Root` `-Repo` `-Json` `-SelfTest` | `{ok, fails, warns, checks[]}` |
| `register-tasks.ps1` | 注册 10 个计划任务 | `-Apply` `-Only <name>` `-BotUser` `-Repo` | 逐任务列表 |
| `devbot-scheduler.ps1` | 全员下班 → 跑 devbot | `-Apply` `-Force` `-AsOf "yyyy-MM-dd HH:mm"` `-Json` | `{willRun, reason, issue, facts}` |
| `devbot.ps1` | 让 agent 改技能 | `-Issue` `-ChatId` `-Apply` `-LivePersona` | 逐步骤日志 |
| `e2e-loop.ps1` | L1→L2→L3→L4→L6 串起来 | `-Apply` | 12 分钟 |
| `rebuild-drill.ps1` | 演练重建（不碰 ProgramData） | `-Root` | 步数/文件数/耗时 |
| `verify-upgrade.ps1` | 升级后验 | — | 逐项 PASS/FAIL |

### 6.2 两条输出契约

**所有脚本统一**：

- `-Json` 输出**纯净 JSON**（stderr 不能污染）
- 退出码：`0` 成功（含 dry-run、含"决定不做"）/ `1` 校验失败或有 FAIL / `2` 用法或环境错误

**所有 `-Side` 脚本统一**：

- `company` → `%ProgramData%\anc`
- `employee` → `%LOCALAPPDATA%\anc`

### 6.3 关键路径

```
%ProgramData%\anc\            部署根（company）
  bin\                        所有 .ps1 的部署副本
  data\anc.db                 SQLite（真相源）
  data\deploy-state.json      进度
  data\devbot-scheduler.json  devbot 运行记录
  data\patch-state.json       补丁状态
  data\test-emit.flag         test-emit 开关（启动时读一次）
  render\                     persona 渲染产物
  secrets\                    webhook / corpid / corpsecret

%LOCALAPPDATA%\anc\           部署根（employee，同样的结构）

%USERPROFILE%\.workbuddy\skills\    技能
%USERPROFILE%\WorkBuddy\Claw\CODEBUDDY.md   WorkBuddy 读的 persona
```

---

## 7. 交回什么

### 7.1 一份记录

写 `docs/VERIFY-<机器标识>.md`，**照 `VERIFY.md` 的格式**：一节一件事，每节有"做法 / 结果 / 判据"。

**必须包含**：

1. **这台机器是什么**（干净机 / 员工机 / 已装过）+ 怎么判断的
2. **每个任务的结论**：通过 / 未通过 / 做不了（+ 卡在哪）
3. **你踩的坑**——这个最重要，下一个人要靠它

### 7.2 修掉你发现的问题

**凡是"文档说 A、实际是 B"或者"照文档做会卡住"的，直接改文档**，然后在提交信息里说清"哪一节、原来写什么、实际是什么"。

主机走过一遍就改了 4 处（`§47.3`）。**你走一遍，一定还有。**

### 7.3 报告格式

```
这台机器：<干净机 / 员工机 / 已装过>，<有/无> 管理员权限

D4.6 公司侧    PASS / FAIL / 做不了     <一句话>
               卡点：<哪一节、什么错>
O-5            ...
E-1 员工机     ...
devbot 22:00   ...
REBUILD 复验   ...

文档改了 N 处：
  <节> <原来> → <实际>

新发现的坑：
  1. ...
```

### 7.4 不要做的事

| 别做 | 为什么 |
|---|---|
| **别凭"应该没问题"结案** | 拿不准就写"未验证" |
| **别把 `SKIP` 说成通过** | 那是没验 |
| **别因为失败就从头重装** | 用 `deploy-state` 断点续装 |
| **别在真机上改 `ProgramData` 里的文件** | 那是事故。改仓库 → 重新部署 |
| **别把真实 chatId / userid 写进文档** | 用占位符 `<chatId>` / `<userid>` |

---

## 附：这份项目的一句话背景

小团队用一台 7×24 的 Windows 主机跑**公司 bot**，每个员工电脑跑**个人 bot**，执行引擎是腾讯 **WorkBuddy**（企业版），IM 是**企业微信**，公司知识放在主机上的 markdown vault 里。

**本库不自己实现 agent 框架、不写 IM 网关**——这两样都用现成的。本库只做它们之外的部分：渲染器（生成 persona 和群映射）、本地小服务（状态/提醒/outbox）、入库进程、接入脚本、主机运维。

**迭代闭环**：员工在群里报问题 → `submission` → `issue` → `patch draft` → `devbot` 用 WorkBuddy 改技能 → `eval` 判定 → 合入。这条链主机已验通（`§27`，12 分钟）。

**你手上这台机器要做的，就是让"第二个人/第二台机器能不能独立装起来"这件事从"没人验过"变成"验过了"。**
