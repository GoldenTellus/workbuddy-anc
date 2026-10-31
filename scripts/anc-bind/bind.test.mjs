// anc-bind 的最小回归：用临时库跑 bind / resolve / rebind / unbind / list
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'bind.mjs');

function run(args, db) {
  return execFileSync(process.execPath, [CLI, ...args, '--db', db, '--json'], { encoding: 'utf8' });
}

test('bind → resolve → rebind → unbind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-bind-'));
  const db = join(dir, 'anc.db');
  try {
    const b = JSON.parse(run(['bind', '--chat-id', 'chat-A', '--employee', '张三'], db));
    assert.equal(b.ok, true);
    assert.equal(b.action, 'created');

    const r = JSON.parse(run(['resolve', '--chat-id', 'chat-A'], db));
    assert.equal(r.found, true);
    assert.equal(r.employee, '张三');

    const b2 = JSON.parse(run(['bind', '--chat-id', 'chat-A', '--employee', '李四'], db));
    assert.equal(b2.action, 'updated');

    const r2 = JSON.parse(run(['resolve', '--chat-id', 'chat-A'], db));
    assert.equal(r2.employee, '李四');

    const list = JSON.parse(run(['list'], db));
    assert.equal(list.count, 1);

    const u = JSON.parse(run(['unbind', '--chat-id', 'chat-A'], db));
    assert.equal(u.removed, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolve 未知 chat 返回 found=false 且退出码 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-bind-'));
  const db = join(dir, 'anc.db');
  try {
    let code = 0;
    try { run(['resolve', '--chat-id', 'nope'], db); } catch (e) { code = e.status; }
    assert.equal(code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('缺参数直接报错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-bind-'));
  const db = join(dir, 'anc.db');
  try {
    let code = 0;
    try { run(['bind', '--chat-id', 'x'], db); } catch (e) { code = e.status; }
    assert.equal(code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
