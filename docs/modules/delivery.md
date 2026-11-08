# delivery — 出站投递

> 类型：模块契约

> 状态：现行（P4 已全部迁入 `src/modules/delivery/`）
> 代码：`src/modules/delivery/{send,outbox,index}.ts`
> 入口：`src/modules/delivery/index.ts`

## 职责

把"要发的一条消息"可靠地送到**它所属群**的企微群机器人 webhook。只做投递机械，不做"该不该发"的业务判断。

## 拥有

| 数据/文件 | 说明 |
|---|---|
| `outbox` 表 | `dedupe_key` 唯一；`status`: pending / sending / sent / failed |
| 发送策略 | 退避 1/5/15/30/60 分钟；网络类 10 次；到点提醒 TTL 60 分钟 |

## 公开契约

- `enqueue(db, {text, chatId, dedupeKey, mentions?, at?, expiresAt?})` → `{inserted}`
- `listPendingDue(db, now, limit, chatId?)`
- `claim(db, id, now)` / `markSent` / `markFailed` / `requeueTransientFailures`
- `sendPending(db, opts)`：按每条消息的 `chat_id` 查员工群绑定；查不到再查 `groups.webhook_file`（部门/公司/`boss_dm`）→ 读 secrets 里的 webhook → 发送

## 不变量

- **入队前与发送前各扫一次凭据**；扫描器异常 → 不发。
- **没有 `chat_bindings.webhook_file` 也没有 `groups.webhook_file` → 判失败，禁止退回默认群**。
- 发送前先 `claim`（pending → sending）；重叠的 tick / `outbox flush` 不会重复发。
- 领取后 10 分钟没回写视为发送方退出，可重领。
- 到点提醒迟到超过 1 小时 → `EXPIRED`，不补发。
- `last_error` 进库前去掉 URL 与文件原文。
- 脏 payload（坏 JSON）直接判死，不能让它把整轮 tick 卡住。

## 失败模式

| 错误码 | 含义 | 出路 |
|---|---|---|
| `NO_WEBHOOK_FOR_CHAT` | 群未绑定/未登记 webhook | 管理员补 `bind set --webhook-file` 或 `bind group-set --webhook-file` |
| `BAD_PAYLOAD_JSON` | payload 坏了 | 手改库/旧数据；直接判死，人工处理 |
| `EXPIRED` | 超过 TTL | 不补发；需要就重排提醒 |
| `HTTP 4xx/5xx` | webhook 返回非 0 | 看 last_error；修好后 `outbox requeue` |

## 依赖

- 允许：core、identity
- 禁止：tasks（任务不应反向依赖投递的实现；`tasks → delivery` 只走 `enqueue`）
- 禁止：interfaces（HTTP/CLI 只能调它）

## 测试

`npm run test:service` 里的 outbox 去重、退避、过期、凭据拦截用例；迁移后加 `npm run test:delivery`。

## 改动指南

- 改退避/TTL：同步 `docs/LOCAL-SERVICE.md` 的 tick 说明与 `DECISIONS` §5.7。
- 加发送通道（除企微外的 IM）：先加适配接口，不要让 `sendPending` 里出现 if/else 品牌分支。

## 变更记录

| 日期 | 改了什么 | 为什么 |
|---|---|---|
| 2026-11-06 | 建档；`sendPending` 已迁入 `send.ts` | 模块化立项 / P3 |
| 2026-11-06 | P4 迁入 `outbox.ts`，delivery 完整 | 模块化 |
