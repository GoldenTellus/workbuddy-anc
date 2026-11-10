# 主机运维

> 类型：运维手册（主机运维）

对应 [PLAN.md](./PLAN.md) 阶段 D（运行身份迁移已按 D25 关闭）与 [DECISIONS.md](./DECISIONS.md) §5.1/§5.10。

## 计划任务

共 14 个，全部 `MultipleInstances = IgnoreNew`（上一次没跑完，新触发直接丢弃，不叠跑）。`<bin>` = `%ProgramData%\anc\bin`，`<svc>` = `%ProgramData%\anc\service`。

| 任务 | 触发 | 身份 | 执行 | 作用 |
|---|---|---|---|---|
| `anc-service` | 开机 + 每天 00:00 起每 1 分钟 | `LOCAL SERVICE` | `cmd /c <bin>\anc-loop.cmd` | 跑 `loop --once`：到期提醒 → outbox → 群机器人 |
| `anc-elevate` | 开机 + 每分钟 | `SYSTEM` | `elevate-runner.ps1 -Root <Root> -Repo <仓库>` | **给 bot 的提权通道**：从 `data\elevate\queue\` 取一条白名单请求（`upgrade` / `register-tasks` / `deploy`）以 SYSTEM 执行，结果写 `done\`、审计写 `elevate.log`。**不接受任意命令**：脚本路径固定从 `tools\` 取，请求里的路径字段一概忽略；请求文件必须是 `<GUID>.json`、不能是链接；TTL 30 分钟、每小时最多 6 条；投递端 `bin\request-elevate.ps1`；白名单仅 upgrade / register-tasks / deploy，GUID 文件名、TTL 30 分钟、每小时最多 6 条 |
| `anc-executor-new-host` | 每天 03:00 | `LOCAL SERVICE` | `new-host.ps1` | 主干2 自动创建新 host 对话；失败由 `anc-executor-host-tick` 标 deferred，旧 host 继续接单 |
|  |  |  |  | > 演练/补测：`new-host.ps1 -Now "2026-11-11T03:00:05+08:00"` 可模拟指定时刻的 03:00（只影响 date/cut-at/title，**不改系统时钟**）；仅用于 ACC-20 这类补测 |
| `anc-executor-host-tick` | 每天 03:00 | `LOCAL SERVICE` | `host-tick.ps1` | 主干2 自动兜底：没有新 host 时只标 `cut_deferred`，旧 host 继续接单（**文件名是 `host-tick.ps1`**：GAP-093 之前写 `executor-host-tick.ps1`，而部署目录里从来没有这个文件，任务一直启动失败） |
| `anc-executor-wake` | 每分钟 | `LOCAL SERVICE` | `wake-if-queued.ps1` | 先跑 `executor expire` + `executor attention sweep --apply`（2h/8h/24h 提醒/升级，不依赖 bridge）；有 queued Ticket 时读 active host：`conversation_id` 是真实 UUID → `/wake` **定向现有 daily host**（D46）；只有旧占位 id 才回退 `/new`；无队列或 bridge 未启用时静默；每次动作写 `executor-wake.log` |
| `anc-backup` | 每天 02:00 起每 1 小时（幂等：距上次成功不足 20h 跳过） | `LOCAL SERVICE` | `backup-anc.ps1 -Destination <第二块盘>` | `VACUUM INTO` 快照 + 完整性校验，保留 14 份并复制到第二块盘；错过 02:00 会自动补 |
| `anc-boot-alert` | 开机后每 10 分钟（持续 2 小时） | `LOCAL SERVICE` | `boot-alert.ps1` | WorkBuddy 没起来就经运维群 webhook 告警 |
| `anc-cleanup` | 每天 03:00 | `SYSTEM` | `cleanup-media.ps1 -MediaDir <bot 用户的 TEMP>\workbuddy-wecom-media -Days 7` | 清企微附件落地目录里超过 7 天的文件（要访问 bot 用户的 TEMP，故用 SYSTEM）；遇到 junction / 符号链接一律跳过。**`-MediaDir` 写死了 bot 用户，换运行身份时要同步改** |
| `anc-watchdog` | 每天 00:00 起每 10 分钟 | `LOCAL SERVICE` | `watchdog.ps1` | 心跳 >10 分钟、outbox 积压 ≥50、WorkBuddy 不在跑 → 运维群告警（同类问题 30 分钟冷却） |
| `anc-workbuddy-launch` | 登录后 30 秒 | bot 用户（Interactive） | `wscript //B <bin>\run-hidden.vbs <bin>\anc-launch.cmd` | 用补丁启动器拉起 WorkBuddy，杜绝「登录自动起了无补丁实例」 |
| `anc-patch-guard` | 登录后 10 秒 + 每天 00:00 起每 1 分钟 | bot 用户（Interactive） | `wscript //B <bin>\run-hidden.vbs <bin>\anc-guard.cmd` | 读 `patch-state.json`；只认补丁体包装成功后写的 `applied=true`，否则触发自愈重启（10 分钟冷却；重启中、重启失败、锚点缺失时 60 分钟内不再触发） |
| `anc-update-watch` | 每天 09:00 | `LOCAL SERVICE` | `check-workbuddy-update.ps1` | 请求厂商更新接口：有新版本就发运维群（只有告警发出去了才记为已见），提示按 skill 走回归 |
| `anc-http` | 开机 + 每分钟（常驻，已跑不叠跑） | `LOCAL SERVICE` | `cmd /c <bin>\anc-http.cmd` | 只监听 `127.0.0.1:17891`：`/__anc_health` 存活探测（不需 token）、`/__anc_status` 需 Bearer token |
| `anc-devbot` | 工作日 22:00~06:00 每 30 分钟 | bot 用户（Interactive） | `devbot-scheduler.ps1` | 查「全员下班」，满足三个条件才触发夜间迭代闭环；与另两个交互类任务同一 principal |

PowerShell 任务统一是 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <bin>\<脚本>`。两个 `.cmd`（`anc-guard.cmd`、`anc-launch.cmd`）与 `anc-loop.cmd` 的应有内容在仓库 `scripts/` 下，部署时以它们覆盖主机上的同名文件；`.cmd` 只写 ASCII（cmd.exe 按 OEM 代码页读）。注册用 `scripts\deploy\register-tasks.ps1`（默认 dry-run，`-Apply` 才写；三个交互类任务要求 bot 用户已登录过、没有用户配置目录时会拒绝注册）：`-BotUser`、`-BackupDestination`、`-CleanupMediaDir` 都可覆盖。

> **两个容易踩的注册偏差（2026-11-09 实测）**：
> - **`-BotUser` 默认取「当前部署账号」（`$env:USERNAME`，D25）**，不再硬编码 `anc-bot` / `Administrator`；
>   本机实测 `BotUser=DNT`。早先默认值与 D25 矛盾（照默认值跑会要求一个不存在/没登录过的用户配置目录），
>   换账号部署时才需要显式传。
> - **从部署目录 `%ProgramData%\anc\tools\` 跑必须显式传 `-Repo <仓库根>`**：脚本按「向上找 `.git`」探测仓库根，
>   部署目录里找不到，`anc-devbot` 的动作会指不到 `scripts\devbot\devbot-scheduler.ps1`；
>   本机实测要传 `-Repo D:\workbuddy-anc`。仓库里直接跑可自动探测。

### 部署（一条命令）

```powershell
# 先看计划（默认 dry-run）
powershell -File scripts\deploy\deploy.ps1
# 落盘：备份 → 复制 → 逐文件对拍 hash → 失败回滚
powershell -File scripts\deploy\deploy.ps1 -Apply
```

把 `src\core`、`src\interfaces`、`src\modules`、`src\service`、`src\ingest`、`src\render`、`src\shared`、`light\templates`、`scripts\<domain>\*`（按 `$BinScripts` / `$ToolScripts` 分别扁平到 `bin\`（运行时 21）与 `tools\`（装机维护 26））和 `scripts\workbuddy-patch\*` 复制到 `%ProgramData%\anc\` 对应目录，排除 `*.test.ts`。落盘前备份到 `%ProgramData%\anc\backup\deploy-<时间>\`，落盘后逐文件比对 SHA-256，不一致就整体回滚。备份目录目前不自动清理，按需删旧的。

## 部署后自动 executor（主干 2，2026-11-10）

公司侧 `install-company -Apply` 装完 `patch` 重启后，不需要人手动加 WorkBuddy 工作区：

1. install-company 的 `executor` 阶段写 `data\wb-wake.flag`、`data\wb-wake-workspace.txt`（默认=仓库绝对路径），并写 `data\deploy-executor-pending.json`。
2. `patch` 重启 WorkBuddy；`anc-patch-guard` 每分钟检查，补丁 `applied=true` 且 marker 在 → 调 `tools\setup-executor.ps1 -Apply -Marker`。
3. 该脚本用 wake bridge `/new` 在工作区建会话并发 `TEST`，bot 回「收到，TEST 正常」（这一动作同时让 WorkBuddy **自动注册工作区**），然后没有 active host 时注册当天 host。
4. 结果：`data\executor-deploy.json`（`ok:true` + workspace/conversation_id/test_reply/host）；成功删 marker，失败留 marker 自动重试（最多 20 次，然后 `data\deploy-executor-failed.json`）。

排查/手动重跑：

```powershell
Get-Content (Join-Path $env:ProgramData 'anc\data\executor-deploy.json') -Raw
Get-Content (Join-Path $env:ProgramData 'anc\data\executor-deploy.log') -Tail 20
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:ProgramData\anc\tools\setup-executor.ps1" -Apply
```

- 不启用：install-company 加 `-SkipExecutor`，或 answers `executor.enabled=否`；不建 `wb-wake.flag` 时 new-host/wake 静默跳过。
- 换工作区：`-ExecutorWorkspace D:\anc\executor-ws`（绝对路径；目录不存在会建）。

## 账号与凭据

- `%ProgramData%\anc\accounts` **只给 Administrators 与 SYSTEM**：里面有 `anc-bot` 密码和按名单开出的只读账号初始密码，bot 账号（标准用户）不得读取；
- 员工账号用 `scripts\accounts\provision-vault-accounts.ps1 -Csv <名单> -DryRun` 先看计划，再正式执行；CSV 用 UTF-8 写；
- 凭据文件发给本人后删除，不进仓库、不进聊天。

### 初始化 org（渲染器的输入）

`D:\anc\org` 还不存在时，渲染、`groups.json`、离职流程都没法跑。最小初始化：

```powershell
New-Item -ItemType Directory 'D:\anc\org\members','D:\anc\org\roles','D:\anc\org\depts','D:\anc\build' -Force
# company.md 的必填字段：name / company_bot_name / vault_shared / vault_internal / local_workdir / boss
# 群配置：company_group_chat_id/company_group_webhook_file / boss_dm_chat_id/boss_dm_webhook_file
# 部门群：org\depts\<id>.md 的 chat_id / webhook_file
# 成员放 org\members\<id>.md，渲染时按 id 出 members\<id>\CODEBUDDY.md
node C:\ProgramData\anc\render\cli.ts deploy --org D:\anc\org --out D:\anc\build --db C:\ProgramData\anc\data\anc.db --json
```

- `vault_shared` 在公司 bot 上填本机路径（`D:\anc\vault-shared`），**不要填 UNC**：UNC 里带主机名，persona 会把它写进对话；
- 渲染是整组事务：失败会整体还原（`deployOrg`），不会留半套产物；
- `groups.json` 是 `bind sync-org` / `bind import` 的输入；停用成员不会出现在里面。
### 共享账号（vault 只读）

```powershell
# 1) 准备名单 CSV（name,id）  2) 看计划
powershell -File scripts\accounts\provision-vault-accounts.ps1 -Csv .\team.csv -DryRun
# 3) 建号：同时授 vault 只读、把组加进「拒绝本地登录」
powershell -File scripts\accounts\provision-vault-accounts.ps1 -Csv .\team.csv
# 4) 验收（读通 / 写拒 / 非管理员 / 拒绝登录），出 JSON 报告
powershell -File scripts\accounts\verify-vault-accounts.ps1 -Csv C:\ProgramData\anc\accounts\provisioned-<时间>.csv
# 5) 凭据发给本人后，删掉那份 provisioned CSV
```

- 组 `anc-vault-readers` 对共享区只有 `RX`；写权限一律不给；
- 「拒绝本地登录」写进 `SeDenyInteractiveLogonRight`（安全策略没有 cmdlet，走 `secedit` 导出→改→导入）。Deny 优先于 Users 的 Allow，组员登不进桌面；
- 验收报告落在 `%ProgramData%\anc\accounts\verify-<时间>.json`，是上线证据（C8 的 DoD 要它）；
- 读/写实测用 `Start-Process -Credential`，依赖 Secondary Logon 服务；服务没开时报告里会写「无法以该身份执行」，那时改用计划任务方式跑探针。
- **收紧 `secrets` 必须是三步**（只做 `/inheritance:r` + `/grant` 不会移除 `BUILTIN\Users`，它会作为显式 ACE 留下）：
  ```powershell
  icacls C:\ProgramData\anc\secrets /inheritance:r
  icacls C:\ProgramData\anc\secrets /remove:g "BUILTIN\Users" "Everyone" "Authenticated Users" /T
  icacls C:\ProgramData\anc\secrets /grant:r "NT AUTHORITY\SYSTEM:(OI)(CI)F" "BUILTIN\Administrators:(OI)(CI)F" "NT AUTHORITY\LOCAL SERVICE:(OI)(CI)RX" "<bot用户>:(OI)(CI)RX" /T
  ```
  改完跑 `doctor`，`secrets-acl` 必须转 PASS；再在群里发一条消息确认提醒仍能发出。

## 维护窗口（升级/排障）

停 WorkBuddy 之前先放维护开关，否则 `anc-patch-guard` 会在一分钟内把它重新拉起：

```powershell
"upgrade 2026-11-01" | Set-Content C:\ProgramData\anc\data\maintenance.flag -Encoding utf8
# 维护完成
Remove-Item C:\ProgramData\anc\data\maintenance.flag
```

维护结束后 guard 会在一分钟内自动拉起（自带 10 分钟节流，失败会告警）。

## 为什么不再弹窗

以登录用户身份运行的任务（`anc-patch-guard`、`anc-workbuddy-launch`）如果直接调 `powershell.exe`，每次触发都会闪一个控制台窗口（守卫每分钟一次）。现在统一用 `scripts/launch/run-hidden.vbs` 包一层：

```
wscript.exe //B //Nologo run-hidden.vbs "<某个 .cmd>"
```

`.cmd` 里再 `powershell -WindowStyle Hidden -File ...`。自愈的 Worker 与重启也都经 `.vbs` 由 Explorer 拉起，全程无窗口。改动后实测：手动触发守卫与自愈，均无可见窗口。

**风险要认：** 管理员模式下，任何能影响 bot 的输入（群消息、被引用的文件、网页内容）都可能变成管理员命令。只在排障窗口用，不要长期挂着。

---

## 补丁的唯一来源

线上只从 `%ProgramData%\anc\patch\` 跑补丁（`launch-patched.ps1` / `preload.cjs` / `inspect.mjs` / `manifest.json`）；守卫与自愈默认 `-PatchDir` 也指向这里。**不从 git 工作副本跑**：在仓库里切分支会直接改到线上补丁，两份 manifest 也会漂移。部署补丁 = 把 `scripts\workbuddy-patch\*` 复制到 `%ProgramData%\anc\patch\`。

登录拉起（`anc-launch.cmd`）、守卫与自愈三条启动路径必须用同一份补丁：`anc-launch.cmd` 一律以仓库 `scripts/launch/anc-launch.cmd` 为准，指向 `%ProgramData%\anc\patch\launch-patched.ps1`。入库技能调用的入库 CLI 同理，应从部署目录跑，不从工作副本跑。

公司 bot 看到消息没有 `[anc:chat=…]` 前缀时**不再自己跑自愈**，只回「身份识别暂不可用」；修复完全交给守卫。任何群成员都能发消息，交给 bot 触发等于让人随意重启 WorkBuddy。

## WorkBuddy 装在非标准路径（Junction）

WorkBuddy 可以装在非标准位置。本机实测装在 `D:\App\WorkBuddy`，用 **Junction** 在标准位置指过去；
补丁启动器、`doctor`、`anc-update-watch` 都按标准位置或 `workbuddy-path.txt` 定位。

```powershell
# 建 Junction（标准位置 → 实际安装目录）
New-Item -ItemType Junction -Path "$env:LOCALAPPDATA\Programs\WorkBuddy" -Target 'D:\App\WorkBuddy'

# 回滚 = 删 Junction（只删链接，不动 D:\App\WorkBuddy 本体）
Remove-Item "$env:LOCALAPPDATA\Programs\WorkBuddy"
```

- **Junction 是机器相关状态**：重装 WorkBuddy、换机器、还原系统后要重建；git 和备份里都没有它。
- **`doctor` 的 `workbuddy` 检查**：先读 `%ProgramData%\anc\data\workbuddy-path.txt`（补丁 `preload.cjs`
  启动时写入实际 `process.execPath`，LOCAL SERVICE 也能定位），读不到或文件不存在再回落
  `%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe`：
  - 两处都找不到 exe → `WARN 找不到 WorkBuddy.exe`（不是 FAIL，常见于还没装或换路径后没重启补丁）；
  - 找到但版本 ≠ `%ProgramData%\anc\patch\manifest.json` 的 `workbuddyVersion` → `FAIL`（按 `WORKBUDDY-PATCH.md` 重放补丁并更新 manifest）；
  - 本机实测 `PASS 版本 5.9.3`（`workbuddy-path.txt` 指向标准位置，经 Junction 落到 `D:\App\WorkBuddy`）。
- **排障顺序**：`Get-Item "$env:LOCALAPPDATA\Programs\WorkBuddy" | Select-Object LinkType,Target` 看 Junction 在不在 →
  看 `workbuddy-path.txt` 内容 → 再跑 `doctor -Repo <仓库根> -Json`。

## 体检与告警

```powershell
powershell -File scripts\doctor\doctor.ps1              # 只读体检（35 项）：部署账号（D25 用管理员账号）、进程 owner、14 个任务与 principal、心跳、版本、补丁、SMB/NTFS、secrets ACL、部署布局、密钥、时区、数据库、绑定、canary

> 非提权会话通常看不到 `LOCAL SERVICE` / `SYSTEM` 的任务，doctor 会把它们报 `WARN 非提权会话看不到服务任务`，不是 FAIL。核对 14 个任务请用**管理员会话**；`FAIL=0` 在两种会话下都成立。
powershell -File scripts\doctor\doctor.ps1 -SelfTest    # 自测：用 %TEMP% 夹具证明每类检查会 FAIL，不碰生产
powershell -File scripts\doctor\doctor.ps1 -BotUser X   # 换专用用户名（默认当前登录账号）
powershell -File scripts\selfheal\watchdog.ps1            # 手动跑一次看有没有要告警的
```

doctor 退出码：0 无 FAIL，1 有 FAIL，并在末尾列出 `FIX`。全 PASS 是上线门槛之一。


## vault 共享

| 项 | 值 |
|---|---|
| 共享名 | `anc-vault-shared` → `D:\anc\vault-shared` |
| 共享层权限 | `Authenticated Users` 只读、`Administrators` 完全控制 |
| NTFS（共享区） | `BUILTIN\Users` 只读；`Administrators` / `SYSTEM` 完全控制；已断开继承，去掉继承来的 `Authenticated Users: Modify` |
| NTFS（内部区） | 只有 `Administrators` / `SYSTEM` + 当前运行用户；`BUILTIN\Users` 与 `Authenticated Users` 已移除 |

> 员工共享账号还没建：按 FORK §5.4，每人一个「只用于读共享、不能登录桌面」的本地账号，等员工名单确定后补。

### 按名单开账号

```powershell
# 名单 CSV（name,id；id 只允许小写字母数字 . _ -）
#   张三,zhangsan
powershell -ExecutionPolicy Bypass -File scripts\accounts\provision-vault-accounts.ps1 -Csv .\team.csv -DryRun
powershell -ExecutionPolicy Bypass -File scripts\accounts\provision-vault-accounts.ps1 -Csv .\team.csv
```

- 账号名 `anc-read-<id>`，随机 12 位密码、永不过期，默认只在 `Users` 组；
- 凭据写到 `%ProgramData%\anc\accounts\provisioned-<时间>.csv`：**发给本人后删除**，不进仓库；
- 幂等：已存在的账号跳过、不改密码；
- 实测（2026-10-31）：脚本创建的账号可读共享、写入被拒，用完即删；
- 「拒绝本地登录」需在本地安全策略里对 `anc-vault-readers` 组设置，脚本不代做，避免把自己锁在外面。

脚本落在 `%ProgramData%\anc\bin\`（只读），数据在 `%ProgramData%\anc\data\`，密钥在 `%ProgramData%\anc\secrets\`。

## 备份

```powershell
# 手动跑一次（本地）
powershell -ExecutionPolicy Bypass -File scripts\backup\backup-anc.ps1

# 带离机目标（UNC 或 U 盘）；目标不可达只告警，不算备份失败
powershell -ExecutionPolicy Bypass -File scripts\backup\backup-anc.ps1 -Destination "\\主机\backup\anc"
```

- 备份是 SQLite `VACUUM INTO` 的一致性快照，服务在跑也能做；
- 恢复：停 `anc-service` → 用备份文件覆盖 `anc.db`（同时删掉 `-wal`/`-shm`）→ 启动任务；
- **离机目标要填上才算真正离机**：注册任务时用 `-BackupDestination <独立盘或 UNC>` 指定（脚本会把它写成任务参数 `-Destination`；本机实测注册为 `D:\anc-backup`）。目标不可达只告警，不算备份失败。
- **同一块物理盘不算离机**：脚本会比对两边的 `DiskNumber`，同盘就发运维告警（同一块盘只报一次，状态记在 `%ProgramData%\anc\data\backup.state.json`）。本机 2026-11-09 实测：离机目标 `D:\anc-backup` 与本地备份同在 Disk 0 —— 会发 WARN、离机复制照常，但等于没有离机保护；要接独立物理盘或 UNC。
- **部署/迁移后必须强制备份（D49 / GAP-089）**：默认 20h 间隔会跳过“刚迁移完还没到点”的情况，导致最新备份是迁移前 schema（实测缺 `attentions`）。规则：每次 deploy 或 DB 迁移收口后跑一次 `backup-anc.ps1 -MinIntervalHours 0 -Destination <离机目标>`，并做一次副本恢复演练。
- **doctor 现在校验备份 schema**：`backup-freshness` 除了看时间，还用 `node:sqlite` 只读打开最新备份，比对 live 库表清单；备份缺表（早于迁移）直接 FAIL。负例：把迁移前备份放成最新 → `FAIL 最新备份缺 live 表: attentions`（2026-11-10 实测）。
- 保留策略：本地 `-Keep 14` 份（每天一份约两周）；离机 `-OffsiteKeep 60` + 每月 1 号那份留 `-OffsiteMonthlyKeep 12`（月档不会被日保留挤掉）。
- 失败一定告警：`cli` 退出码非 0、文件为空/没生成、离机复制失败都会发 `ops-webhook.txt`；`doctor` 的 `backup-freshness` 在最近备份超过 30 小时或缺表时 FAIL。

## 离职（一个人走掉时）

前置：`D:\anc\org` 要先存在（渲染器的输入）。当前主机还没建这个目录，所以在建好之前只能做「任务转交 + 解绑」两步。

```powershell
# 1) 手工在 org/members/<id>.md 的 frontmatter 加 disabled: true（脚本不改 org）
# 2) 看计划（默认 dry-run）
powershell -File scripts\accounts\offboard-member.ps1 -MemberId zhangsan -ToUserid <新人 userid> -ToName 王五
# 3) 真做
powershell -File scripts\accounts\offboard-member.ps1 -MemberId zhangsan -ToUserid <新人 userid> -ToName 王五 -Apply
# 4) 连 Windows 账号一起删（不可逆，默认不做）
powershell -File scripts\accounts\offboard-member.ps1 ... -Apply -DeleteAccount -AccountName <账号名>
```

- 做四件事：重渲染（清掉该成员 persona、从 `groups.json` 移除）、把 open 任务转给新人（记 `reassigned` 事件）、解绑员工群、可选删账号；
- **不删数据**：vault 里的档案与入库记录原样保留（D21 复核保留，离职也一样）；
- `disabled` 只认字符串 `true`：写 `1` / `yes` 不生效，渲染时会当成在职；
- 停用后 `groups.json` 里不再出现这个人，`bind sync-org` 不会给他重建绑定；groups 表停用目前要手工 `bind group-set --status disabled`。

## 开机提醒

`anc-boot-alert` 在开机后等 60 秒，检查 `WorkBuddy.exe` 是否在跑；不在就向 `%ProgramData%\anc\secrets\ops-webhook.txt` 发一条「公司 bot 离线，请登录恢复」，之后每 10 分钟重复，2 小时后停（避免无限刷屏）。

## 自动升级

补丁启动器在网络层拦掉 `/v2/update`，并会在版本/hash 不符时向运维群告警，见 [WORKBUDDY-PATCH.md](./WORKBUDDY-PATCH.md)。

## 运行身份（D25，2026-11-02）

本部署约定**直接用管理员账号**跑 bot 与两个 Interactive 计划任务，不建专用标准用户。

`doctor` 的 `dedicated-user` / `bot-process-owner` / `task-anc-*` 之间的一致性检查仍然保留，
但期望值改为「当前部署账号」（`-BotUser` 可覆盖），管理员组不再算 FAIL——实际身份仍会打出来，
便于发现意外变更（例如被换成 `SYSTEM` 或别的账号）。

**代价（知情接受）**：WorkBuddy 及其 `preload.cjs` 补丁在这个账号下拿到管理员权限，
它或它加载的任何东西出问题，损失是整台主机。D6 的另外两条仍然有效：不开自动登录、本机不存密码。

要收紧到专用标准用户时的做法：

1. 建一个标准用户（不进管理员组）；
2. 把 `anc-workbuddy-launch` 与 `anc-patch-guard` 的 principal 改成该用户 + Interactive；
3. 在该用户下装 WorkBuddy、扫码登录、`launch-patched.ps1` 起补丁、装技能；
4. `doctor -BotUser <该用户>` 复核 —— 此时 `dedicated-user` 会报「标准用户」，其余项期望值同步。

## 常用命令

```powershell
# 看任务状态
Get-ScheduledTask -TaskName 'anc-*' | Select-Object TaskName, State
Get-ScheduledTaskInfo -TaskName 'anc-service' | Select-Object LastRunTime, LastTaskResult, NextRunTime

# 看服务日志
Get-Content C:\ProgramData\anc\data\loop.log -Tail 20
# 日志超过 5 MB 由 anc-loop.cmd 轮转为 loop.log.1（只留一份）；该命令带 --no-warnings，屏蔽 sqlite 实验特性告警
# loop.log 末尾就是每次 tick 的 JSON（enqueued/sent/failed/skipped/requeued）；failed>0 时看 outbox 的 last_error

# 看备份日志
Get-Content C:\ProgramData\anc\data\backup.log -Tail 20
```
## 主机时间必须自动同步（2026-11-04 发现并修复）

这台机器上 `W32Time` 服务原本是 **Stopped**、启动类型 Manual，`w32tm /query /status` 直接报 `0x80070426`（服务未启动）。也就是说时间从装好起就没同步过。

为什么这是必修项：`patch-guard` 用 `patch-state.at >= 主进程创建时间 - 15 秒` 判断"补丁是这次的还是上次的残留"（`VERIFY §16` 那个坑）。这个判断依赖时钟，漂到分钟级就会把残留判成有效，或者把有效判成残留。

```powershell
Set-Service W32Time -StartupType Automatic
Start-Service W32Time
w32tm /config /manualpeerlist:"ntp.aliyun.com,time.windows.com" /syncfromflags:manual /reliable:yes /update
w32tm /resync /force
w32tm /query /status      # 看"上次成功同步时间"和"来源"
```

`doctor` 目前不查这一项。判断办法：`Get-Service W32Time` 应该是 Running + Automatic，`w32tm /query /status` 的"来源"不应为空。

顺带一个教训：`new Date().toISOString()` 写进 `patch-canary.json` / `patch-state.json` 的时间戳是**系统时间**。系统时间错了，日志时间就全错，排障时会拿着错的时间轴去对事件。核对时间戳前先确认机器时间准不准。
### 历史时间戳的处理口径

2026-11-04 03:00 之前写入的绝对时间戳（数据库 `created_at` / `due_at`、日志、状态文件）**可能偏过，视为不可信**。

影响面盘点见 `VERIFY §19`。结论是：靠相对时间算的（冷启动耗时、各冷却间隔）不受影响；补丁机制的窗口比对因为同一台机器同时偏而互相抵消；**真正受影响的只有提醒与逾期判断**，而那条链还没做端到端验证，库里相关行都是联调数据。

**不回头修历史数据**——不知道原来偏了多少，没有基准；改了反而破坏审计链。将来验证提醒时用**新造的数据**，不要拿旧行做依据。

## 程序化测试入口：模拟"有人 @ 了 bot"（2026-11-04）

> **`test-emit.flag` 的语义是"下次启动时要不要开口"，不是"现在开不开"**（2026-11-04 实测确认）。
>
> `preload.cjs` 里是 `if (fs.existsSync(TEST_FLAG)) { 启动 HTTP 服务 }`——**只在启动时读一次**。
> 所以：
> - **删掉 flag 不会让已经在跑的口子停**，要重启 WorkBuddy 才关得上；
> - 加 flag 也一样，要重启才开。
>
> 别按"删了就关了"去理解——会以为关成功了，实际还开着。

### 它解决什么

验证 persona、技能、出站行为，本质都要**让 bot 收到一条消息**。原来只能请人在企微群里手动 @ 一次——每轮实验都要人等，而且重启后要再等一次。

这个入口让你用一条 HTTP 请求代替那次人工操作。

### 怎么开

```powershell
# 开（之后重启 WorkBuddy 才生效）
Set-Content 'C:\ProgramData\anc\data\test-emit.flag' -Value 'enabled' -Encoding UTF8
# 关（删掉 flag 并重启，或等下次重启自然失效）
Remove-Item 'C:\ProgramData\anc\data\test-emit.flag'
```

**默认是关的**（flag 不存在就不监听）。代码在 `scripts/workbuddy-patch/preload.cjs`。

### 怎么用

```powershell
$chatId = '<员工群 chatId；四类群用 groups 表或 bind group-list 查>'
$msgId  = -join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })  # 32 位 hex，缺了会出 undefined
$body = @{
  chatId  = $chatId
  user    = 'test-emit'
  msgId   = $msgId
  content = '第二阶段的码是多少'
} | ConvertTo-Json

Invoke-RestMethod -Uri 'http://127.0.0.1:17999/emit' -Method POST `
  -ContentType 'application/json; charset=utf-8' `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
# 若下面启用了 emit-token.txt，再加一行：
#   -Headers @{ 'X-Anc-Token' = (Get-Content 'C:\ProgramData\anc\data\emit-token.txt' -Raw -Encoding UTF8).Trim() }
```

返回 `{"ok":true,"chatId":"...","len":N}`。`len` 是**加上身份前缀之后**的长度（`[anc:chat=… from=…]`），比原始内容长十几到几十字符是正常的。

### 怎么知道 bot 真处理了

**三个地方看，按可靠程度排序**：

| 看什么 | 在哪 | 说明 |
|---|---|---|
| **bot 的回复** | `%ProgramData%\anc\data\patch-out.log` | 最硬的证据。行数增加 = bot 真的回了，后面跟 `len=` 和正文 |
| **消息被接收** | `%ProgramData%\anc\data\patch-canary.json` | `at` 更新 = `emitMessage` 被调用。**但没有正文**，只能证明"收到了" |
| 出站过滤观测 | `%USERPROFILE%\anc\narration-filter.log` | 只在 `sendReply` 被调用时写（企微不走那条路，见 `VERIFY §17`） |

WorkBuddy 自己的日志 `%USERPROFILE%\.workbuddy\logs\workbuddyMainThread*.log` 里搜 `test-emit`，能看到完整的 `Conversation lookup`（含 `cwd` 和 `existingAgentSessionId`）——**查 persona 相关问题时这个最有用**。

### 三个前提

**1. 重启后要等一会儿**

实例引用是"bot 调用某个原型方法时"才抓到的。实测重启后 **8–30 秒**就有。拿不到会返回：

```json
{"ok":false,"error":"还没有实例引用：先让 bot 收到一条真实消息"}
```

轮询几次（每次隔 8 秒）通常第 2–3 次就成功。

**2. 不能伪造"真 @ 到机器人"**

`emitMessage` 收到的是消息对象，`content` 里写 `@某bot` 只是文本。bot 是否会回，取决于它自己怎么判断（persona 里写的是"@ 才回应"）。

实测用 `ping` 这种内容 bot 也会处理并回复——说明**在这个入口下它不检查 @ 标记**。这既是方便（不用伪造 @），也是**失真**（行为和真实群消息不完全一样）。**做"bot 会不会回应"这类判断时不能只靠这个入口。**

**3. 只开在 127.0.0.1**

代码里 `__srv.listen(17999, '127.0.0.1', ...)`，body 上限 1 MB。**2026-11-06 起支持可选鉴权**：同目录（`%ProgramData%\anc\data\`）放 `emit-token.txt`，`/emit` 就要求 `X-Anc-Token` 且用常量时间比对；**不放文件则维持「能连本机就能发」的旧行为**，`deploy-verify.ps1` 会自动带上 token。默认仍无认证，所以 flag 用完就删，别长期开着；要防本机伪造就建 token 文件。**隔离验证**：给 WorkBuddy 进程设 `ANC_EMIT_PORT=<其它端口>` 可起独立 test-emit，避免把测试消息注进在跑部署的 17999（`VERIFY §86.4` 踩过）。

### 走过的弯路（免得重走）

| 尝试 | 为什么不行 |
|---|---|
| 企微群机器人 webhook 发消息 | bot 作为**应用**根本收不到群机器人发的消息（试过带 @、不带 @，`canary` 都不动） |
| webhook 的 `mentioned_list` | 不知道 bot 的 userid；`settings.json` 里 86 个 `wr…` 全是 chatId，只有一个 `wokc…` 是员工 userid |
| Windows UIA 操作企微界面 | 企微是 **Flutter**，UIA 只能到 `FLUTTERVIEW` 这一层，读不到输入框 |
| UIA + 截图定位 | `SetFocus()` 报"目标元素无法接收焦点"；截图截到的是别的窗口 |
| 连 inspector（`--inspect-brk=9229`） | `inject.cjs` 注入完就关掉了，端口不在 |
| 只包装 `emitMessage` | 只有"收到消息"时才抓得到实例 → 重启后仍要等人 |
| 只包装 `connect` / `onMessage` / `sendStreamChunk` | **没用**，重启后仍拿不到 |
| **包装原型上所有方法** | ✓ 有效。bot 启动后调用任何一个方法就把 `this` 存下来 |

### 相关的两个约束（不是这个入口的问题，但做实验会撞到）

**persona 是每会话首次注入时读一次**（`VERIFY §18`）。所以：
- 同一个会话里改了 `CODEBUDDY.md`，bot 看不到
- 用测试入口发消息**会新建会话**，能读到最新版本；而群里已有的老会话不会
- 做完 persona 实验要恢复文件，否则下次会话会读到实验内容

**出站过滤在企微这条路上不工作**（`VERIFY §17`）。企微走 `sendStreamChunk` 流式，`preload` 包装的是 `sendReply`（那是 QQ bot 的）。要约束输出只能改 persona。
