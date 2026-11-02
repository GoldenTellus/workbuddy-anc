# 上游功能模块 → 本项目覆盖对照

> **视角说明**：`docs/REUSE-MAP.md` 是「本项目需要什么 → 上游有没有」。
> 这份是**反过来**：以上游为基准拆出功能模块，逐块看本项目覆盖了哪些、哪些没覆盖、没覆盖的是"不用做"还是"漏了"。

## 0. 方法与口径

- 上游：`HA7CH/ai-native-company@90e4fb2`（**只有 33 个文件**，是个轻量仓库——大部分"功能"在 `SPEC.md` 的设计里，代码只占 `light/` 与 `tools/`）。
- 模块划分依据：`SPEC.md` 的 12 章 + `light/`（skills / vault-service）+ `tools/harness-proxy` 的实际文件。
- 覆盖状态口径：

| 标记 | 含义 |
|---|---|
| ✅ | 本项目有等价实现，语义一致 |
| 🟡 | 有实现但语义或范围不同（差异写在"差在哪"） |
| 🔄 | 用**另一种机制**达成同一目的（机制不同、目的相同） |
| ⬜ | **没做**，且不是"不适用"——是真空白 |
| ➖ | **不适用**：上游的前提在本项目不成立（写在"为什么"） |

---

## 1. 总表（20 个模块）

| # | 上游模块 | 上游位置 | 状态 | 本项目在哪 |
|---|---|---|---|---|
| 1 | 概念模型（Company–Vault–Member–Bot） | SPEC §2 | ✅ | `light/templates/org/`、`src/render/org.ts` |
| 2 | 每 bot 一个 cwd（隔离枢轴） | SPEC §2.2 | 🔄 | WorkBuddy 工作区目录（R6 实测隔离成立） |
| 3 | Vault（共享知识库，git repo） | SPEC §2.3 | ✅ | `D:\anc\vault-shared` / `vault-internal`（D14 两区） |
| 4 | 写路径：inbox 自动结构化入库 | SPEC §2.4 | ✅ | `src/ingest/`（apply / validate / git）+ 技能 `anc-ingest-company` |
| 5 | 问题模型（vault 诊断层） | SPEC §2.5 | ✅ | `light/templates/vault/company/problem-model.md` |
| 6 | Gateway 层（cc-connect） | SPEC §3.1 | ✅ | 功能等价：WorkBuddy 内置企微通道（实现不同，目的达到） |
| 7 | Harness 层（统一接口，**可换后端**） | SPEC §3.2 | ⬜ | **缺"可换模型"**：锁死在 WorkBuddy 自带模型。补法见 §3.1 |
| 8 | 部署层（一台常驻机的工程学） | SPEC §3.3 | ✅ | `docs/OPS.md` + `docs/REBUILD.md` + 9 个计划任务 |
| 9 | Persona 系统（七段式模板） | SPEC §4.1 | ✅ | `light/templates/company-bot.md`、`light/personas/` |
| 10 | persona-as-code 管线 | SPEC §4.2 | ✅ | `src/render/`（git 变更 → 渲染 → 部署，D15） |
| 11 | 对话层与任务层 | SPEC §4.3 | ✅ | 任务登记/完成/提醒（`src/service/`） |
| 12 | Skill 系统（格式 + 部署） | SPEC §5 | ✅ | `light/skills/`（5 个技能）+ 渲染器同步 |
| 13 | **技能迭代闭环**（聊天挖掘→问题池→devbot→eval） | SPEC §5 | ⬜ | **没有**。见 §3.1 |
| 14 | Onboarding：对话式冷启动 | SPEC §6 | 🟡 | `anc-interview` 技能做员工访谈；**公司级建库**没有对话式流程 |
| 15 | 安全模型（Identity / Scope / Model 三层） | SPEC §7 | ✅ | D19–D25 裁决 + ACL + 出站扫描 + 审计 |
| 16 | 运维与可观测（防假绿、watchdog、日报） | SPEC §8 | 🟡 | `doctor`（28 项）+ `anc-watchdog` + 备份；**没有日报** |
| 17 | 包形态与命令面（npm + `anc` CLI） | SPEC §9 | 🔄 | 不发布 npm 包；部署目录 + `cli.ts` 子命令 |
| 18 | vault-service（Cloudflare R2 + MCP 五工具 + `_history/`） | `light/vault-service/` | 🔄 | 本地 vault + **git 充当版本历史** + CLI 代替 MCP |
| 19 | harness-proxy：`system-prompt-proxy` | `tools/harness-proxy/` | ➖ | 前提是能改写引擎的请求；WorkBuddy 闭源，改不了 |
| 20 | harness-proxy：`tool-turn-filter` | `tools/harness-proxy/` | 🔄 | **思路已用上**：出站旁白过滤（FORK §11），但位置不同——上游在代理层过滤，我们在补丁里包 `sendReply` |
| 21 | 三个技能：`anc-ingest` / `anc-join` / `anc-onboard` | `light/skills/` | 🟡 | ingest → `anc-ingest-company`（改写）；join 的名片规则 → `light/skill-cards/`；onboard → 见 #14 |

**统计（2026-11-03 按"零差距"口径重判）**：✅ 11 · 🔄 4 · 🟡 3 · **⬜ 2** · ➖ 0（共 20 个功能模块 + 技能分项）

> ⬜ 两项是 1.0 的硬目标：**迭代闭环**（#13）与 **Harness 可换后端**（#7）。见 §3。

---

## 2. 逐模块要点（只写有差异的）

### #2 每 bot 一个 cwd → 换成 WorkBuddy 工作区

上游靠"每个 bot 一个独立 cwd"做隔离，persona 放在 cwd 里的 `CLAUDE.md`。

本项目没有 cwd 概念，对应物是 **WorkBuddy 工作区目录**（`%USERPROFILE%\WorkBuddy\<工作区>\CODEBUDDY.md`）。
R6 实测过：切到另一个工作区后，读的是该工作区的规则，**不会串读 Claw 的 persona**（见 VERIFY §12）。

差在哪：上游的 cwd 隔离是进程级的；这里靠应用自己的目录约定，**由 R6 的实测保证**，不是操作系统强制。

### #6 / #7 Gateway 与 Harness → 整层不适用

上游架构：`IM ←→ Gateway(cc-connect) ←→ Bot ←→ Harness ←→ Vault`，本库只做 Gateway 和 Vault 之间的编排。

本项目直接吃 WorkBuddy 内置的企微通道（D18 实测：企业版与个人版都没有群身份，只能靠补丁），
所以 **Gateway 层和 Harness 层都不存在**——不是"没做"，是这两层的职责被 WorkBuddy 内部消化了。

代价写在 FORK §4 D16/D17：能力依赖闭源产品，得靠补丁维持；厂商升级就要重放（`anc-wb-patch` 技能 + R7）。

### #13 技能迭代闭环 → 真的没做（唯一的真空白）

上游 SPEC §5 把这条叫"本库的灵魂"：

```
使用/事故 → 聊天挖掘（每日分析对话，发现答错/新需求）→ 问题池 triage（聚类去重、频率信号）
→ issue → devbot 实现 → review → merge → 自动部署 → eval 回归
目标：从「答错一次」到「校验 skill 上线」在一天内闭环
```

本项目**一条都没有**：
- 没有聊天挖掘（不改群里对话去发现"bot 答错了"）
- 没有问题池
- 没有 devbot（`docs/REUSE-MAP.md:203` 就写着「上游由 devbot 改，这里没有对应角色」）
- 没有 eval 回归

为什么没做：这条链条的前提是"有一个会自己改技能的 agent"。本项目的技能改动走 D15（人工 git 变更 → 渲染 → 部署），
`anc-wb-patch` 只做补丁重放，不做技能改进。

**如果要补**，最小可行的一步不是 devbot，而是**"答错记录"**：把群里"不对/不是这个"这类反馈落一条记录（谁、什么任务、bot 回了什么），
攒起来人工看。这能承接上游"聊天挖掘"的第一步，成本很低。

### #14 Onboarding → 拆成了两个不同的东西

上游的 onboarding 是一场**访谈**：问公司是做什么的、业务域、术语，产出 `company/profile.md` + 术语表 + vault 目录设计稿。

本项目有两个相关件，但都不等价：
- `anc-interview` 技能：**给员工**做 11 题结构访谈，归档到内部区；
- `src/render/onboard.ts` + `anc-onboard` 技能：**给新员工**渲染接入包（persona、群映射、技能名片）。

**缺的是"公司级冷启动"**：新客户从零到有 vault，目前靠人照着 `docs/REBUILD.md` 手工建。
上游那套"访谈出来"的体验没有。

### #16 运维与可观测 → 缺日报

上游 §8 有四样：防假绿探针、watchdog、**日报**、成本策略。

本项目有前三样里的两样半：
- 防假绿：`doctor` 28 项 + `heartbeat` 判 `loop.log` 新鲜度 ✅
- watchdog：`anc-watchdog` 独立任务 ✅
- **日报**：⬜ 没有（token 用量、活跃度、问题挖掘都没有）
- 成本策略：➖ 不适用（单人单机，没有"多 bot 抢订阅池"的问题）

日报缺得不冤：本项目的成本结构不同（WorkBuddy 自带额度）。但"每天一条运营摘要"对单人也有用——只是优先级不高。

### #18 vault-service → git 顶替了 R2 + `_history/`

上游：Cloudflare R2 存文件、Worker 暴露 MCP 五工具、覆盖写前把旧版存 `_history/<path>/<时间戳>`。

本项目：本地目录 + **git 就是版本历史**（`git log` 可查可回滚），CLI 代替 MCP。
好处是零外部依赖、离线可用；差在**没有跨机实时同步**（要共享得靠 SMB，见 `docs/OPS.md` vault 共享）。

### #20 tool-turn-filter → 同一个问题，不同的落点

上游在 harness-proxy 里丢"含 tool_use 轮次的 text"，因为它在网关位置能看到结构化轮次。

本项目看不到轮次（`emitMessage` 只有整条消息），所以落在**出站最后一个可拦点**：包 `sendReply` 按行匹配过程话。
效果相近，但我们的方法是**启发式**（词表），上游是**结构判断**（有没有 tool_use）。
这也解释了为什么 T21 三次实测"persona 词表无效"——词表在出站侧才管用，prompt 侧管不了。

---

## 3. 距零差距还差什么

> **1.0 的要求是"覆盖上游全部功能、没有差距"**（PLAN 1.0 §2 第 5 条）。
> 这一节列"从现在到零差距"的清单。

### 3.1 两个 ➖ 不适用，重新判

之前把 Gateway 和 Harness 标成"不适用"，理由是"本项目没有这两层"。**按功能等价重判，结论不一样**：

| 模块 | 之前 | 现在 | 理由 |
|---|---|---|---|
| **Gateway（cc-connect）** | ➖ | **✅ 功能等价** | 上游要的是"让 bot 接进 IM"。本项目用 WorkBuddy 内置企微通道，这个功能**做到了**。实现不同不算差距 |
| **Harness（统一接口、可换后端）** | ➖ | **⬜ 缺"可换"** | 上游能换 provider、能挂兜底模型。本项目锁死在 WorkBuddy 自带模型——**这个能力我们没有**，属真差距 |

**Harness 怎么补**（PLAN §2.1 的手段）：

```
拦模型调用层 → 拿到请求 → 改端点 / 改模型名 → 转发到别的 provider
```

和"拦 https.request 拦升级检查"是同一类手段，只是目标换成模型 API。难点在**先定位模型调用在哪个模块**（需要解包 app.asar 或 hook Module._compile 观察）。

### 3.2 零差距清单（三项）

| # | 缺什么 | 补法 | 在哪 |
|---|---|---|---|
| 1 | **迭代闭环全链**（收集 / 汇总 / devbot / eval） | 按上游设计实现，devbot 做**全自动** | PLAN 阶段 L |
| 2 | **Harness 的可换后端** | 拦模型调用层 + 换端点 | PLAN §2.1 手段表 |
| 3 | **eval 能测模型遵从度** | 驱动 WorkBuddy 回放，比对回答（CDP 已有） | PLAN L6 |

**这三项补完，20 个模块就没有 ⬜ 了。**

### 3.3 还剩下的差异（不算差距，但要写明）

| 项 | 上游 | 本项目 | 为什么不算差距 |
|---|---|---|---|
| 每 bot 一个 cwd | 进程级隔离 | WorkBuddy 工作区（R6 实测不串） | 隔离这个**目的**达到了 |
| 包形态 | npm 包 + anc CLI | 部署目录 + cli.ts | "有命令面"达到了 |
| vault-service | R2 + MCP + _history/ | 本地 + git + CLI | "版本历史 + 读写接口"达到了 |
| tool-turn-filter | 结构判断 | 词表启发式 | **这个算差距**（判据弱），在 PLAN 阶段 O 处理 |

### 3.4 结论

**零差距可达到**，工作量集中在三项（迭代闭环 / Harness 可换后端 / eval 测遵从度）。
没有一项被"闭源"卡死——闭源只是换成"加一层"的做法（PLAN §2.1）。
