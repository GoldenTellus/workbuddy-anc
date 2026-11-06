import type { DatabaseSync } from 'node:sqlite';
import { isWorkTime, nextWorkStart, type WorkRules } from '../../core/index.ts';
import { scheduleReminder } from '../tasks/index.ts';
import { enqueue } from '../delivery/index.ts';
import { blockedBySecret } from './guard.ts';

/**
 * 单次 tick 最多发多少条「未完成、已顺延」通知。
 * 时钟大跳变（机器时间错乱、VM 恢复旧快照）时，所有 open 任务会同时被判成"昨天没完成"，
 * 一个任务一条就是几十条刷屏。提醒本身照样重排，只是通知有上限。
 */
export const CARRY_NOTIFY_MAX = 5;

export interface CarryInput {
  now: string;
  nowDate: Date;
  rules: WorkRules;
  sendAt: string;
}

/**
 * 昨天没完成、又没有 pending 提醒的任务 → 从"现在能开始催的时刻"续排，并告知。
 * 返回本轮新增的 outbox 条数与跳过数。
 */
export function carryOverdueTasks(db: DatabaseSync, input: CarryInput): { enqueued: number; skipped: number } {
  const { now, nowDate, rules, sendAt } = input;
  let enqueued = 0;
  let skipped = 0;
  const dayStart = new Date(nowDate); dayStart.setHours(0, 0, 0, 0);
  const stale = db.prepare(
    "SELECT id, title, due_at, chat_id FROM tasks WHERE status = 'open' AND due_at IS NOT NULL AND due_at < ?"
  ).all(dayStart.toISOString()) as Array<{ id: number; title: string; due_at: string; chat_id: string | null }>;
  // 去重键用本地日期：toISOString().slice(0,10) 是 UTC 日期，北京时间 00:00–08:00 会算成前一天
  const dayKey = `${dayStart.getFullYear()}-${String(dayStart.getMonth() + 1).padStart(2, '0')}-${String(dayStart.getDate()).padStart(2, '0')}`;
  let carryNotified = 0;
  let carrySilenced = 0;
  for (const t of stale) {
    const key = `carry:${t.id}:${dayKey}`;
    // 不再用"有没有 pending 提醒"做闸门：正常续排的任务一整天都是 pending，"次日顺延并告知"会永远发不出去
    if (db.prepare('SELECT id FROM outbox WHERE dedupe_key = ?').get(key)) continue;
    // 逾期任务从"现在能开始催的时刻"接着提醒（改法 A，2026-11-02 裁决）。
    //
    // 原来排到"次日同一时分"，并把当天的 pending 提醒 cancelled——结果是逾期当天
    // 只有早上一条「已顺延到 X」，整天不催。体感是"昨天没做完，今天它不理我了"，
    // 而且升级条件（累计 4 次提醒）对逾期任务永远不可能满足。
    // 现在：工作时段内就从此刻接着提醒，夜里才推到下一个工作起点；提醒按 15 分钟继续重复。
    const due = new Date(t.due_at);
    const target = isWorkTime(nowDate, rules) ? nowDate : nextWorkStart(nowDate, rules);
    const at = due.toLocaleString('sv-SE').slice(0, 16);
    const nextLabel = target.toLocaleString('sv-SE').slice(0, 16);
    const sameDay = target.toLocaleDateString('sv-SE') === nowDate.toLocaleDateString('sv-SE');
    const text = sameDay
      ? `任务 #${t.id} ${t.title} 上次定在 ${at} 没完成，今天继续提醒`
      : `任务 #${t.id} ${t.title} 上次定在 ${at} 没完成，已排到 ${nextLabel} 继续提醒`;
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
  return { enqueued, skipped };
}
