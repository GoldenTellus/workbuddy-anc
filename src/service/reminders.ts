import type { DatabaseSync } from 'node:sqlite';
import { nowIso, toIso, tx } from './db.ts';

export interface Reminder {
  id: number;
  task_id: number;
  due_at: string;
  repeat_minutes: number;
  status: 'pending' | 'sent' | 'cancelled';
  last_sent_at: string | null;
  created_at: string;
}

export interface ScheduleInput {
  taskId: number;
  dueAt: string;
  repeatMinutes?: number;
}

function localDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function scheduleReminder(db: DatabaseSync, input: ScheduleInput): Reminder {
  if (!input.dueAt) throw new Error('dueAt 必填');
  const due = toIso(input.dueAt);
  const t = nowIso();
  const rawRepeat = Number(input.repeatMinutes ?? 15);
  const repeat = Number.isFinite(rawRepeat) ? Math.min(1440, Math.max(1, Math.floor(rawRepeat))) : 15;
  return tx(db, () => {
    db.prepare("UPDATE reminders SET status = 'cancelled' WHERE task_id = ? AND status = 'pending'").run(input.taskId);
    const r = db.prepare(
      `INSERT INTO reminders (task_id, due_at, repeat_minutes, status, created_at)
       VALUES (?, ?, ?, 'pending', ?)`
    ).run(input.taskId, due, repeat, t);
    db.prepare('INSERT INTO task_events (task_id, kind, detail, created_at) VALUES (?, ?, ?, ?)')
      .run(input.taskId, 'reminder_scheduled', JSON.stringify({ due_at: due, repeat }), t);
    return db.prepare('SELECT * FROM reminders WHERE id = ?').get(Number(r.lastInsertRowid)) as unknown as Reminder;
  });
}

export function dueReminders(db: DatabaseSync, now: string = nowIso()): Reminder[] {
  return db.prepare("SELECT * FROM reminders WHERE status = 'pending' AND due_at <= ? ORDER BY due_at").all(toIso(now)) as unknown as Reminder[];
}

/**
 * 标记已发；同一自然日内按 repeat_minutes 排下一次，跨天自动停（FORK §5.7：夜里不推送）。
 */
export function markReminderSent(db: DatabaseSync, id: number, now?: string): { sent: Reminder; next: Reminder | null };
export function markReminderSent(db: DatabaseSync, id: number, now: string | undefined, opts: { ifPending: true }): { sent: Reminder; next: Reminder | null } | null;
/** opts.ifPending：提醒已不是 pending（任务刚被完成、提醒被取消）时返回 null，不抛错。 */
export function markReminderSent(db: DatabaseSync, id: number, now: string = nowIso(), opts: { ifPending?: boolean } = {}): { sent: Reminder; next: Reminder | null } | null {
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as unknown as Reminder | undefined;
    if (!row) { if (opts.ifPending) return null; throw new Error(`提醒不存在: ${id}`); }
    if (row.status !== 'pending') { if (opts.ifPending) return null; throw new Error(`提醒不是 pending: ${id}`); }
    const t = toIso(now);
    db.prepare("UPDATE reminders SET status = 'sent', last_sent_at = ? WHERE id = ?").run(t, id);
    db.prepare('INSERT INTO task_events (task_id, kind, detail, created_at) VALUES (?, ?, ?, ?)')
      .run(row.task_id, 'reminder_sent', JSON.stringify({ due_at: row.due_at }), t);

    const nextAt = new Date(new Date(row.due_at).getTime() + row.repeat_minutes * 60_000).toISOString();
    const sameDay = localDate(nextAt) === localDate(row.due_at);
    let next: Reminder | null = null;
    if (sameDay) {
      const r = db.prepare(
        `INSERT INTO reminders (task_id, due_at, repeat_minutes, status, created_at)
         VALUES (?, ?, ?, 'pending', ?)`
      ).run(row.task_id, nextAt, row.repeat_minutes, t);
      next = db.prepare('SELECT * FROM reminders WHERE id = ?').get(Number(r.lastInsertRowid)) as unknown as Reminder;
      db.prepare('INSERT INTO task_events (task_id, kind, detail, created_at) VALUES (?, ?, ?, ?)')
        .run(row.task_id, 'reminder_scheduled', JSON.stringify({ due_at: nextAt, repeat: row.repeat_minutes }), t);
    }
    return { sent: db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as unknown as Reminder, next };
  });
}

export function cancelRemindersForTask(db: DatabaseSync, taskId: number): number {
  const r = db.prepare("UPDATE reminders SET status = 'cancelled' WHERE task_id = ? AND status = 'pending'").run(taskId);
  return Number(r.changes ?? 0);
}
