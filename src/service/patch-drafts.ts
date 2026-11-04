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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

// ── 清理：把插进技能文件的「已知问题」块删掉 ──────────────
//
// 为什么需要：模板版往 SKILL.md 里插的是一段引用块，注明"修好后删掉这一段"。
// 靠人肉删有两个问题——忘了删会一路膨胀把真指令挤没；删的时候找不准边界会删错。
//
// 做法：draft 里存着当时的 patch_hint 原文，按它在文件里精确匹配。
// **匹配不上就报错，不猜位置**——文件被人改过时猜错比不删更糟。

export interface PruneResult {
  /** 找到并（在 apply 时）删掉了吗 */
  removed: boolean;
  /** 删掉的行数（含规整掉的空行） */
  removedLines: number;
  /** 目标文件（仓库相对路径） */
  file: string;
  /** 删完之后的全文；未 apply 时也返回，方便人先看 */
  preview: string;
  /** 没能删除时的原因 */
  reason?: string;
}

/**
 * 删掉某条 issue 插进技能文件的块。
 *
 * `apply=false`（默认）只返回 preview，不写文件——先看再删。
 */

export function prune(
  db: DatabaseSync,
  opts: { issueId: number; repo?: string; apply?: boolean },
): PruneResult {
  const repo = opts.repo || process.cwd();

  // **不依赖 draft 的 skill_path**：早期 draft（2026-11-02 那批）存的是绝对路径，
  // 而且指向已经废弃的 %ProgramData%\anc\skills\。定位应该走 issue 的 skill → 仓库里的技能文件。
  const issue = db
    .prepare('SELECT id, skill, section FROM issues WHERE id = ?')
    .get(opts.issueId) as { id: number; skill: string | null; section: string | null } | undefined;
  if (!issue) {
    return { removed: false, removedLines: 0, file: '', preview: '', reason: '没有这个 issue: #' + opts.issueId };
  }
  if (!issue.skill) {
    return {
      removed: false,
      removedLines: 0,
      file: '',
      preview: '',
      reason: 'issue #' + opts.issueId + ' 还没分诊（skill 为空）',
    };
  }

  const relPath = join('light', 'skills', issue.skill, 'SKILL.md').replace(/\\/g, '/');
  const absPath = join(repo, relPath);
  if (!existsSync(absPath)) {
    return { removed: false, removedLines: 0, file: relPath, preview: '', reason: '技能文件不存在: ' + absPath };
  }

  const original = readFileSync(absPath, 'utf8');
  const lines = original.split(/\r?\n/);

  // 找「> **已知问题 #<N>**」那一行，往下吃掉整个连续的引用块（以 > 开头的行）
  const marker = '> **已知问题 #' + opts.issueId + '**';
  let from = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(marker)) {
      from = i;
      break;
    }
  }
  if (from < 0) {
    return {
      removed: false,
      removedLines: 0,
      file: relPath,
      preview: original,
      reason: '文件里没有「已知问题 #' + opts.issueId + '」这一块（可能已经删过）',
    };
  }

  let to = from;
  while (to + 1 < lines.length && lines[to + 1].trimStart().startsWith('>')) to++;

  // 往前吃掉块上方的空行，往后吃掉块下方的空行，避免删完留下两个连续空行
  let cutFrom = from;
  while (cutFrom > 0 && lines[cutFrom - 1].trim() === '') cutFrom--;
  let cutTo = to;
  while (cutTo + 1 < lines.length && lines[cutTo + 1].trim() === '') cutTo++;

  const kept = [...lines.slice(0, cutFrom), '', ...lines.slice(cutTo + 1)];
  const out = kept.join('\n').replace(/\n{3,}/g, '\n\n');
  const removedLines = lines.length - kept.length;

  if (opts.apply) {
    writeFileSync(absPath, out, 'utf8');
  }
  return { removed: true, removedLines, file: relPath, preview: out };
}

// 追加进 patch-drafts.ts：批量清理「已关闭 issue」留在技能文件里的块
//
// 为什么要批量：单个 prune 只能一条一条删，而实际场景是"一批 issue 改完合入了，
// 把它们插进技能文件的提醒一起清掉"。一条条敲容易漏，漏掉的那段会一直挂在技能文件里。

export interface PruneBatchResult {
  /** 扫了几个已关闭的 issue */
  scanned: number;
  /** 真删掉了几块 */
  removed: number;
  /** 跳过几个（文件里已经没有那一块） */
  skipped: number;
  /** 每个 issue 的明细 */
  results: Array<{ issueId: number; removed: boolean; removedLines: number; reason?: string }>;
}

/**
 * 清理所有 `status = 'closed'` 的 issue 留在技能文件里的「已知问题」块。
 *
 * `apply=false`（默认）只统计，不写文件。
 *
 * **只处理 closed，不处理 rejected**：rejected 的意思是"不会修"，那段提醒应该留着——
 * 它记录的是一个已知且决定不修的问题，对模型仍然有价值。
 */
export function pruneClosed(
  db: DatabaseSync,
  opts: { repo?: string; apply?: boolean },
): PruneBatchResult {
  const rows = db
    .prepare("SELECT id FROM issues WHERE status = 'closed' ORDER BY id")
    .all() as Array<{ id: number }>;

  const out: PruneBatchResult = { scanned: rows.length, removed: 0, skipped: 0, results: [] };
  for (const row of rows) {
    let r: PruneResult;
    try {
      r = prune(db, { issueId: row.id, repo: opts.repo, apply: opts.apply });
    } catch (e) {
      out.skipped++;
      out.results.push({ issueId: row.id, removed: false, removedLines: 0, reason: (e as Error).message });
      continue;
    }
    if (r.removed) out.removed++;
    else out.skipped++;
    out.results.push({
      issueId: row.id,
      removed: r.removed,
      removedLines: r.removedLines,
      reason: r.reason,
    });
  }
  return out;
}
