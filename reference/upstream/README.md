# 上游参考（不参与构建）

来源：[HA7CH/ai-native-company](https://github.com/HA7CH/ai-native-company)（MIT），本库导入点 `90e4fb2`。**这里的内容不是本库代码**，不部署、不测试；要用时挑出来改写进正式目录。

上游的完整原样随时可取：`git show 90e4fb2:<路径>`，或 `git fetch upstream` 后与 `90e4fb2` 对比看上游的新变化。这里只留「以后可能用到」的部分，每份写明什么时候会用。

| 路径 | 原位置 | 什么时候会用 |
|---|---|---|
| `skills/anc-onboard.SKILL.md` | `light/skills/anc-onboard/SKILL.md` | 做「管理员私聊里的建库技能」时（REUSE-MAP 第 54 行）：借它的铁律、进度行约定、`onboarding-state.md` 断点续走；写入要改投 `inbox\pending\`，并支持一批几十个文件 |
| `skills/anc-onboard.vault-skills.anc-ingest.md` | `light/skills/anc-onboard/vault-skills/anc-ingest.md` | 上游入库技能的 vault 内版本；本库的 `light/skills/anc-ingest-company/` 已由它改写而来，改入库技能时可对照原意 |
| `vault-service/mcp-rpc-skeleton.ts` | `light/vault-service/src/index.ts` 摘录 | 若改用「自定义 MCP」让公司 bot 调本地小服务（REUSE-MAP 第 88、148 行）。T6 已经走 CLI 通过，这只是备选 |
| `unmerged/` | 原 `reference/upstream-unmerged/` | 上游三个未合并分支。`feat-m1-w1` 是 M3 渲染器的改写来源；`worktree-light-v2-layered` 的 `VAULT-FORMS.md` 是 vault 形态 C 的出处；`docs-debt` 的「一机多公司」本库不采用（一机一公司），留作对照 |

已删除（按 FORK-DIRECTION 的裁决用不上，需要时从 git 取）：`light/skills/anc-ingest/`（被 `anc-ingest-company` 取代）、`light/skills/anc-join/`（名片规则已吸收进 `light/skill-cards/`，MCP 接入步骤不适用）、`light/vault-service/` 的 Worker / R2 / wrangler 部署、`tools/harness-proxy/`（前提是能改写执行引擎的请求，WorkBuddy 闭源）。

上游的设计文档（`SPEC.md`、`docs/LESSONS-MANUFACTURING-PILOT.md`、`docs/LIGHT-MVP.md`、`docs/RESEARCH.md`、`docs/M1-DESIGN.md`）仍在原位，各自开头标了「上游原文」。REUSE-MAP 按章节号引用它们，所以不挪。
