import { submissions } from '../../modules/improvement/index.ts';
import type { CliContext } from './context.ts';

// 迭代闭环的收集端（L1）。技能 anc-feedback 调这里：
//   submission add --text "..." [--file "..."] [--chat-id "..."] [--user-id "..."]
//   → { ok, id, created, employee }；created=false 表示这条已经记过
export default function submission(ctx: CliContext): void {
  const { db, args, cmd, out, fail } = ctx;
  if (cmd === 'add') {
    const text = typeof args.text === 'string' ? args.text : '';
    if (!text.trim()) fail('缺少 --text');
    try {
      out({ ok: true, ...submissions.add(db, {
        text,
        filePath: typeof args.file === 'string' ? args.file : undefined,
        fileHash: typeof args['file-hash'] === 'string' ? args['file-hash'] : undefined,
        chatId: typeof args['chat-id'] === 'string' ? args['chat-id'] : undefined,
        userid: typeof args['user-id'] === 'string' ? args['user-id'] : undefined,
      }) });
    } catch (e) { fail((e as Error).message); }
  } else if (cmd === 'list') {
    out({ ok: true, submissions: submissions.list(db, {
      limit: typeof args.limit === 'string' ? Number(args.limit) : undefined,
      status: typeof args.status === 'string' ? args.status : undefined,
    }) });
  } else if (cmd === 'set-status') {
    const id = typeof args.id === 'string' ? Number(args.id) : NaN;
    if (!Number.isInteger(id) || id <= 0) fail('缺少 --id');
    const st = String(args.to ?? '');
    if (st !== 'triaged' && st !== 'dropped') fail('--to 只能是 triaged 或 dropped');
    const ok = submissions.setStatus(db, id, st as 'triaged' | 'dropped');
    out({ ok, id, status: st });
    if (!ok) process.exit(1);
  } else fail('未知 submission 子命令（add/list/set-status）');
}
