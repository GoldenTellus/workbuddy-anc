import type { DatabaseSync } from 'node:sqlite';
import { assertSafeOutbound, toIso } from '../../core/index.ts';

/** 出站内容含凭据：记事件、不入队，返回 true。单条坏数据不能让整个 tick 抛错停摆。 */
export function blockedBySecret(db: DatabaseSync, taskId: number, text: string, now: string): boolean {
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
