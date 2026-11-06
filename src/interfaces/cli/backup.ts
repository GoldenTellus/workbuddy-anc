import { backup } from '../../core/index.ts';
import type { CliContext } from './context.ts';

export default function backupGroup(ctx: CliContext): void {
  const { db, args, out, fail } = ctx;
  const to = typeof args.to === 'string' ? args.to : '';
  if (!to) fail('缺少 --to');
  out({ ok: true, path: backup(db, to) });
}
