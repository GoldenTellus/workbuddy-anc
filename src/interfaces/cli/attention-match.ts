import type { DatabaseSync } from 'node:sqlite';
import * as executor from '../../modules/executor/index.ts';
import * as identity from '../../modules/identity/index.ts';

export type MatchReason = 'ok' | 'unknown-actor' | 'not-found' | 'not-confirmer' | 'not-in-chat' | 'closed';

export interface AttentionMatchItem {
  attention: executor.Attention;
  allowed: boolean;
  allowed_actions: executor.AttentionAction[];
  reason: MatchReason;
}

export interface AttentionMatchResult {
  reason: MatchReason;
  ambiguous: boolean;
  code: string | null;
  matches: AttentionMatchItem[];
}

/** 从正文/引用文本里抠短号；避免把 SA12 这类词当成 A12。 */
export function extractShortCode(text: string): string | null {
  const m = String(text ?? '').match(/(?:^|[^A-Za-z0-9])A(\d{1,4})(?![0-9])/i);
  return m ? 'A' + m[1] : null;
}

function actionsFor(a: executor.Attention): executor.AttentionAction[] {
  if (a.status !== 'open') return [];
  if (a.purpose === 'answer') return ['answer'];
  if (a.purpose === 'review') return ['approve', 'reject'];
  return ['ack'];
}

function itemFor(db: DatabaseSync, actor: identity.Person, a: executor.Attention): AttentionMatchItem {
  const allowed = identity.canConfirmAttention(actor, {
    requiredConfirmerId: a.required_confirmer_id,
    deptId: a.department_id,
  });
  return {
    attention: a,
    allowed,
    allowed_actions: allowed ? actionsFor(a) : [],
    reason: !allowed ? 'not-confirmer' : a.status === 'open' ? 'ok' : 'closed',
  };
}

/**
 * 短号确认的确定性匹配层：不执行动作，只回答“这条消息可能指哪几条 Attention”。
 * 顺序：正文短号 > 引用文本短号 > 当前人当前群唯一 open；多条不猜。
 *
 * 引用文本（quoteText）来自补丁注入的 `quote=` 字段（GAP-079 / DEV-02）：
 * 用户引用一条带 `A12` 的 bot 通知、只回「可以」时正文没有短号，靠引用文本兜底；
 * 正文里写了短号则以正文为准（不拿引用覆盖正文，避免“引用 + 另写一个号”时选错）。
 */
export function matchAttention(
  db: DatabaseSync,
  input: { chatId: string; userid: string; text: string; quoteText?: string | null },
): AttentionMatchResult {
  const actor = identity.resolveActor(db, input.chatId, input.userid);
  if (!actor.person) return { reason: 'unknown-actor', ambiguous: false, code: null, matches: [] };

  // 正文短号优先；正文没有才看引用文本里的短号（D40 匹配顺序）。
  const textCode = extractShortCode(input.text);
  const code = textCode ?? extractShortCode(input.quoteText ?? '');
  if (code) {
    const a = executor.getAttentionByCode(db, code);
    if (!a) return { reason: 'not-found', ambiguous: false, code, matches: [] };
    const item = itemFor(db, actor.person, a);
    // 非老板只能在自己被通知/发起的那条会话里确认；避免在别的群把问题内容带出来。
    const inChat = a.origin_chat_id === input.chatId || a.notified_chat_id === input.chatId;
    if (!identity.isBoss(actor.person) && !inChat) {
      item.allowed = false;
      item.allowed_actions = [];
      item.reason = 'not-in-chat';
    }
    return { reason: 'ok', ambiguous: false, code, matches: [item] };
  }

  const isBoss = identity.isBoss(actor.person);
  const open = isBoss
    ? executor.listAttentions(db, { status: 'open', limit: 100 })
    : executor.listAttentions(db, { status: 'open', confirmerId: actor.person.person_id, limit: 100 });
  const inChat = open.filter((a) => a.origin_chat_id === input.chatId || a.notified_chat_id === input.chatId);
  // 老板可以在任意渠道确认；非老板只认自己在该群被通知/发起的那条，避免跨群误认。
  const candidates = isBoss && inChat.length === 0 ? open : inChat;
  if (candidates.length === 0) return { reason: 'not-found', ambiguous: false, code: null, matches: [] };
  if (candidates.length === 1) {
    return { reason: 'ok', ambiguous: false, code: null, matches: [itemFor(db, actor.person, candidates[0])] };
  }
  return {
    reason: 'ok',
    ambiguous: true,
    code: null,
    matches: candidates.slice(0, 3).map((a) => itemFor(db, actor.person, a)),
  };
}
