# workbuddy-anc

小团队的「AI native 公司」落地仓库：一台 7×24 的 Windows 主机跑一个**公司 bot**，每个员工电脑跑一个**个人 bot**，执行引擎是腾讯 **WorkBuddy（企业版）**，IM 是**企业微信**，公司知识放在主机上的 markdown vault 里。

基于 [HA7CH/ai-native-company](https://github.com/HA7CH/ai-native-company)@`90e4fb2`（MIT）二次开发，结构照搬上游的制造企业试点；上游写的是 Mac mini + cc-connect + Claude Code，和本库的形态不同，上游原文只作参考（见 [reference/upstream/](./reference/upstream/README.md)）。

## 本库做什么、不做什么

**不写** agent，**不写** IM 网关——这两样由 WorkBuddy 自带的企微机器人提供。本库只做它们之外、必须确定性完成的部分：

| 部分 | 位置 | 作用 |
|---|---|---|
| 本地小服务 | `src/service/` | 任务与提醒、完成判定、outbox（经群机器人 webhook 发消息）、群绑定、工作时段、A2A 访谈归档。SQLite 为真相 |
| 入库进程 | `src/ingest/` | 校验公司 bot 整理好的批次并写进 vault：路径校验、覆盖写必须带 base hash、原件只许新建、事务回滚。不调模型 |
| 渲染器 | `src/render/` | 从 org 数据（角色 × 成员）生成 persona（`CODEBUDDY.md`）、个人接入包、群映射 |
| WorkBuddy 补丁 | `scripts/workbuddy-patch/` | 把群标识与发送人注入消息正文（D17）、拦自动升级；带版本绑定、一键关闭、自愈与守卫 |
| 主机运维 | `scripts/*.ps1` | 体检、watchdog、备份、开机提醒、附件清理、更新探测、自愈 |
| 技能与 persona | `light/` | 公司 bot 的技能、persona、渲染模板、vault 模板、个人 bot 的技能名片 |

## 架构一览

```
企业微信
  ├─ 每个员工一个群：本人 + 公司 bot + 本人的个人 bot + 提醒用群机器人（一人一群 = 身份边界）
  └─ 私聊公司 bot：仅管理员

Windows 主机（7×24）
  ├─ 公司 bot：WorkBuddy + D17 补丁（消息开头带 [anc:chat=<chatid> from=<userid>]）
  ├─ 本地小服务：计划任务每分钟一次 tick
  ├─ vault 共享区（全员只读，SMB）/ 内部区（只有公司侧读写），各是一个 git 目录
  └─ inbox：公司 bot 投递 → 入库进程校验后写入

员工电脑：个人 bot（WorkBuddy），只服务本人，只读 vault 共享区
```

确定性的事（状态、计时、「完成」判定、出站消息）一律归本地小服务，不交给模型。

## 现状

- 里程碑 M0–M4 的功能都已交付：任务提醒、vault 与入库、渲染与接入、访谈与 A2A；补丁侧有锚点模式、自愈与守卫、canary、更新探测，主机上 8 个计划任务。
- 收尾与后续见 [docs/PLAN.md](./docs/PLAN.md) 2.0：**阶段 R（收尾，含"让 doctor 能自证 FAIL"）→ H（硬化）→ C（补齐）→ V（收口）**，每段一个 gate。
- `npm test` 60 项（Node 24 直接跑 `.ts`；Node 22 需加 `--experimental-sqlite --experimental-strip-types`）。

## 从哪里开始读

| 想了解 | 读 |
|---|---|
| 为什么这么设计、所有已定裁决 | [docs/FORK-DIRECTION.md](./docs/FORK-DIRECTION.md)（唯一真相源） |
| 做到哪了、下一步做什么 | [docs/PLAN.md](./docs/PLAN.md) |
| 实测记录 | [docs/VERIFY.md](./docs/VERIFY.md) |
| 主机怎么运维、怎么重建 | [docs/OPS.md](./docs/OPS.md)、[docs/REBUILD.md](./docs/REBUILD.md) |
| 各组件用法 | [LOCAL-SERVICE](./docs/LOCAL-SERVICE.md)、[INGEST](./docs/INGEST.md)、[RENDERER](./docs/RENDERER.md)、[ONBOARDING](./docs/ONBOARDING.md)、[WORKBUDDY-PATCH](./docs/WORKBUDDY-PATCH.md)、[CHAT-BINDINGS](./docs/CHAT-BINDINGS.md) |
| 借了上游什么 | [docs/REUSE-MAP.md](./docs/REUSE-MAP.md) |

上游原文（仅作参考）：[SPEC.md](./SPEC.md)、[docs/M1-DESIGN.md](./docs/M1-DESIGN.md)、[docs/LESSONS-MANUFACTURING-PILOT.md](./docs/LESSONS-MANUFACTURING-PILOT.md)、[docs/LIGHT-MVP.md](./docs/LIGHT-MVP.md)、[docs/RESEARCH.md](./docs/RESEARCH.md)。

## 开发约定

- 文档中文为主；TypeScript + Node 22 LTS，零运行时依赖；主机脚本用 PowerShell 5.1（`.ps1` 必须带 UTF-8 BOM，`.json` 不带）。
- 开发流程：分支 → PR → 验证 → squash merge。
- 部署：从仓库复制到 `%ProgramData%\anc\`（命令见 REBUILD §3），主机上手改线上文件视为事故。
- 泄密防线：生产细节只放 `_research/`（不进 git）；转公开前跑 `bash scripts/check-public.sh` 并人工过一遍全量 diff。

`package.json` 保持 `"private": true`，不发 npm。

## License

MIT。上游版权 © HA7CH，见 [LICENSE](./LICENSE)。
