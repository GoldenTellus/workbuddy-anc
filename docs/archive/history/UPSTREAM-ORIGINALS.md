# 上游原文索引

> 这 4 份是**上游的原样文档**（HA7CH/ai-native-company@`90e4fb2`），只作参考。
> 正文已移到 [`reference/upstream/originals/`](../reference/upstream/originals/)，这里只留索引。
>
> 为什么挪走：它们写的是上游的形态（**Mac mini + cc-connect + Claude Code + 飞书**），
> 和本项目（**Windows 单机 + WorkBuddy + 企业微信**）在硬件、IM、引擎三样上都不同。
> 留在这里会让读文档的人误以为是本项目的设计。
>
> 每一份开头都保留了原「本库说明」头部（标明是上游原文、和本库哪个里程碑无关）。

| 文件 | 原位置 | 什么时候真的会看它 |
|---|---|---|
| [M1-DESIGN.md](../reference/upstream/originals/M1-DESIGN.md) | `docs/M1-DESIGN.md` §6 | **只有一处**：脚本退出码约定（0 成功 / 1 校验失败 / 2 用法错误），`FORK-DIRECTION §5.10` 沿用了它 |
| [LESSONS-MANUFACTURING-PILOT.md](../reference/upstream/originals/LESSONS-MANUFACTURING-PILOT.md) | `docs/LESSONS-MANUFACTURING-PILOT.md` | 解释「结构照搬上游制造企业试点」这句话的出处（`FORK-DIRECTION §2`） |
| [RESEARCH.md](../reference/upstream/originals/RESEARCH.md) | `docs/RESEARCH.md` | 对外材料/选型答辩时引用：§5 IM 平台矩阵可作「为什么是企微」的旁证；§6「文件系统当数据库」的行业背书 |
| [LIGHT-MVP.md](../reference/upstream/originals/LIGHT-MVP.md) | `docs/LIGHT-MVP.md` | **只有一处**：名片安全底座五条（`REUSE-MAP` 判定「直接用」），用在每张技能名片上 |

## 注意：`SPEC.md` 里有两处旧链接会指向空

`SPEC.md` 是上游原文（没改过），它正文里引用了两个已经被移走的文件：

| SPEC.md 里的旧链接 | 现在实际位置 |
|---|---|
| `docs/LESSONS-MANUFACTURING-PILOT.md` | [`reference/upstream/originals/LESSONS-MANUFACTURING-PILOT.md`](../reference/upstream/originals/LESSONS-MANUFACTURING-PILOT.md) |
| `docs/RESEARCH.md` | [`reference/upstream/originals/RESEARCH.md`](../reference/upstream/originals/RESEARCH.md) |

**为什么不用改 `SPEC.md`**：它是上游原文，改了就不再是原文。按 `REUSE-MAP` 的口径，
上游文档「原位保留、标了就行」。读到时按下表换算即可。

## 怎么取上游的其他原文

不必依赖这 4 份副本：

```powershell
# 直接看导入点
git show 90e4fb2:docs/M1-DESIGN.md

# 或拉上游后对比
git fetch upstream
git diff 90e4fb2 upstream/main -- docs/
```

## 上游的完整仓库

<https://github.com/HA7CH/ai-native-company>（MIT）。本库导入点是 `90e4fb2`。