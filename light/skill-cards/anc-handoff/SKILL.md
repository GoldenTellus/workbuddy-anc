---
name: anc-handoff
description: 把本机整理好的资料交给公司 bot 入库。用户说「入库」「交给公司 bot」「归档」时使用。触发词：入库、交给公司 bot、归档、handoff。
---

# anc-handoff（个人 bot 侧名片）

> 未实现（主干 4 待设计，旧 1.0 名片）：仓库内没有该技能正文，handoff 协议与归属确认尚未定，不要当成可直接调用的入库流程。

正文在共享区：`{{vault_shared}}/skills/anc-handoff/SKILL.md`。先读正文，再按它做。

## 底线（不依赖正文）

- 个人 bot **不直接写公司 vault**；资料由主人转发给公司 bot，走公司 bot 的入库流程。
- 整理时只写资料里有的，不编。
- 不把内部路径、凭据写进要外发的材料。
