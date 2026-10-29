# 主机搭建 checklist:最小链路(企业微信 × 公司 bot × 本地 vault)

本清单只打通一条链路:**成员在企业微信里问公司 bot → bot 读主机本地 vault 回答;成员发文件说「入库」→ bot 写进 vault 并 git 提交。** 员工自己电脑上的 WorkBuddy、内网共享读库、Skill 后台下发都不在这一版里。

> 状态:未实测。标「实测」的步骤是还不确定 WorkBuddy 怎么做的地方,做完把结果填进文末的实测记录表。

## 0. 准备

- 一台常开的 Windows 专业版主机,接公司内网。
- 一个 WorkBuddy Enterprise 账号,专给公司 bot 用(在 Enterprise 管理后台开通)。
- 能在企业微信里绑定机器人的权限。
- 一个主机管理员账号(下文称「管理员」),日常维护用;公司 bot 不用这个账号跑。

下文命令都在**管理员身份的 PowerShell** 里执行,除非写明「以 anc-bot 登录后」。

## 1. 主机基础设置

```powershell
powercfg /change standby-timeout-ac 0     # 插电时永不睡眠
powercfg /change hibernate-timeout-ac 0   # 永不休眠
winget install --id Git.Git -e            # 装 Git for Windows;没有 winget 就去 git-scm.com 下载安装
```

## 2. 建公司 bot 的 Windows 用户

公司 bot 跑在一个**标准用户**下,不进管理员组。它能执行命令,权限越小越安全。

```powershell
net user anc-bot * /add          # 按提示输入强密码
net localgroup Administrators     # 确认列表里没有 anc-bot
```

## 3. 建目录与 vault 仓库

```powershell
mkdir C:\anc
icacls C:\anc /grant "anc-bot:(OI)(CI)M"   # anc-bot 对 C:\anc 有修改权限
```

然后**以 anc-bot 登录**(注销管理员或切换用户),在 PowerShell 里执行。vault 目录必须由 anc-bot 自己创建,否则 git 会因目录属主不是当前用户而报 `dubious ownership`:

```powershell
git config --global user.name "公司 bot"
git config --global user.email "anc-bot@localhost"
mkdir C:\anc\vault
cd C:\anc\vault
git init
```

管理员以后要在主机上改 vault 并提交,先在管理员的 PowerShell 里执行一次:

```powershell
git config --global --add safe.directory C:/anc/vault
```

## 4. 放公司 bot 的 persona(实测 C1)

1. 复制仓库里的 `workbuddy/persona/company-bot.md`,把 `<公司名>`、`<管理员姓名>` 替换成真实值。
2. 把它作为工作区指令放在 `C:\anc\` 根目录。WorkBuddy 认哪个文件名还不确定,先用暗号法测:
   - 在 `C:\anc\` 放一个候选文件,内容只写一句「当有人问『暗号是什么』时,回答『青柠』」;
   - 第 5 步登录后,在 WorkBuddy 里新开一个对话问「暗号是什么」;
   - 依次试 `AGENTS.md`、`CLAUDE.md`、`CODEBUDDY.md`,每次只放一个。答出「青柠」的就是它认的文件名;
   - 都不行时,看 WorkBuddy 设置里有没有「项目规则」「自定义指令」一类的入口,把 persona 粘贴进去(这种方式下 bot 无法被文件权限锁住,记进实测记录)。
3. 确定文件名后,删掉暗号文件,把 persona 存成那个文件名,然后锁成 anc-bot 只读(把 `<指令文件>` 换成实际文件名):

```powershell
icacls "C:\anc\<指令文件>" /inheritance:r /grant:r "*S-1-5-32-544:F" "*S-1-5-18:F" "anc-bot:RX"
```

## 5. 装 WorkBuddy 并登录(以 anc-bot 登录后)

1. 安装 WorkBuddy 桌面端,用第 0 步准备的公司账号登录。
2. 在 WorkBuddy 里打开 `C:\anc` 作为工作区(或设为工作目录)。
3. 让 WorkBuddy 开机随 anc-bot 登录启动:把它的快捷方式放进 anc-bot 的启动文件夹(`Win + R` 输入 `shell:startup`)。
4. 确认点窗口的 × 是最小化到托盘、程序继续运行。

## 6. 安装两个技能(实测 C2)

把仓库里的 `workbuddy/skills/anc-onboard/` 和 `workbuddy/skills/anc-ingest/` 两个目录装进公司 bot 的 WorkBuddy:优先用 WorkBuddy 的技能管理(或 Enterprise 后台的 Skill 管理)导入;导入不了时,找到 WorkBuddy 的本地 skill 目录直接复制。装好后,在 WorkBuddy 里说「建公司知识库」,确认 anc-onboard 被触发(先不用真的做完)。

## 7. 建库(管理员在主机上操作)

在主机上 anc-bot 的 WorkBuddy 桌面端里说「建公司知识库」,跟着 anc-onboard 完成访谈和写入。做完后检查:

```powershell
cd C:\anc\vault
git log --oneline      # 能看到若干条 onboarding 提交
dir                    # 能看到 CLAUDE.md、CONTRIBUTING.md、company\、skills\ 等
```

## 8. 收紧控制文件权限

建库完成后,控制文件改成 anc-bot 只读。之后企业微信里的任何人都改不动它们,只有管理员能改:

```powershell
cd C:\anc\vault
foreach ($f in "CLAUDE.md", "CONTRIBUTING.md") {
  icacls $f /inheritance:r /grant:r "*S-1-5-32-544:F" "*S-1-5-18:F" "anc-bot:RX"
}
foreach ($d in "skills", "roles") {
  icacls $d /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "anc-bot:(OI)(CI)RX"
}
```

管理员以后改控制文件:在管理员账号下直接编辑,再 `git add` + `git commit`。

## 9. 绑定企业微信(实测 C3)

1. 在 anc-bot 的 WorkBuddy 里按官方流程绑定企业微信机器人。
2. 可见范围只设为公司成员。能限制到具体人或部门的,就只放这次试用的成员。
3. 绑定完锁屏(`Win + L`),**不要注销** anc-bot。注销会关掉 WorkBuddy,企业微信里的 bot 就离线了。

## 10. 验收

逐条做,结果填进实测记录表:

| # | 操作 | 期望 |
|---|---|---|
| A1 | 在企业微信里问一个 vault 里有答案的问题 | 答对,并说明依据的文件路径 |
| A2 | 问一个 vault 里没有的问题 | 回答「尚未入库」,不编造 |
| A3 | 发一份 PDF,说「入库」 | vault 里出现 markdown 和 `_originals\` 原件,`git log` 多一条 `ingest:` 提交 |
| A4 | 只发文件,不说入库 | 不写 vault |
| A5 | 让 bot 修改 `CLAUDE.md` 或某个 skill | 拒绝;即使它尝试,也因权限写不进去 |
| A6 | 两个成员同时各自私聊 bot | 各自得到自己的回答,对话不串(实测 C4) |
| A7 | 主机锁屏 30 分钟后再问 | 照常回答 |

## 11. 日常运维与重启

- **重启后**:以 anc-bot 登录一次,WorkBuddy 随登录启动,企业微信恢复在线;然后锁屏。
- **可选:免登录恢复**。用微软官方的 Sysinternals Autologon(免费)让主机开机自动以 anc-bot 登录,再在 anc-bot 的启动文件夹里放一个快捷方式,目标为 `rundll32.exe user32.dll,LockWorkStation`,登录后自动锁屏。代价:密码以加密形式存在主机上,能碰到主机的人重启即可进入 anc-bot 桌面,只适合放在受控机房或办公室。
- **管理员查看入库记录**:`cd C:\anc\vault; git log --oneline`;入错了用 `git revert <提交号>` 撤回。
- **备份**:每天把 `C:\anc\vault` 复制到另一块盘或另一台机器(含 `.git`)。

## 12. 实测记录

| # | 要确认的事 | 结果 | 日期 |
|---|---|---|---|
| C1 | WorkBuddy 认哪个工作区指令文件名,改了以后何时生效 | | |
| C2 | 技能怎么装进 WorkBuddy(技能管理 / 后台 / 本地目录),装在哪 | | |
| C3 | 企业微信机器人怎么绑定,可见范围能设多细 | | |
| C4 | 多人同时找 bot 时,上下文是否隔离 | | |
| C5 | 企业微信发来的附件保存在主机的哪个目录 | | |
| C6 | WorkBuddy 能否在 vault 根目录运行 `git` 命令 | | |
