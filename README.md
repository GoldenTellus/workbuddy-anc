# workbuddy-anc

> 本仓库基于 [HA7CH/ai-native-company](https://github.com/HA7CH/ai-native-company)@`90e4fb2` 二次开发（MIT 许可）。

> 一台 Windows 主机,每个员工一个自己的 WorkBuddy,企业微信里随时找它干活;公司知识全在 markdown 里。
>
> One Windows host, one WorkBuddy per employee, reachable from WeCom — all company knowledge in markdown.

**状态:设计阶段。** 架构规范见 [SPEC.md](./SPEC.md)(0.1-fork Draft),实现前先完成 SPEC §14 的待验证清单。命令入口名 `anc`(规划中)。

---

## 是什么

给 5 人左右的小团队用的一套搭建与运维方案:

- **一人一个 WorkBuddy。** 每个员工在主机上有自己的 Windows 用户和自己的 WorkBuddy 账号,上下文、记忆、skill 迭代轨迹按人隔离。bot 对应的是人,不是岗位;岗位只是 persona 的模板来源。
- **在企业微信里用。** WorkBuddy 自带企微机器人,员工日常在企微里单聊或群里找自己的 WorkBuddy,任务在主机上执行、结果回到企微。
- **账号只在主机上登录。** 员工电脑只当「屏幕」:需要看界面时用系统自带的远程桌面连进主机,只看到自己的 WorkBuddy 窗口。同一账号永远只有一处在线。
- **公司知识 = 文件系统。** 主机上一个 git 管理的 markdown vault,员工只读;原件入库时一次性结构化,回答时直读文件,不做 embedding、不建向量库。
- **零采购。** 全部用免费、开源或系统自带的组件:Windows 专业版 + RDP Wrapper(多人同时远程)+ RemoteApp Tool(只发布 WorkBuddy)+ 组策略 / AppLocker(界面锁定)。

本库**不写 agent、不写 IM 网关**,只做 WorkBuddy 和企微之外的部分:主机搭建、多会话接入、隔离与锁定、vault / persona / skill 分发、运维体检。

## 架构

```
员工电脑(公司内网)
   │ 双击自己的 .rdp(系统自带远程桌面客户端)
   ▼
Windows 专业版主机(常开)
   ├─ 多会话层:rdpwrap | single | rds(可替换)
   ├─ RemoteApp:只发布 WorkBuddy 窗口
   ├─ Windows 用户 alice / bob / …(每人一个,ACL 隔离)
   │     └─ 自己的 WorkBuddy 账号 + 工作区(persona 由渲染管线生成)
   └─ C:\anc\vault\(公司 markdown 知识库,员工只读;inbox → 单写者入库)

企业微信 ←→ 每个人的 WorkBuddy(WorkBuddy 自带企微机器人)
```

## 已知取舍(详见 SPEC §3.1、§11)

- **RDP Wrapper 违反微软授权协议**,会被杀软报为黑客工具,系统更新后可能失效。部署方知情接受;合规路径(Windows Server + RDS + User CAL)写在文档里,随时可替换。不装它也能用:同一时间 1 人远程,其他人的 WorkBuddy 照常在后台回企微。
- **只在公司内网使用**,远程桌面端口不映射外网。
- **单台主机**:重启后每个员工远程连一次即恢复,不做无人值守自动恢复。
- **数据经腾讯云**:模型推理与账号数据经过 WorkBuddy 的云端,onboarding 时作为决策项呈现。

## Roadmap(摘要)

- **M0** 方向与 SPEC ✅
- **M0.5** 实测 SPEC §14 待验证清单(AppLocker 白名单、工作区指令文件、vault 读取方式、RemoteApp 托盘行为、重启后企微恢复……)
- **M1** 主机搭建:`anc init` / `anc host setup` / `anc host multisession` / `anc member add`,在一台干净的 Windows 专业版上拉起 5 人可用的环境
- **M2** 知识层:persona 渲染、skill 分发、inbox 入库、对话式 onboarding
- **M3** 运维:`anc status` / `anc doctor` / `anc audit`

新的里程碑计划将替换 `docs/PLAN.md`。`docs/`、`light/`、`tools/harness-proxy/` 继承自上游,运行时相关部分已作废(SPEC §12),仅作参考。

## License

MIT © [HA7CH](https://github.com/HA7CH)(上游原作) · © [GoldenTellus](https://github.com/GoldenTellus)(二次开发)
