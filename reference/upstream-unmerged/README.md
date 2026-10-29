# 上游未合并分支(仅供参考)

来源:[HA7CH/ai-native-company](https://github.com/HA7CH/ai-native-company) 上没有合进 main 的三个分支,导出于 2026-10-29。上游 main 当时为 `90e4fb2`,即本库导入的版本。

**这里的内容不参与构建、不是本库代码。** 二次开发时觉得哪部分有用,再挑出来改写进正式目录。

## 目录结构

每个分支一个子目录,只放该分支改过或新增的文件(取分支末端版本,路径与原仓库一致);同名 `.diff` 是该分支相对分叉点的完整改动。

| 目录 | 分支末端 | 分叉点 | 文件数 | 内容 |
|---|---|---|---|---|
| `feat-m1-w1/` | `7035529`(2026-07-25) | `410bc3b` | 32 | 托管形态 M1 第一周:org schema、frontmatter 解析、persona 渲染、cc-connect TOML 渲染与三重校验、`anc` CLI 雏形,带 golden 测试与 demo vault。TypeScript,约 4500 行 |
| `worktree-light-v2-layered/` | `36d3fc3`(2026-07-29) | `410bc3b` | 7 | 分层轻形态:`docs/VAULT-FORMS.md` 提出 vault 形态 A(git)/ B(对象存储分层 + 本地镜像)/ C(单机托管);Worker 改为 MCP 只做控制面、原件走流式 HTTP;新增零依赖 CLI `light/cli/anc.mjs` 与 56 项测试 |
| `docs-debt/` | `e0d7ab2`(2026-07-25) | `410bc3b` | 5 | 文档补丁:SPEC 开放问题 2 改判为「共享托管」(一机多公司)、PLAN 登记轻形态 MVP 与 backlog、RESEARCH 把 WorkBuddy 列入 gap 矩阵、vault-service 自定义域说明 |

上游另外三个分支(`worktree-m1-design`、`worktree-light-mvp`、`skill-stub-sync`)已经以 PR #1/#2/#3 合进上游 main,这里不收。

## 和本库现状的关系

三个分支都从 `410bc3b` 分出,早于上游 main 最后一个提交 `90e4fb2`(制造企业试点,PR #13)。试算三方合并的结果:

- `docs-debt`、`worktree-light-v2-layered` 可以干净合入。
- `feat-m1-w1` 在 `package.json` 和 `docs/M1-DESIGN.md` 有冲突。M1-DESIGN 的冲突是两边各自补了配置项说明:main 侧加了试点的 `reset_on_idle_mins` / display / hooks,分支侧按 cc-connect v1.3.4 源码核对了 auto_compress、providers、`disabled_commands` 等,两边内容都有价值。

所以读 `.diff` 时注意:它是相对分叉点的改动,不是相对本库现在的文件。
