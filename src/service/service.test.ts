import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.ts';
import * as tasks from './tasks.ts';
import * as reminders from './reminders.ts';
import * as outbox from './outbox.ts';
import * as bindings from './bindings.ts';
import * as config from './config.ts';
import { scanOutbound, assertSafeOutbound } from './outbound-scan.ts';
import { tick as loopTick } from './loop.ts';

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

test('权限：非执行人/交办人不能完成', () => withDb((db) => {
  const t = tasks.createTask(db, { title: '权限测试', assigneeUserId: 'u1', requesterUserId: 'u2' });
  assert.throws(() => tasks.completeTask(db, t.id, { text: 'x' }, 'u3'), /只有执行人或交办人/);
  assert.throws(() => tasks.completeTask(db, t.id, { text: 'x' }), /只有执行人或交办人/);
  const r = tasks.completeTask(db, t.id, { text: 'x' }, 'u1');
  assert.equal(r.task.status, 'done');
}));

test('outbox：失败后退避，不在到点前重发', () => withDb((db) => {
  const q = outbox.enqueue(db, { text: '退避测试', dedupeKey: 'b1' });
  outbox.markFailed(db, q.id!, 'boom');
  const row = outbox.listOutbox(db, { status: 'pending' })[0];
  assert.equal(row.attempts, 1);
  assert.equal(outbox.listPendingDue(db, new Date(Date.now() - 5_000).toISOString()).length, 0);
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

test('循环：到期提醒入队、@ 绑定人并发送一次', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-loop-'));
  const db = openDb(join(dir, 'anc.db'));
  try {
    bindings.bind(db, 'chat-A', '张三', undefined, 'user-zhang');
    const t = tasks.createTask(db, { title: '写周报', chatId: 'chat-A' });
    reminders.scheduleReminder(db, { taskId: t.id, dueAt: '2026-10-31T09:00:00+08:00' });

    const calls: Array<{ text: string; mentions: string[] }> = [];
    const send = async (_url: string, text: string, mentions: string[]) => { calls.push({ text, mentions }); };

    const hookFile = join(dir, 'webhook.txt');
    writeFileSync(hookFile, 'https://example.invalid/hook\n', 'utf8');
    const r = await loopTick(db, { now: '2026-10-31T09:00:10+08:00', webhookFile: hookFile, send });
    assert.equal(r.enqueued, 1);
    assert.equal(r.sent, 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].mentions, ['user-zhang']);
    assert.match(calls[0].text, /到点提醒：#1 写周报/);
    assert.equal(outbox.listOutbox(db, { status: 'pending' }).length, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('循环：任务已完成时跳过并取消提醒', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-loop-'));
  const db = openDb(join(dir, 'anc.db'));
  try {
    const t = tasks.createTask(db, { title: '已完成的活', chatId: 'chat-A' });
    reminders.scheduleReminder(db, { taskId: t.id, dueAt: '2026-10-31T09:00:00+08:00' });
    tasks.completeTask(db, t.id, { text: 'done' });
    // 模拟一条漏网的 pending（正常路径下完成时已被取消）
    db.prepare("UPDATE reminders SET status = 'pending' WHERE task_id = ?").run(t.id);

    const r = await loopTick(db, { now: '2026-10-31T09:00:10+08:00' });
    assert.equal(r.skipped, 1);
    assert.equal(r.enqueued, 0);
    const rows = db.prepare('SELECT status FROM reminders WHERE task_id = ?').all(t.id) as Array<{ status: string }>;
    assert.ok(rows.every((x) => x.status !== 'pending'));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('升级：第 4 次提醒后通知交办人，之后每小时', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-esc-'));
  const db = openDb(join(dir, 'anc.db'));
  try {
    bindings.bind(db, 'chat-A', '张三', undefined, 'u-zhang');
    const t = tasks.createTask(db, { title: '催办测试', chatId: 'chat-A', assigneeUserId: 'u-zhang', requesterUserId: 'u-li' });
    reminders.scheduleReminder(db, { taskId: t.id, dueAt: '2026-10-31T09:00:00+08:00', repeatMinutes: 15 });
    for (const at of ['09:00:05', '09:15:05', '09:30:05', '09:45:05']) {
      await loopTick(db, { now: `2026-10-31T${at}+08:00` });
    }
    const esc = outbox.listOutbox(db, { limit: 50 }).find((m) => (m.dedupe_key || '').startsWith('escalate:'));
    assert.ok(esc, '应有一条升级通知');
    const payload = JSON.parse(esc!.payload) as { mentions: string[]; text: string };
    assert.deepEqual(payload.mentions, ['u-li']);
    const pending = db.prepare("SELECT repeat_minutes FROM reminders WHERE task_id = ? AND status = 'pending'").get(t.id) as { repeat_minutes: number };
    assert.equal(pending.repeat_minutes, 60);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('顺延：昨天未完成、没有 pending 的任务排到下一次并告知', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-carry-'));
  const db = openDb(join(dir, 'anc.db'));
  try {
    const t = tasks.createTask(db, { title: '昨天的活', chatId: 'chat-A', dueAt: '2026-10-30T09:00:00+08:00' });
    const r0 = reminders.scheduleReminder(db, { taskId: t.id, dueAt: '2026-10-30T09:00:00+08:00' });
    db.prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ?").run(r0.id);

    const r = await loopTick(db, { now: '2026-10-31T08:00:00+08:00' });
    assert.ok(r.enqueued >= 1);
    const carry = outbox.listOutbox(db, { limit: 50 }).find((m) => (m.dedupe_key || '').startsWith('carry:'));
    assert.ok(carry, '应有一条顺延通知');
    const next = db.prepare("SELECT due_at, status FROM reminders WHERE task_id = ? AND status = 'pending'").get(t.id) as { due_at: string; status: string };
    assert.equal(next.due_at, '2026-10-31T01:00:00.000Z');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('工作时段：周末不发，顺延到下一个工作起点', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-hours-'));
  const db = openDb(join(dir, 'anc.db'));
  try {
    config.setConfig(db, 'work_start', '09:00');
    config.setConfig(db, 'work_end', '18:00');
    config.setConfig(db, 'weekdays', '1-5');

    const t = tasks.createTask(db, { title: '周末任务', chatId: 'chat-A' });
    reminders.scheduleReminder(db, { taskId: t.id, dueAt: '2026-10-31T10:00:00+08:00' }); // 周六
    const r = await loopTick(db, { now: '2026-10-31T10:00:05+08:00' });
    assert.equal(r.enqueued, 0);
    const rem = db.prepare("SELECT due_at, status FROM reminders WHERE task_id = ?").get(t.id) as { due_at: string; status: string };
    assert.equal(rem.due_at, '2026-11-02T01:00:00.000Z'); // 周一 09:00 +08
    assert.equal(rem.status, 'pending');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
