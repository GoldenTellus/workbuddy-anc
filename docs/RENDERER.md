# 渲染器

对应 [FORK-DIRECTION.md](./FORK-DIRECTION.md) §5.9 与 [PLAN.md](./PLAN.md) M3。**渲染是唯一上线路径**（D15）：persona 和接入包只能由渲染器生成，手改线上文件视为事故。

## 输入（org 数据）

```
org/
├─ company.md            # 公司级字段
├─ roles/<role>.md       # 角色（可选，预留）
└─ members/<id>.md       # 每个员工一份
```

`company.md`（frontmatter）：

```yaml
---
name: 示例公司
company_bot_name: 公司bot
vault_shared: '\\主机\anc-vault-shared'
vault_internal: 'D:\anc\vault-internal'
local_workdir: 'C:\Users\<用户>\WorkBuddy\Claw'
---
```

`members/<id>.md`：

```yaml
---
id: zhangsan
name: 张三
role: manager
userid: <userid>
chat_id: <chatid>
webhook_file: wecom-webhook.txt
seat: Enterprise
bot: 已接入
---
```

- 仓库里只放 `org.example/`，**真实 org 数据不进仓库**（人名、chatid、userid 都算敏感）；
- 真实数据放主机（如 `D:\anc\org\`），或放 vault 内部区，由运维指定 `--org` 路径。

## 产物

```
<out>/company-bot/CODEBUDDY.md      # 公司 bot persona
<out>/members/<id>/CODEBUDDY.md     # 个人 bot persona（接入包的一半）
<out>/groups.json                   # 群 → 员工映射 + userid + webhook 引用名
```

- 每个产物顶部带 `<!-- anc:input-sha256:<hash> -->`：hash 覆盖 company.md + roles/* + members/*；
- **手改检测**：`<out>/manifest.json` 记下每个产物的内容 hash。下次渲染时若输入没变、文件 hash 变了，就报 `WARN 产物被手改过` 并以退出码 1 结束（原文件已备份）；
- **长度闸门**：>6500 字节警告，>7500 字节报错并列出各段长度（T19）；
- **落盘**：先备份 `.bak-<时间>` → 临时文件 → 读回对拍 sha256 → 重命名（被占用时重试 5 次）。

## 用法

```powershell
node src\render\cli.ts render --org org.example --out %TEMP%\anc-render
node src\render\cli.ts render --org D:\anc\org --out D:\anc\build --json
```

## 真相归属（PLAN M3 第 2 项）

**`members/` 是成员与群对应的唯一真相**；本地小服务的 `chat_bindings` 是投影，由 `groups.json` 同步：

```powershell
node src\service\cli.ts --db C:\ProgramData\anc\data\anc.db bind import --from <out>\groups.json
```

- 运行期不再手改绑定表；要改群/人，改 org 数据 → 重渲染 → `bind import`；
- `bind import` 幂等：同 chatid 更新为最新值，没有 chatid 的成员跳过。

## 已实现 / 未实现

- 已实现：org 解析与校验、公司/个人 persona 渲染、groups.json、指纹、长度闸门、原子写与备份、6 条测试；
- 未实现：技能名片、接入脚本体、部署到 `%USERPROFILE%\WorkBuddy\Claw` 的 `--adopt` 闸门、手改检测（把产物 hash 记到清单再比对）、rollback。
