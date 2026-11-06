import { readFileSync } from 'node:fs';
import * as bindings from '../../modules/identity/index.ts';
import type { CliContext } from './context.ts';

export default function bind(ctx: CliContext): void {
  const { db, args, cmd, out, fail } = ctx;
  if (cmd === 'set') {
    const r = bindings.bind(
      db,
      String(args['chat-id'] ?? ''),
      String(args.employee ?? ''),
      typeof args.note === 'string' ? args.note : undefined,
      typeof args.userid === 'string' ? args.userid : undefined,
      typeof args['webhook-file'] === 'string' ? args['webhook-file'] : undefined
    );
    out({ ok: true, action: r.action, binding: r.binding });
  } else if (cmd === 'resolve') {
    const b = bindings.resolve(db, String(args['chat-id'] ?? ''));
    out(b ? { ok: true, found: true, binding: b } : { ok: false, found: false });
    if (!b) process.exit(1);
  } else if (cmd === 'unbind') {
    out({ ok: true, removed: bindings.unbind(db, String(args['chat-id'] ?? '')) });
  } else if (cmd === 'list') {
    out({ ok: true, bindings: bindings.listBindings(db) });
  } else if (cmd === 'import') {
    const from = typeof args.from === 'string' ? args.from : '';
    if (!from) fail('缺少 --from <groups.json>');
    const groups = JSON.parse(readFileSync(from, 'utf8')) as bindings.GroupsFile;
    out({ ok: true, ...bindings.importGroups(db, groups) });
  } else fail('未知 bind 子命令');
}
