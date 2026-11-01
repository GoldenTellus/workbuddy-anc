import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import * as tasks from './tasks.ts';
import * as reminders from './reminders.ts';
import * as outbox from './outbox.ts';
import * as bindings from './bindings.ts';
import * as config from './config.ts';
import * as a2a from './a2a.ts';
import { scanOutbound, assertSafeOutbound } from './outbound-scan.ts';
import { tick as loopTick } from './loop.ts';
import * as backup from './backup.ts';

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

test('A2A：解析信封（代码块里）与协议校验', () => {
  const env = {
    protocol: 'anc-a2a/1', survey_id: 's1', message_id: 'm1', reply_to: null,
    type: 'survey', rule_version: 'r1', payload: '整理本机资料',
  };
  const text = '请看下面\n```json\n' + JSON.stringify(env) + '\n```';
  const parsed = a2a.parseEnvelope(text);
  assert.equal(parsed.survey_id, 's1');
  assert.equal(parsed.payload, '整理本机资料');
  assert.throws(() => a2a.parseEnvelope('{"protocol":"anc-a2a/1"}'), /缺少字段/);
  assert.throws(() => a2a.parseEnvelope(JSON.stringify({ ...env, protocol: 'x/1' })), /protocol/);
  // PowerShell 写文件会带 BOM
  assert.equal(a2a.parseEnvelope('\uFEFF' + JSON.stringify(env)).message_id, 'm1');
});

test('A2A：提交归档到内部区并按 message_id 去重', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-a2a-'));
  const db = openDb(join(dir, 'anc.db'));
  const internal = join(dir, 'vault-internal');
  try {
    a2a.createSurvey(db, { surveyId: 's1', ruleVersion: 'r1' });
    const env = a2a.parseEnvelope(JSON.stringify({
      protocol: 'anc-a2a/1', survey_id: 's1', message_id: 'm1', reply_to: null,
      type: 'survey', rule_version: 'r1', payload: '工作事实',
    }));
    const r1 = a2a.submit(db, env, internal, 'u1');
    assert.equal(r1.inserted, true);
    assert.ok(r1.file && r1.file.endsWith('m1.md'));
    const again = a2a.submit(db, env, internal, 'u1');
    assert.equal(again.inserted, false);
    assert.equal(a2a.listSubmissions(db, 's1').length, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A2A：规则版本不符被拒；完成判定按 expected 与题数', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-a2a2-'));
  const db = openDb(join(dir, 'anc.db'));
  const internal = join(dir, 'vault-internal');
  try {
    a2a.createSurvey(db, { surveyId: 's1', ruleVersion: 'r1', expected: ['u1'], questionCount: 3 });
    const mk = (id: string, ver: string) => a2a.parseEnvelope(JSON.stringify({
      protocol: 'anc-a2a/1', survey_id: 's1', message_id: id, reply_to: null,
      type: 'answer', rule_version: ver, payload: 'x',
    }));
    assert.throws(() => a2a.submit(db, mk('q1', 'r2'), internal, 'u1'), /冻结的是 r1/);

    a2a.submit(db, mk('q1', 'r1'), internal, 'u1');
    let st = a2a.surveyStatus(db, 's1')!;
    assert.equal(st.complete, false, '只答一题不算完成');
    assert.deepEqual(st.missing_questions, ['q2', 'q3']);
    assert.deepEqual(st.missing, []);

    // q10 不能被当成 q1 命中
    const big = a2a.createSurvey(db, { surveyId: 's2', ruleVersion: 'r1', expected: ['u1'], questionCount: 11 });
    assert.equal(big.question_count, 11);
    a2a.submit(db, a2a.parseEnvelope(JSON.stringify({
      protocol: 'anc-a2a/1', survey_id: 's2', message_id: 'q10-20261031', reply_to: null,
      type: 'answer', rule_version: 'r1', payload: 'x',
    })), internal, 'u1');
    const st2 = a2a.surveyStatus(db, 's2')!;
    assert.ok(!st2.missing_questions.includes('q10'), 'q10 已提交');
    assert.ok(st2.missing_questions.includes('q1'), 'q1 仍未提交');
    assert.equal(st2.missing_questions.length, 10);

    a2a.submit(db, mk('q2', 'r1'), internal, 'u1');
    a2a.submit(db, mk('q3', 'r1'), internal, 'u1');
    st = a2a.surveyStatus(db, 's1')!;
    assert.equal(st.complete, true);
    assert.deepEqual(st.missing_questions, []);

    // 第二场访谈同样从 q1 开始：不是重复，必须入库
    a2a.createSurvey(db, { surveyId: 's3', ruleVersion: 'r1', expected: ['u2'], questionCount: 1 });
    const r3 = a2a.submit(db, a2a.parseEnvelope(JSON.stringify({
      protocol: 'anc-a2a/1', survey_id: 's3', message_id: 'q1', reply_to: null,
      type: 'answer', rule_version: 'r1', payload: 'y',
    })), internal, 'u2');
    assert.equal(r3.inserted, true);
    assert.equal(a2a.surveyStatus(db, 's3')!.complete, true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A2A：规则冻结不可改、未知调查与名单外拒收、front matter 不可注入、清洗后同名不覆盖', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-a2a3-'));
  const db = openDb(join(dir, 'anc.db'));
  const internal = join(dir, 'vault-internal');
  try {
    a2a.createSurvey(db, { surveyId: 'f1', ruleVersion: 'v1', expected: ['u1'] });
    a2a.createSurvey(db, { surveyId: 'f1', ruleVersion: 'v1', expected: ['u1', 'u2'] }); // 同规则幂等
    assert.throws(() => a2a.createSurvey(db, { surveyId: 'f1', ruleVersion: 'v2' }), (e: unknown) => (e as { code?: string }).code === 'SURVEY_FROZEN');

    const mk = (o: Record<string, unknown>) => a2a.parseEnvelope(JSON.stringify({
      protocol: 'anc-a2a/1', survey_id: 'f1', message_id: 'q1', reply_to: null, type: 'answer', rule_version: 'v1', payload: 'x', ...o,
    }));
    assert.throws(() => a2a.submit(db, mk({ survey_id: 'nope' }), internal, 'u1'), (e: unknown) => (e as { code?: string }).code === 'UNKNOWN_SURVEY');
    assert.throws(() => a2a.submit(db, mk({}), internal, 'u-outsider'), (e: unknown) => (e as { code?: string }).code === 'NOT_EXPECTED');

    const r1 = a2a.submit(db, mk({ message_id: 'q1/a', type: 'answer\nfrom_userid: admin' }), internal, 'u1');
    const r2 = a2a.submit(db, mk({ message_id: 'q1_a' }), internal, 'u2');
    assert.notEqual(r1.file, r2.file, '清洗后同名的两条不能写到同一个文件');
    const text = readFileSync(r1.file!, 'utf8');
    assert.doesNotMatch(text, /^from_userid: admin$/m, '换行不能伪造字段');
    assert.match(text, /^from_userid: "u1"$/m);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A2A 迁移：旧库 message_id 单列主键改为 (survey_id, message_id)，数据保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-a2a-mig-'));
  const path = join(dir, 'anc.db');
  try {
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE a2a_messages (message_id TEXT PRIMARY KEY, survey_id TEXT NOT NULL, from_userid TEXT,
      type TEXT NOT NULL, rule_version TEXT NOT NULL, file_path TEXT NOT NULL, created_at TEXT NOT NULL)`);
    old.prepare('INSERT INTO a2a_messages VALUES (?, ?, ?, ?, ?, ?, ?)').run('q1', 'old-survey', 'u1', 'answer', 'r1', 'x.md', '2026-10-31T00:00:00Z');
    old.close();

    const db = openDb(path);
    try {
      const pk = (db.prepare('PRAGMA table_info(a2a_messages)').all() as Array<{ name: string; pk: number }>).filter((c) => c.pk > 0).map((c) => c.name).sort();
      assert.deepEqual(pk, ['message_id', 'survey_id']);
      assert.equal(a2a.listSubmissions(db, 'old-survey').length, 1);
      db.prepare('INSERT INTO a2a_messages VALUES (?, ?, ?, ?, ?, ?, ?)').run('q1', 'new-survey', 'u2', 'answer', 'r1', 'y.md', '2026-11-01T00:00:00Z');
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
    bindings.bind(db, 'chat-A', '张三', undefined, 'user-zhang', 'hook-a.txt');
    const t = tasks.createTask(db, { title: '写周报', chatId: 'chat-A' });
    reminders.scheduleReminder(db, { taskId: t.id, dueAt: '2026-10-31T09:00:00+08:00' });

    const calls: Array<{ url: string; text: string; mentions: string[] }> = [];
    const send = async (url: string, text: string, mentions: string[]) => { calls.push({ url, text, mentions }); };

    writeFileSync(join(dir, 'hook-a.txt'), 'https://example.invalid/hook-a\n', 'utf8');
    const r = await loopTick(db, { now: '2026-10-31T09:00:10+08:00', secretsDir: dir, send });
    assert.equal(r.enqueued, 1);
    assert.equal(r.sent, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://example.invalid/hook-a');
    assert.deepEqual(calls[0].mentions, ['user-zhang']);
    assert.match(calls[0].text, /到点提醒：#1 写周报/);
    assert.equal(outbox.listOutbox(db, { status: 'pending' }).length, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('隔离：未绑定群的消息不退回默认 webhook，webhook_file 不能是路径', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-loop-'));
  const db = openDb(join(dir, 'anc.db'));
  try {
    for (const bad of ['..\\ops-webhook.txt', '../x.txt', 'C:\\x.txt', 'sub/hook.txt', 'hook.json']) {
      assert.throws(() => bindings.bind(db, 'chat-X', '某人', undefined, 'u-x', bad), /webhook_file/, bad);
    }
    // 默认文件存在也不许用：未绑定群的提醒必须失败
    writeFileSync(join(dir, 'wecom-webhook.txt'), 'https://example.invalid/default\n', 'utf8');
    const t = tasks.createTask(db, { title: '未绑定群的活', chatId: 'chat-unbound' });
    reminders.scheduleReminder(db, { taskId: t.id, dueAt: '2026-10-31T09:00:00+08:00' });
    const calls: string[] = [];
    const r = await loopTick(db, { now: '2026-10-31T09:00:10+08:00', secretsDir: dir, send: async (url) => { calls.push(url); } });
    assert.equal(r.sent, 0);
    assert.equal(calls.length, 0);
    const failed = outbox.listOutbox(db, { status: 'pending' }).concat(outbox.listOutbox(db, { status: 'failed' }));
    assert.match(failed[0].last_error ?? '', /NO_WEBHOOK_FOR_CHAT/);
    // 固定 webhook 不带 chatId 直接拒绝
    await assert.rejects(() => loopTick(db, { now: '2026-10-31T09:00:10+08:00', webhookFile: join(dir, 'wecom-webhook.txt'), send: async () => {} }), /chatId/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('凭据：标题含凭据登记即拒；漏网的坏数据不卡住同一 tick 的其他提醒', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-loop-'));
  const db = openDb(join(dir, 'anc.db'));
  try {
    const secret = ['api', 'key'].join('_') + ': abcdef1234567890'; // 拼接，避免 check-public 自命中
    assert.throws(() => tasks.createTask(db, { title: '把 ' + secret + ' 发给运维', chatId: 'chat-A' }), /凭据|OUTBOUND|secret/i);

    bindings.bind(db, 'chat-A', '张三', undefined, 'u-zhang', 'hook-a.txt');
    writeFileSync(join(dir, 'hook-a.txt'), 'https://example.invalid/hook-a\n', 'utf8');
    const bad = tasks.createTask(db, { title: '占位', chatId: 'chat-A' });
    db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('旧数据 ' + secret, bad.id); // 模拟修复前登记的坏标题
    const good = tasks.createTask(db, { title: '写周报', chatId: 'chat-A' });
    reminders.scheduleReminder(db, { taskId: bad.id, dueAt: '2026-10-31T09:00:00+08:00' });
    reminders.scheduleReminder(db, { taskId: good.id, dueAt: '2026-10-31T09:00:00+08:00' });

    const calls: string[] = [];
    const r = await loopTick(db, { now: '2026-10-31T09:00:10+08:00', secretsDir: dir, send: async (_u, text) => { calls.push(text); } });
    assert.equal(r.sent, 1);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /写周报/);
    const ev = db.prepare("SELECT COUNT(*) AS c FROM task_events WHERE task_id = ? AND kind = 'notify_blocked'").get(bad.id) as { c: number };
    assert.equal(ev.c, 1);
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

    const r = await loopTick(db, { now: '2026-10-31T09:00:10+08:00', send: async () => {} });
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
    bindings.bind(db, 'chat-L', '李四', undefined, 'u-li');
    const t = tasks.createTask(db, { title: '催办测试', chatId: 'chat-A', assigneeUserId: 'u-zhang', requesterUserId: 'u-li' });
    reminders.scheduleReminder(db, { taskId: t.id, dueAt: '2026-10-31T09:00:00+08:00', repeatMinutes: 15 });
    for (const at of ['09:00:05', '09:15:05', '09:30:05', '09:45:05']) {
      await loopTick(db, { now: `2026-10-31T${at}+08:00`, send: async () => {} });
    }
    const esc = outbox.listOutbox(db, { limit: 50 }).find((m) => (m.dedupe_key || '').startsWith('escalate:'));
    assert.ok(esc, '应有一条升级通知');
    const payload = JSON.parse(esc!.payload) as { mentions: string[]; text: string };
    assert.deepEqual(payload.mentions, ['u-li']);
    assert.equal(esc!.chat_id, 'chat-L', '升级通知发到交办人自己的群');
    const pending = db.prepare("SELECT repeat_minutes, due_at FROM reminders WHERE task_id = ? AND status = 'pending'").get(t.id) as { repeat_minutes: number; due_at: string };
    assert.equal(pending.repeat_minutes, 60);
    assert.equal(pending.due_at, new Date('2026-10-31T10:45:05+08:00').toISOString(), '升级后的下一次在一小时后');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('outbox：领取后别人不能再领；超时未回写的可重领；超时报错算网络类；网络失败只回收一次', () => withDb((db) => {
  const a = outbox.enqueue(db, { text: 'x', chatId: 'c', at: '2026-10-31T01:00:00Z' });
  assert.equal(outbox.claim(db, a.id!, '2026-10-31T01:00:00Z'), true);
  assert.equal(outbox.claim(db, a.id!, '2026-10-31T01:01:00Z'), false, '已被领取');
  assert.equal(outbox.claim(db, a.id!, '2026-10-31T01:20:00Z'), true, '10 分钟未回写视为发送方退出');

  outbox.markFailed(db, a.id!, 'TimeoutError: The operation was aborted due to timeout');
  const row = db.prepare('SELECT status FROM outbox WHERE id = ?').get(a.id!) as { status: string };
  assert.equal(row.status, 'pending', '超时只退避，不按业务错误计');

  db.prepare("UPDATE outbox SET status = 'failed', last_error = 'fetch failed', created_at = ? WHERE id = ?").run('2026-10-31T00:30:00Z', a.id!);
  assert.equal(outbox.requeueTransientFailures(db, '2026-10-31T02:00:00Z'), 1);
  db.prepare("UPDATE outbox SET status = 'failed' WHERE id = ?").run(a.id!);
  assert.equal(outbox.requeueTransientFailures(db, '2026-10-31T02:01:00Z'), 0, '同一条不再回收');

  assert.equal(outbox.redactError('Failed to parse URL from secret-file-content'), 'BAD_WEBHOOK_URL');
  assert.doesNotMatch(outbox.redactError('HTTP 400 https://example.invalid/x?key=abc'), /example\.invalid/);
}));

test('配置：格式严格校验；坏配置退回默认不停发；支持跨零点的班；23:59 含当分钟', () => withDb((db) => {
  for (const bad of ['18:00:00', '6pm', '9:00', '24:00']) {
    assert.throws(() => config.validateConfig('work_end', bad), /HH:mm/, bad);
  }
  assert.throws(() => config.validateConfig('weekdays', 'mon-fri'), /weekdays/);
  assert.throws(() => config.validateConfig('holidays', '10/1'), /holidays/);
  config.validateConfig('work_start', '09:00');

  // 绕过校验写进库的坏值：退回全天，并能被报出来
  config.setConfig(db, 'work_start', '9:00');
  config.setConfig(db, 'work_end', '18:00');
  assert.equal(config.loadRules(db).workStart, '00:00');
  assert.equal(config.configProblems(db).length, 1);

  const night: config.WorkRules = { workStart: '22:00', workEnd: '06:00', weekdays: [1, 2, 3, 4, 5], holidays: [] };
  assert.equal(config.isWorkTime(new Date('2026-10-30T23:00:00+08:00'), night), true, '周五 23:00 在班');
  assert.equal(config.isWorkTime(new Date('2026-10-31T03:00:00+08:00'), night), true, '周六凌晨属于周五的班');
  assert.equal(config.isWorkTime(new Date('2026-11-01T03:00:00+08:00'), night), false, '周日凌晨属于周六，不上班');
  assert.equal(config.isWorkTime(new Date('2026-10-30T12:00:00+08:00'), night), false);

  const all: config.WorkRules = { workStart: '00:00', workEnd: '23:59', weekdays: [1, 2, 3, 4, 5, 6, 7], holidays: [] };
  assert.equal(config.isWorkTime(new Date('2026-10-30T23:59:30+08:00'), all), true);
}));

test('工作时段：夜里的顺延通知不立刻推，排到下一个工作起点', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-night-'));
  const db = openDb(join(dir, 'anc.db'));
  try {
    config.setConfig(db, 'work_start', '09:00');
    config.setConfig(db, 'work_end', '18:00');
    const t = tasks.createTask(db, { title: '昨天的活', chatId: 'chat-A', dueAt: '2026-10-29T09:00:00+08:00' });
    const r0 = reminders.scheduleReminder(db, { taskId: t.id, dueAt: '2026-10-29T09:00:00+08:00' });
    db.prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ?").run(r0.id);
    await loopTick(db, { now: '2026-10-30T00:05:00+08:00', send: async () => {} });
    const carry = db.prepare("SELECT next_attempt_at FROM outbox WHERE dedupe_key LIKE 'carry:%'").get() as { next_attempt_at: string };
    assert.equal(carry.next_attempt_at, new Date('2026-10-30T09:00:00+08:00').toISOString());
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

    const r = await loopTick(db, { now: '2026-10-31T08:00:00+08:00', send: async () => {} });
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
    const r = await loopTick(db, { now: '2026-10-31T10:00:05+08:00', send: async () => {} });
    assert.equal(r.enqueued, 0);
    const rem = db.prepare("SELECT due_at, status FROM reminders WHERE task_id = ?").get(t.id) as { due_at: string; status: string };
    assert.equal(rem.due_at, '2026-11-02T01:00:00.000Z'); // 周一 09:00 +08
    assert.equal(rem.status, 'pending');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('完成：通知命中凭据只拦消息、不回滚完成；重复完成不重复入队', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-done-'));
  const db = openDb(join(dir, 'anc.db'));
  try {
    // 1) 通知里带 webhook → 被扫描拦下，但任务仍算完成
    const t1 = tasks.createTask(db, { title: '回访客户', chatId: 'c1', assigneeUserId: 'u1', requesterUserId: 'u2' });
    const blocked = tasks.completeTask(db, t1.id, { text: '已完成 #' + t1.id + ' https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefgh-1234' }, 'u1');
    assert.equal(blocked.enqueued, false, '命中凭据不入队');
    assert.equal(tasks.getTask(db, t1.id)!.status, 'done', '完成状态不回滚');
    assert.equal(outbox.listOutbox(db, { limit: 10 }).length, 0);
    const ev = tasks.taskEvents(db, t1.id).map((e) => e.kind);
    assert.ok(ev.includes('notify_blocked'), '应记 notify_blocked');

    // 2) 普通完成入队一次，重复完成不再入队
    const t2 = tasks.createTask(db, { title: '回访供应商', chatId: 'c1', assigneeUserId: 'u1' });
    const r1 = tasks.completeTask(db, t2.id, { text: '已完成 #' + t2.id }, 'u1');
    assert.equal(r1.enqueued, true);
    const r2 = tasks.completeTask(db, t2.id, { text: '已完成 #' + t2.id }, 'u1');
    assert.equal(r2.enqueued, false, '重复完成不再入队');
    assert.equal(outbox.listOutbox(db, { limit: 10 }).length, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A2A：survey_id 含 ../ 不会写到内部区之外', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-tra-'));
  const db = openDb(join(dir, 'anc.db'));
  const internal = join(dir, 'vault-internal');
  try {
    a2a.createSurvey(db, { surveyId: '../../evil', ruleVersion: 'v1' });
    const env = a2a.parseEnvelope(JSON.stringify({
      protocol: 'anc-a2a/1', survey_id: '../../evil', message_id: 'm1', reply_to: null,
      type: 'answer', rule_version: 'v1', payload: 'x',
    }));
    const r = a2a.submit(db, env, internal, 'u1');
    assert.ok(r.file, '应落盘');
    assert.ok(r.file!.startsWith(internal), '文件必须在内部区内: ' + r.file);
    assert.ok(!r.file!.includes('..'));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('绑定：再次 bind 不带 userid 时保留原值（COALESCE）', () => withDb((db) => {
  bindings.bind(db, 'chat-B', '李四', undefined, 'user-li', 'hook.txt');
  bindings.bind(db, 'chat-B', '李四', '改备注');
  const b = bindings.resolve(db, 'chat-B')!;
  assert.equal(b.userid, 'user-li', 'userid 不应被清空');
  assert.equal(b.webhook_file, 'hook.txt', 'webhook_file 不应被清空');
  bindings.bind(db, 'chat-B', '李四', undefined, 'user-li2');
  assert.equal(bindings.resolve(db, 'chat-B')!.userid, 'user-li2', '显式传入应更新');
}));
test('提醒：repeatMinutes 非法值兜底为 15', () => withDb((db) => {
  const t = tasks.createTask(db, { title: '非法 repeat' });
  const r = reminders.scheduleReminder(db, { taskId: t.id, dueAt: new Date().toISOString(), repeatMinutes: Number('abc') });
  assert.equal(r.repeat_minutes, 15);
  const r2 = reminders.scheduleReminder(db, { taskId: t.id, dueAt: new Date().toISOString(), repeatMinutes: 0 });
  assert.equal(r2.repeat_minutes, 1, '下限 1');
}));
test('outbox：网络错误 10 次才判死，下一 tick 会被重新入队；业务错误仍 5 次', () => withDb((db) => {
  const q = outbox.enqueue(db, { text: '网络重试', chatId: 'c1', dedupeKey: 'net:1' });
  for (let i = 0; i < 9; i++) outbox.markFailed(db, q.id!, 'fetch failed');
  let row = db.prepare('SELECT status, attempts FROM outbox WHERE id = ?').get(q.id) as { status: string; attempts: number };
  assert.equal(row.status, 'pending', '9 次仍应可重试');
  outbox.markFailed(db, q.id!, 'fetch failed');
  row = db.prepare('SELECT status, attempts FROM outbox WHERE id = ?').get(q.id) as { status: string; attempts: number };
  assert.equal(row.status, 'failed', '10 次判死');

  const n = outbox.requeueTransientFailures(db, new Date().toISOString());
  assert.equal(n, 1, '网络失败应被捞回');
  row = db.prepare('SELECT status, attempts FROM outbox WHERE id = ?').get(q.id) as { status: string; attempts: number };
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 0);

  const q2 = outbox.enqueue(db, { text: '业务错误', chatId: 'c1', dedupeKey: 'perm:1' });
  for (let i = 0; i < 5; i++) outbox.markFailed(db, q2.id!, 'HTTP 400 invalid webhook');
  const r2 = db.prepare('SELECT status FROM outbox WHERE id = ?').get(q2.id) as { status: string };
  assert.equal(r2.status, 'failed');
  assert.equal(outbox.requeueTransientFailures(db, new Date().toISOString()), 0, '业务错误不捞回');
}));
test('A2A：内部区必须是独立 git 目录，且不能是共享区', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-a2a-zone-'));
  try {
    const internal = join(dir, 'vault-internal');
    const shared = join(dir, 'vault-shared');
    mkdirSync(internal, { recursive: true });
    mkdirSync(shared, { recursive: true });
    assert.throws(() => a2a.assertInternalDir('relative/path'), /绝对路径/);
    assert.throws(() => a2a.assertInternalDir(internal), /不是 git 仓库/);
    mkdirSync(join(internal, '.git'), { recursive: true });
    mkdirSync(join(shared, '.git'), { recursive: true });
    assert.equal(a2a.assertInternalDir(internal), internal);
    assert.throws(() => a2a.assertInternalDir(shared, shared), /不能是共享区/);
    assert.throws(() => a2a.assertInternalDir(join(shared, 'sub'), shared), /不能是共享区/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A2A：payload 超过上限被拒，且不落库', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-a2a-big-'));
  const db = openDb(join(dir, 'anc.db'));
  try {
    const internal = join(dir, 'vault-internal');
    a2a.createSurvey(db, { surveyId: 's1', ruleVersion: 'r1', expected: ['u1'], questionCount: 1 });
    const env = a2a.parseEnvelope(JSON.stringify({
      protocol: a2a.PROTOCOL, survey_id: 's1', message_id: 'q1', type: 'answer', rule_version: 'r1', payload: 'x'.repeat(a2a.MAX_PAYLOAD + 1),
    }));
    assert.throws(() => a2a.submit(db, env, internal, 'u1'), (e: unknown) => (e as { code?: string }).code === 'PAYLOAD_TOO_LARGE');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM a2a_messages').get().c, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('顺延：昨天有 pending 提醒也照样告知（生产态），且提醒重排到开工时间', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-carry-pending-'));
  const db = openDb(join(dir, 'anc.db'));
  try {
    config.setConfig(db, 'work_start', '09:00');
    config.setConfig(db, 'work_end', '18:00');
    const t = tasks.createTask(db, { title: '昨天的活', chatId: 'chat-A', dueAt: '2026-10-30T10:00:00+08:00' });
    reminders.scheduleReminder(db, { taskId: t.id, dueAt: '2026-10-30T10:00:00+08:00' });
    const r = await loopTick(db, { now: '2026-10-31T08:00:00+08:00', send: async () => {} });
    assert.ok(r.enqueued >= 1);
    assert.ok(outbox.listOutbox(db, { limit: 50 }).some((m) => (m.dedupe_key || '').startsWith('carry:')), '应有顺延通知');
    const next = db.prepare("SELECT due_at, status FROM reminders WHERE task_id = ? AND status = 'pending' ORDER BY id DESC").get(t.id) as { due_at: string; status: string };
    assert.equal(next.due_at, '2026-10-31T02:00:00.000Z');
    // 同一天再 tick 一次：不重复告知
    await loopTick(db, { now: '2026-10-31T08:05:00+08:00', send: async () => {} });
    const carries = outbox.listOutbox(db, { limit: 100 }).filter((m) => (m.dedupe_key || '').startsWith('carry:'));
    assert.equal(carries.length, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('备份：VACUUM INTO 快照可打开且数据一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-backup-snap-'));
  const db = openDb(join(dir, 'anc.db'));
  try {
    tasks.createTask(db, { title: '备份前的任务', chatId: 'chat-A' });
    const snap = backup.backup(db, join(dir, 'snap', 'anc-snap.db'));
    assert.ok(existsSync(snap));
    const s2 = new DatabaseSync(snap, { readOnly: true });
    try {
      const n = (s2.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number }).c;
      assert.equal(n, 1);
    } finally {
      s2.close();
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('备份：目标已存在时不覆盖、不破坏原文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-backup-exists-'));
  const db = openDb(join(dir, 'anc.db'));
  try {
    tasks.createTask(db, { title: 'x' });
    const target = join(dir, 'x.db');
    writeFileSync(target, 'not-a-db', 'utf8');
    assert.throws(() => backup.backup(db, target));
    assert.equal(readFileSync(target, 'utf8'), 'not-a-db', '原文件必须原样保留');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('outbox：两个连接同时领取，只有一个拿到（多进程语义）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-claim-'));
  const path = join(dir, 'anc.db');
  const db1 = openDb(path);
  const db2 = openDb(path);
  try {
    const q = outbox.enqueue(db1, { text: 'x', chatId: 'chat-A', dedupeKey: 'k1', at: '2026-11-02T00:00:00.000Z' });
    assert.equal(q.inserted, true);
    assert.equal(outbox.claim(db1, q.id!, '2026-11-02T00:00:01.000Z'), true);
    assert.equal(outbox.claim(db2, q.id!, '2026-11-02T00:00:01.000Z'), false, '第二个连接不能再领');
  } finally {
    db1.close();
    db2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
