# BOOTSTRAP — agent 的部署入口

> 类型：部署入口 · 最后整理：2026-11-16
>
> 读到这份文件，说明有人给了你一个仓库链接，让你在这台机器上装这个项目。
> **先读完这一页再动手。** `docs/DEPLOY-COMPANY.md` 是 1200 行的逐段手册，是排障参考，不是入口。

## 你要做的事

在一台 **Windows 或 macOS** 机器上装出「公司 bot」或「员工 bot」。Windows 全程 4 步（其中 3 步不需要人）；mac 收在第 0 步的四条命令里。

## 第 0 步：这台机器是 Windows 还是 mac

先看平台：**Windows 走第 1–4 步（原样不变）；mac 走下面四条命令，全程只有一次 `sudo`。**

| 机器 | 走法 | 要人做的唯一一步 |
|---|---|---|
| Windows 10/11 | 第 1–4 步：`bootstrap` → `preflight` → `deploy-kickoff` → `install-company` | 第一次管理员会话（注册 SYSTEM 任务本身要提权） |
| macOS 12+ · 公司侧（常开主机） | 下面四条命令，`install` 直接 `sudo` | 一次 `sudo`（写 `/Library`、装 LaunchDaemon） |
| macOS 12+ · 员工侧 | 下面四条命令，把 `--side company` 换成 `--side employee`，**不要 sudo** | 装 WorkBuddy 并登录 |

```bash
node scripts/deploy/anc.mjs doctor --side company                    # 平台 / 路径 / WorkBuddy / 任务体检；ok:false 看 blockers
node scripts/deploy/anc.mjs plan   --side company                    # dry-run：会铺什么、装哪些任务、要哪些权限
sudo -E node scripts/deploy/anc.mjs install --side company --apply --system   # 公司侧一次 sudo；员工侧去掉 sudo -E 与 --system
# -E 不是可选项：macOS 的 sudo 默认 env_reset，PATH 里没有 /usr/local/bin（Homebrew 的 node 在这），
# 敲 `sudo node ...` 会直接 command not found。
node scripts/deploy/anc.mjs verify --side company --json             # ok:true 即装完
```

装在哪、10 个能跑 / 4 个暂不注册的是哪几个、为什么，看 [docs/PLATFORMS.md](./docs/PLATFORMS.md)——**mac 上少 4 个任务不是装漏了**（其中 `anc-elevate` 是设计上不需要：LaunchDaemon 本身就是 root）。

### 同一台机器上还要定 side

> 「这台机器是公司那台常开的主机，还是员工自己的电脑？」

- 主机 → `company`
- 员工电脑 → `employee`

**不要问「你要 company 还是 employee」**——那是内部术语，装的人不知道自己是哪种。
Windows 的第 1–4 步按 `company` 写；员工侧把 `-Side` / `-VaultRoot` 换掉即可，差异见 `docs/DEPLOY-EMPLOYEE.md`。

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

按固定顺序跑 **11 步**（`preflight → dirs → files → skills → tasks → vault → org → wecom → verify → executor → patch`）；`preflight` 只是前置检查、**不记账**，其余每步自动记账，失败即停；续跑用 `-From <阶段>`。`deploy-state` 公司侧共 14 阶段（另含 `brief`/`answers`/`workbuddy`），员工侧 9 阶段（没有 `dirs`/`tasks`，由本地自举一次做完）

`patch` 排在最后，因为它会用启动器重启 WorkBuddy——当前会话会断，这是预期的。

**重启后不需要任何人再做手工步骤**：`anc-patch-guard` 会在一分钟内完成主干 2 收尾——
自动把仓库目录加入 WorkBuddy 工作区（用 wake bridge 在该目录建会话并发 `TEST`，bot 回「收到，TEST 正常」），
然后自动注册当天的 host。结果看：

```powershell
Get-Content (Join-Path $env:ProgramData 'anc\data\executor-deploy.json') -Raw
```

`ok:true` 即部署完成。失败会自动重试，原因在 `data\executor-deploy.log`；人工修好后跑
`tools\setup-executor.ps1 -Apply`（仓库源文件 `scripts\deploy\setup-executor.ps1`）重试。不想自动启用：`-SkipExecutor`，或 answers 里 `executor.enabled=否`。

> 默认工作区 = **仓库父目录下的独立空目录**（如 `D:\anc-executor-ws`），与仓库本身隔离；想换路径传 `-ExecutorWorkspace <绝对路径>`。
> 不需要在 WorkBuddy UI 里手动“添加工作区”。

## 只有人能做，别硬扛

| 事 | 为什么 |
|---|---|
| 装 WorkBuddy 并以管理员身份打开 | 装不了自己 |
| 企微群里加机器人、抄 chatId 和 webhook | 后台操作，企微没给 API |
| 填公司名、成员名单、部门 | 只有人知道 |
| 第一次管理员会话（Windows）/ 一次 `sudo`（mac 公司侧） | 注册系统级任务本身要提权（鸡生蛋） |

## 装完之后

日常升级在群里说一句「项目有更新」即可（`anc-update` 技能）。它走 `anc-elevate` 的 SYSTEM 通道，**不需要再提权**。

## 读更多

| 想了解 | 读 |
|---|---|
| 逐段细节、排障、重装、回滚 | `docs/DEPLOY-COMPANY.md` / `docs/DEPLOY-EMPLOYEE.md` |
| 这台机器是 mac：路径、任务、哪些暂不注册 | `docs/PLATFORMS.md` |
| 这个项目到底是什么 | `README.md` |
| 开发规则（**不是**部署流程） | `AGENTS.md` |
