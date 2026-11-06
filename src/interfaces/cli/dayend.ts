import { dayend } from '../../modules/improvement/index.ts';
import type { CliContext } from './context.ts';

// 迭代闭环第五步（L5）：员工说「下班」的记录。纯记录，不调模型。
export default function dayendGroup(ctx: CliContext): void {
  const { db, args, cmd, out, fail } = ctx;
  if (cmd === 'add') {
    const employee = typeof args.employee === 'string' ? args.employee : '';
    if (!employee.trim()) fail('缺少 --employee');
    try {
      const r = dayend.add(db, {
        employee,
        userid: typeof args['user-id'] === 'string' ? args['user-id'] : undefined,
        chatId: typeof args['chat-id'] === 'string' ? args['chat-id'] : undefined,
        note: typeof args.note === 'string' ? args.note : undefined,
        day: typeof args.day === 'string' ? args.day : undefined,
      });
      out({ ok: true, ...r });
    } catch (e) { fail((e as Error).message); }
  } else if (cmd === 'list') {
    out({ ok: true, dayend: dayend.list(db, {
      day: typeof args.day === 'string' ? args.day : undefined,
      limit: typeof args.limit === 'string' ? Number(args.limit) : undefined,
    }) });
  } else if (cmd === 'all-off') {
    // 全员下班判定：夜间窗口的开关条件
    out({ ok: true, ...dayend.checkAllOff(db, {
      day: typeof args.day === 'string' ? args.day : undefined,
    }) });
  } else fail('未知 dayend 子命令（add/list/all-off）');
}
