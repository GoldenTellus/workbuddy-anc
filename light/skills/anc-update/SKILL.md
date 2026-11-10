---
name: anc-update
description: 一句话升级本项目——拉新版本、换运行件、保留所有数据。用户说「项目有更新 / 升级一下 / 更新到最新 / 拉更新 / 有新版吗」时使用。触发词：有更新、升级、更新项目、拉最新、upgrade。
---

# anc-update（一句话升级）

目标：群里说一句话 → bot 自己把运行件换到最新版本，**不动任何运行数据**（任务、提醒、入库记录、vault、org、备份全保留）。

## 0. 先判谁能触发（不合格就拒绝，别客气）

| 你在哪 | 谁能触发 |
|---|---|
| 公司 bot（主机） | **只有 boss / manager**。升级会重启主机上的 WorkBuddy，而群里任何成员都能发消息——不能让人随便重启公司主机 |
| 员工 bot（本人电脑） | 本人说就做；**别人**在群里说，先问主人再动 |

判角色用 `bind actor`：

```powershell
node --no-warnings C:\ProgramData\anc\service\cli.ts --db C:\ProgramData\anc\data\anc.db --json bind actor --chat-id <当前群> --userid <消息里的 from>
```

查不到人 → 走 `anc-task` 的「首次绑定」流程，**不要猜人**。

## 1. 只读：有没有新版本

```powershell
# 公司侧
powershell -NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\anc\tools\upgrade.ps1 -Action check -Side company -Json

# 员工侧
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\anc\tools\upgrade.ps1" -Action check -Side employee -Json
```

看 `behind`：

- **0** → 回「已是最新，当前版本 `<rev>`」，结束。不要为了"显得有用"去强升。
- **>0** → 有更新。把 `incoming` 里前 1–2 条提交标题念出来，问一句「现在升吗」。

## 2. 升级

**先回一句话再跑**——升级会重启 WorkBuddy，当前会话会断，人得知道发生了什么：

> 收到，开始升级到 `abc1234`（3 个提交）。数据不会动，重启后我回来。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\anc\tools\upgrade.ps1 -Action apply -Restart -Json
```

脚本按顺序做，每步都有独立结果：

1. **备份数据库**（强制，忽略幂等间隔）——备份失败就中止，不在没备份时升级
2. `git pull --ff-only`——本地有未提交改动会失败（这是对的，别强推）
3. **铺运行件**（`deploy.ps1 -Apply`，逐文件 hash 对拍，任一失败整体回滚）
4. 同步技能（`%USERPROFILE%\.workbuddy\skills`）
5. 公司侧重渲染并安装 persona
6. 重启 WorkBuddy（`-Restart`）
7. 自证（`deploy-verify`）

## 3. 结果怎么回

| 退出码 | 意思 | 怎么跟人说 |
|---|---|---|
| `0` + `ok:true` | 成功 | 「已升到 `<rev>`，数据都在。重启后恢复正常了」 |
| `3` | **权限不足**（最常见） | 「这次要管理员授权一次：管理员跑 `upgrade.ps1 -Action apply -GrantDeployWrite`，之后我就能自己升了」 |
| `1` | 失败、**已自动回滚** | 「升级失败，运行件已回滚到原版本，**数据没动**。原因：`<FAIL 那行的 detail>`」 |
| `2` | 环境问题（git/node/路径） | 把 `NEXT` 那行原样告诉人 |

**不要把 SKIP 说成成功。** 自证里 `bot-reply` 在员工侧永远是 SKIP（没装补丁、没有 test-emit），那是没验，不是通过。

## 4. 为什么数据不会丢（被问就照这个解释）

`deploy.ps1` 的部署清单里**没有** `data\`、`org\`、`backup\`、`secrets\`、vault 两区——升级只覆盖运行件（`core/modules/service/interfaces/shared/bin/tools/patch/light\templates`）。

- 数据库 schema 变化由 cli 打开时自动迁移（`src/core/migrate.ts`，只增不改：加表加列，不删数据）
- 升级前强制备份一份 DB 到 `backup\`
- 失败时 `deploy.ps1` 会把运行件整体回滚，数据库根本没被写过

## 5. 不要做的事

- **不要**手工 copy 覆盖 `C:\ProgramData\anc` 下的文件——绕过 hash 对拍，出问题没人知道哪一版
- **不要**在升级未结束时再触发一次（覆盖中途会半套）
- **不要**为了「让它变绿」加 `-Force` 跳过检查
- **不要**在群里替别人升级他的电脑——员工侧升级只动本机，装错对象等于给别人换代码

## 6. 回滚（升级完发现不对）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\anc\tools\upgrade.ps1 -Action rollback -Json
```

读 `data\version.json` 里的 `prevRev`，`git checkout` 回去再重铺运行件。**这不是恢复数据库**——数据库在升级中从未被改写；要恢复数据另用 `backup-anc.ps1` 的快照。
