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

CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS a2a_surveys (
  survey_id    TEXT PRIMARY KEY,
  rule_version TEXT NOT NULL,
  rule_hash    TEXT,
  expected     TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS a2a_messages (
  message_id   TEXT NOT NULL,
  survey_id    TEXT NOT NULL,
  from_userid  TEXT,
  type         TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  file_path    TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (survey_id, message_id)
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
  status     TEXT NOT NULL DEFAULT 'pending',        -- pending | sending | sent | failed
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
  // 计划任务每分钟一次，bot 侧 CLI 随时写：撞锁时等最多 5 秒，而不是直接报 database is locked
  db.exec('PRAGMA busy_timeout = 5000');
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
// 后台任务（D22）：执行器是 WorkBuddy，小服务只管状态与超时
addCol('tasks', 'kind', "TEXT NOT NULL DEFAULT 'simple'");
addCol('tasks', 'started_at', 'TEXT');
addCol('tasks', 'timeout_minutes', 'INTEGER');
  addCol('tasks', 'requester_userid', 'TEXT');
  addCol('outbox', 'next_attempt_at', 'TEXT');
  addCol('outbox', 'claimed_at', 'TEXT');
  addCol('outbox', 'requeued_at', 'TEXT');
  addCol('outbox', 'expires_at', 'TEXT');
  addCol('a2a_surveys', 'question_count', 'INTEGER NOT NULL DEFAULT 0');

  // a2a_messages 早期以 message_id 单列为主键：每场访谈都用 q1..qN，第二场会被当成重复丢掉。
  // 改为 (survey_id, message_id) 复合主键；旧数据原样搬过去。
  const pk = (db.prepare('PRAGMA table_info(a2a_messages)').all() as Array<{ name: string; pk: number }>)
    .filter((c) => c.pk > 0).map((c) => c.name);
  if (pk.length === 1 && pk[0] === 'message_id') {
    tx(db, () => {
      db.exec(`CREATE TABLE a2a_messages_new (
        message_id TEXT NOT NULL, survey_id TEXT NOT NULL, from_userid TEXT, type TEXT NOT NULL,
        rule_version TEXT NOT NULL, file_path TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (survey_id, message_id))`);
      db.exec(`INSERT INTO a2a_messages_new (message_id, survey_id, from_userid, type, rule_version, file_path, created_at)
        SELECT message_id, survey_id, from_userid, type, rule_version, file_path, created_at FROM a2a_messages`);
      db.exec('DROP TABLE a2a_messages');
      db.exec('ALTER TABLE a2a_messages_new RENAME TO a2a_messages');
    });
  }
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
  // IMMEDIATE：事务一开始就拿写锁，「先查状态再改」在多进程下才是原子的（我们的事务都会写）
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
