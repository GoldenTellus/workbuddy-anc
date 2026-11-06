# improvement — 自我改进

> 类型：模块契约

> 状态：现行（P4 已迁入 `src/modules/improvement/`）
> 代码：`src/modules/improvement/{submissions,issues,patch-drafts,eval,dayend}.ts`、`scripts/devbot/{devbot,devbot-scheduler,e2e-loop}.ps1`
> 入口：`src/modules/improvement/index.ts`

## 职责

把员工在群里的"这个不对"变成一次可评审的技能修改：`submission → issue → patch draft → devbot 分支 → eval`。另外维护 `dayend`（下班记录，用作夜间窗口开关）。**分诊与判定都不用模型。**

## 拥有

| 数据/文件 | 说明 |
|---|---|
| `submissions` 表 | 员工原话照存；`status`: new / triaged / dropped |
| `issues` 表 | 结构化 issue；`status`: open / drafted / closed / rejected |
| `patch_drafts` 表 | diff + `base_hash`；**不直接改仓库** |
| `eval_runs` 表 | 一条用例一次跑的结果；`checks` 是 JSON |
| `dayend` 表 | 按本地日期唯一；`(employee, day)` |
| `devbot/issue-*` 分支 | 只允许改 `light/skills/` 与 `light/evals/` |

## 公开契约

- `submissions.add/list/setStatus`
- `issues.draftFromSubmission` / `triage` / `setTriage` / `setStatus` / `list`
- `patchDrafts.draftFromIssue` / `prune` / `pruneClosed`
- `eval.loadCases` / `runCase` / `record` / `waitReady`
- `dayend.add` / `list` / `checkAllOff`
- 编排：`devbot.ps1 -Issue <n> -Apply`，输出"分支 + 提交数 + 改动文件 + eval 结果"

## 不变量

- 分诊**只用规则表**（`RULES`）；命中不了 → `skill/section = null`，标"待人工分诊"，**不硬猜**。
- `patch draft` 只产出 diff 与 `base_hash`，**不写仓库**；合不合由人决定。
- `eval` 只判 pass/fail；**eval 是筛子不是证明**，人 review 不能省。
- `dayend` 名册为空时 `allOff = false`（没配员工时说"全员下班"没意义，且会让 devbot 在空系统上夜间乱改）。
- devbot 四道闸：`maintenance.flag` 不存在、时间在 22:00–06:00、`allOff = true`、有 `status=open` 的 issue；任一不过不跑，并说明理由。
- devbot 只允许改 `light/skills|evals/`；跑完**必须**恢复 persona 并切回起始分支（异常路径也要）。

## 失败模式

| 错误码 | 含义 | 出路 |
|---|---|---|
| `SUB_NOT_FOUND` | submission 不存在 | `submission list` |
| `ISSUE_NEED_TRIAGE` | 规则表没命中 | `issue triage --id --skill --section` |
| `PATCH_BASE_CHANGED` | 源文件在生成后被改 | 重新 `patch draft` |
| `EVAL_NOT_READY` | test-emit 没就绪 | 检查 `test-emit.flag`，重启后等 8–30 秒 |
| `DEVBOT_SCOPE` | 改了范围外文件 | 分支作废；人看devbot 的越界行 |

## 依赖

- 允许：core
- 禁止：tasks / delivery / runtime（改进闭环不改运行时状态机）
- 注意：`eval` 通过 `test-emit` 调 WorkBuddy，但不 import `workbuddy` 的代码；只依赖 HTTP 入口契约。

## 测试

`npm run test:service` 里的 closure / submission / issue / eval / dayend 用例；`scripts/devbot/e2e-loop.ps1` 做端到端（12 分钟）。

## 改动指南

- 加规则：`issues.ts` 的 `RULES` + 一条测试；章节名必须是 SKILL.md 里真实存在的 `## 标题`。
- 改 devbot 闸门：同步 `docs/PRODUCT.md` §4 与 `docs/OPS.md` 的 `anc-devbot`。
- 改 eval：同步 `light/evals/*.json` 与 `docs/VERIFY` 里对应用例。

## 变更记录

| 日期 | 改了什么 | 为什么 |
|---|---|---|
| 2026-11-06 | 建档 | 模块化立项 |
| 2026-11-06 | P4 迁入 `src/modules/improvement/` | 模块化 |
