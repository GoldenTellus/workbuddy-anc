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

-- 迭代闭环的收集端（PLAN 阶段 L1）。
-- 只做一件事：把员工在群里报的问题**原话照存**，等有人早上看。
-- 不判断该不该修、不评估工作量、不建议方案——那些是 review 的人干的。
CREATE TABLE IF NOT EXISTS submissions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT UNIQUE,                       -- 同一群里同一句话只记一次
  chat_id    TEXT,
  employee   TEXT,                              -- 从 chat_bindings 推，省得再问"你是谁"
  userid     TEXT,
  text       TEXT NOT NULL,                     -- 员工原话，不总结不改写
  file_path  TEXT,
  file_hash  TEXT,
  status     TEXT NOT NULL DEFAULT 'new',       -- new | triaged | dropped
  issue_id   INTEGER,                           -- L2 转成 issue 后回填
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status, id);

-- 迭代闭环的第二步（PLAN 阶段 L2）：submission → 结构化 issue。
-- 一条员工原话变成一个开发侧能直接动手的东西 {skill, section, symptom, expected, verify}。
-- 分诊靠规则表（issues.ts 的 RULES），不用模型——PLAN §5.1「确定性的事不交给模型」。
-- skill/section 可以为 null：规则表没命中时标成「待人工分诊」，不硬猜。
CREATE TABLE IF NOT EXISTS issues (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  skill         TEXT,
  section       TEXT,
  symptom       TEXT,
  expected      TEXT,
  verify        TEXT,
  status        TEXT NOT NULL DEFAULT 'open',   -- open | drafted | closed
  note          TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status, id);
CREATE INDEX IF NOT EXISTS idx_issues_submission ON issues(submission_id);

-- 迭代闭环的第三步（PLAN 阶段 L3）：issue → 一个可评审的 diff。
-- 只存 diff 与 base_hash，不直接改仓库文件——合不合由人决定。
-- base_hash 是生成那一刻源文件的 sha256：将来应用时用它判断"这期间文件被动过没有"。
CREATE TABLE IF NOT EXISTS patch_drafts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id   INTEGER NOT NULL,
  skill      TEXT,
  skill_path TEXT NOT NULL,
  section    TEXT,
  base_hash  TEXT NOT NULL,
  patch_hint TEXT NOT NULL,
  diff       TEXT NOT NULL,
  warnings   TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_patch_drafts_issue ON patch_drafts(issue_id);

-- 迭代闭环的第五步（PLAN 阶段 L5）：员工说「下班」的记录。
-- 纯记录，不调模型。用途有两个：
--   1. 人看：谁几点收的工
--   2. 机器看：全员都下班了 → 开夜间窗口（devbot 跑的时间）
-- day 按**本地日期**存（YYYY-MM-DD），因为"今天有没有说过下班"是按自然日算的。
CREATE TABLE IF NOT EXISTS dayend (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  employee   TEXT NOT NULL,
  userid     TEXT,
  chat_id    TEXT,
  note       TEXT,
  day        TEXT NOT NULL,
  at         TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dayend_uniq ON dayend(employee, day);
CREATE INDEX IF NOT EXISTS idx_dayend_day ON dayend(day, at);

-- 迭代闭环的第六步（PLAN 阶段 L6）：一条用例一次跑的结果。
-- checks 是 JSON 数组（每项 {name, ok, detail}），answer_hash 用来判断"两次回答是否同一份"。
CREATE TABLE IF NOT EXISTS eval_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id     TEXT NOT NULL,
  skill       TEXT,
  verdict     TEXT NOT NULL,
  checks      TEXT,
  answer_hash TEXT,
  answer_len  INTEGER,
  note        TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eval_runs_case ON eval_runs(case_id, id);
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

  // submissions 早期版本用的是 submitter_userid（stash 里那版）。
  // CREATE TABLE IF NOT EXISTS 对已存在的表是空操作，所以新列必须走迁移，
  // 否则 CLI 一插入就是 "no such column: userid"（2026-11-04 踩到）。
  addCol('submissions', 'userid', 'TEXT');
  addCol('submissions', 'file_hash', 'TEXT');
  addCol('submissions', 'issue_id', 'INTEGER');

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
