import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso, toIso } from './db.ts';
import { dueReminders, markReminderSent } from './reminders.ts';
import { getTask } from './tasks.ts';
import { resolve } from './bindings.ts';
import { enqueue, listPendingDue, markSent, markFailed } from './outbox.ts';
import { assertSafeOutbound } from './outbound-scan.ts';

export type Sender = (url: string, text: string, mentions: string[]) => Promise<void>;

export interface TickOptions {
  /** 逻辑时间，测试用；默认当前时间 */
  now?: string;
  /** 固定 webhook 文件（测试或单群部署）；不传则按群绑定里的 webhook_file 选，默认 wecom-webhook.txt */
  webhookFile?: string;
  /** 密钥目录，默认 %ProgramData%\anc\secrets */
  secretsDir?: string;
  /** 注入发送器，测试用；默认走 fetch */
  send?: Sender;
  limit?: number;
}

export interface TickResult {
  enqueued: number;
  sent: number;
  failed: number;
  skipped: number;
}

async function defaultSender(url: string, text: string, mentions: string[]): Promise<void> {
  assertSafeOutbound(text);
  const payload: Record<string, unknown> = { content: text };
  if (mentions.length) payload.mentioned_list = mentions;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ msgtype: 'text', text: payload }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string };
  if (!res.ok || body.errcode !== 0) {
    throw new Error(`HTTP ${res.status} ${body.errcode ?? ''} ${body.errmsg ?? ''}`.trim());
  }
}

/**
 * 一次 tick：
 *   1. 到期提醒 → 生成 outbox 消息（带上该群绑定人的 userid 作为 @）；
 *   2. 到期提醒标记已发（同日续排，跨天停）；
 *   3. 有 webhook 时把 pending 消息发出去。
 */
export async function tick(db: DatabaseSync, opts: TickOptions = {}): Promise<TickResult> {
  const now = opts.now ?? nowIso();
  const due = dueReminders(db, now);
  let enqueued = 0;
  let skipped = 0;

  for (const r of due) {
    const task = getTask(db, r.task_id);
    if (!task || task.status !== 'open') {
      db.prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ?").run(r.id);
      skipped += 1;
      continue;
    }
    const binding = task.chat_id ? resolve(db, task.chat_id) : null;
    const mentions = binding?.userid ? [binding.userid] : [];
    const text = `到点提醒：#${task.id} ${task.title}\n回复「@公司bot #${task.id} 完成」停止提醒`;
    const q = enqueue(db, {
      text,
      chatId: task.chat_id,
      dedupeKey: `reminder:${r.id}`,
      mentions,
      at: now,
    });
    if (q.inserted) enqueued += 1;
    markReminderSent(db, r.id, now);
  }

  let sent = 0;
  let failed = 0;
  const send = opts.send ?? defaultSender;
  const fixedUrl = opts.webhookFile ? readFileSync(opts.webhookFile, 'utf8').trim() : '';
  const secretsDir = opts.secretsDir ?? join(process.env.ProgramData || 'C:\\ProgramData', 'anc', 'secrets');
  const pending = listPendingDue(db, toIso(now), opts.limit ?? 20);

  for (const m of pending) {
    const binding = m.chat_id ? resolve(db, m.chat_id) : null;
    const file = binding?.webhook_file || 'wecom-webhook.txt';
    let url = fixedUrl;
    if (!url) {
      try {
        url = readFileSync(join(secretsDir, file), 'utf8').trim();
      } catch {
        markFailed(db, m.id, '读不到 webhook 文件: ' + file);
        failed += 1;
        continue;
      }
    }
    if (!url) {
      markFailed(db, m.id, 'webhook 文件为空: ' + file);
      failed += 1;
      continue;
    }
    const payload = JSON.parse(m.payload) as { text: string; mentions?: string[] };
    try {
      await send(url, payload.text, payload.mentions ?? []);
      markSent(db, m.id);
      sent += 1;
    } catch (e) {
      markFailed(db, m.id, (e as Error).message);
      failed += 1;
    }
  }

  return { enqueued, sent, failed, skipped };
}

export interface RunOptions extends TickOptions {
  intervalMs?: number;
  onTick?: (r: TickResult) => void;
}

/** 常驻循环：立即跑一次，之后按间隔跑；同一时刻只允许一个 tick 在跑。 */
export async function run(db: DatabaseSync, opts: RunOptions = {}): Promise<never> {
  const interval = Math.max(1000, opts.intervalMs ?? 60_000);
  let busy = false;
  const once = async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await tick(db, opts);
      (opts.onTick ?? ((x: TickResult) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...x }))))(r);
    } catch (e) {
      console.error('tick failed: ' + (e as Error).message);
    } finally {
      busy = false;
    }
  };
  await once();
  setInterval(once, interval);
  return new Promise<never>(() => {});
}
