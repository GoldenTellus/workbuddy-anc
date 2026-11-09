# 主机重建 runbook

> 类型：运维手册（主机重建）

主机坏了，按这份在新机器上重建。目标：**数据不丢、提醒照常、bot 能上线**。

## 0. 先分清哪些东西不在 git 里

| 资产 | 位置 | 是否有副本 |
|---|---|---|
| SQLite 数据库 | `C:\ProgramData\anc\data\anc.db` | `anc-backup` 每天 02:00（本地保留 14 份；离机目标要**自己配**） |
| 密钥（webhook / 运维 webhook / userid） | `C:\ProgramData\anc\secrets\` | **只有主机上有**；须另行离线保存 |
| vault 原件 `_originals/` | `D:\anc\vault-shared\_originals\` | 不进 git；须随备份一起复制 |
| 两区 vault 的 git | `D:\anc\vault-*` | 有 git 历史；建议加一个远端 |
| org 数据 / 渲染产物 | `D:\anc\org`、`D:\anc\build` | 建议纳入 vault 内部区或单独备份 |

## 1. 新机准备

1. Windows + 管理员账号；
2. Node.js 22 LTS（设计基线；本机 2026-11-09 实测 v26.13.0 亦可跑 216/216）、Git for Windows；
3. 把仓库 clone 到 `E:\workbuddy-anc`（或任意路径，下面用变量）；
4. 建目录。**完整清单在这里，别按 §3 那句命令行抄**（那段只建 deploy 要写的 7 个，其余要手工建）：

   ```
   C:\ProgramData\anc\   accounts  backup  bin  data  evals  inbox  ingest
                          light     patch   render  secrets  service  shared
                          skills    stage
   （15 个，2026-11-04 按实际部署核对）

   D:\anc\               vault-shared  vault-internal  inbox  org  build
   ```

   - `evals`（用例）、`light`（渲染源）、`stage`（入库暂存）、`inbox` 是运行时才会被写到的，
     `deploy.ps1` 不管它们，漏建会在第一次用到时炸；
   - `D:\anc` 假定有 D 盘。没有的话要改三处：`company.md` 的 `vault_shared`/`vault_internal`、
     计划任务里的路径、**以及跑 `doctor.ps1` 时传的 `-VaultRoot`**（`# 11 vault 目录 NTFS` 与
     `# 20 vault 改动有没有入库记录` 都从它推导共享区路径，默认 `D:\anc`）。
     漏传的表现是：在别的盘符上跑它，vault 那两项查的还是 `D:` 上的真实目录。
     2026-11-06 起演练根传 `-VaultRoot <演练根>` 即可，不用再手改脚本
     （`VERIFY §34` 第 ③ 点）。

## 2. 恢复数据

```powershell
# 数据库：取最新一份备份
Copy-Item E:\anc-backup\anc-<最新>.db C:\ProgramData\anc\data\anc.db
# 密钥：从离线保管处放回（值不进 git、不进聊天）
# 原件与 vault：从备份复制 D:\anc\vault-shared / vault-internal（含 _originals）
```

### 恢复完先自查这四项，再往下走

这一步没有自动化验证（数据是外面拿来的，脚本不知道"应该有多少"），但下面四条能拦住绝大多数"看似恢复了、实际缺东西"。

```powershell
$A = 'C:\ProgramData\anc'; $Cli = "$A\service\cli.ts"

# 1) 库能打开吗、里面有没有东西
node $Cli --db "$A\data\anc.db" --json task list --limit 1     # 不报错、有返回
node $Cli --db "$A\data\anc.db" --json bind list               # 至少有一条绑定
node $Cli --db "$A\data\anc.db" --json config list             # work_start/work_end/timezone 都在

# 2) 两区 vault 的 git 历史还在吗（不在的话"版本历史"这层就没了）
git -C D:\anc\vault-shared   log --oneline -3
git -C D:\anc\vault-internal log --oneline -3

# 3) 原件在吗（PDF/图片都不进 git，只能靠备份带过来）
(Get-ChildItem D:\anc\vault-shared\_originals -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count

# 4) 密钥文件齐吗（**只看名字和大小，不要打印内容**）
Get-ChildItem "$A\secrets" -File | Select-Object Name, Length
```

**判据**：

| 项 | 什么样算过 |
|---|---|
| 库 | 三条命令都返回合法 JSON，不报 `database is locked` / `no such table` |
| vault git | 两个仓库都能 `log`，说明 `.git` 一起带过来了 |
| 原件数 | 和备份前对得上。**这一项最容易漏**——`_originals/` 不在 git 里，只复制 `*.md` 会丢 |
| 密钥 | 至少有一个 `wecom-webhook.txt`。少了就得去群机器人设置里重新生成 |

**救不回来的三种情况**（`§6 已知缺口` 里有详述）：密钥没离线副本 → 只能重新生成 webhook；`_originals/` 没随备份走 → 原件永久丢失；vault 的 git 没带走 → 历史没了但文件还在。


### 2.5 恢复 ACL —— `robocopy` 不带权限，这一步不做后面全错

**这一段是 2026-11-05 实测补的**（`VERIFY §62`）。之前这份 runbook 只讲拷文件、没讲权限，结果按它恢复完 `doctor` 报 3 个 FAIL，**其中 2 个是权限问题**。

**为什么**：`robocopy /E` 只拷数据、**不拷 ACL**。恢复出来的目录会退回从 `%ProgramData%` 继承的默认权限，而那套默认权限对这台机器**同时太宽和太窄**：

- **太宽**：`secrets\` 会变成 `BUILTIN\Users` 可写 → `doctor` 的 `secrets-acl` 直接 FAIL
- **太窄**：`data\` 下的日志对 `LOCAL SERVICE` 只读不写 → 服务跑得起来但写不进 `loop.log`，`doctor` 的 `heartbeat` FAIL，而**任务记录显示「每分钟成功、退出码 0」**

**「太窄」这一半尤其阴**：所有间接证据都说服务正常，唯一异常是日志文件不动。不造探针实地跑一次，光看任务状态永远发现不了。

```powershell
$A = 'C:\ProgramData\anc'

# ① secrets：SYSTEM / Administrators 全控 + LOCAL SERVICE 只读
#    LOCAL SERVICE 不能漏 —— anc-service 和 anc-http 都是以它运行的
icacls "$A\secrets" /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' 'LOCAL SERVICE:(OI)(CI)RX'

# ② data：服务身份要能写日志
icacls "$A\data" /grant:r 'LOCAL SERVICE:(OI)(CI)M'

# ③ 已经存在的日志文件不继承新 ACE，要逐个补
foreach ($f in 'loop.log','http.log','patch-in.log','patch-out.log','selfheal.log','audit.log') {
    $p = Join-Path "$A\data" $f
    if (Test-Path $p) { icacls $p /grant:r 'LOCAL SERVICE:(M)' | Out-Null }
}
```

**判据**：

| 项 | 怎么查 | 期望 |
|---|---|---|
| secrets 不对外 | `(Get-Acl "$A\secrets").Access \| % { $_.IdentityReference }` | 只有 SYSTEM / Administrators / LOCAL SERVICE，**没有 BUILTIN\Users** |
| 服务能写日志 | 见下面的探针 | `LastResult=0x0` 且 `loop.log` 的 mtime 变了 |

**用探针验证服务身份真能写**（比读 ACL 靠谱得多）：

```powershell
$ll = "$A\data\loop.log"; $before = (Get-Item $ll).LastWriteTime
$act  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c "C:\ProgramData\anc\bin\anc-loop.cmd"'
$prin = New-ScheduledTaskPrincipal -UserId 'LOCAL SERVICE' -LogonType ServiceAccount
Register-ScheduledTask -TaskName 'anc-probe-ls' -Action $act -Principal $prin -Force | Out-Null
Start-ScheduledTask -TaskName 'anc-probe-ls'; Start-Sleep -Seconds 18
$i = Get-ScheduledTaskInfo -TaskName 'anc-probe-ls'
"LastResult=0x{0:X}" -f $i.LastTaskResult
"loop.log 更新: {0}" -f ((Get-Item $ll).LastWriteTime -gt $before)
Unregister-ScheduledTask -TaskName 'anc-probe-ls' -Confirm:$false
```

**为什么要造探针**：任务计划里显示「成功运行、退出码 0」**并不代表脚本里的重定向成功了**。用同一个身份、同一个脚本实地跑一次，看**副作用**（文件时间有没有变），才能确定。

**恢复完顺手重启服务**，让它们用新权限重新读 secrets：

```powershell
Start-ScheduledTask -TaskName 'anc-service'
Start-ScheduledTask -TaskName 'anc-http'
Start-Sleep -Seconds 60
powershell -File E:\workbuddy-anc\scripts\doctor\doctor.ps1
# 期望 fails=0；如果 http-health 还 FAIL，确认 17891 在监听（不是 18765，那个是猜的）
```

---

## 3. 装服务与任务

**不要手工列复制清单**。用 `deploy.ps1`：它是部署的唯一真相源，带映射表 + 覆盖率检查
（`src/` 下每个文件都必须落在某个映射下，否则直接 Fail），还有逐文件 hash 校验和备份。

```powershell
$R = '<仓库>'; $A = 'C:\ProgramData\anc'
# 目标目录先建好（root 不存在时 deploy 会 Fail）
'service','ingest','render','shared','bin','backup','patch' | ForEach-Object { New-Item -ItemType Directory -Force "$A\$_" | Out-Null }
powershell -File "$R\scripts\deploy\deploy.ps1" -Repo $R -Root $A -Apply
```

> 为什么改成这样：原来这段手工列 `Copy-Item "$R\src\service\*" ...`，只覆盖 service/ingest/render。
> 后来加了 `src\shared\audit.ts`，手工清单没跟上——按老 runbook 重建的机器上 CLI 会
> `ERR_MODULE_NOT_FOUND`，而且删掉之后 doctor 读出来全是空。deploy 的覆盖率检查能当场拦住这类漂移。

补丁（线上补丁的唯一来源）也由 deploy 一并复制到 `patch\`。

按 [OPS.md](./OPS.md) 重新注册计划任务（现 **13 个**，以 OPS 的计划任务表为准）：`anc-service`、`anc-backup`、
`anc-boot-alert`、`anc-cleanup`、`anc-watchdog`、`anc-http`、`anc-workbuddy-launch`、`anc-patch-guard`、
`anc-update-watch`，以及 `anc-executor-wake`、`anc-executor-new-host`、`anc-executor-host-tick`、`anc-devbot`。

> `anc-workbuddy-launch`、`anc-patch-guard`、`anc-devbot` 必须用**bot 用户 + Interactive** 身份注册，否则拉不起 GUI / 切不了 persona。
> 三个 `.cmd`（`anc-guard.cmd`、`anc-launch.cmd` 进 `bin\`，`anc-loop.cmd` 进 `service\`）由 deploy 复制；
> 触发器、身份、参数照 OPS.md 的计划任务表。

## 4. 恢复 bot

**按 D25：直接用管理员账号部署，不建专用用户。**

1. 用管理员账号登录（不开自动登录、本机不存密码——这两条仍然有效）；
2. 安装 WorkBuddy（企业版），扫码登录企业微信；
   > **非标准安装路径用 Junction 指回标准位置**（本机装在 `D:\App\WorkBuddy`）：
   > `New-Item -ItemType Junction -Path "$env:LOCALAPPDATA\Programs\WorkBuddy" -Target 'D:\App\WorkBuddy'`；
   > **回滚 = 删 Junction**（`Remove-Item` 只删链接，不动安装本体）。补丁会把实际 exe 路径写进
   > `%ProgramData%\anc\data\workbuddy-path.txt`，`doctor` 的 `workbuddy` 检查优先读它（详见 `OPS.md`）。
3. 用补丁启动器启动：`launch-patched.ps1`，确认日志里 `APPLIED mode=hash` + `update-hook installed`；
   - 若启动器报"已启动"但进程数为 0，多半是 `--inspect-brk` 卡在等调试器，重跑一次即可；
4. 装技能：**用脚本，不要手工复制**（手工抄一次就可能和仓库不一致，而且没人知道差在哪）：

   ```powershell
   powershell -File "<仓库>\scripts\deploy\deploy-skills.ps1"          # 预检
   powershell -File "<仓库>\scripts\deploy\deploy-skills.ps1" -Apply   # 真部署
   ```

   落盘目录按 `SKILL.md` 里的 `name:` 字段，不是仓库目录名（仓库里 `anc-ingest-company` 的
   技能名是 `anc-ingest`，按目录名落盘会造出两个同名技能）。脚本会检查这件事。
   技能在**新会话**才生效（每会话首次注入时读盘，`VERIFY §18`）。
5. **不用等人发消息** —— 用 `§4b` 的 test-emit 自己验：

   ```powershell
   New-Item -ItemType File -Force "$env:ProgramData\anc\data\test-emit.flag" | Out-Null
   # 重启 WorkBuddy，等 8–30 秒，然后照 §4b 注入一条「今天有什么任务」
   # 看 patch-out.log 里有没有回复正文
   ```

   验完记得删掉 `test-emit.flag`。

> **代价是知情的**（D25）：WorkBuddy 及其 `preload.cjs` 补丁在这个账号下拿到管理员权限。
> 它或它加载的任何东西出问题，损失是整台主机。要收紧时的做法：建一个标准用户，
> 把两个 Interactive 计划任务与 WorkBuddy 迁过去，再用 `doctor -BotUser <该用户>` 复核。
## 4b. 装完之后怎么验（不用等人）

装完 bot 之后，**先别去群里发消息**——下面这些都能自己验。

### 测试入口：模拟「有人 @ 了 bot」

补丁在 `preload.cjs` 里开了一个本地 HTTP 口（默认 `127.0.0.1:17999`），可以伪造一条入站消息。
**默认关着**，要有 `%ProgramData%\anc\data\test-emit.flag` 才生效。

```powershell
# 开（重启 WorkBuddy 后 8–30 秒可用）
New-Item -ItemType File -Force "$env:ProgramData\anc\data\test-emit.flag" | Out-Null

# 用：注入一条消息
$body = @{
  chatId  = "<完整 chatId，从 groups 表或 bind group-list 取，别从日志抄截断的>"
  user    = "<员工 userid>"
  msgId   = ([guid]::NewGuid().ToString("N"))
  content = "今天有什么任务"
} | ConvertTo-Json -Compress
Invoke-RestMethod -Uri "http://127.0.0.1:17999/emit" -Method Post `
  -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($body))

# 关（用完删掉 flag）
Remove-Item "$env:ProgramData\anc\data\test-emit.flag"
```

**怎么判断 bot 真处理了**（按可靠程度排序）：

1. `%ProgramData%\anc\data\patch-out.log` 里出现**回复正文**（最硬）。
   注意它是**单行**格式，换行被转义成字面 `\n`，且只记前 400 字符。
2. `patch-canary.json` 的 `at` 更新了（证明收到了，但不知道回了什么）。
3. `daemon.log` 里 `[SubscriptionGate] ... type=skill name=<技能>`（证明它在看某个技能）。

**三个前提**：重启后要等 8–30 秒；它只走 `emitMessage`，不检查 @ 标记（所以"会不会回应"不能只靠它判断）；
它不做认证，只监听回环地址。

### 迭代闭环的几个命令

`C:\ProgramData\anc\service\cli.ts` 有这些子命令组，装完之后可以逐组试一下：

| 命令 | 干什么 | 试法 |
|---|---|---|
| `submission add/list` | 员工报的问题原话 | `--text "…" --chat-id "<id>"` |
| `issue draft/list/triage` | submission → 结构化 issue | `--submission <id>` |
| `patch draft/list/show` | issue → 可评审的 diff | `--issue <id> --repo <仓库>` |
| `dayend add/list/all-off` | 下班记录 + 全员下班判定 | `--employee "…"`；`all-off` 看夜间窗口该不该开 |
| `eval run/list/history` | 驱动 bot 回放用例判 pass/fail | `--case <id> --chat-id <id> --repo <仓库> --wait-ready` |

### 两个编排脚本

```powershell
# 端到端：一条反馈走完 L1→L2→L3→L4→L6（约 12 分钟）
powershell -File "<仓库>\scripts\devbot\e2e-loop.ps1" -ChatId <id> -UserId <id> -Apply -WithDevbot

# 只跑 devbot：切 persona → 注入 issue → 等 → 检查 → 恢复（约 7 分钟）
powershell -File "<仓库>\scripts\devbot\devbot.ps1" -Issue <api号> -ChatId <id> -UserId <id> -Apply
```

`devbot.ps1` 会把 live persona 切到 `light/personas/devbot/CODEBUDDY.md`，跑完在 `finally` 里恢复。
**它不负责切 git 分支**——那是调用方的责任。`e2e-loop.ps1` 里有这句（开头记 `$startBranch`，汇总前切回）。
自己写编排脚本时别忘了这件事：**任何会改 `git` 当前分支的脚本，都必须负责把分支切回去**。

## 5. 验收

```powershell
powershell -File C:\ProgramData\anc\bin\doctor.ps1      # 判据见下
powershell -File C:\ProgramData\anc\bin\watchdog.ps1    # 无异常退出 0
```

**doctor 的合格线是 `FAIL=0`，不是"全 PASS"。** WARN 项按实际数据恢复情况而变：
本机公司侧 2026-11-09 实测 WARN=3（`work-hours` / `patch` / `bindings`；`canary` 在收到首条真实消息后 PASS，见 `DEPLOY-COMPANY.md §12`）。
重建机上典型的一条 vault 相关 WARN 长这样：

```
WARN  vault-ingest-audit   3 个未跟踪文件，但 1 小时内没有成功入库记录
```

这条 WARN 只在"有人绕过入库进程直接往 vault 写文件"时才该变红。
干净重建后它一直是 WARN 的话，说明备份里带了未入库的散文件——那本身值得看一眼。

**`time-sync` 必须 PASS**（`W32Time` 在跑）。它查的是时钟有没有自动校准：
不校准会让 `patch-guard` 的 ±15 秒窗口和提醒的 `due_at` 一起出错（`VERIFY §15`）。
这台机器就踩过——`W32Time` 从装好起一直是 Stopped，而那时 doctor 只有 `timezone` 一项（只查时区名）。

再人工做一次：登记 2 分钟后到点的任务 → 到点收到 @ 提醒。

## 6. 已知缺口

- 密钥没有离机副本时，只能重新生成 webhook（群机器人设置里换一个新的）；
- 主机名/共享名变了，员工机上的 `\\主机\anc-vault-shared` 路径要跟着改（重渲染接入包）；
- `_originals/` 没随备份走的话，入库文档会失去原件，只能重新收集。

## 7. 重建演练与基线（2026-11-02）

没有第二台干净机，所以用一个**空目录**演练：按 §1、§3 建目录 + 部署，再用 `doctor -Root <演练根> -VaultRoot <vault 根>` 验证结构。
它不能替代真机（§2 数据恢复、§4 bot 登录没法自动化），但能回答两件事——结构 doctor 认不认、每步多久。

```powershell
powershell -File scripts\rebuild\rebuild-drill.ps1            # 默认用临时空目录，跑完自清理
powershell -File scripts\rebuild\rebuild-drill.ps1 -Keep      # 保留演练根，便于手工看
```

**基线（本机 2026-11-02 实测）**：

| 步骤 | 耗时 |
|---|---|
| 建目录结构 | 0.1 s |
| 部署运行件（deploy -Apply，66 文件逐字节校验） | 3.8 s |
| doctor 校验结构 | 17.5 s |
| **合计** | **21.4 s**（2026-11-04 复测 21.3 s / 66 文件，耗时未变） |

`deploy-layout: PASS`。重建耗时以这个数为基线：明显变慢说明映射变多或校验变重，要回头看是否值得。

每次演练追加一行到 `_research/rebuild-baseline.log`（不在 git 里），便于对比。

> 演练本身也抓过一次问题：脚本里用 scriptblock 执行步骤，赋值落在局部作用域，
> 外层读到的永远是初值——表现是"部署明明成功却报未取到"。这类问题只有真跑一遍才暴露。
