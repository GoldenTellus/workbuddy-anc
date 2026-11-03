// 员工说「下班」的记录（PLAN 阶段 L5）。
//
// 纯记录，不调模型。两个用途：
//   1. 人看：谁几点收的工
//   2. 机器看：全员都下班了 → 开夜间窗口（devbot 跑的时间）
//
// **谁算"全员"**：`chat_bindings` 里出现过的 employee 去重。
// 这是目前唯一的员工名册——渲染器生成群映射时就是用它。
// 如果将来有独立的 org 名册，这个函数要跟着改（会多/少人）。

import type { DatabaseSync } from 'node:sqlite';

export interface DayEnd {
  id: number;
  employee: string;
  userid: string | null;
  chat_id: string | null;
  note: string | null;
  day: string;
  at: string;
}

export interface AddInput {
  employee: string;
  userid?: string;
  chatId?: string;
  note?: string;
  /** 覆盖"哪一天"，默认按本地日期。测试和补记录时用 */
  day?: string;
}

/** 本地日期 YYYY-MM-DD。用本地时区，因为"今天说过下班没有"是按自然日算的。 */
export function localDay(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export interface AddResult {
  record: DayEnd;
  /** false = 这个人今天已经说过下班了（同一天幂等） */
  created: boolean;
}

/**
 * 记一条下班。
 *
 * 幂等是有意的：员工可能连说两遍「下班」，或者消息被重复投递。
 * 同一个人同一天只留第一条（`idx_dayend_uniq` 保证），不覆盖时间——
 * 第一次说下班的时间才是真的。
 */
export function add(db: DatabaseSync, input: AddInput): AddResult {
  const employee = String(input.employee ?? '').trim();
  if (!employee) throw new Error('employee 不能为空');
  const day = input.day?.trim() || localDay();

  const existing = db
    .prepare('SELECT * FROM dayend WHERE employee = ? AND day = ?')
    .get(employee, day) as DayEnd | undefined;
  if (existing) return { record: existing, created: false };

  const at = new Date().toISOString();
  const r = db
    .prepare('INSERT INTO dayend (employee, userid, chat_id, note, day, at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(employee, input.userid?.trim() || null, input.chatId?.trim() || null, input.note?.trim() || null, day, at);

  const record = db.prepare('SELECT * FROM dayend WHERE id = ?').get(Number(r.lastInsertRowid)) as DayEnd;
  return { record, created: true };
}

/** 今天（或指定某天）谁说过下班。 */
export function list(db: DatabaseSync, opts: { day?: string; limit?: number } = {}): DayEnd[] {
  const day = opts.day?.trim() || localDay();
  const raw = Number(opts.limit);
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 500) : 200;
  return db
    .prepare('SELECT * FROM dayend WHERE day = ? ORDER BY at DESC LIMIT ?')
    .all(day, limit) as unknown as DayEnd[];
}

export interface AllOffResult {
  /** 全员都说过下班了吗 */
  allOff: boolean;
  /** 名册（chat_bindings 里的 employee 去重） */
  roster: string[];
  /** 今天已经说下班的 */
  off: string[];
  /** 还没说的 */
  pending: string[];
  day: string;
}

/**
 * 全员下班判定 —— 夜间窗口的开关条件。
 *
 * **空名册返回 allOff=false**：一个员工都没登记时说"全员下班"没有意义，
 * 而且会让 devbot 在一个没人用过的系统上半夜乱改。
 */
export function checkAllOff(db: DatabaseSync, opts: { day?: string } = {}): AllOffResult {
  const day = opts.day?.trim() || localDay();
  const rows = db.prepare('SELECT DISTINCT employee FROM chat_bindings WHERE employee IS NOT NULL AND employee <> \'\'').all() as Array<{ employee: string }>;
  const roster = rows.map((r) => r.employee);
  const off = new Set(
    (db.prepare('SELECT employee FROM dayend WHERE day = ?').all(day) as Array<{ employee: string }>).map((r) => r.employee),
  );
  const offList = roster.filter((e) => off.has(e));
  const pending = roster.filter((e) => !off.has(e));
  return {
    allOff: roster.length > 0 && pending.length === 0,
    roster,
    off: offList,
    pending,
    day,
  };
}
