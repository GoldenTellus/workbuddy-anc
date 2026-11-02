#!/usr/bin/env node
// 本地小服务 CLI：脚本方式给公司 bot 调（bind/task/reminder/outbox/a2a/config/loop/serve）
// 用法见 docs/LOCAL-SERVICE.md；所有命令支持 --db 与 --json。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
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
import { appendAudit, commandName } from '../shared/audit.ts';
import { startServer } from './http.ts';
import { checkProjection, rebuildProjection, writeProjection } from './project.ts';

type Args = Record<string, string | true> & { _: string[] };

const BOOL_FLAGS = new Set(['json', 'once', 'check', 'rebuild']);

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

// 审计：每个会改状态的调用留一行（观测手段，写失败不挡主流程）。
// 绕过 CLI 直接改库/改 vault 时这里不会有记录——doctor 靠这个差异发现绕过。
const dataDir = dirname(dbPath);
const audit: { at: string; cmd: string; ok: boolean; code: string | null; targets: string[] } = {
  at: new Date().toISOString(),
  cmd: 'service ' + commandName(process.argv.slice(2)),
  ok: true,
  code: null,
  targets: [],
};
process.on('exit', (code) => {
  // fail() 直接 process.exit，不走 catch：用退出码补上 code，别让审计把失败记成"ok"
  audit.ok = code === 0 && !audit.code;
  audit.code = audit.code ?? (code === 0 ? null : 'EXIT_' + code);
  appendAudit(dataDir, audit);
});
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

function numArg(v: unknown, def: number, min = 1, max = 1000): number {
  if (typeof v !== 'string' || !/^\d+$/.test(v)) return def;
  return Math.min(max, Math.max(min, Number(v)));
}

const db = openDb(dbPath);

if (!group) fail('缺少命令组（bind / task / reminder / outbox / a2a / config / backup / project / loop / serve）');

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
      // 发起人必须登记：没有 userid 的任务任何人都能完成/取消（权限校验只对登记过 userid 的任务生效）
      if (typeof args['requester-userid'] !== 'string' || !args['requester-userid'].trim()) {
        fail('缺少 --requester-userid（用消息前缀里的 from）');
      }
      let dueAt: string | undefined = typeof args.due === 'string' ? args.due : undefined;
      if (typeof args['due-local'] === 'string') {
        // 本地时间（如 "2026-10-31 17:30"）→ UTC ISO，避免模型自己做时区换算。
        // 格式必须完整：只写日期会被按 UTC 零点解析（北京时间 08:00），「Oct 31」这类也会被 Date 接受
        const raw = String(args['due-local']).trim();
        if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(raw)) fail('--due-local 必须是 "YYYY-MM-DD HH:mm"');
        const d = new Date(raw.replace(' ', 'T'));
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
        // 后台任务（D22）：执行器是 WorkBuddy，小服务只管超时；简单任务不允许 start
        kind: args.kind === 'background' ? 'background' : 'simple',
        timeoutMinutes: typeof args.timeout === 'string' ? numArg(args.timeout, 30, 1, 1440) : undefined,
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
      // 不在这里预扫：completeTask 内部只拦通知、不拦完成（「通知被拦不影响完成」）
      const r = tasks.completeTask(
        db,
        id,
        { chatId: typeof args['chat-id'] === 'string' ? args['chat-id'] : undefined, text },
        typeof args.actor === 'string' ? args.actor : undefined
      );
      out({ ok: true, task: r.task, enqueued: r.enqueued });
    } else if (cmd === 'start') {
      // 后台任务开始执行（bot 动手时调一次）；超时后 loop 会转 needs_review
      out({ ok: true, task: tasks.startBackgroundTask(db, num('id')) });
    } else if (cmd === 'reassign') {
      // 离职转交：把某人的 open 任务全部转到新人名下（--to 传 userid，--to-name 传姓名）
      const from = String(args.from ?? '');
      if (!from) fail('缺少 --from <userid 或姓名>');
      const toUserid = typeof args.to === 'string' ? args.to : null;
      const toName = typeof args['to-name'] === 'string' ? args['to-name'] : null;
      if (!toUserid && !toName) fail('缺少 --to <userid> 或 --to-name <姓名>');
      out({ ok: true, ...tasks.reassignTasks(db, from, { userid: toUserid, name: toName }, typeof args.actor === 'string' ? args.actor : undefined) });
    } else if (cmd === 'cancel') {
      out({ ok: true, task: tasks.cancelTask(db, num('id'), typeof args.actor === 'string' ? args.actor : undefined) });
    } else if (cmd === 'review') {
      // 所有者复核：retry 回到 open（清 started_at），close 直接取消
      const decision = String(args.decision ?? '');
      if (decision !== 'retry' && decision !== 'close') fail('--decision 必须是 retry 或 close');
      out({ ok: true, task: tasks.reviewTask(db, num('id'), decision as 'retry' | 'close', typeof args.actor === 'string' ? args.actor : undefined) });
    } else fail('未知 task 子命令');
  } else if (group === 'reminder') {
    if (cmd === 'add') {
      const r = reminders.scheduleReminder(db, { taskId: num('task'), dueAt: String(args.due ?? ''), repeatMinutes: typeof args.repeat === 'string' ? numArg(args.repeat, 15, 1, 1440) : undefined });
      out({ ok: true, reminder: r });
    } else if (cmd === 'due') {
      out({ ok: true, due: reminders.dueReminders(db, typeof args.now === 'string' ? args.now : undefined) });
    } else if (cmd === 'sent') {
      out({ ok: true, ...reminders.markReminderSent(db, num('id'), typeof args.now === 'string' ? args.now : undefined) });
    } else fail('未知 reminder 子命令');
  } else if (group === 'outbox') {
    if (cmd === 'list') {
      out({ ok: true, messages: outbox.listOutbox(db, { status: args.status as never, limit: numArg(args.limit, 50, 1, 200) }) });
    } else if (cmd === 'flush') {
      // 与 tick 同一套发送逻辑：按每条消息的群绑定选 webhook，不再把所有群的消息发到一个 URL
      if (typeof args['webhook-file'] === 'string') fail('outbox flush 不接受 --webhook-file：按群绑定发送；联调请用 loop --once --webhook-file --chat-id');
      const r = await loop.sendPending(db, { limit: numArg(args.limit, 20, 1, 200) });
      out({ ok: r.failed === 0, sent: r.sent, failed: r.failed });
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
        questionCount: typeof args.questions === 'string' && /^\d+$/.test(args.questions) ? Number(args.questions) : 0,
      }) });
    } else if (cmd === 'submit') {
      const text = typeof args.text === 'string'
        ? args.text
        : (typeof args['text-file'] === 'string' ? readFileSync(args['text-file'], 'utf8') : '');
      const internal = typeof args.internal === 'string' ? args.internal : '';
      if (!text) fail('缺少 --text 或 --text-file');
      if (!internal) fail('缺少 --internal <内部区目录>');
      // 越区防护：内部区必须是独立的 git 目录，且不能是共享区（传 --shared 时比对）
      try { a2a.assertInternalDir(internal, typeof args.shared === 'string' ? args.shared : undefined); }
      catch (e) { fail((e as Error).message); }
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
      const problems = config.configProblems(db);
      out({ ok: problems.length === 0, config: config.listConfig(db), problems });
    } else if (cmd === 'get') {
      const key = String(args.key ?? '');
      const v = config.getConfig(db, key);
      out({ ok: v !== null, key, value: v });
      if (v === null) process.exit(1);
    } else if (cmd === 'set') {
      const key = String(args.key ?? '');
      if (!key) fail('缺少 --key');
      config.validateConfig(key, String(args.value ?? ''));
      const nextStart = key === 'work_start' ? String(args.value) : config.getConfig(db, 'work_start');
      const nextEnd = key === 'work_end' ? String(args.value) : config.getConfig(db, 'work_end');
      if (nextStart && nextEnd && nextStart.trim() === nextEnd.trim()) fail('work_start 与 work_end 不能相同');
      config.setConfig(db, key, String(args.value ?? '').trim());
      out({ ok: true, key, value: config.getConfig(db, key) });
    } else fail('未知 config 子命令');
  } else if (group === 'project') {
    // 任务投影：库 → 内部区 collab/tasks.md。--check 只校验，--rebuild 删了重建
    const internal = typeof args.internal === 'string' ? args.internal : (config.getConfig(db, 'vault_internal') ?? '');
    if (!internal) fail('缺少 --internal <内部区目录>（也可先 config set vault_internal <绝对路径>）');
    if (args.check === true) {
      const c = checkProjection(db, internal);
      out({ ok: c.ok, path: c.path, reason: c.reason });
      if (!c.ok) process.exit(1);
    } else if (args.rebuild === true) {
      const c = rebuildProjection(db, internal);
      out({ ok: c.ok, path: c.path, reason: c.reason });
      if (!c.ok) process.exit(1);
    } else {
      out({ ok: true, ...writeProjection(db, internal) });
    }
  } else if (group === 'serve') {
    // 长驻 HTTP 面：只监听 127.0.0.1。token 从 secrets 读，未配置时业务路由全 503（fail-closed）
    const secretsDir = join(process.env.ProgramData ?? 'C:\\ProgramData', 'anc', 'secrets');
    const tokenFile = typeof args['token-file'] === 'string' ? args['token-file'] : join(secretsDir, 'service-token.txt');
    let token: string | null = null;
    if (existsSync(tokenFile)) {
      const raw = readFileSync(tokenFile, 'utf8').trim();
      token = raw || null;
    }
    if (!token) console.error('WARN  未配置 token（' + tokenFile + '）：业务路由会全部 503，只有 /__anc_health 可用');
    const logPath = join(dirname(dbPath), 'loop.log');

    const s = await startServer({
      port: numArg(args.port, 17891, 1024, 65535),
      token,
      // D24 方案 B：入库由服务身份执行，bot 只把批次写进 inbox。
      // vault 对 bot 收紧成只读之后，这条路径是**唯一**能写 vault 的入口。
      ingest: async (batchDir: string) => {
        const inboxRoot = join(process.env.ProgramData ?? 'C:\\ProgramData', 'anc', 'inbox');
        const pending = resolve(inboxRoot, 'pending');
        const target = resolve(batchDir);
        // 只认 inbox/pending 下的目录：否则这个端点等于"以服务身份写任意路径"
        if (!target.startsWith(pending + sep)) {
          throw new Error('批次目录必须在 ' + pending + ' 下，收到: ' + target);
        }
        const vaultShared = config.getConfig(db, 'vault_shared');
        if (!vaultShared) throw new Error('未配置 vault_shared（config set vault_shared <绝对路径>）');
        const { applyBatch, archiveBatch } = await import('../ingest/apply.ts');
        const r = applyBatch(target, vaultShared);
        // 文件已经写进 vault 了，归档只是"把批次挪到 done"。
        // 归档失败（服务身份对 inbox 没有删权限，2026-11-02 实测）不该让调用方以为整批失败。
        let archived: string | null = null;
        try { archived = archiveBatch(target, inboxRoot); } catch (e) {
          console.error('WARN  批次已入库但归档失败: ' + (e as Error).message + '（手工把 ' + target + ' 挪到 inbox\\done 即可）');
        }
        return { added: r.added, modified: r.modified, originals: r.originals, archived };
      },
      health: () => {
        let ageMin: number | null = null;
        try { ageMin = Math.round((Date.now() - statSync(logPath).mtimeMs) / 60000); } catch { ageMin = null; }
        return { ok: ageMin !== null && ageMin <= 10, detail: ageMin === null ? '没有 loop.log' : 'tick ' + ageMin + ' 分钟前' };
      },
      status: () => ({
        open_tasks: (db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE status='open'").get() as { c: number }).c,
        pending_outbox: (db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE status='pending'").get() as { c: number }).c,
      }),
    });
    console.log(JSON.stringify({ ok: true, url: s.url, token_configured: Boolean(token) }));
    const stop = (): void => {
      void s.close().then(() => { try { db.close(); } catch { /* ignore */ } process.exit(0); });
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    // 长驻：靠信号退出，finally 不会执行
    await new Promise<void>(() => { /* keep alive */ });
  } else if (group === 'loop') {
    const explicit = typeof args['webhook-file'] === 'string' ? args['webhook-file'] : null;
    const chatId = typeof args['chat-id'] === 'string' ? args['chat-id'] : undefined;
    if (explicit && !chatId) fail('--webhook-file 只用于联调单个群，必须同时给 --chat-id');
    const secretsDir = join(process.env.ProgramData ?? 'C:\\ProgramData', 'anc', 'secrets');
    // --now：联调与故障注入时把 tick 拨到指定时刻。只对 --once 有意义，
    // 常驻循环传固定时间会让「每分钟一次」永远停在同一点。
    const nowArg = typeof args.now === 'string' ? args.now : undefined;
    if (nowArg && args.once !== true) fail('--now 只能和 --once 一起用');
    if (args.once === true) {
      const r = await loop.tick(db, { webhookFile: explicit ?? undefined, chatId, secretsDir, now: nowArg });
      out({ ok: true, ...r });
    } else {
      const intervalMs = numArg(args['interval-ms'], 60000, 1000, 3600000);
      process.on('SIGINT', () => { try { db.close(); } catch { /* ignore */ } process.exit(0); });
      await loop.run(db, { webhookFile: explicit ?? undefined, chatId, secretsDir, intervalMs });
    }
  } else {
    fail('未知命令组: ' + group);
  }
} catch (e) {
  const err = e as Error & { code?: string };
  audit.code = err.code ?? 'ERROR';
  console.error('ERROR ' + err.message);
  if (err.code === 'OUTBOUND_SECRET_BLOCKED') console.error('FIX   出站内容含凭据，先删掉再入队/发送（FORK §5.5）');
  else console.error('FIX   看 docs/LOCAL-SERVICE.md');
  process.exit(1);
} finally {
  db.close();
}
