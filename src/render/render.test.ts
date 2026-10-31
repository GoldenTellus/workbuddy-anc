import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderTemplate, checkLength, writeAtomic } from './render.ts';
import { renderOrg } from './index.ts';

test('模板：占位符替换，未知占位符报错', () => {
  assert.equal(renderTemplate('你好 {{name}}', { name: '张三' }), '你好 张三');
  assert.throws(() => renderTemplate('{{missing}}', {}), /missing/);
});

test('长度闸门：6500 警告、7500 报错', () => {
  const w = checkLength('x'.repeat(6501));
  assert.equal(w.ok, true);
  assert.equal(w.warn, true);
  const e = checkLength('x'.repeat(7501));
  assert.equal(e.ok, false);
  assert.ok(Array.isArray(e.sections));
});

test('原子写：备份旧文件、写后无临时文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-w-'));
  try {
    const f = join(dir, 'a.md');
    writeAtomic(f, 'v1');
    writeAtomic(f, 'v2');
    assert.equal(readFileSync(f, 'utf8'), 'v2');
    const leftovers = readdirSync(dir).filter((x) => x.startsWith('.tmp-'));
    assert.deepEqual(leftovers, []);
    assert.ok(readdirSync(dir).some((x) => x.includes('.bak-')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeOrg(dir: string) {
  mkdirSync(join(dir, 'roles'), { recursive: true });
  mkdirSync(join(dir, 'members'), { recursive: true });
  writeFileSync(join(dir, 'company.md'), [
    '---',
    'name: 示例公司',
    'company_bot_name: 公司bot',
    "vault_shared: '\\\\主机\\anc-vault-shared'",
    "vault_internal: 'D:\\anc\\vault-internal'",
    "local_workdir: 'C:\\Users\\<用户>\\WorkBuddy\\Claw'",
    '---',
  ].join('\n'), 'utf8');
  writeFileSync(join(dir, 'roles', 'manager.md'), '---\nid: manager\nname: 负责人\n---\n', 'utf8');
  writeFileSync(join(dir, 'members', 'zhangsan.md'), [
    '---', 'id: zhangsan', 'name: 张三', 'role: manager', 'userid: u-zhang',
    'chat_id: chat-a', 'webhook_file: wecom-webhook.txt', '---',
  ].join('\n'), 'utf8');
}

test('渲染：公司 persona + 接入包 + groups.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-r-'));
  const org = join(dir, 'org');
  const out = join(dir, 'out');
  try {
    makeOrg(org);
    const r = renderOrg(org, out);
    assert.equal(r.members, 1);
    const company = readFileSync(join(out, 'company-bot', 'CODEBUDDY.md'), 'utf8');
    assert.match(company, /示例公司/);
    assert.match(company, /anc:input-sha256:[0-9a-f]{64}/);
    assert.ok(!company.includes('{{'));

    const member = readFileSync(join(out, 'members', 'zhangsan', 'CODEBUDDY.md'), 'utf8');
    assert.match(member, /张三/);
    assert.match(member, /u-zhang/);

    const groups = JSON.parse(readFileSync(join(out, 'groups.json'), 'utf8'));
    assert.equal(groups.members[0].chat_id, 'chat-a');
    assert.equal(groups.members[0].webhook_file, 'wecom-webhook.txt');
    assert.equal(groups.input_sha256, r.inputSha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('渲染：缺字段时报错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-r2-'));
  const org = join(dir, 'org');
  try {
    mkdirSync(org, { recursive: true });
    writeFileSync(join(org, 'company.md'), '---\nname: 只有名字\n---\n', 'utf8');
    assert.throws(() => renderOrg(org, join(dir, 'out')), /缺少字段/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('渲染：产物被手改后，指纹能发现', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-r3-'));
  const org = join(dir, 'org');
  const out = join(dir, 'out');
  try {
    makeOrg(org);
    renderOrg(org, out);
    const f = join(out, 'company-bot', 'CODEBUDDY.md');
    writeFileSync(f, readFileSync(f, 'utf8').replace('示例公司', '被改过的公司'), 'utf8');
    const again = renderOrg(org, out);
    assert.equal(again.tampered.length, 1);
    assert.equal(again.tampered[0], f);
    const now = readFileSync(f, 'utf8');
    assert.match(now, /anc:input-sha256:/);
    assert.match(now, /示例公司/);
    assert.equal(again.members, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('org：成员 id 重复要报错（否则渲染会互相覆盖）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-org-dup-'));
  try {
    writeFileSync(join(dir, 'company.md'), '---\nname: 示例\ncompany_bot_name: 公司bot\nvault_shared: \\\\host\\vault\nvault_internal: D:\\vault-internal\nlocal_workdir: D:\\work\n---\n');
    mkdirSync(join(dir, 'members'), { recursive: true });
    const body = '---\nid: same\nname: 张三\nrole: 销售\n---\n';
    writeFileSync(join(dir, 'members', 'a.md'), body);
    writeFileSync(join(dir, 'members', 'b.md'), body);
    assert.throws(() => renderOrg(dir, join(dir, 'out')), /成员 id 重复/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});