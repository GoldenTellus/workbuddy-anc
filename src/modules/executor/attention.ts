import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { nowIso, toIso, tx } from '../../core/index.ts';
import { closeTicket, getTicket, type Ticket, type TicketState } from './executor.ts';

export type AttentionPurpose = 'answer' | 'review' | 'responsibility';
export type AttentionStatus =
  | 'open'
  | 'answered'
  | 'approved'
  | 'rejected'
  | 'acked'
  | 'notified'
  | 'expired'
  | 'cancelled';
export type AttentionAction = 'answer' | 'approve' | 'reject' | 'ack';

export interface Attention {
  attention_id: string;
  short_code: string;
  ticket_id: string | null;
  task_id: number | null;
  department_id: string | null;
  purpose: AttentionPurpose;
  question: string;
  options_json: string;
  required_confirmer_id: string;
  require_ack: number;
  origin_chat_id: string | null;
  status: AttentionStatus;
  answer_text: string | null;
  answered_by: string | null;
  on_behalf_of: string | null;
  answer_message_id: string | null;
  notified_chat_id: string | null;
  notified_outbox_id: number | null;
  remind_day: string | null;
  remind_count_today: number;
  remind_count: number;
  last_reminded_at: string | null;
  escalate_level: number;
  created_at: string;
  answered_at: string | null;
  expires_at: string | null;
}

export interface CreateAttentionInput {
  purpose: AttentionPurpose;
  question: string;
  requiredConfirmerId: string;
  ticketId?: string | null;
  taskId?: number | null;
  departmentId?: string | null;
  options?: string[];
  requireAck?: boolean;
  originChatId?: string | null;
  expiresAt?: string | null;
  at?: string;
}

export interface AnswerAttentionInput {
  attentionId: string;
  action: AttentionAction;
  answeredBy: string;
  text?: string | null;
  onBehalfOf?: string | null;
  answerMessageId?: string | null;
  at?: string;
}

export interface ListAttentionOptions {
  status?: AttentionStatus;
  ticketId?: string;
  taskId?: number;
  confirmerId?: string;
  limit?: number;
}

export interface DueAttention {
  attention: Attention;
  level: 1 | 2 | 3;
  kind: 'remind' | 'manager' | 'boss';
}

const PURPOSES: AttentionPurpose[] = ['answer', 'review', 'responsibility'];
const ACTIONS: AttentionAction[] = ['answer', 'approve', 'reject', 'ack'];
const REMIND_MINUTES = 120;
const MANAGER_MINUTES = 480;
const BOSS_MINUTES = 1440;
const MAX_REMINDERS_PER_DAY = 3;

function attentionError(code: string, message: string): Error {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

function validatePurpose(p: string): AttentionPurpose {
  if (!PURPOSES.includes(p as AttentionPurpose)) {
    throw attentionError('EXEC_BAD_ATTENTION_PURPOSE', 'purpose 必须是 answer/review/responsibility');
  }
  return p as AttentionPurpose;
}

function validateAction(a: string): AttentionAction {
  if (!ACTIONS.includes(a as AttentionAction)) {
    throw attentionError('EXEC_ATTENTION_BAD_ACTION', 'action 必须是 answer/approve/reject/ack');
  }
  return a as AttentionAction;
}

function parseOptions(options?: string[]): string {
  if (options === undefined) return '[]';
  if (!Array.isArray(options)) throw attentionError('EXEC_BAD_ATTENTION', 'options 必须是字符串数组');
  return JSON.stringify(options.map((s) => String(s).trim()).filter(Boolean));
}

/** A<seq>：全局单调、不复用；取消/删除不回收。 */
function nextAttentionSeq(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'attention_seq'").get() as { value: string } | undefined;
  const current = row ? Number(row.value) : 0;
  const next = Number.isFinite(current) && current >= 0 ? Math.floor(current) + 1 : 1;
  db.prepare(`INSERT INTO meta (key, value) VALUES ('attention_seq', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(next));
  return next;
}

function localDay(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function recordAttentionEvent(db: DatabaseSync, kind: string, attention: Attention, detail?: unknown): void {
  db.prepare(`INSERT INTO executor_events (kind, host_id, ticket_id, assignment_id, detail, created_at)
    VALUES (?, NULL, ?, NULL, ?, ?)`).run(
    kind,
    attention.ticket_id,
    JSON.stringify({
      attention_id: attention.attention_id,
      short_code: attention.short_code,
      ...(detail && typeof detail === 'object' ? detail as Record<string, unknown> : {}),
    }),
    nowIso(),
  );
}

function ticketEntryState(ticket: Ticket, purpose: AttentionPurpose, requireAck: boolean): TicketState | null {
  if (purpose === 'answer') {
    if (ticket.state !== 'working' && ticket.state !== 'waiting_trigger' && ticket.state !== 'waiting_answer') {
      throw attentionError('EXEC_ATTENTION_BAD_STATE',
        `Ticket ${ticket.ticket_id} 当前 ${ticket.state}，answer 只能从 working/waiting_trigger/waiting_answer 进入`);
    }
    return 'waiting_answer';
  }
  if (purpose === 'review') {
    if (ticket.state !== 'waiting_review') {
      throw attentionError('EXEC_ATTENTION_BAD_STATE',
        `Ticket ${ticket.ticket_id} 当前 ${ticket.state}，review 只能在 waiting_review 建`);
    }
    return null;
  }
  if (requireAck) {
    if (ticket.state !== 'waiting_review' && ticket.state !== 'working') {
      throw attentionError('EXEC_ATTENTION_BAD_STATE',
        `Ticket ${ticket.ticket_id} 当前 ${ticket.state}，require_ack 只能从 waiting_review/working 进入`);
    }
    return 'waiting_ack';
  }
  return null;
}

function expectedStatus(purpose: AttentionPurpose, action: AttentionAction): AttentionStatus {
  if (action === 'answer') {
    if (purpose !== 'answer') throw attentionError('EXEC_ATTENTION_BAD_ACTION', '只有 answer 类型能回答');
    return 'answered';
  }
  if (action === 'approve') {
    if (purpose !== 'review') throw attentionError('EXEC_ATTENTION_BAD_ACTION', '只有 review 类型能通过');
    return 'approved';
  }
  if (action === 'reject') {
    if (purpose !== 'review') throw attentionError('EXEC_ATTENTION_BAD_ACTION', '只有 review 类型能退回');
    return 'rejected';
  }
  if (purpose !== 'responsibility') throw attentionError('EXEC_ATTENTION_BAD_ACTION', '只有 responsibility 类型能回执');
  return 'acked';
}

export function createAttention(db: DatabaseSync, input: CreateAttentionInput): Attention {
  const purpose = validatePurpose(input.purpose);
  const question = String(input.question ?? '').trim();
  if (!question) throw attentionError('EXEC_BAD_ATTENTION', 'question 必填');
  const confirmer = String(input.requiredConfirmerId ?? '').trim();
  if (!confirmer) throw attentionError('EXEC_BAD_ATTENTION', 'requiredConfirmerId 必填');
  const at = input.at ? toIso(input.at) : nowIso();
  const requireAck = input.requireAck === true ? 1 : 0;
  if (requireAck === 1 && purpose !== 'responsibility') {
    throw attentionError('EXEC_BAD_ATTENTION', 'require_ack 只用于 responsibility');
  }
  return tx(db, () => {
    const ticket = input.ticketId ? getTicket(db, input.ticketId) : null;
    if (input.ticketId && !ticket) throw attentionError('EXEC_TICKET_NOT_FOUND', 'ticket 不存在');
    const nextState = ticket ? ticketEntryState(ticket, purpose, requireAck === 1) : null;
    const status: AttentionStatus = purpose === 'responsibility' && requireAck === 0 ? 'notified' : 'open';
    const attention: Attention = {
      attention_id: 'at-' + randomUUID(),
      short_code: 'A' + nextAttentionSeq(db),
      ticket_id: input.ticketId ?? null,
      task_id: input.taskId ?? ticket?.task_id ?? null,
      department_id: input.departmentId ?? ticket?.department_id ?? null,
      purpose,
      question,
      options_json: parseOptions(input.options),
      required_confirmer_id: confirmer,
      require_ack: requireAck,
      origin_chat_id: input.originChatId ?? null,
      status,
      answer_text: null,
      answered_by: null,
      on_behalf_of: null,
      answer_message_id: null,
      notified_chat_id: null,
      notified_outbox_id: null,
      remind_day: null,
      remind_count_today: 0,
      remind_count: 0,
      last_reminded_at: null,
      escalate_level: 0,
      created_at: at,
      answered_at: null,
      expires_at: input.expiresAt ? toIso(input.expiresAt) : null,
    };
    db.prepare(`INSERT INTO attentions
      (attention_id, short_code, ticket_id, task_id, department_id, purpose, question, options_json,
       required_confirmer_id, require_ack, origin_chat_id, status, answer_text, answered_by, on_behalf_of,
       answer_message_id, notified_chat_id, notified_outbox_id, remind_day, remind_count_today, remind_count,
       last_reminded_at, escalate_level, created_at, answered_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, 0, ?, NULL, ?)`)
      .run(attention.attention_id, attention.short_code, attention.ticket_id, attention.task_id,
        attention.department_id, attention.purpose, attention.question, attention.options_json,
        attention.required_confirmer_id, attention.require_ack, attention.origin_chat_id, attention.status,
        attention.created_at, attention.expires_at);
    if (ticket && nextState) {
      db.prepare('UPDATE tickets SET state = ?, updated_at = ? WHERE ticket_id = ?').run(nextState, at, ticket.ticket_id);
      recordAttentionEvent(db, 'attention_ticket_state', attention, { from: ticket.state, to: nextState });
    }
    recordAttentionEvent(db, 'attention_created', attention, { purpose, status });
    return getAttention(db, attention.attention_id)!;
  });
}

export function getAttention(db: DatabaseSync, attentionId: string): Attention | null {
  return (db.prepare('SELECT * FROM attentions WHERE attention_id = ?').get(attentionId) as Attention | undefined) ?? null;
}

export function getAttentionByCode(db: DatabaseSync, shortCode: string): Attention | null {
  const code = String(shortCode ?? '').trim().toUpperCase();
  if (!/^A\d+$/.test(code)) return null;
  return (db.prepare('SELECT * FROM attentions WHERE short_code = ?').get(code) as Attention | undefined) ?? null;
}

export function listAttentions(db: DatabaseSync, opts: ListAttentionOptions = {}): Attention[] {
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (opts.status) { where.push('status = ?'); args.push(opts.status); }
  if (opts.ticketId) { where.push('ticket_id = ?'); args.push(opts.ticketId); }
  if (opts.taskId !== undefined) { where.push('task_id = ?'); args.push(opts.taskId); }
  if (opts.confirmerId) { where.push('required_confirmer_id = ?'); args.push(opts.confirmerId); }
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 50)));
  const sql = `SELECT * FROM attentions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, attention_id DESC LIMIT ${limit}`;
  return db.prepare(sql).all(...(args as never[])) as unknown as Attention[];
}

export function attentionContext(db: DatabaseSync, ticketId: string): Attention[] {
  return db.prepare('SELECT * FROM attentions WHERE ticket_id = ? ORDER BY created_at, attention_id')
    .all(ticketId) as unknown as Attention[];
}

export function answerAttention(db: DatabaseSync, input: AnswerAttentionInput): Attention {
  const action = validateAction(input.action);
  const answeredBy = String(input.answeredBy ?? '').trim();
  if (!answeredBy) throw attentionError('EXEC_BAD_ATTENTION', 'answeredBy 必填');
  const text = input.text == null ? null : String(input.text).trim();
  if ((action === 'answer' || action === 'reject') && !text) {
    throw attentionError('EXEC_BAD_ATTENTION', action === 'answer' ? '回答内容必填' : '退回原因必填');
  }
  const at = input.at ? toIso(input.at) : nowIso();
  return tx(db, () => {
    const a = getAttention(db, input.attentionId);
    if (!a) throw attentionError('EXEC_ATTENTION_NOT_FOUND', 'attention 不存在');
    const next = expectedStatus(a.purpose, action);
    // at-least-once：同一人、同一动作、同一内容重复投递时返回当前状态，不重复推进。
    if (a.status === next) {
      if (a.answered_by === answeredBy && (a.answer_text ?? '') === (text ?? '')) return a;
      throw attentionError('EXEC_ATTENTION_ALREADY_ANSWERED', `已由 ${a.answered_by ?? '他人'} 处理`);
    }
    if (a.status !== 'open') {
      throw attentionError('EXEC_ATTENTION_NOT_OPEN', `attention 当前 ${a.status}，不能再处理`);
    }
    const onBehalf = input.onBehalfOf ? String(input.onBehalfOf).trim() : null;
    db.prepare(`UPDATE attentions
      SET status = ?, answer_text = ?, answered_by = ?, on_behalf_of = ?, answer_message_id = ?, answered_at = ?
      WHERE attention_id = ?`).run(
      next, text, answeredBy, onBehalf, input.answerMessageId ?? null, at, a.attention_id,
    );

    if (a.ticket_id) {
      if (action === 'approve' || action === 'ack') {
        closeTicket(db, { ticketId: a.ticket_id, decision: 'done' });
      } else if (action === 'reject') {
        const t = getTicket(db, a.ticket_id);
        if (t && t.state !== 'done' && t.state !== 'cancelled') {
          db.prepare("UPDATE tickets SET state = 'queued', updated_at = ? WHERE ticket_id = ?").run(at, a.ticket_id);
        }
      }
    }

    recordAttentionEvent(db, 'attention_answered', { ...a, status: next }, {
      action, answered_by: answeredBy, on_behalf_of: onBehalf,
    });
    return getAttention(db, a.attention_id)!;
  });
}

export function cancelAttention(db: DatabaseSync, input: { attentionId: string; reason?: string; at?: string }): Attention {
  const at = input.at ? toIso(input.at) : nowIso();
  return tx(db, () => {
    const a = getAttention(db, input.attentionId);
    if (!a) throw attentionError('EXEC_ATTENTION_NOT_FOUND', 'attention 不存在');
    if (a.status === 'cancelled' || a.status === 'expired') return a;
    if (a.status !== 'open' && a.status !== 'notified') {
      throw attentionError('EXEC_ATTENTION_NOT_OPEN', `attention 当前 ${a.status}，不能取消`);
    }
    db.prepare("UPDATE attentions SET status = 'cancelled' WHERE attention_id = ?").run(a.attention_id);
    recordAttentionEvent(db, 'attention_cancelled', a, { reason: input.reason ?? null });
    return getAttention(db, a.attention_id)!;
  });
}

/** Ticket 取消/过期时，把还挂着的 Attention 一起收口。 */
export function closeAttentionsForTicket(
  db: DatabaseSync,
  input: { ticketId: string; status: 'cancelled' | 'expired'; reason?: string; at?: string },
): number {
  const at = input.at ? toIso(input.at) : nowIso();
  return tx(db, () => {
    const rows = db.prepare(
      "SELECT * FROM attentions WHERE ticket_id = ? AND status IN ('open', 'notified')",
    ).all(input.ticketId) as unknown as Attention[];
    for (const a of rows) {
      db.prepare('UPDATE attentions SET status = ? WHERE attention_id = ?').run(input.status, a.attention_id);
      recordAttentionEvent(db, input.status === 'expired' ? 'attention_expired' : 'attention_cancelled', a, {
        reason: input.reason ?? null,
      });
    }
    return rows.length;
  });
}

/**
 * 到期扫描：只算“哪条该提醒/该升到哪一级”，不发消息。
 * level 1=本人 2h、2=部门管理者 8h、3=老板 24h；level 1 每 2h 最多重复 3 次/天。
 */
export function listDueAttentions(db: DatabaseSync, input: { now: string }): DueAttention[] {
  const now = toIso(input.now);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw attentionError('EXEC_BAD_ATTENTION', 'now 不是合法时间');
  const rows = db.prepare("SELECT * FROM attentions WHERE status = 'open' ORDER BY created_at").all() as unknown as Attention[];
  const due: DueAttention[] = [];
  for (const a of rows) {
    const createdMs = Date.parse(a.created_at);
    if (!Number.isFinite(createdMs)) continue;
    const ageMin = (nowMs - createdMs) / 60_000;
    if (ageMin < 0) continue;
    const target: 0 | 1 | 2 | 3 = ageMin >= BOSS_MINUTES ? 3 : ageMin >= MANAGER_MINUTES ? 2 : ageMin >= REMIND_MINUTES ? 1 : 0;
    if (target === 0) continue;
    let level: 1 | 2 | 3 | null = null;
    if (target > a.escalate_level) {
      level = target as 1 | 2 | 3;
    } else if (target === 1 && a.escalate_level >= 1) {
      const today = localDay(now);
      const countToday = a.remind_day === today ? a.remind_count_today : 0;
      const lastMs = a.last_reminded_at ? Date.parse(a.last_reminded_at) : 0;
      if (countToday < MAX_REMINDERS_PER_DAY && nowMs - lastMs >= REMIND_MINUTES * 60_000) level = 1;
    }
    if (level === null) continue;
    due.push({
      attention: a,
      level,
      kind: level === 3 ? 'boss' : level === 2 ? 'manager' : 'remind',
    });
  }
  return due;
}

export function markAttentionNotified(
  db: DatabaseSync,
  input: { attentionId: string; chatId?: string | null; outboxId?: number | null; at?: string },
): Attention {
  return tx(db, () => {
    const a = getAttention(db, input.attentionId);
    if (!a) throw attentionError('EXEC_ATTENTION_NOT_FOUND', 'attention 不存在');
    db.prepare(`UPDATE attentions
      SET notified_chat_id = COALESCE(?, notified_chat_id),
          notified_outbox_id = COALESCE(?, notified_outbox_id)
      WHERE attention_id = ?`).run(input.chatId ?? null, input.outboxId ?? null, a.attention_id);
    recordAttentionEvent(db, 'attention_notified', a, { chat_id: input.chatId ?? null, outbox_id: input.outboxId ?? null });
    return getAttention(db, a.attention_id)!;
  });
}

export function markAttentionReminded(
  db: DatabaseSync,
  input: { attentionId: string; level: 1 | 2 | 3; at?: string },
): Attention {
  const at = input.at ? toIso(input.at) : nowIso();
  return tx(db, () => {
    const a = getAttention(db, input.attentionId);
    if (!a) throw attentionError('EXEC_ATTENTION_NOT_FOUND', 'attention 不存在');
    const today = localDay(at);
    const countToday = a.remind_day === today ? a.remind_count_today + 1 : 1;
    const level = Math.max(a.escalate_level, input.level);
    db.prepare(`UPDATE attentions
      SET escalate_level = ?, remind_day = ?, remind_count_today = ?, remind_count = remind_count + 1,
          last_reminded_at = ?
      WHERE attention_id = ?`).run(level, today, countToday, at, a.attention_id);
    recordAttentionEvent(db, input.level === 1 ? 'attention_reminded' : 'attention_escalated', a, {
      level: input.level, count_today: countToday,
    });
    return getAttention(db, a.attention_id)!;
  });
}
