import { createHash } from 'node:crypto';

const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i;
// Windows 文件名非法字符与控制字符：放过去要到写盘时才失败，再叠加回滚
const ILLEGAL = /[<>"|?*\u0000-\u001f]/;

export class IngestError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** 共享区内部路径规范化与校验（FORK §5.4 第 3 步）。 */
export function normalizeTarget(input: string): string {
  if (typeof input !== 'string' || !input.trim()) throw new IngestError('BAD_PATH', '路径为空');
  let p = input.trim().replace(/\\/g, '/');
  if (p.length > 200) throw new IngestError('BAD_PATH', '路径过长: ' + p);
  if (p.startsWith('/')) throw new IngestError('BAD_PATH', '不允许绝对路径: ' + p);
  if (/^[A-Za-z]:/.test(p)) throw new IngestError('BAD_PATH', '不允许盘符: ' + p);
  if (p.includes(':')) throw new IngestError('BAD_PATH', '不允许冒号: ' + p);
  const parts = p.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..') throw new IngestError('BAD_PATH', '非法路径段: ' + p);
    if (/[ .]$/.test(part)) throw new IngestError('BAD_PATH', '路径段不能以空格或点结尾: ' + p);
    if (RESERVED.test(part)) throw new IngestError('BAD_PATH', 'Windows 保留名: ' + p);
    if (ILLEGAL.test(part)) throw new IngestError('BAD_PATH', '含 Windows 非法字符或控制字符: ' + p);
    // .git 与 8.3 短名（如 GIT~1）一律拒绝：写进 .git 等于能植入 hook，在下次提交时执行
    if (part.toLowerCase() === '.git' || /~\d/.test(part)) throw new IngestError('BAD_PATH', '不允许写入 .git 或使用短文件名: ' + p);
  }
  return parts.join('/');
}

export function assertTextSize(buf: Buffer, maxBytes = 1024 * 1024): void {
  if (buf.length > maxBytes) throw new IngestError('TOO_LARGE', `文本超过 ${maxBytes} 字节`);
}

/** git blob hash：判断覆盖写时 base hash 是否等于 HEAD。 */
export function blobHash(buf: Buffer): string {
  const header = Buffer.from(`blob ${buf.length}\0`);
  return createHash('sha1').update(Buffer.concat([header, buf])).digest('hex');
}

const FRONTMATTER_FIELDS = ['title', 'source_file', 'updated_at'];

/** 最小 frontmatter 校验：有 --- 头，且包含必要字段。 */
export function assertFrontmatter(markdown: string): void {
  const m = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) throw new IngestError('BAD_FRONTMATTER', '缺少 frontmatter');
  for (const f of FRONTMATTER_FIELDS) {
    if (!new RegExp(`^${f}\\s*:`, 'm').test(m[1])) {
      throw new IngestError('BAD_FRONTMATTER', `frontmatter 缺少 ${f}`);
    }
  }
}
