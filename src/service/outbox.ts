import type { DatabaseSync } from 'node:sqlite';
import { nowIso, toIso } from './db.ts';
import { assertSafeOutbound } from './outbound-scan.ts';

export interface OutboxMessage {
  id: number;
  dedupe_key: string | null;
  chat_id: string | null;
  payload: string;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnqueueInput {
  text: string;
  chatId?: string | null;
  dedupeKey?: string | null;
  /** 要 @ 的企微 userid（T3 已实测：mentioned_list 可 @ 到人） */
  mentions?: string[];
  /** 入队时间（测试用逻辑时间）；默认当前时间 */
  at?: string;
}

/** 入队前先过凭据扫描：命中就不入库，避免污染 outbox。 */
export function enqueue(db: DatabaseSync, input: EnqueueInput): { inserted: boolean; id: number | null } {
  const safeText = assertSafeOutbound(input.text);
  const mentions = (input.mentions ?? []).map((m) => String(m).trim()).filter(Boolean);
  const t = nowIso();
  const at = toIso(input.at ?? t);
  const r = db.prepare(
    `INSERT INTO outbox (dedupe_key, chat_id, payload, status, created_at, updated_at, next_attempt_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?)
     ON CONFLICT(dedupe_key) DO NOTHING`
  ).run(input.dedupeKey ?? null, input.chatId ?? null, JSON.stringify({ text: safeText, mentions }), t, t, at);
  const changes = Number(r.changes ?? 0);
  return { inserted: changes > 0, id: changes > 0 ? Number(r.lastInsertRowid) : null };
}

export function listOutbox(db: DatabaseSync, opts: { status?: OutboxMessage['status']; limit?: number } = {}): OutboxMessage[] {
  const where = opts.status ? 'WHERE status = ?' : '';
  const args: unknown[] = opts.status ? [opts.status] : [];
  args.push(opts.limit ?? 50);
  return db.prepare(`SELECT * FROM outbox ${where} ORDER BY id LIMIT ?`).all(...(args as never[])) as unknown as OutboxMessage[];
}

/** 到点且退避已过的待发消息（next_attempt_at 为空按到期处理）。 */
export function listPendingDue(db: DatabaseSync, now: string, limit = 20): OutboxMessage[] {
  return db.prepare(
    `SELECT * FROM outbox WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY id LIMIT ?`
  ).all(now, limit) as unknown as OutboxMessage[];
}

export function markSent(db: DatabaseSync, id: number): void {
  const t = nowIso();
  db.prepare("UPDATE outbox SET status = 'sent', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(t, id);
}

const BACKOFF_MIN = [1, 5, 15, 30, 60];

export function markFailed(db: DatabaseSync, id: number, error: string): void {
  const row = db.prepare('SELECT attempts FROM outbox WHERE id = ?').get(id) as { attempts: number } | undefined;
  const attempts = Number(row?.attempts ?? 0) + 1;
  const t = nowIso();
  if (attempts >= 5) {
    db.prepare("UPDATE outbox SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .run(attempts, String(error).slice(0, 500), t, id);
    return;
  }
  const backoff = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)];
  const nextAt = new Date(Date.now() + backoff * 60_000).toISOString();
  db.prepare("UPDATE outbox SET attempts = ?, last_error = ?, updated_at = ?, next_attempt_at = ? WHERE id = ?")
    .run(attempts, String(error).slice(0, 500), t, nextAt, id);
}
