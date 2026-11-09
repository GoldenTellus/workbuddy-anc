# content — 业务内容

> 类型：模块契约

> 状态：现行
> 代码：`light/`
> 入口：`light/skills/`（8 个技能）

## 职责

业务行为的"内容层"：技能、persona、模板、eval 用例、vault 模板。**不含 TypeScript 代码**，但通过 CLI 命令与代码耦合。

## 拥有

| 数据/文件 | 说明 |
|---|---|
| `light/skills/` | 8 个技能：anc-task / anc-dayend / anc-feedback / anc-ingest-company / anc-interview / anc-vault-read / anc-wb-patch / anc-executor |
| `light/skill-cards/` | 员工侧名片：anc-handoff / anc-vault-read |
| `light/personas/` | 公司 bot、devbot 的手写 persona（与模板必须一致） |
| `light/templates/` | 公司/个人 persona 模板、vault 模板 |
| `light/evals/` | 4 个技能 / 8 个用例 |

## 公开契约

- **技能 frontmatter**：`name` + `description`（触发词在这里声明，模型按语义匹配）。
- **技能里调用的 CLI 命令**：`node C:\ProgramData\anc\service\cli.ts ...`；命令组/参数/`--json` 字段是契约。
- **persona 模板变量**：`{{company_name}}` / `{{vault_shared}}` / `{{vault_internal}}` / `{{fingerprint}}`（公司）；`{{member_*}}` / `{{owner_userid}}` / `{{local_workdir}}`（个人）。
- **长度预算**：persona 6500 字节警告 / 7500 报错；模板改动要跑渲染。

## 不变量

- 技能**只调 CLI**：不直接读写 SQLite、不 git commit、不直接写 vault。
- 技能必须写"失败照实说"，不许臆断原因。
- persona **不写死盘符**：路径由渲染器注入。
- 资料正文**不进对话**（D19）：只报路径与标题，摘要由本地脚本生成。
- 触发词必须能区分"下班"与"还有多久下班"、"入库"与"查库"这类近义场景。
- 公司 bot 与 devbot 的手写 persona 必须与模板同步改（只差变量）。

## 失败模式

| 现象 | 含义 | 出路 |
|---|---|---|
| 技能不触发 | `description` 没覆盖说法 | 补触发词；不要靠模型猜 |
| 触发错技能 | 触发词重叠 | 收窄描述，加反例 |
| 回复带过程话 | persona 约束没生效 | 改 persona 的"不旁白"清单；代码层过滤不可靠 |
| 渲染超长 | persona 过 7500 字节 | 砍段；看报错里的分段长度 |

## 依赖

- 允许：无代码依赖
- **唯一允许的耦合**：技能里的 CLI 命令。CLI 改名 = 破坏性变更，必须同步技能与文档。
- 禁止：技能里写内部函数名、表名、数据库路径以外的实现细节。

## 测试

`light/evals/*.json` + `cli eval run`；`npm run test:render` 的长度闸门；真群验收（P-3 剩余部分）。

## 改动指南

- 改技能：先改 `SKILL.md` 的触发词与步骤，再跑对应 eval；**不要**在技能里加"聪明"的自主判断。
- 改 persona：同步 `light/personas/*` 与 `light/templates/*`，跑 `render deploy` 看长度。
- 加技能：`light/skills/<id>/SKILL.md` + eval 用例 + 渲染/部署 + `PRODUCT.md` + `issues.ts` 规则表。

## 变更记录

| 日期 | 改了什么 | 为什么 |
|---|---|---|
| 2026-11-06 | 建档 | 模块化立项 |
| 2026-11-06 | P6 文档收口；无代码变化 | 模块化 |
| 2026-11-09 | `anc-task` / `anc-executor` / `subagent.md` / 公司 persona 加 Attention 短号确认、question Report、三类通知 | 主干 3 T3.5 |
