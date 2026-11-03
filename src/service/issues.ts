// submission → 结构化 issue（PLAN 阶段 L2）。
//
// 一条员工原话进来，要变成开发侧能直接动手的东西：
//   { skill, section, symptom, expected, verify }
//
// **这里不用模型。** PLAN §5.1 的原则是「确定性的事不交给模型」——分诊靠规则表，
// 抽取靠字符串规则。规则表命中不了就留 null，标成"待人工分诊"，不硬猜。
//
// 规则表维护在 RULES 里：关键词 → 技能 → 章节。章节名必须是 SKILL.md 里真实存在的
// `## 标题`，否则 devbot 定位不到段落。

import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

export interface Issue {
  id: number;
  submission_id: number;
  skill: string | null;
  section: string | null;
  symptom: string | null;
  expected: string | null;
  verify: string | null;
  status: string;
  note: string | null;
  created_at: string;
}

/**
 * 关键词 → 技能 → 章节。
 *
 * 章节名取自各 SKILL.md 的真实 `## 标题`（2026-11-04 核对过）。
 * 顺序有意义：先命中先返回，所以把更具体的词放前面。
 */
interface Rule {
  skill: string;
  section: string;
  keywords: string[];
}

export const RULES: Rule[] = [
  // anc-task
  { skill: 'anc-task', section: '查任务', keywords: ['查任务', '任务列表', '列出任务', '看任务', '有哪些任务', '今天有什么任务', '列任务'] },
  { skill: 'anc-task', section: '登记任务', keywords: ['登记任务', '记个任务', '帮我记', '记一下这个事'] },
  { skill: 'anc-task', section: '完成 / 取消', keywords: ['完成任务', '取消任务', '标完成', '标记完成'] },

  // anc-ingest（公司侧入库）
  { skill: 'anc-ingest', section: '执行方式（硬约束，违反即事故）', keywords: ['入库', '批次', 'meta.json', '投批次'] },
  { skill: 'anc-ingest', section: '2. 建批次并整理文档', keywords: ['建档', '整理文档'] },

  // anc-vault-read
  { skill: 'anc-vault-read', section: '怎么查', keywords: ['查库', '搜索', '找资料', '库里有没有', '查一下库'] },
  { skill: 'anc-vault-read', section: '查不到时', keywords: ['查不到', '没找到'] },

  // anc-interview
  { skill: 'anc-interview', section: '2. 逐题问，逐题提交', keywords: ['访谈', '问卷', '逐题'] },

  // anc-wb-patch
  { skill: 'anc-wb-patch', section: '2. 分三种情况', keywords: ['补丁', 'patch', '注入', 'manifest'] },
  { skill: 'anc-wb-patch', section: '3. 回归（测试群里做，四条）', keywords: ['回归', '升级后'] },

  // anc-feedback 自身（员工嫌它记错/多记时）
  { skill: 'anc-feedback', section: '记录', keywords: ['记错了', '不该记', '多记了', '没记下来'] },
];

/** 分诊：按关键词找技能和章节。找不到返回 null（等人工）。 */
export function triage(text: string): { skill: string; section: string } | null {
  const t = String(text || '');
  // 先比更长的关键词：避免「查任务」被「任务」这种短词抢先（目前没有短词，但留着以防将来加）
  let best: { rule: Rule; kw: string } | null = null;
  for (const rule of RULES) {
    for (const kw of rule.keywords) {
      if (!t.includes(kw)) continue;
      if (!best || kw.length > best.kw.length) best = { rule, kw };
    }
  }
  return best ? { skill: best.rule.skill, section: best.rule.section } : null;
}

/**
 * 抽"期望"：找员工说"应该怎样"的那句。
 *
 * 只认这几个引导词，不猜语气——猜错的期望比没有期望更糟（develop 会照着改错的）。
 */
const EXPECT_MARKERS = ['应该', '希望', '最好', '能不能', '可不可以', '要能', '需要能', '改为', '改成'];

export function extractExpected(text: string): string | null {
  const t = String(text || '');
  for (const m of EXPECT_MARKERS) {
    const i = t.indexOf(m);
    if (i < 0) continue;
    // 从引导词起，取到句末（。！？\n 都算）
    const rest = t.slice(i);
    const end = rest.search(/[。！？\n]/);
    const seg = (end < 0 ? rest : rest.slice(0, end)).trim();
    if (seg.length >= 2) return seg;
  }
  return null;
}

/**
 * 抽"症状"：员工说"哪里不对"的那部分。
 *
 * 找不到明确标记就退回整段原话——原话永远是最安全的（不会有提炼失真）。
 */
export function extractSymptom(text: string): string {
  const t = String(text || '').trim();
  if (!t) return '';
  const markers = ['不对', '没按预期', '漏了', '为什么没', '有问题', '错了', '不应该', '坏了'];
  for (const m of markers) {
    const i = t.indexOf(m);
    if (i < 0) continue;
    // 「不对」常常在句中，取它所在的整句
    const start = Math.max(t.lastIndexOf('。', i), t.lastIndexOf('\n', i), t.lastIndexOf('！', i), t.lastIndexOf('？', i)) + 1;
    const after = t.slice(i);
    const end = after.search(/[。！？\n]/);
    const seg = t.slice(start, end < 0 ? t.length : i + end).trim();
    if (seg.length >= 2) return seg;
  }
  return t;
}

/** 按 skill+section 生成"怎么验"。 */
export function makeVerify(skill: string | null, section: string | null): string | null {
  if (!skill || !section) return null;
  return `跑 ${skill} 的「${section}」相关用例，确认这条症状不再出现`;
}

export interface DraftResult {
  issue: Issue;
  created: boolean;
  /** 分诊命中不了时为 true，需要人工看 */
  needTriage: boolean;
}

/** 一条 submission → 一条 issue。同一条 submission 重复 draft 会返回已有的那条。 */
export function draftFromSubmission(db: DatabaseSync, submissionId: number): DraftResult {
  const sub = db
    .prepare('SELECT id, text, status, issue_id FROM submissions WHERE id = ?')
    .get(submissionId) as { id: number; text: string; status: string; issue_id: number | null } | undefined;
  if (!sub) throw new Error('没有这条 submission: #' + submissionId);

  // 幂等：已经转过就直接返回，不重复建 issue
  if (sub.issue_id) {
    const existing = db.prepare('SELECT * FROM issues WHERE id = ?').get(sub.issue_id) as Issue | undefined;
    if (existing) return { issue: existing, created: false, needTriage: !existing.skill };
  }

  const tri = triage(sub.text);
  const symptom = extractSymptom(sub.text);
  const expected = extractExpected(sub.text);
  const verify = makeVerify(tri?.skill ?? null, tri?.section ?? null);
  const now = new Date().toISOString();

  const r = db
    .prepare(
      `INSERT INTO issues (submission_id, skill, section, symptom, expected, verify, status, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    )
    .run(
      sub.id,
      tri?.skill ?? null,
      tri?.section ?? null,
      symptom || null,
      expected,
      verify,
      tri ? null : '规则表没命中，需要人工分诊',
      now,
      now,
    );

  const issueId = Number(r.lastInsertRowid);
  db.prepare("UPDATE submissions SET issue_id = ?, status = 'triaged' WHERE id = ?").run(issueId, sub.id);

  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(issueId) as Issue;
  return { issue, created: true, needTriage: !tri };
}

export function list(db: DatabaseSync, opts: { limit?: number; status?: string } = {}): Issue[] {
  const raw = Number(opts.limit);
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 200) : 50;
  const rows = opts.status
    ? db.prepare('SELECT * FROM issues WHERE status = ? ORDER BY id DESC LIMIT ?').all(opts.status, limit)
    : db.prepare('SELECT * FROM issues ORDER BY id DESC LIMIT ?').all(limit);
  return rows as unknown as Issue[];
}

/** 人工分诊：分诊没命中时补上 skill/section，或者直接关掉。 */
export function setTriage(db: DatabaseSync, id: number, skill: string | null, section: string | null): boolean {
  const now = new Date().toISOString();
  const verify = makeVerify(skill, section);
  const r = db
    .prepare('UPDATE issues SET skill = ?, section = ?, verify = ?, note = ?, updated_at = ? WHERE id = ?')
    .run(skill, section, verify, skill ? null : '规则表没命中，需要人工分诊', now, id);
  return Number(r.changes) > 0;
}
