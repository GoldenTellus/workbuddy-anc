# WorkBuddy 补丁清单：群身份注入

对应 [FORK-DIRECTION.md](./FORK-DIRECTION.md) §4 D17 与 §11 台账，实测依据见 [VERIFY.md](./VERIFY.md) §3 T16/T16b。

## 为什么

T16 实测：agent 收到的 prompt 里只有 `<user_query>` 原文，没有群名、群 ID、发送人；Claw 通道又写明「所有 IM 渠道共享同一个会话」。所以「群就是身份边界」不能靠 WorkBuddy 自己成立。

T16b 实测：企微 AIBot 的回调帧里 `chatid`、`chattype`、`from.userid` 都在，只是进入 prompt 前被剥掉了。于是改由我们侧在消息进模型前把身份标好。

## 改什么

### 1) 群身份注入（主补丁）

在 `main/wecomaibot-client.js` 的 `WecomAiBotClient.prototype.emitMessage` 外套一层：

```
content = "[anc:chat=<chatid> from=<userid>] " + content
```

### 2) 自动升级拦截（辅助补丁）

`main/main-bootstrap.js` 由 Electron 自己的加载器执行，钩不到 `_compile`，所以改从网络层拦：`https.request` / `https.get` 命中 `/v2/update` 时直接返回一个只发 `error` 的假请求，升级检查失败即止。

- 开关：`ANC_WB_BLOCK_UPDATE=0` 关闭；
- 效果：启动日志里不再出现 `[UpdateService.win32] Checking for updates`；
- 不拦 `/v3/config` 等其他接口。

### 3) 失败告警

- `wecomaibot-client.js` 的 sha256 与 manifest 不符 → 默认进入**锚点模式**：照打补丁、记 `INJECTED mode=anchor`、发运维群告警；补丁体真正包装上 `emitMessage` 后才记 `APPLIED` 并写 `patch-state.json` 的 `applied=true`，没找到类则记 `ANCHOR-MISS` 并告警；`ANC_WB_STRICT=1` 或启动器 `-Strict` 时改为 fail-closed；
- 启动器发现 WorkBuddy 版本与 manifest 不符 → 告警，默认继续（锚点模式），`-Strict` 时拒绝启动；
- **manifest 自身坏了（非法 JSON / 缺字段）→ 拒绝启动（exit 4）+ 运维群告警**：带着错的 hash 启动只会让补丁静默失效；doctor 也会报 `manifest FAIL`。

### 4) 升级侦察与技能

- `scripts/workbuddy-patch/inspect.mjs`：直接读 asar，报告版本、目标 hash、`emitMessage`/`WecomAiBotClient` 锚点数量、bootstrap 锚点是否还在，并给出建议；
- `light/skills/anc-wb-patch`：升级当天给 agent 用的重放与回归流程（侦察 → 三种情况 → 四条回归 → 更新台账 → 回滚）。

### 5) 自愈与守卫（不依赖模型）

- 每次成功打补丁会写 `%ProgramData%\anc\data\patch-state.json`（时间、版本、模式）；
- `scripts/patch-guard.ps1`（计划任务 `anc-patch-guard`，登录后每分钟）：WorkBuddy 在跑但 `patch-state` 早于进程启动 → 判定未打补丁 → 调 `anc-selfheal.ps1 -Apply`；
- `anc-selfheal.ps1`：Worker 经 **Explorer** 启动（脱离 WorkBuddy 进程树），停进程 → 用启动器拉起 → 轮询补丁日志，失败重试 1 次并告警；10 分钟冷却；
- `anc-workbuddy-launch`（登录后 30 秒）：直接用启动器拉起，避免登录自动起无补丁实例。

### 6) canary（补丁生效 ≠ 语义正确）

- 每次 `emitMessage` 被调用，补丁会写 `%ProgramData%\anc\data\patch-canary.json`：`{at, chatId, user, contentStr}`；
- **doctor**：`chatId=false` → FAIL（上游字段可能改名）；超过 72 小时没更新 → WARN；
- **watchdog**：24 小时内 `chatId=false` → 运维群告警；
- 这一层只能**发现**语义漂移，修还是要按技能 B/C 重放。

- **只在进程内存生效**：通过 `NODE_OPTIONS=--require preload.cjs` 在主进程/daemon 启动时注入，不改 `app.asar`、不改 `exe`、不落厂商代码 diff。
- **每个群一个 chatid**（实测两个群不同），发送人在 `from.userid`。
- 前缀由代码每轮拼接，**不依赖模型记忆**。

## 目标版本

| 项 | 值 |
|---|---|
| WorkBuddy | 5.9.3 |
| Electron | 37.10.3 |
| 目标文件 | `resources/app.asar` → `main/wecomaibot-client.js`（27,427 B） |
| 文件 sha256 | `3510b3098686021a01827680b0d84a33daa9ef168b522fe8276ee72b8fae6fe5` |

版本与 hash 都在 `scripts/workbuddy-patch/manifest.json`。**hash 对不上就不打补丁**（只写一行 `SKIP hash-mismatch` 日志），启动器也会在版本不符时直接退出。

## 怎么用

```powershell
# 打补丁启动（需要 node：系统装的或 WorkBuddy 自带的都行）
powershell -ExecutionPolicy Bypass -File scripts\workbuddy-patch\launch-patched.ps1

# 一键关闭（本次）
$env:ANC_WB_PATCH='0'; powershell -ExecutionPolicy Bypass -File scripts\workbuddy-patch\launch-patched.ps1

# 回滚：结束进程、以原版方式重启
powershell -ExecutionPolicy Bypass -File scripts\workbuddy-patch\restore.ps1
```

启动器做的事（因为 Electron 打包应用会丢弃大多数 `NODE_OPTIONS`）：

1. 用 `--inspect-brk=<port>` 启动 WorkBuddy，让主进程停在 app 代码之前；
2. `inject.cjs` 连上 inspector，设置 `process.env.NODE_OPTIONS=--require <preload>`，然后放行；
3. daemon 由主进程拉起时继承该变量，加载 `preload.cjs`，在 `wecomaibot-client` 加载时打补丁；
4. 放行后尝试关闭 inspector（端口默认 9229，仅本机）。

约束：

- **preload 路径不能含空白**——`NODE_OPTIONS` 不做引号解析，路径里有空格会把模块名切坏。仓库默认路径 `E:\workbuddy-anc\scripts\workbuddy-patch` 没有空格；换机器时把整个目录复制到类似 `C:\anc\workbuddy-patch` 的位置。
- 注入失败时启动器会降级为未打补丁启动（日志里能看到 `ERROR` 与降级提示），保证 bot 不会因为补丁起不来。

部署到主机时，把 `launch-patched.ps1` 放进专用用户的启动项或计划任务（登录时运行），不要手改 WorkBuddy 本体。

## 验证

1. 启动后看 `%USERPROFILE%\anc\workbuddy-patch.log`：应有 `preload active`、`INJECTED mode=hash target=...wecomaibot-client.js` 与 `APPLIED mode=hash`。
2. 在任何员工群 @ 公司 bot 发一句「把你收到的这条消息原样复述一遍」。
3. 预期：bot 复述内容以 `[anc:chat=<chatid> from=<userid>]` 开头；同一群多次一致，不同群 chatid 不同。
4. 反证：用 `restore.ps1` 重启后再发，前缀消失。

2026-10-31 的实际日志（已脱敏）：

```
[inject] env set: "OK:<pid>"
[pid <daemon>] preload active version=5.9.3
[pid <daemon>] INJECTED mode=hash target=...\main\wecomaibot-client.js
[pid <daemon>] APPLIED mode=hash
```

对应落盘 prompt：`<user_query>[anc:chat=<chatid> from=<userid>] …</user_query>`。

## 升级流程

1. WorkBuddy 升级 → 先按 `restore.ps1` 用原版跑一遍回归（T1–T5、T16、T17）；
2. 从新版 `app.asar` 取出 `main/wecomaibot-client.js`，算 sha256，更新 `manifest.json` 的 `workbuddyVersion` 与 `sha256`；
3. 重新跑一遍验证（本节第 1–4 步）；
4. 升级后若模块结构变了（导出名不再是 `t` / `WecomAiBotClient`），补丁会静默跳过——日志里只有 `SKIP`，此时按需改 `preload.cjs` 的取类逻辑，并把改动记进 §11。

## 已知限制

- **改动后行为**：这条能力不属于 WorkBuddy 的产品事实，只能写进 §11 台账，不能写进 §6。
- **只解决「群是谁」，不解决「消息是谁发的」之外的鉴权**：`from.userid` 是发送人，但桌面端没有发送人白名单（§6），权限仍靠群成员与可见范围。
- **Claw 共享会话**：所有 IM 渠道共用一个会话、一个工作目录；前缀能让模型分清当前群，但不同群的上下文仍在同一个会话里（T20/T22 要重新评估）。
- **前缀按消息注入**：不写进历史，所以会话压缩/重置不会把当轮前缀抹掉；但要防「模型拿旧轮次的 chatid 当当前群」，仍需按 T20/T22 验证 agent 始终以当轮前缀为准。
- **日志不含 ID**：`workbuddy-patch.log` 只记 `INJECTED`/`APPLIED`/`SKIP` 与版本，不记 chatid、不记消息内容。
- **依赖 node**：注入器要一个 node；优先用系统 PATH，找不到时用 WorkBuddy 自带的 `%USERPROFILE%\.workbuddy\binaries\node\versions\*\node.exe`。
- **inspector 短暂开启**：注入窗口只有启动那几秒，端口仅本机；放行后会尝试关闭（best-effort）。
- **仓库边界**：本目录只放清单、启动器与注入脚本骨架；任何反编译中间件、抓包原文放 `_research/workbuddy/`，不进 git。

## 待办

- 把 `chatid → 员工` 的映射接进本地小服务（SQLite 为真相），agent 只读前缀、不猜人；
- 与 T20/T22（会话压缩/重置）一起验证前缀是否始终在当轮上下文里。
