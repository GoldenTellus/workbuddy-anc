import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
  for (const i of [...inputs].sort((a, b) => a.path.localeCompare(b.path))) {
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

/** 备份 → 临时写 → 读回对拍 → 重命名；目标被占用时重试。 */
export function writeAtomic(target: string, content: string, retries = 5): string {
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    copyFileSync(target, join(dirname(target), `.${target.split(/[\\/]/).pop()}.bak-${stamp}`));
  }
  const tmp = join(dirname(target), `.tmp-${Date.now()}-${process.pid}.md`);
  writeFileSync(tmp, content, 'utf8');
  const back = readFileSync(tmp, 'utf8');
  const a = createHash('sha256').update(content).digest('hex');
  const b = createHash('sha256').update(back).digest('hex');
  if (a !== b) throw new Error('写回校验失败: ' + target);
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
  throw new Error('目标文件写入失败（可能被占用）: ' + target + ' — ' + (lastErr as Error)?.message);
}
