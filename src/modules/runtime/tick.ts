import type { DatabaseSync } from 'node:sqlite';
import { nowIso, toIso, getConfig, loadRules, isWorkTime, nextWorkStart } from '../../core/index.ts';
import { dueReminders, markReminderSent, getTask, markTimedOut } from '../tasks/index.ts';
import { resolve } from '../identity/index.ts';
import { sendPending, enqueue, requeueTransientFailures, type SendOptions } from '../delivery/index.ts';
import { writeProjection } from './projection.ts';
import { carryOverdueTasks } from './carry.ts';
import { escalateIfNeeded } from './escalation.ts';
import { blockedBySecret } from './guard.ts';

/** 到点提醒的有效期：超过这么久还没发出去（断网、积压）就作废，不补发。 */
const REMINDER_TTL_MIN = 60;

export interface TickOptions extends SendOptions {}

export interface TickResult {
  enqueued: number;
  sent: number;
  failed: number;
  skipped: number;
  requeued: number;
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

  const rules = loadRules(db);
  const nowDate = new Date(toIso(now));
  // 系统主动发的通知（顺延、升级）不在夜里推：非工作时段入队，但最早可发时间排到下一个工作起点
  const sendAt = isWorkTime(nowDate, rules) ? toIso(now) : nextWorkStart(nowDate, rules).toISOString();

  const carry = carryOverdueTasks(db, { now, nowDate, rules, sendAt });
  let enqueued = carry.enqueued;
  let skipped = carry.skipped;

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
    enqueued += escalateIfNeeded(db, task, sentCount, { now, sendAt });
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
