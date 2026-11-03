// issue → patch draft（PLAN 阶段 L3，**模板版**）。
//
// 输入：一条 issue（skill + section + symptom + expected）
// 输出：一个 unified diff，插在目标段落末尾，外加一条 patch_drafts 记录
//
// **这是模板版，不用模型。** PLAN §5.2 特意说明了为什么先做模板版：
//   「如果它产不出你愿意合入的 diff，L4 的 agent 版就是把不可用的产出复制 N 份」
// 所以这一层的目标不是"聪明"，是**产出人能看懂、愿意合的东西**。
//
// 三个硬约束：
//   1. 只读仓库，不改文件——diff 给人看，合不合由人决定
//   2. 必须记 base_hash——将来应用时用它判断"这期间文件被人改过没有"
//   3. 定位不到段落就报错，不猜位置（插错地方比不插更糟）

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Issue } from './issues.ts';

export interface PatchDraft {
  id: number;
  issue_id: number;
  skill: string | null;
  skill_path: string;
  section: string | null;
  base_hash: string;
  patch_hint: string;
  diff: string;
  warnings: string | null;
  created_at: string;
}

export interface DraftOptions {
  /** 仓库根；不给就按当前工作目录 */
  repo?: string;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 把 SKILL.md 按 `## 标题` 切成段，返回每一段的起止行号（0-based，含标题行）。 */
function findSection(lines: string[], section: string): { start: number; end: number } | null {
  const want = section.trim();
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+?)\s*$/);
    if (!m) continue;
    if (start < 0) {
      if (m[1] === want) start = i;
    } else {
      // 找到下一个同级标题 → 当前段落结束
      return { start, end: i };
    }
  }
  if (start >= 0) return { start, end: lines.length };
  return null;
}

/**
 * 生成要插入的内容。
 *
 * 故意做得朴素：一条引用块 + 症状 + 期望。
 * 不生成"改进建议"——那是 L4 devbot 的事，模板版只负责把问题**摆到模型的视野里**。
 */
export function makeHint(issue: Issue): string {
  const id = `#${issue.id}`;
  const symptom = (issue.symptom || '').trim();
  const expected = (issue.expected || '').trim();
  const out: string[] = [];
  out.push('');
  out.push(`> **已知问题 ${id}**（${new Date().toISOString().slice(0, 10)} 登记，修好后删掉这一段）：`);
  if (symptom) out.push(`> - 现象：${symptom}`);
  if (expected) out.push(`> - 期望：${expected}`);
  if (!symptom && !expected) out.push('> - （原话见 submission）');
  out.push('');
  return out.join('\n');
}

/** 生成 unified diff（只有新增行，够用且好读）。 */
function makeUnifiedDiff(relPath: string, oldLines: string[], newLines: string[], insertAt: number, insertedCount: number): string {
  const ctx = 3;
  const from = Math.max(0, insertAt - ctx);
  const to = Math.min(oldLines.length, insertAt + ctx);
  const oldCount = to - from;
  const newCount = oldCount + insertedCount;

  const out: string[] = [];
  out.push(`--- a/${relPath}`);
  out.push(`+++ b/${relPath}`);
  out.push(`@@ -${from + 1},${oldCount} +${from + 1},${newCount} @@`);
  // 插入点之前的上下文
  for (let i = from; i < insertAt; i++) out.push(' ' + oldLines[i]);
  // 新增内容
  for (let i = insertAt; i < insertAt + insertedCount; i++) out.push('+' + newLines[i]);
  // 插入点之后的上下文
  for (let i = insertAt; i < to; i++) out.push(' ' + oldLines[i]);
  return out.join('\n') + '\n';
}

export interface DraftResult {
  draft: PatchDraft;
  /** 人对 diff 的判断依据：改了几个文件、插了几行、有没有警告 */
  insertedLines: number;
}

export function draftFromIssue(db: DatabaseSync, issueId: number, opts: DraftOptions = {}): DraftResult {
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(issueId) as Issue | undefined;
  if (!issue) throw new Error('没有这个 issue: #' + issueId);
  if (!issue.skill || !issue.section) {
    throw new Error(`issue #${issueId} 还没分诊（skill/section 为空）——先 cli issue triage --id ${issueId} --skill <技能> --section <章节>`);
  }

  const repo = opts.repo || process.cwd();
  const relPath = join('light', 'skills', issue.skill, 'SKILL.md').replace(/\\/g, '/');
  const absPath = join(repo, relPath);
  if (!existsSync(absPath)) throw new Error('技能文件不存在: ' + absPath);

  const original = readFileSync(absPath, 'utf8');
  const baseHash = sha256(original);
  const lines = original.split('\n');

  const span = findSection(lines, issue.section);
  if (!span) {
    throw new Error(`在 ${relPath} 里找不到「## ${issue.section}」这一段——先确认章节名和 SKILL.md 一致`);
  }

  // 插在段落末尾（下一个 ## 之前），并且往前跳过尾部空行
  let insertAt = span.end;
  while (insertAt > span.start + 1 && lines[insertAt - 1].trim() === '') insertAt--;

  const hint = makeHint(issue);
  const hintLines = hint.split('\n');
  // split('\n') 末尾通常是 ''，去掉它，避免多插一个空行
  if (hintLines[hintLines.length - 1] === '') hintLines.pop();
  const insertedCount = hintLines.length;

  const newLines = [...lines.slice(0, insertAt), ...hintLines, ...lines.slice(insertAt)];
  const diff = makeUnifiedDiff(relPath, lines, newLines, insertAt, insertedCount);

  const warnings: string[] = [];
  if (!issue.symptom) warnings.push('issue 没有 symptom，diff 里只有期望');
  if (!issue.expected) warnings.push('issue 没有 expected——模板版只能摆出现象，改法要人来定');
  // 同一个 issue 已经有 draft 过：提示别重复插
  const dup = db.prepare('SELECT COUNT(*) AS c FROM patch_drafts WHERE issue_id = ?').get(issueId) as { c: number };
  if (dup.c > 0) warnings.push(`issue #${issueId} 已有 ${dup.c} 份 draft——确认要再出一份`);

  const now = new Date().toISOString();
  const r = db
    .prepare(
      `INSERT INTO patch_drafts (issue_id, skill, skill_path, section, base_hash, patch_hint, diff, warnings, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(issueId, issue.skill, relPath, issue.section, baseHash, hint, diff, warnings.length ? warnings.join('; ') : null, now);

  const draft = db.prepare('SELECT * FROM patch_drafts WHERE id = ?').get(Number(r.lastInsertRowid)) as PatchDraft;
  return { draft, insertedLines: insertedCount };
}

export function list(db: DatabaseSync, opts: { limit?: number; issueId?: number } = {}): PatchDraft[] {
  const raw = Number(opts.limit);
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 100) : 20;
  const rows = opts.issueId
    ? db.prepare('SELECT * FROM patch_drafts WHERE issue_id = ? ORDER BY id DESC LIMIT ?').all(opts.issueId, limit)
    : db.prepare('SELECT * FROM patch_drafts ORDER BY id DESC LIMIT ?').all(limit);
  return rows as unknown as PatchDraft[];
}
