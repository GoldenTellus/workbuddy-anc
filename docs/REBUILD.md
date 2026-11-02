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

**不要手工列复制清单**。用 `deploy.ps1`：它是部署的唯一真相源，带映射表 + 覆盖率检查
（`src/` 下每个文件都必须落在某个映射下，否则直接 Fail），还有逐文件 hash 校验和备份。

```powershell
$R = '<仓库>'; $A = 'C:\ProgramData\anc'
# 目标目录先建好（root 不存在时 deploy 会 Fail）
'service','ingest','render','shared','bin','backup','patch' | ForEach-Object { New-Item -ItemType Directory -Force "$A\$_" | Out-Null }
powershell -File "$R\scripts\deploy.ps1" -Repo $R -Root $A -Apply
```

> 为什么改成这样：原来这段手工列 `Copy-Item "$R\src\service\*" ...`，只覆盖 service/ingest/render。
> 后来加了 `src\shared\audit.ts`，手工清单没跟上——按老 runbook 重建的机器上 CLI 会
> `ERR_MODULE_NOT_FOUND`，而且删掉之后 doctor 读出来全是空。deploy 的覆盖率检查能当场拦住这类漂移。

补丁（线上补丁的唯一来源）也由 deploy 一并复制到 `patch\`。

按 [OPS.md](./OPS.md) 重新注册九个计划任务：`anc-service`、`anc-backup`、`anc-boot-alert`、
`anc-cleanup`、`anc-watchdog`、`anc-http`、`anc-workbuddy-launch`、`anc-patch-guard`、`anc-update-watch`。

> `anc-workbuddy-launch` 与 `anc-patch-guard` 必须用**bot 用户 + Interactive** 身份注册，否则拉不起 GUI。
> 三个 `.cmd`（`anc-guard.cmd`、`anc-launch.cmd` 进 `bin\`，`anc-loop.cmd` 进 `service\`）由 deploy 复制；
> 触发器、身份、参数照 OPS.md 的计划任务表。

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

## 7. 重建演练与基线（2026-11-02）

没有第二台干净机，所以用一个**空目录**演练：按 §1、§3 建目录 + 部署，再用 `doctor -Root` 验证结构。
它不能替代真机（§2 数据恢复、§4 bot 登录没法自动化），但能回答两件事——结构 doctor 认不认、每步多久。

```powershell
powershell -File scripts\rebuild-drill.ps1            # 默认用临时空目录，跑完自清理
powershell -File scripts\rebuild-drill.ps1 -Keep      # 保留演练根，便于手工看
```

**基线（本机 2026-11-02 实测）**：

| 步骤 | 耗时 |
|---|---|
| 建目录结构 | 0.1 s |
| 部署运行件（deploy -Apply，56 文件逐字节校验） | 3.8 s |
| doctor 校验结构 | 17.5 s |
| **合计** | **21.4 s** |

`deploy-layout: PASS`。重建耗时以这个数为基线：明显变慢说明映射变多或校验变重，要回头看是否值得。

每次演练追加一行到 `_research/rebuild-baseline.log`（不在 git 里），便于对比。

> 演练本身也抓过一次问题：脚本里用 scriptblock 执行步骤，赋值落在局部作用域，
> 外层读到的永远是初值——表现是"部署明明成功却报未取到"。这类问题只有真跑一遍才暴露。
