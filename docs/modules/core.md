# core — 平台底座

> 类型：模块契约

> 状态：现行（P1 已迁到 `src/core/`；旧路径兼容薄壳已删除）
> 代码：`src/core/{db,schema,migrate,tx,fs,config,outbound-scan,backup,audit}.ts`
> 入口：`src/core/index.ts`

## 职责

所有模块共享的确定性底座：打开与迁移数据库、事务、时间规范化、运行时配置、审计日志、出站凭据扫描、数据库备份。**不包含任何业务规则。**

## 拥有

| 数据/文件 | 说明 |
|---|---|
| `meta` / `config` 表 | 键值配置；`config` 写入即校验 |
| schema 与 `migrate()` | 只加列、不改旧数据；表定义在 `schema.ts`，迁移在 `migrate.ts`，表定义与代码一起进 git |
| 原子写 | `fs.ts` 的 `atomicWriteFile`：临时文件 → 可选读回校验 → rename；整组事务由调用方负责 |
| `%ProgramData%\anc\data\audit.log` | JSONL；每次 CLI 调用一行，只记命令与目标，不记参数值 |

## 公开契约

- `openDb(path?)` → `DatabaseSync`；打不开时抛人话错误，不冒 Node 裸堆栈
- `tx(db, fn)`：嵌套用 SAVEPOINT；外层 `BEGIN IMMEDIATE`
- `nowIso()` / `toIso(v)`：一律 UTC ISO；非法时间直接抛错
- `atomicWriteFile(target, content, opts?)`：单文件原子写；`verify` 读回对拍，`retries` 控制 rename 重试，`exclusive` 用 `wx` 开临时文件
- `getConfig / setConfig / listConfig / validateConfig / configProblems`
- `appendAudit(dataDir, entry)`
- `assertSafeOutbound(text)`：命中凭据抛 `OUTBOUND_SECRET_BLOCKED`
- `backup(db, to)`：`VACUUM INTO` + 完整性校验

## 不变量

- 库里时间**一律 UTC ISO**；本地日期只在展示与 `dayend` 用。
- 配置非法值**必须报错**，不静默兜底。
- 审计**只记命令与目标**，不记参数值。
- 扫描器不可用 → **不发**（fail-closed）。
- `tx()` 的 `fn` 必须是同步的；异步工作在事务外做。

## 失败模式

| 错误码 | 含义 | 出路 |
|---|---|---|
| `DB_OPEN_FAILED` | 库被独占 / 目录不可写 / 磁盘满 | 看错误里的提示；确认没有第二个进程 |
| `CONFIG_INVALID` | 配置值不合规 | 按 `configProblems` 的提示改 |
| `OUTBOUND_SECRET_BLOCKED` | 出站内容含凭据 | 删掉凭据再入队；不要重试原消息 |

## 依赖

- 允许：无
- 禁止：任何业务模块（core 不能 import tasks / outbox / render / …）

## 测试

`npm run test:service` 里的 audit、配置、扫描、备份用例；`db` / `fs` 由 service / render / ingest 的集成用例覆盖。

## 改动指南

- **加表**：同时改 schema、`migrate()`、拥有模块的文档；表注释写 `OWNER: <module>`。
- **改时间语义**：先改这里与 `docs/LOCAL-SERVICE.md`，再改调用方。
- **改扫描规则**：同步 `DECISIONS` §8 与测试。

## 变更记录

| 日期 | 改了什么 | 为什么 |
|---|---|---|
| 2026-11-06 | 建档 | 模块化立项 |
| 2026-11-06 | P1 迁入 `src/core/`；P3 删除旧薄壳 | 模块化 |
| 2026-11-06 | P1b：schema/migrate/tx 拆出，`writeAtomic` 下沉 `fs.ts` | 收掉 core 最后的混装 |
