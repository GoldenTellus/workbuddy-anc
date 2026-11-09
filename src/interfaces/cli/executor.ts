import { readFileSync } from 'node:fs';
import * as executor from '../../modules/executor/index.ts';
import * as delivery from '../../modules/delivery/index.ts';
import * as tasks from '../../modules/tasks/index.ts';
import type { ReportType } from '../../modules/executor/index.ts';
import type { CliContext } from './context.ts';

function readReport(args: CliContext['args'], fail: CliContext['fail']): { type: ReportType; summary: string; evidence: string[]; nextStep: string | null } {
  if (typeof args['json-file'] === 'string') {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(args['json-file'], 'utf8')); } catch (e) {
      fail('读不了 --json-file: ' + (e as Error).message);
    }
    const r = raw as Record<string, unknown>;
    if (!r || typeof r !== 'object') fail('--json-file 必须是对象');
    if (typeof r.type !== 'string' || typeof r.summary !== 'string') fail('Report 缺 type/summary');
    const evidence = Array.isArray(r.evidence) ? r.evidence.filter((x): x is string => typeof x === 'string') : [];
    return {
      type: r.type as ReportType,
      summary: r.summary,
      evidence,
      nextStep: typeof r.next_step === 'string' ? r.next_step : null,
    };
  }
  const type = String(args.type ?? '');
  const summary = String(args.summary ?? '');
  if (!type || !summary) fail('缺少 --json-file 或 --type/--summary');
  let evidence: string[] = [];
  if (typeof args['evidence-json'] === 'string') {
    try {
      const v = JSON.parse(args['evidence-json']);
      if (!Array.isArray(v)) fail('--evidence-json 必须是字符串数组');
      evidence = v.filter((x): x is string => typeof x === 'string');
    } catch (e) {
      fail('--evidence-json 不是合法 JSON');
    }
  }
  return { type: type as ReportType, summary, evidence, nextStep: typeof args['next-step'] === 'string' ? args['next-step'] : null };
}

export default function executorGroup(ctx: CliContext): void {
  const { db, args, cmd, out, fail, numArg } = ctx;
  if (cmd === 'host') {
    const sub = args._[2];
    if (sub === 'register') {
      const conversationId = String(args['conversation-id'] ?? '');
      const date = String(args.date ?? '');
      const cutAt = String(args['cut-at'] ?? '');
      if (!conversationId) fail('缺少 --conversation-id');
      if (!date) fail('缺少 --date');
      if (!cutAt) fail('缺少 --cut-at');
      out({ ok: true, host: executor.createHost(db, { conversationId, businessDate: date, cutAt }) });
    } else if (sub === 'bootstrap') {
      const conversationId = String(args['conversation-id'] ?? '');
      const date = String(args.date ?? '');
      const cutAt = String(args['cut-at'] ?? '');
      if (!conversationId) fail('缺少 --conversation-id');
      if (!date) fail('缺少 --date');
      if (!cutAt) fail('缺少 --cut-at');
      out({ ok: true, host: executor.bootstrapHost(db, { conversationId, businessDate: date, cutAt }) });
    } else if (sub === 'tick') {
      const now = typeof args.now === 'string' ? args.now : new Date().toISOString();
      const r = executor.deferCutIfDue(db, now);
      out({ ok: true, ...r });
    } else if (sub === 'cut') {
      const oldHostId = String(args['old-host'] ?? '');
      const newConversationId = String(args['new-conversation-id'] ?? '');
      const date = String(args.date ?? '');
      if (!oldHostId) fail('缺少 --old-host');
      if (!newConversationId) fail('缺少 --new-conversation-id');
      if (!date) fail('缺少 --date');
      out({ ok: true, host: executor.cutHost(db, { oldHostId, newConversationId, businessDate: date }) });
    } else if (sub === 'status') {
      out({ ok: true, hosts: executor.listHosts(db) });
    } else {
      fail('未知 executor host 子命令');
    }
    return;
  }

  if (cmd === 'ticket') {
    const sub = args._[2];
    if (sub === 'create') {
      const taskId = Number(args['task-id']);
      if (!Number.isInteger(taskId) || taskId <= 0) fail('缺少或非法 --task-id');
      const departmentId = String(args['department-id'] ?? '');
      const title = String(args.title ?? '');
      const taskDir = typeof args['task-dir'] === 'string' ? args['task-dir'] : undefined;
      if (!departmentId) fail('缺少 --department-id');
      if (!title) fail('缺少 --title');
      out({ ok: true, ticket: executor.createTicket(db, {
        taskId,
        departmentId,
        title,
        taskDir,
        priority: typeof args.priority === 'string' ? args.priority as never : undefined,
        dueAt: typeof args['due-at'] === 'string' ? args['due-at'] : undefined,
      }) });
    } else if (sub === 'list') {
      out({ ok: true, tickets: executor.listTickets(db, typeof args.state === 'string' ? args.state as never : undefined) });
    } else {
      fail('未知 executor ticket 子命令');
    }
    return;
  }

  if (cmd === 'claim') {
    const hostId = String(args['host-id'] ?? '');
    if (!hostId) fail('缺少 --host-id');
    const slot = args.slot === 'human' ? 'human' : 'normal';
    const limit = numArg(args.limit, 1, 1, 4);
    out({ ok: true, data: executor.claim(db, { hostId, slot, limit }) });
    return;
  }

  if (cmd === 'start') {
    const assignmentId = String(args['assignment-id'] ?? '');
    const subagentId = String(args['subagent-id'] ?? '');
    if (!assignmentId) fail('缺少 --assignment-id');
    if (!subagentId) fail('缺少 --subagent-id');
    out({ ok: true, assignment: executor.startAssignment(db, { assignmentId, subagentId }) });
    return;
  }

  if (cmd === 'report') {
    const assignmentId = String(args['assignment-id'] ?? '');
    if (!assignmentId) fail('缺少 --assignment-id');
    const report = readReport(args, fail);
    const saved = executor.appendReport(db, { assignmentId, ...report });
    const ticket = executor.getTicket(db, saved.ticket_id);
    let taskDone = false;
    if (ticket?.state === 'done') {
      tasks.completeTaskFromExecution(db, ticket.task_id, 'executor-dropped');
      taskDone = true;
    }
    out({ ok: true, report: saved, task_done: taskDone });
    return;
  }

  if (cmd === 'sweep') {
    const now = typeof args.now === 'string' ? args.now : new Date().toISOString();
    const grace = numArg(args['grace-minutes'], 10, 1, 1440);
    out({ ok: true, ...executor.sweepStaleAssignments(db, { now, graceMinutes: grace }) });
    return;
  }

  if (cmd === 'recover') {
    const hostId = String(args['host-id'] ?? '');
    if (!hostId) fail('缺少 --host-id');
    out({ ok: true, ...executor.recoverHost(db, { hostId, reason: typeof args.reason === 'string' ? args.reason : 'host-restart' }) });
    return;
  }

  if (cmd === 'scope') {
    const ticketId = String(args['ticket-id'] ?? '');
    if (!ticketId) fail('缺少 --ticket-id');
    out({ ok: true, scope: executor.getTicketScope(db, ticketId) });
    return;
  }

  if (cmd === 'expire') {
    const now = typeof args.now === 'string' ? args.now : new Date().toISOString();
    out({ ok: true, ...executor.expireTickets(db, { now }) });
    return;
  }

  if (cmd === 'evaluate') {
    const taskId = Number(args['task-id']);
    const decision = String(args.decision ?? '');
    const reason = String(args.reason ?? '');
    if (!Number.isInteger(taskId) || taskId <= 0) fail('缺少或非法 --task-id');
    if (!['accept', 'defer', 'ask', 'reject'].includes(decision)) fail('--decision 必须是 accept/defer/ask/reject');
    if (!reason.trim()) fail('缺少 --reason');
    const priority = typeof args.priority === 'string' ? args.priority : undefined;
    out({ ok: true, evaluation: executor.recordEvaluation(db, {
      taskId,
      decision: decision as 'accept' | 'defer' | 'ask' | 'reject',
      reason,
      priority,
      ticketId: typeof args['ticket-id'] === 'string' ? args['ticket-id'] : null,
    }) });
    return;
  }

  if (cmd === 'evaluations') {
    const taskId = typeof args['task-id'] === 'string' ? Number(args['task-id']) : undefined;
    const limit = numArg(args.limit, 50, 1, 500);
    out({ ok: true, evaluations: executor.listEvaluations(db, { taskId, limit }) });
    return;
  }

  if (cmd === 'close') {
    const ticketId = String(args['ticket-id'] ?? '');
    const decision = String(args.decision ?? 'done');
    if (!ticketId) fail('缺少 --ticket-id');
    if (decision !== 'done' && decision !== 'cancelled') fail('--decision 必须是 done 或 cancelled');
    const ticket = executor.closeTicket(db, { ticketId, decision });
    let taskDone = false;
    if (decision === 'done') {
      tasks.completeTaskFromExecution(db, ticket.task_id, 'executor-close');
      taskDone = true;
    }
    out({ ok: true, ticket, task_done: taskDone });
    return;
  }

  if (cmd === 'notify') {
    const chatId = String(args['chat-id'] ?? '');
    const text = String(args.text ?? '');
    if (!chatId) fail('缺少 --chat-id');
    if (!text.trim()) fail('缺少 --text');
    const q = delivery.enqueue(db, {
      chatId,
      text,
      dedupeKey: typeof args['dedupe-key'] === 'string' ? args['dedupe-key'] : null,
    });
    out({ ok: true, enqueued: q });
    return;
  }

  if (cmd === 'end') {
    const assignmentId = String(args['assignment-id'] ?? '');
    if (!assignmentId) fail('缺少 --assignment-id');
    out({ ok: true, assignment: executor.endAssignment(db, {
      assignmentId,
      reason: typeof args.reason === 'string' ? args.reason : 'completed',
    }) });
    return;
  }

  fail('未知 executor 子命令');
}
