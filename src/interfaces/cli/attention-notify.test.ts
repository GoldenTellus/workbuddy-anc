import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setConfig } from '../../core/index.ts';
import * as identity from '../../modules/identity/index.ts';
import * as executor from '../../modules/executor/index.ts';
import { enqueue } from '../../modules/delivery/index.ts';
import {
  buildAttentionText,
  notifyAttentionAsk,
  resolveAttentionTarget,
  sendAttentionNotice,
} from './attention-notify.ts';

type Db = ReturnType<typeof openDb>;

function seed(db: Db): number {
  identity.upsertPerson(db, { personId: 'boss', name: '老板', userid: 'uid-boss', systemRole: 'boss' });
  identity.upsertPerson(db, { personId: 'mgr', name: '管理者', userid: 'uid-mgr', systemRole: 'manager', deptId: 'sales' });
  identity.upsertPerson(db, { personId: 'emp', name: '员工', userid: 'uid-emp', systemRole: 'employee', deptId: 'sales' });
  identity.upsertPerson(db, { personId: 'req', name: '交办人', userid: 'uid-req', systemRole: 'employee', deptId: 'sales' });
  identity.upsertGroup(db, { chatId: 'chat-emp', type: 'employee', employeeId: 'emp' });
  identity.upsertGroup(db, { chatId: 'chat-mgr', type: 'employee', employeeId: 'mgr' });
  identity.upsertGroup(db, { chatId: 'chat-req', type: 'employee', employeeId: 'req' });
  identity.upsertGroup(db, { chatId: 'chat-boss', type: 'boss_dm' });
  identity.upsertGroup(db, { chatId: 'chat-company', type: 'company' });
  db.prepare("INSERT INTO manager_scopes (person_id, dept_id, created_at) VALUES ('mgr', 'sales', ?)")
    .run(new Date().toISOString());
  const now = new Date().toISOString();
  const r = db.prepare("INSERT INTO tasks (title, status, requester_id, created_at, updated_at) VALUES ('测试', 'open', 'req', ?, ?)")
    .run(now, now);
  return Number(r.lastInsertRowid);
}

function outbox(db: Db, id: number) {
  return db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as {
    chat_id: string; payload: string; attention_id: string | null; next_attempt_at: string; created_at: string;
  };
}

test('attention notify：answer 走私密员工群，带问题正文和短号，并回写 notified', () => {
  const db = openDb(':memory:');
  try {
    seed(db);
    const a = executor.createAttention(db, {
      purpose: 'answer', question: '成本数是多少？', requiredConfirmerId: 'emp', originChatId: 'chat-company',
    });
    const r = notifyAttentionAsk(db, a);
    assert.equal(r.sent, true);
    assert.equal(r.reason, 'sent');
    assert.equal(r.target?.chat_id, 'chat-emp');
    assert.equal(r.target?.neutral, false);
    const row = outbox(db, r.outbox_id!);
    assert.equal(row.chat_id, 'chat-emp');
    assert.equal(row.attention_id, a.attention_id);
    const text = JSON.parse(row.payload).text as string;
    assert.match(text, /A1/);
    assert.match(text, /成本数是多少/);
    assert.equal(executor.getAttention(db, a.attention_id)!.notified_chat_id, 'chat-emp');
    assert.equal(executor.getAttention(db, a.attention_id)!.notified_outbox_id, r.outbox_id);
  } finally { db.close(); }
});

test('attention notify：review 找交办人；交办人停用后落老板', () => {
  const db = openDb(':memory:');
  try {
    const taskId = seed(db);
    const a = executor.createAttention(db, {
      purpose: 'review', taskId, question: '可以提交吗？', requiredConfirmerId: 'boss', originChatId: 'chat-company',
    });
    const r = sendAttentionNotice(db, a, 'ask');
    assert.equal(r.target?.person_id, 'req');
    assert.equal(r.target?.chat_id, 'chat-req');

    identity.upsertPerson(db, { personId: 'req', name: '交办人', userid: 'uid-req', systemRole: 'employee', deptId: 'sales', status: 'disabled' });
    const fallback = resolveAttentionTarget(db, a, 'ask');
    assert.equal(fallback?.person_id, 'boss');
    assert.equal(fallback?.chat_id, 'chat-boss');
  } finally { db.close(); }
});

test('attention notify：没有私密渠道时回原群，只发中性短号，不带正文', () => {
  const db = openDb(':memory:');
  try {
    seed(db);
    identity.upsertPerson(db, { personId: 'emp2', name: '无群员工', userid: 'uid-emp2', systemRole: 'employee', deptId: 'sales' });
    const a = executor.createAttention(db, {
      purpose: 'answer', question: '这是内部问题，不能贴群', requiredConfirmerId: 'emp2', originChatId: 'chat-company',
    });
    const r = sendAttentionNotice(db, a, 'ask');
    assert.equal(r.target?.mode, 'origin');
    assert.equal(r.target?.neutral, true);
    const text = buildAttentionText(db, a, 'ask', r.target!);
    assert.match(text, /A1/);
    assert.doesNotMatch(text, /内部问题/);
  } finally { db.close(); }
});

test('attention notify：8h 找部门管理者，24h 找老板', () => {
  const db = openDb(':memory:');
  try {
    seed(db);
    const a = executor.createAttention(db, {
      purpose: 'answer', question: '成本数？', requiredConfirmerId: 'emp', originChatId: 'chat-company',
    });
    const mgr = resolveAttentionTarget(db, a, 'manager');
    assert.equal(mgr?.person_id, 'mgr');
    assert.equal(mgr?.chat_id, 'chat-mgr');
    assert.match(buildAttentionText(db, a, 'manager', mgr!), /催办/);

    const boss = resolveAttentionTarget(db, a, 'boss');
    assert.equal(boss?.person_id, 'boss');
    assert.equal(boss?.chat_id, 'chat-boss');
    assert.match(buildAttentionText(db, a, 'boss', boss!), /升级/);
  } finally { db.close(); }
});

test('attention notify：静默时段顺延到 08:00；每日上限生效', () => {
  const db = openDb(':memory:');
  try {
    seed(db);
    setConfig(db, 'notify_quiet_start', '22:00');
    setConfig(db, 'notify_quiet_end', '08:00');
    const a = executor.createAttention(db, {
      purpose: 'answer', question: '成本数？', requiredConfirmerId: 'emp', originChatId: 'chat-company',
    });
    const quietNow = new Date();
    quietNow.setHours(23, 0, 0, 0);
    const r = sendAttentionNotice(db, a, 'ask', { now: quietNow.toISOString() });
    assert.equal(r.sent, true);
    const row = outbox(db, r.outbox_id!);
    const next = new Date(row.next_attempt_at);
    assert.equal(next.getHours(), 8);
    assert.ok(next.getTime() > quietNow.getTime());

    setConfig(db, 'notify_daily_cap', '1');
    enqueue(db, { text: '占位', chatId: 'chat-emp', dedupeKey: 'cap-test' });
    const capped = sendAttentionNotice(db, a, 'remind');
    assert.equal(capped.sent, false);
    assert.equal(capped.reason, 'daily-cap');
  } finally { db.close(); }
});
