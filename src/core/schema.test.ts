import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import { migrate } from './migrate.ts';

test('schema：people / groups / manager_scopes 表存在，chat_bindings 兼容保留', () => {
  const db = openDb(':memory:');
  try {
    const names = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .map((r) => r.name),
    );
    for (const t of ['people', 'groups', 'manager_scopes', 'chat_bindings']) {
      assert.equal(names.has(t), true, `缺表: ${t}`);
    }
    const indexes = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>)
        .map((r) => r.name),
    );
    assert.equal(indexes.has('idx_groups_type'), true, '缺索引: idx_groups_type');
  } finally {
    db.close();
  }
});

test('schema：people.system_role 只接受 boss/manager/employee', () => {
  const db = openDb(':memory:');
  try {
    db.prepare("INSERT INTO people (person_id,name,system_role,created_at,updated_at) VALUES (?,?,?,?,?)")
      .run('p1', '张三', 'manager', '2026-11-07', '2026-11-07');
    assert.throws(
      () => db.prepare("INSERT INTO people (person_id,name,system_role,created_at,updated_at) VALUES (?,?,?,?,?)")
        .run('p2', '李四', 'owner', '2026-11-07', '2026-11-07'),
      /CHECK constraint failed/,
    );
  } finally {
    db.close();
  }
});

test('schema：groups.type 只接受四类群', () => {
  const db = openDb(':memory:');
  try {
    db.prepare("INSERT INTO groups (chat_id,type,created_at,updated_at) VALUES (?,?,?,?)")
      .run('c1', 'company', '2026-11-07', '2026-11-07');
    assert.throws(
      () => db.prepare("INSERT INTO groups (chat_id,type,created_at,updated_at) VALUES (?,?,?,?)")
        .run('c2', 'team', '2026-11-07', '2026-11-07'),
      /CHECK constraint failed/,
    );
  } finally {
    db.close();
  }
});

test('schema：旧 reports 表迁到含 question 的 CHECK，旧行保留', () => {
  const db = openDb(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = OFF');   // 测试用假 assignment/ticket id；生产库有真实外键
    db.exec('DROP TABLE reports');
    db.exec(`CREATE TABLE reports (
      report_id TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      department_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped')),
      summary TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      next_step TEXT,
      late INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`);
    db.prepare("INSERT INTO reports (report_id,assignment_id,ticket_id,department_id,type,summary,created_at) VALUES (?,?,?,?,?,?,?)")
      .run('r-old', 'a-old', 't-old', 'sales', 'ready', '旧回报', '2026-11-01T00:00:00.000Z');

    migrate(db);

    const n = (db.prepare('SELECT COUNT(*) AS n FROM reports').get() as { n: number }).n;
    assert.equal(Number(n), 1);
    db.prepare("INSERT INTO reports (report_id,assignment_id,ticket_id,department_id,type,summary,created_at) VALUES (?,?,?,?,?,?,?)")
      .run('r-new', 'a-new', 't-new', 'sales', 'question', '需要人回答', '2026-11-09T00:00:00.000Z');
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='reports'").get() as { sql: string }).sql;
    assert.match(sql, /'question'/);
  } finally {
    db.close();
  }
});
