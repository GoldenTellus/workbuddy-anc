import type { DatabaseSync } from 'node:sqlite';
import { tx } from './tx.ts';

/** 轻量迁移：只加列，不改旧数据。 */
export function migrate(db: DatabaseSync): void {
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
  addCol('tasks', 'requester_id', 'TEXT');
  addCol('tasks', 'assignee_id', 'TEXT');
  addCol('tasks', 'origin_group_id', 'TEXT');
  addCol('tasks', 'dept_id', 'TEXT');
  addCol('tasks', 'approver_id', 'TEXT');
  addCol('tasks', 'approved_at', 'TEXT');
  addCol('tasks', 'accepted_at', 'TEXT');
  addCol('tasks', 'accept_deadline', 'TEXT');
  addCol('tasks', 'approval_deadline', 'TEXT');
  addCol('tasks', 'reject_reason', 'TEXT');
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
