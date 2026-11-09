import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../core/index.ts';
import {
  appendReport,
  claim,
  closeTicket,
  createHost,
  createTicket,
  endAssignment,
  expireTickets,
  getTicket,
  startAssignment,
  type Ticket,
} from './executor.ts';
import {
  answerAttention,
  attentionContext,
  cancelAttention,
  closeAttentionsForTicket,
  createAttention,
  getAttention,
  getAttentionByCode,
  listAttentions,
  listDueAttentions,
  markAttentionNotified,
  markAttentionReminded,
  type Attention,
} from './attention.ts';

type Db = ReturnType<typeof openDb>;

function seedTask(db: Db): number {
  const now = new Date().toISOString();
  const r = db.prepare("INSERT INTO tasks (title, status, created_at, updated_at) VALUES (?, 'open', ?, ?)")
    .run('test-task', now, now);
  return Number(r.lastInsertRowid);
}

function host(db: Db, date = '2026-11-09') {
  return createHost(db, {
    conversationId: 'conv-' + date,
    businessDate: date,
    cutAt: date + 'T19:00:00.000Z',
  });
}

function workingTicket(db: Db, h: ReturnType<typeof host>, maxAttempts?: number): Ticket {
  const role = seedTask(db);
  const t = createTicket(db, { taskId: role, departmentId: 'sales', title: '整理报价', maxAttempts });
  const c = claim(db, { hostId: h.host_id });
  assert.ok(c);
  startAssignment(db, { assignmentId: c!.assignment.assignment_id, subagentId: 'agent-1' });
  return getTicket(db, t.ticket_id)!;
}

function reviewReadyTicket(db: Db, h: ReturnType<typeof host>): Ticket {
  const t = workingTicket(db, h);
  const c = db.prepare("SELECT * FROM assignments WHERE ticket_id = ? AND state = 'running' LIMIT 1").get(t.ticket_id) as { assignment_id: string };
  appendReport(db, {
    assignmentId: c.assignment_id,
    type: 'ready',
    summary: '完成',
    evidence: [t.task_dir + '/out.md'],
  });
  endAssignment(db, { assignmentId: c.assignment_id });
  return getTicket(db, t.ticket_id)!;
}

function runningAssignmentId(db: Db, ticketId: string): string {
  const a = db.prepare("SELECT * FROM assignments WHERE ticket_id = ? AND state = 'running' LIMIT 1").get(ticketId) as { assignment_id: string } | undefined;
  assert.ok(a, '没有 running assignment');
  return a!.assignment_id;
}

test('attention：answer 从 working 进入 waiting_answer，回答后同一 Ticket 保持等待人工恢复', () => {
  const db = openDb(':memory:');
  try {
    const h = host(db);
    const t = workingTicket(db, h);
    const a = createAttention(db, {
      purpose: 'answer',
      ticketId: t.ticket_id,
      question: 'Q3 报价的成本数是多少？',
      requiredConfirmerId: 'emp-zhang',
      originChatId: 'chat-sales',
      options: ['含税', '不含税'],
    });
    assert.equal(a.short_code, 'A1');
    assert.equal(a.status, 'open');
    assert.equal(getTicket(db, t.ticket_id)!.state, 'waiting_answer');

    const answered = answerAttention(db, {
      attentionId: a.attention_id,
      action: 'answer',
      text: '成本 12 万，含税',
      answeredBy: 'emp-zhang',
      answerMessageId: 'msg-1',
    });
    assert.equal(answered.status, 'answered');
    assert.equal(answered.answer_text, '成本 12 万，含税');
    assert.equal(answered.answered_by, 'emp-zhang');
    // answer 不替 Main 推进 Ticket；恢复走 human slot。
    assert.equal(getTicket(db, t.ticket_id)!.state, 'waiting_answer');

    const again = answerAttention(db, {
      attentionId: a.attention_id,
      action: 'answer',
      text: '成本 12 万，含税',
      answeredBy: 'emp-zhang',
    });
    assert.equal(again.status, 'answered');
    assert.throws(() => answerAttention(db, {
      attentionId: a.attention_id,
      action: 'answer',
      text: '成本 13 万',
      answeredBy: 'emp-zhang',
    }), /已由/);

    const ctx = attentionContext(db, t.ticket_id);
    assert.equal(ctx.length, 1);
    assert.equal(ctx[0].answer_text, '成本 12 万，含税');
  } finally { db.close(); }
});

test('attention：review approve 收口 Ticket/任务，reject 回 queued', () => {
  const db = openDb(':memory:');
  try {
    const h = host(db);
    const t = reviewReadyTicket(db, h);
    assert.equal(t.state, 'waiting_review');
    const a = createAttention(db, {
      purpose: 'review',
      ticketId: t.ticket_id,
      question: '报价整理好了，可以提交吗？',
      requiredConfirmerId: 'boss',
    });
    const approved = answerAttention(db, {
      attentionId: a.attention_id,
      action: 'approve',
      answeredBy: 'boss',
    });
    assert.equal(approved.status, 'approved');
    assert.equal(getTicket(db, t.ticket_id)!.state, 'done');

    const t2 = reviewReadyTicket(db, h);
    const a2 = createAttention(db, {
      purpose: 'review',
      ticketId: t2.ticket_id,
      question: '这份可以吗？',
      requiredConfirmerId: 'boss',
    });
    const rejected = answerAttention(db, {
      attentionId: a2.attention_id,
      action: 'reject',
      text: '金额写错了，重做',
      answeredBy: 'boss',
    });
    assert.equal(rejected.status, 'rejected');
    assert.equal(getTicket(db, t2.ticket_id)!.state, 'queued');
  } finally { db.close(); }
});

test('attention：responsibility 默认 notified 不改 Ticket，require_ack 走 waiting_ack', () => {
  const db = openDb(':memory:');
  try {
    const h = host(db);
    const t1 = workingTicket(db, h);
    const noted = createAttention(db, {
      purpose: 'responsibility',
      ticketId: t1.ticket_id,
      question: '这件事后续由你跟进',
      requiredConfirmerId: 'emp-li',
    });
    assert.equal(noted.status, 'notified');
    assert.equal(getTicket(db, t1.ticket_id)!.state, 'working');
    assert.throws(() => answerAttention(db, {
      attentionId: noted.attention_id,
      action: 'ack',
      answeredBy: 'emp-li',
    }), /不能再处理/);

    const t2 = workingTicket(db, h);
    const acked = createAttention(db, {
      purpose: 'responsibility',
      ticketId: t2.ticket_id,
      question: '这件事后续由你接手，请确认',
      requiredConfirmerId: 'emp-li',
      requireAck: true,
    });
    assert.equal(acked.status, 'open');
    assert.equal(getTicket(db, t2.ticket_id)!.state, 'waiting_ack');
    const ack = answerAttention(db, {
      attentionId: acked.attention_id,
      action: 'ack',
      answeredBy: 'emp-li',
    });
    assert.equal(ack.status, 'acked');
    assert.equal(getTicket(db, t2.ticket_id)!.state, 'done');
  } finally { db.close(); }
});

test('attention：非法入口被拒绝；review 只能从 waiting_review 建', () => {
  const db = openDb(':memory:');
  try {
    const h = host(db);
    const role = seedTask(db);
    const queued = createTicket(db, { taskId: role, departmentId: 'sales', title: '还没跑' });
    assert.throws(() => createAttention(db, {
      purpose: 'answer',
      ticketId: queued.ticket_id,
      question: 'q',
      requiredConfirmerId: 'x',
    }), /只能从/);

    const working = workingTicket(db, h);
    assert.throws(() => createAttention(db, {
      purpose: 'review',
      ticketId: working.ticket_id,
      question: 'q',
      requiredConfirmerId: 'x',
    }), /只能在/);
    assert.throws(() => createAttention(db, {
      purpose: 'answer',
      question: 'q',
      requiredConfirmerId: 'x',
      requireAck: true,
    }), /require_ack/);
  } finally { db.close(); }
});

test('attention：短号全局单调、不复用，可按短号取回', () => {
  const db = openDb(':memory:');
  try {
    const a1 = createAttention(db, { purpose: 'answer', question: 'q1', requiredConfirmerId: 'x' });
    const a2 = createAttention(db, { purpose: 'answer', question: 'q2', requiredConfirmerId: 'x' });
    const a3 = createAttention(db, { purpose: 'answer', question: 'q3', requiredConfirmerId: 'x' });
    assert.deepEqual([a1.short_code, a2.short_code, a3.short_code], ['A1', 'A2', 'A3']);
    assert.equal(getAttentionByCode(db, 'a2')!.attention_id, a2.attention_id);
    assert.equal(getAttentionByCode(db, 'nope'), null);
    assert.equal(listAttentions(db, { confirmerId: 'x' }).length, 3);
  } finally { db.close(); }
});

test('attention：2h/8h/24h 到期扫描，remind 可重复但每天最多 3 次', () => {
  const db = openDb(':memory:');
  try {
    const now = '2026-11-09T02:00:00.000Z';   // 本地 10:00
    const mk = (at: string): Attention => createAttention(db, {
      purpose: 'answer', question: 'q', requiredConfirmerId: 'x', at,
    });
    const a1 = mk('2026-11-08T23:00:00.000Z');   // 3h
    const a2 = mk('2026-11-08T17:00:00.000Z');   // 9h
    const a3 = mk('2026-11-08T01:00:00.000Z');   // 25h

    const due = listDueAttentions(db, { now });
    assert.deepEqual(due.map((d) => [d.attention.short_code, d.level, d.kind]).sort(), [
      ['A1', 1, 'remind'],
      ['A2', 2, 'manager'],
      ['A3', 3, 'boss'],
    ]);

    markAttentionReminded(db, { attentionId: a1.attention_id, level: 1, at: now });
    assert.equal(listDueAttentions(db, { now: '2026-11-09T03:00:00.000Z' }).length, 2); // A2/A3 还没标记
    assert.equal(listDueAttentions(db, { now: '2026-11-09T04:00:00.000Z' })
      .filter((d) => d.attention.short_code === 'A1').length, 1);

    markAttentionReminded(db, { attentionId: a1.attention_id, level: 1, at: '2026-11-09T04:00:00.000Z' });
    markAttentionReminded(db, { attentionId: a1.attention_id, level: 1, at: '2026-11-09T06:00:00.000Z' });

    markAttentionReminded(db, { attentionId: a2.attention_id, level: 2, at: now });
    markAttentionReminded(db, { attentionId: a3.attention_id, level: 3, at: now });
    // a1 到 8h 后应从“本人提醒”升到“部门管理者”，不能再按 level 1 重复。
    const at8 = listDueAttentions(db, { now: '2026-11-09T08:00:00.000Z' });
    assert.deepEqual(at8.map((d) => [d.attention.short_code, d.level]), [['A1', 2]]);
    markAttentionReminded(db, { attentionId: a1.attention_id, level: 2, at: '2026-11-09T08:00:00.000Z' });
    assert.equal(listDueAttentions(db, { now: '2026-11-09T08:00:00.000Z' }).length, 0);
  } finally { db.close(); }
});

test('attention：cancel / closeAttentionsForTicket / notified 记录', () => {
  const db = openDb(':memory:');
  try {
    const h = host(db);
    const t = workingTicket(db, h);
    const a = createAttention(db, {
      purpose: 'answer', ticketId: t.ticket_id, question: 'q', requiredConfirmerId: 'x',
    });
    const noted = markAttentionNotified(db, { attentionId: a.attention_id, chatId: 'chat-1', outboxId: 7 });
    assert.equal(noted.notified_chat_id, 'chat-1');
    assert.equal(noted.notified_outbox_id, 7);

    const cancelled = cancelAttention(db, { attentionId: a.attention_id, reason: 'test' });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(getAttention(db, a.attention_id)!.status, 'cancelled');

    const t2 = workingTicket(db, h);
    createAttention(db, {
      purpose: 'answer', ticketId: t2.ticket_id, question: 'q2', requiredConfirmerId: 'x',
    });
    assert.equal(closeAttentionsForTicket(db, { ticketId: t2.ticket_id, status: 'expired' }), 1);
  } finally { db.close(); }
});

test('executor：question Report 进 waiting_answer，human slot 定向恢复且不计 max_attempts', () => {
  const db = openDb(':memory:');
  try {
    const h = host(db);
    const t = workingTicket(db, h, 1);
    const aid = runningAssignmentId(db, t.ticket_id);
    appendReport(db, {
      assignmentId: aid,
      type: 'question',
      summary: '需要成本数',
      nextStep: '请提供 Q3 成本数',
    });
    assert.equal(getTicket(db, t.ticket_id)!.state, 'waiting_answer');
    endAssignment(db, { assignmentId: aid });

    const a = createAttention(db, {
      purpose: 'answer', ticketId: t.ticket_id, question: '成本数？', requiredConfirmerId: 'emp',
    });
    answerAttention(db, { attentionId: a.attention_id, action: 'answer', text: '12 万', answeredBy: 'emp' });

    // max_attempts=1：normal 已用掉 1 次；human 仍应能定向恢复。
    const human = claim(db, { hostId: h.host_id, slot: 'human', ticketId: t.ticket_id });
    assert.ok(human);
    assert.equal(human!.assignment.slot, 'human');
    assert.equal(human!.ticket.ticket_id, t.ticket_id);
    startAssignment(db, { assignmentId: human!.assignment.assignment_id, subagentId: 'agent-human' });
    assert.equal(getTicket(db, t.ticket_id)!.state, 'working');
  } finally { db.close(); }
});

test('executor：human 定向领取必须有 answered/rejected Attention', () => {
  const db = openDb(':memory:');
  try {
    const h = host(db);
    const t = workingTicket(db, h);
    const aid = runningAssignmentId(db, t.ticket_id);
    appendReport(db, { assignmentId: aid, type: 'question', summary: '需要信息' });
    endAssignment(db, { assignmentId: aid });
    assert.throws(() => claim(db, { hostId: h.host_id, slot: 'human', ticketId: t.ticket_id }), /answered\/rejected/);
  } finally { db.close(); }
});

test('executor：closeTicket / expireTickets 收口 open Attention', () => {
  const db = openDb(':memory:');
  try {
    const h = host(db);
    const t = workingTicket(db, h);
    const a = createAttention(db, {
      purpose: 'answer', ticketId: t.ticket_id, question: 'q', requiredConfirmerId: 'emp',
    });
    closeTicket(db, { ticketId: t.ticket_id, decision: 'cancelled' });
    assert.equal(getAttention(db, a.attention_id)!.status, 'cancelled');

    const t2 = workingTicket(db, h);
    const a2 = createAttention(db, {
      purpose: 'answer', ticketId: t2.ticket_id, question: 'q2', requiredConfirmerId: 'emp',
    });
    db.prepare('UPDATE tickets SET expires_at = ? WHERE ticket_id = ?').run('2026-01-01T00:00:00.000Z', t2.ticket_id);
    expireTickets(db, { now: '2026-01-02T00:00:00.000Z' });
    assert.equal(getTicket(db, t2.ticket_id)!.state, 'failed');
    assert.equal(getAttention(db, a2.attention_id)!.status, 'expired');
  } finally { db.close(); }
});
