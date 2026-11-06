import type { DatabaseSync } from 'node:sqlite';
import { nowIso, toIso } from './db.ts';
import { assertSafeOutbound } from './outbound-scan.ts';

export interface OutboxMessage {
  id: number;
  dedupe_key: string | null;
  chat_id: string | null;
  payload: string;
  status: 'pending' | 'sending' | 'sent' | 'failed';
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
  /** 入队时间（测试用逻辑时间）；默认当前时间。也是最早可发时间（next_attempt_at） */
  at?: string;
  /** 过了这个时间还没发出去就不再发（到点提醒迟到太久就没有意义，也可能落到夜里） */
  expiresAt?: string | null;
}

/** 入队前先过凭据扫描：命中就不入库，避免污染 outbox。 */
export function enqueue(db: DatabaseSync, input: EnqueueInput): { inserted: boolean; id: number | null } {
  const safeText = assertSafeOutbound(input.text);
  const mentions = (input.mentions ?? []).map((m) => String(m).trim()).filter(Boolean);
  const t = nowIso();
  const at = toIso(input.at ?? t);
  const r = db.prepare(
    `INSERT INTO outbox (dedupe_key, chat_id, payload, status, created_at, updated_at, next_attempt_at, expires_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
     ON CONFLICT(dedupe_key) DO NOTHING`
  ).run(input.dedupeKey ?? null, input.chatId ?? null, JSON.stringify({ text: safeText, mentions }), t, t, at,
    input.expiresAt ? toIso(input.expiresAt) : null);
  const changes = Number(r.changes ?? 0);
  return { inserted: changes > 0, id: changes > 0 ? Number(r.lastInsertRowid) : null };
}

export function listOutbox(db: DatabaseSync, opts: { status?: OutboxMessage['status']; limit?: number } = {}): OutboxMessage[] {
  const where = opts.status ? 'WHERE status = ?' : '';
  const args: unknown[] = opts.status ? [opts.status] : [];
  args.push(opts.limit ?? 50);
  return db.prepare(`SELECT * FROM outbox ${where} ORDER BY id LIMIT ?`).all(...(args as never[])) as unknown as OutboxMessage[];
}

/** 领取超过这么久还没回写结果的 sending，视为发送进程中途退出，允许重新领取。 */
const CLAIM_STALE_MIN = 10;

function staleBefore(now: string): string {
  return new Date(new Date(now).getTime() - CLAIM_STALE_MIN * 60_000).toISOString();
}

/** 到点且退避已过的待发消息（next_attempt_at 为空按到期处理）；含领取后超时未回写的。
 *  chatId 过滤下推到 SQL —— 先 LIMIT 再在 JS 里过滤会让无关群的消息把名额吃光，
 *  指定群的消息永远排不上（联调 --chat-id 时必现）。 */
export function listPendingDue(db: DatabaseSync, now: string, limit = 20, chatId?: string | null): OutboxMessage[] {
  return db.prepare(
    `SELECT * FROM outbox
     WHERE ((status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
         OR (status = 'sending' AND claimed_at < ?))
       AND (? IS NULL OR chat_id = ?)
     ORDER BY id LIMIT ?`
  ).all(now, staleBefore(now), chatId ?? null, chatId ?? null, limit) as unknown as OutboxMessage[];
}

/**
 * 发送前先领取：只有一个发送方能把它从 pending 改成 sending。
 * loop 与 outbox flush 重叠、或上一轮 tick 还没跑完时，同一条消息不会被发两遍。
 */
export function claim(db: DatabaseSync, id: number, now: string = nowIso()): boolean {
  const r = db.prepare(
    `UPDATE outbox SET status = 'sending', claimed_at = ?, updated_at = ?
     WHERE id = ? AND (status = 'pending' OR (status = 'sending' AND claimed_at < ?))`
  ).run(now, nowIso(), id, staleBefore(now));
  return Number(r.changes ?? 0) === 1;
}

export function markSent(db: DatabaseSync, id: number): void {
  const t = nowIso();
  db.prepare("UPDATE outbox SET status = 'sent', attempts = attempts + 1, claimed_at = NULL, updated_at = ? WHERE id = ?").run(t, id);
}

/** 错误信息进库前去掉 URL 与解析失败时回显的原文，outbox list 不能把 webhook 或文件内容带出去。 */
export function redactError(error: string): string {
  return String(error)
    .replace(/Failed to parse URL from[\s\S]*/i, 'BAD_WEBHOOK_URL')
    .replace(/https?:\/\/\S+/gi, '<url>')
    .slice(0, 300);
}

const BACKOFF_MIN = [1, 5, 15, 30, 60];

/**
 * 配置类错误：重试永远不会成功——webhook 没配、文件内容不是 URL、文件读不到。
 * 这类要**立即判死**，否则会按业务错误退避 5 次（累计半小时以上），
 * 期间每次重试都必然失败，而真正该做的是让人去修配置。
 */
const PERMANENT = /NO_WEBHOOK_FOR_CHAT|webhook 文件内容不是 https URL|读不到 webhook 文件|webhook 文件为空|webhook 文件不是|BAD_PAYLOAD_JSON/i;

/** 网络类错误（开机后还没联网、DNS 未就绪）与业务错误分开：前者多给几次机会。 */
// 超时（AbortSignal.timeout → TimeoutError / aborted due to timeout）也算网络类
const TRANSIENT = /fetch failed|HTTP 5\d\d|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|TimeoutError|aborted due to timeout|AbortError/i;

function isTransient(error: string): boolean {
  return TRANSIENT.test(String(error));
}

/** 这条错误是不是"必须人去修配置"的永久失败。 */
export function isPermanentFailure(error: string): boolean {
  return PERMANENT.test(String(error));
}

export function markFailed(db: DatabaseSync, id: number, error: string): void {
  const row = db.prepare('SELECT attempts FROM outbox WHERE id = ?').get(id) as { attempts: number } | undefined;
  const attempts = Number(row?.attempts ?? 0) + 1;
  const t = nowIso();
  const msg = redactError(error);
  const maxAttempts = PERMANENT.test(error) ? 1 : isTransient(error) ? 10 : 5;
  if (attempts >= maxAttempts) {
    db.prepare("UPDATE outbox SET status = 'failed', attempts = ?, last_error = ?, claimed_at = NULL, updated_at = ? WHERE id = ?")
      .run(attempts, msg, t, id);
    return;
  }
  const backoff = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)];
  const nextAt = new Date(Date.now() + backoff * 60_000).toISOString();
  db.prepare("UPDATE outbox SET status = 'pending', attempts = ?, last_error = ?, claimed_at = NULL, updated_at = ?, next_attempt_at = ? WHERE id = ?")
    .run(attempts, msg, t, nextAt, id);
}

/**
 * 把「近期因网络原因失败」的消息重新入队：开机后网络晚就绪时，别让提醒永久 failed。
 * 只回收 24 小时内、错误看起来是网络类的；**每条只回收一次**（requeued_at），
 * 否则每个 tick 都把它重置成 attempts=0，退避上限形同虚设、watchdog 也永远看不到 failed。
 */
export function requeueTransientFailures(db: DatabaseSync, now: string, withinHours = 24): number {
  const since = new Date(new Date(now).getTime() - withinHours * 3600_000).toISOString();
  const r = db.prepare(
    `UPDATE outbox SET status = 'pending', attempts = 0, next_attempt_at = ?, requeued_at = ?
     WHERE status = 'failed' AND created_at >= ? AND requeued_at IS NULL
       AND (last_error LIKE '%fetch failed%' OR last_error LIKE 'HTTP 5%'
            OR last_error LIKE '%ETIMEDOUT%' OR last_error LIKE '%ECONNRESET%'
            OR last_error LIKE '%ENOTFOUND%' OR last_error LIKE '%EAI_AGAIN%'
            OR last_error LIKE '%TimeoutError%' OR last_error LIKE '%aborted due to timeout%'
            OR last_error LIKE '%AbortError%')`
  ).run(now, now, since);
  return Number(r.changes ?? 0);
}
