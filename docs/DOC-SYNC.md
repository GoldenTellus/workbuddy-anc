# 文档联动规则

> 类型：联动规则（主干完成时怎么全量更新文档）
> 最后更新：2026-11-07
>
> 一句话：**全量核对，只改受影响内容，其余留“已核对无变化”记录。** 不是每份文档都重写。

---

## 1. 单一事实源

| 问题 | 唯一来源 | 其他文档怎么做 |
|---|---|---|
| 要建什么、完成到哪 | [FUTURE-DESIGN.md](./FUTURE-DESIGN.md) | 引用，不复制结论 |
| 当前主干怎么干 | [PLAN.md](./PLAN.md) | 引用，不另写计划 |
| 做完什么、缺什么 | [STATUS.md](./STATUS.md) | 引用 `GAP-###`，不重复记 |
| 现在能做什么 | [PRODUCT.md](./PRODUCT.md) | 引用，不重写能力清单 |
| 现在代码怎么组织 | [ARCHITECTURE.md](./ARCHITECTURE.md) + [modules/](./modules/) | 模块细节只写模块契约 |
| 接口怎么调 | [LOCAL-SERVICE.md](./LOCAL-SERVICE.md)、[RENDERER.md](./RENDERER.md)、[INGEST.md](./INGEST.md)、[WORKBUDDY-PATCH.md](./WORKBUDDY-PATCH.md) | 不在别处复制参数表 |
| 怎么部署运维 | [DEPLOY-COMPANY.md](./DEPLOY-COMPANY.md)、[DEPLOY-EMPLOYEE.md](./DEPLOY-EMPLOYEE.md)、[OPS.md](./OPS.md)、[REBUILD.md](./REBUILD.md)、[RELEASE-CHECKLIST.md](./RELEASE-CHECKLIST.md) | 运维步骤只写一处 |
| 为什么这么定 | [DECISIONS.md](./DECISIONS.md) | 设计文档只引用决策编号 |
| 来源/许可证 | [UPSTREAM.md](./UPSTREAM.md) + [upstreams/](./upstreams/) | 代码/文档引用 `upstream:<slug>` |

**冲突规则**：现状看 STATUS，方向看 FUTURE-DESIGN，代码看 ARCHITECTURE + modules；三者不一致时，先修事实，再改文档。

---

## 2. 文档依赖图

```text
FUTURE-DESIGN
  ├─ PLAN（当前主干）
  ├─ STATUS（完成/缺口）
  │    └─ DOC-SYNC（本文件：审计）
  ├─ PRODUCT（能力变化）
  ├─ ARCHITECTURE（代码结构变化）
  │    ├─ modules/*（契约变化）
  │    ├─ LOCAL-SERVICE / RENDERER / INGEST / WORKBUDDY-PATCH
  │    └─ DEPLOY / OPS / REBUILD（部署变化）
  ├─ INDEX / README（入口变化）
  ├─ DECISIONS（新决策）
  └─ UPSTREAM / upstreams（新来源或许可证变化）
```

主干完成时，从 FUTURE-DESIGN 沿图往下走；不是随机翻文档。

---

## 3. 主干完成检查清单

按顺序执行：

- [ ] **STATUS**：完成项写进“已完成”，带证据（提交、测试、部署、实测）。
- [ ] **FUTURE-DESIGN**：先标该主干的**所有分支**，再标主干；状态必须有 STATUS 证据。
- [ ] **PLAN**：任务勾完；快照到 `archive/plans/TRUNK-<N>-<YYYYMMDD>.md`；本文件切下一个主干。
- [ ] **PRODUCT**：能力/限制有没有变？
- [ ] **ARCHITECTURE**：模块、依赖、源码/部署布局有没有变？
- [ ] **modules/***：契约、不变量、失败模式、测试有没有变？
- [ ] **接口文档**：CLI/HTTP/渲染/入库/补丁有没有变？
- [ ] **运维文档**：部署步骤、计划任务、ACL、备份、重建有没有变？
- [ ] **INDEX / README**：入口、链接、实测数字有没有变？
- [ ] **DECISIONS**：有没有新决策要记？
- [ ] **UPSTREAM**：有没有新来源、许可证、拷贝代码需要登记？
- [ ] **设计反哺**：未来主干纠正了哪些旧行为/旧契约？是否已在 STATUS §3.3 登记，并同步改受影响的现状文档？
- [ ] **STATUS §4 文档同步审计**：每份文档标 `✅ 已更新 / ◎ 已核对无变化 / — 不适用`。
- [ ] `npm run check`：`check:modules:deep` + `check:docs` 全过。
- [ ] 文档与代码同一个提交，或紧邻的文档提交。

> **主干完成定义**：代码/测试/部署完成 + STATUS 有证据 + FUTURE-DESIGN 分支/主干已标 + PLAN 已快照 + 审计行已填 + `npm run check` 通过。
> 只满足代码，不算主干完成。

---

## 4. 改动类型 → 必查文档

| 改了什么 | 必须核对 |
|---|---|
| `src/core/` | `ARCHITECTURE`、`modules/core.md`、`LOCAL-SERVICE`（若 CLI 变） |
| `src/modules/tasks|delivery|identity|runtime` | 对应模块契约、`LOCAL-SERVICE`、`ARCHITECTURE` |
| `src/modules/knowledge/ingest` | `modules/knowledge.md`、`INGEST.md` |
| `src/modules/org` | `modules/org.md`、`RENDERER.md`、`DEPLOY-*`（若产物变） |
| `src/modules/improvement` | `modules/improvement.md`、`DECISIONS`（若流程变） |
| `src/interfaces` | `LOCAL-SERVICE`、`ARCHITECTURE`、`modules/interfaces.md` |
| `scripts/deploy|doctor|selfheal|backup|rebuild|accounts|devbot|workbuddy` | `OPS`、`REBUILD`、`DEPLOY-*`、`RELEASE-CHECKLIST` |
| 新表/迁移 | `ARCHITECTURE`、相关 `modules/*`、`STATUS`（数据/迁移缺口） |
| 未来主干修正现状 | `FUTURE-DESIGN` 主干 0.7、`STATUS` §3.3、受影响的 `PRODUCT` / `ARCHITECTURE` / 模块 / 接口 / 运维文档；行为改变时补 `DECISIONS` |
| 新上游/拷贝代码 | `UPSTREAM`、`upstreams/<slug>.md`、`THIRD_PARTY_NOTICES.md`、`DECISIONS` |
| 只改文档 | `INDEX`、`doc-map.json`、`check:docs` |

---

## 5. 审计表

填在 [STATUS.md](./STATUS.md) §4，不在本文件重复。列固定：

```text
| 日期 | 事项 | FUTURE-DESIGN | PLAN | STATUS | PRODUCT | ARCHITECTURE | modules | 接口 | 运维 | INDEX | DECISIONS | 上游 |
```

标记：

- `✅` 已更新
- `◎` 已核对，无变化
- `—` 不适用
- `⏸` 被阻塞（必须在备注写原因）

---

## 6. 文档地图与机器检查

- 人读入口：[INDEX.md](./INDEX.md)
- 机器清单：`docs/doc-map.json`（路径、类型、上下游）
- `npm run check:docs` 负责：
  - 相对链接存在；
  - 每份现行文档在 `doc-map.json` 里；
  - 类型 banner 与 map 一致；
  - 每份现行文档能从 `INDEX.md` 链到。

新增/移动文档时，先改 `doc-map.json`，再改 `INDEX.md`，最后跑 `check:docs`。
