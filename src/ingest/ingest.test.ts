import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyBatch, archiveBatch, failBatch, inferInbox } from '../modules/knowledge/ingest/apply.ts';
import { commitVault } from '../modules/knowledge/ingest/git.ts';
import { normalizeTarget, blobHash, IngestError } from '../modules/knowledge/ingest/validate.ts';

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
    for (const target of ['../evil.md', 'C:/evil.md', 'company/CON.md', 'company/x:.md', 'company/..', '.git/hooks/pre-commit', '.GIT/config', 'GIT~1/hooks/pre-commit', 'company/.git/x',
      'company/CONIN$.md', 'company/a?.md', 'company/a|b.md', 'company/a<b.md', 'company/a\u0001.md']) {
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

test('入库：meta.json 带 UTF-8 BOM 也能读', () => {
  const { dir, vault, batch } = setup();
  try {
    writeFileSync(join(batch, 'a.md'), MD, 'utf8');
    const metaObj = { batch_id: 'b-bom', files: [{ src: 'a.md', target: 'company/BOM.md', kind: 'markdown' }] };
    writeFileSync(join(batch, 'meta.json'), '\uFEFF' + JSON.stringify(metaObj), 'utf8');
    const r = applyBatch(batch, vault);
    assert.deepEqual(r.added, ['company/BOM.md']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inferInbox：从 pending 路径推断 inbox', () => {
  assert.equal(inferInbox('D:\\anc\\inbox\\pending\\b1'), 'D:\\anc\\inbox');
  assert.equal(inferInbox('D:/anc/inbox/pending/b1/'), 'D:/anc/inbox');
  assert.equal(inferInbox('D:\\tmp\\b1'), null);
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

    // 仓库里的 hook 不会被执行
    const marker = join(dir, 'hook-ran');
    writeFileSync(join(vault, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho x > "' + marker.replace(/\\/g, '/') + '"\n', 'utf8');
    // 本地配置显式指向仓库 hooks（盖过机器上的全局 hooksPath），没有防护时 hook 一定会跑
    execFileSync('git', ['config', 'core.hooksPath', '.git/hooks'], { cwd: vault });
    writeFileSync(join(batch, 'a.md'), MD.replace('术语', '术语二'), 'utf8');
    meta(batch, [{ src: 'a.md', target: 'company/术语二.md', kind: 'markdown' }]);
    applyBatch(batch, vault);
    assert.ok(commitVault(vault, 'ingest: hook test'));
    assert.ok(!existsSync(marker), 'pre-commit hook 不应被执行');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('越界 src 被拒：meta 指向批次目录之外', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-ing-tra-'));
  const batch = join(dir, 'pending', 'b1');
  const vault = join(dir, 'vault');
  mkdirSync(batch, { recursive: true });
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(dir, 'evil.md'), '---\ntitle: x\nsource_file: y\nupdated_at: 2026-01-01\n---\nbody\n');
  writeFileSync(join(batch, 'meta.json'), JSON.stringify({
    batch_id: 'b1',
    files: [{ src: '../../../evil.md', target: 'a/b.md', kind: 'markdown' }],
  }));
  try {
    assert.throws(() => applyBatch(batch, vault), (e: unknown) => e instanceof IngestError && (e as IngestError).code === 'BAD_PATH');
    assert.ok(!existsSync(join(vault, 'a', 'b.md')), '不应写盘');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
const codeOf = (c: string) => (e: unknown) => (e as IngestError).code === c;

test('入库：中途写失败时回滚已写入的文件，vault 不留半成品', () => {
  const { dir, vault, batch } = setup();
  try {
    writeFileSync(join(vault, 'blocker'), 'i am a file', 'utf8'); // 第二个目标的父路径是文件 → 写入必然失败
    writeFileSync(join(batch, 'a.md'), MD, 'utf8');
    writeFileSync(join(batch, 'b.md'), MD, 'utf8');
    meta(batch, [
      { src: 'a.md', target: 'company/新文件.md', kind: 'markdown' },
      { src: 'b.md', target: 'blocker/x.md', kind: 'markdown' },
    ]);
    assert.throws(() => applyBatch(batch, vault));
    assert.ok(!existsSync(join(vault, 'company/新文件.md')), '第一个文件应被回滚');
    assert.ok(!existsSync(join(vault, 'company')), '新建的目录也应清掉');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('入库：同一目标出现两次、vault 被占用（锁）都拒绝', () => {
  const { dir, vault, batch } = setup();
  try {
    writeFileSync(join(batch, 'a.md'), MD, 'utf8');
    meta(batch, [
      { src: 'a.md', target: 'company/x.md', kind: 'markdown' },
      { src: 'a.md', target: 'company/x.md', kind: 'markdown' },
    ]);
    assert.throws(() => applyBatch(batch, vault), codeOf('DUPLICATE_TARGET'));

    meta(batch, [{ src: 'a.md', target: 'company/x.md', kind: 'markdown' }]);
    writeFileSync(join(vault, '.anc-ingest.lock'), '', 'utf8');
    assert.throws(() => applyBatch(batch, vault), codeOf('VAULT_BUSY'));
    rmSync(join(vault, '.anc-ingest.lock'));
    applyBatch(batch, vault);
    assert.ok(!existsSync(join(vault, '.anc-ingest.lock')), '用完要释放锁');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('入库：批次内的 junction 指向批次外、vault 内的 junction 指向 vault 外，都拒绝', () => {
  const { dir, vault, batch } = setup();
  const outside = join(dir, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.md'), MD, 'utf8');
  try {
    try {
      symlinkSync(outside, join(batch, 'lnk'), 'junction');
      symlinkSync(outside, join(vault, 'vlnk'), 'junction');
    } catch {
      return; // 环境不允许建 junction 时跳过
    }
    meta(batch, [{ src: 'lnk/secret.md', target: 'company/x.md', kind: 'markdown' }]);
    assert.throws(() => applyBatch(batch, vault), codeOf('BAD_PATH'));

    writeFileSync(join(batch, 'a.md'), MD, 'utf8');
    meta(batch, [{ src: 'a.md', target: 'vlnk/pwn.md', kind: 'markdown' }]);
    assert.throws(() => applyBatch(batch, vault), codeOf('BAD_PATH'));
    assert.ok(!existsSync(join(outside, 'pwn.md')), '不能经 junction 写到 vault 外');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('提交：只提交本批文件，别的未复核改动不被带进去', () => {
  const { dir, vault, batch } = setup();
  try {
    execFileSync('git', ['init', '-q'], { cwd: vault });
    writeFileSync(join(vault, '别人的草稿.md'), 'draft', 'utf8');
    writeFileSync(join(batch, 'a.md'), MD, 'utf8');
    meta(batch, [{ src: 'a.md', target: 'company/本批.md', kind: 'markdown' }]);
    const r = applyBatch(batch, vault);
    assert.ok(commitVault(vault, 'ingest: 本批', [...r.added, ...r.modified]));
    const files = execFileSync('git', ['-c', 'core.quotepath=false', 'show', '--name-only', '--pretty=', 'HEAD'], { cwd: vault, encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(files, ['company/本批.md']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('提交：原件永不进 git（vault 有 .gitignore 时也不报错）', () => {
  const { dir, vault, batch } = setup();
  try {
    execFileSync('git', ['init', '-q'], { cwd: vault });
    writeFileSync(join(vault, '.gitignore'), '_originals/\n', 'utf8');
    writeFileSync(join(batch, 'a.md'), MD, 'utf8');
    writeFileSync(join(batch, 'x.pdf'), Buffer.from('%PDF-1.4'));
    meta(batch, [
      { src: 'a.md', target: 'company/术语.md', kind: 'markdown' },
      { src: 'x.pdf', target: '_originals/x.pdf', kind: 'original' },
    ]);
    const r = applyBatch(batch, vault);
    const hash = commitVault(vault, 'ingest: ' + r.added.join(','), [...r.added, ...r.modified]);
    assert.ok(hash);
    const tracked = execFileSync('git', ['ls-files', '_originals'], { cwd: vault, encoding: 'utf8' }).trim();
    assert.equal(tracked, '', '原件不得进 git');
    assert.ok(existsSync(join(vault, '_originals/x.pdf')), '原件仍应在磁盘');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('提交：把 _originals 传给 commitVault 必须被拒（D14）', () => {
  const { dir, vault } = setup();
  try {
    execFileSync('git', ['init', '-q'], { cwd: vault });
    assert.throws(() => commitVault(vault, 'x', ['_originals/a.pdf']), /_originals/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('锁：残留锁（pid 不存在）可接管；活锁仍拒绝', () => {
  const { dir, vault, batch } = setup();
  try {
    mkdirSync(join(vault, '.git'), { recursive: true });
    writeFileSync(join(vault, 'a.md'), MD, 'utf8');
    writeFileSync(join(batch, 'a.md'), MD, 'utf8');
    meta(batch, [{ src: 'a.md', target: 'company/a.md', kind: 'markdown' }]);
    const lock = join(vault, '.git', 'anc-ingest.lock');
    writeFileSync(lock, JSON.stringify({ pid: 999999, started_at: '2020-01-01T00:00:00.000Z' }), 'utf8');
    const r = applyBatch(batch, vault);
    assert.deepEqual(r.added, ['company/a.md']);
    meta(batch, [{ src: 'a.md', target: 'company/b.md', kind: 'markdown' }]);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), 'utf8');
    assert.throws(() => applyBatch(batch, vault), (e: unknown) => (e as IngestError).code === 'VAULT_BUSY');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
