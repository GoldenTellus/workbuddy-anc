import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../core/index.ts';
import {
  upsertPerson,
  resolvePersonByUserid,
  upsertGroup,
  resolveGroup,
  listGroups,
  setManagerScopes,
  listManagerScopes,
  resolveActor,
  resolvePrivateChat,
} from './groups.ts';

function db() {
  return openDb(':memory:');
}

test('people：按 userid 解析，更新角色/部门', () => {
  const d = db();
  try {
    const p = upsertPerson(d, {
      personId: 'zhangsan', name: '张三', userid: 'uid-zs',
      systemRole: 'manager', deptId: 'sales',
    });
    assert.equal(p.system_role, 'manager');
    assert.equal(p.dept_id, 'sales');
    assert.equal(resolvePersonByUserid(d, 'uid-zs')?.person_id, 'zhangsan');

    const p2 = upsertPerson(d, {
      personId: 'zhangsan', name: '张三', userid: 'uid-zs',
      systemRole: 'employee', deptId: 'engineering',
    });
    assert.equal(p2.system_role, 'employee');
    assert.equal(p2.dept_id, 'engineering');
  } finally { d.close(); }
});

test('people：mention_userid 只接受企微 userid 字符集（≤64），空串清空', () => {
  const d = db();
  try {
    const p = upsertPerson(d, {
      personId: 'zhangsan', name: '张三', userid: 'uid-zs', mentionUserid: 'zhang.san@corp',
    });
    assert.equal(p.mention_userid, 'zhang.san@corp');
    assert.equal(resolvePersonByUserid(d, 'uid-zs')?.mention_userid, 'zhang.san@corp');

    // 空串 = 清空：org 删掉 mention_userid 后同步要能回退到「不 @」
    assert.equal(upsertPerson(d, {
      personId: 'zhangsan', name: '张三', userid: 'uid-zs', mentionUserid: '',
    }).mention_userid, null);

    for (const bad of ['zhang san', '张三', 'a'.repeat(65), 'zhang/../x', 'a"b']) {
      assert.throws(
        () => upsertPerson(d, { personId: 'zhangsan', name: '张三', mentionUserid: bad }),
        /mention_userid 不合规/,
        bad,
      );
    }
  } finally { d.close(); }
});

test('groups：四类群 + 约束', () => {
  const d = db();
  try {
    upsertGroup(d, { chatId: 'c-emp', type: 'employee', employeeId: 'zhangsan' });
    upsertGroup(d, { chatId: 'c-dept', type: 'department', deptId: 'sales' });
    upsertGroup(d, { chatId: 'c-co', type: 'company' });
    upsertGroup(d, { chatId: 'c-boss', type: 'boss_dm' });

    assert.equal(resolveGroup(d, 'c-dept')?.dept_id, 'sales');
    assert.equal(listGroups(d, 'company').length, 1);

    assert.throws(
      () => upsertGroup(d, { chatId: 'bad-emp', type: 'employee' }),
      /employee 群必须有 employee_id/,
    );
    assert.throws(
      () => upsertGroup(d, { chatId: 'bad-dept', type: 'department' }),
      /department 群必须有 dept_id/,
    );
  } finally { d.close(); }
});

test('manager_scopes：全量替换并去重', () => {
  const d = db();
  try {
    upsertPerson(d, { personId: 'zhangsan', name: '张三', systemRole: 'manager' });
    setManagerScopes(d, 'zhangsan', ['sales', 'engineering', 'sales']);
    assert.deepEqual(listManagerScopes(d, 'zhangsan'), ['engineering', 'sales']);

    setManagerScopes(d, 'zhangsan', ['sales']);
    assert.deepEqual(listManagerScopes(d, 'zhangsan'), ['sales']);
  } finally { d.close(); }
});

test('resolveActor：群 + 人；缺任一返回 null，不猜', () => {
  const d = db();
  try {
    upsertPerson(d, { personId: 'zhangsan', name: '张三', userid: 'uid-zs' });
    upsertGroup(d, { chatId: 'c-emp', type: 'employee', employeeId: 'zhangsan' });
    const ok = resolveActor(d, 'c-emp', 'uid-zs');
    assert.equal(ok.group?.type, 'employee');
    assert.equal(ok.person?.person_id, 'zhangsan');

    assert.equal(resolveActor(d, 'missing', 'uid-zs').group, null);
    assert.equal(resolveActor(d, 'c-emp', 'uid-other').person, null);
  } finally { d.close(); }
});

test('resolvePrivateChat：员工群 / boss_dm；缺失返回 null', () => {
  const d = db();
  try {
    upsertGroup(d, { chatId: 'c-emp', type: 'employee', employeeId: 'zhangsan' });
    upsertGroup(d, { chatId: 'c-boss', type: 'boss_dm' });
    assert.equal(resolvePrivateChat(d, 'zhangsan', 'employee'), 'c-emp');
    assert.equal(resolvePrivateChat(d, 'lisi', 'employee'), null);
    assert.equal(resolvePrivateChat(d, 'zhangsan', 'boss_dm'), 'c-boss');
  } finally { d.close(); }
});
