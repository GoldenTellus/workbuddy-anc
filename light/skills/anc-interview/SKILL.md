---
name: anc-interview
description: 给员工做一次结构访谈，把回答归档到公司内部区。用户说「访谈」「做个访谈」「建档」时使用。触发词：访谈、做个访谈、建档、interview。
---

# anc-interview（公司 bot 侧）

一次访谈 = 一场 A2A 调查（`survey_id` 固定），每题提交一条消息，落内部区 `surveys/<survey_id>/`。

## 1. 开场（一次）

```powershell
node C:\ProgramData\anc\service\cli.ts --db C:\ProgramData\anc\data\anc.db --json a2a create --survey interview-<member>-<YYYYMMDD> --rule-version v1 --rule-file C:\ProgramData\anc\skills\anc-interview\questions.md --expected <userid> --questions 11
```

（`questions.md` 由部署脚本放到上面路径；没有就先用仓库里的 `light/skills/anc-interview/questions.md`。）

回一句进度行，例如「访谈 1/11 · 公司是做什么的？」。

## 2. 逐题问，逐题提交

一次只问一题；员工答完，马上提交（信封先写进临时文件，避免引号被 shell 吃掉）：

```powershell
$envelope = @{ protocol='anc-a2a/1'; survey_id='interview-<member>-<YYYYMMDD>'; message_id='q1'; reply_to=$null; type='answer'; rule_version='v1'; payload='<员工原话或 TBC>' } | ConvertTo-Json -Compress
[IO.File]::WriteAllText("$env:TEMP\anc-env.json", $envelope, (New-Object System.Text.UTF8Encoding($false)))
node C:\ProgramData\anc\service\cli.ts --db C:\ProgramData\anc\data\anc.db --json a2a submit --text-file "$env:TEMP\anc-env.json" --internal D:\anc\vault-internal --from-userid <userid>
```

信封字段（`message_id` 用 `q1`…`q11`）：`protocol` / `survey_id` / `message_id` / `reply_to` / `type` / `rule_version` / `payload`。

- 答不出 → payload 写 `TBC`，不要追问超过一次；
- 每次提交成功就报进度，并问下一题；
- 同一题重答：`message_id` 加后缀 `-r2`，不要覆盖旧答案。

## 3. 收尾

```powershell
node C:\ProgramData\anc\service\cli.ts --db C:\ProgramData\anc\data\anc.db --json a2a status --survey interview-<member>-<YYYYMMDD>
```

`complete=true` 就告诉员工「访谈完成，已归档到内部区」；缺人就说还差谁。

## 继续没做完的访谈

先说「继续访谈」时：

```powershell
node C:\ProgramData\anc\service\cli.ts --db C:\ProgramData\anc\data\anc.db --json a2a status --survey interview-<member>-<YYYYMMDD>
```

- `missing_questions` 里最小的那个就是下一题；从它接着问，`message_id` 用同名；
- `complete=true` 就直接告诉员工已完成，别重复问。

## 边界

- 只记工作事实，不生成绩效、排名、忙闲评价；
- 不编答案；员工说「跳过」就写 `TBC`；
- 访谈内容只进内部区，不在群里复述敏感细节。
