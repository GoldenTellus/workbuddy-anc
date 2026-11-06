import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deployOrg } from '../modules/org/index.ts';

function orgWith(dir: string, members: Array<{ id: string; name: string; userid?: string; disabled?: boolean }>): void {
  mkdirSync(join(dir, 'members'), { recursive: true });
  writeFileSync(join(dir, 'company.md'), [
    '---',
    'name: 示例公司',
    'company_bot_name: 公司bot',
    'vault_shared: \\\\host\\vault',
    'vault_internal: D:\\vault-internal',
    'local_workdir: D:\\work',
    '---',
    ''
  ].join('\n'), 'utf8');
  for (const m of members) {
    const lines = ['---', 'id: ' + m.id, 'name: ' + m.name];
    if (m.userid) lines.push('userid: ' + m.userid);
    if (m.disabled) lines.push('disabled: true');
    lines.push('---', '');
    writeFileSync(join(dir, 'members', m.id + '.md'), lines.join('\n'), 'utf8');
  }
}

test('停用成员：不出 persona、不进 groups.json、旧产物被清掉', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-offboard-'));
  try {
    const org = join(dir, 'org');
    const out = join(dir, 'out');

    // 先按"两人在职"渲染一次，产生 zhangsan 的产物
    orgWith(org, [
      { id: 'zhangsan', name: '张三', userid: 'u-zhang' },
      { id: 'lisi', name: '李四', userid: 'u-li' }
    ]);
    const first = deployOrg(org, out);
    assert.equal(first.members, 2);
    assert.equal(first.removed.length, 0);
    assert.ok(existsSync(join(out, 'members', 'zhangsan', 'CODEBUDDY.md')));

    // 张三离职
    orgWith(org, [
      { id: 'zhangsan', name: '张三', userid: 'u-zhang', disabled: true },
      { id: 'lisi', name: '李四', userid: 'u-li' }
    ]);
    const second = deployOrg(org, out);

    assert.equal(second.members, 1, '只剩在职成员');
    assert.deepEqual(second.removed, ['zhangsan'], '要报告清掉了谁的产物');
    assert.ok(!existsSync(join(out, 'members', 'zhangsan')), '停用成员的产物目录必须删掉');
    assert.ok(existsSync(join(out, 'members', 'lisi', 'CODEBUDDY.md')), '在职成员不受影响');

    const groups = JSON.parse(readFileSync(join(out, 'groups.json'), 'utf8')) as { members: Array<{ id: string }> };
    assert.deepEqual(groups.members.map((m) => m.id), ['lisi'], 'groups.json 不能留离职成员（否则 bind import 会给他建绑定）');
    assert.ok(second.warnings.some((w) => w.includes('停用')), '要在 warnings 里说出来');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('成员文件被删掉（不是 disabled）：残留 persona 产物要被清掉', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-orphan-'));
  try {
    const org = join(dir, 'org');
    const out = join(dir, 'out');
    orgWith(org, [
      { id: 'zhangsan', name: '张三', userid: 'u-zhang' },
      { id: 'lisi', name: '李四', userid: 'u-li' }
    ]);
    const first = deployOrg(org, out);
    assert.deepEqual(first.pruned, []);
    assert.ok(existsSync(join(out, 'members', 'zhangsan', 'CODEBUDDY.md')));

    // 手滑删掉 members/zhangsan.md —— 不是离职，org 里压根没这个人了
    rmSync(join(org, 'members', 'zhangsan.md'));
    const second = deployOrg(org, out);
    assert.deepEqual(second.pruned, ['zhangsan'], '要报告清掉了谁的残留产物');
    assert.ok(!existsSync(join(out, 'members', 'zhangsan')), '不存在的人不能留着 persona');
    assert.ok(existsSync(join(out, 'members', 'lisi', 'CODEBUDDY.md')), '在职成员不受影响');

    // 不是渲染器产出的目录不能被误删
    mkdirSync(join(out, 'members', 'not-a-person'), { recursive: true });
    writeFileSync(join(out, 'members', 'not-a-person', 'keep.txt'), 'x', 'utf8');
    const third = deployOrg(org, out);
    assert.ok(!third.pruned.includes('not-a-person'), '陌生目录不能删');
    assert.ok(existsSync(join(out, 'members', 'not-a-person', 'keep.txt')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('停用成员：disabled 只认字符串 true，写 1/yes 不生效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-offboard2-'));
  try {
    const org = join(dir, 'org');
    const out = join(dir, 'out');
    mkdirSync(join(org, 'members'), { recursive: true });
    writeFileSync(join(org, 'company.md'), [
      '---',
      'name: 示例公司',
      'company_bot_name: 公司bot',
      'vault_shared: \\\\host\\vault',
      'vault_internal: D:\\vault-internal',
      'local_workdir: D:\\work',
      '---',
      ''
    ].join('\n'), 'utf8');
    // disabled: 1 —— 不是字符串 true，应视为在职
    writeFileSync(join(org, 'members', 'wangwu.md'), ['---', 'id: wangwu', 'name: 王五', 'userid: u-wang', 'disabled: 1', '---', ''].join('\n'), 'utf8');
    const r = deployOrg(org, out);
    assert.equal(r.members, 1, 'disabled: 1 不能把人在职状态弄错');
    assert.ok(existsSync(join(out, 'members', 'wangwu', 'CODEBUDDY.md')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
