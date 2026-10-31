---
name: anc-vault-read
description: 从公司知识库（D:\anc\vault-shared）查资料并回答。用户问公司情况、制度、术语、已有资料里的内容，或说「库里有没有」「查一下」时使用。触发词：查一下、库里有吗、公司资料、知识库、按库答、vault。
---

# anc-vault-read（公司 bot 侧）

只读。**先查库，再回答；查不到就直说「尚未入库」，不要用常识补。**

## 库在哪

`D:\anc\vault-shared`（共享区，只读）。目录路由：

- `company/`：简介、名单、术语、问题模型、架构说明等
- `collab/`：协作模板、设计讨论、决策记录
- `skills/<名字>/SKILL.md`：技能正文
- `_originals/`：原件（PDF/图片），Markdown 的 `source_file` 指回

## 怎么查

1. 先按关键词找文件：

```powershell
Get-ChildItem D:\anc\vault-shared -Recurse -File -Include *.md | Select-String -Pattern "<关键词>" -List | Select-Object -First 10 Path
```

2. 找到后读全文（大文件先看 frontmatter 和标题）：

```powershell
Get-Content "D:\anc\vault-shared\<相对路径>" -TotalCount 80
```

3. 回答里带上出处（相对路径），例如「见 company/ANC架构详解.md」。

## 查不到时

- 说「库里还没有这方面的资料（尚未入库）」；
- 不要用训练知识冒充公司事实；
- 可以建议：「把资料发我并说入库，我存进去后再回答」。

## 边界

- 只读 `D:\anc\vault-shared`；不读 `D:\anc\vault-internal`（内部区）；
- 不修改任何文件；
- 回答不超过用户的提问范围；原文没有的推断要标明「这是推断」。
