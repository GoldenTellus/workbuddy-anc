import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPackage, verifyInstall } from './onboard.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'anc-onboard-'));
  const pkg = join(dir, 'pkg');
  const home = join(dir, 'home');
  mkdirSync(pkg, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(pkg, 'CODEBUDDY.md'), '# 个人 bot\n\n指纹 <!-- anc:input-sha256:abc -->\n', 'utf8');
  return { dir, pkg, home };
}

function makeCards(dir: string) {
  mkdirSync(join(dir, 'anc-vault-read'), { recursive: true });
  writeFileSync(join(dir, 'anc-vault-read', 'SKILL.md'), '# 名片\n\n库在 {{vault_shared}}\n', 'utf8');
}

test('接入：装 persona 与名片，写安装记录', () => {
  const { dir, pkg, home } = setup();
  const cards = join(dir, 'cards');
  makeCards(cards);
  try {
    const r = installPackage({ packageDir: pkg, homeDir: home, cardsDir: cards, vaultShared: '\\\\host\\vault' });
    assert.ok(existsSync(r.persona));
    assert.equal(r.cards.length, 1);
    const card = readFileSync(join(home, '.workbuddy', 'skills', 'anc-vault-read', 'SKILL.md'), 'utf8');
    assert.match(card, /host\\vault/);
    assert.ok(existsSync(r.record));
    assert.deepEqual(verifyInstall(home), { ok: true, changed: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('接入：已存在 persona 时必须 --adopt，adopt 后先备份', () => {
  const { dir, pkg, home } = setup();
  try {
    installPackage({ packageDir: pkg, homeDir: home });
    assert.throws(() => installPackage({ packageDir: pkg, homeDir: home }), /--adopt/);
    const r = installPackage({ packageDir: pkg, homeDir: home, adopt: true });
    assert.equal(r.backedUp.length, 1);
    const backups = readdirSync(join(home, 'WorkBuddy', 'Claw')).filter((x) => x.includes('.bak-'));
    assert.equal(backups.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('接入：手改后 verify 能发现', () => {
  const { dir, pkg, home } = setup();
  const cards = join(dir, 'cards');
  makeCards(cards);
  try {
    installPackage({ packageDir: pkg, homeDir: home, cardsDir: cards });
    const f = join(home, 'WorkBuddy', 'Claw', 'CODEBUDDY.md');
    writeFileSync(f, readFileSync(f, 'utf8') + '\n手改\n', 'utf8');
    const v = verifyInstall(home);
    assert.equal(v.ok, false);
    assert.ok(v.changed.includes(f));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
