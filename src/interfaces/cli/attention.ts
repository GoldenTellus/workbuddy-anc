import { nowIso, tx } from '../../core/index.ts';
import * as executor from '../../modules/executor/index.ts';
import * as identity from '../../modules/identity/index.ts';
import * as tasks from '../../modules/tasks/index.ts';
import { matchAttention } from './attention-match.ts';
import { notifyAttentionAsk, notifyDueAttention } from './attention-notify.ts';
import type { CliContext } from './context.ts';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function attentionArg(ctx: CliContext): executor.Attention {
  const { db, args, fail } = ctx;
  const id = str(args.id);
  const code = str(args.code);
  if (!id && !code) fail('缺少 --id 或 --code');
  const a = id ? executor.getAttention(db, id) : executor.getAttentionByCode(db, code);
  if (!a) fail('Attention 不存在: ' + (id || code));
  return a;
}

function parseOptions(ctx: CliContext): string[] | undefined {
  const raw = str(ctx.args['options-json']);
  if (!raw) return undefined;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { ctx.fail('--options-json 不是合法 JSON'); }
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) ctx.fail('--options-json 必须是字符串数组');
  return v as string[];
}

/** executor attention ...：创建/查询/匹配/回答/取消/扫描。 */
export default function attentionGroup(ctx: CliContext): void {
  const { db, args, out, fail, numArg } = ctx;
  const sub = args._[2];

  if (sub === 'create') {
    const purpose = str(args.purpose) as executor.AttentionPurpose;
    const question = str(args.question);
    const confirmerId = str(args['required-confirmer']);
    if (!purpose) fail('缺少 --purpose（answer/review/responsibility）');
    if (!question.trim()) fail('缺少 --question');
    if (!confirmerId) fail('缺少 --required-confirmer');
    const confirmer = identity.resolvePerson(db, confirmerId);
    if (!confirmer) fail('找不到确认人: ' + confirmerId);

    const ticketId = str(args['ticket-id']) || undefined;
    let taskId = str(args['task-id']) ? numArg(args['task-id'], 0, 1, 1_000_000_000) : undefined;
    let deptId = str(args['dept-id']) || undefined;
    let originChat = str(args['origin-chat']) || undefined;
    if (ticketId) {
      const ticket = executor.getTicket(db, ticketId);
      if (!ticket) fail('Ticket 不存在: ' + ticketId);
      taskId ??= ticket.task_id;
      deptId ??= ticket.department_id;
    }
    if (!originChat && taskId !== undefined) {
      const task = tasks.getTask(db, taskId);
      if (task?.chat_id) originChat = task.chat_id;
    }

    const { attention, notified } = tx(db, () => {
      const a = executor.createAttention(db, {
        purpose,
        question,
        requiredConfirmerId: confirmer.person_id,
        ticketId,
        taskId,
        departmentId: deptId,
        options: parseOptions(ctx),
        requireAck: args['require-ack'] === true,
        originChatId: originChat,
        expiresAt: str(args['expires-at']) || undefined,
      });
      return { attention: a, notified: notifyAttentionAsk(db, a) };
    });
    out({ ok: true, attention, notified });
    return;
  }

  if (sub === 'list') {
    const limit = numArg(args.limit, 50, 1, 500);
    out({
      ok: true,
      attentions: executor.listAttentions(db, {
        status: str(args.status) as executor.AttentionStatus || undefined,
        ticketId: str(args['ticket-id']) || undefined,
        taskId: str(args['task-id']) ? numArg(args['task-id'], 0, 1, 1_000_000_000) : undefined,
        confirmerId: str(args['confirmer']) || undefined,
        limit,
      }),
    });
    return;
  }

  if (sub === 'show') {
    out({ ok: true, attention: attentionArg(ctx) });
    return;
  }

  if (sub === 'match') {
    const chatId = str(args['chat-id']);
    const userid = str(args.userid);
    if (!chatId) fail('缺少 --chat-id');
    if (!userid) fail('缺少 --userid');
    const result = matchAttention(db, {
      chatId,
      userid,
      text: str(args.text),
      quoteText: str(args['quote-text']) || null,
    });
    out({ ok: true, ...result });
    return;
  }

  if (sub === 'answer') {
    const a = attentionArg(ctx);
    const chatId = str(args['chat-id']);
    const userid = str(args.userid);
    const action = str(args.action) as executor.AttentionAction;
    if (!chatId) fail('缺少 --chat-id');
    if (!userid) fail('缺少 --userid');
    if (!action) fail('缺少 --action（answer/approve/reject/ack）');
    const actor = identity.resolveActor(db, chatId, userid).person;
    if (!actor) fail('找不到操作人；先 bind actor 或完成首次绑定');
    const inChat = a.origin_chat_id === chatId || a.notified_chat_id === chatId;
    if (!identity.isBoss(actor) && !inChat) fail('这条要在原会话确认，不能在其他群处理');
    if (!identity.canConfirmAttention(actor, { requiredConfirmerId: a.required_confirmer_id, deptId: a.department_id })) {
      const confirmer = identity.resolvePerson(db, a.required_confirmer_id);
      fail('这条需要 ' + (confirmer?.name ?? a.required_confirmer_id) + ' 确认');
    }
    const onBehalf = identity.isBoss(actor) && a.required_confirmer_id !== actor.person_id
      ? a.required_confirmer_id
      : null;
    const answered = executor.answerAttention(db, {
      attentionId: a.attention_id,
      action,
      answeredBy: actor.person_id,
      text: str(args.text) || null,
      onBehalfOf: onBehalf,
      answerMessageId: str(args['message-id']) || null,
    });
    let taskDone = false;
    if ((action === 'approve' || action === 'ack') && answered.ticket_id) {
      const ticket = executor.getTicket(db, answered.ticket_id);
      if (ticket) {
        tasks.completeTaskFromExecution(db, ticket.task_id, 'attention-' + action);
        taskDone = true;
      }
    }
    out({ ok: true, attention: answered, on_behalf_of: onBehalf, task_done: taskDone });
    return;
  }

  if (sub === 'cancel') {
    const a = attentionArg(ctx);
    out({
      ok: true,
      attention: executor.cancelAttention(db, {
        attentionId: a.attention_id,
        reason: str(args.reason) || undefined,
      }),
    });
    return;
  }

  if (sub === 'context') {
    const ticketId = str(args['ticket-id']);
    if (!ticketId) fail('缺少 --ticket-id');
    out({ ok: true, ticket_id: ticketId, attentions: executor.attentionContext(db, ticketId) });
    return;
  }

  if (sub === 'sweep') {
    const now = str(args.now) || nowIso();
    const due = executor.listDueAttentions(db, { now });
    if (args.apply !== true) {
      out({
        ok: true,
        now,
        dry_run: true,
        due: due.map((d) => ({
          attention_id: d.attention.attention_id,
          short_code: d.attention.short_code,
          ticket_id: d.attention.ticket_id,
          purpose: d.attention.purpose,
          level: d.level,
          kind: d.kind,
          required_confirmer_id: d.attention.required_confirmer_id,
        })),
      });
      return;
    }
    const results = due.map((d) => ({
      attention_id: d.attention.attention_id,
      short_code: d.attention.short_code,
      level: d.level,
      kind: d.kind,
      result: notifyDueAttention(db, d, { now }),
    }));
    out({ ok: true, now, applied: true, due: results });
    return;
  }

  fail('未知 attention 子命令: ' + String(sub ?? '') +
    '（create/list/show/match/answer/cancel/context/sweep）');
}
