---
name: anc-ingest
description: 把群里的资料入库到公司知识库。用户说「入库」「把这个存进公司库」「归档」「ingest」时使用。触发词：入库、归档、存进公司库、这份文件入库、ingest、archive。
---

> 公司 bot 的入库技能（**线上在用的就是这份**，安装后目录名是 `anc-ingest`）。上游原版 `light/skills/anc-ingest/SKILL.md` 已删除，需要时 `git show 90e4fb2:light/skills/anc-ingest/SKILL.md`；它在本库的改写来源是 `reference/upstream/skills/anc-onboard.vault-skills.anc-ingest.md`。


# anc-ingest（公司 bot 侧）

入库分两步：**你负责把资料整理成结构化 markdown 并投进批次目录；入库进程负责确定性校验与写入**。你**不直接写 vault**。

## 1. 找到附件

企业微信附件落在 `%TEMP%\workbuddy-wecom-media\`，消息里会给出绝对路径。找不到就如实说「没找到附件」，不要猜路径、不要去翻别的目录。

## 2. 建批次并整理文档

```powershell
$id = "batch-" + (Get-Date -Format "yyyyMMdd-HHmmss")
New-Item -ItemType Directory "D:\anc\inbox\pending\$id" -Force
```

1. 把附件**复制**进批次目录（原件，不修改）；
   - 原件放在**批次根目录**（例如 `对话.txt`），不要放进批次里的 `_originals/` 子目录；
   - `meta.json` 里 `src` 写批次根目录的文件名，`target` 才写 `_originals/<文件名>`；
2. 写一个 markdown（正文）：

```markdown
---
title: <标题>
source_file: _originals/<附件文件名>
updated_at: <YYYY-MM-DD>
---

<整理后的正文；只写资料里有的，不编>
```

3. 写 `meta.json`：

```json
{
  "batch_id": "<批次目录名>",
  "chat_id": "<消息前缀里的 chatid>",
  "from_userid": "<消息前缀里的 from>",
  "received_at": "<ISO 时间>",
  "files": [
    { "src": "<文档>.md", "target": "<按根路由选目录>/<标题>.md", "kind": "markdown" },
    { "src": "<附件文件名>", "target": "_originals/<附件文件名>", "kind": "original" }
  ]
}
```

- **`meta.json` 必须逐字按上面的模板写**：`files` 数组不能省、`src` 与 `target` 不能缺。缺字段的批次会被直接移进 `failed`，整批作废（这不是"格式小问题"，是批次失败）。
- **目录按 vault 根路由选**：公司概况/名单/术语 → `company/`；协作模板 → `collab/`；技能 → `skills/<名字>/`。拿不准就先问用户，不要猜。
- **覆盖已有文件**：先用 `git -C D:\anc\vault-shared hash-object <目标路径>` 取当前 blob hash，填进 `base_hash`；新文件不要填 `base_hash`。
- 原件已存在会被拒；这种情况告诉用户「原件已经在库里」，不要改名重投。

## 3. 跑入库进程

```powershell
$tk = (Get-Content C:\ProgramData\anc\secrets\service-token.txt -Raw).Trim()
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:17891/__anc_ingest -Headers @{ Authorization = "Bearer $tk" } -ContentType 'application/json' -Body (@{ batch = 'C:\ProgramData\anc\inbox\pending\<id>' } | ConvertTo-Json -Compress)
```

- 成功：批次会自动移到 `D:\anc\inbox\done\`；把 `added` / `modified` / `original` 转成中文摘要；
- 失败：批次自动移到 `D:\anc\inbox\failed\` 并附 `reason.txt`；把错误码与原因**原样转告**。
- **`failed` 里的批次一个字节都不要改**：不要补 frontmatter、不要改 `meta.json`、不要重跑它。那批已经作废，正确的做法是**重新建一个批次**从头来。改 failed 批次等于绕过校验，是事故。

## 执行方式（硬约束，违反即事故）

**只准通过本地服务入库**（D24）：vault 对 bot 是只读的，写操作只能由服务身份完成。

> 2026-11-02 实测教训（务必照做）：
> - **不要用 `node ... cli.ts ingest apply`**——那是服务内部的入口，bot 直接调会因 vault 只读而失败；
>   必须发 HTTP 请求给 `/__anc_ingest`，由服务身份去写。
> - **不要 `git commit` / `git add`**。vault 的 `.git` 对 bot 也是只读的，而且提交是**管理员复核后**的步骤，
>   不是入库的一部分。撞到 `Permission denied` 就停手，不要反复重试、也不要提议"放开权限"。
> - **失败就是失败**：HTTP 返回 `ok:false` 时，把 `error` 原样转告用户，不要说"已入库"。
>   判据只有一条——响应里 `ok` 为 `true` 且 `added` 列出了文件。
你把批次写进 `C:\ProgramData\anc\inbox\pending\<id>`，再 POST 给 `/__anc_ingest`，由它去写 vault。

**执行命令**：

```
$tk = (Get-Content C:\ProgramData\anc\secrets\service-token.txt -Raw).Trim()
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:17891/__anc_ingest -Headers @{ Authorization = "Bearer $tk" } -ContentType 'application/json' -Body (@{ batch = '<批次目录>' } | ConvertTo-Json -Compress)
```

- **不许自己把文件复制进 `D:\anc\vault-shared\` 的任何子目录**（它对你是只读的，强写会被拒）（`collab/`、`company/`、`skills/`、`_originals/`…）。你有文件系统权限不等于可以绕过入库进程——路径校验、原件去重、入库锁、事件记录全在 CLI 里；
- **批次进 `failed` 就是失败**：重新建一个新批次从头来。不许改 `failed` 里的任何文件（补 frontmatter、改 meta.json 都算事故）；
- **只有 CLI 返回 `"ok": true`** 才能说「入库成功」；返回非 0 或 `ok:false` 一律按失败回复，并原样转告错误码。

## 回复模板（硬约束，违反即事故）

整条回复**只能**是这一句，说完就停：

```
已入库：<路径>（原件 <文件名>，<字数>）

入库失败时：`入库失败：<服务返回的 error 原文>`（不要解释成"稍后重试"之类，也不要说成功）
```

- **不许描述你做了什么**：建批次、拷原件、写 meta、执行入库——过程话一句都不发；
- **不许列举章节、主题、决策点、摘要、要点**；「提炼 / 结构化 / 整理成 / 超集 / N 节」这类词一律不出现（FORK D19：只报路径与标题）；
- **不许自己定目录**：拿不准就先问一句，别先做了再说「如果你觉得该单独放…说一声」；
- 失败时只回 `入库失败：<错误码> <原因>`，原样转告。

反例（下面这些都禁止）：

- 「我先看一下之前入库批次的格式约定」「我找一下 meta.json」「格式清楚了」「批次就绪」「现在写整理文档」「文件就绪，执行入库」——工具旁白；
- 「提炼成 15 节锁定决策：项目定位、市场与首版范围…」——内容复述。

## 4. 回执

在群里回一条短摘要：文件名、落到哪个目录、新增还是更新、原件是否已存。不贴 JSON，不贴内部绝对路径。

## 边界

- 只写 `D:\anc\inbox\` 与调用上面的 CLI；不手改 `D:\anc\vault-shared`；
- 不覆盖原件、不改附件；
- 不确定归哪个目录、或内容里含个人敏感信息（应进内部区）时，先问管理员。
