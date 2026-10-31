# 主机运维

对应 [PLAN.md](./PLAN.md) M1「上线前必须满足」与 [FORK-DIRECTION.md](./FORK-DIRECTION.md) §5.1/§5.10。

## 计划任务

| 任务 | 触发 | 身份 | 作用 |
|---|---|---|---|
| `anc-service` | 开机 + 每分钟 | `LOCAL SERVICE` | 跑 `loop --once`：到期提醒 → outbox → 群机器人 |
| `anc-backup` | 每天 02:00 | `LOCAL SERVICE` | `VACUUM INTO` 备份数据库，保留最近 14 份 |
| `anc-boot-alert` | 开机 + 每 10 分钟（持续 2 小时） | `LOCAL SERVICE` | WorkBuddy 没起来就经运维群 webhook 告警 |
| `anc-cleanup` | 每天 03:00 | `SYSTEM` | 清企微附件落地目录里超过 7 天的文件（要访问 bot 用户的 TEMP，故用 SYSTEM） |

## vault 共享

| 项 | 值 |
|---|---|
| 共享名 | `anc-vault-shared` → `D:\anc\vault-shared` |
| 共享层权限 | `Authenticated Users` 只读、`Administrators` 完全控制 |
| NTFS（共享区） | `BUILTIN\Users` 只读；`Administrators` / `SYSTEM` 完全控制；已断开继承，去掉继承来的 `Authenticated Users: Modify` |
| NTFS（内部区） | 只有 `Administrators` / `SYSTEM`；普通用户与 `Authenticated Users` 已移除 |

> 员工共享账号还没建：按 FORK §5.4，每人一个「只用于读共享、不能登录桌面」的本地账号，等员工名单确定后补。

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

## 常用命令

```powershell
# 看任务状态
Get-ScheduledTask -TaskName 'anc-*' | Select-Object TaskName, State
Get-ScheduledTaskInfo -TaskName 'anc-service' | Select-Object LastRunTime, LastTaskResult, NextRunTime

# 看服务日志
Get-Content C:\ProgramData\anc\data\loop.log -Tail 20

# 看备份日志
Get-Content C:\ProgramData\anc\data\backup.log -Tail 20
```
