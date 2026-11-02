import type { DatabaseSync } from 'node:sqlite';
import { nowIso, toIso, tx } from './db.ts';
import { enqueue } from './outbox.ts';
import { assertSafeOutbound } from './outbound-scan.ts';

export type TaskStatus = 'open' | 'done' | 'cancelled' | 'needs_review';
export type TaskKind = 'simple' | 'background';

export interface Task {
  id: number;
  title: string;
  chat_id: string | null;
  assignee: string | null;
  requester: string | null;
  assignee_userid: string | null;
  requester_userid: string | null;
  due_at: string | null;
  status: TaskStatus;
  kind: TaskKind;
  started_at: string | null;
  timeout_minutes: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface CreateTaskInput {
  title: string;
  chatId?: string;
  assignee?: string;
  requester?: string;
  assigneeUserId?: string;
  requesterUserId?: string;
  dueAt?: string;
  kind?: TaskKind;
  timeoutMinutes?: number;
  policyVersion?: string;
  ruleHash?: string;
}

const FIELDS = 'id, title, chat_id, assignee, requester, assignee_userid, requester_userid, due_at, status, kind, started_at, timeout_minutes, created_at, updated_at, completed_at';

export function createTask(db: DatabaseSync, input: CreateTaskInput): Task {
  if (!input.title || !input.title.trim()) throw new Error('title 必填');
  // 标题会进每一条提醒：含凭据就在登记时拒绝，不要等到发送时卡住整个循环
  assertSafeOutbound(input.title);
  const t = nowIso();
  return tx(db, () => {
    const r = db.prepare(
      `INSERT INTO tasks (title, chat_id, assignee, requester, assignee_userid, requester_userid, due_at, status, kind, timeout_minutes, policy_version, rule_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`
    ).run(
      input.title.trim(),
      input.chatId ?? null,
      input.assignee ?? null,
      input.requester ?? null,
      input.assigneeUserId ?? null,
      input.requesterUserId ?? null,
      input.dueAt ? toIso(input.dueAt) : null,
      input.kind ?? 'simple',
      input.kind === 'background' ? Math.min(1440, Math.max(1, Math.floor(input.timeoutMinutes ?? 30))) : null,
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

function assertActor(task: Task, actor?: string): void {
  const ids = [task.assignee_userid, task.requester_userid].filter(Boolean) as string[];
  if (!ids.length) return; // 没登记 userid 的任务不校验（兼容旧数据）
  if (!actor || !ids.includes(actor)) {
    const e = new Error('只有执行人或交办人能操作这个任务') as Error & { code?: string };
    e.code = 'FORBIDDEN';
    throw e;
  }
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
export function completeTask(db: DatabaseSync, id: number, outbox?: { chatId?: string; text: string; dedupeKey?: string; mentions?: string[] }, actor?: string): { task: Task; enqueued: boolean } {
  const t = nowIso();
  return tx(db, () => {
    const task = getTask(db, id);
    if (!task) throw new Error(`任务不存在: ${id}`);
    assertActor(task, actor);
    if (task.status === 'done') return { task, enqueued: false };
    if (task.status === 'cancelled') throw new Error(`任务已取消，不能标记完成: ${id}`);
    db.prepare('UPDATE tasks SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?').run('done', t, t, id);
    db.prepare('INSERT INTO task_events (task_id, kind, detail, created_at) VALUES (?, ?, ?, ?)').run(id, 'completed', null, t);
    db.prepare("UPDATE reminders SET status = 'cancelled' WHERE task_id = ? AND status = 'pending'").run(id);
    let enqueued = false;
    if (outbox) {
      // 走 enqueue：统一过出站扫描（命中即阻断）、按 dedupe_key 去重，并如实返回是否入队。
      // 通知被扫描拦下不应该让「完成任务」失败——任务已完成，只是这条消息不发。
      try {
        const q = enqueue(db, {
          text: outbox.text,
          chatId: outbox.chatId ?? task.chat_id,
          dedupeKey: outbox.dedupeKey ?? `task-done:${id}`,
          mentions: outbox.mentions,
        });
        enqueued = q.inserted;
      } catch (e) {
        db.prepare('INSERT INTO task_events (task_id, kind, detail, created_at) VALUES (?, ?, ?, ?)')
          .run(id, 'notify_blocked', JSON.stringify({ code: (e as Error & { code?: string }).code ?? 'ERROR' }), t);
      }
    }
    return { task: getTask(db, id)!, enqueued };
  });
}

export function cancelTask(db: DatabaseSync, id: number, actor?: string): Task {
  const t = nowIso();
  return tx(db, () => {
    const task = getTask(db, id);
    if (!task) throw new Error(`任务不存在: ${id}`);
    assertActor(task, actor);
    if (task.status !== 'open') throw new Error(`只有 open 的任务能取消: ${id}`);
    db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run('cancelled', t, id);
    db.prepare('INSERT INTO task_events (task_id, kind, detail, created_at) VALUES (?, ?, ?, ?)').run(id, 'cancelled', null, t);
    db.prepare("UPDATE reminders SET status = 'cancelled' WHERE task_id = ? AND status = 'pending'").run(id);
    return getTask(db, id)!;
  });
}

/** 标记后台任务开始执行（由 bot 在动手时调）。简单任务不允许，避免把普通待办变成钉子。 */
export function startBackgroundTask(db: DatabaseSync, id: number): Task {
  return tx(db, () => {
    const task = getTask(db, id);
    if (!task) throw new Error(`没有这个任务: ${id}`);
    if (task.kind !== 'background') throw new Error(`只有后台任务能 start: ${id}`);
    if (task.status !== 'open') throw new Error(`只有 open 的后台任务能 start: ${id}（当前 ${task.status}）`);
    // 重复 start 是调用方 bug：刷新时间会把超时判定拖后，掩盖"卡住"这件事
    if (task.started_at) throw new Error(`这个后台任务已经开始过: ${id}（要重来先 review retry）`);
    const t = nowIso();
    db.prepare('UPDATE tasks SET started_at = ?, updated_at = ? WHERE id = ?').run(t, t, id);
    db.prepare('INSERT INTO task_events (task_id, kind, detail, created_at) VALUES (?, ?, ?, ?)')
      .run(id, 'started', JSON.stringify({ at: t }), t);
    return getTask(db, id)!;
  });
}

/** 超时判定：running 且超过 timeout_minutes 的后台任务转 needs_review（不自动重试）。 */
export function markTimedOut(db: DatabaseSync, now: string): Array<{ id: number; title: string; chat_id: string | null; started_at: string; timeout_minutes: number | null }> {
  const rows = db.prepare("SELECT id, title, chat_id, started_at, timeout_minutes FROM tasks WHERE status = 'open' AND kind = 'background' AND started_at IS NOT NULL").all() as unknown as Array<{ id: number; title: string; chat_id: string | null; started_at: string; timeout_minutes: number | null }>;
  const nowMs = new Date(toIso(now)).getTime();
  const out: Array<{ id: number; title: string; chat_id: string | null; started_at: string; timeout_minutes: number | null }> = [];
  for (const r of rows) {
    const limit = (r.timeout_minutes ?? 30) * 60_000;
    const started = new Date(r.started_at).getTime();
    if (!Number.isFinite(started) || nowMs - started <= limit) continue;
    db.prepare("UPDATE tasks SET status = 'needs_review', updated_at = ? WHERE id = ?").run(toIso(now), r.id);
    db.prepare('INSERT INTO task_events (task_id, kind, detail, created_at) VALUES (?, ?, ?, ?)')
      .run(r.id, 'timeout', JSON.stringify({ started_at: r.started_at, limit_minutes: r.timeout_minutes ?? 30 }), toIso(now));
    out.push({ id: r.id, title: r.title, chat_id: r.chat_id, started_at: r.started_at, timeout_minutes: r.timeout_minutes });
  }
  return out;
}

/** 所有者确认：retry → 回到 open 并清 started_at；close → 取消。needs_review 只能由这里离开。 */
export function reviewTask(db: DatabaseSync, id: number, decision: 'retry' | 'close', actor?: string): Task {
  return tx(db, () => {
    const task = getTask(db, id);
    if (!task) throw new Error(`没有这个任务: ${id}`);
    if (task.status !== 'needs_review') throw new Error(`只有 needs_review 的任务需要复核: ${id}（当前 ${task.status}）`);
    const t = nowIso();
    if (decision === 'retry') {
      db.prepare("UPDATE tasks SET status = 'open', started_at = NULL, updated_at = ? WHERE id = ?").run(t, id);
    } else {
      db.prepare("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?").run(t, id);
      db.prepare("UPDATE reminders SET status = 'cancelled' WHERE task_id = ? AND status = 'pending'").run(id);
    }
    db.prepare('INSERT INTO task_events (task_id, kind, detail, created_at) VALUES (?, ?, ?, ?)')
      .run(id, 'reviewed', JSON.stringify({ decision, actor: actor ?? null }), t);
    return getTask(db, id)!;
  });
}

export function taskEvents(db: DatabaseSync, id: number): Array<{ id: number; kind: string; detail: string | null; created_at: string }> {
  return db.prepare('SELECT id, kind, detail, created_at FROM task_events WHERE task_id = ? ORDER BY id').all(id) as never;
}
