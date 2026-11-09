# identity — 身份与群绑定

> 类型：模块契约

> 状态：现行（P4 已迁入 `src/modules/identity/`；主干 1 加 people/groups/manager_scopes）
> 代码：`src/modules/identity/{bindings,groups,policy,privacy}.ts`、`scripts/anc-bind/`
> 入口：`src/modules/identity/index.ts`

## 职责

维护「群 → 类型 → 人 → 角色 → 部门 → webhook」的唯一真相。**`chat_bindings` 是一人一群的兼容层；新代码优先用 `people` / `groups` / `manager_scopes`。** 未绑定/未识别的群不猜人、不退回默认群。

## 拥有

| 数据/文件 | 说明 |
|---|---|
| `people` 表 | `person_id` 主键；`userid` 唯一（会话级 `wok…` 会话 id）；`mention_userid` 企微通讯录 userid（webhook 真 @ 用，可空）；`system_role`：boss/manager/employee；`dept_id` |
| `groups` 表 | `chat_id` 主键；`type`：employee/department/company/boss_dm；`employee_id`/`dept_id`/`webhook_file` |
| `manager_scopes` 表 | 管理者 → 部门（多对多） |
| `chat_bindings` 表 | 兼容层：员工群 `chat_id` → `employee` / `userid` / `webhook_file` |
| webhook 文件名校验规则 | 只接受 secrets 目录下的纯文件名（字母数字 `._-`，`.txt` 结尾） |

## 公开契约

- `bind(db, chatId, employee, note?, userid?, webhookFile?)` → `{action, binding}`
- `resolve(db, chatId)` → binding | null
- `resolveByUserid(db, userid)` → binding | null（交办人通知用）
- `unbind(db, chatId)` / `listBindings(db)`
- `importGroups(db, groups)`：一次导入 `groups.json` 的 `members[]` 与 `groups[]`（四类群）
- `assertWebhookFileName(name)`：防路径穿越
- `upsertPerson` / `resolvePerson` / `resolvePersonByUserid` / `listPeople`；`upsertPerson` 可带 `mentionUserid`（不传/空串 = 清空）
- `isMentionUserid(v)`：webhook `mentioned_list` 取值是否安全（`[A-Za-z0-9_@.-]`、≤64）
- `upsertGroup` / `resolveGroup` / `listGroups`
- `setManagerScopes` / `listManagerScopes`
- `resolveActor(db, chatId, userid)` → `{group, person}`；缺任一返回 null
- `priorityFor` / `isBoss` / `isManager` / `canManageDept` / `canAssignTo` / `canApproveCrossDept` / `canViewTask` / `canConfirmAttention` / `canStopTask`
- `routeData({level, groupType, actorRole, isSelf})` → `{allowed, target, reason?}`
- `resolveEmployeeGroup` / `resolveBossDmGroup` / `resolvePrivateChat(db, personId, target)`

## 不变量

- `webhook_file` **只能是文件名**，不能是路径；否则拒绝。
- 查不到绑定 → **返回 null**，调用方必须失败，**禁止退回任何默认群**。
- `people.userid` 唯一；空 userid 可多条。
- `people.mention_userid` 只用于 webhook `mentioned_list` 真 @（GAP-080）：字符集 `[A-Za-z0-9_@.-]`、≤64，空表示没配；它**不能**代替 `userid` 做身份识别，`userid` 也不能当 @ 目标（会话级 `wok…` 不一定 @ 得到人）。
- `people` 是 org 的投影：`bind sync-org` 重跑时按 org 全量覆盖，org 删掉 `mention_userid` 会清空库里的旧值；`bind verify-org` 对账这一列，漂移要报错（否则只会悄悄回到不 @）。
- `groups` 只有四类：employee / department / company / boss_dm；employee 群必须有 `employee_id`，department 群必须有 `dept_id`。
- `manager_scopes` 是管理者范围的真相；`system_role=manager` 不等于自动有范围。
- 隐私路由只决定“在哪说/能不能说”，不取 `chat_id`；实际渠道由调用方解析。
- 只允许管理员写（建群、离职交接）；agent 只读。

## 失败模式

| 错误码 | 含义 | 出路 |
|---|---|---|
| `BAD_WEBHOOK_FILE` | 文件名带路径/非法字符 | 改成 secrets 下的纯文件名 |
| `NO_BINDING` | 该 chat 没有绑定 | 管理员 `bind set`；不要猜人 |
| `BAD_GROUP_TYPE` | 群类型不是四类之一 | 改成 employee/department/company/boss_dm |
| `GROUP_FIELD_MISSING` | employee 群缺 employee_id / department 群缺 dept_id | 补字段；不要猜 |
| `PERSON_DUPLICATE_USERID` | 同一个 userid 绑了两个人 | 先合并/解绑旧人 |

## 依赖

- 允许：core
- 禁止：tasks / delivery / runtime（身份是它们的前置，不是反过来）

## 测试

`node --test scripts/anc-bind/bind.test.mjs`；`npm run test:service` 里的「未绑定群不退回默认 webhook」用例；`src/modules/identity/groups.test.ts`、`policy.test.ts`、`privacy.test.ts`。

## 改动指南

- 改表结构：同步 `docs/WORKBUDDY-PATCH.md` 的「群绑定表」一节、`bind.mjs`、`db.ts` 迁移。
- 加字段（如部门）：先确认 `groups.json` 与渲染器是否也要带。

## 变更记录

| 日期 | 改了什么 | 为什么 |
|---|---|---|
| 2026-11-06 | 建档 | 模块化立项 |
| 2026-11-06 | P4 迁入 `src/modules/identity/` | 模块化 |
| 2026-11-07 | 加 people/groups/manager_scopes、policy、privacy | 主干 1 |
| 2026-11-10 | people 加 `mention_userid`（通讯录 userid）；sync-org 写入、verify-org 对账；`isMentionUserid` | GAP-080 / DEV-03 |
