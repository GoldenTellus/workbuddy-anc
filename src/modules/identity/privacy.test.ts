import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeData } from './privacy.ts';

test('privacy：公司级/部门级可在公司群直接答', () => {
  assert.deepEqual(routeData({ level: 'company', groupType: 'company', actorRole: 'employee' }), { allowed: true, target: 'current' });
  assert.deepEqual(routeData({ level: 'department', groupType: 'company', actorRole: 'employee' }), { allowed: true, target: 'current' });
  assert.deepEqual(routeData({ level: 'department', groupType: 'department', actorRole: 'employee' }), { allowed: true, target: 'current' });
});

test('privacy：个人级在公司/部门群转私密；本人员工群可直接答', () => {
  assert.equal(routeData({ level: 'personal', groupType: 'company', actorRole: 'employee', isSelf: true }).target, 'employee');
  assert.equal(routeData({ level: 'personal', groupType: 'department', actorRole: 'employee', isSelf: true }).target, 'employee');
  assert.equal(routeData({ level: 'personal', groupType: 'employee', actorRole: 'employee', isSelf: true }).target, 'current');
  assert.equal(routeData({ level: 'personal', groupType: 'company', actorRole: 'employee', isSelf: false }).allowed, false);
});

test('privacy：老板问个人数据转 1:1；问他人数据也不在公司群公开', () => {
  assert.equal(routeData({ level: 'personal', groupType: 'company', actorRole: 'boss', isSelf: false }).target, 'boss_dm');
  assert.equal(routeData({ level: 'personal', groupType: 'employee', actorRole: 'boss', isSelf: false }).target, 'boss_dm');
});

test('privacy：内部级只回 boss_dm；管理者也不行', () => {
  assert.equal(routeData({ level: 'internal', groupType: 'company', actorRole: 'manager' }).allowed, false);
  assert.deepEqual(routeData({ level: 'internal', groupType: 'company', actorRole: 'boss' }), { allowed: true, target: 'boss_dm' });
});

test('privacy：不确定默认私密', () => {
  assert.equal(routeData({ level: 'unknown', groupType: 'company', actorRole: 'employee' }).target, 'employee');
  assert.equal(routeData({ level: 'unknown', groupType: 'department', actorRole: 'manager' }).target, 'employee');
  assert.equal(routeData({ level: 'unknown', groupType: 'company', actorRole: 'boss' }).target, 'boss_dm');
});
