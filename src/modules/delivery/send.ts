// delivery 的出站发送：按每条消息自己的群绑定选 webhook，发送、失败告警、退避由 outbox 负责。
// 这里只做"把一条到点的消息发出去"的机械部分，不做业务判断。
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso, toIso, assertSafeOutbound } from '../../core/index.ts';
import { resolve, resolveGroup, assertWebhookFileName } from '../identity/index.ts';
import { listPendingDue, claim, markSent, markFailed, isPermanentFailure } from './outbox.ts';

export type Sender = (url: string, text: string, mentions: string[]) => Promise<void>;

export interface SendOptions {
  /** 逻辑时间，测试用；默认当前时间 */
  now?: string;
  /** 固定 webhook 文件（联调/测试）；必须同时给 chatId，只发这个群的消息。不传则按群绑定里的 webhook_file 选 */
  webhookFile?: string;
  /** 只处理这个群的待发消息（配合 webhookFile 联调） */
  chatId?: string;
  /** 密钥目录，默认 %ProgramData%\anc\secrets */
  secretsDir?: string;
  /** 注入发送器，测试用；默认走 fetch */
  send?: Sender;
  limit?: number;
}

async function defaultSender(url: string, text: string, mentions: string[]): Promise<void> {
  assertSafeOutbound(text);
  const payload: Record<string, unknown> = { content: text };
  if (mentions.length) payload.mentioned_list = mentions;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ msgtype: 'text', text: payload }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string };
  if (!res.ok || body.errcode !== 0) {
    throw new Error(`HTTP ${res.status} ${body.errcode ?? ''} ${body.errmsg ?? ''}`.trim());
  }
}

/** 配置类错误判死后喊一次运维：同一个群同类错误只在第一条上喊，别每条消息都刷屏。 */
async function failConfigAndAlert(db: DatabaseSync, secretsDir: string, chatId: string | null, id: number, error: string, hint: string): Promise<void> {
  markFailed(db, id, error);
  if (!isPermanentFailure(error)) return;
  const like = error.split(':')[0] + '%';
  const prior = (db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE chat_id = ? AND status = 'failed' AND last_error LIKE ?")
    .get(chatId ?? '', like) as { c: number }).c;
  if (prior > 1) return;
  // 只有"给这个群成功发过消息"才值得喊人：从没成功过的 chat 基本是测试数据或误配，
  // 在群里发一条"没登记 webhook"只会让人以为线上出了问题。这种情况留给 doctor 的 bindings 检查。
  const everSent = (db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE chat_id = ? AND status = 'sent'")
    .get(chatId ?? '') as { c: number }).c;
  if (everSent === 0) return;
  await alertOps(secretsDir, hint + '（chat ' + (chatId ?? '?') + '，修好后用 outbox requeue 重发）');
}

/**
 * 运维告警：只在"配置坏了、重试没用"时用。发不出去也不能影响主流程——
 * 告警是通知，不是关卡。
 */
async function alertOps(secretsDir: string, text: string): Promise<void> {
  try {
    const f = join(secretsDir, 'ops-webhook.txt');
    if (!existsSync(f)) return;
    const url = readFileSync(f, 'utf8').trim();
    if (!url) return;
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ msgtype: 'text', text: { content: '[anc] ' + text } }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    console.error('WARN  运维告警发送失败: ' + (e as Error).message);
  }
}

/** 发送到点的 pending 消息：每条按自己群的绑定选 webhook，查不到就失败，不退回默认群。 */
export async function sendPending(db: DatabaseSync, opts: SendOptions = {}): Promise<{ sent: number; failed: number }> {
  if (opts.webhookFile && !opts.chatId) throw new Error('webhookFile 只能配合 chatId 使用（联调单个群），避免把所有群的消息发到同一个 webhook');
  let sent = 0;
  let failed = 0;
  const send = opts.send ?? defaultSender;
  // 同一个 tick 内所有时间判断用同一个 now：分别调 nowIso() 会跨毫秒，边界上可能自相矛盾
  const now = opts.now ?? nowIso();
  const fixedUrl = opts.webhookFile ? readFileSync(opts.webhookFile, 'utf8').trim() : '';
  const secretsDir = opts.secretsDir ?? join(process.env.ProgramData || 'C:\\ProgramData', 'anc', 'secrets');
  const pending = listPendingDue(db, now, opts.limit ?? 20, opts.chatId);

  const nowStr = toIso(now);
  for (const m of pending) {
    // 先领取：别的发送方（重叠的 tick、outbox flush）已经拿走的就跳过
    if (!claim(db, m.id, nowStr)) continue;
    const exp = (m as { expires_at?: string | null }).expires_at;
    if (exp && exp < nowStr) {
      db.prepare("UPDATE outbox SET status = 'failed', last_error = 'EXPIRED', claimed_at = NULL, updated_at = ? WHERE id = ?").run(nowIso(), m.id);
      failed += 1;
      continue;
    }
    let url = fixedUrl;
    let file = '(fixed)';
    if (!url) {
      // 员工群优先走 chat_bindings 兼容层；公司/部门/boss_dm 群走 groups.webhook_file
      const binding = m.chat_id ? resolve(db, m.chat_id) : null;
      const group = m.chat_id ? resolveGroup(db, m.chat_id) : null;
      const webhook = binding?.webhook_file ?? group?.webhook_file;
      if (!webhook) {
        await failConfigAndAlert(db, secretsDir, m.chat_id, m.id, 'NO_WEBHOOK_FOR_CHAT: 该群未绑定或未登记 webhook_file', '有群没登记 webhook，消息发不出去已判失败');
        failed += 1;
        continue;
      }
      file = webhook;
      try {
        url = readFileSync(join(secretsDir, assertWebhookFileName(file)), 'utf8').trim();
      } catch {
        await failConfigAndAlert(db, secretsDir, m.chat_id, m.id, '读不到 webhook 文件: ' + file, '读不到 webhook 文件 ' + file + '，消息发不出去已判失败');
        failed += 1;
        continue;
      }
    }
    if (!url) {
      await failConfigAndAlert(db, secretsDir, m.chat_id, m.id, 'webhook 文件为空: ' + file, 'webhook 文件 ' + file + ' 是空的，消息发不出去已判失败');
      failed += 1;
      continue;
    }
    // 不是 https URL 就别交给 fetch：它的报错会把文件原文带进 last_error
    if (!/^https:\/\/\S+$/i.test(url)) {
      await failConfigAndAlert(db, secretsDir, m.chat_id, m.id, 'webhook 文件内容不是 https URL: ' + file, 'webhook 文件 ' + file + ' 里不是 https URL，消息发不出去已判失败');
      failed += 1;
      continue;
    }
    let payload: { text: string; mentions?: string[] };
    try {
      payload = JSON.parse(m.payload) as { text: string; mentions?: string[] };
      if (!payload || typeof payload.text !== 'string') throw new Error('BAD_PAYLOAD_JSON');
    } catch {
      // 脏 payload（手改库 / 残缺备份 / 旧版本数据）重试永远不会变好：直接判死。
      // parse 原本在 try 外面，一条坏数据会把整个 tick 抛出去，而这条消息已被 claim
      // 成 sending —— 之后每 10 分钟被当 stale 重新领取再抛一次，永久卡死。
      markFailed(db, m.id, 'BAD_PAYLOAD_JSON');
      failed += 1;
      continue;
    }
    try {
      await send(url, payload.text, payload.mentions ?? []);
      markSent(db, m.id);
      sent += 1;
    } catch (e) {
      markFailed(db, m.id, (e as Error).message);
      failed += 1;
    }
  }

  return { sent, failed };
}
