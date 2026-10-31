import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync, cpSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { IngestError, normalizeTarget, assertTextSize, blobHash, assertFrontmatter } from './validate.ts';

export interface BatchFile {
  /** 批次目录内的相对源文件 */
  src: string;
  /** 目标路径（共享区相对路径） */
  target: string;
  /** markdown 或 original */
  kind: 'markdown' | 'original';
  /** 覆盖已有 markdown 时，读取时的 git blob hash */
  base_hash?: string | null;
}

export interface BatchMeta {
  batch_id: string;
  chat_id?: string;
  from_userid?: string;
  received_at?: string;
  files: BatchFile[];
}

export interface ApplyResult {
  added: string[];
  modified: string[];
  originals: string[];
}

function readJson(path: string): BatchMeta {
  try {
    const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw) as BatchMeta;
  } catch (e) {
    throw new IngestError('BAD_META', 'meta.json 读取失败: ' + (e as Error).message);
  }
}

/**
 * 把一批入库到共享区：
 * - 全部校验通过才动磁盘；
 * - 中途失败回滚已写入/覆盖的文件；
 * - 不做 git 提交（管理员复核 diff 后再提交）。
 */
export function applyBatch(batchDir: string, vaultDir: string): ApplyResult {
  const meta = readJson(join(batchDir, 'meta.json'));
  if (!meta.batch_id) throw new IngestError('BAD_META', 'meta.json 缺少 batch_id');
  if (!Array.isArray(meta.files) || meta.files.length === 0) throw new IngestError('BAD_META', 'meta.json 没有 files');

  const plan: Array<{ src: string; target: string; kind: BatchFile['kind']; content: Buffer; existed: boolean; old?: Buffer }> = [];

  for (const f of meta.files) {
    const target = normalizeTarget(f.target);
    const srcPath = join(batchDir, f.src);
    if (!existsSync(srcPath)) throw new IngestError('MISSING_SRC', '批次里缺少文件: ' + f.src);
    const content = readFileSync(srcPath);

    const dest = join(vaultDir, target);
    const existed = existsSync(dest);
    let old: Buffer | undefined;
    if (existed) old = readFileSync(dest);

    if (f.kind === 'original') {
      if (existed) throw new IngestError('ORIGINAL_EXISTS', '原件已存在，拒绝覆盖: ' + target);
    } else {
      assertTextSize(content);
      assertFrontmatter(content.toString('utf8'));
      if (existed) {
        if (!f.base_hash) throw new IngestError('NEED_BASE_HASH', '覆盖已有文件必须带 base_hash: ' + target);
        if (blobHash(old!) !== f.base_hash) throw new IngestError('BASE_HASH_MISMATCH', 'base_hash 与当前 HEAD 不一致: ' + target);
      } else if (f.base_hash) {
        throw new IngestError('UNEXPECTED_BASE_HASH', '新文件不应带 base_hash: ' + target);
      }
    }
    plan.push({ src: srcPath, target, kind: f.kind, content, existed, old });
  }

  // 大小写冲突检查（Windows）
  const seen = new Map<string, string>();
  for (const p of plan) {
    const key = p.target.toLowerCase();
    if (seen.has(key) && seen.get(key) !== p.target) throw new IngestError('CASE_CONFLICT', '仅大小写不同的路径冲突: ' + p.target);
    seen.set(key, p.target);
  }

  const result: ApplyResult = { added: [], modified: [], originals: [] };
  const created: string[] = [];
  const replaced: Array<{ path: string; old: Buffer }> = [];

  try {
    for (const p of plan) {
      const dest = join(vaultDir, p.target);
      mkdirSync(dirname(dest), { recursive: true });
      if (p.existed) {
        replaced.push({ path: dest, old: p.old! });
        writeFileSync(dest, p.content);
        if (p.kind === 'markdown') result.modified.push(p.target);
      } else {
        writeFileSync(dest, p.content);
        created.push(dest);
        if (p.kind === 'markdown') result.added.push(p.target);
        else result.originals.push(p.target);
      }
    }
  } catch (e) {
    for (const c of created) { try { unlinkSync(c); } catch { /* ignore */ } }
    for (const r of replaced) { try { writeFileSync(r.path, r.old); } catch { /* ignore */ } }
    throw e;
  }

  return result;
}

/** 从 `…\<inbox>\pending\<id>` 推断 inbox 目录；不匹配返回 null。 */
export function inferInbox(batchDir: string): string | null {
  const m = batchDir.replace(/[\\/]+$/, '').match(/^(.*)[\\/]pending[\\/][^\\/]+$/);
  return m ? m[1] : null;
}

/** 成功后把批次挪到 done/。 */
export function archiveBatch(batchDir: string, inboxDir: string): string {
  const name = batchDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'batch';
  const dest = join(inboxDir, 'done', name);
  mkdirSync(dirname(dest), { recursive: true });
  try {
    renameSync(batchDir, dest);
  } catch {
    cpSync(batchDir, dest, { recursive: true });
    rmSync(batchDir, { recursive: true, force: true });
  }
  return dest;
}

/** 失败后把批次挪到 failed/ 并写 reason.txt。 */
export function failBatch(batchDir: string, inboxDir: string, reason: string): string {
  const name = batchDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'batch';
  const dest = join(inboxDir, 'failed', name);
  mkdirSync(dirname(dest), { recursive: true });
  try {
    renameSync(batchDir, dest);
  } catch {
    cpSync(batchDir, dest, { recursive: true });
    rmSync(batchDir, { recursive: true, force: true });
  }
  writeFileSync(join(dest, 'reason.txt'), reason, 'utf8');
  return dest;
}
