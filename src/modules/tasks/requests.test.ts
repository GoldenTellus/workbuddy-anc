import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../core/index.ts';
import {
  createTask, createTaskRequest, approveTaskRequest, acceptTaskRequest,
  rejectTaskRequest, completeTask, completeTaskFromExecution, cancelTask, getTask, taskEvents, listTasks,
} from './index.ts';

function db() { return openDb(':memory:'); }

test('任务请求：同部门直接 pending_acceptance → 接受 → open', () => {
  const d = db();
  try {
    const t = createTaskRequest(d, {
      title: '帮我看下报价', requesterId: 'emp', assigneeId: 'emp2', deptId: 'sales',
      requiresApproval: false, requester: '员工A', assignee: '员工B',
    });
    assert.equal(t.status, 'pending_acceptance');
    assert.equal(t.origin_group_id, null);
    assert.throws(() => completeTask(d, t.id), /不能标记完成/);
    const open = acceptTaskRequest(d, t.id, 'emp2');
    assert.equal(open.status, 'open');
    assert.ok(open.accepted_at);
    assert.equal(taskEvents(d, t.id).some((e) => e.kind === 'accepted'), true);
  } finally { d.close(); }
});

test('任务请求：跨部门 pending_approval → 批准 → pending_acceptance → 接受', () => {
  const d = db();
  try {
    const t = createTaskRequest(d, {
      title: '跨部门支援', requesterId: 'emp', assigneeId: 'other', deptId: 'engineering',
      requiresApproval: true, originGroupId: 'chat-emp',
    });
    assert.equal(t.status, 'pending_approval');
    const approved = approveTaskRequest(d, t.id, 'mgr-eng');
    assert.equal(approved.status, 'pending_acceptance');
    assert.equal(approved.approver_id, 'mgr-eng');
    const open = acceptTaskRequest(d, t.id, 'other');
    assert.equal(open.status, 'open');
    assert.equal(open.origin_group_id, 'chat-emp');
  } finally { d.close(); }
});

test('任务请求：拒绝必须带原因；批准/接受阶段都能拒绝', () => {
  const d = db();
  try {
    const a = createTaskRequest(d, { title: 'A', requesterId: 'emp', assigneeId: 'other', deptId: 'engineering', requiresApproval: true });
    assert.throws(() => rejectTaskRequest(d, a.id, 'mgr-eng', '  '), /拒绝必须带原因/);
    const rejected = rejectTaskRequest(d, a.id, 'mgr-eng', '没资源');
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.reject_reason, '没资源');

    const b = createTaskRequest(d, { title: 'B', requesterId: 'emp', assigneeId: 'emp2', deptId: 'sales', requiresApproval: false });
    assert.equal(rejectTaskRequest(d, b.id, 'emp2', '忙').status, 'rejected');
  } finally { d.close(); }
});

test('任务请求：只有执行人能接受；待审批可取消', () => {
  const d = db();
  try {
    const t = createTaskRequest(d, { title: 'C', requesterId: 'emp', assigneeId: 'emp2', deptId: 'sales', requiresApproval: false });
    assert.throws(() => acceptTaskRequest(d, t.id, 'other'), /只有执行人能接受/);
    assert.equal(cancelTask(d, t.id, 'emp2').status, 'cancelled');
  } finally { d.close(); }
});

test('任务请求：接受/拒绝后不能重复操作', () => {
  const d = db();
  try {
    const t = createTaskRequest(d, { title: 'D', requesterId: 'emp', assigneeId: 'emp2', deptId: 'sales', requiresApproval: false });
    acceptTaskRequest(d, t.id, 'emp2');
    assert.throws(() => acceptTaskRequest(d, t.id, 'emp2'), /只有 pending_acceptance/);
    assert.throws(() => rejectTaskRequest(d, t.id, 'emp2', '晚了一步'), /只有待审批/);
    assert.equal(getTask(d, t.id)?.status, 'open');
  } finally { d.close(); }
});
test('任务列表：kind=background 只返回后台候选', () => {
  const d = db();
  try {
    const bg = createTask(d, { title: '后台日报', kind: 'background' });
    createTask(d, { title: '简单任务' });
    const rows = listTasks(d, { status: 'open', kind: 'background' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, bg.id);
    assert.equal(rows[0].kind, 'background');
  } finally { d.close(); }
});
test('任务映射：执行侧完成只把 Task 置 done', () => {
  const d = db();
  try {
    const t = createTask(d, { title: '执行完成', kind: 'background' });
    const done = completeTaskFromExecution(d, t.id, 'executor-close');
    assert.equal(done.status, 'done');
    assert.equal(taskEvents(d, t.id).some((e) => e.kind === 'executor_done'), true);
  } finally { d.close(); }
});
