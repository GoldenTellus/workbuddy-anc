# 上游与参考来源

> 类型：来源政策（怎么收录、怎么授权、怎么引用）
> 最后更新：2026-11-07
>
> 上游不是单数。除了初始 fork 基线，还包括以后用于学习、借鉴、二创的项目、库、设计文档。每一份来源都要有记录，不能只在聊天里说“参考了某个项目”。

---

## 1. 来源类型

| 类型 | 含义 | 许可证义务 |
|---|---|---|
| `fork-base` | 本仓库从它 fork/派生 | 保留原许可证与版权声明 |
| `code` | 拷贝/改编了代码或配置 | 按许可证署名/NOTICE/同许可证 |
| `design` | 借鉴了架构、流程、交互 | 引用来源；不拷代码 |
| `reference` | 只用于学习/论证 | 引用来源；不拷代码 |
| `tool` | 运行时/构建依赖 | 由包管理器与依赖清单管理 |

## 2. 来源索引

| id | 类型 | 许可证 | 固定版本 | 状态 | 记录 |
|---|---|---|---|---|---|
| `ai-native-company` | `fork-base` | MIT | `90e4fb2` | active | [upstreams/ai-native-company.md](./upstreams/ai-native-company.md) |
| `dsh-superagent` | `design` | MIT | `8c32a9d` | active | [upstreams/dsh-superagent.md](./upstreams/dsh-superagent.md) |
| `openai-future-of-the-firm` | `reference` | 无代码 | — | reference | [upstreams/openai-future-of-the-firm.md](./upstreams/openai-future-of-the-firm.md) |

> 新增来源必须同时更新本表、`docs/upstreams/<slug>.md`；如果拷贝了代码，还要更新根目录 `THIRD_PARTY_NOTICES.md`。

## 3. 硬规则

1. **先定许可证，再决定怎么用。**
   - MIT / Apache-2.0：可借鉴/拷贝，保留版权与许可声明。
   - GPL / AGPL：可能要求衍生作品同许可证；未评审不得拷贝。
   - 许可证不明：**只学概念，不拷代码**。
2. **上游必须钉版本。** 记录 commit/tag，不写 `latest`；升级是显式动作，进 `DECISIONS.md`。
3. **代码来源和灵感来源分开记。**
   - 拷了/改了代码 → `THIRD_PARTY_NOTICES.md` + `upstreams/<slug>.md`。
   - 只借鉴设计/思路 → `upstreams/<slug>.md`，注明 `no code copied`。
4. **私有/本地来源也要登记。** 加 `visibility: private`，不写敏感 URL；记录可见范围。
5. **文档引用统一写 `upstream:<slug>`**，不写“参考了某个项目”这种无法追溯的话。

## 4. 新增一个来源

1. 在 `docs/upstreams/<slug>.md` 按模板建条目。
2. 在本文件 §2 加一行。
3. 若拷贝代码：在 `THIRD_PARTY_NOTICES.md` 加许可证与版权。
4. 若改变了设计：在 `DECISIONS.md` 记一条（为什么用、为什么不用别的）。
5. 若影响某个主干：在 `STATUS.md` 的文档同步审计里标“上游已更新”。

## 5. 原始资料放哪

- 上游原样文档/未合并分支：`reference/upstream/`，只读，不参与构建。
- 本项目对来源的判断：`docs/upstreams/<slug>.md`。
- 历史盘点（第一个上游的旧版）：`docs/archive/history/REUSE-MAP.md`、`UPSTREAM-COVERAGE.md`、`UPSTREAM-ORIGINALS.md`。

## 6. 许可证与归属

根目录 `LICENSE` 是本项目当前许可证；第三方代码归属见 [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)。
本文件不是法律意见；引入 GPL/AGPL/商业许可证前必须单独评审。
