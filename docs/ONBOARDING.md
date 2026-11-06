# 入职 / 离职 runbook

> 类型：运维手册（入职/离职）

对应 [DECISIONS.md](./DECISIONS.md) §5.8、[PLAN.md](./PLAN.md) 阶段 D（O-5 干净机重建）与离职自动化、共享账号。目标：新员工一小时内拿到个人 bot 和三方群。

## 入职

### 0. 先备齐（缺一项就停）

- 员工姓名 + ASCII `id`（如 `zhangsan`）；
- 企微 `userid`；
- 三方群已建好：**本人 + 公司 bot + 本人个人 bot**；
- 该群的 webhook 密钥文件已放进 `%ProgramData%\anc\secrets\`，文件名登记到成员记录里（值不进 git）。

### 1. 主机：开只读共享账号

```powershell
# 名单 CSV：name,id
powershell -ExecutionPolicy Bypass -File scripts\provision-vault-accounts.ps1 -Csv .\team.csv
```

凭据写到 `%ProgramData%\anc\accounts\provisioned-<时间>.csv`，发给本人后删除。

### 2. org 数据登记（唯一真相）

在主机上的 org 目录（如 `D:\anc\org\members\zhangsan.md`）写：

```yaml
---
id: zhangsan
name: 张三
role: manager
userid: <userid>
chat_id: <chatid>
webhook_file: hook-zhangsan.txt
seat: Enterprise
bot: 未接入
---
```

### 3. 渲染 + 部署 persona

```powershell
node src\render\cli.ts render --org D:\anc\org --out D:\anc\build
```

产物：公司 persona、`members\zhangsan\CODEBUDDY.md`、`groups.json`。公司 bot 的 persona 部署见 [WORKBUDDY-PATCH.md](./WORKBUDDY-PATCH.md) 的 `deploy-persona.ps1`（M3 之后由渲染器直接部署）。

### 4. 同步绑定表

```powershell
node src\service\cli.ts --db C:\ProgramData\anc\data\anc.db bind import --from D:\anc\build\groups.json
```

### 5. 员工机：装 WorkBuddy 并登录

- 员工用自己的账号登录企业微信与 WorkBuddy；
- 把 `D:\anc\build\members\zhangsan\` 整个目录拷到员工机（U 盘或内网共享，别走 IM）。

### 6. 员工机：接入

```powershell
node <仓库>\src\render\cli.ts onboard --package <接入包目录> --home %USERPROFILE% --vault-shared \\主机\anc-vault-shared
node <仓库>\src\render\cli.ts verify  --home %USERPROFILE%
```

- 已有 `CODEBUDDY.md` 时必须 `--adopt`（会先备份）；
- `verify` 报 OK 才算装好。

### 7. 群里验一遍

1. 本人 @ 公司 bot：「登记任务：明天 10:00 提醒我交周报」→ 有任务号；
2. 到点收到提醒并被 @；
3. 问「今天有什么任务」→ 能列出；
4. 引用一个文件 @ 公司 bot「入库」→ 有入库摘要。

### 8. 收尾

- 把成员记录里的 `bot` 改成 `已接入`，重渲染并 `bind import`；
- 删掉 `provisioned-*.csv`；
- 在 [OPS.md](./OPS.md) 的备份里确认当晚 `anc-backup` 成功。

## 离职

1. **停权**：`Disable-LocalUser -Name anc-read-<id>`（只读共享账号）；
2. **解绑**：`node src\service\cli.ts --db … bind unbind --chat-id <chatid>`；
3. **org 数据**：成员文件标 `status: inactive`（或移入 `org/archive/`），重渲染；
4. **群里**：把个人 bot 移出三方群；公司 bot 保留；
5. **webhook**：该群 webhook 停用/重置（密钥只在主机，不在 git）；
6. **资料**：该员工入库的文档不删；访谈与个人数据留在内部区，按公司规定处理。

## 检查清单（打印出来用）

- [ ] 只读账号已开、凭据已发、文件已删
- [ ] org 成员记录齐全（userid / chat_id / webhook_file）
- [ ] 渲染 + `bind import` 成功
- [ ] 员工机 `verify` 返回 OK
- [ ] 群里四条验收动作通过
- [ ] 当晚备份成功
