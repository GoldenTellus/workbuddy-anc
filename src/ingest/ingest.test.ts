import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyBatch, archiveBatch, failBatch } from './apply.ts';
import { commitVault } from './git.ts';
import { normalizeTarget, blobHash, IngestError } from './validate.ts';

const MD = '---\ntitle: 测试\nsource_file: _originals/x.pdf\nupdated_at: 2026-10-31\n---\n\n正文\n';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'anc-ingest-'));
  const vault = join(dir, 'vault');
  const batch = join(dir, 'batch');
  mkdirSync(vault, { recursive: true });
  mkdirSync(batch, { recursive: true });
  return { dir, vault, batch };
}

function meta(batch: string, files: unknown[]) {
  writeFileSync(join(batch, 'meta.json'), JSON.stringify({ batch_id: 'b1', files }), 'utf8');
}

test('入库：新 markdown + 原件', () => {
  const { dir, vault, batch } = setup();
  try {
    writeFileSync(join(batch, 'a.md'), MD, 'utf8');
    writeFileSync(join(batch, 'x.pdf'), Buffer.from('%PDF-1.4 test'));
    meta(batch, [
      { src: 'a.md', target: 'company/术语.md', kind: 'markdown' },
      { src: 'x.pdf', target: '_originals/x.pdf', kind: 'original' },
    ]);
    const r = applyBatch(batch, vault);
    assert.deepEqual(r.added, ['company/术语.md']);
    assert.deepEqual(r.originals, ['_originals/x.pdf']);
    assert.equal(readFileSync(join(vault, 'company/术语.md'), 'utf8'), MD);
    assert.ok(existsSync(join(vault, '_originals/x.pdf')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('入库：覆盖必须带正确 base hash', () => {
  const { dir, vault, batch } = setup();
  try {
    mkdirSync(join(vault, 'company'), { recursive: true });
    writeFileSync(join(vault, 'company/术语.md'), MD, 'utf8');
    writeFileSync(join(batch, 'a.md'), MD.replace('正文', '新正文'), 'utf8');

    meta(batch, [{ src: 'a.md', target: 'company/术语.md', kind: 'markdown' }]);
    assert.throws(() => applyBatch(batch, vault), (e: unknown) => (e as IngestError).code === 'NEED_BASE_HASH');

    meta(batch, [{ src: 'a.md', target: 'company/术语.md', kind: 'markdown', base_hash: 'deadbeef' }]);
    assert.throws(() => applyBatch(batch, vault), (e: unknown) => (e as IngestError).code === 'BASE_HASH_MISMATCH');

    const okHash = blobHash(Buffer.from(MD));
    meta(batch, [{ src: 'a.md', target: 'company/术语.md', kind: 'markdown', base_hash: okHash }]);
    const r = applyBatch(batch, vault);
    assert.deepEqual(r.modified, ['company/术语.md']);
    assert.match(readFileSync(join(vault, 'company/术语.md'), 'utf8'), /新正文/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('入库：路径穿越与保留名被拒', () => {
  const { dir, vault, batch } = setup();
  try {
    writeFileSync(join(batch, 'a.md'), MD, 'utf8');
    for (const target of ['../evil.md', 'C:/evil.md', 'company/CON.md', 'company/x:.md', 'company/..']) {
      meta(batch, [{ src: 'a.md', target, kind: 'markdown' }]);
      assert.throws(() => applyBatch(batch, vault), (e: unknown) => (e as IngestError).code === 'BAD_PATH', target);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('入库：原件已存在则拒绝', () => {
  const { dir, vault, batch } = setup();
  try {
    mkdirSync(join(vault, '_originals'), { recursive: true });
    writeFileSync(join(vault, '_originals/x.pdf'), 'old');
    writeFileSync(join(batch, 'x.pdf'), 'new');
    meta(batch, [{ src: 'x.pdf', target: '_originals/x.pdf', kind: 'original' }]);
    assert.throws(() => applyBatch(batch, vault), (e: unknown) => (e as IngestError).code === 'ORIGINAL_EXISTS');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('入库：缺 frontmatter 被拒，且不落盘', () => {
  const { dir, vault, batch } = setup();
  try {
    writeFileSync(join(batch, 'a.md'), '# 没有 frontmatter\n', 'utf8');
    meta(batch, [{ src: 'a.md', target: 'company/无头.md', kind: 'markdown' }]);
    assert.throws(() => applyBatch(batch, vault), (e: unknown) => (e as IngestError).code === 'BAD_FRONTMATTER');
    assert.ok(!existsSync(join(vault, 'company/无头.md')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizeTarget：合法路径通过', () => {
  assert.equal(normalizeTarget('company\\术语.md'), 'company/术语.md');
  assert.equal(normalizeTarget('skills/anc-task/SKILL.md'), 'skills/anc-task/SKILL.md');
});

test('归档：成功进 done，失败进 failed 并写 reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-arch-'));
  const inbox = join(dir, 'inbox');
  const b1 = join(inbox, 'pending', 'b1');
  const b2 = join(inbox, 'pending', 'b2');
  mkdirSync(b1, { recursive: true });
  mkdirSync(b2, { recursive: true });
  writeFileSync(join(b1, 'a.md'), 'x');
  writeFileSync(join(b2, 'a.md'), 'x');
  try {
    const done = archiveBatch(b1, inbox);
    assert.ok(existsSync(join(done, 'a.md')));
    assert.ok(!existsSync(b1));

    const failed = failBatch(b2, inbox, 'BAD_PATH: ../x');
    assert.ok(existsSync(join(failed, 'a.md')));
    assert.match(readFileSync(join(failed, 'reason.txt'), 'utf8'), /BAD_PATH/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('提交：--commit 生成提交，无改动返回 null', () => {
  const { dir, vault, batch } = setup();
  try {
    execFileSync('git', ['init', '-q'], { cwd: vault });
    writeFileSync(join(batch, 'a.md'), MD, 'utf8');
    meta(batch, [{ src: 'a.md', target: 'company/术语.md', kind: 'markdown' }]);
    applyBatch(batch, vault);

    const hash = commitVault(vault, 'ingest: company/术语.md');
    assert.ok(hash && /^[0-9a-f]{7,}$/.test(hash));
    const msg = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: vault, encoding: 'utf8' }).trim();
    assert.equal(msg, 'ingest: company/术语.md');

    assert.equal(commitVault(vault, 'again'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
