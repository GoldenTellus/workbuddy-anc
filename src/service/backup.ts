import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

/** 用 SQLite 的 VACUUM INTO 做一致性快照（服务在跑也能安全备份），写完重新打开做完整性校验。 */
export function backup(db: DatabaseSync, target: string): string {
  mkdirSync(dirname(target), { recursive: true });
  const safe = target.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${safe}'`);
  // 快照不完整时删掉，避免残缺文件被当成有效备份、再被保留策略挤掉旧的好备份
  let ok = false;
  try {
    const snap = new DatabaseSync(target, { readOnly: true });
    try {
      const r = snap.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
      ok = r?.integrity_check === 'ok';
    } finally {
      snap.close();
    }
  } catch { ok = false; }
  if (!ok) {
    rmSync(target, { force: true });
    throw new Error('备份快照完整性校验失败，已删除: ' + target);
  }
  return target;
}
