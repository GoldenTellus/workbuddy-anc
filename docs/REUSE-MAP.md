# 上游复用清单

版本:0.3(2026-11-02)。0.3 补录 6 条原表漏判(`tools/harness-proxy/tool-turn-filter.mjs`、`light/vault-service/README.md`、`tsconfig.json` 的误判、`docs/RESEARCH.md` 等),并新增 §6「按阶段取用」把本表与 PLAN 2.0 的 A/R/H/C/V 对齐。0.2(2026-11-01)。范围:上游 main(`90e4fb2`)全部内容 + [`reference/upstream/unmerged/`](../reference/upstream/unmerged/README.md) 里三个未合并分支。对照的设计是 [FORK-DIRECTION.md](./FORK-DIRECTION.md)。

> **0.2:上游文件已按本表整理**(2026-11-01)。下文的「来源」列仍写上游原路径(便于对照上游),现在的位置是:
>
> - 已删除(按本表「不适用」或已被本库实现取代):`light/skills/anc-ingest/`、`light/skills/anc-join/`、`light/vault-service/`、`tools/harness-proxy/`。原样随时可取:`git show 90e4fb2:<路径>`。
> - 挪到 [`reference/upstream/`](../reference/upstream/README.md)(以后可能用,写明了什么时候用):`anc-onboard/SKILL.md`、`anc-onboard/vault-skills/anc-ingest.md`、`vault-service` 的 MCP RPC 骨架、三个未合并分支。
> - 挪进本库模板目录:`vault-templates/company/`、`vault-templates/collab/` → `light/templates/vault/`。
> - 上游设计文档(SPEC、LESSONS、LIGHT-MVP、RESEARCH、M1-DESIGN)留在原位,开头标了「上游原文」。

文中「M1-DESIGN §n」指上游的 M1 设计 [`docs/M1-DESIGN.md`](./M1-DESIGN.md)(main 版),和本库 1.1 的 M1 无关（1.1 已归档：`git show 52e816a:docs/PLAN.md`）;写明「该分支」的指 `reference/upstream/unmerged/feat-m1-w1/docs/M1-DESIGN.md`。两版的差异见 M1-DESIGN 开头的本库说明。

判定分五档:**直接用**(基本原样)/ **改写**(结构保留、内容要改)/ **借鉴**(只取思路)/ **仅参考** / **不适用**。

## 1. 总体结论

- **设计层大部分能沿用**:vault 规范、inbox 管线、问题模型、状态层裁决(知识用文件、状态用事务)、规则冻结、A2A 信封、安全红线、运维约定(doctor、watchdog、防假绿、配置变更流程)。要改的主要是 Windows 和 WorkBuddy 带来的落地方式。
- **代码层最值钱的是 `feat-m1-w1` 的渲染侧**:frontmatter 解析、org 读取与校验、三层 persona 叠加、路由表生成、指纹与差分闸门、测试骨架。改成输出两份 `CODEBUDDY.md` 和一份「群 → 员工」映射后,渲染侧约六成能直接搬。它只有纯函数和测试,**落盘代码(备份 → 原子写 → 校验 → 还原)没有实现**,`deploy` / `rollback` 只是桩。
- **轻形态的 skill 文本可以大量照用**:访谈 11 问、名片模板与三槽位校验、入库技能正文、问题模型、协作三件套、vault 使用纪律。要替换的是写死的 MCP 工具名、`claude mcp add` 和 `~/.claude/skills/` 路径。
- **vault 服务的云部分用不上,但两段逻辑要搬进入库进程**:覆盖写必须带读取时的版本号(base_etag),原件只许新建。
- **用不上的**:cc-connect 配置渲染、harness-proxy、launchd / systemd / bubblewrap、Cloudflare Worker + R2 部署、批量 provisioning、第三方模型接入。

## 2. 按组件

### 2.1 渲染器:生成 CODEBUDDY.md 与群映射

来源都在 `reference/upstream/unmerged/feat-m1-w1/`。

| 上游 | 判定 | 用在哪 | 要改什么 |
|---|---|---|---|
| `src/org/frontmatter.ts` 的 `parseFrontmatter` | 直接用 | 解析 company / roles / members | 开头剥 UTF-8 BOM:第 157 行要求首行精确等于 `---`,记事本和 PowerShell 写出的带 BOM 文件会失败 |
| `src/org/schema.ts` 的 `FieldReader` / `MapReader`、`parsePersonaBody` / `checkBodySections` | 直接用 | 逐字段读取、未知键报错带行号、H2 段落归属校验 | 段名表按新模板调整 |
| `schema.ts` 的 `buildCompany` / `buildRole` / `buildMember`、`checkOrg` | 改写 | org 真相源 | 删飞书和 cc-connect 字段(`platform: feishu`、`model`、`mode`、`allowed_tools`、`feishu.*`、devbot 特判);加企微字段(userid、群标识、群 webhook 引用名、个人 bot 接入状态、WorkBuddy 席位);目录名允许中文,另设 ASCII `id` 供文件名和环境变量名用 |
| `src/org/load.ts` 的 `loadOrg` | 直接用 | 有任何一条错误,坏数据就不进渲染 | 去掉 devbot 殿后的排序 |
| `src/render/persona.ts` + `templates/persona-base.md` | 改写 | 生成公司 bot 和个人 bot 两份 `CODEBUDDY.md` | 两份 base 模板;公司 bot 的 member 层改为可选;删 TOML 专属 lint;路径 lint 改认 `C:\` 和 `\\主机\`;加 8000 字符闸门(建议 6500 报警告、7500 报错,报错时列出各段长度) |
| `src/render/routing.ts` | 直接用 | persona 里的 vault 路由表 | `vaultRoot` 按目标传(公司 bot 用本地路径,个人 bot 用 UNC);排除 `inbox` |
| `toml.ts` 里的 `sha256` / `stableStringify` / `computeInputsHash` / 指纹头 | 直接用 | `CODEBUDDY.md` 的指纹注释、`groups.json` 的指纹,用来查漂移 | 指纹注释约 100 字符,计入 8000 预算 |
| `src/render/validate.ts` 的 `validateSemantic`(secret 引用存在性、明文拦截、ID 格式)和 `validateDiff`(`--adopt` / `--allow-scale`) | 改写 | 群映射校验;已有 `CODEBUDDY.md` 时不直接覆盖 | 删 cc-connect 专属检查;ID 格式改成企微的 |
| `validateRoundTrip` | 借鉴 | 落盘后读回,对拍 hash | 去掉 TOML 解析 |
| `src/cli.ts` | 仅参考 | 退出码 0/1/2/3、`--json`、错误固定两行 `ERROR` + `FIX` | 命令全是桩 |

**要新写的**:落盘流程(设计见该分支 `docs/M1-DESIGN.md` §4.4)。Windows 上目标文件可能正被 WorkBuddy 打开,`rename` 会报 EPERM / EBUSY,要加重试。

### 2.2 个人 bot 接入脚本与技能名片(FORK §5.3)

| 上游 | 判定 | 用在哪 | 要改什么 |
|---|---|---|---|
| `light/skills/anc-join/SKILL.md` 铁律三条 | 直接用 | 个人 bot 的 `CODEBUDDY.md` | — |
| `anc-join` 名片生成规则、名片模板、三槽位校验(单行、非空、≤200 字) | 改写 | 接入脚本第 3 步,**这批里价值最高** | 读取路径改成 `\\主机\vault\skills\<name>\SKILL.md`,读不到就去群里问公司 bot;删 `vault_read` / `claude mcp add` / `~/.claude/skills/`;两份名片由同一个模板生成,不手写 |
| `docs/LIGHT-MVP.md` 的名片安全底座五条 | 直接用 | 每张技能名片 | — |
| v1 / v2 `vault-service/src/index.ts` 的 `INSTRUCTIONS`(先读路由、查不到说尚未入库、搜索结果只是样本、改前先读) | 直接用 | 两份 `CODEBUDDY.md` | — |
| `validateDiff` 的 `--adopt` 闸门 | 改写 | 已有 `CODEBUDDY.md` 时先备份、提示确认 | 见 2.1 |
| M1-DESIGN §8 用第二个系统用户当干净机测试 | 借鉴 | 接入脚本用第二个 Windows 用户实测 | — |
| `anc-join` 第 1、2 步 | 不适用 | — | MCP 接入与自检换成 FORK §5.3 第 4 步 |

### 2.3 公司 bot 的技能

| 上游 | 判定 | 用在哪 | 要改什么 |
|---|---|---|---|
| `anc-onboard/SKILL.md` 铁律、进度行约定、`onboarding-state.md` 断点续走 | 改写 | 管理员私聊里的建库技能 | 写入改投 inbox,inbox 要支持批量(一次几十个文件) |
| `anc-onboard` 访谈 11 问(含问题模型五问) | 直接用 | D3 访谈 | — |
| `anc-onboard` 目录骨架、根路由三条纪律、「触发词 / 简介」两行约定 | 改写 | FORK §5.4 | `vault_write` 改投 `inbox/pending/` |
| `vault-skills/anc-ingest.md` 铁律、数据源表、步骤 1/2/4/5 | 直接用 | 公司 bot 的入库技能 | — |
| `anc-ingest` 步骤 3(`content_base64`) | 改写 | 原件入库 | 从 `%TEMP%\workbuddy-wecom-media\` 复制进 `inbox/pending/<id>/`,附元数据 JSON |
| `vault-templates/company/problem-model.md` | 直接用 | D3 | — |
| `vault-templates/collab/` 三件套 | 改写 | 跨部门项目协作 | 「主控(人或 devbot)」改成公司 bot。当日任务以 SQLite 为真相(FORK §5.7),和任务看板分开 |
| SPEC §5 技能三个结构约定、中英双语触发词、只信 org 内部技能 | 直接用 | 所有技能 | 禁装 WorkBuddy 技能市场的第三方技能 |
| SPEC §4.3 「技能库是流程登记表,不是能力白名单」「不向用户展示内部路径与任务状态」 | 直接用 | 公司 bot 的 `CODEBUDDY.md` | — |

### 2.4 vault 与入库管线(FORK §5.4)

| 上游 | 判定 | 用在哪 | 要改什么 |
|---|---|---|---|
| SPEC §2.3 vault 结构、frontmatter、路由、诚实条款、易变事实单点存放 | 直接用 | vault | 列出 canonical 清单(成员与群的对应、口径等) |
| SPEC §2.4 inbox 管线:`.meta.txt`、`inbox/failed/`、每日兜底、入库后群发摘要 | 改写 | 入库进程 | 补 `failed` 状态 |
| v2 `toolWrite` 的 base_etag | 改写 | 入库进程**核心** | inbox 条目带读取时的 git blob hash,和 HEAD 不一致就拒写并回执公司 bot;新建文件要求路径不存在 |
| v2 `handleRawPut` 原件只许新建 | 改写 | `_originals/` 已有文件一律拒写 | — |
| v1 / v2 `normalizePath` / `hasControlChar` | 改写 | 入库路径校验 | 补 Windows 规则:反斜杠、盘符、`:`、CON / NUL / COM1 等保留名、结尾的点和空格、大小写冲突、路径长度 |
| v2 拒写二进制路径、单个文本 ≤1MB | 直接用 | 入库进程 | — |
| `VAULT-FORMS.md` 形态 C(单机目录、不上云) | 直接用 | 就是本库的形态 | — |
| `VAULT-FORMS.md` 原件进 git 后删不掉、`_ocr/` 文本投影、`_history` 不是备份 | 借鉴 | 原件存放与离机备份 | 见 §5 待定 |
| v2 `toolSearch` 按文件配额与截断报告 | 借鉴 | 只有自写检索脚本时才需要 | — |
| `light/cli/anc.mjs` 的 `cmdPull` 清单增量、`pool()` | 借鉴 | T12 不成立时的退路 | 退路改用计划任务跑 `robocopy \\主机\vault <本地目录> /MIR`,镜像设只读。`push` / 冲突处理不适用(员工不写 vault) |
| R2、`_history/`、`toolHistory`、manifest | 不适用 | — | 用 git log |

### 2.5 本地小服务(FORK §5.5–5.7)

| 上游 | 判定 | 用在哪 | 要改什么 |
|---|---|---|---|
| SPEC §2.3 状态层:SQLite 为真相,「完成」与出站消息同一事务提交,markdown 投影可用 `reproject` 重建 | 直接用 | 状态与 outbox | — |
| SPEC §5 规则冻结(`policy_version` + 内容 hash,工作流开始时冻结) | 直接用 | 访谈与任务规则 | — |
| SPEC §7 A2A 最小信封七字段(`protocol` / `survey_id` / `message_id` / `reply_to` / `type` / `rule_version` / `payload`) | 改写 | FORK §5.6 | 员工转发时信封要能整段复制(放进短代码块),收到后按 schema 校验 |
| SPEC §4.3 `needs_review` 不自动重试、任务按发送者隔离 | 直接用 | 后台任务 | 依赖 T6 |
| v1 `vault-service` 的 `handleRpc` / `rpcResult` / `rpcError` | 改写 | 若 T6 支持自定义 MCP,作为零依赖 MCP 骨架 | Worker fetch 换成 `node:http` 或 stdio |
| v1 `authorized()`(常量时间比较、未配 token 全拒)、413 / 400 / 拒 batch | 直接用 | 本机接口鉴权 | — |
| harness-proxy 只监听 `127.0.0.1`、`/__anc_health` | 借鉴 | 存活探测 | — |
| M1-DESIGN §2 渲染层是纯函数、命令层只编排 | 借鉴 | 代码结构 | — |
| SPEC §8 日报不做个人排名 | 直接用 | 任务清单导出、汇总 | — |

### 2.6 运维

| 上游 | 判定 | 用在哪 | 要改什么 |
|---|---|---|---|
| M1-DESIGN §5.3 doctor(每个 FAIL 带出路,按依赖排序) | 改写 | 主机体检 | 检查项:专用用户不在管理员组、睡眠已关、更新组策略、SMB 只读与 NTFS 权限、密钥不进 git、小服务只监听本机、系统时区、WorkBuddy 版本等于回归通过的版本 |
| M1-DESIGN §5.2 watchdog(不依赖被监控链路、冷却、自愈次数上限) | 改写 | 监控 WorkBuddy 进程、小服务心跳、outbox 积压 | 独立 PowerShell 计划任务;对 WorkBuddy 只告警,不自动重启 |
| SPEC §8 防假绿:输出新鲜度 + 成功标记 | 直接用 | 所有定时任务 | — |
| SPEC §3.3 配置变更「备份 → 原子写 → 校验 → 重启 → 探针 → 失败还原」 | 改写 | `CODEBUDDY.md`、技能、小服务配置 | PowerShell / Node 实现;计划任务里显式写工作目录和 PATH |
| M1-DESIGN §2 主机局部状态不进 git | 改写 | `%ProgramData%\anc\` + NTFS 权限 | 每个群一个 webhook,只登记引用名 |
| M1-DESIGN §3.4 `disabled` 停用不删档 | 直接用 | 离职流程 | — |
| M1-DESIGN §3.2 `timezone` + doctor 校验系统时区 | 直接用 | 提醒 | — |
| M1-DESIGN §6 退出码、`ERROR` + `FIX`、`rollback` | 直接用 | 所有脚本 | — |
| SPEC §9 命令面(`doctor` / `status` / `member add\|remove`) | 借鉴 | 运维脚本 | — |
| SPEC §11 风险登记表 | 借鉴 | 补 WorkBuddy 厂商风险、单机单点 | — |

### 2.7 安全

| 上游 | 判定 | 用在哪 | 要改什么 |
|---|---|---|---|
| SPEC §7 信任模型:同公司互信,不做敌意多租户 | 直接用 | FORK §8 | FORK 没写,要补 |
| SPEC §3.2 / LESSONS §4 员工面向的 bot 不给全权限,反模式 yolo + `allow_from = "*"` | 改写 | WorkBuddy 的命令执行确认档位设到最严;可见范围(T5) | — |
| LESSONS §4 persona 写死盘符 | 直接用这条教训 | 路径由接入脚本注入,模板里不写死 | — |
| LESSONS §2.7 出站凭据扫描 | 改写 | outbox 与 webhook | `rg` 换成小服务内置正则;**WorkBuddy 自己在企微里的回复扫描不到**,要写明 |
| LESSONS §2.1 敏感结果只落内部目录 | 直接用 | 访谈报告 | 和「vault 全员只读共享」冲突,见 §5 待定 |
| `scripts/check-public.sh` | 改写 | 泄密绊线 | 扫描范围加 `.mjs` `.ps1` `.jsonc` `.bat`;规则加企微 webhook(`qyapi.weixin.qq.com/cgi-bin/webhook/send?key=`)、corpid(`ww[0-9a-f]{16}`)、带真实用户名的 `C:\Users\` 路径、内网地址段、`key` / `secret` / `webhook` 明文赋值 |

### 2.8 测试与工具链

| 上游 | 判定 | 要改什么 |
|---|---|---|
| `feat-m1-w1/test/`:`node:test` + `assert/strict` + tsc 零依赖;`helpers.ts` 内存 org 工厂;golden 快照用 `UPDATE_GOLDEN=1` 重生成 | 直接用 | fixtures 换企微字段与中文成员目录;golden 换成两份 `CODEBUDDY.md` + `groups.json`;`config-golden` / `toml-roundtrip` 两个测试作废 |
| `package.json` / `tsconfig.json`(strict、`noUncheckedIndexedAccess`、零运行时依赖) | 直接用 | `node --test dist/test/*.test.js` 的通配符 cmd.exe 不展开,要用 Node 22 自带 glob 或显式列文件。**0.3 修正**:这里指的是 `light/vault-service/tsconfig.json` 的编译理念(`strict` + `noUncheckedIndexedAccess`),**文件本身不能直接用**——它是 Cloudflare Worker 配置,见 §2.9 |
| `light/test/e2e.mjs` 的 `ok()` / `section()`、一个用例对应一次实测失败 | 借鉴 | 小服务回归测试 |
| `light/test/cli-collab.mjs` 改 `HOME` 隔离 | 不能照搬 | Windows 上 `os.homedir()` 读 `USERPROFILE`,照搬会污染真实配置 |

### 2.9 0.3 补录:原表漏判或判过粗的七条

> 2026-11-02 重新逐文件核对上游 `90e4fb2`(33 个文件)后补。原表按"组件"覆盖得很全,但下面这些要么只被整体一句"不适用"带过,要么根本没判。

| 上游 | 判定 | 用在哪 | 要改什么 |
|---|---|---|---|
| `tools/harness-proxy/tool-turn-filter.mjs` | **借鉴**(原判"不适用"过粗) | **T21** 若实测"工具轮次的叙述(「让我先查一下」)会发进企微":把它的规则搬过来——含 `tool_use` 的轮次丢弃其 text 块,只透传最终文本轮次 | 上游过滤的是 Anthropic Messages 的响应(SSE + JSON 两种形态);本库没有"harness 与端点之间"这个代理位,只能在 `emitMessage` 侧做**启发式**过滤(拿不到 tool_use 标记),必须可关闭、误杀要记事件。先测 T21 再决定 |
| `tools/harness-proxy/README.md` | 借鉴(设计参照) | FORK §5.5 本机接口、§8 安全基线 | 四条可直接抄进 C1 的检查项:只监听 loopback、凭据文件权限收紧(上游建议 600)、代理/服务不持有上游凭据(header 由调用方带)、`GET /__anc_health` 存活探测 |
| `light/vault-service/README.md` | 改写 | **C1**(接口契约)、**C2**(投影/搜索) | 取 MCP 五工具(`vault_list/read/search/write/history`)的字段与错误语义、etag CAS 的"窄窗口竞争"说明、搜索资源上限(≤400 文件 / 15MB 每次)、二进制 ≤6MB、`_history/` 只读;Worker / R2 / wrangler / `claude mcp add` 全不取 |
| `light/vault-service/tsconfig.json` | **改写**(修正原判"直接用") | 若引入 strict 编译 | 原文是 Worker 配置(`types:["@cloudflare/workers-types"]`、`moduleResolution:"bundler"`、`noEmit`);本库是 Node + `node:sqlite`,换 `types:["node"]`、`module:"nodenext"`、`target:"es2023"`。`strict` / `noUncheckedIndexedAccess` 这两条理念直接用 |
| `light/vault-service/.dev.vars.example` | 仅参考 | C1 的 token 设计 | 上游是"单 token 一家公司";本库是"按群一个 webhook + 服务 token",键名与粒度都不能照搬 |
| `docs/RESEARCH.md` | 仅参考(原表未判) | 对外材料、选型答辩 | §5 IM 平台矩阵可作"为什么是企微"的旁证;§6「文件系统当数据库」的行业背书可引用;§2/§3/§4(cc-connect 选型、OpenClaw、Harness 双后端)与本库无关 |
| 根 `.gitignore`、上游 `AGENTS.md` / `CLAUDE.md` | 仅参考 | 措辞对照 | `.gitignore` 的 `_research/` 本库已同源采用;`.dev.vars` / `.wrangler/` 不需要。上游指引只作"铁律怎么写、诚实条款怎么落到 persona"的措辞对照,避免两套指引漂移 |

## 3. 不适用

| 上游 | 原因 |
|---|---|
| SPEC §2.2 每 bot 一个 cwd 四合一 | 各群大概率共用 `Claw` 一个目录(T10) |
| SPEC §3.1 cc-connect、平台优先级、卡片回调;LESSONS §2.5 | 企微连接由 WorkBuddy 自带;群机器人 webhook 只能发、不能收 |
| SPEC §3.2 Harness 接口;`tools/harness-proxy/` 功能;LESSONS §2.4 | WorkBuddy 闭源,改写它的请求就是封装它 |
| `feat-m1-w1/src/render/toml.ts` 的 TOML 渲染与转义、`parseAncToml` | 没有 cc-connect |
| SPEC §3.3 launchd / systemd、bubblewrap;M1-DESIGN §5.1 plist | Windows 主机;沙箱改用标准用户 + NTFS 权限 |
| `light/vault-service` 的 Worker / R2 部署、wrangler 配置 | vault 在主机本地 |
| LESSONS §1 批量 provisioning(中转站签发 key) | Enterprise 席位替代;只借「停用的不自动重建」用于离职 |
| docs-debt 的一机多公司 | 一机一公司 |
| PLAN 的 M1–M5 里程碑 | 要按新方向重排 |

## 4. 要警惕的坑

1. **单写者不等于不丢更新**:入库进程把提交排成队,但挡不住「基于旧版本生成的整文件替换」。多个群同时找公司 bot 时更明显,必须沿用 base hash。
2. **公司 bot 不能直接写 vault**:FORK §8 要求入库进程用独立用户,所以建库(onboard)也要走 inbox,inbox 要支持批量。
3. **出站扫描有盲区**:只能覆盖本地小服务经 webhook 发的消息。
4. **`CODEBUDDY.md` 只在第一轮注入**:铁律要在技能里重复。若 T6 支持自定义 MCP,工具描述每轮都会带上,可能更稳,需要实测。
5. **frontmatter 带 BOM 会解析失败**,见 2.1。
6. **Windows 上 rename 可能因文件被占用失败**,见 2.1。
7. **测试隔离不能靠改 `HOME`**,见 2.8。
8. **原件一旦进 git,历史里就删不掉**。
9. **任务状态可能有两份**:协作三件套的任务看板和 SQLite 任务,要定清楚谁是真相源(见 2.3)。
10. **8000 字符是按字符还是按字节算,还不知道**,闸门先按字符,实测后再调。

## 5. 对 FORK-DIRECTION 的影响

> 2026-10-29:本节已全部并入 FORK-DIRECTION 0.2。5.1 逐条补进相应章节;5.2 的五项按建议定为 D11–D15。下文保留作来由记录。

### 5.1 应当直接补进去的

- **运行身份前后不一致**:§5.7 要求主机重启后没人登录也能发提醒,§5.5 却写小服务跑在一个低权限用户下;跑在普通用户下又要「不论是否登录都运行」,就得在计划任务里存密码,和 D5 冲突。应改为不存密码的身份(服务虚拟账户,或把 Node 进程注册成 Windows 服务),并新增一条实测:该身份能否外发 HTTPS 到企微 webhook。
- **小服务鉴权**:除了只监听本机,还要带 token;JSON 投递目录只允许公司 bot 的用户写。
- **状态机细节**:规则冻结、A2A 信封七字段、「完成」与出站消息同一事务、`reproject`。
- **inbox**:补 `inbox/failed/`、批量投递、base hash 拒写后的回执(重读 → 合并 → 重投)。
- **安全**:写明信任模型;写明出站扫描的盲区;WorkBuddy 命令执行确认档位设到最严、禁装第三方技能。
- **§6 新增观察项**:长会话压缩后 persona 是否还在、工具轮次的叙述会不会发给用户、群会话会不会自动重置。
- **§7 新增实测**:技能名片放在哪里 WorkBuddy 才认、frontmatter 认不认;agent 实际能看到群的什么标识;8000 字符的计数方式;小服务运行身份能否外发 HTTPS。
- **运维**:主机体检、watchdog、离机备份(vault 的 git 与 SQLite)、重建 runbook、风险登记表。
- **org 真相源与离职流程**:成员、企微 userid、群、webhook 引用名四者的对应,配校验器;离职 = `disabled` + 回收席位 + 归档群 + 转交任务。
- **时间配置**:时区、工作时段、节假日;doctor 校验系统时区。
- **§2 说明**:公司 bot 是所有人共用的一个实例,和上游 P1「一人一 bot」不同。

### 5.2 需要你定的(附建议)

| 事项 | 建议 |
|---|---|
| 本地小服务与渲染器用什么语言(FORK §9) | **TypeScript + Node 22 LTS**。渲染侧可复用的代码全是 TypeScript,群映射的类型要在渲染器和小服务之间共用;Node 22 自带 `fetch` 和 `node:sqlite`(仍是实验特性,退路是只引 better-sqlite3 一个依赖) |
| 敏感数据放哪 | vault 分两区:**共享区**(全员只读)和**内部区**(只有公司 bot 与入库进程能读写),访谈报告、个人定制、任务投影放内部区。个人 bot 不需要在运行时读 `members/`,渲染时已经写进它的 `CODEBUDDY.md` |
| 结构化入库由谁做 | 公司 bot 做结构化(主机上只有它有模型),结果投进 `inbox/pending/`;入库进程不调模型,只做路径、hash、schema 校验和 commit;起步阶段加一道管理员复核 |
| 原件放哪 | `_originals/` 不进 git,只在 markdown 里登记来源路径,靠离机备份保护 |
| 技能和 persona 谁来改 | 上游由 devbot 改,这里没有对应角色。建议由管理员在本仓库走分支 → 验证 → 合并,合并后由渲染器部署到主机 |

---

## 6. 按阶段取用(PLAN 2.0 索引)

横向表按组件;这张按"你正在做哪件事"。**R/H 阶段基本不用上游**——收尾与硬化都是本库自己的体检、身份、入库、补丁;上游真正吃重是从 C 阶段开始。

| 阶段 / 任务 | 取哪份 | 取什么 | 明确不取 |
|---|---|---|---|
| R 收尾(R0–R8) | 基本不取 | — | 上游没有"运行身份迁移""注销后无人登录""干净机计时"这类东西(它的形态是 Mac + launchd)。R3 的告警冷却写法可参照 `docs/M1-DESIGN.md` §5.2 |
| H7 出站扫描 | LESSONS §2.7 | 扫描哪些凭据类型 + "WorkBuddy 自己的回复扫不到"这个盲区 | `rg` 实现 |
| H8 check-public | 上游 `scripts/check-public.sh`、§2.7 | 规则清单:企微 webhook、corpid `ww[0-9a-f]{16}`、`C:\Users\<真名>`、内网段、key/secret 明文赋值 | 它的扫描范围(缺 `.mjs` / `.ps1`)与 bash 实现 |
| H10 frontmatter | `feat-m1-w1/src/org/frontmatter.ts` | 解析逻辑 + BOM 教训(首行必须精确 `---`) | 它的字段集 |
| C1 HTTP + token | v1 `vault-service` 的 `authorized()` / `handleRpc`、`light/vault-service/README.md`、harness-proxy README | 常量时间比较、未配 token 全拒、五工具契约、`/__anc_health`、只监听 loopback | Worker / R2 / wrangler / `claude mcp add` |
| C2 投影 + reproject | SPEC §2.3 状态层、`light/vault-service/README.md` 的 etag 说明 | "SQLite 是真相、markdown 是投影、可重建";etag CAS 的窄窗口并发语义 | `_history/`、`toolHistory`、manifest(用 git log) |
| C3 后台任务 | SPEC §4.3 | `needs_review` 不自动重试、按发送者隔离 | 它的执行器(Claude Code 会话) |
| C4 A2A | SPEC §7 | 七字段信封 | 飞书卡片回调 |
| C6 离机备份 | `VAULT-FORMS.md` | 原件进 git 删不掉、`_history` 不是备份、`_ocr/` 文本投影 | R2 对象存储 |
| C7 离职 | M1-DESIGN §3.4 | `disabled` 停用不删档 | 批量 provisioning |
| C8 共享账号 | LESSONS §1 | "停用的不自动重建"这一条 | 中转站签发 key |
| C9 渲染器 rollback + 部署 | `feat-m1-w1` 的 `validateRoundTrip` / `--adopt`、分支版 M1-DESIGN §4.4 | "备份 → 原子写 → 读回对拍 → 失败还原";`deploy` / `rollback` 在上游只是桩,要自己写 | TOML 渲染 |
| C10 配置化 | M1-DESIGN §3.2 | `timezone` 配置项 + doctor 校验系统时区 | — |
| C13 不上云 | `VAULT-FORMS.md` 形态 C、SPEC §2.3 | "单机目录、不上云"就是本库形态 | 云同步 |
| T21 若实测会漏叙述 | `tools/harness-proxy/tool-turn-filter.mjs` | 见 §2.9 第一条:过滤 tool 轮次的 text | SSE 解析那一半(本库没有代理位) |
| V6 转公开 | 上游 `check-public.sh`、§2.7 | 同 H8 | 同 H8 |
| 日常改渲染器/技能 | `feat-m1-w1`、`anc-onboard` 的 11 问 / 问题模型 / 入库正文 | frontmatter、org 校验、三层 persona、路由表、指纹闸门、测试骨架;技能文本 | 飞书字段、`platform: feishu`、`allowed_tools`、`~/.claude/skills/` |
| T12 退路 | `worktree-light-v2-layered/light/cli/anc.mjs` 的 `cmdPull` | 清单增量、`pool()` 思路 → 改成计划任务跑 `robocopy /MIR` | `push` 与冲突处理(员工不写 vault) |

**三个未合并分支各管一摊**:`feat-m1-w1` = 渲染器改写来源;`worktree-light-v2-layered` = 入库(base_etag / handleRawPut / normalizePath)与 `VAULT-FORMS.md`;`docs-debt` = 不采用(一机多公司),只作对照。

**取用规矩**:先查本表定位 → 再看 §2 / §2.9 的判定档 → 从 `git show 90e4fb2:<路径>` 或 `reference/upstream/` 取 → 按 FORK 的 D 系列改写 → 补测试。凡是"群身份、企微回调、Windows 落地"的问题,上游一律没有答案(它的前提是 Claude Code + 飞书 + Mac)。
