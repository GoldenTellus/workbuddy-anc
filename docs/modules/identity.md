# identity — 身份与群绑定

> 类型：模块契约

> 状态：现行（P4 已迁入 `src/modules/identity/`）
> 代码：`src/modules/identity/bindings.ts`、`scripts/anc-bind/`
> 入口：`src/modules/identity/index.ts`

## 职责

维护「群 → 员工 → 企微 userid → webhook 文件」的唯一真相。**一人一群是身份边界**：未绑定的群不猜人、不退回默认群。

## 拥有

| 数据/文件 | 说明 |
|---|---|
| `chat_bindings` 表 | `chat_id` 主键；`employee` / `userid` / `webhook_file` / `note` |
| webhook 文件名校验规则 | 只接受 secrets 目录下的纯文件名（字母数字 `._-`，`.txt` 结尾） |

## 公开契约

- `bind(db, chatId, employee, note?, userid?, webhookFile?)` → `{action, binding}`
- `resolve(db, chatId)` → binding | null
- `resolveByUserid(db, userid)` → binding | null（交办人通知用）
- `unbind(db, chatId)` / `listBindings(db)`
- `importGroups(db, groups)`：一次导入 `groups.json`
- `assertWebhookFileName(name)`：防路径穿越

## 不变量

- `webhook_file` **只能是文件名**，不能是路径；否则拒绝。
- 查不到绑定 → **返回 null**，调用方必须失败，**禁止退回任何默认群**。
- 正常情况下一个员工只有一个群；表不强制，允许临时一人多群。
- 只允许管理员写（建群、离职交接）；agent 只读。

## 失败模式

| 错误码 | 含义 | 出路 |
|---|---|---|
| `BAD_WEBHOOK_FILE` | 文件名带路径/非法字符 | 改成 secrets 下的纯文件名 |
| `NO_BINDING` | 该 chat 没有绑定 | 管理员 `bind set`；不要猜人 |

## 依赖

- 允许：core
- 禁止：tasks / delivery / runtime（身份是它们的前置，不是反过来）

## 测试

`node --test scripts/anc-bind/bind.test.mjs`；`npm run test:service` 里的「未绑定群不退回默认 webhook」用例。

## 改动指南

- 改表结构：同步 `docs/WORKBUDDY-PATCH.md` 的「群绑定表」一节、`bind.mjs`、`db.ts` 迁移。
- 加字段（如部门）：先确认 `groups.json` 与渲染器是否也要带。

## 变更记录

| 日期 | 改了什么 | 为什么 |
|---|---|---|
| 2026-11-06 | 建档 | 模块化立项 |
| 2026-11-06 | P4 迁入 `src/modules/identity/` | 模块化 |
