import {
  existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync, cpSync, rmSync,
  realpathSync, lstatSync, openSync, closeSync, rmdirSync, writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { IngestError, normalizeTarget, assertTextSize, blobHash, assertFrontmatter } from './validate.ts';
import { atomicWriteFile } from '../../../core/index.ts';

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

  const plan: PlanItem[] = [];

  // 先解析真实路径：resolve 不跟链接，junction / 符号链接能把「批次内」的路径指到批次外
  const base = realpathSync(resolve(batchDir));
  const vaultReal = realpathSync(resolve(vaultDir));

  for (const f of meta.files) {
    const target = normalizeTarget(f.target);
    // src 必须在批次目录内：meta.json 来自 bot，不能让它读批次外的文件
    const srcPath = resolve(base, f.src);
    if (!isInside(base, srcPath)) throw new IngestError('BAD_PATH', '批次文件越界: ' + f.src);
    if (!existsSync(srcPath)) throw new IngestError('MISSING_SRC', '批次里缺少文件: ' + f.src);
    const st = lstatSync(srcPath);
    if (st.isSymbolicLink() || !st.isFile()) throw new IngestError('BAD_PATH', '批次文件必须是普通文件（不收链接/目录）: ' + f.src);
    if (!isInside(base, realpathSync(srcPath))) throw new IngestError('BAD_PATH', '批次文件经链接指向批次外: ' + f.src);
    const content = readFileSync(srcPath);

    const dest = join(vaultReal, target);
    assertNoLinkOnPath(vaultReal, dest);
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
        if (blobHash(old!) !== f.base_hash) {
          const cur = blobHash(old!);
          throw new IngestError('BASE_HASH_MISMATCH', 'base_hash 与目标当前内容不一致: ' + target + '；当前=' + cur.slice(0, 12) + ' 传入=' + String(f.base_hash).slice(0, 12) + '（请重读后重投）');
        }
      } else if (f.base_hash) {
        throw new IngestError('UNEXPECTED_BASE_HASH', '新文件不应带 base_hash: ' + target);
      }
    }
    plan.push({ src: srcPath, target, kind: f.kind, content, existed, old });
  }

  // 同一批次内：同一路径出现两次、或仅大小写不同（Windows 上是同一个文件）都拒绝
  const seen = new Map<string, string>();
  for (const p of plan) {
    const key = p.target.toLowerCase();
    if (seen.has(key)) {
      throw new IngestError(seen.get(key) === p.target ? 'DUPLICATE_TARGET' : 'CASE_CONFLICT', '批次内目标路径重复: ' + p.target);
    }
    seen.set(key, p.target);
  }

  return withVaultLock(vaultReal, () => writePlan(vaultReal, plan));
}

type PlanItem = { src: string; target: string; kind: BatchFile['kind']; content: Buffer; existed: boolean; old?: Buffer };

function isInside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

/** 目标路径上已存在的每一级都不能是链接：否则写入会穿到 vault 外。 */
function assertNoLinkOnPath(root: string, dest: string): void {
  let cur = root;
  for (const part of relative(root, dest).split(sep)) {
    cur = join(cur, part);
    if (!existsSync(cur)) return;
    if (lstatSync(cur).isSymbolicLink() || !isInside(root, realpathSync(cur))) {
      throw new IngestError('BAD_PATH', '目标路径经链接指向 vault 外: ' + relative(root, dest));
    }
  }
}

const LOCK_STALE_MS = 10 * 60_000;

function readLock(lockPath: string): { pid?: number; started_at?: string } | null {
  try { return JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number; started_at?: string }; } catch { return null; }
}

/** 锁是否已失效：pid 不存在，或存在超过 10 分钟。判不了（解析失败）就返回 null，按占用处理。 */
function staleReason(lockPath: string): string | null {
  const l = readLock(lockPath);
  if (!l || typeof l.pid !== "number") return null;
  let alive = true;
  try { process.kill(l.pid, 0); } catch { alive = false; }
  const started = l.started_at ? Date.parse(l.started_at) : NaN;
  const age = Number.isFinite(started) ? Date.now() - started : Number.POSITIVE_INFINITY;
  if (!alive) return "pid " + l.pid + " 已不存在";
  if (age > LOCK_STALE_MS) return "锁已存在 " + Math.round(age / 60000) + " 分钟";
  return null;
}

function acquireLock(lockPath: string): number {
  const payload = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() });
  try {
    const fd = openSync(lockPath, "wx");
    writeSync(fd, payload);
    return fd;
  } catch (e) {
    // 关键区分：EEXIST 才是"有人占着"；EACCES/EPERM 是**没有写权限**——
    // 2026-11-02 实测踩过：服务身份没有 .git 写权限时，openSync 失败被当成"活锁"，
    // 报"另一个入库正在进行"，把权限问题伪装成并发问题，查了半天。
    const code = (e as NodeJS.ErrnoException).code;
    if (code && code !== "EEXIST") {
      throw new IngestError(
        "VAULT_NOT_WRITABLE",
        "无法在 vault 里建锁文件（" + code + "）: " + lockPath + "；" +
          "这通常是运行身份对 vault 没有写权限，不是并发冲突。用 icacls 检查该身份是否有 (OI)(CI)F"
      );
    }
    const reason = staleReason(lockPath);
    if (!reason) {
      throw new IngestError("VAULT_BUSY", "另一个入库正在进行（锁文件 " + lockPath + "）；稍后重试，确认没有进程在跑时可删掉锁文件");
    }
    // 留档而不是直接删：出问题时能看出是谁、什么时候留下的
    try { renameSync(lockPath, lockPath + ".stale-" + Date.now()); } catch { /* ignore */ }
    const fd = openSync(lockPath, "wx");
    writeSync(fd, payload);
    process.stderr.write("WARN  接管了残留锁（" + reason + "）；旧锁已改名留档\n");
    return fd;
  }
}

/**
 * vault 级独占锁：两个入库进程同时改同一文件、带同一个 base_hash 时，
 * 计划阶段都能通过，后写的会覆盖先写的。拿锁后在写入前再核一次 hash。
 * 崩溃/断电留下的锁按 pid 与年龄自愈，不然入库会永久停摆。
 */
function withVaultLock<T>(vault: string, fn: () => T): T {
  const lock = join(vault, ".git", "anc-ingest.lock");
  const lockPath = existsSync(join(vault, ".git")) ? lock : join(vault, ".anc-ingest.lock");
  const fd = acquireLock(lockPath);
  try {
    return fn();
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
    try { unlinkSync(lockPath); } catch { /* ignore */ }
  }
}

function writePlan(vault: string, plan: PlanItem[]): ApplyResult {
  // 拿到锁后再核一次：计划阶段到现在之间别的进程可能改过
  for (const p of plan) {
    const dest = join(vault, p.target);
    const nowExists = existsSync(dest);
    if (nowExists !== p.existed) throw new IngestError('BASE_HASH_MISMATCH', '目标在校验后被改动: ' + p.target);
    if (nowExists && blobHash(readFileSync(dest)) !== blobHash(p.old!)) throw new IngestError('BASE_HASH_MISMATCH', '目标在校验后被改动: ' + p.target);
  }

  const result: ApplyResult = { added: [], modified: [], originals: [] };
  const created: string[] = [];
  const createdDirs: string[] = [];
  const replaced: Array<{ path: string; old: Buffer }> = [];

  try {
    for (const p of plan) {
      const dest = join(vault, p.target);
      for (const d of missingDirs(vault, dirname(dest))) { mkdirSync(d); createdDirs.push(d); }
      if (p.existed) replaced.push({ path: dest, old: p.old! });
      writeAtomic(dest, p.content);
      if (!p.existed) created.push(dest);
      if (p.kind === 'original') result.originals.push(p.target);
      else (p.existed ? result.modified : result.added).push(p.target);
    }
  } catch (e) {
    // 回滚失败不能吞掉：vault 可能半新半旧，必须让人知道去哪儿修
    const rollbackErrors: string[] = [];
    for (const c of created) { try { unlinkSync(c); } catch (re) { rollbackErrors.push('删除 ' + relative(vault, c) + ': ' + (re as Error).message); } }
    for (const r of replaced) { try { writeAtomic(r.path, r.old); } catch (re) { rollbackErrors.push('恢复 ' + relative(vault, r.path) + ': ' + (re as Error).message); } }
    for (const d of createdDirs.reverse()) { try { rmdirSync(d); } catch { /* 非空或已删，不影响内容 */ } }
    const err = e instanceof IngestError ? e : new IngestError('WRITE_FAILED', (e as Error).message);
    if (rollbackErrors.length) {
      err.code = 'ROLLBACK_INCOMPLETE';
      err.message += '；回滚未完成，vault 需人工检查: ' + rollbackErrors.join('；');
    }
    throw err;
  }

  return result;
}

/** 从 root 到 dir 之间还不存在的目录（由浅到深）。 */
function missingDirs(root: string, dir: string): string[] {
  const out: string[] = [];
  let cur = dir;
  while (cur !== root && isInside(root, cur) && !existsSync(cur)) { out.unshift(cur); cur = dirname(cur); }
  return out;
}

/** 先写同目录临时文件再改名：进程中途退出不会留下写了一半的目标文件。 */
function writeAtomic(dest: string, content: Buffer): void {
  // ingest 的语义：临时文件 wx（不覆盖同名 tmp）+ rename；不读回校验、不重试。
  atomicWriteFile(dest, content, { exclusive: true });
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
