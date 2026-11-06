import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../core/index.ts';
import * as tasks from '../modules/tasks/index.ts';
import * as project from '../modules/runtime/index.ts';

test('投影：生成 markdown、幂等、check 能识别缺失与手改', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-proj-'));
  const db = openDb(join(dir, 'anc.db'));
  const internal = join(dir, 'vault-internal');
  try {
    tasks.createTask(db, { title: '写周报', chatId: 'chat-A', assignee: '张三', dueAt: '2026-11-03T10:00:00+08:00' });
    tasks.createTask(db, { title: '采购 | 清单\n第二行', chatId: 'chat-A' });

    // 第一次：生成
    const r1 = project.writeProjection(db, internal);
    assert.equal(r1.changed, true);
    assert.equal(r1.rows, 2);
    const md = readFileSync(r1.path, 'utf8');
    assert.match(md, /# 任务快照/);
    assert.match(md, /写周报/);
    assert.match(md, /采购 \\\| 清单 第二行/, '标题里的竖线和换行必须转义');
    assert.doesNotMatch(md, /生成时间/, '投影里不能有时间戳，否则永远判 stale');

    // 第二次：同样数据不应改动
    const r2 = project.writeProjection(db, internal);
    assert.equal(r2.changed, false, '同库状态必须生成同样字节');

    // check 通过
    assert.equal(project.checkProjection(db, internal).ok, true);

    // 手改 → stale
    writeFileSync(r1.path, md + '\n手加一行\n', 'utf8');
    const c1 = project.checkProjection(db, internal);
    assert.equal(c1.ok, false);
    assert.match(c1.reason!, /不一致/);

    // 删掉 → 缺失，重建后恢复
    rmSync(r1.path, { force: true });
    const c2 = project.checkProjection(db, internal);
    assert.equal(c2.ok, false);
    assert.match(c2.reason!, /不存在/);
    const rb = project.rebuildProjection(db, internal);
    assert.equal(rb.ok, true);
    assert.ok(existsSync(rb.path));

    // 库变了没重投影 → stale
    tasks.createTask(db, { title: '新任务', chatId: 'chat-A' });
    assert.equal(project.checkProjection(db, internal).ok, false);
    project.writeProjection(db, internal);
    assert.equal(project.checkProjection(db, internal).ok, true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('投影：状态与完成时间进表，内部区路径带 collab/', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-proj2-'));
  const db = openDb(join(dir, 'anc.db'));
  try {
    const t = tasks.createTask(db, { title: 'x', chatId: 'chat-A' });
    tasks.completeTask(db, t.id, { chatId: 'chat-A', text: '完成' }, undefined);
    const md = project.renderTasks(db);
    assert.match(md, /\| done \|/);
    assert.equal(project.projectionPath('D:\\anc\\vault-internal'), join('D:\\anc\\vault-internal', 'collab', 'tasks.md'));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
