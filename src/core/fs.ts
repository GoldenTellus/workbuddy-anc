import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export interface AtomicWriteOptions {
  /** 重命名尝试次数（默认 1 次；org 渲染传 5） */
  retries?: number;
  /** 写回后读回校验 sha256（org 渲染必须开；ingest 不需要） */
  verify?: boolean;
  /** 临时文件用 wx 打开：同一临时名已存在时直接失败（ingest 的语义） */
  exclusive?: boolean;
}

/**
 * 原子写文件：同目录临时文件 → （可选）读回校验 → rename 覆盖。
 * 只负责"单个文件"的原子性；整组文件的事务（快照/回滚/备份）由调用方负责。
 * 返回写入内容的 sha256，调用方可直接拿去做 manifest / 对拍。
 */
export function atomicWriteFile(target: string, content: string | Buffer, opts: AtomicWriteOptions = {}): string {
  mkdirSync(dirname(target), { recursive: true });
  const name = basename(target);
  const tmp = join(dirname(target), `.tmp-${Date.now()}-${process.pid}-${name}`);
  const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const sha = createHash('sha256').update(data).digest('hex');
  let created = false;
  try {
    writeFileSync(tmp, data, opts.exclusive ? { flag: 'wx' } : undefined);
    created = true;
    if (opts.verify) {
      const back = readFileSync(tmp);
      const got = createHash('sha256').update(back).digest('hex');
      if (got !== sha) throw new Error('写回校验失败: ' + target);
    }
    const attempts = Math.max(1, opts.retries ?? 1);
    let lastErr: unknown = null;
    for (let i = 0; i < attempts; i++) {
      try {
        renameSync(tmp, target);
        return sha;
      } catch (e) {
        lastErr = e;
        if (i < attempts - 1) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
        }
      }
    }
    throw new Error('目标文件写入失败（可能被占用）: ' + target + ' — ' + (lastErr as Error)?.message);
  } catch (e) {
    if (created) { try { unlinkSync(tmp); } catch { /* ignore */ } }
    throw e;
  }
}
