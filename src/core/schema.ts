// 全量 schema：只增不改。已有库的新列/主键变更走 migrate.ts 的 addCol / 重建逻辑。
export const SCHEMA = `
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

-- 主干 1：人、群、管理者范围。
-- chat_bindings 保留做员工群兼容层；新代码优先读 people/groups。
CREATE TABLE IF NOT EXISTS people (
  person_id   TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  userid      TEXT UNIQUE,
  system_role TEXT NOT NULL DEFAULT 'employee'
              CHECK (system_role IN ('boss', 'manager', 'employee')),
  dept_id     TEXT,
  status      TEXT NOT NULL DEFAULT 'active',   -- active | disabled
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  chat_id     TEXT PRIMARY KEY,
  type        TEXT NOT NULL
              CHECK (type IN ('employee', 'department', 'company', 'boss_dm')),
  employee_id TEXT,                              -- employee 群：该员工 person_id
  dept_id     TEXT,                              -- department 群：该部门 id
  name        TEXT,
  webhook_file TEXT,                              -- 出站 webhook 文件名（secrets 目录下）
  status      TEXT NOT NULL DEFAULT 'active',    -- active | disabled
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_groups_type ON groups(type, status);

CREATE TABLE IF NOT EXISTS manager_scopes (
  person_id  TEXT NOT NULL,
  dept_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (person_id, dept_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL,
  chat_id        TEXT,
  assignee       TEXT,
  requester      TEXT,
  due_at         TEXT,
  status         TEXT NOT NULL DEFAULT 'open',      -- open | pending_approval | pending_acceptance | done | cancelled | rejected | needs_review
  policy_version TEXT,
  rule_hash      TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  completed_at   TEXT,
  requester_id   TEXT,
  assignee_id    TEXT,
  origin_group_id TEXT,
  dept_id        TEXT,
  approver_id    TEXT,
  approved_at    TEXT,
  accepted_at    TEXT,
  accept_deadline TEXT,
  approval_deadline TEXT,
  reject_reason  TEXT
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
