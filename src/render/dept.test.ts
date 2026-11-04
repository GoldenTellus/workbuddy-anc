// 部门（dept）的行为测试。
//
// 部门存在的意义是**收窄范围**：一个员工属于某部门时，他只能看到该部门的 vault 目录、
// 只用该部门的技能。所以这些测试的重点不是"字段读进来了没有"，而是：
//   1. 引用了不存在的部门必须报错（否则技能集和路径静默落空，行为与预期不符）
//   2. 部门确实影响产物（groups.json 和 persona 都要变）
//   3. 没有部门的 org 照样能渲染（向后兼容——老 org 不该因为新字段而坏掉）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrg, splitList } from './org.ts';
import { renderOrg } from './index.ts';

const COMPANY = [
  '---',
  'name: 测试公司',
  'company_bot_name: 小助',
  'vault_shared: \\\\host\\vault',
  'vault_internal: \\\\host\\internal',
  'local_workdir: C:\\work',
  '---',
  '',
].join('\n');

function mkOrg(dir: string, opts: { members?: string[]; depts?: Array<[string, string]> } = {}): string {
  const org = join(dir, 'org');
  mkdirSync(join(org, 'members'), { recursive: true });
  mkdirSync(join(org, 'roles'), { recursive: true });
  writeFileSync(join(org, 'company.md'), COMPANY);
  writeFileSync(join(org, 'roles', 'eng.md'), '---\nid: eng\nname: 工程师\nduties: 写代码\n---\n');
  if (opts.depts) {
    mkdirSync(join(org, 'depts'), { recursive: true });
    for (const [file, body] of opts.depts) writeFileSync(join(org, 'depts', file), body);
  }
  for (const m of opts.members ?? []) {
    const id = m.match(/^id:\s*(\S+)/m)?.[1] ?? 'x';
    writeFileSync(join(org, 'members', id + '.md'), m);
  }
  return org;
}

function withTmp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'anc-dept-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const MEMBER_PLAIN = '---\nid: zhangsan\nname: 张三\nrole: eng\nuserid: uid-zs\nchat_id: chat-1\n---\n';
const MEMBER_WITH_DEPT = '---\nid: zhangsan\nname: 张三\nrole: eng\nuserid: uid-zs\nchat_id: chat-1\ndept: engineering\n---\n';
const DEPT_ENG = '---\nid: engineering\nname: 研发部\nvault_paths: shared/工艺, internal/研发\nskills: anc-task, anc-vault-read\n---\n';

test('splitList：逗号分隔的字符串拆成数组，空值返回空数组', () => {
  assert.deepEqual(splitList('a, b , c'), ['a', 'b', 'c']);
  assert.deepEqual(splitList(''), []);
  assert.deepEqual(splitList(undefined), []);
  assert.deepEqual(splitList('  '), []);
  assert.deepEqual(splitList('single'), ['single']);
});

test('loadOrg：没有 depts/ 目录时 depts 是空 Map（向后兼容老 org）', () => {
  withTmp((d) => {
    const org = mkOrg(d, { members: [MEMBER_PLAIN] });
    const o = loadOrg(org);
    assert.equal(o.depts.size, 0);
    assert.equal(o.members[0].dept, undefined);
  });
});

test('loadOrg：读得到部门，成员带上 dept', () => {
  withTmp((d) => {
    const org = mkOrg(d, { members: [MEMBER_WITH_DEPT], depts: [['engineering.md', DEPT_ENG]] });
    const o = loadOrg(org);
    assert.equal(o.depts.size, 1);
    const dept = o.depts.get('engineering');
    assert.equal(dept?.name, '研发部');
    assert.equal(dept?.skills, 'anc-task, anc-vault-read');
    assert.equal(o.members[0].dept, 'engineering');
  });
});

test('loadOrg：成员引用了不存在的部门要报错（关键：不能静默落空）', () => {
  withTmp((d) => {
    // 只有 engineering，成员却写 nonexistent
    const bad = MEMBER_WITH_DEPT.replace('dept: engineering', 'dept: nonexistent');
    const org = mkOrg(d, { members: [bad], depts: [['engineering.md', DEPT_ENG]] });
    assert.throws(() => loadOrg(org), /引用了不存在的部门.*nonexistent/s);
  });
});

test('loadOrg：部门缺 name 要报错', () => {
  withTmp((d) => {
    const noName = '---\nid: engineering\nskills: anc-task\n---\n';
    const org = mkOrg(d, { members: [MEMBER_WITH_DEPT], depts: [['engineering.md', noName]] });
    assert.throws(() => loadOrg(org), /部门缺少 name/);
  });
});

test('loadOrg：部门 id 不合规要报错（会进 groups.json 和 persona 文本）', () => {
  withTmp((d) => {
    const badId = '---\nid: Eng Team\nname: 研发部\n---\n';
    const org = mkOrg(d, { members: [], depts: [['x.md', badId]] });
    assert.throws(() => loadOrg(org), /部门 id 不合规/);
  });
});

test('loadOrg：部门里写未知字段要报错（拼错的键会被静默忽略）', () => {
  withTmp((d) => {
    const typo = '---\nid: engineering\nname: 研发部\nskill: anc-task\n---\n';   // skill 少了 s
    const org = mkOrg(d, { members: [], depts: [['engineering.md', typo]] });
    assert.throws(() => loadOrg(org), /不认识的字段.*skill/s);
  });
});

test('renderOrg：groups.json 带上部门的 skills 与 vault_paths', () => {
  withTmp((d) => {
    const org = mkOrg(d, { members: [MEMBER_WITH_DEPT], depts: [['engineering.md', DEPT_ENG]] });
    const out = join(d, 'out');
    renderOrg(org, out);
    const g = JSON.parse(readFileSync(join(out, 'groups.json'), 'utf8'));
    const m = g.members[0];
    assert.equal(m.dept, 'engineering');
    assert.equal(m.dept_name, '研发部');
    assert.deepEqual(m.skills, ['anc-task', 'anc-vault-read']);
    assert.deepEqual(m.vault_paths, ['shared/工艺', 'internal/研发']);
  });
});

test('renderOrg：persona 里写出部门、技能、vault 目录', () => {
  withTmp((d) => {
    const org = mkOrg(d, { members: [MEMBER_WITH_DEPT], depts: [['engineering.md', DEPT_ENG]] });
    const out = join(d, 'out');
    renderOrg(org, out);
    const p = readFileSync(join(out, 'members', 'zhangsan', 'CODEBUDDY.md'), 'utf8');
    assert.match(p, /你属于哪个部门/);
    assert.match(p, /部门：研发部/);
    assert.match(p, /技能：anc-task、anc-vault-read/);
    assert.match(p, /vault 目录：shared\/工艺、internal\/研发/);
    assert.match(p, /超出这个范围的请求，先问主人/);
  });
});

test('renderOrg：没分部门的成员给「没限制」措辞，不留空占位', () => {
  withTmp((d) => {
    const org = mkOrg(d, { members: [MEMBER_PLAIN] });
    const out = join(d, 'out');
    renderOrg(org, out);
    const p = readFileSync(join(out, 'members', 'zhangsan', 'CODEBUDDY.md'), 'utf8');
    assert.match(p, /未分部门/);
    assert.match(p, /技能：全部/);
    // 不能留 {{...}} 占位
    assert.doesNotMatch(p, /\{\{member_/);
    // groups.json 里 dept 是 null、skills 是空数组（表示没限制，不是没技能）
    const g = JSON.parse(readFileSync(join(out, 'groups.json'), 'utf8'));
    assert.equal(g.members[0].dept, null);
    assert.deepEqual(g.members[0].skills, []);
  });
});

test('renderOrg：改部门文件会让输入指纹变（否则手改检测会漏）', () => {
  withTmp((d) => {
    const org = mkOrg(d, { members: [MEMBER_WITH_DEPT], depts: [['engineering.md', DEPT_ENG]] });
    const out = join(d, 'out');
    const r1 = renderOrg(org, out);
    // 只改部门文件——成员没动
    writeFileSync(join(org, 'depts', 'engineering.md'), DEPT_ENG.replace('anc-task, anc-vault-read', 'anc-task'));
    const r2 = renderOrg(org, out);
    assert.notEqual(r1.inputSha, r2.inputSha, '改了 depts/ 必须让 inputSha 变');
  });
});

test('renderOrg：停用的成员不出 persona，即使他有部门', () => {
  withTmp((d) => {
    const disabled = MEMBER_WITH_DEPT.replace('dept: engineering', 'dept: engineering\ndisabled: true');
    const org = mkOrg(d, { members: [disabled], depts: [['engineering.md', DEPT_ENG]] });
    const out = join(d, 'out');
    renderOrg(org, out);
    assert.equal(existsSync(join(out, 'members', 'zhangsan')), false);
    const g = JSON.parse(readFileSync(join(out, 'groups.json'), 'utf8'));
    assert.equal(g.members.length, 0);
  });
});
