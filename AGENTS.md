# workbuddy-anc — 项目指引(Codex 版,与 CLAUDE.md 内容一致)

GoldenTellus 的二次开发仓库,基于 [HA7CH/ai-native-company](https://github.com/HA7CH/ai-native-company)@`90e4fb2`(MIT)。目标:让 5 人左右的小团队,用一台常开的 **Windows 专业版主机**,给每个员工配一个自己的 **腾讯 WorkBuddy**,在 **企业微信** 里随时找它干活,全公司共享一个 markdown 知识库;全部用免费、开源或系统自带的组件搭起来。

本库不写 agent、不写 IM 网关:执行引擎是 WorkBuddy,IM 通道是 WorkBuddy 自带的企微机器人。本库只做它们之外的部分——主机搭建、多会话接入、隔离与界面锁定、公司知识层(vault / persona / skill)、运维。

## 当前状态

- **新 SPEC 0.1-fork 已定稿为 Draft**,取代上游 SPEC。下一步:逐条做 SPEC §14 待验证清单,然后制定新里程碑计划(替换 `docs/PLAN.md`)。
- 仓库为 private;`package.json` 保持 `"private": true`,不发 npm。命令入口名 `anc`(规划中,SPEC §9.2)。

## 文档地图(改代码前先读)

| 文件 | 内容 |
|---|---|
| `SPEC.md` | 架构规范——**设计裁决的唯一真相源**。§14 是实现前必须实测的假设 |
| `README.md` | 对外定位 |
| `scripts/check-public.sh` | 泄密绊线 |
| `docs/*`、`light/`、`tools/harness-proxy/` | **继承自上游,运行时相关部分已作废**(SPEC §12),仅作参考,不再维护,不作为开发依据 |

## 关键裁决速览(详见 SPEC,不要在实现中偏离)

1. **一人一账号**:每个员工一个 Windows 标准用户 + 一个 WorkBuddy 账号 + 一个企微绑定;岗位只是 persona 模板来源。
2. **账号只在主机上登录**:员工电脑只当屏幕,用远程桌面连入,不装也不登 WorkBuddy。
3. **真正的隔离边界是 Windows 用户 + 磁盘 ACL**;RemoteApp、组策略、AppLocker 的界面锁定是尽力而为,不当作安全边界。员工用户一律不进管理员组。
4. **多会话层可替换**:`rdpwrap`(v1 默认,部署方已知情接受其 EULA、报毒、更新失效风险)/ `single` / `rds`。风险在文档里原样呈现,不淡化。
5. **只在公司内网使用**;远程桌面端口不映射外网。重启后人工恢复(员工各连一次),不做无人值守自动恢复。
6. **不封装、不修改 WorkBuddy,不提取其凭据或内部数据**,只用它的公开能力。
7. **零 token 数据层**:vault 是主机本地 git 目录,员工只读;写入走 inbox → Admin 单写者入库。
8. **零采购**:不依赖需要购买的授权或服务;合规付费路径只写进文档作替代。

## 约定

- 文档中文为主;主机侧脚本以 PowerShell 为主(实现语言见 SPEC §13)。
- 标「待验证」的条目先实测再实现,结论回写 SPEC。
- 开发流程:分支 → PR → 验证 → squash merge;维护者明确要求时可直接提交 main。
- 从上游继承内容时只取运行时无关的 generic 机制;不引入任何真实公司名、人名、主机名、内网地址、账号标识。
- **CLAUDE.md 与本文件同步维护**(Claude 镜像,内容一致)。

## 铁律:泄密防线

- `_research/` 与任何含生产细节的内容**绝不 commit**(.gitignore 已排除,别绕过)。
- 转公开检查(repo 转 public 前必跑):`bash scripts/check-public.sh`,零输出且退出码 0 = 通过。规则维护在脚本里(脚本自身不在扫描范围,无自命中;文档示例占位符用 ou_*** / cli_***)。脚本是绊线不是证明,转公开前仍需人工过一遍全量 diff。
- 涉及部署现场的表述只写通用化 lessons learned,不写可定位到具体在跑机器的攻击面线索(措辞用设计约束时态,如「一律不授予」,不用「已整改/待整改」)。
