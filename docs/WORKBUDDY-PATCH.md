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

## 群绑定表（chat_bindings）

> 这一节原先是独立的 `docs/CHAT-BINDINGS.md`，2026-11-05 并进来 —— 它和「群身份注入」是同一件事的两半：
> 补丁负责**把 chatid 塞进消息**，这张表负责**把 chatid 翻成人**。拆两份会让人来回跳。

### 为什么要有这张表

agent 在消息开头能看到 `[anc:chat=<chatid> from=<userid>]`（D17 的注入），但**它不该自己记住谁是谁** —— 名单是易变事实，模型记不住也不该记。

所以把「chatid → 员工」放进本地 SQLite 当真相；agent 只负责把前缀里的 chatid 拿来查，不在上下文里存名单。

### 表结构

```sql
-- 真实定义见 src/service/bindings.ts; 默认库 %ProgramData%\anc\data\anc.db
CREATE TABLE IF NOT EXISTS chat_bindings (
  chat_id      TEXT PRIMARY KEY,
  employee     TEXT NOT NULL,
  userid       TEXT,              -- 企微 userid（wokc… 形态）；一人一群时可空
  webhook_file TEXT,              -- secrets 目录下的文件名，如 test2-webhook.txt
  note         TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
```

**这两列容易被文档漏掉**（2026-11-05 前的 `CHAT-BINDINGS.md` 就漏了 `userid` / `webhook_file`）：

- `userid`：企微的员工 userid。`resolveByUserid()` 靠它做「交办人的通知发到交办人的群」。
- `webhook_file`：每群一个 webhook 文件。`loop.ts` 按它选文件发提醒，**没登记就发不出去**（`doctor` 的 `bindings` 那一项查的就是这个）。

约束：

- 一个人一个群（D7），正常情况下 `employee` 唯一；表本身不强制，方便临时一人多群。
- `webhook_file` 只接受 `secrets` 目录下的文件名（字母数字 `._-`，以 `.txt` 结尾），防止路径穿越。
- schema 由 `scripts/anc-bind/bind.mjs` 或本地小服务建，重复执行安全（`CREATE TABLE IF NOT EXISTS`）。

### 用法

```powershell
# 建群时绑定（管理员执行）
node scripts\anc-bind\bind.mjs bind --chat-id <chatid> --employee <姓名>

# 带 userid 和 webhook（实际部署都需要）
node scripts\anc-bind\bind.mjs bind --chat-id <chatid> --employee <姓名> --userid <wokc…> --webhook-file test2-webhook.txt

# 查
node scripts\anc-bind\bind.mjs resolve --chat-id <chatid> --json

# 改绑（员工换群 / 离职交接）
node scripts\anc-bind\bind.mjs bind --chat-id <chatid> --employee <姓名> --note "2026-11 换人"

# 解绑 / 列表
node scripts\anc-bind\bind.mjs unbind --chat-id <chatid>
node scripts\anc-bind\bind.mjs list
```

退出码：0 成功 / 1 查不到（`resolve`）/ 2 参数或环境错误。支持 `--json`。

测试：`node --test scripts/anc-bind/bind.test.mjs`。

### 谁写、什么时候写

- **只允许管理员写**：绑定发生在建群那一步（一人一群），或离职交接时由管理员改。
- 员工和 agent 都不能改这张表；agent 只读。
- 绑定口令方案（管理员在群里发一句、bot 记住）**不再使用** —— 那是 T16 不通过时的退路，现在有 chatid 就不需要了。

### agent 侧怎么用

1. 每轮消息开头有 `[anc:chat=<chatid> from=<userid>]`；
2. persona 规则：**先拿 chatid 查绑定表，查到再按员工走**；查不到就按「未绑定的人」处理，不猜；
3. 具体查法在本地工具/技能里实现（读这张表或调本地小服务的接口），不在 prompt 里塞名单。

### 隐私与边界

- chatid、userid 都是标识符，不是凭据；库只在本机，`*.db` 不入 git。
- 日志里不写 chatid：`workbuddy-patch.log` 只记 `INJECTED`/`APPLIED`/`SKIP`。
- 与 D13/D14 一致：原件与敏感数据不进 git；绑定表属于内部区数据，转公开前确认不在仓库里。

---

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

**2026-11-06 起，注入结果是可判的**（`VERIFY §86`）：
- 启动器每次启动写 `patch-run.json`（`runId` + `startedAt`）；`preload.cjs` 把 `runId` 带进 `patch-state.json`；
- 放行后由 `scripts/workbuddy-patch/wait-patch-state.ps1` 校验 `runId` / 时间窗 / pid，超时明确输出 `[anc] 注入没成功：<原因>` 并回写 `applied=false`，不再留「自己去看日志」的含糊结论；
- 旧版 preload 不写 `runId` 时，等待脚本用「状态时间晚于本次启动」兜底，兼容升级窗口。

部署到主机时，把 `launch-patched.ps1` 放进专用用户的启动项或计划任务（登录时运行），不要手改 WorkBuddy 本体。

## 验证

1. 启动后看 `%USERPROFILE%\anc\workbuddy-patch.log`：应有 `preload active`、`INJECTED mode=hash target=...wecomaibot-client.js` 与 `APPLIED mode=hash`。
2. 在任何员工群 @ 公司 bot 发一句「把你收到的这条消息原样复述一遍」。
3. 预期：bot 复述内容以 `[anc:chat=<chatid> from=<userid>]` 开头；同一群多次一致，不同群 chatid 不同。
4. 反证：用 `restore.ps1` 重启后再发，前缀消失。
5. 注入没成功时看启动器输出：`[anc] 注入没成功：…` 会直接给出原因（陈旧状态 / runId 不符 / 无 state 文件 / pid 已退出）。

**test-emit 测试入口的两个开关**：`test-emit.flag` 决定下次启动要不要开 17999；
同目录 `emit-token.txt` 存在时 `/emit` 要求 `X-Anc-Token`（常量时间比对，不建文件则维持「能连本机就能发」）；
隔离验证用 `ANC_EMIT_PORT` 换端口，避免注入到在跑部署。见 `docs/OPS.md`「程序化测试入口」。

2026-10-31 的实际日志（已脱敏）：

```
[inject] env set: "OK:<pid>"
[pid <daemon>] preload active version=5.9.3
[pid <daemon>] INJECTED mode=hash target=...\main\wecomaibot-client.js
[pid <daemon>] APPLIED mode=hash
```

对应落盘 prompt：`<user_query>[anc:chat=<chatid> from=<userid>] …</user_query>`。

## 升级流程

升级前后都跑一次 `scripts\verify-upgrade.ps1`：8 项机械检查（版本/hash/锚点/bootstrap/applied/update-hook/doctor）应全 PASS；它判不了的 4 项（前缀、@、旁白过滤、更新拦截）会打印成人工清单。

1. WorkBuddy 升级 → 先按 `restore.ps1` 用原版跑一遍回归（T1–T5、T16、T17）；
2. 从新版 `app.asar` 取出 `main/wecomaibot-client.js`，算 sha256，更新 `manifest.json` 的 `workbuddyVersion` 与 `sha256`；
3. 重新跑一遍验证（本节第 1–4 步）；
4. 升级后若模块结构变了（导出名不再是 `t` / `WecomAiBotClient`），补丁会静默跳过——日志里只有 `SKIP`，此时按需改 `preload.cjs` 的取类逻辑，并把改动记进 §11。

### 5.1 自愈链路（2026-11-03 实测摸清）

补丁不是"启动了就有"，是**三层接力**兜住的：

```
anc-patch-guard（每分钟）
  ├─ 维护开关 maintenance.flag 存在 → 退出（升级/排障期间不抢）
  ├─ 找主进程（WorkBuddy.exe 且命令行不含 --type= / --daemon-app-serv）
  ├─ 没在跑 → anc-selfheal.ps1 -Apply（10 分钟冷却）
  └─ 在跑 → 判断补丁是否"对得上"
        applied=true 且 patch-state.at >= 主进程创建时间 - 15 秒
        ├─ 对上 → 退出
        └─ 对不上 → anc-selfheal.ps1 -Apply

anc-selfheal.ps1
  ├─ 经 explorer.exe 启动 launch-patched.ps1        ← 关键，见下
  ├─ 等补丁日志出现 INJECTED / APPLIED
  └─ 两次都没见到 → 写 restart-failed + 发群告警

launch-patched.ps1
  └─ WorkBuddy.exe --inspect-brk=PORT → inject.cjs 注入 NODE_OPTIONS → 放行
```

四条冷却 / 避让规则（防止"每分钟拉一次进程"把机器拖死）：

| 规则 | 值 | 目的 |
|---|---|---|
| guard 自己记的拉起时间 | 3 分钟 | 别在自愈还没跑完时重复触发 |
| selfheal 冷却 | 10 分钟 | 两个任务各自独立，冷却要写两边 |
| blocked 状态 | 60 分钟 | 已判定「修不了」（`anchors-missing` / `inspect-failed`）时不再拉进程 |
| canary 避让 | 2 分钟 | 最近有人在对话就不重启，等下一分钟的空档 |

**★ 必须经 Explorer 启动，不要直接 Start-Process**

`anc-selfheal.ps1` 第 94 行的注释：

> 经 Explorer 启动：与人工双击/relaunch.cmd 的路径一致，**避免直接 Start-Process 导致的提前退出**

**这是 2026-11-02 排障踩坑的根因**：用 `Start-Process WorkBuddy.exe` 反复试，主进程被放行后立即 `exit 0`、不 fork 子进程，看起来像"补丁把 WorkBuddy 弄崩了"。实际是**启动方式**的问题。

**结论：手工排障要用 `launch-patched.ps1`，或者等 `patch-guard` 自己补（最多 1 分钟）。**

### 5.2 注入是三态，不是"成功/失败"（2026-11-03 实测）

| 状态 | 触发条件 | 行为 | 告警 |
|---|---|---|---|
| `mode=hash` | 目标文件 sha256 与 manifest 一致 | 精确匹配后打补丁 | 无 |
| **`mode=anchor`** | hash 不匹配但**结构锚点在**（`prefix = "[anc:chat="` 等） | **降级**：按锚点照样打，标 `version-unverified` | **发**（"版本变化，请回归后更新 manifest"） |
| 失败 | hash 不匹配**且**锚点不在 | 两次自愈都失败 → `restart-failed`，60 分钟内不再试 | 发（"自愈重启失败"） |

**为什么这层重要**：升级后目标文件 hash 必变。没有 `mode=anchor`，每次升级都会掉线直到人工更新 manifest；有了它，升级后的表现是"降级可用 + 一条告警"。

**R7 验证时要看的是告警到没到、回归过没过，不是"补丁掉没掉"。**

实测方法：把 `manifest.json` 的 `sha256` 改成全零 → 走 `mode=anchor` + 发 ALERT + `APPLIED mode=anchor`。
（第三态"锚点也不在"未单独制造故障，它发的告警走同一套 webhook，第二态已证明通路可达。）

### 5.3 doctor 查不到的一件事

`deploy-layout` 只比**部署目录 vs 仓库**，不比**运行时 vs 部署目录**。

所以会出现：部署是新的、仓库是新的、**但正在跑的进程加载的是更早的版本**。

判断运行时版本的唯一可靠办法：看 `patch-state.json` 的 `at` 与主进程创建时间——`at` 早于进程创建，说明跑的是更早的内容，需要重启才加载新部署的那版。

另外 `deploy.ps1` **不清理仓库里没有的多余文件**：换分支或回退后，旧模块会残留在 `%ProgramData%\anc\service\`。`doctor` 查不出（它只查"仓库的文件部署了吗"）。清理时先确认仓库代码没有引用它们。

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

## 手段清单（FORK D26：闭源不构成排除理由）

WorkBuddy 闭源，但**这不是"做不到"的理由**。下面这些手段本项目都在用或可按需取用，全部由 D16 授权：

| 目标 | 手段 | 位置 / 状态 |
|---|---|---|
| 拿群身份与发送人 | 在 `_compile` 里包 `emitMessage`，往正文注入 `[anc:chat=… from=…]` | `preload.cjs`，**在跑**（D17） |
| 拿出站文本 | 包 `sendReply(chatId, text)` | `preload.cjs`，**在跑**（出站过滤挂这） |
| 拦自动升级检查 | 劫持 `https.request` 匹配 `/v2/update` | `preload.cjs`，**在跑**；**注意它会让 Electron 主进程崩**，已加进程守卫（`process.type === "browser"` 时直接返回） |
| 驱动 UI（切工作区、点按钮） | CDP / UIA | 已验证（T6 / T13 / R6） |
| 看内部结构 | `app.asar` 解包 + 反编译 + `Module._compile` hook 观察 | D16 允许，按需 |
| 换模型后端（Harness 可换） | 拦模型调用层 → 改端点 / 模型名 → 转发 | **不做**（2026-11-03 裁决：单引擎部署下是负担不是能力，论证见 `UPSTREAM-COVERAGE` §3.2）。手段留着，形态变了再用 |
| 进程 / 服务级 | 计划任务、服务配置、注入 inspector（`--inspect-brk` + `inject.cjs`） | 已在用 |

**默认动作**：遇到做不到，先想"能不能**加一层**"，而不是降级需求。

**代价写清**：每加一层都要按 `FORK §11` 登记目标版本 / hash，随 WorkBuddy 升级重放（R7），并可一键关闭。
**不是不做，是做了要维护**——真正的风险是"忘了它存在"（见 `VERIFY §16`：`patch-state.json` 的 `applied:true` 长期是上一次成功启动的残留）。
