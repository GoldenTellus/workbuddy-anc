import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso, toIso } from './db.ts';
import { dueReminders, markReminderSent, scheduleReminder } from './reminders.ts';
import { getTask } from './tasks.ts';
import { resolve, resolveByUserid, assertWebhookFileName } from './bindings.ts';
import { enqueue, listPendingDue, claim, markSent, markFailed, requeueTransientFailures, isPermanentFailure } from './outbox.ts';

/** 到点提醒的有效期：超过这么久还没发出去（断网、积压）就作废，不补发。 */
const REMINDER_TTL_MIN = 60;

/**
 * 单次 tick 最多发多少条「未完成、已顺延」通知。
 * 时钟大跳变（机器时间错乱、VM 恢复旧快照）时，所有 open 任务会同时被判成"昨天没完成"，
 * 一个任务一条就是几十条刷屏。提醒本身照样重排，只是通知有上限。
 */
const CARRY_NOTIFY_MAX = 5;
import { assertSafeOutbound } from './outbound-scan.ts';
import { getConfig, loadRules, isWorkTime, nextWorkStart } from './config.ts';
import { writeProjection } from './project.ts';
import { markTimedOut } from './tasks.ts';

export type Sender = (url: string, text: string, mentions: string[]) => Promise<void>;

export interface TickOptions {
  /** 逻辑时间，测试用；默认当前时间 */
  now?: string;
  /** 固定 webhook 文件（联调/测试）；必须同时给 chatId，只发这个群的消息。不传则按群绑定里的 webhook_file 选 */
  webhookFile?: string;
  /** 只处理这个群的待发消息（配合 webhookFile 联调） */
  chatId?: string;
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
  requeued: number;
}

/** 出站内容含凭据：记事件、不入队，返回 true。单条坏数据不能让整个 tick 抛错停摆。 */
function blockedBySecret(db: DatabaseSync, taskId: number, text: string, now: string): boolean {
  try {
    assertSafeOutbound(text);
    return false;
  } catch {
    // 记事件本身也可能失败（库被锁、磁盘满）：这里再兜一层，否则注释里"不能让整个 tick 抛错"
    // 就是空话——事件写不进去只该留痕，不该把这一轮的所有提醒一起带走
    try {
      db.prepare("INSERT INTO task_events (task_id, kind, detail, created_at) VALUES (?, 'notify_blocked', ?, ?)")
        .run(taskId, JSON.stringify({ reason: 'OUTBOUND_SECRET_BLOCKED' }), toIso(now));
    } catch (logErr) {
      console.error('WARN  记 notify_blocked 事件失败: ' + (logErr as Error).message);
    }
    return true;
  }
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
 *   0. 昨天没完成、又没有 pending 提醒的任务 → 顺延到今天同一时刻，并告知；
 *   1. 到期提醒 → 生成 outbox 消息（带上该群绑定人的 userid 作为 @）；
 *   2. 到期提醒标记已发（同日续排，跨天停）；连续 4 次没回应 → 通知交办人一次，之后每小时一次；
 *   3. 把到点且退避已过的 pending 消息发出去。
 */
export async function tick(db: DatabaseSync, opts: TickOptions = {}): Promise<TickResult> {
  // 测试必须注入 send：node:test 子进程会带 NODE_TEST_CONTEXT，禁止默认发送器外发
  if (!opts.send && process.env.NODE_TEST_CONTEXT) {
    throw new Error('测试必须注入 send，禁止真实外发');
  }
  const now = opts.now ?? nowIso();
  // 开机后网络可能晚就绪：先把近期因网络失败的消息捞回来
  let requeued = 0;
  try {
    requeued = requeueTransientFailures(db, toIso(now));
  } catch (e) {
    // 捞不回来会让开机后积压的消息永远发不出去：至少要在日志里留下痕迹
    console.error('WARN  requeueTransientFailures 失败: ' + (e as Error).message);
  }

  let skipped = 0;
  const rules = loadRules(db);
  // 0) 次日顺延
  const nowDate = new Date(toIso(now));
  // 系统主动发的通知（顺延、升级）不在夜里推：非工作时段入队，但最早可发时间排到下一个工作起点
  const sendAt = isWorkTime(nowDate, rules) ? toIso(now) : nextWorkStart(nowDate, rules).toISOString();
  const dayStart = new Date(nowDate); dayStart.setHours(0, 0, 0, 0);
  const stale = db.prepare(
    "SELECT id, title, due_at, chat_id FROM tasks WHERE status = 'open' AND due_at IS NOT NULL AND due_at < ?"
  ).all(dayStart.toISOString()) as Array<{ id: number; title: string; due_at: string; chat_id: string | null }>;
  let enqueued = 0;
  // 去重键用本地日期：toISOString().slice(0,10) 是 UTC 日期，北京时间 00:00–08:00 会算成前一天
  const dayKey = `${dayStart.getFullYear()}-${String(dayStart.getMonth() + 1).padStart(2, '0')}-${String(dayStart.getDate()).padStart(2, '0')}`;
  let carryNotified = 0;
  let carrySilenced = 0;
  for (const t of stale) {
    const key = `carry:${t.id}:${dayKey}`;
    // 不再用"有没有 pending 提醒"做闸门：正常续排的任务一整天都是 pending，"次日顺延并告知"会永远发不出去
    if (db.prepare('SELECT id FROM outbox WHERE dedupe_key = ?').get(key)) continue;
    // 顺延到"次日同一时分"；那个时刻若不在工作时段，再推到下一个工作起点
    const due = new Date(t.due_at);
    const next = new Date(nowDate);
    next.setHours(due.getHours(), due.getMinutes(), 0, 0);
    if (next.getTime() <= nowDate.getTime()) next.setDate(next.getDate() + 1);
    const target = isWorkTime(next, rules) ? next : nextWorkStart(next, rules);
    const at = due.toLocaleString('sv-SE').slice(0, 16);
    const nextLabel = target.toLocaleString('sv-SE').slice(0, 16);
    const text = `任务 #${t.id} ${t.title} 上次定在 ${at} 没完成，已顺延到 ${nextLabel}`;
    // 先检查再排期：被拦的任务不再顺延，免得每天都卡在这里
    if (blockedBySecret(db, t.id, text, now)) { skipped += 1; continue; }
    scheduleReminder(db, { taskId: t.id, dueAt: target.toISOString() });
    // 排期一律照做（任务要能继续被提醒），只有"通知"受上限约束
    if (carryNotified >= CARRY_NOTIFY_MAX) { carrySilenced += 1; continue; }
    const q = enqueue(db, { text, chatId: t.chat_id, dedupeKey: key, at: sendAt });
    if (q.inserted) { enqueued += 1; carryNotified += 1; }
  }
  if (carrySilenced > 0) {
    console.error('WARN  顺延通知超过上限（' + CARRY_NOTIFY_MAX + ' 条），另有 ' + carrySilenced + ' 个任务只重排未通知；提醒本身已全部重排');
  }
  const due = dueReminders(db, now);

  for (const r of due) {
    // 非工作时段/节假日：顺延到下一个工作时段起点，不发
    if (!isWorkTime(nowDate, rules)) {
      const next = nextWorkStart(nowDate, rules);
      db.prepare('UPDATE reminders SET due_at = ? WHERE id = ?').run(next.toISOString(), r.id);
      db.prepare("INSERT INTO task_events (task_id, kind, detail, created_at) VALUES (?, 'reminder_deferred', ?, ?)")
        .run(r.task_id, JSON.stringify({ to: next.toISOString() }), toIso(now));
      skipped += 1;
      continue;
    }
    const task = getTask(db, r.task_id);
    if (!task || task.status !== 'open') {
      db.prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ?").run(r.id);
      skipped += 1;
      continue;
    }
    const binding = task.chat_id ? resolve(db, task.chat_id) : null;
    const mentions = binding?.userid ? [binding.userid] : [];
    const text = `到点提醒：#${task.id} ${task.title}\n回复「@公司bot #${task.id} 完成」停止提醒`;
    if (blockedBySecret(db, task.id, text, now)) {
      db.prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ?").run(r.id);
      skipped += 1;
      continue;
    }
    // 先把提醒标成已发（只在仍是 pending 时生效）再入队：
    // 期间任务被完成、提醒被取消的话这里拿到 null，就不会再发一条过期提醒
    if (!markReminderSent(db, r.id, now, { ifPending: true })) { skipped += 1; continue; }
    const q = enqueue(db, {
      text,
      chatId: task.chat_id,
      dedupeKey: `reminder:${r.id}`,
      mentions,
      at: now,
      // 到点提醒迟到超过一小时就不发了：网络恢复后补发一堆旧提醒没有意义
      expiresAt: new Date(nowDate.getTime() + REMINDER_TTL_MIN * 60_000).toISOString(),
    });
    if (q.inserted) enqueued += 1;

    // 连续 4 次没回应 → 在交办人自己的群里通知一次，并把后续提醒改成每小时
    const sentCount = (db.prepare("SELECT COUNT(*) AS c FROM task_events WHERE task_id = ? AND kind = 'reminder_sent'").get(task.id) as { c: number }).c;
    const escText = `任务 #${task.id} ${task.title} 已提醒 ${sentCount} 次仍未回应，请交办人跟进`;
    if (sentCount >= 4 && !blockedBySecret(db, task.id, escText, now)) {
      const reqGroup = task.requester_userid ? resolveByUserid(db, task.requester_userid) : null;
      if (!reqGroup) {
        db.prepare("INSERT INTO task_events (task_id, kind, detail, created_at) VALUES (?, 'escalate_no_group', ?, ?)")
          .run(task.id, JSON.stringify({ fallback: 'task_chat' }), toIso(now));
      }
      const esc = enqueue(db, {
        text: escText,
        // 交办人在一人一群里通常不在执行人的群：优先发到交办人的群；查不到才退回任务所在群
        chatId: reqGroup?.chat_id ?? task.chat_id,
        dedupeKey: `escalate:${task.id}`,
        mentions: task.requester_userid ? [task.requester_userid] : [],
        at: sendAt,
      });
      if (esc.inserted) enqueued += 1;
      // markReminderSent 已按旧间隔（15 分钟）排好下一次：一并改到一小时后
      db.prepare("UPDATE reminders SET repeat_minutes = 60, due_at = ? WHERE task_id = ? AND status = 'pending'")
        .run(new Date(nowDate.getTime() + 60 * 60_000).toISOString(), task.id);
    }
  }

  const r = await sendPending(db, { ...opts, now: toIso(now) });
  // 后台任务超时（C3）：转 needs_review 并告知交办人；不自动重试，等所有者复核
  for (const t of markTimedOut(db, now)) {
    const text = `任务 #${t.id} ${t.title} 执行超过 ${t.timeout_minutes ?? 30} 分钟没收尾，已转人工复核（回「#${t.id} 重排」或「#${t.id} 关掉」）`;
    enqueue(db, { text, chatId: t.chat_id, dedupeKey: `timeout:${t.id}:${t.started_at}`, at: sendAt });
    enqueued += 1;
  }

  // 任务投影（C2）：配置了内部区就顺手更新；失败只在日志里留痕，不能阻断提醒与发送
  const internalDir = getConfig(db, 'vault_internal');
  if (internalDir) {
    try { writeProjection(db, internalDir); } catch (e) { console.error('WARN  投影失败: ' + (e as Error).message); }
  }

  return { enqueued, sent: r.sent, failed: r.failed, skipped, requeued };
}

/** 发送到点的 pending 消息：每条按自己群的绑定选 webhook，查不到就失败，不退回默认群。 */

/** 配置类错误判死后喊一次运维：同一个群同类错误只在第一条上喊，别每条消息都刷屏。 */
async function failConfigAndAlert(db: DatabaseSync, secretsDir: string, chatId: string | null, id: number, error: string, hint: string): Promise<void> {
  markFailed(db, id, error);
  if (!isPermanentFailure(error)) return;
  const like = error.split(':')[0] + '%';
  const prior = (db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE chat_id = ? AND status = 'failed' AND last_error LIKE ?")
    .get(chatId ?? '', like) as { c: number }).c;
  if (prior > 1) return;
  // 只有"给这个群成功发过消息"才值得喊人：从没成功过的 chat 基本是测试数据或误配，
  // 在群里发一条"没登记 webhook"只会让人以为线上出了问题。这种情况留给 doctor 的 bindings 检查。
  const everSent = (db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE chat_id = ? AND status = 'sent'")
    .get(chatId ?? '') as { c: number }).c;
  if (everSent === 0) return;
  await alertOps(secretsDir, hint + '（chat ' + (chatId ?? '?') + '，修好后用 outbox requeue 重发）');
}
/**
 * 运维告警：只在"配置坏了、重试没用"时用。发不出去也不能影响主流程——
 * 告警是通知，不是关卡。
 */
async function alertOps(secretsDir: string, text: string): Promise<void> {
  try {
    const f = join(secretsDir, 'ops-webhook.txt');
    if (!existsSync(f)) return;
    const url = readFileSync(f, 'utf8').trim();
    if (!url) return;
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ msgtype: 'text', text: { content: '[anc] ' + text } }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    console.error('WARN  运维告警发送失败: ' + (e as Error).message);
  }
}

export async function sendPending(db: DatabaseSync, opts: TickOptions = {}): Promise<{ sent: number; failed: number }> {
  if (opts.webhookFile && !opts.chatId) throw new Error('webhookFile 只能配合 chatId 使用（联调单个群），避免把所有群的消息发到同一个 webhook');
  let sent = 0;
  let failed = 0;
  const send = opts.send ?? defaultSender;
  // 同一个 tick 内所有时间判断用同一个 now：分别调 nowIso() 会跨毫秒，边界上可能自相矛盾
  const now = opts.now ?? nowIso();
  const fixedUrl = opts.webhookFile ? readFileSync(opts.webhookFile, 'utf8').trim() : '';
  const secretsDir = opts.secretsDir ?? join(process.env.ProgramData || 'C:\\ProgramData', 'anc', 'secrets');
  const pending = listPendingDue(db, now, opts.limit ?? 20)
    .filter((m) => !opts.chatId || m.chat_id === opts.chatId);

  const nowStr = toIso(now);
  for (const m of pending) {
    // 先领取：别的发送方（重叠的 tick、outbox flush）已经拿走的就跳过
    if (!claim(db, m.id, nowStr)) continue;
    const exp = (m as { expires_at?: string | null }).expires_at;
    if (exp && exp < nowStr) {
      db.prepare("UPDATE outbox SET status = 'failed', last_error = 'EXPIRED', claimed_at = NULL, updated_at = ? WHERE id = ?").run(nowIso(), m.id);
      failed += 1;
      continue;
    }
    let url = fixedUrl;
    let file = '(fixed)';
    if (!url) {
      // 一人一群：只发到这条消息所属群自己的 webhook；查不到就失败，不退回任何默认群
      const binding = m.chat_id ? resolve(db, m.chat_id) : null;
      if (!binding?.webhook_file) {
        await failConfigAndAlert(db, secretsDir, m.chat_id, m.id, 'NO_WEBHOOK_FOR_CHAT: 该群未绑定或未登记 webhook_file', '有群没登记 webhook，消息发不出去已判失败');
        failed += 1;
        continue;
      }
      file = binding.webhook_file;
      try {
        url = readFileSync(join(secretsDir, assertWebhookFileName(file)), 'utf8').trim();
      } catch {
        await failConfigAndAlert(db, secretsDir, m.chat_id, m.id, '读不到 webhook 文件: ' + file, '读不到 webhook 文件 ' + file + '，消息发不出去已判失败');
        failed += 1;
        continue;
      }
    }
    if (!url) {
      await failConfigAndAlert(db, secretsDir, m.chat_id, m.id, 'webhook 文件为空: ' + file, 'webhook 文件 ' + file + ' 是空的，消息发不出去已判失败');
      failed += 1;
      continue;
    }
    // 不是 https URL 就别交给 fetch：它的报错会把文件原文带进 last_error
    if (!/^https:\/\/\S+$/i.test(url)) {
      await failConfigAndAlert(db, secretsDir, m.chat_id, m.id, 'webhook 文件内容不是 https URL: ' + file, 'webhook 文件 ' + file + ' 里不是 https URL，消息发不出去已判失败');
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

  return { sent, failed };
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
