import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SCHEMA } from './schema.ts';
import { migrate } from './migrate.ts';

export const DEFAULT_DB = process.env.ANC_DB && process.env.ANC_DB.trim()
  ? process.env.ANC_DB.trim()
  : join(process.env.ProgramData || 'C:\\ProgramData', 'anc', 'data', 'anc.db');

// 兼容旧 import：tx 现在在 tx.ts，但 core/index.ts 仍从 db.ts 拿到它。
export { tx } from './tx.ts';

export function openDb(path: string = DEFAULT_DB): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  // 2026-11-05 加（VERIFY §71 A4-1）：库文件被独占（另一个进程持有句柄）时，
  // new DatabaseSync 会抛原始错误 —— 直接冒出去就是一段 Node 裸堆栈，
  // 运维和 agent 都读不出「是文件被占用了」。这里转成一句人话再抛。
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
  } catch (e) {
    const msg = (e as Error).message || String(e);
    const hint = /unable to open|EBUSY|EPERM|EACCES/i.test(msg)
      ? '（常见原因：另一个进程正独占这个文件、目录不可写、或磁盘已满）'
      : '';
    throw new Error(`打不开数据库: ${path} —— ${msg}${hint}`);
  }
  // 计划任务每分钟一次，bot 侧 CLI 随时写：撞锁时等最多 5 秒，而不是直接报 database is locked
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function nowIso(d: Date = new Date()): string {
  return d.toISOString();
}

/** 统一把时间规范成 UTC ISO（字符串比较才可靠）；非法时间直接抛错。 */
export function toIso(v: string | Date): string {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error('非法时间: ' + String(v));
  return d.toISOString();
}
