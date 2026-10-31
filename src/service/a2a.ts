import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso } from './db.ts';

export const PROTOCOL = 'anc-a2a/1';

export interface Envelope {
  protocol: string;
  survey_id: string;
  message_id: string;
  reply_to: string | null;
  type: string;
  rule_version: string;
  payload: string;
}

export class A2AError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** 从消息文本里抽 ``` 代码块（信封放在代码块里，方便整段复制）。 */
export function extractBlock(text: string): string | null {
  const m = text.match(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/);
  return m ? m[1].trim() : null;
}

export function parseEnvelope(text: string): Envelope {
  const raw = (extractBlock(text) ?? text).replace(/^\uFEFF/, '');
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    throw new A2AError('BAD_JSON', '信封不是合法 JSON: ' + (e as Error).message);
  }
  const need = ['protocol', 'survey_id', 'message_id', 'type', 'rule_version', 'payload'];
  for (const k of need) {
    if (typeof obj[k] !== 'string' || !(obj[k] as string).trim()) throw new A2AError('BAD_ENVELOPE', '信封缺少字段: ' + k);
  }
  if (obj.protocol !== PROTOCOL) throw new A2AError('BAD_PROTOCOL', `protocol 必须是 ${PROTOCOL}，收到 ${String(obj.protocol)}`);
  return {
    protocol: obj.protocol as string,
    survey_id: obj.survey_id as string,
    message_id: obj.message_id as string,
    reply_to: typeof obj.reply_to === 'string' ? obj.reply_to : null,
    type: obj.type as string,
    rule_version: obj.rule_version as string,
    payload: obj.payload as string,
  };
}

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

export interface CreateSurveyInput {
  surveyId: string;
  ruleVersion: string;
  ruleFile?: string;
  expected?: string[];
  /** 访谈类：一共多少题（q1..qN），用于完成判定 */
  questionCount?: number;
}

/** 建一次调查：冻结规则版本与内容 hash；expected 是应该交回的人员 userid。 */
export function createSurvey(db: DatabaseSync, input: CreateSurveyInput): { survey_id: string; rule_version: string; rule_hash: string | null; expected: string[]; question_count: number } {
  if (!input.surveyId) throw new A2AError('BAD_SURVEY', '缺少 survey_id');
  const ruleHash = input.ruleFile ? sha256(readFileSync(input.ruleFile)) : null;
  const expected = input.expected ?? [];
  const questionCount = input.questionCount ?? 0;
  db.prepare(
    `INSERT INTO a2a_surveys (survey_id, rule_version, rule_hash, expected, question_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(survey_id) DO UPDATE SET rule_version = excluded.rule_version, rule_hash = excluded.rule_hash, expected = excluded.expected, question_count = excluded.question_count`
  ).run(input.surveyId, input.ruleVersion, ruleHash, JSON.stringify(expected), questionCount, nowIso());
  return { survey_id: input.surveyId, rule_version: input.ruleVersion, rule_hash: ruleHash, expected, question_count: questionCount };
}

export interface SubmitResult {
  inserted: boolean;
  message_id: string;
  survey_id: string;
  file: string | null;
}

/** 提交：校验 → 规则版本对得上 → 去重 → 归档到内部区。 */
export function submit(db: DatabaseSync, env: Envelope, internalDir: string, fromUserid?: string): SubmitResult {
  const survey = db.prepare('SELECT survey_id, rule_version FROM a2a_surveys WHERE survey_id = ?').get(env.survey_id) as { survey_id: string; rule_version: string } | undefined;
  if (survey && survey.rule_version !== env.rule_version) {
    throw new A2AError('RULE_MISMATCH', `这次调查冻结的是 ${survey.rule_version}，信封是 ${env.rule_version}；旧调查不能用新规则`);
  }
  const dup = db.prepare('SELECT message_id FROM a2a_messages WHERE message_id = ?').get(env.message_id);
  if (dup) return { inserted: false, message_id: env.message_id, survey_id: env.survey_id, file: null };

  // survey_id 会进文件路径：只保留安全字符，去掉 .. 片段，避免穿越
  const safeSurvey = String(env.survey_id)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^\.+/, '_') || '_invalid';
  const dir = join(internalDir, 'surveys', safeSurvey || '_invalid');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, env.message_id.replace(/[^A-Za-z0-9._-]/g, '_') + '.md');
  const body = [
    '---',
    `survey_id: ${env.survey_id}`,
    `message_id: ${env.message_id}`,
    `type: ${env.type}`,
    `rule_version: ${env.rule_version}`,
    `reply_to: ${env.reply_to ?? ''}`,
    `from_userid: ${fromUserid ?? ''}`,
    `submitted_at: ${nowIso()}`,
    '---',
    '',
    env.payload,
    '',
  ].join('\n');
  writeFileSync(file, body, 'utf8');

  db.prepare(
    `INSERT INTO a2a_messages (message_id, survey_id, from_userid, type, rule_version, file_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(env.message_id, env.survey_id, fromUserid ?? null, env.type, env.rule_version, file, nowIso());

  return { inserted: true, message_id: env.message_id, survey_id: env.survey_id, file };
}

export interface SurveyStatus {
  survey_id: string;
  rule_version: string;
  expected: string[];
  received: string[];
  missing: string[];
  missing_questions: string[];
  complete: boolean;
}

export function surveyStatus(db: DatabaseSync, surveyId: string): SurveyStatus | null {
  const s = db.prepare('SELECT survey_id, rule_version, expected, question_count FROM a2a_surveys WHERE survey_id = ?').get(surveyId) as { survey_id: string; rule_version: string; expected: string; question_count: number } | undefined;
  if (!s) return null;
  const expected = JSON.parse(s.expected || '[]') as string[];
  const rows = db.prepare('SELECT DISTINCT from_userid FROM a2a_messages WHERE survey_id = ? AND from_userid IS NOT NULL').all(surveyId) as Array<{ from_userid: string }>;
  const received = rows.map((r) => r.from_userid);
  const missing = expected.filter((u) => !received.includes(u));

  const ids = db.prepare('SELECT message_id FROM a2a_messages WHERE survey_id = ?').all(surveyId) as Array<{ message_id: string }>;
  const missingQuestions: string[] = [];
  for (let i = 1; i <= (s.question_count || 0); i++) {
    const re = new RegExp(`^q${i}(-|$)`);
    if (!ids.some((r) => re.test(r.message_id))) missingQuestions.push('q' + i);
  }

  return {
    survey_id: s.survey_id,
    rule_version: s.rule_version,
    expected,
    received,
    missing,
    missing_questions: missingQuestions,
    complete: expected.length > 0 && missing.length === 0 && missingQuestions.length === 0,
  };
}

export function listSubmissions(db: DatabaseSync, surveyId: string): Array<{ message_id: string; from_userid: string | null; file_path: string; created_at: string }> {
  return db.prepare('SELECT message_id, from_userid, file_path, created_at FROM a2a_messages WHERE survey_id = ? ORDER BY created_at').all(surveyId) as never;
}
