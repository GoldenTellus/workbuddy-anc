import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../../core/index.ts';
import { tx } from '../../core/index.ts';

export type SystemRole = 'boss' | 'manager' | 'employee';
export type GroupType = 'employee' | 'department' | 'company' | 'boss_dm';
export type PersonStatus = 'active' | 'disabled';
export type GroupStatus = 'active' | 'disabled';

export interface Person {
  person_id: string;
  name: string;
  userid: string | null;
  /** 企微通讯录 userid（GAP-080）：只用于 webhook mentioned_list 真 @；空表示没配，通知回退不 @ */
  mention_userid: string | null;
  system_role: SystemRole;
  dept_id: string | null;
  status: PersonStatus;
  created_at: string;
  updated_at: string;
}

export interface Group {
  chat_id: string;
  type: GroupType;
  employee_id: string | null;
  dept_id: string | null;
  name: string | null;
  webhook_file: string | null;
  status: GroupStatus;
  created_at: string;
  updated_at: string;
}

export interface ActorContext {
  group: Group | null;
  person: Person | null;
}

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/**
 * 通讯录 userid：会原样进企微 webhook 的 `mentioned_list`，只允许企微 userid 字符集，长度按上限 64。
 * 与 org 模块的成员校验保持一致（org 不能 import identity，规则各留一份，改一处要同步另一处）。
 */
const MENTION_USERID = /^[A-Za-z0-9_@.-]{1,64}$/;

/** webhook `mentioned_list` 的取值是否安全（char 集 + ≤64）；发送路径也会用它兜一层。 */
export function isMentionUserid(v: unknown): v is string {
  return typeof v === 'string' && MENTION_USERID.test(v);
}

function assertMentionUserid(v: string | undefined): string | null {
  if (v === undefined) return null;
  const s = v.trim();
  if (!s) return null;   // 空值等当没配
  if (!isMentionUserid(s)) {
    throw new Error('mention_userid 不合规（企微通讯录 userid：字母数字 _ @ . -，≤64）: ' + v);
  }
  return s;
}

function clean(v: string | undefined, field: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`缺少 ${field}`);
  const s = v.trim();
  if (s.length > 200) throw new Error(`${field} 过长`);
  if (/[\u0000-\u001f]/.test(s)) throw new Error(`${field} 含控制字符`);
  return s;
}

function assertId(v: string, field: string): string {
  const s = clean(v, field);
  if (!ID.test(s)) throw new Error(`${field} 不合规（小写字母数字 _ -，≤64）: ${s}`);
  return s;
}

function assertRole(v: string | undefined): SystemRole {
  const r = v ?? 'employee';
  if (r !== 'boss' && r !== 'manager' && r !== 'employee') {
    throw new Error('system_role 只能是 boss / manager / employee: ' + r);
  }
  return r;
}

function assertGroupType(v: string): GroupType {
  if (v !== 'employee' && v !== 'department' && v !== 'company' && v !== 'boss_dm') {
    throw new Error('group.type 只能是 employee / department / company / boss_dm: ' + v);
  }
  return v;
}

function assertWebhook(v: string | undefined): string | null {
  if (!v) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.txt$/.test(v) || v.includes('..')) {
    throw new Error('webhook_file 只能是 secrets 目录下的文件名（字母数字._-，以 .txt 结尾）: ' + v);
  }
  return v;
}

function personFromRow(row: unknown): Person | null {
  return (row as Person | undefined) ?? null;
}

function groupFromRow(row: unknown): Group | null {
  return (row as Group | undefined) ?? null;
}

/** 新增或更新一个人。userid 可为空；空 userid 不参与唯一冲突。 */
export function upsertPerson(
  db: DatabaseSync,
  input: {
    personId: string;
    name: string;
    userid?: string;
    /** 企微通讯录 userid（webhook 真 @ 用）；不传/空串 = 清空，回退不 @ */
    mentionUserid?: string;
    systemRole?: SystemRole;
    deptId?: string;
    status?: PersonStatus;
  },
): Person {
  const personId = assertId(input.personId, 'person_id');
  const name = clean(input.name, 'name');
  const userid = input.userid ? clean(input.userid, 'userid') : null;
  const mentionUserid = assertMentionUserid(input.mentionUserid);
  const systemRole = assertRole(input.systemRole);
  const deptId = input.deptId ? assertId(input.deptId, 'dept_id') : null;
  const status = input.status ?? 'active';
  if (status !== 'active' && status !== 'disabled') throw new Error('person.status 只能是 active / disabled: ' + status);
  const t = nowIso();
  db.prepare(`
    INSERT INTO people (person_id, name, userid, mention_userid, system_role, dept_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(person_id) DO UPDATE SET
      name = excluded.name,
      userid = excluded.userid,
      mention_userid = excluded.mention_userid,
      system_role = excluded.system_role,
      dept_id = excluded.dept_id,
      status = excluded.status,
      updated_at = excluded.updated_at
  `).run(personId, name, userid, mentionUserid, systemRole, deptId, status, t, t);
  return resolvePerson(db, personId)!;
}

export function resolvePerson(db: DatabaseSync, personId: string): Person | null {
  return personFromRow(db.prepare('SELECT * FROM people WHERE person_id = ?').get(personId));
}

export function resolvePersonByUserid(db: DatabaseSync, userid: string): Person | null {
  return personFromRow(db.prepare('SELECT * FROM people WHERE userid = ? LIMIT 1').get(userid));
}

export function listPeople(db: DatabaseSync): Person[] {
  return db.prepare('SELECT * FROM people ORDER BY person_id').all() as unknown as Person[];
}

/** 新增或更新一个群。employee 群必须有 employee_id，department 群必须有 dept_id。 */
export function upsertGroup(
  db: DatabaseSync,
  input: {
    chatId: string;
    type: GroupType;
    employeeId?: string;
    deptId?: string;
    name?: string;
    webhookFile?: string;
    status?: GroupStatus;
  },
): Group {
  const chatId = clean(input.chatId, 'chat_id');
  const type = assertGroupType(input.type);
  const employeeId = input.employeeId ? assertId(input.employeeId, 'employee_id') : null;
  const deptId = input.deptId ? assertId(input.deptId, 'dept_id') : null;
  if (type === 'employee' && !employeeId) throw new Error('employee 群必须有 employee_id');
  if (type === 'department' && !deptId) throw new Error('department 群必须有 dept_id');
  const name = input.name ? clean(input.name, 'name') : null;
  const webhookFile = assertWebhook(input.webhookFile);
  const status = input.status ?? 'active';
  if (status !== 'active' && status !== 'disabled') throw new Error('group.status 只能是 active / disabled: ' + status);
  const t = nowIso();
  db.prepare(`
    INSERT INTO groups (chat_id, type, employee_id, dept_id, name, webhook_file, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      type = excluded.type,
      employee_id = excluded.employee_id,
      dept_id = excluded.dept_id,
      name = excluded.name,
      webhook_file = excluded.webhook_file,
      status = excluded.status,
      updated_at = excluded.updated_at
  `).run(chatId, type, employeeId, deptId, name, webhookFile, status, t, t);
  return resolveGroup(db, chatId)!;
}

export function resolveGroup(db: DatabaseSync, chatId: string): Group | null {
  return groupFromRow(db.prepare('SELECT * FROM groups WHERE chat_id = ?').get(chatId));
}

export function listGroups(db: DatabaseSync, type?: GroupType): Group[] {
  if (type) return db.prepare('SELECT * FROM groups WHERE type = ? ORDER BY chat_id').all(type) as unknown as Group[];
  return db.prepare('SELECT * FROM groups ORDER BY chat_id').all() as unknown as Group[];
}

export function resolveEmployeeGroup(db: DatabaseSync, personId: string): Group | null {
  return groupFromRow(db.prepare(
    "SELECT * FROM groups WHERE type = 'employee' AND employee_id = ? AND status = 'active' ORDER BY chat_id LIMIT 1",
  ).get(personId));
}

export function resolveBossDmGroup(db: DatabaseSync): Group | null {
  return groupFromRow(db.prepare(
    "SELECT * FROM groups WHERE type = 'boss_dm' AND status = 'active' ORDER BY chat_id LIMIT 1",
  ).get());
}

/** 把 privacy router 的 target 落成具体 chat_id；找不到返回 null，调用方 fail closed。 */
export function resolvePrivateChat(db: DatabaseSync, personId: string, target: 'employee' | 'boss_dm'): string | null {
  const g = target === 'boss_dm' ? resolveBossDmGroup(db) : resolveEmployeeGroup(db, personId);
  return g?.chat_id ?? null;
}

/** 设置某人的管理者范围（全量替换，不是追加）。 */
export function setManagerScopes(db: DatabaseSync, personId: string, deptIds: string[]): void {
  const pid = assertId(personId, 'person_id');
  const ids = [...new Set(deptIds.map((d) => assertId(d, 'dept_id')))];
  tx(db, () => {
    db.prepare('DELETE FROM manager_scopes WHERE person_id = ?').run(pid);
    const stmt = db.prepare('INSERT INTO manager_scopes (person_id, dept_id, created_at) VALUES (?, ?, ?)');
    const t = nowIso();
    for (const d of ids) stmt.run(pid, d, t);
  });
}

export function listManagerScopes(db: DatabaseSync, personId: string): string[] {
  const rows = db.prepare('SELECT dept_id FROM manager_scopes WHERE person_id = ? ORDER BY dept_id').all(personId) as Array<{ dept_id: string }>;
  return rows.map((r) => r.dept_id);
}

/** 某部门的管理者（用于跨部门审批通知）；只返回启用人。 */
export function listManagersForDept(db: DatabaseSync, deptId: string): Person[] {
  const rows = db.prepare(`
    SELECT p.* FROM people p
    JOIN manager_scopes ms ON ms.person_id = p.person_id
    WHERE ms.dept_id = ? AND p.status = 'active'
    ORDER BY p.person_id
  `).all(deptId);
  return rows as unknown as Person[];
}

/** 只看“这条消息来自哪个群、是谁发的”；权限判断不在这里。 */
export function resolveActor(db: DatabaseSync, chatId: string, userid: string): ActorContext {
  return {
    group: resolveGroup(db, chatId),
    person: resolvePersonByUserid(db, userid),
  };
}
