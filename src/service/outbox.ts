import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from './db.ts';
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
}

/** 入队前先过凭据扫描：命中就不入库，避免污染 outbox。 */
export function enqueue(db: DatabaseSync, input: EnqueueInput): { inserted: boolean; id: number | null } {
  const safeText = assertSafeOutbound(input.text);
  const t = nowIso();
  const r = db.prepare(
    `INSERT INTO outbox (dedupe_key, chat_id, payload, status, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?)
     ON CONFLICT(dedupe_key) DO NOTHING`
  ).run(input.dedupeKey ?? null, input.chatId ?? null, JSON.stringify({ text: safeText }), t, t);
  const changes = Number(r.changes ?? 0);
  return { inserted: changes > 0, id: changes > 0 ? Number(r.lastInsertRowid) : null };
}

export function listOutbox(db: DatabaseSync, opts: { status?: OutboxMessage['status']; limit?: number } = {}): OutboxMessage[] {
  const where = opts.status ? 'WHERE status = ?' : '';
  const args: unknown[] = opts.status ? [opts.status] : [];
  args.push(opts.limit ?? 50);
  return db.prepare(`SELECT * FROM outbox ${where} ORDER BY id LIMIT ?`).all(...(args as never[])) as unknown as OutboxMessage[];
}

export function markSent(db: DatabaseSync, id: number): void {
  const t = nowIso();
  db.prepare("UPDATE outbox SET status = 'sent', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(t, id);
}

export function markFailed(db: DatabaseSync, id: number, error: string): void {
  const t = nowIso();
  db.prepare("UPDATE outbox SET status = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?")
    .run(String(error).slice(0, 500), t, id);
}
