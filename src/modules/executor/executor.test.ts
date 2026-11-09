import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../core/index.ts';
import {
  appendReport,
  claim,
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
      taskDir: 'departments/sales/tasks/t-1',
    });
    assert.equal(t.state, 'queued');

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
      evidence: ['departments/sales/tasks/t-1/out.md'],
    });
    assert.equal(r.type, 'ready');
    assert.equal(getTicket(db, t.ticket_id)!.state, 'waiting_review');
    assert.equal(getTicket(db, t.ticket_id)!.latest_report_id, r.report_id);

    const ended = endAssignment(db, { assignmentId: c!.assignment.assignment_id });
    assert.equal(ended.state, 'ended');
    assert.equal(getHost(db, h.host_id)!.status, 'active');
  } finally { db.close(); }
});

test('executor：一个 Ticket 只能有一个 active Assignment', () => {
  const db = openDb(':memory:');
  try {
    seedTask(db);
    const h = host(db);
    createTicket(db, { taskId: 1, departmentId: 'sales', title: 't', taskDir: 'departments/sales/tasks/t-1' });
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
      createTicket(db, { taskId: i + 1, departmentId: 'sales', title: 't' + i, taskDir: `departments/sales/tasks/t-${i}` });
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
    const t1 = createTicket(db, { taskId: 1, departmentId: 'sales', title: 'old', taskDir: 'departments/sales/tasks/t-1' });
    const a1 = claim(db, { hostId: h1.host_id })!;
    startAssignment(db, { assignmentId: a1.assignment.assignment_id, subagentId: 'agent-old' });

    const h2 = cutHost(db, { oldHostId: h1.host_id, newConversationId: 'conv-2026-11-10', businessDate: '2026-11-10' });
    assert.equal(getHost(db, h1.host_id)!.status, 'closing');
    assert.equal(getHost(db, h1.host_id)!.accepting_new, 0);
    assert.equal(h2.status, 'active');
    assert.equal(getTicket(db, t1.ticket_id)!.state, 'working');
    assert.equal(closeHostIfIdle(db, h1.host_id), false);

    const t2 = createTicket(db, { taskId: 2, departmentId: 'ops', title: 'new', taskDir: 'departments/ops/tasks/t-2' });
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
    createTicket(db, { taskId: 1, departmentId: 'sales', title: 't', taskDir: 'departments/sales/tasks/t-1' });
    const a = claim(db, { hostId: h.host_id })!;
    startAssignment(db, { assignmentId: a.assignment.assignment_id, subagentId: 'agent-1' });
    const i = interruptAssignment(db, { assignmentId: a.assignment.assignment_id, reason: 'host-cut' });
    assert.equal(i.state, 'interrupted');
    assert.equal(getTicket(db, a.ticket.ticket_id)!.state, 'queued');
    assert.ok(claim(db, { hostId: h.host_id }));
  } finally { db.close(); }
});
