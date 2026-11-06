import type { DatabaseSync } from 'node:sqlite';

// 嵌套深度：所有 tx() 的 fn 都是同步的，Node 单线程下模块级计数不会跨连接串。
let txDepth = 0;

export function tx<T>(db: DatabaseSync, fn: () => T): T {
  // 嵌套用 SAVEPOINT。原来直接 BEGIN 会抛「cannot start a transaction within a transaction」，
  // 冒泡到外层 catch 后 ROLLBACK 会把外层已完成的写入一并撤销，报错却完全不提数据已丢。
  if (txDepth > 0) {
    const sp = 'anc_sp_' + txDepth;
    txDepth++;
    db.exec('SAVEPOINT ' + sp);
    try {
      const out = fn();
      db.exec('RELEASE ' + sp);
      return out;
    } catch (e) {
      try { db.exec('ROLLBACK TO ' + sp); db.exec('RELEASE ' + sp); } catch { /* 保留原始异常 */ }
      throw e;
    } finally {
      txDepth--;
    }
  }
  // IMMEDIATE：事务一开始就拿写锁，「先查状态再改」在多进程下才是原子的（我们的事务都会写）
  db.exec('BEGIN IMMEDIATE');
  txDepth++;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    // SQLite 自行回滚（FULL/IOERR/BUSY）时 ROLLBACK 会抛「no transaction is active」，别覆盖原始异常
    try { db.exec('ROLLBACK'); } catch { /* 保留原始异常 */ }
    throw e;
  } finally {
    txDepth--;
  }
}
