import * as tasks from '../../modules/tasks/index.ts';
import * as reminders from '../../modules/tasks/index.ts';
import * as identity from '../../modules/identity/index.ts';
import type { CliContext } from './context.ts';

export default function task(ctx: CliContext): void {
  const { db, args, cmd, out, fail, num, numArg } = ctx;
  if (cmd === 'add') {
    // 发起人必须登记：没有 userid 的任务任何人都能完成/取消（权限校验只对登记过 userid 的任务生效）
    if (typeof args['requester-userid'] !== 'string' || !args['requester-userid'].trim()) {
      fail('缺少 --requester-userid（用消息前缀里的 from）');
    }
    let dueAt: string | undefined = typeof args.due === 'string' ? args.due : undefined;
    if (typeof args['due-local'] === 'string') {
      // 本地时间（如 "2026-10-31 17:30"）→ UTC ISO，避免模型自己做时区换算。
      // 格式必须完整：只写日期会被按 UTC 零点解析（北京时间 08:00），「Oct 31」这类也会被 Date 接受
      const raw = String(args['due-local']).trim();
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(raw)) fail('--due-local 必须是 "YYYY-MM-DD HH:mm"');
      const d = new Date(raw.replace(' ', 'T'));
      if (Number.isNaN(d.getTime())) fail('--due-local 不是合法时间（用 "YYYY-MM-DD HH:mm"）');
      dueAt = d.toISOString();
    }
    const t = tasks.createTask(db, {
      title: String(args.title ?? ''),
      chatId: typeof args['chat-id'] === 'string' ? args['chat-id'] : undefined,
      assignee: typeof args.assignee === 'string' ? args.assignee : undefined,
      requester: typeof args.requester === 'string' ? args.requester : undefined,
      assigneeUserId: typeof args['assignee-userid'] === 'string' ? args['assignee-userid'] : undefined,
      requesterUserId: typeof args['requester-userid'] === 'string' ? args['requester-userid'] : undefined,
      dueAt,
      // 后台任务（D22）：执行器是 WorkBuddy，小服务只管超时；简单任务不允许 start
      kind: args.kind === 'background' ? 'background' : 'simple',
      timeoutMinutes: typeof args.timeout === 'string' ? numArg(args.timeout, 30, 1, 1440) : undefined,
      requesterId: typeof args['requester-id'] === 'string' ? args['requester-id'] : undefined,
      assigneeId: typeof args['assignee-id'] === 'string' ? args['assignee-id'] : undefined,
      originGroupId: typeof args['chat-id'] === 'string' ? args['chat-id'] : undefined,
      deptId: typeof args['dept-id'] === 'string' ? args['dept-id'] : undefined,
    });
    if (dueAt) reminders.scheduleReminder(db, { taskId: t.id, dueAt });
    out({ ok: true, task: t, due_local: dueAt ? new Date(dueAt).toLocaleString('sv-SE') : null });
  } else if (cmd === 'request') {
    // 员工请求同事：同部门直接待接受；跨部门强制先审批。
    const requesterId = String(args['requester-id'] ?? '');
    const assigneeId = String(args['assignee-id'] ?? '');
    if (!requesterId || !assigneeId) fail('缺少 --requester-id / --assignee-id');
    const requester = identity.resolvePerson(db, requesterId);
    const assignee = identity.resolvePerson(db, assigneeId);
    if (!requester) fail('找不到请求人: ' + requesterId);
    if (!assignee) fail('找不到执行人: ' + assigneeId);
    const explicitDept = typeof args['dept-id'] === 'string' ? args['dept-id'] : '';
    const deptId = explicitDept || assignee.dept_id || '';
    if (!deptId) fail('缺少 --dept-id（执行人也没有部门）');
    const crossDept = Boolean(requester.dept_id && assignee.dept_id && requester.dept_id !== assignee.dept_id);
    const requiresApproval = args['requires-approval'] === true || crossDept;
    const t = tasks.createTaskRequest(db, {
      title: String(args.title ?? ''),
      chatId: typeof args['chat-id'] === 'string' ? args['chat-id'] : undefined,
      originGroupId: typeof args['chat-id'] === 'string' ? args['chat-id'] : undefined,
      requesterId,
      assigneeId,
      deptId,
      requiresApproval,
      requester: typeof args.requester === 'string' ? args.requester : requester.name,
      assignee: typeof args.assignee === 'string' ? args.assignee : assignee.name,
      requesterUserId: typeof args['requester-userid'] === 'string' ? args['requester-userid'] : requester.userid ?? undefined,
      assigneeUserId: typeof args['assignee-userid'] === 'string' ? args['assignee-userid'] : assignee.userid ?? undefined,
    });
    out({ ok: true, task: t, cross_dept: crossDept, requires_approval: requiresApproval });
  } else if (cmd === 'approve') {
    const id = num('id');
    const approverId = String(args['approver-id'] ?? '');
    if (!approverId) fail('缺少 --approver-id');
    const t = tasks.getTask(db, id);
    if (!t) fail('任务不存在: ' + id);
    const approver = identity.resolvePerson(db, approverId);
    const assignee = t.assignee_id ? identity.resolvePerson(db, t.assignee_id) : null;
    if (!approver) fail('找不到审批人: ' + approverId);
    if (!assignee || !identity.canApproveCrossDept(db, approver, assignee)) fail('没有跨部门审批权限');
    out({ ok: true, task: tasks.approveTaskRequest(db, id, approverId) });
  } else if (cmd === 'accept') {
    const id = num('id');
    const assigneeId = String(args['assignee-id'] ?? '');
    if (!assigneeId) fail('缺少 --assignee-id');
    out({ ok: true, task: tasks.acceptTaskRequest(db, id, assigneeId) });
  } else if (cmd === 'reject') {
    const id = num('id');
    const actorId = String(args['actor-id'] ?? '');
    const reason = String(args.reason ?? '');
    if (!actorId) fail('缺少 --actor-id');
    if (!reason.trim()) fail('缺少 --reason');
    const t = tasks.getTask(db, id);
    if (!t) fail('任务不存在: ' + id);
    if (t.status === 'pending_approval') {
      const actor = identity.resolvePerson(db, actorId);
      const assignee = t.assignee_id ? identity.resolvePerson(db, t.assignee_id) : null;
      if (!actor || !assignee || !identity.canApproveCrossDept(db, actor, assignee)) fail('没有跨部门审批权限');
    } else if (t.status === 'pending_acceptance') {
      if (t.assignee_id !== actorId) fail('只有执行人能拒绝这个请求');
    } else {
      fail('只有待审批/待接受的任务能拒绝: ' + t.status);
    }
    out({ ok: true, task: tasks.rejectTaskRequest(db, id, actorId, reason) });
  } else if (cmd === 'list') {
    out({ ok: true, tasks: tasks.listTasks(db, { status: args.status as never, chatId: typeof args['chat-id'] === 'string' ? args['chat-id'] : undefined }) });
  } else if (cmd === 'get') {
    const t = tasks.getTask(db, num('id'));
    out(t ? { ok: true, task: t, events: tasks.taskEvents(db, t.id) } : { ok: false, found: false });
    if (!t) process.exit(1);
  } else if (cmd === 'done') {
    const id = num('id');
    const text = typeof args.text === 'string' ? args.text : `#${id} 已完成`;
    // 不在这里预扫：completeTask 内部只拦通知、不拦完成（「通知被拦不影响完成」）
    const r = tasks.completeTask(
      db,
      id,
      { chatId: typeof args['chat-id'] === 'string' ? args['chat-id'] : undefined, text },
      typeof args.actor === 'string' ? args.actor : undefined
    );
    out({ ok: true, task: r.task, enqueued: r.enqueued });
  } else if (cmd === 'start') {
    // 后台任务开始执行（bot 动手时调一次）；超时后 loop 会转 needs_review
    out({ ok: true, task: tasks.startBackgroundTask(db, num('id')) });
  } else if (cmd === 'reassign') {
    // 离职转交：把某人的 open 任务全部转到新人名下（--to 传 userid，--to-name 传姓名）
    const from = String(args.from ?? '');
    if (!from) fail('缺少 --from <userid 或姓名>');
    const toUserid = typeof args.to === 'string' ? args.to : null;
    const toName = typeof args['to-name'] === 'string' ? args['to-name'] : null;
    if (!toUserid && !toName) fail('缺少 --to <userid> 或 --to-name <姓名>');
    out({ ok: true, ...tasks.reassignTasks(db, from, { userid: toUserid, name: toName }, typeof args.actor === 'string' ? args.actor : undefined) });
  } else if (cmd === 'cancel') {
    out({ ok: true, task: tasks.cancelTask(db, num('id'), typeof args.actor === 'string' ? args.actor : undefined) });
  } else if (cmd === 'review') {
    // 所有者复核：retry 回到 open（清 started_at），close 直接取消
    const decision = String(args.decision ?? '');
    if (decision !== 'retry' && decision !== 'close') fail('--decision 必须是 retry 或 close');
    out({ ok: true, task: tasks.reviewTask(db, num('id'), decision as 'retry' | 'close', typeof args.actor === 'string' ? args.actor : undefined) });
  } else fail('未知 task 子命令');
}
