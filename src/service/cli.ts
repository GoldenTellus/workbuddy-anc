#!/usr/bin/env node
// 本地小服务 CLI（先用脚本方式给公司 bot 调，HTTP 监听等 T17/T6）
// 用法见 docs/LOCAL-SERVICE.md；所有命令支持 --db 与 --json。

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { openDb, DEFAULT_DB } from './db.ts';
import * as tasks from './tasks.ts';
import * as reminders from './reminders.ts';
import * as outbox from './outbox.ts';
import * as bindings from './bindings.ts';
import * as config from './config.ts';
import * as backup from './backup.ts';
import * as a2a from './a2a.ts';
import * as loop from './loop.ts';
import { assertSafeOutbound } from './outbound-scan.ts';

type Args = Record<string, string | true> & { _: string[] };

const BOOL_FLAGS = new Set(['json', 'once']);

function parse(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (BOOL_FLAGS.has(k)) { out[k] = true; continue; }
      const n = argv[i + 1];
      if (n !== undefined && !n.startsWith('--')) { out[k] = n; i++; } else { out[k] = true; }
    } else out._.push(a);
  }
  return out;
}

const args = parse(process.argv.slice(2));
const dbPath = typeof args.db === 'string' ? args.db : DEFAULT_DB;
const json = args.json === true;
const [group, cmd] = args._;

function out(obj: unknown): void {
  if (json) console.log(JSON.stringify(obj, null, 2));
  else if (typeof obj === 'string') console.log(obj);
  else console.log(JSON.stringify(obj));
}

function fail(msg: string, code = 2): never {
  console.error('ERROR ' + msg);
  console.error('FIX   看 docs/LOCAL-SERVICE.md');
  process.exit(code);
}

function num(name: string): number {
  const v = args[name];
  if (typeof v !== 'string' || !/^\d+$/.test(v)) fail(`缺少或非法的 --${name}`);
  return Number(v);
}

const db = openDb(dbPath);

if (!group) fail('缺少命令组（bind / task / reminder / outbox）');

try {
  if (group === 'bind') {
    if (cmd === 'set') {
      const r = bindings.bind(
        db,
        String(args['chat-id'] ?? ''),
        String(args.employee ?? ''),
        typeof args.note === 'string' ? args.note : undefined,
        typeof args.userid === 'string' ? args.userid : undefined,
        typeof args['webhook-file'] === 'string' ? args['webhook-file'] : undefined
      );
      out({ ok: true, action: r.action, binding: r.binding });
    } else if (cmd === 'resolve') {
      const b = bindings.resolve(db, String(args['chat-id'] ?? ''));
      out(b ? { ok: true, found: true, binding: b } : { ok: false, found: false });
      if (!b) process.exit(1);
    } else if (cmd === 'unbind') {
      out({ ok: true, removed: bindings.unbind(db, String(args['chat-id'] ?? '')) });
    } else if (cmd === 'list') {
      out({ ok: true, bindings: bindings.listBindings(db) });
    } else if (cmd === 'import') {
      const from = typeof args.from === 'string' ? args.from : '';
      if (!from) fail('缺少 --from <groups.json>');
      const groups = JSON.parse(readFileSync(from, 'utf8')) as bindings.GroupsFile;
      out({ ok: true, ...bindings.importGroups(db, groups) });
    } else fail('未知 bind 子命令');
  } else if (group === 'task') {
    if (cmd === 'add') {
      let dueAt: string | undefined = typeof args.due === 'string' ? args.due : undefined;
      if (typeof args['due-local'] === 'string') {
        // 本地时间（如 "2026-10-31 17:30"）→ UTC ISO，避免模型自己做时区换算
        const d = new Date(String(args['due-local']).replace(' ', 'T'));
        if (Number.isNaN(d.getTime())) fail('--due-local 不是合法时间（用 "YYYY-MM-DD HH:mm"）');
        dueAt = d.toISOString();
      }
      const t = tasks.createTask(db, {
        title: String(args.title ?? ''),
        chatId: typeof args['chat-id'] === 'string' ? args['chat-id'] : undefined,
        assignee: typeof args.assignee === 'string' ? args.assignee : undefined,
        requester: typeof args.requester === 'string' ? args.requester : undefined,
        assigneeUserId: typeof args['assignee-userid'] === 'string' ? args['assignee-userid'] : undefined,
        requesterUserId: typeof args['requester-userid'] === 'string' ? args['requester-userid'] : undefined,
        dueAt,
      });
      if (dueAt) reminders.scheduleReminder(db, { taskId: t.id, dueAt });
      out({ ok: true, task: t, due_local: dueAt ? new Date(dueAt).toLocaleString('sv-SE') : null });
    } else if (cmd === 'list') {
      out({ ok: true, tasks: tasks.listTasks(db, { status: args.status as never, chatId: typeof args['chat-id'] === 'string' ? args['chat-id'] : undefined }) });
    } else if (cmd === 'get') {
      const t = tasks.getTask(db, num('id'));
      out(t ? { ok: true, task: t, events: tasks.taskEvents(db, t.id) } : { ok: false, found: false });
      if (!t) process.exit(1);
    } else if (cmd === 'done') {
      const id = num('id');
      const text = typeof args.text === 'string' ? args.text : `#${id} 已完成`;
      assertSafeOutbound(text);
      const r = tasks.completeTask(
        db,
        id,
        { chatId: typeof args['chat-id'] === 'string' ? args['chat-id'] : undefined, text },
        typeof args.actor === 'string' ? args.actor : undefined
      );
      out({ ok: true, task: r.task, enqueued: r.enqueued });
    } else if (cmd === 'cancel') {
      out({ ok: true, task: tasks.cancelTask(db, num('id'), typeof args.actor === 'string' ? args.actor : undefined) });
    } else fail('未知 task 子命令');
  } else if (group === 'reminder') {
    if (cmd === 'add') {
      const r = reminders.scheduleReminder(db, { taskId: num('task'), dueAt: String(args.due ?? ''), repeatMinutes: typeof args.repeat === 'string' ? Number(args.repeat) : undefined });
      out({ ok: true, reminder: r });
    } else if (cmd === 'due') {
      out({ ok: true, due: reminders.dueReminders(db, typeof args.now === 'string' ? args.now : undefined) });
    } else if (cmd === 'sent') {
      out({ ok: true, ...reminders.markReminderSent(db, num('id'), typeof args.now === 'string' ? args.now : undefined) });
    } else fail('未知 reminder 子命令');
  } else if (group === 'outbox') {
    if (cmd === 'list') {
      out({ ok: true, messages: outbox.listOutbox(db, { status: args.status as never, limit: typeof args.limit === 'string' ? Number(args.limit) : undefined }) });
    } else if (cmd === 'flush') {
      const file = typeof args['webhook-file'] === 'string'
        ? args['webhook-file']
        : join(process.env.ProgramData ?? 'C:\\ProgramData', 'anc', 'secrets', 'wecom-webhook.txt');
      let url = '';
      try { url = readFileSync(file, 'utf8').trim(); } catch { fail('读不到 webhook 文件: ' + file); }
      if (!url) fail('webhook 文件为空: ' + file);
      const limit = typeof args.limit === 'string' ? Number(args.limit) : 20;
      const pend = outbox.listOutbox(db, { status: 'pending', limit });
      let sent = 0; let failed = 0;
      for (const m of pend) {
        const payload = JSON.parse(m.payload) as { text: string; mentions?: string[] };
        try {
          assertSafeOutbound(payload.text);
          const text: Record<string, unknown> = { content: payload.text };
          if (payload.mentions && payload.mentions.length) text.mentioned_list = payload.mentions;
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ msgtype: 'text', text }),
          });
          const body = await res.json().catch(() => ({}));
          if (res.ok && (body as { errcode?: number }).errcode === 0) { outbox.markSent(db, m.id); sent++; }
          else { outbox.markFailed(db, m.id, `HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`); failed++; }
        } catch (e) {
          outbox.markFailed(db, m.id, (e as Error).message);
          failed++;
        }
      }
      out({ ok: failed === 0, sent, failed });
    } else fail('未知 outbox 子命令');
  } else if (group === 'a2a') {
    if (cmd === 'create') {
      if (!args.survey) fail('缺少 --survey');
      if (!args['rule-version']) fail('缺少 --rule-version');
      const expected = typeof args.expected === 'string' ? args.expected.split(',').map((s) => s.trim()).filter(Boolean) : [];
      out({ ok: true, ...a2a.createSurvey(db, {
        surveyId: String(args.survey),
        ruleVersion: String(args['rule-version']),
        ruleFile: typeof args['rule-file'] === 'string' ? args['rule-file'] : undefined,
        expected,
      }) });
    } else if (cmd === 'submit') {
      const text = typeof args.text === 'string'
        ? args.text
        : (typeof args['text-file'] === 'string' ? readFileSync(args['text-file'], 'utf8') : '');
      const internal = typeof args.internal === 'string' ? args.internal : '';
      if (!text) fail('缺少 --text 或 --text-file');
      if (!internal) fail('缺少 --internal <内部区目录>');
      const env = a2a.parseEnvelope(text);
      out({ ok: true, ...a2a.submit(db, env, internal, typeof args['from-userid'] === 'string' ? args['from-userid'] : undefined) });
    } else if (cmd === 'status') {
      const s = a2a.surveyStatus(db, String(args.survey ?? ''));
      if (!s) fail('没有这次调查: ' + String(args.survey ?? ''));
      out({ ok: true, ...s });
    } else if (cmd === 'list') {
      out({ ok: true, submissions: a2a.listSubmissions(db, String(args.survey ?? '')) });
    } else fail('未知 a2a 子命令（create/submit/status/list）');
  } else if (group === 'backup') {
    const to = typeof args.to === 'string' ? args.to : '';
    if (!to) fail('缺少 --to');
    out({ ok: true, path: backup.backup(db, to) });
  } else if (group === 'config') {
    if (cmd === 'list') {
      out({ ok: true, config: config.listConfig(db) });
    } else if (cmd === 'get') {
      const key = String(args.key ?? '');
      const v = config.getConfig(db, key);
      out({ ok: v !== null, key, value: v });
      if (v === null) process.exit(1);
    } else if (cmd === 'set') {
      const key = String(args.key ?? '');
      if (!key) fail('缺少 --key');
      config.setConfig(db, key, String(args.value ?? ''));
      out({ ok: true, key, value: config.getConfig(db, key) });
    } else fail('未知 config 子命令');
  } else if (group === 'loop') {
    const explicit = typeof args['webhook-file'] === 'string' ? args['webhook-file'] : null;
    const secretsDir = explicit ? dirname(explicit) : join(process.env.ProgramData ?? 'C:\\ProgramData', 'anc', 'secrets');
    if (args.once === true) {
      const r = await loop.tick(db, { webhookFile: explicit ?? undefined, secretsDir });
      out({ ok: true, ...r });
    } else {
      const intervalMs = typeof args['interval-ms'] === 'string' ? Number(args['interval-ms']) : 60000;
      process.on('SIGINT', () => { try { db.close(); } catch { /* ignore */ } process.exit(0); });
      await loop.run(db, { webhookFile: explicit ?? undefined, secretsDir, intervalMs });
    }
  } else {
    fail('未知命令组: ' + group);
  }
} catch (e) {
  const err = e as Error & { code?: string };
  console.error('ERROR ' + err.message);
  if (err.code === 'OUTBOUND_SECRET_BLOCKED') console.error('FIX   出站内容含凭据，先删掉再入队/发送（FORK §5.5）');
  else console.error('FIX   看 docs/LOCAL-SERVICE.md');
  process.exit(1);
} finally {
  db.close();
}
