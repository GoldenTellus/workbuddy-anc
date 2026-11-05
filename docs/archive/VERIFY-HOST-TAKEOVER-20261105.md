# 接手验证记录：公司主机（2026-11-05）

> **已归档（2026-11-06）**：核心结论已并入 `docs/VERIFY.md` §79，本文整体移到
> `docs/archive/` 留档。**附录 B「复现清单」是本文独有的，完整保留在文末**——
> 那是「换机器后怎么快速自证现状」的可执行清单，VERIFY 里没有对应内容。
> 当前状态与判据一律以 `VERIFY.md` / `PLAN.md` 为准；本文的 pid、时间戳、端口
> 归属都是 2026-11-05 那一刻的历史快照，重启即变，不要当现状读。

> **这份文档是什么**：一个没有参与过本项目的 agent，在**已经在跑的公司主机**上做的一次只读现状核查。
> 对应 `docs/D-HANDOFF-PROMPT.md`「B 路（接手维护）」的实测，也是 1.0 判据第 4 条（"第二个人能不能自己判断现状"）的一次样本。
>
> **读者**：下一个接手这台机器的人 / agent。
> **不要**把它当成"补丁永远没问题"的证明——pid 和时间戳都是**某一刻的快照**，重启就变。

| 项 | 值 |
|---|---|
| 执行时间 | 2026-11-05 15:13–15:22（Asia/Shanghai） |
| 执行者 | 运维 agent（新会话，无历史上下文） |
| 写入范围 | **只读为主**；唯一写入是 `-DryRun` 按设计往 `data\selfheal.log` 追了 3 行 |
| 仓库 | `E:\workbuddy-anc`，`main` @ `7b55f5a`（2026-11-05 15:12），工作区干净 |

---

## 0. 三句话结论

1. **这台机器是"已装过的公司侧主机"**（`%ProgramData%\anc` 12:50 落盘，`%LOCALAPPDATA%\anc` 不存在），所以 `AGENT-VERIFY-HANDOFF.md` 里最值钱的三项（D4.6 陌生人独立装 / O-5 干净机重建 / E-1 员工机）**在本机做不了**——它就是主机本身。
2. **自证是绿的**：`doctor` 两处都是 `ok=true fails=0`（31 项，WARN=1 / WARN=2），`deploy-verify` 是 `ok=true pass=5 fail=0 skip=0`；其中 `bot-reply` 只代表"注入成功"，**60 秒内没有观察到回复**。
3. **补丁生效中是"活的"**：`applied=true` + `pid 17164` 还活着 + `127.0.0.1:17999` 属主就是它 + 钩子今天还在触发 + canary 今天还在更新；自愈链是 `anc-patch-guard`（每 1 分钟）→ `anc-selfheal.ps1`（inspect → 重启 → 最多 4 次重试）。

---

## 1. 这台机器是什么

| 项 | 实测 |
|---|---|
| 机器 | Windows 10 家庭版 |
| 账号 | `Administrator`（**已提权**，`IsInRole(Administrator)=True`；按 D25 约定直接用管理员账号） |
| 角色判定 | **公司侧，且为 `already-installed`**：`%ProgramData%\anc` 存在（2026-11-05 12:50 落盘），`%LOCALAPPDATA%\anc` **不存在** |
| 运行时 | node **v24.13.1** / git **2.52.0.windows.1** / `W32Time` **Running** |
| WorkBuddy | **5.9.3**，8 个进程，主进程 pid **17164**（14:34:16 启动） |
| 部署根 | `%ProgramData%\anc`：`bin/ data/ patch/ render/ secrets/ service/ shared/ templates/ vault 相关 dirs` |
| 部署副本一致性 | `doctor.ps1` / `deploy-verify.ps1` / `patch-guard.ps1` / `anc-selfheal.ps1` 与仓库 **SHA256 全等**；`patch\` 下 7 个文件与 `scripts\workbuddy-patch\` **全部一致**（见 §4.5） |

按 `docs/AGENT-VERIFY-HANDOFF.md` §1.2 的对表，这是**第 3 行「已经装过（`already-installed`）」**，只能验标 `[升级]` 的项。

---

## 2. 交接文档说了什么（以及一处需要纠正的偏差）

`docs/AGENT-VERIFY-HANDOFF.md`（829 行）是给**新机器**的验证交接：能验/不能验、24 个坑（§4.1–§4.4）、6 个测试方法（§5）、工具速查（§6）、交回物（§7）。三条与本次直接相关：

- **§1.4** 4 项任何单机都做不了：真升级回归（R7）、E-2 私聊仅管理员、P-3 真员工上线、P-7 席位回收。
- **§4.3⑳** `patch-state.json` 会跨版本残留、`doctor` 也信它 → 判补丁必须同时满足「`applied=true`」**和**「那个 pid 还活着」。
- **§4.3⑯** `deploy-state` 记的是"哪些步骤跑过了"，不等于"能用"→ 要再用 `deploy-verify` 验。

HEAD 提交（`7b55f5a`）另附了一份 `docs/D-HANDOFF-PROMPT.md`（B 路：接手维护），结论与上面一致。

**一处需要纠正**：该文档第 97 行写 `deploy-state 9/11（patch 与 wecom 标 FAILED）`。
**实际读到的 `deploy-state.json` 里 `failed` 是空字符串**，两项是 `pending`：

```json
{"side":"company","stage":"patch","done":["preflight",...,"verify"],"failed":"","error":""}
```

即：**不是"失败"，是"没标 done"**。这个区别影响判断——"失败"要修，"没记账"只要复核后补记账。

---

## 3. 自证结果（原样）

### 3.1 `scripts\doctor.ps1 -Repo <仓库根> -Json` → exit 0

```text
ok=true   fails=0   warns=1   共 31 项
WARN: work-hours —— 未配置工作时段（默认全天）
```

### 3.2 `%ProgramData%\anc\bin\doctor.ps1 -Json` → exit 0

```text
ok=true   fails=0   warns=2   共 31 项
WARN: work-hours
WARN: secrets-in-git —— 未指定 -Repo（或不是 git 仓库），跳过仓库密钥扫描
```

> 差一个 WARN 是**设计如此**（没有仓库可扫），不是部署副本坏了。

### 3.3 `scripts\deploy-verify.ps1 -Side company -Json` → exit 0

```text
ok=true   pass=5   fail=0   skip=0

database    PASS  库存在 %ProgramData%\anc\data\anc.db
doctor      PASS  FAIL=0 WARN=2（31 项）
task-write  PASS  task #10 写进去了，查得回来
bot-reply   PASS  注入成功（len=75），但 60 秒内没等到回复
tasks       PASS  10 个任务全部 Ready/Running
next: 全部通过。
```

**`bot-reply` 必须准确表述**：PASS 的依据是**注入成功**，脚本自己也写了"但 60 秒内没等到回复"，FIX 是"回复慢是模型行为（并发时等到过 8 分钟）"。
→ 结论应记为 **"注入通过 / 回复未观察"**，**不能记成"全绿"**（对照 §5.4：`SKIP` 与"PASS 但没观察到效果"都不是通过）。

### 3.4 doctor 31 项逐项（`-Repo` 那一次）

| # | check | state | detail |
|---|---|---|---|
| 1 | dedicated-user | PASS | Administrator（管理员组，按 D25 约定） |
| 2 | bot-process-owner | PASS | WorkBuddy 跑在 Administrator |
| 3 | work-hours | **WARN** | 未配置工作时段（默认全天） |
| 4 | task-anc-backup | PASS | Ready / LOCAL SERVICE |
| 5 | task-anc-boot-alert | PASS | Ready / LOCAL SERVICE |
| 6 | task-anc-cleanup | PASS | Ready / SYSTEM |
| 7 | task-anc-devbot | PASS | Ready / Administrator |
| 8 | task-anc-http | PASS | Running / LOCAL SERVICE |
| 9 | task-anc-patch-guard | PASS | Ready / Administrator |
| 10 | task-anc-service | PASS | Ready / LOCAL SERVICE |
| 11 | task-anc-update-watch | PASS | Ready / LOCAL SERVICE |
| 12 | task-anc-watchdog | PASS | Ready / LOCAL SERVICE |
| 13 | task-anc-workbuddy-launch | PASS | Ready / Administrator |
| 14 | heartbeat | PASS | 1 分钟内有 tick |
| 15 | manifest | PASS | 5.9.3 / 3510b309… |
| 16 | workbuddy | PASS | 版本 5.9.3 |
| 17 | patch | PASS | APPLIED(hash) + update-hook |
| 18 | smb | PASS | 共享存在且 Everyone/Authenticated Users/Users 只读 |
| 19 | vault-acl | PASS | 共享区对 Users/Everyone/Authenticated Users 只读 |
| 20 | secrets-acl | PASS | 只对服务身份与管理员可读，且服务身份确实有读权限 |
| 21 | data-acl | PASS | data 目录与日志对服务身份可写 |
| 22 | deploy-layout | PASS | 部署目录结构正确，patch 与仓库一致 |
| 23 | secrets-in-git | PASS | 仓库内容未见真实密钥 |
| 24 | timezone | PASS | China Standard Time |
| 25 | time-sync | PASS | W32Time Running |
| 26 | database | PASS | 4096 B |
| 27 | bindings | PASS | 1 个绑定都登记了 webhook |
| 28 | canary | PASS | 最近 0 小时内有消息且带 chatId |
| 29 | http-health | PASS | tick 1 分钟前 |
| 30 | vault-ingest-audit | PASS | 共享区无未跟踪改动 |
| 31 | backup-freshness | PASS | 2 小时前，140 KB |

### 3.5 `deploy-state`（进度文件）——与现实的偏差

```text
progress 9/11   stage=patch   failed=""（空）
done  = preflight, workbuddy, dirs, files, skills, tasks, vault, org, verify
pending = patch, wecom
next  = "下一步：patch（打补丁（patch-guard / selfheal））"
```

**但这两项实际已完成**（`patch` 见 §4；`wecom` 见 §5①）。这是记账落后，不是安装未完成。处理建议见 §5①。

---

## 4. 补丁现在是什么状态

### 4.1 结论：生效中，且是活着的那一个进程，不是残留

单看 `applied=true` 会被 §4.3⑳ 的残留骗；单看日志 `APPLIED` 只能证明"注入过"（§4.3⑲）。所以做了**五条独立交叉验证**：

| # | 证据 | 实测值 |
|---|---|---|
| 1 | `data\patch-state.json` | `{"pid":17164,"version":"5.9.3","at":"2026-11-05T06:34:18.915Z","mode":"hash","applied":true}` |
| 2 | pid 是否活着 | **17164 存在**，启动 14:34:16（与状态文件 14:34:18 吻合） |
| 3 | 端口属主 | `127.0.0.1:17999` **Listen，OwningProcess=17164**——就是打了补丁那个进程 |
| 4 | 钩子是否真的在跑 | `patch-hooks.log`：`14:36:14 HIT sendReply #1`、**`15:18:00 HIT emitMessage #3`**（15:18 是本次 `deploy-verify` 注入的） |
| 5 | 注入方式是否降级 | `node patch\inspect.mjs` → `hashMatches:true anchorsOk:true bootstrapOk:true`；hash `3510b309…`、size 27427 与 `manifest.json` 登记一致 |
| 6 | 群身份是否真取到 | `patch-canary.json`：`{"at":"2026-11-05T07:18:00Z","chatId":true,"user":true,"contentStr":true}` |

补充：`workbuddy-patch.log` 对应行 `[pid 17164] INJECTED mode=hash target=…\app.asar\main\wecomaibot-client.js` / `APPLIED mode=hash`（06:34:18.910Z / .916Z）。
注入的**目的**（D17）：把企微 AIBot 回调里的 `chatId` / 发送人注入消息正文，让 agent 能读到"群身份"。

### 4.2 靠什么自愈：四层，不是一层

| 层 | 谁 | 频率 / 身份 | 职责 |
|---|---|---|---|
| ① 启动兜底 | `anc-workbuddy-launch` → `patch\launch-patched.ps1` | 登录触发 / Administrator·Interactive | 开机第一跳就用带补丁的启动器 |
| ② 每分钟守卫 | `anc-patch-guard` → `bin\patch-guard.ps1` | **每 1 分钟** / Administrator·Interactive，上限 3 分钟，`IgnoreNew` | 判"在跑但没补丁"→ 触发 ③ |
| ③ 自愈执行器 | `bin\anc-selfheal.ps1` | 被 ②/人工 调起；10 分钟冷却；单飞锁 3 分钟 | inspect → 判锚点 → 起 worker 重启 → **最多 4 次** |
| ④ 看门狗 | `anc-watchdog` → `bin\watchdog.ps1` | 每 10 分钟 / LOCAL SERVICE | 心跳 ≥10 分钟、outbox 积压 ≥50、WorkBuddy 不在、canary 24 小时内无 `chatId`、17891 `/__anc_health`；异常发运维群（30 分钟冷却） |

**② 的判定逻辑**（`scripts\patch-guard.ps1`，逐行读过）：

1. `data\maintenance.flag` 在 → **完全不插手**（升级/排障期间不许抢着拉起）。实测：**ABSENT**。
2. 主进程**不在**（排除 `--type=` 子进程与 `daemon-app-server-entry`）→ 直接自愈；但 3 分钟内不重复拉（`patch-guard.state.json` 记 `lastStartAt`）。
3. 主进程在 → 判补丁：**双条件** `applied=true` **且** `state.at >= 进程 CreationDate - 15 秒`。这道 15 秒闸就是防残留的。
4. 有人正在对话（`patch-canary.json` **2 分钟内**有更新）→ **推迟重启**，等下一个空档（不打断正在回话的 bot）。
5. **只对永久性失败封锁 60 分钟**：`anchors-missing`（厂商改了代码，要人工重找锚点）、`restart-failed`（反复起不来）。**`inspect-failed` 不封锁**——这是 `VERIFY §75.4` 修的缺陷：升级窗口里 `app.asar` 正被替换，inspect 必然失败一次，原来会把"升级后自愈"这条路径自己锁死 60 分钟。
6. 其余情况 → 调 ③。

**③ 的重试与失败信号**（`scripts\anc-selfheal.ps1`）：

- 冷却 10 分钟；**WorkBuddy 根本不在时绕过冷却**（崩溃恢复优先）。
- `inspect.mjs` 判 `version / hashMatches / anchorsOk / bootstrapOk`；锚点缺失 → `exit 3` + 运维群告警 + 60 分钟封锁。
- 单飞锁 `selfheal.lock`（3 分钟后视为陈旧可接管），防守卫/看门狗/人工同时重启。
- worker **经 `explorer.exe` + `.vbs` 拉起**，脱离 WorkBuddy 进程树（否则 `taskkill` 会把自己一起杀）。
- **停全部 WorkBuddy → 用 `launch-patched.ps1` 重启 → 轮询 `patch-state.json`**：每次尝试最多 75×2 秒，**最多 4 次**。
- 为什么是 4 次：`--inspect-brk` 注入**单次成功率实测约 66%**（210 次 `env set` / 140 次 `APPLIED`，`VERIFY §59`）。重试 2 次全败约 11%，4 次约 **(1/3)⁴ ≈ 1.2%**。这是"承认它只有 66%，用重试兜住"，不是"修好了注入"。
- 成功 → `selfheal.state.json = healed`；**失败 → 把 `patch-state.json` 改写成 `applied=false` + `error`，并发运维群 webhook**（`VERIFY §58` 修的：不让状态文件继续骗 `doctor`）。

**最近两次自愈实测**（`data\selfheal.log`）：

```text
13:29:35 inspect: version=5.9.3 hashMatches=True anchorsOk=True bootstrapOk=True
13:29:35 安排自愈重启（约 5 秒后 bot 短暂离线）
13:29:49 worker: 第 1 次启动 …\patch\launch-patched.ps1
13:30:03 worker: 重启成功（补丁已生效）          ← R7 修好后的自动路径，55 秒

14:33:54 inspect: … hashMatches=True anchorsOk=True bootstrapOk=True
14:34:19 worker: 重启成功（补丁已生效）          ← 本次运行前的那一次，约 25 秒
```

### 4.3 怎么验（三层，便宜的在前）

**层 1 — 30 秒，判"现在活着没"**（跳过它必被骗）

```powershell
$s = Get-Content "$env:ProgramData\anc\data\patch-state.json" -Raw | ConvertFrom-Json
$s.applied                                                                    # 必须 True
Get-Process -Id $s.pid                                                        # pid 必须还在
(Get-NetTCPConnection -LocalPort 17999 -State Listen).OwningProcess -eq $s.pid # 必须 True
```

**层 2 — 2 分钟，判"注入方式对不对 + 真能取到群身份"**

```powershell
node "$env:ProgramData\anc\patch\inspect.mjs"        # hashMatches/anchorsOk/bootstrapOk 都要 True
# 然后往群里发一条，看这两处：
Get-Content "$env:ProgramData\anc\data\patch-hooks.log" -Tail 5   # 要出现新的 HIT emitMessage / sendReply
Get-Content "$env:ProgramData\anc\data\patch-canary.json" -Raw    # 要 chatId:true
```

**层 3 — 破坏性，判"自愈真的会动"**（本次**没跑**，因为会打断 bot）

```powershell
Stop-Process -Name WorkBuddy -Force
# 等 ≤2 分钟：守卫每分钟一次 → worker 4 秒 → 启动约 55 秒
Get-Content "$env:ProgramData\anc\data\selfheal.log" -Tail 10   # 应看到"安排自愈重启"→"重启成功"
# patch-state.json 应出现新 pid，且 17999 属主跟着变
```

**层 4 — 无副作用的自愈干跑**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:ProgramData\anc\bin\anc-selfheal.ps1" -DryRun
# 本次实测 15:20:58：
#   inspect: version=5.9.3 hashMatches=True anchorsOk=True bootstrapOk=True
#   dry-run：锚点可用，未安排重启
```

**升级回归**另按 `docs/VERIFY.md §75` 走（`verify-upgrade.ps1` + R7 四项判据）。
⚠️ **对真厂商升级的自愈，`§75` 是唯一一次实测**（而且是伪造触发 + 一次真实 5.8.3→5.9.3 升级），别当常态保证。

### 4.4 相关任务与触发器（实测）

| 任务 | 状态 | 身份 | 触发 | 备注 |
|---|---|---|---|---|
| anc-patch-guard | Ready | Administrator / Interactive | 登录 + 开机 + **每 1 分钟**（`PT1M`，上限 3 分钟，`IgnoreNew`） | 跑 `run-hidden.vbs` → `anc-guard.cmd` → `patch-guard.ps1` |
| anc-selfheal | *（无独立任务）* | — | 由 ②/④/人工调起 | 单飞锁 + 冷却 |
| anc-watchdog | Ready | LOCAL SERVICE | 每天 00:00 起 **每 10 分钟**（上限 5 分钟） | 5 项检查 → 运维群 |
| anc-workbuddy-launch | Ready | Administrator / Interactive | **登录** | 用 `launch-patched.ps1` 启动 |
| anc-update-watch | Ready（从未跑 `0x41303`） | LOCAL SERVICE | 每天 09:00 | 主动查新版，同版本只告警一次 |
| anc-service | Ready | LOCAL SERVICE | 每天 00:00 起 **每 1 分钟** + 开机 | 本地小服务 tick（`loop.log`） |
| anc-http | **Running** | LOCAL SERVICE | 开机 + 每 1 分钟（常驻监听） | `LastResult=0x800710E0` 见 §5③ |
| anc-backup | Ready | LOCAL SERVICE | 每天 02:00 起每 1 小时 | `-Destination E:\anc-backup` |
| anc-devbot | Ready（**从未跑 `0x41303`**） | Administrator / Interactive | 每天 **22:00** 起每 30 分钟 | 见 §6⑤ |
| anc-cleanup | Ready（从未跑） | SYSTEM | 每天 03:00 | — |
| anc-boot-alert | Ready（从未跑） | LOCAL SERVICE | 开机 | — |

> `0x41303` = `SCHED_S_TASK_HAS_NOT_RUN`（还没跑过）；`0x0` = 成功。

### 4.5 部署副本与仓库一致性

`scripts\doctor.ps1` / `deploy-verify.ps1` / `patch-guard.ps1` / `anc-selfheal.ps1` 与仓库 SHA256 全等。
`patch\` 下 7 个文件与 `scripts\workbuddy-patch\` 全等：

```text
launch-patched.ps1  7795BB02 = 7795BB02
inject.cjs          AAEC68D9 = AAEC68D9
preload.cjs         F4B0D5F1 = F4B0D5F1
manifest.json       5281046F = 5281046F
inspect.mjs         9CD09BF3 = 9CD09BF3
restore.ps1         A52D18D3 = A52D18D3
narration.test.mjs  A45C7C99 = A45C7C99
```

`manifest.json` 关键字段：`workbuddyVersion 5.9.3` / `electron 37.10.3` / `target main/wecomaibot-client.js` / `sha256 3510b309…` / `size 27427` / `prefix "[anc:chat="` / `toggleEnv ANC_WB_PATCH`，另含 bootstrap 两处替换（关掉强更：`runStartupForceAutoUpdate` / `runEarlyForceUpgradeCheck` → `void 0`）。

---

## 5. 现场发现的 3 处偏差（都不是"坏了"，但会误导人）

### ① `deploy-state` 记账落后于现实 —— 最需要知道的一条

```text
progress 9/11   stage=patch   failed=""（空）   remaining=["patch","wecom"]
next: "下一步：patch（打补丁（patch-guard / selfheal））"
```

而 `patch` 与 `wecom` 实际都完成了：

- `patch`：§4 已证。
- `wecom`：`bind list` 有 **1 条**绑定（管理员 → `<chatId>`，`webhook_file: wecom-webhook.txt`）；`doctor` 的 `bindings`、`canary` 都 PASS。

**后果**：下一个接手的人只信这个文件，会得出"还没装完"的错误结论（`D-HANDOFF-PROMPT.md` 也预判了这个坑）。
**修法**（用脚本，不手改文件，符合"别在真机上改 ProgramData 文件"）：

```powershell
powershell -File scripts\deploy-state.ps1 -Side company -Mark patch -AsDone
powershell -File scripts\deploy-state.ps1 -Side company -Mark wecom -AsDone
```

> 本次**没有**替维护者执行，属于"要改你的进度文件"的决定，见 §6②。

### ② `test-emit.flag` 已删，但 17999 还在监听 —— 真实隐藏状态

- `data\test-emit.flag`：**ABSENT**。
- `127.0.0.1:17999`：**仍在 Listen**，属主 17164。

原因：flag 是**进程启动时读一次**（`AGENT-VERIFY-HANDOFF §4.3⑫`；`OPS.md` 也记过）。flag 存在 ≠ 端口在监听，反过来，flag 删了 ≠ 端口关掉。
**后果**：现在本机 `POST 127.0.0.1:17999/emit` 仍能伪造"有人 @ 了 bot"（仅回环 + 仅管理员可达）。本次 `deploy-verify` 的 `bot-reply` 就是靠它注入成功的（15:18:00）。
**关掉的代价**：重启 WorkBuddy，bot 短暂离线约 55 秒。见 §6③。

### ③ `anc-http` 的 `LastResult=0x800710E0` 不是故障

任务状态 `Running`（常驻监听器），每分钟触发器按 `IgnoreNew` 被拒，所以这个码停在"上一次启动被忽略"。
**实际服务是好的**：`http://127.0.0.1:17891/__anc_health` → `{"ok":true,"detail":"tick 0 分钟前"}`；`loop.log` 的 mtime 就是当前分钟（age=0）。

旁注：`node src\service\cli.ts … issue list` 输出 `ok:true, issues:[]`，**单独跑退出码 0**。首次看到 `exit 1` 是 PowerShell 把 stderr 的 SQLite 实验性警告当 `NativeCommandError`，不是脚本问题——这条记下来，免得下一个人误判。

---

## 6. 需要人配合的（按"要不要动手"排）

| # | 事项 | 为什么 | 谁做 |
|---|---|---|---|
| ① | **去群里看一眼**：15:18 那条 `deploy-verify` 注入（len=12）bot 有没有回 | `bot-reply` 只判到"注入成功"，回复是模型行为，等不到 60 秒不代表坏 | 人 |
| ② | **要不要补 `deploy-state` 的 `patch` / `wecom` 记账**（§5① 那两行） | 记账落后会误导下一个接手者；但那是维护者的进度文件 | 人点头 → agent 执行 |
| ③ | **要不要关掉 17999**（重启 WorkBuddy，约 55 秒离线） | 它现在是"无 flag 但仍在听"的隐藏状态 | 人决定 |
| ④ | **企微后台两项**：`E-2` 私聊仅管理员、`P-7` 删席位回收 | 后台开关，本机无权限；属 1.0 的 🟡，**不是代码缺陷** | 人 |
| ⑤ | **今晚 22:00 的 devbot 首次真触发** | `anc-devbot` 是 **Interactive / Administrator**，要开机 + 部署账号在线。**但当前 `issue list --status open` 为空** → 会照常触发但无事可做 | 人保持在线；要不要先造 issue 见下 |
| ⑥ | **要验"真到点跑一次完整链路"得先造一条 open issue** | `cli` 没有直接造 issue 的命令，可从 submission 走一遍，或直接写库（**说明用了哪种**） | 人指定 |

### 本机做不到的（写明，不硬凑）

| 项 | 卡在哪 |
|---|---|
| **真升级回归（R7）** | 要腾讯真发新版；`§75` 只做过一次真实升级 + 三次伪造失效路径 |
| **E-2 私聊仅管理员** | 企微管理后台开关 |
| **P-3 真员工上线** | 要真企微账号 + 真人，验不了"一小时"这个 SLA |
| **P-7 席位回收** | 企微后台删席位（其余三步 `§35` 已验） |
| **D4.6 陌生人独立装 / O-5 干净机重建 / E-1 员工机** | 本机就是主机本身；且 WorkBuddy 用 asar 全局互斥体保证单实例（`§33`），同机当不了员工机 |

> 这 5 个 DoD 🟡 全部卡环境，按 `docs/ACCEPTANCE.md` 的降级表处置，**不卡 1.0**，也不能标"完成"。

---

## 7. 本次做了什么 / 没做什么（披露）

**只读**：读文档、`doctor`×2、`deploy-verify`、`deploy-state -Json`、`inspect.mjs`、`anc-selfheal.ps1 -DryRun`、`bind list`、`issue list`、任务/进程/端口/CIM 查询、文件哈希比对、日志尾部读取。

**唯一写入**：`-DryRun` 按设计往 `data\selfheal.log` 追加 3 行（15:20:58–15:20:59），**不安排重启、不改状态文件**。

**没做（明确说明，不是漏了）**：

- 没有跑破坏性自愈验证（会打断 bot）。
- 没有改 `deploy-state`。
- 没有重启 WorkBuddy / 没关 17999。
- 没有在真机上改 `ProgramData` 里的任何文件（改仓库 → 重新部署，是唯一路径）。
- 没有把真实 `chatId` / `userid` / 主机名写进本文档（用 `<chatId>` / `<userid>` / `%USERPROFILE%` 占位）。

---

## 附录 A 关键状态文件快照（2026-11-05 15:2x）

```jsonc
// data\patch-state.json
{"pid":17164,"version":"5.9.3","at":"2026-11-05T06:34:18.915Z","mode":"hash","applied":true}

// data\selfheal.state.json
{"at":"2026-11-05T14:34:19.2675025+08:00","status":"healed"}

// data\patch-canary.json
{"at":"2026-11-05T07:18:00.047Z","chatId":true,"user":true,"contentStr":true}

// data\deploy-state.json
{"side":"company","stage":"patch","done":["preflight","workbuddy","dirs","files","skills","tasks","vault","org","verify"],"failed":"","at":"2026-11-05T13:06:37.8240596+08:00","error":""}

// data\workbuddy-path.txt
C:\Users\<user>\AppData\Local\Programs\WorkBuddy\WorkBuddy.exe
```

`bind list` / `issue list` 摘要：

```text
bindings: 1 条（管理员 → <chatId>，webhook_file=wecom-webhook.txt）
issues(open): 0 条
```

`patch-in.log` 尾部（含本次注入）：

```text
2026-11-05T06:35:41.607Z chat=<chatId> from=deploy-verify len=12 text=????:???????
2026-11-05T06:46:11.405Z chat=<chatId> from=deploy-verify len=12 text=????:???????
2026-11-05T07:18:00.046Z chat=<chatId> from=deploy-verify len=12 text=????:???????
```

> 中文显示成 `????` 是写日志时的编码问题（`VERIFY §25` 记过类似的 `\n` 转义问题），不影响判据。

---

## 附录 B 复现清单（一条条敲，30 秒到 2 分钟）

```powershell
# 1) 这台机器是什么
whoami; (Get-CimInstance Win32_OperatingSystem).Caption
Test-Path (Join-Path $env:ProgramData 'anc'); Test-Path (Join-Path $env:LOCALAPPDATA 'anc')

# 2) 自证
cd E:\workbuddy-anc
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\doctor.ps1 -Repo 'E:\workbuddy-anc' -Json
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:ProgramData\anc\bin\doctor.ps1" -Json
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy-verify.ps1 -Side company -Json
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy-state.ps1 -Side company -Json

# 3) 补丁是否活着（三条必须同时成立）
$s = Get-Content "$env:ProgramData\anc\data\patch-state.json" -Raw | ConvertFrom-Json
$s.applied
Get-Process -Id $s.pid
(Get-NetTCPConnection -LocalPort 17999 -State Listen).OwningProcess -eq $s.pid

# 4) 注入方式 / 自愈干跑
node "$env:ProgramData\anc\patch\inspect.mjs"
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:ProgramData\anc\bin\anc-selfheal.ps1" -DryRun

# 5) 现场痕迹
Get-Content "$env:ProgramData\anc\data\patch-hooks.log" -Tail 5
Get-Content "$env:ProgramData\anc\data\selfheal.log" -Tail 10
Get-ScheduledTask -TaskName 'anc-*' | ForEach-Object {
  $i = Get-ScheduledTaskInfo -TaskName $_.TaskName
  [pscustomobject]@{ Name=$_.TaskName; State=$_.State; LastResult=('0x{0:X}' -f $i.LastTaskResult); Next=$i.NextRunTime }
} | Format-Table -AutoSize
```

---

## 附录 C 给下一个接手者的一句话

> **别信 `deploy-state` 的 9/11，也别只信 `patch-state.json` 的 `applied=true`。**
> 前者是"跑过哪几步"，后者可能是上次成功的残留；
> 判"补丁现在活着"的唯一硬判据是：**`applied=true` + 那个 `pid` 还在 + `17999` 属主等于它**，
> 再用 `patch-hooks.log` / `patch-canary.json` 证明它**今天还在干活**。
