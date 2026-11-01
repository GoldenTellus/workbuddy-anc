import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, copyFileSync, unlinkSync, constants as fsConstants } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// 闸门按 UTF-8 字节算（中文 3 字节/字），比按字符更保守：只会误拒、不会放过超长。
// 与 docs/RENDERER.md 一致；WorkBuddy 实测是字符计数（T19：8020 字符原样可读），这里刻意留余量。
export const LENGTH_WARN = 6500;
export const LENGTH_ERROR = 7500;

export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{([a-z0-9_]+)\}\}/gi, (_m, key: string) => {
    const v = vars[key];
    if (v === undefined) throw new Error('模板占位符没有值: {{' + key + '}}');
    return v;
  });
}

export function fingerprint(inputs: Array<{ path: string; content: string }>): string {
  const h = createHash('sha256');
  // 不用 localeCompare：它随 locale 变化，会让同一份输入在不同机器上算出不同指纹
  const sorted = [...inputs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const i of sorted) {
    h.update(i.path);
    h.update('\0');
    h.update(i.content);
    h.update('\0');
  }
  return h.digest('hex');
}

export interface LengthCheck {
  ok: boolean;
  warn: boolean;
  bytes: number;
  sections?: Array<{ title: string; bytes: number }>;
}

/** 长度闸门：>6500 警告，>7500 报错并给出各段长度。 */
export function checkLength(text: string): LengthCheck {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= LENGTH_WARN) return { ok: true, warn: false, bytes };
  const sections = text.split(/\n(?=## )/).map((s) => ({
    title: (s.match(/^#+\s*(.+)$/m)?.[1] || '(开头)').slice(0, 30),
    bytes: Buffer.byteLength(s, 'utf8'),
  }));
  return { ok: bytes <= LENGTH_ERROR, warn: true, bytes, sections };
}

/** 每个产物保留的备份份数：每次渲染都会备份一次，不设上限会无限增长 */
const BAK_KEEP = 10;

/**
 * 备份成 <dst>.bak-<毫秒时间戳>；同名已存在就追加序号（COPYFILE_EXCL 不覆盖）。
 * 只精确到秒时，同一秒内两次 --adopt 会让第二次备份覆盖第一次，员工原来的 persona 就丢了。
 */
export function backupUnique(src: string, dstBase: string): string {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 17);
  for (let i = 0; i < 100; i++) {
    const dst = `${dstBase}.bak-${stamp}${i ? '-' + i : ''}`;
    try {
      copyFileSync(src, dst, fsConstants.COPYFILE_EXCL);
      return dst;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  throw new Error('备份名冲突过多: ' + dstBase);
}

function pruneBackups(dir: string, prefix: string): void {
  const baks = readdirSync(dir).filter((f) => f.startsWith(prefix + '.bak-')).sort();
  for (const f of baks.slice(0, Math.max(0, baks.length - BAK_KEEP))) {
    try { unlinkSync(join(dir, f)); } catch { /* ignore */ }
  }
}

/** 备份 → 临时写 → 读回对拍 → 重命名；目标被占用时重试。 */
export function writeAtomic(target: string, content: string, retries = 5): string {
  mkdirSync(dirname(target), { recursive: true });
  const name = basename(target);
  if (existsSync(target)) {
    backupUnique(target, join(dirname(target), '.' + name));
    pruneBackups(dirname(target), '.' + name);
  }
  const tmp = join(dirname(target), `.tmp-${Date.now()}-${process.pid}-${name}`);
  writeFileSync(tmp, content, 'utf8');
  const back = readFileSync(tmp, 'utf8');
  const a = createHash('sha256').update(content).digest('hex');
  const b = createHash('sha256').update(back).digest('hex');
  if (a !== b) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw new Error('写回校验失败: ' + target);
  }
  let lastErr: unknown = null;
  for (let i = 0; i < retries; i++) {
    try {
      renameSync(tmp, target);
      return a;
    } catch (e) {
      lastErr = e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
  try { unlinkSync(tmp); } catch { /* ignore */ }
  throw new Error('目标文件写入失败（可能被占用）: ' + target + ' — ' + (lastErr as Error)?.message);
}
