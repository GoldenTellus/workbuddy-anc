# 主机重建 runbook

主机坏了，按这份在新机器上重建。目标：**数据不丢、提醒照常、bot 能上线**。

## 0. 先分清哪些东西不在 git 里

| 资产 | 位置 | 是否有副本 |
|---|---|---|
| SQLite 数据库 | `C:\ProgramData\anc\data\anc.db` | `anc-backup` 每天 02:00（本地 14 份 + 第二块盘 `E:\anc-backup`） |
| 密钥（webhook / 运维 webhook / userid） | `C:\ProgramData\anc\secrets\` | **只有主机上有**；须另行离线保存 |
| vault 原件 `_originals/` | `D:\anc\vault-shared\_originals\` | 不进 git；须随备份一起复制 |
| 两区 vault 的 git | `D:\anc\vault-*` | 有 git 历史；建议加一个远端 |
| org 数据 / 渲染产物 | `D:\anc\org`、`D:\anc\build` | 建议纳入 vault 内部区或单独备份 |

## 1. 新机准备

1. Windows + 管理员账号；
2. Node.js 22 LTS、Git for Windows；
3. 把仓库 clone 到 `E:\workbuddy-anc`（或任意路径，下面用变量）；
4. 建目录：`C:\ProgramData\anc\{data,secrets,service,skills,bin,backup,accounts}`、`D:\anc\{vault-shared,vault-internal,inbox}`。

## 2. 恢复数据

```powershell
# 数据库：取最新一份备份
Copy-Item E:\anc-backup\anc-<最新>.db C:\ProgramData\anc\data\anc.db
# 密钥：从离线保管处放回（值不进 git、不进聊天）
# 原件与 vault：从备份复制 D:\anc\vault-shared / vault-internal（含 _originals）
```

## 3. 装服务与任务

```powershell
# 服务代码
Copy-Item <仓库>\src\service\* C:\ProgramData\anc\service -Recurse -Force
# 运维脚本
Copy-Item <仓库>\scripts\{backup-anc,boot-alert,cleanup-media,watchdog,doctor}.ps1 C:\ProgramData\anc\bin -Force
# ACL：LOCAL SERVICE 读 service/secrets、写 data/backup；anc-bot 读 service/secrets/skills、写 data
```

按 [OPS.md](./OPS.md) 重新注册八个计划任务：`anc-service`、`anc-backup`、`anc-boot-alert`、`anc-cleanup`、`anc-watchdog`、`anc-workbuddy-launch`、`anc-patch-guard`、`anc-update-watch`。

> `anc-workbuddy-launch` 与 `anc-patch-guard` 必须用**登录用户 + Interactive** 身份注册，否则拉不起 GUI。

## 4. 恢复 bot

1. 建专用标准用户 `anc-bot`；
2. 登录该用户，安装 WorkBuddy（企业版），扫码登录企业微信；
3. 用补丁启动器启动：`launch-patched.ps1`，确认日志里 `APPLIED mode=hash` + `update-hook installed`；
4. 安装技能到该用户 `~/.workbuddy/skills/`（或 `render onboard`）；
5. 群里发「今天有什么任务」，有回复即可。

## 5. 验收

```powershell
powershell -File C:\ProgramData\anc\bin\doctor.ps1      # 全 PASS 才算完
powershell -File C:\ProgramData\anc\bin\watchdog.ps1    # 无异常退出 0
```

再人工做一次：登记 2 分钟后到点的任务 → 到点收到 @ 提醒。

## 6. 已知缺口

- 密钥没有离机副本时，只能重新生成 webhook（群机器人设置里换一个新的）；
- 主机名/共享名变了，员工机上的 `\\主机\anc-vault-shared` 路径要跟着改（重渲染接入包）；
- `_originals/` 没随备份走的话，入库文档会失去原件，只能重新收集。
