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
5. 确认 `workbuddy-patch.log` 里 `PATCHED` 与 `update-hook installed` 都在；
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

# 看备份日志
Get-Content C:\ProgramData\anc\data\backup.log -Tail 20
```
