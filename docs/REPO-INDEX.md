# 仓库导航与现状总览

> **这是什么**：一份给「刚打开这个仓库的人 / agent」用的索引 —— 目录各管什么、现在实测是多少、
> 常用命令怎么跑、文档按什么顺序读。**数字全部由命令实测**，取数命令写在表里，可自己复核。
>
> **数据时点**：2026-11-06（全量文档校准与闭环测试补完之后）。历史读数保留在 `VERIFY.md` 各节里，不是当前值。
> **本文件不替代契约**：改代码前先读 [AGENTS.md](../AGENTS.md)；设计裁决以 [FORK-DIRECTION.md](./FORK-DIRECTION.md) 为准。

---

## 一句话定位

Windows 单机 + 企业微信 + WorkBuddy 的公司 bot 系统：**确定性的事（状态、计时、完成判定、出站消息）
归本地小服务，模型只做结构化**。技能、persona、org 数据走 git → 渲染器部署；主机上手改线上文件视为事故。

---

## 实测数字（取数命令可复核）

| 指标 | 当前值 | 取数命令 / 来源 |
|---|---|---|
| 测试 | **155 / 155 pass** | `npm test`（2026-11-06 文档改动后重跑） |
| 覆盖率（行 / 分支 / 函数） | **91.34% / 81.34% / 93.68%** | `npm run coverage` |
| 测试文件 | **17** 个 | `package.json` 的 `scripts.test` 列表 |
| doctor 检查项 | **31** 项 | 21 个 `Add-Result` 字面量 + 10 个 `task-*` 循环项 |
| 计划任务 | **10** 个 | `grep -c "Name = '" scripts/register-tasks.ps1` |
| 技能目录 | **7** 个 | `ls -d light/skills/*/ \| wc -l` |
| 本地服务命令组 | **15** 组 | `grep -o "group === '[a-z]*'" src/service/cli.ts \| sort -u` |
| 终态 DoD | **38 ✅ / 2 🟡 / 0 ⬜** | [ACCEPTANCE.md](./ACCEPTANCE.md)（实测结论，本轮未改动） |
| 运行时依赖 | **0** | `npm ls --depth=0` → `(empty)` |
| Node | **v22.22.2** | `node -v`（`node:sqlite` 与类型剥离默认可用，无需实验标志） |
| VERIFY 章节 | **87** 节 / 509,452 字节 | 见 [VERIFY-INDEX.md](./VERIFY-INDEX.md) |

> 两个口径提醒：① `node src/service/cli.ts` 不带参数时打印的帮助文本只列 **11** 组，
> `cli.ts` 实际解析的是 **15** 组（缺的是 `dayend / eval / issue / patch / submission` 等）。
> ② doctor 项数按检查名计为 31，`-Json` 返回的 `checks.Count` 也是 31。

---

## 目录职责

| 路径 | 管什么 | 备注 |
|---|---|---|
| `docs/` | 契约、目标、部署运维手册、实测记录 | 20 份文档 + `archive/`；**文档是契约，不是说明书** |
| `src/service/` | 本地小服务：SQLite 真相源、CLI、HTTP、任务/提醒/绑定、迭代闭环 | 25 个文件，最大的模块 |
| `src/render/` | 渲染器：org → 个人 bot 工作区产物 | 12 个文件；`members/` 是成员与群对应的唯一真相 |
| `src/ingest/` | 入库进程：inbox 校验 → vault 写入 | 6 个文件，只支持 `apply` |
| `src/shared/` | 共享工具（audit / summarize） | 4 个文件 |
| `scripts/` | PowerShell 5.1 主机脚本、计划任务、体检、部署自证 | 48 个文件；`.ps1` **必须 UTF-8 BOM** |
| `scripts/workbuddy-patch/` | WorkBuddy 补丁体、启动器、注入测试口 | 见 [WORKBUDDY-PATCH.md](./WORKBUDDY-PATCH.md) |
| `light/` | 技能名片、persona、模板、eval 用例 | 7 个技能目录 |
| `reference/upstream/` | 上游原样文档与未合并分支 | **不参与构建**；什么时候会看它见 [UPSTREAM-ORIGINALS.md](./UPSTREAM-ORIGINALS.md) |
| `org.example/` | org 真相源的示例结构 | 渲染器输入样例 |
| `docs/archive/` | 归档的历史接手 / 验证记录 | 其中**附录 B 复现清单**是 VERIFY 里没有的独有内容 |
| `_research/` | 本地调研原文（含生产敏感细节） | **被 `.gitignore` 排除，绝不入库**，不清理、不提交 |
| `.workbuddy/` | 本地 agent 工作日志 | 未跟踪，不入库 |

---

## 常用命令

| 目的 | 命令 |
|---|---|
| 全量测试 | `npm test` |
| 覆盖率 | `npm run coverage`（已排除仓库外 WorkBuddy shim） |
| 分组测试 | `npm run test:bind` / `test:service` / `test:ingest` / `test:render` |
| 公开前扫描 | `node scripts/check-public.mjs`（**零输出才算过**） |
| 空 catch 扫描 | `node scripts/scan-catch.mjs` |
| 本地服务 CLI | `node src/service/cli.ts <组> <命令> [参数]`；组见上表，用法见 [LOCAL-SERVICE.md](./LOCAL-SERVICE.md) |
| 渲染器 / 入库 | `node src/render/cli.ts ...` / `node src/ingest/cli.ts apply` |
| 主机体检 | `powershell -File scripts/doctor.ps1 -Root <部署根> -VaultRoot <vault 根> -Json` |
| 体检自测（不碰真实环境） | `powershell -File scripts/doctor.ps1 -SelfTest`（用 `%TEMP%` 夹具证明每类检查确实能 FAIL） |

> `-Root` 是 `%ProgramData%\anc` 部署根，`-VaultRoot` 是 `D:\anc` 原件根，**两个根不同**（REBUILD §1）。
> 演练根 / 换盘符时两个都要传，否则会检查到生产数据。

---

## 文档地图（按读者顺序）

**先读**：[README.md](../README.md)（概览）→ [AGENTS.md](../AGENTS.md) / [CLAUDE.md](../CLAUDE.md)（改代码前的约定，两者正文一致）→ 本文件 → [WHAT-IT-DOES.md](./WHAT-IT-DOES.md)（部署完能干什么）。

| 主题 | 文档 | 一句话 |
|---|---|---|
| 契约与目标 | [FORK-DIRECTION.md](./FORK-DIRECTION.md) | 设计裁决**唯一真相源** D1–D26、组件设计、实测 T1–T22、风险登记 |
| | [PLAN.md](./PLAN.md) | PLAN 1.0：阶段 S/O/L/D、终态 DoD 40 条、每阶段 gate |
| | [ACCEPTANCE.md](./ACCEPTANCE.md) | V1 验收矩阵（DoD 逐条判据与实测结论） |
| | [RELEASE-CHECKLIST.md](./RELEASE-CHECKLIST.md) | 发布前四阶段检查清单（读者是 agent） |
| 部署与运维 | [AGENT-DEPLOY-COMPANY.md](./AGENT-DEPLOY-COMPANY.md) | 公司侧部署手册（给 agent 读） |
| | [AGENT-DEPLOY-EMPLOYEE.md](./AGENT-DEPLOY-EMPLOYEE.md) | 员工侧部署手册（给 agent 读） |
| | [AGENT-VERIFY-HANDOFF.md](./AGENT-VERIFY-HANDOFF.md) | 新机器验证交接：能验什么、25 条踩过的坑、工具速查 |
| | [D-HANDOFF-PROMPT.md](./D-HANDOFF-PROMPT.md) | D 阶段 B 路交班提示词（整段复制到新会话） |
| | [OPS.md](./OPS.md) | 主机运维：10 个计划任务、补丁与部署的唯一来源、维护开关 |
| | [REBUILD.md](./REBUILD.md) | 主机重建 runbook（含 `-VaultRoot` 用法） |
| | [ONBOARDING.md](./ONBOARDING.md) | 入职 / 离职 runbook |
| | [WORKBUDDY-PATCH.md](./WORKBUDDY-PATCH.md) | 补丁清单：群身份注入、启动器、runId、`/emit` 鉴权 |
| 组件用法 | [LOCAL-SERVICE.md](./LOCAL-SERVICE.md) | 本地小服务、CLI、`timezone` 只校验不参与计算的契约 |
| | [INGEST.md](./INGEST.md) | 入库进程 |
| | [RENDERER.md](./RENDERER.md) | 渲染器 |
| 实测与复用 | [VERIFY.md](./VERIFY.md) | append-only 实测记录，87 节 / 509 KB |
| | [VERIFY-INDEX.md](./VERIFY-INDEX.md) | **VERIFY 章节索引**（按问题查 + 全部 87 节行号） |
| | [REUSE-MAP.md](./REUSE-MAP.md) | 上游代码与设计逐项复用判定（默认复用，不重复造） |
| | [UPSTREAM-COVERAGE.md](./UPSTREAM-COVERAGE.md) | 上游功能模块 → 本项目覆盖对照 |
| | [UPSTREAM-ORIGINALS.md](./UPSTREAM-ORIGINALS.md) | 4 份上游原样文档的索引（正文在 `reference/upstream/originals/`） |
| | [docs/archive/](./archive/) | 历史接手 / 验证记录归档件 |
| 上游原文 | [SPEC.md](../SPEC.md)、`reference/upstream/originals/` | 原位保留并标「上游原文」，与 FORK-DIRECTION 冲突时以后者为准 |

---

## 维护约定（都是踩过的坑）

1. **VERIFY.md 是混合换行**且有大量行尾字面 CR：任何编辑工具都会规整出上千行假 diff。
   追加只能走字节级脚本（先 `--dry` 验命中数再落盘），做法记在 `VERIFY §86 / §87`。
2. `.ps1` 必须 UTF-8 BOM、`.json` 必须无 BOM（`check-public` 会查；PowerShell 5.1 按 GBK 读无 BOM 的中文脚本）。
3. **PS 5.1 按 GBK 解码 node 的 UTF-8 stdout**（`VERIFY §84.3`）：`& node ... \| ConvertFrom-Json` 会因中文 mojibake 失败。
   doctor 已用局部切 `Console.OutputEncoding` 规避；自己写脚本时用 node 直读或同样处理。
4. `\| Out-Null` 会吞掉错误但 `$LASTEXITCODE` 仍可能是 0；`git` / `Remove-Item` 这类命令后要显式查退出码（`§87 #11`）。
5. `node -e` 里 `process.argv[1]` 是脚本路径，第一个参数在 `[2]`（`§84.3`）。
6. 生产细节只放 `_research/`（不进 git）；转公开前跑 `check-public` 并人工过一遍全量 diff。

---

## 相关索引

- [VERIFY-INDEX.md](./VERIFY-INDEX.md)：VERIFY 87 节的「按问题查」入口与全部章节行号。
- [AGENTS.md](../AGENTS.md) 的「文档地图」：改代码前的最小必读清单。
