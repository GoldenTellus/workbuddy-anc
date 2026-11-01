import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { nowIso, tx } from './db.ts';

export const PROTOCOL = 'anc-a2a/1';
export const MAX_PAYLOAD = 256 * 1024;

/** 内部区必须是独立 git 目录；传了共享区路径时，内部区不能是它或其子目录（D12 的两区不能混）。 */
export function assertInternalDir(dir: string, sharedDir?: string): string {
  if (!dir) throw new A2AError('BAD_INTERNAL', '缺少内部区目录（--internal）');
  if (!isAbsolute(dir)) throw new A2AError('BAD_INTERNAL', '内部区必须是绝对路径: ' + dir);
  // 越区先判，且不依赖目录是否存在：shared\sub 这种还没建的路径也要当场拒掉
  if (sharedDir && isAbsolute(sharedDir)) {
    const r = resolve(dir);
    const s2 = resolve(sharedDir);
    if (r === s2 || r.startsWith(s2 + sep)) {
      throw new A2AError('BAD_INTERNAL', '内部区不能是共享区或其子目录: ' + dir);
    }
  }
  if (!existsSync(dir)) throw new A2AError('BAD_INTERNAL', '内部区目录不存在: ' + dir);
  if (!existsSync(join(dir, '.git'))) throw new A2AError('BAD_INTERNAL', '内部区不是 git 仓库（内部区与共享区必须是两个独立目录）: ' + dir);
  return dir;
}

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
  // 规则冻结（FORK §5.5）：已开的调查不能换规则，只能对新开的调查生效。
  // 同一规则再 create 是幂等的（访谈中断后重跑技能），名单与题数允许更新。
  const existing = db.prepare('SELECT rule_version, rule_hash FROM a2a_surveys WHERE survey_id = ?').get(input.surveyId) as { rule_version: string; rule_hash: string | null } | undefined;
  if (existing && (existing.rule_version !== input.ruleVersion || (existing.rule_hash ?? null) !== ruleHash)) {
    throw new A2AError('SURVEY_FROZEN', `调查 ${input.surveyId} 已按 ${existing.rule_version} 冻结；新规则请开新的 survey_id`);
  }
  db.prepare(
    `INSERT INTO a2a_surveys (survey_id, rule_version, rule_hash, expected, question_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(survey_id) DO UPDATE SET expected = excluded.expected, question_count = excluded.question_count`
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
  // payload 是员工整理的内容，会整段写进内部区：给个上限，免得一次提交把磁盘写满
  if (typeof env.payload !== 'string' || env.payload.length > MAX_PAYLOAD) {
    throw new A2AError('PAYLOAD_TOO_LARGE', 'payload 超过 ' + MAX_PAYLOAD + ' 字节');
  }
  const survey = db.prepare('SELECT survey_id, rule_version, expected FROM a2a_surveys WHERE survey_id = ?').get(env.survey_id) as { survey_id: string; rule_version: string; expected: string } | undefined;
  // 没 create 过的调查不收：否则版本检查被跳过，任意 survey_id 都能往内部区写
  if (!survey) throw new A2AError('UNKNOWN_SURVEY', `没有这场调查: ${env.survey_id}（先 a2a create）`);
  if (survey.rule_version !== env.rule_version) {
    throw new A2AError('RULE_MISMATCH', `这次调查冻结的是 ${survey.rule_version}，信封是 ${env.rule_version}；旧调查不能用新规则`);
  }
  const expected = JSON.parse(survey.expected || '[]') as string[];
  if (expected.length && (!fromUserid || !expected.includes(fromUserid))) {
    throw new A2AError('NOT_EXPECTED', '提交人不在这场调查的名单里');
  }
  // 去重在同一场调查内：每场访谈都用 q1..qN，跨调查同名不是重复
  const dup = db.prepare('SELECT message_id FROM a2a_messages WHERE survey_id = ? AND message_id = ?').get(env.survey_id, env.message_id);
  if (dup) return { inserted: false, message_id: env.message_id, survey_id: env.survey_id, file: null };

  // survey_id 会进文件路径：只保留安全字符，去掉 .. 片段，避免穿越
  const safeSurvey = String(env.survey_id)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^\.+/, '_') || '_invalid';
  const dir = join(internalDir, 'surveys', safeSurvey || '_invalid');
  mkdirSync(dir, { recursive: true });
  // 清洗会把不同 id 映射成同名（q1/a 与 q1_a）：清洗改动过的 id 加短 hash，避免互相覆盖
  const cleanId = env.message_id.replace(/[^A-Za-z0-9._-]/g, '_');
  const base = cleanId === env.message_id ? cleanId : cleanId + '-' + sha256(env.message_id).slice(0, 8);
  const file = join(dir, base + '.md');
  // front matter 的值统一 JSON 转义：带换行的 survey_id / type / reply_to 不能伪造 from_userid 等字段
  const fm = (k: string, v: unknown) => `${k}: ${JSON.stringify(v ?? '')}`;
  const body = [
    '---',
    fm('survey_id', env.survey_id),
    fm('message_id', env.message_id),
    fm('type', env.type),
    fm('rule_version', env.rule_version),
    fm('reply_to', env.reply_to ?? ''),
    fm('from_userid', fromUserid ?? ''),
    fm('submitted_at', nowIso()),
    '---',
    '',
    env.payload,
    '',
  ].join('\n');

  // 先插库再写文件，同一事务：写文件失败（含 wx 撞名）会回滚插入，不会留下有记录没文件或覆盖旧文件
  tx(db, () => {
    db.prepare(
      `INSERT INTO a2a_messages (message_id, survey_id, from_userid, type, rule_version, file_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(env.message_id, env.survey_id, fromUserid ?? null, env.type, env.rule_version, file, nowIso());
    writeFileSync(file, body, { encoding: 'utf8', flag: 'wx' });
  });

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
