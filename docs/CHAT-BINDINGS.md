# 群与员工的绑定表（chat bindings）

对应 [FORK-DIRECTION.md](./FORK-DIRECTION.md) §5.2「员工群」、D17 与 [WORKBUDDY-PATCH.md](./WORKBUDDY-PATCH.md)。

## 为什么

agent 现在能在消息开头看到 `[anc:chat=<chatid> from=<userid>]`（D17 的注入），但**它不该自己记住谁是谁**——名单是易变事实，模型记不住也不该记。

所以把「chatid → 员工」放进本地 SQLite，作为真相；agent 只负责把前缀里的 chatid 拿来查，不在上下文里存名单。

## 表

```sql
CREATE TABLE chat_bindings (
  chat_id    TEXT PRIMARY KEY,
  employee   TEXT NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

- 一个人一个群（D7），正常情况下 `employee` 唯一；表本身不强制，方便临时一人多群。
- 默认库：`%USERPROFILE%\anc\anc.db`（`*.db` 已在 `.gitignore` 里，数据不进 git）。
- schema 由 `scripts/anc-bind/bind.mjs` 建，重复执行安全（`CREATE TABLE IF NOT EXISTS`）。

## 用法

```powershell
# 建群时绑定（管理员执行）
node scripts\anc-bind\bind.mjs bind --chat-id <chatid> --employee <姓名>

# 查
node scripts\anc-bind\bind.mjs resolve --chat-id <chatid> --json

# 改绑（员工换群 / 离职交接）
node scripts\anc-bind\bind.mjs bind --chat-id <chatid> --employee <姓名> --note "2026-11 换人"

# 解绑
node scripts\anc-bind\bind.mjs unbind --chat-id <chatid>

# 列表
node scripts\anc-bind\bind.mjs list
```

退出码：0 成功 / 1 查不到（`resolve`）/ 2 参数或环境错误。支持 `--json`。

测试：`node --test scripts/anc-bind/bind.test.mjs`（3 条：绑定/改绑/解绑、未知 chat、缺参数）。

> 同一张表也可以从本地小服务那边操作：`npm run service -- bind set --chat-id <chatid> --employee <姓名>`。服务侧的 schema 与这里一致，见 [LOCAL-SERVICE.md](./LOCAL-SERVICE.md)。

## 谁写、什么时候写

- **只允许管理员写**：绑定发生在建群那一步（一人一群），或离职交接时由管理员改。
- 员工和 agent 都不能改这张表；agent 只读。
- 绑定口令方案（管理员在群里发一句、bot 记住）**不再使用**——那是 T16 不通过时的退路，现在有 chatid 就不需要了。

## agent 侧怎么用

1. 每轮消息开头有 `[anc:chat=<chatid> from=<userid>]`；
2. persona 规则：**先拿 chatid 查绑定表，查到再按员工走**；查不到就按「未绑定的人」处理，不猜；
3. 具体查法在本地工具/技能里实现（读这张表或调本地小服务的接口），不在 prompt 里塞名单。

## 隐私与边界

- chatid、userid 都是标识符，不是凭据；库只在本机，`*.db` 不入 git。
- 日志里不写 chatid：`workbuddy-patch.log` 只记 `INJECTED`/`APPLIED`/`SKIP`。
- 与 D13/D14 一致：原件与敏感数据不进 git；绑定表属于内部区数据，转公开前确认不在仓库里。

## 待办

- 把这张表接进本地小服务（后续的 tasks / reminders / outbox 都用同一个库）；
- 员工离职/换群时的解绑与审计（谁在什么时候改的）；
- 与 T20/T22 一起看：会话压缩/重置后，agent 是否仍按 chatid 查表（前缀是每轮注入的，理论上不受影响）。
