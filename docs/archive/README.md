# 归档

> 类型：历史 · 最后整理：2026-11-10

这里放**不再是现行契约**的文档。归档不等于删除：它们保留“当时为什么这么做”的证据，但行号、路径、模块名可能已失效。

## 目录

| 目录 | 放什么 |
|---|---|
| `history/` | 旧计划、旧路线图、验收矩阵、VERIFY 实测、上游盘点、交接记录 |
| `plans/` | 每个主干完成后的 `PLAN.md` 快照 |
| `completed/` | 已完成主干/批次的证据快照（新结构） |

## 现行文档在哪

- 方向：[../FUTURE-DESIGN.md](../FUTURE-DESIGN.md)
- 当前计划：[../PLAN.md](../PLAN.md)
- 已完成/缺口：[../STATUS.md](../STATUS.md)
- 现状架构：[../ARCHITECTURE.md](../ARCHITECTURE.md)
- 文档导航：[../INDEX.md](../INDEX.md)

## 规则

- 归档文件只追加说明，不再改写事实；要纠正历史，在现行文档里写“取代了哪份归档”。
- 新归档文件必须在 `history/` 或 `plans/` 下，并在相应的 `history/` 或 `plans/` 索引（`plans/README.md`）登记。
- `check:docs` 默认跳过 `archive/`，避免历史断链阻塞；引用归档时用相对路径。
