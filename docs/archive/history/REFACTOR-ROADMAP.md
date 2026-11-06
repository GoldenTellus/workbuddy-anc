# ROADMAP — 从"能跑"到"可迭代"

> 状态：2026-11-06。**P0–P7 + P1b 全部完成**；模块化收口结束。
> 产品方向见 [FUTURE-DESIGN.md](./FUTURE-DESIGN.md)（设计树：主干/分支/叶子）。
> 现行切分见 [ARCHITECTURE.md](./ARCHITECTURE.md)，模块契约见 [modules/](./modules/)，机器可读版是 [`module-map.json`](../module-map.json)。

## 现在在哪

| 项 | 现状 |
|---|---|
| 模块 | **12/12 `current`**；`core` + 7 个能力模块 + `interfaces` + `org` + `ops` + `content` |
| 源码 | `src/core` 9 个实现；`src/modules` 7 个模块 42 个文件；`src/interfaces` 23 个文件 |
| 薄壳 | `src/service/{cli,loop}.ts`、`src/render/cli.ts`、`src/ingest/cli.ts` 只做转发 |
| 测试 | `npm test` **163/163**；`pretest` 自动跑 `npm run check`（`check:modules:deep` + `check:docs`）；`check-public` 零输出 |
| 部署 | 121 个文件；`bin\` 仍是 32 个扁平脚本，文件名未变 |
| 主机自检 | `doctor -SelfTest` **ALL PASS**；`deploy-verify` 能自动识别仓库/部署两种根 |

## 已完成

| 阶段 | 结果 |
|---|---|
| **P0 冻基线** | `ARCHITECTURE.md`、`module-map.json`、12 份模块契约、`check:modules` |
| **P1 抽 core** | `src/core/{db,schema,migrate,tx,fs,config,outbound-scan,backup,audit}.ts`；旧薄壳已在 P3 删除 |
| **P1b core 收尾** | `db.ts` 拆出 `schema.ts` / `migrate.ts` / `tx.ts`；两份 `writeAtomic` 下沉 `fs.ts` |
| **P2 拆 CLI** | 16 组命令拆到 `src/interfaces/cli/<group>.ts` + `registry.ts`；HTTP 面迁入 `interfaces` |
| **P3 拆 runtime** | `runtime/{tick,run,carry,escalation,guard}.ts` + `delivery/{send,outbox}.ts`；深导入 17→0 |
| **P4 全部模块** | identity / tasks / delivery / improvement / knowledge / org / runtime 全部迁入 `src/modules/`；`render/index.ts` 拆成 `persona.ts` + `deploy.ts` |
| **P5 scripts 分组** | 49 个脚本按域分组；`deploy.ps1` 递归收集、扁平复制到 `bin\`，文件名不变 |
| **P6 文档收口** | 12 份模块契约对齐；`ROADMAP.md`；8 份基线 banner；README 入口；`check:docs` 40 份 0 断链 |
| **P7 边界强制** | `npm test` 的 `pretest` 跑 `check:modules:deep` + `check:docs`；故意造深导入验证会红 |

## 剩余与收尾记录

> P1b / P6 / P7 全部完成；没有待做阶段。

### P1b — core 收尾（✅ 2026-11-06）

- `db.ts` 只留 `openDb` / 时间函数；schema 在 `schema.ts`，迁移在 `migrate.ts`，事务在 `tx.ts`。
- `writeAtomic` 两份已下沉 `core/fs.ts`：org 保留备份 + 读回校验 + 5 次重试；ingest 保留 `wx` 临时文件 + rename、不校验不重试。
- 验收：`npm test` 163；`check:modules:deep` 0；部署布局 `render` / `ingest` 通过。
- 回滚：单提交 `git revert`。

### P6 — 文档收口（✅ 2026-11-06）

- 12 份模块契约的状态/代码路径/测试命令/变更记录与 `module-map.json` 对齐。
- 本 `ROADMAP.md`；基线文档加"历史快照"banner；README 换入口。
- 新增 `npm run check:docs`：扫描 Markdown 相对链接，断链即失败。
- 验收：`npm run check:docs` 0 断链；`check:modules --strict` 通过；README 里不再有"当前实现"指向旧目录。
- 回滚：只改文档，可单独 revert。

### P7 — 边界强制（✅ 2026-11-06）

- `package.json` 增加 `check` = `check:modules:deep` + `check:docs`；`pretest` / `precoverage` 挂到 `npm test` / `coverage`。
- 验收：故意在 `interfaces` 里造一条 `modules/tasks/tasks.ts` 的深导入，`npm run check` 退出 1 并点名；删除后 `npm test` 163/163。
- 回滚：去掉 `pretest` / `precoverage` 两行。

## 不要动

- **部署入口路径**：`service/cli.ts`、`render/cli.ts`、`ingest/cli.ts`；`bin\<name>` 文件名不变（计划任务与技能按名字调用）。
- **`%ProgramData%\anc\` 布局**、10 个计划任务、secrets/data 的 ACL 语义。
- **一人一群**：未绑定的群不猜人、不退回默认 webhook。
- **模块边界**：跨模块只 import 对方的 `index.ts`；不直接读别人的表。
- **`.ps1` 必须 UTF-8 BOM**；`.json` 不许带 BOM。

## 常用命令

```powershell
npm test
npm run check:modules:deep
npm run check:docs
npm run scan
node scripts/checks/check-public.mjs

# 部署（dry-run 默认；-Apply 才落盘）
powershell -File scripts\deploy\deploy.ps1 -Side company
powershell -File scripts\deploy\deploy.ps1 -Side company -Apply

# 主机体检 / 自测
powershell -File scripts\doctor\doctor.ps1 -Root $env:ProgramData\anc -VaultRoot <vault 根> -Json
powershell -File scripts\doctor\doctor.ps1 -SelfTest
```
