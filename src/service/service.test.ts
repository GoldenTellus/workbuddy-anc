import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.ts';
import * as tasks from './tasks.ts';
import * as reminders from './reminders.ts';
import * as outbox from './outbox.ts';
import * as bindings from './bindings.ts';
import { scanOutbound, assertSafeOutbound } from './outbound-scan.ts';

function withDb(fn: (db: ReturnType<typeof openDb>) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'anc-svc-'));
  const db = openDb(join(dir, 'anc.db'));
  try { fn(db); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('绑定：bind → resolve → unbind', () => withDb((db) => {
  const r = bindings.bind(db, 'chat-A', '张三', '建群');
  assert.equal(r.action, 'created');
  assert.equal(bindings.resolve(db, 'chat-A')?.employee, '张三');
  assert.equal(bindings.listBindings(db).length, 1);
  assert.equal(bindings.unbind(db, 'chat-A'), 1);
  assert.equal(bindings.resolve(db, 'chat-A'), null);
}));

test('任务：完成与出站消息同事务，重复完成幂等', () => withDb((db) => {
  const t = tasks.createTask(db, { title: '写周报', chatId: 'chat-A', assignee: '张三', requester: '李四', dueAt: '2026-10-31T09:00:00+08:00' });
  const rem = reminders.scheduleReminder(db, { taskId: t.id, dueAt: '2026-10-31T09:00:00+08:00' });
  assert.equal(rem.status, 'pending');

  const r1 = tasks.completeTask(db, t.id, { text: `#${t.id} 已完成` });
  assert.equal(r1.task.status, 'done');
  assert.equal(r1.enqueued, true);
  assert.equal(outbox.listOutbox(db, { status: 'pending' }).length, 1);
  assert.equal(reminders.dueReminders(db, '2026-10-31T10:00:00+08:00').length, 0);

  const r2 = tasks.completeTask(db, t.id, { text: `#${t.id} 已完成` });
  assert.equal(r2.enqueued, false);
  assert.equal(outbox.listOutbox(db, { status: 'pending' }).length, 1);
}));

test('任务：取消后不能完成，提醒同步取消', () => withDb((db) => {
  const t = tasks.createTask(db, { title: '取消我' });
  reminders.scheduleReminder(db, { taskId: t.id, dueAt: '2026-10-31T09:00:00+08:00' });
  tasks.cancelTask(db, t.id);
  assert.equal(reminders.dueReminders(db, '2026-10-31T10:00:00+08:00').length, 0);
  assert.throws(() => tasks.completeTask(db, t.id, { text: 'x' }), /已取消/);
}));

test('提醒：同日重复，跨天停', () => withDb((db) => {
  const t = tasks.createTask(db, { title: '提醒测试' });
  reminders.scheduleReminder(db, { taskId: t.id, dueAt: '2026-10-31T09:00:00+08:00', repeatMinutes: 15 });
  const due = reminders.dueReminders(db, '2026-10-31T09:00:00+08:00');
  assert.equal(due.length, 1);
  const r = reminders.markReminderSent(db, due[0].id, '2026-10-31T09:00:05+08:00');
  assert.ok(r.next);
  assert.equal(r.next?.due_at, '2026-10-31T01:15:00.000Z');

  const late = tasks.createTask(db, { title: '跨天' });
  const rem2 = reminders.scheduleReminder(db, { taskId: late.id, dueAt: '2026-10-31T23:55:00+08:00', repeatMinutes: 15 });
  const r2 = reminders.markReminderSent(db, rem2.id, '2026-10-31T23:55:01+08:00');
  assert.equal(r2.next, null);
}));

test('outbox：去重与凭据拦截', () => withDb((db) => {
  const a = outbox.enqueue(db, { text: 'hi', dedupeKey: 'k1' });
  const b = outbox.enqueue(db, { text: 'hi again', dedupeKey: 'k1' });
  assert.equal(a.inserted, true);
  assert.equal(b.inserted, false);
  assert.throws(() => outbox.enqueue(db, { text: 'token: Bearer abcdefghijklmnop' }), /凭据/);
}));

test('outbox：@ 人写进 payload', () => withDb((db) => {
  const r = outbox.enqueue(db, { text: '到点提醒', mentions: ['user-1', 'user-2'] });
  assert.equal(r.inserted, true);
  const row = outbox.listOutbox(db, { status: 'pending' })[0];
  const payload = JSON.parse(row.payload) as { text: string; mentions: string[] };
  assert.deepEqual(payload.mentions, ['user-1', 'user-2']);
}));

test('出站扫描：命中即脱敏并给出规则名', () => {
  const s = scanOutbound('see sk-ABCDEFGHIJKLMNOPQRST and https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc-123');
  assert.equal(s.clean, false);
  assert.match(s.text, /\[REDACTED\]/);
  assert.ok(s.hits.includes('openai-style'));
  // 运行时拼接，避免仓库里出现形如赋值语句的字符串（check-public 的绊线）
  const fakeAssignment = 'app_secret' + ' = ' + 'hunter2';
  assert.throws(() => assertSafeOutbound(fakeAssignment), /凭据/);
});
