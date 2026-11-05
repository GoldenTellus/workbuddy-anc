# D 阶段交接提示词（B 路：接手维护）

> 用法：**开一个新会话**（不要继承当前会话的上下文），把下面「提示词」那一栏整段贴过去。
> 不要额外补充任何这台机器的信息 —— 让他自己查，那才是验「陌生 agent 能不能接手」。

---

## 提示词（直接复制这一段）

```
你是公司主机上的运维 agent，接手一台已经在跑的公司主机（Windows）。

仓库：https://github.com/GoldenTellus/workbuddy-anc

先做三件事，然后告诉我结论：
1. 读仓库里的 docs/AGENT-VERIFY-HANDOFF.md，弄清这台机器现在是什么状态；
2. 跑一遍自证：scripts\doctor.ps1（部署目录里也有一份 %ProgramData%\anc\bin\doctor.ps1）
   和 deploy-verify.ps1，把结果如实报给我；
3. 告诉我这台机器上「补丁」现在是什么状态 —— 它有没有生效、靠什么自愈、怎么验。

做到哪一步卡住了就停下来说清楚卡在哪，不要猜、不要跳过、不要编。
需要我配合的（比如去企微后台点东西）直接说。
```

---

## 为什么只给这么多

**1.0 判据第 4 条问的不是「他照着我说的做能不能做完」，是「他拿到仓库能不能自己判断现状」。**

所以提示词里**故意不给**：

| 故意不给的信息 | 为什么 |
|---|---|
| WorkBuddy 版本（5.9.3） | 他应该自己查 |
| 补丁现在生效了（`applied=true` / `mode=hash` / pid 活着） | **第 3 问就是在考这个** |
| 补丁靠 `anc-patch-guard` 每分钟跑 + `selfheal` 自愈 | 他应该从仓库和日志里读出来 |
| 我在 C 阶段撞过的 4 个卡点 | 已经**修进脚本和文档**了，他不该再撞；如果他撞了，说明修得不够 |
| `secrets` 文件级的权限坑 | 已经修进 `set-acl.ps1` 了 |
| `test-emit.flag` 已删、`17999` 可能还在听 | **这是个真实的隐藏状态**，看他会不会被误导 |
| 绑了 1 个群（测试群） | 他应该从 `bind list` 读 |
| `staff-a` 已被移出 | 他应该从 `D:\anc\org\members\` 读 |

---

## 他大概会走的路（我的预测，用来对照）

```
1. 读 AGENT-VERIFY-HANDOFF.md §1（判断这台机器能干什么）→ §2（装运行件 / 看进度）
2. deploy-state.ps1 -Status → 会看到 9/11，patch 和 wecom 标 FAILED
   ⚠️ 这是上一轮 5.8.3 上留下的历史记录，现在两项实际都好了
   —— 他如果只信 deploy-state 就会得出「还没装完」的错误结论
   —— 正确做法是跑 doctor / deploy-verify 复核
3. doctor → ok=True fails=0 warns=1（work-hours）
4. deploy-verify → 可能会卡在 bot-reply（有 binding 就尝试注入，17999 可能还在听但没人处理）
   —— 正确做法是看 FIX 提示，或者干脆跳过这一项并说明原因
5. 第 3 问（补丁状态）→ 他应该去读 data\patch-state.json + data\selfheal.log
   + 认出 scripts\patch-guard.ps1 → anc-selfheal.ps1 这条链
```

**最容易踩的三个点**：

1. **只信 `deploy-state` 的 9/11**，不跑 `doctor` 复核 → 结论错
2. **`deploy-verify` 的 `bot-reply` 卡住**（有 binding + `17999` 在听但无响应）→ 不知道怎么绕
3. **把 `patch` 在 `deploy-state` 里的 FAILED 当成"现在还是坏的"** → 没去看 `patch-state.json`

---

## 我怎么判他做得对不对

| 判据 | 通过 | 不通过 |
|---|---|---|
| 找到仓库、读到交接文档 | ✅ | — |
| 跑 `doctor` 并如实报 `ok=True fails=0 warns=1` | ✅ | 报错、或报的数字不对 |
| 跑 `deploy-verify` 并说清哪项 SKIP / 卡住 | ✅ | 沉默跳过、或声称全绿但没说 SKIP |
| **第 3 问：说出补丁 `applied=true` `mode=hash`，并指出自愈链是 `patch-guard → selfheal`** | ✅ | 只说"补丁装了"、或去翻 `workbuddy-patch.log` 找 `APPLIED` 就以为完事（那只能证明注入过，不能证明现在活着） |
| **对 `deploy-state` 9/11 的处理** | 认出这是历史记录、用 `doctor` 复核 | 直接报"还没装完" |
| **不编造** | 卡住就说卡住 | 编一个数字或结论 |

---

## 我会在旁边看，不插手

**除非他明确说"需要我配合"**（比如要去企微后台），否则我不出声、不提示、不帮他查。

他做完之后，我按上表逐项对照，把结果记进 `VERIFY §79`（D 阶段实测）。

---

## 现在的机器状态（给你自己看的，不是给他的）

```
WorkBuddy     5.9.3 / app.asar 173.56 MB
patch         applied=True  mode=hash  pid 活着
doctor        ok=True  fails=0  warns=1（work-hours）
deploy-verify PASS=5  FAIL=0  SKIP=0
deploy-state  9/11（patch 与 wecom 标 FAILED —— 5.8.3 时的历史记录，现在两项实际都好了）
绑定          1 条（管理员 → 测试群 wrkc…k2Hfbg）
任务          10 个 · 17891 在监听
test-emit     已删，但 17999 可能还在听（WorkBuddy 没重启过）
vault         两个 git 仓库（vault-shared / vault-internal）
仓库          E:\workbuddy-anc，39 个提交未推
```
