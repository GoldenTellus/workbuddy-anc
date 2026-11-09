# 模块契约

每个模块一份，位置固定 `docs/modules/<id>.md`，由 [`module-map.json`](../../module-map.json) 引用。
它不是设计文档，是**改这块之前必须知道的约束**。

> 门禁：`npm test` 的 `pretest` 会自动跑 `npm run check`（`check:modules:deep` + `check:docs`）；契约缺失或文档断链都会红。

## 模板

```markdown
# <id> — <中文名>

> 状态：现行 / 迁移中 / 规划
> 代码：<当前路径>
> 入口：<目标 index.ts>

## 职责
## 拥有
## 公开契约
## 不变量
## 失败模式
## 依赖
## 测试
## 改动指南
## 变更记录
```

## 填写规则

1. **"拥有"里的表/文件只能由本模块写。** 别的模块要读，走公开契约；不许直接 `db.prepare('SELECT ... FROM 别人的表')`。
2. **"公开契约"只写稳定接口。** 内部函数、内部类型、表句柄都不算。
3. **"不变量"用"必须/禁止"句式。** 能写成测试的，优先写成测试。
4. **"失败模式"写错误码与出路。** 错误码带模块前缀（`TASK_` / `OUTBOX_` / `INGEST_` / `RENDER_` / `WB_`）。
   **注意：当前多数模块还抛中文 `Error`，没有 `code`**；表里的错误码是 P1–P7 的目标约定，落地前以实际错误文本为准。
5. **"改动指南"写影响面。** 改这块要同步哪些块、哪些文档、哪些技能。
6. **先改本文件，再改代码。** 契约变了而文档没变，视为缺陷。

## 索引

| 模块 | 一句话 | 契约 |
|---|---|---|
| core | 库、配置、审计、扫描、备份 | [core.md](./core.md) |
| identity | chatid ↔ 员工 ↔ webhook | [identity.md](./identity.md) |
| tasks | 任务生命周期与提醒 | [tasks.md](./tasks.md) |
| executor | 日对话 / Ticket / Assignment / Report 调度 | [executor.md](./executor.md) |
| delivery | outbox 与 webhook 发送 | [delivery.md](./delivery.md) |
| knowledge | vault 入库、检索、A2A | [knowledge.md](./knowledge.md) |
| org | org → persona、部署与回滚 | [org.md](./org.md) |
| improvement | submission → issue → patch → eval | [improvement.md](./improvement.md) |
| runtime | 一次 tick 的编排 | [runtime.md](./runtime.md) |
| interfaces | 16 组 CLI + HTTP 面 | [interfaces.md](./interfaces.md) |
| workbuddy | 唯一碰 WorkBuddy 本体的层 | [workbuddy.md](./workbuddy.md) |
| ops | 部署、体检、备份、重建 | [ops.md](./ops.md) |
| content | 技能、persona、模板、用例 | [content.md](./content.md) |

总图与迁移路线见 [../ARCHITECTURE.md](../ARCHITECTURE.md)。
