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

// GAP-079 / DEV-02（2026-11-10）：补丁把引用文本注入消息前缀的 quote= 字段，Main 原样传给
// `--quote-text`。验收场景：用户引用一条带 A12 的通知，只回「可以」（正文不带短号）→ 命中。
test('attention match：正文无短号时用引用文本兜底（真实通知文案形状）', () => {
  const db = openDb(':memory:');
  try {
    seed(db);
    const a = createAttention(db, {
      purpose: 'review', question: '可以提交吗？', requiredConfirmerId: 'emp', originChatId: 'chat-emp',
    });
    // 与 buildAttentionText 的 ask 文案一致（短号在【】里，补丁不去这类括号，靠正则边界识别）
    const notice = `【${a.short_code}】${a.question}\n回复 @公司bot ${a.short_code} 可以 / 不行 <原因>。`;
    const quoted = matchAttention(db, { chatId: 'chat-emp', userid: 'uid-emp', text: '可以', quoteText: notice });
    assert.equal(quoted.reason, 'ok');
    assert.equal(quoted.code, a.short_code);
    assert.equal(quoted.ambiguous, false);
    assert.equal(quoted.matches.length, 1);
    assert.equal(quoted.matches[0].attention.attention_id, a.attention_id);
    assert.equal(quoted.matches[0].allowed, true);
    assert.deepEqual(quoted.matches[0].allowed_actions, ['approve', 'reject']);
  } finally { db.close(); }
});

test('attention match：正文短号优先于引用短号；两边都无短号且无候选 → not-found', () => {
  const db = openDb(':memory:');
  try {
    seed(db);
    createAttention(db, {
      purpose: 'answer', question: 'q1', requiredConfirmerId: 'emp', originChatId: 'chat-emp',
    }); // A1
    // 正文写了一个不存在的短号：按「正文优先」返回 not-found，不偷偷回退到引用里的 A1
    const wrong = matchAttention(db, {
      chatId: 'chat-emp', userid: 'uid-emp', text: 'A99 可以', quoteText: '【A1】有一条待确认',
    });
    assert.equal(wrong.reason, 'not-found');
    assert.equal(wrong.code, 'A99');
    assert.equal(wrong.matches.length, 0);

    // 正文、引用都没有短号；当前人在当前群又没有唯一 open → not-found（不能猜）
    const empty = matchAttention(db, {
      chatId: 'chat-company', userid: 'uid-emp', text: '可以', quoteText: '这条引用里没有短号',
    });
    assert.equal(empty.reason, 'not-found');
    assert.equal(empty.code, null);
    assert.equal(empty.ambiguous, false);
    assert.equal(empty.matches.length, 0);
  } finally { db.close(); }
});
