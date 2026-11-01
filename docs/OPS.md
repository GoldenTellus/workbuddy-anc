# 主机运维

对应 [PLAN.md](./PLAN.md) 阶段 R（R1 运行身份迁移）与 [FORK-DIRECTION.md](./FORK-DIRECTION.md) §5.1/§5.10。

## 计划任务

共 8 个，全部 `MultipleInstances = IgnoreNew`（上一次没跑完，新触发直接丢弃，不叠跑）。`<bin>` = `%ProgramData%\anc\bin`，`<svc>` = `%ProgramData%\anc\service`。

| 任务 | 触发 | 身份 | 执行 | 作用 |
|---|---|---|---|---|
| `anc-service` | 开机 + 每天 00:00 起每 1 分钟 | `LOCAL SERVICE` | `cmd /c <bin>\anc-loop.cmd` | 跑 `loop --once`：到期提醒 → outbox → 群机器人 |
| `anc-backup` | 每天 02:00 起每 1 小时（幂等：距上次成功不足 20h 跳过） | `LOCAL SERVICE` | `backup-anc.ps1 -Destination <第二块盘>` | `VACUUM INTO` 快照 + 完整性校验，保留 14 份并复制到第二块盘；错过 02:00 会自动补 |
| `anc-boot-alert` | 开机后每 10 分钟（持续 2 小时） | `LOCAL SERVICE` | `boot-alert.ps1` | WorkBuddy 没起来就经运维群 webhook 告警 |
| `anc-cleanup` | 每天 03:00 | `SYSTEM` | `cleanup-media.ps1 -MediaDir <bot 用户的 TEMP>\workbuddy-wecom-media -Days 7` | 清企微附件落地目录里超过 7 天的文件（要访问 bot 用户的 TEMP，故用 SYSTEM）；遇到 junction / 符号链接一律跳过。**`-MediaDir` 写死了 bot 用户，换运行身份时要同步改** |
| `anc-watchdog` | 每天 00:00 起每 10 分钟 | `LOCAL SERVICE` | `watchdog.ps1` | 心跳 >10 分钟、outbox 积压 ≥50、WorkBuddy 不在跑 → 运维群告警（同类问题 30 分钟冷却） |
| `anc-workbuddy-launch` | 登录后 30 秒 | bot 用户（Interactive） | `wscript //B <bin>\run-hidden.vbs <bin>\anc-launch.cmd` | 用补丁启动器拉起 WorkBuddy，杜绝「登录自动起了无补丁实例」 |
| `anc-patch-guard` | 登录后 10 秒 + 每天 00:00 起每 1 分钟 | bot 用户（Interactive） | `wscript //B <bin>\run-hidden.vbs <bin>\anc-guard.cmd` | 读 `patch-state.json`；只认补丁体包装成功后写的 `applied=true`，否则触发自愈重启（10 分钟冷却；重启中、重启失败、锚点缺失时 60 分钟内不再触发） |
| `anc-update-watch` | 每天 09:00 | `LOCAL SERVICE` | `check-workbuddy-update.ps1` | 请求厂商更新接口：有新版本就发运维群（只有告警发出去了才记为已见），提示按 skill 走回归 |

PowerShell 任务统一是 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <bin>\<脚本>`。两个 `.cmd`（`anc-guard.cmd`、`anc-launch.cmd`）与 `anc-loop.cmd` 的应有内容在仓库 `scripts/` 下，部署时以它们覆盖主机上的同名文件；`.cmd` 只写 ASCII（cmd.exe 按 OEM 代码页读）。注册用 `scripts\register-tasks.ps1`（默认 dry-run，`-Apply` 才写；两个交互类任务要求 bot 用户已登录过、没有用户配置目录时会拒绝注册）：`-BotUser`、`-BackupDestination`、`-CleanupMediaDir` 都可覆盖。

### 部署（一条命令）

```powershell
# 先看计划（默认 dry-run）
powershell -File scripts\deploy.ps1
# 落盘：备份 → 复制 → 逐文件对拍 hash → 失败回滚
powershell -File scripts\deploy.ps1 -Apply
```

把 `src\{service,ingest,render}`、`scripts\*.ps1|*.cmd|*.vbs`、`scripts\workbuddy-patch\*` 复制到 `%ProgramData%\anc\` 下的 `service|ingest|render|bin|patch`，排除 `*.test.ts`。落盘前备份到 `%ProgramData%\anc\backup\deploy-<时间>\`，落盘后逐文件比对 SHA-256，不一致就整体回滚。备份目录目前不自动清理，按需删旧的。

## 账号与凭据

- `%ProgramData%\anc\accounts` **只给 Administrators 与 SYSTEM**：里面有 `anc-bot` 密码和按名单开出的只读账号初始密码，bot 账号（标准用户）不得读取；
- 员工账号用 `scripts\provision-vault-accounts.ps1 -Csv <名单> -DryRun` 先看计划，再正式执行；CSV 用 UTF-8 写；
- 凭据文件发给本人后删除，不进仓库、不进聊天。
- **收紧 `secrets` 必须是三步**（只做 `/inheritance:r` + `/grant` 不会移除 `BUILTIN\Users`，它会作为显式 ACE 留下）：
  ```powershell
  icacls C:\ProgramData\anc\secrets /inheritance:r
  icacls C:\ProgramData\anc\secrets /remove:g "BUILTIN\Users" "Everyone" "Authenticated Users" /T
  icacls C:\ProgramData\anc\secrets /grant "NT AUTHORITY\SYSTEM:(OI)(CI)F" "BUILTIN\Administrators:(OI)(CI)F" "NT AUTHORITY\LOCAL SERVICE:(OI)(CI)RX" "<bot用户>:(OI)(CI)RX" /T
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

以登录用户身份运行的任务（`anc-patch-guard`、`anc-workbuddy-launch`）如果直接调 `powershell.exe`，每次触发都会闪一个控制台窗口（守卫每分钟一次）。现在统一用 `scripts/run-hidden.vbs` 包一层：

```
wscript.exe //B //Nologo run-hidden.vbs "<某个 .cmd>"
```

`.cmd` 里再 `powershell -WindowStyle Hidden -File ...`。自愈的 Worker 与重启也都经 `.vbs` 由 Explorer 拉起，全程无窗口。改动后实测：手动触发守卫与自愈，均无可见窗口。

## 补丁的唯一来源

线上只从 `%ProgramData%\anc\patch\` 跑补丁（`launch-patched.ps1` / `preload.cjs` / `inspect.mjs` / `manifest.json`）；守卫与自愈默认 `-PatchDir` 也指向这里。**不从 git 工作副本跑**：在仓库里切分支会直接改到线上补丁，两份 manifest 也会漂移。部署补丁 = 把 `scripts\workbuddy-patch\*` 复制到 `%ProgramData%\anc\patch\`。

登录拉起（`anc-launch.cmd`）、守卫与自愈三条启动路径必须用同一份补丁：`anc-launch.cmd` 一律以仓库 `scripts/anc-launch.cmd` 为准，指向 `%ProgramData%\anc\patch\launch-patched.ps1`。入库技能调用的入库 CLI 同理，应从部署目录跑，不从工作副本跑。

公司 bot 看到消息没有 `[anc:chat=…]` 前缀时**不再自己跑自愈**，只回「身份识别暂不可用」；修复完全交给守卫。任何群成员都能发消息，交给 bot 触发等于让人随意重启 WorkBuddy。
## 体检与告警

```powershell
powershell -File scripts\doctor.ps1              # 只读体检（23 项）：专用用户、进程 owner、8 个任务与 principal、心跳、版本、补丁、SMB/NTFS、secrets ACL、部署布局、密钥、时区、数据库、绑定、canary
powershell -File scripts\doctor.ps1 -SelfTest    # 自测：用 %TEMP% 夹具证明每类检查会 FAIL，不碰生产
powershell -File scripts\doctor.ps1 -BotUser X   # 换专用用户名（默认 anc-bot）
powershell -File scripts\watchdog.ps1            # 手动跑一次看有没有要告警的
```

doctor 退出码：0 无 FAIL，1 有 FAIL，并在末尾列出 `FIX`。全 PASS 是上线门槛之一。


## vault 共享

| 项 | 值 |
|---|---|
| 共享名 | `anc-vault-shared` → `D:\anc\vault-shared` |
| 共享层权限 | `Authenticated Users` 只读、`Administrators` 完全控制 |
| NTFS（共享区） | `BUILTIN\Users` 只读；`Administrators` / `SYSTEM` 完全控制；已断开继承，去掉继承来的 `Authenticated Users: Modify` |
| NTFS（内部区） | 只有 `Administrators` / `SYSTEM`；普通用户与 `Authenticated Users` 已移除 |

> 员工共享账号还没建：按 FORK §5.4，每人一个「只用于读共享、不能登录桌面」的本地账号，等员工名单确定后补。

### 按名单开账号

```powershell
# 名单 CSV（name,id；id 只允许小写字母数字 . _ -）
#   张三,zhangsan
powershell -ExecutionPolicy Bypass -File scripts\provision-vault-accounts.ps1 -Csv .\team.csv -DryRun
powershell -ExecutionPolicy Bypass -File scripts\provision-vault-accounts.ps1 -Csv .\team.csv
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
powershell -ExecutionPolicy Bypass -File scripts\backup-anc.ps1

# 带离机目标（UNC 或 U 盘）；目标不可达只告警，不算备份失败
powershell -ExecutionPolicy Bypass -File scripts\backup-anc.ps1 -Destination "\\主机\backup\anc"
```

- 备份是 SQLite `VACUUM INTO` 的一致性快照，服务在跑也能做；
- 恢复：停 `anc-service` → 用备份文件覆盖 `anc.db`（同时删掉 `-wal`/`-shm`）→ 启动任务；
- **离机目标要填上才算真正离机**：当前任务的参数里没有 `-Destination`，需要时改任务参数或加一个带目标的副本。

## 开机提醒

`anc-boot-alert` 在开机后等 60 秒，检查 `WorkBuddy.exe` 是否在跑；不在就向 `%ProgramData%\anc\secrets\ops-webhook.txt` 发一条「公司 bot 离线，请登录恢复」，之后每 10 分钟重复，2 小时后停（避免无限刷屏）。

## 自动升级

补丁启动器在网络层拦掉 `/v2/update`，并会在版本/hash 不符时向运维群告警，见 [WORKBUDDY-PATCH.md](./WORKBUDDY-PATCH.md)。

## 专用用户切换清单（上线门槛）

机器侧已就绪（2026-10-31）：标准用户 `anc-bot`（非管理员）已建，`%ProgramData%\anc\data` 给了 Modify，`secrets` / `service` / `skills` 给了 ReadAndExecute；密码写在 `%ProgramData%\anc\accounts\anc-bot.txt`（只有管理员能读，交付后删除）。

剩下是**交互**部分，按顺序做一次：

1. 注销 Administrator，用 `anc-bot` 登录；
2. 在该用户下装 WorkBuddy（企业版），登录企业微信（扫码）；
3. 把补丁目录拷到该用户可读的位置（如 `C:\ProgramData\anc\patch\`），或用共享；
4. 用补丁启动器起 WorkBuddy：`powershell -File launch-patched.ps1`；
5. 确认 `workbuddy-patch.log` 里 `APPLIED mode=hash` 与 `update-hook installed` 都在；
6. 在该用户下装技能：把 `~/.workbuddy/skills/anc-*` 复制过去（或跑 `render onboard --home`）；
7. 群里发「今天有什么任务」→ 有回复即 T4 复测通过；
8. 回填 [VERIFY.md](./VERIFY.md) 的 T4 行，并把本清单标记完成。

> 注意：切换后别再回 Administrator 跑 WorkBuddy，否则又回到「bot 在管理员会话里」的状态。

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
