import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deployOrg, rollbackOutDir } from '../modules/org/index.ts';

function makeOrg(dir: string, opts: { bad?: boolean } = {}): void {
  mkdirSync(join(dir, 'members'), { recursive: true });
  // bad: 故意漏必填字段，让 renderOrg 在写文件之前就抛
  writeFileSync(join(dir, 'company.md'), opts.bad
    ? '---\nname: 只有名字\n---\n'
    : [
      '---',
      'name: 示例公司',
      'company_bot_name: 公司bot',
      'vault_shared: \\\\host\\vault',
      'vault_internal: D:\\vault-internal',
      'local_workdir: D:\\work',
      '---',
      ''
    ].join('\n'), 'utf8');
  writeFileSync(join(dir, 'members', 'zhangsan.md'), [
    '---',
    'id: zhangsan',
    'name: 张三',
    'userid: u-zhangsan',
    'chat_id: chat-a',
    'webhook_file: wecom-webhook.txt',
    '---',
    ''
  ].join('\n'), 'utf8');
}

test('deploy：产物落盘并对拍通过，返回 verified 与 outputs 数量一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-deploy-'));
  try {
    const org = join(dir, 'org');
    const out = join(dir, 'out');
    makeOrg(org);
    const r = deployOrg(org, out);
    assert.equal(r.verified, r.outputs.length);
    assert.ok(r.outputs.length >= 2, '公司 persona + 成员 persona');
    for (const o of r.outputs) assert.ok(existsSync(o.file), o.file);
    assert.ok(existsSync(join(out, 'groups.json')));
    assert.ok(existsSync(join(out, 'manifest.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deploy：渲染失败时整体回滚，不留下半套产物', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-deploy-rb-'));
  try {
    const org = join(dir, 'org');
    const out = join(dir, 'out');
    makeOrg(org);
    deployOrg(org, out);
    const before = readFileSync(join(out, 'company-bot', 'CODEBUDDY.md'), 'utf8');
    const beforeGroups = readFileSync(join(out, 'groups.json'), 'utf8');

    // 把 org 改坏：缺必填字段 → renderOrg 抛错
    writeFileSync(join(org, 'company.md'), '---\nname: 只有名字\n---\n', 'utf8');
    assert.throws(() => deployOrg(org, out), /渲染失败，已回滚/);

    assert.equal(readFileSync(join(out, 'company-bot', 'CODEBUDDY.md'), 'utf8'), before, '旧产物必须原样');
    assert.equal(readFileSync(join(out, 'groups.json'), 'utf8'), beforeGroups, 'groups.json 必须原样');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rollback：把每个文件最新的 .bak 还原回去；dry-run 只报不动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-deploy-rb2-'));
  try {
    const org = join(dir, 'org');
    const out = join(dir, 'out');
    makeOrg(org);
    deployOrg(org, out);
    const target = join(out, 'company-bot', 'CODEBUDDY.md');
    const good = readFileSync(target, 'utf8');

    // 再部署一次 → 产生 .CODEBUDDY.md.bak-<stamp>（内容是 good）
    deployOrg(org, out);
    // 手改目标
    writeFileSync(target, good + '\n手加一行\n', 'utf8');
    assert.notEqual(readFileSync(target, 'utf8'), good);

    // dry-run 不动文件
    const dry = rollbackOutDir(out, { dryRun: true });
    assert.ok(dry.restored.length >= 1);
    assert.notEqual(readFileSync(target, 'utf8'), good, 'dry-run 不应该改文件');

    // 真回滚
    const r = rollbackOutDir(out);
    assert.ok(r.restored.length >= 1);
    assert.equal(r.skipped.length, 0);
    assert.equal(readFileSync(target, 'utf8'), good, '必须恢复到备份内容');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rollback：没有备份时不做事、不抛错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-deploy-rb3-'));
  try {
    mkdirSync(join(dir, 'empty'), { recursive: true });
    const r = rollbackOutDir(join(dir, 'empty'));
    assert.equal(r.restored.length, 0);
    assert.equal(r.skipped.length, 0);
    assert.deepEqual(readdirSync(join(dir, 'empty')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
