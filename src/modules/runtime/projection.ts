// 任务投影：SQLite 是真相，markdown 是投影（FORK §5.4 / PLAN C2）。
//
// 为什么要有投影：库是二进制，人看不了、git 也 diff 不了。把任务拍成一份 markdown 放进
// 内部区，坏库时能对照、交接时能看。投影永远单向（库 → 文件），文件被人手改会在
// `project --check` 里被判 stale，然后被下一次投影覆盖。
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface TaskRow {
  id: number;
  title: string;
  status: string;
  assignee: string | null;
  requester: string | null;
  due_at: string | null;
  completed_at: string | null;
}

export interface ProjectResult {
  path: string;
  changed: boolean;
  rows: number;
}

export interface CheckResult {
  ok: boolean;
  path: string;
  reason: string | null;
}

/** 投影落在内部区的 collab/tasks.md：任务带人名，属于内部资料。 */
export function projectionPath(internalDir: string): string {
  return join(internalDir, 'collab', 'tasks.md');
}

function esc(s: string): string {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function fmt(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('sv-SE').slice(0, 16);
}

/**
 * 生成投影正文。**不含生成时间**：同库状态必须生成同样的字节，
 * 否则 `project --check` 永远 stale、git 也会每次脏。
 */
export function renderTasks(db: DatabaseSync): string {
  const rows = db.prepare(
    'SELECT id, title, status, assignee, requester, due_at, completed_at FROM tasks ORDER BY id'
  ).all() as unknown as TaskRow[];
  const lines = [
    '# 任务快照',
    '',
    '> 由 `anc service project` 从 SQLite 生成，**不要手改**；真相在 `%ProgramData%\\anc\\data\\anc.db`。',
    '> 手改会被 `project --check` 判为过期，并在下一次投影时被覆盖。',
    '',
    '| # | 状态 | 标题 | 负责人 | 交办人 | 截止 | 完成 |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    lines.push(
      '| ' + [String(r.id), r.status, esc(r.title), r.assignee || '—', r.requester || '—', fmt(r.due_at), fmt(r.completed_at)].join(' | ') + ' |'
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** 原子写投影：先写 .tmp 再 rename，避免半份文件被当成有效投影。 */
export function writeProjection(db: DatabaseSync, internalDir: string): ProjectResult {
  const path = projectionPath(internalDir);
  const next = renderTasks(db);
  const rows = (db.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number }).c;
  const prev = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (prev === next) return { path, changed: false, rows };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, next, 'utf8');
  renameSync(tmp, path);
  return { path, changed: true, rows };
}

/** 只校验不写：投影缺失或与库不一致都算不 ok。 */
export function checkProjection(db: DatabaseSync, internalDir: string): CheckResult {
  const path = projectionPath(internalDir);
  if (!existsSync(path)) return { ok: false, path, reason: '投影不存在' };
  let cur: string;
  try { cur = readFileSync(path, 'utf8'); } catch (e) {
    return { ok: false, path, reason: '读不到投影: ' + (e as Error).message };
  }
  const want = renderTasks(db);
  if (cur === want) return { ok: true, path, reason: null };
  return { ok: false, path, reason: '投影与库不一致（被手改过，或库变了没重投影）' };
}

/** 删掉投影后重建（= 从库恢复视图）。返回重建后的校验结果。 */
export function rebuildProjection(db: DatabaseSync, internalDir: string): CheckResult {
  const path = projectionPath(internalDir);
  if (existsSync(path)) rmSync(path, { force: true });
  writeProjection(db, internalDir);
  return checkProjection(db, internalDir);
}
