import type { DatabaseSync } from 'node:sqlite';
import { loadNotifyDailyCap, loadQuietRules, nextQuietEnd, nowIso, toIso } from '../../core/index.ts';
import * as delivery from '../../modules/delivery/index.ts';
import * as executor from '../../modules/executor/index.ts';
import * as identity from '../../modules/identity/index.ts';
import * as tasks from '../../modules/tasks/index.ts';

export type AttentionNoticeKind = 'ask' | 'remind' | 'manager' | 'boss';

export interface AttentionTarget {
  person_id: string;
  chat_id: string;
  /** true = 只发中性短号，不带问题正文（回原群/兜底时用） */
  neutral: boolean;
  mode: 'private' | 'origin' | 'boss';
}

export interface AttentionNoticeResult {
  sent: boolean;
  reason: 'sent' | 'duplicate' | 'no-target' | 'daily-cap' | 'blocked' | 'queued-quiet';
  target: AttentionTarget | null;
  outbox_id: number | null;
  at: string;
  text?: string;
}

function privateChat(db: DatabaseSync, personId: string, role: string): string | null {
  if (role === 'boss') {
    return identity.resolvePrivateChat(db, personId, 'boss_dm')
      ?? identity.resolvePrivateChat(db, personId, 'employee');
  }
  // 非老板只认自己的员工群；resolvePrivateChat(..., 'boss_dm') 会返回全局老板 1:1，
  // 对普通员工就是错的目标，不能当兜底。
  return identity.resolvePrivateChat(db, personId, 'employee');
}

function tryPerson(db: DatabaseSync, attention: executor.Attention, personId: string | null | undefined): AttentionTarget | null {
  if (!personId) return null;
  const person = identity.resolvePerson(db, personId);
  if (!person || person.status !== 'active') return null;

  const origin = attention.origin_chat_id ? identity.resolveGroup(db, attention.origin_chat_id) : null;
  const originTarget = origin && origin.status === 'active'
    ? { person_id: person.person_id, chat_id: origin.chat_id, neutral: true, mode: 'origin' as const }
    : null;

  // D32：老板 1:1 不做主动推送；公司/部门级回原群中性短号，内部级等老板问“待办”。
  if (person.system_role === 'boss') return originTarget;

  const chat = privateChat(db, person.person_id, person.system_role);
  if (chat) {
    const g = identity.resolveGroup(db, chat);
    // 私密群没有 webhook 就发不出去；退回原群中性短号，比静默丢消息好。
    if (g && g.status === 'active' && g.webhook_file) {
      return { person_id: person.person_id, chat_id: chat, neutral: false, mode: 'private' };
    }
  }
  return originTarget;
}

function bossTarget(db: DatabaseSync, attention: executor.Attention): AttentionTarget | null {
  const boss = identity.listPeople(db).find((p) => p.system_role === 'boss' && p.status === 'active');
  if (!boss) return null;
  const direct = tryPerson(db, attention, boss.person_id);
  if (direct) return { ...direct, mode: direct.mode === 'private' ? 'boss' : direct.mode };
  return null;
}

/** 按 purpose/提醒级别找“有效”的收件人：私密优先，其次原群中性短号，最后老板。 */
export function resolveAttentionTarget(
  db: DatabaseSync,
  attention: executor.Attention,
  kind: AttentionNoticeKind,
): AttentionTarget | null {
  if (kind === 'boss') return bossTarget(db, attention);

  if (kind === 'manager') {
    const person = identity.resolvePerson(db, attention.required_confirmer_id);
    const managers = person?.dept_id ? identity.listManagersForDept(db, person.dept_id) : [];
    for (const m of managers) {
      const t = tryPerson(db, attention, m.person_id);
      if (t) return t;
    }
    return bossTarget(db, attention);
  }

  const task = attention.task_id !== null ? tasks.getTask(db, attention.task_id) : null;
  const primary = attention.purpose === 'review' ? task?.requester_id : attention.required_confirmer_id;
  const direct = tryPerson(db, attention, primary);
  if (direct) return direct;

  // answer 的第二顺位是交办人（D44）；review 的第一顺位已经是交办人。
  if (attention.purpose === 'answer' && task?.requester_id && task.requester_id !== primary) {
    const requester = tryPerson(db, attention, task.requester_id);
    if (requester) return requester;
  }
  return bossTarget(db, attention);
}

function actionHint(a: executor.Attention): string {
  if (a.purpose === 'answer') return '<内容>';
  if (a.purpose === 'review') return '可以 / 不行 <原因>';
  return '收到';
}

export function buildAttentionText(
  db: DatabaseSync,
  a: executor.Attention,
  kind: AttentionNoticeKind,
  target: AttentionTarget,
): string {
  const confirmer = identity.resolvePerson(db, a.required_confirmer_id);
  const name = confirmer?.name ?? a.required_confirmer_id;
  const code = a.short_code;
  if (target.neutral) {
    if (kind === 'manager') return `【催办 ${code}】${name} 的确认已等 8 小时，请催办；确认仍由本人处理。`;
    if (kind === 'boss') return `【升级 ${code}】${name} 的确认已等 24 小时，请介入；详情回 1:1 问 @公司bot ${code}。`;
    return `【${code}】有一条待确认，请在原会话/私聊回复 @公司bot ${code} ${actionHint(a)}。`;
  }
  if (kind === 'manager') return `【催办 ${code}】${name} 的确认已等 8 小时，请催办；确认仍由本人处理。\n${a.question}`;
  if (kind === 'boss') return `【升级 ${code}】${name} 的确认已等 24 小时，请介入。\n${a.question}`;
  if (kind === 'remind') return `【催办 ${code}】${a.question}\n回复 @公司bot ${code} ${actionHint(a)}。`;
  return `【${code}】${a.question}\n回复 @公司bot ${code} ${actionHint(a)}。`;
}

function localDayStart(d: Date): string {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.toISOString();
}

function countToday(db: DatabaseSync, chatId: string, now: Date): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE chat_id = ? AND created_at >= ?')
    .get(chatId, localDayStart(now)) as { n: number };
  return Number(row.n);
}

function dedupeKey(a: executor.Attention, kind: AttentionNoticeKind): string {
  if (kind === 'ask') return `attention:${a.attention_id}:ask`;
  if (kind === 'remind') return `attention:${a.attention_id}:remind:${a.remind_count + 1}`;
  if (kind === 'manager') return `attention:${a.attention_id}:escalate:2`;
  return `attention:${a.attention_id}:escalate:3`;
}

function isP0Answer(db: DatabaseSync, a: executor.Attention): boolean {
  if (a.purpose !== 'answer' || !a.ticket_id) return false;
  return executor.getTicket(db, a.ticket_id)?.priority === 'P0';
}

/**
 * 把一条 Attention 通知落进 outbox。只做“发不发、发给谁、发什么”，
 * 状态回写由 notifyAttentionAsk / notifyDueAttention 负责。
 */
export function sendAttentionNotice(
  db: DatabaseSync,
  a: executor.Attention,
  kind: AttentionNoticeKind,
  opts: { now?: string } = {},
): AttentionNoticeResult {
  const now = opts.now ? toIso(opts.now) : nowIso();
  const target = resolveAttentionTarget(db, a, kind);
  if (!target) return { sent: false, reason: 'no-target', target: null, outbox_id: null, at: now };

  const nowDate = new Date(now);
  const quiet = loadQuietRules(db);
  const quietUntil = nextQuietEnd(nowDate, quiet);
  const force = kind === 'boss' || isP0Answer(db, a);   // 老板升级与 P0 的 answer 不静默
  const at = quietUntil && !force ? quietUntil.toISOString() : now;

  // 首条 ask 不占每日上限：新问题被静默比多一条通知更糟；上限只压提醒/升级。
  if (kind !== 'boss' && kind !== 'ask' && countToday(db, target.chat_id, nowDate) >= loadNotifyDailyCap(db)) {
    return { sent: false, reason: 'daily-cap', target, outbox_id: null, at: now };
  }

  const text = buildAttentionText(db, a, kind, target);
  try {
    const q = delivery.enqueue(db, {
      text,
      chatId: target.chat_id,
      dedupeKey: dedupeKey(a, kind),
      attentionId: a.attention_id,
      at,
    });
    return {
      sent: q.inserted,
      reason: q.inserted ? 'sent' : 'duplicate',
      target,
      outbox_id: q.id,
      at,
      text,
    };
  } catch (e) {
    return {
      sent: false,
      reason: 'blocked',
      target,
      outbox_id: null,
      at,
      text: (e as Error).message.slice(0, 200),
    };
  }
}

/** 初始通知：成功入队后回写 notified_chat_id / notified_outbox_id。 */
export function notifyAttentionAsk(db: DatabaseSync, a: executor.Attention, opts: { now?: string } = {}): AttentionNoticeResult {
  const r = sendAttentionNotice(db, a, 'ask', opts);
  if (r.sent && r.target && r.outbox_id !== null) {
    executor.markAttentionNotified(db, {
      attentionId: a.attention_id,
      chatId: r.target.chat_id,
      outboxId: r.outbox_id,
    });
  }
  return r;
}

/** 到期提醒/升级：成功入队后推进 escalate_level 与提醒计数。 */
export function notifyDueAttention(
  db: DatabaseSync,
  due: executor.DueAttention,
  opts: { now?: string } = {},
): AttentionNoticeResult {
  const r = sendAttentionNotice(db, due.attention, due.kind, opts);
  if (r.sent) {
    executor.markAttentionReminded(db, {
      attentionId: due.attention.attention_id,
      level: due.level,
      at: opts.now,
    });
  }
  return r;
}
