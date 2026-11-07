import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';

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
