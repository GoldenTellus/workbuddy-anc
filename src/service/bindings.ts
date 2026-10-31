import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from './db.ts';

export interface Binding {
  chat_id: string;
  employee: string;
  userid: string | null;
  webhook_file: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

function clean(v: string | undefined, field: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`缺少 ${field}`);
  const s = v.trim();
  if (s.length > 200) throw new Error(`${field} 过长`);
  if (/[\u0000-\u001f]/.test(s)) throw new Error(`${field} 含控制字符`);
  return s;
}

export function bind(db: DatabaseSync, chatId: string, employee: string, note?: string, userid?: string, webhookFile?: string): { action: 'created' | 'updated'; binding: Binding } {
  const cid = clean(chatId, 'chat_id');
  const emp = clean(employee, 'employee');
  const uid = userid ? clean(userid, 'userid') : null;
  const hook = webhookFile ? clean(webhookFile, 'webhook_file') : null;
  const t = nowIso();
  const exists = db.prepare('SELECT chat_id FROM chat_bindings WHERE chat_id = ?').get(cid);
  if (exists) {
    db.prepare('UPDATE chat_bindings SET employee = ?, userid = ?, webhook_file = COALESCE(?, webhook_file), note = ?, updated_at = ? WHERE chat_id = ?')
      .run(emp, uid, hook, note ?? null, t, cid);
  } else {
    db.prepare('INSERT INTO chat_bindings (chat_id, employee, userid, webhook_file, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(cid, emp, uid, hook, note ?? null, t, t);
  }
  return { action: exists ? 'updated' : 'created', binding: resolve(db, cid)! };
}

export function resolve(db: DatabaseSync, chatId: string): Binding | null {
  const row = db.prepare('SELECT * FROM chat_bindings WHERE chat_id = ?').get(chatId);
  return (row as Binding | undefined) ?? null;
}

export function listBindings(db: DatabaseSync): Binding[] {
  return db.prepare('SELECT * FROM chat_bindings ORDER BY employee').all() as unknown as Binding[];
}

export function unbind(db: DatabaseSync, chatId: string): number {
  const r = db.prepare('DELETE FROM chat_bindings WHERE chat_id = ?').run(chatId);
  return Number(r.changes ?? 0);
}

export interface GroupsFile {
  members: Array<{ id: string; name: string; chat_id?: string | null; userid?: string | null; webhook_file?: string | null }>;
}

/** 把渲染器产出的 groups.json 同步进绑定表（members/ 是真相，绑定表是投影）。 */
export function importGroups(db: DatabaseSync, groups: GroupsFile): { created: number; updated: number; skipped: number } {
  let created = 0; let updated = 0; let skipped = 0;
  for (const m of groups.members ?? []) {
    if (!m.chat_id) { skipped += 1; continue; }
    const r = bind(db, m.chat_id, m.name, undefined, m.userid ?? undefined, m.webhook_file ?? undefined);
    if (r.action === 'created') created += 1; else updated += 1;
  }
  return { created, updated, skipped };
}
