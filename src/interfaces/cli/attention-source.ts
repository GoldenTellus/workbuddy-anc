// 入站消息核验层：确认动作必须绑定 patch-in.log 里的真实消息（GAP-107）。
// 模型只能“引用”一条真实入站消息（--source-msg），动作、发送人、聊天都从该行日志重新推导，
// 不能用模型自述的 --action/--userid/--text 覆盖。这样“群里发一段注入文本让 bot 直接 approve”
// 在服务端就过不去：注入文本里没有「可以/不行」这类动作词，或发送人不是确认人。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import * as executor from '../../modules/executor/index.ts';
import * as identity from '../../modules/identity/index.ts';
import { matchAttention } from './attention-match.ts';

export interface InboundLine {
  at: string;
  chat: string;
  from: string;
  msg: string;
  text: string;
  quote: string | null;
}

/** patch-in.log 的一行：`<iso> chat=… from=… msg=… len=N text=… [ quote=… quote-type=…]` */
export function parseInboundLine(line: string): InboundLine | null {
  const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) chat=(\S+) from=(\S+) msg=(\S+) len=\d+ text=(.*)$/.exec(line);
  if (!m) return null;
  let body = m[5];
  let text = body;
  let quote: string | null = null;
  const qi = body.indexOf(' quote=');
  if (qi >= 0) {
    text = body.slice(0, qi);
    const tail = body.slice(qi + 1); // starts with "quote=..."
    const qm = /^quote=(.*?)(?: quote-type=\S+)?$/.exec(tail);
    if (qm) quote = qm[1];
  }
  return { at: m[1], chat: m[2], from: m[3], msg: m[4], text, quote };
}

export function readInboundLog(dataDir: string): InboundLine[] {
  const file = join(dataDir, 'patch-in.log');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).map(parseInboundLine).filter((x): x is InboundLine => !!x);
}

export function findInbound(dataDir: string, msgId: string, limit = 5000): InboundLine | null {
  const rows = readInboundLog(dataDir);
  const tail = rows.slice(-limit);
  for (let i = tail.length - 1; i >= 0; i--) if (tail[i].msg === msgId) return tail[i];
  return null;
}

/**
 * 从入站正文确定性推导动作；推导不出来就不允许执行。
 * 只认中文动作词，故意不认英文 approve（注入文本常含 approved）。
 */
export function deriveAction(
  purpose: executor.AttentionPurpose,
  text: string,
): { action: executor.AttentionAction; answerText?: string } | null {
  const t = String(text ?? '').trim();
  if (!t) return null;
  if (purpose === 'review') {
    if (/(不行|不可以|不通过|驳回|拒绝)/.test(t)) return { action: 'reject' };
    if (/(可以|同意|通过)/.test(t)) return { action: 'approve' };
    return null;
  }
  if (purpose === 'answer') {
    const body = t.replace(/^\s*A\d{1,4}[\s:：,，-]*/i, '').trim();
    return body ? { action: 'answer', answerText: body } : null;
  }
  if (purpose === 'responsibility') {
    if (/(收到|确认|ack)/i.test(t)) return { action: 'ack' };
    return null;
  }
  return null;
}

/** 消息必须在 Attention 创建之后（留 60s 时钟容差），且不能太久以前（防重放）。 */
export function isFreshInbound(
  line: InboundLine,
  attention: executor.Attention,
  now: Date = new Date(),
  maxAgeMs = 15 * 60 * 1000,
  skewMs = 60 * 1000,
): boolean {
  const at = new Date(line.at).getTime();
  const created = new Date(attention.created_at).getTime();
  if (!Number.isFinite(at) || !Number.isFinite(created)) return false;
  if (at < created - skewMs) return false;
  if (now.getTime() - at > maxAgeMs) return false;
  if (at > now.getTime() + skewMs) return false;
  return true;
}

/** 核验一条 source-msg 能不能作为这条 Attention 的确认来源；返回推导出的动作。 */
export function verifyAttentionSource(
  db: DatabaseSync,
  dataDir: string,
  attention: executor.Attention,
  sourceMsg: string,
  now: Date = new Date(),
): { actor: identity.Person; line: InboundLine; action: executor.AttentionAction; answerText?: string } {
  const line = findInbound(dataDir, sourceMsg);
  if (!line) throw new Error('找不到入站消息 ' + sourceMsg + '（必须来自 patch-in.log 的真实消息）');
  if (!isFreshInbound(line, attention, now)) throw new Error('入站消息时间不在允许窗口（须晚于 Attention 创建，且 15 分钟内）');
  const derived = deriveAction(attention.purpose, line.text);
  if (!derived) throw new Error('无法从入站消息正文判定动作（正文：' + line.text + '）');
  const actor = identity.resolveActor(db, line.chat, line.from).person;
  if (!actor) throw new Error('入站消息发送人无法识别');
  const match = matchAttention(db, { chatId: line.chat, userid: line.from, text: line.text, quoteText: line.quote });
  const hit = match.matches.find((m) => m.attention.attention_id === attention.attention_id && m.allowed);
  if (!hit) throw new Error('入站消息与这条 Attention 不匹配或发送人无权确认');
  return { actor, line, action: derived.action, answerText: derived.answerText };
}
