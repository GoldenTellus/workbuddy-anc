# workbuddy-anc — 项目指引

> 类型：agent 规则（canonical）· 最后整理：2026-11-08
>
> 本文件是 agent 开工前的最小必读。`CLAUDE.md` 只是指向本文件的短指针，不再维护第二份正文。

GoldenTellus 的二次开发仓库，基于 [HA7CH/ai-native-company](https://github.com/HA7CH/ai-native-company)@`90e4fb2`（MIT）。目标：小团队用一台 7×24 的 Windows 主机跑**公司 bot**，每个员工电脑跑**员工 bot**；执行引擎是腾讯 **WorkBuddy**，IM 是**企业微信**，公司知识放在 markdown vault 里。

本库**不自己实现** agent 框架、**不写** IM 网关——用 WorkBuddy 与企业微信现成能力。本库做它们之外必须确定性完成的部分：状态、计时、完成判定、出站消息、渲染、入库、主机运维。

## 1. 现在到哪了

- 13 个模块全部 `current`；`src/service` / `src/render` / `src/ingest` 只剩入口薄壳。
- `npm test` **216/216**；`npm run check`（`check:modules:deep` + `check:docs`）通过。
- 文档已分层：方向 / 执行 / 账本 / 现状 / 运维 / 来源 / 历史。
- 1.0 的历史计划、路线图、验收、实测已归档；不要再把 `PLAN-1.0` 当现行计划。

**现行入口**：

| 问题 | 文档 |
|---|---|
| 要建什么、完成到哪 | [docs/FUTURE-DESIGN.md](./docs/FUTURE-DESIGN.md) |
| 当前主干怎么干 | [docs/PLAN.md](./docs/PLAN.md) |
| 做完什么、还缺什么 | [docs/STATUS.md](./docs/STATUS.md) |
| 主干完成时文档怎么联动 | [docs/DOC-SYNC.md](./docs/DOC-SYNC.md) |
| 现在代码怎么组织 | [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) + [docs/modules/](./docs/modules/) |
| 现在能做什么 | [docs/PRODUCT.md](./docs/PRODUCT.md) |
| 文档/目录导航 | [docs/INDEX.md](./docs/INDEX.md) |

## 2. 文档地图（改代码前先读）

| 文件 | 内容 |
|---|---|
| **`docs/ARCHITECTURE.md`** | 13 个模块、依赖规则、源码/部署布局；`module-map.json` + `check:modules` 可执行 |
| **`docs/FUTURE-DESIGN.md`** | 未来设计树：主干/分支/叶子；主干 0 是常驻清债 |
| `docs/PLAN.md` | 当前主干的执行计划；一次只写一个主干 |
| `docs/STATUS.md` | 已完成 / 进行中 / 缺口 / 风险；`GAP-###` 总账 |
| `docs/DOC-SYNC.md` | 主干完成时的文档联动清单与审计表 |
| `docs/PRODUCT.md` | 部署完能干什么：技能、命令组、计划任务、能力边界 |
| `docs/DECISIONS.md` | 设计裁决台账（D1–D26 及后续）；与代码冲突时先改代码或改决策，不要两边漂 |
| `docs/modules/` | 13 份模块契约：职责/拥有/公开接口/不变量/失败模式/测试 |
| `docs/LOCAL-SERVICE.md` | CLI / HTTP 契约 |
| `docs/RENDERER.md` / `docs/INGEST.md` / `docs/WORKBUDDY-PATCH.md` | 渲染 / 入库 / 补丁契约 |
| `docs/DEPLOY-COMPANY.md` / `docs/DEPLOY-EMPLOYEE.md` | 给 agent 的部署手册 |
| `docs/OPS.md` / `docs/REBUILD.md` / `docs/RELEASE-CHECKLIST.md` | 主机运维 / 重建 / 发布门禁 |
| `docs/UPSTREAM.md` + `docs/upstreams/` | 上游/参考来源、许可证、用了什么 |
| `docs/archive/` | 历史计划、验收、实测、交接；只读，不再当现行契约 |

## 3. 关键裁决（不要偏离）

1. **可以改 WorkBuddy**：patch、封装、读凭据与内部数据都允许（D16）；每处改动按 `DECISIONS` 登记、随升级重放、可一键关闭。
2. **当前实现已落“四类群 + 三角色”地基**：员工群/部门群/公司大群/老板 1:1；boss/manager/employee；`people/groups/manager_scopes` 是真相，`chat_bindings` 只保留员工群兼容层。**员工 bot 仍按旧实现**，主干 4 返工；真实群验收见 `STATUS §3.5`。
3. **确定性的事不交给模型**：任务/工单状态、计时提醒、“完成”判定、出站消息归本地服务；SQLite 是真相，markdown 是投影。
4. **vault 分两区**：共享区全员只读、内部区只有公司侧能读写；两个独立 git 目录，原件不进 git。
5. **公司 bot 只做结构化，入库进程只校验和提交**，不调模型；覆盖写必须带读取时的 base hash。
6. **运行身份（D25）**：直接用管理员账号部署，不建专用用户；保留“主机不开自动登录、本机不存账号密码”。
7. **技能、模板、org 数据只走 git → 渲染器部署**；主机上手改线上文件视为事故。
8. **闭源不构成排除理由（D26）**：WorkBuddy 做不到时默认加一层（patch/hook/代理/注入），不是降级需求；每层都要登记、随升级重放。

## 3.5 文件驱动工作法（不是聊天驱动）

- **聊天只用于讨论；结论必须落到文件。** 没写进仓库的结论 = 没发生，下一次会话不会记得。
- **文件是跨会话唯一记忆**：开工先读 `STATUS` / `PLAN` / `FUTURE-DESIGN` / 模块契约；不要靠“上次聊过”推进。
- **顺序**：先改账本/计划/契约（GAP、PLAN、模块文档）→ 再执行 → 再补证据和状态；不是做完再想怎么记。
- **完成不是“代码写完”**：按 `STATUS` §3.6 逐项更新；没有账本更新不算完成。
- **需要真实环境的**不阻塞：登记 `STATUS` §3.5 的 ACC，继续做本地能做的，统一收尾时跑。
- **每次讨论形成结论**：在 `STATUS` §3.4 留一行，哪怕“已核对无变化”。

## 4. 约定

- **模块边界**：新代码按 `ARCHITECTURE` 归块；跨模块只 import 对方 `index.ts`；不直接读别人的表。改完跑 `npm run check:modules:deep`。
- **主干流程**：从 `FUTURE-DESIGN` 选主干 → 写 `PLAN` → 做 → `STATUS` 记证据 → 按 `DOC-SYNC` 全量核对文档 → 标 `FUTURE-DESIGN` → 归档 PLAN 快照。
- **设计反哺**：未来主干如果纠正旧行为/旧契约，必须在 `STATUS` §3.3 登记 `GAP`（旧行为/目标行为/影响文件），并同步改受影响的现状文档；不能在新主干里静默改掉旧行为。
- **主干 0 复检**：每次讨论形成结论、或完成一个任务/主干后，逐项看 `FUTURE-DESIGN` 0.1–0.8，有新增/关闭就更新 `STATUS` 的 `GAP`，没有变化也在 `STATUS` §3.4 留一行“已核对无变化”。
- **真实环境验收不阻塞**：需要真实群、凭据、公司主机或现场动作的，登记到 `STATUS` §3.5 的 ACC 批次，继续做能做的；统一收尾时一次跑，通过前主干保持 🟡 待验收。
- **完成即更新**：任何完成都按 `STATUS` §3.6 更新 `GAP`、`FUTURE-DESIGN` 分支/主干、`PLAN`、模块契约/审计行和测试数；只改代码或文档，不算完成。
- **文档**：中文为主；每份现行文档顶部有 `> 类型：...`；新增/移动文档要登记 `docs/doc-map.json`、更新 `docs/INDEX.md`、跑 `npm run check:docs`。
- **代码**：TypeScript + Node 22 LTS（设计基线；本机 2026-11-09 实测 v26.13.0 亦可跑 216/216）；零或极少运行时依赖；主机脚本 PowerShell 5.1。
- **流程**：分支 → PR → 验证 → squash merge；维护者明确要求时可直接提交 main。
- **上游**：借代码/设计前先查 `docs/UPSTREAM.md` 与 `docs/upstreams/`；许可证不明只学概念，不拷代码。
- **计划可变，但改要留痕**：`PLAN` 是当前最佳判断，不是合同；调整理由写进 `PLAN` 顶部或 `STATUS`，不要静默改。
- **AGENTS.md 是唯一正文**；`CLAUDE.md` 只是指针。

## 5. 铁律：泄密防线

- `_research/` 与任何含生产细节的内容**绝不 commit**（`.gitignore` 已排除，别绕过）。
- 改动 WorkBuddy 的产物（patch diff、反编译中间件、提取脚本输出）同样不进仓库；原件放 `_research/workbuddy/`，仓库只放清单与脚本骨架。
- 绝不进仓库：企微 webhook 地址、corpid / corpsecret、WorkBuddy 或企微账号 ID、按 D16 读取的任何凭据值、真实主机名、内网地址、带真实用户名的本机路径、人名。文档用 `%USERPROFILE%`、`\\主机\vault`、`<userid>` 占位。
- 转公开前必跑：`node scripts/checks/check-public.mjs`，零输出且退出码 0 = 通过。`.ps1` 必须 UTF-8 BOM，`.json` 不许带 BOM。
- 脚本是绊线不是证明；转公开前仍需人工过一遍全量 diff。

## 6. 常用命令

```powershell
npm test                 # pretest 自动跑 npm run check
npm run check            # check:modules:deep + check:docs
npm run check:docs       # 只查文档链接/类型/入口
npm run coverage
npm run test:service     # 分组测试：test:bind / test:ingest / test:render
node scripts/checks/check-public.mjs
```
