import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../core/index.ts';
import * as identity from '../../modules/identity/index.ts';
import { createAttention } from '../../modules/executor/index.ts';
import { extractShortCode, matchAttention } from './attention-match.ts';

type Db = ReturnType<typeof openDb>;

function seed(db: Db): void {
  identity.upsertPerson(db, { personId: 'boss', name: '老板', userid: 'uid-boss', systemRole: 'boss' });
  identity.upsertPerson(db, { personId: 'mgr', name: '管理者', userid: 'uid-mgr', systemRole: 'manager', deptId: 'sales' });
  identity.upsertPerson(db, { personId: 'emp', name: '员工', userid: 'uid-emp', systemRole: 'employee', deptId: 'sales' });
  identity.upsertGroup(db, { chatId: 'chat-emp', type: 'employee', employeeId: 'emp' });
  identity.upsertGroup(db, { chatId: 'chat-boss', type: 'boss_dm' });
  identity.upsertGroup(db, { chatId: 'chat-company', type: 'company' });
  db.prepare("INSERT INTO manager_scopes (person_id, dept_id, created_at) VALUES ('mgr', 'sales', ?)")
    .run(new Date().toISOString());
}

test('attention match：短号命中，确认人可执行；管理者不代确认', () => {
  const db = openDb(':memory:');
  try {
    seed(db);
    const a = createAttention(db, {
      purpose: 'answer', question: '成本数？', requiredConfirmerId: 'emp', originChatId: 'chat-emp',
    });
    const ok = matchAttention(db, { chatId: 'chat-emp', userid: 'uid-emp', text: 'A1 成本 12 万' });
    assert.equal(ok.reason, 'ok');
    assert.equal(ok.ambiguous, false);
    assert.equal(ok.matches.length, 1);
    assert.equal(ok.matches[0].attention.short_code, a.short_code);
    assert.equal(ok.matches[0].allowed, true);
    assert.deepEqual(ok.matches[0].allowed_actions, ['answer']);

    const mgr = matchAttention(db, { chatId: 'chat-emp', userid: 'uid-mgr', text: 'A1 可以' });
    assert.equal(mgr.matches[0].allowed, false);
    assert.equal(mgr.matches[0].reason, 'not-confirmer');
    assert.deepEqual(mgr.matches[0].allowed_actions, []);

    const otherChat = matchAttention(db, { chatId: 'chat-boss', userid: 'uid-emp', text: 'A1 可以' });
    assert.equal(otherChat.matches[0].allowed, false);
    assert.equal(otherChat.matches[0].reason, 'not-in-chat');
  } finally { db.close(); }
});

test('attention match：老板可代确认；引用文本里的短号也认', () => {
  const db = openDb(':memory:');
  try {
    seed(db);
    createAttention(db, {
      purpose: 'review', question: '可以提交吗？', requiredConfirmerId: 'emp', originChatId: 'chat-emp',
    });
    const boss = matchAttention(db, { chatId: 'chat-boss', userid: 'uid-boss', text: 'A1 可以' });
    assert.equal(boss.matches[0].allowed, true);
    assert.deepEqual(boss.matches[0].allowed_actions, ['approve', 'reject']);

    const quoted = matchAttention(db, {
      chatId: 'chat-emp', userid: 'uid-emp', text: '可以', quoteText: 'A1 待确认：可以提交吗？',
    });
    assert.equal(quoted.code, 'A1');
    assert.equal(quoted.matches[0].allowed, true);
  } finally { db.close(); }
});

test('attention match：没有短号时只认当前人当前群唯一 open；多条不猜', () => {
  const db = openDb(':memory:');
  try {
    seed(db);
    const a1 = createAttention(db, {
      purpose: 'answer', question: 'q1', requiredConfirmerId: 'emp', originChatId: 'chat-emp',
    });
    const one = matchAttention(db, { chatId: 'chat-emp', userid: 'uid-emp', text: '可以' });
    assert.equal(one.ambiguous, false);
    assert.equal(one.matches[0].attention.attention_id, a1.attention_id);

    createAttention(db, {
      purpose: 'answer', question: 'q2', requiredConfirmerId: 'emp', originChatId: 'chat-emp',
    });
    const many = matchAttention(db, { chatId: 'chat-emp', userid: 'uid-emp', text: '可以' });
    assert.equal(many.ambiguous, true);
    assert.equal(many.matches.length, 2);
  } finally { db.close(); }
});

test('attention match：未知的人 / 找不到 / SA12 不误判', () => {
  const db = openDb(':memory:');
  try {
    seed(db);
    const unknown = matchAttention(db, { chatId: 'chat-emp', userid: 'nobody', text: 'A1' });
    assert.equal(unknown.reason, 'unknown-actor');
    assert.equal(extractShortCode('SA12 可以'), null);
    assert.equal(extractShortCode('见 A12'), 'A12');
    assert.equal(extractShortCode('a7可以'), 'A7');

    const none = matchAttention(db, { chatId: 'chat-emp', userid: 'uid-emp', text: 'A99' });
    assert.equal(none.reason, 'not-found');
  } finally { db.close(); }
});
