# runtime — 运行编排

> 类型：模块契约

> 状态：现行（P4 已全部迁入 `src/modules/runtime/`；`src/service/loop.ts` 是入口薄壳）
> 代码：`src/modules/runtime/{tick,run,carry,escalation,guard,projection,index}.ts`
> 入口：`src/modules/runtime/index.ts`

## 职责

一次 tick 的编排：回收失败消息 → 逾期顺延 → 到点提醒 → 升级通知 → 发送 → 后台任务超时 → 任务投影。它**不拥有表**，只调用能力模块。

## 拥有

| 数据/文件 | 说明 |
|---|---|
| tick 的执行顺序 | 下面的 0–4 步是契约，不能随手调换 |
| 任务投影文件 | 内部区 `collab/tasks.md`（由库单向生成，可重建） |

## 公开契约

- `tick(db, opts)` → `{enqueued, sent, failed, skipped, requeued}`
- `run(db, opts)`：常驻循环，同一时刻只允许一个 tick 在跑
- `writeProjection` / `checkProjection` / `rebuildProjection`

## tick 的固定顺序

0. `requeueTransientFailures`：把开机后网络失败的消息捞回来（每条只回收一次）
1. 逾期顺延：昨天没完成、今天没有 pending 提醒的任务 → 从"现在能开始催的时刻"续排；通知有上限（`CARRY_NOTIFY_MAX = 5`）
2. 到点提醒：非工作时段 → 顺延到下一个工作起点；任务已完成/取消 → 取消提醒；否则入队并标已发
3. 升级：连续 4 次没回应 → 通知交办人（优先发到交办人的群，查不到才退回任务群），之后每小时一次
4. 发送 `sendPending` → 后台任务超时转 `needs_review` → 投影（失败只记日志，不阻断）

## 不变量

- **单飞**：同一时刻只有一个 tick；重叠的 tick 直接跳过。
- 一次 tick 内**所有时间判断用同一个 `now`**，不能每步 `new Date()`。
- 单条坏数据（脏 payload、坏 webhook）**不能拖垮整轮**；该条判失败，其它照发。
- 测试环境（`NODE_TEST_CONTEXT`）**必须注入 `send`**，禁止真实外发。
- 投影失败**不阻断**提醒与发送。
- `--now` 只能与 `--once` 一起用（常驻循环传固定时间会永远停在同一点）。

## 失败模式

| 错误码 | 含义 | 出路 |
|---|---|---|
| `TICK_BUSY` | 上一轮还没跑完 | 正常跳过，不用处理 |
| `PROJECTION_FAILED` | 投影写不进去 | 只记 WARN；查内部区 ACL |
| `NO_SENDER_IN_TEST` | 测试没注入 send | 测试代码补 `send` |

## 依赖

- 允许：core、identity、tasks、delivery、knowledge
- 禁止：interfaces（接口调 runtime，不是反过来）
- 说明：`sendPending` 已迁 delivery（P3）；runtime 只编排，不碰 HTTP 细节。

## 测试

`npm run test:service` 里的 tick 顺序、顺延、升级、超时、投影用例；迁移后加 `npm run test:runtime`。

## 改动指南

- 改 tick 顺序：先想清楚幂等与"已完成任务不能再被提醒"，再改测试。
- 加一个周期动作：优先做成独立函数并在 tick 里显式调用，不要塞进现有循环。
- 改投影：同步 `docs/LOCAL-SERVICE.md` 的 `project` 一节。

## 变更记录

| 日期 | 改了什么 | 为什么 |
|---|---|---|
| 2026-11-06 | 建档；`sendPending` 标记为待迁出 | 模块化立项 |
| 2026-11-06 | P4 迁入 `projection.ts`，runtime 完整 | 模块化 |
