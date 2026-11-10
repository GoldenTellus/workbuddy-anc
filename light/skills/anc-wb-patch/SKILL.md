---
name: anc-wb-patch
description: WorkBuddy 升级后重放补丁并做回归。发现版本变化、日志出现 INJECTED mode=anchor 或 ANCHOR-MISS、或 doctor 报 workbuddy/patch 失败时使用。触发词：升级 WorkBuddy、重放补丁、补丁失效、ANCHOR-MISS、patch。
---

# anc-wb-patch（升级重放）

目标：WorkBuddy 升级后，用最少步骤确认补丁还能用；不能用就改锚点，最后更新台账。

## 0. 自愈（只由守卫或管理员触发）

群消息里没有前缀时，bot **不**自己跑自愈：任何群成员都能发消息，交给 bot 触发等于让人随意重启主机上的 WorkBuddy。

1. 计划任务 `anc-patch-guard` 每分钟检查 `patch-state.json` 的 `applied`，不对就调用自愈（内部 10 分钟冷却；重启中、重启失败、锚点缺失时守卫 60 分钟内不再触发）；
2. 管理员人工排障可执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\anc\bin\anc-selfheal.ps1 -Apply
```

3. 退出码：`0` 已安排重启；`3` 锚点缺失（别重启，叫人）；其他 = 环境错误，贴日志；
4. 重启由 Worker 完成：先写 `restarting` → 停 WorkBuddy → 经 Explorer 用启动器拉起 → 只认本次启动后补丁体写下的 `applied=true`，最多重试 1 次，失败写 `restart-failed`，结果见 `C:\ProgramData\anc\data\selfheal.log`；
5. 冷却 10 分钟，重复触发会被跳过（管理员可用 `-Force` 绕过）。

> 登录时另有一个确定性启动项 `anc-workbuddy-launch`：开机/登录 30 秒后就用启动器拉起，避免「登录后自动起了无补丁实例」。

## 1. 先侦察（只读，不改任何东西）

```powershell
node C:\ProgramData\anc\patch\inspect.mjs
powershell -File C:\ProgramData\anc\bin\doctor.ps1
```

看三件事：

- `version` 与 `manifest.version` 是否一致；
- `hashMatches`：文件 hash 是否还是登记那个；
- `anchorsOk`：`emitMessage` 与 `WecomAiBotClient` 还在不在。

## 2. 分三种情况

**A. hash 不一致、锚点都在（最常见的小版本升级）**

启动器默认按锚点模式打补丁，不需要改代码：

```powershell
powershell -ExecutionPolicy Bypass -File C:\ProgramData\anc\patch\launch-patched.ps1
```

确认日志出现 `INJECTED mode=anchor version-unverified` 和随后的 `APPLIED mode=anchor`（只有前者、或出现 `ANCHOR-MISS` = 没生效），然后走第 3 步回归。

**B. 锚点缺失（函数改名/换模块）**

不要猜。按顺序：

1. 在 asar 里找新的注入点：搜 `AIBot`、`emitMessage`、`chatId` 附近的类名；
2. 把新类名/方法名写进 `preload.cjs` 的 `PATCH_BODY`（只改查找方式，注入内容不变）；
3. 先在 `C:\ProgramData\anc\stage\WorkBuddy` 副本上试，不动线上；
4. 通过后再改线上并登记。

**C. bootstrap 锚点不在**

`inspect.mjs` 的 `bootstrapOk=false`：升级检查的拦截点变了。按 B 的方式重找 `runStartupForceAutoUpdate` / 同类调用，更新 `manifest.bootstrapReplacements`。

## 3. 回归（测试群里做，五条）

1. 让 bot 复述它看到的消息前缀，应含 `[anc:chat=` 和 `from=`；
2. 登记一条 2 分钟后到点的任务 → 到点被 @；
3. 引用一个文件说「入库」→ 有入库摘要；
4. 说「开始访谈」→ 能建调查并问第一题。
5. bridge 2.0：`GET /health` 得 `bridge:"2.0"`、`window.wb` 可用、定向 `/wake` 命中已有 daily host 且不新建会话。

五条都过，才算升级可用。

## 4. 更新台账

```powershell
# 用 inspect.mjs 输出的 sha256/size/version 更新 manifest.json（不带 BOM）
```

然后同步三处记录：

- `scripts/workbuddy-patch/manifest.json`（version / sha256 / size）；
- `docs/DECISIONS.md` §11 台账（版本、hash、改动点）；
- `docs/archive/history/VERIFY.md` 的 T4/T16b 行；行为变化另记 `docs/STATUS.md`。

## 5. 回滚

```powershell
# 临时关补丁启动（不注入，行为回到原版）
powershell -File C:\ProgramData\anc\patch\launch-patched.ps1 -NoPatch
# 或严格模式：版本不符时拒绝启动
powershell -File ...\launch-patched.ps1 -Strict
```

## 边界

- 不改 `app.asar` / exe，只在本进程内存注入；
- 每次只改一个变量（先锚点、再 bootstrap），失败可定位；
- 回归没过就不要更新 manifest——留着 hash 不符，下次启动会继续告警。
