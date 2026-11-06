import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, copyFileSync, unlinkSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve, dirname } from 'node:path';
import { renderOrg, type RenderResult } from './persona.ts';

// ───────────────────────────── C9：整组部署与回滚 ─────────────────────────────
//
// writeAtomic 只保证「单个文件」原子；渲染是一组文件（company-bot/、members/*/、
// groups.json、manifest.json），中途失败会留下"一半新一半旧"，这比整批失败更难查。
// 所以部署要包一层事务：先快照 → 渲染 → 读回对拍 → 任一失败整体还原。

interface Snapshot {
  files: Map<string, Buffer>;
  dirs: string[];
}

function isTransient(name: string): boolean {
  return name.startsWith('.tmp-') || name.includes('.bak-') || name === '.anc-backup';
}

function walk(root: string, onDir: (dir: string) => void): void {
  if (!existsSync(root)) return;
  onDir(root);
  for (const name of readdirSync(root)) {
    if (isTransient(name)) continue;
    const p = join(root, name);
    try { if (statSync(p).isDirectory()) walk(p, onDir); } catch { /* ignore */ }
  }
}

function snapshotOutDir(outDir: string): Snapshot {
  const root = resolve(outDir);
  const files = new Map<string, Buffer>();
  const dirs: string[] = [];
  walk(root, (dir) => {
    dirs.push(dir);
    for (const name of readdirSync(dir)) {
      if (isTransient(name)) continue;
      const p = join(dir, name);
      try { if (statSync(p).isFile()) files.set(relative(root, p), readFileSync(p)); } catch { /* ignore */ }
    }
  });
  return { files, dirs };
}

function restoreOutDir(outDir: string, snap: Snapshot): void {
  const root = resolve(outDir);
  // 先写回快照里的内容（目录按快照补）
  for (const d of snap.dirs) mkdirSync(d, { recursive: true });
  for (const [rel, buf] of snap.files) {
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, buf);
  }
  // 再删掉快照之后新增的文件（渲染产物只可能落在这两类路径下）
  const now = snapshotOutDir(outDir);
  for (const rel of now.files.keys()) {
    if (!snap.files.has(rel)) {
      try { unlinkSync(join(root, rel)); } catch { /* ignore */ }
    }
  }
}

export interface DeployResult extends RenderResult {
  verified: number;
  /** 从 org 里删掉（而非 disabled）的成员，其残留产物目录被清掉的 id */
  pruned: string[];
}

/**
 * 清理「已经不在 org 里」的成员产物（VERIFY §36 ①）。
 * renderOrg 只遍历当前 org.members：disabled 的会删，但从 members/ 目录里直接
 * 删掉的人它根本看不见，那个人的 persona 会一直留在 build/ 并被部署出去。
 * 只在 deployOrg 对拍通过之后跑；渲染失败时快照会把文件写回来。
 */
function pruneOrphanMembers(outDir: string, activeIds: Set<string>): string[] {
  const membersDir = join(outDir, 'members');
  if (!existsSync(membersDir)) return [];
  const pruned: string[] = [];
  for (const entry of readdirSync(membersDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || activeIds.has(entry.name)) continue;
    const dir = join(membersDir, entry.name);
    // 只删渲染器自己产出的成员目录：认 CODEBUDDY.md 或空目录；陌生目录一律不动。
    const names = readdirSync(dir);
    if (names.length > 0 && !names.includes('CODEBUDDY.md')) continue;
    rmSync(dir, { recursive: true, force: true });
    pruned.push(entry.name);
  }
  return pruned;
}

/**
 * 事务式部署：快照 → 渲染 → 逐产物读回对拍 → 失败整体还原。
 * 对拍不只是相信 writeAtomic 的写回校验：还要确认落盘内容与本次返回值一致，
 * 防止"rename 成功但内容不是这一版"这类磁盘级意外。
 */
export function deployOrg(orgDir: string, outDir: string, templateDir?: string): DeployResult {
  const snap = snapshotOutDir(outDir);
  try {
    const r = templateDir ? renderOrg(orgDir, outDir, templateDir) : renderOrg(orgDir, outDir);
    let verified = 0;
    for (const o of r.outputs) {
      const cur = createHash('sha256').update(readFileSync(o.file)).digest('hex');
      if (cur !== o.sha) throw new Error('产物对拍失败: ' + o.file + '（期望 ' + o.sha.slice(0, 12) + '，实际 ' + cur.slice(0, 12) + '）');
      verified += 1;
    }
    // groups.json / manifest.json 不在 outputs 里，单独核一次可解析
    const groups = JSON.parse(readFileSync(join(outDir, 'groups.json'), 'utf8')) as { members: Array<{ id: string }> };
    JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'));
    const pruned = pruneOrphanMembers(outDir, new Set((groups.members || []).map((m) => m.id)));
    return { ...r, verified, pruned };
  } catch (e) {
    restoreOutDir(outDir, snap);
    throw new Error('渲染失败，已回滚到部署前状态：' + (e as Error).message);
  }
}

/** 把每个文件最新的 `.名字.bak-<时间戳>` 还原回去；没有备份的文件跳过。 */
export function rollbackOutDir(outDir: string, opts: { dryRun?: boolean } = {}): { restored: Array<{ file: string; from: string }>; skipped: string[] } {
  const root = resolve(outDir);
  const picks = new Map<string, { bak: string; stamp: string }>();
  walk(root, (dir) => {
    for (const name of readdirSync(dir)) {
      const m = name.match(/^\.(.+)\.bak-(\d{17}(?:-\d+)?)$/);
      if (!m) continue;
      const target = join(dir, m[1]);
      const prev = picks.get(target);
      if (!prev || m[2] > prev.stamp) picks.set(target, { bak: join(dir, name), stamp: m[2] });
    }
  });
  const restored: Array<{ file: string; from: string }> = [];
  const skipped: string[] = [];
  for (const [target, pick] of picks) {
    if (opts.dryRun) { restored.push({ file: target, from: pick.bak }); continue; }
    try {
      copyFileSync(pick.bak, target);
      restored.push({ file: target, from: pick.bak });
    } catch (e) {
      skipped.push(target + ': ' + (e as Error).message);
    }
  }
  return { restored, skipped };
}
