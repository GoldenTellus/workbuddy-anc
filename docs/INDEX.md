# 文档与仓库索引

> 类型：导航 · 最后整理：2026-11-07
>
> **这是什么**：一份给「刚打开这个仓库的人 / agent」用的索引——文档按什么顺序读、目录各管什么、常用命令怎么跑。
> **不替代契约**：改代码前先读 [AGENTS.md](../AGENTS.md)；现状架构看 [ARCHITECTURE.md](./ARCHITECTURE.md)；未来方向看 [FUTURE-DESIGN.md](./FUTURE-DESIGN.md)。

---

## 先读（按顺序）

1. [../README.md](../README.md)：项目入口，装什么、能做什么。
2. [../AGENTS.md](../AGENTS.md)：agent 开工规则；[../CLAUDE.md](../CLAUDE.md) 只是短指针。
3. 本文件：文档与目录导航。
4. [PRODUCT.md](./PRODUCT.md)：部署完能干什么、每项能力怎么用。
5. [FUTURE-DESIGN.md](./FUTURE-DESIGN.md)：要建成什么；主干 / 分支 / 叶子。
6. [ARCHITECTURE.md](./ARCHITECTURE.md)：现在代码怎么分。

---

## 文档分层

| 层 | 回答什么 | 文档 |
|---|---|---|
| **方向** | 要建什么、为什么、完成到哪 | [FUTURE-DESIGN.md](./FUTURE-DESIGN.md) |
| **执行** | 当前主干怎么干 | [PLAN.md](./PLAN.md) |
| **账本** | 已完成什么、还缺什么 | [STATUS.md](./STATUS.md) |
| **联动规则** | 主干完成时哪些文档要跟着更新 | [DOC-SYNC.md](./DOC-SYNC.md) |
| **现状能力** | 现在能做什么、不做什么 | [PRODUCT.md](./PRODUCT.md) |
| **现状架构** | 现在代码怎么组织 | [ARCHITECTURE.md](./ARCHITECTURE.md) + [modules/](./modules/) |
| **接口契约** | CLI / HTTP / 渲染 / 入库 / 补丁 / Main↔Executor 怎么调 | [LOCAL-SERVICE.md](./LOCAL-SERVICE.md)、[MAIN-EXECUTOR.md](./MAIN-EXECUTOR.md)、[RENDERER.md](./RENDERER.md)、[INGEST.md](./INGEST.md)、[WORKBUDDY-PATCH.md](./WORKBUDDY-PATCH.md) |
| **运维手册** | 怎么部署、怎么修、怎么重建 | [DEPLOY-COMPANY.md](./DEPLOY-COMPANY.md)、[DEPLOY-EMPLOYEE.md](./DEPLOY-EMPLOYEE.md)、[OPS.md](./OPS.md)、[REBUILD.md](./REBUILD.md)、[RELEASE-CHECKLIST.md](./RELEASE-CHECKLIST.md)、[ONBOARDING.md](./ONBOARDING.md) |
| **来源** | 哪些上游/参考项目、许可证、用了什么 | [UPSTREAM.md](./UPSTREAM.md) + [upstreams/](./upstreams/) |
| **决策** | 为什么这么定 | [DECISIONS.md](./DECISIONS.md) |
| **历史** | 以前的计划、验收、实测 | [archive/](./archive/) |

---

## 实测数字

| 指标 | 当前值 | 取数命令 / 来源 |
|---|---|---|
| 测试 | **212 / 212 pass** | `npm test`（`pretest` 自动跑 `npm run check`） |
| 覆盖率（行 / 分支 / 函数） | **90.83% / 80.43% / 94.99%** | `npm run coverage`（2026-11-09 干净树 `0ed1938` 实测，212 测试；早一轮 dirty 树为 90.83） |
| 测试文件 | **25** 个 | `package.json` 的 `scripts.test` 列表 |
| doctor 检查项 | **34** 项 | 21 个 `Add-Result` 字面量 + 13 个 `task-*` 循环项 |
| 计划任务 | **13** 个 | `grep -c "Name = '" scripts/deploy/register-tasks.ps1` |
| 技能目录 | **8** 个 | `ls -d light/skills/*/ \| wc -l` |
| 本地服务命令组 | **17** 组 | `node -e "import('./src/interfaces/cli/registry.ts').then(m => console.log(m.order.length))"` |
| 模块 | **13 / 13 `current`** | `npm run check:modules` |
| 运行时依赖 | **0** | `npm ls --depth=0` → `(empty)` |
| Node | **v26.13.0**（本机实测；设计基线 Node 22 LTS） | `node -v`（`node:sqlite` 与类型剥离默认可用） |
| 脚本 | **55** 个 | `(git ls-files scripts \| Measure-Object -Line).Lines`（文件系统同为 55） |

> 历史验收（38 ✅ / 2 🟡）在 [archive/history/ACCEPTANCE.md](./archive/history/ACCEPTANCE.md)；历史实测在 [archive/history/VERIFY.md](./archive/history/VERIFY.md)。

---

## 目录职责

| 路径 | 管什么 | 备注 |
|---|---|---|
| `module-map.json` | 模块边界真相源（`ARCHITECTURE.md` 的可执行版） | `check:modules` 读它；13 个模块的 paths/dependsOn |
| `docs/` | 方向、执行、账本、现状契约、运维手册、历史 | 现行文档 + `modules/` + `upstreams/` + `archive/` |
| `docs/modules/` | 每个模块一份契约（目的/拥有/公开接口/不变量/失败模式） | 13 份；由 `module-map.json` 引用 |
| `docs/FUTURE-DESIGN.md` | 未来发展设计（设计树） | 主干/分支/叶子；不是现状 |
| `docs/PLAN.md` | 当前主干的执行计划 | 一次只写一个主干 |
| `docs/STATUS.md` | 已完成 / 进行中 / 缺口 / 风险 | `GAP-###` 总账 |
| `docs/DOC-SYNC.md` | 主干完成时的文档联动清单 | 文档依赖图 + 审计表 |
| `docs/UPSTREAM.md` | 上游/参考来源政策与索引 | 一项目一文件，见 `docs/upstreams/` |
| `docs/upstreams/` | 每个来源一份记录 | URL / 许可证 / 固定版本 / 用了什么 |
| `src/core/` | 平台底座：库/schema/迁移/事务、原子写、配置、审计、出站扫描、备份 | 11 个文件；`db.ts` 只留 `openDb` + 时间函数 |
| `src/interfaces/` | service CLI 的 17 组命令 + 注册表 + HTTP 门面 | 26 个文件；`src/service/cli.ts` 是入口薄壳 |
| `src/modules/` | 能力模块：`runtime`、`delivery`、`identity`、`tasks`、`executor`、`improvement`、`knowledge`、`org` | 52 个文件；每个模块有 `index.ts` 公开入口 |
| `src/service/` | 只剩入口薄壳（`cli.ts` / `loop.ts`）与集成测试 | 8 个文件；部署时只复制 3 个 |
| `src/render/` | 只剩 `cli.ts` 薄壳与渲染器测试 | 8 个文件；部署时只复制 2 个 |
| `src/ingest/` | 只剩 `cli.ts` 薄壳与入库测试 | 3 个文件；部署时只复制 2 个 |
| `src/shared/` | 只剩 summarize 测试与 package | 3 个文件；运行代码已迁 `modules/knowledge` |
| `scripts/` | PowerShell 5.1 主机脚本、计划任务、体检、部署自证 | 55 个文件，按域分组；部署仍扁平到 `bin\`，文件名不变；`.ps1` **必须 UTF-8 BOM** |
| `scripts/workbuddy-patch/` | WorkBuddy 补丁体、启动器、注入测试口 | 见 [WORKBUDDY-PATCH.md](./WORKBUDDY-PATCH.md) |
| `light/` | 技能名片、persona、模板、eval 用例 | 8 个技能目录 |
| `reference/upstream/` | 上游原样文档与未合并分支 | **不参与构建**；来源登记见 [UPSTREAM.md](./UPSTREAM.md) |
| `org.example/` | org 真相源的示例结构 | 渲染器输入样例 |
| `docs/archive/` | 历史计划、验收、实测、交接 | 见 [archive/README.md](./archive/README.md) |
| `_research/` | 本地调研原文（含生产敏感细节） | **被 `.gitignore` 排除，绝不入库** |
| `.workbuddy/` | 本地 agent 工作日志 | 未跟踪，不入库 |

---

## 常用命令

| 目的 | 命令 |
|---|---|
| 全量测试 | `npm test`（`pretest` 自动跑 `npm run check`） |
| 门禁 | `npm run check`（`check:modules:deep` + `check:docs`） |
| 覆盖率 | `npm run coverage`（已排除仓库外 WorkBuddy shim） |
| 模块边界 | `npm run check:modules`（加 `-- --strict` 有违规就退出 1；`check:modules:deep` 连深导入一起阻断） |
| 文档链接 | `npm run check:docs`（相对链接 0 断链才通过，排除 `docs/archive/`） |
| 分组测试 | `npm run test:bind` / `test:service` / `test:ingest` / `test:render` |
| 公开前扫描 | `node scripts/checks/check-public.mjs`（**零输出才算过**） |
| 空 catch 扫描 | `node scripts/checks/scan-catch.mjs` |
| 本地服务 CLI | `node src/service/cli.ts <组> <命令> [参数]`；用法见 [LOCAL-SERVICE.md](./LOCAL-SERVICE.md) |
| 渲染器 / 入库 | `node src/render/cli.ts ...` / `node src/ingest/cli.ts apply` |
| 主机体检 | `powershell -File scripts/doctor/doctor.ps1 -Root <部署根> -VaultRoot <vault 根> -Json` |
| 体检自测 | `powershell -File scripts/doctor/doctor.ps1 -SelfTest` |

> `-Root` 是 `%ProgramData%\anc` 部署根，`-VaultRoot` 是 `D:\anc` 原件根，**两个根不同**（REBUILD §1）。

---

## 历史文档

| 文档 | 内容 | 现在由谁取代 |
|---|---|---|
| [archive/history/PLAN-1.0.md](./archive/history/PLAN-1.0.md) | 1.0 产品目标与 DoD | `FUTURE-DESIGN` + `PRODUCT` |
| [archive/history/REFACTOR-ROADMAP.md](./archive/history/REFACTOR-ROADMAP.md) | P0–P7 模块化重构 | `FUTURE-DESIGN` 的完成状态 |
| [archive/history/ACCEPTANCE.md](./archive/history/ACCEPTANCE.md) | V1 40 条验收矩阵 | `STATUS` |
| [archive/history/VERIFY.md](./archive/history/VERIFY.md) | 87 节实测记录 | `STATUS` 的证据链接 |
| [archive/history/VERIFY-INDEX.md](./archive/history/VERIFY-INDEX.md) | VERIFY 章节索引 | 同上 |
| [archive/history/REUSE-MAP.md](./archive/history/REUSE-MAP.md) | 第一个上游的复用盘点 | `UPSTREAM` |
| [archive/history/UPSTREAM-COVERAGE.md](./archive/history/UPSTREAM-COVERAGE.md) | 第一个上游的功能覆盖 | `UPSTREAM` |
| [archive/history/UPSTREAM-ORIGINALS.md](./archive/history/UPSTREAM-ORIGINALS.md) | 第一个上游的原文索引 | `UPSTREAM` |
| [archive/history/D-HANDOFF-PROMPT.md](./archive/history/D-HANDOFF-PROMPT.md) | D 阶段交接提示词 | `archive` 留档 |
| [archive/history/AGENT-VERIFY-HANDOFF.md](./archive/history/AGENT-VERIFY-HANDOFF.md) | 新机器验证交接 | `RELEASE-CHECKLIST` + `archive` |
| [archive/history/VERIFY-HOST-TAKEOVER-20261105.md](./archive/history/VERIFY-HOST-TAKEOVER-20261105.md) | 主机接手核查 | `archive` 留档 |

---

## 维护规则

1. **文档分层**：方向、执行、账本、现状、运维、来源、历史，不混用。
2. **主干完成顺序**：先写 `STATUS` 证据 → 再标 `FUTURE-DESIGN` 分支/主干 → 归档 `PLAN` 快照 → 按 `DOC-SYNC` 全量核对下游文档 → 跑 `npm run check`。
3. **每份现行文档顶部有一行 `> 类型：...`**；新增文档必须登记到 `docs/doc-map.json`，并能从本文件链到。
4. **移动/改名**：同步改 `INDEX.md`、`doc-map.json` 和所有引用；改完跑 `npm run check:docs`。
5. `.ps1` 必须 UTF-8 BOM、`.json` 必须无 BOM（`check-public` 会查）。
6. 历史文档只追加说明，不改写事实；归档进 `archive/history/`，并在 `archive/README.md` 登记。

---

## 相关索引

- [../AGENTS.md](../AGENTS.md)：改代码前的最小必读清单。
- [./modules/README.md](./modules/README.md)：模块契约模板与索引。
- [./archive/README.md](./archive/README.md)：归档说明。
