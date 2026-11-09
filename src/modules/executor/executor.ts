import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { nowIso, tx } from '../../core/index.ts';

export const NORMAL_SLOTS = 4;
export const HUMAN_SLOTS = 1;
export const DEFAULT_MAX_MINUTES = 30;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_MODEL = 'default';
export const DEFAULT_BUDGET = Object.freeze({ max_minutes: DEFAULT_MAX_MINUTES, model: DEFAULT_MODEL });

export type HostStatus = 'active' | 'closing' | 'closed';
export type TicketState =
  | 'queued'
  | 'working'
  | 'waiting_trigger'
  | 'waiting_answer'
  | 'waiting_review'
  | 'waiting_ack'
  | 'blocked'
  | 'failed'
  | 'done'
  | 'cancelled';
export type AssignmentState = 'pending' | 'running' | 'ended' | 'interrupted' | 'failed' | 'cancelled';
export type ReportType = 'progress' | 'waiting' | 'question' | 'ready' | 'blocked' | 'failed' | 'dropped';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';

export interface ExecutorHost {
  host_id: string;
  business_date: string;
  conversation_id: string;
  status: HostStatus;
  accepting_new: number;
  cut_at: string;
  cut_deferred: number;
  cut_deferred_at: string | null;
  started_at: string;
  closed_at: string | null;
  last_heartbeat_at: string | null;
}

export interface Ticket {
  ticket_id: string;
  task_id: number;
  department_id: string;
  title: string;
  state: TicketState;
  priority: Priority;
  due_at: string | null;
  task_dir: string;
  tools_json: string;
  vault_paths_json: string;
  budget_json: string | null;
  expires_at: string | null;
  max_attempts: number;
  latest_report_id: string | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

export interface Assignment {
  assignment_id: string;
  ticket_id: string;
  host_id: string;
  subagent_id: string | null;
  department_id: string;
  task_dir: string;
  slot: 'normal' | 'human';
  state: AssignmentState;
  attempt: number;
  report_id: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
}

export interface Report {
  report_id: string;
  assignment_id: string;
  ticket_id: string;
  department_id: string;
  type: ReportType;
  summary: string;
  evidence_json: string;
  next_step: string | null;
  late: number;
  created_at: string;
}

export interface CreateHostInput {
  conversationId: string;
  businessDate: string;
  cutAt: string;
  startedAt?: string;
}

export interface CreateTicketInput {
  taskId: number;
  departmentId: string;
  title: string;
  taskDir?: string;
  priority?: Priority;
  dueAt?: string;
  tools?: string[];
  vaultPaths?: string[];
  budget?: Record<string, unknown>;
  expiresAt?: string;
  maxAttempts?: number;
}

export interface ClaimResult {
  ticket: Ticket;
  assignment: Assignment;
}

export interface TicketScope {
  ticket_id: string;
  task_dir: string;
  allowed_roots: string[];
  tools: string[];
  vault_paths: string[];
  group_access: false;
}

export interface ExecutorEvaluation {
  evaluation_id: string;
  task_id: number;
  decision: 'accept' | 'defer' | 'ask' | 'reject';
  reason: string;
  priority: string | null;
  ticket_id: string | null;
  created_at: string;
}

export interface ExecutorEvent {
  id: number;
  kind: string;
  host_id: string | null;
  ticket_id: string | null;
  assignment_id: string | null;
  detail: string | null;
  created_at: string;
}

const PRIORITY_ORDER: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

function execError(code: string, message: string): Error {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

function canonicalTaskDir(departmentId: string, ticketId: string): string {
  const dept = departmentId.trim();
  if (!dept || dept === '.' || dept === '..' || /[\\/]/.test(dept)) {
    throw execError('EXEC_BAD_DEPARTMENT', 'department_id 不能为空或包含路径分隔符');
  }
  return `departments/${dept}/tasks/${ticketId}`;
}

function assertTaskDir(taskDir: string, departmentId: string, ticketId: string): string {
  const p = taskDir.replace(/\\/g, '/');
  const expected = canonicalTaskDir(departmentId, ticketId);
  if (p !== expected || p.includes('..') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) {
    throw execError('EXEC_BAD_TASK_DIR', 'task_dir 必须是 ' + expected);
  }
  return expected;
}

function recordEvent(db: DatabaseSync, kind: string, ids: { hostId?: string | null; ticketId?: string | null; assignmentId?: string | null }, detail?: unknown): void {
  db.prepare(`INSERT INTO executor_events (kind, host_id, ticket_id, assignment_id, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    kind,
    ids.hostId ?? null,
    ids.ticketId ?? null,
    ids.assignmentId ?? null,
    detail === undefined ? null : JSON.stringify(detail),
    nowIso(),
  );
}

export function recordEvaluation(db: DatabaseSync, input: { taskId: number; decision: ExecutorEvaluation['decision']; reason: string; priority?: string; ticketId?: string | null }): ExecutorEvaluation {
  if (!input.reason || !input.reason.trim()) throw execError('EXEC_BAD_EVALUATION', 'reason 必填');
  if (!['accept', 'defer', 'ask', 'reject'].includes(input.decision)) throw execError('EXEC_BAD_EVALUATION', 'decision 必须是 accept/defer/ask/reject');
  const at = nowIso();
  const e: ExecutorEvaluation = {
    evaluation_id: 'e-' + randomUUID(),
    task_id: input.taskId,
    decision: input.decision,
    reason: input.reason.trim(),
    priority: input.priority ?? null,
    ticket_id: input.ticketId ?? null,
    created_at: at,
  };
  db.prepare(`INSERT INTO executor_evaluations (evaluation_id, task_id, decision, reason, priority, ticket_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(e.evaluation_id, e.task_id, e.decision, e.reason, e.priority, e.ticket_id, e.created_at);
  recordEvent(db, 'background_evaluated', { ticketId: e.ticket_id }, { task_id: e.task_id, decision: e.decision });
  return e;
}

export function listEvaluations(db: DatabaseSync, opts: { taskId?: number; limit?: number } = {}): ExecutorEvaluation[] {
  const where = opts.taskId === undefined ? '' : 'WHERE task_id = ?';
  const args: number[] = opts.taskId === undefined ? [] : [opts.taskId];
  const limit = Math.max(1, Math.min(500, opts.limit ?? 50));
  return db.prepare(`SELECT * FROM executor_evaluations ${where} ORDER BY created_at DESC, evaluation_id DESC LIMIT ${limit}`).all(...(args as never[])) as unknown as ExecutorEvaluation[];
}

export function listExecutorEvents(db: DatabaseSync, opts: { ticketId?: string; hostId?: string; limit?: number } = {}): ExecutorEvent[] {
  const where: string[] = [];
  const args: string[] = [];
  if (opts.ticketId) { where.push('ticket_id = ?'); args.push(opts.ticketId); }
  if (opts.hostId) { where.push('host_id = ?'); args.push(opts.hostId); }
  const sql = 'SELECT * FROM executor_events' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY id DESC LIMIT ?';
  args.push(String(Math.max(1, Math.min(500, opts.limit ?? 50))));
  return db.prepare(sql).all(...(args as never[])) as unknown as ExecutorEvent[];
}

function validatePriority(p: string): Priority {
  if (p !== 'P0' && p !== 'P1' && p !== 'P2' && p !== 'P3') {
    throw execError('EXEC_BAD_PRIORITY', 'priority 必须是 P0/P1/P2/P3');
  }
  return p;
}

function validateReportType(t: string): ReportType {
  if (!['progress', 'waiting', 'question', 'ready', 'blocked', 'failed', 'dropped'].includes(t)) {
    throw execError('EXEC_BAD_REPORT_TYPE', '未知 Report type: ' + t);
  }
  return t as ReportType;
}

function mapReportState(type: ReportType): TicketState | null {
  switch (type) {
    case 'progress': return null;
    case 'waiting': return 'waiting_trigger';
    case 'question': return 'waiting_answer';
    case 'ready': return 'waiting_review';
    case 'blocked': return 'blocked';
    case 'failed': return 'failed';
    case 'dropped': return 'done';
  }
}

export function createHost(db: DatabaseSync, input: CreateHostInput): ExecutorHost {
  if (!input.conversationId.trim()) throw execError('EXEC_BAD_HOST', 'conversationId 必填');
  const at = input.startedAt ?? nowIso();
  return tx(db, () => {
    const active = db.prepare("SELECT host_id FROM executor_hosts WHERE status = 'active'").get() as { host_id?: string } | undefined;
    if (active?.host_id) throw execError('EXEC_HOST_ACTIVE', '已有 active host: ' + active.host_id);
    const host: ExecutorHost = {
      host_id: 'h-' + randomUUID(),
      business_date: input.businessDate,
      conversation_id: input.conversationId,
      status: 'active',
      accepting_new: 1,
      cut_at: input.cutAt,
      cut_deferred: 0,
      cut_deferred_at: null,
      started_at: at,
      closed_at: null,
      last_heartbeat_at: at,
    };
    db.prepare(`INSERT INTO executor_hosts
      (host_id, business_date, conversation_id, status, accepting_new, cut_at, cut_deferred, cut_deferred_at, started_at, closed_at, last_heartbeat_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(host.host_id, host.business_date, host.conversation_id, host.status,
        host.accepting_new, host.cut_at, host.cut_deferred, host.cut_deferred_at,
        host.started_at, null, host.last_heartbeat_at);
    recordEvent(db, 'host_created', { hostId: host.host_id }, { date: host.business_date });
    return host;
  });
}

export function getHost(db: DatabaseSync, hostId: string): ExecutorHost | null {
  return (db.prepare('SELECT * FROM executor_hosts WHERE host_id = ?').get(hostId) as ExecutorHost | undefined) ?? null;
}

export function listHosts(db: DatabaseSync): ExecutorHost[] {
  return db.prepare('SELECT * FROM executor_hosts ORDER BY started_at DESC').all() as ExecutorHost[];
}

export function getActiveHost(db: DatabaseSync): ExecutorHost | null {
  return (db.prepare("SELECT * FROM executor_hosts WHERE status = 'active' LIMIT 1").get() as ExecutorHost | undefined) ?? null;
}

/** 新对话首个 turn 调用：没有 active 就建；同一天同一对话幂等；跨日自动切 host。 */
export function bootstrapHost(db: DatabaseSync, input: { conversationId: string; businessDate: string; cutAt: string }): ExecutorHost {
  return tx(db, () => {
    const active = getActiveHost(db);
    if (!active) return createHost(db, { ...input, startedAt: nowIso() });
    if (active.status === 'active' && active.business_date === input.businessDate && active.conversation_id === input.conversationId) {
      return active;
    }
    if (active.status === 'active' && active.business_date < input.businessDate) {
      return cutHost(db, {
        oldHostId: active.host_id,
        newConversationId: input.conversationId,
        businessDate: input.businessDate,
        cutAt: input.cutAt,
      });
    }
    throw execError('EXEC_HOST_ACTIVE', '已有 active host，且不是同日同对话: ' + active.host_id);
  });
}

export function cutHost(db: DatabaseSync, input: { oldHostId: string; newConversationId: string; businessDate: string; cutAt?: string }): ExecutorHost {
  const at = input.cutAt ?? nowIso();
  return tx(db, () => {
    const old = getHost(db, input.oldHostId);
    if (!old) throw execError('EXEC_HOST_NOT_FOUND', 'host 不存在: ' + input.oldHostId);
    if (old.status !== 'active') throw execError('EXEC_HOST_NOT_ACTIVE', '只有 active host 能日切');
    db.prepare("UPDATE executor_hosts SET status = 'closing', accepting_new = 0, last_heartbeat_at = ? WHERE host_id = ?")
      .run(at, old.host_id);
    const next = createHost(db, {
      conversationId: input.newConversationId,
      businessDate: input.businessDate,
      cutAt: input.cutAt ?? at,
      startedAt: at,
    });
    recordEvent(db, 'host_cut', { hostId: old.host_id }, { old_host: old.host_id, new_host: next.host_id });
    return next;
  });
}

/** 03:00 没有新 host：不硬切；旧 host 继续接单，标记 deferred。 */
export function deferCutIfDue(db: DatabaseSync, now: string = nowIso()): { host: ExecutorHost | null; deferred: boolean } {
  return tx(db, () => {
    const host = getActiveHost(db);
    if (!host) return { host: null, deferred: false };
    const due = new Date(host.cut_at).getTime();
    if (!Number.isFinite(due) || due > new Date(now).getTime()) return { host, deferred: false };
    if (host.cut_deferred === 1) return { host, deferred: true };
    db.prepare('UPDATE executor_hosts SET cut_deferred = 1, cut_deferred_at = ?, last_heartbeat_at = ? WHERE host_id = ?')
      .run(now, now, host.host_id);
    recordEvent(db, 'host_cut_deferred', { hostId: host.host_id }, { at: now });
    return { host: getHost(db, host.host_id), deferred: true };
  });
}

export function closeHostIfIdle(db: DatabaseSync, hostId: string): boolean {
  return tx(db, () => {
    const host = getHost(db, hostId);
    if (!host || host.status === 'closed') return host?.status === 'closed';
    const active = db.prepare(
      "SELECT COUNT(*) AS n FROM assignments WHERE host_id = ? AND state IN ('pending', 'running')",
    ).get(hostId) as { n: number };
    if (Number(active.n) > 0) return false;
    db.prepare("UPDATE executor_hosts SET status = 'closed', accepting_new = 0, closed_at = ? WHERE host_id = ?")
      .run(nowIso(), hostId);
    recordEvent(db, 'host_closed', { hostId });
    return true;
  });
}

export function createTicket(db: DatabaseSync, input: CreateTicketInput): Ticket {
  const priority = validatePriority(input.priority ?? 'P2');
  const at = nowIso();
  const ticketId = 't-' + randomUUID();
  const taskDir = input.taskDir === undefined
    ? canonicalTaskDir(input.departmentId, ticketId)
    : assertTaskDir(input.taskDir, input.departmentId, ticketId);
  const ticket: Ticket = {
    ticket_id: ticketId,
    task_id: input.taskId,
    department_id: input.departmentId,
    title: input.title.trim(),
    state: 'queued',
    priority,
    due_at: input.dueAt ?? null,
    task_dir: taskDir,
    tools_json: JSON.stringify(input.tools ?? []),
    vault_paths_json: JSON.stringify(input.vaultPaths ?? []),
    budget_json: JSON.stringify({ ...DEFAULT_BUDGET, ...(input.budget ?? {}) }),
    expires_at: input.expiresAt ?? null,
    max_attempts: Math.max(1, Math.floor(input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)),
    latest_report_id: null,
    created_at: at,
    updated_at: at,
    ended_at: null,
  };
  if (!ticket.title) throw execError('EXEC_BAD_TICKET', 'title 必填');
  db.prepare(`INSERT INTO tickets
    (ticket_id, task_id, department_id, title, state, priority, due_at, task_dir,
     tools_json, vault_paths_json, budget_json, expires_at, max_attempts,
     latest_report_id, created_at, updated_at, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(ticket.ticket_id, ticket.task_id, ticket.department_id, ticket.title, ticket.state,
      ticket.priority, ticket.due_at, ticket.task_dir, ticket.tools_json, ticket.vault_paths_json,
      ticket.budget_json, ticket.expires_at, ticket.max_attempts, null, ticket.created_at,
      ticket.updated_at, null);
  recordEvent(db, 'ticket_created', { ticketId: ticket.ticket_id }, { department_id: ticket.department_id });
  return ticket;
}

export function getTicket(db: DatabaseSync, ticketId: string): Ticket | null {
  return (db.prepare('SELECT * FROM tickets WHERE ticket_id = ?').get(ticketId) as Ticket | undefined) ?? null;
}

export function getAssignment(db: DatabaseSync, assignmentId: string): Assignment | null {
  return (db.prepare('SELECT * FROM assignments WHERE assignment_id = ?').get(assignmentId) as Assignment | undefined) ?? null;
}

export function listTickets(db: DatabaseSync, state?: TicketState): Ticket[] {
  if (state) return db.prepare('SELECT * FROM tickets WHERE state = ? ORDER BY created_at').all(state) as Ticket[];
  return db.prepare('SELECT * FROM tickets ORDER BY created_at').all() as Ticket[];
}

export function getTicketScope(db: DatabaseSync, ticketId: string): TicketScope {
  const t = getTicket(db, ticketId);
  if (!t) throw execError('EXEC_TICKET_NOT_FOUND', 'ticket 不存在');
  return {
    ticket_id: t.ticket_id,
    task_dir: t.task_dir,
    allowed_roots: [t.task_dir],
    tools: JSON.parse(t.tools_json) as string[],
    vault_paths: JSON.parse(t.vault_paths_json) as string[],
    group_access: false,
  };
}

function activeCount(db: DatabaseSync, slot: 'normal' | 'human'): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM assignments WHERE slot = ? AND state IN ('pending', 'running')",
  ).get(slot) as { n: number };
  return Number(row.n);
}

function assignmentCount(db: DatabaseSync, ticketId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE ticket_id = ?').get(ticketId) as { n: number };
  return Number(row.n);
}

/** max_attempts 只数 normal 尝试；human 的问答续谈不能把 Ticket 跑成 failed（D43）。 */
function normalAssignmentCount(db: DatabaseSync, ticketId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE ticket_id = ? AND slot = 'normal'").get(ticketId) as { n: number };
  return Number(row.n);
}

function activeAssignmentForTicket(db: DatabaseSync, ticketId: string): Assignment | null {
  return (db.prepare(
    "SELECT * FROM assignments WHERE ticket_id = ? AND state IN ('pending', 'running') LIMIT 1",
  ).get(ticketId) as Assignment | undefined) ?? null;
}

export function claim(db: DatabaseSync, input: { hostId: string; slot?: 'normal' | 'human'; limit?: number; ticketId?: string }): ClaimResult | null {
  const slot = input.slot ?? 'normal';
  const limit = Math.max(1, Math.min(4, Math.floor(input.limit ?? 1)));
  return tx(db, () => {
    const host = getHost(db, input.hostId);
    if (!host) throw execError('EXEC_HOST_NOT_FOUND', 'host 不存在');
    if (host.status !== 'active' || host.accepting_new !== 1) {
      throw execError('EXEC_HOST_NOT_ACCEPTING', 'host 不在接单状态');
    }
    if (activeCount(db, slot) >= (slot === 'human' ? HUMAN_SLOTS : NORMAL_SLOTS)) return null;

    const stateFilter = slot === 'human'
      ? "t.state IN ('waiting_answer', 'waiting_review', 'waiting_ack', 'blocked', 'failed')"
      : "t.state = 'queued'";
    const ticketFilter = input.ticketId ? ' AND t.ticket_id = ?' : '';
    const rows = db.prepare(`
      SELECT t.* FROM tickets t
      WHERE ${stateFilter}${ticketFilter}
        AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.ticket_id = t.ticket_id AND a.state IN ('pending', 'running'))
      ORDER BY CASE t.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
               CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END, t.due_at, t.created_at
      LIMIT ?
    `).all(...(input.ticketId ? [input.ticketId] : []), limit) as Ticket[];
    if (!rows.length) return null;

    const ticket = rows[0];
    // human 定向恢复必须有可用的回答/退回意见，否则不让它空跑一次。
    if (slot === 'human' && input.ticketId) {
      const hasInput = db.prepare(
        "SELECT 1 FROM attentions WHERE ticket_id = ? AND status IN ('answered', 'rejected') LIMIT 1",
      ).get(ticket.ticket_id);
      if (!hasInput) throw execError('EXEC_HUMAN_NO_INPUT', 'human claim 需要先有 answered/rejected 的 Attention');
    }
    const nextAttempt = assignmentCount(db, ticket.ticket_id) + 1;
    if (slot === 'normal' && normalAssignmentCount(db, ticket.ticket_id) >= ticket.max_attempts) {
      db.prepare("UPDATE tickets SET state = 'failed', updated_at = ? WHERE ticket_id = ?").run(nowIso(), ticket.ticket_id);
      recordEvent(db, 'ticket_failed', { ticketId: ticket.ticket_id }, { reason: 'max-attempts' });
      return null;
    }
    const assignment: Assignment = {
      assignment_id: 'a-' + randomUUID(),
      ticket_id: ticket.ticket_id,
      host_id: host.host_id,
      subagent_id: null,
      department_id: ticket.department_id,
      task_dir: ticket.task_dir,
      slot,
      state: 'pending',
      attempt: assignmentCount(db, ticket.ticket_id) + 1,
      report_id: null,
      created_at: nowIso(),
      started_at: null,
      ended_at: null,
      end_reason: null,
    };
    db.prepare(`INSERT INTO assignments
      (assignment_id, ticket_id, host_id, subagent_id, department_id, task_dir, slot, state,
       attempt, report_id, created_at, started_at, ended_at, end_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(assignment.assignment_id, assignment.ticket_id, assignment.host_id, null,
        assignment.department_id, assignment.task_dir, assignment.slot, assignment.state,
        assignment.attempt, null, assignment.created_at, null, null, null);
    recordEvent(db, 'assignment_claimed', { hostId: host.host_id, ticketId: ticket.ticket_id, assignmentId: assignment.assignment_id }, { slot });
    return { ticket, assignment };
  });
}

export function startAssignment(db: DatabaseSync, input: { assignmentId: string; subagentId: string }): Assignment {
  return tx(db, () => {
    const a = getAssignment(db, input.assignmentId);
    if (!a) throw execError('EXEC_ASSIGNMENT_NOT_FOUND', 'assignment 不存在');
    if (a.state === 'running') return a;
    if (a.state !== 'pending') throw execError('EXEC_ASSIGNMENT_BAD_STATE', '只有 pending 能 start');
    if (!input.subagentId.trim()) throw execError('EXEC_BAD_SUBAGENT', 'subagentId 必填');
    const at = nowIso();
    db.prepare("UPDATE assignments SET state = 'running', subagent_id = ?, started_at = ? WHERE assignment_id = ?")
      .run(input.subagentId, at, a.assignment_id);
    db.prepare("UPDATE tickets SET state = 'working', updated_at = ? WHERE ticket_id = ?")
      .run(at, a.ticket_id);
    recordEvent(db, 'assignment_started', { hostId: a.host_id, ticketId: a.ticket_id, assignmentId: a.assignment_id }, { subagent_id: input.subagentId });
    return getAssignment(db, a.assignment_id)!;
  });
}

export function appendReport(db: DatabaseSync, input: { assignmentId: string; type: ReportType; summary: string; evidence?: string[]; nextStep?: string | null }): Report {
  const type = validateReportType(input.type);
  if (!input.summary.trim()) throw execError('EXEC_BAD_REPORT', 'summary 必填');
  return tx(db, () => {
    const a = getAssignment(db, input.assignmentId);
    if (!a) throw execError('EXEC_ASSIGNMENT_NOT_FOUND', 'assignment 不存在');
    const ticket = getTicket(db, a.ticket_id);
    if (!ticket) throw execError('EXEC_TICKET_NOT_FOUND', 'ticket 不存在');
    // 旧 Assignment（已中断/结束）的迟到 Report 只留证，不推进 Ticket；
    // 新 Assignment 可能已经在跑，不能被旧回报覆盖。
    const late = a.state !== 'running' && a.state !== 'pending';
    const at = nowIso();
    const report: Report = {
      report_id: 'r-' + randomUUID(),
      assignment_id: a.assignment_id,
      ticket_id: a.ticket_id,
      department_id: a.department_id,
      type,
      summary: input.summary.trim(),
      evidence_json: JSON.stringify(input.evidence ?? []),
      next_step: input.nextStep ?? null,
      late: late ? 1 : 0,
      created_at: at,
    };
    db.prepare(`INSERT INTO reports
      (report_id, assignment_id, ticket_id, department_id, type, summary, evidence_json, next_step, late, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(report.report_id, report.assignment_id, report.ticket_id, report.department_id,
        report.type, report.summary, report.evidence_json, report.next_step, report.late, report.created_at);
    db.prepare('UPDATE assignments SET report_id = ? WHERE assignment_id = ?').run(report.report_id, a.assignment_id);
    recordEvent(db, 'report_appended', { hostId: a.host_id, ticketId: a.ticket_id, assignmentId: a.assignment_id }, { type, late });
    if (late) return report;
    const nextState = mapReportState(type);
    if (nextState === 'failed') {
      const attempts = normalAssignmentCount(db, a.ticket_id);
      const ticketNow = getTicket(db, a.ticket_id)!;
      if (attempts < ticketNow.max_attempts) {
        db.prepare("UPDATE tickets SET state = 'queued', latest_report_id = ?, updated_at = ? WHERE ticket_id = ?")
          .run(report.report_id, at, a.ticket_id);
        recordEvent(db, 'retry_scheduled', { ticketId: a.ticket_id }, { attempts, max_attempts: ticketNow.max_attempts });
      } else {
        db.prepare("UPDATE tickets SET state = 'failed', latest_report_id = ?, updated_at = ?, ended_at = ? WHERE ticket_id = ?")
          .run(report.report_id, at, at, a.ticket_id);
        recordEvent(db, 'ticket_failed', { ticketId: a.ticket_id }, { attempts, max_attempts: ticketNow.max_attempts });
      }
    } else if (nextState) {
      const ended = nextState === 'done' ? at : null;
      db.prepare('UPDATE tickets SET state = ?, latest_report_id = ?, updated_at = ?, ended_at = COALESCE(ended_at, ?) WHERE ticket_id = ?')
        .run(nextState, report.report_id, at, ended, a.ticket_id);
      if (nextState === 'done') closeTicketAttentions(db, a.ticket_id, 'cancelled', 'ticket-done', at);
    } else {
      db.prepare('UPDATE tickets SET latest_report_id = ?, updated_at = ? WHERE ticket_id = ?')
        .run(report.report_id, at, a.ticket_id);
    }
    return report;
  });
}

/** 人工/核查关闭 Ticket：done 或 cancelled；只做状态收敛，不碰 Assignment 历史。 */
/** Ticket 收口时把还挂着的人确认一起关掉；已 answered/approved/... 的不动。 */
function closeTicketAttentions(
  db: DatabaseSync,
  ticketId: string,
  status: 'cancelled' | 'expired',
  reason: string,
  at: string,
): number {
  const rows = db.prepare(
    "SELECT attention_id, short_code FROM attentions WHERE ticket_id = ? AND status IN ('open', 'notified')",
  ).all(ticketId) as Array<{ attention_id: string; short_code: string }>;
  const kind = status === 'expired' ? 'attention_expired' : 'attention_cancelled';
  for (const a of rows) {
    db.prepare('UPDATE attentions SET status = ? WHERE attention_id = ?').run(status, a.attention_id);
    db.prepare(`INSERT INTO executor_events (kind, host_id, ticket_id, assignment_id, detail, created_at)
      VALUES (?, NULL, ?, NULL, ?, ?)`).run(
      kind, ticketId, JSON.stringify({ attention_id: a.attention_id, short_code: a.short_code, reason }), at,
    );
  }
  return rows.length;
}

export function closeTicket(db: DatabaseSync, input: { ticketId: string; decision: 'done' | 'cancelled' }): Ticket {
  return tx(db, () => {
    const t = getTicket(db, input.ticketId);
    if (!t) throw execError('EXEC_TICKET_NOT_FOUND', 'ticket 不存在');
    if (t.state === 'done' || t.state === 'cancelled') {
      closeTicketAttentions(db, t.ticket_id, 'cancelled', 'ticket-already-closed', nowIso());
      return t;
    }
    const at = nowIso();
    db.prepare('UPDATE tickets SET state = ?, ended_at = ?, updated_at = ? WHERE ticket_id = ?')
      .run(input.decision, at, at, t.ticket_id);
    closeTicketAttentions(db, t.ticket_id, 'cancelled', 'ticket-' + input.decision, at);
    recordEvent(db, 'ticket_closed', { ticketId: t.ticket_id }, { decision: input.decision });
    return getTicket(db, t.ticket_id)!;
  });
}

export function endAssignment(db: DatabaseSync, input: { assignmentId: string; reason?: string }): Assignment {
  return tx(db, () => {
    const a = getAssignment(db, input.assignmentId);
    if (!a) throw execError('EXEC_ASSIGNMENT_NOT_FOUND', 'assignment 不存在');
    if (a.state === 'ended') return a;
    if (a.state !== 'running' && a.state !== 'pending') {
      throw execError('EXEC_ASSIGNMENT_BAD_STATE', 'assignment 已结束');
    }
    db.prepare("UPDATE assignments SET state = 'ended', ended_at = ?, end_reason = ? WHERE assignment_id = ?")
      .run(nowIso(), input.reason ?? 'completed', a.assignment_id);
    recordEvent(db, 'assignment_ended', { hostId: a.host_id, ticketId: a.ticket_id, assignmentId: a.assignment_id }, { reason: input.reason ?? 'completed' });
    return getAssignment(db, a.assignment_id)!;
  });
}

/** 进程重启/旧 host 失联：把该 host 所有 pending/running 统一中断并放回队列。 */
export function recoverHost(db: DatabaseSync, input: { hostId: string; reason?: string }): { host: ExecutorHost; recovered: number } {
  return tx(db, () => {
    const host = getHost(db, input.hostId);
    if (!host) throw execError('EXEC_HOST_NOT_FOUND', 'host 不存在');
    const rows = db.prepare(
      "SELECT * FROM assignments WHERE host_id = ? AND state IN ('pending', 'running')",
    ).all(host.host_id) as Assignment[];
    const at = nowIso();
    for (const a of rows) {
      db.prepare("UPDATE assignments SET state = 'interrupted', ended_at = ?, end_reason = ? WHERE assignment_id = ?")
        .run(at, input.reason ?? 'host-restart', a.assignment_id);
      const ticket = getTicket(db, a.ticket_id);
      if (ticket && ticket.state === 'working') {
        db.prepare("UPDATE tickets SET state = 'queued', updated_at = ? WHERE ticket_id = ?").run(at, a.ticket_id);
      }
      recordEvent(db, 'assignment_interrupted', { hostId: host.host_id, ticketId: a.ticket_id, assignmentId: a.assignment_id }, { reason: input.reason ?? 'host-restart' });
    }
    recordEvent(db, 'host_recovered', { hostId: host.host_id }, { recovered: rows.length, reason: input.reason ?? 'host-restart' });
    closeHostIfIdle(db, host.host_id);
    return { host: getHost(db, host.host_id)!, recovered: rows.length };
  });
}

/** expires_at 已到的 Ticket：中断活跃 Assignment，Ticket 转 failed。 */
export function expireTickets(db: DatabaseSync, input: { now: string }): { expired: number } {
  return tx(db, () => {
    const rows = db.prepare(`
      SELECT * FROM tickets
      WHERE expires_at IS NOT NULL AND expires_at <= ?
        AND state NOT IN ('done', 'cancelled', 'failed')
    `).all(input.now) as Ticket[];
    for (const t of rows) {
      db.prepare("UPDATE assignments SET state = 'interrupted', ended_at = ?, end_reason = 'ticket-expired' WHERE ticket_id = ? AND state IN ('pending', 'running')")
        .run(input.now, t.ticket_id);
      db.prepare("UPDATE tickets SET state = 'failed', ended_at = ?, updated_at = ? WHERE ticket_id = ?")
        .run(input.now, input.now, t.ticket_id);
      closeTicketAttentions(db, t.ticket_id, 'expired', 'ticket-expired', input.now);
      recordEvent(db, 'ticket_expired', { ticketId: t.ticket_id }, { expires_at: t.expires_at });
    }
    return { expired: rows.length };
  });
}

/** 运行中的 Assignment 超过 Ticket 的 budget.max_minutes：中断并 block Ticket。 */
export function expireAssignmentsByBudget(db: DatabaseSync, input: { now: string }): { expired: number } {
  return tx(db, () => {
    const rows = db.prepare(`
      SELECT a.*, t.budget_json FROM assignments a
      JOIN tickets t ON t.ticket_id = a.ticket_id
      WHERE a.state = 'running' AND a.started_at IS NOT NULL AND t.budget_json IS NOT NULL
    `).all() as Array<Assignment & { budget_json: string }>;
    let expired = 0;
    for (const a of rows) {
      let maxMinutes = 0;
      try {
        const b = JSON.parse(a.budget_json) as { max_minutes?: unknown };
        maxMinutes = Number(b.max_minutes ?? 0);
      } catch (_) { continue; }
      if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) continue;
      const ends = new Date(a.started_at!).getTime() + maxMinutes * 60_000;
      if (ends > new Date(input.now).getTime()) continue;
      db.prepare("UPDATE assignments SET state = 'interrupted', ended_at = ?, end_reason = 'budget-timeout' WHERE assignment_id = ?")
        .run(input.now, a.assignment_id);
      db.prepare("UPDATE tickets SET state = 'blocked', updated_at = ? WHERE ticket_id = ?")
        .run(input.now, a.ticket_id);
      recordEvent(db, 'budget_exceeded', { hostId: a.host_id, ticketId: a.ticket_id, assignmentId: a.assignment_id }, { max_minutes: maxMinutes });
      expired += 1;
    }
    return { expired };
  });
}

/** 旧 host 的 Assignment 超过 grace 仍未回报：定时扫描并中断。 */
export function sweepStaleAssignments(db: DatabaseSync, input: { now: string; graceMinutes?: number }): { interrupted: number; hostsClosed: number } {
  const grace = Math.max(1, Math.floor(input.graceMinutes ?? 10));
  const cutoff = new Date(new Date(input.now).getTime() - grace * 60_000).toISOString();
  return tx(db, () => {
    const rows = db.prepare(`
      SELECT a.* FROM assignments a
      JOIN executor_hosts h ON h.host_id = a.host_id
      WHERE a.state IN ('pending', 'running')
        AND h.status IN ('closing', 'closed')
        AND COALESCE(a.started_at, a.created_at) <= ?
    `).all(cutoff) as Assignment[];
    const hosts = new Set<string>();
    for (const a of rows) {
      const at = input.now;
      db.prepare("UPDATE assignments SET state = 'interrupted', ended_at = ?, end_reason = ? WHERE assignment_id = ?")
        .run(at, 'grace-timeout', a.assignment_id);
      const ticket = getTicket(db, a.ticket_id);
      if (ticket && ticket.state === 'working') {
        db.prepare("UPDATE tickets SET state = 'queued', updated_at = ? WHERE ticket_id = ?").run(at, a.ticket_id);
      }
      recordEvent(db, 'assignment_interrupted', { hostId: a.host_id, ticketId: a.ticket_id, assignmentId: a.assignment_id }, { reason: 'grace-timeout' });
      hosts.add(a.host_id);
    }
    let hostsClosed = 0;
    for (const hostId of hosts) if (closeHostIfIdle(db, hostId)) hostsClosed += 1;
    return { interrupted: rows.length, hostsClosed };
  });
}

export function interruptAssignment(db: DatabaseSync, input: { assignmentId: string; reason?: string }): Assignment {
  return tx(db, () => {
    const a = getAssignment(db, input.assignmentId);
    if (!a) throw execError('EXEC_ASSIGNMENT_NOT_FOUND', 'assignment 不存在');
    if (a.state !== 'running' && a.state !== 'pending') {
      throw execError('EXEC_ASSIGNMENT_BAD_STATE', 'assignment 已结束');
    }
    const at = nowIso();
    db.prepare("UPDATE assignments SET state = 'interrupted', ended_at = ?, end_reason = ? WHERE assignment_id = ?")
      .run(at, input.reason ?? 'host-cut', a.assignment_id);
    const ticket = getTicket(db, a.ticket_id);
    if (ticket && ticket.state === 'working') {
      db.prepare("UPDATE tickets SET state = 'queued', updated_at = ? WHERE ticket_id = ?").run(at, a.ticket_id);
    }
    recordEvent(db, 'assignment_interrupted', { hostId: a.host_id, ticketId: a.ticket_id, assignmentId: a.assignment_id }, { reason: input.reason ?? 'host-cut' });
    return getAssignment(db, a.assignment_id)!;
  });
}
