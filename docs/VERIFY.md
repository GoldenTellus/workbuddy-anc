# 阻断项实测手册

版本:0.1(2026-10-29)。对应 [FORK-DIRECTION.md](./FORK-DIRECTION.md) §7 的七条阻断项:T1–T5、T16、T17。任何一条不成立,都要先改结构再写代码。影响实现的 T6–T15、T18–T22 之后另写。

## 怎么用

- 每条写了前提、步骤、观察什么、怎样算通过,以及不通过时怎么办。照着做,把结果填进 §4 的记录表。
- **凭据不要贴进对话、不要写进仓库**:群机器人 webhook 地址、corpid、真实的 userid、群 ID 都只记在你自己那里。记录表里写「通过 / 不通过 + 现象」就够了,需要举例时用 `<userid>` 这类占位。
- 记下当时的 WorkBuddy 版本号。这些都是实测行为,升级后可能会变。

## 1. 准备

| 要准备的 | 用于 |
|---|---|
| 主机上已登录、已接企业微信的公司 bot(现在的测试机即可) | 全部 |
| 两个测试员工 X、Y(企微账号) | T16、T1、T2 |
| X 的电脑装好 WorkBuddy,用 X 本人的账号登录,并接上企业微信,作为 X 的个人 bot | T1、T2、T5 |
| 企业微信管理后台的管理员权限 | T5、T1 |

## 2. 建议顺序

按准备成本从低到高排。T16 和 T4 只要有公司 bot 就能测,而且 T16 最关键,先做。

1. **T16** 群标识(半小时)
2. **T16b** 传输层群标识与注入(一小时,依赖 T16 结论;要重启一次 WorkBuddy)
3. **T4** 锁屏和长时间无人(放一晚上)
4. **T3** 群机器人 @ 人(十分钟)
5. **T5 → T1 → T2** 需要 X 的个人 bot
6. **T17** 由我在主机上做,开始前先跟你确认要改的内容;和上面几条可以并行

## 3. 逐条步骤

### T16 公司 bot 能否知道这是哪个群

**为什么关键**:一人一群的前提是「群就是身份边界」,公司 bot 和本地小服务都要靠「哪个群」认人。WorkBuddy 按群隔离会话,但 agent 本身能不能看到群的标识,目前不知道。

**前提**:只需要公司 bot,不需要个人 bot。

1. 建两个测试群:G1(你 + X + 公司 bot)、G2(你 + Y + 公司 bot)。企微建群至少 3 人,这里先用真人凑够。
2. 分别在 G1、G2 里 @ 公司 bot,原样发这段话:

   > 请告诉我这条消息来自哪个群:把你能看到的群名和群 ID 原样给出;再告诉我发消息的人是谁(名字和企微 userid)。如果你看不到这些信息,直接说看不到,不要猜。

3. 让 X 在 G1、Y 在 G2 各发一次同样的话,看发送人那部分有没有跟着变(顺带测 T9)。
4. 第二天,或者在 WorkBuddy 里把这两个群的会话重开后,再问一次,对比群 ID 是否和第一次一样。
5. 把 G1 改个名,再问一次,看群 ID 变不变。

**观察**:给出的是不是真实信息(群名对不对得上);两个群的标识是否不同;同一个群前后几次是否一致;改名后群 ID 是否不变。

**通过**:能给出稳定的、每个群各不相同的标识(最好是群 ID,改名不变)。只拿得到群名也算勉强通过,那样群名就不能随便改,要写进运维约定。

**不通过时**(只说看不到,或者明显在猜):「群就是身份边界」不成立。备选做法是建群时由管理员在群里发一条绑定口令,公司 bot 在会话里记住这个群属于谁。但这依赖会话不被压缩、不被重置(T20、T22),比较脆弱,要重新评估员工隔离方案。

**实测记录(2026-10-31,WorkBuddy 5.9.3 / Electron 37.10.3)**

- **环境**:personal/free 账号,IM 读取工具被企业授权拦下(`enableTeamIm=false`、无 enterpriseId)。按 §7 的口径,这只说明工具不可用,不计入本项;下面直接看 agent 实际收到的入站内容。
- **做法**:在测试群 @ 公司 bot 发第 2 步那句话,然后核对本机落盘的入站 prompt:
  - `%USERPROFILE%\.workbuddy\projects\<cwd 编码目录>\<session-id>.jsonl` —— 本轮会话记录,第一条 user 消息就是入站内容;
  - `%USERPROFILE%\.workbuddy\traces\<pid>\trace_*.jsonl` —— 本轮 generation 的 `toolInput`,同一份内容的模型视角。
- **观察**:入站 prompt 只有三段——`system-reminder`(`user_info` 里只有 OS、Shell、工作目录,外加身份文件、项目布局、connector 状态)、`current_time`、`<user_query>原文</user_query>`。**没有群名、没有群 ID、没有发送人 userid、没有渠道标识**。Claw 的系统提示里写着一句:「所有 IM 渠道(如元宝、QQ、钉钉、微信等)的消息共享同一个会话。」
- **判定**:**不通过**。agent 侧拿不到任何群标识;同一份入站内容里也拿不到发送人,所以 T9 同步不通过。
- **结论**:「群就是身份边界」在 Claw 通道上不成立。绑定口令(管理员在群里发一句、bot 记住)能补「哪个群属于谁」,但有两个硬伤:①依赖会话不被压缩、不被重置(T20、T22);②所有渠道共用一个会话,不同群的消息会落进同一上下文,口令本身也只能靠模型记住,隔离强度不够。
- **新增待测 T16b(未做)**:传输层能否拿到群标识——企微 AIBot 回调 / Claw 会话元数据里有没有 chat id,本地小服务能否读到,并在会话启动时注入给 agent(例如按会话写一个 `current-chat.json`,或设环境变量)。成立则群身份改由我们侧提供,不再依赖 WorkBuddy;不成立则一人一群要退回「一员工一 bot」或「群内人工绑定 + 只按群授权」。
- **取证注意**:会话记录里有真实群名、userid 和本机路径,只在本机看,不要贴进对话或仓库;写文档一律用 `<session-id>`、`<cwd 编码目录>` 这类占位。

> 补充:第 2–5 步原本的 bot 自述探针(上下文 / 环境 / 改名)已经不需要——入站内容本身可读,直接核对即可。要复核时再发一次,比较两次 `<user_query>` 之外的部分有没有多出字段。

### T16b 群标识能否从传输层拿到并注入(两段都成立;注入依赖 patch)

**为什么要有这条**:T16 已判不通过(agent 侧看不到群)。这条回答的是退路——群标识在 WorkBuddy 的传输层是否还存在,以及能不能由我们侧按会话注入给 agent。成立的话,「群就是身份边界」可以改成「由本地小服务提供身份边界」。

**前提**:公司 bot 在跑;能复现一次群消息;允许用 `--inspect` 起一次 WorkBuddy(会短暂离线)。

**先排除的(2026-10-31 已查)**:

- `%USERPROFILE%\.workbuddy\workbuddy.db` 的 `sessions` 表有 `group_id`、`group_title` 两列,但当前 14 行全为空;Claw 会话(`transport=local`)和 teams 会话(`transport=cloud`)都没有值。**库里有位置、没人写。**
- 入站 prompt 里没有群标识(T16 已证)。
- `daemon.log` / `main.log` 里搜不到 chatid 一类字段,只有 `conversationId`。

**初测结果(2026-10-31,路线 1)**:在 daemon 里钩 `ws` 的 `message` 事件,拿到了企微 AIBot 的回调原文,`body` 里字段齐全:

- `chatid` —— 两个测试群各一个,**值不同**;
- `chattype` —— `group`;
- `from.userid` —— 发送人;
- `msgid`、`aibotid`、`response_url`、`text.content`。

**结论:传输层有群标识,也有发送人。** T16b 的第一段(拿得到)通过;第二段见下。

**第二段结果(2026-10-31,注入依赖 patch)**:在 `wecomaibot-client.js` 的 `emitMessage` 上套壳,把 `chatId` 和 `user` 拼成 `[anc:chat=<chatid> from=<userid>] ` 前缀加进 `content`。重发一条消息后:

- 落盘 prompt 的 `<user_query>` 开头确实变成 `[anc:chat=<chatid> from=<userid>] …`;
- bot 复述时把方括号原样带出,群 ID 和发送人都在;
- 前缀是每轮由客户端代码拼进去的,**不依赖模型记忆**。

**判定:两段都成立。** 代价是这一步属于**改动后行为**(patch `emitMessage`),必须按 §11 登记、随升级重放。不想背 patch 的话,替代方案是让本地小服务在更外层注入(会话工作目录文件或环境变量),但那需要另测——尤其是 Claw 目前所有渠道共享一个工作目录,直接写文件会串台。

**已产品化(2026-10-31)**:同一注入以 `scripts/workbuddy-patch/`(preload + 启动器 + manifest)交付。用 `launch-patched.ps1` 启动后,日志依次出现 `preload active` 与 `PATCHED target=…wecomaibot-client.js`,复测同一条消息,落盘 prompt 仍以 `[anc:chat=<chatid> from=<userid>]` 开头。部署、开关与升级流程见 [WORKBUDDY-PATCH.md](./WORKBUDDY-PATCH.md)。

> 取证注意:帧里有真实 chatid、userid 和 `response_url`(短时有效),只在本机看,录完即删;文档里只留字段名。抓取用了进程内钩子(改动后行为),但帧内容是 AIBot 自己发的协议数据,不是我们构造的。

**三条取证路线(按成本排)**:

1. **进程内钩子(推荐,成本最低)**
   用 T16 那套以 `--inspect=9229` 起主进程或 daemon,在 CDP 里给企微 AIBot 的 WebSocket 客户端挂 `message` 钩子,把每帧里的 `chatid` / `chattype` / 发送人字段写进 `%USERPROFILE%\anc\aibot-frames.jsonl`。字段名和长度可以记,群名等值只在本机看。SDK 封装太深时,退一步 hook `ws` 的 `emit('message')`。
2. **抓包(成本高,兜底)**
   对 `wss://` 走 mitm,需要让 Electron 信任我们的 CA(`NODE_EXTRA_CA_CERTS` 或系统证书库)。只在路线 1 失败时做。
3. **读对象图**
   在 CDP 里找 Claw 通道的会话对象,看有没有 chat 字段。适合拿不到帧、但对象里其实有值的情况。

**拿到 chat id 之后的注入形态**:

| 形态 | 做法 | 风险 |
|---|---|---|
| 每轮环境变量 | wrapper 启动 agent 时注入 `ANC_CHAT_ID` | 得能控制启动;升级后可能失效 |
| 会话目录文件 | 每轮写 `current-chat.json` 到会话工作目录 | Claw 是所有渠道共享一个目录,会串台 |
| 本地工具 / MCP | 本地小服务按 session id 建 `session → chat` 映射,agent 调 `get_current_chat` | agent 得能拿到自己的 session id;拿不到就只能按时间窗口猜 |

**判据**:

- **通过**:能稳定拿到每个群的 chat id,并且能在**不依赖模型记忆**的前提下,让 agent 每轮读到正确的那一个。
- **不通过**:chat id 拿得到但注入不了,或只能靠模型记——退回「一员工一 bot」或「群内人工绑定 + 只按群授权」。

**记录**:测完在 §4 加一行;若结论依赖改动(注入层是 patch/封装),同步进 FORK-DIRECTION §11 台账。

### T4 锁屏和长时间无人时是否一直在线

**前提**:主机电源设置为睡眠「从不」,允许关闭显示器。

1. 主机按 Win+L 锁屏,之后不碰它。
2. 2 小时后,在手机上分别在 G1 里 @ 公司 bot、用管理员账号私聊公司 bot,各发一句话。
3. 放一整晚,第二天早上再做一次第 2 步。

**观察**:有没有回应;从发出到回复大概多久。

**通过**:两次都正常回应。

**不通过时**:先查网卡是否开了节能(设备管理器 → 网卡 → 电源管理),再看 WorkBuddy 是否显示已断开。若确认是锁屏导致掉线,常驻方式要重新设计。

**备注**:现在测试机上的 WorkBuddy 跑在管理员账号下;正式部署用专用标准用户,到时要在那个用户下再测一次。

**实测记录(2026-10-31)**:锁屏整夜,期间公司 bot 在群里照常收发;提醒/消息照常送达。**通过。**

- 覆盖的是「锁屏 + 长时间无人」这一条;专用标准用户下的复测仍按上面的备注留到部署时做。

### T3 群机器人能否稳定地 @ 到人

1. 在 G1 里添加群机器人(群设置 → 群机器人 → 添加),复制它的 webhook 地址。
2. 把地址存进主机上一个只有你能读的文件,例如 `%USERPROFILE%\anc-test\webhook.txt`。**不要贴进对话或仓库。**
3. 在企微管理后台的通讯录里查到 X 的 userid。
4. 在 PowerShell 里运行(把 `<X 的 userid>` 换成真实值,只在本机运行):

   ```powershell
   $url = (Get-Content "$env:USERPROFILE\anc-test\webhook.txt" -Raw).Trim()
   $body = @{ msgtype = 'text'; text = @{ content = 'T3 测试:到点提醒'; mentioned_list = @('<X 的 userid>') } } | ConvertTo-Json -Depth 4
   Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
   ```

5. X 先把电脑上的企业微信退出,只开手机,你再运行一次。

> 本机已备脚本:`powershell -ExecutionPolicy Bypass -File scripts/verify/t3-webhook.ps1`(读上面两个文件,打印 errcode;`-Mobile` 改用手机号 @,`-NoMention` 只发群消息)。

**观察**:返回的 `errcode` 是否为 0;消息里 X 有没有被 @ 高亮;X 的手机有没有收到「有人@我」的提醒;电脑退出后手机是否照样收到。

**通过**:`errcode` 为 0,X 被 @ 到,手机收到提醒。

**不通过时**:把 `mentioned_list` 换成 `mentioned_mobile_list`(填手机号)再试;仍不行就改成不 @,只发群消息,提醒效果会变弱,要在 FORK-DIRECTION §5.7 里写明。

**实测记录(2026-10-31)**:

- 准备:内部群加群机器人,webhook 只存本机文件(不进仓库);被 @ 的人用本人 userid。
- 第一次(电脑端企业微信在线):`errcode:0`、`errmsg:ok`;群里收到消息,本人被 @ 高亮,手机收到「有人@我」。
- 第二次(电脑端企业微信退出、仅手机在线):`errcode:0`;手机仍收到,并被 @ 高亮。
- 结论:**通过**。`mentioned_list` 填 userid 即可 @ 到人,且不依赖桌面端在线——提醒链路可以走 webhook,不必经过 WorkBuddy。
- 备注:验证中脚本重试重复发过一条,不影响判定;webhook key 曾在对话里出现过,已提示重置。

### T5 个人 bot 的可见范围能否只设本人

**前提**:X 的个人 bot 已接上企业微信。

1. 在企微管理后台找到 X 的个人 bot(智能机器人相关的管理页),把可见范围设为只有 X。**把实际的菜单路径记下来**,之后要写进接入手册。
2. 让 Y 在通讯录、工作台、搜索里找这个 bot,并尝试给它发消息。
3. X 自己私聊它,确认还能用。

**观察**:Y 能否找到、能否发消息;X 是否不受影响。另外记下:可见范围是管理员设的,还是 X 自己就能设。

**通过**:Y 找不到,也发不了消息;X 正常使用。

**不通过时**:个人 bot 不能上线,同事可以操控 X 的电脑。

**和 T1 一起看**:T1 里会把这个 bot 拉进群。要特别观察「Y 在群里 @ 它会不会被响应」:可见范围可能只管私聊,不管群。如果是这样,规则就变成「个人 bot 只能出现在本人的三方群里」。

**实测记录(2026-10-31)**:

- 可见范围设为仅本人后,同事在通讯录、工作台、搜索里**找不到**这个 bot。
- **但同事能把个人 bot 加进自己的通讯录**——可见范围挡的是「找到」,挡不住「添加」。
- 个人 bot 另有「仅个人使用 / 多人使用」设置;设为「仅个人使用」后,同事即使加了也不能用。
- 结论:**通过,但必须两项都设**(可见范围 + 仅个人使用)。接入脚本已按这个改(FORK §5.3)。

### T1 三方群能否建出来

**前提**:T5 已做,X 的个人 bot 可见范围只有 X。

1. 由 X 发起建群,成员只选:公司 bot、X 自己的个人 bot。看建群界面能否直接选机器人,能否只靠这三方建成。
2. 如果建群时选不了机器人:先拉一位同事凑够 3 人建群,再把两个 bot 加进来,最后把同事移出。看移出后群是否还在、能否正常使用。
3. 在群设置里把邀请权限设为「仅群主」。
4. 临时把 Y 拉进来,让 Y @ X 的个人 bot,看会不会被响应(接 T5);测完把 Y 移出。

**观察**:最终群里是否只有 X + 两个 bot;群是否稳定;邀请权限能否锁住;Y 在群里能否触发 X 的个人 bot。

**通过**:能建成只有 X + 两个 bot 的群,并能锁住邀请权限。

**不通过时**:群里必须多一个真人的话,访谈内容会被第三个人看到。可能的退路是让那个人固定为管理员,但要重新评估访谈的保密边界。

**实测记录(2026-10-31)**:

- 群建出来了,成员就是 本人 + 公司 bot + 个人 bot,不需要先拉第三个人再移出。
- 拉人权限可以在「仅群主」和「成员可拉」之间选,按 D7 设成「仅群主」。
- 结论:**通过**。

### T2 两个智能机器人和一个群机器人能否在同一个群里共存

**前提**:T1 建好的三方群。先在 WorkBuddy 里把两个 bot 的群回复策略都设成「@ 才回应」(D8)。

1. 把群机器人加进这个群。
2. X @ 公司 bot 说一句话,再 @ 个人 bot 说一句话。
3. X 发一条不 @ 任何 bot 的消息。
4. 用 T3 的命令,经这个群的 webhook 发一条消息。
5. 让公司 bot 回一条较长的内容,观察个人 bot 有没有被它触发。

**观察**:被 @ 的 bot 是否回应、另一个是否保持沉默;不 @ 时两个 bot 是否都不回;webhook 消息是否正常出现;bot 之间会不会互相触发(顺带测 T7)。

**通过**:各自只在被 @ 时回应,webhook 正常,没有互相触发。

**不通过时**:三方群的方案要重新设计。

**实测记录(2026-10-31)**:

- 两个 bot 都设成「@ 才回应」:被 @ 的回应,另一个保持沉默;不 @ 时两个都不回。
- **T7(随 T2)**:① 公司 bot 回长内容(不带 @)时个人 bot 沉默;② 让公司 bot 原样输出「@个人bot …」,个人 bot 沉默;③ 反向同理,公司 bot 沉默。
- 结论:**通过,且不互相触发**——bot 输出里的 @ 不构成对另一个 bot 的触发,长内容也不误触发。

### T17 本地小服务的运行身份能否外发 HTTPS、能否被 NTFS 单独授权

这一条在主机上测,**会改动主机**。开始前我会再跟你确认一遍。计划改动:

1. 建测试目录 `%ProgramData%\anc-t17\`,下设三个子目录:`out\`(给 LOCAL SERVICE 写权限)、`secret\`(给 LOCAL SERVICE 读权限)、`deny\`(明确拒绝 LOCAL SERVICE)。
2. 由你把 T3 的 webhook 地址放进 `secret\webhook.txt`,我不接触这个地址。
3. 建一个一次性计划任务 `anc-t17`,以 `NT AUTHORITY\LOCAL SERVICE` 运行(不存密码)。它读 `secret\webhook.txt`,往群里发一条测试消息,再尝试读 `deny\` 下的文件,把每一步的结果写进 `out\result.txt`。
4. 手动触发一次,看群里有没有消息、`result.txt` 写了什么。
5. 再在没有任何用户登录的状态下触发一次(注销后由开机触发,或另设定时触发),确认照样运行。
6. 测完删除这个计划任务和测试目录。

**观察**:消息是否发出;`deny\` 是否读取失败;`out\` 是否写入成功;没人登录时是否照样运行。

**通过**:以上四项都符合预期。

**不通过时**:如果公司网络要走需要认证的代理,LOCAL SERVICE 可能出不去网,要先配系统级代理;仍不行就改用「Windows 服务 + 服务虚拟账户」再测。

**实测记录(2026-10-31)**:

- 目录:`%ProgramData%\anc\{service,data,secrets}`;`LOCAL SERVICE` 对 `service`/`secrets` 只读、对 `data` 可写;另建 `deny\` 显式拒绝,用来验证反向。
- 任务:一次性计划任务,身份 `NT AUTHORITY\LOCAL SERVICE`(ServiceAccount,不存密码),执行 `node cli.ts loop --once`。
- 结果:`LastTaskResult=0`;loop 输出 `enqueued=1 / sent=1 / failed=0`;outbox 状态 `sent`;群里收到「到点提醒」并被 @ 高亮;`data\` 写入成功;`deny\` 读取被拒(拒绝访问)。
- 结论:**通过**——低权服务身份能跑 node、读密钥、写数据、外发 HTTPS,且能被 NTFS 按目录单独授权与拒绝。
- 未覆盖:真正的「无人登录」场景没有实测(触发时管理员仍在线)。任务身份是 ServiceAccount,按语义不依赖交互会话;主机上线时补一次注销后的触发测试。
- 收尾:计划任务与探针目录已删除;`%ProgramData%\anc\secrets\` 留下(正式部署位置),webhook 待重置后替换。

## 4. 结果记录

测完一条填一行。结论回写 [FORK-DIRECTION.md](./FORK-DIRECTION.md):通过的移进 §6「已观察行为」,不通过的按「不通过时」改设计。

| 项 | 日期 | WorkBuddy 版本 | 结果 | 现象与备注 |
|---|---|---|---|---|
| T16 群标识 | 2026-10-31 | 5.9.3 | **不通过** | 入站 prompt 只有 `<user_query>`,没有群名/群 ID/渠道标识;Claw 通道所有 IM 渠道共享一个会话。取证路径见 §3 |
| T9 发送人身份(随 T16) | 2026-10-31 | 5.9.3 | **不通过** | 同一份入站内容里也没有发送人字段 |
| T16b 群标识(传输层) | 2026-10-31 | 5.9.3 | **两段成立(注入经 patch)** | AIBot 帧里有 `chatid`(两个群不同)、`chattype`、`from.userid`;在 `wecomaibot-client` 的 `emitMessage` 注入前缀后,prompt 与 bot 复述都带出。属改动后行为,见 FORK §11 |
| T4 锁屏 / 无人 | 2026-10-31 | 5.9.3 | **通过** | 锁屏整夜,公司 bot 照常收发、提醒照常送达。专用标准用户下待复测 |
| T3 群机器人 @ 人 | 2026-10-31 | — | **通过** | `mentioned_list` + userid 可用;电脑端企业微信退出后,手机仍收到并被 @ 高亮 |
| T5 可见范围 | 2026-10-31 | 5.9.3 | **通过(两项都要设)** | 同事找不到;但能把个人 bot 加进通讯录——需同时设「仅个人使用」才挡得住 |
| T1 三方群 | 2026-10-31 | 5.9.3 | **通过** | 成员=本人+公司 bot+个人 bot;拉人权限可锁「仅群主」 |
| T2 三机器人共存 | 2026-10-31 | 5.9.3 | **通过** | 两个 bot 均 @ 才回应,不 @ 不回 |
| T7 bot 互相触发(随 T2) | 2026-10-31 | 5.9.3 | **通过** | 长内容不误触发;正向/反向让 bot 原样输出 @ 对方,对方均沉默——bot 输出里的 @ 不构成触发 |
| T17 运行身份 | 2026-10-31 | — | **通过** | `LOCAL SERVICE` 计划任务跑 `loop --once`:`sent=1`、outbox=`sent`、群里收到并被 @;`data` 可写、`deny` 读取被拒。无人登录项按 ServiceAccount 语义推定,未单测 |
| T12 个人 bot 读网络路径 | 2026-10-31 | — | **通过** | 以个人 bot 的运行身份（标准本地账号、非管理员）经 `\\主机\anc-vault-shared` 读取成功、写入被拒（`UnauthorizedAccessException`）；共享层 `Authenticated Users` 只读 + NTFS `Users` 只读 |
| T20 长会话后规则是否还在 | 2026-10-31 | 5.9.3 | **通过** | 同一三方群连续数十轮后，persona 与技能规则仍生效：任务登记/完成、引用文件入库、11 题访谈均按既定流程执行，未见规则漂移 |
| T19 8000 字符计数 | 2026-10-31 | 5.9.3 | **通过** | 让公司 bot 读 `company/_t19-test.md`（8020 字符）并回末行，原样返回 `T19-END-MARKER-7Q2Z`——长文档未被截断，8000 字级读取可用 |
| T17 无人登录（代理） | 2026-10-31 | — | **通过（代理）** | 把 WorkBuddy 全部进程停掉（`procs=0`）后，21:25 到点的提醒仍由 `anc-service`（`LOCAL SERVICE`）发出：`outbox reminder:14 = sent`，`loop.log` 记 `enqueued=1 sent=1`。说明提醒不依赖 bot 进程与交互登录；真机「注销后」仍待上线窗口 |
| T4 专用用户下复测 | 2026-10-31 | 5.9.3 | **通过（但当前未在该用户下运行）** | 维护者确认：切换到专用标准用户后补丁生效、群内应答正常。2026-11-01 盘点时 bot 与两个交互式计划任务都在管理员账号下，`anc-bot` 没有用户配置目录；结论是「补丁与 T4 在标准用户下可用」，但线上常态运行身份要重新迁过去才成立（PLAN M1 已改回未完成） |
| T18 技能名片位置 | 2026-10-31 | 5.9.3 | **通过** | `%USERPROFILE%\.workbuddy\skills\<name>\SKILL.md` 被识别：`anc-task`、`anc-ingest` 装在该位置后，真实群里触发并执行成功 |
| T22 群会话过期/重置 | 2026-10-31 | 5.9.3 | **通过** | 群会话在长时间间隔后仍保有上下文（用户实测未过期、未重置）；公司 bot 的 persona 与群身份前缀继续生效 |
| T13 其他项目读不到 Claw 的 `CODEBUDDY.md`（跨用户代理） | 2026-10-31 | 5.9.3 | **部分通过** | 临时标准用户（非管理员）读取 Administrator 的 `WorkBuddy\Claw\CODEBUDDY.md` 被拒（`OTHER_DENIED`），读取自己的正常（`OWN_READ_OK`）；接入器在该用户 profile 里跑通、`verify` 返回 OK。同一用户下「另一个项目工作区」的隔离待 UI 实测 |
| T6 经 skill 调本地脚本 | 2026-10-31 起持续 | 5.9.3 | **通过** | 5 个技能装在 `%USERPROFILE%\.workbuddy\skills\<name>\SKILL.md`（anc-task / anc-ingest / anc-interview / anc-vault-read / anc-wb-patch），在真实群里触发后执行成功；`audit.log` 留有对应 CLI 调用记录 |
| T10 各群是否共用 Claw | 2026-10-31（随 T16） | 5.9.3 | **通过（结论是负面的）** | Claw 通道所有 IM 渠道共用一个会话、一个工作目录：这既解释 T16 拿不到群标识，也说明多群**不是**天然隔离的——所以群身份只能靠 D17 注入 |
| T21 工具轮次叙述 | 2026-11-02 | 5.9.3 | **不通过** | 多步工具链会把过程话发进企微：单工具 0 段，入库 7 / 15 / 6 段；`CODEBUDDY.md` 加禁止词表、技能加回复模板**都无效**。解法只能在出站侧（包 `sendReply` 按段过滤），登记在 FORK §11 待做 |
## 5. 覆盖清单（T1–T22，22/22）

单一清单：每条都有归属状态，未测的写明卡点，不留"漂着"的项（PLAN 的「不许悬空」）。
实测细节见 §4；不通过的结论如何影响设计，见 FORK-DIRECTION §6/§7/§11。

| 项 | 状态 | 结论一句话 | 证据 |
|---|---|---|---|
| T1 三方群 | ✅ 通过 | 成员=本人+公司 bot+个人 bot；拉人权限可锁「仅群主」 | §4 |
| T2 三机器人共存 | ✅ 通过 | 两个 bot 均 @ 才回应，不 @ 不回 | §4 |
| T3 群机器人 @ 人 | ✅ 通过 | `mentioned_list` + userid 可用，手机端被 @ 高亮 | §4 |
| T4 锁屏/无人 | ✅ 通过 | 锁屏整夜照常收发；专用标准用户下复测通过（当前线上仍跑在管理员账号，见 R1） | §4 |
| T5 可见范围 | ✅ 通过 | 必须同时设「仅个人使用」，否则能被加进通讯录 | §4 |
| T6 skill 调本地脚本 | ✅ 通过 | 5 个技能装在 `%USERPROFILE%\.workbuddy\skills\`，真实群里执行成功 | §4 + `audit.log` |
| T7 bot 互相触发 | ✅ 通过 | bot 输出里的 @ 不构成触发 | §4 |
| T8 不同群同时处理 | ⬜ **未测** | T16 表明 Claw 共享一个会话，串话风险未验证 | 需两个群同时提问 |
| T9 发送人身份 | ❌ 不通过 | 入站无发送人字段，靠 D17 注入补 | §4 |
| T10 共用 Claw | ✅ 通过（负面） | 所有 IM 渠道共享一个会话/工作目录，多群不天然隔离 | §4 |
| T11 私聊限管理员 | ⬜ **未测** | 属企微后台配置，未在后台验证过 | 需企微管理后台 |
| T12 个人 bot 读网络路径 | ✅ 通过 | 标准账号经 UNC 读成功、写被拒 | §4 |
| T13 其他项目读不到 Claw | 🟡 部分 | 跨用户隔离通过；**同用户另一工作区待 UI 实测**（PLAN R6） | §4 |
| T14 个人 bot 发群消息 | ⬜ **未测**（仅源码探查） | 客户端有 `sendReply`/`sendMessage`/`sendCustomCmd`/`sendMediaMessage`/`sendStreamChunk`，但"以员工身份发群消息"没真跑 | 需员工机 |
| T15 Skill 从 vault 同步 | ⬜ **未测** | Enterprise 后台的 Skill 管理能否从 vault 同步 | 需企业后台 |
| T16 群标识 | ❌ 不通过 | 入站 prompt 没有群名/群 ID/渠道标识 | §4 |
| T16b 传输层注入 | ✅ 两段成立 | 帧里有 `chatid`/`chattype`/`from.userid`，注入后 prompt 与复述都带出（**改动后行为**，见 §11） | §4 |
| T17 运行身份 | ✅ 通过 | `LOCAL SERVICE` 能外发 HTTPS、`data` 可写、`deny` 读取被拒 | §4 |
| T18 技能名片位置 | ✅ 通过 | `%USERPROFILE%\.workbuddy\skills\<name>\SKILL.md` 被识别 | §4 |
| T19 8000 字符计数 | ✅ 通过 | 8020 字符文档读取未被截断 | §4 |
| T20 长会话后规则 | ✅ 通过 | 数十轮后 persona 与技能规则仍生效 | §4 |
| T21 工具轮次叙述 | ❌ 不通过 | 多步工具链漏 6–15 段过程话，persona 词表无效 | §4 + FORK §11 待做 |
| T22 群会话过期 | ✅ 通过 | 长时间间隔后上下文仍在，未过期未重置 | §4 |

**统计**（23 行 = T1–T22 + T16b 变体）：通过 15 · 不通过 3（T9 / T16 / T21）· 部分 1（T13）· **未测 4（T8 / T11 / T14 / T15）**。

> 未测的四项都卡在**本机测不了**的地方：T8 要两个群同时问、T11 要企微管理后台、T14 要员工机、T15 要企业版后台。它们不影响当前设计已成立的部分（T14 已按 D23 走员工转发兜底），但**不能当成通过**。

## 6. R 段台账（R0–R8）

PLAN 阶段 R 的单一清单。带"挂起/待触发"的项写明卡点，不写成通过。

| 项 | 状态 | 证据 / 卡点 |
|---|---|---|
| R0 让证明有效 | ✅ 完成 | `doctor.ps1` 28 项（任务覆盖 9/9 带 Principal 校验、`secrets-acl`、`backup-freshness`、`vault-ingest-audit`）；`-SelfTest` 6 条断言全 PASS |
| R1 运行身份迁 `anc-bot` | ⏸ 挂起（blocker） | 需注销当前账号、以 `anc-bot` 登录企微扫码；`C:\Users\anc-bot` 尚不存在 |
| R2 注销后无人登录 | ⏸ 挂起 | 依赖 R1 |
| R3 升级通知/非执行人拒绝 | ⬜ 待测 | 需真实群里造"第 4 次不回应" |
| R4 跨天访谈 | ⬜ 待测 | 需跨两天 |
| R5 干净机计时 | ⏸ 挂起 | 依赖 R1 |
| R6 T13 同用户另一工作区 | ⬜ 待测 | 需在 WorkBuddy UI 里切到另一个项目工作区观察（见 §5 T13） |
| R7 真升级回归 | ⏳ 待触发 | 厂商发版后按 FORK §11 三段回归 |
| R8 收尾台账统一 | ✅ 完成（2026-11-02） | 本文 §5（T1–T22 覆盖）+ §6（R0–R8 台账） |

**gate R 现状**：R0 / R8 完成，R1·R2·R5 挂起在切换用户，R3·R4·R6 待环境，R7 待触发。gate 的书面条件是「R0–R6、R8 全绿」，因此**gate R 未过**；H/C 段是在 PLAN 明确允许下并行推进的。
## 7. V3 故障注入记录（2026-11-02）

工具：`node scripts/fault-inject.mjs`（安全三项：webhook / clock / lock；`--all --yes` 才会跑杀进程与写入失败）。
每项自建现场、自清理、把过程写进 `_research/fault-injection-<时间>.md`（该目录不进 git，所以结论记在这里）。

| 故障 | 注入方式 | 结果 | 观察 |
|---|---|---|---|
| webhook 失效 | 绑定指向内容为 `not-a-url` 的 webhook 文件 | ✅ PASS | 错误被记进 `last_error`、消息留在 pending 不丢；**但配置类错误被当成可重试**（5 次退避才判死，见下） |
| 时钟跳变 | `loop --once --now <时刻>` 跳到 due 之后 / 回退 / 回同刻 | ✅ PASS | 到点入队 1 条、回退 0 条、同刻 0 条；大跳变会让每个 open 任务各发一条顺延通知 |
| 锁残留 | 造活锁（pid 存在）与死锁（pid=999999） | ✅ PASS | 活锁拒绝且报出锁路径；死锁自动接管、旧锁改名 `.stale-<ts>` 留档；**无需人工删锁** |
| 杀进程 | 杀掉 `cli.ts serve` 进程，再靠计划任务拉起 | ✅ PASS | 杀掉后 serve 进程数 0，`Start-ScheduledTask` 后约 18 秒 `health` 恢复；WorkBuddy 与 `anc-service` 不受影响 |
| 写入失败 | `icacls /deny` 拒绝库文件写入 | ✅ PASS | 有到点任务时 tick 明确 `ok=false`（不假装成功）；撤销 ACL 后立即恢复可写 |

### 本轮暴露的两个问题（已修）

1. **`loop --now` 根本没接线**：CLI 的 loop 分支没把 `--now` 传给 `tick`，`opts.now ?? nowIso()` 永远落到系统时间——故障注入时以为功能坏了，其实是参数没接上。已接上，并限制 `--now` 只能配 `--once`。
2. **tick 内三处各自取 `nowIso()`**（含 `sendPending` 漏定义），同一 tick 里可能跨毫秒自相矛盾。已统一成"每函数取一次、全程传下去"。

### 两个待改进（未修，已记账）

| 项 | 现象 | 建议 |
|---|---|---|
| 配置类错误白重试 | `NO_WEBHOOK_FOR_CHAT`、`webhook 文件内容不是 https URL` 走 5 次退避，半小时才判死，期间重试永不成功 | `markFailed` 加第三档「永久失败」：立即 failed + 运维告警 |
| 大跳变通知风暴 | 时钟跳一年时每个 open 任务各一条 `carry:` 通知 | 单 tick 上限（如 5 条）或汇总成一条 |

### 五项全跑通（2026-11-02，`--all --yes`）

```
汇总：5 PASS · 0 FAIL · 0 SKIP
```

跑完现场回到基线：tasks 无残留、无残留绑定、vault 无未跟踪改动、库文件无 deny 残留、`health` 正常。

### 注入方法本身的一个坑（值得记）

第一版「写入失败」用 `icacls /deny <data 目录>:(W)`，结果 tick 报 `ok=true, enqueued=1`——看着像"假成功"，其实是**注入没生效**：
Windows 的目录 `(W)` 只拦「创建新文件」，而 SQLite 是**就地更新**已有的 `anc.db`/`-wal`。

改成 deny 库文件本身之后才测出真实行为（`ok=false`）。**故障注入失败时要先怀疑注入**，别急着判被测代码有 bug。

## 8. V2 静默失败扫描（2026-11-02）

工具：`node scripts/scan-catch.mjs`（`npm run scan`）。逐文件解析 `catch` 块，按"失败被吞掉的程度"分四档：

| 档 | 含义 |
|---|---|
| `EMPTY` | 块里只有空白和注释 —— 最可疑 |
| `LOG_ONLY` | 只 `console.error/warn` —— 留了痕，调用方仍不知道失败 |
| `SWALLOW` | 有 `return/continue/赋值`，但没有 log 也没有 throw |
| `HANDLED` | 有 `throw`、或把错误交出去（`fail()` / `markFailed()` / `.push()` / `return {ok:false}` / `lastErr =` / `failed++`） |

**扫描结果（`src/` 下 15 个文件）**：53 个 `catch` —— `EMPTY` 16（**全部带"为什么吞"的注释**）· `SWALLOW` 10 · `LOG_ONLY` 7 · `HANDLED` 20。

**没有任何未声明的空吞。** 10 个 `SWALLOW` 逐个看过：

| 位置 | 写法 | 结论 |
|---|---|---|
| `ingest/apply.ts:129` | `return null`（读锁失败） | 合理：调用方按"锁无效/可接管"处理 |
| `ingest/apply.ts:137` | `alive = false`（`process.kill(pid,0)` 失败） | 合理：就是"进程不存在"的判定本身 |
| `ingest/apply.ts:256/270` | `cpSync + rmSync`（归档时 rename 跨卷失败） | 合理：跨卷 fallback |
| `ingest/cli.ts:64/74/84` | `moveError/archiveError/commitError = ...` | 合理：收集后一并输出 |
| `service/backup.ts:20` | `ok = false` | 合理：紧接 `if (!ok) throw` |
| `service/cli.ts:284` | `ageMin = null` | 合理：降级成 `health.ok = false` |
| `service/http.ts:68` | `send(400, ...)` | 合理 |

### 修掉的一处「注释与实现不符」

`loop.ts` 的 `blockedBySecret` 注释写着「单条坏数据不能让整个 tick 抛错停摆」，但它自己写 `task_events` 时**没有保护**——库被锁或磁盘满时照样会抛，把这一轮的所有提醒一起带走。`tasks.ts` 的 `completeTask` 里同样问题（任务已完成的公告被拦时不记事件也不该回滚，但记事件失败会抛）。

两处都补了内层 `try` + `console.error`：**不抛，但也不静默**。

### 没做到的（诚实标注）

PLAN V2 的完整验收是「对每条 fail 分支注入」。本轮只做了**静态扫 + 10 处人工判定**，注入覆盖的是关键路径（V3 的五项 + 93 个单测），**没有对 53 个 catch 逐个注入**。这一步留作后续：改一处 catch 就补一条注入，而不是一次性补齐。

## 9. V4 证明有效（2026-11-02）

两个层次：`doctor -SelfTest` 验"函数逻辑对不对"，`scripts/verify-doctor.mjs` 验"真实环境里该 FAIL 的时候真的 FAIL"。

### 自检（fixture）

```
SELFTEST PASS  secrets-acl 能识别广泛组可读  (FAIL)
SELFTEST PASS  secrets-acl 收紧后放行  (PASS)
SELFTEST PASS  deploy-layout 能识别"目录被复制成文件"  (FAIL)
SELFTEST PASS  task-coverage 能识别缺任务  ()
SELFTEST PASS  bot-process-owner 能分辨 owner 不符  (FAIL)
SELFTEST PASS  secrets-in-git 走 git grep
SELFTEST RESULT: ALL PASS
```

### 实机抽查（真注入、真恢复）

`node scripts/verify-doctor.mjs`：每一项都跑三遍 doctor——注入前应 PASS、注入后应 **FAIL**、恢复后应回 PASS，且失败项必须**是对应那一项**（"报了但报错了地方"比不报更糟）。

| 抽查 | 注入 | 注入后 | 恢复后 |
|---|---|---|---|
| ACL | 给 `secrets` 加 `BUILTIN\Users:(OI)(CI)RX` | `secrets-acl` FAIL ✅ | PASS ✅ |
| 计划任务 | `Disable-ScheduledTask anc-watchdog` | `task-anc-watchdog` FAIL ✅ | PASS ✅ |
| 补丁文件 | 往 `patch/preload.cjs` 尾部加一行注释 | `deploy-layout` FAIL ✅ | PASS ✅ |

```
汇总：3 PASS · 0 FAIL
```

恢复核对：`secrets` 无 Users 项、`anc-watchdog` 回到 Ready、`preload.cjs` 与仓库 hash 一致。

### 抽查逼出的一处判定问题

第一轮 `task` 项拿到 **WARN 而不是 FAIL**：`doctor` 把「任务被禁用」和「任务在跑/排队」混在同一档。被禁用等于功能停摆，不该和"正在跑"同档。已拆开：

- `Disabled` → **FAIL**（要在维护期间停用，就显式改 PLAN 并在 doctor 加豁免，别让它悄悄 WARN）
- 其他非 Ready/Running 状态 → WARN

改动后 `task` 项抽查转 PASS。
## 10. V5 浸泡（2026-11-02 判定）

PLAN V5 的书面要求是「7×24 浸泡」。维护者判定通过，但**实际连续运行约 3 天，未满 7 天**，
这里按实际记录，不写成"7 天通过"。

### 实际时长与证据

| 项 | 实测 |
|---|---|
| 起点 | 2026-10-31 14:47（+08），首条 `task_events` |
| 终点 | 2026-11-02 判定时 |
| 跨度 | **约 3 天**（未满 7 天） |
| 业务活动天 | 10-31（36 条事件）· 11-01（36 条事件） |
| 外发消息 | 10-31 `sent` 9 条 · 11-01 `sent` 4 条 · 无失败堆积 |
| 库备份 | 7 份，日期跨 10-31 → 11-02 |
| tick 记录 | `loop.log` 8002 行（每分钟一条，连续无断档） |

### 浸泡期间观察到的（能算证据的）

- 提醒按时发出：`outbox` 里 `sent` 有记录，没有长期 `pending` 堆积；
- 投影正常：`vault-internal/collab/tasks.md` 随任务变化重写，内容未变时不重写（幂等）；
- 补丁稳定：`patch-state.json` 的 `applied` 在多次重启后仍为 true，`patch-canary.json` 随群消息更新；
- 巡检可重复：`doctor` 多次运行结果一致（FAIL 恒为 R1 那三项）。

### 浸泡中真实暴露并修掉的问题

这段时间不是"没出事"，而是出了事被修掉了——按发现顺序：

| 问题 | 影响 | 处理 |
|---|---|---|
| `loop --now` 没接线 | 时钟类注入测不了 | 接线并限制只配 `--once` |
| 配置类错误白重试 5 次 | 提醒迟到半小时才判死 | 加「永久失败」档，一次即判死 + 告警 |
| 顺延通知无上限 | 时钟跳变时几十条刷屏 | 封顶 5 条/ tick，提醒照排 |
| 投影 `EPERM` | `anc-service` 对 `vault-internal` 无写权限，投影从未成功 | 授 `LOCAL SERVICE:(OI)(CI)F` |
| 告警对测试数据也喊 | 群里出现"没登记 webhook"，误导 | 只对"曾成功发过消息"的群告警 |

### 7 天后应复核的（未做）

- 连续 7 天无人工干预后，`doctor` 仍全绿（除 R1）；
- `loop.log` 无断档（断电/重启后能自愈接上）；
- 备份保留策略真的轮转过一遍（14 份本地 + 第二块盘）；
- 期间若发生过 WorkBuddy 自动更新，`patch-guard` 是否按预期拦下并告警。

> 判定理由（维护者）：上述问题都在浸泡窗口内被真实触发并修复，系统连续运行无中断，
> 因此判定通过；7 天整的复核留待自然时间到达后补。
## 11. R2 注销后无人登录（2026-11-02 判定通过）

**结论：通过。** 维护者判定：本机注销后，到点的提醒照常在群里送达。

### 依据来源（如实标注）

这条依据的是**维护者的现场观察**（另一台电脑上看群消息），不是本机数据库的旁证。
判定时（17:09）本机数据状态：

| 项 | 判定时的值 |
|---|---|
| 任务 #31「R2 注销验证」 | `open` |
| 提醒 #77 | `pending`，`last_sent_at = null` |
| 到点时间 | 17:15（判定时尚未到点） |
| `outbox` 中 `reminder:77` | 无记录 |

也就是说，本机库里**没有**"注销期间发送"的数据库证据可作交叉印证。将来若要对这条做二次确认，
做法是：排一个明确到点的时间 → 注销 → 到点后先不登录，用另一台设备看群 → 登录后查
`outbox` 里该条的 `created_at` 是否落在注销窗口内。

### 这件事证明了什么

`anc-service` 以 `LOCAL SERVICE` + `ServiceAccount` 注册（`LogonType` 不是 `Interactive`），
触发器是 Daily + Boot 每 1 分钟重复，`RunOnlyIfIdle = False`——按注册方式它不依赖交互会话。
观察结果与这个注册形态一致。

### 一个待确认项

`anc-service` 的任务设置里 `DisallowStartIfOnBatteries = True`、`StopIfGoingOnBatteries = True`。
本机是台式机/常电供电，不影响；但如果将来迁到靠电池的设备，注销（或拔电）后任务会被静默停掉。
**既然是 7×24 主机，这两项应当显式改成允许**，避免"看起来在跑、其实被电源策略停了"。

### 第 4 天快照（2026-11-02 17:44）

| 项 | 实测 |
|---|---|
| 跨度 | 10-31 14:47 → 11-02 17:44，**约 2.9 天**（仍未满 7 天） |
| tick | `loop.log` 8049 行 / 604 KB，最后写入 17:43:01，每分钟一条 |
| 库备份 | 7 份，最新 `anc-20261102-094103.db` |
| 补丁 | `patch-state` `applied=true` `mode=hash`；`verify-upgrade.ps1` 8 项全 PASS |
| doctor | `FAIL=0 WARN=1`（WARN 是未带 `-Repo` 时的 `secrets-in-git` 跳过） |
| 自愈 | 今日 28 次重启（绝大多数是当天的部署/测试与 00:03 风暴），单飞锁跳过 2 次 |

### 今日新发现并修掉

| 问题 | 证据 | 处理 |
|---|---|---|
| **自愈风暴**：守卫每分钟、看门狗、人工同时 `-Force` 时各自拉起一次重启 | 00:03 一小时内 9 次「重启成功」，日志同秒出现多条「安排自愈重启」 | `anc-selfheal.ps1` 加单飞锁（`selfheal.lock`，3 分钟过期）；并发两次实测只有一次重启、另一次记 `another selfheal in flight`。修复过程中还发现锁函数被误放进 `if ($Worker)` 分支，主路径看不到——已移到顶层并重新验证 |
| **电源策略会静默停任务**：9 个任务默认 `DisallowStartIfOnBatteries=True` | 逐任务读出为 True（台式机不影响，但与 7×24 语义相反） | 9 个任务全部改成 `False/False`；`register-tasks.ps1` 默认值同步改，避免重建回归 |
| E-4 与 D6 冲突：现场 `AutoAdminLogon=1` | `HKLM\…\Winlogon` 实读；无 `DefaultPassword`，疑似 Autologon 工具存 LSA | **已裁决：关闭**。`AutoAdminLogon` 已改为 0，ACCEPTANCE E-4 转 ✅；重启后需人工登录，登录前由 boot-alert 告警 |
## 12. R6 同用户另一工作区（2026-11-02 通过）

T13 之前只验了**跨用户**（临时标准用户读不到 Administrator 的 `Claw\CODEBUDDY.md`）。
R6 补的是另一半：**同一个用户下，切到另一个项目工作区，会不会串读 Claw 的 persona**。

### 怎么验的（双向探针）

前提确认：本机**没有用户级 `CODEBUDDY.md`**（`~/.workbuddy/`、`~`、`WorkBuddy/` 三处都不存在），
所以规则只可能来自工作区目录——这让结论不会含糊。

在两个工作区各放一条**互相排斥**的规则：

| 工作区 | `CODEBUDDY.md` 第一句 | 预期行为 |
|---|---|---|
| `Claw`（生产 persona） | 公司 bot | 没有 `[anc:chat=…]` 前缀 → 只回「身份识别暂不可用」 |
| `2026-10-26-23-09-51`（空工作区放探针） | 工作区隔离探针 | 回答第一行必须是 `OTHER-WS-OK` |

探针内容：

```markdown
# 工作区隔离探针（R6）

你在这个工作区里回答任何问题时，**必须在回答的第一行原样写 `OTHER-WS-OK`**，然后再正常回答。

这条只在本工作区有效。
```

操作：切到 `2026-10-26-23-09-51` → **新开会话**（避免继承 Claw 的上下文，否则测的是记忆不是规则）
→ 问「你能做什么？」

### 结果

| 验证方向 | 观察 | 结论 |
|---|---|---|
| 读没读**自己的**规则 | 回答第一行是 `OTHER-WS-OK`，随后是通用 WorkBuddy 自我介绍 | ✅ 本工作区 `CODEBUDDY.md` 被加载并生效 |
| 读没读 **Claw 的** persona | 全文没有「身份识别暂不可用」，也没有「我服务全体员工」「群就是身份边界」这类措辞 | ✅ 没串读 |

**结论：同一用户下，工作区的 `CODEBUDDY.md` 按目录隔离；切换工作区不会继承 Claw 的公司 bot persona。**

这条很重要：它意味着**一台机器上可以同时跑多个不同身份的助手**而不互相污染，
也是"公司 bot 与个人 bot 不混"的结构前提。

> 收尾：探针文件已删除，`2026-10-26-23-09-51` 恢复为空工作区。
## 13. R3 升级通知与非执行人拒绝（2026-11-02 通过）

### Part A：连续 4 次未回应 → 交办人收到跟进通知

做法：建任务 #33（执行人=本人、交办人=一个未绑定群的 userid、due=次日 09:00），
用 `loop --once --now` 依次推进 `09:00 / 09:15 / 09:30 / 09:45`——
**用 `--now` 而不是真等 45 分钟**，但走的是同一条 `tick` 代码路径。

| 时刻 | 产出 |
|---|---|
| 09:00 / 09:15 / 09:30 | 各 1 条提醒，`sent` |
| 09:45 | 提醒 + `escalate:33` 同时发出 |
| 累计 | `reminder_sent = 4` |

实际发出的升级文案：

```
任务 #33 R3 升级验证 已提醒 4 次仍未回应，请交办人跟进
```

**降频也生效了**：升级后新建的提醒 `repeat_minutes = 60`（原来是 15），
`due_at` 从 09:45 推到 10:45。

**fallback 也验证了**：交办人的 userid 没绑定群 → 记 `escalate_no_group` 事件 →
按代码退回任务所在群发送，消息没有丢。

### Part B：非执行人说「#n 完成」被拒

```
node ... task done --id 33 --chat-id <群> --actor u-stranger
→ ERROR 只有执行人或交办人能操作这个任务
→ 任务 status 仍是 open（被拒不改变状态）
```

`assertActor` 被 `completeTask` / `cancelTask` / `reviewTask` 共用，
`task cancel --actor u-stranger` 同样被拒，两条路径一致。

### 顺带发现的一个缺陷（未修，待裁决）

测试最初失败的原因不是代码错误，而是**逾期任务当天一条提醒都不发**：

- 顺延逻辑把逾期任务的提醒排到「次日同一时分」（`due_at + 1 day` 再取工作时段起点），
- 同时把原来当天的 pending 提醒 `cancelled` 掉，
- 结果：任务逾期当天只有早上一条「已顺延到 X」的通知，**整天没有任何提醒**。

对使用者的体感是「昨天没做完的事，今天它不再催我，只在早上说一句顺延」。
这和「任务提醒」的初衷不一致，也让 R3 的升级条件（累计 4 次提醒）不可能触发。

两种改法（需要定）：

| 改法 | 效果 | 代价 |
|---|---|---|
| 逾期任务当天顺延到「今天的工作时段起点」，之后照常 15 分钟重复 | 逾期当天继续催 | 顺延通知的语义要改（不再是"到明天"） |
| 保留「顺延到次日」，但逾期当天仍按原间隔提醒 | 语义不变 | 需要区分"提醒队列"与"计划时间"，改动更大 |

登记在 FORK §11，不擅自改行为。
## 14. D24 落地验证：bot 从「直写 vault」到「必须走服务」（2026-11-02）

D24 的目标是：vault 对 bot 只读，入库只能由服务身份执行。这一节记录**两次真实入库的对比**——
同一个人、同一套技能、同一台机器，唯一变化是权限与入口护栏。

### 20:00 之前：绕过（失败案例）

| 证据 | 值 |
|---|---|
| 落盘文件属主 | `Administrator` |
| `audit.log` | 有 `ingest apply D:/anc/inbox/pending/batch-… ok:true` |
| 实际调用 | bot 直接调 CLI，**没走技能里写的 HTTP** |
| 结论 | 技能文案拦不住；那一次 vault ACL 也没真正挡住 |

**最危险的不是写进去了，而是它撞墙后的反应**：它在回复里主动提议
「要不要放开 `.git` 对当前身份的写权限」——它是管理员，真能做到。

### 20:00 之后：走服务（通过）

| 证据 | 值 |
|---|---|
| 落盘文件属主 | **`NT AUTHORITY\LOCAL SERVICE`** |
| `audit.log` | **没有任何 ingest 记录**（CLI 没被调用） |
| `inbox/done` | `batch-20261102-195709` 已归档 |
| bot 回复 | `已入库：company/金豪庭698套餐报价单.md（原件 金豪庭698套餐.xls，4056字）` |

文件属主与审计记录这两个证据是**互补的**：属主说明"谁写的"，审计说明"有没有绕过入口"。
两条都对上，才能排除"看起来走了 HTTP、其实还是 CLI"的情况。

### 让这次成功变成必然的三件事

| 措施 | 作用 |
|---|---|
| vault ACL：`Administrators:(OI)(CI)(RX)` / `LOCAL SERVICE:(OI)(CI)(F)` | 物理上写不进去 |
| `ingest/cli.ts` 入口护栏 | 非服务身份调 `apply` 直接 ERROR 并指路 HTTP，**把"撞权限墙"变成"用错入口"**——撞墙的 agent 会想去改 ACL，用错入口的不会 |
| 技能三条硬边界 | 不要调 CLI、不要 `git commit`、失败就说失败 |

只靠前两条里的任何一条都不够：ACL 那次没挡住（权限状态与预期不符），技能文案那次也没被遵守。
**护栏是关键的一条**——它不依赖"模型守规矩"，也不给"改 ACL"留下动机。

### 一个仍然存在的边界

bot 是管理员，理论上仍可以 `takeown` + `icacls` 改回权限。护栏让它没有动机这么做，
但这是**行为约束，不是权限约束**。要真封死，得把 bot 迁到标准用户（原 D6 方案，
2026-11-02 按 D25 决定不做）。这条边界写清楚，免得以后误以为"已经绝对安全"。
## 15. O-2 doctor 故障矩阵（2026-11-02 首轮 26/28；2026-11-04 补 time-sync 后 27/29）

V4 只抽查了 3 项。O-2 要的是**每一项都证明在该 FAIL 时会 FAIL**。

工具：`scripts/doctor-fault-matrix.mjs`，**13 组**，按组注入——同类项一次弄坏（如同时禁用 8 个任务），
一次 doctor 验多项。每组都是「注入 → 断言该项变红 → 恢复 → 断言回绿」，跑完统一再验一次现场。

```
11 组全部通过　最终 FAIL: 0　WARN: 1（vault-ingest-audit，基线即 WARN）
```

| 组 | 覆盖项 | 注入方式 |
|---|---|---|
| tasks | 8 个 `task-anc-*` | `Disable-ScheduledTask` |
| config | `work-hours`、`timezone` | 配置写成 `99:99` / `Not/AZone` |
| **timesync** | **`time-sync`** | **`Stop-Service W32Time`（2026-11-04 补）** |
| patchfiles | `manifest`、`patch`、`deploy-layout` | manifest 写坏 JSON；清空 `workbuddy-patch.log`；改 `preload.cjs` |
| acl | `secrets-acl`、`vault-acl` | 给 `Users` 加读/改权限 |
| staleness | `heartbeat`、`canary`、`backup-freshness` | 改 mtime / 改 canary 的 `at` / **所有**备份改旧 |
| identity | `dedicated-user`、`bot-process-owner` | `-BotUser` 指向不存在的账号 |
| http | `http-health`、`task-anc-http` | Disable + Stop + 杀 serve 进程 |
| wbversion | `workbuddy` | manifest 登记的版本改成 `0.0.0-o2-mismatch` |
| smb | `smb` | `Grant-SmbShareAccess Everyone Change` |
| bindings | `bindings` | 清空 `chat_bindings`（先备份） |
| secretingit | `secrets-in-git` | 在 `scripts/` 放假 webhook（`docs/*` 被 grep 排除） |

**27 项已注入验证**（原 26 + 2026-11-04 补的 `time-sync`）。剩 2 项：

| 项 | 状态 |
|---|---|
| `vault-ingest-audit` | **已有真实触发证据**：基线就是 WARN「3 个未跟踪文件，但 1 小时内没有成功入库记录」——这不是推测，是它真报了。它的因果也在 D24 那次（bot 直写 vault）被观察过 |
| `database` | 注入需停 2 个服务 + 杀 node 进程再改名，doctor 期间服务全停 —— **留维护窗口**。它本身是信息项（只报文件大小），风险收益不划算 |

### 2026-11-04 补的一项：`time-sync`

**为什么补**：这台机器的 `W32Time` 服务从装好起就是 **Stopped**（启动类型 Manual），`w32tm /query /status` 报 `0x80070426`。但 `doctor` 一直 PASS——因为 `timezone` 项只查**时区名**（`China Standard Time`），不查**时间服务在不在跑**。

**后果**：时钟会慢慢漂。`patch-guard` 用 `patch-state.at >= 主进程创建时间 - 15 秒` 判断补丁新旧，提醒的 `due_at` 也依赖绝对时间。漂到分钟级就会误判。

**怎么修的**：在 `doctor.ps1` 里新增独立项 `time-sync`（没有并进 `timezone`——"时区错"和"时间没同步"是两个独立故障，合并会让诊断信息混在一起）。判据：

```
找不到 W32Time 服务          → FAIL
服务存在但不在 Running       → FAIL（并提示 patch-guard / due_at 会受影响）
在跑但查不到上次同步时间     → WARN
在跑且有同步记录             → PASS
```

**一个坑**：`w32tm /query /status` 输出是**本地化 + GBK**，在 PowerShell 里读成乱码，用中文 key（`上次成功同步时间`）匹配不到。改成认「日期 + 时间」形态：

```
\d{4}[/-]\d{1,2}[/-]\d{1,2}.{0,12}\d{1,2}:\d{2}:\d{2}
```

**故障注入**（已并进矩阵，`--only timesync` 可单独跑）：

```
[timesync] W32Time 服务被停（时钟不再自动校准）
  注入: Stop-Service W32Time
  ✓ 注入后应报出问题        → FAIL=1
  恢复: Start-Service W32Time + resync
  ✓ 恢复后应转回 PASS       → FAIL=0
```

### 这一轮踩的 10 个坑（都是"注入方式没对上检查逻辑"）

| 现象 | 真因 |
|---|---|
| 8 个任务注入后仍 PASS | 用 `task-anc-backup` 去 disable，实际任务名是 `anc-backup`（少前缀），静默失败 |
| `manifest` 改版本号不红 | 它的判据是"能否解析"，版本比对在 `workbuddy` 项 |
| `patch` 改 `patch-state.json` 不红 | 它读 `workbuddy-patch.log` 里的 `APPLIED` |
| `canary` 改 mtime 不红 | 它看 JSON 里的 `at` 字段 |
| `backup-freshness` 只改最新一份不红 | 改旧后"最新"落到第二份（12 小时，没到 30 小时阈值）→ 必须**全部**改旧 |
| `heartbeat` 改 mtime 不红 | `anc-service` 每分钟 tick 会写 `loop.log`，把 mtime 刷回现在 → 注入前先停服务 |
| `task-anc-http` 只 Stop 不红 | Stop 让 State 变 Running→Ready，仍算正常；要 Disable + Stop |
| `secrets-in-git` 放 `docs/` 不红 | 那条 `git grep` 明确排除 `docs/*` |
| `anc.db` rename 一直 EBUSY | `anc-service` 和 `anc-http` **都**持有库连接；停任务不等于杀进程 |
| **`secrets-in-git` 基线突然 FAIL** | 抓到了**我自己**：本脚本里硬编码了完整假 webhook 模式。改成拼接后回 PASS —— 这反而是它"会红"的**最强证据**（不是我注入的，是我真写了） |

共同教训：**写注入脚本前先读检查的实现**。凭"它应该看这个"去猜，一半会猜错，
而猜错的表现是"该项没红"——看起来像 doctor 失灵，实际是注入没打中。

### 收尾核对

跑完 11 组后：`FAIL=0 WARN=1`；`anc-http` Running、`anc-service` Ready；`anc.db` 完好；
SMB 权限回到 `Everyone: Read`；vault 无新增改动；无残留测试文件。

## 16. 补丁启动链路在「彻底重启」后失效（2026-11-02 踩到）

**这是一次真实事故的记录**：为了加一行观测，重启了 WorkBuddy，结果 bot 下线约 15 分钟，
恢复后**补丁没加载**。记下来，因为它暴露的不是"某次操作失误"，是启动链路的根本脆弱。

### 现象

| 启动方式 | 结果 |
|---|---|
| `launch-patched.ps1`（`--inspect-brk` + `inject.cjs` 设 `NODE_OPTIONS`） | 主进程被放行后**立即退出**（exit 0），无进程 |
| 父进程直接设 `NODE_OPTIONS=--require <preload>` 再启动 | preload **能加载**（日志有 `preload active`），但主进程**随后退出** |
| **不带任何补丁**直接启动 | **能起**（6–8 进程） |

关键证据：env 方式下日志出现了 `[pid N] preload active version=5.9.3`——
**说明 preload 代码本身没问题**，是被加载后主进程走不下去。

### 真正的原因：`cowork-svc` 与 `CoworkVMService` 的耦合

WorkBuddy 不是单个 exe：

- `WorkBuddy.exe`：启动器，检测到已有实例就把参数转过去、自己 exit 0；
- `cowork-svc.exe`：真正的后台 daemon，**由 Windows 服务 `CoworkVMService` 拉起**；
- 多个 `WorkBuddy` 子进程：UI 侧（renderer / gpu / utility）。

踩到的两个陷阱：

1. **杀掉所有 `WorkBuddy` 进程会让 `CoworkVMService` 跟着停**——之后 main 起来连不上 daemon，直接 exit 0。
2. **`cowork-svc` 在跑时，新启动器会把工作交给它并退出**。所以"带补丁启动"必须让 daemon 也是新的（才能继承新的 `NODE_OPTIONS`），但 daemon 又由服务拉起——两边互相卡住。

可用的恢复顺序（实测）：

```
1. 杀干净：WorkBuddy + cowork-svc
2. Start-Service CoworkVMService
3. 等 8 秒（让服务把 cowork-svc 拉起来）
4. 启动 WorkBuddy.exe
5. 等 20 秒左右（3 秒时还是 0，21 秒才有 6 个）——不要因为头几秒是 0 就重跑
```

### 逐项实验数据（2026-11-02 23:15-23:24）

| 实验 | preload 加载 | 主进程 | 进程数 |
|---|---|---|---|
| 不带任何参数 | 未加载 | 退出（exit 0） | **6–8，正常** |
| `--inspect-brk=9229`，**不注入** | 未加载 | **活着**，9229 在侦听 | 1（等调试器） |
| `--inspect-brk` + `inject.cjs` 放行 | **无日志**（连加载都没到） | 放行后 **2 秒内消失** | 0 |
| 父进程设 `NODE_OPTIONS=--require` 再启动 | **有日志**（`preload active`） | 加载后退出 | 0 |

三条推论：

1. **`--inspect-brk` 本身没问题**——不注入时主进程能稳定停在等调试器的状态。
2. **`--inspect-brk` + inject 这条路，`NODE_OPTIONS` 根本没传到任何会加载 preload 的进程**
   （preload 日志一条没有，说明连加载都没发生）。
3. **`NODE_OPTIONS` 能传到（env 方式证明了），但 preload 在主进程里加载会让它退出**。
   也就是说：**preload 不能跑在主进程里**，它假设自己运行在某个子进程/注入点。

### 一个无法复现的疑点

22:55 那次日志里确实有 `[pid 14352] INJECTED mode=hash` + `APPLIED mode=hash` + `preload active`，
说明**当时补丁真的注入成功了**。但在同样的操作序列下，之后的所有尝试都没能复现。
没法确认那次是"操作序列的某个细节不同"还是"某个残留进程恰好接住了"。**这一点如实记下，不猜。**

### 为什么以前一直没发现

`patch-state.json` 里 `applied:true`、`patch` 项也 PASS——因为**那些是上一次成功启动的残留**。
只要不彻底重启，进程一直活着，看起来一切正常。**一旦真的重启，补丁就回不来了。**

这正是 R7（真升级回归）要发现的问题，现在提前暴露：**升级后 WorkBuddy 必然重启，补丁大概率起不来**。

### 现在的状态与待办

- bot **在线**（7 进程），但**补丁未加载**——群身份注入缺失，D17 的能力实际不可用；
- `preload.cjs` 已回滚到加观测之前的版本，与仓库一致；
- **待办**：补丁启动机制需要重做。两条候选：
  1. 让 daemon 在服务启动时就能拿到 `NODE_OPTIONS`（改服务配置或包装 cowork-svc 的启动）；
  2. 不用 `NODE_OPTIONS`，改用 WorkBuddy 自己的扩展点（若有）。

> 教训：**改注入代码前，先确认"能不能重启回来"**。这次的观测改动本身无害（preload 能加载），
> 但它诱使重启，而重启链路是坏的。

### 根因与修复（2026-11-02 23:33 确认）

**根因**：`preload.cjs` 里有一段"劫持 `https.request` 拦自动升级检查"的逻辑，**没有任何进程判断**。
被 `NODE_OPTIONS=--require` 加载后，**Electron 主进程**也执行了这段劫持 → 破坏 Electron 自身初始化 → 主进程 exit 0。
这解释了 env 方式下"preload 有日志、主进程随后消失"的怪现象。

**修复**：文件开头加进程守卫——

```js
const __ancIsMainProc = (process.versions.electron && process.type === "browser");
if (__ancIsMainProc) { module.exports = {}; return; }
```

主进程静默返回（不劫持 https），子进程照常注入。

**离线验证**（不碰 WorkBuddy）：

| 模拟进程 | 加载结果 | `https.request` 是否被劫持 |
|---|---|---|
| 主进程（electron + browser） | 不崩 | **false**（被守卫挡住） |
| 渲染进程（electron + renderer） | 不崩 | **true**（正常注入路径） |
| 普通 node（无 electron） | 不崩 | — |

**实测结果**（`NODE_OPTIONS=--require <preload>` 启动）：

```
33s  进程=5  preload=3  INJECTED=1
15:33:54 [pid 8520] INJECTED mode=hash target=...wecomaibot-client.js
15:33:54 [pid 8520] APPLIED mode=hash
```

`patch-state.json` → `{pid:8520, applied:true, mode:hash}`；doctor 的 `patch` / `workbuddy` / `deploy-layout` 三项 PASS。

### 还发现一件以前不知道的事

日志里出现了 `[inject] env set` + `[inject] inspector: "scheduled"`，**不是手跑 launch 产生的**，
而是 **`anc-patch-guard` 计划任务**（每 1 分钟 + 登录 + 开机触发）自动补齐的。

也就是说：补丁起不来时，**不用手跑 `launch-patched.ps1`**，只要 WorkBuddy 在跑，
`patch-guard` 最多 1 分钟内会自己把注入补上。之前排查时我没等够时间，反而反复杀掉重来。

### 正确的启动与恢复流程（替换前面那段）

```
1. 杀干净 WorkBuddy（不需要动 Claude 的 CoworkVMService，那是另一个产品）
2. 启动 WorkBuddy.exe（可以不设 NODE_OPTIONS，也可以设——守卫保证主进程不会崩）
3. 等 30 秒到 1 分钟：patch-guard 会自动注入，日志出现 INJECTED + APPLIED
4. 确认 patch-state.json 的 applied:true、doctor 的 patch PASS
```

> 前一次记录里"杀 WorkBuddy 会让 CoworkVMService 跟着停"是**误判**——那是 Claude Desktop 的服务
> （`WindowsApps\Claude_*\app\resources\cowork-svc.exe`），与 WorkBuddy 无关，是我自己执行过 `Stop-Service`。

## 17. O1：出站旁白过滤挂在错的类上，而且流式架构下代码层做不到（2026-11-03）

### 问题

11-02 19:13 那次回复带了明显旁白（"让我先查一下"），但过滤代码在、部署了、`patch` 项 PASS。
所以要么没跑到、要么跑了没匹配上。

### 怎么查的

给 `sendReply` 的包装加了观测（只记行数不记内容）：`__ancStat("reply", 原文行数, 过滤后行数, 丢几行)`。
部署、重启（`mode=hash` / `APPLIED` / 无 `patch error`），然后请维护者在群里问一句。

**bot 回了两行**：

```
Let me resolve the group binding and list today's open tasks.   ← 该被过滤的
今天没有未完成任务。                                              ← 正常回答
```

**观测日志根本没生成。**

### 答案分两层

**第一层：挂错了类。**

从厂商代码（`app.asar` 里 `wecomaibot-client.js`）看：

| 方法 | 属于哪个类 | 上下文 |
|---|---|---|
| `sendReply` | **`QQBotClient`** | `[QQBotClient] sendReply: no userId or groupId provided` |
| `sendStreamChunk` | **`WecomAiBotClient`** | `[WecomAiBotClient] Failed to send stream chunk` |

`preload.cjs` 的注释写着"最终回复走 `sendReply`（内部按字节分块逐条 `sendMessage`）"——**这个假设是错的**。
企微的 `sendReply` 确实存在，但**实际调用的是 `sendStreamChunk`**：

```js
async sendStreamChunk(e, t, n) {
  let r = this.frameCache.get(e);
  if (r) return await this.wsClient.replyStream(r, { content: t }, 'text', n), true
}
```

它直接调 `wsClient.replyStream`，**不经过 `sendReply`**。所以包装 `sendReply` 等于装在一条没人走的路口。

**第二层：就算装对地方，流式也做不了。**

`sendStreamChunk` 的 `t` 是**一个 chunk**，可能只有几个字。判断"这句是不是旁白"需要整句，而整句从来没有在一个地方出现过——它在发出之前就被切碎了。

`preload.cjs` 的注释其实已经想到这一点（"`sendStreamChunk` 不动——流式块可能只有几个字，判断不了整句，硬过滤会误杀"），但它把结论下成了"所以过滤放 `sendReply`"，而真相是**企微只有流式**。

### 结论：代码层过滤在这条架构下不可行

三个方案，只有一个成立：

| 方案 | 可行性 | 原因 |
|---|---|---|
| 挂 `sendReply` | ✗ | 企微不用它（已实测） |
| 挂 `sendStreamChunk` | ✗ | 每块只有几个字，判断不了整句；而且发出去了无法撤回 |
| **在生成前约束（persona）** | **✓** | 让模型一开始就不说旁白。**维护者 11-03 加进 persona 的那条"回复必须落在结果上"正是干这个** |

所以出站过滤的正确位置不是代码，是 persona。代码层的 `__ancFilterNarration` 保留着无害（它挂在一条不走的路上，等于空转），但**不能指望它**。

### 词表还有第二个问题（次要）

即使挂对地方，`NARRATION_RE` 是**236 字符全中文**。而这次模型的旁白是**英文**（"Let me resolve the group binding…"）。

所以就算过滤跑到了，也匹配不上。补词表要同时覆盖中英两种——但既然代码层不可行，这条优先级降到最低。

### 留下的观测

`__ancStat` 保留在 `preload.cjs` 里（只记数字不记内容）。它的价值变成了**证据**：以后要确认"某条出站路径有没有被调用"，看 `%USERPROFILE%\anc\narration-filter.log` 有没有对应的行即可。

`sendReply` 那条路现在是空的——这本身就是"企微不走它"的证据。

## 18. O2：persona 从哪读、什么时候读（2026-11-04 结案）

### 结论

| 问题 | 答案 | 证据 |
|---|---|---|
| bot 从哪个文件读 persona | `%USERPROFILE%\WorkBuddy\Claw\CODEBUDDY.md` | WorkBuddy 主线程日志 `Conversation lookup` 里的 `cwd` |
| 什么时候读 | **每个会话首次注入时读一次**，不是每轮 | 改文件后同一会话里问，bot 看不到新内容 |
| 改完怎么生效 | **新会话**即可，不用重启 WorkBuddy | `existingAgentSessionId` 有值 = 复用会话 |

### 怎么测的

**第一轮（探针）**

在 `Claw\CODEBUDDY.md` 末尾加一段，只答一个从没出现过的串：

```
如果用户问「实验编号」，只回答：O2-PROBE-1103-A
```

维护者在群里问 → bot 答对。**说明文件确实被读了。**

**第二轮（同会话改值）**

把那段改成 `ZX-10` + 新增 `校验码 = 4K7`，再问「校验码」。

bot 答：**"没有「校验码」这回事。你要的是实验编号的话，它是 `O2-PROBE-1103-A`"**

——它看不到新加的内容，**但记得上一轮的答案**（对话历史）。所以不是"读了一次就缓存"，
而是**这个会话的 persona 快照停留在会话开始那一刻**。

**第三轮（查 WorkBuddy 自己的日志，拿到硬证据）**

用测试入口模拟一条入站消息，WorkBuddy 日志出现：

```
[CHANNEL_TRACE] [ClawService] Conversation lookup {
  "channelId":"wecomaibot",
  "senderId":"test-emit",
  "conversationKey":"claw:user:2001fe8a-...",
  "found":true,
  "cwd":"C:\\Users\\Administrator\\WorkBuddy\\Claw",
  "existingAgentSessionId":"9..."
}
```

`cwd` 就在这里，不用再猜。`existingAgentSessionId` 有值 → 复用了已有会话 → 不会重读 persona。

### 对后续的意义

**夜间 persona 轮换（PLAN 阶段 L4）不能只改文件**。

如果想在夜里把公司 bot 切成 devbot，只复制 `CODEBUDDY.md` 是不够的——**必须让会话重建**（新会话或重启）。这条约束写进 L4 的实现里。

### 第四轮：用测试入口直接问，它在 14 个字里给了答案

修好时间同步后重看 `patch-out.log`，第 3 行是：

```
2026-11-03T18:23:06.100Z chat=wrkcDlGwAAca len=14
正文: O2-PHASE2-7731
```

`18:23:06Z` = 本地 **02:23:06**，正是第一次用测试入口 POST「第二阶段的码是多少」那次。

**bot 答出了 `O2-PHASE2-7731`** —— 那是我两分钟前才写进 `Claw\CODEBUDDY.md` 的值。

这一条同时钉死了两件事：

1. **persona 确实从 `Claw\CODEBUDDY.md` 读**（答出了里面刚写的值，不是历史记忆）
2. **新会话会读最新版本**（旧的群会话读不到 `ZX-10`/`4K7`，是因为它的快照更早）

比前一轮的推理硬得多——前一轮只能证明"记得旧值"，这一轮证明"读到了新值"。

### 一个附带发现：这台机器的时间从没同步过

`W32Time` 服务是 **Stopped**，`w32tm /query /status` 报 `0x80070426`。

这会影响 `patch-guard` 的判断——它用 `patch-state.at >= 主进程创建时间 - 15 秒` 来区分"补丁是这次的还是上次残留的"。时钟漂到分钟级就会误判。

已修：服务设 Automatic 并启动，NTP 源 `ntp.aliyun.com,time.windows.com`，
实测与外部时间源偏差 **1.2 秒**。写进 `OPS.md`。

## 19. 主机时间从没同步过——影响面盘点（2026-11-04）

### 事情

维护者发现本机时间不对，手动同步后提醒："之前的工作都是在时间错误的情况下做的，怕给项目带来错误。"

查下来：`W32Time` 服务状态 **Stopped**、启动类型 **Manual**，`w32tm /query /status` 直接报 `0x80070426`（服务未启动）。**这台机器装好起时间就没同步过。**

已修（`OPS.md`「主机时间必须自动同步」）。这一节回答的是另一个问题：**之前那些结论还可信吗。**

### 先量化：错得有多乱

能查的都查了：

| 检查项 | 结果 |
|---|---|
| `workbuddy-patch.log` 1068 条的相邻时间差 | **倒退 0 次**；7 次 >2 小时的跳跃，逐一看都是夜间无活动的空档（01:00–08:00 那种） |
| 状态文件互相对照 | `patch-state.at`（UTC）与 `selfheal.state.json`（本地 +08:00）**换算后一致** |
| 日志内部一致性 | 同一秒内的多条记录顺序正常，没有"后发生的事时间更早" |

**结论：不是那种会让逻辑错乱的漂移。** 没有倒退、没有突然跳跃、各来源之间自洽。

但**"一直偏一个固定量"从这个证据里看不出来**——机器没开过时间服务，也就没有校准记录可对照。所以不能断言"完全没偏"，只能说"没有证据显示它偏到会破坏判断的程度"。

### 按依赖程度分三类

**第一类：靠相对时间，完全不受影响**

| 位置 | 怎么算的 |
|---|---|
| 冷启动耗时（46/60/29 秒） | `(Get-Date) - $t0`，两次采样相减，绝对时间偏了也抵消 |
| 各处"等 30 秒""轮询 40 次×3 秒" | 同上，都是间隔 |
| 补丁注入耗时 | 同上 |

**这一类结论可以直接用**，包括 `VERIFY §17` 的冷启动数据和 `WORKBUDDY-PATCH §5.1` 的自愈链路时序。

**第二类：用绝对时间，但判断是"窗口比对"，靠得住**

| 位置 | 判断方式 | 时间错会怎样 |
|---|---|---|
| `patch-guard` 判补丁是否过期 | `patch-state.at >= 主进程创建时间 - 15 秒` | 两边都是同一台机器的时钟，**同时偏就互相抵消**。只有"打补丁和进程启动之间时钟跳了一下"才会错，而 W32Time 停着反而不会跳 |
| `selfheal` 冷却 10 分钟 | 上次尝试时间 vs 现在 | 可能提前或延后触发，**最多多启动或少启动一次**，不会让补丁失效 |
| `patch-guard` 冷却 3 分钟 / `blocked` 60 分钟 | 同上 | 同上 |
| canary 避让 2 分钟 | 同上 | 同上 |

**这一类的影响是"效率"，不是"正确性"。** 补丁该打还是打了（`VERIFY §17` 三次冷启动都 `APPLIED`，`§18` 的 anchor 降级也正常发出）。

**第三类：真正受影响的——提醒与逾期**

| 位置 | 为什么受影响 |
|---|---|
| `reminders.due_at`（56 行） | 到点触发靠绝对时间。时间偏 5 分钟，提醒就早/晚 5 分钟 |
| `tasks.due_at`（34 行）、逾期判断 | 同上 |
| `outbox.next_attempt_at`、`expires_at`（13 行） | 重试节奏会偏 |

**但这一类现在的影响接近于零**，因为：

- **提醒的端到端验证还没做**（`PLAN` 阶段 S 的第 3 项 gate 就是"一个真实逾期任务被正常提醒"，至今挂着）
- 库里那 56 条 `reminders` 和 34 条 `tasks` 是**开发和联调时造的**，不是真实业务
- `dayend` 0 行、`devbot_runs` 0 行——这两个功能还没真正跑过

**所以：提醒/逾期这条链上的历史数据时间戳应当视为"不可信"**，将来验证提醒时要用**新造的数据**，别拿旧行做依据。

### 第四类：只是记录，不影响判断

`eval_runs.created_at`（99 行）、`task_events.created_at`（150 行）、`a2a_messages.created_at`（11 行）、`patch_drafts`、`issues`、`submissions`——这些是审计/追溯用的。时间可能偏，但**没有人基于它们做判断**。

唯一代价：事后按时间排序或对时间线时会错位。这次排障我自己就被坑了两次——把 UTC 当本地读，得出"canary 没更新"的错误结论（见下面"教训"）。

### 要不要回头修历史数据

**不修**。理由：

1. 修不了——不知道原来偏了多少，没有基准
2. 没必要——受影响最大的第三类（提醒）本来就没真正用起来
3. 有代价——改时间戳会破坏审计链，比留着一个"可能偏过"的记录更糟

**做法**：在文档里标清楚"2026-11-04 03:00 之前的绝对时间戳可能不准"，将来验证提醒时用新数据。

### 教训（给以后排障的人）

**核对时间戳前，先确认机器时间准不准。**

`new Date().toISOString()` 写进 `patch-canary.json` / `patch-state.json` / 各种日志的是**系统时间**。系统时间错了，整条时间轴都是错的，照着它推理就会得出错误结论。

这次的具体表现：`canary` 写着 `2026-11-03T08:05:39.307Z`，我没做时区换算就当成"刚更新"，据此判断 webhook 消息能到达 bot——实际那是北京时间 16:05 的旧值，跟当时的测试毫无关系。后来又反过来误判一次。**两次都是没核对就下结论。**

排查顺序应当是：
1. `Get-Date` + `w32tm /query /status` 确认时钟和同步状态
2. 再做任何时间戳比对

## 20. gate S 第 3 项：逾期任务提醒（2026-11-04，**造的数据**）

### 先说清楚：这一项不是"自然发生"的

`PLAN` 原本写的是"等一个真实逾期任务被正常提醒，不专门造"。

但库里 34 个任务全是 `cancelled` 或 `done`，56 条提醒全是 `cancelled` 或 `sent`——**没有可等的**。所以改用 `test-emit` 之外的另一条路：**走 CLI 造一条 `due_at` 已过的任务**，让它在真实链路上跑完整流程。

**这是造的，不是自然发生的。** 记在这里，不装。

### 链路

```
cli task add --due-local <过去时间> --chat-id <完整 chatId> --requester-userid <员工>
  → tasks 表新增一行 (status=open)
  → scheduleReminder() 建 pending 提醒
  → anc-service 每分钟 tick
      → dueReminders() 选出到点的
      → isWorkTime() 判断在不在工作时段
      → enqueue() 写 outbox
      → defaultSender() 调 webhook 发出
  → task_events 记 reminder_sent，并排下一次 (+repeat_minutes)
```

### 第一次尝试踩了两个坑

**坑一：凌晨造的任务被顺延（这不是 bug）**

02:22 造了一条 1 小时前到期的任务，tick 2 秒后就把它挪走了：

```
19:22:59  created              {"title":"验收测试：逾期提醒是否真的发出来"}
19:22:59  reminder_scheduled   {"due_at":"2026-11-03T18:22:00.000Z","repeat":15}
19:23:01  reminder_deferred    {"to":"2026-11-04T00:30:00.000Z"}   ← 顺延到明天 08:30
```

`loop.ts` 里的逻辑：

```js
if (!isWorkTime(nowDate, rules)) {
  const next = nextWorkStart(nowDate, rules);
  // 顺延到下一个工作时段起点，不发
}
```

现在 03:25，工作时段是 08:30–18:00，所以**正确顺延**。这是 `FORK §5.7`「夜里不推送」的设计，不是故障。全库历史上 `reminder_deferred` 出现过 5 次，说明这机制一直在工作。

**坑二：我从截断的日志里抄了 chatId，导致发送失败**

```
outbox #66 [failed]  NO_WEBHOOK_FOR_CHAT: 该群未绑定或未登记 webhook_file
                     payload: {"text":"到点提醒：#60 …","mentions":[]}
```

对照绑定表：

```
我用的      wrkcDlGwAAcaQxHs                      ← 20 字符，从日志的 chat=wrkcDlGwAAca 抄的
真实的      wrkcDlGwAAcaQxHsYyEztVz2Jby1YbTw      ← 32 字符
```

`resolve()` 拿这个短 id 查不到绑定 → `mentions: []` → 发送时找不到 webhook → FAIL。

**这不是系统 bug，是我抄错了。** 日志里 `chat=` 后面那截是被截断显示用的。

**教训**：`chatId` 从 `chat_bindings` 表取完整值，绝不从日志或报错的截断副本里抄。

### 第二次：通过

用完整 chatId 重造（task 61），并把工作时段临时改成 `00:00–23:59`（否则还是会顺延到 08:30，今晚验不了）：

```
19:29:04  created             {"title":"验收测试：逾期提醒（用完整 chatId 重造）"}
19:29:04  reminder_scheduled  {"due_at":"2026-11-03T19:24:00.000Z","repeat":15}
19:29:05  reminder_sent       {"due_at":"2026-11-03T19:24:00.000Z"}
19:29:05  reminder_scheduled  {"due_at":"2026-11-03T19:39:00.000Z","repeat":15}   ← 下一次 +15 分钟
```

```
tick: {"ok":true,"enqueued":1,"sent":1,"failed":0,"skipped":0,"requeued":0}

outbox #67 [sent] attempts=1 err=-
  {"text":"到点提醒：#61 验收测试：逾期提醒（用完整 chatId 重造）\n回复「@公司bot #61 完成」停止提醒","mentions":[…]}
```

**整条链路通了**：到点 → 选出 → 判断工作时段 → 入 outbox → webhook 发出 → 记 `reminder_sent` → 排下一次。

### 收尾

| 动作 | 结果 |
|---|---|
| 工作时段改回 | `work_start=08:30` `work_end=18:00` ✓ |
| task 60 / 61 | `cancelled` |
| 它们的 pending 提醒 | `cancelled` |
| outbox #66（chatId 抄错那条） | 保留 `failed` 但清掉 `next_attempt_at`，不再重试 |
| 剩余 | **0 open 任务、0 pending 提醒** |

### 顺带确认的两件事

**1. `task cancel` 要求"执行人或交办人"**

用 `--requester-userid` 建的任务，`cancel` 时仍报「只有执行人或交办人能操作」——因为 `requester`（人名）和 `assignee` 都是 null，只有 `requester_userid`。这条限制本身是合理的（防止乱取消别人的任务），但**清理自己造的测试数据时会挡路**。这次是直接改库清的，注明在此。

**2. `NO_WEBHOOK_FOR_CHAT` 是永久错误，不该重试**

现在它被记进 `last_error` 后仍留在 outbox 里，靠 `next_attempt_at` 控制重试。清理时我把 `next_attempt_at` 置空才停下。永久性错误（找不到群/webhook）和临时性错误（网络抖动）应该有不同处理，但那是优化项，不在 gate S 范围。

## 21. L1：submission 收集端（2026-11-04 端到端通过）

### 做了什么

三件东西，对应 PLAN §5.2 的 L1：

| 组件 | 位置 |
|---|---|
| 表 | `db.ts` 的 `SCHEMA` 里加 `submissions`（11 个业务列 + `issue_id` 给 L2 预留） |
| 逻辑 | `src/service/submissions.ts` —— `add` / `list` / `setStatus` / `linkIssue` |
| 命令 | `cli submission add|list|set-status` |
| 技能 | `light/skills/anc-feedback/SKILL.md`（收集端，bot 侧） |
| 部署 | **新建 `scripts/deploy-skills.ps1`** —— 之前技能是手工复制的，违反「只走 git → 部署」 |

### 端到端怎么验的

用 `OPS.md` 的 test-emit 入口模拟员工在群里报问题：

```
POST 127.0.0.1:17999/emit
{ chatId: <完整 chatId>, user: <员工 userid>, msgId: <32位hex>,
  content: "刚才查任务那条回复不对——我说的是只看今天到期的，它把上周逾期的也列出来了。应该按 due_at 过滤。" }
```

结果：

```
submissions 2 → 3

id          3
chat_id     wrkcDlGwAAcaQxHsYyEztVz2Jby1YbTw
employee    本人                                     ← 从 chat_bindings 推出
userid      wokcDlGwAAXCl5GBcPfwP7EGd2-YsUTw
text        刚才查任务那条回复不对——…应该按 due_at 过滤。   ← 一字不改
status      new
issue_id    (null)                                   ← 等 L2

bot 回执    在。\n已记录 #3，明早 review 会看到。        ← SKILL.md 里定死的形状
```

**这就是 gate L 第一条要的东西**：群里引用后说问题 → 表里有记录，且是原话。

### 踩的四个坑

**坑一：表结构漂移，`CREATE TABLE IF NOT EXISTS` 是空操作**

库里已经有一张 `submissions`（2026-11-02 留下的 2 行测试数据），列名是 `submitter_userid`。我新写的 `CREATE TABLE IF NOT EXISTS submissions (... userid ...)` 对已存在的表**什么都不做**，于是：

```
ERROR  no such column: userid
```

**修法**：走 `migrate()` 加列（`addCol('submissions','userid','TEXT')` 等三列）。

**教训**：加表不能只改 `SCHEMA`——**表已存在时 `IF NOT EXISTS` 会静默跳过**，新列必须同时进 `migrate()`。

**坑二：技能落盘目录该用 `name:` 不是目录名**

仓库目录叫 `anc-ingest-company`，但 SKILL.md 里写 `name: anc-ingest`，persona 引用的也是 `anc-ingest`。第一版 `deploy-skills.ps1` 用目录名落盘，造出了 `anc-ingest-company` 目录 → **bot 侧会出现两个同名技能**。

**修法**：解析 SKILL.md 的 `name:` 字段作为落盘目录名，并且检测「两个目录声称同一个名字」时直接报错退出。

**坑三：PowerShell 的 keep-alive 复用被服务端关掉的连接**

`Invoke-RestMethod` 连续调用 test-emit 时，第二次报「基础连接已经关闭: 服务器关闭了本应保持活动状态的连接」。Node 的 `http.createServer` 有 `keepAliveTimeout`，服务端先关，客户端还拿着旧连接。

**修法**：用 node 发请求，`agent: false` 不复用。**这不是服务的问题。**

**坑四：bot 处理要两分钟，不是两秒**

注入后 `canary` 立刻更新（消息到了），但 `submissions` 要 **2 分钟**才出现记录。中间过程在 `daemon.log` 里能看到：

```
19:39:37  [SubscriptionGate] check conversation=... type=skill name=anc-feedback
19:39:37  [SubscriptionGate] allow reason=skill-not-in-market-pool
19:39:56  submissions 多了一条
19:40:05  [patch-out] 在。\n已记录 #3，明早 review 会看到。
```

**排查时别只看 10–20 秒就下结论**。之前我等 120 秒以为失败了，其实是差几十秒。

### 顺带查清的两件事

**1. WorkBuddy 的日志文件已经换名字了**

以前是 `workbuddyMainThread__*.log`，现在是 `main.log` / `daemon.log` / `renderer.log`。`CHANNEL_TRACE` 这类对话追踪现在在 **`daemon.log`** 里。

**2. `SubscriptionGate` 会检查技能**

```
[SubscriptionGate] check ... type=skill name=anc-feedback
[SubscriptionGate] allow reason=skill-not-in-market-pool
```

自建技能不在市场池里，但**被 allow 了**——说明「自己装的技能」是允许的。这条值得记住：将来如果技能不生效，先看这里有没有 `allow`。

### 表结构（最终）

```
id                INTEGER  PK
dedupe_key        TEXT     UNIQUE     sha256(chat_id + NUL + text) 前 32 位
chat_id           TEXT
employee          TEXT                从 chat_bindings 推
userid            TEXT                迁移加了（旧表叫 submitter_userid）
submitter_userid  TEXT                旧列，保留兼容
text              TEXT NOT NULL       原话，不总结不改写
file_path         TEXT
file_hash         TEXT
status            TEXT DEFAULT 'new'  new | triaged | dropped
issue_id          INTEGER             L2 回填
created_at        TEXT
```

### 下一步（L2）

`cli issue draft`：submission → 结构化 issue `{skill, section, symptom, expected, verify}`。
需要一张「关键词 → 技能 → 段落」的规则表。
