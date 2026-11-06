import { listOutbox, sendPending } from '../../modules/delivery/index.ts';
import type { CliContext } from './context.ts';

export default async function outboxGroup(ctx: CliContext): Promise<void> {
  const { db, args, cmd, out, fail, numArg } = ctx;
  if (cmd === 'list') {
    out({ ok: true, messages: listOutbox(db, { status: args.status as never, limit: numArg(args.limit, 50, 1, 200) }) });
  } else if (cmd === 'flush') {
    // 与 tick 同一套发送逻辑：按每条消息的群绑定选 webhook，不再把所有群的消息发到一个 URL
    if (typeof args['webhook-file'] === 'string') fail('outbox flush 不接受 --webhook-file：按群绑定发送；联调请用 loop --once --webhook-file --chat-id');
    const r = await sendPending(db, { limit: numArg(args.limit, 20, 1, 200) });
    out({ ok: r.failed === 0, sent: r.sent, failed: r.failed });
  } else fail('未知 outbox 子命令');
}
