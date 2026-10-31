import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DEFAULT_DB = process.env.ANC_DB && process.env.ANC_DB.trim()
  ? process.env.ANC_DB.trim()
  : join(process.env.ProgramData || 'C:\\ProgramData', 'anc', 'data', 'anc.db');

const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_bindings (
  chat_id    TEXT PRIMARY KEY,
  employee   TEXT NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL,
  chat_id        TEXT,
  assignee       TEXT,
  requester      TEXT,
  due_at         TEXT,
  status         TEXT NOT NULL DEFAULT 'open',      -- open | done | cancelled
  policy_version TEXT,
  rule_hash      TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  completed_at   TEXT
);

CREATE TABLE IF NOT EXISTS task_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL,
  kind       TEXT NOT NULL,                          -- created | completed | cancelled | reminder_scheduled | reminder_sent
  detail     TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id        INTEGER NOT NULL,
  due_at         TEXT NOT NULL,
  repeat_minutes INTEGER NOT NULL DEFAULT 15,
  status         TEXT NOT NULL DEFAULT 'pending',    -- pending | sent | cancelled
  last_sent_at   TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT UNIQUE,
  chat_id    TEXT,
  payload    TEXT NOT NULL,                          -- JSON
  status     TEXT NOT NULL DEFAULT 'pending',        -- pending | sent | failed
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_reminders_pending ON reminders(status, due_at);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status, id);
`;

export function openDb(path: string = DEFAULT_DB): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** 轻量迁移：只加列，不改旧数据。 */
function migrate(db: DatabaseSync): void {
  const addCol = (table: string, col: string, type: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  };
  addCol('chat_bindings', 'userid', 'TEXT');
  addCol('chat_bindings', 'webhook_file', 'TEXT');
  addCol('tasks', 'assignee_userid', 'TEXT');
  addCol('tasks', 'requester_userid', 'TEXT');
  addCol('outbox', 'next_attempt_at', 'TEXT');
}

export function nowIso(d: Date = new Date()): string {
  return d.toISOString();
}

/** 统一把时间规范成 UTC ISO（字符串比较才可靠）；非法时间直接抛错。 */
export function toIso(v: string | Date): string {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error('非法时间: ' + String(v));
  return d.toISOString();
}

export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
