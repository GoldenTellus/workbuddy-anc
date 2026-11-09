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

export interface QuietRules {
  start: string; // "HH:mm"，静默开始
  end: string;   // "HH:mm"，静默结束
}

export const DEFAULT_QUIET: QuietRules = { start: '22:00', end: '08:00' };
export const DEFAULT_NOTIFY_DAILY_CAP = 10;

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

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * config set 的入口校验：写错格式（18:00:00、6pm、9:00）以前会被解析成 0，
 * isWorkTime 永远为假，提醒被静默无限顺延。现在写入时就拒绝。
 */
export function validateConfig(key: string, value: string): void {
  const v = String(value ?? '').trim();
  if (key === 'work_start' || key === 'work_end') {
    if (!HHMM.test(v)) throw new Error(`${key} 必须是 HH:mm（00:00–23:59），收到: ${value}`);
  } else if (key === 'notify_quiet_start' || key === 'notify_quiet_end') {
    if (!HHMM.test(v)) throw new Error(`${key} 必须是 HH:mm（00:00–23:59），收到: ${value}`);
  } else if (key === 'notify_daily_cap') {
    if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 100) throw new Error('notify_daily_cap 必须是 1–100 的整数');
  } else if (key === 'weekdays') {
    if (!v.split(',').every((p) => /^\s*[1-7](\s*-\s*[1-7])?\s*$/.test(p))) throw new Error('weekdays 只能是 1–7 的列表或区间，如 1-5 或 1,2,3');
  } else if (key === 'timezone') {
    // 部署一致性断言：只用于 doctor 校验「主机系统时区 == 配置值」，**不参与运行时时间计算**
    // （isWorkTime / localDay / 提醒排期一律按主机系统本地时区）。写入它不改变任何行为。
    // 存 Windows 时区 Id：doctor 用 Get-TimeZone 可直接比，IANA 名在 PowerShell 5.1 下没有内建映射
    if (!/^[A-Za-z][A-Za-z0-9 _+\-]{2,63}$/.test(v) || v.indexOf('/') !== -1) throw new Error('timezone 必须是 Windows 时区 Id，如 China Standard Time；IANA 名（Asia/Shanghai）doctor 比不上，先换成对应的 Windows Id');
  } else if (key === 'vault_internal' || key === 'vault_shared') {
    if (v && !/^[A-Za-z]:[\\/]/.test(v)) throw new Error(key + ' 必须是绝对路径，如 D:\\anc\\vault-internal');
  } else if (key === 'holidays') {
    if (v && !v.split(',').every((p) => /^\s*\d{4}-\d{2}-\d{2}\s*$/.test(p))) throw new Error('holidays 只能是 YYYY-MM-DD 的逗号列表');
  }
}

/** 已存的工作时段有问题（start/end 相同或格式坏）时的说明；空数组 = 正常。供 doctor / config list 用。 */
export function configProblems(db: DatabaseSync): string[] {
  const out: string[] = [];
  const s = getConfig(db, 'work_start');
  const e = getConfig(db, 'work_end');
  if (s !== null && !HHMM.test(s)) out.push('work_start 格式无效，已按默认处理: ' + s);
  if (e !== null && !HHMM.test(e)) out.push('work_end 格式无效，已按默认处理: ' + e);
  if (s !== null && e !== null && HHMM.test(s) && HHMM.test(e) && s === e) out.push('work_start 与 work_end 相同，已按默认处理');
  const qs = getConfig(db, 'notify_quiet_start');
  const qe = getConfig(db, 'notify_quiet_end');
  if (qs !== null && !HHMM.test(qs)) out.push('notify_quiet_start 格式无效，已按默认处理: ' + qs);
  if (qe !== null && !HHMM.test(qe)) out.push('notify_quiet_end 格式无效，已按默认处理: ' + qe);
  if (qs !== null && qe !== null && HHMM.test(qs) && HHMM.test(qe) && qs === qe) out.push('notify_quiet_start 与 notify_quiet_end 相同，已按默认处理');
  const cap = getConfig(db, 'notify_daily_cap');
  if (cap !== null && (!/^\d+$/.test(cap) || Number(cap) < 1 || Number(cap) > 100)) out.push('notify_daily_cap 无效，已按默认处理: ' + cap);
  const tz = getConfig(db, 'timezone');
  if (tz !== null && (!/^[A-Za-z][A-Za-z0-9 _+\-]{2,63}$/.test(tz) || tz.indexOf('/') !== -1)) out.push('timezone 格式无效（要 Windows 时区 Id）: ' + tz);
  return out;
}

export function loadRules(db: DatabaseSync): WorkRules {
  let workStart = getConfig(db, 'work_start') ?? DEFAULT_RULES.workStart;
  let workEnd = getConfig(db, 'work_end') ?? DEFAULT_RULES.workEnd;
  // 坏配置不能让提醒全停：退回默认（全天），由 doctor 报出来
  if (!HHMM.test(workStart) || !HHMM.test(workEnd) || workStart === workEnd) {
    workStart = DEFAULT_RULES.workStart;
    workEnd = DEFAULT_RULES.workEnd;
  }
  return {
    workStart,
    workEnd,
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

/** 下班时刻（分钟）；23:59 视为到当天结束，否则 23:59 这一分钟到期的提醒会被推到次日。 */
function endMinutes(hhmm: string): number {
  return hhmm === '23:59' ? 24 * 60 : minutes(hhmm);
}

export function isWorkTime(d: Date, rules: WorkRules): boolean {
  const cur = d.getHours() * 60 + d.getMinutes();
  const start = minutes(rules.workStart);
  const end = endMinutes(rules.workEnd);
  if (start < end) return isWorkday(d, rules) && cur >= start && cur < end;
  // 跨零点的班（如 22:00–06:00）：晚上那段算当天的班，凌晨那段算前一天的班
  if (cur >= start) return isWorkday(d, rules);
  if (cur < end) {
    const prev = new Date(d);
    prev.setDate(prev.getDate() - 1);
    return isWorkday(prev, rules);
  }
  return false;
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

export function loadQuietRules(db: DatabaseSync): QuietRules {
  const start = getConfig(db, 'notify_quiet_start') ?? DEFAULT_QUIET.start;
  const end = getConfig(db, 'notify_quiet_end') ?? DEFAULT_QUIET.end;
  // 坏配置不能让通知全停：退回默认，由 doctor/configProblems 报出来。
  if (!HHMM.test(start) || !HHMM.test(end) || start === end) return DEFAULT_QUIET;
  return { start, end };
}

/** 静默窗口：支持跨零点（22:00–08:00）。 */
export function isQuietTime(d: Date, rules: QuietRules): boolean {
  const cur = d.getHours() * 60 + d.getMinutes();
  const start = minutes(rules.start);
  const end = minutes(rules.end);
  if (start < end) return cur >= start && cur < end;
  return cur >= start || cur < end;
}

/** 当前处于静默时，返回静默结束时刻；不在静默时返回 null。 */
export function nextQuietEnd(d: Date, rules: QuietRules): Date | null {
  if (!isQuietTime(d, rules)) return null;
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  out.setMinutes(minutes(rules.end));
  if (out.getTime() <= d.getTime()) out.setDate(out.getDate() + 1);
  return out;
}

export function loadNotifyDailyCap(db: DatabaseSync): number {
  const raw = getConfig(db, 'notify_daily_cap');
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_NOTIFY_DAILY_CAP;
  const n = Number(raw);
  return n >= 1 && n <= 100 ? Math.floor(n) : DEFAULT_NOTIFY_DAILY_CAP;
}
