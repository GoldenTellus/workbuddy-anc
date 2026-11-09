import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../core/index.ts';
import { upsertPerson, setManagerScopes } from './groups.ts';
import {
  priorityFor, isBoss, isManager, canManageDept, canAssignTo,
  canApproveCrossDept, canViewTask, canConfirmAttention, canStopTask,
} from './policy.ts';

function setup() {
  const db = openDb(':memory:');
  const boss = upsertPerson(db, { personId: 'boss', name: '老板', systemRole: 'boss' });
  const mgr = upsertPerson(db, { personId: 'mgr', name: '销售经理', systemRole: 'manager', deptId: 'sales' });
  const emp = upsertPerson(db, { personId: 'emp', name: '销售员工', systemRole: 'employee', deptId: 'sales' });
  const other = upsertPerson(db, { personId: 'other', name: '研发员工', systemRole: 'employee', deptId: 'engineering' });
  setManagerScopes(db, 'mgr', ['sales']);
  return { db, boss, mgr, emp, other };
}

test('policy：角色优先级 boss P0 / manager P1 / employee P2', () => {
  const { db, boss, mgr, emp } = setup();
  try {
    assert.equal(priorityFor(boss), 'P0');
    assert.equal(priorityFor(mgr), 'P1');
    assert.equal(priorityFor(emp), 'P2');
    assert.equal(isBoss(boss), true);
    assert.equal(isManager(db, mgr), true);
    assert.equal(isManager(db, emp), false);
  } finally { db.close(); }
});

test('policy：管理者只看本部门；老板看全部', () => {
  const { db, boss, mgr, emp, other } = setup();
  try {
    assert.equal(canManageDept(db, boss, 'engineering'), true);
    assert.equal(canManageDept(db, mgr, 'sales'), true);
    assert.equal(canManageDept(db, mgr, 'engineering'), false);
    assert.equal(canManageDept(db, emp, 'sales'), false);

    assert.equal(canAssignTo(db, boss, other), true);
    assert.equal(canAssignTo(db, mgr, emp), true);
    assert.equal(canAssignTo(db, mgr, other), false);
    assert.equal(canAssignTo(db, emp, other), false);
    assert.equal(canAssignTo(db, emp, emp), true);

    assert.equal(canApproveCrossDept(db, mgr, emp), true);
    assert.equal(canApproveCrossDept(db, mgr, other), false);
    assert.equal(canApproveCrossDept(db, emp, other), false);
  } finally { db.close(); }
});

test('policy：任务可见 / 确认 / 停止按范围', () => {
  const { db, boss, mgr, emp, other } = setup();
  try {
    const salesTask = { requesterId: 'boss', assigneeId: 'emp', deptId: 'sales' };
    assert.equal(canViewTask(db, boss, salesTask), true);
    assert.equal(canViewTask(db, mgr, salesTask), true);
    assert.equal(canViewTask(db, emp, salesTask), true);
    assert.equal(canViewTask(db, other, salesTask), false);

    assert.equal(canConfirmAttention(boss, { requiredConfirmerId: 'other', deptId: 'engineering' }), true);
    assert.equal(canConfirmAttention(mgr, { requiredConfirmerId: 'emp', deptId: 'sales' }), false, '管理者不代确认，只可见/催办');
    assert.equal(canConfirmAttention(mgr, { requiredConfirmerId: 'other', deptId: 'engineering' }), false);
    assert.equal(canConfirmAttention(emp, { requiredConfirmerId: 'emp' }), true);
    assert.equal(canConfirmAttention(emp, { requiredConfirmerId: 'other' }), false);

    assert.equal(canStopTask(db, mgr, salesTask), true);
    assert.equal(canStopTask(db, emp, salesTask), true);
    assert.equal(canStopTask(db, other, salesTask), false);
  } finally { db.close(); }
});
