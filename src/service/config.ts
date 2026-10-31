import type { DatabaseSync } from 'node:sqlite';

export interface WorkRules {
  workStart: string; // "HH:mm"
  workEnd: string;
  weekdays: number[]; // 1=周一 … 7=周日
  holidays: string[]; // "YYYY-MM-DD"
}

export const DEFAULT_RULES: WorkRules = {
  workStart: '00:00',
  workEnd: '23:59',
  weekdays: [1, 2, 3, 4, 5, 6, 7],
  holidays: [],
};

export function getConfig(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setConfig(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function listConfig(db: DatabaseSync): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM config ORDER BY key').all() as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function parseWeekdays(v: string): number[] {
  const out = new Set<number>();
  for (const part of v.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^([1-7])\s*-\s*([1-7])$/);
    if (m) {
      const a = Number(m[1]); const b = Number(m[2]);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.add(i);
    } else if (/^[1-7]$/.test(p)) {
      out.add(Number(p));
    }
  }
  return out.size ? Array.from(out).sort() : DEFAULT_RULES.weekdays;
}

function parseHolidays(v: string): string[] {
  return v.split(',').map((s) => s.trim()).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
}

export function loadRules(db: DatabaseSync): WorkRules {
  return {
    workStart: getConfig(db, 'work_start') ?? DEFAULT_RULES.workStart,
    workEnd: getConfig(db, 'work_end') ?? DEFAULT_RULES.workEnd,
    weekdays: parseWeekdays(getConfig(db, 'weekdays') ?? ''),
    holidays: parseHolidays(getConfig(db, 'holidays') ?? ''),
  };
}

function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function minutes(hhmm: string): number {
  const m = hhmm.match(/^(\d{2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

function isWorkday(d: Date, rules: WorkRules): boolean {
  const dow = d.getDay() === 0 ? 7 : d.getDay();
  if (!rules.weekdays.includes(dow)) return false;
  if (rules.holidays.includes(localDateKey(d))) return false;
  return true;
}

export function isWorkTime(d: Date, rules: WorkRules): boolean {
  if (!isWorkday(d, rules)) return false;
  const cur = d.getHours() * 60 + d.getMinutes();
  return cur >= minutes(rules.workStart) && cur < minutes(rules.workEnd);
}

/** 从 d 起最近的工作时段起点（同一天若还没到上班时间就用今天）。 */
export function nextWorkStart(d: Date, rules: WorkRules): Date {
  const startMin = minutes(rules.workStart);
  for (let i = 0; i < 14; i++) {
    const day = new Date(d);
    day.setDate(day.getDate() + i);
    day.setHours(0, 0, 0, 0);
    if (!isWorkday(day, rules)) continue;
    const at = new Date(day);
    at.setMinutes(startMin);
    if (at.getTime() > d.getTime()) return at;
  }
  // 兜底：明天同一时刻
  const fallback = new Date(d);
  fallback.setDate(fallback.getDate() + 1);
  return fallback;
}
