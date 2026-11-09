import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../core/index.ts';
import {
  upsertGroup,
  upsertPerson,
} from '../../modules/identity/index.ts';
import {
  acceptTaskRequest,
  approveTaskRequest,
  createTaskRequest,
  rejectTaskRequest,
} from '../../modules/tasks/index.ts';
import { listOutbox } from '../../modules/delivery/index.ts';
import { notifyTaskEvent } from './task-notify.ts';

function seed(db: ReturnType<typeof openDb>) {
  upsertPerson(db, { personId: 'emp', name: '员工', userid: 'u-emp', systemRole: 'employee', deptId: 'sales' });
  upsertPerson(db, { personId: 'emp2', name: '同事', userid: 'u-emp2', systemRole: 'employee', deptId: 'sales' });
  upsertPerson(db, { personId: 'mgr', name: '经理', userid: 'u-mgr', systemRole: 'manager', deptId: 'sales' });
  upsertGroup(db, { chatId: 'c-emp', type: 'employee', employeeId: 'emp', webhookFile: 'hook-emp.txt' });
  upsertGroup(db, { chatId: 'c-emp2', type: 'employee', employeeId: 'emp2', webhookFile: 'hook-emp2.txt' });
  upsertGroup(db, { chatId: 'c-mgr', type: 'employee', employeeId: 'mgr', webhookFile: 'hook-mgr.txt' });
  db.prepare('INSERT INTO manager_scopes (person_id, dept_id, created_at) VALUES (?, ?, ?)')
    .run('mgr', 'sales', new Date().toISOString());
}

function clear(db: ReturnType<typeof openDb>) {
  db.prepare('DELETE FROM outbox').run();
}

function messages(db: ReturnType<typeof openDb>) {
  return listOutbox(db, { status: 'pending' }).map((m) => ({
    chat: m.chat_id,
    text: (JSON.parse(m.payload) as { text: string }).text,
    mentions: (JSON.parse(m.payload) as { mentions: string[] }).mentions,
  }));
}

test('notifyTaskEvent：同部门请求通知执行人', () => {
  const db = openDb(':memory:');
  try {
    seed(db);
    const t = createTaskRequest(db, {
      title: '看报价', requesterId: 'emp', assigneeId: 'emp2', deptId: 'sales', requiresApproval: false,
    });
    const r = notifyTaskEvent(db, t, 'requested');
    assert.equal(r.sent, 1);
    const m = messages(db);
    assert.equal(m.length, 1);
    assert.equal(m[0].chat, 'c-emp2');
    assert.deepEqual(m[0].mentions, ['u-emp2']);
    assert.match(m[0].text, /接受 #/);
  } finally { db.close(); }
});

test('notifyTaskEvent：跨部门请求通知执行人部门管理者；批准后通知执行人', () => {
  const db = openDb(':memory:');
  try {
    seed(db);
    const t = createTaskRequest(db, {
      title: '跨部门报价', requesterId: 'emp', assigneeId: 'emp2', deptId: 'sales', requiresApproval: true,
    });
    const requested = notifyTaskEvent(db, t, 'requested');
    assert.equal(requested.sent, 1);
    assert.equal(messages(db)[0].chat, 'c-mgr');
    assert.match(messages(db)[0].text, /审批/);

    clear(db);
    const approved = approveTaskRequest(db, t.id, 'mgr');
    const r = notifyTaskEvent(db, approved, 'approved');
    assert.equal(r.sent, 1);
    assert.equal(messages(db)[0].chat, 'c-emp2');
    assert.match(messages(db)[0].text, /已批准/);
  } finally { db.close(); }
});

test('notifyTaskEvent：优先用通讯录 mention_userid 真 @，没配才退回 userid', () => {
  const db = openDb(':memory:');
  try {
    seed(db);
    upsertPerson(db, {
      personId: 'emp2', name: '同事', userid: 'u-emp2', mentionUserid: 'zhangsan-real', systemRole: 'employee', deptId: 'sales',
    });
    const t = createTaskRequest(db, {
      title: '看报价', requesterId: 'emp', assigneeId: 'emp2', deptId: 'sales', requiresApproval: false,
    });
    const r = notifyTaskEvent(db, t, 'requested');
    assert.equal(r.sent, 1);
    assert.deepEqual(messages(db)[0].mentions, ['zhangsan-real']);
  } finally { db.close(); }
});

test('notifyTaskEvent：接受通知交办人；拒绝带原因通知交办人', () => {
  const db = openDb(':memory:');
  try {
    seed(db);
    const t = createTaskRequest(db, {
      title: '同部门请求', requesterId: 'emp', assigneeId: 'emp2', deptId: 'sales', requiresApproval: false,
    });
    notifyTaskEvent(db, t, 'requested');
    clear(db);
    const accepted = acceptTaskRequest(db, t.id, 'emp2');
    assert.equal(notifyTaskEvent(db, accepted, 'accepted').sent, 1);
    assert.equal(messages(db)[0].chat, 'c-emp');
    assert.match(messages(db)[0].text, /已接受/);

    clear(db);
    const t2 = createTaskRequest(db, {
      title: '拒绝测试', requesterId: 'emp', assigneeId: 'emp2', deptId: 'sales', requiresApproval: false,
    });
    const rejected = rejectTaskRequest(db, t2.id, 'emp2', '没空');
    assert.equal(notifyTaskEvent(db, rejected, 'rejected').sent, 1);
    assert.equal(messages(db)[0].chat, 'c-emp');
    assert.match(messages(db)[0].text, /没空/);
  } finally { db.close(); }
});
