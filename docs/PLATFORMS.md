# PLATFORMS — 双平台部署契约（Windows / macOS）

> 类型：平台契约 · 最后整理：2026-11-16
>
> **这是什么**：同一套公司 bot / 员工 bot，在 Windows 和 macOS 上**装到哪、由谁拉起、哪些能力换成什么实现、哪些任务暂时不注册**。
> **真相在代码，不在本文**：路径、能力矩阵、14 个任务表、launchd 渲染都在 [`scripts/platform/anc-platform.mjs`](../scripts/platform/anc-platform.mjs)；运行时侧同名规则在 [`src/core/paths.ts`](../src/core/paths.ts)。两份实现由跨层对拍测试钉住，本文只解释差异与后果。
> **不重复手册**：逐段安装细节看 [DEPLOY-COMPANY.md](./DEPLOY-COMPANY.md) / [DEPLOY-EMPLOYEE.md](./DEPLOY-EMPLOYEE.md)；主机运维看 [OPS.md](./OPS.md)。

---

## 0. 承诺范围

| 平台 | 状态 | 判定依据 | 说明 |
|---|---|---|---|
| Windows 10/11（PowerShell 5.1 + Node 22） | **正式支持** | `node scripts/platform/anc-platform.mjs facts` → `capabilities.supported=true` | 行为与 2026-11-10 之前**完全一致**，装机仍由 `scripts/deploy/*.ps1` 承载（§6） |
| macOS 12+（Apple Silicon / Intel） | **正式支持（10/14 任务；4 项待移植）** | 同上，`os=darwin` | 公司侧走 LaunchDaemon + 一次 `sudo`；员工侧走 LaunchAgent，不需要 sudo |
| Linux | **不承诺** | `facts` → `ok:false`、`why` 有原因 | 只做平台识别与可预测根路径（`~/.local/share/anc`），便于 CI；调度/提权/ACL 没有实现 |

```bash
node scripts/platform/anc-platform.mjs facts              # 人读：平台 / 根 / 调度 / 提权 / launcher / 任务
node scripts/platform/anc-platform.mjs facts --json       # 机器读：与 preflight 的 facts 字段尽量对齐
```

---

## 1. 能力矩阵

> 每一格都是「这个平台上**用什么实现**」，不是「有没有这个功能」。移植新平台先看这张表。

| 能力 | Windows（`win32`） | macOS（`darwin`） |
|---|---|---|
| 部署根（公司侧） | `%ProgramData%\anc` | `/Library/Application Support/anc` |
| 部署根（员工侧） | `%LOCALAPPDATA%\anc` | `~/Library/Application Support/anc` |
| vault 默认根 | 公司侧 `D:\anc`；员工侧 `%USERPROFILE%\anc` | 公司侧 `/Users/Shared/anc`；员工侧 `~/anc` |
| 调度器 | `schtasks`（[`scripts/deploy/register-tasks.ps1`](../scripts/deploy/register-tasks.ps1)） | `launchd`（[`scripts/deploy/scheduler.mjs`](../scripts/deploy/scheduler.mjs)）；公司侧 `/Library/LaunchDaemons`、员工侧 `~/Library/LaunchAgents`，标签 `local.anc.<task>` |
| 提权 | `uac`：首次管理员会话 + SYSTEM 任务（`scripts/elevate/*`，第 14 个任务 `anc-elevate`） | `sudo`：公司侧 LaunchDaemon 本身以 root 跑，**没有 SYSTEM 那层**，因此不需要提权通道（`scripts/deploy/anc.mjs` 装的时候 sudo 一次） |
| ACL | `icacls`：断继承 + 显式授权（`scripts/deploy/set-acl.ps1`） | `posix`：`chown` + `chmod`（公司侧 `root:wheel`，目录 750、`secrets` 700），没有「断继承」这个概念。**当前 `anc.mjs doctor` 只校验属主与可写性**，权限位在 mac 真机验收时逐项核对（`bin/*.sh` 的可执行位由 `deploy.mjs` 复制时保留，丢了就是「任务注册成功但从不触发」） |
| 启动器 | `.cmd` + `run-hidden.vbs`（隐藏窗口）；补丁启动走 `patch/launch-patched.ps1` | `.sh`（[`scripts/platform/darwin/`](../scripts/platform/darwin/)）；launchd 自身没有窗口问题；补丁启动走 **`patch/launch-patched.mjs`**（同一套判定，Node 实现，见 §4.1） |
| 日志 | `<部署根>\data\`（`loop.log` / `http.log`，>5 MB 转 `.1`） | 公司侧 `/Library/Logs/anc/`、员工侧 `~/Library/Logs/anc/`；每任务 `<task>.log` + `<task>.err.log` |
| WorkBuddy 安装位置 | `%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe`（或 `Program Files`）；补丁目标 `resources\app.asar` | `/Applications/WorkBuddy.app`（可覆盖为 `~/Applications`）；主程序 `Contents/MacOS/WorkBuddy`，补丁目标 `Contents/Resources/app.asar` |
| 探测命令 | `node scripts/platform/anc-platform.mjs facts --json` → `workbuddy.found` | 同上；`--json` 里 `workbuddy.appAsar` 即补丁器目标文件 |
| 环境前置 | Node 22 LTS + Git；`scripts/deploy/bootstrap.ps1` 可用 winget 静默装 | Node 22 LTS + Git（Homebrew 或官方包）；**不做自动安装**，缺就在 `anc.mjs doctor` 里报 blocker |

补充约束（两平台相同）：部署根下的标准子目录名一致（`data` / `secrets` / `bin` / `tools` / `service` / `interfaces` / `core` / `modules` / `shared` / `patch` / `inbox` / `render` / `light` / `backup` / `ingest` / `accounts` / `evals` / `stage` / `skills`），运维只记一套名字；vault 仍是两区（`vault-shared` 只读 / `vault-internal` 只有公司侧可写）。

---

## 2. 路径对照

| 用途 | Windows | macOS | 备注 |
|---|---|---|---|
| 公司侧部署根 | `%ProgramData%\anc` | `/Library/Application Support/anc` | 系统级位置，装的时候要一次 `sudo`；等价于 Windows 的首次管理员会话（D25：不建专用用户） |
| 员工侧部署根 | `%LOCALAPPDATA%\anc` | `~/Library/Application Support/anc` | 用户级位置，登录用户可写 |
| 公司侧 vault | `D:\anc` | `/Users/Shared/anc` | `D:` 是与系统盘分离的惯例；mac 用多用户可读的公共目录 |
| 员工侧 vault | `%USERPROFILE%\anc` | `~/anc` | 本地原件，不上公司共享（D54） |
| 公司侧调度目录 | `%SystemRoot%\System32\Tasks\`（`schtasks`） | `/Library/LaunchDaemons/` | mac 开机即起、不依赖人登录 —— 7×24 的硬约束 |
| 员工侧调度目录 | 同上（当前用户任务） | `~/Library/LaunchAgents/` | 登录后起，与员工电脑「不保证开机」一致 |
| 日志 | `%ProgramData%\anc\data\` | `/Library/Logs/anc/`、`~/Library/Logs/anc/` | mac 用系统认可的日志位置，便于 Console.app 与 `log show` |
| WorkBuddy | `%LOCALAPPDATA%\Programs\WorkBuddy\` | `/Applications/WorkBuddy.app/` | 补丁目标都在 `app.asar`，路径形态不同、结构同构 |

```bash
# 两台机器上都能跑：只算路径，不落盘、不需要已部署
node scripts/platform/anc-platform.mjs paths --side company     # 公司侧
node scripts/platform/anc-platform.mjs paths --side employee    # 员工侧
```

> 运行时（`src/`）**不得**再出现 `process.env.ProgramData ?? 'C:\\ProgramData'` 这类硬编码；一律走 `src/core/paths.ts` 的 `sideRoot()` / `defaultVaultRoot()` / `ancPaths()` / `defaultDbPath()` / `sideFromEnv()`（GAP-125）。

---

## 3. 计划任务在 macOS 的落地状态

任务名、排期、动作的**唯一真相**是 `anc-platform.mjs` 的 `TASKS`（14 项）。Windows 侧由 `register-tasks.ps1` 展开成 `schtasks`，macOS 侧由 `scheduler.mjs` 展开成 launchd plist。查当前机器：

```bash
node scripts/platform/anc-platform.mjs tasks --side company --json   # 只列本平台会注册的
node scripts/platform/anc-platform.mjs facts --side company           # 末尾打印「本平台不注册的任务 + 原因」
```

| 任务 | 排期 | Windows principal | macOS 状态 | macOS 落点 |
|---|---|---|---|---|
| `anc-service` | 每 60 s（`RunAtLoad`） | LOCAL SERVICE | ✅ 能跑 | `local.anc.anc-service` → `node --no-warnings <root>/service/cli.ts loop --once --db <root>/data/anc.db` |
| `anc-http` | 常驻（`KeepAlive`） | LOCAL SERVICE | ✅ 能跑 | `node --no-warnings <root>/service/cli.ts serve --port 17891 --db <root>/data/anc.db`（只监听 127.0.0.1） |
| `anc-backup` | 每 3600 s | LOCAL SERVICE | ✅ 能跑 | `node --no-warnings <root>/service/cli.ts backup --to <备份目的地>` |
| `anc-cleanup` | 每天 03:00 | LOCAL SERVICE | ✅ 能跑 | `/bin/sh <root>/bin/cleanup-media.sh --days 7` |
| `anc-watchdog` | 每 600 s | LOCAL SERVICE | ✅ 能跑 | `/bin/sh <root>/bin/watchdog.sh` |
| `anc-executor-wake` | 每 60 s | LOCAL SERVICE | ✅ 能跑 | `node --no-warnings <root>/bin/executor-tasks.mjs wake --root <root>` |
| `anc-executor-new-host` | 每天 03:00 | LOCAL SERVICE | ✅ 能跑 | `node --no-warnings <root>/bin/executor-tasks.mjs new-host --root <root>` |
| `anc-executor-host-tick` | 每天 03:00 | LOCAL SERVICE | ✅ 能跑 | `node --no-warnings <root>/bin/executor-tasks.mjs host-tick --root <root>` |

> 三份 executor 动作（`wake-if-queued.ps1` / `new-host.ps1` / `host-tick.ps1`）在 Node 侧合并成**一个文件三个子命令**（`scripts/executor/executor-tasks.mjs`）：判断逻辑本来就重叠，拆三份会出现三份「45 秒节流」「UUID 判定」的实现，迟早漂。
| `anc-workbuddy-launch` | 登录后一次（`RunAtLoad`） | 交互（DNT） | ✅ 能跑 | `<root>/bin/anc-launch.sh`（补丁启动器） |
| `anc-boot-alert` | 每 600 s（`RunAtLoad`） | LOCAL SERVICE | ✅ 能跑（已移植） | `/bin/sh <root>/bin/boot-alert.sh` |
| `anc-patch-guard` | 每 60 s | 交互（DNT） | ❌ 不注册 | 依赖 `Win32_Process` 进程枚举与自愈链路，待移植（§5） |
| `anc-elevate` | 每 60 s | SYSTEM | ❌ 不注册 | 公司侧 LaunchDaemon 本身就是 root，**不需要提权通道**（不是缺口，是设计差异） |
| `anc-update-watch` | 每天 09:00 | LOCAL SERVICE | ❌ 不注册 | 厂商更新探测按 Windows 安装布局写，mac 侧待实测（§5） |
| `anc-devbot` | 每 1800 s | LOCAL SERVICE | ❌ 不注册 | 依赖 WorkBuddy persona 路径与 git 身份，待移植（§5） |

结论：**macOS 上 10 个任务能跑、4 个暂不注册**（其中 `anc-elevate` 属「设计上不需要」，另 3 个是真缺口）。`requiresWorkbuddy=true` 的任务在没探测到 WorkBuddy 时不注册（只装确定性服务的机器）。

> **不许「以为装了」**：`doctor` / `facts` 必须把不注册的任务与原因打出来，而不是安静少几个任务。判据是 `facts.scheduler.unsupported` 非空时要有可见输出。

`facts` 在这台 mac（未装 WorkBuddy）上的真实输出形状——**没有 WorkBuddy 时 5 个交互/执行任务也不注册**，只剩确定性服务：

```text
平台                    darwin / arm64
部署根                   /Library/Application Support/anc
vault                 /Users/Shared/anc
调度                    launchd → /Library/LaunchDaemons
提权                    sudo
launcher              shell
WorkBuddy             未找到（只装确定性服务）
计划任务                  5 个：anc-service, anc-http, anc-backup, anc-cleanup, anc-watchdog
本平台不注册的任务：4 条（patch-guard / elevate / update-watch / devbot，各自带原因）
```

---

## 4. 命令面

两平台共用一套 Node 入口；Windows 的老 PowerShell 入口继续可用（§6）。

| 目的 | 命令 | 说明 |
|---|---|---|
| 平台体检 | `node scripts/deploy/anc.mjs doctor --side company`（入口见 [`scripts/deploy/anc.mjs`](../scripts/deploy/anc.mjs)） | 平台事实 + 根路径 + WorkBuddy 探测 + 任务计划；macOS 上等价于 Windows 的 `preflight.ps1` |
| 只看要做什么 | `node scripts/deploy/anc.mjs plan --side company` | 打印会铺哪些目录/文件、装哪些任务、需要几次 sudo；**默认 dry-run** |
| 落地 | `sudo -E node scripts/deploy/anc.mjs install --side company --apply --system` | 公司侧要 sudo 一次（LaunchDaemon + `/Library` 写入）；员工侧去掉 sudo，落到 `~/Library`。`-E` 必需：macOS `sudo` 默认 `env_reset`，`PATH` 不含 Homebrew 的 `/usr/local/bin`，`sudo node` 会 command not found |
| 自证 | `node scripts/deploy/anc.mjs verify --side company --json` | 与 `deploy-verify.ps1` 同口径的 `ok` / 失败项 |
| 平台事实 | `node scripts/platform/anc-platform.mjs facts \| paths \| tasks \| plist` | `plist` 接受 `--task <name> --side company --root <root>`，输出可直接 `plutil -lint` 校验 |
| 铺运行时件 | `node scripts/deploy/deploy.mjs --side company`（dry-run）→ `--apply` 落盘 → `--rollback` 回滚 | 清单真相源仍是 `deploy.ps1`，Node 侧读其镜像 `deploy-manifest.json`；备份 → 复制 → sha256 对拍 → 失败整体回滚 |
| 装/卸调度 | `node scripts/deploy/scheduler.mjs status`（对账）/ `apply --apply`（落盘 + `launchctl bootstrap`）/ `--uninstall --apply`（`bootout` + 删 plist） | 标签 `local.anc.<task>`；plist 里只允许 `ANC_ROOT` / `ANC_SIDE` / `NODE_OPTIONS` / `PATH`，凭据一律走 `<root>/secrets` |
| 装机账本 | `node scripts/deploy/deploy-state.mjs --side company --json`；`--mark <阶段> --as-done` / `--as-failed --reason "<原因>"` | 公司侧 14 阶段（员工侧阶段清单以 `--json` 的 `stages` 为准）；状态文件 `<root>/data/deploy-state.json`，阶段名与 Windows 侧一致 |
| 路径与清单对拍 | `node scripts/checks/check-platform-parity.mjs`（**零输出 = 通过**，已挂在 `npm run check`，`npm test` 经 pretest 必跑）；负向用例在 `scripts/platform/deploy.test.mjs`（伪造漂移的 `paths.ts` 必须报差异） | 四条绊线：`paths.ts ↔ anc-platform.mjs` 四组（win/mac × company/employee）；`deploy.ps1 ↔ deploy-manifest.json`（含顺序与 Only 白名单）；清单 ↔ 真实文件；`src/` 非测试 `.ts` 全覆盖 |

```bash
# 渲染一个 plist 看看（不落盘、不需要 sudo）
node scripts/platform/anc-platform.mjs plist --task anc-service --side company \
  --root "/Library/Application Support/anc" | plutil -lint -- -
```

参数以各脚本文件头注释里的 usage 为准（`scripts/deploy/anc.mjs` / `deploy.mjs` / `scheduler.mjs` / `deploy-state.mjs` 四个文件头都写了用法与退出码）；仓库统一约定：`0` 成功 / `1` 校验失败 / `2` 用法错误。**`deploy.mjs` 的 `3` 是「复制失败且已回滚」**（沿用 `deploy.ps1` 的历史语义，与 `anc.mjs` 里「环境不满足」不是同一个意思，判断时看 stderr 的 `ERROR`/`FIX` 两行）。

---

## 4.1 补丁链路（2026-11-16 真机验收结果）

真机：macOS arm64 + WorkBuddy（验收开始时 5.9.3，期间自升级到 5.11.3）+ Electron 37.10.3。全部通过 launchd 触发，不手工起进程。

| 项 | 结果 | 说明 |
|---|---|---|
| 包里找得到应用 | ✅ | `/Applications/WorkBuddy.app`；**包内主程序叫 `Electron`**（`CFBundleExecutable=Electron`），写死 `MacOS/WorkBuddy` 会一直「找不到 WorkBuddy」 |
| 主补丁锚点 | ✅ | `main/wecomaibot-client.js` 27,427 B / sha256 与 manifest **逐字节一致**（5.9.3）；升级到 5.11.3 后 hash 变（27,300 B）但 `emitMessage` / `WecomAiBotClient` 锚点仍在 → 走 `mode=anchor` |
| 升级拦截补丁 | ⚠️ 不适用 | `main/main-bootstrap.js` 的 `runStartupForceAutoUpdate` / `runEarlyForceUpgradeCheck` 在 macOS 包里**不存在**；`manifest.bootstrapTarget` 需要在 mac 上重新侦察后才能启用 |
| 注入 | ✅ | `--inspect-brk=9229` 启动 → `inject.cjs` 在主进程设 `NODE_OPTIONS` → daemon 子进程（`daemon-app-server-entry.js`）加载 preload → `patch-state.json` `{applied:true, mode:"anchor", pid:<daemon>}`，`runId` 与本次启动一致 |
| 触发路径 | ✅ | `local.anc.anc-workbuddy-launch` → `bin/anc-launch.sh` → `patch/launch-patched.mjs`（整条链在 launchd 下跑通，人不用登录到桌面点图标） |
| 系统级安装（2026-11-16 次日二次验收） | ✅ 通过 | `/Library/Application Support/anc` 171 文件、9 个 LaunchDaemon（system 域）+ 1 个 LaunchAgent（gui 域，属主改回登录用户）、`verify` 32 项 0 失败；`anc-service` last exit 0、`/__anc_health` ok、`anc-workbuddy-launch` 由 launchd 拉起且 `patch-state.json` `applied=true` |
| 系统级安装的 TCC 约束 | ⚠️ 记入运维 | root 进程（sudo / 图形授权）**读不到** `~/Documents` 下的仓库（TCC 隐私保护），会 `EPERM uv_cwd`；系统级安装要把仓库复制到可读路径（如 `/tmp/anc-repo-live`）再 `--repo` 指过去 |
| 空格路径 | ✅ 已修 | 部署根 `/Library/Application Support/anc` 带空格，`NODE_OPTIONS` 不加引号会把 preload 路径切断。实测 Node 22 支持 `NODE_OPTIONS='--require "…"'` 引号写法 → `inject.cjs` 改为加引号，不再“见空格即拒绝” |
| 域划分 | ✅ 已修 | `--system` 时 9 个服务进 `/Library/LaunchDaemons`（system 域），GUI 任务 `anc-workbuddy-launch` 进登录用户的 `~/Library/LaunchAgents`（gui 域）并改属主；root daemon 拉起 WorkBuddy 会被系统拒绝 |
| 环境陷阱 | ✅ 已修 | agent 宿主会给子进程带 `ELECTRON_RUN_AS_NODE=1`：WorkBuddy 被当**纯 Node** 拉起来，主进程解析完参数即退出（无窗口、无崩溃报告），现象酷似「补丁把应用弄崩」。启动器现在清 `ELECTRON_RUN_AS_NODE` / `ELECTRON_NO_ATTACH_CONSOLE` / `NODE_OPTIONS` 后再 exec |
| 启动方式 | ✅ 已修 | macOS 上直接 exec `Contents/MacOS/Electron` 才拿得到 `--inspect-brk`（`open --args` 实测传不进）；进程清理按 **bundle 路径**匹配（按名字 `WorkBuddy` 杀不掉叫 `Electron` 的主进程） |

同轮真机验收还暴露并修掉三处「装机看起来成功、运行时不对」的问题：

| 现象 | 根因 | 修法 |
|---|---|---|
| `/__anc_health` 恒 `ok:false`（`没有 loop.log`），watchdog 会误报「心跳停了」 | launchd 把 stdout 重定向到 `/Library/Logs/anc/anc-service.log`，而健康检查按 `<root>/data/loop.log` 的 mtime 判活（Windows 的 `anc-loop.cmd` 就是写这个文件） | `anc-service` 的 plist `StandardOutPath` 固定为 `<root>/data/loop.log`，其余任务仍写 `<logDir>/<task>.log` |
| 改了 plist，`launchctl print` 里还是旧参数/旧日志路径 | launchd 在 bootstrap 时**快照** job 配置；只覆盖文件不会自动重载 | `scheduler.mjs` 比对已加载 job 的 `ProgramArguments` + `StandardOutPath`，漂移则 `bootout` + `bootstrap` |
| `--launchd-dir` 指到 `~/Library/LaunchAgents` 时 bootstrap 全部失败 | 域按 `side` 算成 `system`，实际目录属于用户域 | 域改为按 **plist 目录** 算（`/Library/**` → `system`，其余 → `gui/<uid>`） |
| `anc-backup` 每次 `EACCES`（`mkdir /Library/...`） | 计划任务动作里只给了 `--to`，CLI 落到平台默认根找库 | 所有 `cli` 动作一律显式带 `--db`；备份改用 `backup-anc.mjs`（时间戳文件名 + 保留 7 份，CLI 的 `--to` 是文件路径且目标已存在会报错） |

证据（本机，不入库）：`_research/acceptance-mac-20261116/`（`patch-state.launchd.json` / `patch-run.json` / `workbuddy-launch.log` / `backup.log` / `scheduler-status.json` / `health.json`）。

---

## 5. 已知缺口（macOS 侧待移植）

| 项 | 影响 | 现状 | 处置 |
|---|---|---|---|
| `anc-patch-guard` 未移植 | 补丁被重启/升级打掉后不会自动自愈；WorkBuddy 侧 `applied=false` 只能靠 `anc.mjs verify` 或人工发现 | macOS 不注册该任务 | 移植进程探测（`pgrep -f WorkBuddy`）+ 复用 `patch-guard.sh` 自愈骨架；归 `GAP-124` |
| `anc-update-watch` 未移植 | 厂商出新版不会主动告警，升级窗口靠人盯 | 探测按 Windows 安装布局写 | 按 `WORKBUDDY.mac` 布局改探测目标（`app.asar` 版本字段），并在 mac 真机实测；归 `GAP-124` |
| `anc-devbot` 未移植 | 夜间「全员下班」自动 devbot 不启动 | 依赖 WorkBuddy persona 路径与 git 身份 | 先在 mac 上固化 persona 落点与 git 身份，再移植；归 `GAP-124` |
| `anc-elevate` 不注册 | 无 | **不是缺口**：root daemon 无需提权通道 | 不需要动作；文档明确写清，避免被当成漏装 |
| macOS 真机验收 | 装机链路、launchd 起停、日志落点、补丁注入**已于 2026-11-16 在本机通过**（见 §4.1） | 用户态验收（`~/anc-acceptance` + `~/Library/LaunchAgents`），未走 `/Library` sudo 路径 | 系统级（LaunchDaemon + `/Library`）与员工侧 mac 分发仍待真机；归 `GAP-124` |
| manifest 版本落后于机器 | 本机 WorkBuddy 已自升级到 5.11.3，`manifest.json` 仍登记 5.9.3（锚点模式可打，但 hash 对不上） | 5.11.3 的 hash（`097c4868…`）已侦察，`emitMessage` 锚点在 | 先跑 Windows 侧升级回归，再更新 `manifest.json` 的 version/sha256/size；归 `GAP-124` |
| 员工侧 mac 分发 | 员工机装 WorkBuddy + 本地自举（D54）在 mac 上未走通 | 只有 Windows 员工侧证据 | 归主干 4 / `GAP-124` 的后续项 |

---

## 6. Windows 行为不变（硬承诺）

| 面 | 现状 | 证据 |
|---|---|---|
| 装机编排 | `install-company.ps1` 11 步不变 | `scripts/deploy/install-company.ps1` |
| 计划任务 | `register-tasks.ps1` 注册 14 个任务、principal 与触发器不变 | `docs/OPS.md` §计划任务 |
| 装机账本 | `deploy-state.ps1` 变成转调 `node scripts/deploy/deploy-state.mjs` 的**薄壳**，阶段名与退出码不变 | `scripts/deploy/deploy-state.ps1` |
| 部署/体检/自证 | `deploy.ps1` / `preflight.ps1` / `deploy-verify.ps1` / `doctor.ps1` 未改 | 同上 |
| 平台层 | 只被 Node 入口与文档引用；`src/` 不 import 它 | `scripts/platform/anc-platform.mjs` 头注释的边界 |

判断标准：Windows 主机的 `deploy-state` 阶段数（公司侧 14；员工侧以 `deploy-state --json` 的 `stages` 为准）、doctor 项数、任务清单、`bin\` 扁平布局**任何一个数字变了就是回归**，不属「平台化」。

---

## 7. 变更记录

| 日期 | 改了什么 | 为什么 |
|---|---|---|
| 2026-11-16 | 建档：能力矩阵、路径对照、14 任务落地状态、命令面、缺口表、Windows 不变声明 | 新增 macOS 部署路径（`GAP-124` / `GAP-125`），把平台差异收进一份契约 |
| 2026-11-16 | 真机验收：补丁启动器改 Node（`launch-patched.mjs`）、env 消毒、直接 exec、loop.log 心跳、域按目录、`--db` 必带、备份走 `backup-anc.mjs`；新增 §4.1 | 本机 macOS 上把「补丁 applied=true」和 10 个 launchd 任务跑通，修掉 4 处只在真机暴露的问题（`GAP-127` / `GAP-128`） |
