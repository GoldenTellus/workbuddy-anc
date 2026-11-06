// 迭代闭环的收集端（PLAN 阶段 L1）。
//
// 职责只有一件事：把员工在群里报的问题**原话照存**成一条 submission，等有人早上看。
// 这里不判断"该不该修"、不评估工作量、不建议方案——那些是 review 的人干的（PLAN §5.1）。
//
// 技能侧（light/skills/anc-feedback）调的是：
//   cli submission add --text "..." [--file "..."] [--chat-id "..."]
//   → { ok, id, created, employee }
//   created=false 表示这句话已经记过了

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface Submission {
  id: number;
  chat_id: string | null;
  employee: string | null;
  userid: string | null;
  text: string;
  file_path: string | null;
  file_hash: string | null;
  status: string;
  issue_id: number | null;
  created_at: string;
}

export interface AddInput {
  text: string;
  filePath?: string;
  fileHash?: string;
  chatId?: string;
  userid?: string;
}

export interface AddResult {
  id: number;
  /** false = 这条已经记过（同群 + 同文本），没有新建 */
  created: boolean;
  /** 从 chat_bindings 推出来的员工；推不出就是 null */
  employee: string | null;
}

/**
 * 去重键：同一个群里同一句话只记一次。
 *
 * 用 NUL 分隔避免 "ab"+"c" 与 "a"+"bc" 撞车——注意这里写的是 String.fromCharCode(0)，
 * 不是 '\0'。SQL 模板里写 '\0' 会被 JS 解析成真的 NUL 字符，症状是 db.exec 报
 * "incomplete input"（2026-11-03 踩过）。
 */
function dedupeKey(chatId: string | null, text: string): string {
  const sep = String.fromCharCode(0);
  return createHash('sha256')
    .update(String(chatId ?? '') + sep + text)
    .digest('hex')
    .slice(0, 32);
}

/**
 * 记一条 submission。
 *
 * 去重是有意的：同一条消息被重复投递（重试、补丁重放、员工连发两遍）不该变成两条，
 * 否则早上 review 看到的是噪声。
 */
export function add(db: DatabaseSync, input: AddInput): AddResult {
  const text = String(input.text ?? '').trim();
  if (!text) throw new Error('text 不能为空');

  const chatId = input.chatId?.trim() || null;
  const key = dedupeKey(chatId, text);

  const existing = db
    .prepare('SELECT id, employee FROM submissions WHERE dedupe_key = ?')
    .get(key) as { id: number; employee: string | null } | undefined;
  if (existing) {
    return { id: Number(existing.id), created: false, employee: existing.employee ?? null };
  }

  // 员工从绑定表推出——在群里说话的人就是那个群的主人，不用再问"你是谁"
  let employee: string | null = null;
  let boundUserid: string | null = null;
  if (chatId) {
    const b = db
      .prepare('SELECT employee, userid FROM chat_bindings WHERE chat_id = ?')
      .get(chatId) as { employee: string; userid: string | null } | undefined;
    if (b) {
      employee = b.employee ?? null;
      boundUserid = b.userid ?? null;
    }
  }

  const now = new Date().toISOString();
  const r = db
    .prepare(
      `INSERT INTO submissions (dedupe_key, chat_id, employee, userid, text, file_path, file_hash, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?)
       ON CONFLICT(dedupe_key) DO NOTHING`,
    )
    .run(
      key,
      chatId,
      employee,
      input.userid?.trim() || boundUserid,
      text,
      input.filePath?.trim() || null,
      input.fileHash?.trim() || null,
      now,
    );

  // 并发：两个写方都过了前面的查重时，第二个不再撞 UNIQUE 抛裸 SQLite 错
  if (Number(r.changes ?? 0) === 0) {
    const dup = db.prepare('SELECT id, employee FROM submissions WHERE dedupe_key = ?').get(key) as { id: number; employee: string | null } | undefined;
    return { id: Number(dup?.id ?? 0), created: false, employee: dup?.employee ?? null };
  }
  return { id: Number(r.lastInsertRowid), created: true, employee };
}

export interface ListOptions {
  limit?: number;
  status?: string;
}

export function list(db: DatabaseSync, opts: ListOptions = {}): Submission[] {
  const raw = Number(opts.limit);
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 500) : 100;
  const rows = opts.status
    ? db.prepare('SELECT * FROM submissions WHERE status = ? ORDER BY id DESC LIMIT ?').all(opts.status, limit)
    : db.prepare('SELECT * FROM submissions ORDER BY id DESC LIMIT ?').all(limit);
  return rows as unknown as Submission[];
}

/** 早上看过一条之后标掉，免得下次又看到。 */
export function setStatus(db: DatabaseSync, id: number, status: 'triaged' | 'dropped'): boolean {
  const r = db.prepare('UPDATE submissions SET status = ? WHERE id = ?').run(status, id);
  return Number(r.changes) > 0;
}

/** L2 转成 issue 之后回填，让 submission 与 issue 对上。 */
export function linkIssue(db: DatabaseSync, id: number, issueId: number): boolean {
  const r = db
    .prepare("UPDATE submissions SET issue_id = ?, status = 'triaged' WHERE id = ?")
    .run(issueId, id);
  return Number(r.changes) > 0;
}
