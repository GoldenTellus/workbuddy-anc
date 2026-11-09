# 1.0 发布前检查清单

> 类型：发布门禁（现行）

> **2026-11-08 起**：本清单仍是 1.0 的发布门禁；**2026-11-09 主干 0 收口**后，当前主干发布前还必须跑 `STATUS §3.5` 的 **ACC-01..12**（四类群/角色/两阶段任务/隐私/部署/executor）。本地测试通过不能代替真实验收。

> **读者是 agent，不是人。** 每一项都有可执行的判据；判据不成立就停在这一项，不要往下走。
>
> 为什么要这份东西：`docs/archive/history/ACCEPTANCE.md` 回答的是「功能做到了没」，这份回答的是
> 「**这东西能不能拿去发布**」。后者包含前者，但多了一整套「代码自己能不能做到」的检验。
>
> 背景见 [VERIFY §65](./archive/history/VERIFY.md)（2026-11-05 第一次发布前审计）。

---

## 主干 0 发布门禁（2026-11-09 收口）

> 本表是**当前主干（主干 0）**的发布门禁。下面「阶段 A–D」是 1.0 的历史记录，保留作参考。
> 数字全部取自 2026-11-09 本机实测；原始证据在 `.workbuddy/verify/`（该目录不进 git）。

| 门禁项 | 判据 | 本机实测（2026-11-09） |
|---|---|---|
| 测试 | `npm test` **238/238**，连跑 3 次不挂起 | ✅ 最近一次 238/238、0 fail（单次约 44 s） |
| 静态检查 | `npm run check`（`check:modules:deep` + `check:docs`） | ✅ 通过（13 模块边界干净 + 40 份 Markdown 检查） |
| 密钥扫描 | `node scripts/checks/check-public.mjs` | ✅ 零输出、exit 0 |
| 计划任务 | **13 个**全部 Ready/Running，principal 正确 | ✅ 13/13（9 LOCAL SERVICE / 1 SYSTEM / 3 交互，`anc-http` Running） |
| 部署 | `deploy.ps1` dry-run 无未归属文件；`deploy-verify.ps1 -Side company` | ✅ **138 文件**；`ok:true pass=4 fail=0 skip=1`（`bot-reply` 因无群 SKIP） |
| 体检 | `doctor` **FAIL=0** | ✅ **34 项**，FAIL=0 WARN=3（`work-hours` / `patch` / `bindings`；`canary` 15:38 收到首条真实消息后 PASS） |
| 补丁 | `patch-state.json` `applied=true` 且 pid 活着 | ✅ `applied=true mode=hash pid=24140`（WorkBuddy 5.9.3） |
| ACC 判定 | `STATUS §3.5` 的 **ACC-01..12 如实判定**：未跑就是未达成，`SKIP` 不是通过 | ✅ ACC-07/09/10/11 本机达成；ACC-02/03/04/05/06/12 用户实测通过（口述，无机器日志，D35）；ACC-08 人工对账书面例外（D36）；备份恢复通过 |
| 主干 0 收口 | 8 分支设计/实现/验收、ACC 全部通过或书面例外、文档联动、门禁 | ✅ 2026-11-09 收口；快照 `docs/archive/plans/TRUNK-0-20261109.md`；正式对外发布仍由用户决定 |

**发布结论（2026-11-09）**：主干 0 已收口（ACC 全部通过或书面例外）；本表面向正式对外发布，仍需用户确认后再放行。**主干 0 已完成，正式发布待定。**
**不得把未跑写成通过**——`deploy-verify` 的 SKIP 只能记「未验」，验收项的判定以 `STATUS §3.5` 为准。

---

## 阶段 A：补代码缺口（不用清空，本机就能做）

### A1 `deploy.ps1` 补 ACL —— **最高优先**  ← **✅ 2026-11-05 已完成**（`VERIFY §66`）

> **做法与下面这段不同**：最终没有把 `icacls` 写进 `deploy.ps1`，而是新建了独立的
> [`scripts/deploy/set-acl.ps1`](../scripts/deploy/set-acl.ps1)（默认 dry-run，`-Apply` 落盘，`-Side employee` 跳过），
> 再由 `deploy.ps1`（L113-125）与 `rebuild-z.ps1`（L46）调用它。原因有两个：
> ① `deploy.ps1` **根本不建** `secrets`/`data`（建它们的是 `rebuild-z.ps1`），所以接入点必须是两处；
> ② 自检不该自己写判据 —— `set-acl.ps1` 直接跑 `doctor.ps1` 的 `secrets-acl`/`data-acl` 两项（那两项是双向的、刚实测过）。
>
> **下面这几段保留作参考**（手工救急时用），但注意：**已全部改成 `/grant:r`** ——
> 原来的 `/grant` 会线性追加 ACE，这台机器上已经出现 4 个日志各 2 条 `LOCAL SERVICE:Modify` 的痕迹。


**问题**：`scripts/deploy.ps1` 里 `icacls` 一处都没有，而 `doctor` 的绿有 5 处靠手工敲。

**要补的 5 处**：

```powershell
# ① secrets 目录：只服务身份 + 管理员可读，不给广泛组
icacls "$Root\secrets" /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' 'LOCAL SERVICE:(OI)(CI)RX'

# ② secrets 的每个文件（不能只设目录——文件有自己的 ACL）
Get-ChildItem "$Root\secrets" -File | ForEach-Object {
    icacls $_.FullName /inheritance:r /grant:r 'SYSTEM:F' 'Administrators:F' 'LOCAL SERVICE:RX'
}

# ③ data 目录：服务身份要能写（loop.log / http.log / patch-*.log 都在这）
icacls "$Root\data" /grant 'LOCAL SERVICE:(OI)(CI)M'

# ④ 已存在的日志文件（独立 ACL，不继承目录）
foreach ($f in 'loop.log','http.log','patch-in.log','patch-out.log','selfheal.log','audit.log') {
    $p = Join-Path "$Root\data" $f
    if (Test-Path $p) { icacls $p /grant 'LOCAL SERVICE:(M)' }
}
```

**判据**：

```powershell
# 服务身份在 secrets 上要有读；在 data 与 6 个日志文件上要有写
(Get-Acl "$Root\secrets").Access | Where-Object { $_.IdentityReference -match 'LOCAL SERVICE' }   # 期望 ≥1 条
(Get-Acl "$Root\data").Access    | Where-Object { $_.IdentityReference -match 'LOCAL SERVICE' }   # 期望含 Modify/Write
# 且不能有 Everyone / BUILTIN\Users / Authenticated Users
(Get-Acl "$Root\secrets").Access | Where-Object { $_.IdentityReference -match 'Everyone|BUILTIN\\Users|Authenticated' }   # 期望空
```

**为什么不能用替代身份**：`anc-service` / `anc-http` / `anc-backup` **全部跑在 `LOCAL SERVICE`**。
判据里如果允许 `SYSTEM` 顶替，就会在「删掉 `LOCAL SERVICE`」时照样 PASS（这个错犯过一次，见 `VERIFY §63`）。

### A2 生成 lockfile + 跑依赖审计  ← **✅ 2026-11-05 已完成**（`VERIFY §67.1`）

> **结果**：`package-lock.json` 13 行 / 254 B，`npm audit` 0 漏洞。
> **口径**：`package.json` 里**根本没有** `dependencies` / `devDependencies` 字段 ——
> `src` 与 `scripts` 里 122+37 处 import 全是 `node:*` 内置或相对路径。
> 所以「0 漏洞」= 「**零第三方依赖**」，不是「依赖都干净」。
> **以后加任何 dep，A2 必须重跑** —— 现在的 0 是真空，不是通过。


```powershell
npm i --package-lock-only          # 仓库现在没有 lockfile，npm audit 直接用不了（ENOLOCK）
git add package-lock.json
npm audit                          # 有 high/critical 就处理
```

**判据**：`npm audit` 能跑通（不再 ENOLOCK），且 high/critical 为 0 或已记录处置理由。

### A3 加覆盖率  ← **✅ 2026-11-05 已完成**（`VERIFY §67.2`/`§67.3`）

> **结果**：行 **93.14%** / 分支 **78.75%** / 函数 **95.79%**（只统计被加载的 23 个文件）。
> `package.json` 加了一行 `coverage` 脚本，别的没动。
>
> **但这个数字会骗人** —— 见下面的 A5：有 1555 行代码从来没被加载过，不在那张表里。
> **2026-11-06 现值**：`npm run coverage` 行 **91.34%** / 分支 81.34% / 函数 93.68%（`VERIFY §87`）；`--test-coverage-exclude` 已排除仓库外 WorkBuddy shim。发布评审用现值，不要用本节的历史读数。

### A5 补 service CLI 的测试盲区 —— **发布前唯一必须补的测试**  ← **✅ 2026-11-05 已完成**（`VERIFY §69`）

**问题**（`VERIFY §67.3`）：**7 个产品文件、1555 行、占 `src` 非测试 .ts 的 35.7%，从未被执行过**：

```
src/service/cli.ts            588 行
src/service/patch-drafts.ts   260
src/service/eval.ts           216
src/service/issues.ts         179
src/service/submissions.ts    111
src/ingest/cli.ts             109
src/service/dayend.ts          92
```

**原因**：这些只被 `src/service/cli.ts` import，而**没有任何测试 spawn 过 service CLI**
（`cli.smoke.test.ts` 只 spawn `src/render/cli.ts`）。

**这 1555 行是什么**：L 阶段迭代闭环的执行体（`dayend` / `eval` / `issues` / `patch-drafts` / `submissions`）。
它们只靠 `e2e-loop.ps1` 与 `fault-inject.mjs` 验过（`§21`–`§27`）——
**功能是通的，但改一行就可能坏而没人知道**。这是回归风险，不是功能缺失。

**要做的**：照 `src/render/cli.smoke.test.ts` 的写法，加一个 `src/service/cli.smoke.test.ts`：
用 spawn / execFile 跑一次真实子进程，只碰**只读**子命令（list / show / status），不要写库。
目的是让那 7 个文件被 Node 加载进覆盖率统计。

**判据**：

```powershell
npm run coverage     # 那 7 个文件从「不在表里」变成「在表里且有行覆盖」
npm test             # 历史读数：当时是 155 项 0 fail（§87 补测后；不能把原有测试弄坏）；2026-11-09 为 217/217
```

**同时修两个分测脚本的漏**（`VERIFY §67.4`）：

| 脚本 | 补什么 |
|---|---|
| `test:service` | `deploy-state` / `http` / `project` 三个 test |
| `test:render` | `dept.test.ts` |

因为主 `test` 跑的是 17 个文件全集（**历史读数：当时 155 项是全的**；2026-11-09 为 25 个测试文件、217 项），但**分开跑会漏**。


```json
// package.json scripts 里加
"coverage": "node --experimental-test-coverage --test test/"
```

**判据**：跑出真实的 line/branch 覆盖率数字，写进本文档。**没有这个数字，就不知道这 155 项测试（历史读数；2026-11-09 为 217 项）护住的是核心还是边角。**

### A4 错误路径测试  ← **✅ 2026-11-05 完成**（`VERIFY §71`，4/5 通过 + 1 项无结论）

| 场景 | 怎么造 | 期望 |
|---|---|---|
| 磁盘满 | 建一个配额很小的临时卷，或塞满 | 写日志/写库失败要**报出来**，不能静默 |
| 文件被占用 | 用另一个进程独占 `anc.db` | 服务给出可读错误，不崩 |
| SQLite 锁 | 两个进程同时写 | 一方等锁/报错，不产生脏数据 |
| 并发写 | 并行跑 20 个 `cli.ts task add` | 全部成功，无丢写 |
| 日志 0 字节 | 把 `loop.log` 置空后再 tick | 正常追加，不丢格式 |

---

## 阶段 B：证明「代码能自己修回来」  ← **✅ 2026-11-05 通过**（`VERIFY §70`）

**这一步之前从没做过，是发布前最重要的一次验证。**

**做法**：

```powershell
# 1) 把手工补的 ACL 全删掉（模拟「刚部署完、还没人手工修」的状态）
icacls "$Root\secrets" /remove:g 'LOCAL SERVICE' /T
icacls "$Root\data"    /remove:g 'LOCAL SERVICE' /T

# 2) 确认它确实红了
powershell -File "$Root\bin\doctor.ps1" -Repo <仓库> -Json | ConvertFrom-Json |
  Select-Object -ExpandProperty checks | Where-Object state -eq 'FAIL'

# 3) 跑 deploy.ps1（不带任何手工步骤）
powershell -File scripts\deploy.ps1 -Side company

# 4) 再跑 doctor
```

**判据**：

| 结果 | 含义 |
|---|---|
| `doctor` 回 `fails=0` | **A1 补对了** —— 别人也能装成 |
| 还红 | A1 没补全，回去补。**只有这样清空重装才有意义** |

**2026-11-05 实测结果**（`VERIFY §70`）：

| 判据 | 结果 |
|---|---|
| 删掉 ACL 后 `doctor` 会红 | **✅ 红 2 项**（`secrets-acl` / `data-acl`） |
| **`set-acl.ps1 -Apply -SkipVerify` 能修回来** | **✅ 7.6 秒，`doctor` 回 `fails=0`** |
| `deploy.ps1 -Apply` 能完整跑完 | **✅ 8.4 秒，73 个文件 + ACL 全部就绪** |
| 修完后机器状态正常 | **✅ `ok=True fails=0 warns=1`，`deploy-layout`/`patch` 全 PASS** |

**顺带修了一个真 bug**：`deploy → set-acl → doctor` 三层嵌套会卡死 180 秒，
已加 `-SkipVerify` 打破（`set-acl.ps1` 不再 spawn doctor）。

**修了一个插入位置 bug**：ACL 块曾被误插进 `Copy-WithRetry` 的 `for` 循环里，
导致 73 个文件 × 3 次重试 ≈ 219 次 `set-acl`（约 25 分钟）。已移到函数外，实测 8.4 秒。

**所以 C 阶段的前置条件已满足**：A 全绿 + B 通过。

---

## 阶段 C：清空重装（真机）  ← **✅ 2026-11-05 11/11 完成**（`VERIFY §72`–`§75`）

**前置**：阶段 A 全绿 + 阶段 B 通过。

```
① 备份 secrets / D:\anc 的两个 git 仓库 / org                    ✅ 2026-11-05 12:03（`VERIFY §72`）
② ★ 把 5.9.3 缓存包复制一份到 E:\ 当「回程票」                  ✅ 2026-11-05（sha256 一致）
③ 清空（prepare-wipe.ps1 -Apply）                              ✅ 2026-11-05 12:11，33.5 秒（`§73.1`）
④ ★★ 确认 hosts 已阻断更新域名（**不要断网**）                ✅ 已验（`§72.6`）
⑤ 装 5.8.3                                                    ✅ 93 秒，必须 /S /currentuser（`§73.2`）
⑥ ★★ 立刻落地冻结三件套                                      ✅ 日志双重验证（`§73.3`）
⑦ 在 5.8.3 上跑 REBUILD + 计时                                ✅ 9/11，~4 分钟，4 个卡点（`§74`）
   ✅ 补丁确实失败：注入成功但 daemon 不继承 NODE_OPTIONS（§74.3）
⑧ 记录 5.8.3 基线                                             ✅ BASELINE-583-REBUILD-130732.txt
⑨ 恢复升级：缓存包放回 + 开关开启                              ✅ 106 秒静默装到 5.9.3（`§75.2`）
⑩ 验：数据完整 + 补丁自动重新注入                              ✅ 4/4 hash 一致；applied=true mode=hash pid 活
⑪ 修 ⑦ 记下的红，再验一次                                      ✅ 修掉瞬态 fail 锁死自愈（`§75.3-75.5`）
```

### C 阶段两个必须知道的机制（`VERIFY §68`）

**① 5.9.3 装包就在本机，升级不需要网络**

```
%TEMP%\workbuddy-update-x64\WorkBuddy-Setup-5.9.3.42398134.exe
  429.3 MB · FileVersion 5.9.3 · Authenticode Valid (Tencent)
  sha256 B5EDB52B...852F9 = 更新 feed 返回的 sha256hash，字节级一致
```

5.9.3 换过缓存目录名（现在是 `workbuddy-update-x64-workbuddy`，为空），扫不到旧目录，
所以这个包活到今天。**反过来：5.8.3 扫的正是旧目录** —— 装回 5.8.3 后，
它会在启动几秒内认领这个包**离线**升回 5.9.3。

**这就是「5.8.3 会自己升级」的真正原因，也是 R7 可以完全离线、几秒完成的原因。**

**② 冻结自升级必须三件一起做**

| # | 做什么 | 拦什么 |
|---|---|---|
| **a** | `%USERPROFILE%\.workbuddy\app\app-config.json` 加 `"startupForceAutoUpdate": false` | 只拦自动**装** |
| **b** | 移走 `%TEMP%\workbuddy-update-x64\WorkBuddy-Setup-5.9.3.*.exe` | 断掉「几秒内认领旧包」 |
| **c** | hosts 加 `127.0.0.1 www.workbuddy.cn` + `copilot.tencent.com`（或 `update-endpoint.json` 指空） | 让 `checkForUpdates` 连不上 → 不下载 |

**只做 a 不够** —— 拦不住 30 秒/每小时的 `checkForUpdates`，那仍会把 429 MB 下到 `ready`。

**最省事：装之前先做 hosts 阻断（两行）+ 移走缓存包** —— **不要断网**，见 `VERIFY §72.6`。

**不要靠补丁的 update-hook 拦升级** —— `§58` 已证 5.8.3 上 `--inspect-brk` 注入不通，钩子根本不生效。

### 为什么装在 5.8.3 上而不是最新版

`VERIFY §57` 查明 5.8.3 是「异类」（会自我升级、补丁注入失败）。
在它上面装一次，拿到「补丁装不上的版本」的对照数据；**升级后补丁能自己装上，这才是 R7 要证的**。

### 升级对用户数据的影响：§57 已经验过一次

| 项 | 结果 |
|---|---|
| persona（1990 B） | `582b557259f3096e` 前后一致 |
| 员工侧（156 文件 / 1.09 MB） | 一致 |
| `groups.json` / `company.md` / `anc.db` | 三者 hash 全部一致 |
| `%USERPROFILE%\WorkBuddy\Claw\CODEBUDDY.md` | **sha256 前后完全相同** |
| `app.asar` | 92.07 MB → 173.56 MB（**只有它被替换**） |

这次只要复核这几项，不用从头验。

---

## 阶段 D：陌生 agent 装公司侧 —— ✅ 已完成（2026-11-05 16:46–17:45）

**前置**：阶段 C 通过 ✅

**怎么做的**：真机清空 → 静默重装 WorkBuddy 5.9.3 → 维护者登录 → 开**全新会话**（无本会话上下文），
只给一段任务描述 + 仓库地址，让它照 `docs/DEPLOY-COMPANY.md` 一节节装。

**结果：11/11，`§12` 自证 `PASS=4 FAIL=0 SKIP=1`，`doctor ok=true FAIL=0`**（`VERIFY §81`）。

| 项 | 实测 |
|---|---|
| 清空 | `prepare-wipe.ps1 -Apply` **43.3 秒**（停进程 8.2 / 注销 10 任务 22.1 / 改名 4 目录 1.4，只改名不删除） |
| 重装 | 静默装 WorkBuddy **75 秒**（`/S /currentuser`），`app.asar` 173.56 MB 指纹对 |
| 装公司侧 | **墙钟 59 分钟**（含等问值表 4m37s），**可计量执行 22 分钟**，逐节台账 11446 B |
| `doctor` | `ok=True fails=0 warns=2`（`work-hours` + `canary`，都要真实群消息） |
| 补丁 | `applied=true mode=hash 5.9.3`，pid 活着 |
| 任务 | 10/10 Ready，principal 全对（**历史读数**，2026-11-05；2026-11-09 为 13/13） |

### ★ 关于「且全程没有问你『这一步该填什么』」这条判据

**它没有满足这条 —— 但这是对的。** 它在 **§1** 停下，列了 11 项问值表，等了 **4 分 37 秒**。

**这不是"文档不够清楚"，是文档规定的硬门槛**：`DEPLOY-COMPANY.md` §1 明写
「开工前必须问人、**填不全就停在这里，别往下做**」，且「**这四类我不会替你编**」。

**实测印证了这条设计是对的**：它把该问的一次问清（还自己发现 `#2 corpId` 不需要，引用了 `§11.1` 的划掉说明），
而不是先编造占位符往下跑、到 §11 才发现值不对要返工。

**所以判据要改成**：
> 它装完能给出 `doctor fails=0`，**且它问的每一样都在 §1 的清单里**（不在清单里的临时追问 = 文档有洞）。

### 它撞到 6 处，4 处是本仓库的缺陷（已全部修掉）

| # | 卡在哪 | 性质 | 已修 |
|---|---|---|---|
| 1 | §1 停下问值表 | **设计行为** | 不改 |
| 2 | **§7 直跑两次失败**（无 `APPLIED`） | **文档缺陷**：没写「可能失败 1–2 次属正常」 | ✅ `§7` 已补（含 66% 成功率与「不要构造确定性解释」的教训） |
| 3 | **§5** `node cli.ts` 的 stderr 在 `EAP=Stop` 下打断脚本 | 文档缺陷：没提醒 | ✅ `§5` 已补三种绕法 |
| 4 | §10 `Get-Content -Raw` 按 ANSI 读 UTF-8 → 误报 mojibake | 它自己识别出是读数方式错 | ✅ `§10` 已补（改用 node 判定） |
| 5 | **§11 新建 secrets 文件 ACL 只有 `LOCAL SERVICE`**，五种方法全被拒 | **流程缺陷**：没写「建完 `secrets` 必须再跑一次 `set-acl.ps1`」 | ✅ `§11` 已补 + `set-acl.ps1` 目录 ACE 补 `(OI)(CI)` |
| 6 | §12 `backup-freshness` FAIL | 文档缺陷：没说明要**本地**备份 | ✅ `§12` 已补 |

### 它自己纠正一处、被纠正一处

- **自己纠正**：把"`E:\anc-backup` 里明明有备份"诊断为"判据查的是本地 `backup\anc-*.db`"，然后跑一次备份转绿 —— **先诊断再改，不是看到 FAIL 就硬改判据**。
- **被纠正**：把 §7 的失败归因为「单实例锁」。**不成立** —— `anc-selfheal` 自己是先 `Stop-Process` 再调启动器，旧实例早没了；真因是 `--inspect-brk` 单次成功率约 66%（`§59`）。

**这条错的推断值得记**：一个正确但只解释 66% 的假设，和一个人错但解释 100% 的假设摆在一起，**人会选后者** ——
因为文档没给"这是随机"的锚点。**已写进 §7。**

**注意**：如果它卡在 ACL 上，说明阶段 A/B 没做透 —— **不要给它手工提示，那是掩盖问题**。
（这次它确实卡在 ACL 上了 —— 但卡的是**阶段 A 没覆盖到的那半个**：目录 ACE 缺继承标志，不是 `deploy.ps1` 完全没设。）

---

## 一张速查

```
A1 deploy.ps1 补 ACL        ← 最高优先，不补则 B/C/D 全部白做
A2 lockfile + npm audit
A3 coverage 脚本
A4 错误路径 5 个场景
B  删掉手工 ACL → deploy.ps1 → doctor 回绿？
C  清空 → 5.8.3 → 只按文档装 → 记红 → 升级(→R7) → 修
D  新会话陌生 agent 装公司侧   ✅ 11/11，59 分钟（§81）
```
