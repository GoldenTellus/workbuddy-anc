import type { DatabaseSync } from 'node:sqlite';
import { nowIso, tx } from './db.ts';

export type TaskStatus = 'open' | 'done' | 'cancelled';

export interface Task {
  id: number;
  title: string;
  chat_id: string | null;
  assignee: string | null;
  requester: string | null;
  due_at: string | null;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface CreateTaskInput {
  title: string;
  chatId?: string;
  assignee?: string;
  requester?: string;
  dueAt?: string;
  policyVersion?: string;
  ruleHash?: string;
}

const FIELDS = 'id, title, chat_id, assignee, requester, due_at, status, created_at, updated_at, completed_at';

export function createTask(db: DatabaseSync, input: CreateTaskInput): Task {
  if (!input.title || !input.title.trim()) throw new Error('title 必填');
  const t = nowIso();
  return tx(db, () => {
    const r = db.prepare(
      `INSERT INTO tasks (title, chat_id, assignee, requester, due_at, status, policy_version, rule_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`
    ).run(
      input.title.trim(),
      input.chatId ?? null,
      input.assignee ?? null,
      input.requester ?? null,
      input.dueAt ?? null,
      input.policyVersion ?? null,
      input.ruleHash ?? null,
      t,
      t
    );
    const id = Number(r.lastInsertRowid);
    db.prepare('INSERT INTO task_events (task_id, kind, detail, created_at) VALUES (?, ?, ?, ?)')
      .run(id, 'created', JSON.stringify({ title: input.title.trim() }), t);
    return getTask(db, id)!;
  });
}

export function getTask(db: DatabaseSync, id: number): Task | null {
  const row = db.prepare(`SELECT ${FIELDS} FROM tasks WHERE id = ?`).get(id);
  return (row as Task | undefined) ?? null;
}

export function listTasks(db: DatabaseSync, opts: { status?: TaskStatus; chatId?: string; limit?: number } = {}): Task[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.status) { where.push('status = ?'); args.push(opts.status); }
  if (opts.chatId) { where.push('chat_id = ?'); args.push(opts.chatId); }
  const sql = `SELECT ${FIELDS} FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  args.push(opts.limit ?? 50);
  return db.prepare(sql).all(...(args as never[])) as unknown as Task[];
}

/**
 * 完成与出站消息在同一个事务里提交（FORK §5.5）。
 * 重复完成是幂等的：已 done 的任务再点一次不再写事件、不再入队。
 */
export function completeTask(db: DatabaseSync, id: number, outbox?: { chatId?: string; text: string; dedupeKey?: string }): { task: Task; enqueued: boolean } {
  const t = nowIso();
  return tx(db, () => {
    const task = getTask(db, id);
    if (!task) throw new Error(`任务不存在: ${id}`);
    if (task.status === 'done') return { task, enqueued: false };
    if (task.status === 'cancelled') throw new Error(`任务已取消，不能标记完成: ${id}`);
    db.prepare('UPDATE tasks SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?').run('done', t, t, id);
    db.prepare('INSERT INTO task_events (task_id, kind, detail, created_at) VALUES (?, ?, ?, ?)').run(id, 'completed', null, t);
    db.prepare("UPDATE reminders SET status = 'cancelled' WHERE task_id = ? AND status = 'pending'").run(id);
    let enqueued = false;
    if (outbox) {
      db.prepare(
        `INSERT INTO outbox (dedupe_key, chat_id, payload, status, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?)
         ON CONFLICT(dedupe_key) DO NOTHING`
      ).run(outbox.dedupeKey ?? `task-done:${id}`, outbox.chatId ?? task.chat_id ?? null, JSON.stringify({ text: outbox.text }), t, t);
      enqueued = true;
    }
    return { task: getTask(db, id)!, enqueued };
  });
}

export function cancelTask(db: DatabaseSync, id: number): Task {
  const t = nowIso();
  return tx(db, () => {
    const task = getTask(db, id);
    if (!task) throw new Error(`任务不存在: ${id}`);
    if (task.status !== 'open') throw new Error(`只有 open 的任务能取消: ${id}`);
    db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run('cancelled', t, id);
    db.prepare('INSERT INTO task_events (task_id, kind, detail, created_at) VALUES (?, ?, ?, ?)').run(id, 'cancelled', null, t);
    db.prepare("UPDATE reminders SET status = 'cancelled' WHERE task_id = ? AND status = 'pending'").run(id);
    return getTask(db, id)!;
  });
}

export function taskEvents(db: DatabaseSync, id: number): Array<{ id: number; kind: string; detail: string | null; created_at: string }> {
  return db.prepare('SELECT id, kind, detail, created_at FROM task_events WHERE task_id = ? ORDER BY id').all(id) as never;
}
