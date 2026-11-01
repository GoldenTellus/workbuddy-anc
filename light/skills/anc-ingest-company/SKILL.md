---

> 公司 bot 的入库技能（**线上在用的就是这份**，安装后目录名是 `anc-ingest`）。上游原版 `light/skills/anc-ingest/SKILL.md` 已删除，需要时 `git show 90e4fb2:light/skills/anc-ingest/SKILL.md`；它在本库的改写来源是 `reference/upstream/skills/anc-onboard.vault-skills.anc-ingest.md`。
name: anc-ingest
description: 把群里的资料入库到公司知识库。用户说「入库」「把这个存进公司库」「归档」「ingest」时使用。触发词：入库、归档、存进公司库、这份文件入库、ingest、archive。
---

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

- **目录按 vault 根路由选**：公司概况/名单/术语 → `company/`；协作模板 → `collab/`；技能 → `skills/<名字>/`。拿不准就先问用户，不要猜。
- **覆盖已有文件**：先用 `git -C D:\anc\vault-shared hash-object <目标路径>` 取当前 blob hash，填进 `base_hash`；新文件不要填 `base_hash`。
- 原件已存在会被拒；这种情况告诉用户「原件已经在库里」，不要改名重投。

## 3. 跑入库进程

```powershell
node E:\workbuddy-anc\src\ingest\cli.ts apply --batch D:\anc\inbox\pending\<id> --shared D:\anc\vault-shared --inbox D:\anc\inbox --json
```

- 成功：批次会自动移到 `D:\anc\inbox\done\`；把 `added` / `modified` / `original` 转成中文摘要；
- 失败：批次自动移到 `D:\anc\inbox\failed\` 并附 `reason.txt`；把错误码与原因**原样转告**，不要自行删改重试。

## 4. 回执

在群里回一条短摘要：文件名、落到哪个目录、新增还是更新、原件是否已存。不贴 JSON，不贴内部绝对路径。

## 边界

- 只写 `D:\anc\inbox\` 与调用上面的 CLI；不手改 `D:\anc\vault-shared`；
- 不覆盖原件、不改附件；
- 不确定归哪个目录、或内容里含个人敏感信息（应进内部区）时，先问管理员。
