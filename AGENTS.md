# workbuddy-anc — 项目指引(Codex 版,与 CLAUDE.md 内容一致)

GoldenTellus 的二次开发仓库,基于 [HA7CH/ai-native-company](https://github.com/HA7CH/ai-native-company)@`90e4fb2`(MIT)。目标:小团队用一台 7×24 的 Windows 主机跑一个**公司 bot**,每个员工电脑跑一个**个人 bot**,执行引擎是腾讯 **WorkBuddy(Enterprise 版)**,IM 是**企业微信**,公司知识放在主机上的 markdown vault 里。结构照搬上游的制造企业试点。

本库不写 agent、不写 IM 网关,只做它们之外的部分:渲染器(生成 `CODEBUDDY.md` 与群映射)、本地小服务(状态、提醒、完成判定、outbox)、入库进程、接入脚本、主机运维。

## 当前状态

- 方向 `docs/FORK-DIRECTION.md` 0.4;阻断项实测已完成(结果见 `docs/VERIFY.md` §4)。里程碑见 `docs/PLAN.md`,**当前做 M1(当日任务与提醒端到端),第一步是 T6**。
- WorkBuddy 只有补丁一条路(D18):企业版与个人版实测一样,群身份靠 D17 补丁。凡上主机的版本都先过 FORK-DIRECTION §11 的升级回归。
- `package.json` 保持 `"private": true`,不发 npm。

## 文档地图(改代码前先读)

| 文件 | 内容 |
|---|---|
| `docs/FORK-DIRECTION.md` | **设计裁决的唯一真相源**:已定裁决 D1–D18、组件设计、WorkBuddy 已观察行为、待实测 T1–T22、安全基线、风险登记、改动台账(§11) |
| `docs/VERIFY.md` | 阻断项实测手册与结果记录 |
| `docs/REUSE-MAP.md` | 上游代码与设计逐项的复用判定,写代码前先查这里有没有能搬的 |
| `reference/upstream-unmerged/` | 上游三个未合并分支(含上游 M1 的渲染器 `feat-m1-w1`,本库在 PLAN M3 复用;名字里的 m1 指上游,不是本库的 M1),只作参考,不参与构建 |
| `docs/PLAN.md` | 里程碑 M0–M4:顺序、上线门槛、验收 |
| `SPEC.md`、`README.md` 等 | **上游原文**(Mac mini + cc-connect + Claude Code),仅作参考;与 FORK-DIRECTION 冲突时以后者为准 |

## 关键裁决速览(详见 FORK-DIRECTION §4,不要在实现中偏离)

1. **可以改 WorkBuddy**:patch 程序、封装、读取它的凭据与内部数据都允许(D16)。但每处改动都要按 FORK-DIRECTION §11 登记版本、随升级重放、可一键关闭;仓库里只放清单与脚本骨架,不放厂商代码 diff。它的行为仍不是公开契约,改动后的行为只能记在 §11 台账,不能当产品事实。
2. **公司 bot 是所有人共用的一个实例**,员工靠「一人一群」隔离(本人 + 公司 bot + 本人的个人 bot);私聊公司 bot 只留管理员。两个 bot 在群里都 @ 才回应。
3. **确定性的事不交给模型**:任务与工作流状态、计时提醒、「完成」判定、出站消息都归本地小服务(SQLite 为真相,markdown 是投影)。
4. **vault 分两区**(共享区全员只读、内部区只有公司侧能读写),是两个独立的 git 目录;原件不进 git。
5. **公司 bot 只做结构化,入库进程只校验和提交**,不调模型;覆盖写必须带读取时的 base hash。
6. **运行身份分开**,都不进管理员组;主机不开自动登录,本机不存账号密码。
7. 技能、模板、org 数据只走 git 变更 → 渲染器部署;主机上手改线上文件视为事故。

## 约定

- 文档中文为主;渲染器与本地小服务用 TypeScript + Node 22 LTS,零或极少运行时依赖;主机运维脚本用 PowerShell。
- 开发流程:分支 → PR → 验证 → squash merge;维护者明确要求时可直接提交 main。
- 从上游借代码前先查 `docs/REUSE-MAP.md`;上游写死的飞书、cc-connect、macOS 内容不要带进来。
- 这台机器上 git 命令较慢,耗时的 git 操作放后台跑。
- **CLAUDE.md 与本文件同步维护**(Claude 镜像,内容一致)。

## 铁律:泄密防线

- `_research/` 与任何含生产细节的内容**绝不 commit**(.gitignore 已排除,别绕过)。
- 改动 WorkBuddy 的产物(patch diff、反编译中间件、提取脚本输出)同样不进仓库:原件放 `_research/workbuddy/`,仓库里只放清单与脚本骨架,规矩见 FORK-DIRECTION §11。
- 绝不进仓库:企微 webhook 地址、corpid / corpsecret、WorkBuddy 或企微的账号 ID、按 D16 读取的任何凭据值、真实的主机名、内网地址、带真实用户名的本机路径、人名。文档里用 `%USERPROFILE%`、`\\主机\vault`、`<userid>` 这类占位符。
- 转公开检查(repo 转 public 前必跑):`bash scripts/check-public.sh`,零输出且退出码 0 = 通过。脚本目前只扫 `*.md *.json *.ts`,按 FORK-DIRECTION §8 扩规则之前,新增 `.ps1` / `.mjs` 等文件要人工过一遍。脚本是绊线不是证明,转公开前仍需人工过一遍全量 diff。
- 涉及部署现场的表述只写通用化 lessons learned,不写可定位到具体在跑机器的攻击面线索(措辞用设计约束时态,如「一律不授予」,不用「已整改/待整改」)。
