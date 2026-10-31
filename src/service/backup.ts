import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** 用 SQLite 的 VACUUM INTO 做一致性快照（服务在跑也能安全备份）。 */
export function backup(db: DatabaseSync, target: string): string {
  mkdirSync(dirname(target), { recursive: true });
  const safe = target.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${safe}'`);
  return target;
}
