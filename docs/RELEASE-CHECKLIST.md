# 1.0 发布前检查清单

> **读者是 agent，不是人。** 每一项都有可执行的判据；判据不成立就停在这一项，不要往下走。
>
> 为什么要这份东西：`docs/ACCEPTANCE.md` 回答的是「功能做到了没」，这份回答的是
> 「**这东西能不能拿去发布**」。后者包含前者，但多了一整套「代码自己能不能做到」的检验。
>
> 背景见 [VERIFY §65](./VERIFY.md)（2026-11-05 第一次发布前审计）。

---

## 阶段 A：补代码缺口（不用清空，本机就能做）

### A1 `deploy.ps1` 补 ACL —— **最高优先**  ← **✅ 2026-11-05 已完成**（`VERIFY §66`）

> **做法与下面这段不同**：最终没有把 `icacls` 写进 `deploy.ps1`，而是新建了独立的
> [`scripts/set-acl.ps1`](../scripts/set-acl.ps1)（默认 dry-run，`-Apply` 落盘，`-Side employee` 跳过），
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

### A2 生成 lockfile + 跑依赖审计

```powershell
npm i --package-lock-only          # 仓库现在没有 lockfile，npm audit 直接用不了（ENOLOCK）
git add package-lock.json
npm audit                          # 有 high/critical 就处理
```

**判据**：`npm audit` 能跑通（不再 ENOLOCK），且 high/critical 为 0 或已记录处置理由。

### A3 加覆盖率

```json
// package.json scripts 里加
"coverage": "node --experimental-test-coverage --test test/"
```

**判据**：跑出真实的 line/branch 覆盖率数字，写进本文档。**没有这个数字，就不知道 127 项测试护住的是核心还是边角。**

### A4 错误路径测试

| 场景 | 怎么造 | 期望 |
|---|---|---|
| 磁盘满 | 建一个配额很小的临时卷，或塞满 | 写日志/写库失败要**报出来**，不能静默 |
| 文件被占用 | 用另一个进程独占 `anc.db` | 服务给出可读错误，不崩 |
| SQLite 锁 | 两个进程同时写 | 一方等锁/报错，不产生脏数据 |
| 并发写 | 并行跑 20 个 `cli.ts task add` | 全部成功，无丢写 |
| 日志 0 字节 | 把 `loop.log` 置空后再 tick | 正常追加，不丢格式 |

---

## 阶段 B：证明「代码能自己修回来」

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

---

## 阶段 C：清空重装（真机）

**前置**：阶段 A 全绿 + 阶段 B 通过。

```
① 备份 secrets / D:\anc 的两个 git 仓库 / org
② 清空（prepare-wipe.ps1 -Apply）
③ 装 5.8.3
④ 只按 AGENT-DEPLOY-COMPANY.md 装，不手工补任何东西 → 记下哪些红  ← 这步的「红」就是 bug 清单
⑤ 升级到最新版本 → 验：数据完整 + 补丁自动重新注入（R7）
⑥ 修 ④ 记下的红，再验一次
```

**为什么装在 5.8.3 上而不是最新版**：`VERIFY §57` 查明 5.8.3 是「异类」（会自我升级、补丁注入失败）。
在它上面装一次，能拿到「补丁装不上的版本」的对照数据；升级后补丁能自己装上，**这才是 R7 要证的**。

**判据**：`doctor fails=0 warns≤2` + `deploy-verify ok=true` + `patch-state.json applied=true mode=hash` 且 pid 活着 + `17999` 监听。

---

## 阶段 D：陌生 agent 装公司侧

**前置**：阶段 C 通过。

开一个**全新会话**（不能继承本会话上下文），粘 `E:\anc-backup-20261104\AGENT-PROMPT.txt`，让它照
`docs/AGENT-DEPLOY-COMPANY.md` 装。

**判据**：它装完能给出 `doctor fails=0` 的输出，**且全程没有问你「这一步该填什么」**。

**注意**：如果它卡在 ACL 上，说明阶段 A/B 没做透 —— **不要给它手工提示，那是掩盖问题**。

---

## 一张速查

```
A1 deploy.ps1 补 ACL        ← 最高优先，不补则 B/C/D 全部白做
A2 lockfile + npm audit
A3 coverage 脚本
A4 错误路径 5 个场景
B  删掉手工 ACL → deploy.ps1 → doctor 回绿？
C  清空 → 5.8.3 → 只按文档装 → 记红 → 升级(→R7) → 修
D  新会话陌生 agent 装公司侧
```
