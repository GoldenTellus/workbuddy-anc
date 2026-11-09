import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../core/index.ts';
import {
  appendReport,
  claim,
  bootstrapHost,
  recoverHost,
  listExecutorEvents,
  listEvaluations,
  recordEvaluation,
  sweepStaleAssignments,
  deferCutIfDue,
  closeHostIfIdle,
  createHost,
  createTicket,
  cutHost,
  endAssignment,
  getHost,
  getTicket,
  interruptAssignment,
  startAssignment,
} from './executor.ts';

function seedTask(db: ReturnType<typeof openDb>, n = 1): void {
  const now = new Date().toISOString();
  while (n-- > 0) {
    db.prepare("INSERT INTO tasks (title,status,created_at,updated_at) VALUES (?, 'open', ?, ?)")
      .run('test-task-' + n, now, now);
  }
}

function host(db: ReturnType<typeof openDb>, date = '2026-11-09') {
  return createHost(db, {
    conversationId: 'conv-' + date,
    businessDate: date,
    cutAt: date + 'T19:00:00.000Z',
  });
}

test('executor：host/ticket/assignment/report 生命周期', () => {
  const db = openDb(':memory:');
  try {
    seedTask(db);
    const h = host(db);
    assert.equal(h.status, 'active');
    const t = createTicket(db, {
      taskId: 1,
      departmentId: 'sales',
      title: '整理报价',
    });
    assert.equal(t.state, 'queued');
    assert.equal(t.task_dir, `departments/sales/tasks/${t.ticket_id}`);

    const c = claim(db, { hostId: h.host_id });
    assert.ok(c);
    assert.equal(c!.assignment.state, 'pending');
    assert.equal(c!.ticket.state, 'queued');

    const started = startAssignment(db, { assignmentId: c!.assignment.assignment_id, subagentId: 'agent-1' });
    assert.equal(started.state, 'running');
    assert.equal(getTicket(db, t.ticket_id)!.state, 'working');

    const r = appendReport(db, {
      assignmentId: c!.assignment.assignment_id,
      type: 'ready',
      summary: 'done',
      evidence: [t.task_dir + '/out.md'],
    });
    assert.equal(r.type, 'ready');
    assert.equal(getTicket(db, t.ticket_id)!.state, 'waiting_review');
    assert.equal(getTicket(db, t.ticket_id)!.latest_report_id, r.report_id);

    const ended = endAssignment(db, { assignmentId: c!.assignment.assignment_id });
    assert.equal(ended.state, 'ended');
    assert.equal(getHost(db, h.host_id)!.status, 'active');
    const kinds = listExecutorEvents(db, { ticketId: t.ticket_id, limit: 20 }).map((e) => e.kind);
    for (const k of ['ticket_created', 'assignment_claimed', 'assignment_started', 'report_appended', 'assignment_ended']) {
      assert.equal(kinds.includes(k), true, '缺事件 ' + k);
    }
  } finally { db.close(); }
});

test('executor：一个 Ticket 只能有一个 active Assignment', () => {
  const db = openDb(':memory:');
  try {
    seedTask(db);
    const h = host(db);
    createTicket(db, { taskId: 1, departmentId: 'sales', title: 't' });
    const a = claim(db, { hostId: h.host_id })!;
    assert.ok(a);
    assert.equal(claim(db, { hostId: h.host_id }), null);
    assert.throws(
      () => db.prepare("INSERT INTO assignments (assignment_id,ticket_id,host_id,department_id,task_dir,slot,state,attempt,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run('a-dup', a.ticket.ticket_id, h.host_id, 'sales', a.assignment.task_dir, 'normal', 'pending', 1, new Date().toISOString()),
      /UNIQUE constraint failed/,
    );
  } finally { db.close(); }
});

test('executor：normal slot 上限为 4，human slot 不接新任务', () => {
  const db = openDb(':memory:');
  try {
    seedTask(db, 5);
    const h = host(db);
    for (let i = 0; i < 5; i++) {
      createTicket(db, { taskId: i + 1, departmentId: 'sales', title: 't' + i });
    }
    for (let i = 0; i < 4; i++) assert.ok(claim(db, { hostId: h.host_id }));
    assert.equal(claim(db, { hostId: h.host_id }), null);
    assert.equal(claim(db, { hostId: h.host_id, slot: 'human' }), null);
  } finally { db.close(); }
});

test('executor：03:00 host 日切，旧 assignment 不迁移，新 host 只接新任务', () => {
  const db = openDb(':memory:');
  try {
    seedTask(db, 2);
    const h1 = host(db, '2026-11-09');
    const t1 = createTicket(db, { taskId: 1, departmentId: 'sales', title: 'old' });
    const a1 = claim(db, { hostId: h1.host_id })!;
    startAssignment(db, { assignmentId: a1.assignment.assignment_id, subagentId: 'agent-old' });

    const h2 = cutHost(db, { oldHostId: h1.host_id, newConversationId: 'conv-2026-11-10', businessDate: '2026-11-10' });
    assert.equal(getHost(db, h1.host_id)!.status, 'closing');
    assert.equal(getHost(db, h1.host_id)!.accepting_new, 0);
    assert.equal(h2.status, 'active');
    assert.equal(getTicket(db, t1.ticket_id)!.state, 'working');
    assert.equal(closeHostIfIdle(db, h1.host_id), false);

    const t2 = createTicket(db, { taskId: 2, departmentId: 'ops', title: 'new' });
    const a2 = claim(db, { hostId: h2.host_id })!;
    assert.equal(a2.ticket.ticket_id, t2.ticket_id);
    assert.throws(() => claim(db, { hostId: h1.host_id }), /host 不在接单状态/);

    endAssignment(db, { assignmentId: a1.assignment.assignment_id });
    assert.equal(closeHostIfIdle(db, h1.host_id), true);
  } finally { db.close(); }
});

test('executor：interrupted 后 Ticket 回 queued，可重新派', () => {
  const db = openDb(':memory:');
  try {
    seedTask(db);
    const h = host(db);
    createTicket(db, { taskId: 1, departmentId: 'sales', title: 't' });
    const a = claim(db, { hostId: h.host_id })!;
    startAssignment(db, { assignmentId: a.assignment.assignment_id, subagentId: 'agent-1' });
    const i = interruptAssignment(db, { assignmentId: a.assignment.assignment_id, reason: 'host-cut' });
    assert.equal(i.state, 'interrupted');
    assert.equal(getTicket(db, a.ticket.ticket_id)!.state, 'queued');
    assert.ok(claim(db, { hostId: h.host_id }));
  } finally { db.close(); }
});
test('executor：bootstrapHost 同日幂等、跨日自动切、不同对话拒绝', () => {
  const db = openDb(':memory:');
  try {
    const a = bootstrapHost(db, { conversationId: 'conv-a', businessDate: '2026-11-09', cutAt: '2026-11-10T03:00:00+08:00' });
    const again = bootstrapHost(db, { conversationId: 'conv-a', businessDate: '2026-11-09', cutAt: '2026-11-10T03:00:00+08:00' });
    assert.equal(again.host_id, a.host_id);
    const b = bootstrapHost(db, { conversationId: 'conv-b', businessDate: '2026-11-10', cutAt: '2026-11-11T03:00:00+08:00' });
    assert.notEqual(b.host_id, a.host_id);
    assert.equal(getHost(db, a.host_id)!.status, 'closing');
    assert.throws(
      () => bootstrapHost(db, { conversationId: 'conv-c', businessDate: '2026-11-10', cutAt: '2026-11-11T03:00:00+08:00' }),
      /已有 active host/,
    );
  } finally { db.close(); }
});
test('executor：03:00 无新 host 时 deferred，旧 host 继续接单', () => {
  const db = openDb(':memory:');
  try {
    seedTask(db, 2);
    const h = createHost(db, { conversationId: 'conv-old', businessDate: '2026-11-09', cutAt: '2026-11-09T00:00:00.000Z' });
    const t = createTicket(db, { taskId: 1, departmentId: 'sales', title: 'old' });
    assert.ok(claim(db, { hostId: h.host_id }));
    const r = deferCutIfDue(db, '2026-11-10T03:00:00+08:00');
    assert.equal(r.deferred, true);
    assert.equal(getHost(db, h.host_id)!.status, 'active');
    assert.equal(getHost(db, h.host_id)!.cut_deferred, 1);
    // 兜底期间旧 host 仍能接新 Ticket
    createTicket(db, { taskId: 2, departmentId: 'ops', title: 'new' });
    assert.ok(claim(db, { hostId: h.host_id }));
    // 新对话出现后，bootstrap 仍然切 host
    const next = bootstrapHost(db, { conversationId: 'conv-new', businessDate: '2026-11-10', cutAt: '2026-11-11T03:00:00+08:00' });
    assert.equal(next.status, 'active');
    assert.equal(getHost(db, h.host_id)!.status, 'closing');
  } finally { db.close(); }
});
test('executor：task_dir 必须由部门 + ticket_id 推导，拒绝跨部门/穿越/自定义', () => {
  const db = openDb(':memory:');
  try {
    seedTask(db);
    const t = createTicket(db, { taskId: 1, departmentId: 'sales', title: 'path', });
    assert.equal(t.task_dir, `departments/sales/tasks/${t.ticket_id}`);
    assert.throws(
      () => createTicket(db, { taskId: 1, departmentId: 'sales', title: 'x', taskDir: 'departments/ops/tasks/t-x' }),
      /task_dir 必须是/,
    );
    assert.throws(
      () => createTicket(db, { taskId: 1, departmentId: 'sales', title: 'x', taskDir: 'departments/sales/tasks/../ops' }),
      /task_dir 必须是/,
    );
    assert.throws(
      () => createTicket(db, { taskId: 1, departmentId: 'sales', title: 'x', taskDir: 'departments/sales/tasks/t-custom' }),
      /task_dir 必须是/,
    );
  } finally { db.close(); }
});
test('executor：旧 Assignment 的迟到 Report 只记录，不覆盖新 Assignment', () => {
  const db = openDb(':memory:');
  try {
    seedTask(db);
    const h = host(db);
    const t = createTicket(db, { taskId: 1, departmentId: 'sales', title: 'late', });
    const a1 = claim(db, { hostId: h.host_id })!;
    startAssignment(db, { assignmentId: a1.assignment.assignment_id, subagentId: 'agent-old' });
    interruptAssignment(db, { assignmentId: a1.assignment.assignment_id, reason: 'host-cut' });
    const a2 = claim(db, { hostId: h.host_id })!;
    startAssignment(db, { assignmentId: a2.assignment.assignment_id, subagentId: 'agent-new' });

    const late = appendReport(db, {
      assignmentId: a1.assignment.assignment_id,
      type: 'ready',
      summary: 'old finished late',
    });
    assert.equal(late.late, 1);
    assert.equal(getTicket(db, t.ticket_id)!.state, 'working');

    const fresh = appendReport(db, {
      assignmentId: a2.assignment.assignment_id,
      type: 'ready',
      summary: 'new finished',
    });
    assert.equal(fresh.late, 0);
    assert.equal(getTicket(db, t.ticket_id)!.state, 'waiting_review');
  } finally { db.close(); }
});
test('executor：recoverHost 将旧 host 的 running 统一 interrupted 并回 queued', () => {
  const db = openDb(':memory:');
  try {
    seedTask(db, 2);
    const h = host(db);
    const t = createTicket(db, { taskId: 1, departmentId: 'sales', title: 'recover', });
    const a = claim(db, { hostId: h.host_id })!;
    startAssignment(db, { assignmentId: a.assignment.assignment_id, subagentId: 'agent-old' });
    const r = recoverHost(db, { hostId: h.host_id, reason: 'process-restart' });
    assert.equal(r.recovered, 1);
    assert.equal(getHost(db, h.host_id)!.status, 'closed');
    assert.equal(getTicket(db, t.ticket_id)!.state, 'queued');
    assert.throws(() => claim(db, { hostId: h.host_id }), /host 不在接单状态/);
    // 新 host 可重新派同一 Ticket
    const h2 = bootstrapHost(db, { conversationId: 'conv-next', businessDate: '2026-11-10', cutAt: '2026-11-11T03:00:00+08:00' });
    assert.ok(claim(db, { hostId: h2.host_id }));
  } finally { db.close(); }
});
test('executor：队列按 P0 → 截止时间 → FIFO', () => {
  const db = openDb(':memory:');
  try {
    seedTask(db, 4);
    const h = host(db);
    const p2 = createTicket(db, { taskId: 1, departmentId: 'sales', title: 'p2', priority: 'P2', dueAt: '2026-11-10T00:00:00Z' });
    const p0late = createTicket(db, { taskId: 2, departmentId: 'sales', title: 'p0-late', priority: 'P0', dueAt: '2026-11-12T00:00:00Z' });
    const p0early = createTicket(db, { taskId: 3, departmentId: 'sales', title: 'p0-early', priority: 'P0', dueAt: '2026-11-11T00:00:00Z' });
    const p1 = createTicket(db, { taskId: 4, departmentId: 'sales', title: 'p1', priority: 'P1' });
    assert.equal(claim(db, { hostId: h.host_id })!.ticket.ticket_id, p0early.ticket_id);
    assert.equal(claim(db, { hostId: h.host_id })!.ticket.ticket_id, p0late.ticket_id);
    assert.equal(claim(db, { hostId: h.host_id })!.ticket.ticket_id, p1.ticket_id);
    assert.equal(claim(db, { hostId: h.host_id })!.ticket.ticket_id, p2.ticket_id);
  } finally { db.close(); }
});

test('executor：human slot 只接等待人工的 Ticket', () => {
  const db = openDb(':memory:');
  try {
    seedTask(db);
    const h = host(db);
    const t = createTicket(db, { taskId: 1, departmentId: 'sales', title: 'human', });
    const a = claim(db, { hostId: h.host_id })!;
    startAssignment(db, { assignmentId: a.assignment.assignment_id, subagentId: 'agent-1' });
    appendReport(db, { assignmentId: a.assignment.assignment_id, type: 'ready', summary: 'review me' });
    endAssignment(db, { assignmentId: a.assignment.assignment_id });
    assert.equal(claim(db, { hostId: h.host_id }), null);
    const human = claim(db, { hostId: h.host_id, slot: 'human' })!;
    assert.equal(human.ticket.ticket_id, t.ticket_id);
    assert.equal(human.assignment.slot, 'human');
  } finally { db.close(); }
});

test('executor：旧 host 超 grace 自动 sweep 中断并关闭', () => {
  const db = openDb(':memory:');
  try {
    seedTask(db, 2);
    const h1 = host(db, '2026-11-09');
    const t = createTicket(db, { taskId: 1, departmentId: 'sales', title: 'stale', });
    const a = claim(db, { hostId: h1.host_id })!;
    startAssignment(db, { assignmentId: a.assignment.assignment_id, subagentId: 'agent-old' });
    db.prepare("UPDATE assignments SET started_at = '2026-11-09T00:00:00.000Z' WHERE assignment_id = ?").run(a.assignment.assignment_id);
    cutHost(db, { oldHostId: h1.host_id, newConversationId: 'conv-new', businessDate: '2026-11-10' });
    const r = sweepStaleAssignments(db, { now: '2026-11-10T03:00:00+08:00', graceMinutes: 10 });
    assert.equal(r.interrupted, 1);
    assert.equal(r.hostsClosed, 1);
    assert.equal(getHost(db, h1.host_id)!.status, 'closed');
    assert.equal(getTicket(db, t.ticket_id)!.state, 'queued');
  } finally { db.close(); }
});
test('executor：Main 评估记录 accept/defer/ask/reject 可追溯', () => {
  const db = openDb(':memory:');
  try {
    seedTask(db);
    const e = recordEvaluation(db, { taskId: 1, decision: 'accept', reason: '有交付物且授权足够', priority: 'P1', ticketId: 't-eval' });
    assert.equal(e.decision, 'accept');
    assert.equal(e.priority, 'P1');
    const list = listEvaluations(db, { taskId: 1 });
    assert.equal(list.length, 1);
    assert.equal(list[0].evaluation_id, e.evaluation_id);
    assert.throws(
      () => recordEvaluation(db, { taskId: 1, decision: 'auto' as never, reason: 'x' }),
      /decision 必须是/,
    );
  } finally { db.close(); }
});
