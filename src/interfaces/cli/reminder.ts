import * as reminders from '../../modules/tasks/index.ts';
import type { CliContext } from './context.ts';

export default function reminder(ctx: CliContext): void {
  const { db, args, cmd, out, fail, num, numArg } = ctx;
  if (cmd === 'add') {
    const r = reminders.scheduleReminder(db, { taskId: num('task'), dueAt: String(args.due ?? ''), repeatMinutes: typeof args.repeat === 'string' ? numArg(args.repeat, 15, 1, 1440) : undefined });
    out({ ok: true, reminder: r });
  } else if (cmd === 'due') {
    out({ ok: true, due: reminders.dueReminders(db, typeof args.now === 'string' ? args.now : undefined) });
  } else if (cmd === 'sent') {
    out({ ok: true, ...reminders.markReminderSent(db, num('id'), typeof args.now === 'string' ? args.now : undefined) });
  } else fail('未知 reminder 子命令');
}
