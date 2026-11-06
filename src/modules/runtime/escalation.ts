import type { DatabaseSync } from 'node:sqlite';
import { toIso } from '../../core/index.ts';
import { resolveByUserid } from '../identity/index.ts';
import { enqueue } from '../delivery/index.ts';
import { blockedBySecret } from './guard.ts';

export interface EscalationTask {
  id: number;
  title: string;
  chat_id: string | null;
  requester_userid: string | null;
}

/**
 * 连续 4 次没回应 → 在交办人自己的群里通知一次，并把后续提醒改成每小时。
 * 返回本轮新增的 outbox 条数（0 或 1）。
 */
export function escalateIfNeeded(
  db: DatabaseSync,
  task: EscalationTask,
  sentCount: number,
  opts: { now: string; sendAt: string }
): number {
  if (sentCount < 4) return 0;
  const escText = `任务 #${task.id} ${task.title} 已提醒 ${sentCount} 次仍未回应，请交办人跟进`;
  if (blockedBySecret(db, task.id, escText, opts.now)) return 0;

  const reqGroup = task.requester_userid ? resolveByUserid(db, task.requester_userid) : null;
  if (!reqGroup) {
    db.prepare("INSERT INTO task_events (task_id, kind, detail, created_at) VALUES (?, 'escalate_no_group', ?, ?)")
      .run(task.id, JSON.stringify({ fallback: 'task_chat' }), toIso(opts.now));
  }
  const esc = enqueue(db, {
    text: escText,
    // 交办人在一人一群里通常不在执行人的群：优先发到交办人的群；查不到才退回任务所在群
    chatId: reqGroup?.chat_id ?? task.chat_id,
    dedupeKey: `escalate:${task.id}`,
    mentions: task.requester_userid ? [task.requester_userid] : [],
    at: opts.sendAt,
  });
  // markReminderSent 已按旧间隔（15 分钟）排好下一次：一并改到一小时后
  db.prepare("UPDATE reminders SET repeat_minutes = 60, due_at = ? WHERE task_id = ? AND status = 'pending'")
    .run(new Date(new Date(toIso(opts.now)).getTime() + 60 * 60_000).toISOString(), task.id);
  return esc.inserted ? 1 : 0;
}
