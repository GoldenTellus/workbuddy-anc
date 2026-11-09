# ops — 主机运维

> 类型：模块契约

> 状态：现行（P5 后按域分组到 `scripts/<domain>/`，部署仍扁平到 `bin/`）
> 代码：`scripts/`（54 个文件）
> 入口：`scripts/deploy/deploy.ps1`

## 职责

主机生命周期：部署与对拍、体检、备份、自愈、重建、账号、计划任务、日志轮转。**只通过 CLI 与文件契约调用业务，不 import `src`。**

## 拥有

| 数据/文件 | 说明 |
|---|---|
| `%ProgramData%\anc\` 布局 | `service/ingest/render/shared/bin/patch/data/secrets/inbox` |
| 13 个计划任务 | 见 `docs/OPS.md`；principal 与触发器是契约 |
| ACL | `secrets` 断继承；`data` 保留继承；vault 对 bot 只读 |
| 备份 | `VACUUM INTO` 快照、保留策略、离机复制、同盘告警 |
| 日志轮转 | `loop.log` / `http.log` >5 MB 转 `.1`，只留一份 |

## 公开契约

- `deploy.ps1`（默认 dry-run；`-Apply` 落盘；备份 → 复制 → 逐文件 SHA-256 对拍 → 失败整体回滚）
- `deploy-verify.ps1 -Side company|employee -Json` → `ok: true`
- `doctor.ps1 -Root <r> -Repo <r> -VaultRoot <r> -Json` → **34 项**，`FAIL=0`
- `doctor.ps1 -SelfTest`：用 `%TEMP%` 夹具证明每类检查能 FAIL
- `backup-anc.ps1 -Destination <盘>`；`register-tasks.ps1 -Apply`；`prepare-wipe.ps1 -Apply`；`rebuild-*.ps1`
- 退出码：0 成功 / 1 校验或诊断失败 / 2 用法错误 / 3 已应用但探针失败且已回滚

## 不变量

- **默认 dry-run**；改配置/动目录的命令必须显式 `-Apply`。
- 任何落盘前先备份/快照；失败**整体回滚**，不留半套。
- `doctor` 每一项都必须能 FAIL（`-SelfTest` + 故障矩阵证明），否则就是假绿。
- **`bin` 扁平化、文件名不变**：计划任务与文档都按 `<bin>\<name>.ps1` 引用。
- 仓库里不放密钥、不放真实主机名/用户名/webhook；`check-public.mjs` 零输出才算过。
- 部署只从 `%ProgramData%\anc\patch\` 跑补丁，不从 git 工作副本跑。
- 运行身份按 D25：管理员账号；`doctor` 的期望身份跟着配置走。

## 失败模式

| 现象 | 含义 | 出路 |
|---|---|---|
| `deploy` 对拍失败 | 复制后内容不一致 | 已回滚；查杀软/磁盘/文件占用 |
| `doctor` FAIL | 环境或部署有问题 | 看每项的 `FIX`；不要先改代码 |
| 备份同盘告警 | "离机"目标与本地同盘 | 换第二块盘或 UNC；同盘不算离机 |
| 自愈 `restart-failed` | 两次都没起来 | 60 分钟冷却；手工 `launch-patched.ps1` |

## 依赖

- 允许：无（只调 `node <Root>\service\cli.ts`、`render\cli.ts`、`ingest\cli.ts` 与文件）
- 禁止：import `src`；脚本里直接读业务库做判断（除 doctor 的只读检查）

## 测试

`doctor -SelfTest`；`doctor-fault-matrix.mjs`（故障矩阵基数 34，注入覆盖待重跑；历史 30/31 只代表旧基数）；临时根 `deploy -Apply` + `deploy-verify`；重建演练 `rebuild-drill.ps1`。

## 改动指南

- 加计划任务：`register-tasks.ps1` + `doctor.ps1` 的期望表 + `docs/OPS.md` + `PRODUCT.md`。
- 改部署布局：`deploy.ps1` + `deploy-verify.ps1` + `REBUILD.md` + 所有引用路径的技能。
- 改体检项：必须同时加"怎么让它 FAIL"的注入，否则不算完成。

## 变更记录

| 日期 | 改了什么 | 为什么 |
|---|---|---|
| 2026-11-06 | 建档；P5 目标为按域分组、部署扁平化 | 模块化立项 |
| 2026-11-06 | P5 完成：49 个脚本分 10 域，部署扁平到 `bin\` | 模块化 |
| 2026-11-09 | 计数同步：54 个脚本、doctor 34 项；故障矩阵基数 34 待重跑 | 主干 0 文档收口（GAP-066） |
