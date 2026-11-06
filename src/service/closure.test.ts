// 迭代闭环 L1–L3 / L6 的分支测试（2026-11-06 补，对应 VERIFY §87 #8）。
//
// 为什么单独一个文件：§69 加的 cli.smoke.test.ts 只让这四个模块「被加载过」，
// 覆盖率报告里 eval 46% / patch-drafts 38% / issues 56% / submissions 56%，
// 而 devbot 恰恰会自动改这些文件。这里补的是**真实分支断言**，不是"跑通不报错"：
//   - submissions：去重键、绑定推导、状态流转
//   - issues：规则表分诊、症状/期望抽取、draft 幂等、人工分诊
//   - patch-drafts：段落定位、diff/base_hash、错误路径、prune 的 preview/apply
//   - eval：日志解析、断言判定、用例装载、落库、HTTP 注入与等待
//
// 隔离：临时 SQLite 库 + 临时技能仓库（opts.repo）+ 随机端口的本地 HTTP server，
// 不碰 %ProgramData%、不碰真实 light/skills/、不碰 17999。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb } from '../core/index.ts';
import { submissions, issues, patchDrafts, evalRunner } from '../modules/improvement/index.ts';
import * as bindings from '../modules/identity/index.ts';

type Db = ReturnType<typeof openDb>;

function withDb(fn: (db: Db) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'anc-closure-'));
  const db = openDb(join(dir, 'anc.db'));
  try { fn(db); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

function row(db: Db, table: string, id: number): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
}

// ───────────────────────── L1 submissions ─────────────────────────

test('submissions：空文本拒绝、原话 trim 后照存', () => withDb((db) => {
  assert.throws(() => submissions.add(db, { text: '' }), /text 不能为空/);
  assert.throws(() => submissions.add(db, { text: '   ' }), /text 不能为空/);
  const r = submissions.add(db, { text: '  查任务把逾期的也列出来了  ' });
  assert.equal(r.created, true);
  assert.equal(row(db, 'submissions', r.id)?.text, '查任务把逾期的也列出来了');
}));

test('submissions：同群同句去重、换群不去重', () => withDb((db) => {
  const a = submissions.add(db, { text: '查任务不对', chatId: 'chat-A' });
  const again = submissions.add(db, { text: '查任务不对', chatId: 'chat-A' });
  assert.equal(again.created, false);
  assert.equal(again.id, a.id);
  const other = submissions.add(db, { text: '查任务不对', chatId: 'chat-B' });
  assert.equal(other.created, true);
  assert.notEqual(other.id, a.id);
  assert.equal(submissions.list(db).length, 2);
}));

test('submissions：员工从绑定表推，显式 userid 优先', () => withDb((db) => {
  bindings.bind(db, 'chat-A', '张三', undefined, 'u-zhang');
  const a = submissions.add(db, { text: '第一条', chatId: 'chat-A' });
  assert.equal(a.employee, '张三');
  assert.equal(row(db, 'submissions', a.id)?.userid, 'u-zhang');

  const b = submissions.add(db, { text: '第二条', chatId: 'chat-A', userid: 'u-explicit' });
  assert.equal(row(db, 'submissions', b.id)?.userid, 'u-explicit');

  const c = submissions.add(db, { text: '第三条', chatId: '未绑定的群' });
  assert.equal(c.employee, null);
  assert.equal(row(db, 'submissions', c.id)?.userid, null);
}));

test('submissions：附件字段与 list 的 limit / status 边界', () => withDb((db) => {
  const a = submissions.add(db, { text: '带附件', filePath: ' a.md ', fileHash: ' h1 ' });
  assert.equal(row(db, 'submissions', a.id)?.file_path, 'a.md');
  assert.equal(row(db, 'submissions', a.id)?.file_hash, 'h1');

  for (let i = 0; i < 3; i++) submissions.add(db, { text: '第 ' + i + ' 条' });
  assert.equal(submissions.list(db, { limit: 2 }).length, 2);
  assert.equal(submissions.list(db, { limit: 0 }).length, 4, '非法 limit 应回退到默认 100');
  assert.equal(submissions.list(db, { limit: 9999 }).length, 4, '上限 500 生效（此处不足 500 条）');
  assert.equal(submissions.list(db, { status: 'triaged' }).length, 0);
  assert.equal(submissions.list(db, { status: 'new' }).length, 4);
}));

test('submissions：setStatus / linkIssue 的成功与不存在', () => withDb((db) => {
  const a = submissions.add(db, { text: '一条反馈' });
  assert.equal(submissions.setStatus(db, a.id, 'dropped'), true);
  assert.equal(row(db, 'submissions', a.id)?.status, 'dropped');
  assert.equal(submissions.setStatus(db, 9999, 'dropped'), false);

  assert.equal(submissions.linkIssue(db, a.id, 42), true);
  assert.equal(row(db, 'submissions', a.id)?.issue_id, 42);
  assert.equal(row(db, 'submissions', a.id)?.status, 'triaged');
  assert.equal(submissions.linkIssue(db, 9999, 42), false);
}));

// ───────────────────────── L2 issues ─────────────────────────

test('issues：triage 命中规则表、长关键词优先、未命中返回 null', () => {
  assert.deepEqual(issues.triage('今天有什么任务没列出来'), { skill: 'anc-task', section: '查任务' });
  assert.deepEqual(issues.triage('登记任务：明天提醒我'), { skill: 'anc-task', section: '登记任务' });
  assert.deepEqual(issues.triage('入库这个批次'), { skill: 'anc-ingest', section: '执行方式（硬约束，违反即事故）' });
  assert.equal(issues.triage('随便聊两句'), null);
  assert.equal(issues.triage(''), null);
});

test('issues：extractExpected 认引导词并截到句末、认不出返回 null', () => {
  assert.equal(issues.extractExpected('查任务不对，应该只列今天的。后面还有别的话'), '应该只列今天的');
  assert.equal(issues.extractExpected('希望改成按天分组'), '希望改成按天分组');
  assert.equal(issues.extractExpected('最好\n能快一点'), '最好');
  assert.equal(issues.extractExpected('只描述现象，没有期望'), null);
});

test('issues：extractSymptom 命中标记取所在句，否则退回整段原话', () => {
  assert.equal(issues.extractSymptom('查任务不对，把逾期的也列了。第二段'), '查任务不对，把逾期的也列了');
  assert.equal(issues.extractSymptom('第一句。第二句漏了今天的任务。第三句'), '第二句漏了今天的任务');
  assert.equal(issues.extractSymptom('平平淡淡一句话'), '平平淡淡一句话');
  assert.equal(issues.extractSymptom('   '), '');
  assert.equal(issues.makeVerify('anc-task', '查任务'), '跑 anc-task 的「查任务」相关用例，确认这条症状不再出现');
  assert.equal(issues.makeVerify(null, '查任务'), null);
});

test('issues：draftFromSubmission 命中→幂等→回填，未命中需人工，不存在报错', () => withDb((db) => {
  const a = submissions.add(db, { text: '查任务不对，应该只列今天的任务。', chatId: 'chat-A' });
  const first = issues.draftFromSubmission(db, a.id);
  assert.equal(first.created, true);
  assert.equal(first.needTriage, false);
  assert.equal(first.issue.skill, 'anc-task');
  assert.equal(first.issue.section, '查任务');
  assert.equal(first.issue.status, 'open');
  assert.ok(first.issue.verify?.includes('查任务'));
  assert.ok(first.issue.symptom?.includes('不对'));
  assert.equal(row(db, 'submissions', a.id)?.issue_id, first.issue.id);
  assert.equal(row(db, 'submissions', a.id)?.status, 'triaged');

  const second = issues.draftFromSubmission(db, a.id);
  assert.equal(second.created, false);
  assert.equal(second.issue.id, first.issue.id);
  assert.equal(issues.list(db).length, 1, '重复 draft 不能多建 issue');

  const b = submissions.add(db, { text: '完全没提任何关键词的闲聊' });
  const unmatched = issues.draftFromSubmission(db, b.id);
  assert.equal(unmatched.created, true);
  assert.equal(unmatched.needTriage, true);
  assert.equal(unmatched.issue.skill, null);
  assert.match(unmatched.issue.note ?? '', /需要人工分诊/);
  assert.equal(unmatched.issue.symptom, '完全没提任何关键词的闲聊');

  assert.throws(() => issues.draftFromSubmission(db, 9999), /没有这条 submission/);
}));

test('issues：setTriage / setStatus / listByStatus / list 边界', () => withDb((db) => {
  const a = submissions.add(db, { text: '没关键词的一条' });
  const { issue } = issues.draftFromSubmission(db, a.id);
  assert.equal(issue.verify, null);

  assert.equal(issues.setTriage(db, issue.id, 'anc-task', '查任务'), true);
  const triaged = row(db, 'issues', issue.id);
  assert.equal(triaged?.skill, 'anc-task');
  assert.ok(String(triaged?.verify).includes('查任务'));
  assert.equal(triaged?.note, null);

  assert.equal(issues.setTriage(db, issue.id, null, null), true);
  assert.match(String(row(db, 'issues', issue.id)?.note), /需要人工分诊/);
  assert.equal(issues.setTriage(db, 9999, 'anc-task', '查任务'), false);

  assert.equal(issues.setStatus(db, issue.id, 'closed', '已合入'), true);
  assert.equal(row(db, 'issues', issue.id)?.note, '已合入');
  assert.equal(issues.setStatus(db, issue.id, 'rejected'), true, '不带 note 走另一条 SQL');
  assert.equal(row(db, 'issues', issue.id)?.note, '已合入', '不带 note 不应覆盖原 note');
  assert.equal(issues.setStatus(db, 9999, 'closed'), false);

  assert.equal(issues.listByStatus(db, 'rejected').length, 1);
  assert.equal(issues.listByStatus(db, 'closed').length, 0);
  assert.equal(issues.list(db, { status: 'rejected' }).length, 1);
  assert.equal(issues.list(db, { limit: -1 }).length, 1, '非法 limit 回退默认 50');
}));

// ───────────────────────── L3 patch-drafts ─────────────────────────

const SKILL_MD = [
  '# anc-task',
  '',
  '## 登记任务',
  '登记任务的说明',
  '',
  '## 查任务',
  '列出任务的说明',
  '',
  '',
  '## 收尾',
  '最后一段',
  '',
].join('\n');

interface Fixture { dir: string; skillFile: string; db: Db }

function withRepo(fn: (f: Fixture) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'anc-draft-'));
  const skillDir = join(dir, 'light', 'skills', 'anc-task');
  mkdirSync(skillDir, { recursive: true });
  const skillFile = join(skillDir, 'SKILL.md');
  writeFileSync(skillFile, SKILL_MD, 'utf8');
  const db = openDb(join(dir, 'anc.db'));
  try { fn({ dir, skillFile, db }); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

function insertIssue(db: Db, o: { skill?: string | null; section?: string | null; symptom?: string | null; expected?: string | null; status?: string }): number {
  const r = db.prepare(
    'INSERT INTO issues (submission_id, skill, section, symptom, expected, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(1, o.skill ?? null, o.section ?? null, o.symptom ?? null, o.expected ?? null, o.status ?? 'open', new Date().toISOString());
  return Number(r.lastInsertRowid);
}

test('patch-drafts：makeHint 覆盖有/无症状与期望', () => {
  const base = { id: 7, submission_id: 1, skill: 'anc-task', section: '查任务', verify: null, status: 'open', note: null, created_at: '' };
  const full = patchDrafts.makeHint({ ...base, symptom: '列多了', expected: '只列今天' });
  assert.match(full, /已知问题 #7/);
  assert.match(full, /现象：列多了/);
  assert.match(full, /期望：只列今天/);
  const empty = patchDrafts.makeHint({ ...base, symptom: null, expected: null });
  assert.match(empty, /原话见 submission/);
});

test('patch-drafts：draftFromIssue 四条错误路径都不能猜位置', () => withRepo(({ dir, db }) => {
  assert.throws(() => patchDrafts.draftFromIssue(db, 9999, { repo: dir }), /没有这个 issue/);
  const untriaged = insertIssue(db, { skill: null, section: null });
  assert.throws(() => patchDrafts.draftFromIssue(db, untriaged, { repo: dir }), /还没分诊/);
  const noFile = insertIssue(db, { skill: 'no-such-skill', section: '查任务' });
  assert.throws(() => patchDrafts.draftFromIssue(db, noFile, { repo: dir }), /技能文件不存在/);
  const noSection = insertIssue(db, { skill: 'anc-task', section: '没有这一段' });
  assert.throws(() => patchDrafts.draftFromIssue(db, noSection, { repo: dir }), /找不到/);
}));

test('patch-drafts：skill 路径穿越在写入与读写两端都被拒（2026-11-06 回归）', () => withRepo(({ dir, db }) => {
  const outside = join(dir, 'outside.txt');
  writeFileSync(outside, 'KEEP', 'utf8');
  const evil = '../../outside.txt';
  const id = insertIssue(db, { skill: null, section: '查任务' });
  assert.throws(() => issues.setTriage(db, id, evil, '查任务'), /技能名不合规/);
  assert.equal(issues.setTriage(db, id, 'anc-task', '查任务'), true, '合法技能名照常通过');
  // 模拟绕过 CLI 直接改库的脏数据：draft 与 prune --apply 都不许拼出仓库外路径
  db.prepare('UPDATE issues SET skill = ? WHERE id = ?').run(evil, id);
  assert.throws(() => patchDrafts.draftFromIssue(db, id, { repo: dir }), /技能名不合规/);
  assert.throws(() => patchDrafts.prune(db, { issueId: id, repo: dir, apply: true }), /技能名不合规/);
  assert.equal(readFileSync(outside, 'utf8'), 'KEEP', '仓库外文件不能被写回');
}));

test('patch-drafts：分诊规则里每个技能都能定位到真实 SKILL.md（线上名反查目录名）', () => withDb((db) => {
  const repo = resolve(import.meta.dirname, '..', '..');
  for (const rule of issues.RULES) {
    const id = insertIssue(db, { skill: rule.skill, section: rule.section });
    const r = patchDrafts.draftFromIssue(db, id, { repo });
    assert.ok(existsSync(join(repo, r.draft.skill_path)),
      `${rule.skill} / ${rule.section} → ${r.draft.skill_path} 定位不到`);
    assert.ok(r.draft.diff.length > 0, `${rule.skill} 应产出 diff`);
  }
  // deploy-skills.ps1 按 SKILL.md 的 name: 落盘：线上名 anc-ingest 对应仓库目录 anc-ingest-company。
  // 原来直接拿线上名拼目录，L3 必然报「技能文件不存在」。
  const id = insertIssue(db, { skill: 'anc-ingest', section: '执行方式（硬约束，违反即事故）' });
  const r = patchDrafts.draftFromIssue(db, id, { repo });
  assert.equal(r.draft.skill_path, 'light/skills/anc-ingest-company/SKILL.md');
}));

test('patch-drafts：正常产出 diff + base_hash + warnings，重复 draft 会警告', () => withRepo(({ dir, skillFile, db }) => {
  const id = insertIssue(db, { skill: 'anc-task', section: '查任务', symptom: '列多了', expected: null });
  const r = patchDrafts.draftFromIssue(db, id, { repo: dir });
  assert.equal(r.draft.issue_id, id);
  assert.equal(r.draft.skill_path, 'light/skills/anc-task/SKILL.md');
  assert.equal(r.draft.base_hash, createHash('sha256').update(readFileSync(skillFile, 'utf8'), 'utf8').digest('hex'));
  assert.ok(r.insertedLines >= 3);
  assert.match(r.draft.diff, /^--- a\/light\/skills\/anc-task\/SKILL\.md/m);
  assert.match(r.draft.diff, /^\+\+\+ b\//m);
  assert.match(r.draft.diff, /^@@ /m);
  assert.ok(r.draft.diff.split('\n').some((l) => l.startsWith('+> **已知问题 #' + id)));
  assert.match(r.draft.warnings ?? '', /没有 expected/);
  assert.doesNotMatch(r.draft.warnings ?? '', /没有 symptom/);
  assert.equal(existsSync(skillFile), true, 'draft 只读仓库，不改文件');
  assert.equal(readFileSync(skillFile, 'utf8'), SKILL_MD, '技能文件内容不能被 draft 改掉');

  const again = patchDrafts.draftFromIssue(db, id, { repo: dir });
  assert.match(again.draft.warnings ?? '', /已有 1 份 draft/);
  assert.equal(patchDrafts.list(db, { issueId: id }).length, 2);
  assert.equal(patchDrafts.list(db, { limit: 1 }).length, 1);
  assert.equal(patchDrafts.list(db, { limit: 0 }).length, 2, '非法 limit 回退默认 20');
}));

test('patch-drafts：prune 的 preview / apply / 各 reason', () => withRepo(({ dir, skillFile, db }) => {
  const id = insertIssue(db, { skill: 'anc-task', section: '查任务', symptom: '列多了', expected: '只列今天' });
  const hint = patchDrafts.makeHint({ id, submission_id: 1, skill: 'anc-task', section: '查任务', symptom: '列多了', expected: '只列今天', verify: null, status: 'open', note: null, created_at: '' });
  writeFileSync(skillFile, SKILL_MD.replace('## 查任务', '## 查任务\n' + hint), 'utf8');
  const withBlock = readFileSync(skillFile, 'utf8');

  const preview = patchDrafts.prune(db, { issueId: id, repo: dir });
  assert.equal(preview.removed, true);
  assert.ok(preview.removedLines > 0);
  assert.equal(preview.file, 'light/skills/anc-task/SKILL.md');
  assert.doesNotMatch(preview.preview, /已知问题 #/);
  assert.equal(readFileSync(skillFile, 'utf8'), withBlock, 'apply=false 不能写文件');

  const applied = patchDrafts.prune(db, { issueId: id, repo: dir, apply: true });
  assert.equal(applied.removed, true);
  assert.doesNotMatch(readFileSync(skillFile, 'utf8'), /已知问题 #/);
  assert.doesNotMatch(readFileSync(skillFile, 'utf8'), /\n{3,}/, '删完不能留三个连续空行');

  const gone = patchDrafts.prune(db, { issueId: id, repo: dir });
  assert.equal(gone.removed, false);
  assert.match(gone.reason ?? '', /已经删过/);
  assert.equal(gone.preview, readFileSync(skillFile, 'utf8'));
}));

test('patch-drafts：prune 的四个失败 reason 与 pruneClosed 只处理 closed', () => withRepo(({ dir, skillFile, db }) => {
  assert.match(patchDrafts.prune(db, { issueId: 9999, repo: dir }).reason ?? '', /没有这个 issue/);
  const untriaged = insertIssue(db, { skill: null });
  assert.match(patchDrafts.prune(db, { issueId: untriaged, repo: dir }).reason ?? '', /还没分诊/);
  const noFile = insertIssue(db, { skill: 'no-such-skill' });
  assert.match(patchDrafts.prune(db, { issueId: noFile, repo: dir }).reason ?? '', /技能文件不存在/);
  const noBlock = insertIssue(db, { skill: 'anc-task' });
  assert.match(patchDrafts.prune(db, { issueId: noBlock, repo: dir }).reason ?? '', /可能已经删过/);

  const closedWithBlock = insertIssue(db, { skill: 'anc-task', status: 'closed' });
  const closedNoBlock = insertIssue(db, { skill: 'anc-task', status: 'closed' });
  const rejected = insertIssue(db, { skill: 'anc-task', status: 'rejected' });
  const hint = patchDrafts.makeHint({ id: closedWithBlock, submission_id: 1, skill: 'anc-task', section: '查任务', symptom: null, expected: null, verify: null, status: 'closed', note: null, created_at: '' });
  writeFileSync(skillFile, SKILL_MD.replace('## 查任务', '## 查任务\n' + hint), 'utf8');

  const batch = patchDrafts.pruneClosed(db, { repo: dir, apply: true });
  assert.equal(batch.scanned, 2, '只扫 closed，不含 rejected');
  assert.equal(batch.removed, 1);
  assert.equal(batch.skipped, 1);
  assert.equal(batch.results.length, 2);
  assert.equal(batch.results.some((r) => r.issueId === rejected), false);
  assert.doesNotMatch(readFileSync(skillFile, 'utf8'), new RegExp('已知问题 #' + closedWithBlock));
  assert.equal(patchDrafts.list(db, { issueId: closedNoBlock }).length, 0);
}));

// ───────────────────────── L6 eval ─────────────────────────

test('eval：readOutLog 解析、还原字面 \\n、跳过坏行、缺文件返回空', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-eval-'));
  try {
    const p = join(dir, 'patch-out.log');
    assert.deepEqual(evalRunner.readOutLog(p), []);
    writeFileSync(p, [
      '2026-11-05T10:00:00.000Z chat=chat-A len=5 text=第一行\\n第二行',
      '这不是日志行',
      '2026-11-05T10:00:01.000Z chat=chat-B len=2 text=在',
      '',
    ].join('\r\n'), 'utf8');
    const lines = evalRunner.readOutLog(p);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].chatId, 'chat-A');
    assert.equal(lines[0].len, 5);
    assert.equal(lines[0].text, '第一行\n第二行');
    assert.equal(lines[1].text, '在');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('eval：judge 的各类断言、坏正则与空行过滤', () => {
  assert.deepEqual(evalRunner.judge('   ', { mustMatch: ['在'] }).map((c) => c.ok), [false], '空回答只报「有回答」失败');
  const ok = evalRunner.judge('在。\n\n有什么要办的？', { mustMatch: ['在'], notMatch: ['马上改'], minLines: 1, maxLines: 2 });
  assert.ok(ok.every((c) => c.ok), JSON.stringify(ok));
  const miss = evalRunner.judge('在', { mustMatch: ['没出现'], notMatch: ['在'] });
  assert.deepEqual(miss.map((c) => c.ok), [true, false, false]);
  const bad = evalRunner.judge('在', { mustMatch: ['['], notMatch: ['('] });
  assert.equal(bad.filter((c) => c.detail === '正则写错了').length, 2);
  const lines = evalRunner.judge('a\nb\nc', { maxLines: 2, minLines: 5 });
  assert.equal(lines.find((c) => c.name.startsWith('最多'))?.ok, false);
  assert.equal(lines.find((c) => c.name.startsWith('至少'))?.ok, false);
});

test('eval：loadCases 目录缺失 / skill 过滤 / 忽略非 json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-eval-cases-'));
  try {
    assert.deepEqual(evalRunner.loadCases(dir), []);
    const evals = join(dir, 'light', 'evals');
    mkdirSync(evals, { recursive: true });
    writeFileSync(join(evals, 'a.json'), JSON.stringify({ cases: [
      { id: 'c1', skill: 'anc-task', input: 'x', expect: {} },
      { id: 'c2', skill: 'anc-ingest-company', input: 'y', expect: {} },
    ] }), 'utf8');
    writeFileSync(join(evals, 'b.json'), JSON.stringify({ note: '没有 cases' }), 'utf8');
    writeFileSync(join(evals, 'c.txt'), 'ignore me', 'utf8');
    assert.equal(evalRunner.loadCases(dir).length, 2);
    assert.deepEqual(evalRunner.loadCases(dir, 'anc-task').map((c) => c.id), ['c1']);
    assert.equal(evalRunner.loadCases(dir, '不存在').length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('eval：record 落库含 answer_hash 与 checks JSON', () => withDb((db) => {
  const result: evalRunner.RunResult = {
    caseId: 'c1', skill: 'anc-task', verdict: 'pass',
    checks: [{ name: '有回答', ok: true }], answer: '在', answerLen: 1,
  };
  const id = evalRunner.record(db, result, '手工回归');
  const r = row(db, 'eval_runs', id);
  assert.equal(r?.case_id, 'c1');
  assert.equal(r?.verdict, 'pass');
  assert.equal(r?.answer_hash, createHash('sha256').update('在', 'utf8').digest('hex'));
  assert.equal(r?.answer_len, 1);
  assert.equal(r?.note, '手工回归');
  assert.deepEqual(JSON.parse(String(r?.checks)), result.checks);
}));

test('eval：waitReady + runCase 走真实本地 HTTP 注入（隔离端口，不碰 17999）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-eval-http-'));
  const outLog = join(dir, 'patch-out.log');
  let server: http.Server | undefined;
  try {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (req.method !== 'POST' || req.url !== '/emit') { res.writeHead(404); res.end(); return; }
        const p = JSON.parse(body || '{}') as { content?: string };
        appendFileSync(outLog, `${new Date().toISOString()} chat=chat-A len=2 text=在\n`, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, content: p.content }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const opts = { chatId: 'chat-A', user: 'tester', port };

    assert.equal(await evalRunner.waitReady(opts, 2000), true);

    const r = await evalRunner.runCase(
      { id: 'case-1', skill: 'anc-task', input: '在吗', expect: { mustMatch: ['在'], minLines: 1, maxLines: 3 } },
      { ...opts, outLog, timeoutMs: 10000, quietMs: 0 },
    );
    assert.equal(r.caseId, 'case-1');
    assert.equal(r.verdict, 'pass', JSON.stringify(r.checks));
    assert.equal(r.answer, '在');
    assert.equal(r.answerLen, 1);

    // 注入成功但 bot 没回（outLog 无新内容）→ 判 fail，且必须明说「没有回答」
    const noAnswer = await evalRunner.runCase(
      { id: 'case-2', input: 'x', expect: { mustMatch: ['在'] } },
      { ...opts, outLog: join(dir, 'unused.log'), timeoutMs: 1000, quietMs: 0 },
    );
    assert.equal(noAnswer.verdict, 'fail');
    assert.equal(noAnswer.answer, '');
    assert.equal(noAnswer.checks[0].name, '有回答');
    assert.equal(noAnswer.checks[0].ok, false);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

// emitOnce 的非 200 分支：用返回 401 的 server 验证 runCase 判 error
test('eval：注入返回非 200 时 runCase 判 error 且不带回答', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-eval-401-'));
  let server: http.Server | undefined;
  try {
    server = http.createServer((_req, res) => { res.writeHead(401); res.end('unauthorized'); });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const r = await evalRunner.runCase(
      { id: 'case-401', input: 'x', expect: { mustMatch: ['在'] } },
      { chatId: 'c', user: 'u', port, outLog: join(dir, 'out.log'), timeoutMs: 500, quietMs: 0 },
    );
    assert.equal(r.verdict, 'error');
    assert.equal(r.answer, '');
    assert.equal(r.checks[0].name, '注入');
    assert.match(r.checks[0].detail ?? '', /HTTP 401/);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('patch-drafts：pruneClosed 单条读文件失败不中断整批（真实 EISDIR，不用 mock）', () => withRepo(({ dir, skillFile, db }) => {
  // 造一个「SKILL.md 实际是目录」的技能：existsSync 为真，readFileSync 抛 EISDIR。
  mkdirSync(join(dir, 'light', 'skills', 'anc-broken', 'SKILL.md'), { recursive: true });

  const good = insertIssue(db, { skill: 'anc-task', status: 'closed' });
  const broken = insertIssue(db, { skill: 'anc-broken', status: 'closed' });
  const hint = patchDrafts.makeHint({ id: good, submission_id: 1, skill: 'anc-task', section: '查任务', symptom: null, expected: null, verify: null, status: 'closed', note: null, created_at: '' });
  writeFileSync(skillFile, SKILL_MD.replace('## 查任务', '## 查任务\n' + hint), 'utf8');

  const batch = patchDrafts.pruneClosed(db, { repo: dir, apply: true });
  assert.equal(batch.scanned, 2);
  assert.equal(batch.removed, 1, '正常那条仍要删掉');
  assert.equal(batch.skipped, 1, '故障那条记 skipped');
  assert.equal(batch.results.length, 2, '不能因为一条失败就少返回明细');
  const failed = batch.results.find((r) => r.issueId === broken);
  assert.equal(failed?.removed, false);
  assert.ok(failed?.reason, '失败原因要带回给调用方，不能静默吞掉');
  assert.doesNotMatch(readFileSync(skillFile, 'utf8'), new RegExp('已知问题 #' + good));
}));

test('eval：waitReady 端口没人听时返回 false（短超时）', async () => {
  // 起一个立刻关闭的 server 拿到一个已释放端口，避免撞上真实服务
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const ok = await evalRunner.waitReady({ chatId: 'c', user: 'u', port }, 100);
  assert.equal(ok, false);
});
