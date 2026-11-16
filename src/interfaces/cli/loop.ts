import { ancPaths, sideRoot } from '../../core/index.ts';
import { tick, run } from '../../modules/runtime/index.ts';
import type { CliContext } from './context.ts';

export default async function loopGroup(ctx: CliContext): Promise<void> {
  const { db, args, out, fail, numArg } = ctx;
  const explicit = typeof args['webhook-file'] === 'string' ? args['webhook-file'] : null;
  const chatId = typeof args['chat-id'] === 'string' ? args['chat-id'] : undefined;
  if (explicit && !chatId) fail('--webhook-file 只用于联调单个群，必须同时给 --chat-id');
  // 密钥目录只有 core/paths.ts 有权决定（Windows %ProgramData%\anc\secrets / macOS 对应根）
  const secretsDir = ancPaths(sideRoot()).secrets;
  // --now：联调与故障注入时把 tick 拨到指定时刻。只对 --once 有意义，
  // 常驻循环传固定时间会让「每分钟一次」永远停在同一点。
  const nowArg = typeof args.now === 'string' ? args.now : undefined;
  if (nowArg && args.once !== true) fail('--now 只能和 --once 一起用');
  if (args.once === true) {
    const r = await tick(db, { webhookFile: explicit ?? undefined, chatId, secretsDir, now: nowArg });
    out({ ok: true, ...r });
  } else {
    const intervalMs = numArg(args['interval-ms'], 60000, 1000, 3600000);
    process.on('SIGINT', () => { try { db.close(); } catch { /* ignore */ } process.exit(0); });
    await run(db, { webhookFile: explicit ?? undefined, chatId, secretsDir, intervalMs });
  }
}
