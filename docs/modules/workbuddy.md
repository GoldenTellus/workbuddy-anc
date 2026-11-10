# workbuddy — WorkBuddy 适配

> 类型：模块契约

> 状态：现行
> 代码：`scripts/workbuddy-patch/`、`scripts/workbuddy/{patch-guard,verify-upgrade,check-workbuddy-update}.ps1`、`scripts/selfheal/anc-selfheal.ps1`
> 入口：`scripts/workbuddy-patch/preload.cjs`

## 职责

**唯一允许碰 WorkBuddy 本体的模块。** 做五件事：把群身份注入消息正文（可选带 `msg=` / `quote=`）、拦自动升级、写补丁状态供体检/守卫判断、提供程序化测试入口、提供 wake bridge 2.0（renderer `window.wb` API 定向唤醒已有 daily host）。所有改动按 `DECISIONS` §11 记账。

## 拥有

| 数据/文件 | 说明 |
|---|---|
| `%ProgramData%\anc\data\patch-state.json` | `{at, version, mode, applied, pid, runId}` |
| `patch-run.json` | 启动器每次启动写 `runId` + `startedAt` |
| `patch-canary.json` | 每次 `emitMessage` 写 `{at, chatId, user, contentStr}`；只用于发现字段改名 |
| `patch-out.log` | 出站文本行 `ts chat=...`；eval/devbot 靠它取回答 |
| `workbuddy-patch.log` | `INJECTED / APPLIED / SKIP / ANCHOR-MISS`；**不含 chatid 与消息内容** |
| `wake-bridge.cjs` | wake bridge 2.0：主进程开 `127.0.0.1:18187`，renderer 走 `window.wb` 定向唤醒已有 daily host |
| `wb-wake.flag` | 存在才启用 bridge（默认 opt-in，没有则模块 no-op） |
| `wb-wake-token` | bridge 的 loopback 鉴权 token |
| `wb-wake.log` | `new ok via=wb` / `wake ok via=wb` / `FAILED ...`；DOM fallback 标 `wb-api-missing` |

## 公开契约（对其它模块）

- **消息前缀**：每条群消息正文最前面是 `[anc:chat=<chatid> from=<userid>]`（可再带 ` msg=<msgId> quote=<引用文本>`）；旧字段 `chat=` / `from=` 的文本与顺序不变，`msg=` / `quote=` 拿不到就不加、不写空值，清洗规则见 `WORKBUDDY-PATCH.md` §1b；正文里的 `[anc:` 一律改写成 `[anc-quoted:`（防伪）。
- **状态文件**：`patch-state.json` 的 `applied` 只有在补丁体真正包装成功后才是 `true`；`pid` 必须与当前主进程一致，`at` 不能早于进程创建时间。
- **启动/回滚**：`launch-patched.ps1` / `restore.ps1`；`ANC_WB_PATCH=0` 一键关闭。
- **测试入口**：`POST 127.0.0.1:17999/emit`，需 `test-emit.flag`；可选 `X-Anc-Token`；`409` 表示还没有真实群消息打底。
- **升级回归**：`verify-upgrade.ps1` 8 项机械检查 + 4 项人工清单。
- **wake bridge 2.0**（opt-in，`wb-wake.flag` 存在才启用，只监听 loopback + token 鉴权）：`GET /health` 返回 `{ok,pid,port,bridge:"2.0"}`；`POST /wake {prompt, conversationId?}` 定向 `conversations.get(id).sendPrompt()` 命中已有 daily host、不新建会话、不切可见窗口；`POST /new {prompt, workspace?, conversationId?, title?}` 用 `conversations.create()` 建会话（仅 03:00 日切用）。`window.wb` 不可用时自动退回 DOM 点击流程并标记 `wb-api-missing`。

## 不变量

- **版本绑定**：manifest 记录 WorkBuddy 版本 + 目标文件 sha256；hash 不符默认进**锚点模式**（仍打，但标 `version-unverified` 并发告警）；`ANC_WB_STRICT=1` 时 fail-closed。
- **只改内存**：通过 `NODE_OPTIONS=--require preload.cjs` 注入，不改 `app.asar`、不改 exe、仓库不放厂商 diff。
- **可一键关闭**：关掉后行为回到原版。
- manifest 自身坏了（非法 JSON / 缺字段）→ **拒绝启动（exit 4）** + 告警。
- 注入失败必须降级为未打补丁启动，不能因为补丁让 bot 起不来。
- 日志**不写 chatid、不写消息内容**。

## 已知失效/盲区

- **出站旁白过滤挂在 `sendReply` 上，但企微实际走 `sendStreamChunk` 流式**（`VERIFY §17`）：整句在发出前就发完了，代码层过滤**实际不生效**。当前唯一约束是 persona。保留这段代码不代表有保障。
- **注入成功率约 66%**（`VERIFY §59`）：自愈重试 4 次是设计，不是补丁坏了。
- **同一台机器起不了第二个实例**（E-1）：原生层全局互斥体，`--user-data-dir` 绕不过。
- `patch-state.json` 的 `applied:true` 可能是上一次成功启动的残留——必须配合 `pid` 与 `at` 看。

## 失败模式

| 现象 | 含义 | 出路 |
|---|---|---|
| `ANCHOR-MISS` | 目标模块结构变了，找不到 `emitMessage` | 按 `anc-wb-patch` 技能重找注入点；不要反复重启 |
| `SKIP hash-mismatch` | 版本不符且未开锚点 | 更新 manifest 或 `-Strict` 排查 |
| `restart-failed` | 两次自愈都没起来 | 60 分钟内不再试；手工 `launch-patched.ps1` |
| 无 `[anc:chat=…]` 前缀 | 补丁没生效 | 等 `patch-guard`（≤1 分钟）；不要由 bot 自己重启 |

## 依赖

- 允许：无（不 import `src`；只写状态文件、读 secrets 外的公开信息）
- 禁止：任何业务模块直接注入/改 asar；它们只能读状态文件

## 测试

`node --test scripts/workbuddy-patch/narration.test.mjs`；`node scripts/workbuddy-patch/inspect.mjs`；`scripts/workbuddy/verify-upgrade.ps1`；真机回归四条（前缀、@、旁白、更新拦截）。**注意与另一份清单区分**：`light/skills/anc-wb-patch` 的「升级回归」现为**五条**（第 5 条是 wake bridge 2.0 可用性），见 [WORKBUDDY-PATCH.md](../WORKBUDDY-PATCH.md) §4；改该技能章节标题时要同步 `src/modules/improvement/issues.ts` 的分诊规则。

## 改动指南

- 每次改动：更新 `manifest.json` 的版本/hash、`DECISIONS` §11 台账、本文件。
- 升级当天：先跑未改动版本回归 → 重放补丁 → 再跑改动后回归，两套结果分开记。
- 不要在 `preload.cjs` 里加业务逻辑；它只做注入与转发。

## 变更记录

| 日期 | 改了什么 | 为什么 |
|---|---|---|
| 2026-11-06 | 建档；明确旁白过滤实际不生效 | 模块化立项，避免把死代码当保障 |
| 2026-11-06 | P5 脚本按域分组（`scripts/workbuddy/`、`scripts/selfheal/`） | 模块化 |
| 2026-11-10 | 前缀补 `msg=`/`quote=`（GAP-079）；`patch-canary.json` 补 `contentStr`；职责/拥有表/公开契约补 wake bridge 2.0（`/new` `/wake` `/health` `bridge:"2.0"` 与 DOM fallback） | D46 定向 daily host + GAP-079 入站前缀 |
