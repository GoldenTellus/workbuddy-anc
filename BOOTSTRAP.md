# BOOTSTRAP — agent 的部署入口

> 读到这份文件，说明有人给了你一个仓库链接，让你在这台机器上装这个项目。
> **先读完这一页再动手。** `docs/DEPLOY-COMPANY.md` 是 1200 行的逐段手册，是排障参考，不是入口。

## 你要做的事

在一台 Windows 机器上装出「公司 bot」或「员工 bot」。全程 4 步，其中 3 步不需要人。

## 第 0 步：问一句，定 side

> 「这台机器是公司那台常开的主机，还是员工自己的电脑？」

- 主机 → `company`
- 员工电脑 → `employee`

**不要问「你要 company 还是 employee」**——那是内部术语，装的人不知道自己是哪种。

## 第 1 步：环境（你自己做）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\bootstrap.ps1 -InstallDeps
```

缺 Node / Git 会用 winget 装好，装完自动从注册表刷新 PATH。要求当前会话是**管理员**（Node/Git 装机器级）。

没有 winget 的机器（Win10 LTSC、精简系统）它会给出两个官方下载链接，那一步得人来做。

## 第 2 步：体检

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\preflight.ps1 -Side company -Json
```

`ok:false` 就看 `blockers`，每条都有 `fix` 和一句人话。最常见的两条：

| blocker | 含义 | 做法 |
|---|---|---|
| `agent-elevated` | WorkBuddy 不是管理员打开的 | 关掉 WorkBuddy，右键「以管理员身份运行」重开本会话 |
| `node` / `git` | 依赖缺失或版本低 | 回第 1 步 |

`facts.machineProfile` 是这台机器的画像（`admin-elevated` / `admin-not-elevated` / `standard-user` / `builtin-admin` / `builtin-admin-uac-off`），`facts.guidance` 是给人看的做法——直接转述，不要自己推断。

## 第 3 步：访谈（问人，一次问全）

```powershell
powershell -File scripts\deploy\deploy-kickoff.ps1 -Phase identity                              # 先定 side
powershell -File scripts\deploy\deploy-kickoff.ps1 -Phase prepare -Side company -Role boss      # 递准备清单给人
powershell -File scripts\deploy\deploy-kickoff.ps1 -Phase collect -Side company -Json           # 要问的字段
powershell -File scripts\deploy\deploy-kickoff.ps1 -Phase check   -Side company                 # 齐了才继续
```

`prepare` 的输出可以原样转发到群里——那是给人看的、带「怎么算做好了」的清单。**等他说做完再往下。**

## 第 4 步：装

```powershell
powershell -File scripts\deploy\install-company.ps1 -VaultRoot D:\anc -Apply
```

10 个阶段按固定顺序跑，每步自动记账，失败即停；续跑用 `-From <阶段>`，别从头重装。

`patch` 排在最后，因为它会用启动器重启 WorkBuddy——当前会话会断，这是预期的。

## 只有人能做，别硬扛

| 事 | 为什么 |
|---|---|
| 装 WorkBuddy 并以管理员身份打开 | 装不了自己 |
| 企微群里加机器人、抄 chatId 和 webhook | 后台操作，企微没给 API |
| 填公司名、成员名单、部门 | 只有人知道 |
| 第一次管理员会话 | 注册 SYSTEM 任务本身要提权（鸡生蛋） |

## 装完之后

日常升级在群里说一句「项目有更新」即可（`anc-update` 技能）。它走 `anc-elevate` 的 SYSTEM 通道，**不需要再提权**。

## 读更多

| 想了解 | 读 |
|---|---|
| 逐段细节、排障、重装、回滚 | `docs/DEPLOY-COMPANY.md` / `docs/DEPLOY-EMPLOYEE.md` |
| 这个项目到底是什么 | `README.md` |
| 开发规则（**不是**部署流程） | `AGENTS.md` |
