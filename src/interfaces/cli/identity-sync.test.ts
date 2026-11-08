import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../core/index.ts';
import { resolvePerson, resolveGroup, listManagerScopes, resolve, upsertPerson, bind } from '../../modules/identity/index.ts';
import { syncOrgIdentity, backfillFromBindings, verifyOrgIdentity } from './identity-sync.ts';

function withTmp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'anc-sync-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function mkOrg(dir: string): string {
  const org = join(dir, 'org');
  mkdirSync(join(org, 'members'), { recursive: true });
  mkdirSync(join(org, 'roles'), { recursive: true });
  mkdirSync(join(org, 'depts'), { recursive: true });
  writeFileSync(join(org, 'company.md'), [
    '---', 'name: 测试公司', 'company_bot_name: 小助', 'boss: boss',
    'company_group_chat_id: c-company', 'company_group_webhook_file: hook-company.txt',
    'boss_dm_chat_id: c-boss-dm', 'boss_dm_webhook_file: hook-boss.txt',
    'vault_shared: \\\\host\\vault', 'vault_internal: \\\\host\\internal', 'local_workdir: C:\\work',
    '---', '',
  ].join('\n'));
  writeFileSync(join(org, 'roles', 'eng.md'), '---\nid: eng\nname: 工程师\nduties: 写代码\n---\n');
  writeFileSync(join(org, 'depts', 'sales.md'), '---\nid: sales\nname: 销售部\nskills: anc-task\nchat_id: c-dept-sales\nwebhook_file: hook-dept.txt\n---\n');
  writeFileSync(join(org, 'members', 'boss.md'), '---\nid: boss\nname: 老板\nrole: eng\nuserid: uid-boss\nchat_id: c-boss\n---\n');
  writeFileSync(join(org, 'members', 'mgr.md'), '---\nid: mgr\nname: 经理\nrole: eng\nuserid: uid-mgr\nchat_id: c-mgr\ndept: sales\nmanages: sales\n---\n');
  writeFileSync(join(org, 'members', 'emp.md'), '---\nid: emp\nname: 员工\nrole: eng\nuserid: uid-emp\nchat_id: c-emp\ndept: sales\n---\n');
  return org;
}

test('syncOrgIdentity：org → people/groups/manager_scopes，并保留 chat_bindings 兼容', () => {
  withTmp((d) => {
    const db = openDb(':memory:');
    try {
      const r = syncOrgIdentity(db, mkOrg(d));
      assert.equal(r.people, 3);
      assert.equal(r.employeeGroups, 3);
      assert.equal(r.departmentGroups, 1);
      assert.equal(r.companyGroups, 1);
      assert.equal(r.bossDmGroups, 1);
      assert.equal(r.managers, 1);
      assert.equal(r.legacyBindings, 3);
      assert.equal(r.warnings.length, 0);

      assert.equal(resolveGroup(db, 'c-dept-sales')?.type, 'department');
      assert.equal(resolveGroup(db, 'c-company')?.type, 'company');
      assert.equal(resolveGroup(db, 'c-boss-dm')?.type, 'boss_dm');

      assert.equal(resolvePerson(db, 'boss')?.system_role, 'boss');
      assert.equal(resolvePerson(db, 'mgr')?.system_role, 'manager');
      assert.equal(resolvePerson(db, 'emp')?.system_role, 'employee');
      assert.deepEqual(listManagerScopes(db, 'mgr'), ['sales']);
      assert.equal(resolveGroup(db, 'c-mgr')?.type, 'employee');
      assert.equal(resolveGroup(db, 'c-mgr')?.employee_id, 'mgr');
      assert.equal(resolve(db, 'c-mgr')?.employee, '经理');
    } finally { db.close(); }
  });
});

test('syncOrgIdentity：缺 userid/chat_id 给 warning，不阻断其他人', () => {
  withTmp((d) => {
    const org = mkOrg(d);
    writeFileSync(join(org, 'members', 'emp.md'), '---\nid: emp\nname: 员工\nrole: eng\ndept: sales\n---\n');
    const db = openDb(':memory:');
    try {
      const r = syncOrgIdentity(db, org);
      assert.equal(r.people, 3);
      assert.equal(r.employeeGroups, 2);
      assert.ok(r.warnings.some((w) => w.includes('没有 userid')));
      assert.ok(r.warnings.some((w) => w.includes('没有 chat_id')));
      assert.equal(resolvePerson(db, 'emp')?.system_role, 'employee');
    } finally { db.close(); }
  });
});

test('backfillFromBindings：chat_bindings 按 userid 补 employee 群，不猜未知人', () => {
  const db = openDb(':memory:');
  try {
    upsertPerson(db, { personId: 'p1', name: '张三', userid: 'u1' });
    bind(db, 'c-old', '张三', 'legacy', 'u1');
    bind(db, 'c-unknown', '李四', 'legacy', 'u-missing');
    const r = backfillFromBindings(db);
    assert.equal(r.matchedPeople, 1);
    assert.equal(r.groupsCreated, 1);
    assert.equal(r.skipped, 1);
    assert.ok(r.warnings.some((w) => w.includes('u-missing')));
    assert.equal(resolveGroup(db, 'c-old')?.type, 'employee');
    assert.equal(resolveGroup(db, 'c-old')?.employee_id, 'p1');
    assert.equal(resolveGroup(db, 'c-unknown'), null);
  } finally { db.close(); }
});

test('verifyOrgIdentity：同步后通过；群里类型漂移要报出来', () => {
  withTmp((d) => {
    const db = openDb(':memory:');
    try {
      const org = mkOrg(d);
      syncOrgIdentity(db, org);
      const ok = verifyOrgIdentity(db, org);
      assert.equal(ok.ok, true, ok.problems.join('; '));

      const g = resolveGroup(db, 'c-dept-sales')!;
      // 故意把部门群改成公司群，模拟手工配错
      db.prepare("UPDATE groups SET type = 'company' WHERE chat_id = ?").run(g.chat_id);
      const bad = verifyOrgIdentity(db, org);
      assert.equal(bad.ok, false);
      assert.ok(bad.problems.some((p) => p.includes('部门群不一致')));
    } finally { db.close(); }
  });
});
