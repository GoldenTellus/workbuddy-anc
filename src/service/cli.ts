#!/usr/bin/env node
// 本地小服务 CLI（先用脚本方式给公司 bot 调，HTTP 监听等 T17/T6）
// 用法见 docs/LOCAL-SERVICE.md；所有命令支持 --db 与 --json。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, DEFAULT_DB } from './db.ts';
import * as tasks from './tasks.ts';
import * as reminders from './reminders.ts';
import * as outbox from './outbox.ts';
import * as bindings from './bindings.ts';
import { assertSafeOutbound } from './outbound-scan.ts';

type Args = Record<string, string | true> & { _: string[] };

const BOOL_FLAGS = new Set(['json']);

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
      const r = bindings.bind(db, String(args['chat-id'] ?? ''), String(args.employee ?? ''), typeof args.note === 'string' ? args.note : undefined);
      out({ ok: true, action: r.action, binding: r.binding });
    } else if (cmd === 'resolve') {
      const b = bindings.resolve(db, String(args['chat-id'] ?? ''));
      out(b ? { ok: true, found: true, binding: b } : { ok: false, found: false });
      if (!b) process.exit(1);
    } else if (cmd === 'unbind') {
      out({ ok: true, removed: bindings.unbind(db, String(args['chat-id'] ?? '')) });
    } else if (cmd === 'list') {
      out({ ok: true, bindings: bindings.listBindings(db) });
    } else fail('未知 bind 子命令');
  } else if (group === 'task') {
    if (cmd === 'add') {
      const t = tasks.createTask(db, {
        title: String(args.title ?? ''),
        chatId: typeof args['chat-id'] === 'string' ? args['chat-id'] : undefined,
        assignee: typeof args.assignee === 'string' ? args.assignee : undefined,
        requester: typeof args.requester === 'string' ? args.requester : undefined,
        dueAt: typeof args.due === 'string' ? args.due : undefined,
      });
      if (typeof args.due === 'string') reminders.scheduleReminder(db, { taskId: t.id, dueAt: args.due });
      out({ ok: true, task: t });
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
      const r = tasks.completeTask(db, id, { chatId: typeof args['chat-id'] === 'string' ? args['chat-id'] : undefined, text });
      out({ ok: true, task: r.task, enqueued: r.enqueued });
    } else if (cmd === 'cancel') {
      out({ ok: true, task: tasks.cancelTask(db, num('id')) });
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
