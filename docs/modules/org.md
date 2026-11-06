# org — 组织与渲染

> 类型：模块契约

> 状态：现行（P4 已迁入 `src/modules/org/`；`src/render/cli.ts` 是入口薄壳）
> 代码：`src/modules/org/{persona,deploy,org,render,onboard,cli}.ts`
> 入口：`src/modules/org/index.ts`

## 职责

把 org 真相源（`company.md` × `roles/` × `depts/` × `members/`）渲染成可部署的产物：公司 bot persona、每个员工的个人 bot persona、`groups.json`、`manifest.json`。**渲染器是唯一上线路径**，手改线上文件视为事故。

## 拥有

| 数据/文件 | 说明 |
|---|---|
| org 输入 | `org/company.md`、`org/roles/*.md`、`org/depts/*.md`、`org/members/*.md` |
| render 产物 | `company-bot/CODEBUDDY.md`、`members/<id>/CODEBUDDY.md`、`groups.json`、`manifest.json` |
| 部署快照与 `.bak-*` | 整组事务的还原依据 |

## 公开契约

- `loadOrg(orgDir)` → `{company, roles, depts, members}`
- `renderOrg(orgDir, outDir, templateDir?)` → `{inputSha, outputs, warnings, tampered, removed}`
- `deployOrg(orgDir, outDir, templateDir?)`：快照 → 渲染 → 逐产物读回对拍 → 失败整体还原
- `rollbackOutDir(outDir, {dryRun?})`：按最新 `.bak-*` 还原
- `onboard` / `verify`：员工机接入包安装与自检
- CLI：`render deploy` / `render verify` / `onboard` / `verify`

## 不变量

- **渲染器是唯一上线路径**；persona 不许手改。
- 长度闸门：`CODEBUDDY.md` > **6500 字节警告**，> **7500 字节报错**，报错列出各段长度。
- 每个产物带输入指纹 `<!-- anc:input-sha256:... -->`；输入没变但文件变了 → 判手改。
- 写入：备份 → 原子写 → 读回对拍 sha256 → 任一失败**整组还原**。
- `disabled` 只认字符串 `true`（`1`/`yes` 不生效）；停用成员不出 persona、不进 `groups.json`，旧产物删除。
- 没有 `userid` 的成员**不生成**个人 persona（否则模板里是字面量 `<userid>`）。
- 孤儿成员目录只在部署对拍通过后清理，且只删"有 CODEBUDDY.md 或空"的目录。

## 失败模式

| 错误码 | 含义 | 出路 |
|---|---|---|
| `ORG_FIELD_MISSING` | `company.md` 缺必填字段 | 补齐 name / company_bot_name / vault_* / local_workdir |
| `PERSONA_TOO_LONG` | 超过 7500 字节 | 砍段落；看报错里的分段长度 |
| `RENDER_VERIFY_FAILED` | 产物对拍失败 | 已自动回滚；查磁盘/杀软/文件占用 |
| `MANIFEST_BAD` | manifest 无法解析 | 本次跳过手改检测并重写；查上一版为什么坏 |

## 依赖

- 允许：core（P4 后共用 `core/fs` 的原子写与 hash）
- 禁止：tasks / delivery / knowledge / runtime

## 测试

`npm run test:render`（渲染、部门、onboard、offboard、部署回滚）；目标 `npm run test:org`。

## 改动指南

- 改模板变量：同步 `light/templates/*.md`、`light/personas/*`、本文件、`docs/RENDERER.md`。
- 改长度闸门：同步 `DECISIONS` §5.9 与 `VERIFY` 里的实测（T19）。
- 加产物：必须同时进 `outputs`（才能被对拍）与 `manifest`（才能查手改）。

## 变更记录

| 日期 | 改了什么 | 为什么 |
|---|---|---|
| 2026-11-06 | 建档 | 模块化立项 |
| 2026-11-06 | P4 迁入 `src/modules/org/`；index 拆成 persona + deploy | 模块化 |
